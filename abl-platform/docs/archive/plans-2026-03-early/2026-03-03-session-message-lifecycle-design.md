# Session & Message Lifecycle — Design Document

**Date:** 2026-03-03
**Updated:** 2026-03-04
**Status:** Draft (v2 — post-review)
**Scope:** Session lifecycle management, context vs message separation, message retention, PII/GDPR erasure, contact context, conversation history retrieval, trace observability
**Builds on:** [Channel Identity & Contact](./2026-02-18-channel-identity-contact-design.md), [Dual-Write Policy](../db/DUAL_WRITE_POLICY.md), [Session Identity Design](../design/SESSION_IDENTITY_DESIGN.md)

---

## Problem

Five independent gaps, each with compliance or product risk:

1. **Sessions never close themselves** — no idle timeout enforcement in Redis. `sessionMaxAgeSeconds` exists in `TenantSecurityConfig` and is wired through `session-factory.ts` to `computeEffectiveTtl()` to Redis TTL, but there is no **idle timeout** — a session with no activity sits in Redis until `maxAgeSeconds` expires or Redis evicts it. No `timeout` or `unengaged` disposition exists.

2. **Message retention is hardcoded** — `MESSAGE_TTL_DAYS = 90` in `mongo-message-store.ts:11` applies to every tenant on every plan regardless of contractual commitment. `PLAN_LIMITS` has `sessionRetentionDays` but no `messageRetentionDays`.

3. **PII/GDPR erasure is incomplete** — `contact_id` is hardcoded to `''` in ClickHouse writes (`clickhouse-message-store.ts:90`). `hasPII` is detected in `message-persistence-queue.ts` via `containsPII()` but dropped before the DB write. Encryption is per-tenant only — no per-contact key material. `CascadeDeleteContact` use case (`contexts/contact/use-cases/cascade-delete-contact.ts`) only deletes the contact document; it does not scrub messages in MongoDB or ClickHouse.

4. **Conversation history is partially unencrypted in Redis** — `ENCRYPTED_FIELDS` covers `authToken`, `state`, `dataValues`, `callerContext`, `customDimensions` but the `conv` Redis LIST (raw user messages) and `threads` JSON field (agent thread conversation history) are stored in plaintext.

5. **No contact context** — each session starts from zero. The Contact model has `metadata` but no `context` subdocument for cross-session memory.

---

## Current State

### Session Lifecycle

| Mechanism           | Today                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Max session age     | `sessionMaxAgeSeconds` in `TenantSecurityConfig` (FREE=3600, TEAM=28800, BUSINESS=28800, ENTERPRISE=86400). Wired via `session-factory.ts` then `resolveSessionMaxAge()` then `computeEffectiveTtl()` then Redis EXPIRE. |
| Idle timeout        | **None** — no sliding TTL on activity. Redis TTL only tracks max age.                                                                                                                                                    |
| Dispositions        | `completed`, `abandoned`, `error` — no `timeout`, no `unengaged`                                                                                                                                                         |
| In-memory reaper    | `runtime-executor.ts:reapStaleSessions()` evicts sessions from pod-local `Map` based on `maxAgeSeconds`. Persists to Redis before removal. Runs on `STALE_SESSION_CHECK_INTERVAL_MS` timer.                              |
| MongoDB cleanup job | `session-cleanup-job.ts` deletes terminal sessions (`completed`, `ended`, `abandoned`, `error`) past `sessionRetentionDays`. Archives to local NDJSON before deletion. Does NOT sweep active sessions.                   |
| Status enum         | `active`, `idle`, `ended`, `completed`, `escalated`, `abandoned`, `archived`                                                                                                                                             |
| Disposition field   | Separate nullable `disposition` string on session model                                                                                                                                                                  |
| Storage             | **Redis** = ephemeral working state (hash + conv LIST, TTL-based). **MongoDB** = source of truth for lifecycle. **ClickHouse** = no session table (messages/traces/metrics only).                                        |

### Message Retention

| Item                                     | Today                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL                                      | `MESSAGE_TTL_DAYS = 90` hardcoded in `mongo-message-store.ts:11`                                                                               |
| `messageRetentionDays` in `TenantLimits` | Missing — only `sessionRetentionDays` exists                                                                                                   |
| Project-level override                   | Not implemented                                                                                                                                |
| Archive on expiry                        | Local filesystem NDJSON via `session-cleanup-job.ts` (not S3). `ArchiveManifest` model tracks metadata.                                        |
| ClickHouse dual-write                    | WS handler: gated by `USE_MONGO_CLICKHOUSE` env. SDK handler: per-tenant `_chMessageStores` Map cache. HTTP path: always writes. Inconsistent. |
| ClickHouse native TTL                    | 30d to warm volume, 90d to cold volume (S3-backed), 730d to DELETE. Self-managing.                                                             |

### PII & GDPR

