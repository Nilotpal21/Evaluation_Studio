/**
 * Agent ON_ERROR E2E Tests
 *
 * Tests ON_ERROR handler routing through the full RuntimeExecutor stack.
 * Uses mock LLM client to trigger controlled errors and verify routing.
 * Error handling config is injected onto agentIR after session creation
 * to test the runtime wiring independent of DSL parser behavior.
 *
 * Verifies:
 * - unknown_error routed to matching ON_ERROR handler
 * - handler respond message returned to user
 * - default_handler with escalate action triggers escalation
 * - agent_error_handled trace event emitted
 * - No ON_ERROR config → error propagates normally
 * - Session remains usable after ON_ERROR continue action
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { injectMockClient } from './execution/pre-refactor/helpers/mock-llm-client.js';
import { createTraceCollector, filterTraces } from './helpers/history-validation.js';
import type { ErrorHandlingConfig } from '@abl/compiler/platform/ir/schema.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

// =============================================================================
// DSL FIXTURES
// =============================================================================

const BASIC_AGENT = `
AGENT: Error_Agent

GOAL: "Handle errors gracefully"
PERSONA: "Resilient assistant"
`;

// =============================================================================
// TESTS
// =============================================================================

describe('Agent ON_ERROR E2E', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('continue action', () => {
    it('unknown_error routed to ON_ERROR handler returns respond message', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new Error('LLM service unavailable');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Error_Agent'),
      );

      // Inject ON_ERROR config
      const errorHandling: ErrorHandlingConfig = {
        handlers: [
          {
            type: 'unknown_error',
            then: 'continue',
            respond: 'Something went wrong, but I can keep going.',
          },
        ],
        default_handler: {
          type: 'DEFAULT',
          then: 'escalate',
          respond: 'Escalating.',
        },
      };
      session.agentIR!.error_handling = errorHandling;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      // The ON_ERROR handler should have caught the error with continue action
      expect(result.response).toContain('Something went wrong, but I can keep going.');

      // Session should NOT be escalated or complete
      expect(session.isEscalated).toBe(false);
      expect(session.isComplete).toBe(false);

      // agent_error_handled trace event should be emitted
      const errorHandled = filterTraces(tc.traces, 'agent_error_handled');
      expect(errorHandled.length).toBeGreaterThanOrEqual(1);
      expect(errorHandled[0].data.errorType).toBe('unknown_error');
      expect(errorHandled[0].data.action).toBe('continue');
    });

    it('attaches banner-eligible configuration diagnostics for missing LLM credentials', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new AppError(
          "No credential found for provider 'openai' in tenant 'tenant-dev'. Configure a TenantModel with a connection or add an LLMCredential.",
          { ...ErrorCodes.SERVICE_UNAVAILABLE },
        );
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Error_Agent'),
      );

      session.agentIR!.error_handling = {
        handlers: [
          {
            type: 'unknown_error',
            then: 'continue',
            respond: 'Something went wrong, but I can keep going.',
          },
        ],
        default_handler: {
          type: 'DEFAULT',
          then: 'continue',
          respond: 'Error occurred.',
        },
      };

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      expect(result.response).toContain('Something went wrong, but I can keep going.');

      const errorHandled = filterTraces(tc.traces, 'agent_error_handled');
      expect(errorHandled).toHaveLength(1);
      expect(errorHandled[0].data.errorCode).toBe(ErrorCodes.SERVICE_UNAVAILABLE.code);
      expect(errorHandled[0].data.diagnostic).toEqual({
        category: 'llm',
        severity: 'error',
        code: 'LLM_CREDENTIAL_MISSING',
        message:
          "No credential found for provider 'openai' in tenant 'tenant-dev'. Configure a TenantModel with a connection or add an LLMCredential.",
        bannerEligible: true,
      });
    });
  });

  describe('escalate action', () => {
    it('default_handler with escalate action triggers escalation', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new Error('Critical failure in LLM');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Error_Agent'),
      );

      // Inject ON_ERROR config with only default_handler (escalate)
      const errorHandling: ErrorHandlingConfig = {
        handlers: [],
        default_handler: {
          type: 'DEFAULT',
          then: 'escalate',
          respond: 'I need to transfer you to a human agent.',
        },
      };
      session.agentIR!.error_handling = errorHandling;

      const tc = createTraceCollector();
      const result = await executor.executeMessage(session.id, 'Hello', undefined, tc.callback);

      // The ON_ERROR default_handler should have escalated
      expect(result.response).toContain('I need to transfer you to a human agent.');

      // Session should be marked as escalated
      expect(session.data.values._escalated).toBe(true);

      // agent_error_handled trace event should show escalate action
      const errorHandled = filterTraces(tc.traces, 'agent_error_handled');
      expect(errorHandled.length).toBeGreaterThanOrEqual(1);
      expect(errorHandled[0].data.action).toBe('escalate');
    });
  });

  describe('no ON_ERROR config', () => {
    it('error propagates normally when no ON_ERROR handlers defined', async () => {
      const mockClient = injectMockClient(executor);
      mockClient.setResponseHandler(() => {
        throw new Error('Unhandled LLM error');
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Error_Agent'),
      );

      // Clear error handling to test raw propagation
      session.agentIR!.error_handling = undefined as unknown as ErrorHandlingConfig;

      const tc = createTraceCollector();

      // Without ON_ERROR, the error should propagate
      await expect(
        executor.executeMessage(session.id, 'Hello', undefined, tc.callback),
      ).rejects.toThrow('Unhandled LLM error');

      // No agent_error_handled trace since there's no handler
      const errorHandled = filterTraces(tc.traces, 'agent_error_handled');
      expect(errorHandled).toHaveLength(0);
    });
  });

  describe('error recovery', () => {
    it('session remains usable after ON_ERROR continue action', async () => {
      const mockClient = injectMockClient(executor);
      let callCount = 0;
      mockClient.setResponseHandler(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient LLM error');
        }
        return {
          text: 'I can help now!',
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: 'I can help now!' }],
        };
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([BASIC_AGENT], 'Error_Agent'),
      );

      const errorHandling: ErrorHandlingConfig = {
        handlers: [
          {
            type: 'unknown_error',
            then: 'continue',
            respond: 'Something went wrong.',
          },
        ],
        default_handler: {
          type: 'DEFAULT',
          then: 'continue',
          respond: 'Error occurred.',
        },
      };
      session.agentIR!.error_handling = errorHandling;

      // First call fails — ON_ERROR handler catches it
      const result1 = await executor.executeMessage(session.id, 'Hello');
      expect(result1.response).toContain('Something went wrong');

      // Second call succeeds — session is still usable
      const result2 = await executor.executeMessage(session.id, 'Try again');
      expect(result2.response).toContain('I can help now!');
    });
  });
});
