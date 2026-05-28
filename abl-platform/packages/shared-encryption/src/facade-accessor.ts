/**
 * Facade Accessor
 *
 * Typed get/set/clear for the global TenantEncryptionFacade instance.
 * Replaces all raw `(globalThis as any).__encryptionFacade` accesses
 * with a single, type-safe module.
 *
 * The facade is stored on globalThis so that packages without a direct
 * dependency on each other (shared-encryption ↔ database plugin) can
 * share the same instance at runtime without circular imports.
 */

import type { TenantEncryptionFacade } from './tenant-encryption-facade.js';
import { createStderrLogger } from './stderr-logger.js';

const log = createStderrLogger('facade-accessor');
const GLOBAL_KEY = '__encryptionFacade';

/** Retrieve the global TenantEncryptionFacade, or undefined if not yet set. */
export function getEncryptionFacade(): TenantEncryptionFacade | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as TenantEncryptionFacade | undefined;
}

/** Store the TenantEncryptionFacade on globalThis. Warns if overwriting an existing instance. */
export function setGlobalEncryptionFacade(facade: TenantEncryptionFacade): void {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  if (existing && existing !== facade) {
    log.warn(
      'Overwriting existing global TenantEncryptionFacade — may indicate duplicate initialization',
    );
  }
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = facade;
}

/** Remove the TenantEncryptionFacade from globalThis. */
export function clearGlobalEncryptionFacade(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
