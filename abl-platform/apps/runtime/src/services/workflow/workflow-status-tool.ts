/** Workflow Status Tool — companion polling tool for async workflow executions. */
import type { ToolExecutor } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { z } from 'zod';

const log = createLogger('workflow-status-tool');

const REDIS_KEY_PREFIX = 'workflow';

export interface WorkflowStatusToolConfig {
  workflowEngineUrl: string;
  authToken: string;
  projectId: string;
  tenantId: string;
  sessionId: string;
  redis: { get: (key: string) => Promise<string | null> };
  getAsyncExecutionIds: () => ReadonlySet<string>;
}

export interface WorkflowStatusResult {
  status: string;
  output?: Record<string, unknown>;
  error?: string;
  executionId: string;
  workflowId: string;
  workflowName?: string;
}

const ExecutionIdSchema = z.object({
  executionId: z.string().min(1),
});

/**
 * Build the Redis key for an async workflow result.
 * Pattern: workflow:{tenantId}:{projectId}:async-result:{executionId}
 * Shared across status-tool (reads) and callback-handler (writes).
 */
export function buildRedisKey(tenantId: string, projectId: string, executionId: string): string {
  return `${REDIS_KEY_PREFIX}:${tenantId}:${projectId}:async-result:${executionId}`;
}

/**
 * Companion tool that agents use to poll async workflow execution results.
 * Two-tier fallback: Redis GET → workflow-engine GET.
 *
 * Session-scoped: rejects executionIds not tracked by the current executor
 * (optimization, not security gate — Redis/GET are project-scoped with auth).
 */
export class WorkflowStatusTool implements ToolExecutor {
  private readonly cfg: WorkflowStatusToolConfig;

  constructor(cfg: WorkflowStatusToolConfig) {
    this.cfg = cfg;
  }

  async execute(
    _toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const parsed = ExecutionIdSchema.safeParse(params);
    if (!parsed.success) {
      return { error: 'Invalid input: executionId is required and must be a non-empty string' };
    }
    const { executionId } = parsed.data;

    log.info('tool.workflow.status.polled', {
      executionId,
      sessionId: this.cfg.sessionId,
    });

    // Session-scoped fast rejection (optimization, not security gate — FR-2 relies on project-scoped backend)
    const knownIds = this.cfg.getAsyncExecutionIds();
    if (knownIds.size > 0 && !knownIds.has(executionId)) {
      log.debug('Execution ID not in session-local tracking set, proceeding with fallback', {
        executionId,
        sessionId: this.cfg.sessionId,
      });
    }

    // Tier 1: Redis cached result
    try {
      const redisKey = buildRedisKey(this.cfg.tenantId, this.cfg.projectId, executionId);
      const cached = await this.cfg.redis.get(redisKey);
      if (cached) {
        const entry = JSON.parse(cached) as Record<string, unknown>;
        log.debug('tool.workflow.status.redis_hit', { executionId });
        return {
          status: entry.status,
          output: entry.output ?? undefined,
          error: entry.error ?? undefined,
          executionId,
          workflowId: entry.workflowId ?? '',
          workflowName: (entry.workflowName as string) ?? undefined,
        };
      }
    } catch (err) {
      log.warn('Redis lookup failed, falling back to GET', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Tier 2: GET from workflow-engine
    const base = this.cfg.workflowEngineUrl.replace(/\/+$/, '');
    const statusUrl = `${base}/api/v1/projects/${this.cfg.projectId}/workflows/_/executions/${executionId}`;
    try {
      const resp = await fetch(statusUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.cfg.authToken}` },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          return { error: 'Execution not found or not authorized', executionId };
        }
        return {
          error: `Failed to fetch execution status: HTTP ${resp.status}`,
          executionId,
        };
      }
      const body = (await resp.json()) as { success: boolean; data?: Record<string, unknown> };
      const execution = body.data ?? {};
      log.debug('tool.workflow.status.get_hit', {
        executionId,
        status: execution.status,
      });
      return {
        status: execution.status ?? 'unknown',
        output: (execution.output as Record<string, unknown>) ?? undefined,
        error:
          typeof execution.error === 'string'
            ? execution.error
            : execution.error
              ? JSON.stringify(execution.error)
              : undefined,
        executionId,
        workflowId: (execution.workflowId as string) ?? '',
        workflowName: (execution.workflowName as string) ?? undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Workflow engine GET failed', { executionId, error: msg });
      return { error: `Failed to check execution status: ${msg}`, executionId };
    }
  }

  async executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>> {
    const results = await Promise.allSettled(
      calls.map((c) => this.execute(c.name, c.params, timeoutMs)),
    );
    return results.map((r, i) => ({
      name: calls[i].name,
      ...(r.status === 'fulfilled'
        ? { result: r.value }
        : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }),
    }));
  }
}
