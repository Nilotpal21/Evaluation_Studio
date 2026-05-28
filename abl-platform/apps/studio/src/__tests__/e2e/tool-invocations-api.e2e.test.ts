// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import express, {
  type Express,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';
import Busboy from 'busboy';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';
import { MTLS_TEST_FIXTURES } from './mtls-test-fixtures';

// Next.js uses the `server-only` sentinel package to fail loudly when a
// server module is imported into a client bundle. Vitest runs outside
// Next's runtime, so any route handler this suite imports would throw
// at module-load. Stubbing the sentinel is the only way to dispatch route
// handlers via callStudioRoute without booting a full Next server.
// `server-only` is a third-party package, allowed by CLAUDE.md
// "Test Architecture" rule 5 (external packages only).
vi.mock('server-only', () => ({}));

const TEST_TIMEOUT_MS = 120_000;
const SUITE_HOOK_TIMEOUT_MS = 300_000;
const MEMORY_MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MEMORY_MONGO_LAUNCH_TIMEOUT_MS = 30_000;
const LLM_MODEL_ID = 'gpt-4o-mini';
const PROJECT_NAME = 'Tool Invocation API E2E';
const DEV_LOGIN_EMAIL = 'tool-invocations@e2e-smoke.test';
const DEV_LOGIN_NAME = 'Tool Invocation E2E';
const AUTH_PROFILE_NAME = 'service_profile';
const CONFIG_AUTH_PROFILE_VAR_KEY = 'SERVICE_AUTH_PROFILE';
const CONFIG_PREFLIGHT_AUTH_PROFILE_VAR_KEY = 'OAUTH_PREFLIGHT_AUTH_PROFILE';
const AUTH_PROFILE_SECRET = 'profile-secret-123';
const AUTH_PROFILE_HEADER = 'X-Service-Api';
const BASIC_AUTH_PROFILE_NAME = 'basic_profile';
const BASIC_LOOKUP_ID = 'basic-7';
const CUSTOM_HEADER_PROFILE_NAME = 'custom_header_profile';
const CUSTOM_HEADER_LOOKUP_ID = 'custom-8';
const CUSTOM_HEADER_API_KEY = 'tenant-key-123';
const CUSTOM_HEADER_ORG_ID = 'org-456';
const AWS_IAM_PROFILE_NAME = 'aws_sigv4_profile';
const AWS_SIGV4_LOOKUP_ID = 'aws-9';
const AWS_IAM_INCOMPLETE_PROFILE_NAME = 'aws_sigv4_incomplete_profile';
const MTLS_PROFILE_NAME = 'mtls_profile';
const MTLS_LOOKUP_ID = 'mtls-11';
const MTLS_PLAIN_LOOKUP_ID = 'mtls-plain-12';
const A2A_API_KEY = 'a2a-secret-123';
const CONTEXT_TICKET_ID = 'TCK-CTX-42';
const ATTACHMENT_TICKET_ID = 'TCK-9001';
const A2A_LOOKUP_ID = 'A2A-77';
const MCP_SERVER_NAME = 'customer_directory';
const MCP_SERVER_TOOL_NAME = 'lookup_customer';
const MCP_DISCOVERED_TOOL_NAME = 'customer_directory__lookup_customer';
const MCP_LOOKUP_ID = 'MCP-55';
const OAUTH_PROFILE_NAME = 'oauth_mail_profile';
const OAUTH_CONFIG_PREFLIGHT_PROFILE_NAME = 'oauth_mail_profile_config';
const OAUTH_ACCESS_TOKEN = 'oauth-access-token-xyz';
const OAUTH_CLIENT_CREDENTIALS_PROFILE_NAME = 'oauth_service_profile';
const OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN = 'oauth-client-credentials-token';
const OAUTH_CLIENT_ID = 'oauth-client-id';
const OAUTH_CLIENT_SECRET = 'oauth-client-secret';
const OAUTH_CODE = 'oauth-code-123';
const OAUTH_LOOKUP_ID = 'oauth-55';
const CLIENT_CREDENTIALS_LOOKUP_ID = 'cc-17';
const SANDBOX_TOTAL = 50;
const JIT_LOOKUP_ID = 'jit-9';
const SECURE_DELETE_ID = 'DEL-22';
const SECURE_DELETE_REASON = 'cleanup';
const REDIS_SERVER_BINARY_CANDIDATES = [
  process.env['REDIS_SERVER_BIN'],
  '/opt/homebrew/bin/redis-server',
  '/usr/local/bin/redis-server',
  'redis-server',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

type CloseableServer = HttpServer | HttpsServer;

interface StudioRouteModule {
  GET?: (request: NextRequest, context: RouteContext) => Promise<Response>;
  POST?: (request: NextRequest, context: RouteContext) => Promise<Response>;
  PUT?: (request: NextRequest, context: RouteContext) => Promise<Response>;
}

interface RouteContext {
  params: Promise<Record<string, string>>;
}

interface StudioModules {
  devLogin: StudioRouteModule;
  projects: StudioRouteModule;
  configVariables: StudioRouteModule;
  tools: StudioRouteModule;
  toolTest: StudioRouteModule;
  agents: StudioRouteModule;
  agentDsl: StudioRouteModule;
  authProfiles: StudioRouteModule;
  authProfileOauthUserConsent: StudioRouteModule;
  authProfileOauthCallback: StudioRouteModule;
  mcpServers: StudioRouteModule;
  mcpServerToolsDiscover: StudioRouteModule;
  mcpServerToolTest: StudioRouteModule;
  tenantCredentials: StudioRouteModule;
  tenantModels: StudioRouteModule;
  tenantModelConnections: StudioRouteModule;
}

interface MockToolRequest {
  route: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  tls?: {
    authorized: boolean;
    peerCommonName?: string;
  };
}

interface MockAttachmentRecord {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  originalFilename: string;
  mimeType: string;
  category: 'document' | 'image' | 'audio' | 'video';
  scanStatus: 'clean' | 'infected' | 'pending' | 'error';
  processingStatus: 'completed' | 'processing' | 'pending' | 'failed' | 'skipped';
  embeddingStatus: 'skipped';
  processedContent: string | null;
  processingError: string | null;
}

interface MockMcpRequest {
  method: string;
  params: unknown;
  headers: Record<string, string>;
}

interface MockLLMRequest {
  body: Record<string, unknown>;
}

interface TestState {
  accessToken: string;
  tenantId: string;
  projectId: string;
  toolIds: Record<string, string>;
  agentNames: Record<string, string>;
  authProfileId: string;
  oauthPreflightProfileId: string;
  oauthConfigPreflightProfileId: string;
  clientCredentialsProfileId: string;
  mcpServerId: string;
  tenantCredentialId: string;
  tenantModelId: string;
  a2aConnectionId: string;
}

let mongoServer: MongoMemoryServer;
let studioModules: StudioModules;
let runtimeProcess: ChildProcessWithoutNullStreams | null = null;

let runtimePort = 0;
let toolServerPort = 0;
let mtlsServerPort = 0;
let llmServerPort = 0;
let multimodalServerPort = 0;
let mcpServerPort = 0;
let redisPort = 0;

let toolServer: CloseableServer;
let mtlsServer: CloseableServer;
let llmServer: CloseableServer;
let multimodalServer: CloseableServer;
let mcpServer: CloseableServer;
let redisProcess: ChildProcessWithoutNullStreams | null = null;

const mockToolRequests: MockToolRequest[] = [];
const mockMcpRequests: MockMcpRequest[] = [];
const mockLLMRequests: MockLLMRequest[] = [];
const mockAttachments = new Map<string, MockAttachmentRecord>();
let mockAttachmentCounter = 0;

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(new URL('../../../../runtime/dist/index.js', import.meta.url));

function debugStep(message: string): void {
  if (process.env['TOOL_INVOCATIONS_E2E_DEBUG'] === 'true') {
    process.stderr.write(`[tool-invocations-e2e] ${message}\n`);
  }
}

const state: TestState = {
  accessToken: '',
  tenantId: '',
  projectId: '',
  toolIds: {},
  agentNames: {},
  authProfileId: '',
  oauthPreflightProfileId: '',
  oauthConfigPreflightProfileId: '',
  clientCredentialsProfileId: '',
  mcpServerId: '',
  tenantCredentialId: '',
  tenantModelId: '',
  a2aConnectionId: '',
};

describe.sequential('Tool invocation API e2e', () => {
  beforeAll(async () => {
    debugStep('reserving ports');
    runtimePort = await reservePort();
    toolServerPort = await reservePort();
    mtlsServerPort = await reservePort();
    llmServerPort = await reservePort();
    multimodalServerPort = await reservePort();
    mcpServerPort = await reservePort();
    redisPort = await reservePort();

    debugStep('starting mock servers');
    toolServer = await startMockToolServer(toolServerPort);
    mtlsServer = await startMockMutualTlsServer(mtlsServerPort);
    llmServer = await startMockLLMServer(llmServerPort);
    multimodalServer = await startMockMultimodalServer(multimodalServerPort);
    mcpServer = await startMockMcpServer(mcpServerPort);

    debugStep('starting in-memory mongo');
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MEMORY_MONGO_VERSION },
      instance: { launchTimeout: MEMORY_MONGO_LAUNCH_TIMEOUT_MS },
    });

    debugStep('setting test environment');
    setTestEnvironment({
      runtimePort,
      llmServerPort,
      multimodalServerPort,
      redisPort,
      mongoUri: mongoServer.getUri('tool_invocations_e2e'),
    });

    vi.resetModules();

    debugStep(`starting redis on ${redisPort}`);
    redisProcess = startRedisProcess(redisPort);
    await waitForRedis(redisPort);
    debugStep('redis ready');

    debugStep(`starting runtime server on ${runtimePort}`);
    runtimeProcess = startRuntimeProcess();
    await waitForHealth(`http://127.0.0.1:${runtimePort}/health`, runtimeProcess);
    debugStep('runtime health check passed');

    debugStep('initializing studio redis client');
    const { loadConfig } = await import('../../config');
    await loadConfig();
    const { initializeRedis } = await import('../../lib/redis-client');
    await initializeRedis();

    debugStep('loading studio route modules');
    studioModules = {
      devLogin:
        (await import('../../app/api/auth/dev-login/route')) as unknown as StudioRouteModule,
      projects: (await import('../../app/api/projects/route')) as unknown as StudioRouteModule,
      configVariables:
        (await import('../../app/api/projects/[id]/config-variables/route')) as unknown as StudioRouteModule,
      tools:
        (await import('../../app/api/projects/[id]/tools/route')) as unknown as StudioRouteModule,
      toolTest:
        (await import('../../app/api/projects/[id]/tools/[toolId]/test/route')) as unknown as StudioRouteModule,
      agents:
        (await import('../../app/api/projects/[id]/agents/route')) as unknown as StudioRouteModule,
      agentDsl:
        (await import('../../app/api/projects/[id]/agents/[agentId]/dsl/route')) as unknown as StudioRouteModule,
      authProfiles:
        (await import('../../app/api/projects/[id]/auth-profiles/route')) as unknown as StudioRouteModule,
      authProfileOauthUserConsent:
        (await import('../../app/api/projects/[id]/auth-profiles/oauth/user-consent/route')) as unknown as StudioRouteModule,
      authProfileOauthCallback:
        (await import('../../app/api/projects/[id]/auth-profiles/oauth/callback/route')) as unknown as StudioRouteModule,
      mcpServers:
        (await import('../../app/api/projects/[id]/mcp-servers/route')) as unknown as StudioRouteModule,
      mcpServerToolsDiscover:
        (await import('../../app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/route')) as unknown as StudioRouteModule,
      mcpServerToolTest:
        (await import('../../app/api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test/route')) as unknown as StudioRouteModule,
      tenantCredentials:
        (await import('../../app/api/tenant-credentials/route')) as unknown as StudioRouteModule,
      tenantModels:
        (await import('../../app/api/tenant-models/route')) as unknown as StudioRouteModule,
      tenantModelConnections:
        (await import('../../app/api/tenant-models/[id]/connections/route')) as unknown as StudioRouteModule,
    };

    debugStep('seeding API state');
    await seedApiState();
    debugStep('seed complete');
  }, SUITE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    const { disconnectRedis } = await import('../../lib/redis-client');
    await disconnectRedis();

    await closeServer(mcpServer);
    await closeServer(multimodalServer);
    await closeServer(llmServer);
    await closeServer(mtlsServer);
    await closeServer(toolServer);
    await stopRuntimeProcess(runtimeProcess);
    runtimeProcess = null;
    await stopRedisProcess(redisProcess);
    redisProcess = null;

    await mongoServer?.stop();
  }, SUITE_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    mockMcpRequests.length = 0;
    mockToolRequests.length = 0;
    mockLLMRequests.length = 0;
  });

  it(
    'executes direct Studio tool tests with path/query/header/body mapping and nested params',
    async () => {
      const result = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${state.toolIds.direct_nested_lookup}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId: state.toolIds.direct_nested_lookup },
        body: {
          input: {
            customerId: 'customer-7',
            status: 'active',
            filter: {
              region: 'us-east',
              nested: { vip: true, tags: ['priority', 'renewal'] },
            },
            extra: 'body-only-value',
          },
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.success).toBe(true);

      const toolRequest = findSingleToolRequest('direct');
      expect(toolRequest.path).toBe('/records/direct/customer-7');
      expect(toolRequest.query).toMatchObject({ status: 'active' });
      expect(toolRequest.headers['x-filter-snapshot']).toContain('"region":"us-east"');
      expect(toolRequest.body).toEqual({
        filter: {
          region: 'us-east',
          nested: { vip: true, tags: ['priority', 'renewal'] },
        },
        extra: 'body-only-value',
      });

      expect(result.json.result.request).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/records/direct/customer-7?status=active'),
        headers: {
          'X-Filter-Snapshot': expect.stringContaining('"region":"us-east"'),
        },
      });
      expect(parseJsonLikeValue(result.json.result.request.body)).toEqual({
        filter: {
          region: 'us-east',
          nested: { vip: true, tags: ['priority', 'renewal'] },
        },
        extra: 'body-only-value',
      });
      expect(result.json.result.response.body).toMatchObject({
        route: 'direct',
        received: {
          query: { status: 'active' },
          body: {
            filter: {
              region: 'us-east',
              nested: { vip: true, tags: ['priority', 'renewal'] },
            },
            extra: 'body-only-value',
          },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes direct Studio sandbox tool tests over the public route',
    async () => {
      const result = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${state.toolIds.sandbox_add}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId: state.toolIds.sandbox_add },
        body: {
          input: {
            left: 19,
            right: 23,
          },
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.success).toBe(true);
      expect(result.json.result.output).toEqual({
        total: 42,
        explanation: '19 + 23 = 42',
      });
      expect(result.json.result.sandbox).toMatchObject({
        runtime: 'javascript',
        timeoutMs: 10_000,
        memoryMb: 128,
      });
      expect(mockToolRequests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes the create-bind-execute-respond agent path with real tool calls',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.agent_lookup_agent,
          message: 'Look up customer customer-7 and summarize the record.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Agent lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'agent_lookup',
      );

      const toolRequest = findSingleToolRequest('agent');
      expect(toolRequest.body).toEqual({ customerId: 'customer-7' });
      expect(mockLLMRequests.length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves nested HTTP parameters through the runtime agent path',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.nested_params_agent,
          message:
            'Look up customer customer-9 with active status in the us-east region and include vip renewal filters.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Nested lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'direct_nested_lookup',
      );

      const toolRequest = findSingleToolRequest('direct');
      expect(toolRequest.path).toBe('/records/direct/customer-9');
      expect(toolRequest.query).toMatchObject({ status: 'active' });
      expect(toolRequest.headers['x-filter-snapshot']).toContain('"region":"us-east"');
      expect(toolRequest.body).toEqual({
        filter: {
          region: 'us-east',
          nested: { vip: true, tags: ['priority', 'renewal'] },
        },
        extra: 'runtime-agent',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves auth profiles during agent tool execution and injects the configured header',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.auth_profile_agent,
          message: 'Run the authenticated lookup for auth-7.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Authenticated lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'auth_profile_lookup',
      );

      const toolRequest = findSingleToolRequest('auth');
      expect(toolRequest.headers['x-service-api']).toBe(`Token ${AUTH_PROFILE_SECRET}`);
      expect(toolRequest.body).toEqual({ lookupId: 'auth-7' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves auth profiles from config-variable references during agent tool execution',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.templated_auth_profile_agent,
          message: 'Run the templated authenticated lookup for auth-8.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Authenticated lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'auth_profile_lookup',
      );

      const toolRequest = findSingleToolRequest('auth');
      expect(toolRequest.headers['x-service-api']).toBe(`Token ${AUTH_PROFILE_SECRET}`);
      expect(toolRequest.body).toEqual({ lookupId: 'auth-8' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes basic auth profiles on the supported HTTP tool path',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.basic_auth_agent,
          message: `Run the basic-auth lookup for ${BASIC_LOOKUP_ID}.`,
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Basic auth lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'basic_auth_lookup',
      );

      const toolRequest = findSingleToolRequest('basic');
      expect(toolRequest.headers['authorization']).toBe(
        `Basic ${Buffer.from('basic-user:basic-pass').toString('base64')}`,
      );
      expect(toolRequest.body).toEqual({ lookupId: BASIC_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes custom header auth profiles on the supported HTTP tool path',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.custom_header_agent,
          message: `Run the custom-header lookup for ${CUSTOM_HEADER_LOOKUP_ID}.`,
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Custom header lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'custom_header_lookup',
      );

      const toolRequest = findSingleToolRequest('custom-header');
      expect(toolRequest.headers['x-tenant-key']).toBe(CUSTOM_HEADER_API_KEY);
      expect(toolRequest.headers['x-org-id']).toBe(CUSTOM_HEADER_ORG_ID);
      expect(toolRequest.body).toEqual({ lookupId: CUSTOM_HEADER_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'signs AWS IAM auth profiles on the supported HTTP tool path',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.aws_sigv4_agent,
          message: `Run the aws lookup for ${AWS_SIGV4_LOOKUP_ID}.`,
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('AWS IAM lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'aws_sigv4_lookup',
      );

      const toolRequest = findSingleToolRequest('aws-sigv4');
      expect(toolRequest.headers['authorization']).toContain('AWS4-HMAC-SHA256');
      expect(toolRequest.headers['authorization']).toContain('/us-east-1/execute-api/aws4_request');
      expect(toolRequest.headers['x-amz-date']).toBeTruthy();
      expect(toolRequest.headers['x-amz-security-token']).toBe('phase2-session-token');
      expect(toolRequest.body).toEqual({ lookupId: AWS_SIGV4_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  // Note: the runtime fail-closed path for "aws_iam profile missing region/service"
  // is unreachable end-to-end now that the Phase 2 schema rejects such profiles
  // at create time (see seed assertion in seedApiState). The runtime backstop is
  // covered by auth-profile-tool-aws-iam-middleware.test.ts.

  it(
    'executes mTLS auth profiles on the supported HTTPS HTTP tool path',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.mtls_agent,
          message: `Run the mtls lookup for ${MTLS_LOOKUP_ID}.`,
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('mTLS lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'mtls_lookup',
      );

      const toolRequest = findSingleToolRequest('mtls');
      expect(toolRequest.tls).toEqual({
        authorized: true,
        peerCommonName: 'AuthProfilePhase2Client',
      });
      expect(toolRequest.body).toEqual({ lookupId: MTLS_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails closed for mTLS auth on a plain HTTP endpoint before any outbound request',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.mtls_plain_agent,
          message: `Run the mtls plain lookup for ${MTLS_PLAIN_LOOKUP_ID}.`,
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('https:// endpoint');
      expect(mockToolRequests.filter((request) => request.route === 'mtls-plain')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'discovers MCP tools through Studio APIs and executes direct MCP tool tests over the public surface',
    async () => {
      const discovery = await callStudioRoute(studioModules.mcpServerToolsDiscover.POST!, {
        path: `/api/projects/${state.projectId}/mcp-servers/${state.mcpServerId}/tools/discover`,
        token: state.accessToken,
        params: { id: state.projectId, serverId: state.mcpServerId },
        body: {
          toolNames: [MCP_SERVER_TOOL_NAME],
        },
      });

      expect(discovery.status).toBe(200);
      expect(discovery.json.success).toBe(true);
      expect(discovery.json.successful).toBeGreaterThanOrEqual(1);

      const testResult = await callStudioRoute(studioModules.mcpServerToolTest.POST!, {
        path: `/api/projects/${state.projectId}/mcp-servers/${state.mcpServerId}/tools/${MCP_SERVER_TOOL_NAME}/test`,
        token: state.accessToken,
        params: {
          id: state.projectId,
          serverId: state.mcpServerId,
          toolName: MCP_SERVER_TOOL_NAME,
        },
        body: {
          input: {
            lookupId: MCP_LOOKUP_ID,
          },
        },
      });

      expect(testResult.status).toBe(200);
      expect(testResult.json.success).toBe(true);
      expect(testResult.json.result.success).toBe(true);
      expect(String(testResult.json.result.output)).toContain(MCP_LOOKUP_ID);
      expect(mockMcpRequests.some((request) => request.method === 'tools/list')).toBe(true);

      const toolCallRequest = mockMcpRequests.find((request) => request.method === 'tools/call');
      expect(toolCallRequest?.params).toMatchObject({
        name: MCP_SERVER_TOOL_NAME,
        arguments: { lookupId: MCP_LOOKUP_ID },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes discovered MCP tools from agent chat end to end',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.mcp_lookup_agent,
          message: 'Use the customer directory MCP tool to look up record MCP-55.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('MCP lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        MCP_DISCOVERED_TOOL_NAME,
      );

      const toolCallRequest = mockMcpRequests.find((request) => request.method === 'tools/call');
      expect(toolCallRequest?.params).toMatchObject({
        name: MCP_SERVER_TOOL_NAME,
        arguments: { lookupId: MCP_LOOKUP_ID },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes sandbox code tools from agent chat using the mock sandbox backend',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.sandbox_agent,
          message: 'Add 20 and 30 with the code tool.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain(String(SANDBOX_TOTAL));
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'sandbox_add',
      );
      expect(mockToolRequests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves oauth2 client-credentials auth profiles during agent tool execution',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.client_credentials_agent,
          message: 'Run the service-authenticated lookup for cc-17.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('Client credentials lookup complete');
      expect(findTraceEvent(result.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'client_credentials_lookup',
      );

      const tokenExchangeRequest = findSingleToolRequest('oauth-token');
      expect(tokenExchangeRequest.body).toMatchObject({
        grant_type: 'client_credentials',
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        scope: 'mail.read mail.send',
      });

      const toolRequest = findSingleToolRequest('client-credentials');
      expect(toolRequest.headers['authorization']).toBe(
        `Bearer ${OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN}`,
      );
      expect(toolRequest.body).toEqual({ lookupId: CLIENT_CREDENTIALS_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks preflight auth-profile tools until OAuth consent is completed, then executes the same session successfully',
    async () => {
      const gatedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.oauth_preflight_agent,
          message: 'Look up the protected OAuth-backed record.',
        },
      });

      expect(gatedTurn.status).toBe(200);
      expect(gatedTurn.json.response).toBe(
        'Authorization is required before the agent can continue.',
      );
      expect(gatedTurn.json.action).toMatchObject({
        type: 'auth_required',
      });
      expect(gatedTurn.json.action.pending).toEqual([
        expect.objectContaining({
          authProfileRef: OAUTH_PROFILE_NAME,
          connectionMode: 'per_user',
        }),
      ]);
      expect(mockLLMRequests).toHaveLength(0);
      expect(mockToolRequests.filter((request) => request.route === 'oauth')).toHaveLength(0);

      const consent = await completeOAuthConsentForSession(
        String(gatedTurn.json.sessionId),
        state.oauthPreflightProfileId,
        OAUTH_PROFILE_NAME,
      );
      expect(consent.authUrl).toContain(`client_id=${OAUTH_CLIENT_ID}`);

      const tokenExchangeRequest = findSingleToolRequest('oauth-token');
      expect(tokenExchangeRequest.body).toMatchObject({
        grant_type: 'authorization_code',
        code: OAUTH_CODE,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      });

      mockToolRequests.length = 0;
      mockLLMRequests.length = 0;

      const resumedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId: gatedTurn.json.sessionId,
          message: 'Retry the protected lookup now that consent is complete.',
        },
      });

      expect(resumedTurn.status).toBe(200);
      expect(resumedTurn.json.response).toContain('OAuth preflight lookup complete');
      expect(findTraceEvent(resumedTurn.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'oauth_preflight_lookup',
      );

      const oauthRequest = findSingleToolRequest('oauth');
      expect(oauthRequest.headers['authorization']).toBe(`Bearer ${OAUTH_ACCESS_TOKEN}`);
      expect(oauthRequest.body).toEqual({ lookupId: OAUTH_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resolves config-backed preflight auth profiles before gating, then executes after OAuth consent',
    async () => {
      const gatedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.templated_oauth_preflight_agent,
          message: 'Look up the protected config-backed OAuth record.',
        },
      });

      expect(gatedTurn.status).toBe(200);
      expect(gatedTurn.json.response).toBe(
        'Authorization is required before the agent can continue.',
      );
      expect(gatedTurn.json.action).toMatchObject({
        type: 'auth_required',
      });
      expect(gatedTurn.json.action.pending).toEqual([
        expect.objectContaining({
          authProfileRef: OAUTH_CONFIG_PREFLIGHT_PROFILE_NAME,
          connectionMode: 'per_user',
        }),
      ]);
      expect(mockLLMRequests).toHaveLength(0);
      expect(mockToolRequests.filter((request) => request.route === 'oauth')).toHaveLength(0);

      const consent = await completeOAuthConsentForSession(
        String(gatedTurn.json.sessionId),
        state.oauthConfigPreflightProfileId,
        OAUTH_CONFIG_PREFLIGHT_PROFILE_NAME,
      );
      expect(consent.authUrl).toContain(`client_id=${OAUTH_CLIENT_ID}`);

      const tokenExchangeRequest = findSingleToolRequest('oauth-token');
      expect(tokenExchangeRequest.body).toMatchObject({
        grant_type: 'authorization_code',
        code: OAUTH_CODE,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      });

      mockToolRequests.length = 0;
      mockLLMRequests.length = 0;

      const resumedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId: gatedTurn.json.sessionId,
          message: 'Retry the protected config-backed lookup now that consent is complete.',
        },
      });

      expect(resumedTurn.status).toBe(200);
      expect(resumedTurn.json.response).toContain('OAuth preflight lookup complete');
      expect(findTraceEvent(resumedTurn.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'oauth_preflight_lookup',
      );

      const oauthRequest = findSingleToolRequest('oauth');
      expect(oauthRequest.headers['authorization']).toBe(`Bearer ${OAUTH_ACCESS_TOKEN}`);
      expect(oauthRequest.body).toEqual({ lookupId: OAUTH_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns a structured JIT auth result on REST chat when the channel cannot deliver interactive consent',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.jit_auth_agent,
          message: 'Run the just-in-time auth lookup for jit-9.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.response).toContain('JIT_AUTH_NOT_SUPPORTED');
      expect(mockToolRequests.filter((request) => request.route === 'jit')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'halts secure side-effecting tools behind confirmation and does not dispatch the request before approval',
    async () => {
      const result = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.secure_delete_agent,
          message: 'Delete record DEL-22.',
        },
      });

      expect(result.status).toBe(200);
      expect(result.json.action).toMatchObject({
        type: 'await_confirmation',
        toolName: 'secure_delete',
      });
      expect(
        findTraceEvent(result.json.traceEvents, 'tool_confirmation_requested')?.data,
      ).toMatchObject({
        toolName: 'secure_delete',
      });
      expect(mockToolRequests.filter((request) => request.route === 'secure')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes secure side-effecting tools after the user confirms the original immutable parameters',
    async () => {
      const gatedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.secure_delete_agent,
          message: `Delete record ${SECURE_DELETE_ID}.`,
        },
      });

      expect(gatedTurn.status).toBe(200);
      expect(gatedTurn.json.action).toMatchObject({
        type: 'await_confirmation',
        toolName: 'secure_delete',
      });
      expect(mockToolRequests.filter((request) => request.route === 'secure')).toHaveLength(0);

      mockToolRequests.length = 0;
      mockLLMRequests.length = 0;

      const confirmedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId: gatedTurn.json.sessionId,
          message: `Yes, confirm deleting record ${SECURE_DELETE_ID}.`,
        },
      });

      expect(confirmedTurn.status).toBe(200);
      expect(confirmedTurn.json.response).toContain(
        `Secure delete complete for ${SECURE_DELETE_ID}`,
      );
      expect(
        findTraceEvent(confirmedTurn.json.traceEvents, 'tool_confirmation_approved')?.data,
      ).toMatchObject({
        toolName: 'secure_delete',
      });

      const secureRequest = findSingleToolRequest('secure');
      expect(secureRequest.body).toEqual({
        ticketId: SECURE_DELETE_ID,
        reason: SECURE_DELETE_REASON,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects secure tool replays when immutable parameters are changed after confirmation was requested',
    async () => {
      const gatedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.secure_delete_agent,
          message: `Delete record ${SECURE_DELETE_ID}.`,
        },
      });

      expect(gatedTurn.status).toBe(200);
      expect(gatedTurn.json.action).toMatchObject({
        type: 'await_confirmation',
        toolName: 'secure_delete',
      });
      expect(mockToolRequests.filter((request) => request.route === 'secure')).toHaveLength(0);

      mockToolRequests.length = 0;
      mockLLMRequests.length = 0;

      const tamperedTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId: gatedTurn.json.sessionId,
          message: 'Actually delete record DEL-99 instead.',
        },
      });

      expect(tamperedTurn.status).toBe(200);
      expect(tamperedTurn.json.response).toContain('Parameter tampering detected');
      expect(
        findTraceEvent(tamperedTurn.json.traceEvents, 'tool_confirmation_immutability_violation')
          ?.data,
      ).toMatchObject({
        toolName: 'secure_delete',
      });
      expect(mockToolRequests.filter((request) => request.route === 'secure')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'maps tool results into session context and injects remembered values into later tool calls',
    async () => {
      const rememberTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.context_agent,
          message: 'Remember the latest ticket for customer ctx-1.',
        },
      });

      expect(rememberTurn.status).toBe(200);
      expect(rememberTurn.json.response).toContain('remembered');
      expect(findTraceEvent(rememberTurn.json.traceEvents, 'tool_call')?.data.toolName).toBe(
        'remember_ticket',
      );

      const rememberRequest = findSingleToolRequest('context-write');
      expect(rememberRequest.body).toEqual({ customerId: 'ctx-1' });

      mockToolRequests.length = 0;

      const readTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId: rememberTurn.json.sessionId,
          message: 'Use the remembered ticket context now.',
        },
      });

      expect(readTurn.status).toBe(200);
      expect(readTurn.json.response).toContain('remembered ticket context');

      const readRequest = findSingleToolRequest('context-read');
      expect(readRequest.body).toEqual({
        context: {
          last_ticket_id: CONTEXT_TICKET_ID,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'uploads attachments through the runtime API and uses extracted attachment text in agent tool calls',
    async () => {
      const initialTurn = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          agentId: state.agentNames.attachment_agent,
          message: 'Look up ticket TCK-0001 first so the session exists.',
        },
      });

      expect(initialTurn.status).toBe(200);
      const sessionId = String(initialTurn.json.sessionId);
      mockToolRequests.length = 0;

      const attachmentUpload = await uploadAttachment({
        projectId: state.projectId,
        sessionId,
        token: state.accessToken,
        filename: 'support-note.txt',
        mimeType: 'text/plain',
        content: `Incident note\nTicket reference: ${ATTACHMENT_TICKET_ID}\nCustomer mentioned a billing mismatch.`,
      });

      expect(attachmentUpload.status).toBe(201);
      expect(attachmentUpload.json.success).toBe(true);

      const turnWithAttachment = await callRuntimeJson('/api/v1/chat/agent', {
        token: state.accessToken,
        body: {
          projectId: state.projectId,
          sessionId,
          message: 'Use the uploaded note to find the right ticket.',
          attachmentIds: [attachmentUpload.json.attachmentId],
        },
      });

      expect(turnWithAttachment.status).toBe(200);
      expect(turnWithAttachment.json.response).toContain(ATTACHMENT_TICKET_ID);

      const preprocessEvent = findTraceEvent(
        turnWithAttachment.json.traceEvents,
        'attachment_preprocess',
      );
      expect(preprocessEvent?.data.attachmentCount).toBe(1);

      const attachmentRequest = findSingleToolRequest('attachment');
      expect(attachmentRequest.body).toEqual({ ticketId: ATTACHMENT_TICKET_ID });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves authenticated A2A routes and executes the full tool invocation chain over message/send',
    async () => {
      const unauthorizedCard = await fetch(
        `http://127.0.0.1:${runtimePort}/a2a/${state.a2aConnectionId}/.well-known/agent-card.json`,
      );
      expect(unauthorizedCard.status).toBe(401);

      const cardResponse = await fetch(
        `http://127.0.0.1:${runtimePort}/a2a/${state.a2aConnectionId}/.well-known/agent-card.json`,
        {
          headers: { Authorization: `Bearer ${A2A_API_KEY}` },
        },
      );
      expect(cardResponse.status).toBe(200);
      const cardJson = (await cardResponse.json()) as Record<string, unknown>;
      expect(cardJson.url).toBe('/a2a');

      const messageResponse = await fetch(
        `http://127.0.0.1:${runtimePort}/a2a/${state.a2aConnectionId}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${A2A_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'a2a-tool-invocations',
            method: 'message/send',
            params: {
              message: {
                kind: 'message',
                messageId: 'a2a-message-1',
                role: 'user',
                parts: [{ kind: 'text', text: 'Look up A2A ticket A2A-77.' }],
              },
            },
          }),
        },
      );

      expect(messageResponse.status).not.toBe(401);
      expect(messageResponse.status).not.toBe(403);

      const rpcBody = (await messageResponse.json()) as Record<string, unknown>;
      expect(rpcBody.error).toBeUndefined();
      expect(extractA2AText(rpcBody.result)).toContain('A2A lookup complete');

      const toolRequest = findSingleToolRequest('a2a');
      expect(toolRequest.body).toEqual({ ticketId: A2A_LOOKUP_ID });
    },
    TEST_TIMEOUT_MS,
  );
});

async function seedApiState(): Promise<void> {
  debugStep('seed: dev login');
  const login = await callStudioRoute(studioModules.devLogin.POST!, {
    path: '/api/auth/dev-login',
    body: { email: DEV_LOGIN_EMAIL, name: DEV_LOGIN_NAME },
  });
  expect(login.status).toBe(200);
  state.accessToken = String(login.json.accessToken);

  debugStep('seed: create project');
  const project = await callStudioRoute(studioModules.projects.POST!, {
    path: '/api/projects',
    token: state.accessToken,
    body: { name: PROJECT_NAME, description: 'E2E coverage for tool invocation paths' },
  });
  expect(project.status).toBe(201);
  state.projectId = String(project.json.project.id);
  state.tenantId = String(project.json.project.tenantId);

  const { Tenant } = await import('@agent-platform/database/models');
  await (Tenant as any).findOneAndUpdate(
    { _id: state.tenantId },
    { $set: { settings: { codeToolsEnabled: true } } },
    { new: true },
  );

  debugStep('seed: create config variables');
  const authProfileConfigVar = await callStudioRoute(studioModules.configVariables.POST!, {
    path: `/api/projects/${state.projectId}/config-variables`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      key: CONFIG_AUTH_PROFILE_VAR_KEY,
      value: AUTH_PROFILE_NAME,
      description: 'Auth profile indirection for tool invocation E2E coverage',
    },
  });
  expect(authProfileConfigVar.status).toBe(201);

  const oauthPreflightConfigVar = await callStudioRoute(studioModules.configVariables.POST!, {
    path: `/api/projects/${state.projectId}/config-variables`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      key: CONFIG_PREFLIGHT_AUTH_PROFILE_VAR_KEY,
      value: OAUTH_CONFIG_PREFLIGHT_PROFILE_NAME,
      description: 'Config-backed preflight auth profile for tool invocation E2E coverage',
    },
  });
  expect(oauthPreflightConfigVar.status).toBe(201);

  debugStep('seed: create tenant credential');
  const tenantCredential = await callStudioRoute(studioModules.tenantCredentials.POST!, {
    path: '/api/tenant-credentials',
    token: state.accessToken,
    body: {
      name: 'mock-openai-credential',
      provider: 'openai',
      apiKey: 'test-openai-key',
      endpoint: `http://127.0.0.1:${llmServerPort}/v1`,
      authType: 'api_key',
    },
  });
  expect(tenantCredential.status).toBe(201);
  state.tenantCredentialId = String(tenantCredential.json.id);

  debugStep('seed: create tenant model');
  const tenantModel = await callStudioRoute(studioModules.tenantModels.POST!, {
    path: '/api/tenant-models',
    token: state.accessToken,
    body: {
      displayName: 'mock-openai-model',
      integrationType: 'easy',
      provider: 'openai',
      modelId: LLM_MODEL_ID,
      isDefault: true,
      capabilities: ['text', 'tools'],
      useResponsesApi: false,
      useStreaming: false,
    },
  });
  expect(tenantModel.status).toBe(201);
  state.tenantModelId = String(tenantModel.json.model.id);

  debugStep('seed: connect tenant model');
  const tenantModelConnection = await callStudioRoute(studioModules.tenantModelConnections.POST!, {
    path: `/api/tenant-models/${state.tenantModelId}/connections`,
    token: state.accessToken,
    params: { id: state.tenantModelId },
    body: { credentialId: state.tenantCredentialId, isPrimary: true },
  });
  expect(tenantModelConnection.status).toBe(201);

  debugStep('seed: create auth profile');
  const authProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: AUTH_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'api_key',
      config: {
        headerName: AUTH_PROFILE_HEADER,
        placement: 'header',
        prefix: 'Token ',
      },
      secrets: {
        apiKey: AUTH_PROFILE_SECRET,
      },
    },
  });
  expect(authProfile.status).toBe(201);
  state.authProfileId = String(authProfile.json.data.id);

  debugStep('seed: create basic auth profile');
  const basicAuthProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: BASIC_AUTH_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'basic',
      config: {},
      secrets: {
        username: 'basic-user',
        password: 'basic-pass',
      },
    },
  });
  expect(basicAuthProfile.status).toBe(201);

  debugStep('seed: create custom header auth profile');
  const customHeaderProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: CUSTOM_HEADER_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'custom_header',
      config: {
        headers: {
          'X-Tenant-Key': 'X-Tenant-Key',
          'X-Org-Id': 'X-Org-Id',
        },
      },
      secrets: {
        headerValues: {
          'X-Tenant-Key': CUSTOM_HEADER_API_KEY,
          'X-Org-Id': CUSTOM_HEADER_ORG_ID,
        },
      },
    },
  });
  expect(customHeaderProfile.status).toBe(201);

  debugStep('seed: create aws iam auth profile');
  const awsIamProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: AWS_IAM_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'aws_iam',
      config: {
        region: 'us-east-1',
        service: 'execute-api',
      },
      secrets: {
        accessKeyId: 'AKIA_PHASE2_TEST',
        secretAccessKey: 'phase2-secret-key',
        sessionToken: 'phase2-session-token',
      },
    },
  });
  expect(awsIamProfile.status).toBe(201);

  // Defense-in-depth check: the AWS IAM Phase 2 schema requires both `region`
  // and `service`, so an incomplete profile must be rejected at the API
  // boundary — runtime never sees it. The runtime backstop is unit-tested
  // separately in apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts.
  debugStep('seed: incomplete aws iam profile is rejected at the schema layer');
  const incompleteAwsIamProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: AWS_IAM_INCOMPLETE_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'aws_iam',
      config: {
        region: 'us-east-1',
      },
      secrets: {
        accessKeyId: 'AKIA_PHASE2_INCOMPLETE',
        secretAccessKey: 'phase2-incomplete-secret',
      },
    },
  });
  expect(incompleteAwsIamProfile.status).toBe(400);

  debugStep('seed: create mtls auth profile');
  const mtlsProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: MTLS_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'mtls',
      config: {},
      secrets: {
        clientCert: MTLS_TEST_FIXTURES.clientCert,
        clientKey: MTLS_TEST_FIXTURES.clientKey,
        caCert: MTLS_TEST_FIXTURES.caCert,
      },
    },
  });
  expect(mtlsProfile.status).toBe(201);

  debugStep('seed: create oauth app auth profile');
  const oauthPreflightProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: OAUTH_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'personal',
      connectionMode: 'per_user',
      authType: 'oauth2_app',
      connector: 'mock_mail',
      config: {
        authorizationUrl: `http://127.0.0.1:${toolServerPort}/oauth/authorize`,
        tokenUrl: `http://127.0.0.1:${toolServerPort}/oauth/token`,
        defaultScopes: ['mail.read', 'mail.send'],
        scopeSeparator: ' ',
      },
      secrets: {
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
      },
    },
  });
  expect(oauthPreflightProfile.status).toBe(201);
  state.oauthPreflightProfileId = String(oauthPreflightProfile.json.data.id);

  debugStep('seed: create config-backed oauth app auth profile');
  const oauthConfigPreflightProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: OAUTH_CONFIG_PREFLIGHT_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'personal',
      connectionMode: 'per_user',
      authType: 'oauth2_app',
      connector: 'mock_mail',
      config: {
        authorizationUrl: `http://127.0.0.1:${toolServerPort}/oauth/authorize`,
        tokenUrl: `http://127.0.0.1:${toolServerPort}/oauth/token`,
        defaultScopes: ['mail.read', 'mail.send'],
        scopeSeparator: ' ',
      },
      secrets: {
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
      },
    },
  });
  expect(oauthConfigPreflightProfile.status).toBe(201);
  state.oauthConfigPreflightProfileId = String(oauthConfigPreflightProfile.json.data.id);

  debugStep('seed: create oauth2 client credentials auth profile');
  const clientCredentialsProfile = await callStudioRoute(studioModules.authProfiles.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: OAUTH_CLIENT_CREDENTIALS_PROFILE_NAME,
      projectId: state.projectId,
      scope: 'project',
      visibility: 'shared',
      authType: 'oauth2_client_credentials',
      config: {
        tokenUrl: `http://127.0.0.1:${toolServerPort}/oauth/token`,
        scopes: ['mail.read', 'mail.send'],
      },
      secrets: {
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
      },
    },
  });
  expect(clientCredentialsProfile.status).toBe(201);
  state.clientCredentialsProfileId = String(clientCredentialsProfile.json.data.id);

  debugStep('seed: create MCP server');
  const mcpServer = await callStudioRoute(studioModules.mcpServers.POST!, {
    path: `/api/projects/${state.projectId}/mcp-servers`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name: MCP_SERVER_NAME,
      description: 'Mock MCP customer directory',
      transport: 'http',
      url: `http://127.0.0.1:${mcpServerPort}/mcp`,
      authType: 'none',
    },
  });
  expect(mcpServer.status).toBe(201);
  state.mcpServerId = String(mcpServer.json.server.id);

  debugStep('seed: discover MCP tools');
  const mcpDiscovery = await callStudioRoute(studioModules.mcpServerToolsDiscover.POST!, {
    path: `/api/projects/${state.projectId}/mcp-servers/${state.mcpServerId}/tools/discover`,
    token: state.accessToken,
    params: { id: state.projectId, serverId: state.mcpServerId },
    body: {
      toolNames: [MCP_SERVER_TOOL_NAME],
    },
  });
  expect(mcpDiscovery.status).toBe(200);
  expect(mcpDiscovery.json.success).toBe(true);

  debugStep('seed: create project tools');
  state.toolIds.direct_nested_lookup = await createProjectTool({
    name: 'direct_nested_lookup',
    description: 'Direct execution coverage for nested parameter mapping',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/direct/{customerId}`,
    parameters: [
      { name: 'customerId', type: 'string', description: 'Customer identifier', required: true },
      { name: 'status', type: 'string', description: 'Lookup status', required: true },
      {
        name: 'filter',
        type: 'object',
        description: 'Nested filter payload',
        required: true,
        objectSchema: JSON.stringify({
          region: { type: 'string', description: 'Geographic region' },
          nested: { type: 'object', description: 'Nested options' },
        }),
      },
      { name: 'extra', type: 'string', description: 'Extra body value', required: false },
    ],
    queryParams: [{ key: 'status', value: '{{input.status}}' }],
    body: `{
  "filter": {{input.filter}},
  "extra": "{{input.extra}}"
}`,
    headers: [{ key: 'X-Filter-Snapshot', value: '{{input.filter}}' }],
  });

  state.toolIds.a2a_lookup = await createProjectTool({
    name: 'a2a_lookup',
    description: 'A2A lookup coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/a2a`,
    parameters: [{ name: 'ticketId', type: 'string', description: 'Ticket id', required: true }],
  });
  state.toolIds.agent_lookup = await createProjectTool({
    name: 'agent_lookup',
    description: 'Runtime agent lookup coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/agent`,
    parameters: [
      { name: 'customerId', type: 'string', description: 'Customer identifier', required: true },
    ],
  });
  state.toolIds.auth_profile_lookup = await createProjectTool({
    name: 'auth_profile_lookup',
    description: 'Auth profile execution coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/auth`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.basic_auth_lookup = await createProjectTool({
    name: 'basic_auth_lookup',
    description: 'Basic auth execution coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/basic`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.custom_header_lookup = await createProjectTool({
    name: 'custom_header_lookup',
    description: 'Custom header execution coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/custom-header`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.aws_sigv4_lookup = await createProjectTool({
    name: 'aws_sigv4_lookup',
    description: 'AWS IAM SigV4 execution coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/aws-sigv4`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  // aws_sigv4_incomplete_lookup is intentionally not created — its profile is
  // rejected at the schema layer (see seedApiState), so the tool would reference
  // a non-existent profile and the runtime path is unreachable through the API.
  state.toolIds.mtls_lookup = await createProjectTool({
    name: 'mtls_lookup',
    description: 'mTLS execution coverage',
    endpoint: `https://127.0.0.1:${mtlsServerPort}/records/mtls`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.mtls_plain_lookup = await createProjectTool({
    name: 'mtls_plain_lookup',
    description: 'mTLS plain-http failure coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/mtls-plain`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.remember_ticket = await createProjectTool({
    name: 'remember_ticket',
    description: 'Stores a ticket into session context',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/context/write`,
    parameters: [
      { name: 'customerId', type: 'string', description: 'Customer identifier', required: true },
    ],
  });
  state.toolIds.read_ticket_context = await createProjectTool({
    name: 'read_ticket_context',
    description: 'Reads session context into the request payload',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/context/read`,
    parameters: [],
    body: `{
  "context": {
    "last_ticket_id": "{{_context.last_ticket_id}}"
  }
}`,
  });
  state.toolIds.attachment_lookup = await createProjectTool({
    name: 'attachment_lookup',
    description: 'Attachment driven lookup coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/attachment`,
    parameters: [{ name: 'ticketId', type: 'string', description: 'Ticket id', required: true }],
  });
  state.toolIds.client_credentials_lookup = await createProjectTool({
    name: 'client_credentials_lookup',
    description: 'OAuth2 client credentials auth-profile coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/client-credentials`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.oauth_preflight_lookup = await createProjectTool({
    name: 'oauth_preflight_lookup',
    description: 'Preflight OAuth auth-profile coverage',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/oauth`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.jit_lookup = await createProjectTool({
    name: 'jit_lookup',
    description: 'JIT auth coverage for non-interactive channels',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/jit`,
    parameters: [{ name: 'lookupId', type: 'string', description: 'Lookup id', required: true }],
  });
  state.toolIds.secure_delete = await createProjectTool({
    name: 'secure_delete',
    description: 'Secure side-effecting tool requiring confirmation',
    endpoint: `http://127.0.0.1:${toolServerPort}/records/secure-delete`,
    parameters: [
      { name: 'ticketId', type: 'string', description: 'Record id', required: true },
      { name: 'reason', type: 'string', description: 'Deletion reason', required: true },
    ],
  });
  state.toolIds.sandbox_add = await createSandboxTool({
    name: 'sandbox_add',
    description: 'Sandbox code tool coverage',
    parameters: [
      { name: 'left', type: 'number', description: 'Left operand', required: true },
      { name: 'right', type: 'number', description: 'Right operand', required: true },
    ],
    code: `return {
  total: $left + $right,
  explanation: String($left) + ' + ' + String($right) + ' = ' + String($left + $right),
};`,
  });

  debugStep('seed: create agents');
  state.agentNames.a2a_agent = await createAgentWithDsl(
    'a2a_agent',
    `AGENT: a2a_agent
GOAL: "Handle A2A ticket requests"

TOOLS:
  a2a_lookup(ticketId: string) -> object
    description: "Look up a ticket from A2A"
`,
  );

  state.agentNames.agent_lookup_agent = await createAgentWithDsl(
    'agent_lookup_agent',
    `AGENT: agent_lookup_agent
GOAL: "Look up customer records with project tools"

TOOLS:
  agent_lookup(customerId: string) -> object
    description: "Look up a customer by id"
`,
  );

  state.agentNames.nested_params_agent = await createAgentWithDsl(
    'nested_params_agent',
    `AGENT: nested_params_agent
GOAL: "Exercise nested HTTP parameter mapping through agent chat"

TOOLS:
  direct_nested_lookup(customerId: string, status: string, filter: object, extra: string) -> object
    description: "Resolve nested HTTP parameters through the runtime tool pipeline"
`,
  );

  state.agentNames.auth_profile_agent = await createAgentWithDsl(
    'auth_profile_agent',
    `AGENT: auth_profile_agent
GOAL: "Run authenticated tool calls"

TOOLS:
  auth_profile_lookup(lookupId: string) -> object
    description: "Look up a protected record"
    auth_profile: "${AUTH_PROFILE_NAME}"
`,
  );

  state.agentNames.templated_auth_profile_agent = await createAgentWithDsl(
    'templated_auth_profile_agent',
    `AGENT: templated_auth_profile_agent
GOAL: "Resolve auth profiles through config variables"

TOOLS:
  auth_profile_lookup(lookupId: string) -> object
    description: "Look up a protected record through config-backed auth profile resolution"
    auth_profile: "{{config.${CONFIG_AUTH_PROFILE_VAR_KEY}}}"
`,
  );

  state.agentNames.basic_auth_agent = await createAgentWithDsl(
    'basic_auth_agent',
    `AGENT: basic_auth_agent
GOAL: "Exercise basic auth profile execution"

TOOLS:
  basic_auth_lookup(lookupId: string) -> object
    description: "Look up a record through a basic auth profile"
    auth_profile: "${BASIC_AUTH_PROFILE_NAME}"
`,
  );

  state.agentNames.custom_header_agent = await createAgentWithDsl(
    'custom_header_agent',
    `AGENT: custom_header_agent
GOAL: "Exercise custom header auth profile execution"

TOOLS:
  custom_header_lookup(lookupId: string) -> object
    description: "Look up a record through a custom header auth profile"
    auth_profile: "${CUSTOM_HEADER_PROFILE_NAME}"
`,
  );

  state.agentNames.aws_sigv4_agent = await createAgentWithDsl(
    'aws_sigv4_agent',
    `AGENT: aws_sigv4_agent
GOAL: "Exercise AWS IAM SigV4 execution"

TOOLS:
  aws_sigv4_lookup(lookupId: string) -> object
    description: "Look up a record through an AWS IAM auth profile"
    auth_profile: "${AWS_IAM_PROFILE_NAME}"
`,
  );

  // aws_sigv4_unsupported_agent is omitted — see comment on
  // state.toolIds.aws_sigv4_incomplete_lookup.
  state.agentNames.mtls_agent = await createAgentWithDsl(
    'mtls_agent',
    `AGENT: mtls_agent
GOAL: "Exercise mTLS execution"

TOOLS:
  mtls_lookup(lookupId: string) -> object
    description: "Look up a record through an mTLS auth profile"
    auth_profile: "${MTLS_PROFILE_NAME}"
`,
  );

  state.agentNames.mtls_plain_agent = await createAgentWithDsl(
    'mtls_plain_agent',
    `AGENT: mtls_plain_agent
GOAL: "Block mTLS on plain HTTP"

TOOLS:
  mtls_plain_lookup(lookupId: string) -> object
    description: "Attempt to use an mTLS auth profile on a plain HTTP endpoint"
    auth_profile: "${MTLS_PROFILE_NAME}"
`,
  );

  state.agentNames.templated_oauth_preflight_agent = await createAgentWithDsl(
    'templated_oauth_preflight_agent',
    `AGENT: templated_oauth_preflight_agent
GOAL: "Require OAuth consent through a config-backed auth profile reference"

TOOLS:
  oauth_preflight_lookup(lookupId: string) -> object
    description: "Look up a protected record after config-backed OAuth consent"
    auth_profile: "{{config.${CONFIG_PREFLIGHT_AUTH_PROFILE_VAR_KEY}}}"
    consent: preflight
    connection: per_user
`,
  );

  state.agentNames.client_credentials_agent = await createAgentWithDsl(
    'client_credentials_agent',
    `AGENT: client_credentials_agent
GOAL: "Execute service-authenticated tool calls"

TOOLS:
  client_credentials_lookup(lookupId: string) -> object
    description: "Look up a record with client credentials"
    auth_profile: "${OAUTH_CLIENT_CREDENTIALS_PROFILE_NAME}"
`,
  );

  state.agentNames.oauth_preflight_agent = await createAgentWithDsl(
    'oauth_preflight_agent',
    `AGENT: oauth_preflight_agent
GOAL: "Require OAuth consent before tool execution"

TOOLS:
  oauth_preflight_lookup(lookupId: string) -> object
    description: "Look up a protected record after OAuth consent"
    auth_profile: "${OAUTH_PROFILE_NAME}"
    consent: preflight
    connection: per_user
`,
  );

  state.agentNames.jit_auth_agent = await createAgentWithDsl(
    'jit_auth_agent',
    `AGENT: jit_auth_agent
GOAL: "Exercise JIT auth behavior on REST chat"

TOOLS:
  jit_lookup(lookupId: string) -> object
    description: "Look up a record that requires JIT auth"
    auth_profile: "missing_jit_profile"
    auth_jit: true
`,
  );

  state.agentNames.mcp_lookup_agent = await createAgentWithDsl(
    'mcp_lookup_agent',
    `AGENT: mcp_lookup_agent
GOAL: "Use discovered MCP tools from agent chat"

TOOLS:
  ${MCP_DISCOVERED_TOOL_NAME}(lookupId: string) -> object
    description: "Look up a customer through MCP"
`,
  );

  state.agentNames.sandbox_agent = await createAgentWithDsl(
    'sandbox_agent',
    `AGENT: sandbox_agent
GOAL: "Use code tools for calculations"

TOOLS:
  sandbox_add(left: number, right: number) -> object
    description: "Add two numbers in the sandbox"
`,
  );

  state.agentNames.secure_delete_agent = await createAgentWithDsl(
    'secure_delete_agent',
    `AGENT: secure_delete_agent
GOAL: "Require explicit confirmation for destructive tools"

TOOLS:
  secure_delete(ticketId: string, reason: string) -> object
    description: "Delete a record only after confirmation"
    confirm: always
    immutable: [ticketId]
`,
  );

  state.agentNames.context_agent = await createAgentWithDsl(
    'context_agent',
    `AGENT: context_agent
GOAL: "Remember and reuse tool results"

MEMORY:
  SESSION:
    - last_ticket_id

TOOLS:
  remember_ticket(customerId: string) -> object
    description: "Remember the latest ticket for a customer"
    store_result: false
    ON_RESULT:
      SET:
        last_ticket_id = result.ticketId

  read_ticket_context() -> object
    description: "Read the remembered ticket context"
    CONTEXT_ACCESS:
      READ: [last_ticket_id]
`,
  );

  state.agentNames.attachment_agent = await createAgentWithDsl(
    'attachment_agent',
    `AGENT: attachment_agent
GOAL: "Use uploaded attachment text to drive tool calls"

TOOLS:
  attachment_lookup(ticketId: string) -> object
    description: "Look up a ticket mentioned in an attachment"
`,
  );

  debugStep('seed: create A2A channel connection');
  const a2aConnection = await callRuntimeJson(
    `/api/projects/${state.projectId}/channel-connections`,
    {
      token: state.accessToken,
      body: {
        channel_type: 'a2a',
        display_name: 'tool-invocation-a2a',
        external_identifier: 'tool-invocation-a2a-connection',
        config: { a2aApiKey: A2A_API_KEY },
      },
    },
  );
  expect(a2aConnection.status).toBe(201);
  state.a2aConnectionId = String(a2aConnection.json.connection.id);
}

async function createProjectTool(params: {
  name: string;
  description: string;
  endpoint: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    objectSchema?: string;
  }>;
  queryParams?: Array<{ key: string; value: string }>;
  headers?: Array<{ key: string; value: string }>;
  body?: string;
}): Promise<string> {
  const result = await callStudioRoute(studioModules.tools.POST!, {
    path: `/api/projects/${state.projectId}/tools`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      toolType: 'http',
      name: params.name,
      description: params.description,
      parameters: params.parameters,
      returnType: 'object',
      endpoint: params.endpoint,
      method: 'POST',
      auth: 'none',
      headers: params.headers,
      queryParams: params.queryParams,
      body: params.body,
      bodyType: 'json',
      timeout: 10_000,
    },
  });
  expect(result.status).toBe(201);
  return String(result.json.tool.id);
}

async function createSandboxTool(params: {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    objectSchema?: string;
  }>;
  code: string;
}): Promise<string> {
  const result = await callStudioRoute(studioModules.tools.POST!, {
    path: `/api/projects/${state.projectId}/tools`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      toolType: 'sandbox',
      name: params.name,
      description: params.description,
      parameters: params.parameters,
      returnType: 'object',
      runtime: 'javascript',
      code: params.code,
      memoryMb: 128,
      timeout: 10_000,
    },
  });
  expect(result.status).toBe(201);
  return String(result.json.tool.id);
}

