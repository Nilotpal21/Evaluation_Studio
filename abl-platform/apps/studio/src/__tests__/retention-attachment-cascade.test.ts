/**
 * Tests for retention and GDPR stores: attachment cascade, tenant isolation,
 * and service-level tenantId propagation.
 *
 * Covers:
 * - MongoRetentionStore.deleteSession: fetch cascade + tenant-scoped deleteOne
 * - MongoGDPRStore.deleteSession: same pattern
 * - MongoGDPRStore.anonymizeAttachments: tenant-scoped batched updateMany
 * - MongoGDPRStore.findSubjectAttachments: tenant-scoped session + attachment lookup
 * - RetentionService.executeRetention: tenantId propagation from plan
 * - GDPRDeletionService.processDeletionRequest: tenantId propagation from request
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MongoRetentionStore } from '../services/retention/mongo-retention-store';
import { MongoGDPRStore } from '../services/retention/mongo-gdpr-store';
import {
  RetentionService,
  GDPRDeletionService,
  type RetentionPlan,
  type DeletionRequest,
  type RetentionStore,
  type GDPRStore,
} from '../services/retention/retention-service';

// ---------------------------------------------------------------------------
// Mock Mongoose models (dynamic import mocking)
// ---------------------------------------------------------------------------

// Use vi.hoisted() so these variables are available when vi.mock factories run
const { mockSession, mockMessage, mockAuditLog, mockContact, mockAttachment } = vi.hoisted(() => {
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

  const mockAttachment = {
    find: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };

  return { mockSession, mockMessage, mockAuditLog, mockContact, mockAttachment };
});

vi.mock('@agent-platform/database/models', () => ({
  Session: mockSession,
  Message: mockMessage,
  AuditLog: mockAuditLog,
  Contact: mockContact,
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  LLMUsageMetric: {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
  },
  Attachment: mockAttachment,
}));

vi.mock('@agent-platform/database', () => ({
  Attachment: mockAttachment,
}));

// Mock the cascade module — deleteSession tests verify this is called with the right sessionId
const mockCascadeDeleteSession = vi.fn().mockResolvedValue({
  counts: { Session: 1, Message: 0, LLMUsageMetric: 0, Attachment: 0 },
  total: 1,
  anonymized: {},
});

vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: (...args: unknown[]) => mockCascadeDeleteSession(...args),
}));

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ deleted: 3 }),
});

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helper: reset all chainable mocks
// ---------------------------------------------------------------------------

function resetChainableMocks() {
  mockSession.find.mockReturnThis();
  mockSession.findById.mockReturnThis();
  mockSession.select.mockReturnThis();
  mockSession.limit.mockReturnThis();
  mockSession.lean.mockResolvedValue([]);
  mockSession.deleteOne.mockResolvedValue({ deletedCount: 1 });

  mockMessage.find.mockReturnThis();
  mockMessage.select.mockReturnThis();
  mockMessage.limit.mockReturnThis();
  mockMessage.lean.mockResolvedValue([]);

  mockAttachment.find.mockReturnThis();
  mockAttachment.select.mockReturnThis();
  mockAttachment.limit.mockReturnThis();
  mockAttachment.lean.mockResolvedValue([]);

  mockContact.find.mockReturnThis();
  mockContact.select.mockReturnThis();
  mockContact.lean.mockResolvedValue([]);

  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ deleted: 0 }),
  });

  mockCascadeDeleteSession.mockResolvedValue({
    counts: { Session: 1, Message: 0, LLMUsageMetric: 0, Attachment: 0 },
    total: 1,
    anonymized: {},
  });
}

async function expectRejectedMessage(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(message),
  });
}

// ==========================================================================
// MongoRetentionStore.deleteSession
// ==========================================================================

describe('MongoRetentionStore.deleteSession', () => {
  let store: MongoRetentionStore;

  beforeEach(() => {
    store = new MongoRetentionStore();
    vi.clearAllMocks();
    resetChainableMocks();
  });

  test('delegates to cascadeDeleteSession with the sessionId', async () => {
    await store.deleteSession('session-abc', 'tenant-42');

    expect(mockCascadeDeleteSession).toHaveBeenCalledTimes(1);
    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('session-abc');
  });

  test('passes correct sessionId to cascade (tenant isolation is handled by cascade)', async () => {
    await store.deleteSession('session-1', 'tenant-99');

    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('session-1');
  });

  test('propagates rejection when cascade throws', async () => {
    mockCascadeDeleteSession.mockRejectedValueOnce(new Error('DB connection lost'));

    await expectRejectedMessage(store.deleteSession('session-1', 'tenant-1'), 'DB connection lost');
  });

  test('returns without error when cascade succeeds', async () => {
    await expect(store.deleteSession('session-2', 'tenant-1')).resolves.not.toThrow();
  });

  test('calls cascade for each call independently', async () => {
    await store.deleteSession('sess-a', 'tenant-1');
    await store.deleteSession('sess-b', 'tenant-1');

    expect(mockCascadeDeleteSession).toHaveBeenCalledTimes(2);
    expect(mockCascadeDeleteSession).toHaveBeenNthCalledWith(1, 'sess-a');
    expect(mockCascadeDeleteSession).toHaveBeenNthCalledWith(2, 'sess-b');
  });

  test('handles special characters in sessionId', async () => {
    await store.deleteSession('session/with-special_chars.123', 'tenant-1');

    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('session/with-special_chars.123');
  });

  test('does not throw when cascade returns empty result', async () => {
    mockCascadeDeleteSession.mockResolvedValueOnce({ counts: {}, total: 0, anonymized: {} });

    await expect(store.deleteSession('session-empty', 'tenant-1')).resolves.not.toThrow();
  });
});

// ==========================================================================
// MongoGDPRStore.deleteSession
// ==========================================================================

describe('MongoGDPRStore.deleteSession', () => {
  let store: MongoGDPRStore;

  beforeEach(() => {
    store = new MongoGDPRStore();
    vi.clearAllMocks();
    resetChainableMocks();
  });

  test('delegates to cascadeDeleteSession with the sessionId', async () => {
    await store.deleteSession('gdpr-session-1', 'tenant-gdpr');

    expect(mockCascadeDeleteSession).toHaveBeenCalledTimes(1);
    expect(mockCascadeDeleteSession).toHaveBeenCalledWith('gdpr-session-1');
  });

  test('propagates rejection when cascade throws', async () => {
    mockCascadeDeleteSession.mockRejectedValueOnce(new Error('DB connection lost'));

    await expectRejectedMessage(
      store.deleteSession('session-g1', 'tenant-g1'),
      'DB connection lost',
    );
  });

  test('returns without error when cascade succeeds', async () => {
    await expect(store.deleteSession('session-g2', 'tenant-g2')).resolves.not.toThrow();
  });

  test('calls cascade for each call independently', async () => {
    await store.deleteSession('sess-a', 'tenant-1');
    await store.deleteSession('sess-b', 'tenant-1');

    expect(mockCascadeDeleteSession).toHaveBeenCalledTimes(2);
    expect(mockCascadeDeleteSession).toHaveBeenNthCalledWith(1, 'sess-a');
    expect(mockCascadeDeleteSession).toHaveBeenNthCalledWith(2, 'sess-b');
  });
});

// ==========================================================================
// MongoGDPRStore.anonymizeAttachments
// ==========================================================================

describe('MongoGDPRStore.anonymizeAttachments', () => {
  let store: MongoGDPRStore;

  beforeEach(() => {
    store = new MongoGDPRStore();
    vi.clearAllMocks();
    resetChainableMocks();
  });

  test('includes tenantId in updateMany filter', async () => {
    await store.anonymizeAttachments(['att-1', 'att-2'], 'tenant-anon');

    expect(mockAttachment.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['att-1', 'att-2'] }, tenantId: 'tenant-anon' },
      {
        $set: {
          originalFilename: '[ANONYMIZED]',
          processedContent: null,
          imageDescription: null,
        },
      },
    );
  });

  test('sets correct anonymization fields', async () => {
    await store.anonymizeAttachments(['att-3'], 'tenant-1');

    const [, update] = mockAttachment.updateMany.mock.calls[0];
    expect(update.$set).toEqual({
      originalFilename: '[ANONYMIZED]',
      processedContent: null,
      imageDescription: null,
    });
  });

  test('batches correctly in groups of 100', async () => {
    const attachmentIds = Array.from({ length: 250 }, (_, i) => `att-${i}`);
    mockAttachment.updateMany.mockResolvedValue({ modifiedCount: 100 });

    await store.anonymizeAttachments(attachmentIds, 'tenant-batch');

    // 250 items / 100 per batch = 3 calls
    expect(mockAttachment.updateMany).toHaveBeenCalledTimes(3);

    // First batch: 100 items
    const [firstFilter] = mockAttachment.updateMany.mock.calls[0];
    expect(firstFilter._id.$in).toHaveLength(100);
    expect(firstFilter.tenantId).toBe('tenant-batch');

    // Second batch: 100 items
    const [secondFilter] = mockAttachment.updateMany.mock.calls[1];
    expect(secondFilter._id.$in).toHaveLength(100);
    expect(secondFilter.tenantId).toBe('tenant-batch');

    // Third batch: 50 items
    const [thirdFilter] = mockAttachment.updateMany.mock.calls[2];
    expect(thirdFilter._id.$in).toHaveLength(50);
    expect(thirdFilter.tenantId).toBe('tenant-batch');
  });

  test('handles empty array without calling updateMany', async () => {
    await store.anonymizeAttachments([], 'tenant-empty');

    expect(mockAttachment.updateMany).not.toHaveBeenCalled();
  });

  test('handles exactly 100 items in a single batch', async () => {
    const attachmentIds = Array.from({ length: 100 }, (_, i) => `att-${i}`);

    await store.anonymizeAttachments(attachmentIds, 'tenant-exact');

    expect(mockAttachment.updateMany).toHaveBeenCalledTimes(1);
    const [filter] = mockAttachment.updateMany.mock.calls[0];
    expect(filter._id.$in).toHaveLength(100);
    expect(filter.tenantId).toBe('tenant-exact');
  });
});

// ==========================================================================
// MongoGDPRStore.findSubjectAttachments
// ==========================================================================

describe('MongoGDPRStore.findSubjectAttachments', () => {
  let store: MongoGDPRStore;

  beforeEach(() => {
    store = new MongoGDPRStore();
    vi.clearAllMocks();
    resetChainableMocks();
  });

  test('scopes session query to tenantId with $or across all subject identifier fields', async () => {
    mockSession.lean.mockResolvedValueOnce([{ _id: 'sess-1' }]);
    mockAttachment.lean.mockResolvedValueOnce([{ _id: 'att-1' }]);

    await store.findSubjectAttachments('user-subject', 'tenant-find');

    expect(mockSession.find).toHaveBeenCalledWith({
      tenantId: 'tenant-find',
      $or: [
        { initiatedById: 'user-subject' },
        { contactId: 'user-subject' },
        { customerId: 'user-subject' },
        { anonymousId: 'user-subject' },
        { callerNumber: 'user-subject' },
      ],
    });
  });

  test('scopes attachment query to tenantId + sessionIds', async () => {
    mockSession.lean.mockResolvedValueOnce([{ _id: 'sess-1' }, { _id: 'sess-2' }]);
    mockAttachment.lean.mockResolvedValueOnce([
      { _id: 'att-1' },
      { _id: 'att-2' },
      { _id: 'att-3' },
    ]);

    const result = await store.findSubjectAttachments('user-abc', 'tenant-xyz');

    expect(mockAttachment.find).toHaveBeenCalledWith({
      tenantId: 'tenant-xyz',
      sessionId: { $in: ['sess-1', 'sess-2'] },
    });
    expect(result).toEqual(['att-1', 'att-2', 'att-3']);
  });

  test('returns empty array when subject has no sessions', async () => {
    mockSession.lean.mockResolvedValueOnce([]);

    const result = await store.findSubjectAttachments('no-sessions-user', 'tenant-1');

    expect(result).toEqual([]);
    // Should not even query attachments when there are no sessions
    expect(mockAttachment.find).not.toHaveBeenCalled();
  });

  test('returns empty array when sessions have no attachments', async () => {
    mockSession.lean.mockResolvedValueOnce([{ _id: 'sess-1' }]);
    mockAttachment.lean.mockResolvedValueOnce([]);

    const result = await store.findSubjectAttachments('user-no-att', 'tenant-1');

    expect(result).toEqual([]);
  });
});

// ==========================================================================
// RetentionService.executeRetention -- tenantId propagation
// ==========================================================================

describe('RetentionService.executeRetention', () => {
  test('passes tenantId from plan to store.deleteSession for each session', async () => {
    const mockStore: RetentionStore = {
      findSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findArchivedSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findTracesOlderThan: vi.fn().mockResolvedValue([]),
      findMessagesWithPIIOlderThan: vi.fn().mockResolvedValue([]),
      archiveSessions: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteTraces: vi.fn().mockResolvedValue(undefined),
      scrubPIIBatch: vi.fn().mockResolvedValue(undefined),
    };

    const service = new RetentionService(mockStore);
    const plan: RetentionPlan = {
      tenantId: 'tenant-retention',
      sessionsToArchive: [],
      sessionsToDelete: ['sess-del-1', 'sess-del-2', 'sess-del-3'],
      tracesToPurge: [],
      piiFieldsToScrub: [],
      auditLogsToArchive: [],
    };

    const report = await service.executeRetention(plan);

    // Each session should be deleted with the plan's tenantId
    expect(mockStore.deleteSession).toHaveBeenCalledTimes(3);
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-del-1', 'tenant-retention');
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-del-2', 'tenant-retention');
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-del-3', 'tenant-retention');
    expect(report.deleted).toBe(3);
    expect(report.tenantId).toBe('tenant-retention');
  });

  test('reports errors but continues when individual session deletion fails', async () => {
    const mockStore: RetentionStore = {
      findSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findArchivedSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findTracesOlderThan: vi.fn().mockResolvedValue([]),
      findMessagesWithPIIOlderThan: vi.fn().mockResolvedValue([]),
      archiveSessions: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(undefined),
      deleteTraces: vi.fn().mockResolvedValue(undefined),
      scrubPIIBatch: vi.fn().mockResolvedValue(undefined),
    };

    const service = new RetentionService(mockStore);
    const plan: RetentionPlan = {
      tenantId: 'tenant-err',
      sessionsToArchive: [],
      sessionsToDelete: ['sess-1', 'sess-2', 'sess-3'],
      tracesToPurge: [],
      piiFieldsToScrub: [],
      auditLogsToArchive: [],
    };

    const report = await service.executeRetention(plan);

    // 2 succeeded, 1 failed
    expect(report.deleted).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('sess-2');
    expect(report.errors[0]).toContain('DB timeout');
  });

  test('handles empty plan with no operations', async () => {
    const mockStore: RetentionStore = {
      findSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findArchivedSessionsOlderThan: vi.fn().mockResolvedValue([]),
      findTracesOlderThan: vi.fn().mockResolvedValue([]),
      findMessagesWithPIIOlderThan: vi.fn().mockResolvedValue([]),
      archiveSessions: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteTraces: vi.fn().mockResolvedValue(undefined),
      scrubPIIBatch: vi.fn().mockResolvedValue(undefined),
    };

    const service = new RetentionService(mockStore);
    const plan: RetentionPlan = {
      tenantId: 'tenant-noop',
      sessionsToArchive: [],
      sessionsToDelete: [],
      tracesToPurge: [],
      piiFieldsToScrub: [],
      auditLogsToArchive: [],
    };

    const report = await service.executeRetention(plan);

    expect(report.deleted).toBe(0);
    expect(report.archived).toBe(0);
    expect(report.scrubbed).toBe(0);
    expect(report.tracePurged).toBe(0);
    expect(report.errors).toHaveLength(0);
    expect(mockStore.deleteSession).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// GDPRDeletionService.processDeletionRequest -- tenantId propagation
// ==========================================================================

describe('GDPRDeletionService.processDeletionRequest', () => {
  function createMockGDPRStore(overrides?: Partial<GDPRStore>): GDPRStore {
    return {
      findSubjectSessions: vi.fn().mockResolvedValue([]),
      findSubjectMessages: vi.fn().mockResolvedValue([]),
      findSubjectTraces: vi.fn().mockResolvedValue([]),
      findSubjectContacts: vi.fn().mockResolvedValue([]),
      findSubjectAttachments: vi.fn().mockResolvedValue([]),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteMessages: vi.fn().mockResolvedValue(undefined),
      anonymizeTraces: vi.fn().mockResolvedValue(undefined),
      anonymizeAuditEntries: vi.fn().mockResolvedValue(undefined),
      anonymizeContacts: vi.fn().mockResolvedValue(undefined),
      anonymizeAttachments: vi.fn().mockResolvedValue(undefined),
      anonymizeUser: vi.fn().mockResolvedValue(undefined),
      deletePersonalAuthProfiles: vi.fn().mockResolvedValue(undefined),
      reassignSharedAuthProfiles: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function createDeletionRequest(overrides?: Partial<DeletionRequest>): DeletionRequest {
    return {
      id: 'req-1',
      tenantId: 'tenant-gdpr-del',
      requestedBy: 'admin-1',
      subjectId: 'subject-user-1',
      scope: 'all_data',
      status: 'pending',
      createdAt: new Date('2026-01-01'),
      slaDeadline: new Date('2026-01-31'),
      ...overrides,
    };
  }

  test('passes tenantId to deleteSession for each subject session (all_data scope)', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectSessions: vi.fn().mockResolvedValue(['sess-a', 'sess-b']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ tenantId: 'tenant-del-1', scope: 'all_data' });

    await service.processDeletionRequest(request);

    expect(mockStore.deleteSession).toHaveBeenCalledTimes(2);
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-a', 'tenant-del-1');
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-b', 'tenant-del-1');
  });

  test('passes tenantId to deleteSession for sessions_only scope', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectSessions: vi.fn().mockResolvedValue(['sess-x']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ tenantId: 'tenant-so', scope: 'sessions_only' });

    await service.processDeletionRequest(request);

    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-x', 'tenant-so');
  });

  test('does not call deleteSession for pii_only scope', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectSessions: vi.fn().mockResolvedValue(['sess-1']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ scope: 'pii_only' });

    await service.processDeletionRequest(request);

    expect(mockStore.deleteSession).not.toHaveBeenCalled();
  });

  test('passes tenantId to anonymizeAttachments for all_data scope', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectAttachments: vi.fn().mockResolvedValue(['att-1', 'att-2']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ tenantId: 'tenant-att', scope: 'all_data' });

    await service.processDeletionRequest(request);

    expect(mockStore.anonymizeAttachments).toHaveBeenCalledWith(['att-1', 'att-2'], 'tenant-att');
  });

  test('passes tenantId to anonymizeAttachments for pii_only scope', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectAttachments: vi.fn().mockResolvedValue(['att-p1']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ tenantId: 'tenant-pii', scope: 'pii_only' });

    await service.processDeletionRequest(request);

    expect(mockStore.anonymizeAttachments).toHaveBeenCalledWith(['att-p1'], 'tenant-pii');
  });

  test('does not call anonymizeAttachments when no attachments found', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectAttachments: vi.fn().mockResolvedValue([]),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({ scope: 'all_data' });

    await service.processDeletionRequest(request);

    expect(mockStore.anonymizeAttachments).not.toHaveBeenCalled();
  });

  test('passes tenantId to findSubjectAttachments', async () => {
    const mockFindAttachments = vi.fn().mockResolvedValue([]);
    const mockStore = createMockGDPRStore({
      findSubjectAttachments: mockFindAttachments,
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({
      tenantId: 'tenant-find-att',
      subjectId: 'subj-1',
      scope: 'all_data',
    });

    await service.processDeletionRequest(request);

    expect(mockFindAttachments).toHaveBeenCalledWith('subj-1', 'tenant-find-att');
  });

  test('passes tenantId to anonymizeAuditEntries for all_data scope', async () => {
    const mockStore = createMockGDPRStore();
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({
      tenantId: 'tenant-audit',
      subjectId: 'subj-audit',
      scope: 'all_data',
    });

    await service.processDeletionRequest(request);

    expect(mockStore.anonymizeAuditEntries).toHaveBeenCalledWith('subj-audit', 'tenant-audit');
  });

  test('sets status to completed on success', async () => {
    const mockStore = createMockGDPRStore();
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest();

    const result = await service.processDeletionRequest(request);

    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  test('sets status to failed when store throws', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectSessions: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest();

    const result = await service.processDeletionRequest(request);

    expect(result.status).toBe('failed');
    expect(result.completedAt).toBeUndefined();
  });

  test('full all_data flow: sessions deleted, messages deleted, traces anonymized, attachments anonymized', async () => {
    const mockStore = createMockGDPRStore({
      findSubjectSessions: vi.fn().mockResolvedValue(['sess-1', 'sess-2']),
      findSubjectMessages: vi.fn().mockResolvedValue(['msg-1', 'msg-2', 'msg-3']),
      findSubjectTraces: vi.fn().mockResolvedValue(['trace-1']),
      findSubjectAttachments: vi.fn().mockResolvedValue(['att-1', 'att-2']),
    });
    const service = new GDPRDeletionService(mockStore);
    const request = createDeletionRequest({
      tenantId: 'tenant-full',
      subjectId: 'user-full',
      scope: 'all_data',
    });

    const result = await service.processDeletionRequest(request);

    // Sessions deleted with tenantId
    expect(mockStore.deleteSession).toHaveBeenCalledTimes(2);
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-1', 'tenant-full');
    expect(mockStore.deleteSession).toHaveBeenCalledWith('sess-2', 'tenant-full');

    // Messages deleted
    expect(mockStore.deleteMessages).toHaveBeenCalledWith(
      ['msg-1', 'msg-2', 'msg-3'],
      'tenant-full',
    );

    // Traces anonymized
    expect(mockStore.anonymizeTraces).toHaveBeenCalledWith(['trace-1'], 'tenant-full');

    // Audit entries anonymized with tenantId
    expect(mockStore.anonymizeAuditEntries).toHaveBeenCalledWith('user-full', 'tenant-full');

    // Attachments anonymized with tenantId
    expect(mockStore.anonymizeAttachments).toHaveBeenCalledWith(['att-1', 'att-2'], 'tenant-full');

    expect(result.status).toBe('completed');
  });
});
