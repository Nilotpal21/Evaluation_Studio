/**
 * Workflow outbox Prometheus metrics (LLD §3.7).
 *
 * Emitted via the OpenTelemetry meter (workflow-engine wires an
 * `OTLPMetricExporter` in `observability/otel-setup.ts`, which Prometheus
 * scrapes downstream). Kept separate from the writer / poller so unit tests
 * can import the metric handles without spinning up Kafka/Mongo.
 *
 * All meter handles are created lazily on first access — the OTel SDK must
 * have booted first (it does, because `otel-setup` is the first import in
 * `index.ts`).
 */

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram, ObservableGauge, Meter } from '@opentelemetry/api';

const METER_NAME = 'workflow-engine.outbox';

let _meter: Meter | undefined;
function meter(): Meter {
  if (!_meter) {
    _meter = metrics.getMeter(METER_NAME);
  }
  return _meter;
}

let _unpublishedGauge: ObservableGauge | undefined;
let _publishLatency: Histogram | undefined;
let _publishFailures: Counter | undefined;
let _publishSuccesses: Counter | undefined;
let _unpublishedGaugeCallback: (() => Promise<number> | number) | null = null;

/**
 * Record the current unpublished row count. The OTel gauge is observable —
 * the poller installs a callback once at start; subsequent observations are
 * pulled by the exporter on each scrape cycle.
 */
export function setUnpublishedRowsProvider(provider: () => Promise<number> | number): void {
  _unpublishedGaugeCallback = provider;
  if (!_unpublishedGauge) {
    _unpublishedGauge = meter().createObservableGauge('workflow_outbox_unpublished_rows', {
      description: 'Count of workflow outbox rows awaiting Kafka publish',
      unit: 'rows',
    });
    _unpublishedGauge.addCallback(async (result) => {
      if (!_unpublishedGaugeCallback) return;
      try {
        const value = await _unpublishedGaugeCallback();
        result.observe(value);
      } catch {
        // Swallow — observation failures must not tear down the metric reader.
        // The gauge will report stale data on the next scrape, which is
        // surfaced via the publish-failure counter + publish-latency histogram.
      }
    });
  }
}

/** Clear the unpublished-rows provider. Used in tests for isolation. */
export function clearUnpublishedRowsProvider(): void {
  _unpublishedGaugeCallback = null;
}

export function recordPublishLatency(ms: number, attributes?: Record<string, string>): void {
  if (!_publishLatency) {
    _publishLatency = meter().createHistogram('workflow_outbox_publish_latency_ms', {
      description: 'Time from outbox enqueue to Kafka ACK',
      unit: 'ms',
    });
  }
  _publishLatency.record(ms, attributes);
}

export function recordPublishFailure(attributes?: Record<string, string>): void {
  if (!_publishFailures) {
    _publishFailures = meter().createCounter('workflow_outbox_publish_failures_total', {
      description: 'Count of Kafka publish failures during outbox drain',
    });
  }
  _publishFailures.add(1, attributes);
}

export function recordPublishSuccess(attributes?: Record<string, string>): void {
  if (!_publishSuccesses) {
    _publishSuccesses = meter().createCounter('workflow_outbox_publish_total', {
      description: 'Count of successful Kafka publishes from outbox drain',
    });
  }
  _publishSuccesses.add(1, attributes);
}
