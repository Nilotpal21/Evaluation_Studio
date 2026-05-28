# High-Level Design: Contacts Management

> **Feature:** #49 Contacts Management
> **Status:** ALPHA
> **Last Updated:** 2026-03-23
> **Feature Spec:** `docs/features/contacts.md`
> **Test Spec:** `docs/testing/contacts.md`

---

## 1. Overview

The Contacts Management system provides a unified identity resolution, lifecycle management, and GDPR-compliant data handling layer for the ABL platform. It tracks end-users across sessions, channels, and identity types with field-level PII encryption, blind-index-based search, and cross-session context persistence.

### Design Goals

1. **Identity resolution in constant time** -- O(1) blind index lookup on encrypted identities
2. **Strict tenant isolation** -- Every query scoped by tenantId, cross-tenant returns 404
3. **GDPR compliance** -- Right to erasure via cascade delete with crypto-shredding
4. **Cross-session context** -- Persisted preferences survive session boundaries
5. **Merge without data loss** -- Identity deduplication, channel history union, session reassignment

---

## 2. Architecture

### 2.1 Component Diagram

```
+--------------------------------------------+
|             HTTP Layer (Express)            |
|  contacts.ts | contact-merge.ts | merge-   |
|  (CRUD)      | (merge/GDPR)     | suggest  |
+--------+----------+----------+-------------+
         |          |          |
+--------v----------v----------v-------------+
|           Use Case Layer                    |
|  ResolveOrCreate | ExecuteMerge | SelfMerge |
|  LinkSession     | CascadeDelete| Detect    |
|  Merge Candidates                           |
+--------+----------+----------+-------------+
         |          |          |
+--------v----------v----------v-------------+
|    Domain Layer (pure types & interfaces)   |
|  Contact | ContactIdentity | MergeSuggest  |
|  ContactRepository (port)                   |
+--------+----------+----------+-------------+
         |          |          |
+--------v----------v----------v-------------+
|          Infrastructure Layer               |
|  ContactMongoRepository | MergeSuggestion  |
|  MongoStore | ContactContextService (Redis) |
|  EncryptionService | AuditHelpers          |
+---------+---------+---------+--------------+
          |         |         |
     +----v---+ +---v---+ +--v-----------+
     |MongoDB | |Redis  | |ClickHouse    |
     |contacts| |cache  | |(analytics)   |
     +--------+ +-------+ +--------------+
```

### 2.2 Layer Responsibilities

| Layer          | Responsibility                                                   | Infrastructure Dependencies |
| -------------- | ---------------------------------------------------------------- | --------------------------- |
| HTTP (Route)   | Request validation, auth, RBAC, rate limiting, response envelope | Express, auth middleware    |
| Use Case       | Business logic orchestration, encryption calls, audit emission   | None (ports only)           |
| Domain         | Types, interfaces, validation rules                              | None                        |
| Infrastructure | MongoDB queries, Redis cache, encryption engine, audit store     | Mongoose, ioredis, crypto   |

### 2.3 Bounded Context

The Contact bounded context follows hexagonal architecture:

- **Inbound ports**: Use case classes (ResolveOrCreateContact, ExecuteMerge, etc.)
- **Outbound ports**: ContactRepository interface, AuditCallback, SessionReassigner
- **Adapters**: ContactMongoRepository, MergeSuggestionMongoStore, EncryptionService

The context is wired via `createContactContext()` factory which injects all dependencies at the composition root (server.ts startup).

---

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

**Approach:** Every MongoDB query includes `tenantId` in the filter. The `tenantIsolationPlugin` on the Mongoose schema enforces this at the model level. Cross-tenant access returns 404 (not 403) to avoid leaking resource existence.

**Enforcement Points:**

- ContactMongoRepository: all methods accept tenantId as first parameter
- Route handlers: extract tenantId from `req.tenantContext`
- MongoContactStore: passes tenantId to all queries
- Blind indexes: tenant-scoped (different tenants produce different indexes for same value)

**Gap:** `MongoContactStore.delete()` and `touchLastSeen()` use `findByIdAndUpdate` without tenantId -- must be fixed.

### 3.2 Authentication and Authorization

**Approach:** `authMiddleware` on all contact routes validates JWT tokens and populates `req.tenantContext`. Write operations (create, update, delete, link-session, history) require `agent:execute` permission via `requirePermissionInline`. Read operations (query, lookup, get-by-id) require only authentication.

