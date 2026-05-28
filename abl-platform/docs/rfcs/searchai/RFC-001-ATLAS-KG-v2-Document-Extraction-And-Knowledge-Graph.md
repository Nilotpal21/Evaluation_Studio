# RFC-001: ATLAS-KG v2 - Document Extraction & Knowledge Graph

**Status:** In Progress (Week 1 Complete)
**Created:** 2026-02-19
**Author:** Engineering Team
**Last Updated:** 2026-02-19

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Proposed Solution](#proposed-solution)
4. [Architecture Overview](#architecture-overview)
5. [Implementation Status](#implementation-status)
6. [Week 1: Completed Work](#week-1-completed-work)
7. [Week 2-3: Pending Work](#week-2-3-pending-work)
8. [How to Resume Work](#how-to-resume-work)
9. [Technical Decisions](#technical-decisions)
10. [Testing Strategy](#testing-strategy)
11. [Deployment Guide](#deployment-guide)
12. [Cost Analysis](#cost-analysis)
13. [References](#references)

---

## Executive Summary

ATLAS-KG v2 (Adaptive Topology & LLM-Augmented Structuring with Knowledge Graph) replaces the current document chunking approach with a **page-based extraction system** that preserves document structure, uses **progressive LLM summarization**, and builds a **cross-document knowledge graph**.

**Key Goals:**

- Preserve document structure (tables, headings, images)
- Enable context chaining between pages
- Add visual understanding (screenshots, charts)
- Build relationships between documents via knowledge graph

**Current Status (Week 1):**

- ✅ Docling extraction service: COMPLETE (7/8 tests passing)
- ✅ S3 storage infrastructure: COMPLETE
- ✅ MongoDB page storage: COMPLETE
- ✅ Worker integration code: COMPLETE (not yet wired to pipeline)
- ❌ Progressive summarization: PENDING
- ❌ Vision analysis: PENDING
- ❌ Knowledge graph: PENDING

---

## Problem Statement

### Current System Limitations

**1. Structure Loss:**

- Text-only chunking loses tables, images, charts
- No preservation of document hierarchy (headings, sections)
- Layout information discarded

**2. No Context Chaining:**

- Each chunk processed independently
- No carry-forward of context between pages
- Table/heading continuity lost across page boundaries

**3. Limited Visual Understanding:**

- No analysis of charts, diagrams, infographics
- No screenshot preservation
- Visual information completely ignored

**4. Weak Cross-Document Relationships:**

- No entity linking between documents
- No knowledge graph
- Search limited to keyword/vector similarity

### Impact

- **RAG Quality:** Lower answer accuracy due to missing context
- **User Experience:** Cannot answer questions about tables, charts, or complex layouts
- **Search Relevance:** Misses relationships between related documents

---

## Proposed Solution

### Core Approach

**Page-Based Chunking:**

- Each page = one chunk (no arbitrary splits)
- Preserves natural document structure
- Maintains layout fidelity

**Progressive Summarization:**

```
Page 1 → LLM → Summary₁
Page 2 + Summary₁ → LLM → Summary₂
Page 3 + Summary₂ → LLM → Summary₃
...
```

**Context Enrichment:**

- Detect table continuations across pages
- Propagate section headings
- Track section boundaries

**Visual Understanding:**

- Screenshot each page
- Vision API analysis (charts, diagrams)
- Store visual descriptions with text

**Knowledge Graph:**

- Extract entities per document
- Link entities across documents
- Contextual nodes (why entities are related)

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Ingestion Worker                         │
│  - Receives document upload                                  │
│  - Validates & stores in MongoDB (SearchDocument)            │
│  - Enqueues: QUEUE_EXTRACTION                               │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Extraction Worker                          │
│  - Stub worker (existing)                                    │
│  - Enqueues: QUEUE_DOCLING_EXTRACTION                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            Docling Extraction Worker (NEW)                   │
│  1. Download document from URL                               │
│  2. Call Docling Python service                              │
│  3. Extract: text, layout, tables, images                    │
│  4. Upload images/screenshots → S3                           │
│  5. Store pages → MongoDB (DocumentPage)                     │
│  6. Enqueue: QUEUE_PAGE_PROCESSING                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Page Processing Worker (TODO)                   │
│  1. Progressive summarization (LLM)                          │
│  2. Context chaining (previous page summary)                 │
│  3. Vision API analysis (screenshots)                        │
│  4. Business term extraction                                 │
│  5. Update DocumentPage with processed data                  │
│  6. Enqueue: QUEUE_CHUNK_GENERATION                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│           Chunk Generation Worker (TODO)                     │
│  1. Create SearchChunk from DocumentPage                     │
│  2. Generate embeddings                                      │
│  3. Generate page-level questions                            │
│  4. Store in MongoDB + Qdrant                                │
│  5. Enqueue: QUEUE_DOCUMENT_QUESTIONS                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│        Document Questions Worker (TODO)                      │
│  1. Generate document-level questions                        │
│  2. Create chunk relationships (question-based)              │
│  3. Store relationships                                      │
│  4. Enqueue: QUEUE_KG_EXTRACTION                            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│          Knowledge Graph Worker (TODO)                       │
│  1. Extract entities from document                           │
│  2. Link entities across documents                           │
│  3. Create contextual nodes (why related)                    │
│  4. Store in Neo4j                                           │
│  5. Update SearchDocument status: COMPLETE                   │
└─────────────────────────────────────────────────────────────┘
```

### Data Models

**DocumentPage (MongoDB):**

```typescript
{
  _id: string,
  tenantId: string,
  indexId: string,
  documentId: string,
  pageNumber: number,
  text: string,
  tokenCount: number,
  layout: {
    headings: Array<{level, text, bbox}>,
    structure: object
  },
  tables: Array<{
    rows: string[][],
    headers: string[],
    html: string,
    markdown: string,
    isComplete: boolean
  }>,
  images: Array<{
    s3Url: string,
    format: string,
    bbox: BoundingBox
  }>,
  screenshot: string | null, // S3 URL
  status: 'pending' | 'processed' | 'failed',
  processingMetadata: {
    summary: string,
    previousPageContext: string,
    visionAnalysis: object,
    businessTerms: string[]
  }
}
```

**SearchChunk (Enhanced):**

```typescript
{
  // Existing fields...
  pageNumber: number,
  documentPageId: string, // Reference to DocumentPage
  hasVisualContent: boolean,
  visionDescription: string | null,
  pageScreenshotUrl: string | null
}
```

### Infrastructure

**Services:**

- **docling-service** (Python FastAPI, port 8080): Document extraction
- **neo4j** (ports 7474, 7687): Knowledge graph
- **qdrant** (ports 6333, 6334): Vector embeddings
- **mongodb**: Page storage + metadata
- **s3**: Images, screenshots, artifacts

**Storage Paths:**

```
S3: {tenantId}/search-ai/{indexId}/{documentId}/page-{N}-{type}.{ext}
MongoDB: document_pages collection (tenant-isolated)
Neo4j: Document/Entity/Relationship nodes
Qdrant: Embeddings with page metadata
```

---

## Implementation Status

### ✅ Week 1: COMPLETE (Foundation)

**Completed Components:**

1. **Docling Python Service** ✅
   - FastAPI service on port 8080
   - Extract pages, tables, images, screenshots
   - Layout analysis with bounding boxes
   - Health check endpoint
   - Tests: 7/8 passing

2. **Shared S3 Storage Service** ✅
   - Multipart upload for large files
   - Server-side encryption (AES256/KMS)
   - Tenant-scoped paths
   - Reusable across platform
   - File: `packages/shared/src/services/s3-storage.ts`

3. **DocumentPage MongoDB Model** ✅
   - Schema with layout, tables, images
   - Tenant isolation plugin
   - Optimized indexes
   - File: `packages/database/src/models/document-page.model.ts`

4. **DoclingExtractionWorker** ✅
   - Downloads documents
   - Calls Docling service
   - Uploads to S3
   - Stores pages in MongoDB
   - File: `apps/search-ai/src/workers/docling-extraction-worker.ts`
   - **Status:** Built but NOT YET WIRED to pipeline

5. **Queue Infrastructure** ✅
   - Added `QUEUE_DOCLING_EXTRACTION`
   - Added `QUEUE_PAGE_PROCESSING`
   - Job data interfaces defined

6. **Docker Infrastructure** ✅
   - docling-service, neo4j, qdrant added
   - All services running

7. **Test Infrastructure** ✅
   - 31MB test datasets (5 PDFs)
   - Comprehensive pytest suite
   - Integration tests for worker

**Files Changed:**

- 29 files
- 4,915 lines added
- 24 new files, 5 modified

---

### ❌ Week 2-3: PENDING

#### 1. Wire DoclingExtractionWorker (15 minutes)

**File:** `apps/search-ai/src/workers/extraction-worker.ts`

**Change Needed:**

```typescript
// Around line 54-68, replace stub with:
import { QUEUE_DOCLING_EXTRACTION } from '@agent-platform/search-ai-sdk';
import { createQueue } from './shared.js';

const doclingQueue = createQueue(QUEUE_DOCLING_EXTRACTION);
await doclingQueue.add('docling-extraction', {
  indexId,
  documentId,
  sourceUrl: document.url, // Assumes document has URL
  tenantId,
});

// Update SearchDocument status
await SearchDocument.findByIdAndUpdate(documentId, {
  status: 'EXTRACTING',
});
```

**File:** `apps/search-ai/src/workers/index.ts`

**Change Needed:**

```typescript
import { doclingExtractionWorker } from './docling-extraction-worker.js';

export const workers = {
  ingestion: ingestionWorker,
  extraction: extractionWorker,
  doclingExtraction: doclingExtractionWorker, // ADD THIS
  // ... rest
};
```

---

#### 2. Page Processing Worker (1-2 days)

**File to Create:** `apps/search-ai/src/workers/page-processing-worker.ts`

**Requirements:**

**a. Progressive Summarization:**

```typescript
async function summarizePage(page: IDocumentPage, previousSummary: string | null): Promise<string> {
  const prompt = `
    Previous Context: ${previousSummary || 'None'}

    Current Page ${page.pageNumber}:
    ${page.text}

    Summarize key points in 2-3 sentences, maintaining context from previous pages.
  `;

  const summary = await llm.complete(prompt);
  return summary;
}
```

**b. Context Chaining:**

- Process pages in order
- Carry forward previous page summary
- Detect section boundaries
- Propagate parent headings

**c. Vision Analysis:**

```typescript
async function analyzeScreenshot(screenshotUrl: string, pageText: string): Promise<VisionAnalysis> {
  const prompt = `
    Page Text: ${pageText}

    Analyze this page screenshot. Describe:
    1. Charts/diagrams and their insights
    2. Visual elements not captured in text
    3. Layout significance
  `;

  const analysis = await visionAPI.analyze(screenshotUrl, prompt);
  return analysis;
}
```

**d. Business Term Extraction:**

```typescript
async function extractBusinessTerms(text: string): Promise<string[]> {
  const prompt = `Extract key business terms, metrics, and domain-specific concepts from: ${text}`;
  const terms = await llm.complete(prompt);
  return parseTerms(terms);
}
```

**e. Update DocumentPage:**

```typescript
await DocumentPage.findByIdAndUpdate(pageId, {
  status: 'processed',
  'processingMetadata.summary': summary,
  'processingMetadata.previousPageContext': previousSummary,
  'processingMetadata.visionAnalysis': visionAnalysis,
  'processingMetadata.businessTerms': businessTerms,
});
```

---

#### 3. Context Enrichment (1-2 days)

**Table Continuity Detection:**

```typescript
function detectTableContinuation(
  currentPage: IDocumentPage,
  previousPage: IDocumentPage | null,
): boolean {
  if (!previousPage) return false;

  // Check if last table in previous page is incomplete
  const lastTable = previousPage.tables[previousPage.tables.length - 1];
  if (!lastTable?.isComplete) {
    // Merge with first table of current page
    return true;
  }

  return false;
}
```

**Heading Propagation:**

```typescript
function propagateHeadings(
  currentPage: IDocumentPage,
  previousPage: IDocumentPage | null,
): string[] {
  const inheritedHeadings = [];

  if (previousPage) {
    // Inherit headings from previous page
    const lastHeading = previousPage.layout.headings[previousPage.layout.headings.length - 1];
    if (lastHeading && currentPage.layout.headings[0]?.level > lastHeading.level) {
      inheritedHeadings.push(lastHeading.text);
    }
  }

  return inheritedHeadings;
}
```

---

#### 4. Chunk Generation Worker (1 day)

**File to Create:** `apps/search-ai/src/workers/chunk-generation-worker.ts`

**Requirements:**

**a. Create SearchChunk from DocumentPage:**

```typescript
async function createChunkFromPage(page: IDocumentPage): Promise<ISearchChunk> {
  const chunk = await SearchChunk.create({
    tenantId: page.tenantId,
    indexId: page.indexId,
    documentId: page.documentId,
    sourceId: page.sourceId,
    pageNumber: page.pageNumber,
    documentPageId: page._id,
    text: page.text,
    summary: page.processingMetadata?.summary,
    hasVisualContent: page.images.length > 0 || page.screenshot !== null,
    visionDescription: page.processingMetadata?.visionAnalysis?.description,
    pageScreenshotUrl: page.screenshot,
    metadata: {
      tables: page.tables.length,
      images: page.images.length,
      headings: page.layout.headings.map((h) => h.text),
      businessTerms: page.processingMetadata?.businessTerms,
    },
  });

  return chunk;
}
```

**b. Generate Page-Level Questions:**

```typescript
async function generatePageQuestions(page: IDocumentPage): Promise<string[]> {
  const prompt = `
    Based on this page content, generate 3-5 questions that this page can answer:

    ${page.text}

    Tables: ${page.tables.length}
    Images: ${page.images.length}

    Return only the questions, one per line.
  `;

  const questions = await llm.complete(prompt);
  return questions.split('\n').filter((q) => q.trim());
}
```

**c. Generate Embeddings:**

```typescript
async function generateEmbeddings(chunk: ISearchChunk): Promise<void> {
  const embeddingText = `
    ${chunk.text}

    Summary: ${chunk.summary}
    ${chunk.visionDescription ? `Visual: ${chunk.visionDescription}` : ''}
  `;

  const embedding = await embeddingModel.embed(embeddingText);

  await qdrant.upsert({
    collection: `index-${chunk.indexId}`,
    points: [
      {
        id: chunk._id,
        vector: embedding,
        payload: {
          pageNumber: chunk.pageNumber,
          documentId: chunk.documentId,
          hasVisualContent: chunk.hasVisualContent,
        },
      },
    ],
  });
}
```

---

#### 5. Document Questions Worker (1-2 days)

**File to Create:** `apps/search-ai/src/workers/document-questions-worker.ts`

**Requirements:**

**a. Generate Document-Level Questions:**

```typescript
async function generateDocumentQuestions(documentId: string): Promise<string[]> {
  // Get all pages for document
  const pages = await DocumentPage.find({ documentId }).sort({ pageNumber: 1 });

  // Combine all summaries
  const documentSummary = pages.map((p) => p.processingMetadata?.summary).join('\n\n');

  const prompt = `
    Based on this document (${pages.length} pages), generate 5-10 high-level questions
    that can be answered by reading the entire document:

    ${documentSummary}

    Focus on:
    - Overall themes and conclusions
    - Cross-page relationships
    - Document purpose and takeaways
  `;

  const questions = await llm.complete(prompt);
  return parseQuestions(questions);
}
```

**b. Create Chunk Relationships:**

```typescript
async function createChunkRelationships(documentId: string): Promise<void> {
  // Get all chunks for document
  const chunks = await SearchChunk.find({ documentId });

  // For each pair of chunks, find similar questions
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      const similarity = await compareQuestions(
        chunks[i].metadata.questions,
        chunks[j].metadata.questions,
      );

      if (similarity > 0.7) {
        await ChunkRelationship.create({
          tenantId: chunks[i].tenantId,
          sourceChunkId: chunks[i]._id,
          targetChunkId: chunks[j]._id,
          relationshipType: 'similar_questions',
          strength: similarity,
        });
      }
    }
  }
}
```

---

#### 6. Knowledge Graph Worker (3-4 days)

**File to Create:** `apps/search-ai/src/workers/knowledge-graph-worker.ts`

**Requirements:**

**a. Extract Entities:**

```typescript
async function extractEntities(document: ISearchDocument): Promise<Entity[]> {
  const pages = await DocumentPage.find({ documentId: document._id });
  const fullText = pages.map((p) => p.text).join('\n\n');

  const prompt = `
    Extract key entities from this document:

    ${fullText}

    Return entities in JSON format:
    [
      {"name": "Entity Name", "type": "PERSON|ORG|CONCEPT|METRIC", "context": "brief description"}
    ]
  `;

  const entities = await llm.complete(prompt);
  return JSON.parse(entities);
}
```

**b. Link Entities Across Documents:**

```typescript
async function linkEntitiesAcrossDocuments(tenantId: string, indexId: string): Promise<void> {
  // Get all documents in index
  const documents = await SearchDocument.find({ tenantId, indexId });

  // Extract entities for each document
  const documentEntities = new Map();
  for (const doc of documents) {
    const entities = await extractEntities(doc);
    documentEntities.set(doc._id, entities);
  }

  // Find common entities across documents
  const entityIndex = new Map<string, Set<string>>(); // entity name -> document IDs

  for (const [docId, entities] of documentEntities) {
    for (const entity of entities) {
      if (!entityIndex.has(entity.name)) {
        entityIndex.set(entity.name, new Set());
      }
      entityIndex.get(entity.name)!.add(docId);
    }
  }

  // Create relationships for entities appearing in multiple documents
  for (const [entityName, docIds] of entityIndex) {
    if (docIds.size > 1) {
      await createEntityRelationships(entityName, Array.from(docIds));
    }
  }
}
```

**c. Create Neo4j Graph:**

```typescript
async function createNeo4jGraph(tenantId: string, indexId: string): Promise<void> {
  const session = neo4jDriver.session();

  try {
    // Create document nodes
    const documents = await SearchDocument.find({ tenantId, indexId });
    for (const doc of documents) {
      await session.run(
        `
        CREATE (d:Document {
          id: $id,
          tenantId: $tenantId,
          indexId: $indexId,
          title: $title,
          url: $url
        })
      `,
        {
          id: doc._id.toString(),
          tenantId: doc.tenantId,
          indexId: doc.indexId,
          title: doc.title,
          url: doc.url,
        },
      );

      // Create entity nodes and relationships
      const entities = await extractEntities(doc);
      for (const entity of entities) {
        await session.run(
          `
          MERGE (e:Entity {name: $name, type: $type})
          WITH e
          MATCH (d:Document {id: $docId})
          CREATE (d)-[:MENTIONS {context: $context}]->(e)
        `,
          {
            name: entity.name,
            type: entity.type,
            docId: doc._id.toString(),
            context: entity.context,
          },
        );
      }
    }
  } finally {
    await session.close();
  }
}
```

**d. Contextual Relationships:**

```typescript
async function createContextualRelationships(
  entity1: string,
  entity2: string,
  documents: string[],
): Promise<void> {
  // Find why these entities are related
  const pages = await DocumentPage.find({
    documentId: { $in: documents },
  });

  const contexts = pages
    .filter((p) => p.text.includes(entity1) && p.text.includes(entity2))
    .map((p) => ({
      documentId: p.documentId,
      pageNumber: p.pageNumber,
      snippet: extractSnippet(p.text, [entity1, entity2]),
    }));

  const session = neo4jDriver.session();
  try {
    await session.run(
      `
      MATCH (e1:Entity {name: $entity1})
      MATCH (e2:Entity {name: $entity2})
      CREATE (e1)-[:RELATED_TO {
        contexts: $contexts,
        strength: $strength
      }]->(e2)
    `,
      {
        entity1,
        entity2,
        contexts: JSON.stringify(contexts),
        strength: contexts.length / documents.length,
      },
    );
  } finally {
    await session.close();
  }
}
```

---

## How to Resume Work

### Quick Start (Next Session)

**1. Review This RFC** (5 minutes)

```bash
# Read this file
cat docs/rfcs/RFC-001-ATLAS-KG-v2-Document-Extraction.md
```

**2. Check Current Status** (2 minutes)

```bash
# Check if services are running
docker-compose ps

# Start services if needed
docker-compose up -d docling-service neo4j qdrant

# Test Docling service
curl http://localhost:8080/health
```

**3. Run Tests** (2 minutes)

```bash
cd services/docling-service
pytest test_suite.py -v
```

**4. Pick Next Task** (see Pending Work section)

---

### Development Environment Setup

**Prerequisites:**

- Docker Desktop or Colima
- Node.js 18+
- Python 3.11+
- pnpm

**Setup Commands:**

```bash
# 1. Clone repo (if fresh start)
git clone <repo-url>
cd abl-platform

# 2. Install dependencies
pnpm install

# 3. Start services
docker-compose up -d

# 4. Verify services
docker-compose ps

# 5. Check Docling service
curl http://localhost:8080/health

# 6. Run tests
cd services/docling-service
pytest test_suite.py -v
```

---

### Next Immediate Task

**Task:** Wire DoclingExtractionWorker into Pipeline (15 minutes)

**Files to Modify:**

1. `apps/search-ai/src/workers/extraction-worker.ts`
2. `apps/search-ai/src/workers/index.ts`

**Steps:**

1. Open `apps/search-ai/src/workers/extraction-worker.ts`
2. Find the stub extraction logic (around line 54-68)
3. Replace with Docling queue enqueue (see Week 2-3 section)
4. Open `apps/search-ai/src/workers/index.ts`
5. Import and export `doclingExtractionWorker`
6. Test: Upload a PDF and verify it flows through to Docling

**Testing:**

```bash
# Start workers
cd apps/search-ai
pnpm run workers

# Upload a PDF via API/Studio UI
# Check logs:
docker-compose logs -f search-ai

# Verify DocumentPage created:
# (Use MongoDB client to check document_pages collection)
```

---

## Technical Decisions

### Why Page-Based Chunking?

**Alternatives Considered:**

1. **Token-based chunking** (current) - Loses structure
2. **Section-based chunking** - Inconsistent across document types
3. **Hybrid approach** - Too complex

**Decision:** Page-based chunking

- Natural boundary for documents
- Preserves layout and structure
- Consistent unit size
- Easy to reference ("page 5")

### Why Docling?

**Alternatives Considered:**

1. **PyPDF2 / pdfplumber** - Limited layout analysis
2. **Apache Tika** - No table structure
3. **AWS Textract** - Expensive ($1.50 per 1000 pages)
4. **Azure Document Intelligence** - Vendor lock-in

**Decision:** IBM Docling

- Open source (free)
- Excellent table detection
- Layout analysis with bounding boxes
- Active development
- Self-hosted (no API costs)

### Why Progressive Summarization?

**Alternatives Considered:**

1. **Map-reduce** - Doesn't preserve context flow
2. **Hierarchical summarization** - Too complex
3. **No summarization** - Context window overflow

**Decision:** Progressive (chain-of-thought)

- Maintains narrative flow
- Preserves context across pages
- Scalable (linear, not exponential)
- Works with any LLM

### Why Neo4j for Knowledge Graph?

**Alternatives Considered:**

1. **MongoDB with references** - Poor graph queries
2. **PostgreSQL with graph extension** - Limited
3. **Custom graph in Redis** - Reinventing wheel

**Decision:** Neo4j

- Purpose-built for graphs
- Cypher query language
- Scalable graph algorithms
- Industry standard

---

## Testing Strategy

### Test Pyramid

**Unit Tests:**

- Docling service functions
- S3 upload helpers
- MongoDB model validations
- Worker job processing

**Integration Tests:**

- End-to-end document flow
- Worker communication
- S3 + MongoDB integration
- Neo4j graph operations

**Load Tests:**

- 1000 concurrent document uploads
- Large documents (1000+ pages)
- High-frequency queries

### Test Datasets

**Located:** `test_data/docling/` (31MB, committed)

**Files:**

- `simple_text_pdf.pdf` (13KB) - Basic extraction
- `research_paper.pdf` (2.1MB) - Tables + images
- `bert_paper.pdf` (757KB) - Multi-page
- `gpt3_paper.pdf` (6.5MB) - Complex layout
- `pdf_spec.pdf` (21MB) - Large (755 pages)

**Coverage:**

- Simple text extraction ✅
- Table detection ⚠️ (needs tuning)
- Image extraction ✅
- Screenshot rendering ✅
- Performance ✅
- Error handling ✅

---

## Deployment Guide

### Environment Variables

**Required:**

```bash
# Docling Service
DOCLING_SERVICE_URL=http://localhost:8080

# S3 Configuration
S3_BUCKET=abl-platform-documents
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>

# Optional: KMS Encryption
S3_ENCRYPTION=aws:kms
S3_KMS_KEY_ID=<kms-key-id>

# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<password>

# Qdrant
QDRANT_URL=http://localhost:6333
```

### Docker Deployment

**Development:**

```bash
docker-compose up -d
```

**Production (Kubernetes):**

```yaml
# Helm values
doclingService:
  replicas: 3
  resources:
    requests:
      cpu: 2
      memory: 4Gi
    limits:
      cpu: 4
      memory: 8Gi

neo4j:
  replicas: 3
  storage: 100Gi

qdrant:
  replicas: 3
  storage: 500Gi
```

### Health Checks

**Docling Service:**

```bash
curl http://localhost:8080/health
# Expected: {"status":"healthy","docling_available":true}
```

**Neo4j:**

```bash
echo "RETURN 1" | cypher-shell -u neo4j -p password
```

**Qdrant:**

```bash
curl http://localhost:6333/
```

---

## Cost Analysis

### Current Implementation (Week 1)

**Infrastructure:**

- Docling service: Self-hosted (ECS Fargate ~$30/month)
- S3 storage: $0.023/GB/month
- S3 requests: $0.0004 per 1K PUTs

**Example (100-page document):**

- Images: 50 × 100KB = 5MB
- Screenshots: 100 × 500KB = 50MB
- Storage: 55MB = $0.0013/month
- Uploads: 150 PUTs = $0.0006
- **Total: ~$0.002/document**

### Future Costs (LLM Processing)

**Per Page:**

- Progressive summarization: $0.01-0.02 (GPT-4o-mini)
- Vision analysis: $0.01 (GPT-4V)
- Business term extraction: $0.005 (GPT-4o-mini)
- **Total: ~$0.025-0.035/page**

**Per Document (100 pages):**

- Page processing: $2.50-3.50
- Document questions: $0.10
- Entity extraction: $0.50
- **Total: ~$3.10-4.10/document**

**Monthly (1000 documents):**

- Processing: $3,100-4,100
- Storage: $50
- Infrastructure: $100
- **Total: ~$3,250-4,250/month**

### Cost Optimization

**Batch Processing:**

- Process documents overnight
- Batch LLM calls (10 pages per request)
- Save ~30% on LLM costs

**Caching:**

- Cache vision analysis for similar images
- Cache entity extractions
- Save ~20% on repeat processing

**Model Selection:**

- Use GPT-4o-mini for summarization ($0.01/page)
- Use Claude Haiku for entity extraction ($0.005/page)
- Save ~40% vs GPT-4

**Optimized: ~$2,000/month for 1000 documents**

---

## References

### Documentation

- [Docling Service README](../../../services/docling-service/README.md)
- [S3 Storage Service](../../../packages/shared/src/services/s3-storage.ts)
- [DocumentPage Model](../../../packages/database/src/models/document-page.model.ts)
- [Integration Status](../../../INTEGRATION_STATUS.md)
- [Quick Start Guide](../../../QUICK_START.md)

### External Resources

- [IBM Docling GitHub](https://github.com/DS4SD/docling)
- [Neo4j Graph Data Science](https://neo4j.com/docs/graph-data-science/)
- [Qdrant Documentation](https://qdrant.tech/documentation/)

### Related RFCs

- RFC-002: Search AI Architecture (if exists)
- RFC-003: Vector Search Strategy (if exists)

---

## Appendix A: Worker Job Data Schemas

**DoclingExtractionJobData:**

```typescript
{
  indexId: string,
  documentId: string,
  sourceUrl: string,
  tenantId: string
}
```

**PageProcessingJobData:**

```typescript
{
  indexId: string,
  documentId: string,
  tenantId: string,
  pageIds: string[],
  previousPageSummary: string | null
}
```

**ChunkGenerationJobData:**

```typescript
{
  indexId: string,
  documentId: string,
  tenantId: string,
  pageIds: string[]
}
```

**KnowledgeGraphJobData:**

```typescript
{
  indexId: string,
  tenantId: string,
  documentIds: string[]
}
```

---

## Appendix B: API Endpoints

**Docling Service:**

- `POST /extract` - Extract document
- `GET /health` - Health check

**Query Examples:**

```bash
# Extract PDF
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F "options={\"extractImages\":true,\"extractTables\":true}"

# Response:
{
  "pages": [...],
  "metadata": {...},
  "structure": {...}
}
```

---

## Appendix C: Troubleshooting

**Service Won't Start:**

```bash
# Check logs
docker-compose logs docling-service

# Rebuild
docker-compose build --no-cache docling-service
docker-compose up -d docling-service
```

**Tests Failing:**

```bash
# Check datasets
ls -lh test_data/docling/

# Re-run specific test
pytest test_suite.py::test_extract_simple_pdf -v
```

**Worker Not Processing:**

```bash
# Check queue
redis-cli -c "LLEN search:docling-extraction"

# Check worker logs
docker-compose logs -f search-ai
```

---

**END OF RFC**

---

**Status Summary:**

- Week 1: ✅ COMPLETE (foundation built, tested, ready to commit)
- Week 2-3: ❌ PENDING (6 major components to build)
- Estimated Time: 2-3 weeks to complete
- Next Task: Wire DoclingExtractionWorker (15 minutes)

**To Resume:** Read "How to Resume Work" section above.
