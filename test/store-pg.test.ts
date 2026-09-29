import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';

const url = process.env.TEST_DATABASE_URL;

// Runs against a real Postgres in CI (see .github/workflows/ci.yml); skipped locally unless TEST_DATABASE_URL is set.
describe.skipIf(!url)('Postgres backend', () => {
  it('survives a restart: users, households, dishes and sessions round-trip', async () => {
    const name = `pg${Date.now()}`;
    const a = await Store.open(url);
    const user = await a.createUser(name, 'correct horse battery', 'America/Chicago');
    if ('error' in user) throw new Error(user.error);
    const hh = a.household(user.householdId)!;
    hh.custom.push({ id: 'dip', name: 'Dip', course: 'starter', cuisine: 'american', tags: [], aliases: ['dip'], steps: [] } as never);
    a.saveHousehold(hh);
    a.publishDish(hh.id, 'dip');
    const session = a.createSession(user.id, hh.id);
    await a.close();

    const b = await Store.open(url);
    try {
      expect(b.household(hh.id)?.publishedDishIds).toEqual(['dip']);
      expect(await b.verifyUser(name, 'correct horse battery')).toMatchObject({ id: user.id });
      expect(b.session(session.token)?.householdId).toBe(hh.id);
    } finally {
      await b.close();
    }
  });

  it('sweeping a guest deletes its rows, not just the in-memory copy', async () => {
    const a = await Store.open(url);
    const guest = a.createGuest('America/New_York');
    a.createSession(guest.id, guest.householdId);
    await a.flush();
    expect(a.sweepGuests(0, Date.now() + 1)).toBeGreaterThan(0);
    await a.close();

    const b = await Store.open(url);
    try {
      expect(b.household(guest.householdId)).toBeUndefined();
      expect(b.user(guest.id)).toBeUndefined();
    } finally {
      await b.close();
    }
  });
});
