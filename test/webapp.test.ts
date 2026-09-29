import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/main.js';
import type { Running } from '../src/server/main.js';

let srv: Running;
let base: string;

beforeAll(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', allowAnonymous: false, demoLogin: false, limits: { webAuth: 1000 } });
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

describe('web app: guest mode', () => {
  const plan = { meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 };

  it('"try it now" gives a working kitchen with no signup', async () => {
    const guest = cookieJar();
    const r = await guest('/api/guest', { method: 'POST', body: JSON.stringify({ tz: 'America/Chicago' }) });
    expect(r.status).toBe(200);
    const me = await guest('/api/me');
    expect(me.data).toMatchObject({ signedIn: true, guest: true });
    expect(Date.parse(me.data.guestExpiresAt)).toBeGreaterThan(Date.now());
    const planned = await guest('/api/plan', { method: 'POST', body: JSON.stringify(plan) });
    expect(planned.data.view.dishes.length).toBeGreaterThan(0);
  });

  it('a guest cannot publish to the gallery, and nobody can log in as a guest', async () => {
    const guest = cookieJar();
    const g = await guest('/api/guest', { method: 'POST', body: '{}' });
    const add = await guest('/api/dishes', { method: 'POST', body: JSON.stringify({ name: 'Guest Dip', course: 'starter', method: 'no cooking', cook_minutes: 0, prep_minutes: 10, hands_off: false, make_ahead: true }) });
    const pub = await guest(`/api/dishes/${add.data.data.dish_id}/publish`, { method: 'POST' });
    expect(pub.status).toBe(403);
    const login = await cookieJar()('/api/login', { method: 'POST', body: JSON.stringify({ username: g.data.username, password: '' }) });
    expect(login.status).toBe(401);
  });

  it('claiming keeps the plan and turns the guest into a real, loggable-in account', async () => {
    const guest = cookieJar();
    await guest('/api/guest', { method: 'POST', body: '{}' });
    const planned = await guest('/api/plan', { method: 'POST', body: JSON.stringify(plan) });
    const name = `kept${Date.now()}`;

    const bad = await guest('/api/claim', { method: 'POST', body: JSON.stringify({ username: 'guest-mine', password: 'long enough pw' }) });
    expect(bad.status).toBe(400);
    const ok = await guest('/api/claim', { method: 'POST', body: JSON.stringify({ username: name, password: 'long enough pw' }) });
    expect(ok.status).toBe(200);
    expect((await guest('/api/me')).data).toMatchObject({ guest: false, username: name });
    expect((await guest('/api/plan')).data.view.plan_id).toBe(planned.data.view.plan_id);
    expect((await guest('/api/claim', { method: 'POST', body: JSON.stringify({ username: `${name}x`, password: 'long enough pw' }) })).status).toBe(400);

    const again = cookieJar();
    expect((await again('/api/login', { method: 'POST', body: JSON.stringify({ username: name, password: 'long enough pw' }) })).status).toBe(200);
    expect((await again('/api/plan')).data.view.plan_id).toBe(planned.data.view.plan_id);
  });

  it('expired guests are swept with everything under them; claimed ones are not', async () => {
    const guest = cookieJar();
    await guest('/api/guest', { method: 'POST', body: '{}' });
    await guest('/api/plan', { method: 'POST', body: JSON.stringify(plan) });
    const swept = srv.store.sweepGuests(0, Date.now() + 1);
    expect(swept).toBeGreaterThan(0);
    expect((await guest('/api/me')).data.signedIn).toBe(false);
    expect(srv.store.allHouseholds().some((h) => h.guest)).toBe(false);
  });
});

describe('web app: dragging the serve time', () => {
  it('serve_at moves dinner to an exact instant and rejects the past', async () => {
    const cook = await newUser(`drag${Date.now()}`);
    const first = await cook('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    const later = new Date(Date.parse(first.data.view.serve_target) + 45 * 60_000).toISOString();
    const moved = await cook('/api/plan/change', { method: 'POST', body: JSON.stringify({ serve_at: later }) });
    expect(moved.data.view.serve_target).toBe(later);
    const past = await cook('/api/plan/change', { method: 'POST', body: JSON.stringify({ serve_at: new Date(Date.now() - 3_600_000).toISOString() }) });
    expect(past.data.view).toBeUndefined();
    expect((await cook('/api/plan')).data.view.serve_target).toBe(later);
  });
});

describe('web app: live sync over SSE', () => {
  /** Opens an SSE stream and resolves with the first `event: plan` it sees. */
  async function firstPlanEvent(path: string, cookie?: string): Promise<{ next: Promise<string>; close: () => void }> {
    const ctrl = new AbortController();
    const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const next = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += new TextDecoder().decode(value);
        const hit = buf.split('\n\n').find((chunk) => chunk.startsWith('event: plan'));
        if (hit) return hit;
      }
    })();
    return { next, close: () => ctrl.abort() };
  }

  it('a change made elsewhere reaches both the owner stream and the public link stream', async () => {
    const jar = { cookie: '' };
    const signup = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `live${Date.now()}`, password: 'correct horse battery' }) });
    jar.cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.cookie }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    await call('/api/plan', { meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 });
    const slug = (await call('/api/plan/share')).data.slug as string;

    const owner = await firstPlanEvent('/api/plan/events', jar.cookie);
    const viewer = await firstPlanEvent(`/api/public/${slug}/events`);
    await call('/api/plan/change', { guests: 6 });
    try {
      expect(await owner.next).toMatch(/updatedAt/);
      expect(await viewer.next).toMatch(/updatedAt/);
    } finally {
      owner.close();
      viewer.close();
    }
  });

  it('reading the plan does not itself fire an event (no refetch loop)', async () => {
    const cook = await newUser(`quiet${Date.now()}`);
    await cook('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    let fired = 0;
    const off = srv.store.onPlanChange(() => fired++);
    await cook('/api/plan');
    await cook('/api/plan');
    off();
    expect(fired).toBe(0);
  });

  it('the owner stream requires auth', async () => {
    expect((await fetch(`${base}/api/plan/events`)).status).toBe(401);
  });
});

