/**
 * Unit tests for WorkflowStatusTool — the companion polling tool for async workflow executions.
 *
 * Tests the two-tier fallback (Redis → GET), input validation, session-scoped tracking,
 * and error handling. Uses dependency injection for Redis and a lightweight HTTP server
 * for the workflow-engine GET endpoint.
 *
 * No mocks of platform components.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  WorkflowStatusTool,
  buildRedisKey,
  type WorkflowStatusToolConfig,
} from '../services/workflow/workflow-status-tool.js';

// ─── Fake Workflow Engine ────────────────────────────────────────────────────

interface FakeEngineState {
  executions: Map<
    string,
    { status: string; output?: Record<string, unknown>; error?: string; workflowId: string }
  >;
}

function createFakeWorkflowEngine(state: FakeEngineState) {
  const app = express();

  // GET — status query (wildcard workflowId since status-tool uses `_`)
  app.get(
    '/api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId',
    (req, res) => {
      const exec = state.executions.get(req.params.executionId);
      if (!exec) {
        return res.status(404).json({ success: false, error: 'Execution not found' });
      }
      return res.json({
        success: true,
        data: {
          executionId: req.params.executionId,
          status: exec.status,
          output: exec.output,
          error: exec.error,
          workflowId: exec.workflowId,
        },
      });
    },
  );

  const server = http.createServer(app);

  return {
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

function createRedisStub(data: Map<string, string> = new Map()) {
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
  };
}

function createConfig(
  overrides: Partial<WorkflowStatusToolConfig> & { workflowEngineUrl: string },
): WorkflowStatusToolConfig {
  return {
    authToken: 'test-token',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    redis: createRedisStub(),
    getAsyncExecutionIds: () => new Set<string>(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildRedisKey', () => {
  it('produces the correct key pattern', () => {
    expect(buildRedisKey('t1', 'p1', 'exec-1')).toBe('workflow:t1:p1:async-result:exec-1');
  });
});

describe('WorkflowStatusTool', () => {
  let engineUrl: string;
  let engineState: FakeEngineState;
  let engine: { close: () => Promise<void> };

  beforeAll(async () => {
    engineState = { executions: new Map() };
    const fake = createFakeWorkflowEngine(engineState);
    engineUrl = await fake.start();
    engine = fake;
  });

  afterAll(async () => {
    await engine.close();
  });

  // ── Input Validation ──

  it('rejects missing executionId', async () => {
    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl }));
    const result = (await tool.execute('check_workflow_status', {}, 10_000)) as { error: string };
    expect(result.error).toContain('executionId is required');
  });

  it('rejects empty string executionId', async () => {
    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl }));
    const result = (await tool.execute('check_workflow_status', { executionId: '' }, 10_000)) as {
      error: string;
    };
    expect(result.error).toContain('executionId is required');
  });

  // ── Redis Hit ──

  it('returns result from Redis cache', async () => {
    const redisData = new Map<string, string>();
    const key = buildRedisKey('tenant-1', 'proj-1', 'exec-redis-hit');
    redisData.set(
      key,
      JSON.stringify({
        status: 'completed',
        output: { summary: 'done' },
        error: null,
        workflowId: 'wf-1',
        workflowName: 'Test Workflow',
      }),
    );
    const redis = createRedisStub(redisData);

    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl, redis }));
    const result = (await tool.execute(
      'check_workflow_status',
      { executionId: 'exec-redis-hit' },
      10_000,
    )) as {
      status: string;
      output: Record<string, unknown>;
      workflowId: string;
      workflowName: string;
    };

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ summary: 'done' });
    expect(result.workflowId).toBe('wf-1');
    expect(result.workflowName).toBe('Test Workflow');
    expect(redis.get).toHaveBeenCalledWith(key);
  });

  // ── Redis Miss → GET Fallback ──

  it('falls back to GET when Redis misses', async () => {
    engineState.executions.set('exec-get-hit', {
      status: 'completed',
      output: { data: 'from-engine' },
      workflowId: 'wf-2',
    });

    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl }));
    const result = (await tool.execute(
      'check_workflow_status',
      { executionId: 'exec-get-hit' },
      10_000,
    )) as {
      status: string;
      output: Record<string, unknown>;
      workflowId: string;
    };

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ data: 'from-engine' });
    expect(result.workflowId).toBe('wf-2');
  });

  it('returns error when GET returns 404', async () => {
    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl }));
    const result = (await tool.execute(
      'check_workflow_status',
      { executionId: 'nonexistent' },
      10_000,
    )) as {
      error: string;
    };

    expect(result.error).toContain('not found');
  });

  // ── Redis Error → GET Fallback ──

  it('falls back to GET when Redis throws', async () => {
    engineState.executions.set('exec-redis-err', {
      status: 'failed',
      error: 'timeout',
      workflowId: 'wf-3',
    });

    const failingRedis = {
      get: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const tool = new WorkflowStatusTool(
      createConfig({ workflowEngineUrl: engineUrl, redis: failingRedis }),
    );
    const result = (await tool.execute(
      'check_workflow_status',
      { executionId: 'exec-redis-err' },
      10_000,
    )) as {
      status: string;
      error: string;
    };

    expect(result.status).toBe('failed');
    expect(result.error).toBe('timeout');
  });

  // ── Session-Scoped Tracking (optimization, not gate) ──

  it('proceeds even when executionId is not in session tracking set', async () => {
    engineState.executions.set('exec-unknown-session', {
      status: 'completed',
      output: { ok: true },
      workflowId: 'wf-4',
    });

    const tool = new WorkflowStatusTool(
      createConfig({
        workflowEngineUrl: engineUrl,
        getAsyncExecutionIds: () => new Set(['other-exec-id']),
      }),
    );
    const result = (await tool.execute(
      'check_workflow_status',
      { executionId: 'exec-unknown-session' },
      10_000,
    )) as {
      status: string;
    };

    // Should still return data — session check is optimization, not security gate
    expect(result.status).toBe('completed');
  });

  // ── executeParallel ──

  it('handles parallel execution of multiple status checks', async () => {
    engineState.executions.set('exec-p1', {
      status: 'completed',
      output: { result: 'a' },
      workflowId: 'wf-p1',
    });
    engineState.executions.set('exec-p2', {
      status: 'running',
      workflowId: 'wf-p2',
    });

    const tool = new WorkflowStatusTool(createConfig({ workflowEngineUrl: engineUrl }));
    const results = await tool.executeParallel(
      [
        { name: 'check_workflow_status', params: { executionId: 'exec-p1' } },
        { name: 'check_workflow_status', params: { executionId: 'exec-p2' } },
      ],
      10_000,
    );

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('check_workflow_status');
    expect(results[0].result).toBeDefined();
    expect(results[1].name).toBe('check_workflow_status');
    expect(results[1].result).toBeDefined();
  });
});
