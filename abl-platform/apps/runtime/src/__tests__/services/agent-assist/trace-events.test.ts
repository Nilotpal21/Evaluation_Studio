/**
 * Unit tests for agent_assist trace event helpers.
 *
 * Uses DI via setAgentAssistTraceEmitter — no mocking of platform packages.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  setAgentAssistTraceEmitter,
  emitReceived,
  emitBindingResolved,
  emitDelegated,
  emitTranslatedResponse,
  emitError,
  emitCallbackScheduled,
  emitCallbackDelivered,
  emitCallbackFailed,
} from '../../../services/agent-assist/trace-events.js';

describe('agent_assist trace events', () => {
  const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];

  beforeEach(() => {
    captured.length = 0;
    setAgentAssistTraceEmitter((type, payload) => {
      captured.push({ type, payload });
    });
  });

  const baseCtx = {
    tenantId: 'T1',
    projectId: 'P1',
    appId: 'aa-test',
    environment: 'dev',
  };

  it('emitReceived emits agent_assist.received with correct payload', () => {
    emitReceived({ ...baseCtx, messageId: 'msg_1', isAsync: false, streaming: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.received');
    expect(captured[0].payload).toMatchObject({
      tenantId: 'T1',
      messageId: 'msg_1',
      isAsync: false,
      streaming: true,
    });
  });

  it('emitBindingResolved emits agent_assist.binding_resolved', () => {
    emitBindingResolved({ ...baseCtx, bindingId: 'bk-1', bindingStatus: 'active' });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.binding_resolved');
    expect(captured[0].payload).toMatchObject({ bindingStatus: 'active' });
  });

  it('emitDelegated emits agent_assist.delegated', () => {
    emitDelegated({ ...baseCtx, sessionId: 's-1', runId: 'r-1', deploymentId: 'dep-1' });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.delegated');
    expect(captured[0].payload).toMatchObject({ sessionId: 's-1', runId: 'r-1' });
  });

  it('emitTranslatedResponse emits agent_assist.translated_response', () => {
    emitTranslatedResponse({
      ...baseCtx,
      sessionId: 's-1',
      runId: 'r-1',
      responseLength: 42,
      mode: 'sync',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.translated_response');
    expect(captured[0].payload).toMatchObject({ responseLength: 42, mode: 'sync' });
  });

  it('emitError emits agent_assist.error', () => {
    emitError({ ...baseCtx, errorCode: 'EXEC_FAIL', errorMessage: 'boom' });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.error');
    expect(captured[0].payload).toMatchObject({ errorCode: 'EXEC_FAIL' });
  });

  it('emitCallbackScheduled emits agent_assist.callback_scheduled', () => {
    emitCallbackScheduled({ ...baseCtx, runId: 'r-1', callbackUrl: 'https://example.com/cb' });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.callback_scheduled');
  });

  it('emitCallbackDelivered emits agent_assist.callback_delivered', () => {
    emitCallbackDelivered({
      ...baseCtx,
      runId: 'r-1',
      callbackUrl: 'https://example.com/cb',
      durationMs: 150,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.callback_delivered');
    expect(captured[0].payload).toMatchObject({ durationMs: 150 });
  });

  it('emitCallbackFailed emits agent_assist.callback_failed', () => {
    emitCallbackFailed({
      ...baseCtx,
      runId: 'r-1',
      callbackUrl: 'https://example.com/cb',
      reason: 'timeout',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('agent_assist.callback_failed');
    expect(captured[0].payload).toMatchObject({ reason: 'timeout' });
  });

  it('swallows exceptions from the emitter function', () => {
    setAgentAssistTraceEmitter(() => {
      throw new Error('boom');
    });
    // Should not throw
    emitReceived({ ...baseCtx, messageId: 'msg_2', isAsync: false, streaming: false });
  });
});
