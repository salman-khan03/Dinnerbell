/**
 * The HTTP front door: OAuth endpoints, discovery documents, health, and /mcp.
 *
 * /mcp serves both MCP protocol eras from ONE tool factory:
 *   - 2025-11-25 (what Alexa+ speaks): a *stateful* Streamable HTTP session.
 *     Elicitation needs this: the server asks a question on the open response
 *     stream, and the person's answer arrives later as a separate POST that
 *     must reach the same server instance. The SDK's default per-request
 *     legacy handling is stateless and cannot do that, so sessions are wired
 *     by hand and bound to the household that opened them.
 *   - 2026-07-28: the SDK's modern per-request handler.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { OAuthServer, readBody } from './auth.js';

export interface Clock {
  now: () => number;
  run: <T>(ms: number | undefined, fn: () => T) => T;
}

/** Wall clock that a demo request may override (for the simulator's "fast-forward the kitchen"). */
export function createClock(): Clock {
  const als = new AsyncLocalStorage<number>();
  return {
    now: () => als.getStore() ?? Date.now(),
    run: (ms, fn) => (ms === undefined ? fn() : als.run(ms, fn)),
  };
}

export type ExtraRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

export interface AppOptions {
  oauth: OAuthServer;
  /** A fresh MCP server per session (legacy era) or per request (modern era). */
  factory: () => McpServer;
  clock: Clock;
  /** Skip authentication and use a shared demo household. Local development only. */
  allowAnonymous: boolean;
  /** Honour the x-dinner-bell-now header (demo / simulator only). */
  demoClock: boolean;
  /** If set, the Host header must be one of these (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Origins allowed to call the MCP endpoint from a browser (e.g. the MCP inspector). */
  corsOrigins?: string[];
  extraRoutes?: ExtraRoute[];
  log?: (line: string) => void;
}

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  householdId: string;
  last: number;
}

const isInitialize = (b: unknown): boolean => !!b && !Array.isArray(b) && (b as { method?: string }).method === 'initialize';

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

export interface App {
  server: Server;
  sessions: () => number;
  close: () => Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const { oauth, factory, clock, allowAnonymous } = opts;
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, Session>();
  const MAX_SESSIONS = 500;
  const IDLE_MS = 30 * 60_000;
  const modern = createMcpHandler(() => factory(), { legacy: 'reject' });
  const modernNode = toNodeHandler(modern);

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.last < cutoff) {
        sessions.delete(id);
        void s.transport.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref();

  async function newSession(householdId: string): Promise<Session> {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0];
      if (oldest) {
        sessions.delete(oldest[0]);
        void oldest[1].transport.close().catch(() => {});
      }
    }
    const server = factory();
    const entry: Session = { server, householdId, last: Date.now(), transport: undefined as unknown as NodeStreamableHTTPServerTransport };
    entry.transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, entry);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });
    entry.transport.onclose = () => {
      if (entry.transport.sessionId) sessions.delete(entry.transport.sessionId);
    };
    await server.connect(entry.transport);
    return entry;
  }

  async function handleLegacy(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, body: unknown, auth: AuthInfo | undefined): Promise<void> {
    const householdId = (auth?.extra?.householdId as string | undefined) ?? 'hh_demo';
    const sid = req.headers['mcp-session-id'];
    const id = Array.isArray(sid) ? sid[0] : sid;
    let s = id ? sessions.get(id) : undefined;
    if (id && (!s || s.householdId !== householdId)) return jsonRpcError(res, 404, -32001, 'Session not found');
    if (!s) {
      if (req.method === 'POST' && isInitialize(body)) s = await newSession(householdId);
      else return jsonRpcError(res, 400, -32000, 'Bad Request: an Mcp-Session-Id header is required after initialize');
    }
    s.last = Date.now();
    req.auth = auth;
    await s.transport.handleRequest(req, res, body);
  }

  async function handleMcp(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse): Promise<void> {
    const auth = oauth.verifyBearer(req) ?? undefined;
    if (!auth && !allowAnonymous) {
      res.writeHead(401, { 'WWW-Authenticate': oauth.wwwAuthenticate(req.headers.authorization ? 'invalid_token' : undefined), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Link your Dinner Bell account to continue.' }));
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      let raw: string;
      try {
        raw = await readBody(req, 1_000_000);
      } catch {
        return jsonRpcError(res, 413, -32600, 'Request too large');
      }
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return jsonRpcError(res, 400, -32700, 'Parse error');
      }
    }

    const nowHeader = opts.demoClock ? req.headers['x-dinner-bell-now'] : undefined;
    const nowMs = typeof nowHeader === 'string' ? (/^\d+$/.test(nowHeader) ? Number(nowHeader) : Date.parse(nowHeader)) : undefined;

    await clock.run(Number.isFinite(nowMs as number) ? (nowMs as number) : undefined, async () => {
      const web = await toWebRequest(req, body);
      if (await isLegacyRequest(web, body)) return handleLegacy(req, res, body, auth);
      req.auth = auth;
      return modernNode(req, res, body);
    });
  }

  function cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin && opts.corsOrigins?.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id, x-dinner-bell-now');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, www-authenticate');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const started = Date.now();
      try {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
        if (opts.allowedHosts && !opts.allowedHosts.includes(host)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden host');
          return;
        }
        const url = new URL(req.url ?? '/', oauth.cfg.baseUrl);
        const p = url.pathname;

        if (p === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, sessions: sessions.size }));
          return;
        }
        if (p.startsWith('/.well-known/')) {
          if (cors(req, res)) return;
          const meta =
            p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration'
              ? oauth.authorizationServerMetadata()
              : p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp'
                ? oauth.protectedResourceMetadata()
                : null;
          if (!meta) return void res.writeHead(404).end();
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }).end(JSON.stringify(meta));
          return;
        }
        if (p === '/authorize') return await oauth.authorize(req, res, url);
        if (p === '/token') return await oauth.token(req, res);
        if (p === '/revoke') return await oauth.revoke(req, res);
        if (p === '/mcp') {
          if (cors(req, res)) return;
          return await handleMcp(req, res);
        }
        for (const route of opts.extraRoutes ?? []) if (await route(req, res, url)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        log(`error ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: status === 500 ? 'internal_error' : 'bad_request' }));
      } finally {
        if (process.env.DINNER_BELL_LOG_REQUESTS) log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      }
    })();
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // MCP streams (SSE, held-open elicitation) must not be cut off

  return {
    server,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweeper);
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
      sessions.clear();
      await modern.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
