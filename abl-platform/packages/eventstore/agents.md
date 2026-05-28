# `@abl/eventstore` — Package Learnings

Append-only package learnings log. Read this before modifying anything under `packages/eventstore/src/`. Each entry is dated and stamped with the Jira key that drove the change.

Template:

```
**Category**: architecture | testing | gotcha | performance | security
**Learning**: <what was surprising / non-obvious>
**Files**: <relative paths>
**Impact**: <how future agents should apply this>
```

---

## 2026-04-21 — ABLP-2 (workflow-execution-event-sourcing)

**Category**: architecture
**Learning**: Workflow events use flat-object Zod schemas (`WorkflowExecutionEventSchema`, `HumanTaskEventSchema`) — not `PlatformEvent` envelopes. Consumers MUST validate via `Schema.safeParse(rawEvent)` directly; `EventRegistry.validate()` is NOT applicable because it parses the `.data` field of a `PlatformEvent`, and these workflow events have no nested `data`. `registerWorkflowExecutionEvents(registry)` + `registerHumanTaskEvents(registry)` still populate the registry — but purely for GDPR PII lookup (`registry.getPIIEventTypes()`). The registration is an explicit function call, not a module-level side effect, to make the call site obvious.
**Files**: `src/schema/events/workflow-execution-events.ts`, `src/schema/events/human-task-events.ts`, `apps/runtime/src/services/workflow-events-consumer.ts`
**Impact**: New flat-object event schemas should follow this pattern. Do NOT auto-register via module side effect when the schema is consumer-validated directly.

---

**Category**: gotcha
**Learning**: `packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts` imports `createLogger` from `@abl/compiler/platform` — but that is NOT a declared dep of `@abl/eventstore/package.json`. Turbo's production build resolves it via hoisted `node_modules`, but vitest's native resolver does not. This is a latent Phase 2 defect (GAP-011). The Phase 4 `workflow-event-lifecycle.ts` uses `@agent-platform/shared-observability` instead — follow that peer convention for any new eventstore logger.
**Files**: `src/stores/clickhouse/init-workflow-event-tables.ts`, `src/retention/workflow-event-lifecycle.ts`
**Impact**: When adding a logger in eventstore, use `import { createLogger } from '@agent-platform/shared-observability'`. Fix the Phase 2 import as a follow-up.

---

**Category**: architecture
**Learning**: Per-row MV projection for ReplacingMergeTree (HLD §5.3 Q1). Each `*_events` raw table has a `*_latest` ReplacingMergeTree projection populated by a per-row materialized view (not aggregation-based). Each event projects 1:1 into the target; ReplacingMergeTree keeps the highest `_version` on merge. `_version` is `toUnixTimestamp64Milli(occurred_at)` — monotonic, shared across outbox + Kafka + CH. `FINAL` is required at query time for deterministic collapsing during active ingest; acceptable for small-result queries (e.g. detail / 1-row lookup), avoid on large `LIMIT`ed list queries.
**Files**: `src/stores/clickhouse/workflow-execution-events-table.ts`, `src/stores/clickhouse/human-task-events-table.ts`
**Impact**: Future state-snapshot projections should follow the per-row MV pattern (not aggregation-based). Reuse `occurred_at → _version` as the dedup key. `FINAL` is the right answer for deterministic reads during ingest, not a smell.

---

**Category**: architecture
**Learning**: `publishAndAck(topic, event, key?)` for transactional-outbox consumers (ABLP-2 Phase 1). Unlike `enqueue()` (fire-and-forget, fixed topic), this awaits the Kafka broker ACK with `acks: -1` (all in-sync replicas). Required when a caller needs to KNOW the publish succeeded before transitioning state (e.g. the workflow-engine outbox poller only marks a row `publishedAt` after ACK). `pendingMessages` is incremented/decremented around the await for observability parity with `enqueue`.
**Files**: `src/queues/kafka-queue.ts`
**Impact**: Any new outbox-style caller should use `publishAndAck`, not `enqueue`. Fire-and-forget is fine only when the state transition doesn't depend on publish success.

---

