# ABLP-303: Neo4j → MongoDB RACL Migration — Implementation Tasks

**Branch:** `feature/neo4j-to-mongo-racl`
**Date:** 2026-04-11
**Goal:** Replace Neo4j entirely with MongoDB for connector RACL (Resource Access Control List). Production-ready, not phased.

---

## Architecture Summary

**What Neo4j does today (to be replaced):**

1. Stores User nodes (email, groups, domain) — written by IdP sync workers
2. Stores Group nodes + MEMBER_OF edges — written by group sync workers
3. Stores Document nodes + HAS_PERMISSION edges — written by SharePoint permission crawler
4. Resolves user's effective groups at query time via `MEMBER_OF*1..20` traversal
5. Resolves document permissions for OpenSearch indexing via `getFlattenedPermissions()`

**What replaces it (MongoDB):**

1. `contacts` collection — extended with `sourceIdentities[]`, `acl{}` fields (unified contact card)
2. `acl_group_hierarchy` collection — NEW, stores group tree for BFS pre-computation
3. `acl_document_permissions` collection — NEW, stores per-document permissions
4. BFS pre-computation at sync time → writes `acl.effectiveGroups` on contact card
5. Query-time reads from contact card (1-3ms) instead of Neo4j traversal (20-50ms)

**What does NOT change:**

- OpenSearch schema (permissions fields on chunks stay identical)
- OpenSearch query structure (4-clause bool filter stays identical)
- Runtime session resolver / contact creation flow (already works)
- Channel webhook processing

---

## Phase 1: MongoDB Models + Collections + Indexes

### Task 1.1: Create `acl_group_hierarchy` Mongoose model

- **File:** `packages/database/src/models/acl-group-hierarchy.model.ts`
- **Schema:** `{ tenantId, groupId, source, displayName, email, parentGroups[], childGroups[], directMemberEmails[], lastSyncAt }`
- **Indexes:** `{ tenantId: 1, groupId: 1 }` UNIQUE, `{ tenantId: 1, source: 1 }`
- **Export from:** `packages/database/src/models/index.ts`

### Task 1.2: Create `acl_document_permissions` Mongoose model

- **File:** `packages/database/src/models/acl-document-permissions.model.ts`
- **Schema:** `{ tenantId, documentId, source, allowedUsers[{ email, role, grantedAt }], allowedGroups[{ groupId, role, grantedAt }], allowedDomains[], publicInDomain, publicEverywhere, lastPermissionCrawlAt }`
- **Indexes:** `{ tenantId: 1, documentId: 1 }` UNIQUE
- **Export from:** `packages/database/src/models/index.ts`

### Task 1.3: Extend Contact model with `sourceIdentities[]` and `acl{}`

- **File:** `packages/database/src/models/contact.model.ts`
- **Add:** `sourceIdentities[]` subdocument (source, sourceUserId, encryptedEmail, blindIndex, displayName, resolved, lastSyncAt)
- **Add:** `acl{}` subdocument (effectiveGroups[], directGroups[{ group, source, addedAt }], domain, effectiveGroupsComputedAt, syncVersion)
- **New indexes:** `{ tenantId: 1, "sourceIdentities.source": 1, "sourceIdentities.sourceUserId": 1 }`, `{ tenantId: 1, "sourceIdentities.blindIndex": 1 }`, `{ tenantId: 1, "acl.domain": 1 }`
- **Also update:** domain types in `apps/runtime/src/contexts/contact/domain/contact.ts`

---

## Phase 2: MongoDB Permission Store (replaces PermissionGraphService)

### Task 2.1: Create `MongoPermissionStore` service

