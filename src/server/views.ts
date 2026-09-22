/**
 * The JSON shape a plan takes on the wire. Used for tool `structuredContent`
 * (for the model and for other clients) and as the data source for the
 * on-screen timeline (the MCP App).
 */
import * as z from 'zod/v4';
import { fmtClock, fmtDate, fromMin, resolveDishes } from '../engine/index.js';
import type { PlanInput, Schedule } from '../engine/index.js';

const iso = (m: number): string => fromMin(m).toISOString();

export const TaskViewSchema = z.object({
  key: z.string(),
  dish: z.string(),
  dish_id: z.string(),
  step: z.string().describe('What to do, as a short sentence.'),
  start: z.string().describe('ISO 8601 start time.'),
  end: z.string().describe('ISO 8601 end time.'),
  start_local: z.string().describe('Start time in the household time zone, e.g. "4:05 PM".'),
  end_local: z.string(),
  attention: z.enum(['full', 'light', 'none']).describe('How much of the cook the step needs.'),
  appliance: z.string().nullable().describe('Where it cooks, e.g. "oven-1" or "burner".'),
  status: z.enum(['pending', 'running', 'done', 'skipped']),
  before_cooking_window: z.boolean().describe('Do this ahead of time, before the cooking window opens.'),
  notes: z.array(z.string()),
});

export const PlanViewSchema = z.object({
  plan_id: z.string(),
  state: z.enum(['on_track', 'tight', 'late', 'impossible']),
  headline: z.string().describe('One sentence a person can read at a glance.'),
  guests: z.number(),
  cooks: z.number().describe('How many people are cooking in this plan.'),
  ovens: z.number().describe('How many ovens this plan may use.'),
  timezone: z.string(),
  now: z.string(),
  serve_target: z.string(),
  serve_target_local: z.string(),
  serve_target_day: z.string(),
  achievable: z.string().describe('The earliest time everything can actually be ready.'),
  achievable_local: z.string(),
  slack_minutes: z.number().describe('Minutes of slack. Negative means the plan is already late.'),
  dishes: z.array(z.object({ id: z.string(), name: z.string(), course: z.string() })),
  tasks: z.array(TaskViewSchema),
  rests: z.array(z.object({ label: z.string(), start: z.string(), end: z.string() })),
  ahead_of_time: z.array(z.object({ text: z.string(), when: z.string().nullable() })),
  warnings: z.array(z.string()),
  suggestions: z.array(z.object({ kind: z.string(), message: z.string(), saves_minutes: z.number().nullable() })),
  next_step: z.object({ start_local: z.string(), step: z.string(), dish: z.string() }).nullable(),
});
export type PlanView = z.infer<typeof PlanViewSchema>;
export type TaskView = z.infer<typeof TaskViewSchema>;

export function buildView(opts: {
  planId: string;
  input: PlanInput;
  schedule: Schedule;
  nowMin: number;
  headline: string;
}): PlanView {
  const { input, schedule: s, nowMin } = opts;
  const tz = input.tz;
  const dishes = resolveDishes(input).map((d) => ({ id: d.def.id, name: d.def.name, course: d.def.course }));
  const pending = s.tasks
    .filter((t) => t.status === 'pending' && !t.preWork)
    .sort((a, b) => a.startMin - b.startMin);
  const next = pending.find((t) => t.startMin >= nowMin - 5) ?? pending[0];

  return {
    plan_id: opts.planId,
    state: s.state,
    headline: opts.headline,
    guests: input.guests,
    cooks: input.kitchen.cooks,
    ovens: input.kitchen.ovens,
    timezone: tz,
    now: iso(nowMin),
    serve_target: iso(s.requestedServeMin),
    serve_target_local: fmtClock(s.requestedServeMin, tz),
    serve_target_day: fmtDate(s.requestedServeMin, tz),
    achievable: iso(s.achievableServeMin),
    achievable_local: fmtClock(s.achievableServeMin, tz),
    slack_minutes: s.bufferMin,
    dishes,
    tasks: s.tasks.map((t) => ({
      key: t.key,
      dish: t.dishName,
      dish_id: t.dishId,
      step: t.label,
      start: iso(t.startMin),
      end: iso(t.endMin),
      start_local: fmtClock(t.startMin, tz),
      end_local: fmtClock(t.endMin, tz),
      attention: t.hands,
      appliance: t.resource ?? t.use?.appliance ?? null,
      status: t.status,
      before_cooking_window: t.preWork,
      notes: t.notes,
    })),
    rests: s.rests.map((r) => ({ label: r.label, start: iso(r.startMin), end: iso(r.endMin) })),
    ahead_of_time: s.prework.map((p) => ({ text: p.text, when: p.when ?? null })),
    warnings: s.warnings,
    suggestions: s.insights.map((i) => ({ kind: i.kind, message: i.message, saves_minutes: i.savesMin ?? null })),
    next_step: next ? { start_local: fmtClock(next.startMin, tz), step: next.label, dish: next.dishName } : null,
  };
}
