/**
 * Eval Compression Helpers
 *
 * Gzip compress/decompress for ClickHouse string payloads.
 * Payloads ≥ 1KB are gzipped and prefixed with 'gz:' for
 * backward-compatible reads. Payloads < 1KB stored as plain JSON.
 *
 * Applied to: conversation transcripts, trace events, tool calls,
 * and long reasoning strings.
 */

import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Threshold in bytes below which compression is skipped (overhead not worthwhile). */
const COMPRESSION_THRESHOLD_BYTES = 1024;

/** Prefix to identify gzipped fields during reads. */
const GZIP_PREFIX = 'gz:';

/**
 * Compress a value for ClickHouse storage.
 * Returns plain JSON for small payloads, gzipped base64 for large ones.
 */
export async function compressField(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  if (json.length < COMPRESSION_THRESHOLD_BYTES) return json;
  const compressed = await gzipAsync(json);
  return GZIP_PREFIX + compressed.toString('base64');
}

/**
 * Decompress a value read from ClickHouse.
 * Handles both gzipped (gz: prefix) and plain JSON transparently.
 */
export async function decompressField<T = unknown>(stored: string): Promise<T> {
  if (stored.startsWith(GZIP_PREFIX)) {
    const buf = Buffer.from(stored.slice(GZIP_PREFIX.length), 'base64');
    const decompressed = await gunzipAsync(buf);
    return JSON.parse(decompressed.toString()) as T;
  }
  return JSON.parse(stored) as T;
}

/**
 * Conditionally compress a string field (not a serialized object).
 * Useful for reasoning/evidence strings that may exceed 1KB.
 */
export async function compressString(value: string): Promise<string> {
  if (value.length < COMPRESSION_THRESHOLD_BYTES) return value;
  const compressed = await gzipAsync(value);
  return GZIP_PREFIX + compressed.toString('base64');
}

/**
 * Decompress a string field. Returns the raw string if not compressed.
 */
export async function decompressString(stored: string): Promise<string> {
  if (stored.startsWith(GZIP_PREFIX)) {
    const buf = Buffer.from(stored.slice(GZIP_PREFIX.length), 'base64');
    const decompressed = await gunzipAsync(buf);
    return decompressed.toString();
  }
  return stored;
}
