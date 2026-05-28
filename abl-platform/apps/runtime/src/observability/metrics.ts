/**
 * OpenTelemetry Metrics
 *
 * Defines application-level metrics using the OTEL Meter API.
 * Metrics are auto-shipped to the OTEL Collector via OTLP.
 *
 * Instruments:
 * - HTTP: request duration, active requests
 * - LLM: call duration, token counts
 * - Tools: call duration
 * - Agent: active sessions
 * - Circuit breaker: state gauge
 */

import { metrics, type Meter } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// METRICS_ENABLED gate
// Default: enabled (backward compat). Only `METRICS_ENABLED=false` disables.
// ---------------------------------------------------------------------------

const METRICS_DISABLED = process.env.METRICS_ENABLED === 'false';

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

const meter: Meter = metrics.getMeter('agent-platform', '1.0.0');

// ---------------------------------------------------------------------------
// HTTP Metrics
// ---------------------------------------------------------------------------

const httpRequestDuration = meter.createHistogram('http.server.request.duration', {
  description: 'Duration of inbound HTTP requests',
  unit: 'ms',
});

const httpActiveRequests = meter.createUpDownCounter('http.server.active_requests', {
  description: 'Number of active HTTP requests',
});

// ---------------------------------------------------------------------------
// LLM Metrics
// ---------------------------------------------------------------------------

const llmCallDuration = meter.createHistogram('llm.call.duration', {
  description: 'Duration of LLM API calls',
  unit: 'ms',
});

const llmCallTokens = meter.createCounter('llm.call.tokens', {
  description: 'Number of tokens consumed by LLM calls',
});

// ---------------------------------------------------------------------------
// Tool Metrics
// ---------------------------------------------------------------------------

const toolCallDuration = meter.createHistogram('tool.call.duration', {
  description: 'Duration of tool calls',
  unit: 'ms',
});

// ---------------------------------------------------------------------------
// Agent Metrics
// ---------------------------------------------------------------------------

const agentActiveSessions = meter.createUpDownCounter('agent.active_sessions', {
  description: 'Number of active agent sessions',
});

// ---------------------------------------------------------------------------
// Rate Limit Metrics
// ---------------------------------------------------------------------------

const rateLimitRejections = meter.createCounter('rate_limit.rejections', {
  description: 'Number of rate limit rejections (429)',
});

const wsRateLimitRejections = meter.createCounter('ws.rate_limit.rejections', {
  description: 'WebSocket connection rate limit rejections',
});

// ---------------------------------------------------------------------------
// Backpressure Metrics
// ---------------------------------------------------------------------------

const backpressureCounter = meter.createCounter('llm.queue.backpressure', {
  description: 'Count of backpressure events when LLM queue depth exceeds threshold',
});

// ---------------------------------------------------------------------------
// Rate Limiter Fallback Metrics
// ---------------------------------------------------------------------------

const rateLimiterFallbackCounter = meter.createCounter('rate_limiter.fallback', {
  description: 'Count of rate limiter backend switches',
});

// ---------------------------------------------------------------------------
// MongoDB Pool Metrics
// ---------------------------------------------------------------------------

const poolCheckoutFailures = meter.createCounter('mongodb.pool.checkout_failures', {
  description: 'MongoDB connection pool checkout failure count',
});

const poolCheckedOut = meter.createUpDownCounter('mongodb.pool.checked_out', {
  description: 'Number of currently checked-out MongoDB connections',
});

const poolConnectionsCreated = meter.createCounter('mongodb.pool.connections_created', {
  description: 'Total MongoDB pool connections created',
});

const poolConnectionsClosed = meter.createCounter('mongodb.pool.connections_closed', {
  description: 'Total MongoDB pool connections closed',
});

// ---------------------------------------------------------------------------
// Circuit Breaker Metrics
// ---------------------------------------------------------------------------

const circuitBreakerState = meter.createObservableGauge('circuit_breaker.state', {
  description: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
});

// Store for circuit breaker state observations
const circuitBreakerStates = new Map<string, number>();

circuitBreakerState.addCallback((result) => {
  for (const [service, state] of circuitBreakerStates) {
    result.observe(state, { service });
  }
});

