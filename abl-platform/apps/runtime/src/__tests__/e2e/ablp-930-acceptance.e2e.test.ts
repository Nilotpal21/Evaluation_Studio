/**
 * SPIKE 2 — ABLP-930 acceptance E2E (Tier 3).
 *
 * Wire-level coverage. Three classes of tests:
 *   - Thin transport/middleware tests (auth 401, validation 400, cross-project
 *     404, cross-tenant 404) — fast, one-purpose each.
 *   - Full handoff happy path tests for each routing variant the old E2E
 *     covered: tool_call routing, plain-text-forwarded handoff, repair-retry.
 *     These assert at the WIRE: target, response text, action shape, thread
 *     state, trace integrity. They preserve boundary coverage that the old
 *     582-line E2E packed.
 *
 * Companion tiers:
 *   - Tier 1 (router decision invariants): scenarios in
 *     apps/runtime/src/__tests__/spike-deterministic-dsl/
 *   - Tier 2 (production runtime → router wiring): integration test in
 *     apps/runtime/src/__tests__/execution/ablp-930-supervisor-tool-call-routing.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
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
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 45_000;
const LEAVE_REQUEST = 'I want to apply for leave and not check leave balance';
const PLAIN_TEXT_LEAVE_REQUEST = 'I need to apply for vacation leave';
const PLAIN_TEXT_SUPERVISOR_REPLY_REQUEST =
  'Please apply for leave first and ignore leave balance for now';

const LEAVE_SUPERVISOR_DSL = `
SUPERVISOR: LeaveSupervisor

GOAL: "Route leave requests to the correct leave specialist"

PERSONA: "A leave routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: when_unavailable
  leave_application: "Apply for leave, request time off, or submit a leave application"
  leave_balance: "Check available leave balance or remaining paid time off"

HANDOFF:
  - TO: LeaveApplicationChild
    WHEN: intent.category == "leave_application"
    RETURN: true

  - TO: LeaveBalanceChild
    WHEN: intent.category == "leave_balance"
    RETURN: true
`;

const LEAVE_APPLICATION_CHILD_DSL = `
AGENT: LeaveApplicationChild

GOAL: "Collect leave application details"

FLOW:
  entry_point: collect_reason
  steps:
    - collect_reason

collect_reason:
  REASONING: false
  GATHER:
    - leave_reason:
        prompt: "What is the reason for the leave application?"
        required: true
  THEN: COMPLETE
`;

const LEAVE_BALANCE_CHILD_DSL = `
AGENT: LeaveBalanceChild

GOAL: "Answer leave balance questions"

FLOW:
  entry_point: respond_balance
  steps:
    - respond_balance

respond_balance:
  REASONING: false
  RESPOND: "LeaveBalanceChild checked the user's leave balance."
  THEN: COMPLETE
`;

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ChatAgentResponse {
  sessionId?: string;
  response?: string;
  action?: { type?: string; target?: string };
  traceEvents?: TraceEvent[];
  error?: unknown;
}

interface SessionDetailResponse {
  success: boolean;
  session?: {
    id: string;
    agentName: string;
    activeThreadIndex?: number;
    threads?: Array<{ agentName?: string; status?: string }>;
  };
  error?: unknown;
}

interface ResponseArtifact {
  status: number;
  body: unknown;
}

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;

async function provisionProject() {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail('ablp-930-acceptance-admin'),
    uniqueSlug('ablp-930-acceptance-tenant'),
    uniqueSlug('ablp-930-acceptance-project'),
  );
  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/leave-supervisor.agent.abl': LEAVE_SUPERVISOR_DSL,
    'agents/leave-application-child.agent.abl': LEAVE_APPLICATION_CHILD_DSL,
    'agents/leave-balance-child.agent.abl': LEAVE_BALANCE_CHILD_DSL,
  });
  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: 'ABLP-930 Acceptance Mock Model',
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: 'ablp-930-acceptance-mock-model',
    endpointUrl: mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: { credentialName: 'ablp-930-acceptance-mock-model', apiKey: 'test-api-key' },
  });
  await setSuperAdmins([admin.userId]);
  return admin;
}

/**
 * Boundary-coverage assertion shared across full-flow happy-path tests.
 * Mirrors the old E2E's `assertLeaveApplicationHandoff` so wire-level coverage
 * is preserved during the conversion.
 */
