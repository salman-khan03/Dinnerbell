/**
 * Persistence: households, meal plans, and OAuth state.
 *
 * `Store` itself is a synchronous, in-memory cache — every read is a plain
 * object lookup, no `await` anywhere in the request path, which matters
 * because report_progress has to replan and answer inside a single voice
 * turn. A `Backend` supplies the actual durability underneath it: `PgBackend`
 * (Postgres, for anywhere with an ephemeral filesystem — most free-tier
 * hosts) or `FileBackend` (a JSON file with atomic writes, dependency-free,
 * fine for a single always-on box). Writes go to the backend write-behind,
 * one call per changed entity, never blocking the response.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { DishDef, Kitchen, PlanInput, Progress, Schedule } from '../engine/types.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Household {
  id: string;
  name: string;
  tz: string;
  kitchen: Kitchen;
  /** Set once the kitchen has been described, so we never ask twice. */
  kitchenKnown: boolean;
  custom: DishDef[];
  /** Ids (within `custom`) the household has published to the public dish gallery. */
  publishedDishIds: string[];
  /** True for a "try it now" session with no real account behind it (see webapp.ts guest mode). */
  guest?: boolean;
  createdAt: number;
}

export interface User {
  id: string;
  username: string;
  salt: string;
  hash: string;
  householdId: string;
}

export interface PlanRecord {
  id: string;
  householdId: string;
  input: PlanInput;
  progress: Progress;
  /** The plan as last shown to the cook; used to say what changed. */
  baseline?: Schedule;
  log: { at: number; text: string }[];
  status: 'active' | 'ended';
  createdAt: number;
  updatedAt: number;
  /** Set once the household shares this plan; the slug is the public, unguessable /p/:slug id. */
  shareSlug?: string;
  sharedAt?: number;
}

export interface Session {
  token: string;
  userId: string;
  householdId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  householdId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  expiresAt: number;
}

export interface TokenRecord {
  accessHash: string;
  refreshHash: string;
  clientId: string;
  userId: string;
  householdId: string;
  scope: string;
  resource?: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

interface Data {
  households: Record<string, Household>;
  users: Record<string, User>;
  plans: Record<string, PlanRecord>;
  tokens: TokenRecord[];
  sessions: Record<string, Session>;
}

const empty = (): Data => ({ households: {}, users: {}, plans: {}, tokens: [], sessions: {} });

const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days
export const GUEST_TTL_MS = 24 * 3600_000;
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l — unambiguous in a shared link

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const newSecret = (): string => randomBytes(32).toString('base64url');

export const DEFAULT_KITCHEN: Kitchen = { ovens: 1, burners: 4, cooks: 1, extras: {} };

// ───────────────────────────── the backend contract ─────────────────────────────

/**
 * Everything a durability backend has to do. Every method here is the
 * write-behind side of one `Store` mutation — called after the in-memory
 * object already reflects the change, never awaited by the caller.
 */
export interface Backend {
  load(): Promise<Partial<Data>>;
  saveHousehold(h: Household): void;
  saveUser(u: User): void;
  savePlan(p: PlanRecord): void;
  saveToken(t: TokenRecord): void;
  deleteToken(accessHash: string): void;
  saveSession(s: Session): void;
  deleteSession(token: string): void;
  /** Remove a household and every user, plan and session under it. */
  deleteHousehold(id: string): void;
  /** Resolves once every write issued so far has landed. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** No persistence at all — the default for tests. */
class MemoryBackend implements Backend {
  async load(): Promise<Partial<Data>> {
    return {};
  }
  saveHousehold(): void {}
  saveUser(): void {}
  savePlan(): void {}
  saveToken(): void {}
  deleteToken(): void {}
  saveSession(): void {}
  deleteSession(): void {}
  deleteHousehold(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * A JSON file with atomic writes: dependency-free, correct, fine for a
 * single always-on process with a real disk. Wrong choice on a host that
 * wipes the filesystem between deploys — see `PgBackend` for that case. Since
 * every mutation touches the same file, this backend just re-dumps the whole
 * snapshot on each call rather than tracking per-entity diffs.
 */
class FileBackend implements Backend {
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private file: string,
    private snapshot: () => Data,
  ) {}

  async load(): Promise<Partial<Data>> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  private writeBehind(): void {
    const file = this.file;
    const body = JSON.stringify(this.snapshot());
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('store(file): write failed', e));
  }

