/**
 * Pooled Encryption Codec
 *
 * Drop-in replacement for dek-codec.ts encrypt path that minimizes per-call
 * allocations to reduce V8 GC pressure under high-concurrency workloads.
 *
 * Optimizations:
 *   1. Pre-allocated IV buffer pool — batch randomFillSync instead of per-call randomBytes
 *   2. Pre-allocated output buffer — direct assembly instead of 5-way Buffer.concat
 *   3. Cached AAD buffers — tenantId strings are converted once and reused
 *   4. Single base64 encode of assembled output (vs intermediate strings)
 *
 * Wire format is IDENTICAL to dek-codec.ts (fully backwards compatible):
 *   base64(id_len[1] + dekId[N] + iv[12] + authTag[16] + ciphertext[...])
 *
 * Measured impact (from saturation test data):
 *   - Original: 7 Buffer allocations per encrypt → promotes to old-gen → GC spikes
 *   - Pooled: 3 unavoidable allocations (cipher, update output, final string)
 *   - Target: eliminate sessionToHash >100ms spikes (currently 2.3% of operations)
 *
 * Thread safety: Single-threaded Node.js event loop. Pool slots are acquired/released
 * synchronously within a single encrypt call — no races possible.
 */

import { createCipheriv, createDecipheriv, randomFillSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// ─── IV Pool ────────────────────────────────────────────────────────────────
// Pre-generate IVs in batches. randomFillSync into a large buffer is much cheaper
// than individual randomBytes(12) calls because it amortizes the CSPRNG syscall.

const IV_BATCH_SIZE = 128;
const IV_POOL_BUFFER = Buffer.allocUnsafe(IV_BATCH_SIZE * IV_LENGTH);
let ivPoolIndex = IV_BATCH_SIZE; // Exhausted → triggers first fill

function acquireIV(): Buffer {
  if (ivPoolIndex >= IV_BATCH_SIZE) {
    randomFillSync(IV_POOL_BUFFER);
    ivPoolIndex = 0;
  }
  const offset = ivPoolIndex * IV_LENGTH;
  ivPoolIndex++;
  // Zero-copy view into the pool. Safe because we copy into output buffer
  // before the next encrypt call could overwrite this slot.
  return IV_POOL_BUFFER.subarray(offset, offset + IV_LENGTH);
}

// ─── Output Buffer ──────────────────────────────────────────────────────────
// Pre-allocated buffer for assembling wire format. Grows as needed, never shrinks.
// Avoids Buffer.concat([5 separate buffers]) which creates 5 + 1 allocations.

const INITIAL_OUTPUT_SIZE = 128 * 1024; // 128KB — covers most session fields
let outputBuffer = Buffer.allocUnsafe(INITIAL_OUTPUT_SIZE);

function ensureOutputCapacity(needed: number): void {
  if (outputBuffer.length < needed) {
    outputBuffer = Buffer.allocUnsafe(Math.max(needed * 2, INITIAL_OUTPUT_SIZE));
  }
}

// ─── AAD Cache ──────────────────────────────────────────────────────────────
// Tenant AAD strings are reused thousands of times. Cache the Buffer conversion.

const aadCache = new Map<string, Buffer>();
const AAD_CACHE_MAX = 512;

function normalizeAADCached(aad?: string | Buffer): Buffer | undefined {
  if (!aad) return undefined;
  if (Buffer.isBuffer(aad)) return aad;

  let cached = aadCache.get(aad);
  if (!cached) {
    if (aadCache.size >= AAD_CACHE_MAX) {
      aadCache.clear();
    }
    cached = Buffer.from(aad, 'utf8');
    aadCache.set(aad, cached);
  }
  return cached;
}

// ─── DekId Cache ────────────────────────────────────────────────────────────
// DEK IDs are a small fixed set (e.g., "active", "active:R1"). Cache their buffers.

const dekIdCache = new Map<string, { buf: Buffer; len: number }>();

function getDekIdBuffer(dekId: string): { buf: Buffer; len: number } {
  let cached = dekIdCache.get(dekId);
  if (!cached) {
    const buf = Buffer.from(dekId, 'utf8');
    cached = { buf, len: buf.length };
    dekIdCache.set(dekId, cached);
  }
  return cached;
}

// ─── Pooled Encrypt ─────────────────────────────────────────────────────────

/**
 * Encrypt plaintext with DEK — allocation-optimized version.
 *
 * Per-call allocations (reduced from 7 to 3):
 *   1. Cipher object (unavoidable — GCM requires fresh state per encryption)
 *   2. cipher.update() + cipher.final() output (unavoidable — crypto internals)
 *   3. Final base64 string (the return value — unavoidable)
 *
 * Eliminated allocations:
 *   ✗ randomBytes(12) → IV pool (zero-copy subarray)
 *   ✗ Buffer.from(dekId) → cached
 *   ✗ Buffer.from([idLen]) → direct byte write
 *   ✗ Buffer.concat([5 buffers]) → direct assembly into output buffer
 *   ✗ normalizeAAD string→Buffer → cached
 */
export function encryptWithDEKPooled(
  plaintext: string,
  dek: Buffer,
  dekId: string,
  aad?: string | Buffer,
): string {
  if (dek.length !== KEY_LENGTH) {
    throw new Error(`DEK must be exactly ${KEY_LENGTH} bytes, got ${dek.length}`);
  }
  if (dekId.length > 255) {
    throw new Error(`DEK identifier must be ≤255 characters, got ${dekId.length}`);
  }

  // Acquire IV from pool (zero-allocation)
  const iv = acquireIV();

  // Create cipher (unavoidable — GCM needs fresh state)
  const cipher = createCipheriv(ALGORITHM, dek, iv);

  const aadBuffer = normalizeAADCached(aad);
  if (aadBuffer) {
    cipher.setAAD(aadBuffer);
  }

  // Encrypt (unavoidable allocations — crypto internals)
  const encrypted = cipher.update(plaintext, 'utf8');
  const final = cipher.final();
  const authTag = cipher.getAuthTag();

  // Assemble wire format into pre-allocated output buffer
  const { buf: idBuf, len: idLen } = getDekIdBuffer(dekId);
  const ciphertextLen = encrypted.length + final.length;
  const totalLen = 1 + idLen + IV_LENGTH + AUTH_TAG_LENGTH + ciphertextLen;

  ensureOutputCapacity(totalLen);

  let offset = 0;
  outputBuffer[offset++] = idLen;
  idBuf.copy(outputBuffer, offset);
  offset += idLen;
  iv.copy(outputBuffer, offset); // Copy IV before pool slot is reused
  offset += IV_LENGTH;
  authTag.copy(outputBuffer, offset);
  offset += AUTH_TAG_LENGTH;
  encrypted.copy(outputBuffer, offset);
  offset += encrypted.length;
  if (final.length > 0) {
    final.copy(outputBuffer, offset);
    offset += final.length;
  }

  // Single base64 encode (one string allocation — the return value)
  return outputBuffer.subarray(0, offset).toString('base64');
}

// ─── Decrypt (unchanged — decrypt is not on the hot path for persist) ───────

export { decryptWithDEK } from './dek-codec.js';

// ─── Pool Stats ─────────────────────────────────────────────────────────────

export function getPoolStats(): {
  ivBatchesFilled: number;
  outputBufferBytes: number;
  aadCacheSize: number;
  dekIdCacheSize: number;
} {
  return {
    ivBatchesFilled: Math.ceil(ivPoolIndex / IV_BATCH_SIZE),
    outputBufferBytes: outputBuffer.length,
    aadCacheSize: aadCache.size,
    dekIdCacheSize: dekIdCache.size,
  };
}
