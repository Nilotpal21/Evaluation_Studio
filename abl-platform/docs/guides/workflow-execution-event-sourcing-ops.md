# Workflow Execution Event Sourcing — Ops Runbook

**Feature**: ABLP-2 (workflow-execution-event-sourcing)
**Scope**: Storage, Kafka topics, producer/consumer wiring for the Mongo → Kafka → ClickHouse tiered-storage pipeline.
**Audience**: Platform/DevOps operators bringing up a new environment or upgrading an existing one.
**Related**:

- Feature spec: [`../features/sub-features/workflow-execution-event-sourcing.md`](../features/sub-features/workflow-execution-event-sourcing.md)
- HLD: [`../specs/workflow-execution-event-sourcing.hld.md`](../specs/workflow-execution-event-sourcing.hld.md)
- LLD: [`../plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md`](../plans/2026-04-21-workflow-execution-event-sourcing-impl-plan.md)

The whole pipeline is flag-gated and additive. Default-off values keep every environment on the legacy Mongo-only path. The sequence below is the order to turn things on per environment (dev → staging → prod).

---

## Feature Flags at a Glance

All 4 gate flags default `false` and are read via [`apps/workflow-engine/src/outbox/flag-gates.ts`](../../apps/workflow-engine/src/outbox/flag-gates.ts) (`readFlags()`) or `process.env` directly at startup. Flipping a flag only affects newly-started pods — the runtime does not hot-reload env vars. Tuning flags (poll interval, batch size, TTL seconds) are the exception and are re-read per request by the poller.

### `WORKFLOW_OUTBOX_ENABLED`

- **Owner**: `apps/workflow-engine`
- **What it gates**: (1) the outbox decorators that wrap `ExecutionStore` + `MongoHumanTaskStore` — every domain write commits a `workflow_event_outbox` row in the same Mongo transaction. (2) The BullMQ outbox poller that drains unpublished rows to Kafka.
- **Default (OFF)**: workflow-engine writes only the domain collections (`workflow_executions`, `human_tasks`). No outbox rows. No Kafka publish. Legacy Mongo-only behavior.
- **ON**: every terminal + step + human-task transition produces an outbox row; the poller ships rows to `abl.workflow.execution` / `abl.human.task` within `WORKFLOW_OUTBOX_POLL_INTERVAL_MS`.
- **Flip semantics**: restart-required (decorators + poller wired at boot).
- **Blast radius**: flipping ON without Kafka topics provisioned ⇒ poller fails every publish, `workflow_outbox_publish_failures_total` climbs, rows accumulate in the outbox (unpublished). Safe recovery: provision topics, restart, backlog drains automatically. Flipping OFF mid-run is safe — the poller stops, outstanding rows remain for the next enablement cycle.
- **Dependencies**: Mongo (outbox collection), Redis (BullMQ lease), Kafka (publish target).

### `WORKFLOW_CH_SINK_ENABLED`

- **Owner**: `apps/runtime`
- **What it gates**: whether the runtime subscribes to `abl.workflow.execution` + `abl.human.task` and sinks events into ClickHouse via two `BufferedClickHouseWriter` instances.
- **Default (OFF)**: runtime still boots and still initializes the CH tables (unconditional), but no Kafka consumer runs. Tables stay empty.
- **ON**: `WorkflowEventsConsumer` starts — 2 Kafka subscriptions with explicit consumer-group IDs, buffered writes to the 4 CH tables, Zod validation at entry, SIGTERM-aware flush on shutdown.
- **Flip semantics**: restart-required.
- **Blast radius**: flipping ON with `WORKFLOW_OUTBOX_ENABLED=false` is harmless (no Kafka messages to consume). Flipping ON with invalid CH credentials ⇒ `BufferedClickHouseWriter` flush failures, events back up in memory buffer (bounded by `maxBufferSize`), eventually drops oldest. Safe recovery: fix creds, restart. Flipping OFF mid-run causes a clean shutdown + flush; unread Kafka messages remain on-broker for the next startup (consumer group offset preserved).
- **Dependencies**: ClickHouse, Kafka. Does NOT require outbox enabled on the same pod (upstream and downstream are independent services).

### `WORKFLOW_DUAL_READ_ENABLED`

