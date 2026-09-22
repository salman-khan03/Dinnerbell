/**
 * The Dinner Bell planner.
 *
 * Problem: given a set of dishes (task graphs with rests and holds), a kitchen
 * (ovens, burners, cooks, gadgets) and a serve time, decide when every task
 * starts so that all dishes are ready together, and keep doing it as reality
 * drifts.
 *
 * Method: a *backward* serial schedule generation scheme (build the timeline
 * from the serve time toward the present, so everything is "just in time" and
 * hot food lands last). Placement honours
 *   - precedence with min/max gaps (resting turkey, drained-then-mashed potatoes),
 *   - oven rack slots and oven-temperature compatibility,
 *   - burner / gadget counts,
 *   - cook attention (full / light / none) against the number of cooks,
 *   - per-dish hold windows and a cushion before serving.
 * When a task cannot be placed, the search bumps that task earlier in the
 * priority order (so it claims its slot before the greedy tasks that blocked
 * it) and retries: conflict-directed reordering. Failing that, hold windows
 * are relaxed in steps and the plan is flagged tight.
 *
 * Everything is deterministic and runs in milliseconds, so a replan after
 * "the turkey needs 30 more minutes" is instant.
 */
import { DISH_INDEX, defaultQuantity } from './library.js';
import type {
  DishDef,
  Insight,
  Kitchen,
  PlanInput,
  PlanState,
  Progress,
  RestPeriod,
  Schedule,
  ScheduledTask,
  TaskDef,
  TaskStatus,
  Use,
} from './types.js';
import { GRID, ceilGrid, dayDiff, floorGrid, humanList, sayClock, sayDuration, zonedParts } from './time.js';

const INF = 1e9;
const OVEN_SLOTS = 2;
const ATTN: Record<string, number> = { full: 1, light: 0.5, none: 0 };
const RELAX_STEPS = [1, 1.5, 2.5];
const MAX_BOOST_ITERS = 28;
const PROBE_BOOST_ITERS = 12;

export interface ResolvedDish {
  def: DishDef;
  quantity?: number;
  servings: number;
}

interface Edge {
  from: string;
  to: string;
  minGap: number;
  maxGap: number;
  label?: string;
}

interface Option {
  use?: Use;
  dur: number;
}

interface Node {
  key: string;
  dish: ResolvedDish;
  task: TaskDef;
  options: Option[];
  attn: number;
  preds: Edge[];
  succs: Edge[];
  isFinal: boolean;
  fixed?: { status: 'done' | 'running' | 'skipped'; start: number; end: number };
  head: number;
  minStart: number;
  /** Bounds on this task's start from already-started predecessors: start <= end + maxGap. */
  ubs: { end: number; maxGap: number }[];
  makeAhead: boolean;
  /** Pre-placed before the cooking window (make-ahead dishes). */
  pre?: Placement;
}

interface Placement {
  start: number;
  end: number;
  opt: number;
  resource?: string;
}

export function resolveDishes(input: PlanInput): ResolvedDish[] {
  const out: ResolvedDish[] = [];
  const seen = new Set<string>();
  for (const pd of input.dishes) {
    const def = input.custom?.find((d) => d.id === pd.dishId) ?? DISH_INDEX.get(pd.dishId);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    out.push({
      def,
      quantity: pd.quantity ?? defaultQuantity(def, input.guests),
      servings: pd.servings ?? input.guests,
    });
  }
  return out;
}

function taskMinutes(d: ResolvedDish, t: TaskDef): number {
  let m = t.minutes + (t.perUnit ?? 0) * (d.quantity ?? 1);
  if (t.scalesWithServings) {
    const ratio = d.servings / Math.max(1, d.def.servings);
    m *= Math.min(2.5, Math.max(0.6, Math.pow(ratio, 0.6)));
  }
  return Math.max(GRID, ceilGrid(m));
}

function availableUse(u: Use | undefined, k: Kitchen): boolean {
  if (!u) return true;
  if (u.appliance === 'oven') return k.ovens > 0;
  if (u.appliance === 'burner') return k.burners > 0;
  return (k.extras[u.appliance] ?? 0) > 0;
}

// ───────────────────────────── problem construction ─────────────────────────────

interface Problem {
  input: PlanInput;
  nowMin: number;
  nodes: Map<string, Node>;
  free: Node[];
  dishes: ResolvedDish[];
  origin: number;
  lowerBound: number;
  warnings: string[];
  startAtGrid: number;
  /** 1 where the household is asleep (pre-window work is not scheduled then). */
  quiet: Uint8Array;
  /** The task that most recently could not be placed (for diagnostics). */
  lastFail?: string;
}

