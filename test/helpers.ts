import { DISH_INDEX, MENU_INDEX, defaultQuantity } from '../src/engine/library.js';
import { GRID, zonedParts, zonedToMin } from '../src/engine/time.js';
import type { Dep, Kitchen, PlanInput, Schedule, TaskDef } from '../src/engine/types.js';

export const TZ = 'America/New_York';

export const at = (y: number, mo: number, d: number, h: number, mi = 0, tz = TZ): number => zonedToMin(y, mo, d, h, mi, tz);

export const kitchen = (over: Partial<Kitchen> = {}): Kitchen => ({ ovens: 1, burners: 4, cooks: 1, extras: {}, ...over });

export function thanksgiving(over: Partial<PlanInput> = {}): PlanInput {
  return {
    serveAt: at(2026, 11, 26, 17),
    startAt: at(2026, 11, 26, 9),
    guests: 10,
    dishes: MENU_INDEX.get('thanksgiving')!.dishes.map((dishId) => ({ dishId })),
    kitchen: kitchen(),
    marginMin: 10,
    tz: TZ,
    ...over,
  };
}

export const NOW_PLANNING = at(2026, 11, 24, 12);

/**
 * An INDEPENDENT constraint checker. It re-derives every hard constraint from
 * the raw library data rather than reusing planner internals, so a scheduler
 * bug cannot hide behind a matching checker bug.
 */
export function violations(input: PlanInput, s: Schedule, nowMin: number): string[] {
  const bad: string[] = [];
  const byKey = new Map(s.tasks.map((t) => [t.key, t]));
  const startAt = Math.max(input.startAt, nowMin);

  for (const t of s.tasks) {
    if (t.status === 'done' || t.status === 'skipped') continue;
    const def = DISH_INDEX.get(t.dishId) ?? input.custom?.find((d) => d.id === t.dishId)!;
    const td = def.tasks.find((x) => x.id === t.taskId) as TaskDef;
    const dishQty = input.dishes.find((d) => d.dishId === t.dishId)?.quantity ?? defaultQuantity(def, input.guests);

    if (t.startMin % GRID !== 0 || t.endMin % GRID !== 0) bad.push(`${t.key}: off grid`);
    if (t.endMin <= t.startMin) bad.push(`${t.key}: non-positive duration`);
    if (t.status === 'pending' && t.startMin < nowMin) bad.push(`${t.key}: starts in the past`);

    // Duration at least the fastest option's base minutes.
    const base = td.minutes + (td.perUnit ?? 0) * (dishQty ?? 1);
    const fastest = Math.min(...(td.uses?.length ? td.uses : [undefined]).map((u) => (u?.minutesFactor ?? 1)));
    const scale = td.scalesWithServings
      ? Math.min(2.5, Math.max(0.6, Math.pow(input.guests / def.servings, 0.6)))
      : 1;
    if (t.endMin - t.startMin < Math.floor(base * scale * fastest) - GRID) bad.push(`${t.key}: too short`);

    // Only make-ahead tasks may precede the cooking window.
    if (t.status === 'pending' && t.startMin < startAt && !td.makeAhead) bad.push(`${t.key}: before window but not make-ahead`);
    if (t.status === 'pending' && td.makeAhead && t.startMin < startAt - td.makeAhead) bad.push(`${t.key}: too far ahead`);

    // Pre-window work is never scheduled while people sleep.
    if (t.status === 'pending' && t.startMin < startAt && (t.hands !== 'none' || t.use)) {
      for (let m = t.startMin; m < t.endMin; m += GRID) {
        const h = zonedParts(m, input.tz).hour;
        if (h >= 22 || h < 7) {
          bad.push(`${t.key}: pre-window work during quiet hours (${h}:xx)`);
          break;
        }
      }
    }

    // Precedence and gaps.
    for (const dep of td.after ?? []) {
      const d: Dep = typeof dep === 'string' ? { task: dep } : dep;
      const fromKey = d.task.includes('.') ? d.task : `${t.dishId}.${d.task}`;
      const p = byKey.get(fromKey);
      if (!p) continue;
      if (p.status !== 'pending' && p.status !== 'running') continue;
      if (t.status === 'pending' && t.startMin < p.endMin + (d.minGap ?? 0)) bad.push(`${t.key}: starts before ${fromKey} ends + minGap`);
      // Hard cap: even fully relaxed (x2.5) a rest may not exceed maxGap * 2.5.
      if (d.maxGap !== undefined && t.status === 'pending' && t.startMin - p.endMin > d.maxGap * 2.5 + GRID) {
        bad.push(`${t.key}: gap after ${fromKey} exceeds relaxed maxGap`);
      }
    }
  }

  // Resource capacity, slot by slot.
  const pending = s.tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  if (pending.length) {
    const lo = Math.min(...pending.map((t) => t.startMin));
    const hi = Math.max(...pending.map((t) => t.endMin));
    for (let m = lo; m < hi; m += GRID) {
      const live = pending.filter((t) => t.startMin <= m && m < t.endMin && !(t.status === 'running' && m < nowMin));
      const attn = live.reduce((a, t) => a + (t.hands === 'full' ? 1 : t.hands === 'light' ? 0.5 : 0), 0);
      if (attn > input.kitchen.cooks + 1e-6) bad.push(`attention ${attn} > ${input.kitchen.cooks} at ${m}`);
      const burners = live.filter((t) => t.use?.appliance === 'burner').length;
      if (burners > input.kitchen.burners) bad.push(`burners ${burners} > ${input.kitchen.burners} at ${m}`);
      for (let o = 1; o <= input.kitchen.ovens; o++) {
        const inOven = live.filter((t) => t.use?.appliance === 'oven' && t.resource === `oven-${o}`);
        const slots = inOven.reduce((a, t) => a + (t.use!.slots ?? 1), 0);
        if (slots > 2) bad.push(`oven-${o} slots ${slots} > 2 at ${m}`);
        if (inOven.length > 1) {
          const temps = inOven.map((t) => t.use!.tempF!);
          const flex = Math.min(...inOven.map((t) => t.use!.tempFlex ?? 25));
          if (Math.max(...temps) - Math.min(...temps) > flex) bad.push(`oven-${o} temps ${temps.join('/')} incompatible at ${m}`);
        }
      }
      for (const extra of ['air_fryer', 'slow_cooker', 'microwave', 'grill'] as const) {
        const n = live.filter((t) => t.use?.appliance === extra).length;
        if (n > (input.kitchen.extras[extra] ?? 0)) bad.push(`${extra} over capacity at ${m}`);
      }
    }
  }

  // Everything is ready by the achievable serve time, and never after it.
  for (const t of pending) if (t.endMin > s.achievableServeMin) bad.push(`${t.key}: ends after serve time`);
  return bad;
}

/** What a cook who is exactly on plan at `now` would have reported: finished steps done, current steps running. */
export function onPlanProgress(s: Schedule, now: number): Record<string, { status: 'done' | 'running'; startedAt: number; doneAt?: number }> {
  const out: Record<string, { status: 'done' | 'running'; startedAt: number; doneAt?: number }> = {};
  for (const t of s.tasks) {
    if (t.preWork || t.endMin <= now) out[t.key] = { status: 'done', startedAt: t.startMin, doneAt: t.endMin };
    else if (t.startMin <= now) out[t.key] = { status: 'running', startedAt: t.startMin };
  }
  return out;
}
