/**
 * E2E: Human Task Resolve & Associate-Session
 *
 * Exercises the human task resolve and workflow associate-session routes
 * through the real runtime HTTP stack with a mock workflow engine:
 *
 *   POST /api/projects/:pid/human-tasks/:taskId/resolve  (resolve task upstream)
 *   GET  /api/projects/:pid/human-tasks/:taskId           (verify task status)
 *   POST /api/projects/:pid/workflows/:wfId/associate-session (link to session)
 *
 * Real components (NO mocks):
 * - Express server with full middleware chain (auth, RBAC, validation)
 * - MongoDB Memory Server for data persistence
 * - JWT-based auth via dev-login bootstrap
 * - Mock workflow engine: a real HTTP server on a random port, injected via
 *   WORKFLOW_ENGINE_URL before the runtime server loads
 *
 * Human tasks are seeded directly via the Mongoose model because the
 * workflow-engine (which normally creates tasks during execution) is a
 * separate service. This follows the same pattern as workflow-crud.e2e.test.ts.
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
import { HumanTask } from '@agent-platform/database/models';

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

  // Set BEFORE server loads so the resolve dispatch picks up the URL
  process.env.WORKFLOW_ENGINE_URL = mockEngine.baseUrl;

  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('ht-resolve'),
    uniqueSlug('tenant'),
    uniqueSlug('project'),
  );
}, SUITE_TIMEOUT_MS);

beforeEach(async () => {
  mockEngine.reset();
  await HumanTask.deleteMany({ tenantId: projectA.tenantId });
});

afterAll(async () => {
  delete process.env.WORKFLOW_ENGINE_URL;
  if (harness) await harness.close();
  if (mockEngine) await mockEngine.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanTaskPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/human-tasks${suffix}`;
}

function workflowPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/workflows${suffix}`;
}

// ---------------------------------------------------------------------------
// Resolve workflow_approval
// ---------------------------------------------------------------------------

describe('Resolve workflow_approval', () => {
  test(
    'approved decision resolves task and dispatches to mock engine',
    async () => {
      // Seed a workflow_approval task
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        title: 'Approve deployment',
        description: 'Review and approve production deployment',
        type: 'approval',
        priority: 'high',
        status: 'pending',
        source: {
          type: 'workflow_approval',
          workflowId: 'wf-approval-001',
          executionId: 'exec-approval-001',
          stepId: 'step-approval-001',
        },
        fields: [],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      const taskId = task._id;

      // POST resolve with approved decision
      const resolveRes = await requestJson<{
        success: boolean;
        data: { taskId: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          decision: 'approved',
          notes: 'Looks good for production',
        },
      });

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.success).toBe(true);
      expect(resolveRes.body.data.status).toBe('completed');

      // Verify mock engine received the approval call
      expect(mockEngine.requests.length).toBeGreaterThanOrEqual(1);
      const approvalReq = mockEngine.requests.find((r) => r.path.includes('/approve'));
      expect(approvalReq).toBeDefined();
      expect(approvalReq!.method).toBe('POST');
      expect(approvalReq!.path).toContain(
        '/executions/exec-approval-001/steps/step-approval-001/approve',
      );
      expect(approvalReq!.body).toMatchObject({
        decision: 'approve',
        reason: 'Looks good for production',
      });

      // Verify task status changed to completed via GET
      const getRes = await requestJson<{
        success: boolean;
        data: { _id: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}`), {
        headers: authHeaders(projectA.token),
      });
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.status).toBe('completed');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'rejected decision resolves task and dispatches reject to mock engine',
    async () => {
      // Seed a workflow_approval task
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        title: 'Approve budget increase',
        description: 'Review budget request',
        type: 'approval',
        priority: 'medium',
        status: 'pending',
        source: {
          type: 'workflow_approval',
          workflowId: 'wf-reject-001',
          executionId: 'exec-reject-001',
          stepId: 'step-reject-001',
        },
        fields: [],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      const taskId = task._id;

      // POST resolve with rejected decision
      const resolveRes = await requestJson<{
        success: boolean;
        data: { taskId: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          decision: 'rejected',
          notes: 'Budget too high',
        },
      });

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.success).toBe(true);
      expect(resolveRes.body.data.status).toBe('completed');

      // Verify mock engine received reject (decision !== 'approved' → reject)
      const approvalReq = mockEngine.requests.find((r) => r.path.includes('/approve'));
      expect(approvalReq).toBeDefined();
      expect(approvalReq!.body).toMatchObject({
        decision: 'reject',
        reason: 'Budget too high',
      });

      // Verify task is completed
      const getRes = await requestJson<{
        success: boolean;
        data: { _id: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}`), {
        headers: authHeaders(projectA.token),
      });
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.status).toBe('completed');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Resolve workflow_human_task
// ---------------------------------------------------------------------------

describe('Resolve workflow_human_task', () => {
  test(
    'resolves human task with fields and dispatches to mock engine',
    async () => {
      // Seed a workflow_human_task
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        title: 'Enter customer data',
        description: 'Fill in customer details',
        type: 'data_entry',
        priority: 'medium',
        status: 'pending',
        source: {
          type: 'workflow_human_task',
          workflowId: 'wf-ht-001',
          executionId: 'exec-ht-001',
          stepId: 'step-ht-001',
        },
        fields: [
          { name: 'customerName', label: 'Customer Name', type: 'text', required: true },
          { name: 'email', label: 'Email', type: 'text', required: false },
        ],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      const taskId = task._id;

      // POST resolve with fields
      const resolveRes = await requestJson<{
        success: boolean;
        data: { taskId: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          fields: { customerName: 'Jane Doe', email: 'jane@example.com' },
          notes: 'Customer verified',
          decision: 'completed',
        },
      });

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.success).toBe(true);
      expect(resolveRes.body.data.status).toBe('completed');

      // Verify mock engine received the human task resolve call
      const htReq = mockEngine.requests.find((r) => r.path.includes('/human-tasks/executions/'));
      expect(htReq).toBeDefined();
      expect(htReq!.method).toBe('POST');
      expect(htReq!.path).toContain('/executions/exec-ht-001/steps/step-ht-001/resolve');
      expect(htReq!.body).toMatchObject({
        fields: { customerName: 'Jane Doe', email: 'jane@example.com' },
        notes: 'Customer verified',
        decision: 'completed',
      });

      // Verify task status changed to completed via GET
      const getRes = await requestJson<{
        success: boolean;
        data: { _id: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}`), {
        headers: authHeaders(projectA.token),
      });
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.status).toBe('completed');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Resolve validation
// ---------------------------------------------------------------------------

describe('Resolve validation', () => {
  test(
    'missing required fields returns 400',
    async () => {
      // Seed a task with required fields
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        title: 'Enter shipping details',
        description: 'Fill in shipping information',
        type: 'data_entry',
        priority: 'high',
        status: 'pending',
        source: {
          type: 'workflow_human_task',
          workflowId: 'wf-val-001',
          executionId: 'exec-val-001',
          stepId: 'step-val-001',
        },
        fields: [
          { name: 'address', label: 'Address', type: 'text', required: true },
          { name: 'city', label: 'City', type: 'text', required: true },
          { name: 'notes', label: 'Notes', type: 'textarea', required: false },
        ],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      const taskId = task._id;

      // POST resolve without providing required fields
      const res = await requestJson<{
        success: boolean;
        error: string;
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          decision: 'completed',
          notes: 'Some notes',
          // Missing 'fields' entirely — address and city are required
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
      expect(res.body.error).toContain('address');
      expect(res.body.error).toContain('city');

      // Verify no calls were made to the mock engine
      expect(mockEngine.requests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'task not found returns 404',
    async () => {
      const fakeTaskId = '01234567-89ab-cdef-0123-456789abcdef';

      const res = await requestJson<{
        success: boolean;
        error: string;
      }>(harness, humanTaskPath(projectA.projectId, `/${fakeTaskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          decision: 'approved',
        },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);

      // Verify no calls were made to the mock engine
      expect(mockEngine.requests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'already resolved task returns 404',
    async () => {
      // Seed a task with status 'completed'
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        title: 'Already resolved task',
        description: 'This task was already completed',
        type: 'approval',
        priority: 'medium',
        status: 'completed',
        source: {
          type: 'workflow_approval',
          workflowId: 'wf-done-001',
          executionId: 'exec-done-001',
          stepId: 'step-done-001',
        },
        fields: [],
        context: {},
        response: {
          respondedBy: 'previous-user',
          respondedAt: new Date(),
          fields: {},
          decision: 'approved',
        },
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      const taskId = task._id;

      const res = await requestJson<{
        success: boolean;
        error: string;
      }>(harness, humanTaskPath(projectA.projectId, `/${taskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          decision: 'approved',
        },
      });

      // The route filters by status in ['pending', 'assigned', 'in_progress'],
      // so a 'completed' task is not found → 404
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);

      // Verify no calls were made to the mock engine
      expect(mockEngine.requests).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Associate session
// ---------------------------------------------------------------------------

describe('Associate session', () => {
  test(
    'happy path — associates workflow with session',
    async () => {
      // Create a workflow first via the CRUD API
      const wfRes = await requestJson<{
        success: boolean;
        data: { id?: string; _id?: string };
      }>(harness, workflowPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: uniqueSlug('assoc-wf'),
          nodes: [
            { id: 's1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 } },
            { id: 'e1', nodeType: 'end', name: 'End', position: { x: 200, y: 0 } },
          ],
          edges: [{ id: 'edge1', source: 's1', target: 'e1' }],
        },
      });

      expect(wfRes.status).toBe(201);
      const workflowId = wfRes.body.data?.id ?? wfRes.body.data?._id;
      expect(workflowId).toBeTruthy();

      // Call associate-session
      const res = await requestJson<{
        success: boolean;
        message: string;
      }>(harness, workflowPath(projectA.projectId, `/${workflowId}/associate-session`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { sessionId: 'session-test-123' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Workflow associated with session');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'workflow not found returns 404',
    async () => {
      const fakeWorkflowId = '01234567-89ab-cdef-0123-456789abcdef';

      const res = await requestJson<{
        success: boolean;
        error: string;
      }>(harness, workflowPath(projectA.projectId, `/${fakeWorkflowId}/associate-session`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { sessionId: 'session-nonexistent' },
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