function assertLeaveApplicationHandoffAtWire(
  turn: ResponseArtifact,
): asserts turn is ResponseArtifact & { body: ChatAgentResponse & { sessionId: string } } {
  const body = turn.body as ChatAgentResponse;
  expect(turn.status, JSON.stringify(body)).toBe(200);
  expect(body.sessionId).toBeTruthy();
  // Child agent's gather prompt MUST appear; the sibling's RESPOND text MUST NOT.
  expect(body.response).toContain('What is the reason for the leave application?');
  expect(body.response).not.toContain("LeaveBalanceChild checked the user's leave balance.");
  // Action shape: handoff to LeaveApplicationChild specifically (not just type).
  expect(body.action).toMatchObject({ type: 'handoff', target: 'LeaveApplicationChild' });
  // Trace integrity: handoff to the right child, no handoff to the sibling, no
  // return_to_parent (lexical escape was suppressed).
  expect(body.traceEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'handoff',
        data: expect.objectContaining({ to: 'LeaveApplicationChild' }),
      }),
    ]),
  );
  expect(body.traceEvents).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'handoff',
        data: expect.objectContaining({ to: 'LeaveBalanceChild' }),
      }),
    ]),
  );
  expect(body.traceEvents).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'return_to_parent',
        data: expect.objectContaining({
          from: 'LeaveApplicationChild',
          to: 'LeaveSupervisor',
        }),
      }),
    ]),
  );
}

