/**
 * Migration Test: 20260508_019 — Backfill profileType on auth_profiles
 *
 * Validates:
 * - 5 seeded rows: 2 with connector → 'integration', 3 without → 'custom'
 * - Idempotent re-run produces no changes
 * - Rollback unsets profileType on all rows
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { setupTestMongo, teardownTestMongo, isMongoReady } from '../helpers/setup-mongo.js';
import { migration } from '../../migrations/scripts/20260508_019_auth_profile_profile_type.js';

const COLLECTION = 'auth_profiles';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  if (!isMongoReady()) return;
  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ name: COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.collection(COLLECTION).deleteMany({});
  }
});

describe('Migration 20260508_019 — profileType backfill', () => {
  test('backfills 2 integration + 3 custom rows correctly', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTION);

    // Seed 5 rows: 2 with connector, 3 without
    await col.insertMany([
      {
        _id: 'profile-1',
        tenantId: 'tenant-1',
        name: 'Slack Integration',
        connector: 'slack',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'encrypted-1',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-2',
        tenantId: 'tenant-1',
        name: 'Google Drive',
        connector: 'google_drive',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'encrypted-2',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-3',
        tenantId: 'tenant-1',
        name: 'Custom API Key',
        authType: 'api_key',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'encrypted-3',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-4',
        tenantId: 'tenant-1',
        name: 'Custom Bearer',
        connector: null,
        authType: 'bearer',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'encrypted-4',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-5',
        tenantId: 'tenant-2',
        name: 'Custom OAuth',
        connector: '',
        authType: 'oauth2_token',
        status: 'active',
        createdBy: 'user-2',
        encryptedSecrets: 'encrypted-5',
        encryptionKeyVersion: 1,
      },
    ]);

    // Run migration
    await migration.up(db);

    // Verify backfill
    const profile1 = await col.findOne({ _id: 'profile-1' });
    expect(profile1?.profileType).toBe('integration');

    const profile2 = await col.findOne({ _id: 'profile-2' });
    expect(profile2?.profileType).toBe('integration');

    const profile3 = await col.findOne({ _id: 'profile-3' });
    expect(profile3?.profileType).toBe('custom');

    const profile4 = await col.findOne({ _id: 'profile-4' });
    expect(profile4?.profileType).toBe('custom');

    const profile5 = await col.findOne({ _id: 'profile-5' });
    expect(profile5?.profileType).toBe('custom');
  });

  test('idempotent re-run produces no changes', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTION);

    // Seed rows
    await col.insertMany([
      {
        _id: 'profile-a',
        tenantId: 'tenant-1',
        name: 'Connector A',
        connector: 'jira',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-a',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-b',
        tenantId: 'tenant-1',
        name: 'Custom B',
        authType: 'api_key',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-b',
        encryptionKeyVersion: 1,
      },
    ]);

    // First run
    await migration.up(db);

    // Verify initial state
    const profileA = await col.findOne({ _id: 'profile-a' });
    expect(profileA?.profileType).toBe('integration');

    // Second run (idempotent)
    await migration.up(db);

    // Verify state unchanged
    const profileAAfter = await col.findOne({ _id: 'profile-a' });
    expect(profileAAfter?.profileType).toBe('integration');

    const profileBAfter = await col.findOne({ _id: 'profile-b' });
    expect(profileBAfter?.profileType).toBe('custom');
  });

  test('rollback unsets profileType on all rows', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTION);

    // Seed and run migration
    await col.insertMany([
      {
        _id: 'profile-r1',
        tenantId: 'tenant-1',
        name: 'R1',
        connector: 'slack',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-r1',
        encryptionKeyVersion: 1,
      },
      {
        _id: 'profile-r2',
        tenantId: 'tenant-1',
        name: 'R2',
        authType: 'api_key',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-r2',
        encryptionKeyVersion: 1,
      },
    ]);

    await migration.up(db);

    // Verify profileType set
    const beforeRollback = await col.findOne({ _id: 'profile-r1' });
    expect(beforeRollback?.profileType).toBe('integration');

    // Rollback
    await migration.down(db);

    // Verify profileType removed
    const afterRollback1 = await col.findOne({ _id: 'profile-r1' });
    expect(afterRollback1?.profileType).toBeUndefined();

    const afterRollback2 = await col.findOne({ _id: 'profile-r2' });
    expect(afterRollback2?.profileType).toBeUndefined();
  });

  test('validate returns ok when all rows have profileType', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTION);

    await col.insertMany([
      {
        _id: 'profile-v1',
        tenantId: 'tenant-1',
        name: 'V1',
        connector: 'jira',
        authType: 'oauth2_app',
        status: 'active',
        createdBy: 'user-1',
        encryptedSecrets: 'enc-v1',
        encryptionKeyVersion: 1,
      },
    ]);

    await migration.up(db);

    const result = await migration.validate!(db);
    expect(result.ok).toBe(true);
  });

  test('validate returns failure when rows are missing profileType', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTION);

    // Insert row without running migration
    await col.insertOne({
      _id: 'profile-v2',
      tenantId: 'tenant-1',
      name: 'V2',
      authType: 'api_key',
      status: 'active',
      createdBy: 'user-1',
      encryptedSecrets: 'enc-v2',
      encryptionKeyVersion: 1,
    });

    const result = await migration.validate!(db);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('missing profileType');
  });
});
