/**
 * The offline stand-in for Alexa+'s language model: a small, transparent intent
 * grammar that turns what a cook says into one Dinner Bell tool call.
 *
 * It exists so the simulator works for anyone without an LLM key, and so the
 * demo is deterministic. The MCP server neither knows nor cares: it sees the
 * same tool calls a real orchestrator would make. (The Bedrock orchestrator
 * is the real thing.)
 */
import { DISHES, findDish } from '../../engine/index.js';

export interface PlanContext {
  cooks: number;
  ovens: number;
  guests: number;
  dishes: { id: string; name: string }[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type Interpretation = { call: ToolCall } | { say: string };

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60,
};

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9:'&@ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function stripWake(t: string): string {
  return t
    .replace(/^(hey |ok |okay )?alexa\b[ ,]*/, '')
    .replace(/^(please |can you |could you |i want to |i'd like to |i would like to |let's |lets )/, '')
    .replace(/\b(ask|tell|open|launch|start|use) dinner bell( to| and| for)?\s*/, '')
    .trim();
}

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  return WORD_NUMBERS[s];
};

/** Known dish phrases, longest first so "sweet potato casserole" beats "potato". */
const DISH_PHRASES: { phrase: string; id: string; name: string }[] = DISHES.flatMap((d) =>
  [d.name, ...(d.aliases ?? [])].map((p) => ({ phrase: norm(p), id: d.id, name: d.name })),
).sort((a, b) => b.phrase.length - a.phrase.length);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds dish mentions and also returns the text with those phrases blanked out
 * ("rest"). Verb/status detection runs against `rest`, not the raw text: a
 * dish name can itself contain a status-shaped word ("mashed" potatoes,
 * "roast" chicken, "baked" beans), and without this the plain mention of a
 * dish would be misread as a progress report.
 */
function dishesIn(text: string, plan?: PlanContext): { found: { id: string; name: string; phrase: string }[]; rest: string } {
  const found: { id: string; name: string; phrase: string }[] = [];
  let rest = ` ${text} `;
  for (const d of DISH_PHRASES) {
    if (d.phrase.length < 3) continue;
    const re = new RegExp(`(?<![a-z])${escapeRe(d.phrase)}(?![a-z])`);
    if (re.test(rest) && !found.some((f) => f.id === d.id)) {
      found.push({ id: d.id, name: d.name, phrase: d.phrase });
      rest = rest.replace(re, ' ');
    }
  }
  const inPlan = new Set(plan?.dishes.map((d) => d.id));
  // Prefer dishes that are actually in the current meal.
  const ordered = inPlan.size ? found.sort((a, b) => Number(inPlan.has(b.id)) - Number(inPlan.has(a.id))) : found;
  return { found: ordered, rest };
}

const OCCASIONS: { re: RegExp; meal: string; day?: string }[] = [
  { re: /\bthanksgiving\b/, meal: 'Thanksgiving', day: 'thanksgiving' },
  { re: /\bfriendsgiving\b/, meal: 'Friendsgiving' },
  { re: /\bchristmas\b/, meal: 'Christmas', day: 'christmas' },
  { re: /\beaster\b/, meal: 'Easter' },
  { re: /\b(hanukkah|chanukah)\b/, meal: 'Hanukkah' },
  { re: /\b(eid|diwali|biryani)\b/, meal: 'Eid or Diwali' },
  { re: /\b(lunar new year|chinese new year)\b/, meal: 'Lunar New Year' },
  { re: /\bsunday (dinner|supper|roast)\b/, meal: 'Sunday supper' },
];

const DAY = '(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|thanksgiving|christmas eve|christmas)';
const TIME = '(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|noon)';

/**
 * A time phrase the server's parser understands, e.g. "5 pm thanksgiving".
 * Deliberately excludes "for" as a time preposition: "for 10" almost always
 * means the guest count ("Thanksgiving for 10 at 5"), and letting it double
 * as a time trigger would steal that number away from `guestsIn`.
 */
function timePhrase(t: string, occasionDay?: string): string | undefined {
  const m = new RegExp(`\\b(?:at|by|around|until|till|to|@)\\s+${TIME}(?![\\d:])`).exec(t) ?? new RegExp(`\\b${TIME}\\s*(?:pm|am)\\b`).exec(t);
  if (!m) return undefined;
  const day = new RegExp(`\\b${DAY}\\b`).exec(t)?.[1] ?? occasionDay;
  return [m[1].trim(), day].filter(Boolean).join(' ');
}