async function createAgentWithDsl(name: string, dslContent: string): Promise<string> {
  const agent = await callStudioRoute(studioModules.agents.POST!, {
    path: `/api/projects/${state.projectId}/agents`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      name,
      agentPath: `tool-invocations/${name}`,
      description: `${name} E2E agent`,
    },
  });
  expect(agent.status).toBe(201);

  const dslSave = await callStudioRoute(studioModules.agentDsl.PUT!, {
    path: `/api/projects/${state.projectId}/agents/${name}/dsl`,
    token: state.accessToken,
    params: { id: state.projectId, agentId: name },
    body: { dslContent },
  });
  expect(dslSave.status).toBe(200);

  return name;
}

async function completeOAuthConsentForSession(
  sessionId: string,
  authProfileId: string,
  displayName: string,
): Promise<{ authUrl: string; state: string }> {
  const consent = await callStudioRoute(studioModules.authProfileOauthUserConsent.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles/oauth/user-consent`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      connectorName: 'mock_mail',
      sessionId,
      authProfileId,
    },
  });
  expect(consent.status).toBe(200);
  expect(consent.json.success).toBe(true);

  const authUrl = String(consent.json.data.authUrl);
  const stateToken = String(consent.json.data.state);

  const callback = await callStudioRoute(studioModules.authProfileOauthCallback.POST!, {
    path: `/api/projects/${state.projectId}/auth-profiles/oauth/callback`,
    token: state.accessToken,
    params: { id: state.projectId },
    body: {
      code: OAUTH_CODE,
      state: stateToken,
      displayName,
    },
  });
  expect(callback.status).toBe(201);
  expect(callback.json.success).toBe(true);

  return { authUrl, state: stateToken };
}

async function callStudioRoute(
  handler: (request: NextRequest, context: RouteContext) => Promise<Response>,
  options: {
    path: string;
    token?: string;
    params?: Record<string, string>;
    body?: unknown;
    method?: 'GET' | 'POST' | 'PUT';
  },
): Promise<{ status: number; json: Record<string, any> }> {
  const method = options.method ?? inferMethodFromHandler(handler);
  const headers = new Headers();
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const request = new NextRequest(new URL(options.path, 'http://localhost:3000'), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  debugStep(`studio route: ${method} ${options.path}`);
  const response = await handler(request, {
    params: Promise.resolve(options.params ?? {}),
  });
  debugStep(`studio route complete: ${response.status} ${options.path}`);

  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
  };
}

function inferMethodFromHandler(
  handler: (request: NextRequest, context: RouteContext) => Promise<Response>,
): 'GET' | 'POST' | 'PUT' {
  if (handler === studioModules.tools.POST) return 'POST';
  if (handler === studioModules.toolTest.POST) return 'POST';
  if (handler === studioModules.agents.POST) return 'POST';
  if (handler === studioModules.agentDsl.PUT) return 'PUT';
  if (handler === studioModules.authProfiles.POST) return 'POST';
  if (handler === studioModules.authProfileOauthUserConsent.POST) return 'POST';
  if (handler === studioModules.authProfileOauthCallback.POST) return 'POST';
  if (handler === studioModules.devLogin.POST) return 'POST';
  if (handler === studioModules.configVariables.POST) return 'POST';
  if (handler === studioModules.mcpServers.POST) return 'POST';
  if (handler === studioModules.mcpServerToolsDiscover.POST) return 'POST';
  if (handler === studioModules.mcpServerToolTest.POST) return 'POST';
  if (handler === studioModules.projects.POST) return 'POST';
  if (handler === studioModules.tenantCredentials.POST) return 'POST';
  if (handler === studioModules.tenantModels.POST) return 'POST';
  if (handler === studioModules.tenantModelConnections.POST) return 'POST';
  return 'GET';
}

async function callRuntimeJson(
  path: string,
  options: {
    token: string;
    body?: unknown;
    method?: 'GET' | 'POST';
  },
): Promise<{ status: number; json: Record<string, any> }> {
  debugStep(`runtime request: ${options.method ?? 'POST'} ${path}`);
  const response = await fetch(`http://127.0.0.1:${runtimePort}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      'X-Tenant-Id': state.tenantId,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  debugStep(`runtime response: ${response.status} ${path}`);

  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
  };
}