| Item                                | Today                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact_id` in ClickHouse messages | Hardcoded `''` at `clickhouse-message-store.ts:90`                                                                                                                                      |
| `contact_id` in MongoDB messages    | **Field does not exist** on `IMessage` schema (`message.model.ts`)                                                                                                                      |
| `hasPII` propagation                | Detected in `message-persistence-queue.ts:342` via `containsPII()`, stored in `MessageJobData.hasPII`, **never written** to either store                                                |
| `scrubbed` field                    | Schema exists on both MongoDB and ClickHouse, never set                                                                                                                                 |
| `scrubMessages()` method            | Does not exist                                                                                                                                                                          |
| Encryption granularity              | Per-tenant AES-256-GCM via `EncryptionService` (PBKDF2-derived tenant key from master). No per-contact key material.                                                                    |
| `CascadeDeleteContact`              | Use case at `contexts/contact/use-cases/cascade-delete-contact.ts`. Only: load contact then clean resolution keys then hard-delete contact doc then audit. **Does NOT touch messages.** |
| Redis `conv` LIST encryption        | None — raw PII in plaintext                                                                                                                                                             |
| `threads` field encryption          | Not in `ENCRYPTED_FIELDS` (currently: `authToken`, `state`, `dataValues`, `callerContext`, `customDimensions`)                                                                          |

### Contact Resolution (Existing)

| Item                            | Today                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session-creation resolution     | `InitializeSession` use case: resolves contact if `identityTier >= 2` OR `providerVerified`. Links via `LinkSessionToContact`.                                 |
| Mid-session identity promotion  | `PromoteAndLink` use case: verifies identity then resolves/creates contact then links session then enqueues `BackLinkSessions` + `DetectMergeCandidates` jobs. |
| Cross-channel linking           | `SwitchChannel` use case: resolves contact on new channel then loads previous session context then links.                                                      |
| Back-linking anonymous sessions | `BackLinkSessions` BullMQ job: finds sessions matching `channelArtifact` hash then updates their `contactId`.                                                  |
| Anonymous users (tier 0-1)      | `anonymousId` set on `CallerContext`. No contact resolved. No `contactId` on session or messages.                                                              |
| contactId flow to messages      | **Broken** — `AddMessageParams` has no `contactId` field. MongoDB messages have no `contactId`. ClickHouse hardcodes `''`.                                     |

### Contact Context

| Item                                      | Today                                       |
| ----------------------------------------- | ------------------------------------------- |
| Cross-session memory                      | None                                        |
| Contact model                             | Has `metadata` but no `context` subdocument |
| Session pre-population from prior contact | Not implemented                             |
| Context promotion on session close        | Not implemented                             |

### Trace Observability

| Item                                     | Today                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Message content in traces                | NOT stored (main path only stores `contentLength`)                               |
| `decision.contextSnapshot`               | Full `dataValues` dump — PII-bearing, large                                      |
| `handoff.context` / `escalation.context` | Same — full `dataValues`                                                         |
| EventStore analytics dual-write          | Raw `storedEvent.data` — no scrubbing                                            |
| `scrubPII` default                       | `false` (opt-in). Handler.ts hardcodes `scrubPII: true` for individual emitters. |

### Tenant Config Duplication

| Item                  | Today                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime tenant-config | `apps/runtime/src/services/tenant-config.ts` — full async resolution, Redis cache, DB load, project overrides. Has `archiveRetentionDays`, `archiveEnabled`, `advancedNlu`.                           |
| Studio tenant-config  | `apps/studio/src/services/tenant-config.ts` — sync only, no DB/Redis, read-only copy of plan defaults. Missing `archiveRetentionDays`, `archiveEnabled`, `advancedNlu`.                               |
| Retention scheduler   | `apps/studio/src/services/retention/retention-service.ts` — has its own `PLAN_RETENTION` constants (separate from `PLAN_LIMITS`), including `messages.retentionDays` and `messages.piiRetentionDays`. |

---

## Decisions (v2)

| #   | Decision                                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Keep `sessionMaxAgeSeconds`** in `TenantSecurityConfig`. Do NOT add `sessionMaxAgeHours` to `TenantLimits`.                                                                                          | Field already exists and is wired through session-factory.ts then computeEffectiveTtl(). Adding a parallel field creates conflicts.                                                                                                                      |
| D2  | **Add `sessionIdleSeconds`** to `TenantSecurityConfig` (alongside `sessionMaxAgeSeconds`).                                                                                                             | Idle timeout is a security concern (like max age), not a resource limit. Keeps the config surface consistent.                                                                                                                                            |
| D3  | **Sliding Redis idle TTL** — set Redis EXPIRE to `min(sessionIdleSeconds, remainingMaxAge)` on every `touch()`.                                                                                        | Makes Redis self-cleaning for idle sessions. MongoDB reaper is backup safety net, not primary mechanism.                                                                                                                                                 |
| D4  | **Drop S3 archive**. ClickHouse cold tier (S3-backed) is sufficient for long-term analytics.                                                                                                           | ClickHouse already has hot to warm to cold to DELETE TTL. Session cleanup job just deletes from MongoDB; no separate archive needed.                                                                                                                     |
| D5  | **Tenant encryption + per-contact HKDF salt** (not full per-contact DEK).                                                                                                                              | Lighter than ContactDEKManager + contact_keys collection. HKDF(tenantKey, contactSalt) derives per-contact key. On GDPR delete: delete salt so ClickHouse data becomes undecryptable.                                                                    |
| D6  | **Anonymous sessions (tier 0-1): session-scoped erasure only**.                                                                                                                                        | No contactId so messages erasable by sessionId only. If user later promotes to tier 2, BackLinkSessions job updates contactId on linked sessions. GDPR right-to-erasure requires identity proof; anonymous users cannot prove they are the data subject. |
| D7  | **Merge tenant config to runtime** — Studio imports from runtime's `tenant-config.ts` (or extract to shared package).                                                                                  | Eliminates drift between two copies. Runtime version is the authoritative source with async resolution.                                                                                                                                                  |
| D8  | **`scrubPII` default: `true` for new tenants, `false` for existing** (feature-flagged).                                                                                                                | Flipping globally breaks observability for all existing tenants. Gate behind `ENABLE_STRICT_PII_MODE` env var for first release; default `true` only for tenants created after the flag date.                                                            |
| D9  | **No LLM summarization in Phase 2** — `ContactContext.summary` is populated by a simple extractive summary (last N dataValues + disposition), not an LLM call. LLM summarization deferred to Phase 3+. | No LLM summarization infrastructure exists today. Introducing a runtime LLM dependency for session close is a significant new concern (credential resolution, token budget, fallback).                                                                   |

---

## Requirements

### Session Lifecycle

1. Every session must have an idle timeout derived from `TenantSecurityConfig.sessionIdleSeconds`
2. Every session must have a maximum age derived from existing `TenantSecurityConfig.sessionMaxAgeSeconds`
3. Redis TTL must be a sliding window: `min(sessionIdleSeconds, remainingMaxAge)`, refreshed on every `touch()`
4. Timeout and unengaged sessions must be dispositioned distinctly via the existing `disposition` field
5. API callers (SDK, REST) must be able to close sessions with explicit disposition
6. Long-running sessions (>24h) must remain valid for ENTERPRISE plan (`sessionMaxAgeSeconds: 86_400`)
7. Project-level overrides must be configurable to shorten (but not exceed) plan limits
8. MongoDB reaper must sweep active sessions that Redis evicted without a clean close (safety net)
9. The three reaper mechanisms (in-memory, Redis TTL, MongoDB sweep) must be documented and non-conflicting

### Message Retention

1. `messageRetentionDays` must be plan-driven: FREE=30, TEAM=90, BUSINESS=365, ENTERPRISE=730
2. `expiresAt` must be computed from plan config at write time, never hardcoded
3. Project-level retention must be configurable (can only shorten, not extend, plan max)
4. ClickHouse handles its own retention natively (30d warm, 90d cold, 730d delete) — no application-level ClickHouse purge needed
5. ClickHouse dual-write must be symmetric across all write paths (HTTP + WebSocket + SDK)
6. MongoDB archive replaced by ClickHouse cold tier — drop local NDJSON archive, simplify cleanup job to delete-only

### PII & GDPR Erasure

1. Every ClickHouse message row must carry `contact_id` (or empty for anonymous)
2. `contactId` must be added to MongoDB `IMessage` schema + `AddMessageParams` interface
3. `hasPII` must flow from detection then `AddMessageParams` then MongoDB field then ClickHouse field
4. `scrubMessages(tenantId, contactId)` must redact content in-place and set `scrubbed=true`
5. `CascadeDeleteContact` must be extended with message-scrub and ClickHouse-cleanup ports
6. Per-contact HKDF salt on Contact model — `encryptionSalt: string` field
7. Anonymous sessions (tier 0-1): erasable by sessionId only; no contact-level encryption
8. Redis `conv` LIST entries must be encrypted per-entry with backward-compat `enc:` prefix
9. `threads` must be added to `ENCRYPTED_FIELDS`
10. `scrubPII` default `true` for new tenants; feature-flagged for existing (`ENABLE_STRICT_PII_MODE`)

### Contact Context

1. A slim context bag must persist per contact across sessions (tier 2+ only)
2. Session start must pre-populate agent dataValues from contact context (Redis-cached)
3. Session close must promote final dataValues to contact context (async, BullMQ)
4. Promotion must be gated by disposition: promote on `completed`/`escalated`, skip on `abandoned`/`timeout`/`unengaged`
5. ABL DSL must expose `CONTEXT.inject` and `CONTEXT.promote` directives

### Conversation History

1. `GET /sessions/:id/messages` with cursor-based pagination (`before=<id>&limit=20`)
2. `recall_history` tool for agents (keyword search in MongoDB)
3. `GET /contacts/:id/history` for cross-session contact history (tier 2+ contacts only)

---

## Architecture

### 1. Session Lifecycle — Three-Layer TTL

```
 Layer 1: Redis Sliding Idle TTL (PRIMARY)
 EXPIRE = min(sessionIdleSeconds, remainingMaxAge)
 Refreshed on every touch() / message / tool call
 Self-cleaning: idle session expires without external action

 Layer 2: In-Memory Reaper (runtime-executor.ts)
 Evicts sessions from pod-local Map when maxAgeSeconds exceeded
 Persists to Redis before removal (best-effort)
 Runs on STALE_SESSION_CHECK_INTERVAL_MS timer

 Layer 3: MongoDB Reaper — Safety Net (session-cleanup-job.ts)
 Pass 1 (existing): delete terminal sessions past retention
 Pass 2 (new): sweep 'active' sessions that missed their close
 Catches sessions that Redis evicted silently (OOM, restart)
 Runs every CLEANUP_INTERVAL_MINUTES (default: 60)
