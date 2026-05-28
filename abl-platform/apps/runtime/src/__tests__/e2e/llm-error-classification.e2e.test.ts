/**
 * LLM Error Classification — E2E Tests
 *
 * ABLP-1229: HTTP-only E2E tests exercising LLM error classification through
 * the full Express runtime + MongoMemoryServer + mock LLM stack.
 *
 * Per CLAUDE.md test architecture:
 *   - No vi.mock of @abl/* or @agent-platform/*
 *   - API-only interaction (seed via POST, assert via GET)
 *   - LLM mocked via DI (external third-party, allowed)
 *   - No direct DB access
 *
 * Scenarios:
 *   E2E-1: Content-filter error → 200 OK + platform default message + trace event
 *   E2E-3: Agent with custom error_llm_content_filter message → custom message
 *   E2E-4: Rate-limited error → 200 OK + platform default + rate_limited subtype
 *   E2E-5: Regression guard — default fallback is exactly 'An error occurred...'
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

const SUITE_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Agent DSL fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal reasoning agent — no error customization. Uses the platform defaults.
 */
const BASIC_AGENT_DSL = `AGENT: LLM_Error_Agent

GOAL: "Answer the user's question using the LLM"

PERSONA: "A helpful assistant"

EXECUTION:
  mode: reasoning

CONVERSATION:
  speaking:
    style: "concise and direct"
    language_policy: interaction_context
    max_sentences: 2
  interaction:
    closure: summarize_outcome
`;

/**
 * Agent with an ON_ERROR handler that specifically targets the content_filter
 * subtype of llm_error. The handler's respond text overrides the platform
 * default, giving the user a project-authored message.
 */
