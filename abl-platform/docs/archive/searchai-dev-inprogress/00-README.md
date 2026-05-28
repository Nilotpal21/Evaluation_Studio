# Development In Progress

This folder contains design documents for features currently under development or planned for future releases.

**Purpose:** Separates implemented features (in main docs) from in-progress work to provide clear visibility on what's production-ready vs what's coming next.

---

## 🚧 Active Development (Q2 2026)

### 1. Graph-Based Retrieval API

**File:** [GRAPH-RETRIEVAL-API-PLAN.md](./GRAPH-RETRIEVAL-API-PLAN.md)
**Status:** Design Complete, Implementation Pending
**Target:** Q2 2026

REST API for graph-based entity search and relationship traversal.

**What's Done:**

- ✅ Neo4j graph storage (entities, relationships, co-occurrence)
- ✅ Entity extraction pipeline
- ✅ Service layer (`KnowledgeGraphService.findRelatedEntities()`)
- ✅ Queryable via Neo4j Browser (Cypher)

**What's Pending:**

- ❌ REST API endpoint (`POST /api/search/:indexId/graph`)
- ❌ Integration into query pipeline
- ❌ Relationship-based ranking
- ❌ Entity-centric search

---

## 📋 Planned (Q3 2026)

### 2. Tree-Based Retrieval

**File:** [TREE-BASED-RETRIEVAL-PLAN.md](./TREE-BASED-RETRIEVAL-PLAN.md)
**Status:** Early Design
**Target:** Q3 2026

Hierarchical search using document tree structure built during ingestion.

**What's Done:**

- ✅ Tree construction (ATLAS-KG chunking)
- ✅ Tree structure stored in MongoDB

**What's Pending:**

- ❌ Tree navigation at query time
- ❌ Scope-aware retrieval (snippet vs section vs document)
- ❌ Parent/child expansion strategies
- ❌ Tree metadata in vector store schema

---

### 3. Entity-Centric Search

**File:** [ENTITY-SEARCH-PLAN.md](./ENTITY-SEARCH-PLAN.md)
**Status:** Early Design
**Target:** Q3 2026

Search by entity ("find all documents about Microsoft") with relationship expansion.

---

## How to Use These Documents

**For Reviewers:**

- These features are NOT implemented yet
- Understand what's planned vs what works today
- Don't expect these features to work in this branch

**For Contributors:**

- Start here before implementing new features
- Update designs as you implement
- Move completed features back to main docs with implementation details

**For Product/Planning:**

- Use for roadmap planning
- Reference for feature prioritization
- Set expectations with stakeholders

---

**Last Updated:** 2026-02-21
**Maintained By:** ABL Platform Team
