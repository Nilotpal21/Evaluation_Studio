# Search-AI Architecture Review: Phase 4-5 Design

**Reviewer:** Claude (Search-AI Architect)
**Date:** 2026-03-05
**Scope:** Vocabulary resolution service, vocabulary CRUD, query pipeline integration
**Source of Truth:** `docs/RFC_SCHEMA_MAPPING_AND_RETRIEVAL_STRATEGIES.md` by Prasanna Arikala
**Recommendation:** BLOCK (Phase 4-5 deployment until fixes applied)

---

## Summary

Phase 1-3 is solid (99.5% quality, merged to develop). Phase 4-5 has **3 CRITICAL**, **4 HIGH**, and **5 MEDIUM** issues that must be fixed before production. **6 new issues** were found by reading the actual code (not just design docs).

---

## CRITICAL Issues (Must fix before any deployment)

### CRITICAL-1: VocabularyResolver missing tenant isolation

**File:** `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts:125`
**Impact:** Cross-tenant data leak. Any tenant can load another tenant's vocabulary.

```typescript
// CURRENT (VULNERABLE):
private async loadVocabulary(projectKbId: string): Promise<VocabularyEntry[]> {
  const doc = await DomainVocabulary.findOne({
    projectKnowledgeBaseId: projectKbId,
    status: 'active',
    // ❌ MISSING: tenantId filter!
  })
```

The caller chain also doesn't pass `tenantId`:

- `query-pipeline.ts:224` calls `this.vocabularyResolver.resolve(projectKbId, processedQuery)` — no tenantId
- `vocabulary-resolver.ts:32-36` — `resolve()` signature has no tenantId parameter

**Fix:** Add `tenantId` to `resolve()` signature and `loadVocabulary()` query. Update `query-pipeline.ts` to pass `tenantId` (already available at line 107).

---

### CRITICAL-2: No LRU cache in VocabularyResolver

**File:** `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts`
**Impact:** Every query hits MongoDB. RFC target: <10ms p95. Actual: ~80ms.

The `CanonicalMapperService` (`canonical-mapper.service.ts:60-83`) has the exact pattern to follow:

- LRU cache: 500 entries, 5-min TTL, updateAgeOnGet
- Redis pub/sub for distributed invalidation
- Cache metrics (hits, misses, evictions, hitRate)
- Singleton pattern with lazy initialization

`VocabularyResolver` has **none of this**. It's a stateless class instantiated fresh in each `QueryPipeline` constructor (`query-pipeline.ts:64`).

**Fix:** Add LRU cache, make VocabularyResolver a singleton, follow `CanonicalMapperService` pattern exactly.

---

### CRITICAL-3: knowledgeBaseId from request body is unvalidated

**File:** `apps/search-ai-runtime/src/routes/query.ts:68`

```typescript
const response = await queryPipeline.execute(
  { ...body, indexId },
  tenantId,
  callerContext,
  (req.body as any).knowledgeBaseId as string | undefined, // ❌ Unvalidated
  authMode,
  userIdentity,
);
```

The `knowledgeBaseId` (which becomes `projectKbId` in the pipeline) is taken directly from the request body without validation. Combined with CRITICAL-1, an attacker can pass any `projectKbId` to load vocabulary from any project/tenant.

Even after CRITICAL-1 is fixed, this value should be validated against the index's actual project association.

**Fix:** Resolve `projectKbId` from the index configuration (already loaded by `verifyIndexOwnership` middleware), don't accept it from the request body.

---

## HIGH Issues (Fix before production)

### HIGH-1: `console.error` in vocabulary routes and query route

**Files:**

- `apps/search-ai/src/routes/vocabulary.ts:100,143,210,246` — 4 instances
- `apps/search-ai-runtime/src/routes/query.ts:75` — 1 instance

Platform rule: **Never `console.log/error` in server code**. Use `createLogger('module')`.

---

### HIGH-2: No cache invalidation on vocabulary mutation

**File:** `apps/search-ai/src/routes/vocabulary.ts`

All 3 mutation endpoints (POST, POST/bulk, DELETE) modify vocabulary but **do not publish Redis invalidation events**. When LRU cache is added to VocabularyResolver (CRITICAL-2 fix), stale data will be served until TTL expires (5 min).

Compare with mapping routes (`mappings.ts`) which correctly call `canonicalMapperService.invalidateCache()` after every confirm/reject/batch-update.

**Fix:** After each vocabulary mutation, publish to `vocabulary:invalidate` Redis channel with `{ projectKbId, tenantId }`.

---

### HIGH-3: Cross-service cache invalidation gap

**Architecture:**

- Vocabulary CRUD lives in `apps/search-ai` (port 3113) — design-time service
- VocabularyResolver lives in `apps/search-ai-runtime` (port 3114) — query-time service

