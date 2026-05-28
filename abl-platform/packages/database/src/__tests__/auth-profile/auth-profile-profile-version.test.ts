/**
 * AuthProfile.profileVersion pre-save hook (CK-1 contract)
 *
 * Exercises the inline pre-save hook in auth-profile.model.ts using an
 * in-memory MongoMemoryServer harness. This is a unit-level behavioral test
 * for a schema hook — it requires a real mongoose connection to fire pre-save
 * middleware, which is why MongoMemoryServer is in scope rather than a pure
 * mock.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from '../helpers/setup-mongo.js';
import { AuthProfile } from '../../models/auth-profile.model.js';
import { makeAuthProfile } from '../helpers/auth-profile-factory.js';

beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('cd'.repeat(32));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('AuthProfile profileVersion pre-save hook', () => {
  it('initializes profileVersion to 1 on first create', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(makeAuthProfile({ name: 'pv-create' }));
    expect(profile.profileVersion).toBe(1);
  });

  it('increments profileVersion when config is mutated', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({ name: 'pv-config-mutate', config: { headerName: 'X-Init' } }),
    );
    expect(profile.profileVersion).toBe(1);

    const reloaded = await AuthProfile.findOne({ _id: profile._id });
    expect(reloaded).not.toBeNull();
    reloaded!.config = { headerName: 'X-Mutated' };
    await reloaded!.save();
    expect(reloaded!.profileVersion).toBe(2);
  });

  it('increments profileVersion when encryptedSecrets is rotated', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(
      makeAuthProfile({ name: 'pv-secret-rotate', encryptedSecrets: '{"k":"v1"}' }),
    );
    expect(profile.profileVersion).toBe(1);

    const reloaded = await AuthProfile.findOne({ _id: profile._id });
    expect(reloaded).not.toBeNull();
    reloaded!.encryptedSecrets = '{"k":"v2"}';
    await reloaded!.save();
    expect(reloaded!.profileVersion).toBe(2);
  });

  it('does not bump profileVersion when only lastUsedAt is touched', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const profile = await AuthProfile.create(makeAuthProfile({ name: 'pv-last-used' }));
    expect(profile.profileVersion).toBe(1);

    const reloaded = await AuthProfile.findOne({ _id: profile._id });
    expect(reloaded).not.toBeNull();
    reloaded!.lastUsedAt = new Date();
    await reloaded!.save();
    expect(reloaded!.profileVersion).toBe(1);
  });
});
