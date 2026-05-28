# Architecture Review: RFC-001 Simplify Taxonomy Setup

**Reviewer:** search-ai-architect
**Mode:** Design Review (Post-Revision)
**Domains:** Knowledge Graph, Database, Ingestion Pipeline, Security, Performance, UI/Frontend
**Review Date:** 2026-03-03

---

## Summary

The updated RFC-001 successfully addresses all 13 findings from the initial architecture review and presents a well-structured, security-first approach to simplifying taxonomy setup. The design introduces **5 implementation phases** with clear dependencies, comprehensive testing strategy, and detailed cost/performance analysis. **No blocking issues remain**. The architecture is production-ready after Phase 0 (security hardening + schema migration) completion.

---

## Impact Analysis

### 1. Database Layer (HIGH IMPACT)

**New Collections:**

- `knowledge_graph_domains` (custom domains with audit fields)
- `taxonomy_health_cache` (quality signals with 1-hour TTL)

**Schema Changes:**

```typescript
// IKGProduct - Add subProducts field (BREAKING if not optional)
subProducts?: Array<{
  id: string;
  name: string;
  disambiguationKeywords: string[];
}>;

// IKnowledgeGraphTaxonomy - Add versioning
previousVersions: Array<{
  version: string;
  taxonomy: TaxonomyData;
  createdAt: Date;
  refinementAction?: string;
  rollbackReason?: string;
}>;
```

**Migration Requirements:**

- Mongoose schema update before Phase 1
- Backward compatible (optional fields)
- Existing taxonomies continue working unchanged

**Indexes Required:**

```typescript
// knowledge_graph_domains
{ tenantId: 1, name: 1 } // List custom domains per tenant
{ tenantId: 1, createdAt: -1 } // Recent domains first

// taxonomy_health_cache
{ tenantId: 1, indexId: 1 } // Unique constraint
{ computedAt: 1 }, { expireAfterSeconds: 3600 } // TTL index
```

### 2. Knowledge Graph Worker (MEDIUM IMPACT)

**Modified Workers:**

- `kg-enrichment-worker.ts` - No changes to core logic, but:
  - Reusable for incremental re-classification
  - Must support document subset filtering
  - Job deduplication via `jobId`

**New Workers:**

- `kg-reclassify-worker.ts` (Phase 4) - Handles refinement-triggered re-classification

**Job Flow Changes:**

```
CURRENT: Taxonomy Setup → Full Enrichment (all docs)

PROPOSED: Taxonomy Setup → Full Enrichment → Quality Signals → Refinement → Incremental Re-classification (affected docs only)
```

### 3. Security Layer (CRITICAL IMPACT)

**New Security Mechanisms:**

| Mechanism        | Purpose                                          | Implementation                               | Phase   |
| ---------------- | ------------------------------------------------ | -------------------------------------------- | ------- |
| SSRF Protection  | Block internal network access via URL fetching   | `validateAndFetchURL()` with IP/DNS checks   | Phase 0 |
| Zod Validation   | Reject malformed LLM responses                   | `OrgProfileSchema`, `DomainDefinitionSchema` | Phase 0 |
| Audit Logging    | Track sensitive custom domain operations         | `auditLog()` on create/access/delete         | Phase 0 |
| BullMQ jobId     | Prevent duplicate job processing                 | Idempotent job IDs with timestamp            | Phase 0 |
| Tenant Isolation | All custom domain queries include `{ tenantId }` | Code review + integration tests              | Phase 0 |

**Attack Surface Analysis:**

| Attack Vector                 | Mitigation                                 | Status       |
| ----------------------------- | ------------------------------------------ | ------------ |
| SSRF via URL input            | DNS resolution + IP blocking + size limits | ✅ Mitigated |
| LLM prompt injection          | Input sanitization + output validation     | ✅ Mitigated |
| Cross-tenant data leak        | Tenant filter enforcement                  | ✅ Mitigated |
| Race conditions               | BullMQ jobId deduplication                 | ✅ Mitigated |
| Malicious regex in attributes | Zod validation with pattern limits         | ✅ Mitigated |

