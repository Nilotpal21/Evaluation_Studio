/**
 * Migration: Unified Credential Store
 *
 * Transforms the llm_credentials collection from user-only credentials
 * to a unified store supporting both user-scoped and tenant-scoped credentials.
 *
 * Steps:
 * 1. Backfill existing user credentials with credentialScope='user', ownerId=userId
 * 2. Migrate inline TenantModel connection keys into tenant-scoped credentials
 * 3. Update indexes to reflect the new unified schema
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { uuidv7 } from '../../mongo/base-document.js';

type Db = mongoose.mongo.Db;

// ─── Constants ──────────────────────────────────────────────────────────────

const CREDENTIALS_COLLECTION = 'llm_credentials';
const TENANT_MODELS_COLLECTION = 'tenant_models';

/** Batch size for bulk operations */
const BATCH_SIZE = 500;

// ─── Old indexes to drop ────────────────────────────────────────────────────

const OLD_INDEXES = [
  { name: 'userId_1_provider_1_name_1', key: { userId: 1, provider: 1, name: 1 } },
  { name: 'userId_1', key: { userId: 1 } },
];

// ─── New indexes to create ──────────────────────────────────────────────────

const NEW_INDEXES = [
  {
    key: { tenantId: 1, credentialScope: 1, ownerId: 1, provider: 1, name: 1 } as Record<string, 1>,
    options: { unique: true, background: true },
  },
  {
    key: { tenantId: 1, credentialScope: 1, ownerId: 1 } as Record<string, 1>,
    options: { background: true },
  },
];

// ─── Migration ──────────────────────────────────────────────────────────────

