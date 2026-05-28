# SearchAI RFCs (Requests for Comments)

This directory contains all formal architectural decision documents (RFCs) for the SearchAI platform, covering ingestion pipeline, crawling, indexing, retrieval, permissions, and orchestration.

---

## 📑 RFC Index

### RFC-001: ATLAS-KG v2 - Document Extraction & Knowledge Graph

**Status:** In Progress (Week 1 Complete)
**Topic:** Ingestion Pipeline Architecture
**Created:** 2026-02-19

- **[RFC-001: ATLAS-KG v2 Document Extraction](./RFC-001-ATLAS-KG-v2-Document-Extraction-And-Knowledge-Graph.md)**

**Summary:**
Replaces text-only chunking with page-based extraction system that:

- Preserves document structure (tables, headings, images)
- Uses progressive LLM summarization
- Enables visual understanding (screenshots, charts)
- Builds cross-document knowledge graph

**Key Features:**

- Page-based chunking (no arbitrary splits)
- Progressive summarization with context chaining
- Visual analysis via LLM (charts, diagrams)
- Neo4j knowledge graph for entity linking

**Status:** Docling extraction complete, progressive summarization pending

---

### RFC-002: OpenSearch Multi-Tenant Index Strategy

**Status:** ✅ Implemented → Superseded by consolidated doc
**Topic:** Vector Store Indexing
**Created:** 2026-02-20
**Archived:** 2026-03-09

**Original documents moved to:** [./\_archive/RFC-002-\*.md](./_archive/)

**Replacement:** See **[`../OPENSEARCH-INDEX-STRATEGY.md`](../OPENSEARCH-INDEX-STRATEGY.md)** for consolidated, implementation-verified design document.

**Why superseded:**

- Original docs spread across 2 files (68KB total)
- Missing implementation status markers
- Design vs code discrepancies (70% vs 60% threshold)
- Migration APIs documented but never implemented

**Core implementation:** ✅ Fully implemented (3 strategies, auto-rotation, hybrid support)

---

### RFC-004: Pluggable Pipeline Architecture

**Status:** Conditional Approval (Use BullMQ Flows, not Restate)
**Topic:** Pipeline Orchestration
**Created:** 2026-03-04

- **[RFC-004: Pluggable Pipeline Architecture](./RFC-004-Pluggable-Pipeline-Architecture.md)** - Main proposal
- **[RFC-004: Architectural Review](./RFC-004-Pluggable-Pipeline-Architectural-Review.md)** - 15,000+ word analysis
- **[RFC-004: Review Summary](./RFC-004-Pluggable-Pipeline-Review-Summary.md)** - Executive summary
- **[RFC-004: Why Not Restate](./RFC-004-Pluggable-Pipeline-Why-Not-Restate.md)** - Detailed comparison

**Summary:**
Transform SearchAI's hardcoded ingestion pipeline into configurable, pluggable workflows where:

- Users can replace built-in stages with alternatives (e.g., LlamaIndex instead of Docling)
- Add custom processing stages (JavaScript sandbox)
- Configure pipeline per index/source
- Swap providers without code changes

**Critical Decision:**
Architecture review recommends **BullMQ Flows** instead of Restate:

- 12× better performance (<0.1s vs 1.25s overhead per document)
- 60% less complexity (29% vs 78% code increase)
- Zero infrastructure cost ($0 vs $X/month for Restate cluster)
- Industry evidence: No document processing systems use workflow engines

**Key Finding:**
Restate designed for interactive workflows with suspension points (human approvals, webhooks). SearchAI is continuous data transformation - wrong tool for the job.

---

### RFC-005: Job Tracking Architecture

**Status:** Approved (Documenting Existing Implementation)
**Topic:** Pipeline Observability
**Created:** 2026-03-04

- **[RFC-005: Job Tracking Architecture](./RFC-005-Job-Tracking-Architecture.md)**

**Summary:**
Documents existing job tracking system for SearchAI's ingestion pipeline. Tracks every worker execution with comprehensive metrics, errors, and context.

**Key Design Decision:** ✅ **Flat schema with no parent-child linking**

Each job execution tracked independently with contextual fields (`sourceId`, `documentId`, `workerStage`) for grouping - avoiding complexity and performance issues of hierarchical relationships.

**Core Value:**

- Complete visibility into every pipeline stage
- Fast queries for document/source aggregations (<50-500ms)
- No hot document problems
- Worker-agnostic instrumentation
- Scalable to millions of jobs

