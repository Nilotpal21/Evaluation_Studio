# Unified Analytics Event Framework — Implementation Plan

## Context

The platform has mature observability infrastructure (11 ClickHouse tables, 22 trace event types, BufferedWriter, retention scheduler, GDPR cascade deletion, webhook delivery). But analytics data is fragmented across specialized tables (`traces`, `llm_metrics`, `audit_events`, `search_queries`) with no unified event stream. Adding new metrics requires touching multiple files — new table DDL, new store implementation, new API endpoint.

This plan creates a **unified event framework** with a single `analytics_events` table as source of truth. Every operation emits a validated event. Analytics queries are written against this stream on demand. Materialized views are added lazily when specific queries prove too slow.

**Goal:** Extensible, pluggable analytics architecture serving governance, compliance, and business use cases — with schema validation, tiered retention, GDPR compliance, zero runtime impact, webhook forwarding, and clean module boundaries for future extraction.

**Architecture:** New `packages/analytics/` package with: Zod-validated event registry, fire-and-forget emitter behind an **`IAnalyticsStore` abstraction layer**, tenant-scoped query service with Redis caching, retention/GDPR integration, webhook forwarding via existing BullMQ delivery pipeline, and migration bridges for existing trace/metrics data. All components depend on the interface, not on ClickHouse directly — so the storage backend can be swapped in the future without changing any consumer code.

**Tech Stack:** ClickHouse (storage), Redis (query cache), Zod (schema validation), ULID (event IDs), BullMQ (webhook delivery). Storage access goes through `IAnalyticsStore` interface.

---

## Package Structure

```
packages/analytics/
  src/
    index.ts                          # Barrel export: interfaces, factory, registry, emitter

    # --- Core interfaces (NO storage or queue dependency) ---
    interfaces/
      analytics-store.ts              # IAnalyticsStore — pluggable storage contract
      analytics-emitter.ts            # IAnalyticsEmitter — write path contract
      event-queue.ts                  # IEventQueue — pluggable queue contract (BullMQ, Redis Streams, Kafka)
      analytics-query.ts              # IAnalyticsQueryService — read path contract
      analytics-retention.ts          # IAnalyticsRetention — lifecycle management contract
      analytics-gdpr.ts               # IAnalyticsGDPR — erasure contract
      types.ts                        # Shared types: TimeRange, QueryParams, AggregateParams, etc.

    # --- Event schema (NO storage dependency) ---
    schema/
      analytics-event.ts              # AnalyticsEvent interface (pure types, no DB row types)
      event-registry.ts               # EventRegistry class (Zod validation per event_type)
      event-categories.ts             # Category constants
      events/
        session-events.ts
        llm-events.ts
        tool-events.ts
        agent-events.ts
        gather-events.ts
        flow-events.ts
        channel-events.ts
        deployment-events.ts
        search-events.ts
        voice-events.ts
        auth-events.ts

    # --- Emitter (depends on IAnalyticsStore, NOT on any DB) ---
    emitter/
      analytics-emitter.ts            # Emitter impl: validates via registry, writes via IAnalyticsStore
      session-event-emitter.ts        # Context-bound convenience wrapper

    # --- Query service (depends on IAnalyticsStore, NOT on any DB) ---
    query/
      analytics-query-service.ts      # Reads via IAnalyticsStore, caches via ICacheProvider
      cache.ts                        # ICacheProvider interface + Redis impl + in-memory impl

    # --- Storage implementations (each implements IAnalyticsStore) ---
    stores/
      clickhouse/
        clickhouse-analytics-store.ts # IAnalyticsStore impl using BufferedClickHouseWriter
        clickhouse-row-mapper.ts      # AnalyticsEvent ↔ ClickHouse row conversion
        analytics-events-table.ts     # DDL for analytics_events table
        materialized-views.ts         # Pre-designed MVs (deploy when needed)
      memory/
        memory-analytics-store.ts     # IAnalyticsStore impl for tests (in-memory array)
      remote/
        remote-analytics-query-client.ts     # IAnalyticsReader impl → HTTP to analytics service
        remote-analytics-lifecycle-client.ts  # IAnalyticsLifecycle impl → HTTP to analytics service

    # --- Queue implementations (each implements IEventQueue) ---
    queues/
      direct-queue.ts                 # IEventQueue impl: no queue, direct pass-through (default)
      bullmq-queue.ts                 # IEventQueue impl: BullMQ backed by Redis
      kafka-queue.ts                  # IEventQueue impl: Kafka producer/consumer
      memory-queue.ts                 # IEventQueue impl: in-memory for tests

    # --- Factory (wires everything together) ---
    factory.ts                        # createAnalytics(config) → { emitter, queryService, retention, gdpr }

    # --- Retention + GDPR (delegates to IAnalyticsStore) ---
    retention/
      analytics-retention-service.ts  # Calls IAnalyticsStore.purge() / .scrubPII()
      analytics-gdpr-service.ts       # Calls IAnalyticsStore.deleteBySession() / .anonymizeActor()

    # --- Webhook forwarding ---
    webhook/
      analytics-webhook-forwarder.ts

    # --- Resilience & failover ---
    resilience/
      filesystem-wal.ts               # Write-Ahead Log (JSONL append-only files)
      analytics-recovery-service.ts   # WAL replay on startup + periodic
    emitters/
      resilient-analytics-emitter.ts  # 3-level failover: queue → direct → WAL

    # --- Migration bridge ---
    migration/
      trace-bridge.ts
      llm-metrics-bridge.ts

  __tests__/
    event-registry.test.ts
    analytics-emitter.test.ts
    analytics-query-service.test.ts
    clickhouse-analytics-store.test.ts
    memory-analytics-store.test.ts
    store-contract.test.ts            # Shared tests run against all IAnalyticsStore impls
    queue-contract.test.ts            # Shared tests run against all IEventQueue impls
    analytics-retention.test.ts
    analytics-gdpr.test.ts
    analytics-webhook-forwarder.test.ts
    filesystem-wal.test.ts            # WAL append, replay, cleanup tests
    resilient-emitter.test.ts         # 3-level failover cascade tests
    analytics-recovery.test.ts        # WAL recovery service tests
    trace-bridge.test.ts
```

---

## Critical Files (Existing — To Modify)

| File                                                         | Change                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `packages/database/src/clickhouse-schemas/init.ts`           | Add `analytics_events` table DDL to TABLES array                              |
| `packages/database/src/cascade/cascade-delete.ts`            | Add analytics event purge in `deleteSession`, `deleteProject`, `deleteTenant` |
| `packages/database/src/models/webhook-subscription.model.ts` | Extend supported events with `analytics.*` patterns                           |
| `apps/studio/src/services/retention/retention-service.ts`    | Add `analytics` field to RetentionPolicy, extend RetentionStore interface     |
| `apps/studio/src/services/retention/mongo-gdpr-store.ts`     | Add analytics deletion/anonymization to GDPR cascade                          |

## Critical Files (Existing — To Reuse, Not Modify)

| File                                                   | What We Reuse                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/database/src/clickhouse.ts`                  | `BufferedClickHouseWriter` (10K batch/5s flush/100K max/3 retries) |
| `packages/compiler/src/platform/stores/trace-store.ts` | `TraceStore` abstract class (migration bridge decorates this)      |
| `apps/runtime/src/services/queues/delivery-worker.ts`  | BullMQ webhook delivery (HMAC, SSRF protection, retry)             |
| `packages/shared/src/services/encryption-service.ts`   | `EncryptionService` for optional data encryption                   |
| `packages/observatory/src/schema/trace-events.ts`      | Trace event types (migration bridge maps these)                    |

---

## Pluggable Storage Interface (`IAnalyticsStore`)

This is the core abstraction that makes the entire persistence layer swappable. Every component (emitter, query service, retention, GDPR) depends on this interface — never on ClickHouse, MongoDB, or any specific database.

### The Interface

```typescript
// packages/analytics/src/interfaces/analytics-store.ts

import type { AnalyticsEvent } from '../schema/analytics-event.js';

/** ─── Write operations ─── */
export interface IAnalyticsWriter {
  /** Append a single event. Must be non-blocking (fire-and-forget). */
  write(event: AnalyticsEvent): void;

  /** Append a batch of events. Must be non-blocking. */
  writeBatch(events: AnalyticsEvent[]): void;

  /** Flush any buffered events to storage. */
  flush(): Promise<void>;

  /** Graceful shutdown: flush remaining buffer, release connections. */
  close(): Promise<void>;

  /** Number of events currently buffered (for monitoring). */
  readonly pendingCount: number;
}

/** ─── Read operations ─── */
export interface IAnalyticsReader {
  /** Query raw events with filtering + pagination. */
  query(params: AnalyticsQueryParams): Promise<AnalyticsQueryResult>;

  /** Aggregate events (GROUP BY + metrics). */
  aggregate(params: AnalyticsAggregateParams): Promise<AnalyticsAggregateResult>;

  /** Count events grouped by a dimension. */
  count(params: AnalyticsCountParams): Promise<AnalyticsCountResult>;
}

/** ─── Lifecycle operations (retention + GDPR) ─── */
export interface IAnalyticsLifecycle {
  /** Delete events older than cutoff for a tenant. */
  purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult>;

  /** Anonymize PII in event data for events matching criteria. */
  scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void>;

  /** Delete all events for specific sessions (GDPR cascade). */
  deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void>;

  /** Anonymize actor identity across all events (GDPR right-to-erasure). */
  anonymizeActor(tenantId: string, actorId: string): Promise<void>;

  /** Delete ALL events for a tenant (tenant offboarding). */
  deleteTenant(tenantId: string): Promise<void>;
}

/** ─── Combined: the full store contract ─── */
export interface IAnalyticsStore extends IAnalyticsWriter, IAnalyticsReader, IAnalyticsLifecycle {
  /** Human-readable backend name for logging (e.g. "clickhouse", "postgres", "memory"). */
  readonly backendName: string;
}
```

### Query/Result Types

```typescript
// packages/analytics/src/interfaces/types.ts

export interface TimeRange {
  from: Date;
  to: Date;
}

export type EventCategory =
  | 'session'
  | 'llm'
  | 'tool'
  | 'agent'
  | 'search'
  | 'audit'
  | 'channel'
  | 'deployment'
  | 'system';

export interface AnalyticsQueryParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  category?: EventCategory;
  eventTypes?: string[];
  sessionId?: string;
  agentName?: string;
  hasError?: boolean;
  limit?: number; // default 100, max 10000
  offset?: number;
}

export interface AnalyticsQueryResult {
  events: AnalyticsEvent[];
  total: number;
  hasMore: boolean;
}