describe('web app: link previews', () => {
  it('a shared plan page carries server-rendered Open Graph tags', async () => {
    const cook = await newUser(`og${Date.now()}`);
    await cook('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 }) });
    const slug = (await cook('/api/plan/share', { method: 'POST' })).data.data.slug as string;
    const html = await fetch(`${base}/p/${slug}`).then((r) => r.text());
    expect(html).toMatch(/<meta property="og:title" content="Dinner at 5(:00)? PM: \d+ dishes for 10 \| Dinner Bell">/);
    expect(html).toMatch(/<meta property="og:description" content="[^"]+ and \d+ more\. Ready [^"]+, shared from og\d+&#39;s kitchen\.">/);
    expect(html).toContain(`<meta property="og:url" content="${base}/p/${slug}">`);
    expect(html).toContain('noindex');
    expect(html).not.toContain('<!--head-->');
  });

  it('an unshared link is a 404 page with no plan details, and the home page gets default tags', async () => {
    const gone = await fetch(`${base}/p/zzzzzzzz`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain('no longer shared');
    expect(await fetch(`${base}/`).then((r) => r.text())).toContain('<meta property="og:title" content="Dinner Bell: every dish on the table at once">');
  });

  it('household names are escaped in the tags', async () => {
    const uname = `xss${Date.now()}`;
    const cook = await newUser(uname);
    srv.store.allHouseholds().find((h) => h.name === `${uname}'s kitchen`)!.name = '"><script>alert(1)</script>';
    await cook('/api/plan', { method: 'POST', body: JSON.stringify({ meal: 'sunday dinner', serve_time: '6pm friday', guests: 4, cooks: 1, ovens: 1 }) });
    const slug = (await cook('/api/plan/share', { method: 'POST' })).data.data.slug as string;
    const html = await fetch(`${base}/p/${slug}`).then((r) => r.text());
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('web app: rate limiting the credential endpoints', () => {
  it('answers 429 past the limit, per client', async () => {
    const tight = await startServer({ port: 0, host: '127.0.0.1', simulator: false, limits: { webAuth: 3 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${tight.url}/api/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      const login = await fetch(`${tight.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'someone', password: 'x' }) });
      expect(login.status).toBe(401); // a separate bucket from guest creation
    } finally {
      await tight.close();
    }
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
