/**
 * Turning what a cook *says* ("the turkey's in", "gravy needs ten more minutes")
 * into progress records the planner can replan around, plus the small pure
 * helpers the voice layer needs (what's happening now, what changed).
 */
import { findDish } from './library.js';
import type { PlanInput, Progress, Schedule, ScheduledTask } from './types.js';

export type ReportStatus = 'started' | 'done' | 'running_long' | 'skipped';

export interface Report {
  dish: string;
  /** Free-text hint for which step ("roast", "carve", "the mash"). */
  step?: string;
  status: ReportStatus;
  /** For running_long: minutes still needed. */
  remainingMin?: number;
}

export type ReportResult =
  | { ok: true; progress: Progress; tasks: ScheduledTask[]; dishName: string }
  | { ok: false; error: string; candidates?: string[] };

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'with', 'for', 'into'].includes(w));

/** How well a free-text hint matches a task. */
function score(hint: string, t: ScheduledTask): number {
  const h = words(hint);
  if (!h.length) return 0;
  const hay = new Set(words(`${t.taskId} ${t.label}`));
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
  const hayStems = new Set([...hay].map(stem));
  let sc = 0;
  for (const w of h) {
    if (hay.has(w)) sc += 2;
    else if (hayStems.has(stem(w))) sc += 1;
  }
  return sc;
}

export function applyReport(schedule: Schedule, progress: Progress, input: PlanInput, report: Report, nowMin: number): ReportResult {
  const dish = findDish(report.dish, input.custom);
  if (!dish || !input.dishes.some((d) => d.dishId === dish.id)) {
    const names = schedule.tasks.map((t) => t.dishName).filter((n, i, a) => a.indexOf(n) === i);
    return { ok: false, error: `"${report.dish}" is not in this meal.`, candidates: names };
  }
  const mine = schedule.tasks.filter((t) => t.dishId === dish.id).sort((a, b) => a.startMin - b.startMin);
  const open = mine.filter((t) => t.status === 'pending' || t.status === 'running');
  if (!open.length) return { ok: false, error: `Everything for ${dish.name.toLowerCase()} is already done.` };

  const pick = (pool: ScheduledTask[]): ScheduledTask | undefined => {
    if (report.step) {
      const ranked = pool
        .map((t) => ({ t, s: score(report.step!, t) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.t.startMin - b.t.startMin);
      if (ranked.length) return ranked[0].t;
    }
    return pool[0];
  };

  const next: Progress = { ...progress };
  const touched: ScheduledTask[] = [];

  switch (report.status) {
    case 'started': {
      const t = pick(open.filter((x) => x.status === 'pending')) ?? pick(open);
      if (!t) return { ok: false, error: 'Nothing to start.' };
      next[t.key] = { status: 'running', startedAt: nowMin };
      touched.push(t);
      break;
    }
    case 'done': {
      // Prefer the step that is actually running; a hint can point at a later one.
      const running = open.filter((x) => x.status === 'running');
      const t = (report.step ? pick(open) : undefined) ?? running[0] ?? open[0];
      next[t.key] = { status: 'done', startedAt: progress[t.key]?.startedAt, doneAt: nowMin };
      touched.push(t);
      break;
    }
    case 'running_long': {
      const running = open.filter((x) => x.status === 'running');
      const t = (report.step ? pick(open) : undefined) ?? running[0] ?? open[0];
      next[t.key] = {
        status: 'running',
        startedAt: progress[t.key]?.startedAt ?? nowMin,
        remainingMin: Math.max(5, report.remainingMin ?? 15),
      };
      touched.push(t);
      break;
    }
    case 'skipped': {
      const targets = report.step ? [pick(open)!] : open;
      for (const t of targets) {
        next[t.key] = { status: 'skipped', doneAt: nowMin };
        touched.push(t);
      }
      break;
    }
  }
  return { ok: true, progress: next, tasks: touched, dishName: dish.name };
}

export interface Agenda {
  running: ScheduledTask[];
  /** Pending and due within the next few minutes. */
  startNow: ScheduledTask[];
  /** Coming up within the horizon. */
  upNext: ScheduledTask[];
  /** How many tasks are left in total. */
  remaining: number;
}

export function agenda(s: Schedule, nowMin: number, horizonMin = 30): Agenda {
  const live = s.tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  const running = live.filter((t) => t.status === 'running');
  const pending = live.filter((t) => t.status === 'pending' && !t.preWork);
  const startNow = pending.filter((t) => t.startMin <= nowMin + 5);
  const upNext = pending.filter((t) => t.startMin > nowMin + 5 && t.startMin <= nowMin + horizonMin);
  return { running, startNow, upNext, remaining: live.length };
}

export interface Moved {
  key: string;
  dishName: string;
  label: string;
  from: number;
  to: number;
}

export interface ScheduleDiff {
  moved: Moved[];
  bufferDelta: number;
  achievableDelta: number;
  stateChanged: boolean;
}

/** What changed for the cook between two versions of the plan. */
export function diffSchedules(prev: Schedule, next: Schedule, thresholdMin = 5): ScheduleDiff {
  const before = new Map(prev.tasks.filter((t) => t.status === 'pending').map((t) => [t.key, t]));
  const moved: Moved[] = [];
  for (const t of next.tasks) {
    if (t.status !== 'pending') continue;
    const b = before.get(t.key);
    if (b && Math.abs(t.startMin - b.startMin) >= thresholdMin) {
      moved.push({ key: t.key, dishName: t.dishName, label: t.label, from: b.startMin, to: t.startMin });
    }
  }
  moved.sort((a, b) => a.to - b.to);
  return {
    moved,
    bufferDelta: next.bufferMin - prev.bufferMin,
    achievableDelta: next.achievableServeMin - prev.achievableServeMin,
    stateChanged: prev.state !== next.state,
  };
}