async function uploadAttachment(params: {
  projectId: string;
  sessionId: string;
  token: string;
  filename: string;
  mimeType: string;
  content: string;
}): Promise<{ status: number; json: Record<string, any> }> {
  const form = new FormData();
  form.append('file', new Blob([params.content], { type: params.mimeType }), params.filename);

  const response = await fetch(
    `http://127.0.0.1:${runtimePort}/api/projects/${params.projectId}/sessions/${params.sessionId}/attachments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'X-Tenant-Id': state.tenantId,
      },
      body: form,
    },
  );

  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
  };
}

function findSingleToolRequest(route: string): MockToolRequest {
  const matches = mockToolRequests.filter((request) => request.route === route);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function findTraceEvent(
  events: Array<{ type: string; data: Record<string, unknown> }> | undefined,
  type: string,
): { type: string; data: Record<string, unknown> } | undefined {
  return events?.find((event) => event.type === type);
}

function extractA2AText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '';
  }

  const message = result as Record<string, unknown>;

  if (message.kind === 'message' && Array.isArray(message.parts)) {
    return message.parts
      .flatMap((part) => {
        if (part && typeof part === 'object' && (part as Record<string, unknown>).kind === 'text') {
          return [String((part as Record<string, unknown>).text ?? '')];
        }
        return [];
      })
      .join(' ');
  }

  if (Array.isArray(message.artifacts)) {
    return message.artifacts
      .flatMap((artifact) => {
        if (!artifact || typeof artifact !== 'object') {
          return [];
        }
        const parts = (artifact as Record<string, unknown>).parts;
        if (!Array.isArray(parts)) {
          return [];
        }
        return parts.flatMap((part) => {
          if (
            part &&
            typeof part === 'object' &&
            (part as Record<string, unknown>).kind === 'text'
          ) {
            return [String((part as Record<string, unknown>).text ?? '')];
          }
          return [];
        });
      })
      .join(' ');
  }

  return '';
}

function setTestEnvironment(params: {
  runtimePort: number;
  llmServerPort: number;
  multimodalServerPort: number;
  redisPort: number;
  mongoUri: string;
}): void {
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'test';
  process.env['HOST'] = '127.0.0.1';
  process.env['PORT'] = String(params.runtimePort);
  process.env['RUNTIME_URL'] = `http://127.0.0.1:${params.runtimePort}`;
  process.env['RUNTIME_BASE_URL'] = `http://127.0.0.1:${params.runtimePort}`;
  process.env['RUNTIME_PUBLIC_BASE_URL'] = `http://127.0.0.1:${params.runtimePort}`;
  process.env['FRONTEND_URL'] = 'http://127.0.0.1:5173';
  process.env['JWT_SECRET'] = 'tool-invocations-e2e-jwt-secret-0123456789';
  process.env['ENABLE_DEV_LOGIN'] = 'true';
  process.env['ENCRYPTION_ENABLED'] = 'true';
  process.env['ENCRYPTION_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['REDIS_ENABLED'] = 'true';
  process.env['REDIS_URL'] = `redis://127.0.0.1:${params.redisPort}`;
  process.env['FEATURE_LIVEKIT_ENABLED'] = 'false';
  process.env['MULTIMODAL_SERVICE_URL'] = `http://127.0.0.1:${params.multimodalServerPort}`;
  process.env['MONGODB_URL'] = params.mongoUri;
  process.env['MONGODB_DATABASE'] = 'tool_invocations_e2e';
  process.env['MONGODB_MANAGED'] = 'true';
  process.env['MONGODB_MIN_POOL_SIZE'] = '1';
  process.env['MONGODB_MAX_POOL_SIZE'] = '5';
  process.env['CLICKHOUSE_URL'] = '';
  process.env['EVENT_KAFKA_ENABLED'] = 'false';
  process.env['SANDBOX_BACKEND'] = 'mock';
  process.env['SMTP_PORT'] = '';
  process.env['EMAIL_FROM_ADDRESS'] = '';
  process.env['NEXT_PUBLIC_RUNTIME_URL'] = `http://127.0.0.1:${params.runtimePort}`;
  process.env['AUTH_SDK_SESSION_SIGNING_SECRET'] = 's'.repeat(64);
  process.env['AUTH_SDK_BOOTSTRAP_SIGNING_SECRET'] = 'b'.repeat(64);
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(
  url: string,
  child: ChildProcessWithoutNullStreams | null,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | null = null;
  let lastBody = '';

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Runtime process exited before health check passed (code=${child.exitCode})`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastStatus = response.status;
      lastBody = await response.text();
      debugStep(`health probe not ready yet: status=${response.status} body=${lastBody}`);
    } catch {
      // Retry until the server is ready.
    }
    await delay(250);
  }

  throw new Error(
    `Timed out waiting for health check: ${url}` +
      (lastStatus ? ` (last status ${String(lastStatus)} body=${lastBody})` : ''),
  );
}

function startRuntimeProcess(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [RUNTIME_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forwardOutput = (prefix: string, chunk: string | Buffer, useErrorStream = false) => {
    if (process.env['TOOL_INVOCATIONS_E2E_DEBUG'] !== 'true') {
      return;
    }
    const text = chunk.toString();
    const target = useErrorStream ? process.stderr : process.stdout;
    target.write(`[runtime:${prefix}] ${text}`);
  };

  child.stdout.on('data', (chunk) => {
    forwardOutput('stdout', chunk);
  });
  child.stderr.on('data', (chunk) => {
    forwardOutput('stderr', chunk, true);
  });
  child.on('exit', (code, signal) => {
    debugStep(`runtime process exited code=${String(code)} signal=${String(signal)}`);
  });

  return child as unknown as ChildProcessWithoutNullStreams;
}

async function stopRuntimeProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    }),
    delay(10_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

async function startMockToolServer(port: number): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  const recordRequest = (route: string, request: ExpressRequest) => {
    mockToolRequests.push({
      route,
      method: request.method,
      path: request.path,
      query: Object.fromEntries(
        Object.entries(request.query).map(([key, value]) => [key, String(value)]),
      ),
      headers: normalizeHeaders(request.headers),
      body: request.body,
    });
  };

  app.get('/oauth/authorize', (request: ExpressRequest, response: ExpressResponse) => {
    response.json({
      authorized: true,
      state: request.query['state'] ?? null,
      redirectUri: request.query['redirect_uri'] ?? null,
    });
  });

  app.post('/oauth/token', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('oauth-token', request);

    if (request.body?.grant_type === 'client_credentials') {
      response.json({
        access_token: OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'mail.read mail.send',
      });
      return;
    }

    response.json({
      access_token: OAUTH_ACCESS_TOKEN,
      refresh_token: 'oauth-refresh-token-xyz',
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'mail.read mail.send',
    });
  });

  app.post('/records/direct/:customerId', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('direct', request);
    response.json({
      route: 'direct',
      received: {
        params: request.params,
        query: request.query,
        headers: {
          'x-filter-snapshot': request.header('x-filter-snapshot'),
        },
        body: request.body,
      },
    });
  });

  app.post('/records/auth', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('auth', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized: request.header('x-service-api') === `Token ${AUTH_PROFILE_SECRET}`,
    });
  });

  app.post('/records/basic', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('basic', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized:
        request.header('authorization') ===
        `Basic ${Buffer.from('basic-user:basic-pass').toString('base64')}`,
    });
  });

  app.post('/records/custom-header', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('custom-header', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized:
        request.header('x-tenant-key') === CUSTOM_HEADER_API_KEY &&
        request.header('x-org-id') === CUSTOM_HEADER_ORG_ID,
    });
  });

  app.post('/records/aws-sigv4', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('aws-sigv4', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      signed: request.header('authorization')?.includes('AWS4-HMAC-SHA256') ?? false,
      amzDate: request.header('x-amz-date') ?? null,
      sessionToken: request.header('x-amz-security-token') ?? null,
    });
  });

  app.post(
    '/records/aws-sigv4-incomplete',
    (request: ExpressRequest, response: ExpressResponse) => {
      recordRequest('aws-sigv4-incomplete', request);
      response.json({
        lookupId: request.body?.lookupId ?? null,
        status: 'unexpected-aws-dispatch',
      });
    },
  );

  app.post('/records/client-credentials', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('client-credentials', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized:
        request.header('authorization') === `Bearer ${OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN}`,
    });
  });

  app.post('/records/oauth', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('oauth', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized: request.header('authorization') === `Bearer ${OAUTH_ACCESS_TOKEN}`,
    });
  });

  app.post('/records/agent', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('agent', request);
    response.json({
      customerId: request.body?.customerId ?? null,
      status: 'found',
    });
  });

  app.post('/records/context/write', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('context-write', request);
    response.json({
      ticketId: CONTEXT_TICKET_ID,
      status: 'saved',
    });
  });

  app.post('/records/context/read', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('context-read', request);
    response.json({
      ticketId: request.body?.context?.last_ticket_id ?? null,
      status: 'read',
    });
  });

  app.post('/records/attachment', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('attachment', request);
    response.json({
      ticketId: request.body?.ticketId ?? null,
      status: 'resolved',
    });
  });

  app.post('/records/a2a', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('a2a', request);
    response.json({
      ticketId: request.body?.ticketId ?? null,
      source: 'a2a',
    });
  });

  app.post('/records/jit', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('jit', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      status: 'unexpected-dispatch',
    });
  });

  app.post('/records/mtls-plain', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('mtls-plain', request);
    response.json({
      lookupId: request.body?.lookupId ?? null,
      status: 'unexpected-plain-http-dispatch',
    });
  });

  app.post('/records/secure-delete', (request: ExpressRequest, response: ExpressResponse) => {
    recordRequest('secure', request);
    response.json({
      deleted: true,
      ticketId: request.body?.ticketId ?? null,
      reason: request.body?.reason ?? null,
    });
  });

  return await listen(app, port);
}

async function startMockMutualTlsServer(port: number): Promise<HttpsServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/records/mtls', (request: ExpressRequest, response: ExpressResponse) => {
    const socket = request.socket as TLSSocket;
    const peerCertificate = socket.getPeerCertificate();

    mockToolRequests.push({
      route: 'mtls',
      method: request.method,
      path: request.path,
      query: Object.fromEntries(
        Object.entries(request.query).map(([key, value]) => [key, String(value)]),
      ),
      headers: normalizeHeaders(request.headers),
      body: request.body,
      tls: {
        authorized: socket.authorized,
        peerCommonName:
          typeof peerCertificate?.subject?.CN === 'string' ? peerCertificate.subject.CN : undefined,
      },
    });

    response.json({
      lookupId: request.body?.lookupId ?? null,
      authorized: socket.authorized,
      peerCommonName:
        typeof peerCertificate?.subject?.CN === 'string' ? peerCertificate.subject.CN : null,
    });
  });

  return await new Promise<HttpsServer>((resolve, reject) => {
    const server = createHttpsServer(
      {
        key: MTLS_TEST_FIXTURES.serverKey,
        cert: MTLS_TEST_FIXTURES.serverCert,
        ca: MTLS_TEST_FIXTURES.caCert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      app,
    );
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function startMockLLMServer(port: number): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/v1/chat/completions', (request: ExpressRequest, response: ExpressResponse) => {
    const body = request.body as Record<string, unknown>;
    mockLLMRequests.push({ body });
    const shouldStream = body.stream === true;

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
    const toolNames = new Set(
      (Array.isArray(body.tools) ? body.tools : [])
        .map((tool) => {
          if (!tool || typeof tool !== 'object') {
            return null;
          }
          const fn = (tool as Record<string, unknown>).function;
          if (!fn || typeof fn !== 'object') {
            return null;
          }
          return String((fn as Record<string, unknown>).name ?? '');
        })
        .filter(Boolean) as string[],
    );

    if (latestMessage?.role === 'tool') {
      const toolName = findLatestToolName(messages);
      const toolResult = extractLatestToolResult(latestMessage.content);
      const payload = makeOpenAITextResponse(
        buildFinalAssistantText(toolName, toolResult ?? undefined),
      );
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    const latestUserText =
      latestMessage?.role === 'user' ? extractTextContent(latestMessage.content) : '';

    if (toolNames.has('agent_lookup')) {
      const customerId = latestUserText.match(/customer-\d+/i)?.[0] ?? 'customer-7';
      const payload = makeOpenAIToolCallResponse('agent_lookup', { customerId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('direct_nested_lookup')) {
      const customerId = latestUserText.match(/customer-\d+/i)?.[0] ?? 'customer-9';
      const status = /inactive/i.test(latestUserText) ? 'inactive' : 'active';
      const payload = makeOpenAIToolCallResponse('direct_nested_lookup', {
        customerId,
        status,
        filter: {
          region: 'us-east',
          nested: { vip: true, tags: ['priority', 'renewal'] },
        },
        extra: 'runtime-agent',
      });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('auth_profile_lookup')) {
      const lookupId = latestUserText.match(/auth-\d+/i)?.[0] ?? 'auth-7';
      const payload = makeOpenAIToolCallResponse('auth_profile_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('basic_auth_lookup')) {
      const lookupId = latestUserText.match(/basic-\d+/i)?.[0] ?? BASIC_LOOKUP_ID;
      const payload = makeOpenAIToolCallResponse('basic_auth_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('custom_header_lookup')) {
      const lookupId = latestUserText.match(/custom-\d+/i)?.[0] ?? CUSTOM_HEADER_LOOKUP_ID;
      const payload = makeOpenAIToolCallResponse('custom_header_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('aws_sigv4_lookup')) {
      const lookupId = latestUserText.match(/aws-\d+/i)?.[0] ?? AWS_SIGV4_LOOKUP_ID;
      const payload = makeOpenAIToolCallResponse('aws_sigv4_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('mtls_lookup')) {
      const lookupId = latestUserText.match(/mtls-\d+/i)?.[0] ?? MTLS_LOOKUP_ID;
      const payload = makeOpenAIToolCallResponse('mtls_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('mtls_plain_lookup')) {
      const lookupId = latestUserText.match(/mtls-plain-\d+/i)?.[0] ?? MTLS_PLAIN_LOOKUP_ID;
      const payload = makeOpenAIToolCallResponse('mtls_plain_lookup', { lookupId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('client_credentials_lookup')) {
      const payload = makeOpenAIToolCallResponse('client_credentials_lookup', {
        lookupId: CLIENT_CREDENTIALS_LOOKUP_ID,
      });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('oauth_preflight_lookup')) {
      const payload = makeOpenAIToolCallResponse('oauth_preflight_lookup', {
        lookupId: OAUTH_LOOKUP_ID,
      });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('jit_lookup')) {
      const payload = makeOpenAIToolCallResponse('jit_lookup', { lookupId: JIT_LOOKUP_ID });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('sandbox_add') && /(add|sum|total|code tool)/i.test(latestUserText)) {
      const payload = makeOpenAIToolCallResponse('sandbox_add', { left: 20, right: 30 });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has(MCP_DISCOVERED_TOOL_NAME)) {
      const payload = makeOpenAIToolCallResponse(MCP_DISCOVERED_TOOL_NAME, {
        lookupId: MCP_LOOKUP_ID,
      });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('secure_delete')) {
      const ticketId = latestUserText.match(/DEL-\d+/i)?.[0] ?? SECURE_DELETE_ID;
      const payload = makeOpenAIToolCallResponse('secure_delete', {
        ticketId,
        reason: SECURE_DELETE_REASON,
      });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('read_ticket_context') && /context/i.test(latestUserText)) {
      const payload = makeOpenAIToolCallResponse('read_ticket_context', {});
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('remember_ticket') && /\bremember\b/i.test(latestUserText)) {
      const payload = makeOpenAIToolCallResponse('remember_ticket', { customerId: 'ctx-1' });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('attachment_lookup') && /(uploaded|attachment|note)/i.test(latestUserText)) {
      const ticketId = latestUserText.match(/TCK-\d+/)?.[0] ?? ATTACHMENT_TICKET_ID;
      const payload = makeOpenAIToolCallResponse('attachment_lookup', { ticketId });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    if (toolNames.has('a2a_lookup')) {
      const payload = makeOpenAIToolCallResponse('a2a_lookup', { ticketId: A2A_LOOKUP_ID });
      if (shouldStream) {
        writeOpenAIStreamingResponse(response, payload);
        return;
      }
      response.json(payload);
      return;
    }

    const payload = makeOpenAITextResponse('No tool call required.');
    if (shouldStream) {
      writeOpenAIStreamingResponse(response, payload);
      return;
    }
    response.json(payload);
  });

  return await listen(app, port);
}

async function startMockMcpServer(port: number): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', (request: ExpressRequest, response: ExpressResponse) => {
    const payload = request.body as Record<string, unknown>;
    const sessionId = String(request.header('mcp-session-id') ?? 'mock-mcp-session');
    const method = typeof payload.method === 'string' ? payload.method : '';

    if (method) {
      mockMcpRequests.push({
        method,
        params: payload.params,
        headers: normalizeHeaders(request.headers),
      });
    }

    response.setHeader('mcp-session-id', sessionId);

    if (typeof payload.id === 'undefined') {
      response.status(204).end();
      return;
    }

    switch (method) {
      case 'initialize':
        response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: '1.0.0',
            },
          },
        });
        return;

      case 'tools/list':
        response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            tools: [
              {
                name: MCP_SERVER_TOOL_NAME,
                description: 'Look up customers in the directory',
                inputSchema: {
                  type: 'object',
                  properties: {
                    lookupId: {
                      type: 'string',
                      description: 'Customer directory lookup id',
                    },
                  },
                  required: ['lookupId'],
                },
              },
            ],
          },
        });
        return;

      case 'tools/call': {
        const params =
          payload.params && typeof payload.params === 'object'
            ? (payload.params as Record<string, unknown>)
            : {};
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        const lookupId = String(args.lookupId ?? MCP_LOOKUP_ID);

        response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [
              {
                type: 'text',
                text: `MCP result for ${lookupId}`,
              },
            ],
          },
        });
        return;
      }

      case 'shutdown':
        response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {},
        });
        return;

      default:
        response.status(404).json({
          jsonrpc: '2.0',
          id: payload.id,
          error: {
            code: -32601,
            message: `Unsupported MCP method: ${method}`,
          },
        });
    }
  });

  app.delete('/mcp', (_request: ExpressRequest, response: ExpressResponse) => {
    response.status(204).end();
  });

  return await listen(app, port);
}

function resolveRedisServerBinary(): string {
  for (const candidate of REDIS_SERVER_BINARY_CANDIDATES) {
    if (!candidate.includes('/') || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('redis-server binary not found. Set REDIS_SERVER_BIN to a valid path.');
}

function startRedisProcess(port: number): ChildProcessWithoutNullStreams {
  const redisEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? REPO_ROOT,
  };

  if (process.env['TMPDIR']) {
    redisEnv['TMPDIR'] = process.env['TMPDIR'];
  }

  const child = spawn(
    resolveRedisServerBinary(),
    ['--save', '', '--appendonly', 'no', '--bind', '127.0.0.1', '--port', String(port)],
    {
      cwd: REPO_ROOT,
      env: redisEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  if (process.env['TOOL_INVOCATIONS_E2E_DEBUG'] === 'true') {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(`[redis:stdout] ${chunk.toString()}`);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[redis:stderr] ${chunk.toString()}`);
    });
  }

  return child;
}