const COUNT = '(\\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)';

function guestsIn(t: string): number | undefined {
  const m =
    new RegExp(`\\b(?:for|feeding|hosting|have|with|serves?)\\s+${COUNT}\\b(?!\\s*(?:pm|am|:|minutes|min|hours?))`).exec(t) ??
    new RegExp(`\\b${COUNT}\\s+(?:people|guests|of us|adults|kids)\\b`).exec(t);
  return num(m?.[1]);
}

function minutesIn(t: string): number | undefined {
  if (/\bhalf an? hour\b/.test(t)) return 30;
  const m = /\b(\d+|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|sixty)\s*(?:more\s*)?(hours?|hrs?|minutes?|mins?)\b/.exec(t);
  if (!m) return undefined;
  const n = num(m[1]) ?? 1;
  return /^h/.test(m[2]) ? n * 60 : n;
}

const STEP_WORDS = ['roast', 'carve', 'peel', 'boil', 'mash', 'prep', 'bake', 'simmer', 'stock', 'mix', 'knead', 'rise', 'shape', 'fry', 'grate', 'steam', 'chill', 'cool', 'sear', 'braise', 'layer', 'marinate', 'saute', 'season', 'toss', 'wrap', 'warm'];
const stepHint = (t: string): string | undefined => STEP_WORDS.find((w) => new RegExp(`\\b${w}(s|ed|ing)?\\b`).test(t));

