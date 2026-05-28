/**
 * Job Management Routes
 *
 * Manage ingestion jobs for search indexes.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';

// In-memory job tracking (will be replaced by BullMQ in production)
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type { ISearchIndex, ISearchSource } from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
interface IngestionJob {
  id: string;
  indexId: string;
  sourceId: string | null;
  tenantId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  documentsProcessed: number;
  documentsTotal: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

const MAX_JOBS = 1000;
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const jobs = new Map<string, IngestionJob>();
let jobCounter = 0;

function evictStaleJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const now = Date.now();
  // First pass: remove completed and expired jobs
  for (const [id, job] of jobs) {
    if (now - job.createdAt.getTime() > JOB_TTL_MS || job.completedAt) {
      jobs.delete(id);
    }
    if (jobs.size <= MAX_JOBS) break;
  }
  // Hard cap: if still over limit, remove oldest entries
  if (jobs.size > MAX_JOBS) {
    const excess = jobs.size - MAX_JOBS;
    const iter = jobs.keys();
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value;
      if (key) jobs.delete(key);
    }
  }
}

const router: RouterType = Router();

/**
 * GET / - List active ingestion jobs
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { indexId, status } = req.query;

    let jobList = Array.from(jobs.values()).filter((j) => j.tenantId === tenantId);

    if (indexId) {
      jobList = jobList.filter((j) => j.indexId === indexId);
    }
    if (status) {
      jobList = jobList.filter((j) => j.status === status);
    }

    // Sort by creation time, newest first
    jobList.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({ jobs: jobList, total: jobList.length });
  } catch (error) {
    console.error('[jobs] Failed to list jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * POST / - Create a new ingestion job
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { indexId, sourceId } = req.body;

    if (!indexId) {
      res.status(400).json({ error: 'indexId is required' });
      return;
    }

    // Verify index exists and belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // If sourceId provided, verify source exists and belongs to tenant
    if (sourceId) {
      const source = await SearchSource.findOne({ _id: sourceId, indexId, tenantId }).lean();
      if (!source) {
        res.status(404).json({ error: 'Source not found for this index' });
        return;
      }
    }

    jobCounter++;
    const jobId = `job_${Date.now()}_${jobCounter}`;

    const job: IngestionJob = {
      id: jobId,
      indexId,
      sourceId: sourceId || null,
      tenantId: index.tenantId,
      status: 'queued',
      progress: 0,
      documentsProcessed: 0,
      documentsTotal: 0,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    evictStaleJobs();
    jobs.set(jobId, job);

    // TODO: Enqueue job via BullMQ for async processing

    res.status(201).json({ job });
  } catch (error) {
    console.error('[jobs] Failed to create job:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

/**
 * GET /:jobId - Get job status
 */
router.get('/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const job = jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ job });
  } catch (error) {
    console.error('[jobs] Failed to get job:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

export default router;