async function waitForRedis(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (await pingRedis(port)) {
      return;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for Redis on port ${port}`);
}

async function pingRedis(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n');
    });
    socket.on('data', (chunk: Buffer | string) => {
      if (chunk.toString().includes('PONG')) {
        finish(true);
      }
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function stopRedisProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    }),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

async function startMockMultimodalServer(port: number): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/internal/attachments', async (request: ExpressRequest, response: ExpressResponse) => {
    try {
      const tenantId = String(request.header('x-tenant-id') ?? '');
      const projectId = String(request.header('x-project-id') ?? '');
      const parsed = await parseMultipartUpload(request);
      const attachmentId = `att-${++mockAttachmentCounter}`;
      const category = parsed.mimeType.startsWith('image/')
        ? 'image'
        : parsed.mimeType.startsWith('audio/')
          ? 'audio'
          : parsed.mimeType.startsWith('video/')
            ? 'video'
            : 'document';

      mockAttachments.set(attachmentId, {
        _id: attachmentId,
        tenantId,
        projectId,
        sessionId: parsed.fields.sessionId ?? '',
        originalFilename: parsed.filename,
        mimeType: parsed.mimeType,
        category,
        scanStatus: 'clean',
        processingStatus: 'completed',
        embeddingStatus: 'skipped',
        processedContent: category === 'document' ? parsed.buffer.toString('utf8') : null,
        processingError: null,
      });

      response.status(201).json({
        success: true,
        data: {
          attachmentId,
          status: 'completed',
        },
      });
    } catch (error) {
      response.status(500).json({
        success: false,
        error: {
          code: 'UPLOAD_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.get(
    '/internal/attachments/session/:sessionId',
    (request: ExpressRequest, response: ExpressResponse) => {
      const tenantId = String(request.header('x-tenant-id') ?? '');
      const attachments = [...mockAttachments.values()].filter(
        (attachment) =>
          attachment.sessionId === request.params.sessionId && attachment.tenantId === tenantId,
      );
      response.json({
        success: true,
        data: {
          attachments,
        },
      });
    },
  );

  app.get(
    '/internal/attachments/:attachmentId',
    (request: ExpressRequest, response: ExpressResponse) => {
      const tenantId = String(request.header('x-tenant-id') ?? '');
      const attachment = mockAttachments.get(request.params.attachmentId);
      if (!attachment || attachment.tenantId !== tenantId) {
        response
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Missing' } });
        return;
      }
      response.json({
        success: true,
        data: {
          attachment,
        },
      });
    },
  );

  app.get(
    '/internal/attachments/:attachmentId/url',
    (request: ExpressRequest, response: ExpressResponse) => {
      const tenantId = String(request.header('x-tenant-id') ?? '');
      const attachment = mockAttachments.get(request.params.attachmentId);
      if (!attachment || attachment.tenantId !== tenantId) {
        response
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Missing' } });
        return;
      }
      response.json({
        success: true,
        data: {
          url: `http://127.0.0.1:${port}/download/${attachment._id}`,
          expiresInSeconds: 3600,
        },
      });
    },
  );

  app.get(
    '/internal/attachments/:attachmentId/status',
    (request: ExpressRequest, response: ExpressResponse) => {
      const tenantId = String(request.header('x-tenant-id') ?? '');
      const attachment = mockAttachments.get(request.params.attachmentId);
      if (!attachment || attachment.tenantId !== tenantId) {
        response
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Missing' } });
        return;
      }
      response.json({
        success: true,
        data: {
          scanStatus: attachment.scanStatus,
          processingStatus: attachment.processingStatus,
          embeddingStatus: attachment.embeddingStatus,
        },
      });
    },
  );

  return await listen(app, port);
}

