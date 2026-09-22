/**
 * Dinner Bell's domain operations, independent of MCP.
 *
 * Each method takes plain arguments and returns an Outcome: a short spoken
 * answer, an optional plan view for the screen, and optional structured data.
 * When information is missing, it asks the person through an injected `ask`
 * function: real MCP elicitation when the client supports it (Alexa+ does),
 * otherwise it returns `needsInput` with the questions so the model can ask.
 */
import {
  MENUS,
  agenda,
  applyReport,
  computeSchedule,
  dayDiff,
  defaultQuantity,
  diffSchedules,
  findDish,
  findMenu,
  humanList,
  parseWhen,
  sayAgenda,
  sayClock,
  sayDuration,
  sayOverview,
  sayPlanCreated,
  sayReport,
  searchDishes,
  toMin,
  zonedParts,
  zonedToMin,
} from '../engine/index.js';
import type { DishDef, PlanDish, PlanInput, Report, ReportStatus, Schedule, TaskDef } from '../engine/index.js';
import { Store, newId, newSecret } from './store.js';
import type { Household, PlanRecord } from './store.js';
import { buildView } from './views.js';
import type { PlanView } from './views.js';

// ───────────────────────────── asking the person ─────────────────────────────

export interface FieldSpec {
  type: 'string' | 'integer' | 'number' | 'boolean';
  title: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

export interface Question {
  message: string;
  fields: Record<string, FieldSpec>;
  required: string[];
}

export type Answer =
  | { action: 'accept'; content: Record<string, string | number | boolean | string[] | undefined> }
  | { action: 'decline' }
  | { action: 'cancel' }
  | { action: 'unsupported' };

export type Ask = (q: Question) => Promise<Answer>;

/** For clients (and tests) that cannot ask: every question becomes "unsupported". */
export const cannotAsk: Ask = async () => ({ action: 'unsupported' });

export interface Outcome {
  /** What to say aloud. */
  text: string;
  view?: PlanView;
  data?: Record<string, unknown>;
  /** The model should collect these answers and call the tool again. */
  needsInput?: string[];
  isError?: boolean;
}

export interface Deps {
  store: Store;
  /** Wall-clock in ms; overridable for demos and tests. */
  now: () => number;
}

// ───────────────────────────── helpers ─────────────────────────────

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }
  return undefined;
}

/** Split "turkey, stuffing and a pie" into names. */
function splitDishes(text: string): string[] {
  return text
    .split(/,|;|\band\b|\bplus\b|\bwith\b|&/i)
    .map((s) => s.replace(/^(a|an|the|some)\s+/i, '').trim())
    .filter(Boolean);
}

const VERB: Record<ReportStatus, (dish: string, mins?: number) => string> = {
  started: (d) => `${d.toLowerCase()} is started`,
  done: (d) => `${d.toLowerCase()} is done`,
  running_long: (d, m) => `${d.toLowerCase()} needs ${sayDuration(m ?? 15)} more`,
  skipped: (d) => `skipping the ${d.toLowerCase()}`,
};

export class DinnerBell {
  constructor(private deps: Deps) {}

  private get store(): Store {
    return this.deps.store;
  }
  private nowMin(): number {
    return toMin(this.deps.now());
  }

  private household(id: string): Household {
    return this.store.ensureHousehold(id);
  }

  private compute(rec: PlanRecord, insights = false): Schedule {
    return computeSchedule(rec.input, rec.progress, this.nowMin(), { insights });
  }

  private viewOf(rec: PlanRecord, s: Schedule, headline: string): PlanView {
    return buildView({ planId: rec.id, input: rec.input, schedule: s, nowMin: this.nowMin(), headline });
  }

  private noPlan(): Outcome {
    return {
      text: `You don't have a meal planned yet. Tell me what you're cooking and when dinner should be ready, and I'll build the plan.`,
      data: { no_plan: true },
    };
  }

  // ───────────────────────────── plan_meal ─────────────────────────────

