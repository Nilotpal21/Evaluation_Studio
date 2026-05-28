/**
 * Callback-secret encryption round-trip — Phase 4 / data-flow-audit Round 2.
 *
 * Round 1 of the data-flow audit found that `callbackSecret` was stored
 * plaintext at-rest in Redis. The fix wraps the BullMQ payload via
 * `wrapJobDataForEncrypt` at the engine enqueue site and unwraps via
 * `unwrapJobDataForDecrypt` at the worker dequeue site, gated by the
 * `workflow-docling-extraction` entry in `REDIS_QUEUE_ENCRYPTION_MANIFEST`.
 *
 * This test exercises the full producer-side encryption + simulated Redis
 * persistence + consumer-side decryption against a fake tenant encryption
 * service (the production service requires Vault / KMS boot). The fake
 * mirrors the contract `TenantFieldEncryptionService` exposes; the assertion
 * is that the plaintext secret never lives in the Redis-stored payload and
 * comes back intact at the consumer.
 */

import { describe, expect, it } from 'vitest';
import {
  wrapJobDataForEncrypt,
  unwrapJobDataForDecrypt,
  type TenantFieldEncryptionService,
} from '@agent-platform/shared-encryption';

const TENANT_ID = 'tenant-roundtrip-test';
const PLAINTEXT_SECRET = 'whsec_test_round_trip_super_secret_42';

// Fake tenant-encryption service — prepends/strips a tenant-scoped prefix so
// the test can assert the at-rest payload doesn't contain the plaintext.
function makeFakeEncryption(): TenantFieldEncryptionService {
  return {
    async encryptForTenant(plaintext: string, tenantId: string): Promise<string> {
      // Base64-prefixed cipher so the at-rest blob is visibly distinct from
      // plaintext but reversible by a matching tenantId.
      return `fake-enc:${tenantId}:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
    },
    async decryptForTenant(ciphertext: string, tenantId: string): Promise<string> {
      const expectedPrefix = `fake-enc:${tenantId}:`;
      if (!ciphertext.startsWith(expectedPrefix)) {
        throw new Error(`Decryption failed: bad prefix for tenant ${tenantId}`);
      }
      return Buffer.from(ciphertext.slice(expectedPrefix.length), 'base64').toString('utf8');
    },
  };
}

describe('workflow-docling-extraction callback-secret encryption round-trip', () => {
  it('encrypts callbackSecret at-rest and decrypts it at the consumer', async () => {
    const enc = makeFakeEncryption();

    const producerPayload = {
      tenantId: TENANT_ID,
      projectId: 'project-a',
      sourceUrl: 'https://files.example.com/doc.pdf',
      workflowExecutionId: 'exec-1',
      stepId: 'step-extract',
      callbackId: 'exec-1:step-extract',
      callbackUrl: 'http://workflow-engine.internal/api/workflows/.../callback',
      callbackSecret: PLAINTEXT_SECRET,
      mode: 'extraction-only' as const,
      options: {},
    };

    // PRODUCER SIDE — engine wraps before enqueue.
    const atRest = await wrapJobDataForEncrypt(
      'workflow-docling-extraction',
      producerPayload as unknown as Record<string, unknown>,
      enc,
    );

    // INVARIANT 1: the plaintext secret no longer appears anywhere in the
    // at-rest payload — neither as the field value nor anywhere in the
    // serialized JSON blob.
    expect(atRest.callbackSecret).not.toBe(PLAINTEXT_SECRET);
    expect(JSON.stringify(atRest)).not.toContain(PLAINTEXT_SECRET);

    // INVARIANT 2: the manifest's `_enc: 'v3'` flag is set so the consumer
    // path knows to decrypt.
    expect(atRest._enc).toBe('v3');

    // CONSUMER SIDE — worker unwraps before reading.
    const recovered = (await unwrapJobDataForDecrypt(
      'workflow-docling-extraction',
      atRest,
      enc,
    )) as typeof producerPayload;

    // INVARIANT 3: plaintext is recovered exactly.
    expect(recovered.callbackSecret).toBe(PLAINTEXT_SECRET);

    // INVARIANT 4: non-encrypted fields are untouched.
    expect(recovered.tenantId).toBe(TENANT_ID);
    expect(recovered.projectId).toBe('project-a');
    expect(recovered.sourceUrl).toBe('https://files.example.com/doc.pdf');
    expect(recovered.callbackId).toBe(producerPayload.callbackId);

    // INVARIANT 5: callbackUrl is encrypted at rest (added to manifest) and
    // recovers exactly after decryption.
    expect(atRest.callbackUrl).not.toBe(producerPayload.callbackUrl);
    expect(recovered.callbackUrl).toBe(producerPayload.callbackUrl);
  });

  it('decryption fails fast under tenant-id mismatch (cross-tenant defense)', async () => {
    const enc = makeFakeEncryption();
    const producerPayload = {
      tenantId: TENANT_ID,
      callbackSecret: PLAINTEXT_SECRET,
    };
    const atRest = await wrapJobDataForEncrypt(
      'workflow-docling-extraction',
      producerPayload as unknown as Record<string, unknown>,
      enc,
    );
    // Swap tenantId on the at-rest record — simulates a malicious / corrupted
    // job that claims a different tenant. The decryption MUST fail.
    const tampered = { ...atRest, tenantId: 'other-tenant' };
    await expect(
      unwrapJobDataForDecrypt('workflow-docling-extraction', tampered, enc),
    ).rejects.toThrow(/Decryption failed/);
  });

  it('pre-fix plaintext jobs still dequeue cleanly (backward-compat)', async () => {
    // Older jobs landed before the manifest entry existed — they have
    // `callbackSecret` as a plain string and no `_enc` flag. The consumer
    // should pass them through unchanged so we don't break in-flight work
    // during the rollout window.
    const enc = makeFakeEncryption();
    const legacyJob = {
      tenantId: TENANT_ID,
      callbackSecret: PLAINTEXT_SECRET,
      // _enc intentionally absent
    };
    const passThrough = (await unwrapJobDataForDecrypt(
      'workflow-docling-extraction',
      legacyJob,
      enc,
    )) as typeof legacyJob;
    expect(passThrough.callbackSecret).toBe(PLAINTEXT_SECRET);
  });

  it('wrap rejects double-encryption (defensive guard)', async () => {
    const enc = makeFakeEncryption();
    const onceEncrypted = await wrapJobDataForEncrypt(
      'workflow-docling-extraction',
      {
        tenantId: TENANT_ID,
        callbackSecret: PLAINTEXT_SECRET,
      } as unknown as Record<string, unknown>,
      enc,
    );
    await expect(
      wrapJobDataForEncrypt('workflow-docling-extraction', onceEncrypted, enc),
    ).rejects.toThrow(/already encrypted/);
  });
});
