# SearchAI Chunking System - Complete Analysis

> **Date**: 2026-02-23
> **Purpose**: Comprehensive documentation of how chunking works in SearchAI
> **Status**: Current Implementation + Research Findings + Enhancement Recommendations

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Current Implementation](#2-current-implementation)
3. [Data Models & Storage](#3-data-models--storage)
4. [Pipeline Integration](#4-pipeline-integration)
5. [Chunking Strategies](#5-chunking-strategies)
6. [Research Findings](#6-research-findings)
7. [Advanced Techniques](#7-advanced-techniques)
8. [Enhancement Opportunities](#8-enhancement-opportunities)
9. [Testing & Validation](#9-testing--validation)

---

## 1. System Overview

### Architecture Context

SearchAI is a programmable knowledge management and RAG platform with a multi-stage ingestion pipeline:

```
┌─────────────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. INGESTION WORKER                                            │
│     - Discovers documents from sources                          │
│     - Creates SearchDocument records                            │
│     - Enqueues extraction jobs                                  │
│                                                                  │
│  2. EXTRACTION WORKER                                           │
│     - Extracts plain text from raw content                      │
│     - PDF → text, HTML → markdown, DOCX → text                 │
│     - Updates document.extractedText                            │
│                                                                  │
│  3. CANONICAL MAPPER WORKER ⭐ (CHUNKING HAPPENS HERE)          │
│     - Splits extractedText into chunks using ChunkingService   │
│     - Creates SearchChunk records (MongoDB)                     │
│     - Applies canonical field mappings                          │
│     - Enqueues enrichment jobs                                  │
│                                                                  │
│  4. ENRICHMENT WORKER                                           │
│     - Enriches chunks with metadata                             │
│     - Entity extraction (stub)                                  │
│     - Language detection (stub)                                 │
│     - Enqueues embedding jobs                                   │
│                                                                  │
│  5. EMBEDDING WORKER                                            │
│     - Generates vector embeddings for chunks                    │
│     - Upserts to vector store (Qdrant)                         │
│     - Marks chunks as indexed                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Point**: Chunking is NOT a standalone service—it's embedded in the canonical-mapper-worker as part of the pipeline.

---

## 2. Current Implementation

### 2.1 Core Service: ChunkingService

**Location**: `apps/search-ai/src/services/chunking/index.ts`

**Interface**:

```typescript
export class ChunkingService {
  chunk(text: string, options: ChunkOptions): TextChunk[];
}

export interface ChunkOptions {
  strategy: 'fixed' | 'semantic' | 'sliding_window';
  chunkSize: number; // Target chunk size in tokens
  chunkOverlap: number; // Overlap between chunks in tokens
  respectBoundaries?: boolean; // For semantic: respect paragraph boundaries
}

export interface TextChunk {
  content: string; // Chunk content
  index: number; // Chunk index within document
  tokenCount: number; // Approximate token count
  charStart: number; // Character offset start
  charEnd: number; // Character offset end
}
```

**Token Estimation**: Uses a **4 characters per token** heuristic (reasonable for English text with most tokenizers: GPT, Claude, etc.)

---

### 2.2 Implemented Strategies

#### Strategy 1: Fixed-Size Chunking

**Algorithm**:

1. Calculate window size: `chunkSize * 4` characters
2. Calculate overlap size: `chunkOverlap * 4` characters
3. Calculate step size: `windowSize - overlapSize`
4. Slide window across text with step size
5. Handle trailing chunks (avoid tiny chunks entirely within overlap)

**Code**:

```typescript
private chunkFixed(text: string, options: ChunkOptions): TextChunk[] {
  const windowSize = options.chunkSize * CHARS_PER_TOKEN; // 4 chars/token
  const overlapSize = options.chunkOverlap * CHARS_PER_TOKEN;
  const stepSize = Math.max(windowSize - overlapSize, 1);

  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const charStart = offset;
    const charEnd = Math.min(offset + windowSize, text.length);
    const content = text.slice(charStart, charEnd);

    chunks.push({
      content,
      index,
      tokenCount: this.estimateTokens(content),
      charStart,
      charEnd,
    });

    offset += stepSize;
    index++;

    // Avoid tiny trailing chunks
    if (offset < text.length && text.length - offset < overlapSize) {
      const remaining = text.slice(offset);
      chunks.push({
        content: remaining,
        index,
        tokenCount: this.estimateTokens(remaining),
        charStart: offset,
        charEnd: text.length,
      });
      break;
    }
  }

  return chunks;
}
```

**Example**:

- Input: 200-character text
- chunkSize: 10 tokens = 40 chars
- chunkOverlap: 2 tokens = 8 chars
- stepSize: 40 - 8 = 32 chars
- Result: Chunks at offsets 0-40, 32-72, 64-104, 96-136, 128-168, 160-200

**Pros**:

- ✅ Predictable chunk sizes
- ✅ Simple implementation
- ✅ Fast processing

**Cons**:

- ❌ Breaks sentences mid-word
- ❌ Fragments context arbitrarily
- ❌ Overlaps create redundancy

---

#### Strategy 2: Semantic Chunking

**Algorithm**:

1. Split text on paragraph boundaries (`\n\n+` by default)
2. Merge small paragraphs until approaching `chunkSize`
3. Split large paragraphs at sentence boundaries
4. Fall back to fixed-size splitting for paragraphs without sentence boundaries

**Code Flow**:

```typescript
private chunkSemantic(text: string, options: ChunkOptions): TextChunk[] {
  const targetChars = options.chunkSize * CHARS_PER_TOKEN;
  const respectBoundaries = options.respectBoundaries !== false; // default true

  // Split into paragraphs
  const paragraphs = respectBoundaries
    ? text.split(/\n\n+/)  // Double newline
    : text.split(/\n+/);   // Single newline

  const chunks: TextChunk[] = [];
  let currentContent = '';
  let currentCharStart = 0;
  let charCursor = 0;
  let index = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const candidateContent = currentContent.length > 0
      ? currentContent + '\n\n' + paragraph
      : paragraph;

    if (candidateContent.length <= targetChars) {
      // Merge into current chunk
      currentContent = candidateContent;
    } else {
      // Flush current chunk if it has content
      if (currentContent.length > 0) {
        chunks.push({
          content: currentContent,
          index,
          tokenCount: this.estimateTokens(currentContent),
          charStart: currentCharStart,
          charEnd: currentCharStart + currentContent.length,
        });
        index++;
      }

      // Handle current paragraph
      if (paragraph.length <= targetChars) {
        currentContent = paragraph;
        currentCharStart = charCursor;
      } else {
        // Large paragraph — split at sentences
        const subChunks = this.splitLargeParagraph(paragraph, targetChars, charCursor);
        for (const sub of subChunks) {
          chunks.push({ ...sub, index });
          index++;
        }
        currentContent = '';
      }
    }

    charCursor += paragraph.length;
  }

  // Flush remaining
  if (currentContent.length > 0) {
    chunks.push({
      content: currentContent,
      index,
      tokenCount: this.estimateTokens(currentContent),
      charStart: currentCharStart,
      charEnd: currentCharStart + currentContent.length,
    });
  }

  return chunks;
}
```

**Sentence Splitting** (for large paragraphs):

```typescript
private splitLargeParagraph(
  paragraph: string,
  targetChars: number,
  baseOffset: number,
): Omit<TextChunk, 'index'>[] {
  // Try sentence boundary regex
  const sentences = paragraph.match(/[^.!?]+[.!?]+\s*/g);

  if (sentences && sentences.length > 1) {
    const results: Omit<TextChunk, 'index'>[] = [];
    let current = '';
    let currentStart = baseOffset;
    let cursor = 0;

    for (const sentence of sentences) {
      if (current.length + sentence.length > targetChars && current.length > 0) {
        results.push({
          content: current.trimEnd(),
          tokenCount: this.estimateTokens(current),
          charStart: currentStart,
          charEnd: currentStart + current.trimEnd().length,
        });
        currentStart = baseOffset + cursor;
        current = sentence;
      } else {
        current += sentence;
      }
      cursor += sentence.length;
    }

    if (current.length > 0) {
      results.push({
        content: current.trimEnd(),
        tokenCount: this.estimateTokens(current),
        charStart: currentStart,
        charEnd: currentStart + current.trimEnd().length,
      });
    }

    return results;
  }

  // No sentence boundaries — fall back to fixed-size
  // ... (same as fixed strategy)
}
```

**Pros**:

- ✅ Respects semantic boundaries (paragraphs, sentences)
- ✅ More coherent chunks
- ✅ Better for human readability

**Cons**:

- ❌ Variable chunk sizes (some very small, some large)
- ❌ More complex implementation
- ❌ Sentence detection can be fragile

---

#### Strategy 3: Sliding Window

**Implementation**:

```typescript
private chunkSlidingWindow(text: string, options: ChunkOptions): TextChunk[] {
  return this.chunkFixed(text, options); // Functionally identical to fixed
}
```

**Note**: Currently just an alias for fixed strategy. The semantic distinction is that sliding window emphasizes overlap for context continuity, while fixed emphasizes coverage.

---

### 2.3 Usage in Pipeline

**Location**: `apps/search-ai/src/workers/canonical-mapper-worker.ts`

```typescript
async function processCanonicalMapJob(job: Job<CanonicalMapJobData>): Promise<void> {
  const { indexId, documentId, tenantId } = job.data;

  // Load document and index
  const [document, index] = await Promise.all([
    SearchDocument.findOne({ _id: documentId, indexId }),
    SearchIndex.findById(indexId).lean(),
  ]);

  // Get chunking strategy from index config
  const chunkStrategy = index.chunkStrategy || {
    method: 'fixed',
    chunkSize: 1024,
    chunkOverlap: 128,
  };

  // Chunk the extracted text
  const chunkingService = new ChunkingService();
  const textChunks = chunkingService.chunk(document.extractedText, {
    strategy: chunkStrategy.method as 'fixed' | 'semantic' | 'sliding_window',
    chunkSize: chunkStrategy.chunkSize,
    chunkOverlap: chunkStrategy.chunkOverlap,
  });

  // Create SearchChunk records
  const chunkDocs = textChunks.map((chunk) => ({
    tenantId,
    indexId,
    documentId,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    chunkIndex: chunk.index,
    metadata: document.sourceMetadata ?? null,
    canonicalMetadata: applyCanonicalMapping(document.sourceMetadata),
    status: ChunkStatus.PENDING,
  }));

  const createdChunks = await SearchChunk.insertMany(chunkDocs);

  // Update document with chunk count
  await SearchDocument.findByIdAndUpdate(documentId, {
    chunkCount: createdChunks.length,
    status: DocumentStatus.ENRICHED,
  });

  // Enqueue enrichment job
  // ...
}
```

**Configuration Flow**:

1. Index created with `chunkStrategy` config (stored in MongoDB SearchIndex)
2. Canonical mapper worker reads config from index
3. ChunkingService splits text according to strategy
4. SearchChunk records created in MongoDB
5. Enrichment worker processes chunks
6. Embedding worker generates embeddings

---

## 3. Data Models & Storage

### 3.1 SearchIndex (MongoDB)

**Location**: `packages/database/src/models/search-index.model.ts`

```typescript
export interface ISearchIndex {
  _id: string;
  tenantId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;

  // Chunking configuration (stored at index level)
  chunkStrategy: {
    method: 'fixed' | 'semantic' | 'sliding_window';
    chunkSize: number; // tokens
    chunkOverlap: number; // tokens
    separator?: string; // for fixed strategy
  };

  // Embedding configuration
  embeddingModel: string;
  embeddingDimensions: number;

  // Vector store configuration
  vectorStore: {
    provider: 'qdrant' | 'pinecone' | 'pgvector';
    collectionName: string;
    connectionConfig?: Record<string, unknown>;
  };

  // Search configuration
  searchDefaults: {
    topK: number;
    similarityThreshold: number;
    includeMetadata: boolean;
    includeContent: boolean;
    reranker?: RerankerConfig;
  };

  status: IndexStatus;
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  lastIndexedAt: Date | null;
  indexError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

**Key Point**: Chunking configuration is per-index, not per-document. All documents in an index use the same chunking strategy.

---

### 3.2 SearchDocument (MongoDB)

**Location**: `packages/database/src/models/search-document.model.ts`

```typescript
export interface ISearchDocument {
  _id: string;
  tenantId: string;
  indexId: string;
  sourceId: string;

  // Content identification
  contentHash: string; // SHA-256 for dedup
  originalReference: string | null; // filename or URL
  contentType: string | null; // MIME type
  contentSizeBytes: number;

  // Extracted content (input to chunking)
  extractedText: string | null; // ⭐ This gets chunked

  // Enrichment results
  language: string | null;
  entities: Array<{ type: string; value: string; confidence: number }>;
  summary: string | null;

  // Metadata
  sourceMetadata: any | null; // Raw metadata from connector

  // Processing status
  status: DocumentStatus; // pending, extracting, extracted, enriched, embedding, indexed, error
  processingError: string | null;
  chunkCount: number; // Number of chunks generated

  createdAt: Date;
  updatedAt: Date;
}
```

**Document Lifecycle**:

```
pending → extracting → extracted → enriched → embedding → indexed
                ↓                      ↓           ↓
        extractedText set        chunks created  embeddings generated
```

---

### 3.3 SearchChunk (MongoDB)

**Location**: `packages/database/src/models/search-chunk.model.ts`

```typescript
export interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;

  // Chunk content
  content: string; // Actual chunk text ⭐
  tokenCount: number; // Estimated token count
  chunkIndex: number; // Position within document (0, 1, 2, ...)

  // Vector storage
  vectorId: string | null; // ID in external vector store (Qdrant)

  // Metadata
  metadata: any | null; // Raw source metadata (copied from document)
  canonicalMetadata: Record<string, unknown> | null; // Transformed metadata

  // Status
  status: string; // pending, indexed, error

  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes**:

```typescript
SearchChunkSchema.index({ indexId: 1, documentId: 1, chunkIndex: 1 });
SearchChunkSchema.index({ indexId: 1, status: 1 });
SearchChunkSchema.index({ vectorId: 1 }, { sparse: true });
SearchChunkSchema.index({ tenantId: 1, indexId: 1 });
```

**Key Points**:

- Each chunk is a separate MongoDB document
- `chunkIndex` preserves document order
- `vectorId` links to external vector store (Qdrant)
- `metadata` and `canonicalMetadata` enable filtering/routing

---

### 3.4 Storage Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ MongoDB (Primary Store)                                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│ SearchIndex                                                       │
│   _id: "idx_123"                                                 │
│   chunkStrategy: { method: "fixed", chunkSize: 1024, ... }      │
│                                                                   │
│ SearchDocument                                                    │
│   _id: "doc_456"                                                 │
│   indexId: "idx_123"                                             │
│   extractedText: "Large document text..."                       │
│   chunkCount: 50                                                 │
│                                                                   │
│ SearchChunk (50 documents for doc_456)                           │
│   _id: "chunk_001", documentId: "doc_456", chunkIndex: 0        │
│   content: "First chunk text...", tokenCount: 1024              │
│   vectorId: "chunk_001"                                          │
│                                                                   │
│   _id: "chunk_002", documentId: "doc_456", chunkIndex: 1        │
│   content: "Second chunk text...", tokenCount: 1024             │
│   vectorId: "chunk_002"                                          │
│   ...                                                            │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
                           ↓ (vectorId references)
┌──────────────────────────────────────────────────────────────────┐
│ Qdrant (Vector Store)                                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│ Collection: "index_idx_123"                                      │
│                                                                   │
│ Point ID: "chunk_001"                                            │
│   vector: [0.123, -0.456, 0.789, ...]  (1536 dims)             │
│   payload: {                                                     │
│     indexId: "idx_123",                                          │
│     documentId: "doc_456",                                       │
│     chunkIndex: 0,                                               │
│     tenantId: "tenant_1",                                        │
│     ...canonicalMetadata                                         │
│   }                                                              │
│                                                                   │
│ Point ID: "chunk_002"                                            │
│   vector: [0.321, -0.654, 0.987, ...]                          │
│   payload: { ... }                                               │
│   ...                                                            │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Why Two Stores?**

- **MongoDB**: Durable storage, full content, metadata, status tracking
- **Qdrant**: Fast vector similarity search, optimized for retrieval
- **Linkage**: `SearchChunk.vectorId` = Qdrant point ID

---

## 4. Pipeline Integration

### 4.1 Complete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Document Upload / Connector Sync                             │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. INGESTION WORKER (apps/search-ai/src/workers/ingestion-     │
│    worker.ts)                                                    │
│                                                                  │
│    - Reads source config, fetches documents                     │
│    - Creates SearchDocument with status: 'pending'              │
│    - Enqueues job → QUEUE_EXTRACTION                            │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. EXTRACTION WORKER (apps/search-ai/src/workers/extraction-   │
│    worker.ts)                                                    │
│                                                                  │
│    - Loads SearchDocument                                       │
│    - Extracts plain text (PDF→text, HTML→markdown, etc.)       │
│    - Updates document.extractedText                             │
│    - Updates status: 'extracted'                                │
│    - Enqueues job → QUEUE_CANONICAL_MAP                         │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. CANONICAL MAPPER WORKER ⭐ CHUNKING HAPPENS HERE             │
│    (apps/search-ai/src/workers/canonical-mapper-worker.ts)     │
│                                                                  │
│    a) Load SearchDocument + SearchIndex                         │
│    b) Read index.chunkStrategy config                           │
│    c) Instantiate ChunkingService                               │
│    d) Call chunkingService.chunk(document.extractedText, opts)  │
│    e) Create SearchChunk records in MongoDB                     │
│    f) Update document.chunkCount                                │
│    g) Update status: 'enriched' (ready for enrichment)          │
│    h) Enqueue job → QUEUE_ENRICHMENT                            │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. ENRICHMENT WORKER (apps/search-ai/src/workers/enrichment-   │
│    worker.ts)                                                    │
│                                                                  │
│    - Loads SearchChunk records for document                     │
│    - Enriches metadata (currently stubbed):                     │
│      • Entity extraction (placeholder)                          │
│      • Language detection (placeholder)                         │
│      • Document-level summary (placeholder)                     │
│    - Updates chunk.canonicalMetadata                            │
│    - Updates status: 'enriched'                                 │
│    - Enqueues job → QUEUE_EMBEDDING                             │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. EMBEDDING WORKER (apps/search-ai/src/workers/embedding-     │
│    worker.ts)                                                    │
│                                                                  │
│    - Loads SearchChunk records for document                     │
│    - Generates embeddings via EmbeddingProvider (OpenAI, etc.)  │
│    - Upserts vectors to Qdrant with payload:                    │
│      {                                                           │
│        indexId, documentId, chunkIndex, tenantId,               │
│        ...canonicalMetadata                                      │
│      }                                                           │
│    - Updates chunk.vectorId, chunk.status: 'indexed'            │
│    - Updates document.status: 'indexed'                         │
└─────────────────────────────────────────────────────────────────┘
```

**Key Insight**: Chunking is tightly coupled to the canonical mapper stage. It cannot be easily extracted or replaced without refactoring the worker.

---

### 4.2 Queue System (BullMQ)

**Queues**:

```typescript
QUEUE_INGESTION = 'ingestion';
QUEUE_EXTRACTION = 'extraction';
QUEUE_CANONICAL_MAP = 'canonical-map'; // ⭐ Chunking happens here
QUEUE_ENRICHMENT = 'enrichment';
QUEUE_EMBEDDING = 'embedding';
```

**Job Data Types**:

```typescript
interface CanonicalMapJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

// Job processing in canonical-mapper-worker:
async function processCanonicalMapJob(job: Job<CanonicalMapJobData>): Promise<void> {
  // 1. Load document
  // 2. Load index config
  // 3. Chunk text using ChunkingService
  // 4. Create SearchChunk records
  // 5. Enqueue enrichment job
}
```

**Concurrency**:

```typescript
export default function createCanonicalMapperWorker(concurrency = 5): Worker<CanonicalMapJobData> {
  const worker = new Worker<CanonicalMapJobData>(
    QUEUE_CANONICAL_MAP,
    processCanonicalMapJob,
    createWorkerOptions(concurrency),
  );
  // ...
}
```

**Error Handling**:

- Retries: 3 attempts with exponential backoff
- On failure: document.status → 'error', document.processingError set
- Chunks are deleted on re-processing (idempotency)

---

## 5. Chunking Strategies (Deep Dive)

### 5.1 Fixed Strategy Implementation

**Algorithm Details**:

```
Input: text = "Lorem ipsum dolor sit amet..."  (200 chars)
Options:
  chunkSize: 10 tokens
  chunkOverlap: 2 tokens

Step 1: Calculate sizes
  CHARS_PER_TOKEN = 4
  windowSize = 10 * 4 = 40 chars
  overlapSize = 2 * 4 = 8 chars
  stepSize = 40 - 8 = 32 chars

Step 2: Generate chunks
  Chunk 0: text[0:40]    (40 chars, offset 0)
  Chunk 1: text[32:72]   (40 chars, offset 32)
  Chunk 2: text[64:104]  (40 chars, offset 64)
  Chunk 3: text[96:136]  (40 chars, offset 96)
  Chunk 4: text[128:168] (40 chars, offset 128)
  Chunk 5: text[160:200] (40 chars, offset 160)

Result: 6 chunks with 8-char overlap between consecutive chunks
```

**Edge Cases**:

1. **Text shorter than chunk size**: Returns single chunk
2. **chunkOverlap >= chunkSize**: stepSize = 1 (minimal step)
3. **Trailing chunk**: If remaining < overlapSize, add as final chunk

**Performance**:

- Time: O(n) where n = text length
- Space: O(c) where c = number of chunks
- Fast: No regex, no parsing, just string slicing

---

### 5.2 Semantic Strategy Implementation

**Algorithm Details**:

```
Input: text = "Para 1.\n\nPara 2.\n\nPara 3."
Options:
  chunkSize: 100 tokens  (400 chars)
  respectBoundaries: true

Step 1: Split on paragraph boundaries
  paragraphs = ["Para 1.", "Para 2.", "Para 3."]

Step 2: Merge paragraphs until target reached
  currentContent = ""

  Add "Para 1.":
    candidateContent = "Para 1."  (7 chars < 400)
    ✓ Merge

  Add "Para 2.":
    candidateContent = "Para 1.\n\nPara 2."  (17 chars < 400)
    ✓ Merge

  Add "Para 3.":
    candidateContent = "Para 1.\n\nPara 2.\n\nPara 3."  (27 chars < 400)
    ✓ Merge

  Result: 1 chunk with all 3 paragraphs

Step 3: If paragraph too large, split at sentences
  Paragraph = "Sentence 1. Sentence 2. Sentence 3. ..."  (600 chars > 400)

  Detect sentences: /[^.!?]+[.!?]+\s*/g
  sentences = ["Sentence 1. ", "Sentence 2. ", ...]

  Merge sentences until target:
    Chunk 0: "Sentence 1. Sentence 2. Sentence 3."  (380 chars)
    Chunk 1: "Sentence 4. Sentence 5. Sentence 6."  (390 chars)
    ...

Step 4: If no sentence boundaries, fall back to fixed
  Paragraph = "xxxxxxxxxxxx..." (no punctuation)
  → Use fixed-size splitting
```

**Edge Cases**:

1. **Single long paragraph**: Splits at sentence boundaries
2. **No sentence boundaries**: Falls back to fixed-size
3. **respectBoundaries=false**: Uses single newline as boundary
4. **Empty paragraphs**: Skipped

**Performance**:

- Time: O(n + p) where p = number of paragraphs
- Space: O(c) where c = number of chunks
- Slower than fixed due to regex and paragraph tracking

---

### 5.3 Comparison Table

| Feature                | Fixed                | Semantic              | Sliding Window        |
| ---------------------- | -------------------- | --------------------- | --------------------- |
| **Chunk Size**         | Exact (±1 char)      | Variable              | Exact (±1 char)       |
| **Overlap**            | Configurable         | No overlap            | Configurable          |
| **Boundary Respect**   | None                 | Paragraphs/sentences  | None                  |
| **Performance**        | Fast (O(n))          | Medium (O(n + p))     | Fast (O(n))           |
| **Coherence**          | Low                  | High                  | Low                   |
| **Context Continuity** | Medium (via overlap) | High (semantic units) | High (via overlap)    |
| **Predictability**     | High                 | Low                   | High                  |
| **Best For**           | Uniform processing   | Human-readable chunks | Context-heavy queries |

---

## 6. Research Findings

### 6.1 Critical Contradictions to Industry Standards

#### Finding 1: Zero Overlap May Outperform

**Source**: ArXiv 2601.14123 (Jan 2025)

**Claim**: Sentence-aligned chunks with **zero overlap** outperform 10-20% overlap

**Industry Standard**:

- 512 tokens per chunk
- 10-20% overlap (50-100 tokens)
- Rationale: Context continuity across chunks

**Research Finding**:

- 0% overlap performs better
- Overlap introduces redundancy
- Confuses retrieval models (duplicate information)

**Impact**:

- ✅ Reduces storage by ~10%
- ✅ Simpler implementation
- ⚠️ Requires validation on our data

---

#### Finding 2: Larger Chunks (2,000 Tokens) May Be Optimal

**Sources**: Multiple 2024-2025 studies

**Claim**: 2,000-2,500 tokens optimal for complex reasoning

**Industry Standard**:

- 512 tokens per chunk
- Rationale: Fits older LLM context windows (GPT-3: 4k)

**Research Finding**:

- Modern LLMs have 200k+ context windows
- Larger chunks provide richer context
- Context cliff at 2,500 tokens (performance drops)

**Trade-offs**:

| Chunk Size   | Best For                    | Limitation                         |
| ------------ | --------------------------- | ---------------------------------- |
| 512 tokens   | Simple factoid queries      | Insufficient context for reasoning |
| 2,000 tokens | Complex multi-hop reasoning | Slower search, less precise        |

**Impact**: ⚠️ Contradicts common 512-token standard

---

#### Finding 3: Advanced Techniques Show 20-67% Improvement

**Techniques**:

1. **Contextual Retrieval** (Anthropic)
   - Prepend chunk-specific context before embedding
   - Performance: -35% to -67% failure rate
   - Cost: $1.02 per 1M tokens (with prompt caching)

2. **Late Chunking** (Jina AI)
   - Embed full document first, then chunk embeddings
   - Performance: +1.9% to +29.98% on BeIR
   - Best for: Documents >1,000 tokens

3. **RAPTOR** (Hierarchical Retrieval)
   - Build recursive tree structures via clustering
   - Performance: +20% accuracy on multi-hop queries
   - Cost: $0.01-0.15 per document (one-time)

---

### 6.2 ATLAS-KG Research (Internal)

**Full Design**: See `docs/searchai/chunking/ATLAS_KG_CHUNKING_ARCHITECTURE.md`

**Six Components**:

```
1. Noise Detection & Elimination
   - Global TF-IDF (cross-document boilerplate)
   - Local TF-IDF (per-document repeated terms)
   - LLM concept extraction
   - Filters 40-60% of indexing noise

2. Adaptive Tree Construction
   - Sentence-aligned chunking (2000 tokens, 0 overlap)
   - Semantic splitting (cosine similarity >0.7)
   - Constrained balancing (max_depth=4, max_children=10)
   - Hierarchical structure with parent-child relationships

3. Cross-Document Knowledge Graph
   - Entity extraction (spaCy NER + optional LLM)
   - Entity co-occurrence (weighted by IDF)
   - Explicit references ("See Contract MSA-2024-001")
   - Neo4j graph connecting related chunks

4. Multi-Modal Enrichment
   - Image descriptions (customer vision models)
   - Table summarization (LLM)
   - Chart analysis (vision models)
   - Text descriptions of visual content

5. Question Synthesis
   - LLM generates 3-5 answerable questions per chunk
   - Pre-computed questions guide retrieval
   - Examples: "What was Q3 revenue?", "Which regions grew?"

6. Scope-Aware Retrieval
   - Classify chunk: chunk-level, section-level, document-level
   - Determines retrieval strategy (parent fetch?)
   - Reduces over-retrieval (3-5 chunks → 1-2 chunks)
```

**Cost Analysis** (per chunk):

```
Component                    | Cost/Chunk | Frequency | Weighted
-----------------------------|------------|-----------|----------
Noise Detection (TF-IDF)     | $0         | 100%      | $0
Concept Extraction (LLM)     | $0.00018   | 100%      | $0.00018
Adaptive Tree (Summary)      | $0.00019   | 100%      | $0.00019
Entity Extraction (NER)      | $0.00002   | 100%      | $0.00002
Image Description (Vision)   | $0.00040   | 20%       | $0.00008
Table Summary (LLM)          | $0.00002   | 30%       | $0.00006
Question Synthesis (LLM)     | $0.00017   | 100%      | $0.00017
Scope Classification (LLM)   | $0.00001   | 100%      | $0.00001
Embedding (OpenAI 3-large)   | $0.00026   | 100%      | $0.00026
-----------------------------|------------|-----------|----------
TOTAL PER CHUNK              |            |           | $0.00101

Per 1M documents (50 chunks avg): $50,500
With prompt caching: ~$40,000
```

---

### 6.3 RAPTOR Research (Internal)

**Full Analysis**: See `docs/searchai/chunking/RAPTOR_RESEARCH.md`

**Algorithm**:

1. Segment documents into chunks (100 tokens, sentence boundaries)
2. Embed chunks using SBERT
3. Cluster embeddings using Gaussian Mixture Models (GMMs)
4. Summarize each cluster using LLM (GPT-3.5-turbo)
5. Recursively repeat on summaries until convergence (3 layers)
6. Store all nodes (original + summaries) in vector database

**Performance**:

- +20% accuracy on QuALITY benchmark (GPT-4)
- +2.7pp on QASPER (Question Answering on Scientific Papers)
- Best for: Documents >10k tokens, multi-hop queries

**Costs**:

- Build: $0.01-0.15 per document (one-time)
- Storage: +25% overhead (all tree nodes)
- Query: <200ms additional latency

**When to Use**:

- ✅ Long documents (>10k tokens)
- ✅ Complex multi-hop queries
- ✅ Infrequent document updates
- ❌ Real-time ingestion (<500ms)
- ❌ Short documents (<5k tokens)

---

### 6.4 Late Chunking Research (Internal)

**Full Analysis**: See `docs/searchai/chunking/LATE_CHUNKING_RESEARCH.md`

**Core Concept**:

```
Traditional: Document → Split → Embed each chunk
Late:        Document → Embed entire → Split embeddings
```

**Algorithm**:

1. Pass full document through transformer (up to 8K tokens)
2. Generate contextualized token embeddings
3. Detect chunk boundaries (sentences, paragraphs)
4. Apply mean pooling to token subsequences
5. Result: Chunk embeddings conditioned on full document

**Performance** (BeIR benchmark):

| Dataset   | Avg Doc Length | Traditional | Late Chunking | Improvement |
| --------- | -------------- | ----------- | ------------- | ----------- |
| SciFact   | 1,498 chars    | 64.20%      | 66.10%        | +1.90%      |
| TRECCOVID | 1,117 chars    | 63.36%      | 64.70%        | +1.34%      |
| NFCorpus  | 1,590 chars    | 23.46%      | 29.98%        | +6.52%      |
| Quora     | 62 chars       | 87.19%      | 87.19%        | 0%          |

**Key Pattern**: Performance correlates with document length

**When to Use**:

- ✅ Long documents (>1,000 tokens)
- ✅ Cross-chunk references (anaphora)
- ✅ Quality-critical applications
- ❌ Real-time ingestion (<500ms)
- ❌ Short content (<500 tokens)

---

## 7. Advanced Techniques

### 7.1 Contextual Retrieval (Anthropic)

**Reference**: https://www.anthropic.com/news/contextual-retrieval

**Algorithm**:

1. For each chunk, generate chunk-specific context
2. Prepend context to chunk before embedding
3. Store both original chunk and contextualized chunk

**Example**:

**Original Chunk**:

```
"The company's revenue grew by 20% in Q3."
```

**Context Generation** (LLM prompt):

```
Given the following document context and chunk, generate a concise
context (1-2 sentences) explaining what this chunk is about:

Document: [Full document or summary]
Chunk: "The company's revenue grew by 20% in Q3."

Context:
```

**LLM Response**:

```
"This refers to Acme Corp's financial performance in the third quarter
of 2024, showing revenue growth."
```

**Contextualized Chunk** (stored + embedded):

```
"This refers to Acme Corp's financial performance in the third quarter
of 2024, showing revenue growth. The company's revenue grew by 20% in Q3."
```

**Performance**:

- Failure rate: 5.7% → 1.9% (-67%)
- Cost: $1.02 per 1M tokens (with prompt caching)
- ROI: High (significant improvement, low cost)

**Implementation Complexity**: Medium

- Requires LLM integration
- Prompt caching for cost efficiency
- Storage overhead (contextualized chunks)

---

### 7.2 Late Chunking (Jina AI)

**Reference**: https://jina.ai/news/late-chunking-in-long-context-embedding-models

**Already covered in Section 6.4**

**Implementation Example**:

```typescript
import { AutoModel, AutoTokenizer } from '@xenova/transformers';

class LateChunkingService {
  private model: any;
  private tokenizer: any;

  async initialize() {
    this.tokenizer = await AutoTokenizer.from_pretrained('jinaai/jina-embeddings-v2-base-en');
    this.model = await AutoModel.from_pretrained('jinaai/jina-embeddings-v2-base-en');
  }

  async chunk(text: string): Promise<{ chunks: string[]; embeddings: number[][] }> {
    // 1. Tokenize full document
    const inputs = await this.tokenizer(text, { return_tensors: 'pt' });

    // 2. Get full document embeddings
    const outputs = await this.model(inputs);
    const tokenEmbeddings = outputs.last_hidden_state[0]; // [num_tokens, embed_dim]

    // 3. Detect sentence boundaries
    const sentences = this.detectSentences(text);
    const spanAnnotations = this.getSpanAnnotations(sentences, this.tokenizer);

    // 4. Pool embeddings for each chunk
    const chunkEmbeddings = spanAnnotations.map((span) => {
      const [start, end] = span;
      const chunkTokens = tokenEmbeddings.slice(start, end);
      return this.meanPool(chunkTokens); // Average across tokens
    });

    return { chunks: sentences, embeddings: chunkEmbeddings };
  }

  private meanPool(embeddings: number[][]): number[] {
    // Average across first dimension (tokens)
    const numTokens = embeddings.length;
    const embedDim = embeddings[0].length;
    const result = new Array(embedDim).fill(0);

    for (let i = 0; i < numTokens; i++) {
      for (let j = 0; j < embedDim; j++) {
        result[j] += embeddings[i][j];
      }
    }

    return result.map((val) => val / numTokens);
  }

  private detectSentences(text: string): string[] {
    // Simple sentence detection (can use more sophisticated tokenizers)
    return text.match(/[^.!?]+[.!?]+/g) || [text];
  }

  private getSpanAnnotations(sentences: string[], tokenizer: any): [number, number][] {
    // Map sentences to token spans
    const spans: [number, number][] = [];
    let offset = 0;

    for (const sentence of sentences) {
      const tokens = tokenizer.encode(sentence);
      spans.push([offset, offset + tokens.length]);
      offset += tokens.length;
    }

    return spans;
  }
}
```

---

### 7.3 RAPTOR (Hierarchical)

**Reference**: https://arxiv.org/abs/2401.18059

**Already covered in Section 6.3**

**High-Level Implementation**:

```typescript
class RAPTORChunker {
  async buildTree(document: string): Promise<TreeNode> {
    // 1. Initial chunking (100 tokens, sentence-aligned)
    const chunks = this.chunkByLength(document, 100);
    const embeddings = await this.embedChunks(chunks);

    // 2. Create leaf nodes
    const leafNodes = chunks.map((chunk, i) => ({
      content: chunk,
      embedding: embeddings[i],
      children: [],
      level: 0,
    }));

    // 3. Recursively build tree via clustering
    let currentLevel = leafNodes;
    let level = 1;

    while (currentLevel.length > 1) {
      // Cluster nodes using GMM
      const clusters = await this.clusterNodes(currentLevel);

      // Summarize each cluster
      const parentNodes = await Promise.all(
        clusters.map(async (cluster) => {
          const childContents = cluster.map((node) => node.content);
          const summary = await this.summarizeCluster(childContents);
          const embedding = await this.embedText(summary);

          return {
            content: summary,
            embedding,
            children: cluster,
            level,
          };
        }),
      );

      currentLevel = parentNodes;
      level++;
    }

    return currentLevel[0]; // Root node
  }

  private async clusterNodes(nodes: TreeNode[]): Promise<TreeNode[][]> {
    // Extract embeddings
    const embeddings = nodes.map((n) => n.embedding);

    // UMAP dimensionality reduction
    const reducedEmbeddings = this.umapReduce(embeddings);

    // GMM clustering
    const clusters = this.gmmCluster(reducedEmbeddings);

    // Group nodes by cluster
    const groupedNodes: TreeNode[][] = [];
    for (const cluster of clusters) {
      groupedNodes.push(cluster.map((idx) => nodes[idx]));
    }

    return groupedNodes;
  }

  private async summarizeCluster(contents: string[]): Promise<string> {
    const combined = contents.join('\n\n');
    const prompt = `Summarize the following content in 300-500 tokens:\n\n${combined}`;

    // Call LLM API (GPT-3.5-turbo)
    const summary = await this.callLLM(prompt);
    return summary;
  }
}
```

---

## 8. Enhancement Opportunities

### 8.1 Immediate Improvements (Low Effort)

#### 1. Add Sentence-Aligned Chunking

**Problem**: Current fixed/sliding_window break sentences mid-word

**Solution**: Add sentence boundary detection to fixed strategy

**Implementation**:

```typescript
private chunkFixedSentenceAligned(text: string, options: ChunkOptions): TextChunk[] {
  const targetChars = options.chunkSize * CHARS_PER_TOKEN;
  const sentences = this.detectSentences(text); // Use NLTK or regex

  const chunks: TextChunk[] = [];
  let currentContent = '';
  let currentStart = 0;
  let index = 0;

  for (const sentence of sentences) {
    if (currentContent.length + sentence.length > targetChars && currentContent.length > 0) {
      // Flush current chunk
      chunks.push({
        content: currentContent,
        index,
        tokenCount: this.estimateTokens(currentContent),
        charStart: currentStart,
        charEnd: currentStart + currentContent.length,
      });
      index++;
      currentContent = sentence;
      currentStart += currentContent.length;
    } else {
      currentContent += sentence;
    }
  }

  if (currentContent.length > 0) {
    chunks.push({
      content: currentContent,
      index,
      tokenCount: this.estimateTokens(currentContent),
      charStart: currentStart,
      charEnd: currentStart + currentContent.length,
    });
  }

  return chunks;
}
```

**Benefits**:

- ✅ More coherent chunks
- ✅ No mid-sentence breaks
- ✅ Minimal code change

**Effort**: 1-2 hours

---

#### 2. Make Token Estimation Accurate

**Problem**: 4 chars/token is rough heuristic

**Solution**: Use actual tokenizer (tiktoken, transformers)

**Implementation**:

```typescript
import { get_encoding } from 'tiktoken';

export class ChunkingService {
  private tokenizer = get_encoding('cl100k_base'); // GPT-3.5/4 tokenizer

  private estimateTokens(text: string): number {
    return this.tokenizer.encode(text).length; // Exact count
  }
}
```

**Benefits**:

- ✅ Accurate token counts
- ✅ Better chunk size control
- ✅ Respects model limits

**Effort**: 30 minutes

---

#### 3. Add Chunk Size Validation

**Problem**: No validation of chunk sizes against model limits

**Solution**: Validate at index creation time

**Implementation**:

```typescript
export function validateChunkStrategy(
  strategy: ChunkStrategy,
  embeddingModel: string,
): ValidationResult {
  const modelLimits: Record<string, number> = {
    'text-embedding-3-small': 8191,
    'text-embedding-3-large': 8191,
    'text-embedding-ada-002': 8191,
  };

  const maxTokens = modelLimits[embeddingModel];
  if (!maxTokens) {
    return { valid: false, error: `Unknown embedding model: ${embeddingModel}` };
  }

  if (strategy.chunkSize > maxTokens) {
    return {
      valid: false,
      error: `Chunk size ${strategy.chunkSize} exceeds model limit ${maxTokens}`,
    };
  }

  if (strategy.chunkOverlap >= strategy.chunkSize) {
    return {
      valid: false,
      error: `Chunk overlap must be less than chunk size`,
    };
  }

  return { valid: true };
}
```

**Benefits**:

- ✅ Prevent configuration errors
- ✅ Better user experience
- ✅ Clear error messages

**Effort**: 1 hour

---

### 8.2 Medium-Term Enhancements (Medium Effort)

#### 4. Implement Late Chunking

**Rationale**: 1.9-29.98% improvement for long documents

**Implementation Plan**:

1. Add `late_chunking` strategy to ChunkOptions
2. Integrate Jina AI embeddings API or self-hosted model
3. Modify EmbeddingWorker to handle late chunking
4. Update SearchChunk schema to store token spans

**Code Outline**:

```typescript
export class LateChunkingService {
  async chunk(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    // 1. Embed full document
    const fullDocEmbedding = await this.embedFullDocument(text);

    // 2. Detect sentence boundaries
    const sentences = this.detectSentences(text);
    const spans = this.getTokenSpans(sentences);

    // 3. Pool embeddings for each chunk
    const chunks = spans.map((span, index) => ({
      content: sentences[index],
      index,
      tokenCount: span[1] - span[0],
      charStart: span[0],
      charEnd: span[1],
      embedding: this.poolEmbedding(fullDocEmbedding, span),
    }));

    return chunks;
  }
}
```

**Benefits**:

- ✅ +6-30% improvement for long docs
- ✅ Better cross-chunk references
- ✅ No overlap needed

**Effort**: 1-2 weeks

---

#### 5. Implement Contextual Retrieval

**Rationale**: -67% failure rate, low cost

**Implementation Plan**:

1. Add context generation step before embedding
2. Use LLM to generate chunk context
3. Store both original and contextualized chunks
4. Enable prompt caching for cost efficiency

**Code Outline**:

```typescript
export class ContextualChunkingService {
  async enrichChunksWithContext(document: string, chunks: TextChunk[]): Promise<ContextualChunk[]> {
    const documentSummary = await this.summarizeDocument(document);

    const contextualChunks = await Promise.all(
      chunks.map(async (chunk) => {
        const context = await this.generateContext(documentSummary, chunk.content);
        const contextualizedContent = `${context}\n\n${chunk.content}`;

        return {
          ...chunk,
          context,
          contextualizedContent,
        };
      }),
    );

    return contextualChunks;
  }

  private async generateContext(documentSummary: string, chunkContent: string): Promise<string> {
    const prompt = `Given the document summary and chunk, generate a concise context (1-2 sentences):

Document Summary: ${documentSummary}
Chunk: ${chunkContent}

Context:`;

    const response = await this.callLLM(prompt, {
      model: 'gpt-3.5-turbo',
      temperature: 0.3,
      max_tokens: 100,
    });

    return response.trim();
  }
}
```

**Benefits**:

- ✅ -67% failure rate
- ✅ Better retrieval accuracy
- ✅ Low cost ($1.02/1M tokens)

**Effort**: 1 week

---

#### 6. Add Adaptive Chunking (Document-Length-Based)

**Rationale**: Different strategies for different document lengths

**Implementation**:

```typescript
export class AdaptiveChunkingService {
  async chunk(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    const tokenCount = this.estimateTokens(text);

    if (tokenCount < 500) {
      // Short content: traditional chunking sufficient
      return this.chunkFixed(text, options);
    } else if (tokenCount <= 8192) {
      // Fits in context: late chunking provides best quality
      return this.chunkLate(text, options);
    } else {
      // Exceeds context: split into sections, late chunk each
      return this.chunkSectioned(text, options);
    }
  }

  private async chunkSectioned(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    // Split document into 8K token sections
    const sections = this.splitIntoSections(text, 8192);

    // Late chunk each section independently
    const allChunks: TextChunk[] = [];
    let globalIndex = 0;

    for (const section of sections) {
      const sectionChunks = await this.chunkLate(section, options);

      // Update indices to be globally sequential
      for (const chunk of sectionChunks) {
        allChunks.push({
          ...chunk,
          index: globalIndex++,
        });
      }
    }

    return allChunks;
  }
}
```

**Benefits**:

- ✅ Optimal strategy per document
- ✅ Better overall performance
- ✅ Handles long documents gracefully

**Effort**: 1-2 weeks

---

### 8.3 Long-Term Enhancements (High Effort)

#### 7. Implement RAPTOR (Hierarchical Chunking)

**Rationale**: +20% accuracy for complex documents

**Implementation Plan**:

1. Build recursive tree structure via clustering (GMM + UMAP)
2. Generate summaries for each cluster (LLM)
3. Store tree structure in database (parent-child relationships)
4. Implement tree-based retrieval (collapsed tree + tree traversal)

**Database Changes**:

```typescript
// Add to SearchChunk schema
export interface ISearchChunk {
  // ... existing fields

  // RAPTOR tree fields
  treeLevel: number; // 0 = leaf, 1+ = internal nodes
  parentChunkId: string | null; // Parent in tree
  childChunkIds: string[]; // Children in tree
  isLeaf: boolean; // Leaf vs internal node
  clusterSummary: string | null; // For internal nodes
}
```

**Benefits**:

- ✅ +20% accuracy on complex docs
- ✅ Multi-level retrieval
- ✅ Better summarization queries

**Effort**: 4-6 weeks

---

#### 8. Implement ATLAS-KG (Full 6-Component System)

**Rationale**: Comprehensive enhancement with noise detection, knowledge graph, multimodal, etc.

**Implementation Plan**:

1. **Noise Detection**: Global/local TF-IDF + LLM concept extraction
2. **Adaptive Tree**: Sentence-aligned + semantic splitting + constrained balancing
3. **Knowledge Graph**: Entity extraction + co-occurrence + Neo4j integration
4. **Multimodal**: Image descriptions + table summarization
5. **Question Synthesis**: LLM-generated questions per chunk
6. **Scope Classification**: Chunk-level vs document-level

**Benefits**:

- ✅ 40-60% noise filtering
- ✅ +20-67% improvement in retrieval
- ✅ Cross-document relationships
- ✅ Multimodal support

**Effort**: 3-6 months (phased rollout)

---

## 9. Testing & Validation

### 9.1 Validation Strategy (Required Before Any Changes)

**⚠️ CRITICAL**: Do NOT implement enhancements without validation

**Research Finding**: Industry standards may not be optimal for our data

**Validation Steps**:

#### Step 1: Build Ground Truth Dataset

**Requirements**:

- 50-100 question-answer pairs from target domain
- Mix of query types:
  - Simple factoid: "What is the CEO's email?"
  - Multi-hop: "How does feature X relate to use case Y?"
  - Summarization: "What are the main themes?"
- Representative of production use cases

**Format**:

```json
{
  "query": "What was Q3 revenue?",
  "expected_answer": "Q3 revenue was $150M, up 20% YoY",
  "source_document": "docs/annual-report-2024.pdf",
  "relevant_chunks": ["chunk_123", "chunk_456"]
}
```

---

#### Step 2: Test Baseline Configurations

**Config A**: Industry Standard

```typescript
{
  strategy: 'fixed',
  chunkSize: 512,
  chunkOverlap: 50  // 10% overlap
}
```

**Config B**: Research-Driven (Zero Overlap)

```typescript
{
  strategy: 'semantic',
  chunkSize: 512,
  chunkOverlap: 0,
  respectBoundaries: true
}
```

**Config C**: Research-Driven (Large Chunks)

```typescript
{
  strategy: 'semantic',
  chunkSize: 2000,
  chunkOverlap: 0,
  respectBoundaries: true
}
```

---

#### Step 3: Evaluate Metrics

**Metric Definitions**:

1. **Recall@K**: % of queries where relevant chunk is in top K results

   ```typescript
   function calculateRecallAtK(results: Result[], groundTruth: string[], k: number): number {
     const topK = results.slice(0, k).map((r) => r.chunkId);
     const relevant = groundTruth.filter((id) => topK.includes(id));
     return relevant.length / groundTruth.length;
   }
   ```

2. **Mean Reciprocal Rank (MRR)**: Average inverse rank of first relevant result

   ```typescript
   function calculateMRR(results: Result[][], groundTruth: string[][]): number {
     let sum = 0;
     for (let i = 0; i < results.length; i++) {
       const firstRelevantRank =
         results[i].findIndex((r) => groundTruth[i].includes(r.chunkId)) + 1;
       sum += firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
     }
     return sum / results.length;
   }
   ```

3. **Coherence**: LLM-judged readability (1-5 scale)
   ```typescript
   async function evaluateCoherence(chunk: string): Promise<number> {
     const prompt = `Rate the coherence of this text on a scale of 1-5:
   ```

${chunk}

Score (1-5):`;

     const response = await callLLM(prompt, { temperature: 0 });
     return parseFloat(response);

}

```

**Target Metrics**:
| Metric      | Target | Method                        |
|-------------|--------|-------------------------------|
| Recall@5    | ≥ 90%  | Top 5 chunks contain answer   |
| Recall@3    | ≥ 80%  | Top 3 chunks contain answer   |
| MRR         | ≥ 0.6  | Mean Reciprocal Rank          |
| Coherence   | ≥ 3.5  | LLM-judged readability (1-5)  |
| Latency     | <2s    | Processing time per document  |

---

#### Step 4: Select Baseline

**Decision Criteria**:
1. Highest Recall@5 (primary)
2. Coherence as tiebreaker (if Recall@5 within 2%)
3. Latency must be <2s (hard requirement)

**Example Results**:
```

Config A (512/50): Recall@5=85%, Coherence=3.2, Latency=0.8s
Config B (512/0): Recall@5=88%, Coherence=3.7, Latency=0.7s ← Winner
Config C (2000/0): Recall@5=90%, Coherence=4.1, Latency=2.5s ✗ Too slow

````

**Selection**: Config B (512 tokens, 0 overlap, semantic)

---

### 9.2 Implementation Testing

**Unit Tests** (already exist):
```typescript
// apps/search-ai/src/__tests__/search-ai-services.test.ts

describe('ChunkingService', () => {
  test('returns single chunk for short text', () => {
    const service = new ChunkingService();
    const result = service.chunk('Hello world', {
      strategy: 'fixed',
      chunkSize: 100,
      chunkOverlap: 0,
    });
    expect(result).toHaveLength(1);
  });

  test('splits text into multiple chunks', () => {
    const service = new ChunkingService();
    const text = 'a'.repeat(200);
    const result = service.chunk(text, {
      strategy: 'fixed',
      chunkSize: 10,
      chunkOverlap: 2,
    });
    expect(result.length).toBeGreaterThan(1);
  });

  // ... 20+ more tests
});
````

**Integration Tests**:

```typescript
describe('Chunking Pipeline E2E', () => {
  test('chunks document through full pipeline', async () => {
    // 1. Upload document
    const document = await uploadTestDocument('test.pdf');

    // 2. Wait for extraction
    await waitForStatus(document.id, 'extracted');

    // 3. Wait for chunking
    await waitForStatus(document.id, 'enriched');

    // 4. Verify chunks created
    const chunks = await SearchChunk.find({ documentId: document.id });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toBeTruthy();
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });
});
```

---

### 9.3 Monitoring & Observability

**Metrics to Track** (production):

1. **Chunking Performance**:
   - Documents processed per minute
   - Average chunks per document
   - Average chunk size (tokens)
   - Chunking latency (p50, p95, p99)

2. **Quality Metrics**:
   - Retrieval accuracy (Recall@K from eval set)
   - User feedback (thumbs up/down on answers)
   - Query latency (search time)

3. **Cost Metrics**:
   - Chunks per dollar (storage)
   - Embeddings cost per document
   - LLM enrichment cost (if using contextual retrieval)

**Dashboard Example**:

```typescript
{
  "chunking_stats": {
    "documents_processed": 10_000,
    "total_chunks": 500_000,
    "avg_chunks_per_doc": 50,
    "avg_chunk_size_tokens": 1024,
    "p50_latency_ms": 850,
    "p95_latency_ms": 1_200,
    "p99_latency_ms": 2_100
  },
  "quality_metrics": {
    "recall_at_5": 0.88,
    "mrr": 0.65,
    "user_satisfaction": 0.82
  },
  "cost_metrics": {
    "storage_cost_per_doc": 0.0012,
    "embedding_cost_per_doc": 0.0008,
    "total_cost_per_doc": 0.0020
  }
}
```

---

## 10. Summary & Recommendations

### Current State

**Strengths**:

- ✅ Working implementation with 3 strategies (fixed, semantic, sliding_window)
- ✅ Integrated into pipeline (canonical-mapper-worker)
- ✅ Configurable per-index (chunkStrategy in SearchIndex)
- ✅ Tested (20+ unit tests)
- ✅ Production-ready (used in current ingestion pipeline)

**Weaknesses**:

- ❌ Fixed strategy breaks sentences mid-word
- ❌ Token estimation is heuristic (4 chars/token)
- ❌ No validation of chunk sizes vs model limits
- ❌ No advanced techniques (contextual retrieval, late chunking, RAPTOR)
- ❌ No cross-document relationships
- ❌ No noise detection

---

### Recommended Enhancements (Priority Order)

#### Phase 1: Baseline Improvements (2-4 weeks)

1. **Validate current strategy** against ground truth dataset
2. **Add sentence-aligned chunking** to fixed strategy
3. **Use actual tokenizer** (tiktoken) for accurate token counts
4. **Add chunk size validation** at index creation

**Impact**: +5-10% retrieval accuracy, prevent configuration errors
**Effort**: 2-4 weeks
**Cost**: Minimal

---

#### Phase 2: Advanced Techniques (1-2 months)

5. **Implement contextual retrieval** (Anthropic)
6. **Implement late chunking** (Jina AI) for docs >1k tokens
7. **Add adaptive chunking** (document-length-based routing)

**Impact**: +20-30% retrieval accuracy, -67% failure rate
**Effort**: 1-2 months
**Cost**: $1-2 per 1M tokens (LLM enrichment)

---

#### Phase 3: Hierarchical & Knowledge Graph (3-6 months)

8. **Implement RAPTOR** (hierarchical chunking) for complex docs
9. **Implement ATLAS-KG** (full 6-component system)

**Impact**: +40-60% noise filtering, cross-document relationships, multimodal support
**Effort**: 3-6 months (phased)
**Cost**: $40-50k per 1M documents (one-time indexing)

---

### Critical Action Items

**⚠️ DO NOT IMPLEMENT WITHOUT VALIDATION**:

- Build ground truth Q&A dataset (50-100 pairs)
- Test baseline configs: 512/50 vs 512/0 vs 2000/0
- Evaluate: Recall@K, MRR, coherence, latency
- Let data drive decision (not research papers or industry standards)

**✅ START HERE**:

1. Build validation dataset
2. Run baseline tests
3. Select optimal config
4. Implement immediate improvements (sentence-aligned, accurate tokenizer)
5. Measure improvement
6. Iterate

---

### Key Takeaways

1. **Current implementation is functional** but lacks advanced features
2. **Research suggests alternatives to industry standards** (0 overlap, 2k tokens)
3. **Validation is REQUIRED** before any changes
4. **Phased approach recommended**: baseline → advanced → hierarchical
5. **Cost-benefit must be evaluated** per enhancement (ROI, complexity, impact)

---

## References

1. **Current Implementation**:
   - `apps/search-ai/src/services/chunking/index.ts`
   - `apps/search-ai/src/workers/canonical-mapper-worker.ts`
   - `packages/database/src/models/search-chunk.model.ts`

2. **Research Documents**:
   - `docs/searchai/chunking/ATLAS_KG_CHUNKING_ARCHITECTURE.md`
   - `docs/searchai/chunking/RAPTOR_RESEARCH.md`
   - `docs/searchai/chunking/LATE_CHUNKING_RESEARCH.md`
   - `docs/searchai/chunking/SEARCHAI_CHUNKING_RESEARCH_UPDATE.md`

3. **Architecture**:
   - `docs/searchai/design/SEARCHAI-ARCHITECTURE.md` (complete system architecture)

4. **External Research**:
   - Anthropic: https://www.anthropic.com/news/contextual-retrieval
   - Jina AI: https://jina.ai/news/late-chunking-in-long-context-embedding-models
   - RAPTOR: https://arxiv.org/abs/2401.18059

---

**Document Complete**: This analysis covers the complete chunking system in SearchAI, from current implementation to research-driven enhancements.
