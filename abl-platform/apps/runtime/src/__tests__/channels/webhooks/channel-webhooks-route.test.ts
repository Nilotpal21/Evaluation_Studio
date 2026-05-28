import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../../routes/auth.js';
import platformAdminTenantsRouter from '../../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../../routes/platform-admin-models.js';
import projectIoRouter from '../../../routes/project-io.js';
import channelConnectionsRouter from '../../../routes/channel-connections.js';
import channelWebhooksRouter from '../../../routes/channel-webhooks.js';
import sessionsRouter from '../../../routes/sessions.js';
import attachmentsRouter from '../../../routes/attachments.js';
import { clearPermissionCache } from '../../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../../services/redis/redis-client.js';
import { startChannelQueues, stopChannelQueues } from '../../../services/queues/index.js';
import {
  startRuntimeApiHarness,
  type RuntimeApiHarness,
} from '../../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../../helpers/channel-e2e-bootstrap.js';
import {
  startMultimodalServiceHarness,
  type MultimodalServiceHarness,
} from '../../helpers/multimodal-service-harness.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../../helpers/redis-server-harness.js';
import { startSlackApiHarness, type SlackApiHarness } from '../../helpers/slack-api-harness.js';
import { startLineApiHarness, type LineApiHarness } from '../../helpers/line-api-harness.js';
import { startMockLLM } from '../../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../../tools/agents/e2e-functional/types.js';

const WEBHOOK_ROUTE_E2E_TIMEOUT_MS = 90_000;

const STATIC_AGENT_DSL = `
AGENT: Shared_Webhook_Agent
GOAL: "Respond to inbound webhook messages"
PERSONA: "Helpful"

FLOW:
  entry_point: reply
  steps:
    - reply

reply:
  REASONING: false
  RESPOND: "Webhook processed."
  THEN: COMPLETE
`;

const ACTION_AGENT_DSL = `
AGENT: Line_Action_Agent
GOAL: "Return interactive options"
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

interface ChannelAdmin {
  token: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

interface SlackChannelSetup {
  admin: ChannelAdmin;
  externalIdentifier: string;
  botToken: string;
  signingSecret: string;
}

interface LineChannelSetup {
  admin: ChannelAdmin;
  destination: string;
  accessToken: string;
  channelSecret: string;
}

interface InfobipChannelSetup {
  admin: ChannelAdmin;
  senderNumber: string;
  apiKey: string;
}

interface InfobipTextMessageCall {
  headers: Record<string, string | string[] | undefined>;
  body: {
    from?: string;
    to?: string;
    content?: {
      text?: string;
    };
  };
}

function uniqueSlackExternalIdentifier(): string {
  const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `T${suffix}:A${suffix}`;
}

function uniqueLineDestination(): string {
  return `U${Math.random().toString(36).slice(2, 18)}`;
}

function signSlackBody(signingSecret: string, rawBody: string, timestamp: string): string {
  return `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

