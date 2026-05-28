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

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

const ROOT_SUPERVISOR_DSL = `
SUPERVISOR: Root_Supervisor

GOAL: "Route work to the right specialist"
PERSONA: "A careful supervisor that routes requests to the correct agent"

HANDOFF:
  - TO: Child_No_Route
    WHEN: route_choice == "child"
    RETURN: false

  - TO: Billing_Specialist
    WHEN: route_choice == "billing"
    RETURN: false
`;

const CHILD_NO_ROUTE_DSL = `
AGENT: Child_No_Route

GOAL: "Handle requests directly without routing them away"
PERSONA: "A helpful agent that should never hand off to another agent"
`;

const BILLING_SPECIALIST_DSL = `
AGENT: Billing_Specialist

GOAL: "Handle billing questions"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Billing specialist reached."
  THEN: COMPLETE
`;

const FALLBACK_HANDLER_DSL = `
AGENT: Fallback_Handler

GOAL: "Handle fallback supervisor traffic"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Fallback reached."
  THEN: COMPLETE
`;

const PARENT_TRIGGER = 'route this to the child first';
const CHILD_TRIGGER = 'child attempts unauthorized transfer';
const CHILD_FALLBACK_RESPONSE =
  'I cannot transfer you there, but I can keep helping directly from here.';

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;

type ChatAgentResponse = {
  sessionId: string;
  response: string;
  traceEvents?: Array<{
    type: string;
    data: Record<string, unknown>;
  }>;
};

type SessionDetailResponse = {
  success: boolean;
  session: {
    id: string;
    agentName: string;
    activeThreadIndex?: number;
    threads?: Array<{
      agentName?: string;
      status?: string;
    }>;
    traceEvents?: Array<{
      type: string;
      data: Record<string, unknown>;
    }>;
  };
};

beforeAll(async () => {
  harness = await startRuntimeServerHarness();
  mockLlm = await startMockLLM();
}, SUITE_TIMEOUT_MS);

beforeEach(async () => {
  clearPermissionCache();
  await harness.resetRuntimeState();
  await setSuperAdmins([]);
  mockLlm.reset();
});

afterAll(async () => {
  await harness.close();
  await mockLlm.close();
}, SUITE_TIMEOUT_MS);

describe('E2E: child routing authority sanitization', () => {
  test(
    'rejects a child reasoning agent that tries to reuse the parent handoff authority',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('routing-authority-admin'),
        uniqueSlug('tenant-routing-authority'),
        uniqueSlug('project-routing-authority'),
      );

      await importProjectFiles(harness, admin.token, admin.projectId, {
        'agents/root-supervisor.agent.abl': ROOT_SUPERVISOR_DSL,
        'agents/child-no-route.agent.abl': CHILD_NO_ROUTE_DSL,
        'agents/billing-specialist.agent.abl': BILLING_SPECIALIST_DSL,
        'agents/fallback-handler.agent.abl': FALLBACK_HANDLER_DSL,
      });

      await provisionTenantModel(harness, admin.token, {
        targetTenantId: admin.tenantId,
        displayName: 'Mock Routing Authority Model',
        integrationType: 'api',
        provider: 'openai_compatible',
        modelId: 'mock-routing-authority-model',
        endpointUrl: mockLlm.url,
        supportsStreaming: false,
        supportsTools: true,
        capabilities: ['text', 'tools'],
        tier: 'balanced',
        isDefault: true,
        connection: {
          credentialName: 'mock-routing-authority-model',
          apiKey: 'test-api-key',
        },
      });

      mockLlm.registerToolCall(PARENT_TRIGGER, {
        name: 'handoff_to_Child_No_Route',
        arguments: {
          reason: 'The child agent should take the next step first.',
          message: CHILD_TRIGGER,
        },
        followUpContent: 'Transferring to the child agent.',
      });

      mockLlm.registerToolCall(CHILD_TRIGGER, {
        name: 'handoff_to_Billing_Specialist',
        arguments: {
          reason: 'Trying to use inherited routing authority.',
          message: 'Please talk to billing instead.',
        },
        followUpContent: CHILD_FALLBACK_RESPONSE,
      });

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Root_Supervisor',
          message: PARENT_TRIGGER,
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBeTruthy();
      expect(chatResponse.body.response).toContain(CHILD_FALLBACK_RESPONSE);

      const denialTrace = chatResponse.body.traceEvents?.find(
        (event) => event.type === 'handoff_authority_denied',
      );
      expect(denialTrace).toBeDefined();
      expect(denialTrace?.data).toMatchObject({
        agentName: 'Child_No_Route',
        targetAgent: 'Billing_Specialist',
        reason: 'agent_not_configured_for_handoffs',
      });

      const detailResponse = await requestJson<SessionDetailResponse>(
        harness,
        `/api/projects/${admin.projectId}/sessions/${encodeURIComponent(chatResponse.body.sessionId)}`,
        {
          method: 'GET',
          headers: authHeaders(admin.token),
        },
      );

      expect(detailResponse.status).toBe(200);
      expect(detailResponse.body.success).toBe(true);

      const threadNames = (detailResponse.body.session.threads ?? []).map(
        (thread) => thread.agentName,
      );
      expect(threadNames).toContain('Root_Supervisor');
      expect(threadNames).toContain('Child_No_Route');
      expect(threadNames).toHaveLength(2);
      expect(threadNames).not.toContain('Billing_Specialist');
    },
    TEST_TIMEOUT_MS,
  );
});