### 4. Performance Layer (MEDIUM IMPACT)

**Caching Strategy:**

```typescript
// Quality signals: 1-hour TTL MongoDB cache
// Cost: 5-10s computation on 100K docs
// Without cache: Poor UX (dashboard blocks on load)
// With cache: <100ms dashboard load (80%+ cache hit rate)

interface TaxonomyHealthCache {
  _id: string;
  tenantId: string;
  indexId: string;
  signals: QualitySignals;
  computedAt: Date;
  ttl: 3600; // 1 hour
}
```

**Cost Optimization:**

| Operation                        | Current Cost | Optimized Cost      | Savings      |
| -------------------------------- | ------------ | ------------------- | ------------ |
| Full re-enrichment (1K docs)     | $1.20        | N/A                 | Baseline     |
| Incremental refinement (23 docs) | N/A          | $0.028              | 98%          |
| Quality signal computation       | N/A          | ~$0.001 per 1K docs | Compute only |

**Scalability Validation:**

| Metric                        | 10K docs | 100K docs | 1M docs | Notes              |
| ----------------------------- | -------- | --------- | ------- | ------------------ |
| Quality signal computation    | ~1s      | ~10s      | ~100s   | Needs caching      |
| Incremental re-classification | $0.28    | $2.80     | $28.00  | Linear scaling     |
| Taxonomy versioning overhead  | <1KB     | <10KB     | <100KB  | 10 versions stored |

### 5. UI/Frontend (MEDIUM IMPACT)

**New Components:**

- Seed input form (URL/name+industry/paragraph)
- Generated profile review editor (editable tree + chips)
- Taxonomy Health dashboard (inline signals, not separate tab)
- Refinement action modals ("Add Product", "Add Boundary Rule", "Add Acronym")
- Version history timeline with rollback button

**Validation UX:**

- Inline validation errors (Zod schema feedback)
- Real-time cost estimates for refinement actions
- Rollback confirmation modal with warning

**Architecture Review Recommendations Applied:**

- ✅ Inline health signals (badges on tree nodes) instead of separate tab
- ✅ Cost preview before refinement actions
- ✅ Fallback to manual flow if LLM generation fails

### 6. API Layer (MEDIUM IMPACT)

**New Endpoints:**

| Endpoint                                         | Method | Purpose                        | Phase   |
| ------------------------------------------------ | ------ | ------------------------------ | ------- |
| `/indexes/:indexId/kg-taxonomy/generate-profile` | POST   | Generate org profile from seed | Phase 2 |
| `/indexes/kg-taxonomy/generate-domain`           | POST   | Generate custom domain         | Phase 3 |
| `/indexes/:indexId/kg-taxonomy/health`           | GET    | Get quality signals (cached)   | Phase 4 |
| `/indexes/:indexId/kg-taxonomy/refine`           | POST   | Apply refinement action        | Phase 4 |
| `/indexes/:indexId/kg-taxonomy/rollback`         | POST   | Rollback to previous version   | Phase 4 |

**Authentication:**

- All endpoints require tenant admin role
- Audit logging on sensitive operations

---

## Domain Checklist Validation

### Knowledge Graph Domain ✅ PASS

- [x] Taxonomy setup is idempotent (Phase 0: Zod validation prevents duplicates)
- [x] Entity extraction uses hybrid mode (unchanged, regex + LLM)
- [x] Neo4j queries include tenant filter (unchanged)
- [x] Batch node/relationship creation (unchanged)
- [x] Co-occurrence analysis uses configurable thresholds (unchanged)
- [x] **NEW**: Taxonomy versioning with rollback (Phase 4)
- [x] **NEW**: Incremental re-classification scoped to affected docs (Phase 4)

### Database Domain ✅ PASS

