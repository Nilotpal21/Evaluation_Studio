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
import type {
  MockLLM,
  OpenAIChatMessageContent,
  OpenAIChatRequest,
} from '../../../../../tools/agents/e2e-functional/types.js';

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 10_000;

const AUTH_RESUME_SUPERVISOR_DSL = `
AGENT: Billing_Coordination_Supervisor

GOAL: "Authenticate billing requests and prove named return handlers through the public API"

MEMORY:
  session:
    - route
  persistent:
    - PATH: workflow.auth_token
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string

FLOW:
  entry_point: classify
  steps:
    - classify

  classify:
    REASONING: false
    RESPOND: "Please describe your billing request."
    ON_INPUT:
      - IF: route == "billing_ready"
        THEN: COMPLETE
      - IF: input contains "billing"
        SET: route = "auth"
        THEN: COMPLETE
      - ELSE:
        RESPOND: "I can help with billing requests once they're authenticated."
        THEN: COMPLETE

RETURN_HANDLERS:
  billing_follow_up:
    RESUME_INTENT: true

HANDOFF:
  - TO: Auth_Agent
    WHEN: route == "auth"
    CONTEXT:
      pass: [route]
      summary: "Verify the customer before billing support."
      history: auto
      memory_grants:
        - path: workflow.auth_token
          access: readwrite
    RETURN: true
    ON_RETURN:
      handler: billing_follow_up
      map:
        route: route
`;

const BILLING_POLICY_BOOTSTRAP_DSL = `
AGENT: Billing_Policy_Bootstrapper

GOAL: "Seed execution-tree auth context and route billing work to the policy-guarded billing agent"

MEMORY:
  session:
    - route
  persistent:
    - PATH: workflow.auth_token
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string

FLOW:
  entry_point: bootstrap
  steps:
    - bootstrap

  bootstrap:
    REASONING: false
    SET:
      workflow.auth_token = "verified-token"
      route = "billing_ready"
    THEN: COMPLETE

HANDOFF:
  - TO: Billing_Agent
    WHEN: route == "billing_ready"
    CONTEXT:
      pass: [route]
      summary: "Authenticated billing request."
      history: auto
      memory_grants:
        - path: workflow.auth_token
          access: read
    RETURN: false
`;

const AUTH_AGENT_DSL = `
AGENT: Auth_Agent

GOAL: "Verify the customer before billing support continues"

FLOW:
  entry_point: verify
  steps:
    - verify

  verify:
    REASONING: false
    SET: route = "billing_ready"
    SET: granted_memory.workflow.auth_token = "verified-token"
    RESPOND: "Verified customer."
    THEN: COMPLETE
`;

const BILLING_AGENT_DSL = `
AGENT: Billing_Agent

GOAL: "Use the billing lookup tool after authentication and follow project policy"

TOOLS:
  lookup_sensitive_billing_data(query: string) -> {status: string}
    DESCRIPTION: "Look up sensitive billing data"
`;

const BILLING_TOOL_DSL = `
TOOLS:
  lookup_sensitive_billing_data(query: string) -> {status: string}
    description: "Look up sensitive billing data"
    type: http
    endpoint: "http://127.0.0.1:9/blocked-before-execution"
    method: POST
`;

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

interface GuardrailPolicyResponse {
  success: boolean;
  data: {
    _id: string;
    name: string;
    status?: string;
    isActive?: boolean;
  };
}

const BILLING_POLICY_PAYLOAD = {
  name: 'billing-tool-input-policy',
  rules: [
    {
      guardrailName: 'billing_tool_input_pii',
      override: 'define' as const,
      kind: 'tool_input' as const,
      tier: 'local' as const,
      check: 'abl.contains_pii(tool_input)',
      message: 'Project policy blocked unsafe billing tool input.',
    },
  ],
  settings: {
    failMode: 'closed' as const,
    timeouts: { local: 100, model: 3000, llm: 10_000 },
    streaming: {
      enabled: false,
      defaultInterval: 'sentence',
      chunkSize: 1,
      maxLatencyMs: 500,
      earlyTermination: true,
    },
  },
  caching: {
    enabled: false,
    exactMatch: false,
    semanticMatch: false,
    semanticThreshold: 0.95,
    defaultTtlSeconds: 3600,
  },
  budget: {
    monthlyLimitUsd: 100,
    currentSpendUsd: 0,
    overspendAction: 'alert_only',
  },
};

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;
let outsider: BootstrapProjectResult;

function buildModelLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function flattenContent(content: OpenAIChatMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content) {
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (!part || typeof part !== 'object') {
          return '';
        }

        if (typeof part.text === 'string') {
          return part.text;
        }

        if (typeof part.content === 'string') {
          return part.content;
        }

        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(content);
}

function findThread(
  threads: SessionDetailResponse['session']['threads'] | undefined,
  agentName: string,
): { agentName?: string; status?: string } | undefined {
  return threads?.find((thread) => thread.agentName === agentName);
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
    modelId: 'mock-abl-contract-hardening-model',
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
    uniqueEmail('ablp417-phase9-outsider'),
    uniqueSlug('ablp417-phase9-outsider-tenant'),
    uniqueSlug('ablp417-phase9-outsider-project'),
  );
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

async function createProjectGuardrailPolicy(
  admin: BootstrapProjectResult,
): Promise<GuardrailPolicyResponse['data']> {
  const response = await requestJson<GuardrailPolicyResponse>(
    harness,
    `/api/projects/${admin.projectId}/guardrail-policies`,
    {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: BILLING_POLICY_PAYLOAD,
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.data;
}

async function activateProjectGuardrailPolicy(
  admin: BootstrapProjectResult,
  policyId: string,
): Promise<void> {
  const response = await requestJson<GuardrailPolicyResponse>(
    harness,
    `/api/projects/${admin.projectId}/guardrail-policies/${policyId}/activate`,
    {
      method: 'POST',
      headers: authHeaders(admin.token),
    },
  );

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
  expect(response.body.data._id).toBe(policyId);
  expect(response.body.data.status).toBe('active');
  expect(response.body.data.isActive).toBe(true);
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

describe('ABL contract hardening Phase 9 public E2E', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({
      ALLOW_INMEMORY_ASYNC_INFRA: 'true',
    });
    mockLlm = await startMockLLM();
    await setSuperAdmins([]);
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    outsider = await bootstrapOutsiderProject();
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'public flow handoff emits named return handler traces and resume_intent after auth child completion',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'project.json': JSON.stringify({
            format_version: '2.0',
            project_name: 'billing-auth-resume',
            entry_agent: 'Billing_Coordination_Supervisor',
            agents: [
              {
                name: 'Billing_Coordination_Supervisor',
                file: 'agents/billing-coordination-supervisor.agent.abl',
              },
              { name: 'Auth_Agent', file: 'agents/auth.agent.abl' },
            ],
          }),
          'agents/billing-coordination-supervisor.agent.abl': AUTH_RESUME_SUPERVISOR_DSL,
          'agents/auth.agent.abl': AUTH_AGENT_DSL,
        },
        'ablp417-phase9-auth-resume',
      );

      const initialResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'Billing_Coordination_Supervisor',
          message: 'start',
        },
      });

      expect(initialResponse.status).toBe(200);
      expect(initialResponse.body.sessionId).toBeTruthy();
      expect(initialResponse.body.response).toContain('Please describe your billing request.');

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: initialResponse.body.sessionId,
          message: 'I need help with billing and my SSN is 123-45-6789.',
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBe(initialResponse.body.sessionId);

      const sessionDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            findThread(detail.threads, 'Auth_Agent')?.status === 'completed' &&
            traces.some(
              (trace) =>
                trace.type === 'handoff_return_handler' &&
                trace.data.handler === 'billing_follow_up',
            ) &&
            traces.some((trace) => trace.type === 'resume_intent')
          );
        },
      );

      expect(findThread(sessionDetail.threads, 'Auth_Agent')?.status).toBe('completed');
      expect(sessionDetail.activeThreadIndex).toBe(0);

      const traces = sessionDetail.traceEvents ?? [];
      expect(
        traces.some(
          (trace) =>
            trace.type === 'handoff_return_handler' && trace.data.handler === 'billing_follow_up',
        ),
      ).toBe(true);
      expect(traces.some((trace) => trace.type === 'resume_intent')).toBe(true);
      expect(chatResponse.body.response).toContain('Verified customer.');
      expect(chatResponse.body.response).toContain('Please describe your billing request.');

      await expectSessionHiddenFromOutsider(admin.projectId, chatResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'public handoff projects execution_tree memory into the billing prompt and blocks unsafe tool input through project policy',
    async () => {
      const admin = await bootstrapReasoningProject(
        {
          'project.json': JSON.stringify({
            format_version: '2.0',
            project_name: 'billing-policy-composition',
            entry_agent: 'Billing_Policy_Bootstrapper',
            agents: [
              {
                name: 'Billing_Policy_Bootstrapper',
                file: 'agents/billing-policy-bootstrapper.agent.abl',
              },
              { name: 'Billing_Agent', file: 'agents/billing.agent.abl' },
            ],
            tools: [
              {
                name: 'lookup_sensitive_billing_data',
                file: 'tools/lookup_sensitive_billing_data.tools.abl',
              },
            ],
          }),
          'agents/billing-policy-bootstrapper.agent.abl': BILLING_POLICY_BOOTSTRAP_DSL,
          'agents/billing.agent.abl': BILLING_AGENT_DSL,
          'tools/lookup_sensitive_billing_data.tools.abl': BILLING_TOOL_DSL,
        },
        'ablp417-phase9-billing-policy',
      );

      const policy = await createProjectGuardrailPolicy(admin);
      await activateProjectGuardrailPolicy(admin, policy._id);

      mockLlm.registerToolCall('billing', {
        name: 'lookup_sensitive_billing_data',
        arguments: {
          query: 'Customer SSN 123-45-6789 with auth token verified-token',
        },
        followUpContent:
          'Verified customer context is available, but project policy blocked the unsafe billing lookup.',
      });

      const bootstrapResponse = await requestJson<ChatAgentResponse>(
        harness,
        '/api/v1/chat/agent',
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: {
            projectId: admin.projectId,
            agentId: 'Billing_Policy_Bootstrapper',
            message: 'I need help with billing and my SSN is 123-45-6789.',
          },
        },
      );

      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrapResponse.body.sessionId).toBeTruthy();

      const billingThreadReady = await waitForSessionDetail(
        admin,
        bootstrapResponse.body.sessionId,
        (detail) => findThread(detail.threads, 'Billing_Agent')?.status === 'active',
      );

      expect(findThread(billingThreadReady.threads, 'Billing_Agent')?.status).toBe('active');
      expect(billingThreadReady.activeThreadIndex).toBe(1);

      const chatResponse = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: bootstrapResponse.body.sessionId,
          message: 'Please continue the billing lookup for SSN 123-45-6789.',
        },
      });

      expect(chatResponse.status).toBe(200);
      expect(chatResponse.body.sessionId).toBe(bootstrapResponse.body.sessionId);

      const sessionDetail = await waitForSessionDetail(
        admin,
        chatResponse.body.sessionId,
        (detail) => {
          const traces = detail.traceEvents ?? [];
          return (
            findThread(detail.threads, 'Billing_Agent')?.status === 'active' &&
            traces.some(
              (trace) =>
                trace.type === 'decision' &&
                trace.data.type === 'pre_turn_surface' &&
                trace.data.additionalGuardrails === 1,
            ) &&
            traces.some((trace) => trace.type === 'guardrail_tool_blocked')
          );
        },
      );

      expect(findThread(sessionDetail.threads, 'Billing_Agent')?.status).toBe('active');
      expect(sessionDetail.activeThreadIndex).toBe(1);

      const traces = sessionDetail.traceEvents ?? [];
      expect(
        traces.some(
          (trace) =>
            trace.type === 'decision' &&
            trace.data.type === 'pre_turn_surface' &&
            trace.data.policyFailMode === 'closed' &&
            trace.data.additionalGuardrails === 1,
        ),
      ).toBe(true);
      expect(
        traces.some(
          (trace) =>
            trace.type === 'guardrail_tool_blocked' &&
            trace.data.toolName === 'lookup_sensitive_billing_data' &&
            trace.data.guardrailName === 'billing_tool_input_pii',
        ),
      ).toBe(true);
      expect(chatResponse.body.response).toContain(
        'project policy blocked the unsafe billing lookup',
      );

      const billingRequests = mockLlm
        .getAllRequests()
        .filter((request) =>
          JSON.stringify(request.tools ?? []).includes('lookup_sensitive_billing_data'),
        );
      expect(billingRequests.length).toBeGreaterThan(0);

      const billingPromptCorpus = billingRequests
        .flatMap((request: OpenAIChatRequest) =>
          request.messages.map((message) => flattenContent(message.content)),
        )
        .join('\n\n');

      expect(billingPromptCorpus).toContain('## Granted Memory');
      expect(billingPromptCorpus).toContain('"workflow.auth_token": "verified-token"');
      expect(billingPromptCorpus).toContain('## Current Policy');
      expect(billingPromptCorpus).toContain('"failMode": "closed"');
      expect(billingPromptCorpus).toContain('"additionalGuardrailCount": 1');

      await expectSessionHiddenFromOutsider(admin.projectId, chatResponse.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );
});
