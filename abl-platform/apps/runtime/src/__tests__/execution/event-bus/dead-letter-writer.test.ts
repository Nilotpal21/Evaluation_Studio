/**
 * ClickHouseDeadLetterWriter Tests
 *
 * Verifies that events are written to the buffered writer with the correct
 * row shape, and that flush delegates to the buffered writer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ClickHouseDeadLetterWriter,
  DEAD_LETTER_TABLE_SQL,
} from '../../../services/event-bus/dead-letter-writer.js';
import type {
  BufferedWriter,
  DeadLetterRow,
} from '../../../services/event-bus/dead-letter-writer.js';
import type { AnyPlatformEvent } from '../../../services/event-bus/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AnyPlatformEvent> = {}): AnyPlatformEvent {
  return {
    eventId: 'evt-dead-001',
    type: 'session.created',
    tenantId: 'tenant-dead',
    projectId: 'proj-1',
    sessionId: 'sess-dead',
    agentName: 'test-agent',
    channel: 'web',
    timestamp: '2026-03-01T12:00:00.000Z',
    payload: { key: 'value' },
    ...overrides,
  };
}

function createMockWriter(): BufferedWriter<DeadLetterRow> & {
  add: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    add: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClickHouseDeadLetterWriter', () => {
  let mockWriter: ReturnType<typeof createMockWriter>;
  let dlWriter: ClickHouseDeadLetterWriter;

  beforeEach(() => {
    mockWriter = createMockWriter();
    dlWriter = new ClickHouseDeadLetterWriter(mockWriter);
  });

  it('writes event to buffered writer with correct row shape', async () => {
    const event = makeEvent();
    await dlWriter.write(event, 'Kafka unreachable', 3);

    expect(mockWriter.add).toHaveBeenCalledTimes(1);

    const row = mockWriter.add.mock.calls[0][0] as DeadLetterRow;
    expect(row.event_id).toBe('evt-dead-001');
    expect(row.event_type).toBe('session.created');
    expect(row.tenant_id).toBe('tenant-dead');
    expect(row.session_id).toBe('sess-dead');
    expect(row.error_message).toBe('Kafka unreachable');
    expect(row.retry_count).toBe(3);
    expect(row.replayed).toBe(0);
  });

  it('serializes the full event as JSON in the payload field', async () => {
    const event = makeEvent({ payload: { nested: { data: 123 } } });
    await dlWriter.write(event, 'timeout', 2);

    const row = mockWriter.add.mock.calls[0][0] as DeadLetterRow;
    const parsed = JSON.parse(row.payload);
    expect(parsed.eventId).toBe('evt-dead-001');
    expect(parsed.payload).toEqual({ nested: { data: 123 } });
  });

  it('formats failed_at as ClickHouse-compatible DateTime string', async () => {
    const event = makeEvent();
    await dlWriter.write(event, 'error', 1);

    const row = mockWriter.add.mock.calls[0][0] as DeadLetterRow;
    // Should be in "YYYY-MM-DD HH:mm:ss.SSS" format (no T, no Z)
    expect(row.failed_at).not.toContain('T');
    expect(row.failed_at).not.toContain('Z');
    expect(row.failed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('delegates flush to the buffered writer', async () => {
    await dlWriter.flush();
    expect(mockWriter.flush).toHaveBeenCalledTimes(1);
  });

  it('can write multiple events sequentially', async () => {
    const event1 = makeEvent({ eventId: 'e1' });
    const event2 = makeEvent({ eventId: 'e2', type: 'tool.called' });
    await dlWriter.write(event1, 'err1', 1);
    await dlWriter.write(event2, 'err2', 2);

    expect(mockWriter.add).toHaveBeenCalledTimes(2);
    expect((mockWriter.add.mock.calls[0][0] as DeadLetterRow).event_id).toBe('e1');
    expect((mockWriter.add.mock.calls[1][0] as DeadLetterRow).event_id).toBe('e2');
    expect((mockWriter.add.mock.calls[1][0] as DeadLetterRow).event_type).toBe('tool.called');
  });
});

// ---------------------------------------------------------------------------
// DDL constant
// ---------------------------------------------------------------------------

describe('DEAD_LETTER_TABLE_SQL', () => {
  it('contains CREATE TABLE statement', () => {
    expect(DEAD_LETTER_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS event_dead_letter');
  });

  it('includes all required columns', () => {
    expect(DEAD_LETTER_TABLE_SQL).toContain('event_id');
    expect(DEAD_LETTER_TABLE_SQL).toContain('event_type');
    expect(DEAD_LETTER_TABLE_SQL).toContain('tenant_id');
    expect(DEAD_LETTER_TABLE_SQL).toContain('session_id');
    expect(DEAD_LETTER_TABLE_SQL).toContain('payload');
    expect(DEAD_LETTER_TABLE_SQL).toContain('error_message');
    expect(DEAD_LETTER_TABLE_SQL).toContain('retry_count');
    expect(DEAD_LETTER_TABLE_SQL).toContain('failed_at');
    expect(DEAD_LETTER_TABLE_SQL).toContain('replayed');
  });

  it('uses MergeTree engine', () => {
    expect(DEAD_LETTER_TABLE_SQL).toContain('ENGINE = MergeTree()');
  });

  it('includes TTL for automatic cleanup', () => {
    expect(DEAD_LETTER_TABLE_SQL).toContain('TTL');
    expect(DEAD_LETTER_TABLE_SQL).toContain('INTERVAL 30 DAY');
  });

  it('orders by tenant_id for tenant-scoped queries', () => {
    expect(DEAD_LETTER_TABLE_SQL).toContain('ORDER BY (tenant_id');
  });
});
