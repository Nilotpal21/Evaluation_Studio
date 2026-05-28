import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../../../../apps/runtime/src/__tests__/helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../../../../apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';
import {
  extractRuntimeInteractionBlock,
  getSystemPromptForLastUserMessage,
} from '../../../../apps/runtime/src/__tests__/helpers/mock-llm-request-utils.js';

const A2A_DATE_AGENT_DSL = `
AGENT: A2A_Interaction_Date

GOAL: "Capture the user's departure date"

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

describe.sequential('A2A interaction context E2E', () => {
  let harness: RuntimeApiHarness | null = null;
  let mockLlm: MockLLM | null = null;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness();
  }, 240_000);

  beforeEach(async () => {
    if (!harness || !mockLlm) {
      throw new Error('A2A harness setup did not complete');
    }

    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
      harness = null;
    }
    if (mockLlm) {
      await mockLlm.close();
      mockLlm = null;
    }
  }, 240_000);

  test('propagates explicit interaction context through /a2a and ignores conflicting legacy clientInfo', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('a2a-interaction-admin'),
      uniqueSlug('tenant-a2a-interaction'),
      uniqueSlug('project-a2a-interaction'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/a2a-interaction-date.agent.abl': A2A_DATE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock A2A Interaction Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-a2a-interaction-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-a2a-interaction-model',
        apiKey: 'test-api-key',
      },
    });

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'a2a',
      display_name: 'A2A Interaction Context',
      external_identifier: uniqueSlug('a2a-interaction'),
      config: {
        a2aApiKey: 'a2a-secret',
      },
    });

    const response = await fetch(`${harness.baseUrl}/a2a/${connection.id}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer a2a-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'a2a-interaction-1',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'a2a-message-1',
            contextId: 'a2a-interaction-context',
            role: 'user',
            parts: [{ kind: 'text', text: 'mañana a2a' }],
            metadata: {
              interactionContext: {
                language: 'es',
                locale: 'es-MX',
                timezone: 'America/Mexico_City',
              },
              sessionMetadata: {
                clientInfo: {
                  locale: 'pt-BR',
                  timezone: 'America/Sao_Paulo',
                },
              },
            },
          },
        },
      }),
    });

    expect(response.status).toBe(200);

    const systemPrompt = await waitFor('A2A runtime interaction prompt', async () => {
      const prompt = getSystemPromptForLastUserMessage(mockLlm, 'mañana a2a');
      return prompt.length > 0 ? prompt : null;
    });

    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);
    const expectedDate = localDateInTimeZone('America/Mexico_City', 1);

    expect(runtimeInteraction).toContain('"language": "es"');
    expect(runtimeInteraction).toContain('"locale": "es-MX"');
    expect(runtimeInteraction).toContain('"timezone": "America/Mexico_City"');
    expect(runtimeInteraction).not.toContain('"locale": "pt-BR"');
    expect(runtimeInteraction).not.toContain('"timezone": "America/Sao_Paulo"');
    expect(systemPrompt).toContain(`"departure_date": "${expectedDate}"`);
  }, 90_000);
});
