import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { DistributedLockManager, type Lock } from '@agent-platform/shared-observability';
import { getRedisClient } from '@/lib/redis-client';

const log = createLogger('git-operation-lock');

const GIT_OPERATION_LOCK_TTL_MS = 5 * 60 * 1000;
const GIT_OPERATION_LOCK_RENEW_MS = Math.floor(GIT_OPERATION_LOCK_TTL_MS / 3);
const GIT_OPERATION_LOCK_PREFIX = 'studio:git-operation';
const LOCAL_LOCK_MAX_ENTRIES = 500;

type GitOperationName = 'setup' | 'update' | 'push' | 'pull' | 'promote' | 'webhook' | 'disconnect';

interface GitOperationLockInput {
  tenantId: string;
  projectId: string;
  operation: GitOperationName;
}

interface AcquiredGitOperationLock {
  acquired: true;
  release: () => Promise<void>;
}

interface ContendedGitOperationLock {
  acquired: false;
  status: 423;
  body: {
    error: string;
    code: 'GIT_OPERATION_IN_PROGRESS';
  };
}

export type GitOperationLockResult = AcquiredGitOperationLock | ContendedGitOperationLock;

const localLocks = new Map<string, { value: string; expiresAt: number }>();

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function buildResourceId(input: Pick<GitOperationLockInput, 'tenantId' | 'projectId'>): string {
  return `${input.tenantId}:${input.projectId}`;
}

function pruneLocalLocks(now = Date.now()): void {
  for (const [key, lock] of localLocks.entries()) {
    if (lock.expiresAt <= now) {
      localLocks.delete(key);
    }
  }

  while (localLocks.size > LOCAL_LOCK_MAX_ENTRIES) {
    const firstKey = localLocks.keys().next().value as string | undefined;
    if (!firstKey) return;
    localLocks.delete(firstKey);
  }
}

function acquireLocalLock(resourceId: string): AcquiredGitOperationLock | null {
  const now = Date.now();
  pruneLocalLocks(now);

  const key = `${GIT_OPERATION_LOCK_PREFIX}:${resourceId}`;
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > now) {
    return null;
  }

  const value = `${now}:${Math.random().toString(36).slice(2)}`;
  localLocks.set(key, { value, expiresAt: now + GIT_OPERATION_LOCK_TTL_MS });
  const renewTimer = setInterval(() => {
    const current = localLocks.get(key);
    if (current?.value === value) {
      current.expiresAt = Date.now() + GIT_OPERATION_LOCK_TTL_MS;
    }
  }, GIT_OPERATION_LOCK_RENEW_MS);
  unrefTimer(renewTimer);

  return {
    acquired: true,
    release: async () => {
      clearInterval(renewTimer);
      const current = localLocks.get(key);
      if (current?.value === value) {
        localLocks.delete(key);
      }
    },
  };
}

function lockedResult(): ContendedGitOperationLock {
  return {
    acquired: false,
    status: 423,
    body: {
      error: 'Another git operation is already in progress for this project',
      code: 'GIT_OPERATION_IN_PROGRESS',
    },
  };
}

export function gitOperationLockedResponse(result: ContendedGitOperationLock): NextResponse {
  return NextResponse.json(result.body, { status: result.status });
}

export async function acquireGitOperationLock(
  input: GitOperationLockInput,
): Promise<GitOperationLockResult> {
  const resourceId = buildResourceId(input);
  const redis = getRedisClient();

  if (redis) {
    const manager = new DistributedLockManager(redis);
    const lock: Lock | null = await manager.acquire(resourceId, {
      keyPrefix: GIT_OPERATION_LOCK_PREFIX,
      ttlMs: GIT_OPERATION_LOCK_TTL_MS,
    });

    if (!lock) {
      return lockedResult();
    }
    const renewTimer = setInterval(() => {
      void manager
        .extend(lock, GIT_OPERATION_LOCK_TTL_MS)
        .then((extended) => {
          if (!extended) {
            log.warn('Git operation lock renewal lost ownership', {
              projectId: input.projectId,
              operation: input.operation,
            });
            clearInterval(renewTimer);
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('Git operation lock renewal failed', {
            projectId: input.projectId,
            operation: input.operation,
            error: message,
          });
        });
    }, GIT_OPERATION_LOCK_RENEW_MS);
    unrefTimer(renewTimer);

    return {
      acquired: true,
      release: async () => {
        clearInterval(renewTimer);
        const released = await manager.release(lock);
        if (!released) {
          log.warn('Git operation lock was not released by owner', {
            projectId: input.projectId,
            operation: input.operation,
          });
        }
      },
    };
  }

  const localLock = acquireLocalLock(resourceId);
  if (!localLock) {
    return lockedResult();
  }

  return localLock;
}