export const migration: Migration = {
  version: '20260219_001',
  description:
    'Unified credential store: backfill user scope, migrate TenantModel inline keys, update indexes',

  async up(db) {
    const credentialsColl = db.collection(CREDENTIALS_COLLECTION);
    const tenantModelsColl = db.collection(TENANT_MODELS_COLLECTION);

    // ── Step 1: Backfill existing user credentials ──────────────────────

    const backfillResult = await credentialsColl.updateMany(
      { credentialScope: { $exists: false } },
      {
        $set: {
          credentialScope: 'user',
          customHeaders: null,
        },
        $rename: { userId: 'ownerId' },
      },
    );
    console.log(`  Backfilled ${backfillResult.modifiedCount} existing user credentials`);

    // ── Step 2: Migrate TenantModel inline connection keys ──────────────

    // Find all tenant_models with connections that have non-null encryptedApiKey
    const tenantModels = await tenantModelsColl
      .find({
        'connections.encryptedApiKey': { $ne: null },
      })
      .toArray();

    let migratedCount = 0;
    const credentialBulkOps: any[] = [];
    const tenantModelBulkOps: any[] = [];

    for (const tm of tenantModels) {
      const connections = (tm.connections ?? []) as any[];

      for (let i = 0; i < connections.length; i++) {
        const conn = connections[i];

        // Skip connections that already have a credentialId or no API key
        if (conn.credentialId || !conn.encryptedApiKey) {
          continue;
        }

        const credentialId = uuidv7();
        const now = new Date();
        const connectionLabel = conn.connectionName || 'default';
        const credentialName = `${tm.displayName} - ${connectionLabel}`;

        // Create a new tenant-scoped credential.
        // ENC-003: The encryptedApiKey value is already in encrypted format (migrated
        // from TenantModel.connections.encryptedApiKey which was encrypted by the
        // previous system). We stamp explicit encryption metadata so the plugin's
        // decrypt path can identify the encryption state without heuristics.
        // The endpointUrl may be plaintext — mark accordingly.
        const apiKeyAlreadyEncrypted =
          typeof conn.encryptedApiKey === 'string' &&
          /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(conn.encryptedApiKey);

        credentialBulkOps.push({
          insertOne: {
            document: {
              _id: credentialId,
              tenantId: tm.tenantId,
              credentialScope: 'tenant',
              ownerId: tm.tenantId,
              provider: tm.provider ?? 'unknown',
              name: credentialName,
              encryptedApiKey: conn.encryptedApiKey,
              encryptedEndpoint: tm.endpointUrl ?? tm.customEndpoint ?? null,
              authType: conn.authType ?? 'api_key',
              authConfig: conn.authConfig ?? {},
              customHeaders: tm.customHeaders ?? null,
              isActive: true,
              isDefault: false,
              lastUsedAt: null,
              lastValidatedAt: null,
              _v: 1,
              // Encryption metadata: stamp the state so the plugin does not guess.
              // If the API key looks encrypted (hex 3-part), mark as pre-encrypted
              // so the decrypt path knows to attempt tenant-scoped decryption.
              ...(apiKeyAlreadyEncrypted
                ? {
                    ire: 'v3',
                    fieldsToEncrypt: ['encryptedApiKey', 'encryptedEndpoint'],
                  }
                : {}),
              createdAt: now,
              updatedAt: now,
            },
          },
        });

        // Update the connection: set credentialId, clear encryptedApiKey
        tenantModelBulkOps.push({
          updateOne: {
            filter: { _id: tm._id, 'connections.id': conn.id },
            update: {
              $set: {
                'connections.$.credentialId': credentialId,
                'connections.$.encryptedApiKey': null,
              },
            },
          },
        });

        migratedCount++;
      }

      // Flush in batches to avoid oversized bulk writes
      if (credentialBulkOps.length >= BATCH_SIZE) {
        await credentialsColl.bulkWrite(credentialBulkOps);
        credentialBulkOps.length = 0;
      }
      if (tenantModelBulkOps.length >= BATCH_SIZE) {
        await tenantModelsColl.bulkWrite(tenantModelBulkOps);
        tenantModelBulkOps.length = 0;
      }
    }

    // Flush remaining operations
    if (credentialBulkOps.length > 0) {
      await credentialsColl.bulkWrite(credentialBulkOps);
    }
    if (tenantModelBulkOps.length > 0) {
      await tenantModelsColl.bulkWrite(tenantModelBulkOps);
    }

    console.log(`  Migrated ${migratedCount} TenantModel connections to tenant-scoped credentials`);

    // ── Step 3: Update indexes ──────────────────────────────────────────

    // Drop old indexes (safe — ignore if they don't exist)
    for (const idx of OLD_INDEXES) {
      try {
        await credentialsColl.dropIndex(idx.name);
        console.log(`  Dropped index: ${idx.name}`);
      } catch (error: any) {
        // Index may not exist (code 27 = IndexNotFound)
        if (error.code !== 27) {
          throw error;
        }
        console.log(`  Index ${idx.name} not found — skipping drop`);
      }
    }

    // Create new indexes
    for (const idx of NEW_INDEXES) {
      await credentialsColl.createIndex(idx.key, idx.options);
    }

    console.log('  Created new unified credential indexes');
  },

  async down(db) {
    const credentialsColl = db.collection(CREDENTIALS_COLLECTION);

    // ── Step 1: Drop new indexes ────────────────────────────────────────

    try {
      await credentialsColl.dropIndex('tenantId_1_credentialScope_1_ownerId_1_provider_1_name_1');
    } catch (error: any) {
      if (error.code !== 27) throw error;
    }
    try {
      await credentialsColl.dropIndex('tenantId_1_credentialScope_1_ownerId_1');
    } catch (error: any) {
      if (error.code !== 27) throw error;
    }

    console.log('  Dropped new unified credential indexes');

    // ── Step 2: Delete migrated tenant-scoped credentials ───────────────

    const deleteResult = await credentialsColl.deleteMany({ credentialScope: 'tenant' });
    console.log(`  Deleted ${deleteResult.deletedCount} tenant-scoped credentials`);

    // ── Step 3: Revert user credentials (rename ownerId back to userId, unset new fields) ──

    await credentialsColl.updateMany(
      { credentialScope: 'user' },
      {
        $rename: { ownerId: 'userId' },
        $unset: { credentialScope: '', customHeaders: '' },
      },
    );

    console.log('  Reverted user credentials to original schema');

    // ── Step 4: Restore old indexes ─────────────────────────────────────

    await credentialsColl.createIndex(
      { userId: 1, provider: 1, name: 1 },
      { unique: true, background: true },
    );
    await credentialsColl.createIndex({ userId: 1 }, { background: true });

    console.log('  Restored original indexes');

    // Note: TenantModel connections are not reverted because the credential
    // documents they referenced have been deleted. The connections will have
    // credentialId set to a now-nonexistent credential and encryptedApiKey=null.
    // A full revert would require a backup strategy — this down migration is
    // designed for index/schema rollback, not full data recovery.
  },
};
