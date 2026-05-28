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
import { getSystemPromptForLastUserMessage } from '../helpers/mock-llm-request-utils.js';

const AGENT_WITH_PROFILE_DSL = `AGENT: Conversation_Behavior_Profile_Agent

GOAL: "Answer with the configured conversation behavior"

PERSONA: "A helpful assistant"

USE BEHAVIOR_PROFILE: http_compact

CONVERSATION:
  speaking:
    style: "warm and concise"
    language_policy: interaction_context
    max_sentences: 2
    one_thing_at_a_time: true
  listening:
    barge_in: allow
  interaction:
    clarification:
      mode: ask_only_when_blocked
      max_questions: 1
    confirmation:
      actions: before_sensitive_actions
`;

const HTTP_PROFILE_DSL = `BEHAVIOR_PROFILE: http_compact
PRIORITY: 5
WHEN: channel.name == "http"

CONVERSATION:
  speaking:
    max_sentences: 1
    tool_lead_in: brief
  interaction:
    closure: summarize_outcome
`;

const AGENT_BASE_ONLY_DSL = `AGENT: Conversation_Behavior_Base_Agent

GOAL: "Answer with only base conversation behavior"

PERSONA: "A helpful assistant"

CONVERSATION:
  speaking:
    style: "steady and direct"
    language_policy: interaction_context
    max_sentences: 2
  interaction:
    closure: summarize_outcome
`;

interface ChatAgentResponse {
  sessionId: string;
  response: string;
}

interface SessionTraceResponse {
  success: boolean;
  traces: Array<{ type: string; data: Record<string, unknown> }>;
}

function findTraceEvent(
  traces: Array<{ type: string; data: Record<string, unknown> }>,
  type: string,
): { type: string; data: Record<string, unknown> } | undefined {
  return traces.find((trace) => trace.type === type);
}

describe.sequential('conversation behavior chat e2e', () => {
  let harness!: RuntimeApiHarness;
  let mockLlm!: MockLLM;
  let admin!: Awaited<ReturnType<typeof bootstrapProject>>;

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
      uniqueEmail('conversation-behavior-admin'),
      uniqueSlug('tenant-conversation-behavior'),
      uniqueSlug('project-conversation-behavior'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/conversation-behavior-profile-agent.agent.abl': AGENT_WITH_PROFILE_DSL,
      'agents/conversation-behavior-base-agent.agent.abl': AGENT_BASE_ONLY_DSL,
      'behavior_profiles/http_compact.behavior_profile.abl': HTTP_PROFILE_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Conversation Behavior Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-conversation-behavior-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-conversation-behavior-model',
        apiKey: 'test-api-key',
      },
    });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, 120_000);

  test('applies merged conversation behavior to the system prompt and records capability-drop diagnostics', async () => {
    const userMessage = 'conversation behavior merge check';
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Conversation_Behavior_Profile_Agent',
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
    expect(systemPrompt).toContain('## Conversation Behavior');
    expect(systemPrompt).toContain('Adopt a warm and concise speaking style.');
    expect(systemPrompt).toContain(
      'Match the current interaction language (fr) and respect locale fr-FR and timezone Europe/Paris when phrasing responses.',
    );
    expect(systemPrompt).toContain('Keep most replies to 1 sentence or fewer.');
    expect(systemPrompt).toContain('Ask for or present one thing at a time.');
    expect(systemPrompt).toContain('Use brief tool lead-ins.');
    expect(systemPrompt).toContain('Close turns with summarize outcome.');
    expect(systemPrompt).not.toContain('For voice turns, barge-in should allow.');

    const traces = await requestJson<SessionTraceResponse>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${response.body.sessionId}/traces`,
      {
        headers: authHeaders(admin.token),
      },
    );

    expect(traces.status).toBe(200);
    expect(traces.body.success).toBe(true);

    const profileResolution = findTraceEvent(traces.body.traces, 'profile_resolution');
    expect(profileResolution).toBeDefined();
    expect(profileResolution?.data.evaluatedProfiles).toEqual(['http_compact']);
    expect(profileResolution?.data.matchedProfiles).toEqual(['http_compact']);
    expect(profileResolution?.data.channel).toBe('http');
    expect(profileResolution?.data.effectiveSummary).toMatchObject({
      hasConversationBehavior: true,
      conversationBehaviorSourceChain: ['agent', 'profile:http_compact'],
      conversationBehaviorCapabilityDrops: 1,
      conversationBehaviorCapabilityDropDetails: [
        expect.objectContaining({
          fieldPath: 'listening.barge_in',
          reason: 'voice_channel_required',
        }),
      ],
    });
  });

  test('emits profile-resolution diagnostics for base conversation behavior even without matching profiles', async () => {
    const userMessage = 'base conversation behavior check';
    const response = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        projectId: admin.projectId,
        agentId: 'Conversation_Behavior_Base_Agent',
        message: userMessage,
        interactionContext: {
          language: 'es',
          locale: 'es-MX',
          timezone: 'America/Mexico_City',
        },
      },
    });

    expect(response.status).toBe(200);

    const systemPrompt = getSystemPromptForLastUserMessage(mockLlm, userMessage);
    expect(systemPrompt).toContain('Adopt a steady and direct speaking style.');
    expect(systemPrompt).toContain(
      'Match the current interaction language (es) and respect locale es-MX and timezone America/Mexico_City when phrasing responses.',
    );
    expect(systemPrompt).toContain('Keep most replies to 2 sentences or fewer.');

    const traces = await requestJson<SessionTraceResponse>(
      harness,
      `/api/projects/${admin.projectId}/sessions/${response.body.sessionId}/traces`,
      {
        headers: authHeaders(admin.token),
      },
    );

    expect(traces.status).toBe(200);

    const profileResolution = findTraceEvent(traces.body.traces, 'profile_resolution');
    expect(profileResolution).toBeDefined();
    expect(profileResolution?.data.evaluatedProfiles).toEqual([]);
    expect(profileResolution?.data.matchedProfiles).toEqual([]);
    expect(profileResolution?.data.effectiveSummary).toMatchObject({
      hasConversationBehavior: true,
      conversationBehaviorSourceChain: ['agent'],
      conversationBehaviorCapabilityDrops: 0,
      conversationBehaviorCapabilityDropDetails: [],
    });
  });
});
