/**
 * ACTION_HANDLERS E2E Tests
 *
 * Tests agent-level ACTION_HANDLERS dispatch through the full RuntimeExecutor stack.
 * Uses DSL-compiled agents with FLOW steps and action buttons.
 *
 * Verifies:
 * - Step-level ON_ACTION dispatches as before (regression guard)
 * - Agent-level ACTION_HANDLERS fires when step-level has no match
 * - Step-level takes priority over agent-level (same action_id defined in both)
 * - action_handler_executed trace event emitted with source and action details
 * - Agent-level handler with SET/RESPOND/TRANSITION executes correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ActionHandlerIR } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// DSL FIXTURES
// =============================================================================

/** Agent with step-level ON_ACTION only */
const STEP_LEVEL_AGENT = `
AGENT: StepAction_Agent
GOAL: "Test step-level action handlers"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  REASONING: false
  RESPOND: "Click a button"
    ACTIONS:
      - BUTTON: "Confirm" -> btn_confirm
      - BUTTON: "Cancel" -> btn_cancel
  ON_ACTION:
    btn_confirm:
      SET: result = confirmed
      RESPOND: "Confirmed via step handler!"
      TRANSITION: done
    btn_cancel:
      RESPOND: "Cancelled."
      TRANSITION: done

done:
  REASONING: false
  RESPOND: "All done. result={{result}}"
  THEN: COMPLETE
`;

/** Agent with step-level actions and ON_ACTION — for testing agent-level fallback */
const AGENT_LEVEL_FALLBACK = `
AGENT: AgentFallback_Agent
GOAL: "Test agent-level action handler fallback"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  REASONING: false
  RESPOND: "Click a button"
    ACTIONS:
      - BUTTON: "Help" -> btn_help
  ON_ACTION:
    btn_help:
      RESPOND: "Step-level help."

done:
  REASONING: false
  RESPOND: "Done."
  THEN: COMPLETE
`;

// =============================================================================
// TESTS
// =============================================================================

describe('ACTION_HANDLERS E2E', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('step-level ON_ACTION (regression guard)', () => {
    it('step-level handler dispatches SET/RESPOND/TRANSITION', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([STEP_LEVEL_AGENT], 'StepAction_Agent'),
      );

      // Initialize — sends RESPOND + ACTIONS, pauses waiting for action
      await executor.initializeSession(session.id);

      // Send action event for btn_confirm — capture chunks for handler RESPOND
      const chunks: string[] = [];
      const tc = createTraceCollector();
      const result = await executor.executeMessage(
        session.id,
        '',
        (c) => chunks.push(c),
        tc.callback,
        { actionEvent: { actionId: 'btn_confirm' } },
      );

      // Step handler should have fired: SET applied, RESPOND in chunks
      expect(session.data.values.result).toBe('confirmed');
      const allOutput = chunks.join('');
      expect(allOutput).toContain('Confirmed via step handler!');

      // After transition to 'done', result.response has the done step output
      expect(result.response).toContain('result=confirmed');

      // action_handler_executed trace event
      const handlerTraces = filterTraces(tc.traces, 'action_handler_executed');
      expect(handlerTraces.length).toBeGreaterThanOrEqual(1);
      expect(handlerTraces[0].data.source).toBe('step');
      expect(handlerTraces[0].data.actionId).toBe('btn_confirm');
    });
  });

  describe('agent-level ACTION_HANDLERS fallback', () => {
    it('agent-level handler fires when step-level has no match', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_LEVEL_FALLBACK], 'AgentFallback_Agent'),
      );

      // Inject agent-level action_handlers for an action_id not in step ON_ACTION
      const agentHandlers: ActionHandlerIR[] = [
        {
          action_id: 'btn_global',
          do: [
            { set: { global_handled: 'true' } },
            { respond: 'Agent-level global handler fired!' },
          ],
        },
      ];
      session.agentIR!.action_handlers = agentHandlers;

      // Initialize session — step has ON_ACTION for btn_help, pauses waiting
      await executor.initializeSession(session.id);

      // Send btn_global — NOT in step.on_action → falls back to agent-level
      const chunks: string[] = [];
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '', (c) => chunks.push(c), tc.callback, {
        actionEvent: { actionId: 'btn_global' },
      });

      // Agent-level handler should have fired
      const allOutput = chunks.join('');
      expect(allOutput).toContain('Agent-level global handler fired!');
      expect(session.data.values.global_handled).toBe(true);

      // Trace event should show source = 'agent'
      const handlerTraces = filterTraces(tc.traces, 'action_handler_executed');
      expect(handlerTraces.length).toBeGreaterThanOrEqual(1);
      expect(handlerTraces[0].data.source).toBe('agent');
      expect(handlerTraces[0].data.actionId).toBe('btn_global');
      expect(handlerTraces[0].data.hasDo).toBe(true);
    });

    it('step-level takes priority over agent-level for same action_id', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_LEVEL_FALLBACK], 'AgentFallback_Agent'),
      );

      // Inject agent-level handler for btn_help (same as step-level)
      session.agentIR!.action_handlers = [
        {
          action_id: 'btn_help',
          do: [{ respond: 'Agent-level help (should NOT fire).' }],
        },
      ];

      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const tc = createTraceCollector();
      await executor.executeMessage(session.id, '', (c) => chunks.push(c), tc.callback, {
        actionEvent: { actionId: 'btn_help' },
      });

      // Step-level should win
      const allOutput = chunks.join('');
      expect(allOutput).toContain('Step-level help.');
      expect(allOutput).not.toContain('Agent-level help');

      const handlerTraces = filterTraces(tc.traces, 'action_handler_executed');
      if (handlerTraces.length > 0) {
        expect(handlerTraces[0].data.source).toBe('step');
      }
    });
  });

  describe('agent-level handler with transition', () => {
    it('agent-level handler TRANSITION moves to target step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([AGENT_LEVEL_FALLBACK], 'AgentFallback_Agent'),
      );

      // Inject agent-level handler with transition
      session.agentIR!.action_handlers = [
        {
          action_id: 'btn_skip',
          do: [{ respond: 'Skipping to done.' }, { goto: 'done' }],
        },
      ];

      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, '', (c) => chunks.push(c), undefined, {
        actionEvent: { actionId: 'btn_skip' },
      });

      // Handler RESPOND + transition to 'done' step
      const allOutput = chunks.join('');
      expect(allOutput).toContain('Skipping to done.');
      expect(allOutput).toContain('Done.');
    });
  });
});
