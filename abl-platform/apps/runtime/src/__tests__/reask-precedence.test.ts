/**
 * TDD lock tests for reask precedence — Slice 2 [ABLP-413]
 *
 * When multiple guardrail violations exist, the pipeline's precedence logic
 * determines which action wins. Block (5) > Reask (4), Escalate (6) > Reask (4).
 * If a terminal action with higher precedence wins, the reask branch must NOT fire.
 *
 * These tests exercise the existing action-precedence logic from the compiler's
 * pipeline result aggregation — no mocks of internal packages.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldExecuteReask,
  type ReaskDecisionInput,
} from '../services/execution/reask-executor.js';

describe('reask precedence', () => {
  it('should NOT reask when block wins over reask (block precedence=5, reask=4)', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'block',
      primaryMessage: 'Content blocked',
      hasReaskViolation: true,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(false);
    expect(decision.fallbackAction).toBe('block');
  });

  it('should NOT reask when escalate wins over reask (escalate precedence=6, reask=4)', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'escalate',
      primaryMessage: 'Escalating to human agent',
      hasReaskViolation: true,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(false);
    expect(decision.fallbackAction).toBe('escalate');
  });

  it('should reask when reask is the primary (highest-precedence) violation action', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'reask',
      primaryMessage: 'Content violates policy',
      hasReaskViolation: true,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(true);
  });

  it('should NOT reask when the action is a non-terminal content modifier (redact, fix, filter)', () => {
    for (const action of ['redact', 'fix', 'filter'] as const) {
      const input: ReaskDecisionInput = {
        primaryAction: action,
        primaryMessage: 'Modified content',
        hasReaskViolation: false,
      };

      const decision = shouldExecuteReask(input);
      expect(decision.shouldReask).toBe(false);
    }
  });

  it('should NOT reask when there is no reask violation at all', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'warn',
      primaryMessage: 'Warning only',
      hasReaskViolation: false,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(false);
  });
});