These are **separate processes**. When search-ai mutates vocabulary, it needs to invalidate search-ai-runtime's cache via Redis pub/sub. Both services connect to the same Redis, so this is achievable but requires:

1. search-ai routes publish to `vocabulary:invalidate` channel
2. search-ai-runtime's VocabularyResolver subscribes to that channel

Neither exists today. The `CanonicalMapperService` pattern works because both publisher and subscriber live in the same process. Vocabulary is split across two services.

**Fix:** Implement Redis pub/sub across service boundaries. Document the channel contract.

---

### HIGH-4: Missing audit logging on vocabulary mutations

**File:** `apps/search-ai/src/services/audit-helpers.ts:183` — `auditVocabularyUpdated()` **exists** but is never called.
**File:** `apps/search-ai/src/routes/vocabulary.ts` — No audit calls in any route handler.

Compliance requirement: all data mutations must be audit-logged.

---

## MEDIUM Issues (Fix before GA)

### MEDIUM-1: Array index-based deletion is fragile

**File:** `apps/search-ai/src/routes/vocabulary.ts:219-249`

DELETE uses `vocab.entries.splice(idx, 1)`. Concurrent operations shift indices, causing wrong entries to be deleted.

**Fix:** Use term-based identification instead of array index.

---

### MEDIUM-2: No Zod validation on vocabulary resolution config

**File:** `apps/search-ai/src/routes/vocabulary.ts:132-134`

`sanitizeObject()` only blocks NoSQL injection. It does not validate that the resolution matches the `VocabularyResolution` discriminated union (filter, aggregate, field, composite).

Invalid configs silently pass through and cause runtime errors in `VocabularyResolver.extractFromResolution()`.

**Fix:** Add Zod schema validation matching the 4 resolution types.

---

### MEDIUM-3: No vocabulary version/activate workflow

**RFC specifies:** `status: 'draft' | 'active'`, `version: number`, versioned snapshots.
**Current:** In-place updates, always `status: 'active'`. No rollback. No review step.

**Fix:** Implement draft/activate workflow with version snapshotting.

---

### MEDIUM-4: VocabularyResolver is not a singleton

**File:** `apps/search-ai-runtime/src/services/query/query-pipeline.ts:64`

A new `VocabularyResolver` is created per `QueryPipeline` instance. Each would have its own cache, defeating the purpose.

**Fix:** Make VocabularyResolver a singleton with lazy initialization (included in CRITICAL-2 fix).

---

### MEDIUM-5: No pagination on vocabulary list endpoint

**File:** `apps/search-ai/src/routes/vocabulary.ts:71-103`

GET endpoint returns all entries at once. No `skip`/`limit` parameters.

---

## INFO Issues

### INFO-1: Query pipeline resilience is well-designed

Vocabulary resolution failure is non-fatal (continues with original query). Permission filter is fail-closed. Preprocessing is non-fatal. Correct RFC-003 intent preservation.

### INFO-2: Embedded array pattern is acceptable for now

500 max entries per vocabulary, ~50KB per document. Would need migration at ~10K+ entries.

### INFO-3: Test coverage is strong (1,069 lines for vocabulary resolver)

Covers exact/alias/fuzzy matching, all resolution types, RFC-003 intent preservation (7 dedicated tests). Tests will need updates after tenant isolation fix.

---

## Priority Fix Order

| #   | Issue                                                 | Severity | Effort          | Blocks             |
| --- | ----------------------------------------------------- | -------- | --------------- | ------------------ |
| 1   | CRITICAL-1: Add tenantId to VocabularyResolver        | CRITICAL | 30 min          | Everything         |
| 2   | CRITICAL-3: Validate projectKbId from index config    | CRITICAL | 1 hour          | Security           |
| 3   | CRITICAL-2: Add LRU cache + singleton + Redis pub/sub | CRITICAL | 4 hours         | Performance        |
| 4   | HIGH-3: Cross-service Redis pub/sub                   | HIGH     | 3 hours         | Cache correctness  |
| 5   | HIGH-2: Invalidation on vocabulary mutation           | HIGH     | 1 hour          | Cache correctness  |
| 6   | HIGH-1: Replace console.error with createLogger       | HIGH     | 30 min          | Observability      |
| 7   | HIGH-4: Wire up audit logging                         | HIGH     | 30 min          | Compliance         |
| 8   | MEDIUM-2: Add Zod validation                          | MEDIUM   | 2 hours         | Data integrity     |
| 9   | MEDIUM-1: Term-based deletion                         | MEDIUM   | 1 hour          | Concurrency safety |
| 10  | MEDIUM-3: Version/activate workflow                   | MEDIUM   | 4 hours         | Operational safety |
| 11  | MEDIUM-4: Singleton VocabularyResolver                | MEDIUM   | (in CRITICAL-2) | —                  |
| 12  | MEDIUM-5: Pagination                                  | MEDIUM   | 1 hour          | Scalability        |

