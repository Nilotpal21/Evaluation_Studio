/**
 * BackfillService — Discovers and batch-processes unprocessed sessions for a pipeline.
 *
 * Queries ClickHouse for sessions in a time range that don't yet have results
 * in the pipeline's output table. Triggers pipeline runs in batches.
 *
 * Tracks backfill progress in MongoDB (backfillStatus field on PipelineConfig).
 */
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import { PipelineConfigModel, type PipelineType } from '../../schemas/pipeline-config.schema.js';

const log = createLogger('backfill-service');

/** Default batch size for backfill processing. */
const BATCH_SIZE = 50;

/** Map pipeline types to their ClickHouse output tables. */
const PIPELINE_OUTPUT_TABLES: Partial<Record<PipelineType, string>> = {
  sentiment_analysis: 'abl_platform.conversation_sentiment',
  intent_classification: 'abl_platform.intent_classifications',
  quality_evaluation: 'abl_platform.quality_evaluations',
};

export interface BackfillOptions {
  tenantId: string;
  projectId: string;
  pipelineType: PipelineType;
  lookbackDays?: number;
  batchSize?: number;
}

export interface BackfillResult {
  totalSessions: number;
  processedSessions: number;
  failedSessions: number;
  skippedSessions: number;
  durationMs: number;
}

export class BackfillService {
  /**
   * Find sessions that haven't been processed by a pipeline.
   * Returns session IDs in chronological order.
   */
  async findUnprocessedSessions(opts: BackfillOptions): Promise<string[]> {
    const outputTable = PIPELINE_OUTPUT_TABLES[opts.pipelineType];
    if (!outputTable) {
      log.warn('No output table for pipeline type', { pipelineType: opts.pipelineType });
      return [];
    }

    const lookbackDays = opts.lookbackDays ?? 30;
    const ch = getClickHouseClient();

    // Find sessions that have messages but no pipeline results
    const query = `
      SELECT DISTINCT session_id
      FROM abl_platform.messages
      WHERE tenant_id = {tenantId:String}
        AND created_at >= now() - INTERVAL ${lookbackDays} DAY
        AND session_id NOT IN (
          SELECT session_id
          FROM ${outputTable}
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
        )
      ORDER BY created_at ASC
      LIMIT ${opts.batchSize ?? BATCH_SIZE}
      SETTINGS max_execution_time = 30
    `;

    const result = await ch.query({
      query,
      query_params: {
        tenantId: opts.tenantId,
        projectId: opts.projectId,
      },
    });

    const rows = ((await result.json()) as { data: Array<{ session_id: string }> }).data;
    return rows.map((r) => r.session_id);
  }

  /**
   * Count total unprocessed sessions for progress tracking.
   */
  async countUnprocessedSessions(opts: BackfillOptions): Promise<number> {
    const outputTable = PIPELINE_OUTPUT_TABLES[opts.pipelineType];
    if (!outputTable) return 0;

    const lookbackDays = opts.lookbackDays ?? 30;
    const ch = getClickHouseClient();

    const query = `
      SELECT count(DISTINCT session_id) AS total
      FROM abl_platform.messages
      WHERE tenant_id = {tenantId:String}
        AND created_at >= now() - INTERVAL ${lookbackDays} DAY
        AND session_id NOT IN (
          SELECT session_id
          FROM ${outputTable}
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
        )
      SETTINGS max_execution_time = 30
    `;

    const result = await ch.query({
      query,
      query_params: {
        tenantId: opts.tenantId,
        projectId: opts.projectId,
      },
    });

    const rows = ((await result.json()) as { data: Array<{ total: number }> }).data;
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Update backfill status on the pipeline config document.
   */
  async updateBackfillStatus(
    tenantId: string,
    projectId: string,
    pipelineType: PipelineType,
    status: 'idle' | 'running' | 'completed' | 'failed',
  ): Promise<void> {
    const updateFields: Record<string, unknown> = { backfillStatus: status };
    if (status === 'running') {
      updateFields.lastBackfillAt = new Date();
    }

    await PipelineConfigModel.updateOne(
      { tenantId, pipelineType, projectId },
      { $set: updateFields },
    );

    log.info('Backfill status updated', { tenantId, projectId, pipelineType, status });
  }

  /**
   * Get current backfill status for a pipeline.
   */
  async getBackfillStatus(
    tenantId: string,
    projectId: string,
    pipelineType: PipelineType,
  ): Promise<{
    status: string;
    lastBackfillAt: Date | null;
    unprocessedCount: number;
  }> {
    const config = await PipelineConfigModel.findOne({
      tenantId,
      pipelineType,
      projectId,
    });

    const unprocessedCount = await this.countUnprocessedSessions({
      tenantId,
      projectId,
      pipelineType,
    });

    return {
      status: config?.backfillStatus ?? 'idle',
      lastBackfillAt: config?.lastBackfillAt ?? null,
      unprocessedCount,
    };
  }
}
