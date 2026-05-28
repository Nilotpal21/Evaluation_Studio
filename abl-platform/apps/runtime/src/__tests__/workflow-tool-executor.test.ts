/**
 * Unit tests for WorkflowToolExecutor — async/sync workflow tool execution.
 *
 * Tests FR-4 (callbackUrl in triggerMetadata), FR-8 (async response enrichment),
 * and FR-10 (telemetry events). Uses a lightweight HTTP server to capture
 * the POST body sent to the workflow engine.
 *
 * No mocks of platform components.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  WorkflowToolExecutor,
  type WorkflowToolExecutorConfig,
  type WorkflowExecuteResult,
} from '../services/workflow/workflow-tool-executor.js';
import type { WorkflowBindingIR } from '@abl/compiler';

// ─── Fake Workflow Engine ────────────────────────────────────────────────────

interface CapturedRequest {
  body: Record<string, unknown>;
  path: string;
}

function createFakeWorkflowEngine() {
  const captured: CapturedRequest[] = [];
  let nextExecutionId = 'exec-test-1';
  let executionStatus = 'completed';
  let executionOutput: Record<string, unknown> = { result: 'done' };

  const app = express();
  app.use(express.json());

  // POST — execute workflow
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
        data: {
          status: executionStatus,
          output: executionOutput,
          workflowId: 'wf-1',
          workflowName: 'Test Workflow',
        },
      });
    },
  );

  // POST — cancel
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
    setExecutionResult: (status: string, output: Record<string, unknown>) => {
      executionStatus = status;
      executionOutput = output;
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

function createExecutorConfig(
  engineUrl: string,
  overrides: Partial<WorkflowToolExecutorConfig> = {},
): WorkflowToolExecutorConfig {
  return {
    workflowEngineUrl: engineUrl,
    authToken: 'test-token',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    defaultTimeoutMs: 30_000,
    ...overrides,
  };
}

function asyncBinding(overrides: Partial<WorkflowBindingIR> = {}): WorkflowBindingIR {
  return {
    workflowId: 'wf-1',
    triggerId: 'trigger-1',
    mode: 'async',
    paramMapping: {},
    timeoutMs: 30_000,
    ...overrides,
  };
}

function syncBinding(overrides: Partial<WorkflowBindingIR> = {}): WorkflowBindingIR {
  return {
    workflowId: 'wf-1',
    triggerId: 'trigger-1',
    mode: 'sync',
    paramMapping: {},
    timeoutMs: 30_000,
    ...overrides,
  };
}

const defaultMeta = {
  name: 'run_workflow',
  description: 'Test workflow',
  inputVariables: [
    { name: 'topic', type: 'string' as const, required: true, description: 'The topic' },
  ],
  triggerMode: 'async' as const,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowToolExecutor', () => {
  let engineUrl: string;
  let engine: ReturnType<typeof createFakeWorkflowEngine>;

  beforeAll(async () => {
    engine = createFakeWorkflowEngine();
    engineUrl = await engine.start();
  });

  afterAll(async () => {
    await engine.close();
  });

  // ── FR-4: callbackUrl in triggerMetadata ──

  describe('callbackUrl in triggerMetadata (FR-4)', () => {
    it('includes callbackUrl for async mode when callbackBaseUrl is set', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(
        createExecutorConfig(engineUrl, { callbackBaseUrl: 'http://runtime:3112' }),
      );
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      const triggerMetadata = engine.captured[0].body.triggerMetadata as Record<string, unknown>;
      expect(triggerMetadata.callbackUrl).toBe(
        'http://runtime:3112/api/internal/workflow-callback',
      );
      expect(triggerMetadata.source).toBe('agent_tool');
      expect(triggerMetadata.sessionId).toBe('session-1');
      expect(triggerMetadata.triggerId).toBe('trigger-1');
    });

    it('allows workflow-originated callers to override triggerType', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(
        createExecutorConfig(engineUrl, { triggerType: 'workflow' }),
      );
      executor.registerBinding('run_workflow', syncBinding(), {
        ...defaultMeta,
        triggerMode: 'sync',
      });
      engine.setExecutionResult('completed', { data: 'ok' });

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      expect(engine.captured[0].body.triggerType).toBe('workflow');
      const triggerMetadata = engine.captured[0].body.triggerMetadata as Record<string, unknown>;
      expect(triggerMetadata.source).toBe('agent_tool');
    });

    it('does NOT include callbackUrl for sync mode', async () => {
      engine.captured.length = 0;
      engine.setExecutionResult('completed', { data: 'ok' });
      const executor = new WorkflowToolExecutor(
        createExecutorConfig(engineUrl, { callbackBaseUrl: 'http://runtime:3112' }),
      );
      executor.registerBinding('run_workflow', syncBinding(), {
        ...defaultMeta,
        triggerMode: 'sync',
      });

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      const triggerMetadata = engine.captured[0].body.triggerMetadata as Record<string, unknown>;
      expect(triggerMetadata.callbackUrl).toBeUndefined();
    });

    it('does NOT include callbackUrl when callbackBaseUrl is not set', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      const triggerMetadata = engine.captured[0].body.triggerMetadata as Record<string, unknown>;
      expect(triggerMetadata.callbackUrl).toBeUndefined();
    });

    it('uses binding timeout as a per-tool cap for sync workflow execution', async () => {
      engine.captured.length = 0;
      engine.setExecutionResult('running', {});
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', syncBinding({ timeoutMs: 1 }), {
        ...defaultMeta,
        triggerMode: 'sync',
      });

      try {
        await expect(executor.execute('run_workflow', { topic: 'test' }, 30_000)).rejects.toThrow(
          'workflow execution timed out after 1ms',
        );
      } finally {
        engine.setExecutionResult('completed', { result: 'done' });
      }
    });

    it('normalizes trailing slashes on callbackBaseUrl', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(
        createExecutorConfig(engineUrl, { callbackBaseUrl: 'http://runtime:3112///' }),
      );
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      const triggerMetadata = engine.captured[0].body.triggerMetadata as Record<string, unknown>;
      expect(triggerMetadata.callbackUrl).toBe(
        'http://runtime:3112/api/internal/workflow-callback',
      );
    });

    it('forwards workflowVersionId when the binding is version-pinned', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding(
        'run_workflow',
        asyncBinding({ workflowVersionId: 'wfv-123' }),
        defaultMeta,
      );

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      expect(engine.captured[0].body.workflowVersionId).toBe('wfv-123');
    });

    it('forwards deployment-resolved workflowVersion for an unpinned binding', async () => {
      engine.captured.length = 0;
      const executor = new WorkflowToolExecutor(
        createExecutorConfig(engineUrl, {
          resolvedWorkflowVersions: {
            run_workflow: {
              workflowId: 'wf-1',
              workflowVersion: 'v3.1.0',
            },
          },
        }),
      );
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(engine.captured).toHaveLength(1);
      expect(engine.captured[0].body.workflowVersion).toBe('v3.1.0');
      expect(engine.captured[0].body.workflowVersionId).toBeUndefined();
    });
  });

  // ── FR-8: Async response enrichment ──

  describe('async response enrichment (FR-8)', () => {
    it('returns executionId, running status, and polling instructions for async mode', async () => {
      engine.setNextExecutionId('exec-async-1');
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      const result = (await executor.execute(
        'run_workflow',
        { topic: 'test' },
        30_000,
      )) as WorkflowExecuteResult;

      expect(result.executionId).toBe('exec-async-1');
      expect(result.status).toBe('running');
      expect(result.message).toBeDefined();
      expect(result.message).toContain('check_workflow_status');
      expect(result.message).toContain('exec-async-1');
    });

    it('does NOT include polling message for sync mode', async () => {
      engine.setNextExecutionId('exec-sync-1');
      engine.setExecutionResult('completed', { data: 'sync-result' });
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', syncBinding(), {
        ...defaultMeta,
        triggerMode: 'sync',
      });

      const result = (await executor.execute(
        'run_workflow',
        { topic: 'test' },
        30_000,
      )) as WorkflowExecuteResult;

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ data: 'sync-result' });
      expect(result.message).toBeUndefined();
    });
  });

  // ── FR-2: Session-scoped execution tracking ──

  describe('session-scoped execution tracking (FR-2)', () => {
    it('tracks async execution IDs in session scope', async () => {
      engine.setNextExecutionId('exec-tracked-1');
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', asyncBinding(), defaultMeta);

      expect(executor.getAsyncExecutionIds().size).toBe(0);

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(executor.getAsyncExecutionIds().has('exec-tracked-1')).toBe(true);
    });

    it('does NOT track sync execution IDs', async () => {
      engine.setNextExecutionId('exec-sync-tracked');
      engine.setExecutionResult('completed', {});
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));
      executor.registerBinding('run_workflow', syncBinding(), {
        ...defaultMeta,
        triggerMode: 'sync',
      });

      await executor.execute('run_workflow', { topic: 'test' }, 30_000);

      expect(executor.getAsyncExecutionIds().has('exec-sync-tracked')).toBe(false);
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('throws ToolExecutionError for unregistered tool', async () => {
      const executor = new WorkflowToolExecutor(createExecutorConfig(engineUrl));

      await expect(executor.execute('unknown_tool', {}, 30_000)).rejects.toThrow(
        'no registered binding',
      );
    });
  });
});
