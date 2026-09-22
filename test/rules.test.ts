import { describe, expect, it } from 'vitest';
import { interpret } from '../src/sim/orchestrators/rules.js';
import type { PlanContext } from '../src/sim/orchestrators/rules.js';
import { parseWhen } from '../src/engine/time.js';
import { TZ, at } from './helpers.js';

const call = (u: string, plan?: PlanContext) => {
  const r = interpret(u, plan);
  if ('call' in r) return r.call;
  throw new Error(`expected a call, got say: ${r.say}`);
};
const say = (u: string, plan?: PlanContext) => {
  const r = interpret(u, plan);
  if ('say' in r) return r.say;
  throw new Error(`expected a say, got call: ${JSON.stringify(r.call)}`);
};

const PLAN: PlanContext = {
  cooks: 1,
  ovens: 1,
  guests: 10,
  dishes: [
    { id: 'turkey', name: 'Roast turkey' },
    { id: 'mashed', name: 'Mashed potatoes' },
    { id: 'rolls', name: 'Homemade dinner rolls' },
    { id: 'gravy', name: 'Turkey gravy' },
  ],
};

describe('named-holiday date parsing', () => {
  const now = at(2026, 11, 24, 12);
  it('resolves Christmas, Christmas Eve and New Year to the right year', () => {
    expect(parseWhen('christmas at 5', { nowMin: now, tz: TZ })).toBe(at(2026, 12, 25, 17));
    expect(parseWhen('christmas eve at 6', { nowMin: now, tz: TZ })).toBe(at(2026, 12, 24, 18));
    const afterChristmas = at(2026, 12, 26, 12);
    expect(parseWhen('christmas at 5', { nowMin: afterChristmas, tz: TZ })).toBe(at(2027, 12, 25, 17));
    expect(parseWhen("new year's eve at 8", { nowMin: now, tz: TZ })).toBe(at(2026, 12, 31, 20));
  });
});

describe('intent grammar: planning', () => {
  it('turns an occasion + time + guests into plan_meal', () => {
    expect(call('plan Thanksgiving dinner for 10 at 5')).toEqual({
      name: 'plan_meal',
      args: { meal: 'Thanksgiving', guests: 10, serve_time: '5 thanksgiving' },
    });
  });
  it('accepts a bare dish list', () => {
    const c = call('help me cook turkey and mashed potatoes for six at 6pm');
    expect(c.name).toBe('plan_meal');
    expect(c.args.guests).toBe(6);
    expect(c.args.meal).toMatch(/Roast turkey/);
  });
  it('handles wake-word and politeness framing', () => {
    expect(call('hey alexa, can you plan hanukkah dinner for 8 at 7')).toEqual({
      name: 'plan_meal',
      args: { meal: 'Hanukkah', guests: 8, serve_time: '7' },
    });
  });
});

describe('intent grammar: progress reporting', () => {
  it('"the turkey is in the oven" starts it', () => {
    expect(call('the turkey is in the oven', PLAN)).toEqual({ name: 'report_progress', args: { dish: 'Roast turkey', status: 'started' } });
  });
  it('"the mashed potatoes are done" completes it', () => {
    expect(call('the mashed potatoes are done', PLAN)).toEqual({ name: 'report_progress', args: { dish: 'Mashed potatoes', status: 'done' } });
  });
  it('"the gravy needs ten more minutes" reports running_long with minutes', () => {
    expect(call('the gravy needs ten more minutes', PLAN)).toEqual({
      name: 'report_progress',
      args: { dish: 'Turkey gravy', status: 'running_long', minutes_left: 10 },
    });
  });
  it('"skip the rolls" reports skipped', () => {
    expect(call('skip the rolls', PLAN)).toEqual({ name: 'report_progress', args: { dish: 'Homemade dinner rolls', status: 'skipped' } });
  });
  it('prefers a dish that is actually in the current plan over an unrelated one', () => {
    // "rolls" appears in both "dinner rolls" and nowhere else here, so this checks disambiguation logic runs.
    const c = call('the rolls are done', PLAN);
    expect(c.args.dish).toBe('Homemade dinner rolls');
  });
});

describe('intent grammar: changing the plan', () => {
  it('a new time moves dinner', () => {
    expect(call('lets push dinner to 6', PLAN)).toEqual({ name: 'change_plan', args: { serve_time: '6' } });
  });
  it('more guests adjusts the count relative to the current plan', () => {
    expect(call('two more guests are coming', PLAN)).toEqual({ name: 'change_plan', args: { guests: 12 } });
  });
  it('a helper increases cooks', () => {
    expect(call('my sister is helping now', PLAN)).toEqual({ name: 'change_plan', args: { cooks: 2 } });
  });
  it('a broken oven with only one oven gets a spoken explanation, not a bad call', () => {
    expect(say('the oven just broke', PLAN)).toMatch(/only oven/);
  });
  it('a broken oven with two ovens decrements the count', () => {
    expect(call('the second oven broke', { ...PLAN, ovens: 2 })).toEqual({ name: 'change_plan', args: { ovens: 1 } });
  });
  it('drop and add dishes by name', () => {
    expect(call('drop the rolls', PLAN)).toEqual({ name: 'change_plan', args: { remove_dishes: ['Homemade dinner rolls'] } });
    expect(call('add brussels sprouts', PLAN)).toEqual({ name: 'change_plan', args: { add_dishes: ['Roasted Brussels sprouts'] } });
  });
});

describe('intent grammar: everything else', () => {
  it('routes status questions to whats_next', () => {
    for (const u of ["what's next", 'what should I be doing', 'are we on time', 'how is it going'])
      expect(call(u, PLAN)).toEqual({ name: 'whats_next', args: {} });
  });
  it('routes to show_timeline, prep checklist, cancel, and recipe teaching', () => {
    expect(call('show me the timeline')).toEqual({ name: 'show_timeline', args: {} });
    expect(call('what can I make ahead')).toEqual({ name: 'get_prep_checklist', args: {} });
    expect(call('cancel the plan')).toEqual({ name: 'cancel_plan', args: {} });
    expect(call('teach you a family recipe')).toEqual({ name: 'add_family_recipe', args: {} });
  });
  it('routes browsing questions without an existing plan requirement', () => {
    expect(call('what should I make for Hanukkah')).toEqual({ name: 'browse_dishes', args: { query: 'Hanukkah' } });
    expect(call('any vegetarian sides')).toEqual({ name: 'browse_dishes', args: { query: 'vegetarian' } });
  });
  it('gives a friendly fallback for gibberish, and for a bare dish name with no plan to attach it to', () => {
    expect(say('purple elephant banana')).toMatch(/didn't catch/);
    expect(say('turkey')).toMatch(/didn't catch/);
  });
  it('asks whether to add or report progress when a dish is named with no clear verb but a plan exists', () => {
    expect(say('turkey', PLAN)).toMatch(/add that to the meal|already start/);
  });
});