- [x] Uses `getLazyModel()` for all model access (enforced in Phase 0)
- [x] All queries include `{ tenantId }` filter (Section 3.5 enforcement)
- [x] No `findById()` — use `findOne({ _id, tenantId })` (enforced)
- [x] No `.lean()` on encrypted fields (not applicable, custom domains not encrypted)
- [x] Wrapped in `withTenantContext()` for workers (kg-enrichment-worker pattern)
- [x] Indexes support query patterns (TTL index for cache, compound for domains)
- [x] Schema changes consistent with DATABASE-SCHEMA.md (Phase 0 migration documented)

### Security Domain ✅ PASS

- [x] Every DB query includes `{ tenantId }` (Section 3.5 + integration tests)
- [x] No `findById()` anywhere (enforced via code review)
- [x] SSRF protection on outbound HTTP (Section 3.1: validateAndFetchURL())
- [x] No secrets in code (LLM API keys via resolveIndexLLMConfig())
- [x] Cross-tenant access returns 404 not 403 (existing pattern maintained)
- [x] Audit logging for sensitive operations (Section 3.3: custom domain ops)
- [x] **NEW**: Zod validation rejects malformed LLM output (Section 3.2)
- [x] **NEW**: BullMQ jobId prevents race conditions (Section 3.4)

### Performance Domain ✅ PASS

- [x] Batch operations where possible (incremental re-classification batches)
- [x] No N+1 query patterns (quality signals computed once, cached)
- [x] Timeouts on all external calls (LLM: 120s, URL fetch: 10s)
- [x] Queue `close()` called in `finally` blocks (Section 3.4 code example)
- [x] **NEW**: 1-hour TTL cache for quality signals (Section 4.4)
- [x] **NEW**: Cost formulas with breakeven analysis (Section 4.4)

### Ingestion Pipeline Domain ✅ PASS

- [x] Worker follows creation pattern (kg-enrichment-worker unchanged)
- [x] BullMQ job has `jobId` for deduplication (Section 3.4: refinement jobs)
- [x] Queue closed in `finally` block (Section 3.4 code example)
- [x] Error sets `DocumentStatus.ERROR` with descriptive message (unchanged)
- [x] Config-gated features check `getConfig()` (unchanged)
- [x] LLM-gated features check `resolveIndexLLMConfig()` (unchanged)

---

## Adversarial Questions (Updated Analysis)

### 1. What are the top 5 ways this design could fail in production?

| Failure Mode                                                | Likelihood | Impact   | Mitigation in RFC                                                                      |
| ----------------------------------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------- |
| **1. LLM generation quality < 50%**                         | Medium     | High     | Section 5.1: Benchmark dataset + fallback strategy (escalate to Opus or defer feature) |
| **2. Sub-products degrade Haiku accuracy**                  | Medium     | High     | Section 5.2: A/B test required before Phase 1 launch (blocking)                        |
| **3. Quality signal computation times out on 1M-doc index** | Low        | Medium   | Section 4.4: 1-hour TTL cache + async computation after enrichment                     |
| **4. Refinement creates worse taxonomy**                    | Low        | Medium   | Section 4.4: Rollback mechanism stores previous 10 versions                            |
| **5. Custom domains leak across tenants**                   | Very Low   | Critical | Section 3.5: Tenant filter enforcement + integration tests                             |

**Assessment**: All top failure modes have documented mitigations. The design is **robust against common failure patterns**.

### 2. What happens when LLM provider is unavailable for 30 minutes?

**Impact:**

