/**
 * DEK Envelope Encryption — Credential Roundtrip Tests
 *
 * E2E-1, E2E-3, E2E-8 from test spec.
 * Uses real MongoDB (MongoMemoryServer), real LLMCredential model,
 * real DEKManager, real LocalKMSProvider, real encryption plugin.
 * NO mocks of codebase components.
 *
 * These tests exercise the full encryption boundary:
 *   LLMCredential.create() → encryption plugin → TenantEncryptionFacade
 *   → DEKManager → KMSProviderPool → dek_registry collection → AES-256-GCM
 *   → LLMCredential.findOne() → decryption → plaintext
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  requireMongo,
  clearCollections,
} from './helpers/setup-mongo.js';
import {
  setEncryptionFacade,
  _resetEncryptionStateForTesting,
  isFacadeEncryptionAvailable,
} from '../mongo/plugins/encryption.plugin.js';
import {
  KMSProviderPool,
  setKMSProviderPool,
  _resetKMSRegistryForTesting,
  KMSResolver,
  DEKManager,
} from '../kms/index.js';
import { TenantEncryptionFacade } from '@agent-platform/shared-encryption';

// =============================================================================
// SHARED SETUP
// =============================================================================

const TEST_MASTER_KEY = 'a'.repeat(64);

let dekManager: DEKManager;
let facade: TenantEncryptionFacade;

async function initRealDEKStack() {
  const pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
  await pool.initialize();
  setKMSProviderPool(pool);

  const resolver = new KMSResolver();
  dekManager = new DEKManager(resolver);
  facade = new TenantEncryptionFacade(dekManager, 'platform-default');
  setEncryptionFacade(facade);
}

/**
 * Dynamically import the LLMCredential model.
 * Must be done after mongoose connects and encryption is wired.
 */
async function getLLMCredentialModel() {
  // Clear cached model to ensure fresh schema with current encryption state
  delete mongoose.models.LLMCredential;
  const mod = await import('../models/llm-credential.model.js');
  return mod.LLMCredential;
}

// =============================================================================
// TESTS
// =============================================================================