**Total estimated effort: ~19 hours**

---

## New Findings vs. Previous Review (RFC-ARCHITECTURE-REVIEW.md)

| Finding                                    | Previous   | This Review                            |
| ------------------------------------------ | ---------- | -------------------------------------- |
| Missing tenantId                           | Identified | Confirmed + validated caller chain     |
| No LRU cache                               | Identified | Confirmed + singleton gap (MEDIUM-4)   |
| Missing Redis pub/sub                      | Identified | Expanded to cross-service gap (HIGH-3) |
| **CRITICAL-3: Unvalidated projectKbId**    | Not found  | **NEW**                                |
| **HIGH-1: console.error violations**       | Not found  | **NEW — 5 instances**                  |
| **HIGH-4: Audit logging not wired**        | Not found  | **NEW — helper exists, not called**    |
| **MEDIUM-1: Fragile array-index deletion** | Not found  | **NEW**                                |
| **MEDIUM-2: No resolution validation**     | Not found  | **NEW**                                |
| **MEDIUM-3: No version/activate workflow** | Not found  | **NEW**                                |

---

## Phase 1-3 Validation: APPROVE

| Layer                     | RFC Spec                            | Implementation                                             | Verdict                           |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------- | --------------------------------- |
| Layer 1: ConnectorSchema  | Per Connector, at sync              | `connector-schema.model.ts` + `jira-discovery`             | Correct                           |
| Layer 2: CanonicalSchema  | Per KnowledgeBase, at ingestion     | `canonical-schema.model.ts` + `canonical-mapper-worker.ts` | Correct                           |
| Layer 2: FieldMapping     | Source -> Canonical with transforms | `field-mapping.model.ts` + LRU cache + Redis pub/sub       | Correct                           |
| Layer 3: DomainVocabulary | Per ProjectKB, at query time        | `domain-vocabulary.model.ts` + `vocabulary-resolver.ts`    | Model correct, service incomplete |

Service placement matches RFC Section 8:

- Schema Discovery, Canonical Mapping: `apps/search-ai` (ingestion)
- Vocabulary Resolution: `apps/search-ai-runtime` (query)

---

---

## Deferred Items (Track for Phase 4 GA)

### DEFERRED-1: Zod validation on vocabulary resolution config (was MEDIUM-2)

**File:** `apps/search-ai/src/routes/vocabulary.ts`
**What:** `sanitizeObject()` only blocks NoSQL injection. Resolution config not validated against the `VocabularyResolution` discriminated union (filter, aggregate, field, composite). Invalid configs silently pass through.
**Fix:** Add Zod schema validation in vocabulary routes matching the 4 resolution types from `packages/search-ai-sdk/src/types/vocabulary.ts`.
**Effort:** 2 hours
**Priority:** Before GA — prevents runtime errors in `VocabularyResolver.extractFromResolution()`.

### DEFERRED-2: Version/activate workflow for vocabulary (was MEDIUM-3)

**File:** `apps/search-ai/src/routes/vocabulary.ts`, `packages/database/src/models/domain-vocabulary.model.ts`
**What:** RFC specifies `status: 'draft' | 'active'`, `version: number`, versioned snapshots. Current implementation does in-place updates, always `status: 'active'`. No rollback. No review step. Changes take effect immediately.
**Fix:** Implement draft/activate workflow: create new versions as `draft`, add `POST /:indexId/vocabulary/:id/activate` endpoint that sets status to `active` and bumps version. Keep previous active version for rollback.
**Effort:** 4 hours
**Priority:** Before GA — operational safety for production vocabulary management.

### DEFERRED-3: Pagination on vocabulary list endpoint (was MEDIUM-5)

**File:** `apps/search-ai/src/routes/vocabulary.ts` (GET handler)
**What:** GET endpoint returns all entries at once. No `skip`/`limit`/`search` parameters. With 500+ entries (bulk import limit), response sizes become significant.
**Fix:** Add `?page=1&limit=50&search=term` query parameters. Return `{ entries, total, page, limit }`.
**Effort:** 1 hour
**Priority:** Before Studio UI integration (S9).

### DEFERRED-4: Pre-existing console.error in other search-ai-runtime files

**Files:** `routes/aggregate.ts`, `routes/suggest.ts`, `routes/structured.ts`, `services/rerank/reranker-factory.ts`, `services/preprocessing/preprocessing-client.ts`, `middleware/auth.ts`, `server.ts`
**What:** ~15 instances of `console.error`/`console.log`/`console.warn` remain in files not touched by Phase 4 fixes.
**Fix:** Replace with `createLogger()` per platform rule.
**Effort:** 1 hour
**Priority:** Tech debt — non-blocking.

---

**Last Updated:** 2026-03-05
**Status:** CRITICAL/HIGH fixes applied, MEDIUM deferred items tracked above
**Next Review:** Before Phase 4 GA deployment
