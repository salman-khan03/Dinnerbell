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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DISHES, MENUS } from '../engine/index.js';
import { cannotAsk } from './service.js';
import type { DinnerBell } from './service.js';
import { readBody } from './auth.js';
import type { ExtraRoute } from './http.js';
import { GUEST_TTL_MS } from './store.js';
import type { PlanRecord, Store } from './store.js';

const COOKIE = 'db_session';
const DAY_S = 24 * 3600;
const LIMIT_WINDOW_MS = 10 * 60_000;
const MAX_STREAMS = 1000;

export interface WebAppOptions {
  store: Store;
  bell: DinnerBell;
  /** Serve the built SPA (index.html/app.js/app.css) for these paths. */
  serveShell: (path: string) => string | undefined;
  /** Require Secure on the session cookie (set once behind real HTTPS). */
  secureCookies: boolean;
  /** Canonical origin for absolute URLs in link-preview tags. */
  publicUrl: () => string;
  /** Behind a reverse proxy (Render, Railway…), take the client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Attempts per client per 10 minutes on signup/login/guest/claim. */
  authLimit?: number;
}

export interface WebApp {
  routes: ExtraRoute[];
  /** Ends open event streams and stops the guest sweeper, so the HTTP server can shut down. */
  close: () => void;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
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

const escAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createWebAppRoutes(opts: WebAppOptions): WebApp {
  const { store, bell } = opts;
  const authLimit = opts.authLimit ?? 20;

  const setSessionCookie = (res: ServerResponse, token: string, maxAgeSec: number): void => {
    const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (opts.secureCookies) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  };
  const clearSessionCookie = (res: ServerResponse): void => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${opts.secureCookies ? '; Secure' : ''}`);
  };

  function currentSession(req: IncomingMessage) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? store.session(token) : undefined;
  }

  /** Reads the session or answers 401. Returns the household id, or null (response already sent). */
  function requireAuth(req: IncomingMessage, res: ServerResponse): string | null {
    const session = currentSession(req);
    if (!session) {
      json(res, 401, { error: 'unauthenticated' });
      return null;
    }
    return session.householdId;
  }

  async function readJson<T>(req: IncomingMessage): Promise<T> {
    const raw = await readBody(req, 200_000);
    try {
      return raw ? (JSON.parse(raw) as T) : ({} as T);
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { status: 400 });
    }
  }

  // ── rate limiting for the credential endpoints ──
  const attempts = new Map<string, { n: number; reset: number }>();
  const clientIp = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  /** Counts an attempt; answers 429 and returns true once `key` is over the limit. */
  function limited(key: string, res: ServerResponse): boolean {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) {
      attempts.set(key, { n: 1, reset: now + LIMIT_WINDOW_MS });
      return false;
    }
    a.n++;
    if (a.n <= authLimit) return false;
    json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' }, { 'Retry-After': String(Math.ceil((a.reset - now) / 1000)) });
    return true;
  }

  // ── background housekeeping ──
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k);
    store.sweepGuests();
  }, 15 * 60_000);
  sweeper.unref();

  // ── auth ──
  const signup: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/signup') return false;
    if (limited(`signup:${clientIp(req)}`, res)) return true;
    const body = await readJson<{ username?: string; password?: string; tz?: string }>(req);
    const result = await store.createUser(body.username ?? '', body.password ?? '', body.tz && isValidTz(body.tz) ? body.tz : 'America/New_York');
    if ('error' in result) return json(res, 400, { error: result.error }), true;
    const session = store.createSession(result.id, result.householdId);
    setSessionCookie(res, session.token, 30 * DAY_S);
    json(res, 200, { username: result.username });
    return true;
  };

  const login: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/login') return false;
    const body = await readJson<{ username?: string; password?: string }>(req);
    if (limited(`login:${clientIp(req)}:${(body.username ?? '').trim().toLowerCase()}`, res)) return true;
    const user = await store.verifyUser(body.username ?? '', body.password ?? '');
    if (!user) return json(res, 401, { error: 'That username and password do not match.' }), true;
    const session = store.createSession(user.id, user.householdId);
    setSessionCookie(res, session.token, 30 * DAY_S);
    json(res, 200, { username: user.username });
    return true;
  };

  /** "Try it now": a real, throwaway account, so every feature works with zero signup friction. */
  const guest: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/guest') return false;
    if (limited(`guest:${clientIp(req)}`, res)) return true;
    const body = await readJson<{ tz?: string }>(req);
    const user = store.createGuest(body.tz && isValidTz(body.tz) ? body.tz : 'America/New_York');
    const session = store.createSession(user.id, user.householdId, GUEST_TTL_MS);
    setSessionCookie(res, session.token, DAY_S);
    json(res, 200, { username: user.username, guest: true });
    return true;
  };

  /** Keep a guest kitchen by giving it a username and password. */
  const claim: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/claim') return false;
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'unauthenticated' }), true;
    if (limited(`claim:${clientIp(req)}`, res)) return true;
    const body = await readJson<{ username?: string; password?: string }>(req);
    const result = await store.claimGuest(session.userId, body.username ?? '', body.password ?? '');
    if ('error' in result) return json(res, 400, { error: result.error }), true;
    store.destroySession(session.token);
    const fresh = store.createSession(result.id, result.householdId);
    setSessionCookie(res, fresh.token, 30 * DAY_S);
    json(res, 200, { username: result.username, guest: false });
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
    json(res, 200, {
      signedIn: true,
      username: user?.username,
      guest: !!hh?.guest,
      guestExpiresAt: hh?.guest ? new Date(hh.createdAt + GUEST_TTL_MS).toISOString() : undefined,
      household: hh ? { name: hh.name, kitchen: hh.kitchen, kitchenKnown: hh.kitchenKnown } : null,
    });
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

  const sharePlan: ExtraRoute = (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/share') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.sharePlan(hh));
    return true;
  };

  const unsharePlan: ExtraRoute = (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/plan/unshare') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    json(res, 200, bell.unsharePlan(hh));
    return true;
  };

  // ── live sync: Server-Sent Events that say "the plan changed, refetch it" ──
  const streams = new Set<ServerResponse>();
  function openStream(req: IncomingMessage, res: ServerResponse, matches: (p: PlanRecord) => boolean): void {
    if (streams.size >= MAX_STREAMS) return json(res, 503, { error: 'busy' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    streams.add(res);
    const off = store.onPlanChange((p) => {
      if (matches(p)) res.write(`event: plan\ndata: ${JSON.stringify({ updatedAt: p.updatedAt })}\n\n`);
    });
    // Proxies drop idle connections; a comment line every 25s keeps this one open.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const done = () => {
      off();
      clearInterval(ping);
      streams.delete(res);
    };
    req.on('close', done);
    res.on('close', done);
  }

  const planEvents: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/plan/events') return false;
    const hh = requireAuth(req, res);
    if (!hh) return true;
    openStream(req, res, (p) => p.householdId === hh);
    return true;
  };

  const publicPlanEvents: ExtraRoute = (req, res, url) => {
    const m = /^\/api\/public\/([a-z0-9]+)\/events$/.exec(url.pathname);
    if (req.method !== 'GET' || !m) return false;
    const rec = store.planBySlug(m[1]);
    if (!rec) return json(res, 404, { error: 'not_found' }), true;
    // Track by plan id, not slug, so unsharing still reaches viewers (their refetch then 404s).
    openStream(req, res, (p) => p.id === rec.id);
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
    const out = bell.setDishPublished(hh, decodeURIComponent(m[1]), m[2] === 'publish');
    json(res, out.data?.needs_account ? 403 : 200, out);
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
    json(res, 200, p);
    return true;
  };

  /**
   * Link-preview tags, rendered server-side because the crawlers behind
   * iMessage/Slack/Discord/LinkedIn previews don't run JavaScript. A shared
   * plan unfurls as "Dinner at 5:00 PM · 9 dishes for 10" instead of a bare URL.
   */
  function headTags(pathname: string): { html: string; status: number } {
    const base = opts.publicUrl();
    const canonical = `${base}${pathname}`;
    let title = 'Dinner Bell: every dish on the table at once';
    let description = 'Plan a multi-dish meal so everything lands hot together, and replan live when something runs late.';
    let status = 200;
    let robots = '';
    const m = /^\/p\/([a-z0-9]+)$/.exec(pathname);
    if (m) {
      const shared = bell.publicPlan(m[1]);
      if (shared) {
        const v = shared.view;
        const names = v.dishes.map((d) => d.name);
        const list = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
        title = `Dinner at ${v.serve_target_local}: ${v.dishes.length} dishes for ${v.guests} | Dinner Bell`;
        description = `${list}. Ready ${v.serve_target_day} at ${v.serve_target_local}, shared from ${shared.householdName}.`.slice(0, 200);
      } else {
        title = 'This plan is no longer shared | Dinner Bell';
        status = 404;
      }
      robots = '<meta name="robots" content="noindex">';
    }
    const t = escAttr(title);
    const d = escAttr(description);
    const html = [
      `<title>${t}</title>`,
      `<meta name="description" content="${d}">`,
      `<link rel="canonical" href="${escAttr(canonical)}">`,
      `<meta property="og:site_name" content="Dinner Bell">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:title" content="${t}">`,
      `<meta property="og:description" content="${d}">`,
      `<meta property="og:url" content="${escAttr(canonical)}">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${t}">`,
      `<meta name="twitter:description" content="${d}">`,
      robots,
    ]
      .filter(Boolean)
      .join('\n  ');
    return { html, status };
  }

  // ── the SPA shell itself: everything under / that isn't an API route ──
  const shell: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/sim')) return false;
    const staticPath = /^\/app\.(js|css)$/.test(url.pathname) ? url.pathname.slice(1) : 'index.html';
    let body = opts.serveShell(staticPath);
    if (!body) return false;
    let status = 200;
    if (staticPath === 'index.html') {
      const head = headTags(url.pathname);
      body = body.replace(/<!--head-->[\s\S]*?<!--\/head-->/, head.html);
      status = head.status;
    }
    const type = staticPath.endsWith('.js') ? 'application/javascript; charset=utf-8' : staticPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    // index.html references assets by content hash (?v=…), so a versioned asset can be cached for good.
    const cache = staticPath === 'index.html' ? 'no-store' : url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache }).end(req.method === 'HEAD' ? undefined : body);
    return true;
  };

  return {
    routes: [
      signup, login, guest, claim, logout, me,
      planEvents, whatsNext, planMeal, changePlan, reportProgress, prepChecklist, cancelPlan, sharePlan, unsharePlan,
      myDishes, addDish, publishDish, discover, forkDish, catalog,
      publicPlanEvents, publicPlan, shell,
    ],
    close: () => {
      clearInterval(sweeper);
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