  saveHousehold = (): void => this.writeBehind();
  saveUser = (): void => this.writeBehind();
  savePlan = (): void => this.writeBehind();
  saveToken = (): void => this.writeBehind();
  deleteToken = (): void => this.writeBehind();
  saveSession = (): void => this.writeBehind();
  deleteSession = (): void => this.writeBehind();
  deleteHousehold = (): void => this.writeBehind();
  flush(): Promise<void> {
    return this.writing;
  }
  async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * Postgres, one JSONB column per entity plus the few columns worth indexing
 * (username, share_slug, household_id) — a document store riding on top of a
 * real relational database rather than a fully normalized schema. That
 * trade-off keeps this file the only thing that changed to add Postgres:
 * every other module still sees the same synchronous `Store`. A normalized
 * schema would be the natural next step if this ever needs relational
 * queries Postgres itself can't do through the JSONB index.
 */
class PgBackend implements Backend {
  private pool: Pool;
  /**
   * Writes run one at a time, in the order they were issued. Firing them in
   * parallel across the pool would let two quick saves of the same plan commit
   * out of order and leave the older version on disk.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(connectionString: string) {
    // Neon (and most managed Postgres) issue properly-trusted certs, so this stays verified —
    // only the `require` mode is forced explicitly for hosts that need SSL but don't say so in the URL.
    this.pool = new Pool({ connectionString, max: 5, ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined });
  }

  /** `work` must capture its parameters eagerly (see `sql`): the objects it saves keep mutating. */
  private queue(work: () => Promise<unknown>): void {
    this.chain = this.chain.then(work).then(
      () => {},
      (e) => console.error('store(pg): write failed', e),
    );
  }

  private sql(text: string, params: unknown[]): void {
    this.queue(() => this.pool.query(text, params));
  }

  async load(): Promise<Partial<Data>> {
    const [households, users, plans, tokens, sessions] = await Promise.all([
      this.pool.query<{ data: Household }>('SELECT data FROM households'),
      this.pool.query<{ data: User }>('SELECT data FROM users'),
      this.pool.query<{ data: PlanRecord }>('SELECT data FROM plans'),
      this.pool.query<{ data: TokenRecord }>('SELECT data FROM tokens WHERE refresh_expires_at > $1', [Date.now()]),
      this.pool.query<{ data: Session }>('SELECT data FROM sessions WHERE expires_at > $1', [Date.now()]),
    ]);
    return {
      households: Object.fromEntries(households.rows.map((r) => [r.data.id, r.data])),
      users: Object.fromEntries(users.rows.map((r) => [r.data.id, r.data])),
      plans: Object.fromEntries(plans.rows.map((r) => [r.data.id, r.data])),
      tokens: tokens.rows.map((r) => r.data),
      sessions: Object.fromEntries(sessions.rows.map((r) => [r.data.token, r.data])),
    };
  }

