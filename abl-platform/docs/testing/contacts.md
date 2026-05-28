# Test Spec: Contacts Management

> **Feature:** #49 Contacts Management
> **Status:** PLANNED
> **Last Updated:** 2026-03-23
> **Feature Spec:** `docs/features/contacts.md`

---

## 1. Test Strategy

The contacts feature spans CRUD operations, encrypted identity resolution, contact merging, GDPR cascade delete, SDK WebSocket integration, and cross-session context management. Testing must cover the full middleware chain (auth, rate limiting, tenant isolation, validation) through the HTTP API without mocking codebase components.

### Test Layers

| Layer       | Scope                                                            | Infrastructure Required                                  |
| ----------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| E2E         | Full HTTP API through Express middleware chain                   | MongoDB, Redis (optional), Express server on random port |
| Integration | Cross-boundary interactions (use-case + repository + encryption) | MongoDB (MongoMemoryServer)                              |
| Unit        | Domain logic, validation, normalization                          | None                                                     |

### Test Infrastructure

- **Server**: Start Express app on `{ port: 0 }` for each test suite to avoid port conflicts
- **Database**: MongoMemoryServer for isolated MongoDB instances per suite
- **Auth**: Seed tenant context via real auth middleware or use test JWT tokens that pass the full auth chain
- **Encryption**: Use real `EncryptionService` with test master key (32 random bytes hex)
- **Redis**: Optional; tests should verify fail-open behavior when Redis is unavailable

---

## 2. E2E Test Scenarios

All E2E tests interact exclusively via HTTP API. No mocking of codebase components. No direct DB queries.

### E2E-01: Contact CRUD Lifecycle

**Covers:** FR-01, FR-02, FR-03, FR-04, FR-05, FR-06, FR-07, FR-19

**Setup:** Start Express server with full middleware chain. Seed auth token for test tenant.

| Step | Action                                                                                                                                         | Expected Result                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1    | POST `/api/contacts` with `{ type: "customer", identity: "user@example.com", identityType: "email", displayName: "Test User", tags: ["vip"] }` | 201, contact returned with id, tenantId, type, identity |
| 2    | GET `/api/contacts` with query `?type=customer`                                                                                                | 200, array contains the created contact, total >= 1     |
| 3    | GET `/api/contacts/lookup?identityType=email&identity=user@example.com`                                                                        | 200, returns the same contact by identity               |
| 4    | GET `/api/contacts/:id`                                                                                                                        | 200, returns the contact by ID                          |
| 5    | PUT `/api/contacts/:id` with `{ displayName: "Updated User", tags: ["vip", "premium"] }`                                                       | 200, updated fields reflected                           |
| 6    | POST `/api/contacts/:id/link-session` with `{ sessionId: "test-session-1" }`                                                                   | 200, success message                                    |
| 7    | DELETE `/api/contacts/:id`                                                                                                                     | 200, soft-delete success                                |
| 8    | GET `/api/contacts/:id`                                                                                                                        | 404, contact no longer findable (soft-deleted)          |

**Assertions:**

- Every response has `{ success: true/false }` envelope
- Created contact has valid UUIDv7 `id`
- Soft-deleted contact is not returned by query endpoints
- Link-session updates lastSeenAt

### E2E-02: Tenant Isolation

**Covers:** NFR-01, FR-04

**Setup:** Two test tenants with separate auth tokens.

| Step | Action                                                                            | Expected Result                              |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | Tenant A: POST `/api/contacts` creates contact-A                                  | 201, contact created                         |
| 2    | Tenant B: GET `/api/contacts/:contact-A-id`                                       | 404, not found (not 403)                     |
| 3    | Tenant B: PUT `/api/contacts/:contact-A-id` with update body                      | 404                                          |
| 4    | Tenant B: DELETE `/api/contacts/:contact-A-id`                                    | 404                                          |
| 5    | Tenant B: GET `/api/contacts`                                                     | 200, empty array (no cross-tenant leakage)   |
| 6    | Tenant B: GET `/api/contacts/lookup?identityType=email&identity=user@example.com` | 404 (even though tenant A has this identity) |

**Assertions:**

- Cross-tenant access always returns 404, never 403
- Query results never include contacts from other tenants
- Identity lookup is tenant-scoped

### E2E-03: Contact Merge Workflow

**Covers:** FR-11, FR-12, FR-14, FR-15

**Setup:** Start Express server with encryption service configured. Create two contacts with overlapping identities.

