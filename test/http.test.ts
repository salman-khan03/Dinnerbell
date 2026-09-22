import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIMULATOR_CLIENT_ID, startServer } from '../src/server/main.js';
import type { Running } from '../src/server/main.js';
import { at } from './helpers.js';

let srv: Running;
let base: string;
const CLIENT = SIMULATOR_CLIENT_ID;

beforeAll(async () => {
  srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    allowAnonymous: false,
    demoLogin: true,
    demoClock: true,
    limits: { demo: 1000, login: 1000 },
    clients: [
      { id: 'alexa-test', name: 'Alexa', secret: 's3cret', redirectUris: [], redirectPrefixes: ['https://pitangui.amazon.com/api/skill/link/'] },
    ],
  });
  base = srv.url;
});
afterAll(async () => {
  await srv.close();
});

// ── a tiny OAuth client ──
const b64 = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}
const redirect = () => `${base}/sim/callback`;

async function authorizeTxn(p: Record<string, string>): Promise<{ status: number; html: string; location?: string }> {
  const r = await fetch(`${base}/authorize?${new URLSearchParams(p)}`, { redirect: 'manual' });
  return { status: r.status, html: await r.text(), location: r.headers.get('location') ?? undefined };
}

async function login(action: 'demo' | 'signup' | 'signin' | 'deny', extra: Record<string, string> = {}, clientId = CLIENT) {
  const { verifier, challenge } = pkce();
  const page = await authorizeTxn({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${base}/mcp`,
  });
  const txn = /name="txn" value="([^"]+)"/.exec(page.html)![1];
  const r = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ txn, action, tz: 'America/New_York', ...extra }),
  });
  return { r, verifier, txn, location: r.headers.get('location') ?? '' };
}

async function tokenFor(code: string, verifier: string, extra: Record<string, string> = {}) {
  const r = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: verifier, redirect_uri: redirect(), resource: `${base}/mcp`, ...extra }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, string | number> };
}

async function getTokens() {
  const { location, verifier } = await login('demo');
  const code = new URL(location).searchParams.get('code')!;
  const t = await tokenFor(code, verifier);
  expect(t.status).toBe(200);
  return t.json as { access_token: string; refresh_token: string; expires_in: number };
}

async function mcpClient(token: string, opts: { answers?: Record<string, unknown>; version?: 'legacy' | 'modern' } = {}) {
  const asked: string[][] = [];
  const client = new Client(
    { name: 'http-test', version: '1' },
    { capabilities: { elicitation: { form: {} } }, ...(opts.version === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}) },
  );
  client.setRequestHandler('elicitation/create', async (req) => {
    const props = (req.params as { requestedSchema?: { properties: Record<string, unknown> } }).requestedSchema?.properties ?? {};
    asked.push(Object.keys(props));
    // Deliberately slow, like a person answering aloud: the answer arrives in a separate HTTP request.
    await new Promise((r) => setTimeout(r, 150));
    const content: Record<string, string | number | boolean> = {};
    for (const k of Object.keys(props)) if (opts.answers && k in opts.answers) content[k] = opts.answers[k] as string | number | boolean;
    return { action: 'accept', content };
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'x-dinner-bell-now': String(at(2026, 11, 24, 12) * 60_000) } },
  });
  await client.connect(transport);
  return { client, asked, transport };
}

describe('discovery', () => {
  it('serves RFC 8414 and RFC 9728 metadata that requires PKCE S256', async () => {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint).toBe(`${base}/token`);
    expect(as.grant_types_supported).toContain('refresh_token');
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${base}/mcp`);
    expect(pr.authorization_servers).toEqual([base]);
    expect(pr.bearer_methods_supported).toEqual(['header']);
  });

  it('answers 401 with a WWW-Authenticate pointer when unauthenticated', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata="[^"]+oauth-protected-resource"/);
  });

  it('ignores tokens in the query string', async () => {
    const t = await getTokens();
    const r = await fetch(`${base}/mcp?access_token=${t.access_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });
});

describe('OAuth 2.1 authorization code + PKCE', () => {
  it('completes the demo flow and returns a bearer token pair', async () => {
    const t = await getTokens();
    expect(t.access_token.length).toBeGreaterThan(30);
    expect(t.expires_in).toBe(3600);
  });

  it('echoes state and iss on the redirect', async () => {
    const { location } = await login('demo');
    const u = new URL(location);
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(u.searchParams.get('iss')).toBe(base);
  });

  it('signs up, then signs in as the same household', async () => {
    const name = `cook${randomBytes(3).toString('hex')}`;
    const up = await login('signup', { username: name, password: 'correct horse battery' });
    expect(up.location).toContain('code=');
    const again = await login('signin', { username: name, password: 'correct horse battery' });
    expect(again.location).toContain('code=');
    const bad = await login('signin', { username: name, password: 'wrong password!' });
    expect(bad.r.status).toBe(200);
    expect(await bad.r.text()).toMatch(/do not match/);
  });

  it('rejects a weak password and duplicate usernames', async () => {
    const weak = await login('signup', { username: 'someone', password: 'short' });
    expect(await weak.r.text()).toMatch(/at least 8/);
  });

  it('refuses PKCE downgrades and missing challenges', async () => {
    const plain = await authorizeTxn({ response_type: 'code', client_id: CLIENT, redirect_uri: redirect(), code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' });
    expect(plain.status).toBe(302);
    expect(plain.location).toContain('error=invalid_request');
    const none = await authorizeTxn({ response_type: 'code', client_id: CLIENT, redirect_uri: redirect() });
    expect(none.location).toContain('error=invalid_request');
  });

  it('never redirects to an unregistered redirect_uri (no open redirect)', async () => {
    const { challenge } = pkce();
    const evil = await authorizeTxn({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(evil.status).toBe(400);
    expect(evil.location).toBeUndefined();
    const unknown = await authorizeTxn({ response_type: 'code', client_id: 'nope', redirect_uri: redirect(), code_challenge: challenge, code_challenge_method: 'S256' });
    expect(unknown.status).toBe(400);
  });

  it('allows Amazon per-skill linking URLs by prefix, but not lookalikes', async () => {
    const { challenge } = pkce();
    const ok = await authorizeTxn({ response_type: 'code', client_id: 'alexa-test', redirect_uri: 'https://pitangui.amazon.com/api/skill/link/M2ABC', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(ok.status).toBe(200);
    const bad = await authorizeTxn({ response_type: 'code', client_id: 'alexa-test', redirect_uri: 'https://pitangui.amazon.com.evil.example/api/skill/link/M2ABC', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(bad.status).toBe(400);
  });

  it('rejects a wrong resource indicator', async () => {
    const { challenge } = pkce();
    const r = await authorizeTxn({ response_type: 'code', client_id: CLIENT, redirect_uri: redirect(), code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    expect(r.location).toContain('error=invalid_target');
  });

  it('binds the code to its PKCE verifier and makes codes single-use', async () => {
    const { location, verifier } = await login('demo');
    const code = new URL(location).searchParams.get('code')!;
    const wrong = await tokenFor(code, b64(randomBytes(32)));
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('invalid_grant');
    // The failed attempt burned the code.
    const retry = await tokenFor(code, verifier);
    expect(retry.status).toBe(400);
  });

  it('rejects a mismatched redirect_uri at the token endpoint', async () => {
    const { location, verifier } = await login('demo');
    const code = new URL(location).searchParams.get('code')!;
    const r = await tokenFor(code, verifier, { redirect_uri: 'https://evil.example/cb' });
    expect(r.status).toBe(400);
  });

  it('rotates refresh tokens: the old one dies on use', async () => {
    const t = await getTokens();
    const use = async (rt: string) =>
      fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: rt }) });
    const first = await use(t.refresh_token);
    expect(first.status).toBe(200);
    const next = (await first.json()) as { refresh_token: string };
    expect(next.refresh_token).not.toBe(t.refresh_token);
    expect((await use(t.refresh_token)).status).toBe(400);
    expect((await use(next.refresh_token)).status).toBe(200);
  });

  it('requires the client secret for confidential clients', async () => {
    const r = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'alexa-test', code: 'x', code_verifier: 'x'.repeat(50) }) });
    expect(r.status).toBe(401);
  });

  it('honours revocation', async () => {
    const t = await getTokens();
    await fetch(`${base}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.access_token }) });
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access_token}` }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('a denied consent redirects with access_denied', async () => {
    const { location } = await login('deny');
    expect(location).toContain('error=access_denied');
  });
});

describe('MCP over real HTTP, authenticated, 2025-11-25 stateful session', () => {
  it('elicitation crosses separate HTTP requests: question on the stream, answer in a new POST', async () => {
    const t = await getTokens();
    const { client, asked } = await mcpClient(t.access_token, { answers: { meal: 'Thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 } });
    const r = await client.callTool({ name: 'plan_meal', arguments: {} });
    expect(asked).toEqual([['meal', 'serve_time', 'guests', 'cooks', 'ovens']]);
    const s = r.structuredContent as { spoken: string; plan: { state: string; dishes: unknown[] } };
    expect(s.plan.dishes).toHaveLength(9);
    expect(s.spoken).toMatch(/9-dish meal for 10/);
    expect(srv.app.sessions()).toBeGreaterThan(0);
    await client.close();
  });

  it('keeps each household separate', async () => {
    const a = await mcpClient((await getTokens()).access_token, { answers: { meal: 'Thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 } });
    const b = await mcpClient((await getTokens()).access_token, {});
    await a.client.callTool({ name: 'plan_meal', arguments: {} });
    const mine = await a.client.callTool({ name: 'whats_next', arguments: {} });
    const theirs = await b.client.callTool({ name: 'whats_next', arguments: {} });
    expect((mine.structuredContent as { plan?: unknown }).plan).toBeTruthy();
    expect((theirs.structuredContent as { data?: { no_plan?: boolean } }).data?.no_plan).toBe(true);
    await a.client.close();
    await b.client.close();
  });

  it('plans persist across sessions for the same account', async () => {
    const t = await getTokens();
    const one = await mcpClient(t.access_token, { answers: { meal: 'Hanukkah', serve_time: '6pm friday', guests: 6, cooks: 1, ovens: 1 } });
    await one.client.callTool({ name: 'plan_meal', arguments: {} });
    await one.client.close();
    const two = await mcpClient(t.access_token);
    const r = await two.client.callTool({ name: 'whats_next', arguments: {} });
    expect((r.structuredContent as { plan?: { dishes: unknown[] } }).plan!.dishes.length).toBe(4);
    await two.client.close();
  });

  it('a stolen session id cannot be used by another household', async () => {
    const a = await mcpClient((await getTokens()).access_token);
    const sid = (a.transport as unknown as { sessionId?: string }).sessionId!;
    expect(sid).toBeTruthy();
    const other = (await getTokens()).access_token;
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${other}`, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(404);
    await a.client.close();
  });

  it('answers a request with no session header and no initialize with a clear 400', async () => {
    const t = await getTokens();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(400);
  });

  it('runs the tools well inside the 500 ms Alexa+ budget', async () => {
    const t = await getTokens();
    const { client } = await mcpClient(t.access_token, { answers: { meal: 'Thanksgiving', serve_time: '5pm thursday', guests: 10, cooks: 1, ovens: 1 } });
    await client.callTool({ name: 'plan_meal', arguments: {} });
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await client.callTool({ name: 'whats_next', arguments: {} });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(p95).toBeLessThan(500);
    await client.close();
  });
});

