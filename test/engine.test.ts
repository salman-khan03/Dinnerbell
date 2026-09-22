import { describe, expect, it } from 'vitest';
import { computeSchedule } from '../src/engine/planner.js';
import { DISHES, MENUS, findDish, findMenu, searchDishes } from '../src/engine/library.js';
import { applyReport, agenda, diffSchedules } from '../src/engine/progress.js';
import { parseWhen, sayClock, sayDuration, zonedParts } from '../src/engine/time.js';
import { sayAgenda, sayPlanCreated } from '../src/engine/voice.js';
import type { PlanInput, Progress } from '../src/engine/types.js';
import { NOW_PLANNING, TZ, at, kitchen, onPlanProgress, thanksgiving, violations } from './helpers.js';

const key = (s: ReturnType<typeof computeSchedule>, k: string) => s.tasks.find((t) => t.key === k)!;

describe('library integrity', () => {
  it('every dependency points at a real task in the same dish or a real dish.task', () => {
    for (const d of DISHES) {
      const local = new Set(d.tasks.map((t) => t.id));
      for (const t of d.tasks) {
        for (const dep of t.after ?? []) {
          const ref = typeof dep === 'string' ? dep : dep.task;
          if (ref.includes('.')) {
            const [dish, task] = ref.split('.');
            const target = DISHES.find((x) => x.id === dish);
            expect(target, `${d.id}.${t.id} -> ${ref}`).toBeTruthy();
            expect(target!.tasks.some((x) => x.id === task), `${d.id}.${t.id} -> ${ref}`).toBe(true);
          } else expect(local.has(ref), `${d.id}.${t.id} -> ${ref}`).toBe(true);
        }
      }
    }
  });

  it('dish ids are unique and every menu dish exists', () => {
    expect(new Set(DISHES.map((d) => d.id)).size).toBe(DISHES.length);
    for (const m of MENUS) for (const id of m.dishes) expect(DISHES.some((d) => d.id === id), `${m.id}:${id}`).toBe(true);
  });

  it('finds dishes by name, alias and loose phrasing', () => {
    expect(findDish('mashed potatoes')?.id).toBe('mashed');
    expect(findDish('Thanksgiving turkey')?.id).toBe('turkey');
    expect(findDish('candied yams')?.id).toBe('sweet_potatoes');
    expect(findDish('mac n cheese')?.id).toBe('mac');
    expect(findDish('nonexistent unicorn stew')).toBeUndefined();
    expect(findMenu('thanksgiving')?.id).toBe('thanksgiving');
    expect(findMenu('hanukkah dinner')?.id).toBe('hanukkah');
    expect(searchDishes('vegetarian holiday').every((d) => d.tags.includes('vegetarian'))).toBe(true);
  });
});

describe('time parsing', () => {
  const now = at(2026, 11, 24, 12);
  it('parses common spoken forms', () => {
    const p = (s: string, after?: number) => parseWhen(s, { nowMin: now, tz: TZ, after });
    expect(p('6pm')).toBe(at(2026, 11, 24, 18));
    expect(p('6:30 PM')).toBe(at(2026, 11, 24, 18, 30));
    expect(p('18:00')).toBe(at(2026, 11, 24, 18));
    expect(p('noon tomorrow')).toBe(at(2026, 11, 25, 12));
    expect(p('tomorrow at 5')).toBe(at(2026, 11, 25, 17));
    expect(p('thanksgiving at 5')).toBe(at(2026, 11, 26, 17));
    expect(p('thursday 4:30pm')).toBe(at(2026, 11, 26, 16, 30));
    expect(p('2026-11-26T17:00:00Z')).toBe(Date.UTC(2026, 10, 26, 17) / 60000);
    expect(p('2026-11-26T17:00:00')).toBe(at(2026, 11, 26, 17));
    expect(p('gibberish')).toBeNull();
  });
  it('rolls an already-passed time to the next day', () => {
    expect(parseWhen('9am', { nowMin: now, tz: TZ })).toBe(at(2026, 11, 25, 9));
  });
  it('formats clocks and durations for speech', () => {
    expect(sayClock(at(2026, 11, 26, 17), TZ)).toBe('5 PM');
    expect(sayClock(at(2026, 11, 26, 9, 5), TZ)).toBe('9:05 AM');
    expect(sayDuration(1)).toBe('1 minute');
    expect(sayDuration(125)).toBe('2 hours 5 minutes');
    expect(sayDuration(60)).toBe('1 hour');
  });
});

