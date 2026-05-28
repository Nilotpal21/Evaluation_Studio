/**
 * Query Log Analysis Worker
 *
 * BullMQ worker that runs QueryLogAnalysisService to extract
 * vocabulary term candidates from historical search queries.
 *
 * WORKFLOW POSITION: Step 1 of Epic 4 (Domain Vocabulary Generation)
 *   **Query Log Analysis** → Critical Field Detection → Vocabulary Generation
 *
 * DESIGN TIME: This worker runs periodically or on-demand (not per document/query).
 */

import { Job, Worker } from 'bullmq';
import { createClient } from '@clickhouse/client';
import { withTenantContext } from '@agent-platform/database/mongo';
import { QueryLogAnalysisService } from '../services/query-log-analysis/index.js';
import { createWorkerOptions, workerLog, workerError } from './shared.js';

// ─── Queue Name ───────────────────────────────────────────────────────────

export const QUEUE_QUERY_LOG_ANALYSIS = 'search-query-log-analysis';

// ─── Job Data ─────────────────────────────────────────────────────────────

export interface QueryLogAnalysisJobData {
  tenantId: string;
  indexId: string;
  knowledgeBaseId: string;
  /** Lookback window in days (default: 30) */
  lookbackDays?: number;
}

// ─── Job Processor ────────────────────────────────────────────────────────

export async function processQueryLogAnalysisJob(job: Job<QueryLogAnalysisJobData>): Promise<void> {
  const { tenantId, indexId, knowledgeBaseId, lookbackDays } = job.data;

  workerLog('query-log-analysis', 'Starting query log analysis', {
    jobId: job.id,
    tenantId,
    indexId,
    knowledgeBaseId,
    lookbackDays,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      await job.updateProgress(10);

      // Create ClickHouse client for read-only analytics
      const clickhouse = createClient({
        url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
        username: process.env.CLICKHOUSE_USER || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
        database: process.env.CLICKHOUSE_DATABASE || 'abl_platform',
      });

      try {
        const service = new QueryLogAnalysisService(clickhouse);

        await job.updateProgress(20);

        const result = await service.analyze({
          tenantId,
          indexId,
          knowledgeBaseId,
          lookbackDays,
        });

        await job.updateProgress(100);

        workerLog('query-log-analysis', 'Query log analysis completed', {
          jobId: job.id,
          tenantId,
          indexId,
          totalQueries: result.totalQueries,
          uniqueTerms: result.uniqueTerms,
          candidateCount: result.candidates.length,
        });
      } finally {
        await clickhouse.close();
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      workerError('query-log-analysis', `Query log analysis failed: ${errMsg}`, error);
      throw error; // BullMQ retries based on job options
    }
  });
}

// ─── Worker Factory ───────────────────────────────────────────────────────

export function createQueryLogAnalysisWorker(concurrency = 2): Worker<QueryLogAnalysisJobData> {
  const worker = new Worker<QueryLogAnalysisJobData>(
    QUEUE_QUERY_LOG_ANALYSIS,
    processQueryLogAnalysisJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('query-log-analysis', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('query-log-analysis', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('query-log-analysis', 'Worker error', err);
  });

  workerLog('query-log-analysis', `Started with concurrency=${concurrency}`);
  return worker;
}