function buildProblem(input: PlanInput, progress: Progress, nowMin: number): Problem {
  const now = ceilGrid(nowMin);
  const dishes = resolveDishes(input);
  const nodes = new Map<string, Node>();
  const warnings: string[] = [];

  for (const d of dishes) {
    for (const t of d.def.tasks) {
      const key = `${d.def.id}.${t.id}`;
      const base = taskMinutes(d, t);
      const options: Option[] = [];
      const uses = t.uses && t.uses.length ? t.uses : [undefined];
      for (const u of uses) {
        if (!availableUse(u, input.kitchen)) continue;
        options.push({ use: u, dur: Math.max(GRID, ceilGrid(base * (u?.minutesFactor ?? 1))) });
      }
      if (!options.length) {
        // The kitchen lacks every way of doing this; fall back to the preferred use.
        options.push({ use: t.uses?.[0], dur: base });
        warnings.push(`This kitchen has no ${t.uses?.[0]?.appliance ?? 'equipment'} for "${t.label}".`);
      }
      nodes.set(key, {
        key,
        dish: d,
        task: t,
        options,
        attn: ATTN[t.hands],
        preds: [],
        succs: [],
        isFinal: false,
        head: 0,
        minStart: 0,
        ubs: [],
        makeAhead: !!t.makeAhead,
      });
    }
  }

  // Edges (dependencies on dishes that are not in the plan are simply satisfied).
  for (const n of nodes.values()) {
    for (const dep of n.task.after ?? []) {
      const d = typeof dep === 'string' ? { task: dep } : dep;
      const fromKey = d.task.includes('.') ? d.task : `${n.dish.def.id}.${d.task}`;
      if (!nodes.has(fromKey)) continue;
      const e: Edge = {
        from: fromKey,
        to: n.key,
        minGap: ('minGap' in d ? d.minGap : 0) ?? 0,
        maxGap: ('maxGap' in d && d.maxGap !== undefined ? d.maxGap : INF) as number,
        label: 'gapLabel' in d ? d.gapLabel : undefined,
      };
      n.preds.push(e);
      nodes.get(fromKey)!.succs.push(e);
    }
  }
  // Progress -> fixed nodes.
  for (const [key, p] of Object.entries(progress)) {
    const n = nodes.get(key);
    if (!n) continue;
    const dur = n.options[0].dur;
    if (p.status === 'done' || p.status === 'skipped') {
      const end = p.doneAt ?? nowMin;
      n.fixed = { status: p.status, start: p.startedAt ?? Math.max(0, end - dur), end };
    } else {
      const start = p.startedAt ?? nowMin;
      const planned = start + dur;
      const remaining = p.remainingMin !== undefined ? ceilGrid(p.remainingMin) : Math.max(GRID, planned - now);
      n.fixed = { status: 'running', start, end: now + remaining };
    }
  }
  // If something downstream has started or finished, everything upstream of it must be done.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes.values()) {
      if (n.fixed) continue;
      const downstreamStarted = n.succs.some((e) => {
        const s = nodes.get(e.to)!;
        return s.fixed && s.fixed.status !== 'skipped';
      });
      if (downstreamStarted) {
        n.fixed = { status: 'done', start: nowMin, end: nowMin };
        changed = true;
      }
    }
  }

  const free = [...nodes.values()].filter((n) => !n.fixed);
  const freeSet = new Set(free.map((n) => n.key));
  const startAt = Math.max(ceilGrid(input.startAt), now);

  // Earliest starts (release times) and upper bounds from fixed predecessors.
  for (const n of free) {
    n.minStart = n.makeAhead ? Math.max(now, floorGrid(input.startAt - n.task.makeAhead!)) : startAt;
    for (const e of n.preds) {
      const p = nodes.get(e.from)!;
      if (p.fixed) {
        n.minStart = Math.max(n.minStart, ceilGrid(p.fixed.end + e.minGap));
        if (e.maxGap < INF) n.ubs.push({ end: p.fixed.end, maxGap: e.maxGap });
      }
    }
    // Only free successors constrain a free node.
    n.succs = n.succs.filter((e) => freeSet.has(e.to));
    n.preds = n.preds.filter((e) => freeSet.has(e.from));
    n.isFinal = n.succs.length === 0;
  }

  // Forward pass: heads (longest chain before a task) and the earliest possible finish.
  const order = topo(free);
  const ef = new Map<string, number>();
  let lower = 0;
  for (const n of order) {
    let est = n.minStart;
    let head = 0;
    for (const e of n.preds) {
      const p = nodes.get(e.from)!;
      est = Math.max(est, (ef.get(p.key) ?? 0) + e.minGap);
      head = Math.max(head, p.head + p.options[0].dur + e.minGap);
    }
    n.head = head;
    const fin = est + Math.min(...n.options.map((o) => o.dur));
    ef.set(n.key, fin);
    if (n.isFinal) lower = Math.max(lower, fin);
  }

  const origin = floorGrid(now);
  const horizon = floorGrid(input.serveAt) + 8 * 60;
  const P: Problem = {
    input,
    nowMin: now,
    nodes,
    free,
    dishes,
    origin,
    lowerBound: lower,
    warnings,
    startAtGrid: startAt,
    quiet: buildQuiet(origin, horizon, input.tz),
  };
  preplaceAhead(P);
  P.free = P.free.filter((n) => !n.pre);
  return P;
}

