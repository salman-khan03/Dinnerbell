/**
 * The Alexa+ simulator: a real OAuth client, a real MCP client (with real
 * elicitation), and a real MCP Apps host — talking to the same Dinner Bell
 * server an actual Alexa+ device would. Nothing here is faked; the only
 * stand-in is the model that decides *which* tool to call from an utterance
 * (`/sim/interpret`, server-side — Bedrock when configured, an offline
 * grammar otherwise), which is exactly the job Alexa+'s own orchestrator
 * does in production.
 *
 * Flow: sign in via this server's own OAuth (PKCE, full page redirect, the
 * same linking flow Alexa+ performs) → connect an MCP client with
 * elicitation → type or speak a line → the interpreter picks a tool → the
 * MCP client calls it → the spoken answer renders as a chat bubble, and if
 * the result carries a `ui://` resource, an `AppBridge` mounts it in a
 * sandboxed iframe exactly as a real host would.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ElicitRequestFormParams, ElicitResult, Tool } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';

// ── tiny render helpers (no framework: this is a small, auditable app) ──
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
};
const root = $('#root');

// ── config from the server (avoids hardcoding the client id/URLs twice) ──
interface SimConfig {
  client_id: string;
  authorize_url: string;
  token_url: string;
  revoke_url: string;
  redirect_uri: string;
  mcp_url: string;
  resource: string;
  orchestrator: 'bedrock' | 'rules';
  model_id: string | null;
}

// ── auth: PKCE authorization-code flow against this server's own /authorize ──
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
const LS_TOKENS = 'dinnerbell.tokens';
const SS_PKCE = 'dinnerbell.pkce'; // { verifier, state } for the in-flight redirect

function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(LS_TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}
function saveTokens(t: Tokens): void {
  try {
    localStorage.setItem(LS_TOKENS, JSON.stringify(t));
  } catch {
    /* private browsing etc.: the session still works, just doesn't persist */
  }
}
function clearTokens(): void {
  try {
    localStorage.removeItem(LS_TOKENS);
  } catch {
    /* ignore */
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randomToken = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

async function beginLogin(cfg: SimConfig): Promise<void> {
  const verifier = randomToken(32);
  const state = randomToken(16);
  sessionStorage.setItem(SS_PKCE, JSON.stringify({ verifier, state }));
  const challenge = await pkceChallenge(verifier);
  const u = new URL(cfg.authorize_url);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.client_id);
  u.searchParams.set('redirect_uri', cfg.redirect_uri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('resource', cfg.resource);
  window.location.href = u.toString();
}

async function completeLoginIfRedirected(cfg: SimConfig): Promise<{ ok: true } | { ok: false; error?: string } | { ok: 'none' }> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return { ok: 'none' };
  const returnedState = params.get('state');
  window.history.replaceState({}, '', window.location.pathname);
  if (params.get('error')) return { ok: false, error: params.get('error_description') ?? params.get('error') ?? undefined };
  let saved: { verifier: string; state: string } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SS_PKCE) ?? 'null');
  } catch {
    /* ignore */
  }
  sessionStorage.removeItem(SS_PKCE);
  if (!saved || saved.state !== returnedState) return { ok: false, error: 'The sign-in response did not match this browser tab. Please try again.' };
  const res = await fetch(cfg.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.client_id,
      code,
      code_verifier: saved.verifier,
      redirect_uri: cfg.redirect_uri,
      resource: cfg.resource,
    }),
  });
  if (!res.ok) return { ok: false, error: 'Sign-in did not complete. Please try again.' };
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  saveTokens({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 });
  return { ok: true };
}

async function refreshTokens(cfg: SimConfig, refresh_token: string): Promise<Tokens | null> {
  const res = await fetch(cfg.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.client_id, refresh_token }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const t: Tokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 };
  saveTokens(t);
  return t;
}

