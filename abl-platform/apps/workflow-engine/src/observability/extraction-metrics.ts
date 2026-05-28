/**
 * Document-extraction metrics — engine-side surface.
 *
 * Emits via the OpenTelemetry meter (workflow-engine boots `OTLPMetricExporter`
 * in `observability/otel-setup.ts`, which Prometheus scrapes downstream).
 * All meter handles are created lazily on first access — the OTel SDK must
 * have booted first (it does, because `otel-setup` is imported in `index.ts`).
 *
 * Search-ai-side metrics live in `apps/search-ai/src/workers/branches/extraction-metrics.ts`.
 * That file emits metric-shaped structured log lines (search-ai does not boot
 * the OTel SDK); this file emits true OTel counters/histograms/gauges from
 * the workflow-engine pod.
 *
 * Naming follows LLD §3 Phase 4 task 4.4 and the HLD §4.2 observability matrix.
 */

import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram, ObservableGauge, Meter } from '@opentelemetry/api';

const METER_NAME = 'workflow-engine.extraction';

let _meter: Meter | undefined;
function meter(): Meter {
  if (!_meter) _meter = metrics.getMeter(METER_NAME);
  return _meter;
}

// ── Wait duration ─────────────────────────────────────────────────────────
//
// Histogram of park-start → promise-resolve latency, recorded by the
// suspension block in `workflow-handler.ts` when a `callbackRequest` resolves
// (or times out). The status dimension distinguishes `success` / `failed` /
// `timeout`.

let _waitDuration: Histogram | undefined;
export function recordExtractionWaitMs(
  durationMs: number,
  attributes: { tenant: string; status: string },
): void {
  if (!_waitDuration) {
    _waitDuration = meter().createHistogram('workflow_docling_wait_duration_seconds', {
      description: 'Engine-side park duration for document-extraction callback steps',
      unit: 's',
    });
  }
  _waitDuration.record(durationMs / 1000, attributes);
}

// ── Parked-promises gauge ─────────────────────────────────────────────────
//
// Observable gauge — the workflow-handler maintains a per-tenant counter
// of currently-parked extraction steps and observes it on each scrape.
// In-memory; replays/restarts re-derive from active step records.

// Bounded eviction for consistency with the neighbouring breaker-state and
// cap-ratio maps. Per-tenant counter that self-cleans on decrement-to-zero,
// so this cap is defence-in-depth against a runaway emission bug.
const MAX_PARKED_TENANT_ENTRIES = 10_000;
const _parkedByTenant = new Map<string, number>();
let _parkedGauge: ObservableGauge | undefined;

export function incrementParked(tenant: string): void {
  if (_parkedByTenant.size >= MAX_PARKED_TENANT_ENTRIES && !_parkedByTenant.has(tenant)) {
    const oldest = _parkedByTenant.keys().next().value;
    if (oldest !== undefined) _parkedByTenant.delete(oldest);
  }
  _parkedByTenant.set(tenant, (_parkedByTenant.get(tenant) ?? 0) + 1);
  ensureParkedGauge();
}

export function decrementParked(tenant: string): void {
  const next = (_parkedByTenant.get(tenant) ?? 0) - 1;
  if (next <= 0) {
    _parkedByTenant.delete(tenant);
  } else {
    _parkedByTenant.set(tenant, next);
  }
}

function ensureParkedGauge(): void {
  if (_parkedGauge) return;
  _parkedGauge = meter().createObservableGauge('workflow_docling_parked_promises_gauge', {
    description: 'Currently-parked extraction callback promises, by tenant',
  });
  _parkedGauge.addCallback((result) => {
    for (const [tenant, count] of _parkedByTenant.entries()) {
      result.observe(count, { tenant });
    }
  });
}

// ── Envelope-size histogram (Round 7) ─────────────────────────────────────
//
// Histogram of serialized extraction-envelope bytes — detects creeping
// payload growth before the 50 MB cap is hit. Buckets per LLD: 100 KB /
// 500 KB / 2 MB / 10 MB / 25 MB / 50 MB. Recorded by the engine-side
// callback completion path (the worker also emits a log-line version; this
// is the durable counter used for alerting).

let _envelopeBytes: Histogram | undefined;
export function recordEnvelopeBytes(bytes: number, attributes: { provider: string }): void {
  if (!_envelopeBytes) {
    _envelopeBytes = meter().createHistogram('workflow_extraction_envelope_bytes', {
      description: 'Serialized extraction-envelope size in bytes (workflow callback path)',
      unit: 'By',
    });
  }
  _envelopeBytes.record(bytes, attributes);
}

// ── Azure DI extractions counter ──────────────────────────────────────────
//
// One increment per `azure-document-intelligence` extraction attempt, tagged
// with terminal status (success / SSRF_BLOCKED / RATE_LIMITED /
// QUOTA_EXCEEDED / CIRCUIT_OPEN / EXTRACTION_FAILED / etc).

let _azureDIExtractions: Counter | undefined;
export function recordAzureDIExtraction(attributes: {
  tenant: string;
  project: string;
  status: string;
}): void {
  if (!_azureDIExtractions) {
    _azureDIExtractions = meter().createCounter('azure_di_extractions_total', {
      description: 'Azure Document Intelligence extraction attempts, by terminal status',
    });
  }
  _azureDIExtractions.add(1, attributes);
}