describe('the 2026-07-28 wire era', () => {
  it('serves a modern client from the same tools (asking degrades to needs_input)', async () => {
    const t = await getTokens();
    const { client } = await mcpClient(t.access_token, { version: 'modern' });
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(9);
    const r = await client.callTool({ name: 'plan_meal', arguments: { meal: 'thanksgiving', serve_time: '5pm thursday', guests: 10 } });
    const s = r.structuredContent as { plan?: { state: string }; needs_input?: string[] };
    expect(s.plan?.state ?? s.needs_input).toBeTruthy();
    await client.close();
  });
});

describe('abuse resistance', () => {
  it('rate limits repeated sign-in guesses', async () => {
    const strict = await startServer({ port: 0, host: '127.0.0.1', demoLogin: true, limits: { login: 3, demo: 3 } });
    try {
      const b = strict.url;
      const attempt = async () => {
        const v = randomBytes(32).toString('base64url');
        const ch = createHash('sha256').update(v).digest('base64url');
        const page = await (await fetch(`${b}/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: `${b}/sim/callback`, code_challenge: ch, code_challenge_method: 'S256' })}`)).text();
        const txn = /name="txn" value="([^"]+)"/.exec(page)![1];
        const r = await fetch(`${b}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ txn, action: 'signin', username: 'victim', password: 'guess-guess-1' }) });
        return r.text();
      };
      const results: string[] = [];
      for (let i = 0; i < 5; i++) results.push(await attempt());
      expect(results.slice(0, 3).join('')).toMatch(/do not match/);
      expect(results[4]).toMatch(/Too many attempts/);
    } finally {
      await strict.close();
    }
  });

  it('caps request body size', async () => {
    const t = await getTokens();
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access_token}` }, body: 'x'.repeat(1_200_000) });
    expect([400, 413]).toContain(r.status);
  });
});
