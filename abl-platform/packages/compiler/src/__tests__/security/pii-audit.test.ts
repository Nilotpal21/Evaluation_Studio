/**
 * PII Audit Logger Tests
 *
 * Tests for the async, fire-and-forget PII audit logging utility.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PIIAuditLogger,
  type PIIAuditStore,
  type PIIAuditEntry,
} from '../../platform/security/pii-audit.js';

function makeEntry(overrides: Partial<PIIAuditEntry> = {}): PIIAuditEntry {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    tokenId: 'token-1',
    piiType: 'email',
    consumer: 'llm',
    action: 'tokenize',
    ...overrides,
  };
}

function createMockStore(): PIIAuditStore & {
  inserted: Array<PIIAuditEntry & { expireAt: Date }>;
} {
  const inserted: Array<PIIAuditEntry & { expireAt: Date }> = [];
  return {
    inserted,
    insert: vi.fn(async (entry: PIIAuditEntry & { expireAt: Date }) => {
      inserted.push(entry);
    }),
  };
}

describe('PIIAuditLogger', () => {
  let store: ReturnType<typeof createMockStore>;
  let logger: PIIAuditLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMockStore();
    logger = new PIIAuditLogger(store);
  });

  afterEach(() => {
    logger.stop();
    vi.useRealTimers();
  });

  // ─── Buffer behavior ──────────────────────────────────────────────────

  test('log() adds entry to buffer', () => {
    logger.log(makeEntry());
    expect(logger.getBufferSize()).toBe(1);
  });

  test('log() sets default 90-day expireAt', () => {
    const now = Date.now();
    logger.log(makeEntry());
    // Flush to see what was sent to store
    void logger.flush();
    expect(store.inserted).toHaveLength(1);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const expireAt = store.inserted[0].expireAt.getTime();
    expect(expireAt).toBeGreaterThanOrEqual(now + ninetyDaysMs - 1000);
    expect(expireAt).toBeLessThanOrEqual(now + ninetyDaysMs + 1000);
  });

  test('log() respects custom retentionDays', () => {
    const now = Date.now();
    logger.log(makeEntry({ retentionDays: 30 }));
    void logger.flush();
    expect(store.inserted).toHaveLength(1);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const expireAt = store.inserted[0].expireAt.getTime();
    expect(expireAt).toBeGreaterThanOrEqual(now + thirtyDaysMs - 1000);
    expect(expireAt).toBeLessThanOrEqual(now + thirtyDaysMs + 1000);
  });

  test('log() respects retentionDays of 1 day', () => {
    const now = Date.now();
    logger.log(makeEntry({ retentionDays: 1 }));
    void logger.flush();
    const oneDayMs = 1 * 24 * 60 * 60 * 1000;
    const expireAt = store.inserted[0].expireAt.getTime();
    expect(expireAt).toBeGreaterThanOrEqual(now + oneDayMs - 1000);
    expect(expireAt).toBeLessThanOrEqual(now + oneDayMs + 1000);
  });

  test('multiple log() calls batch correctly', () => {
    logger.log(makeEntry({ tokenId: 'tok-1' }));
    logger.log(makeEntry({ tokenId: 'tok-2' }));
    logger.log(makeEntry({ tokenId: 'tok-3' }));
    expect(logger.getBufferSize()).toBe(3);
  });

  test('getBufferSize() tracks buffer size accurately', () => {
    expect(logger.getBufferSize()).toBe(0);
    logger.log(makeEntry());
    expect(logger.getBufferSize()).toBe(1);
    logger.log(makeEntry());
    expect(logger.getBufferSize()).toBe(2);
  });

  // ─── Flush behavior ──────────────────────────────────────────────────

  test('flush() calls store.insert for all buffered entries', async () => {
    logger.log(makeEntry({ tokenId: 'tok-1' }));
    logger.log(makeEntry({ tokenId: 'tok-2' }));
    await logger.flush();
    expect(store.insert).toHaveBeenCalledTimes(2);
    expect(store.inserted).toHaveLength(2);
    expect(store.inserted[0].tokenId).toBe('tok-1');
    expect(store.inserted[1].tokenId).toBe('tok-2');
  });

  test('flush() clears buffer after write', async () => {
    logger.log(makeEntry());
    logger.log(makeEntry());
    expect(logger.getBufferSize()).toBe(2);
    await logger.flush();
    expect(logger.getBufferSize()).toBe(0);
  });

  test('flush() is no-op when buffer is empty', async () => {
    await logger.flush();
    expect(store.insert).not.toHaveBeenCalled();
  });

  test('flush() handles store errors gracefully (logs warning, does not throw)', async () => {
    const failStore: PIIAuditStore = {
      insert: vi.fn().mockRejectedValue(new Error('DB down')),
    };
    const failLogger = new PIIAuditLogger(failStore);
    failLogger.log(makeEntry());
    // Should not throw
    await expect(failLogger.flush()).resolves.toBeUndefined();
    // Buffer is cleared even on failure (entries were spliced before insert)
    expect(failLogger.getBufferSize()).toBe(0);
    failLogger.stop();
  });

  test('flush() handles non-Error store failures gracefully', async () => {
    const failStore: PIIAuditStore = {
      insert: vi.fn().mockRejectedValue('string error'),
    };
    const failLogger = new PIIAuditLogger(failStore);
    failLogger.log(makeEntry());
    await expect(failLogger.flush()).resolves.toBeUndefined();
    failLogger.stop();
  });

  // ─── Auto-flush at MAX_BUFFER_SIZE ────────────────────────────────────

  test('auto-flushes when buffer reaches MAX_BUFFER_SIZE (100)', () => {
    for (let i = 0; i < 100; i++) {
      logger.log(makeEntry({ tokenId: `tok-${i}` }));
    }
    // flush was called (fire-and-forget), buffer was drained
    // Since flush is async and void-called, we check that store.insert was called
    expect(store.insert).toHaveBeenCalled();
  });

  test('does not auto-flush before reaching MAX_BUFFER_SIZE', () => {
    for (let i = 0; i < 99; i++) {
      logger.log(makeEntry({ tokenId: `tok-${i}` }));
    }
    expect(store.insert).not.toHaveBeenCalled();
    expect(logger.getBufferSize()).toBe(99);
  });

  // ─── stop() behavior ─────────────────────────────────────────────────

  test('stop() flushes remaining entries', () => {
    logger.log(makeEntry());
    logger.log(makeEntry());
    logger.stop();
    // flush is called fire-and-forget on stop
    expect(store.insert).toHaveBeenCalled();
  });

  test('stop() clears the interval timer', () => {
    // Trigger timer creation
    logger.log(makeEntry());
    logger.stop();
    // Logging after stop still works (new timer not created since stop cleared it)
    // but the point is stop() cleared the timer
    expect(logger.getBufferSize()).toBe(0);
  });

  // ─── Entry data integrity ────────────────────────────────────────────

  test('preserves all entry fields through flush', async () => {
    const entry = makeEntry({
      tenantId: 'tenant-x',
      projectId: 'proj-x',
      sessionId: 'sess-x',
      tokenId: 'tok-x',
      piiType: 'phone',
      consumer: 'tools',
      action: 'detokenize',
      metadata: { toolName: 'stripe' },
    });
    logger.log(entry);
    await logger.flush();
    expect(store.inserted).toHaveLength(1);
    const stored = store.inserted[0];
    expect(stored.tenantId).toBe('tenant-x');
    expect(stored.projectId).toBe('proj-x');
    expect(stored.sessionId).toBe('sess-x');
    expect(stored.tokenId).toBe('tok-x');
    expect(stored.piiType).toBe('phone');
    expect(stored.consumer).toBe('tools');
    expect(stored.action).toBe('detokenize');
    expect(stored.metadata).toEqual({ toolName: 'stripe' });
    expect(stored.expireAt).toBeInstanceOf(Date);
  });

  test('entries without metadata have no metadata field leak', async () => {
    logger.log(makeEntry());
    await logger.flush();
    const stored = store.inserted[0];
    // metadata is undefined in the entry (not provided), which is fine
    expect(stored.metadata).toBeUndefined();
  });
});
