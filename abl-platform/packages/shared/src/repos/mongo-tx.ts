/**
 * MongoDB Transaction Helpers
 *
 * Shared utilities for transactional operations.
 * Caches whether the connected MongoDB supports transactions (replica set / mongos).
 * Uses session.withTransaction() for automatic transient-error retry.
 */

import mongoose from 'mongoose';

/** TTL for the replica-set check cache (ms). Re-checks after this period. */
const TX_CHECK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Cached result + timestamp for TTL-based invalidation. */
let _txCache: { promise: Promise<boolean>; checkedAt: number } | null = null;

/**
 * Check whether the connected MongoDB supports transactions.
 * Result is cached with a 5-minute TTL to handle late replica-set promotion
 * without hammering the admin API on every request.
 */
export function canUseTransactions(): Promise<boolean> {
  const now = Date.now();
  if (_txCache && now - _txCache.checkedAt < TX_CHECK_TTL_MS) {
    return _txCache.promise;
  }

  const promise = (async () => {
    try {
      const admin = mongoose.connection.db!.admin();
      const info = await admin.command({ hello: 1 });
      return !!(info['setName'] || info['msg'] === 'isdbgrid');
    } catch {
      return false;
    }
  })();

  _txCache = { promise, checkedAt: now };
  return promise;
}

/** Reset the cache. Exposed for tests only. */
export function _resetTxCache(): void {
  _txCache = null;
}

/**
 * Run an operation inside a MongoDB transaction if available, otherwise run without.
 *
 * Uses Mongoose's `session.withTransaction()` which automatically retries on
 * TransientTransactionError and UnknownTransactionCommitResult — the manual
 * startTransaction/commitTransaction pattern does NOT retry.
 *
 * The callback receives `session` (ClientSession) when transactions are available,
 * or `null` when running on standalone MongoDB. Callers must pass `session` to
 * all Mongoose operations via `{ session }` options for transactional consistency.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>,
): Promise<T> {
  const useTx = await canUseTransactions();

  if (useTx) {
    const session = await mongoose.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  return fn(null);
}