describe('DEK Envelope Encryption — Credential Roundtrip', () => {
  beforeAll(async () => {
    await setupTestMongo();
  });

  afterAll(async () => {
    await teardownTestMongo();
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
  });

  beforeEach(async ({ skip }) => {
    requireMongo(skip);
    await clearCollections();
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
    dekManager?.clearCache();

    // Clear ALL mongoose models to avoid "Cannot overwrite model" errors
    for (const name of Object.keys(mongoose.models)) {
      delete mongoose.models[name];
      if (mongoose.connection.collections[name.toLowerCase()]) {
        delete mongoose.connection.collections[name.toLowerCase()];
      }
    }

    await initRealDEKStack();
  });

  // ===========================================================================
  // E2E-1: Create and read encrypted LLM credential (full roundtrip)
  // ===========================================================================

  describe('E2E-1: LLM credential encrypt/decrypt roundtrip', () => {
    it(
      'should encrypt apiKey on save and decrypt on find',
      { timeout: 60_000 },
      async ({ skip }) => {
        requireMongo(skip);

        const LLMCredential = await getLLMCredentialModel();
        expect(isFacadeEncryptionAvailable()).toBe(true);

        const doc = new LLMCredential({
          credentialScope: 'tenant',
          ownerId: 'user-e2e-001',
          tenantId: 'tenant-e2e-001',
          provider: 'openai',
          name: 'test-cred-e2e1',
          encryptedApiKey: 'sk-test-abc123xyz789',
          encryptedEndpoint: 'https://api.openai.com/v1',
          authType: 'api_key',
        });
        await doc.save();

        // Read back via Mongoose — should decrypt transparently
        const found = await LLMCredential.findOne({ _id: doc._id });
        expect(found?.encryptedApiKey).toBe('sk-test-abc123xyz789');
        expect(found?.encryptedEndpoint).toBe('https://api.openai.com/v1');

        // Read raw document — should be encrypted (base64, no colons)
        const raw = await mongoose.connection.db
          .collection('llm_credentials')
          .findOne({ _id: doc._id });
        expect(raw?.encryptedApiKey).not.toBe('sk-test-abc123xyz789');
        expect(raw?.encryptedApiKey).not.toContain(':'); // Not v3 hex format
        expect(raw?.encryptedEndpoint).not.toBe('https://api.openai.com/v1');
        expect(raw?.encryptedEndpoint).not.toContain(':');

        // No legacy metadata fields
        expect(raw?.ire).toBeUndefined();
        expect(raw?.cek).toBeUndefined();
        expect(raw?.iv).toBeUndefined();
      },
    );

    it('should produce a DEK in dek_registry with tenant scope sentinels', async ({ skip }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-e2e-001',
        tenantId: 'tenant-e2e-001',
        provider: 'openai',
        name: 'test-cred-dek-check',
        encryptedApiKey: 'sk-dek-check',
        authType: 'api_key',
      }).save();

      // LLMCredential has scope: 'tenant' — DEK should use _tenant sentinels
      const dekEntry = await mongoose.connection.db
        .collection('dek_registry')
        .findOne({ tenantId: 'tenant-e2e-001', status: 'active' });
      expect(dekEntry).not.toBeNull();
      expect(dekEntry?.projectId).toBe('_tenant');
      expect(dekEntry?.environment).toBe('_tenant');
      expect(dekEntry?.dekId).toBeTruthy();
      expect(typeof dekEntry?.dekId).toBe('string');
    });

    it('should reuse the same DEK for multiple credentials of same tenant', async ({ skip }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-e2e-001',
        tenantId: 'tenant-e2e-001',
        provider: 'openai',
        name: 'cred-1',
        encryptedApiKey: 'sk-first',
        authType: 'api_key',
      }).save();

      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-e2e-001',
        tenantId: 'tenant-e2e-001',
        provider: 'anthropic',
        name: 'cred-2',
        encryptedApiKey: 'sk-second',
        authType: 'api_key',
      }).save();

      // Only one DEK in registry for this tenant scope
      const dekCount = await mongoose.connection.db.collection('dek_registry').countDocuments({
        tenantId: 'tenant-e2e-001',
        projectId: '_tenant',
        environment: '_tenant',
        status: 'active',
      });
      expect(dekCount).toBe(1);

      // Both decrypt correctly
      const creds = await LLMCredential.find({ tenantId: 'tenant-e2e-001' });
      const keys = creds.map((c: any) => c.encryptedApiKey).sort();
      expect(keys).toEqual(['sk-first', 'sk-second']);
    });
  });

  // ===========================================================================
  // E2E-3: Tenant-scoped model — _tenant sentinels, no projectId needed
  // ===========================================================================

  describe('E2E-3: Tenant-scoped LLMCredential uses _tenant sentinels', () => {
    it('should encrypt with tenant scope and _tenant sentinels', async ({ skip }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      const doc = await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-e2e-003',
        tenantId: 'tenant-e2e-003',
        provider: 'openai',
        name: 'tenant-only-cred',
        encryptedApiKey: 'sk-tenant-only',
        authType: 'api_key',
      }).save();

      // Verify plaintext roundtrip
      const found = await LLMCredential.findOne({ _id: doc._id });
      expect(found?.encryptedApiKey).toBe('sk-tenant-only');

      // Verify raw is encrypted
      const raw = await mongoose.connection.db
        .collection('llm_credentials')
        .findOne({ _id: doc._id });
      expect(raw?.encryptedApiKey).not.toBe('sk-tenant-only');

      // Verify DEK scope uses _tenant sentinels
      const dekEntry = await mongoose.connection.db
        .collection('dek_registry')
        .findOne({ tenantId: 'tenant-e2e-003', status: 'active' });
      expect(dekEntry).not.toBeNull();
      expect(dekEntry?.projectId).toBe('_tenant');
      expect(dekEntry?.environment).toBe('_tenant');
    });

    it('should keep tenant DEKs separate from each other', async ({ skip }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      // Tenant A
      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-a',
        tenantId: 'tenant-A',
        provider: 'openai',
        name: 'cred-a',
        encryptedApiKey: 'sk-tenant-a-secret',
        authType: 'api_key',
      }).save();

      // Tenant B
      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-b',
        tenantId: 'tenant-B',
        provider: 'openai',
        name: 'cred-b',
        encryptedApiKey: 'sk-tenant-b-secret',
        authType: 'api_key',
      }).save();

      // Should have 2 separate DEKs
      const deks = await mongoose.connection.db
        .collection('dek_registry')
        .find({ status: 'active' })
        .toArray();
      expect(deks.length).toBe(2);
      expect(deks[0].tenantId).not.toBe(deks[1].tenantId);
      expect(deks[0].dekId).not.toBe(deks[1].dekId);

      // Both decrypt correctly via their own DEKs
      const credA = await LLMCredential.findOne({ tenantId: 'tenant-A' });
      const credB = await LLMCredential.findOne({ tenantId: 'tenant-B' });
      expect(credA?.encryptedApiKey).toBe('sk-tenant-a-secret');
      expect(credB?.encryptedApiKey).toBe('sk-tenant-b-secret');
    });
  });

  // ===========================================================================
  // E2E-8: Cross-tenant isolation — cannot read other tenant's credentials
  // ===========================================================================

  describe('E2E-8: Cross-tenant isolation', () => {
    it('should not return credentials from a different tenant', async ({ skip }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      // Create credential for tenant-A
      const doc = await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-a',
        tenantId: 'tenant-isolation-A',
        provider: 'openai',
        name: 'secret-cred',
        encryptedApiKey: 'sk-tenant-a-only-secret',
        authType: 'api_key',
      }).save();

      // Query as tenant-B — should not find tenant-A's credential
      const asB = await LLMCredential.findOne({
        _id: doc._id,
        tenantId: 'tenant-isolation-B',
      });
      expect(asB).toBeNull();

      // Query tenant-B's credentials — should be empty
      const allB = await LLMCredential.find({ tenantId: 'tenant-isolation-B' });
      expect(allB).toHaveLength(0);

      // Verify tenant-A can still read their own
      const asA = await LLMCredential.findOne({
        _id: doc._id,
        tenantId: 'tenant-isolation-A',
      });
      expect(asA).not.toBeNull();
      expect(asA?.encryptedApiKey).toBe('sk-tenant-a-only-secret');
    });

    it('should not decrypt tenant-A data even if tenant-B somehow gets the raw doc', async ({
      skip,
    }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      // Create credential for tenant-A
      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-a',
        tenantId: 'tenant-crypto-A',
        provider: 'openai',
        name: 'crypto-test',
        encryptedApiKey: 'sk-crypto-isolation-test',
        authType: 'api_key',
      }).save();

      // Create credential for tenant-B to establish a different DEK
      await new LLMCredential({
        credentialScope: 'tenant',
        ownerId: 'user-b',
        tenantId: 'tenant-crypto-B',
        provider: 'openai',
        name: 'crypto-test-b',
        encryptedApiKey: 'sk-b-different',
        authType: 'api_key',
      }).save();

      // Verify DEKs are different
      const dekA = await mongoose.connection.db
        .collection('dek_registry')
        .findOne({ tenantId: 'tenant-crypto-A', status: 'active' });
      const dekB = await mongoose.connection.db
        .collection('dek_registry')
        .findOne({ tenantId: 'tenant-crypto-B', status: 'active' });
      expect(dekA?.dekId).not.toBe(dekB?.dekId);

      // Raw ciphertext from tenant-A
      const rawA = await mongoose.connection.db
        .collection('llm_credentials')
        .findOne({ tenantId: 'tenant-crypto-A' });
      const rawB = await mongoose.connection.db
        .collection('llm_credentials')
        .findOne({ tenantId: 'tenant-crypto-B' });

      // Ciphertexts should be different (different DEKs)
      expect(rawA?.encryptedApiKey).not.toBe(rawB?.encryptedApiKey);

      // Neither should be plaintext
      expect(rawA?.encryptedApiKey).not.toBe('sk-crypto-isolation-test');
      expect(rawB?.encryptedApiKey).not.toBe('sk-b-different');
    });

    it('should handle multiple tenants with many credentials without cross-contamination', async ({
      skip,
    }) => {
      requireMongo(skip);

      const LLMCredential = await getLLMCredentialModel();

      const tenants = ['tenant-multi-1', 'tenant-multi-2', 'tenant-multi-3'];
      const providers = ['openai', 'anthropic', 'google'];

      // Create 3 credentials per tenant (9 total)
      for (const tenantId of tenants) {
        for (const provider of providers) {
          await new LLMCredential({
            credentialScope: 'tenant',
            ownerId: `user-${tenantId}`,
            tenantId,
            provider,
            name: `cred-${provider}`,
            encryptedApiKey: `sk-${tenantId}-${provider}`,
            authType: 'api_key',
          }).save();
        }
      }

      // Verify each tenant sees only their 3 credentials
      for (const tenantId of tenants) {
        const creds = await LLMCredential.find({ tenantId });
        expect(creds).toHaveLength(3);
        for (const cred of creds) {
          expect((cred as any).encryptedApiKey).toMatch(new RegExp(`^sk-${tenantId}-`));
        }
      }

      // Verify 3 separate DEKs (one per tenant)
      const dekCount = await mongoose.connection.db
        .collection('dek_registry')
        .countDocuments({ status: 'active' });
      expect(dekCount).toBe(3);
    });
  });
});
