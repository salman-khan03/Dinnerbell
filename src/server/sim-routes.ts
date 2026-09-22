/**
 * Static hosting and the intent endpoint for the Alexa+ simulator SPA.
 *
 * The simulator is a real OAuth client of this same server (see
 * `SIMULATOR_CLIENT_ID` in main.ts) and a real MCP client — nothing here
 * pretends. This module only adds: the built browser bundle, a discovery
 * endpoint so the SPA doesn't hardcode the client id, and `/sim/interpret`,
 * which turns one utterance into one Dinner Bell tool call using whichever
 * `Orchestrator` the process was started with (Bedrock or the rule grammar).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExtraRoute } from './http.js';
import { readBody } from './auth.js';
import type { Orchestrator, PlanContext, Turn, McpToolInfo } from '../sim/orchestrators/index.js';

export interface SimRoutesOptions {
  distDir: string;
  clientId: string;
  baseUrl: () => string;
  orchestrator: Orchestrator;
  /** Max utterances kept as conversation context for the orchestrator. */
  historyLimit?: number;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res: ServerResponse, status: number, body: string, contentType: string, cache = 'no-store'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': cache });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

interface InterpretRequest {
  utterance?: string;
  plan?: PlanContext;
  history?: Turn[];
  tools?: McpToolInfo[];
}

export function createSimRoutes(opts: SimRoutesOptions): ExtraRoute[] {
  const file = (rel: string): string | undefined => {
    const p = path.join(opts.distDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  const notBuilt = (): string =>
    '<!doctype html><meta charset="utf-8"><title>Dinner Bell simulator</title><body style="font:16px system-ui;padding:24px">The simulator has not been built yet. Run <code>npm run build:ui</code>.</body>';

  const staticFile = (relPath: string): ExtraRoute => {
    const ext = path.extname(relPath);
    const basename = path.basename(relPath);
    return (req, res, url) => {
      if (req.method !== 'GET' || url.pathname !== relPath) return false;
      const body = file(basename);
      if (!body) {
        send(res, 404, `/* ${basename} has not been built yet. Run npm run build:ui. */`, MIME[ext] ?? 'text/plain');
        return true;
      }
      send(res, 200, body, MIME[ext] ?? 'text/plain', 'public, max-age=60');
      return true;
    };
  };

  const html: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || (url.pathname !== '/sim' && url.pathname !== '/sim/' && url.pathname !== '/sim/callback')) return false;
    send(res, 200, file('index.html') ?? notBuilt(), MIME['.html']);
    return true;
  };

  const config: ExtraRoute = (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/sim/config') return false;
    const base = opts.baseUrl();
    sendJson(res, 200, {
      client_id: opts.clientId,
      authorize_url: `${base}/authorize`,
      token_url: `${base}/token`,
      revoke_url: `${base}/revoke`,
      redirect_uri: `${base}/sim/callback`,
      mcp_url: `${base}/mcp`,
      resource: `${base}/mcp`,
      orchestrator: opts.orchestrator.kind,
      model_id: opts.orchestrator.modelId ?? null,
    });
    return true;
  };

  const interpret: ExtraRoute = async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/sim/interpret') return false;
    let body: InterpretRequest;
    try {
      const raw = await readBody(req, 200_000);
      body = raw ? (JSON.parse(raw) as InterpretRequest) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return true;
    }
    const utterance = (body.utterance ?? '').slice(0, 500);
    if (!utterance.trim()) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'utterance is required' });
      return true;
    }
    const history = (body.history ?? []).slice(-(opts.historyLimit ?? 8));
    try {
      const result = await opts.orchestrator.run(utterance, body.plan, history, body.tools ?? []);
      sendJson(res, 200, { ...result, orchestrator: opts.orchestrator.kind });
    } catch (e) {
      sendJson(res, 500, { error: 'interpret_failed', error_description: (e as Error).message });
    }
    return true;
  };

  return [html, config, interpret, staticFile('/sim/app.js'), staticFile('/sim/app.css')];
}

export function readSimFile(distDir: string, rel: string): string | undefined {
  const p = path.join(distDir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

// Kept for the rare hand-wired composition that wants to gate on the request first.
export type { IncomingMessage, ServerResponse };