async function parseMultipartUpload(request: ExpressRequest): Promise<{
  filename: string;
  mimeType: string;
  buffer: Buffer;
  fields: Record<string, string>;
}> {
  return await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: request.headers });
    const chunks: Buffer[] = [];
    const fields: Record<string, string> = {};
    let filename = 'upload.bin';
    let mimeType = 'application/octet-stream';

    busboy.on('field', (name: string, value: string) => {
      fields[name] = value;
    });

    busboy.on(
      'file',
      (
        _name: string,
        stream: NodeJS.ReadableStream,
        info: { filename: string; mimeType: string },
      ) => {
        filename = info.filename;
        mimeType = info.mimeType || mimeType;
        stream.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
      },
    );

    busboy.on('finish', () => {
      resolve({
        filename,
        mimeType,
        buffer: Buffer.concat(chunks),
        fields,
      });
    });

    busboy.on('error', reject);
    request.pipe(busboy);
  });
}

function normalizeHeaders(headers: ExpressRequest['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        return [[key.toLowerCase(), value.join(', ')]];
      }
      if (typeof value === 'undefined') {
        return [];
      }
      return [[key.toLowerCase(), String(value)]];
    }),
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const record = part as Record<string, unknown>;
      if (record.type === 'text') {
        return String(record.text ?? '');
      }
      return '';
    })
    .join(' ');
}

