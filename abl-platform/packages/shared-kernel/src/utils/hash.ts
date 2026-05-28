/**
 * Content-addressed hashing utilities.
 *
 * `computeSourceHash` produces a full 64-char SHA-256 hex digest for collision
 * safety across the tool corpus. Used by project_tools.sourceHash, stale
 * detection, and Redis cache keys.
 *
 * Note: The compiler's `hashSource()` (16-char truncated) is kept separately
 * for IR config_hash — different use case, different collision tolerance.
 */

import { createHash } from 'crypto';

/**
 * Compute a full SHA-256 hex digest of the given content.
 * Returns a 64-character lowercase hex string.
 */
export function computeSourceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