function signLineBody(channelSecret: string, rawBody: string): string {
  return crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
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

const describeChannelWebhookRouteE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeChannelWebhookRouteE2E('Channel webhook route black-box E2E', () => {
  let harness: RuntimeApiHarness | undefined;
  let multimodal: MultimodalServiceHarness | undefined;
  let redis: RedisServerHarness | undefined;
  let slack: SlackApiHarness | undefined;
  let line: LineApiHarness | undefined;
  let mockLlm: MockLLM | undefined;
  let infobipTextMessageCalls: InfobipTextMessageCall[] = [];

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    redis = await startRedisServerHarness();
    slack = await startSlackApiHarness();
    line = await startLineApiHarness();
    mockLlm = await startMockLLM();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.post('/infobip-api/whatsapp/1/message/text', (req, res) => {
          infobipTextMessageCalls.push({
            headers: req.headers,
            body: req.body,
          });
          res.json({
            messageId: `infobip-outbound-${infobipTextMessageCalls.length}`,
            status: { groupName: 'PENDING' },
          });
        });
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
    slack?.reset();
    line?.reset();
    mockLlm?.reset();
    infobipTextMessageCalls = [];
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (line) await line.close();
    if (slack) await slack.close();
    if (redis) await redis.close();
    if (multimodal) await multimodal.close();
  });

  async function provisionWebhookProject(agentDsl: string, prefix: string): Promise<ChannelAdmin> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail(`${prefix}-admin`),
      uniqueSlug(`tenant-${prefix}`),
      uniqueSlug(`project-${prefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/webhook.agent.abl': agentDsl,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: `${prefix} model`,
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: `${prefix}-model`,
      endpointUrl: mockLlm.url,
      supportsStreaming: true,
      supportsTools: true,
      capabilities: ['text', 'tools', 'streaming'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: `${prefix}-model`,
        apiKey: 'test-api-key',
      },
    });

    return admin;
  }

  async function setupSlackChannel(agentDsl = STATIC_AGENT_DSL): Promise<SlackChannelSetup> {
    const admin = await provisionWebhookProject(agentDsl, 'webhook-slack');
    const externalIdentifier = uniqueSlackExternalIdentifier();
    const botToken = `xoxb-test-${Math.random().toString(36).slice(2, 10)}`;
    const signingSecret = `slack-secret-${Math.random().toString(36).slice(2, 10)}`;

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'slack',
      display_name: 'Slack Webhook Test Channel',
      external_identifier: externalIdentifier,
      credentials: {
        bot_token: botToken,
        signing_secret: signingSecret,
      },
      config: {
        slackApiBaseUrl: slack.baseUrl,
      },
    });

    return {
      admin,
      externalIdentifier,
      botToken,
      signingSecret,
    };
  }

  async function setupLineChannel(agentDsl = STATIC_AGENT_DSL): Promise<LineChannelSetup> {
    const admin = await provisionWebhookProject(agentDsl, 'webhook-line');
    const destination = uniqueLineDestination();
    const accessToken = `line-token-${Math.random().toString(36).slice(2, 10)}`;
    const channelSecret = `line-secret-${Math.random().toString(36).slice(2, 10)}`;

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'line',
      display_name: 'LINE Webhook Test Channel',
      external_identifier: destination,
      credentials: {
        channel_access_token: accessToken,
        channel_secret: channelSecret,
      },
      config: {
        lineApiBaseUrl: line.baseUrl,
        lineDataApiBaseUrl: line.dataBaseUrl,
      },
    });

    return {
      admin,
      destination,
      accessToken,
      channelSecret,
    };
  }

  async function setupInfobipChannel(agentDsl = STATIC_AGENT_DSL): Promise<InfobipChannelSetup> {
    const admin = await provisionWebhookProject(agentDsl, 'webhook-infobip');
    const senderNumber = '447860099299';
    const apiKey = `infobip-key-${Math.random().toString(36).slice(2, 10)}`;

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'whatsapp',
      display_name: 'Infobip WhatsApp Test Channel',
      external_identifier: `+${senderNumber}`,
      credentials: {
        base_url: `${harness.baseUrl}/infobip-api`,
        api_key: apiKey,
      },
      config: {
        provider: 'infobip',
        authType: 'api_key',
      },
    });

    expect(connection.externalIdentifier).toBe(senderNumber);

    return {
      admin,
      senderNumber,
      apiKey,
    };
  }

  async function listProjectSessions(projectId: string, token: string, channel: string) {
    const response = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${projectId}/sessions?channel=${encodeURIComponent(channel)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    return response.body.sessions;
  }

  async function listSessionAttachments(projectId: string, sessionId: string, token: string) {
    const response = await requestJson<{
      success: boolean;
      data: {
        attachments: Array<{
          id: string;
          filename?: string;
          originalFilename?: string;
          mimeType?: string;
        }>;
      };
    }>(harness, `/api/projects/${projectId}/sessions/${sessionId}/attachments`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    return response.body.data.attachments;
  }

  async function postJson(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${harness.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  async function postSlackGenericWebhook(
    setup: SlackChannelSetup,
    body: Record<string, unknown>,
    options?: { signingSecret?: string },
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackBody(
      options?.signingSecret ?? setup.signingSecret,
      rawBody,
      timestamp,
    );

    const response = await fetch(`${harness.baseUrl}/api/v1/channels/slack/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': signature,
      },
      body: rawBody,
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  async function postSlackConnectionWebhook(
    setup: SlackChannelSetup,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackBody(setup.signingSecret, rawBody, timestamp);

    const response = await fetch(
      `${harness.baseUrl}/api/v1/channels/slack/webhook/${encodeURIComponent(setup.externalIdentifier)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': timestamp,
          'X-Slack-Signature': signature,
        },
        body: rawBody,
      },
    );

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  async function postSlackInteractiveWebhook(
    setup: SlackChannelSetup,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const payload = JSON.stringify(body);
    const rawBody = new URLSearchParams({ payload }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackBody(setup.signingSecret, rawBody, timestamp);

    const response = await fetch(
      `${harness.baseUrl}/api/v1/channels/slack/webhook/${encodeURIComponent(setup.externalIdentifier)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Slack-Request-Timestamp': timestamp,
          'X-Slack-Signature': signature,
        },
        body: rawBody,
      },
    );

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  async function postLineWebhook(
    setup: LineChannelSetup,
    body: Record<string, unknown>,
    options?: { channelSecret?: string },
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = JSON.stringify(body);
    const signature = signLineBody(options?.channelSecret ?? setup.channelSecret, rawBody);

    const response = await fetch(`${harness.baseUrl}/api/v1/channels/line/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature,
      },
      body: rawBody,
    });

    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
    };
  }

  test(
    'accepts cold Infobip provider-specific WhatsApp webhooks and sends a response',
    async () => {
      const setup = await setupInfobipChannel();

      const webhook = await postJson('/api/v1/channels/whatsapp/infobip/webhook', {
        results: [
          {
            from: '917989681324',
            to: setup.senderNumber,
            integrationType: 'WHATSAPP',
            receivedAt: '2026-05-07T12:52:40.000+0000',
            messageId: 'infobip-e2e-msg-001',
            message: { type: 'TEXT', text: 'Hii' },
            contact: { name: 'WhatsApp User' },
          },
        ],
        messageCount: 1,
        pendingMessageCount: 0,
      });

      expect(webhook.status).toBe(200);
      expect(webhook.body).toEqual({ ok: true });

      const sentMessage = await waitFor('Infobip outbound response', () =>
        infobipTextMessageCalls.length > 0 ? infobipTextMessageCalls[0] : null,
      );

      expect(sentMessage.headers.authorization).toBe(`App ${setup.apiKey}`);
      expect(sentMessage.body).toEqual({
        from: setup.senderNumber,
        to: '917989681324',
        content: { text: 'Webhook processed.' },
      });

      const sessions = await waitFor('Infobip WhatsApp session', async () => {
        const result = await listProjectSessions(
          setup.admin.projectId,
          setup.admin.token,
          'whatsapp',
        );
        return result.length > 0 ? result : null;
      });

      expect(sessions).toHaveLength(1);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test('rejects unsupported channel types on generic and explicit webhook routes', async () => {
    const generic = await postJson('/api/v1/channels/unknown_channel/webhook', {
      type: 'event_callback',
    });
    const explicit = await postJson('/api/v1/channels/unknown_channel/webhook/example', {
      type: 'event_callback',
    });

    expect(generic.status).toBe(400);
    expect(generic.body).toEqual({ error: 'Unsupported channel type: unknown_channel' });
    expect(explicit.status).toBe(400);
    expect(explicit.body).toEqual({ error: 'Unsupported channel type: unknown_channel' });
  });

  test(
    'routes signed Slack generic webhook payloads using the identifier extracted from the body',
    async () => {
      const setup = await setupSlackChannel();
      const [teamId, appId] = setup.externalIdentifier.split(':');

      const webhook = await postSlackGenericWebhook(setup, {
        type: 'event_callback',
        team_id: teamId,
        api_app_id: appId,
        event_id: 'EvSlackGeneric001',
        event_time: 1_700_000_001,
        event: {
          type: 'message',
          channel: 'C_GENERIC',
          user: 'U_GENERIC',
          text: 'hello from generic route',
          ts: '1700000001.000100',
          event_ts: '1700000001.000100',
          channel_type: 'im',
        },
      });

      expect(webhook.status).toBe(200);
      expect(webhook.body).toEqual({ ok: true });

      const postedMessage = await waitFor('Slack generic response', () => {
        const messages = slack.getPostedMessages();
        return messages.length > 0 ? messages[0] : null;
      });

      expect(postedMessage.token).toBe(setup.botToken);
      expect(postedMessage.body.text).toBe('Webhook processed.');

      const sessions = await waitFor('Slack generic session', async () => {
        const result = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'slack');
        return result.length > 0 ? result : null;
      });

      expect(sessions).toHaveLength(1);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test('returns a safe 400 for Slack generic webhooks missing an external identifier', async () => {
    const response = await postJson('/api/v1/channels/slack/webhook', {
      type: 'event_callback',
      event_id: 'EvMissingIdentifier',
      event_time: 1_700_000_002,
      event: {
        type: 'message',
        channel: 'C_MISSING',
        user: 'U_MISSING',
        text: 'missing team',
        ts: '1700000002.000100',
        event_ts: '1700000002.000100',
        channel_type: 'im',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Missing external identifier' });
  });

  test(
    'filters signed Slack bot events before queueing or creating sessions',
    async () => {
      const setup = await setupSlackChannel();
      const [teamId, appId] = setup.externalIdentifier.split(':');

      const webhook = await postSlackGenericWebhook(setup, {
        type: 'event_callback',
        team_id: teamId,
        api_app_id: appId,
        event_id: 'EvSlackBot001',
        event_time: 1_700_000_003,
        event: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_TEST',
          channel: 'C_BOT',
          text: 'bot event',
          ts: '1700000003.000100',
          event_ts: '1700000003.000100',
          channel_type: 'im',
        },
      });

      expect(webhook.status).toBe(200);
      expect(webhook.body).toEqual({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(slack.getPostedMessages()).toHaveLength(0);
      const sessions = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'slack');
      expect(sessions).toHaveLength(0);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test('returns 404 when a Slack webhook targets an unknown connection', async () => {
    const response = await postJson('/api/v1/channels/slack/webhook/T404%3AA404', {
      type: 'event_callback',
      team_id: 'T404',
      api_app_id: 'A404',
      event_id: 'EvNotFound',
      event_time: 1_700_000_004,
      event: {
        type: 'message',
        channel: 'C404',
        user: 'U404',
        text: 'hello',
        ts: '1700000004.000100',
        event_ts: '1700000004.000100',
        channel_type: 'im',
      },
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Channel not configured for this workspace' });
  });

  test(
    'returns 503 when the inbound queue is unavailable after Slack verification succeeds',
    async () => {
      const setup = await setupSlackChannel();
      const [teamId, appId] = setup.externalIdentifier.split(':');

      await stopChannelQueues();
      try {
        const response = await postSlackGenericWebhook(setup, {
          type: 'event_callback',
          team_id: teamId,
          api_app_id: appId,
          event_id: 'EvSlackQueueUnavailable',
          event_time: 1_700_000_005,
          event: {
            type: 'message',
            channel: 'C_QUEUE',
            user: 'U_QUEUE',
            text: 'queue unavailable',
            ts: '1700000005.000100',
            event_ts: '1700000005.000100',
            channel_type: 'im',
          },
        });

        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Queue unavailable' });
        expect(slack.getPostedMessages()).toHaveLength(0);
      } finally {
        await startChannelQueues();
      }
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'returns response_action clear for signed Slack view submissions on the connection-scoped route',
    async () => {
      const setup = await setupSlackChannel(ACTION_AGENT_DSL);
      const [teamId, appId] = setup.externalIdentifier.split(':');

      const response = await postSlackInteractiveWebhook(setup, {
        type: 'view_submission',
        trigger_id: '1337.42.view',
        api_app_id: appId,
        user: { id: 'U_VIEW', team_id: teamId, name: 'viewer' },
        team: { id: teamId },
        view: {
          id: 'V_VIEW',
          callback_id: 'order_form',
          state: {
            values: {
              order_block: {
                item_field: {
                  value: 'latte',
                },
              },
            },
          },
        },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ response_action: 'clear' });
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'rejects LINE webhooks with an invalid signature',
    async () => {
      const setup = await setupLineChannel();

      const response = await postLineWebhook(
        setup,
        {
          destination: setup.destination,
          events: [
            {
              type: 'message',
              timestamp: 1_700_000_006_000,
              replyToken: 'reply-invalid',
              source: { type: 'user', userId: 'U_LINE_INVALID' },
              message: { type: 'text', id: 'line-invalid-1', text: 'hello' },
            },
          ],
        },
        { channelSecret: 'wrong-line-secret' },
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid signature' });
      expect(line.getReplyCalls()).toHaveLength(0);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'returns 200 for LINE communication checks without queueing or creating sessions',
    async () => {
      const setup = await setupLineChannel();

      const response = await postLineWebhook(setup, {
        destination: setup.destination,
        events: [],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(line.getReplyCalls()).toHaveLength(0);
      expect(line.getPushCalls()).toHaveLength(0);
      const sessions = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'line');
      expect(sessions).toHaveLength(0);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'fans out multi-event LINE webhooks into separate replies without dropping events',
    async () => {
      const setup = await setupLineChannel();

      const response = await postLineWebhook(setup, {
        destination: setup.destination,
        events: [
          {
            type: 'message',
            timestamp: 1_700_000_007_000,
            replyToken: 'reply-line-1',
            source: { type: 'user', userId: 'U_LINE_FANOUT' },
            message: { type: 'text', id: 'line-fanout-1', text: 'first event' },
          },
          {
            type: 'message',
            timestamp: 1_700_000_007_100,
            replyToken: 'reply-line-2',
            source: { type: 'user', userId: 'U_LINE_FANOUT' },
            message: { type: 'text', id: 'line-fanout-2', text: 'second event' },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      const replies = await waitFor('LINE fan-out replies', () => {
        const calls = line.getReplyCalls();
        return calls.length >= 2 ? calls : null;
      });

      expect(replies).toHaveLength(2);
      expect(replies.map((call) => call.token)).toEqual([setup.accessToken, setup.accessToken]);
      expect(replies.map((call) => call.body.replyToken)).toEqual(['reply-line-1', 'reply-line-2']);

      const sessions = await waitFor('LINE fan-out session', async () => {
        const result = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'line');
        return result.length > 0 ? result : null;
      });

      expect(sessions).toHaveLength(1);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'preserves LINE quick replies and emits typing indicators for supported user chats',
    async () => {
      const setup = await setupLineChannel(ACTION_AGENT_DSL);

      const response = await postLineWebhook(setup, {
        destination: setup.destination,
        events: [
          {
            type: 'message',
            timestamp: 1_700_000_008_000,
            replyToken: 'reply-line-quick',
            source: { type: 'user', userId: 'U_LINE_QUICK' },
            message: { type: 'text', id: 'line-quick-1', text: 'hello' },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      const typingIndicator = await waitFor('LINE typing indicator', () => {
        const calls = line.getTypingIndicators();
        return calls.length > 0 ? calls[0] : null;
      });
      expect(typingIndicator.token).toBe(setup.accessToken);
      expect(typingIndicator.body).toEqual({
        chatId: 'U_LINE_QUICK',
        loadingSeconds: 20,
      });

      const reply = await waitFor('LINE quick reply response', () => {
        const calls = line.getReplyCalls();
        return calls.length > 0 ? calls[0] : null;
      });

      expect(reply.token).toBe(setup.accessToken);
      expect(reply.body.replyToken).toBe('reply-line-quick');
      expect(reply.body.messages).toHaveLength(1);
      const message = (reply.body.messages as Array<Record<string, unknown>>)[0];
      expect(message.text).toBe('Confirm order?');
      expect(message.quickReply).toEqual({
        items: [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: 'Yes',
              data: 'confirm_yes',
              displayText: 'Yes',
            },
          },
          {
            type: 'action',
            action: {
              type: 'postback',
              label: 'No',
              data: 'confirm_no',
              displayText: 'No',
            },
          },
        ],
      });
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'ingests LINE media through attachment APIs using the configured local provider download endpoint',
    async () => {
      const setup = await setupLineChannel();
      line.registerContent('line-media-1', {
        mimeType: 'image/jpeg',
        content: Buffer.from('line-media-content', 'utf8'),
        requiredToken: setup.accessToken,
      });

      const response = await postLineWebhook(setup, {
        destination: setup.destination,
        events: [
          {
            type: 'message',
            timestamp: 1_700_000_009_000,
            replyToken: 'reply-line-media',
            source: { type: 'user', userId: 'U_LINE_MEDIA' },
            message: {
              type: 'image',
              id: 'line-media-1',
              contentProvider: { type: 'line' },
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      const download = await waitFor('LINE media download', () => {
        const downloads = line.getContentDownloads();
        return downloads.length > 0 ? downloads[0] : null;
      });

      expect(download).toEqual({
        messageId: 'line-media-1',
        token: setup.accessToken,
      });

      const sessions = await waitFor('LINE media session', async () => {
        const result = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'line');
        return result.length > 0 ? result : null;
      });

      expect(sessions).toHaveLength(1);

      const attachments = await waitFor('LINE uploaded attachment', async () => {
        const result = await listSessionAttachments(
          setup.admin.projectId,
          sessions[0].id,
          setup.admin.token,
        );
        return result.length > 0 ? result : null;
      });

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual(
        expect.objectContaining({
          filename: 'image_line-media-1.jpg',
          originalFilename: 'image_line-media-1.jpg',
          mimeType: 'image/jpeg',
        }),
      );
      expect(attachments[0]).not.toHaveProperty('storageKey');
      expect(attachments[0]).not.toHaveProperty('contentHash');
      expect(attachments[0]).not.toHaveProperty('tenantId');
      expect(attachments[0]).not.toHaveProperty('projectId');
      expect(attachments[0]).not.toHaveProperty('sessionId');
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );

  test(
    'suppresses LINE typing indicators for unsupported group chats while still delivering a reply',
    async () => {
      const setup = await setupLineChannel();

      const response = await postLineWebhook(setup, {
        destination: setup.destination,
        events: [
          {
            type: 'message',
            timestamp: 1_700_000_010_000,
            replyToken: 'reply-line-group',
            source: { type: 'group', groupId: 'G_LINE_GROUP', userId: 'U_LINE_GROUP' },
            message: { type: 'text', id: 'line-group-1', text: 'hello group' },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      await waitFor('LINE group reply', () => {
        const replies = line.getReplyCalls();
        return replies.length > 0 ? replies[0] : null;
      });

      expect(line.getTypingIndicators()).toHaveLength(0);
    },
    WEBHOOK_ROUTE_E2E_TIMEOUT_MS,
  );
});
