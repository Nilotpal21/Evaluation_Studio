/**
 * E2E: Workflow Trigger Proxy Routes
 *
 * Exercises the real runtime server's proxy layer for trigger management
 * requests. The runtime forwards these to the workflow-engine service;
 * a mock engine (real HTTP server on a random port) records every request
 * so we can assert correct path mapping, header forwarding, and body
 * passthrough.
 *
 * Trigger routes under `/api/projects/:projectId/workflows`:
 *   GET    /triggers                          List trigger registrations
 *   POST   /triggers                          Register a new trigger
 *   DELETE /triggers/:registrationId          Delete a trigger
 *   POST   /triggers/:registrationId/pause    Pause a trigger
 *   POST   /triggers/:registrationId/resume   Resume a trigger
 *   POST   /triggers/:registrationId/fire     Manually fire a trigger
 *
 * Real components (NO mocks):
 * - Express server with full middleware chain (auth, RBAC, validation)
 * - MongoDB Memory Server for data persistence
 * - JWT-based auth via dev-login bootstrap
 * - Mock workflow engine: a real Express HTTP server on a random port
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
  process.env.WORKFLOW_ENGINE_URL = mockEngine.baseUrl;

  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('proxy-trig'),
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

function triggerPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/workflows/triggers${suffix}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow Trigger Proxy Routes', () => {
  test(
    'GET /triggers proxies list request to engine with correct path',
    async () => {
      const res = await requestJson<{ success: boolean; data: unknown[] }>(
        harness,
        triggerPath(projectA.projectId),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received the request
      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('GET');
      expect(recorded.path).toBe(`/api/v1/projects/${projectA.projectId}/triggers`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers proxies register request with body to engine',
    async () => {
      const triggerBody = {
        workflowId: 'wf-abc-123',
        triggerType: 'webhook',
        config: { url: 'https://example.com/hook', method: 'POST' },
      };

      const res = await requestJson<{ success: boolean; data: Record<string, unknown> }>(
        harness,
        triggerPath(projectA.projectId),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: triggerBody,
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received the full body
      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('POST');
      expect(recorded.path).toBe(`/api/v1/projects/${projectA.projectId}/triggers`);
      expect(recorded.body).toEqual(triggerBody);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers forwards Authorization header to engine',
    async () => {
      await requestJson<{ success: boolean }>(harness, triggerPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { workflowId: 'wf-auth-check', triggerType: 'cron', config: {} },
      });

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.headers['authorization']).toBe(`Bearer ${projectA.token}`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'DELETE /triggers/:registrationId proxies delete to engine',
    async () => {
      const registrationId = 'reg-del-001';

      const res = await requestJson<{ success: boolean }>(
        harness,
        triggerPath(projectA.projectId, `/${registrationId}`),
        {
          method: 'DELETE',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('DELETE');
      expect(recorded.path).toBe(
        `/api/v1/projects/${projectA.projectId}/triggers/${registrationId}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers/:registrationId/pause proxies pause to engine',
    async () => {
      const registrationId = 'reg-pause-001';

      const res = await requestJson<{ success: boolean }>(
        harness,
        triggerPath(projectA.projectId, `/${registrationId}/pause`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('POST');
      expect(recorded.path).toBe(
        `/api/v1/projects/${projectA.projectId}/triggers/${registrationId}/pause`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers/:registrationId/resume proxies resume to engine',
    async () => {
      const registrationId = 'reg-resume-001';

      const res = await requestJson<{ success: boolean }>(
        harness,
        triggerPath(projectA.projectId, `/${registrationId}/resume`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('POST');
      expect(recorded.path).toBe(
        `/api/v1/projects/${projectA.projectId}/triggers/${registrationId}/resume`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers/:registrationId/fire proxies fire to engine',
    async () => {
      const registrationId = 'reg-fire-001';

      const res = await requestJson<{ success: boolean; data: { executionId: string } }>(
        harness,
        triggerPath(projectA.projectId, `/${registrationId}/fire`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.method).toBe('POST');
      expect(recorded.path).toBe(
        `/api/v1/projects/${projectA.projectId}/triggers/${registrationId}/fire`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /triggers without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, triggerPath(projectA.projectId), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      // Mock engine should NOT have received the request
      expect(mockEngine.requests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /triggers forwards query params to engine',
    async () => {
      const res = await requestJson<{ success: boolean; data: unknown[] }>(
        harness,
        triggerPath(projectA.projectId) + '?workflowId=xyz&status=active',
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.query['workflowId']).toBe('xyz');
      expect(recorded.query['status']).toBe('active');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /triggers/:registrationId/fire injects x-tenant-id header',
    async () => {
      const registrationId = 'reg-tenant-check';

      await requestJson<{ success: boolean }>(
        harness,
        triggerPath(projectA.projectId, `/${registrationId}/fire`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(mockEngine.requests).toHaveLength(1);
      const recorded = mockEngine.requests[0];
      expect(recorded.headers['x-tenant-id']).toBe(projectA.tenantId);
    },
    TEST_TIMEOUT_MS,
  );
});