describe('planner: the classic Thanksgiving', () => {
  const input = thanksgiving();
  const s = computeSchedule(input, {}, NOW_PLANNING);

  it('produces an on-track plan a single cook can follow', () => {
    expect(s.state).toBe('on_track');
    expect(s.achievableServeMin).toBe(input.serveAt);
    expect(violations(input, s, NOW_PLANNING)).toEqual([]);
  });

  it('is fast enough to run inside a voice turn', () => {
    const t0 = performance.now();
    computeSchedule(input, {}, NOW_PLANNING, { insights: true });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('is deterministic', () => {
    const again = computeSchedule(input, {}, NOW_PLANNING);
    expect(again.tasks.map((t) => [t.key, t.startMin, t.endMin, t.resource])).toEqual(
      s.tasks.map((t) => [t.key, t.startMin, t.endMin, t.resource]),
    );
  });

  it('roasts the turkey ~13 minutes a pound and rests it 30 to 60 minutes before carving', () => {
    const roast = key(s, 'turkey.roast');
    const carve = key(s, 'turkey.carve');
    // 10 guests * 1.25 = 13 lb (rounded) -> 169 min -> 170 on the grid
    expect(roast.endMin - roast.startMin).toBe(170);
    const rest = carve.startMin - roast.endMin;
    expect(rest).toBeGreaterThanOrEqual(30);
    expect(rest).toBeLessThanOrEqual(60);
    expect(s.rests.some((r) => r.label === 'Turkey rests')).toBe(true);
  });

  it('makes gravy from drippings only after the turkey comes out', () => {
    expect(key(s, 'gravy.finish').startMin).toBeGreaterThanOrEqual(key(s, 'turkey.roast').endMin);
  });

  it('bakes the sides inside the turkey rest, since the turkey needs the whole oven', () => {
    const roast = key(s, 'turkey.roast');
    for (const k of ['stuffing.bake', 'green_bean.bake', 'sweet_potatoes.bake', 'rolls.bake']) {
      const t = key(s, k);
      expect(t.startMin >= roast.endMin || t.endMin <= roast.startMin, `${k} overlaps the roast`).toBe(true);
    }
  });

  it('moves make-ahead dishes to the evening before, at humane hours', () => {
    const pie = ['make', 'bake', 'cool'].map((x) => key(s, `pumpkin_pie.${x}`));
    expect(pie.every((t) => t.preWork)).toBe(true);
    const hour = zonedParts(pie[0].startMin, TZ).hour;
    expect(hour).toBeGreaterThanOrEqual(7);
    expect(hour).toBeLessThan(22);
    expect(s.prework.some((p) => p.when === 'the evening before' && /pie/i.test(p.text))).toBe(true);
    expect(s.prework.some((p) => /thaw/i.test(p.text))).toBe(true);
  });

  it('does not let dough sit unrisen for hours', () => {
    const mix = key(s, 'rolls.mix');
    const rise = key(s, 'rolls.rise');
    expect(rise.startMin - mix.endMin).toBeLessThanOrEqual(15);
  });
});

describe('planner: honesty when the plan does not fit', () => {
  it('starting too late with one cook and one oven says so and offers real fixes', () => {
    const input = thanksgiving({ startAt: at(2026, 11, 26, 13) });
    const now = input.startAt;
    const s = computeSchedule(input, {}, now, { insights: true });
    expect(s.state).toBe('late');
    expect(s.achievableServeMin).toBeGreaterThan(input.serveAt);
    expect(s.bufferMin).toBeLessThan(0);
    expect(violations(input, s, now)).toEqual([]);
    const kinds = s.insights.map((i) => i.kind);
    expect(kinds).toContain('helper');
    expect(kinds).toContain('drop_dish');
    expect(s.insights.every((i) => (i.savesMin ?? 0) >= 10)).toBe(true);
  });

  it('a second cook and second oven make the same start on time', () => {
    const input = thanksgiving({ startAt: at(2026, 11, 26, 13), kitchen: kitchen({ cooks: 2, ovens: 2 }) });
    const s = computeSchedule(input, {}, input.startAt);
    expect(['on_track', 'tight']).toContain(s.state);
    expect(s.achievableServeMin).toBe(input.serveAt);
    expect(violations(input, s, input.startAt)).toEqual([]);
  });

  it('reports impossible rather than looping on a nonsense kitchen', () => {
    const input = thanksgiving({ kitchen: kitchen({ burners: 0 }), startAt: at(2026, 11, 26, 16) });
    const t0 = performance.now();
    const s = computeSchedule(input, {}, input.startAt);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(['late', 'impossible', 'tight']).toContain(s.state);
  });
});

describe('planner: gadgets and kitchens', () => {
  const base = (extras = {}) =>
    ({
      serveAt: at(2026, 11, 26, 18),
      startAt: at(2026, 11, 26, 16, 30),
      guests: 8,
      dishes: [{ dishId: 'roast_chicken' }, { dishId: 'brussels' }, { dishId: 'roasted_veg' }],
      kitchen: kitchen({ extras }),
      marginMin: 10,
      tz: TZ,
    }) satisfies PlanInput;

  it('uses an air fryer when it is available and helps', () => {
    const withFryer = computeSchedule(base({ air_fryer: 1 }), {}, base().startAt);
    expect(violations(base({ air_fryer: 1 }), withFryer, base().startAt)).toEqual([]);
    const used = withFryer.tasks.some((t) => t.use?.appliance === 'air_fryer');
    const without = computeSchedule(base(), {}, base().startAt);
    expect(without.tasks.some((t) => t.use?.appliance === 'air_fryer')).toBe(false);
    // With the gadget the plan is never worse.
    expect(withFryer.bufferMin).toBeGreaterThanOrEqual(without.bufferMin);
    expect(used || withFryer.bufferMin === without.bufferMin).toBe(true);
  });

  it('shares an oven between compatible temperatures and says so', () => {
    const input = thanksgiving({ kitchen: kitchen({ cooks: 2 }) });
    const s = computeSchedule(input, {}, NOW_PLANNING);
    const shared = s.tasks.filter((t) => t.notes.some((n) => n.includes('shared with')));
    for (const t of shared) expect(t.notes.join(' ')).toMatch(/Oven at \d+ degrees/);
  });
});

describe('planner: invariants hold across many scenarios', () => {
  const menus = MENUS.map((m) => m.id);
  const starts = [8, 11, 13, 15];
  for (const menuId of menus) {
    it(`menu ${menuId}: schedules satisfy every hard constraint`, () => {
      const dishes = MENUS.find((m) => m.id === menuId)!.dishes.map((dishId) => ({ dishId }));
      for (const cooks of [1, 2, 3]) {
        for (const ovens of [1, 2]) {
          for (const startH of starts) {
            for (const guests of [4, 12]) {
              const input: PlanInput = {
                serveAt: at(2026, 12, 25, 18),
                startAt: at(2026, 12, 25, startH),
                guests,
                dishes,
                kitchen: kitchen({ cooks, ovens }),
                marginMin: 10,
                tz: TZ,
              };
              for (const now of [input.startAt, input.startAt - 3 * 24 * 60]) {
                const s = computeSchedule(input, {}, now);
                const v = violations(input, s, now);
                expect(v, `${menuId} c${cooks} o${ovens} start${startH} g${guests} now${now === input.startAt ? '=start' : '-3d'}`).toEqual([]);
                if (s.state !== 'impossible') expect(s.achievableServeMin).toBeGreaterThanOrEqual(input.serveAt);
              }
            }
          }
        }
      }
    });
  }
});

describe('replanning: the meal never goes to plan', () => {
  const input = thanksgiving();
  // The plan was made on Tuesday; these tests happen on the day.
  const initial = computeSchedule(input, {}, NOW_PLANNING);
  const roast = initial.tasks.find((t) => t.key === 'turkey.roast')!;
  const base: Progress = { 'turkey.prep': { status: 'done', doneAt: roast.startMin } };
  const cooking: Progress = { ...base, 'turkey.roast': { status: 'running', startedAt: roast.startMin } };

  it('the turkey needs 30 more minutes: everything downstream shifts and the plan stays valid', () => {
    const now = roast.endMin - 20;
    const onPlan = onPlanProgress(initial, now);
    const before = computeSchedule(input, onPlan, now);
    const delayed: Progress = { ...onPlan, 'turkey.roast': { ...onPlan['turkey.roast'], remainingMin: 50 } };
    const withDelay = computeSchedule(input, delayed, now);
    expect(violations(input, withDelay, now)).toEqual([]);
    expect(key(withDelay, 'turkey.roast').endMin).toBe(now + 50);
    expect(key(withDelay, 'turkey.carve').startMin).toBeGreaterThan(key(before, 'turkey.carve').startMin);
    expect(withDelay.bufferMin).toBeLessThanOrEqual(before.bufferMin);
    const diff = diffSchedules(before, withDelay);
    expect(diff.moved.length + (diff.stateChanged ? 1 : 0) + (diff.achievableDelta ? 1 : 0)).toBeGreaterThan(0);
  });

  it('a huge overrun becomes an honest "late" with a new achievable time, not a crash', () => {
    const now = roast.startMin + 60;
    const prog: Progress = { ...cooking, 'turkey.roast': { ...cooking['turkey.roast'], remainingMin: 200 } };
    const s = computeSchedule(input, prog, now, { insights: true });
    expect(s.state).toBe('late');
    expect(s.achievableServeMin).toBeGreaterThan(input.serveAt);
    expect(s.tasks.length).toBeGreaterThan(5);
    expect(violations(input, s, now)).toEqual([]);
  });

  it('finished tasks stay finished and are never rescheduled', () => {
    const prep = initial.tasks.find((t) => t.key === 'mashed.peel')!;
    const prog: Progress = { 'mashed.peel': { status: 'done', startedAt: prep.startMin, doneAt: prep.endMin } };
    const s = computeSchedule(input, prog, prep.endMin);
    const t = key(s, 'mashed.peel');
    expect(t.status).toBe('done');
    expect(t.startMin).toBe(prep.startMin);
    expect(key(s, 'mashed.boil').startMin).toBeGreaterThanOrEqual(prep.endMin);
  });

  it('if a later step has started, earlier steps are treated as done', () => {
    const now = roast.endMin + 35;
    const s = computeSchedule(input, { 'turkey.carve': { status: 'running', startedAt: now } }, now);
    expect(key(s, 'turkey.roast').status).toBe('done');
    expect(key(s, 'turkey.prep').status).toBe('done');
    expect(['late', 'tight', 'on_track']).toContain(s.state); // never a crash, even with unreported gaps
  });

  it('a running task keeps its oven occupied so nothing else is booked into it', () => {
    const now = roast.startMin + 80;
    const onPlan = onPlanProgress(initial, now);
    const prog: Progress = { ...onPlan, 'turkey.roast': { ...onPlan['turkey.roast'], remainingMin: 90 } };
    const s = computeSchedule(input, prog, now);
    expect(violations(input, s, now)).toEqual([]);
    for (const t of s.tasks.filter((x) => x.status === 'pending' && x.use?.appliance === 'oven')) {
      expect(t.startMin >= now + 90, `${t.key} should wait for the roast`).toBe(true);
    }
  });

  it('a cook who forgot to report earlier steps gets a degraded-but-honest plan, not a crash', () => {
    const now = roast.startMin + 80;
    const s = computeSchedule(input, { ...cooking, 'turkey.roast': { ...cooking['turkey.roast'], remainingMin: 90 } }, now);
    expect(s.state).not.toBe('impossible');
    expect(s.tasks.length).toBeGreaterThan(5);
    expect(s.warnings.length + (s.state === 'late' ? 1 : 0)).toBeGreaterThan(0);
  });

  it('skipping a dish removes its work', () => {
    const now = roast.startMin;
    const prog: Progress = Object.fromEntries(
      ['rolls.mix', 'rolls.rise', 'rolls.shape', 'rolls.bake'].map((k) => [k, { status: 'skipped' as const, doneAt: now }]),
    );
    const s = computeSchedule(input, prog, now);
    expect(s.tasks.filter((t) => t.dishId === 'rolls').every((t) => t.status === 'skipped')).toBe(true);
    expect(violations(input, s, now)).toEqual([]);
  });

  it('replanning is fast enough to answer mid-conversation', () => {
    const now = roast.startMin + 30;
    const t0 = performance.now();
    computeSchedule(input, cooking, now);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('reports in plain language', () => {
  const input = thanksgiving();
  const now = input.startAt + 4 * 60;
  const s0 = computeSchedule(input, {}, now);

  it('"the turkey is in" starts the roast', () => {
    const r = applyReport(s0, {}, input, { dish: 'turkey', step: 'roast', status: 'started' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.progress['turkey.roast']?.status).toBe('running');
  });

  it('"the potatoes are done" completes the running step, else the next one', () => {
    const r = applyReport(s0, {}, input, { dish: 'mashed potatoes', status: 'done' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.progress)).toEqual(['mashed.peel']);
  });

  it('"gravy needs ten more minutes" records remaining time', () => {
    const r = applyReport(s0, {}, input, { dish: 'gravy', step: 'stock', status: 'running_long', remainingMin: 10 }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.progress['gravy.stock']?.remainingMin).toBe(10);
  });

  it('skipping a whole dish skips all its steps', () => {
    const r = applyReport(s0, {}, input, { dish: 'rolls', status: 'skipped' }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.progress).length).toBe(4);
  });

  it('rejects dishes that are not in the meal, with helpful candidates', () => {
    const r = applyReport(s0, {}, input, { dish: 'lasagna', status: 'done' }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates?.length).toBeGreaterThan(3);
  });
});

describe('voice output is safe to read aloud', () => {
  it('has no markup, urls or symbols, and stays short', () => {
    const input = thanksgiving();
    const now = input.startAt + 3 * 60 + 25;
    const s = computeSchedule(input, {}, now, { insights: true });
    const lines = [
      sayPlanCreated(s, { tz: TZ, guests: 10, dishCount: 9 }),
      sayAgenda(agenda(s, now), s, TZ, now),
      sayAgenda(agenda(s, now + 60), s, TZ, now + 60),
    ];
    for (const l of lines) {
      expect(l.length).toBeGreaterThan(10);
      expect(l.length).toBeLessThan(420);
      expect(l).not.toMatch(/[*_#`<>[\]{}|\\]|https?:|www\./);
    }
  });
});
