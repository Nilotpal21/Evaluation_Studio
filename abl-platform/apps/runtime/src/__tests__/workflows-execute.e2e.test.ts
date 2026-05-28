/**
 * Workflows Execute API E2E Tests
 *
 * Exercises the new short-URL workflow execution API through the real HTTP stack:
 * real Express server, real MongoDB (MongoMemoryServer), real auth middleware.
 *
 * The workflow-engine is an external service — a small Express mock server
 * stands in for it, which is the only thing "mocked" (via DI, not vi.mock).
 *
 * Routes under test:
 *   POST /api/v1/workflows/:workflowId/execute                    — execute a workflow
 *   GET  /api/v1/workflows/:workflowId/executions/:executionId    — poll execution status
 *
 * Covers:
 *   E2E-1  — sync happy path via short URL
 *   E2E-2  — version pin happy path + 404 on missing version
 *   E2E-8  — status-poll happy + auth + cross-project 404
 *   INT-6  — cross-project conceal
 *   FR-5   — sync-timeout auto-promote to 202
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import type { AuditLog } from '@abl/compiler/platform/core/types';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import { requestJson } from './helpers/channel-e2e-bootstrap.js';
import { authMiddleware } from '../middleware/auth.js';
import { createWorkflowsExecuteRouter } from '../routes/workflows-execute.js';
import type { SyncExecutionService, SyncExecutionResult } from '../services/sync-execution.js';
import {
  getAuditStore,
  initializeAuditStore,
  _resetAuditStore,
} from '../services/audit-store-singleton.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-wf-execute-e2e';
const PROJECT_ID = 'project-wf-execute-e2e';
const OTHER_PROJECT_ID = 'project-wf-other-e2e';
const API_KEY_ID = 'apikey-wf-execute-e2e';
const CLIENT_ID = 'client-wf-execute-e2e';
const CREATOR_ID = 'creator-wf-execute-e2e';
const WORKFLOW_ID = 'workflow-wf-execute-e2e';
const VERSION_ID = 'version-wf-execute-e2e-v010';
const RAW_API_KEY = 'abl_test_wf_execute_e2e_key_1234567890abcdef';
const API_KEY_PREFIX = RAW_API_KEY.substring(0, 8);
const API_KEY_HASH = crypto.createHash('sha256').update(RAW_API_KEY).digest('hex');

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecuteResponse {
  success: boolean;
  data?: {
    traceId: string;
    status: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
    resolvedVersion?: string;
    resolvedVersionId?: string;
  };
  error?: { code: string; message: string };
}

interface StatusResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ─── Mock Workflow Engine ─────────────────────────────────────────────────────

function createMockWorkflowEngine(): {
  app: express.Express;
  server: http.Server;
  baseUrl: string;
  lastPayload: Record<string, unknown> | null;
  lastExecuteHeaders: { authorization?: string; xApiKey?: string } | null;
  lastExecutionStatusRequest: { workflowId: string; executionId: string } | null;
  lastStatusHeaders: { authorization?: string; xApiKey?: string } | null;
  close: () => Promise<void>;
  start: () => Promise<void>;
} {
  const engineApp = express();
  engineApp.use(express.json());

  const state = {
    app: engineApp,
    server: null as unknown as http.Server,
    baseUrl: '',
    lastPayload: null as Record<string, unknown> | null,
    lastExecuteHeaders: null as { authorization?: string; xApiKey?: string } | null,
    lastExecutionStatusRequest: null as {
      workflowId: string;
      executionId: string;
    } | null,
    lastStatusHeaders: null as { authorization?: string; xApiKey?: string } | null,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        state.server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    start: async () => {
      await new Promise<void>((resolve) => {
        state.server = http.createServer(engineApp);
        state.server.listen(0, '127.0.0.1', () => {
          const addr = state.server.address() as AddressInfo;
          state.baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    },
  };

  // Execute endpoint — accepts workflow execution requests
  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/execute',
    (req, res) => {
      state.lastPayload = req.body;
      state.lastExecuteHeaders = {
        authorization: req.headers.authorization,
        xApiKey: req.headers['x-api-key'] as string | undefined,
      };
      res.status(200).json({ success: true, data: { executionId: req.body?.executionId } });
    },
  );

  // Status poll endpoint — returns mock execution status
  engineApp.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId',
    (req, res) => {
      const { workflowId, executionId } = req.params;
      state.lastExecutionStatusRequest = { workflowId, executionId };
      state.lastStatusHeaders = {
        authorization: req.headers.authorization,
        xApiKey: req.headers['x-api-key'] as string | undefined,
      };

      // Return mock status for known execution IDs
      if (executionId === 'exec-status-test-001') {
        return res.status(200).json({
          success: true,
          data: {
            executionId,
            status: 'completed',
            output: { result: 'success' },
          },
        });
      }

      // 404 for unknown executions
      return res.status(404).json({
        success: false,
        error: {
          code: 'EXECUTION_NOT_FOUND',
          message: 'Execution not found',
        },
      });
    },
  );

  return state;
}

// ─── Controllable SyncExecutionService (DI, not vi.mock) ─────────────────────

class ControllableSyncExecution implements SyncExecutionService {
  private _activeCount = 0;
  private pendingResolvers: Array<(result: SyncExecutionResult) => void> = [];

  get activeCount(): number {
    return this._activeCount;
  }

  async waitForCompletion(
    _tenantId: string,
    _executionId: string,
    _timeoutMs: number,
    _abortSignal?: AbortSignal,
  ): Promise<SyncExecutionResult> {
    this._activeCount++;
    return new Promise<SyncExecutionResult>((resolve) => {
      this.pendingResolvers.push((result) => {
        this._activeCount--;
        resolve(result);
      });
    });
  }

  resolveNext(result: SyncExecutionResult): void {
    const resolver = this.pendingResolvers.shift();
    if (!resolver) throw new Error('No pending waitForCompletion to resolve');
    resolver(result);
  }

  get pendingCount(): number {
    return this.pendingResolvers.length;
  }

  async shutdown(): Promise<void> {
    while (this.pendingResolvers.length > 0) {
      this.resolveNext({ status: 'timeout' });
    }
  }
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function apiKeyHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${RAW_API_KEY}` };
}

async function seedApiKey(overrides: Record<string, unknown> = {}): Promise<void> {
  const { ApiKey } = await import('@agent-platform/database/models');
  await ApiKey.create({
    _id: API_KEY_ID,
    tenantId: TENANT_ID,
    name: 'wf-execute-e2e-key',
    clientId: CLIENT_ID,
    keyHash: API_KEY_HASH,
    prefix: API_KEY_PREFIX,
    scopes: ['workflow:execute'],
    projectIds: [PROJECT_ID],
    environments: [],
    createdBy: CREATOR_ID,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  });
}

async function seedWorkflow(overrides: Record<string, unknown> = {}): Promise<void> {
  const { Workflow } = await import('@agent-platform/database');
  await Workflow.create({
    _id: WORKFLOW_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: 'E2E Workflow Execute Test',
    description: 'Workflow for workflows-execute E2E tests',
    nodes: [
      { id: 'start-1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      { id: 'end-1', nodeType: 'end', name: 'End', position: { x: 200, y: 0 }, config: {} },
    ],
    edges: [{ id: 'edge-1', source: 'start-1', target: 'end-1' }],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
    status: 'active',
    metadata: null,
    createdBy: CREATOR_ID,
    ...overrides,
  });
}

async function seedWorkflowVersion(overrides: Record<string, unknown> = {}): Promise<void> {
  const { WorkflowVersion } = await import('@agent-platform/database/models');
  await WorkflowVersion.create({
    _id: VERSION_ID,
    workflowId: WORKFLOW_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    version: 'v0.1.0',
    state: 'inactive',
    deleted: false,
    definition: { nodes: [], edges: [] },
    sourceHash: 'e2e-test-hash-v010',
    createdBy: CREATOR_ID,
    publishedAt: new Date(),
    ...overrides,
  });
}

async function clearTestData(): Promise<void> {
  const { ApiKey, WorkflowVersion, WorkflowExecution } =
    await import('@agent-platform/database/models');
  const { Workflow } = await import('@agent-platform/database');
  await ApiKey.deleteMany({ tenantId: TENANT_ID });
  await Workflow.deleteMany({ tenantId: TENANT_ID });
  await WorkflowVersion.deleteMany({ tenantId: TENANT_ID });
  await WorkflowExecution.deleteMany({ tenantId: TENANT_ID });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Workflows Execute API E2E', () => {
  let harness: RuntimeApiHarness;
  let mockEngine: Awaited<ReturnType<typeof createMockWorkflowEngine>>;
  let syncExec: ControllableSyncExecution;

  beforeAll(async () => {
    mockEngine = createMockWorkflowEngine();
    await mockEngine.start();

    syncExec = new ControllableSyncExecution();

    const sharedDeps = {
      syncExecution: () => syncExec as SyncExecutionService,
      engineBaseUrl: mockEngine.baseUrl,
    };

    const workflowsExecuteRouter = createWorkflowsExecuteRouter(sharedDeps);

    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/v1/workflows', authMiddleware, workflowsExecuteRouter);
    });

    // Audit helpers are fire-and-forget and no-op when the store isn't
    // initialized; this e2e suite asserts audit persistence, so initialize
    // the shared in-memory backend now that the harness has connected.
    _resetAuditStore();
    await initializeAuditStore({ clickhouseReady: false });
  }, 60_000);

  beforeEach(async () => {
    await clearTestData();
    mockEngine.lastPayload = null;
    mockEngine.lastExecuteHeaders = null;
    mockEngine.lastExecutionStatusRequest = null;
    mockEngine.lastStatusHeaders = null;
  });

  afterAll(async () => {
    _resetAuditStore();
    await syncExec.shutdown();
    await mockEngine.close();
    await harness.close();
  }, 30_000);

  // ─── E2E-1: Sync Happy Path via Short URL ──────────────────────────────

  test('E2E-1: sync execution via short URL returns 200 with result', async () => {
    await seedApiKey();
    await seedWorkflow();

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: { question: 'hello' } },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );

    // Verify engine received execution request
    expect(mockEngine.lastPayload).toBeTruthy();
    expect(mockEngine.lastPayload?.triggerType).toBe('webhook');
    expect(mockEngine.lastPayload?.webhookMode).toBe('sync');
    expect(mockEngine.lastPayload?.payload).toEqual({ question: 'hello' });

    // Simulate completion
    syncExec.resolveNext({
      status: 'completed',
      result: { answer: 42, summary: 'Done' },
    });

    const res = await resPromise;

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('completed');
    expect(res.body.data?.traceId).toBeTruthy();
    expect(res.body.data?.result).toEqual({ answer: 42, summary: 'Done' });
  });

  test('FR-5: sync execution that times out auto-promotes to 202 running', async () => {
    await seedApiKey();
    await seedWorkflow();

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: { slow: true } },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );

    // Simulate the 30s sync timeout firing — SyncExecutionService yields
    // { status: 'timeout' }, handler must auto-promote to async (202 running).
    syncExec.resolveNext({ status: 'timeout' });

    const res = await resPromise;

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('running');
    expect(res.body.data?.traceId).toBeTruthy();
    // Engine was called in sync mode — timeout auto-promote is runtime-side only.
    expect(mockEngine.lastPayload?.webhookMode).toBe('sync');
  });

  test('E2E-1: async mode via ?mode=async returns 202', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: { data: 'batch' } },
      },
    );

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('running');
    expect(res.body.data?.traceId).toBeTruthy();

    // Verify engine received async request
    expect(mockEngine.lastPayload).toBeTruthy();
    expect(mockEngine.lastPayload?.webhookMode).toBe('async');
    expect(mockEngine.lastPayload?.webhookDelivery).toBe('poll');
    expect(mockEngine.lastExecuteHeaders?.authorization).toBe(`Bearer ${RAW_API_KEY}`);
  });

  // ─── E2E-2: Version Pin Happy Path + 404 ──────────────────────────────

  test('E2E-2: version pin on inactive version returns 200 with correct version in engine payload', async () => {
    await seedApiKey();
    await seedWorkflow();
    // Seed an inactive (not-deleted) version
    await seedWorkflowVersion({ state: 'inactive', deleted: false });

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?version=v0.1.0`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );

    // Verify engine payload includes version fields
    expect(mockEngine.lastPayload?.workflowVersionId).toBe(VERSION_ID);
    expect(mockEngine.lastPayload?.workflowVersion).toBe('v0.1.0');

    syncExec.resolveNext({ status: 'completed', result: {} });

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('validates explicit version pins against the resolved version input schema', async () => {
    await seedApiKey();
    await seedWorkflow({
      inputSchema: {
        type: 'object',
        required: ['containerOnly'],
        properties: { containerOnly: { type: 'string' } },
      },
    });
    await seedWorkflowVersion({
      state: 'active',
      deleted: false,
      definition: {
        nodes: [],
        edges: [],
        inputSchema: {
          type: 'object',
          required: ['versionOnly'],
          properties: { versionOnly: { type: 'string' } },
        },
      },
    });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async&version=v0.1.0`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: { versionOnly: 'supported-by-version' } },
      },
    );

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(mockEngine.lastPayload?.payload).toEqual({ versionOnly: 'supported-by-version' });
  });

  test('validates default executes against the resolved default version input schema', async () => {
    await seedApiKey();
    await seedWorkflow({
      inputSchema: {
        type: 'object',
        required: ['containerOnly'],
        properties: { containerOnly: { type: 'string' } },
      },
    });
    await seedWorkflowVersion({
      state: 'active',
      deleted: false,
      definition: {
        nodes: [],
        edges: [],
        inputSchema: {
          type: 'object',
          required: ['versionOnly'],
          properties: { versionOnly: { type: 'string' } },
        },
      },
    });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: { versionOnly: 'resolved-default-version' } },
      },
    );

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(mockEngine.lastPayload?.workflowVersionId).toBe(VERSION_ID);
    expect(mockEngine.lastPayload?.workflowVersion).toBe('v0.1.0');
    expect(mockEngine.lastPayload?.payload).toEqual({ versionOnly: 'resolved-default-version' });
  });

  test('E2E-2: version pin on non-existent version returns 404 WORKFLOW_VERSION_NOT_FOUND', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?version=v99.99.99`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
  });

  test('E2E-2: version pin on soft-deleted version returns 404', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'inactive', deleted: true });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?version=v0.1.0`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
  });

  // ─── Path-segment URL form ──────────────────────────────────────────────

  test('path-segment URL resolves version from :version param', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'inactive', deleted: false });

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/versions/v0.1.0/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );

    expect(mockEngine.lastPayload?.workflowVersionId).toBe(VERSION_ID);
    expect(mockEngine.lastPayload?.workflowVersion).toBe('v0.1.0');

    syncExec.resolveNext({ status: 'completed', result: {} });
    const res = await resPromise;
    expect(res.status).toBe(200);
  });

  test('path-segment URL 404s on nonexistent version', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/versions/v99.99.99/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
  });

  test('path segment takes precedence over ?version= query when both supplied', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'inactive', deleted: false });

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/versions/v0.1.0/execute?version=v9.9.9`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );

    // Path wins: engine sees v0.1.0 (the existing seeded version), not v9.9.9
    expect(mockEngine.lastPayload?.workflowVersion).toBe('v0.1.0');

    syncExec.resolveNext({ status: 'completed', result: {} });
    const res = await resPromise;
    expect(res.status).toBe(200);
  });

  // ─── E2E-8: Status-poll ─────────────────────────────────────────────────

  test('E2E-8: status poll returns execution data from engine', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<StatusResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/executions/exec-status-test-001`,
      {
        method: 'GET',
        headers: apiKeyHeaders(),
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeTruthy();
    expect(mockEngine.lastExecutionStatusRequest?.workflowId).toBe(WORKFLOW_ID);
    expect(mockEngine.lastExecutionStatusRequest?.executionId).toBe('exec-status-test-001');
    expect(mockEngine.lastStatusHeaders?.authorization).toBe(`Bearer ${RAW_API_KEY}`);
  });

  test('E2E-8: status poll returns 401 without API key', async () => {
    await seedWorkflow();

    const res = await requestJson<StatusResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/executions/exec-status-test-001`,
      {
        method: 'GET',
      },
    );

    expect(res.status).toBe(401);
  });

  test('E2E-8: status poll returns 404 for non-existent execution', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<StatusResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/executions/non-existent-execution`,
      {
        method: 'GET',
        headers: apiKeyHeaders(),
      },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('EXECUTION_NOT_FOUND');
  });

  test('E2E-8: status poll returns 404 for workflow in different project (cross-project)', async () => {
    // Seed API key scoped to PROJECT_ID
    await seedApiKey();
    // Seed workflow in a DIFFERENT project
    await seedWorkflow({ projectId: OTHER_PROJECT_ID });

    const res = await requestJson<StatusResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/executions/exec-status-test-001`,
      {
        method: 'GET',
        headers: apiKeyHeaders(),
      },
    );

    // Should get 404 because the workflow's project doesn't match API key scope
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('WORKFLOW_NOT_FOUND');
  });

  // ─── INT-6: Cross-project conceal ──────────────────────────────────────

  test('INT-6: cross-project conceal — execute returns 404 for workflow outside API key scope', async () => {
    await seedApiKey(); // scoped to PROJECT_ID
    await seedWorkflow({ projectId: OTHER_PROJECT_ID }); // different project

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('WORKFLOW_NOT_FOUND');
  });

  // ─── Auth & Validation Tests ──────────────────────────────────────────

  test('rejects execute request without API key', async () => {
    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        body: { input: {} },
      },
    );
    expect(res.status).toBe(401);
  });

  test('rejects execute with API key lacking workflow:execute scope', async () => {
    const noScopeKey = 'abl_noscp_wf_execute_e2e_key_no_scope_xxxx';
    const noScopeHash = crypto.createHash('sha256').update(noScopeKey).digest('hex');
    const { ApiKey } = await import('@agent-platform/database/models');
    await ApiKey.create({
      tenantId: TENANT_ID,
      name: 'no-scope-key',
      clientId: 'client-no-scope',
      keyHash: noScopeHash,
      prefix: noScopeKey.substring(0, 8),
      scopes: ['read'],
      projectIds: [PROJECT_ID],
      environments: [],
      createdBy: CREATOR_ID,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${noScopeKey}` },
        body: { input: {} },
      },
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  test('rejects execute for non-existent workflow', async () => {
    await seedApiKey();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/nonexistent-workflow/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('WORKFLOW_NOT_FOUND');
  });

  test('executes workflows even when the container status is draft if a runnable version resolves', async () => {
    await seedApiKey();
    await seedWorkflow({ status: 'draft' });
    await seedWorkflowVersion({ state: 'active', deleted: false });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(mockEngine.lastPayload?.workflowVersionId).toBe(VERSION_ID);
    expect(mockEngine.lastPayload?.workflowVersion).toBe('v0.1.0');
  });

  test('rejects execute with invalid callbackUrl → INVALID_CALLBACK_URL (HLD error table)', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {}, callbackUrl: 'not-a-url' },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_CALLBACK_URL');
  });

  test('rejects async_push mode without callbackUrl', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async_push`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('MISSING_CALLBACK_URL');
  });

  test('rejects execute with extra body fields (.strict())', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {}, unknownField: 'bad' },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_INPUT');
  });

  // ─── Response Envelope — resolved version visibility ──────────────────

  test('async execute response envelope includes resolvedVersion and resolvedVersionId', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'active', deleted: false });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async&version=v0.1.0`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.resolvedVersion).toBe('v0.1.0');
    expect(res.body.data?.resolvedVersionId).toBe(VERSION_ID);
  });

  test('sync completed response includes resolvedVersion for default-resolved versions', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'active', deleted: false });

    const resPromise = requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    await waitForCondition(
      () => syncExec.pendingCount > 0 && mockEngine.lastPayload !== null,
      10_000,
    );
    syncExec.resolveNext({ status: 'completed', result: { ok: true } });

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.body.data?.resolvedVersion).toBe('v0.1.0');
    expect(res.body.data?.resolvedVersionId).toBe(VERSION_ID);
  });

  // ─── Rate limit wiring ─────────────────────────────────────────────────

  test('execute response sets X-RateLimit-* headers (rate-limit middleware attached)', async () => {
    await seedApiKey();
    await seedWorkflow();

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(202);
    // Rate-limit middleware applies per-tenant headers — presence proves
    // `tenantRateLimit` is wired on the execute route, not a mocked bypass.
    expect(res.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
  });

  // ─── Audit log emission ────────────────────────────────────────────────

  test('execute writes a workflow.executed audit log entry', async () => {
    await seedApiKey();
    await seedWorkflow();
    await seedWorkflowVersion({ state: 'active', deleted: false });

    const res = await requestJson<ExecuteResponse>(
      harness,
      `/api/v1/workflows/${WORKFLOW_ID}/execute?mode=async`,
      {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: { input: {} },
      },
    );

    expect(res.status).toBe(202);
    const executionId = res.body.data?.traceId;
    expect(executionId).toBeTruthy();

    const auditStore = getAuditStore();
    expect(auditStore).not.toBeNull();
    if (!auditStore) {
      throw new Error('Audit store should be initialized for workflow execute audit assertions');
    }

    // Fire-and-forget audit — poll until the record lands in the active store.
    const deadline = Date.now() + 5_000;
    let logs: AuditLog[] = [];
    while (Date.now() < deadline) {
      const result = await auditStore.query({
        tenantId: TENANT_ID,
        startTime: new Date(0),
        endTime: new Date(),
        limit: 200,
        offset: 0,
      });
      logs = result.logs.filter(
        (log) =>
          log.action === 'workflow.executed' &&
          (log.metadata as Record<string, unknown>).executionId === executionId,
      );
      if (logs.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(logs.length).toBeGreaterThan(0);
    const entry = logs[0];
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.workflowVersion).toBe('v0.1.0');
    expect(metadata.workflowVersionId).toBe(VERSION_ID);
    expect(metadata.mode).toBe('async');
    expect(metadata.apiKeyId).toBe(API_KEY_ID);
  });
});