- Taxonomy setup blocked (can't generate org profile or custom domain)
- **Fallback in RFC**: Section 4.1 - fall back to manual org profile entry
- **Good**: Manual flow still works, feature degrades gracefully

**Recommendation**: Add to monitoring:

- LLM availability SLA tracking
- Alert if generation failure rate > 20% in 1 hour
- Automatic fallback notification in UI

### 3. Can tenant A access tenant B's custom domain?

**Answer**: No, if implementation follows RFC.

**Enforcement Mechanisms:**

1. Section 3.5: All queries require `{ _id, tenantId }` filter
2. Integration tests validate tenant isolation (Section 5.3)
3. Code review checklist in Phase 0

**Risk**: Human error during implementation. **Mitigation**: Make `findById()` linter error (add ESLint rule).

### 4. What's the blast radius if taxonomy versioning corrupts data?

**Blast Radius**: Single index affected (not tenant-wide)

**Recovery Paths:**

1. Rollback to previous version (10 versions stored)
2. Delete taxonomy and restart setup (nuclear option)
3. Manual JSON export/import from backup

**Recommendation**: Add to Phase 4:

- Daily backup of all taxonomies to S3
- Point-in-time recovery mechanism

### 5. Will this work at 100x current document volume (10M docs)?

| Component                     | 100K docs | 1M docs       | 10M docs | Bottleneck            |
| ----------------------------- | --------- | ------------- | -------- | --------------------- |
| Quality signal computation    | 10s       | 100s (cached) | 1,000s   | Needs pre-computation |
| Incremental re-classification | $2.80     | $28.00        | $280.00  | Cost acceptable       |
| Taxonomy versioning           | 10KB      | 100KB         | 1MB      | Storage negligible    |
| Custom domain queries         | <10ms     | <10ms         | <10ms    | Indexed, scales well  |

**Recommendation**: At 10M-doc scale, move quality signal computation to **background job** (not on-demand). Trigger after enrichment, store results.

---

## Cross-Cutting Concerns

### Tenant Isolation: ✅ PASS

**Enforcement Mechanisms:**

- Section 3.5: Code examples show correct pattern
- Phase 0: Integration tests validate all custom domain queries
- All new collections include `tenantId` in schema
- No use of `findById()` anywhere in design

**Confidence Level**: High. Design explicitly addresses tenant isolation at every layer.

### Error Handling: ✅ PASS with Recommendations

**Current Design:**

- SSRF validation throws `ValidationError`
- Zod validation throws `ZodError` → converted to `ValidationError`
- LLM generation fallback to manual flow (Section 4.1)
- Refinement job failures logged + mark documents with error status

**Missing (Recommendations):**

- **Circuit breaker** for LLM API calls (protect against cascading failures)
- **Dead letter queue** for failed refinement jobs (manual review)
- **Exponential backoff** for URL fetching (already in BullMQ, but not in fetch)

**Add to Phase 2:**

```typescript
// In org-profile-generator.service.ts
const circuitBreaker = new CircuitBreaker(llmClient.chat, {
  timeout: 120_000,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
});
```

### Observability: ⚠️ NEEDS ENHANCEMENT

**Current Design:**

- Success metrics defined (Section 9)
- Audit logging for custom domains (Section 3.3)
- Telemetry mentioned (Phase 2: track generation success rate)

**Missing:**

- **Trace events** for taxonomy operations (create, refine, rollback)
- **Prometheus metrics** for LLM cost per tenant
- **Dashboard** showing taxonomy health trends over time
- **Alerting** for quality signal degradation

**Recommendation - Add to Section 5:**

```typescript
interface TaxonomyTraceEvent {
  eventType: 'taxonomy_setup' | 'taxonomy_refined' | 'taxonomy_rolled_back';
  tenantId: string;
  indexId: string;
  metadata: {
    generatedBy?: 'llm' | 'manual';
    refinementAction?: string;
    llmCost?: number;
    qualitySignals?: QualitySignals;
  };
}
```

### Testing Coverage: ✅ EXCELLENT

**Comprehensive Testing Strategy:**

- Section 5.1: Benchmark dataset (12 ground truth org profiles)
- Section 5.2: A/B test plan for sub-products (1,000 docs, 5 industries)
- Section 5.3: Integration tests (SSRF, Zod, BullMQ dedup, rollback)

**Test Coverage Estimate:**

- Security: 95% (SSRF, validation, tenant isolation)
- Functionality: 80% (generation, refinement, rollback)
- Performance: 70% (caching, cost optimization)

**Confidence Level**: Very High. Testing strategy exceeds typical RFC rigor.

---

## Consistency with Existing Architecture

### ✅ Reuses Existing Patterns

| Pattern                   | Existing Use              | RFC Usage                             |
| ------------------------- | ------------------------- | ------------------------------------- |
| `getLazyModel()`          | All Search-AI models      | Custom domains, taxonomy health cache |
| `withTenantContext()`     | All Search-AI workers     | Refinement worker                     |
| `resolveIndexLLMConfig()` | Progressive summarization | Org profile generation (Phase 2)      |
| BullMQ `jobId`            | All ingestion workers     | Refinement jobs (Section 3.4)         |
| `ValidationError`         | All service layers        | SSRF, Zod validation failures         |
| TTL indexes               | SearchChunk cleanup       | Taxonomy health cache                 |

### ⚠️ Introduces New Patterns (Acceptable)

| New Pattern                   | Justification                  | Risk                           |
| ----------------------------- | ------------------------------ | ------------------------------ |
| Zod validation for LLM output | Stronger validation than regex | Low (industry standard)        |
| Taxonomy versioning           | Enables rollback               | Low (similar to git history)   |
| Quality signal caching        | Performance optimization       | Low (standard caching pattern) |

**Assessment**: New patterns are well-justified and align with industry best practices.

---

## Recommendations

### 1. APPROVE FOR IMPLEMENTATION ✅

All CRITICAL, HIGH, and MEDIUM findings from initial review have been addressed. The design is production-ready after Phase 0 completion.

### 2. Before Phase 0 Launch:

- [ ] Add ESLint rule: `no-restricted-syntax` for `findById()` calls
- [ ] Create integration test suite for tenant isolation (10+ test cases)
- [ ] Document SSRF protection in security runbook
- [ ] Add circuit breaker to LLM API calls

### 3. Before Phase 1 Launch:

- [ ] Complete A/B test (blocking requirement)
- [ ] If A/B test fails: Do NOT implement sub-products, keep 11 flat products
- [ ] Validate benchmark dataset quality (12 ground truth profiles)

### 4. Before Phase 4 Launch:

- [ ] Add trace events for taxonomy operations
- [ ] Create taxonomy health trend dashboard
- [ ] Set up alerting for quality signal degradation
- [ ] Implement dead letter queue for failed refinement jobs

### 5. Future Enhancements (Post-Launch):

- Daily taxonomy backup to S3 (DR strategy)
- Background quality signal computation for 10M+ doc indexes
- Community domain templates (if adoption data supports)
- LLM response streaming for faster UX (Phase 2)

---

## Risk Assessment Matrix

| Risk Category                   | Severity | Likelihood | Mitigation Quality            | Residual Risk |
| ------------------------------- | -------- | ---------- | ----------------------------- | ------------- |
| Security (SSRF)                 | Critical | Low        | Excellent (DNS + IP blocking) | Minimal       |
| Security (Tenant Isolation)     | Critical | Low        | Excellent (enforced + tested) | Minimal       |
| Data Integrity (LLM validation) | High     | Medium     | Excellent (Zod schemas)       | Low           |
| Performance (Cache)             | Medium   | Medium     | Good (1-hour TTL)             | Low           |
| Cost (Sub-products)             | Medium   | Medium     | Good (A/B test gated)         | Low           |
| Operability (Rollback)          | Medium   | Low        | Good (10 versions)            | Low           |

**Overall Risk Level**: **LOW** ✅

---

## Final Recommendation

**Status**: **APPROVED FOR IMPLEMENTATION**

**Rationale**:

1. All 13 architecture review findings resolved
2. Comprehensive security hardening (SSRF, validation, audit logging)
3. Robust testing strategy (benchmarks, A/B tests, integration tests)
4. Clear phase dependencies with blocking requirements
5. Cost optimization with detailed formulas
6. Performance caching strategy
7. Rollback mechanism for safety

**Next Steps**:

1. ✅ Create Phase 0 implementation ticket
2. ✅ Schedule architecture review checkpoint after Phase 0
3. ✅ Begin benchmark dataset creation (12 org profiles)
4. ✅ Design A/B test infrastructure

**Architecture Review Sign-Off**: search-ai-architect
**Date**: 2026-03-03
**Recommendation**: Proceed with implementation

---

**End of Architecture Review**