```

**Disposition rules** (using existing `disposition` field on session model):

- `completed` — explicit API close with `disposition=completed`
- `abandoned` — customer disconnected, no further turns within idle window
- `escalated` — handoff to human agent
- `timeout` (NEW) — idle window exceeded (had message turns)
- `unengaged` (NEW) — session age exceeded with zero message turns (bot, crawler, etc.)

**Per-plan idle timeout** — added to existing `TenantSecurityConfig`:

```typescript
// apps/runtime/src/services/tenant-config.ts — TenantSecurityConfig
export interface TenantSecurityConfig {
  // existing:
  allowedServiceDomains: string[];
  requireMtls: boolean;
  ipAllowlist: string[];
  requireMfa: boolean;
  sessionMaxAgeSeconds: number; // FREE=3600, TEAM=28800, BUSINESS=28800, ENTERPRISE=86400
  apiKeyMaxAgeDays: number;
  // new:
  sessionIdleSeconds: number; // FREE=600, TEAM=1800, BUSINESS=3600, ENTERPRISE=7200
}
```

**Redis sliding idle TTL** — extend `computeEffectiveTtl()` in `redis-session-store.ts`:

```typescript
// redis-session-store.ts — replace existing computeEffectiveTtl
private computeEffectiveTtl(
  createdAt: number,
  maxAgeSeconds?: number,
  idleSeconds?: number,
): number {
  // 1. Compute remaining max-age lifetime (existing logic)
  let effectiveTtl = this.sessionTtlSeconds;
  if (maxAgeSeconds) {
    const elapsedSeconds = (Date.now() - createdAt) / 1000;
    const remainingLifetime = maxAgeSeconds - elapsedSeconds;
    effectiveTtl = Math.max(0, Math.min(effectiveTtl, Math.ceil(remainingLifetime)));
  }

  // 2. Cap by idle timeout (new — sliding window)
  if (idleSeconds && idleSeconds > 0) {
    effectiveTtl = Math.min(effectiveTtl, idleSeconds);
  }

  return effectiveTtl;
}
```

Every `touch()`, `saveSession()`, and `appendConversation()` call already refreshes the Redis EXPIRE via `computeEffectiveTtl()`. Adding `idleSeconds` makes the TTL shrink to the idle window on each refresh — if no activity comes, Redis expires the key automatically.

**`sessionIdleSeconds` must be threaded** through:

1. `session-factory.ts:resolveSessionMaxAge()` — also resolve idle seconds from config
2. `SessionData.idleSeconds?: number` field (alongside existing `maxAgeSeconds`)
3. `redis-session-store.ts` reads it from session data

**MongoDB reaper Pass 2** — in `session-cleanup-job.ts`:

```typescript
// Pass 2 (new): sweep active sessions that Redis evicted without close
// Uses sessionIdleSeconds and sessionMaxAgeSeconds from tenant config
const tenantConfig = await configService.getConfigAsync(tenantId);
const idleSeconds = tenantConfig.security.sessionIdleSeconds;
const maxAgeSeconds = tenantConfig.security.sessionMaxAgeSeconds;

const idleCutoff = new Date(Date.now() - idleSeconds * 1000);
const ageCutoff = new Date(Date.now() - maxAgeSeconds * 1000);

// Batch via cursor, not toArray()
const cursor = SessionModel.find({
  tenantId,
  status: 'active',
  $or: [{ lastActivityAt: { $lt: idleCutoff } }, { createdAt: { $lt: ageCutoff } }],
}).cursor({ batchSize: 100 });

for await (const session of cursor) {
  const disposition = session.messageCount === 0 ? 'unengaged' : 'timeout';
  await SessionModel.findOneAndUpdate(
    { _id: session._id, tenantId, status: 'active' }, // idempotent: status guard
    { status: 'ended', disposition, endedAt: new Date() },
  );
}
```

**Compound index** (already exists for session queries):

```javascript
{ tenantId: 1, status: 1, lastActivityAt: 1 }
```

---

### 2. Message Retention

**Add `messageRetentionDays` to `TenantLimits`** in `apps/runtime/src/services/tenant-config.ts`:

```typescript
// TenantLimits — add field
messageRetentionDays: number; // FREE=30, TEAM=90, BUSINESS=365, ENTERPRISE=730

// PLAN_LIMITS — add values
FREE:       { ..., messageRetentionDays: 30 },
TEAM:       { ..., messageRetentionDays: 90 },
BUSINESS:   { ..., messageRetentionDays: 365 },
ENTERPRISE: { ..., messageRetentionDays: 730 },
```

**Wire `messageRetentionDays` to `expiresAt` at write time:**

```typescript
// mongo-message-store.ts — replace hardcoded MESSAGE_TTL_DAYS = 90
const config = await getTenantConfigService().getConfigAsync(tenantId);
const retentionDays = config.limits.messageRetentionDays;
const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
```

**Retention resolution hierarchy:**

```
project.messageRetentionDays  (if set, must be <= tenant limit)
  | fallback
