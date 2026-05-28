import { describe, test, expect } from 'vitest';
import {
  interpretConstraintControlFlow,
  MAX_BACKTRACKS_PER_STEP,
} from '../../services/execution/constraint-checker.js';
import type { ConstraintCheckInfo } from '@abl/compiler';

function createSession(overrides?: Record<string, unknown>) {
  return {
    agentName: 'test',
    currentFlowStep: 'step1',
    data: { values: {}, gatheredKeys: new Set<string>() },
    backtrackCounts: {},
    constraintCollectState: undefined,
    ...overrides,
  } as any;
}

describe('constraint control flow', () => {
  test('collect_field directive returns collect action', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'max_guests',
      condition: 'num_guests <= 10',
      passed: false,
      action: {
        type: 'collect_field',
        collect_fields: ['num_guests'],
        message: 'Too many guests',
        then_action: 'continue',
      },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('collect_field');
    expect(directive!.fields).toEqual(['num_guests']);
    expect(directive!.thenAction).toBe('continue');
    expect(directive!.respond).toBe('Too many guests');
    expect(directive!.constraintCondition).toBe('num_guests <= 10');
  });

  test('goto_step directive returns goto with target', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'need_info',
      condition: 'info IS SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_info', message: 'Need more info' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
    expect(directive!.targetStep).toBe('gather_info');
    expect(directive!.respond).toBe('Need more info');
  });

  test('goto_step tracks backtrack count and allows under limit', () => {
    const session = createSession({ backtrackCounts: { gather_info: 1 } });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'need_info',
      condition: 'info IS SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_info', message: 'Need more info' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
  });

  test('goto_step exceeds MAX_BACKTRACKS_PER_STEP returns null', () => {
    const session = createSession({
      backtrackCounts: { gather_info: MAX_BACKTRACKS_PER_STEP },
    });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'need_info',
      condition: 'info IS SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_info', message: 'Need more info' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).toBeNull();
  });

  test('retry_step directive returns retry action', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'format_check',
      condition: 'valid_format == true',
      passed: false,
      action: { type: 'retry_step', message: 'Invalid format, try again' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('retry_step');
    expect(directive!.respond).toBe('Invalid format, try again');
  });

  test('terminal actions (respond, escalate, block) return null', () => {
    const session = createSession();

    const respondViolation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'x',
      condition: 'x > 0',
      passed: false,
      action: { type: 'respond', message: 'No' },
    };
    expect(interpretConstraintControlFlow(session, respondViolation)).toBeNull();

    const escalateViolation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'x',
      condition: 'x > 0',
      passed: false,
      action: { type: 'escalate', reason: 'bad' },
    };
    expect(interpretConstraintControlFlow(session, escalateViolation)).toBeNull();

    const blockViolation: ConstraintCheckInfo = {
      type: 'guardrail',
      name: 'x',
      condition: 'x > 0',
      passed: false,
      action: { type: 'block', message: 'blocked' },
    };
    expect(interpretConstraintControlFlow(session, blockViolation)).toBeNull();
  });

  test('collect_field sets constraintCollectState on session', () => {
    const session = createSession();
    // Simulate what handleConstraintControlFlow does
    session.constraintCollectState = {
      fields: ['num_guests'],
      thenAction: 'continue',
      constraintCondition: 'num_guests <= 10',
    };
    expect(session.constraintCollectState).toBeDefined();
    expect(session.constraintCollectState.fields).toEqual(['num_guests']);
    expect(session.constraintCollectState.thenAction).toBe('continue');
    expect(session.constraintCollectState.constraintCondition).toBe('num_guests <= 10');
  });

  test('collect_field still fails after collection should escalate (state cleared)', () => {
    // After mini-collect, if constraint still fails, constraintCollectState is cleared
    const session = createSession({
      constraintCollectState: {
        fields: ['num_guests'],
        thenAction: 'continue',
        constraintCondition: 'num_guests <= 10',
      },
    });
    // Simulate clearing after failed re-evaluation
    session.constraintCollectState = undefined;
    expect(session.constraintCollectState).toBeUndefined();
  });

  test('nested constraint-collect is prevented by clearing state first', () => {
    // If already in a constraint-collect state, executeMiniCollect clears it
    // before re-evaluation, preventing nested collect states
    const session = createSession({
      constraintCollectState: {
        fields: ['field_a'],
        thenAction: 'continue',
        constraintCondition: 'field_a > 0',
      },
    });
    expect(session.constraintCollectState).toBeDefined();
    // executeMiniCollect clears state before re-eval
    session.constraintCollectState = undefined;
    expect(session.constraintCollectState).toBeUndefined();
  });

  test('goto_step with backtrackCounts at limit minus one still works', () => {
    const session = createSession({
      backtrackCounts: { gather_info: MAX_BACKTRACKS_PER_STEP - 1 },
    });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'need_info',
      condition: 'info IS SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_info', message: 'One more try' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
  });

  test('goto_step without existing backtrackCounts initializes correctly', () => {
    const session = createSession({ backtrackCounts: undefined });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'need_info',
      condition: 'info IS SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'new_step', message: 'Going back' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
    expect(directive!.targetStep).toBe('new_step');
  });

  test('collect_field with then_action=retry returns retry thenAction', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'check_amount',
      condition: 'amount > 0',
      passed: false,
      action: {
        type: 'collect_field',
        collect_fields: ['amount'],
        message: 'Amount must be positive',
        then_action: 'retry',
      },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('collect_field');
    expect(directive!.thenAction).toBe('retry');
  });

  test('handoff and redact actions return null (terminal)', () => {
    const session = createSession();

    const handoffViolation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'route',
      condition: 'needs_human == true',
      passed: false,
      action: { type: 'handoff', target: 'human_agent' },
    };
    expect(interpretConstraintControlFlow(session, handoffViolation)).toBeNull();

    const redactViolation: ConstraintCheckInfo = {
      type: 'guardrail',
      name: 'pii',
      condition: 'contains_pii == false',
      passed: false,
      action: { type: 'redact', message: 'PII detected' },
    };
    expect(interpretConstraintControlFlow(session, redactViolation)).toBeNull();
  });

  test('collect_field with no collect_fields defaults to empty array', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'test',
      condition: 'x > 0',
      passed: false,
      action: { type: 'collect_field', message: 'Please provide data' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.fields).toEqual([]);
  });

  test('collect_field with no then_action defaults to continue', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'test',
      condition: 'x > 0',
      passed: false,
      action: {
        type: 'collect_field',
        collect_fields: ['x'],
        message: 'Please provide x',
      },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.thenAction).toBe('continue');
  });

  test('collect_field reads then_step from compiler output while preserving then_action fallback', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'compiler_collect_goto',
      condition: 'verification_code IS SET',
      passed: false,
      action: {
        type: 'collect_field',
        collect_fields: ['verification_code'],
        then_step: 'verify_identity',
        then_action: 'retry',
        message: 'Please share your verification code',
      },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('collect_field');
    expect(directive!.fields).toEqual(['verification_code']);
    expect(directive!.thenStep).toBe('verify_identity');
    expect(directive!.thenAction).toBe('retry');
  });

  test('goto_step with no then_step or target defaults to empty string', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'test',
      condition: 'x > 0',
      passed: false,
      action: { type: 'goto_step', message: 'Going somewhere' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.targetStep).toBe('');
  });

  test('goto_step reads then_step (compiler output) over target', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'compiler_goto',
      condition: 'data IS NOT SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_data', message: 'Need data' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
    expect(directive!.targetStep).toBe('gather_data');
  });

  test('goto_step falls back to target when then_step is absent (legacy compat)', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'legacy_goto',
      condition: 'data IS NOT SET',
      passed: false,
      action: { type: 'goto_step', target: 'legacy_step', message: 'Fallback' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
    expect(directive!.targetStep).toBe('legacy_step');
  });

  test('goto_step prefers then_step when both then_step and target are present', () => {
    const session = createSession();
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'both_fields',
      condition: 'x IS NOT SET',
      passed: false,
      action: {
        type: 'goto_step',
        then_step: 'correct_step',
        target: 'wrong_step',
        message: 'Go',
      },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.targetStep).toBe('correct_step');
  });

  test('goto_step backtrack counting works with then_step (compiler path)', () => {
    const session = createSession({ backtrackCounts: { gather_data: 2 } });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'compiler_backtrack',
      condition: 'data IS NOT SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_data', message: 'Need data' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).not.toBeNull();
    expect(directive!.type).toBe('goto_step');
    expect(directive!.targetStep).toBe('gather_data');
  });

  test('goto_step backtrack limit works with then_step (compiler path)', () => {
    const session = createSession({
      backtrackCounts: { gather_data: MAX_BACKTRACKS_PER_STEP },
    });
    const violation: ConstraintCheckInfo = {
      type: 'constraint',
      name: 'compiler_backtrack_limit',
      condition: 'data IS NOT SET',
      passed: false,
      action: { type: 'goto_step', then_step: 'gather_data', message: 'Need data' },
    };
    const directive = interpretConstraintControlFlow(session, violation);
    expect(directive).toBeNull();
  });
});
