/**
 * HybridHumanTaskReader (LLD §5.3, Phase 5 Read Path).
 *
 * Unions the Mongo `HumanTask` collection (scoped to `mailbox='workflow'`)
 * with the CH `human_tasks_latest` ReplacingMergeTree projection. Flag-
 * gated via the caller-supplied `readFlags()` — flag off delegates to the
 * Mongo model only, matching current behaviour.
 *
 * Critical scope guard (HLD §5.3 errata E-5): `mailbox='workflow'` is
 * enforced at TWO layers:
 *   1. Mongo filter in `listWorkflowTasksPage()` — live-row guard.
 *   2. CH MV `human_tasks_latest_mv` WHERE-clause at projection time —
 *      sole CH-side guard. The projection table `human_tasks_latest`
 *      intentionally drops the `mailbox` column because the MV already
 *      filtered it. See `queryCh()` for why the CH SQL omits the predicate.
 *
 * Other mailboxes (agent-escalation, ticket, chat) are NOT in scope for
 * this event-sourcing pipeline and MUST continue reading from Mongo only.
 */

import { createLogger } from '@abl/compiler/platform';

/**
 * Local copy of the dual-read merger (see
 * `apps/workflow-engine/src/persistence/dual-read-merger.ts` for the
 * canonical unit-tested version). Duplicated locally to avoid a cross-app
 * import — the LLD §7 open question earmarks promoting this to a shared
 * `packages/database/src/migration-helpers/` module in a later refactor.
 */
function mergeMongoAndCH<T>(
  mongoRows: readonly T[],
  chRows: readonly T[],
  keyFn: (row: T) => string,
  sortFn: (row: T) => number | string,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of mongoRows) {
    byKey.set(keyFn(row), row);
  }
  for (const row of chRows) {
    const key = keyFn(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    const va = sortFn(a);
    const vb = sortFn(b);
    if (va === vb) return 0;
    return va < vb ? 1 : -1;
  });
  return merged;
}

const log = createLogger('runtime:hybrid-human-task-reader');

export interface HumanTaskRow {
  _id: string;
  tenantId: string;
  projectId: string;
  mailbox: string;
  status: string;
  type?: string;
  priority?: string;
  assignedTo?: string[];
  claimedBy?: string;
  executionId?: string;
  workflowId?: string;
  createdAt: Date | string | null;
  source?: 'mongo' | 'ch';
}

export type WorkflowTaskVisibility =
  | { kind: 'all' }
  | { kind: 'user_only'; userId: string }
  | { kind: 'user_or_open_pool'; userId: string };

export interface WorkflowTaskPage {
  rows: HumanTaskRow[];
  total: number;
}

export interface HybridHumanTaskMongoModel {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      skip(n: number): {
        limit(n: number): { lean(): Promise<HumanTaskRow[]> };
      };
    };
  };
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  distinctTaskIds(filter: Record<string, unknown>): Promise<string[]>;
}

export interface HumanTaskReadFlags {
  dualReadEnabled: boolean;
}

export interface HybridReaderChClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
  }): Promise<{ json<T>(): Promise<T[]> }>;
}

export interface HybridHumanTaskReaderDeps {
  mongoModel: HybridHumanTaskMongoModel;
  chClient: HybridReaderChClient;
  readFlags: () => HumanTaskReadFlags;
  onLatency?: (mode: 'mongo-only' | 'union', durationMs: number) => void;
}

export interface ListWorkflowTasksParams {
  tenantId: string;
  projectId: string;
  /** Any of these status values matches — MUST be a non-empty list. */
  statuses: string[];
  type?: string;
  priority?: string;
  visibility: WorkflowTaskVisibility;
  limit: number;
  offset: number;
}

const CH_DATABASE = 'abl_platform';

interface ChHumanTaskLatestRow {
  task_id: string;
  tenant_id: string;
  project_id: string;
  execution_id: string;
  workflow_id: string;
  task_type: string;
  status: string;
  priority: string;
  assigned_to: string[];
  claimed_by: string;
  created_at: string;
  last_event_at: string;
  _version: string;
}

interface ChScope {
  conditions: string[];
  params: Record<string, unknown>;
}

