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
const LOAN_REQUEST = 'i want to apply for a loan';

const BANKING_SUPERVISOR_DSL = `
SUPERVISOR: BankingSupervisor

GOAL: "Route banking application requests to the correct specialist"

PERSONA: "A banking routing supervisor"

EXECUTION:
  pipeline:
    enabled: false

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  loan_application: "Apply for a personal loan, mortgage, or other loan product"
  apply_credit_card: "Apply for a credit card"

HANDOFF:
  - TO: Loan_Application_Agent
    WHEN: intent.category == "loan_application"
    RETURN: true

  - TO: Credit_Card_Application_Agent
    WHEN: intent.category == "apply_credit_card"
    RETURN: true
`;

const LOAN_AGENT_DSL = `
AGENT: Loan_Application_Agent

GOAL: "Collect loan application details"

FLOW:
  entry_point: collect_loan_amount
  steps:
    - collect_loan_amount

collect_loan_amount:
  REASONING: false
  GATHER:
    - loan_amount:
        prompt: "What loan amount would you like to apply for?"
        required: true
  THEN: COMPLETE
`;

const CREDIT_CARD_AGENT_DSL = `
AGENT: Credit_Card_Application_Agent

GOAL: "Collect credit card application details"

FLOW:
  entry_point: respond
  steps:
    - respond

respond:
  REASONING: false
  RESPOND: "Credit card application flow started."
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

async function bootstrapAblp549Project(): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail('ablp-549-admin'),
    uniqueSlug('ablp-549-tenant'),
    uniqueSlug('ablp-549-project'),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/banking-supervisor.agent.abl': BANKING_SUPERVISOR_DSL,
    'agents/loan-application.agent.abl': LOAN_AGENT_DSL,
    'agents/credit-card-application.agent.abl': CREDIT_CARD_AGENT_DSL,
  });

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'ABLP-549 Mock Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'ablp-549-mock-model',
    endpointUrl: mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: 'ablp-549-mock-model',
      apiKey: 'test-api-key',
    },
  });

  await setSuperAdmins([admin.userId]);
  return admin;
}

describe.sequential('ABLP-549 supervisor lexical conflict acceptance E2E', () => {
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
    'does not let the shared word "apply" reroute a loan handoff into the credit-card child',
    async () => {
      const admin = await bootstrapAblp549Project();

      mockLlm.registerToolCall(LOAN_REQUEST, {
        name: 'handoff_to_Loan_Application_Agent',
        arguments: {
          reason: 'The user wants to apply for a loan.',
          message: LOAN_REQUEST,
        },
        followUpContent: 'Routing you to the loan application specialist.',
      });

      const firstTurn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'BankingSupervisor',
          message: LOAN_REQUEST,
        },
      });

      expect(firstTurn.status).toBe(200);
      expect(firstTurn.body.sessionId).toBeTruthy();
      expect(firstTurn.body.response).toContain('What loan amount would you like to apply for?');
      expect(firstTurn.body.response).not.toContain('Credit card application flow started.');
      expect(firstTurn.body.action).toMatchObject({
        type: 'handoff',
        target: 'Loan_Application_Agent',
      });
      expect(firstTurn.body.state).toMatchObject({
        gatherProgress: {},
      });
      expect(firstTurn.body.traceEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'digression',
            data: expect.objectContaining({
              target: 'Credit_Card_Application_Agent',
            }),
          }),
          expect.objectContaining({
            type: 'return_to_parent',
            data: expect.objectContaining({
              from: 'Loan_Application_Agent',
              to: 'BankingSupervisor',
            }),
          }),
        ]),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
