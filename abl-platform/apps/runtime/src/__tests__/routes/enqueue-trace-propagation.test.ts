/**
 * Enqueue trace propagation tests
 *
 * Verifies that traceId and full span context are injected into BullMQ
 * job payloads at the enqueue sites for:
 * - channel-webhooks.ts
 * - http-async-channel.ts
 * - smtp-server.ts
 *
 * All three files follow the same pattern:
 *   jobPayload.traceId = getCurrentTraceId();
 *   const obsCtx = getObservabilityContext();
 *   if (obsCtx) { injectTrace(jobPayload, { traceId: obsCtx.traceId, spanId: obsCtx.spanId }); }
 *
 * We test this pattern directly since the actual route handlers are complex
 * and require extensive infrastructure mocking.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  runWithObservabilityContext,
  getCurrentTraceId,
  getObservabilityContext,
} from '@abl/compiler/platform/observability';
import { injectTrace, extractTrace } from '@agent-platform/shared-observability/tracing';

describe('Enqueue trace propagation pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Simulates the exact pattern used in channel-webhooks.ts, http-async-channel.ts,
   * and smtp-server.ts for injecting trace context into job payloads.
   */
  function simulateEnqueueTraceInjection(): Record<string, unknown> {
    const jobPayload: Record<string, unknown> = {
      connectionId: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      channelType: 'slack',
      message: { text: 'hello' },
      subscriptionId: 'sub-1',
      idempotencyKey: 'key-1',
      traceId: getCurrentTraceId(),
    };

    const obsCtx = getObservabilityContext();
    if (obsCtx) {
      injectTrace(jobPayload as Record<string, unknown>, {
        traceId: obsCtx.traceId,
        spanId: obsCtx.spanId,
      });
    }

    return jobPayload;
  }

  test('traceId is set from getCurrentTraceId() when inside observability context', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext(
      { traceId: 'webhook-trace-123', spanId: 'webhook-span-456' },
      () => {
        payload = simulateEnqueueTraceInjection();
      },
    );

    expect(payload['traceId']).toBe('webhook-trace-123');
  });

  test('full span context injected via injectTrace when obsCtx exists', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext(
      { traceId: 'webhook-trace-abc', spanId: 'webhook-span-def' },
      () => {
        payload = simulateEnqueueTraceInjection();
      },
    );

    expect(payload['__traceId']).toBe('webhook-trace-abc');
    expect(payload['__spanId']).toBe('webhook-span-def');
  });

  test('extractTrace can recover injected span context from job payload', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext({ traceId: 'roundtrip-trace', spanId: 'roundtrip-span' }, () => {
      payload = simulateEnqueueTraceInjection();
    });

    const extracted = extractTrace(payload);
    expect(extracted).toEqual({
      traceId: 'roundtrip-trace',
      spanId: 'roundtrip-span',
    });
  });

  test('traceId is undefined when outside observability context', () => {
    const payload = simulateEnqueueTraceInjection();

    expect(payload['traceId']).toBeUndefined();
    // injectTrace should not be called (obsCtx is undefined)
    expect(payload['__traceId']).toBeUndefined();
    expect(payload['__spanId']).toBeUndefined();
  });

  test('pattern works for channel-webhooks (slack example)', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext({ traceId: 'slack-trace', spanId: 'slack-span' }, () => {
      payload = {
        connectionId: 'conn-slack',
        tenantId: 'tenant-slack',
        channelType: 'slack',
        traceId: getCurrentTraceId(),
      };
      const obsCtx = getObservabilityContext();
      if (obsCtx) {
        injectTrace(payload, { traceId: obsCtx.traceId, spanId: obsCtx.spanId });
      }
    });

    expect(payload['traceId']).toBe('slack-trace');
    expect(payload['__traceId']).toBe('slack-trace');
  });

  test('pattern works for http-async-channel', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext({ traceId: 'http-async-trace', spanId: 'http-async-span' }, () => {
      payload = {
        connectionId: 'conn-http',
        channelType: 'http_async',
        traceId: getCurrentTraceId(),
      };
      const obsCtx = getObservabilityContext();
      if (obsCtx) {
        injectTrace(payload, { traceId: obsCtx.traceId, spanId: obsCtx.spanId });
      }
    });

    expect(payload['traceId']).toBe('http-async-trace');
    expect(extractTrace(payload)).toEqual({
      traceId: 'http-async-trace',
      spanId: 'http-async-span',
    });
  });

  test('pattern works for smtp-server (email)', () => {
    let payload: Record<string, unknown> = {};
    runWithObservabilityContext({ traceId: 'email-trace', spanId: 'email-span' }, () => {
      payload = {
        connectionId: 'conn-email',
        channelType: 'email',
        traceId: getCurrentTraceId(),
      };
      const obsCtx = getObservabilityContext();
      if (obsCtx) {
        injectTrace(payload, { traceId: obsCtx.traceId, spanId: obsCtx.spanId });
      }
    });

    expect(payload['traceId']).toBe('email-trace');
    expect(extractTrace(payload)).toEqual({
      traceId: 'email-trace',
      spanId: 'email-span',
    });
  });
});
