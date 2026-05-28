/**
 * E2E: Workflow CRUD, Versioning, Human Tasks, and Isolation
 *
 * Exercises the real runtime server through its HTTP API:
 * - POST /api/projects/:pid/workflows               Create workflow
 * - GET  /api/projects/:pid/workflows                List workflows
 * - GET  /api/projects/:pid/workflows/:id            Get by ID
 * - GET  /api/projects/:pid/workflows/by-name        Get by name
 * - PUT  /api/projects/:pid/workflows/:id            Update workflow
 * - POST /api/projects/:pid/workflows/:id/archive    Archive workflow
 * - POST /api/projects/:pid/workflows/:wfId/versions           Create version
 * - GET  /api/projects/:pid/workflows/:wfId/versions           List versions
 * - POST /api/projects/:pid/workflows/:wfId/versions/:v/activate  Activate version
 * - POST /api/projects/:pid/workflows/:wfId/versions/:v/deactivate Deactivate version
 * - GET  /api/projects/:pid/human-tasks              List human tasks
 * - GET  /api/projects/:pid/human-tasks/:taskId      Get single task
 * - POST /api/projects/:pid/human-tasks/:taskId/assign  Assign task
 * - POST /api/projects/:pid/human-tasks/:taskId/claim   Claim task
 * - POST /api/projects/:pid/human-tasks/:taskId/resolve Resolve task
 *
 * Real components (NO mocks):
 * - Express server with full middleware chain (auth, RBAC, validation)
 * - MongoDB Memory Server for data persistence
 * - JWT-based auth via dev-login bootstrap
 *
 * Requires: mongodb-memory-server binary (downloaded on first run)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
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
import { HumanTask } from '@agent-platform/database/models';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

let harness: RuntimeApiHarness;
let projectA: BootstrapProjectResult;
let projectB: BootstrapProjectResult;

// ---------------------------------------------------------------------------
// Setup: start real runtime + MongoDB, bootstrap two projects for isolation
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await startRuntimeServerHarness();

  projectA = await bootstrapProject(
    harness,
    uniqueEmail('wf-e2e-a'),
    uniqueSlug('wf-tenant-a'),
    uniqueSlug('wf-project-a'),
  );

  projectB = await bootstrapProject(
    harness,
    uniqueEmail('wf-e2e-b'),
    uniqueSlug('wf-tenant-b'),
    uniqueSlug('wf-project-b'),
  );
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.close();
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workflowPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/workflows${suffix}`;
}

function humanTaskPath(projectId: string, suffix = ''): string {
  return `/api/projects/${projectId}/human-tasks${suffix}`;
}

interface WorkflowResponse {
  success: boolean;
  data: {
    id: string;
    _id?: string;
    tenantId: string;
    projectId: string;
    name: string;
    type: string;
    description?: string;
    status: string;
    nodes?: Array<{
      id: string;
      nodeType: string;
      name: string;
      position: { x: number; y: number };
      config?: Record<string, unknown>;
    }>;
    edges?: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      label?: string;
    }>;
    envVars?: Record<string, string>;
    steps?: unknown[];
    triggers?: unknown[];
    escalationRules?: unknown[];
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  };
}

interface WorkflowListResponse {
  success: boolean;
  data: WorkflowResponse['data'][];
  total: number;
}

// ---------------------------------------------------------------------------
// E2E-WF-01: Workflow CRUD Lifecycle
// ---------------------------------------------------------------------------

describe('E2E-WF-01: Workflow CRUD Lifecycle', () => {
  let createdWorkflowId: string;

  test(
    'POST /workflows creates a workflow and returns 201',
    async () => {
      const res = await requestJson<WorkflowResponse>(harness, workflowPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: 'Order Processing Workflow',
          type: 'cx_automation',
          description: 'Handles customer order processing',
          metadata: { category: 'orders', version: '1.0' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Order Processing Workflow');
      expect(res.body.data.type).toBe('cx_automation');
      expect(res.body.data.description).toBe('Handles customer order processing');
      expect(res.body.data.projectId).toBe(projectA.projectId);

      createdWorkflowId = res.body.data.id ?? res.body.data._id!;
      expect(createdWorkflowId).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /workflows lists workflows including the created one',
    async () => {
      const res = await requestJson<WorkflowListResponse>(
        harness,
        workflowPath(projectA.projectId),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const found = res.body.data.find((w) => (w.id ?? w._id) === createdWorkflowId);
      expect(found).toBeDefined();
      expect(found!.name).toBe('Order Processing Workflow');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /workflows/:id returns the specific workflow',
    async () => {
      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, `/${createdWorkflowId}`),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Order Processing Workflow');
      expect(res.body.data.description).toBe('Handles customer order processing');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /workflows/by-name returns workflow by name',
    async () => {
      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, '/by-name?name=Order Processing Workflow'),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Order Processing Workflow');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PUT /workflows/:id updates the workflow',
    async () => {
      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, `/${createdWorkflowId}`),
        {
          method: 'PUT',
          headers: authHeaders(projectA.token),
          body: {
            name: 'Order Processing Workflow v2',
            description: 'Updated: handles orders with priority routing',
            metadata: { category: 'orders', version: '2.0' },
          },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Order Processing Workflow v2');
      expect(res.body.data.description).toBe('Updated: handles orders with priority routing');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /workflows/:id/archive archives the workflow',
    async () => {
      const res = await requestJson<{
        success: boolean;
        message: string;
        warning?: string;
      }>(harness, workflowPath(projectA.projectId, `/${createdWorkflowId}/archive`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Workflow archived');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /workflows/:id after archive still returns the workflow (archived status)',
    async () => {
      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, `/${createdWorkflowId}`),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('archived');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-02: Canvas Node/Edge Persistence
// ---------------------------------------------------------------------------

describe('E2E-WF-02: Canvas Node/Edge Persistence', () => {
  let canvasWorkflowId: string;

  const nodes = [
    {
      id: 'start-1',
      nodeType: 'start',
      name: 'Start',
      position: { x: 100, y: 200 },
      config: {},
    },
    {
      id: 'condition-1',
      nodeType: 'condition',
      name: 'Check Order Value',
      position: { x: 300, y: 200 },
      config: { expression: '{{trigger.payload.orderTotal}} > 1000' },
    },
    {
      id: 'human-1',
      nodeType: 'human',
      name: 'Manager Approval',
      position: { x: 500, y: 100 },
      config: {
        taskType: 'approval',
        title: 'Approve high-value order',
        assignTo: 'manager',
      },
    },
    {
      id: 'func-1',
      nodeType: 'function',
      name: 'Auto-Process',
      position: { x: 500, y: 300 },
      config: { code: 'return { processed: true };' },
    },
    {
      id: 'end-1',
      nodeType: 'end',
      name: 'End',
      position: { x: 700, y: 200 },
      config: {},
    },
  ];

  const edges = [
    { id: 'e1', source: 'start-1', target: 'condition-1' },
    {
      id: 'e2',
      source: 'condition-1',
      sourceHandle: 'if',
      target: 'human-1',
      label: 'High value',
    },
    {
      id: 'e3',
      source: 'condition-1',
      sourceHandle: 'else',
      target: 'func-1',
      label: 'Low value',
    },
    { id: 'e4', source: 'human-1', target: 'end-1' },
    { id: 'e5', source: 'func-1', target: 'end-1' },
  ];

  test(
    'creates workflow with canvas nodes and edges',
    async () => {
      const res = await requestJson<WorkflowResponse>(harness, workflowPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: 'Canvas Order Flow',
          type: 'cx_automation',
          nodes,
          edges,
          envVars: { ORDER_THRESHOLD: '1000' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      canvasWorkflowId = res.body.data.id ?? res.body.data._id!;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET returns persisted nodes with correct positions and config',
    async () => {
      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, `/${canvasWorkflowId}`),
        {
          method: 'GET',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);

      const data = res.body.data;
      expect(data.nodes).toHaveLength(5);
      expect(data.edges).toHaveLength(5);

      // Verify condition node persists with config
      const conditionNode = data.nodes!.find((n) => n.id === 'condition-1');
      expect(conditionNode).toBeDefined();
      expect(conditionNode!.nodeType).toBe('condition');
      expect(conditionNode!.name).toBe('Check Order Value');
      expect(conditionNode!.position).toEqual({ x: 300, y: 200 });
      expect(conditionNode!.config).toEqual({
        expression: '{{trigger.payload.orderTotal}} > 1000',
      });

      // Verify edges with labels and source handles
      const ifEdge = data.edges!.find((e) => e.id === 'e2');
      expect(ifEdge).toBeDefined();
      expect(ifEdge!.sourceHandle).toBe('if');
      expect(ifEdge!.label).toBe('High value');

      // Verify envVars round-trip
      expect(data.envVars).toEqual({ ORDER_THRESHOLD: '1000' });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PUT updates node positions and adds new nodes',
    async () => {
      const updatedNodes = [
        ...nodes,
        {
          id: 'delay-1',
          nodeType: 'delay',
          name: 'Wait 5 min',
          position: { x: 600, y: 200 },
          config: { durationMs: 300000 },
        },
      ];

      const res = await requestJson<WorkflowResponse>(
        harness,
        workflowPath(projectA.projectId, `/${canvasWorkflowId}`),
        {
          method: 'PUT',
          headers: authHeaders(projectA.token),
          body: {
            nodes: updatedNodes,
            edges: [...edges, { id: 'e6', source: 'human-1', target: 'delay-1' }],
          },
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.data.nodes).toHaveLength(6);
      expect(res.body.data.edges).toHaveLength(6);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-03: Workflow Versioning
// ---------------------------------------------------------------------------

describe('E2E-WF-03: Workflow Versioning', () => {
  let versionWorkflowId: string;
  let firstVersionId: string;
  let firstVersionLabel: string;

  test(
    'setup: create a workflow for versioning tests',
    async () => {
      const res = await requestJson<WorkflowResponse>(harness, workflowPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: 'Versioned Workflow',
          type: 'cx_automation',
          nodes: [
            {
              id: 's1',
              nodeType: 'start',
              name: 'Start',
              position: { x: 0, y: 0 },
            },
            {
              id: 'e1',
              nodeType: 'end',
              name: 'End',
              position: { x: 200, y: 0 },
            },
          ],
          edges: [{ id: 'edge1', source: 's1', target: 'e1' }],
        },
      });

      expect(res.status).toBe(201);
      versionWorkflowId = res.body.data.id ?? res.body.data._id!;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /versions creates a version snapshot',
    async () => {
      const res = await requestJson<{
        success: boolean;
        versionId: string;
        version: string;
        sourceHash: string;
        deduplicated?: boolean;
      }>(harness, workflowPath(projectA.projectId, `/${versionWorkflowId}/versions`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { changelog: 'Initial version' },
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.versionId).toBeTruthy();
      expect(res.body.version).toBeTruthy();
      expect(res.body.sourceHash).toBeTruthy();

      firstVersionId = res.body.versionId;
      firstVersionLabel = res.body.version;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /versions again with no changes deduplicates',
    async () => {
      const res = await requestJson<{
        success: boolean;
        versionId: string;
        version: string;
        sourceHash: string;
        deduplicated?: boolean;
      }>(harness, workflowPath(projectA.projectId, `/${versionWorkflowId}/versions`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { changelog: 'Attempt duplicate' },
      });

      // Should return 200 with deduplicated flag (not 201)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deduplicated).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /versions lists versions for the workflow',
    async () => {
      const res = await requestJson<{
        success: boolean;
        versions: Array<{
          versionId: string;
          version: string;
          state?: string;
          sourceHash: string;
        }>;
        total: number;
        hasMore: boolean;
      }>(harness, workflowPath(projectA.projectId, `/${versionWorkflowId}/versions`), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.versions.length).toBeGreaterThanOrEqual(1);
      expect(res.body.total).toBeGreaterThanOrEqual(1);

      const v1 = res.body.versions.find((v) => v.versionId === firstVersionId);
      expect(v1).toBeDefined();
      // Newly published versions start as inactive (state replaces legacy status)
      expect(v1!.state).toBe('inactive');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /versions/:v/activate transitions version to active state',
    async () => {
      const res = await requestJson<{
        success: boolean;
        version: Record<string, unknown>;
      }>(
        harness,
        workflowPath(
          projectA.projectId,
          `/${versionWorkflowId}/versions/${firstVersionLabel}/activate`,
        ),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.version.state).toBe('active');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /versions/draft/activate returns 400 — draft is always active',
    async () => {
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(
        harness,
        workflowPath(projectA.projectId, `/${versionWorkflowId}/versions/draft/activate`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('DRAFT_ALWAYS_ACTIVE');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-04: Human Task CRUD via API
// ---------------------------------------------------------------------------

describe('E2E-WF-04: Human Task CRUD via API', () => {
  let seededTaskId: string;

  test(
    'setup: seed a human task via the model for API testing',
    async () => {
      // We seed directly because the workflow-engine (which creates tasks during
      // execution) is a separate service not started in this harness. The runtime
      // routes read/update tasks in MongoDB — that is what we test here.
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        type: 'approval',
        status: 'pending',
        priority: 'high',
        title: 'Approve refund for order #12345',
        description: 'Customer requested refund for damaged item',
        source: {
          type: 'workflow_approval',
          workflowId: 'wf-seed-001',
          executionId: 'exec-seed-001',
          stepId: 'step-seed-001',
        },
        fields: [
          {
            name: 'decision_notes',
            type: 'textarea',
            label: 'Decision Notes',
            required: true,
          },
          {
            name: 'refund_amount',
            type: 'number',
            label: 'Refund Amount',
            required: true,
          },
        ],
        context: { orderId: '12345', customerName: 'John Doe', orderTotal: 299.99 },
        escalationChain: ['manager-1', 'director-1'],
        currentEscalationLevel: 0,
      });

      seededTaskId = task._id;
      expect(seededTaskId).toBeTruthy();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /human-tasks lists pending tasks for the project',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{
          _id: string;
          type: string;
          status: string;
          priority: string;
          title: string;
        }>;
        total: number;
        countsByType?: Record<string, number>;
      }>(harness, humanTaskPath(projectA.projectId), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const found = res.body.data.find((t) => t._id === seededTaskId);
      expect(found).toBeDefined();
      expect(found!.type).toBe('approval');
      expect(found!.status).toBe('pending');
      expect(found!.priority).toBe('high');
      expect(found!.title).toBe('Approve refund for order #12345');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /human-tasks with status filter returns only matching tasks',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{ _id: string; status: string }>;
        total: number;
      }>(harness, humanTaskPath(projectA.projectId, '?status=completed'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Our seeded task is pending, not completed
      const found = res.body.data.find((t) => t._id === seededTaskId);
      expect(found).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /human-tasks/:taskId returns a single task with full detail',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: {
          _id: string;
          type: string;
          status: string;
          title: string;
          description: string;
          source: { type: string; executionId: string; stepId: string };
          fields: Array<{ name: string; type: string; required: boolean }>;
          context: Record<string, unknown>;
          escalationChain: string[];
        };
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}`), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(seededTaskId);
      expect(res.body.data.source.type).toBe('workflow_approval');
      expect(res.body.data.source.executionId).toBe('exec-seed-001');
      expect(res.body.data.fields).toHaveLength(2);
      expect(res.body.data.context.orderId).toBe('12345');
      expect(res.body.data.escalationChain).toEqual(['manager-1', 'director-1']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /human-tasks/:taskId/assign assigns the task to a user',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; status: string; assignedTo: string[] };
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}/assign`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { assignedTo: projectA.userId },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('assigned');
      expect(res.body.data.assignedTo).toEqual([projectA.userId]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /human-tasks/:taskId/claim transitions task to in_progress',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; status: string; claimedBy: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}/claim`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.data.claimedBy).toBe(projectA.userId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /human-tasks/:taskId/resolve with missing required fields returns 400',
    async () => {
      // The task has required fields: decision_notes and refund_amount
      // Resolve without providing them should fail validation
      const res = await requestJson<{
        success: boolean;
        error: string;
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: { decision: 'approved', notes: 'Looks good' },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /human-tasks/:taskId/resolve with all required fields returns 502 (no workflow engine)',
    async () => {
      // The resolve endpoint dispatches to the workflow engine upstream first.
      // Since workflow-engine is not running in this harness, the upstream call
      // will fail and the route returns 502 UPSTREAM_DISPATCH_FAILED.
      // This is the CORRECT behavior — the task must NOT be marked completed
      // if upstream dispatch fails (FR-39: synchronous upstream dispatch).
      const res = await requestJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}/resolve`), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          fields: { decision_notes: 'Approved per policy', refund_amount: 299.99 },
          decision: 'approved',
          notes: 'Customer is eligible for full refund',
        },
      });

      // 502 because workflow-engine is not running — upstream dispatch fails
      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UPSTREAM_DISPATCH_FAILED');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'task remains in_progress after failed upstream dispatch (not silently completed)',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: { _id: string; status: string };
      }>(harness, humanTaskPath(projectA.projectId, `/${seededTaskId}`), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      // Critical assertion: task was NOT marked completed because upstream failed
      expect(res.body.data.status).toBe('in_progress');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-05: Tenant Isolation
// ---------------------------------------------------------------------------

describe('E2E-WF-05: Tenant Isolation', () => {
  let isolatedWorkflowId: string;
  let isolatedTaskId: string;

  test(
    'setup: create workflow and task in projectA',
    async () => {
      const wfRes = await requestJson<WorkflowResponse>(harness, workflowPath(projectA.projectId), {
        method: 'POST',
        headers: authHeaders(projectA.token),
        body: {
          name: 'Isolated Workflow',
          type: 'internal',
        },
      });
      expect(wfRes.status).toBe(201);
      isolatedWorkflowId = wfRes.body.data.id ?? wfRes.body.data._id!;

      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        type: 'data_entry',
        status: 'pending',
        priority: 'medium',
        title: 'Enter shipping details',
        source: {
          type: 'workflow_human_task',
          workflowId: isolatedWorkflowId,
          executionId: 'exec-iso-001',
          stepId: 'step-iso-001',
        },
        fields: [],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });
      isolatedTaskId = task._id;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'projectB cannot see projectA workflow (returns 404)',
    async () => {
      // Attempting to access projectA's workflow using projectB's auth
      // The auth middleware scopes to projectB's tenant, so the workflow is invisible
      const res = await requestJson<{ success: boolean; error: string }>(
        harness,
        workflowPath(projectB.projectId, `/${isolatedWorkflowId}`),
        {
          method: 'GET',
          headers: authHeaders(projectB.token),
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'projectB human task list does not contain projectA tasks',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{ _id: string }>;
        total: number;
      }>(harness, humanTaskPath(projectB.projectId), {
        method: 'GET',
        headers: authHeaders(projectB.token),
      });

      expect(res.status).toBe(200);
      const found = res.body.data.find((t) => t._id === isolatedTaskId);
      expect(found).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'projectB cannot access projectA human task by ID (returns 404)',
    async () => {
      const res = await requestJson<{ success: boolean; error: string }>(
        harness,
        humanTaskPath(projectB.projectId, `/${isolatedTaskId}`),
        {
          method: 'GET',
          headers: authHeaders(projectB.token),
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'projectB cannot assign projectA task (returns 404)',
    async () => {
      const res = await requestJson<{ success: boolean; error: string }>(
        harness,
        humanTaskPath(projectB.projectId, `/${isolatedTaskId}/assign`),
        {
          method: 'POST',
          headers: authHeaders(projectB.token),
          body: { assignedTo: projectB.userId },
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-06: Auth Enforcement
// ---------------------------------------------------------------------------

describe('E2E-WF-06: Auth Enforcement', () => {
  test(
    'request without auth token to workflows returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, workflowPath(projectA.projectId), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'request without auth token to human-tasks returns 401',
    async () => {
      const res = await requestJson<unknown>(harness, humanTaskPath(projectA.projectId), {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /workflows without name returns validation error',
    async () => {
      const res = await requestJson<{ success: boolean; error?: string }>(
        harness,
        workflowPath(projectA.projectId),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {
            // Missing required 'name' field
            type: 'cx_automation',
          },
        },
      );

      // The route validates via Zod — missing name should fail
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'PUT /workflows/:id for non-existent workflow returns 404',
    async () => {
      const fakeId = '01234567-89ab-cdef-0123-456789abcdef';
      const res = await requestJson<{ success: boolean; error: string }>(
        harness,
        workflowPath(projectA.projectId, `/${fakeId}`),
        {
          method: 'PUT',
          headers: authHeaders(projectA.token),
          body: { name: 'Ghost Workflow' },
        },
      );

      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'POST /human-tasks/:taskId/assign without assignedTo returns 400',
    async () => {
      // Create a fresh task for this test
      const task = await HumanTask.create({
        tenantId: projectA.tenantId,
        projectId: projectA.projectId,
        type: 'review',
        status: 'pending',
        priority: 'low',
        title: 'Review document',
        source: {
          type: 'workflow_human_task',
          workflowId: 'wf-auth-test',
          executionId: 'exec-auth-test',
          stepId: 'step-auth-test',
        },
        fields: [],
        context: {},
        escalationChain: [],
        currentEscalationLevel: 0,
      });

      const res = await requestJson<{ success: boolean; error: string }>(
        harness,
        humanTaskPath(projectA.projectId, `/${task._id}/assign`),
        {
          method: 'POST',
          headers: authHeaders(projectA.token),
          body: {},
        },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('assignedTo');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E2E-WF-07: Human Task Priority Filter
// ---------------------------------------------------------------------------

describe('E2E-WF-07: Human Task Priority and Type Filters', () => {
  test(
    'setup: seed tasks with different priorities and types',
    async () => {
      const tasks = [
        {
          tenantId: projectA.tenantId,
          projectId: projectA.projectId,
          type: 'data_entry' as const,
          status: 'pending' as const,
          priority: 'critical' as const,
          title: 'Critical: Verify customer identity',
          source: {
            type: 'workflow_human_task' as const,
            workflowId: 'wf-filter-001',
            executionId: 'exec-filter-001',
            stepId: 'step-filter-001',
          },
          fields: [],
          context: {},
          escalationChain: [],
          currentEscalationLevel: 0,
        },
        {
          tenantId: projectA.tenantId,
          projectId: projectA.projectId,
          type: 'decision' as const,
          status: 'pending' as const,
          priority: 'low' as const,
          title: 'Low: Categorize feedback',
          source: {
            type: 'workflow_human_task' as const,
            workflowId: 'wf-filter-002',
            executionId: 'exec-filter-002',
            stepId: 'step-filter-002',
          },
          fields: [],
          context: {},
          escalationChain: [],
          currentEscalationLevel: 0,
        },
      ];

      await HumanTask.insertMany(tasks);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /human-tasks?priority=critical returns only critical tasks',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{ _id: string; priority: string; title: string }>;
      }>(harness, humanTaskPath(projectA.projectId, '?priority=critical'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const task of res.body.data) {
        expect(task.priority).toBe('critical');
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'GET /human-tasks?type=decision returns only decision tasks',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: Array<{ _id: string; type: string }>;
      }>(harness, humanTaskPath(projectA.projectId, '?type=decision'), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const task of res.body.data) {
        expect(task.type).toBe('decision');
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'countsByType includes counts for active task types',
    async () => {
      const res = await requestJson<{
        success: boolean;
        data: unknown[];
        countsByType: Record<string, number>;
      }>(harness, humanTaskPath(projectA.projectId), {
        method: 'GET',
        headers: authHeaders(projectA.token),
      });

      expect(res.status).toBe(200);
      expect(res.body.countsByType).toBeDefined();
      // We seeded approval, data_entry, decision, and review tasks
      // At least some of them should appear in countsByType
      const totalActive = Object.values(res.body.countsByType).reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(totalActive).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
