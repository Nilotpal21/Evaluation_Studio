/**
 * Agent Transfer Metrics
 *
 * OpenTelemetry metrics for agent transfer operations.
 * Instruments: transfer duration, count, errors, prechecks,
 * provider latency, and active session gauge.
 *
 * Meter name: 'agent-transfer'
 */

import { metrics, type Meter } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

const meter: Meter = metrics.getMeter('agent-transfer', '1.0.0');

// ---------------------------------------------------------------------------
// Transfer Metrics
// ---------------------------------------------------------------------------

const transferDuration = meter.createHistogram('agent_transfer.duration', {
  description: 'Duration of agent transfer operations',
  unit: 'ms',
});

const transferCount = meter.createCounter('agent_transfer.count', {
  description: 'Number of agent transfer operations',
});

const transferErrors = meter.createCounter('agent_transfer.errors', {
  description: 'Number of agent transfer errors',
});

// ---------------------------------------------------------------------------
// Pre-check Metrics
// ---------------------------------------------------------------------------

const precheckDuration = meter.createHistogram('agent_transfer.precheck.duration', {
  description: 'Duration of transfer pre-check operations (hours, availability, queue)',
  unit: 'ms',
});

// ---------------------------------------------------------------------------
// Provider Metrics
// ---------------------------------------------------------------------------

const providerLatency = meter.createHistogram('agent_transfer.provider.latency', {
  description: 'Latency of provider API calls (SmartAssist)',
  unit: 'ms',
});

// ---------------------------------------------------------------------------
// Event Metrics
// ---------------------------------------------------------------------------

const transferEvents = meter.createCounter('agent_transfer.events', {
  description: 'Number of agent transfer events received',
});

// ---------------------------------------------------------------------------
// Session Metrics
// ---------------------------------------------------------------------------

const activeSessionsStates = new Map<string, number>();

const activeSessions = meter.createObservableGauge('agent_transfer.active_sessions', {
  description: 'Number of active agent transfer sessions',
});

activeSessions.addCallback((result) => {
  for (const [key, count] of activeSessionsStates) {
    const [provider, channel] = key.split(':');
    result.observe(count, { provider: provider ?? 'unknown', channel: channel ?? 'unknown' });
  }
});

// ---------------------------------------------------------------------------
// Recovery Metrics
// ---------------------------------------------------------------------------

const recoveryScanDuration = meter.createHistogram('agent_transfer.recovery.scan_duration', {
  description: 'Duration of session recovery scans',
  unit: 'ms',
});

const recoveryClaims = meter.createCounter('agent_transfer.recovery.claims', {
  description: 'Number of orphaned sessions claimed during recovery',
});

// ---------------------------------------------------------------------------
// Recording Helpers
// ---------------------------------------------------------------------------

/**
 * Record a completed agent transfer operation.
 */
export function recordTransfer(opts: {
  provider: string;
  channel: string;
  status: string;
  durationMs: number;
  success: boolean;
}): void {
  transferDuration.record(opts.durationMs, {
    provider: opts.provider,
    channel: opts.channel,
    status: opts.status,
  });
  transferCount.add(1, {
    provider: opts.provider,
    channel: opts.channel,
    status: opts.status,
  });
  if (!opts.success) {
    transferErrors.add(1, {
      provider: opts.provider,
      error_code: opts.status,
    });
  }
}

/**
 * Record a transfer pre-check operation.
 */
export function recordPrecheck(opts: {
  check: string;
  durationMs: number;
  success: boolean;
}): void {
  precheckDuration.record(opts.durationMs, {
    check: opts.check,
    success: opts.success,
  });
}

/**
 * Record a provider API call latency.
 */
export function recordProviderLatency(opts: {
  provider: string;
  operation: string;
  durationMs: number;
}): void {
  providerLatency.record(opts.durationMs, {
    provider: opts.provider,
    operation: opts.operation,
  });
}

/**
 * Record a transfer event received.
 */
export function recordTransferEvent(eventType: string): void {
  transferEvents.add(1, { event_type: eventType });
}

/**
 * Increment the active sessions gauge for a provider+channel.
 */
export function incrementActiveSessions(provider: string, channel: string): void {
  const key = `${provider}:${channel}`;
  activeSessionsStates.set(key, (activeSessionsStates.get(key) ?? 0) + 1);
}

/**
 * Decrement the active sessions gauge for a provider+channel.
 */
export function decrementActiveSessions(provider: string, channel: string): void {
  const key = `${provider}:${channel}`;
  const current = activeSessionsStates.get(key) ?? 0;
  activeSessionsStates.set(key, Math.max(0, current - 1));
}

/**
 * Record a recovery scan operation.
 */
export function recordRecoveryScan(durationMs: number): void {
  recoveryScanDuration.record(durationMs);
}

/**
 * Record a session claim during recovery.
 */
export function recordRecoveryClaim(): void {
  recoveryClaims.add(1);
}