  saveHousehold(h: Household): void {
    this.sql('INSERT INTO households (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [h.id, JSON.stringify(h)]);
  }
  saveUser(u: User): void {
    this.sql('INSERT INTO users (id, username, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET username = $2, data = $3', [u.id, u.username, JSON.stringify(u)]);
  }
  savePlan(p: PlanRecord): void {
    this.sql(
      `INSERT INTO plans (id, household_id, share_slug, status, updated_at, data) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET household_id = $2, share_slug = $3, status = $4, updated_at = $5, data = $6`,
      [p.id, p.householdId, p.shareSlug ?? null, p.status, p.updatedAt, JSON.stringify(p)],
    );
  }
  saveToken(t: TokenRecord): void {
    this.sql(
      `INSERT INTO tokens (access_hash, refresh_hash, refresh_expires_at, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (access_hash) DO UPDATE SET refresh_hash = $2, refresh_expires_at = $3, data = $4`,
      [t.accessHash, t.refreshHash, t.refreshExpiresAt, JSON.stringify(t)],
    );
  }
  deleteToken(accessHash: string): void {
    this.sql('DELETE FROM tokens WHERE access_hash = $1', [accessHash]);
  }
  saveSession(s: Session): void {
    this.sql('INSERT INTO sessions (token, expires_at, data) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET expires_at = $2, data = $3', [s.token, s.expiresAt, JSON.stringify(s)]);
  }
  deleteSession(token: string): void {
    this.sql('DELETE FROM sessions WHERE token = $1', [token]);
  }
  deleteHousehold(id: string): void {
    this.queue(async () => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("DELETE FROM sessions WHERE data->>'householdId' = $1", [id]);
          await client.query('DELETE FROM plans WHERE household_id = $1', [id]);
          await client.query("DELETE FROM users WHERE data->>'householdId' = $1", [id]);
          await client.query('DELETE FROM households WHERE id = $1', [id]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
    });
  }
  flush(): Promise<void> {
    return this.chain;
  }
  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}

// ───────────────────────────── the store ─────────────────────────────

export class Store {
  private data: Data = empty();
  /** Authorization codes are short-lived and never persisted. */
  readonly codes = new Map<string, AuthCode>();

  private constructor(private backend: Backend) {}

  /**
   * `target`: a `postgres://`/`postgresql://` URL for Postgres, a file path
   * for the JSON-file backend, or omitted for a pure in-memory store (tests).
   */
  static async open(target?: string): Promise<Store> {
    const backend = !target ? new MemoryBackend() : /^postgres(ql)?:\/\//.test(target) ? new PgBackend(target) : new FileBackend(target, () => store.data);
    const store = new Store(backend);
    const loaded = await backend.load();
    store.data = { ...empty(), ...loaded };
    for (const h of Object.values(store.data.households)) if (!h.publishedDishIds) h.publishedDishIds = []; // pre-gallery households
    return store;
  }

  /** Resolves once every write issued so far has landed (tests, graceful shutdown). */
  flush(): Promise<void> {
    return this.backend.flush();
  }
  close(): Promise<void> {
    return this.backend.close();
  }

  // ── households ──
  household(id: string): Household | undefined {
    return this.data.households[id];
  }

  ensureHousehold(id: string, name = 'My kitchen', tz = 'America/New_York'): Household {
    let h = this.data.households[id];
    if (!h) {
      h = { id, name, tz, kitchen: { ...DEFAULT_KITCHEN }, kitchenKnown: false, custom: [], publishedDishIds: [], createdAt: Date.now() };
      this.data.households[id] = h;
      this.backend.saveHousehold(h);
    }
    return h;
  }

  allHouseholds(): Household[] {
    return Object.values(this.data.households);
  }

  saveHousehold(h: Household): void {
    this.data.households[h.id] = h;
    this.backend.saveHousehold(h);
  }

  /** Remove a household and every user, plan and session under it. */
  deleteHousehold(id: string): void {
    delete this.data.households[id];
    for (const [uid, u] of Object.entries(this.data.users)) if (u.householdId === id) delete this.data.users[uid];
    for (const [pid, p] of Object.entries(this.data.plans)) if (p.householdId === id) delete this.data.plans[pid];
    for (const [tok, s] of Object.entries(this.data.sessions)) if (s.householdId === id) delete this.data.sessions[tok];
    this.backend.deleteHousehold(id);
  }

  // ── users ──
  private credentialsError(name: string, password: string): string | undefined {
    if (!/^[a-z0-9._-]{3,32}$/.test(name)) return 'Choose a username of 3 to 32 letters, numbers, dots or dashes.';
    if (name.startsWith('guest-')) return 'Usernames starting with "guest-" are reserved.';
    if (password.length < 8) return 'Use a password of at least 8 characters.';
    if (Object.values(this.data.users).some((u) => u.username === name)) return 'That username is taken.';
    return undefined;
  }

