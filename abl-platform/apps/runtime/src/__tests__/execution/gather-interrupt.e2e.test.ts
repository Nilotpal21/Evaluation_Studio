import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
} from '../helpers/channel-e2e-bootstrap.js';
import {
  bootstrapGatherInterruptContext,
  GATHER_INTERRUPT_MESSAGE,
  INITIAL_CHILD_HANDOFF_TRIGGER,
  sendGatherInterrupt,
  startChildGatherConversation,
  startGatherInterruptTestHarness,
  type GatherInterruptCombinedHarness,
  type GatherInterruptContext,
} from '../helpers/gather-interrupt-harness.js';
import type {
  MockLLM,
  OpenAIChatRequest,
} from '../../../../../tools/agents/e2e-functional/types.js';

const SUITE_TIMEOUT_MS = 120_000;
const TRACE_POLL_INTERVAL_MS = 200;
const TRACE_POLL_TIMEOUT_MS = 5_000;

const SEMANTIC_NEGATIVE_SUPERVISOR_DSL = `
SUPERVISOR: GatherInterruptSupervisor

GOAL: "Route destination collection and branch lookup requests"

PERSONA: "A routing supervisor that can resume after child gather turns"

EXECUTION:
  pipeline:
    enabled: true

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  collect_trip: "Users starting destination collection"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: ChildGatherFlow
    WHEN: intent.category == "collect_trip"
    RETURN: true

  - TO: BranchLocatorSibling
    WHEN: intent.category == "branch_locator"
    RETURN: true
`;

const CHILD_GATHER_DSL = `
AGENT: ChildGatherFlow

GOAL: "Collect the caller destination"

FLOW:
  entry_point: collect_destination
  steps:
    - collect_destination

collect_destination:
  REASONING: false
  GATHER:
    - destination: required
  THEN: COMPLETE
`;

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

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

interface SessionDetailResponse {
  success: boolean;
  session: {
    id: string;
    traceEvents?: TraceEvent[];
  };
}

function countTraceEvents(session: SessionDetailResponse['session'], type: string): number {
  return session.traceEvents?.filter((event) => event.type === type).length ?? 0;
}

function stringifyMessageContent(
  content: OpenAIChatRequest['messages'][number]['content'],
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content == null) {
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
      .join('\n');
  }

  return JSON.stringify(content);
}

function findClassifierRequest(
  mockLlm: MockLLM,
  userMessage: string,
): OpenAIChatRequest | undefined {
  return mockLlm.getAllRequests().find((request) =>
    request.messages.some((message) => {
      const text = stringifyMessageContent(message.content);
      return (
        text.includes('You are an intent classifier.') &&
        text.includes(`Current user message: "${userMessage}"`)
      );
    }),
  );
}

function buildClassifierPromptPattern(userMessage: string): string {
  return `Current user message: "${userMessage}"`;
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSessionDetail(
  context: GatherInterruptContext,
  sessionId: string,
): Promise<SessionDetailResponse | null> {
  const response = await requestJson<SessionDetailResponse>(
    context.harness,
    `/api/projects/${context.admin.projectId}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: authHeaders(context.admin.token),
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
  context: GatherInterruptContext,
  sessionId: string,
  predicate: (detail: SessionDetailResponse['session']) => boolean,
  timeoutMs = TRACE_POLL_TIMEOUT_MS,
): Promise<SessionDetailResponse['session']> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail: SessionDetailResponse['session'] | undefined;

  while (Date.now() < deadline) {
    const detail = await fetchSessionDetail(context, sessionId);
    if (!detail) {
      await pause(TRACE_POLL_INTERVAL_MS * 2);
      continue;
    }

    lastDetail = detail.session;
    if (predicate(detail.session)) {
      return detail.session;
    }

    await pause(TRACE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for session detail predicate. Last detail: ${JSON.stringify(lastDetail)}`,
  );
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
}

function registerSemanticNegativeTurn(mockLlm: MockLLM, userMessage: string): void {
  mockLlm.register(buildClassifierPromptPattern(userMessage), {
    content: JSON.stringify({
      intents: [
        {
          category: null,
          confidence: 0.19,
          summary: 'destination input',
          out_of_scope: false,
        },
      ],
    }),
  });
}

async function bootstrapSemanticNegativeContext(
  combined: GatherInterruptCombinedHarness,
): Promise<GatherInterruptContext> {
  const admin = await bootstrapProject(
    combined.harness,
    uniqueEmail('gather-interrupt-semantic-admin'),
    uniqueSlug('gather-interrupt-semantic-tenant'),
    uniqueSlug('gather-interrupt-semantic-project'),
  );

  const alternateProjectSlug = uniqueSlug('gather-interrupt-semantic-alt-project');
  const alternateProject = await createProject(
    combined.harness,
    admin.token,
    admin.tenantId,
    `${alternateProjectSlug} Name`,
    alternateProjectSlug,
  );

  await importProjectFiles(combined.harness, admin.token, admin.projectId, {
    'agents/gather-interrupt-supervisor.agent.abl': SEMANTIC_NEGATIVE_SUPERVISOR_DSL,
    'agents/gather-interrupt-child.agent.abl': CHILD_GATHER_DSL,
    'agents/gather-interrupt-sibling.agent.abl': SIBLING_AGENT_DSL,
  });

  await provisionTenantModel(combined.harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'Mock Gather Interrupt Semantic Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'mock-gather-interrupt-semantic-model',
    endpointUrl: combined.mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: 'mock-gather-interrupt-semantic-model',
      apiKey: 'test-api-key',
    },
  });

  const outsider = await bootstrapProject(
    combined.harness,
    uniqueEmail('gather-interrupt-semantic-outsider'),
    uniqueSlug('gather-interrupt-semantic-outsider-tenant'),
    uniqueSlug('gather-interrupt-semantic-outsider-project'),
  );

  registerInitialChildHandoff(combined.mockLlm);
  registerSemanticNegativeTurn(combined.mockLlm, GATHER_INTERRUPT_MESSAGE);
  await setSuperAdmins([]);
  clearPermissionCache();

  return {
    harness: combined.harness,
    mockLlm: combined.mockLlm,
    admin,
    alternateProjectId: alternateProject._id,
    outsider,
  };
}

