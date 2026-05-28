import crypto from 'node:crypto';
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
  type BootstrapProjectResult,
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  startMockA2ARemoteAgent,
  type MockA2ACallbackDelivery,
  type MockA2ARemoteAgent,
} from '../helpers/mock-a2a-remote-agent.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

const RETURN_SUPERVISOR_DSL = `
SUPERVISOR: Return_Supervisor

GOAL: "Route billing work to the billing specialist and resume after completion"
PERSONA: "A careful routing supervisor"

HANDOFF:
  - TO: Billing_Return_Agent
    WHEN: route_choice == "billing"
    RETURN: true
`;

const BILLING_RETURN_AGENT_DSL = `
AGENT: Billing_Return_Agent

GOAL: "Resolve billing questions and return control to the supervisor"

FLOW:
  entry_point: resolve
  steps:
    - resolve

resolve:
  REASONING: false
  RESPOND: "Billing return agent resolved the billing issue."
  THEN: COMPLETE
`;

const MULTI_INTENT_SUPERVISOR_DSL = `
SUPERVISOR: Support_Multi_Intent_Supervisor

GOAL: "Route billing and shipping questions to the right specialists"
PERSONA: "A supervisor that coordinates multiple specialists"

HANDOFF:
  - TO: Billing_Local_Agent
    WHEN: intent.category == "billing"
    RETURN: false

  - TO: Shipping_Local_Agent
    WHEN: intent.category == "shipping"
    RETURN: false
`;

const BILLING_LOCAL_AGENT_DSL = `
AGENT: Billing_Local_Agent

GOAL: "Handle billing requests"

FLOW:
  entry_point: resolve
  steps:
    - resolve

resolve:
  REASONING: false
  RESPOND: "Billing specialist confirmed the invoice is corrected."
  THEN: COMPLETE
`;

const SHIPPING_LOCAL_AGENT_DSL = `
AGENT: Shipping_Local_Agent

GOAL: "Handle shipping requests"

FLOW:
  entry_point: resolve
  steps:
    - resolve

resolve:
  REASONING: false
  RESPOND: "Shipping specialist confirmed the package is on schedule."
  THEN: COMPLETE
`;

const SCRIPTED_MULTI_INTENT_FLOW_DSL = `
AGENT: Support_Scripted_Multi_Intent_Agent

GOAL: "Handle billing, shipping, and cancellation requests in a scripted flow"
PERSONA: "A deterministic support workflow that can queue or disambiguate requests"

FLOW:
  entry_point: detect
  steps:
    - detect
    - billing
    - shipping
    - cancellation

detect:
  REASONING: false
  ON_INPUT:
    - IF: input contains "bill"
      SET: handled_intent = "billing"
      THEN: billing
    - IF: input contains "ship"
      SET: handled_intent = "shipping"
      THEN: shipping
    - IF: input contains "cancel"
      SET: handled_intent = "cancellation"
      THEN: cancellation
    - ELSE:
      RESPOND: "Please ask me about billing, shipping, or cancellation."
      THEN: COMPLETE

billing:
  REASONING: false
  RESPOND: "Billing specialist corrected the invoice."
  THEN: COMPLETE

shipping:
  REASONING: false
  RESPOND: "Shipping specialist confirmed the package is on schedule."
  THEN: COMPLETE

cancellation:
  REASONING: false
  RESPOND: "Cancellation specialist closed the request."
  THEN: COMPLETE
`;

const SCRIPTED_MULTI_INTENT_FRENCH_LOCALE = JSON.stringify({
  multi_intent_disambiguate_header:
    'Je vois plusieurs demandes. Laquelle dois-je traiter d’abord ?',
  multi_intent_disambiguate_option: '{{index}}. {{intent}} ({{confidence}} %)',
  multi_intent_queued_notice: 'Je traiterai vos autres demandes apres celle-ci.',
  multi_intent_queued_follow_up: 'Ensuite : {{next_intent}}. Voulez-vous que je m’en occupe ?',
});

function buildAsyncFanOutSupervisorDsl(remoteEndpoint: string): string {
  return `
SUPERVISOR: Async_FanOut_Supervisor

GOAL: "Coordinate local and remote specialists in parallel"
PERSONA: "A supervisor that fans out work and waits for remote callbacks"

HANDOFF:
  - TO: Billing_Local_Agent
    WHEN: route_choice == "billing"
    RETURN: false

  - TO: Remote_Analytics_Agent
    WHEN: route_choice == "analytics"
    RETURN: false
    LOCATION: remote
    ENDPOINT: "${remoteEndpoint}"
    PROTOCOL: a2a
`;
}

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ChatAgentResponse {
  sessionId: string;
  response: string;
  traceEvents?: TraceEvent[];
}

