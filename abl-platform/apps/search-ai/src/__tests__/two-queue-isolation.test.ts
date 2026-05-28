/**
 * Two-queue topology: factory shape + reserved-slot guarantees
 * (LLD Phase 1 Task 1.9 / Exit Criterion — factory-level slice).
 *
 * **Scope** — this file covers the **factory** layer only:
 *   - Default concurrency split (3 ingestion + 2 workflow = 5 total)
 *   - Env-variable overrides (`DOCLING_INGESTION_CONCURRENCY` / `DOCLING_WORKFLOW_CONCURRENCY`)
 *   - Runtime assertion that `ingestion + workflow ≤ INGESTION_MAX_CONCURRENT_JOBS`
 *   - Two-queue subscription wiring (each Worker bound to the correct queue)
 *
 * **Out of scope (LLD-deferred)** — the LLD exit criterion (impl-plan line 447)
 * also calls for a live BullMQ saturation scenario: enqueue 3 long ingestion
 * jobs at `?delay=10000`, assert workflow jobs complete in <2s, observe
 * `worker_active_jobs{queue}` never exceeds 3 / 2. That requires a real Redis
 * + the BullMQ runtime + metric scrape, which lands with the Phase 2 producer
 * wiring. See `docs/sdlc-logs/document-extraction-integrations/implementation.log.md`.
 *
 * No `vi.mock('bullmq')` — the test inspects the returned Worker objects'
 * public properties (queue name, opts.concurrency). Workers are closed in
 * the cleanup hook so no Redis subscriptions leak even when the harness has
 * no Redis available (BullMQ tolerates `close()` before the first connect).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_WORKFLOW_DOCLING_EXTRACTION,
} from '@agent-platform/search-ai-sdk';
import createDoclingExtractionWorker, {
  type DoclingExtractionWorkers,
} from '../workers/docling-extraction-worker.js';

const ENV_KEYS = [
  'DOCLING_INGESTION_CONCURRENCY',
  'DOCLING_WORKFLOW_CONCURRENCY',
  'INGESTION_MAX_CONCURRENT_JOBS',
] as const;

describe('createDoclingExtractionWorker — two-queue topology', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const createdWorkers: DoclingExtractionWorkers[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await Promise.allSettled(
      createdWorkers.flatMap((w) => [w.ingestion.close(), w.workflow.close()]),
    );
    createdWorkers.length = 0;
  });

  it('returns an { ingestion, workflow } pair with default concurrency 3+2', () => {
    const workers = createDoclingExtractionWorker();
    createdWorkers.push(workers);

    expect(workers.ingestion.name).toBe(QUEUE_DOCLING_EXTRACTION);
    expect(workers.workflow.name).toBe(QUEUE_WORKFLOW_DOCLING_EXTRACTION);
    // BullMQ exposes `opts.concurrency` on the Worker instance
    expect(workers.ingestion.opts.concurrency).toBe(3);
    expect(workers.workflow.opts.concurrency).toBe(2);
  });

  it('honors env overrides via DOCLING_INGESTION_CONCURRENCY / DOCLING_WORKFLOW_CONCURRENCY', () => {
    process.env.DOCLING_INGESTION_CONCURRENCY = '4';
    process.env.DOCLING_WORKFLOW_CONCURRENCY = '1';
    process.env.INGESTION_MAX_CONCURRENT_JOBS = '5';

    const workers = createDoclingExtractionWorker();
    createdWorkers.push(workers);

    expect(workers.ingestion.opts.concurrency).toBe(4);
    expect(workers.workflow.opts.concurrency).toBe(1);
  });

  it('throws when the concurrency sum exceeds INGESTION_MAX_CONCURRENT_JOBS', () => {
    process.env.INGESTION_MAX_CONCURRENT_JOBS = '5';

    expect(() =>
      createDoclingExtractionWorker({ ingestionConcurrency: 4, workflowConcurrency: 3 }),
    ).toThrow(/exceeds INGESTION_MAX_CONCURRENT_JOBS cap/);
  });

  it('throws when an explicit concurrency is negative', () => {
    expect(() => createDoclingExtractionWorker({ ingestionConcurrency: -1 })).toThrow(
      /must be non-negative/,
    );
  });

  it('falls back to defaults when env values are non-numeric (NaN guard)', () => {
    process.env.DOCLING_INGESTION_CONCURRENCY = 'not-a-number';
    process.env.DOCLING_WORKFLOW_CONCURRENCY = 'also-bad';

    const workers = createDoclingExtractionWorker();
    createdWorkers.push(workers);

    expect(workers.ingestion.opts.concurrency).toBe(3);
    expect(workers.workflow.opts.concurrency).toBe(2);
  });

  it('honors explicit overrides over env values', () => {
    process.env.DOCLING_INGESTION_CONCURRENCY = '99';
    process.env.DOCLING_WORKFLOW_CONCURRENCY = '99';

    const workers = createDoclingExtractionWorker({
      ingestionConcurrency: 2,
      workflowConcurrency: 1,
      totalConcurrencyCap: 5,
    });
    createdWorkers.push(workers);

    expect(workers.ingestion.opts.concurrency).toBe(2);
    expect(workers.workflow.opts.concurrency).toBe(1);
  });

  it('binds the workflow worker to the new queue name (not the ingestion queue)', () => {
    const workers = createDoclingExtractionWorker();
    createdWorkers.push(workers);

    expect(workers.workflow.name).toBe('workflow-docling-extraction');
    expect(workers.ingestion.name).toBe('search-docling-extraction');
    // Backward-compat invariant: the ingestion worker is bound to the
    // pre-existing queue constant — refactor did NOT rename it.
    expect(workers.ingestion.name).toBe(QUEUE_DOCLING_EXTRACTION);
  });

  it('allows total cap > 5 when explicitly overridden (operator tuning)', () => {
    const workers = createDoclingExtractionWorker({
      ingestionConcurrency: 8,
      workflowConcurrency: 4,
      totalConcurrencyCap: 12,
    });
    createdWorkers.push(workers);

    expect(workers.ingestion.opts.concurrency).toBe(8);
    expect(workers.workflow.opts.concurrency).toBe(4);
  });
});