export interface AnalyticsAggregateParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  groupBy: ('category' | 'event_type' | 'agent_name' | 'channel' | 'hour' | 'day')[];
  metrics: ('count' | 'avg_duration' | 'error_rate' | 'p95_duration' | 'sum_tokens' | 'sum_cost')[];
  filters?: {
    category?: EventCategory;
    eventTypes?: string[];
    hasError?: boolean;
  };
  /** Optional: extract a numeric field from data JSON for aggregation. */
  dataField?: string;
}

export interface AnalyticsAggregateResult {
  buckets: Record<string, unknown>[];
}

export interface AnalyticsCountParams {
  tenantId: string;
  projectId: string;
  timeRange: TimeRange;
  groupBy: 'category' | 'event_type' | 'agent_name' | 'channel';
  filters?: {
    category?: EventCategory;
    hasError?: boolean;
  };
}

export interface AnalyticsCountResult {
  counts: Array<{ key: string; count: number; errorCount: number }>;
}

export interface PurgeResult {
  /** Estimated rows affected. -1 if backend doesn't support exact counts. */
  deletedEstimate: number;
}
```

### Event Queue Interface (`IEventQueue`)

The queue sits between the emitter and the store. It decouples "accept an event" from "persist an event."

```typescript
// packages/analytics/src/interfaces/event-queue.ts

import type { AnalyticsEvent } from '../schema/analytics-event.js';

export interface IEventQueue {
  /** Enqueue an event for processing. Must be non-blocking. */
  enqueue(event: AnalyticsEvent): void;

  /** Enqueue a batch. Must be non-blocking. */
  enqueueBatch(events: AnalyticsEvent[]): void;

  /**
   * Register the consumer that processes dequeued events.
   * Called once at startup. The consumer typically writes to IAnalyticsStore.
   */
  onProcess(handler: (event: AnalyticsEvent) => void): void;

  /** Flush pending events through to the consumer. */
  flush(): Promise<void>;

  /** Graceful shutdown: drain queue, then close. */
  close(): Promise<void>;

  /** Number of events waiting in the queue (for monitoring). */
  readonly pendingCount: number;

  /** Queue backend name for logging. */
  readonly queueName: string;

  /** Health check — returns false if queue infrastructure is down (e.g., Redis/Kafka unreachable). */
  isHealthy(): boolean;
}
```

**Four implementations:**

```typescript
// 1. DirectQueue — no queue, synchronous pass-through (default, lowest latency)
//    enqueue(event) → immediately calls handler(event)
//    Use when: analytics store write is already buffered (ClickHouse BufferedWriter)
export class DirectQueue implements IEventQueue {
  /* ... */
}

// 2. BullMQEventQueue — Redis-backed persistent queue
//    enqueue(event) → queue.add(event)
//    Worker calls handler(event) from the consumer side
//    Use when: need durability, retry, or decoupled processing within existing Redis infra
export class BullMQEventQueue implements IEventQueue {
  /* ... */
}

// 3. KafkaEventQueue — Kafka producer/consumer
//    enqueue(event) → producer.send(topic, event) [non-blocking with batching]
//    Consumer group calls handler(event) from the consumer side
//    Use when: need high-throughput event streaming, cross-service fan-out,
//    or integration with external data pipelines (Spark, Flink, data lake)
//    Config: topic name, partition count, consumer group ID, batch size
export class KafkaEventQueue implements IEventQueue {
  /* ... */
}

// 4. MemoryEventQueue — in-memory array for tests
//    enqueue(event) → push to array, drain on flush()
export class MemoryEventQueue implements IEventQueue {
  /* ... */
}
```

**How it plugs into the data flow:**

```
                              IEventQueue
                                  │
              ┌───────────┬───────┼───────────┬──────────┐
              ▼           ▼       ▼           ▼          │
         DirectQueue  BullMQ   Kafka     MemoryQueue     │
         (pass-thru)  (Redis)  (streaming) (tests)       │
              │           │       │           │          │
              └─────┬─────┘───────┘───────────┘          │
                     ▼
              handler(event) → store.write(event)
                                    │
                              IAnalyticsStore
```

**Emitter flow with queue:**

```typescript
// AnalyticsEmitter.emit() does:
// 1. Validate event via EventRegistry
// 2. Enqueue via IEventQueue (non-blocking)
// 3. Optionally forward to webhook (async, fire-and-forget)

class AnalyticsEmitter implements IAnalyticsEmitter {
  constructor(
    private queue: IEventQueue,
    private registry: EventRegistry,
    private webhookForwarder?: AnalyticsWebhookForwarder,
  ) {
    // Wire queue consumer → store write
    // (store is injected into the queue's onProcess handler at factory level)
  }

  emit(event: AnalyticsEvent): void {
    const result = this.registry.safeValidateData(event.event_type, event.data);
    if (!result.success) {
      /* log warning, return */
    }

    this.queue.enqueue(event);

    if (this.webhookForwarder) {
      this.webhookForwarder.maybeForward(event).catch(/* log */);
    }
  }
}
```

**Factory wiring:**

```typescript
export function createAnalytics(config: AnalyticsConfig): AnalyticsServices {
  const store = config.backend === 'clickhouse'
    ? new ClickHouseAnalyticsStore(config.clickhouse!)
    : new MemoryAnalyticsStore();

  // Create queue (default: direct pass-through)
  const queue = createEventQueue(config.queue ?? { type: 'direct' });

  // Wire: queue dequeues → store writes
  queue.onProcess((event) => store.write(event));

  const emitter = new AnalyticsEmitter(queue, analyticsEventRegistry, ...);
  // ... rest unchanged
}

function createEventQueue(config: EventQueueConfig): IEventQueue {
  switch (config.type) {
    case 'direct':  return new DirectQueue();
    case 'bullmq':  return new BullMQEventQueue(config.redis!);
    case 'kafka':   return new KafkaEventQueue(config.kafka!);
    case 'memory':  return new MemoryEventQueue();
  }
}
```

### Cache Provider Interface

```typescript
// packages/analytics/src/query/cache.ts

/** Pluggable cache for query results. */
export interface ICacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Two implementations shipped:
// 1. RedisCacheProvider  — production (uses existing Redis client)
// 2. MemoryCacheProvider — tests (in-memory Map with TTL expiry)
```

### ClickHouse Implementation (Default)

```typescript
// packages/analytics/src/stores/clickhouse/clickhouse-analytics-store.ts

export class ClickHouseAnalyticsStore implements IAnalyticsStore {
  readonly backendName = 'clickhouse';
  private writer: BufferedClickHouseWriter<ClickHouseAnalyticsRow>;
  private client: ClickHouseClient;
  private rowMapper: ClickHouseRowMapper;

  constructor(config: {
    client: ClickHouseClient;
    encryptionService?: EncryptionService;
    writerOptions?: Partial<BufferedWriterOptions>;
  }) {
    /* ... */
  }

  // --- IAnalyticsWriter ---
  write(event: AnalyticsEvent): void {
    this.writer.insert(this.rowMapper.toRow(event));
  }
  writeBatch(events: AnalyticsEvent[]): void {
    this.writer.insertMany(events.map((e) => this.rowMapper.toRow(e)));
  }
  flush(): Promise<void> {
    return this.writer.flush();
  }
  close(): Promise<void> {
    return this.writer.close();
  }
  get pendingCount(): number {
    return this.writer.pending;
  }

  // --- IAnalyticsReader ---
  async query(params: AnalyticsQueryParams): Promise<AnalyticsQueryResult> {
    // Builds parameterized SQL, executes on ClickHouse, maps rows back
  }
  async aggregate(params: AnalyticsAggregateParams): Promise<AnalyticsAggregateResult> {
    // GROUP BY query with JSONExtract for data fields
  }
  async count(params: AnalyticsCountParams): Promise<AnalyticsCountResult> {
    // COUNT(*) grouped by dimension
  }

  // --- IAnalyticsLifecycle ---
  async purgeExpired(tenantId, olderThan): Promise<PurgeResult> {
    // ALTER TABLE ... DELETE WHERE tenant_id = ? AND timestamp < ?
  }
  async scrubPII(tenantId, olderThan, eventTypes): Promise<void> {
    // ALTER TABLE ... UPDATE data = '{"anonymized":true}' WHERE ...
  }
  async deleteBySessionIds(tenantId, sessionIds): Promise<void> {
    // ALTER TABLE ... DELETE WHERE tenant_id = ? AND session_id IN (?)
  }
  async anonymizeActor(tenantId, actorId): Promise<void> {
    // ALTER TABLE ... UPDATE actor_id = '[ANONYMIZED:hash]' WHERE ...
  }
  async deleteTenant(tenantId): Promise<void> {
    // ALTER TABLE ... DELETE WHERE tenant_id = ?
  }
}
```

### In-Memory Implementation (Tests)

```typescript
// packages/analytics/src/stores/memory/memory-analytics-store.ts

export class MemoryAnalyticsStore implements IAnalyticsStore {
  readonly backendName = 'memory';
  private events: AnalyticsEvent[] = [];
  private maxSize: number;

  constructor(config?: { maxSize?: number }) {
    this.maxSize = config?.maxSize ?? 100_000;
  }

  // --- IAnalyticsWriter ---
  write(event: AnalyticsEvent): void {
    if (this.events.length >= this.maxSize) this.events.shift();
    this.events.push(event);
  }
  writeBatch(events: AnalyticsEvent[]): void {
    events.forEach((e) => this.write(e));
  }
  async flush(): Promise<void> {
    /* no-op */
  }
  async close(): Promise<void> {
    this.events = [];
  }
  get pendingCount(): number {
    return 0;
  }

  // --- IAnalyticsReader ---
  async query(params: AnalyticsQueryParams): Promise<AnalyticsQueryResult> {
    // Filter this.events in-memory, apply pagination
  }
  async aggregate(params: AnalyticsAggregateParams): Promise<AnalyticsAggregateResult> {
    // Group/aggregate in-memory
  }
  async count(params: AnalyticsCountParams): Promise<AnalyticsCountResult> {
    // Count in-memory
  }

  // --- IAnalyticsLifecycle ---
  async purgeExpired(tenantId, olderThan) {
    /* filter array */
  }
  async scrubPII(tenantId, olderThan, eventTypes) {
    /* mutate data field */
  }
  async deleteBySessionIds(tenantId, sessionIds) {
    /* filter array */
  }
  async anonymizeActor(tenantId, actorId) {
    /* replace actor_id */
  }
  async deleteTenant(tenantId) {
    /* filter array */
  }
}
```

### Factory

```typescript
// packages/analytics/src/factory.ts

export type AnalyticsBackend = 'clickhouse' | 'memory';