interface SessionDetailResponse {
  success: boolean;
  session: {
    id: string;
    agentName: string;
    activeThreadIndex?: number;
    traceEvents?: TraceEvent[];
    threads?: Array<{
      agentName?: string;
      status?: string;
    }>;
  };
}

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;
let remoteAgent: MockA2ARemoteAgent;
let outsider: BootstrapProjectResult;

function buildModelLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrapReasoningProject(
  files: Record<string, string>,
  label: string,
): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`${label}-admin`),
    uniqueSlug(`${label}-tenant`),
    uniqueSlug(`${label}-project`),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, files);

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: buildModelLabel(label),
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'mock-routing-phase5-model',
    endpointUrl: mockLlm.url,
    supportsStreaming: true,
    supportsTools: true,
    capabilities: ['text', 'tools', 'streaming'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: `${label}-mock-model`,
      apiKey: 'test-api-key',
    },
  });

  return admin;
}

async function bootstrapOutsiderProject(): Promise<BootstrapProjectResult> {
  return bootstrapProject(
    harness,
    uniqueEmail('routing-phase5-outsider'),
    uniqueSlug('routing-phase5-outsider-tenant'),
    uniqueSlug('routing-phase5-outsider-project'),
  );
}

async function updateProjectRuntimeConfig(
  admin: BootstrapProjectResult,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await requestJson<{ projectId: string }>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body,
    },
  );

  expect(response.status).toBe(200);
}

function buildMultiIntentRuntimeConfig(
  strategy: 'primary_queue' | 'sequential' | 'disambiguate',
): Record<string, unknown> {
  return {
    multi_intent: {
      enabled: true,
      strategy,
      max_intents: 3,
      confidence_threshold: 0.5,
      queue_max_age_ms: 600_000,
    },
  };
}

async function fetchSessionDetail(
  admin: BootstrapProjectResult,
  sessionId: string,
): Promise<SessionDetailResponse | null> {
  const response = await requestJson<SessionDetailResponse>(
    harness,
    `/api/projects/${admin.projectId}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: authHeaders(admin.token),
    },
  );

  if (response.status === 429) {
    return null;
  }

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
  return response.body;
}

async function waitForSessionDetail(
  admin: BootstrapProjectResult,
  sessionId: string,
  predicate: (detail: SessionDetailResponse['session']) => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<SessionDetailResponse['session']> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail: SessionDetailResponse['session'] | undefined;

  while (Date.now() < deadline) {
    const detail = await fetchSessionDetail(admin, sessionId);
    if (!detail) {
      await pause(POLL_INTERVAL_MS * 2);
      continue;
    }
    lastDetail = detail.session;
    if (predicate(detail.session)) {
      return detail.session;
    }
    await pause(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for session detail predicate. Last detail: ${JSON.stringify(lastDetail)}`,
  );
}

async function waitForCallbackDelivery(
  predicate: (deliveries: MockA2ACallbackDelivery[]) => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<MockA2ACallbackDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  let lastDeliveries: MockA2ACallbackDelivery[] = [];

  while (Date.now() < deadline) {
    const deliveries = remoteAgent.getDeliveries();
    lastDeliveries = deliveries;
    if (predicate(deliveries)) {
      return deliveries;
    }
    await pause(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for callback delivery predicate. Last deliveries: ${JSON.stringify(lastDeliveries)}`,
  );
}

function findDecisionTrace(
  traces: TraceEvent[] | undefined,
  decisionType: string,
): TraceEvent | undefined {
  return traces?.find((trace) => trace.type === 'decision' && trace.data.type === decisionType);
}

function findThread(
  threads: SessionDetailResponse['session']['threads'] | undefined,
  agentName: string,
): { agentName?: string; status?: string } | undefined {
  return threads?.find((thread) => thread.agentName === agentName);
}

async function expectSessionHiddenFromOutsider(
  projectId: string,
  sessionId: string,
): Promise<void> {
  const response = await requestJson<{ success?: boolean; error?: unknown }>(
    harness,
    `/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: authHeaders(outsider.token),
    },
  );

  expect(response.status).toBe(404);
}

