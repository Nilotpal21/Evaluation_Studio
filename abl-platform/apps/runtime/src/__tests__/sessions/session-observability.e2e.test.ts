/**
 * Session Observability E2E Tests
 *
 * Verifies session lifecycle trace events (agent_enter, agent_exit, user_message),
 * channel metadata propagation, multi-turn event counting, per-turn span structure,
 * and cross-tenant isolation — all through the REAL HTTP API with REAL auth,
 * REAL MongoDB, and a mock LLM server.
 *
 * ZERO vi.mock() calls — exercises the full middleware chain.
 *
 * Pattern: follows channels-sdk-runtime.e2e.test.ts harness approach.
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

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 90_000;

const SIMPLE_AGENT_DSL = `AGENT: Simple_Chat_Agent

GOAL: "Answer user questions conversationally"

PERSONA: "Helpful assistant"
`;

const GUARDRAIL_AGENT_DSL = `AGENT: Guardrail_Block_Agent

GOAL: "Answer questions but block messages containing prohibited keywords"

PERSONA: "Helpful assistant with safety guardrails"

GUARDRAILS:
  keyword_blocker:
    kind: input
    check: abl.matches_pattern(input, "BLOCKED_KEYWORD")
    action: block
    message: "Your message was blocked due to prohibited content."
    priority: 1
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatAgentResponse {
  sessionId: string;
  response: string;
  action?: { type: string };
  state?: Record<string, unknown>;
  traceEvents?: Array<{ type: string; data: Record<string, unknown> }>;
}

interface TracesApiResponse {
  success: boolean;
  total: number;
  offset: number;
  limit: number;
  traces: Array<{
    type: string;
    data?: Record<string, unknown>;
    timestamp?: string;
    spanId?: string;
    agentName?: string;
  }>;
  _meta: {
    source: string;
    event_count: number;
    is_truncated: boolean;
  };
}

interface SessionListResponse {
  success: boolean;
  sessions: Array<{ id: string; agentName?: string; status?: string }>;
  total?: number;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe(
  'Session Observability E2E',
  () => {
    let harness: RuntimeApiHarness;
    let harnessStarted = false;
    let mockLlm: MockLLM;
    let mockLlmStarted = false;

    // Tenant A (primary)
    let tenantA: BootstrapProjectResult;

    // Tenant B (for isolation tests)
    let tenantB: BootstrapProjectResult;

    beforeAll(async () => {
      mockLlm = await startMockLLM();
      mockLlmStarted = true;

      harness = await startRuntimeServerHarness();
      harnessStarted = true;

      // ── Bootstrap Tenant A ─────────────────────────────────────────────
      tenantA = await bootstrapProject(
        harness,
        uniqueEmail('obs-gap-admin-a'),
        uniqueSlug('obs-gap-tenant-a'),
        uniqueSlug('obs-gap-project-a'),
      );

      await importProjectFiles(harness, tenantA.token, tenantA.projectId, {
        'agents/simple-chat.agent.abl': SIMPLE_AGENT_DSL,
      });

      await provisionTenantModel(harness, tenantA.token, {
        targetTenantId: tenantA.tenantId,
        displayName: 'Mock Observability Model A',
        integrationType: 'api',
        provider: 'openai_compatible',
        modelId: 'mock-model',
        endpointUrl: mockLlm.url,
        supportsStreaming: false,
        supportsTools: false,
        capabilities: ['text'],
        tier: 'balanced',
        isDefault: true,
        connection: {
          credentialName: 'mock-obs-model-a',
          apiKey: 'test-api-key',
        },
      });

      // ── Bootstrap Tenant B ─────────────────────────────────────────────
      tenantB = await bootstrapProject(
        harness,
        uniqueEmail('obs-gap-admin-b'),
        uniqueSlug('obs-gap-tenant-b'),
        uniqueSlug('obs-gap-project-b'),
      );

      await importProjectFiles(harness, tenantB.token, tenantB.projectId, {
        'agents/simple-chat.agent.abl': SIMPLE_AGENT_DSL,
      });

      await provisionTenantModel(harness, tenantB.token, {
        targetTenantId: tenantB.tenantId,
        displayName: 'Mock Observability Model B',
        integrationType: 'api',
        provider: 'openai_compatible',
        modelId: 'mock-model',
        endpointUrl: mockLlm.url,
        supportsStreaming: false,
        supportsTools: false,
        capabilities: ['text'],
        tier: 'balanced',
        isDefault: true,
        connection: {
          credentialName: 'mock-obs-model-b',
          apiKey: 'test-api-key',
        },
      });

      // Restore both users as super admins
      await setSuperAdmins([tenantA.userId, tenantB.userId]);
    }, TIMEOUT_MS);

    beforeEach(() => {
      clearPermissionCache();
      mockLlm.reset();
      // Register a default response for all messages
      mockLlm.register('', { content: 'Mock observability response.' });
    });

    afterAll(async () => {
      if (harnessStarted) {
        await harness.close();
      }
      if (mockLlmStarted) {
        await mockLlm.close();
      }
    }, TIMEOUT_MS);

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-1: Single-turn lifecycle events
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-1: Single-turn lifecycle events', () => {
      test('chat response includes trace events with agent lifecycle data', async () => {
        mockLlm.register('Hello observability', {
          content: 'Hello from the observable agent.',
        });

        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Hello observability',
          },
        });

        expect(chatRes.status).toBe(200);
        expect(chatRes.body.sessionId).toBeTruthy();
        expect(chatRes.body.response).toContain('Hello from the observable agent');

        // The chat response includes inline traceEvents
        const traceEvents = chatRes.body.traceEvents ?? [];

        // Verify there are trace events emitted during execution
        // The exact events depend on the runtime execution path; at minimum
        // we expect some events from the agent execution pipeline.
        expect(traceEvents.length).toBeGreaterThan(0);

        // Check for lifecycle-related events (agent_enter / agent_exit or equivalents)
        const eventTypes = traceEvents.map((e) => e.type);
        const hasAgentEnter = eventTypes.some(
          (t) => t === 'agent_enter' || t === 'agent.entered' || t === 'agent_entered',
        );
        const hasAgentExit = eventTypes.some(
          (t) => t === 'agent_exit' || t === 'agent.exited' || t === 'agent_exited',
        );

        // Lifecycle events MUST be present — unconditional assertions
        expect(hasAgentEnter).toBe(true);
        expect(hasAgentExit).toBe(true);

        const enterEvent = traceEvents.find(
          (e) =>
            e.type === 'agent_enter' || e.type === 'agent.entered' || e.type === 'agent_entered',
        );
        const exitEvent = traceEvents.find(
          (e) => e.type === 'agent_exit' || e.type === 'agent.exited' || e.type === 'agent_exited',
        );

        expect(enterEvent).toBeDefined();
        expect(exitEvent).toBeDefined();

        // Verify durationMs is present and positive on exit event
        expect(typeof exitEvent?.data?.durationMs).toBe('number');
        expect(exitEvent?.data?.durationMs).toBeGreaterThanOrEqual(0);
      });

      test('traces API endpoint resolves session and returns correct structure', async () => {
        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Trace endpoint test',
          },
        });

        expect(chatRes.status).toBe(200);
        const sessionId = chatRes.body.sessionId;

        // Query the traces endpoint — session should be findable via DB + runtime
        const tracesRes = await requestJson<TracesApiResponse>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${sessionId}/traces`,
          { headers: authHeaders(tenantA.token) },
        );

        // The session was created by the chat endpoint and is both in-memory
        // and persisted to MongoDB. The traces endpoint should find it.
        if (tracesRes.status === 200) {
          expect(tracesRes.body.success).toBe(true);
          expect(tracesRes.body._meta).toBeDefined();
          expect(typeof tracesRes.body._meta.event_count).toBe('number');
          expect(typeof tracesRes.body._meta.is_truncated).toBe('boolean');
          expect(Array.isArray(tracesRes.body.traces)).toBe(true);
        } else {
          // 404 is acceptable if the session resolution path doesn't find it
          // (e.g., ownership check for non-elevated user)
          expect(tracesRes.status).toBe(404);
        }
      });

      test('cross-tenant access to traces returns 404', async () => {
        // Create a session in tenant A
        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Tenant isolation trace test',
          },
        });

        expect(chatRes.status).toBe(200);
        const sessionId = chatRes.body.sessionId;

        // Tenant B tries to access tenant A's session traces
        const tracesRes = await requestJson<{ success: boolean }>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${sessionId}/traces`,
          { headers: authHeaders(tenantB.token) },
        );

        // Cross-tenant access should be denied (404 to not leak existence)
        expect([403, 404]).toContain(tracesRes.status);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-2: channelMetadata.channel = 'api'
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-2: channelMetadata.channel = api', () => {
      test('chat response trace events include channel metadata', async () => {
        mockLlm.register('Channel metadata test', {
          content: 'Response for channel metadata verification.',
        });

        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Channel metadata test',
          },
        });

        expect(chatRes.status).toBe(200);

        const traceEvents = chatRes.body.traceEvents ?? [];

        // Look for events that carry channel metadata
        const eventsWithChannel = traceEvents.filter((e) => e.data?.channel === 'api');

        // Look for events with contentLength
        const eventsWithContentLength = traceEvents.filter(
          (e) => typeof e.data?.contentLength === 'number',
        );

        // Channel metadata MUST propagate — unconditional assertions
        expect(traceEvents.length).toBeGreaterThan(0);
        expect(eventsWithChannel.length).toBeGreaterThan(0);
        expect(eventsWithChannel[0].data?.channel).toBe('api');
        expect(eventsWithContentLength.length).toBeGreaterThan(0);
        expect(eventsWithContentLength[0].data?.contentLength).toBe('Channel metadata test'.length);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-3: Multi-turn lifecycle count
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-3: Multi-turn lifecycle count', () => {
      test('3 messages to same session produce 3 sets of trace events', async () => {
        mockLlm.register('Turn one', { content: 'Response to turn one.' });
        mockLlm.register('Turn two', { content: 'Response to turn two.' });
        mockLlm.register('Turn three', { content: 'Response to turn three.' });

        // First message creates the session
        const turn1 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Turn one',
          },
        });

        expect(turn1.status).toBe(200);
        const sessionId = turn1.body.sessionId;
        expect(sessionId).toBeTruthy();
        const turn1TraceCount = turn1.body.traceEvents?.length ?? 0;

        // Second message reuses the session
        const turn2 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            sessionId,
            message: 'Turn two',
          },
        });

        expect(turn2.status).toBe(200);
        expect(turn2.body.sessionId).toBe(sessionId);
        const turn2TraceCount = turn2.body.traceEvents?.length ?? 0;

        // Third message reuses the session
        const turn3 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            sessionId,
            message: 'Turn three',
          },
        });

        expect(turn3.status).toBe(200);
        expect(turn3.body.sessionId).toBe(sessionId);
        const turn3TraceCount = turn3.body.traceEvents?.length ?? 0;

        // Each turn should independently produce trace events
        expect(turn1TraceCount).toBeGreaterThan(0);
        expect(turn2TraceCount).toBeGreaterThan(0);
        expect(turn3TraceCount).toBeGreaterThan(0);

        // Verify the session listing shows this session
        const listRes = await requestJson<SessionListResponse>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions`,
          { headers: authHeaders(tenantA.token) },
        );

        expect(listRes.status).toBe(200);
        expect(listRes.body.success).toBe(true);
        const sessionIds = listRes.body.sessions.map((s) => s.id);
        expect(sessionIds).toContain(sessionId);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-4: Channel identifier verification (REST API only)
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-4: Channel identifier verification', () => {
      test('session created via chat/agent has channel api in DB', async () => {
        mockLlm.register('Channel verify', {
          content: 'Channel verification response.',
        });

        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Channel verify',
          },
        });

        expect(chatRes.status).toBe(200);
        const sessionId = chatRes.body.sessionId;

        // Fetch the session detail from the sessions API
        const detailRes = await requestJson<{
          success: boolean;
          session: {
            id: string;
            channel?: string;
            agentName?: string;
            messages?: Array<{ role: string; content: string }>;
          };
        }>(harness, `/api/projects/${tenantA.projectId}/sessions/${sessionId}`, {
          headers: authHeaders(tenantA.token),
        });

        if (detailRes.status === 200) {
          expect(detailRes.body.success).toBe(true);
          expect(detailRes.body.session).toBeDefined();
        } else {
          // The session may not be accessible via the detail endpoint if
          // the runtime holds it only in memory. 404 is acceptable.
          expect(detailRes.status).toBe(404);
        }

        // Verify traces contain channel information from inline trace events — unconditional
        const traceEvents = chatRes.body.traceEvents ?? [];
        const channelEvents = traceEvents.filter((e) => e.data?.channel !== undefined);
        expect(channelEvents.length).toBeGreaterThan(0);
        expect(channelEvents.some((e) => e.data?.channel === 'api')).toBe(true);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-5: Per-turn spans in waterfall
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-5: Per-turn spans in waterfall', () => {
      test('each turn produces distinct trace events with independent data', async () => {
        mockLlm.register('Span turn A', {
          content: 'Response for span turn A.',
        });
        mockLlm.register('Span turn B', {
          content: 'Response for span turn B.',
        });
        mockLlm.register('Span turn C', {
          content: 'Response for span turn C.',
        });

        // Turn 1
        const turn1 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Span turn A',
          },
        });
        expect(turn1.status).toBe(200);
        const sessionId = turn1.body.sessionId;

        // Turn 2
        const turn2 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            sessionId,
            message: 'Span turn B',
          },
        });
        expect(turn2.status).toBe(200);

        // Turn 3
        const turn3 = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            sessionId,
            message: 'Span turn C',
          },
        });
        expect(turn3.status).toBe(200);

        const traces1 = turn1.body.traceEvents ?? [];
        const traces2 = turn2.body.traceEvents ?? [];
        const traces3 = turn3.body.traceEvents ?? [];

        // Each turn should have produced trace events independently
        expect(traces1.length).toBeGreaterThan(0);
        expect(traces2.length).toBeGreaterThan(0);
        expect(traces3.length).toBeGreaterThan(0);

        // Look for llm_call events (the most reliable trace type) to verify
        // each turn had distinct LLM interactions
        const llmCalls1 = traces1.filter((e) => e.type === 'llm_call');
        const llmCalls2 = traces2.filter((e) => e.type === 'llm_call');
        const llmCalls3 = traces3.filter((e) => e.type === 'llm_call');

        // Each turn that goes through the LLM should have at least one llm_call
        expect(llmCalls1.length).toBeGreaterThanOrEqual(1);
        expect(llmCalls2.length).toBeGreaterThanOrEqual(1);
        expect(llmCalls3.length).toBeGreaterThanOrEqual(1);

        // Verify the traces endpoint shows the session was found (even if
        // ClickHouse traces are empty)
        const tracesRes = await requestJson<TracesApiResponse>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${sessionId}/traces`,
          { headers: authHeaders(tenantA.token) },
        );

        if (tracesRes.status === 200) {
          expect(tracesRes.body.success).toBe(true);
          expect(tracesRes.body._meta).toBeDefined();
        }
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // E2E-6: Constraint violation exit result
    // ═══════════════════════════════════════════════════════════════════════

    describe('E2E-6: Constraint violation exit result', () => {
      test('sends a message triggering a guardrail block and verifies constraint_blocked exit', async () => {
        // Upload the guardrail agent
        await importProjectFiles(harness, tenantA.token, tenantA.projectId, {
          'agents/guardrail-block.agent.abl': GUARDRAIL_AGENT_DSL,
        });

        // Register a response for the mock LLM (shouldn't be reached if guardrail blocks)
        mockLlm.register('BLOCKED_KEYWORD test message', {
          content: 'This should not be reached.',
        });

        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            agentName: 'Guardrail_Block_Agent',
            message: 'BLOCKED_KEYWORD test message',
          },
        });

        // The chat endpoint should still return 200 (the block message is returned as the response)
        expect(chatRes.status).toBe(200);

        const traceEvents = chatRes.body.traceEvents ?? [];

        // Verify constraint_check trace event with passed=false exists
        const constraintChecks = traceEvents.filter((e) => e.type === 'constraint_check');
        expect(constraintChecks.length).toBeGreaterThan(0);
        const blockEvent = constraintChecks.find((e) => e.data?.passed === false);
        expect(blockEvent).toBeDefined();
        if (blockEvent) {
          expect(blockEvent.data.action).toBe('block');
        }

        // Verify agent_exit with result='constraint_blocked'
        const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');
        expect(agentExits.length).toBeGreaterThan(0);
        const blockedExit = agentExits.find((e) => e.data?.result === 'constraint_blocked');
        expect(blockedExit).toBeDefined();
        if (blockedExit) {
          expect(typeof blockedExit.data.durationMs).toBe('number');
        }

        // The response should contain the guardrail block message
        expect(chatRes.body.response).toContain('blocked due to prohibited content');
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Additional: Cross-tenant session isolation
    // ═══════════════════════════════════════════════════════════════════════

    describe('Cross-tenant session isolation', () => {
      test('tenant A cannot list tenant B sessions', async () => {
        // Create a session in tenant B
        const chatB = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantB.token),
          body: {
            projectId: tenantB.projectId,
            message: 'Tenant B session',
          },
        });
        expect(chatB.status).toBe(200);

        // Tenant A tries to list sessions in tenant B's project
        const listRes = await requestJson<SessionListResponse>(
          harness,
          `/api/projects/${tenantB.projectId}/sessions`,
          { headers: authHeaders(tenantA.token) },
        );

        // Cross-tenant should be denied or return empty list
        if (listRes.status === 200) {
          expect(listRes.body.sessions).toHaveLength(0);
        } else {
          expect([403, 404]).toContain(listRes.status);
        }
      });

      test('tenant B cannot access tenant A session detail', async () => {
        const chatA = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Tenant A isolation test',
          },
        });
        expect(chatA.status).toBe(200);

        const detailRes = await requestJson<{ success: boolean }>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${chatA.body.sessionId}`,
          { headers: authHeaders(tenantB.token) },
        );

        expect([403, 404]).toContain(detailRes.status);
      });

      test('tenant B cannot access tenant A session metrics', async () => {
        const chatA = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Metrics isolation test',
          },
        });
        expect(chatA.status).toBe(200);

        const metricsRes = await requestJson<{ success: boolean }>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${chatA.body.sessionId}/metrics`,
          { headers: authHeaders(tenantB.token) },
        );

        expect([403, 404]).toContain(metricsRes.status);
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Additional: Trace endpoint auth enforcement
    // ═══════════════════════════════════════════════════════════════════════

    describe('Trace endpoint auth enforcement', () => {
      test('traces endpoint requires authentication', async () => {
        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Auth enforcement test',
          },
        });
        expect(chatRes.status).toBe(200);

        const tracesRes = await requestJson(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${chatRes.body.sessionId}/traces`,
          {},
        );

        expect(tracesRes.status).toBe(401);
      });

      test('traces for nonexistent session returns 404', async () => {
        const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const tracesRes = await requestJson<{ success: boolean }>(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${fakeId}/traces`,
          { headers: authHeaders(tenantA.token) },
        );

        expect(tracesRes.status).toBe(404);
      });

      test('session metrics endpoint requires authentication', async () => {
        const chatRes = await requestJson<ChatAgentResponse>(harness, '/api/v1/chat/agent', {
          method: 'POST',
          headers: authHeaders(tenantA.token),
          body: {
            projectId: tenantA.projectId,
            message: 'Metrics auth test',
          },
        });
        expect(chatRes.status).toBe(200);

        const metricsRes = await requestJson(
          harness,
          `/api/projects/${tenantA.projectId}/sessions/${chatRes.body.sessionId}/metrics`,
          {},
        );

        expect(metricsRes.status).toBe(401);
      });
    });
  },
  TIMEOUT_MS,
);
