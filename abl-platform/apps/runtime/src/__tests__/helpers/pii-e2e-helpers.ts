/**
 * Shared bootstrap helpers for the PII detection E2E suite.
 *
 * Each test file uses these to (a) stand up a project with a real
 * Express + Mongo runtime and a mock LLM, (b) configure the PII
 * redaction settings via the runtime config API, (c) drive a chat
 * round-trip and inspect the response.
 *
 * Per CLAUDE.md test architecture: this file does NOT mock any
 * `@abl/*` or `@agent-platform/*` modules. The mock LLM is provisioned
 * as a real OpenAI-compatible HTTP server on a random port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect } from 'vitest';
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
} from './channel-e2e-bootstrap.js';
import type { RuntimeApiHarness } from './runtime-api-harness.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

/**
 * Minimal echo agent used across PII E2E tests. Hits the LLM directly
 * so the mock LLM's registered response becomes the assistant text —
 * giving us a deterministic surface for asserting output-PII redaction.
 *
 * Matches the shape of `Conversation_Behavior_Base_Agent` in
 * `conversation-behavior.e2e.test.ts` — bare `AGENT + GOAL + PERSONA +
 * CONVERSATION` is enough to default to LLM-driven response.
 */
export const PII_ECHO_AGENT_DSL = `AGENT: PII_Echo_Agent

GOAL: "Answer the user's question using the LLM"

PERSONA: "A helpful assistant"

CONVERSATION:
  speaking:
    style: "concise and direct"
    language_policy: interaction_context
    max_sentences: 2
  interaction:
    closure: summarize_outcome
`;

export interface PIIRedactionPatch {
  enabled?: boolean;
  redact_input?: boolean;
  redact_output?: boolean;
  tier?: 'basic' | 'standard' | 'advanced' | 'maximum';
  latency_budget_ms?: number;
  confidence_threshold?: number;
  enabled_recognizer_packs?: string[];
}

interface RuntimeConfigResponse {
  success: boolean;
  data?: { pii_redaction?: PIIRedactionPatch };
  error?: { code: string };
}

/**
 * Bootstrap a project with the echo agent + mock LLM provisioning.
 *
 * Returns the bootstrap result — caller is responsible for any
 * subsequent runtime-config PATCH (so the test sees the boundary
 * between default config and the configured config).
 */
export async function bootstrapPIIProject(
  harness: RuntimeApiHarness,
  mockLlm: MockLLM,
  slugPrefix: string,
): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`${slugPrefix}-admin`),
    uniqueSlug(`${slugPrefix}-tenant`),
    uniqueSlug(`${slugPrefix}-project`),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'agents/pii-echo-agent.agent.abl': PII_ECHO_AGENT_DSL,
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
 * PUT /api/projects/:projectId/runtime-config with the supplied
 * pii_redaction patch. Asserts HTTP 200 and returns the resolved config.
 */
export async function patchPIIConfig(
  harness: RuntimeApiHarness,
  admin: BootstrapProjectResult,
  patch: PIIRedactionPatch,
): Promise<PIIRedactionPatch | undefined> {
  const response = await requestJson<RuntimeConfigResponse>(
    harness,
    `/api/projects/${admin.projectId}/runtime-config`,
    {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body: { pii_redaction: patch },
    },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data?.pii_redaction;
}

export interface PIITraceEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ChatAgentBody {
  sessionId?: string;
  response?: string;
  traceEvents?: PIITraceEvent[];
  error?: unknown;
}

/**
 * Drive POST /api/v1/chat/agent against the echo agent. When sessionId
 * is supplied, the runtime continues the existing session; otherwise a
 * new session starts.
 */
export async function chatWithPIIEcho(
  harness: RuntimeApiHarness,
  admin: BootstrapProjectResult,
  message: string,
  options?: { sessionId?: string },
): Promise<{ status: number; body: ChatAgentBody }> {
  return requestJson<ChatAgentBody>(harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: {
      projectId: admin.projectId,
      agentId: 'PII_Echo_Agent',
      message,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    },
  });
}

/**
 * Register a custom PII pattern via POST /api/projects/:projectId/pii-patterns.
 * Required fields per `validatePattern`: name, piiType, redaction, defaultRenderMode.
 */
export async function registerCustomPattern(
  harness: RuntimeApiHarness,
  admin: BootstrapProjectResult,
  body: {
    name: string;
    regex: string;
    piiType?: string;
    description?: string;
    enabled?: boolean;
  },
): Promise<{ status: number }> {
  const response = await requestJson<{ success: boolean }>(
    harness,
    `/api/projects/${admin.projectId}/pii-patterns`,
    {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: {
        name: body.name,
        regex: body.regex,
        piiType: body.piiType ?? body.name.replace(/[^a-zA-Z0-9_]/g, '_'),
        redaction: { type: 'predefined', label: `[${body.name.toUpperCase()}]` },
        defaultRenderMode: 'redacted',
        description: body.description ?? `Custom pattern ${body.name}`,
        enabled: body.enabled ?? true,
      },
    },
  );
  return { status: response.status };
}

// ---------------------------------------------------------------------------
// Mock Tool Captor — captures parameters the runtime sends to an HTTP tool
// ---------------------------------------------------------------------------

/** A captured tool invocation received by the mock tool server. */
export interface CapturedToolCall {
  toolName: string;
  params: Record<string, unknown>;
  receivedAt: number;
}

