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

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 45_000;

const FIRST_MESSAGE = 'i need help with my card payment';
const SECOND_MESSAGE = 'search the database for invoice 42';

const FOLLOWUP_SUPERVISOR_DSL = `
SUPERVISOR: FollowupSupervisor

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
  - TO: CardOpsChild
    WHEN: intent.category == "card_help"
    RETURN: true

  - TO: DatabaseSearchChild
    WHEN: intent.category == "database_search"
    RETURN: true
`;

const CARD_GATHER_CHILD_DSL = `
AGENT: CardOpsChild

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

const DATABASE_SEARCH_CHILD_DSL = `
AGENT: DatabaseSearchChild

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

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ChatAgentResponse {
  sessionId: string;
  response: string;
  action?: {
    type?: string;
    target?: string;
  };
  state?: Record<string, unknown>;
  traceEvents?: TraceEvent[];
}

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;

async function bootstrapAblp541Project(): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail('ablp-541-admin'),
    uniqueSlug('ablp-541-tenant'),
    uniqueSlug('ablp-541-project'),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/followup-supervisor.agent.abl': FOLLOWUP_SUPERVISOR_DSL,
    'agents/card-ops-child.agent.abl': CARD_GATHER_CHILD_DSL,
    'agents/database-search-child.agent.abl': DATABASE_SEARCH_CHILD_DSL,
  });

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'ABLP-541 Mock Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'ablp-541-mock-model',
    endpointUrl: mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: 'ablp-541-mock-model',
      apiKey: 'test-api-key',
    },
  });

  await setSuperAdmins([admin.userId]);
  return admin;
}

describe.sequential('ABLP-541 parent reroute before gather acceptance E2E', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({
      ALLOW_INMEMORY_ASYNC_INFRA: 'true',
    });
    mockLlm = await startMockLLM();
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'reroutes the second turn through the supervisor before the RETURN:true gather child can accept card_last4',
    async () => {
      const admin = await bootstrapAblp541Project();

      mockLlm.registerToolCall(FIRST_MESSAGE, {
        name: 'handoff_to_CardOpsChild',
        arguments: {
          reason: 'Card operations should collect the last four digits first.',
          message: FIRST_MESSAGE,
        },
        followUpContent: 'Let me collect the last four digits first.',
      });
      mockLlm.registerToolCall(SECOND_MESSAGE, {
        name: '_extract_entities',
        arguments: {
          card_last4: SECOND_MESSAGE,
        },
        followUpContent: '{}',
      });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'FollowupSupervisor',
          message: FIRST_MESSAGE,
        },
      });

      expect(firstTurn.status).toBe(200);
      expect(firstTurn.body.sessionId).toBeTruthy();
      expect(firstTurn.body.response).toContain('What are the last four digits of the card?');

      const secondTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          sessionId: firstTurn.body.sessionId,
          message: SECOND_MESSAGE,
        },
      });

      expect(secondTurn.status).toBe(200);
      expect(secondTurn.body.sessionId).toBe(firstTurn.body.sessionId);
      expect(secondTurn.body.response).toContain('DatabaseSearchAgent looked up invoice 42.');
      expect(secondTurn.body.action).toMatchObject({
        type: 'handoff',
        target: 'DatabaseSearchChild',
      });
      expect(secondTurn.body.state ?? {}).toEqual({});
      expect(secondTurn.body.traceEvents?.some((event) => event.type === 'dsl_collect')).toBe(
        false,
      );
      expect(secondTurn.body.traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'digression',
            data: expect.objectContaining({
              intent: 'database_search',
              detectionMode: 'lexical',
              target: 'DatabaseSearchChild',
            }),
          }),
          expect.objectContaining({
            type: 'return_to_parent',
            data: expect.objectContaining({
              from: 'CardOpsChild',
              to: 'FollowupSupervisor',
              forwardedMessage: SECOND_MESSAGE,
            }),
          }),
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