**Schema:**

- JobExecution collection with flat structure
- Comprehensive metrics (duration, LLM tokens, memory)
- Full error details with stack traces
- Retry tracking and distributed tracing support

---

### RFC-006: Job Tracking + BullMQ Flows Integration

**Status:** Approved - Ready for Implementation
**Topic:** Flows Integration
**Created:** 2026-03-04
**Dependencies:** RFC-004 must be approved first

- **[RFC-006: Job Tracking + BullMQ Flows Integration](./RFC-006-Job-Tracking-BullMQ-Flows-Integration.md)**

**Summary:**
Analyzes compatibility between existing job tracking (RFC-005) and BullMQ Flows for pluggable pipelines (RFC-004).

**Verdict:** ✅ **HIGHLY COMPATIBLE** - Current flat schema is ideal for BullMQ Flows

**Required Changes:** **MINIMAL**

- Add 3 optional fields: `pipelineId`, `pipelineVersion`, `flowJobId`
- Add 2 indexes for pipeline analytics
- Minor instrumentation update (3 lines)

**Performance Impact:** **ZERO** - Same MongoDB operations, same query performance

**Timeline:** 2-3 weeks (parallel with flow implementation)

**Why Flat Schema Works:**

- Flow orchestration happens in BullMQ (Redis), not MongoDB
- Job tracking just records individual executions as before
- No hot document problems (each job is independent)
- Simple queries (no traversal needed)

---

### RFC-007: Query Pipeline - Intent Preservation & Hybrid Search

**Status:** Draft - Under Discussion
**Topic:** Query/Retrieval Pipeline
**Created:** 2026-02-23

- **[RFC-007: Query Pipeline Intent Preservation & Hybrid Search](./RFC-007-Query-Pipeline-Intent-Preservation-And-Hybrid-Search.md)**

**Summary:**
Comprehensive redesign of query pipeline to fix three critical flaws:

1. **Vocabulary resolution destroys intent** - Strips meaningful terms, leaves only stopwords
2. **False "hybrid" search** - No BM25 scoring, `hybridAlpha` parameter ignored
3. **Reranker not implemented** - Stub only, missing 5-10% accuracy improvement

**Proposed Solution:**

- Preserve original query semantics for embedding
- Implement true hybrid search with RRF score fusion
- Integrate production-grade reranking
- Add query type routing for optimized pipelines

**Expected Impact:**

- Accuracy: 87% → 94% MRR@10 (+8.0%)
- Query Intent Preservation: 0% → 100%
- Latency: 135ms → 265ms (RRF +20ms, Reranker +110ms)

**Environment:** OpenSearch 2.11.0 confirmed - native hybrid search ready

---

### RFC-008: Enterprise Permission & Authorization Architecture

**Status:** Draft
**Topic:** Permissions & Security
**Created:** 2026-02-24

- **[RFC-008: Enterprise Permission & Authorization](./RFC-008-Enterprise-Permission-And-Authorization-Architecture.md)**

**Summary:**
Enterprise-grade permission system enabling:

- Identity Federation via IDP (Azure AD, Okta, Google) - NO per-user OAuth
- Neo4j Permission Graph for nested group hierarchies (unlimited depth)
- Vector DB Permission Metadata for single-query authorization
- Near Real-Time Updates (<10 minutes via webhooks + delta queries)
- Multi-connector support with unified user identity

**Timeline:** 18-21 weeks (quality-first, enterprise-ready)

**Key Decision:**
IDP-based authentication eliminates spoofing risks, making domain verification optional for security.

**Architecture Highlights:**

- Two-layer authentication (Platform + End-User)
- Neo4j for recursive group resolution (<10ms)
- Single-query authorization (60-180ms vs 105-360ms current)
- Webhook subscriptions for near real-time updates

**Scale Targets:**

- 100K end users per tenant
- 10M documents per tenant
- 100M vector chunks across all tenants
- <100ms added latency for permission checks

---

### RFC-009: Web Crawler Implementation & Testing

**Status:** In Progress (7 issues, 15 tasks)
**Topic:** Web Crawler
**Created:** 2026-02-23

**Main RFC:**

- **[RFC-009: Web Crawler End-User Testing Methodology](./RFC-009-Web-Crawler-End-User-Testing-Methodology.md)**

**Test Results & Validation:**

