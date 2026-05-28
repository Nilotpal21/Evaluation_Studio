/**
 * E2E: Workflow Proxy Admin Routes (Approvals, Notifications, Connectors)
 *
 * Exercises the runtime's workflow-engine-proxy through its real HTTP stack:
 *
 * Approvals:
 *   GET  /api/projects/:pid/workflows/approvals
 *   POST /api/projects/:pid/workflows/approvals/:wfId/executions/:execId/steps/:stepId/approve
 *   POST /api/projects/:pid/workflows/:wfId/executions/:execId/steps/:stepId/approve (alternate)
 *
 * Notification Rules:
 *   GET    /api/projects/:pid/workflows/:wfId/notifications
 *   POST   /api/projects/:pid/workflows/:wfId/notifications
 *   PUT    /api/projects/:pid/workflows/:wfId/notifications/:ruleId
 *   DELETE /api/projects/:pid/workflows/:wfId/notifications/:ruleId
 *   POST   /api/projects/:pid/workflows/:wfId/notifications/:ruleId/test
 *
 * Connector Catalog:
 *   GET /api/projects/:pid/workflows/connectors
 *   GET /api/projects/:pid/workflows/connectors/:connectorName
 *   GET /api/projects/:pid/workflows/connectors/:connectorName/actions
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
    uniqueEmail('proxy-admin'),
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

// Fake IDs — no real workflow needed since the mock engine handles all requests
const WORKFLOW_ID = 'wf-test-123';
const EXECUTION_ID = 'exec-test-456';
const STEP_ID = 'step-test-789';
const RULE_ID = 'rule-test-001';

// ---------------------------------------------------------------------------
// E2E-PROXY-ADM-01: Approvals
// ---------------------------------------------------------------------------

describe('Approvals', () => {
  test(
    'GET /approvals returns 200 and proxies to engine',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: unknown[];
      }>(harness, `${basePath(projectA.projectId)}/approvals`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      // Verify the mock engine received the GET request with correct path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe(`/api/v1/projects/${projectA.projectId}/approvals`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST approve (canonical path) proxies to engine with body',
    async () => {
      const approveBody = { approved: true, reason: 'looks good' };
      const res = await requestJson<{
        success: boolean;
      }>(
        harness,
        `${basePath(projectA.projectId)}/approvals/${WORKFLOW_ID}/executions/${EXECUTION_ID}/steps/${STEP_ID}/approve`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: approveBody,
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received the correct path and body
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('POST');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/approvals/${WORKFLOW_ID}/executions/${EXECUTION_ID}/steps/${STEP_ID}/approve`,
      );
      expect(engineReq.body).toEqual(approveBody);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST approve (alternate path — Studio turbopack workaround) proxies to same engine path',
    async () => {
      const approveBody = { approved: false, reason: 'needs revision' };
      const res = await requestJson<{
        success: boolean;
      }>(
        harness,
        `${basePath(projectA.projectId)}/${WORKFLOW_ID}/executions/${EXECUTION_ID}/steps/${STEP_ID}/approve`,
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: approveBody,
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the engine receives the same canonical approve path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('POST');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/approvals/${WORKFLOW_ID}/executions/${EXECUTION_ID}/steps/${STEP_ID}/approve`,
      );
      expect(engineReq.body).toEqual(approveBody);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /approvals without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, `${basePath(projectA.projectId)}/approvals`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-ADM-02: Notification Rules
// ---------------------------------------------------------------------------

describe('Notification Rules', () => {
  test(
    'GET /:workflowId/notifications returns 200 and proxies to engine',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: unknown[];
      }>(harness, `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      // Verify the mock engine received the correct path with workflowId
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/workflows/${WORKFLOW_ID}/notifications`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /:workflowId/notifications creates a notification rule',
    async () => {
      const ruleBody = { event: 'step_failed', channels: ['email'] };
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; event: string; channels: string[] };
      }>(harness, `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications`, {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: ruleBody,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe('mock-rule-id');
      expect(res.body.data.event).toBe('step_failed');

      // Verify the mock engine received POST with the correct body
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('POST');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/workflows/${WORKFLOW_ID}/notifications`,
      );
      expect(engineReq.body).toEqual(ruleBody);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PUT /:workflowId/notifications/:ruleId updates a notification rule',
    async () => {
      const updateBody = { event: 'step_completed', channels: ['slack', 'email'] };
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; event: string; channels: string[] };
      }>(harness, `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications/${RULE_ID}`, {
        method: 'PUT',
        headers: authHeaders(projectA.token),
        body: updateBody,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(RULE_ID);

      // Verify the mock engine received PUT with the correct path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('PUT');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/workflows/${WORKFLOW_ID}/notifications/${RULE_ID}`,
      );
      expect(engineReq.body).toEqual(updateBody);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'DELETE /:workflowId/notifications/:ruleId deletes a notification rule',
    async () => {
      const res = await requestJson<{
        success: boolean;
      }>(harness, `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications/${RULE_ID}`, {
        method: 'DELETE',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received DELETE with the correct path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('DELETE');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/workflows/${WORKFLOW_ID}/notifications/${RULE_ID}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /:workflowId/notifications/:ruleId/test tests a notification rule',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { delivered: boolean };
      }>(harness, `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications/${RULE_ID}/test`, {
        method: 'POST',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.delivered).toBe(true);

      // Verify the mock engine received POST to the test path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('POST');
      expect(engineReq.path).toBe(
        `/api/v1/projects/${projectA.projectId}/workflows/${WORKFLOW_ID}/notifications/${RULE_ID}/test`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /:workflowId/notifications without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(
        harness,
        `${basePath(projectA.projectId)}/${WORKFLOW_ID}/notifications`,
        {
          method: 'POST',
          body: { event: 'step_failed', channels: ['email'] },
        },
      );

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-ADM-03: Connector Catalog
// ---------------------------------------------------------------------------

describe('Connector Catalog', () => {
  test(
    'GET /connectors returns 200 with connector list from engine',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{ name: string; displayName: string; description: string }>;
      }>(harness, `${basePath(projectA.projectId)}/connectors`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].name).toBe('slack');
      expect(res.body.data[1].name).toBe('github');

      // Verify the mock engine received the GET request
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe('/api/v1/connectors');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /connectors/:connectorName returns connector detail',
    async () => {
      const connectorName = 'slack';
      const res = await requestJson<{
        success: boolean;
        data: { name: string; displayName: string; actions: unknown[] };
      }>(harness, `${basePath(projectA.projectId)}/connectors/${connectorName}`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe(connectorName);

      // Verify the mock engine received the correct connectorName in path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe(`/api/v1/connectors/${connectorName}`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /connectors/:connectorName/actions returns actions list',
    async () => {
      const connectorName = 'github';
      const res = await requestJson<{
        success: boolean;
        data: Array<{ name: string; displayName: string }>;
      }>(harness, `${basePath(projectA.projectId)}/connectors/${connectorName}/actions`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].name).toBe('send_message');
      expect(res.body.data[1].name).toBe('list_channels');

      // Verify the mock engine received the correct path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe(`/api/v1/connectors/${connectorName}/actions`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /connectors forwards query params to engine',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: unknown[];
      }>(harness, `${basePath(projectA.projectId)}/connectors?category=messaging&limit=10`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the mock engine received the query string
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.query).toEqual({ category: 'messaging', limit: '10' });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /connectors without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(
        harness,
        `${basePath(projectA.projectId)}/connectors`,
        {
          method: 'GET',
        },
      );

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-PROXY-ADM-04: Trigger Catalog (closes GAP-A)
// ---------------------------------------------------------------------------
//
// The engine exposes the trigger catalog at /api/v1/connectors/triggers/catalog
// (registry-wide, not project-scoped). The runtime proxy forwards
// /api/projects/:pid/workflows/triggers/catalog to that engine path so Studio
// can call it with JWT-based project permission checks.
//
// NOTE: at the time of writing, the Studio component `ExternalAppCatalog.tsx`
// still calls the (unwired) path `/api/connectors/triggers/catalog`. That
// component is currently unused; updating the call site is a follow-up.

describe('Trigger Catalog', () => {
  test(
    'GET /triggers/catalog returns catalog from engine',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{
          name: string;
          displayName: string;
          triggers: Array<{ name: string; strategy: string }>;
        }>;
      }>(harness, `${basePath(projectA.projectId)}/triggers/catalog`, {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      const slack = res.body.data.find((c) => c.name === 'slack');
      expect(slack).toBeTruthy();
      expect(slack!.triggers[0].name).toBe('new_message');

      // Verify the proxy hit the non-project-scoped engine path
      expect(mockEngine.requests).toHaveLength(1);
      const engineReq = mockEngine.lastRequest!;
      expect(engineReq.method).toBe('GET');
      expect(engineReq.path).toBe('/api/v1/connectors/triggers/catalog');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /triggers/catalog forwards query params to engine',
    async () => {
      await requestJson<{ success: boolean; data: unknown[] }>(
        harness,
        `${basePath(projectA.projectId)}/triggers/catalog?category=messaging&limit=5`,
        { method: 'GET', headers: authHeaders(projectA.token) },
      );

      expect(mockEngine.lastRequest).not.toBeNull();
      expect(mockEngine.lastRequest!.query).toMatchObject({
        category: 'messaging',
        limit: '5',
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /triggers/catalog without auth returns 401',
    async () => {
      const res = await requestJson<unknown>(
        harness,
        `${basePath(projectA.projectId)}/triggers/catalog`,
        { method: 'GET' },
      );
      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /triggers/catalog is not captured by /triggers/:registrationId (route ordering)',
    async () => {
      // If /:registrationId were matched first, the engine would see a DELETE
      // or 'catalog' as a registrationId. We're asserting route-ordering via a
      // GET here — GET /triggers/:registrationId does not exist, so a route-
      // ordering bug would surface as a 404 at the proxy layer. This test
      // guards against accidental regression when /triggers/:id getters are
      // added in the future.
      const res = await requestJson<{ success: boolean }>(
        harness,
        `${basePath(projectA.projectId)}/triggers/catalog`,
        { method: 'GET', headers: authHeaders(projectA.token) },
      );
      expect(res.status).toBe(200);
      expect(mockEngine.lastRequest!.path).toBe('/api/v1/connectors/triggers/catalog');
    },
    TEST_TIMEOUT_MS,
  );
});
