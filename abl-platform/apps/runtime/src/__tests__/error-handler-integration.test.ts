/**
 * Error Handler Router Integration Tests
 *
 * Tests resolveErrorHandler and error routing for non-tool errors.
 * Verifies handler matching, action resolution, and retry scheduling.
 *
 * INT-3: resolveErrorHandler for non-tool errors (validation_error, unknown_error)
 * INT-12: Error handler with `then: escalate` action
 */

import { describe, it, expect } from 'vitest';
import {
  resolveErrorHandler,
  calculateRetryDelays,
  executeWithRetry,
} from '../services/execution/error-handler-router.js';
import type { ErrorContext, ErrorResolution } from '../services/execution/error-handler-router.js';
import type { AgentIR } from '@abl/compiler';
import type { ErrorHandlingConfig, ErrorHandler } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

function createAgentIR(errorHandling?: ErrorHandlingConfig): AgentIR {
  return {
    name: 'test-agent',
    identity: { goal: 'test' },
    error_handling: errorHandling,
  } as unknown as AgentIR;
}

function createHandler(
  overrides: Partial<ErrorHandler> & { type: string; then: ErrorHandler['then'] },
): ErrorHandler {
  return {
    ...overrides,
  } as ErrorHandler;
}

// =============================================================================
// TESTS
// =============================================================================

