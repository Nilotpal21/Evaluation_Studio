/**
 * ON_ERROR Sanitized Response — Slice 1 lock test (ABLP-412)
 *
 * Bruce feedback item 2.4 (security risk): when a tool fails with a raw error
 * containing credentials, internal IDs, or stack traces, the runtime must
 * NOT leak that detail into the user-facing response.
 *
 * Contract:
 *   - When the matching ON_ERROR handler has `respond: "..."`, the handler
 *     string wins — the raw error.message is dropped.
 *   - classifyToolError must never return subtype values that embed
 *     tenant/user/provider detail — subtypes are a fixed enum.
 *   - ErrorContext.message is for internal trace logging only. User surfaces
 *     receive handler.respond (sanitized at authoring time).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveErrorHandler,
  type ErrorContext,
} from '../services/execution/error-handler-router.js';
import { classifyToolError } from '../services/execution/tool-error-classifier.js';
import type { AgentIR } from '@abl/compiler';
import type { ErrorHandlingConfig, ErrorHandler } from '@abl/compiler/platform/ir/schema.js';

const SECRET_BEARING_MESSAGES = [
  'Authorization: Bearer sk-live-AbCd1234EfGh5678',
  'Failed to connect to mongodb://admin:s3cr3t@cluster.internal:27017/tenants',
  'stack: at Object.<anonymous> (/app/secrets/api-keys.json:42:17)',
  "tenant-prod-xyz: credential resolution failed for provider 'openai' with key ending in ...ab12",
];

const SUBTYPE_ENUM = new Set([
  'rate_limit',
  'auth_failure',
  'network_error',
  'tool_timeout',
  undefined,
]);

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

describe('ON_ERROR sanitized user-facing response (Slice 1 ABLP-412)', () => {
  describe('classifier output enum safety', () => {
    it.each(SECRET_BEARING_MESSAGES)(
      'classifyToolError returns only enum subtypes for secret-bearing message: %s',
      (msg) => {
        const out = classifyToolError(new Error(msg));
        expect(SUBTYPE_ENUM.has(out.subtype)).toBe(true);
      },
    );

    it('classifier never copies message content into subtype', () => {
      const out = classifyToolError(new Error('Bearer token abc123 expired'));
      // subtype must be enum value, NOT something derived from message
      const subtypeStr = out.subtype ?? '';
      expect(subtypeStr).not.toContain('abc123');
      expect(subtypeStr).not.toContain('Bearer');
      expect(SUBTYPE_ENUM.has(out.subtype)).toBe(true);
    });
  });

  describe('handler.respond wins over raw error', () => {
    it('matching handler with respond overrides raw error message for user surface', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'tool_error',
            subtypes: ['auth_failure'],
            then: 'continue',
            respond: "We're having trouble reaching that service. Please try again shortly.",
          }),
        ],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate', respond: 'Escalating.' }),
      });

      const rawErr = new Error('HTTP 401 Unauthorized — Bearer sk-live-AbCd1234 rejected');
      const { subtype, retryable } = classifyToolError(rawErr);
      const errorCtx: ErrorContext = {
        type: 'tool_error',
        subtype,
        message: rawErr.message,
        retryable,
      };

      const resolution = resolveErrorHandler(errorCtx, agentIR);

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBe(
        "We're having trouble reaching that service. Please try again shortly.",
      );
      // The sanitized response must not leak the secret-bearing raw message
      expect(resolution!.respond).not.toContain('sk-live');
      expect(resolution!.respond).not.toContain('Bearer');
    });

    it('handler without respond does NOT auto-fill raw error — respond stays undefined', () => {
      const agentIR = ir({
        handlers: [
          handler({
            type: 'tool_error',
            then: 'continue',
            // no respond field
          }),
        ],
        default_handler: handler({ type: 'DEFAULT', then: 'escalate' }),
      });

      const rawErr = new Error('Internal path: /srv/prod/secrets.json not readable');
      const { subtype, retryable } = classifyToolError(rawErr);
      const errorCtx: ErrorContext = {
        type: 'tool_error',
        subtype,
        message: rawErr.message,
        retryable,
      };

      const resolution = resolveErrorHandler(errorCtx, agentIR);

      expect(resolution).not.toBeNull();
      expect(resolution!.respond).toBeUndefined();
    });
  });
});
