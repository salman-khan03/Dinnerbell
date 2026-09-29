import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DinnerBell } from '../src/server/service.js';
import { createDinnerBellMcp, UI_URI } from '../src/server/mcp.js';
import { Store } from '../src/server/store.js';
import { at } from './helpers.js';

interface Harness {
  client: Client;
  asked: { message: string; fields: string[]; types: string[] }[];
  close: () => Promise<void>;
}

/** A real MCP client talking to the real server over a linked in-memory transport (2025 wire era). */
async function connect(opts: { elicitation?: boolean; answers?: Record<string, unknown>; action?: 'accept' | 'decline' } = {}): Promise<Harness & { store: Store }> {
  const store = await Store.open();
  const clock = at(2026, 11, 24, 12) * 60_000;
  const bell = new DinnerBell({ store, now: () => clock });
  const server = createDinnerBellMcp({ bell, store, uiHtml: () => '<!doctype html><title>t</title>', allowAnonymous: true });
  const asked: Harness['asked'] = [];
  const client = new Client(
    { name: 'test-alexa-plus', version: '0.0.1' },
    { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } },
  );
  if (opts.elicitation !== false) {
    client.setRequestHandler('elicitation/create', async (req) => {
      const params = req.params as { message: string; requestedSchema?: { properties: Record<string, { type?: string }> } };
      asked.push({
        message: params.message,
        fields: Object.keys(params.requestedSchema?.properties ?? {}),
        types: Object.values(params.requestedSchema?.properties ?? {}).map((p) => String(p.type)),
      });
      if (opts.action === 'decline') return { action: 'decline' };
      const content: Record<string, string | number | boolean> = {};
      for (const k of Object.keys(params.requestedSchema?.properties ?? {})) if (opts.answers && k in opts.answers) content[k] = opts.answers[k] as string | number | boolean;
      return { action: 'accept', content };
    });
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    asked,
    store,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let h: (Harness & { store: Store }) | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const structured = (r: { structuredContent?: unknown }) => r.structuredContent as { spoken: string; plan?: { state: string; dishes: unknown[]; tasks: unknown[] }; needs_input?: string[]; data?: Record<string, unknown> };

describe('MCP protocol surface', () => {
  it('advertises tools with usage-guiding descriptions, output schemas and UI metadata', async () => {
    h = await connect();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['add_family_recipe', 'browse_dishes', 'cancel_plan', 'change_plan', 'get_prep_checklist', 'plan_meal', 'report_progress', 'show_timeline', 'whats_next']);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect((t.description ?? '').length, t.name).toBeGreaterThan(80);
      expect((t.description ?? '').length, t.name).toBeLessThan(700);
      expect(t.outputSchema, t.name).toBeTruthy();
    }
    const plan = tools.find((t) => t.name === 'plan_meal')!;
    expect((plan._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(UI_URI);
    expect(tools.find((t) => t.name === 'cancel_plan')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'show_timeline')!.annotations?.readOnlyHint).toBe(true);
  });

  it('serves the timeline as an MCP App resource and exposes menus and a prompt', async () => {
    h = await connect();
    const ui = await h.client.readResource({ uri: UI_URI });
    expect(ui.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    const menus = await h.client.readResource({ uri: 'dinnerbell://menus' });
    expect(JSON.parse((menus.contents[0] as { text: string }).text).menus.length).toBeGreaterThan(5);
    const prompt = await h.client.getPrompt({ name: 'plan_holiday_meal', arguments: { occasion: 'Thanksgiving', guests: '10' } });
    expect(JSON.stringify(prompt.messages)).toMatch(/Thanksgiving/);
  });

  it('gives the model server instructions', async () => {
    h = await connect();
    expect(h.client.getInstructions()).toMatch(/plan_meal/);
  });
});

describe('elicitation over the real protocol', () => {
  it('plan_meal with nothing supplied asks a flat form, then plans', async () => {
    h = await connect({ answers: { meal: 'Thanksgiving', serve_time: '5 PM Thursday', guests: 10, cooks: 1, ovens: 1 } });
    const r = await h.client.callTool({ name: 'plan_meal', arguments: {} });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].fields).toEqual(['meal', 'serve_time', 'guests', 'cooks', 'ovens']);
    const s = structured(r);
    expect(s.plan!.state).toBe('on_track');
    expect(s.plan!.dishes).toHaveLength(9);
    expect(s.spoken).toMatch(/9-dish meal for 10/);
    expect((r.content as { type: string; text: string }[])[0].text).toBe(s.spoken);
  });

  it('every elicitation schema is flat primitives, as Alexa+ requires', async () => {
    h = await connect({ answers: {} });
    // Trigger every tool that can ask.
    await h.client.callTool({ name: 'plan_meal', arguments: {} });
    await h.client.callTool({ name: 'add_family_recipe', arguments: {} });
    await h.client.callTool({ name: 'cancel_plan', arguments: {} });
    expect(h.asked.length).toBeGreaterThanOrEqual(2);
    for (const q of h.asked) for (const t of q.types) expect(['string', 'number', 'integer', 'boolean']).toContain(t);
  });

  it('a declined question ends politely without creating a plan', async () => {
    h = await connect({ action: 'decline' });
    const r = await h.client.callTool({ name: 'plan_meal', arguments: {} });
    expect(structured(r).spoken).toMatch(/No problem/);
    expect(h.store.activePlan('hh_demo')).toBeUndefined();
  });

  it('a client without elicitation gets needs_input so the model can ask instead', async () => {
    h = await connect({ elicitation: false });
    const r = await h.client.callTool({ name: 'plan_meal', arguments: { meal: 'thanksgiving' } });
    const s = structured(r);
    expect(s.plan).toBeUndefined();
    expect(s.needs_input!.join(' ')).toMatch(/dinner be ready/);
    // The model asks, then calls again with everything. It is never blocked on kitchen details.
    const again = await h.client.callTool({ name: 'plan_meal', arguments: { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10 } });
    expect(structured(again).plan!.state).toBe('on_track');
    expect(structured(again).spoken).toMatch(/assumed one cook and one oven/);
  });

  it('kitchen details supplied as arguments are remembered and not assumed again', async () => {
    h = await connect({ elicitation: false });
    await h.client.callTool({ name: 'plan_meal', arguments: { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 2, ovens: 2 } });
    const again = await h.client.callTool({ name: 'plan_meal', arguments: { meal: 'sunday dinner', serve_time: '6pm friday', guests: 4 } });
    expect(structured(again).spoken).not.toMatch(/assumed/);
    expect(h.store.household('hh_demo')!.kitchen).toMatchObject({ cooks: 2, ovens: 2 });
  });

  it('cancel_plan confirms through elicitation before ending anything', async () => {
    h = await connect({ answers: { meal: 'Sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1, confirm: true } });
    await h.client.callTool({ name: 'plan_meal', arguments: {} });
    const r = await h.client.callTool({ name: 'cancel_plan', arguments: {} });
    expect(h.asked.at(-1)!.fields).toEqual(['confirm']);
    expect(structured(r).spoken).toMatch(/ended/);
  });

  it('teaches a family recipe through a multi-field form', async () => {
    h = await connect({ answers: { name: 'Nana pie', course: 'dessert', method: 'oven', cook_minutes: 50, prep_minutes: 25, hands_off: true, make_ahead: true } });
    const r = await h.client.callTool({ name: 'add_family_recipe', arguments: {} });
    expect(structured(r).spoken).toMatch(/Saved Nana pie/);
    expect(h.asked[0].fields).toContain('cook_minutes');
  });
});

describe('the cooking loop through the protocol', () => {
  it('plan, ask what is next, report progress, change the plan', async () => {
    h = await connect({ answers: { cooks: 1, ovens: 1 } });
    const planned = await h.client.callTool({ name: 'plan_meal', arguments: { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10 } });
    expect(structured(planned).plan!.tasks.length).toBeGreaterThan(20);

    const next = await h.client.callTool({ name: 'whats_next', arguments: {} });
    expect(structured(next).spoken.length).toBeGreaterThan(10);

    // Two days out, the cook already made the cranberry sauce: it drops off the prep list.
    const report = await h.client.callTool({ name: 'report_progress', arguments: { dish: 'cranberry', status: 'done', step: 'chill' } });
    expect(structured(report).spoken).toMatch(/Got it/);

    const bad = await h.client.callTool({ name: 'report_progress', arguments: { dish: 'lasagna', status: 'done' } });
    expect(bad.isError).toBe(true);
    expect(structured(bad).spoken).toMatch(/not in this meal/);

    const changed = await h.client.callTool({ name: 'change_plan', arguments: { remove_dishes: ['rolls'] } });
    expect(structured(changed).plan!.dishes).toHaveLength(8);

    const prep = await h.client.callTool({ name: 'get_prep_checklist', arguments: {} });
    expect(structured(prep).spoken).toMatch(/evening before/);
    expect(structured(prep).spoken).toMatch(/pumpkin pie/i);
    expect(structured(prep).spoken).not.toMatch(/cranberry/i);

    const shown = await h.client.callTool({ name: 'show_timeline', arguments: {} });
    expect(structured(shown).plan).toBeTruthy();
  });

  it('every tool result is speakable: short, no markup', async () => {
    h = await connect({ answers: { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 } });
    const outs = [
      await h.client.callTool({ name: 'plan_meal', arguments: {} }),
      await h.client.callTool({ name: 'whats_next', arguments: {} }),
      await h.client.callTool({ name: 'get_prep_checklist', arguments: {} }),
      await h.client.callTool({ name: 'browse_dishes', arguments: { query: 'hanukkah' } }),
      await h.client.callTool({ name: 'show_timeline', arguments: {} }),
    ];
    for (const o of outs) {
      const t = (o.content as { text: string }[])[0].text;
      expect(t.length).toBeLessThan(450);
      expect(t).not.toMatch(/[*_#`<>[\]{}|\\]|https?:/);
    }
  });
});
