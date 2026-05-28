# @abl/eventstore

Unified event storage framework for the ABL platform.

## Features

- **Pluggable storage**: ClickHouse (production), Memory (tests), Remote (HTTP client)
- **Pluggable queuing**: Direct (pass-through), BullMQ (Redis), Kafka (streaming), Memory (tests)
- **40+ event types** across 11 categories (session, LLM, tool, agent, gather, flow, channel, deployment, search, voice, audit)
- **Three-level failover** for zero data loss: queue → direct store → filesystem WAL
- **Schema validation** with Zod - add new event types without code changes
- **Hot/warm/cold storage** with plan-based retention (FREE/TEAM/BUSINESS/ENTERPRISE)
- **GDPR compliance** - cascade deletion, PII scrubbing, right-to-erasure
- **Webhook forwarding** with pattern matching (`events.session.*`)
- **Service extraction** - switch from embedded to standalone via config

## Installation

```bash
pnpm add @abl/eventstore
```

## Usage

### Embedded Mode (Default)

```typescript
import { createEventStore } from '@abl/eventstore';

const { emitter, queryService, retention, gdpr } = createEventStore({
  mode: 'embedded',
  backend: 'clickhouse',
  queue: { type: 'direct' }, // Lowest latency, no extra infra
  clickhouse: { client: getClickHouseClient() },
});

// Emit events
emitter.emit({
  event_type: 'session.started',
  tenant_id: 'tenant_123',
  project_id: 'proj_456',
  session_id: 'sess_789',
  timestamp: new Date(),
  data: {
    channel: 'web',
    agent_name: 'booking_agent',
    deployment_id: 'dep_001',
  },
});

// Query events
const result = await queryService.query({
  tenantId: 'tenant_123',
  projectId: 'proj_456',
  timeRange: { from: startDate, to: endDate },
  category: 'session',
});
```

### Resilient Mode (Zero Data Loss)

```typescript
const { emitter, recovery } = createEventStore({
  mode: 'embedded',
  backend: 'clickhouse',
  queue: { type: 'kafka', kafka: { brokers: ['kafka:9092'] } },
  resilience: {
    enabled: true,
    wal: { directory: '/var/eventstore-wal/' },
  },
});

// On startup - replay any leftover WAL from crashes
await recovery.recoverFromWAL();
await recovery.startPeriodicRecovery(); // Every 5 minutes
```

### Standalone Service Mode

**Runtime pods:**

```typescript
const { emitter, queryService } = createEventStore({
  mode: 'remote',
  queue: { type: 'bullmq', redis: { url: process.env.REDIS_URL } },
  queryUrl: 'http://eventstore-svc:3100',
});
```

**Event storage service pod:**

```typescript
const { store, queryService, retention } = createEventStore({
  mode: 'service',
  backend: 'clickhouse',
  queue: { type: 'bullmq', redis: { url: process.env.REDIS_URL } },
});
```

## Architecture

See [`docs/plans/2026-02-27-unified-analytics-event-framework-design.md`](../../docs/plans/2026-02-27-unified-analytics-event-framework-design.md) for full design documentation (note: doc uses "analytics" terminology but implementation uses "eventstore").

## Testing

```bash
pnpm test                # Run all tests
pnpm test:watch         # Watch mode
pnpm test:coverage      # Coverage report
```

## License

Proprietary - Kore.ai