const DAY_MIN = 1440;
const QUIET_FROM = 22 * 60;
const QUIET_TO = 7 * 60;

function buildQuiet(origin: number, horizon: number, tz: string): Uint8Array {
  const len = Math.max(2, Math.ceil((horizon - origin) / GRID) + 2);
  const q = new Uint8Array(len);
  const BLOCK = 144; // recompute the local clock every 12 hours to stay right across DST
  for (let k0 = 0; k0 < len; k0 += BLOCK) {
    const p = zonedParts(origin + k0 * GRID, tz);
    const base = p.hour * 60 + p.minute;
    for (let k = k0; k < Math.min(len, k0 + BLOCK); k++) {
      const m = (base + (k - k0) * GRID) % DAY_MIN;
      q[k] = m >= QUIET_FROM || m < QUIET_TO ? 1 : 0;
    }
  }
  return q;
}

function overlapsQuiet(P: Problem, s: number, e: number): boolean {
  const a = Math.max(0, Math.round((s - P.origin) / GRID));
  const b = Math.min(P.quiet.length, Math.round((e - P.origin) / GRID));
  for (let k = a; k < b; k++) if (P.quiet[k]) return true;
  return false;
}

/** Work that needs a person or an appliance is not scheduled while the household sleeps. */
const needsAwake = (n: Node, o: Option): boolean => n.attn > 0 || !!o.use;

/**
 * Dishes made entirely ahead (pies, cranberry sauce, applesauce) are placed as
 * their own small forward schedule ending before the cooking window opens, at
 * sensible hours: "bake the pie the evening before", never at 3 AM.
 */
function preplaceAhead(P: Problem): void {
  const lead = P.startAtGrid - P.nowMin;
  if (lead < 120) return; // cooking starts right away; nothing can go before it
  const tl = new Timelines(P.origin, P.startAtGrid + GRID * 4, P.input.kitchen);
  for (const d of P.dishes) {
    if (d.def.holdMin < DAY_MIN) continue;
    const keys = d.def.tasks.map((t) => `${d.def.id}.${t.id}`);
    const nodes = keys.map((k) => P.nodes.get(k)!);
    const keySet = new Set(keys);
    const ok = nodes.every(
      (n) =>
        !n.fixed &&
        n.makeAhead &&
        [...n.preds, ...n.succs].every((e) => keySet.has(e.from) && keySet.has(e.to)),
    );
    if (!ok) continue;
    const order = topo(nodes.map((n) => ({ ...n, preds: n.preds.filter((e) => keySet.has(e.from)), succs: n.succs })) as Node[]).map(
      (n) => P.nodes.get(n.key)!,
    );
    const chain = order.reduce((a, n) => a + n.options[0].dur + Math.max(0, ...n.preds.map((e) => e.minGap)), 0);
    const earliest = Math.max(...nodes.map((n) => n.minStart), P.nowMin);
    for (let S = floorGrid(P.startAtGrid - chain - 30); S >= earliest; S -= 15) {
      const plan = new Map<string, Placement>();
      let good = true;
      for (const n of order) {
        let est = Math.max(S, n.minStart);
        for (const e of n.preds) est = Math.max(est, (plan.get(e.from)?.end ?? 0) + e.minGap);
        est = ceilGrid(est);
        let chosen: Placement | null = null;
        for (let oi = 0; oi < n.options.length && !chosen; oi++) {
          const o = n.options[oi];
          const end = est + o.dur;
          if (end > P.startAtGrid) continue;
          if (needsAwake(n, o) && overlapsQuiet(P, est, end)) continue;
          if (n.preds.some((e) => e.maxGap < INF && est - (plan.get(e.from)?.end ?? est) > e.maxGap)) continue;
          const res = tl.fit(o.use, n.attn, est, end);
          if (res !== null) chosen = { start: est, end, opt: oi, resource: res || undefined };
        }
        if (!chosen) {
          good = false;
          break;
        }
        plan.set(n.key, chosen);
      }
      if (good) {
        for (const n of order) {
          const p = plan.get(n.key)!;
          tl.commit(n.options[p.opt].use, p.resource ?? '', n.attn, p.start, p.end);
          n.pre = p;
        }
        break;
      }
    }
  }
}