- **Owner**: `apps/workflow-engine` + `apps/runtime`
- **What it gates**: the hybrid read path. When ON, `HybridExecutionReader` (workflow-engine) and `HybridHumanTaskReader` (runtime, `mailbox='workflow'` only) fan out to Mongo + CH in parallel and UNION the results with Mongo-winning-on-overlap.
- **Default (OFF)**: all list + detail GET endpoints query Mongo only — current legacy behavior. Zero performance change.
- **ON**: list endpoints merge Mongo + `workflow_executions_latest` / `human_tasks_latest`. Detail endpoint falls through to CH on Mongo miss (post-TTL historical path) and returns `{...chRow, steps: []}` so the UI can render a reduced view. Emits `workflow_dual_read_request_latency_ms` histogram tagged `{entity, mode=mongo-only|union}`.
- **Flip semantics**: restart-required in both services.
- **Blast radius**: flipping ON with CH empty or unreachable is safe — the CH query is wrapped in try/catch and falls back to Mongo-only silently (warn log). User-visible responses remain unchanged. The risk is _silent staleness_: if the CH projection lags Mongo, union-mode merges could show older CH rows for executions already reaped from Mongo — but "Mongo wins on overlap" prevents this for live rows, and `_latest` with `FINAL` collapses to the newest `_version` for detail queries.
- **Dependencies**: same as OFF (Mongo). Gracefully degrades without CH.

### `WORKFLOW_MONGO_TTL_ENABLED`

- **Owner**: `apps/workflow-engine` (write path) + `packages/database` (schema index declaration)
- **What it gates**: (1) TTL partial-filter index creation at schema-load time on `workflow_executions` + `human_tasks`. (2) `expiresAt` population on terminal-status writes via `computeExecutionExpiresAt` / `computeHumanTaskExpiresAt` helpers. Only `mailbox='workflow'` human tasks get the TTL (aggregation-pipeline `$cond` guards this).
- **Default (OFF)**: no TTL index, `expiresAt` never written. Rows persist indefinitely (legacy behavior).
- **ON**: TTL indexes declared on schema load; new terminal-status writes set `expiresAt = now + WORKFLOW_MONGO_TTL_SECONDS`. Mongo's TTL monitor (~60s cycle) drops rows whose `expiresAt` has passed. `_id` matches the Mongo TTL partial filter `{expiresAt: {$type: 'date'}}` — in-flight rows (`expiresAt: null`) are never eligible.
- **Flip semantics**: **restart-required + ordering-sensitive**. Flag must be `'true'` at model-load time for the index to be declared. Pod restart after the flip is mandatory. Flipping OFF after TTL has run does NOT reanimate deleted rows — drop is permanent.
- **Blast radius**: **highest-risk flag**. If CH ingest is lagging when TTL fires, Mongo rows will be gone before CH has them ⇒ read-path misses. This is why the startup `WORKFLOW_OUTBOX_ALERT_THRESHOLD` check exists: workflow-engine logs a WARN if `workflow_event_outbox.countDocuments({publishedAt: null}) > 10000` when this flag is ON at boot. Always confirm parity-check drift < 0.1% for ≥48h BEFORE flipping. Recommended first value: 14 days (`WORKFLOW_MONGO_TTL_SECONDS=1209600`); narrow to 48h after 1 week staging observation.
- **Dependencies**: requires `WORKFLOW_OUTBOX_ENABLED=true` + `WORKFLOW_CH_SINK_ENABLED=true` to be safe — turning TTL on without CH ingest is data loss.

### Tuning flags

These are behavior-dials, not gates. They're safe to tune without toggling any of the 4 primary flags above.

| Variable                              | Default                  | What it controls                                                                                      | Flip semantics                |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------- |
| `WORKFLOW_MONGO_TTL_SECONDS`          | `1209600` (14 days)      | TTL window on terminal workflow_executions + workflow-mailbox human_tasks rows.                       | Restart (read at write time). |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS`    | `1000`                   | BullMQ repeatable-job tick. Lower = faster publish, higher Mongo+Redis load.                          | Restart.                      |
| `WORKFLOW_OUTBOX_BATCH_SIZE`          | `100`                    | Max rows per drain. Raise under burst loads if publish latency climbs.                                | Restart.                      |
| `WORKFLOW_OUTBOX_ALERT_THRESHOLD`     | `10000`                  | Backlog gate at TTL-enablement startup. Over this count ⇒ warn log, TTL not recommended yet.          | Restart.                      |
| `WORKFLOW_CH_RETENTION_OVERRIDE_DAYS` | unset                    | Operator override for CH retention. Test/staging only — production uses `RetentionPolicy` plan tiers. | Restart.                      |
| `WORKFLOW_EVENT_TOPIC_EXECUTION`      | `abl.workflow.execution` | Kafka topic name override. Only change for isolated test clusters.                                    | Restart.                      |
| `WORKFLOW_EVENT_TOPIC_HUMAN_TASK`     | `abl.human.task`         | Kafka topic name override. Only change for isolated test clusters.                                    | Restart.                      |
| `EVENT_KAFKA_BROKERS`                 | `localhost:9092`         | Comma-separated Kafka broker list, shared by producer + consumer.                                     | Restart.                      |

### Flag dependency graph

```
WORKFLOW_MONGO_TTL_ENABLED   (TTL deletes Mongo rows)
          │ requires
          ▼