  async createUser(username: string, password: string, tz: string): Promise<User | { error: string }> {
    const name = username.trim().toLowerCase();
    const error = this.credentialsError(name, password);
    if (error) return { error };
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    const household = this.ensureHousehold(newId('hh'), `${username.trim()}'s kitchen`, tz);
    const user: User = { id: newId('usr'), username: name, salt: salt.toString('hex'), hash: hash.toString('hex'), householdId: household.id };
    this.data.users[user.id] = user;
    this.backend.saveUser(user);
    return user;
  }

  /** A throwaway account for "try it now": no password anyone knows, swept after GUEST_TTL_MS unless claimed. */
  createGuest(tz: string): User {
    const household = this.ensureHousehold(newId('hh'), 'Guest kitchen', tz);
    household.guest = true;
    this.saveHousehold(household);
    const user: User = { id: newId('usr'), username: `guest-${randomBytes(4).toString('hex')}`, salt: '', hash: '', householdId: household.id };
    this.data.users[user.id] = user;
    this.backend.saveUser(user);
    return user;
  }

  /** Turn a guest into a real account in place, keeping its plan and dishes. */
  async claimGuest(userId: string, username: string, password: string): Promise<User | { error: string }> {
    const user = this.data.users[userId];
    const household = user && this.data.households[user.householdId];
    if (!user || !household?.guest) return { error: 'This account is already registered.' };
    const name = username.trim().toLowerCase();
    const error = this.credentialsError(name, password);
    if (error) return { error };
    const salt = randomBytes(16);
    user.username = name;
    user.salt = salt.toString('hex');
    user.hash = (await scrypt(password, salt, 32)).toString('hex');
    household.guest = false;
    household.name = `${username.trim()}'s kitchen`;
    this.saveHousehold(household);
    this.backend.saveUser(user);
    return user;
  }

  /** Delete every unclaimed guest household older than `maxAgeMs`. Returns how many went. */
  sweepGuests(maxAgeMs = GUEST_TTL_MS, now = Date.now()): number {
    const stale = this.allHouseholds().filter((h) => h.guest && h.createdAt < now - maxAgeMs);
    for (const h of stale) this.deleteHousehold(h.id);
    return stale.length;
  }

  async verifyUser(username: string, password: string): Promise<User | null> {
    const name = username.trim().toLowerCase();
    const found = Object.values(this.data.users).find((u) => u.username === name);
    const user = found?.hash ? found : undefined; // guests have no password and can never log in
    // Always do the hashing work, so timing does not reveal whether a username exists.
    const salt = Buffer.from(user?.salt ?? '00'.repeat(16), 'hex');
    const given = await scrypt(password, salt, 32);
    if (!user) return null;
    const want = Buffer.from(user.hash, 'hex');
    return want.length === given.length && timingSafeEqual(want, given) ? user : null;
  }

  user(id: string): User | undefined {
    return this.data.users[id];
  }