describe('Routing hardening Phase 5 E2E', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({
      ALLOW_INMEMORY_ASYNC_INFRA: 'true',
    });
    mockLlm = await startMockLLM();
    remoteAgent = await startMockA2ARemoteAgent({
      callbackDelayMs: 500,
      responseText: 'Remote analytics complete.',
    });
    await setSuperAdmins([]);
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    remoteAgent.reset();
    outsider = await bootstrapOutsiderProject();
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
    await remoteAgent.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'supports RETURN:true handoff round-trip through the public HTTP API',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/return-supervisor.agent.abl': RETURN_SUPERVISOR_DSL,
          'agents/billing-return-agent.agent.abl': BILLING_RETURN_AGENT_DSL,
        },
        'routing-phase5-return',
      );

      const userMessage = 'Please route this billing question to the billing specialist.';
      mockLlm.registerToolCall(userMessage, {
        name: 'handoff_to_Billing_Return_Agent',
        arguments: {
          reason: 'The billing specialist should handle this request.',
          message: 'Please resolve this billing issue.',
        },
        followUpContent: 'Routing to billing.',
      });

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Return_Supervisor',
          message: userMessage,
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBeTruthy();
      expect(chatResponse.body.response).toContain(
        'Billing return agent resolved the billing issue.',
      );

      const sessionDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) =>
          detail.activeThreadIndex === 0 &&
          detail.threads?.length === 2 &&
          findThread(detail.threads, 'Billing_Return_Agent')?.status === 'completed',
      );

      expect(findThread(sessionDetail.threads, 'Return_Supervisor')?.status).toBe('active');
      expect(findThread(sessionDetail.threads, 'Billing_Return_Agent')?.status).toBe('completed');
      expect(sessionDetail.traceEvents?.some((trace) => trace.type === 'handoff')).toBe(true);
      expect(sessionDetail.traceEvents?.some((trace) => trace.type === 'thread_return')).toBe(true);

      await expectSessionHiddenFromOutsider(admin.projectId, chatResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'runs guided multi-intent planning and execution through the shared parallel router',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/support-multi-intent-supervisor.agent.abl': MULTI_INTENT_SUPERVISOR_DSL,
          'agents/billing-local.agent.abl': BILLING_LOCAL_AGENT_DSL,
          'agents/shipping-local.agent.abl': SHIPPING_LOCAL_AGENT_DSL,
        },
        'routing-phase5-multi-intent',
      );

      await updateProjectRuntimeConfig(admin, {
        pipeline: {
          enabled: true,
          mode: 'parallel',
          shortCircuit: {
            enabled: true,
            confidenceThreshold: 0.95,
          },
          toolFilter: {
            enabled: false,
          },
          keywordVeto: {
            enabled: false,
          },
          intentBridge: {
            enabled: true,
            programmaticThreshold: 0.95,
            guidedThreshold: 0.5,
            multiIntentSignal: true,
            outOfScopeDecline: false,
          },
        },
        multi_intent: {
          enabled: true,
          strategy: 'parallel',
          max_intents: 3,
          confidence_threshold: 0.5,
          queue_max_age_ms: 600000,
        },
      });

      mockLlm.register('Respond with ONLY valid JSON', {
        content: JSON.stringify({
          intents: [
            {
              category: 'billing',
              confidence: 0.82,
              summary: 'Fix the billing issue',
            },
            {
              category: 'shipping',
              confidence: 0.78,
              summary: 'Check the shipping status',
            },
          ],
          should_execute_in_agent: false,
          matched_tools: [],
        }),
      });

      const mergedResponse =
        'Billing is corrected and shipping is still on schedule, so both parts of your request are covered.';
      mockLlm.register('Agent responses:', {
        content: mergedResponse,
      });

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Support_Multi_Intent_Supervisor',
          message: 'Please fix my bill and also tell me where the shipment stands.',
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBeTruthy();
      expect(chatResponse.body.response).toContain(mergedResponse);
      expect(
        mockLlm
          .getAllRequests()
          .some((request) => JSON.stringify(request).includes('Agent responses:')),
      ).toBe(true);

      const sessionDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            traces.some((trace) => trace.type === 'pipeline_classify') &&
            traces.some((trace) => trace.type === 'pipeline_merge') &&
            traces.some((trace) => trace.type === 'fan_out_complete') &&
            traces.some((trace) => trace.type === 'pipeline_tiered_action') &&
            findDecisionTrace(traces, 'multi_intent_target_resolved') !== undefined &&
            findDecisionTrace(traces, 'multi_intent_plan_built') !== undefined &&
            findDecisionTrace(traces, 'multi_intent_parallel_executed') !== undefined
          );
        },
      );

      const traces = sessionDetail.traceEvents ?? [];
      expect(traces.some((trace) => trace.type === 'pipeline_classify')).toBe(true);
      expect(traces.some((trace) => trace.type === 'pipeline_merge')).toBe(true);
      expect(traces.some((trace) => trace.type === 'fan_out_start')).toBe(true);
      expect(traces.some((trace) => trace.type === 'fan_out_complete')).toBe(true);

      const tieredActionTrace = traces.find((trace) => trace.type === 'pipeline_tiered_action');
      expect(tieredActionTrace?.data.action).toBe('guided');
      expect(tieredActionTrace?.data.details).toMatchObject({ hasMultiIntent: true });

      expect(findDecisionTrace(traces, 'multi_intent_target_resolved')).toBeDefined();
      expect(findDecisionTrace(traces, 'multi_intent_plan_built')).toBeDefined();
      expect(findDecisionTrace(traces, 'multi_intent_parallel_executed')).toBeDefined();
      expect(
        traces.some(
          (trace) =>
            trace.type === 'fan_out_child_completed' &&
            trace.data.agentName === 'Billing_Local_Agent',
        ),
      ).toBe(true);
      expect(
        traces.some(
          (trace) =>
            trace.type === 'fan_out_child_completed' &&
            trace.data.agentName === 'Shipping_Local_Agent',
        ),
      ).toBe(true);

      await expectSessionHiddenFromOutsider(admin.projectId, chatResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'runs primary_queue multi-intent through HTTP and replays the queued request after confirmation',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/support-scripted-multi-intent.agent.abl': SCRIPTED_MULTI_INTENT_FLOW_DSL,
        },
        'routing-phase5-primary-queue',
      );

      await updateProjectRuntimeConfig(admin, buildMultiIntentRuntimeConfig('primary_queue'));

      const firstResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Support_Scripted_Multi_Intent_Agent',
          message: 'Please fix my bill and also check the shipment.',
        },
      });

      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.sessionId).toBeTruthy();
      expect(firstResponse.body.response).toContain('Billing specialist corrected the invoice.');
      expect(firstResponse.body.response).toContain('Next: shipping.');
      expect(firstResponse.body.response).toContain('Would you like me to help with that?');
      expect(
        findDecisionTrace(firstResponse.body.traceEvents, 'multi_intent_queued'),
      ).toBeDefined();
      expect(
        firstResponse.body.traceEvents?.some(
          (trace) => trace.type === 'multi_intent_queue_surfaced',
        ),
      ).toBe(true);

      const secondResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: firstResponse.body.sessionId,
          message: 'yes',
        },
      });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.sessionId).toBe(firstResponse.body.sessionId);
      expect(secondResponse.body.response).toContain(
        'Shipping specialist confirmed the package is on schedule.',
      );
      expect(
        secondResponse.body.traceEvents?.some(
          (trace) => trace.type === 'multi_intent_queue_accepted',
        ),
      ).toBe(true);

      const sessionDetail = await waitForSessionDetail(
        admin,
        firstResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            findDecisionTrace(traces, 'multi_intent_queued') !== undefined &&
            traces.some((trace) => trace.type === 'multi_intent_queue_surfaced') &&
            traces.some((trace) => trace.type === 'multi_intent_queue_accepted')
          );
        },
      );

      expect(findDecisionTrace(sessionDetail.traceEvents, 'multi_intent_queued')).toBeDefined();
      expect(
        sessionDetail.traceEvents?.some((trace) => trace.type === 'multi_intent_queue_surfaced'),
      ).toBe(true);
      expect(
        sessionDetail.traceEvents?.some((trace) => trace.type === 'multi_intent_queue_accepted'),
      ).toBe(true);

      await expectSessionHiddenFromOutsider(admin.projectId, firstResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'runs sequential multi-intent through HTTP and preserves the sequential trace contract',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/support-scripted-multi-intent.agent.abl': SCRIPTED_MULTI_INTENT_FLOW_DSL,
        },
        'routing-phase5-sequential',
      );

      await updateProjectRuntimeConfig(admin, buildMultiIntentRuntimeConfig('sequential'));

      const firstResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Support_Scripted_Multi_Intent_Agent',
          message: 'Please fix my bill and also check the shipment.',
        },
      });

      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.sessionId).toBeTruthy();
      expect(firstResponse.body.response).toContain('Billing specialist corrected the invoice.');
      expect(firstResponse.body.response).toContain('Next: shipping.');
      expect(
        findDecisionTrace(firstResponse.body.traceEvents, 'multi_intent_sequential'),
      ).toBeDefined();
      expect(
        findDecisionTrace(firstResponse.body.traceEvents, 'multi_intent_queued'),
      ).toBeUndefined();

      const secondResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: firstResponse.body.sessionId,
          message: 'yes',
        },
      });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.response).toContain(
        'Shipping specialist confirmed the package is on schedule.',
      );
      expect(
        secondResponse.body.traceEvents?.some(
          (trace) => trace.type === 'multi_intent_queue_accepted',
        ),
      ).toBe(true);

      const sessionDetail = await waitForSessionDetail(
        admin,
        firstResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            findDecisionTrace(traces, 'multi_intent_sequential') !== undefined &&
            !traces.some(
              (trace) => trace.type === 'decision' && trace.data.type === 'multi_intent_queued',
            ) &&
            traces.some((trace) => trace.type === 'multi_intent_queue_accepted')
          );
        },
      );

      expect(findDecisionTrace(sessionDetail.traceEvents, 'multi_intent_sequential')).toBeDefined();
      expect(findDecisionTrace(sessionDetail.traceEvents, 'multi_intent_queued')).toBeUndefined();
      expect(
        sessionDetail.traceEvents?.some((trace) => trace.type === 'multi_intent_queue_accepted'),
      ).toBe(true);

      await expectSessionHiddenFromOutsider(admin.projectId, firstResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'runs disambiguate multi-intent through HTTP and honors the selected follow-up choice',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/support-scripted-multi-intent.agent.abl': SCRIPTED_MULTI_INTENT_FLOW_DSL,
        },
        'routing-phase5-disambiguate',
      );

      await updateProjectRuntimeConfig(admin, buildMultiIntentRuntimeConfig('disambiguate'));

      const firstResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Support_Scripted_Multi_Intent_Agent',
          message: 'Please fix my bill and also check the shipment.',
        },
      });

      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.sessionId).toBeTruthy();
      expect(firstResponse.body.response).toContain(
        'I noticed your message may contain multiple requests.',
      );
      expect(firstResponse.body.response).toContain('1. billing');
      expect(firstResponse.body.response).toContain('2. shipping');
      expect(
        findDecisionTrace(firstResponse.body.traceEvents, 'multi_intent_disambiguate'),
      ).toBeDefined();
      expect(
        findDecisionTrace(firstResponse.body.traceEvents, 'multi_intent_disambiguation_requested'),
      ).toBeDefined();

      const secondResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: firstResponse.body.sessionId,
          message: '2',
        },
      });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.response).toContain(
        'Shipping specialist confirmed the package is on schedule.',
      );
      expect(
        secondResponse.body.traceEvents?.some(
          (trace) => trace.type === 'multi_intent_disambiguate_choice',
        ),
      ).toBe(true);

      const sessionDetail = await waitForSessionDetail(
        admin,
        firstResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            findDecisionTrace(traces, 'multi_intent_disambiguation_requested') !== undefined &&
            traces.some((trace) => trace.type === 'multi_intent_disambiguate_choice')
          );
        },
      );

      expect(
        findDecisionTrace(sessionDetail.traceEvents, 'multi_intent_disambiguation_requested'),
      ).toBeDefined();
      expect(
        sessionDetail.traceEvents?.some(
          (trace) => trace.type === 'multi_intent_disambiguate_choice',
        ),
      ).toBe(true);

      await expectSessionHiddenFromOutsider(admin.projectId, firstResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'localizes queued and disambiguation multi-intent prompts from locale assets during HTTP chat',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/support-scripted-multi-intent.agent.abl': SCRIPTED_MULTI_INTENT_FLOW_DSL,
          'locales/fr/support_scripted_multi_intent_agent.json':
            SCRIPTED_MULTI_INTENT_FRENCH_LOCALE,
        },
        'routing-phase5-localized-multi-intent',
      );

      await updateProjectRuntimeConfig(admin, buildMultiIntentRuntimeConfig('primary_queue'));

      const queuedResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Support_Scripted_Multi_Intent_Agent',
          message: 'Please fix my bill and also check the shipment.',
          interactionContext: {
            locale: 'fr-FR',
          },
        },
      });

      expect(queuedResponse.status).toBe(200);
      expect(queuedResponse.body.response).toContain(
        'Je traiterai vos autres demandes apres celle-ci.',
      );
      expect(queuedResponse.body.response).toContain(
        'Ensuite : shipping. Voulez-vous que je m’en occupe ?',
      );

      await updateProjectRuntimeConfig(admin, buildMultiIntentRuntimeConfig('disambiguate'));

      const disambiguationResponse = await requestJson<ChatAgentResponse>(
        harness,
        '/api/v1/chat/agent',
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            projectId: admin.projectId,
            agentId: 'Support_Scripted_Multi_Intent_Agent',
            message: 'Please fix my bill and also check the shipment.',
            interactionContext: {
              locale: 'fr-FR',
            },
          },
        },
      );

      expect(disambiguationResponse.status).toBe(200);
      expect(disambiguationResponse.body.response).toContain(
        'Je vois plusieurs demandes. Laquelle dois-je traiter d’abord ?',
      );
      expect(disambiguationResponse.body.response).toContain('1. billing (80 %)');
      expect(disambiguationResponse.body.response).toContain('2. shipping (80 %)');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'resumes mixed local and remote async fan-out after the remote callback arrives',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'agents/async-fanout-supervisor.agent.abl': buildAsyncFanOutSupervisorDsl(
            remoteAgent.endpointUrl,
          ),
          'agents/billing-local.agent.abl': BILLING_LOCAL_AGENT_DSL,
        },
        'routing-phase5-async-fanout',
      );

      const userMessage = 'Handle the billing issue and run remote analytics too.';
      mockLlm.registerToolCall(userMessage, {
        name: '__fan_out__',
        arguments: {
          reason: 'Need both the local billing specialist and the remote analytics specialist.',
          tasks: [
            {
              target: 'Billing_Local_Agent',
              intent: 'Fix the billing issue',
            },
            {
              target: 'Remote_Analytics_Agent',
              intent: 'Run remote analytics',
            },
          ],
        },
        followUpContent:
          'I started both specialists and will share the combined result when remote work finishes.',
      });

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Async_FanOut_Supervisor',
          message: userMessage,
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBeTruthy();
      expect(chatResponse.body.response).toContain('I started both specialists');
      expect(chatResponse.body.traceEvents?.map((trace) => trace.type)).toEqual(
        expect.arrayContaining([
          'fan_out_async_started',
          'fan_out_branch_registered',
          'fan_out_parent_suspended',
          'fan_out_branch_dispatched',
        ]),
      );

      const remoteDispatch = remoteAgent
        .getRequests()
        .find((request) => request.method === 'POST' && !!request.callbackUrl);
      expect(remoteDispatch).toBeDefined();
      expect(remoteDispatch?.callbackUrl).toContain(harness.baseUrl);
      expect(remoteDispatch?.callbackToken).toBeTruthy();

      const initialDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) =>
          detail.threads?.length === 3 &&
          findThread(detail.threads, 'Billing_Local_Agent')?.status === 'completed' &&
          findThread(detail.threads, 'Remote_Analytics_Agent')?.status === 'waiting',
      );

      expect(findThread(initialDetail.threads, 'Remote_Analytics_Agent')?.status).toBe('waiting');

      const deliveries = await waitForCallbackDelivery((records) => records.length > 0);
      const firstDelivery = deliveries[0];
      if (!firstDelivery?.ok || firstDelivery.status !== 200) {
        throw new Error(`Remote callback delivery failed: ${JSON.stringify(firstDelivery)}`);
      }

      const completedDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          const branchResumed = traces.find(
            (trace) =>
              trace.type === 'decision' &&
              trace.data.type === 'fan_out_branch_resumed' &&
              trace.data.continuationType === 'fan_out_remote_branch',
          );
          const parentResumed = findDecisionTrace(traces, 'fan_out_parent_resumed');
          const remoteThreadComplete =
            findThread(detail.threads, 'Remote_Analytics_Agent')?.status === 'completed';
          return branchResumed !== undefined && parentResumed !== undefined && remoteThreadComplete;
        },
      );

      expect(
        completedDetail.traceEvents?.some(
          (trace) =>
            trace.type === 'decision' &&
            trace.data.type === 'fan_out_branch_resumed' &&
            trace.data.continuationType === 'fan_out_remote_branch',
        ),
      ).toBe(true);
      expect(
        findDecisionTrace(completedDetail.traceEvents, 'fan_out_parent_resumed'),
      ).toBeDefined();
      expect(findThread(completedDetail.threads, 'Remote_Analytics_Agent')?.status).toBe(
        'completed',
      );

      await expectSessionHiddenFromOutsider(admin.projectId, chatResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );
});