export type EventQueueType = 'direct' | 'bullmq' | 'kafka' | 'memory';

export interface EventQueueConfig {
  type: EventQueueType;
  redis?: { url: string }; // required for bullmq
  kafka?: {
    // required for kafka
    brokers: string[]; // e.g. ['kafka1:9092', 'kafka2:9092']
    topic?: string; // default: 'analytics-events'
    groupId?: string; // consumer group (default: 'analytics-consumer')
    partitions?: number; // topic partition count (default: 6)
  };
  concurrency?: number; // bullmq/kafka consumer concurrency (default: 10)
  maxRetries?: number; // retry count (default: 3)
}

export type AnalyticsMode = 'embedded' | 'remote' | 'service';

export interface AnalyticsConfig {
  mode: AnalyticsMode; // 'embedded' (default), 'remote' (runtime→service), 'service' (analytics pod)
  backend?: AnalyticsBackend; // used in 'embedded' and 'service' modes
  queue?: EventQueueConfig; // default: { type: 'direct' }
  queryUrl?: string; // used in 'remote' mode — URL of standalone analytics service
  redis?: { url: string }; // used when queue.type='bullmq' or mode='remote'/'service'
  clickhouse?: { client: ClickHouseClient; encryptionService?: EncryptionService };
  cache?: { provider: ICacheProvider; ttlSeconds?: number };
  webhook?: {
    deliveryQueue: BullMQQueue | null;
    getSubscriptions: (tenantId: string) => Promise<WebhookSubscription[]>;
  };
  validation?: { enabled?: boolean; strictMode?: boolean };
}

export interface AnalyticsServices {
  store?: IAnalyticsStore; // only present in 'embedded' and 'service' modes
  emitter: IAnalyticsEmitter;
  queryService: IAnalyticsQueryService;
  retention: IAnalyticsRetention;
  gdpr: IAnalyticsGDPR;
  recovery?: AnalyticsRecoveryService; // WAL recovery (only when resilience.wal is configured)
  webhookForwarder?: AnalyticsWebhookForwarder;
}

export function createAnalytics(config: AnalyticsConfig): AnalyticsServices {
  // Mode determines what runs locally vs. remotely
  // See "Design Decision #6: Service Extraction via Config Change" for full details

  if (config.mode === 'remote') {
    // RUNTIME POD in standalone mode: writes go to queue, reads go to remote service
    const queue = createEventQueue(config.queue ?? { type: 'bullmq', redis: config.redis! });
    const remoteReader = new RemoteAnalyticsQueryClient(config.queryUrl!);
    const remoteLifecycle = new RemoteAnalyticsLifecycleClient(config.queryUrl!);
    return {
      emitter: new AnalyticsEmitter(queue, analyticsEventRegistry, config.validation),
      queryService: new AnalyticsQueryService(remoteReader, config.cache?.provider ?? null),
      retention: new AnalyticsRetentionService(remoteLifecycle),
      gdpr: new AnalyticsGDPRService(remoteLifecycle),
    };
  }

  // 'embedded' or 'service' — both own the store locally
  const store =
    (config.backend ?? 'clickhouse') === 'clickhouse'
      ? new ClickHouseAnalyticsStore(config.clickhouse!)
      : new MemoryAnalyticsStore();

  const primaryQueue = createEventQueue(config.queue ?? { type: 'direct' });
  primaryQueue.onProcess((event) => store.write(event));

  const webhookForwarder = config.webhook?.deliveryQueue
    ? new AnalyticsWebhookForwarder(config.webhook)
    : undefined;

  // Resilience: 3-level failover if enabled
  let emitter: IAnalyticsEmitter;
  let recovery: AnalyticsRecoveryService | undefined;

  if (config.resilience?.enabled !== false && config.resilience?.wal) {
    // Resilient mode: primary queue → fallback direct → WAL
    const wal = new FileSystemWAL(config.resilience.wal);
    const fallbackQueue = new DirectQueue(); // Bypass primary queue, write directly to store
    fallbackQueue.onProcess((event) => store.write(event));
    emitter = new ResilientAnalyticsEmitter(
      primaryQueue,
      fallbackQueue,
      wal,
      analyticsEventRegistry,
      config.resilience,
    );
    recovery = new AnalyticsRecoveryService(wal, store);
  } else {
    // Standard mode: single queue path
    emitter = new AnalyticsEmitter(
      primaryQueue,
      analyticsEventRegistry,
      config.validation,
      webhookForwarder,
    );
  }

  return {
    store,
    emitter,
    queryService: new AnalyticsQueryService(store, config.cache?.provider ?? null),
    retention: new AnalyticsRetentionService(store),
    gdpr: new AnalyticsGDPRService(store),
    recovery,
    webhookForwarder,
  };
}
```

### How Each Component Uses the Interface

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Consumer Layer                                   │
│  (Runtime callsites, Studio UI, Retention Scheduler, GDPR Service)     │
└─────────┬──────────────┬──────────────┬──────────────┬─────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
   AnalyticsEmitter  QueryService  RetentionSvc   GDPRService
   (validates +      (caches +     (calls         (calls
    calls write())    calls query)  purge/scrub)   delete/anonymize)
          │              │              │              │
          ▼              ▼              ▼              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                    IAnalyticsStore                            │
   │   write()  query()  aggregate()  purge()  delete()  scrub() │
   └──────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      ClickHouse         Memory          (Future: Postgres,
      Analytics          Analytics        MongoDB, Kafka, etc.)
      Store              Store
```

**Key principle:** Nothing above the `IAnalyticsStore` line knows what database is being used. The emitter calls `store.write()`, the query service calls `store.query()`, and the retention service calls `store.purgeExpired()`. Swapping ClickHouse for PostgreSQL means implementing a new class that satisfies `IAnalyticsStore` — zero changes to emitter, query service, retention, GDPR, webhook forwarder, or any callsite.

### Shared Store Contract Tests

A single test suite that runs against every `IAnalyticsStore` implementation to guarantee behavioral equivalence:

```typescript
// __tests__/store-contract.test.ts
export function runStoreContractTests(createStore: () => IAnalyticsStore) {
  describe('IAnalyticsStore contract', () => {
    it('write() + query() roundtrip', async () => {
      /* ... */
    });
    it('query() filters by tenantId (isolation)', async () => {
      /* ... */
    });
    it('query() filters by timeRange', async () => {
      /* ... */
    });
    it('aggregate() groups by category', async () => {
      /* ... */
    });
    it('purgeExpired() removes old events', async () => {
      /* ... */
    });
    it('deleteBySessionIds() removes matching events', async () => {
      /* ... */
    });
    it('anonymizeActor() replaces actor_id', async () => {
      /* ... */
    });
    it('deleteTenant() removes all tenant events', async () => {
      /* ... */
    });
    // ... etc
  });
}

// In memory-analytics-store.test.ts:
runStoreContractTests(() => new MemoryAnalyticsStore());

// In clickhouse-analytics-store.test.ts:
runStoreContractTests(() => new ClickHouseAnalyticsStore({ client: testClient }));
```

---

## Complete Event Catalog

Every emittable event, grouped by category, with the exact callsite where it gets emitted, the data payload fields, and what queries it enables.

### Session Events (category: `session`)

| Event Type           | Emitted From                                  | Data Payload                                                                                                                                                |
| -------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`    | `session-service.ts` → `createSession()`      | `{ channel, agent_name, deployment_id, resolution_method: "new"\|"resumed"\|"artifact", caller_identity_tier: "anonymous"\|"identified"\|"verified" }`      |
| `session.ended`      | `runtime-executor.ts` → session completion    | `{ reason: "completed"\|"timeout"\|"error"\|"user_exit", total_duration_ms, total_turns, total_llm_calls, total_tool_calls, total_tokens, estimated_cost }` |
| `session.resumed`    | `session-resolver.ts` → `resolveSession()`    | `{ resolution_method: "explicit_id"\|"channel_artifact", original_session_age_ms, channel }`                                                                |
| `session.terminated` | `runtime-executor.ts` → `reapStaleSessions()` | `{ reason: "stale"\|"expired"\|"over_capacity", inactivity_duration_ms }`                                                                                   |

**Example queries these enable:**

```sql
-- Daily active sessions by channel (Studio dashboard overview)
SELECT
  toDate(timestamp) AS day,
  JSONExtractString(data, 'channel') AS channel,
  count() AS session_count,
  countIf(has_error) AS error_sessions,
  round(countIf(has_error) / count() * 100, 2) AS error_rate_pct
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type = 'session.started'
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY day, channel
ORDER BY day DESC;

-- Average session duration and completion rate (business KPI)
SELECT
  toDate(timestamp) AS day,
  count() AS ended_sessions,
  round(avg(JSONExtractUInt(data, 'total_duration_ms')) / 1000, 1) AS avg_duration_sec,
  round(countIf(JSONExtractString(data, 'reason') = 'completed') / count() * 100, 1) AS completion_rate_pct,
  round(avg(JSONExtractFloat(data, 'estimated_cost')), 4) AS avg_cost_per_session
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type = 'session.ended'
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY day
ORDER BY day DESC;

-- Session timeout trend (governance: are sessions being abandoned?)
SELECT
  toStartOfHour(timestamp) AS hour,
  JSONExtractString(data, 'reason') AS termination_reason,
  count() AS count
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND event_type IN ('session.ended', 'session.terminated')
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY hour, termination_reason
ORDER BY hour DESC;
```

### LLM Events (category: `llm`)

| Event Type           | Emitted From                                  | Data Payload                                                                                                                  |
| -------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `llm.call.completed` | `session-llm-client.ts` → `chatWithToolUse()` | `{ model, provider, input_tokens, output_tokens, total_tokens, estimated_cost, latency_ms, streaming_used, tool_call_count }` |
| `llm.call.failed`    | `session-llm-client.ts` → error path          | `{ model, provider, error_type, error_message, latency_ms, retry_attempt }`                                                   |
| `llm.model.resolved` | `model-resolution.ts`                         | `{ requested_model, resolved_model, resolution_source: "agent"\|"project"\|"tenant"\|"env" }`                                 |

**Example queries:**

```sql
-- LLM cost breakdown by model (billing dashboard)
SELECT
  JSONExtractString(data, 'model') AS model,
  JSONExtractString(data, 'provider') AS provider,
  count() AS call_count,
  sum(JSONExtractUInt(data, 'input_tokens')) AS total_input_tokens,
  sum(JSONExtractUInt(data, 'output_tokens')) AS total_output_tokens,
  round(sum(JSONExtractFloat(data, 'estimated_cost')), 4) AS total_cost,
  round(avg(JSONExtractUInt(data, 'latency_ms'))) AS avg_latency_ms,
  quantile(0.95)(JSONExtractUInt(data, 'latency_ms')) AS p95_latency_ms
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type = 'llm.call.completed'
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY model, provider
ORDER BY total_cost DESC;