**Category**: architecture
**Learning**: `IEventLifecycle` contract is 5 methods: `purgeExpired`, `scrubPII`, `deleteBySessionIds`, `anonymizeActor`, `deleteTenant`. Not every implementation needs to implement all of them. `WorkflowEventLifecycle` makes `deleteBySessionIds` + `anonymizeActor` explicit no-ops (workflow events aren't session-scoped; no `actor_id` column) — comment the reason in-code, don't skip the method. Retention is delegated to `IEventLifecycle` via `EventRetentionService(lifecycle)`; the runtime can run multiple retention services in parallel (one per subsystem's lifecycle impl).
**Files**: `src/retention/workflow-event-lifecycle.ts`, `src/retention/event-retention-service.ts`, `src/interfaces/event-store.ts`
**Impact**: New `IEventLifecycle` impls should explicit-no-op the methods that don't apply and leave a comment with the reason — don't throw, don't omit. This keeps the interface uniform and lets callers safely invoke any method without a capability-check.

---

**Category**: gotcha
**Learning**: `export type *` in the top-level package barrel silently strips VALUE exports. `packages/eventstore/src/index.ts` had `export type * from './schema/events/index.js'` to avoid tree-shaking noise — this unintentionally dropped the `register*` value exports, so importers at `@abl/eventstore` could see the types but not call the functions. Fix: use explicit named re-exports for anything that must ship both type + value (`export { registerWorkflowExecutionEvents, registerHumanTaskEvents, WorkflowExecutionEventSchema, HumanTaskEventSchema, WorkflowExecutionEventTypeSchema, HumanTaskEventTypeSchema } from './schema/events/index.js'`).
**Files**: `src/index.ts`
**Impact**: When adding a new schema module that exports both types and registration functions, add explicit named re-exports at the top-level barrel. Relying on `export type *` will break runtime consumers with confusing "… cannot be used as a value" errors.

---

**Category**: gotcha
**Learning**: KafkaJS has no built-in LZ4 codec, but docker brokers are often configured with `compression.type=lz4` at the broker level — which forces recompression on every message regardless of the producer's `compression` setting. Without a registered codec the consumer throws `KafkaJSNotImplemented: LZ4 compression not implemented`. Workarounds tried: (1) `kafkajs-lz4@2.0.0-beta.0` ships `lz4-asm` WASM that fails on Node 24 with `ERR_INVALID_URL`; (2) pure-JS `lz4js` + hand-rolled codec works reliably. Registration must happen via `createRequire(import.meta.url)` because KafkaJS exports `CompressionTypes` + `CompressionCodecs` as CJS-only and tsx's ESM loader cannot see them from `import { }` statements.
**Files**: `src/queues/kafka-queue.ts`
**Impact**: Any new KafkaJS producer/consumer in this repo must run alongside this module's side-effect import (already handled at module load). If you spin up KafkaJS outside this package, register the same codec manually. Do NOT rely on disabling broker-side compression — the docker and prod Kafka deployments both enforce it.

---

**Category**: gotcha
**Learning**: KafkaJS `subscribe` → `run` sequencing race. Calling `consumer.run()` before `consumer.subscribe()` resolves throws `Cannot subscribe to topic while consumer is running`. The original code wrote `connect().then(subscribe); connect().then(run)` — two independent chains that could interleave. Fix: fuse into a single chain `connect().then(() => subscribe()).then(() => run())` so the order is deterministic.
**Files**: `src/queues/kafka-queue.ts`
**Impact**: Any lifecycle-sensitive KafkaJS startup (subscribe → run → offset-commit) must be fused into a single promise chain. Parallel chains off the same `connect()` create non-determinism.

---

## 2026-04-25 — ABLP-571 (runtime trace schema alignment)

**Category**: architecture
**Learning**: Runtime trace-to-platform mappings can point at EventStore event names that are not registered in `eventRegistry`, because the EventEmitter permissively passes unknown event types through. Schema alignment needs an explicit registration test at the runtime/EventStore boundary, not only per-package schema tests.
**Files**: `src/schema/events/agent-events.ts`, `src/schema/events/flow-events.ts`, `apps/runtime/src/__tests__/observability/runtime-eventstore-schema-alignment.test.ts`
**Impact**: When adding a new dotted platform event to `TRACE_TO_PLATFORM_TYPE`, add the matching EventStore schema registration in the same change or the runtime alignment test should fail.

## 2026-05-05 — Redis Dual-Mode: Cluster-Safe BullMQ Queue

**Category**: architecture
**Learning**: `BullMQEventQueue` now accepts a `RedisConnectionHandle` instead of `{ url: string }`. It uses `createBullMQPair(handle)` from `@agent-platform/redis` to create cluster-safe Queue + Worker connections. The manual URL parsing (`new URL(config.redis.url)`) was removed. The `pair.disconnect()` call is included in `close()` for proper cleanup.
**Files**: `src/queues/bullmq-queue.ts`, `src/interfaces/event-queue.ts`, `package.json`
**Impact**: `@agent-platform/redis` is now a dependency. Any future callers of `BullMQEventQueue` or `createEventQueue({ type: 'bullmq', redis: ... })` must pass a `RedisConnectionHandle` (from `getRedisHandle()` or `createRedisConnection()`), not a `{ url: string }` object.
