import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { startChannelQueues, stopChannelQueues } from '../../services/queues/index.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
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

const E2E_TIMEOUT_MS = 90_000;

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

const describeSlackAttachmentWebhookE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeSlackAttachmentWebhookE2E('Slack attachment webhook E2E', () => {
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

    harness = await startRuntimeServerHarness({
      MULTIMODAL_SERVICE_URL: multimodal.baseUrl,
      REDIS_ENABLED: 'true',
      REDIS_URL: redis.url,
    });

    await initializeRedis();
    await startChannelQueues();
  }, E2E_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness?.resetRuntimeState();
    await redis?.clear();
    await setSuperAdmins([]);
    slack?.reset();
    mockLlm?.reset();
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (slack) await slack.close();
    if (redis) await redis.close();
    if (multimodal) await multimodal.close();
  }, E2E_TIMEOUT_MS);

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
      endpointUrl: mockLlm!.url,
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

  async function setupSlackChannel(): Promise<SlackChannelSetup> {
    const admin = await provisionWebhookProject(STATIC_AGENT_DSL, 'slack-attachment-webhook');
    const externalIdentifier = uniqueSlackExternalIdentifier();
    const botToken = `xoxb-test-${Math.random().toString(36).slice(2, 10)}`;
    const signingSecret = `slack-secret-${Math.random().toString(36).slice(2, 10)}`;

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'slack',
      display_name: 'Slack Attachment Webhook Test Channel',
      external_identifier: externalIdentifier,
      credentials: {
        bot_token: botToken,
        signing_secret: signingSecret,
      },
      config: {
        slackApiBaseUrl: slack!.baseUrl,
      },
    });

    return {
      admin,
      externalIdentifier,
      botToken,
      signingSecret,
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

  async function postSlackGenericWebhook(
    setup: SlackChannelSetup,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSlackBody(setup.signingSecret, rawBody, timestamp);

    const response = await fetch(`${harness!.baseUrl}/api/v1/channels/slack/webhook`, {
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

  test(
    'processes a Slack file_share webhook and exposes the uploaded attachment through the session API',
    async () => {
      const setup = await setupSlackChannel();
      const [teamId, appId] = setup.externalIdentifier.split(':');
      const fileId = 'F_SLACK_ATTACHMENT_1';
      const fileContent = Buffer.from('slack-image-content', 'utf8');

      slack!.registerFile(fileId, {
        filename: 'test-slack-image.png',
        mimeType: 'image/png',
        content: fileContent,
        requiredToken: setup.botToken,
      });

      const webhook = await postSlackGenericWebhook(setup, {
        type: 'event_callback',
        team_id: teamId,
        api_app_id: appId,
        event_id: 'EvSlackFile001',
        event_time: 1_700_000_003,
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'D_ATTACHMENT',
          user: 'U_ATTACHMENT',
          text: 'What is this image?',
          ts: '1700000003.000100',
          event_ts: '1700000003.000100',
          channel_type: 'im',
          upload: true,
          files: [
            {
              id: fileId,
              name: 'test-slack-image.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: fileContent.length,
              url_private_download: slack!.getFileUrl(fileId),
              file_access: 'visible',
            },
          ],
        },
      });

      expect(webhook.status).toBe(200);
      expect(webhook.body).toEqual({ ok: true });

      const download = await waitFor('Slack file download', () => {
        const downloads = slack!.getFileDownloads();
        return downloads.length > 0 ? downloads[0] : null;
      });

      expect(download).toEqual({
        fileId,
        token: setup.botToken,
      });

      const postedMessage = await waitFor('Slack file response', () => {
        const messages = slack!.getPostedMessages();
        return messages.length > 0 ? messages[0] : null;
      });

      expect(postedMessage.token).toBe(setup.botToken);
      expect(postedMessage.body.text).toBe('Webhook processed.');

      const sessions = await waitFor('Slack file session', async () => {
        const result = await listProjectSessions(setup.admin.projectId, setup.admin.token, 'slack');
        return result.length > 0 ? result : null;
      });

      expect(sessions).toHaveLength(1);

      const attachments = await waitFor('Slack uploaded attachment', async () => {
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
          filename: 'test-slack-image.png',
          originalFilename: 'test-slack-image.png',
          mimeType: 'image/png',
        }),
      );
      expect(attachments[0]).not.toHaveProperty('storageKey');
      expect(attachments[0]).not.toHaveProperty('contentHash');
      expect(attachments[0]).not.toHaveProperty('tenantId');
      expect(attachments[0]).not.toHaveProperty('projectId');
      expect(attachments[0]).not.toHaveProperty('sessionId');
    },
    E2E_TIMEOUT_MS,
  );
});
