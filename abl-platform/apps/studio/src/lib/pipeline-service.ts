/**
 * Pipeline Service
 *
 * Shared service layer for pipeline run queries.
 * Uses a hybrid approach:
 *   1. Check MongoDB first for completed runs (fast, indexed)
 *   2. Fall back to Restate shared handler for running workflows (live status)
 */

import {
  PipelineRunRecordModel,
  type IPipelineRunRecord,
} from '@agent-platform/pipeline-engine/schemas';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('pipeline-service');

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * Get the status of a pipeline run.
 *
 * Checks MongoDB for completed runs first (indexed, fast). If the run
 * is not in a terminal state, queries Restate for live workflow status.
 */
export async function getRunStatus(
  runId: string,
  tenantId: string,
): Promise<
  IPipelineRunRecord | { runId: string; tenantId: string; status: string; message: string } | null
> {
  // 1. Check MongoDB for completed run (tenant-isolated query)
  const record = (await PipelineRunRecordModel.findOne({ runId, tenantId }).lean()) as any;
  if (record && TERMINAL_STATUSES.includes(record.status as (typeof TERMINAL_STATUSES)[number])) {
    return record;
  }

  // If we have a record but it's still running, return it — it reflects current known state
  if (record) {
    return record;
  }

  // 2. Query Restate for live status (run might not have persisted a record yet)
  try {
    // TODO: Wire up when pipelineRun workflow reference is available
    // const restateUrl = getRestateIngressUrl();
    // const res = await fetch(`${restateUrl}/PipelineRun/${runId}/getStatus`);
    // return { runId, ...(await res.json()) };
    return { runId, tenantId, status: 'unknown', message: 'Restate query not yet wired' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to query Restate for run status', { runId, error: msg });
    return null;
  }
}

/**
 * Cancel a running pipeline.
 *
 * Verifies tenant ownership via MongoDB before issuing the cancel.
 */
export async function cancelRun(
  runId: string,
  tenantId: string,
): Promise<{ success: boolean; error?: string }> {
  // Verify ownership — tenant-isolated query
  const record = (await PipelineRunRecordModel.findOne({ runId, tenantId }).lean()) as any;
  if (!record) {
    return { success: false, error: 'Run not found' };
  }

  if (TERMINAL_STATUSES.includes(record.status as (typeof TERMINAL_STATUSES)[number])) {
    return { success: false, error: `Run is already in terminal state: ${record.status}` };
  }

  try {
    // TODO: Use Restate's cancel API when pipelineRun workflow reference is available
    // const restateUrl = getRestateIngressUrl();
    // await fetch(`${restateUrl}/PipelineRun/${runId}/cancel`, { method: 'POST' });
    log.info('Cancelling pipeline run', { runId, tenantId });

    // Update the record to cancelled
    await PipelineRunRecordModel.findOneAndUpdate(
      { runId, tenantId },
      { $set: { status: 'cancelled', completedAt: new Date() } },
    );

    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to cancel pipeline run', { runId, error: msg });
    return {
      success: false,
      error: msg,
    };
  }
}

// ─── Project-Scoped Helpers ──────────────────────────────────────────────
// NOTE: listProjectRuns and getProjectRunHealth were removed as part of
// ABLP-280. The runtime now owns these queries — Studio proxies to
// /api/projects/:projectId/pipeline-observability/runs[/health].
