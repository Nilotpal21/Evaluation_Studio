import { describe, it, expect } from 'vitest';
import {
  interpretConstraintControlFlow,
  MAX_BACKTRACKS_PER_STEP,
} from '../../services/execution/constraint-checker.js';
import type { RuntimeSession } from '../../services/execution/types.js';

function createMockSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test-agent',
    tenantId: 'test-tenant',
    data: { values: {}, gatheredKeys: new Set() },
    conversationHistory: [],
    initialized: true,
    traceVerbosity: 'verbose',
    ...overrides,
  } as RuntimeSession;
}

describe('constraint decision traces', () => {
  describe('constraint_directive', () => {
    it('emits control_flow for collect_field action', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession();

      const violation = {
        type: 'constraint' as const,
        name: 'budget_check',
        condition: 'budget > 0',
        passed: false,
        action: {
          type: 'collect_field' as const,
          collect_fields: ['budget'],
          message: 'Need budget',
        },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      const directive = events.find((e) => e.type === 'constraint_directive');
      expect(directive).toBeDefined();
      expect(directive!.data.directiveType).toBe('control_flow');
      expect(directive!.data.directiveAction).toBe('collect_field');
    });

    it('emits terminal for respond action', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession();

      const violation = {
        type: 'constraint' as const,
        name: 'age_check',
        condition: 'age >= 18',
        passed: false,
        action: { type: 'respond' as const, message: 'Too young' },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      const directive = events.find((e) => e.type === 'constraint_directive');
      expect(directive).toBeDefined();
      expect(directive!.data.directiveType).toBe('terminal');
    });

    it('emits control_flow for goto_step within limit', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession({ backtrackCounts: {} });

      const violation = {
        type: 'constraint' as const,
        name: 'validation',
        condition: 'x > 0',
        passed: false,
        action: { type: 'goto_step' as const, then_step: 'step_1' },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      const directive = events.find((e) => e.type === 'constraint_directive');
      expect(directive).toBeDefined();
      expect(directive!.data.directiveType).toBe('control_flow');
      expect(directive!.data.directiveAction).toBe('goto_step');
    });

    it('emits control_flow for retry_step', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession();

      const violation = {
        type: 'constraint' as const,
        name: 'retry_check',
        condition: 'valid === true',
        passed: false,
        action: { type: 'retry_step' as const },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      const directive = events.find((e) => e.type === 'constraint_directive');
      expect(directive).toBeDefined();
      expect(directive!.data.directiveType).toBe('control_flow');
      expect(directive!.data.directiveAction).toBe('retry_step');
    });

    it('is NOT emitted at standard verbosity', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession({ traceVerbosity: 'standard' });

      const violation = {
        type: 'constraint' as const,
        name: 'check',
        condition: 'x > 0',
        passed: false,
        action: { type: 'collect_field' as const, collect_fields: ['x'] },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      expect(events.filter((e) => e.type === 'constraint_directive')).toHaveLength(0);
    });
  });

  describe('constraint_backtrack', () => {
    it('emits backtrack count for goto_step', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession({ backtrackCounts: { step_1: 1 } });

      const violation = {
        type: 'constraint' as const,
        name: 'v',
        condition: 'x > 0',
        passed: false,
        action: { type: 'goto_step' as const, then_step: 'step_1' },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      const backtrack = events.find((e) => e.type === 'constraint_backtrack');
      expect(backtrack).toBeDefined();
      expect(backtrack!.data.count).toBe(1);
      expect(backtrack!.data.limit).toBe(MAX_BACKTRACKS_PER_STEP);
    });
  });

  describe('constraint_backtrack_limit', () => {
    it('emits when backtrack limit exceeded', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession({
        backtrackCounts: { step_1: MAX_BACKTRACKS_PER_STEP },
      });

      const violation = {
        type: 'constraint' as const,
        name: 'v',
        condition: 'x > 0',
        passed: false,
        action: { type: 'goto_step' as const, then_step: 'step_1' },
      };

      const result = interpretConstraintControlFlow(session, violation, onTraceEvent);

      expect(result).toBeNull(); // limit exceeded
      const limitEvent = events.find((e) => e.type === 'constraint_backtrack_limit');
      expect(limitEvent).toBeDefined();
      expect(limitEvent!.data.fallbackAction).toBe('escalate');
      expect(limitEvent!.data.originalAction).toBe('goto_step');
    });

    it('does NOT emit backtrack_limit when within limit', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) => events.push(e);
      const session = createMockSession({ backtrackCounts: { step_1: 1 } });

      const violation = {
        type: 'constraint' as const,
        name: 'v',
        condition: 'x > 0',
        passed: false,
        action: { type: 'goto_step' as const, then_step: 'step_1' },
      };

      interpretConstraintControlFlow(session, violation, onTraceEvent);

      expect(events.filter((e) => e.type === 'constraint_backtrack_limit')).toHaveLength(0);
    });
  });

  describe('no trace handler', () => {
    it('does not throw when onTraceEvent is undefined', () => {
      const session = createMockSession();
      const violation = {
        type: 'constraint' as const,
        name: 'check',
        condition: 'x > 0',
        passed: false,
        action: { type: 'collect_field' as const, collect_fields: ['x'] },
      };

      expect(() => interpretConstraintControlFlow(session, violation)).not.toThrow();
    });
  });
});
