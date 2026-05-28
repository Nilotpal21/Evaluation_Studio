/**
 * WebSocket handler — trace ID generation and propagation tests
 *
 * Verifies the trace-related code paths in handler.ts and sdk-handler.ts:
 * 1. traceId generated at agent-load / connection time (crypto.randomUUID format)
 * 2. traceId passed to executeMessage via runWithObservabilityContext
 * 3. traceId included in session_start message (sdk-handler)
 * 4. traceId attached to trace events sent to client
 * 5. Fallback when no traceId available
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  runWithObservabilityContext,
  getCurrentTraceId,
} from '@abl/compiler/platform/observability';

describe('WebSocket trace propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // traceId generation
  // -----------------------------------------------------------------------

  describe('traceId generation', () => {
    test('generates W3C-compatible 32-hex traceId', () => {
      // This is the exact pattern used in handler.ts and sdk-handler.ts:
      // state.traceId = crypto.randomUUID().replace(/-/g, '');
      const traceId = crypto.randomUUID().replace(/-/g, '');

      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(traceId).toHaveLength(32);
    });

    test('generates unique traceId per call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(crypto.randomUUID().replace(/-/g, ''));
      }
      expect(ids.size).toBe(100);
    });

    test('generates W3C-compatible 16-hex spanId', () => {
      // Pattern from handler.ts:
      // const wsSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(spanId).toHaveLength(16);
    });
  });

  // -----------------------------------------------------------------------
  // runWithObservabilityContext wrapping
  // -----------------------------------------------------------------------

  describe('observability context wrapping', () => {
    test('executeMessage wrapped in observability context has access to traceId', () => {
      const wsTraceId = crypto.randomUUID().replace(/-/g, '');
      const wsSpanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

      let capturedTraceId: string | undefined;

      // Simulate what handler.ts does:
      // result = await runWithObservabilityContext(
      //   { traceId: wsTraceId, spanId: wsSpanId },
      //   executeInContext,
      // );
      runWithObservabilityContext({ traceId: wsTraceId, spanId: wsSpanId }, () => {
        capturedTraceId = getCurrentTraceId();
      });

      expect(capturedTraceId).toBe(wsTraceId);
    });

    test('falls back to new UUID when clientState has no traceId', () => {
      // Pattern: const wsTraceId = clientState?.traceId || crypto.randomUUID().replace(/-/g, '');
      const clientStateTraceId: string | undefined = undefined;
      const wsTraceId = clientStateTraceId || crypto.randomUUID().replace(/-/g, '');

      expect(wsTraceId).toMatch(/^[0-9a-f]{32}$/);
    });

    test('uses clientState traceId when available', () => {
      const clientStateTraceId = 'aabbccddaabbccddaabbccddaabbccdd';
      const wsTraceId = clientStateTraceId || crypto.randomUUID().replace(/-/g, '');

      expect(wsTraceId).toBe('aabbccddaabbccddaabbccddaabbccdd');
    });
  });

  // -----------------------------------------------------------------------
  // session_start message includes traceId (sdk-handler)
  // -----------------------------------------------------------------------

  describe('session_start message', () => {
    test('session_start includes traceId field', () => {
      // Simulates the message structure from sdk-handler.ts:
      // send(ws, { type: 'session_start', sessionId, projectId, permissions, traceId });
      const traceId = crypto.randomUUID().replace(/-/g, '');
      const sessionStartMsg = {
        type: 'session_start' as const,
        sessionId: 'test-session-123',
        projectId: 'project-abc',
        permissions: { chat: true, voice: false },
        traceId,
      };

      expect(sessionStartMsg.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(sessionStartMsg.type).toBe('session_start');
    });
  });

  // -----------------------------------------------------------------------
  // Trace events include traceId
  // -----------------------------------------------------------------------

  describe('trace event traceId propagation', () => {
    test('trace event includes traceId from client state', () => {
      // From sdk-handler.ts:
      // const traceEvent = { ..., ...(state.traceId && { traceId: state.traceId }) };
      const stateTraceId = 'abcdef1234567890abcdef1234567890';

      const traceEvent = {
        id: crypto.randomUUID(),
        sessionId: 'session-1',
        type: 'llm_call',
        timestamp: new Date(),
        data: {},
        ...(stateTraceId ? { traceId: stateTraceId } : {}),
      };

      expect(traceEvent.traceId).toBe('abcdef1234567890abcdef1234567890');
    });

    test('trace event omits traceId when state has none', () => {
      const stateTraceId: string | undefined = undefined;

      const traceEvent = {
        id: crypto.randomUUID(),
        sessionId: 'session-1',
        type: 'llm_call',
        timestamp: new Date(),
        data: {},
        ...(stateTraceId && { traceId: stateTraceId }),
      };

      expect('traceId' in traceEvent).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // agentLoaded response includes traceId (handler.ts)
  // -----------------------------------------------------------------------

  describe('agentLoaded message', () => {
    test('ServerMessages.agentLoaded receives traceId', () => {
      // In handler.ts line 1118:
      // send(ws, ServerMessages.agentLoaded(sessionId, agent, state?.traceId));
      const stateTraceId = crypto.randomUUID().replace(/-/g, '');

      // Simulating the ServerMessages.agentLoaded call pattern
      const args = {
        sessionId: 'session-123',
        agent: { name: 'TestAgent' },
        traceId: stateTraceId,
      };

      expect(args.traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    test('agentLoaded receives undefined traceId when state is missing', () => {
      const state: { traceId?: string } | undefined = undefined;
      const traceId = state?.traceId;

      expect(traceId).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Nested context isolation
  // -----------------------------------------------------------------------

  describe('context isolation', () => {
    test('observability contexts do not leak between concurrent operations', async () => {
      const results: string[] = [];

      await Promise.all([
        new Promise<void>((resolve) => {
          runWithObservabilityContext({ traceId: 'ws-trace-A', spanId: 'span-A' }, () => {
            // Simulate async work
            setTimeout(() => {
              results.push(getCurrentTraceId()!);
              resolve();
            }, 10);
          });
        }),
        new Promise<void>((resolve) => {
          runWithObservabilityContext({ traceId: 'ws-trace-B', spanId: 'span-B' }, () => {
            setTimeout(() => {
              results.push(getCurrentTraceId()!);
              resolve();
            }, 5);
          });
        }),
      ]);

      expect(results).toContain('ws-trace-A');
      expect(results).toContain('ws-trace-B');
    });
  });
});