  async planMeal(
    householdId: string,
    a: { meal?: string; dishes?: string[]; serve_time?: string; guests?: number; start_time?: string; cooks?: number; ovens?: number },
    ask: Ask,
  ): Promise<Outcome> {
    const hh = this.household(householdId);
    const tz = hh.tz;
    const now = this.nowMin();

    // 1. Which dishes?
    const ids: string[] = [];
    const unknown: string[] = [];
    const addDishFrom = (label: string): void => {
      const d = findDish(label, hh.custom);
      if (d) {
        if (!ids.includes(d.id)) ids.push(d.id);
      } else unknown.push(label);
    };
    /** "Thanksgiving" -> a whole menu; "turkey, stuffing and pie" -> those dishes. */
    const resolveMeal = (text: string): void => {
      const menu = findMenu(text);
      if (menu) {
        for (const id of menu.dishes) if (!ids.includes(id)) ids.push(id);
      } else for (const n of splitDishes(text)) addDishFrom(n);
    };
    if (a.meal) resolveMeal(a.meal);
    for (const n of a.dishes ?? []) resolveMeal(n);

    // 2. What is still missing?
    let serveText = a.serve_time?.trim();
    let guests = toInt(a.guests);
    let cooks = toInt(a.cooks) ?? hh.kitchen.cooks;
    let ovens = toInt(a.ovens) ?? hh.kitchen.ovens;
    const kitchenGiven = a.cooks !== undefined || a.ovens !== undefined;
    let kitchenAssumed = false;
    const fields: Record<string, FieldSpec> = {};
    const required: string[] = [];
    if (!ids.length) {
      fields.meal = {
        type: 'string',
        title: 'What are you cooking?',
        description: `Name an occasion like ${humanList(MENUS.slice(0, 3).map((m) => m.occasion), 'or')}, or list the dishes.`,
      };
      required.push('meal');
    }
    if (!serveText) {
      fields.serve_time = { type: 'string', title: 'What time should dinner be ready?', description: 'For example 5 PM.' };
      required.push('serve_time');
    }
    if (!guests) {
      fields.guests = { type: 'integer', title: 'How many people are you feeding?', minimum: 1, maximum: 60 };
      required.push('guests');
    }
    if (!hh.kitchenKnown && !kitchenGiven) {
      fields.cooks = { type: 'integer', title: 'How many people will be cooking?', minimum: 1, maximum: 6, default: 1 };
      fields.ovens = { type: 'integer', title: 'How many ovens can you use?', minimum: 1, maximum: 3, default: 1 };
    }

    if (Object.keys(fields).length) {
      const answer = await ask({ message: 'A few details so I can time everything.', fields, required });
      if (answer.action === 'decline' || answer.action === 'cancel') {
        return { text: `No problem. Tell me when you're ready to plan the meal.`, data: { cancelled: true } };
      }
      if (answer.action === 'unsupported') {
        // Nobody to ask. Block only on what we truly cannot guess; assume a simple kitchen.
        if (required.length) {
          const questions = required.map((k) => fields[k].title);
          return {
            text: `I need a little more. ${humanList(questions)}`,
            needsInput: questions,
            data: { missing: required, unknown_dishes: unknown },
          };
        }
        kitchenAssumed = true;
      } else if (answer.action === 'accept') {
        const c = answer.content;
        if (typeof c.meal === 'string') resolveMeal(c.meal);
        if (typeof c.serve_time === 'string') serveText = c.serve_time.trim();
        if (c.guests !== undefined) guests = toInt(c.guests) ?? guests;
        if (fields.cooks) {
          cooks = clamp(toInt(c.cooks) ?? 1, 1, 6);
          ovens = clamp(toInt(c.ovens) ?? 1, 1, 3);
        }
      }
    }
    cooks = clamp(cooks, 1, 6);
    ovens = clamp(ovens, 1, 3);

    if (!ids.length) {
      const hint = unknown.length ? `I don't know ${humanList(unknown.map((u) => `"${u}"`), 'or')} yet. ` : '';
      return {
        text: `${hint}I couldn't find any dishes in that. Try an occasion like Thanksgiving, or dishes like turkey and mashed potatoes. You can also teach me a family recipe.`,
        needsInput: ['Which dishes, or which occasion?'],
        data: { unknown_dishes: unknown },
        isError: false,
      };
    }
    if (!serveText || !guests) {
      return { text: 'I still need the serve time and the number of guests.', needsInput: ['What time should dinner be ready?', 'How many people?'] };
    }

    // 3. Times.
    const serveMin = parseWhen(serveText, { nowMin: now, tz, prefer: 'pm' });
    if (!serveMin) {
      return {
        text: `I didn't catch that time. Try something like 5 PM or 6:30 in the evening.`,
        needsInput: ['What time should dinner be ready?'],
        isError: false,
      };
    }
    if (serveMin <= now + 30) {
      return { text: `That time has already passed or is too close. Pick a later time for dinner.`, needsInput: ['What time should dinner be ready?'] };
    }
    let startAt: number;
    if (a.start_time) {
      const parsed = parseWhen(a.start_time, { nowMin: now, tz, prefer: 'am', after: now - 1 });
      startAt = parsed ?? now;
    } else if (dayDiff(now, serveMin, tz) > 0) {
      const p = zonedParts(serveMin, tz);
      startAt = zonedToMin(p.year, p.month, p.day, 8, 0, tz);
    } else startAt = now;
    startAt = Math.max(startAt, now);
    if (startAt >= serveMin - 20) startAt = Math.max(now, serveMin - 20);

    // 4. Build and solve.
    const g = clamp(guests, 1, 60);
    const dishes: PlanDish[] = ids.map((dishId) => ({ dishId }));
    const input: PlanInput = {
      serveAt: serveMin,
      startAt,
      guests: g,
      dishes,
      kitchen: { ovens, burners: hh.kitchen.burners, cooks, extras: hh.kitchen.extras },
      marginMin: 10,
      tz,
      custom: hh.custom.filter((d) => ids.includes(d.id)),
    };
    if (!kitchenAssumed && (!hh.kitchenKnown || kitchenGiven)) {
      hh.kitchen = { ...hh.kitchen, cooks, ovens };
      hh.kitchenKnown = true;
      this.store.saveHousehold(hh);
    }

    const previous = this.store.activePlan(householdId);
    if (previous) {
      previous.status = 'ended';
      this.store.savePlan(previous);
    }

    const schedule = computeSchedule(input, {}, now, { insights: true });
    const rec: PlanRecord = {
      id: newId('plan'),
      householdId,
      input,
      progress: {},
      baseline: schedule,
      log: [{ at: now, text: 'Plan created' }],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.savePlan(rec);

    let text = sayPlanCreated(schedule, { tz, guests: g, dishCount: ids.length });
    if (unknown.length) text += ` I didn't recognise ${humanList(unknown.map((u) => `"${u}"`), 'or')}, so I left ${unknown.length === 1 ? 'it' : 'them'} out.`;
    if (kitchenAssumed) text += ' I assumed one cook and one oven; tell me if that is different.';
    if (previous) text += ' This replaces your earlier plan.';
    return { text, view: this.viewOf(rec, schedule, text), data: { unknown_dishes: unknown } };
  }

  // ───────────────────────────── whats_next ─────────────────────────────

  async whatsNext(householdId: string, a: { minutes_ahead?: number } = {}): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const tz = rec.input.tz;
    const now = this.nowMin();
    const s = this.compute(rec, true);
    const ag = agenda(s, now, clamp(a.minutes_ahead ?? 30, 5, 120));
    let text = sayAgenda(ag, s, tz, now);

    // If the plan slipped since the cook last heard, say so first.
    if (rec.baseline) {
      const d = diffSchedules(rec.baseline, s);
      if (s.state === 'late' && rec.baseline.state !== 'late') text = `Heads up: ${sayOverviewSlip(s, tz)} ${text}`;
      else if (d.bufferDelta <= -15) text = `You've slipped a bit. Slack is down to ${s.bufferMin > 0 ? sayDuration(s.bufferMin) : 'nothing'}. ${text}`;
    }
    rec.baseline = s;
    this.store.savePlan(rec);
    return { text, view: this.viewOf(rec, s, text), data: { running: ag.running.length, start_now: ag.startNow.length } };
  }

