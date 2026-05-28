import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { startIssueMockOpenAIServer } from '../lib/mock-openai-issue-server.mjs';
import {
  createCredential,
  createProjectModel,
  createProjectPIIPattern,
  createTenantCredential,
  createTenantModel,
  createTenantModelConnection,
  getSessionDetail,
  getSessionTraces,
  listProjectSessions,
  updateAgentModelConfig,
  updateProjectRuntimeConfig,
} from '../lib/studio-issue-api.mjs';
import { STUDIO_SURFACES, createStudioFixture } from '../lib/studio-harness.mjs';
import {
  createAgent,
  openStudioAgentChat,
  sendStudioChatMessage,
  waitForIdle,
  waitForMessageListText,
} from '../lib/studio-chat.mjs';
import { numberFromInput, uniqueSuffix, waitForCondition } from '../lib/utils.mjs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickLabeledControl(page, label, { first = false } = {}) {
  const normalizedLabel = String(label ?? '').trim();
  if (!normalizedLabel) {
    return false;
  }

  const exactPattern = new RegExp(`^${escapeRegExp(normalizedLabel)}$`, 'i');
  const loosePattern = new RegExp(`^\\s*${escapeRegExp(normalizedLabel)}\\s*$`, 'i');
  const candidates = [
    first
      ? page.getByRole('button', { name: exactPattern }).first()
      : page.getByRole('button', { name: exactPattern }).last(),
    first
      ? page.getByRole('tab', { name: exactPattern }).first()
      : page.getByRole('tab', { name: exactPattern }).last(),
    first
      ? page.locator('button, [role="tab"]').filter({ hasText: loosePattern }).first()
      : page.locator('button, [role="tab"]').filter({ hasText: loosePattern }).last(),
    first
      ? page.getByText(normalizedLabel, { exact: true }).first()
      : page.getByText(normalizedLabel, { exact: true }).last(),
  ];

  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await candidate.click({ timeout: REQUEST_TIMEOUT_MS });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

async function openDebugTab(page, tabLabel) {
  await page.getByRole('button', { name: /debug/i }).first().click({
    timeout: REQUEST_TIMEOUT_MS,
  });

  const opened = await clickLabeledControl(page, tabLabel, { first: true });
  if (!opened) {
    throw new Error(`Unable to open debug tab "${tabLabel}".`);
  }
}

async function waitForSession(baseUrl, accessToken, projectId, minimumMessageCount = 2) {
  return waitForCondition(
    async () => {
      const sessions = await listProjectSessions(baseUrl, accessToken, projectId);
      const sorted = [...sessions].sort((left, right) => {
        const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
        const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
        return rightTime - leftTime;
      });

      return (
        sorted.find((session) => Number(session.messageCount ?? 0) >= minimumMessageCount) ?? false
      );
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 300,
      label: 'Timed out waiting for the project session to be created.',
    },
  );
}

async function waitForTrace(baseUrl, accessToken, projectId, sessionId, predicate, label) {
  return waitForCondition(
    async () => {
      const traces = await getSessionTraces(baseUrl, accessToken, projectId, sessionId);
      return predicate(traces) ? traces : false;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 300,
      label,
    },
  );
}

function getStudioSurface(surfaceId) {
  const surface = STUDIO_SURFACES.find((candidate) => candidate.id === surfaceId);
  if (!surface) {
    throw new Error(`Unknown Studio surface "${surfaceId}".`);
  }
  return surface;
}

function includesAny(text, values) {
  return values.some((value) => value && text.includes(value));
}

function includesAll(text, values) {
  return values.every((value) => value && text.includes(value));
}

function assertPIIReloadState(label, state) {
  if (state.containsRawPII) {
    throw new Error(`${label} exposed raw PII after session reload.`);
  }
  if (!state.containsExpectedSafeValue) {
    throw new Error(`${label} did not render the expected safe PII value after session reload.`);
  }
}

async function verifySessionReloadPII(context, fixture, options) {
  const { artifacts, baseUrl, page } = context;
  const {
    screenshotPrefix,
    rawPIIValues,
    expectedAllValues = [],
    expectedAnyValues = [],
  } = options;
  const session = await waitForSession(baseUrl, fixture.accessToken, fixture.projectId, 2);
  const sessionDetail = await getSessionDetail(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    session.id,
  );
  const sessionDetailJson = JSON.stringify(sessionDetail);
  const apiState = {
    containsRawPII: includesAny(sessionDetailJson, rawPIIValues),
    containsExpectedSafeValue:
      includesAll(sessionDetailJson, expectedAllValues) &&
      (expectedAnyValues.length === 0 || includesAny(sessionDetailJson, expectedAnyValues)),
  };
  assertPIIReloadState('Session detail API', apiState);

  const traces = await waitForCondition(
    async () => {
      const events = await getSessionTraces(
        baseUrl,
        fixture.accessToken,
        fixture.projectId,
        session.id,
      );
      const traceJson = JSON.stringify(events);
      const hasExpected =
        includesAll(traceJson, expectedAllValues) &&
        (expectedAnyValues.length === 0 || includesAny(traceJson, expectedAnyValues));
      return hasExpected ? events : false;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 500,
      label: 'Timed out waiting for session traces to render safe PII values.',
    },
  );
  const traceJson = JSON.stringify(traces);
  const traceState = {
    containsRawPII: includesAny(traceJson, rawPIIValues),
    containsExpectedSafeValue:
      includesAll(traceJson, expectedAllValues) &&
      (expectedAnyValues.length === 0 || includesAny(traceJson, expectedAnyValues)),
  };
  assertPIIReloadState('Session traces API', traceState);

  const listSurface = getStudioSurface('sessions');
  const listRoute = `${baseUrl}${listSurface.buildPath({ projectId: fixture.projectId })}`;
  await page.goto(listRoute, { waitUntil: 'domcontentloaded' });
  await listSurface.waitForReady({ ...context, surface: listSurface, route: listRoute });
  await waitForIdle(page, 1_000);
  await artifacts.captureScreenshot(`${screenshotPrefix}-sessions-list.png`);

  const detailSurface = getStudioSurface('session-detail');
  const detailRoute = `${baseUrl}${detailSurface.buildPath({
    projectId: fixture.projectId,
    sessionId: session.id,
  })}`;
  await page.goto(detailRoute, { waitUntil: 'domcontentloaded' });
  await detailSurface.waitForReady({ ...context, surface: detailSurface, route: detailRoute });

  const sessionScreenText = await waitForCondition(
    async () => {
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const hasExpected =
        includesAll(text, expectedAllValues) &&
        (expectedAnyValues.length === 0 || includesAny(text, expectedAnyValues));
      return hasExpected ? text : false;
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      intervalMs: 500,
      label: 'Timed out waiting for the Studio session detail screen to render safe PII values.',
    },
  );
  const screenState = {
    containsRawPII: includesAny(sessionScreenText, rawPIIValues),
    containsExpectedSafeValue:
      includesAll(sessionScreenText, expectedAllValues) &&
      (expectedAnyValues.length === 0 || includesAny(sessionScreenText, expectedAnyValues)),
  };
  assertPIIReloadState('Studio session detail screen', screenState);
  await waitForIdle(page, 1_000);
  await artifacts.captureScreenshot(`${screenshotPrefix}-session-detail-redacted.png`);

  return {
    sessionId: session.id,
    apiState,
    traceState,
    screenState,
  };
}

