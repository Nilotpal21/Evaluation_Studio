/**
 * ABLP-1123 — pre-save hook on AuthProfile bumps `profileVersion` on every
 * meaningful mutation so pod-local credential caches keyed on `{tenantId,
 * profileId, profileVersion}` self-invalidate without an explicit eviction.
 *
 * Mutations that MUST bump: config, encryptedSecrets, status, enabled.
 * Mutations that MUST NOT bump: lastUsedAt, lastValidatedAt (and other
 * non-credential audit fields).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
  initTestDEKFacade,
} from './helpers/setup-mongo.js';
import { AuthProfile } from '../models/auth-profile.model.js';
import { makeAuthProfile } from './helpers/auth-profile-factory.js';

// Reload after create with tenant scope so encryptedSecrets is the on-disk
// ciphertext rather than the factory's plaintext. Otherwise the second save
// would re-encrypt an already-encrypted blob.
async function reload(id: string, tenantId: string) {
  const doc = await AuthProfile.findOne({ _id: id, tenantId });
  if (!doc) throw new Error(`reload: profile ${id} not found`);
  return doc;
}

beforeAll(async () => {
  await setupTestMongo();
  await initTestDEKFacade('ab'.repeat(32));
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('AuthProfile pre-save hook — profileVersion bump rules', () => {
  it('initialises profileVersion=1 on first save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const profile = await AuthProfile.create(makeAuthProfile());
    expect(profile.profileVersion).toBe(1);
  });

  it('bumps profileVersion when `config` changes', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await AuthProfile.create(makeAuthProfile());
    const profile = await reload(created._id, created.tenantId);
    const before = profile.profileVersion ?? 1;
    profile.config = { ...(profile.config ?? {}), headerName: 'X-New-Key' };
    await profile.save();
    expect(profile.profileVersion).toBe(before + 1);
  });

  it('bumps profileVersion when `status` changes (revoke / activate / lazy expiry)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await AuthProfile.create(makeAuthProfile());
    const profile = await reload(created._id, created.tenantId);
    const before = profile.profileVersion ?? 1;
    profile.status = 'revoked';
    await profile.save();
    expect(profile.profileVersion).toBe(before + 1);

    const profile2 = await reload(created._id, created.tenantId);
    profile2.status = 'active';
    await profile2.save();
    expect(profile2.profileVersion).toBe(before + 2);
  });

  it('bumps profileVersion when `enabled` changes (admin pause / resume)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await AuthProfile.create(makeAuthProfile());
    const profile = await reload(created._id, created.tenantId);
    const before = profile.profileVersion ?? 1;
    profile.enabled = false;
    await profile.save();
    expect(profile.profileVersion).toBe(before + 1);

    const profile2 = await reload(created._id, created.tenantId);
    profile2.enabled = true;
    await profile2.save();
    expect(profile2.profileVersion).toBe(before + 2);
  });

  it('does NOT bump profileVersion on a touch-only save (no relevant fields mutated)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await AuthProfile.create(makeAuthProfile());
    const profile = await reload(created._id, created.tenantId);
    const before = profile.profileVersion ?? 1;
    profile.lastValidatedAt = new Date();
    await profile.save();
    expect(profile.profileVersion).toBe(before);
  });

  it('bumps once per save even when multiple relevant fields change together', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const created = await AuthProfile.create(makeAuthProfile());
    const profile = await reload(created._id, created.tenantId);
    const before = profile.profileVersion ?? 1;
    profile.status = 'revoked';
    profile.enabled = false;
    profile.config = { ...(profile.config ?? {}), headerName: 'X-Changed' };
    await profile.save();
    expect(profile.profileVersion).toBe(before + 1);
  });
});
