/**
 * OAuth 2.1 authorization server + resource-server helpers for account linking.
 *
 * What Alexa+ requires of an add-on (per the MCP Toolkit quickstart):
 *  - 401 for unauthenticated MCP requests, with a pointer to the metadata;
 *  - discovery documents under /.well-known/;
 *  - authorization code flow with PKCE, S256 mandatory;
 *  - bearer tokens in the Authorization header only (never the query string);
 *  - the RFC 8707 `resource` parameter on authorize and token requests;
 *  - no reliance on Dynamic Client Registration (clients are pre-registered).
 *
 * Security notes: redirect URIs are matched exactly (or by a fixed https
 * prefix for Amazon's per-skill linking URLs); an invalid client or redirect
 * URI never redirects (it renders an error); authorization codes are single
 * use and expire in 5 minutes; refresh tokens rotate; tokens are stored only
 * as SHA-256 hashes; passwords use scrypt; logins are rate limited.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { Store, newSecret, sha256 } from './store.js';
import type { TokenRecord } from './store.js';

export interface OAuthClient {
  id: string;
  name: string;
  /** Confidential clients have a secret; public clients (the simulator) rely on PKCE alone. */
  secret?: string;
  redirectUris: string[];
  /** https URL prefixes that are allowed (Amazon issues a distinct linking URL per skill). */
  redirectPrefixes?: string[];
}

export interface AuthConfig {
  /** Canonical public origin, e.g. https://dinnerbell.example.com (no trailing slash). */
  baseUrl: string;
  clients: OAuthClient[];
  /** Offer one-click throwaway households, for judges and demos. */
  demoLogin: boolean;
  accessTtlSec?: number;
  refreshTtlSec?: number;
  /** Attempts per 10 minutes per client address. */
  limits?: { demo?: number; login?: number };
}

export const SCOPE = 'dinnerbell';
const CODE_TTL_MS = 5 * 60_000;
const TXN_TTL_MS = 10 * 60_000;

interface Txn {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  expiresAt: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const b64url = (buf: Buffer): string => buf.toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: string | object, headers: Record<string, string> = {}): void {
  const isObj = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

export class OAuthServer {
  private txns = new Map<string, Txn>();
  private attempts = new Map<string, { n: number; reset: number }>();

  constructor(
    private store: Store,
    readonly cfg: AuthConfig,
  ) {}

  get resourceUrl(): string {
    return `${this.cfg.baseUrl}/mcp`;
  }

  // ───────────── discovery ─────────────

  authorizationServerMetadata(): object {
    const b = this.cfg.baseUrl;
    return {
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      revocation_endpoint: `${b}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
      // The Alexa+ quickstart asks for protected-resource metadata at this path too, so it is repeated here.
      resource: this.resourceUrl,
      authorization_servers: [b],
    };
  }

  protectedResourceMetadata(): object {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.cfg.baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'Dinner Bell',
    };
  }

  wwwAuthenticate(error?: string): string {
    const parts = [`resource_metadata="${this.cfg.baseUrl}/.well-known/oauth-protected-resource"`, `scope="${SCOPE}"`];
    if (error) parts.unshift(`error="${error}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  // ───────────── resource-server side ─────────────

  /** Verify the bearer token in the Authorization header. Query-string tokens are deliberately ignored. */
  verifyBearer(req: IncomingMessage): AuthInfo | null {
    const h = req.headers.authorization;
    const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    if (!m) return null;
    const rec = this.store.findAccess(sha256(m[1]));
    if (!rec || rec.accessExpiresAt <= Date.now()) return null;
    if (rec.resource && rec.resource !== this.resourceUrl) return null;
    return {
      token: m[1],
      clientId: rec.clientId,
      scopes: rec.scope.split(' '),
      expiresAt: Math.floor(rec.accessExpiresAt / 1000),
      resource: rec.resource ? new URL(rec.resource) : undefined,
      extra: { householdId: rec.householdId, userId: rec.userId },
    };
  }

  // ───────────── helpers ─────────────

  private client(id: string | undefined): OAuthClient | undefined {
    return id ? this.cfg.clients.find((c) => c.id === id) : undefined;
  }

  private redirectAllowed(c: OAuthClient, uri: string): boolean {
    if (c.redirectUris.includes(uri)) return true;
    return (c.redirectPrefixes ?? []).some((p) => p.startsWith('https://') && uri.startsWith(p));
  }

  private rateLimited(key: string, max: number): boolean {
    const now = Date.now();
    const a = this.attempts.get(key);
    if (!a || a.reset < now) {
      this.attempts.set(key, { n: 1, reset: now + 10 * 60_000 });
      return false;
    }
    a.n++;
    return a.n > max;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, t] of this.txns) if (t.expiresAt < now) this.txns.delete(k);
    for (const [k, c] of this.store.codes) if (c.expiresAt < now) this.store.codes.delete(k);
    for (const [k, a] of this.attempts) if (a.reset < now) this.attempts.delete(k);
  }

