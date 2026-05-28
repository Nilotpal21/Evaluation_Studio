# Dual-Write Policy: MongoDB + ClickHouse

## Source of Truth

| Data Type  | Primary (Authoritative)                      | Secondary (Analytics) | Notes                                                           |
| ---------- | -------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| Messages   | **MongoDB**                                  | ClickHouse            | Sync write to Mongo, async to ClickHouse                        |
| Sessions   | **MongoDB**                                  | ClickHouse            | Lifecycle managed in Mongo, replicated for analytics            |
| Traces     | **Redis Streams** (hot) / **MongoDB** (warm) | ClickHouse            | Real-time via Redis, persisted to Mongo, archived to ClickHouse |
| Metrics    | **MongoDB** (`$inc` atomics)                 | ClickHouse            | Token counts, error counts via atomic increments                |
| Audit Logs | **MongoDB**                                  | ClickHouse            | Fire-and-forget writes, never blocks caller                     |

## Write Paths

### Messages

1. **BullMQ path** (Redis available): WS handler → in-memory buffer → BullMQ job → MongoDB `insertMany` (ordered: false, idempotency key dedup)
2. **Direct path** (no Redis): WS handler → MongoDB `create` via `MongoMessageStore.addMessage()`
3. **ClickHouse replication**: Async consumer reads from BullMQ completed jobs or change streams

### Sessions

1. **Creation**: `MongoConversationStore.createSession()` — synchronous MongoDB write
2. **Updates**: Atomic `$set` / `$inc` via `findByIdAndUpdate`
3. **Redis cache**: `RedisSessionStore` holds hot session state (30min TTL), persisted back to MongoDB on close/detach
4. **ClickHouse**: Periodic batch sync of completed sessions

### Traces

1. **Hot path**: Redis Streams (`XADD`) + Pub/Sub for real-time delivery
2. **Warm path**: In-memory `TraceStore` for single-pod deployments
3. **Cold path**: ClickHouse for long-term retention and analytics queries

## Conflict Resolution

- **MongoDB wins**: It is the synchronous write path and source of truth
- **ClickHouse is eventually consistent**: Accepts slight lag (seconds to minutes)
- **Redis is ephemeral**: Session/trace data in Redis has TTL; MongoDB is the durable backup

## Data Retention

| Store            | Retention                     | Mechanism                                     |
| ---------------- | ----------------------------- | --------------------------------------------- |
| Redis sessions   | 30 minutes TTL                | Redis key expiry                              |
| Redis traces     | 15 minutes TTL                | Stream MAXLEN + key expiry                    |
| MongoDB sessions | 90 days after `endedAt`       | TTL index (partial filter: `endedAt != null`) |
| MongoDB messages | 90 days via `expiresAt`       | TTL index (sparse, per-document expiry)       |
| ClickHouse       | Configurable (default 1 year) | TTL on MergeTree tables                       |

## Encryption at Rest

| Store            | Encrypted Fields                                          | Method                                                        |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Redis sessions   | `authToken`, `state`, `dataValues`, conversation messages | AES-256-GCM per tenant (`EncryptionService.encryptForTenant`) |
| MongoDB messages | `content`                                                 | AES-256-GCM per tenant (when `ENCRYPTION_MASTER_KEY` set)     |
| ClickHouse       | `content`                                                 | Compress-then-encrypt (ZSTD + AES-256-GCM)                    |

## Divergence Detection (Future)

Periodic reconciliation job (not yet implemented):

1. Count messages per session in MongoDB vs ClickHouse
2. Compare checksum of message content hashes
3. Alert on divergence > threshold
4. Repair: re-sync from MongoDB (authoritative) to ClickHouse