tenant.retentionOverrides.messageRetentionDays  (if set, must be <= plan max)
  | fallback
PLAN_LIMITS[plan].messageRetentionDays
```

**ClickHouse message lifecycle — native TTL (no application management needed):**

ClickHouse `messages` table already has (from `clickhouse-schemas/init.ts`):

```sql
TTL toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',   -- cold = S3
    toDateTime(created_at) + INTERVAL 730 DAY DELETE
```

This is self-managing. Cold volume is S3-backed (`cold_s3` disk in `storage.xml`). No application-level ClickHouse purge or S3 archive needed.

**Drop local NDJSON archive** — simplify `session-cleanup-job.ts`:

- Remove `archiveBatch()` and local filesystem writes
- Remove `ArchiveManifest` creation
- Remove `purgeExpiredArchives()` pass
- Cleanup job becomes: find terminal sessions past retention then delete sessions then delete orphaned messages

**DualWriteMessageStore** — consolidate the 3 ad-hoc ClickHouse instantiations:

```typescript
// store-factory.ts — new wrapper
class DualWriteMessageStore implements MessageStore {
  private chCache = new Map<string, ClickHouseMessageStore>();

  constructor(
    private mongo: MongoMessageStore,
    private chFactory: (tenantId: string) => ClickHouseMessageStore,
  ) {}

  async addMessage(params: AddMessageParams): Promise<Message> {
    const msg = await this.mongo.addMessage(params);
    // fire-and-forget; never blocks the caller
    const tenantId = params.tenantId || 'default';
    this.getOrCreateChStore(tenantId)
      .addMessage(params)
      .catch((err) => log.error('ClickHouse message write failed', { err }));
    return msg;
  }

  private getOrCreateChStore(tenantId: string): ClickHouseMessageStore {
    let store = this.chCache.get(tenantId);
    if (!store) {
      if (this.chCache.size >= MAX_CLICKHOUSE_STORE_CACHE) {
        const oldest = this.chCache.keys().next().value;
        if (oldest !== undefined) this.chCache.delete(oldest);
      }
      store = this.chFactory(tenantId);
      this.chCache.set(tenantId, store);
    }
    return store;
  }
}
```

**Key**: `ClickHouseMessageStore` requires `tenantId` at construction (used for `compressAndEncryptForTenant()`). The wrapper maintains a per-tenant cache, matching the existing pattern in `sdk-handler.ts:242-265`. All three call sites (HTTP handler, WS handler, SDK handler) use the same `DualWriteMessageStore` from `store-factory.ts`.

---

### 3. PII & GDPR Erasure

#### Encryption Strategy: Tenant Key + Per-Contact HKDF Salt

```
ENCRYPTION_MASTER_KEY (env var, 32-byte hex)
      |
      v  PBKDF2(masterKey, `tenant:${tenantId}`)
Tenant Key  (cached in EncryptionService.TenantKeyCache, 30min TTL)
      |
      v  HKDF(tenantKey, contactSalt)           <-- NEW
Per-Contact Derived Key  (computed on demand, not stored)
```

**No new collection, no DEK manager, no LRU cache for keys.** The per-contact key is derived deterministically from the tenant key + a random salt stored on the contact document. Crypto-shredding = delete the salt.

**Contact model change** — add `encryptionSalt` to existing `Contact` interface:

```typescript
// contexts/contact/domain/contact.ts — add field
export interface Contact {
  // existing fields...
  encryptionSalt: string; // 32-byte random hex, generated at contact creation
}
```

Generated in `ResolveOrCreateContact.execute()` via `crypto.randomBytes(32).toString('hex')`.

**Anonymous users (tier 0-1):** No contact resolved, no salt, messages encrypted with tenant key only. Erasure is by sessionId (delete session, messages orphaned, cleaned by retention TTL). This is acceptable because:

- GDPR right-to-erasure requires the requestor to prove identity (Article 12)
- Anonymous users cannot prove they are the data subject
- Messages age out via `messageRetentionDays` TTL regardless

**contactId plumbing** — thread contactId from session to message writes:

1. Add `contactId?: string` to `AddMessageParams` in `packages/compiler/src/platform/stores/message-store.ts`
2. Add `contactId?: string` to `IMessage` schema in `packages/database/src/models/message.model.ts`
3. Add index `{ tenantId: 1, contactId: 1, timestamp: -1 }` for contact-scoped queries and GDPR scrub
4. Add `contactId` param to `persistMessage()` in `message-persistence-queue.ts`
5. Thread from `state.callerContext.contactId` in WS/SDK handlers to `persistMessage()` call

**hasPII plumbing** — propagate from queue to stores:

1. Add `hasPII?: boolean` to `AddMessageParams` (compiler package)
2. In `message-persistence-queue.ts` processor: pass `hasPII` to `store.addMessage({ ..., hasPII })`
3. In `MongoMessageStore.addMessage()`: write `hasPII` field (schema field already exists, just not populated)
4. In `ClickHouseMessageStore.addMessage()`: write `has_pii: params.hasPII ? 1 : 0` (was: hardcoded `0`)

**ClickHouse contact_id** — `clickhouse-message-store.ts:90`:

```typescript
// Before:
contact_id: '',

// After:
contact_id: params.contactId || '',
```

**`scrubMessages()` — new method on `MongoMessageStore`:**

```typescript
async scrubMessages(tenantId: string, contactId: string): Promise<number> {
  const result = await MessageModel.updateMany(
    { tenantId, contactId, scrubbed: { $ne: true } },
    { $set: { content: '[REDACTED]', scrubbed: true, scrubbedAt: new Date() } },
  );
  return result.modifiedCount;
}

// Session-scoped variant for anonymous users
async scrubMessagesBySession(tenantId: string, sessionId: string): Promise<number> {
  const result = await MessageModel.updateMany(
    { tenantId, sessionId, scrubbed: { $ne: true } },
    { $set: { content: '[REDACTED]', scrubbed: true, scrubbedAt: new Date() } },
  );
  return result.modifiedCount;
}
```

**Extended `CascadeDeleteContact` flow:**

The existing `CascadeDeleteContact` use case at `contexts/contact/use-cases/cascade-delete-contact.ts` needs new ports:

```typescript
export class CascadeDeleteContact {
  constructor(
    private readonly repo: ContactRepository,
    private readonly onAudit: AuditCallback,
    private readonly resolutionKeyCleanup?: ResolutionKeyCleanup,
    // NEW ports:
    private readonly scrubMessages?: (tenantId: string, contactId: string) => Promise<number>,
    private readonly clickhouseCleanup?: (tenantId: string, contactId: string) => Promise<void>,
  ) {}

