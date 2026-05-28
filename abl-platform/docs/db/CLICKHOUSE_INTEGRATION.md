# ClickHouse Integration Guide

## Overview

ClickHouse handles high-volume time-series and analytics data for the ABL Platform, storing ~330M writes/day across 5 tables. It operates alongside MongoDB (metadata) when `DB_BACKEND=mongo`.

## Tables

| Table                                                                   | Volume    | Purpose                     | Encrypted Columns |
| ----------------------------------------------------------------------- | --------- | --------------------------- | ----------------- |
| messages (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md) S5.2)     | ~300M/day | Chat message content        | `content`         |
| llm_metrics (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md) S5.3)  | ~100M/day | LLM API usage metrics       | None              |
| traces (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md) S5.1)       | ~200M/day | Execution trace spans       | `data`            |
| logs (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md) S5.4)         | ~65M/day  | Structured application logs | None              |
| audit_events (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md) S5.5) | ~10M/day  | Runtime audit trail         | None              |

## Engine Selection

All tables use `ReplicatedMergeTree('/clickhouse/tables/{shard}/{table}', '{replica}')` in both dev and production. Docker Compose includes ClickHouse Keeper for local dev to ensure consistent behavior across environments.

A TypeScript init script at `packages/database/src/clickhouse-schemas/init.ts` generates the DDL.

## Encryption Architecture

### Strategy: Application-Level, Tenant-Scoped

Encryption happens at the application layer before data reaches the `BufferedClickHouseWriter`. ClickHouse stores opaque ciphertext — no server-side decryption.

- Uses existing `EncryptionService` at `apps/runtime/src/services/encryption-service.ts`
- Tenant-scoped keys via `compressAndEncryptForTenant(plaintext, tenantId)`
- Key derivation: PBKDF2, 100K iterations, SHA-256
- Algorithm: AES-256-GCM

### Encrypt Pipeline (per message)

```
plaintext → ZSTD compress (level 3) → AES-256-GCM encrypt → Base64 encode → store in ClickHouse
```

### Wire Format

```
{compression}:{iv_b64}:{authTag_b64}:{ciphertext_b64}

Z1:kE3vX...:pQ8r...:encrypted_data...    -- ZSTD compressed
N0:kE3vX...:pQ8r...:encrypted_data...    -- No compression (input < 64 bytes)
```

### Key Caching

A `TenantKeyCache` (LRU, 1000 entries, 30min TTL) avoids re-deriving PBKDF2 keys per message. PBKDF2 runs once per tenant per 30 minutes.

### Encryption Metadata Columns

Tables with encrypted columns include:

- `encrypted UInt8 DEFAULT 1` — flag for gradual migration
- `key_version UInt16 DEFAULT 1` — tracks key version for rotation

### GDPR Crypto-Shredding

- **Contact deletion**: `ALTER TABLE messages DELETE WHERE tenant_id = ? AND contact_id = ?`
- **Tenant deletion**: Destroy tenant key → all encrypted data permanently unreadable in O(1)
- **Key rotation**: Background job re-encrypts rows using `key_version` column

## Compression Strategy

### Compress-Then-Encrypt

Encrypted data is incompressible (max entropy). Compression must happen before encryption.

| Algorithm  | Ratio      | Compress Speed | Decompress Speed |
| ---------- | ---------- | -------------- | ---------------- |
| LZ4        | 2-2.5x     | 780 MB/s       | 4200 MB/s        |
| **ZSTD 3** | **3-3.5x** | **350 MB/s**   | **1700 MB/s**    |
| gzip 6     | 3-3.5x     | 50 MB/s        | 350 MB/s         |

ZSTD level 3 provides gzip-level compression at 7x the speed.

### Column Codecs

| Column Type            | Codec                         | Rationale                            |
| ---------------------- | ----------------------------- | ------------------------------------ |
| Encrypted strings      | `CODEC(NONE)`                 | High entropy, incompressible         |
| UUIDs/CUIDs            | `CODEC(NONE)`                 | High entropy                         |
| Repeated strings       | `CODEC(ZSTD(1))`              | Excellent compression on sorted data |
| LowCardinality strings | `CODEC(ZSTD(1))`              | Dictionary-encoded                   |
| UInt8 flags            | `CODEC(T64, ZSTD(1))`         | T64 optimal for small integers       |
| DateTime64 timestamps  | `CODEC(DoubleDelta, ZSTD(1))` | Monotonic timestamps                 |
| DateTime timestamps    | `CODEC(Delta, ZSTD(1))`       | Second-precision timestamps          |
| Float metrics          | `CODEC(Gorilla, ZSTD(1))`     | Float time-series                    |
| Integer metrics        | `CODEC(T64, ZSTD(1))`         | Integer sequences                    |

## Storage Tiering

```
Hot (local SSD) → Warm (attached SSD, 30 days) → Cold (S3, 90 days) → Delete (TTL)
```

Configuration: `scripts/clickhouse-init/storage.xml`

## Data Ingestion

### Batch Size: 10K rows / 5s flush

The `BufferedClickHouseWriter` buffers 10,000 rows OR flushes every 5 seconds. ClickHouse async inserts are enabled as a safety net.

```typescript
const client = createClient({
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 1,
    async_insert_max_data_size: 10485760, // 10MB
    async_insert_busy_timeout_ms: 5000, // 5s
  },
});
```

## Per-Tenant Retention

ClickHouse TTL is table-level. Per-tenant retention uses a daily scheduler issuing lightweight deletes:

```sql
ALTER TABLE abl_platform.messages DELETE
WHERE tenant_id = {tenantId} AND created_at < now() - INTERVAL {days} DAY
```

## Best Practices Applied

- No `Nullable` columns — use `DEFAULT ''` or `DEFAULT 0`
- `DateTime` where millisecond precision unneeded (logs, audit_events)
- `LowCardinality` for all string columns with <10K distinct values
- Low-cardinality columns first in ORDER BY
- Daily partitions for high-volume tables (1-300 GB per partition)
- Selective skip indexes (bloom_filter adds ~45% overhead)
- `ttl_only_drop_parts = 1` for efficient partition-level drops
- `AggregatingMergeTree` + `SimpleAggregateFunction` for materialized views

## Related Files

| File                                               | Purpose                           |
| -------------------------------------------------- | --------------------------------- |
| `packages/database/src/clickhouse.ts`              | Client singleton + BufferedWriter |
| `packages/database/src/clickhouse-schemas/init.ts` | DDL generation                    |
| `scripts/clickhouse-init/01-init.sql`              | Raw DDL script                    |
| `scripts/clickhouse-init/storage.xml`              | Storage policy                    |
| `apps/runtime/src/services/encryption-service.ts`  | Encryption + key cache            |
| `apps/runtime/src/services/stores/clickhouse-*.ts` | Store implementations             |
