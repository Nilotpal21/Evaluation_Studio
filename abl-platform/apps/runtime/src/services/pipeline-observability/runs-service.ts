/**
 * Pipeline Runs Service — Project-Scoped
 *
 * Aggregated queries over PipelineRunRecord for the Recent Runs tab and the
 * health summary that drives pipeline-card badges.
 *
 * All queries are {tenantId, projectId}-scoped. Never exposes runs from a
 * different project or tenant.
 */

import type { IPipelineRunRecord } from '@agent-platform/pipeline-engine/schemas';

// ─── Types ────────────────────────────────────────────────────────────────

export interface RunSummary {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  pipelineKind: 'builtin' | 'custom';
  status: IPipelineRunRecord['status'];
  trigger: IPipelineRunRecord['trigger'];
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: { message: string };
}

export interface ListProjectRunsArgs {
  tenantId: string;
  projectId: string;
  type?: 'builtin' | 'custom' | 'all';
  pipelineId?: string;
  status?: IPipelineRunRecord['status'];
  since?: Date;
  until?: Date;
  limit: number;
  offset: number;
}

export interface RunHealthSummary {
  total: number;
  completed: number;
  failed: number;
  running: number;
  cancelled: number;
  successRate: number;
  avgDurationMs: number;
  byPipeline?: Array<{
    pipelineId: string;
    total: number;
    failed: number;
    successRate: number;
  }>;
}

// ─── Listing ──────────────────────────────────────────────────────────────

export async function listProjectRuns(args: ListProjectRunsArgs): Promise<{
  data: RunSummary[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}> {
  const { PipelineRunRecordModel } = await import('@agent-platform/pipeline-engine/schemas');

  const filter: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
  };
  if (args.pipelineId) filter.pipelineId = args.pipelineId;
  if (args.status) filter.status = args.status;
  if (args.since || args.until) {
    filter.startedAt = {};
    if (args.since) (filter.startedAt as Record<string, unknown>).$gte = args.since;
    if (args.until) (filter.startedAt as Record<string, unknown>).$lte = args.until;
  }

  const [rows, total] = await Promise.all([
    PipelineRunRecordModel.aggregate([
      { $match: filter },
      { $sort: { startedAt: -1 } },
      { $skip: args.offset },
      { $limit: args.limit },
      {
        $lookup: {
          from: 'pipeline_definitions',
          localField: 'pipelineId',
          foreignField: '_id',
          as: 'def',
        },
      },
      { $unwind: { path: '$def', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          runId: 1,
          pipelineId: 1,
          pipelineName: { $ifNull: ['$def.name', '$pipelineId'] },
          pipelineKind: {
            $cond: [{ $eq: ['$def.tenantId', '__platform__'] }, 'builtin', 'custom'],
          },
          status: 1,
          trigger: 1,
          startedAt: 1,
          completedAt: 1,
          durationMs: 1,
          error: { message: '$error.message' },
        },
      },
    ]),
    PipelineRunRecordModel.countDocuments(filter),
  ]);

  let data = rows as RunSummary[];
  if (args.type && args.type !== 'all') {
    data = data.filter((r) => r.pipelineKind === args.type);
  }

  return {
    data,
    pagination: {
      total,
      limit: args.limit,
      offset: args.offset,
      hasMore: args.offset + data.length < total,
    },
  };
}

// ─── Health ───────────────────────────────────────────────────────────────

export async function getProjectRunHealth(args: {
  tenantId: string;
  projectId: string;
  window: '1h' | '24h' | '7d';
  pipelineId?: string;
}): Promise<RunHealthSummary> {
  const { PipelineRunRecordModel } = await import('@agent-platform/pipeline-engine/schemas');

  const windowMs = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[args.window];
  const since = new Date(Date.now() - windowMs);

  const match: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
    startedAt: { $gte: since },
  };
  if (args.pipelineId) match.pipelineId = args.pipelineId;

  const [totals, byPipelineRaw] = await Promise.all([
    PipelineRunRecordModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          running: {
            $sum: {
              $cond: [{ $in: ['$status', ['running', 'pending']] }, 1, 0],
            },
          },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          avgDurationMs: { $avg: '$durationMs' },
        },
      },
    ]),
    args.pipelineId
      ? Promise.resolve([])
      : PipelineRunRecordModel.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$pipelineId',
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            },
          },
        ]),
  ]);

  const t = (totals[0] ?? {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    cancelled: 0,
    avgDurationMs: 0,
  }) as {
    total: number;
    completed: number;
    failed: number;
    running: number;
    cancelled: number;
    avgDurationMs: number | null;
  };
  const terminal = t.completed + t.failed + t.cancelled;
  const successRate = terminal === 0 ? 1 : t.completed / terminal;

  const summary: RunHealthSummary = {
    total: t.total,
    completed: t.completed,
    failed: t.failed,
    running: t.running,
    cancelled: t.cancelled,
    successRate,
    avgDurationMs: t.avgDurationMs ?? 0,
  };

  if (!args.pipelineId) {
    summary.byPipeline = (
      byPipelineRaw as Array<{
        _id: string;
        total: number;
        failed: number;
        completed: number;
      }>
    ).map((p) => ({
      pipelineId: p._id,
      total: p.total,
      failed: p.failed,
      successRate: p.total === 0 ? 1 : p.completed / p.total,
    }));
  }

  return summary;
}

// ─── Run Session Lookup ───────────────────────────────────────────────────

/**
 * Look up the sessionId that a given run processed.
 *
 * Analytics tables don't have a run_id column, so when the Data tab filters
 * by runId, we resolve it to the session_id the run operated on and use
 * that for the ClickHouse query.
 */
export async function resolveRunSessionId(
  runId: string,
  tenantId: string,
): Promise<string | undefined> {
  const { PipelineRunRecordModel } = await import('@agent-platform/pipeline-engine/schemas');
  const run = (await PipelineRunRecordModel.findOne({ runId, tenantId })
    .lean()
    .select('input.sessionId triggerInput.sessionId')) as Record<string, unknown> | null;
  const input = (run?.triggerInput ?? run?.input) as Record<string, unknown> | undefined;
  if (input && typeof input.sessionId === 'string') {
    return input.sessionId;
  }
  return undefined;
}