// ── gate screen ──
function renderGate(cfg: SimConfig, error?: string): void {
  root.replaceChildren(
    el(
      'div',
      { class: 'gate' },
      el(
        'div',
        { class: 'gate-card' },
        el('div', { class: 'icon', style: 'margin:0 auto' }, '🔔'),
        el('h1', {}, 'Dinner Bell'),
        el('p', {}, 'A kitchen conductor for Alexa+ — link your account to try it.'),
        ...(error ? [el('div', { class: 'err-box' }, error)] : []),
        el(
          'div',
          { class: 'stack' },
          button('Sign in or create an account', 'primary', () => void beginLogin(cfg)),
          button('Try a demo kitchen — no sign-up', 'ghost', () => void beginLogin(cfg)),
        ),
        el(
          'p',
          { class: 'gate-note' },
          `This opens Dinner Bell's own sign-in page and links your account with OAuth (PKCE) — the same flow Alexa+ uses to link an add-on. Orchestrator: ${cfg.orchestrator === 'bedrock' ? `Amazon Bedrock (${cfg.model_id})` : 'offline rule grammar (set BEDROCK_MODEL_ID for live Bedrock)'}.`,
        ),
      ),
    ),
  );
}
function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}` }, text);
  b.addEventListener('click', onClick);
  return b;
}

// ── the main app ──
interface Turn {
  role: 'user' | 'assistant';
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolResult?: { name: string; spoken: string };
}
interface PlanContext {
  cooks: number;
  ovens: number;
  guests: number;
  dishes: { id: string; name: string }[];
}
interface PlanView {
  dishes: { id: string; name: string }[];
  cooks: number;
  ovens: number;
  guests: number;
}

class SimApp {
  private client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private tools: Tool[] = [];
  private history: Turn[] = [];
  private plan: PlanContext | undefined;
  private bridge: AppBridge | undefined;
  private mountedUri: string | undefined;
  private busy = false;
  private pendingElicit: { resolve: (r: ElicitResult) => void; message: string; schema: ElicitRequestFormParams['requestedSchema'] } | undefined;
  /**
   * A simulated "now", sent as `x-dinner-bell-now` on every MCP request. Real
   * Alexa+ traffic never sends this; the server only honours it when started
   * with DEMO_CLOCK. Without it, a plan for "next Thursday" would sit hours or
   * days away from whatever the real wall clock says, which makes "the turkey
   * needs more time" impossible to demo without literally waiting.
   */
  private clockMs: number | undefined;
  private clockBadge!: HTMLElement;

  constructor(
    private cfg: SimConfig,
    private tokens: Tokens,
  ) {}

  /** Resolves once the app has either started or given up and handed back to the gate. */
  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    this.buildShell();
    this.setStatus('connecting…', false);
    try {
      await this.connect();
    } catch (e) {
      // Most likely a stale token: the token looked unexpired client-side but the
      // server no longer recognises it (restarted, store cleared, revoked elsewhere).
      return { ok: false, error: describeConnectError(e) };
    }
    this.log('sys', `Connected. Say something, or tap a suggestion below.`);
    return { ok: true };
  }

  // ── shell ──
  private els!: { log: HTMLElement; input: HTMLInputElement; send: HTMLButtonElement; screenWrap: HTMLElement; status: HTMLElement };

  private buildShell(): void {
    const status = el('span', { class: 'badge' }, 'connecting…');
    const orchBadge = el(
      'span',
      { class: 'badge' },
      this.cfg.orchestrator === 'bedrock' ? `🧠 Bedrock · ${this.cfg.model_id}` : '🧭 offline grammar',
    );
    const clockBadge = el('span', { class: 'badge', title: 'Simulated time for demos — real Alexa+ traffic never sets this' }, '🕐 real time');
    clockBadge.style.cursor = 'pointer';
    clockBadge.addEventListener('click', () => this.showClockModal());
    this.clockBadge = clockBadge;
    const signOut = el('button', { class: 'icon-btn', title: 'Sign out' }, '⎋');
    signOut.addEventListener('click', () => this.signOut());

    const log = el('div', { class: 'log' });
    const input = el('input', { placeholder: 'Say something… e.g. "plan Thanksgiving for 10 at 5"' }) as HTMLInputElement;
    const send = el('button', { class: 'mic', title: 'Send' }, '➤');
    const form = el('form', { class: 'composer' }, input, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      void this.say(text);
    });

    const suggest = el('div', { class: 'suggest' });
    for (const s of ['plan Thanksgiving dinner for 10 at 5', "what's next?", 'the turkey is in the oven', 'the gravy needs ten more minutes', 'push dinner to 6', 'show me the timeline']) {
      const c = el('button', { class: 'chip' }, s);
      c.addEventListener('click', () => void this.say(s));
      suggest.append(c);
    }

    const screenWrap = el('div', { class: 'screen-frame-wrap' });
    const screen = el(
      'div',
      { class: 'screen' },
      el('div', { class: 'placeholder' }, el('div', {}, el('b', {}, 'No screen yet'), 'Plan a meal and the timeline will appear here — the same MCP App a screen-equipped Alexa+ device would render.')),
    );
    this.screenEl = screen;
    this.screenWrapEl = screenWrap;

    const convo = el('div', { class: 'convo' }, log, suggest, form);
    const layout = el('div', { class: 'layout' }, convo, screen);
    const header = el(
      'header',
      { class: 'top' },
      el('div', { class: 'brand' }, el('div', { class: 'icon' }, '🔔'), 'Dinner Bell'),
      status,
      orchBadge,
      clockBadge,
      el('div', { class: 'spacer' }),
      signOut,
    );
    root.replaceChildren(el('div', { class: 'shell' }, header, layout));
    this.els = { log, input, send, screenWrap, status };
  }
  private screenEl!: HTMLElement;
  private screenWrapEl!: HTMLElement;

  private setStatus(text: string, live: boolean): void {
    this.els.status.textContent = live ? 'live' : text;
    this.els.status.className = `badge${live ? ' live' : ''}`;
  }

  private log(kind: 'me' | 'bell' | 'sys' | 'err', text: string, tag?: string): HTMLElement {
    const bubble = el('div', { class: `msg ${kind}` }, ...(tag ? [el('span', { class: 'call-tag' }, tag)] : []), text);
    this.els.log.append(bubble);
    this.els.log.scrollTop = this.els.log.scrollHeight;
    return bubble;
  }

  private typing(): () => void {
    const t = el('div', { class: 'typing' }, el('i', {}), el('i', {}), el('i', {}));
    this.els.log.append(t);
    this.els.log.scrollTop = this.els.log.scrollHeight;
    return () => t.remove();
  }

  private signOut(): void {
    void fetch(this.cfg.revoke_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: this.tokens.access_token }) }).catch(() => {});
    clearTokens();
    window.location.reload();
  }

  // ── simulated clock, for demos: fast-forward "now" instead of waiting for real Thursday ──
  private setClock(ms: number | undefined): void {
    this.clockMs = ms;
    this.clockBadge.textContent = ms === undefined ? '🕐 real time' : `🕐 ${new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }

  /** Wall-clock time in `tz` -> epoch ms (mirrors `zonedToMin` in src/engine/time.ts). */
  private static zonedToMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const parts = (ms: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
      return out;
    };
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ms = guess;
    for (let i = 0; i < 2; i++) {
      const p = parts(ms);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
      ms -= asUtc - guess;
    }
    return ms;
  }

  /**
   * The next upcoming U.S. Thanksgiving (4th Thursday of November) at
   * `hour:minute` in the household's default time zone (America/New_York) —
   * matching exactly what the server resolves "Thanksgiving" to
   * (`thanksgiving()` in src/engine/time.ts). A generic "next Thursday"
   * preset would drift arbitrarily far from the plan the demo utterance
   * actually creates, since "plan Thanksgiving for 10 at 5" asks for the
   * holiday, not just any Thursday.
   */
  private static nextThanksgivingAt(hour: number, minute = 0): number {
    const TZ = 'America/New_York';
    const thanksgivingMs = (year: number): number => {
      const first = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0=Sun
      const firstThu = 1 + ((4 - first + 7) % 7);
      return SimApp.zonedToMs(year, 11, firstThu + 21, hour, minute, TZ);
    };
    const year = new Date().getFullYear();
    let ms = thanksgivingMs(year);
    if (ms <= Date.now()) ms = thanksgivingMs(year + 1);
    return ms;
  }

  private showClockModal(): void {
    const presets: [string, number | undefined][] = [
      ['Real time', undefined],
      ['Thanksgiving morning, 9 AM', SimApp.nextThanksgivingAt(9)],
      ["Midday — turkey's in, 1 PM", SimApp.nextThanksgivingAt(13)],
      ['Crunch time, 4:30 PM', SimApp.nextThanksgivingAt(16, 30)],
    ];
    const toLocalInputValue = (ms: number): string => {
      const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
      return d.toISOString().slice(0, 16);
    };
    const manual = el('input', { type: 'datetime-local', value: toLocalInputValue(this.clockMs ?? Date.now()) }) as HTMLInputElement;
    const applyManual = el('button', { type: 'button', class: 'btn primary' }, 'Set');
    applyManual.addEventListener('click', () => {
      const t = new Date(manual.value).getTime();
      if (Number.isFinite(t)) {
        this.setClock(t);
        close();
      }
    });
    const chips = presets.map(([label, ms]) => {
      const b = el('button', { type: 'button', class: 'chip' }, label);
      b.style.display = 'block';
      b.style.width = '100%';
      b.style.marginBottom = '6px';
      b.addEventListener('click', () => {
        this.setClock(ms);
        close();
      });
      return b;
    });
    const cancel = el('button', { type: 'button', class: 'btn ghost' }, 'Close');
    const modal = el(
      'div',
      { class: 'modal' },
      el('h3', {}, 'Simulated time'),
      el('p', { class: 'sub' }, 'Fast-forward the kitchen clock so a plan for later this week plays out right now. Real Alexa+ traffic never does this.'),
      ...chips,
      el('div', { class: 'field' }, el('label', {}, 'Or pick a moment'), manual),
      el('div', { class: 'modal-actions' }, cancel, applyManual),
    );
    const backdrop = el('div', { class: 'modal-backdrop' }, modal);
    const close = () => backdrop.remove();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    document.body.append(backdrop);
  }

  // ── MCP connection ──
  private authedFetch: typeof fetch = async (input, init) => {
    if (this.tokens.expires_at < Date.now() + 30_000) {
      const fresh = await refreshTokens(this.cfg, this.tokens.refresh_token);
      if (fresh) this.tokens = fresh;
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${this.tokens.access_token}`);
    if (this.clockMs !== undefined) headers.set('x-dinner-bell-now', String(this.clockMs));
    return fetch(input, { ...init, headers });
  };

  private async connect(): Promise<void> {
    this.client = new Client({ name: 'dinner-bell-simulator', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    this.client.setRequestHandler('elicitation/create', (req) => this.handleElicit(req.params as ElicitRequestFormParams));
    this.transport = new StreamableHTTPClientTransport(new URL(this.cfg.mcp_url), { fetch: this.authedFetch });
    await this.client.connect(this.transport);
    const { tools } = await this.client.listTools();
    this.tools = tools;
    this.setStatus('live', true);
  }

  // ── elicitation: a real flat-schema form, rendered as a modal ──
  private handleElicit(params: ElicitRequestFormParams): Promise<ElicitResult> {
    return new Promise((resolve) => {
      this.pendingElicit = { resolve, message: params.message, schema: params.requestedSchema };
      this.showElicitModal(params);
    });
  }

  private showElicitModal(params: ElicitRequestFormParams): void {
    const schema = params.requestedSchema;
    const props = Object.entries(schema.properties ?? {}) as [string, Record<string, unknown>][];
    const required = new Set(schema.required ?? []);
    const inputs: Record<string, HTMLInputElement | HTMLSelectElement | { yes: HTMLButtonElement; no: HTMLButtonElement; value: boolean }> = {};

    const fields = props.map(([key, spec]) => {
      const title = String(spec.title ?? key);
      const type = String(spec.type ?? 'string');
      const label = el('label', {}, title);
      if (type === 'boolean') {
        const dflt = spec.default === true;
        const yes = el('button', { type: 'button', class: `on-${dflt}` }, 'Yes');
        const no = el('button', { type: 'button' }, 'No');
        const state = { yes, no, value: dflt };
        const paint = () => {
          yes.classList.toggle('on', state.value);
          no.classList.toggle('on', !state.value);
        };
        yes.addEventListener('click', () => {
          state.value = true;
          paint();
        });
        no.addEventListener('click', () => {
          state.value = false;
          paint();
        });
        paint();
        inputs[key] = state;
        return el('div', { class: 'field' }, label, el('div', { class: 'toggle' }, yes, no));
      }
      if (Array.isArray(spec.enum)) {
        const select = el('select', {}) as HTMLSelectElement;
        for (const opt of spec.enum as string[]) select.append(el('option', { value: opt }, opt));
        if (typeof spec.default === 'string') select.value = spec.default;
        inputs[key] = select;
        return el('div', { class: 'field' }, label, select);
      }
      const input = el('input', {
        type: type === 'number' || type === 'integer' ? 'number' : 'text',
        ...(typeof spec.minimum === 'number' ? { min: String(spec.minimum) } : {}),
        ...(typeof spec.maximum === 'number' ? { max: String(spec.maximum) } : {}),
        ...(spec.default !== undefined ? { value: String(spec.default) } : {}),
        placeholder: String(spec.description ?? ''),
      }) as HTMLInputElement;
      inputs[key] = input;
      return el('div', { class: 'field' }, label, input);
    });

    const cancel = el('button', { type: 'button', class: 'btn ghost' }, 'Not now');
    const submit = el('button', { type: 'submit', class: 'btn primary' }, 'Continue');
    const form = el(
      'form',
      { class: 'modal' },
      el('h3', {}, 'Dinner Bell needs one more thing'),
      el('p', { class: 'sub' }, params.message),
      ...fields,
      el('div', { class: 'modal-actions' }, cancel, submit),
    );
    const backdrop = el('div', { class: 'modal-backdrop' }, form);
    document.body.append(backdrop);
    (fields[0]?.querySelector('input,select') as HTMLElement | null)?.focus();

    const finish = (result: ElicitResult): void => {
      backdrop.remove();
      const p = this.pendingElicit;
      this.pendingElicit = undefined;
      p?.resolve(result);
    };
    cancel.addEventListener('click', () => finish({ action: 'decline' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const content: Record<string, string | number | boolean> = {};
      for (const [key, spec] of props) {
        const box = inputs[key];
        if ('value' in box && typeof box.value === 'boolean') content[key] = box.value;
        else {
          const raw = (box as HTMLInputElement | HTMLSelectElement).value;
          if (raw === '' && !required.has(key)) continue;
          content[key] = spec.type === 'number' || spec.type === 'integer' ? Number(raw) : raw;
        }
      }
      finish({ action: 'accept', content });
    });
  }

  // ── one utterance ──
  private async say(utterance: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.els.send.disabled = true;
    this.log('me', utterance);
    const stopTyping = this.typing();
    try {
      const toolsForInterpreter = this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      const res = await fetch('/sim/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ utterance, plan: this.plan, history: this.history.slice(-8), tools: toolsForInterpreter }),
      });
      if (!res.ok) {
        stopTyping();
        this.log('err', `Sorry, something went wrong on my end (${res.status}).`);
        return;
      }
      const decision = (await res.json()) as { call?: { name: string; args: Record<string, unknown> }; say?: string };
      this.history.push({ role: 'user', text: utterance });

      if (decision.call) {
        const result = await this.client.callTool({ name: decision.call.name, arguments: decision.call.args });
        stopTyping();
        const spoken = firstText(result) || '(no response)';
        this.log('bell', spoken, decision.call.name);
        this.history.push({ role: 'assistant', toolCall: decision.call, toolResult: { name: decision.call.name, spoken } });
        await this.handleResult(decision.call.name, decision.call.args, result);
      } else {
        stopTyping();
        this.log('bell', decision.say ?? `I'm not sure how to help with that.`);
        this.history.push({ role: 'assistant', text: decision.say });
      }
    } catch (e) {
      stopTyping();
      this.log('err', `Connection hiccup: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      this.els.send.disabled = false;
      this.els.input.focus();
    }
  }

  private async handleResult(toolName: string, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    const structured = result.structuredContent as { plan?: PlanView } | undefined;
    if (structured?.plan) {
      this.plan = { cooks: structured.plan.cooks, ovens: structured.plan.ovens, guests: structured.plan.guests, dishes: structured.plan.dishes };
    }
    const tool = this.tools.find((t) => t.name === toolName);
    const uiUri = tool ? getToolUiResourceUri(tool) : undefined;
    if (!uiUri) return;
    await this.showApp(uiUri, args, result);
  }

  // ── MCP Apps host: mount the real UI resource in a sandboxed iframe ──
  private async showApp(uiUri: string, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    if (this.mountedUri !== uiUri || !this.bridge) await this.mountApp(uiUri);
    if (!this.bridge) return;
    try {
      await this.bridge.sendToolInput({ arguments: args });
      await this.bridge.sendToolResult(result as never);
    } catch (e) {
      console.error('MCP App update failed', e);
    }
  }

  private async mountApp(uiUri: string): Promise<void> {
    this.bridge?.close().catch(() => {});
    this.mountedUri = uiUri;
    const iframe = el('iframe', { sandbox: 'allow-scripts', title: 'Dinner Bell timeline' }) as HTMLIFrameElement;
    // Mount into the live document first: contentWindow only exists once the
    // <iframe> is actually attached, and we need it before we can connect.
    this.screenWrapEl.replaceChildren(iframe);
    this.screenEl.replaceChildren(this.screenWrapEl);
    const win = iframe.contentWindow;
    if (!win) throw new Error('The timeline view could not be created (no iframe window).');

    const bridge = new AppBridge(this.client, { name: 'Dinner Bell Simulator', version: '1.0.0' }, { openLinks: {}, serverTools: {}, logging: {} });
    this.bridge = bridge;
    // The view's App.connect() handshake (ui/initialize -> ui/notifications/initialized)
    // is asynchronous, so `sendToolInput`/`sendToolResult` are only safe to call from
    // inside `oninitialized` — calling them right after setting `srcdoc` would race the
    // view's own startup and the notifications would arrive before anything is listening.
    const ready = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });
    // Connect the host transport BEFORE loading the view's script, so its initial
    // `ui/initialize` handshake is never sent into an empty room.
    await bridge.connect(new PostMessageTransport(win, win));
    const { contents } = await this.client.readResource({ uri: uiUri });
    const html = (contents[0] as { text?: string }).text ?? '<!doctype html><body>Could not load the view.</body>';
    iframe.srcdoc = html;
    const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('The timeline view did not start in time.')), 15000));
    await Promise.race([ready, timeout]);
  }
}

function firstText(result: CallToolResult): string {
  for (const c of result.content ?? []) if (c.type === 'text') return c.text;
  return '';
}

function describeConnectError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthor/i.test(msg)) return 'Your sign-in is no longer valid (the server may have restarted). Please sign in again.';
  return `Could not connect to Dinner Bell: ${msg}`;
}

// ── boot ──
async function main(): Promise<void> {
  const cfg = (await (await fetch('/sim/config')).json()) as SimConfig;
  const redirected = await completeLoginIfRedirected(cfg);
  if (redirected.ok === false) return renderGate(cfg, redirected.error ?? 'Sign-in was cancelled.');

  let tokens = loadTokens();
  if (!tokens) return renderGate(cfg);
  if (tokens.expires_at < Date.now()) {
    const fresh = await refreshTokens(cfg, tokens.refresh_token);
    if (!fresh) {
      clearTokens();
      return renderGate(cfg, 'Your session expired. Please sign in again.');
    }
    tokens = fresh;
  }
  const result = await new SimApp(cfg, tokens).start();
  if (!result.ok) {
    clearTokens();
    renderGate(cfg, result.error);
  }
}

void main();
