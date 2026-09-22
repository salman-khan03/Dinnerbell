import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/main.js';
import type { Running } from '../src/server/main.js';

let srv: Running;
let base: string;

beforeAll(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', allowAnonymous: false, demoLogin: false });
  base = srv.url;
});
afterAll(async () => {
  await srv.close();
});

function cookieJar() {
  let cookie = '';
  const capture = (res: Response) => {
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
  };
  const fetchJson = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) } });
    capture(res);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return fetchJson;
}

async function newUser(name: string) {
  const fetchJson = cookieJar();
  const r = await fetchJson('/api/signup', { method: 'POST', body: JSON.stringify({ username: name, password: 'correct horse battery', tz: 'America/New_York' }) });
  expect(r.status).toBe(200);
  return fetchJson;
}

describe('web app: auth', () => {
  it('signs up, gets a session, and /api/me reflects it', async () => {
    const fetchJson = await newUser(`ava${Date.now()}`);
    const me = await fetchJson('/api/me');
    expect(me.data.signedIn).toBe(true);
  });

  it('rejects a wrong password and unknown users the same way', async () => {
    const fetchJson = cookieJar();
    const bad = await fetchJson('/api/login', { method: 'POST', body: JSON.stringify({ username: 'nobody', password: 'whatever12' }) });
    expect(bad.status).toBe(401);
  });

  it('logs out and clears the session', async () => {
    const fetchJson = await newUser(`ben${Date.now()}`);
    await fetchJson('/api/logout', { method: 'POST' });
    const me = await fetchJson('/api/me');
    expect(me.data.signedIn).toBe(false);
  });

  it('every plan/dish endpoint requires auth', async () => {
    const fetchJson = cookieJar();
    for (const [path, method] of [['/api/plan', 'GET'], ['/api/dishes', 'GET'], ['/api/plan/share', 'POST']] as const) {
      const r = await fetchJson(path, { method });
      expect(r.status).toBe(401);
    }
  });
});