function extractLatestToolResult(content: unknown): Record<string, unknown> | null {
  if (typeof content === 'string') {
    return parseToolResultRecord(content);
  }

  if (!Array.isArray(content)) {
    return parseToolResultRecord(content);
  }

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    const record = part as Record<string, unknown>;
    if (record.type !== 'tool-result') {
      const inlineResult = parseToolResultRecord(
        typeof record.text === 'string'
          ? record.text
          : typeof record.content === 'string'
            ? record.content
            : typeof record.value === 'string'
              ? record.value
              : null,
      );
      if (inlineResult) {
        return inlineResult;
      }
      continue;
    }

    const output = record.output;
    if (!output || typeof output !== 'object') {
      continue;
    }

    const value = (output as Record<string, unknown>).value;
    if (typeof value === 'string') {
      return parseToolResultRecord(value) ?? { value };
    }
    return parseToolResultRecord(value);
  }

  return null;
}

function parseToolResultRecord(value: unknown): Record<string, unknown> | null {
  let normalized: unknown = value;

  if (typeof normalized === 'string') {
    const parsed = safeJsonParse(normalized);
    if (parsed !== null) {
      return parseToolResultRecord(parsed);
    }
    return null;
  }

  if (Array.isArray(normalized)) {
    for (const entry of normalized) {
      const parsedEntry = parseToolResultRecord(entry);
      if (parsedEntry) {
        return parsedEntry;
      }
    }
    return null;
  }

  if (!normalized || typeof normalized !== 'object') {
    return null;
  }

  const record = normalized as Record<string, unknown>;

  if (record.type === 'tool-result') {
    const parsedOutput = parseToolResultRecord(record.output);
    if (parsedOutput) {
      return parsedOutput;
    }
  }

  for (const candidate of [record.output, record.result, record.content, record.value]) {
    const parsedCandidate = parseToolResultRecord(candidate);
    if (parsedCandidate) {
      return parsedCandidate;
    }
  }

  return record;
}