WORKFLOW_CH_SINK_ENABLED     (CH has the rows before Mongo deletes them)
          │ requires
          ▼
WORKFLOW_OUTBOX_ENABLED      (events reach Kafka)

WORKFLOW_DUAL_READ_ENABLED   (independent — reads union Mongo+CH)
          │ value-adds with
          ▼
WORKFLOW_CH_SINK_ENABLED     (CH has rows to read from)
```

Turning flags ON out of order is not fatal (every flag degrades safely) but defeats the flag's purpose. The §6 rollout sequence follows the dependency graph strictly.

---

## 1. ClickHouse Tables

### 1.1 What gets created

Six objects, created by `initWorkflowEventTables(chClient)` ([`packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts`](../../packages/eventstore/src/stores/clickhouse/init-workflow-event-tables.ts)):

| Database       | Object                          | Engine                         | Purpose                                              |
| -------------- | ------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `abl_platform` | `workflow_execution_events`     | MergeTree                      | Append-only raw event stream for workflow executions |
| `abl_platform` | `human_task_events`             | MergeTree                      | Append-only raw event stream for human tasks         |
| `abl_platform` | `workflow_executions_latest`    | ReplacingMergeTree(`_version`) | Per-execution projection (collapsed by `_version`)   |
| `abl_platform` | `human_tasks_latest`            | ReplacingMergeTree(`_version`) | Per-task projection                                  |
| `abl_platform` | `workflow_executions_latest_mv` | Materialized view → `*_latest` | Per-row MV — projects every event 1:1                |
| `abl_platform` | `human_tasks_latest_mv`         | Materialized view → `*_latest` | Per-row MV; `WHERE mailbox = 'workflow'`             |

All DDL uses `CREATE … IF NOT EXISTS`. Safe to run on every boot.

### 1.2 New environment

1. Ensure the `abl_platform` database exists on the ClickHouse cluster (created by `initClickHouseSchema()` during the first platform-events deploy; no extra step needed).
2. Start `@agent-platform/runtime`. At boot, **`initWorkflowEventTables(getClickHouseClient())` runs unconditionally** (see [`apps/runtime/src/server.ts`](../../apps/runtime/src/server.ts) right after the EventStore init block). This creates the streams → projections → MVs in the correct order.

   > Read-path queries against the `_latest` projections work even when `WORKFLOW_CH_SINK_ENABLED=false`. The tables will simply be empty until the consumer is turned on.

3. Verify:

   ```sql
   SELECT name FROM system.tables
   WHERE database = 'abl_platform'
     AND name LIKE '%workflow%' OR name LIKE '%human_task%';
   ```

   Expect 6 rows (the 4 tables + 2 MVs).

### 1.3 Existing environment (upgrade)

Same as §1.2 — the DDL is idempotent. Restart the runtime pod and the boot-time call will create whatever is missing without affecting existing `platform_events` or `_latest` tables.

If you need to force-provision ahead of a runtime restart (e.g. to pre-warm before flipping `WORKFLOW_CH_SINK_ENABLED`), call the init function directly from a Node REPL or a one-off job pointed at the same ClickHouse.

### 1.4 Retention

Plan-tiered retention is owned by `WorkflowEventLifecycle` in [`packages/eventstore/src/retention/workflow-event-lifecycle.ts`](../../packages/eventstore/src/retention/workflow-event-lifecycle.ts). It implements all 5 `IEventLifecycle` methods (purge expired, scrub PII, delete by session no-op, anonymize actor no-op, delete tenant). The runtime instantiates it and exposes it via `getWorkflowRetention()` in [`apps/runtime/src/services/eventstore-singleton.ts`](../../apps/runtime/src/services/eventstore-singleton.ts).

> **Known gap (GAP-010)**: The daily retention cron (`apps/studio/src/services/retention/retention-scheduler.ts`) does not yet call `registerEventRetentionHandler` for the workflow retention service. `purgeExpired`/`scrubPII` must be invoked manually or via a future wiring PR.

---

## 2. MongoDB Collections

### 2.1 New collection — `workflow_event_outbox`

Defined by the Mongoose schema at [`packages/database/src/models/workflow-event-outbox.model.ts`](../../packages/database/src/models/workflow-event-outbox.model.ts). Created on first write. Three indexes built via `ensureIndexes()`:

| Index                                                                           | Purpose                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------- |
| `{ occurredAt: 1 }`, `partialFilter: { publishedAt: null }`                     | Poller hot path — "oldest unpublished first" |
| `{ expiresAt: 1 }`, TTL 0s, `partialFilter: { publishedAt: { $type: 'date' } }` | Auto-expire published rows; keep unpublished |
| `{ tenantId: 1, entityKind: 1, entityId: 1, occurredAt: 1 }`                    | Per-entity ordering / dedup lookup           |

> **Partial-filter gotcha**: MongoDB rejects `$ne` in partial filters. Always use `{ field: { $type: 'date' } }`.

### 2.2 Modified collections — `workflow_executions` + `human_tasks`

Both schemas gain an `expiresAt: Date | null` column and a flag-gated TTL partial-filter index. Index declaration is wrapped in `if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true')` at schema-load time:

| Collection            | Index                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| `workflow_executions` | `{ expiresAt: 1 }`, TTL 0s, `partialFilter: { expiresAt: { $type: 'date' } }` |
| `human_tasks`         | `{ expiresAt: 1 }`, TTL 0s, `partialFilter: { expiresAt: { $type: 'date' } }` |

> **Flag-flip requires restart**: the TTL index is only declared when the env var is `'true'` at model-load time. Flipping after boot does NOT retroactively create the index. Set `WORKFLOW_MONGO_TTL_ENABLED=true` in the pod spec BEFORE the restart that turns TTL on.

### 2.3 New environment

1. Start `@agent-platform/workflow-engine`. On first write the outbox collection is created; `ensureIndexes()` builds the 3 indexes.
2. Verify:

   ```js
   use abl_platform;
   db.workflow_event_outbox.getIndexes();
   // Expect 3 non-_id indexes.
   ```

### 2.4 Existing environment (upgrade)

1. Deploy the new workflow-engine build. The outbox collection + indexes are created automatically.
2. If you're upgrading before turning TTL on: set `WORKFLOW_MONGO_TTL_ENABLED=false` (or leave unset — default). The `expiresAt` column ships additive; existing documents have `null`.
3. When ready for TTL:
   - **Update the pod spec** to `WORKFLOW_MONGO_TTL_ENABLED=true`.
   - Restart workflow-engine pods. At boot, the TTL indexes are declared + built (non-blocking on MongoDB 4.2+).
   - Verify:
     ```js
     db.workflow_executions.getIndexes().filter((i) => i.key.expiresAt);
     db.human_tasks.getIndexes().filter((i) => i.key.expiresAt);
     ```
4. Optional — narrow the TTL window after a 1-week staging observation by setting `WORKFLOW_MONGO_TTL_SECONDS` (default `1209600` = 14 days; recommended production target `172800` = 48h).

### 2.5 GDPR cascade (tenant deletion)

`packages/database/src/cascade/cascade-delete.ts:deleteTenant()` now fans out to three additional collections:

- `WorkflowExecution.deleteMany({ tenantId })`
- `HumanTask.deleteMany({ tenantId, mailbox: 'workflow' })` — **scope guard**: agent-mailbox tasks are untouched (they belong to the Memory & Sessions feature)
- `WorkflowEventOutboxModel.deleteMany({ tenantId })`

The CH side is reaped by the registered `EventCascadeHook.deleteTenant` which the runtime wires via `cascadeWorkflowTenant()` in [`apps/runtime/src/services/workflow-cascade-hook.ts`](../../apps/runtime/src/services/workflow-cascade-hook.ts). No operator action required — both sides trigger off the same `POST /api/admin/tenants/:id/delete` call.

---

## 3. Kafka Topics

### 3.0 LZ4 codec — required for every consumer

Both the workflow-engine outbox poller and the runtime consumer talk to Kafka via `KafkaEventQueue` (`packages/eventstore/src/queues/kafka-queue.ts`). Since the broker stores batches as LZ4 (per topic config), **any consumer built on KafkaJS MUST have the LZ4 codec registered** — KafkaJS ships with zero built-in support for LZ4 / Snappy / ZSTD.

