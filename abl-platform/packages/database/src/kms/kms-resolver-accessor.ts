/**
 * KMS Resolver Accessor
 *
 * Typed get/set/clear for the global KMSResolver instance.
 * Replaces all raw `(globalThis as any).__kmsResolver` accesses
 * with a single, type-safe module.
 */

import type { KMSResolver } from './kms-resolver.js';

const GLOBAL_KEY = '__kmsResolver';

/** Retrieve the global KMSResolver, or undefined if not yet set. */
export function getGlobalKMSResolver(): KMSResolver | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as KMSResolver | undefined;
}

/** Store the KMSResolver on globalThis. */
export function setGlobalKMSResolver(resolver: KMSResolver): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = resolver;
}

/** Remove the KMSResolver from globalThis. */
export function clearGlobalKMSResolver(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
