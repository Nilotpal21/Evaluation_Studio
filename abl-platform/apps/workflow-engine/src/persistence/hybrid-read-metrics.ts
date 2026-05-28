/**
 * Hybrid-read metrics (LLD §5.2 + §5.3). Shared between the workflow-engine
 * `HybridExecutionReader` and the runtime `HybridHumanTaskReader` via label
 * tags (`entity={workflow_execution|human_task}`, `mode={mongo-only|union}`).
 *
 * Handle is lazily created on first use so the OTel SDK has time to boot.
 */

import { metrics } from '@opentelemetry/api';
import type { Histogram, Meter } from '@opentelemetry/api';

const METER_NAME = 'workflow-engine.dual-read';

let _meter: Meter | undefined;
function meter(): Meter {
  if (!_meter) _meter = metrics.getMeter(METER_NAME);
  return _meter;
}

let _latency: Histogram | undefined;

export function recordDualReadLatency(
  ms: number,
  attributes: { entity: 'workflow_execution' | 'human_task'; mode: 'mongo-only' | 'union' },
): void {
  if (!_latency) {
    _latency = meter().createHistogram('workflow_dual_read_request_latency_ms', {
      description: 'Per-request latency for the dual-read hybrid readers',
      unit: 'ms',
    });
  }
  _latency.record(ms, attributes);
}
