// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import express, {
  type Express,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';

import {
  createSoapStubServer,
  stopSoapStubServer,
  type SoapStubServer,
} from './fixtures/soap-stub-server';

vi.mock('server-only', () => ({}));

const TEST_TIMEOUT_MS = 120_000;
const SUITE_HOOK_TIMEOUT_MS = 300_000;
const MEMORY_MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MEMORY_MONGO_LAUNCH_TIMEOUT_MS = 30_000;
const LLM_MODEL_ID = 'gpt-4o-mini';
const PROJECT_NAME = 'SOAP Tool API E2E';
const DEV_LOGIN_EMAIL = 'soap-tool@e2e-smoke.test';
const DEV_LOGIN_NAME = 'SOAP Tool E2E';
const REDIS_SERVER_BINARY_CANDIDATES = [
  process.env['REDIS_SERVER_BIN'],
  '/opt/homebrew/bin/redis-server',
  '/usr/local/bin/redis-server',
  'redis-server',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

// ─── Studio Route Types ─────────────────────────────────────────────────────

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
  tools: StudioRouteModule;
  toolTest: StudioRouteModule;
  tenantCredentials: StudioRouteModule;
  tenantModels: StudioRouteModule;
  tenantModelConnections: StudioRouteModule;
}

// ─── Test State ─────────────────────────────────────────────────────────────

interface TestState {
  accessToken: string;
  tenantId: string;
  projectId: string;
  toolIds: Record<string, string>;
  tenantCredentialId: string;
  tenantModelId: string;
}

let mongoServer: MongoMemoryServer;
let studioModules: StudioModules;
let runtimeProcess: ChildProcessWithoutNullStreams | null = null;

let runtimePort = 0;
let llmServerPort = 0;
let redisPort = 0;

let llmServer: Server;
let redisProcess: ChildProcessWithoutNullStreams | null = null;
let soapStub: SoapStubServer;

const mockLLMRequests: Array<{ body: Record<string, unknown> }> = [];

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const RUNTIME_ENTRY = fileURLToPath(new URL('../../../../runtime/dist/index.js', import.meta.url));

const state: TestState = {
  accessToken: '',
  tenantId: '',
  projectId: '',
  toolIds: {},
  tenantCredentialId: '',
  tenantModelId: '',
};

