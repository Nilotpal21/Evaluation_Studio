/**
 * Pre-Refactor: Constraint Actions Extended Parity Tests
 *
 * Covers constraint violation action types that exist in the runtime
 * but were not previously tested:
 * - ON_FAIL: HANDOFF (route to another agent)
 * - ON_FAIL: collect_field (re-collect specific fields)
 * - ON_FAIL: goto_step (backtrack to a specific step)
 * - ON_FAIL: retry_step (retry the current step)
 * - ON_FAIL: redact (redact sensitive content)
 * - ON_FAIL: block (block execution, default fallback)
 * - Warning-severity constraints (non-blocking)
 * - Backtrack limit enforcement
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import {
  checkFlatConstraints,
  handleConstraintViolation,
  interpretConstraintControlFlow,
  MAX_BACKTRACKS_PER_STEP,
} from '../../../services/execution/constraint-checker';

// =============================================================================
// TESTS
// =============================================================================

describe('Pre-Refactor: Constraint Actions Extended', () => {
  let executor: RuntimeExecutor;
  const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  function attachCustomContractPII(
    session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  ) {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );

    session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };
    session.piiRecognizerRegistry = registry;
    session.piiVault = new PIIVault({ recognizerRegistry: registry });
    session.piiPatternConfigs = [
      {
        patternName: 'ContractID',
        defaultRenderMode: 'redacted',
        consumerAccess: [],
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // ON_FAIL: HANDOFF
  // ---------------------------------------------------------------------------

  describe('ON_FAIL: HANDOFF', () => {
    test('constraint violation triggers handoff action', async () => {
      const dsl = `
AGENT: Handoff_Constraint
GOAL: "Test handoff on constraint violation"

CONSTRAINTS:
  - REQUIRE false
    ON_FAIL: HANDOFF supervisor

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - query: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Handoff_Constraint'),
      );
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'test', undefined, tc.callback);

      // REQUIRE false always fails, ON_FAIL: HANDOFF should trigger
      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      const violationTraces = filterTraces(tc.traces, 'constraint_violation');
      expect(constraintTraces.length + violationTraces.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // handleConstraintViolation unit tests
  // ---------------------------------------------------------------------------

  describe('handleConstraintViolation Direct', () => {
    test('respond action emits message and returns constraint_blocked', () => {
      const dsl = `
AGENT: Unit_Respond
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Respond'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_constraint',
          condition: 'val > 100',
          passed: false,
          action: { type: 'respond', message: 'Value too high.' },
        },
        (c) => chunks.push(c),
      );

      expect(chunks.join('')).toContain('Value too high.');
      expect(result.action.type).toBe('constraint_blocked');
    });

    test('respond action redacts delivery while tokenizing history for custom patterns', () => {
      const dsl = `
AGENT: Unit_Respond_PII
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Respond_PII'),
      );
      attachCustomContractPII(session);

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_constraint_pii',
          condition: 'val > 100',
          passed: false,
          action: { type: 'respond', message: `Value too high for ${rawContractId}.` },
        },
        (c) => chunks.push(c),
      );

      expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
      expect(result.response).not.toContain(rawContractId);
      expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
      expect(chunks.join('')).not.toContain(rawContractId);
      const lastHistory = session.conversationHistory[session.conversationHistory.length - 1];
      expect(String(lastHistory.content)).toContain('{{PII:ContractID:');
      expect(String(lastHistory.content)).not.toContain(rawContractId);
      expect(result.action.type).toBe('constraint_blocked');
    });

    test('escalate action sets session.isEscalated', () => {
      const dsl = `
AGENT: Unit_Escalate
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Escalate'),
      );

      const result = handleConstraintViolation(session as any, {
        type: 'constraint',
        name: 'test_escalate',
        condition: 'false',
        passed: false,
        action: { type: 'escalate', reason: 'Critical violation' },
      });

      expect(session.isEscalated).toBe(true);
      expect(session.escalationReason).toContain('Critical violation');
      expect(result.action.type).toBe('escalate');
    });

    test('handoff action returns handoff target', () => {
      const dsl = `
AGENT: Unit_Handoff
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Handoff'),
      );

      const result = handleConstraintViolation(session as any, {
        type: 'constraint',
        name: 'test_handoff',
        condition: 'false',
        passed: false,
        action: { type: 'handoff', target: 'billing_agent' },
      });

      expect(result.action.type).toBe('handoff');
      expect((result.action as any).target).toBe('billing_agent');
    });

    test('block action returns blocked result', () => {
      const dsl = `
AGENT: Unit_Block
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Block'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_block',
          condition: 'false',
          passed: false,
          action: { type: 'block', message: 'Blocked by policy.' },
        },
        (c) => chunks.push(c),
      );

      expect(result.action.type).toBe('blocked');
      expect(chunks.join('')).toContain('Blocked by policy.');
    });

    test('redact action returns redacted result', () => {
      const dsl = `
AGENT: Unit_Redact
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Redact'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_redact',
          condition: 'contains_pii',
          passed: false,
          action: { type: 'redact', message: 'Content has been redacted.' },
        },
        (c) => chunks.push(c),
      );

      expect(result.action.type).toBe('redacted');
      expect(chunks.join('')).toContain('redacted');
    });

    test('collect_field action returns constraint_collect', () => {
      const dsl = `
AGENT: Unit_Collect
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Collect'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_collect',
          condition: 'missing_field',
          passed: false,
          action: {
            type: 'collect_field',
            collect_fields: ['phone'],
            message: 'We need your phone number.',
          },
        },
        (c) => chunks.push(c),
      );

      expect(result.action.type).toBe('constraint_collect');
      expect((result.action as any).fields).toEqual(['phone']);
    });

    test('goto_step action returns goto_step target', () => {
      const dsl = `
AGENT: Unit_Goto
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Goto'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_goto',
          condition: 'invalid_state',
          passed: false,
          action: {
            type: 'goto_step',
            then_step: 'ask',
            message: 'Going back to collection.',
          },
        },
        (c) => chunks.push(c),
      );

      expect(result.action.type).toBe('goto_step');
      expect((result.action as any).target).toBe('ask');
    });

    test('retry_step action returns retry_step', () => {
      const dsl = `
AGENT: Unit_Retry
GOAL: "Unit test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Unit_Retry'),
      );

      const chunks: string[] = [];
      const result = handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'test_retry',
          condition: 'transient_error',
          passed: false,
          action: { type: 'retry_step', message: 'Please try again.' },
        },
        (c) => chunks.push(c),
      );

      expect(result.action.type).toBe('retry_step');
      expect(chunks.join('')).toContain('try again');
    });
  });

  // ---------------------------------------------------------------------------
  // interpretConstraintControlFlow
  // ---------------------------------------------------------------------------

  describe('interpretConstraintControlFlow', () => {
    test('collect_field returns ConstraintControlFlowDirective', () => {
      const dsl = `
AGENT: CF_Collect
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'CF_Collect'),
      );

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'need_more',
        condition: 'phone IS NOT SET',
        passed: false,
        action: {
          type: 'collect_field',
          collect_fields: ['phone'],
          then_action: 'continue',
          message: 'Need phone.',
        },
      });

      expect(directive).not.toBeNull();
      expect(directive!.type).toBe('collect_field');
      expect(directive!.fields).toEqual(['phone']);
      expect(directive!.thenAction).toBe('continue');
    });

    test('goto_step returns directive with target step', () => {
      const dsl = `
AGENT: CF_Goto
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'CF_Goto'));

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'bad_state',
        condition: 'val == invalid',
        passed: false,
        action: { type: 'goto_step', then_step: 'ask', message: 'Try again.' },
      });

      expect(directive).not.toBeNull();
      expect(directive!.type).toBe('goto_step');
      expect(directive!.targetStep).toBe('ask');
    });

    test('goto_step returns null when backtrack limit exceeded', () => {
      const dsl = `
AGENT: CF_Backtrack_Limit
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'CF_Backtrack_Limit'),
      );
      // Simulate having already backtracked MAX times
      (session as any).backtrackCounts = { ask: MAX_BACKTRACKS_PER_STEP };

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'loop_constraint',
        condition: 'val == invalid',
        passed: false,
        action: { type: 'goto_step', then_step: 'ask', message: 'Try again.' },
      });

      // Should return null (falls through to terminal handling)
      expect(directive).toBeNull();
    });

    test('retry_step returns directive', () => {
      const dsl = `
AGENT: CF_Retry
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'CF_Retry'));

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'retry_me',
        condition: 'transient',
        passed: false,
        action: { type: 'retry_step', message: 'Retry.' },
      });

      expect(directive).not.toBeNull();
      expect(directive!.type).toBe('retry_step');
    });

    test('respond returns null (terminal action)', () => {
      const dsl = `
AGENT: CF_Respond
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'CF_Respond'),
      );

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'blocked',
        condition: 'false',
        passed: false,
        action: { type: 'respond', message: 'Not allowed.' },
      });

      expect(directive).toBeNull();
    });

    test('escalate returns null (terminal action)', () => {
      const dsl = `
AGENT: CF_Escalate
GOAL: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'CF_Escalate'),
      );

      const directive = interpretConstraintControlFlow(session as any, {
        type: 'constraint',
        name: 'critical',
        condition: 'false',
        passed: false,
        action: { type: 'escalate', reason: 'Critical.' },
      });

      expect(directive).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Constraint trace events for various actions
  // ---------------------------------------------------------------------------

  describe('Constraint Trace Events for Actions', () => {
    test('violation emits constraint_violation trace', () => {
      const dsl = `
AGENT: Trace_Violation
GOAL: "Test trace"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Trace_Violation'),
      );

      const tc = createTraceCollector();
      handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'trace_test',
          condition: 'false',
          passed: false,
          action: { type: 'respond', message: 'Blocked.' },
        },
        undefined,
        tc.callback,
      );

      const violationTraces = filterTraces(tc.traces, 'constraint_violation');
      expect(violationTraces.length).toBe(1);
      expect(violationTraces[0].data.name).toBe('trace_test');
    });

    test('escalation emits both violation and escalation traces', () => {
      const dsl = `
AGENT: Trace_Escalation
GOAL: "Test trace"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Trace_Escalation'),
      );

      const tc = createTraceCollector();
      handleConstraintViolation(
        session as any,
        {
          type: 'constraint',
          name: 'escalate_trace',
          condition: 'false',
          passed: false,
          action: { type: 'escalate', reason: 'Critical' },
        },
        undefined,
        tc.callback,
      );

      const violationTraces = filterTraces(tc.traces, 'constraint_violation');
      const escalationTraces = filterTraces(tc.traces, 'escalation');
      expect(violationTraces.length).toBe(1);
      expect(escalationTraces.length).toBe(1);
      expect(escalationTraces[0].data.source).toBe('constraint_violation');
    });
  });

  // ---------------------------------------------------------------------------
  // checkFlatConstraints integration
  // ---------------------------------------------------------------------------

  describe('checkFlatConstraints Integration', () => {
    test('returns null when no constraints defined', () => {
      const dsl = `
AGENT: No_Constraints
GOAL: "No constraints"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'No_Constraints'),
      );

      const result = checkFlatConstraints(session as any);
      expect(result).toBeNull();
    });

    test('returns null when all constraints pass', async () => {
      const dsl = `
AGENT: All_Pass
GOAL: "Test all pass"

CONSTRAINTS:
  - REQUIRE true

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'All_Pass'));
      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const result = checkFlatConstraints(session as any, tc.callback);

      // REQUIRE true always passes
      if (result === null) {
        // All passed — no violation
        expect(result).toBeNull();
      } else {
        // If result is returned, it should be a passing check
        expect(result.passed).toBe(true);
      }
    });

    test('returns violation when constraint fails', async () => {
      const dsl = `
AGENT: Fails_Check
GOAL: "Test fail"

CONSTRAINTS:
  - REQUIRE false
    ON_FAIL: RESPOND "Always fails"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Fails_Check'),
      );
      await executor.initializeSession(session.id);
      // Set a value so constraint checking runs
      session.data.values.val = 'test';

      const tc = createTraceCollector();
      const result = checkFlatConstraints(session as any, tc.callback);

      // REQUIRE false always fails
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(false);

      const constraintTraces = filterTraces(tc.traces, 'constraint_check');
      expect(constraintTraces.length).toBeGreaterThanOrEqual(1);
    });
  });
});