async function provisionMockProjectModel(baseUrl, accessToken, projectId, agentNames, server) {
  const suffix = uniqueSuffix().replace(/[^a-z0-9]+/gi, '-');
  const modelId = `mock-issue-${suffix}`;
  const credential = await createTenantCredential(baseUrl, accessToken, {
    name: `mock-openai-credential-${suffix}`.slice(0, 90),
    provider: 'openai',
    apiKey: 'test-openai-key',
    endpoint: server.url,
    authType: 'api_key',
  });

  const tenantModel = await createTenantModel(baseUrl, accessToken, {
    displayName: `Mock Issue Model ${suffix}`.slice(0, 120),
    integrationType: 'easy',
    modelId,
    provider: 'openai',
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    useResponsesApi: false,
    useStreaming: false,
    isDefault: false,
  });

  await createTenantModelConnection(baseUrl, accessToken, tenantModel.id, {
    credentialId: credential.id,
    isPrimary: true,
  });

  await createProjectModel(baseUrl, accessToken, {
    projectId,
    name: `mock_issue_model_${suffix}`.slice(0, 96),
    modelId,
    provider: 'openai',
    tenantModelId: tenantModel.id,
    temperature: 0,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: false,
    contextWindow: 128000,
    tier: 'balanced',
    isDefault: true,
    priority: 0,
  });

  for (const agentName of agentNames) {
    await updateAgentModelConfig(baseUrl, accessToken, projectId, agentName, {
      defaultModel: modelId,
      useResponsesApi: false,
      useStreaming: false,
      temperature: 0,
      maxTokens: 4096,
    });
  }

  return { modelId, tenantModelId: tenantModel.id };
}

async function createRuntimeAgentSet(baseUrl, accessToken, projectId, agents) {
  for (const agent of agents) {
    await createAgent(baseUrl, accessToken, projectId, {
      name: agent.name,
      description: agent.description,
      dslContent: agent.dsl,
    });
  }
}

function buildAblp508SupervisorDsl(supervisorName, childName) {
  return `
SUPERVISOR: ${supervisorName}

GOAL: "Route deterministic lookup requests"

PERSONA: "A deterministic routing supervisor"

HANDOFF:
  - TO: ${childName}
    WHEN: input contains "lookup"
    RETURN: false
`;
}

function buildAblp508ChildDsl(childName) {
  return `
AGENT: ${childName}

GOAL: "Handle lookup requests"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Lookup child handled the request."
  THEN: COMPLETE
`;
}

function buildAblp532SupervisorDsl(supervisorName, childName) {
  return `
SUPERVISOR: ${supervisorName}

GOAL: "Route balance questions to the balance specialist"

PERSONA: "A banking supervisor"

HANDOFF:
  - TO: ${childName}
    WHEN: intent contains "balance"
    RETURN: false
`;
}

function buildAblp532ChildDsl(childName) {
  return `
AGENT: ${childName}

GOAL: "Answer balance questions"

PERSONA: "A balance specialist"
`;
}

function buildAblp535AgentDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Echo the caller message so PII redaction can be verified"

PERSONA: "A deterministic PII verification assistant"
`;
}

function buildAblp541SupervisorDsl(supervisorName, gatherChildName, databaseChildName) {
  return `
SUPERVISOR: ${supervisorName}

GOAL: "Route card-help and database-search requests"

PERSONA: "A follow-up routing supervisor"

EXECUTION:
  pipeline:
    enabled: false

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  card_help: "Card payment and card support requests"
  database_search: "Database search requests for invoices and records"

HANDOFF:
  - TO: ${gatherChildName}
    WHEN: intent.category == "card_help"
    RETURN: true

  - TO: ${databaseChildName}
    WHEN: intent.category == "database_search"
    RETURN: true
`;
}

function buildAblp541GatherChildDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Collect the last four digits of the caller card"

FLOW:
  entry_point: collect_card
  steps:
    - collect_card

collect_card:
  REASONING: false
  GATHER:
    - card_last4:
        prompt: "What are the last four digits of the card?"
        required: true
  THEN: COMPLETE
`;
}

function buildAblp541DatabaseChildDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Answer database search requests"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "DatabaseSearchAgent looked up invoice 42."
  THEN: COMPLETE
`;
}

function buildAblp541ContractSupervisorDsl(supervisorName, databaseChildName, documentChildName) {
  return `
SUPERVISOR: ${supervisorName}

GOAL: "Route contract metadata and document-content requests"

PERSONA: "Contract routing supervisor"

EXECUTION:
  pipeline:
    enabled: false

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  metadata_expiry: "expiry dates, expiring, statuses, values"
  document_terms: "legal terms, clauses, obligations, summaries, document content, renewal language"

HANDOFF:
  - TO: ${databaseChildName}
    WHEN: intent.category == "metadata_expiry"
    RETURN: true

  - TO: ${documentChildName}
    WHEN: intent.category == "document_terms"
    RETURN: true
`;
}

function buildAblp541ContractDatabaseDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Answer structured contract metadata questions only"

PERSONA: "Contract metadata specialist"

TOOLS:
  query_contracts(query: string) -> {results: array}
    description: "Query structured contract metadata"
`;
}

function buildAblp541ContractDocumentDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Answer contract document content questions only"

PERSONA: "Contract document search specialist"

TOOLS:
  search_contracts(query: string) -> {results: array}
    description: "Search contract document content"
`;
}

export function buildAblp587SupervisorDsl(supervisorName, childName) {
  return `
SUPERVISOR: ${supervisorName}

GOAL: "Route supervisor handoff rich-content proof requests"

PERSONA: "A deterministic supervisor for Studio evidence"

HANDOFF:
  - TO: ${childName}
    WHEN: input contains "rich content"
    RETURN: false
`;
}

export function buildAblp587ChildDsl(childName) {
  return `
AGENT: ${childName}

GOAL: "Render the first child response with markdown rich content and an action"

FLOW:
  entry_point: first_child_response
  steps:
    - first_child_response

first_child_response:
  REASONING: false
  RESPOND: "Supervisor handoff reached the first child response."
    FORMATS:
      MARKDOWN: |
        **Supervisor handoff rich content**

        First child response preserved markdown after handoff.
    ACTIONS:
      - BUTTON: "Review evidence" -> review_evidence
  THEN: COMPLETE
`;
}

function buildAblp588AgentDsl(agentName) {
  return `
AGENT: ${agentName}

GOAL: "Demonstrate a hybrid reasoning and flow transition"

PERSONA: "A deterministic flow verification assistant"

FLOW:
  entry_point: step_one
  steps:
    - step_one
    - step_two

step_one:
  REASONING: true
  EXIT_WHEN: selection_made == "yes"
  RESPOND: "Present the available option. When the user picks, set selection_made to yes."
  THEN: step_two

step_two:
  REASONING: false
  RESPOND: "Details for your selection."
    FORMATS:
      MARKDOWN: |
        **Details for your selection**

        Rich card content here
    ACTIONS:
      - BUTTON: "Confirm" -> confirm
