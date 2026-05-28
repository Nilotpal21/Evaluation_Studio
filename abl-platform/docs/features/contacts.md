# Feature Spec: Contacts Management

> **Feature ID:** #49
> **Status:** ALPHA
> **Owner:** Runtime Team
> **Last Updated:** 2026-03-23

---

## 1. Problem Statement

The ABL platform needs a unified contact management system that tracks end-users (customers, employees, anonymous visitors) across multiple sessions, channels, and identity types. Without this, agents cannot access cross-session context, cannot recognize returning users, and cannot comply with GDPR erasure requirements. The platform must resolve identities automatically, merge duplicate contacts, encrypt PII at rest, and provide administrative CRUD operations -- all while enforcing strict tenant isolation.

## 2. Scope

### In Scope

- **Contact CRUD**: Create, read, update, soft-delete contacts via REST API
- **Identity Resolution**: Automatic resolve-or-create via blind index lookup on encrypted identities (email, phone, external)
- **Session Linking**: Associate sessions with contacts, track channel interaction history
- **Contact Merging**: Admin-initiated merge of two contacts; self-merge when a user provides a new identity matching an existing contact
- **Merge Suggestions**: Detect merge candidates based on overlapping blind indexes; admin review workflow (pending/accepted/rejected/auto_merged)
- **GDPR Cascade Delete**: Hard-delete a contact and all associated data (messages, analytics, encryption salts) for right-to-erasure compliance
- **Crypto-Shredding**: Nullify encryption salt to render encrypted PII unrecoverable without full hard-delete
- **Cross-Session Context**: Persist preferences, data values, disposition, and session count across sessions via Redis-cached MongoDB store
- **SDK Contact Linking**: Automatic contact resolution and session linking for tier 2+ SDK WebSocket sessions
- **Contact History**: Cursor-paginated cross-session message history for identified contacts
- **Audit Trail**: Structured audit events for all contact lifecycle operations (created, updated, deleted, merged, linked)
- **Encryption**: AES-256-GCM field-level encryption with tenant-scoped HKDF-derived keys; HMAC-SHA256 blind indexes for searchable encrypted fields

### Out of Scope

- Contact import/export (bulk CSV operations)
- Contact search by encrypted PII (only blind-index-based lookup)
- Contact deduplication ML models (manual/rule-based merge suggestions only)
- Studio UI for contact management (API-only for now)
- Multi-tenant contact sharing
- Contact activity timeline visualization

## 3. Requirements

### 3.1 Functional Requirements

| ID    | Requirement                                                                                                                                             | Priority | Status      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| FR-01 | Create a contact with tenant scoping, optional identity (email/phone/external), display name, metadata, and tags                                        | P0       | IMPLEMENTED |
| FR-02 | Query contacts with filters (type, channel, tags) and pagination (limit/offset)                                                                         | P0       | IMPLEMENTED |
| FR-03 | Lookup a contact by identity type and value within a tenant                                                                                             | P0       | IMPLEMENTED |
| FR-04 | Get a contact by ID with tenant isolation (cross-tenant returns 404)                                                                                    | P0       | IMPLEMENTED |
| FR-05 | Update contact fields (type, identity, displayName, department, employeeId, company, tags, metadata)                                                    | P0       | IMPLEMENTED |
| FR-06 | Soft-delete a contact (nullify PII fields, set type to anonymous, set deletedAt, unlink sessions)                                                       | P0       | IMPLEMENTED |
| FR-07 | Link a contact to a session and update lastSeenAt                                                                                                       | P0       | IMPLEMENTED |
| FR-08 | Resolve-or-create: given an identity, find existing contact via blind index or create new with encrypted identity                                       | P0       | IMPLEMENTED |
| FR-09 | Encrypt identity values with AES-256-GCM using tenant-scoped HKDF-derived keys                                                                          | P0       | IMPLEMENTED |
| FR-10 | Generate deterministic blind indexes (HMAC-SHA256) for encrypted identity lookup without decryption                                                     | P0       | IMPLEMENTED |
| FR-11 | Admin merge: merge secondary contact into primary, dedup identities by blind index, merge channel history, reassign sessions                            | P0       | IMPLEMENTED |
| FR-12 | Self-merge: when a contact provides an identity owned by another contact, merge by recency                                                              | P0       | IMPLEMENTED |
| FR-13 | GDPR cascade delete: hard-delete contact, scrub messages, clean up ClickHouse data, nullify encryption salt, emit audit event                           | P0       | IMPLEMENTED |
| FR-14 | Detect merge candidates based on overlapping blind indexes across contacts                                                                              | P1       | IMPLEMENTED |
| FR-15 | List and resolve merge suggestions (pending/accepted/rejected) with admin workflow                                                                      | P1       | IMPLEMENTED |
| FR-16 | Cross-session contact context: persist preferences, dataValues, lastDisposition across sessions with Redis cache (5min TTL) and MongoDB source of truth | P1       | IMPLEMENTED |
| FR-17 | SDK WebSocket contact linking: auto-resolve and link contacts for tier 2+ sessions                                                                      | P1       | IMPLEMENTED |
| FR-18 | Contact history: cursor-paginated cross-session message history for identified (non-anonymous) contacts                                                 | P1       | IMPLEMENTED |
| FR-19 | Validate identity format (email regex, phone regex, non-empty external)                                                                                 | P0       | IMPLEMENTED |
| FR-20 | Normalize identities before encryption (lowercase email, strip phone formatting)                                                                        | P0       | IMPLEMENTED |
| FR-21 | Contact context size guard: reject contactContext updates exceeding 64 KB serialized limit                                                              | P1       | IMPLEMENTED |
| FR-22 | Backward compatibility: support legacy flat identity/identityType fields alongside new identities array                                                 | P1       | IMPLEMENTED |
| FR-23 | Migration: backfill contactId on messages from session contactId                                                                                        | P1       | IMPLEMENTED |