**Gap:** Contact merge and GDPR routes only check `tenantContext` presence, not RBAC permissions. These should require admin-level permissions.

### 3.3 Data Model and Schema

**MongoDB Collection:** `contacts` with UUIDv7 primary keys.

**Schema Evolution Strategy:**

- `_v` field for document versioning
- Legacy flat `identity`/`identityType` fields retained alongside new `identities` array
- Migration `20260305_009` backfills `contactId` on messages

**Compound Indexes:**

- `{ tenantId: 1, 'identities.blindIndex': 1 }` for O(1) identity resolution
- `{ tenantId: 1, lastSeenAt: -1 }` for recency-sorted queries
- `{ tenantId: 1, type: 1 }` for type-filtered queries

### 3.4 Encryption and Privacy

**Field-Level Encryption:**

- AES-256-GCM with tenant-scoped HKDF-derived keys
- Random 16-byte IV per encryption (no ciphertext reuse)
- Per-contact encryption salt for HKDF key derivation

**Blind Indexes:**

- HMAC-SHA256 with tenant-scoped blind key
- Deterministic: same tenant + same value = same index
- Tenant-isolated: different tenants produce different indexes

**Crypto-Shredding:**

- GDPR delete nullifies `encryptionSalt`, rendering all encrypted data for that contact unrecoverable
- Defense-in-depth: salt nullification precedes hard-delete

**Identity Normalization:**

- Email: lowercase, trimmed
- Phone: digits and leading + only
- Normalization happens before encryption and blind index generation

### 3.5 Caching

**Contact Context Cache (Redis):**

- Key format: `ctx:<tenantId>:<contactId>`
- TTL: 300 seconds (5 minutes)
- Pattern: fail-open (Redis failure falls through to MongoDB)
- Write-through: `update()` writes to DB then invalidates cache
- Stale window: up to 5 minutes if cache invalidation fails

**No contact record caching:** Contact CRUD queries go directly to MongoDB. The compound indexes provide sufficient performance for typical query patterns.

### 3.6 Performance

**Query Performance:**

- Blind index lookup: compound index `{ tenantId, identities.blindIndex }` for single-document resolution
- Paginated queries: `skip(offset).limit(limit)` with compound index on `{ tenantId, lastSeenAt }` for cursor-free pagination
- Contact history: cursor-based pagination on `{ tenantId, contactId, timestamp }` compound index

**Batch Operations:**

- Message backfill migration: 100 sessions per batch with cursor-based pagination
- GDPR cascade: sequential operations (resolution key cleanup -> message scrub -> ClickHouse cleanup -> salt nullification -> hard-delete)

**Size Bounds:**

- `contactContext`: 64 KB max (validated by Mongoose custom validator)
- `tags`: max 50 items, each max 50 characters
- `displayName`: max 200 characters

### 3.7 Error Handling

**Use Case Layer:** Returns `{ success: boolean, error?: { code, message } }` discriminated union. Never throws for business logic failures (not-found, validation errors).

**Route Layer:** Catches all exceptions, returns structured JSON error responses with appropriate HTTP status codes. Currently uses `console.error` (GAP-03, should use `createLogger`).

**Infrastructure Layer:** Audit failures are non-critical (fire-and-forget with catch). Redis failures fall through to MongoDB (fail-open). ClickHouse cleanup failures are caught and logged, do not block GDPR delete.

### 3.8 Audit and Traceability

**Structured Audit Events:**

- `contact.created` -- new contact registered
- `contact.updated` -- fields modified (with before/after diff)
- `contact.deleted` -- soft-delete initiated
- `contact.hard_deleted` -- GDPR cascade completed (with identityCount, sessionCount, scrubbedMessageCount)
- `contact.merged` -- two contacts merged (with identitiesMoved count)
- `contact.self_merged` -- self-merge triggered
- `contact.identity_added` -- new identity added to existing contact
- `contact.session_linked` -- session associated with contact

**Implementation:** Two audit pathways:

1. `auditContactCreated/Updated/Deleted/Linked` helpers write to AuditStore (14-field structured records)
2. `ContactAuditEmitter` interface for domain-level events from use cases

### 3.9 Observability

**Logging:** `createLogger('contacts-route')` and `createLogger('contact-context-service')` for structured logging. Gaps in merge routes (use `console.error`).

**Metrics Gaps:** No Prometheus metrics for contact operations, cache hit/miss rates, or merge execution durations. Should be added.

### 3.10 Scalability

**Horizontal Scaling:**

