/**
 * Pre-Refactor Test: Constraint Delegation via ConstraintExecutor
 *
 * Validates that the shadow-mode delegation to ConstraintExecutor
 * produces results consistent with the old runtime constraint-checker path.
 * During shadow phase, the old path's result is always returned.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { ConstraintExecutor } from '@abl/compiler';
import type { ConstraintOptions } from '@abl/compiler';
import {
  createBaseSession,
  createBaseState,
  createBaseDataStore,
} from './helpers/test-session-factory.js';
import {
  buildExecutionContext,
  type BridgeDeps,
} from '../../../services/execution/execution-context-bridge.js';
import { checkConstraints } from '../../../services/execution/constraint-checker.js';

// =============================================================================
// FIXTURES
// =============================================================================

function createMinimalAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    name: 'TestAgent',
    goal: 'Test goal',
    execution_mode: 'reasoning',
    tools: [],
    constraints: { constraints: [], guardrails: [] },
    ...overrides,
  } as AgentIR;
}

function createMinimalDeps(): BridgeDeps {
  return {
    toolExecutor: {
      execute: async () => ({}),
      executeParallel: async () => [],
    },
    llmClient: {
      chat: async () => '',
      chatWithTools: async () => ({ toolCalls: [], stopReason: 'end_turn' as const }),
      extractJson: async () => ({}),
    },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Constraint Delegation: ConstraintExecutor parity', () => {
  let constraintExecutor: ConstraintExecutor;

  beforeEach(() => {
    constraintExecutor = new ConstraintExecutor();
  });

  // ---------------------------------------------------------------------------
  // Basic parity: constraint passes
  // ---------------------------------------------------------------------------

  describe('Constraint passes', () => {
    test('both paths agree when all constraints pass', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [{ condition: 'true', on_fail: { type: 'respond', message: 'fail' } }],
          guardrails: [],
        },
      });

      const session = createBaseSession({
        agentIR: ir,
        data: createBaseDataStore({ values: { name: 'Alice' }, gatheredKeys: new Set(['name']) }),
      });

      // Old path
      const oldResult = checkConstraints(session);

      // New path via ConstraintExecutor
      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);

      // Old returns null when all pass
      expect(oldResult).toBeNull();
      // New returns continue action
      expect(newResult.action.type).toBe('continue');
    });

    test('REQUIRE true always passes in both paths', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [{ condition: 'true', on_fail: { type: 'block' } }],
          guardrails: [],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Basic parity: constraint fails
  // ---------------------------------------------------------------------------

  describe('Constraint fails', () => {
    test('both paths detect violation when condition is false', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            { condition: 'false', on_fail: { type: 'respond', message: 'Blocked by constraint' } },
          ],
          guardrails: [],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      // Old path returns ConstraintCheckInfo with passed=false
      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.passed).toBe(false);
      expect(oldResult!.action.type).toBe('respond');

      // New path returns respond action
      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('respond');
    });

    test('both paths detect escalation action', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'false',
              on_fail: { type: 'escalate', reason: 'Must escalate' },
            },
          ],
          guardrails: [],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.action.type).toBe('escalate');

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('escalate');
    });

    test('both paths detect block action', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'false',
              on_fail: { type: 'block', reason: 'Blocked' },
            },
          ],
          guardrails: [],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.action.type).toBe('block');

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('block');
    });
  });

  // ---------------------------------------------------------------------------
  // Guard semantics parity
  // ---------------------------------------------------------------------------

  describe('Guard semantics', () => {
    test('IS SET guard skips constraint when variable unset', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'origin IS SET AND origin != destination',
              on_fail: { type: 'respond', message: 'Same origin/dest' },
            },
          ],
          guardrails: [],
        },
      });

      // origin is not set — guard should skip
      const session = createBaseSession({
        agentIR: ir,
        data: createBaseDataStore({
          values: { destination: 'Paris' },
          gatheredKeys: new Set(['destination']),
        }),
      });

      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull(); // guard skipped = pass

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('continue');
    });

    test('guard passes then assertion evaluated', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'origin IS SET AND origin != destination',
              on_fail: { type: 'respond', message: 'Same origin/dest' },
            },
          ],
          guardrails: [],
        },
      });

      // origin IS set and equals destination — should fail
      const session = createBaseSession({
        agentIR: ir,
        data: createBaseDataStore({
          values: { origin: 'Paris', destination: 'Paris' },
          gatheredKeys: new Set(['origin', 'destination']),
        }),
      });

      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.passed).toBe(false);

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('respond');
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple constraints: first failure wins
  // ---------------------------------------------------------------------------

  describe('Multiple constraints', () => {
    test('first failing constraint determines the action', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'amount > 0',
              on_fail: { type: 'respond', message: 'Amount must be positive.' },
            },
            {
              condition: 'amount <= 10000',
              on_fail: { type: 'respond', message: 'Amount exceeds max.' },
            },
          ],
          guardrails: [],
        },
      });

      // amount = -5: fails first constraint
      const session = createBaseSession({
        agentIR: ir,
        data: createBaseDataStore({
          values: { amount: -5 },
          gatheredKeys: new Set(['amount']),
        }),
      });

      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.action.message).toBe('Amount must be positive.');

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('respond');
    });

    test('second constraint fails when first passes', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'amount > 0',
              on_fail: { type: 'respond', message: 'Amount must be positive.' },
            },
            {
              condition: 'amount <= 10000',
              on_fail: { type: 'respond', message: 'Amount exceeds max.' },
            },
          ],
          guardrails: [],
        },
      });

      // amount = 50000: passes first, fails second
      const session = createBaseSession({
        agentIR: ir,
        data: createBaseDataStore({
          values: { amount: 50000 },
          gatheredKeys: new Set(['amount']),
        }),
      });

      const oldResult = checkConstraints(session);
      expect(oldResult).not.toBeNull();
      expect(oldResult!.action.message).toBe('Amount exceeds max.');

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('respond');
    });
  });

  // ---------------------------------------------------------------------------
  // Guardrails parity
  // ---------------------------------------------------------------------------

  describe('Guardrails', () => {
    test('ConstraintExecutor catches guardrails while the legacy path skips them', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [],
          guardrails: [
            {
              name: 'profanity_check',
              check: 'true', // violation detected (guardrail semantics: check=true means violation)
              action: { type: 'block', message: 'Content blocked' },
            },
          ],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      // Legacy runtime path now skips guardrails entirely; they are evaluated
      // at dedicated pipeline checkpoints instead of through checkConstraints().
      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();

      // New path
      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).not.toBe('continue');
      expect(newResult.metadata?.failedAt).toBe('guardrail');
    });

    test('guardrail passes when check is false', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [],
          guardrails: [
            {
              name: 'safe_check',
              check: 'false', // no violation
              action: { type: 'block', message: 'Content blocked' },
            },
          ],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('continue');
    });
  });

  // ---------------------------------------------------------------------------
  // Empty constraints
  // ---------------------------------------------------------------------------

  describe('Edge cases', () => {
    test('no constraints defined — both paths pass', async () => {
      const ir = createMinimalAgentIR({
        constraints: { constraints: [], guardrails: [] },
      });

      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();

      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('continue');
    });

    test('null constraints on IR — old path returns null', () => {
      const ir = createMinimalAgentIR({ constraints: undefined as unknown });
      const session = createBaseSession({ agentIR: ir });

      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();
    });

    test('warning severity constraint does not block', async () => {
      const ir = createMinimalAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'false',
              on_fail: { type: 'respond', message: 'Warning only' },
              severity: 'warning',
            },
          ],
          guardrails: [],
        },
      });

      const session = createBaseSession({ agentIR: ir });

      // Old path: warning-severity failures are non-blocking
      const oldResult = checkConstraints(session);
      expect(oldResult).toBeNull();

      // New path: should also continue
      const ctx = buildExecutionContext(session, createMinimalDeps());
      const newResult = await constraintExecutor.execute(ctx);
      expect(newResult.action.type).toBe('continue');
    });
  });
});