  async execute(tenantId: string, contactId: string): Promise<DeleteResult> {
    const contact = await this.repo.findById(tenantId, contactId);
    if (!contact) {
      return { success: false, error: { code: 'CONTACT_NOT_FOUND', message: '...' } };
    }

    // 1. Clean up resolution keys (existing)
    await this.resolutionKeyCleanup?.(tenantId, contactId);

    // 2. Scrub MongoDB messages (NEW)
    const scrubbed = (await this.scrubMessages?.(tenantId, contactId)) ?? 0;

    // 3. ClickHouse cleanup (NEW) — crypto-shred by deleting contact salt
    //    Contact.encryptionSalt is deleted with the contact doc (step 4).
    //    ClickHouse data encrypted with HKDF(tenantKey, salt) becomes unreadable.
    //    Also queue ALTER TABLE UPDATE for eventual scrub marking:
    await this.clickhouseCleanup?.(tenantId, contactId);

    // 4. Hard-delete contact (existing — also deletes encryptionSalt)
    await this.repo.hardDelete(tenantId, contactId);

    // 5. Emit audit event (existing, extended)
    await this.onAudit({
      action: 'contact.hard_deleted',
      tenantId,
      contactId,
      identityCount: contact.identities.length,
      sessionCount: contact.sessionCount,
      scrubbedMessageCount: scrubbed,
      timestamp: new Date(),
    });

    return { success: true };
  }
}
```

**ClickHouse cleanup implementation:**

```typescript
// ClickHouse mutation — async, runs in background
async function clickhouseContactCleanup(tenantId: string, contactId: string): Promise<void> {
  await clickhouseClient.query({
    query: `ALTER TABLE abl_platform.messages
            UPDATE scrubbed = 1, content = '[REDACTED]'
            WHERE tenant_id = {tenantId:String}
            AND contact_id = {contactId:String}`,
    query_params: { tenantId, contactId },
  });
}
```

Note: ClickHouse `ALTER TABLE UPDATE` is an async mutation. Combined with crypto-shredding (salt deleted so HKDF-derived key irrecoverable so existing encrypted content unreadable), this provides defense-in-depth. The mutation is best-effort cleanup; the crypto-shredding is the primary GDPR mechanism.

---

### 4. Redis PII Hardening

**`conv` LIST entry encryption** — backward-compatible `enc:` prefix:

```typescript
// redis-session-store.ts — on write (appendConversation, createSession)
const encoded = `enc:${await this.encryptionService.encryptForTenant(
  JSON.stringify(message),
  tenantId,
)}`;
await redis.rpush(convKey, encoded);

// on read (loadSession, getConversation)
const raw = await redis.lrange(convKey, 0, -1);
const messages = await Promise.all(
  raw.map(
    async (entry) =>
      entry.startsWith('enc:')
        ? JSON.parse(await this.encryptionService.decryptForTenant(entry.slice(4), tenantId))
        : JSON.parse(entry), // backward compat for pre-migration entries
  ),
);
```

**Note on Lua script compatibility:** The existing `LUA_APPEND_CONV` Lua script trims the conversation list by index position (preserving index 0 as the system message). Encrypted entries don't change this behavior — the script operates on LIST indices, not content. During rolling deploy, the list may contain mixed plaintext and `enc:` entries; the read path handles both.

**`threads` field** — add to `ENCRYPTED_FIELDS`:

```typescript
// redis-session-store.ts — currently:
const ENCRYPTED_FIELDS = ['authToken', 'state', 'dataValues', 'callerContext', 'customDimensions'];

// change to:
const ENCRYPTED_FIELDS = [
  'authToken',
  'state',
  'dataValues',
  'callerContext',
  'customDimensions',
  'threads',
];
```

**Size consideration:** `threads` contains `AgentThreadData[]` with per-agent `conversationHistory`, `state`, and `dataValues`. For multi-agent sessions this can be large. AES-GCM encryption is hardware-accelerated (~0.1ms per operation), but the serialized JSON size should be monitored. Phase 3 adds gzip compression for fields > 1KB.

**`scrubPII` default** — feature-flagged rollout:

```typescript
// tenant-config.ts — TenantSecurityConfig
export interface TenantSecurityConfig {
  // existing fields...
  scrubPII: boolean;  // NEW — controls trace PII scrubbing
}

// DEFAULT_SECURITY — new tenants get true, existing get false
// Controlled by ENABLE_STRICT_PII_MODE env var
const strictPiiMode = process.env.ENABLE_STRICT_PII_MODE === 'true';

FREE:       { ..., scrubPII: strictPiiMode },
TEAM:       { ..., scrubPII: strictPiiMode },
BUSINESS:   { ..., scrubPII: true },         // BUSINESS+ always scrub
ENTERPRISE: { ..., scrubPII: true },
```

---

### 5. Contact Context

**`contactContext` subdocument on Contact model:**

```typescript
// contexts/contact/domain/contact.ts — add to Contact interface
interface ContactContext {
  preferences: Record<string, unknown>; // language, channel, communication_style
  dataValues: Record<string, unknown>; // collected fields (account_type, tier, etc.)
  lastDisposition: string; // disposition of most recent session
  lastInteraction: Date;
  sessionCount: number;
  updatedAt: Date;
}
```

Note: `summary` field deferred — requires LLM summarization infrastructure that does not exist today. Phase 3+ will add it with a platform LLM key for internal operations.

**Session start pre-population** (tier 2+ contacts only):

```typescript
// runtime-executor.ts — on session create, after contact resolution
if (callerContext.contactId && callerContext.identityTier >= 2) {
  const ctx = await contactContextService.get(tenantId, callerContext.contactId);
  if (ctx) {
    session.dataValues = { ...ctx.dataValues, ...session.dataValues }; // session wins
    session.callerContext.contactContext = ctx;
  }
}
```

**Session close promotion (BullMQ, non-blocking):**

```typescript
// session-close-handler.ts — after session status update
const PROMOTE_DISPOSITIONS = new Set(['completed', 'escalated']);

if (contactId && PROMOTE_DISPOSITIONS.has(disposition)) {
  await contactContextQueue.add('promote', {
    tenantId,
    contactId,
    sessionId,
    dataValues: session.dataValues,
    disposition,
  });
}
```

**Mid-session contact linking** — existing `PromoteAndLink` use case already handles identity verification then contact creation then session linking. The new addition: after `PromoteAndLink` succeeds, **backfill contactId on messages** already persisted for this session:

```typescript
// After PromoteAndLink returns contactId:
await MessageModel.updateMany(
  { tenantId, sessionId, contactId: { $exists: false } },
  { $set: { contactId } },
);
```

This ensures messages sent before identity promotion are also linked to the contact.

**ABL DSL directives** (Phase 3):

```yaml
CONTEXT:
  inject: [account_type, preferred_language, tier]
  promote: [resolution_status, satisfaction_score]
