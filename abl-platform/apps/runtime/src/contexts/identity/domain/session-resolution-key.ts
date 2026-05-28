/**
 * Session Resolution Key
 *
 * Compatibility exports for the Redis key-builder and legacy callers that still
 * construct resolution writes with the older top-level `sessionId` shape.
 */

import type { SessionResolutionWriteInput } from './session-resolution-record.js';

export type SessionResolutionKey = SessionResolutionWriteInput;

// =============================================================================
// KEY BUILDER
// =============================================================================

/** Build a tenant-scoped resolution key ID for Redis/store lookups. */
export function buildResolutionKeyId(
  tenantId: string,
  channelId: string,
  artifactHash: string,
): string {
  return `session_resolution:${tenantId}:${channelId}:${artifactHash}`;
}