async function assertSessionThreadStateAtWire(
  admin: { token: string; projectId: string },
  sessionId: string,
): Promise<void> {
  const detail = await requestJson<SessionDetailResponse>(
    harness,
    `/api/projects/${admin.projectId}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'GET', headers: authHeaders(admin.token) },
  );
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  expect(detail.body.success).toBe(true);
  expect(detail.body.session?.activeThreadIndex).toBe(1);
  const threadNames = (detail.body.session?.threads ?? []).map((t) => t.agentName);
  expect(threadNames).toContain('LeaveSupervisor');
  expect(threadNames).toContain('LeaveApplicationChild');
  expect(threadNames).not.toContain('LeaveBalanceChild');
  expect(detail.body.session?.threads?.[1]).toMatchObject({
    agentName: 'LeaveApplicationChild',
    status: 'active',
  });
}

describe.sequential('ABLP-930 acceptance E2E (transport + boundary coverage)', () => {
  beforeAll(async () => {
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
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

  // ─── Thin transport/middleware tests ──────────────────────────────────────

  test(
    'POST /api/v1/chat/agent rejects missing auth with 401',
    async () => {
      const admin = await provisionProject();
      const res = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        body: { projectId: admin.projectId, agentId: 'LeaveSupervisor', message: LEAVE_REQUEST },
      });
      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /api/v1/chat/agent rejects invalid body with 400',
    async () => {
      const admin = await provisionProject();
      const res = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { agentId: 'LeaveSupervisor', message: LEAVE_REQUEST }, // missing projectId
      });
      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET session detail returns 404 for cross-project access (project isolation)',
    async () => {
      const admin = await provisionProject();
      const otherProject = await createProject(
        harness,
        admin.token,
        admin.tenantId,
        'ABLP-930 Other Project',
        uniqueSlug('ablp-930-other-project'),
      );
      mockLlm.registerToolCall(LEAVE_REQUEST, {
        name: 'handoff_to_LeaveApplicationChild',
        arguments: { reason: 'apply', message: 'apply' },
        followUpContent: 'ok',
      });
      const turn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { projectId: admin.projectId, agentId: 'LeaveSupervisor', message: LEAVE_REQUEST },
      });
      expect(turn.status).toBe(200);
      const sessionId = turn.body.sessionId!;

      const res = await requestJson<SessionDetailResponse>(
        harness,
        `/api/projects/${otherProject._id}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'GET', headers: authHeaders(admin.token) },
      );
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET session detail returns 404 for cross-tenant access (tenant isolation)',
    async () => {
      const admin = await provisionProject();
      mockLlm.registerToolCall(LEAVE_REQUEST, {
        name: 'handoff_to_LeaveApplicationChild',
        arguments: { reason: 'apply', message: 'apply' },
        followUpContent: 'ok',
      });
      const turn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { projectId: admin.projectId, agentId: 'LeaveSupervisor', message: LEAVE_REQUEST },
      });
      expect(turn.status).toBe(200);
      const sessionId = turn.body.sessionId!;

      const otherTenant = await bootstrapProject(
        harness,
        uniqueEmail('ablp-930-other-tenant-admin'),
        uniqueSlug('ablp-930-other-tenant'),
        uniqueSlug('ablp-930-other-tenant-project'),
      );
      const res = await requestJson<SessionDetailResponse>(
        harness,
        `/api/projects/${otherTenant.projectId}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'GET', headers: authHeaders(otherTenant.token) },
      );
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  // ─── Full handoff happy paths — preserve old E2E boundary coverage ────────

  test(
    'tool_call handoff: full wire-level boundary coverage (target, response, traces, thread state)',
    async () => {
      const admin = await provisionProject();
      mockLlm.registerToolCall(LEAVE_REQUEST, {
        name: 'handoff_to_LeaveApplicationChild',
        arguments: {
          reason: 'The user wants to apply for leave.',
          message: 'Transfer user to agent LeaveApplicationChild before checking LeaveBalanceChild',
        },
        followUpContent: 'Routing to the leave application specialist.',
      });
      const turn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { projectId: admin.projectId, agentId: 'LeaveSupervisor', message: LEAVE_REQUEST },
      });
      assertLeaveApplicationHandoffAtWire(turn);
      await assertSessionThreadStateAtWire(admin, turn.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'plain-text forwarded handoff: full wire-level boundary coverage',
    async () => {
      // Supervisor's tool call carries the user's plain text as the routing
      // message. Wire path must still route to LeaveApplicationChild without
      // downgrading to LeaveBalanceChild via lexical scan.
      const admin = await provisionProject();
      mockLlm.registerToolCall(PLAIN_TEXT_LEAVE_REQUEST, {
        name: 'handoff_to_LeaveApplicationChild',
        arguments: {
          reason: 'The user wants to apply for leave.',
          message: PLAIN_TEXT_LEAVE_REQUEST,
        },
        followUpContent: 'Routing to the leave application specialist.',
      });
      const turn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'LeaveSupervisor',
          message: PLAIN_TEXT_LEAVE_REQUEST,
        },
      });
      assertLeaveApplicationHandoffAtWire(turn);
      await assertSessionThreadStateAtWire(admin, turn.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'plain-text supervisor repair-retry: trace integrity + final routing at wire',
    async () => {
      // Supervisor first emits a plain-text reply with no tool call. The
      // runtime detects the missing routing decision and triggers a retry
      // ('supervisor_routing_repair'). The retry produces a tool_call which
      // routes to LeaveApplicationChild. Wire-level proof: the repair flow
      // emits the right trace events AND ultimately routes correctly.
      const admin = await provisionProject();
      mockLlm.registerToolCall('Routing correction', {
        name: 'handoff_to_LeaveApplicationChild',
        arguments: {
          reason: 'The user wants to apply for leave.',
          message: 'Transfer user to agent LeaveApplicationChild before checking LeaveBalanceChild',
        },
        followUpContent: 'Routing to the leave application specialist.',
      });
      const turn = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          agentId: 'LeaveSupervisor',
          message: PLAIN_TEXT_SUPERVISOR_REPLY_REQUEST,
        },
      });
      assertLeaveApplicationHandoffAtWire(turn);
      // Repair-retry trace assertions: first LLM call had no tool calls and
      // was suppressed for routing repair; the runtime emitted a repair-retry
      // decision; the next LLM call carried tool calls.
      expect(turn.body.traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'llm_call',
            data: expect.objectContaining({
              hasToolCalls: false,
              responseContribution: 'internal_only',
              responseSuppressedReason: 'supervisor_routing_repair',
            }),
          }),
          expect.objectContaining({
            type: 'decision',
            data: expect.objectContaining({
              decision: 'supervisor_routing_repair_retry',
            }),
          }),
          expect.objectContaining({
            type: 'llm_call',
            data: expect.objectContaining({ hasToolCalls: true, toolCallCount: 1 }),
          }),
        ]),
      );
      await assertSessionThreadStateAtWire(admin, turn.body.sessionId);
    },
    TEST_TIMEOUT_MS,
  );
});