- **File:** `packages/search-ai-internal/src/permissions/mongo-permission-store.ts`
- **Purpose:** Drop-in replacement for PermissionGraphService methods that are called by workers and query service
- **Methods:**
  - `upsertUser(input)` → find/create contact by email blindIndex, upsert sourceIdentities
  - `upsertGroup(input)` → upsert acl_group_hierarchy document
  - `upsertDocument(input)` → upsert acl_document_permissions (not Neo4j Document node)
  - `setPermission(input)` → update acl_document_permissions (add user/group to allowed lists)
  - `removeAllDocumentPermissions(tenantId, documentId)` → clear allowed lists on acl_document_permissions
  - `setMembership(input)` → add group to contact.acl.directGroups + trigger BFS
  - `removeMembership(input)` → remove group from contact.acl.directGroups + trigger BFS
  - `getUserGroups(tenantId, email)` → read contact.acl.effectiveGroups (pre-computed, no traversal)
  - `getFlattenedPermissions(tenantId, documentId)` → read acl_document_permissions (replaces Neo4j 4-match Cypher)
  - `setPublicInDomain(tenantId, documentId, domain)` → update acl_document_permissions
  - `deleteDocument(tenantId, documentId)` → remove acl_document_permissions entry
- **Also:** Circuit breaker + retry logic (carry over from PermissionGraphService)

### Task 2.2: Create BFS effective groups computation service

- **File:** `packages/search-ai-internal/src/permissions/effective-groups-compute.ts`
- **Purpose:** Pre-compute transitive group closure at sync time
- **Methods:**
  - `computeEffectiveGroups(tenantId, directGroups[], groupHierarchy)` → BFS with cycle detection, max depth 20
  - `recomputeForUser(tenantId, contactId)` → load hierarchy, BFS, write to contact.acl.effectiveGroups
  - `recomputeForTenant(tenantId)` → bulk recompute all users in tenant (after hierarchy change)
  - `loadGroupHierarchy(tenantId)` → load full hierarchy into in-memory Map

### Task 2.3: Update PermissionGraphService exports / create adapter

- **File:** `packages/search-ai-internal/src/permissions/index.ts`
- **Action:** Export `MongoPermissionStore` alongside (or replacing) `PermissionGraphService`
- **Goal:** All consumers that import from `@agent-platform/search-ai-internal/permissions` get the MongoDB version
- **Strategy:** `MongoPermissionStore` implements the same public API as `PermissionGraphService` so callers don't change

---

## Phase 3: Worker Rewrites (Design-Time Write Path)

### Task 3.1: Rewrite Azure AD User Sync Worker

- **File:** `apps/search-ai/src/workers/azuread-user-sync-worker.ts`
- **Change:** Replace `permissionService.upsertUser()` (Neo4j) with `mongoPermissionStore.upsertUser()` (MongoDB contact card)
- **Add:** Read `proxyAddresses`, `otherMails`, `mobilePhone` from Graph API `$select`
- **Add:** For each additional email/phone, add as identity on contact card (enables cross-identity merge)

### Task 3.2: Rewrite Azure AD Group Sync Worker

- **File:** `apps/search-ai/src/workers/azuread-group-sync-worker.ts`
- **Change:** Replace Neo4j group writes with `acl_group_hierarchy` MongoDB writes
- **Add:** After group sync, trigger BFS recomputation for affected users → write `acl.effectiveGroups` on contact cards
- **Add:** Redis cache invalidation for affected users

### Task 3.3: Rewrite Okta User + Group Sync Workers

- **Files:** `apps/search-ai/src/workers/okta-user-sync-worker.ts`, `okta-group-sync-worker.ts`
- **Same pattern as Azure AD:** Replace Neo4j calls with MongoDB contact card + acl_group_hierarchy

### Task 3.4: Rewrite Google User + Group Sync Workers

- **Files:** `apps/search-ai/src/workers/google-user-sync-worker.ts`, `google-group-sync-worker.ts`
- **Same pattern as Azure AD/Okta**

### Task 3.5: Rewrite SharePoint Permission Crawler

- **File:** `packages/connectors/sharepoint/src/permissions/sharepoint-permission-crawler.ts`
- **Change:** Replace all `permissionService.upsertUser/upsertGroup/setPermission/setMembership` (Neo4j) with MongoDB equivalents
- **Document permissions:** Write to `acl_document_permissions` instead of Neo4j Document nodes + HAS_PERMISSION edges
- **User discovery:** Find/create contact cards for users discovered in document permissions
- **Group resolution:** Write to `acl_group_hierarchy` + trigger BFS

