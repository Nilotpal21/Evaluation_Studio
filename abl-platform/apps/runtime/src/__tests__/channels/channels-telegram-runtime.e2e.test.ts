import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import projectIoRouter from '../../routes/project-io.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import channelWebhooksRouter from '../../routes/channel-webhooks.js';
import sessionsRouter from '../../routes/sessions.js';
import attachmentsRouter from '../../routes/attachments.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { startChannelQueues, stopChannelQueues } from '../../services/queues/index.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  startMultimodalServiceHarness,
  type MultimodalServiceHarness,
} from '../helpers/multimodal-service-harness.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../helpers/redis-server-harness.js';
import {
  startTelegramBotApiHarness,
  type TelegramBotApiHarness,
} from '../helpers/telegram-bot-api-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const TELEGRAM_E2E_TIMEOUT_MS = 90_000;

const TELEGRAM_ACTION_AGENT_DSL = `
AGENT: Telegram_Action_Agent
GOAL: "Handle button interactions"
PERSONA: "Helpful"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirmed
    - cancelled

ask:
  REASONING: false
  RESPOND: "Confirm order?"
    ACTIONS:
      - BUTTON: "Yes" -> confirm_yes
      - BUTTON: "No" -> confirm_no
  ON_ACTION:
    confirm_yes:
      SET: choice = yes
      RESPOND: "Order confirmed!"
      TRANSITION: confirmed
    confirm_no:
      RESPOND: "Order cancelled."
      TRANSITION: cancelled

confirmed:
  REASONING: false
  RESPOND: "Processing your order. choice={{choice}}"
  THEN: COMPLETE

cancelled:
  REASONING: false
  RESPOND: "Goodbye."
  THEN: COMPLETE
`;

