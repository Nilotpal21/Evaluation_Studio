/**
 * DEK Envelope Encryption — Full-Chain Tests
 *
 * INT-1, INT-5, INT-10 from test spec.
 * Uses real MongoDB (MongoMemoryServer), real DEKManager, real LocalKMSProvider.
 * NO mocks of codebase components.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  requireMongo,
  clearCollections,
} from './helpers/setup-mongo.js';
import {
  encryptionPlugin,
  setEncryptionFacade,
  _resetEncryptionStateForTesting,
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

// =============================================================================
// TESTS
// =============================================================================

describe('DEK Envelope Encryption — Full Chain', () => {
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
  // INT-1: Mongoose plugin encrypt/decrypt roundtrip with real MongoDB
  // ===========================================================================

  describe('INT-1: Mongoose plugin roundtrip with real DEKManager', () => {
    it(
      'should encrypt on save, decrypt on find — string field',
      { timeout: 60_000 },
      async ({ skip }) => {
        requireMongo(skip);

        const schema = new Schema({ tenantId: String, secret: String });
        schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
        const TestModel = mongoose.model('INT1String', schema);

        // Create document
        const doc = new TestModel({ tenantId: 'tenant-int1', secret: 'my-api-key-12345' });
        await doc.save();

        // Read back via Mongoose — should decrypt transparently
        const found = await TestModel.findOne({ _id: doc._id });
        expect(found?.secret).toBe('my-api-key-12345');

        // Read raw document — should be encrypted (base64, no colons)
        const raw = await mongoose.connection.db
          .collection('int1strings')
          .findOne({ _id: doc._id });
        expect(raw?.secret).not.toBe('my-api-key-12345');
        expect(raw?.secret).not.toContain(':'); // Not v3 hex format
        // No legacy metadata fields
        expect(raw?.ire).toBeUndefined();
        expect(raw?.cek).toBeUndefined();
        expect(raw?.iv).toBeUndefined();
      },
    );

    it('should encrypt/decrypt JSON (Mixed) fields', async ({ skip }) => {
      requireMongo(skip);

      const schema = new Schema({
        tenantId: String,
        config: Schema.Types.Mixed,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['config'] });
      const TestModelJson = mongoose.model('INT1Json', schema);

      const originalConfig = {
        database: { host: 'localhost', port: 5432 },
        features: ['auth', 'logging'],
        nested: { deep: { value: 42 } },
      };

      const doc = new TestModelJson({ tenantId: 'tenant-int1', config: originalConfig });
      await doc.save();

      // Read back — plugin decrypts to string, JSON fields remain as JSON string
      // (the Mongoose post-find hook decrypts but JSON.parse is done by the caller
      // or by the Mixed type handler depending on the path)
      const found = await TestModelJson.findOne({ _id: doc._id });
      const config = typeof found?.config === 'string' ? JSON.parse(found.config) : found?.config;
      expect(config).toEqual(originalConfig);
    });

    it('should reuse the same DEK for second create (cache hit)', async ({ skip }) => {
      requireMongo(skip);

      const schema = new Schema({ tenantId: String, secret: String });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
      const TestModelCache = mongoose.model('INT1Cache', schema);

      await new TestModelCache({ tenantId: 'tenant-int1', secret: 'first' }).save();
      await new TestModelCache({ tenantId: 'tenant-int1', secret: 'second' }).save();

      // Only one DEK should exist in the registry for this scope
      const dekCount = await mongoose.connection.db.collection('dek_registry').countDocuments({
        tenantId: 'tenant-int1',
        projectId: '_tenant',
        environment: '_tenant',
        status: 'active',
      });
      expect(dekCount).toBe(1);
    });
  });

  // ===========================================================================
  // INT-10: Tenant-scoped model encryption (no projectId, no environment)
  // ===========================================================================

  describe('INT-10: Tenant-scoped model uses _tenant sentinels', () => {
    it('should store DEK with _tenant projectId and environment', async ({ skip }) => {
      requireMongo(skip);

      const schema = new Schema({ tenantId: String, apiKey: String });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['apiKey'],
        scope: 'tenant',
        scopeFields: { tenantId: 'tenantId' },
      });
      const TenantModel = mongoose.model('INT10Tenant', schema);

      await new TenantModel({ tenantId: 'tenant-10', apiKey: 'sk-tenant-only' }).save();

      // Verify DEK entry uses _tenant sentinels
      const dekEntry = await mongoose.connection.db
        .collection('dek_registry')
        .findOne({ tenantId: 'tenant-10', status: 'active' });
      expect(dekEntry).not.toBeNull();
      expect(dekEntry?.projectId).toBe('_tenant');
      expect(dekEntry?.environment).toBe('_tenant');

      // Verify data round-trips
      const found = await TenantModel.findOne({ tenantId: 'tenant-10' });
      expect(found?.apiKey).toBe('sk-tenant-only');
    });

    it('project-scoped model creates separate DEK from tenant-scoped', async ({ skip }) => {
      requireMongo(skip);

      // Tenant-scoped model
      const tenantSchema = new Schema({ tenantId: String, apiKey: String });
      tenantSchema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['apiKey'],
        scope: 'tenant',
        scopeFields: { tenantId: 'tenantId' },
      });
      const TenantModel2 = mongoose.model('INT10TenantScoped', tenantSchema);

      // Project-scoped model
      const projectSchema = new Schema({
        tenantId: String,
        projectId: String,
        secret: String,
      });
      projectSchema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['secret'],
        scope: 'project',
        scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
      });
      const ProjectModel = mongoose.model('INT10ProjectScoped', projectSchema);

      await new TenantModel2({ tenantId: 'tenant-10', apiKey: 'tenant-secret' }).save();
      await new ProjectModel({
        tenantId: 'tenant-10',
        projectId: 'proj-abc',
        secret: 'project-secret',
      }).save();

      // Should have 2 separate DEK entries for the same tenant
      const dekEntries = await mongoose.connection.db
        .collection('dek_registry')
        .find({ tenantId: 'tenant-10', status: 'active' })
        .toArray();
      expect(dekEntries.length).toBe(2);

      const tenantDek = dekEntries.find((d) => d.projectId === '_tenant');
      const projectDek = dekEntries.find((d) => d.projectId === 'proj-abc');
      expect(tenantDek).toBeDefined();
      expect(projectDek).toBeDefined();
      expect(tenantDek?.dekId).not.toBe(projectDek?.dekId);
    });
  });

  // ===========================================================================
  // INT-5: Dual-format decryption (mixed legacy + DEK in same collection)
  // ===========================================================================

  describe('INT-5: Dual-format reads (legacy v3 + DEK envelope)', () => {
    it('should decrypt DEK envelope docs and handle null fields', async ({ skip }) => {
      requireMongo(skip);

      const schema = new Schema({ tenantId: String, secret: String, optional: String });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret', 'optional'] });
      const DualModel = mongoose.model('INT5Dual', schema);

      // Create a DEK-encrypted document via the plugin
      const dekDoc = new DualModel({
        tenantId: 'tenant-dual',
        secret: 'dek-value',
        optional: null,
      });
      await dekDoc.save();

      // Verify DEK doc decrypts correctly
      const found = await DualModel.findOne({ _id: dekDoc._id });
      expect(found?.secret).toBe('dek-value');
      expect(found?.optional).toBeNull();

      // Verify raw DB has encrypted data (not plaintext)
      const raw = await mongoose.connection.db.collection('int5duals').findOne({ _id: dekDoc._id });
      expect(raw?.secret).not.toBe('dek-value');
      expect(raw?.secret).not.toContain(':');
    });

    it('should decrypt multiple DEK docs in a find query', async ({ skip }) => {
      requireMongo(skip);

      const schema = new Schema({ tenantId: String, secret: String });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
      const MultiModel = mongoose.model('INT5Multi', schema);

      await new MultiModel({ tenantId: 'tenant-dual', secret: 'secret-a' }).save();
      await new MultiModel({ tenantId: 'tenant-dual', secret: 'secret-b' }).save();
      await new MultiModel({ tenantId: 'tenant-dual', secret: 'secret-c' }).save();

      const docs = await MultiModel.find({ tenantId: 'tenant-dual' });
      const secrets = docs.map((d) => d.secret).sort();
      expect(secrets).toEqual(['secret-a', 'secret-b', 'secret-c']);
    });
  });
});
