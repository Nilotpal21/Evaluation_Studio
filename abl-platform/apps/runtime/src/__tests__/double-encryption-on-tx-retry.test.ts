/**
 * Double Encryption on Transaction Retry — Reproduction Test
 *
 * Proves that the Mongoose encryption plugin's in-place mutation of doc objects
 * during pre('insertMany') causes "Double encryption rejected" errors when
 * the same doc array is reused (e.g., via withTransaction retry or shared refs).
 *
 * This test does NOT mock any platform components. It uses the real encryption
 * plugin attached to a real Mongoose schema against real MongoDB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isAlreadyEncrypted } from '@agent-platform/shared-encryption';
import { wrapJobDataForEncrypt, unwrapJobDataForDecrypt } from '@agent-platform/shared/encryption';
import {
  createEncryptedTestModel,
  setupTestEncryption,
  teardownTestEncryption,
  testFieldEncryptionService,
} from './helpers/fake-encryption.js';

const TestMessage = createEncryptedTestModel('test_double_enc');

describe('Double Encryption on Transaction Retry', () => {
  beforeAll(setupTestEncryption);

  afterAll(async () => {
    await TestMessage.deleteMany({});
    await teardownTestEncryption();
  });

  it('insertMany encrypts content in-place, causing double-encryption on reuse', async () => {
    const mappedMessages = [
      {
        sessionId: 'sess-001',
        tenantId: 'tenant-test-001',
        projectId: 'proj-test-001',
        role: 'user',
        content: 'Hello, this is a plaintext message',
        channel: 'api',
      },
      {
        sessionId: 'sess-001',
        tenantId: 'tenant-test-001',
        projectId: 'proj-test-001',
        role: 'assistant',
        content: 'Hi there, I can help you',
        channel: 'api',
      },
    ];

    expect(mappedMessages[0].content).toBe('Hello, this is a plaintext message');

    // First call: insertMany mutates docs in-place
    await TestMessage.insertMany(mappedMessages, { ordered: false });

    // PROOF: original objects are now ciphertext (DEK envelope = base64)
    expect(mappedMessages[0].content).not.toBe('Hello, this is a plaintext message');
    expect(mappedMessages[0].content).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // Second call with same objects → double encryption rejected
    await expect(TestMessage.insertMany(mappedMessages, { ordered: false })).rejects.toThrow(
      /Double encryption rejected/,
    );
  });

  it('queue encrypt → decrypt round-trip leaves content as plaintext for Mongoose', async () => {
    const originalMsg = {
      tenantId: 'tenant-test-001',
      projectId: 'proj-test-001',
      sessionId: 'sess-queue-001',
      role: 'user',
      content: 'plaintext message for queue test',
      channel: 'api',
    };

    const encrypted = await wrapJobDataForEncrypt(
      'message-persistence',
      { ...originalMsg } as Record<string, unknown>,
      testFieldEncryptionService,
    );
    expect((encrypted.content as string).startsWith('ENC:v3:')).toBe(true);

    const decrypted = await unwrapJobDataForDecrypt(
      'message-persistence',
      encrypted,
      testFieldEncryptionService,
    );
    expect(decrypted.content).toBe('plaintext message for queue test');

    await expect(
      TestMessage.insertMany([{ ...(decrypted as Record<string, unknown>), _enc: undefined }], {
        ordered: false,
      }),
    ).resolves.not.toThrow();
  });

  it('queue decrypt failure leaves ENC:v3: prefix → Mongoose rejects', async () => {
    const encrypted = await wrapJobDataForEncrypt(
      'message-persistence',
      {
        tenantId: 'tenant-test-001',
        projectId: 'proj-test-001',
        sessionId: 'sess-queue-002',
        role: 'user',
        content: 'this will be double encrypted',
        channel: 'api',
      } as Record<string, unknown>,
      testFieldEncryptionService,
    );

    expect(isAlreadyEncrypted(encrypted.content as string)).toBe(true);

    await expect(
      TestMessage.insertMany([{ ...(encrypted as Record<string, unknown>), _enc: undefined }], {
        ordered: false,
      }),
    ).rejects.toThrow(/Double encryption rejected/);
  });

  it('structuredClone prevents double-encryption on retry', async () => {
    const mappedMessages = [
      {
        sessionId: 'sess-002',
        tenantId: 'tenant-test-001',
        projectId: 'proj-test-001',
        role: 'user',
        content: 'This message should survive retry',
        channel: 'api',
      },
    ];

    await TestMessage.insertMany(structuredClone(mappedMessages), { ordered: false });
    expect(mappedMessages[0].content).toBe('This message should survive retry');

    await expect(
      TestMessage.insertMany(structuredClone(mappedMessages), { ordered: false }),
    ).resolves.not.toThrow();
  });
});