// ---------------------------------------------------------------------------
// Recording Helpers
// ---------------------------------------------------------------------------

export function recordHttpRequest(opts: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}): void {
  if (METRICS_DISABLED) return;
  httpRequestDuration.record(opts.durationMs, {
    'http.request.method': opts.method,
    'http.route': opts.route,
    'http.response.status_code': opts.statusCode,
  });
}

export function incrementActiveRequests(): void {
  if (METRICS_DISABLED) return;
  httpActiveRequests.add(1);
}

export function decrementActiveRequests(): void {
  if (METRICS_DISABLED) return;
  httpActiveRequests.add(-1);
}

export function recordLlmCall(opts: {
  provider: string;
  model: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
}): void {
  if (METRICS_DISABLED) return;
  llmCallDuration.record(opts.durationMs, {
    'llm.provider': opts.provider,
    'llm.model': opts.model,
  });
  llmCallTokens.add(opts.tokensIn, {
    'llm.provider': opts.provider,
    'llm.model': opts.model,
    'llm.token.type': 'prompt',
  });
  llmCallTokens.add(opts.tokensOut, {
    'llm.provider': opts.provider,
    'llm.model': opts.model,
    'llm.token.type': 'completion',
  });
}

export function recordToolCall(opts: {
  toolName: string;
  durationMs: number;
  success: boolean;
}): void {
  if (METRICS_DISABLED) return;
  toolCallDuration.record(opts.durationMs, {
    'tool.name': opts.toolName,
    'tool.success': opts.success,
  });
}

export function recordRateLimitRejection(opts: { tenantId: string; operation: string }): void {
  if (METRICS_DISABLED) return;
  rateLimitRejections.add(1, { tenant_id: opts.tenantId, operation: opts.operation });
}

export function recordWsRateLimitRejection(opts: { ip: string }): void {
  if (METRICS_DISABLED) return;
  wsRateLimitRejections.add(1, { ip: opts.ip });
}

export function recordRateLimiterFallback(direction: string): void {
  if (METRICS_DISABLED) return;
  rateLimiterFallbackCounter.add(1, { direction });
}

export function recordBackpressure(reason: string, tenantId?: string): void {
  if (METRICS_DISABLED) return;
  backpressureCounter.add(1, { reason, ...(tenantId ? { 'tenant.id': tenantId } : {}) });
}

export function incrementActiveSessions(): void {
  if (METRICS_DISABLED) return;
  agentActiveSessions.add(1);
}

export function decrementActiveSessions(): void {
  if (METRICS_DISABLED) return;
  agentActiveSessions.add(-1);
}

/**
 * Record a MongoDB connection pool checkout failure.
 * Called from the pool monitoring callback wired in db/index.ts.
 */
export function recordPoolCheckoutFailure(reason?: string): void {
  if (METRICS_DISABLED) return;
  poolCheckoutFailures.add(1, { ...(reason ? { reason } : {}) });
}

export function recordPoolCheckedOut(): void {
  if (METRICS_DISABLED) return;
  poolCheckedOut.add(1);
}

export function recordPoolCheckedIn(): void {
  if (METRICS_DISABLED) return;
  poolCheckedOut.add(-1);
}

export function recordPoolConnectionCreated(): void {
  if (METRICS_DISABLED) return;
  poolConnectionsCreated.add(1);
}

export function recordPoolConnectionClosed(): void {
  if (METRICS_DISABLED) return;
  poolConnectionsClosed.add(1);
}

/**
 * Update circuit breaker state for a service.
 * @param service - Service name
 * @param state - 0=closed, 1=half-open, 2=open
 */
export function setCircuitBreakerState(service: string, state: number): void {
  if (METRICS_DISABLED) return;
  circuitBreakerStates.set(service, state);
}

/** Record a circuit breaker persistence failure (e.g. Redis write failed during recordFailure) */
export function recordCBPersistenceFailure(service: string, operation: string): void {
  if (METRICS_DISABLED) return;
  cbPersistenceFailures.add(1, { service, operation });
}

const cbPersistenceFailures = meter.createCounter('cb.persistence.failures', {
  description: 'Number of circuit breaker persistence failures',
});
