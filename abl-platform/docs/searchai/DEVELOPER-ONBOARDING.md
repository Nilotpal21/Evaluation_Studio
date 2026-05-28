# Search-AI Developer Onboarding Guide

**Version:** 1.0
**Date:** 2026-03-04
**Purpose:** Comprehensive onboarding guide for developers joining the Search-AI team

---

## Table of Contents

1. [Welcome to Search-AI](#welcome-to-search-ai)
2. [Architecture Overview](#architecture-overview)
3. [Core Technologies & Frameworks](#core-technologies--frameworks)
4. [Production Infrastructure Essentials](#production-infrastructure-essentials) → See [INFRASTRUCTURE-GUIDE.md](./INFRASTRUCTURE-GUIDE.md)
5. [Essential Algorithms & Concepts](#essential-algorithms--concepts) → See [ALGORITHMS-DEEP-DIVE.md](./ALGORITHMS-DEEP-DIVE.md)
6. [Research Papers to Read](#research-papers-to-read)
7. [Skills Development Path](#skills-development-path)
8. [Learning Resources](#learning-resources)
9. [News Feeds & Channels](#news-feeds--channels)
10. [First 90 Days Roadmap](#first-90-days-roadmap)
11. [Hands-On Exercises](#hands-on-exercises)

---

## Welcome to Search-AI

Search-AI is an enterprise-grade **Retrieval-Augmented Generation (RAG)** platform that enables semantic search over multi-source document collections. We've built a production system processing millions of documents with state-of-the-art chunking, embedding, and retrieval techniques.

### What Makes Search-AI Unique

1. **ATLAS-KG Architecture**: First unified system addressing all six RAG failure modes simultaneously
2. **Multi-Strategy Indexing**: Flexible index strategies (shared, per-app, per-connector) with automatic rotation
3. **Knowledge Graph Integration**: Entity extraction and relationship mapping across documents
4. **Production-Grade Scale**: Designed for 100M+ documents with sub-100ms query latency
5. **Enterprise Multi-Tenancy**: Strict tenant isolation across all data stores

### Key Metrics

- **70+ Services**: Background workers, REST APIs, business logic modules
- **5 Data Stores**: MongoDB, OpenSearch, Neo4j, ClickHouse, Redis
- **23 Total Workers**: 14 core ingestion workers (always-on) + 3 optional workers (LLM features) + 6 connector/crawler workers (separate services)
- **15+ LLM Providers**: Flexible provider integration via Vercel AI SDK

---

## Architecture Overview

### High-Level System Design

```
┌──────────────────────────────────────────────────────────────────┐
│                         Search-AI Platform                        │
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

### Data Flow: Ingestion Pipeline

```
Document Upload
  └─▶ Connector Fetch
      └─▶ Docling Extraction (Layout-aware parsing)
          └─▶ Page Processing Worker
              ├─▶ Chunking (ATLAS-KG strategy)
              ├─▶ Progressive Summarization (LLM)
              └─▶ Question Synthesis (LLM)
                  └─▶ Enrichment Worker
                      ├─▶ Entity Extraction (Compromise NLP)
                      ├─▶ Canonical Metadata Mapping
                      └─▶ Noise Detection (TF-IDF scoring)
                          └─▶ Embedding Worker
                              ├─▶ Generate Vectors (BGE-M3)
                              ├─▶ Resolve Index (IndexRegistry)
                              └─▶ Upsert to OpenSearch
                                  └─▶ Update MongoDB Status
```

### Data Flow: Query Pipeline

```
User Query
  └─▶ Query Preprocessing
      └─▶ Vocabulary Resolution (Synonyms)
          └─▶ Embedding Generation
              └─▶ Hybrid Search
                  ├─▶ Vector Search (k-NN, cosine similarity)
                  ├─▶ BM25 Full-Text Search
                  └─▶ Knowledge Graph Traversal (optional)
                      └─▶ RRF Fusion (Reciprocal Rank Fusion)
                          └─▶ Reranking (Cohere cross-encoder)
                              └─▶ Token Budget Packing (20K tokens)
                                  └─▶ Return Results
```

---

## Core Technologies & Frameworks

### Backend Stack

| Technology     | Version | Purpose             | Learning Priority   |
| -------------- | ------- | ------------------- | ------------------- |
| **TypeScript** | 5.3+    | Primary language    | ⭐⭐⭐⭐⭐ Critical |
| **Node.js**    | 20+     | Runtime environment | ⭐⭐⭐⭐⭐ Critical |
| **Express.js** | 4.x     | REST API framework  | ⭐⭐⭐⭐ High       |
| **BullMQ**     | 5.x     | Job queue system    | ⭐⭐⭐⭐⭐ Critical |
| **Mongoose**   | 8.x     | MongoDB ODM         | ⭐⭐⭐⭐ High       |

### Data Stores

| Store          | Purpose              | Key Concepts                            | Learning Priority   |
| -------------- | -------------------- | --------------------------------------- | ------------------- |
| **MongoDB**    | Metadata storage     | Documents, Indexes, Aggregations        | ⭐⭐⭐⭐⭐ Critical |
| **OpenSearch** | Vector + text search | k-NN, BM25, HNSW, Field mappings        | ⭐⭐⭐⭐⭐ Critical |
| **Neo4j**      | Knowledge graph      | Cypher, Graph algorithms, Relationships | ⭐⭐⭐ Medium       |
| **ClickHouse** | Structured analytics | Columnar storage, SQL                   | ⭐⭐ Low            |
| **Redis**      | Queue + cache        | Pub/Sub, Streams, Distributed locks     | ⭐⭐⭐⭐ High       |

### NLP & Machine Learning

| Technology           | Purpose                              | Learning Priority |
| -------------------- | ------------------------------------ | ----------------- |
| **BGE-M3**           | Multilingual embedding model         | ⭐⭐⭐⭐ High     |
| **Compromise NLP**   | Named entity recognition (JS-native) | ⭐⭐⭐ Medium     |
| **Vercel AI SDK**    | LLM provider abstraction             | ⭐⭐⭐⭐ High     |
| **Anthropic Claude** | LLM for summarization, Q&A           | ⭐⭐⭐⭐ High     |
| **OpenAI GPT**       | Alternative LLM provider             | ⭐⭐⭐ Medium     |
| **Docling**          | Document layout extraction           | ⭐⭐⭐ Medium     |

### Infrastructure

| Technology            | Purpose               | Learning Priority |
| --------------------- | --------------------- | ----------------- |
| **Docker**            | Containerization      | ⭐⭐⭐⭐ High     |
| **Kubernetes**        | Orchestration         | ⭐⭐⭐ Medium     |
| **Turbo (Turborepo)** | Monorepo build system | ⭐⭐⭐ Medium     |
| **pnpm**              | Package manager       | ⭐⭐⭐⭐ High     |

### LLM Provider Configuration

Search-AI supports **15+ LLM providers** through the Vercel AI SDK with a sophisticated credential resolution system.

**Credential Resolution Hierarchy:**

1. **Project-level API keys** (highest priority) - Encrypted in MongoDB, scoped to specific projects
2. **Tenant-level API keys** (fallback) - Shared across projects within a tenant
3. **System-level API keys** (default) - Global fallback for all tenants

**Supported Providers:**

- Anthropic (Claude 3.5 Sonnet, Haiku)
- OpenAI (GPT-4, GPT-3.5)
- Google (Gemini Pro)
- Cohere (Command, Embed)
- Azure OpenAI
- AWS Bedrock
- +10 more

**Implementation:**

See `apps/search-ai/src/services/llm-credential-resolver.ts` for the credential resolution logic. All LLM operations automatically resolve credentials through this service, ensuring proper tenant isolation and fallback behavior.

**Prompt Templates:** LLM prompts are stored as versioned YAML files in `apps/search-ai/src/prompts/v1/` and loaded via `PromptLoaderService`. When modifying or adding prompts, create new YAML templates in that directory rather than using inline strings in worker/service code.

**Security Note:** API keys are encrypted at rest using AES-256-GCM. Never log or expose API keys in responses or error messages.

---

## Production Infrastructure Essentials

This onboarding guide focuses on **application development** (RAG, workers, APIs, security). For production infrastructure skills (Kubernetes StatefulSets, database replication, connection pooling, distributed systems, observability, disaster recovery), see the dedicated guide:

**📘 [INFRASTRUCTURE-GUIDE.md](./INFRASTRUCTURE-GUIDE.md)** - Complete guide to deploying and operating Search-AI in production

**Quick Links:**

- [Kubernetes StatefulSets vs Deployments](./INFRASTRUCTURE-GUIDE.md#kubernetes-statefulsets-vs-deployments)
- [Database Replication Patterns](./INFRASTRUCTURE-GUIDE.md#database-replication-patterns)
- [Connection Pooling](./INFRASTRUCTURE-GUIDE.md#connection-pooling)
- [Distributed Systems Fundamentals](./INFRASTRUCTURE-GUIDE.md#distributed-systems-fundamentals)
- [Production Checklist](./INFRASTRUCTURE-GUIDE.md#production-checklist)

### 🔒 Security: Tenant Isolation (CRITICAL)

> **Platform Principle #1**: Tenant isolation is the highest-priority security concern. Every query must be scoped to `tenantId`. **No cross-tenant data leakage is acceptable.**

#### Why Tenant Isolation Matters

**Critical Security Risk:**

- **Data Privacy**: Tenant A must NEVER see Tenant B's data
- **Compliance**: GDPR, HIPAA, SOC 2 require strict data isolation
- **Attack Prevention**: Prevents unauthorized access via ID guessing
- **Trust**: Customers trust us to keep their data separate

#### The `tenantIsolationPlugin`

Search-AI uses a Mongoose plugin that **automatically injects `tenantId` filters** into all database operations.

**How It Works:**

```typescript
import { tenantIsolationPlugin } from '@agent-platform/database';

// Applied to all tenant-scoped models
SearchChunkSchema.plugin(tenantIsolationPlugin);
SearchDocumentSchema.plugin(tenantIsolationPlugin);
```

**What It Does:**

- Automatically adds `tenantId` filter to `find()`, `findOne()`, `updateOne()`, etc.
- Auto-sets `tenantId` when creating new documents
- Uses AsyncLocalStorage for request context (no manual passing)
- Prevents accidental cross-tenant queries

#### Secure Query Patterns (ALWAYS Use These)

**✅ CORRECT: Database-Level Filtering**

```typescript
import { withTenantContext } from '@agent-platform/database';

// Wrap all request handlers with tenant context
app.get('/api/documents/:id', async (req, res) => {
  const tenantId = req.user.tenantId; // From JWT

  await withTenantContext({ tenantId }, async () => {
    // All queries inside automatically scoped to tenantId
    const doc = await SearchDocument.findOne({
      _id: req.params.id,
      indexId: req.query.indexId,
    });
    // Plugin automatically adds: { tenantId }

    res.json(doc);
  });
});
```

**✅ CORRECT: Explicit tenantId in Query**

```typescript
// Always include tenantId explicitly for clarity
const chunks = await SearchChunk.find({
  tenantId, // REQUIRED
  indexId, // Scope to index
  documentId, // Scope to document
});
```

**✅ CORRECT: Aggregation Pipelines**

```typescript
await SearchChunk.aggregate([
  // Plugin automatically prepends: { $match: { tenantId } }
  { $match: { indexId } },
  { $group: { _id: '$documentId', count: { $sum: 1 } } },
]);
```

#### Anti-Patterns (NEVER Do This)

**❌ WRONG: Using `findById` Without Scope**

```typescript
// DANGER: No tenantId check!
const doc = await SearchDocument.findById(documentId);
if (doc.tenantId !== tenantId) {
  throw new Error('Unauthorized');
}
```

**Why This Is Dangerous:**

- **Timing side-channel attack**: Response time reveals if document exists in other tenant
- Attacker can probe: "Does document X exist in tenant Y?"
- Database already fetched cross-tenant data before check

**❌ WRONG: Forgetting `withTenantContext`**

```typescript
// DANGER: Query runs without tenant scope!
const doc = await SearchDocument.findOne({ _id: docId });
// Plugin cannot inject tenantId (no context)
```

**❌ WRONG: Manual `$or` Queries Across Tenants**

```typescript
// DANGER: Trying to query multiple tenants
const docs = await SearchDocument.find({
  $or: [{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }],
});
// This should NEVER be needed in application code
```

#### Cross-Tenant Data Leak Risks

**Common Mistakes:**

1. **ID Guessing**

   ```typescript
   // Attacker tries: GET /api/documents/doc-from-other-tenant
   // If no tenantId check: returns cross-tenant data
   ```

2. **Cache Keys Without tenantId**

   ```typescript
   // WRONG
   redis.get(`doc:${documentId}`);

   // CORRECT
   redis.get(`doc:${tenantId}:${documentId}`);
   ```

3. **Logs Containing Cross-Tenant Data**

   ```typescript
   // WRONG: Logs document without verifying tenant
   logger.info('Processing document', { documentId, content });

   // CORRECT: Verify tenant first
   if (doc.tenantId === currentTenantId) {
     logger.info('Processing document', { tenantId, documentId });
   }
   ```

4. **OpenSearch Queries Without tenantId**

   ```typescript
   // WRONG
   await opensearch.search({
     index: 'search-vectors-v1',
     body: { query: { match: { content: 'query' } } },
   });

   // CORRECT
   await opensearch.search({
     index: 'search-vectors-v1',
     body: {
       query: {
         bool: {
           must: [
             { term: { tenantId } }, // REQUIRED
             { match: { content: 'query' } },
           ],
         },
       },
     },
   });
   ```

#### Testing Tenant Isolation

**Always Test:**

```typescript
describe('Tenant Isolation', () => {
  it('should not return documents from other tenants', async () => {
    // Create doc in tenant A
    const docA = await SearchDocument.create({
      tenantId: 'tenant-a',
      indexId: 'index-1',
      content: 'Secret data',
    });

    // Try to access from tenant B context
    await withTenantContext({ tenantId: 'tenant-b' }, async () => {
      const found = await SearchDocument.findOne({ _id: docA._id });
      expect(found).toBeNull(); // Must not find it!
    });
  });
});
```

#### Further Reading

For complete tenant isolation implementation details, see:

- **`apps/search-ai/docs/chunking/11-security-tenant-isolation.md`** - Security audit
- **`packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`** - Plugin source code

---

---

## Essential Algorithms & Concepts

This onboarding guide focuses on **application development** and **security**. For deep dives into the mathematical and algorithmic foundations of Search-AI (RAG, vector embeddings, BM25, hybrid search, ATLAS-KG chunking, knowledge graphs), see the dedicated guide:

**📘 [ALGORITHMS-DEEP-DIVE.md](./ALGORITHMS-DEEP-DIVE.md)** - Complete algorithmic foundations with formulas, examples, and hands-on exercises

**Core Algorithms Covered:**

1. **RAG (Retrieval-Augmented Generation)** - Foundation of Search-AI's query pipeline
2. **Vector Embeddings & Similarity Search** - HNSW algorithm, cosine similarity, BGE-M3
3. **BM25 (Best Match 25)** - Probabilistic ranking for full-text search
4. **Hybrid Search & RRF Fusion** - Combining vector and keyword search
5. **ATLAS-KG Chunking Strategy** - Our proprietary 6-component chunking approach
6. **Knowledge Graph Construction** - Entity extraction, co-occurrence analysis, IDF weighting
7. **TF-IDF for Noise Detection** - Filtering low-quality chunks
8. **Progressive Summarization** - Multi-level context preservation
9. **Question Synthesis** - Query-question matching for improved retrieval

**Quick Links:**

- [RAG Pipeline Architecture](./ALGORITHMS-DEEP-DIVE.md#1-retrieval-augmented-generation-rag)
- [Vector Embeddings & HNSW](./ALGORITHMS-DEEP-DIVE.md#2-vector-embeddings--similarity-search)
- [BM25 Formula & Examples](./ALGORITHMS-DEEP-DIVE.md#3-bm25-best-match-25)
- [ATLAS-KG Explained](./ALGORITHMS-DEEP-DIVE.md#5-atlas-kg-chunking-strategy)
- [Hands-On Algorithm Exercises](./ALGORITHMS-DEEP-DIVE.md#hands-on-exercises)

---

## Research Papers to Read

### Foundational Papers (Must Read)

#### 1. **Retrieval-Augmented Generation**

- **Title**: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"
- **Authors**: Lewis et al., Meta AI (2020)
- **Link**: https://arxiv.org/abs/2005.11401
- **Why**: Introduces the RAG paradigm that Search-AI implements
- **Key Takeaways**: Combining retrieval with generation improves factuality and reduces hallucination

#### 2. **Dense Passage Retrieval**

- **Title**: "Dense Passage Retrieval for Open-Domain Question Answering"
- **Authors**: Karpukhin et al., Meta AI (2020)
- **Link**: https://arxiv.org/abs/2004.04906
- **Why**: Foundation of vector-based semantic search
- **Key Takeaways**: Dense vectors outperform sparse (BM25) for semantic similarity

#### 3. **HNSW Algorithm**

- **Title**: "Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs"
- **Authors**: Malkov & Yashunin (2018)
- **Link**: https://arxiv.org/abs/1603.09320
- **Why**: Core algorithm behind OpenSearch k-NN
- **Key Takeaways**: Hierarchical graph structure enables sub-linear search time

#### 4. **BM25 and Beyond**

- **Title**: "The Probabilistic Relevance Framework: BM25 and Beyond"
- **Authors**: Robertson & Zaragoza (2009)
- **Link**: https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf
- **Why**: Understanding full-text search ranking
- **Key Takeaways**: BM25 is still the gold standard for keyword search

### Advanced Papers (Strongly Recommended)

#### 5. **Contextual Embeddings**

- **Title**: "Contextual Document Embeddings"
- **Authors**: Anthropic (2024)
- **Link**: https://www.anthropic.com/news/contextual-retrieval
- **Why**: Inspired our progressive summarization approach
- **Key Takeaways**: Adding document context to chunks improves retrieval by 35%

#### 6. **Lost in the Middle**

- **Title**: "Lost in the Middle: How Language Models Use Long Contexts"
- **Authors**: Liu et al., Stanford (2023)
- **Link**: https://arxiv.org/abs/2307.03172
- **Why**: Explains why chunk ordering matters
- **Key Takeaways**: LLMs pay more attention to start and end of context, not middle

#### 7. **Hypothetical Document Embeddings (HyDE)**

- **Title**: "Precise Zero-Shot Dense Retrieval without Relevance Labels"
- **Authors**: Gao et al., CMU (2022)
- **Link**: https://arxiv.org/abs/2212.10496
- **Why**: Novel approach to query reformulation
- **Key Takeaways**: Generate hypothetical answer, then search for similar documents

#### 8. **RAPTOR: Recursive Summarization**

- **Title**: "RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval"
- **Authors**: Sarthi et al., Stanford (2024)
- **Link**: https://arxiv.org/abs/2401.18059
- **Why**: Inspired our hierarchical chunking approach
- **Key Takeaways**: Multi-level summarization trees improve retrieval accuracy

### Emerging Research (Optional, but Valuable)

#### 9. **Knowledge Graphs for RAG**

- **Title**: "Benchmarking Large Language Models in Retrieval-Augmented Generation"
- **Authors**: Chen et al., 2023
- **Link**: https://arxiv.org/abs/2309.01431
- **Why**: Justifies our knowledge graph integration
- **Key Takeaways**: Graph-augmented RAG improves multi-hop reasoning

#### 10. **Chunking Strategies**

- **Title**: "Chunk, Align, Select: A Simple Long-Sequence Processing Method for Transformers"
- **Authors**: Ding et al., 2024
- **Link**: https://arxiv.org/abs/2308.13191
- **Why**: Research backing for our ATLAS-KG chunking decisions
- **Key Takeaways**: Zero-overlap chunking can outperform overlapping chunks

#### 11. **Reranking**

- **Title**: "RankGPT: Listwise Passage Reranking with Large Language Models"
- **Authors**: Sun et al., Google (2023)
- **Link**: https://arxiv.org/abs/2304.09542
- **Why**: Reranking significantly improves top-k precision
- **Key Takeaways**: LLM-based reranking beats traditional cross-encoders

---

## Skills Development Path

### Month 1: Foundations

**Week 1-2: TypeScript & Node.js**

- [ ] Complete TypeScript Deep Dive (https://basarat.gitbook.io/typescript/)
- [ ] Build a simple Express REST API with TypeScript
- [ ] Learn async/await, Promises, error handling
- [ ] Understand TypeScript generics and discriminated unions

**Week 3-4: Core Data Structures**

- [ ] Implement vector similarity search in TypeScript
- [ ] Build a simple in-memory inverted index (BM25)
- [ ] Understand MongoDB aggregation pipelines
- [ ] Learn OpenSearch query DSL basics

### Month 2: RAG Fundamentals

**Week 1-2: Embedding & Vector Search**

- [ ] Run BGE-M3 locally, generate embeddings for sample docs
- [ ] Implement cosine similarity from scratch
- [ ] Set up OpenSearch k-NN index
- [ ] Experiment with different `ef_search` and `m` parameters

**Week 3-4: Text Retrieval**

- [ ] Implement BM25 from scratch
- [ ] Build a hybrid search (vector + BM25)
- [ ] Implement RRF fusion
- [ ] Compare retrieval quality metrics (Precision@K, Recall@K)

### Month 3: Advanced Techniques

**Week 1-2: Knowledge Graphs**

- [ ] Learn Neo4j and Cypher query language
- [ ] Implement entity extraction using Compromise NLP
- [ ] Build co-occurrence matrix with IDF weighting
- [ ] Create simple graph visualization

**Week 3-4: LLM Integration**

- [ ] Use Vercel AI SDK to call Claude/GPT
- [ ] Implement progressive summarization
- [ ] Build question synthesis pipeline
- [ ] Experiment with different prompt templates

### Month 4: Production Engineering

**Week 1-2: Job Queues & Workers**

- [ ] Learn BullMQ, build a simple worker
- [ ] Implement job retry logic with exponential backoff
- [ ] Understand concurrency and rate limiting
- [ ] Build a worker health monitoring system

**Week 3-4: System Integration**

- [ ] Contribute to a real Search-AI worker
- [ ] Debug a production issue end-to-end
- [ ] Write integration tests for a pipeline stage
- [ ] Optimize a slow query or worker

### Month 5: Kubernetes & Stateful Services

**Week 1-2: Kubernetes Fundamentals**

- [ ] Complete Kubernetes Up and Running book (Chapters 1-12)
- [ ] Deploy StatefulSet with MongoDB in local Kubernetes (minikube/kind)
- [ ] Understand PersistentVolumes and StorageClasses
- [ ] Configure headless services for pod discovery

**Week 3-4: Database Replication**

- [ ] Set up 3-node MongoDB replica set in Kubernetes
- [ ] Configure OpenSearch cluster (3 master, 3 data nodes)
- [ ] Implement read preference strategies (secondaryPreferred)
- [ ] Test failover scenarios (kill primary node)

### Month 6: Production Operations

**Week 1-2: Observability**

- [ ] Set up Prometheus to scrape Search-AI metrics
- [ ] Create Grafana dashboards for workers and queues
- [ ] Implement distributed tracing with OpenTelemetry
- [ ] Configure alerts for critical thresholds

**Week 3-4: Disaster Recovery**

- [ ] Implement automated MongoDB backups (mongodump)
- [ ] Configure OpenSearch snapshot repository (S3)
- [ ] Write disaster recovery runbook
- [ ] Execute DR drill (restore from backup)

---

## Learning Resources

### Online Courses

#### Vector Search & Embeddings

1. **"Embeddings and Vector Databases" by DeepLearning.AI**
   - Free on Coursera
   - https://www.deeplearning.ai/short-courses/

2. **"Building RAG Applications" by LangChain**
   - Free short course
   - https://www.deeplearning.ai/short-courses/langchain-rag/

#### Knowledge Graphs

3. **"Introduction to Neo4j" by Neo4j GraphAcademy**
   - Free, hands-on
   - https://graphacademy.neo4j.com/

#### Machine Learning

4. **"Fast.ai Practical Deep Learning"**
   - Free, code-first approach
   - https://course.fast.ai/

### Books

1. **"Speech and Language Processing" by Jurafsky & Martin**
   - Chapters 23-24 on Information Retrieval
   - Free online: https://web.stanford.edu/~jurafsky/slp3/

2. **"Introduction to Information Retrieval" by Manning et al.**
   - Stanford NLP bible
   - Free online: https://nlp.stanford.edu/IR-book/

3. **"Designing Data-Intensive Applications" by Martin Kleppmann**
   - Essential for understanding distributed systems
   - Chapters on replication, partitioning, consistency

4. **"Graph Algorithms" by Mark Needham & Amy Hodler**
   - Neo4j perspective on graph processing
   - Free: https://neo4j.com/graph-algorithms-book/

### Video Content

1. **"Retrieval-Augmented Generation" by Pinecone**
   - YouTube series on modern RAG techniques
   - https://www.youtube.com/c/Pinecone

2. **"Vector Search Explained" by Weaviate**
   - Deep dive into HNSW and vector indexing
   - https://www.youtube.com/c/Weaviate

### Tutorials & Labs

1. **OpenSearch k-NN Plugin Tutorial**
   - Hands-on vector search
   - https://opensearch.org/docs/latest/search-plugins/knn/

2. **BullMQ Patterns & Best Practices**
   - Official guide
   - https://docs.bullmq.io/patterns/

3. **Neo4j Cypher Tutorials**
   - Interactive Cypher queries
   - https://neo4j.com/developer/cypher/

---

## News Feeds & Channels

### Must-Follow Blogs

1. **OpenAI Research Blog**
   - https://openai.com/research/
   - Latest in LLMs, embeddings, evaluation

2. **Anthropic Blog**
   - https://www.anthropic.com/news
   - Claude updates, AI safety, prompt engineering

3. **Hugging Face Blog**
   - https://huggingface.co/blog
   - Open-source models, datasets, techniques

4. **Pinecone Blog**
   - https://www.pinecone.io/blog/
   - Vector database best practices

5. **Neo4j Developer Blog**
   - https://neo4j.com/blog/
   - Knowledge graphs in production

6. **OpenSearch Blog**
   - https://opensearch.org/blog/
   - Search engine updates, k-NN improvements

### Academic Feeds

1. **arXiv cs.IR (Information Retrieval)**
   - https://arxiv.org/list/cs.IR/recent
   - Latest retrieval research

2. **arXiv cs.CL (Computation & Language)**
   - https://arxiv.org/list/cs.CL/recent
   - NLP and LLM papers

3. **Papers With Code - NLP**
   - https://paperswithcode.com/area/natural-language-processing
   - Implementations of latest papers

### Twitter/X Accounts

1. **@OpenAI** - Official updates
2. **@AnthropicAI** - Claude news
3. **@HuggingFace** - Model releases
4. **@chipro** (Chip Huyen) - MLOps insights
5. **@jeremyphoward** (Jeremy Howard) - Fast.ai founder
6. **@ylecun** (Yann LeCun) - Meta AI Chief
7. **@karpathy** (Andrej Karpathy) - AI educator

### YouTube Channels

1. **Two Minute Papers**
   - https://www.youtube.com/@TwoMinutePapers
   - Research paper summaries

2. **Yannic Kilcher**
   - https://www.youtube.com/@YannicKilcher
   - Deep paper reviews

3. **AI Explained**
   - https://www.youtube.com/@ai-explained
   - LLM developments

### Newsletters

1. **The Batch by DeepLearning.AI**
   - Weekly AI news
   - https://www.deeplearning.ai/the-batch/

2. **Import AI by Jack Clark**
   - Weekly paper summaries
   - https://importai.substack.com/

3. **TLDR AI**
   - Daily AI news digest
   - https://tldr.tech/ai

### Slack/Discord Communities

1. **OpenSearch Community Slack**
   - https://opensearch.org/slack.html

2. **Hugging Face Discord**
   - https://discord.com/invite/hugging-face

3. **Neo4j Community**
   - https://community.neo4j.com/

### Conferences (Watch Recordings)

1. **NeurIPS** (Neural Information Processing Systems)
2. **SIGIR** (Special Interest Group on Information Retrieval)
3. **EMNLP** (Empirical Methods in NLP)
4. **ACL** (Association for Computational Linguistics)
5. **AI Engineer Summit** (Practical AI engineering)

---

## First 90 Days Roadmap

> **Note:** This roadmap assumes full-time onboarding focus with minimal production interruptions. If onboarding alongside production work, adjust timelines to 120-180 days. The goal is thorough learning, not rushing through topics.

### Phase 1: Application Development (Days 1-30)

### Days 1-5: Environment Setup & Codebase Exploration

**Goals:**

- [ ] Get local development environment running
- [ ] Understand repository structure
- [ ] Run Search-AI locally with all dependencies

**Tasks:**

1. Clone repository, install dependencies (`pnpm install`)
2. Start infrastructure: `docker compose up -d`
3. Build packages: `pnpm build`
4. Run Search-AI: `cd apps/search-ai && pnpm dev`
5. Create test index via API
6. Upload sample document and watch it flow through pipeline

**Reading:**

- [ ] `docs/searchai/00-START-HERE.md`
- [ ] `docs/searchai/SERVICES-INVENTORY.md`
- [ ] `apps/search-ai/README.md`

### Days 6-10: Architecture Deep Dive

**Goals:**

- [ ] Understand ingestion pipeline flow
- [ ] Understand query pipeline flow
- [ ] Map out worker interactions

**Tasks:**

1. Trace a document from upload to indexed (add logging)
2. Trace a query from request to response
3. Draw architecture diagrams on whiteboard
4. Identify key decision points in code

**Reading:**

- [ ] `docs/searchai/design/SEARCHAI-ARCHITECTURE.md` (complete system architecture)
- [ ] `docs/searchai/design/QUERY-PIPELINE-DESIGN.md`
- [ ] `docs/searchai/DATABASE-SCHEMA.md`

### Days 11-15: Core Concepts

**Goals:**

- [ ] Understand vector embeddings
- [ ] Understand chunking strategies
- [ ] Run experiments with different configurations

**Tasks:**

1. Generate embeddings for sample texts using BGE-M3
2. Calculate cosine similarity manually
3. Compare different chunking strategies (token-based, page-based, markdown)
4. Modify chunk size and observe effects on retrieval

**Reading:**

- [ ] Papers: RAG (Lewis et al.), Dense Passage Retrieval
- [ ] `docs/searchai/EMBEDDING-GUIDE.md`

### Days 16-20: Workers & Job Queues

**Goals:**

- [ ] Understand BullMQ worker pattern
- [ ] Debug a worker failure
- [ ] Modify a worker

**Tasks:**

1. Add custom logging to `page-processing-worker.ts`
2. Intentionally break a worker, observe error handling
3. Modify `enrichment-worker.ts` to add custom metadata field
4. Monitor Redis queues in real-time

**Reading:**

- [ ] BullMQ documentation: https://docs.bullmq.io/
- [ ] `apps/search-ai/src/workers/README.md` (if exists)

### Days 21-25: Knowledge Graph

**Goals:**

- [ ] Understand entity extraction
- [ ] Query Neo4j graph
- [ ] Modify entity extraction logic

**Tasks:**

1. Install Neo4j Browser, explore ingested entities
2. Write Cypher queries to find co-occurring entities
3. Add a new entity type to regex extraction patterns
4. Visualize entity relationships

**Reading:**

- [ ] `apps/search-ai/KNOWLEDGE_GRAPH.md`
- [ ] Neo4j GraphAcademy intro course

### Days 26-30: First Contribution

**Goals:**

- [ ] Fix a bug or implement a small feature
- [ ] Write tests
- [ ] Submit pull request

**Tasks:**

1. Pick a good first issue from backlog
2. Implement fix/feature
3. Write unit tests
4. Run integration tests
5. Submit PR with clear description

**Celebration:**
🎉 You've completed Phase 1! You understand application architecture and can contribute to workers and APIs.

---

### Phase 2: Infrastructure & Kubernetes (Days 31-60)

### Days 31-40: Kubernetes Basics

**Goals:**

- [ ] Deploy stateful services in Kubernetes
- [ ] Understand StatefulSets and persistent storage

**Tasks:**

1. Install minikube or kind (local Kubernetes)
2. Deploy MongoDB StatefulSet with 3 replicas
3. Configure PersistentVolumes and StorageClasses
4. Set up headless service for MongoDB discovery
5. Test pod restart (verify data persists)

**Reading:**

- [ ] "Kubernetes Up and Running" - Chapters 11-12
- [ ] Official Kubernetes StatefulSet tutorial

### Days 41-50: Database Replication & High Availability

**Goals:**

- [ ] Configure MongoDB replica sets
- [ ] Set up OpenSearch cluster

**Tasks:**

1. Initialize MongoDB replica set in Kubernetes
2. Test read preferences (primary, secondaryPreferred)
3. Test failover (kill primary pod, observe election)
4. Deploy 3-node OpenSearch cluster
5. Configure shard allocation and replication

**Reading:**

- [ ] MongoDB Replication documentation
- [ ] OpenSearch cluster setup guide

### Days 51-60: Connection Pooling & Distributed Systems

**Goals:**

- [ ] Size connection pools correctly
- [ ] Implement distributed locks

**Tasks:**

1. Monitor MongoDB connection pool health
2. Calculate optimal pool sizes for worker concurrency
3. Implement Redis distributed lock
4. Test lock under concurrent workers
5. Debug simulated connection leak

**Reading:**

- [ ] MongoDB Connection Pooling best practices
- [ ] Redlock algorithm paper

---

### Phase 3: Production Operations (Days 61-90)

### Days 61-75: Observability & Monitoring

**Goals:**

- [ ] Set up Prometheus and Grafana
- [ ] Implement distributed tracing

**Tasks:**

1. Deploy Prometheus in Kubernetes
2. Configure Search-AI to expose metrics
3. Create Grafana dashboard for:
   - Worker queue depths
   - MongoDB connection pool stats
   - OpenSearch query latency
4. Set up OpenTelemetry tracing
5. Trace document ingestion end-to-end

**Reading:**

- [ ] Prometheus documentation
- [ ] OpenTelemetry getting started

### Days 76-90: Disaster Recovery & Production Readiness

**Goals:**

- [ ] Implement backup automation
- [ ] Execute disaster recovery drill

**Tasks:**

1. Configure automated MongoDB backups (cronjob)
2. Set up OpenSearch snapshot repository (S3)
3. Write disaster recovery runbook
4. Execute DR drill:
   - Delete test database
   - Restore from backup
   - Verify data integrity
5. Production readiness review

**Reading:**

- [ ] MongoDB Backup and Restore guide
- [ ] OpenSearch Snapshot documentation

**Final Celebration:**
🎉🚀 You've completed full onboarding! You can now develop features AND deploy them to production.

---

## Hands-On Exercises

> **Algorithm Exercises:** For hands-on exercises on vector search, BM25, chunking, entity extraction, and reranking (Exercises 1-5), see **[ALGORITHMS-DEEP-DIVE.md § Hands-On Exercises](./ALGORITHMS-DEEP-DIVE.md#hands-on-exercises)**.

This section focuses on **infrastructure and production operations** exercises.

### Exercise 6: Worker Development

**Objective:** Create a custom worker.

**Steps:**

1. Define job payload schema
2. Implement worker processing function
3. Add error handling and retries
4. Write unit tests
5. Integrate with existing pipeline
6. Monitor in Redis

**Expected Time:** 12 hours

**Skills Gained:**

- BullMQ patterns
- Error handling
- Testing

### Exercise 7: Deploy MongoDB Replica Set

**Objective:** Set up a 3-node MongoDB replica set in Kubernetes.

**Steps:**

1. Create StatefulSet YAML for MongoDB (3 replicas)
2. Configure volumeClaimTemplates for persistent storage
3. Deploy to local Kubernetes (minikube/kind)
4. Initialize replica set via mongosh
5. Test read preferences (primary vs secondaryPreferred)
6. Simulate primary failure, observe election

**Expected Time:** 6 hours

**Skills Gained:**

- Kubernetes StatefulSets
- MongoDB replication
- High availability patterns

### Exercise 8: Connection Pool Monitoring

**Objective:** Monitor and optimize MongoDB connection pooling.

**Steps:**

1. Add connection pool monitoring to Search-AI
2. Run workers under load (ingest 100 documents)
3. Track pool metrics (available, in-use, waiting)
4. Intentionally exhaust pool (reduce maxPoolSize to 5)
5. Observe errors and fix by increasing pool size
6. Calculate optimal pool size for worker concurrency

**Expected Time:** 4 hours

**Skills Gained:**

- Connection pooling
- Performance debugging
- Resource optimization

### Exercise 9: Distributed Lock Implementation

**Objective:** Implement Redis distributed lock to prevent duplicate processing.

**Steps:**

1. Implement `acquireLock()` and `releaseLock()` functions
2. Add lock to document processing worker
3. Test with 3 concurrent workers processing same document
4. Verify only one worker processes (others skip)
5. Test lock timeout and renewal
6. Measure lock contention under load

**Expected Time:** 4 hours

**Skills Gained:**

- Distributed systems
- Race condition prevention
- Redis operations

### Exercise 10: Prometheus Monitoring Dashboard

**Objective:** Create a Grafana dashboard for Search-AI metrics.

**Steps:**

1. Deploy Prometheus to local Kubernetes
2. Add Prometheus annotations to Search-AI deployment
3. Expose custom metrics from workers:
   - Queue depth (gauge)
   - Processing time (histogram)
   - Error rate (counter)
4. Deploy Grafana, connect to Prometheus
5. Create dashboard with 6 panels:
   - Worker queue depths
   - Processing latency (p50, p95, p99)
   - Error rate
   - MongoDB connection pool usage
   - OpenSearch query latency
   - Job throughput (jobs/sec)

**Expected Time:** 6 hours

**Skills Gained:**

- Prometheus metrics
- Grafana dashboards
- Production observability

---

## Debugging & Troubleshooting Guide

### Common Issues for New Developers

#### Issue 1: Worker Not Processing Jobs

**Symptoms:**

- Jobs stuck in queue
- Worker appears idle

**Debug Steps:**

1. Check Redis connection: `redis-cli ping`
2. Check worker logs for errors
3. Verify queue name matches
4. Check concurrency settings
5. Look for unhandled promise rejections

**Common Causes:**

- Database connection timeout
- Unhandled async errors
- Queue name typo
- Redis out of memory

#### Issue 2: Embeddings Not Generating

**Symptoms:**

- Chunks created but no `vectorId`
- Embedding worker fails silently

**Debug Steps:**

1. Check BGE-M3 service: `curl http://localhost:8001/health`
2. Verify chunk text length (max 8192 tokens)
3. Check API key if using OpenAI
4. Look for rate limiting errors

#### Issue 3: OpenSearch Query Fails

**Symptoms:**

- Search returns no results
- Timeout errors

**Debug Steps:**

1. Verify index exists: `GET /_cat/indices`
2. Check field mappings: `GET /index-name/_mapping`
3. Test query in OpenSearch console
4. Check tenant isolation filters
5. Verify vector dimensions match

#### Issue 4: Connection Pool Exhausted

**Symptoms:**

- `MongoServerSelectionError: connection pool destroyed`
- Workers hang waiting for database connections
- Slow query performance

**Debug Steps:**

1. Monitor pool health:
   ```typescript
   const pool = mongoose.connection.getClient().topology.s.pool;
   console.log({
     total: pool.totalConnectionCount,
     available: pool.availableConnectionCount,
     inUse: pool.currentCheckoutCount,
     waiting: pool.waitQueueSize, // HIGH = problem!
   });
   ```
2. Check `MONGODB_MAX_POOL_SIZE` in env
3. Calculate required pool size: `workers × concurrency × 1.1`
4. Look for connection leaks (unclosed cursors/sessions)
5. Increase pool size if undersized

**Common Causes:**

- Pool too small for worker concurrency
- Unclosed MongoDB cursors
- Unclosed Neo4j sessions
- Long-running transactions blocking connections

**Fix:**

```bash
# Increase pool size
MONGODB_MAX_POOL_SIZE=100  # Was 50

# Or reduce worker concurrency
WORKER_CONCURRENCY=3  # Was 5
```

---

## Glossary

**ATLAS-KG**: Adaptive Topology Linguistic Augmentation with Semantic Knowledge Graphs - our proprietary chunking architecture

**BGE-M3**: BAAI General Embedding Multilingual Model - our default embedding model

**BM25**: Best Match 25 - probabilistic ranking function for full-text search

**BullMQ**: Node.js job queue library built on Redis

**Chunk**: A segment of a document, typically 512-2048 tokens

**Co-occurrence**: When two entities appear together in the same chunk

**Connection Pool**: Set of reusable database connections to prevent connection exhaustion

**Distributed Lock**: Coordination mechanism using Redis to prevent concurrent processing of same resource

**Docling**: IBM's document layout extraction service

**HNSW**: Hierarchical Navigable Small World - approximate nearest neighbor algorithm

**IDF**: Inverse Document Frequency - measures term rarity

**IndexRegistry**: System for routing documents to appropriate OpenSearch indices

**k-NN**: k-Nearest Neighbors - vector similarity search

**RAG**: Retrieval-Augmented Generation

**Replica Set**: MongoDB cluster with automatic failover (primary + secondaries)

**RRF**: Reciprocal Rank Fusion - method for combining ranked lists

**StatefulSet**: Kubernetes workload for stateful services with stable identity and persistent storage

**TF-IDF**: Term Frequency - Inverse Document Frequency

**Vector Store**: Database optimized for vector similarity search (OpenSearch, Qdrant, Pinecone)

---

## Next Steps After Onboarding

After completing this onboarding guide, you should:

1. **Specialize** in one area:
   - Ingestion pipeline optimization
   - Query performance tuning
   - Knowledge graph development
   - LLM integration
   - Infrastructure scaling

2. **Contribute** to documentation:
   - Add missing examples
   - Clarify confusing sections
   - Update outdated information

3. **Mentor** new team members:
   - Share your learning experience
   - Improve onboarding process

4. **Research** cutting-edge techniques:
   - Read latest papers
   - Prototype new features
   - Propose improvements

5. **Present** your work:
   - Team demos
   - Architecture reviews
   - Conference talks

---

## Contact & Support

**Team Slack Channels:**

- `#search-ai-dev` - Development discussions
- `#search-ai-architecture` - Design decisions
- `#search-ai-support` - User support

**Team Leads:**

- Architecture: [TBD]
- Backend: [TBD]
- ML/NLP: [TBD]

**Office Hours:**

- Wednesdays 2-3 PM - Open Q&A
- Fridays 10-11 AM - Pair programming

---

**Welcome to the team! We're excited to have you contribute to Search-AI. 🚀**

---

**Document Version:** 1.0
**Last Updated:** 2026-03-04
**Maintained By:** Search-AI Team
