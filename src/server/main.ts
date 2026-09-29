/**
 * Process entry point and reusable bootstrap.
 *
 *   npm run dev      local: anonymous demo household, no account linking needed
 *   npm start        production shape: OAuth enforced (set PUBLIC_URL, DATA_DIR)
 *
 * Environment:
 *   PORT, HOST                 listen address (default 8787, 0.0.0.0)
 *   PUBLIC_URL                 canonical https origin, used as the OAuth issuer
 *   DATABASE_URL                postgres://... — takes priority over DATA_DIR when set (use this
 *                               on any host with an ephemeral filesystem, which is most free tiers)
 *   DATA_DIR                   where store.json lives when there's no DATABASE_URL ("" = in-memory)
 *   ALLOW_ANONYMOUS=1          skip auth, shared demo household (local dev only)
 *   DEMO_LOGIN=1               "Try a demo kitchen" button on the sign-in page
 *   DEMO_CLOCK=1               honour x-dinner-bell-now so the simulator can fast-forward time
 *   ALEXA_CLIENT_ID / ALEXA_CLIENT_SECRET / ALEXA_REDIRECT_URIS   Alexa+ account linking client
 *   TRUST_PROXY=1              behind a host's reverse proxy: rate-limit by X-Forwarded-For, not the proxy's IP
 *   ALLOWED_HOSTS, CORS_ORIGINS  comma separated
 *   BEDROCK_MODEL_ID, AWS_REGION   AWS Builder path: Bedrock picks the simulator's tool calls
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { OAuthServer } from './auth.js';
import type { OAuthClient } from './auth.js';
import { createApp, createClock } from './http.js';
import type { App, ExtraRoute } from './http.js';
import { createDinnerBellMcp } from './mcp.js';
import { createSimRoutes } from './sim-routes.js';
import { createWebAppRoutes } from './webapp.js';
import { DinnerBell } from './service.js';
import { Store } from './store.js';
import { createOrchestrator } from '../sim/orchestrators/index.js';
import type { Orchestrator } from '../sim/orchestrators/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SIMULATOR_CLIENT_ID = 'dinner-bell-simulator';

export interface StartOptions {
  port?: number;
  host?: string;
  publicUrl?: string;
  /** postgres://... — wins over dataDir when set. */
  databaseUrl?: string;
  dataDir?: string;
  allowAnonymous?: boolean;
  demoLogin?: boolean;
  demoClock?: boolean;
  clients?: OAuthClient[];
  limits?: { demo?: number; login?: number; webAuth?: number };
  /** Take client IPs from X-Forwarded-For (set when running behind a host's reverse proxy). */
  trustProxy?: boolean;
  allowedHosts?: string[];
  corsOrigins?: string[];
  extraRoutes?: (ctx: { store: Store; oauth: OAuthServer; bell: DinnerBell; baseUrl: () => string }) => ExtraRoute[];
  /** Defaults to env-driven selection (Bedrock if BEDROCK_MODEL_ID is set, else the rule grammar). */
  orchestrator?: Orchestrator;
  /** Serve the built simulator SPA at /sim. Defaults to true. */
  simulator?: boolean;
  log?: (line: string) => void;
}

export interface Running {
  url: string;
  app: App;
  store: Store;
  oauth: OAuthServer;
  bell: DinnerBell;
  orchestrator: Orchestrator;
  close: () => Promise<void>;
}

const csv = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function loadUiHtml(): string {
  const built = path.join(ROOT, 'dist', 'app', 'timeline.html');
  if (existsSync(built)) return readFileSync(built, 'utf8');
  return '<!doctype html><meta charset="utf-8"><title>Dinner Bell</title><body style="font:16px system-ui;padding:24px">The timeline view has not been built yet. Run <code>npm run build:ui</code>.</body>';
}

