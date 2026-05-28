# SearchAI Pipeline Invocation Guide

> **When does docling extraction, page processing, question synthesis, scope classification, and other advanced features get invoked?**
>
> **Date**: 2026-02-23
> **Status**: Current Implementation

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Two Parallel Paths](#two-parallel-paths)
3. [Path 1: Legacy Extraction (Old/Simple)](#path-1-legacy-extraction-oldsimple)
4. [Path 2: Docling + ATLAS-KG (New/Advanced)](#path-2-docling--atlas-kg-newadvanced)
5. [Configuration: How to Control Pipeline Path](#configuration-how-to-control-pipeline-path)
6. [Advanced Features Detail](#advanced-features-detail)
7. [Worker Dependency Graph](#worker-dependency-graph)
8. [When Each Strategy Is Invoked](#when-each-strategy-is-invoked)

---

## Pipeline Overview

SearchAI has **two ingestion paths** that run in parallel depending on document type and configuration:

```
                         ┌─── UPLOAD DOCUMENT ───┐
                         │                        │
                         ▼                        ▼
          ┌────────────────────────┐    ┌────────────────────────┐
          │ PATH 1: LEGACY         │    │ PATH 2: DOCLING        │
          │ (Old extraction path)  │    │ (Advanced path)        │
          └────────────────────────┘    └────────────────────────┘
                    │                              │
                    │                              │
           Simple Documents              Complex Documents
           (Text, Markdown)              (PDFs with images/tables)
                    │                              │
                    ▼                              ▼
          Extraction Worker                Docling Extraction Worker
          (Stub - reads                    (Python service -
           pre-extracted text)              layout, images, tables)
                    │                              │
                    ▼                              ▼
          Canonical Mapper                 Page Processing Worker
          (Chunking)                       (Progressive summarization,
                                            question generation)
                    │                              │
                    │                              ├─► Visual Enrichment
                    │                              │   (Phase 3)
                    │                              │
                    ▼                              ▼
          ┌────────────────────────────────────────────────┐
          │         CONVERGENCE POINT                      │
          │         (Both paths merge here)                │
          └────────────────────────────────────────────────┘
                              │
                              ▼
                    Enrichment Worker
                              │
                              ▼
          ┌────────────────────────────────────────────────┐
          │  PARALLEL ADVANCED FEATURES (Optional)         │
          │  - Question Synthesis                          │
          │  - Scope Classification                        │
          │  - Knowledge Graph                             │
          │  - Tree Building                               │
          │  - Multimodal Enrichment                       │
          └────────────────────────────────────────────────┘
                              │
                              ▼
                    Embedding Worker
                              │
                              ▼
                          INDEXED
```

---

## Two Parallel Paths

### Key Decision Point: Document Upload

When a document is uploaded, the system must decide which path to take:

**Currently**: Based on document route/endpoint used:

- `/api/indexes/:indexId/sources/:sourceId/documents` → **Path 1 (Legacy)**
- Direct Docling upload endpoint → **Path 2 (Docling)**

**Future** (not yet implemented): Based on index configuration or content type detection.

---

## Path 1: Legacy Extraction (Old/Simple)

### When It's Used

- Text documents (`.txt`, `.md`)
- Pre-extracted content
- Documents that don't need layout/structure analysis
- **DEFAULT PATH** for the ingestion worker

### Pipeline Flow

```
1. INGESTION WORKER
   Queue: QUEUE_INGESTION
   └─> Creates SearchDocument records
   └─> Enqueues to QUEUE_EXTRACTION

2. EXTRACTION WORKER ⭐ (STUB)
   Queue: QUEUE_EXTRACTION
   └─> Reads document.extractedText (already populated)
   └─> Updates document status: EXTRACTED
   └─> Enqueues to QUEUE_CANONICAL_MAP

3. CANONICAL MAPPER WORKER ⭐ CHUNKING HAPPENS HERE
   Queue: QUEUE_CANONICAL_MAP
   └─> Uses ChunkingService to split text
   └─> Creates SearchChunk records
   └─> Updates document.chunkCount
   └─> Enqueues to QUEUE_ENRICHMENT

4. ENRICHMENT WORKER
   Queue: QUEUE_ENRICHMENT
   └─> Entity extraction (stub)
   └─> Language detection (stub)
   └─> Enqueues to QUEUE_QUESTION_SYNTHESIS (if enabled)
   └─> Enqueues to QUEUE_SCOPE_CLASSIFICATION (if enabled)
   └─> Enqueues to QUEUE_EMBEDDING

5. QUESTION SYNTHESIS WORKER (Optional)
   Queue: QUEUE_QUESTION_SYNTHESIS
   └─> IF llmConfig.useCases.questionSynthesis.enabled
   └─> Generates 3-5 questions per chunk
   └─> Stores in ChunkQuestion collection

6. SCOPE CLASSIFICATION WORKER (Optional)
   Queue: QUEUE_SCOPE_CLASSIFICATION
   └─> IF llmConfig.useCases.scopeClassification.enabled
   └─> Classifies chunk scope (chunk/section/document)
   └─> Stores in ChunkScope collection

7. EMBEDDING WORKER
   Queue: QUEUE_EMBEDDING
   └─> Generates embeddings for chunks
   └─> Upserts to Qdrant vector store
   └─> Updates document status: INDEXED
```

### Code References

- Ingestion: `apps/search-ai/src/workers/ingestion-worker.ts`
- Extraction: `apps/search-ai/src/workers/extraction-worker.ts` (stub)
- Canonical Mapper: `apps/search-ai/src/workers/canonical-mapper-worker.ts`
- Enrichment: `apps/search-ai/src/workers/enrichment-worker.ts`
- Question Synthesis: `apps/search-ai/src/workers/question-synthesis-worker.ts`
- Scope Classification: `apps/search-ai/src/workers/scope-classification-worker.ts`
- Embedding: `apps/search-ai/src/workers/embedding-worker.ts`

---

## Path 2: Docling + ATLAS-KG (New/Advanced)

### When It's Used

- **PDFs** with images, tables, complex layouts
- Documents requiring **page-by-page processing**
- When **visual enrichment** is needed
- When **progressive summarization** across pages is desired

### Pipeline Flow

```
1. DOCUMENT UPLOAD (Direct)
   Route: Direct upload to docling endpoint
   └─> Creates SearchDocument record
   └─> Uploads file to S3 or local storage
   └─> Enqueues to QUEUE_DOCLING_EXTRACTION

2. DOCLING EXTRACTION WORKER ⭐
   Queue: QUEUE_DOCLING_EXTRACTION
   └─> Downloads document from S3/URL
   └─> Calls Docling Python service (REST API)
   └─> Extracts:
       • Page text (with layout structure)
       • Headings (hierarchical structure)
       • Tables (rows, headers, markdown, HTML)
       • Images (base64-encoded)
       • Screenshots (full page renders)
   └─> Uploads images/screenshots to S3
   └─> Creates DocumentPage records (MongoDB)
   └─> Updates document status: EXTRACTED
   └─> Enqueues to QUEUE_PAGE_PROCESSING

3. PAGE PROCESSING WORKER ⭐ (Phase 2: Progressive Summarization)
   Queue: QUEUE_PAGE_PROCESSING

   BATCH PROCESSING (10 pages at a time):

   For each page:
     a) Progressive Summarization
        └─> IF llmConfig.useCases.progressiveSummarization.enabled
        └─> Generates summary with context from previous pages
        └─> Passes summary to next page (context continuity)

     b) Create Page Chunk
        └─> Creates SearchChunk from page.text
        └─> Stores summary in chunk.metadata.progressiveSummary

     c) Question Generation (Per-Page)
        └─> IF llmConfig.useCases.questionSynthesis.enabled
        └─> Generates questions for this page
        └─> Creates ChunkQuestion records

     d) Extract Tables as Separate Chunks
        └─> Each table becomes a separate chunk
        └─> metadata.chunkType = 'table'

   If more pages remain:
     └─> Enqueue next batch to QUEUE_PAGE_PROCESSING
         (passes currentSummary as context)

   If all pages processed:
     └─> Generate document-level summary (from all page summaries)
     └─> Store in document.metadata.documentSummary
     └─> Enqueue to QUEUE_QUESTION_SYNTHESIS (document-level)
     └─> Enqueue to QUEUE_CANONICAL_MAP

4. QUESTION SYNTHESIS WORKER (Document-Level)
   Queue: QUEUE_QUESTION_SYNTHESIS
   └─> Generates document-level questions
   └─> Scope: 'document' (vs 'chunk' from page processing)

5. CANONICAL MAPPER WORKER
   Queue: QUEUE_CANONICAL_MAP
   └─> Applies canonical field mappings (stub)
   └─> Updates canonicalMetadata on chunks
   └─> Enqueues to QUEUE_VISUAL_ENRICHMENT (if has images)
   └─> Enqueues to QUEUE_ENRICHMENT

6. VISUAL ENRICHMENT WORKER ⭐ (Phase 3: Multimodal)
   Queue: QUEUE_VISUAL_ENRICHMENT

   IF document has images:

     Phase 3a: Page-by-Page Visual Enrichment
     For each page with images:
       └─> Analyze images with vision model
       └─> Progressive context: pass visual descriptions forward
       └─> Re-summarize page text + visual context
       └─> Enhance questions with visual information

     Phase 3b: Document-Level Visual Enrichment
       └─> Re-generate document summary with all visual context
       └─> Enhance document-level questions

   └─> Updates chunks with visual metadata
   └─> Enqueues to QUEUE_ENRICHMENT

7. ENRICHMENT WORKER
   Queue: QUEUE_ENRICHMENT
   └─> Entity extraction (stub)
   └─> Language detection (stub)
   └─> Enqueues to QUEUE_SCOPE_CLASSIFICATION (if enabled)
   └─> Enqueues to QUEUE_EMBEDDING

8. SCOPE CLASSIFICATION WORKER (Optional)
   Queue: QUEUE_SCOPE_CLASSIFICATION
   └─> IF llmConfig.useCases.scopeClassification.enabled
   └─> Classifies chunk scope (chunk/section/document)
   └─> Stores in ChunkScope collection

9. EMBEDDING WORKER
   Queue: QUEUE_EMBEDDING
   └─> Generates embeddings for chunks
   └─> Upserts to Qdrant vector store
   └─> Updates document status: INDEXED
```

### Code References

- Docling Extraction: `apps/search-ai/src/workers/docling-extraction-worker.ts`
- Page Processing: `apps/search-ai/src/workers/page-processing-worker.ts`
- Visual Enrichment: `apps/search-ai/src/workers/visual-enrichment-worker.ts`
- Question Synthesis (doc-level): `apps/search-ai/src/workers/question-synthesis-worker.ts`
- Scope Classification: `apps/search-ai/src/workers/scope-classification-worker.ts`

---

## Configuration: How to Control Pipeline Path

### Per-Index LLM Configuration

All advanced features are controlled by **per-index configuration** stored in MongoDB.

**Location**: `SearchIndex` model → `llmConfig` field (resolves from tenant → project → index hierarchy)

**Schema**:

```typescript
interface IndexLLMConfig {
  useCases: {
    // Progressive Summarization (Phase 2)
    progressiveSummarization: {
      enabled: boolean; // Enable/disable
      provider: 'anthropic' | 'openai' | 'google';
      model: string; // e.g., 'claude-sonnet-4'
      apiKey: string; // Provider API key
      maxTokens: number; // Max tokens for summary
      enableDocumentSummary: boolean; // Document-level summary
      documentSummaryMaxTokens: number;
    };

    // Question Synthesis (Phase 2 & 5)
    questionSynthesis: {
      enabled: boolean;
      provider: 'anthropic' | 'openai' | 'google';
      model: string;
      apiKey: string;
      questionsPerChunk: number; // Default: 3-5
      maxTokens: number;
      enableEmbedding: boolean; // Embed questions for retrieval
    };

    // Scope Classification (Phase 5)
    scopeClassification: {
      enabled: boolean;
      provider: 'anthropic' | 'openai' | 'google';
      model: string;
      apiKey: string;
      maxTokens: number;
    };

    // Visual Enrichment (Phase 3)
    visualEnrichment: {
      enabled: boolean;
      provider: 'anthropic' | 'openai' | 'google';
      model: string; // e.g., 'claude-opus-4' (vision)
      apiKey: string;
      maxTokens: number;
    };
  };
}
```

### Resolution Hierarchy

Configuration resolves in this order (most specific wins):

1. **Index-level**: `SearchIndex.llmConfig`
2. **Project-level**: `Project.llmConfig` (if not overridden by index)
3. **Tenant-level**: `Tenant.llmConfig` (if not overridden by project)
4. **Platform defaults**: `apps/search-ai/src/services/llm-config/defaults.ts`

**Resolver**: `apps/search-ai/src/services/llm-config/resolver.ts`

```typescript
export async function resolveIndexLLMConfig(
  tenantId: string,
  indexId: string,
): Promise<IndexLLMConfig> {
  // Fetch index → project → tenant
  // Merge configs (deep merge)
  // Return resolved config
}
```

### Example Configuration

**Enable all Phase 2 features (progressive summarization + questions)**:

```json
{
  "useCases": {
    "progressiveSummarization": {
      "enabled": true,
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "apiKey": "sk-ant-...",
      "maxTokens": 500,
      "enableDocumentSummary": true,
      "documentSummaryMaxTokens": 1000
    },
    "questionSynthesis": {
      "enabled": true,
      "provider": "google",
      "model": "gemini-1.5-flash",
      "apiKey": "AIza...",
      "questionsPerChunk": 3,
      "maxTokens": 200,
      "enableEmbedding": false
    }
  }
}
```

**Disable all advanced features** (use basic chunking only):

```json
{
  "useCases": {
    "progressiveSummarization": { "enabled": false },
    "questionSynthesis": { "enabled": false },
    "scopeClassification": { "enabled": false },
    "visualEnrichment": { "enabled": false }
  }
}
```

---

## Advanced Features Detail

### 1. Docling Extraction

**When Invoked**: When a PDF document is uploaded to the docling extraction path

**What It Does**:

- Calls Python Docling service (REST API at `http://localhost:8080/extract`)
- Extracts structured content:
  - **Text** with layout information (headings, paragraphs)
  - **Tables** (rows, headers, markdown, HTML, bounding boxes)
  - **Images** (base64-encoded, with bounding boxes)
  - **Screenshots** (full page renders as PNG)
- Uploads images/screenshots to S3 (or local storage in dev)
- Creates `DocumentPage` records in MongoDB (one per page)

**Configuration**:

- Service URL: `process.env.DOCLING_SERVICE_URL` (default: `http://localhost:8080`)
- Options: `{ extractImages: true, extractTables: true, renderScreenshots: true, ocrEnabled: true }`

**Output**: `DocumentPage` collection populated

**Code**: `apps/search-ai/src/workers/docling-extraction-worker.ts`

---

### 2. Page Processing (Progressive Summarization)

**When Invoked**: After Docling extraction, processes pages in batches of 10

**What It Does**:

- **Progressive Summarization**:
  - Generates summary for each page
  - Passes summary to next page as context (context continuity)
  - Example: Page 3 summary includes context from pages 1-2
- **Question Generation (Per-Page)**:
  - Generates 3-5 questions per page
  - Questions stored with `scope: 'chunk'`
- **Table Extraction**:
  - Extracts tables as separate chunks
  - `metadata.chunkType = 'table'`
- **Document-Level Summary**:
  - After all pages processed, generates overall document summary
  - Uses all page summaries as input

**Configuration**:

```typescript
llmConfig.useCases.progressiveSummarization: {
  enabled: true,
  model: 'claude-sonnet-4',
  maxTokens: 500,
  enableDocumentSummary: true
}
```

**Output**:

- `SearchChunk` records with `metadata.progressiveSummary`
- `ChunkQuestion` records (per-page, `scope: 'chunk'`)
- `SearchDocument.metadata.documentSummary`

**Code**: `apps/search-ai/src/workers/page-processing-worker.ts`

**Services**:

- `apps/search-ai/src/services/progressive-summarization/index.ts`
- `apps/search-ai/src/services/question-synthesis/index.ts`

---

### 3. Question Synthesis

**When Invoked**: Two invocation points:

**A. Per-Chunk (During Page Processing)**:

- Inline during page processing worker
- Generates questions for each page chunk
- Immediate storage in `ChunkQuestion` collection

**B. Document-Level (After All Pages Processed)**:

- Separate worker after page processing completes
- Generates high-level questions spanning entire document
- Questions have `scope: 'document'`

**What It Does**:

- Uses LLM to generate 3-5 answerable questions per chunk
- Question types: factoid, conceptual, analytical, comparative
- Stored in `ChunkQuestion` collection
- Optional: Embed questions for question-based retrieval

**Configuration**:

```typescript
llmConfig.useCases.questionSynthesis: {
  enabled: true,
  provider: 'google',
  model: 'gemini-1.5-flash',
  questionsPerChunk: 3,
  maxTokens: 200,
  enableEmbedding: false
}
```

**Output**: `ChunkQuestion` collection populated

**Code**: `apps/search-ai/src/workers/question-synthesis-worker.ts`

**Service**: `apps/search-ai/src/services/question-synthesis/index.ts`

---

### 4. Scope Classification

**When Invoked**: After enrichment (parallel with embedding), if enabled

**What It Does**:

- Classifies each chunk's **scope level**:
  - **chunk**: Answers queries about specific detail (e.g., "What is X?")
  - **section**: Answers queries about a section/concept (e.g., "How does Y work?")
  - **document**: Answers queries about overall content (e.g., "What is this document about?")
- Determines **retrieval strategy**:
  - `chunk`: Return just the chunk
  - `section`: Return chunk + parent context
  - `document`: Return chunk + document summary
- Stored in `ChunkScope` collection

**Configuration**:

```typescript
llmConfig.useCases.scopeClassification: {
  enabled: true,
  provider: 'google',
  model: 'gemini-1.5-flash',
  maxTokens: 100
}
```

**Output**: `ChunkScope` collection populated

**Code**: `apps/search-ai/src/workers/scope-classification-worker.ts`

**Service**: `apps/search-ai/src/services/scope-classifier/index.ts`

---

### 5. Visual Enrichment (Phase 3)

**When Invoked**: After canonical mapping, if document has images

**What It Does**:

**Phase 3a: Page-by-Page Enrichment**

- For each page with images:
  - Analyze images with vision model (Claude Opus 4 or GPT-4 Vision)
  - Generate descriptions with progressive context from previous pages
  - Re-summarize page text enriched with visual information
  - Enhance existing questions with visual context

**Phase 3b: Document-Level Enrichment**

- After all pages enriched:
  - Re-generate document summary with all visual context
  - Enhance document-level questions

**Configuration**:

```typescript
llmConfig.useCases.visualEnrichment: {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-opus-4',  // Must support vision
  maxTokens: 1000
}
```

**Output**:

- Updated `SearchChunk` records with visual metadata
- Updated `ChunkQuestion` records with visual enhancements
- Updated `SearchDocument.metadata.documentSummary`

**Code**:

- `apps/search-ai/src/workers/visual-enrichment-worker.ts`
- `apps/search-ai/src/workers/document-visual-enrichment-worker.ts`

**Service**: `apps/search-ai/src/services/vision/index.ts`

---

### 6. Chunking Strategies

**When Invoked**: During canonical mapper worker (Path 1) or after page processing (Path 2)

**Three Strategies** (configured per-index):

#### A. Fixed-Size Chunking

```typescript
{
  method: 'fixed',
  chunkSize: 1024,      // tokens
  chunkOverlap: 128     // tokens
}
```

- Splits text at fixed character boundaries
- Uses 4 chars/token heuristic
- Fast, predictable chunk sizes
- **Downside**: Breaks sentences mid-word

#### B. Semantic Chunking

```typescript
{
  method: 'semantic',
  chunkSize: 1024,
  chunkOverlap: 0,
  respectBoundaries: true
}
```

- Respects paragraph boundaries (`\n\n+`)
- Splits large paragraphs at sentence boundaries
- Falls back to fixed for non-parsable text
- **Downside**: Variable chunk sizes

#### C. Sliding Window

```typescript
{
  method: 'sliding_window',
  chunkSize: 1024,
  chunkOverlap: 128
}
```

- Alias for fixed strategy (currently identical)
- Emphasis on overlap for context continuity

**Code**: `apps/search-ai/src/services/chunking/index.ts`

---

## Worker Dependency Graph

```
┌────────────────────────────────────────────────────────────────────┐
│                     WORKER EXECUTION ORDER                          │
└────────────────────────────────────────────────────────────────────┘

SEQUENTIAL (Path 1 - Legacy):
  1. Ingestion → 2. Extraction → 3. Canonical Map → 4. Enrichment
      │                                                    │
      └───────────────────────────────────────────────────┘
                                │
                    ┌───────────┴────────────┐
                    ▼                        ▼
         5a. Question Synthesis   5b. Scope Classification
             (if enabled)              (if enabled)
                    │                        │
                    └───────────┬────────────┘
                                ▼
                         6. Embedding

SEQUENTIAL (Path 2 - Docling):
  1. Docling Extraction → 2. Page Processing → 3. Canonical Map
                              │                      │
                              ├─► Question Synthesis │
                              │   (per-page)         │
                              │                      │
                              └─► Visual Enrichment ─┘
                                      (if has images)
                                            │
                                            ▼
                                     4. Enrichment
                                            │
                    ┌───────────────────────┴────────────────────┐
                    ▼                                            ▼
         5a. Question Synthesis                   5b. Scope Classification
             (document-level)                          (if enabled)
                    │                                            │
                    └───────────────────┬────────────────────────┘
                                        ▼
                                  6. Embedding

DEPENDENCIES:
  - Question Synthesis depends on: Enrichment
  - Scope Classification depends on: Enrichment
  - Embedding depends on: All optional workers complete
  - Visual Enrichment depends on: Page Processing + has images
```

---

## When Each Strategy Is Invoked

### Summary Table

| Feature                        | Invoked When                                 | Configuration Key                                     | Queue                        |
| ------------------------------ | -------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| **Docling Extraction**         | PDF uploaded to docling path                 | N/A (path-based)                                      | `QUEUE_DOCLING_EXTRACTION`   |
| **Page Processing**            | After docling extraction                     | N/A (always runs after docling)                       | `QUEUE_PAGE_PROCESSING`      |
| **Progressive Summarization**  | Page processing worker, if enabled           | `llmConfig.useCases.progressiveSummarization.enabled` | (inline in page processing)  |
| **Question Synthesis (chunk)** | Page processing worker, if enabled           | `llmConfig.useCases.questionSynthesis.enabled`        | (inline in page processing)  |
| **Question Synthesis (doc)**   | After all pages processed, if enabled        | `llmConfig.useCases.questionSynthesis.enabled`        | `QUEUE_QUESTION_SYNTHESIS`   |
| **Visual Enrichment**          | After canonical map, if has images & enabled | `llmConfig.useCases.visualEnrichment.enabled`         | `QUEUE_VISUAL_ENRICHMENT`    |
| **Scope Classification**       | After enrichment, if enabled                 | `llmConfig.useCases.scopeClassification.enabled`      | `QUEUE_SCOPE_CLASSIFICATION` |
| **Chunking (fixed)**           | Canonical mapper worker                      | `index.chunkStrategy.method = 'fixed'`                | (inline in canonical mapper) |
| **Chunking (semantic)**        | Canonical mapper worker                      | `index.chunkStrategy.method = 'semantic'`             | (inline in canonical mapper) |
| **Chunking (sliding_window)**  | Canonical mapper worker                      | `index.chunkStrategy.method = 'sliding_window'`       | (inline in canonical mapper) |
| **Embedding**                  | Always (final step)                          | N/A (always runs)                                     | `QUEUE_EMBEDDING`            |

---

## Example Scenarios

### Scenario 1: Simple Text Document (Markdown)

**Upload**: `/api/indexes/idx_1/sources/src_1/documents` (multipart/form-data)

**Pipeline**:

```
Ingestion → Extraction (stub) → Canonical Map (chunking) → Enrichment → Embedding → INDEXED
```

**Time**: ~5 seconds
**Features Used**: Basic chunking only
**Cost**: $0.0001 per chunk (embedding only)

---

### Scenario 2: PDF with Images (All Features Enabled)

**Upload**: Direct docling upload

**Pipeline**:

```
Docling Extraction (layout + images + tables)
  ↓
Page Processing (10 pages/batch)
  ├─► Progressive Summarization (per-page)
  ├─► Question Generation (per-page)
  └─► Table Extraction
  ↓
(All pages complete)
  ├─► Document-Level Summary
  └─► Question Synthesis (document-level)
  ↓
Canonical Map (field mappings)
  ↓
Visual Enrichment (Phase 3)
  ├─► Phase 3a: Page-by-Page Visual Analysis
  └─► Phase 3b: Document-Level Visual Summary
  ↓
Enrichment (entity extraction, language detection)
  ↓
Scope Classification (chunk/section/document)
  ↓
Embedding → INDEXED
```

**Time**: ~2-5 minutes (depends on page count, image count)
**Features Used**: All advanced features
**Cost**: ~$0.001 per chunk (full ATLAS-KG Phase 2+3+5)

---

### Scenario 3: PDF Without Images (Phase 2 Only)

**Upload**: Direct docling upload

**Pipeline**:

```
Docling Extraction
  ↓
Page Processing
  ├─► Progressive Summarization
  ├─► Question Generation (per-page)
  └─► Document-Level Summary
  ↓
Canonical Map
  ↓
Enrichment
  ↓
Question Synthesis (document-level)
  ↓
Scope Classification
  ↓
Embedding → INDEXED
```

**Time**: ~30-60 seconds
**Features Used**: Phase 2 + Phase 5 (no visual enrichment)
**Cost**: ~$0.0005 per chunk

---

## Configuration Examples

### Minimal Configuration (No Advanced Features)

```typescript
{
  useCases: {
    progressiveSummarization: { enabled: false },
    questionSynthesis: { enabled: false },
    scopeClassification: { enabled: false },
    visualEnrichment: { enabled: false }
  }
}
```

**Result**: Basic chunking + embedding only (cheapest, fastest)

---

### Phase 2 Only (Progressive Summarization + Questions)

```typescript
{
  useCases: {
    progressiveSummarization: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-...',
      maxTokens: 500,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 1000
    },
    questionSynthesis: {
      enabled: true,
      provider: 'google',
      model: 'gemini-1.5-flash',
      apiKey: 'AIza...',
      questionsPerChunk: 3,
      maxTokens: 200,
      enableEmbedding: false
    },
    scopeClassification: { enabled: false },
    visualEnrichment: { enabled: false }
  }
}
```

**Result**: Progressive summarization + questions (no visual, no scope)

---

### Full ATLAS-KG (All Features)

```typescript
{
  useCases: {
    progressiveSummarization: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-...',
      maxTokens: 500,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 1000
    },
    questionSynthesis: {
      enabled: true,
      provider: 'google',
      model: 'gemini-1.5-flash',
      apiKey: 'AIza...',
      questionsPerChunk: 3,
      maxTokens: 200,
      enableEmbedding: true  // Embed questions for retrieval
    },
    scopeClassification: {
      enabled: true,
      provider: 'google',
      model: 'gemini-1.5-flash',
      apiKey: 'AIza...',
      maxTokens: 100
    },
    visualEnrichment: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-4',
      apiKey: 'sk-ant-...',
      maxTokens: 1000
    }
  }
}
```

**Result**: All ATLAS-KG phases enabled (most expensive, highest quality)

---

## Key Takeaways

> **LLM Configuration:** All LLM-using workers now resolve models per-use-case via `SearchIndex.llmConfig` through `resolveIndexLLMConfig(tenantId, indexId)`. No hardcoded model names remain. Prompts are loaded from versioned YAML templates in `apps/search-ai/src/prompts/v1/` via `PromptLoaderService`, not inline strings.

1. **Two Parallel Paths**: Legacy (simple) vs Docling (advanced)
   - Legacy: Text documents, basic chunking
   - Docling: PDFs with layout/images/tables

2. **Configuration-Driven**: All advanced features controlled by per-index `llmConfig`
   - Can enable/disable each feature independently
   - Provider/model selection per use case
   - Resolves from tenant → project → index

3. **Progressive Enhancement**: Features build on each other
   - Phase 2: Progressive summarization + questions
   - Phase 3: Visual enrichment (requires Phase 2)
   - Phase 5: Scope classification (standalone)

4. **Chunking is Always Invoked**: Either during canonical mapper (Path 1) or after page processing (Path 2)
   - Three strategies: fixed, semantic, sliding_window
   - Configured per-index via `chunkStrategy`

5. **Question Synthesis Has Two Invocation Points**:
   - Per-chunk (inline during page processing)
   - Document-level (separate worker after all pages)

6. **Visual Enrichment is Conditional**:
   - Only runs if document has images
   - Only runs if enabled in config
   - Requires Phase 2 (progressive summarization) first

---

## References

### Documentation

- `docs/searchai/chunking/ATLAS_KG_CHUNKING_ARCHITECTURE.md`
- `docs/searchai/chunking/ATLAS_KG_WORKER_ARCHITECTURE.md`
- `docs/searchai/ATLAS-KG-ARCHITECTURE.md`
- `docs/searchai/CHUNKING_SYSTEM_ANALYSIS.md` (this document's companion)

### Code

- Workers: `apps/search-ai/src/workers/`
- Services: `apps/search-ai/src/services/`
- Config: `apps/search-ai/src/services/llm-config/`
- Queue Definitions: `packages/search-ai-sdk/src/constants.ts`

---

**Document Complete**: This guide explains when and how each advanced feature is invoked in the SearchAI pipeline.
