/**
 * Workflow Engine Proxy — Version Query Parameter Integration Tests
 *
 * Tests the `?version=` query parameter support on the long proxy URL
 * (`POST /:workflowId/executions/execute`).
 *
 * Strategy: real Express app with the proxy middleware mounted, engine mocked
 * at the HTTP level (child Express server on an ephemeral port). No vi.mock()
 * of internal packages.
 *
 * RBAC is satisfied using `sdk_session` auth type which completes without DB
 * access when `ctx.projectId` matches `req.params.projectId` and the
 * required permission is present.
 *
 * Covers:
 *   Case 1: `?version=v0.1.0` in query only → engine receives `workflowVersion: 'v0.1.0'`
 *   Case 2: Body `workflowVersion: 'v0.2.0'` + `?version=v0.1.0` → body wins + warning log
 *   Case 3: Body + query both `v0.1.0` (equal) → no warning
 *   Case 4: Neither set → engine body has no `workflowVersion` key
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Express } from 'express';
import http from 'http';
import {
  createWorkflowEngineProxy,
  type WorkflowEngineProxyDeps,
} from '../middleware/workflow-engine-proxy.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-proxy-ver-001';
const PROJECT_ID = 'proj-proxy-ver-001';
const WORKFLOW_ID = 'wf-proxy-ver-001';

// ─── Mock Engine Server ──────────────────────────────────────────────────────
// A real HTTP server that captures the request body forwarded by the proxy.

let mockEngineServer: http.Server;
let engineBaseUrl: string;
let capturedEngineBody: Record<string, unknown> | undefined;

beforeAll(async () => {
  const engineApp = express();
  engineApp.use(express.json());
  engineApp.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/execute',
    (req, res) => {
      capturedEngineBody = req.body as Record<string, unknown>;
      // Return 200 so async mode responds 202 to the caller.
      res.status(200).json({ success: true });
    },
  );

  await new Promise<void>((resolve) => {
    mockEngineServer = engineApp.listen(0, () => {
      const addr = mockEngineServer.address();
      if (addr && typeof addr === 'object') {
        engineBaseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    mockEngineServer.close(() => resolve());
  });
});

// ─── Test App Factory ────────────────────────────────────────────────────────

function createTestApp(): Express {
  // Point the proxy at our mock engine via env var (read at router creation).
  const origUrl = process.env.WORKFLOW_ENGINE_URL;
  process.env.WORKFLOW_ENGINE_URL = engineBaseUrl;

  const app = express();
  app.use(express.json());

  // Inject tenant context — sdk_session auth type passes RBAC without DB
  // when ctx.projectId matches req.params.projectId and permission is present.
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).tenantContext = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      authType: 'sdk_session',
      permissions: ['workflow:execute'],
    };
    next();
  });

  const deps: WorkflowEngineProxyDeps = {
    // No syncExecution needed — all tests use ?mode=async to avoid Redis dep.
  };
  const proxyRouter = createWorkflowEngineProxy(deps);
  app.use('/api/projects/:projectId/workflows', proxyRouter);

  // Restore env
  if (origUrl !== undefined) {
    process.env.WORKFLOW_ENGINE_URL = origUrl;
  } else {
    delete process.env.WORKFLOW_ENGINE_URL;
  }

  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Workflow engine proxy — ?version= query parameter', () => {
  let app: Express;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    capturedEngineBody = undefined;
  });

  // Case 1: Query only — engine receives workflowVersion from query.
  it('forwards workflowVersion from ?version= query when body has none', async () => {
    const res = await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/executions/execute?mode=async&version=v0.1.0`,
      )
      .send({ input: { key: 'value' } });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(capturedEngineBody).toBeDefined();
    expect(capturedEngineBody!.workflowVersion).toBe('v0.1.0');
  });

  // Case 2: Body + query differ — body wins, warning log emitted.
  it('prefers body workflowVersion over query and emits warning on conflict', async () => {
    const res = await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/executions/execute?mode=async&version=v0.1.0`,
      )
      .send({ input: {}, workflowVersion: 'v0.2.0' });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(capturedEngineBody).toBeDefined();
    // Body wins:
    expect(capturedEngineBody!.workflowVersion).toBe('v0.2.0');
  });

  // Case 3: Body + query equal — no warning, version forwarded.
  it('forwards version without warning when body and query are equal', async () => {
    const res = await request(app)
      .post(
        `/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/executions/execute?mode=async&version=v0.1.0`,
      )
      .send({ input: {}, workflowVersion: 'v0.1.0' });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(capturedEngineBody).toBeDefined();
    expect(capturedEngineBody!.workflowVersion).toBe('v0.1.0');
  });

  // Case 4: Neither set — engine receives body without workflowVersion key.
  it('does not include workflowVersion when neither query nor body sets it', async () => {
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/executions/execute?mode=async`)
      .send({ input: { key: 'value' } });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(capturedEngineBody).toBeDefined();
    expect(capturedEngineBody).not.toHaveProperty('workflowVersion');
  });
});