### 3.2 Non-Functional Requirements

| ID     | Requirement                                                                          | Target                        |
| ------ | ------------------------------------------------------------------------------------ | ----------------------------- |
| NFR-01 | Tenant isolation: every query must include tenantId; cross-tenant access returns 404 | Mandatory                     |
| NFR-02 | Encryption at rest: all PII fields encrypted with AES-256-GCM                        | Mandatory                     |
| NFR-03 | Contact context cache: Redis 5min TTL, fail-open to MongoDB on Redis failure         | P99 < 50ms for cache hit      |
| NFR-04 | Contact query performance: paginated with compound indexes                           | P95 < 200ms for 1000 contacts |
| NFR-05 | GDPR cascade delete: complete within 30 seconds for contacts with up to 10K messages | Mandatory                     |
| NFR-06 | Audit logging: every mutation emits a structured audit event                         | Mandatory                     |
| NFR-07 | Blind index lookup: single-query resolution via compound index                       | P95 < 50ms                    |
| NFR-08 | Contact context size: bounded at 64 KB serialized                                    | Mandatory                     |

## 4. User Stories

### US-01: Agent resolves returning customer

As an AI agent, when a customer initiates a session with a known identity (email/phone), I want their contact to be automatically resolved so I can access their cross-session context (preferences, past interactions, disposition).

### US-02: Admin creates a contact manually

As a platform admin, I want to create a contact with a display name, type, and identity so that I can pre-register known customers before they interact with agents.

### US-03: Admin merges duplicate contacts

As a platform admin, when I see two contacts that represent the same person (detected via overlapping identities), I want to merge them into one contact so that session history is unified.

### US-04: Customer self-merges on identity change

As a customer who previously used phone authentication and now provides an email, I want my contacts to be automatically merged so that my full interaction history follows me.

### US-05: Compliance officer performs GDPR erasure

As a compliance officer, I want to permanently delete a contact and all associated data (messages, analytics, encryption keys) so that I can fulfill a right-to-erasure request.

### US-06: Agent accesses cross-session context

As an AI agent, at the start of a session, I want to load the contact's persisted preferences and data values so that I can personalize the interaction without re-gathering information.

### US-07: Admin reviews merge suggestions

As a platform admin, I want to see a list of merge suggestions (with confidence levels) so that I can accept or reject them to keep the contact database clean.

### US-08: Admin views contact interaction history

As a platform admin, I want to view a contact's cross-session message history with cursor pagination so that I can audit past interactions.

## 5. Data Model

### Contact (MongoDB: `contacts` collection)

