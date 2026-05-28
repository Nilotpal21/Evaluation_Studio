# Search-AI Algorithms Deep Dive

**Version:** 1.0
**Date:** 2026-03-04
**Purpose:** Deep dive into core algorithms powering Search-AI's RAG pipeline

---

## Table of Contents

1. [Introduction](#introduction)
2. [Retrieval-Augmented Generation (RAG)](#1-retrieval-augmented-generation-rag)
3. [Vector Embeddings & Similarity Search](#2-vector-embeddings--similarity-search)
4. [BM25 (Best Match 25)](#3-bm25-best-match-25)
5. [Hybrid Search & RRF Fusion](#4-hybrid-search--rrf-fusion)
6. [ATLAS-KG Chunking Strategy](#5-atlas-kg-chunking-strategy)
7. [Knowledge Graph Construction](#6-knowledge-graph-construction)
8. [TF-IDF for Noise Detection](#7-tf-idf-for-noise-detection)
9. [Progressive Summarization](#8-progressive-summarization)
10. [Question Synthesis](#9-question-synthesis)
11. [Hands-On Exercises](#hands-on-exercises)

---

## Introduction

This guide provides a **deep dive into the core algorithms** that power Search-AI's RAG (Retrieval-Augmented Generation) pipeline. While the main [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) covers architecture and development workflows, this guide focuses on the mathematical and algorithmic foundations.

**What You'll Learn:**

- How vector embeddings and similarity search work (HNSW, cosine similarity)
- BM25 ranking for full-text search
- Hybrid search fusion with RRF (Reciprocal Rank Fusion)
- ATLAS-KG chunking strategy (our proprietary approach)
- Knowledge graph construction and entity co-occurrence
- Noise detection using TF-IDF
- Progressive summarization and question synthesis

**Prerequisites:**

- Basic linear algebra (vectors, dot products)
- Understanding of probability and statistics
- Familiarity with information retrieval concepts

**Related Documents:**

- [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) - Core onboarding, architecture, security
- [INFRASTRUCTURE-GUIDE.md](./INFRASTRUCTURE-GUIDE.md) - Production infrastructure, databases, monitoring

---

## 1. Retrieval-Augmented Generation (RAG)

### What It Is

RAG combines information retrieval with large language models. Instead of relying solely on the LLM's training data, the system first retrieves relevant documents, then feeds them as context to the LLM for generation.

### Core Components

- **Retriever**: Finds relevant documents (vector search, BM25)
- **Generator**: LLM that uses retrieved context to answer queries
- **Context Window**: Limited token budget (typically 20K-100K tokens)

### Why It Matters

RAG is the foundation of modern enterprise AI systems. Understanding RAG deeply is essential for working on Search-AI.

### Key Challenges We Solve

1. **Context fragmentation across chunks** - Documents split into chunks lose coherence
2. **Information noise** - Low-quality chunks dilute context quality
3. **Lost structure** - Tables, hierarchies, and formatting get lost in chunking
4. **Ballooning costs** - Over-retrieval wastes tokens and increases LLM costs
5. **Temporal context loss** - Recency and version information gets lost
6. **Entity relationship blindness** - Connections between entities across documents are missed

### RAG Pipeline Architecture

```
Query → Embedding → Retrieval → Reranking → Context Packing → LLM Generation → Response
```

**Search-AI's RAG Pipeline:**

```
1. Query Preprocessing
   ├─ Vocabulary resolution (synonyms)
   ├─ Query expansion
   └─ Embedding generation (BGE-M3)

2. Hybrid Retrieval
   ├─ Vector search (k-NN, cosine similarity)
   ├─ BM25 full-text search
   └─ Knowledge graph traversal (optional)

3. Fusion & Reranking
   ├─ RRF (Reciprocal Rank Fusion)
   └─ Cross-encoder reranking (Cohere)

4. Context Packing
   ├─ Token budget allocation (20K tokens)
   ├─ Progressive summarization (if needed)
   └─ Metadata injection

5. LLM Generation
   └─ Generate answer with citations
```

---

## 2. Vector Embeddings & Similarity Search

### Concept

Convert text into dense numerical vectors (e.g., 768 or 1536 dimensions) where semantically similar texts have similar vectors.

**Example:**

```
"machine learning" → [0.23, -0.45, 0.78, ..., 0.12]  (768 dimensions)
"artificial intelligence" → [0.25, -0.43, 0.76, ..., 0.14]  (similar vector)
"banana smoothie" → [-0.67, 0.89, -0.23, ..., 0.45]  (different vector)
```

### Key Algorithms

#### HNSW (Hierarchical Navigable Small World)

Fast approximate nearest neighbor search.

**How it Works:**

1. Build a graph where each node is a vector
2. Navigate graph hierarchically to find nearest neighbors
3. Trade-off: `ef_construction` (build time) vs `ef_search` (query time)

**Visualization:**

```
Layer 2:  A ──────────── F  (Long-range connections)
         /              /
Layer 1: A ── C ── E ── F   (Mid-range connections)
        /|    |    |    |\
Layer 0: A B C D E F G H I  (All vectors, short-range connections)
```

**OpenSearch k-NN Configuration:**

```json
{
  "type": "knn_vector",
  "dimension": 1024,
  "method": {
    "name": "hnsw",
    "engine": "nmslib",
    "parameters": {
      "ef_construction": 512,
      "m": 16
    }
  }
}
```

**Parameters to Understand:**

- `m`: Number of bidirectional links per node (higher = better recall, more memory)
- `ef_construction`: Size of dynamic candidate list during build (higher = better quality)
- `ef_search`: Size of dynamic candidate list during search (higher = better recall)

#### Cosine Similarity

Measures angle between vectors.

**Formula:**

```
similarity = (A · B) / (||A|| × ||B||)
Range: -1 (opposite) to 1 (identical)
```

**Example Calculation:**

```
A = [1, 2, 3]
B = [2, 3, 4]

A · B = (1×2) + (2×3) + (3×4) = 2 + 6 + 12 = 20
||A|| = √(1² + 2² + 3²) = √14 ≈ 3.74
||B|| = √(2² + 3² + 4²) = √29 ≈ 5.39

similarity = 20 / (3.74 × 5.39) ≈ 0.99 (very similar!)
```

### BGE-M3 Embedding Model

**Search-AI uses BGE-M3** (BAAI General Embedding Multilingual Model):

- **Dimensions**: 1024
- **Max input tokens**: 8192
- **Languages**: 100+ (multilingual)
- **Performance**: State-of-the-art on MTEB benchmark

**API Usage:**

> **Note:** Check your deployment configuration for the actual BGE-M3 endpoint. The service URL is configured via `EMBEDDING_SERVICE_URL` environment variable.

```typescript
const response = await fetch('http://bge-m3:8000/embed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'your text here' }),
});

const { embedding } = await response.json();
// embedding: number[] (1024 dimensions)
```

---

## 3. BM25 (Best Match 25)

### What It Is

Probabilistic text ranking function for full-text search. Ranks documents based on term frequency (TF) and inverse document frequency (IDF).

### Formula

```
BM25(D, Q) = Σ IDF(qi) × (f(qi,D) × (k1 + 1)) / (f(qi,D) + k1 × (1 - b + b × |D| / avgdl))

Where:
- D: Document
- Q: Query
- qi: Query term i
- f(qi,D): Frequency of term qi in document D
- |D|: Document length (words)
- avgdl: Average document length in corpus
- k1: Term saturation parameter (default: 1.2)
- b: Length normalization parameter (default: 0.75)
```

### Parameters

- **k1** (default: 1.2): Controls term saturation
  - Higher k1 = term frequency matters more
  - Lower k1 = diminishing returns on repeated terms
- **b** (default: 0.75): Controls document length normalization
  - b=1: Full normalization (penalize long documents)
  - b=0: No normalization (don't penalize long documents)

### Why It's Important

BM25 is the **gold standard for keyword search**. It outperforms simpler TF-IDF for ranking because:

1. **Saturation**: Repeated terms have diminishing returns (not linear)
2. **Length normalization**: Adjusts for document length (long docs aren't unfairly penalized)
3. **IDF weighting**: Rare terms are more important than common terms

### Example Calculation

**Corpus:**

```
Doc 1: "machine learning is a subset of artificial intelligence"
Doc 2: "deep learning is a subset of machine learning"
Doc 3: "neural networks are used in deep learning"
```

**Query:** "machine learning"

**Step 1: Calculate IDF**

```
IDF("machine") = log((N - df("machine") + 0.5) / (df("machine") + 0.5))
               = log((3 - 2 + 0.5) / (2 + 0.5))
               = log(1.5 / 2.5) ≈ -0.51

IDF("learning") = log((3 - 3 + 0.5) / (3 + 0.5))
                = log(0.5 / 3.5) ≈ -1.95
```

**Step 2: Calculate BM25 for Doc 1**

```
f("machine", Doc1) = 1
f("learning", Doc1) = 1
|Doc1| = 9 words
avgdl = (9 + 9 + 7) / 3 = 8.33

BM25(Doc1, "machine") = (-0.51) × (1 × 2.2) / (1 + 1.2 × (1 - 0.75 + 0.75 × 9/8.33))
                      ≈ -0.51 × 2.2 / 2.28 ≈ -0.49

BM25(Doc1, "learning") = (-1.95) × (1 × 2.2) / 2.28 ≈ -1.88

Total BM25(Doc1) ≈ -2.37
```

_(Repeat for Doc 2 and Doc 3, rank by highest score)_

---

## 4. Hybrid Search & RRF Fusion

### Why Hybrid Search?

**Vector search** is great for semantic similarity but misses exact keyword matches.
**BM25 search** is great for keyword matching but misses semantic similarity.
**Hybrid search combines both** for best results.

### Reciprocal Rank Fusion (RRF)

Combines ranked lists from multiple retrieval methods.

**Formula:**

```
RRF(d) = Σ 1 / (k + rank_i(d))

Where:
- d: document
- rank_i(d): rank of document in i-th list
- k: constant (typically 60)
```

### Example

**Vector Search Results:**

```
1. Doc A (score: 0.95)
2. Doc C (score: 0.88)
3. Doc B (score: 0.82)
```

**BM25 Results:**

```
1. Doc B (score: 12.5)
2. Doc A (score: 10.2)
3. Doc D (score: 8.7)
```

**RRF Calculation:**

```
Doc A: 1/(60+1) + 1/(60+2) = 0.0164 + 0.0161 = 0.0325
Doc B: 1/(60+3) + 1/(60+1) = 0.0159 + 0.0164 = 0.0323
Doc C: 1/(60+2) + 0        = 0.0161 + 0      = 0.0161
Doc D: 0        + 1/(60+3) = 0      + 0.0159 = 0.0159
```

**Final Ranking:** A, B, C, D

### OpenSearch Hybrid Search

```json
POST /search-index/_search
{
  "query": {
    "hybrid": {
      "queries": [
        {
          "knn": {
            "embedding": { "vector": [...], "k": 20 }
          }
        },
        {
          "match": { "content": "machine learning" }
        }
      ]
    }
  }
}
```

---

## 5. ATLAS-KG Chunking Strategy

### Problem

Traditional fixed-size chunking breaks semantic relationships and loses document structure.

**Example Problem:**

```
Original Document:
┌─────────────────────────┐
│ Table: Q3 Sales Results │
├──────────┬──────────────┤
│ Region   │ Revenue      │
├──────────┼──────────────┤
│ North    │ $2.5M        │
│ South    │ $3.1M        │
└──────────┴──────────────┘

Fixed Chunking (512 tokens):
Chunk 1: "Table: Q3 Sales Results Region Revenue"
Chunk 2: "North $2.5M South $3.1M"

❌ Table structure lost!
❌ Context fragmented!
```

### ATLAS-KG Solution

**ATLAS-KG** = Adaptive Topology Linguistic Augmentation with Semantic Knowledge Graphs

**Six Integrated Components:**

1. **Layout-Aware Extraction**: Use Docling to preserve tables, lists, hierarchies
2. **Noise Detection**: Filter low-quality chunks using TF-IDF before embedding
3. **Progressive Summarization**: Generate summaries at multiple granularities
4. **Question Synthesis**: Create questions that chunks can answer
5. **Knowledge Graph**: Extract entities and relationships across documents
6. **Tree Building**: Organize chunks hierarchically for better retrieval

### Key Innovation

Integrate all six components so they **amplify each other**, rather than treating them as independent optimizations.

**Example Integration:**

```
Document → Docling (preserve table)
         → Chunk with table metadata
         → TF-IDF filter (remove boilerplate)
         → Generate summary ("Q3 sales data")
         → Synthesize questions ("What were Q3 sales?")
         → Extract entities (North, South, $2.5M, $3.1M)
         → Build KG edges (North →REVENUE→ $2.5M)
         → Embed chunk + metadata
```

### Layout-Aware Extraction (Docling)

**Docling** is IBM's document layout extraction service that preserves structure.

**Features:**

- Table extraction with cell positions
- List hierarchy detection
- Section heading recognition
- Image caption extraction
- Footnote linking

**API Usage:**

> **Note:** Check your deployment configuration for the actual Docling endpoint. The service URL is configured via `DOCLING_SERVICE_URL` environment variable.

```typescript
const response = await fetch('http://docling:8080/parse', {
  method: 'POST',
  body: pdfBuffer,
});

const { pages, tables, images } = await response.json();
```

### Chunking Strategy

**Search-AI's chunking approach (architectural pseudocode):**

```typescript
1. Parse document with Docling (get layout structure)
2. Segment by section (use headings as boundaries)
3. For each section:
   a. If section < 2048 tokens: Keep as single chunk
   b. If section > 2048 tokens: Split by paragraph with 200-token overlap
   c. If table: Extract as single chunk with metadata
4. Generate metadata for each chunk:
   - Section hierarchy (H1 → H2 → H3)
   - Page number
   - Document title
   - Parent chunk ID (for tree structure)
5. TF-IDF filter (remove chunks with score < 0.1)
6. Generate summaries (100-200 tokens per chunk)
7. Synthesize questions (3-5 per chunk)
8. Extract entities, build co-occurrence graph
```

---

## 6. Knowledge Graph Construction

### Purpose

Build a graph of entities and relationships across documents to enable:

- Entity-centric search ("Find all documents mentioning Dr. Smith")
- Relationship traversal ("What companies did Dr. Smith work with?")
- Cross-document insights ("Which entities appear in both Contract A and Policy B?")

### Entity Extraction Methods

#### 1. Regex Patterns (Fast, Deterministic)

```typescript
const patterns = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  url: /https?:\/\/[^\s]+/g,
  money: /\$[\d,]+(?:\.\d{2})?/g,
  date: /\b\d{4}-\d{2}-\d{2}\b/g,
};
```

#### 2. Compromise NLP (Semantic Extraction)

```typescript
import nlp from 'compromise';

const doc = nlp('Dr. Jane Smith works at Acme Corp in New York.');
const people = doc.people().out('array'); // ["Dr. Jane Smith"]
const orgs = doc.organizations().out('array'); // ["Acme Corp"]
const places = doc.places().out('array'); // ["New York"]
```

#### 3. Hybrid Approach

Combine both methods, deduplicate, and merge:

```typescript
const entities = [...extractRegexEntities(text), ...extractNLPEntities(text)];

// Deduplicate by normalized form
const uniqueEntities = deduplicateEntities(entities);
```

### Co-Occurrence Analysis

Calculate **IDF-weighted relationships** between entities that appear together.

**Formula:**

```
Weight = min(IDF_entity1, IDF_entity2) × co_occurrence_count

IDF = log(total_chunks / chunks_containing_entity)
```

**Why IDF Weighting:**

- **Rare entities co-occurring** = strong signal (e.g., "Dr. Smith" + "Quantum Physics Project")
- **Common entities co-occurring** = weak signal (e.g., "the" + "project")

**Example Calculation:**

```
Corpus: 1000 chunks

Entity A: "Dr. Jane Smith" appears in 5 chunks
Entity B: "Quantum Project" appears in 3 chunks
Entity C: "the" appears in 900 chunks

IDF(A) = log(1000 / 5) = 5.3
IDF(B) = log(1000 / 3) = 5.8
IDF(C) = log(1000 / 900) = 0.1

Co-occurrence in 2 chunks:
- (A, B): Weight = min(5.3, 5.8) × 2 = 10.6 (STRONG relationship)
- (A, C): Weight = min(5.3, 0.1) × 2 = 0.2 (WEAK relationship)
```

### Neo4j Storage

```cypher
// Create entity nodes
CREATE (e:Entity {id: 'dr-jane-smith', name: 'Dr. Jane Smith', type: 'PERSON'})

// Create relationships
MATCH (a:Entity {id: 'dr-jane-smith'})
MATCH (b:Entity {id: 'quantum-project'})
CREATE (a)-[:CO_OCCURS_WITH {weight: 10.6, count: 2}]->(b)
```

### Querying the Knowledge Graph

```cypher
// Find all entities related to Dr. Smith
MATCH (e:Entity {id: 'dr-jane-smith'})-[r:CO_OCCURS_WITH]-(related)
WHERE r.weight > 5.0
RETURN related.name, r.weight
ORDER BY r.weight DESC
LIMIT 10
```

---

## 7. TF-IDF for Noise Detection

### Term Frequency - Inverse Document Frequency

Measures importance of a word in a document relative to a corpus.

### Formula

```
TF-IDF(t, d, D) = TF(t, d) × IDF(t, D)

TF(t, d) = (count of term t in document d) / (total terms in d)

IDF(t, D) = log(N / df(t))
  where N = total documents
        df(t) = documents containing term t
```

### Example Calculation

**Corpus:**

```
Doc 1: "machine learning is great"
Doc 2: "deep learning is powerful"
Doc 3: "learning the the the the"
```

**Calculate TF-IDF for "learning" in Doc 3:**

```
TF("learning", Doc3) = 1 / 5 = 0.2

IDF("learning") = log(3 / 3) = log(1) = 0

TF-IDF("learning", Doc3) = 0.2 × 0 = 0
```

**Calculate TF-IDF for "the" in Doc 3:**

```
TF("the", Doc3) = 4 / 5 = 0.8

IDF("the") = log(3 / 1) = 1.1

TF-IDF("the", Doc3) = 0.8 × 1.1 = 0.88
```

### Application in Search-AI

**Noise Detection:**

- **Low TF-IDF chunks** = boilerplate/noise (headers, footers, disclaimers)
- **High TF-IDF chunks** = unique, informative content
- **Filter chunks below threshold** before embedding to save cost

**Implementation:**

```typescript
function calculateChunkTFIDF(chunk: string, corpus: string[]): number {
  const terms = chunk.toLowerCase().split(/\s+/);
  const termFrequencies = new Map<string, number>();

  // Calculate TF
  for (const term of terms) {
    termFrequencies.set(term, (termFrequencies.get(term) || 0) + 1);
  }

  let totalTFIDF = 0;
  for (const [term, freq] of termFrequencies) {
    const tf = freq / terms.length;
    const idf = Math.log(corpus.length / corpus.filter((doc) => doc.includes(term)).length);
    totalTFIDF += tf * idf;
  }

  return totalTFIDF / terms.length; // Average TF-IDF per term
}

// Filter low-quality chunks
const threshold = 0.1;
const qualityChunks = chunks.filter((chunk) => calculateChunkTFIDF(chunk, corpus) > threshold);
```

---

## 8. Progressive Summarization

### Concept

Generate summaries at multiple levels of abstraction to preserve context across chunks.

### Levels

1. **Chunk-level**: Summarize each chunk (150-200 tokens)
2. **Page-level**: Combine chunk summaries into page summary
3. **Document-level**: High-level overview of entire document

### Why It Matters

When a query requires multi-chunk context, the LLM can read **summaries instead of full chunks**, reducing token usage.

**Example:**

```
Original: 5 chunks × 2000 tokens = 10,000 tokens
With summaries: 5 summaries × 200 tokens = 1,000 tokens
Savings: 90% token reduction
```

### Implementation

```typescript
async function generateChunkSummary(chunk: string): Promise<string> {
  const response = await llm.generate({
    model: 'claude-3-haiku-20240307',
    prompt: `Summarize this text in 150-200 tokens, preserving key facts and entities:\n\n${chunk}`,
    maxTokens: 250,
  });

  return response.text;
}

async function generateDocumentSummary(pageSummaries: string[]): Promise<string> {
  const combinedSummaries = pageSummaries.join('\n\n');

  const response = await llm.generate({
    model: 'claude-3-haiku-20240307',
    prompt: `Summarize these page summaries into a high-level document overview (max 500 tokens):\n\n${combinedSummaries}`,
    maxTokens: 600,
  });

  return response.text;
}
```

### Hierarchical Retrieval

Use summaries for **two-stage retrieval**:

1. **Stage 1**: Retrieve top-20 chunk summaries (fast, low tokens)
2. **Stage 2**: Retrieve full chunks for top-5 summaries (precise, high tokens)

---

## 9. Question Synthesis

### Concept

For each chunk, generate 3-5 questions that the chunk can answer.

### Types of Questions

- **Factual**: "What is X?", "Who did Y?"
- **Conceptual**: "How does X work?"
- **Procedural**: "How do you do X?"
- **Analytical**: "Why did X happen?"

### Benefits

- **Query-question matching** can supplement vector similarity
- **Helps retrieve chunks** when query semantics differ from chunk text
- **Improves retrieval** for specific question-style queries

### Implementation

```typescript
async function synthesizeQuestions(chunk: string): Promise<string[]> {
  const response = await llm.generate({
    model: 'claude-3-haiku-20240307',
    prompt: `Generate 3-5 questions that this text can answer. Mix factual, conceptual, and procedural questions:\n\n${chunk}`,
    maxTokens: 300,
  });

  // Parse response into array of questions
  return response.text.split('\n').filter((q) => q.trim().endsWith('?'));
}
```

### Retrieval Strategy

**Two-part query:**

1. **Embed query** → retrieve chunks with similar embeddings
2. **Match query against synthesized questions** → retrieve chunks with matching questions

**Combine results** with RRF fusion for final ranking.

---

## Hands-On Exercises

> **Note:** Time estimates assume familiarity with the technology stack. First-time setup and debugging may add 50-100% to these estimates. Don't be discouraged if exercises take longer than estimated—learning takes time!

### Exercise 1: Build a Simple Vector Search Engine

**Objective:** Implement vector search from scratch to understand the fundamentals.

**Steps:**

1. Create a small corpus (10-20 documents)
2. Generate embeddings using BGE-M3 API
3. Store embeddings in memory (TypeScript Map)
4. Implement cosine similarity function
5. Build query function that returns top-k results
6. Compare with OpenSearch k-NN results

**Expected Time:** 4 hours

**Skills Gained:**

- Vector operations
- Similarity metrics
- API integration

**Starter Code:**

```typescript
// Cosine similarity function
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

// Simple vector search
function search(query: number[], corpus: Map<string, number[]>, k: number): string[] {
  const results = Array.from(corpus.entries())
    .map(([id, vector]) => ({
      id,
      score: cosineSimilarity(query, vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return results.map((r) => r.id);
}
```

---

### Exercise 2: Implement BM25 Scoring

**Objective:** Build a simple BM25 ranking system to understand full-text search.

**Steps:**

1. Parse corpus into term-document matrix
2. Calculate IDF for each term
3. Implement BM25 scoring function
4. Build inverted index
5. Query and rank documents
6. Compare with OpenSearch BM25 results

**Expected Time:** 6 hours

**Skills Gained:**

- Information retrieval fundamentals
- Inverted indexes
- Statistical ranking

**Starter Code:**

```typescript
function calculateBM25(
  term: string,
  doc: string[],
  corpus: string[][],
  k1 = 1.2,
  b = 0.75,
): number {
  const tf = doc.filter((t) => t === term).length;
  const docLength = doc.length;
  const avgDocLength = corpus.reduce((sum, d) => sum + d.length, 0) / corpus.length;
  const df = corpus.filter((d) => d.includes(term)).length;
  const idf = Math.log((corpus.length - df + 0.5) / (df + 0.5));

  return (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * docLength) / avgDocLength));
}
```

---

### Exercise 3: Build a Chunking Strategy

**Objective:** Implement a custom chunking strategy.

**Steps:**

1. Choose a strategy (e.g., sentence-based with token limit)
2. Parse documents, split into chunks
3. Ensure chunks don't exceed token limit
4. Add overlap between chunks
5. Generate metadata for each chunk
6. Integrate into Search-AI pipeline

**Expected Time:** 8 hours

**Skills Gained:**

- Text processing
- Token counting
- Pipeline integration

---

### Exercise 4: Entity Extraction Pipeline

**Objective:** Build a simple entity extraction system.

**Steps:**

1. Use Compromise NLP to extract entities
2. Deduplicate entities
3. Calculate entity frequencies
4. Build co-occurrence matrix
5. Store in Neo4j
6. Query relationships

**Expected Time:** 10 hours

**Skills Gained:**

- NLP processing
- Graph databases
- Entity linking

---

### Exercise 5: Build a Reranker

**Objective:** Implement a simple reranking system.

**Steps:**

1. Retrieve top-20 results from vector search
2. Use cross-encoder (Cohere) to rescore
3. Reorder results by new scores
4. Compare precision@5 before/after reranking
5. Measure latency impact

**Expected Time:** 6 hours

**Skills Gained:**

- Reranking techniques
- API integration
- Performance analysis

---

## Further Reading

### Academic Papers

- **RAG**: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (Lewis et al., 2020)
- **Dense Retrieval**: "Dense Passage Retrieval for Open-Domain Question Answering" (Karpukhin et al., 2020)
- **HNSW**: "Efficient and Robust Approximate Nearest Neighbor Search" (Malkov & Yashunin, 2018)
- **BM25**: "The Probabilistic Relevance Framework: BM25 and Beyond" (Robertson & Zaragoza, 2009)

### Books

- **"Introduction to Information Retrieval"** by Manning, Raghavan, Schütze
- **"Neural Network Methods for Natural Language Processing"** by Yoav Goldberg
- **"Speech and Language Processing"** by Jurafsky & Martin

### Online Courses

- **Stanford CS224N**: Natural Language Processing with Deep Learning
- **Fast.ai**: Practical Deep Learning for Coders
- **Coursera**: Machine Learning Specialization (Andrew Ng)

---

## Glossary

**BGE-M3**: BAAI General Embedding Multilingual Model - our default embedding model

**BM25**: Best Match 25 - probabilistic ranking function for full-text search

**Chunk**: A segment of a document, typically 512-2048 tokens

**Co-occurrence**: When two entities appear together in the same chunk

**Cosine Similarity**: Measures angle between vectors (-1 to 1)

**HNSW**: Hierarchical Navigable Small World - approximate nearest neighbor algorithm

**IDF**: Inverse Document Frequency - measures term rarity

**k-NN**: k-Nearest Neighbors - vector similarity search

**RAG**: Retrieval-Augmented Generation

**RRF**: Reciprocal Rank Fusion - method for combining ranked lists

**TF-IDF**: Term Frequency - Inverse Document Frequency

---

**Related Documents:**

- [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) - Main onboarding guide
- [INFRASTRUCTURE-GUIDE.md](./INFRASTRUCTURE-GUIDE.md) - Production infrastructure
- [DATABASE-SCHEMA.md](./design/DATABASE-SCHEMA.md) - MongoDB models and indexes
- [SERVICES-INVENTORY.md](./design/SERVICES-INVENTORY.md) - Complete worker catalog