function topo(nodes: Node[]): Node[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const indeg = new Map(nodes.map((n) => [n.key, n.preds.length]));
  const q = nodes.filter((n) => n.preds.length === 0);
  const out: Node[] = [];
  while (q.length) {
    const n = q.shift()!;
    out.push(n);
    for (const e of n.succs) {
      const s = byKey.get(e.to)!;
      const d = (indeg.get(s.key) ?? 1) - 1;
      indeg.set(s.key, d);
      if (d === 0) q.push(s);
    }
  }
  if (out.length !== nodes.length) throw new Error('Dish dependencies contain a cycle.');
  return out;
}

// ───────────────────────────── resource timelines ─────────────────────────────

class Timelines {
  readonly len: number;
  readonly att: Float32Array;
  readonly burner: Uint8Array;
  readonly ovens: { slots: Uint8Array; tMin: Int16Array; tMax: Int16Array; flex: Int16Array }[];
  readonly extras = new Map<string, Uint8Array>();

  constructor(
    private origin: number,
    end: number,
    private kitchen: Kitchen,
  ) {
    this.len = Math.max(2, Math.ceil((end - origin) / GRID) + 2);
    this.att = new Float32Array(this.len);
    this.burner = new Uint8Array(this.len);
    this.ovens = Array.from({ length: kitchen.ovens }, () => ({
      slots: new Uint8Array(this.len),
      tMin: new Int16Array(this.len).fill(32000),
      tMax: new Int16Array(this.len).fill(-32000),
      flex: new Int16Array(this.len).fill(32000),
    }));
  }

  private ix(t: number): number {
    return Math.max(0, Math.round((t - this.origin) / GRID));
  }

  private extra(name: string): Uint8Array {
    let a = this.extras.get(name);
    if (!a) {
      a = new Uint8Array(this.len);
      this.extras.set(name, a);
    }
    return a;
  }

  /** Find a resource instance for `use` over [s, e). Returns its name, '' when no resource is needed, or null. */
  fit(use: Use | undefined, attn: number, s: number, e: number): string | null {
    const a = this.ix(s);
    const b = this.ix(e);
    if (b > this.len) return null;
    if (attn > 0) {
      const cap = this.kitchen.cooks + 1e-6;
      for (let k = a; k < b; k++) if (this.att[k] + attn > cap) return null;
    }
    if (!use) return '';
    switch (use.appliance) {
      case 'burner': {
        for (let k = a; k < b; k++) if (this.burner[k] + 1 > this.kitchen.burners) return null;
        return 'burner';
      }
      case 'oven': {
        const need = use.slots ?? 1;
        const T = use.tempF ?? 350;
        const flex = use.tempFlex ?? 25;
        for (let i = 0; i < this.ovens.length; i++) {
          const o = this.ovens[i];
          let ok = true;
          for (let k = a; k < b && ok; k++) {
            if (o.slots[k] + need > OVEN_SLOTS) ok = false;
            else if (o.slots[k] > 0) {
              const span = Math.max(o.tMax[k], T) - Math.min(o.tMin[k], T);
              if (span > Math.min(o.flex[k], flex)) ok = false;
            }
          }
          if (ok) return `oven-${i + 1}`;
        }
        return null;
      }
      default: {
        const cap = this.kitchen.extras[use.appliance] ?? 0;
        if (cap <= 0) return null;
        const arr = this.extra(use.appliance);
        for (let k = a; k < b; k++) if (arr[k] + 1 > cap) return null;
        return use.appliance;
      }
    }
  }

  commit(use: Use | undefined, resource: string, attn: number, s: number, e: number): void {
    const a = this.ix(s);
    const b = Math.min(this.len, this.ix(e));
    if (attn > 0) for (let k = a; k < b; k++) this.att[k] += attn;
    if (!use) return;
    if (use.appliance === 'burner') {
      for (let k = a; k < b; k++) this.burner[k]++;
    } else if (use.appliance === 'oven') {
      const o = this.ovens[Math.max(0, parseInt(resource.split('-')[1] ?? '1', 10) - 1)];
      const T = use.tempF ?? 350;
      const flex = use.tempFlex ?? 25;
      for (let k = a; k < b; k++) {
        o.slots[k] += use.slots ?? 1;
        o.tMin[k] = Math.min(o.tMin[k], T);
        o.tMax[k] = Math.max(o.tMax[k], T);
        o.flex[k] = Math.min(o.flex[k], flex);
      }
    } else {
      const arr = this.extra(use.appliance);
      for (let k = a; k < b; k++) arr[k]++;
    }
  }
}

// ───────────────────────────── the scheduler ─────────────────────────────

interface AttemptOK {
  ok: true;
  placement: Map<string, Placement>;
  margin: number;
  relax: number;
  /** Bounds tied to already-started tasks were dropped (drippings keep, so gravy can wait). */
  ubDropped: boolean;
}
interface AttemptFail {
  ok: false;
  failKey: string;
  /** The already-placed successor that bounded the failing task's window, and where it starts. */
  bind?: { key: string; start: number };
}

