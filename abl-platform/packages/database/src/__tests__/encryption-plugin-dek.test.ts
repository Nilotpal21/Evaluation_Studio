/**
 * Encryption Plugin DEK Envelope Tests
 *
 * UT-22 through UT-25 from test spec.
 * Tests the DEK facade-based encryption path in the Mongoose plugin.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { isAlreadyEncrypted, setGlobalEncryptionFacade } from '@agent-platform/shared-encryption';
import {
  encryptionPlugin,
  setEncryptionFacade,
  isFacadeEncryptionAvailable,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';
import {
  setupTestMongo,
  teardownTestMongo,
  requireMongo,
  clearCollections,
} from './helpers/setup-mongo.js';

// Mock facade for testing
const MOCK_DEK_ID = 'mock-dek-id';

function makeMockEnvelope(plaintext: string): string {
  const dekId = Buffer.from(MOCK_DEK_ID, 'utf8');
  const iv = Buffer.alloc(12, 1);
  const authTag = Buffer.alloc(16, 2);
  const ciphertext = Buffer.from(plaintext, 'utf8');
  return Buffer.concat([Buffer.from([dekId.length]), dekId, iv, authTag, ciphertext]).toString(
    'base64',
  );
}

function parseMockEnvelope(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const dekIdLen = buf[0];
  if (typeof dekIdLen !== 'number' || dekIdLen <= 0) {
    throw new Error('Invalid DEK envelope format');
  }
  const payloadOffset = 1 + dekIdLen + 12 + 16;
  if (buf.length < payloadOffset) {
    throw new Error('Invalid DEK envelope format');
  }
  return buf.subarray(payloadOffset).toString('utf8');
}

const createMockFacade = () => {
  return {
    encrypt: vi.fn(
      async (
        plaintext: string,
        scope: { tenantId: string; projectId: string; environment: string },
        _context?: { fieldName: string; resourceType: string },
      ) => {
        // Simulate DEK envelope format encryption with a valid wire shape.
        return makeMockEnvelope(`${scope.tenantId}:${plaintext}`);
      },
    ),
    decrypt: vi.fn(async (ciphertext: string, tenantId: string) => {
      // Simulate DEK envelope format decryption.
      if (isAlreadyEncrypted(ciphertext)) {
        const raw = parseMockEnvelope(ciphertext);
        const prefix = `${tenantId}:`;
        return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      }
      throw new Error('Invalid DEK envelope format');
    }),
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
  };
};

describe('encryption-plugin DEK envelope', () => {
  beforeAll(async () => {
    await setupTestMongo();
  });

  afterAll(async () => {
    await teardownTestMongo();
  });

  beforeEach(async ({ skip }) => {
    requireMongo(skip);
    await clearCollections();
    _resetEncryptionStateForTesting();

    // Clear ALL mongoose models to avoid "Cannot overwrite model" errors
    const modelNames = Object.keys(mongoose.models);
    for (const name of modelNames) {
      delete mongoose.models[name];
      if (mongoose.connection.collections[name.toLowerCase()]) {
        delete mongoose.connection.collections[name.toLowerCase()];
      }
    }
  });

  describe('facade injection (UT-22)', () => {
    it('should expose setEncryptionFacade and check availability', () => {
      expect(isFacadeEncryptionAvailable()).toBe(false);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      expect(isFacadeEncryptionAvailable()).toBe(true);

      _resetEncryptionStateForTesting();
      expect(isFacadeEncryptionAvailable()).toBe(false);
    });

    it('treats a global facade bridge as available', () => {
      expect(isFacadeEncryptionAvailable()).toBe(false);

      const mockFacade = createMockFacade();
      setGlobalEncryptionFacade(mockFacade as any);

      expect(isFacadeEncryptionAvailable()).toBe(true);
    });
  });

  describe('pre-save encrypts via facade (UT-22)', () => {
    it('should encrypt fields using facade when available', async ({ skip }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
        secret: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey', 'secret'] });

      const TestModelDEK = mongoose.model('TestModelDEK', schema);
      const doc = new TestModelDEK({
        tenantId: 'tenant-123',
        apiKey: 'my-api-key',
        secret: 'my-secret',
      });

      await doc.save();

      // Verify facade.encrypt was called for both fields
      expect(mockFacade.encrypt).toHaveBeenCalledTimes(2);
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'my-api-key',
        {
          tenantId: 'tenant-123',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'apiKey', resourceType: 'testmodeldeks' },
      );
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'my-secret',
        {
          tenantId: 'tenant-123',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'secret', resourceType: 'testmodeldeks' },
      );

      // Verify fields are now encrypted in DEK envelope format.
      expect(isAlreadyEncrypted(doc.apiKey)).toBe(true);
      expect(isAlreadyEncrypted(doc.secret)).toBe(true);

      // Verify NO metadata fields are set (DEK envelope has no ire/cek/iv)
      expect((doc as any).ire).toBeUndefined();
      expect((doc as any).cek).toBeUndefined();
      expect((doc as any).iv).toBeUndefined();
    });

    it('should encrypt fields using the global facade bridge when local module state is empty', async ({
      skip,
    }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setGlobalEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const GlobalFacadeModel = mongoose.model('GlobalFacadeModel', schema);
      const doc = new GlobalFacadeModel({
        tenantId: 'tenant-global',
        apiKey: 'shared-secret',
      });

      await doc.save();

      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'shared-secret',
        {
          tenantId: 'tenant-global',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'apiKey', resourceType: 'globalfacademodels' },
      );
      expect(isAlreadyEncrypted(doc.apiKey)).toBe(true);
    });

    it('should handle skipTenantScoping with tenantId=system (UT-22)', async ({ skip }) => {
      const mockFacade = createMockFacade();
      requireMongo(skip);
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        username: String,
        password: String,
      });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['password'],
        skipTenantScoping: true,
      });

      const UserDEK = mongoose.model('User', schema);
      const doc = new UserDEK({
        username: 'admin',
        password: 'secret123',
      });

      await doc.save();

      // Verify facade.encrypt was called with tenantId='system'
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'secret123',
        {
          tenantId: 'system',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'password', resourceType: 'users' },
      );
      expect(isAlreadyEncrypted(doc.password)).toBe(true);
    });

    it('should handle JSON values (UT-22)', async ({ skip }) => {
      const mockFacade = createMockFacade();
      requireMongo(skip);
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        metadata: Schema.Types.Mixed,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['metadata'] });

      const TestModelDEKJson = mongoose.model('TestModelDEKJson', schema);
      const doc = new TestModelDEKJson({
        tenantId: 'tenant-123',
        metadata: { nested: { value: 42 } },
      });

      await doc.save();

      // JSON.stringify was called before encryption
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        '{"nested":{"value":42}}',
        {
          tenantId: 'tenant-123',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'metadata', resourceType: 'testmodeldekjsons' },
      );
    });
  });

  describe('post-find decrypts via facade (UT-23)', () => {
    it('should decrypt fields using facade', async ({ skip }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const TestModelDEKDecrypt = mongoose.model('TestModelDEKDecrypt', schema);

      // First encrypt and save a document
      const doc = new TestModelDEKDecrypt({
        tenantId: 'tenant-123',
        apiKey: 'my-api-key',
      });
      await doc.save();

      // Clear the mock to isolate decrypt calls
      mockFacade.decrypt.mockClear();

      // Now retrieve the document, which should trigger decryption
      const retrieved = await TestModelDEKDecrypt.findOne({ tenantId: 'tenant-123' });

      // Verify facade.decrypt was called
      expect(mockFacade.decrypt).toHaveBeenCalled();
      expect(retrieved?.apiKey).toBe('my-api-key'); // Should be decrypted
    });

    it('nulls fields and marks the document when facade decryption fails', async ({ skip }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const TestModelDEKDecryptFailure = mongoose.model('TestModelDEKDecryptFailure', schema);

      const doc = new TestModelDEKDecryptFailure({
        tenantId: 'tenant-123',
        apiKey: 'my-api-key',
      });
      await doc.save();

      mockFacade.decrypt.mockRejectedValueOnce(new Error('decrypt failed'));

      const retrieved = await TestModelDEKDecryptFailure.findOne({ tenantId: 'tenant-123' });

      expect(retrieved?.apiKey).toBeNull();
      expect((retrieved as { _decryptionFailed?: boolean } | null)?._decryptionFailed).toBe(true);
    });

    it('nulls fields and marks legacy encrypted documents as decryption failures', async ({
      skip,
    }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const LegacyEncryptedModel = mongoose.model('LegacyEncryptedModel', schema);
      await LegacyEncryptedModel.collection.insertOne({
        tenantId: 'tenant-legacy',
        apiKey: 'legacy-ciphertext-value',
        ire: 'v2',
        cek: 'legacy-cek',
        iv: 'legacy-iv',
        fieldsToEncrypt: ['apiKey'],
      });

      const retrieved = await LegacyEncryptedModel.findOne({ tenantId: 'tenant-legacy' });

      expect(retrieved?.apiKey).toBeNull();
      expect((retrieved as { _decryptionFailed?: boolean } | null)?._decryptionFailed).toBe(true);
    });

    it('leaves scrubbed plaintext untouched when it is no longer encrypted', async ({ skip }) => {
      requireMongo(skip);

      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
        scrubbed: Boolean,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const PlaintextOptOutModel = mongoose.model('PlaintextOptOutModel', schema);
      await PlaintextOptOutModel.collection.insertOne({
        tenantId: 'tenant-plaintext',
        apiKey: '[REDACTED]',
        scrubbed: true,
      });

      const retrieved = await PlaintextOptOutModel.findOne({ tenantId: 'tenant-plaintext' });

      expect(mockFacade.decrypt).not.toHaveBeenCalled();
      expect(retrieved?.apiKey).toBe('[REDACTED]');
      expect((retrieved as { _decryptionFailed?: boolean } | null)?._decryptionFailed).toBeFalsy();
    });
  });

  describe('nested JSON handling (UT-24)', () => {
    it('should roundtrip nested JSON via facade', async ({ skip }) => {
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        config: Schema.Types.Mixed,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['config'] });

      const TestModelDEKNestedJson = mongoose.model('TestModelDEKNestedJson', schema);
      const doc = new TestModelDEKNestedJson({
        tenantId: 'tenant-123',
        config: {
          database: { host: 'localhost', port: 5432 },
          api: { key: 'secret-key', timeout: 30 },
        },
      });

      await doc.save();

      // JSON stringified before encryption
      const encrypted = doc.config;
      expect(isAlreadyEncrypted(encrypted)).toBe(true);

      // Parse the mock format to verify JSON was stringified
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        expect.stringContaining('database'),
        {
          tenantId: 'tenant-123',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'config', resourceType: 'testmodeldeknestedjsons' },
      );
    });
  });

  describe('missing fields handling (UT-25)', () => {
    it('should gracefully handle null fields', async ({ skip }) => {
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
        secret: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey', 'secret'] });

      const TestModelDEKNull = mongoose.model('TestModelDEKNull', schema);
      const doc = new TestModelDEKNull({
        tenantId: 'tenant-123',
        apiKey: 'my-key',
        secret: null,
      });

      await doc.save();

      // Only apiKey was encrypted (secret is null)
      expect(mockFacade.encrypt).toHaveBeenCalledTimes(1);
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'my-key',
        {
          tenantId: 'tenant-123',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'apiKey', resourceType: 'testmodeldeknulls' },
      );
      expect(doc.secret).toBeNull();
    });

    it('should gracefully handle undefined fields', async ({ skip }) => {
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
        optional: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey', 'optional'] });

      const TestModelDEKUndef = mongoose.model('TestModelDEKUndef', schema);
      const doc = new TestModelDEKUndef({
        tenantId: 'tenant-123',
        apiKey: 'my-key',
        // optional is undefined
      });

      await doc.save();

      // Only apiKey was encrypted
      expect(mockFacade.encrypt).toHaveBeenCalledTimes(1);
      expect(doc.optional).toBeUndefined();
    });

    it('should throw if tenantId is missing and not skipTenantScoping', async ({ skip }) => {
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        apiKey: String,
      });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const TestModelDEKNoTenant = mongoose.model('TestModelDEKNoTenant', schema);
      const doc = new TestModelDEKNoTenant({
        // tenantId missing!
        apiKey: 'my-key',
      });

      await expect(doc.save()).rejects.toThrow('Encryption requires tenantId');
    });
  });

  describe('FR-17: insertMany double-encryption guard', () => {
    it('should encrypt bulk docs via facade in insertMany', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({ tenantId: String, apiKey: String }, { collection: 'bulkmodels' });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const BulkModel = mongoose.model('BulkModel', schema);
      await BulkModel.insertMany([
        { tenantId: 'tenant-1', apiKey: 'key-a' },
        { tenantId: 'tenant-1', apiKey: 'key-b' },
      ]);

      // Facade encrypt called for each doc's encrypted field
      expect(mockFacade.encrypt).toHaveBeenCalledTimes(2);
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'key-a',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        expect.objectContaining({ fieldName: 'apiKey', resourceType: 'bulkmodels' }),
      );
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'key-b',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        expect.objectContaining({ fieldName: 'apiKey', resourceType: 'bulkmodels' }),
      );
    });

    it('should reject pre-encrypted values in insertMany (double-encryption guard)', async ({
      skip,
    }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({ tenantId: String, apiKey: String });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const BulkGuardModel = mongoose.model('BulkGuardModel', schema);

      // Pre-encrypted value (v3 format: three hex parts separated by colons)
      const preEncrypted = 'a'.repeat(64) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(64);

      await expect(
        BulkGuardModel.insertMany([{ tenantId: 'tenant-1', apiKey: preEncrypted }]),
      ).rejects.toThrow(/[Dd]ouble encryption rejected/);
    });

    it('should require tenantId in insertMany for tenant-scoped models', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({ tenantId: String, apiKey: String });
      schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['apiKey'] });

      const BulkNoTenantModel = mongoose.model('BulkNoTenantModel', schema);

      await expect(BulkNoTenantModel.insertMany([{ apiKey: 'some-key' }])).rejects.toThrow(
        /tenantId/i,
      );
    });
  });

  describe('per-model scope declarations (UT-42, UT-43, UT-44)', () => {
    it('UT-42: tenant scope uses _tenant for projectId and environment', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({ tenantId: String, apiKey: String });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['apiKey'],
        scope: 'tenant',
        scopeFields: { tenantId: 'tenantId' },
      });

      const TenantScopeModel = mongoose.model('TenantScopeModel', schema);
      const doc = new TenantScopeModel({ tenantId: 'tenant-42', apiKey: 'secret' });
      await doc.save();

      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'secret',
        {
          tenantId: 'tenant-42',
          projectId: '_tenant',
          environment: '_tenant',
        },
        { fieldName: 'apiKey', resourceType: 'tenantscopemodels' },
      );
    });

    it('UT-43: project scope reads projectId from doc field', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        projectId: String,
        secret: String,
      });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['secret'],
        scope: 'project',
        scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
      });

      const ProjectScopeModel = mongoose.model('ProjectScopeModel', schema);
      const doc = new ProjectScopeModel({
        tenantId: 'tenant-43',
        projectId: 'proj-abc',
        secret: 'my-secret',
      });
      await doc.save();

      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'my-secret',
        {
          tenantId: 'tenant-43',
          projectId: 'proj-abc',
          environment: '_shared',
        },
        { fieldName: 'secret', resourceType: 'projectscopemodels' },
      );
    });

    it('UT-43: project scope throws when projectId is missing', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        projectId: String,
        secret: String,
      });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['secret'],
        scope: 'project',
        scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
      });

      const ProjectNoIdModel = mongoose.model('ProjectNoIdModel', schema);
      const doc = new ProjectNoIdModel({
        tenantId: 'tenant-43',
        // projectId missing!
        secret: 'my-secret',
      });

      await expect(doc.save()).rejects.toThrow("scope='project' requires");
    });

    it('UT-44: project scope reads environment from doc field', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        projectId: String,
        environment: String,
        value: String,
      });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['value'],
        scope: 'project',
        scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' },
      });

      const EnvScopeModel = mongoose.model('EnvScopeModel', schema);
      const doc = new EnvScopeModel({
        tenantId: 'tenant-44',
        projectId: 'proj-xyz',
        environment: 'production',
        value: 'env-secret',
      });
      await doc.save();

      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'env-secret',
        {
          tenantId: 'tenant-44',
          projectId: 'proj-xyz',
          environment: 'production',
        },
        { fieldName: 'value', resourceType: 'envscopemodels' },
      );
    });

    it('UT-44: project scope falls back to _shared when no env on doc', async ({ skip }) => {
      requireMongo(skip);
      const mockFacade = createMockFacade();
      setEncryptionFacade(mockFacade as any);

      const schema = new Schema({
        tenantId: String,
        projectId: String,
        secret: String,
      });
      schema.plugin(encryptionPlugin, {
        fieldsToEncrypt: ['secret'],
        scope: 'project',
        scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
      });

      const NoEnvModel = mongoose.model('NoEnvModel', schema);
      const doc = new NoEnvModel({
        tenantId: 'tenant-44',
        projectId: 'proj-noenv',
        secret: 'no-env-secret',
      });
      await doc.save();

      // No environment field declared, no ALS — falls back to '_shared'
      expect(mockFacade.encrypt).toHaveBeenCalledWith(
        'no-env-secret',
        {
          tenantId: 'tenant-44',
          projectId: 'proj-noenv',
          environment: '_shared',
        },
        { fieldName: 'secret', resourceType: 'noenvmodels' },
      );
    });
  });
});
