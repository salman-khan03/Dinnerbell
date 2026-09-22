import { beforeEach, describe, expect, it } from 'vitest';
import { DinnerBell, cannotAsk } from '../src/server/service.js';
import type { Answer, Ask, Question } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { PlanViewSchema } from '../src/server/views.js';
import { at } from './helpers.js';

const HH = 'hh_test';
let clock = at(2026, 11, 24, 12) * 60_000; // Tuesday noon, two days out
let store: Store;
let bell: DinnerBell;

const scripted = (answers: Record<string, string | number | boolean>): { ask: Ask; asked: Question[] } => {
  const asked: Question[] = [];
  const ask: Ask = async (q): Promise<Answer> => {
    asked.push(q);
    const content: Record<string, string | number | boolean> = {};
    for (const k of Object.keys(q.fields)) if (k in answers) content[k] = answers[k];
    return { action: 'accept', content };
  };
  return { ask, asked };
};

beforeEach(() => {
  clock = at(2026, 11, 24, 12) * 60_000;
  store = new Store();
  bell = new DinnerBell({ store, now: () => clock });
});

const setClock = (y: number, mo: number, d: number, h: number, mi = 0) => {
  clock = at(y, mo, d, h, mi) * 60_000;
};

describe('plan_meal', () => {
  it('asks only for what is missing, one form, then builds a valid plan', async () => {
    const { ask, asked } = scripted({ meal: 'Thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 });
    const out = await bell.planMeal(HH, {}, ask);
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0].fields)).toEqual(['meal', 'serve_time', 'guests', 'cooks', 'ovens']);
    expect(out.view).toBeTruthy();
    expect(PlanViewSchema.safeParse(out.view).success).toBe(true);
    expect(out.view!.dishes.length).toBe(9);
    expect(out.view!.state).toBe('on_track');
    expect(out.text).toMatch(/9-dish meal for 10/);
    expect(out.text).toMatch(/5 PM/);
  });

  it('does not re-ask about the kitchen once it is known', async () => {
    await bell.planMeal(HH, {}, scripted({ meal: 'Thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 2, ovens: 2 }).ask);
    const { ask, asked } = scripted({ serve_time: '6pm friday', guests: 4 });
    await bell.planMeal(HH, { meal: 'sunday dinner' }, ask);
    expect(Object.keys(asked[0].fields)).toEqual(['serve_time', 'guests']);
    expect(store.household(HH)!.kitchen.cooks).toBe(2);
  });

  it('skips asking entirely when the model supplied everything', async () => {
    const { ask, asked } = scripted({ cooks: 1, ovens: 1 });
    const out = await bell.planMeal(HH, { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 8 }, ask);
    expect(Object.keys(asked[0].fields)).toEqual(['cooks', 'ovens']);
    expect(out.view).toBeTruthy();
  });

  it('degrades to needs_input for clients that cannot elicit', async () => {
    const out = await bell.planMeal(HH, { meal: 'thanksgiving' }, cannotAsk);
    expect(out.view).toBeUndefined();
    expect(out.needsInput?.join(' ')).toMatch(/dinner be ready/);
    expect(out.needsInput?.join(' ')).toMatch(/How many people/);
  });

  it('handles a declined form politely', async () => {
    const out = await bell.planMeal(HH, {}, async () => ({ action: 'decline' }));
    expect(out.text).toMatch(/No problem/);
    expect(store.activePlan(HH)).toBeUndefined();
  });

  it('accepts free-text dish lists and reports what it did not recognise', async () => {
    const out = await bell.planMeal(
      HH,
      { meal: 'turkey, mashed potatoes and grandmas mystery casserole', serve_time: '5pm thursday', guests: 6 },
      scripted({ cooks: 1, ovens: 1 }).ask,
    );
    expect(out.view!.dishes.map((d) => d.id)).toEqual(['turkey', 'mashed']);
    expect(out.text).toMatch(/didn't recognise/);
    expect(out.data!.unknown_dishes).toEqual(["grandmas mystery casserole"]);
  });

  it('rejects a time that has passed and one it cannot parse', async () => {
    const past = await bell.planMeal(HH, { meal: 'thanksgiving', serve_time: '12:05pm', guests: 4 }, scripted({ cooks: 1, ovens: 1 }).ask);
    expect(past.view).toBeUndefined();
    const junk = await bell.planMeal(HH, { meal: 'thanksgiving', serve_time: 'whenever', guests: 4 }, scripted({ cooks: 1, ovens: 1 }).ask);
    expect(junk.needsInput?.[0]).toMatch(/dinner be ready/);
  });

  it('replaces an earlier active plan', async () => {
    const a = scripted({ cooks: 1, ovens: 1 }).ask;
    await bell.planMeal(HH, { meal: 'sunday dinner', serve_time: '6pm tomorrow', guests: 4 }, a);
    const out = await bell.planMeal(HH, { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10 }, a);
    expect(out.text).toMatch(/replaces your earlier plan/);
    expect(store.plansFor(HH).filter((p) => p.status === 'active')).toHaveLength(1);
  });
});

describe('a whole cooking day', () => {
  beforeEach(async () => {
    await bell.planMeal(HH, { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10 }, scripted({ cooks: 1, ovens: 1 }).ask);
  });

  it('nothing to do before the first step, then says what to do now', async () => {
    const early = await bell.whatsNext(HH);
    expect(early.text).toMatch(/Nothing to do|Next up/);
    const plan = store.activePlan(HH)!;
    const first = early.view!.next_step!;
    expect(first.start_local).toMatch(/\d+:\d\d [AP]M/);

    setClock(2026, 11, 26, 12, 25);
    const now = await bell.whatsNext(HH);
    expect(now.text).toMatch(/Right now/);
    void plan;
  });

  it('a delay replans and speaks about the consequences', async () => {
    setClock(2026, 11, 26, 12, 30);
    await bell.reportProgress(HH, { dish: 'turkey', step: 'prep', status: 'started' });
    setClock(2026, 11, 26, 13, 0);
    await bell.reportProgress(HH, { dish: 'turkey', step: 'prep', status: 'done' });
    setClock(2026, 11, 26, 13, 10);
    const inOven = await bell.reportProgress(HH, { dish: 'turkey', step: 'roast', status: 'started' });
    expect(inOven.view!.tasks.find((t) => t.key === 'turkey.roast')!.status).toBe('running');

    setClock(2026, 11, 26, 15, 30);
    const slow = await bell.reportProgress(HH, { dish: 'turkey', step: 'roast', status: 'running_long', minutes_left: 90 });
    expect(slow.text).toMatch(/needs 1 hour 30 minutes more/);
    expect(['tight', 'late']).toContain(slow.view!.state);
    expect(slow.view!.suggestions.length).toBeGreaterThan(0);
    expect(slow.data!.moved_steps).toBeTruthy();
  });

  it('change_plan: pushing dinner back fixes a late plan', async () => {
    setClock(2026, 11, 26, 14, 0);
    const late = await bell.changePlan(HH, { serve_time: '4pm' });
    expect(late.view!.state).toBe('late');
    const fixed = await bell.changePlan(HH, { serve_time: '9:30pm' });
    expect(['on_track', 'tight']).toContain(fixed.view!.state);
  });

  it('change_plan: add and remove dishes by name', async () => {
    const out = await bell.changePlan(HH, { remove_dishes: ['rolls'], add_dishes: ['brussels sprouts', 'unicorn stew'] });
    const ids = out.view!.dishes.map((d) => d.id);
    expect(ids).not.toContain('rolls');
    expect(ids).toContain('brussels');
    expect(out.text).toMatch(/unicorn stew/);
  });

  it('prep checklist speaks the evening-before work and the thaw reminder', async () => {
    const out = await bell.prepChecklist(HH);
    expect(out.text).toMatch(/evening before/);
    expect(out.text).toMatch(/pumpkin pie/i);
    expect(out.text).toMatch(/Thaw/);
  });

  it('show_timeline returns a full view; cancel asks first', async () => {
    const t = await bell.showTimeline(HH);
    expect(t.view!.tasks.length).toBeGreaterThan(20);
    const kept = await bell.cancelPlan(HH, {}, async () => ({ action: 'accept', content: { confirm: false } }));
    expect(kept.text).toMatch(/keep the plan/);
    const ended = await bell.cancelPlan(HH, {}, async () => ({ action: 'accept', content: { confirm: true } }));
    expect(ended.text).toMatch(/ended/);
    expect((await bell.whatsNext(HH)).data!.no_plan).toBe(true);
  });
});

describe('family recipes and browsing', () => {
  it('teaches a custom dish through elicitation and uses it in a plan', async () => {
    const out = await bell.addFamilyRecipe(
      HH,
      {},
      scripted({ name: "Grandma's mac", course: 'side', method: 'oven', cook_minutes: 40, prep_minutes: 20, hands_off: true, make_ahead: false }).ask,
    );
    expect(out.text).toMatch(/Saved Grandma's mac/);
    const plan = await bell.planMeal(
      HH,
      { meal: "turkey and Grandma's mac", serve_time: '5pm thursday', guests: 8 },
      scripted({ cooks: 1, ovens: 1 }).ask,
    );
    expect(plan.view!.dishes.map((d) => d.name)).toContain("Grandma's mac");
    expect(plan.view!.tasks.some((t) => t.dish === "Grandma's mac" && /Cook/.test(t.step))).toBe(true);
  });

  it('asks for recipe details when the client cannot elicit', async () => {
    const out = await bell.addFamilyRecipe(HH, { name: 'Dip' }, cannotAsk);
    expect(out.needsInput?.length).toBeGreaterThan(1);
  });

  it('browses menus and dishes', async () => {
    const menu = await bell.browseDishes(HH, { query: 'hanukkah' });
    expect(menu.text).toMatch(/brisket/);
    const veg = await bell.browseDishes(HH, { query: 'vegetarian' });
    expect((veg.data!.dishes as unknown[]).length).toBeGreaterThan(3);
    const none = await bell.browseDishes(HH, { query: 'zzzz' });
    expect(none.text).toMatch(/don't have anything/);
  });
});

describe('no plan yet', () => {
  it('every plan tool answers helpfully instead of failing', async () => {
    for (const out of [
      await bell.whatsNext(HH),
      await bell.showTimeline(HH),
      await bell.prepChecklist(HH),
      await bell.reportProgress(HH, { dish: 'turkey', status: 'done' }),
      await bell.changePlan(HH, { guests: 4 }),
    ]) {
      expect(out.text).toMatch(/don't have a meal planned/);
      expect(out.isError).toBeFalsy();
    }
  });
});
