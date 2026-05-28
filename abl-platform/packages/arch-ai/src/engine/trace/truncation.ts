/**
 * Attribute value truncation with UTF-8 multi-byte safety and secret scrubbing.
 *
 * Design spec: §13 (payload policy)
 * LLD: Phase 1a, task 1.a.5
 *
 * Rules:
 * - Any attribute value > 16 KB (stringified) is truncated to 16 KB
 *   with suffix '…[truncated; original=<N> bytes]'.
 * - Secret keys (api_key, authorization, token, secret, password, credential)
 *   are scrubbed from attribute values.
 * - Truncation never splits a multi-byte UTF-8 character.
 */

/** Default maximum attribute value size in bytes. */
export const DEFAULT_MAX_ATTRIBUTE_BYTES = 16 * 1024; // 16 KB

/**
 * Pattern matching keys that should be scrubbed from attribute values.
 * Requires the sensitive word to be a full key segment (bounded by start/end
 * or a separator) so that e.g. `input_tokens` does not match `token`.
 */
const SENSITIVE_KEY_PATTERN =
  /(^|[._-])(api[_-]?key|authorization|token|secret|password|credential)($|[._-])/i;

/** Sentinel value for scrubbed keys. */
const SCRUBBED_VALUE = '[REDACTED]';

/**
 * Options for truncateAttributes.
 */
export interface TruncationOptions {
  /** Max bytes per attribute value (default: 16 KB). */
  maxBytes?: number;
  /** Callback when a value is truncated. */
  onTruncate?: (key: string, originalBytes: number) => void;
  /** Callback when a secret key is scrubbed. */
  onScrub?: (key: string) => void;
}

/**
 * Truncate and scrub attribute values.
 *
 * Returns a new attributes object with:
 * - Sensitive keys replaced with '[REDACTED]'
 * - Oversized string values truncated at a safe UTF-8 boundary
 * - Non-string oversized values stringified then truncated
 *
 * Pure function — does not mutate the input.
 */
export function truncateAttributes(
  attributes: Record<string, unknown>,
  opts?: TruncationOptions,
  visited: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_ATTRIBUTE_BYTES;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attributes)) {
    // Secret scrubbing: check the key name
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      opts?.onScrub?.(key);
      result[key] = SCRUBBED_VALUE;
      continue;
    }

    // Also scrub values that are objects containing sensitive keys
    if (isRecord(value)) {
      if (visited.has(value)) {
        result[key] = '[circular]';
        continue;
      }
      visited.add(value);
      result[key] = truncateAttributes(value as Record<string, unknown>, opts, visited);
      continue;
    }

    // Truncate strings
    if (typeof value === 'string') {
      result[key] = truncateString(value, maxBytes, key, opts?.onTruncate);
      continue;
    }

    // For non-string values, check if their JSON stringification exceeds the limit
    if (value !== null && value !== undefined) {
      let stringified: string;
      try {
        stringified = JSON.stringify(value);
      } catch {
        // Circular or non-serializable — replace with error marker
        result[key] = '[non-serializable]';
        continue;
      }

      const byteLength = getByteLength(stringified);
      if (byteLength > maxBytes) {
        const truncated = truncateString(stringified, maxBytes, key, opts?.onTruncate);
        result[key] = truncated;
        continue;
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Truncate a string to maxBytes at a safe UTF-8 boundary.
 * Appends a suffix indicating the original size.
 */
function truncateString(
  value: string,
  maxBytes: number,
  key: string,
  onTruncate?: (key: string, originalBytes: number) => void,
): string {
  const originalBytes = getByteLength(value);
  if (originalBytes <= maxBytes) return value;

  onTruncate?.(key, originalBytes);

  const suffix = `\u2026[truncated; original=${originalBytes} bytes]`;
  const suffixBytes = getByteLength(suffix);
  const targetBytes = maxBytes - suffixBytes;

  if (targetBytes <= 0) {
    return suffix;
  }

  // Truncate at a safe UTF-8 boundary using TextEncoder/TextDecoder
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  const sliced = encoded.slice(0, targetBytes);

  // Decode back — TextDecoder handles partial multi-byte sequences by replacing
  // them with the replacement character, but we want a clean cut. Walk backwards
  // to find the last complete character boundary.
  const safeSlice = findSafeUtf8Boundary(sliced);
  const decoder = new TextDecoder();
  return decoder.decode(safeSlice) + suffix;
}

/**
 * Find the last safe UTF-8 boundary in a byte array.
 * Walks backwards from the end to avoid splitting multi-byte sequences.
 */
function findSafeUtf8Boundary(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;

  // Walk backwards past any continuation bytes (10xxxxxx = 0x80..0xBF)
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) {
    end--;
  }

  // Now bytes[end-1] is a leading byte (or end === 0).
  // Check if the full multi-byte sequence starting at that leading byte
  // is present within the slice. If so, include it entirely; if not
  // (truncated in the middle of a sequence), drop the leading byte too.
  if (end > 0) {
    const leadIndex = end - 1;
    const leadByte = bytes[leadIndex];
    const expectedLength = utf8SequenceLength(leadByte);
    const availableFromLead = bytes.length - leadIndex;
    if (availableFromLead >= expectedLength) {
      // Complete sequence — include all of it.
      end = leadIndex + expectedLength;
    } else {
      // Incomplete sequence — drop the leading byte.
      end = leadIndex;
    }
  }

  return bytes.slice(0, end);
}

/**
 * Determine the expected length of a UTF-8 sequence from its leading byte.
 */
function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1; // 0xxxxxxx
  if ((leadByte & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((leadByte & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((leadByte & 0xf8) === 0xf0) return 4; // 11110xxx
  return 1; // Invalid — treat as single byte
}

/**
 * Get the byte length of a string in UTF-8 encoding.
 */
function getByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Type guard for plain objects (Record<string, unknown>).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
