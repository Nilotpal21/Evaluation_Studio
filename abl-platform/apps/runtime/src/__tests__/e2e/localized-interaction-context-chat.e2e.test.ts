import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  extractRuntimeInteractionBlock,
  findRuntimeInteractionRequestsForLastUserMessage,
  getSystemPromptForLastUserMessage,
} from '../helpers/mock-llm-request-utils.js';

const CONTEXT_REASONING_AGENT_DSL = `
AGENT: Interaction_Context_Reasoner

GOAL: "Answer briefly while respecting the current interaction context"

PERSONA: "A concise assistant"
`;

const DATE_CAPTURE_AGENT_DSL = `
AGENT: Interaction_Date_Capture

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

interface ChatAgentResponse {
  sessionId: string;
  response: string;
  state?: {
    context?: Record<string, unknown>;
  };
}

interface SessionDetailResponse {
  success: boolean;
  session: {
    state: {
      context?: Record<string, unknown>;
    };
  };
}

describe.sequential('localized interaction context REST chat E2E', () => {
  let harness!: RuntimeApiHarness;
  let mockLlm!: MockLLM;
  let admin!: Awaited<ReturnType<typeof bootstrapProject>>;
  let dateAdmin!: Awaited<ReturnType<typeof bootstrapProject>>;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness();
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();

    admin = await bootstrapProject(
      harness,
      uniqueEmail('localized-chat-admin'),
      uniqueSlug('tenant-localized-chat'),
      uniqueSlug('project-localized-chat'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/interaction-context-reasoner.agent.abl': CONTEXT_REASONING_AGENT_DSL,
      'agents/interaction-date-capture.agent.abl': DATE_CAPTURE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Localized Interaction Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-localized-interaction-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-localized-interaction-model',
        apiKey: 'test-api-key',
      },
    });

    dateAdmin = await bootstrapProject(
      harness,
      uniqueEmail('localized-date-admin'),
      uniqueSlug('tenant-localized-date'),
      uniqueSlug('project-localized-date'),
    );

    await importProjectFiles(harness, dateAdmin.token, dateAdmin.projectId, {
      'agents/interaction-date-capture.agent.abl': DATE_CAPTURE_AGENT_DSL,
    });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, 120_000);

  test('injects explicit interaction context into the main assistant prompt', async () => {
    const userMessage = 'explicit context check';
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Interaction_Context_Reasoner',
        message: userMessage,
        interactionContext: {
          language: 'fr',
          locale: 'fr-FR',
          timezone: 'Europe/Paris',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBeTruthy();

    const systemPrompt = getSystemPromptForLastUserMessage(mockLlm, userMessage);
    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);

    expect(runtimeInteraction).toContain('"interactionContext"');
    expect(runtimeInteraction).toContain('"language": "fr"');
    expect(runtimeInteraction).toContain('"locale": "fr-FR"');
    expect(runtimeInteraction).toContain('"timezone": "Europe/Paris"');
  });

  test('keeps legacy clientInfo locale/timezone compatibility on REST chat', async () => {
    const userMessage = 'legacy client info check';
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Interaction_Context_Reasoner',
        message: userMessage,
        sessionMetadata: {
          clientInfo: {
            locale: 'pt-BR',
            timezone: 'America/Sao_Paulo',
          },
        },
      },
    });

    expect(response.status).toBe(200);

    const systemPrompt = getSystemPromptForLastUserMessage(mockLlm, userMessage);
    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);

    expect(runtimeInteraction).toContain('"locale": "pt-BR"');
    expect(runtimeInteraction).toContain('"timezone": "America/Sao_Paulo"');
  });

  test('prefers explicit interaction context over conflicting metadata and legacy clientInfo inputs', async () => {
    const userMessage = 'interaction precedence check';
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Interaction_Context_Reasoner',
        message: userMessage,
        metadata: {
          language: 'de',
          locale: 'de-DE',
          timezone: 'Europe/Berlin',
        },
        sessionMetadata: {
          clientInfo: {
            locale: 'pt-BR',
            timezone: 'America/Sao_Paulo',
          },
        },
        interactionContext: {
          language: 'es',
          locale: 'es-MX',
          timezone: 'America/Mexico_City',
        },
      },
    });

    expect(response.status).toBe(200);

    const systemPrompt = getSystemPromptForLastUserMessage(mockLlm, userMessage);
    const runtimeInteraction = extractRuntimeInteractionBlock(systemPrompt);

    expect(runtimeInteraction).toContain('"language": "es"');
    expect(runtimeInteraction).toContain('"locale": "es-MX"');
    expect(runtimeInteraction).toContain('"timezone": "America/Mexico_City"');
  });

  test('resolves "a week from tomorrow" against the caller timezone instead of the host timezone', async () => {
    const expectedDate = localDateInTimeZone('America/Los_Angeles', 8);
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(dateAdmin.token),
      body: {
        projectId: dateAdmin.projectId,
        agentId: 'Interaction_Date_Capture',
        message: 'a week from tomorrow',
        interactionContext: {
          locale: 'en-US',
          timezone: 'America/Los_Angeles',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.state?.context?.departure_date).toBe(expectedDate);
  });

  test('parses non-English relative dates when the caller only provides language and timezone', async () => {
    const expectedDate = localDateInTimeZone('America/Mexico_City', 1);
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(dateAdmin.token),
      body: {
        projectId: dateAdmin.projectId,
        agentId: 'Interaction_Date_Capture',
        message: 'mañana',
        interactionContext: {
          language: 'es',
          timezone: 'America/Mexico_City',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.state?.context?.departure_date).toBe(expectedDate);
  });

  test('does not deduplicate identical REST messages when their explicit interaction context differs', async () => {
    const first = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Interaction_Context_Reasoner',
        message: 'same text different context',
        interactionContext: {
          language: 'en',
          locale: 'en-US',
          timezone: 'UTC',
        },
      },
    });

    const second = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        sessionId: first.body.sessionId,
        message: 'same text different context',
        interactionContext: {
          language: 'es',
          locale: 'es-MX',
          timezone: 'America/Mexico_City',
        },
      },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const matchingRequests = findRuntimeInteractionRequestsForLastUserMessage(
      mockLlm,
      'same text different context',
    );

    expect(matchingRequests).toHaveLength(2);
  });
});