  // ───────────────────────────── report_progress ─────────────────────────────

  async reportProgress(
    householdId: string,
    a: { dish: string; status: ReportStatus; step?: string; minutes_left?: number },
  ): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const tz = rec.input.tz;
    const now = this.nowMin();
    const before = rec.baseline ?? this.compute(rec);
    const current = this.compute(rec);
    const report: Report = { dish: a.dish, status: a.status, step: a.step, remainingMin: a.minutes_left };
    const r = applyReport(current, rec.progress, rec.input, report, now);
    if (!r.ok) {
      return { text: `${r.error}${r.candidates ? ` This meal has ${humanList(r.candidates.map((c) => c.toLowerCase()))}.` : ''}`, data: { candidates: r.candidates ?? [] }, isError: true };
    }
    rec.progress = r.progress;
    rec.log.push({ at: now, text: `${a.dish}: ${a.status}${a.step ? ` (${a.step})` : ''}` });
    const s = computeSchedule(rec.input, rec.progress, now, { insights: true });
    const diff = diffSchedules(before, s);
    rec.baseline = s;
    this.store.savePlan(rec);
    const text = sayReport(VERB[a.status](r.dishName, a.minutes_left), r.dishName, s, diff, tz);
    return {
      text,
      view: this.viewOf(rec, s, text),
      data: { moved_steps: diff.moved.map((m) => ({ step: m.label, dish: m.dishName, from: m.from, to: m.to })), slack_change_minutes: diff.bufferDelta },
    };
  }

  // ───────────────────────────── change_plan ─────────────────────────────

  async changePlan(
    householdId: string,
    a: {
      serve_time?: string;
      guests?: number;
      add_dishes?: string[];
      remove_dishes?: string[];
      cooks?: number;
      ovens?: number;
    },
  ): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const hh = this.household(householdId);
    const tz = rec.input.tz;
    const now = this.nowMin();
    const before = rec.baseline ?? this.compute(rec);
    const input: PlanInput = JSON.parse(JSON.stringify(rec.input));
    const notes: string[] = [];
    const unknown: string[] = [];

    if (a.serve_time) {
      const m = parseWhen(a.serve_time, { nowMin: now, tz, prefer: 'pm' });
      if (!m || m <= now) return { text: `I didn't catch a usable time. Try something like 6 PM.`, needsInput: ['What time should dinner be ready?'] };
      input.serveAt = m;
      notes.push(`dinner at ${sayClock(m, tz)}`);
    }
    const g = toInt(a.guests);
    if (g) {
      input.guests = clamp(g, 1, 60);
      notes.push(`${input.guests} guests`);
    }
    if (a.cooks) input.kitchen.cooks = clamp(toInt(a.cooks) ?? input.kitchen.cooks, 1, 6);
    if (a.ovens) input.kitchen.ovens = clamp(toInt(a.ovens) ?? input.kitchen.ovens, 0, 3);
    for (const name of a.remove_dishes ?? []) {
      const d = findDish(name, [...hh.custom, ...(input.custom ?? [])]);
      if (d && input.dishes.some((x) => x.dishId === d.id)) {
        input.dishes = input.dishes.filter((x) => x.dishId !== d.id);
        for (const k of Object.keys(rec.progress)) if (k.startsWith(`${d.id}.`)) delete rec.progress[k];
        notes.push(`dropped the ${d.name.toLowerCase()}`);
      } else unknown.push(name);
    }
    for (const name of a.add_dishes ?? []) {
      const d = findDish(name, hh.custom);
      if (d) {
        if (!input.dishes.some((x) => x.dishId === d.id)) {
          input.dishes.push({ dishId: d.id });
          if (hh.custom.some((c) => c.id === d.id) && !input.custom?.some((c) => c.id === d.id)) (input.custom ??= []).push(d);
          notes.push(`added ${d.name.toLowerCase()}`);
        }
      } else unknown.push(name);
    }
    if (!input.dishes.length) return { text: 'That would leave nothing to cook. Say cancel the plan if you want to stop.', isError: true };

    rec.input = input;
    rec.log.push({ at: now, text: `Changed: ${notes.join(', ') || 'nothing'}` });
    const s = computeSchedule(input, rec.progress, now, { insights: true });
    const diff = diffSchedules(before, s);
    rec.baseline = s;
    this.store.savePlan(rec);
    let text = sayReport(`I ${notes.length ? `updated the plan: ${humanList(notes)}` : 'checked the plan'}`, '', s, diff, tz);
    if (unknown.length) text += ` I didn't recognise ${humanList(unknown.map((u) => `"${u}"`), 'or')}.`;
    return { text, view: this.viewOf(rec, s, text), data: { unknown_dishes: unknown } };
  }

  // ───────────────────────────── show_timeline ─────────────────────────────

  async showTimeline(householdId: string): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const s = this.compute(rec, true);
    const text = sayOverview(s, rec.input.tz);
    return { text, view: this.viewOf(rec, s, text) };
  }

  // ───────────────────────────── prep checklist ─────────────────────────────

  async prepChecklist(householdId: string): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const s = this.compute(rec);
    if (!s.prework.length) {
      return { text: 'Nothing to do ahead of time. Everything happens on the day.', view: this.viewOf(rec, s, 'Nothing to do ahead of time.') };
    }
    const scheduled = s.prework.filter((p) => p.when && p.when !== 'in the days before');
    const days = s.prework.filter((p) => p.when === 'in the days before');
    const parts: string[] = [];
    if (scheduled.length) {
      const when = scheduled[0].when!;
      const names = [...new Set(scheduled.map((p) => p.text.split(':')[0].toLowerCase()))];
      parts.push(`For ${when}: make ${humanList(names)}.`);
    }
    if (days.length) parts.push(days.map((d) => d.text.replace(/^[^:]+:\s*/, '')).slice(0, 2).join(' '));
    const text = parts.join(' ');
    return { text, view: this.viewOf(rec, s, text), data: { items: s.prework } };
  }

  // ───────────────────────────── browse ─────────────────────────────

  async browseDishes(householdId: string, a: { query?: string }): Promise<Outcome> {
    const hh = this.household(householdId);
    const q = (a.query ?? '').trim();
    const menu = q ? findMenu(q) : undefined;
    const dishes = searchDishes(q, hh.custom).slice(0, 8);
    const menus = MENUS.map((m) => ({ id: m.id, name: m.name, occasion: m.occasion, dishes: m.dishes }));
    const brief = (d: DishDef) => ({ id: d.id, name: d.name, course: d.course, cuisine: d.cuisine, tags: d.tags });
    let text: string;
    if (menu) {
      const names = menu.dishes.map((id) => findDish(id)?.name.toLowerCase() ?? id);
      text = `For ${menu.occasion} I'd do ${menu.name}: ${humanList(names)}. Say plan it, and tell me the time and how many guests.`;
    } else if (dishes.length) {
      text = `I found ${dishes.length} ${dishes.length === 1 ? 'dish' : 'dishes'}: ${humanList(dishes.slice(0, 5).map((d) => d.name.toLowerCase()))}.`;
    } else {
      text = `I don't have anything for that yet. I know menus for ${humanList(MENUS.slice(0, 4).map((m) => m.occasion))}, and you can teach me your own recipes.`;
    }
    return { text, data: { menus: menu ? [menus.find((m) => m.id === menu.id)] : menus, dishes: dishes.map(brief) } };
  }

  // ───────────────────────────── family recipes ─────────────────────────────

  async addFamilyRecipe(
    householdId: string,
    a: {
      name?: string;
      course?: string;
      method?: string;
      oven_temp_f?: number;
      cook_minutes?: number;
      prep_minutes?: number;
      hands_off?: boolean;
      make_ahead?: boolean;
      serves?: number;
    },
    ask: Ask,
  ): Promise<Outcome> {
    const hh = this.household(householdId);
    const fields: Record<string, FieldSpec> = {};
    const required: string[] = [];
    if (!a.name) {
      fields.name = { type: 'string', title: `What's the dish called?` };
      required.push('name');
    }
    if (!a.course) {
      fields.course = { type: 'string', title: 'Is it a main, side, bread, dessert, or starter?', enum: ['main', 'side', 'bread', 'dessert', 'starter'] };
      required.push('course');
    }
    if (!a.method) {
      fields.method = { type: 'string', title: 'Does it cook in the oven, on the stovetop, or not at all?', enum: ['oven', 'stovetop', 'no cooking'] };
      required.push('method');
    }
    if (a.cook_minutes === undefined) {
      fields.cook_minutes = { type: 'integer', title: 'How many minutes does it cook?', minimum: 0, maximum: 600 };
      required.push('cook_minutes');
    }
    if (a.prep_minutes === undefined) {
      fields.prep_minutes = { type: 'integer', title: 'How many minutes of prep before it cooks?', minimum: 0, maximum: 300, default: 15 };
    }
    if (a.hands_off === undefined) fields.hands_off = { type: 'boolean', title: 'Can it cook without you watching?', default: true };
    if (a.make_ahead === undefined) fields.make_ahead = { type: 'boolean', title: 'Can it be made the day before?', default: false };

    const v: Record<string, string | number | boolean | string[] | undefined> = { ...a };
    if (Object.keys(fields).length) {
      const ans = await ask({ message: 'Tell me about the recipe so I can time it.', fields, required });
      if (ans.action === 'decline' || ans.action === 'cancel') return { text: `Okay, I won't save it.` };
      if (ans.action === 'unsupported') {
        const questions = required.map((k) => fields[k].title);
        return { text: `To save it I need: ${humanList(questions)}`, needsInput: questions };
      }
      Object.assign(v, ans.content);
    }

    const name = String(v.name ?? '').trim();
    if (!name) return { text: `I need a name for the dish.`, needsInput: [`What's the dish called?`] };
    const course = (['main', 'side', 'bread', 'dessert', 'starter'].includes(String(v.course)) ? String(v.course) : 'side') as DishDef['course'];
    const method = String(v.method ?? 'oven');
    const cookMin = clamp(toInt(v.cook_minutes) ?? 30, 0, 600);
    const prepMin = clamp(toInt(v.prep_minutes) ?? 15, 0, 300);
    const handsOff = v.hands_off !== false;
    const makeAhead = v.make_ahead === true;
    const temp = clamp(toInt(v.oven_temp_f) ?? 350, 200, 500);

    const id = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}`;
    const tasks: TaskDef[] = [];
    if (prepMin > 0) tasks.push({ id: 'prep', label: `Prepare the ${name.toLowerCase()}`, minutes: prepMin, hands: 'full', ...(makeAhead ? { makeAhead: 1440 } : {}) });
    if (cookMin > 0 && method !== 'no cooking') {
      tasks.push({
        id: 'cook',
        label: `Cook the ${name.toLowerCase()}`,
        minutes: cookMin,
        hands: handsOff ? 'none' : 'light',
        uses: [method === 'stovetop' ? { appliance: 'burner' } : { appliance: 'oven', tempF: temp, slots: 1, tempFlex: 25 }],
        ...(prepMin > 0 ? { after: ['prep'] } : {}),
        ...(makeAhead && prepMin === 0 ? { makeAhead: 1440 } : {}),
      });
    }
    if (!tasks.length) tasks.push({ id: 'make', label: `Make the ${name.toLowerCase()}`, minutes: Math.max(5, prepMin || cookMin), hands: 'full' });
    const dish: DishDef = {
      id,
      name,
      aliases: [name.toLowerCase()],
      course,
      cuisine: 'Family',
      tags: ['family'],
      servings: clamp(toInt(v.serves) ?? 8, 1, 60),
      holdMin: makeAhead ? 1440 : course === 'dessert' ? 60 : course === 'bread' ? 20 : course === 'starter' ? 15 : 30,
      tasks,
      blurb: 'Your family recipe.',
    };
    hh.custom = [...hh.custom.filter((d) => d.id !== id), dish];
    this.store.saveHousehold(hh);
    return {
      text: `Saved ${name}. Say add ${name} to the meal whenever you want it in a plan.`,
      data: { dish_id: id, name, course, tasks: tasks.length, quantity_default: defaultQuantity(dish, 8) ?? null },
    };
  }

  // ───────────────────────────── cancel ─────────────────────────────

  async cancelPlan(householdId: string, a: { confirm?: boolean }, ask: Ask): Promise<Outcome> {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    let confirmed = a.confirm === true;
    if (!confirmed) {
      const ans = await ask({
        message: 'This will end your current meal plan.',
        fields: { confirm: { type: 'boolean', title: 'Do you want to end the current meal plan?', default: false } },
        required: ['confirm'],
      });
      if (ans.action === 'accept') confirmed = ans.content.confirm === true;
      else if (ans.action === 'unsupported') {
        return { text: `Are you sure you want to end the current plan? Say yes and I'll do it.`, needsInput: ['Do you want to end the current meal plan?'] };
      }
    }
    if (!confirmed) return { text: `Okay, I'll keep the plan.`, data: { cancelled: false } };
    rec.status = 'ended';
    rec.log.push({ at: this.nowMin(), text: 'Plan ended' });
    this.store.savePlan(rec);
    return { text: `Done. I've ended the plan. Enjoy the meal.`, data: { cancelled: true } };
  }

  // ───────────────────────────── the public gallery: publish, fork, share ─────────────────────────────

  /** Every custom dish a household has, with which ones are already public. */
  myDishes(householdId: string): { id: string; name: string; course: string; published: boolean }[] {
    const hh = this.household(householdId);
    return hh.custom.map((d) => ({ id: d.id, name: d.name, course: d.course, published: hh.publishedDishIds.includes(d.id) }));
  }

  setDishPublished(householdId: string, dishId: string, published: boolean): Outcome {
    if (published) {
      const ok = this.store.publishDish(householdId, dishId);
      if (!ok) return { text: `I couldn't find that dish in your kitchen.`, isError: true };
      return { text: `Published. Anyone can find and fork it from the gallery now.`, data: { dish_id: dishId, published: true } };
    }
    this.store.unpublishDish(householdId, dishId);
    return { text: `Made it private again.`, data: { dish_id: dishId, published: false } };
  }

  /** The public dish gallery: every published dish across every kitchen. */
  discover(): { id: string; name: string; course: string; cuisine: string; tags: string[]; blurb?: string; author: string; householdId: string }[] {
    return this.store.publicDishes().map(({ dish, authorName, householdId }) => ({
      id: dish.id,
      name: dish.name,
      course: dish.course,
      cuisine: dish.cuisine,
      tags: dish.tags,
      blurb: dish.blurb,
      author: authorName,
      householdId,
    }));
  }

  /** Copy a published dish from another kitchen into this one, so the caller can build on it. */
  forkDish(intoHouseholdId: string, fromHouseholdId: string, dishId: string): Outcome {
    const source = this.store.household(fromHouseholdId);
    const dish = source?.custom.find((d) => d.id === dishId);
    if (!source || !dish || !source.publishedDishIds.includes(dishId)) {
      return { text: `That dish isn't available to fork.`, isError: true };
    }
    const into = this.household(intoHouseholdId);
    const forkedId = `${dishId}_fork_${newSecret().slice(0, 6).toLowerCase()}`;
    const forked: DishDef = { ...dish, id: forkedId, aliases: [dish.name.toLowerCase()] };
    into.custom = [...into.custom, forked];
    this.store.saveHousehold(into);
    return { text: `Added ${dish.name} to your kitchen. Say plan it whenever you're ready.`, data: { dish_id: forkedId, name: dish.name } };
  }

  /** Turn the active plan into a public, no-login-required link. */
  sharePlan(householdId: string): Outcome {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    const slug = this.store.sharePlan(rec);
    return { text: `Anyone with the link can now see this plan.`, data: { slug, url: `/p/${slug}` } };
  }

  unsharePlan(householdId: string): Outcome {
    const rec = this.store.activePlan(householdId);
    if (!rec) return this.noPlan();
    this.store.unsharePlan(rec);
    return { text: `That link no longer works.`, data: { unshared: true } };
  }

  /** Read-only view of a publicly shared plan — no household/session required. */
  publicPlan(slug: string): { view: PlanView; householdName: string } | undefined {
    const rec = this.store.planBySlug(slug);
    if (!rec) return undefined;
    const hh = this.store.household(rec.householdId);
    const s = this.compute(rec, true);
    return { view: this.viewOf(rec, s, sayOverview(s, rec.input.tz)), householdName: hh?.name ?? 'A Dinner Bell kitchen' };
  }
}

function sayOverviewSlip(s: Schedule, tz: string): string {
  return `you're now ${sayDuration(-s.bufferMin)} behind, so dinner would be ready at ${sayClock(s.achievableServeMin, tz)}.`;
}
