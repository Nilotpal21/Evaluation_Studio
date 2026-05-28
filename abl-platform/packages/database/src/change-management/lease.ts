import mongoose from 'mongoose';

type Db = mongoose.mongo.Db;

export const CHANGE_LOCK_COLLECTION = '_change_lock';
export const DEFAULT_CHANGE_LEASE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CHANGE_LOCK_HEARTBEAT_MS = 60 * 1000;

export interface ChangeLeaseRecord {
  _id: string;
  lockedBy: string;
  lockedAt: Date;
  expiresAt: Date;
  fence: number;
}

interface ChangeLeaseOptions {
  lockId: string;
  collectionName?: string;
  now?: Date;
}

export interface AcquireChangeLeaseOptions extends ChangeLeaseOptions {
  holderId: string;
  ttlMs?: number;
}

export interface ExtendChangeLeaseOptions extends ChangeLeaseOptions {
  holderId: string;
  fence?: number;
  ttlMs?: number;
}

export interface ReleaseChangeLeaseOptions extends ChangeLeaseOptions {
  holderId?: string;
  fence?: number;
}

export interface AssertLeaseFenceOptions extends ChangeLeaseOptions {
  holderId: string;
  fence: number;
}

export interface ChangeLeaseHeartbeatHandle {
  stop(): Promise<void>;
}

export interface StartChangeLeaseHeartbeatOptions extends ExtendChangeLeaseOptions {
  intervalMs: number;
  onLeaseLost?: () => Promise<void> | void;
}

export class StaleLeaseFenceError extends Error {
  constructor(message = 'Lease holder is stale or no longer owns the active fence.') {
    super(message);
    this.name = 'StaleLeaseFenceError';
  }
}

function getCollection(db: Db, collectionName = CHANGE_LOCK_COLLECTION) {
  return db.collection<ChangeLeaseRecord>(collectionName);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveChangeLockTtlMs(): number {
  return parsePositiveInteger(process.env.CHANGE_LOCK_TTL_MS, DEFAULT_CHANGE_LEASE_TTL_MS);
}

export function resolveChangeLockHeartbeatMs(): number {
  return parsePositiveInteger(
    process.env.CHANGE_LOCK_HEARTBEAT_MS,
    DEFAULT_CHANGE_LOCK_HEARTBEAT_MS,
  );
}

export async function acquireChangeLease(
  db: Db,
  options: AcquireChangeLeaseOptions,
): Promise<ChangeLeaseRecord | null> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CHANGE_LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const collection = getCollection(db, options.collectionName);

  try {
    const result = await collection.findOneAndUpdate(
      {
        _id: options.lockId,
        $or: [{ lockedAt: { $exists: false } }, { expiresAt: { $lt: now } }],
      },
      {
        $set: {
          _id: options.lockId,
          lockedBy: options.holderId,
          lockedAt: now,
          expiresAt,
        },
        $inc: { fence: 1 },
      },
      {
        upsert: true,
        returnDocument: 'after',
      },
    );

    return result ?? null;
  } catch (error) {
    if (error instanceof Error && error.message.includes('E11000')) {
      return null;
    }

    const mongoError = error as { code?: number };
    if (mongoError.code === 11000) {
      return null;
    }

    throw error;
  }
}

export async function extendChangeLease(
  db: Db,
  options: ExtendChangeLeaseOptions,
): Promise<ChangeLeaseRecord | null> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CHANGE_LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const filter: Record<string, unknown> = {
    _id: options.lockId,
    lockedBy: options.holderId,
    expiresAt: { $gt: now },
  };

  if (options.fence !== undefined) {
    filter.fence = options.fence;
  }

  const result = await getCollection(db, options.collectionName).findOneAndUpdate(
    filter,
    {
      $set: {
        expiresAt,
      },
    },
    { returnDocument: 'after' },
  );

  return result ?? null;
}

export async function releaseChangeLease(
  db: Db,
  options: ReleaseChangeLeaseOptions,
): Promise<boolean> {
  const filter: Record<string, unknown> = { _id: options.lockId };

  if (options.holderId !== undefined) {
    filter.lockedBy = options.holderId;
  }

  if (options.fence !== undefined) {
    filter.fence = options.fence;
  }

  const result = await getCollection(db, options.collectionName).deleteOne(filter);
  return result.deletedCount > 0;
}

export async function getChangeLease(
  db: Db,
  options: ChangeLeaseOptions,
): Promise<ChangeLeaseRecord | null> {
  return getCollection(db, options.collectionName).findOne({ _id: options.lockId });
}

export async function isChangeLeaseHeld(db: Db, options: ChangeLeaseOptions): Promise<boolean> {
  const now = options.now ?? new Date();
  const lease = await getCollection(db, options.collectionName).findOne({
    _id: options.lockId,
    expiresAt: { $gt: now },
  });
  return lease !== null;
}

export async function assertLeaseFence(
  db: Db,
  options: AssertLeaseFenceOptions,
): Promise<ChangeLeaseRecord> {
  const now = options.now ?? new Date();
  const lease = await getCollection(db, options.collectionName).findOne({
    _id: options.lockId,
    lockedBy: options.holderId,
    fence: options.fence,
    expiresAt: { $gt: now },
  });

  if (!lease) {
    throw new StaleLeaseFenceError();
  }

  return lease;
}

export function startChangeLeaseHeartbeat(
  db: Db,
  options: StartChangeLeaseHeartbeatOptions,
): ChangeLeaseHeartbeatHandle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  async function tick(): Promise<void> {
    const lease = await extendChangeLease(db, options);
    if (lease) {
      return;
    }

    if (options.onLeaseLost) {
      await options.onLeaseLost();
    }

    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stopped = true;
  }

  timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = tick()
      .catch(async () => {
        if (options.onLeaseLost) {
          await options.onLeaseLost();
        }
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        stopped = true;
      })
      .finally(() => {
        inFlight = null;
      });
  }, options.intervalMs);

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight;
      }
    },
  };
}
