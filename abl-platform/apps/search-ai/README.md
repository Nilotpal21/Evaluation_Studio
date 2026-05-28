# Search AI Service

Enterprise RAG (Retrieval-Augmented Generation) platform with ATLAS-KG chunking architecture for high-quality knowledge base search.

## What is Search AI?

Search AI provides semantic search over documents with:

- **Multi-source ingestion**: Web crawlers, file uploads, APIs, databases
- **ATLAS-KG chunking**: Adaptive topology with knowledge graph enrichment
- **Hybrid retrieval**: Vector (BGE-M3) + full-text (BM25) + knowledge graph
- **Multi-tenant isolation**: Secure tenant and app-level data separation
- **Index management**: Automatic shared index rotation, hybrid strategies

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- pnpm 9+

### Run Locally

```bash
# Install dependencies
pnpm install

# Start infrastructure (MongoDB, OpenSearch, BGE-M3, Neo4j)
docker compose up -d

# Build packages
pnpm build

# Start search-ai service
cd apps/search-ai
pnpm dev

# Service runs on http://localhost:3005
```

### Environment Variables

```bash
# Core Services
MONGODB_URI=mongodb://localhost:27017/search_ai
OPENSEARCH_URL=http://localhost:9200
BGE_M3_URL=http://localhost:8001
NEO4J_URI=neo4j://localhost:7687

# Optional: Knowledge Graph
KNOWLEDGE_GRAPH_ENABLED=true

# Optional: LLM for enrichment
ANTHROPIC_API_KEY=sk-ant-...

# Token Counting (Optional)
# Tokenizer model for accurate token counting (default: cl100k_base)
# Options: cl100k_base (GPT-4), p50k_base (GPT-3), r50k_base (GPT-3 older)
TOKENIZER_MODEL=cl100k_base
```

### Verify Setup

```bash
# Health check
curl http://localhost:3005/health

# Create test index
curl -X POST http://localhost:3005/api/indexes \
  -H "Content-Type: application/json" \
  -d '{"name": "test-kb", "description": "Test knowledge base"}'
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Search AI Pipeline                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Ingestion:                                                   │
│  └─ Connectors → Docling → Pages → Chunks → Enrichment      │
│     → Embedding → OpenSearch                                  │
│                                                               │
│  Retrieval:                                                   │
│  └─ Query → Hybrid Search (Vector + BM25) → Rerank          │
│     → Results                                                 │
│                                                               │
│  Knowledge Graph (optional):                                  │
│  └─ Entity Extraction → Neo4j → Relationship Search         │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Key Components:**

- **Workers**: Background job processing (embedding, enrichment, knowledge graph)
- **IndexRegistry**: Multi-strategy index management (shared, per-app, per-connector)
- **Vector Store**: OpenSearch with strict field mappings for multi-tenant isolation
- **Storage**: MongoDB for metadata, OpenSearch for vectors, Neo4j for knowledge graph

## Key Features

### 1. ATLAS-KG Chunking

Adaptive document chunking with:

- Docling extraction (layout-aware)
- Progressive summarization
- Question synthesis
- Entity extraction

### 2. IndexRegistry System

Flexible index strategies:

- **Shared**: Default for most apps (10M vectors, auto-rotation at 60%)
- **Per-App**: Dedicated indices for large apps
- **Per-Connector**: High-volume connectors isolated
- **Hybrid**: Mix strategies per app

### 3. Knowledge Graph

Optional entity-relationship extraction:

- Named entity recognition (people, orgs, locations)
- Co-occurrence analysis (IDF-weighted)
- Cross-document reference detection
- Neo4j storage with tenant isolation

### 4. Multi-Tenant Security

- Tenant-scoped data isolation (MongoDB + OpenSearch + Neo4j)
- Per-tenant LLM configurations
- Resource limits per tenant
- Audit logging

## Implementation Status

### ✅ Phase 1 Complete (February 2026)

**Ingestion Pipeline:**

- ✅ ATLAS-KG chunking (noise detection, tree building, semantic splitting)
- ✅ Progressive summarization
- ✅ Question synthesis
- ✅ Scope classification
- ✅ Visual enrichment (images, tables via vision models)
- ✅ Knowledge graph construction (entity extraction, Neo4j storage)
- ✅ Canonical metadata mapping
- ✅ Multi-provider embeddings (BGE-M3, OpenAI, Cohere, Custom)

**IndexRegistry:**

- ✅ Automatic shared index rotation (60% capacity threshold)
- ✅ Hybrid strategies (shared, per-app, per-connector)
- ✅ Admin APIs (rotate, status, archive)

**Query Pipeline:**

- ✅ Vector search (OpenSearch k-NN, Qdrant)
- ✅ Structured queries (metadata filtering)
- ✅ Aggregation queries (sum, avg, count, min, max)
- ✅ Similar documents
- ✅ Autocomplete/suggestions
- ✅ Vocabulary resolution

**Knowledge Graph:**

- ✅ Entity extraction and Neo4j storage
- ✅ Queryable via Neo4j Browser (Cypher)
- ✅ Service layer API (`findRelatedEntities()`)

### 🚧 Phase 2 In Progress (Q2 2026)

**Retrieval Enhancements:**

- 🚧 BM25 full-text search (OpenSearch text analyzer)
- 🚧 Graph-based retrieval REST API (`POST /api/search/:indexId/graph`)
- 🚧 Hybrid search (vector + BM25 with RRF fusion)
- 🚧 Reranker integration (Cohere cross-encoder)

**Details:** See [../../docs/searchai/dev-inprogress/](../../docs/searchai/dev-inprogress/)

### 📋 Phase 3 Planned (Q3 2026)

**Advanced Retrieval:**

- Tree-based retrieval (hierarchical search)
- Entity-centric search ("find all docs mentioning X")
- Relationship-based ranking (boost connected entities)
- Temporal graph analysis

## Configuration

### Index Strategies

Configure per app via Admin API:

```bash
# Force shared index rotation
POST /api/admin/indexes/rotate-shared