-- LLM error rate trend (ops alert: is a provider degraded?)
SELECT
  toStartOfHour(timestamp) AS hour,
  JSONExtractString(data, 'provider') AS provider,
  countIf(event_type = 'llm.call.completed') AS success,
  countIf(event_type = 'llm.call.failed') AS failures,
  round(countIf(event_type = 'llm.call.failed') / count() * 100, 2) AS error_rate_pct
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND category = 'llm'
  AND timestamp >= now() - INTERVAL 24 HOUR
GROUP BY hour, provider
ORDER BY hour DESC;

-- Token usage trend (cost governance: are costs growing?)
SELECT
  toDate(timestamp) AS day,
  sum(JSONExtractUInt(data, 'total_tokens')) AS daily_tokens,
  round(sum(JSONExtractFloat(data, 'estimated_cost')), 2) AS daily_cost
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND event_type = 'llm.call.completed'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day;
```

### Tool Events (category: `tool`)

| Event Type            | Emitted From                                  | Data Payload                                                                                           |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tool.call.completed` | `reasoning-executor.ts` → `executeToolCall()` | `{ tool_name, tool_type: "http"\|"lambda"\|"mcp"\|"sandbox", success, latency_ms, result_size_bytes }` |
| `tool.call.failed`    | `flow-step-executor.ts` → error path          | `{ tool_name, tool_type, error_type, error_message, latency_ms }`                                      |
| `tool.call.retried`   | `flow-step-executor.ts` → retry logic         | `{ tool_name, attempt, max_retries, delay_ms, reason }`                                                |
| `tool.error.handled`  | `error-handler-router.ts`                     | `{ tool_name, error_type, handler_action: "retry"\|"respond"\|"handoff"\|"backtrack" }`                |

**Example queries:**

```sql
-- Tool reliability dashboard (which tools fail most?)
SELECT
  JSONExtractString(data, 'tool_name') AS tool,
  JSONExtractString(data, 'tool_type') AS type,
  countIf(event_type = 'tool.call.completed' AND JSONExtractBool(data, 'success')) AS successes,
  countIf(event_type = 'tool.call.failed') AS failures,
  round(avg(JSONExtractUInt(data, 'latency_ms'))) AS avg_latency_ms,
  quantile(0.95)(JSONExtractUInt(data, 'latency_ms')) AS p95_latency_ms
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND category = 'tool'
  AND timestamp >= {from:DateTime64(3)}
GROUP BY tool, type
ORDER BY failures DESC;
```

### Agent Routing Events (category: `agent`)

| Event Type                 | Emitted From                                 | Data Payload                                                                                |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `agent.entered`            | `trace-emitter.ts` → `logAgentEnter()`       | `{ mode: "scripted"\|"reasoning", trigger: "user_message"\|"handoff"\|"delegate" }`         |
| `agent.exited`             | `trace-emitter.ts` → `logAgentExit()`        | `{ result: "completed"\|"handoff"\|"delegate"\|"error", duration_ms }`                      |
| `agent.handoff`            | `routing-executor.ts` → `handleHandoff()`    | `{ from_agent, to_agent, return_expected, context_fields_passed }`                          |
| `agent.escalated`          | `reasoning-executor.ts` → `handleEscalate()` | `{ from_agent, reason, priority: "low"\|"medium"\|"high"\|"critical", user_message_count }` |
| `agent.delegated`          | `reasoning-executor.ts` → `handleDelegate()` | `{ from_agent, to_agent, task_summary, success, duration_ms }`                              |
| `agent.fanout.completed`   | `routing-executor.ts` → `handleFanOut()`     | `{ from_agent, target_count, success_count, failure_count, total_duration_ms }`             |
| `agent.decision`           | `trace-emitter.ts`                           | `{ decision_type: "routing"\|"escalation"\|"constraint", decision, reasoning }`             |
| `agent.constraint.checked` | `constraint-checker.ts`                      | `{ constraint_name, passed, violation_type, handler_action }`                               |

**Example queries:**

```sql
-- Escalation rate by agent (governance: which agents can't handle requests?)
SELECT
  agent_name,
  countIf(event_type = 'agent.entered') AS total_entries,
  countIf(event_type = 'agent.escalated') AS escalations,
  round(countIf(event_type = 'agent.escalated') / countIf(event_type = 'agent.entered') * 100, 2) AS escalation_rate_pct,
  topK(3)(JSONExtractString(data, 'reason')) AS top_escalation_reasons
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND category = 'agent'
  AND event_type IN ('agent.entered', 'agent.escalated')
  AND timestamp >= {from:DateTime64(3)}
GROUP BY agent_name
ORDER BY escalation_rate_pct DESC;

-- Handoff flow visualization (which agent-to-agent paths are most common?)
SELECT
  JSONExtractString(data, 'from_agent') AS from_agent,
  JSONExtractString(data, 'to_agent') AS to_agent,
  count() AS handoff_count
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND event_type = 'agent.handoff'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY from_agent, to_agent
ORDER BY handoff_count DESC;
```

### Gather/Extraction Events (category: `agent`)

| Event Type                   | Emitted From                                         | Data Payload                                                                             |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gather.field.extracted`     | `flow-step-executor.ts` → `extractEntitiesWithLLM()` | `{ step_name, field_name, extraction_method: "llm"\|"pattern", latency_ms }`             |
| `gather.field.validated`     | `llm-field-validator.ts` → `validateFieldsWithLLM()` | `{ field_name, passed, validation_rule, error_message }`                                 |
| `gather.completed`           | `flow-step-executor.ts` → gather finish              | `{ step_name, fields_collected, duration_ms, clarification_count, extraction_attempts }` |
| `gather.correction.detected` | `flow-step-executor.ts` → `detectCorrection()`       | `{ field_name, original_value, corrected_value }`                                        |

**Example queries:**

```sql
-- Gather efficiency (business: how many turns does it take to collect data?)
SELECT
  JSONExtractString(data, 'step_name') AS step,
  count() AS completions,
  round(avg(JSONExtractUInt(data, 'fields_collected')), 1) AS avg_fields,
  round(avg(JSONExtractUInt(data, 'clarification_count')), 1) AS avg_clarifications,
  round(avg(JSONExtractUInt(data, 'duration_ms')) / 1000, 1) AS avg_duration_sec
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND event_type = 'gather.completed'
  AND timestamp >= {from:DateTime64(3)}
GROUP BY step
ORDER BY avg_clarifications DESC;
```

### Flow Events (category: `agent`)

| Event Type          | Emitted From            | Data Payload                                                      |
| ------------------- | ----------------------- | ----------------------------------------------------------------- |
| `flow.step.entered` | `flow-step-executor.ts` | `{ step_name, step_type: "gather"\|"call"\|"respond"\|"branch" }` |
| `flow.step.exited`  | `flow-step-executor.ts` | `{ step_name, duration_ms, next_step }`                           |
| `flow.transition`   | `flow-step-executor.ts` | `{ from_step, to_step, condition, reason }`                       |

### Channel Events (category: `channel`)

| Event Type                  | Emitted From         | Data Payload                                                                                                   |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `channel.message.received`  | `inbound-worker.ts`  | `{ channel_type, connection_id, deduped, processing_duration_ms, status: "processed"\|"failed"\|"duplicate" }` |
| `channel.message.sent`      | message persistence  | `{ channel_type, role, has_pii }`                                                                              |
| `channel.webhook.delivered` | `delivery-worker.ts` | `{ subscription_id, event_type, http_status, latency_ms, status: "delivered"\|"failed", retry_attempt }`       |

**Example queries:**

```sql
-- Channel volume breakdown (business: where are conversations coming from?)
SELECT
  JSONExtractString(data, 'channel_type') AS channel,
  count() AS message_count,
  countIf(JSONExtractString(data, 'status') = 'failed') AS failures,
  round(avg(JSONExtractUInt(data, 'processing_duration_ms'))) AS avg_processing_ms
FROM abl_platform.analytics_events
WHERE tenant_id = {tenantId:String}
  AND event_type = 'channel.message.received'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY channel
ORDER BY message_count DESC;
```

### Deployment Events (category: `deployment`)

| Event Type               | Emitted From           | Data Payload                                                   |
| ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `deployment.created`     | `deployments.ts` route | `{ environment, entry_agent, agent_count, created_by }`        |
| `deployment.retired`     | `deployments.ts` route | `{ draining_started_at, linked_channel_count, retired_by }`    |
| `deployment.rolled_back` | `deployments.ts` route | `{ previous_deployment_id, channels_updated, rolled_back_by }` |

### Voice Events (category: `channel`)

| Event Type              | Emitted From                 | Data Payload                                                                                    |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `voice.session.created` | `realtime-voice-executor.ts` | `{ voice_provider: "twilio"\|"korevg"\|"livekit", direction: "inbound"\|"outbound", call_sid }` |
| `voice.session.ended`   | `realtime-voice-executor.ts` | `{ duration_ms, reason: "user_hangup"\|"agent_hangup"\|"timeout"\|"error" }`                    |

### Search Events (category: `search`)

| Event Type              | Emitted From                    | Data Payload                                                                                         |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `search.query.executed` | `search-ai-runtime` query route | `{ query_id, result_count, latency_ms, ranking_method: "vector"\|"bm25"\|"hybrid", reranking_used }` |
| `search.reranked`       | `reranker-factory.ts`           | `{ candidate_count, reranking_model, latency_ms }`                                                   |

### Auth Events (category: `audit`)

| Event Type           | Emitted From    | Data Payload                                           |
| -------------------- | --------------- | ------------------------------------------------------ |
| `auth.login`         | `auth.ts` route | `{ auth_type: "dev_login"\|"oauth"\|"api_key", role }` |
| `auth.token.created` | `jwt-utils.ts`  | `{ token_type: "access"\|"sdk", expires_in }`          |

---

## Backpressure & Queuing Architecture (Deep Dive)

### Current State: 6 Independent BufferedWriters

The runtime already runs **6 concurrent BufferedClickHouseWriter instances**, each writing to a different table with its own 100K buffer:

| Writer           | Table                     | Typical Volume                         |
| ---------------- | ------------------------- | -------------------------------------- |
| Trace store      | `traces`                  | ~10-50 events/session (highest volume) |
| Message store    | `messages`                | ~2-20 messages/session                 |
| Metrics store    | `llm_metrics`             | ~1-5 records/session                   |
| Audit store      | `audit_events`            | ~1-3 events/session                    |
| Search ingestion | `search_ingestion_events` | Batch on connector sync                |
| Search query     | `search_queries`          | 1 per search query                     |

Adding the analytics writer makes it **7 writers**. For a busy pod handling 100 concurrent sessions, that's roughly:

- **Traces**: ~500-5000 events/5s flush → 1 batch
- **Analytics**: ~500-5000 events/5s flush → 1 batch (comparable to traces — every trace event gets a corresponding analytics event via the bridge, plus session/deployment/auth events)
- **Messages/Metrics/Audit**: Much lower volume → rarely hits batch threshold, mostly timer-flushed

### Do We Need Additional Queuing?

**Short answer: No, the existing BufferedWriter is sufficient. Here's why:**

#### What BufferedWriter Already Handles

The `BufferedClickHouseWriter` (lines 84-196 of `packages/database/src/clickhouse.ts`) implements a **three-layer backpressure defense**:

```
Layer 1: Application Buffer (in-process)
  ┌─────────────────────────────────────────────┐
  │  insert(row) → buffer.push(row)  [O(1)]    │
  │  Buffer capacity: 100,000 rows              │
  │  Overflow: drop oldest 10K, fire onError    │
  │  Flush trigger: 10K rows OR 5s timer        │
  └──────────────────┬──────────────────────────┘
                     │ async flush() — non-blocking
                     ▼