/** One deterministic pass with a given priority-boost table. */
function runOnce(
  P: Problem,
  D: number,
  margin: number,
  relax: number,
  boost: Map<string, number>,
  caps: Map<string, number>,
  ubDrop: boolean,
): AttemptOK | AttemptFail {
  const tl = new Timelines(P.origin, D + GRID * 4, P.input.kitchen);
  const placed = new Map<string, Placement>();

  // Running tasks occupy their resources from now until they finish.
  for (const n of P.nodes.values()) {
    if (n.fixed?.status === 'running') {
      const o = n.options[0];
      const res = tl.fit(o.use, n.attn, P.nowMin, n.fixed.end) ?? (o.use ? `${o.use.appliance}-forced` : '');
      if (!res.endsWith('-forced')) tl.commit(o.use, res, n.attn, P.nowMin, n.fixed.end);
    }
  }

  // Make-ahead dishes placed before the cooking window still occupy the kitchen.
  for (const n of P.nodes.values()) {
    if (n.pre) tl.commit(n.options[n.pre.opt].use, n.pre.resource ?? '', n.attn, n.pre.start, n.pre.end);
  }

  const remainingSuccs = new Map<string, number>();
  for (const n of P.free) remainingSuccs.set(n.key, n.succs.length);
  const ready = P.free.filter((n) => n.succs.length === 0);

  const rank = (n: Node): [number, number, number, number, string] => [
    boost.get(n.key) ?? 0,
    n.head,
    Math.max(...n.options.map((o) => o.dur)),
    Math.max(...n.options.map((o) => o.use?.slots ?? 0)),
    n.key,
  ];
  const better = (a: Node, b: Node): boolean => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return (ra[i] as number) > (rb[i] as number);
    return ra[4] < rb[4];
  };

  while (ready.length) {
    let bi = 0;
    for (let i = 1; i < ready.length; i++) if (better(ready[i], ready[bi])) bi = i;
    const n = ready.splice(bi, 1)[0];

    // Window for the end of this task.
    let latestEnd = INF;
    let earliestEnd = -INF;
    for (const e of n.succs) {
      const s = placed.get(e.to)!;
      latestEnd = Math.min(latestEnd, s.start - e.minGap);
      if (e.maxGap < INF) earliestEnd = Math.max(earliestEnd, s.start - Math.round(e.maxGap * relax));
    }
    if (n.isFinal) {
      const hold = n.dish.def.holdMin * relax;
      latestEnd = Math.min(latestEnd, D - Math.min(margin, hold));
      earliestEnd = Math.max(earliestEnd, D - hold);
    }

    let startUB = INF;
    if (!ubDrop) for (const b of n.ubs) startUB = Math.min(startUB, b.end + Math.round(b.maxGap * relax));

    let done: Placement | null = null;
    for (let e = floorGrid(latestEnd); e >= earliestEnd && !done; e -= GRID) {
      let anyReachable = false;
      for (let oi = 0; oi < n.options.length; oi++) {
        const o = n.options[oi];
        const s = e - o.dur;
        if (s < n.minStart) continue;
        anyReachable = true;
        if (s > startUB) continue;
        const cap = caps.get(n.key);
        if (cap !== undefined && s > cap) continue;
        if (s < P.startAtGrid && needsAwake(n, o) && overlapsQuiet(P, s, e)) continue;
        const res = tl.fit(o.use, n.attn, s, e);
        if (res !== null) {
          tl.commit(o.use, res, n.attn, s, e);
          done = { start: s, end: e, opt: oi, resource: res || undefined };
          break;
        }
      }
      if (!anyReachable) break;
    }
    if (!done) {
      let bind: AttemptFail['bind'];
      let bestEnd = INF;
      for (const e of n.succs) {
        const sp = placed.get(e.to)!;
        if (sp.start - e.minGap < bestEnd) {
          bestEnd = sp.start - e.minGap;
          bind = { key: e.to, start: sp.start };
        }
      }
      return { ok: false, failKey: n.key, bind };
    }
    placed.set(n.key, done);

    for (const e of n.preds) {
      const c = (remainingSuccs.get(e.from) ?? 1) - 1;
      remainingSuccs.set(e.from, c);
      if (c === 0) ready.push(P.nodes.get(e.from)!);
    }
  }
  return { ok: true, placement: placed, margin, relax, ubDropped: ubDrop };
}

