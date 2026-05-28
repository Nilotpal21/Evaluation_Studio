import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  authHeaders,
  bootstrapProject,
  createProject,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  type BootstrapProjectResult,
} from './channel-e2e-bootstrap.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
  type RuntimeHarnessEnvOverrides,
  type RuntimeHarnessOptions,
} from './runtime-api-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const SIBLING_AGENT_DSL = `
AGENT: BranchLocatorSibling

GOAL: "Help find nearby branches"

FLOW:
  entry_point: respond_location
  steps:
    - respond_location

respond_location:
  REASONING: false
  RESPOND: "I can help find branches nearby."
  THEN: COMPLETE
`;

const FIXTURE_CHILD_PATH = new URL(
  '../fixtures/gather-interrupt/child-gather.abl',
  import.meta.url,
);
const FIXTURE_SUPERVISOR_PATH = new URL(
  '../fixtures/gather-interrupt/supervisor.abl',
  import.meta.url,
);

export const INITIAL_CHILD_HANDOFF_TRIGGER = 'start destination collection';
export const GATHER_INTERRUPT_MESSAGE = 'show me nearby branches';
export const DESTINATION_VALUE = 'Sydney';

export interface GatherInterruptTraceEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface GatherInterruptChatResponse {
  sessionId: string;
  response: string;
  action?: {
    type?: string;
    target?: string;
  };
  state?: Record<string, unknown>;
  traceEvents?: GatherInterruptTraceEvent[];
}

export interface GatherInterruptContext {
  harness: RuntimeApiHarness;
  mockLlm: MockLLM;
  admin: BootstrapProjectResult;
  alternateProjectId: string;
  outsider: BootstrapProjectResult;
}

export interface GatherInterruptCombinedHarness {
  harness: RuntimeApiHarness;
  mockLlm: MockLLM;
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function loadFixture(path: URL): Promise<string> {
  return readFile(path, 'utf8');
}

function registerInitialChildHandoff(mockLlm: MockLLM): void {
  mockLlm.registerToolCall(INITIAL_CHILD_HANDOFF_TRIGGER, {
    name: 'handoff_to_ChildGatherFlow',
    arguments: {
      reason: 'The child gather flow should collect the destination first.',
      message: 'I need to collect a destination.',
    },
    followUpContent: 'Let me collect your destination first.',
  });

  mockLlm.registerToolCall(DESTINATION_VALUE, {
    name: '_extract_entities',
    arguments: {
      destination: DESTINATION_VALUE,
    },
    followUpContent: '{}',
  });
}

export async function startGatherInterruptTestHarness(
  envOverrides: RuntimeHarnessEnvOverrides = {},
  options: RuntimeHarnessOptions = {},
): Promise<GatherInterruptCombinedHarness> {
  const mockLlm = await startMockLLM();
  const harness = await startRuntimeServerHarness(envOverrides, options);

  return {
    harness,
    mockLlm,
    async reset() {
      clearPermissionCache();
      await harness.resetRuntimeState();
      await setSuperAdmins([]);
      mockLlm.reset();
    },
    async close() {
      await harness.close();
      await mockLlm.close();
    },
  };
}

export async function bootstrapGatherInterruptContext(
  combined: GatherInterruptCombinedHarness,
): Promise<GatherInterruptContext> {
  const supervisorDsl = await loadFixture(FIXTURE_SUPERVISOR_PATH);
  const childDsl = await loadFixture(FIXTURE_CHILD_PATH);

  const admin = await bootstrapProject(
    combined.harness,
    uniqueEmail('gather-interrupt-admin'),
    uniqueSlug('gather-interrupt-tenant'),
    uniqueSlug('gather-interrupt-project'),
  );

  const alternateProjectSlug = uniqueSlug('gather-interrupt-alt-project');
  const alternateProject = await createProject(
    combined.harness,
    admin.token,
    admin.tenantId,
    `${alternateProjectSlug} Name`,
    alternateProjectSlug,
  );

  await importProjectFiles(combined.harness, admin.token, admin.projectId, {
    'agents/gather-interrupt-supervisor.agent.abl': supervisorDsl,
    'agents/gather-interrupt-child.agent.abl': childDsl,
    'agents/gather-interrupt-sibling.agent.abl': SIBLING_AGENT_DSL,
  });

  await provisionTenantModel(combined.harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'Mock Gather Interrupt Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'mock-gather-interrupt-model',
    endpointUrl: combined.mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: 'mock-gather-interrupt-model',
      apiKey: 'test-api-key',
    },
  });

  const outsider = await bootstrapProject(
    combined.harness,
    uniqueEmail('gather-interrupt-outsider'),
    uniqueSlug('gather-interrupt-outsider-tenant'),
    uniqueSlug('gather-interrupt-outsider-project'),
  );

  await setSuperAdmins([admin.userId, outsider.userId]);
  registerInitialChildHandoff(combined.mockLlm);

  return {
    harness: combined.harness,
    mockLlm: combined.mockLlm,
    admin,
    alternateProjectId: alternateProject._id,
    outsider,
  };
}

export async function startChildGatherConversation(
  context: GatherInterruptContext,
  message = INITIAL_CHILD_HANDOFF_TRIGGER,
) {
  return requestJson<GatherInterruptChatResponse>(context.harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(context.admin.token),
    body: {
      projectId: context.admin.projectId,
      agentId: 'GatherInterruptSupervisor',
      message,
    },
  });
}

export async function sendDestinationValue(
  context: GatherInterruptContext,
  sessionId: string,
  destination = DESTINATION_VALUE,
) {
  return requestJson<GatherInterruptChatResponse>(context.harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(context.admin.token),
    body: {
      projectId: context.admin.projectId,
      sessionId,
      message: destination,
    },
  });
}

export async function sendGatherInterrupt(
  context: GatherInterruptContext,
  sessionId: string,
  message = GATHER_INTERRUPT_MESSAGE,
) {
  return requestJson<GatherInterruptChatResponse>(context.harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(context.admin.token),
    body: {
      projectId: context.admin.projectId,
      sessionId,
      message,
    },
  });
}

export async function assertGatherInterruptIsolation404(
  context: GatherInterruptContext,
  sessionId: string,
  message = GATHER_INTERRUPT_MESSAGE,
): Promise<void> {
  const crossProject = await requestJson<{ error?: string }>(
    context.harness,
    '/api/v1/chat/agent',
    {
      method: 'POST',
      headers: authHeaders(context.admin.token),
      body: {
        projectId: context.alternateProjectId,
        sessionId,
        message,
      },
    },
  );

  expect(crossProject.status).toBe(404);

  const crossTenant = await requestJson<{ error?: string }>(context.harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(context.outsider.token),
    body: {
      projectId: context.outsider.projectId,
      sessionId,
      message,
    },
  });

  expect(crossTenant.status).toBe(404);
}