  private errorPage(res: ServerResponse, status: number, message: string): void {
    send(res, status, page('Something went wrong', `<p class="err">${esc(message)}</p><p class="muted">Close this window and try linking again from your app.</p>`));
  }

  private redirectBack(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.cfg.baseUrl);
    res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  // ───────────── /authorize ─────────────

  async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.sweep();
    if (req.method === 'GET') return this.authorizeGet(res, url);
    if (req.method === 'POST') return this.authorizePost(req, res);
    res.writeHead(405, { Allow: 'GET, POST' }).end();
  }

  private authorizeGet(res: ServerResponse, url: URL): void {
    const p = url.searchParams;
    const client = this.client(p.get('client_id') ?? undefined);
    const redirectUri = p.get('redirect_uri') ?? '';
    // Never redirect to an unvalidated URI.
    if (!client) return this.errorPage(res, 400, 'Unknown application.');
    if (!redirectUri || !this.redirectAllowed(client, redirectUri)) return this.errorPage(res, 400, 'This redirect address is not allowed for the application.');
    const state = p.get('state') ?? undefined;
    const fail = (error: string, description: string) => this.redirectBack(res, redirectUri, { error, error_description: description, state });
    if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
    const challenge = p.get('code_challenge');
    if (!challenge || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const resource = p.get('resource') ?? undefined;
    if (resource && resource !== this.resourceUrl) return fail('invalid_target', 'Unknown resource.');
    const scope = (p.get('scope') ?? SCOPE).split(/\s+/).filter(Boolean);
    if (scope.some((s) => s !== SCOPE)) return fail('invalid_scope', `Only the "${SCOPE}" scope is available.`);

    const id = b64url(randomBytes(24));
    this.txns.set(id, { clientId: client.id, redirectUri, state, codeChallenge: challenge, resource, scope: scope.join(' ') || SCOPE, expiresAt: Date.now() + TXN_TTL_MS });
    const nonce = b64url(randomBytes(16));
    send(res, 200, this.loginPage(id, client.name, nonce), {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self' https: http:; base-uri 'none'; frame-ancestors 'none'`,
    });
  }

  private async authorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req, 20_000));
    } catch {
      return this.errorPage(res, 413, 'That request was too large.');
    }
    const txnId = form.get('txn') ?? '';
    const txn = this.txns.get(txnId);
    if (!txn || txn.expiresAt < Date.now()) return this.errorPage(res, 400, 'This sign-in page expired. Please start again.');
    const client = this.client(txn.clientId)!;
    const action = form.get('action') ?? 'signin';
    const ip = req.socket.remoteAddress ?? 'unknown';

    const back = (msg: string) => {
      const nonce = b64url(randomBytes(16));
      send(res, 200, this.loginPage(txnId, client.name, nonce, msg, form.get('username') ?? ''), {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self' https: http:; base-uri 'none'; frame-ancestors 'none'`,
      });
    };
    const finish = (userId: string, householdId: string): void => {
      this.txns.delete(txnId); // a transaction is single-use
      const code = newSecret();
      this.store.codes.set(sha256(code), {
        codeHash: sha256(code),
        clientId: txn.clientId,
        userId,
        householdId,
        redirectUri: txn.redirectUri,
        codeChallenge: txn.codeChallenge,
        resource: txn.resource,
        scope: txn.scope,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      this.redirectBack(res, txn.redirectUri, { code, state: txn.state });
    };

    if (action === 'deny') {
      this.txns.delete(txnId);
      return this.redirectBack(res, txn.redirectUri, { error: 'access_denied', state: txn.state });
    }

    if (action === 'demo') {
      if (!this.cfg.demoLogin) return back('Demo sign-in is not enabled here.');
      if (this.rateLimited(`demo:${ip}`, this.cfg.limits?.demo ?? 30)) return back('Too many attempts. Try again in a few minutes.');
      const tz = validTz(form.get('tz'));
      const user = await this.store.createUser(`demo-${randomBytes(4).toString('hex')}`, randomBytes(18).toString('base64url'), tz);
      if ('error' in user) return back(user.error);
      return finish(user.id, user.householdId);
    }

    const username = form.get('username') ?? '';
    const password = form.get('password') ?? '';
    if (this.rateLimited(`login:${ip}:${username.toLowerCase()}`, this.cfg.limits?.login ?? 12)) return back('Too many attempts. Try again in a few minutes.');

    if (action === 'signup') {
      const user = await this.store.createUser(username, password, validTz(form.get('tz')));
      if ('error' in user) return back(user.error);
      return finish(user.id, user.householdId);
    }
    const user = await this.store.verifyUser(username, password);
    if (!user) return back('That username and password do not match.');
    return finish(user.id, user.householdId);
  }

  // ───────────── /token ─────────────

  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.sweep();
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req, 20_000));
    } catch {
      return send(res, 413, { error: 'invalid_request' });
    }
    const fail = (status: number, error: string, description?: string) => send(res, status, { error, ...(description ? { error_description: description } : {}) });

    // Client authentication: HTTP Basic or form fields.
    let clientId = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const basic = req.headers.authorization && /^Basic\s+(.+)$/i.exec(req.headers.authorization);
    if (basic) {
      const [id, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id);
      secret = decodeURIComponent(rest.join(':'));
    }
    const client = this.client(clientId);
    if (!client) return fail(401, 'invalid_client');
    if (client.secret && !(secret && safeEqual(secret, client.secret))) return fail(401, 'invalid_client');

    const resource = form.get('resource') ?? undefined;
    if (resource && resource !== this.resourceUrl) return fail(400, 'invalid_target', 'Unknown resource.');

    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const rec = this.store.codes.get(sha256(code));
      this.store.codes.delete(sha256(code)); // single use, even on failure
      if (!rec || rec.expiresAt < Date.now() || rec.clientId !== client.id) return fail(400, 'invalid_grant');
      if (form.get('redirect_uri') !== rec.redirectUri) return fail(400, 'invalid_grant', 'redirect_uri mismatch');
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return fail(400, 'invalid_grant', 'Missing or malformed code_verifier.');
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      if (!safeEqual(challenge, rec.codeChallenge)) return fail(400, 'invalid_grant', 'PKCE verification failed.');
      if (rec.resource && resource && rec.resource !== resource) return fail(400, 'invalid_target');
      return this.issue(res, client.id, rec.userId, rec.householdId, rec.scope, rec.resource ?? resource);
    }

    if (grant === 'refresh_token') {
      const old = this.store.findRefresh(sha256(form.get('refresh_token') ?? ''));
      if (!old || old.refreshExpiresAt < Date.now() || old.clientId !== client.id) return fail(400, 'invalid_grant');
      this.store.removeToken(old); // rotation: the old refresh token dies immediately
      return this.issue(res, client.id, old.userId, old.householdId, old.scope, old.resource);
    }
    return fail(400, 'unsupported_grant_type');
  }

  private issue(res: ServerResponse, clientId: string, userId: string, householdId: string, scope: string, resource?: string): void {
    const access = newSecret();
    const refresh = newSecret();
    const accessTtl = this.cfg.accessTtlSec ?? 3600;
    const refreshTtl = this.cfg.refreshTtlSec ?? 60 * 24 * 3600;
    const now = Date.now();
    const rec: TokenRecord = {
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      clientId,
      userId,
      householdId,
      scope,
      resource,
      accessExpiresAt: now + accessTtl * 1000,
      refreshExpiresAt: now + refreshTtl * 1000,
    };
    this.store.saveToken(rec);
    send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope });
  }

  // ───────────── /revoke (RFC 7009) ─────────────

  async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
    const form = new URLSearchParams(await readBody(req, 20_000).catch(() => ''));
    const token = form.get('token');
    if (token) this.store.revoke(sha256(token));
    send(res, 200, {}); // always 200: do not reveal whether the token existed
  }

  // ───────────── the sign-in page ─────────────

  private loginPage(txn: string, clientName: string, nonce: string, message?: string, username = ''): string {
    const demo = this.cfg.demoLogin
      ? `<form method="post" class="demo"><input type="hidden" name="txn" value="${esc(txn)}"><input type="hidden" name="tz" class="tz"><button name="action" value="demo" class="ghost">Try it with a demo kitchen, no sign-up</button></form>`
      : '';
    return page(
      'Link Dinner Bell',
      `<p class="lead"><strong>${esc(clientName)}</strong> would like to link with your Dinner Bell kitchen so it can plan your meals.</p>
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ''}
<form method="post" autocomplete="on">
  <input type="hidden" name="txn" value="${esc(txn)}"><input type="hidden" name="tz" class="tz">
  <label>Username<input name="username" value="${esc(username)}" autocomplete="username" required minlength="3" maxlength="32"></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
  <div class="row"><button name="action" value="signin">Sign in and link</button><button name="action" value="signup" class="ghost">Create account</button></div>
</form>
${demo}
<form method="post"><input type="hidden" name="txn" value="${esc(txn)}"><button name="action" value="deny" class="link">Cancel</button></form>
<script nonce="${nonce}">document.querySelectorAll('.tz').forEach(function(e){try{e.value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(_){}})</script>`,
    );
  }
}

