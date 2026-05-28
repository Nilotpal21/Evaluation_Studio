/**
 * Encryption Context
 *
 * AsyncLocalStorage-based environment propagation for DEK scope resolution.
 * Two-layer middleware pattern (Decision 12):
 *   1. Global middleware (after auth): run({ environment: null })
 *   2. Project route middleware: override with deployment environment
 *   3. BullMQ workers: run({ environment: job.data.environment })
 *
 * The encryption plugin reads this to determine the 'environment' dimension
 * of the DEK scope when the document doesn't have an environment field.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface EncryptionContext {
  environment: string | null;
}

/** Singleton AsyncLocalStorage instance for encryption context. */
export const encryptionContext = new AsyncLocalStorage<EncryptionContext>();

/** Read the current environment from AsyncLocalStorage, or null if not set. */
export function getEncryptionEnvironment(): string | null {
  return encryptionContext.getStore()?.environment ?? null;
}

/** Convenience wrapper — run a function within an encryption context. */
export function runWithEncryptionContext<T>(ctx: EncryptionContext, fn: () => T): T {
  return encryptionContext.run(ctx, fn);
}