Layer 2: ClickHouse Async Insert Queue (server-side)
  ┌─────────────────────────────────────────────┐
  │  async_insert=1, wait_for_async_insert=1    │
  │  Server buffer: 10MB or 5s                  │
  │  ClickHouse batches internally before       │
  │  writing to MergeTree parts                 │
  └──────────────────┬──────────────────────────┘
                     │
                     ▼
Layer 3: MergeTree Part Merges (storage)
  ┌─────────────────────────────────────────────┐
  │  ClickHouse creates small parts on insert   │
  │  Background merges combine parts            │
  │  Configurable merge rate limits             │
  └─────────────────────────────────────────────┘
```

**Layer 1 protects the runtime:** `insert()` is synchronous — it pushes to an array and returns. No I/O, no await, no network call. The flush happens asynchronously on a timer or when the batch threshold is reached. If ClickHouse is completely down, rows accumulate up to 100K, then oldest get dropped. The runtime never blocks.

**Layer 2 protects ClickHouse:** Even if we flush frequently, ClickHouse's server-side async insert queue batches our writes into larger parts, reducing write amplification.

**Layer 3 handles storage efficiency:** MergeTree background merges consolidate small parts. No action needed from us.

#### Queue Layer (`IEventQueue`) Handles the "What If"

The `IEventQueue` interface sits between the emitter and the store. It provides the abstraction point for different durability/throughput tradeoffs:

| Queue Type         | Behavior                                                                  | When to Use                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirectQueue`      | Synchronous pass-through: `enqueue()` → immediately calls `store.write()` | Default. Store already buffers (ClickHouse BufferedWriter handles batching). Lowest latency, no extra infra.                                                            |
| `BullMQEventQueue` | Redis-backed persistent queue with retry                                  | Need durability (events must not be lost), decoupled processing, or cross-pod fan-in. Uses existing Redis infra.                                                        |
| `KafkaEventQueue`  | Kafka producer/consumer with partitioned topics                           | High-throughput streaming, cross-service fan-out, integration with external data pipelines (Spark, Flink, data lake). Tenant-based partitioning for ordered processing. |
| `MemoryEventQueue` | In-memory array, drain on `flush()`                                       | Tests                                                                                                                                                                   |

**Default flow (DirectQueue + ClickHouse):**

```
emit() → DirectQueue.enqueue() → store.write() → BufferedWriter.insert() → ClickHouse
```