```

---

### 6. Conversation History Retrieval

**`GET /sessions/:id/messages`** — cursor-based pagination:

```
GET /sessions/sess-123/messages?before=msg-456&limit=20
Response: { messages: [...], nextCursor: "msg-101", hasMore: true }
```

Uses `uuidv7` message IDs (lexicographically sortable by time) — efficient `_id < cursor` index scan, no `skip`.

**`recall_history` agent tool:**

```typescript
recall_history({ query: 'what did the customer say about billing', limit: 5 });
// Returns: [{ role, content, timestamp, sessionId }]
```

Backed by MongoDB text index on `messages.content` scoped to `{ tenantId, contactId }`.

**`GET /contacts/:id/history`** — cross-session timeline (tier 2+ only):

```
GET /contacts/contact-789/history?limit=5&before=sess-456
Response: { sessions: [{ id, startedAt, disposition, messageCount }] }
```

---

### 7. Trace Cleanup

**Remove `contextSnapshot` full-value dumps:**

```typescript
// Before (trace-emitter.ts):
interface DecisionEvent {
  contextSnapshot: Record<string, unknown>; // full dataValues
}

// After:
interface DecisionEvent {
  contextMeta: {
    keysEvaluated: string[]; // field names only, no values
    sessionId: string;
    turnCount: number;
  };
}
```

Same pattern for `handoff.context` and `escalation.context`.

**Scrub EventStore analytics dual-write** (trace-emitter.ts):

```typescript
// Before:
bridge.emitTraceEventAsAnalytics(storedEvent.data);

// After:
const safeData = scrubObjectValues(storedEvent.data);
bridge.emitTraceEventAsAnalytics(safeData);
```

Uses existing `scrubSecrets()` from `packages/compiler/src/platform/constructs/executors/sanitizer-middleware.ts` + `redactPII()` from `pii-detector.ts`.

---

### 8. Tenant Config Consolidation

**Current state:** Two independent copies of `TenantConfigService` with drifting types.

| Field                  | Runtime               | Studio         |
| ---------------------- | --------------------- | -------------- |
| `archiveRetentionDays` | Yes                   | Missing        |
| `archiveEnabled`       | Yes                   | Missing        |
| `advancedNlu`          | Yes                   | Missing        |
| Async resolution       | Yes (Redis + MongoDB) | No (sync only) |

**Plan:** Move shared types and plan defaults to runtime's `tenant-config.ts` as the single source of truth. Studio imports:

```typescript
// apps/studio/src/services/tenant-config.ts — replace with re-export
export {
  type Plan,
  type TenantLimits,
  type TenantFeatures,
  type TenantSecurityConfig,
  type TenantConfig,
  PLAN_LIMITS,
  PLAN_FEATURES,
  TenantConfigService,
  getTenantConfigService,
} from '@agent-platform/runtime/services/tenant-config';
```

If cross-app import is problematic, extract to `packages/config/src/tenant-config.ts` (shared package). Runtime and Studio both import from there. The async `getConfigAsync()` / `loadFromDB()` methods stay in the runtime service layer.

**Retention scheduler alignment:** `apps/studio/src/services/retention/retention-service.ts` has its own `PLAN_RETENTION` constant. Must be aligned with `PLAN_LIMITS.messageRetentionDays` after the new field is added. Long-term: derive `PLAN_RETENTION` from `PLAN_LIMITS`.

---

## Data Flow Summary

```
Concern              MongoDB                           Redis                             ClickHouse
---                  ---                               ---                               ---
Session lifecycle    Source of truth. Reaper Pass 2    Sliding idle TTL + max age cap.   No session table. N/A.
                     sweeps active sessions past       Self-cleaning on idle timeout.
                     idle/max-age cutoff (safety net)  Refreshed on every touch().

Message retention    expiresAt field, plan-driven TTL  Entries live until session         Native TTL: 30d warm, 90d cold
                     via messageRetentionDays.         expires (idle or max-age).         (S3), 730d DELETE. Self-managing.

GDPR erasure         scrubMessages() redacts content   Session data removed when TTL      Crypto-shred: delete contact
(tier 2+ contact)    in-place by contactId.            expires or session closes.         encryptionSalt so HKDF-derived
                                                                                          key irrecoverable. Async ALTER
                                                                                          UPDATE scrubbed=1 for defense.

GDPR erasure         scrubMessagesBySession() redacts  Same — TTL-based cleanup.          No contact salt. Data encrypted
(anonymous tier<2)   by sessionId on request.                                             with tenant key only. Ages out
                                                                                          via 730d native TTL.

Authoritative?       Source of truth for lifecycle     Ephemeral working state with       Analytics/audit store (messages,
                     and message content.              PII encryption at rest.            traces, metrics). S3-backed cold
                                                                                          tier for long-term retention.
