/**
 * Decision Event Emission Tests
 *
 * Tests the verbosity-aware decision event system:
 * - shouldEmitDecision: gates decisions by kind + verbosity level
 * - DECISION_KIND_VERBOSITY: maps 11 decision kinds to verbosity tiers
 * - emitDecisionEvent: callback helper that respects gating
 */

import { describe, test, expect, vi } from 'vitest';
import {
  shouldEmitDecision,
  DECISION_KIND_VERBOSITY,
  VERBOSITY_LEVELS,
  emitDecisionEvent,
  type DecisionKind,
  type TraceVerbosity,
} from '../services/execution/trace-helpers.js';

// =============================================================================
// shouldEmitDecision
// =============================================================================

describe('shouldEmitDecision', () => {
  test('standard verbosity emits standard-tier decisions', () => {
    expect(shouldEmitDecision('handoff', 'standard')).toBe(true);
    expect(shouldEmitDecision('delegation', 'standard')).toBe(true);
    expect(shouldEmitDecision('flow_transition', 'standard')).toBe(true);
    expect(shouldEmitDecision('field_validation', 'standard')).toBe(true);
    expect(shouldEmitDecision('escalation', 'standard')).toBe(true);
    expect(shouldEmitDecision('completion', 'standard')).toBe(true);
    expect(shouldEmitDecision('constraint_check', 'standard')).toBe(true);
    expect(shouldEmitDecision('guardrail_check', 'standard')).toBe(true);
  });

  test('standard verbosity does NOT emit verbose-tier decisions', () => {
    expect(shouldEmitDecision('gather_extraction', 'standard')).toBe(false);
    expect(shouldEmitDecision('correction', 'standard')).toBe(false);
    expect(shouldEmitDecision('data_mutation', 'standard')).toBe(false);
  });

  test('verbose verbosity emits all decisions', () => {
    expect(shouldEmitDecision('gather_extraction', 'verbose')).toBe(true);
    expect(shouldEmitDecision('correction', 'verbose')).toBe(true);
    expect(shouldEmitDecision('data_mutation', 'verbose')).toBe(true);
    expect(shouldEmitDecision('handoff', 'verbose')).toBe(true);
  });

  test('minimal verbosity emits nothing', () => {
    expect(shouldEmitDecision('handoff', 'minimal')).toBe(false);
    expect(shouldEmitDecision('gather_extraction', 'minimal')).toBe(false);
  });

  test('debug verbosity emits everything', () => {
    expect(shouldEmitDecision('handoff', 'debug')).toBe(true);
    expect(shouldEmitDecision('data_mutation', 'debug')).toBe(true);
  });

  test('unknown kind defaults to standard level (emitted at standard+)', () => {
    // Unknown kinds fall through to ?? 1 (standard level)
    const unknownKind = 'unknown_kind' as DecisionKind;
    expect(shouldEmitDecision(unknownKind, 'standard')).toBe(true);
    expect(shouldEmitDecision(unknownKind, 'verbose')).toBe(true);
    expect(shouldEmitDecision(unknownKind, 'minimal')).toBe(false);
  });

  test('defaults to standard when no verbosity specified', () => {
    expect(shouldEmitDecision('handoff')).toBe(true);
    expect(shouldEmitDecision('gather_extraction')).toBe(false);
  });
});

// =============================================================================
// DECISION_KIND_VERBOSITY
// =============================================================================

describe('DECISION_KIND_VERBOSITY', () => {
  test('covers all 12 decision kinds', () => {
    const kinds = Object.keys(DECISION_KIND_VERBOSITY);
    expect(kinds).toHaveLength(12);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'field_validation',
        'gather_extraction',
        'flow_transition',
        'correction',
        'data_mutation',
        'handoff',
        'delegation',
        'constraint_check',
        'escalation',
        'guardrail_check',
        'completion',
        'await_attachment',
      ]),
    );
  });

  test('8 kinds at standard level, 4 at verbose', () => {
    const standard = Object.entries(DECISION_KIND_VERBOSITY).filter(
      ([, v]) => v === VERBOSITY_LEVELS.standard,
    );
    const verbose = Object.entries(DECISION_KIND_VERBOSITY).filter(
      ([, v]) => v === VERBOSITY_LEVELS.verbose,
    );
    expect(standard).toHaveLength(8);
    expect(verbose).toHaveLength(4);
  });

  test('standard kinds are the expected set', () => {
    const standardKinds = Object.entries(DECISION_KIND_VERBOSITY)
      .filter(([, v]) => v === VERBOSITY_LEVELS.standard)
      .map(([k]) => k)
      .sort();
    expect(standardKinds).toEqual([
      'completion',
      'constraint_check',
      'delegation',
      'escalation',
      'field_validation',
      'flow_transition',
      'guardrail_check',
      'handoff',
    ]);
  });

  test('verbose kinds are the expected set', () => {
    const verboseKinds = Object.entries(DECISION_KIND_VERBOSITY)
      .filter(([, v]) => v === VERBOSITY_LEVELS.verbose)
      .map(([k]) => k)
      .sort();
    expect(verboseKinds).toEqual([
      'await_attachment',
      'correction',
      'data_mutation',
      'gather_extraction',
    ]);
  });
});