function loadWebAppFile(name: string): string | undefined {
  const p = path.join(ROOT, 'dist', 'webapp', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export async function startServer(o: StartOptions = {}): Promise<Running> {
  const log = o.log ?? ((l) => console.log(l));
  const store = await Store.open(o.databaseUrl || (o.dataDir ? path.join(o.dataDir, 'store.json') : undefined));
  const clock = createClock();
  const bell = new DinnerBell({ store, now: clock.now });
  const clients: OAuthClient[] = [...(o.clients ?? [])];

  // Amazon issues a distinct linking redirect per skill; allow its well-known https prefixes.
  const alexaId = process.env.ALEXA_CLIENT_ID;
  if (alexaId && !clients.some((c) => c.id === alexaId)) {
    clients.push({
      id: alexaId,
      name: 'Alexa',
      secret: process.env.ALEXA_CLIENT_SECRET,
      redirectUris: csv(process.env.ALEXA_REDIRECT_URIS) ?? [],
      redirectPrefixes: ['https://pitangui.amazon.com/api/skill/link/', 'https://layla.amazon.com/api/skill/link/', 'https://alexa.amazon.co.jp/api/skill/link/'],
    });
  }

  const oauth = new OAuthServer(store, {
    baseUrl: o.publicUrl ?? `http://localhost:${o.port ?? 8787}`,
    clients,
    demoLogin: !!o.demoLogin,
    limits: o.limits,
  });

  const orchestrator = o.orchestrator ?? createOrchestrator();
  const baseUrl = () => oauth.cfg.baseUrl;
  const webApp = createWebAppRoutes({
    store,
    bell,
    serveShell: loadWebAppFile,
    secureCookies: !!o.publicUrl?.startsWith('https://'),
    publicUrl: baseUrl,
    trustProxy: o.trustProxy,
    authLimit: o.limits?.webAuth,
  });
  const extraRoutes = [
    ...webApp.routes,
    ...(o.simulator === false ? [] : createSimRoutes({ distDir: path.join(ROOT, 'dist', 'sim'), clientId: SIMULATOR_CLIENT_ID, baseUrl, orchestrator })),
    ...(o.extraRoutes?.({ store, oauth, bell, baseUrl }) ?? []),
  ];

  const app = createApp({
    oauth,
    factory: () => createDinnerBellMcp({ bell, store, uiHtml: loadUiHtml, allowAnonymous: !!o.allowAnonymous }),
    clock,
    allowAnonymous: !!o.allowAnonymous,
    demoClock: !!o.demoClock,
    allowedHosts: o.allowedHosts,
    corsOrigins: o.corsOrigins,
    extraRoutes,
    log,
  });

  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(o.port ?? 8787, o.host ?? '0.0.0.0', () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;
  if (!o.publicUrl) oauth.cfg.baseUrl = `http://localhost:${port}`;
  const base = oauth.cfg.baseUrl;

  // The simulator is a public OAuth client (PKCE only).
  if (!clients.some((c) => c.id === SIMULATOR_CLIENT_ID)) {
    clients.push({ id: SIMULATOR_CLIENT_ID, name: 'the Alexa+ simulator', redirectUris: [`${base}/sim/callback`] });
  }

  return {
    url: base,
    app,
    store,
    oauth,
    bell,
    orchestrator,
    close: async () => {
      webApp.close();
      await app.close();
      await store.close();
    },
  };
}

// ── CLI ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const env = process.env;
  const flag = (k: string): boolean => env[k] === '1' || env[k] === 'true';
  const dev = env.NODE_ENV !== 'production';
  const port = Number(env.PORT ?? 8787);
  const dataDir = env.DATA_DIR === undefined ? path.join(ROOT, 'data') : env.DATA_DIR;
  startServer({
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: dataDir || undefined,
    allowAnonymous: env.ALLOW_ANONYMOUS === undefined ? dev : flag('ALLOW_ANONYMOUS'),
    demoLogin: env.DEMO_LOGIN === undefined ? dev : flag('DEMO_LOGIN'),
    demoClock: env.DEMO_CLOCK === undefined ? dev : flag('DEMO_CLOCK'),
    trustProxy: flag('TRUST_PROXY'),
    allowedHosts: csv(env.ALLOWED_HOSTS),
    corsOrigins: csv(env.CORS_ORIGINS),
  })
    .then((r) => {
      console.log(`Dinner Bell:            ${r.url}`);
      console.log(`  discover gallery:     ${r.url}/#/discover`);
      console.log(`  MCP server:           ${r.url}/mcp`);
      console.log(`  OAuth metadata:       ${r.url}/.well-known/oauth-authorization-server`);
      console.log(`  Alexa+ simulator:     ${r.url}/sim`);
      console.log(`  orchestrator:         ${r.orchestrator.kind}${r.orchestrator.modelId ? ` (${r.orchestrator.modelId})` : ' (offline grammar — set BEDROCK_MODEL_ID for AWS Builder mode)'}`);
      console.log(`  anonymous demo mode:  ${flag('ALLOW_ANONYMOUS') || (env.ALLOW_ANONYMOUS === undefined && dev) ? 'ON (local dev only)' : 'off (OAuth required)'}`);
      console.log(`  storage:              ${env.DATABASE_URL ? 'Postgres' : dataDir ? `file (${dataDir})` : 'in-memory (nothing persists)'}`);
      const stop = () => void r.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