- Stateless route handlers (no pod-local state)
- Redis for shared cache state
- MongoDB for durable storage with replica set support

**Scaling Concerns:**

- Merge suggestions query has no pagination (could return unbounded results for large tenants)
- Skip/offset pagination for contact queries is O(N) for deep pages -- consider cursor-based pagination

### 3.11 Reliability

**Graceful Degradation:**

- Redis cache: fail-open to MongoDB
- ClickHouse cleanup: failure does not block GDPR delete
- Audit: failure does not block primary operations
- Contact linking: errors caught and logged, never blocks session initialization

**GDPR Delete Ordering:**

1. Resolution key cleanup (optional, before hard-delete)
2. Message scrubbing
3. ClickHouse cleanup (wrapped in try/catch)
4. Encryption salt nullification (wrapped in try/catch)
5. Hard-delete
6. Audit event emission (non-critical)

### 3.12 Compliance

**GDPR Right to Erasure:**

- `CascadeDeleteContact` use case performs complete data erasure
- Crypto-shredding as defense-in-depth
- Message scrubbing via `DualWriteMessageStore`
- ClickHouse data cleanup
- Audit trail of deletion (without PII)

**Data Minimization:**

- Contact context bounded at 64 KB
- Soft-delete nullifies PII fields (identity, displayName, employeeId, company, accountRef)

---

## 4. Alternatives Considered

### Alternative 1: Centralized Identity Service (Rejected)

**Description:** Extract identity resolution into a standalone microservice with its own database, exposing gRPC/REST API for all identity operations.

**Pros:**

- Complete isolation of identity logic
- Independent scaling and deployment
- Could serve multiple platform services

**Cons:**

- Network hop for every session initialization (latency-critical path)
- Additional infrastructure (new service, new database, new deployment)
- Complex distributed transactions for merge operations
- Overkill for current single-runtime architecture

**Decision:** Rejected. The platform runs as a monolith-first architecture. Extracting to a microservice adds latency and complexity without proportional benefit. The bounded context pattern within the monolith provides sufficient isolation.

### Alternative 2: Client-Side Encryption with Key Vault (Rejected)

**Description:** Use a separate key management service (AWS KMS, HashiCorp Vault) for key wrapping, with data encryption keys (DEKs) encrypted by key encryption keys (KEKs) stored in the vault.

**Pros:**

- Hardware-backed key storage
- Key rotation without re-encryption
- Standard enterprise pattern

**Cons:**

- Network latency for every encryption/decryption operation
- Dependency on external service availability
- More complex key management for per-tenant and per-contact keys
- Higher operational complexity for self-hosted deployments

**Decision:** Rejected for now. Current HKDF-based key derivation from a single master key provides adequate security with zero external dependencies. Key vault integration can be added later as a pluggable backend behind the EncryptionService interface.

### Alternative 3: Event-Sourced Contact Aggregate (Considered for future)

**Description:** Store contacts as an event stream (ContactCreated, IdentityAdded, SessionLinked, ContactMerged, etc.) and project into read models.

**Pros:**

- Complete audit trail by default
- Easy temporal queries ("what did this contact look like at time T?")
- Natural fit for merge operations (replay events)

**Cons:**

- Significant complexity increase
- Eventual consistency for read models
- Larger storage footprint
- Overkill for current requirements

**Decision:** Deferred. Current CRUD + audit logging approach is simpler and meets requirements. Event sourcing could be introduced later if temporal queries become a requirement.

---

## 5. Data Flow Diagrams

### 5.1 Identity Resolution (Session Start)

```
SDK Session Init
       |
       v
[sdk-handler-contact-linking]
       |
       | tier >= 2 and customerId present
       v
[ResolveOrCreateContact.execute]
       |
       +--- normalizeIdentity(type, value)
       |
       +--- encryptor.blindIndex(tenantId, normalized)
       |
       +--- repo.findByBlindIndex(tenantId, blindIdx)
       |         |
       |         +-- found? --> return existing contact
       |         |
       |         +-- not found? --> encrypt identity
       |                           create contact
       |                           return new contact
       v
[LinkSessionToContact.execute]
       |
       +--- repo.linkSession(tenantId, contactId, sessionId, channelType, channelId)
       |       |
       |       +-- update channel history (upsert)
       |       +-- increment sessionCount
       |       +-- update lastSeenAt
       v
Return contactId to SDK handler
```

### 5.2 Contact Merge