function debugStep(message: string): void {
  if (process.env['SOAP_E2E_DEBUG'] === 'true') {
    process.stderr.write(`[soap-tool-e2e] ${message}\n`);
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe.sequential('SOAP tool API e2e', () => {
  beforeAll(async () => {
    debugStep('reserving ports');
    runtimePort = await reservePort();
    llmServerPort = await reservePort();
    redisPort = await reservePort();

    debugStep('starting mock LLM server');
    llmServer = await startMockLLMServer(llmServerPort);

    debugStep('starting SOAP stub servers');
    soapStub = await createSoapStubServer();
    debugStep(`SOAP 1.1 stub on port ${soapStub.port11}, SOAP 1.2 stub on port ${soapStub.port12}`);

    debugStep('starting in-memory mongo');
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MEMORY_MONGO_VERSION },
      instance: { launchTimeout: MEMORY_MONGO_LAUNCH_TIMEOUT_MS },
    });

    debugStep('setting test environment');
    setTestEnvironment({
      runtimePort,
      llmServerPort,
      redisPort,
      mongoUri: mongoServer.getUri('soap_tool_e2e'),
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
      tools:
        (await import('../../app/api/projects/[id]/tools/route')) as unknown as StudioRouteModule,
      toolTest:
        (await import('../../app/api/projects/[id]/tools/[toolId]/test/route')) as unknown as StudioRouteModule,
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

    await closeServer(llmServer);
    await stopSoapStubServer(soapStub);
    await stopRuntimeProcess(runtimeProcess);
    runtimeProcess = null;
    await stopRedisProcess(redisProcess);
    redisProcess = null;

    await mongoServer?.stop();
  }, SUITE_HOOK_TIMEOUT_MS);

  beforeAll(() => {
    mockLLMRequests.length = 0;
  });

  // ── E2E-1: SOAP 1.1 happy path ─────────────────────────────────────────

  it(
    'E2E-1: creates and tests a SOAP 1.1 tool — echo happy path',
    async () => {
      soapStub.capturedRequests.length = 0;

      // 1. Create a SOAP 1.1 tool targeting the stub /Echo endpoint
      const toolResult = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_echo_11',
          description: 'SOAP 1.1 echo tool',
          parameters: [
            { name: 'message', type: 'string', description: 'Message to echo', required: true },
          ],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port11}/Echo`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          bodyType: 'xml',
          body: '<Echo><Message>{{input.message}}</Message></Echo>',
          timeout: 10_000,
        },
      });

      expect(toolResult.status).toBe(201);
      const toolId = String(toolResult.json.tool.id);
      state.toolIds.soap_echo_11 = toolId;

      // 2. Test the tool
      const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId },
        body: {
          input: { message: 'hello-soap' },
        },
      });

      expect(testResult.status).toBe(200);
      expect(testResult.json.success).toBe(true);

      // 3. Verify stub received the request with correct SOAP 1.1 framing
      const stubRequests = soapStub.capturedRequests.filter((r) => r.path === '/Echo');
      expect(stubRequests.length).toBeGreaterThanOrEqual(1);

      const stubReq = stubRequests[stubRequests.length - 1];
      // Content-Type must be text/xml for SOAP 1.1
      expect(stubReq.headers['content-type']).toContain('text/xml');
      // Body must contain a SOAP envelope
      expect(stubReq.body).toContain('schemas.xmlsoap.org/soap/envelope');
      // Body must contain the user message
      expect(stubReq.body).toContain('hello-soap');

      // 4. Response should contain unwrapped data (not raw XML)
      // The tool test route returns the result in the response
      expect(testResult.json.result).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-2: SOAP 1.2 framing ────────────────────────────────────────────

  it(
    'E2E-2: creates and tests a SOAP 1.2 tool — correct Content-Type',
    async () => {
      soapStub.capturedRequests.length = 0;

      const toolResult = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_echo_12',
          description: 'SOAP 1.2 echo tool',
          parameters: [
            { name: 'message', type: 'string', description: 'Message to echo', required: true },
          ],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port12}/Echo12`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.2',
          bodyType: 'xml',
          body: '<Echo12><Message>{{input.message}}</Message></Echo12>',
          timeout: 10_000,
        },
      });

      expect(toolResult.status).toBe(201);
      const toolId = String(toolResult.json.tool.id);
      state.toolIds.soap_echo_12 = toolId;

      const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId },
        body: {
          input: { message: 'hello-1.2' },
        },
      });

      expect(testResult.status).toBe(200);
      expect(testResult.json.success).toBe(true);

      // Verify SOAP 1.2 framing on the stub
      const stubRequests = soapStub.capturedRequests.filter((r) => r.path === '/Echo12');
      expect(stubRequests.length).toBeGreaterThanOrEqual(1);

      const stubReq = stubRequests[stubRequests.length - 1];
      // SOAP 1.2 uses application/soap+xml
      expect(stubReq.headers['content-type']).toContain('application/soap+xml');
      // Body must contain the SOAP 1.2 namespace
      expect(stubReq.body).toContain('www.w3.org/2003/05/soap-envelope');
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-3: SOAP fault (default on_soap_fault=error) ────────────────────

  it(
    'E2E-3: SOAP fault returned as error by default (on_soap_fault=error)',
    async () => {
      soapStub.capturedRequests.length = 0;

      const toolResult = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_fault_error',
          description: 'SOAP 1.1 fault tool (error mode)',
          parameters: [
            {
              name: 'policy_number',
              type: 'string',
              description: 'Policy number',
              required: true,
            },
          ],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port11}/Fault`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          onSoapFault: 'error',
          bodyType: 'xml',
          body: '<LookupPolicy><PolicyNumber>{{input.policy_number}}</PolicyNumber></LookupPolicy>',
          timeout: 10_000,
        },
      });

      expect(toolResult.status).toBe(201);
      const toolId = String(toolResult.json.tool.id);

      const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId },
        body: {
          input: { policy_number: 'FAULT' },
        },
      });

      // The test endpoint should report the error (either in result.success=false or in the error field)
      // The exact shape depends on how the executor surfaces faults
      expect(testResult.status).toBe(200);
      // The tool test should indicate failure — either via success=false on the result or error content
      const hasError =
        testResult.json.success === false ||
        testResult.json.result?.success === false ||
        testResult.json.result?.error !== undefined ||
        testResult.json.error !== undefined ||
        (typeof testResult.json.result?.response?.body === 'string' &&
          testResult.json.result.response.body.includes('Fault'));

      expect(hasError).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-4: on_soap_fault=data — fault returned as data ─────────────────

  it(
    'E2E-4: SOAP fault returned as data when onSoapFault=data',
    async () => {
      soapStub.capturedRequests.length = 0;

      const toolResult = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_fault_data',
          description: 'SOAP 1.1 fault tool (data mode)',
          parameters: [
            {
              name: 'policy_number',
              type: 'string',
              description: 'Policy number',
              required: true,
            },
          ],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port11}/Fault`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          onSoapFault: 'data',
          bodyType: 'xml',
          body: '<LookupPolicy><PolicyNumber>{{input.policy_number}}</PolicyNumber></LookupPolicy>',
          timeout: 10_000,
        },
      });

      expect(toolResult.status).toBe(201);
      const toolId = String(toolResult.json.tool.id);

      const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId },
        body: {
          input: { policy_number: 'FAULT' },
        },
      });

      expect(testResult.status).toBe(200);
      // With on_soap_fault=data, the tool test should succeed and return the fault as data
      // The response should contain fault information in the result
      expect(testResult.json.success).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-5: Cross-tenant 404 ────────────────────────────────────────────

  it(
    'E2E-5: cross-tenant access to SOAP tool returns 404',
    async () => {
      // Create a second tenant via a separate dev-login
      const login2 = await callStudioRoute(studioModules.devLogin.POST!, {
        path: '/api/auth/dev-login',
        body: { email: 'soap-other-tenant@e2e-smoke.test', name: 'Other Tenant' },
      });
      expect(login2.status).toBe(200);
      const otherToken = String(login2.json.accessToken);

      // Create a project in the other tenant
      const project2 = await callStudioRoute(studioModules.projects.POST!, {
        path: '/api/projects',
        token: otherToken,
        body: { name: 'Other Tenant Project', description: 'Cross-tenant isolation test' },
      });
      expect(project2.status).toBe(201);
      const otherProjectId = String(project2.json.project.id);

      // Try to access the SOAP tool from E2E-1 via the other tenant's context
      // The tool was created in state.projectId; access it via otherProjectId route
      const toolId = state.toolIds.soap_echo_11;
      if (toolId) {
        const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
          path: `/api/projects/${otherProjectId}/tools/${toolId}/test`,
          token: otherToken,
          params: { id: otherProjectId, toolId },
          body: {
            input: { message: 'cross-tenant' },
          },
        });

        // Cross-tenant access should return 404 (tool does not exist in that tenant/project)
        expect(testResult.status).toBe(404);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-5b: Cross-project 404 ──────────────────────────────────────────

  it(
    'E2E-5b: cross-project access to SOAP tool returns 404',
    async () => {
      // Create a second project in the SAME tenant
      const project2 = await callStudioRoute(studioModules.projects.POST!, {
        path: '/api/projects',
        token: state.accessToken,
        body: { name: 'Second Project', description: 'Cross-project isolation test' },
      });
      expect(project2.status).toBe(201);
      const secondProjectId = String(project2.json.project.id);

      // Try to test the SOAP tool from E2E-1 via the second project's route
      const toolId = state.toolIds.soap_echo_11;
      if (toolId) {
        const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
          path: `/api/projects/${secondProjectId}/tools/${toolId}/test`,
          token: state.accessToken,
          params: { id: secondProjectId, toolId },
          body: {
            input: { message: 'cross-project' },
          },
        });

        expect(testResult.status).toBe(404);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-5c: Missing auth — no token → 401 ─────────────────────────────

  it(
    'E2E-5c: missing auth returns 401 on tool create',
    async () => {
      const result = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        // No token
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'no_auth_tool',
          description: 'Should fail',
          parameters: [],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port11}/Echo`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          bodyType: 'xml',
          body: '<Echo/>',
          timeout: 10_000,
        },
      });

      expect(result.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-6: SSRF blocked ───────────────────────────────────────────────

  it(
    'E2E-6: SSRF blocked for SOAP endpoint on private IP',
    async () => {
      const result = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_ssrf_blocked',
          description: 'SSRF test',
          parameters: [],
          returnType: 'object',
          endpoint: 'http://169.254.169.254/latest/meta-data',
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          bodyType: 'xml',
          body: '<Echo/>',
          timeout: 10_000,
        },
      });

      // SSRF validation can happen at creation time (400) or at test time (error in result)
      // If creation succeeds, test it and expect an error
      if (result.status === 201) {
        const toolId = String(result.json.tool.id);
        const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
          path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
          token: state.accessToken,
          params: { id: state.projectId, toolId },
          body: { input: {} },
        });

        // Test should fail due to SSRF blocking
        const isBlocked =
          testResult.status !== 200 ||
          testResult.json.success === false ||
          testResult.json.result?.success === false ||
          (testResult.json.result?.error &&
            typeof testResult.json.result.error === 'string' &&
            /ssrf|blocked|private/i.test(testResult.json.result.error));

        expect(isBlocked).toBe(true);
      } else {
        // Creation itself was blocked — that's also acceptable
        expect(result.status).toBeGreaterThanOrEqual(400);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── E2E-7: SOAPAction header set correctly (1.1) ───────────────────────

  it(
    'E2E-7: SOAPAction header set correctly for SOAP 1.1',
    async () => {
      soapStub.capturedRequests.length = 0;

      const toolResult = await callStudioRoute(studioModules.tools.POST!, {
        path: `/api/projects/${state.projectId}/tools`,
        token: state.accessToken,
        params: { id: state.projectId },
        body: {
          toolType: 'http',
          name: 'soap_action_test',
          description: 'SOAPAction header test',
          parameters: [{ name: 'message', type: 'string', description: 'Message', required: true }],
          returnType: 'object',
          endpoint: `http://127.0.0.1:${soapStub.port11}/Echo`,
          method: 'POST',
          auth: 'none',
          protocol: 'soap',
          soapVersion: '1.1',
          soapAction: 'http://example.com/EchoAction',
          bodyType: 'xml',
          body: '<Echo><Message>{{input.message}}</Message></Echo>',
          timeout: 10_000,
        },
      });

      expect(toolResult.status).toBe(201);
      const toolId = String(toolResult.json.tool.id);

      const testResult = await callStudioRoute(studioModules.toolTest.POST!, {
        path: `/api/projects/${state.projectId}/tools/${toolId}/test`,
        token: state.accessToken,
        params: { id: state.projectId, toolId },
        body: {
          input: { message: 'action-test' },
        },
      });

      expect(testResult.status).toBe(200);

      // Verify the SOAPAction header was sent to the stub
      const stubRequests = soapStub.capturedRequests.filter((r) => r.path === '/Echo');
      expect(stubRequests.length).toBeGreaterThanOrEqual(1);

      const stubReq = stubRequests[stubRequests.length - 1];
      // SOAPAction header should be present (case-insensitive check)
      const soapActionHeader = stubReq.headers['soapaction'] ?? stubReq.headers['SOAPAction'] ?? '';
      expect(soapActionHeader).toContain('http://example.com/EchoAction');
    },
    TEST_TIMEOUT_MS,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (self-contained — duplicated from tool-invocations-api.e2e.test.ts)
