# MongoDB + ClickHouse: Additional Concerns & Proposed Solutions

> **Document Type**: Supplementary Design — Additional concerns for MongoDB + ClickHouse architecture
> **Status**: Draft
> **Date**: 2026-02-09
> **Companion**: [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md) (consolidated data architecture reference)

---

MongoDB + ClickHouse is the recommended architecture for the ABL Platform — it scores good or excellent on 15 of 16 query patterns, handles 330M writes/day across all data types, and provides declarative retention via ClickHouse TTL. The full rationale is in [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md), Section 3.

This document covers four additional concerns that this architecture must address beyond what the analysis and implementation docs cover.

---

## Table of Contents

1. [Message Queuing — Runs Collection](#1-message-queuing--runs-collection)
2. [Encryption at Rest — BYOK + ClickHouse Compression](#2-encryption-at-rest--byok--clickhouse-compression)
3. [PII Token Retention — Separate Collection vs Unified Retention](#3-pii-token-retention--separate-collection-vs-unified-retention)
4. [Session Analytics — MongoDB-only Sessions Limit Analytics Queries](#4-session-analytics--mongodb-only-sessions-limit-analytics-queries)
5. [Summary](#5-summary)

---

## Gap 1: Message Queuing — Runs Collection & Attachments

### Problem

The current architecture has no concept of a "run" — a unit of work that processes a user message through the agent pipeline. When multiple messages arrive for the same session in rapid succession (e.g., user sends two messages before the agent responds to the first), there is no mechanism to:

1. **Queue messages per session** — ensure they are processed sequentially, not concurrently
2. **Track processing status** — know whether a message is pending, in-progress, completed, or failed
3. **Store attachments** — user-uploaded files (images, documents, audio) associated with a specific message turn

Currently, `handleSendMessage()` in `handler.ts` calls `executor.executeMessage()` synchronously per WebSocket event. If two messages arrive concurrently for the same session, both hit the RuntimeExecutor simultaneously, causing race conditions on shared session state (`conversationHistory`, `currentFlowStep`, `flowCollectedData`).

### Solution Summary

New `runs` collection in MongoDB. Each user message creates a Run (queued → in_progress → completed/failed). Per-session Redis lock (`SETNX` with TTL) ensures sequential processing — no concurrent runs on the same session. When a run completes, it picks up the next queued run.

### Current State

| Component                   | Status                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Run model/collection        | Does not exist                                                                           |
| Message queuing per session | No queue — messages processed inline on WebSocket event                                  |
| Attachment model            | Interface exists (`Attachment` in `digital-runtime.ts:67-84`) but not persisted anywhere |
| Concurrency control         | None — two concurrent messages on the same session cause undefined behavior              |

### Proposed Solution: Runs Collection in MongoDB + Attachment Storage

#### 1.1 Runs Collection (MongoDB)

A `Run` represents one turn of user input → agent processing → agent output. It lives in MongoDB alongside conversation metadata because it requires frequent status updates and indexed lookups.

```javascript
// Collection: runs
{
  _id: String,                      // CUID
  organizationId: String,           // Tenant isolation
  conversationId: String,           // Links to conversations collection

  // Ordering
  sequenceNumber: Number,           // Auto-incrementing per conversation (1, 2, 3...)

  // Status lifecycle
  status: String,                   // 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

  // Input
  userMessageId: String,            // References the user message in ClickHouse
  inputText: String,                // Original user message text (for quick access without ClickHouse read)
  inputChannel: String,             // Channel the message arrived on

  // Output
  agentMessageId: String | null,    // References the agent response in ClickHouse
  agentName: String,                // Which agent processed this run
  outputText: String | null,        // Agent response text (for quick access)
  toolCalls: Number,                // How many tool calls were made
  handoffTo: String | null,         // If run resulted in a handoff

  // Execution metadata
  traceId: String | null,           // Links to ClickHouse traces table
  modelId: String | null,           // Which LLM model was used
  inputTokens: Number | null,
  outputTokens: Number | null,

  // Timing
  queuedAt: Date,                   // When the message was received
  startedAt: Date | null,           // When processing began
  completedAt: Date | null,         // When processing finished
  durationMs: Number | null,        // Total processing time

  // Error tracking
  error: String | null,             // Error message if failed
  retryCount: Number,               // Number of retry attempts
  maxRetries: Number,               // Max retries allowed
}

// Indexes
{ conversationId: 1, sequenceNumber: 1 }        // Ordered run history
{ conversationId: 1, status: 1 }                 // Find pending/in-progress runs
{ organizationId: 1, status: 1, queuedAt: 1 }   // Global queue monitoring
{ organizationId: 1, completedAt: -1 }           // Recent runs dashboard
```

#### 1.2 Per-Session Sequential Processing

The concurrency problem is solved with a **per-session lock** — not a global queue. Each session processes one run at a time:

```
User Message arrives
    │
    ├─► Create Run document (status: 'queued', queuedAt: now)
    │
    ├─► Acquire per-session lock (Redis SETNX with TTL)
    │   Key: `run:lock:{conversationId}`
    │   TTL: 120 seconds (max run duration)
    │
    ├─► If lock acquired:
    │     Set Run status → 'in_progress', startedAt → now
    │     Execute agent pipeline
    │     Set Run status → 'completed' or 'failed'
    │     Release lock (DEL key)
    │     Check for next queued Run in this session → process it
    │
    └─► If lock NOT acquired (another run in progress):
          Run stays in 'queued' status
          When current run completes → picks up next queued run
```

**Why Redis lock, not MongoDB queue polling:**

- Redis SETNX is atomic and sub-millisecond
- No polling interval — lock release triggers immediate pickup
- TTL prevents deadlocks if a run crashes mid-processing
- Redis is already in the architecture (active session message buffer)

#### 1.3 Impact on Existing Architecture

| Component                        | Change                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| MongoDB                          | New `runs` collection                                      |
| Redis                            | Per-session lock keys (`run:lock:{conversationId}`)        |
| WebSocket handler (`handler.ts`) | Create Run → acquire lock → execute → release → check next |
| RuntimeExecutor                  | Run status available in message context                    |
| Retention Service                | Delete runs when conversation is deleted                   |
| GDPR Service                     | Include run deletion in erasure flow                       |

---

## Gap 2: Encryption at Rest — ClickHouse Compression vs Encryption

### Problem

The DATA_ARCHITECTURE.md (Section 3) recommends ClickHouse for its 10-30x columnar compression ratio. Encrypting individual fields (like `content` in messages) **before** insertion destroys this compression because:

- ClickHouse achieves high compression by storing similar column values adjacent (e.g., many messages have `role = 'assistant'` — compresses to near-zero)
- AES-256-GCM encrypted data is indistinguishable from random bytes
- Random bytes achieve ~0% compression ratio
- Encrypting the `content` column would inflate storage by 10-30x for that column, negating ClickHouse's primary advantage

This is not a theoretical concern. The `content` column is the largest column in the `messages` table (typically 80%+ of row size). Encrypting it would mean:

```
Without encryption: 25 GB/day × 10x compression = 2.5 GB/day stored
With field encryption: 25 GB/day × 1x compression = 25 GB/day stored (10x worse)
```

### Solution Summary

Two layers. **Layer 1**: ClickHouse disk-level encryption (AES-256-CTR) with platform-managed key — covers all data, preserves compression. **Layer 2**: Per-tenant BYOK encryption on `content` column only via application-level `BYOKClickHouseClient` — each tenant's key from their KMS (AWS KMS / Azure Key Vault / GCP Cloud KMS / Vault). Trade-off: ~8x storage increase on content column (encrypted bytes don't compress). Metadata columns stay unencrypted and fully queryable. `content_key_version` column tracks key version for rotation. PII scrubbing becomes an application-level batch job since ClickHouse TTL SET can't decrypt/re-encrypt.

### Options Evaluated

#### Option A: ClickHouse Disk-Level Encryption (Recommended)

ClickHouse supports **encryption at the disk layer** — all data written to disk is encrypted transparently, and decrypted on read. This preserves columnar compression because encryption happens **after** compression:

```
Write path:  Column data → LZ4/ZSTD compress → AES-256-CTR encrypt → disk
Read path:   Disk → AES-256-CTR decrypt → LZ4/ZSTD decompress → query engine
```

```xml
<!-- ClickHouse encrypted disk configuration -->
<storage_configuration>
  <disks>
    <!-- Encrypted local disk wrapping the physical disk -->
    <encrypted_local>
      <type>encrypted</type>
      <disk>local</disk>
      <path>encrypted/</path>
      <algorithm>aes_256_ctr</algorithm>
      <key_hex from_env="CLICKHOUSE_ENCRYPTION_KEY" />
    </encrypted_local>

    <!-- Encrypted warm disk -->
    <encrypted_warm>
      <type>encrypted</type>
      <disk>warm_ssd</disk>
      <path>encrypted/</path>
      <algorithm>aes_256_ctr</algorithm>
      <key_hex from_env="CLICKHOUSE_ENCRYPTION_KEY" />
    </encrypted_warm>

    <!-- Cold storage (S3) — use S3 SSE instead -->
    <cold_s3>
      <type>s3</type>
      <endpoint>https://{bucket}.s3.{region}.amazonaws.com/clickhouse/</endpoint>
      <!-- S3 Server-Side Encryption -->
      <server_side_encryption_customer_algorithm>aws:kms</server_side_encryption_customer_algorithm>
      <server_side_encryption_kms_key_id>{kms-key-id}</server_side_encryption_kms_key_id>
    </cold_s3>
  </disks>

  <policies>
    <tiered_encrypted>
      <volumes>
        <hot>
          <disk>encrypted_local</disk>
        </hot>
        <warm>
          <disk>encrypted_warm</disk>
        </warm>
        <cold>
          <disk>cold_s3</disk>   <!-- S3 SSE-KMS handles encryption -->
        </cold>
      </volumes>
    </tiered_encrypted>
  </policies>
</storage_configuration>
```

**Pros:**

- Zero compression impact — encryption happens after compression
- Zero application code changes — transparent to queries and inserts
- Covers ALL columns, not just `content` — full disk encryption
- Key rotation via ClickHouse key management or external KMS
- Cold tier uses cloud-native encryption (S3 SSE-KMS, Azure SSE, GCS CMEK)

**Cons:**

- Encrypts everything — no selective field encryption (but this is actually better for compliance)
- ClickHouse process has the decryption key in memory — compromised process = compromised data

**Compliance mapping:**
| Requirement | Coverage |
|---|---|
| SOC 2 (CC6.1 — encryption at rest) | Full — all data encrypted on disk |
| HIPAA (§164.312(a)(2)(iv) — encryption) | Full — AES-256 on all storage tiers |
| PCI-DSS (Req 3.4 — stored cardholder data) | Full — PII column encrypted at rest (plus TTL scrub at 14 days) |
| GDPR (Art. 32 — security of processing) | Full — encryption at rest + PII TTL |

#### Option B: Application-Level Encryption via Wrapping SDK Client

Wrap the ClickHouse client SDK to encrypt/decrypt specific fields on insert/read:

```typescript
class EncryptedClickHouseClient {
  private encryptionService: EncryptionService;
  private client: ClickHouseClient;

  async insertMessage(msg: Message): Promise<void> {
    const encrypted = {
      ...msg,
      content: this.encryptionService.encrypt(msg.content),
    };
    await this.client.insert('messages', encrypted);
  }

  async queryMessages(conversationId: string): Promise<Message[]> {
    const rows = await this.client.query(`SELECT * FROM messages WHERE conversation_id = ?`, [
      conversationId,
    ]);
    return rows.map((row) => ({
      ...row,
      content: this.encryptionService.decrypt(row.content),
    }));
  }
}
```

**Pros:**

- Selective field encryption — only encrypt `content`, leave metadata unencrypted
- Defense-in-depth — even if disk encryption is compromised, content is still encrypted
- ClickHouse process never sees plaintext content

**Cons:**

- **Destroys compression on encrypted columns** — 10-30x storage increase for `content`
- **Breaks ClickHouse TTL SET rules** — `SET content = '[PII_EXPIRED]'` would need to SET encrypted bytes, requiring the encryption key in the TTL rule (not possible)
- **Breaks text search** — `hasToken(content, 'keyword')` cannot search encrypted content
- **Breaks cross-conversation search (Q11)** — fundamental incompatibility
- **Every read requires decryption** — adds latency to every message query
- **Key rotation requires re-encryption of all data** — unlike disk-level where only the outer layer is re-encrypted

#### Option C: Hybrid — Disk Encryption + Per-Tenant Application Encryption with BYOK (Recommended)

The platform requires **BYOK (Bring Your Own Key)** — enterprise tenants must be able to provide their own encryption keys so that neither the platform operator nor the infrastructure provider can access their data without the tenant's key. Disk-level encryption alone (Option A) uses a single platform-wide key, which does not satisfy BYOK requirements.

**Architecture: Two encryption layers, each serving a different purpose.**

```
Layer 1 — Disk-Level Encryption (platform-managed key):
  → Protects against physical disk theft, cloud provider access
  → Single key per ClickHouse instance
  → Covers ALL columns, ALL tenants
  → Compression happens BEFORE this layer → zero impact

Layer 2 — Application-Level Encryption (per-tenant BYOK key):
  → Protects content from platform operators and co-tenants
  → Each tenant has their own key (stored in their KMS or our vault)
  → Applied ONLY to the `content` column (and other sensitive fields)
  → Compression is destroyed on encrypted columns → accept this trade-off for content
  → Metadata columns (role, channel, timestamp, org_id) remain unencrypted → queryable

Cold Tier (cloud-native per-tenant keys):
  → S3 SSE-KMS with per-tenant KMS key
  → Azure SSE with per-tenant Key Vault key
  → GCS CMEK with per-tenant Cloud KMS key
```

**Per-tenant key management:**

```typescript
// Tenant Key Resolution
interface TenantKeyProvider {
  /** Get the encryption key for a tenant — from their KMS or our vault */
  getKey(organizationId: string): Promise<{ key: Buffer; keyVersion: number }>;
  /** Rotate to a new key — old key kept for decrypt-only */
  rotateKey(organizationId: string, newKey: Buffer): Promise<void>;
}

class BYOKClickHouseClient {
  private keyProvider: TenantKeyProvider;
  private client: ClickHouseClient;

  async insertMessage(msg: Message): Promise<void> {
    const { key, keyVersion } = await this.keyProvider.getKey(msg.organizationId);
    const encrypted = {
      ...msg,
      content: encrypt(msg.content, key), // AES-256-GCM with tenant's key
      content_key_version: keyVersion, // Track which key version encrypted this
    };
    await this.client.insert('messages', encrypted);
  }

  async queryMessages(orgId: string, conversationId: string): Promise<Message[]> {
    const rows = await this.client.query(
      `SELECT * FROM messages WHERE organization_id = ? AND conversation_id = ?`,
      [orgId, conversationId],
    );
    const { key } = await this.keyProvider.getKey(orgId);
    return rows.map((row) => ({
      ...row,
      content: decrypt(row.content, key, row.content_key_version),
    }));
  }
}
```

**ClickHouse schema addition for BYOK:**

```sql
CREATE TABLE messages (
    organization_id     String,
    conversation_id     String,
    message_id          String,
    contact_id          Nullable(String),

    role                LowCardinality(String),     -- unencrypted — queryable
    content             String,                     -- BYOK-encrypted per tenant
    content_key_version UInt16 DEFAULT 0,           -- which key version encrypted this row
    channel             LowCardinality(String),     -- unencrypted — queryable
    trace_id            Nullable(String),

    has_pii             Bool DEFAULT false,          -- unencrypted — queryable
    scrubbed            Bool DEFAULT false,           -- unencrypted — queryable

    metadata            String DEFAULT '{}',         -- unencrypted (no PII in metadata)
    timestamp           DateTime64(3),               -- unencrypted — partition key

    INDEX idx_contact contact_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_pii (has_pii, scrubbed) TYPE set(4) GRANULARITY 4
) ENGINE = ReplicatedMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (organization_id, conversation_id, timestamp)
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered_encrypted',
    index_granularity = 8192;
```

**Impact on ClickHouse features:**

| Feature                     | Unencrypted columns (role, channel, timestamp, metadata, org_id) | BYOK-encrypted columns (content)                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Columnar compression        | Full (10-30x)                                                    | None (~1x) — encrypted bytes are random                                                                                                                 |
| TTL partition drop (DELETE) | Works                                                            | Works — entire partition dropped regardless of content                                                                                                  |
| TTL SET (PII scrub)         | Works                                                            | **Does not work** — cannot rewrite encrypted content without the key. PII scrubbing must be done at application level.                                  |
| Text search (Q11)           | Works                                                            | **Does not work** — encrypted content is not searchable. Full-text search requires a separate search index built at ingestion time (before encryption). |
| Aggregation / GROUP BY      | Works                                                            | Not applicable — you don't aggregate on message content                                                                                                 |
| ORDER BY / filtering        | Works                                                            | Not applicable — content is not used in WHERE clauses                                                                                                   |

**Storage cost impact:**

```
Without BYOK encryption on content:
  25 GB/day raw → ~2.5 GB/day compressed (10x) → 225 GB/90 days hot

With BYOK encryption on content:
  Content column: 20 GB/day raw → ~20 GB/day (1x) → 1.8 TB/90 days hot
  Other columns:   5 GB/day raw → ~0.5 GB/day (10x) → 45 GB/90 days hot
  Total:          25 GB/day raw → ~20.5 GB/day → 1.85 TB/90 days hot

  Storage increase: ~8x on total, driven by content column
```

This is the cost of BYOK. It is unavoidable when encrypting with per-tenant keys at the application layer. The trade-off is accepted because:

- Tenant data isolation is a hard requirement for enterprise customers
- Content is the only large column — metadata columns still compress normally
- ClickHouse still handles the volume (20.5 GB/day is modest for ClickHouse)
- The alternative (not offering BYOK) loses enterprise deals

**Key rotation:**

When a tenant rotates their key:

1. New writes use the new key (tracked via `content_key_version`)
2. Old data remains encrypted with the old key — old key is kept in `decrypt_only` status
3. Background re-encryption job (optional): reads old rows, decrypts with old key, re-encrypts with new key, rewrites
4. After re-encryption completes, old key can be destroyed

The `content_key_version` column enables reads to select the correct key version without trial-and-error decryption.

**PII scrubbing with BYOK:**

Since ClickHouse TTL SET cannot decrypt/re-encrypt content, PII scrubbing returns to the application layer — but in a much simpler form than the original N+1 pattern:

```typescript
// Application-level PII scrub (runs as scheduled job)
async function scrubPIIForTenant(orgId: string, beforeDate: Date): Promise<void> {
  const { key } = await keyProvider.getKey(orgId);

  // ClickHouse returns encrypted content for messages with hasPII=true
  const rows = await clickhouse.query(
    `
    SELECT message_id, content, content_key_version
    FROM messages
    WHERE organization_id = ? AND has_pii = true AND scrubbed = false AND timestamp < ?
  `,
    [orgId, beforeDate],
  );

  // Batch: decrypt → replace → re-encrypt → lightweight update
  const updates = rows.map((row) => ({
    message_id: row.message_id,
    content: encrypt('[PII_EXPIRED]', key),
    scrubbed: true,
  }));

  await clickhouse.insertBatch('messages_pii_updates', updates);
  // Use ReplacingMergeTree or ALTER TABLE UPDATE for batch rewrite
}
```

This is more work than ClickHouse-native TTL SET, but it only runs on `hasPII=true` messages (typically ~10% of total), and it's batched — not N+1.

**Pros:**

- Satisfies BYOK requirement — each tenant controls their own key
- Defense-in-depth — disk encryption + app encryption + cloud-native cold tier encryption
- Metadata columns remain unencrypted → ClickHouse query/filter/aggregate capabilities preserved
- `content_key_version` enables clean key rotation without re-encrypting everything immediately
- Works with per-tenant dedicated clusters (tenant's KMS key used exclusively)

**Cons:**

- ~8x storage increase for content column (no compression on encrypted data)
- PII scrubbing falls back to application-level job (not ClickHouse TTL SET)
- Cross-conversation text search (Q11) requires separate search index built at ingestion
- Two key management systems (platform disk keys + per-tenant BYOK keys)
- Read latency adds decryption overhead (~1-2ms per batch of messages)

### Recommendation

**Use Option C (Hybrid with BYOK) as the platform default.** BYOK is a hard requirement for enterprise tenants.

**Layer 1 (Disk-Level, always on):**

- ClickHouse encrypted disk (AES-256-CTR) with platform-managed key
- Cold tier: S3 SSE-KMS / Azure SSE / GCS CMEK with per-tenant keys
- Protects all data at the storage layer — covers compliance baselines (SOC 2, GDPR)

**Layer 2 (Application-Level BYOK, per-tenant):**

- `content` column encrypted with tenant's own key via `BYOKClickHouseClient`
- `content_key_version` tracks key version for rotation
- PII scrubbing via application-level batch job (not ClickHouse TTL SET)
- Enterprise tenants provide their key via KMS integration (AWS KMS, Azure Key Vault, GCP Cloud KMS, or HashiCorp Vault)

**For non-enterprise tenants** (FREE, TEAM plans): the platform manages the encryption key in its own vault. The same `BYOKClickHouseClient` code path is used — the only difference is who controls the key. This keeps the code path uniform.

**Do NOT use Option B alone.** Wrapping the entire ClickHouse client with field-level encryption on ALL columns defeats ClickHouse's purpose. Only the `content` column (and potentially `data` in traces) should be BYOK-encrypted. All metadata columns must remain unencrypted for query, filter, aggregate, and TTL operations.

---

## Gap 3: PII Token Retention — Separate Collection vs Unified Retention

### Problem

The current architecture has:

1. **PII detection at ingestion** — `pii-detector.ts` scans messages for email, phone, SSN, credit card, IP address using regex + Luhn validation
2. **Redacted content stored in messages** — the `content` field in ClickHouse stores the already-redacted version (e.g., `"My card is [REDACTED_CREDIT_CARD]"`)
3. **`hasPII` flag on message** — boolean indicating PII was detected
4. **Separate PII retention window** — `piiRetentionDays` in `RetentionPolicy` (can differ from general `retentionDays`)
5. **ClickHouse TTL SET rule** — after 14 days, rewrites `content` to `[PII_EXPIRED]` and sets `scrubbed = true`

The question: if `content` is already redacted at ingestion, and the original PII tokens (the actual credit card numbers, emails, etc.) are stored in a separate collection, do we need:

- A separate PII token collection at all?
- A separate retention job for PII vs general messages?

### Solution Summary

Remove the separate PII retention window. Original PII is never persisted — `pii-detector.ts` redacts at ingestion. The ClickHouse `content` column already contains `[REDACTED_*]` labels, not actual PII. No separate scrub job needed. If a future requirement demands storing original PII tokens, use a MongoDB `pii_tokens` collection with TTL index (auto-deletes, no job).

### Current State

| What                        | Where                                                                             | Retention                                          |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Redacted message content    | ClickHouse `messages.content`                                                     | General message TTL (90 days hot → 2 years delete) |
| `hasPII` / `scrubbed` flags | ClickHouse `messages`                                                             | Same as message row                                |
| Original PII tokens         | **Nowhere** — `pii-detector.ts` returns `detections[]` but they are not persisted | N/A                                                |
| PII redaction labels        | Inline in content (e.g., `[REDACTED_CREDIT_CARD]`)                                | Same as message content                            |

Key finding: **The original PII values are not stored anywhere.** The `pii-detector.ts:detectPII()` function returns `{ hasPII, detections, redacted }` but only the `redacted` string is persisted. The `detections` array (containing actual PII values, positions, and types) is used transiently during processing and then discarded.

### Analysis

Given that original PII tokens are **not persisted**, the current ClickHouse TTL SET rule that rewrites `content` to `[PII_EXPIRED]` after 14 days is doing this:

```
Day 0:  content = "My card is [REDACTED_CREDIT_CARD], call me at [REDACTED_PHONE]"
Day 14: content = "[PII_EXPIRED]"
```

This destroys the redacted message text — which contains **no actual PII** (only redaction labels). The only value of this TTL rule is:

- Removing the **surrounding context** that might reveal what was redacted (e.g., "My card is \_\_\_" implies financial data)
- Reducing storage for old messages (content becomes a short fixed string)

### Proposed Solution

#### If PII Tokens Are NOT Stored Separately (Current State)

**Simplify: remove the separate PII retention window.** Since original PII is never persisted, there's nothing to scrub. The redacted content is safe to keep for the full message retention period.

Modify the ClickHouse TTL to remove the PII SET rule:

```sql
-- Before (current proposal):
TTL
    timestamp + INTERVAL 14 DAY
        GROUP BY organization_id, conversation_id, timestamp
        SET content = if(has_pii, '[PII_EXPIRED]', content),
            scrubbed = if(has_pii, true, scrubbed),
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 730 DAY DELETE

-- After (simplified):
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 730 DAY DELETE
```

Remove from `RetentionPolicy`:

- `piiRetentionDays` — no longer needed
- `scrubPIIBatch()` — no longer needed
- `findMessagesWithPIIOlderThan()` — no longer needed

**Pros:**

- Simpler architecture — one retention window per data type, not two
- No content rewriting — preserves conversation replay quality
- The `hasPII` flag still exists for filtering/auditing

**Cons:**

- Redacted message text is available for longer (but contains no actual PII)
- Surrounding context might hint at PII type (minor risk)

#### If PII Tokens SHOULD Be Stored Separately (New Requirement)

If the business requires storing original PII tokens (e.g., for dispute resolution — "what credit card number did the customer provide?"), create a separate PII token collection:

```javascript
// Collection: pii_tokens (MongoDB — encrypted, short-lived)
{
  _id: String,
  organizationId: String,
  conversationId: String,
  messageId: String,             // References ClickHouse message
  runId: String,                 // References the run that processed this message

  tokens: [
    {
      type: String,              // 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address'
      encryptedValue: String,    // AES-256-GCM encrypted original value
      redactionLabel: String,    // '[REDACTED_CREDIT_CARD]'
      position: { start: Number, end: Number },
    }
  ],

  detectedAt: Date,
  expiresAt: Date,               // MongoDB TTL index — auto-deletes
}

// Indexes
{ expiresAt: 1 }                                    // MongoDB TTL index (auto-delete)
{ organizationId: 1, conversationId: 1 }            // Lookup by conversation
{ organizationId: 1, messageId: 1 }                 // Lookup by message
```

**Retention**: MongoDB TTL index on `expiresAt` auto-deletes PII tokens. `expiresAt` is set based on the organization's `piiRetentionDays`:

```
FREE plan:       expiresAt = detectedAt + 7 days
TEAM plan:       expiresAt = detectedAt + 30 days
PCI-DSS:         expiresAt = detectedAt + 0 days (immediate — don't store at all)
```

**No separate retention job needed** — MongoDB TTL index handles deletion automatically (similar to ClickHouse TTL but for this small collection).

### Recommendation

**Use the simplified approach (no separate PII storage)** unless there is a concrete business requirement to access original PII values after the conversation ends. The current `pii-detector.ts` already strips PII before persistence — this is the correct default behavior.

If a specific customer requires PII access for dispute resolution, add the `pii_tokens` collection with MongoDB TTL index per that customer's deployment. This is a per-tenant opt-in, not a platform default.

Either way, **remove the separate PII retention job** from the retention scheduler. Retention is either:

- Handled by ClickHouse TTL (for messages, traces, logs, metrics)
- Handled by MongoDB TTL index (for pii_tokens, if they exist)
- Handled by the simplified retention scheduler (for conversation metadata in MongoDB)

---

## Gap 4: Session Analytics — MongoDB-only Sessions Limit Analytics Queries

### Problem

The current architecture places conversations (sessions) in **MongoDB only**. For transactional operations (create, update status, lookup by ID) this is ideal. But for analytics queries, MongoDB is inefficient:

| Analytics Query                               | MongoDB Approach                                                 | Problem                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Average session duration per day              | `aggregate([{$match}, {$group}, {$project}])` across 1M docs/day | Full collection scan or index-assisted scan — slow at scale                     |
| Sessions by channel (voice/chat/sms) per hour | `$group` by channel + hour                                       | Scatter-gather on sharded cluster                                               |
| Returning vs new users (by contactId)         | `$group` by contactId, `$match` on count > 1                     | Requires scanning entire collection — O(N)                                      |
| Session status distribution over time         | `$group` by status + time bucket                                 | No columnar optimization — reads entire document for each group                 |
| P95 session duration by agent                 | Sort + percentile on `endedAt - startedAt`                       | No native percentile function — requires `$setWindowFields` or application-side |
| Week-over-week session volume trends          | Two `$group` aggregations with date arithmetic                   | Repeated full scans                                                             |

These queries are acceptable at development scale (hundreds of sessions), but at production scale (1M sessions/day, 30M in the 30-day window) they become impractical without dedicated analytical infrastructure.

### Solution Summary

Two options — **Option A**: Materialized views on the existing `messages` table (no new collection, derives session metrics from message data already flowing into ClickHouse). **Option B**: Separate `session_events` table with explicit lifecycle events. Option A is simpler and avoids dual-write; Option B is richer (captures escalation, disposition, voice metadata) but requires application-level event emission. MongoDB remains source of truth for session state in both cases.

### Proposed Solution

#### Option A: Materialized Views on Messages Table (Recommended)

Since messages are already written to ClickHouse, session analytics can be **derived** from that data without a new table. The `messages` table already has `organization_id`, `conversation_id`, `contact_id`, `channel`, `role`, and `timestamp` — enough to compute session volume, duration, message counts, and user metrics.

**Materialized Views:**

```sql
-- Hourly session metrics derived from messages
CREATE MATERIALIZED VIEW session_metrics_hourly
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (organization_id, channel, hour)
AS SELECT
    organization_id,
    channel,
    toStartOfHour(timestamp)                        AS hour,

    -- Session volume (count distinct conversations with first message in this hour)
    uniqState(conversation_id)                       AS sessions,

    -- Message volume
    count()                                          AS total_messages,
    countIf(role = 'user')                           AS user_messages,
    countIf(role = 'assistant')                      AS assistant_messages,

    -- User metrics
    uniqStateIf(contact_id, contact_id IS NOT NULL)  AS unique_contacts,

    -- Duration proxy: time between first and last message per conversation
    -- (use raw table query for precise duration — see below)

    minState(timestamp)                              AS earliest_message,
    maxState(timestamp)                              AS latest_message

FROM messages
GROUP BY organization_id, channel, hour;


-- Daily rollup
CREATE MATERIALIZED VIEW session_metrics_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (organization_id, channel, day)
AS SELECT
    organization_id,
    channel,
    toStartOfDay(timestamp)                          AS day,

    uniqState(conversation_id)                       AS sessions,
    count()                                          AS total_messages,
    countIf(role = 'user')                           AS user_messages,
    countIf(role = 'assistant')                      AS assistant_messages,
    uniqStateIf(contact_id, contact_id IS NOT NULL)  AS unique_contacts

FROM messages
GROUP BY organization_id, channel, day;
```

**Session duration & per-session analytics** (queried on raw messages table):

```sql
-- Session duration distribution (P50, P95, P99) — last 7 days
SELECT
    organization_id,
    quantile(0.50)(duration) AS p50_seconds,
    quantile(0.95)(duration) AS p95_seconds,
    quantile(0.99)(duration) AS p99_seconds
FROM (
    SELECT
        organization_id,
        conversation_id,
        dateDiff('second', min(timestamp), max(timestamp)) AS duration
    FROM messages
    WHERE timestamp >= now() - INTERVAL 7 DAY
    GROUP BY organization_id, conversation_id
)
GROUP BY organization_id;

-- Returning vs new users (contacts with >1 conversation)
SELECT
    organization_id,
    toStartOfDay(first_seen) AS day,
    countIf(conv_count = 1) AS new_users,
    countIf(conv_count > 1) AS returning_users
FROM (
    SELECT
        organization_id,
        contact_id,
        min(timestamp) AS first_seen,
        uniq(conversation_id) AS conv_count
    FROM messages
    WHERE contact_id IS NOT NULL
      AND timestamp >= now() - INTERVAL 30 DAY
    GROUP BY organization_id, contact_id
)
GROUP BY organization_id, day;
```

**Pros:**

- No new table, no additional writes — zero operational overhead
- Session metrics stay in sync automatically as messages are written
- Simpler architecture — one source of truth for message data

**Cons:**

- Cannot capture session-level events that don't produce messages (escalation, abandonment, disposition)
- Duration is approximated as first-to-last message gap (not precise startedAt/endedAt)
- Voice metadata (call duration, caller number) not available in messages table
- Per-session queries (duration, P95) require scanning raw messages — slower than pre-aggregated events

---

#### Option B: Separate Session Events Table

For richer analytics — escalation tracking, disposition codes, voice metrics, precise duration — a dedicated `session_events` table captures lifecycle transitions explicitly.

```sql
CREATE TABLE session_events (
    organization_id     String,
    conversation_id     String,
    contact_id          Nullable(String),
    project_id          String,

    channel             LowCardinality(String),
    environment         LowCardinality(String),
    agent_name          LowCardinality(String),

    event_type          LowCardinality(String),    -- 'started', 'ended', 'escalated',
                                                   -- 'transferred', 'abandoned', 'archived'

    -- Populated on 'ended' event
    duration_seconds    Nullable(UInt32),
    message_count       Nullable(UInt16),
    llm_call_count      Nullable(UInt16),
    tool_call_count     Nullable(UInt16),
    handoff_count       Nullable(UInt8),
    status              LowCardinality(String),
    disposition         Nullable(String),

    -- Voice-specific
    call_duration       Nullable(UInt32),
    caller_number       Nullable(String),

    -- User identity
    is_identified       Bool DEFAULT false,
    is_returning        Bool DEFAULT false,

    timestamp           DateTime64(3),

    INDEX idx_contact contact_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_event event_type TYPE set(10) GRANULARITY 4
) ENGINE = ReplicatedMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (organization_id, timestamp, conversation_id)
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192;
```

Events are emitted at session lifecycle transitions (not by polling):

```
Session created  → INSERT (event_type='started', channel, agent_name, ...)
Session ended    → INSERT (event_type='ended', duration_seconds, message_count, disposition, ...)
Session escalated → INSERT (event_type='escalated', ...)
```

Materialized views on `session_events` (hourly/daily rollups) power sub-second dashboard queries.

**Pros:**

- Captures escalation, abandonment, disposition — richer analytics
- Precise duration (from application, not message gap approximation)
- Voice metadata available
- Pre-aggregated views for all metrics — sub-second response

**Cons:**

- New table + application-level dual-write (MongoDB session state + ClickHouse event)
- More operational complexity

---

#### Comparison

| Metric                          | Option A (MV on messages)           | Option B (session_events table)         |
| ------------------------------- | ----------------------------------- | --------------------------------------- |
| New tables                      | 0                                   | 1                                       |
| Additional writes               | 0                                   | ~2-3M events/day                        |
| Session volume                  | Yes (via `uniq(conversation_id)`)   | Yes (via `count(event_type='started')`) |
| Message counts                  | Yes (native)                        | Yes (populated at session end)          |
| Duration (P50/P95)              | Approximate (first-to-last message) | Precise (application-computed)          |
| Escalation/abandonment tracking | No                                  | Yes                                     |
| Voice metrics                   | No                                  | Yes                                     |
| Disposition/outcome codes       | No                                  | Yes                                     |
| Returning user analytics        | Yes                                 | Yes                                     |
| Complexity                      | Low                                 | Medium                                  |

**Recommendation**: Start with **Option A** — it's zero-cost and covers the most common analytics needs. Add Option B later if escalation tracking, voice analytics, or precise disposition reporting becomes a requirement.

#### What Stays in MongoDB

MongoDB remains the **source of truth** for session state in both options:

| Operation                          | Database       | Reason                                 |
| ---------------------------------- | -------------- | -------------------------------------- |
| Create conversation                | MongoDB        | Needs indexed lookup, status updates   |
| Update status (active → completed) | MongoDB        | Transactional update                   |
| Lookup by conversationId           | MongoDB        | Single-document read                   |
| Archive old conversations          | MongoDB        | Status flip                            |
| **Analytics dashboards**           | **ClickHouse** | Materialized views (Option A or B)     |
| **Returning user metrics**         | **ClickHouse** | `uniq(contact_id)` across time ranges  |
| **Session duration distribution**  | **ClickHouse** | `quantile()` on columnar data          |
| **Channel breakdowns**             | **ClickHouse** | `GROUP BY` on `LowCardinality` columns |

---

## Summary

Option D (MongoDB + ClickHouse) is the best architecture for the platform. These four additional concerns have the following proposed solutions:

| Concern                  | Proposed Solution                                                                                                                                                                                                                    | Complexity   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **1. Runs**              | New `runs` collection in MongoDB + per-session Redis lock for sequential processing                                                                                                                                                  | Medium       |
| **2. Encryption (BYOK)** | Disk-level encryption (AES-256-CTR) for all data + per-tenant BYOK on `content` column via `BYOKClickHouseClient`. Accept ~8x storage on content. Cloud-native SSE for cold tier.                                                    | High         |
| **3. PII Retention**     | Remove separate PII retention. PII is redacted at ingestion — original tokens are not persisted. One unified retention window per data type.                                                                                         | Low          |
| **4. Session Analytics** | **Option A (recommended)**: Materialized views on existing `messages` table — no new collection. **Option B**: Separate `session_events` table for richer analytics (escalation, voice, disposition). Start with A, add B if needed. | Low / Medium |