function attempt(P: Problem, D: number, margin: number, relax: number, iters: number, ubDrop = false): AttemptOK | null {
  const boost = new Map<string, number>();
  const caps = new Map<string, number>();
  const capStep = new Map<string, number>();
  for (let i = 0; i < iters; i++) {
    const r = runOnce(P, D, margin, relax, boost, caps, ubDrop);
    if (r.ok) return r;
    P.lastFail = r.failKey;
    // 1) Let the failing task claim its slot before the greedy tasks that blocked it.
    boost.set(r.failKey, (boost.get(r.failKey) ?? 0) + 1);
    // 2) If its window was boxed in by a successor, push that successor earlier (doubling step).
    if (r.bind) {
      const step = capStep.get(r.bind.key) ?? GRID;
      const from = caps.get(r.bind.key) ?? r.bind.start;
      caps.set(r.bind.key, floorGrid(from - step));
      capStep.set(r.bind.key, step * 2);
    }
  }
  return null;
}

/** The configurations to try at a given serve time, strictest first: [margin, relax, dropStartedBounds]. */
function configs(inputMargin: number): [number, number, boolean][] {
  const m = Math.max(0, inputMargin);
  const out: [number, number, boolean][] = [
    [m, RELAX_STEPS[0], false],
    [0, RELAX_STEPS[0], false],
    [m, RELAX_STEPS[1], false],
    [0, RELAX_STEPS[1], false],
    [0, RELAX_STEPS[2], false],
    [0, RELAX_STEPS[2], true],
  ];
  return out.filter((c, i) => out.findIndex((d) => d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) === i);
}

function solveAt(P: Problem, D: number, iters = MAX_BOOST_ITERS): AttemptOK | null {
  for (const [m, r, drop] of configs(P.input.marginMin)) {
    const a = attempt(P, D, m, r, iters, drop);
    if (a) return a;
  }
  return null;
}

/** Earliest feasible serve time >= `from` (strict-to-relaxed configs), via galloping + bisection. */
function earliestServe(P: Problem, from: number): { D: number; res: AttemptOK } | null {
  const first = solveAt(P, from);
  if (first) return { D: from, res: first };
  let lo = from;
  let step = 15;
  let hi = -1;
  let hiRes: AttemptOK | null = null;
  const LIMIT = from + 8 * 60;
  while (lo < LIMIT) {
    const cand = floorGrid(Math.min(LIMIT, lo + step));
    const r = solveAt(P, cand, PROBE_BOOST_ITERS);
    if (r) {
      hi = cand;
      hiRes = r;
      break;
    }
    lo = cand;
    step *= 2;
    if (cand >= LIMIT) break;
  }
  if (!hiRes) {
    // Feasibility is not monotonic when a step is tied to one that already started
    // (gravy must follow the roast within 45 minutes), so a narrow window can hide
    // between the galloping probes. Scan it directly.
    for (let cand = from + 15; cand <= LIMIT; cand += 15) {
      const r = solveAt(P, floorGrid(cand), PROBE_BOOST_ITERS);
      if (r) {
        hi = floorGrid(cand);
        hiRes = r;
        lo = hi - 15;
        break;
      }
    }
    if (!hiRes) return null;
  }
  while (hi - lo > GRID) {
    const mid = floorGrid((lo + hi) / 2);
    if (mid <= lo) break;
    const r = solveAt(P, mid, PROBE_BOOST_ITERS);
    if (r) {
      hi = mid;
      hiRes = r;
    } else lo = mid;
  }
  // Re-solve at the final answer with the full iteration budget for the best layout.
  return { D: hi, res: solveAt(P, hi) ?? hiRes };
}

