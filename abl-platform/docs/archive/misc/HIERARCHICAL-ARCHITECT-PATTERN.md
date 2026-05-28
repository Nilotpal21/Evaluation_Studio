# Hierarchical Architect Pattern for Code Review

**Date:** 2026-03-03
**Purpose:** Research and design proposal for "Architect of Architects" pattern
**Objective:** Delegate specialized architecture reviews based on change scope

---

## Executive Summary

**Pattern:** **Master Architect** delegates to specialized domain architects based on change analysis.

**Benefits:**

- ✅ Deeper domain expertise per subsystem
- ✅ Parallel review of multi-domain changes
- ✅ Consistent patterns within each domain
- ✅ Scalable as system grows
- ✅ Clear ownership and accountability

**Inspiration:** Software architecture patterns (SAFe, C4 Model), Anthropic Claude research on multi-agent systems

---

## 1. Pattern Overview

### Traditional Single-Reviewer Approach

```
Developer → Code Review → Single Architect → Approval/Feedback
```

**Problems:**

- One architect must know entire system deeply
- Bottleneck on complex changes touching multiple domains
- Expertise dilution (generalist vs specialist)
- Review fatigue on large changesets

### Hierarchical Architect Approach

```
Developer → Code Review → Master Architect
                               ↓
                    ┌──────────┼───────────┐
                    ↓          ↓           ↓
            Ingestion    Query Pipeline  Database
            Architect     Architect      Architect
                    ↓          ↓           ↓
            Specialized  Specialized  Specialized
            Review       Review       Review
                    ↓          ↓           ↓
                    └──────────┴───────────┘
                               ↓
                    Master Architect (synthesis)
                               ↓
                    Approval/Feedback
```

---

## 2. Architect Hierarchy for Search-AI

### Level 1: Master Architect

**Role:** System-wide concerns, coordination, final approval

**Responsibilities:**

- Analyze change scope → delegate to domain architects
- Ensure cross-domain consistency
- Resolve conflicts between domain architects
- Approve/reject based on synthesized feedback
- Maintain system-level invariants (tenant isolation, security, scalability)

**Skills Required:**

- `search-ai-architecture-reviewer` (system-wide)
- `platform-principles` (tenant isolation, auth, compliance)
- Understanding of all domain boundaries

---

### Level 2: Domain Architects (Specialists)

#### 2.1 Ingestion Pipeline Architect

**Scope:** Document ingestion, extraction, processing, workers

**File Patterns:**

- `apps/search-ai/src/workers/*-worker.ts`
- `apps/search-ai/src/services/extraction/*`
- `apps/search-ai/src/services/canonical-mapper/*`
- `apps/search-ai/src/services/progressive-summarization/*`
- `apps/search-ai/src/services/question-synthesis/*`

**Review Focus:**

- Worker design (concurrency, error handling, retry logic)
- Pipeline integration (stage ordering, branching points)
- BullMQ queue usage (job data, queue names, priorities)
- Document/chunk status state machines
- LLM integration (credential resolution, cost tracking)
- Phase 2 LLM features (summarization, question synthesis)

**Key Patterns:**

- Config-gated features (`getConfig()`)
- LLM-gated features (`resolveIndexLLMConfig()`)
- Dual-database access (`getLazyModel()`)
- Tenant isolation in worker jobs

---

#### 2.2 Query Pipeline Architect

**Scope:** Query-time retrieval, caching, reranking, result assembly

**File Patterns:**

- `apps/search-ai-runtime/src/services/query/*`
- `apps/search-ai-runtime/src/services/rerank/*`
- `apps/search-ai-runtime/src/services/cache/*`
- `packages/search-ai-internal/src/retrieval/*`
- `packages/search-ai-internal/src/vocabulary/*`

**Review Focus:**

- 6-stage query pipeline (preprocessing → vocabulary → embedding → vector search → rerank → format)
- Cache strategies (QueryCache, RequestCache, dual-tier)
- Performance targets (<500ms p95)
- Batched reranker optimization (85% API call reduction)
- Tenant isolation in queries
- Cost calculation accuracy

**Key Patterns:**

- Hybrid retrieval (vector + BM25)
- RRF fusion
- Circuit breakers for external APIs
- Request deduplication (SHA256 hashing)

---

#### 2.3 Database Architect

**Scope:** Data models, migrations, dual-database architecture, query optimization

**File Patterns:**