`KafkaEventQueue` handles this automatically: at module load, it registers an LZ4 codec backed by the pure-JS `lz4js` package. This is a process-wide side effect (`CompressionCodecs` is a shared global) — so any KafkaJS consumer in the same process gets LZ4 support for free.

Implementation note: the more common `kafkajs-lz4` package bundles a WASM LZ4 codec that fails on Node 24 with `ERR_INVALID_URL` when locating its `.wasm` binary. `lz4js` is pure JavaScript and avoids this issue. Don't swap without re-verifying on the target Node version.

### 3.1 Topic definitions

| Topic                    | Purpose                             | Partitions                    | Replication         | Compression | Retention (ms)     |
| ------------------------ | ----------------------------------- | ----------------------------- | ------------------- | ----------- | ------------------ |
| `abl.workflow.execution` | Workflow execution lifecycle events | 3 (dev) / operator-set (prod) | 1 (dev) / ≥3 (prod) | lz4         | 604800000 (7 days) |
| `abl.human.task`         | Workflow-mailbox human-task events  | 3 (dev) / operator-set (prod) | 1 (dev) / ≥3 (prod) | lz4         | 604800000 (7 days) |

Dev defaults from `docker-compose.yml` `init-kafka-topics`. Production values are owned by the `abl-platform-deploy` Helm/Terraform workspace — the 3/1/lz4/7d defaults are the minimum reference, not an SLA.

### 3.2 New environment (dev / docker-compose)

1. `docker compose up -d kafka init-kafka-topics` — the `init-kafka-topics` sidecar creates all 10 platform topics (including the 2 new workflow topics). It is idempotent (`--if-not-exists`).
2. Verify:
   ```bash
   docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
     --bootstrap-server kafka:9092 --list | grep -E "abl.(workflow|human)"
   ```
   Expect `abl.workflow.execution` and `abl.human.task`.

### 3.3 New environment (prod)

1. Provision both topics in `abl-platform-infra` (Terraform) or via your cluster's topic-admin path:
   ```bash
   kafka-topics.sh --bootstrap-server <broker> --create --if-not-exists \
     --topic abl.workflow.execution \
     --partitions <N> --replication-factor <R> \
     --config compression.type=lz4 \
     --config retention.ms=604800000
   kafka-topics.sh --bootstrap-server <broker> --create --if-not-exists \
     --topic abl.human.task \
     --partitions <N> --replication-factor <R> \
     --config compression.type=lz4 \
     --config retention.ms=604800000
   ```
2. `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false` is set in dev compose; prod should match. Explicit topic provisioning is required.

### 3.4 Existing environment (upgrade)

1. Add the 2 new topics using the commands in §3.3.
2. The outbox poller's producer will reject messages if the topic is missing — provision topics BEFORE setting `WORKFLOW_OUTBOX_ENABLED=true`.
3. No change required to existing platform topics (`abl.session.*`, `abl.message.*`, `abl.tool.*`).

---

## 4. Kafka Producer — Workflow-Engine Outbox Poller

### 4.1 What it does

[`apps/workflow-engine/src/outbox/outbox-poller.ts`](../../apps/workflow-engine/src/outbox/outbox-poller.ts) runs a BullMQ repeatable job that drains unpublished rows from `workflow_event_outbox` into Kafka via `KafkaEventQueue.publishAndAck()`.

- **Concurrency**: 1 per replica — BullMQ `jobId`-based leader lock ensures only one worker drains at a time.
- **Publish semantics**: `publishAndAck(topic, event, key)` awaits the Kafka ACK with `acks: -1` (all in-sync replicas) before marking the row `publishedAt`.
- **Partition key**: defaults to `tenantId` (so all events for the same tenant land on the same partition — preserves per-tenant ordering).
- **Idempotent producer**: `idempotent: true`, `maxInFlightRequests: 5` (configured in `KafkaEventQueue` constructor).

### 4.2 Required dependencies

- **MongoDB**: connection to read the outbox collection.
- **Redis**: required for BullMQ's repeatable-job lease. The poller skips startup if Redis is unavailable — logs `WORKFLOW_OUTBOX_ENABLED=true but Redis is unavailable — outbox poller not started`.
- **Kafka brokers** reachable via `EVENT_KAFKA_BROKERS` (comma-separated).

### 4.3 Configuration