| Step | Action                                                                                                        | Expected Result                                           |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1    | Create contact-A with email identity `a@test.com`                                                             | 201                                                       |
| 2    | Create contact-B with email identity `a@test.com` (duplicate) and phone identity `+1234567890`                | 201                                                       |
| 3    | POST `/api/contacts/manage/merge` with `{ primaryContactId: contact-A-id, secondaryContactId: contact-B-id }` | 200, merge execution returned                             |
| 4    | GET `/api/contacts/:contact-A-id`                                                                             | 200, primary has merged identities (both email and phone) |
| 5    | GET `/api/contacts/:contact-B-id`                                                                             | Shows mergedInto = contact-A-id, soft-deleted             |
| 6    | Verify session counts are summed on primary                                                                   | sessionCount reflects both contacts                       |

**Assertions:**

- Identities are deduplicated by blind index during merge
- Channel history is merged (union of both contacts' channels)
- Secondary contact's mergedInto field points to primary
- MergeExecution record contains identitiesMoved and sessionsMoved

### E2E-04: Self-Merge via Identity Change

**Covers:** FR-12

**Setup:** Start Express server with encryption. Create two contacts owned by same tenant.

| Step | Action                                                                                                                | Expected Result                               |
| ---- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | Create contact-A (anonymous, no identity)                                                                             | 201                                           |
| 2    | Create contact-B with email identity `user@test.com`                                                                  | 201                                           |
| 3    | POST `/api/contacts/manage/:contact-A-id/self-merge` with `{ identityType: "email", identityValue: "user@test.com" }` | 200, merged = true, returns surviving contact |
| 4    | Verify surviving contact has the email identity                                                                       | identity present on primary                   |
| 5    | Verify non-surviving contact has mergedInto set                                                                       | mergedInto points to primary                  |

**Assertions:**

- Self-merge picks the more recently seen contact as primary
- Merged contact is soft-deleted with mergedInto set
- If identity already exists on the same contact, no merge occurs (merged = false)

### E2E-05: GDPR Cascade Delete

**Covers:** FR-13, NFR-05

**Setup:** Start Express server with encryption. Create a contact, link sessions, create messages.

| Step | Action                                                                 | Expected Result                  |
| ---- | ---------------------------------------------------------------------- | -------------------------------- |
| 1    | Create contact with identity                                           | 201                              |
| 2    | Link contact to a session via POST `/api/contacts/:id/link-session`    | 200                              |
| 3    | DELETE `/api/contacts/manage/:id/gdpr`                                 | 200, permanently deleted message |
| 4    | GET `/api/contacts/:id`                                                | 404, contact gone completely     |
| 5    | Verify no trace of contact in DB (hard-deleted, not just soft-deleted) | Contact document absent          |

**Assertions:**

- Hard-delete removes the contact document entirely
- Encryption salt is nullified before deletion (crypto-shredding)
- Audit event emitted with action `contact.hard_deleted`
- Associated messages are scrubbed

### E2E-06: Input Validation

**Covers:** FR-19, FR-01

**Setup:** Start Express server with auth.

| Step | Action                                                                           | Expected Result                                   |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1    | POST `/api/contacts` with `{ identity: "invalid-email", identityType: "email" }` | 400, validation error on identity format          |
| 2    | POST `/api/contacts` with `{ identity: "user@test.com" }` (missing identityType) | 400, identityType required when identity provided |
| 3    | POST `/api/contacts` with `{ displayName: "x".repeat(201) }`                     | 400, displayName exceeds max length               |
| 4    | POST `/api/contacts` with `{ tags: Array(51).fill("tag") }`                      | 400, tags exceed max count                        |
| 5    | POST `/api/contacts` with `{ type: "invalid" }`                                  | 400, type must be employee/customer/anonymous     |
| 6    | GET `/api/contacts?limit=0`                                                      | 400, limit must be >= 1                           |
| 7    | GET `/api/contacts?limit=1001`                                                   | 400, limit must be <= 1000                        |
| 8    | GET `/api/contacts?offset=-1`                                                    | 400, offset must be non-negative                  |

**Assertions:**

- Each validation error returns `{ success: false }` with meaningful error message
- Valid field combinations are accepted (identity + identityType together)
- Partial updates (PUT) validate only provided fields

### E2E-07: Contact History Pagination

**Covers:** FR-18

**Setup:** Create a contact with identity. Create multiple sessions with messages linked to this contact.

| Step | Action                                                              | Expected Result                                           |
| ---- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| 1    | Create contact, link to session, seed 100 messages for this contact | Setup complete                                            |
| 2    | GET `/api/contacts/:id/history?limit=10`                            | 200, 10 messages returned, hasMore=true, nextCursor set   |
| 3    | GET `/api/contacts/:id/history?limit=10&cursor=<nextCursor>`        | 200, next 10 messages, timestamps < cursor                |
| 4    | Continue pagination until hasMore=false                             | All messages retrieved in order                           |
| 5    | GET `/api/contacts/:anonymous-id/history`                           | 404, anonymous contacts cannot have cross-session history |

**Assertions:**

- Messages are returned in reverse chronological order (newest first)
- Cursor is an ISO 8601 timestamp
- Page size is bounded by MAX_HISTORY_PAGE_SIZE (200)
- Invalid cursor returns 400

### E2E-08: Authentication and Authorization

**Covers:** NFR-01

**Setup:** Start Express server.

| Step | Action                                                     | Expected Result              |
| ---- | ---------------------------------------------------------- | ---------------------------- |
| 1    | GET `/api/contacts` without auth header                    | 401, authentication required |
| 2    | POST `/api/contacts` without auth header                   | 401                          |
| 3    | POST `/api/contacts/manage/merge` without auth header      | 401                          |
| 4    | DELETE `/api/contacts/manage/:id/gdpr` without auth header | 401                          |
| 5    | GET `/api/merge-suggestions` without auth header           | 401                          |

**Assertions:**

- All endpoints require authentication
- Write endpoints require `agent:execute` permission
- Missing auth returns 401 with structured error

---

## 3. Integration Test Scenarios

Integration tests exercise real service boundaries (use-case + repository + encryption) with MongoMemoryServer. No mocking of codebase components.

### INT-01: ResolveOrCreateContact with Encryption

**Covers:** FR-08, FR-09, FR-10, FR-20

**Setup:** MongoMemoryServer, real EncryptionService with test master key, ContactMongoRepository.

| Step | Action                                                                       | Expected Result                                              |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Call `resolveOrCreateContact.execute(tenantId, "email", "User@Example.COM")` | New contact created with normalized email                    |
| 2    | Call again with `"user@example.com"` (different case)                        | Returns same contact (normalized + blind index match)        |
| 3    | Call with different tenant, same email                                       | Creates a new separate contact (tenant-isolated blind index) |
| 4    | Verify stored identity has encryptedValue != plaintext                       | PII is encrypted                                             |
| 5    | Verify blind index is deterministic for same tenant + value                  | Same blind index produced                                    |

**Assertions:**

- Email normalization: lowercase, trimmed
- Phone normalization: digits only, no formatting
- Blind index is tenant-scoped (different tenants = different index)
- Encrypted value differs on each call (random IV)

### INT-02: ExecuteMerge with Session Reassignment

**Covers:** FR-11

**Setup:** MongoMemoryServer, two contacts with identities, sessions linked.

| Step | Action                                                                 | Expected Result         |
| ---- | ---------------------------------------------------------------------- | ----------------------- |
| 1    | Create primary contact with 1 identity, 2 sessions                     | Contact A exists        |
| 2    | Create secondary contact with 2 identities (1 overlapping), 3 sessions | Contact B exists        |
| 3    | Execute merge (A = primary, B = secondary)                             | MergeExecution returned |
| 4    | Verify primary has 2 unique identities (deduped)                       | Blind index dedup works |
| 5    | Verify primary sessionCount = A.sessionCount + B.sessionCount          | Counts merged           |
| 6    | Verify secondary has mergedInto = A.id and is soft-deleted             | Secondary cleaned up    |
| 7    | Verify channel history is merged                                       | Union of both histories |

**Assertions:**

- Identity deduplication by blind index prevents duplicates
- Channel history merge uses earliest firstSessionAt and latest lastSessionAt
- Session reassigner callback is invoked with correct IDs

### INT-03: CascadeDeleteContact with Message Scrubbing

**Covers:** FR-13, NFR-05

**Setup:** MongoMemoryServer, contact with linked sessions and messages.

| Step | Action                                                     | Expected Result              |
| ---- | ---------------------------------------------------------- | ---------------------------- |
| 1    | Create contact with encrypted identities                   | Contact exists               |
| 2    | Create messages associated with contact                    | Messages exist               |
| 3    | Execute cascade delete                                     | Success                      |
| 4    | Verify contact document is hard-deleted from MongoDB       | Document absent              |
| 5    | Verify encryption salt was nullified before deletion       | Salt null in pre-delete step |
| 6    | Verify audit callback received event with correct metadata | Audit emitted                |
| 7    | Verify message scrub callback invoked                      | Messages scrubbed            |

**Assertions:**

- Hard-delete removes the document entirely (not soft-delete)
- Crypto-shredding step precedes hard-delete
- Audit event includes identityCount and sessionCount
- ClickHouse cleanup callback invoked if provided

### INT-04: ContactContextService with Redis Cache

**Covers:** FR-16, NFR-03

**Setup:** MongoMemoryServer, mock Redis (in-memory Map implementing RedisLike interface).

| Step | Action                                                                                                                                                                    | Expected Result                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Call `get(tenantId, contactId)` — cache miss                                                                                                                              | Returns null (no contact context yet)    |
| 2    | Call `update(tenantId, contactId, { preferences: { lang: "en" }, dataValues: {}, lastDisposition: null, lastInteraction: null, sessionCount: 1, updatedAt: new Date() })` | Context saved to DB                      |
| 3    | Call `get(tenantId, contactId)` — cache miss, DB hit                                                                                                                      | Returns context, populates cache         |
| 4    | Call `get(tenantId, contactId)` — cache hit                                                                                                                               | Returns context from cache (no DB query) |
| 5    | Call `invalidate(tenantId, contactId)`                                                                                                                                    | Cache entry removed                      |
| 6    | Call `get(tenantId, contactId)` — cache miss after invalidation                                                                                                           | Loads from DB again                      |
| 7    | Simulate Redis failure, call `get()`                                                                                                                                      | Falls through to DB (fail-open)          |

**Assertions:**

- Cache key format is `ctx:<tenantId>:<contactId>`
- Cache TTL is 300 seconds (5 minutes)
- Redis failure does not block the request (fail-open)
- Update invalidates cache before next read

### INT-05: SelfMerge Identity Resolution

**Covers:** FR-12

**Setup:** MongoMemoryServer, EncryptionService, ContactMongoRepository.

| Step | Action                                                                     | Expected Result                       |
| ---- | -------------------------------------------------------------------------- | ------------------------------------- |
| 1    | Create contact-A (anonymous)                                               | Contact A exists                      |
| 2    | Create contact-B with email `user@test.com`                                | Contact B exists                      |
| 3    | Call `selfMerge.execute(tenantId, contact-A-id, "email", "user@test.com")` | Merged = true                         |
| 4    | Verify primary (more recently seen) has both contacts' data                | Merge completed                       |
| 5    | Call `selfMerge.execute(tenantId, primary-id, "email", "user@test.com")`   | Merged = false (already has identity) |
| 6    | Call `selfMerge.execute(tenantId, primary-id, "phone", "+1234567890")`     | New identity added, merged = false    |
| 7    | Verify primary now has 2 identities                                        | Identity added                        |

**Assertions:**

- Self-merge picks more recently seen contact as primary
- Already-owned identity returns merged = false without changes
- New identity is encrypted and added with blind index
- Audit events emitted for merge and identity_added

### INT-06: ContactMongoRepository Tenant Isolation

**Covers:** NFR-01

**Setup:** MongoMemoryServer, ContactMongoRepository.

| Step | Action                                              | Expected Result                |
| ---- | --------------------------------------------------- | ------------------------------ |
| 1    | Create contact for tenant-A                         | Contact exists                 |
| 2    | `findById(tenant-B, contact-A-id)`                  | Returns null (tenant-isolated) |
| 3    | `findByBlindIndex(tenant-B, contact-A-blind-index)` | Returns null                   |
| 4    | `softDelete(tenant-B, contact-A-id)`                | No-op (wrong tenant)           |
| 5    | `hardDelete(tenant-B, contact-A-id)`                | No-op (wrong tenant)           |
| 6    | Verify contact-A still exists for tenant-A          | Not affected                   |

**Assertions:**

- Every repository method enforces tenantId in query filter
- Cross-tenant operations have no effect
- No error is thrown for cross-tenant access (silent 404 pattern)

### INT-07: DetectMergeCandidates

**Covers:** FR-14

**Setup:** MongoMemoryServer, EncryptionService, multiple contacts with shared identities.

| Step | Action                                                                         | Expected Result          |
| ---- | ------------------------------------------------------------------------------ | ------------------------ |
| 1    | Create contact-A with email `shared@test.com`                                  | Contact A exists         |
| 2    | Create contact-B with email `shared@test.com` and phone `+1111111111`          | Contact B exists         |
| 3    | Create contact-C with phone `+1111111111`                                      | Contact C exists         |
| 4    | Call `detectMergeCandidates.execute(tenantId, [blind-index-for-shared-email])` | Returns contacts A and B |
| 5    | Call `detectMergeCandidates.execute(tenantId, [blind-index-for-phone])`        | Returns contacts B and C |

**Assertions:**

- Candidates are found via blind index overlap
- Soft-deleted contacts are excluded from candidates
- Different tenant's contacts are not returned

---

## 4. Unit Test Scenarios

### UNIT-01: Contact Validation

**Covers:** FR-19

- `validateCreateContact` rejects missing tenantId
- `validateCreateContact` rejects identity without identityType
- `validateCreateContact` rejects invalid email format
- `validateCreateContact` rejects invalid phone format
- `validateCreateContact` accepts valid email identity
- `validateCreateContact` accepts valid phone identity
- `validateCreateContact` accepts external identity
- `validateCreateContact` rejects displayName > 200 chars
- `validateCreateContact` rejects tags array > 50 items
- `validateUpdateContact` validates same rules for partial updates

### UNIT-02: Identity Normalization

**Covers:** FR-20

- Normalizes email to lowercase
- Trims whitespace from email
- Strips non-digit characters from phone (except leading +)
- Preserves external identity as-is (no normalization)

### UNIT-03: Encryption Backward Compatibility

**Covers:** FR-09, FR-22

- Decrypts data encrypted by old ContactEncryptor format
- Produces same blind index as old ContactEncryptor
- Different tenants produce different blind indexes for same value
- Different salts produce different derived keys

---

## 5. Test Coverage Map

| Component             | E2E            | Integration | Unit    | Status                              |
| --------------------- | -------------- | ----------- | ------- | ----------------------------------- |
| Contact CRUD routes   | E2E-01, E2E-06 | -           | -       | PLANNED                             |
| Tenant isolation      | E2E-02         | INT-06      | -       | PLANNED                             |
| Contact merge         | E2E-03         | INT-02      | -       | PLANNED                             |
| Self-merge            | E2E-04         | INT-05      | -       | PLANNED                             |
| GDPR cascade delete   | E2E-05         | INT-03      | -       | PLANNED                             |
| Input validation      | E2E-06         | -           | UNIT-01 | PLANNED                             |
| Contact history       | E2E-07         | -           | -       | PLANNED                             |
| Auth/authz            | E2E-08         | -           | -       | PLANNED                             |
| Identity resolution   | -              | INT-01      | UNIT-02 | PLANNED                             |
| Contact context cache | -              | INT-04      | -       | PLANNED                             |
| Merge candidates      | -              | INT-07      | -       | PLANNED                             |
| Encryption compat     | -              | -           | UNIT-03 | PLANNED (existing tests cover this) |

---

## 6. Risk Matrix

| Risk                                                          | Impact | Probability | Mitigation                                                      |
| ------------------------------------------------------------- | ------ | ----------- | --------------------------------------------------------------- |
| Tenant isolation bypass in MongoContactStore (GAP-01, GAP-02) | HIGH   | HIGH        | Fix before E2E tests; INT-06 specifically tests this            |
| GDPR cascade fails partway through                            | HIGH   | LOW         | Test retry behavior; verify crypto-shredding before hard-delete |
| Merge produces data loss (identity dedup bug)                 | HIGH   | LOW         | INT-02 tests identity dedup explicitly                          |
| Redis cache serves stale contact context                      | MEDIUM | MEDIUM      | INT-04 tests invalidation and fail-open                         |
| Concurrent merges on same contact                             | HIGH   | LOW         | Add distributed lock test scenario                              |

---

## 7. Health Dashboard

| Metric                   | Current                   | Target |
| ------------------------ | ------------------------- | ------ |
| E2E scenarios            | 0                         | 8      |
| Integration scenarios    | 0                         | 7      |
| Unit scenarios           | 3 (encryption only)       | 6      |
| Total test count         | ~15 (encryption + domain) | 80+    |
| Coverage: routes         | 0%                        | 90%    |
| Coverage: use-cases      | 0%                        | 95%    |
| Coverage: infrastructure | 0%                        | 85%    |