- `packages/database/src/mongo/models/*`
- `packages/database/src/mongo/plugins/*`
- `packages/database/src/clickhouse/*`
- `apps/search-ai/src/db/index.ts` (model binding)

**Review Focus:**

- Dual-database separation (`abl_platform` vs `search_ai`)
- Model registry usage (`getLazyModel()`, `bindModelsForSearchAI()`)
- Mongoose plugins (tenant isolation, audit trail, encryption)
- Index design and query performance
- Data retention policies (TTLs, cascading deletes)
- Schema migrations

**Key Patterns:**

- Never import models directly from `@agent-platform/database`
- Always use `withTenantContext()` for queries
- Tenant isolation in all queries (`{ tenantId }` filter)
- Encrypted fields require full Mongoose documents (no `.lean()`)

---

#### 2.4 Vector Store Architect

**Scope:** OpenSearch, embeddings, index management, HNSW tuning

**File Patterns:**

- `packages/search-ai-internal/src/vector-store/*`
- `packages/search-ai-internal/src/embedding/*`
- `apps/search-ai/src/workers/embedding-worker.ts`
- `packages/search-ai-internal/src/vector-store/index-registry.ts`

**Review Focus:**

- OpenSearch index strategies (shared vs dedicated)
- Vector dimensions and distance metrics
- HNSW parameters (`ef_search`, `m`, `ef_construction`)
- Embedding provider integration (BGE-M3, OpenAI, custom)
- Batch processing (size 8 CPU, 32 GPU)
- Index rotation and versioning (IndexRegistry)

**Key Patterns:**

- Tenant-aware index routing
- Graceful degradation on vector store failures
- Embedding provider connection pooling
- Cost tracking per embedding provider

---

#### 2.5 Knowledge Graph Architect

**Scope:** Neo4j, entity extraction, taxonomy, co-occurrence analysis

**File Patterns:**

- `apps/search-ai/src/services/knowledge-graph/*`
- `apps/search-ai/src/workers/kg-enrichment-worker.ts`
- `apps/search-ai/src/workers/knowledge-graph-worker.ts`
- `apps/search-ai/src/workers/taxonomy-setup-worker.ts`

**Review Focus:**

- Entity extraction methods (regex, NLP, LLM)
- Reference extraction patterns
- Neo4j graph structure (nodes, relationships, properties)
- Co-occurrence analysis algorithms
- Taxonomy generation (LLM-powered)
- Graph traversal performance

**Key Patterns:**

- Hybrid entity extraction (regex + Compromise NLP)
- Cypher query optimization
- Batch node/relationship creation
- Tenant isolation in graph queries

---

#### 2.6 Connector Architect

**Scope:** External connectors, sync strategies, permission crawling

**File Patterns:**

- `apps/search-ai/src/workers/connector-sync-worker.ts`
- `apps/search-ai/src/workers/connector-permission-crawl-worker.ts`
- `apps/search-ai/src/services/connectors/*`

**Review Focus:**

- Connector API integration (Google Drive, SharePoint, etc.)
- Incremental sync strategies (full vs delta)
- Permission preservation and sync
- Rate limiting and quota management
- Webhook handling for real-time updates
- Connector credential management

**Key Patterns:**

- OAuth flow for connector auth
- Cursor-based pagination for sync
- Permission mapping (source → platform)
- Error recovery and retry logic

---

#### 2.7 Performance Architect

**Scope:** Profiling, optimization, cost analysis, scalability

**Cross-cutting:** All domains

**Review Focus:**

- Throughput targets (docs/second, queries/second)
- Latency budgets (<500ms query, <5s extraction)
- Cost per operation (LLM calls, embeddings, storage)
- Resource utilization (CPU, memory, Redis, OpenSearch)
- Bottleneck identification
- Scalability analysis (1M docs → 100M docs)

**Key Patterns:**

- Batch operations (bulk inserts, pipeline queries)
- Connection pooling
- Circuit breakers
- Async compression before storage
- Query result pagination

---

#### 2.8 Security Architect

**Scope:** Tenant isolation, authentication, encryption, compliance

**Cross-cutting:** All domains

**Review Focus:**

- Tenant isolation (DB queries, Redis keys, cache keys)
- Authentication flows (JWT, session tokens, API keys)
- Encryption at rest (field-level, full-document)
- Encryption in transit (TLS)
- SSRF protection (outbound HTTP from tools)
- PII handling (data minimization, TTLs, right to erasure)

**Key Patterns:**

