import { describe, it, expect } from 'vitest';
import {
  PLATFORM_TO_TRACE_ALIASES,
  PLATFORM_TO_TRACE_TYPE,
  TRACE_TO_PLATFORM_TYPE,
} from '../schema/trace-event-mappings.js';
import { ALL_TRACE_EVENT_TYPES } from '../schema/trace-events.js';

const EXPECTED_PLATFORM_CATEGORIES = [
  'agent',
  'attachment',
  'channel',
  'flow',
  'llm',
  'message',
  'session',
  'system',
  'tool',
  'voice',
] as const;

const LEGACY_TRACE_ALIASES = ['delegate'] as const;

describe('trace event mappings', () => {
  it('covers every expected platform category', () => {
    const categories = [
      ...new Set(
        Object.values(TRACE_TO_PLATFORM_TYPE).map((platformType) => platformType.split('.')[0]),
      ),
    ].sort();

    expect(categories).toEqual([...EXPECTED_PLATFORM_CATEGORIES].sort());
  });

  it('contains only canonical trace event types plus documented legacy aliases', () => {
    const knownTraceTypes = new Set([...ALL_TRACE_EVENT_TYPES, ...LEGACY_TRACE_ALIASES]);
    const unknownTraceTypes = Object.keys(TRACE_TO_PLATFORM_TYPE).filter(
      (traceType) => !knownTraceTypes.has(traceType),
    );

    expect(unknownTraceTypes).toEqual([]);
  });

  it('does not create orphaned reverse-map entries', () => {
    const uniquePlatformTypes = [...new Set(Object.values(TRACE_TO_PLATFORM_TYPE))].sort();
    const aliasPlatformTypes = Object.keys(PLATFORM_TO_TRACE_ALIASES).sort();

    expect(Object.keys(PLATFORM_TO_TRACE_TYPE).sort()).toEqual(
      [...new Set([...uniquePlatformTypes, ...aliasPlatformTypes])].sort(),
    );

    for (const [platformType, traceType] of Object.entries(PLATFORM_TO_TRACE_TYPE)) {
      if (platformType in PLATFORM_TO_TRACE_ALIASES) {
        expect(PLATFORM_TO_TRACE_ALIASES[platformType]).toBe(traceType);
        continue;
      }
      expect(TRACE_TO_PLATFORM_TYPE[traceType]).toBe(platformType);
    }
  });

  it('documents the last-writer-wins delegation alias collision', () => {
    expect(TRACE_TO_PLATFORM_TYPE.delegate).toBe('agent.delegated');
    expect(TRACE_TO_PLATFORM_TYPE.delegate_start).toBe('agent.delegated');
    expect(PLATFORM_TO_TRACE_TYPE['agent.delegated']).toBe('delegate_start');
  });

  it('round-trips all non-aliased mappings', () => {
    const platformTypeCounts = Object.values(TRACE_TO_PLATFORM_TYPE).reduce<Record<string, number>>(
      (counts, platformType) => {
        counts[platformType] = (counts[platformType] ?? 0) + 1;
        return counts;
      },
      {},
    );

    for (const [traceType, platformType] of Object.entries(TRACE_TO_PLATFORM_TYPE)) {
      if (platformTypeCounts[platformType] === 1) {
        expect(PLATFORM_TO_TRACE_TYPE[platformType]).toBe(traceType);
      }
    }
  });

  it('normalizes dotted failure/retry aliases onto canonical trace types', () => {
    expect(TRACE_TO_PLATFORM_TYPE.tool_call_retry).toBe('tool.call.retried');
    expect(PLATFORM_TO_TRACE_TYPE['llm.call.failed']).toBe('llm_call');
    expect(PLATFORM_TO_TRACE_TYPE['tool.call.failed']).toBe('tool_call');
    expect(PLATFORM_TO_TRACE_TYPE['tool.call.retried']).toBe('tool_call_retry');
  });
});
