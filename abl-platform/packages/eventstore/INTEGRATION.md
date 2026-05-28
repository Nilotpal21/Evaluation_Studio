# EventStore Integration Guide

This guide shows how to integrate the eventstore package into the existing platform.

## 1. Retention Service Integration

Add `events` field to existing `RetentionPolicy`:

```typescript
// apps/studio/src/services/retention/retention-service.ts

export interface RetentionPolicy {
  // ... existing fields (sessions, messages, traces, auditLogs)

  events: {
    totalRetentionDays: number;
    piiRetentionDays: number;
  };
}

// Update plan retention configs:
const PLAN_RETENTION: Record<string, Omit<RetentionPolicy, 'tenantId' | 'plan'>> = {
  FREE: {
    // ... existing
    events: { totalRetentionDays: 30, piiRetentionDays: 7 },
  },
  TEAM: {
    // ... existing
    events: { totalRetentionDays: 90, piiRetentionDays: 30 },
  },
  BUSINESS: {
    // ... existing
    events: { totalRetentionDays: 365, piiRetentionDays: 90 },
  },
  ENTERPRISE: {
    // ... existing
    events: { totalRetentionDays: 2555, piiRetentionDays: 365 },
  },
};
```

Call event retention in the daily scheduler:

```typescript
// In runRetentionForTenant():
import { eventRetention } from './event-retention-instance'; // Singleton

await eventRetention.runRetention(tenantId, policy);
```

## 2. GDPR Cascade Integration

Add event deletion to cascade-delete functions:

```typescript
// packages/database/src/cascade/cascade-delete.ts

import { eventGDPR } from '@abl/eventstore'; // Singleton from runtime

export async function deleteSession(tenantId: string, sessionId: string): Promise<void> {
  // ... existing cascade (messages, traces, etc.)

  // Delete events
  await eventGDPR.deleteBySessionIds(tenantId, [sessionId]);
}

export async function deleteTenant(tenantId: string): Promise<void> {
  // ... existing cascade

  // Delete all events
  await eventGDPR.deleteTenant(tenantId);
}
```

## 3. Runtime Initialization

Initialize eventstore in runtime startup:

```typescript
// apps/runtime/src/index.ts

import { createEventStore } from '@abl/eventstore';
import { getClickHouseClient } from '@agent-platform/database';

// Create eventstore services
const eventstore = createEventStore({
  mode: 'embedded',
  backend: 'clickhouse',
  queue: { type: 'direct' }, // Or 'kafka' for high throughput
  clickhouse: {
    client: getClickHouseClient(),
  },
  resilience: {
    enabled: true,
    wal: {
      directory: '/var/eventstore-wal/',
      maxFileSizeBytes: 100 * 1024 * 1024,
      maxRetentionHours: 24,
    },
  },
});

// Recover WAL on startup
if (eventstore.recovery) {
  await eventstore.recovery.recoverFromWAL();
  eventstore.recovery.startPeriodicRecovery(); // Every 5 minutes
}

// Export for use throughout runtime
export const { emitter, queryService, retention, gdpr } = eventstore;
```

## 4. Emit Events

Emit events from your code:

```typescript
import { emitter } from './index';

// Session started
emitter.emit({
  event_type: 'session.started',
  tenant_id: session.tenantId,
  project_id: session.projectId,
  session_id: session.id,
  timestamp: new Date(),
  data: {
    channel: session.channel,
    agent_name: session.entryAgent,
    deployment_id: session.deploymentId,
    resolution_method: 'new',
    caller_identity_tier: session.callerIdentityTier,
  },
});

// LLM call completed
emitter.emit({
  event_type: 'llm.call.completed',
  tenant_id: session.tenantId,
  project_id: session.projectId,
  session_id: session.id,
  agent_name: currentAgent,
  timestamp: new Date(),
  duration_ms: latency,
  data: {
    model: resolvedModel,
    provider: providerName,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    estimated_cost: usage.cost,
    latency_ms: latency,
    streaming_used: streaming,
    tool_call_count: toolCalls.length,
  },
});
```

## 5. Query Events (Studio UI)

Query events in Studio dashboards:

```typescript
// apps/studio/src/app/api/analytics/events/route.ts

import { queryService } from '@abl/eventstore'; // Singleton

export async function GET(req: Request) {
  const { tenantId, projectId, from, to, category } = extractParams(req);

  const result = await queryService.query({
    tenantId,
    projectId,
    timeRange: { from: new Date(from), to: new Date(to) },
    category,
    limit: 100,
  });

  return Response.json(result);
}

// Convenience method for session metrics
const metrics = await queryService.getSessionMetrics(tenantId, projectId, {
  from: startOfDay,
  to: endOfDay,
});
```

## 6. Migration Bridge (Optional)

Enable dual-write from existing trace/metrics stores:

```typescript
// In TraceStore after creating trace:
import { emitTraceEventAsAnalytics } from '@abl/eventstore/migration';

await emitTraceEventAsAnalytics(emitter, traceEvent);

// In LLM metrics writer:
import { emitLLMMetricsAsAnalytics } from '@abl/eventstore/migration';

await emitLLMMetricsAsAnalytics(emitter, metricsRow);
```

## 7. Webhook Subscriptions

Extend webhook subscription model:

```typescript
// packages/database/src/models/webhook-subscription.model.ts

// Add to supported event patterns:
// - events.session.*
// - events.llm.call.completed
// - events.agent.escalated
// etc.
```

## 8. ClickHouse Initialization

The `platform_events` table is automatically created when you run:

```bash
pnpm run clickhouse:init
```

This executes the DDL defined in `packages/database/src/clickhouse-schemas/init.ts`.

## 9. Studio Dashboard

Create analytics dashboards:

```typescript
// Example: Session completion rate chart
const result = await queryService.aggregate({
  tenantId,
  projectId,
  timeRange: { from, to },
  groupBy: ['day'],
  metrics: ['count', 'avg_duration', 'error_rate'],
  filters: {
    eventTypes: ['session.ended'],
  },
});

// Example: LLM cost breakdown
const costs = await queryService.getCostBreakdown(tenantId, projectId, timeRange);
```

## 10. Monitoring

Add OTEL metrics for buffer monitoring:

```typescript
// packages/observatory/src/metrics.ts

const eventBufferPending = meter.createObservableGauge('eventstore.buffer.pending', {
  description: 'Number of events pending in write buffer',
});

eventBufferPending.addCallback((result) => {
  result.observe(emitter.pendingCount, { table: 'platform_events' });
});
```

Alert when `eventstore.buffer.pending > 50000` (50% capacity).
