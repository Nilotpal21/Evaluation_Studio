/**
 * Lock Service — advisory locks with optimistic concurrency control
 *
 * Prevents concurrent edits to the same agent. Uses TTL-based auto-expiry.
 * Database operations are abstracted through a store interface.
 */

import type { LockType } from '../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('lock-service');

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Store Interface ────────────────────────────────────────────────────

export interface LockRecord {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  lockedBy: string;
  lockedAt: Date;
  expiresAt: Date;
  lockType: LockType;
}

export interface LockStore {
  getLock(projectId: string, agentId: string, lockType: LockType): Promise<LockRecord | null>;
  createLock(record: Omit<LockRecord, 'id'>): Promise<LockRecord>;
  updateLock(id: string, updates: Partial<LockRecord>): Promise<LockRecord>;
  deleteLock(projectId: string, agentId: string, lockType: LockType): Promise<void>;
  listLocks(projectId: string): Promise<LockRecord[]>;
}

// ─── Error Types ────────────────────────────────────────────────────────

export interface LockConflictError {
  code: 'LOCK_CONFLICT';
  message: string;
  lockedBy: string;
  lockedAt: Date;
  expiresAt: Date;
}

// ─── Service ────────────────────────────────────────────────────────────

export class LockService {
  constructor(private readonly store: LockStore) {}

  async acquireLock(
    projectId: string,
    agentId: string,
    agentName: string,
    userId: string,
    lockType: LockType = 'edit',
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
  ): Promise<LockRecord | LockConflictError> {
    // Check for existing lock first (for same-user refresh)
    const existing = await this.store.getLock(projectId, agentId, lockType);

    if (existing) {
      if (existing.expiresAt > new Date()) {
        // Still active
        if (existing.lockedBy === userId) {
          // Same user, just refresh
          return this.store.updateLock(existing.id, {
            expiresAt: new Date(Date.now() + ttlMs),
          });
        }
        return {
          code: 'LOCK_CONFLICT',
          message: `Agent "${agentName}" is locked by another user`,
          lockedBy: existing.lockedBy,
          lockedAt: existing.lockedAt,
          expiresAt: existing.expiresAt,
        };
      }
      // Expired — clean up and proceed
      await this.store.deleteLock(projectId, agentId, lockType);
    }

    // Use create-first pattern to handle race conditions.
    // If two requests pass the check above simultaneously, the unique constraint
    // on (projectId, agentId, lockType) ensures only one succeeds.
    const now = new Date();
    try {
      return await this.store.createLock({
        projectId,
        agentId,
        agentName,
        lockedBy: userId,
        lockedAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
        lockType,
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        // Another request won the race — check if their lock is still active
        const conflicting = await this.store.getLock(projectId, agentId, lockType);
        if (conflicting && conflicting.expiresAt > new Date()) {
          if (conflicting.lockedBy === userId) {
            // Same user won the race — just return their lock
            return conflicting;
          }
          return {
            code: 'LOCK_CONFLICT',
            message: `Agent "${agentName}" is locked by another user`,
            lockedBy: conflicting.lockedBy,
            lockedAt: conflicting.lockedAt,
            expiresAt: conflicting.expiresAt,
          };
        }
        // Race winner's lock already expired or was cleaned up — retry once
        return this.store.createLock({
          projectId,
          agentId,
          agentName,
          lockedBy: userId,
          lockedAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
          lockType,
        });
      }
      throw error;
    }
  }

  async releaseLock(
    projectId: string,
    agentId: string,
    userId: string,
    lockType: LockType = 'edit',
  ): Promise<void> {
    const existing = await this.store.getLock(projectId, agentId, lockType);
    if (!existing) return;

    if (existing.lockedBy !== userId) {
      throw new Error('Cannot release a lock held by another user');
    }

    await this.store.deleteLock(projectId, agentId, lockType);
  }

  async refreshLock(
    projectId: string,
    agentId: string,
    userId: string,
    lockType: LockType = 'edit',
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
  ): Promise<LockRecord> {
    const existing = await this.store.getLock(projectId, agentId, lockType);
    if (!existing) {
      throw new Error('No active lock to refresh');
    }

    if (existing.lockedBy !== userId) {
      throw new Error('Cannot refresh a lock held by another user');
    }

    return this.store.updateLock(existing.id, {
      expiresAt: new Date(Date.now() + ttlMs),
    });
  }

  async getLock(
    projectId: string,
    agentId: string,
    lockType: LockType = 'edit',
  ): Promise<LockRecord | null> {
    const lock = await this.store.getLock(projectId, agentId, lockType);
    if (lock && lock.expiresAt <= new Date()) {
      // Expired
      await this.store.deleteLock(projectId, agentId, lockType);
      return null;
    }
    return lock;
  }

  async forceBreakLock(
    projectId: string,
    agentId: string,
    brokenBy: string,
    lockType: LockType = 'edit',
  ): Promise<void> {
    const existing = await this.store.getLock(projectId, agentId, lockType);
    if (existing) {
      log.warn('Lock force-broken', {
        agentId,
        projectId,
        previousHolder: existing.lockedBy,
        brokenBy,
        lockType,
      });
    }
    await this.store.deleteLock(projectId, agentId, lockType);
  }

  async listLocks(projectId: string): Promise<LockRecord[]> {
    const locks = await this.store.listLocks(projectId);
    // Filter out expired
    const now = new Date();
    return locks.filter((l) => l.expiresAt > now);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isDuplicateKeyError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code?: number }).code === 11000;
  }
  return false;
}
