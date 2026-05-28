import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import projectIoRouter from '../../routes/project-io.js';
import channelConnectionsRouter from '../../routes/channel-connections.js';
import sessionsRouter from '../../routes/sessions.js';
import channelAudiocodesRouter from '../../routes/channel-audiocodes.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { disconnectRedis, initializeRedis } from '../../services/redis/redis-client.js';
import { startChannelQueues, stopChannelQueues } from '../../services/queues/index.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from '../helpers/redis-server-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  extractRuntimeInteractionBlock,
  getSystemPromptForLastUserMessage,
} from '../helpers/mock-llm-request-utils.js';

const AUDIOCODES_DATE_AGENT_DSL = `
AGENT: AudioCodes_Interaction_Date

GOAL: "Capture the caller's departure date"

PERSONA: "A travel assistant"

GATHER:
  departure_date:
    prompt: "What is your departure date?"
    type: date
    required: true

COMPLETE:
  - WHEN: all_fields_gathered == true
    RESPOND: "Departure date is {{departure_date}}."
`;

function localDateInTimeZone(timeZone: string, dayOffset: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '0');
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '1');
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '1');
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
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

const describeAudioCodesInteractionContext = isRedisServerHarnessAvailable()
  ? describe.sequential
  : describe.skip;

describeAudioCodesInteractionContext('AudioCodes interaction context E2E', () => {
  let harness!: RuntimeApiHarness;
  let redis!: RedisServerHarness;
  let mockLlm!: MockLLM;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    redis = await startRedisServerHarness();
    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/projects/:projectId/channel-connections', channelConnectionsRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
        app.use('/api/v1/channels/audiocodes', channelAudiocodesRouter);
      },
      {
        REDIS_ENABLED: 'true',
        REDIS_URL: redis.url,
      },
      {
        requireAsyncInfra: false,
      },
    );

    await initializeRedis();
    await startChannelQueues();
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await redis.clear();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    await stopChannelQueues();
    await disconnectRedis();
    if (harness) {
      await harness.close();
    }
    if (redis) {
      await redis.close();
    }
    if (mockLlm) {
      await mockLlm.close();
    }
  }, 120_000);

  test('uses AudioCodes language hints when the channel only supplies language and no locale', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('audiocodes-interaction-admin'),
      uniqueSlug('tenant-audiocodes-interaction'),
      uniqueSlug('project-audiocodes-interaction'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/audiocodes-interaction-date.agent.abl': AUDIOCODES_DATE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock AudioCodes Interaction Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-audiocodes-interaction-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-audiocodes-interaction-model',
        apiKey: 'test-api-key',
      },
    });

    const identifier = uniqueSlug('audiocodes-interaction');
    await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'audiocodes',
      display_name: 'AudioCodes Interaction Context',
      external_identifier: identifier,
      credentials: {
        inboundAuthToken: 'audiocodes-secret',
      },
      config: {
        language: 'es',
      },
    });

    const conversationId = uniqueSlug('audiocodes-conversation');
    const initResponse = await fetch(
      `${harness.baseUrl}/api/v1/channels/audiocodes/webhook/${encodeURIComponent(identifier)}?token=audiocodes-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: conversationId }),
      },
    );

    expect(initResponse.status).toBe(200);
    const initPayload = (await initResponse.json()) as { activitiesURL: string };

    const activitiesUrl = new URL(initPayload.activitiesURL, harness.baseUrl).toString();
    const activitiesResponse = await fetch(activitiesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activities: [
          {
            type: 'message',
            text: 'mañana',
          },
        ],
      }),
    });

    expect(activitiesResponse.status).toBe(200);

    const expectedDate = localDateInTimeZone('UTC', 1);
    const systemPrompt = await waitFor('AudioCodes runtime interaction prompt', async () => {
      const prompt = getSystemPromptForLastUserMessage(mockLlm, 'mañana');
      return prompt.length > 0 ? prompt : null;
    });

    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);

    expect(runtimeInteraction).toContain('"language": "es"');
    expect(systemPrompt).toContain(`"departure_date": "${expectedDate}"`);
  }, 90_000);
});
