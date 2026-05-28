/**
 * Unit tests for WorkflowCallbackHandler — push callback processing for async workflow executions.
 *
 * Tests HMAC verification delegation, Zod validation, Redis persistence, system message formatting,
 * session injection, WS broadcast, and error handling. All dependencies injected via constructor config.
 *
 * No mocks of platform components.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowCallbackHandler,
  type WorkflowCallbackHandlerConfig,
  type WorkflowCallbackPayload,
} from '../services/workflow/workflow-callback-handler.js';

// ─── Stubs ───────────────────────────────────────────────────────────────────

function createRedisStub() {
  return {
    set: vi.fn().mockResolvedValue('OK') as ReturnType<typeof vi.fn>,
  };
}

function createMessageStoreStub() {
  return {
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  };
}

function createWsManagerStub() {
  return {
    broadcastToSession: vi.fn().mockReturnValue(1),
  };
}

function createConfig(
  overrides: Partial<WorkflowCallbackHandlerConfig> = {},
): WorkflowCallbackHandlerConfig {
  return {
    redis: createRedisStub(),
    messageStore: createMessageStoreStub(),
    internalWsManager:
      createWsManagerStub() as unknown as WorkflowCallbackHandlerConfig['internalWsManager'],
    sdkWsManager: createWsManagerStub() as unknown as WorkflowCallbackHandlerConfig['sdkWsManager'],
    internalSecret: 'test-secret-key',
    ...overrides,
  };
}

function validPayload(overrides: Partial<WorkflowCallbackPayload> = {}): WorkflowCallbackPayload {
  return {
    executionId: 'exec-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    workflowId: 'wf-1',
    workflowName: 'Test Workflow',
    status: 'completed',
    output: { result: 'success' },
    source: 'agent_tool',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowCallbackHandler', () => {
  // ── Zod Validation ──

  describe('handleCallback — validation', () => {
    it('rejects payload missing required fields', async () => {
      const handler = new WorkflowCallbackHandler(createConfig());
      const result = await handler.handleCallback({ executionId: 'exec-1' });
      expect(result.injected).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects payload with wrong source', async () => {
      const handler = new WorkflowCallbackHandler(createConfig());
      const result = await handler.handleCallback({
        ...validPayload(),
        source: 'webhook',
      });
      expect(result.injected).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects payload with empty executionId', async () => {
      const handler = new WorkflowCallbackHandler(createConfig());
      const result = await handler.handleCallback({
        ...validPayload(),
        executionId: '',
      });
      expect(result.injected).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('accepts payload without optional output', async () => {
      const cfg = createConfig();
      const handler = new WorkflowCallbackHandler(cfg);
      const payload = validPayload();
      delete (payload as Record<string, unknown>).output;
      const result = await handler.handleCallback(payload);
      expect(result.injected).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts payload with error object', async () => {
      const cfg = createConfig();
      const handler = new WorkflowCallbackHandler(cfg);
      const result = await handler.handleCallback(
        validPayload({
          status: 'failed',
          error: { code: 'WORKFLOW_FAILED', message: 'step timeout' },
        }),
      );
      expect(result.injected).toBe(true);
    });
  });

  // ── Redis Persistence ──

  describe('handleCallback — Redis persistence', () => {
    it('persists result to Redis with correct key, TTL, and NX flag', async () => {
      const redis = createRedisStub();
      const handler = new WorkflowCallbackHandler(createConfig({ redis }));
      await handler.handleCallback(validPayload());

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl, nx] = redis.set.mock.calls[0];
      expect(key).toBe('workflow:tenant-1:proj-1:async-result:exec-1');
      expect(mode).toBe('EX');
      expect(ttl).toBe(24 * 3600); // default 24h TTL
      expect(nx).toBe('NX'); // idempotency dedup

      const parsed = JSON.parse(value as string);
      expect(parsed.status).toBe('completed');
      expect(parsed.output).toEqual({ result: 'success' });
      expect(parsed.workflowId).toBe('wf-1');
      expect(parsed.workflowName).toBe('Test Workflow');
      expect(parsed.completedAt).toBeDefined();
    });

    it('uses custom TTL when configured', async () => {
      const redis = createRedisStub();
      const handler = new WorkflowCallbackHandler(createConfig({ redis, asyncResultTtlHours: 48 }));
      await handler.handleCallback(validPayload());

      const [, , , ttl] = redis.set.mock.calls[0];
      expect(ttl).toBe(48 * 3600);
    });

    it('continues processing when Redis write fails', async () => {
      const redis = { set: vi.fn().mockRejectedValue(new Error('Redis down')) };
      const messageStore = createMessageStoreStub();
      const handler = new WorkflowCallbackHandler(createConfig({ redis, messageStore }));
      const result = await handler.handleCallback(validPayload());

      // Should still inject message despite Redis failure
      expect(result.injected).toBe(true);
      expect(messageStore.addMessage).toHaveBeenCalledTimes(1);
    });

    it('skips injection and broadcast on duplicate callback (SETNX returns null)', async () => {
      const redis = { set: vi.fn().mockResolvedValue(null) };
      const messageStore = createMessageStoreStub();
      const internalWs = createWsManagerStub();
      const sdkWs = createWsManagerStub();
      const handler = new WorkflowCallbackHandler(
        createConfig({
          redis,
          messageStore,
          internalWsManager:
            internalWs as unknown as WorkflowCallbackHandlerConfig['internalWsManager'],
          sdkWsManager: sdkWs as unknown as WorkflowCallbackHandlerConfig['sdkWsManager'],
        }),
      );
      const result = await handler.handleCallback(validPayload());

      expect(result.injected).toBe(false);
      expect(result.duplicate).toBe(true);
      expect(messageStore.addMessage).not.toHaveBeenCalled();
      expect(internalWs.broadcastToSession).not.toHaveBeenCalled();
      expect(sdkWs.broadcastToSession).not.toHaveBeenCalled();
    });
  });

  // ── System Message Formatting ──

  describe('handleCallback — message formatting', () => {
    it('formats completed workflow message', async () => {
      const messageStore = createMessageStoreStub();
      const handler = new WorkflowCallbackHandler(createConfig({ messageStore }));
      await handler.handleCallback(validPayload());

      const msg = messageStore.addMessage.mock.calls[0][0];
      expect(msg.content).toContain('[Workflow Complete]');
      expect(msg.content).toContain('exec-1');
      expect(msg.content).toContain('Test Workflow');
      expect(msg.content).toContain('completed successfully');
      expect(msg.content).toContain('"result":"success"');
    });

    it('formats failed workflow message', async () => {
      const messageStore = createMessageStoreStub();
      const handler = new WorkflowCallbackHandler(createConfig({ messageStore }));
      await handler.handleCallback(
        validPayload({
          status: 'failed',
          error: { code: 'STEP_TIMEOUT', message: 'HTTP step timed out' },
        }),
      );

      const msg = messageStore.addMessage.mock.calls[0][0];
      expect(msg.content).toContain('[Workflow Failed]');
      expect(msg.content).toContain('exec-1');
      expect(msg.content).toContain('STEP_TIMEOUT');
      expect(msg.content).toContain('HTTP step timed out');
    });

    it('truncates large output in system message', async () => {
      const messageStore = createMessageStoreStub();
      const handler = new WorkflowCallbackHandler(createConfig({ messageStore }));

      const largeOutput: Record<string, unknown> = {};
      for (let i = 0; i < 500; i++) {
        largeOutput[`key_${i}`] = `value_${'x'.repeat(50)}_${i}`;
      }

      await handler.handleCallback(validPayload({ output: largeOutput }));

      const msg = messageStore.addMessage.mock.calls[0][0];
      expect(msg.content).toContain('[truncated]');
      // Message should not exceed ~2200 chars (2000 for output + overhead)
      expect(msg.content.length).toBeLessThan(2500);
    });
  });

  // ── Session Message Injection ──

  describe('handleCallback — session injection', () => {
    it('injects system message with correct parameters', async () => {
      const messageStore = createMessageStoreStub();
      const handler = new WorkflowCallbackHandler(createConfig({ messageStore }));
      await handler.handleCallback(validPayload());

      expect(messageStore.addMessage).toHaveBeenCalledTimes(1);
      const params = messageStore.addMessage.mock.calls[0][0];
      expect(params.sessionId).toBe('session-1');
      expect(params.role).toBe('system');
      expect(params.channel).toBe('api');
      expect(params.traceId).toBe('exec-1');
      expect(params.tenantId).toBe('tenant-1');
      expect(params.projectId).toBe('proj-1');
    });

    it('returns injected=false when message store fails', async () => {
      const messageStore = {
        addMessage: vi.fn().mockRejectedValue(new Error('Session not found')),
      };
      const handler = new WorkflowCallbackHandler(createConfig({ messageStore }));
      const result = await handler.handleCallback(validPayload());

      expect(result.injected).toBe(false);
      expect(result.error).toBeUndefined(); // Not a validation error, just inactive session
    });
  });

  // ── WebSocket Broadcast ──

  describe('handleCallback — WS broadcast', () => {
    it('broadcasts to both internal and SDK WS managers', async () => {
      const internalWs = createWsManagerStub();
      const sdkWs = createWsManagerStub();
      const handler = new WorkflowCallbackHandler(
        createConfig({
          internalWsManager:
            internalWs as unknown as WorkflowCallbackHandlerConfig['internalWsManager'],
          sdkWsManager: sdkWs as unknown as WorkflowCallbackHandlerConfig['sdkWsManager'],
        }),
      );
      await handler.handleCallback(validPayload());

      expect(internalWs.broadcastToSession).toHaveBeenCalledWith(
        'session-1',
        'workflow.result',
        expect.objectContaining({
          type: 'workflow.result',
          executionId: 'exec-1',
          workflowId: 'wf-1',
          status: 'completed',
        }),
        'tenant-1', // tenant filtering (GAP-006)
      );
      expect(sdkWs.broadcastToSession).toHaveBeenCalledWith(
        'session-1',
        'workflow.result',
        expect.objectContaining({ type: 'workflow.result' }),
        'tenant-1', // tenant filtering (GAP-006)
      );
    });
  });

  // ── HMAC Verification ──

  describe('verifyHmac', () => {
    it('delegates to verifyWebhookSignature with the internal secret', () => {
      const handler = new WorkflowCallbackHandler(createConfig());
      // With an incorrect signature, verification should fail
      const result = handler.verifyHmac('{"test":true}', 'invalid-sig', String(Date.now()));
      expect(result).toBe(false);
    });
  });
});
