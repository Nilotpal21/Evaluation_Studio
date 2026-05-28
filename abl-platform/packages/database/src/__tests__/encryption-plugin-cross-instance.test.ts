/**
 * Encryption Plugin — Cross-Instance Facade Resolution (ABLP-364)
 *
 * Reproduces the DEK facade dual-module-instance bug:
 *   - `dek-facade-factory.ts` resolves `setEncryptionFacade` via a relative
 *     dynamic import, which under tsx/ESM can resolve to a different
 *     module instance than what consumer code (e.g. the plugin's own
 *     `post('findOne')` hook) sees.
 *   - The bootstrap's module-local `encryptionFacade` is set on instance A.
 *   - The plugin hook runs on instance B, where module-local is `null`.
 *   - Before the fix: `isFacadeEncryptionAvailable()` returned `false` and
 *     decryption was silently skipped, leaving ciphertext in place.
 *
 * These tests simulate the dual-instance condition by writing the facade
 * only to `globalThis.__encryptionFacade` (via `setGlobalEncryptionFacade`)
 * and NOT to the plugin's module-local binding, then asserting that the
 * plugin still encrypts and decrypts correctly via the globalThis fallback.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import {
  isAlreadyEncrypted,
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
} from '@agent-platform/shared-encryption';
import {
  encryptionPlugin,
  isFacadeEncryptionAvailable,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';
import {
  setupTestMongo,
  teardownTestMongo,
  requireMongo,
  clearCollections,
} from './helpers/setup-mongo.js';

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

const createMockFacade = () => ({
  encrypt: vi.fn(
    async (
      plaintext: string,
      scope: { tenantId: string; projectId: string; environment: string },
      _context?: { fieldName: string; resourceType: string },
    ) => makeMockEnvelope(`${scope.tenantId}:${plaintext}`),
  ),
  decrypt: vi.fn(async (ciphertext: string, tenantId: string) => {
    if (!isAlreadyEncrypted(ciphertext)) throw new Error('Invalid DEK envelope format');
    const raw = parseMockEnvelope(ciphertext);
    const prefix = `${tenantId}:`;
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  }),
  encryptJson: vi.fn(),
  decryptJson: vi.fn(),
});

describe('encryption-plugin cross-instance facade resolution (ABLP-364)', () => {
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
    clearGlobalEncryptionFacade();

    const modelNames = Object.keys(mongoose.models);
    for (const name of modelNames) {
      delete mongoose.models[name];
      if (mongoose.connection.collections[name.toLowerCase()]) {
        delete mongoose.connection.collections[name.toLowerCase()];
      }
    }
  });

  it('isFacadeEncryptionAvailable() returns true when only globalThis facade is set', () => {
    expect(isFacadeEncryptionAvailable()).toBe(false);

    // Simulate the dual-instance scenario: bootstrap pushed the facade into
    // a *different* module instance, which forwarded it to globalThis.
    // The plugin's own module-local binding remains null.
    const mockFacade = createMockFacade();
    setGlobalEncryptionFacade(mockFacade as any);

    expect(isFacadeEncryptionAvailable()).toBe(true);

    clearGlobalEncryptionFacade();
    expect(isFacadeEncryptionAvailable()).toBe(false);
  });

  it('decrypts fields via globalThis facade when module-local is null (the original bug)', async ({
    skip,
  }) => {
    requireMongo(skip);

    // Stage 1 — set facade via BOTH paths, save an encrypted doc.
    // This matches how a correctly-wired process writes records.
    const mockFacade = createMockFacade();
    setGlobalEncryptionFacade(mockFacade as any);
    // Directly poke the module-local too so the save path works. In
    // production the bootstrap sets both via `setEncryptionFacade`.
    const pluginModule = await import('../mongo/plugins/encryption.plugin.js');
    pluginModule.setEncryptionFacade(mockFacade as any);

    const schema = new Schema({
      tenantId: String,
      encryptedApiKey: String,
      encryptedEndpoint: String,
    });
    schema.plugin(encryptionPlugin, {
      fieldsToEncrypt: ['encryptedApiKey', 'encryptedEndpoint'],
    });
    const Model = mongoose.model('DualInstanceLLMCred', schema);

    const saved = await Model.create({
      tenantId: 'tenant-A',
      encryptedApiKey: 'sk-plaintext-key',
      encryptedEndpoint: 'https://api.example.com',
    });
    expect(isAlreadyEncrypted(saved.encryptedApiKey)).toBe(true);
    expect(isAlreadyEncrypted(saved.encryptedEndpoint)).toBe(true);

    // Stage 2 — simulate the dual-instance condition on the *read* side:
    // blow away the module-local binding, leaving the globalThis facade
    // as the only way the plugin can find the facade. This is exactly
    // what happens to consumer code in a separate tsx/ESM module graph.
    _resetEncryptionStateForTesting();
    setGlobalEncryptionFacade(mockFacade as any);

    const found = await Model.findOne({ tenantId: 'tenant-A' });
    expect(found).not.toBeNull();

    // Before the fix: these would be ciphertext ("dek_mock_..."), and
    // `_decryptionFailed` would NOT be set (silent skip at the facade
    // availability check). That's how raw ciphertext leaked into
    // `createVercelProvider({ baseURL })` and produced
    // `Failed to parse URL from <ciphertext>/chat/completions`.
    expect(found!.encryptedApiKey).toBe('sk-plaintext-key');
    expect(found!.encryptedEndpoint).toBe('https://api.example.com');
    expect((found as any)._decryptionFailed).toBeUndefined();
  });

  it('encrypts on save via globalThis facade when module-local is null', async ({ skip }) => {
    requireMongo(skip);

    const mockFacade = createMockFacade();
    // Only the globalThis path is set — no setEncryptionFacade() call.
    setGlobalEncryptionFacade(mockFacade as any);

    const schema = new Schema({ tenantId: String, secret: String });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
    const Model = mongoose.model('DualInstanceSaveOnly', schema);

    const saved = await Model.create({ tenantId: 'tenant-B', secret: 'hunter2' });

    expect(mockFacade.encrypt).toHaveBeenCalledWith(
      'hunter2',
      {
        tenantId: 'tenant-B',
        projectId: '_tenant',
        environment: '_tenant',
      },
      { fieldName: 'secret', resourceType: 'dualinstancesaveonlies' },
    );
    expect(isAlreadyEncrypted(saved.secret)).toBe(true);
  });

  it('prefers the module-local binding over the globalThis fallback', async () => {
    // Guard rail: if someone injects two different facades (module-local
    // vs globalThis), we want the explicit setEncryptionFacade() winner
    // to take precedence — it represents the caller who knows about this
    // particular plugin module instance.
    const localFacade = createMockFacade();
    const globalFacade = createMockFacade();

    const pluginModule = await import('../mongo/plugins/encryption.plugin.js');
    pluginModule.setEncryptionFacade(localFacade as any);
    // Overwrite globalThis with a different instance
    setGlobalEncryptionFacade(globalFacade as any);

    expect(isFacadeEncryptionAvailable()).toBe(true);

    // Trigger a decrypt through the plugin by running a pre-seeded find.
    // Easier: directly assert via an encrypt, which routes through the
    // same getActiveFacade() path.
    const schema = new Schema({ tenantId: String, secret: String });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
    const Model = mongoose.model('PrecedenceCheck', schema);

    await Model.create({ tenantId: 'tenant-C', secret: 'use-local' });

    // The module-local facade should be the one invoked, not the global.
    expect(localFacade.encrypt).toHaveBeenCalledWith(
      'use-local',
      {
        tenantId: 'tenant-C',
        projectId: '_tenant',
        environment: '_tenant',
      },
      { fieldName: 'secret', resourceType: 'precedencechecks' },
    );
    expect(globalFacade.encrypt).not.toHaveBeenCalled();
  });
});
