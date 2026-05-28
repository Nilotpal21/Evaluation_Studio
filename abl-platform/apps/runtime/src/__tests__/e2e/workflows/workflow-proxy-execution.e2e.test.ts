/**
 * E2E: Workflow Proxy Execution Routes
 *
 * Exercises the runtime's workflow-engine-proxy through its real HTTP stack:
 *   POST /api/projects/:pid/workflows/:wfId/executions/execute  (execute workflow)
 *   GET  /api/projects/:pid/workflows/:wfId/executions          (list executions)
 *   GET  /api/projects/:pid/workflows/:wfId/executions/:execId  (get execution)
 *   POST /api/projects/:pid/workflows/:wfId/executions/:execId/cancel (cancel)
 *
 * Real components (NO mocks):
 * - Express server with full middleware chain (auth, RBAC, validation)
 * - MongoDB Memory Server for data persistence
 * - JWT-based auth via dev-login bootstrap
 * - Mock workflow engine: a real HTTP server on a random port, injected via
 *   WORKFLOW_ENGINE_URL before the runtime server loads
 *
 * Requires: mongodb-memory-server binary (downloaded on first run)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RuntimeApiHarness } from '../../helpers/runtime-api-harness.js';
import { startRuntimeServerHarness } from '../../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  authHeaders,
  requestJson,
  uniqueSlug,
  uniqueEmail,
  type BootstrapProjectResult,
} from '../../helpers/channel-e2e-bootstrap.js';
import {
  createMockWorkflowEngine,
  type MockWorkflowEngine,
} from '../../helpers/mock-workflow-engine.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

let harness: RuntimeApiHarness;
let mockEngine: MockWorkflowEngine;
let projectA: BootstrapProjectResult;

// ---------------------------------------------------------------------------
// Setup: start mock engine, then real runtime + MongoDB, bootstrap a project
// ---------------------------------------------------------------------------

beforeAll(async () => {
  mockEngine = createMockWorkflowEngine();
  await mockEngine.start();

  // Set BEFORE server loads so the proxy picks up the URL
  process.env.WORKFLOW_ENGINE_URL = mockEngine.baseUrl;

  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('proxy-exec'),
    uniqueSlug('tenant'),
    uniqueSlug('project'),
  );
}, SUITE_TIMEOUT_MS);

beforeEach(() => {
  mockEngine.reset();
});

afterAll(async () => {
  delete process.env.WORKFLOW_ENGINE_URL;
  if (harness) await harness.close();
  if (mockEngine) await mockEngine.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basePath(projectId: string): string {
  return `/api/projects/${projectId}/workflows`;
}

/**
 * Seed a minimal workflow via the CRUD API and return its ID.
 */