| Variable                           | Default          | Notes                                                                |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `WORKFLOW_OUTBOX_ENABLED`          | `false`          | Gate — flip to `true` after outbox collection + Kafka topics exist.  |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS` | `1000`           | BullMQ repeatable-job tick interval.                                 |
| `WORKFLOW_OUTBOX_BATCH_SIZE`       | `100`            | Max rows fetched per drain.                                          |
| `WORKFLOW_OUTBOX_ALERT_THRESHOLD`  | `10000`          | Startup safety check — see `WORKFLOW_MONGO_TTL_ENABLED` interaction. |
| `EVENT_KAFKA_BROKERS`              | `localhost:9092` | Comma-separated list.                                                |

### 4.4 Enablement steps

1. Confirm `workflow_event_outbox` exists + indexes are built (§2).
2. Confirm both Kafka topics exist (§3).
3. Confirm Redis is reachable.
4. Set `WORKFLOW_OUTBOX_ENABLED=true` in the workflow-engine pod spec.
5. Restart workflow-engine pods. Look for `Workflow-event outbox decorators wired` and `Outbox poller started` in logs.
6. Validate with the test-diagnostic endpoint (NODE_ENV=test only) or Mongo queries:
   ```js
   db.workflow_event_outbox.countDocuments({ publishedAt: null });
   // Should trend toward 0 within seconds under a light write load.
   ```

### 4.5 Observability

Emitted from [`apps/workflow-engine/src/outbox/metrics.ts`](../../apps/workflow-engine/src/outbox/metrics.ts) via OTel meter:

- `workflow_outbox_unpublished_rows` (observable gauge)
- `workflow_outbox_publish_latency_ms` (histogram)
- `workflow_outbox_publish_total` / `workflow_outbox_publish_failures_total` (counters)

Structured log events: `workflow.outbox.enqueued`, `workflow.outbox.published`.

---

## 5. Kafka Consumer — Runtime Workflow-Events Consumer

### 5.1 What it does

[`apps/runtime/src/services/workflow-events-consumer.ts`](../../apps/runtime/src/services/workflow-events-consumer.ts) subscribes to the 2 topics via **two independent `KafkaEventQueue` instances** and sinks messages into ClickHouse via `BufferedClickHouseWriter`.

| Topic                    | Consumer group                | CH target table             |
| ------------------------ | ----------------------------- | --------------------------- |
| `abl.workflow.execution` | `workflow-execution-consumer` | `workflow_execution_events` |
| `abl.human.task`         | `human-task-consumer`         | `human_task_events`         |

> **Critical**: each `KafkaEventQueue` MUST set its own `kafka.groupId`. The `KafkaEventQueue` default is `eventstore-consumer`; sharing it across both instances would create constant consumer-group rebalances. The consumer explicitly overrides both.

### 5.2 Buffered-writer tuning

Smaller than the `BufferedClickHouseWriter` defaults (10K batch / 5s flush) — workflow events are lower-volume, latency-sensitive (p95 ≤ 10s event→CH SLI):

- `batchSize: 1000`
- `flushIntervalMs: 1000`

Both are caller-overridable via the `WorkflowEventsConsumerDeps` constructor parameters. Revisit after LOAD-02 confirms headroom.

### 5.3 Validation at entry

Each event is `.safeParse()`'d through the Zod schema exported from `@abl/eventstore/schema` (`WorkflowExecutionEventSchema`, `HumanTaskEventSchema`). The human-task schema pins `mailbox: z.literal('workflow')` — rogue agent-mailbox events get dropped with a `Dropped invalid human.task event` warn log.

### 5.4 Required dependencies

- **ClickHouse** connection (`getClickHouseClient()` from `@agent-platform/database/clickhouse`).
- **Kafka brokers** via `EVENT_KAFKA_BROKERS`.
- The 4 CH tables + 2 MVs must exist (boot-time `initWorkflowEventTables` handles this).

### 5.5 Configuration

| Variable                   | Default          | Notes                                                                    |
| -------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `WORKFLOW_CH_SINK_ENABLED` | `false`          | Gate — turn on after the workflow-engine outbox is publishing healthily. |
| `EVENT_KAFKA_BROKERS`      | `localhost:9092` | Same list as the producer.                                               |

### 5.6 Enablement steps

1. Confirm the workflow-engine outbox is publishing — `workflow_outbox_unpublished_rows` gauge staying low.
2. Confirm CH tables exist (boot-time init already handled this).
3. Set `WORKFLOW_CH_SINK_ENABLED=true` in the runtime pod spec.
4. Restart runtime pods. Look for `Workflow events consumer started` in logs.
5. Validate — confirm rows reach CH within 10s:
   ```sql
   SELECT count() FROM abl_platform.workflow_execution_events
   WHERE occurred_at > now() - INTERVAL 1 MINUTE;
   ```

### 5.7 Observability

Emitted from [`apps/runtime/src/services/workflow-events-consumer-metrics.ts`](../../apps/runtime/src/services/workflow-events-consumer-metrics.ts) via OTel meter:

- `workflow_ch_consumer_lag_ms` (histogram — `Date.now() - event.occurred_at`)
- `workflow_ch_ingest_latency_ms` (histogram — first buffered event → flush success)
- `workflow_ch_buffered_writer_flush_latency_ms` (histogram)
- `workflow_ch_buffered_writer_flush_total` / `_failures_total` (counters)

Structured log events: `workflow.outbox.consumed`, `workflow.consumer.flush_failed`.

### 5.8 Shutdown

The consumer registers a SIGTERM hook (`workflowEventsConsumer.shutdown()`) that flushes both CH writers, closes them, then disconnects Kafka. Flushes run **before** the Kafka disconnect so no buffered events are lost.

---

## 6. Full Rollout Sequence

Recommended per-environment order (assume starting from an upgraded deploy with all code present but every flag default-off):

1. **Verify CH tables** — restart runtime → `initWorkflowEventTables` creates tables automatically. No flag needed.
2. **Provision Kafka topics** — `init-kafka-topics` sidecar in dev; explicit `kafka-topics.sh --create` in prod.
3. **Flip `WORKFLOW_OUTBOX_ENABLED=true`** on workflow-engine. Restart pods. Confirm outbox drains.
4. **Flip `WORKFLOW_CH_SINK_ENABLED=true`** on runtime. Restart pods. Confirm CH rows arrive.
5. **Flip `WORKFLOW_DUAL_READ_ENABLED=true`** on workflow-engine + runtime (read path uses hybrid reader). Confirm API responses still match (parity-check CLI — §7).
6. **Run the parity-check CLI for ≥48h** against the staging dataset. Confirm drift < 0.1%.
7. **Flip `WORKFLOW_MONGO_TTL_ENABLED=true`** + optionally set `WORKFLOW_MONGO_TTL_SECONDS` (default 14 days → narrow to 48h after 1 week staging observation). Restart workflow-engine so the TTL index is created.

Rollback: flip the relevant flag(s) to `false` and restart. TTL indexes remain until manually dropped (`db.workflow_executions.dropIndex('expiresAt_1')`, non-blocking op on MongoDB 4.2+).

---

## 7. Parity-Check CLI

`tools/test-infra/parity-check.ts` samples random executions from Mongo and diffs 10 canonical fields against `workflow_executions_latest`:

```bash
pnpm tsx tools/test-infra/parity-check.ts --help
pnpm tsx tools/test-infra/parity-check.ts --sample-size 1000 --threshold 0.001
pnpm tsx tools/test-infra/parity-check.ts --tenant-id <t> --threshold 0.0005
```

Env vars: `MONGODB_URL` (required), `CLICKHOUSE_URL` (default `http://localhost:8123`), `CLICKHOUSE_DATABASE` (default `abl_platform`), `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`.