export function interpret(utterance: string, plan?: PlanContext): Interpretation {
  const raw = norm(utterance);
  const t = stripWake(raw);
  if (!t) return { say: `I'm listening. Try "plan Thanksgiving for ten at five", or "what's next?".` };
  const has = (re: RegExp): boolean => re.test(t);
  const { found: dishes, rest } = dishesIn(t, plan);
  // Status/step words are matched against `rest` (dish names blanked out), so a
  // dish whose own name looks like a verb ("mashed" potatoes) never self-triggers.
  const hasRest = (re: RegExp): boolean => re.test(rest);

  if (has(/\b(cancel|end|scrap|abandon|stop)\b.*\b(plan|meal|cooking|dinner)\b|^start over\b/)) return { call: { name: 'cancel_plan', args: {} } };

  if (has(/\b(teach|save|remember|add)\b.*\b(family|my|our|grandma'?s?|mom'?s?|new)\b.*\brecipe\b|\brecipe\b.*\b(teach|save|add)\b/)) {
    return { call: { name: 'add_family_recipe', args: {} } };
  }
  if (has(/\b(show|display|open|pull up|bring up)\b.*\b(plan|timeline|schedule|day|screen)\b/)) return { call: { name: 'show_timeline', args: {} } };
  if (has(/\b(make ahead|prep list|prep ahead|ahead of time|the night before|the day before|tonight|do ahead|checklist)\b/) && !dishes.length) {
    return { call: { name: 'get_prep_checklist', args: {} } };
  }
  if (has(/\b(what'?s next|what is next|what now|what do i do|what should i (?:be )?doing|what should i do|where are we|how are we (?:doing|on time)|next step|am i on time|are we on time|how(?:'s| is) (?:it|dinner) going|status)\b/)) {
    return { call: { name: 'whats_next', args: {} } };
  }

  // ── progress on a dish ──
  const dish = dishes[0];
  if (dish) {
    const step = stepHint(rest);
    const args = { dish: dish.name, ...(step ? { step } : {}) };
    if (hasRest(/\bskip\b/)) return { call: { name: 'report_progress', args: { dish: dish.name, status: 'skipped' } } };
    if (hasRest(/\b(needs?|need|another|running (?:late|behind)|not (?:done|ready|cooked)|takes? longer|more time|still needs|longer)\b/)) {
      return { call: { name: 'report_progress', args: { ...args, status: 'running_long', minutes_left: minutesIn(t) ?? 15 } } };
    }
    if (
      hasRest(/\b(done|finished|ready|out of the oven|took (?:it|them) out|pulled|cooked|carved|mashed|drained|peeled|chopped|mixed|shaped|complete)\b/) &&
      !hasRest(/\b(drop|remove|add)\b/)
    ) {
      return { call: { name: 'report_progress', args: { ...args, status: 'done' } } };
    }
    if (hasRest(/\b(in the oven|in the pan|in the pot|on the stove|started|starting|begin|beginning|putting|put|going in|is in|are in|just went in)\b/)) {
      return { call: { name: 'report_progress', args: { ...args, status: 'started' } } };
    }
  }

  // ── changing the plan ──
  const change = has(/\b(push|move|change|delay|bump|shift|reschedule|pull|let'?s eat|we'?ll eat|eat at|dinner at|serve at)\b/) && timePhrase(t);
  if (plan && change) return { call: { name: 'change_plan', args: { serve_time: timePhrase(t) } } };

  const more = new RegExp(`\\b${COUNT}\\s+(?:more|extra|additional)\\s+(?:guests|people)\\b`).exec(t);
  if (more) {
    if (!plan) return { say: 'Let me plan the meal first, then I can change the guest count.' };
    return { call: { name: 'change_plan', args: { guests: plan.guests + (num(more[1]) ?? 1) } } };
  }
  const total = new RegExp(`\\b(?:now|actually|there(?:'?ll)? be|make it)\\s+${COUNT}\\s+(?:guests|people)\\b`).exec(t);
  if (plan && total) return { call: { name: 'change_plan', args: { guests: num(total[1]) } } };

  if (has(/\b(helping|helps? me|helps? out|joined|here to help|another (?:cook|pair of hands)|got (?:a )?help|someone (?:is )?(?:here|helping))\b/) && !dishes.length) {
    if (!plan) return { say: 'Once a meal is planned, tell me who is helping and I will re-time everything.' };
    return { call: { name: 'change_plan', args: { cooks: Math.min(6, plan.cooks + 1) } } };
  }
  if (has(/\boven\b.*\b(broke|broken|out|not working|died|down|unavailable|is off)\b|\b(lost|no) (?:the )?(?:second |extra )?oven\b/)) {
    if (!plan) return { say: 'I will keep that in mind once a meal is planned.' };
    if (plan.ovens <= 1) return { say: `That's your only oven, so there's nothing I can move around. You could use a neighbor's oven or drop the baked dishes.` };
    return { call: { name: 'change_plan', args: { ovens: plan.ovens - 1 } } };
  }
  const drop = /^(?:drop|remove|take out|cut|leave out|no more)\s+(?:the\s+)?(.+)$/.exec(t);
  if (plan && drop) return { call: { name: 'change_plan', args: { remove_dishes: [dishes[0]?.name ?? drop[1]] } } };
  const add = /^add\s+(?:some\s+|a\s+|an\s+|the\s+)?(.+?)(?:\s+to\s+(?:the\s+)?(?:meal|plan|menu|dinner))?$/.exec(t);
  if (plan && add) {
    const names = dishes.length ? dishes.map((d) => d.name) : add[1].split(/,| and /).map((s) => s.trim()).filter(Boolean);
    return { call: { name: 'change_plan', args: { add_dishes: names } } };
  }

  // ── suggestions ──
  if (has(/\b(what (?:should|can|could) i (?:make|cook|serve)|suggest|ideas?|what goes with|menu for|dishes? for|any (?:vegetarian|vegan)|vegetarian|vegan|gluten)\b/) && !has(/\bplan\b/)) {
    const occ = OCCASIONS.find((o) => o.re.test(t));
    const q = occ?.meal ?? (has(/vegetarian|vegan/) ? 'vegetarian' : has(/gluten/) ? 'gluten-free' : t.replace(/^.*\b(?:for|with)\s+/, ''));
    return { call: { name: 'browse_dishes', args: { query: q } } };
  }

  // ── planning ──
  const occasion = OCCASIONS.find((o) => o.re.test(t));
  if (has(/\b(plan|cook|cooking|host|hosting|make|making|prepare|organi[sz]e|time|schedule|orchestrate|conduct|help me)\b/) && (occasion || dishes.length || has(/\b(dinner|meal|supper|lunch|feast)\b/))) {
    const meal = occasion?.meal ?? (dishes.length ? dishes.map((d) => d.name).join(', ') : undefined);
    const args: Record<string, unknown> = {};
    if (meal) args.meal = meal;
    const g = guestsIn(t);
    if (g) args.guests = g;
    const when = timePhrase(t, occasion?.day);
    if (when) args.serve_time = when;
    return { call: { name: 'plan_meal', args } };
  }

  if (plan && findDish(t)) return { say: `Do you want me to add that to the meal, or did you already start it?` };
  return { say: `Sorry, I didn't catch that. You can say "plan Thanksgiving for ten at five", "what's next", or "the turkey is in the oven".` };
}
