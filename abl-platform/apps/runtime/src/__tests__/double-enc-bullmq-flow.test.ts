/**
 * Double Encryption — BullMQ end-to-end flow diagnostic test
 *
 * Traces content state through the full production pipeline:
 *   encrypt for queue → JSON round-trip → decrypt from queue → insertMany
 *
 * Uses real MongoDB + real encryption plugin via shared test helpers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isAlreadyEncrypted } from '@agent-platform/shared-encryption';
import {
  wrapJobDataForEncrypt,
  unwrapJobDataForDecrypt,
  ENC_VALUE_PREFIX,
} from '@agent-platform/shared/encryption';
import {
  createEncryptedTestModel,
  setupTestEncryption,
  teardownTestEncryption,
  testFieldEncryptionService,
} from './helpers/fake-encryption.js';

const TestMsg = createEncryptedTestModel('test_bullmq_enc');

describe('Double Encryption — BullMQ Flow Diagnostic', () => {
  beforeAll(setupTestEncryption);

  afterAll(async () => {
    await TestMsg.deleteMany({});
    await teardownTestEncryption();
  });

  it('traces content state through full encrypt → decrypt → insertMany pipeline', async () => {
    const PLAINTEXT = 'This is a plaintext message for BullMQ flow test';

    const messageJobData = {
      dbSessionId: 'sess-bullmq-001',
      tenantId: 'tenant-test-001',
      projectId: 'proj-test-001',
      role: 'user' as const,
      content: PLAINTEXT,
      channel: 'api',
      enqueuedAt: Date.now(),
      idempotencyKey: 'idem-001',
      hasPII: false,
    };

    expect(isAlreadyEncrypted(messageJobData.content)).toBe(false);

    // Stage 1: encrypt for queue — adds ENC:v3: prefix
    const encryptedForQueue = await wrapJobDataForEncrypt(
      'message-persistence',
      { ...messageJobData } as Record<string, unknown>,
      testFieldEncryptionService,
    );
    expect((encryptedForQueue.content as string).startsWith(ENC_VALUE_PREFIX)).toBe(true);
    expect(encryptedForQueue._enc).toBe('v3');

    // Stage 2: JSON round-trip (simulates BullMQ Redis storage)
    const deserialized = JSON.parse(JSON.stringify(encryptedForQueue)) as Record<string, unknown>;
    expect(deserialized._enc).toBe('v3');

    // Stage 3: decrypt from queue — strips ENC:v3:, restores plaintext
    const decryptedFromQueue = await unwrapJobDataForDecrypt(
      'message-persistence',
      deserialized,
      testFieldEncryptionService,
    );
    expect(decryptedFromQueue.content).toBe(PLAINTEXT);

    // Stage 4: insertMany — Mongoose plugin encrypts for MongoDB
    await expect(
      TestMsg.insertMany(
        [
          {
            sessionId: decryptedFromQueue.dbSessionId as string,
            tenantId: decryptedFromQueue.tenantId as string,
            projectId: decryptedFromQueue.projectId as string,
            role: decryptedFromQueue.role as string,
            content: decryptedFromQueue.content as string,
            channel: decryptedFromQueue.channel as string,
          },
        ],
        { ordered: false },
      ),
    ).resolves.not.toThrow();
  });

  it('shared object reference between batches causes double encryption', async () => {
    const sharedMessage = {
      sessionId: 'sess-race-001',
      tenantId: 'tenant-test-001',
      projectId: 'proj-test-001',
      role: 'user' as const,
      content: 'shared message object between batches',
      channel: 'api',
    };

    // Batch 1: insertMany mutates content in-place (no clone)
    await TestMsg.insertMany([sharedMessage], { ordered: false });
    expect(isAlreadyEncrypted(sharedMessage.content)).toBe(true);

    // Batch 2: same object → double encryption rejected
    await expect(TestMsg.insertMany([sharedMessage], { ordered: false })).rejects.toThrow(
      /Double encryption rejected/,
    );
  });
});