async function seedWorkflow(project: BootstrapProjectResult): Promise<string> {
  const res = await requestJson<{
    success: boolean;
    data: { id?: string; _id?: string };
  }>(harness, basePath(project.projectId), {
    method: 'POST',
    headers: authHeaders(project.token),
    body: {
      name: uniqueSlug('wf'),
      nodes: [
        { id: 'start-1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
        { id: 'end-1', nodeType: 'end', name: 'End', position: { x: 200, y: 0 }, config: {} },
      ],
      edges: [{ id: 'e1', source: 'start-1', target: 'end-1' }],
    },
  });

  expect(res.status).toBe(201);
  const workflowId = res.body.data?.id ?? res.body.data?._id;
  expect(workflowId).toBeTruthy();
  return workflowId!;
}

// ---------------------------------------------------------------------------
// E2E-PROXY-01: Execute Async — Happy Path
// ---------------------------------------------------------------------------

describe('E2E-PROXY-01: Execute workflow (async)', () => {
  let workflowId: string;

  test(
    'setup: seed a workflow',
    async () => {
      workflowId = await seedWorkflow(projectA);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute with ?mode=async returns 202 with executionId',
    async () => {
      const res = await requestJson<{
        success: boolean;
        executionId: string;
      }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`, {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { input: { key: 'value' } },
      });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.executionId).toBeTruthy();

      // Verify the mock engine received the request
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('POST');
      expect(engineReq.path).toContain(
        `/projects/${projectA.projectId}/workflows/${workflowId}/executions/execute`,
      );

      // Verify engine body contains expected fields
      const engineBody = engineReq.body as Record<string, unknown>;
      expect(engineBody.executionId).toBeTruthy();
      expect(engineBody.payload).toEqual({ key: 'value' });
      expect(engineBody.triggerType).toBe('studio');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'execute async forwards Authorization header to engine',
    async () => {
      await requestJson(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { input: {} },
        },
      );

      expect(mockEngine.lastRequest).not.toBeNull();
      const authHeader = mockEngine.lastRequest!.headers['authorization'];
      expect(authHeader).toBeTruthy();
      expect(String(authHeader)).toContain('Bearer ');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'execute async injects x-tenant-id header server-side',
    async () => {
      await requestJson(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { input: {} },
        },
      );

      expect(mockEngine.lastRequest).not.toBeNull();
      const tenantHeader = mockEngine.lastRequest!.headers['x-tenant-id'];
      expect(tenantHeader).toBe(projectA.tenantId);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-02: Execute — Validation Errors
// ---------------------------------------------------------------------------

describe('E2E-PROXY-02: Execute validation errors', () => {
  let workflowId: string;

  test(
    'setup: seed a workflow',
    async () => {
      workflowId = await seedWorkflow(projectA);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute with invalid mode returns 400 INVALID_MODE',
    async () => {
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=invalid`, {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { input: {} },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_MODE');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          body: { input: {} },
        },
      );

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute async_push without callbackUrl returns 400 MISSING_CALLBACK_URL',
    async () => {
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async_push`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { input: {} },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('MISSING_CALLBACK_URL');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute async_push with invalid callbackUrl returns 400 INVALID_CALLBACK_URL',
    async () => {
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async_push`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { input: {}, callbackUrl: 'not-a-url' },
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_CALLBACK_URL');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute with invalid executionId format returns 400 INVALID_EXECUTION_ID',
    async () => {
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`, {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { input: {}, executionId: 'not-a-uuid' },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_EXECUTION_ID');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-03: List / Get / Cancel proxying
// ---------------------------------------------------------------------------

describe('E2E-PROXY-03: List, Get, and Cancel executions proxy', () => {
  let workflowId: string;
  const fakeExecutionId = '00000000-0000-0000-0000-000000000001';

  test(
    'setup: seed a workflow',
    async () => {
      workflowId = await seedWorkflow(projectA);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /:workflowId/executions proxies to engine and returns 200',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: unknown[];
      }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received the GET request with correct path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toContain(
        `/projects/${projectA.projectId}/workflows/${workflowId}/executions`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /:workflowId/executions/:executionId proxies to engine and returns 200',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; workflowId: string; status: string };
      }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions/${fakeExecutionId}`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(fakeExecutionId);

      // Verify the mock engine received correct executionId
      expect(mockEngine.lastRequest).not.toBeNull();
      expect(mockEngine.lastRequest!.path).toContain(fakeExecutionId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /:workflowId/executions/:executionId/cancel proxies to engine and returns 200',
    async () => {
      const res = await requestJson<{
        success: boolean;
        message?: string;
      }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/${fakeExecutionId}/cancel`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received POST for cancel path
      expect(mockEngine.lastRequest).not.toBeNull();
      expect(mockEngine.lastRequest!.method).toBe('POST');
      expect(mockEngine.lastRequest!.path).toContain(`${fakeExecutionId}/cancel`);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-05: Version + Webhook Field Forwarding
// ---------------------------------------------------------------------------
//
// The proxy body-translation block used to build enginePayload with only
// { executionId, payload, triggerType, triggerMetadata }, silently dropping
// the four engine-schema fields below. These tests assert that each field
// now survives proxy translation, that the proxy does not invent them when
// absent, and that the type guards reject invalid values.
//
// IMPORTANT: This block runs BEFORE E2E-PROXY-04 because that suite stops
// and restarts the mock engine on a new port; the runtime's proxy caches
// `engineBase` at construction time and cannot pick up the new URL, so
// any test after E2E-PROXY-04 would hit a stale address.

describe('E2E-PROXY-05: Version and webhook field forwarding', () => {
  let workflowId: string;

  test(
    'setup: seed a workflow',
    async () => {
      workflowId = await seedWorkflow(projectA);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'forwards workflowVersionId and workflowVersion from body to engine',
    async () => {
      const res = await requestJson<{ success: boolean; executionId: string }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {
            input: { key: 'value' },
            workflowVersionId: 'wv-test-0001',
            workflowVersion: '1.4.2',
          },
        },
      );

      expect(res.status).toBe(202);
      expect(mockEngine.lastRequest).not.toBeNull();
      const engineBody = mockEngine.lastRequest!.body as Record<string, unknown>;
      expect(engineBody.workflowVersionId).toBe('wv-test-0001');
      expect(engineBody.workflowVersion).toBe('1.4.2');
      // Core fields still present
      expect(engineBody.payload).toEqual({ key: 'value' });
      expect(engineBody.triggerType).toBe('studio');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'forwards webhookMode and webhookDelivery from body to engine',
    async () => {
      const res = await requestJson<{ success: boolean; executionId: string }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {
            input: {},
            webhookMode: 'async',
            webhookDelivery: 'poll',
          },
        },
      );

      expect(res.status).toBe(202);
      expect(mockEngine.lastRequest).not.toBeNull();
      const engineBody = mockEngine.lastRequest!.body as Record<string, unknown>;
      expect(engineBody.webhookMode).toBe('async');
      expect(engineBody.webhookDelivery).toBe('poll');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'does not inject version or webhook fields when the client omits them',
    async () => {
      // Studio's `executeWorkflow()` client sends only { payload } — the engine
      // is expected to default to the active workflow version. The proxy must
      // not invent version/webhook fields when the client does not send them.
      const res = await requestJson<{ success: boolean; executionId: string }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { payload: { studioRun: true } },
        },
      );

      expect(res.status).toBe(202);
      expect(mockEngine.lastRequest).not.toBeNull();
      const engineBody = mockEngine.lastRequest!.body as Record<string, unknown>;
      expect(engineBody).not.toHaveProperty('workflowVersionId');
      expect(engineBody).not.toHaveProperty('workflowVersion');
      expect(engineBody).not.toHaveProperty('webhookMode');
      expect(engineBody).not.toHaveProperty('webhookDelivery');
      // Core fields are still forwarded (payload accepts `payload` for
      // back-compat; see proxy body-translation block).
      expect(engineBody.payload).toEqual({ studioRun: true });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'type guards reject invalid field types — does not forward non-string workflowVersionId or invalid enum webhookMode',
    async () => {
      const res = await requestJson<{ success: boolean; executionId: string }>(
        harness,
        `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {
            input: {},
            workflowVersionId: 12345, // not a string
            workflowVersion: { nested: 'object' }, // not a string
            webhookMode: 'invalid', // not in enum
            webhookDelivery: null, // not in enum
          },
        },
      );

      expect(res.status).toBe(202);
      expect(mockEngine.lastRequest).not.toBeNull();
      const engineBody = mockEngine.lastRequest!.body as Record<string, unknown>;
      // All four type-invalid fields should be stripped by the proxy's type
      // guards; the engine never sees them.
      expect(engineBody).not.toHaveProperty('workflowVersionId');
      expect(engineBody).not.toHaveProperty('workflowVersion');
      expect(engineBody).not.toHaveProperty('webhookMode');
      expect(engineBody).not.toHaveProperty('webhookDelivery');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-04: Engine Unreachable — 502
// ---------------------------------------------------------------------------

describe('E2E-PROXY-04: Engine unreachable returns 502', () => {
  let workflowId: string;

  test(
    'setup: seed a workflow while engine is running',
    async () => {
      workflowId = await seedWorkflow(projectA);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST execute returns 502 WORKFLOW_ENGINE_UNAVAILABLE when engine is down',
    async () => {
      // Stop the mock engine to simulate unreachability
      await mockEngine.close();

      try {
        const res = await requestJson<{
          success: boolean;
          error: { code: string; message: string };
        }>(harness, `${basePath(projectA.projectId)}/${workflowId}/executions/execute?mode=async`, {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: { input: { test: true } },
        });

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('WORKFLOW_ENGINE_UNAVAILABLE');
      } finally {
        // Restore the mock engine for subsequent tests (if any)
        await mockEngine.start();
        // Update env so any new proxy lookups get the fresh URL
        process.env.WORKFLOW_ENGINE_URL = mockEngine.baseUrl;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
