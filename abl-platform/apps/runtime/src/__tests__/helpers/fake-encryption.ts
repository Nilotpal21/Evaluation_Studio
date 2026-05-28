/**
 * Shared test helpers for fake DEK envelope encryption.
 *
 * Produces syntactically valid DEK envelope ciphertext that is detected by
 * isAlreadyEncrypted() and isDEKEnvelopeFormat(), without requiring real KMS.
 * Wire format: base64(dekIdLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)
 */

import mongoose, { Schema, model } from 'mongoose';
import { encryptionPlugin, setMasterKey } from '@agent-platform/database/mongo';
import {
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
} from '@agent-platform/shared-encryption';
import { setupTestMongo, teardownTestMongo } from './setup-mongo.js';

// ─── DEK Envelope Helpers ───────────────────────────────────────────────

const DEFAULT_DEK_ID = 'test-dek-id-1234';

export function fakeDEKEncrypt(plaintext: string, dekId = DEFAULT_DEK_ID): string {
  const dekIdBytes = Buffer.from(dekId, 'utf8');
  const iv = Buffer.alloc(12, 0xaa);
  const authTag = Buffer.alloc(16, 0xbb);
  const ciphertext = Buffer.from(plaintext, 'utf8');
  return Buffer.concat([
    Buffer.from([dekIdBytes.length]),
    dekIdBytes,
    iv,
    authTag,
    ciphertext,
  ]).toString('base64');
}

export function fakeDEKDecrypt(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  const dekIdLen = buf[0];
  const payloadStart = 1 + dekIdLen + 12 + 16;
  return buf.subarray(payloadStart).toString('utf8');
}

// ─── Mock Encryption Facade ─────────────────────────────────────────────

export const testEncryptionFacade = {
  async encrypt(
    plaintext: string,
    _scope: { tenantId: string; projectId: string; environment: string },
    _aad?: unknown,
  ): Promise<string> {
    return fakeDEKEncrypt(plaintext);
  },
  async decrypt(
    ciphertext: string,
    _scope: { tenantId: string; projectId: string; environment: string },
    _aad?: unknown,
  ): Promise<string> {
    return fakeDEKDecrypt(ciphertext);
  },
};

/** Tenant field encryption service (for queue encrypt/decrypt wrappers) */
export const testFieldEncryptionService = {
  encryptForTenant: async (plaintext: string, _tenantId: string) => fakeDEKEncrypt(plaintext),
  decryptForTenant: async (ciphertext: string, _tenantId: string) => fakeDEKDecrypt(ciphertext),
};

// ─── Test Model Factory ─────────────────────────────────────────────────

const TEST_MASTER_KEY = '507f048e098f2282d72d04ccc02e84f9a0200ba23d154e31dfed46f507af0d66';

let modelCounter = 0;

/**
 * Create a Mongoose model with the encryption plugin for testing.
 * Each call creates a unique model name and collection to avoid conflicts.
 */
export function createEncryptedTestModel(collectionPrefix = 'test_enc') {
  modelCounter++;
  const name = `TestEncModel_${modelCounter}`;
  const collection = `${collectionPrefix}_${modelCounter}`;

  const schema = new Schema(
    {
      _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
      sessionId: { type: String, required: true },
      tenantId: { type: String, required: true },
      projectId: { type: String, required: true },
      role: { type: String, required: true },
      content: { type: String, required: true },
      channel: { type: String, default: 'api' },
    },
    { timestamps: true, collection },
  );

  schema.plugin(encryptionPlugin, {
    fieldsToEncrypt: ['content'],
    tenantIdField: 'tenantId',
    scope: 'project',
    scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
  });

  return model(name, schema);
}

/**
 * Setup: connect to MongoDB, set master key, install test facade.
 * Call in beforeAll.
 */
export async function setupTestEncryption(): Promise<void> {
  await setupTestMongo();
  setMasterKey(TEST_MASTER_KEY);
  setGlobalEncryptionFacade(testEncryptionFacade as any);
}

/**
 * Teardown: clear facade, disconnect.
 * Call in afterAll.
 */
export async function teardownTestEncryption(): Promise<void> {
  clearGlobalEncryptionFacade();
  await teardownTestMongo();
}