- Every DB query includes `{ tenantId }` filter
- Redis keys prefixed with `tenant:${tenantId}:`
- Field-level encryption via Mongoose plugin
- SSRF protection on tool HTTP calls
- Audit logging for sensitive operations

---

## 3. Delegation Algorithm

### Master Architect Change Analysis

```typescript
interface ChangeAnalysis {
  files: string[];
  domains: DomainScope[];
  complexity: 'low' | 'medium' | 'high';
  crossDomain: boolean;
}

function analyzePullRequest(pr: PullRequest): ChangeAnalysis {
  const domains = detectDomains(pr.files);
  const complexity = calculateComplexity(pr);
  const crossDomain = domains.length > 1;

  return { files: pr.files, domains, complexity, crossDomain };
}

function detectDomains(files: string[]): DomainScope[] {
  const domains: Set<DomainScope> = new Set();

  for (const file of files) {
    if (file.includes('workers/') && file.endsWith('-worker.ts')) {
      domains.add('ingestion');
    }
    if (file.includes('search-ai-runtime/src/services/query/')) {
      domains.add('query-pipeline');
    }
    if (file.includes('database/src/mongo/models/')) {
      domains.add('database');
    }
    if (file.includes('vector-store/')) {
      domains.add('vector-store');
    }
    if (file.includes('knowledge-graph/')) {
      domains.add('knowledge-graph');
    }
    if (file.includes('connectors/')) {
      domains.add('connector');
    }
    // Cross-cutting concerns
    if (hasSecurityImplications(file)) {
      domains.add('security');
    }
    if (hasPerformanceImplications(file)) {
      domains.add('performance');
    }
  }

  return Array.from(domains);
}
```

### Delegation Strategy

```typescript
type DomainScope =
  | 'ingestion'
  | 'query-pipeline'
  | 'database'
  | 'vector-store'
  | 'knowledge-graph'
  | 'connector'
  | 'security'
  | 'performance';

interface ReviewTask {
  domain: DomainScope;
  architect: string; // Skill name
  files: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

function delegateReviews(analysis: ChangeAnalysis): ReviewTask[] {
  const tasks: ReviewTask[] = [];

  for (const domain of analysis.domains) {
    const architect = getArchitectForDomain(domain);
    const domainFiles = filterFilesByDomain(analysis.files, domain);
    const priority = calculatePriority(domain, analysis.complexity);

    tasks.push({ domain, architect, files: domainFiles, priority });
  }

  // Always include security review if changes touch sensitive areas
  if (touchesSensitiveArea(analysis.files)) {
    tasks.push({
      domain: 'security',
      architect: 'search-ai-security-architect',
      files: analysis.files,
      priority: 'critical',
    });
  }

  return tasks;
}
```

---

## 4. Implementation as Claude Skills

### Master Architect Skill

```markdown
---
name: search-ai-master-architect
description: Coordinate code reviews across Search-AI domains. Analyzes changes, delegates to specialized architects, synthesizes feedback.
---

# Search-AI Master Architect

## Responsibilities

1. **Analyze Pull Request:**
   - Detect affected domains (ingestion, query, database, etc.)
   - Calculate complexity (LOC, files changed, domain count)
   - Identify cross-domain dependencies

2. **Delegate Reviews:**
   - Assign domain-specific reviews to specialized architects
   - Prioritize security/performance reviews for sensitive changes
   - Request parallel reviews for multi-domain changes

3. **Synthesize Feedback:**
   - Collect feedback from all domain architects
   - Resolve conflicts between domain recommendations
   - Identify missing concerns not covered by domain reviews

4. **Final Approval:**
   - Approve if all domain architects approve + system-level checks pass
   - Block if any critical issues found
   - Request changes with consolidated feedback

## Review Process

### Step 1: Analyze Change Scope

[Use detectDomains() algorithm]

### Step 2: Delegate to Domain Architects

[Invoke domain-specific skills in parallel]

### Step 3: Synthesize

[Collect results, check for conflicts]

### Step 4: System-Level Checks

- Tenant isolation across all changes
- No breaking API changes without migration plan
- Documentation updated
- Tests added/updated

### Step 5: Approve or Block

[Provide consolidated feedback]
```

### Domain Architect Skills

Each domain gets a skill file:

```markdown
---
name: search-ai-ingestion-architect
description: Review ingestion pipeline changes (workers, extraction, processing).
---

# Search-AI Ingestion Architect

[Domain-specific checklist and patterns]
```

---

## 5. Benefits of Hierarchical Pattern

### For Developers

