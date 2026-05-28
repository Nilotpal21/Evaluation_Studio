/**
 * Workflow Docling Extraction — metric emission surface (Phase 1).
 *
 * Phase 1 emits metric-shaped structured log lines so the existing platform
 * log pipeline can derive counters until Phase 4 wires real OpenTelemetry
 * counters/histograms (per LLD §3 phase split — observability/hardening lives
 * in Phase 4). Call-shape matches the eventual OTel surface so the swap is
 * mechanical: replace the body of each `record*` function, leave call sites
 * untouched.
 *
 * Naming follows LLD §3 Phase 1 task 1.7 and the broader feature spec
 * observability matrix (US-6).
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-docling-metrics');

type Tags = Readonly<Record<string, string | number | undefined>>;

function emit(metricName: string, value: number, tags?: Tags): void {
  // Filter `undefined` tag values so structured-log serializers don't emit
  // them as the string `"undefined"` and pollute the metric stream.
  const cleanTags: Record<string, string | number> = {};
  if (tags) {
    for (const [k, v] of Object.entries(tags)) {
      if (v !== undefined) cleanTags[k] = v;
    }
  }
  log.info('metric', {
    metric: metricName,
    value,
    ...cleanTags,
  });
}

export function recordCallbackPostAttempt(tags: { tenant: string; attempt: number }): void {
  emit('workflow_docling_callback_post_attempts_total', 1, tags);
}

export function recordCallbackPostFailure(tags: { tenant: string; error_class: string }): void {
  emit('workflow_docling_callback_post_failures_total', 1, tags);
}

export function recordCallbackPostSuccess(tags: { tenant: string }): void {
  emit('workflow_docling_callback_post_total', 1, tags);
}

export function recordExtractionTooLarge(tags: { tenant: string; provider: string }): void {
  emit('workflow_extraction_too_large_total', 1, tags);
}

export function recordExtractionError(tags: { tenant: string; error_class: string }): void {
  emit('workflow_docling_errors_total', 1, tags);
}

export function recordWaitDurationMs(ms: number, tags: { tenant: string; status: string }): void {
  emit('workflow_docling_wait_duration_seconds', ms / 1000, tags);
}

/**
 * Histogram of serialized extraction-envelope size in bytes (Round-7 add).
 *
 * Detects creeping payload growth before the 50 MB inline cap is hit. Buckets
 * configured downstream in the Grafana dashboard: 100 KB / 500 KB / 2 MB /
 * 10 MB / 25 MB / 50 MB. The engine-side mirror at
 * `apps/workflow-engine/src/observability/extraction-metrics.ts:recordEnvelopeBytes`
 * is the durable OTel-backed counter used for alerting; this log-line emission
 * survives until the search-ai pod boots an OTel SDK.
 */
export function recordEnvelopeBytes(bytes: number, tags: { provider: string }): void {
  emit('workflow_extraction_envelope_bytes', bytes, tags);
}

/**
 * BullMQ queue depth gauge — emitted on a periodic tick from the worker
 * process. The tick lives in `docling-extraction-worker.ts` (Phase 4 metric
 * task 4.4 mark-up) and reads `await queue.getWaitingCount()` every 15 s.
 */
export function recordBullMQQueueDepth(depth: number, tags: { queue: string }): void {
  emit('bullmq_queue_depth', depth, tags);
}

/**
 * Worker active jobs counter — incremented on `job.processing`, decremented
 * on `job.completed`/`job.failed`. The worker holds a separate in-process
 * gauge surface, but the counter delta is sufficient for derived rate panels.
 */
export function recordWorkerActiveJobs(delta: number, tags: { queue: string }): void {
  emit('worker_active_jobs', delta, tags);
}