// =============================================================================
// VERBOSITY_LEVELS
// =============================================================================

describe('VERBOSITY_LEVELS', () => {
  test('has 4 levels in ascending order', () => {
    expect(VERBOSITY_LEVELS.minimal).toBe(0);
    expect(VERBOSITY_LEVELS.standard).toBe(1);
    expect(VERBOSITY_LEVELS.verbose).toBe(2);
    expect(VERBOSITY_LEVELS.debug).toBe(3);
  });

  test('levels are strictly ordered', () => {
    expect(VERBOSITY_LEVELS.minimal).toBeLessThan(VERBOSITY_LEVELS.standard);
    expect(VERBOSITY_LEVELS.standard).toBeLessThan(VERBOSITY_LEVELS.verbose);
    expect(VERBOSITY_LEVELS.verbose).toBeLessThan(VERBOSITY_LEVELS.debug);
  });
});

// =============================================================================
// emitDecisionEvent (callback helper)
// =============================================================================

describe('emitDecisionEvent', () => {
  test('calls callback with correct event shape', () => {
    const callback = vi.fn();
    emitDecisionEvent(callback, 'standard', 'handoff', {
      toAgent: 'billing',
      reason: 'user requested',
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      type: 'decision',
      data: {
        decisionKind: 'handoff',
        toAgent: 'billing',
        reason: 'user requested',
      },
    });
  });

  test('includes decisionKind in the event data', () => {
    const callback = vi.fn();
    emitDecisionEvent(callback, 'verbose', 'gather_extraction', {
      field: 'email',
    });

    const emittedData = callback.mock.calls[0][0].data;
    expect(emittedData.decisionKind).toBe('gather_extraction');
    expect(emittedData.field).toBe('email');
  });

  test('respects verbosity gating — blocks verbose-tier at standard', () => {
    const callback = vi.fn();
    emitDecisionEvent(callback, 'standard', 'gather_extraction', { field: 'email' });
    expect(callback).not.toHaveBeenCalled();
  });

  test('respects verbosity gating — allows verbose-tier at verbose', () => {
    const callback = vi.fn();
    emitDecisionEvent(callback, 'verbose', 'gather_extraction', { field: 'email' });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('no-ops when callback is undefined', () => {
    // Should not throw
    expect(() => {
      emitDecisionEvent(undefined, 'standard', 'handoff', { reason: 'test' });
    }).not.toThrow();
  });

  test('defaults to standard verbosity when verbosity is undefined', () => {
    const callback = vi.fn();

    // Standard-tier kind should emit
    emitDecisionEvent(callback, undefined, 'handoff', { reason: 'test' });
    expect(callback).toHaveBeenCalledTimes(1);

    // Verbose-tier kind should not emit
    callback.mockClear();
    emitDecisionEvent(callback, undefined, 'data_mutation', { key: 'val' });
    expect(callback).not.toHaveBeenCalled();
  });

  test('minimal verbosity blocks all decision kinds', () => {
    const callback = vi.fn();
    const allKinds: DecisionKind[] = [
      'handoff',
      'delegation',
      'flow_transition',
      'field_validation',
      'escalation',
      'completion',
      'constraint_check',
      'guardrail_check',
      'gather_extraction',
      'correction',
      'data_mutation',
      'await_attachment',
    ];

    for (const kind of allKinds) {
      emitDecisionEvent(callback, 'minimal', kind, {});
    }
    expect(callback).not.toHaveBeenCalled();
  });

  test('debug verbosity emits all decision kinds', () => {
    const callback = vi.fn();
    const allKinds: DecisionKind[] = [
      'handoff',
      'delegation',
      'flow_transition',
      'field_validation',
      'escalation',
      'completion',
      'constraint_check',
      'guardrail_check',
      'gather_extraction',
      'correction',
      'data_mutation',
      'await_attachment',
    ];

    for (const kind of allKinds) {
      emitDecisionEvent(callback, 'debug', kind, { kind });
    }
    expect(callback).toHaveBeenCalledTimes(12);
  });

  test('metadata is spread into event data alongside decisionKind', () => {
    const callback = vi.fn();
    const metadata = {
      fromAgent: 'support',
      toAgent: 'billing',
      reason: 'billing inquiry',
      confidence: 0.95,
    };
    emitDecisionEvent(callback, 'standard', 'handoff', metadata);

    const data = callback.mock.calls[0][0].data;
    expect(data).toEqual({
      decisionKind: 'handoff',
      ...metadata,
    });
  });
});
