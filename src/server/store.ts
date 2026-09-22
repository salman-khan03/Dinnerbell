/**
 * Persistence: households, meal plans, and OAuth state.
 *
 * A JSON file with atomic writes keeps the whole project dependency-free and
 * deployable anywhere with a disk; the class is the only thing that touches
 * storage, so swapping in DynamoDB or Postgres is one file. Passing no path
 * gives a pure in-memory store for tests.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
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
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/i/l — unambiguous in a shared link

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const newSecret = (): string => randomBytes(32).toString('base64url');

export const DEFAULT_KITCHEN: Kitchen = { ovens: 1, burners: 4, cooks: 1, extras: {} };

export class Store {
  private data: Data = empty();
  /** Authorization codes are short-lived and never persisted. */
  readonly codes = new Map<string, AuthCode>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private file?: string) {}

  static async open(file?: string): Promise<Store> {
    const s = new Store(file);
    if (file) {
      try {
        s.data = { ...empty(), ...(JSON.parse(await fs.readFile(file, 'utf8')) as Data) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return s;
  }

  /** Serialised, atomic write-behind. */
  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('store: write failed', e));
  }

  /** Resolves once queued writes have landed (used by tests and graceful shutdown). */
  flush(): Promise<void> {
    return this.writing;
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
      this.persist();
    } else if (!h.publishedDishIds) {
      h.publishedDishIds = []; // migrating a household saved before this field existed
    }
    return h;
  }

  allHouseholds(): Household[] {
    return Object.values(this.data.households);
  }

  saveHousehold(h: Household): void {
    this.data.households[h.id] = h;
    this.persist();
  }

  // ── users ──
  async createUser(username: string, password: string, tz: string): Promise<User | { error: string }> {
    const name = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(name)) return { error: 'Choose a username of 3 to 32 letters, numbers, dots or dashes.' };
    if (password.length < 8) return { error: 'Use a password of at least 8 characters.' };
    if (Object.values(this.data.users).some((u) => u.username === name)) return { error: 'That username is taken.' };
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32);
    const household = this.ensureHousehold(newId('hh'), `${username.trim()}'s kitchen`, tz);
    const user: User = { id: newId('usr'), username: name, salt: salt.toString('hex'), hash: hash.toString('hex'), householdId: household.id };
    this.data.users[user.id] = user;
    this.persist();
    return user;
  }

  async verifyUser(username: string, password: string): Promise<User | null> {
    const name = username.trim().toLowerCase();
    const user = Object.values(this.data.users).find((u) => u.username === name);
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

  savePlan(p: PlanRecord): void {
    p.updatedAt = Date.now();
    this.data.plans[p.id] = p;
    this.persist();
  }

  plansFor(householdId: string): PlanRecord[] {
    return Object.values(this.data.plans).filter((p) => p.householdId === householdId);
  }

  // ── tokens ──
  saveToken(t: TokenRecord): void {
    const now = Date.now();
    this.data.tokens = this.data.tokens.filter((x) => x.refreshExpiresAt > now);
    this.data.tokens.push(t);
    this.persist();
  }

  findAccess(accessHash: string): TokenRecord | undefined {
    return this.data.tokens.find((t) => t.accessHash === accessHash);
  }

  findRefresh(refreshHash: string): TokenRecord | undefined {
    return this.data.tokens.find((t) => t.refreshHash === refreshHash);
  }

  revoke(hash: string): boolean {
    const before = this.data.tokens.length;
    this.data.tokens = this.data.tokens.filter((t) => t.accessHash !== hash && t.refreshHash !== hash);
    if (this.data.tokens.length !== before) this.persist();
    return this.data.tokens.length !== before;
  }

  removeToken(t: TokenRecord): void {
    this.data.tokens = this.data.tokens.filter((x) => x !== t);
    this.persist();
  }

  // ── first-party web sessions (cookie-based, separate from the OAuth/PKCE flow above,
  // which exists for third-party MCP clients like Alexa+ linking in — the web app is
  // first-party, so it authenticates itself directly rather than round-tripping OAuth) ──
  createSession(userId: string, householdId: string): Session {
    const now = Date.now();
    const session: Session = { token: newSecret(), userId, householdId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    this.data.sessions[session.token] = session;
    this.persist();
    return session;
  }

  session(token: string): Session | undefined {
    const s = this.data.sessions[token];
    if (s && s.expiresAt < Date.now()) {
      delete this.data.sessions[token];
      this.persist();
      return undefined;
    }
    return s;
  }

  destroySession(token: string): void {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.persist();
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
