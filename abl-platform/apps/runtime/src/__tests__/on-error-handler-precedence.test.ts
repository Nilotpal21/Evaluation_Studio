/**
 * ON_ERROR Handler Precedence — Slice 1 lock test (ABLP-412)
 *
 * Bruce feedback item 2.4: the runtime never classified tool errors into
 * subtypes like rate_limit/auth_failure/network_error/tool_timeout. Once
 * classification is wired, handler precedence matters:
 *
 *   subtype match > type match > DEFAULT
 *
 * These tests exercise the full error-context→resolution path (router)
 * with classifier-produced subtypes, locking the precedence contract.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveErrorHandler,
  type ErrorContext,
} from '../services/execution/error-handler-router.js';
import { classifyToolError } from '../services/execution/tool-error-classifier.js';
import type { AgentIR } from '@abl/compiler';
import type { ErrorHandlingConfig, ErrorHandler } from '@abl/compiler/platform/ir/schema.js';

function ir(errorHandling?: ErrorHandlingConfig): AgentIR {
  return {
    name: 'test-agent',
    identity: { goal: 'test' },
    error_handling: errorHandling,
  } as unknown as AgentIR;
}

function handler(
  overrides: Partial<ErrorHandler> & { type: string; then: ErrorHandler['then'] },
): ErrorHandler {
  return { ...overrides } as ErrorHandler;
}

function contextFromError(err: unknown): ErrorContext {
  const { subtype, retryable } = classifyToolError(err);
  return {
    type: 'tool_error',
    subtype,
    message: err instanceof Error ? err.message : String(err),
    retryable,
  };
}

describe('ON_ERROR handler precedence (Slice 1 ABLP-412)', () => {
  describe('subtype > type > DEFAULT', () => {
    it('subtype-specific handler beats plain type handler', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'tool_error',
            subtypes: ['rate_limit'],
            then: 'continue',
            respond: 'Slow down — retrying.',
          }),
          handler({
            type: 'tool_error',
            then: 'continue',
            respond: 'Generic tool error.',
          }),
        ],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const resolution = resolveErrorHandler(
        contextFromError(new Error('429 Too Many Requests')),
        agentIR,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Slow down — retrying.');
      expect(resolution!.handler.subtypes).toEqual(['rate_limit']);
    });

    it('plain type handler matches when no subtype-specific handler exists', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'tool_error',
            then: 'continue',
            respond: 'Generic tool error.',
          }),
        ],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate', respond: 'Escalate' }),
      });

      const resolution = resolveErrorHandler(
        contextFromError(new Error('HTTP 401 Unauthorized')),
        agentIR,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Generic tool error.');
    });

    it('DEFAULT handler is last resort when no type handler matches', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'validation_error',
            then: 'continue',
            respond: 'Validation issue.',
          }),
        ],
        default_handler: handler({
          type: 'DEFAULT',
          then: 'escalate',
          respond: 'Catch-all escalation.',
        }),
      });

      const resolution = resolveErrorHandler(
        contextFromError(new Error('timeout after 30000ms')),
        agentIR,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Catch-all escalation.');
      expect(resolution!.handler.type).toBe('DEFAULT');
    });
  });

  describe('step-level precedence', () => {
    it('step on_error handler beats agent-level handler for same type', () => {
      const agentIR = ir({
        handlers: [handler({ type: 'tool_error', then: 'escalate', respond: 'Agent-level' })],
        default_handler: handler({ type: 'DEFAULT', then: 'complete' }),
      });

      const stepHandler = handler({
        type: 'tool_error',
        then: 'continue',
        respond: 'Step-level recovery.',
      });

      const resolution = resolveErrorHandler(
        { ...contextFromError(new Error('timeout')), stepName: 'call_tool' },
        agentIR,
        { on_error: [stepHandler] } as unknown as import('@abl/compiler/platform').FlowStep,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Step-level recovery.');
    });

    it('step subtype handler beats step type handler', () => {
      const agentIR = ir({
        handlers: [],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const stepHandlers: ErrorHandler[] = [
        handler({
          type: 'tool_error',
          subtypes: ['auth_failure'],
          then: 'handoff',
          handoff_target: 'Auth_Support',
          respond: 'Transferring for auth.',
        }),
        handler({
          type: 'tool_error',
          then: 'continue',
          respond: 'Generic step.',
        }),
      ];

      const resolution = resolveErrorHandler(
        { ...contextFromError(new Error('HTTP 401')), stepName: 'call_tool' },
        agentIR,
        { on_error: stepHandlers } as unknown as import('@abl/compiler/platform').FlowStep,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Transferring for auth.');
      expect(resolution!.action).toBe('handoff');
      expect(resolution!.handoffTarget).toBe('Auth_Support');
    });
  });

  describe('unknown subtype fallthrough', () => {
    it('falls through to type handler when classifier returns undefined subtype', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'tool_error',
            subtypes: ['rate_limit'],
            then: 'continue',
            respond: 'Subtype-specific.',
          }),
          handler({
            type: 'tool_error',
            then: 'continue',
            respond: 'Generic fallback.',
          }),
        ],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const resolution = resolveErrorHandler(
        contextFromError(new Error('JSON parse error: Unexpected token at position 42')),
        agentIR,
      );

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe('Generic fallback.');
    });
  });
});
