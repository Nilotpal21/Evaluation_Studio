import { WebSocket as NodeWebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import type {
  AnyPlatformEvent,
  EventBus,
  PlatformEvent,
  SessionEndedPayload,
} from '../services/event-bus/types.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import {
  getRuntimeEventBus,
  setRuntimeEventBus,
} from '../services/event-bus/runtime-bus-accessor.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkBootstrapChannel,
  createSdkPublicKey,
  importProjectFiles,
  initSdkSession,
  provisionTenantModel,
  requestJson,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

const TIMEOUT_MS = 120_000;

const SIMPLE_AGENT_DSL = `AGENT: Simple_Chat_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

type SessionEndedEvent = PlatformEvent<'session.ended', SessionEndedPayload>;

function makeCollectorBus(events: AnyPlatformEvent[]): EventBus {
  return {
    emit(event) {
      events.push(event);
    },
    subscribe() {
      /* no-op */
    },
    unsubscribe() {
      /* no-op */
    },
    async shutdown() {
      /* no-op */
    },
  };
}

async function waitForEventTypeCount(
  events: AnyPlatformEvent[],
  type: string,
  expectedCount: number,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (events.filter((event) => event.type === type).length >= expectedCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${expectedCount} ${type} events`);
}

async function waitFor<T>(
  label: string,
  getValue: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value !== null && value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForSocketMessage(
  ws: NodeWebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };

    const onMessage = (data: NodeWebSocket.RawData) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      if (!predicate(parsed)) {
        return;
      }

      cleanup();
      resolve(parsed);
    };

    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before ${label}: code=${code} reason=${reason.toString('utf8')}`,
        ),
      );
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

async function waitForSocketClose(
  ws: NodeWebSocket,
  timeoutMs = 15_000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket close'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('close', onClose);
      ws.off('error', onError);
    };

    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString('utf8') });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

async function setupProject(
  harness: RuntimeApiHarness,
  mockLlm: MockLLM,
  prefix: string,
): Promise<BootstrapProjectResult & { publicKey: string }> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`sdk-terminalization-int-${prefix}`),
    uniqueSlug(`sdk-terminalization-int-tenant-${prefix}`),
    uniqueSlug(`sdk-terminalization-int-project-${prefix}`),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/simple-chat.agent.abl': SIMPLE_AGENT_DSL,
  });

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: `Mock SDK Terminalization Model ${prefix}`,
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'mock-model',
    endpointUrl: mockLlm.url,
    supportsStreaming: false,
    supportsTools: false,
    capabilities: ['text'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: `mock-sdk-terminalization-model-${prefix}`,
      apiKey: 'test-api-key',
    },
  });

  const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
    name: `SDK Terminalization Key ${prefix}`,
  });
  await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

  return {
    ...admin,
    publicKey: publicKey.key!,
  };
}

async function updateProjectSessionLifecycle(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await requestJson<{ success: boolean }>(
    harness,
    `/api/projects/${projectId}/session-lifecycle`,
    {
      method: 'PATCH',
      headers: authHeaders(token),
      body,
    },
  );

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
}

describe('Session Terminalization SDK Integration', () => {
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;
  let previousBus: EventBus | null = null;
  let capturedEvents: AnyPlatformEvent[] = [];

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({
      SESSION_TERMINALIZATION_ENABLED: 'true',
    });
  }, TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    mockLlm.reset();
    capturedEvents = [];
    previousBus = getRuntimeEventBus();
    setRuntimeEventBus(makeCollectorBus(capturedEvents));
  });

  afterEach(() => {
    setRuntimeEventBus(previousBus);
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, TIMEOUT_MS);

  test(
    'SDK end_session terminalizes a detach-default web_chat conversation and emits one canonical session.ended event',
    async () => {
      const admin = await setupProject(harness, mockLlm, 'explicit-end');
      mockLlm.register('Please end this SDK session after this reply.', {
        content: 'Handled. The session can be ended now.',
      });

      const sdkSession = await initSdkSession(harness, {
        publicKey: admin.publicKey,
        userContext: { userId: 'sdk-terminalization-int-user' },
      });

      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws/sdk`,
        buildSdkWSProtocols(sdkSession.token),
      );

      try {
        const sessionStart = await waitForSocketMessage(
          ws,
          (message) => message.type === 'session_start',
          'session_start',
        );
        const runtimeSessionId =
          typeof sessionStart.sessionId === 'string' ? sessionStart.sessionId : undefined;
        expect(runtimeSessionId).toBeTruthy();

        ws.send(
          JSON.stringify({
            type: 'chat_message',
            text: 'Please end this SDK session after this reply.',
            messageId: 'sdk-terminalization-int-msg-1',
          }),
        );

        const responseEnd = await waitForSocketMessage(
          ws,
          (message) => message.type === 'response_end',
          'response_end',
        );
        expect(responseEnd.fullText).toBe('Handled. The session can be ended now.');

        const sessionEndedPromise = waitForSocketMessage(
          ws,
          (message) => message.type === 'session_ended',
          'session_ended',
        );
        const socketClosePromise = waitForSocketClose(ws);

        ws.send(JSON.stringify({ type: 'end_session' }));

        const sessionEnded = await sessionEndedPromise;
        const socketClosed = await socketClosePromise;

        expect(sessionEnded).toMatchObject({
          type: 'session_ended',
          sessionId: sessionStart.sessionId,
        });
        expect(socketClosed).toMatchObject({
          code: 1000,
          reason: 'Session ended by client',
        });

        const { Session } = await import('@agent-platform/database/models');
        const storedSession = await waitFor(
          'terminalized SDK session record',
          async () => {
            const session = await Session.findOne({
              _id: runtimeSessionId,
              tenantId: admin.tenantId,
              projectId: admin.projectId,
            }).lean();

            if (
              session?.status === 'completed' &&
              session?.disposition === 'completed' &&
              session?.endedAt instanceof Date
            ) {
              return session;
            }

            return null;
          },
          15_000,
        );

        expect(storedSession).toMatchObject({
          _id: runtimeSessionId,
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          status: 'completed',
          disposition: 'completed',
          channel: 'web_chat',
        });

        await waitForEventTypeCount(capturedEvents, 'session.ended', 1);

        const sessionEndedEvent = capturedEvents.find(
          (event): event is SessionEndedEvent => event.type === 'session.ended',
        );

        expect(sessionEndedEvent).toMatchObject({
          type: 'session.ended',
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          sessionId: runtimeSessionId,
          channel: 'web_chat',
          payload: {
            reason: 'completed',
            disposition: 'completed',
            status: 'completed',
            terminalSource: 'sdk_end_session',
          },
        });
      } finally {
        if (ws.readyState === NodeWebSocket.OPEN || ws.readyState === NodeWebSocket.CONNECTING) {
          ws.terminate();
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    'SDK end_session delivers a configured respond hook on web_chat after terminalization begins',
    async () => {
      const admin = await setupProject(harness, mockLlm, 'respond-hook');
      await updateProjectSessionLifecycle(harness, admin.token, admin.projectId, {
        endHook: {
          mode: 'ignore',
        },
        channels: {
          web_chat: {
            endHook: {
              mode: 'respond',
              message: 'This chat has ended.',
            },
          },
        },
      });

      mockLlm.register('Please end this SDK session with a hook.', {
        content: 'Handled. The session can be ended now.',
      });

      const sdkSession = await initSdkSession(harness, {
        publicKey: admin.publicKey,
        userContext: { userId: 'sdk-terminalization-int-user-hook' },
      });

      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws/sdk`,
        buildSdkWSProtocols(sdkSession.token),
      );

      try {
        const sessionStart = await waitForSocketMessage(
          ws,
          (message) => message.type === 'session_start',
          'session_start',
        );
        const runtimeSessionId =
          typeof sessionStart.sessionId === 'string' ? sessionStart.sessionId : undefined;
        expect(runtimeSessionId).toBeTruthy();

        ws.send(
          JSON.stringify({
            type: 'chat_message',
            text: 'Please end this SDK session with a hook.',
            messageId: 'sdk-terminalization-int-msg-hook-1',
          }),
        );

        const responseEnd = await waitForSocketMessage(
          ws,
          (message) =>
            message.type === 'response_end' &&
            message.fullText === 'Handled. The session can be ended now.',
          'chat response_end',
        );
        expect(responseEnd.fullText).toBe('Handled. The session can be ended now.');

        const hookStartPromise = waitForSocketMessage(
          ws,
          (message) => message.type === 'response_start',
          'hook response_start',
        );
        const hookEndPromise = waitForSocketMessage(
          ws,
          (message) =>
            message.type === 'response_end' && message.fullText === 'This chat has ended.',
          'hook response_end',
        );
        const sessionEndedPromise = waitForSocketMessage(
          ws,
          (message) => message.type === 'session_ended',
          'session_ended',
        );
        const socketClosePromise = waitForSocketClose(ws);

        ws.send(JSON.stringify({ type: 'end_session' }));

        const hookStart = await hookStartPromise;
        const hookEnd = await hookEndPromise;
        const sessionEnded = await sessionEndedPromise;
        const socketClosed = await socketClosePromise;

        expect(hookStart).toMatchObject({
          type: 'response_start',
          sessionId: sessionStart.sessionId,
        });
        expect(hookEnd).toMatchObject({
          type: 'response_end',
          sessionId: sessionStart.sessionId,
          fullText: 'This chat has ended.',
        });
        expect(sessionEnded).toMatchObject({
          type: 'session_ended',
          sessionId: sessionStart.sessionId,
        });
        expect(socketClosed).toMatchObject({
          code: 1000,
          reason: 'Session ended by client',
        });

        const { Session } = await import('@agent-platform/database/models');
        const storedSession = await waitFor(
          'terminalized SDK session record with respond hook',
          async () => {
            const session = await Session.findOne({
              _id: runtimeSessionId,
              tenantId: admin.tenantId,
              projectId: admin.projectId,
            }).lean();

            if (
              session?.status === 'completed' &&
              session?.disposition === 'completed' &&
              session?.endedAt instanceof Date
            ) {
              return session;
            }

            return null;
          },
          15_000,
        );

        expect(storedSession).toMatchObject({
          _id: runtimeSessionId,
          status: 'completed',
          disposition: 'completed',
          channel: 'web_chat',
        });

        await waitForEventTypeCount(capturedEvents, 'session.ended', 1);

        const sessionEndedEvent = capturedEvents.find(
          (event): event is SessionEndedEvent => event.type === 'session.ended',
        );

        expect(sessionEndedEvent).toMatchObject({
          type: 'session.ended',
          sessionId: runtimeSessionId,
          payload: {
            disposition: 'completed',
            status: 'completed',
            terminalSource: 'sdk_end_session',
          },
        });
      } finally {
        if (ws.readyState === NodeWebSocket.OPEN || ws.readyState === NodeWebSocket.CONNECTING) {
          ws.terminate();
        }
      }
    },
    TIMEOUT_MS,
  );
});
