import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from '../helpers/setup-mongo.js';
import {
  acquireChangeLease,
  getChangeLease,
  startChangeLeaseHeartbeat,
  extendChangeLease,
} from '../../change-management/lease.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  for (const collectionName of ['_change_lock']) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length > 0) {
      await db.collection(collectionName).deleteMany({});
    }
  }
});

describe('change-management lease', () => {
  test('acquires a free lease successfully', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const lease = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
    });

    expect(lease).not.toBeNull();
    expect(lease?.lockedBy).toBe('holder-a');
    expect(lease?.fence).toBe(1);
  });

  test('rejects acquisition when another holder owns the active lease', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const first = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
    });
    const second = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-b',
    });

    expect(first?.fence).toBe(1);
    expect(second).toBeNull();
  });

  test('extends an active lease heartbeat without changing the fence', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const lease = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      ttlMs: 40,
    });
    expect(lease).not.toBeNull();

    const originalExpiresAt = lease!.expiresAt.getTime();
    const heartbeat = startChangeLeaseHeartbeat(db, {
      lockId: 'global',
      holderId: 'holder-a',
      fence: lease!.fence,
      ttlMs: 40,
      intervalMs: 10,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      await heartbeat.stop();
    }

    const updated = await getChangeLease(db, { lockId: 'global' });
    expect(updated?.fence).toBe(lease?.fence);
    expect(updated?.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt);
  });

  test('reacquires after expiry with a strictly higher fence', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const start = new Date('2026-04-15T00:00:00.000Z');
    const first = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      ttlMs: 10,
      now: start,
    });
    const second = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-b',
      ttlMs: 10,
      now: new Date(start.getTime() + 50),
    });

    expect(first?.fence).toBe(1);
    expect(second?.fence).toBe(2);
  });

  test('rejects heartbeat attempts from a stale holder', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const start = new Date('2026-04-15T00:00:00.000Z');
    const first = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      ttlMs: 10,
      now: start,
    });
    const reacquired = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-b',
      ttlMs: 10,
      now: new Date(start.getTime() + 50),
    });
    const staleHeartbeat = await extendChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      fence: first!.fence,
      ttlMs: 10,
      now: new Date(start.getTime() + 55),
    });

    expect(reacquired?.fence).toBe(2);
    expect(staleHeartbeat).toBeNull();
  });

  test('invokes the lease-loss callback when heartbeat can no longer extend', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const lease = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      ttlMs: 20,
    });
    expect(lease).not.toBeNull();

    let leaseLostCount = 0;
    const heartbeat = startChangeLeaseHeartbeat(db, {
      lockId: 'global',
      holderId: 'holder-a',
      fence: lease!.fence,
      ttlMs: 20,
      intervalMs: 30,
      onLeaseLost: () => {
        leaseLostCount += 1;
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 70));
    } finally {
      await heartbeat.stop();
    }

    expect(leaseLostCount).toBe(1);
  });
});
