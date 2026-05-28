/**
 * Tests for retention scheduler and MongoDB stores
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntervalScheduler } from '../services/scheduler/interval-scheduler';
import { MongoRetentionStore } from '../services/retention/mongo-retention-store';
import { MongoGDPRStore } from '../services/retention/mongo-gdpr-store';
import type { ScheduledJob } from '../services/scheduler/scheduler-types';

// Mock Mongoose models (the stores do dynamic import('@agent-platform/database/models'))
const mockSession = {
  find: vi.fn().mockReturnThis(),
  findById: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
};

const mockMessage = {
  find: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
};

const mockAuditLog = {
  updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
};

const mockContact = {
  find: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
};

vi.mock('@agent-platform/database/models', () => ({
  Session: mockSession,
  Message: mockMessage,
  AuditLog: mockAuditLog,
  Contact: mockContact,
}));

const mockCascadeDeleteSession = vi.fn().mockResolvedValue({ counts: { Session: 1 } });
vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: mockCascadeDeleteSession,
}));

describe('IntervalScheduler', () => {
  let scheduler: IntervalScheduler;

  beforeEach(() => {
    scheduler = new IntervalScheduler();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  test('registers jobs and starts', async () => {
    const handler = vi.fn(async () => {});
    const job: ScheduledJob = {
      name: 'test-job',
      cron: '0 2 * * *',
      handler,
    };

    await scheduler.register(job);
    await scheduler.start();

    expect(scheduler.isRunning()).toBe(true);
  });

  test('stops and reports not running', async () => {
    await scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  test('getType returns "interval"', () => {
    expect(scheduler.getType()).toBe('interval');
  });

  test('remove unregisters job', async () => {
    const handler = vi.fn(async () => {});
    const job: ScheduledJob = {
      name: 'test-job',
      cron: '* * * * *',
      handler,
    };

    await scheduler.register(job);
    await scheduler.remove('test-job');

    // Start and wait - handler should not be called
    await scheduler.start();

    // Access private entries to verify removal
    const entries = (scheduler as any).entries;
    expect(entries.has('test-job')).toBe(false);
  });

  test('cron matching: shouldRun matches wildcard patterns', async () => {
    const handler = vi.fn(async () => {});
    const job: ScheduledJob = {
      name: 'every-minute',
      cron: '* * * * *',
      handler,
    };

    await scheduler.register(job);
    await scheduler.start();

    // Manually trigger tick to test cron matching
    const tick = (scheduler as any).tick.bind(scheduler);
    await tick();

    // Handler should have been called
    expect(handler).toHaveBeenCalled();
  });

  test('prevents running same job twice within 60 seconds', async () => {
    let callCount = 0;
    const handler = vi.fn(async () => {
      callCount++;
    });

    const job: ScheduledJob = {
      name: 'frequent-job',
      cron: '* * * * *',
      handler,
    };

    await scheduler.register(job);
    await scheduler.start();

    // Call tick twice in quick succession
    const tick = (scheduler as any).tick.bind(scheduler);
    await tick();
    await tick();

    // Handler should only be called once (60s cooldown)
    expect(callCount).toBe(1);
  });
});

describe('MongoRetentionStore', () => {
  let store: MongoRetentionStore;

  beforeEach(() => {
    store = new MongoRetentionStore();
    vi.clearAllMocks();

    // Reset chainable mock methods for Session
    mockSession.find.mockReturnThis();
    mockSession.findById.mockReturnThis();
    mockSession.select.mockReturnThis();
    mockSession.limit.mockReturnThis();
    mockSession.lean.mockResolvedValue([]);

    // Reset chainable mock methods for Message
    mockMessage.find.mockReturnThis();
    mockMessage.select.mockReturnThis();
    mockMessage.limit.mockReturnThis();
    mockMessage.lean.mockResolvedValue([]);
  });

  test('archiveSessions updates status with updateMany scoped to tenantId', async () => {
    mockSession.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await store.archiveSessions(['session-1', 'session-2'], 'tenant-1');

    expect(mockSession.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['session-1', 'session-2'] }, tenantId: 'tenant-1' },
      { $set: { status: 'archived', archivedAt: expect.any(Date) } },
    );
  });

  test('deleteSession calls cascadeDeleteSession', async () => {
    await store.deleteSession('session-1', 'tenant-1');

    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('session-1');
  });

  test('scrubPIIBatch updates messages with updateMany in batches scoped to tenantId', async () => {
    mockMessage.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await store.scrubPIIBatch(['msg-1', 'msg-2'], 'tenant-1');

    expect(mockMessage.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['msg-1', 'msg-2'] }, tenantId: 'tenant-1' },
      { $set: { content: '[PII_SCRUBBED]', scrubbed: true } },
    );
  });

  test('scrubPIIBatch handles batching for large sets', async () => {
    const messageIds = Array.from({ length: 250 }, (_, i) => `msg-${i}`);
    mockMessage.updateMany.mockResolvedValue({ modifiedCount: 100 });

    await store.scrubPIIBatch(messageIds, 'tenant-1');

    // Should be called 3 times (100, 100, 50)
    expect(mockMessage.updateMany).toHaveBeenCalledTimes(3);
  });

  test('findSessionsOlderThan returns session IDs', async () => {
    const oldDate = new Date('2023-01-01');
    mockSession.lean.mockResolvedValue([{ _id: 'session-1' }, { _id: 'session-2' }]);

    const result = await store.findSessionsOlderThan('tenant-1', oldDate);

    expect(result).toEqual(['session-1', 'session-2']);
    expect(mockSession.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      status: { $ne: 'archived' },
      lastActivityAt: { $lt: oldDate },
    });
  });

  test('findTracesOlderThan returns empty (no-op, traces live in eventstore)', async () => {
    const result = await store.findTracesOlderThan('tenant-1', new Date('2023-01-01'));
    expect(result).toEqual([]);
    // Should NOT query Message collection
    expect(mockMessage.find).not.toHaveBeenCalled();
  });

  test('deleteTraces is a no-op (traces live in eventstore)', async () => {
    const traceIds = Array.from({ length: 250 }, (_, i) => `trace-${i}`);

    await store.deleteTraces(traceIds);

    // Should NOT delete any messages
    expect(mockMessage.deleteMany).not.toHaveBeenCalled();
  });
});

describe('MongoGDPRStore', () => {
  let store: MongoGDPRStore;

  beforeEach(() => {
    store = new MongoGDPRStore();
    vi.clearAllMocks();

    // Reset chainable mock methods for Session
    mockSession.find.mockReturnThis();
    mockSession.findById.mockReturnThis();
    mockSession.select.mockReturnThis();
    mockSession.limit.mockReturnThis();
    mockSession.lean.mockResolvedValue([]);

    // Reset chainable mock methods for Message
    mockMessage.find.mockReturnThis();
    mockMessage.select.mockReturnThis();
    mockMessage.limit.mockReturnThis();
    mockMessage.lean.mockResolvedValue([]);
  });

  test('anonymizeAuditEntries hashes userId and filters by tenantId', async () => {
    mockAuditLog.updateMany.mockResolvedValue({ modifiedCount: 5 });

    await store.anonymizeAuditEntries('user-123', 'tenant-1');

    expect(mockAuditLog.updateMany).toHaveBeenCalledWith(
      { userId: 'user-123', tenantId: 'tenant-1' },
      { $set: { userId: expect.stringMatching(/^\[ANONYMIZED:[a-f0-9]{12}\]$/) } },
    );
  });

  test('anonymizeTraces uses batched updateMany', async () => {
    const traceIds = ['msg-1', 'msg-2'];
    mockMessage.updateMany.mockResolvedValue({ modifiedCount: 2 });

    await store.anonymizeTraces(traceIds);

    expect(mockMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(mockMessage.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['msg-1', 'msg-2'] } },
      { $set: { content: '[ANONYMIZED]', scrubbed: true } },
    );
  });

  test('anonymizeTraces handles large batches', async () => {
    const traceIds = Array.from({ length: 250 }, (_, i) => `msg-${i}`);
    mockMessage.updateMany.mockResolvedValue({ modifiedCount: 100 });

    await store.anonymizeTraces(traceIds);

    // Should be called 3 times (100, 100, 50)
    expect(mockMessage.updateMany).toHaveBeenCalledTimes(3);
  });

  test('findSubjectSessions queries all user identifier fields', async () => {
    mockSession.lean.mockResolvedValue([{ _id: 'session-1' }, { _id: 'session-2' }]);

    const result = await store.findSubjectSessions('user-123', 'tenant-1');

    expect(result).toEqual(['session-1', 'session-2']);
    expect(mockSession.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [
        { initiatedById: 'user-123' },
        { contactId: 'user-123' },
        { customerId: 'user-123' },
        { anonymousId: 'user-123' },
        { callerNumber: 'user-123' },
      ],
    });
  });

  test('findSubjectMessages finds messages via sessions and contactId', async () => {
    // First lean() call returns sessions (from findAllSubjectSessionIds)
    mockSession.lean.mockResolvedValueOnce([{ _id: 'session-1' }, { _id: 'session-2' }]);
    // Second lean() call returns messages
    mockMessage.lean.mockResolvedValueOnce([{ _id: 'msg-1' }, { _id: 'msg-2' }]);

    const result = await store.findSubjectMessages('user-123', 'tenant-1');

    expect(result).toEqual(['msg-1', 'msg-2']);
    // Session query uses all identifier fields
    expect(mockSession.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [
        { initiatedById: 'user-123' },
        { contactId: 'user-123' },
        { customerId: 'user-123' },
        { anonymousId: 'user-123' },
        { callerNumber: 'user-123' },
      ],
    });
    // Message query uses $or with contactId and session membership
    expect(mockMessage.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [{ contactId: 'user-123' }, { sessionId: { $in: ['session-1', 'session-2'] } }],
    });
  });

  test('findSubjectMessages searches by contactId even when no sessions found', async () => {
    mockSession.lean.mockResolvedValue([]);
    mockMessage.lean.mockResolvedValueOnce([{ _id: 'msg-1' }]);

    const result = await store.findSubjectMessages('user-123', 'tenant-1');

    expect(result).toEqual(['msg-1']);
    // Should still query messages by contactId
    expect(mockMessage.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [{ contactId: 'user-123' }],
    });
  });

  test('findSubjectTraces searches sessions, contactId, content, and metadata', async () => {
    // First lean() returns sessions (from findAllSubjectSessionIds)
    mockSession.lean.mockResolvedValueOnce([{ _id: 'session-1' }]);
    // Second lean() returns trace messages
    mockMessage.lean.mockResolvedValueOnce([{ _id: 'msg-1' }]);

    const result = await store.findSubjectTraces('user-123', 'tenant-1');

    expect(result).toEqual(['msg-1']);
    expect(mockMessage.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      $or: [
        { contactId: 'user-123' },
        { content: { $regex: 'user-123', $options: 'i' } },
        { 'metadata.userId': 'user-123' },
        { 'metadata.email': 'user-123' },
        { 'metadata.externalId': 'user-123' },
        { sessionId: { $in: ['session-1'] } },
      ],
    });
  });

  test('deleteSession calls cascadeDeleteSession', async () => {
    await store.deleteSession('session-1', 'tenant-1');

    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('session-1');
  });
});