| Field          | Type                                | Description                                       |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| \_id           | String (UUIDv7)                     | Primary key                                       |
| tenantId       | String                              | Tenant isolation key                              |
| type           | Enum: employee, customer, anonymous | Contact classification                            |
| identities     | Array of ContactIdentity            | Encrypted identity subdocuments                   |
| channelHistory | Array of ChannelHistoryEntry        | Per-channel interaction stats                     |
| sessionCount   | Number                              | Total sessions across all channels                |
| mergedInto     | String or null                      | ID of surviving contact after merge               |
| identity       | String or null                      | Legacy flat identity (backward compat)            |
| identityType   | Enum or null                        | Legacy identity type                              |
| displayName    | String or null                      | Human-readable name                               |
| department     | String or null                      | Organizational department                         |
| employeeId     | String or null                      | Employee identifier                               |
| company        | String or null                      | Company name                                      |
| accountRef     | String or null                      | External account reference                        |
| channel        | String or null                      | Primary channel                                   |
| metadata       | Mixed                               | Arbitrary key-value metadata                      |
| tags           | Array of String                     | Searchable tags (max 50)                          |
| firstSeenAt    | Date                                | First interaction timestamp                       |
| lastSeenAt     | Date                                | Most recent interaction timestamp                 |
| deletedAt      | Date or null                        | Soft-delete timestamp                             |
| encryptionSalt | String or null                      | Per-contact HKDF salt (nullified on crypto-shred) |
| contactContext | Mixed (max 64KB)                    | Cross-session persisted context                   |
| \_v            | Number                              | Document version                                  |

### ContactIdentity (subdocument)

| Field          | Type                         | Description                               |
| -------------- | ---------------------------- | ----------------------------------------- |
| type           | Enum: email, phone, external | Identity type                             |
| encryptedValue | String                       | AES-256-GCM encrypted PII                 |
| blindIndex     | String                       | HMAC-SHA256 deterministic hash for lookup |
| verified       | Boolean                      | Whether identity has been verified        |
| verifiedAt     | Date or null                 | Verification timestamp                    |
| verifiedVia    | Enum or null                 | Verification method                       |
| channel        | String or null               | Channel where identity was collected      |

### Indexes

- `{ tenantId: 1, identityType: 1, identity: 1 }` -- Legacy lookup
- `{ tenantId: 1, type: 1 }` -- Type filtering
- `{ tenantId: 1, lastSeenAt: -1 }` -- Recency sorting
- `{ tenantId: 1, deletedAt: 1 }` -- Soft-delete filtering
- `{ tenantId: 1, 'identities.blindIndex': 1 }` -- Encrypted identity lookup
- `{ tenantId: 1, mergedInto: 1 }` -- Merge chain traversal

## 6. API Surface

### Contact CRUD (`/api/contacts`)

| Method | Path                             | Auth          | Description                                   |
| ------ | -------------------------------- | ------------- | --------------------------------------------- |
| POST   | `/api/contacts`                  | agent:execute | Create contact                                |
| GET    | `/api/contacts`                  | authenticated | Query contacts (type, channel, limit, offset) |
| GET    | `/api/contacts/lookup`           | authenticated | Find by identityType + identity               |
| GET    | `/api/contacts/:id`              | authenticated | Get by ID                                     |
| PUT    | `/api/contacts/:id`              | agent:execute | Update contact                                |
| DELETE | `/api/contacts/:id`              | agent:execute | Soft delete                                   |
| POST   | `/api/contacts/:id/link-session` | agent:execute | Link contact to session                       |
| GET    | `/api/contacts/:id/history`      | agent:execute | Cross-session message history                 |

### Contact Merge (`/api/contacts/manage`)

| Method | Path                                  | Auth          | Description                   |
| ------ | ------------------------------------- | ------------- | ----------------------------- |
| POST   | `/api/contacts/manage/merge`          | authenticated | Admin merge two contacts      |
| POST   | `/api/contacts/manage/:id/self-merge` | authenticated | Self-merge on identity change |
| DELETE | `/api/contacts/manage/:id/gdpr`       | authenticated | GDPR cascade hard-delete      |

### Merge Suggestions (`/api/merge-suggestions`)

| Method | Path                         | Auth          | Description                                     |
| ------ | ---------------------------- | ------------- | ----------------------------------------------- |
| GET    | `/api/merge-suggestions`     | authenticated | List merge suggestions (optional status filter) |
| PUT    | `/api/merge-suggestions/:id` | authenticated | Accept or reject suggestion                     |

## 7. Architecture Overview

The contacts feature follows a bounded context / hexagonal architecture pattern:

- **Domain Layer** (`contexts/contact/domain/`): Pure types and interfaces -- Contact aggregate, ContactIdentity, MergeSuggestion, MergeExecution, ContactRepository port
- **Use Case Layer** (`contexts/contact/use-cases/`): ResolveOrCreateContact, LinkSessionToContact, DetectMergeCandidates, ExecuteMerge, SelfMerge, CascadeDeleteContact
- **Infrastructure Layer** (`contexts/contact/infrastructure/`): ContactMongoRepository, MergeSuggestionMongoStore, normalize-identity, contact-audit
- **Route Layer** (`routes/`): contacts.ts (CRUD), contact-merge.ts (merge/GDPR), merge-suggestions.ts (suggestion workflow)
- **Service Layer** (`services/`): ContactContextService (Redis+Mongo cache), MongoContactStore (legacy store adapter)
- **WebSocket Integration** (`websocket/`): sdk-handler-contact-linking.ts (automatic SDK contact resolution)

### Factory Wiring

`createContactContext()` wires all use cases with their dependencies (repository, encryptor, audit callbacks, session reassigner). The server.ts startup sequence conditionally mounts merge routes when `ENCRYPTION_MASTER_KEY` is available.

## 8. Security Considerations

- **Tenant Isolation**: Every query includes tenantId. Cross-tenant access returns 404.
- **PII Encryption**: All identity values encrypted with AES-256-GCM using HKDF-derived tenant-scoped keys. Random IV per encryption (no ciphertext reuse).
- **Blind Indexes**: HMAC-SHA256 with tenant-scoped blind key enables lookup without decryption. Different tenants produce different indexes for the same value.
- **Crypto-Shredding**: GDPR delete nullifies encryptionSalt, rendering all per-contact encrypted data unrecoverable.
- **RBAC**: Write operations require `agent:execute` permission. Read operations require authentication.
- **Audit Trail**: Every mutation emits structured audit events via AuditStore.

## 9. Known Gaps and Risks

| ID     | Gap                                                                                           | Severity | Mitigation                                                 |
| ------ | --------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| GAP-01 | `MongoContactStore.delete()` uses `findByIdAndDelete` without tenantId filter                 | HIGH     | Must be fixed to use `findOneAndDelete({ _id, tenantId })` |
| GAP-02 | `MongoContactStore.touchLastSeen()` uses `findByIdAndUpdate` without tenantId                 | HIGH     | Must be fixed to include tenantId in filter                |
| GAP-03 | Routes use `console.error` instead of structured logger                                       | MEDIUM   | Replace with `createLogger` calls                          |
| GAP-04 | Contact merge routes require only tenantContext, not RBAC permission check                    | MEDIUM   | Add `requirePermissionInline` for admin-level operations   |
| GAP-05 | No rate limiting on merge/GDPR endpoints                                                      | MEDIUM   | Add `tenantRateLimit` middleware                           |
| GAP-06 | Merge suggestions GET has no pagination                                                       | LOW      | Add limit/offset for large tenants                         |
| GAP-07 | Contact context Redis cache has no max-size bound on cached entries                           | LOW      | Add LRU eviction or tenant-scoped key prefix TTL           |
| GAP-08 | Dual store layer: `MongoContactStore` and `ContactMongoRepository` serve overlapping purposes | LOW      | Consolidate into single repository                         |
| GAP-09 | No E2E tests exist for the contacts feature                                                   | HIGH     | Must be implemented                                        |
| GAP-10 | Self-merge uses recency as primary heuristic which may not always be correct                  | LOW      | Consider admin-configurable merge strategy                 |

## 10. Decision Log

| Decision                                                          | Rationale                                                                                                     | Date         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ |
| Blind index for encrypted identity lookup                         | Enables O(1) contact resolution without decrypting all identities; standard pattern for searchable encryption | Pre-existing |
| Hexagonal architecture with domain/use-case/infrastructure layers | Isolates business logic from MongoDB/Redis, enables unit testing without infrastructure                       | Pre-existing |
| Factory wiring via `createContactContext()`                       | Single composition root for all use cases; dependencies injected, not imported                                | Pre-existing |
| Redis fail-open for contact context cache                         | Availability over consistency; stale data bounded by 5min TTL                                                 | Pre-existing |
| Per-contact encryption salt for HKDF                              | Enables per-contact crypto-shredding for GDPR compliance                                                      | Pre-existing |
| Legacy flat identity fields retained                              | Backward compatibility with existing data; new code uses identities array                                     | Pre-existing |