- **[RFC-009: Test Results - docs.kore.ai](./RFC-009-Web-Crawler-Test-Results-docs-kore-ai.md)**
- **[RFC-009: Task Validation Report](./RFC-009-Web-Crawler-Task-Validation-Report.md)**
- **[RFC-009: Verification Commands](./RFC-009-Web-Crawler-Verification-Commands.md)**

**Implementation & Issues:**

- **[RFC-009: Implementation Task List](./RFC-009-Web-Crawler-Implementation-Task-List.md)** - Master plan for 15 tasks
- **[RFC-009: Issue #6 - Sitemap Link Following](./RFC-009-Issue-6-Sitemap-Link-Following-Not-Implemented.md)**
- **[RFC-009: Issue #7 - Crawl Configuration UX](./RFC-009-Issue-7-Confusing-Crawl-Configuration-UX.md)**

**Summary:**
Comprehensive testing and validation of web crawler implementation. Test against docs.kore.ai uncovered 6 critical issues:

**Issues Found:**

1. ✅ HTML extraction disabled (FIXED)
2. ❌ Content preservation 8% (should be 90%+) - Readability too aggressive
3. ❌ Chunking produces 0 chunks - Pipeline failure
4. ❌ Documents stuck in Pending (300+ seconds) - State machine issue
5. ❌ 0% success rate - No documents indexed
6. ❌ Only 1 page crawled (should be 5+) - Sitemap/link following not implemented
7. ❌ Confusing crawl config UX - Technical parameters vs user-friendly strategies

**Status:**

- ✅ Complete: 7 tasks (47%)
- ⚠️ Needs Verification: 5 tasks (33%)
- ❌ Not Started: 3 tasks (20%)

**Critical Finding:**
Most infrastructure already built - likely configuration/integration issues rather than missing code.

---

### RFC-010: IdP Authentication & Permission Filtering

**Status:** Draft (Phase 2B Complete for Azure AD)
**Topic:** Authentication & Permissions
**Created:** 2026-03-03

- **[RFC-010: IdP Authentication & Permission Filtering](./RFC-010-IdP-Authentication-And-Permission-Filtering.md)** - Main RFC
- **[RFC-010: Gap Analysis](./RFC-010-IdP-Authentication-Gap-Analysis.md)** - Architecture review
- **[RFC-010: Phase 2B Complete](./RFC-010-IdP-Authentication-Phase2B-Complete.md)** - Azure AD implementation

**Summary:**
Adds Identity Provider-based authentication to SearchAI query routes with document-level permissions at query time.

**Two-Layer Authentication:**

**Layer 1 - Platform Authentication** (existing):

- Validates calling application has access to tenant/index
- Uses API keys or User JWTs
- Enforces tenant isolation

**Layer 2 - End-User Identity** (new):

- Validates which end user is making request
- Uses IdP tokens (Azure AD, Okta, Google)
- Resolves user's group memberships from Neo4j
- Filters results to documents user has access to

**Implementation Status:**

**Phase 2B Complete (Azure AD):**

- ✅ Azure AD user sync worker (Microsoft Graph API)
- ✅ Azure AD group sync worker (nested groups, 20 levels)
- ✅ IdP sync API routes
- ✅ Delta query support for incremental syncs
- ⏳ Okta integration (TBD)
- ⏳ Google Workspace integration (TBD)

**Key Benefits:**

- Document-level access control (least privilege)
- Leverages existing SharePoint/Drive ACLs
- Backward compatible (opt-in via header)
- Performance: <500ms P95 with Redis caching
- Multi-tenant & multi-IdP support

**Timeline:** 8-9 weeks total (revised from 6 weeks due to IdP sync gaps)

---

## 🗂️ RFC Organization by Topic

### Ingestion Pipeline

- RFC-001: ATLAS-KG v2 Document Extraction
- RFC-004: Pluggable Pipeline Architecture
- RFC-005: Job Tracking Architecture
- RFC-006: Job Tracking + BullMQ Flows Integration

### Web Crawler

- RFC-009: Web Crawler Implementation & Testing (7 files)

### Indexing & Storage

- RFC-002: OpenSearch Multi-Tenant Index Strategy (superseded by [OPENSEARCH-INDEX-STRATEGY.md](../OPENSEARCH-INDEX-STRATEGY.md))

### Query & Retrieval

- RFC-007: Query Pipeline - Intent Preservation & Hybrid Search

### Permissions & Security

- RFC-008: Enterprise Permission & Authorization Architecture
- RFC-010: IdP Authentication & Permission Filtering

---

## 📊 RFC Status Summary

| RFC       | Topic                           | Status                         | Files  |
| --------- | ------------------------------- | ------------------------------ | ------ |
| RFC-001   | ATLAS-KG v2 Document Extraction | In Progress (Week 1 Complete)  | 1      |
| RFC-002   | OpenSearch Index Strategy       | Draft                          | 2      |
| RFC-004   | Pluggable Pipeline Architecture | Conditional Approval           | 4      |
| RFC-005   | Job Tracking Architecture       | Approved (Existing)            | 1      |
| RFC-006   | Job Tracking + BullMQ Flows     | Approved - Ready for Impl      | 1      |
| RFC-007   | Query Pipeline Redesign         | Draft - Under Discussion       | 1      |
| RFC-008   | Enterprise Permissions          | Draft                          | 1      |
| RFC-009   | Web Crawler Testing             | In Progress (47% Complete)     | 7      |
| RFC-010   | IdP Authentication              | Draft (Phase 2B Azure AD Done) | 3      |
| **Total** |                                 |                                | **21** |

---

## 🔗 Key Relationships

```
RFC-001 (ATLAS-KG Ingestion)
    │
    ├──► RFC-004 (Pluggable Pipelines) ◄─┐
    │         │                          │
    │         ├──► RFC-005 (Job Tracking)│
    │         │                          │
    │         └──► RFC-006 (Flows Integration)
    │
    └──► RFC-009 (Web Crawler) - Tests RFC-001 implementation

RFC-002 (OpenSearch Indexing)
    │
    └──► RFC-007 (Query Pipeline) - Queries RFC-002 indices

RFC-008 (Enterprise Permissions)
    │
    └──► RFC-010 (IdP Auth) - Implements RFC-008 with IdP integration
```

---

## 🎯 Implementation Priorities

### Priority 1: CRITICAL (Blocking Production)

- **RFC-009 Issues #2-5** - Fix crawler pipeline (content preservation, chunking, indexing)
- **RFC-006** - Implement BullMQ Flows integration (2-3 weeks)

### Priority 2: HIGH (Quality & Performance)

- **RFC-007** - Fix query pipeline intent preservation & hybrid search
- **RFC-004** - Implement pluggable pipeline with BullMQ Flows
- **RFC-009 Issues #6-7** - Complete crawler features (sitemap, UX)

### Priority 3: MEDIUM (Feature Completeness)

- **RFC-001** - Complete ATLAS-KG v2 (progressive summarization, vision analysis)
- **RFC-010** - Complete IdP sync (Okta, Google)

### Priority 4: LOW (Enterprise Features)

- **RFC-002** - Implement index strategy rotation
- **RFC-008** - Full enterprise permission system (18-21 weeks)

---

## 📝 Contributing to RFCs

### Creating New RFCs

1. Use format: `RFC-XXX-Descriptive-Title-In-Title-Case.md`
2. Include these sections:
   - Executive Summary
   - Problem Statement
   - Goals & Non-Goals
   - Proposed Solution
   - Performance Impact
   - Migration Strategy
   - Success Metrics
3. Add entry to this README with status and relationships
4. Link related RFCs for context

### RFC Numbering

- RFC-001 to RFC-003: Early RFCs (some conflicts resolved)
- RFC-004 to RFC-006: Pipeline orchestration suite
- RFC-007 to RFC-008: Query & permissions (resolved RFC-003 conflict)
- RFC-009: Web crawler suite (consolidated from scattered RFC-001 files)
- RFC-010: IdP authentication suite

**Next available:** RFC-011

---

## 📚 Related Documentation

- [SearchAI Architecture Overview](../ARCHITECTURE.md)
- [SearchAI Ingestion Pipeline](../INGESTION-PIPELINE-ARCHITECTURE.md)
- [SearchAI Database Schema](../DATABASE-SCHEMA.md)
- [SearchAI Developer Onboarding](../DEVELOPER-ONBOARDING.md)
- [BullMQ Flows Production Guide](../BULLMQ-FLOWS-PRODUCTION-GUIDE.md) — Known issues, scaling challenges, per-worker configuration
- [Job Creation Flow Diagram](../../Job_Creation_Flow_Diagram.md)

---

**Last Updated:** 2026-03-04
**Total RFCs:** 10 (with 21 files total including supporting documents)
**Total Size:** ~1.6 MB of architectural documentation