```

---

## Implementation Sequence

### Phase 1 — Compliance & Lifecycle (1 sprint)

| #   | Change                                                                                             | Files (actual paths)                                                                                                                                                                | Risk   | Notes                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | Add `sessionIdleSeconds` to `TenantSecurityConfig` + `DEFAULT_SECURITY`                            | `apps/runtime/src/services/tenant-config.ts`                                                                                                                                        | Low    | FREE=600, TEAM=1800, BUSINESS=3600, ENTERPRISE=7200                                                           |
| 2   | Thread `idleSeconds` through `SessionData` then `session-factory.ts` then `redis-session-store.ts` | `apps/runtime/src/services/session/types.ts`, `apps/runtime/src/channels/pipeline/session-factory.ts`, `apps/runtime/src/services/session/redis-session-store.ts`                   | Medium | Extend `computeEffectiveTtl()` to accept `idleSeconds`. Every `touch()`/`save()` already refreshes EXPIRE.    |
| 3   | Add `timeout` + `unengaged` disposition values                                                     | `packages/database/src/models/session.model.ts`                                                                                                                                     | Low    | Disposition is already a nullable string — no schema migration needed.                                        |
| 4   | MongoDB reaper Pass 2 in `session-cleanup-job.ts`                                                  | `apps/runtime/src/services/session-cleanup-job.ts`                                                                                                                                  | Medium | Sweep active sessions past idle/max-age cutoff. Uses existing compound index. Batch via cursor.               |
| 5   | Add `messageRetentionDays` to `TenantLimits` + `PLAN_LIMITS`                                       | `apps/runtime/src/services/tenant-config.ts`                                                                                                                                        | Low    | FREE=30, TEAM=90, BUSINESS=365, ENTERPRISE=730                                                                |
| 6   | Wire `messageRetentionDays` to `expiresAt` at write time                                           | `apps/runtime/src/services/stores/mongo-message-store.ts`                                                                                                                           | Low    | Replace hardcoded `MESSAGE_TTL_DAYS = 90`. Resolve from `TenantConfigService.getConfigAsync()`.               |
| 7   | Add `contactId` + `hasPII` to `AddMessageParams`                                                   | `packages/compiler/src/platform/stores/message-store.ts`                                                                                                                            | Low    | Shared interface — both fields optional. Cross-package change.                                                |
| 8   | Add `contactId` to `IMessage` schema + index                                                       | `packages/database/src/models/message.model.ts`                                                                                                                                     | Low    | New field + index `{ tenantId: 1, contactId: 1, timestamp: -1 }`.                                             |
| 9   | Propagate `contactId` from `callerContext` through `persistMessage()` to stores                    | `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`                                      | Medium | Thread `state.callerContext.contactId` through all `persistMessage()` call sites.                             |
| 10  | Propagate `hasPII` from queue processor to stores                                                  | `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/services/stores/mongo-message-store.ts`, `apps/runtime/src/services/stores/clickhouse-message-store.ts` | Low    | `hasPII` already detected in queue; pass to `addMessage()`. Write to MongoDB `hasPII` + ClickHouse `has_pii`. |
| 11  | Write `contact_id` in ClickHouse message rows                                                      | `apps/runtime/src/services/stores/clickhouse-message-store.ts`                                                                                                                      | Low    | Change line 90 from `''` to `params.contactId` or `''`.                                                       |
| 12  | Add `threads` to `ENCRYPTED_FIELDS`                                                                | `apps/runtime/src/services/session/redis-session-store.ts`                                                                                                                          | Low    | One-line change. Monitor serialized size in production.                                                       |
| 13  | Trim `contextSnapshot` / `handoff.context` to key names only                                       | `apps/runtime/src/services/trace-emitter.ts`                                                                                                                                        | Low    | Replace `contextSnapshot: Record` with `contextMeta: { keysEvaluated, sessionId, turnCount }`.                |
| 14  | Scrub EventStore analytics dual-write                                                              | `apps/runtime/src/services/trace-emitter.ts`                                                                                                                                        | Low    | Wrap `storedEvent.data` with existing `scrubSecrets()` + `redactPII()` before analytics emit.                 |

### Phase 2 — GDPR & Encryption (2 sprints)

| #   | Change                                                                      | Files (actual paths)                                                                                   | Risk   | Notes                                                                                                                                        |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | Add `encryptionSalt` to Contact model                                       | `apps/runtime/src/contexts/contact/domain/contact.ts`, `packages/database/src/models/contact.model.ts` | Low    | 32-byte random hex. Generated in `ResolveOrCreateContact.execute()`.                                                                         |
| 16  | HKDF key derivation helper in `EncryptionService`                           | `packages/shared/src/services/encryption-service.ts`                                                   | Medium | `deriveContactKey(tenantId, contactSalt): Buffer` using HKDF-SHA256.                                                                         |
| 17  | ClickHouse message encryption with per-contact derived key (tier 2+)        | `apps/runtime/src/services/stores/clickhouse-message-store.ts`                                         | Medium | If `contactId` present: derive key via HKDF(tenantKey, salt). Else: use tenant key (anonymous).                                              |
| 18  | `scrubMessages()` + `scrubMessagesBySession()` on MongoMessageStore         | `apps/runtime/src/services/stores/mongo-message-store.ts`                                              | Low    | updateMany with `{ content: '[REDACTED]', scrubbed: true, scrubbedAt: new Date() }`.                                                         |
| 19  | Extend `CascadeDeleteContact` with message-scrub + ClickHouse-cleanup ports | `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`                                | Medium | Add `scrubMessages` and `clickhouseCleanup` ports. Wire in factory.                                                                          |
| 20  | ClickHouse contact cleanup (async ALTER UPDATE scrubbed=1)                  | `apps/runtime/src/services/stores/clickhouse-message-store.ts`                                         | Medium | Async mutation. Primary erasure is crypto-shred (salt deletion).                                                                             |
| 21  | `DualWriteMessageStore` wrapper — consolidate 3 ad-hoc ClickHouse writes    | `apps/runtime/src/services/stores/store-factory.ts`                                                    | Medium | Per-tenant ClickHouse store cache (matching existing `sdk-handler.ts` pattern). Remove dual-write logic from `handler.ts`, `sdk-handler.ts`. |
| 22  | Redis `conv` LIST per-entry encryption (`enc:` prefix)                      | `apps/runtime/src/services/session/redis-session-store.ts`                                             | Medium | Backward compat: read path checks `enc:` prefix. Rolling deploy safe. Lua trim script unaffected (index-based).                              |
| 23  | `scrubPII` in `TenantSecurityConfig` + feature-flagged default              | `apps/runtime/src/services/tenant-config.ts`                                                           | Low    | BUSINESS+ always true. FREE/TEAM: controlled by `ENABLE_STRICT_PII_MODE` env.                                                                |
| 24  | Project-level `messageRetentionDays` field + retention resolver             | `packages/database/src/models/project.model.ts`, `apps/runtime/src/services/tenant-config.ts`          | Low    | Project override can only shorten, not extend plan max.                                                                                      |
| 25  | Drop local NDJSON archive from cleanup job                                  | `apps/runtime/src/services/session-cleanup-job.ts`                                                     | Low    | Remove `archiveBatch()`, `purgeExpiredArchives()`. Simplify to delete-only. ClickHouse cold tier (S3) covers long-term.                      |
| 26  | Backfill contactId on messages after mid-session `PromoteAndLink`           | `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`                                | Low    | `MessageModel.updateMany({ tenantId, sessionId, contactId: null }, { $set: { contactId } })`                                                 |

### Phase 3 — Contact Context & Product (2 sprints)

| #   | Change                                                                        | Files (actual paths)                                                                                       | Risk   | Notes                                                                                                                        |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 27  | `contactContext` subdocument on Contact model                                 | `apps/runtime/src/contexts/contact/domain/contact.ts`, `packages/database/src/models/contact.model.ts`     | Low    | `preferences`, `dataValues`, `lastDisposition`, `lastInteraction`, `sessionCount`, `updatedAt`. No `summary` yet (deferred). |
| 28  | `ContactContextService` with Redis 5min cache                                 | New: `apps/runtime/src/services/contact-context-service.ts`                                                | Medium | `get(tenantId, contactId)` from Redis cache then MongoDB fallback. `invalidate(tenantId, contactId)`.                        |
| 29  | Session start pre-population from contact context (tier 2+ only)              | `apps/runtime/src/services/runtime-executor.ts` or `apps/runtime/src/channels/pipeline/session-factory.ts` | Medium | After contact resolution in `InitializeSession`, load context and merge into `dataValues`.                                   |
| 30  | Session close promotion via BullMQ                                            | New: `apps/runtime/src/services/session-close-handler.ts`                                                  | Medium | Gated by disposition: promote on `completed`/`escalated`. Enqueue to existing BullMQ infrastructure.                         |
| 31  | ABL DSL `CONTEXT.inject` + `CONTEXT.promote` directives                       | `packages/compiler/`                                                                                       | High   | New compiler constructs. Deferred if compiler bandwidth is tight.                                                            |
| 32  | Redis session state compression (gzip fields > 1KB)                           | `apps/runtime/src/services/session/redis-session-store.ts`                                                 | Medium | Compress `threads`, `dataValues` before encrypt. Backward compat via prefix detection.                                       |
| 33  | `GET /sessions/:id/messages` cursor pagination                                | `apps/runtime/src/routes/sessions.ts`                                                                      | Low    | uuidv7 cursor, `_id < cursor` index scan.                                                                                    |
| 34  | `recall_history` agent tool                                                   | New tool in `packages/compiler/`                                                                           | Medium | MongoDB text index on `messages.content` scoped to `{ tenantId, contactId }`. Contact-scoped by default.                     |
| 35  | `GET /contacts/:id/history` cross-session endpoint                            | `apps/runtime/src/routes/`                                                                                 | Low    | Query sessions by contactId. Tier 2+ contacts only.                                                                          |
| 36  | Tenant config consolidation — Studio imports from runtime (or shared package) | `apps/studio/src/services/tenant-config.ts`, `apps/runtime/src/services/tenant-config.ts`                  | Low    | Eliminate duplicate. Align `PLAN_RETENTION` with `PLAN_LIMITS`.                                                              |
| 37  | Conversation summarization (LLM-based, plan-gated, feature flag)              | New service                                                                                                | High   | Deferred. Requires platform LLM key, token budget, fallback strategy.                                                        |

---

## Performance & Scale Notes

### Redis Sliding Idle TTL

- `computeEffectiveTtl()` already runs on every session save/touch — adding `idleSeconds` is a single `Math.min()` call, zero additional latency
- Default `sessionTtlMinutes=30` (config) acts as an upper bound — `idleSeconds` cannot exceed the configured Redis TTL
- If `sessionIdleSeconds=600` (FREE plan), Redis EXPIRE is set to 600s after each message. If no message for 10 min, Redis auto-expires. No reaper needed.
- MongoDB reaper Pass 2 only catches edge cases: Redis restart, OOM eviction, pod crash before TTL refresh

### Stale Session Reaper Coordination

| Mechanism             | What it catches                                             | Frequency                                | Side effects                                          |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Redis idle TTL        | Sessions with no activity past `idleSeconds`                | Continuous (TTL-based)                   | Key disappears. No MongoDB update.                    |
| In-memory reaper      | Pod-local Map entries past `maxAgeSeconds`                  | `STALE_SESSION_CHECK_INTERVAL_MS`        | Persists to Redis first, then evicts from Map.        |
| MongoDB reaper Pass 2 | Sessions still `active` in MongoDB after Redis expired them | `CLEANUP_INTERVAL_MINUTES` (default: 60) | Sets `status=ended`, `disposition=timeout/unengaged`. |

Non-conflicting: Redis TTL is primary; in-memory reaper handles pod-local Map hygiene; MongoDB reaper is the authoritative lifecycle closer.

### DualWriteMessageStore

- ClickHouse write is fire-and-forget — never adds latency to the caller
- Failure logged, not surfaced to end user (MongoDB is source of truth)
- ClickHouse backpressure: uses existing `BufferedClickHouseWriter` (10K rows / 5s flush)
- Per-tenant store cache bounded by `MAX_CLICKHOUSE_STORE_CACHE` (LRU eviction)

### Per-Contact HKDF Key Derivation

- HKDF-SHA256 is ~0.01ms per derivation (no iteration like PBKDF2)
- No cache needed — derive on demand from tenant key (already cached) + contact salt (on params)
- Anonymous messages (no contactId) skip HKDF — use tenant key directly (existing path)
- On GDPR delete: salt is deleted with the contact doc. No cache invalidation needed.

### Redis Conversation Encryption

- Per-entry encrypt adds ~0.1ms per message push (AES-GCM is hardware-accelerated)
- Backward compat via `enc:` prefix check on read — no migration needed for existing entries
- Lua trim script (`LUA_APPEND_CONV`) operates on LIST indices, not content — unaffected by encryption

### Contact Context Promotion

- BullMQ worker is async — does not block session close response
- Contact context update is `findOneAndUpdate($set)` — O(1), indexed by `contactId`
- Redis cache TTL 5min: promotion then cache invalidation then next session sees new context within 5min

---

## Resolved Questions

1. ~~**Contact DEK storage**~~ Resolved (D5): HKDF(tenantKey, contactSalt). No separate key storage. Salt on Contact document.

2. **Conversation summarization trigger**: Deferred to Phase 3+. Phase 2 contact context uses extractive summary (last N dataValues + disposition). LLM summarization requires platform infrastructure that doesn't exist yet.

3. **Project-level retention floor**: Yes — projects may set `messageRetentionDays=7` on a BUSINESS plan (365). Projects can have stricter compliance requirements than the plan default.

4. **`recall_history` tool scope**: Contact-scoped by default. Tenant-scoped requires explicit agent permission.

5. ~~**scrubPII default flip**~~ Resolved (D8): Feature-flagged via `ENABLE_STRICT_PII_MODE`. BUSINESS+ always true. FREE/TEAM controlled by env var.

6. ~~**S3 archive**~~ Resolved (D4): Dropped. ClickHouse cold tier is S3-backed. Simplify cleanup job to delete-only.

7. ~~**Anonymous users**~~ Resolved (D6): Session-scoped erasure only. No contact-level encryption for tier 0-1. Messages age out via retention TTL.

8. ~~**Redis TTL gap**~~ Resolved (D3): Sliding idle TTL via extended `computeEffectiveTtl()`. Redis is self-cleaning.

## Open Questions

1. **Tenant config extraction**: Should shared types live in `packages/config/` (new) or in `apps/runtime/` with Studio importing? Cross-app imports may be problematic with Turbo build ordering.

2. **ClickHouse per-contact HKDF**: Should ClickHouse messages for tier 2+ contacts be re-encrypted with the HKDF-derived key, or continue using tenant key with crypto-shredding via salt deletion only? Re-encryption adds a contact salt lookup to every ClickHouse write. Salt-deletion-only is simpler but relies on the attacker not having cached the derived key.

3. **MongoDB message contactId backfill**: For existing messages with no contactId, should we run a one-time migration (join messages.sessionId to sessions.contactId) or accept that pre-migration messages are contact-unlinkable?
