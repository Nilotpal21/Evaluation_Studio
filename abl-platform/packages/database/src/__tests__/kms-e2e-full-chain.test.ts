/**
 * KMS Full Chain E2E Test
 *
 * Exercises the REAL end-to-end KMS encryption chain with zero mocks:
 *   KMSProviderPool → KMSResolver → DEKManager → TenantEncryptionFacade
 *     → Mongoose encryption plugin → MongoDB
 *
 * Infrastructure:
 *   - Real MongoMemoryServer (documents actually written/read)
 *   - Real LocalKMSProvider (real AES-256-GCM crypto)
 *   - Real DEKManager (creates DEK entries in MongoDB)
 *   - Real TenantEncryptionFacade (DEK envelope format)
 *   - Real Mongoose encryption plugin (pre-save/post-find hooks)
 *   - Real encryptForTenantAuto / decryptForTenantAuto
 *
 * Only external cloud KMS providers are absent — LocalKMSProvider stands in
 * as a real, functionally complete KMS that uses the same interface.
 *
 * Scenarios:
 *   1. Platform-level KMS init → Mongoose plugin encrypts/decrypts via DEK facade
 *   2. encryptForTenantAuto / decryptForTenantAuto round-trip
 *   3. Per-tenant override via TenantKMSConfig document
 *   4. Tenant without config falls back to platform default
 *   5. Cross-tenant isolation (tenant B cannot decrypt tenant A's data)
 *   6. DEK rotation: old data still decryptable after rotation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import crypto from 'node:crypto';
import {
  setupTestMongo,
  teardownTestMongo,
  requireMongo,
  clearCollections,
} from './helpers/setup-mongo.js';

// ── Real KMS components (no mocks) ──────────────────────────────────────

import { KMSProviderPool } from '../kms/kms-provider-pool.js';
import { KMSResolver } from '../kms/kms-resolver.js';
import { DEKManager } from '../kms/dek-manager.js';
import { setKMSProviderPool, _resetKMSRegistryForTesting } from '../kms/kms-registry.js';
import {
  encryptionPlugin,
  setMasterKey,
  setEncryptionFacade,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';

// TenantEncryptionFacade — real implementation
import { TenantEncryptionFacade } from '@agent-platform/shared-encryption';
import {
  encryptForTenantAuto,
  decryptForTenantAuto,
  _resetEncryptionServiceForTesting,
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
} from '@agent-platform/shared-encryption';

import { uuidv7 } from '../mongo/base-document.js';

// ── Constants ────────────────────────────────────────────────────────────

const MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
const TENANT_A = 'tenant-alpha-e2e';
const TENANT_B = 'tenant-beta-e2e';
const TENANT_NO_CONFIG = 'tenant-no-config-e2e';

// ── Helpers ──────────────────────────────────────────────────────────────

let modelCounter = 0;
function createEncryptedModel(fields: string[]) {
  const name = `KmsE2E_${++modelCounter}_${Date.now()}`;
  const schemaDef: Record<string, any> = {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: String,
  };
  for (const f of fields) {
    schemaDef[f] = String;
  }
  const schema = new Schema(schemaDef);
  schema.plugin(encryptionPlugin, { fieldsToEncrypt: fields });
  return mongoose.model(name, schema);
}

// ── Suite Setup ──────────────────────────────────────────────────────────

let pool: KMSProviderPool;
let resolver: KMSResolver;
let dekManager: DEKManager;
let facade: TenantEncryptionFacade;

describe('KMS full chain E2E (real MongoDB + real crypto)', () => {
  beforeAll(async () => {
    await setupTestMongo();

    // Set env for platform default
    process.env.KMS_PROVIDER = 'local';
    // No cloud env vars — LocalKMSProvider is the platform default

    // 1. Master key for platform-local KMS bootstrap
    setMasterKey(MASTER_KEY_HEX);

    // 2. KMSProviderPool (creates LocalKMSProvider from master key)
    pool = new KMSProviderPool({ masterKeyHex: MASTER_KEY_HEX });
    await pool.initialize();
    setKMSProviderPool(pool);

    // 3. KMSResolver (reads TenantKMSConfig from MongoDB, falls back to platform default)
    resolver = new KMSResolver();

    // 4. DEKManager + TenantEncryptionFacade
    dekManager = new DEKManager(resolver);
    facade = new TenantEncryptionFacade(dekManager, 'platform-default');

    // 5. Inject facade into Mongoose plugin (also sets globalThis.__encryptionFacade)
    setEncryptionFacade(facade);

    // 6. Set the facade on globalThis so encryptForTenantAuto picks it up
    setGlobalEncryptionFacade(facade);
  });

  afterAll(async () => {
    clearGlobalEncryptionFacade();
    _resetEncryptionStateForTesting();
    _resetKMSRegistryForTesting();
    _resetEncryptionServiceForTesting();
    delete process.env.KMS_PROVIDER;
    await teardownTestMongo();
  });

  beforeEach(async ({ skip }) => {
    requireMongo(skip);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 1: Mongoose plugin encrypts/decrypts via DEK facade
  // ════════════════════════════════════════════════════════════════════════

  it(
    'S1: Mongoose plugin round-trips encrypted fields via DEK facade',
    { timeout: 60_000 },
    async ({ skip }) => {
      requireMongo(skip);

      const Model = createEncryptedModel(['secret', 'apiKey']);

      // Save a document — plugin should encrypt via facade
      const doc = await Model.create({
        tenantId: TENANT_A,
        name: 'alice',
        secret: 'my-secret-value',
        apiKey: 'sk-1234567890',
      });

      // Verify raw storage is encrypted (not plaintext)
      const raw = await Model.collection.findOne({ _id: doc._id });
      expect(raw).toBeDefined();
      expect(raw!.secret).not.toBe('my-secret-value');
      expect(raw!.apiKey).not.toBe('sk-1234567890');
      expect(raw!.name).toBe('alice'); // Unencrypted field unchanged

      // Read back — plugin should decrypt via facade
      const found = await Model.findOne({ _id: doc._id });
      expect(found).toBeDefined();
      expect(found!.secret).toBe('my-secret-value');
      expect(found!.apiKey).toBe('sk-1234567890');
      expect(found!.name).toBe('alice');
    },
  );

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 2: encryptForTenantAuto / decryptForTenantAuto round-trip
  // ════════════════════════════════════════════════════════════════════════

  it('S2: encryptForTenantAuto/decryptForTenantAuto round-trip through facade', async ({
    skip,
  }) => {
    requireMongo(skip);

    const plaintext = 'sensitive-oauth-token-xyz';

    const encrypted = await encryptForTenantAuto(plaintext, TENANT_A);

    // Encrypted value must differ from plaintext
    expect(encrypted).not.toBe(plaintext);
    // DEK envelope format is base64 (not hex 3-part)
    expect(encrypted).not.toContain(':');

    const decrypted = await decryptForTenantAuto(encrypted, TENANT_A);
    expect(decrypted).toBe(plaintext);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 3: Multiple encrypt calls produce different ciphertexts (nonce uniqueness)
  // ════════════════════════════════════════════════════════════════════════

  it('S3: same plaintext produces different ciphertexts (IV uniqueness)', async ({ skip }) => {
    requireMongo(skip);

    const plaintext = 'repeated-value';
    const ct1 = await encryptForTenantAuto(plaintext, TENANT_A);
    const ct2 = await encryptForTenantAuto(plaintext, TENANT_A);

    // Same plaintext, same tenant, but different IVs → different ciphertexts
    expect(ct1).not.toBe(ct2);

    // Both decrypt to same value
    expect(await decryptForTenantAuto(ct1, TENANT_A)).toBe(plaintext);
    expect(await decryptForTenantAuto(ct2, TENANT_A)).toBe(plaintext);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 4: Cross-tenant isolation — tenant B cannot decrypt tenant A's data
  // ════════════════════════════════════════════════════════════════════════

  it('S4: cross-tenant isolation — different tenant cannot decrypt', async ({ skip }) => {
    requireMongo(skip);

    const plaintext = 'alpha-only-secret';
    const encryptedByA = await encryptForTenantAuto(plaintext, TENANT_A);

    // Tenant A can decrypt
    expect(await decryptForTenantAuto(encryptedByA, TENANT_A)).toBe(plaintext);

    // Tenant B cannot decrypt tenant A's data (DEK not found for B's scope)
    await expect(decryptForTenantAuto(encryptedByA, TENANT_B)).rejects.toThrow();
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 5: DEK created in MongoDB (real DEKEntry document)
  // ════════════════════════════════════════════════════════════════════════

  it('S5: DEK entry is actually created in MongoDB', async ({ skip }) => {
    requireMongo(skip);

    const tenantId = 'tenant-dek-check-e2e';

    // Encrypt something to trigger DEK creation
    await encryptForTenantAuto('trigger-dek', tenantId);

    // Verify DEKEntry exists in MongoDB
    const { DEKEntry } = await import('../models/index.js');
    const entry = await DEKEntry.findOne({ tenantId }).lean();

    expect(entry).toBeDefined();
    expect(entry!.tenantId).toBe(tenantId);
    expect(entry!.status).toBe('active');
    expect(entry!.wrappedDek).toBeTruthy(); // Base64-encoded wrapped key
    expect(entry!.kekKeyId).toBe('platform-default');
    expect(entry!.kekKeyVersion).toBeGreaterThanOrEqual(1);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 6: DEK rotation — old data still decryptable
  // ════════════════════════════════════════════════════════════════════════

  it('S6: after DEK rotation, old ciphertexts are still decryptable', async ({ skip }) => {
    requireMongo(skip);

    const tenantId = 'tenant-rotation-e2e';
    const plaintext = 'pre-rotation-secret';

    // Encrypt before rotation
    const encryptedBefore = await encryptForTenantAuto(plaintext, tenantId);

    // Force-rotate DEKs
    const rotatedCount = await facade.forceRotate(tenantId, '_tenant', '_shared');
    expect(rotatedCount).toBeGreaterThanOrEqual(1);

    // Encrypt after rotation (will use new DEK)
    const encryptedAfter = await encryptForTenantAuto('post-rotation-secret', tenantId);

    // Old ciphertext still decryptable (unwrapDEK finds the old DEK in decrypt_only status)
    expect(await decryptForTenantAuto(encryptedBefore, tenantId)).toBe(plaintext);

    // New ciphertext also decryptable
    expect(await decryptForTenantAuto(encryptedAfter, tenantId)).toBe('post-rotation-secret');

    // Old and new ciphertexts are different (different DEKs)
    expect(encryptedBefore).not.toBe(encryptedAfter);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 8: Per-tenant KMS config override via TenantKMSConfig document
  // ════════════════════════════════════════════════════════════════════════

  it('S8: tenant with TenantKMSConfig gets resolved config from MongoDB', async ({ skip }) => {
    requireMongo(skip);

    const tenantId = 'tenant-with-custom-config-e2e';

    // Insert a per-tenant KMS config into MongoDB (pointing to local provider with custom keyId)
    const { TenantKMSConfig } = await import('../models/index.js');
    await TenantKMSConfig.create({
      tenantId,
      defaultProvider: {
        providerType: 'local',
        keyId: 'custom-tenant-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      },
      failurePolicy: 'fail-closed',
      _v: 1,
    });

    // Resolve config — should come from DB, not platform default
    const resolved = await resolver.resolve(tenantId);
    expect(resolved.provider.providerType).toBe('local');
    expect(resolved.keyId).toBe('custom-tenant-key');
    expect(resolved.sourceConfigVersion).toBe(1); // From DB (_v field)

    // Encrypt/decrypt round-trip works with the per-tenant config
    const plaintext = 'per-tenant-secret';
    const encrypted = await encryptForTenantAuto(plaintext, tenantId);
    const decrypted = await decryptForTenantAuto(encrypted, tenantId);
    expect(decrypted).toBe(plaintext);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 9: Tenant without config falls back to platform default
  // ════════════════════════════════════════════════════════════════════════

  it('S9: tenant without TenantKMSConfig falls back to platform default', async ({ skip }) => {
    requireMongo(skip);

    // Resolve config for a tenant with no TenantKMSConfig document
    const resolved = await resolver.resolve(TENANT_NO_CONFIG);
    expect(resolved.provider.providerType).toBe('local');
    expect(resolved.keyId).toBe('platform-default');
    expect(resolved.sourceConfigVersion).toBe(0); // Platform default marker

    // Encrypt/decrypt still works via platform default
    const plaintext = 'fallback-secret';
    const encrypted = await encryptForTenantAuto(plaintext, TENANT_NO_CONFIG);
    const decrypted = await decryptForTenantAuto(encrypted, TENANT_NO_CONFIG);
    expect(decrypted).toBe(plaintext);
  });

  it('S9b: resolver throws when config lookups fail instead of silently using platform default', async ({
    skip,
  }) => {
    requireMongo(skip);

    const { MaterializedKMSConfig } = await import('../models/index.js');
    vi.spyOn(MaterializedKMSConfig, 'findOne').mockImplementation(() => {
      throw new Error('materialized lookup unavailable');
    });

    await expect(resolver.resolve('tenant-resolution-failure-e2e')).rejects.toThrow(
      /materialized lookup unavailable/i,
    );
  });

  it('S9c: tenant config still resolves when materialized lookup fails', async ({ skip }) => {
    requireMongo(skip);

    const tenantId = 'tenant-fallback-config-e2e';
    const { TenantKMSConfig, MaterializedKMSConfig } = await import('../models/index.js');

    await TenantKMSConfig.create({
      tenantId,
      defaultProvider: {
        providerType: 'local',
        keyId: 'tenant-fallback-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      },
      failurePolicy: 'fail-closed',
      _v: 3,
    });

    vi.spyOn(MaterializedKMSConfig, 'findOne').mockImplementation(() => {
      throw new Error('materialized lookup unavailable');
    });

    const resolved = await resolver.resolve(tenantId);
    expect(resolved.provider.providerType).toBe('local');
    expect(resolved.keyId).toBe('tenant-fallback-key');
    expect(resolved.sourceConfigVersion).toBe(3);
  });

  it('S9d: resolver throws when tenant config lookup fails and no materialized config exists', async ({
    skip,
  }) => {
    requireMongo(skip);

    const { TenantKMSConfig } = await import('../models/index.js');
    vi.spyOn(TenantKMSConfig, 'findOne').mockImplementation(() => {
      throw new Error('tenant config lookup unavailable');
    });

    await expect(resolver.resolve('tenant-config-failure-e2e')).rejects.toThrow(
      /tenant config lookup unavailable/i,
    );
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 10: Mongoose plugin round-trip with multiple documents
  // ════════════════════════════════════════════════════════════════════════

  it('S10: batch save and read multiple encrypted documents', async ({ skip }) => {
    requireMongo(skip);

    const Model = createEncryptedModel(['secret']);
    const tenantId = 'tenant-batch-e2e';
    const count = 10;
    const secrets = Array.from({ length: count }, (_, i) => `secret-${i}`);

    // Bulk create
    const docs = await Model.insertMany(
      secrets.map((s, i) => ({
        tenantId,
        name: `user-${i}`,
        secret: s,
      })),
    );

    expect(docs).toHaveLength(count);

    // Read all back
    const found = await Model.find({ tenantId }).sort({ name: 1 }).exec();
    expect(found).toHaveLength(count);

    for (let i = 0; i < count; i++) {
      expect(found[i].secret).toBe(`secret-${i}`);
      expect(found[i].name).toBe(`user-${i}`);
    }

    // Verify raw storage is encrypted
    const rawDocs = await Model.collection.find({ tenantId }).toArray();
    for (const raw of rawDocs) {
      expect(raw.secret).not.toMatch(/^secret-\d+$/);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 11: Mixed content — JSON objects as encrypted fields
  // ════════════════════════════════════════════════════════════════════════

  it('S11: JSON object fields encrypt/decrypt correctly', async ({ skip }) => {
    requireMongo(skip);

    const name = `KmsE2EJson_${++modelCounter}_${Date.now()}`;
    const schema = new Schema({
      _id: { type: String, default: uuidv7 },
      tenantId: { type: String, required: true },
      config: Schema.Types.Mixed,
    });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['config'] });
    const Model = mongoose.model(name, schema);

    const originalConfig = {
      database: { host: 'db.example.com', port: 5432, password: 'p@ssw0rd!' },
      features: ['auth', 'billing'],
    };

    const doc = await Model.create({
      tenantId: TENANT_A,
      config: originalConfig,
    });

    // Read back — Mixed fields come back as JSON string after decrypt
    const found = await Model.findOne({ _id: doc._id });
    expect(found).toBeDefined();
    const parsed = typeof found!.config === 'string' ? JSON.parse(found!.config) : found!.config;
    expect(parsed).toEqual(originalConfig);
  });

  // ════════════════════════════════════════════════════════════════════════
  // SCENARIO 12: Double encryption guard
  // ════════════════════════════════════════════════════════════════════════

  it('S12: double encryption is detected and rejected', async ({ skip }) => {
    requireMongo(skip);

    const plaintext = 'some-value';
    const encrypted = await encryptForTenantAuto(plaintext, TENANT_A);

    // Attempting to encrypt already-encrypted data should throw
    await expect(encryptForTenantAuto(encrypted, TENANT_A)).rejects.toThrow(/double encryption/i);
  });
});
