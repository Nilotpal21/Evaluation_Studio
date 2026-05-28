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
import { startTwilioApiHarness, type TwilioApiHarness } from '../helpers/twilio-api-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const TWILIO_E2E_TIMEOUT_MS = 90_000;

const TWILIO_CONTEXT_AGENT_DSL = `
AGENT: Twilio_Context_Agent

GOAL: "Collect user context across multiple SMS turns"

FLOW:
  entry_point: collect_name
  steps:
    - collect_name
    - collect_topic
    - summary

collect_name:
  REASONING: false
  GATHER:
    - name: required
  THEN: collect_topic

collect_topic:
  REASONING: false
  GATHER:
    - topic: required
  THEN: summary

summary:
  REASONING: false
  RESPOND: "Summary for {{name}} about {{topic}}."
  THEN: COMPLETE
`;

const TWILIO_ACTION_AGENT_DSL = `
AGENT: Twilio_Action_Agent
GOAL: "Produce rich output that must degrade to plain SMS text"
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

interface TwilioChannelSetup {
  admin: {
    token: string;
    userId: string;
    tenantId: string;
    projectId: string;
  };
  twilioNumber: string;
  accountSid: string;
  authToken: string;
}

function uniqueTwilioNumber(): string {
  const suffix = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
  return `+1555${suffix}`;
}

function uniqueAccountSid(): string {
  return `AC${crypto.randomBytes(16).toString('hex')}`;
}

function uniqueAuthToken(): string {
  return `twilio-auth-${crypto.randomBytes(8).toString('hex')}`;
}

function buildBasicAuthorization(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

function signTwilioWebhook(
  authToken: string,
  webhookUrl: string,
  form: Record<string, string>,
): string {
  const data =
    webhookUrl +
    Object.keys(form)
      .sort()
      .map((key) => `${key}${form[key]}`)
      .join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
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

const describeTwilioRuntimeE2E = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeTwilioRuntimeE2E('Twilio runtime channel E2E', () => {
  let harness: RuntimeApiHarness | undefined;
  let multimodal: MultimodalServiceHarness | undefined;
  let redis: RedisServerHarness | undefined;
  let twilio: TwilioApiHarness | undefined;
  let mockLlm: MockLLM | undefined;

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    redis = await startRedisServerHarness();
    twilio = await startTwilioApiHarness();
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
    twilio?.reset();
    mockLlm?.reset();
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) await harness.close();
    if (mockLlm) await mockLlm.close();
    if (twilio) await twilio.close();
    if (redis) await redis.close();
    if (multimodal) await multimodal.close();
  });

  async function setupTwilioChannel(agentDsl: string): Promise<TwilioChannelSetup> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('twilio-admin'),
      uniqueSlug('tenant-twilio'),
      uniqueSlug('project-twilio'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/twilio.agent.abl': agentDsl,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Twilio Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-twilio-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-twilio-model',
        apiKey: 'test-api-key',
      },
    });

    const twilioNumber = uniqueTwilioNumber();
    const accountSid = uniqueAccountSid();
    const authToken = uniqueAuthToken();

    twilio.registerAccount(accountSid, authToken);

    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'twilio_sms',
      display_name: 'Twilio Test Channel',
      external_identifier: twilioNumber,
      credentials: {
        account_sid: accountSid,
        auth_token: authToken,
      },
      config: {
        from_number: twilioNumber,
        twilioApiBaseUrl: twilio.apiBaseUrl,
      },
    });

    return {
      admin,
      twilioNumber,
      accountSid,
      authToken,
    };
  }

  async function postTwilioWebhook(
    setup: TwilioChannelSetup,
    form: Record<string, string>,
    options?: { authToken?: string },
  ): Promise<{ status: number; text: string }> {
    const path = `/api/v1/channels/twilio_sms/webhook/${encodeURIComponent(setup.twilioNumber)}`;
    const webhookUrl = `${harness.baseUrl}${path}`;
    const signature = signTwilioWebhook(options?.authToken ?? setup.authToken, webhookUrl, form);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: new URLSearchParams(form).toString(),
    });

    return {
      status: response.status,
      text: await response.text(),
    };
  }

  test(
    'rejects Twilio SMS webhook calls with an invalid signature',
    async () => {
      const setup = await setupTwilioChannel(TWILIO_ACTION_AGENT_DSL);

      const response = await postTwilioWebhook(
        setup,
        {
          MessageSid: 'SM00000000000000000000000000000001',
          AccountSid: setup.accountSid,
          From: '+15551234567',
          To: setup.twilioNumber,
          Body: 'hello',
          NumMedia: '0',
        },
        { authToken: 'wrong-auth-token' },
      );

      expect(response.status).toBe(401);
      expect(JSON.parse(response.text)).toEqual({ error: 'Invalid signature' });
      expect(twilio.getSentMessages()).toHaveLength(0);
    },
    TWILIO_E2E_TIMEOUT_MS,
  );

  test('reuses the same Twilio session across SMS turns and preserves gathered context', async () => {
    const setup = await setupTwilioChannel(TWILIO_CONTEXT_AGENT_DSL);
    const callerNumber = '+15551234567';
    const expectedAuthorization = buildBasicAuthorization(setup.accountSid, setup.authToken);

    mockLlm.registerToolCall('Alice', {
      name: '_extract_entities',
      arguments: { name: 'Alice' },
      followUpContent: '{}',
    });
    mockLlm.registerToolCall('tenant isolation', {
      name: '_extract_entities',
      arguments: { topic: 'tenant isolation' },
      followUpContent: '{}',
    });

    const firstWebhook = await postTwilioWebhook(setup, {
      MessageSid: 'SM00000000000000000000000000001001',
      AccountSid: setup.accountSid,
      From: callerNumber,
      To: setup.twilioNumber,
      Body: 'start',
      NumMedia: '0',
    });

    expect(firstWebhook.status).toBe(200);
    expect(firstWebhook.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const firstOutbound = await waitFor('first Twilio SMS response', () => {
      const messages = twilio.getSentMessages();
      return messages.length > 0 ? messages[0] : null;
    });

    expect(firstOutbound.authorization).toBe(expectedAuthorization);
    expect(firstOutbound.body.To).toBe(callerNumber);
    expect(firstOutbound.body.From).toBe(setup.twilioNumber);
    expect(firstOutbound.body.Body.toLowerCase()).toContain('name');

    const initialSessions = await waitFor('Twilio session list', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=twilio_sms`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body : null;
    });

    expect(initialSessions.sessions).toHaveLength(1);

    const secondWebhook = await postTwilioWebhook(setup, {
      MessageSid: 'SM00000000000000000000000000001002',
      AccountSid: setup.accountSid,
      From: callerNumber,
      To: setup.twilioNumber,
      Body: 'Alice',
      NumMedia: '0',
    });

    expect(secondWebhook.status).toBe(200);
    expect(secondWebhook.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const secondOutbound = await waitFor('second Twilio SMS response', () => {
      const messages = twilio.getSentMessages();
      return messages.length >= 2 ? messages[1] : null;
    });

    expect(secondOutbound.authorization).toBe(expectedAuthorization);
    expect(secondOutbound.body.Body.toLowerCase()).toContain('topic');

    const thirdWebhook = await postTwilioWebhook(setup, {
      MessageSid: 'SM00000000000000000000000000001003',
      AccountSid: setup.accountSid,
      From: callerNumber,
      To: setup.twilioNumber,
      Body: 'tenant isolation',
      NumMedia: '0',
    });

    expect(thirdWebhook.status).toBe(200);
    expect(thirdWebhook.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    const allMessages = await waitFor('final Twilio SMS response', () => {
      const messages = twilio.getSentMessages();
      return messages.length >= 3 ? messages : null;
    });

    expect(allMessages[2].authorization).toBe(expectedAuthorization);
    expect(allMessages[2].body.Body).toContain('Alice');
    expect(allMessages[2].body.Body).toContain('tenant isolation');

    const resumedSessions = await requestJson<{
      success: boolean;
      sessions: Array<{ id: string }>;
    }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=twilio_sms`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${setup.admin.token}`,
      },
    });

    expect(resumedSessions.status).toBe(200);
    expect(resumedSessions.body.sessions).toHaveLength(1);
    expect(resumedSessions.body.sessions[0].id).toBe(initialSessions.sessions[0].id);
  });

  test('ingests MMS attachments through APIs and downgrades rich output to plain SMS text', async () => {
    const setup = await setupTwilioChannel(TWILIO_ACTION_AGENT_DSL);
    const callerNumber = '+15557654321';
    const messageSid = 'SM00000000000000000000000000002001';
    const mediaSid = 'ME00000000000000000000000000000001';
    const expectedAuthorization = buildBasicAuthorization(setup.accountSid, setup.authToken);

    twilio.registerMedia({
      accountSid: setup.accountSid,
      messageSid,
      mediaSid,
      contentType: 'text/plain',
      content: 'attachment-content',
    });

    const webhookResponse = await postTwilioWebhook(setup, {
      MessageSid: messageSid,
      AccountSid: setup.accountSid,
      From: callerNumber,
      To: setup.twilioNumber,
      Body: 'hello',
      NumMedia: '1',
      MediaUrl0: twilio.getMediaUrl(setup.accountSid, messageSid, mediaSid),
      MediaContentType0: 'text/plain',
    });

    expect(webhookResponse.status).toBe(200);
    expect(webhookResponse.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );

    const mediaDownload = await waitFor('Twilio MMS media download', () => {
      const downloads = twilio.getMediaDownloads();
      return downloads.length > 0 ? downloads[0] : null;
    });

    expect(mediaDownload.authorization).toBe(expectedAuthorization);

    const outbound = await waitFor('Twilio outbound SMS', () => {
      const messages = twilio.getSentMessages();
      return messages.length > 0 ? messages[0] : null;
    });

    expect(outbound.authorization).toBe(expectedAuthorization);
    expect(outbound.body.To).toBe(callerNumber);
    expect(outbound.body.From).toBe(setup.twilioNumber);
    expect(outbound.body.Body).toBe('Confirm order?');

    const sessions = await waitFor('Twilio MMS session', async () => {
      const response = await requestJson<{
        success: boolean;
        sessions: Array<{ id: string }>;
      }>(harness, `/api/projects/${setup.admin.projectId}/sessions?channel=twilio_sms`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${setup.admin.token}`,
        },
      });

      return response.body.sessions.length > 0 ? response.body.sessions : null;
    });

    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0].id;

    const attachments = await waitFor('Twilio uploaded attachment', async () => {
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
        filename: expect.stringMatching(/^twilio_mms_0_\d+\.txt$/),
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