# Check capacity status
GET /api/admin/indexes/shared/status

# Archive old indices
POST /api/admin/indexes/shared/archive/:version
```

### Knowledge Graph

Enable per index:

```bash
# In .env
KNOWLEDGE_GRAPH_ENABLED=true
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
```

### LLM Configuration

Configure models per use case:

```typescript
{
  "llmConfig": {
    "extraction": { "provider": "anthropic", "model": "claude-3-haiku" },
    "summarization": { "provider": "anthropic", "model": "claude-3-haiku" },
    "questionSynthesis": { "provider": "anthropic", "model": "claude-3-haiku" }
  }
}
```

## Documentation

**Start Here:**

- [`docs/searchai/00-START-HERE.md`](../../docs/searchai/00-START-HERE.md) - Documentation navigation

**Architecture:**

- [`docs/searchai/design/SEARCHAI-ARCHITECTURE.md`](../../docs/searchai/design/SEARCHAI-ARCHITECTURE.md) - Complete SearchAI system architecture (code-verified)
- [`docs/searchai/ATLAS-KG-ARCHITECTURE.md`](../../docs/searchai/ATLAS-KG-ARCHITECTURE.md) - IndexRegistry design

**API Reference:**

- [`docs/searchai/ADMIN-API-REFERENCE.md`](../../docs/searchai/ADMIN-API-REFERENCE.md) - Admin endpoints
- [`docs/searchai/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md`](../../docs/searchai/OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) - Query patterns

**Features:**

- [`KNOWLEDGE_GRAPH.md`](./KNOWLEDGE_GRAPH.md) - Entity extraction & relationships
- [`MULTIMODAL.md`](./MULTIMODAL.md) - Vision processing

## Testing

```bash
# Run all tests
pnpm test

# Run specific test suite
pnpm test embedding-worker

# E2E document upload test
pnpm test test/e2e/document-upload-flow.test.ts
```

## Deployment

```bash
# Build production image
docker build -t search-ai:latest .

# Run with docker-compose
docker compose -f docker-compose.prod.yml up -d
```

**Environment-specific configs:**

- Development: `.env.development`
- Staging: `.env.staging`
- Production: `.env.production`

## Monitoring

**Key Metrics:**

- Index capacity: `GET /api/admin/indexes/shared/status`
- Vector count per index
- Rotation frequency
- Worker processing rates

**Health Checks:**

- Service: `GET /health`
- OpenSearch: `GET /health/opensearch`
- MongoDB: `GET /health/mongodb`
- Neo4j: `GET /health/neo4j` (if enabled)

## Troubleshooting

**Common Issues:**

1. **Workers not processing**
   - Check BullMQ connection to Redis
   - Verify MongoDB connection
   - Check worker logs: `docker compose logs -f search-ai`

2. **Shared index rotation not triggered**
   - Check capacity: `GET /api/admin/indexes/shared/status`
   - Verify threshold: `OPENSEARCH_SHARED_CAPACITY_THRESHOLD=0.6`
   - Manual rotation: `POST /api/admin/indexes/rotate-shared`

3. **Knowledge graph entities not extracted**
   - Verify `KNOWLEDGE_GRAPH_ENABLED=true`
   - Check Neo4j connection
   - Review entity extraction method: `KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD=hybrid`

## Contributing

Follow platform guidelines in [`CLAUDE.md`](../../CLAUDE.md):

- Tenant isolation is mandatory for all data paths
- Use structured metadata (`sys`, `doc`, `canonical`)
- Test with multi-tenant scenarios
- Document all configuration options

## License

Proprietary - Kore.ai Internal Use Only
