import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_ROOT = join(tmpdir(), 'abl-platform-test-locks');
const STALE_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ESRCH' || error.code === 'ERR_INVALID_ARG_TYPE')
    );
  }
}

async function readLockFile(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function clearStaleLock(lockPath, existingLock) {
  const createdAtMs =
    typeof existingLock?.createdAt === 'string' ? Date.parse(existingLock.createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : Number.POSITIVE_INFINITY;
  const pid = typeof existingLock?.pid === 'number' ? existingLock.pid : null;

  if (pid !== null && isProcessAlive(pid) && ageMs < STALE_LOCK_AGE_MS) {
    return false;
  }

  await rm(lockPath, { force: true });
  return true;
}

function formatOwner(existingLock) {
  if (!existingLock) {
    return 'another active test process';
  }

  const parts = [];
  if (typeof existingLock.owner === 'string' && existingLock.owner.length > 0) {
    parts.push(existingLock.owner);
  }
  if (typeof existingLock.cwd === 'string' && existingLock.cwd.length > 0) {
    parts.push(`cwd=${existingLock.cwd}`);
  }
  if (typeof existingLock.pid === 'number') {
    parts.push(`pid=${String(existingLock.pid)}`);
  }
  if (typeof existingLock.createdAt === 'string' && existingLock.createdAt.length > 0) {
    parts.push(`started=${existingLock.createdAt}`);
  }

  return parts.length > 0 ? parts.join(' ') : 'another active test process';
}

export async function acquireNonBlockingTestLock(name, metadata = {}) {
  await mkdir(LOCK_ROOT, { recursive: true });

  const lockPath = join(LOCK_ROOT, `${name}.json`);
  const payload = {
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    name,
    pid: process.pid,
    ...metadata,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(payload, null, 2));
      } finally {
        await handle.close();
      }

      let released = false;

      return {
        async release() {
          if (released) {
            return;
          }

          released = true;
          const existingLock = await readLockFile(lockPath);
          if (
            existingLock?.pid === payload.pid &&
            existingLock?.createdAt === payload.createdAt &&
            existingLock?.name === payload.name
          ) {
            await rm(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      const existingLock = await readLockFile(lockPath);
      if (await clearStaleLock(lockPath, existingLock)) {
        continue;
      }

      throw new Error(
        `Could not acquire test lock "${name}". Held by ${formatOwner(existingLock)}. ` +
          'Another heavy local test run is already using the shared infra, so this run is failing fast.',
      );
    }
  }

  throw new Error(`Could not acquire test lock "${name}".`);
}
