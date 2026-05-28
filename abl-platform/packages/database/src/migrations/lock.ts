import mongoose from 'mongoose';
import { hostname } from 'node:os';
import {
  acquireChangeLease,
  extendChangeLease,
  isChangeLeaseHeld,
  releaseChangeLease,
  resolveChangeLockHeartbeatMs,
  resolveChangeLockTtlMs,
} from '../change-management/lease.js';

type Db = mongoose.mongo.Db;

export const MIGRATION_LOCK_COLLECTION = '_migration_lock';
export const MIGRATION_LOCK_ID = 'migration_runner';

export function buildMigrationLockHolderId(): string {
  return `${hostname()}_${process.pid}`;
}

export function getMigrationLockTtlMs(): number {
  return resolveChangeLockTtlMs();
}

export function getMigrationLockHeartbeatMs(): number {
  return resolveChangeLockHeartbeatMs();
}

/**
 * Acquire the distributed migration lock.
 * Returns true if the lock was acquired, false if another runner holds it.
 */
export async function acquireLock(db: Db): Promise<boolean> {
  const lease = await acquireChangeLease(db, {
    lockId: MIGRATION_LOCK_ID,
    holderId: buildMigrationLockHolderId(),
    ttlMs: getMigrationLockTtlMs(),
    collectionName: MIGRATION_LOCK_COLLECTION,
  });

  return lease !== null;
}

/**
 * Release the migration lock.
 */
export async function releaseLock(db: Db): Promise<void> {
  await releaseChangeLease(db, {
    lockId: MIGRATION_LOCK_ID,
    holderId: buildMigrationLockHolderId(),
    collectionName: MIGRATION_LOCK_COLLECTION,
  });
}

/**
 * Extend the lock TTL (for long-running migrations).
 */
export async function extendLock(db: Db): Promise<boolean> {
  const lease = await extendChangeLease(db, {
    lockId: MIGRATION_LOCK_ID,
    holderId: buildMigrationLockHolderId(),
    ttlMs: getMigrationLockTtlMs(),
    collectionName: MIGRATION_LOCK_COLLECTION,
  });

  return lease !== null;
}

/**
 * Check if the lock is currently held.
 */
export async function isLocked(db: Db): Promise<boolean> {
  return isChangeLeaseHeld(db, {
    lockId: MIGRATION_LOCK_ID,
    collectionName: MIGRATION_LOCK_COLLECTION,
  });
}
