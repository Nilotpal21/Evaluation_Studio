/**
 * INT-6: PII detect latency telemetry on production entry points.
 *
 * Asserts that `recordPIIDetectLatency` and `recordPIIDetectDegraded`
 * emit the canonical TraceStore events with the documented dimensions.
 * Uses a constructor-injected `TraceStoreInterface` test double — no
 * module mocks, in line with CLAUDE.md test architecture.
 *
 * Real production callers wrap detection at three live entry points:
 *   - nlu_guard       (compiler `pii-guard.ts` via the onDetectLatency callback)
 *   - vault_tokenize  (runtime `pii-llm-redaction.ts`)
 *   - output_filter   (runtime `output-pii-filter.ts`)
 * The streaming-chunk entry point is intentionally not wired (HLD §4
 * Concern 8) — `StreamingPIIBuffer.processChunk` has no production
 * caller yet.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  recordPIIDetectLatency,
  recordPIIDetectDegraded,
  type PIIEntryPoint,
} from '../../observability/pii-telemetry.js';
import type { TraceStoreInterface, TraceEvent } from '../../services/trace-store.js';

function createCapturingTraceStore(): TraceStoreInterface & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const stub: Partial<TraceStoreInterface> = {
    addEvent: vi.fn(async (_sessionId: string, ev: TraceEvent) => {
      events.push(ev);
    }),
  };
  return Object.assign(stub as TraceStoreInterface, { events });
}

describe('INT-6: pii.detect.latency_ms emission', () => {
  test('emits one event with full dimensions', () => {
    const trace = createCapturingTraceStore();
    recordPIIDetectLatency(trace, 'session-A', {
      entry_point: 'output_filter',
      tier: 'standard',
      pack: 'eu',
      recognizer: 'eu-iban',
      ms: 12.34,
    });
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].type).toBe('pii.detect.latency_ms');
    expect(trace.events[0].sessionId).toBe('session-A');
    expect(trace.events[0].data).toMatchObject({
      entry_point: 'output_filter',
      tier: 'standard',
      pack: 'eu',
      recognizer: 'eu-iban',
      ms: 12.34,
    });
  });

  test('every production entry point label is accepted', () => {
    const trace = createCapturingTraceStore();
    const entryPoints: PIIEntryPoint[] = [
      'nlu_guard',
      'vault_tokenize',
      'output_filter',
      'streaming_chunk',
    ];
    for (const ep of entryPoints) {
      recordPIIDetectLatency(trace, 'session', { entry_point: ep, tier: 'basic', ms: 1 });
    }
    expect(trace.events).toHaveLength(4);
    expect(trace.events.map((e) => e.data.entry_point)).toEqual(entryPoints);
  });

  test('unique event id per emission', () => {
    const trace = createCapturingTraceStore();
    recordPIIDetectLatency(trace, 's', { entry_point: 'nlu_guard', tier: 'basic', ms: 1 });
    recordPIIDetectLatency(trace, 's', { entry_point: 'nlu_guard', tier: 'basic', ms: 2 });
    expect(trace.events[0].id).not.toBe(trace.events[1].id);
  });
});

describe('INT-6: pii.detect.degraded emission', () => {
  test.each([
    ['async_budget_exceeded', 'eu-iban'],
    ['recognizer_threw', 'eu-iban'],
    ['unknown_pack', 'totally-fake'],
    ['unsupported_tier', undefined],
  ] as const)('reason=%s emits with documented dimensions', (reason, recognizer) => {
    const trace = createCapturingTraceStore();
    recordPIIDetectDegraded(trace, 'session-A', {
      entry_point: 'nlu_guard',
      reason,
      ...(recognizer ? { recognizer } : {}),
    });
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].type).toBe('pii.detect.degraded');
    expect(trace.events[0].data).toMatchObject({
      entry_point: 'nlu_guard',
      reason,
    });
    if (recognizer) {
      expect(trace.events[0].data).toMatchObject({ recognizer });
    }
  });
});
