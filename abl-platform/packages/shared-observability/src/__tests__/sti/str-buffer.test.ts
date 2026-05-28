import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STRBuffer,
  MAX_ENTRIES_PER_TRACE,
  TRACE_TTL_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RESET_MS,
} from '../../sti/str-buffer.js';

describe('STRBuffer', () => {
  let buffer: STRBuffer;

  beforeEach(() => {
    buffer = new STRBuffer();
  });

  afterEach(() => {
    buffer.destroy();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Basic recording and flushing
  // -----------------------------------------------------------------------

  it('records an entry and flushes it', () => {
    const handle = buffer.recordEntry('trace-1', 'llm/chat/invoke', 1);
    handle.markSuccess();
    handle.recordDuration(500);

    const entries = buffer.flush('trace-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'llm/chat/invoke',
      durationUs: 500,
      outcome: 'success',
      depth: 1,
    });
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it('returns empty array when flushing unknown trace', () => {
    expect(buffer.flush('nonexistent')).toEqual([]);
  });

  it('removes trace from buffer after flush', () => {
    buffer.recordEntry('trace-1', 'a');
    buffer.flush('trace-1');
    expect(buffer.size).toBe(0);
    expect(buffer.flush('trace-1')).toEqual([]);
  });

  it('defaults depth to 0', () => {
    buffer.recordEntry('trace-1', 'a');
    const entries = buffer.flush('trace-1');
    expect(entries[0].depth).toBe(0);
  });

  it('defaults outcome to pending', () => {
    buffer.recordEntry('trace-1', 'a');
    const entries = buffer.flush('trace-1');
    expect(entries[0].outcome).toBe('pending');
  });

  it('marks error correctly', () => {
    const handle = buffer.recordEntry('trace-1', 'a');
    handle.markError();
    const entries = buffer.flush('trace-1');
    expect(entries[0].outcome).toBe('error');
  });

  // -----------------------------------------------------------------------
  // Multiple traces
  // -----------------------------------------------------------------------

  it('tracks multiple traces independently', () => {
    buffer.recordEntry('t1', 'a');
    buffer.recordEntry('t2', 'b');
    buffer.recordEntry('t1', 'c');

    expect(buffer.size).toBe(2);
    expect(buffer.flush('t1')).toHaveLength(2);
    expect(buffer.flush('t2')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Ring buffer eviction (per-trace cap)
  // -----------------------------------------------------------------------

  it('drops oldest entries when per-trace cap is exceeded', () => {
    for (let i = 0; i < MAX_ENTRIES_PER_TRACE + 100; i++) {
      buffer.recordEntry('trace-1', `path-${i}`);
    }
    const entries = buffer.flush('trace-1');
    expect(entries).toHaveLength(MAX_ENTRIES_PER_TRACE);
    // Oldest should have been dropped
    expect(entries[0].path).toBe('path-100');
    expect(entries[entries.length - 1].path).toBe(`path-${MAX_ENTRIES_PER_TRACE + 99}`);
  });

  // -----------------------------------------------------------------------
  // TTL eviction
  // -----------------------------------------------------------------------

  it('evicts stale traces on access', () => {
    buffer.recordEntry('old-trace', 'a');

    // Advance time past TTL
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TRACE_TTL_MS + 1);

    // New record triggers eviction
    buffer.recordEntry('new-trace', 'b');

    expect(buffer.flush('old-trace')).toEqual([]);
    expect(buffer.flush('new-trace')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------

  it('circuit is closed by default', () => {
    expect(buffer.isCircuitOpen()).toBe(false);
  });

  it('opens circuit after threshold consecutive failures', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }
    expect(buffer.isCircuitOpen()).toBe(true);
  });

  it('rejects writes when circuit is open', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }
    const handle = buffer.recordEntry('trace-1', 'a');
    // Should be a no-op handle
    handle.markSuccess(); // Should not throw
    expect(buffer.flush('trace-1')).toEqual([]);
  });

  it('resets circuit after timeout', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }
    expect(buffer.isCircuitOpen()).toBe(true);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CIRCUIT_RESET_MS + 1);
    expect(buffer.isCircuitOpen()).toBe(false);
  });

  it('resets failure counter on flush success', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      buffer.reportFlushFailure();
    }
    buffer.reportFlushSuccess();
    buffer.reportFlushFailure(); // Should be 1, not threshold
    expect(buffer.isCircuitOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  it('clears all state on destroy', () => {
    buffer.recordEntry('t1', 'a');
    buffer.recordEntry('t2', 'b');
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      buffer.reportFlushFailure();
    }

    buffer.destroy();

    expect(buffer.size).toBe(0);
    expect(buffer.isCircuitOpen()).toBe(false);
    expect(buffer.flush('t1')).toEqual([]);
  });
});
