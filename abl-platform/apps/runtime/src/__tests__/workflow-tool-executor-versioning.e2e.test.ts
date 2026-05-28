/**
 * E2E-6 — Full agent-tool-binding round-trip for workflowVersion.
 *
 * Verifies end-to-end:
 * 1. Register a binding with workflowVersion: 'v0.1.0' via WorkflowToolExecutor.
 * 2. Call execute() → engine request body contains workflowVersion: 'v0.1.0' at top level.
 * 3. Re-register the binding WITHOUT workflowVersion.
 * 4. Call execute() again → engine request body omits workflowVersion entirely.
 *
 * Uses a real Express HTTP server as the DI-injected "engine" — external service
 * boundary, so DI-based HTTP interception is permitted per CLAUDE.md.
 * No vi.mock of internal packages.
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

// ─── DI-mocked engine (external service boundary) ───────────────────────────

interface CapturedBody {
  body: Record<string, unknown>;
}

function createEngineStub() {
  const captured: CapturedBody[] = [];
  const execId = 'exec-e2e-version-1';

  const app = express();
  app.use(express.json());

  // POST /execute — capture body
  app.post('/api/v1/projects/:projectId/workflows/:workflowId/executions/execute', (req, res) => {
    captured.push({ body: req.body });
    res.status(202).json({ success: true, executionId: execId });
  });

  // GET — poll (sync mode needs this)
  app.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId',
    (_req, res) => {
      res.json({
        success: true,
        data: { status: 'completed', output: { msg: 'done' } },
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

function makeCfg(engineUrl: string): WorkflowToolExecutorConfig {
  return {
    workflowEngineUrl: engineUrl,
    authToken: 'e2e-token',
    projectId: 'proj-e2e-1',
    tenantId: 'tenant-e2e-1',
    sessionId: 'session-e2e-1',
    agentName: 'e2e-agent',
    defaultTimeoutMs: 30_000,
  };
}

function makeBinding(overrides: Partial<WorkflowBindingIR> = {}): WorkflowBindingIR {
  return {
    workflowId: 'wf-e2e-1',
    triggerId: 'tr-e2e-1',
    mode: 'async',
    paramMapping: {},
    ...overrides,
  };
}

const meta = {
  name: 'e2e_version_tool',
  description: 'E2E version round-trip',
  inputVariables: [],
  triggerMode: 'async' as const,
};

// ─── E2E-6 Suite ─────────────────────────────────────────────────────────────

describe('E2E-6: WorkflowToolExecutor — workflowVersion full round-trip', () => {
  let engineUrl: string;
  let engineStub: ReturnType<typeof createEngineStub>;

  beforeAll(async () => {
    engineStub = createEngineStub();
    engineUrl = await engineStub.start();
  });

  afterAll(async () => {
    await engineStub.close();
  });

  it('round-trips workflowVersion through register → execute → engine body', async () => {
    const executor = new WorkflowToolExecutor(makeCfg(engineUrl));
    const toolName = 'versioned_wf';

    // Step 1: Register binding WITH workflowVersion
    executor.registerBinding(toolName, makeBinding({ workflowVersion: 'v0.1.0' }), meta);

    engineStub.captured.length = 0;
    await executor.execute(toolName, { data: 'round-trip' }, 30_000);

    expect(engineStub.captured).toHaveLength(1);
    const body1 = engineStub.captured[0].body;
    // workflowVersion MUST be at the top level of the body
    expect(body1.workflowVersion).toBe('v0.1.0');
    // MUST NOT be inside triggerMetadata
    const meta1 = body1.triggerMetadata as Record<string, unknown>;
    expect(meta1.workflowVersion).toBeUndefined();

    // Step 2: Re-register WITHOUT workflowVersion (overrides previous binding)
    executor.registerBinding(toolName, makeBinding(), meta);

    engineStub.captured.length = 0;
    await executor.execute(toolName, { data: 'no-version' }, 30_000);

    expect(engineStub.captured).toHaveLength(1);
    const body2 = engineStub.captured[0].body;
    // workflowVersion MUST be absent from body entirely
    expect(body2).not.toHaveProperty('workflowVersion');
  });

  it('handles sync mode with workflowVersion correctly', async () => {
    const executor = new WorkflowToolExecutor(makeCfg(engineUrl));
    const toolName = 'sync_versioned';

    executor.registerBinding(toolName, makeBinding({ mode: 'sync', workflowVersion: 'v0.2.0' }), {
      ...meta,
      triggerMode: 'sync',
    });

    engineStub.captured.length = 0;
    const result = await executor.execute(toolName, { x: 1 }, 30_000);

    expect(engineStub.captured).toHaveLength(1);
    expect(engineStub.captured[0].body.workflowVersion).toBe('v0.2.0');
    expect(result.status).toBe('completed');
  });
});