Exit codes: `0` drift ≤ threshold; `1` drift > threshold; `2` invalid args / connection failure. Use in CI or as a scheduled job during the canary rollout.

---

## 8. Quick Reference — all env vars

| Variable                           | Owner service                       | Default                  | When to set                                            |
| ---------------------------------- | ----------------------------------- | ------------------------ | ------------------------------------------------------ |
| `WORKFLOW_OUTBOX_ENABLED`          | workflow-engine                     | `false`                  | Step 3 of the rollout sequence.                        |
| `WORKFLOW_CH_SINK_ENABLED`         | runtime                             | `false`                  | Step 4 of the rollout sequence.                        |
| `WORKFLOW_DUAL_READ_ENABLED`       | workflow-engine + runtime           | `false`                  | Step 5 of the rollout sequence.                        |
| `WORKFLOW_MONGO_TTL_ENABLED`       | workflow-engine + packages/database | `false`                  | Step 7 — requires restart after flip.                  |
| `WORKFLOW_MONGO_TTL_SECONDS`       | workflow-engine                     | `1209600` (14 days)      | Optional — narrow to `172800` (48 h) post-observation. |
| `WORKFLOW_OUTBOX_POLL_INTERVAL_MS` | workflow-engine                     | `1000`                   | Tune for publish latency if needed.                    |
| `WORKFLOW_OUTBOX_BATCH_SIZE`       | workflow-engine                     | `100`                    | Tune for drain throughput if needed.                   |
| `WORKFLOW_OUTBOX_ALERT_THRESHOLD`  | workflow-engine                     | `10000`                  | Startup safety log threshold.                          |
| `WORKFLOW_EVENT_TOPIC_EXECUTION`   | workflow-engine + runtime           | `abl.workflow.execution` | Only override for isolated test clusters.              |
| `WORKFLOW_EVENT_TOPIC_HUMAN_TASK`  | workflow-engine + runtime           | `abl.human.task`         | Only override for isolated test clusters.              |
| `EVENT_KAFKA_BROKERS`              | workflow-engine + runtime           | `localhost:9092`         | Comma-separated broker list.                           |