function findLatestToolName(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }
    const toolCalls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }
    const firstToolCall = toolCalls[0] as Record<string, unknown>;
    const fn = firstToolCall.function;
    if (fn && typeof fn === 'object') {
      return String((fn as Record<string, unknown>).name ?? '');
    }
  }
  return '';
}

function buildFinalAssistantText(toolName: string, toolResult?: Record<string, unknown>): string {
  switch (toolName) {
    case 'agent_lookup':
      return `Agent lookup complete for ${String(toolResult?.customerId ?? 'customer-7')}.`;
    case 'direct_nested_lookup':
      return 'Nested lookup complete.';
    case 'auth_profile_lookup':
      return 'Authenticated lookup complete.';
    case 'basic_auth_lookup':
      return 'Basic auth lookup complete.';
    case 'custom_header_lookup':
      return 'Custom header lookup complete.';
    case 'aws_sigv4_lookup':
      return 'AWS IAM lookup complete.';
    case 'mtls_lookup':
      return 'mTLS lookup complete.';
    case 'mtls_plain_lookup':
      return `mTLS plain lookup result: ${String(
        toolResult?.code ??
          (toolResult?.error && typeof toolResult.error === 'object' && 'code' in toolResult.error
            ? (toolResult.error as Record<string, unknown>).code
            : toolResult?.error) ??
          'unknown',
      )}.`;
    case 'client_credentials_lookup':
      return 'Client credentials lookup complete.';
    case 'oauth_preflight_lookup':
      return 'OAuth preflight lookup complete.';
    case 'jit_lookup':
      return `JIT auth handling result: ${String(
        toolResult?.code ??
          (toolResult?.error && typeof toolResult.error === 'object' && 'code' in toolResult.error
            ? (toolResult.error as Record<string, unknown>).code
            : toolResult?.error) ??
          'unknown',
      )}.`;
    case MCP_DISCOVERED_TOOL_NAME:
      return 'MCP lookup complete.';
    case 'sandbox_add':
      return `Sandbox total ${String(toolResult?.total ?? SANDBOX_TOTAL)}.`;
    case 'secure_delete':
      if (typeof toolResult?.error === 'string' && toolResult.error.length > 0) {
        return toolResult.error;
      }
      return `Secure delete complete for ${String(toolResult?.ticketId ?? SECURE_DELETE_ID)}.`;
    case 'remember_ticket':
      return 'I remembered the ticket.';
    case 'read_ticket_context':
      return `I used the remembered ticket context ${String(toolResult?.ticketId ?? CONTEXT_TICKET_ID)}.`;
    case 'attachment_lookup':
      return `Attachment lookup complete for ${String(toolResult?.ticketId ?? ATTACHMENT_TICKET_ID)}.`;
    case 'a2a_lookup':
      return 'A2A lookup complete.';
    default:
      return 'Tool call complete.';
  }
}

