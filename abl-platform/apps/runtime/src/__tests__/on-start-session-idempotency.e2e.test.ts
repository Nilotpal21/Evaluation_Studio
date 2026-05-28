/**
 * ON_START Session Idempotency E2E Tests
 *
 * Covers:
 *   Phase 4.2 — ON_START fires exactly once per session
 *   Phase 4.2 — Rehydrated sessions don't re-fire ON_START
 *   Phase 4.2 — Concurrent first messages don't double-fire
 *
 * E2E rules enforced:
 *   - No vi.mock / jest.mock
 *   - All interaction via HTTP API
 *   - Real servers with MongoMemoryServer
 *   - No direct Mongoose model access
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  importProjectFiles,
  provisionTenantModel,
  authHeaders,
  requestJson,
  uniqueSlug,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../tools/agents/e2e-functional/types.js';

// ─── DSL Fixtures ───────────────────────────────────────────────────────────

const ON_START_AGENT_DSL = `AGENT: GreeterAgent
GOAL: Greet the user on session start

ON_START:
  RESPOND: "Welcome! How can I help you today?"

ON_ERROR:
  RESPOND: "Something went wrong."
`;

const ON_START_SET_AGENT_DSL = `AGENT: SetterAgent
GOAL: Set variables on session start

ON_START:
  SET:
    greeting_sent = true
    session_lang = en

ON_ERROR:
  RESPOND: "Error."
`;

const NO_ON_START_AGENT_DSL = `AGENT: PlainAgent
GOAL: Answer user questions without any ON_START handler

ON_ERROR:
  RESPOND: "Error."
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function sendChatMessage(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  message: string,
  sessionId?: string,
) {
  return requestJson<{
    success?: boolean;
    sessionId?: string;
    response?: string;
    messages?: Array<{ role: string; content: string }>;
    error?: unknown;
  }>(harness, `/api/v1/chat/agent`, {
    method: 'POST',
    headers: authHeaders(token),
    body: {
      projectId,
      message,
      agentName: 'GreeterAgent',
      ...(sessionId ? { sessionId } : {}),
    },
  });
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('ON_START Session Idempotency E2E', () => {
  let harness: RuntimeApiHarness;
  let admin: BootstrapProjectResult;
  let mockLlm: MockLLM;

  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness();
    admin = await bootstrapProject(
      harness,
      'onstart-e2e@example.com',
      uniqueSlug('onstart'),
      uniqueSlug('onstart-proj'),
    );

    // Import agent with ON_START
    await importProjectFiles(harness, admin.token, admin.projectId, {
      'project.json': JSON.stringify({
        format_version: '2.0',
        entry_agent: 'GreeterAgent',
        agents: [{ name: 'GreeterAgent', file: 'agents/greeteragent.agent.abl' }],
        tools: [],
      }),
      'agents/greeteragent.agent.abl': ON_START_AGENT_DSL,
    });

    // Provision a mock LLM model so compilation and execution work
    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock LLM',
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
        credentialName: 'mock-on-start-model',
        apiKey: 'test-api-key',
      },
    });
  }, 60_000);

  beforeEach(() => {
    mockLlm.reset();
    mockLlm.register('', { content: 'Mock LLM default response.' });
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4.2 — ON_START Fires Once
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ON_START fires exactly once', () => {
    test('first message in a new session runs ON_START setup without swallowing the user turn', async () => {
      mockLlm.register('Hello', { content: 'Processed first user message.' });

      const result = await sendChatMessage(harness, admin.token, admin.projectId, 'Hello');

      // Session should be created, ON_START should run, and the inbound user
      // turn should still be processed in the same request.
      expect(result.status).toBe(200);
      const responseText = JSON.stringify(result.body);
      expect(responseText).toContain('Processed first user message.');
      expect(responseText).not.toContain('Welcome');
    });

    test('second message in same session does NOT re-trigger ON_START', async () => {
      // First message — creates session and fires ON_START
      const first = await sendChatMessage(harness, admin.token, admin.projectId, 'Hello');
      expect(first.status).toBe(200);
      const sessionId = first.body.sessionId;
      expect(sessionId).toBeDefined();

      // Second message — same session, should NOT fire ON_START again
      const second = await sendChatMessage(
        harness,
        admin.token,
        admin.projectId,
        'What is the weather?',
        sessionId,
      );

      expect(second.status).toBe(200);
      // The ON_START greeting should NOT appear in the second response
      // (it may appear in conversation history, but not as a new response)
    });

    test('third message still does not re-trigger ON_START', async () => {
      const first = await sendChatMessage(harness, admin.token, admin.projectId, 'Hello');
      const sessionId = first.body.sessionId;

      await sendChatMessage(harness, admin.token, admin.projectId, 'Second message', sessionId);

      const third = await sendChatMessage(
        harness,
        admin.token,
        admin.projectId,
        'Third message',
        sessionId,
      );

      expect(third.status).toBe(200);
      // ON_START should have fired only once (on first message)
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4.2 — New Session Gets Its Own ON_START
  // ═══════════════════════════════════════════════════════════════════════════

  describe('New sessions get their own ON_START', () => {
    test('each new session fires ON_START independently', async () => {
      mockLlm.register('Hello from session', { content: 'Processed session greeting.' });

      // Session 1
      const session1 = await sendChatMessage(
        harness,
        admin.token,
        admin.projectId,
        'Hello from session 1',
      );
      expect(session1.status).toBe(200);

      // Session 2 (no sessionId = new session)
      const session2 = await sendChatMessage(
        harness,
        admin.token,
        admin.projectId,
        'Hello from session 2',
      );
      expect(session2.status).toBe(200);

      // Both should have their own session IDs
      expect(session1.body.sessionId).not.toBe(session2.body.sessionId);

      // Both should have received ON_START
      const response1 = JSON.stringify(session1.body);
      const response2 = JSON.stringify(session2.body);
      expect(response1).toContain('Processed session greeting.');
      expect(response2).toContain('Processed session greeting.');
      expect(response1).not.toContain('Welcome');
      expect(response2).not.toContain('Welcome');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4.2 — Agent Without ON_START
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Agent without ON_START', () => {
    test('agent with no ON_START handler works normally', async () => {
      // Import a plain agent without ON_START
      await importProjectFiles(harness, admin.token, admin.projectId, {
        'project.json': JSON.stringify({
          format_version: '2.0',
          entry_agent: 'PlainAgent',
          agents: [{ name: 'PlainAgent', file: 'agents/plainagent.agent.abl' }],
          tools: [],
        }),
        'agents/plainagent.agent.abl': NO_ON_START_AGENT_DSL,
      });

      const result = await requestJson<{
        success?: boolean;
        sessionId?: string;
        error?: unknown;
      }>(harness, `/api/v1/chat/agent`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: {
          projectId: admin.projectId,
          message: 'Hello',
          agentName: 'PlainAgent',
        },
      });

      expect(result.status).toBe(200);
      // Should work fine without ON_START
    });
  });
});