describe('ErrorHandlerRouter', () => {
  describe('INT-3: resolveErrorHandler for non-tool errors', () => {
    it('matches validation_error handler by type', () => {
      const ir = createAgentIR({
        handlers: [
          createHandler({
            type: 'validation_error',
            then: 'continue',
            respond: 'Please try again with valid input.',
            rich_content: { markdown: 'Please review the highlighted field.' } as any,
            voice_config: { plain_text: 'Please review the highlighted field.' } as any,
            actions: {
              elements: [{ id: 'retry', type: 'button', label: 'Try again' }],
            } as any,
          }),
        ],
        default_handler: createHandler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const errorCtx: ErrorContext = {
        type: 'validation_error',
        message: 'Field "email" failed validation',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('continue');
      expect(resolution!.respond).toBe('Please try again with valid input.');
      expect(resolution!.richContent).toEqual({ markdown: 'Please review the highlighted field.' });
      expect(resolution!.voiceConfig).toEqual({
        plain_text: 'Please review the highlighted field.',
      });
      expect(resolution!.actions).toEqual({
        elements: [{ id: 'retry', type: 'button', label: 'Try again' }],
      });
      expect(resolution!.handler.type).toBe('validation_error');
    });

    it('matches unknown_error handler by type', () => {
      const ir = createAgentIR({
        handlers: [createHandler({ type: 'unknown_error', then: 'escalate' })],
        default_handler: createHandler({ type: 'DEFAULT', then: 'complete' }),
      });

      const errorCtx: ErrorContext = {
        type: 'unknown_error',
        message: 'LLM call failed',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('escalate');
      expect(resolution!.handler.type).toBe('unknown_error');
    });

    it('matches handler by type + subtype (fine-grained)', () => {
      const ir = createAgentIR({
        handlers: [
          createHandler({
            type: 'validation_error',
            subtypes: ['max_retries_exceeded'],
            then: 'escalate',
            respond: 'Too many attempts. Connecting to an agent.',
          }),
          createHandler({
            type: 'validation_error',
            then: 'continue',
            respond: 'Try again.',
          }),
        ],
        default_handler: createHandler({ type: 'DEFAULT', then: 'complete' }),
      });

      const errorCtx: ErrorContext = {
        type: 'validation_error',
        subtype: 'max_retries_exceeded',
        message: 'Field "phone" failed 3 times',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('escalate');
      expect(resolution!.respond).toBe('Too many attempts. Connecting to an agent.');
    });

    it('falls back to DEFAULT handler when no type match', () => {
      const ir = createAgentIR({
        handlers: [createHandler({ type: 'tool_error', then: 'continue' })],
        default_handler: createHandler({
          type: 'DEFAULT',
          then: 'escalate',
          respond: 'Something went wrong.',
        }),
      });

      const errorCtx: ErrorContext = {
        type: 'unknown_error',
        message: 'unexpected error',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('escalate');
      expect(resolution!.handler.type).toBe('DEFAULT');
    });

    it('returns null when no error_handling config', () => {
      const ir = createAgentIR(undefined);

      const errorCtx: ErrorContext = {
        type: 'unknown_error',
        message: 'something failed',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).toBeNull();
    });

    it('includes step-level on_error handlers with priority', () => {
      const ir = createAgentIR({
        handlers: [createHandler({ type: 'validation_error', then: 'escalate' })],
        default_handler: createHandler({ type: 'DEFAULT', then: 'complete' }),
      });

      const stepHandler = createHandler({
        type: 'validation_error',
        then: 'continue',
        respond: 'Step-level recovery.',
      });

      const errorCtx: ErrorContext = {
        type: 'validation_error',
        message: 'invalid input',
        retryable: false,
        stepName: 'gather_info',
      };

      const resolution = resolveErrorHandler(errorCtx, ir, {
        on_error: [stepHandler],
      } as unknown as import('@abl/compiler/platform').FlowStep);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('continue');
      expect(resolution!.respond).toBe('Step-level recovery.');
    });
  });

  describe('INT-12: Error handler with escalate action', () => {
    it('returns escalate action for matching handler', () => {
      const ir = createAgentIR({
        handlers: [],
        default_handler: createHandler({
          type: 'DEFAULT',
          then: 'escalate',
          respond: 'Escalating to a human agent.',
        }),
      });

      const errorCtx: ErrorContext = {
        type: 'unknown_error',
        message: 'Unrecoverable LLM error',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('escalate');
      expect(resolution!.respond).toBe('Escalating to a human agent.');
    });

    it('returns handoff action with target', () => {
      const ir = createAgentIR({
        handlers: [
          createHandler({
            type: 'unknown_error',
            then: 'handoff',
            handoff_target: 'fallback_agent',
            respond: 'Transferring you to another agent.',
          }),
        ],
        default_handler: createHandler({ type: 'DEFAULT', then: 'complete' }),
      });

      const errorCtx: ErrorContext = {
        type: 'unknown_error',
        message: 'service unavailable',
        retryable: false,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.action).toBe('handoff');
      expect(resolution!.handoffTarget).toBe('fallback_agent');
    });
  });

  describe('retry scheduling', () => {
    it('calculates fixed retry delays', () => {
      const delays = calculateRetryDelays(3, 1000, 'fixed', 60_000);

      expect(delays).toEqual([1000, 1000, 1000]);
    });

    it('calculates exponential retry delays', () => {
      const delays = calculateRetryDelays(4, 500, 'exponential', 10_000);

      expect(delays).toEqual([500, 1000, 2000, 4000]);
    });

    it('caps exponential delays at maxDelay', () => {
      const delays = calculateRetryDelays(5, 1000, 'exponential', 5000);

      expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    });

    it('calculates linear retry delays', () => {
      const delays = calculateRetryDelays(3, 500, 'linear', 60_000);

      expect(delays).toEqual([500, 1000, 1500]);
    });

    it('builds resolution with retry config from handler', () => {
      const ir = createAgentIR({
        handlers: [
          createHandler({
            type: 'tool_error',
            then: 'continue',
            retry: 3,
            retry_delay_ms: 500,
            retry_backoff: 'exponential',
          }),
        ],
        default_handler: createHandler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const errorCtx: ErrorContext = {
        type: 'tool_error',
        message: 'timeout',
        retryable: true,
      };

      const resolution = resolveErrorHandler(errorCtx, ir);

      expect(resolution).not.toBeNull();
      expect(resolution!.retryCount).toBe(3);
      expect(resolution!.retryDelays).toEqual([500, 1000, 2000]);
    });
  });

  describe('executeWithRetry', () => {
    it('succeeds on first try without retry', async () => {
      const resolution: ErrorResolution = {
        handler: createHandler({ type: 'tool_error', then: 'continue' }),
        action: 'continue',
      };

      const result = await executeWithRetry(() => Promise.resolve('ok'), resolution);

      expect(result).toBe('ok');
    });

    it('retries and succeeds on second attempt', async () => {
      let attempts = 0;
      const fn = () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve('recovered');
      };

      const resolution: ErrorResolution = {
        handler: createHandler({ type: 'tool_error', then: 'continue' }),
        action: 'continue',
        retryCount: 2,
        retryDelays: [0, 0],
      };

      const retries: number[] = [];
      const result = await executeWithRetry(fn, resolution, (attempt) => retries.push(attempt));

      expect(result).toBe('recovered');
      expect(retries).toEqual([1]);
    });

    it('throws after retries exhausted', async () => {
      const fn = () => Promise.reject(new Error('persistent failure'));

      const resolution: ErrorResolution = {
        handler: createHandler({ type: 'tool_error', then: 'continue' }),
        action: 'continue',
        retryCount: 2,
        retryDelays: [0, 0],
      };

      await expect(executeWithRetry(fn, resolution)).rejects.toThrow('persistent failure');
    });

    it('respects abort signal', async () => {
      const controller = new AbortController();
      controller.abort(); // abort immediately

      const fn = () => Promise.reject(new Error('fail'));

      const resolution: ErrorResolution = {
        handler: createHandler({ type: 'tool_error', then: 'continue' }),
        action: 'continue',
        retryCount: 3,
        retryDelays: [100, 100, 100],
      };

      await expect(executeWithRetry(fn, resolution, undefined, controller.signal)).rejects.toThrow(
        'Retry aborted',
      );
    });
  });
});
