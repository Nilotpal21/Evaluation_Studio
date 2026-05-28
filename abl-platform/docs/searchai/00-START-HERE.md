# Search AI Documentation - Start Here

**Welcome!** This guide helps you navigate the Search AI documentation based on your role and goals.

---

## 🚀 New to Search AI? (5-10 minutes)

Start with these in order:

1. **[`apps/search-ai/README.md`](../../apps/search-ai/README.md)** (5 min)
   - What is Search AI?
   - Quick start guide
   - Key features overview

2. **[Architecture Overview](#architecture-overview)** (5 min, this page)
   - High-level system design
   - Key components
   - Data flow

3. **Then dive into specific areas below** ↓

---

## 📚 Documentation by Role

### For **Product Managers & Business**

**Goal:** Understand capabilities, costs, and trade-offs

📖 Read in order:

1. [`apps/search-ai/README.md`](../../apps/search-ai/README.md) - Feature overview
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Section 1 (Executive Summary) & Section 8 (Risks)
3. [`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md) - Index strategies & costs

**Key Questions Answered:**

- What problems does Search AI solve?
- What's the cost per million documents?
- What are the index strategy trade-offs?
- What's required for production deployment?

---

### For **Architects & Tech Leads**

**Goal:** Understand system design and integration points

📖 Read in order:

1. [`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md) - **Index strategy & rotation design**
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Full comprehensive design

**Key Questions Answered:**

- Why these architectural choices?
- What are the scaling limits?
- How does multi-tenancy work?
- What's the data model?
- Where are the integration points?

---

### For **Backend Engineers**

**Goal:** Implement features, fix bugs, understand code paths

📖 Quick reference:

1. [`apps/search-ai/README.md`](../../apps/search-ai/README.md) - Setup & run locally
2. [`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md) - **Index strategy & rotation (single source of truth)**
3. [`INGESTION-PIPELINE-ARCHITECTURE.md`](./INGESTION-PIPELINE-ARCHITECTURE.md) 🚧 - Worker orchestration, error handling, scaling
   - [`INGESTION-PIPELINE-GUIDE.md`](./design/INGESTION-PIPELINE-GUIDE.md) - Scene-by-scene walkthrough (flows, stages, providers, reindexing)
   - [`INGESTION-PIPELINE-DIAGRAMS.md`](./design/INGESTION-PIPELINE-DIAGRAMS.md) - ASCII class, sequence, and state diagrams
4. [`QUERY-PIPELINE-DESIGN.md`](./design/QUERY-PIPELINE-DESIGN.md) - Query pipeline design (7 stages, vocabulary, agent integration)
5. [`SERVICES-INVENTORY.md`](./design/SERVICES-INVENTORY.md) - 17 workers + routes + services catalog
6. [`OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Query patterns
7. [`ADMIN-API-REFERENCE.md`](./ADMIN-API-REFERENCE.md) - Admin endpoints
8. [`BULLMQ-FLOWS-PRODUCTION-GUIDE.md`](./BULLMQ-FLOWS-PRODUCTION-GUIDE.md) - BullMQ Flows known issues, scaling, per-worker config

**Code Entry Points:**

- **Ingestion pipeline**: `apps/search-ai/src/workers/`
- **Index management**: `packages/search-ai-internal/src/vector-store/index-registry.ts` (see [OPENSEARCH-INDEX-STRATEGY.md](./design/OPENSEARCH-INDEX-STRATEGY.md))
- **Admin API**: `apps/search-ai/src/routes/admin.ts`
- **Vector store**: `packages/search-ai-internal/src/vector-store/opensearch.ts`

**Key Questions Answered:**

- How do I query OpenSearch with filters?
- What's the worker processing flow?
- How does index rotation work?
- What are the MongoDB models?

---

### For **Data Scientists & ML Engineers**

**Goal:** Understand embedding pipeline, chunking, and retrieval

📖 Read in order:

1. [`EMBEDDING-GUIDE.md`](./EMBEDDING-GUIDE.md) - Providers, models, configuration
2. [`OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Vector search queries
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Section 5.2 (ATLAS-KG Chunking)

**Key Questions Answered:**

- What embedding models are supported?
- How do I configure embeddings per index?
- What's the chunking strategy?
- How does hybrid retrieval work?

---

### For **DevOps & SRE**

**Goal:** Deploy, monitor, and troubleshoot production

📖 Quick reference:

1. [`apps/search-ai/README.md`](../../apps/search-ai/README.md) - Deployment & monitoring
2. [`ADMIN-API-REFERENCE.md`](./ADMIN-API-REFERENCE.md) - Operational workflows
3. [`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md) - Capacity planning & operations

**Key Operations:**

- **Manual rotation**: `POST /api/admin/indexes/rotate-shared`
- **Check capacity**: `GET /api/admin/indexes/shared/status`
- **Archive indices**: `POST /api/admin/indexes/shared/archive/:version`

**Monitoring:**

- Index capacity percentage
- Worker processing rates
- Vector count per index
- Rotation frequency

**Key Questions Answered:**

- How do I monitor index capacity?
- When should I manually rotate?
- How do I troubleshoot worker failures?
- What are the resource requirements?

---

## 🗺️ Complete Document Map

### Entry Points

- **[`apps/search-ai/README.md`](../../apps/search-ai/README.md)** - Service overview & quick start

### Core Architecture

- **[`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md)** - **Index strategy, rotation & design decisions**
- **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** - Historical design rationale (Feb 2025) - explains **WHY** decisions were made
- **[`QUERY-PIPELINE-DESIGN.md`](./design/QUERY-PIPELINE-DESIGN.md)** - 7-stage query pipeline design, vocabulary, schema, agent integration
- **[`QUERY-PIPELINE-DIAGRAMS.md`](./design/QUERY-PIPELINE-DIAGRAMS.md)** - Class, sequence, and flow diagrams for query pipeline
- **[`INGESTION-PIPELINE-ARCHITECTURE.md`](./INGESTION-PIPELINE-ARCHITECTURE.md)** 🚧 - Ingestion-time worker orchestration
- **[`SERVICES-INVENTORY.md`](./design/SERVICES-INVENTORY.md)** - Complete catalog of 17 workers + services (22KB)

### API & Schema Reference

- **[`ADMIN-API-REFERENCE.md`](./ADMIN-API-REFERENCE.md)** - Admin endpoints (rotate, status, archive)
- **[`OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md)** - Field mappings & query patterns
- **[`DATABASE-SCHEMA.md`](./design/DATABASE-SCHEMA.md)** - MongoDB models, collections, indexes, plugins

### Configuration Guides

- **[`EMBEDDING-GUIDE.md`](./EMBEDDING-GUIDE.md)** - Embedding providers & configuration

### Feature Documentation

- **[`apps/search-ai/KNOWLEDGE_GRAPH.md`](../../apps/search-ai/KNOWLEDGE_GRAPH.md)** - Entity extraction & Neo4j
- **[`apps/search-ai/MULTIMODAL.md`](../../apps/search-ai/MULTIMODAL.md)** - Vision processing

---

## 🏗️ Architecture Overview

### High-Level System Design

```
┌──────────────────────────────────────────────────────────────────┐
│                         Search AI Platform                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │   Ingestion     │───▶│  IndexRegistry   │                    │
│  │   Pipeline      │    │  (Routing)       │                    │
│  └─────────────────┘    └──────────────────┘                    │
│           │                      │                                │
│           │                      ▼                                │
│           │         ┌─────────────────────────┐                  │
│           │         │   OpenSearch Indices    │                  │
│           │         ├─────────────────────────┤                  │
│           │         │ search-vectors-v1       │ ← Shared         │
│           │         │ search-vectors-v2       │ ← Shared (active)│
│           │         │ search-tenant-a-app1    │ ← Dedicated      │
│           │         └─────────────────────────┘                  │
│           │                      ▲                                │
│           │                      │                                │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │   MongoDB       │    │   Retrieval      │                    │
│  │   (Metadata)    │    │   Pipeline       │                    │
│  └─────────────────┘    └──────────────────┘                    │
│           │                      ▲                                │
│           │                      │                                │
│  ┌─────────────────┐            │                                │
│  │   Neo4j         │────────────┘                                │
│  │   (Knowledge    │     (Optional)                              │
│  │    Graph)       │                                              │
│  └─────────────────┘                                              │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component              | Purpose                                     | Technology           |
| ---------------------- | ------------------------------------------- | -------------------- |
| **IndexRegistry**      | Route documents to correct OpenSearch index | MongoDB + TypeScript |
| **Ingestion Pipeline** | Extract, chunk, enrich, embed documents     | Workers (BullMQ)     |
| **Vector Store**       | Store and search embeddings                 | OpenSearch (k-NN)    |
| **Metadata Store**     | Document metadata, chunks, indices          | MongoDB              |
| **Knowledge Graph**    | Entity relationships (optional)             | Neo4j                |
| **Embedding Service**  | Generate vectors                            | BGE-M3 (Docker)      |

### Data Flow

```
1. Document Upload
   └─▶ Connector fetches content
       └─▶ Docling extracts layout
           └─▶ Page Processing Worker
               ├─▶ Chunk generation (ATLAS-KG)
               ├─▶ Progressive summarization (LLM)
               └─▶ Question synthesis (LLM)
                   └─▶ Enrichment Worker
                       ├─▶ Entity extraction (optional)
                       └─▶ Canonical metadata mapping
                           └─▶ Embedding Worker
                               ├─▶ Generate vectors (BGE-M3)
                               ├─▶ Resolve index (IndexRegistry)
                               └─▶ Store in OpenSearch
                                   └─▶ Update MongoDB status

2. Search Query
   └─▶ Hybrid Retrieval
       ├─▶ Vector search (cosine similarity)
       ├─▶ BM25 full-text search
       └─▶ Knowledge graph (optional)
           └─▶ RRF Fusion
               └─▶ Rerank (optional)
                   └─▶ Return results
```

---

## 🔍 Common Use Cases

### Use Case 1: Add New Index Strategy

**Docs to read:**

1. [`OPENSEARCH-INDEX-STRATEGY.md`](./design/OPENSEARCH-INDEX-STRATEGY.md) - Index strategies (single source of truth)
2. [`ADMIN-API-REFERENCE.md`](./ADMIN-API-REFERENCE.md) - Manual operations

**Code to modify:**

- `packages/search-ai-internal/src/vector-store/index-registry.ts`

---

### Use Case 2: Add New Embedding Provider

**Docs to read:**

1. [`EMBEDDING-GUIDE.md`](./EMBEDDING-GUIDE.md) - Provider interface
2. [`OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Vector dimensions

**Code to modify:**

- `packages/search-ai-internal/src/embedding/providers/`

---

### Use Case 3: Customize Chunking Strategy

**Docs to read:**

1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Section 5.2 (ATLAS-KG Chunking)
2. [`apps/search-ai/README.md`](../../apps/search-ai/README.md) - Configuration

**Code to modify:**

- `apps/search-ai/src/workers/page-processing-worker.ts`

---

### Use Case 4: Debug Query Performance

**Docs to read:**

1. [`OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](./design/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Query optimization
2. [`ADMIN-API-REFERENCE.md`](./ADMIN-API-REFERENCE.md) - Monitoring

**Debug steps:**

1. Check index capacity: `GET /api/admin/indexes/shared/status`
2. Review HNSW parameters (ef_search, m)
3. Analyze filter selectivity
4. Check shard distribution

---

## 🤝 Contributing

**Before submitting a PR:**

1. Read [`CLAUDE.md`](../../CLAUDE.md) - Platform guidelines
2. Ensure tenant isolation for all data paths
3. Use structured metadata (`sys`, `doc`, `canonical`)
4. Add tests for new features
5. Update documentation

**Documentation standards:**

- Keep README.md up to date
- Add inline code comments for complex logic
- Update architecture docs for design changes
- Create feature docs in `apps/search-ai/` for new features

---

## 📞 Getting Help

**Questions?**

- Check existing docs first (use this guide)
- Review code examples in implementation files
- Ask in team Slack: `#search-ai-dev`

**Found a bug?**

- Check troubleshooting in [`apps/search-ai/README.md`](../../apps/search-ai/README.md)
- File issue with: logs, reproduction steps, expected vs actual behavior

**Need a feature?**

- Propose in architecture review
- Update design docs first
- Implement with tests
- Submit PR with documentation

---

## 🗃️ Legacy / Archive

**Note:** These docs are kept for historical reference but may be outdated:

- None yet (clean slate after Feb 2026 consolidation)

---

**Last Updated:** March 3, 2026
**Maintained By:** ABL Platform Team
