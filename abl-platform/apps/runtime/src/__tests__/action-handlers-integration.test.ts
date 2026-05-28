/**
 * ACTION_HANDLERS Integration Tests (INT-8)
 *
 * Tests FlowStepExecutor action dispatch with direct function interaction.
 * Verifies:
 * - Step-level on_action matched → SET/RESPOND/transition executed
 * - Agent-level action_handlers fallback when step has no match
 * - No handler at either level → falls through to normal processing
 * - Condition evaluation on action handlers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ActionHandlerIR } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// DSL FIXTURES
// =============================================================================

/** Minimal agent with an action-bearing step */
const ACTION_AGENT = `
AGENT: ActionInt_Agent
GOAL: "Test action handler dispatch"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask
    - next

ask:
  REASONING: false
  RESPOND: "Choose an option"
    ACTIONS:
      - BUTTON: "Option A" -> opt_a
      - BUTTON: "Option B" -> opt_b
  ON_ACTION:
    opt_a:
      SET: selected = a
      RESPOND: "You chose A."

next:
  REASONING: false
  RESPOND: "Next step."
  THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('ACTION_HANDLERS Integration (INT-8)', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('step-level dispatch', () => {
    it('step on_action fires SET + RESPOND for matching action_id', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ACTION_AGENT], 'ActionInt_Agent'),
      );

      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, '', undefined, tc.callback, {
        actionEvent: { actionId: 'opt_a' },
      });

      expect(session.data.values.selected).toBe('a');
      expect(result.response).toContain('You chose A.');
    });

    it('unmatched action_id at step level falls through to normal processing', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ACTION_AGENT], 'ActionInt_Agent'),
      );

      await executor.initializeSession(session.id);

      // Send an action_id that doesn't match any step handler and no agent-level handlers
      const result = await executor.executeMessage(
        session.id,
        'fallback text',
        undefined,
        undefined,
        {
          actionEvent: { actionId: 'unknown_action' },
        },
      );

      // Should fall through to normal step processing (re-prompt or advance)
      expect(result).toBeDefined();
    });
  });

  describe('agent-level fallback', () => {
    it('agent action_handlers fires when step has no matching handler', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ACTION_AGENT], 'ActionInt_Agent'),
      );

      // Inject agent-level handlers
      session.agentIR!.action_handlers = [
        {
          action_id: 'opt_global',
          do: [{ set: { global_flag: 'yes' } }, { respond: 'Global handler response.' }],
        },
      ];

      await executor.initializeSession(session.id);

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, '', undefined, tc.callback, {
        actionEvent: { actionId: 'opt_global' },
      });

      expect(result.response).toContain('Global handler response.');
      expect(session.data.values.global_flag).toBe('yes');

      // Verify trace
      const handlerTraces = filterTraces(tc.traces, 'action_handler_executed');
      expect(handlerTraces.length).toBeGreaterThanOrEqual(1);
      expect(handlerTraces[0].data.source).toBe('agent');
      expect(handlerTraces[0].data.hasDo).toBe(true);
    });

    it('agent action_handlers with condition evaluates correctly', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ACTION_AGENT], 'ActionInt_Agent'),
      );

      // Set a session value that the condition depends on
      session.data.values.premium = true;

      // Agent handler with condition
      session.agentIR!.action_handlers = [
        {
          action_id: 'opt_premium',
          condition: 'premium == true',
          do: [{ respond: 'Premium handler fired.' }],
        },
        {
          action_id: 'opt_premium',
          do: [{ respond: 'Standard handler fired.' }],
        },
      ];

      await executor.initializeSession(session.id);

      const result = await executor.executeMessage(session.id, '', undefined, undefined, {
        actionEvent: { actionId: 'opt_premium' },
      });

      // Premium condition matches first
      expect(result.response).toContain('Premium handler fired.');
    });
  });

  describe('no handler at any level', () => {
    it('unmatched action at both levels falls through gracefully', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ACTION_AGENT], 'ActionInt_Agent'),
      );

      // Agent-level handlers exist but don't match
      session.agentIR!.action_handlers = [
        {
          action_id: 'other_action',
          do: [{ respond: 'Should not fire.' }],
        },
      ];

      await executor.initializeSession(session.id);

      // Send completely unknown action
      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'text', undefined, tc.callback, {
        actionEvent: { actionId: 'nonexistent' },
      });

      // No action_handler_executed trace
      const handlerTraces = filterTraces(tc.traces, 'action_handler_executed');
      expect(handlerTraces).toHaveLength(0);

      // Should still return a valid result (falls through to normal processing)
      expect(result).toBeDefined();
    });
  });
});