  // ── plans ──
  activePlan(householdId: string): PlanRecord | undefined {
    return Object.values(this.data.plans)
      .filter((p) => p.householdId === householdId && p.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /**
   * `silent` persists without notifying subscribers — for bookkeeping writes
   * (e.g. whats_next recording what the cook last saw) that a reader's own
   * refetch would otherwise trigger, looping forever.
   */
  savePlan(p: PlanRecord, opts: { silent?: boolean } = {}): void {
    p.updatedAt = Date.now();
    this.data.plans[p.id] = p;
    this.backend.savePlan(p);
    if (!opts.silent) for (const fn of this.planListeners) fn(p);
  }

  private planListeners = new Set<(p: PlanRecord) => void>();
  /** Called after every meaningful plan change; returns an unsubscribe function. */
  onPlanChange(fn: (p: PlanRecord) => void): () => void {
    this.planListeners.add(fn);
    return () => this.planListeners.delete(fn);
  }

  plansFor(householdId: string): PlanRecord[] {
    return Object.values(this.data.plans).filter((p) => p.householdId === householdId);
  }

  // ── tokens ──
  saveToken(t: TokenRecord): void {
    const now = Date.now();
    this.data.tokens = this.data.tokens.filter((x) => x.refreshExpiresAt > now);
    this.data.tokens.push(t);
    this.backend.saveToken(t);
  }

  findAccess(accessHash: string): TokenRecord | undefined {
    return this.data.tokens.find((t) => t.accessHash === accessHash);
  }

  findRefresh(refreshHash: string): TokenRecord | undefined {
    return this.data.tokens.find((t) => t.refreshHash === refreshHash);
  }

  revoke(hash: string): boolean {
    const before = this.data.tokens.length;
    const hit = this.data.tokens.find((t) => t.accessHash === hash || t.refreshHash === hash);
    this.data.tokens = this.data.tokens.filter((t) => t.accessHash !== hash && t.refreshHash !== hash);
    if (hit) this.backend.deleteToken(hit.accessHash);
    return this.data.tokens.length !== before;
  }

  removeToken(t: TokenRecord): void {
    this.data.tokens = this.data.tokens.filter((x) => x !== t);
    this.backend.deleteToken(t.accessHash);
  }

  // ── first-party web sessions (cookie-based, separate from the OAuth/PKCE flow above,
  // which exists for third-party MCP clients like Alexa+ linking in — the web app is
  // first-party, so it authenticates itself directly rather than round-tripping OAuth) ──
  createSession(userId: string, householdId: string, ttlMs = SESSION_TTL_MS): Session {
    const now = Date.now();
    const session: Session = { token: newSecret(), userId, householdId, createdAt: now, expiresAt: now + ttlMs };
    this.data.sessions[session.token] = session;
    this.backend.saveSession(session);
    return session;
  }

  session(token: string): Session | undefined {
    const s = this.data.sessions[token];
    if (s && s.expiresAt < Date.now()) {
      delete this.data.sessions[token];
      this.backend.deleteSession(token);
      return undefined;
    }
    return s;
  }

  destroySession(token: string): void {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.backend.deleteSession(token);
    }
  }

  // ── the public dish gallery ──
  publishDish(householdId: string, dishId: string): boolean {
    const h = this.household(householdId);
    if (!h || !h.custom.some((d) => d.id === dishId)) return false;
    if (!h.publishedDishIds.includes(dishId)) h.publishedDishIds.push(dishId);
    this.saveHousehold(h);
    return true;
  }

  unpublishDish(householdId: string, dishId: string): void {
    const h = this.household(householdId);
    if (!h) return;
    h.publishedDishIds = h.publishedDishIds.filter((id) => id !== dishId);
    this.saveHousehold(h);
  }

  /** Every published dish across every household, newest first, with a public author label. */
  publicDishes(): { dish: DishDef; authorName: string; householdId: string }[] {
    const out: { dish: DishDef; authorName: string; householdId: string }[] = [];
    for (const h of this.allHouseholds()) {
      for (const id of h.publishedDishIds) {
        const dish = h.custom.find((d) => d.id === id);
        if (dish) out.push({ dish, authorName: h.name, householdId: h.id });
      }
    }
    return out.reverse();
  }

  // ── sharing a plan by link ──
  private uniqueSlug(): string {
    let slug: string;
    do {
      slug = Array.from({ length: 8 }, () => SLUG_ALPHABET[randomBytes(1)[0] % SLUG_ALPHABET.length]).join('');
    } while (this.planBySlug(slug));
    return slug;
  }

  sharePlan(p: PlanRecord): string {
    if (!p.shareSlug) {
      p.shareSlug = this.uniqueSlug();
      p.sharedAt = Date.now();
    }
    this.savePlan(p);
    return p.shareSlug;
  }

  unsharePlan(p: PlanRecord): void {
    p.shareSlug = undefined;
    p.sharedAt = undefined;
    this.savePlan(p);
  }

  planBySlug(slug: string): PlanRecord | undefined {
    return Object.values(this.data.plans).find((p) => p.shareSlug === slug);
  }
}