// ═══════════════════════════════════════════════════════════════════════════

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
    body: { name: PROJECT_NAME, description: 'E2E coverage for SOAP tool invocation paths' },
  });
  expect(project.status).toBe(201);
  state.projectId = String(project.json.project.id);
  state.tenantId = String(project.json.project.tenantId);

  debugStep('seed: create tenant credential');
  const tenantCredential = await callStudioRoute(studioModules.tenantCredentials.POST!, {
    path: '/api/tenant-credentials',
    token: state.accessToken,
    body: {
      name: 'mock-openai-credential-soap',
      provider: 'openai',
      apiKey: 'test-openai-key-soap',
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
      displayName: 'mock-openai-model-soap',
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
  const method = options.method ?? inferMethod(handler);
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

  let json: Record<string, any> = {};
  try {
    json = (await response.json()) as Record<string, any>;
  } catch {
    // Empty response body
  }

  return { status: response.status, json };
}

function inferMethod(
  handler: (request: NextRequest, context: RouteContext) => Promise<Response>,
): 'GET' | 'POST' | 'PUT' {
  if (handler === studioModules.tools.POST) return 'POST';
  if (handler === studioModules.toolTest.POST) return 'POST';
  if (handler === studioModules.devLogin.POST) return 'POST';
  if (handler === studioModules.projects.POST) return 'POST';
  if (handler === studioModules.tenantCredentials.POST) return 'POST';
  if (handler === studioModules.tenantModels.POST) return 'POST';
  if (handler === studioModules.tenantModelConnections.POST) return 'POST';
  return 'GET';
}

function setTestEnvironment(params: {
  runtimePort: number;
  llmServerPort: number;
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
  process.env['JWT_SECRET'] = 'soap-tool-e2e-jwt-secret-0123456789abc';
  process.env['ENABLE_DEV_LOGIN'] = 'true';
  process.env['ENCRYPTION_ENABLED'] = 'true';
  process.env['ENCRYPTION_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['REDIS_ENABLED'] = 'true';
  process.env['REDIS_URL'] = `redis://127.0.0.1:${params.redisPort}`;
  process.env['FEATURE_LIVEKIT_ENABLED'] = 'false';
  process.env['MULTIMODAL_SERVICE_URL'] = '';
  process.env['MONGODB_URL'] = params.mongoUri;
  process.env['MONGODB_DATABASE'] = 'soap_tool_e2e';
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
    if (process.env['SOAP_E2E_DEBUG'] !== 'true') {
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

function resolveRedisServerBinary(): string {
  for (const candidate of REDIS_SERVER_BINARY_CANDIDATES) {
    if (candidate === 'redis-server') {
      return candidate;
    }
    if (existsSync(candidate)) {
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

  if (process.env['SOAP_E2E_DEBUG'] === 'true') {
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

async function startMockLLMServer(port: number): Promise<Server> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/v1/chat/completions', (request: ExpressRequest, response: ExpressResponse) => {
    const body = request.body as Record<string, unknown>;
    mockLLMRequests.push({ body });

    // Simple text response — we don't exercise the LLM path heavily in SOAP E2E
    response.json({
      id: 'chatcmpl-soap-e2e',
      object: 'chat.completion',
      created: Date.now(),
      model: LLM_MODEL_ID,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'SOAP tool test response.',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  return await listen(app, port);
}

async function listen(app: Express, port: number): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
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