---

## 9. Gated E2E Tests

The feature ships with an E2E test lane (`pnpm --filter=@agent-platform/workflow-engine test:e2e`) that hits the real running stack. Each scenario is **gated** — it SKIPS (never fails) unless the operator has both the feature flags on AND the service + infra reachable. This keeps default CI green while letting operators validate a staging/prod-like environment with a single command.

### Enabling E2E-01 (workflow-execution-lifecycle pilot)

1. Bring up the stack:

   ```bash
   docker compose up -d mongo kafka clickhouse redis   # or `make dev-up`
   # In two terminals (so the services pick up flags):
   WORKFLOW_OUTBOX_ENABLED=true pnpm --filter=@agent-platform/workflow-engine dev
   WORKFLOW_CH_SINK_ENABLED=true NODE_ENV=test pnpm --filter=@agent-platform/runtime dev
   ```

   `NODE_ENV=test` on the runtime enables the `/api/admin/test/workflow-ch-events/:id` diagnostic the E2E test uses. Workflow-engine auto-mounts its test-diagnostic router under the same guard.

2. Seed a workflow and capture its id (out of scope for the E2E test — the test consumes an already-deployed workflow):

   ```bash
   # via Studio or direct API POST to /api/v1/projects/:projectId/workflows
   export E2E_WORKFLOW_ID='<your workflow id>'
   ```

3. Export auth context (a JWT the workflow-engine's `createUnifiedAuthMiddleware` accepts):

   ```bash
   export E2E_AUTH_TOKEN='<bearer-jwt>'
   export E2E_TENANT_ID='t1'
   export E2E_PROJECT_ID='p1'
   export E2E_USER_ID='u1'   # defaults shown
   ```

4. Run the E2E lane:

   ```bash
   WORKFLOW_OUTBOX_ENABLED=true WORKFLOW_CH_SINK_ENABLED=true \
     pnpm --filter=@agent-platform/workflow-engine test:e2e
   ```

If any gate is unmet the test emits `[e2e:E2E-01] skipped — <reason>` and exits 0. Vitest reports `1 skipped` — safe to wire into CI.

### Gate environment variables

| Variable                  | Purpose                                | Default                 |
| ------------------------- | -------------------------------------- | ----------------------- |
| `E2E_WORKFLOW_ENGINE_URL` | Workflow-engine base URL the test hits | `http://127.0.0.1:9080` |
| `E2E_RUNTIME_URL`         | Runtime base URL the test hits         | `http://127.0.0.1:3112` |
| `CLICKHOUSE_URL`          | CH base URL (reused from ops stack)    | `http://127.0.0.1:8123` |
| `CLICKHOUSE_USERNAME`     | CH HTTP basic-auth user (if CH locked) | — (optional)            |
| `CLICKHOUSE_PASSWORD`     | CH HTTP basic-auth password            | — (optional)            |
| `EVENT_KAFKA_BROKERS`     | Kafka brokers (reused from ops stack)  | `127.0.0.1:9092`        |
| `E2E_AUTH_TOKEN`          | Bearer JWT for auth header             | — (required)            |
| `E2E_TENANT_ID`           | Tenant scope for test assertions       | `t1`                    |
| `E2E_PROJECT_ID`          | Project scope for test assertions      | `p1`                    |
| `E2E_USER_ID`             | User scope for test assertions         | `u1`                    |
| `E2E_WORKFLOW_ID`         | Pre-seeded workflow id to execute      | — (required)            |

### Adding more scenarios

Scenarios follow the same pattern: one `.e2e.test.ts` file per scenario, top-level `await evaluateE2EGate(...)` with the required flags + services, `describe.skipIf(!gate.shouldRun)(...)`. Shared helper at `apps/workflow-engine/src/__tests__/helpers/e2e-gate.ts`. Future scenarios (E2E-02 dual-read, E2E-05 GDPR cascade, E2E-06 trigger chain) drop in alongside E2E-01 and pick up the same gate matrix.
