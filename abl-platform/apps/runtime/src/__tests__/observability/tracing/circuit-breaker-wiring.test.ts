import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STRBuffer,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RESET_MS,
  type STREntry,
  type RowWriter,
  STRWriter,
  type FlushContext,
} from '@agent-platform/shared-observability/sti';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRowWriter(opts?: { throwOnInsert?: boolean }): RowWriter & {
  insertedRows: unknown[];
} {
  const insertedRows: unknown[] = [];
  return {
    insertedRows,
    insert(row: unknown) {
      if (opts?.throwOnInsert) {
        throw new Error('ClickHouse write failed');
      }
      insertedRows.push(row);
    },
  };
}

function makeEntry(path = 'agent.llm.call', depth = 0): STREntry {
  return {
    path,
    timestamp: Date.now(),
    durationUs: 1000,
    outcome: 'success',
    depth,
  };
}

const FLUSH_CTX: FlushContext = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  traceId: 'trace-abc',
  sessionId: 'sess-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Circuit breaker feedback loop (STRBuffer ↔ STRWriter)', () => {
  let buffer: STRBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new STRBuffer();
  });

  afterEach(() => {
    buffer.destroy();
    vi.useRealTimers();
  });

  // ─── Success callback wiring ────────────────────────────────────────────

  it('successful flush calls buffer.reportFlushSuccess()', () => {
    const rowWriter = createMockRowWriter();
    const writer = new STRWriter(rowWriter);
    const successSpy = vi.spyOn(buffer, 'reportFlushSuccess');

    const entries = [makeEntry()];
    writer.flush(entries, FLUSH_CTX, {
      onSuccess: () => buffer.reportFlushSuccess(),
      onFailure: () => buffer.reportFlushFailure(),
    });

    expect(successSpy).toHaveBeenCalledOnce();
  });

  // ─── Failure callback wiring ────────────────────────────────────────────

  it('failed flush (writer.insert throws) calls buffer.reportFlushFailure()', () => {
    const rowWriter = createMockRowWriter({ throwOnInsert: true });
    const writer = new STRWriter(rowWriter);
    const failureSpy = vi.spyOn(buffer, 'reportFlushFailure');

    const entries = [makeEntry()];
    writer.flush(entries, FLUSH_CTX, {
      onSuccess: () => buffer.reportFlushSuccess(),
      onFailure: () => buffer.reportFlushFailure(),
    });

    expect(failureSpy).toHaveBeenCalledOnce();
  });

  // ─── Circuit opens after threshold failures ─────────────────────────────

  it(`after ${CIRCUIT_FAILURE_THRESHOLD} consecutive failures, circuit opens and recordEntry returns noop handles`, () => {
    const rowWriter = createMockRowWriter({ throwOnInsert: true });
    const writer = new STRWriter(rowWriter);

    // Trigger CIRCUIT_FAILURE_THRESHOLD consecutive failures
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      writer.flush([makeEntry()], FLUSH_CTX, {
        onSuccess: () => buffer.reportFlushSuccess(),
        onFailure: () => buffer.reportFlushFailure(),
      });
    }

    expect(buffer.isCircuitOpen()).toBe(true);

    // recordEntry should return noop handles — entry should NOT be stored
    const handle = buffer.recordEntry('trace-open', 'agent.test');
    handle.markSuccess(); // noop — should not throw
    handle.markError(); // noop — should not throw
    handle.recordDuration(500); // noop — should not throw

    // Buffer should have nothing for this trace since circuit is open
    const flushed = buffer.flush('trace-open');
    expect(flushed).toHaveLength(0);
  });

  // ─── Circuit closes after cooldown ──────────────────────────────────────

  it('after 30s cooldown, circuit closes and entries are accepted again', () => {
    // Open the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }
    expect(buffer.isCircuitOpen()).toBe(true);

    // Advance time past CIRCUIT_RESET_MS
    vi.advanceTimersByTime(CIRCUIT_RESET_MS + 1);

    expect(buffer.isCircuitOpen()).toBe(false);

    // Entries should be accepted again
    const handle = buffer.recordEntry('trace-after-cooldown', 'agent.test');
    handle.markSuccess();

    const flushed = buffer.flush('trace-after-cooldown');
    expect(flushed).toHaveLength(1);
    expect(flushed[0].outcome).toBe('success');
  });

  // ─── Success resets failure counter ─────────────────────────────────────

  it('a success after some failures resets the consecutive failure counter', () => {
    const failingRowWriter = createMockRowWriter({ throwOnInsert: true });
    const failingWriter = new STRWriter(failingRowWriter);

    // Accumulate failures just below threshold
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      failingWriter.flush([makeEntry()], FLUSH_CTX, {
        onSuccess: () => buffer.reportFlushSuccess(),
        onFailure: () => buffer.reportFlushFailure(),
      });
    }

    // One success resets the counter
    const succeedingRowWriter = createMockRowWriter();
    const succeedingWriter = new STRWriter(succeedingRowWriter);
    succeedingWriter.flush([makeEntry()], FLUSH_CTX, {
      onSuccess: () => buffer.reportFlushSuccess(),
      onFailure: () => buffer.reportFlushFailure(),
    });

    // Now CIRCUIT_FAILURE_THRESHOLD - 1 more failures should NOT open the circuit
    // (because the counter was reset)
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      failingWriter.flush([makeEntry()], FLUSH_CTX, {
        onSuccess: () => buffer.reportFlushSuccess(),
        onFailure: () => buffer.reportFlushFailure(),
      });
    }

    expect(buffer.isCircuitOpen()).toBe(false);

    // Entries are still accepted
    buffer.recordEntry('trace-still-open', 'agent.test');
    const flushed = buffer.flush('trace-still-open');
    expect(flushed).toHaveLength(1);
  });

  // ─── End-to-end flow ────────────────────────────────────────────────────

  it('end-to-end: buffer → writer flush → circuit breaker state transitions', () => {
    const rowWriter = createMockRowWriter();
    const writer = new STRWriter(rowWriter);

    // 1. Record entries into buffer
    const handle1 = buffer.recordEntry('trace-e2e', 'agent.llm.call', 1);
    handle1.markSuccess();
    handle1.recordDuration(5000);

    const handle2 = buffer.recordEntry('trace-e2e', 'agent.tool.execute', 2);
    handle2.markError();
    handle2.recordDuration(3000);

    // 2. Flush buffer and feed to writer (mimics channel-trace-utils wiring)
    const entries = buffer.flush('trace-e2e');
    expect(entries).toHaveLength(2);

    writer.flush(entries, FLUSH_CTX, {
      onSuccess: () => buffer.reportFlushSuccess(),
      onFailure: () => buffer.reportFlushFailure(),
    });

    // 3. Verify rows were written
    expect(rowWriter.insertedRows).toHaveLength(2);
    expect(buffer.isCircuitOpen()).toBe(false);

    // 4. Now simulate repeated failures to open circuit
    const failingRowWriter = createMockRowWriter({ throwOnInsert: true });
    const failingWriter = new STRWriter(failingRowWriter);

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      failingWriter.flush([makeEntry()], FLUSH_CTX, {
        onSuccess: () => buffer.reportFlushSuccess(),
        onFailure: () => buffer.reportFlushFailure(),
      });
    }

    expect(buffer.isCircuitOpen()).toBe(true);

    // 5. Recording while circuit is open returns noop
    const noopHandle = buffer.recordEntry('trace-e2e-blocked', 'agent.blocked');
    noopHandle.markSuccess(); // no-op
    expect(buffer.flush('trace-e2e-blocked')).toHaveLength(0);

    // 6. After cooldown, circuit closes
    vi.advanceTimersByTime(CIRCUIT_RESET_MS + 1);
    expect(buffer.isCircuitOpen()).toBe(false);

    // 7. New entries accepted after reset
    const handle3 = buffer.recordEntry('trace-e2e-recovered', 'agent.recovered');
    handle3.markSuccess();
    const recovered = buffer.flush('trace-e2e-recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].path).toBe('agent.recovered');
  });

  // ─── Circuit resets failure counter on cooldown expiry ───────────────────

  it('circuit cooldown resets consecutive failure counter to zero', () => {
    // Open the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }
    expect(buffer.isCircuitOpen()).toBe(true);

    // Advance past cooldown
    vi.advanceTimersByTime(CIRCUIT_RESET_MS + 1);

    // Circuit is now closed (half-open → reset)
    expect(buffer.isCircuitOpen()).toBe(false);

    // Failure counter was also reset, so it takes a full CIRCUIT_FAILURE_THRESHOLD
    // failures to reopen the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      buffer.reportFlushFailure();
    }
    expect(buffer.isCircuitOpen()).toBe(false);

    // One more failure opens it again
    buffer.reportFlushFailure();
    expect(buffer.isCircuitOpen()).toBe(true);
  });
});