const TELEGRAM_STREAM_AGENT_DSL = `
AGENT: Telegram_Stream_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

interface TelegramChannelSetup {
  admin: {
    token: string;
    userId: string;
    tenantId: string;
    projectId: string;
  };
  botToken: string;
  botUsername: string;
  secretToken: string;
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

const describeTelegramRuntimeE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeTelegramRuntimeE2E('Telegram runtime channel E2E', () => {
  let harness: RuntimeApiHarness | undefined;
  let multimodal: MultimodalServiceHarness | undefined;
  let redis: RedisServerHarness | undefined;
  let telegram: TelegramBotApiHarness | undefined;
  let mockLlm: MockLLM | undefined;

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    redis = await startRedisServerHarness();
    telegram = await startTelegramBotApiHarness();
    mockLlm = await startMockLLM();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/v1/channels', channelWebhooksRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
        app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);
      },
      {
        MULTIMODAL_SERVICE_URL: multimodal.baseUrl,
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
    );

    await initializeRedis();
    await startChannelQueues();
  });

  beforeEach(async () => {
    clearPermissionCache();
    await harness?.resetRuntimeState();
    await redis?.clear();
    await setSuperAdmins([]);
    telegram?.reset();
    mockLlm?.reset();
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (telegram) await telegram.close();
    if (redis) await redis.close();
    if (multimodal) await multimodal.close();
  });

  async function setupTelegramChannel(
    agentDsl: string,
    options: {
      botToken: string;
      botUsername: string;
      streaming?: { enabled: boolean; chunkSize?: number };
    },
  ): Promise<TelegramChannelSetup> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('telegram-admin'),
      uniqueSlug('tenant-telegram'),
      uniqueSlug('project-telegram'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/telegram.agent.abl': agentDsl,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Telegram Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-telegram-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: true,
      supportsTools: true,
      capabilities: ['text', 'tools', 'streaming'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-telegram-model',
        apiKey: 'test-api-key',
      },
    });

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'telegram',
      display_name: 'Telegram Test Channel',
      external_identifier: options.botUsername,
      credentials: {
        bot_token: options.botToken,
      },
      config: {
        telegramApiBaseUrl: telegram.baseUrl,
        ...(options.streaming ? { streaming: options.streaming } : {}),
      },
    });

    const secretToken = await waitFor('Telegram webhook secret', () =>
      telegram.getWebhookSecret(options.botToken),
    );

    return {
      admin,
      botToken: options.botToken,
      botUsername: options.botUsername,
      secretToken,
    };
  }

  test(
    'rejects webhook calls with an invalid Telegram secret token',
    async () => {
      const setup = await setupTelegramChannel(TELEGRAM_ACTION_AGENT_DSL, {
        botToken: 'telegram-invalid-secret-token',
        botUsername: uniqueSlug('telegram-invalid-secret-bot'),
      });

      const response = await requestJson<{ error: string }>(
        harness,
        `/api/v1/channels/telegram/webhook/${encodeURIComponent(setup.botUsername)}`,
        {
          method: 'POST',
          headers: {
            'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
          },
          body: {
            update_id: 1,
            message: {
              message_id: 10,
              from: {
                id: 101,
                is_bot: false,
                first_name: 'Alice',
              },
              chat: {
                id: 101,
                type: 'private',
              },
              date: 1_700_000_000,
              text: 'hello',
            },
          },
        },
      );

      expect(response.status).toBe(401);
      expect(telegram.getSentMessages()).toHaveLength(0);
    },
    TELEGRAM_E2E_TIMEOUT_MS,
  );

  test('delivers rich inline keyboards and resumes the same session on callback queries', async () => {
    const setup = await setupTelegramChannel(TELEGRAM_ACTION_AGENT_DSL, {
      botToken: 'telegram-rich-token',
      botUsername: uniqueSlug('telegram-rich-bot'),
    });

    const firstWebhook = await requestJson<{ ok: boolean }>(
      harness,
      `/api/v1/channels/telegram/webhook/${encodeURIComponent(setup.botUsername)}`,
      {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': setup.secretToken,
        },
        body: {
          update_id: 1001,
          message: {
            message_id: 11,
            from: {
              id: 501,
              is_bot: false,
              first_name: 'Alice',
              username: 'alice',
            },
            chat: {
              id: 501,
              type: 'private',
            },
            date: 1_700_000_100,
            text: 'hello',
          },
        },
      },
    );

    expect(firstWebhook.status).toBe(200);
    expect(firstWebhook.body.ok).toBe(true);

    const firstMessage = await waitFor('Telegram rich response', () => {
      const messages = telegram.getSentMessages();
      return messages.length > 0 ? messages[0] : null;
    });

    expect(firstMessage.body.text).toBe('Confirm order?');
    expect(firstMessage.body.reply_markup).toEqual(
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              callback_data: 'confirm_yes',
              text: 'Yes',
            }),
          ]),
        ]),
      }),
    );

    await waitFor('Telegram typing indicator', () => {
      const typingActions = telegram.getTypingActions();
      return typingActions.length > 0 ? typingActions[0] : null;
    });

    const sessionList = await waitFor('Telegram session list', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=telegram`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body : null;
    });

    expect(sessionList.sessions).toHaveLength(1);

    const callbackWebhook = await requestJson<{ ok: boolean }>(
      harness,
      `/api/v1/channels/telegram/webhook/${encodeURIComponent(setup.botUsername)}`,
      {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': setup.secretToken,
        },
        body: {
          update_id: 1002,
          callback_query: {
            id: 'cbq-1',
            from: {
              id: 501,
              is_bot: false,
              first_name: 'Alice',
              username: 'alice',
            },
            data: 'confirm_yes',
            message: {
              message_id: 12,
              date: 1_700_000_101,
              chat: {
                id: 501,
                type: 'private',
              },
            },
          },
        },
      },
    );

    expect(callbackWebhook.status).toBe(200);
    expect(callbackWebhook.body.ok).toBe(true);

    await waitFor('Telegram callback answer', () => {
      const answers = telegram.getCallbackAnswers();
      return answers.length > 0 ? answers[0] : null;
    });

    const allMessages = await waitFor('Telegram callback response message', () => {
      const messages = telegram.getSentMessages();
      return messages.length >= 2 ? messages : null;
    });

    expect(allMessages[1].body.text).toContain('Processing your order');
    expect(allMessages[1].body.text).toContain('choice=yes');

    const resumedSessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=telegram`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${setup.admin.token}`,
      },
    });

    expect(resumedSessions.status).toBe(200);
    expect(resumedSessions.body.sessions).toHaveLength(1);
    expect(resumedSessions.body.sessions[0].id).toBe(sessionList.sessions[0].id);
  });

  test('streams drafts, uploads Telegram attachments through APIs, and delivers the final message', async () => {
    const setup = await setupTelegramChannel(TELEGRAM_STREAM_AGENT_DSL, {
      botToken: 'telegram-stream-token',
      botUsername: uniqueSlug('telegram-stream-bot'),
      streaming: {
        enabled: true,
        chunkSize: 80,
      },
    });

    const longResponse =
      'Streaming response segment. '.repeat(30) +
      'The attachment was processed through the real multimodal API.';
    mockLlm.register('stream and store this file', {
      content: longResponse,
    });

    telegram.registerFile('file-1', {
      filePath: 'documents/file-1.txt',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      content: 'attachment-content',
    });

    const webhookResponse = await requestJson<{ ok: boolean }>(
      harness,
      `/api/v1/channels/telegram/webhook/${encodeURIComponent(setup.botUsername)}`,
      {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': setup.secretToken,
        },
        body: {
          update_id: 2001,
          message: {
            message_id: 21,
            from: {
              id: 777,
              is_bot: false,
              first_name: 'Bob',
              username: 'bob',
            },
            chat: {
              id: 777,
              type: 'private',
            },
            date: 1_700_000_200,
            caption: 'stream and store this file',
            document: {
              file_id: 'file-1',
              file_unique_id: 'unique-file-1',
              file_name: 'notes.txt',
              mime_type: 'text/plain',
              file_size: 18,
            },
          },
        },
      },
    );

    expect(webhookResponse.status).toBe(200);
    expect(webhookResponse.body.ok).toBe(true);

    const drafts = await waitFor('Telegram streaming drafts', () => {
      const values = telegram.getDraftRequests();
      return values.length > 0 ? values : null;
    });

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0].body.text.length).toBeGreaterThan(80);
    expect(drafts[drafts.length - 1].body.text.length).toBeGreaterThanOrEqual(
      drafts[0].body.text.length,
    );

    const finalMessage = await waitFor('Telegram final message', () => {
      const messages = telegram.getSentMessages();
      return messages.length > 0 ? messages[messages.length - 1] : null;
    });

    expect(finalMessage.body.text).toBe(longResponse);

    const sessions = await waitFor('Telegram attachment session', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=telegram`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body.sessions : null;
    });

    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0].id;

    const attachments = await waitFor('Telegram uploaded attachment', async () => {
      const response = await requestJson<{
        success: boolean;
        data: {
          attachments: Array<{
            id: string;
            originalFilename?: string;
            filename?: string;
            mimeType?: string;
          }>;
        };
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions/${sessionId}/attachments`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.data.attachments.length > 0 ? response.body.data.attachments : null;
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual(
      expect.objectContaining({
        filename: 'notes.txt',
        originalFilename: 'notes.txt',
        mimeType: 'text/plain',
      }),
    );
    expect(attachments[0]).not.toHaveProperty('storageKey');
    expect(attachments[0]).not.toHaveProperty('contentHash');
    expect(attachments[0]).not.toHaveProperty('tenantId');
    expect(attachments[0]).not.toHaveProperty('projectId');
    expect(attachments[0]).not.toHaveProperty('sessionId');
  });
});