```
Admin POST /api/contacts/manage/merge
       |
       v
[ExecuteMerge.execute]
       |
       +--- Load primary contact (tenant-scoped)
       +--- Load secondary contact (tenant-scoped)
       |
       +--- Deduplicate identities by blindIndex
       +--- Merge channel history (union)
       |
       +--- Reassign sessions (optional callback)
       |
       +--- Update primary (merged identities + history + counts)
       +--- Mark secondary (mergedInto = primary.id)
       +--- Soft-delete secondary
       |
       +--- Emit audit event
       v
Return MergeExecution
```

### 5.3 GDPR Cascade Delete

```
Admin DELETE /api/contacts/manage/:id/gdpr
       |
       v
[CascadeDeleteContact.execute]
       |
       +--- Load contact (verify tenant ownership)
       +--- Resolution key cleanup (optional)
       +--- Scrub messages (optional)
       +--- ClickHouse cleanup (optional, try/catch)
       +--- Nullify encryptionSalt (crypto-shredding, try/catch)
       +--- Hard-delete contact document
       +--- Emit audit event (non-critical)
       v
Return { success: true }
```

---

## 6. Dependency Map

### Internal Dependencies

| Component                     | Depends On                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| contacts.ts (routes)          | authMiddleware, rbac, rate-limiter, MongoContactStore, contact-validation, audit-helpers |
| contact-merge.ts (routes)     | ContactContext (use cases)                                                               |
| merge-suggestions.ts (routes) | MergeSuggestionMongoStore                                                                |
| ResolveOrCreateContact        | ContactRepository, EncryptionService, ContactAuditEmitter                                |
| ExecuteMerge                  | ContactRepository, ContactAuditEmitter, SessionReassigner                                |
| SelfMerge                     | ContactRepository, EncryptionService, ContactAuditEmitter, SessionReassigner             |
| CascadeDeleteContact          | ContactRepository, AuditCallback, ResolutionKeyCleanup, scrubMessages, clickhouseCleanup |
| LinkSessionToContact          | ContactRepository, ContactAuditEmitter                                                   |
| DetectMergeCandidates         | ContactRepository                                                                        |
| ContactMongoRepository        | Mongoose Contact model                                                                   |
| ContactContextService         | Redis (optional), ContactContextRepo (MongoDB)                                           |

### External Dependencies

| Dependency | Usage                              | Failure Mode                        |
| ---------- | ---------------------------------- | ----------------------------------- |
| MongoDB    | Primary data store                 | Fatal -- contacts unavailable       |
| Redis      | Contact context cache              | Graceful -- fall through to MongoDB |
| ClickHouse | Analytics data (GDPR cleanup only) | Graceful -- logged and continued    |

---

## 7. Migration Strategy

### Existing Migrations

1. **20260305_009**: Backfill `contactId` on messages from session `contactId`. Batch size 100, cursor-paginated, idempotent.

### Schema Compatibility

- Legacy flat `identity`/`identityType` fields retained on Contact model
- New code uses `identities` array with encrypted subdocuments
- Both field sets are indexed for query support
- No breaking migration required -- additive schema evolution

### Future Migrations

- Consolidate `MongoContactStore` and `ContactMongoRepository` into single adapter
- Fix tenant isolation gaps in `MongoContactStore.delete()` and `touchLastSeen()`
- Add pagination to merge suggestions query

---

## 8. Security Review Checklist

| Check                             | Status  | Notes                                                              |
| --------------------------------- | ------- | ------------------------------------------------------------------ |
| All queries include tenantId      | PARTIAL | MongoContactStore has 2 gaps                                       |
| PII encrypted at rest             | PASS    | AES-256-GCM with tenant-scoped HKDF keys                           |
| Blind indexes are tenant-isolated | PASS    | Different tenants produce different indexes                        |
| Auth required on all endpoints    | PASS    | authMiddleware on CRUD routes, tenantContext check on merge routes |
| RBAC on write operations          | PARTIAL | CRUD routes use requirePermissionInline; merge routes do not       |
| Rate limiting                     | PARTIAL | CRUD routes have tenantRateLimit; merge/GDPR routes do not         |
| Input validation                  | PASS    | Zod schemas + manual validation with length/format checks          |
| Audit logging                     | PASS    | All mutations emit structured audit events                         |
| Crypto-shredding for GDPR         | PASS    | Salt nullification before hard-delete                              |
| No PII in logs                    | PASS    | Only contactId/tenantId logged, never identity values              |