function chToRow(ch: ChHumanTaskLatestRow): HumanTaskRow {
  return {
    _id: ch.task_id,
    tenantId: ch.tenant_id,
    projectId: ch.project_id,
    mailbox: 'workflow',
    status: ch.status,
    type: ch.task_type,
    priority: ch.priority,
    assignedTo: ch.assigned_to,
    claimedBy: ch.claimed_by || undefined,
    executionId: ch.execution_id,
    workflowId: ch.workflow_id,
    createdAt: ch.created_at,
    source: 'ch',
  };
}

export class HybridHumanTaskReader {
  constructor(private readonly deps: HybridHumanTaskReaderDeps) {}

  /**
   * List workflow-mailbox tasks. Non-workflow mailboxes must use the
   * Mongo-only path — this reader rejects them by design.
   */
  async listWorkflowTasksPage(params: ListWorkflowTasksParams): Promise<WorkflowTaskPage> {
    const flags = this.deps.readFlags();
    const start = Date.now();
    const scanLimit = params.offset + params.limit;

    // Build the Mongo filter — always scoped to `mailbox='workflow'` here.
    const mongoFilter: Record<string, unknown> = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      mailbox: 'workflow',
      ...buildMongoVisibilityFilter(params.visibility),
    };
    if (params.statuses.length === 1) {
      mongoFilter.status = params.statuses[0];
    } else if (params.statuses.length > 1) {
      mongoFilter.status = { $in: params.statuses };
    }
    if (params.type) mongoFilter.type = params.type;
    if (params.priority) mongoFilter.priority = params.priority;

    const [mongoRows, mongoCount] = await Promise.all([
      this.deps.mongoModel
        .find(mongoFilter)
        .sort({ createdAt: -1 })
        .skip(0)
        .limit(scanLimit)
        .lean(),
      this.deps.mongoModel.countDocuments(mongoFilter),
    ]);

    if (!flags.dualReadEnabled) {
      this.deps.onLatency?.('mongo-only', Date.now() - start);
      return {
        rows: mongoRows
          .map((row) => ({ ...row, source: 'mongo' as const }))
          .slice(params.offset, scanLimit),
        total: mongoCount,
      };
    }

    const [chRows, chCount, mongoIds] = await Promise.all([
      this.queryChRows({
        tenantId: params.tenantId,
        projectId: params.projectId,
        statuses: params.statuses,
        type: params.type,
        priority: params.priority,
        visibility: params.visibility,
        limit: scanLimit,
      }),
      this.queryChCount({
        tenantId: params.tenantId,
        projectId: params.projectId,
        statuses: params.statuses,
        type: params.type,
        priority: params.priority,
        visibility: params.visibility,
      }),
      mongoCount > 0 ? this.deps.mongoModel.distinctTaskIds(mongoFilter) : Promise.resolve([]),
    ]);

    const chOnlyCount =
      mongoIds.length === 0 || chCount === 0
        ? chCount
        : await this.queryChCount({
            tenantId: params.tenantId,
            projectId: params.projectId,
            statuses: params.statuses,
            type: params.type,
            priority: params.priority,
            visibility: params.visibility,
            excludeTaskIds: mongoIds,
          });

    const merged = mergeMongoAndCH(
      mongoRows.map((row) => ({ ...row, source: 'mongo' as const })),
      chRows.map(chToRow),
      (row) => row._id,
      (row) => (row.createdAt ? new Date(row.createdAt).getTime() : 0),
    );

