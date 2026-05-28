/**
 * HybridExecutionReader (LLD §5.2, Phase 5 Read Path).
 *
 * Sits in front of the `WorkflowExecution` Mongo model and — when
 * `WORKFLOW_DUAL_READ_ENABLED=true` — unions Mongo rows with the CH
 * `workflow_executions_latest` ReplacingMergeTree projection for historical
 * executions whose Mongo rows have been reaped by Phase 6 TTL. Mongo wins
 * on overlap (HLD §4 concern #5).
 *
 * Design notes
 * ------------
 *  - Flag-off path: delegates directly to the Mongo model — current
 *    behaviour, zero performance impact.
 *  - Flag-on path: fans out to Mongo + CH in parallel, merges via
 *    `mergeMongoAndCH`, emits a latency histogram sample per call.
 *  - CH query applies tenant + project + workflow filters in the
 *    `query_params` (never string-interpolated) — Core Invariant #1
 *    tenant-isolation.
 *  - `_version` is used as the CH primary dedup key (monotonic, backed by
 *    `occurred_at` → ms timestamp) so the ReplacingMergeTree `_latest`
 *    projection returns the freshest row when `FINAL` is used. FINAL is
 *    required for deterministic reads during active ingest — acceptable
 *    here because the list endpoint caps at MAX_PAGE_LIMIT rows.
 */

import { createLogger } from '@abl/compiler/platform';
import { mergeMongoAndCH } from './dual-read-merger.js';

/**
 * Minimal structural CH client shape — avoids dragging `@clickhouse/client`
 * into workflow-engine's deps. The actual runtime client satisfies this
 * interface by exposing `query({ query, query_params, format })` returning
 * `{ json(): Promise<T[]> }`.
 */
export interface HybridReaderChClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
  }): Promise<{ json<T>(): Promise<T[]> }>;
}

const log = createLogger('workflow-engine:hybrid-execution-reader');

/**
 * Minimal shape of a workflow execution row as returned by both Mongo and
 * CH. List endpoints return this shape — detail endpoints stay Mongo-only
 * since the rich `nodeExecutions` / `context` fields are not projected to CH.
 */
export interface WorkflowExecutionRow {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersion?: string;
  status: string;
  triggerType?: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  durationMs?: number;
  /** Present when the row came from Mongo (Mongoose doc / lean). */
  source?: 'mongo' | 'ch';
}

/** Mongo-side surface consumed by the reader (narrower than the full model). */
export interface HybridExecutionMongoModel {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): {
        lean(): Promise<WorkflowExecutionRow[]>;
      };
    };
  };
  findOne(filter: Record<string, unknown>): {
    lean(): Promise<WorkflowExecutionRow | null>;
  };
}

export interface HybridReadFlags {
  dualReadEnabled: boolean;
}

export interface HybridExecutionReaderDeps {
  mongoModel: HybridExecutionMongoModel;
  chClient: HybridReaderChClient;
  readFlags: () => HybridReadFlags;
  /**
   * Optional latency observer (ms). Wired to the OTel histogram by the
   * caller so tests can inject a spy.
   */
  onLatency?: (mode: 'mongo-only' | 'union', durationMs: number) => void;
}

export interface ListByWorkflowParams {
  tenantId: string;
  projectId: string;
  workflowId: string;
  limit: number;
  status?: string;
}

export interface GetByIdParams {
  tenantId: string;
  projectId: string;
  workflowId?: string;
  executionId: string;
}

const CH_DATABASE = 'abl_platform';

interface ChLatestRow {
  execution_id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  trigger_type: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  last_event_at: string;
  _version: string;
}

function toRow(ch: ChLatestRow): WorkflowExecutionRow {
  return {
    _id: ch.execution_id,
    tenantId: ch.tenant_id,
    projectId: ch.project_id,
    workflowId: ch.workflow_id,
    workflowVersion: ch.workflow_version,
    status: ch.status,
    triggerType: ch.trigger_type,
    startedAt: ch.started_at,
    completedAt: ch.completed_at,
    durationMs: ch.duration_ms,
    source: 'ch',
  };
}

export class HybridExecutionReader {
  constructor(private readonly deps: HybridExecutionReaderDeps) {}

  async listByWorkflow(params: ListByWorkflowParams): Promise<WorkflowExecutionRow[]> {
    const flags = this.deps.readFlags();
    const start = Date.now();

    const filter: Record<string, unknown> = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
    };
    if (params.status) filter.status = params.status;

    const mongoRows = await this.deps.mongoModel
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(params.limit)
      .lean();

    if (!flags.dualReadEnabled) {
      this.deps.onLatency?.('mongo-only', Date.now() - start);
      return mongoRows.map((r) => ({ ...r, source: 'mongo' }));
    }

    const chRows = await this.queryChLatest({
      tenantId: params.tenantId,
      projectId: params.projectId,
      workflowId: params.workflowId,
      status: params.status,
      limit: params.limit,
    });