### Task 3.6: Rewrite Document Permission Resolver (for embedding worker)

- **File:** `apps/search-ai/src/services/document-permissions/document-permission-resolver.ts`
- **Change:** Replace `permissionService.getFlattenedPermissions()` (Neo4j 4-match Cypher) with `acl_document_permissions.findOne()` (MongoDB 1-3ms)
- **Fix:** Change fail-open `publicEverywhere: true` fallback to fail-closed `publicEverywhere: false`

### Task 3.7: Rewrite Permission Recrawl Worker

- **File:** `apps/search-ai/src/workers/permission-recrawl-worker.ts`
- **Change:** Use MongoDB permission store instead of Neo4j for recrawl operations

---

## Phase 4: Query-Time Read Path (Runtime)

### Task 4.1: Rewrite Permission Filter Service in SearchAI-Runtime

- **File:** `apps/search-ai-runtime/src/services/query/permission-filter-service.ts`
- **Change:** Replace `getPermissionGraph().getUserGroups()` (Neo4j) with 3-tier resolution:
  - Tier 1: JWT groups claim (0ms) — extract from IdP token
  - Tier 2: Redis cache (0.5ms) — existing cache pattern
  - Tier 3: Contact card `findOne()` → `acl.effectiveGroups` (1-3ms)
- **Keep:** Same OpenSearch 4-clause bool filter construction
- **Keep:** Redis caching pattern (same keys, same TTL)

### Task 4.2: Extend IdP Token Validator for JWT groups

- **File:** `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`
- **Add:** Extract `groups` claim from Azure AD / Okta JWTs
- **Add:** `groups?: string[]` field to `UserIdentity` interface
- **Handle:** Azure AD `hasgroups: true` (>200 groups → fall through to Tier 2/3)

### Task 4.3: Extend Permission Filter Middleware

- **File:** `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts`
- **Add:** Support for `X-Auth-Mode: "contact"` + `X-Contact-Id` header (contact-based resolution)
- **Add:** Support for `X-User-Email` + `X-User-Groups` + `X-User-Domain` headers (pre-resolved by Runtime)
- **Keep:** Existing `X-Auth-Mode: "user"` + `X-End-User-Token` path (backward compatible)

### Task 4.4: Add Identity Bridge to SearchAI KB Tool Executor