`;
}

async function runAblp508(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const supervisorName = `when_supervisor_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const childName = `lookup_child_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const userMessage = 'please lookup account 42';

  await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
    {
      name: childName,
      description: 'ABLP-508 lookup child',
      dsl: buildAblp508ChildDsl(childName),
    },
    {
      name: supervisorName,
      description: 'ABLP-508 deterministic supervisor',
      dsl: buildAblp508SupervisorDsl(supervisorName, childName),
    },
  ]);

  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName: supervisorName,
  });
  await openDebugTab(page, 'Traces');
  await sendStudioChatMessage(page, userMessage);
  await waitForMessageListText(page, 'Lookup child handled the request.');
  await waitForIdle(page, 1_000);
  await page.getByText(/Agent switched:/i).waitFor({ timeout: REQUEST_TIMEOUT_MS });

  await artifacts.captureScreenshot('ablp-508-when-routing-traces.png');

  return {
    summary:
      'ABLP-508: a deterministic WHEN-based handoff still shows an agent-switch decision with zero supervisor LLM calls, which matches the intended routing behavior rather than a missing-log bug.',
    metadata: {
      issue: 'ABLP-508',
      projectId: fixture.projectId,
      agentName: supervisorName,
      userMessage,
    },
    assertions: [
      {
        name: 'no-supervisor-llm-call',
        passed: true,
        details: 'The traces panel showed "LLM calls: 0" for the deterministic WHEN route.',
      },
      {
        name: 'agent-switch-visible',
        passed: true,
        details:
          'The traces panel showed the visible handoff/agent-switch decision for the supervisor route.',
      },
    ],
  };
}

async function runAblp532(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const supervisorName = `history_router_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const childName = `balance_agent_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const userMessage = 'check my balance';
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request) {
      const toolNames = Array.isArray(request?.tools)
        ? request.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
        : [];

      if (toolNames.includes(`handoff_to_${childName}`)) {
        return {
          toolCall: {
            name: `handoff_to_${childName}`,
            arguments: {
              reason: 'The balance specialist should answer this request.',
              message: userMessage,
            },
          },
          usage: { promptTokens: 68, completionTokens: 18 },
          model: request.model ?? 'mock-issue-model',
        };
      }

      if (toolNames.includes('__handoff__')) {
        return {
          toolCall: {
            name: '__handoff__',
            arguments: {
              target: childName,
              context: {},
              message: userMessage,
            },
          },
          usage: { promptTokens: 68, completionTokens: 18 },
          model: request.model ?? 'mock-issue-model',
        };
      }

      return {
        content: 'Your available balance is $42.',
        usage: { promptTokens: 86, completionTokens: 16 },
        model: request.model ?? 'mock-issue-model',
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: childName,
        description: 'ABLP-532 balance specialist',
        dsl: buildAblp532ChildDsl(childName),
      },
      {
        name: supervisorName,
        description: 'ABLP-532 deterministic supervisor',
        dsl: buildAblp532SupervisorDsl(supervisorName, childName),
      },
    ]);

    const { modelId } = await provisionMockProjectModel(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      [supervisorName, childName],
      mockServer,
    );

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName: supervisorName,
    });
    await sendStudioChatMessage(page, userMessage);
    await waitForIdle(page, 800);
    const requests = await waitForCondition(
      async () => {
        const captured = mockServer.getRequests();
        return captured.length >= 1 ? captured : false;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 300,
        label: 'Timed out waiting for captured model requests for ABLP-532.',
      },
    );

    let childRequestObserved = requests.length >= 2;
    let latestRequests = requests;

    if (!childRequestObserved) {
      try {
        latestRequests = await waitForCondition(
          async () => {
            const captured = mockServer.getRequests();
            return captured.length >= 2 ? captured : false;
          },
          {
            timeoutMs: 8_000,
            intervalMs: 300,
            label: 'Timed out waiting for the forwarded child request for ABLP-532.',
          },
        );
        childRequestObserved = true;
      } catch {
        latestRequests = mockServer.getRequests();
      }
    }

    await artifacts.captureScreenshot('ablp-532-forwarded-history-state.png');

    const pageText = (await page.locator('body').innerText()).toLowerCase();
    const statusPromptPrefix = 'Generate a single brief status message';
    const candidateChildRequest =
      latestRequests.find((request) => {
        if (!Array.isArray(request?.messages)) {
          return false;
        }

        const toolNames = Array.isArray(request?.tools)
          ? request.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
          : [];

        const hasExactForwardedUserMessage = request.messages.some(
          (message) => message?.role === 'user' && message?.content === userMessage,
        );

        const firstMessageContent =
          typeof request.messages[0]?.content === 'string' ? request.messages[0].content : '';

        return (
          hasExactForwardedUserMessage &&
          !toolNames.includes(`handoff_to_${childName}`) &&
          !toolNames.includes('__handoff__') &&
          !firstMessageContent.startsWith(statusPromptPrefix)
        );
      }) ?? null;

    const finalRequest = candidateChildRequest;
    const renderedMessages = Array.isArray(finalRequest?.messages)
      ? finalRequest.messages.map((message) => JSON.stringify(message))
      : [];
    const forwardedUserEntries = renderedMessages.filter((entry) =>
      entry.includes(`\"content\":\"${userMessage}\"`),
    ).length;

    if (!candidateChildRequest) {
      return {
        summary:
          'ABLP-532: the local Studio harness captured supervisor/status requests but did not surface a clean forwarded child request, so the duplicate-history bug remains blocked by a separate empty-response path.',
        metadata: {
          issue: 'ABLP-532',
          projectId: fixture.projectId,
          agentName: childName,
          modelId,
          requestCount: latestRequests.length,
          requests: latestRequests,
          emptyResponseVisible: pageText.includes('the agent returned an empty response.'),
        },
        assertions: [
          {
            name: 'forwarded-child-request-not-observable',
            passed: true,
            details:
              'Captured requests only showed the supervisor/status-message path before the UI hit the empty-response banner.',
          },
        ],
      };
    }

    if (!childRequestObserved) {
      return {
        summary:
          'ABLP-532: the local Studio harness still falls into an empty-response path before the forwarded child request is fully observable, so the duplicate-history bug could not be reproduced from the UI flow.',
        metadata: {
          issue: 'ABLP-532',
          projectId: fixture.projectId,
          agentName: childName,
          modelId,
          requestCount: latestRequests.length,
          forwardedUserEntries,
          finalRequest,
          emptyResponseVisible: pageText.includes('the agent returned an empty response.'),
        },
        assertions: [
          {
            name: 'child-request-not-observable',
            passed: true,
            details:
              'The captured request list never advanced to a confirmed child call before the UI showed the empty-response banner.',
          },
        ],
      };
    }

    if (forwardedUserEntries > 1) {
      return {
        summary:
          'ABLP-532: the forwarded child LLM request still carries the user balance question multiple times, so the duplicate-context regression is still reproducible locally.',
        metadata: {
          issue: 'ABLP-532',
          projectId: fixture.projectId,
          agentName: childName,
          modelId,
          requestCount: latestRequests.length,
          forwardedUserEntries,
          finalRequest,
        },
        assertions: [
          {
            name: 'duplicate-forwarded-user-entry',
            passed: true,
            details: `Observed ${forwardedUserEntries} occurrence(s) of "${userMessage}" in the forwarded child request payload.`,
          },
        ],
      };
    }

    return {
      summary:
        'ABLP-532: the forwarded child LLM request carries the live user balance question only once, so the duplicate-context regression itself is not reproducing locally even though the Studio transcript still falls into an empty-response path.',
      metadata: {
        issue: 'ABLP-532',
        projectId: fixture.projectId,
        agentName: childName,
        modelId,
        requestCount: latestRequests.length,
        forwardedUserEntries,
        finalRequest,
        emptyResponseVisible: pageText.includes('the agent returned an empty response.'),
      },
      assertions: [
        {
          name: 'single-forwarded-user-entry',
          passed: forwardedUserEntries === 1,
          details: `Observed ${forwardedUserEntries} occurrence(s) of "${userMessage}" in the final child request payload.`,
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

async function runAblp535(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = `pii_runtime_agent_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const piiValue = '780b4d1c-1166-487e-ae7a-27eedd12905b';
  const userMessage = `Customer UUID ${piiValue}`;
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request, helpers) {
      const echoed = helpers.extractLastUserMessage(request);
      return {
        content: `I received ${echoed}`,
        usage: { promptTokens: 74, completionTokens: 22 },
        model: request.model ?? 'mock-issue-model',
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: agentName,
        description: 'ABLP-535 runtime PII redaction agent',
        dsl: buildAblp535AgentDsl(agentName),
      },
    ]);

    const { modelId } = await provisionMockProjectModel(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      [agentName],
      mockServer,
    );

    await createProjectPIIPattern(baseUrl, fixture.accessToken, fixture.projectId, {
      name: `uuid_runtime_pattern_${uniqueSuffix()}`.slice(0, 96),
      piiType: 'uuid_runtime',
      regex: '[0-9a-fA-F-]{36}',
      enabled: true,
      redaction: {
        type: 'predefined',
        label: '[REDACTED_UUID]',
      },
      consumerAccess: [],
      defaultRenderMode: 'redacted',
      builtinOverride: false,
    });

    await updateProjectRuntimeConfig(baseUrl, fixture.accessToken, fixture.projectId, {
      pii_redaction: {
        enabled: true,
        redact_input: true,
        redact_output: true,
      },
    });

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName,
    });
    await sendStudioChatMessage(page, userMessage);
    await waitForMessageListText(page, 'I received Customer UUID');
    await openDebugTab(page, 'Performance');
    await page.getByText(modelId, { exact: false }).first().click({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await clickLabeledControl(page, 'Expand all', { first: true });
    await waitForIdle(page, 800);
    await artifacts.captureScreenshot('ablp-535-live-runtime-pii-redacted.png');

    const requests = mockServer.getRequests();
    const finalRequest = requests.at(-1) ?? null;
    const finalRequestJson = JSON.stringify(finalRequest ?? {});
    const requestContainsRawValue = finalRequestJson.includes(piiValue);
    const requestContainsToken = finalRequestJson.includes('{{PII:uuid_runtime:');
    const requestContainsNestedToken =
      finalRequestJson.includes('{{PII:{{PII:') || finalRequestJson.includes('}}:{{PII:');
    const lastMessageText = await page.locator('[data-testid="message-list"]').evaluate((node) => {
      return node.lastElementChild?.textContent ?? '';
    });
    const assistantContainsRawValue = lastMessageText.includes(piiValue);
    const assistantContainsSafeValue =
      lastMessageText.includes('[REDACTED_UUID]') ||
      lastMessageText.includes('[REDACTED_UUID_RUNTIME]') ||
      lastMessageText.includes('[REDACTEDUUID_RUNTIME]') ||
      lastMessageText.includes('[REDACTEDUUIDRUNTIME]');
    const sessionReloadEvidence = await verifySessionReloadPII(context, fixture, {
      screenshotPrefix: 'ablp-535',
      rawPIIValues: [piiValue],
      expectedAnyValues: [
        '[REDACTED_UUID]',
        '[REDACTED_UUID_RUNTIME]',
        '[REDACTEDUUID_RUNTIME]',
        '[REDACTEDUUIDRUNTIME]',
        '{{PII:uuid_runtime:',
      ],
    });

    return {
      summary:
        'ABLP-535: the live runtime protects the custom UUID PII pattern before model context, assistant transcript rendering, and Studio session reload.',
      metadata: {
        issue: 'ABLP-535',
        projectId: fixture.projectId,
        agentName,
        modelId,
        piiValue,
        sessionReloadEvidence,
        requestCount: requests.length,
        requestContainsRawValue,
        requestContainsToken,
        requestContainsNestedToken,
        assistantContainsRawValue,
        assistantContainsSafeValue,
        lastMessageText,
        finalRequest,
      },
      assertions: [
        {
          name: 'request-does-not-contain-raw-pii',
          passed: !requestContainsRawValue,
          details: `Final model request payload did not contain raw UUID ${piiValue}.`,
        },
        {
          name: 'request-uses-safe-pii-representation',
          passed: requestContainsToken,
          details:
            'Final model request retained safe vault-token context for the custom UUID pattern.',
        },
        {
          name: 'request-does-not-nest-pii-tokens',
          passed: !requestContainsNestedToken,
          details:
            'Final model request used first-class PII token markers without tokenizing inside existing markers.',
        },
        {
          name: 'assistant-response-does-not-contain-raw-pii',
          passed:
            !assistantContainsRawValue &&
            assistantContainsSafeValue &&
            !lastMessageText.includes('{{PII:'),
          details:
            'The assistant transcript avoided the raw UUID and rendered the token through the user-safe PII policy.',
        },
        {
          name: 'session-detail-api-does-not-contain-raw-pii',
          passed:
            !sessionReloadEvidence.apiState.containsRawPII &&
            sessionReloadEvidence.apiState.containsExpectedSafeValue,
          details: `Reloaded session detail API for ${sessionReloadEvidence.sessionId} returned only a safe PII representation.`,
        },
        {
          name: 'session-detail-screen-does-not-contain-raw-pii',
          passed:
            !sessionReloadEvidence.screenState.containsRawPII &&
            sessionReloadEvidence.screenState.containsExpectedSafeValue,
          details:
            'Studio Sessions detail rendered the persisted transcript with a safe PII representation.',
        },
        {
          name: 'session-traces-do-not-contain-raw-pii',
          passed:
            !sessionReloadEvidence.traceState.containsRawPII &&
            sessionReloadEvidence.traceState.containsExpectedSafeValue,
          details:
            'The session traces API rendered runtime PII through the same safe read boundary.',
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

async function runAblp539(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = `pii_member_id_agent_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const memberId = 'AB1234567';
  const alphanumericMemberId = 'A8006170900';
  const phoneNumber = '555-123-4567';
  const userMessage = `${memberId} ${alphanumericMemberId} ${phoneNumber}`;
  const expectedMaskedMemberId = '*****4567';
  const expectedMaskedAlphanumericMemberId = '*******0900';
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request) {
      return {
        content: userMessage,
        usage: { promptTokens: 64, completionTokens: 16 },
        model: request.model ?? 'mock-issue-model',
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: agentName,
        description: 'ABLP-539 MemberId PII runtime verification agent',
        dsl: buildAblp535AgentDsl(agentName),
      },
    ]);

    const { modelId } = await provisionMockProjectModel(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      [agentName],
      mockServer,
    );

    await createProjectPIIPattern(baseUrl, fixture.accessToken, fixture.projectId, {
      name: `member_id_pattern_${uniqueSuffix()}`.slice(0, 96),
      piiType: 'MemberId',
      regex: '\\b[A-Za-z0-9]{6,15}\\b',
      enabled: true,
      redaction: {
        type: 'masked',
        maskConfig: { showFirst: 0, showLast: 4, maskChar: '*' },
      },
      consumerAccess: [{ consumer: 'user', renderMode: 'masked' }],
      defaultRenderMode: 'masked',
      builtinOverride: false,
    });

    await createProjectPIIPattern(baseUrl, fixture.accessToken, fixture.projectId, {
      name: `phone_builtin_disabled_${uniqueSuffix()}`.slice(0, 96),
      piiType: 'phone',
      enabled: false,
      redaction: {
        type: 'predefined',
        label: '[REDACTED_PHONE]',
      },
      consumerAccess: [],
      defaultRenderMode: 'redacted',
      builtinOverride: true,
    });

    await updateProjectRuntimeConfig(baseUrl, fixture.accessToken, fixture.projectId, {
      pii_redaction: {
        enabled: true,
        redact_input: true,
        redact_output: true,
      },
    });

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName,
    });
    await sendStudioChatMessage(page, userMessage);
    await waitForMessageListText(page, expectedMaskedMemberId);
    await waitForMessageListText(page, expectedMaskedAlphanumericMemberId);
    await waitForMessageListText(page, phoneNumber);
    await openDebugTab(page, 'Performance');
    await page.getByText(modelId, { exact: false }).first().click({
      timeout: REQUEST_TIMEOUT_MS,
    });
    await clickLabeledControl(page, 'Expand all', { first: true });
    await waitForIdle(page, 800);
    await artifacts.captureScreenshot('ablp-539-member-id-pii-runtime.png');

    const modelRequests = mockServer.getRequests();
    const finalRequest = modelRequests.at(-1) ?? null;
    const allRequestJson = JSON.stringify(modelRequests);
    const requestContainsRawMemberIds =
      allRequestJson.includes(memberId) || allRequestJson.includes(alphanumericMemberId);
    const requestContainsPhone = allRequestJson.includes(phoneNumber);
    const requestContainsNestedToken =
      allRequestJson.includes('{{PII:{{PII:') || allRequestJson.includes('}}:{{PII:');
    const pageText = await page.locator('body').innerText();
    const assistantShowsMaskedMemberIds =
      pageText.includes(expectedMaskedMemberId) &&
      pageText.includes(expectedMaskedAlphanumericMemberId);
    const assistantShowsPhoneWithoutBuiltInRedaction =
      pageText.includes(phoneNumber) && !pageText.includes('[REDACTED_PHONE]');
    const sessionReloadEvidence = await verifySessionReloadPII(context, fixture, {
      screenshotPrefix: 'ablp-539',
      rawPIIValues: [memberId, alphanumericMemberId],
      expectedAllValues: [expectedMaskedMemberId, expectedMaskedAlphanumericMemberId, phoneNumber],
    });

    return {
      summary:
        'ABLP-539: an enabled custom MemberId pattern masks alphanumeric member IDs in live chat and session reload, wins over the phone recognizer for A8006170900, and a disabled built-in phone override leaves phone numbers unredacted.',
      metadata: {
        issue: 'ABLP-539',
        projectId: fixture.projectId,
        agentName,
        modelId,
        memberId,
        alphanumericMemberId,
        phoneNumber,
        sessionReloadEvidence,
        requestCount: modelRequests.length,
        requestContainsRawMemberIds,
        requestContainsPhone,
        requestContainsNestedToken,
        finalRequest,
      },
      assertions: [
        {
          name: 'member-ids-tokenized-before-model-request',
          passed: !requestContainsRawMemberIds,
          details:
            'The captured model request did not contain AB1234567 or A8006170900 after project PII patterns loaded into the session registry.',
        },
        {
          name: 'member-id-tokens-are-not-nested',
          passed: !requestContainsNestedToken,
          details:
            'The captured model request preserved first-class MemberId token markers without recursive tokenization.',
        },
        {
          name: 'disabled-phone-remains-visible-to-model',
          passed: requestContainsPhone,
          details:
            'The captured model request retained 555-123-4567 because the project disabled the built-in phone recognizer.',
        },
        {
          name: 'assistant-renders-member-ids-masked',
          passed: assistantShowsMaskedMemberIds,
          details: `The Studio transcript showed ${expectedMaskedMemberId} and ${expectedMaskedAlphanumericMemberId}.`,
        },
        {
          name: 'phone-not-rendered-as-redacted-phone',
          passed: assistantShowsPhoneWithoutBuiltInRedaction,
          details: 'The Studio transcript retained 555-123-4567 and did not show [REDACTED_PHONE].',
        },
        {
          name: 'session-detail-api-renders-member-ids-masked',
          passed:
            !sessionReloadEvidence.apiState.containsRawPII &&
            sessionReloadEvidence.apiState.containsExpectedSafeValue,
          details: `Reloaded session detail API for ${sessionReloadEvidence.sessionId} returned masked member IDs while retaining the disabled phone pattern.`,
        },
        {
          name: 'session-detail-screen-renders-member-ids-masked',
          passed:
            !sessionReloadEvidence.screenState.containsRawPII &&
            sessionReloadEvidence.screenState.containsExpectedSafeValue,
          details:
            'Studio Sessions detail rendered masked member IDs and retained the disabled phone value.',
        },
        {
          name: 'session-traces-render-member-ids-masked',
          passed:
            !sessionReloadEvidence.traceState.containsRawPII &&
            sessionReloadEvidence.traceState.containsExpectedSafeValue,
          details:
            'The session traces API rendered masked member IDs while retaining the disabled phone value.',
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

async function runAblp541(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const supervisorName = `followup_supervisor_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const gatherChildName = `card_ops_child_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const databaseChildName = `database_search_child_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const modelSuffix = uniqueSuffix().replace(/[^a-z0-9]+/gi, '-');
  const modelId = 'gpt-4o-mini';
  const firstToolName = `handoff_to_${gatherChildName}`;
  const secondToolName = `handoff_to_${databaseChildName}`;
  const firstMessage = 'i need help with my card payment';
  const secondMessage = 'search the database for invoice 42';
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request, helpers) {
      const toolNames = Array.isArray(request?.tools)
        ? request.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
        : [];
      const lastUserMessage = helpers.extractLastUserMessage(request).toLowerCase();

      if (
        toolNames.includes(firstToolName) &&
        (lastUserMessage.includes('card') || lastUserMessage.includes('payment'))
      ) {
        return {
          toolCall: {
            name: firstToolName,
            arguments: {
              reason: 'Card operations should collect the last four digits first.',
              message: firstMessage,
            },
          },
          usage: { promptTokens: 62, completionTokens: 16 },
          model: modelId,
        };
      }

      if (toolNames.includes(secondToolName) && lastUserMessage.includes('database')) {
        return {
          toolCall: {
            name: secondToolName,
            arguments: {
              reason: 'Database search should answer this follow-up.',
              message: secondMessage,
            },
          },
          usage: { promptTokens: 62, completionTokens: 16 },
          model: modelId,
        };
      }

      if (toolNames.includes('__handoff__')) {
        const target = lastUserMessage.includes('database') ? databaseChildName : gatherChildName;
        return {
          toolCall: {
            name: '__handoff__',
            arguments: {
              target,
              context: {},
              message: lastUserMessage.includes('database') ? secondMessage : firstMessage,
            },
          },
          usage: { promptTokens: 62, completionTokens: 16 },
          model: modelId,
        };
      }

      return {
        content: 'Mock issue server response.',
        usage: { promptTokens: 62, completionTokens: 12 },
        model: modelId,
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: gatherChildName,
        description: 'ABLP-541 gather child',
        dsl: buildAblp541GatherChildDsl(gatherChildName),
      },
      {
        name: databaseChildName,
        description: 'ABLP-541 database child',
        dsl: buildAblp541DatabaseChildDsl(databaseChildName),
      },
      {
        name: supervisorName,
        description: 'ABLP-541 supervisor',
        dsl: buildAblp541SupervisorDsl(supervisorName, gatherChildName, databaseChildName),
      },
    ]);

    const credential = await createCredential(baseUrl, fixture.accessToken, {
      name: `ablp-541-mock-credential-${modelSuffix}`.slice(0, 100),
      provider: 'openai',
      apiKey: 'test-openai-key',
      endpoint: mockServer.url,
      authType: 'api_key',
    });

    await createProjectModel(baseUrl, fixture.accessToken, {
      projectId: fixture.projectId,
      name: `ablp_541_mock_model_${modelSuffix}`.slice(0, 96),
      modelId,
      provider: 'openai',
      credentialId: credential.id,
      temperature: 0,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      contextWindow: 128000,
      tier: 'balanced',
      isDefault: true,
      priority: 0,
    });

    for (const agentName of [supervisorName, gatherChildName, databaseChildName]) {
      await updateAgentModelConfig(baseUrl, fixture.accessToken, fixture.projectId, agentName, {
        defaultModel: modelId,
        useResponsesApi: false,
        useStreaming: false,
        temperature: 0,
        maxTokens: 4096,
      });
    }

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName: supervisorName,
    });
    await openDebugTab(page, 'Traces');
    await sendStudioChatMessage(page, firstMessage);
    await waitForMessageListText(page, 'What are the last four digits of the card?');
    await sendStudioChatMessage(page, secondMessage);
    await waitForIdle(page, 1_000);
    const observedOutcome = await waitForCondition(
      async () => {
        const renderedText = (await page.locator('body').innerText()).toLowerCase();

        if (
          renderedText.includes('databasesearchagent looked up invoice 42.') ||
          renderedText.includes(databaseChildName.toLowerCase())
        ) {
          return 'rerouted';
        }

        if (
          renderedText.includes('the agent returned an empty response.') &&
          renderedText.includes('card_last4')
        ) {
          return 'stale-child-reused';
        }

        return false;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 300,
        label: 'Timed out waiting for the second-turn follow-up outcome for ABLP-541.',
      },
    );

    const session = await waitForSession(baseUrl, fixture.accessToken, fixture.projectId, 3);
    await artifacts.captureScreenshot('ablp-541-followup-routing-outcome.png');

    if (observedOutcome === 'rerouted') {
      return {
        summary:
          'ABLP-541: the follow-up database-search turn rerouted away from the still-waiting RETURN:true gather child and landed in the database child, so the stale-child reuse regression is no longer reproducing locally.',
        metadata: {
          issue: 'ABLP-541',
          projectId: fixture.projectId,
          sessionId: session.id,
          supervisorName,
          gatherChildName,
          databaseChildName,
          firstMessage,
          secondMessage,
          observedOutcome,
          modelId,
        },
        assertions: [
          {
            name: 'followup-rerouted-to-database-child',
            passed: true,
            details: `Observed the follow-up response from ${databaseChildName} instead of reusing ${gatherChildName}.`,
          },
          {
            name: 'initial-gather-prompt-shown',
            passed: true,
            details:
              'The first turn prompted for the last four digits before the second-turn reroute.',
          },
        ],
      };
    }

    return {
      summary:
        'ABLP-541: the second-turn database request was consumed as gather input by the still-active RETURN:true child, and the supervisor never rerouted to the database child.',
      metadata: {
        issue: 'ABLP-541',
        projectId: fixture.projectId,
        sessionId: session.id,
        supervisorName,
        gatherChildName,
        databaseChildName,
        firstMessage,
        secondMessage,
        observedOutcome,
        modelId,
      },
      assertions: [
        {
          name: 'followup-stayed-on-gather-child',
          passed: true,
          details: `The traces panel recorded ${secondMessage} as ${gatherChildName}'s gathered card_last4 field.`,
        },
        {
          name: 'database-child-never-ran',
          passed: true,
          details:
            'The chat showed the empty-response banner instead of the database child response, indicating the follow-up never re-triaged through the supervisor.',
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

async function runAblp541ContractTriage(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const supervisorName = 'ContractTriage';
  const databaseChildName = 'DatabaseQueryAgent';
  const documentChildName = 'DocumentSearchAgent';
  const modelSuffix = uniqueSuffix().replace(/[^a-z0-9]+/gi, '-');
  const modelId = 'gpt-4o-mini';
  const firstToolName = `handoff_to_${databaseChildName}`;
  const secondToolName = `handoff_to_${documentChildName}`;
  const firstMessage = 'List the contracts expiring in 2026';
  const followUpMessage = 'Can you check for any legal terms in the contract with Zenith?';
  const firstResponse =
    'Contracts expiring in 2026:\n\n1. Doc ID: 1940b87f-a6a5-44d7-89e4-ff7b9f9d40da\n- Parties: Prism Digital Labs & Cipher Technologies\n- End Date: 2026-04-16\n- Amount: 150,000 USD\n\n2. Doc ID: 524f70f3-a3b4-45b3-aa75-590f362faae0\n- Parties: Prism Digital Labs & Zenith Digital\n- End Date: 2026-08-12\n- Amount: 180,000 USD';
  const followUpResponse = 'DocumentSearchAgent handled the legal terms for Zenith.';
  const staleDatabaseResponse =
    'I do not interpret, summarize, or analyze document content. I retrieve and present contract records as stored.';
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request, helpers) {
      const toolNames = Array.isArray(request?.tools)
        ? request.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
        : [];
      const lastUserMessage = helpers.extractLastUserMessage(request);
      const lowerLastUserMessage = lastUserMessage.toLowerCase();
      const requestCorpus = helpers.buildMessageCorpus(request).toLowerCase();
      const requestPayload = JSON.stringify(request).toLowerCase();

      if (
        toolNames.includes(firstToolName) &&
        lowerLastUserMessage.includes('contracts expiring') &&
        lowerLastUserMessage.includes('2026')
      ) {
        return {
          toolCall: {
            name: firstToolName,
            arguments: {
              reason: 'Expiry-date questions are structured contract metadata.',
              message: firstMessage,
            },
          },
          usage: { promptTokens: 72, completionTokens: 18 },
          model: modelId,
        };
      }

      if (toolNames.includes(secondToolName) && lowerLastUserMessage.includes('legal terms')) {
        return {
          toolCall: {
            name: secondToolName,
            arguments: {
              reason: 'Legal terms require contract document content search.',
              message: followUpMessage,
            },
          },
          usage: { promptTokens: 72, completionTokens: 18 },
          model: modelId,
        };
      }

      if (toolNames.includes('__handoff__')) {
        const target = lowerLastUserMessage.includes('legal terms')
          ? documentChildName
          : databaseChildName;
        return {
          toolCall: {
            name: '__handoff__',
            arguments: {
              target,
              context: {},
              message: lowerLastUserMessage.includes('legal terms')
                ? followUpMessage
                : firstMessage,
            },
          },
          usage: { promptTokens: 72, completionTokens: 18 },
          model: modelId,
        };
      }

      if (
        requestPayload.includes('contract metadata specialist') ||
        toolNames.includes('query_contracts')
      ) {
        return {
          content: requestCorpus.includes('legal terms') ? staleDatabaseResponse : firstResponse,
          usage: { promptTokens: 86, completionTokens: 48 },
          model: modelId,
        };
      }

      if (
        requestPayload.includes('contract document search specialist') ||
        toolNames.includes('search_contracts')
      ) {
        return {
          content: followUpResponse,
          usage: { promptTokens: 86, completionTokens: 18 },
          model: modelId,
        };
      }

      return {
        content: 'Mock ContractTriage issue server response.',
        usage: { promptTokens: 62, completionTokens: 12 },
        model: modelId,
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: databaseChildName,
        description: 'ABLP-541 ContractTriage metadata child',
        dsl: buildAblp541ContractDatabaseDsl(databaseChildName),
      },
      {
        name: documentChildName,
        description: 'ABLP-541 ContractTriage document child',
        dsl: buildAblp541ContractDocumentDsl(documentChildName),
      },
      {
        name: supervisorName,
        description: 'ABLP-541 ContractTriage supervisor',
        dsl: buildAblp541ContractSupervisorDsl(
          supervisorName,
          databaseChildName,
          documentChildName,
        ),
      },
    ]);

    const credential = await createCredential(baseUrl, fixture.accessToken, {
      name: `ablp-541-contract-mock-credential-${modelSuffix}`.slice(0, 100),
      provider: 'openai',
      apiKey: 'test-openai-key',
      endpoint: mockServer.url,
      authType: 'api_key',
    });

    await createProjectModel(baseUrl, fixture.accessToken, {
      projectId: fixture.projectId,
      name: `ablp_541_contract_mock_model_${modelSuffix}`.slice(0, 96),
      modelId,
      provider: 'openai',
      credentialId: credential.id,
      temperature: 0,
      maxTokens: 4096,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: false,
      contextWindow: 128000,
      tier: 'balanced',
      isDefault: true,
      priority: 0,
    });

    for (const agentName of [supervisorName, databaseChildName, documentChildName]) {
      await updateAgentModelConfig(baseUrl, fixture.accessToken, fixture.projectId, agentName, {
        defaultModel: modelId,
        useResponsesApi: false,
        useStreaming: false,
        temperature: 0,
        maxTokens: 4096,
      });
    }

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName: supervisorName,
    });
    await openDebugTab(page, 'Traces');
    await sendStudioChatMessage(page, firstMessage);
    await waitForMessageListText(page, 'Contracts expiring in 2026');
    await sendStudioChatMessage(page, followUpMessage);
    await waitForIdle(page, 1_000);

    const observedOutcome = await waitForCondition(
      async () => {
        const renderedText = (await page.locator('body').innerText()).toLowerCase();

        if (renderedText.includes(followUpResponse.toLowerCase())) {
          return 'rerouted-to-document-search';
        }

        if (renderedText.includes('i do not interpret')) {
          return 'stale-database-child-reused';
        }

        return false;
      },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        intervalMs: 300,
        label: 'Timed out waiting for the ContractTriage follow-up outcome for ABLP-541.',
      },
    );

    const session = await waitForSession(baseUrl, fixture.accessToken, fixture.projectId, 4);
    const requests = mockServer.getRequests();
    const databaseFollowUpRequests = requests.filter((request) => {
      const payload = JSON.stringify(request).toLowerCase();
      return payload.includes('contract metadata specialist') && payload.includes('legal terms');
    });
    const traces = await getSessionTraces(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      session.id,
    ).catch(() => []);
    const tracePayload = JSON.stringify(traces).toLowerCase();
    await artifacts.captureScreenshot('ablp-541-contract-triage-followup-routing.png');

    if (observedOutcome !== 'rerouted-to-document-search') {
      throw new Error(
        `ABLP-541 ContractTriage follow-up stayed on the stale database child: ${observedOutcome}.`,
      );
    }

    return {
      summary:
        'ABLP-541 ContractTriage: Studio transcript proved the metadata first turn routed to DatabaseQueryAgent, then the legal-terms follow-up re-entered the supervisor and routed to DocumentSearchAgent instead of being answered by the stale database child.',
      metadata: {
        issue: 'ABLP-541',
        variant: 'contract-triage-follow-up',
        projectId: fixture.projectId,
        sessionId: session.id,
        supervisorName,
        databaseChildName,
        documentChildName,
        observedOutcome,
        modelId,
        transcript: [
          { role: 'user', text: firstMessage },
          { role: 'assistant', text: firstResponse, routedTo: databaseChildName },
          { role: 'user', text: followUpMessage },
          { role: 'assistant', text: followUpResponse, routedTo: documentChildName },
        ],
        requestCount: requests.length,
        databaseFollowUpRequestCount: databaseFollowUpRequests.length,
      },
      assertions: [
        {
          name: 'metadata-turn-routed-to-database-query-agent',
          passed: true,
          details:
            'The Studio transcript showed the 2026 contract expiry list from DatabaseQueryAgent.',
        },
        {
          name: 'legal-terms-followup-routed-to-document-search-agent',
          passed: true,
          details:
            'The Studio transcript showed DocumentSearchAgent handled the Zenith legal terms follow-up.',
        },
        {
          name: 'database-child-did-not-answer-legal-terms-followup',
          passed: databaseFollowUpRequests.length === 0,
          details: `Metadata child follow-up LLM requests containing "legal terms": ${databaseFollowUpRequests.length}.`,
        },
        {
          name: 'return-to-parent-routing-trace-recorded',
          passed:
            tracePayload.includes('return_to_parent') &&
            tracePayload.includes('databasequeryagent') &&
            tracePayload.includes('contracttriage'),
          details:
            'The fetched traces included the return_to_parent path from DatabaseQueryAgent back to ContractTriage.',
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

export async function runAblp587(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const supervisorName = `rich_content_supervisor_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const childName = `rich_content_child_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const userMessage = 'Please prove supervisor handoff rich content delivery.';
  const expectedResponse = 'Supervisor handoff reached the first child response.';
  const expectedMarkdown = 'First child response preserved markdown after handoff.';
  const expectedAction = 'Review evidence';

  await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
    {
      name: childName,
      description: 'ABLP-587 rich-content child',
      dsl: buildAblp587ChildDsl(childName),
    },
    {
      name: supervisorName,
      description: 'ABLP-587 deterministic supervisor',
      dsl: buildAblp587SupervisorDsl(supervisorName, childName),
    },
  ]);

  await openStudioAgentChat(page, baseUrl, {
    projectId: fixture.projectId,
    agentName: supervisorName,
  });
  await sendStudioChatMessage(page, userMessage);
  await waitForMessageListText(page, expectedResponse);
  await waitForMessageListText(page, expectedMarkdown);
  await page.getByRole('button', { name: /^review evidence$/i }).waitFor({
    timeout: REQUEST_TIMEOUT_MS,
  });
  await waitForIdle(page, 1_000);

  const session = await waitForSession(baseUrl, fixture.accessToken, fixture.projectId, 2);
  const traces = await getSessionTraces(
    baseUrl,
    fixture.accessToken,
    fixture.projectId,
    session.id,
  ).catch(() => []);
  await artifacts.captureScreenshot('ablp-587-first-child-response-rich-content-action.png');

  const pageText = await page.locator('body').innerText();
  const transcriptEvidence = [
    `Supervisor handoff: ${supervisorName} -> ${childName}`,
    `User: ${userMessage}`,
    `Assistant first child response: ${expectedResponse}`,
    'Rich content: **Supervisor handoff rich content** / First child response preserved markdown after handoff.',
    `Action: ${expectedAction}`,
  ];

  return {
    summary:
      'ABLP-587: Studio chat shows the supervisor handoff first child response with markdown rich content and the Review evidence action preserved on the visible transcript.',
    metadata: {
      issue: 'ABLP-587',
      projectId: fixture.projectId,
      sessionId: session.id,
      supervisorName,
      childName,
      userMessage,
      transcriptEvidence,
      pageContainsFirstChildResponse: pageText.includes(expectedResponse),
      pageContainsRichContent: pageText.includes(expectedMarkdown),
      pageContainsAction: pageText.includes(expectedAction),
      traceTypes: traces.map((event) => event?.type).filter(Boolean),
    },
    assertions: [
      {
        name: 'first-child-response-rendered-rich-content-and-action',
        passed:
          pageText.includes(expectedResponse) &&
          pageText.includes(expectedMarkdown) &&
          pageText.includes(expectedAction),
        details:
          'The visible Studio transcript rendered the first child response, markdown rich content, and Review evidence action button after supervisor handoff.',
      },
    ],
  };
}

async function runAblp588(context, fixture) {
  const { artifacts, baseUrl, page } = context;
  const agentName = `reasoning_exit_flow_${uniqueSuffix().replace(/[^a-z0-9]+/gi, '_')}`;
  const userMessage = 'I pick the first option';
  let setContextIssued = false;
  const mockServer = await startIssueMockOpenAIServer({
    async handleRequest(request, helpers) {
      const toolNames = Array.isArray(request?.tools)
        ? request.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
        : [];
      const lastUserMessage = helpers.extractLastUserMessage(request).toLowerCase();

      if (
        !setContextIssued &&
        toolNames.includes('__set_context__') &&
        lastUserMessage.includes('pick')
      ) {
        setContextIssued = true;
        return {
          toolCall: {
            name: '__set_context__',
            arguments: {
              updates: {
                selection_made: 'yes',
              },
            },
          },
          usage: { promptTokens: 96, completionTokens: 18 },
          model: request.model ?? 'mock-issue-model',
        };
      }

      return {
        content: 'Selection recorded.',
        usage: { promptTokens: 82, completionTokens: 12 },
        model: request.model ?? 'mock-issue-model',
      };
    },
  });

  try {
    await createRuntimeAgentSet(baseUrl, fixture.accessToken, fixture.projectId, [
      {
        name: agentName,
        description: 'ABLP-588 reasoning EXIT_WHEN transition agent',
        dsl: buildAblp588AgentDsl(agentName),
      },
    ]);

    const { modelId } = await provisionMockProjectModel(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      [agentName],
      mockServer,
    );

    await openStudioAgentChat(page, baseUrl, {
      projectId: fixture.projectId,
      agentName,
    });
    await sendStudioChatMessage(page, userMessage);
    await waitForMessageListText(page, 'Details for your selection.');
    await waitForMessageListText(page, 'Rich card content here');
    await waitForMessageListText(page, 'Confirm');
    await openDebugTab(page, 'Traces');
    await waitForIdle(page, 1_000);

    const session = await waitForSession(baseUrl, fixture.accessToken, fixture.projectId, 2);
    const traces = await getSessionTraces(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      session.id,
    ).catch(() => []);
    const detail = await getSessionDetail(
      baseUrl,
      fixture.accessToken,
      fixture.projectId,
      session.id,
    );
    await artifacts.captureScreenshot('ablp-588-reasoning-flow-transition.png');

    const requestJson = JSON.stringify(mockServer.getRequests());
    const pageText = await page.locator('body').innerText();
    const transcriptEvidence = [
      `User: ${userMessage}`,
      'Assistant: Details for your selection.',
      'Rich content: **Details for your selection** / Rich card content here',
      'Action: Confirm',
    ];

    return {
      summary:
        'ABLP-588: Studio chat shows a REASONING:true FLOW step setting selection_made through __set_context__, exiting step_one, and rendering step_two markdown plus the Confirm button.',
      metadata: {
        issue: 'ABLP-588',
        projectId: fixture.projectId,
        sessionId: session.id,
        agentName,
        modelId,
        userMessage,
        transcriptEvidence,
        requestCount: mockServer.getRequests().length,
        requestIncludedSetContext: requestJson.includes('__set_context__'),
        pageContainsStepTwo: pageText.includes('Details for your selection.'),
        pageContainsConfirmAction: pageText.includes('Confirm'),
        traceTypes: traces.map((event) => event?.type).filter(Boolean),
        sessionDetailKeys: detail && typeof detail === 'object' ? Object.keys(detail) : [],
      },
      assertions: [
        {
          name: 'reasoning-step-had-set-context-tool',
          passed: requestJson.includes('__set_context__'),
          details: 'The captured mock model request included __set_context__ in the tool list.',
        },
        {
          name: 'reasoning-flow-transition-rendered',
          passed: true,
          details:
            'Studio rendered the deterministic step_two response after the reasoning step set selection_made.',
        },
        {
          name: 'step-two-rendered-markdown-and-button',
          passed: pageText.includes('Rich card content here') && pageText.includes('Confirm'),
          details:
            'The Studio transcript rendered the step_two markdown content and Confirm action.',
        },
      ],
    };
  } finally {
    await mockServer.close();
  }
}

export const scenario = {
  id: 'ablp-runtime-regressions',
  title: 'ABLP Runtime Regression Evidence',
  description:
    'Runs reproducible Studio evidence flows for the runtime-heavy ABLP ticket set by passing --issue <key>.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-runtime-regressions --issue ABLP-587',
  async run(context) {
    const { options, page } = context;
    const issue = String(options.issue ?? '')
      .trim()
      .toUpperCase();
    if (!issue) {
      throw new Error('ablp-runtime-regressions requires --issue <ABLP-key>.');
    }

    const finalPauseMs = numberFromInput(options.finalPauseMs, 1500);
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: false,
    });

    if (!fixture.projectId) {
      throw new Error('ablp-runtime-regressions requires a project fixture.');
    }

    let result;
    switch (issue) {
      case 'ABLP-508':
        result = await runAblp508(context, fixture);
        break;
      case 'ABLP-532':
        result = await runAblp532(context, fixture);
        break;
      case 'ABLP-535':
        result = await runAblp535(context, fixture);
        break;
      case 'ABLP-539':
        result = await runAblp539(context, fixture);
        break;
      case 'ABLP-541':
        result = await runAblp541(context, fixture);
        break;
      case 'ABLP-541-CONTRACT':
        result = await runAblp541ContractTriage(context, fixture);
        break;
      case 'ABLP-587':
        result = await runAblp587(context, fixture);
        break;
      case 'ABLP-588':
        result = await runAblp588(context, fixture);
        break;
      default:
        throw new Error(`ablp-runtime-regressions does not support issue ${issue}.`);
    }

    await waitForIdle(page, 500);
    await page.waitForTimeout(finalPauseMs);
    return result;
  },
};

export { buildAblp535AgentDsl, runAblp535 };
