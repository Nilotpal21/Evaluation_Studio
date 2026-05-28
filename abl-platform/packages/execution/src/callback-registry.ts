/**
 * CallbackRegistry — O(1) lookup from callbackId to suspension metadata.
 *
 * Every async boundary generates a unique callbackId that is:
 * - Injected into outbound requests (as a URL path segment or token)
 * - Registered in Redis with a TTL matching the suspension timeout
 * - Used as the path parameter when the external system calls back
 */

export interface CallbackRegistryEntry {
  callbackId: string;
  suspensionId: string;
  sessionId: string;
  tenantId: string;
  expiresAt: number; // epoch ms
}

export interface CallbackRegistry {
  /**
   * Register a callback. Sets Redis key with TTL derived from expiresAt.
   * Idempotent: if the key already exists with the same suspensionId, this is a no-op.
   */
  register(entry: CallbackRegistryEntry): Promise<void>;

  /**
   * Look up a callback. Returns null if not found or expired.
   * Does NOT remove the entry — use claim() for atomic claim-and-remove.
   */
  lookup(callbackId: string): Promise<CallbackRegistryEntry | null>;

  /**
   * Atomic claim: look up and remove in a single Redis operation.
   * Returns the entry if found, null if already claimed or expired.
   * Uses Lua script for atomicity (GET + DEL in one round-trip).
   */
  claim(callbackId: string): Promise<CallbackRegistryEntry | null>;

  /** Remove a callback explicitly (e.g., on cancellation or expiry). */
  remove(callbackId: string): Promise<void>;
}