describe.sequential('Gather interrupt E2E', () => {
  let combined: GatherInterruptCombinedHarness;

  beforeAll(async () => {
    combined = await startGatherInterruptTestHarness();
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    await combined.reset();
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await combined.close();
  }, SUITE_TIMEOUT_MS);

  test('returns a child gather turn to the parent supervisor via normalized lexical fallback when classification is unavailable', async () => {
    const context = await bootstrapGatherInterruptContext(combined);
    await setSuperAdmins([]);
    clearPermissionCache();

    const firstTurn = await startChildGatherConversation(context);

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.sessionId).toBeTruthy();
    expect(firstTurn.body.response.toLowerCase()).toContain('destination');

    const secondTurn = await sendGatherInterrupt(
      context,
      firstTurn.body.sessionId,
      GATHER_INTERRUPT_MESSAGE,
    );

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.body.sessionId).toBe(firstTurn.body.sessionId);
    expect(secondTurn.body.response).toContain('find branches nearby');
    expect(secondTurn.body.action).toMatchObject({
      type: 'handoff',
      target: 'BranchLocatorSibling',
    });
    expect(secondTurn.body.state ?? {}).toEqual({});
    expect(secondTurn.body.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'digression',
          data: expect.objectContaining({
            intent: 'branch_locator',
            detectionMode: 'lexical',
            lexicalMatchType: 'normalized',
            matched: 'branch',
            target: 'BranchLocatorSibling',
          }),
        }),
        expect.objectContaining({
          type: 'return_to_parent',
          data: expect.objectContaining({
            from: 'ChildGatherFlow',
            to: 'GatherInterruptSupervisor',
            forwardedMessage: GATHER_INTERRUPT_MESSAGE,
          }),
        }),
      ]),
    );
    expect(findClassifierRequest(combined.mockLlm, GATHER_INTERRUPT_MESSAGE)).toBeUndefined();
  });

  test('keeps the child gather active when the classifier rejects a lexical interrupt candidate', async () => {
    const context = await bootstrapSemanticNegativeContext(combined);

    const firstTurn = await startChildGatherConversation(context);

    expect(firstTurn.status).toBe(200);
    expect(firstTurn.body.sessionId).toBeTruthy();
    expect(firstTurn.body.response.toLowerCase()).toContain('destination');

    const baselineSessionDetail = await waitForSessionDetail(
      context,
      firstTurn.body.sessionId,
      (detail) => countTraceEvents(detail, 'pipeline_classify') >= 1,
    );
    const baselinePipelineClassifyCount = countTraceEvents(
      baselineSessionDetail,
      'pipeline_classify',
    );

    const secondTurn = await sendGatherInterrupt(
      context,
      firstTurn.body.sessionId,
      GATHER_INTERRUPT_MESSAGE,
    );

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.body.sessionId).toBe(firstTurn.body.sessionId);
    expect(secondTurn.body.action?.type).not.toBe('return_to_parent');
    expect(secondTurn.body.response.toLowerCase()).toContain('destination');
    expect(secondTurn.body.traceEvents?.some((event) => event.type === 'digression') ?? false).toBe(
      false,
    );
    expect(
      secondTurn.body.traceEvents?.some((event) => event.type === 'return_to_parent') ?? false,
    ).toBe(false);
    expect(findClassifierRequest(combined.mockLlm, GATHER_INTERRUPT_MESSAGE)).toBeDefined();

    const sessionDetail = await waitForSessionDetail(
      context,
      firstTurn.body.sessionId,
      (detail) => countTraceEvents(detail, 'pipeline_classify') > baselinePipelineClassifyCount,
    );
    const classifyTrace = sessionDetail.traceEvents
      ?.filter((event) => event.type === 'pipeline_classify')
      .at(-1);

    expect(classifyTrace?.data.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: null,
          confidence: 0.19,
          summary: 'destination input',
          out_of_scope: false,
        }),
      ]),
    );
  });
});
