/**
 * Migration Test: 20260508_020 — EndUserOAuthToken project scope
 *
 * Validates:
 * - Three backfill cases: (a) resolved from profile, (b) tenant-scoped, (c) unresolvable
 * - Old unique index dropped, new partial unique + partial secondary created
 * - Idempotent re-run
 * - Rollback restores old index and unsets new fields
 * - INT-28 invariants: cross-project token reuse blocked, same-tenant lookups return distinct
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { setupTestMongo, teardownTestMongo, isMongoReady } from '../helpers/setup-mongo.js';
import { migration } from '../../migrations/scripts/20260508_020_end_user_oauth_token_project_scope.js';
import { hasIndex } from '../../migrations/validation.js';

const TOKEN_COLLECTION = 'end_user_oauth_tokens';
const PROFILE_COLLECTION = 'auth_profiles';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  if (!isMongoReady()) return;
  const db = mongoose.connection.db!;

  for (const collName of [TOKEN_COLLECTION, PROFILE_COLLECTION]) {
    const collections = await db.listCollections({ name: collName }).toArray();
    if (collections.length > 0) {
      await db.collection(collName).deleteMany({});
      // Drop all non-_id indexes for clean slate
      try {
        await db.collection(collName).dropIndexes();
      } catch {
        // collection may not exist yet
      }
    }
  }
});

describe('Migration 20260508_020 — EndUserOAuthToken project scope', () => {
  test('backfills three cases: resolved, tenant-scoped, unresolvable', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);
    const profileCol = db.collection(PROFILE_COLLECTION);

    // Seed auth profiles
    await profileCol.insertMany([
      {
        _id: 'profile-project-scoped',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        name: 'Slack Integration',
        connector: 'slack',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-1',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-tenant-scoped',
        tenantId: 'tenant-1',
        projectId: null,
        name: 'Tenant Slack',
        connector: 'google_drive',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-2',
        encryptionKeyVersion: 1,
      },
    ]);

    // Create old unique index first
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    // Seed tokens
    await tokenCol.insertMany([
      {
        _id: 'token-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'slack',
        providerUserId: 'slack-u1',
        encryptedAccessToken: 'enc-at-1',
        encryptedRefreshToken: null,
        scope: 'read',
        consentedAt: new Date(),
      },
      {
        _id: 'token-2',
        tenantId: 'tenant-1',
        userId: 'user-2',
        provider: 'google_drive',
        providerUserId: 'gd-u2',
        encryptedAccessToken: 'enc-at-2',
        encryptedRefreshToken: null,
        scope: 'read',
        consentedAt: new Date(),
      },
      {
        _id: 'token-3',
        tenantId: 'tenant-1',
        userId: 'user-3',
        provider: 'unknown_provider',
        providerUserId: 'uk-u3',
        encryptedAccessToken: 'enc-at-3',
        encryptedRefreshToken: null,
        scope: 'read',
        consentedAt: new Date(),
      },
    ]);

    // Run migration
    await migration.up(db);

    // Case (a): token-1 should be linked to project-scoped profile
    const token1 = await tokenCol.findOne({ _id: 'token-1' });
    expect(token1?.projectId).toBe('proj-1');
    expect(token1?.profileId).toBe('profile-project-scoped');

    // Case (b): token-2 should have profileId but null projectId (tenant-scoped)
    const token2 = await tokenCol.findOne({ _id: 'token-2' });
    expect(token2?.projectId).toBeNull();
    expect(token2?.profileId).toBe('profile-tenant-scoped');

    // Case (c): token-3 — unresolvable, both null
    const token3 = await tokenCol.findOne({ _id: 'token-3' });
    expect(token3?.projectId).toBeNull();
    expect(token3?.profileId).toBeNull();
  });

  test('drops old unique index and creates new partial indexes', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    // Verify old index exists
    const hasOldBefore = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasOldBefore).toBe(true);

    // Run migration
    await migration.up(db);

    // Old unique index should be gone
    const hasOldAfter = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasOldAfter).toBe(false);

    // New partial unique index should exist
    const hasNewUnique = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, projectId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasNewUnique).toBe(true);

    // New partial secondary index should exist
    const hasNewSecondary = await hasIndex(db, TOKEN_COLLECTION, {
      tenantId: 1,
      profileId: 1,
      userId: 1,
    });
    expect(hasNewSecondary).toBe(true);
  });

  test('idempotent re-run produces no errors', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    // Insert a token
    await tokenCol.insertOne({
      _id: 'token-idem-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-1',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // First run
    await migration.up(db);

    // Second run (idempotent)
    await migration.up(db);

    // Token should still be correctly set (null since no matching profile)
    const token = await tokenCol.findOne({ _id: 'token-idem-1' });
    expect(token?.projectId).toBeNull();
    expect(token?.profileId).toBeNull();

    // Indexes should still be correct
    const hasNewUnique = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, projectId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasNewUnique).toBe(true);
  });

  test('rollback restores old unique index and unsets new fields', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index and seed
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    await tokenCol.insertOne({
      _id: 'token-rb-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-1',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // Run migration
    await migration.up(db);

    // Verify new state
    const tokenAfterUp = await tokenCol.findOne({ _id: 'token-rb-1' });
    expect(tokenAfterUp).toHaveProperty('projectId');
    expect(tokenAfterUp).toHaveProperty('profileId');

    // Rollback
    await migration.down(db);

    // Old unique index should be restored
    const hasOld = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasOld).toBe(true);

    // New indexes should be gone
    const hasNewUnique = await hasIndex(
      db,
      TOKEN_COLLECTION,
      { tenantId: 1, projectId: 1, userId: 1, provider: 1 },
      { unique: true },
    );
    expect(hasNewUnique).toBe(false);

    const hasNewSecondary = await hasIndex(db, TOKEN_COLLECTION, {
      tenantId: 1,
      profileId: 1,
      userId: 1,
    });
    expect(hasNewSecondary).toBe(false);

    // Fields should be unset
    const tokenAfterDown = await tokenCol.findOne({ _id: 'token-rb-1' });
    expect(tokenAfterDown?.projectId).toBeUndefined();
    expect(tokenAfterDown?.profileId).toBeUndefined();
  });

  test('validate returns ok when indexes are correct', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    await migration.up(db);

    const result = await migration.validate!(db);
    expect(result.ok).toBe(true);
  });

  test('validate returns failure when old unique still exists', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Only create old index, don't run migration
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );

    const result = await migration.validate!(db);
    expect(result.ok).toBe(false);
  });

  test('INT-28: cross-project token reuse blocked by partial unique index', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index and run migration
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );
    await migration.up(db);

    // Insert a token with projectId
    await tokenCol.insertOne({
      _id: 'token-int28-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      profileId: 'profile-1',
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-1',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // Same user, same provider, different project → should succeed
    await tokenCol.insertOne({
      _id: 'token-int28-2',
      tenantId: 'tenant-1',
      projectId: 'proj-2',
      profileId: 'profile-2',
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-2',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // Same user, same provider, same project → should fail (duplicate)
    await expect(
      tokenCol.insertOne({
        _id: 'token-int28-3',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        profileId: 'profile-1',
        userId: 'user-1',
        provider: 'slack',
        providerUserId: 'slack-u1-dup',
        encryptedAccessToken: 'enc-at-3',
        encryptedRefreshToken: null,
        scope: 'read',
        consentedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/i);

    // Verify distinct rows for same tenant across projects
    const results = await tokenCol
      .find({ tenantId: 'tenant-1', userId: 'user-1', provider: 'slack' })
      .toArray();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.projectId).sort()).toEqual(['proj-1', 'proj-2']);
  });

  test('legacy null-projectId rows survive alongside project-scoped rows', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const tokenCol = db.collection(TOKEN_COLLECTION);

    // Create old unique index and run migration
    await tokenCol.createIndex(
      { tenantId: 1, userId: 1, provider: 1 },
      { name: 'tenantId_1_userId_1_provider_1', unique: true },
    );
    await migration.up(db);

    // Insert a legacy null-projectId token
    await tokenCol.insertOne({
      _id: 'token-legacy-1',
      tenantId: 'tenant-1',
      projectId: null,
      profileId: null,
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-1',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // Insert a project-scoped token for same user+provider → should succeed
    // because the partial unique only applies when projectId is a string
    await tokenCol.insertOne({
      _id: 'token-new-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      profileId: 'profile-1',
      userId: 'user-1',
      provider: 'slack',
      providerUserId: 'slack-u1',
      encryptedAccessToken: 'enc-at-2',
      encryptedRefreshToken: null,
      scope: 'read',
      consentedAt: new Date(),
    });

    // Both should exist
    const all = await tokenCol
      .find({ tenantId: 'tenant-1', userId: 'user-1', provider: 'slack' })
      .toArray();
    expect(all).toHaveLength(2);
  });
});
