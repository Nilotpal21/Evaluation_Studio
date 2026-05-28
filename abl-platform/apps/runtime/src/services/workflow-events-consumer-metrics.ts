/**
 * Workflow events consumer metrics (LLD §4.5).
 *
 * Emitted via the OpenTelemetry meter — apps/runtime wires
 * `OTLPMetricExporter` at boot (`observability/otel-setup.ts`), which
 * Prometheus scrapes downstream. Kept separate from the consumer so unit
 * tests can assert on the metric handles without spinning up Kafka/CH.
 *
 * Metrics
 * -------
 *  workflow_ch_consumer_lag_ms            — histogram, `Date.now() - event.occurred_at`
 *  workflow_ch_ingest_latency_ms          — histogram, first-event to flush-success
 *  workflow_ch_buffered_writer_flush_latency_ms — histogram, CH flush duration
 *  workflow_ch_buffered_writer_flush_total      — counter, successful flushes
 *  workflow_ch_buffered_writer_flush_failures_total — counter, flush errors
 *
 * Meter handles are created lazily on first access — the OTel SDK must
 * have booted first.
 */

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';

const METER_NAME = 'runtime.workflow-events-consumer';

let _meter: Meter | undefined;
function meter(): Meter {
  if (!_meter) {
    _meter = metrics.getMeter(METER_NAME);
  }
  return _meter;
}

let _consumerLag: Histogram | undefined;
let _ingestLatency: Histogram | undefined;
let _flushLatency: Histogram | undefined;
let _flushSuccesses: Counter | undefined;
let _flushFailures: Counter | undefined;

export function recordConsumerLag(ms: number, attributes?: Record<string, string>): void {
  if (!_consumerLag) {
    _consumerLag = meter().createHistogram('workflow_ch_consumer_lag_ms', {
      description: 'Event age on consume (Date.now() - event.occurred_at) for workflow CH sink',
      unit: 'ms',
    });
  }
  _consumerLag.record(ms, attributes);
}

export function recordIngestLatency(ms: number, attributes?: Record<string, string>): void {
  if (!_ingestLatency) {
    _ingestLatency = meter().createHistogram('workflow_ch_ingest_latency_ms', {
      description: 'Time from first event buffered to CH flush success',
      unit: 'ms',
    });
  }
  _ingestLatency.record(ms, attributes);
}

export function recordFlushLatency(ms: number, attributes?: Record<string, string>): void {
  if (!_flushLatency) {
    _flushLatency = meter().createHistogram('workflow_ch_buffered_writer_flush_latency_ms', {
      description: 'Duration of BufferedClickHouseWriter flush() calls for workflow CH sink',
      unit: 'ms',
    });
  }
  _flushLatency.record(ms, attributes);
}

export function recordFlushSuccess(attributes?: Record<string, string>): void {
  if (!_flushSuccesses) {
    _flushSuccesses = meter().createCounter('workflow_ch_buffered_writer_flush_total', {
      description: 'Count of successful CH flushes from workflow events consumer',
    });
  }
  _flushSuccesses.add(1, attributes);
}

export function recordFlushFailure(attributes?: Record<string, string>): void {
  if (!_flushFailures) {
    _flushFailures = meter().createCounter('workflow_ch_buffered_writer_flush_failures_total', {
      description: 'Count of CH flush failures from workflow events consumer',
    });
  }
  _flushFailures.add(1, attributes);
}