- **File:** `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
- **Add:** Load contact card from `session.contactId` → extract email, groups, domain
- **Add:** Pass permission context to SearchAI-Runtime via headers
- **Cache:** Contact ACL data on session object (loaded once, reused for all KB tool calls in conversation)

---

## Phase 5: Server Initialization + Cleanup

### Task 5.1: Update SearchAI server initialization

- **File:** `apps/search-ai/src/server.ts`
- **Change:** Replace Neo4j connection initialization with MongoDB permission store initialization
- **Remove:** Neo4j health check from startup
- **Keep:** All other initialization (Redis, OpenSearch, BullMQ)

### Task 5.2: Update SearchAI-Runtime server initialization

- **File:** `apps/search-ai-runtime/src/server.ts`
- **Change:** Replace Neo4j connection (if any) with MongoDB connection for contact card reads

### Task 5.3: Update health checks

- **File:** `apps/runtime/src/health/service-registry.ts` (and any other health check files)
- **Remove:** Neo4j from health check registry
- **Add:** MongoDB acl collections health check (optional — MongoDB is already checked)

### Task 5.4: Update docker-compose.yml

- **Note:** Do NOT remove Neo4j container yet (other features like KG taxonomy may still use it)
- **Action:** Verify SearchAI permissions work without Neo4j running

---

## Phase 6: Tests

### Task 6.1: Create unit tests for MongoPermissionStore

- **File:** `packages/search-ai-internal/src/permissions/__tests__/mongo-permission-store.test.ts`
- **Cover:** All CRUD operations, BFS computation, edge cases (empty groups, cycle detection, max depth)

### Task 6.2: Create unit tests for BFS effective groups computation

- **File:** `packages/search-ai-internal/src/permissions/__tests__/effective-groups-compute.test.ts`
- **Cover:** Linear chain, diamond hierarchy, cycle detection, max depth 20, empty groups, single group

### Task 6.3: Update existing worker tests

- **Files:** Worker test files in `apps/search-ai/src/workers/__tests__/`
- **Change:** Update mocks from Neo4j PermissionGraphService to MongoDB MongoPermissionStore

### Task 6.4: Update permission filter service tests

- **File:** `apps/search-ai-runtime/src/services/query/` tests
- **Change:** Test 3-tier resolution (JWT → Redis → MongoDB)

### Task 6.5: Update SharePoint permission crawler tests

- **File:** `packages/connectors/sharepoint/src/__tests__/sharepoint-permission-crawler.test.ts`
- **Change:** Verify MongoDB writes instead of Neo4j writes

---

## Phase 7: Verification + Documentation

### Task 7.1: Build verification

- Run `pnpm build` for all affected packages
- Verify zero TypeScript errors

### Task 7.2: Test suite verification

- Run `pnpm test` for affected packages
- Verify all tests pass

### Task 7.3: Query optimization review

- Verify all MongoDB queries have appropriate indexes
- Check explain plans for key queries (findByBlindIndex, effectiveGroups lookup, document permission lookup)

### Task 7.4: Create feature completion doc

- **File:** `docs/architecture/neo4j-to-mongo-racl-completion.md`
- Document: what was replaced, what was kept, migration notes, performance expectations
- Checklist: every Neo4j call site verified replaced

---

## Files Affected (Summary)

| Package/App                      | Files                                                            | Change Type  |
| -------------------------------- | ---------------------------------------------------------------- | ------------ |
| `packages/database`              | 3 files (2 new models + contact model extension)                 | NEW + MODIFY |
| `packages/search-ai-internal`    | 4 files (mongo store, BFS compute, index, types)                 | NEW + MODIFY |
| `packages/connectors/sharepoint` | 1 file (permission crawler)                                      | MODIFY       |
| `apps/search-ai`                 | 8 files (6 sync workers + server + document-permission-resolver) | MODIFY       |
| `apps/search-ai-runtime`         | 3 files (permission filter service, middleware, server)          | MODIFY       |
| `apps/runtime`                   | 2 files (searchai-kb-tool-executor, health)                      | MODIFY       |
| Tests                            | ~10 files                                                        | NEW + MODIFY |
| Docs                             | 1 file (completion doc)                                          | NEW          |

**Total:** ~32 files across 6 packages/apps

---

## Commit Strategy

Each commit focused on one concern, max 40 files, max 3 packages:

1. `[ABLP-303] feat(database): add acl_group_hierarchy and acl_document_permissions models + extend contact model`
2. `[ABLP-303] feat(search-ai-internal): add MongoPermissionStore and BFS effective groups computation`
3. `[ABLP-303] refactor(search-ai): rewrite azuread user+group sync workers for MongoDB`
4. `[ABLP-303] refactor(search-ai): rewrite okta+google sync workers for MongoDB`
5. `[ABLP-303] refactor(connectors/sharepoint): rewrite permission crawler for MongoDB`
6. `[ABLP-303] refactor(search-ai): rewrite document-permission-resolver + permission-recrawl-worker`
7. `[ABLP-303] feat(search-ai-runtime): 3-tier permission resolution (JWT → Redis → MongoDB contact card)`
8. `[ABLP-303] feat(runtime): add identity bridge in SearchAI KB tool executor`
9. `[ABLP-303] refactor(search-ai,search-ai-runtime): update server initialization, remove Neo4j dependency`
10. `[ABLP-303] test(search-ai-internal): add MongoPermissionStore + BFS unit tests`
11. `[ABLP-303] test(search-ai,connectors): update worker + crawler tests for MongoDB`
12. `[ABLP-303] docs: add neo4j-to-mongo-racl completion doc`