// ── Azure DI circuit-breaker state gauge ──────────────────────────────────
//
// Observable gauge (0=closed, 1=half-open, 2=open) keyed by tenant. The
// breaker's `onEvent` listener pushes state transitions into the in-process
// map; the gauge callback observes the map on each scrape.

const BREAKER_STATE_CODES: Record<string, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};
// Bounded eviction — per CLAUDE.md "every in-memory Map needs max size + TTL +
// eviction." On overflow we drop the oldest inserted entry. The cap is sized
// at 10k tenants, well above realistic deployments.
const MAX_BREAKER_STATE_ENTRIES = 10_000;
const _breakerStateByTenant = new Map<string, number>();
let _breakerStateGauge: ObservableGauge | undefined;

export function recordAzureDIBreakerState(tenant: string, state: string): void {
  const code = BREAKER_STATE_CODES[state];
  if (code === undefined) return;
  if (
    _breakerStateByTenant.size >= MAX_BREAKER_STATE_ENTRIES &&
    !_breakerStateByTenant.has(tenant)
  ) {
    const oldest = _breakerStateByTenant.keys().next().value;
    if (oldest !== undefined) _breakerStateByTenant.delete(oldest);
  }
  _breakerStateByTenant.set(tenant, code);
  ensureBreakerStateGauge();
}

function ensureBreakerStateGauge(): void {
  if (_breakerStateGauge) return;
  _breakerStateGauge = meter().createObservableGauge('azure_di_circuit_breaker_state', {
    description: 'Azure DI circuit-breaker state: 0=closed, 1=half-open, 2=open',
  });
  _breakerStateGauge.addCallback((result) => {
    for (const [tenant, code] of _breakerStateByTenant.entries()) {
      result.observe(code, { tenant });
    }
  });
}

// ── Azure DI cost-cap-used ratio gauge ────────────────────────────────────
//
// Observable gauge of `usageCount / cap` per (tenant, project). The hard
// cap takes precedence when set; falls back to soft cap. Updated by the
// AzureDIUsageCounter on each `recordUsage` call.

interface CapRatioPoint {
  tenant: string;
  project: string;
  ratio: number;
  capKind: 'hard' | 'soft';
}
// Bounded eviction — per CLAUDE.md "every in-memory Map needs max size + TTL +
// eviction." On overflow we drop the oldest inserted entry. Cap is generous
// (10k entries) and per-connection — well above realistic deployments.
const MAX_CAP_RATIO_ENTRIES = 10_000;
const _capRatioByConn = new Map<string, CapRatioPoint>();
let _capRatioGauge: ObservableGauge | undefined;

export function recordAzureDICapUsage(args: {
  connectionId: string;
  tenant: string;
  project: string;
  usageCount: number;
  usageSoftCap: number | null;
  usageHardCap: number | null;
}): void {
  const cap = args.usageHardCap ?? args.usageSoftCap;
  if (cap === null || cap <= 0) {
    // No cap configured (or zero is the kill-switch sentinel). Drop the point.
    _capRatioByConn.delete(args.connectionId);
    return;
  }
  if (_capRatioByConn.size >= MAX_CAP_RATIO_ENTRIES && !_capRatioByConn.has(args.connectionId)) {
    const oldest = _capRatioByConn.keys().next().value;
    if (oldest !== undefined) _capRatioByConn.delete(oldest);
  }
  const capKind: 'hard' | 'soft' = args.usageHardCap !== null ? 'hard' : 'soft';
  _capRatioByConn.set(args.connectionId, {
    tenant: args.tenant,
    project: args.project,
    ratio: args.usageCount / cap,
    capKind,
  });
  ensureCapRatioGauge();
}

function ensureCapRatioGauge(): void {
  if (_capRatioGauge) return;
  _capRatioGauge = meter().createObservableGauge('azure_di_cost_cap_used_ratio', {
    description: 'Azure DI usage ratio against the configured cap (hard preferred over soft)',
  });
  _capRatioGauge.addCallback((result) => {
    for (const point of _capRatioByConn.values()) {
      result.observe(point.ratio, {
        tenant: point.tenant,
        project: point.project,
        cap_kind: point.capKind,
      });
    }
  });
}

// ── Rate-limited counter ──────────────────────────────────────────────────
//
// Incremented when a connector body rejects with `RATE_LIMITED`. Engine
// observes this on the step.failed path.

let _rateLimited: Counter | undefined;
export function recordExtractionRateLimited(attributes: {
  tenant: string;
  provider: string;
}): void {
  if (!_rateLimited) {
    _rateLimited = meter().createCounter('workflow_docling_rate_limited_total', {
      description: 'Document-extraction calls rejected by per-tenant rate-limiter',
    });
  }
  _rateLimited.add(1, attributes);
}

// ── Test helper ───────────────────────────────────────────────────────────
//
// Resets the in-process state. Used by unit tests that need to assert the
// observable-gauge inputs without booting the OTel SDK.

export function __resetMetricsForTest(): void {
  _parkedByTenant.clear();
  _breakerStateByTenant.clear();
  _capRatioByConn.clear();
}

export function __getParkedSnapshotForTest(): ReadonlyMap<string, number> {
  return new Map(_parkedByTenant);
}

export function __getBreakerStateSnapshotForTest(): ReadonlyMap<string, number> {
  return new Map(_breakerStateByTenant);
}

export function __getCapRatioSnapshotForTest(): ReadonlyMap<string, CapRatioPoint> {
  return new Map(_capRatioByConn);
}