function makeOpenAIToolCallResponse(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `chatcmpl-tool-${name}`,
    object: 'chat.completion',
    created: Date.now(),
    model: LLM_MODEL_ID,
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${name}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function makeOpenAITextResponse(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-final',
    object: 'chat.completion',
    created: Date.now(),
    model: LLM_MODEL_ID,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function writeOpenAIStreamingResponse(
  response: ExpressResponse,
  payload: Record<string, unknown>,
): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  const id = String(payload.id ?? 'chatcmpl-stream');
  const created =
    typeof payload.created === 'number' ? payload.created : Math.floor(Date.now() / 1000);
  const model = String(payload.model ?? LLM_MODEL_ID);
  const firstChoice = Array.isArray(payload.choices)
    ? ((payload.choices[0] as Record<string, unknown> | undefined) ?? {})
    : {};
  const message =
    firstChoice.message && typeof firstChoice.message === 'object'
      ? (firstChoice.message as Record<string, unknown>)
      : {};
  const finishReason =
    typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : 'stop';
  const usage =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : undefined;
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : [];

  if (toolCalls.length > 0) {
    const initialToolCalls = toolCalls.map((toolCall, index) => {
      const fn =
        toolCall.function && typeof toolCall.function === 'object'
          ? (toolCall.function as Record<string, unknown>)
          : {};
      return {
        index,
        id: String(toolCall.id ?? `call-${index}`),
        type: 'function',
        function: {
          name: String(fn.name ?? ''),
          arguments: '',
        },
      };
    });

    writeSseData(response, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: '',
            tool_calls: initialToolCalls,
          },
          finish_reason: null,
        },
      ],
    });

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const toolCall = toolCalls[toolIndex];
      const fn =
        toolCall.function && typeof toolCall.function === 'object'
          ? (toolCall.function as Record<string, unknown>)
          : {};
      const args = String(fn.arguments ?? '');
      const argChunks = splitIntoChunks(args, 2);

      for (const argChunk of argChunks) {
        writeSseData(response, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    function: {
                      arguments: argChunk,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      }
    }

    writeSseData(response, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    });
    response.write('data: [DONE]\n\n');
    response.end();
    return;
  }

  const content = typeof message.content === 'string' ? message.content : '';
  const chunks = splitIntoChunks(content, 3);

  for (let index = 0; index < chunks.length; index += 1) {
    writeSseData(response, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta:
            index === 0
              ? {
                  role: 'assistant',
                  content: chunks[index],
                }
              : {
                  content: chunks[index],
                },
          finish_reason: null,
        },
      ],
    });
  }

  writeSseData(response, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function writeSseData(response: ExpressResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function splitIntoChunks(value: string, parts: number): string[] {
  if (value.length === 0) {
    return [''];
  }

  const chunkSize = Math.max(1, Math.ceil(value.length / parts));
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonLikeValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const parsed = safeJsonParse(value);
  return parsed ?? value;
}

async function listen(app: Express, port: number): Promise<HttpServer> {
  return await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function closeServer(server: CloseableServer | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