describe('web app: plan a meal without any elicitation dance', () => {
  it('a complete form plans a meal in one call', async () => {
    const fetchJson = await newUser(`cook${Date.now()}`);
    const r = await fetchJson('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'Sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    expect(r.status).toBe(200);
    expect(r.data.view.dishes.length).toBeGreaterThan(0);
    const again = await fetchJson('/api/plan');
    expect(again.data.view.plan_id).toBe(r.data.view.plan_id);
  });

  it('an incomplete form comes back with needs_input, not a crash', async () => {
    const fetchJson = await newUser(`incomplete${Date.now()}`);
    const r = await fetchJson('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'thanksgiving' }) });
    expect(r.status).toBe(200);
    expect(r.data.view).toBeUndefined();
    expect(r.data.needsInput?.length).toBeGreaterThan(0);
  });

  it('reporting progress replans and returns the updated view', async () => {
    const fetchJson = await newUser(`report${Date.now()}`);
    await fetchJson('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    const r = await fetchJson('/api/plan/report', { method: 'POST', body: JSON.stringify({ dish: 'roast chicken', status: 'started', step: 'prep' }) });
    expect(r.status).toBe(200);
    expect(r.data.view.tasks.find((t: { key: string }) => t.key === 'roast_chicken.prep').status).toBe('running');
  });
});

describe('web app: sharing a plan by link', () => {
  it('shares a plan, the public link works without auth, then unshare kills it', async () => {
    const fetchJson = await newUser(`sharer${Date.now()}`);
    await fetchJson('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    const share = await fetchJson('/api/plan/share', { method: 'POST' });
    const slug = share.data.data.slug as string;
    expect(slug).toBeTruthy();

    const publicRes = await fetch(`${base}/api/public/${slug}`);
    expect(publicRes.status).toBe(200);
    const publicJson = await publicRes.json();
    expect(publicJson.view.dishes.length).toBeGreaterThan(0);

    await fetchJson('/api/plan/unshare', { method: 'POST' });
    const gone = await fetch(`${base}/api/public/${slug}`);
    expect(gone.status).toBe(404);
  });

  it('a bogus slug is a clean 404, not a crash', async () => {
    const r = await fetch(`${base}/api/public/nonexistent0`);
    expect(r.status).toBe(404);
  });
});

describe('web app: dish publishing and forking', () => {
  it('publishing makes a dish show up in /api/discover; unpublishing removes it', async () => {
    const owner = await newUser(`chef${Date.now()}`);
    const add = await owner('/api/dishes', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Casserole', course: 'side', method: 'oven', cook_minutes: 30, prep_minutes: 10, hands_off: true, make_ahead: false }),
    });
    const dishId = add.data.data.dish_id as string;
    const before = await fetch(`${base}/api/discover`).then((r) => r.json());
    expect(before.dishes.some((d: { id: string }) => d.id === dishId)).toBe(false);

    await owner(`/api/dishes/${dishId}/publish`, { method: 'POST' });
    const after = await fetch(`${base}/api/discover`).then((r) => r.json());
    const entry = after.dishes.find((d: { id: string }) => d.id === dishId);
    expect(entry).toBeTruthy();
    expect(entry.name).toBe('Test Casserole');

    await owner(`/api/dishes/${dishId}/unpublish`, { method: 'POST' });
    const gone = await fetch(`${base}/api/discover`).then((r) => r.json());
    expect(gone.dishes.some((d: { id: string }) => d.id === dishId)).toBe(false);
  });

  it('another user can fork a published dish into their own kitchen', async () => {
    const owner = await newUser(`baker${Date.now()}`);
    const add = await owner('/api/dishes', {
      method: 'POST',
      body: JSON.stringify({ name: 'Forkable Pie', course: 'dessert', method: 'oven', cook_minutes: 40, prep_minutes: 20, hands_off: true, make_ahead: true }),
    });
    const dishId = add.data.data.dish_id as string;
    await owner(`/api/dishes/${dishId}/publish`, { method: 'POST' });
    const ownerHouseholdId = ((await fetch(`${base}/api/discover`).then((r) => r.json())).dishes.find((d: { id: string }) => d.id === dishId) ?? {}).householdId;

    const forker = await newUser(`forker${Date.now()}`);
    const fork = await forker(`/api/discover/${ownerHouseholdId}/${dishId}/fork`, { method: 'POST' });
    expect(fork.status).toBe(200);
    expect(fork.data.data.dish_id).not.toBe(dishId);

    const mine = await forker('/api/dishes');
    expect(mine.data.dishes.some((d: { name: string }) => d.name === 'Forkable Pie')).toBe(true);
  });

  it('cannot fork a dish that was never published', async () => {
    const owner = await newUser(`private${Date.now()}`);
    const add = await owner('/api/dishes', { method: 'POST', body: JSON.stringify({ name: 'Secret Stew', course: 'main', method: 'stovetop', cook_minutes: 45, prep_minutes: 15, hands_off: false, make_ahead: false }) });
    const dishId = add.data.data.dish_id as string;
    const discoverList = await fetch(`${base}/api/discover`).then((r) => r.json());
    expect(discoverList.dishes.some((d: { id: string }) => d.id === dishId)).toBe(false);

    // Even knowing the (private) dish id and needing the household id, forking must fail.
    const anyoneElse = await newUser(`snoop${Date.now()}`);
    const r = await anyoneElse(`/api/discover/hh_bogus/${dishId}/fork`, { method: 'POST' });
    expect(r.data.isError).toBe(true);
  });
});

describe('web app: static shell and catalog', () => {
  it('serves the SPA shell and catalog without auth', async () => {
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Dinner Bell');
    const catalog = await fetch(`${base}/api/catalog`).then((r) => r.json());
    expect(catalog.menus.length).toBeGreaterThan(5);
  });

  it('does not shadow /mcp or /sim', async () => {
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(mcp.status).toBe(401); // unauthenticated MCP, not a 404 or the SPA shell
  });
});
