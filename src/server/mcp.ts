/**
 * The MCP surface of Dinner Bell: tools, a UI resource, a resource and a prompt.
 *
 * Design rules that come from how Alexa+ uses an MCP server:
 *  - The model (Alexa+) picks tools from their descriptions, so each one says
 *    *when to use it* and gives spoken examples.
 *  - Results are read aloud, so `content[0].text` is a short spoken answer and
 *    the full structure goes in `structuredContent` (and drives the screen).
 *  - Missing details are collected with MCP elicitation (flat primitives only,
 *    one question at a time on the device). Clients without elicitation get a
 *    `needs_input` result so the model asks instead.
 *  - Every tool is fast: the planner answers in milliseconds.
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod/v4';
import { MENUS, DISHES } from '../engine/index.js';
import { DinnerBell, cannotAsk } from './service.js';
import type { Ask, FieldSpec, Outcome } from './service.js';
import { PlanViewSchema } from './views.js';
import type { Store } from './store.js';

export const SERVER_NAME = 'dinner-bell';
export const SERVER_VERSION = '1.0.0';
export const UI_URI = 'ui://dinner-bell/timeline.html';

/** How long to wait for a person to answer a spoken question. Alexa+ holds the stream open. */
const ELICIT_TIMEOUT_MS = 10 * 60_000;

const INSTRUCTIONS = `Dinner Bell conducts a multi-dish meal so everything lands hot at the same time, and re-plans live when something runs late.

How to use it:
- To start, call plan_meal. If you do not yet know the dishes (or occasion), serve time or guest count, call it anyway: it will ask the person itself.
- While cooking, call whats_next for "what now?", and report_progress every time the person says a step started, finished, is running late, or should be skipped. Do not guess progress: report only what the person said.
- Use change_plan for anything that changes the meal (new serve time, more guests, an extra cook, a broken oven, adding or dropping a dish).
- Results include a short spoken answer in the text. Read it out as written; do not add markdown, lists, symbols or links, and do not repeat the whole timeline aloud. Longer detail is shown on screen when a display is available.`;

export interface McpDeps {
  bell: DinnerBell;
  store: Store;
  /** The timeline UI as one HTML document. */
  uiHtml: () => string;
  /** Serve a shared demo household when a request carries no identity (local development only). */
  allowAnonymous: boolean;
}

// ───────────────────────────── shared schemas ─────────────────────────────

const OutputSchema = z.object({
  spoken: z.string().describe('The answer to say aloud.'),
  plan: PlanViewSchema.optional().describe('The current plan, when there is one.'),
  needs_input: z.array(z.string()).optional().describe('Questions to ask the person before calling again.'),
  data: z.record(z.string(), z.unknown()).optional(),
});

const STATUS = z.enum(['started', 'done', 'running_long', 'skipped']);

function toResult(out: Outcome) {
  const structured: z.infer<typeof OutputSchema> = { spoken: out.text };
  if (out.view) structured.plan = out.view;
  if (out.needsInput) structured.needs_input = out.needsInput;
  if (out.data) structured.data = out.data;
  return {
    content: [{ type: 'text' as const, text: out.text }],
    structuredContent: structured,
    ...(out.isError ? { isError: true } : {}),
  };
}

function householdOf(ctx: ServerContext, allowAnonymous: boolean): string {
  const id = ctx.http?.authInfo?.extra?.householdId;
  if (typeof id === 'string' && id) return id;
  if (allowAnonymous) return 'hh_demo';
  throw new Error('Sign in to Dinner Bell to continue.');
}

const fieldToSchema = (f: FieldSpec): Record<string, unknown> => ({
  type: f.type,
  title: f.title,
  ...(f.description ? { description: f.description } : {}),
  ...(f.enum ? { enum: f.enum } : {}),
  ...(f.minimum !== undefined ? { minimum: f.minimum } : {}),
  ...(f.maximum !== undefined ? { maximum: f.maximum } : {}),
  ...(f.default !== undefined ? { default: f.default } : {}),
});

/** Real elicitation when the client can do it; otherwise the model asks. */
function makeAsk(mcp: McpServer, ctx: ServerContext): Ask {
  return async (q) => {
    const caps = mcp.server.getClientCapabilities();
    if (!caps?.elicitation) return cannotAsk(q);
    try {
      const r = await ctx.mcpReq.elicitInput(
        {
          mode: 'form',
          message: q.message,
          requestedSchema: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(q.fields).map(([k, f]) => [k, fieldToSchema(f)])),
            required: q.required,
          },
        } as Parameters<ServerContext['mcpReq']['elicitInput']>[0],
        { timeout: ELICIT_TIMEOUT_MS },
      );
      if (r.action === 'accept') return { action: 'accept', content: (r.content ?? {}) as Record<string, string | number | boolean> };
      return { action: r.action === 'cancel' ? 'cancel' : 'decline' };
    } catch {
      // The 2026-07-28 era does not push requests; treat like "no elicitation".
      return cannotAsk(q);
    }
  };
}

