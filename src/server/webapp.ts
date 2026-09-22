/**
 * The first-party web product's REST API: plain cookie-session auth (not the
 * OAuth/PKCE flow in auth.ts, which exists for third-party MCP clients like
 * Alexa+ linking in) driving the same `DinnerBell` service the MCP tools use.
 *
 * Every plan/dish-editing call passes `cannotAsk` — the web app is a form,
 * not a conversation, so it always sends complete fields; a service method
 * that still comes back with `needsInput` just means the form was incomplete
 * and the frontend re-shows it with those fields required.
 */
import { DISHES, MENUS } from '../engine/index.js';
import { cannotAsk } from './service.js';
import type { DinnerBell } from './service.js';
import { readBody } from './auth.js';
import type { ExtraRoute } from './http.js';
import type { Store } from './store.js';

const COOKIE = 'db_session';

export interface WebAppOptions {
  store: Store;
  bell: DinnerBell;
  /** Serve the built SPA (index.html/app.js/app.css) for these paths. */
  serveShell: (path: string) => string | undefined;
  /** Require Secure on the session cookie (set once behind real HTTPS). */
  secureCookies: boolean;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createWebAppRoutes(opts: WebAppOptions): ExtraRoute[] {
  const { store, bell } = opts;

  const setSessionCookie = (res: import('node:http').ServerResponse, token: string, maxAgeSec: number): void => {
    const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (opts.secureCookies) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  };
  const clearSessionCookie = (res: import('node:http').ServerResponse): void => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${opts.secureCookies ? '; Secure' : ''}`);
  };

  function currentSession(req: import('node:http').IncomingMessage) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? store.session(token) : undefined;
  }

  /** Reads the session or answers 401. Returns the household id, or null (response already sent). */
  function requireAuth(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): string | null {
    const session = currentSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthenticated' });
      return null;
    }
    return session.householdId;
  }

  async function readJson<T>(req: import('node:http').IncomingMessage): Promise<T> {
    const raw = await readBody(req, 200_000);
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  }

  // ── auth ──
  const signup: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/signup') return false;
    const body = await readJson<{ username?: string; password?: string; tz?: string }>(req);
    const result = await store.createUser(body.username ?? '', body.password ?? '', body.tz && isValidTz(body.tz) ? body.tz : 'America/New_York');
    if ('error' in result) return json(res, 400, { error: result.error }), true;
    const session = store.createSession(result.id, result.householdId);
    setSessionCookie(res, session.token, 30 * 24 * 3600);
    json(res, 200, { username: result.username });
    return true;
  };

  const login: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/login') return false;
    const body = await readJson<{ username?: string; password?: string }>(req);
    const user = await store.verifyUser(body.username ?? '', body.password ?? '');
    if (!user) return json(res, 401, { error: 'That username and password do not match.' }), true;
    const session = store.createSession(user.id, user.householdId);
    setSessionCookie(res, session.token, 30 * 24 * 3600);
    json(res, 200, { username: user.username });
    return true;
  };

  const logout: ExtraRoute = (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/logout') return false;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) store.destroySession(token);
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return true;
  };

  const me: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/me') return false;
    const session = currentSession(req);
    if (!session) return json(res, 200, { signedIn: false }), true;
    const user = store.user(session.userId);
    const hh = store.household(session.householdId);
    json(res, 200, { signedIn: true, username: user?.username, household: hh ? { name: hh.name, kitchen: hh.kitchen, kitchenKnown: hh.kitchenKnown } : null });
    return true;
  };

  // ── the active plan ──
  const whatsNext: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/plan') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, await bell.whatsNext(hh));
    return true;
  };

  const planMeal: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    const body = await readJson<Record<string, unknown>>(req);
    json(res, 200, await bell.planMeal(hh, body as never, cannotAsk));
    return true;
  };

  const changePlan: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/change') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    const body = await readJson<Record<string, unknown>>(req);
    json(res, 200, await bell.changePlan(hh, body as never));
    return true;
  };

  const reportProgress: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/report') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    const body = await readJson<Record<string, unknown>>(req);
    json(res, 200, await bell.reportProgress(hh, body as never));
    return true;
  };

  const prepChecklist: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/plan/prep') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, await bell.prepChecklist(hh));
    return true;
  };

  const cancelPlan: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/cancel') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, await bell.cancelPlan(hh, { confirm: true }, cannotAsk));
    return true;
  };

  const sharePlan: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/share') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.sharePlan(hh));
    return true;
  };

  const unsharePlan: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/unshare') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.unsharePlan(hh));
    return true;
  };

  // ── dishes: mine, publish, and the public gallery ──
  const myDishes: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/dishes') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, { dishes: bell.myDishes(hh) });
    return true;
  };

  const addDish: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/dishes') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    const body = await readJson<Record<string, unknown>>(req);
    json(res, 200, await bell.addFamilyRecipe(hh, body as never, cannotAsk));
    return true;
  };

  const publishDish: ExtraRoute = (req, res, url) => {
    const m = /^\/api\/dishes\/([^/]+)\/(publish|unpublish)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.setDishPublished(hh, decodeURIComponent(m[1]), m[2] === 'publish'));
    return true;
  };

  const discover: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/discover') return false;
    json(res, 200, { dishes: bell.discover(), menus: MENUS.map((m) => ({ id: m.id, name: m.name, occasion: m.occasion, dishes: m.dishes })) });
    return true;
  };

  const forkDish: ExtraRoute = (req, res, url) => {
    const m = /^\/api\/discover\/([^/]+)\/([^/]+)\/fork$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.forkDish(hh, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
    return true;
  };

  // ── read-only reference data (no auth) ──
  const catalog: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/catalog') return false;
    json(res, 200, {
      dishes: DISHES.map((d) => ({ id: d.id, name: d.name, course: d.course, cuisine: d.cuisine, tags: d.tags })),
      menus: MENUS.map((m) => ({ id: m.id, name: m.name, occasion: m.occasion, dishes: m.dishes })),
    });
    return true;
  };

  // ── public, unauthenticated plan links ──
  const publicPlan: ExtraRoute = (req, res, url) => {
    const m = /^\/api\/public\/([a-z0-9]+)$/.exec(url.pathname);
    if (req.method !== 'GET' || !m) return false;
    const p = bell.publicPlan(m[1]);
    if (!p) return json(res, 404, { error: 'not_found' }), true;
    json(res, 200, p, { 'Cache-Control': 'no-store' });
    return true;
  };

  // ── the SPA shell itself: everything under / that isn't an API route ──
  const shell: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET') return false;
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/sim')) return false;
    const staticPath = /^\/app\.(js|css)$/.test(url.pathname) ? url.pathname.slice(1) : 'index.html';
    const body = opts.serveShell(staticPath);
    if (!body) return false;
    const type = staticPath.endsWith('.js') ? 'application/javascript; charset=utf-8' : staticPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': staticPath === 'index.html' ? 'no-store' : 'public, max-age=60' }).end(body);
    return true;
  };

  return [signup, login, logout, me, whatsNext, planMeal, changePlan, reportProgress, prepChecklist, cancelPlan, sharePlan, unsharePlan, myDishes, addDish, publishDish, discover, forkDish, catalog, publicPlan, shell];
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