function validTz(tz: string | null): string {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      /* fall through */
    }
  }
  return 'America/New_York';
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Dinner Bell</title>
<style>
:root{color-scheme:light dark;--bg:#fbf6ee;--fg:#2a211a;--mut:#7a6a5c;--card:#fff;--ac:#c2410c;--bd:#eadfce}
@media(prefers-color-scheme:dark){:root{--bg:#1a1410;--fg:#f4ebe0;--mut:#b7a793;--card:#241c16;--ac:#fb923c;--bd:#3a2f26}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--bd);border-radius:20px;padding:28px;box-shadow:0 10px 40px rgba(0,0,0,.08)}
h1{margin:0 0 6px;font-size:22px;display:flex;gap:10px;align-items:center}h1 i{font-style:normal;background:var(--ac);color:#fff;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:18px}
.lead{color:var(--mut);margin:8px 0 18px}.err{color:#b91c1c;background:rgba(185,28,28,.08);padding:10px 12px;border-radius:10px;margin:0 0 14px}
label{display:block;font-size:14px;color:var(--mut);margin:0 0 12px}input{display:block;width:100%;margin-top:4px;padding:11px 12px;font:inherit;border:1px solid var(--bd);border-radius:10px;background:transparent;color:var(--fg)}
input:focus{outline:2px solid var(--ac);outline-offset:1px}.row{display:flex;gap:8px}button{flex:1;font:inherit;font-weight:600;padding:11px 14px;border-radius:10px;border:0;background:var(--ac);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--ac);border:1px solid var(--ac)}button.link{background:none;color:var(--mut);font-weight:400;text-decoration:underline;margin-top:8px}.demo{margin-top:12px}.demo button{width:100%}.muted{color:var(--mut)}
</style></head><body><main><h1><i>🔔</i>Dinner Bell</h1>${body}</main></body></html>`;
}