// ───────────────────────────── the server ─────────────────────────────

export function createDinnerBellMcp(deps: McpDeps): McpServer {
  const { bell, store, allowAnonymous } = deps;
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Dinner Bell', description: 'A kitchen conductor for multi-dish meals.' },
    { instructions: INSTRUCTIONS },
  );
  const ui = { ui: { resourceUri: UI_URI } };

  registerAppResource(
    mcp,
    'Cooking timeline',
    UI_URI,
    { description: 'A visual timeline of the meal: who is doing what, on which burner or oven, and when.' },
    async () => ({
      contents: [
        {
          uri: UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: deps.uiHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );

  registerAppTool(
    mcp,
    'plan_meal',
    {
      title: 'Plan a meal',
      description:
        'Build a cooking plan so every dish in a meal is ready at the same time. Use whenever someone wants to plan, cook, host or time a dinner, holiday meal or any multi-dish meal (Thanksgiving, Christmas, Hanukkah, Eid, Sunday dinner). It works out when each step starts around the oven, burners and number of cooks, and moves prep to the evening before when that helps. If the occasion or dishes, the serve time or the guest count are missing, call this tool anyway: it asks the person itself. Not for looking up a single recipe.',
      inputSchema: z.object({
        meal: z.string().optional().describe('An occasion ("Thanksgiving", "Hanukkah") or a list of dishes ("turkey, mashed potatoes and pie").'),
        serve_time: z.string().optional().describe('When dinner should be ready, e.g. "5 PM" or "Thursday at 5".'),
        guests: z.number().int().min(1).max(60).optional().describe('How many people are eating.'),
        start_time: z.string().optional().describe('When cooking can begin, if the person said. Defaults to now, or the morning of the day.'),
        cooks: z.number().int().min(1).max(6).optional().describe('How many people are cooking. Only if the person said.'),
        ovens: z.number().int().min(1).max(3).optional().describe('How many ovens they can use. Only if the person said.'),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: ui,
    },
    async (args, ctx) => toResult(await bell.planMeal(householdOf(ctx, allowAnonymous), args, makeAsk(mcp, ctx))),
  );

  registerAppTool(
    mcp,
    'whats_next',
    {
      title: "What's next",
      description:
        `Tell the person what to do right now and what is coming in the next half hour in their current meal plan. Use for "what's next?", "what should I be doing?", "where are we?" and "are we on time?". It also warns first if the plan has slipped since the last update.`,
      inputSchema: z.object({
        minutes_ahead: z.number().int().min(5).max(120).optional().describe('How far ahead to look. Defaults to 30.'),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: ui,
    },
    async (args, ctx) => toResult(await bell.whatsNext(householdOf(ctx, allowAnonymous), args)),
  );

  registerAppTool(
    mcp,
    'report_progress',
    {
      title: 'Report progress',
      description:
        `Record cooking progress and re-plan around it instantly. Use whenever the person says a dish or step has started, finished, is running late or needs more time, or should be skipped: "the turkey is in the oven", "the potatoes are done", "the gravy needs ten more minutes", "skip the rolls". Returns what moved and whether dinner is still on time. Only report what the person actually said.`,
      inputSchema: z.object({
        dish: z.string().describe('The dish, e.g. "turkey" or "mashed potatoes".'),
        status: STATUS.describe('started, done, running_long (needs more time), or skipped.'),
        step: z.string().optional().describe('Which step, if the person said: "roast", "carve", "the mash".'),
        minutes_left: z.number().int().min(1).max(600).optional().describe('For running_long: minutes still needed.'),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: ui,
    },
    async (args, ctx) => toResult(await bell.reportProgress(householdOf(ctx, allowAnonymous), args)),
  );

  registerAppTool(
    mcp,
    'change_plan',
    {
      title: 'Change the plan',
      description:
        `Change the current meal plan: move dinner earlier or later, change the guest count, add or drop dishes, or change how many people are cooking or ovens are usable. Examples: "push dinner to 6", "my sister is helping", "the second oven is out", "add a salad", "drop the rolls", "two more guests".`,
      inputSchema: z.object({
        serve_time: z.string().optional().describe('New serve time.'),
        guests: z.number().int().min(1).max(60).optional(),
        add_dishes: z.array(z.string()).optional().describe('Dish names to add.'),
        remove_dishes: z.array(z.string()).optional().describe('Dish names to drop.'),
        cooks: z.number().int().min(1).max(6).optional().describe('How many people are cooking now.'),
        ovens: z.number().int().min(0).max(3).optional().describe('How many ovens can be used now.'),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: ui,
    },
    async (args, ctx) => toResult(await bell.changePlan(householdOf(ctx, allowAnonymous), args)),
  );

  registerAppTool(
    mcp,
    'show_timeline',
    {
      title: 'Show the timeline',
      description: `Show the whole cooking timeline on the screen and give a short spoken overview. Use for "show me the plan", "show the timeline", "what does my day look like".`,
      inputSchema: z.object({}),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: ui,
    },
    async (_args, ctx) => toResult(await bell.showTimeline(householdOf(ctx, allowAnonymous))),
  );

  registerAppTool(
    mcp,
    'get_prep_checklist',
    {
      title: 'Prep-ahead checklist',
      description: `List what to do ahead of time: dishes to make the evening before and things to thaw days earlier. Use for "what can I make ahead?", "what do I need to do tonight?" and "prep list".`,
      inputSchema: z.object({}),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: ui,
    },
    async (_args, ctx) => toResult(await bell.prepChecklist(householdOf(ctx, allowAnonymous))),
  );

  mcp.registerTool(
    'browse_dishes',
    {
      title: 'Find dishes and menus',
      description: `Suggest menus and dishes by occasion, cuisine, course or dietary need. Use for "what should I make for Hanukkah?", "vegetarian sides", "what goes with turkey?". Not needed when the person already named their dishes.`,
      inputSchema: z.object({ query: z.string().optional().describe('An occasion, cuisine, course or diet. Empty lists everything.') }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) => toResult(await bell.browseDishes(householdOf(ctx, allowAnonymous), args)),
  );

  mcp.registerTool(
    'add_family_recipe',
    {
      title: 'Teach a family recipe',
      description: `Teach Dinner Bell one of the household's own recipes so it can be timed in future meals ("add Grandma's mac and cheese"). It asks how long the dish cooks and whether it needs watching. Call it with just the name if that is all you know.`,
      inputSchema: z.object({
        name: z.string().optional(),
        course: z.enum(['main', 'side', 'bread', 'dessert', 'starter']).optional(),
        method: z.enum(['oven', 'stovetop', 'no cooking']).optional(),
        oven_temp_f: z.number().int().min(200).max(500).optional(),
        cook_minutes: z.number().int().min(0).max(600).optional(),
        prep_minutes: z.number().int().min(0).max(300).optional(),
        hands_off: z.boolean().optional().describe('True if it can cook without being watched.'),
        make_ahead: z.boolean().optional().describe('True if it can be made the day before.'),
        serves: z.number().int().min(1).max(60).optional(),
      }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx) => toResult(await bell.addFamilyRecipe(householdOf(ctx, allowAnonymous), args, makeAsk(mcp, ctx))),
  );

  mcp.registerTool(
    'cancel_plan',
    {
      title: 'End the meal plan',
      description: `End the current meal plan. It always checks with the person first. Use for "cancel the plan", "we're done", "start over".`,
      inputSchema: z.object({ confirm: z.boolean().optional().describe('Only true if the person has already said yes.') }),
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) => toResult(await bell.cancelPlan(householdOf(ctx, allowAnonymous), args, makeAsk(mcp, ctx))),
  );

  // ── resources ──
  mcp.registerResource(
    'menus',
    'dinnerbell://menus',
    { title: 'Menus', description: 'The built-in occasion menus and the dishes in them.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ menus: MENUS, dishes: DISHES.map((d) => ({ id: d.id, name: d.name, course: d.course, cuisine: d.cuisine, tags: d.tags })) }) }],
    }),
  );

  // ── prompt ──
  mcp.registerPrompt(
    'plan_holiday_meal',
    {
      title: 'Plan a holiday meal',
      description: 'Help someone plan and cook a holiday meal so everything is ready together.',
      argsSchema: z.object({ occasion: z.string().optional(), guests: z.string().optional(), serve_time: z.string().optional() }),
    },
    ({ occasion, guests, serve_time }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `I'm cooking ${occasion ?? 'a holiday meal'}${guests ? ` for ${guests} people` : ''}${serve_time ? `, dinner at ${serve_time}` : ''}. Use Dinner Bell to build a plan so everything is ready at the same time, then walk me through it as I cook.`,
          },
        },
      ],
    }),
  );

  void store;
  return mcp;
}