- ✅ **Faster reviews:** Parallel domain reviews instead of sequential
- ✅ **Better feedback:** Specialized expertise per domain
- ✅ **Clear expectations:** Domain-specific checklists
- ✅ **Learning:** See feedback from multiple perspectives

### For Architects

- ✅ **Focused expertise:** Deep dive into specific domains
- ✅ **Reduced cognitive load:** Don't need to track entire system
- ✅ **Parallel work:** Multiple reviews happening simultaneously
- ✅ **Scalability:** Add new domains as system grows

### For System Quality

- ✅ **Consistent patterns:** Domain architects enforce domain-specific best practices
- ✅ **Fewer missed issues:** Specialists catch domain-specific problems
- ✅ **Better documentation:** Domain-specific review checklists become living docs
- ✅ **Knowledge sharing:** Domain expertise documented in skills

---

## 6. Research & References

### Anthropic Claude Research

- **Constitutional AI:** Hierarchical value alignment through delegation
- **Debate & Delegation:** Multi-agent systems where agents review each other's work
- **Superalignment:** Coordinating multiple specialized models

### Software Architecture Patterns

- **C4 Model:** Context → Container → Component → Code (hierarchical views)
- **Scaled Agile (SAFe):** Solution Architect → System Architect → Component Architect
- **Microservices:** Domain-driven design with bounded contexts

### Industry Best Practices

- **Google:** Readability reviewers (language-specific) + domain experts
- **Meta:** Code review routing based on OWNERS files (domain mapping)
- **Amazon:** Two-pizza teams with domain ownership

---

## 7. Implementation Plan

### Phase 1: Create Domain Architect Skills (1 week)

- [ ] `search-ai-ingestion-architect.md`
- [ ] `search-ai-query-pipeline-architect.md`
- [ ] `search-ai-database-architect.md`
- [ ] `search-ai-vector-store-architect.md`
- [ ] `search-ai-knowledge-graph-architect.md`
- [ ] `search-ai-connector-architect.md`
- [ ] `search-ai-security-architect.md`
- [ ] `search-ai-performance-architect.md`

### Phase 2: Create Master Architect Skill (2 days)

- [ ] `search-ai-master-architect.md`
- [ ] Delegation algorithm
- [ ] Synthesis logic
- [ ] Conflict resolution rules

### Phase 3: Testing & Refinement (1 week)

- [ ] Test on past PRs (retrospective analysis)
- [ ] Refine delegation thresholds
- [ ] Optimize skill prompts based on feedback
- [ ] Document edge cases

### Phase 4: Rollout (ongoing)

- [ ] Use in code reviews for Search-AI changes
- [ ] Collect metrics (review time, issues caught, false positives)
- [ ] Iterate on skills based on usage patterns
- [ ] Expand to other platform domains (Runtime, Studio, etc.)

---

## 8. Success Metrics

- **Review Time:** Target <2 hours for single-domain, <4 hours for multi-domain
- **Issue Detection Rate:** Target >95% of issues caught before merge
- **False Positive Rate:** Target <10% (feedback that's not actionable)
- **Developer Satisfaction:** Survey score >8/10
- **Architect Load:** Target <2 hours/day per domain architect

---

## 9. Recommendations

### Immediate Next Steps

1. ✅ **Start with existing skills:** We already have:
   - `search-ai-architecture-reviewer` (system-wide) → Master Architect foundation
   - `search-ai-development` (implementation details)
   - `search-ai-documentation-reviewer` (docs)

2. ✅ **Create 3 domain architect skills first** (proof of concept):
   - `search-ai-ingestion-architect` (highest change frequency)
   - `search-ai-query-pipeline-architect` (performance-critical)
   - `search-ai-security-architect` (cross-cutting, critical)

3. ✅ **Test hierarchical pattern on next PR:**
   - Use Master Architect skill to analyze change
   - Manually delegate to domain skills
   - Collect feedback on effectiveness

4. ✅ **Iterate and expand:**
   - Add remaining domain skills based on results
   - Refine delegation algorithm
   - Document patterns that emerge

---

**Conclusion:** Hierarchical architect pattern is well-supported by research and industry practice. For Search-AI's complexity (17+ workers, 6+ domains), this pattern will improve review quality and speed while reducing architect cognitive load.

**Recommendation:** Proceed with implementation starting with 3 domain architect skills as proof of concept.

---

**Last Updated:** 2026-03-03
**Author:** Architecture Team
**Status:** Design Proposal
