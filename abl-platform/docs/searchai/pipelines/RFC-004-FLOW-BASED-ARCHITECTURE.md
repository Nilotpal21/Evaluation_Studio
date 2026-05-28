# RFC-004: Flow-Based Pipeline Architecture

**Status:** Draft
**Created:** 2026-03-06
**Authors:** System Architecture Team
**Related RFCs:** RFC-005 (Job Tracking Architecture), RFC-006 (BullMQ Flows Integration)
**Supersedes:** RFC-004-Pluggable-Pipelines-Requirements.md, RFC-004-Pluggable-Pipelines-Design.md

---

## Executive Summary

This document defines the **flow-based pipeline architecture** for SearchAI pluggable pipelines, enabling users to configure multiple document processing flows within a single pipeline based on MIME type, connector, and metadata conditions.

**Key Innovation:** One pipeline contains multiple flows that converge to a common chunks store, enabling:

- ✅ Different extraction methods per document type (PDF → Docling, HTML → LlamaIndex)
- ✅ Per-flow customization with shared stage inheritance
- ✅ Chunks as restart point for manual triggers (skip re-extraction)
- ✅ Sequential document processing with priority-based flow selection
- ✅ Cost optimization (disable expensive stages per flow)

**Architecture:**

```
Knowledge Base → ONE Pipeline Definition
├─ Flow 1: PDF via Docling (priority: 40)
├─ Flow 2: HTML via LlamaIndex (priority: 30)
├─ Flow 3: Docx via Custom API (priority: 20)
└─ Flow 4: SharePoint Custom (priority: 10)

Document arrives → Router selects flow → Execute → Chunks → Shared Stages → Vector Store
```

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Flow-Based Architecture Model](#flow-based-architecture-model)
3. [Flow Selection Algorithm](#flow-selection-algorithm)
4. [Chunks as Convergence Point](#chunks-as-convergence-point)
5. [Per-Flow Customization](#per-flow-customization)
6. [Shared Stages (Inheritance Model)](#shared-stages-inheritance-model)
7. [Manual Triggers (3 Entry Points)](#manual-triggers-3-entry-points)
8. [Execution Model](#execution-model)
9. [Live Monitoring](#live-monitoring)
10. [Real-World Examples](#real-world-examples)
11. [Data Models](#data-models)
12. [Default Flows](#default-flows)
13. [Provider System](#provider-system)
14. [Pipeline Validation](#pipeline-validation)
15. [Job Tracking Integration](#job-tracking-integration)
16. [Implementation Guide](#implementation-guide)
17. [Non-Functional Requirements](#non-functional-requirements)
18. [Constraints](#constraints)
19. [Success Criteria](#success-criteria)
20. [Migration Path](#migration-path)

---

## Problem Statement

### Current Limitations (Pre-Flow Architecture)

**1. One-Size-Fits-All Pipeline**

Current design: All documents flow through the same pipeline regardless of type.

```
Document (any type) → Fixed 17-stage pipeline → Vector Store
```

**Problems:**

- PDF documents use same extraction as HTML (inefficient)
- Cannot route medical PDFs to specialized HIPAA-compliant processing
- No way to use LlamaIndex for HTML while using Docling for PDFs
- All documents get same enrichment (waste resources on simple text files)

**2. No Conditional Routing**

Users cannot configure:

- "Use Docling for PDFs from Confluence, but custom API for PDFs from SharePoint"
- "Route large PDFs (>10MB) to different extraction with higher timeout"
- "Skip OCR for digital PDFs, enable for scanned documents"

**3. All-or-Nothing Enrichment**

Current: Enrichment is global (all documents or none).

Users need:

- Medical documents: Custom medical entity extraction
- Financial documents: Standard LLM enrichment
- Simple text files: No enrichment (save cost)

**4. No Restart Points**

Current: Re-extraction requires fetching from source and full pipeline re-run.

Users need:

- Re-enrich with new LLM model WITHOUT re-extracting (save time/cost)
- Re-embed with new model WITHOUT re-enriching (even faster)
- Chunks as checkpoint for incremental updates

### User Stories Requiring Flow-Based Architecture

**Story 1: Medical + Financial Documents**

> "As a healthcare/finance company, I need medical PDFs to go through HIPAA-compliant entity extraction, while financial PDFs use standard enrichment. Both document types are in the same knowledge base."

**Current:** Impossible. All documents use same enrichment.
**With Flows:** Medical flow → HIPAA enrichment, Financial flow → Standard enrichment.

**Story 2: Multi-Format Content Platform**

> "As a content platform, I have PDFs (use Docling), HTML (use LlamaIndex), Docx (use custom API), and Markdown (use simple parser). Each format needs different extraction."

**Current:** Forced to use one extractor for all, or create separate indexes.
**With Flows:** 4 flows in one pipeline, each with appropriate extractor.

**Story 3: Cost Optimization**

> "As a small business, I want to skip enrichment on simple text files to save LLM costs, but enable full enrichment on complex PDFs."

**Current:** All documents enriched or none.
**With Flows:** Simple text flow → skip enrichment, PDF flow → full enrichment.

**Story 4: Conditional OCR**

> "As a document processor, I want to run OCR only on scanned PDFs (low extraction confidence), not on digital PDFs. OCR is expensive and slow."

**Current:** OCR runs on all PDFs or none.
**With Flows:** PDF flow with conditional stage: `if (output.confidence < 0.8) → run OCR`.

---

## Flow-Based Architecture Model

### Conceptual Overview

**One Pipeline, Multiple Flows:**

```
┌─────────────────────────────────────────────────────────────────┐
│ Knowledge Base: Medical Records                                  │
│ Pipeline: Medical Documents Processing                           │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Flow 1: PDF via Docling (Priority: 40)                      │ │
│ │ Selection: fileType === 'pdf'                                │ │
│ │ Stages: Docling → Chunking                                   │ │
│ │ Enrichment: Using shared                                     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Flow 2: HTML via LlamaIndex (Priority: 30)                  │ │
│ │ Selection: fileType === 'html'                               │ │
│ │ Stages: LlamaIndex → Markdown Chunking                       │ │
│ │ Enrichment: Using shared                                     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Flow 3: Docx via Custom API (Priority: 20)                  │ │
│ │ Selection: fileType === 'docx'                               │ │
│ │ Stages: Custom API → Docling → LLM → Chunking               │ │
│ │ Enrichment: Custom (Medical Entity Extractor)                │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Flow 4: SharePoint Custom (Priority: 10)                    │ │
│ │ Selection: sourceType === 'sharepoint'                       │ │
│ │ Stages: Docling → Condition → Chunking                       │ │
│ │ Enrichment: Custom Script                                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│ Shared Stages (inherited by all flows):                          │
│ ├─ Enrichment: LLM GPT-4 Entity Extraction                      │
│ └─ Indexing: BGE-M3 Embeddings (1024-dim)                       │
└─────────────────────────────────────────────────────────────────┘
```

### Document Processing Flow

```
┌──────────────────┐
│ Document Arrives │
│ medical-002.pdf  │
└────────┬─────────┘
         │
         ↓
┌──────────────────────────────────────────────┐
│ Pipeline Router                               │
│ - Load pipeline for knowledge base            │
│ - Evaluate flow selection rules (priority)    │
│ - First match wins                            │
└────────┬─────────────────────────────────────┘
         │
         ↓ MATCH: Flow 1 (fileType === 'pdf')
         │
┌────────▼─────────────────────────────────────┐
│ Execute Flow 1 Stages                         │
│ 1. Docling Extraction    (2 min)             │
│ 2. Chunking              (30 sec)            │
└────────┬─────────────────────────────────────┘
         │
         ↓
┌────────▼─────────────────────────────────────┐
│ Chunks Store (MongoDB)                        │
│ - 45 chunks created                           │
│ - flowId: "flow-pdf-docling"                  │
│ - Common ISearchChunk schema                  │
└────────┬─────────────────────────────────────┘
         │
         ↓
┌────────▼─────────────────────────────────────┐
│ Execute Shared Enrichment                     │
│ (flow.customEnrichment || pipeline.shared)    │
│ - LLM GPT-4 Entity Extraction (1 min)        │
└────────┬─────────────────────────────────────┘
         │
         ↓
┌────────▼─────────────────────────────────────┐
│ Execute Shared Indexing                       │
│ - BGE-M3 Embedding Generation (45 sec)       │
└────────┬─────────────────────────────────────┘
         │
         ↓
┌────────▼─────────────────────────────────────┐
│ Vector Store (OpenSearch)                     │
│ - Document searchable ✅                      │
│ - Total time: ~4.5 minutes                    │
└───────────────────────────────────────────────┘
```

### Key Principles

**1. One Pipeline Per Knowledge Base**

- Each knowledge base has ONE pipeline definition
- Pipeline contains multiple flows
- NOT per-index, NOT per-document

**2. Priority-Based Flow Selection**

- Flows evaluated in priority order (highest first)
- First matching flow is selected
- Selection rules use document metadata (fileType, sourceType, metadata.\*)

**3. Chunks as Convergence Point**

- All flows produce chunks with common ISearchChunk schema
- Chunks stored in MongoDB (persistent checkpoint)
- Post-chunk stages (enrichment, indexing) shared or per-flow

**4. Sequential Processing**

- Documents processed one by one
- Each document finds its flow, executes sequentially
- Multiple KBs in project CAN process in parallel

**5. Shared Stage Inheritance**

- Pipeline defines shared enrichment/indexing
- Flows inherit by default (DRY principle)
- Flows can override with custom logic

---

## Flow Selection Algorithm

### Algorithm Overview

**Input:** Document metadata (`fileType`, `sourceType`, `metadata`, etc.)
**Output:** Selected `PipelineFlow`
**Method:** Priority-based rule evaluation with CEL expressions

### Pseudocode

```typescript
function selectFlow(pipeline: PipelineDefinition, document: SearchDocument): PipelineFlow {
  // 1. Get all enabled flows
  const enabledFlows = pipeline.flows.filter((f) => f.enabled);

  // 2. Sort by priority (highest first)
  const sortedFlows = enabledFlows.sort((a, b) => b.priority - a.priority);

  // 3. Evaluate selection rules in priority order
  for (const flow of sortedFlows) {
    if (evaluateSelectionRules(flow.selectionRules, document)) {
      return flow; // First match wins
    }
  }

  // 4. No match - throw error (should not happen if default flow exists)
  throw new Error(`No matching flow found for document ${document._id}`);
}

function evaluateSelectionRules(rules: RuleCondition[], document: SearchDocument): boolean {
  if (!rules || rules.length === 0) {
    return false; // No rules = no match
  }

  // Evaluate all rules with AND logic (all must pass)
  for (const rule of rules) {
    if (!evaluateRule(rule, document)) {
      return false;
    }
  }

  return true; // All rules passed
}

function evaluateRule(rule: RuleCondition, document: SearchDocument): boolean {
  const context = {
    doc: {
      fileType: document.fileType,
      fileName: document.fileName,
      fileSize: document.fileSize,
      sourceType: document.sourceType,
      metadata: document.metadata,
    },
  };

  switch (rule.type) {
    case 'simple':
      return evaluateSimpleCondition(rule, context);
    case 'compound':
      return evaluateCompoundCondition(rule, context);
    case 'cel':
      return evaluateCelExpression(rule.celExpression, context);
    default:
      return false;
  }
}
```

### Selection Rule Examples

**Example 1: Simple MIME Type Match**

```json
{
  "flow": {
    "name": "PDF via Docling",
    "priority": 40,
    "selectionRules": [
      {
        "type": "simple",
        "field": "doc.fileType",
        "operator": "eq",
        "value": "pdf"
      }
    ]
  }
}
```

**Matches:** Any PDF document

**Example 2: Compound Condition (AND)**

```json
{
  "flow": {
    "name": "Large PDFs with OCR",
    "priority": 50,
    "selectionRules": [
      {
        "type": "compound",
        "logic": "AND",
        "conditions": [
          {
            "type": "simple",
            "field": "doc.fileType",
            "operator": "eq",
            "value": "pdf"
          },
          {
            "type": "simple",
            "field": "doc.fileSize",
            "operator": "gt",
            "value": 10000000
          }
        ]
      }
    ]
  }
}
```

**Matches:** PDFs larger than 10MB

**Example 3: CEL Expression (Complex Logic)**

```json
{
  "flow": {
    "name": "Medical Documents",
    "priority": 60,
    "selectionRules": [
      {
        "type": "cel",
        "celExpression": "doc.fileType == 'pdf' && (doc.metadata.category == 'medical' || abl.upper(doc.fileName).contains('HIPAA'))"
      }
    ]
  }
}
```

**Matches:** PDFs with medical category OR filename containing "HIPAA"

**Example 4: SharePoint Override (Highest Priority)**

```json
{
  "flow": {
    "name": "SharePoint Custom",
    "priority": 70,
    "selectionRules": [
      {
        "type": "simple",
        "field": "doc.sourceType",
        "operator": "eq",
        "value": "sharepoint"
      }
    ]
  }
}
```

**Matches:** All SharePoint documents (evaluated before other flows due to priority 70)

### Priority Evaluation Example

**Scenario:** medical-report.pdf from SharePoint

**Pipeline Flows:**

1. Flow 1: PDF via Docling (priority: 40) - Rule: `fileType === 'pdf'`
2. Flow 2: SharePoint Custom (priority: 70) - Rule: `sourceType === 'sharepoint'`
3. Flow 3: Medical Documents (priority: 60) - Rule: `fileType === 'pdf' && metadata.category === 'medical'`

**Evaluation Order:**

```
1. Evaluate Flow 2 (priority 70): sourceType === 'sharepoint' ✅ MATCH
   → Flow 2 selected, stop evaluation

Result: Document routed to SharePoint Custom flow
```

**Key Point:** Higher priority wins. Even though document matches all 3 flows, Flow 2 selected because it has highest priority.

### Default Flow Pattern

**Recommendation:** Always have a catch-all default flow with priority 1.

```json
{
  "flow": {
    "name": "Default (Fallback)",
    "priority": 1,
    "selectionRules": [
      {
        "type": "cel",
        "celExpression": "true"
      }
    ]
  }
}
```

This ensures every document matches at least one flow.

---

## Chunks as Convergence Point

### Why Chunks?

**Problem:** Different extraction methods produce different intermediate formats.

- Docling: Page-based extraction with images
- LlamaIndex: Node-based extraction with metadata
- Custom API: Proprietary format

**Solution:** All flows converge to common **ISearchChunk** schema.

### Chunk Schema (Extended)

```typescript
export interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;

  // Content
  content: string; // Extracted text
  tokenCount: number;
  chunkIndex: number; // Position in document

  // Vector store
  vectorId: string | null;

  // Metadata
  metadata: any | null; // Raw source metadata
  canonicalMetadata: Record<string, unknown> | null; // Mapped fields

  // Knowledge Graph
  classification?: IChunkClassification;

  // Status
  status: string; // 'pending' | 'enriched' | 'indexed'

  // NEW: Flow tracking
  flowId?: string; // Which flow created this chunk
  enrichmentFlowId?: string; // Which enrichment was applied

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  _v: number;
}
```

### Convergence Visualization

```
┌────────────────────┐
│ Flow 1: PDF        │ → Docling → Chunking → ┐
└────────────────────┘                         │
                                               │
┌────────────────────┐                         │
│ Flow 2: HTML       │ → LlamaIndex → Chunking →┼→ ┌──────────────────┐
└────────────────────┘                         │  │ Chunks Store     │
                                               │  │ (Common Schema)  │
┌────────────────────┐                         │  │ MongoDB          │
│ Flow 3: Docx       │ → Custom API → Chunking →┘  └────────┬─────────┘
└────────────────────┘                                       │
                                                             ↓
                                              ┌──────────────────────────┐
                                              │ Shared Enrichment        │
                                              │ (or per-flow custom)     │
                                              └────────┬─────────────────┘
                                                       ↓
                                              ┌──────────────────────────┐
                                              │ Shared Indexing          │
                                              │ (or per-flow custom)     │
                                              └────────┬─────────────────┘
                                                       ↓
                                              ┌──────────────────────────┐
                                              │ Vector Store (OpenSearch)│
                                              └──────────────────────────┘
```

### Chunks as Restart Point

**Key Benefit:** Chunks persist in MongoDB, enabling manual triggers without re-extraction.

**Use Cases:**

**1. Re-enrichment (Skip Extraction)**

```
Load Chunks → New Enrichment → Re-index
Time saved: ~2 minutes per document (no extraction)
Cost saved: No source fetch, no extraction compute
```

**2. Re-indexing (Skip Extraction + Enrichment)**

```
Load Chunks → Re-embed → Re-index
Time saved: ~3 minutes per document
Cost saved: No extraction, no LLM calls
```

**3. Incremental Updates**

```
New enrichment stage added → Re-enrich all chunks → Keep existing embeddings
```

### Flow Tracking

**Purpose:** Track which flow created each chunk for debugging and manual triggers.

**Example Query:**

```typescript
// Get all chunks created by PDF flow
const chunks = await SearchChunk.find({
  tenantId: 'tenant-123',
  knowledgeBaseId: 'kb-456',
  flowId: 'flow-pdf-docling',
});

// Re-enrich only PDF flow chunks
for (const chunk of chunks) {
  await enrichmentQueue.add({
    chunkId: chunk._id,
    enrichmentConfig: pdfFlow.customEnrichment || pipeline.sharedEnrichment,
  });
}
```

---

## Per-Flow Customization

### Customization Dimensions

**1. Extraction Provider**

Each flow can use different extraction method:

- Flow 1: Docling (for PDFs)
- Flow 2: LlamaIndex (for HTML)
- Flow 3: Custom HTTP API (for proprietary formats)

**2. Chunking Strategy**

Each flow can use different chunking:

- Flow 1: Token-based (512 tokens)
- Flow 2: Markdown-aware (preserve structure)
- Flow 3: Paragraph-based (semantic chunks)

**3. Conditional Stages**

Each flow can have conditional logic:

```json
{
  "stage": {
    "id": "ocr-1",
    "type": "ocr",
    "executionCondition": {
      "type": "cel",
      "celExpression": "output.confidence < 0.8"
    }
  }
}
```

**4. Enrichment Override**

Each flow can override shared enrichment:

- Flow 1: Use shared (standard LLM entities)
- Flow 3: Custom medical entity extractor (HIPAA-compliant)
- Flow 4: Custom script (domain-specific logic)

**5. Indexing Override**

Each flow can override shared indexing:

- Flow 1: Use shared (BGE-M3 embeddings)
- Flow 2: Custom OpenAI embeddings (better for HTML)

### Flow Configuration Example

```typescript
const pipelineDefinition: PipelineDefinition = {
  _id: 'pipeline-123',
  tenantId: 'tenant-456',
  knowledgeBaseId: 'kb-789',
  name: 'Medical Documents Processing',

  flows: [
    {
      id: 'flow-pdf-docling',
      name: 'PDF via Docling',
      priority: 40,
      enabled: true,

      // Selection: fileType === 'pdf'
      selectionRules: [
        {
          type: 'simple',
          field: 'doc.fileType',
          operator: 'eq',
          value: 'pdf',
        },
      ],

      // Flow-specific stages (extraction → chunking)
      stages: [
        {
          id: 'extract-pdf',
          name: 'Docling Extraction',
          type: 'docling_extraction',
          provider: 'docling',
          providerConfig: {
            extractImages: true,
            extractTables: true,
          },
          lockDuration: 600000, // 10 min
        },
        {
          id: 'chunk-pdf',
          name: 'Token-based Chunking',
          type: 'chunking',
          provider: 'token-based',
          providerConfig: {
            chunkSize: 512,
            chunkOverlap: 50,
          },
        },
      ],

      // Use shared enrichment and indexing (no overrides)
      customEnrichment: undefined,
      customIndexing: undefined,
    },

    {
      id: 'flow-docx-custom',
      name: 'Docx via Custom API',
      priority: 20,
      enabled: true,

      selectionRules: [
        {
          type: 'simple',
          field: 'doc.fileType',
          operator: 'eq',
          value: 'docx',
        },
      ],

      stages: [
        {
          id: 'extract-docx',
          name: 'Custom API Extraction',
          type: 'custom_http',
          provider: 'http',
          providerConfig: {
            url: 'https://api.example.com/extract',
            method: 'POST',
            auth: 'bearer',
            timeout: 30000,
          },
          lockDuration: 120000, // 2 min
        },
        {
          id: 'chunk-docx',
          name: 'Markdown-aware Chunking',
          type: 'chunking',
          provider: 'markdown-aware',
          providerConfig: {
            preserveHeadings: true,
            maxChunkSize: 1000,
          },
        },
      ],

      // Override shared enrichment with custom medical entity extractor
      customEnrichment: {
        id: 'enrich-medical',
        name: 'Medical Entity Extraction',
        type: 'enrichment',
        provider: 'custom_http',
        providerConfig: {
          url: 'https://api.medical.com/extract-entities',
          method: 'POST',
          auth: 'api_key',
          apiKey: '${env.MEDICAL_API_KEY}',
        },
        lockDuration: 180000, // 3 min
      },

      // Use shared indexing (no override)
      customIndexing: undefined,
    },
  ],

  // Shared stages (inherited by flows unless overridden)
  sharedStages: {
    enrichment: {
      id: 'enrich-shared',
      name: 'LLM Entity Extraction',
      type: 'enrichment',
      provider: 'llm',
      providerConfig: {
        model: 'gpt-4',
        prompt: 'Extract entities from: {{content}}',
      },
      lockDuration: 120000, // 2 min
    },
    indexing: {
      id: 'index-shared',
      name: 'BGE-M3 Embeddings',
      type: 'embedding',
      provider: 'bge-m3',
      providerConfig: {
        model: 'bge-m3',
        dimensions: 1024,
        batchSize: 32,
      },
      lockDuration: 180000, // 3 min
    },
  },
};
```

---

## Shared Stages (Inheritance Model)

### Why Inheritance?

**DRY Principle:** Define enrichment/indexing once, all flows inherit.

**Benefits:**

- ✅ Easier updates (change shared, all flows update automatically)
- ✅ Consistent behavior across flows
- ✅ Simpler configuration (flows only override when needed)
- ✅ No worker changes (same queue, different config)

### Inheritance Logic

```typescript
function getEnrichmentStage(
  flow: PipelineFlow,
  pipeline: PipelineDefinition,
): PipelineStage | null {
  // Use flow's custom enrichment if defined, else fallback to shared
  return flow.customEnrichment || pipeline.sharedStages?.enrichment || null;
}

function getIndexingStage(flow: PipelineFlow, pipeline: PipelineDefinition): PipelineStage {
  // Indexing is mandatory, so always return shared if no override
  return flow.customIndexing || pipeline.sharedStages.indexing;
}
```

### Backend Implementation

**FlowBuilder Integration:**

```typescript
// packages/search-ai/src/pipeline/flow-builder.ts

export class PipelineFlowBuilder {
  buildFlow(
    pipeline: PipelineDefinition,
    selectedFlow: PipelineFlow,
    document: SearchDocument,
  ): FlowJob {
    // 1. Build flow-specific extraction stages
    const extractionJobs = this.buildExtractionStages(selectedFlow, document);

    // 2. Build enrichment stage (shared or custom)
    const enrichmentStage = selectedFlow.customEnrichment || pipeline.sharedStages?.enrichment;
    const enrichmentJob = enrichmentStage
      ? this.buildEnrichmentJob(enrichmentStage, document)
      : null;

    // 3. Build indexing stage (shared or custom)
    const indexingStage = selectedFlow.customIndexing || pipeline.sharedStages.indexing;
    const indexingJob = this.buildIndexingJob(indexingStage, document);

    // 4. Assemble flow tree
    return {
      name: selectedFlow.name,
      queueName: 'flow-orchestrator',
      data: {
        documentId: document._id,
        flowId: selectedFlow.id,
        pipelineId: pipeline._id,
      },
      children: [...extractionJobs, enrichmentJob, indexingJob].filter(Boolean), // Remove null jobs
    };
  }

  private buildEnrichmentJob(stage: PipelineStage, document: SearchDocument): FlowJob {
    return {
      name: stage.name,
      queueName: 'enrichment', // SAME QUEUE for shared or custom
      data: {
        documentId: document._id,
        stageId: stage.id,
        providerConfig: stage.providerConfig, // Different config per flow
      },
      opts: {
        failParentOnFailure: true,
        lockDuration: stage.lockDuration || 120000,
        stalledInterval: (stage.lockDuration || 120000) / 2,
      },
    };
  }
}
```

**Worker Compatibility:**

```typescript
// apps/search-ai/src/workers/enrichment-worker.ts

async function processEnrichmentJob(job: Job) {
  const { documentId, stageId, providerConfig } = job.data;

  // Load chunks
  const chunks = await SearchChunk.find({ documentId });

  // Route to provider (doesn't care if config from shared or custom)
  const provider = getProvider(providerConfig.provider);
  const enrichedChunks = await provider.enrich(chunks, providerConfig);

  // Save enriched chunks
  await Promise.all(
    enrichedChunks.map((chunk) =>
      SearchChunk.updateOne(
        { _id: chunk._id },
        {
          $set: {
            entities: chunk.entities,
            summary: chunk.summary,
            enrichmentFlowId: stageId, // Track which enrichment was used
          },
        },
      ),
    ),
  );
}
```

**Key Point:** Worker doesn't know if `providerConfig` came from shared or custom. Same code path.

### UI Representation

**Pipeline Configuration UI:**

```
Pipeline: Medical Documents Processing

Shared Stages (inherited by all flows unless overridden):
┌─────────────────────────────────────────────────┐
│ 🔄 Enrichment: LLM Entity Extraction (GPT-4)    │
│    Extract: Entities, Summaries, Language       │
│    [Edit Shared Enrichment]                     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ 📊 Indexing: BGE-M3 Embeddings (1024-dim)       │
│    Batch size: 32, Dimensions: 1024             │
│    [Edit Shared Indexing]                       │
└─────────────────────────────────────────────────┘

Flows:
┌─────────────────────────────────────────────────┐
│ Flow 1: PDF via Docling                         │
│ ├─ Extraction: Docling                          │
│ ├─ Chunking: Token-based (512 tokens)           │
│ ├─ Enrichment: ✓ Using shared                   │
│ └─ Indexing: ✓ Using shared                     │
│ [Edit Flow]                                     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Flow 3: Docx via Custom API                     │
│ ├─ Extraction: Custom API                       │
│ ├─ Chunking: Markdown-aware                     │
│ ├─ Enrichment: ⚠️ Custom Override               │
│ │   Medical Entity Extractor (HIPAA)           │
│ │   [Edit Custom] [Remove Override]            │
│ └─ Indexing: ✓ Using shared                     │
│ [Edit Flow]                                     │
└─────────────────────────────────────────────────┘
```

---

## Manual Triggers (3 Entry Points)

### Overview

Manual triggers allow users to re-process documents from three different starting points:

1. **Full Re-extraction:** Start from source (complete re-run)
2. **Re-enrichment:** Start from chunks (skip extraction)
3. **Re-indexing:** Start from enriched chunks (skip extraction + enrichment)

**Key Benefit:** Chunks as checkpoint enable faster/cheaper re-processing.

### Entry Point 1: Full Re-extraction

**Use Case:** New extraction provider, need to re-extract everything.

**Example:** Switching from Docling to LlamaIndex for PDF extraction.

**Execution:**

```
1. Re-fetch documents from source (or use cached file)
2. Re-run flow selection (in case flows changed)
3. Execute: Extraction → Chunking → Enrichment → Indexing
4. Replace existing chunks/embeddings
```

**API:**

```
POST /api/projects/:projectId/search/kb/:kbId/reprocess
Body: {
  triggerType: 'extraction',
  scope: 'all' | 'flow' | 'selected',
  flowId?: 'flow-pdf-docling',  // If scope === 'flow'
  documentIds?: ['doc-1', 'doc-2']  // If scope === 'selected'
}
```

**Granularity Options:**

- `scope: 'all'` - Re-extract all documents in KB (all flows)
- `scope: 'flow'` - Re-extract all documents in specific flow (e.g., all PDFs)
- `scope: 'selected'` - Re-extract selected documents (from UI selection)

**Example Response:**

```json
{
  "success": true,
  "jobId": "reprocess-job-123",
  "estimatedDuration": 7200,
  "documentCount": 1234,
  "status": "queued"
}
```

### Entry Point 2: Re-enrichment (from Chunks)

**Use Case:** Changed LLM model, added new enrichment stage.

**Example:** Switching from GPT-3.5 to GPT-4 for entity extraction.

**Execution:**

```
1. Load existing chunks from MongoDB (skip extraction)
2. Execute: Enrichment → Indexing
3. Update chunks with new enrichment data
4. Re-generate embeddings with new context
```

**Cost Savings:**

- ⏱️ Time: ~2 min saved per document (no extraction)
- 💰 Cost: No source fetch, no extraction compute

**API:**

```
POST /api/projects/:projectId/search/kb/:kbId/reprocess
Body: {
  triggerType: 'enrichment',
  scope: 'all' | 'flow' | 'selected',
  flowId?: 'flow-pdf-docling',
  documentIds?: ['doc-1', 'doc-2']
}
```

**Each Flow Uses Own Enrichment:**

- Flow 1 chunks → Re-enrich with Flow 1 enrichment (shared or custom)
- Flow 3 chunks → Re-enrich with Flow 3 enrichment (custom medical extractor)

**Example:**

```typescript
// Backend implementation
async function reprocessEnrichment(kbId: string, scope: ReprocessScope) {
  // Load chunks to re-enrich
  const chunks = await getChunksForReprocessing(kbId, scope);

  // Group chunks by flowId
  const chunksByFlow = groupBy(chunks, 'flowId');

  // Re-enrich each flow's chunks with that flow's enrichment
  for (const [flowId, flowChunks] of Object.entries(chunksByFlow)) {
    const flow = await getFlow(flowId);
    const pipeline = await getPipeline(flow.pipelineId);

    // Get enrichment stage (flow override or shared)
    const enrichmentStage = flow.customEnrichment || pipeline.sharedStages.enrichment;

    // Enqueue enrichment jobs
    for (const chunk of flowChunks) {
      await enrichmentQueue.add({
        chunkId: chunk._id,
        stageConfig: enrichmentStage.providerConfig,
      });
    }
  }
}
```

### Entry Point 3: Re-indexing (from Enriched Chunks)

**Use Case:** Changed embedding model.

**Example:** Switching from BGE-M3 (1024-dim) to OpenAI (1536-dim).

**Execution:**

```
1. Load existing enriched chunks from MongoDB
2. Execute: Indexing → Vector Store
3. Re-generate embeddings (no re-enrichment)
4. Upsert to OpenSearch with new embeddings
```

**Cost Savings:**

- ⏱️ Time: ~3 min saved per document (no extraction, no enrichment)
- 💰 Cost: No source fetch, no extraction, no LLM calls

**API:**

```
POST /api/projects/:projectId/search/kb/:kbId/reprocess
Body: {
  triggerType: 'indexing',
  scope: 'all' | 'flow' | 'selected',
  flowId?: 'flow-pdf-docling',
  documentIds?: ['doc-1', 'doc-2']
}
```

**Schema Change Handling:**

```typescript
// If embedding dimension changes, need to recreate OpenSearch index
async function reprocessIndexing(kbId: string, newEmbeddingModel: string) {
  const oldModel = await getCurrentEmbeddingModel(kbId);
  const oldDim = oldModel.dimensions; // 1024
  const newDim = getModelDimensions(newEmbeddingModel); // 1536

  if (oldDim !== newDim) {
    // Dimension change requires index recreation
    await createNewIndex(kbId, newDim);
    // Blue-green switch: old index stays live until new ready
  }

  // Load all chunks and re-embed
  const chunks = await SearchChunk.find({ knowledgeBaseId: kbId });

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk.content, newEmbeddingModel);

    await openSearchClient.index({
      index: `search-${kbId}-new`,
      id: chunk._id,
      body: {
        content: chunk.content,
        embedding,
        // ... other fields
      },
    });
  }

  // Atomic cutover
  await switchIndex(kbId, `search-${kbId}-new`);
}
```

### Manual Trigger UI (Two Locations)

**Location 1: Pipeline Configuration Page**

```
Manual Triggers

All Documents (1,234 docs):
┌─────────────────────────────────────────────┐
│ ⟳ Re-extract All Documents                  │
│   Scope: All flows                          │
│   Duration: ~6 hours                        │
│   [Confirm Re-extract]                      │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ 🔄 Re-enrich All Documents                   │
│   From: Chunks (skip extraction)            │
│   Scope: All flows                          │
│   Duration: ~2 hours                        │
│   [Confirm Re-enrich]                       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ 📊 Re-index All Documents                    │
│   From: Enriched chunks                     │
│   Scope: All flows                          │
│   Duration: ~1 hour                         │
│   [Confirm Re-index]                        │
└─────────────────────────────────────────────┘

Per-Flow Triggers:
├─ PDF Flow (560 docs): [⟳] [🔄] [📊]
├─ HTML Flow (340 docs): [⟳] [🔄] [📊]
└─ Docx Flow (334 docs): [⟳] [🔄] [📊]
```

**Location 2: Documents Page** (existing DocumentsTab.tsx)

```
Documents (1,234)  [Upload] [Bulk Actions ▼]

Bulk Actions:
├─ ⟳ Re-extract selected documents
├─ 🔄 Re-enrich selected (from chunks)
├─ 📊 Re-index selected (re-embed)
└─ 🗑️ Delete selected

☑ doc-123.pdf    ✅ Indexed (PDF Flow)      45 chunks    2.3 MB
☑ doc-456.html   ⏳ Processing (HTML Flow)  -            1.1 MB
☐ doc-789.docx   ❌ Error (Docx Flow)       -            850 KB
```

---

## Execution Model

### Sequential Per-Document Processing

**Key Principle:** Documents processed **one by one**, not in parallel per document.

**Why Sequential?**

1. **Resource management:** Each document can be resource-intensive (LLM calls, embeddings)
2. **Fair scheduling:** Prevents one large document blocking others
3. **Error isolation:** One document failure doesn't affect others
4. **Observability:** Easier to track progress per document

**Parallel Processing:**

- ✅ **Multiple KBs in project** - CAN process in parallel
- ✅ **Multiple documents** - Queued and processed sequentially
- ❌ **Stages within document** - Sequential (extraction → chunking → enrichment → indexing)

### Document Processing Timeline

```
Document A arrives (10:00:00)
  ├─ Flow selection (10:00:00.050) - 50ms
  ├─ Extraction (10:00:00 - 10:02:00) - 2 min
  ├─ Chunking (10:02:00 - 10:02:30) - 30 sec
  ├─ Enrichment (10:02:30 - 10:03:30) - 1 min
  └─ Indexing (10:03:30 - 10:04:15) - 45 sec
  Total: ~4.5 minutes

Document B arrives (10:00:10) - QUEUED
  ├─ Waits for Document A to complete
  ├─ Starts processing at 10:04:15
  └─ ...
```

### BullMQ Flow Execution

**Flow Tree Structure:**

```typescript
const flowTree: FlowJob = {
  name: 'Document Processing',
  queueName: 'ingestion',
  data: {
    documentId: 'doc-123',
    flowId: 'flow-pdf-docling',
    pipelineId: 'pipeline-456',
  },
  children: [
    {
      name: 'Extraction',
      queueName: 'docling-extraction',
      data: { documentId: 'doc-123', stageId: 'extract-pdf' },
      opts: {
        failParentOnFailure: true,
        lockDuration: 600000, // 10 min
        stalledInterval: 300000, // 5 min
      },
      children: [
        {
          name: 'Chunking',
          queueName: 'chunking',
          opts: { failParentOnFailure: true },
          children: [
            {
              name: 'Enrichment',
              queueName: 'enrichment',
              opts: { failParentOnFailure: true, lockDuration: 120000 },
              children: [
                {
                  name: 'Indexing',
                  queueName: 'embedding',
                  opts: { failParentOnFailure: true, lockDuration: 180000 },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
```

**Execution:** BullMQ manages dependencies, workers process jobs independently.

### Knowledge Base Processing

**One Active Pipeline Per KB:**

- Each KB has ONE pipeline definition
- Pipeline contains multiple flows
- Documents in KB route to different flows based on selection rules

**Multiple KBs in Parallel:**

```
Project: Healthcare Platform
├─ KB 1: Medical Records (1,000 docs) - Processing in parallel ✅
│   └─ Documents queued sequentially
├─ KB 2: Financial Reports (500 docs) - Processing in parallel ✅
│   └─ Documents queued sequentially
└─ KB 3: Legal Contracts (2,000 docs) - Processing in parallel ✅
    └─ Documents queued sequentially
```

**Each KB's pipeline runs independently.**

---

## Live Monitoring

### Two-View Monitoring Dashboard

**View 1: Flow-Level (Aggregated)**

Shows high-level progress per flow (default view).

```
Processing Status - Medical Records KB

┌──────────────────────────────────────────────────────────┐
│ 📄 PDF Flow                                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░ 75% (420/560)       │
│ Current Stage: Enrichment                                │
│ 10 documents in progress                                 │
│ Avg. time per doc: 4.2 minutes                           │
│ Est. completion: 15 minutes                              │
│ [View Documents] [Pause] [Retry Failed]                  │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 🌐 HTML Flow                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 90% (306/340)        │
│ Current Stage: Indexing                                  │
│ 2 documents in progress                                  │
│ Avg. time per doc: 2.1 minutes                           │
│ Est. completion: 5 minutes                               │
│ [View Documents] [Pause]                                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ 📝 Docx Flow                                              │
│ ━━━━━━━━━━━░░░░░░░░░░░░░░░░░░░░░░░ 35% (117/334)       │
│ Current Stage: Extraction                                │
│ 5 documents in progress, 2 failed                        │
│ Avg. time per doc: 5.8 minutes                           │
│ Est. completion: 45 minutes                              │
│ [View Documents] [Pause] [Retry Failed (2)]              │
└──────────────────────────────────────────────────────────┘
```

**View 2: Document-Level (Expandable)**

Shows individual document status (drill-down).

```
📄 PDF Flow (420/560 completed)  [Expand ▼]

Documents (showing 10 of 560):
┌────────────────────────────────────────────────────────┐
│ doc-001.pdf                                            │
│ ✅ Completed (2 min ago)                               │
│ Extraction: 1.8m | Chunking: 0.3m | Enrichment: 0.9m  │
│ 45 chunks | 1024-dim embeddings                        │
│ [View Chunks] [Re-process]                             │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ doc-002.pdf                                            │
│ ⏳ Enrichment (progress: 3/4 stages)                   │
│ Started: 5 min ago                                     │
│ Extraction: ✅ | Chunking: ✅ | Enrichment: ⏳ | Index: ⏸️│
│ 38 chunks created                                      │
│ [View Live Log]                                        │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ doc-003.pdf                                            │
│ ⏳ Chunking (progress: 45%)                            │
│ Started: 2 min ago                                     │
│ Extraction: ✅ (1.2m) | Chunking: ⏳                    │
│ 12 chunks created so far                               │
│ [View Live Log]                                        │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ doc-004.pdf                                            │
│ ⏳ Queued                                               │
│ Position in queue: #23                                 │
│ Est. start time: 8 minutes                             │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ doc-005.pdf                                            │
│ ❌ Failed (extraction error)                           │
│ Error: Docling extraction timeout after 10 minutes    │
│ Last attempt: 15 min ago                               │
│ [Retry] [View Error Details] [Skip Document]          │
└────────────────────────────────────────────────────────┘

[Show All 560 Documents] [Filter by Status ▼]
```

### Real-Time Updates (WebSocket)

**API:**

```
WebSocket: ws://localhost:3114/api/projects/:projectId/search/kb/:kbId/processing-events
```

**Event Types:**

```typescript
type ProcessingEvent =
  | { type: 'document_started'; documentId: string; flowId: string }
  | { type: 'stage_completed'; documentId: string; stage: string; duration: number }
  | { type: 'document_completed'; documentId: string; duration: number }
  | { type: 'document_failed'; documentId: string; error: string }
  | { type: 'flow_progress'; flowId: string; completed: number; total: number };
```

**Client Example:**

```typescript
const ws = new WebSocket(
  `ws://localhost:3114/api/projects/${projectId}/search/kb/${kbId}/processing-events`,
);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'document_started':
      updateDocumentStatus(data.documentId, 'processing');
      break;

    case 'stage_completed':
      updateStageProgress(data.documentId, data.stage);
      break;

    case 'document_completed':
      updateDocumentStatus(data.documentId, 'completed');
      updateFlowProgress(data.flowId);
      break;

    case 'flow_progress':
      updateFlowProgressBar(data.flowId, data.completed, data.total);
      break;
  }
};
```

### Monitoring REST API

**GET /api/projects/:projectId/search/kb/:kbId/processing-status**

Returns current processing status (flow-level + document-level).

**Response:**

```json
{
  "knowledgeBaseId": "kb-789",
  "pipelineId": "pipeline-123",
  "flows": [
    {
      "flowId": "flow-pdf-docling",
      "flowName": "PDF via Docling",
      "status": "processing",
      "progress": {
        "total": 560,
        "completed": 420,
        "inProgress": 10,
        "queued": 128,
        "failed": 2
      },
      "currentStage": "enrichment",
      "avgTimePerDoc": 252,
      "estimatedCompletion": 900
    },
    {
      "flowId": "flow-html-llamaindex",
      "flowName": "HTML via LlamaIndex",
      "status": "processing",
      "progress": {
        "total": 340,
        "completed": 306,
        "inProgress": 2,
        "queued": 32,
        "failed": 0
      },
      "currentStage": "indexing",
      "avgTimePerDoc": 126,
      "estimatedCompletion": 300
    }
  ],
  "documents": [
    {
      "documentId": "doc-001",
      "fileName": "medical-report-001.pdf",
      "flowId": "flow-pdf-docling",
      "status": "completed",
      "completedAt": "2026-03-06T10:04:15Z",
      "duration": 270,
      "chunkCount": 45
    },
    {
      "documentId": "doc-002",
      "fileName": "medical-report-002.pdf",
      "flowId": "flow-pdf-docling",
      "status": "in_progress",
      "currentStage": "enrichment",
      "progress": 0.75,
      "startedAt": "2026-03-06T10:05:00Z"
    }
    // ... more documents
  ]
}
```

---

## Real-World Examples

### Example 1: Medical + Financial Documents

**Scenario:** Healthcare company with medical records (HIPAA) and financial reports (standard).

**Pipeline Configuration:**

```typescript
{
  "name": "Healthcare Documents",
  "knowledgeBaseId": "kb-healthcare",

  "flows": [
    {
      "id": "flow-medical-hipaa",
      "name": "Medical PDFs (HIPAA-compliant)",
      "priority": 50,
      "selectionRules": [
        {
          "type": "cel",
          "celExpression": "doc.fileType == 'pdf' && doc.metadata.category == 'medical'"
        }
      ],
      "stages": [
        { "type": "docling_extraction", "provider": "docling" },
        { "type": "chunking", "provider": "token-based" }
      ],
      "customEnrichment": {
        "type": "enrichment",
        "provider": "custom_http",
        "providerConfig": {
          "url": "https://hipaa.medical-ai.com/extract-entities",
          "auth": "bearer",
          "timeout": 30000
        }
      }
    },
    {
      "id": "flow-financial",
      "name": "Financial Reports",
      "priority": 40,
      "selectionRules": [
        {
          "type": "simple",
          "field": "doc.metadata.category",
          "operator": "eq",
          "value": "financial"
        }
      ],
      "stages": [
        { "type": "docling_extraction", "provider": "docling" },
        { "type": "chunking", "provider": "token-based" }
      ]
      // Uses shared enrichment (standard LLM)
    }
  ],

  "sharedStages": {
    "enrichment": {
      "type": "enrichment",
      "provider": "llm",
      "providerConfig": { "model": "gpt-4" }
    },
    "indexing": {
      "type": "embedding",
      "provider": "bge-m3"
    }
  }
}
```

**Result:**

- Medical PDFs → HIPAA-compliant enrichment (custom provider)
- Financial PDFs → Standard GPT-4 enrichment (shared)
- Both use same embedding model (shared)

---

### Example 2: Multi-Format Content Platform

**Scenario:** Content platform with PDFs, HTML articles, Docx documents, and Markdown files.

**Pipeline Configuration:**

```typescript
{
  "name": "Multi-Format Content",
  "knowledgeBaseId": "kb-content-platform",

  "flows": [
    {
      "id": "flow-pdf-docling",
      "name": "PDF Documents",
      "priority": 40,
      "selectionRules": [
        { "type": "simple", "field": "doc.fileType", "operator": "eq", "value": "pdf" }
      ],
      "stages": [
        { "type": "docling_extraction", "provider": "docling" },
        { "type": "chunking", "provider": "token-based", "providerConfig": { "chunkSize": 512 } }
      ]
    },
    {
      "id": "flow-html-llamaindex",
      "name": "HTML Articles",
      "priority": 30,
      "selectionRules": [
        { "type": "simple", "field": "doc.fileType", "operator": "eq", "value": "html" }
      ],
      "stages": [
        { "type": "document_extraction", "provider": "llamaindex" },
        { "type": "chunking", "provider": "markdown-aware" }
      ]
    },
    {
      "id": "flow-docx-custom",
      "name": "Docx Documents",
      "priority": 20,
      "selectionRules": [
        { "type": "simple", "field": "doc.fileType", "operator": "eq", "value": "docx" }
      ],
      "stages": [
        { "type": "custom_http", "provider": "http", "providerConfig": { "url": "https://api.docx-parser.com/extract" } },
        { "type": "chunking", "provider": "paragraph-based" }
      ]
    },
    {
      "id": "flow-markdown-simple",
      "name": "Markdown Files",
      "priority": 10,
      "selectionRules": [
        { "type": "simple", "field": "doc.fileType", "operator": "in", "value": ["md", "markdown"] }
      ],
      "stages": [
        { "type": "document_extraction", "provider": "markdown-parser" },
        { "type": "chunking", "provider": "heading-based" }
      ],
      "customEnrichment": null  // Skip enrichment for simple markdown (save cost)
    }
  ],

  "sharedStages": {
    "enrichment": {
      "type": "enrichment",
      "provider": "llm",
      "providerConfig": { "model": "gpt-3.5-turbo" }  // Cheaper model
    },
    "indexing": {
      "type": "embedding",
      "provider": "bge-m3"
    }
  }
}
```

**Result:**

- PDF → Docling extraction, token-based chunking
- HTML → LlamaIndex extraction, markdown-aware chunking
- Docx → Custom API extraction, paragraph-based chunking
- Markdown → Simple parser, heading-based chunking, no enrichment (cost saving)

---

### Example 3: Conditional OCR for Scanned PDFs

**Scenario:** Document processor with mix of digital and scanned PDFs. OCR only on scanned.

**Pipeline Configuration:**

```typescript
{
  "name": "PDF Processing with Conditional OCR",
  "knowledgeBaseId": "kb-documents",

  "flows": [
    {
      "id": "flow-pdf-smart",
      "name": "PDF with Smart OCR",
      "priority": 40,
      "selectionRules": [
        { "type": "simple", "field": "doc.fileType", "operator": "eq", "value": "pdf" }
      ],
      "stages": [
        {
          "id": "extract-pdf",
          "type": "docling_extraction",
          "provider": "docling"
        },
        {
          "id": "ocr-conditional",
          "type": "ocr",
          "provider": "tesseract",
          "executionCondition": {
            "type": "cel",
            "celExpression": "output.confidence < 0.8 || doc.metadata.isScanned == true"
          }
        },
        {
          "type": "chunking",
          "provider": "token-based"
        }
      ]
    }
  ],

  "sharedStages": {
    "enrichment": { "type": "enrichment", "provider": "llm" },
    "indexing": { "type": "embedding", "provider": "bge-m3" }
  }
}
```

**Result:**

- Digital PDFs (high confidence) → Skip OCR → Fast processing (~2 min)
- Scanned PDFs (low confidence) → Run OCR → Slower but accurate (~5 min)
- 40% time saving (OCR skipped on 60% of PDFs)

---

## Data Models

### PipelineDefinition

```typescript
interface PipelineDefinition {
  _id: ObjectId;
  tenantId: string;
  knowledgeBaseId: string; // ONE pipeline per KB

  name: string;
  description: string;
  version: number; // Auto-incremented on update
  status: 'draft' | 'active' | 'archived';

  // Multiple flows
  flows: PipelineFlow[];

  // Shared stages (inherited by flows)
  sharedStages?: {
    enrichment?: PipelineStage;
    indexing: PipelineStage; // Mandatory
  };

  // Metadata
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeployedAt?: Date;

  // Validation cache
  validationErrors?: ValidationError[];
}
```

### PipelineFlow

```typescript
interface PipelineFlow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  // Selection (document routing)
  selectionRules: RuleCondition[];
  priority: number; // Higher = evaluated first

  // Flow-specific stages (extraction → chunking)
  stages: PipelineStage[];

  // Override shared stages
  customEnrichment?: PipelineStage;
  customIndexing?: PipelineStage;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
```

### ISearchChunk (Extended)

```typescript
interface ISearchChunk {
  // ... existing fields

  // NEW: Flow tracking
  flowId?: string; // Which flow created this chunk
  enrichmentFlowId?: string; // Which enrichment was applied

  // Enables per-flow manual triggers and debugging
}
```

---

## Default Flows

Every new pipeline starts with **4 default flows** that map to current MIME type routing patterns. These flows cover all document types currently supported and provide a foundation for user customization.

### Overview

**Purpose:** Make document routing explicit and customizable

**Default Flows:**

1. **Document Processing** (Priority 100) - PDF, Office docs, HTML → Docling
2. **Image Processing** (Priority 90) - Images with OCR → Docling
3. **Plain Text Processing** (Priority 80) - TXT, Markdown → LlamaIndex
4. **Default Fallback** (Priority 0) - All others → Docling (quality-first)

**Benefits:**

- ✅ **Explicit routing** - Users see which flow handles which MIME types (not hidden in code)
- ✅ **Customizable** - Override defaults by adding higher-priority flows
- ✅ **Testable** - Flow simulation: "Which flow will process my PDF?"
- ✅ **Observable** - Trace events show flow selection decisions
- ✅ **Extensible** - Add new MIME types via UI (no code deployment)

### Flow 1: Document Processing (Priority 100)

**Purpose:** Process structured documents using Docling provider

**MIME Types:**

- `application/pdf` - PDF documents
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` - DOCX
- `application/vnd.openxmlformats-officedocument.presentationml.presentation` - PPTX
- `application/msword` - DOC (legacy)
- `application/vnd.ms-powerpoint` - PPT (legacy)
- `text/html` - HTML documents

**Selection Rules:**

```json
{
  "selectionRules": [
    {
      "type": "cel",
      "celExpression": "doc.contentType == 'application/pdf'",
      "description": "PDF documents"
    },
    {
      "type": "cel",
      "celExpression": "doc.contentType.startsWith('application/vnd.openxmlformats-officedocument')",
      "description": "Office Open XML (DOCX, PPTX)"
    },
    {
      "type": "cel",
      "celExpression": "doc.contentType == 'application/msword' || doc.contentType == 'application/vnd.ms-powerpoint'",
      "description": "Legacy Office formats"
    },
    {
      "type": "cel",
      "celExpression": "doc.contentType == 'text/html'",
      "description": "HTML documents"
    }
  ]
}
```

**Stages:**

- Extraction: Docling (extractImages: true, extractTables: true, preserveLayout: true)
- Chunking: Recursive Character Splitter (1000/200)
- Enrichment: LLM Metadata Extractor (inherited from shared stages)
- Embedding: BGE-M3 (1024 dimensions)
- Indexing: OpenSearch (inherited from shared stages)

### Flow 2: Image Processing (Priority 90)

**Purpose:** Process images with OCR using Docling provider

**MIME Types:**

- `image/png`, `image/jpeg`, `image/jpg`
- `image/tiff`, `image/bmp`, `image/webp`
- Any other `image/*` types

**Selection Rules:**

```json
{
  "selectionRules": [
    {
      "type": "cel",
      "celExpression": "doc.contentType.startsWith('image/')",
      "description": "All image formats"
    }
  ]
}
```

**Stages:**

- Extraction: Docling with OCR (ocrEnabled: true, ocrLanguage: "eng")
- Chunking: Recursive Character Splitter (1000/200)
- Enrichment: LLM Metadata Extractor (inherited)
- Embedding: BGE-M3 (1024 dimensions)
- Indexing: OpenSearch (inherited)

**Expected Documents:** Scanned documents, screenshots, photos with text

### Flow 3: Plain Text Processing (Priority 80)

**Purpose:** Process plain text and markdown using LlamaIndex provider (legacy path)

**MIME Types:**

- `text/plain` - Plain text files (.txt)
- `text/markdown` - Markdown files (.md)

**Selection Rules:**

```json
{
  "selectionRules": [
    {
      "type": "cel",
      "celExpression": "doc.contentType == 'text/plain' || doc.contentType == 'text/markdown'",
      "description": "Plain text and Markdown files"
    }
  ]
}
```

**Stages:**

- Extraction: LlamaIndex Simple Extractor (preserveFormatting: true)
- Chunking: Recursive Character Splitter (1000/200)
- Enrichment: LLM Metadata Extractor (inherited)
- Embedding: BGE-M3 (1024 dimensions)
- Indexing: OpenSearch (inherited)

**Expected Documents:** README files, code documentation, plain text notes

### Flow 4: Default Fallback (Priority 0)

**Purpose:** Handle all other document types with Docling (quality-first approach)

**MIME Types:** All types not matched by higher-priority flows

**Selection Rules:**

```json
{
  "selectionRules": [
    {
      "type": "cel",
      "celExpression": "true",
      "description": "Catch-all for unmatched documents"
    }
  ]
}
```

**Stages:**

- Extraction: Docling (fallback configuration)
- Chunking: Recursive Character Splitter (1000/200)
- Enrichment: LLM Metadata Extractor (inherited)
- Embedding: BGE-M3 (1024 dimensions)
- Indexing: OpenSearch (inherited)

**Design Choice:** Default to Docling (most capable provider) rather than rejecting unknown types

### MIME Type to Flow Mapping

| MIME Type                          | Flow                  | Provider      | Priority |
| ---------------------------------- | --------------------- | ------------- | -------- |
| `application/pdf`                  | Document Processing   | Docling       | 100      |
| `application/vnd.openxmlformats-*` | Document Processing   | Docling       | 100      |
| `application/msword`               | Document Processing   | Docling       | 100      |
| `application/vnd.ms-powerpoint`    | Document Processing   | Docling       | 100      |
| `text/html`                        | Document Processing   | Docling       | 100      |
| `image/*`                          | Image Processing      | Docling (OCR) | 90       |
| `text/plain`                       | Plain Text Processing | LlamaIndex    | 80       |
| `text/markdown`                    | Plain Text Processing | LlamaIndex    | 80       |
| _(all others)_                     | Default Fallback      | Docling       | 0        |

### Flow Selection Examples

**Example 1: PDF Upload**

```
Document: report.pdf
contentType: application/pdf

Flow Selection:
1. Check Flow 1 (Priority 100) - Document Processing
   Rule: doc.contentType == 'application/pdf'
   Match: ✅ TRUE
   Selected: Flow 1 - Document Processing

Trace Event:
{
  "type": "flow_selection",
  "flowId": "flow-documents",
  "priority": 100,
  "matchedRule": "doc.contentType == 'application/pdf'",
  "provider": "docling"
}
```

**Example 2: Image with OCR**

```
Document: scan.png
contentType: image/png

Flow Selection:
1. Check Flow 1 (Priority 100) - No match
2. Check Flow 2 (Priority 90) - Image Processing
   Rule: doc.contentType.startsWith('image/')
   Match: ✅ TRUE
   Selected: Flow 2 - Image Processing

Result: Docling processes with OCR enabled
```

**Example 3: Unknown Format**

```
Document: data.xyz
contentType: application/x-xyz

Flow Selection:
1. Check Flow 1 (Priority 100) - No match
2. Check Flow 2 (Priority 90) - No match
3. Check Flow 3 (Priority 80) - No match
4. Check Flow 4 (Priority 0) - Default Fallback
   Rule: true (catch-all)
   Match: ✅ TRUE
   Selected: Flow 4 - Default Fallback

Result: Docling attempts processing (quality-first)
```

### User Customization Scenarios

**Scenario 1: Override PDF Provider**

User wants custom provider for PDFs instead of Docling.

**Solution:** Add higher-priority flow

```json
{
  "id": "flow-custom-pdf",
  "name": "Custom PDF Processing",
  "priority": 110, // Higher than default (100)
  "selectionRules": [{ "celExpression": "doc.contentType == 'application/pdf'" }],
  "stages": [
    { "type": "extraction", "provider": "my-custom-pdf-extractor" }
    // ... rest of stages
  ]
}
```

**Result:** PDFs use custom flow (priority 110) instead of default (priority 100)

**Scenario 2: Add CSV Processing**

User wants to process CSV files with custom provider.

**Solution:** Add new flow

```json
{
  "id": "flow-csv",
  "name": "CSV Processing",
  "priority": 95,
  "selectionRules": [{ "celExpression": "doc.contentType == 'text/csv'" }],
  "stages": [
    { "type": "extraction", "provider": "csv-parser" }
    // ... rest of stages
  ]
}
```

**Result:** CSV files use custom flow, other files use default flows

**Scenario 3: Conditional Processing by Size**

User wants different extraction for large PDFs.

**Solution:** Add flow with compound rules

```json
{
  "id": "flow-large-pdf",
  "name": "Large PDF Processing",
  "priority": 105, // Higher than default PDF (100)
  "selectionRules": [
    {
      "celExpression": "doc.contentType == 'application/pdf' && doc.contentSizeBytes > 10000000"
    }
  ],
  "stages": [
    { "type": "extraction", "provider": "optimized-large-pdf-extractor" }
    // ... rest of stages
  ]
}
```

**Result:** PDFs >10MB use optimized extractor, smaller PDFs use default flow

### Migration from Current Routing

**Current Implementation (`document-upload.ts`):**

```typescript
// Hardcoded routing function
const route = routeDocument(contentType);
const queueName = route === 'docling' ? QUEUE_DOCLING_EXTRACTION : QUEUE_EXTRACTION;
```

**Flow-Based Implementation (Future):**

```typescript
// Flow selection algorithm
const selectedFlow = await selectFlow(pipeline, document);
// Evaluates selection rules in priority order (100 → 90 → 80 → 0)
// First flow with matching rule wins

await flowQueue.add(`flow:${selectedFlow.id}:${document._id}`, {
  pipelineId: pipeline._id,
  flowId: selectedFlow.id,
  documentId: document._id.toString(),
  // ... context
});
```

**Migration Path:**

1. Phase 1: Add default flows to all new pipelines
2. Phase 2: Migrate existing routing to flow selection
3. Phase 3: Remove old `routeDocument()` function
4. Phase 4: Users customize default flows as needed

**Backward Compatibility:** Default flows produce same results as current routing, no breaking changes to workers.

---

## Provider System

The provider system enables pluggable document processing stages with multiple interchangeable implementations. Each stage type (extraction, chunking, enrichment, embedding, indexing) can have multiple providers that users can swap via configuration.

### Overview

**Purpose:** Enable users to choose best-fit providers for their document types and use cases

**Key Capabilities:**

- ✅ Multiple providers per stage type (extraction: Docling, LlamaIndex, custom API)
- ✅ Provider swapping via configuration (no code changes)
- ✅ HTTP webhook providers (call external APIs)
- ✅ JavaScript sandbox providers (custom logic)
- ✅ Output schema consistency (providers must produce compatible outputs)

**Benefits:**

- 🎯 **Flexibility** - Choose provider based on document type, quality, cost
- 🎯 **Extensibility** - Add new providers without changing workers
- 🎯 **Vendor independence** - Not locked to single extraction/embedding service
- 🎯 **Cost optimization** - Use cheaper providers for simple documents

### Stage Types and Providers

| Stage Type     | Available Providers                                                  | Output Schema                      |
| -------------- | -------------------------------------------------------------------- | ---------------------------------- |
| **Extraction** | Docling, LlamaIndex Simple, HTTP Webhook, JavaScript                 | `IDocumentPage[]`                  |
| **Chunking**   | Recursive Character, Semantic, Fixed Size, JavaScript                | `ISearchChunk[]`                   |
| **Enrichment** | LLM Metadata Extractor, Question Synthesis, HTTP Webhook, JavaScript | `ISearchChunk[]` (enriched)        |
| **Embedding**  | BGE-M3, OpenAI, Cohere, Custom Model                                 | `ISearchChunk[]` (with embeddings) |
| **Indexing**   | OpenSearch, Elasticsearch, Custom Vector Store                       | Success status                     |

### Provider Registry Concept

**High-Level:** Providers are registered by name and referenced in pipeline configurations.

**Example Flow Configuration:**

```json
{
  "stages": [
    {
      "id": "extract",
      "type": "extraction",
      "provider": "docling", // Reference to registered provider
      "config": {
        "extractImages": true,
        "extractTables": true
      }
    },
    {
      "id": "chunk",
      "type": "chunking",
      "provider": "recursive-character",
      "config": {
        "chunkSize": 1000,
        "chunkOverlap": 200
      }
    }
  ]
}
```

**Provider Lookup:** At runtime, system looks up "docling" in extraction provider registry and executes.

**Note:** Detailed provider registry implementation (singleton pattern, lazy loading, caching) deferred to design document.

### Built-In Providers

#### Extraction Providers

**1. Docling Provider**

**Capabilities:**

- PDF, Office docs (DOCX, PPTX), HTML extraction
- Image OCR (PNG, JPEG, TIFF, BMP, WEBP)
- Table extraction with structure preservation
- Layout-aware text extraction

**Configuration:**

```typescript
{
  "provider": "docling",
  "config": {
    "extractImages": boolean,      // Extract embedded images
    "extractTables": boolean,       // Preserve table structure
    "preserveLayout": boolean,      // Maintain document layout
    "ocrEnabled": boolean,          // Enable OCR for images
    "ocrLanguage": string,          // OCR language (default: "eng")
    "timeout": number               // Extraction timeout (ms)
  }
}
```

**Output:** `IDocumentPage[]` (array of pages with markdown content)

**2. LlamaIndex Simple Provider**

**Capabilities:**

- Plain text extraction (TXT, MD)
- Single-page output (full file as one page)
- Minimal processing overhead

**Configuration:**

```typescript
{
  "provider": "llamaindex-simple",
  "config": {
    "preserveFormatting": boolean  // Preserve line breaks and spacing
  }
}
```

**Output:** `IDocumentPage[]` (single page with full content)

**3. HTTP Webhook Provider**

**Capabilities:**

- Call external extraction API
- Custom document processing services
- Third-party extraction providers

**Configuration:**

```typescript
{
  "provider": "http-webhook",
  "config": {
    "url": string,                  // Webhook URL (HTTPS only)
    "method": "POST",               // HTTP method
    "timeout": number,              // Request timeout (ms, max 300000)
    "headers": Record<string, string>,  // Custom headers
    "auth": {
      "type": "bearer" | "api-key",
      "token": string               // Auth token (encrypted at rest)
    },
    "retries": number               // Max retry attempts (default: 3)
  }
}
```

**Request Body:**

```json
{
  "documentId": "string",
  "sourceUrl": "string",
  "contentType": "string",
  "metadata": {}
}
```

**Expected Response:**

```json
{
  "pages": [
    {
      "pageNumber": 1,
      "content": "markdown content",
      "metadata": {}
    }
  ]
}
```

**Security:** HTTPS only, no access to internal network, configurable timeout

**Note:** Detailed auth methods (OAuth, API key rotation) deferred to design document.

**4. JavaScript Sandbox Provider**

**Capabilities:**

- Custom extraction logic in JavaScript
- User-defined processing rules
- Sandboxed execution (no filesystem/network access)

**Configuration:**

```typescript
{
  "provider": "javascript-sandbox",
  "config": {
    "code": string,                // JavaScript code (validated)
    "timeout": number,             // Execution timeout (ms, max 10000)
    "memoryLimit": number          // Memory limit (MB, max 128)
  }
}
```

**JavaScript API:**

```javascript
// User-provided extraction function
async function extract(document, sourceContent) {
  // document: { id, contentType, metadata }
  // sourceContent: string (file content)

  // Custom processing logic
  const lines = sourceContent.split('\n');
  const pages = [
    {
      pageNumber: 1,
      content: lines.join('\n'),
      metadata: { lineCount: lines.length },
    },
  ];

  return { pages };
}
```

**Security:**

- No `require()` / `import` (no npm packages)
- No filesystem access (`fs`, `path` disabled)
- No network access (`http`, `https`, `fetch` disabled)
- Timeout: 10 seconds max
- Memory: 128MB max

**Note:** Sandbox library choice (isolated-vm vs vm2) and exact security limits deferred to design document.

#### Chunking Providers

**1. Recursive Character Splitter**

**Capabilities:**

- Recursive splitting by separators (\n\n, \n, space)
- Configurable chunk size and overlap
- Preserves semantic boundaries (paragraphs, sentences)

**Configuration:**

```typescript
{
  "provider": "recursive-character",
  "config": {
    "chunkSize": number,          // Target chunk size (characters)
    "chunkOverlap": number,       // Overlap between chunks (characters)
    "separators": string[]        // Custom separators (optional)
  }
}
```

**2. Semantic Chunker**

**Capabilities:**

- Embedding-based semantic splitting
- Groups semantically similar sentences
- Better context preservation than fixed-size

**Configuration:**

```typescript
{
  "provider": "semantic-chunker",
  "config": {
    "targetChunkSize": number,    // Target chunk size (approximate)
    "embeddingModel": string,     // Model for similarity (e.g., "bge-m3")
    "similarityThreshold": number // Threshold for grouping (0-1)
  }
}
```

**3. JavaScript Sandbox Chunker**

Custom chunking logic with same sandbox constraints as extraction.

#### Enrichment Providers

**1. LLM Metadata Extractor**

**Capabilities:**

- Extract title, summary, keywords, entities
- LLM-based enrichment (requires LLM credentials)
- Configurable fields to extract

**Configuration:**

```typescript
{
  "provider": "llm-metadata-extractor",
  "config": {
    "fields": string[],           // Fields to extract: ["title", "summary", "keywords", "entities"]
    "llmProvider": string,        // LLM provider (resolved via credential system)
    "model": string,              // Model name (e.g., "gpt-4", "claude-3")
    "maxTokens": number           // Max tokens per enrichment call
  }
}
```

**Note:** LLM credential resolution handled by existing system (RFC-XXX), not duplicated here.

**2. Question Synthesis**

**Capabilities:**

- Generate questions answerable by chunk
- Enhances retrieval quality (HyDE-style)

**Configuration:**

```typescript
{
  "provider": "question-synthesis",
  "config": {
    "questionsPerChunk": number,  // Number of questions to generate
    "llmProvider": string,
    "model": string
  }
}
```

**3. HTTP Webhook Enrichment**

Call external API for custom enrichment (same pattern as extraction webhook).

**4. JavaScript Sandbox Enrichment**

Custom enrichment logic with sandbox constraints.

#### Embedding Providers

**1. BGE-M3 (Default)**

**Capabilities:**

- Multi-lingual embeddings (100+ languages)
- 1024-dimensional vectors
- Self-hosted (no external API calls)

**Configuration:**

```typescript
{
  "provider": "bge-m3",
  "config": {
    "dimensions": 1024,           // Fixed for BGE-M3
    "batchSize": number           // Batch size for embedding calls
  }
}
```

**2. OpenAI Embeddings**

**Capabilities:**

- High-quality embeddings (text-embedding-3-large)
- Multiple dimension options (1536, 3072)
- Requires OpenAI API key

**Configuration:**

```typescript
{
  "provider": "openai-embeddings",
  "config": {
    "model": "text-embedding-3-large",
    "dimensions": number,         // 1536 or 3072
    "apiKey": string              // Resolved via credential system
  }
}
```

**3. Cohere Embeddings**

Similar pattern to OpenAI, different models and dimensions.

#### Indexing Providers

**1. OpenSearch (Default)**

**Capabilities:**

- Vector similarity search (HNSW, IVF)
- Hybrid search (vector + keyword)
- Existing infrastructure

**Configuration:**

```typescript
{
  "provider": "opensearch",
  "config": {
    "indexName": string,          // Target index (default: "search_chunks")
    "vectorField": string,        // Field for embeddings (default: "embedding")
    "refresh": boolean            // Refresh index after insert (default: false)
  }
}
```

**2. Elasticsearch**

Similar to OpenSearch, compatible API.

**3. Custom Vector Store**

HTTP webhook pattern for custom vector databases.

### Output Schema Consistency

**Critical Requirement:** All providers for a stage type must produce compatible output schemas.

**Example: Extraction Providers**

All extraction providers (Docling, LlamaIndex, HTTP, JavaScript) must return:

```typescript
interface ExtractionOutput {
  pages: IDocumentPage[]; // Array of pages
}

interface IDocumentPage {
  pageNumber: number;
  content: string; // Markdown content
  metadata?: {
    imageCount?: number;
    tableCount?: number;
    [key: string]: any;
  };
}
```

**Why:** Downstream stages (chunking, enrichment) expect consistent input format regardless of extraction provider.

**Validation:** Provider output validated against schema at runtime. Invalid output fails the job with clear error.

**Note:** Complete TypeScript interfaces and validation logic deferred to design document.

### Provider Configuration UI

**Flow Editor:**

- Dropdown to select provider per stage
- Provider-specific configuration form (dynamic based on provider)
- Cost estimator shows price per 1K documents (based on selected providers)

**Example:**

```
Stage: Extraction
Provider: [Dropdown: Docling / LlamaIndex / HTTP Webhook / JavaScript]

[If Docling selected]
  ☑ Extract Images
  ☑ Extract Tables
  ☑ Preserve Layout
  [ ] Enable OCR

[If HTTP Webhook selected]
  URL: https://my-api.example.com/extract
  Method: POST
  Timeout: 30000 ms
  Auth Type: [Dropdown: Bearer / API Key]
  Token: [Encrypted input]
```

### Provider Validation

**Save-Time Validation:**

1. **Provider exists** - Referenced provider name must be registered
2. **Configuration valid** - Config matches provider schema
3. **Required fields present** - All required config fields provided
4. **Security constraints** - HTTP webhooks use HTTPS, JavaScript code passes safety checks
5. **Output schema compatibility** - Provider produces expected output type

**Example Validation Errors:**

```json
{
  "validationErrors": [
    {
      "code": "PROVIDER_NOT_FOUND",
      "message": "Provider 'my-custom-extractor' not found in extraction registry",
      "stageId": "extract"
    },
    {
      "code": "INVALID_CONFIG",
      "message": "Field 'chunkSize' must be positive integer, got: -100",
      "stageId": "chunk"
    },
    {
      "code": "INSECURE_WEBHOOK",
      "message": "HTTP webhook URL must use HTTPS, got: http://insecure.com",
      "stageId": "extract"
    }
  ]
}
```

**Note:** Complete validation service implementation and error code catalog deferred to design document.

### Cross-References

**Related Sections:**

- [Default Flows](#default-flows) - Default flows reference providers (Docling, LlamaIndex)
- [Pipeline Validation](#pipeline-validation) - Validates provider configurations
- [Non-Functional Requirements](#non-functional-requirements) - Security constraints for HTTP/JavaScript providers

**Related RFCs:**

- RFC-005 (Job Tracking) - Providers tracked in job execution metadata
- LLM Credential System RFC - Enrichment providers use existing credential resolution

---

## Pipeline Validation

Save-time validation catches configuration errors before pipeline activation, preventing runtime failures and providing immediate feedback to users. Flow-based pipelines require flow-specific validation rules beyond basic schema validation.

### Validation Levels

**1. Schema Validation (Automatic)**

- TypeScript interface validation
- Required fields present
- Correct data types

**2. Business Logic Validation (Custom)**

- Flow selection rules compile
- Flow priorities unique
- Convergence to common chunk schema
- Provider configurations valid

**3. Cross-Entity Validation (Referential)**

- Knowledge Base exists
- Providers exist in registry
- LLM credentials exist (if enrichment enabled)

### Flow Selection Validation

**Rule 1: At Least One Enabled Flow**

**Requirement:** Pipeline must have at least one enabled flow

**Error:**

```json
{
  "code": "NO_ENABLED_FLOWS",
  "message": "Pipeline must have at least one enabled flow",
  "severity": "error"
}
```

**Fix:** Enable at least one flow or add a default fallback flow

**Rule 2: Unique Flow Priorities**

**Requirement:** All flow priorities must be unique within pipeline

**Error:**

```json
{
  "code": "DUPLICATE_PRIORITY",
  "message": "Flows 'flow-pdf' and 'flow-html' have same priority: 100",
  "severity": "error",
  "affectedFlows": ["flow-pdf", "flow-html"]
}
```

**Fix:** Assign unique priority values to each flow

**Rule 3: Selection Rules Compile (CEL)**

**Requirement:** All CEL expressions must compile successfully

**Error:**

```json
{
  "code": "INVALID_CEL_EXPRESSION",
  "message": "CEL expression failed to compile: syntax error at line 1:15",
  "severity": "error",
  "flowId": "flow-pdf",
  "ruleIndex": 0,
  "expression": "doc.contentType = 'application/pdf'"
}
```

**Fix:** Correct CEL syntax (use `==` instead of `=`)

**Rule 4: Selection Rule Field Access**

**Requirement:** CEL expressions can only access whitelisted fields

**Whitelisted Fields:**

- `doc.contentType` - Document MIME type
- `doc.contentSizeBytes` - Document size
- `doc.sourceMetadata.*` - User-defined metadata
- `doc.originalReference` - Original filename/URL

**Blacklisted Fields (Security):**

- `doc.tenantId` - Cannot access tenant ID (security risk)
- `doc._id` - Cannot access document ID (security risk)
- `doc.credentials` - Cannot access credentials (security risk)

**Error:**

```json
{
  "code": "INVALID_FIELD_ACCESS",
  "message": "CEL expression accesses restricted field: doc.tenantId",
  "severity": "error",
  "flowId": "flow-pdf",
  "ruleIndex": 0,
  "field": "tenantId"
}
```

**Fix:** Remove access to restricted fields

**Rule 5: Default Flow Recommended**

**Requirement:** Pipeline should have a fallback flow with catch-all rule

**Warning:**

```json
{
  "code": "NO_DEFAULT_FLOW",
  "message": "No default fallback flow found. Documents not matching any flow will be rejected.",
  "severity": "warning",
  "recommendation": "Add flow with priority 0 and selection rule: true"
}
```

**Fix:** Add default fallback flow (priority 0, rule: `true`)

### Flow Structure Validation

**Rule 6: Mandatory Stages Per Flow**

**Requirement:** Every flow must have extraction + chunking stages

**Why:** Flows converge to chunks checkpoint, extraction and chunking required

**Error:**

```json
{
  "code": "MISSING_REQUIRED_STAGE",
  "message": "Flow 'flow-pdf' missing required stage type: extraction",
  "severity": "error",
  "flowId": "flow-pdf",
  "missingStage": "extraction"
}
```

**Fix:** Add extraction stage to flow

**Rule 7: Stage Order Validation**

**Requirement:** Stages must be in logical order: extraction → chunking → (enrichment) → embedding → indexing

**Error:**

```json
{
  "code": "INVALID_STAGE_ORDER",
  "message": "Chunking stage must come after extraction stage",
  "severity": "error",
  "flowId": "flow-pdf",
  "stageId": "chunk-1"
}
```

**Fix:** Reorder stages to match execution flow

**Rule 8: Convergence to Common Schema**

**Requirement:** All flows must converge to same `ISearchChunk` schema

**Why:** Manual triggers and indexing require consistent chunk format

**Validation:**

- Extraction output → `IDocumentPage[]` (all providers)
- Chunking output → `ISearchChunk[]` (all providers)
- Common fields: `flowId`, `enrichmentFlowId`, `content`, `embedding`, `metadata`

**Error:**

```json
{
  "code": "SCHEMA_MISMATCH",
  "message": "Flow 'flow-custom' produces chunks with custom fields not in ISearchChunk schema",
  "severity": "error",
  "flowId": "flow-custom",
  "extraFields": ["customField1", "customField2"]
}
```

**Fix:** Remove custom chunk fields or add to shared schema

### Shared Stages Validation

**Rule 9: Shared Indexing Stage Required**

**Requirement:** Pipeline must define shared indexing stage (mandatory)

**Error:**

```json
{
  "code": "MISSING_SHARED_INDEXING",
  "message": "Pipeline missing required shared indexing stage",
  "severity": "error"
}
```

**Fix:** Add shared indexing stage to pipeline

**Rule 10: Shared Enrichment Optional**

**Requirement:** Shared enrichment stage is optional but recommended

**Warning:**

```json
{
  "code": "NO_SHARED_ENRICHMENT",
  "message": "No shared enrichment stage defined. Per-flow enrichment increases cost.",
  "severity": "warning",
  "recommendation": "Add shared enrichment stage to reduce LLM calls"
}
```

**Fix:** Add shared enrichment stage (or acknowledge per-flow enrichment cost)

### Provider Validation

**Rule 11: Provider Exists**

**Requirement:** Referenced provider must exist in registry

**Error:**

```json
{
  "code": "PROVIDER_NOT_FOUND",
  "message": "Provider 'my-custom-extractor' not found in extraction registry",
  "severity": "error",
  "flowId": "flow-pdf",
  "stageId": "extract",
  "providerName": "my-custom-extractor"
}
```

**Fix:** Use registered provider or register custom provider first

**Rule 12: Provider Configuration Valid**

**Requirement:** Provider config must match provider schema

**Error:**

```json
{
  "code": "INVALID_PROVIDER_CONFIG",
  "message": "Docling provider config invalid: 'chunkSize' is not a valid field for extraction provider",
  "severity": "error",
  "flowId": "flow-pdf",
  "stageId": "extract",
  "providerName": "docling",
  "invalidField": "chunkSize"
}
```

**Fix:** Remove invalid config fields or fix field names

**Rule 13: HTTP Webhook Security**

**Requirement:** HTTP webhooks must use HTTPS (not HTTP)

**Error:**

```json
{
  "code": "INSECURE_WEBHOOK_URL",
  "message": "HTTP webhook URL must use HTTPS protocol, got: http://insecure.com/extract",
  "severity": "error",
  "flowId": "flow-custom",
  "stageId": "extract",
  "url": "http://insecure.com/extract"
}
```

**Fix:** Change URL to HTTPS

**Rule 14: JavaScript Sandbox Code Validation**

**Requirement:** JavaScript code must pass safety checks

**Safety Checks:**

- No `require()` or `import` statements
- No filesystem access (`fs`, `path`)
- No network access (`http`, `https`, `fetch`, `XMLHttpRequest`)
- No process manipulation (`process.exit`, `child_process`)
- No dangerous globals (`eval`, `Function` constructor)

**Error:**

```json
{
  "code": "UNSAFE_JAVASCRIPT_CODE",
  "message": "JavaScript code contains forbidden API: require",
  "severity": "error",
  "flowId": "flow-custom",
  "stageId": "extract",
  "forbiddenAPI": "require",
  "line": 5
}
```

**Fix:** Remove forbidden APIs from JavaScript code

### Tenant Limits Validation

**Rule 15: Maximum Flows Per Pipeline**

**Requirement:** Max 10 flows per pipeline

**Error:**

```json
{
  "code": "TOO_MANY_FLOWS",
  "message": "Pipeline exceeds maximum allowed flows: 11 (max: 10)",
  "severity": "error",
  "flowCount": 11,
  "maxFlows": 10
}
```

**Fix:** Remove flows or consolidate similar flows

**Rule 16: Maximum Stages Per Flow**

**Requirement:** Max 20 stages per flow

**Error:**

```json
{
  "code": "TOO_MANY_STAGES",
  "message": "Flow 'flow-pdf' exceeds maximum allowed stages: 22 (max: 20)",
  "severity": "error",
  "flowId": "flow-pdf",
  "stageCount": 22,
  "maxStages": 20
}
```

**Fix:** Remove unnecessary stages or split into multiple flows

**Rule 17: Maximum Selection Rules Per Flow**

**Requirement:** Max 10 selection rules per flow

**Why:** Evaluation performance (<100ms flow selection target)

**Error:**

```json
{
  "code": "TOO_MANY_SELECTION_RULES",
  "message": "Flow 'flow-pdf' exceeds maximum allowed selection rules: 12 (max: 10)",
  "severity": "error",
  "flowId": "flow-pdf",
  "ruleCount": 12,
  "maxRules": 10
}
```

**Fix:** Consolidate selection rules using compound CEL expressions

**Rule 18: Priority Range**

**Requirement:** Priority must be 0-100 (inclusive)

**Error:**

```json
{
  "code": "PRIORITY_OUT_OF_RANGE",
  "message": "Flow 'flow-pdf' priority out of range: 150 (must be 0-100)",
  "severity": "error",
  "flowId": "flow-pdf",
  "priority": 150,
  "minPriority": 0,
  "maxPriority": 100
}
```

**Fix:** Set priority between 0-100

### Validation API

**POST /api/projects/:projectId/search/pipelines/:pipelineId/validate**

**Request:** Pipeline definition (before save)

**Response:**

```json
{
  "valid": false,
  "errors": [
    {
      "code": "DUPLICATE_PRIORITY",
      "message": "Flows 'flow-pdf' and 'flow-html' have same priority: 100",
      "severity": "error",
      "affectedFlows": ["flow-pdf", "flow-html"]
    },
    {
      "code": "INVALID_CEL_EXPRESSION",
      "message": "CEL expression failed to compile: syntax error",
      "severity": "error",
      "flowId": "flow-pdf",
      "ruleIndex": 0
    }
  ],
  "warnings": [
    {
      "code": "NO_DEFAULT_FLOW",
      "message": "No default fallback flow found",
      "severity": "warning",
      "recommendation": "Add flow with priority 0 and rule: true"
    }
  ]
}
```

**UI Behavior:**

- **Errors:** Block save, show error messages inline
- **Warnings:** Allow save, show yellow warning indicators

### Example Validation Errors

**Example 1: Invalid CEL Expression**

**Configuration:**

```json
{
  "flows": [
    {
      "id": "flow-pdf",
      "selectionRules": [
        {
          "celExpression": "doc.contentType = 'application/pdf'" // Wrong: = instead of ==
        }
      ]
    }
  ]
}
```

**Error:**

```json
{
  "code": "INVALID_CEL_EXPRESSION",
  "message": "CEL expression failed to compile: syntax error at position 18, expected '==' got '='",
  "severity": "error",
  "flowId": "flow-pdf",
  "ruleIndex": 0,
  "expression": "doc.contentType = 'application/pdf'",
  "suggestion": "Use '==' for equality comparison"
}
```

**Example 2: Missing Required Stage**

**Configuration:**

```json
{
  "flows": [
    {
      "id": "flow-pdf",
      "stages": [
        { "id": "chunk", "type": "chunking" } // Missing extraction stage
      ]
    }
  ]
}
```

**Error:**

```json
{
  "code": "MISSING_REQUIRED_STAGE",
  "message": "Flow 'flow-pdf' missing required stage type: extraction",
  "severity": "error",
  "flowId": "flow-pdf",
  "missingStage": "extraction",
  "requiredStages": ["extraction", "chunking"]
}
```

### Cross-References

**Related Sections:**

- [Provider System](#provider-system) - Provider configurations validated
- [Constraints](#constraints) - Tenant limits enforced during validation
- [Default Flows](#default-flows) - Default flows pre-validated

**Note:** Detailed validation service implementation (CEL library choice, validation algorithms) deferred to design document.

---

## Job Tracking Integration

Job tracking for flow-based pipelines is fully specified in **RFC-006 (BullMQ Flows Integration)** and **RFC-005 (Job Tracking Architecture)**. This section provides a brief cross-reference showing how pipeline context flows through the system.

### Complete Specification

**See:** `docs/searchai/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md`

RFC-006 defines:

- `JobExecution` schema with pipeline/flow context fields
- Flat schema design (no parent-child links)
- Zero worker changes (instrumentation handles tracking)
- Query patterns for document history, flow execution, source summaries

### Pipeline Context Flow

**Document Ingestion → Job Data:**

```typescript
// When document arrives
const document = await SearchDocument.create({...});

// Flow selection
const selectedFlow = await selectFlow(pipeline, document);

// Job data includes pipeline context
const jobData = {
  documentId: document._id.toString(),
  pipelineId: pipeline._id.toString(),  // ← Pipeline ID
  pipelineVersion: pipeline.version,     // ← Pipeline version
  flowId: selectedFlow.id,               // ← Selected flow ID
  tenantId,
  indexId,
  sourceUrl: document.sourceUrl
};

// Enqueue to BullMQ
await flowQueue.add(`flow:${selectedFlow.id}:${document._id}`, jobData);
```

**Job Data → JobExecution:**

```typescript
// Instrumentation wrapper (automatic, no worker changes)
const jobExecution = await JobExecution.create({
  bullJobId: job.id,
  workerStage: 'extraction',
  status: 'processing',

  // Context fields (from job data)
  documentId: job.data.documentId,
  pipelineId: job.data.pipelineId, // ← Tracked
  pipelineVersion: job.data.pipelineVersion, // ← Tracked
  flowId: job.data.flowId, // ← Tracked
  flowJobId: job.parentKey, // ← BullMQ flow parent ID

  tenantId: job.data.tenantId,
  indexId: job.data.indexId,
  sourceId: job.data.sourceId,
});
```

### Key Query Patterns

**1. Document History (All jobs for document):**

```typescript
const jobs = await JobExecution.find({
  documentId,
  tenantId,
}).sort({ createdAt: -1 });

// Shows: which pipeline, which flow, which stages executed
```

**2. Flow Execution Count:**

```typescript
const count = await JobExecution.countDocuments({
  pipelineId,
  flowId,
  workerStage: 'extraction',
  status: 'completed',
  tenantId,
});

// Shows: how many documents processed by flow
```

**3. Pipeline Version Tracking:**

```typescript
const jobs = await JobExecution.find({
  pipelineId,
  pipelineVersion: 5, // Specific version
  tenantId,
});

// Shows: which documents processed by pipeline v5
```

### No Worker Changes Needed

**Critical:** Workers do NOT need code changes for job tracking.

**Why:** Instrumentation wrapper automatically creates `JobExecution` records from job context.

**Worker receives same job data:**

```typescript
// Worker code (unchanged)
async function extractionWorker(job) {
  const { documentId, sourceUrl, tenantId } = job.data;
  // ... extraction logic (no tracking code)
}
```

**Instrumentation wrapper (automatic):**

```typescript
// Before worker
await JobExecution.create({...});  // Start tracking

// Worker executes
await extractionWorker(job);

// After worker
await JobExecution.updateOne({...}, { status: 'completed' });  // End tracking
```

### Cross-References

**Related RFCs:**

- **RFC-006:** BullMQ Flows Integration (complete job tracking specification)
- **RFC-005:** Job Tracking Architecture (flat schema design)

**Related Sections:**

- [Execution Model](#execution-model) - BullMQ flow execution with job context
- [Data Models](#data-models) - Pipeline and flow data structures

---

## Implementation Guide

### Phase 1: Data Models (Week 1)

1. Add `PipelineFlow` interface to database models
2. Update `PipelineDefinition` schema with `flows` array and `sharedStages`
3. Add `flowId` and `enrichmentFlowId` to `ISearchChunk`
4. Create database migration script

### Phase 2: Flow Selection Service (Week 1-2)

1. Implement `FlowSelector` class with priority-based algorithm
2. Add CEL expression evaluation for selection rules
3. Add flow selection tests (unit + integration)

### Phase 3: Flow Builder Integration (Week 2-3)

1. Update `PipelineFlowBuilder` to build flow-specific trees
2. Add shared stage inheritance logic
3. Update job data with `flowId`
4. Test flow tree generation

### Phase 4: Worker Updates (Week 3-4)

1. Update workers to accept `flowId` in job data
2. Update enrichment worker to use `providerConfig` from job data (no code change, just verification)
3. Remove legacy KG enqueue from enrichment-worker.ts (lines 164-187)

### Phase 5: Manual Trigger APIs (Week 4-5)

1. Implement POST `/api/.../reprocess` endpoint
2. Add 3 trigger types: extraction, enrichment, indexing
3. Add scope options: all, flow, selected
4. Test manual triggers with each scope

### Phase 6: Live Monitoring APIs (Week 5-6)

1. Implement GET `/api/.../processing-status` endpoint
2. Implement WebSocket `/api/.../processing-events`
3. Add flow-level and document-level aggregations
4. Test real-time updates

### Phase 7: UI Components (Week 6-8)

1. Pipeline configuration UI (flow list, flow editor)
2. Manual trigger UI (2 locations)
3. Live monitoring dashboard (2 views)
4. Integration tests

---

## Non-Functional Requirements

Non-functional requirements define system boundaries, performance targets, and quality attributes that constrain architectural decisions.

### NFR-1: Performance

**Goal:** Flow-based architecture must not degrade document processing performance

#### Flow Selection Performance

**Requirement:** Flow selection < 100ms p95 per document

**Why:** Flow selection happens before document processing starts. Slow selection delays entire pipeline.

**Constraints:**

- Priority-based evaluation (highest first, stop at first match)
- CEL expressions compiled once at pipeline save-time (not per document)
- Provider registry cached in memory (not DB lookup per job)
- Selection rules evaluated sequentially (not exhaustively)

**Measurement:**

```typescript
const start = performance.now();
const selectedFlow = await selectFlow(pipeline, document);
const duration = performance.now() - start;
// duration must be < 100ms for p95
```

**Note:** Caching strategy and query optimization deferred to design document.

#### Throughput

**Requirement:** Support 100K+ documents/day per tenant

**Why:** Large enterprises ingest thousands of documents daily

**Constraints:**

- Horizontal scaling (add more workers)
- BullMQ distributed queue (not single-process bottleneck)
- No global locks (per-tenant isolation)

**Measurement:** Documents processed per day (aggregated from `JobExecution` records)

#### Latency

**Requirement:** No regression vs current pipeline (2-3 min per doc average)

**Why:** Users expect same or better performance with flow-based architecture

**Baseline:** Current average: 2-3 minutes per document (extraction 1-2 min, chunking 10s, enrichment 30-60s, embedding 10s, indexing 10s)

**Measurement:** End-to-end document processing time (document created → indexed)

### NFR-2: Security

**Goal:** Protect tenant data and prevent unauthorized access

#### Tenant Isolation

**Requirement:** All pipeline queries must include `tenantId` filter

**Why:** Prevents cross-tenant data access

**Implementation:**

```typescript
// ✅ CORRECT
const pipeline = await PipelineDefinition.findOne({
  _id: pipelineId,
  tenantId, // Always include
});

// ❌ WRONG
const pipeline = await PipelineDefinition.findById(pipelineId);
// Missing tenantId check
```

**Enforcement:** Database plugin enforces `tenantId` in all queries

#### Selection Rule Field Access

**Requirement:** CEL expressions cannot access sensitive fields

**Blacklist:**

- `doc.tenantId` - Tenant ID (security risk)
- `doc._id` - Document ID (security risk)
- `doc.credentials` - Credentials (security risk)

**Whitelist:**

- `doc.contentType` - MIME type
- `doc.contentSizeBytes` - File size
- `doc.sourceMetadata.*` - User-defined metadata
- `doc.originalReference` - Filename/URL

**Enforcement:** Validation at save-time, CEL expressions rejected if accessing blacklisted fields

#### JavaScript Sandbox

**Requirement:** Custom JavaScript providers must run in sandbox with no filesystem/network access

**Constraints:**

- Timeout: 10 seconds max
- Memory: 128MB max
- No `require()` / `import` (no npm packages)
- No filesystem access (`fs`, `path`, `child_process`)
- No network access (`http`, `https`, `fetch`, `XMLHttpRequest`)
- No dangerous globals (`eval`, `Function` constructor, `process`)

**Enforcement:** Sandbox library (isolated-vm or vm2) with whitelist of allowed APIs

**Note:** Sandbox library choice and exact limits deferred to design document.

#### HTTP Webhook Security

**Requirement:** HTTP webhooks must use HTTPS and have configurable timeout

**Constraints:**

- HTTPS only (no HTTP)
- Configurable timeout (default: 30s, max: 5 minutes)
- No access to internal network (no `localhost`, `127.0.0.1`, `10.*`, `192.168.*`)
- Auth tokens encrypted at rest

**Enforcement:** Validation at save-time (HTTPS check), network policies block internal IPs

**Note:** HTTP auth methods (Bearer, API key, OAuth) and token rotation deferred to design document.

### NFR-3: Observability

**Goal:** Provide visibility into pipeline execution for debugging and monitoring

#### Trace Events

**Requirement:** Emit trace events for key pipeline execution points

**Flow-Specific Events:**

- `flow_selection` - Which flow selected, why (priority, matched rule)
- `flow_execution_start` - Flow begins processing document
- `flow_execution_complete` - Flow finished, chunks created
- `stage_skip` - Stage skipped due to `executionCondition`
- `stage_execution` - Stage executed (existing)
- `stage_error` - Stage failed (existing)

**Example:**

```typescript
traceStore.emit({
  type: 'flow_selection',
  flowId: selectedFlow.id,
  flowName: selectedFlow.name,
  priority: selectedFlow.priority,
  matchedRule: 'doc.contentType == "application/pdf"',
  documentId: document._id,
  tenantId,
  timestamp: new Date(),
});
```

**Note:** Trace event schema and format deferred to design document.

#### Metrics

**Requirement:** Track execution metrics per flow

**Per-Flow Metrics:**

- Execution count (documents processed by flow)
- Success rate (percentage of successful executions)
- Duration p50/p95/p99 (latency distribution)
- Error rate (percentage of failed executions)

**Example Queries:**

```typescript
// Flow execution count
const count = await JobExecution.countDocuments({
  pipelineId,
  flowId,
  status: 'completed',
  tenantId,
});

// Flow success rate
const total = await JobExecution.countDocuments({ pipelineId, flowId, tenantId });
const successful = await JobExecution.countDocuments({
  pipelineId,
  flowId,
  status: 'completed',
  tenantId,
});
const successRate = (successful / total) * 100;
```

**Note:** Metrics collection library (Prometheus, StatsD) deferred to design document.

#### Structured Logs

**Requirement:** All logs include pipeline context (pipelineId, flowId, stageId, documentId)

**Example:**

```typescript
logger.info('Stage executed', {
  pipelineId: pipeline._id,
  flowId: selectedFlow.id,
  stageId: stage.id,
  documentId: document._id,
  tenantId,
  duration: 1234,
  status: 'completed',
});
```

**Format:** JSON logs for machine parsing

**Note:** Logging library choice (Winston, Pino) deferred to design document.

#### Flow Simulation Mode

**Requirement:** Dry-run mode to test flow selection without processing documents

**Example:**

```typescript
// Simulate flow selection
const result = await simulateFlowSelection(pipeline, {
  contentType: 'application/pdf',
  contentSizeBytes: 5000000,
});

// Result: { flowId: 'flow-pdf', flowName: 'PDF Processing', matchedRule: '...' }
```

**UI:** Upload sample document → Preview which flow selected

### NFR-4: Reliability

**Goal:** Prevent pipeline failures from affecting document processing

#### Circuit Breaker Per Flow

**Requirement:** If flow fails repeatedly, disable flow and route to fallback

**Pattern:**

- Track failure rate per flow (last 10 executions)
- If failure rate > 30%, open circuit (disable flow)
- Route documents to default fallback flow (priority 0)
- Periodically test if circuit can close (every 5 minutes)

**Example:**

```typescript
// Circuit breaker state
{
  flowId: 'flow-pdf',
  state: 'open',  // open | closed | half-open
  failureCount: 8,
  lastFailure: new Date(),
  nextRetry: new Date(Date.now() + 300000)  // 5 minutes
}
```

**Note:** Circuit breaker algorithm and failure threshold deferred to design document.

#### Save-Time Validation

**Requirement:** Validate pipeline configuration before activation

**Why:** Catch errors before they affect production

**Validation:**

- Flow selection rules compile (CEL)
- Providers exist in registry
- Required stages present (extraction, chunking)
- Flow priorities unique

**See:** [Pipeline Validation](#pipeline-validation) section

#### Per-Stage Retry Configuration

**Requirement:** Configurable retry policy per stage type

**Default Retries:**

- Extraction: 3 attempts (exponential backoff: 2s, 4s, 8s)
- Chunking: 2 attempts (fixed delay: 1s)
- Enrichment: 3 attempts (exponential backoff: 2s, 4s, 8s)
- Embedding: 2 attempts (fixed delay: 1s)
- Indexing: 3 attempts (exponential backoff: 1s, 2s, 4s)

**Configuration:**

```typescript
{
  "stages": [
    {
      "id": "extract",
      "type": "extraction",
      "retry": {
        "maxAttempts": 3,
        "backoff": "exponential",
        "initialDelay": 2000
      }
    }
  ]
}
```

**Note:** Retry formula and backoff algorithm deferred to design document.

#### Dead Letter Queue

**Requirement:** Failed documents routed to DLQ for manual review

**Why:** Prevent data loss from unrecoverable errors

**DLQ Pattern:**

- After max retry attempts exhausted, move job to DLQ
- DLQ stored in BullMQ failed queue
- Admin UI shows failed documents with error details
- Option to retry from DLQ after fixing issue

### NFR-5: Usability

**Goal:** Make pipeline configuration intuitive and error-free

#### Flow List View

**Requirement:** Show all flows with priority, selection rules, enabled/disabled status

**UI:**

```
Flows (4)
  [✓] Document Processing  | Priority: 100 | Rules: contentType = PDF, DOCX, HTML
  [✓] Image Processing     | Priority: 90  | Rules: contentType = image/*
  [✓] Plain Text           | Priority: 80  | Rules: contentType = text/plain, markdown
  [✓] Default Fallback     | Priority: 0   | Rules: (catch-all)
```

**Actions:** Enable/disable, edit, delete, reorder (change priority)

#### Flow Editor

**Requirement:** Visual or form-based flow configuration

**Components:**

- Flow name, description, priority
- Selection rules builder (no-code CEL expression builder)
- Stage list (drag-and-drop reordering)
- Provider selection per stage (dropdown with config form)

**Note:** UI component library (React Flow, D3.js) deferred to design document.

#### Flow Simulation

**Requirement:** Test flow selection before saving

**UI:**

```
Test Flow Selection
  Upload sample file: [Choose File] report.pdf
  [Simulate]

Result:
  Selected Flow: Document Processing (Priority 100)
  Matched Rule: doc.contentType == 'application/pdf'
  Provider: Docling
  Estimated Cost: $0.05 per 1K docs
```

**Benefit:** Preview routing before activation

#### Cost Estimator Per Flow

**Requirement:** Show estimated cost per 1K documents for each flow

**Calculation:**

- LLM calls (enrichment): $0.01-0.10 per doc (model-dependent)
- Embedding calls: $0.0001-0.001 per doc (dimensions-dependent)
- HTTP webhooks: Variable (user-provided estimate)

**Display:**

```
Flow: PDF Processing
  Extraction (Docling): $0.01
  Enrichment (GPT-4): $0.03
  Embedding (BGE-M3): $0.0001
  Total: ~$0.04 per 1K docs
```

**Note:** Cost calculation algorithm and pricing data deferred to design document.

#### Manual Trigger UI

**Requirement:** Manual triggers accessible from 2 locations

**Location 1: Pipeline Page**

- "Re-process All Documents" button
- Options: Full extraction / Re-enrichment / Re-indexing

**Location 2: Documents Page**

- Bulk select documents
- "Re-process Selected" button
- Same options as Location 1

**See:** [Manual Triggers](#manual-triggers-3-entry-points) section

### Cross-References

**Related Sections:**

- [Provider System](#provider-system) - JavaScript sandbox and HTTP webhook security
- [Pipeline Validation](#pipeline-validation) - Save-time validation requirements
- [Constraints](#constraints) - System limits enforced by NFRs

**Note:** Detailed implementation (libraries, algorithms, formulas) deferred to design document.

---

## Constraints

Constraints define system boundaries and limits. They are architectural commitments that affect implementation choices and system behavior.

### Technical Constraints

**1. BullMQ Flows Architecture (Must Use)**

**Requirement:** Must use BullMQ Flows for orchestration (not Restate, Temporal, or other alternatives)

**Why:**

- BullMQ already integrated (existing infrastructure)
- Restate rejected due to complexity and cost
- Flow tree built at document ingestion time (upfront orchestration)

**Impact:**

- Job data format constrained by BullMQ API
- Redis-backed queue (not separate orchestration service)
- Worker patterns follow BullMQ conventions

**Note:** See `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md` for production considerations

**2. Worker Backward Compatibility (No Breaking Changes)**

**Requirement:** Existing 17 workers must remain unchanged

**Why:**

- Workers are stable and tested
- No business logic changes needed
- Flow orchestration happens outside workers

**Impact:**

- Workers receive same job data format (with optional additional fields)
- Job data additions: `pipelineId`, `pipelineVersion`, `flowId` (optional, ignored by workers)
- No worker code changes required

**Validation:**

```typescript
// Worker receives (unchanged):
{
  documentId,
  sourceUrl,
  tenantId,
  indexId,
  // NEW (optional, workers ignore):
  pipelineId?,
  flowId?
}
```

**3. MongoDB Schema (Flat, No Parent-Child)**

**Requirement:** Pipeline definitions stored in MongoDB, job tracking uses flat schema

**Why:**

- MongoDB already used for data models
- Flat schema avoids hot document problems (RFC-005)
- Time ordering + context fields sufficient for queries

**Impact:**

- `PipelineDefinition` stored in `abl_platform` database
- `JobExecution` stored in `search_ai` database (flat schema)
- No parent-child links in job tracking (context fields instead)

**See:** RFC-005 (Job Tracking Architecture) for flat schema design rationale

**4. Query Pipeline Exclusion (Phase 1-2)**

**Requirement:** Query pipeline NOT using pluggable system in Phase 1-2

**Why:**

- Query pipeline synchronous HTTP handlers (not async jobs)
- Different architecture needed (configuration-based, not flow-based)
- Separate concerns (ingestion vs query)

**Scope:**

- ✅ **In Scope:** Ingestion pipeline (extraction → chunking → enrichment → embedding → indexing)
- ❌ **Out of Scope:** Query pipeline (search, RAG, answer generation)

**Phase 3+:** Query pipeline may adopt pluggable approach with different design

### Business Constraints

**1. Tenant Limits**

| Limit                         | Value | Rationale                                         |
| ----------------------------- | ----- | ------------------------------------------------- |
| Max pipelines per tenant      | 10    | One pipeline per KB, max 10 KBs per tenant        |
| Max flows per pipeline        | 10    | UI performance (flow list), validation complexity |
| Max stages per flow           | 20    | Query performance (graph traversal depth)         |
| Max total stages per pipeline | 100   | Across all flows (10 flows × 10 avg stages)       |
| Max selection rules per flow  | 10    | Evaluation performance (<100ms target)            |
| Priority range                | 0-100 | Deterministic selection, UI constraints (slider)  |
| Max nested condition levels   | 5     | CEL expression complexity limit                   |

**Enforcement:** Validation at save-time, errors block pipeline activation

**Example Error:**

```json
{
  "code": "TOO_MANY_FLOWS",
  "message": "Pipeline exceeds maximum allowed flows: 11 (max: 10)"
}
```

**2. Custom Code Limits**

**JavaScript Sandbox:**

- Timeout: 10 seconds max
- Memory: 128MB max
- No npm packages (built-in APIs only)
- No filesystem access
- No network access

**HTTP Webhooks:**

- Timeout: 5 minutes max (default: 30 seconds)
- HTTPS only (no HTTP)
- No internal network access (`localhost`, `10.*`, `192.168.*`)
- Max 3 retry attempts

**Enforcement:** Sandbox library enforces limits, validation checks HTTPS at save-time

**3. Cost Considerations**

**No Vendor Lock-In:**

- Must support multiple providers per stage type
- Docling, LlamaIndex, HTTP webhooks, custom JavaScript
- Users can switch providers without code changes

**Show Cost Estimates:**

- Cost estimator per flow in UI
- Show cost per 1K documents based on selected providers
- Breakdown: LLM calls, embedding dimensions, HTTP webhooks

**Default Flow Optimized for Cost:**

- Default flows use cost-effective providers
- BGE-M3 embeddings (self-hosted, no API costs)
- Optional enrichment (users enable if needed)
- Target: <$0.10 per 1K docs for default configuration

**Example Cost Estimate:**

```
Flow: PDF Processing
  Extraction (Docling): $0.01
  Enrichment (GPT-4): $0.03 (optional)
  Embedding (BGE-M3): $0.0001 (self-hosted)
  Total: ~$0.01-0.04 per 1K docs
```

### Flow-Specific Constraints

**1. Convergence Requirement**

**Requirement:** All flows must converge to common `ISearchChunk` schema

**Why:**

- Manual triggers query chunks by `flowId`
- Indexing expects consistent chunk format
- Cross-flow querying impossible without common schema

**Schema:**

```typescript
interface ISearchChunk {
  // Common fields (all flows)
  documentId: ObjectId;
  content: string;
  embedding: number[];

  // Flow tracking (NEW)
  flowId?: string;
  enrichmentFlowId?: string;

  // Metadata
  metadata?: Record<string, any>;
}
```

**Constraint:** Cannot have flow-specific chunk fields (except `flowId`, `enrichmentFlowId`)

**2. Mandatory Stages Per Flow**

**Requirement:** Every flow must have extraction + chunking stages

**Why:** Flows converge to chunks checkpoint

**Enforcement:** Validation at save-time

**Error:**

```json
{
  "code": "MISSING_REQUIRED_STAGE",
  "message": "Flow 'flow-pdf' missing required stage type: extraction"
}
```

**3. Priority Uniqueness**

**Requirement:** All flow priorities must be unique within pipeline

**Why:** Deterministic flow selection, no ambiguous routing

**Enforcement:** Validation at save-time

**Error:**

```json
{
  "code": "DUPLICATE_PRIORITY",
  "message": "Flows 'flow-pdf' and 'flow-html' have same priority: 100"
}
```

**4. Selection Rule Constraints**

**CEL Expressions:**

- Must compile successfully (syntax check)
- Can only access whitelisted fields (see NFR-2: Security)
- Max 10 rules per flow (performance constraint)
- Max 5 nested condition levels (complexity limit)

**Example Valid Rule:**

```javascript
doc.contentType == 'application/pdf' && doc.contentSizeBytes > 10000000;
```

**Example Invalid Rule:**

```javascript
doc.tenantId == '12345'; // ❌ Cannot access tenantId (security)
```

**5. Sequential Execution (No Branching)**

**Requirement:** Stages within flow execute sequentially (array order), no branching

**Why:**

- Simple mental model
- Predictable execution
- FR-4 (Conditional Stage Routing) deferred to Phase 2

**Branching Deferred:** Conditional execution (`executionCondition`) supported, but not branching (next stage selection based on output)

### Cross-References

**Related Sections:**

- [Pipeline Validation](#pipeline-validation) - Constraints enforced during validation
- [Non-Functional Requirements](#non-functional-requirements) - NFRs constrain system behavior
- [Default Flows](#default-flows) - Default flows respect constraints

**Related RFCs:**

- RFC-005 (Job Tracking) - Flat schema design (avoids parent-child constraint)
- RFC-006 (Flows Integration) - BullMQ Flows architecture constraint

**Note:** This section defines **what** constraints exist. Design document defines **how** to enforce them.

---

## Success Criteria

Success criteria define measurable outcomes that indicate project success. This section provides brief context on adoption and performance goals, with detailed metrics tracked separately.

### Adoption Goals

**3 Months:**

- 20% of tenants use multi-flow pipelines (not just default single flow)
- At least 2 flows per pipeline on average (demonstrates value of flow-based model)

**6 Months:**

- 50% of tenants use multi-flow pipelines
- 30% of tenants use manual triggers (re-enrichment, re-indexing)

**12 Months:**

- Average 2.5 flows per pipeline across all tenants
- 50% chunk savings from manual triggers (avoided re-extraction)

**Why These Goals:**

- Multi-flow adoption shows users finding value in conditional routing
- Manual trigger usage demonstrates chunks as effective restart point
- Flow count indicates complexity of document processing needs

### Manual Trigger Adoption

**Goal:** Manual triggers save time and cost vs full re-extraction

**Metrics:**

- 30% of re-processing uses Entry Point 2 or 3 (skip extraction)
- Average time savings: <5 minutes for re-enrichment (vs 30 minutes full extraction)

**Example:**

- Full extraction (Entry Point 1): 30 minutes (fetch source → extract → chunk → enrich → embed → index)
- Re-enrichment (Entry Point 2): 5 minutes (query chunks → enrich → embed → index)
- Savings: 25 minutes (83% faster)

### Performance Targets

**See:** [Non-Functional Requirements](#non-functional-requirements) for complete performance specification

**Key Targets:**

- Flow selection: <100ms p95
- Throughput: 100K+ docs/day per tenant
- No latency regression vs current pipeline (2-3 min per doc)
- Manual trigger latency: Re-enrichment <5 minutes average

**Why:** Performance targets ensure flow-based architecture doesn't degrade user experience

### Quality Targets

**See:** [Non-Functional Requirements](#non-functional-requirements) for complete quality specification

**Key Targets:**

- Uptime: 99.9% (circuit breaker per flow prevents cascading failures)
- Validation coverage: 100% of breaking changes detected at save-time
- Security incidents: 0 sandbox escapes (JavaScript providers)

**Why:** Quality targets ensure system reliability and security

### Business Metrics

**Note:** Detailed business metrics tracked in separate product success document

**Brief Summary:**

- Cost reduction: 30% average per tenant (optional stages removed, targeted enrichment)
- Support tickets: <5% related to pipeline configuration (usability validation)

**For Complete Business Metrics:** See product success metrics document (separate from technical RFC)

### Cross-References

**Related Sections:**

- [Non-Functional Requirements](#non-functional-requirements) - Technical performance and quality targets
- [Default Flows](#default-flows) - Default flows provide baseline for adoption
- [Manual Triggers](#manual-triggers-3-entry-points) - Manual trigger usage metrics

**Note:** Success criteria provide context for "why we're building this." Detailed tracking and dashboards defined separately.

---

## Migration Path

### Existing Pipelines → Flow-Based

**Current:** Flat 17-stage pipeline per index

**New:** One pipeline per KB with multiple flows

**Migration Strategy:**

```typescript
async function migratePipelineToFlowBased(
  oldPipeline: OldPipelineDefinition,
): Promise<PipelineDefinition> {
  // Create default flow with all existing stages
  const defaultFlow: PipelineFlow = {
    id: 'flow-default-migration',
    name: 'Default (Migrated)',
    priority: 10,
    enabled: true,

    // Match all documents
    selectionRules: [
      {
        type: 'cel',
        celExpression: 'true',
      },
    ],

    // Copy all extraction/chunking stages
    stages: oldPipeline.stages.filter(
      (s) => s.type === 'document_extraction' || s.type === 'chunking',
    ),

    // No custom enrichment/indexing (use shared)
    customEnrichment: undefined,
    customIndexing: undefined,
  };

  // Create shared stages from old enrichment/indexing
  const sharedStages = {
    enrichment: oldPipeline.stages.find((s) => s.type === 'enrichment'),
    indexing: oldPipeline.stages.find((s) => s.type === 'embedding'),
  };

  return {
    ...oldPipeline,
    knowledgeBaseId: oldPipeline.indexId, // Migrate from index-level to KB-level
    flows: [defaultFlow],
    sharedStages,
  };
}
```

**Users can then:**

1. Split default flow into per-MIME-type flows
2. Add custom enrichment per flow
3. Add conditional stages
4. Optimize per-flow settings

---

## Conclusion

Flow-based pipeline architecture enables:

- ✅ **Per-document-type customization** (PDF → Docling, HTML → LlamaIndex)
- ✅ **Cost optimization** (skip enrichment on simple files)
- ✅ **Faster re-processing** (chunks as restart point)
- ✅ **Flexible routing** (medical → HIPAA, financial → standard)
- ✅ **Shared stage inheritance** (DRY principle, no worker changes)

**Next Steps:**

1. Review this RFC (Task #16)
2. Consolidate requirements (Task #17)
3. Update design document (Task #18)
4. Update UI/UX document (Task #19)
5. Begin implementation (Phase 1)

---

**End of RFC-004: Flow-Based Pipeline Architecture**