    this.deps.onLatency?.('union', Date.now() - start);
    return {
      rows: merged.slice(params.offset, scanLimit),
      total: mongoCount + chOnlyCount,
    };
  }

  private async queryChRows(args: {
    tenantId: string;
    projectId: string;
    statuses: string[];
    type?: string;
    priority?: string;
    visibility: WorkflowTaskVisibility;
    limit: number;
  }): Promise<ChHumanTaskLatestRow[]> {
    const { conditions, params } = this.buildChScope(args);
    params.limit = args.limit;

    try {
      const result = await this.deps.chClient.query({
        query: `
          SELECT task_id, tenant_id, project_id, execution_id, workflow_id,
                 task_type, status, priority, assigned_to, claimed_by,
                 created_at, last_event_at, _version
          FROM ${CH_DATABASE}.human_tasks_latest FINAL
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT {limit:UInt32}
          SETTINGS max_execution_time = 10
        `,
        query_params: params,
        format: 'JSONEachRow',
      });
      return await result.json<ChHumanTaskLatestRow>();
    } catch (err) {
      log.warn('CH human_tasks_latest query failed — falling back to Mongo-only', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async queryChCount(args: {
    tenantId: string;
    projectId: string;
    statuses: string[];
    type?: string;
    priority?: string;
    visibility: WorkflowTaskVisibility;
    excludeTaskIds?: string[];
  }): Promise<number> {
    const { conditions, params } = this.buildChScope(args);
    if (args.excludeTaskIds && args.excludeTaskIds.length > 0) {
      conditions.push('task_id NOT IN {excludeTaskIds:Array(String)}');
      params.excludeTaskIds = args.excludeTaskIds;
    }

    try {
      const result = await this.deps.chClient.query({
        query: `
          SELECT count() AS row_count
          FROM ${CH_DATABASE}.human_tasks_latest FINAL
          WHERE ${conditions.join(' AND ')}
          SETTINGS max_execution_time = 10
        `,
        query_params: params,
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ row_count: number | string }>();
      const value = rows[0]?.row_count;
      return typeof value === 'string' ? Number.parseInt(value, 10) : (value ?? 0);
    } catch (err) {
      log.warn('CH human_tasks_latest count failed — falling back to Mongo-only', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  private buildChScope(args: {
    tenantId: string;
    projectId: string;
    statuses: string[];
    type?: string;
    priority?: string;
    visibility: WorkflowTaskVisibility;
  }): ChScope {
    // Scope guard for `mailbox='workflow'` lives at TWO layers:
    //   1. Mongo filter in `listWorkflowTasksPage()` — belt-and-suspenders for live rows.
    //   2. CH materialised view (`human_tasks_latest_mv`) WHERE-clause during projection — the sole CH-side guard.
    //
    // The `human_tasks_latest` projection table has NO `mailbox` column
    // (it was dropped during projection because the MV filter made it
    // redundant). Adding `mailbox = 'workflow'` to this SQL would raise
    // `UNKNOWN_IDENTIFIER`. So we intentionally OMIT it — trust the MV.
    const conditions = ['tenant_id = {tenantId:String}', 'project_id = {projectId:String}'];
    const params: Record<string, unknown> = {
      tenantId: args.tenantId,
      projectId: args.projectId,
    };
    if (args.statuses.length > 0) {
      conditions.push('status IN {statuses:Array(String)}');
      params.statuses = args.statuses;
    }
    if (args.type) {
      conditions.push('task_type = {taskType:String}');
      params.taskType = args.type;
    }
    if (args.priority) {
      conditions.push('priority = {priority:String}');
      params.priority = args.priority;
    }
    appendChVisibilityClause(conditions, params, args.visibility);

    return { conditions, params };
  }
}

function buildMongoVisibilityFilter(visibility: WorkflowTaskVisibility): Record<string, unknown> {
  switch (visibility.kind) {
    case 'all':
      return {};
    case 'user_only':
      return {
        $or: [{ assignedTo: visibility.userId }, { claimedBy: visibility.userId }],
      };
    case 'user_or_open_pool':
      return {
        $or: [
          { assignedTo: visibility.userId },
          { claimedBy: visibility.userId },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
          { assignedTo: { $size: 0 } },
        ],
      };
  }
}

function appendChVisibilityClause(
  conditions: string[],
  params: Record<string, unknown>,
  visibility: WorkflowTaskVisibility,
): void {
  if (visibility.kind === 'all') {
    return;
  }

  params.visibilityUserId = visibility.userId;
  if (visibility.kind === 'user_only') {
    conditions.push(
      '(has(assigned_to, {visibilityUserId:String}) OR claimed_by = {visibilityUserId:String})',
    );
    return;
  }

  conditions.push(
    '(has(assigned_to, {visibilityUserId:String}) OR claimed_by = {visibilityUserId:String} OR length(assigned_to) = 0)',
  );
}
