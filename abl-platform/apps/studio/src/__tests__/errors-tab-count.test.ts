/**
 * ErrorsTab — useErrorCount logic tests
 *
 * Verifies the error/warning counting logic that drives the ErrorsTab badge.
 * Tests the counting algorithm directly (same logic as useErrorCount in ErrorsTab.tsx)
 * to avoid happy-dom fork hangs from lucide-react icon imports.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ExtendedTraceEvent } from '../types';
import { getBannerEligibleConfigurationDiagnostic } from '../utils/configuration-trace-events';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extracted counting logic — mirrors useErrorCount in ErrorsTab.tsx exactly.
 * If the component logic changes, this must be updated to match.
 */
function countErrors(events: ExtendedTraceEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (getBannerEligibleConfigurationDiagnostic(event)) {
      count++;
    } else if (event.type === 'error' || event.type === 'warning') {
      count++;
    } else if (event.metadata?.severity === 'error' || event.metadata?.severity === 'warn') {
      count++;
    } else if (event.type === 'constraint_check' && event.data.passed === false) {
      count++;
    }
  }
  return count;
}

let eventId = 0;

function makeEvent(overrides: Partial<ExtendedTraceEvent>): ExtendedTraceEvent {
  eventId++;
  return {
    id: `evt-${eventId}`,
    type: 'flow_step_enter',
    timestamp: new Date(),
    traceId: 'trace-1',
    spanId: `span-${eventId}`,
    sessionId: 'sess-1',
    agentName: 'test-agent',
    data: {},
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ErrorsTab countErrors logic', () => {
  beforeEach(() => {
    eventId = 0;
  });

  it('returns 0 when there are no events', () => {
    expect(countErrors([])).toBe(0);
  });

  it('counts error events', () => {
    const events = [makeEvent({ type: 'error', data: { message: 'Something broke' } })];
    expect(countErrors(events)).toBe(1);
  });

  it('counts warning events', () => {
    const events = [makeEvent({ type: 'warning', data: { message: 'Watch out' } })];
    expect(countErrors(events)).toBe(1);
  });

  it('counts constraint_check with passed=false', () => {
    const events = [
      makeEvent({
        type: 'constraint_check',
        data: { passed: false, constraint: 'min_age' },
      }),
    ];
    expect(countErrors(events)).toBe(1);
  });

  it('does not count constraint_check with passed=true', () => {
    const events = [
      makeEvent({
        type: 'constraint_check',
        data: { passed: true, constraint: 'min_age' },
      }),
    ];
    expect(countErrors(events)).toBe(0);
  });

  it('counts events with metadata severity error', () => {
    const events = [
      makeEvent({
        type: 'tool_call',
        metadata: { severity: 'error' },
        data: { message: 'tool failed' },
      }),
    ];
    expect(countErrors(events)).toBe(1);
  });

  it('counts events with metadata severity warn', () => {
    const events = [
      makeEvent({
        type: 'llm_call',
        metadata: { severity: 'warn' },
        data: { message: 'slow call' },
      }),
    ];
    expect(countErrors(events)).toBe(1);
  });

  it('counts banner-eligible configuration diagnostics carried on non-error trace events', () => {
    const events = [
      makeEvent({
        type: 'agent_error_handled',
        data: {
          diagnostic: {
            category: 'llm',
            severity: 'error',
            code: 'LLM_CREDENTIAL_MISSING',
            message: 'Missing provider credential',
            bannerEligible: true,
          },
        },
      }),
    ];
    expect(countErrors(events)).toBe(1);
  });

  it('does not count non-error events like step_enter', () => {
    const events = [
      makeEvent({ type: 'flow_step_enter', data: {} }),
      makeEvent({ type: 'llm_call', data: {} }),
      makeEvent({ type: 'tool_call', data: {} }),
    ];
    expect(countErrors(events)).toBe(0);
  });

  it('does not count events with metadata severity info or debug', () => {
    const events = [
      makeEvent({ type: 'tool_call', metadata: { severity: 'info' }, data: {} }),
      makeEvent({ type: 'llm_call', metadata: { severity: 'debug' }, data: {} }),
    ];
    expect(countErrors(events)).toBe(0);
  });

  it('correctly counts mixed events', () => {
    const events = [
      makeEvent({ type: 'error', data: { message: 'err1' } }),
      makeEvent({ type: 'error', data: { message: 'err2' } }),
      makeEvent({ type: 'warning', data: { message: 'warn1' } }),
      makeEvent({ type: 'flow_step_enter', data: {} }),
      makeEvent({
        type: 'constraint_check',
        data: { passed: false, constraint: 'c1' },
      }),
      makeEvent({
        type: 'constraint_check',
        data: { passed: true, constraint: 'c2' },
      }),
      makeEvent({
        type: 'tool_call',
        metadata: { severity: 'error' },
        data: {},
      }),
      makeEvent({ type: 'llm_call', data: {} }),
    ];

    // 2 errors + 1 warning + 1 failed constraint + 1 metadata error = 5
    expect(countErrors(events)).toBe(5);
  });

  it('does not double-count error events that also have error metadata', () => {
    // An 'error' type event is counted on the first branch; metadata check is skipped
    const events = [
      makeEvent({
        type: 'error',
        metadata: { severity: 'error' },
        data: { message: 'err' },
      }),
    ];
    expect(countErrors(events)).toBe(1);
  });
});
