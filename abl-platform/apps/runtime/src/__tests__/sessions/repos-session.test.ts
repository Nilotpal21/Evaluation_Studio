/**
 * Session Repository Integration Tests
 *
 * Tests session-repo.ts functions against a real in-memory MongoDB.
 * Covers CRUD, querying, bulk operations, message persistence,
 * and cleanup operations.
 *
 * IMPORTANT: All imports from @agent-platform/database/models and repo
 * modules MUST be dynamic (inside beforeAll) because the models barrel
 * triggers an auto-connect on import.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  ensureTestIndexes,
} from '../helpers/setup-mongo.js';

// ─── Lazy-loaded references (populated in beforeAll after Mongo is ready) ───

let Session: any;
let Message: any;

let findSessionById: any;
let findSessionByRuntimeId: any;
let findStoredSessionByAnyId: any;
let findSessionSummaryByAnyId: any;
let listSessions: any;
let countSessions: any;
let updateSession: any;
let updateSessionActivity: any;
let incrementSessionTokens: any;
let incrementSessionMetrics: any;
let applySessionTurnUpdate: any;
let unlinkContactFromSessions: any;
let findMessagesForSession: any;
let findMessagesForSessionCursor: any;
let batchCreateMessages: any;
let findOldSessions: any;
let deleteSessionsByIds: any;
let deleteOldMessages: any;

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Connect to in-memory MongoDB FIRST (before models auto-connect)
  await setupTestMongo();

  // Dynamic imports AFTER mongo is connected
  const models = await import('@agent-platform/database/models');
  models.setMasterKey('a'.repeat(64));
  await initDEKFacade({ masterKeyHex: 'a'.repeat(64) });
  Session = models.Session;
  Message = models.Message;

  // Ensure unique sparse indexes (e.g. idempotencyKey) are built before tests
  await ensureTestIndexes('runtime-message-indexes', async () => {
    await Message.syncIndexes();
  });

  const repo = await import('../../repos/session-repo.js');
  findSessionById = repo.findSessionById;
  findSessionByRuntimeId = repo.findSessionByRuntimeId;
  findStoredSessionByAnyId = repo.findStoredSessionByAnyId;
  findSessionSummaryByAnyId = repo.findSessionSummaryByAnyId;
  listSessions = repo.listSessions;
  countSessions = repo.countSessions;
  updateSession = repo.updateSession;
  updateSessionActivity = repo.updateSessionActivity;
  incrementSessionTokens = repo.incrementSessionTokens;
  incrementSessionMetrics = repo.incrementSessionMetrics;
  applySessionTurnUpdate = repo.applySessionTurnUpdate;
  unlinkContactFromSessions = repo.unlinkContactFromSessions;
  findMessagesForSession = repo.findMessagesForSession;
  findMessagesForSessionCursor = repo.findMessagesForSessionCursor;
  batchCreateMessages = repo.batchCreateMessages;
  findOldSessions = repo.findOldSessions;
  deleteSessionsByIds = repo.deleteSessionsByIds;
  deleteOldMessages = repo.deleteOldMessages;
}, 60_000);

afterAll(async () => {
  await teardownTestMongo();
}, 15_000);

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    currentAgent: 'booking_agent',
    environment: 'dev',
    channel: 'web',
    status: 'active',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

let msgCounter = 0;
function makeMessage(overrides: Record<string, unknown> = {}) {
  msgCounter += 1;
  return {
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    role: 'user' as const,
    content: 'Hello',
    channel: 'web',
    timestamp: new Date(),
    // Generate a unique idempotencyKey by default so the sparse unique index
    // does not conflict when multiple messages lack an explicit key.
    idempotencyKey: `auto-${Date.now()}-${msgCounter}`,
    ...overrides,
  };
}

// #############################################################################
// findSessionById
// #############################################################################

describe('session-repo: findSessionById', () => {
  it('returns session with normalized id when found', async () => {
    const session = await Session.create(makeSession());
    const result = await findSessionById(session._id, 'tenant-1');

    expect(result).not.toBeNull();
    // Use String() to compare ObjectId instances by value, not by reference
    expect(String(result!.id)).toBe(String(session._id));
    expect(result!.status).toBe('active');
    expect(result!.tenantId).toBe('tenant-1');
  });

  it('returns null when session does not exist', async () => {
    const result = await findSessionById('nonexistent-id', 'tenant-1');
    expect(result).toBeNull();
  });

  it('excludes context and metadata fields from projection', async () => {
    const session = await Session.create(
      makeSession({ context: { foo: 'bar' }, metadata: { key: 'val' } }),
    );
    const result = await findSessionById(session._id, 'tenant-1');

    expect(result).not.toBeNull();
    // context and metadata should be excluded by the select('-context -metadata')
    expect(result!.context).toBeUndefined();
    expect(result!.metadata).toBeUndefined();
  });

  it('returns null when tenantId does not match (cross-tenant isolation)', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-1' }));

    // Querying with the correct id but a different tenantId must return null
    const result = await findSessionById(session._id, 'tenant-OTHER');

    expect(result).toBeNull();
  });

  it('returns session when tenantId matches', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-1' }));

    const result = await findSessionById(session._id, 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-1');
  });
});

// #############################################################################
// findSessionByRuntimeId
// #############################################################################

describe('session-repo: findSessionByRuntimeId', () => {
  it('preserves compatibility for callers passing the canonical stored session id', async () => {
    const session = await Session.create(makeSession());

    const result = await findSessionByRuntimeId(session._id, 'tenant-1');

    expect(result).not.toBeNull();
    expect(String(result!.id)).toBe(String(session._id));
  });

  it('returns null when the canonical session id does not match', async () => {
    await Session.create(makeSession());

    const result = await findSessionByRuntimeId('rt-nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });

  it('returns null when tenantId does not match (cross-tenant isolation)', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-1' }));

    const result = await findSessionByRuntimeId(session._id, 'tenant-OTHER');
    expect(result).toBeNull();
  });

  it('returns session when tenantId matches', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-1' }));

    const result = await findSessionByRuntimeId(session._id, 'tenant-1');
    expect(result).not.toBeNull();
    expect(String(result!.id)).toBe(String(session._id));
    expect(result!.tenantId).toBe('tenant-1');
  });
});

// #############################################################################
// findStoredSessionByAnyId
// #############################################################################

describe('session-repo: findStoredSessionByAnyId', () => {
  it('resolves a stored session by its canonical id', async () => {
    const session = await Session.create(makeSession());

    const result = await findStoredSessionByAnyId(session._id, 'tenant-1');

    expect(result).not.toBeNull();
    expect(String(result!.id)).toBe(String(session._id));
  });

  it('returns null when the canonical session id does not exist', async () => {
    await Session.create(makeSession());

    const result = await findStoredSessionByAnyId('runtime-session-abc', 'tenant-1');

    expect(result).toBeNull();
  });

  it('preserves tenant isolation when resolving canonical session ids', async () => {
    const session = await Session.create(makeSession({ tenantId: 't-1' }));

    const result = await findStoredSessionByAnyId(session._id, 't-2');

    expect(result).toBeNull();
  });
});

// #############################################################################
// findSessionSummaryByAnyId
// #############################################################################

describe('session-repo: findSessionSummaryByAnyId', () => {
  it('finds a session by canonical DB id for summary lookups', async () => {
    const session = await Session.create(makeSession({ context: { foo: 'bar' } }));

    const result = await findSessionSummaryByAnyId(session._id);

    expect(result).not.toBeNull();
    expect(String(result!.id)).toBe(String(session._id));
    expect(result!.context).toBeUndefined();
  });

  it('returns null when the canonical summary session id does not exist', async () => {
    await Session.create(makeSession());

    const result = await findSessionSummaryByAnyId('runtime-session-summary');

    expect(result).toBeNull();
  });
});

// #############################################################################
// listSessions
// #############################################################################

describe('session-repo: listSessions', () => {
  it('returns empty array when no sessions match', async () => {
    const result = await listSessions({ projectId: 'proj-nonexistent' });
    expect(result).toEqual([]);
  });

  it('filters by where clause', async () => {
    await Session.create(makeSession({ projectId: 'proj-1', status: 'active' }));
    await Session.create(makeSession({ projectId: 'proj-1', status: 'ended' }));
    await Session.create(makeSession({ projectId: 'proj-2', status: 'active' }));

    const result = await listSessions({ projectId: 'proj-1', status: 'active' });

    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe('proj-1');
    expect(result[0].status).toBe('active');
  });

  it('normalizes _id to id on all returned documents', async () => {
    await Session.create(makeSession());

    const result = await listSessions({ tenantId: 'tenant-1' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBeDefined();
    expect(result[0]._id).toBeDefined();
    expect(result[0].id).toEqual(result[0]._id);
  });

  it('applies skip and take for pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await Session.create(makeSession({ projectId: 'proj-page' }));
    }

    const page = await listSessions({ projectId: 'proj-page' }, { skip: 2, take: 2 });

    expect(page).toHaveLength(2);
  });

  it('applies orderBy sorting', async () => {
    const now = new Date();
    await Session.create(
      makeSession({
        projectId: 'proj-sort',
        startedAt: new Date(now.getTime() - 2000),
        lastActivityAt: new Date(now.getTime() - 2000),
      }),
    );
    await Session.create(
      makeSession({
        projectId: 'proj-sort',
        startedAt: new Date(now.getTime() - 1000),
        lastActivityAt: new Date(now.getTime() - 1000),
      }),
    );
    await Session.create(
      makeSession({
        projectId: 'proj-sort',
        startedAt: now,
        lastActivityAt: now,
      }),
    );

    const result = await listSessions(
      { projectId: 'proj-sort' },
      { orderBy: { startedAt: 'desc' } },
    );

    expect(result).toHaveLength(3);
    const timestamps = result.map((s: any) => new Date(s.startedAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[2]);
  });

  it('applies select projection and maps id to _id', async () => {
    await Session.create(makeSession({ projectId: 'proj-select' }));

    const result = await listSessions(
      { projectId: 'proj-select' },
      { select: { id: true, status: true } },
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBeDefined();
    expect(result[0].status).toBe('active');
  });
});

// #############################################################################
// countSessions
// #############################################################################

describe('session-repo: countSessions', () => {
  it('returns 0 when no sessions match', async () => {
    const count = await countSessions({ projectId: 'nonexistent' });
    expect(count).toBe(0);
  });

  it('returns correct count for matching filter', async () => {
    await Session.create(makeSession({ projectId: 'proj-count', status: 'active' }));
    await Session.create(makeSession({ projectId: 'proj-count', status: 'active' }));
    await Session.create(makeSession({ projectId: 'proj-count', status: 'ended' }));

    const count = await countSessions({ projectId: 'proj-count', status: 'active' });
    expect(count).toBe(2);
  });
});

// #############################################################################
// updateSession
// #############################################################################

describe('session-repo: updateSession', () => {
  it('updates and returns the modified session', async () => {
    const session = await Session.create(makeSession());

    const result = await updateSession(session._id, { status: 'completed' }, 'tenant-1');

    expect(result).not.toBeNull();
    expect(result.status).toBe('completed');
  });

  it('returns null when session does not exist', async () => {
    const result = await updateSession('nonexistent-id', { status: 'completed' }, 'tenant-1');
    expect(result).toBeNull();
  });

  it('only updates specified fields without overwriting others', async () => {
    const session = await Session.create(makeSession({ channel: 'web', currentAgent: 'agent_a' }));

    await updateSession(session._id, { status: 'ended' }, 'tenant-1');

    const fresh = await Session.findOne({ _id: session._id }).lean();
    expect(fresh!.status).toBe('ended');
    expect(fresh!.channel).toBe('web');
    expect(fresh!.currentAgent).toBe('agent_a');
  });
});

// #############################################################################
// updateSessionActivity
// #############################################################################

describe('session-repo: updateSessionActivity', () => {
  it('updates lastActivityAt and increments messageCount', async () => {
    const session = await Session.create(makeSession({ messageCount: 5 }));
    const beforeUpdate = session.lastActivityAt;

    // Small delay to ensure date changes
    await new Promise((r) => setTimeout(r, 10));
    await updateSessionActivity(session._id, 3, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.messageCount).toBe(8);
    expect(new Date(updated!.lastActivityAt).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeUpdate).getTime(),
    );
  });
});

// #############################################################################
// incrementSessionTokens
// #############################################################################

describe('session-repo: incrementSessionTokens', () => {
  it('atomically increments tokenCount and estimatedCost', async () => {
    const session = await Session.create(makeSession({ tokenCount: 100, estimatedCost: 0.01 }));

    await incrementSessionTokens(session._id, 250, 0.005, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.tokenCount).toBe(350);
    expect(updated!.estimatedCost).toBeCloseTo(0.015, 5);
  });
});

// #############################################################################
// incrementSessionMetrics
// #############################################################################

describe('session-repo: incrementSessionMetrics', () => {
  it('increments traceEventCount', async () => {
    const session = await Session.create(makeSession({ traceEventCount: 10 }));

    await incrementSessionMetrics(session._id, { traceEventCount: 5 }, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.traceEventCount).toBe(15);
  });

  it('increments errorCount and handoffCount together', async () => {
    const session = await Session.create(makeSession({ errorCount: 1, handoffCount: 2 }));

    await incrementSessionMetrics(session._id, { errorCount: 3, handoffCount: 1 }, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.errorCount).toBe(4);
    expect(updated!.handoffCount).toBe(3);
  });

  it('no-ops when all increments are zero or undefined', async () => {
    const session = await Session.create(makeSession({ traceEventCount: 5 }));

    await incrementSessionMetrics(session._id, {}, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.traceEventCount).toBe(5);
  });
});

// #############################################################################
// applySessionTurnUpdate
// #############################################################################

describe('session-repo: applySessionTurnUpdate', () => {
  it('updates activity and increments all turn counters in one write', async () => {
    const originalActivityAt = new Date('2026-01-01T00:00:00.000Z');
    const session = await Session.create(
      makeSession({
        lastActivityAt: originalActivityAt,
        messageCount: 2,
        tokenCount: 100,
        estimatedCost: 0.01,
        traceEventCount: 4,
        errorCount: 1,
        handoffCount: 0,
      }),
    );

    await applySessionTurnUpdate(
      session._id,
      {
        messageCountIncrement: 2,
        tokenCountIncrement: 50,
        estimatedCostIncrement: 0.005,
        traceEventCountIncrement: 3,
        errorCountIncrement: 1,
        handoffCountIncrement: 2,
        touchLastActivityAt: true,
      },
      'tenant-1',
    );

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.messageCount).toBe(4);
    expect(updated!.tokenCount).toBe(150);
    expect(updated!.estimatedCost).toBeCloseTo(0.015, 5);
    expect(updated!.traceEventCount).toBe(7);
    expect(updated!.errorCount).toBe(2);
    expect(updated!.handoffCount).toBe(2);
    expect(updated!.lastActivityAt.getTime()).toBeGreaterThan(originalActivityAt.getTime());
  });

  it('no-ops when no increments and no activity touch are provided', async () => {
    const session = await Session.create(makeSession({ traceEventCount: 5 }));

    await applySessionTurnUpdate(session._id, {}, 'tenant-1');

    const updated = await Session.findOne({ _id: session._id }).lean();
    expect(updated!.traceEventCount).toBe(5);
  });
});

// #############################################################################
// unlinkContactFromSessions
// #############################################################################

describe('session-repo: unlinkContactFromSessions', () => {
  it('sets contactId to null on all sessions with the given contactId', async () => {
    await Session.create(makeSession({ contactId: 'contact-1' }));
    await Session.create(makeSession({ contactId: 'contact-1' }));
    await Session.create(makeSession({ contactId: 'contact-2' }));

    await unlinkContactFromSessions('contact-1', 'tenant-1');

    const sessions = await Session.find({ contactId: 'contact-1' }).lean();
    expect(sessions).toHaveLength(0);

    const unaffected = await Session.find({ contactId: 'contact-2' }).lean();
    expect(unaffected).toHaveLength(1);
  });
});

// #############################################################################
// findMessagesForSession
// #############################################################################

describe('session-repo: findMessagesForSession', () => {
  it('returns messages for a session sorted by timestamp ascending', async () => {
    const now = new Date();
    await Message.create(
      makeMessage({
        sessionId: 'sess-msg-1',
        content: 'First',
        timestamp: new Date(now.getTime() - 2000),
      }),
    );
    await Message.create(
      makeMessage({
        sessionId: 'sess-msg-1',
        content: 'Second',
        timestamp: new Date(now.getTime() - 1000),
      }),
    );
    await Message.create(
      makeMessage({
        sessionId: 'sess-msg-1',
        content: 'Third',
        timestamp: now,
      }),
    );

    const messages = await findMessagesForSession('sess-msg-1');

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
  });

  it('returns only selected fields (id, role, content, timestamp)', async () => {
    await Message.create(
      makeMessage({ sessionId: 'sess-field', content: 'Test', role: 'assistant' }),
    );

    const messages = await findMessagesForSession('sess-field');

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBeDefined();
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Test');
    expect(messages[0].timestamp).toBeInstanceOf(Date);
  });

  it('returns message metadata when present', async () => {
    await Message.create(
      makeMessage({
        sessionId: 'sess-metadata',
        role: 'assistant',
        content: 'Generated response',
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      }),
    );

    const messages = await findMessagesForSession('sess-metadata');

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
  });

  it('merges top-level agentName into metadata for transcript readback', async () => {
    await Message.create(
      makeMessage({
        sessionId: 'sess-agent-attribution',
        role: 'assistant',
        content: 'Policy guidance',
        agentName: 'PolicyAdvisor',
        metadata: {
          isLlmGenerated: true,
        },
      }),
    );

    const messages = await findMessagesForSession('sess-agent-attribution');

    expect(messages).toHaveLength(1);
    expect(messages[0].agentName).toBe('PolicyAdvisor');
    expect(messages[0].metadata).toEqual({
      isLlmGenerated: true,
      agentName: 'PolicyAdvisor',
    });
  });

  it('adds metadata agentName from top-level attribution when metadata is absent', async () => {
    await Message.create(
      makeMessage({
        sessionId: 'sess-agent-attribution-only',
        role: 'assistant',
        content: 'Policy guidance',
        agentName: 'PolicyAdvisor',
      }),
    );

    const messages = await findMessagesForSession('sess-agent-attribution-only');

    expect(messages).toHaveLength(1);
    expect(messages[0].agentName).toBe('PolicyAdvisor');
    expect(messages[0].metadata).toEqual({
      agentName: 'PolicyAdvisor',
    });
  });

  it('decodes legacy JSON content blocks into rawContent for runtime resume paths', async () => {
    const blocks = [
      { type: 'text', text: 'Please see the attached image.' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/demo.png' },
      },
    ];

    await Message.create(
      makeMessage({
        sessionId: 'sess-structured',
        content: JSON.stringify(blocks),
        role: 'assistant',
      }),
    );

    const messages = await findMessagesForSession('sess-structured');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Please see the attached image.');
    expect(messages[0].rawContent).toEqual(blocks);
  });

  it('prefers the canonical contentEnvelope field when present', async () => {
    const contentEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Structured resume response.',
      blocks: [{ type: 'text', text: 'Structured resume response.' }],
      richContent: { markdown: '**Structured resume response.**' },
      actions: {
        elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
      },
      voiceConfig: { plain_text: 'Structured resume response.' },
    };

    await Message.create(
      makeMessage({
        sessionId: 'sess-envelope',
        content: 'Structured resume response.',
        contentEnvelope: JSON.stringify(contentEnvelope),
        role: 'assistant',
      }),
    );

    const messages = await findMessagesForSession('sess-envelope');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Structured resume response.');
    expect(messages[0].rawContent).toEqual(contentEnvelope.blocks);
    expect(messages[0].contentEnvelope).toEqual(contentEnvelope);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await Message.create(
        makeMessage({
          sessionId: 'sess-limit',
          content: `Message ${i}`,
          timestamp: new Date(Date.now() + i * 1000),
        }),
      );
    }

    const messages = await findMessagesForSession('sess-limit', 5);
    expect(messages).toHaveLength(5);
  });

  it('returns empty array when no messages exist for session', async () => {
    const messages = await findMessagesForSession('nonexistent-sess');
    expect(messages).toEqual([]);
  });
});

// #############################################################################
// session-repo: findMessagesForSession tenant isolation
// #############################################################################

describe('session-repo: findMessagesForSession tenant isolation', () => {
  it('returns empty array when session belongs to different tenant', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-A' }));
    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-A',
        content: 'Secret message',
        timestamp: new Date(),
      }),
    );

    // Try to fetch messages with wrong tenantId — message has tenantId 'tenant-A'
    // so filtering by 'tenant-B' correctly returns nothing
    const messages = await findMessagesForSession(session._id, 200, 'tenant-B');
    expect(messages).toEqual([]);
  });

  it('returns messages when session belongs to correct tenant', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-correct-msg' }));
    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-correct-msg',
        content: 'Visible message',
        timestamp: new Date(),
      }),
    );

    const messages = await findMessagesForSession(session._id, 200, 'tenant-correct-msg');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Visible message');
  });
});

// #############################################################################
// findMessagesForSessionCursor
// #############################################################################

describe('session-repo: findMessagesForSessionCursor', () => {
  it('returns empty result when session does not belong to tenant', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-A' }));
    await Message.create(
      makeMessage({ sessionId: session._id, content: 'secret', timestamp: new Date() }),
    );

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-OTHER');

    expect(result.messages).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('returns messages in desc order by default', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-desc' }));
    for (let i = 1; i <= 3; i++) {
      await Message.create(
        makeMessage({
          sessionId: session._id,
          tenantId: 'tenant-cursor-desc',
          timestamp: new Date(i * 1000),
        }),
      );
    }

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-cursor-desc');

    expect(result.messages).toHaveLength(3);
    // Verify returned _ids are in descending string order (UUIDv7 sorts lexicographically)
    const returnedIds = result.messages.map((m: any) => String(m.id));
    const sortedDesc = [...returnedIds].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const sortedAscCmp = [...returnedIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(returnedIds).toEqual(sortedDesc);
    // Confirm it is NOT in ascending order (independent non-mutated reference)
    expect(returnedIds).not.toEqual(sortedAscCmp);
  });

  it('surfaces rawContent when cursor pagination loads legacy structured messages', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-structured' }));
    const blocks = [{ type: 'text', text: 'Rendered from structured history.' }];

    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-cursor-structured',
        content: JSON.stringify(blocks),
        timestamp: new Date(),
      }),
    );

    const result = await findMessagesForSessionCursor(
      String(session._id),
      'tenant-cursor-structured',
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Rendered from structured history.');
    expect(result.messages[0].rawContent).toEqual(blocks);
  });

  it('surfaces the canonical contentEnvelope during cursor pagination', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-envelope' }));
    const contentEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Cursor structured response.',
      richContent: { markdown: '**Cursor structured response.**' },
      actions: {
        elements: [{ id: 'cursor-next', type: 'button', label: 'Next' }],
      },
    };

    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-cursor-envelope',
        content: 'Cursor structured response.',
        contentEnvelope: JSON.stringify(contentEnvelope),
        timestamp: new Date(),
      }),
    );

    const result = await findMessagesForSessionCursor(
      String(session._id),
      'tenant-cursor-envelope',
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].contentEnvelope).toEqual(contentEnvelope);
  });

  it('returns message metadata during cursor pagination', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-metadata' }));

    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-cursor-metadata',
        role: 'assistant',
        content: 'Cursor metadata response',
        metadata: {
          isLlmGenerated: false,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'scripted',
            disclaimerRequired: false,
            usedLlmInternally: true,
          },
        },
        timestamp: new Date(),
      }),
    );

    const result = await findMessagesForSessionCursor(
      String(session._id),
      'tenant-cursor-metadata',
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].metadata).toEqual({
      isLlmGenerated: false,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'scripted',
        disclaimerRequired: false,
        usedLlmInternally: true,
      },
    });
  });

  it('merges top-level agentName into cursor metadata for transcript readback', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-agent' }));

    await Message.create(
      makeMessage({
        sessionId: session._id,
        tenantId: 'tenant-cursor-agent',
        role: 'assistant',
        content: 'Cursor agent response',
        agentName: 'FulfillmentSpecialist',
        metadata: {
          isLlmGenerated: true,
        },
        timestamp: new Date(),
      }),
    );

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-cursor-agent');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].agentName).toBe('FulfillmentSpecialist');
    expect(result.messages[0].metadata).toEqual({
      isLlmGenerated: true,
      agentName: 'FulfillmentSpecialist',
    });
  });

  it('returns messages in asc order when direction=asc', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-asc' }));
    for (let i = 1; i <= 3; i++) {
      await Message.create(
        makeMessage({
          sessionId: session._id,
          tenantId: 'tenant-cursor-asc',
          timestamp: new Date(i * 1000),
        }),
      );
    }

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-cursor-asc', {
      direction: 'asc',
    });

    expect(result.messages).toHaveLength(3);
    // Verify returned _ids are in ascending string order (UUIDv7 sorts lexicographically)
    const returnedIds = result.messages.map((m: any) => String(m.id));
    const sortedAsc = [...returnedIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sortedDescCmp = [...returnedIds].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    expect(returnedIds).toEqual(sortedAsc);
    // Confirm it is NOT in descending order (independent non-mutated reference)
    expect(returnedIds).not.toEqual(sortedDescCmp);
  });

  it('sets hasMore=true and nextCursor when results exceed limit', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-paged' }));
    for (let i = 1; i <= 5; i++) {
      await Message.create(
        makeMessage({
          sessionId: session._id,
          tenantId: 'tenant-cursor-paged',
          content: `page-${i}`,
          timestamp: new Date(i * 1000),
        }),
      );
    }

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-cursor-paged', {
      limit: 3,
      direction: 'asc',
    });

    expect(result.messages).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('sets hasMore=false when all results fit within limit', async () => {
    const session = await Session.create(makeSession({ tenantId: 'tenant-cursor-full' }));
    for (let i = 1; i <= 2; i++) {
      await Message.create(
        makeMessage({
          sessionId: session._id,
          tenantId: 'tenant-cursor-full',
          content: `full-${i}`,
          timestamp: new Date(i * 1000),
        }),
      );
    }

    const result = await findMessagesForSessionCursor(String(session._id), 'tenant-cursor-full', {
      limit: 10,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// #############################################################################
// batchCreateMessages
// #############################################################################

describe('session-repo: batchCreateMessages', () => {
  it('creates multiple messages in a single batch insert', async () => {
    const msgs = [
      makeMessage({ sessionId: 'sess-batch', content: 'Msg 1', timestamp: new Date() }),
      makeMessage({
        sessionId: 'sess-batch',
        content: 'Msg 2',
        role: 'assistant',
        timestamp: new Date(),
      }),
    ];

    await batchCreateMessages(msgs);

    const stored = await Message.find({ sessionId: 'sess-batch' }).lean();
    expect(stored).toHaveLength(2);
  });

  it('persists contentEnvelope alongside the flattened text preview', async () => {
    const contentEnvelope = {
      version: 2,
      format: 'message_envelope',
      text: 'Batch rich response.',
      richContent: { markdown: '**Batch rich response.**' },
    };

    await batchCreateMessages([
      makeMessage({
        sessionId: 'sess-batch-envelope',
        role: 'assistant',
        content: 'Batch rich response.',
        contentEnvelope: JSON.stringify(contentEnvelope),
        timestamp: new Date(),
      }),
    ]);

    const [stored] = await Message.find({ sessionId: 'sess-batch-envelope' }).lean();
    expect(stored).toBeDefined();
    expect(stored.content).toBe('Batch rich response.');
    expect(stored.contentEnvelope).toBe(JSON.stringify(contentEnvelope));
  });

  it('ignores duplicate key errors from idempotencyKey', async () => {
    const key = 'idem-key-abc-123';
    const msg1 = makeMessage({
      sessionId: 'sess-idem',
      content: 'First',
      idempotencyKey: key,
      timestamp: new Date(),
    });

    await batchCreateMessages([msg1]);

    // Second attempt with same idempotencyKey should not throw
    const msg2 = makeMessage({
      sessionId: 'sess-idem',
      content: 'Dupe',
      idempotencyKey: key,
      timestamp: new Date(),
    });
    await expect(batchCreateMessages([msg2])).resolves.not.toThrow();

    // Only one message should exist
    const stored = await Message.find({ idempotencyKey: key }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('First');
  });
});

// #############################################################################
// findOldSessions
// #############################################################################

describe('session-repo: findOldSessions', () => {
  it('returns sessions older than cutoff with matching statuses', async () => {
    const old = new Date(Date.now() - 100000);
    const recent = new Date();
    await Session.create(
      makeSession({
        lastActivityAt: old,
        startedAt: old,
        status: 'ended',
      }),
    );
    await Session.create(
      makeSession({
        lastActivityAt: recent,
        startedAt: recent,
        status: 'ended',
      }),
    );
    await Session.create(
      makeSession({
        lastActivityAt: old,
        startedAt: old,
        status: 'active',
      }),
    );

    const cutoff = new Date(Date.now() - 50000);
    const result = await findOldSessions(cutoff, ['ended', 'completed'], 100);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBeDefined();
  });

  it('respects batchSize limit', async () => {
    const old = new Date(Date.now() - 100000);
    for (let i = 0; i < 5; i++) {
      await Session.create(
        makeSession({
          lastActivityAt: old,
          startedAt: old,
          status: 'ended',
        }),
      );
    }

    const cutoff = new Date(Date.now() - 50000);
    const result = await findOldSessions(cutoff, ['ended'], 3);

    expect(result).toHaveLength(3);
  });

  it('returns empty when no sessions match', async () => {
    const cutoff = new Date(Date.now() - 50000);
    const result = await findOldSessions(cutoff, ['ended'], 100);
    expect(result).toEqual([]);
  });
});

// #############################################################################
// deleteSessionsByIds
// #############################################################################

describe('session-repo: deleteSessionsByIds', () => {
  it('deletes sessions by their IDs and returns count', async () => {
    const s1 = await Session.create(makeSession());
    const s2 = await Session.create(makeSession());
    await Session.create(makeSession());

    const deleted = await deleteSessionsByIds([s1._id, s2._id], 'tenant-1');

    expect(deleted).toBe(2);

    const remaining = await Session.countDocuments();
    expect(remaining).toBe(1);
  });

  it('returns 0 when no IDs match', async () => {
    const deleted = await deleteSessionsByIds(['nonexistent-1', 'nonexistent-2'], 'tenant-1');
    expect(deleted).toBe(0);
  });
});

// #############################################################################
// deleteOldMessages
// #############################################################################

describe('session-repo: deleteOldMessages', () => {
  it('deletes messages for sessions in terminal status before cutoff', async () => {
    const session = await Session.create(makeSession({ status: 'ended' }));
    const oldTime = new Date(Date.now() - 100000);

    await Message.create(
      makeMessage({
        sessionId: session._id,
        timestamp: oldTime,
        content: 'Old message',
      }),
    );
    await Message.create(
      makeMessage({
        sessionId: session._id,
        timestamp: new Date(),
        content: 'Recent message',
      }),
    );

    const cutoff = new Date(Date.now() - 50000);
    const deleted = await deleteOldMessages(cutoff, ['ended', 'completed']);

    expect(deleted).toBe(1);
  });

  it('returns 0 when no sessions are in terminal status', async () => {
    await Session.create(makeSession({ status: 'active' }));

    const cutoff = new Date(Date.now() - 50000);
    const deleted = await deleteOldMessages(cutoff, ['ended']);

    expect(deleted).toBe(0);
  });

  it('does not delete messages for active sessions', async () => {
    const activeSession = await Session.create(makeSession({ status: 'active' }));
    const oldTime = new Date(Date.now() - 100000);
    await Message.create(
      makeMessage({
        sessionId: activeSession._id,
        timestamp: oldTime,
      }),
    );

    const cutoff = new Date(Date.now() - 50000);
    const deleted = await deleteOldMessages(cutoff, ['ended']);

    expect(deleted).toBe(0);
    const count = await Message.countDocuments({ sessionId: activeSession._id });
    expect(count).toBe(1);
  });
});
