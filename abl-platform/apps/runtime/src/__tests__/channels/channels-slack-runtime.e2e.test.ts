import crypto from 'node:crypto';
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
import { startSlackApiHarness, type SlackApiHarness } from '../helpers/slack-api-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const SLACK_E2E_TIMEOUT_MS = 90_000;

const SLACK_ACTION_AGENT_DSL = `
AGENT: Slack_Action_Agent
GOAL: "Handle Slack button interactions"
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

const SLACK_STREAM_AGENT_DSL = `
AGENT: Slack_Stream_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

interface SlackChannelSetup {
  admin: {
    token: string;
    userId: string;
    tenantId: string;
    projectId: string;
  };
  externalIdentifier: string;
  botToken: string;
  signingSecret: string;
}

function uniqueSlackExternalIdentifier(): string {
  const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `T${suffix}:A${suffix}`;
}

function signSlackBody(signingSecret: string, rawBody: string, timestamp: string): string {
  return `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
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

const describeSlackRuntimeE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeSlackRuntimeE2E('Slack runtime channel E2E', () => {
  let harness: RuntimeApiHarness | undefined;
  let multimodal: MultimodalServiceHarness | undefined;
  let redis: RedisServerHarness | undefined;
  let slack: SlackApiHarness | undefined;
  let mockLlm: MockLLM | undefined;

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    redis = await startRedisServerHarness();
    slack = await startSlackApiHarness();
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
  }, SLACK_E2E_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    // BullMQ jobs from the previous test can still be finalizing when the next
    // test starts. Restart queues before clearing Redis to prevent cross-test
    // leakage (for example a delayed Slack postMessage arriving after reset()).
    await stopChannelQueues();
    await harness?.resetRuntimeState();
    await redis?.clear();
    await setSuperAdmins([]);
    slack?.reset();
    mockLlm?.reset();
    await startChannelQueues();
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (slack) await slack.close();
    if (redis) await redis.close();
    if (multimodal) await multimodal.close();
  }, SLACK_E2E_TIMEOUT_MS);

  async function setupSlackChannel(
    agentDsl: string,
    options?: {
      externalIdentifier?: string;
      botToken?: string;
      signingSecret?: string;
      streaming?: { enabled: boolean; chunkSize?: number };
    },
  ): Promise<SlackChannelSetup> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('slack-admin'),
      uniqueSlug('tenant-slack'),
      uniqueSlug('project-slack'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/slack.agent.abl': agentDsl,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Slack Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-slack-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: true,
      supportsTools: true,
      capabilities: ['text', 'tools', 'streaming'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-slack-model',
        apiKey: 'test-api-key',
      },
    });

    const externalIdentifier = options?.externalIdentifier ?? uniqueSlackExternalIdentifier();
    const botToken = options?.botToken ?? `xoxb-test-${Math.random().toString(36).slice(2, 10)}`;
    const signingSecret =
      options?.signingSecret ?? `signing-secret-${Math.random().toString(36).slice(2, 10)}`;

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'slack',
      display_name: 'Slack Test Channel',
      external_identifier: externalIdentifier,
      credentials: {
        bot_token: botToken,
        signing_secret: signingSecret,
      },
      config: {
        slackApiBaseUrl: slack.baseUrl,
        ...(options?.streaming ? { streaming: options.streaming } : {}),
      },
    });

    return {
      admin,
      externalIdentifier,
      botToken,
      signingSecret,
    };
  }

  async function postSlackJsonWebhook(
    setup: SlackChannelSetup,
    body: Record<string, unknown>,
    options?: { signingSecret?: string },
  ): Promise<{
    status: number;
    body: unknown;
  }> {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackBody(
      options?.signingSecret ?? setup.signingSecret,
      rawBody,
      timestamp,
    );

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
    payload: Record<string, unknown>,
  ): Promise<{
    status: number;
    body: unknown;
  }> {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();
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

  test(
    'rejects webhook calls with an invalid Slack signature',
    async () => {
      const setup = await setupSlackChannel(SLACK_ACTION_AGENT_DSL);

      const response = await postSlackJsonWebhook(
        setup,
        {
          type: 'event_callback',
          team_id: setup.externalIdentifier.split(':')[0],
          api_app_id: setup.externalIdentifier.split(':')[1],
          event_id: 'EvInvalid',
          event_time: 1_700_000_000,
          event: {
            type: 'message',
            channel: 'C_INVALID',
            user: 'U_INVALID',
            text: 'hello',
            ts: '1700000000.000001',
            event_ts: '1700000000.000001',
            channel_type: 'im',
          },
        },
        { signingSecret: 'wrong-signing-secret' },
      );

      expect(response.status).toBe(401);
      expect(slack.getPostedMessages()).toHaveLength(0);
    },
    SLACK_E2E_TIMEOUT_MS,
  );

  test('verifies signed Slack url_verification payloads on connection-scoped webhook routes', async () => {
    const setup = await setupSlackChannel(SLACK_ACTION_AGENT_DSL);
    const [teamId, appId] = setup.externalIdentifier.split(':');

    const success = await postSlackJsonWebhook(setup, {
      type: 'url_verification',
      challenge: 'challenge-token',
      team_id: teamId,
      api_app_id: appId,
    });

    expect(success.status).toBe(200);
    expect(success.body).toEqual({ challenge: 'challenge-token' });

    const rejected = await postSlackJsonWebhook(
      setup,
      {
        type: 'url_verification',
        challenge: 'challenge-token',
        team_id: teamId,
        api_app_id: appId,
      },
      { signingSecret: 'wrong-signing-secret' },
    );

    expect(rejected.status).toBe(401);
  });

  test('delivers rich blocks and resumes the same session on block actions', async () => {
    const setup = await setupSlackChannel(SLACK_ACTION_AGENT_DSL);
    const [teamId, appId] = setup.externalIdentifier.split(':');
    const channelId = 'C_ACTIONS';
    const userMessageTs = '1700000100.000100';

    const firstWebhook = await postSlackJsonWebhook(setup, {
      type: 'event_callback',
      team_id: teamId,
      api_app_id: appId,
      event_id: 'EvSlack1001',
      event_time: 1_700_000_100,
      event: {
        type: 'message',
        channel: channelId,
        user: 'U_ALICE',
        text: 'hello',
        ts: userMessageTs,
        event_ts: userMessageTs,
        channel_type: 'im',
      },
    });

    expect(firstWebhook.status).toBe(200);
    expect(firstWebhook.body).toEqual({ ok: true });

    const firstMessage = await waitFor('Slack rich response', () => {
      const messages = slack.getPostedMessages();
      return messages.length > 0 ? messages[0] : null;
    });

    expect(firstMessage.body.text).toBe('Confirm order?');
    expect(firstMessage.body.thread_ts).toBe(userMessageTs);
    expect(JSON.stringify(firstMessage.body.blocks)).toContain('confirm_yes');
    expect(JSON.stringify(firstMessage.body.blocks)).toContain('"Yes"');

    const sessionList = await waitFor('Slack session list', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=slack`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body : null;
    });

    expect(sessionList.sessions).toHaveLength(1);

    const callbackWebhook = await postSlackInteractiveWebhook(setup, {
      type: 'block_actions',
      trigger_id: '1337.42.block',
      api_app_id: appId,
      user: { id: 'U_ALICE', team_id: teamId, name: 'alice' },
      team: { id: teamId },
      channel: { id: channelId },
      message: {
        ts: firstMessage.ts,
        thread_ts: userMessageTs,
      },
      actions: [
        {
          type: 'button',
          action_id: 'confirm_yes',
          block_id: 'actions_0',
          value: 'confirm_yes',
        },
      ],
    });

    expect(callbackWebhook.status).toBe(200);
    expect(callbackWebhook.body).toEqual({ ok: true });

    const allMessages = await waitFor('Slack callback response', () => {
      const messages = slack.getPostedMessages();
      return messages.length >= 2 ? messages : null;
    });

    expect(allMessages[1].body.text).toContain('Processing your order');
    expect(allMessages[1].body.text).toContain('choice=yes');
    expect(allMessages[1].body.thread_ts).toBe(userMessageTs);

    const resumedSessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=slack`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${setup.admin.token}`,
      },
    });

    expect(resumedSessions.status).toBe(200);
    expect(resumedSessions.body.sessions).toHaveLength(1);
    expect(resumedSessions.body.sessions[0].id).toBe(sessionList.sessions[0].id);
  });

  test('keeps threaded Slack channel callbacks bound to the originating thread session', async () => {
    const setup = await setupSlackChannel(SLACK_ACTION_AGENT_DSL);
    const [teamId, appId] = setup.externalIdentifier.split(':');
    const channelId = 'C_THREAD';
    const threadTs = '1700000150.000050';

    const firstWebhook = await postSlackJsonWebhook(setup, {
      type: 'event_callback',
      team_id: teamId,
      api_app_id: appId,
      event_id: 'EvSlackThread1001',
      event_time: 1_700_000_150,
      event: {
        type: 'message',
        channel: channelId,
        user: 'U_THREAD_USER',
        text: 'hello from thread',
        ts: '1700000150.000200',
        event_ts: '1700000150.000200',
        thread_ts: threadTs,
        channel_type: 'channel',
      },
    });

    expect(firstWebhook.status).toBe(200);

    const firstMessage = await waitFor('Slack threaded response', () => {
      const messages = slack.getPostedMessages();
      return messages.length > 0 ? messages[0] : null;
    });

    expect(firstMessage.body.thread_ts).toBe(threadTs);

    const initialSessions = await waitFor('Slack threaded session list', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=slack`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body : null;
    });

    expect(initialSessions.sessions).toHaveLength(1);

    const callbackWebhook = await postSlackInteractiveWebhook(setup, {
      type: 'block_actions',
      trigger_id: 'threaded.block',
      api_app_id: appId,
      user: { id: 'U_THREAD_USER', team_id: teamId, name: 'thread-user' },
      team: { id: teamId },
      channel: { id: channelId },
      message: {
        ts: firstMessage.ts,
        thread_ts: threadTs,
      },
      actions: [
        {
          type: 'button',
          action_id: 'confirm_yes',
          block_id: 'actions_thread',
          value: 'confirm_yes',
        },
      ],
    });

    expect(callbackWebhook.status).toBe(200);

    const resumedSessions = await waitFor('Slack threaded resumed session list', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=slack`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body : null;
    });

    expect(resumedSessions.sessions).toHaveLength(1);
    expect(resumedSessions.sessions[0].id).toBe(initialSessions.sessions[0].id);
  });

  test('streams Slack responses, ingests file attachments through APIs, and returns a sanitized attachment DTO', async () => {
    const setup = await setupSlackChannel(SLACK_STREAM_AGENT_DSL, {
      streaming: {
        enabled: true,
        chunkSize: 80,
      },
    });
    const [teamId, appId] = setup.externalIdentifier.split(':');

    const longResponse =
      'Streaming response segment. '.repeat(30) +
      'The attachment was processed through the real multimodal API.';
    mockLlm.register('stream and store this file', {
      content: longResponse,
    });

    slack.registerFile('F_STREAM_1', {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      content: 'attachment-content',
      requiredToken: setup.botToken,
    });

    const webhookResponse = await postSlackJsonWebhook(setup, {
      type: 'event_callback',
      team_id: teamId,
      api_app_id: appId,
      event_id: 'EvSlack2001',
      event_time: 1_700_000_200,
      event: {
        type: 'message',
        channel: 'C_STREAM',
        user: 'U_BOB',
        text: 'stream and store this file',
        ts: '1700000200.000200',
        event_ts: '1700000200.000200',
        channel_type: 'im',
        files: [
          {
            id: 'F_STREAM_1',
            name: 'notes.txt',
            mimetype: 'text/plain',
            filetype: 'text',
            size: 18,
            url_private_download: slack.getFileUrl('F_STREAM_1'),
            file_access: 'visible',
          },
        ],
      },
    });

    expect(webhookResponse.status).toBe(200);
    expect(webhookResponse.body).toEqual({ ok: true });

    await waitFor('Slack file download', () => {
      const downloads = slack.getFileDownloads();
      return downloads.length > 0 ? downloads[0] : null;
    });

    const streamStart = await waitFor('Slack stream start', () => {
      const starts = slack.getStreamStarts();
      return starts.length > 0 ? starts[0] : null;
    });

    expect(streamStart.token).toBe(setup.botToken);

    const streamStop = await waitFor('Slack stream stop', () => {
      const stops = slack.getStreamStops();
      return stops.length > 0 ? stops[stops.length - 1] : null;
    });

    const appendedText = slack
      .getStreamAppends()
      .map((request) => String(request.body.markdown_text ?? ''))
      .join('');
    const stoppedText = String(streamStop.body.markdown_text ?? '');

    expect(appendedText.length).toBeGreaterThan(0);
    expect(appendedText + stoppedText).toBe(longResponse);
    expect(slack.getPostedMessages()).toHaveLength(0);

    const sessions = await waitFor('Slack attachment session', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=slack`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body.sessions : null;
    });

    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0].id;

    const attachments = await waitFor('Slack uploaded attachment', async () => {
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