/** The earliest serve time <= `requested` that is still strictly feasible (no margin, no relaxation). */
function earliestStrict(P: Problem, requested: number): number {
  let hi = requested;
  let lo = Math.max(ceilGrid(P.lowerBound) - GRID, requested - 6 * 60);
  const atLb = attempt(P, ceilGrid(P.lowerBound), 0, 1, PROBE_BOOST_ITERS);
  if (atLb && ceilGrid(P.lowerBound) <= requested) return ceilGrid(P.lowerBound);
  lo = Math.max(lo, ceilGrid(P.lowerBound));
  while (hi - lo > GRID) {
    const mid = floorGrid((lo + hi) / 2);
    if (mid <= lo) break;
    if (attempt(P, mid, 0, 1, PROBE_BOOST_ITERS)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ───────────────────────────── public API ─────────────────────────────

export interface ComputeOptions {
  /** Also compute what-if suggestions (a little slower). */
  insights?: boolean;
}

export function computeSchedule(
  input: PlanInput,
  progress: Progress = {},
  nowMin: number = input.startAt,
  options: ComputeOptions = {},
): Schedule {
  const P = buildProblem(input, progress, nowMin);
  const requested = floorGrid(input.serveAt);
  const warnings = [...P.warnings];

  let state: PlanState;
  let D = requested;
  let res: AttemptOK | null = null;
  let buffer = 0;

  if (P.free.length === 0) {
    state = 'on_track';
    buffer = Math.max(0, requested - P.nowMin);
    res = { ok: true, placement: new Map(), margin: 0, relax: 1, ubDropped: false };
  } else {
    const start = Math.max(requested, ceilGrid(P.lowerBound));
    const found = start === requested ? earliestServe(P, requested) : earliestServe(P, start);
    if (!found) {
      if (process.env.DINNER_BELL_DEBUG) console.error('planner: could not place', P.lastFail);
      return emptyImpossible(P, input, warnings);
    }
    D = found.D;
    res = found.res;
    if (D > requested) {
      state = 'late';
      buffer = requested - D;
      warnings.push(`The earliest everything can be ready is ${sayClock(D, input.tz)}, ${sayDuration(D - requested)} after ${sayClock(requested, input.tz)}.`);
    } else {
      const strict = earliestStrict(P, requested);
      buffer = requested - strict;
      state = res.relax > 1 || res.ubDropped || buffer < 15 ? 'tight' : 'on_track';
      if (res.relax > 1 || res.ubDropped) warnings.push('Some dishes will wait a little longer than ideal before serving.');
    }
  }

  const schedule = assemble(P, res, requested, D, buffer, state, warnings);
  if (options.insights && (state === 'late' || state === 'tight')) {
    schedule.insights = computeInsights(P, input, progress, nowMin, schedule);
  }
  return schedule;
}

function emptyImpossible(P: Problem, input: PlanInput, warnings: string[]): Schedule {
  return {
    state: 'impossible',
    requestedServeMin: input.serveAt,
    achievableServeMin: input.serveAt,
    bufferMin: -999,
    tasks: [],
    rests: [],
    prework: [],
    warnings: [...warnings, 'These dishes cannot be fitted into this kitchen within a sensible time. Try fewer dishes or another cook.'],
    insights: [],
    generatedAtMin: P.nowMin,
    firstActionMin: input.startAt,
  };
}

function assemble(
  P: Problem,
  res: AttemptOK,
  requested: number,
  D: number,
  buffer: number,
  state: PlanState,
  warnings: string[],
): Schedule {
  const { input } = P;
  // The plan's own cooking window opens at input.startAt, however late in the day we are replanning.
  const startAt = ceilGrid(input.startAt);
  const tasks: ScheduledTask[] = [];

  for (const n of P.nodes.values()) {
    let startMin: number;
    let endMin: number;
    let status: TaskStatus = 'pending';
    let use: Use | undefined;
    let resource: string | undefined;
    if (n.fixed) {
      startMin = n.fixed.start;
      endMin = n.fixed.end;
      status = n.fixed.status;
      use = n.options[0].use;
    } else {
      const p = n.pre ?? res.placement.get(n.key)!;
      startMin = p.start;
      endMin = p.end;
      use = n.options[p.opt].use;
      resource = p.resource;
    }
    const notes: string[] = [];
    if (use?.appliance === 'oven' && use.tempF && status !== 'done') notes.push(`Oven at ${use.tempF} degrees`);
    if (use && use.appliance !== 'oven' && use.appliance !== 'burner' && status !== 'done') {
      notes.push(`Use the ${use.appliance.replace('_', ' ')}`);
    }
    tasks.push({
      key: n.key,
      dishId: n.dish.def.id,
      dishName: n.dish.def.name,
      taskId: n.task.id,
      label: n.task.label,
      startMin,
      endMin,
      hands: n.task.hands,
      use,
      resource,
      status,
      preWork: startMin < startAt,
      notes,
    });
  }
  tasks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.key.localeCompare(b.key));

  harmoniseOvenTemps(tasks);

  // Rest periods (labelled gaps between a task and its dependant).
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const rests: RestPeriod[] = [];
  for (const n of P.nodes.values()) {
    for (const e of n.preds) {
      if (!e.label) continue;
      const a = byKey.get(e.from);
      const b = byKey.get(e.to);
      if (a && b && b.startMin > a.endMin) {
        rests.push({ fromKey: a.key, toKey: b.key, startMin: a.endMin, endMin: b.startMin, label: e.label });
      }
    }
  }

  // Pre-work: static notes on the dishes plus scheduled make-ahead tasks.
  const prework: Schedule['prework'] = [];
  for (const t of tasks) {
    if (t.preWork && (t.status === 'pending' || t.status === 'running')) {
      const days = dayDiff(t.startMin, startAt, input.tz);
      const when =
        days >= 2
          ? `${days} days ahead`
          : days === 1
            ? zonedParts(t.startMin, input.tz).hour >= 17
              ? 'the evening before'
              : 'the day before'
            : 'earlier, before you start';
      prework.push({ text: `${t.dishName}: ${lowerFirst(t.label)}`, when, key: t.key });
    }
  }
  for (const d of P.dishes) for (const text of d.def.prework ?? []) prework.push({ text: `${d.def.name}: ${text}`, when: 'in the days before' });

  const live = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  const firstAction = live.filter((t) => !t.preWork).sort((a, b) => a.startMin - b.startMin)[0];

  return {
    state,
    requestedServeMin: input.serveAt,
    achievableServeMin: D,
    bufferMin: buffer,
    tasks,
    rests,
    prework,
    warnings,
    insights: [],
    generatedAtMin: P.nowMin,
    firstActionMin: firstAction ? firstAction.startMin : startAt,
  };
}

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Tasks sharing an oven at different temperatures settle on one temperature: say so. */
function harmoniseOvenTemps(tasks: ScheduledTask[]): void {
  const oven = tasks.filter((t) => t.use?.appliance === 'oven' && t.resource && t.status !== 'done');
  for (const t of oven) {
    const mates = oven.filter(
      (o) => o !== t && o.resource === t.resource && o.startMin < t.endMin && t.startMin < o.endMin,
    );
    const temps = [t, ...mates].map((x) => x.use!.tempF!);
    if (new Set(temps).size > 1) {
      const shared = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length / 5) * 5;
      t.notes = t.notes.filter((n) => !n.startsWith('Oven at'));
      t.notes.push(`Oven at ${shared} degrees (shared with ${humanList([...new Set(mates.map((m) => m.dishName.toLowerCase()))])})`);
    }
  }
}

// ───────────────────────────── what-if insights ─────────────────────────────

/** Buffer (minutes; negative = late) a variant of the plan would have. */
function bufferFor(input: PlanInput, progress: Progress, nowMin: number): number {
  return computeSchedule(input, progress, nowMin).bufferMin;
}

function computeInsights(P: Problem, input: PlanInput, progress: Progress, nowMin: number, current: Schedule): Insight[] {
  const out: Insight[] = [];
  const cur = current.bufferMin;
  const target = floorGrid(input.serveAt);

  // A second pair of hands.
  const withHelper = bufferFor({ ...input, kitchen: { ...input.kitchen, cooks: input.kitchen.cooks + 1 } }, progress, nowMin);
  if (withHelper - cur >= 10) {
    out.push({
      kind: 'helper',
      savesMin: withHelper - cur,
      message:
        cur < 0 && withHelper >= 0
          ? `With one more person helping, you would be back on time for ${sayClock(target, input.tz)}.`
          : `With one more person helping, you would gain ${sayDuration(withHelper - cur)} of breathing room.`,
    });
  }

  // A second oven, if there is only one and the oven is the bottleneck.
  if (input.kitchen.ovens < 2 && P.dishes.some((d) => d.def.tasks.some((t) => t.uses?.[0]?.appliance === 'oven'))) {
    const withOven = bufferFor({ ...input, kitchen: { ...input.kitchen, ovens: input.kitchen.ovens + 1 } }, progress, nowMin);
    if (withOven - cur >= 10) {
      out.push({
        kind: 'appliance',
        savesMin: withOven - cur,
        message: `A second oven, even a neighbor's, would give you ${sayDuration(withOven - cur)} more room.`,
      });
    }
  }

  // Dropping a side.
  let best: { name: string; gain: number } | null = null;
  for (const d of P.dishes) {
    if (d.def.course === 'main') continue;
    if (Object.keys(progress).some((k) => k.startsWith(`${d.def.id}.`))) continue;
    const gain = bufferFor({ ...input, dishes: input.dishes.filter((x) => x.dishId !== d.def.id) }, progress, nowMin) - cur;
    if (gain >= 10 && (!best || gain > best.gain)) best = { name: d.def.name.toLowerCase(), gain };
  }
  if (best) {
    out.push({ kind: 'drop_dish', savesMin: best.gain, message: `Skipping the ${best.name} would give you ${sayDuration(best.gain)} back.` });
  }

  // A cheaper swap: store-bought rolls.
  if (input.dishes.some((d) => d.dishId === 'rolls') && !Object.keys(progress).some((k) => k.startsWith('rolls.'))) {
    const swapped = input.dishes.map((d) => (d.dishId === 'rolls' ? { ...d, dishId: 'rolls_store' } : d));
    const gain = bufferFor({ ...input, dishes: swapped }, progress, nowMin) - cur;
    if (gain >= 10) out.push({ kind: 'drop_dish', savesMin: gain, message: `Using store-bought rolls would give you ${sayDuration(gain)} back.` });
  }

  // Start earlier (only useful before cooking has begun).
  if (cur < 15 && Object.keys(progress).length === 0 && input.startAt > P.nowMin) {
    const room = Math.min(15 - cur, input.startAt - P.nowMin);
    out.push({ kind: 'start_earlier', savesMin: room, message: `Starting ${sayDuration(room)} earlier would give you a comfortable cushion.` });
  }
  return out.sort((a, b) => (b.savesMin ?? 0) - (a.savesMin ?? 0));
}