Two layers of buffering are already present (BufferedWriter's 100K in-process buffer + ClickHouse async inserts). No additional queue needed for normal operation.

**Durable flow (BullMQEventQueue + ClickHouse):**

```
emit() → BullMQEventQueue.enqueue() → Redis queue → Worker → store.write() → ClickHouse
```

Adds Redis persistence between emitter and store. Events survive pod restarts. Configurable concurrency and retry.

Switching between queue types = change `config.queue.type` in factory config. No code changes to emitter, store, or callsites.

### Backpressure Configuration

The analytics writer uses tuned settings for its expected volume:

```typescript
const ANALYTICS_WRITER_CONFIG = {
  table: 'abl_platform.analytics_events',
  batchSize: 10_000, // Same as existing writers
  flushIntervalMs: 5_000, // 5s timer flush
  maxBufferSize: 100_000, // 100K rows (~40MB at ~400 bytes/row)
  maxRetries: 3, // Drop after 3 consecutive failures
  onError: (err, ctx) => {
    log.warn('Analytics buffer issue', {
      context: ctx,
      pending: ctx.pending,
      error: err instanceof Error ? err.message : String(err),
    });
    // Emit OTEL metric for monitoring
    analyticsBufferOverflow.add(1, { table: ctx.table });
  },
};
```

**Memory budget per pod:** 100K rows × ~400 bytes/row = ~40MB. With 7 writers, worst-case total buffer memory is ~280MB. In practice, buffers are mostly empty (flushed every 5s).

### Monitoring the Analytics Writer

The emitter exposes `bufferPending` for health checks. An OTEL gauge tracks buffer fill level:

```typescript
// In observability/metrics.ts
const analyticsBufferLevel = meter.createObservableGauge('analytics.buffer.pending', {
  description: 'Number of analytics events pending in write buffer',
});
analyticsBufferLevel.addCallback((result) => {
  result.observe(emitter.bufferPending, { table: 'analytics_events' });
});
```

Alert when `analytics.buffer.pending > 50000` (50% capacity) — indicates ClickHouse is struggling to keep up with writes.

---

## Design Decisions

### 1. Storage is Fully Pluggable via `IAnalyticsStore`

**This is the central design decision.** Every component depends on `IAnalyticsStore`, never on ClickHouse directly.

- `IAnalyticsStore` combines three sub-interfaces: `IAnalyticsWriter` (write), `IAnalyticsReader` (query), `IAnalyticsLifecycle` (retention + GDPR)
- The emitter calls `store.write()`, the query service calls `store.query()`, retention calls `store.purgeExpired()` — none of them import ClickHouse types
- `ClickHouseAnalyticsStore` is the production implementation. `MemoryAnalyticsStore` is for tests.
- Shared contract tests (`runStoreContractTests()`) verify both implementations behave identically.
- The `AnalyticsEvent` type is a pure TypeScript interface with no DB-specific fields. Row mapping lives inside each store implementation.

**What this means concretely:**

- `AnalyticsEmitter` imports `IAnalyticsWriter`, not `BufferedClickHouseWriter`
- `AnalyticsQueryService` imports `IAnalyticsReader`, not `ClickHouseClient`
- `AnalyticsRetentionService` imports `IAnalyticsLifecycle`, not ClickHouse mutation queries
- `AnalyticsGDPRService` imports `IAnalyticsLifecycle`, not ClickHouse DELETE syntax
- `ICacheProvider` abstracts the query cache — Redis for production, in-memory for tests
- If the storage backend needs to change in the future, implement `IAnalyticsStore` and update the factory — nothing else changes

### 2. Event Schema & Validation (Zod Registry)

- Single `AnalyticsEvent` envelope with typed `data` payload per `event_type`
- `EventRegistry` maps each `event_type` string to a Zod schema + metadata (category, version, containsPII flag)
- Validation at emit time (fast — <1ms for Zod parse). Invalid events are logged and dropped, never block runtime.
- Adding new event type = add Zod schema file + register in registry. No DDL changes, no emitter changes, no query changes.
- `containsPII` flag on each event definition drives GDPR scrubbing — only PII-bearing events get anonymized during retention sweep.

### 3. ClickHouse Implementation (Default Backend)

Single `analytics_events` table with:

- `ORDER BY (tenant_id, category, event_type, timestamp)` — covers all tenant-scoped, category-filtered, time-range queries
- `PARTITION BY toDate(timestamp)` — efficient TTL drops
- `LowCardinality` on enum-like columns (`event_type`, `channel`, `actor_type`, `category`)
- Skip indexes: `session_id` (bloom), `project_id` (bloom), `has_error` (set)
- `data` column as JSON string — schema-on-read, validated at application layer via Zod
- TTL tiers: 30d warm, 90d cold, 730d delete (outer envelope; per-tenant enforcement via retention scheduler)
- Uses `BufferedClickHouseWriter` internally (10K batch / 5s / 100K max) — this is an implementation detail hidden behind `IAnalyticsWriter.write()`

### 4. Retention & Hot/Cold Storage Pipeline

Data moves through three physical storage tiers automatically. Two independent mechanisms work together: ClickHouse TTL (infrastructure-level, partition-granularity) and the Retention Scheduler (application-level, tenant-granularity).

#### Physical Storage Tiers (from `scripts/clickhouse-init/storage.xml`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Storage Tier Pipeline                                  │
│                                                                              │
│  HOT (local SSD)          WARM (attached SSD)         COLD (S3)             │
│  /var/lib/clickhouse/     /mnt/warm/clickhouse/       s3://bucket/          │
│  ┌───────────────┐        ┌───────────────┐          ┌───────────────┐      │
│  │  Recent data  │──TTL──▶│  Aging data   │───TTL──▶│  Archive data │      │
│  │  0-30 days    │  30d   │  30-90 days   │   90d   │  90-730 days  │      │
│  │  Fast queries │        │  Slower reads │         │  Cheapest     │      │
│  └───────────────┘        └───────────────┘          └──────┬────────┘      │
│                                                             │ TTL 730d      │
│                                                             ▼               │
│                                                        DELETE               │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Hot** — `disk: local` — local NVMe/SSD, fastest random reads, used for recent data and real-time dashboards
- **Warm** — `disk: warm_ssd` — attached SSD at `/mnt/warm/clickhouse/`, good read performance, lower cost
- **Cold** — `disk: cold_s3` — S3 object storage, cheapest per GB, higher latency reads
- **`move_factor: 0.1`** — ClickHouse also starts moving data to the next tier when a volume reaches 90% capacity (safety valve)

#### Mechanism 1: ClickHouse TTL Rules (Automatic, Infrastructure-Level)

The `analytics_events` table DDL includes TTL rules that ClickHouse enforces automatically via background merges:

```sql
CREATE TABLE abl_platform.analytics_events (
  -- ... columns ...
)
ENGINE = ReplicatedMergeTree(...)
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, category, event_type, timestamp)
TTL
  toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'warm',
  toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'cold',
  toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
  storage_policy = 'tiered',
  ttl_only_drop_parts = 1,
  merge_with_ttl_timeout = 86400;
```

**How it works:**

1. New inserts land on `hot` (local SSD) — ClickHouse writes small "parts" (groups of rows) to the hot volume
2. Background merge threads periodically check part metadata against TTL rules
3. When ALL rows in a partition (one day's data, since `PARTITION BY toDate(timestamp)`) are past the 30-day threshold, the entire partition is moved to `warm`
4. At 90 days, partitions move from `warm` to `cold` (S3)
5. At 730 days, partitions are dropped entirely (`DELETE`)
6. `ttl_only_drop_parts = 1` ensures ClickHouse drops whole parts rather than row-by-row deletion (much more efficient)
7. `merge_with_ttl_timeout = 86400` limits TTL merge checks to once per day (avoids excessive I/O)

**This is a coarse-grained envelope** — it applies to ALL tenants uniformly. A FREE plan tenant's data at 31 days sits on `warm` storage alongside an ENTERPRISE tenant's 31-day data. The infrastructure doesn't know about plans.

#### Mechanism 2: Retention Scheduler (Application-Level, Tenant-Scoped)

The `RetentionService` (daily cron job) enforces **per-tenant, per-plan** retention windows that are stricter than the outer ClickHouse TTL:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Retention Scheduler (Daily)                           │
│                                                                         │
│  For each tenant:                                                       │
│    1. Look up plan (FREE / TEAM / BUSINESS / ENTERPRISE)                │
│    2. Apply compliance overrides (SOC2, HIPAA, GDPR, PCI DSS)          │
│    3. Calculate cutoff dates per data type                              │
│    4. Call IAnalyticsStore.purgeExpired(tenantId, cutoffDate)           │
│    5. Call IAnalyticsStore.scrubPII(tenantId, piiCutoff, piiTypes)     │
│    6. Record retention report                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Plan-based analytics retention windows** (added to existing `RetentionPolicy`):

| Plan       | Analytics Hot | Analytics Warm | Analytics Total (Delete) | PII Scrub |
| ---------- | ------------- | -------------- | ------------------------ | --------- |
| FREE       | 7 days        | 0 (no warm)    | 30 days                  | 7 days    |
| TEAM       | 30 days       | 60 days        | 90 days                  | 30 days   |
| BUSINESS   | 90 days       | 180 days       | 365 days                 | 90 days   |
| ENTERPRISE | 365 days      | 730 days       | 2555 days                | 365 days  |

**How the two mechanisms interact:**

```
Day 0:  Event written → hot volume (local SSD)
Day 7:  FREE plan → retention scheduler calls store.purgeExpired() → APPLICATION DELETE
Day 30: ClickHouse TTL → remaining data moves hot → warm (infra-level)
Day 30: TEAM plan → retention scheduler calls store.purgeExpired() → APPLICATION DELETE
Day 90: ClickHouse TTL → remaining data moves warm → cold (infra-level)
Day 90: BUSINESS plan → retention scheduler calls store.purgeExpired() → APPLICATION DELETE
Day 365: ENTERPRISE plan → retention scheduler calls store.purgeExpired() → APPLICATION DELETE
Day 730: ClickHouse TTL → remaining data (any that survived) moves to DELETE (infra-level)
```

- The **retention scheduler** handles tenant-specific deletion (e.g., FREE plan data deleted at 7 days, even though ClickHouse keeps it on hot storage for 30 days)
- The **ClickHouse TTL** is the outer safety net — moves data between physical tiers and enforces the absolute maximum (730 days) regardless of plan
- For ENTERPRISE tenants with compliance (e.g., HIPAA requiring 2190-day retention), the ClickHouse TTL DELETE at 730 days would be insufficient. The `analytics_events` DDL uses `730 DAY DELETE` as a default, but the table supports `ALTER TABLE ... MODIFY TTL` per-partition for long-retention tenants. Alternatively, ENTERPRISE compliance data stays on cold storage past 730 days via the retention scheduler NOT deleting it — ClickHouse's `ttl_only_drop_parts = 1` means it only drops a partition when ALL rows in it are expired, and the scheduler can skip ENTERPRISE tenant rows.

#### How `IAnalyticsLifecycle` Abstracts This

The retention and GDPR services never call ClickHouse directly. They use the store interface:

```typescript
// RetentionService (daily scheduler) — platform level
async function runAnalyticsRetention(tenantId: string, policy: RetentionPolicy) {
  const cutoff = subDays(new Date(), policy.analytics.totalRetentionDays);
  await analyticsStore.purgeExpired(tenantId, cutoff);

  if (policy.analytics.piiRetentionDays < policy.analytics.totalRetentionDays) {
    const piiCutoff = subDays(new Date(), policy.analytics.piiRetentionDays);
    const piiTypes = analyticsEventRegistry.getPIIEventTypes();
    await analyticsStore.scrubPII(tenantId, piiCutoff, piiTypes);
  }
}

// Inside ClickHouseAnalyticsStore (implementation detail):
async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
  // ALTER TABLE abl_platform.analytics_events DELETE
  // WHERE tenant_id = {tenantId} AND timestamp < {olderThan}
}

// Inside MemoryAnalyticsStore (test implementation):
async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
  // this.events = this.events.filter(e => !(e.tenantId === tenantId && e.timestamp < olderThan))
}
```

If the storage backend changes, only the store implementation changes. The retention scheduler code remains identical.

### 5. GDPR Data Deletion

- `AnalyticsGDPRService` calls store interface methods, not DB-specific queries:
  - `store.deleteBySessionIds(tenantId, sessionIds)` — session cascade
  - `store.anonymizeActor(tenantId, actorId)` — actor anonymization for audit events
  - `store.deleteTenant(tenantId)` — tenant offboarding
- Integrated into existing `cascade-delete.ts` functions (`deleteSession`, `deleteProject`, `deleteTenant`) via the GDPR service, not via direct DB calls.

### 6. Pluggable Module — Service Extraction via Config Change

The analytics package is designed so that switching from **embedded mode** (runs inside runtime pods) to **standalone service mode** (runs as its own deployment) is a config change — no code changes to any emitter callsite, query consumer, or retention logic.

#### Two Deployment Modes

```
MODE 1: EMBEDDED (default — current plan)
──────────────────────────────────────────

  Runtime Pod
  ┌──────────────────────────────────────────────────┐
  │  Callsite (e.g. session-service.ts)              │
  │       │                                           │
  │       ▼                                           │
  │  AnalyticsEmitter  ──▶  IEventQueue (Direct)     │
  │       │                      │                    │
  │       │                      ▼                    │
  │       │              IAnalyticsStore (ClickHouse)  │
  │       │                                           │
  │  AnalyticsQueryService  ──▶  IAnalyticsReader     │
  │  AnalyticsRetention     ──▶  IAnalyticsLifecycle  │
  │  AnalyticsGDPR          ──▶  IAnalyticsLifecycle  │
  └──────────────────────────────────────────────────┘

  Config: { mode: 'embedded', backend: 'clickhouse', queue: { type: 'direct' } }


MODE 2: STANDALONE SERVICE (future — config change only)
────────────────────────────────────────────────────────

  Runtime Pod                          Analytics Service Pod
  ┌──────────────────────────┐         ┌──────────────────────────────────┐
  │  Callsite                │         │  IEventQueue consumer            │
  │       │                  │         │       │                          │
  │       ▼                  │         │       ▼                          │
  │  AnalyticsEmitter        │         │  IAnalyticsStore (ClickHouse)    │
  │       │                  │         │                                  │
  │       ▼                  │  Redis  │  Analytics Query API (/query)    │
  │  IEventQueue (BullMQ) ──────────▶ │  Analytics Retention (cron)      │
  │                          │  queue  │  Analytics GDPR (on-demand)      │
  │  RemoteQueryClient ─── HTTP ────▶ │  Webhook Forwarder               │
  └──────────────────────────┘         └──────────────────────────────────┘

  Runtime config:  { mode: 'remote', queue: { type: 'bullmq', redis: '...' }, queryUrl: 'http://analytics-svc:3100' }
  Service config:  { mode: 'service', backend: 'clickhouse', queue: { type: 'bullmq', redis: '...' } }
```

#### What Changes Between Modes

| Component             | Embedded Mode                                                               | Standalone Mode                                                                            |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Write path**        | `DirectQueue` → `ClickHouseAnalyticsStore.write()` in-process               | `BullMQEventQueue` → Redis → Analytics service worker → `ClickHouseAnalyticsStore.write()` |
| **Read path**         | `AnalyticsQueryService` calls `ClickHouseAnalyticsStore.query()` in-process | `RemoteAnalyticsQueryClient` calls Analytics service HTTP API                              |
| **Retention**         | Runs inside runtime's cron scheduler                                        | Runs inside analytics service's own cron                                                   |
| **GDPR**              | Called from runtime's cascade-delete                                        | Called via HTTP to analytics service's GDPR endpoint                                       |
| **Webhook**           | Enqueues to BullMQ from runtime pod                                         | Enqueues to BullMQ from analytics service pod                                              |
| **ClickHouse access** | Runtime pod connects to ClickHouse                                          | Only analytics service connects to ClickHouse                                              |

#### Implementation: Two New Classes for Remote Mode

```typescript
// packages/analytics/src/stores/remote/remote-analytics-query-client.ts
// Implements IAnalyticsReader — delegates to HTTP API

export class RemoteAnalyticsQueryClient implements IAnalyticsReader {
  constructor(private baseUrl: string) {}

  async query(params: AnalyticsQueryParams): Promise<AnalyticsQueryResult> {
    const res = await fetch(`${this.baseUrl}/api/analytics/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  async aggregate(params: AnalyticsAggregateParams): Promise<AnalyticsAggregateResult> {
    const res = await fetch(`${this.baseUrl}/api/analytics/aggregate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  async count(params: AnalyticsCountParams): Promise<AnalyticsCountResult> {
    const res = await fetch(`${this.baseUrl}/api/analytics/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.json();
  }
}
```

```typescript
// packages/analytics/src/stores/remote/remote-analytics-lifecycle-client.ts
// Implements IAnalyticsLifecycle — delegates to HTTP API

export class RemoteAnalyticsLifecycleClient implements IAnalyticsLifecycle {
  constructor(private baseUrl: string) {}

  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    const res = await fetch(`${this.baseUrl}/api/analytics/retention/purge`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, olderThan }),
    });
    return res.json();
  }

  async deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void> {
    await fetch(`${this.baseUrl}/api/analytics/gdpr/delete-sessions`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, sessionIds }),
    });
  }

  // ... same pattern for scrubPII, anonymizeActor, deleteTenant
}
```

#### Factory Handles the Switch

```typescript
// packages/analytics/src/factory.ts

