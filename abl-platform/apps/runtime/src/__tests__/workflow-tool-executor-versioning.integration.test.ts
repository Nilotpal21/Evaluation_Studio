/**
 * INT-5 — WorkflowToolExecutor forwards binding.workflowVersion to engine body.
 *
 * Verifies:
 * - Binding with `workflowVersion: 'v0.1.0'` → engine request body contains the
 *   field at top level (not inside triggerMetadata).
 * - Binding without `workflowVersion` → engine request body omits the field entirely.
 *
 * Uses a lightweight HTTP server to capture the POST body — no mocks of platform
 * components.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  WorkflowToolExecutor,
  type WorkflowToolExecutorConfig,
} from '../services/workflow/workflow-tool-executor.js';
import type { WorkflowBindingIR } from '@abl/compiler';

// ─── Fake Workflow Engine ────────────────────────────────────────────────────

interface CapturedRequest {
  body: Record<string, unknown>;
  path: string;
}

function createFakeWorkflowEngine() {
  const captured: CapturedRequest[] = [];
  let nextExecutionId = 'exec-version-1';

  const app = express();
  app.use(express.json());

  // POST /execute — capture the body and respond with success
  app.post('/api/v1/projects/:projectId/workflows/:workflowId/executions/execute', (req, res) => {
    captured.push({ body: req.body, path: req.path });
    res.status(202).json({ success: true, executionId: nextExecutionId });
  });

  // GET — execution status (for sync polling)
  app.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId',
    (_req, res) => {
      res.json({
        success: true,
        data: { status: 'completed', output: { ok: true } },
      });
    },
  );

  // POST — cancel stub
  app.post(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel',
    (_req, res) => {
      res.json({ success: true });
    },
  );

  const server = http.createServer(app);
  return {
    captured,
    setNextExecutionId: (id: string) => {
      nextExecutionId = id;
    },
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCfg(
  engineUrl: string,
  overrides: Partial<WorkflowToolExecutorConfig> = {},
): WorkflowToolExecutorConfig {
  return {
    workflowEngineUrl: engineUrl,
    authToken: 'tok-test',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    agentName: 'agent-1',
    defaultTimeoutMs: 30_000,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<WorkflowBindingIR> = {}): WorkflowBindingIR {
  return {
    workflowId: 'wf-version-1',
    triggerId: 'tr-1',
    mode: 'async',
    paramMapping: {},
    ...overrides,
  };
}

const meta = {
  name: 'version_tool',
  description: 'test',
  inputVariables: [],
  triggerMode: 'async' as const,
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('WorkflowToolExecutor — workflowVersion forwarding (INT-5)', () => {
  let engineUrl: string;
  let engine: ReturnType<typeof createFakeWorkflowEngine>;

  beforeAll(async () => {
    engine = createFakeWorkflowEngine();
    engineUrl = await engine.start();
  });

  afterAll(async () => {
    await engine.close();
  });

  it('forwards binding.workflowVersion as a top-level body field', async () => {
    const executor = new WorkflowToolExecutor(makeCfg(engineUrl));
    executor.registerBinding('versioned_tool', makeBinding({ workflowVersion: 'v0.1.0' }), meta);

    engine.captured.length = 0;
    await executor.execute('versioned_tool', { input: 'hello' }, 30_000);

    expect(engine.captured).toHaveLength(1);
    const body = engine.captured[0].body;
    // workflowVersion must be at top level, NOT inside triggerMetadata
    expect(body.workflowVersion).toBe('v0.1.0');
    expect((body.triggerMetadata as Record<string, unknown>).workflowVersion).toBeUndefined();
  });

  it('omits workflowVersion from body when binding has no version', async () => {
    const executor = new WorkflowToolExecutor(makeCfg(engineUrl));
    executor.registerBinding('unversioned_tool', makeBinding(), meta);

    engine.captured.length = 0;
    await executor.execute('unversioned_tool', { input: 'world' }, 30_000);

    expect(engine.captured).toHaveLength(1);
    const body = engine.captured[0].body;
    expect(body).not.toHaveProperty('workflowVersion');
  });

  it('omits workflowVersion when binding.workflowVersion is undefined', async () => {
    const executor = new WorkflowToolExecutor(makeCfg(engineUrl));
    executor.registerBinding('explicit_undef', makeBinding({ workflowVersion: undefined }), meta);

    engine.captured.length = 0;
    await executor.execute('explicit_undef', { input: 'test' }, 30_000);

    expect(engine.captured).toHaveLength(1);
    expect(engine.captured[0].body).not.toHaveProperty('workflowVersion');
  });
});