    const merged = mergeMongoAndCH(
      mongoRows.map((r) => ({ ...r, source: 'mongo' as const })),
      chRows.map(toRow),
      (r) => r._id,
      (r) => (r.startedAt ? new Date(r.startedAt).getTime() : 0),
    );

    this.deps.onLatency?.('union', Date.now() - start);
    // Respect the caller's page limit even when the union exceeds it.
    return merged.slice(0, params.limit);
  }

  /**
   * Test-only inspection helpers (LLD §5.7). Surface the Mongo-only, CH-
   * only, and union views side-by-side so parity tests assert equivalence.
   */
  async inspectMongoOnly(params: GetByIdParams): Promise<WorkflowExecutionRow | null> {
    const mongoFilter: Record<string, unknown> = {
      _id: params.executionId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    };
    if (params.workflowId) mongoFilter.workflowId = params.workflowId;
    const row = await this.deps.mongoModel.findOne(mongoFilter).lean();
    return row ? { ...row, source: 'mongo' } : null;
  }

  async inspectChOnly(params: GetByIdParams): Promise<WorkflowExecutionRow | null> {
    const rows = await this.queryChLatest({
      tenantId: params.tenantId,
      projectId: params.projectId,
      executionId: params.executionId,
      limit: 1,
    });
    return rows.length > 0 ? toRow(rows[0]!) : null;
  }

  async inspectUnion(params: GetByIdParams): Promise<WorkflowExecutionRow | null> {
    // Mongo wins on overlap; fall through to CH on miss. Mirrors getById()
    // but returns a single row rather than the decorated null-on-both-miss
    // that the production path uses.
    const [mongoRow, chRow] = await Promise.all([
      this.inspectMongoOnly(params),
      this.inspectChOnly(params),
    ]);
    return mongoRow ?? chRow ?? null;
  }

  async getById(params: GetByIdParams): Promise<WorkflowExecutionRow | null> {
    const flags = this.deps.readFlags();
    const start = Date.now();

    const mongoFilter: Record<string, unknown> = {
      _id: params.executionId,
      tenantId: params.tenantId,
      projectId: params.projectId,
    };
    if (params.workflowId) mongoFilter.workflowId = params.workflowId;

    const mongoRow = await this.deps.mongoModel.findOne(mongoFilter).lean();
    if (mongoRow) {
      this.deps.onLatency?.(flags.dualReadEnabled ? 'union' : 'mongo-only', Date.now() - start);
      return { ...mongoRow, source: 'mongo' };
    }

    if (!flags.dualReadEnabled) {
      this.deps.onLatency?.('mongo-only', Date.now() - start);
      return null;
    }

    // Mongo miss — try CH (historical / post-TTL path).
    const chRows = await this.queryChLatest({
      tenantId: params.tenantId,
      projectId: params.projectId,
      executionId: params.executionId,
      limit: 1,
    });
    this.deps.onLatency?.('union', Date.now() - start);
    return chRows.length > 0 ? toRow(chRows[0]!) : null;
  }

  private async queryChLatest(args: {
    tenantId: string;
    projectId: string;
    workflowId?: string;
    executionId?: string;
    status?: string;
    limit: number;
  }): Promise<ChLatestRow[]> {
    const conditions = ['tenant_id = {tenantId:String}', 'project_id = {projectId:String}'];
    const params: Record<string, unknown> = {
      tenantId: args.tenantId,
      projectId: args.projectId,
      limit: args.limit,
    };
    if (args.workflowId) {
      conditions.push('workflow_id = {workflowId:String}');
      params.workflowId = args.workflowId;
    }
    if (args.executionId) {
      conditions.push('execution_id = {executionId:String}');
      params.executionId = args.executionId;
    }
    if (args.status) {
      conditions.push('status = {status:String}');
      params.status = args.status;
    }

    try {
      const result = await this.deps.chClient.query({
        query: `
          SELECT execution_id, tenant_id, project_id, workflow_id, workflow_version,
                 status, trigger_type, started_at, completed_at, duration_ms,
                 last_event_at, _version
          FROM ${CH_DATABASE}.workflow_executions_latest FINAL
          WHERE ${conditions.join(' AND ')}
          ORDER BY started_at DESC
          LIMIT {limit:UInt32}
          SETTINGS max_execution_time = 10
        `,
        query_params: params,
        format: 'JSONEachRow',
      });
      return await result.json<ChLatestRow>();
    } catch (err) {
      // CH failures are non-fatal — fall back to Mongo-only semantics.
      // `@clickhouse/client` throws plain objects without a `message` in some
      // paths (e.g. HTTP 401/403), so include the raw shape in the log so
      // operators can see auth/network issues instead of a blank error.
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null
            ? (JSON.stringify(err, Object.getOwnPropertyNames(err as Record<string, unknown>)) ??
              String(err))
            : String(err);
      log.warn('CH workflow_executions_latest query failed — falling back to Mongo-only', {
        error: message,
      });
      return [];
    }
  }
}