const CUSTOM_ERROR_AGENT_DSL = `AGENT: Custom_Error_Agent

GOAL: "Answer the user's question using the LLM"

PERSONA: "A helpful assistant"

EXECUTION:
  mode: reasoning

CONVERSATION:
  speaking:
    style: "concise and direct"
    language_policy: interaction_context
    max_sentences: 2
  interaction:
    closure: summarize_outcome

ON_ERROR:
  llm_error:
    subtypes: [content_filter]
    respond: "I can't help with that. Could you rephrase?"
    then: continue
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChatAgentBody {
  sessionId?: string;
  response?: string;
  traceEvents?: Array<{ type: string; data: Record<string, unknown> }>;
  error?: unknown;
}

/**
 * Bootstrap a project with the given agent DSL + mock LLM provisioning.
 */
async function bootstrapLlmErrorProject(
  harness: RuntimeApiHarness,
  mockLlm: MockLLM,
  slugPrefix: string,
  agentDsl: string,
  agentName: string,
): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`${slugPrefix}-admin`),
    uniqueSlug(`${slugPrefix}-tenant`),
    uniqueSlug(`${slugPrefix}-project`),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    [`agents/${agentName.toLowerCase()}.agent.abl`]: agentDsl,
  });

  await provisionTenantModel(harness, admin.token, {
    targetTenantId: admin.tenantId,
    displayName: `${slugPrefix} mock model`,
    integrationType: 'api',
    provider: 'openai_compatible',
    modelId: `${slugPrefix}-mock-model`,
    endpointUrl: mockLlm.url,
    supportsStreaming: false,
    supportsTools: true,
    capabilities: ['text', 'tools'],
    tier: 'balanced',
    isDefault: true,
    connection: {
      credentialName: `${slugPrefix}-mock-model`,
      apiKey: 'test-api-key',
    },
  });

  await setSuperAdmins([admin.userId]);
  return admin;
}

/**
 * Send a chat message to the specified agent and return the full response.
 */
async function chatWithAgent(
  harness: RuntimeApiHarness,
  admin: BootstrapProjectResult,
  agentId: string,
  message: string,
): Promise<{ status: number; body: ChatAgentBody }> {
  return requestJson<ChatAgentBody>(harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: {
      projectId: admin.projectId,
      agentId,
      message,
      debug: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;

describe.sequential('LLM Error Classification — E2E', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
  }, SUITE_TIMEOUT_MS);

  // =========================================================================
  // E2E-1: Content-filter error → 200 OK + platform default + trace event
  // =========================================================================

  test(
    'E2E-1: content-filter error → 200 OK with platform default message and error trace event',
    async () => {
      const admin = await bootstrapLlmErrorProject(
        harness,
        mockLlm,
        'llm-err-cf',
        BASIC_AGENT_DSL,
        'LLM_Error_Agent',
      );

      // Register error: when the user message matches "tell me", the mock LLM
      // returns HTTP 400 with an Azure-shaped content_filter error.
      mockLlm.registerError('tell me', {
        status: 400,
        body: {
          error: {
            message:
              'The response was filtered due to the prompt triggering content management policy.',
            type: 'server_error',
            code: 'content_filter',
            innererror: {
              content_filter_result: {
                hate: { severity: 'safe', filtered: false, detected: false },
                violence: { severity: 'medium', filtered: true, detected: true },
              },
            },
          },
        },
      });

      const response = await chatWithAgent(
        harness,
        admin,
        'LLM_Error_Agent',
        'Please tell me about that topic',
      );

      // The runtime should handle the error gracefully — NOT return 500.
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // The response text should be the platform default error message.
      // This is the zero-regression assertion: any agent without custom
      // error messages gets EXACTLY this string.
      expect(response.body.response).toBeDefined();
      expect(response.body.response).toBe('An error occurred. Please try again.');

      // The traceEvents should include an agent_error_handled event
      // (emitted at reasoning-executor line 3784).
      const traceEvents = response.body.traceEvents ?? [];
      const errorEvents = traceEvents.filter((e) => e.type === 'agent_error_handled');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      const errorEvent = errorEvents[0];
      expect(errorEvent.data.errorType).toBe('llm_error');
      expect(errorEvent.data.errorSubtype).toBe('content_filter');
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // E2E-3: Agent with ON_ERROR handler for content_filter subtype
  // =========================================================================

  test(
    'E2E-3: agent with ON_ERROR handler for content_filter subtype → uses custom respond text',
    async () => {
      const admin = await bootstrapLlmErrorProject(
        harness,
        mockLlm,
        'llm-err-custom',
        CUSTOM_ERROR_AGENT_DSL,
        'Custom_Error_Agent',
      );

      // Register the same content_filter error
      mockLlm.registerError('tell me', {
        status: 400,
        body: {
          error: {
            message: 'Content filter triggered.',
            type: 'server_error',
            code: 'content_filter',
          },
        },
      });

      const response = await chatWithAgent(
        harness,
        admin,
        'Custom_Error_Agent',
        'Please tell me about that topic',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // The response should be the CUSTOM respond text from the ON_ERROR
      // handler, NOT the platform default.
      expect(response.body.response).toBeDefined();
      expect(response.body.response).toBe("I can't help with that. Could you rephrase?");
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // E2E-4: Rate-limited error → 200 OK + platform default + rate_limited subtype
  // =========================================================================

  test(
    'E2E-4: rate-limit error → 200 OK with platform default message and rate_limited subtype',
    async () => {
      const admin = await bootstrapLlmErrorProject(
        harness,
        mockLlm,
        'llm-err-rl',
        BASIC_AGENT_DSL,
        'LLM_Error_Agent',
      );

      // Register error: 429 rate-limit response from the mock LLM
      mockLlm.registerError('rate limit test', {
        status: 429,
        body: {
          error: {
            message: 'Rate limit exceeded. Please retry after a moment.',
            type: 'requests',
            code: 'rate_limit_exceeded',
          },
        },
      });

      const response = await chatWithAgent(harness, admin, 'LLM_Error_Agent', 'rate limit test');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.response).toBe('An error occurred. Please try again.');

      const traceEvents = response.body.traceEvents ?? [];
      const errorEvents = traceEvents.filter((e) => e.type === 'agent_error_handled');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      const errorEvent = errorEvents[0];
      expect(errorEvent.data.errorType).toBe('llm_error');
      expect(errorEvent.data.errorSubtype).toBe('rate_limited');
    },
    TEST_TIMEOUT_MS,
  );

  // =========================================================================
  // E2E-5: Regression guard — no error customization → exact platform default
  // =========================================================================

  test(
    'E2E-5: regression guard — no error customization → exact platform default message',
    async () => {
      const admin = await bootstrapLlmErrorProject(
        harness,
        mockLlm,
        'llm-err-regr',
        BASIC_AGENT_DSL,
        'LLM_Error_Agent',
      );

      // Trigger a content-filter error
      mockLlm.registerError('help me', {
        status: 400,
        body: {
          error: {
            message: 'Content policy violation.',
            type: 'server_error',
            code: 'content_filter',
          },
        },
      });

      const response = await chatWithAgent(
        harness,
        admin,
        'LLM_Error_Agent',
        'Can you help me with this?',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // THE REGRESSION GUARD ASSERTION:
      // If a future change accidentally alters the default fallback message,
      // this test fails immediately. This is the zero-regression proof that
      // was previously only claimed in code review.
      expect(response.body.response).toBe('An error occurred. Please try again.');

      // Verify the trace event captures error classification data
      const traceEvents = response.body.traceEvents ?? [];
      const errorEvents = traceEvents.filter((e) => e.type === 'agent_error_handled');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      // The handler should be a DEFAULT handler (not a subtype-specific one)
      const errorEvent = errorEvents[0];
      expect(errorEvent.data.errorType).toBe('llm_error');
    },
    TEST_TIMEOUT_MS,
  );
});