export type AnalyticsMode = 'embedded' | 'remote' | 'service';

export interface AnalyticsConfig {
  mode: AnalyticsMode;
  backend?: AnalyticsBackend; // used in 'embedded' and 'service' modes
  queue?: EventQueueConfig; // queue config
  queryUrl?: string; // used in 'remote' mode (runtime pod pointing to service)
  // ... existing fields
}

export function createAnalytics(config: AnalyticsConfig): AnalyticsServices {
  switch (config.mode) {
    case 'embedded': {
      // Everything runs in-process (current plan — default)
      const store = createStore(config);
      const queue = createEventQueue(config.queue ?? { type: 'direct' });
      queue.onProcess((event) => store.write(event));
      return {
        emitter: new AnalyticsEmitter(queue, analyticsEventRegistry),
        queryService: new AnalyticsQueryService(store, config.cache?.provider ?? null),
        retention: new AnalyticsRetentionService(store),
        gdpr: new AnalyticsGDPRService(store),
        // ...
      };
    }

    case 'remote': {
      // Runtime pod — writes go to queue, reads go to remote service
      const queue = createEventQueue(config.queue ?? { type: 'bullmq', redis: config.redis! });
      // No local store.write() wiring — the analytics service consumes the queue
      const remoteReader = new RemoteAnalyticsQueryClient(config.queryUrl!);
      const remoteLifecycle = new RemoteAnalyticsLifecycleClient(config.queryUrl!);
      return {
        emitter: new AnalyticsEmitter(queue, analyticsEventRegistry),
        queryService: new AnalyticsQueryService(remoteReader, config.cache?.provider ?? null),
        retention: new AnalyticsRetentionService(remoteLifecycle),
        gdpr: new AnalyticsGDPRService(remoteLifecycle),
        // ...
      };
    }

    case 'service': {
      // Analytics service pod — consumes queue, owns the store
      const store = createStore(config);
      const queue = createEventQueue(config.queue ?? { type: 'bullmq', redis: config.redis! });
      queue.onProcess((event) => store.write(event));
      // Also exposes HTTP API for query/retention/gdpr (wired in service entrypoint)
      return {
        store,
        emitter: new AnalyticsEmitter(queue, analyticsEventRegistry),
        queryService: new AnalyticsQueryService(store, config.cache?.provider ?? null),
        retention: new AnalyticsRetentionService(store),
        gdpr: new AnalyticsGDPRService(store),
        // ...
      };
    }
  }
}
```

#### Migration Path: Embedded → Standalone

1. **Phase 1 (now)**: Deploy with `mode: 'embedded'`. All analytics run in-process on runtime pods. Zero extra infra.
2. **Phase 2 (when needed)**: Switch queue to `{ type: 'bullmq' }` while still embedded. Events now persist in Redis. This validates the queue path works correctly.
3. **Phase 3 (extraction)**: Deploy a new `analytics-service` pod with `mode: 'service'`. Switch runtime pods to `mode: 'remote', queryUrl: 'http://analytics-svc:3100'`. Runtime pods no longer need ClickHouse connection for analytics. Done.

**No callsite changes at any phase.** Every emitter call (`analytics.emit(event)`) and every query call (`queryService.getSessionMetrics(...)`) works identically across all three modes. The factory wires the right implementations based on config.

#### What the Analytics Service Entrypoint Looks Like

```typescript
// apps/analytics-service/src/index.ts (created in Phase 3, not now)
import { createAnalytics } from '@abl/analytics';
import express from 'express';

const { store, queryService, retention, gdpr } = createAnalytics({
  mode: 'service',
  backend: 'clickhouse',
  queue: { type: 'bullmq', redis: { url: process.env.REDIS_URL! } },
  clickhouse: { client: getClickHouseClient() },
});

const app = express();

// Query API
app.post('/api/analytics/query', async (req, res) => {
  res.json(await queryService.query(req.body));
});
app.post('/api/analytics/aggregate', async (req, res) => {
  res.json(await queryService.aggregate(req.body));
});
app.post('/api/analytics/count', async (req, res) => {
  res.json(await queryService.count(req.body));
});

// Retention API
app.post('/api/analytics/retention/purge', async (req, res) => {
  res.json(await retention.purgeExpired(req.body.tenantId, new Date(req.body.olderThan)));
});

// GDPR API
app.post('/api/analytics/gdpr/delete-sessions', async (req, res) => {
  await gdpr.deleteBySessionIds(req.body.tenantId, req.body.sessionIds);
  res.json({ success: true });
});

app.listen(3100);
```

This service is NOT built now. It's shown to demonstrate that the interfaces we're building today fully support it with zero changes to `packages/analytics/`.

#### Package Structure Addition for Remote Clients

```
packages/analytics/src/stores/remote/
  remote-analytics-query-client.ts      # IAnalyticsReader impl → HTTP calls to service
  remote-analytics-lifecycle-client.ts   # IAnalyticsLifecycle impl → HTTP calls to service
```

These are built now as part of `packages/analytics/` — they implement the same interfaces as `ClickHouseAnalyticsStore` but delegate over HTTP instead of querying ClickHouse directly. They're only used when `mode: 'remote'`.

### 7. Resilience & Failover (Zero Data Loss Guarantee)

Analytics events are critical for compliance, audit trails, and billing. The write path must degrade gracefully through **three fallback levels** to ensure zero data loss even when infrastructure components fail.

#### Three-Level Failover Cascade

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Resilient Write Path                                │
│                                                                          │
│  emit(event)                                                             │
│       │                                                                  │
│       ├─▶ LEVEL 1: Primary Queue (Kafka/BullMQ)                         │
│       │   ├─ Health check: isHealthy() → true?                          │
│       │   ├─ Try: enqueue(event) → queue → consumer → ClickHouse       │
│       │   └─ On failure/unhealthy: ↓                                    │
│       │                                                                  │
│       ├─▶ LEVEL 2: Direct to Store (in-memory buffer)                   │
│       │   ├─ Bypass queue, write directly to BufferedClickHouseWriter  │
│       │   ├─ Try: store.write(event) → buffer → async flush            │
│       │   └─ On failure: ↓                                              │
│       │                                                                  │
│       └─▶ LEVEL 3: Filesystem WAL (Write-Ahead Log)                     │
│           ├─ Append event to /var/analytics-wal/{timestamp}.jsonl      │
│           ├─ JSONL format (one event per line), rotated at 100MB       │
│           ├─ Recovery job replays WAL on startup + every 5 minutes     │
│           └─ Delete WAL files after successful replay to ClickHouse    │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Components

**1. Health-Aware Queue Interface**

Every `IEventQueue` implementation reports its own health status:

```typescript
interface IEventQueue {
  enqueue(event: AnalyticsEvent): Promise<void>;
  onProcess(handler: (event: AnalyticsEvent) => Promise<void>): void;
  isHealthy(): boolean; // NEW — health check
  close(): Promise<void>;
}
```

- `BullMQEventQueue.isHealthy()` — pings Redis with `redis.ping()`, returns false if Redis connection is down
- `KafkaEventQueue.isHealthy()` — checks broker connectivity via producer metadata request
- `DirectQueue.isHealthy()` — always returns `true` (no external dependency, writes directly to store)

**2. Resilient Emitter with Fallback Chain**

```typescript
// packages/analytics/src/emitters/resilient-analytics-emitter.ts
export class ResilientAnalyticsEmitter implements IAnalyticsEmitter {
  constructor(
    private primaryQueue: IEventQueue, // Kafka/BullMQ (durable)
    private fallbackQueue: IEventQueue, // DirectQueue (in-memory → ClickHouse)
    private wal: FileSystemWAL, // Filesystem fallback
    private registry: EventRegistry,
    private config: ResilienceConfig,
  ) {
    // Health check loop
    setInterval(() => this.checkPrimaryHealth(), config.healthCheckIntervalMs ?? 5000);
  }

  private primaryHealthy = true;

  private checkPrimaryHealth(): void {
    this.primaryHealthy = this.primaryQueue.isHealthy();
    if (!this.primaryHealthy) {
      log.warn('Primary queue unhealthy, using fallback', {
        queue: this.primaryQueue.constructor.name,
      });
    }
  }

