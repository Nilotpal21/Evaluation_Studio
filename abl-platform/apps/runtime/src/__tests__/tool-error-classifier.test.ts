/**
 * Tool Error Classifier — Slice 1 lock test (ABLP-412)
 *
 * Bruce feedback item 2.4: error type classification is wired in reasoning-executor
 * only via hardcoded `type: 'tool_error'`. The existing arch-ai classifier buckets
 * errors into retriable / rate_limited / permanent but the runtime never consumed
 * it. This test locks the runtime-local classifier behavior:
 *
 *   classifyToolError(err) => {
 *     subtype: 'rate_limit' | 'auth_failure' | 'network_error' | 'tool_timeout' | undefined,
 *     retryable: boolean,
 *   }
 *
 * Undefined subtype means "no specific category" — caller falls back to type=tool_error.
 */

import { describe, it, expect } from 'vitest';
import { classifyToolError } from '../services/execution/tool-error-classifier.js';
import { ToolExecutionError } from '@agent-platform/shared-kernel';

describe('classifyToolError — pure function (Slice 1 ABLP-412)', () => {
  describe('rate limit classification', () => {
    it('classifies HTTP 429 message as rate_limit + retryable', () => {
      const out = classifyToolError(new Error('Request failed with status 429 Too Many Requests'));
      expect(out.subtype).toBe('rate_limit');
      expect(out.retryable).toBe(true);
    });

    it('classifies "rate limit exceeded" string as rate_limit', () => {
      const out = classifyToolError(new Error('Upstream API: rate limit exceeded'));
      expect(out.subtype).toBe('rate_limit');
      expect(out.retryable).toBe(true);
    });

    it('honors TOOL_RATE_LIMITED code from ToolExecutionError', () => {
      const err = new ToolExecutionError({
        code: 'TOOL_RATE_LIMITED',
        message: 'Rate limited',
        toolName: 't',
        retryable: true,
      });
      const out = classifyToolError(err);
      expect(out.subtype).toBe('rate_limit');
      expect(out.retryable).toBe(true);
    });
  });

  describe('auth failure classification', () => {
    it('classifies HTTP 401 as auth_failure + NOT retryable', () => {
      const out = classifyToolError(new Error('HTTP 401 Unauthorized'));
      expect(out.subtype).toBe('auth_failure');
      expect(out.retryable).toBe(false);
    });

    it('classifies HTTP 403 as auth_failure', () => {
      const out = classifyToolError(new Error('403 Forbidden — invalid credentials'));
      expect(out.subtype).toBe('auth_failure');
      expect(out.retryable).toBe(false);
    });

    it('honors TOOL_AUTH_FAILED code from ToolExecutionError', () => {
      const err = new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message: 'Auth failed',
        toolName: 't',
        retryable: false,
      });
      const out = classifyToolError(err);
      expect(out.subtype).toBe('auth_failure');
      expect(out.retryable).toBe(false);
    });
  });

  describe('network error classification', () => {
    it('classifies ECONNRESET as network_error + retryable', () => {
      const out = classifyToolError(new Error('socket ECONNRESET'));
      expect(out.subtype).toBe('network_error');
      expect(out.retryable).toBe(true);
    });

    it('classifies ECONNREFUSED as network_error', () => {
      const out = classifyToolError(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
      expect(out.subtype).toBe('network_error');
      expect(out.retryable).toBe(true);
    });

    it('classifies generic "network error" string', () => {
      const out = classifyToolError(new Error('network error: upstream unreachable'));
      expect(out.subtype).toBe('network_error');
      expect(out.retryable).toBe(true);
    });

    it('classifies HTTP 503/502 as network_error retryable', () => {
      expect(classifyToolError(new Error('503 Service Unavailable')).subtype).toBe('network_error');
      expect(classifyToolError(new Error('502 Bad Gateway')).subtype).toBe('network_error');
    });

    it('honors TOOL_NETWORK_ERROR code from ToolExecutionError', () => {
      const err = new ToolExecutionError({
        code: 'TOOL_NETWORK_ERROR',
        message: 'Net',
        toolName: 't',
        retryable: true,
      });
      expect(classifyToolError(err).subtype).toBe('network_error');
    });
  });

  describe('tool timeout classification', () => {
    it('classifies "timeout" message as tool_timeout + retryable', () => {
      const out = classifyToolError(new Error('Tool call timeout after 30000ms'));
      expect(out.subtype).toBe('tool_timeout');
      expect(out.retryable).toBe(true);
    });

    it('classifies ETIMEDOUT as tool_timeout', () => {
      const out = classifyToolError(new Error('ETIMEDOUT'));
      expect(out.subtype).toBe('tool_timeout');
      expect(out.retryable).toBe(true);
    });

    it('honors TOOL_TIMEOUT code from ToolExecutionError', () => {
      const err = new ToolExecutionError({
        code: 'TOOL_TIMEOUT',
        message: 'Timeout',
        toolName: 't',
        retryable: true,
      });
      expect(classifyToolError(err).subtype).toBe('tool_timeout');
    });
  });

  describe('ambiguous / unknown fallthrough', () => {
    it('returns undefined subtype for messages with no known pattern', () => {
      const out = classifyToolError(new Error('Unexpected token in JSON at position 42'));
      expect(out.subtype).toBeUndefined();
      // retryable defaults to false for permanent errors
      expect(out.retryable).toBe(false);
    });

    it('returns undefined subtype for plain string errors', () => {
      const out = classifyToolError('something weird happened');
      expect(out.subtype).toBeUndefined();
    });

    it('returns undefined subtype for null/undefined', () => {
      expect(classifyToolError(null).subtype).toBeUndefined();
      expect(classifyToolError(undefined).subtype).toBeUndefined();
    });
  });

  describe('conservative classification — ambiguous 429 from non-rate-limit APIs', () => {
    it('still classifies as rate_limit when message contains 429 — caller must use handler subtypes to disambiguate', () => {
      // APIs that abuse 429 for other reasons still land in rate_limit.
      // Handlers specify their own subtypes for precise matching.
      const out = classifyToolError(new Error('429: custom API quota exhausted'));
      expect(out.subtype).toBe('rate_limit');
    });
  });

  describe('ToolExecutionError code precedence over message', () => {
    it('TOOL_TIMEOUT code wins even if message mentions "unauthorized"', () => {
      const err = new ToolExecutionError({
        code: 'TOOL_TIMEOUT',
        message: 'timeout after unauthorized check',
        toolName: 't',
        retryable: true,
      });
      expect(classifyToolError(err).subtype).toBe('tool_timeout');
    });
  });

  describe('regex false-positive guards (Round 2 audit tightening)', () => {
    it('does NOT classify "social network" in error message as network_error', () => {
      // Bare /network/ would have matched. Tightened pattern requires
      // network\s*(?:error|failure|unreachable) so innocent uses pass through.
      const out = classifyToolError(new Error('Social network integration succeeded'));
      expect(out.subtype).toBeUndefined();
    });

    it('does NOT classify "neural network" mention as network_error', () => {
      const out = classifyToolError(new Error('neural network model batch processing completed'));
      expect(out.subtype).toBeUndefined();
    });

    it('DOES classify "network error" as network_error', () => {
      expect(classifyToolError(new Error('network error: upstream unreachable')).subtype).toBe(
        'network_error',
      );
      expect(classifyToolError(new Error('network failure mid-request')).subtype).toBe(
        'network_error',
      );
    });
  });
});