/** Mock HTTP tool server that records every invocation for assertion. */
export interface MockToolCaptor {
  /** Base URL of the mock tool server (e.g. http://127.0.0.1:PORT) */
  url: string;
  port: number;
  /** Return all captured calls in order. */
  getCapturedCalls(): CapturedToolCall[];
  /** Return the most recent captured call, or undefined if none. */
  getLastCall(): CapturedToolCall | undefined;
  /** Clear captured calls. */
  reset(): void;
  /** Shut down the server. */
  close(): Promise<void>;
}

/**
 * Start a mock HTTP tool server on a random port. The server accepts
 * POST to any path (the runtime's ToolBindingExecutor posts the tool
 * params as JSON). It captures the request body and returns a simple
 * success response.
 */
export async function startMockToolCaptor(): Promise<MockToolCaptor> {
  const captured: CapturedToolCall[] = [];

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'ok' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {};
        const toolName = (req.url ?? '/').replace(/^\//, '') || 'unknown';
        captured.push({ toolName, params: parsed, receivedAt: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: 'Tool executed successfully' }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    getCapturedCalls(): CapturedToolCall[] {
      return [...captured];
    },
    getLastCall(): CapturedToolCall | undefined {
      return captured.length > 0 ? captured[captured.length - 1] : undefined;
    },
    reset(): void {
      captured.length = 0;
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Agent DSL with a tool that has an HTTP endpoint + pii_access
// ---------------------------------------------------------------------------

/**
 * Build an agent DSL string with a reasoning agent that has a tool.
 * The pii_access property MUST be set in the agent DSL's inline TOOLS
 * section because the IR compiler merges DSL behavioral properties onto
 * resolved project tools — the .tools.abl file's pii_access is not
 * carried through the resolution pipeline.
 */
export function buildPIIToolAgentDSL(
  piiAccess?: 'original' | 'tools' | 'user' | 'logs' | 'llm',
): string {
  const piiLine = piiAccess ? `\n    pii_access: ${piiAccess}` : '';
  return `AGENT: PII_Tool_Agent

GOAL: "Help users look up records using their personal information"

PERSONA: "A helpful assistant that processes sensitive data"

EXECUTION:
  mode: reasoning

CONVERSATION:
  speaking:
    style: "concise and direct"
    language_policy: interaction_context
    max_sentences: 2
  interaction:
    closure: summarize_outcome

TOOLS:
  crm_lookup(ssn: string) -> {result: string}
    description: "Look up a record by SSN"${piiLine}
`;
}

/**
 * Build a .tools.abl file for the crm_lookup tool with an HTTP endpoint
 * and the specified pii_access level.
 */
export function buildCrmToolDSL(
  endpointUrl: string,
  piiAccess?: 'original' | 'tools' | 'user' | 'logs' | 'llm',
): string {
  const piiLine = piiAccess ? `    pii_access: ${piiAccess}\n` : '';
  return `TOOLS:
  crm_lookup(ssn: string) -> {result: string}
    description: "Look up a record by SSN"
    type: http
    endpoint: "${endpointUrl}/crm_lookup"
    method: POST
${piiLine}`;
}

/**
 * Bootstrap a project with a reasoning agent + tool (with HTTP endpoint
 * and optional pii_access configuration) + mock LLM provisioning.
 */
export async function bootstrapPIIToolProject(
  harness: RuntimeApiHarness,
  mockLlm: MockLLM,
  toolCaptor: MockToolCaptor,
  slugPrefix: string,
  piiAccess?: 'original' | 'tools' | 'user' | 'logs' | 'llm',
): Promise<BootstrapProjectResult> {
  const admin = await bootstrapProject(
    harness,
    uniqueEmail(`${slugPrefix}-admin`),
    uniqueSlug(`${slugPrefix}-tenant`),
    uniqueSlug(`${slugPrefix}-project`),
  );

  await importProjectFiles(harness, admin.token, admin.projectId, {
    'project.json': JSON.stringify({
      format_version: '2.0',
      entry_agent: 'PII_Tool_Agent',
      agents: [{ name: 'PII_Tool_Agent', file: 'agents/pii-tool-agent.agent.abl' }],
      tools: [{ name: 'crm_lookup', file: 'tools/crm_lookup.tools.abl' }],
    }),
    // pii_access is set in the AGENT DSL's inline TOOLS section because
    // the IR compiler merges DSL behavioral properties onto resolved tools.
    'agents/pii-tool-agent.agent.abl': buildPIIToolAgentDSL(piiAccess),
    'tools/crm_lookup.tools.abl': buildCrmToolDSL(toolCaptor.url),
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
 * Drive POST /api/v1/chat/agent against the PII_Tool_Agent.
 * Unlike chatWithPIIEcho, this targets PII_Tool_Agent and the
 * response body includes traceEvents.
 */
export async function chatWithPIIToolAgent(
  harness: RuntimeApiHarness,
  admin: BootstrapProjectResult,
  message: string,
  options?: { sessionId?: string; debug?: boolean },
): Promise<{ status: number; body: ChatAgentBody }> {
  return requestJson<ChatAgentBody>(harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: {
      projectId: admin.projectId,
      agentId: 'PII_Tool_Agent',
      message,
      debug: options?.debug ?? true,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    },
  });
}
