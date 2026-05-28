/**
 * Pre-Refactor Test: Completion Delegation
 *
 * Tests the CompletionDetector construct executor that evaluates
 * COMPLETE WHEN conditions, explicit THEN:COMPLETE, STORE directives,
 * and escalation triggers. This is the new compiler-layer implementation
 * that will replace the runtime's inline completion logic.
 */

import { describe, test, expect } from 'vitest';
import type { AgentIR, CompletionCondition, CompletionCheckResult } from '@abl/compiler';
import { CompletionDetector } from '@abl/compiler';

// =============================================================================
// FIXTURES
// =============================================================================

function createAgentIR(
  completionConditions: CompletionCondition[],
  overrides: Partial<AgentIR> = {},
): AgentIR {
  return {
    name: 'TestAgent',
    goal: 'Test goal',
    execution_mode: 'reasoning',
    tools: [],
    constraints: [],
    completion: {
      conditions: completionConditions,
    },
    ...overrides,
  } as AgentIR;
}

function createContext(values: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...values };
}

// =============================================================================
// TESTS
// =============================================================================

describe('CompletionDetector', () => {
  const detector = new CompletionDetector();

  // ---------------------------------------------------------------------------
  // COMPLETE WHEN condition evaluation
  // ---------------------------------------------------------------------------

  describe('COMPLETE WHEN conditions', () => {
    test('returns completed when condition is met', () => {
      const ir = createAgentIR([{ when: 'name IS SET', respond: 'Goodbye {{name}}!' }]);
      const context = createContext({ name: 'Alice' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
      expect(result.matchedCondition).toBeDefined();
      expect(result.matchedCondition!.when).toBe('name IS SET');
    });

    test('returns not completed when condition is not met', () => {
      const ir = createAgentIR([{ when: 'confirmed == true', respond: 'Confirmed!' }]);
      const context = createContext({ name: 'Alice' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(false);
      expect(result.matchedCondition).toBeUndefined();
    });

    test('first matching condition wins', () => {
      const ir = createAgentIR([
        { when: 'vip == true', respond: 'VIP goodbye!' },
        { when: 'name IS SET', respond: 'Regular goodbye.' },
      ]);
      const context = createContext({ name: 'Bob' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
      expect(result.matchedCondition!.respond).toBe('Regular goodbye.');
    });

    test('evaluates all conditions and stops at first match', () => {
      const ir = createAgentIR([
        { when: 'a == 1', respond: 'A' },
        { when: 'b == 2', respond: 'B' },
        { when: 'c == 3', respond: 'C' },
      ]);
      const context = createContext({ b: 2 });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
      expect(result.matchedCondition!.respond).toBe('B');
    });

    test('WHEN: true always matches', () => {
      const ir = createAgentIR([{ when: 'true', respond: 'Done.' }]);
      const context = createContext({});
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
    });

    test('handles complex IS SET condition', () => {
      const ir = createAgentIR([
        { when: 'name IS SET AND email IS SET', respond: 'All collected!' },
      ]);
      const context = createContext({ name: 'Alice', email: 'a@b.com' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
    });

    test('complex condition fails when partial', () => {
      const ir = createAgentIR([
        { when: 'name IS SET AND email IS SET', respond: 'All collected!' },
      ]);
      const context = createContext({ name: 'Alice' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // No completion section
  // ---------------------------------------------------------------------------

  describe('No completion conditions', () => {
    test('returns not completed when agentIR has no completion section', () => {
      const ir = {
        name: 'NoComplete',
        goal: 'No completion',
        execution_mode: 'reasoning',
        tools: [],
        constraints: [],
      } as AgentIR;
      const context = createContext({ anything: true });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(false);
    });

    test('returns not completed when completion conditions array is empty', () => {
      const ir = createAgentIR([]);
      const context = createContext({ anything: true });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // STORE directive
  // ---------------------------------------------------------------------------

  describe('STORE directive', () => {
    test('matched condition includes store key', () => {
      const ir = createAgentIR([
        { when: 'city IS SET', respond: 'Booked!', store: 'booking_city = city' },
      ]);
      const context = createContext({ city: 'Paris' });
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
      expect(result.matchedCondition!.store).toBe('booking_city = city');
    });

    test('unmatched condition does not expose store', () => {
      const ir = createAgentIR([
        { when: 'city IS SET', respond: 'Booked!', store: 'booking_city = city' },
      ]);
      const context = createContext({});
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(false);
      expect(result.matchedCondition).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Trace callback
  // ---------------------------------------------------------------------------

  describe('Trace callback', () => {
    test('calls onCheck for each evaluated condition', () => {
      const ir = createAgentIR([
        { when: 'a == 1', respond: 'A' },
        { when: 'b == 2', respond: 'B' },
        { when: 'c == 3', respond: 'C' },
      ]);
      const context = createContext({ b: 2 });
      const checks: CompletionCheckResult[] = [];
      detector.check(ir, context, { onCheck: (info) => checks.push(info) });

      // First condition (a==1) evaluated and failed, second (b==2) matched and stopped
      expect(checks.length).toBe(2);
      expect(checks[0].passed).toBe(false);
      expect(checks[0].condition).toBe('a == 1');
      expect(checks[1].passed).toBe(true);
      expect(checks[1].condition).toBe('b == 2');
    });

    test('calls onCheck for all conditions when none match', () => {
      const ir = createAgentIR([
        { when: 'x == 1', respond: 'X' },
        { when: 'y == 2', respond: 'Y' },
      ]);
      const context = createContext({});
      const checks: CompletionCheckResult[] = [];
      detector.check(ir, context, { onCheck: (info) => checks.push(info) });

      expect(checks.length).toBe(2);
      expect(checks.every((c) => !c.passed)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Response interpolation
  // ---------------------------------------------------------------------------

  describe('Response message', () => {
    test('matched condition includes respond template', () => {
      const ir = createAgentIR([{ when: 'name IS SET', respond: 'Goodbye {{name}}!' }]);
      const context = createContext({ name: 'Alice' });
      const result = detector.check(ir, context);

      expect(result.matchedCondition!.respond).toBe('Goodbye {{name}}!');
    });

    test('matched condition without respond returns undefined respond', () => {
      const ir = createAgentIR([{ when: 'true' }]);
      const context = createContext({});
      const result = detector.check(ir, context);

      expect(result.shouldComplete).toBe(true);
      expect(result.matchedCondition!.respond).toBeUndefined();
    });
  });
});