  async emit(event: AnalyticsEvent): Promise<void> {
    // Validate schema
    const validation = this.registry.validate(event);
    if (!validation.valid) {
      log.warn('Invalid event dropped', { errors: validation.errors });
      return;
    }

    // LEVEL 1: Try primary queue (if healthy)
    if (this.primaryHealthy) {
      try {
        await this.primaryQueue.enqueue(event);
        return; // Success — event in durable queue
      } catch (err) {
        log.warn('Primary queue enqueue failed, falling back', {
          error: err instanceof Error ? err.message : String(err),
          eventType: event.event_type,
        });
        // Mark unhealthy for next emit (avoid repeated failures)
        this.primaryHealthy = false;
      }
    }

    // LEVEL 2: Try direct store write (in-memory buffer → ClickHouse)
    try {
      await this.fallbackQueue.enqueue(event); // DirectQueue → store.write()
      log.debug('Event written via fallback queue', { eventType: event.event_type });
      return; // Success — event in ClickHouse buffer
    } catch (err) {
      log.error('Store write failed, writing to WAL', {
        error: err instanceof Error ? err.message : String(err),
        eventType: event.event_type,
      });
    }

    // LEVEL 3: Filesystem WAL (last resort)
    try {
      await this.wal.append(event);
      log.info('Event written to WAL', { eventType: event.event_type });
    } catch (err) {
      // Even WAL failed — log and drop (extremely rare: disk full or permissions issue)
      log.error('WAL write failed — event lost', {
        error: err instanceof Error ? err.message : String(err),
        event,
      });
    }
  }
}
```

**3. Filesystem WAL (Write-Ahead Log)**

```typescript
// packages/analytics/src/resilience/filesystem-wal.ts
import { appendFile, readdir, readFile, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { ulid } from 'ulid';

export interface WALConfig {
  directory: string; // e.g., /var/analytics-wal/
  maxFileSizeBytes?: number; // default: 100MB
  maxRetentionHours?: number; // default: 24 (delete old files even if not replayed)
}

export class FileSystemWAL {
  private currentFile: string | null = null;
  private currentSize = 0;
  private maxSize: number;

  constructor(private config: WALConfig) {
    this.maxSize = config.maxFileSizeBytes ?? 100 * 1024 * 1024; // 100MB
  }

  async append(event: AnalyticsEvent): Promise<void> {
    // Rotate file if current exceeds max size
    if (!this.currentFile || this.currentSize >= this.maxSize) {
      await this.rotateFile();
    }

    const line = JSON.stringify(event) + '\n';
    const filePath = join(this.config.directory, this.currentFile!);

    await appendFile(filePath, line, 'utf8');
    this.currentSize += line.length;
  }

  private async rotateFile(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.currentFile = `wal-${timestamp}-${ulid()}.jsonl`;
    this.currentSize = 0;
  }

  async replay(): Promise<{ events: AnalyticsEvent[]; files: string[] }> {
    const files = await readdir(this.config.directory);
    const walFiles = files.filter((f) => f.startsWith('wal-') && f.endsWith('.jsonl'));

    const events: AnalyticsEvent[] = [];
    for (const file of walFiles) {
      const filePath = join(this.config.directory, file);
      const content = await readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch (err) {
          log.warn('WAL line parse failed', {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { events, files: walFiles };
  }

  async clearProcessed(fileNames: string[]): Promise<void> {
    for (const file of fileNames) {
      await unlink(join(this.config.directory, file));
    }
  }

  async cleanup(): Promise<void> {
    // Delete WAL files older than maxRetentionHours
    const files = await readdir(this.config.directory);
    const now = Date.now();
    const maxAgeMs = (this.config.maxRetentionHours ?? 24) * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('wal-')) continue;
      const filePath = join(this.config.directory, file);
      const stats = await stat(filePath);
      if (now - stats.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        log.info('WAL file expired and deleted', { file });
      }
    }
  }
}
```

**4. Recovery Service (Startup + Periodic)**

```typescript
// packages/analytics/src/resilience/analytics-recovery-service.ts
export class AnalyticsRecoveryService {
  constructor(
    private wal: FileSystemWAL,
    private store: IAnalyticsStore,
  ) {}

  async recoverFromWAL(): Promise<{ recovered: number; failed: number }> {
    const { events, files } = await this.wal.replay();
    if (events.length === 0) {
      log.debug('No WAL events to recover');
      return { recovered: 0, failed: 0 };
    }

    log.info(`Recovering ${events.length} events from ${files.length} WAL files`);

    let recovered = 0;
    let failed = 0;

    // Batch write to store (10K per batch)
    const batchSize = 10_000;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      try {
        await this.store.writeBatch(batch);
        recovered += batch.length;
      } catch (err) {
        log.error('WAL recovery batch failed', {
          batchStart: i,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
        failed += batch.length;
      }
    }

    if (failed === 0) {
      // All events successfully written — delete WAL files
      await this.wal.clearProcessed(files);
      log.info('WAL recovery complete, files deleted', { recovered, files: files.length });
    } else {
      log.warn('WAL recovery partial', { recovered, failed, filesRetained: files.length });
    }

    return { recovered, failed };
  }

  async startPeriodicRecovery(intervalMs: number = 5 * 60 * 1000): Promise<void> {
    setInterval(() => {
      this.recoverFromWAL().catch((err) => {
        log.error('Periodic WAL recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }
}
```

#### Configuration

```typescript
export interface ResilienceConfig {
  enabled?: boolean; // default: true (enable failover)
  healthCheckIntervalMs?: number; // default: 5000 (check queue health every 5s)
  wal?: WALConfig;
}

export interface AnalyticsConfig {
  mode: AnalyticsMode;
  backend?: AnalyticsBackend;
  queue?: EventQueueConfig;
  resilience?: ResilienceConfig; // NEW — failover config
  // ... existing fields
}
```

**Default configuration** (production):

```typescript
const analyticsConfig: AnalyticsConfig = {
  mode: 'embedded',
  backend: 'clickhouse',
  queue: { type: 'kafka', kafka: { brokers: ['kafka:9092'] } },
  resilience: {
    enabled: true,
    healthCheckIntervalMs: 5000,
    wal: {
      directory: '/var/analytics-wal/',
      maxFileSizeBytes: 100 * 1024 * 1024, // 100MB per file
      maxRetentionHours: 24,
    },
  },
};
```

#### Lifecycle Integration

**On pod startup:**

```typescript
const { recovery } = createAnalytics(config);
await recovery.recoverFromWAL(); // Replay any leftover WAL from previous pod crash
await recovery.startPeriodicRecovery(); // Every 5 minutes, check for new WAL files
```

**Health monitoring:**

```typescript
// Expose emitter health metrics via OTEL
const analyticsQueueHealthy = meter.createObservableGauge('analytics.queue.healthy', {
  description: 'Primary queue health status (1=healthy, 0=degraded)',
});
analyticsQueueHealthy.addCallback((result) => {
  result.observe(emitter.primaryHealthy ? 1 : 0);
});
```

#### Trade-Offs & Considerations

**Filesystem WAL:**

- **Pros**: Survives pod restarts, zero data loss even if ClickHouse is down for hours
- **Cons**: Disk I/O per event (mitigated with async append), requires persistent volume (not ephemeral pod storage)
- **Storage**: Each WAL file is ~100MB JSONL. At 10K events/sec, ~4GB/hour. With 24h retention, ~100GB max disk usage.

**Replay ordering:**

- WAL events are replayed in batch after recovery. They arrive out-of-order with events that succeeded before the failure.
- This is acceptable for analytics (eventual consistency) — timestamps preserve true ordering for queries.

**Multi-pod WAL:**

- Each runtime pod has its own WAL directory (e.g., `/var/analytics-wal/{podName}/`).
- Recovery runs per-pod on startup + periodic check.
- If using ephemeral pod storage, mount a PersistentVolume for `/var/analytics-wal/`.

**Alternative (simpler)**: Skip filesystem WAL, use **larger in-memory fallback buffer**:

- Primary queue fails → 1M-event in-memory buffer → periodic batch flush to ClickHouse
- Accepts data loss on pod crash (rare), avoids filesystem complexity
- Only use if event durability requirements allow it

**Recommendation**: Use the full 3-level failover with filesystem WAL for production. Use the simpler 2-level (queue → direct store) for dev/staging.

### 8. Webhook Forwarding

- `AnalyticsWebhookForwarder` checks tenant webhook subscriptions against emitted event types
- Pattern matching: `analytics.session.*` matches `session.started`, `session.ended`, etc.
- Enqueues to existing BullMQ `webhook-delivery` queue — reuses HMAC signing, SSRF protection, retry logic, idempotency
- Subscription cache: in-memory Map with 1-min TTL, max 1000 entries, tenant-prefixed keys
- Non-blocking: `maybeForward()` is async fire-and-forget with `.catch()` guard

### 8. Query Layer (Studio UI)

- `AnalyticsQueryService` wraps `IAnalyticsReader` with caching via `ICacheProvider`
- Calls `store.query()` and `store.aggregate()` — never constructs SQL/queries itself
- Cache: 60s TTL, tenant-included hash keys (no cross-tenant cache leakage)
- Convenience methods (`getEventCounts`, `getSessionMetrics`, `getCostBreakdown`) built on top of `store.aggregate()`
- If backend changes from ClickHouse to Postgres, the query service works unchanged — it only calls `IAnalyticsReader` methods

### 9. Lazy Materialized Views (ClickHouse-Specific Optimization)

- This is an optimization INSIDE the `ClickHouseAnalyticsStore` implementation, not visible to the rest of the system
- `ClickHouseAnalyticsStore.aggregate()` can internally route certain query patterns to pre-aggregated MV tables instead of scanning raw `analytics_events`
- Two MVs pre-designed and ready to deploy when queries prove slow (>2s):
  - **Session metrics daily**: `AggregatingMergeTree` grouping `session.ended` events by tenant/project/day/channel
  - **LLM cost hourly**: `AggregatingMergeTree` grouping `llm.call.*` events by tenant/project/hour/agent

### 10. Migration Bridge

- `AnalyticsTraceBridge`: decorator around existing `TraceStore` that also calls `emitter.emit()` on `createTrace`, `appendEvent`, `endTrace`
- `emitLLMMetricsAsAnalytics()`: converts existing `llm_metrics` row to analytics event via emitter
- Both use the `IAnalyticsEmitter` interface — backend-agnostic
- Activated via config flag (`analytics.dualWrite: true`) — no code changes to existing trace/metrics stores
- Migration phases: dual-write → validate data correctness → build Studio dashboards on new data → optionally stop legacy writes

---

## Verification Plan

1. **Store contract tests**: Run `runStoreContractTests()` against both `MemoryAnalyticsStore` and `ClickHouseAnalyticsStore` — verifies write/query/aggregate/purge/delete/anonymize behave identically
2. **Queue contract tests**: Run `runQueueContractTests()` against `DirectQueue`, `BullMQEventQueue`, `KafkaEventQueue`, and `MemoryEventQueue` — verifies enqueue/onProcess/flush/close behave identically
3. **Unit tests**: EventRegistry validation (valid/invalid payloads, unknown types, PII listing), emitter fire-and-forget + overflow behavior, retention TTL calculations, GDPR cascade logic, webhook pattern matching, cache key isolation
4. **Integration tests**: Full pipeline roundtrip — emitter → queue → store → query (with both DirectQueue and BullMQEventQueue)
5. **Build verification**: `pnpm build` then `pnpm test` from repo root (Turbo enforces build order)
6. **Manual verification**:
   - Emit events via runtime, query via `AnalyticsQueryService` to verify data flows through the full pipeline
   - Trigger GDPR deletion request, verify events are purged/anonymized via `IAnalyticsLifecycle`
   - Configure webhook subscription with `analytics.session.*`, verify delivery via delivery worker logs
7. **Backend swap test**: Run the full test suite with `backend: 'memory'` + `queue: 'memory'` to verify nothing depends on ClickHouse or Redis directly
8. **Performance check**: Emit 100K events in a burst, verify runtime request latency is unaffected (buffer absorbs, no blocking)
9. **Buffer monitoring**: Verify OTEL gauge `analytics.buffer.pending` is exported and alertable
10. **Resilience tests**:
    - **Queue failover**: Kill Redis/Kafka mid-emit, verify events fall back to direct store write (Level 2), check `analytics.queue.healthy` metric drops to 0
    - **Store failover**: Mock ClickHouse failure, verify events written to WAL (Level 3), check WAL files exist in `/var/analytics-wal/`
    - **WAL replay**: Restart pod with WAL files present, verify recovery service replays events to ClickHouse and deletes WAL files
    - **WAL rotation**: Emit events until WAL file exceeds 100MB, verify new file created with timestamped name
    - **WAL cleanup**: Set `maxRetentionHours: 1`, wait 2 hours, verify old WAL files are deleted even if not replayed
    - **Health check**: Verify `isHealthy()` returns correct status for each queue type (BullMQ: ping Redis, Kafka: check brokers)

---

## Step 0: Save Design Document

Before starting implementation, save this complete design to `docs/plans/2026-02-22-unified-analytics-event-framework-design.md` and commit.
