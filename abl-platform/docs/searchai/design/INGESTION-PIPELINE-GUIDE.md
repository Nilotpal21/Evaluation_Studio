# SearchAI Ingestion Pipeline Guide

> **Status Legend:** Items marked with ✅ are implemented today. Items marked 🚧 are partially implemented or under testing. Items marked 🔮 are planned but not yet available.

## Scene 1: The Problem

Meet LegalMind AI, a legal tech company building an AI-powered research assistant. Their knowledge base contains over 50,000 documents: scanned PDF contracts, Word-format internal memos, HTML regulatory updates scraped from government sites, and spreadsheets tracking case databases and billing records. Four fundamentally different document types, each with its own structure, its own quirks, and its own extraction requirements.

The naive approach is tempting: run every document through the same extraction, split it into chunks of the same size, generate embeddings with the same model, and call it a day. Here is why that fails spectacularly.

**Scanned PDFs need OCR.** A contract scanned from paper contains no machine-readable text. Without optical character recognition, your extraction stage returns nothing. Your search index is blind to 12,000 contracts.

**Contracts need clause-level chunking.** A 40-page vendor agreement has clauses like "Limitation of Liability" and "Indemnification" that must be kept together. Generic 512-token chunking splits a critical clause across two chunks, and now your AI cites half a sentence when a lawyer asks "What are the indemnification terms?"

**Spreadsheets need row-level processing.** A billing record spreadsheet is not prose. Breaking it into overlapping text chunks creates nonsensical fragments. Each row is a discrete record and should be treated as one.

**HTML needs tag stripping and section awareness.** A regulatory update page from the SEC has navigation bars, footers, cookie banners, and the actual regulation. Without HTML-aware extraction, your search results include "Accept Cookies | Privacy Policy" alongside securities law.

The cost of getting this wrong: poor search results, missed clauses in legal review, hallucinated answers from malformed chunks, and ultimately, a product that lawyers cannot trust.

LegalMind needs each document type processed through its own optimized path. That is exactly what ingestion pipelines provide.

---

## Scene 2: Enter Ingestion Pipelines

An ingestion pipeline is the processing assembly line that turns a raw document into searchable, indexed knowledge. Every document that enters your knowledge base passes through one.

The pipeline has four stages, always in this order:

```
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │  Extraction  │ -> │   Chunking   │ -> │  Enrichment  │ -> │  Embedding   │
 │              │    │              │    │              │    │              │
 │  Raw file    │    │  Full text   │    │  Chunks with │    │  Chunks with │
 │  to text     │    │  to chunks   │    │  metadata    │    │  vectors     │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

**Extraction** converts the raw file (PDF, DOCX, HTML, image) into machine-readable text. Providers like Docling handle complex layouts, tables, and OCR. A fallback provider like LlamaIndex catches simpler formats.

**Chunking** splits the extracted text into pieces sized for retrieval. Tree-builder chunking preserves document structure (headings, sections, clauses). Token-based chunking is simpler and works well for prose.

**Enrichment** adds metadata to each chunk using LLM calls: summaries, entity extraction, question synthesis. This is optional per flow -- if it fails, the chunk is still usable. All seven enrichment services load prompts from versioned YAML templates in `apps/search-ai/src/prompts/v1/` via `PromptLoaderService`, and resolve LLM credentials per-use-case through `resolveIndexLLMConfig(tenantId, indexId)` using the use case key from `USE_CASE_DEFAULTS`.

**Embedding** generates vector representations of each chunk so they can be found by semantic search. The embedding model and dimensions must be consistent across the entire pipeline.

Each stage is **pluggable**. You can swap the extraction provider from Docling to a custom OCR service without touching the chunking, enrichment, or embedding stages. The pipeline structure stays the same; only the provider changes.

> **Visual Processing.** Two additional workers run **after enrichment**, in parallel with embedding: a **vision worker** that analyzes full-page screenshots for layout understanding, and a **multimodal worker** that generates text descriptions of individual images, charts, and tables extracted by Docling. Both are opt-in features configured per knowledge base through the LLM Features settings (see Scene 9). A fifth stage type (`multimodal`) is defined in the pipeline schema for future integration into the pluggable flow system; today the workers run as standalone post-enrichment processors outside the flow builder.
>
> 🔮 **Future: Shared Stages.** The pipeline schema supports `sharedStages` — common enrichment and indexing stages that run for every flow regardless of flow-specific configuration. This avoids duplicating identical stages across flows. Not yet implemented.

---

## Scene 3: Flows -- One Pipeline, Many Paths

A single pipeline can contain multiple **flows**. Each flow is a complete processing path through the four stages, configured for a specific document type. When a document enters the pipeline, **flow selection** evaluates the document's properties and routes it to the right flow.

LegalMind creates four flows in their pipeline. All flows share the same embedding configuration (BGE-M3, 1024 dimensions) because embedding is set at the **pipeline level**, not per flow (see Scene 6):

| Flow                 | Extraction          | Chunking            | Enrichment              |
| -------------------- | ------------------- | ------------------- | ----------------------- |
| PDF Contract Flow    | Docling (OCR + PDF) | Clause-aware (tree) | Legal entity extraction |
| Word Memo Flow       | Docling (standard)  | Paragraph (512 tok) | Progressive summary     |
| HTML Regulatory Flow | HTML parser         | Section-based       | Regulation tagging      |
| Default (Catch-all)  | Docling + fallback  | Token-based (512)   | LLM enrichment          |

> The pipeline's `activeEmbeddingConfig` applies uniformly to all flows. Per-flow embedding providers are 🔮 **not supported today** — all chunks must use the same model and dimensions so that query-time vector comparison works correctly.

### How Flow Selection Works

Each flow has **selection rules** and a **priority** (1-100, higher evaluated first). When a document arrives, the system:

1. Filters out disabled flows
2. Sorts remaining flows by priority (highest first)
3. Evaluates each flow's selection rules against the document
4. Returns the **first match**
5. If nothing matches, falls back to the default flow (the one with no rules)

```
Document arrives (contract.pdf, application/pdf, source: "contracts")
  │
  ├─ Priority 90: PDF Contract Flow
  │    Rules: document.mimeType == "application/pdf" AND source.connector == "contracts"
  │    Result: MATCH -> Use this flow
  │
  ├─ Priority 70: Word Memo Flow          (not evaluated, already matched)
  ├─ Priority 50: HTML Regulatory Flow     (not evaluated)
  └─ Priority 0:  Default Flow             (not evaluated)
```

Selection rules come in three flavors:

- **Simple rules**: `document.extension eq "pdf"` -- a field, an operator, a value
- **Compound rules**: Combine simple rules with AND/OR logic
- **CEL expressions** 🚧: Full Common Expression Language for complex conditions like `document.mimeType.startsWith("application/") && document.size > 1000000` _(CEL evaluation is implemented but under active testing)_

The default flow has **no selection rules** and the lowest priority. It catches every document that does not match a more specific flow. Every pipeline must have at least one enabled flow, and having a default catch-all is strongly recommended.

---

## Scene 4: Configuring a Flow (Step by Step)

Let us walk through creating the "PDF Contract Flow" for LegalMind.

### Step 1: Define the Flow

```json
{
  "id": "flow-pdf-contracts",
  "name": "PDF Contract Processing",
  "description": "Optimized extraction and clause-aware chunking for scanned PDF contracts",
  "enabled": true,
  "priority": 90
}
```

Priority 90 means this flow is evaluated before most others. Only flows with priority 91-100 would be checked first.

### Step 2: Configure Each Stage

Each stage specifies a **provider** and its **configuration**:

```json
{
  "stages": [
    {
      "id": "stage-extract",
      "name": "Docling PDF Extraction",
      "type": "extraction",
      "provider": "docling",
      "providerConfig": {
        "extractTables": true,
        "extractImages": false,
        "preserveLayout": true,
        "supportedMimeTypes": ["application/pdf"]
      },
      "onError": "fail",
      "fallbackProvider": "llamaindex",
      "fallbackConfig": {}
    },
    {
      "id": "stage-chunk",
      "name": "Clause-Aware Chunking",
      "type": "chunking",
      "provider": "tree-builder",
      "providerConfig": {
        "maxChunkTokens": 1024,
        "overlap": 50
      },
      "onError": "fail"
    },
    {
      "id": "stage-enrich",
      "name": "Legal Entity Extraction",
      "type": "enrichment",
      "provider": "llm-enrichment",
      "providerConfig": {
        "useCase": "entityExtraction",
        "temperature": 0
      },
      "onError": "continue"
    },
    {
      "id": "stage-embed",
      "name": "Generate Embeddings",
      "type": "embedding",
      "provider": "bge-m3",
      "providerConfig": {
        "model": "bge-m3",
        "dimensions": 1024
      },
      "onError": "fail"
    }
  ]
}
```

> **Note:** The embedding stage's provider and dimensions must match the pipeline-level `activeEmbeddingConfig`. The system validates this at publish time. You configure embedding once at the pipeline level (Scene 6) and the embedding stage in each flow inherits that configuration.

Notice the `onError` settings. Extraction and chunking are set to `"fail"` -- if they break, the document cannot be processed and the flow should stop. Enrichment is set to `"continue"` -- if the LLM call fails, the chunk still has its text and can still be searched. Losing the entity metadata is not worth losing the entire document.

The extraction stage also has a `fallbackProvider`. If Docling fails (service down, unsupported format), the system automatically tries LlamaIndex as a backup.

### Step 3: Set Selection Rules

```json
{
  "selectionRules": [
    {
      "type": "compound",
      "logic": "AND",
      "conditions": [
        {
          "type": "simple",
          "field": "document.mimeType",
          "operator": "eq",
          "value": "application/pdf"
        },
        {
          "type": "simple",
          "field": "source.connector",
          "operator": "eq",
          "value": "contracts"
        }
      ],
      "description": "PDF files from the contracts source"
    }
  ]
}
```

This flow activates only when both conditions are true: the document is a PDF **and** it comes from the contracts source. A PDF from a different source (say, "invoices") would not match and would fall through to a lower-priority flow or the default.

### Step 4: Enable and Save

The flow is now part of the pipeline definition in `draft` status. It will not affect live processing until you publish it (covered in Scene 7).

---

## Scene 5: The Provider Registry

Providers are the pluggable implementations that do the actual work at each stage. Docling extracts text from PDFs. BGE-M3 generates embeddings. The tree-builder creates hierarchical chunks. Each provider implements a standard interface:

```typescript
interface PipelineStageProvider<TInput, TOutput, TConfig> {
  id: string; // 'docling', 'bge-m3', 'tree-builder'
  name: string; // 'Docling v2', 'BGE-M3 Embedding'
  type: SearchPipelineStageType; // 'extraction', 'embedding', etc.
  version: string; // '2.0.0'

  execute(input: TInput, config: TConfig): Promise<TOutput>;
  validateConfig(config: unknown): config is TConfig;
  getSchema(): JSONSchema;
}
```

Three methods matter:

- **`execute`** does the work. For an extraction provider, it takes a file buffer and returns extracted text. For an embedding provider, it takes text and returns vectors.
- **`validateConfig`** checks that the configuration object from the database matches what the provider expects. This runs at pipeline publish time to catch misconfiguration early.
- **`getSchema`** returns a JSON Schema describing the provider's configuration options. The Studio UI uses this schema to **dynamically generate configuration forms** -- no frontend code changes needed when a new provider is added.

### Provider Registry Status ✅

The provider registry pattern and `PipelineStageProvider` interface are fully implemented. Concrete provider adapters are being built on top of the existing extraction, chunking, enrichment, and embedding services that already power the ingestion pipeline today.

**Extraction and chunking** are handled by the existing Docling service (port 8080), tree-builder chunking, and LLM enrichment workers. **Embedding** is handled by BGE-M3 (port 8000) with OpenAI, Cohere, and custom provider support in the embedding configuration layer. The provider registry formalizes these into a pluggable interface.

### Planned Providers

| Stage      | Provider         | Description                                         | Status                 |
| ---------- | ---------------- | --------------------------------------------------- | ---------------------- |
| Extraction | `docling`        | Rich format extraction (PDF, DOCX, PPTX, HTML, OCR) | 🚧 Adapter in progress |
| Extraction | `llamaindex`     | Fallback for plain text and markdown                | 🔮 Planned             |
| Chunking   | `tree-builder`   | Structure-aware hierarchical chunking               | 🚧 Adapter in progress |
| Enrichment | `llm-enrichment` | LLM-powered summaries, entities, questions          | 🚧 Adapter in progress |
| Embedding  | `bge-m3`         | Self-hosted BGE-M3 model (1024 dimensions)          | ✅ Default             |
| Embedding  | `openai`         | OpenAI text-embedding-3 models                      | ✅ Supported           |
| Embedding  | `cohere`         | Cohere embed models                                 | ✅ Supported           |
| Embedding  | `custom`         | Custom embedding endpoint (self-hosted models)      | ✅ Supported           |

> The embedding providers (bge-m3, openai, cohere, custom) are fully functional in the `activeEmbeddingConfig` system today. The extraction, chunking, and enrichment providers work as standalone services — the provider registry adapters that wrap them into the `PipelineStageProvider` interface are being built.

### Adding a New Provider

To add a custom provider, implement the `PipelineStageProvider` interface, register it with the provider registry, and it becomes available in the Studio UI automatically. The JSON Schema you return from `getSchema()` drives the configuration form -- define your fields, their types, defaults, and constraints, and the UI renders the appropriate inputs.

---

## Scene 6: Embedding Configuration

Embedding is special. Unlike extraction or chunking, where each flow can use a different provider, the embedding configuration must be **consistent across the entire pipeline**. Here is why: when a user searches, the query is embedded using one model and compared against all stored vectors. If different flows used different embedding models with different dimensions, the vectors would be incompatible and search would break.

The pipeline definition has a top-level `activeEmbeddingConfig`:

```json
{
  "activeEmbeddingConfig": {
    "provider": "bge-m3",
    "model": "bge-m3",
    "dimensions": 1024
  }
}
```

This configuration is shared by every flow. The embedding stage in each flow **must** match this pipeline-level setting. The system enforces this at validation time.

> **Warning:** Changing the embedding provider or dimensions triggers a full reindex of every document in the knowledge base. For LegalMind's 50,000 documents, that means re-embedding every chunk. This is by design -- you cannot mix vectors from different models -- but it is an expensive operation. Change embedding configuration deliberately.

The supported embedding providers are:

| Provider | Type                                        | Dimensions   | Status       |
| -------- | ------------------------------------------- | ------------ | ------------ |
| `bge-m3` | Self-hosted (port 8000)                     | 1024         | ✅ Default   |
| `openai` | External API (text-embedding-3-small/large) | 1536 / 3072  | ✅ Supported |
| `cohere` | External API (embed models)                 | Varies       | ✅ Supported |
| `custom` | Self-hosted endpoint (any model)            | Configurable | ✅ Supported |

The default is **BGE-M3**, a self-hosted model running as a sidecar service on port 8000. It produces 1024-dimensional vectors and requires no external API calls, making it fast and cost-free. The `custom` provider lets teams point at their own embedding service with a configurable endpoint, model name, and dimensions. Teams that need higher-quality embeddings for specific use cases can switch to OpenAI, Cohere, or a custom provider, understanding the reindex cost.

---

## Scene 7: Publishing and Reindexing

Pipeline changes follow a **draft-to-active lifecycle**. When you edit flows, add providers, or change configuration, those changes exist in `draft` status. Live document processing continues using the current `active` pipeline. Nothing changes until you explicitly **publish**.

Publishing does two things:

1. Sets the pipeline status from `draft` to `active`
2. Compares the new version against the previous version to determine **what changed**

This comparison drives the **4-checkpoint reindexing system**, which ensures only the minimum necessary work is performed.

### The 4 Checkpoints

```
Checkpoint 1: Routing        "Which flow does each document belong to?"
Checkpoint 2: Pre-chunk       "Re-extract from source and re-chunk"
Checkpoint 3: Post-chunk      "Re-enrich existing chunks"
Checkpoint 4: Embedding       "Re-embed all chunks"
```

**Checkpoint 1 -- Routing.** If you changed selection rules or added/removed flows, documents might belong to different flows now. The system re-evaluates flow assignment for every document. A PDF that previously hit the default flow might now match the new PDF Contract Flow.

**Checkpoint 2 -- Pre-chunk.** If extraction or chunking providers or their configurations changed, the system must go back to the original source file, re-extract, and re-chunk. This is the most expensive checkpoint because it reprocesses from scratch.

**Checkpoint 3 -- Post-chunk.** If only enrichment changed (say, you added legal entity extraction), existing chunks are fine -- they just need new metadata. The system runs the new enrichment stage on existing chunks without touching extraction or chunking.

**Checkpoint 4 -- Embedding.** If the embedding model or dimensions changed, every chunk needs a new vector. The text stays the same; only the vectors are regenerated.

### Why This Matters

LegalMind has 50,000 documents producing roughly 500,000 chunks. A full reprocess from checkpoint 1 takes hours. But if LegalMind only changed the enrichment provider in one flow:

- Checkpoint 1: Skipped (routing unchanged)
- Checkpoint 2: Skipped (extraction/chunking unchanged)
- **Checkpoint 3: Runs** (re-enrich affected chunks only)
- Checkpoint 4: Skipped (embedding unchanged)

Instead of hours, this takes minutes. The reindex system calculates a **change set** that describes exactly what changed and at which checkpoint processing should begin. The publish confirmation UI shows an estimate of affected documents, duration, and cost before you commit.

```typescript
interface ReindexSummary {
  checkpoint1Count: number; // Documents to re-route
  checkpoint2Count: number; // Documents to re-extract + re-chunk
  checkpoint3Count: number; // Chunks to re-enrich
  checkpoint4Count: number; // Chunks to re-embed
  totalDocuments: number;
  totalChunks: number;
  estimatedCostUsd: number;
  estimatedDurationMin: number;
}
```

---

## Scene 8: Circuit Breakers and Resilience

It is 2 AM and Docling goes down mid-processing. LegalMind has 3,000 documents queued for extraction. Without protection, the system hammers a dead service with 3,000 requests, each timing out after 10 minutes. That is 500 hours of wasted compute time, a flooded error log, and a Redis queue growing without bound.

Circuit breakers prevent this.

### How Circuit Breakers Work

The circuit breaker pattern is a three-state machine:

```
 ┌─────────┐  failures exceed   ┌──────┐  cooldown elapsed  ┌───────────┐
 │ CLOSED  │ ──── threshold ──> │ OPEN │ ────────────────> │ HALF-OPEN │
 │ (normal)│ <── success ────── │(fail)│ <── failure ────── │  (probe)  │
 └─────────┘                    └──────┘                    └───────────┘
```

**CLOSED (normal):** Requests pass through. The circuit counts failures.

**OPEN (failing):** After the failure threshold is crossed, the circuit opens. All requests fail immediately without calling the downstream service. This protects the service from being overwhelmed and lets it recover.

**HALF-OPEN (probing):** After a cooldown period, one test request is allowed through. If it succeeds, the circuit closes and normal operation resumes. If it fails, the circuit reopens.

### Per-Provider Thresholds

Different providers have different reliability profiles and different costs when they fail:

| Provider | Failure Threshold | Success Threshold | Cooldown | Rationale                                              |
| -------- | ----------------- | ----------------- | -------- | ------------------------------------------------------ |
| Docling  | 10 failures       | 5 successes       | 120s     | Heavy model, longer recovery, higher failure tolerance |
| OpenAI   | 3 failures        | 2 successes       | 60s      | External API, network sensitive, lower threshold       |
| BGE-M3   | 5 failures        | 3 successes       | 90s      | Local embedding service, moderate tolerance            |
| Default  | 5 failures        | 2 successes       | 60s      | Applied to any provider without specific configuration |

When a circuit opens and the stage has a `fallbackProvider` configured, the system automatically routes to the fallback. If Docling is down, the PDF Contract Flow can fall back to LlamaIndex for extraction. The quality may be lower (no OCR, less layout awareness), but documents continue processing rather than piling up in the queue.

### Backpressure

BullMQ has no built-in queue depth limit. If Docling is slow and documents keep arriving, the queue grows until Redis runs out of memory. The flow builder checks queue depth before adding new jobs:

```typescript
const waitingCount = await queue.getWaitingCount();
if (waitingCount > maxDepth) {
  throw new BackpressureError(/* ... */);
}
```

When backpressure triggers, the system pauses intake and retries after a cooldown period. This prevents cascading failures across the entire pipeline.

---

## Scene 9: Visual Processing — Making Images and Tables Searchable

LegalMind's 50,000 documents are not just text. Their PDF contracts contain signature blocks and organizational charts. Regulatory updates include compliance matrices and flowcharts. Financial spreadsheets have charts summarizing quarterly data. With text-only processing, a lawyer searching "what does the Q3 revenue chart show?" gets nothing — the chart is a PNG embedded in the PDF, invisible to semantic search.

Visual processing solves this by turning images and tables into searchable text descriptions.

### What Docling Extracts

During the extraction stage (Scene 2), Docling does more than pull text. For each page, it produces three visual assets:

| Asset                | What it is                                                        | Example                                        |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| **Page screenshot**  | A full PNG rendering of the entire page                           | The whole contract page as a user would see it |
| **Extracted images** | Individual images pulled from the page (charts, photos, diagrams) | A bar chart embedded between paragraphs        |
| **Extracted tables** | Structured table data (HTML, markdown, row/column arrays)         | A compliance checklist rendered as `<table>`   |

These assets are stored per-page in MongoDB (`DocumentPage`) with images uploaded to S3 (or local storage in development). They sit there, waiting for visual processing to make them useful.

### Two Workers, Two Jobs

Two workers consume this visual content, each with a different purpose:

**The vision worker** processes **page screenshots**. It chains visual context from page to page — understanding that page 4's chart continues the data series from page 3. It enriches the existing text summary for each chunk with visual insights ("this page contains a revenue bar chart showing regional performance") and adds visual-specific questions to the chunk's question set. This is page-level, sequential, context-aware processing.

**The multimodal worker** processes **individual images and tables**. It sends each extracted image to a vision-capable LLM and gets back a standalone text description: "A bar chart showing Q3 revenue by region: North $1.2M, South $900K, East $1.1M, West $800K. North leads with 32% growth YoY." For tables, it generates semantic summaries: "Quarterly revenue showing North leading with 32% growth." These descriptions are stored as chunk metadata and embedded alongside the chunk text, making the visual content findable through natural language search.

```
extraction → chunking → enrichment → [vision + multimodal + embedding]
                                       (all three run in parallel)
```

Both workers run **in parallel with embedding** after enrichment completes. Neither blocks the other. If either fails, the document is still indexed — visual processing is optional enrichment, not a hard requirement.

### How Users Configure It

Both features are **disabled by default** and configured per knowledge base through the LLM Features settings in Studio (Settings tab → Advanced section). Each feature appears as a card with a toggle, status badge, and expandable configuration:

| Setting                   | What it controls                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Enable/disable toggle** | Turn the feature on or off for this knowledge base                                                                          |
| **Model tier**            | `fast`, `balanced`, or `powerful` — the system auto-selects the best available model from the tenant's configured providers |
| **Sub-feature toggles**   | For multimodal: `enableImageDescription`, `enableTableSummarization`, `enableChartAnalysis` — enable only what you need     |

Users do not pick a specific model like "GPT-4o" or "Claude Sonnet." They pick a **tier**, and the LLM configuration resolver automatically selects the best model available from whatever the tenant admin has configured. If the requested tier is unavailable, it falls back automatically — balanced falls back to fast, fast to powerful — and the UI shows a "Fallback" badge explaining what happened.

This matters for cost control. Vision and multimodal are the most expensive LLM features (cost rating 7-8 out of 10). A 50-page PDF with 10 images costs roughly $0.10 per document with OpenAI Vision, $0.025 with Gemini. At LegalMind's scale of 50,000 documents, that is $5,000-$2,500 per full processing run. Users enable these features deliberately for knowledge bases where visual content carries information — financial reports, technical documentation, product catalogs — and leave them off for text-heavy knowledge bases like chat logs or policy documents.

### What Gets Stored

After visual processing, chunk metadata includes the generated descriptions:

```
chunk.metadata.imageDescriptions[] → "A bar chart showing Q3 revenue by region..."
chunk.metadata.tableSummaries[]    → "Quarterly revenue showing North leading..."
chunk.metadata.visualAnalysis      → Page-level layout understanding from vision worker
```

These text descriptions are embedded into vectors alongside the chunk's original text. When a user searches "Q3 revenue by region," the chunk containing the chart description now matches — even though the original chunk text said nothing more than "See Figure 3."

### Pipeline Integration Status

The vision and multimodal workers exist and run today as standalone post-enrichment processors. They are **not yet wired through the pluggable flow system** (BullMQ Flows, Scene 7) — they run as independent BullMQ workers triggered after enrichment, outside the flow builder's orchestration. The `multimodal` stage type exists in the pipeline schema for future integration, which would allow per-flow visual processing configuration and proper reindex tracking when visual processing settings change.

---

## Scene 10: The Result

Before customizable pipelines, LegalMind ran every document through the same processing path. Scanned PDFs produced empty extractions. Contracts were split at arbitrary token boundaries. Spreadsheet rows were mangled into incoherent text fragments. Search quality was poor, and lawyers did not trust the AI assistant.

After configuring four targeted flows:

- **PDF contracts** are OCR-extracted by Docling, chunked at clause boundaries by the tree builder, enriched with legal entity metadata, and embedded with BGE-M3 vectors (the pipeline's shared embedding model). When a lawyer searches for "indemnification terms in the Acme contract," the system returns the complete indemnification clause, not a fragment.

- **Word memos** are extracted with standard text processing, chunked by paragraph, and summarized by the LLM enrichment stage. Internal policy searches return relevant paragraphs with contextual summaries.

- **HTML regulatory updates** are cleaned of navigation chrome and advertising, chunked by section headers, and tagged with regulation identifiers. Compliance searches return the actual regulation text, not website boilerplate.

- **Everything else** hits the default flow with sensible defaults. No document falls through the cracks.

Changes are safe. The draft-to-active lifecycle means engineers can experiment with new configurations without affecting live search. The publish confirmation shows exactly what will be reindexed and how long it will take. If only enrichment changed, only checkpoint 3 runs -- minutes instead of hours for 50,000 documents.

The system is resilient. When Docling went down during a weekend batch import, the circuit breaker detected the failure after 10 requests, stopped sending traffic, and fell back to LlamaIndex. When Docling recovered 3 minutes later, the half-open probe succeeded and the circuit closed automatically. No manual intervention, no lost documents, no overloaded queues.

Each document type processed optimally. Each change reviewed before deployment. Each failure handled automatically. That is what customizable ingestion pipelines deliver.

---

## Scene 11: How Each Format Gets Chunked and Embedded

Scenes 2–4 describe the pipeline architecture in general terms. This scene documents the **concrete behavior** for every supported file format: how many pages Docling extracts, how many chunks are created, and what text is sent to the embedding model.

> For the full changelog that led to these improvements, see [CHUNKING_IMPROVEMENTS.md](../CHUNKING_IMPROVEMENTS.md).

### Extraction: How Documents Become Pages

The Docling Python service (`services/docling-service/app.py`) handles documents differently based on their native structure:

| Format                              | Docling Returns                | DocumentPages      | Why                                                        |
| ----------------------------------- | ------------------------------ | ------------------ | ---------------------------------------------------------- |
| **PDF**                             | `result.pages` (list)          | N (1 per PDF page) | PDF has explicit page boundaries in the file structure     |
| **PPTX/PPT**                        | `result.document.pages` (dict) | N (1 per slide)    | Slides are discrete XML files (`slide1.xml`, `slide2.xml`) |
| **DOCX/DOC**                        | `result.document` (`pages={}`) | 1                  | Flow document — content is XML paragraphs, not pages       |
| **HTML**                            | `result.document` (`pages={}`) | 1                  | Flow document — no concept of pages                        |
| **Images** (PNG/JPEG/TIFF/BMP/WEBP) | `result.pages` (1 OCR page)    | 1                  | Single image = single page of OCR-extracted text           |
| **TXT**                             | Legacy `fs.readFile`           | 1                  | Raw text read as UTF-8                                     |
| **Markdown**                        | Legacy `fs.readFile`           | 1                  | Raw text read as UTF-8                                     |
| **CSV/JSON/Excel**                  | Structured data worker         | 0                  | No DocumentPages — goes to schema analysis + ClickHouse    |

DOCX stores paragraphs, styles, and tables as XML — not pages. Pages only exist when Word renders the content based on paper size, margins, and fonts. The same DOCX can be 3 pages on one machine and 4 on another. PPTX has discrete slides as separate XML files, so Docling correctly maps them to pages. PDF has explicit page boundaries.

### Chunking: How Pages Become Chunks

`page-processing-worker.ts` applies this decision tree:

```
1. Is index.tokenChunkStrategy set?
   YES -> Token-based: all pages concatenated, ChunkingService splits by token count
          (works for ANY content type)

2. Is contentType in [text/markdown, DOCX, DOC, text/html]?
   YES -> Markdown-aware: chunkMarkdown() splits on H1/H2 headings
          Preserves code blocks, tables, lists. maxChunkSize: 1024 tokens.

3. Default: Page-based
   Each page.text    -> 1 SearchChunk (chunkType: 'page')
   Each page.table[i] -> 1 SearchChunk (chunkType: 'table')
```

### Complete MIME Type Reference (All 19 Types)

**Document Upload API — Docling Path:**

| Format                        | Chunking       | Example Input      | Chunks Created               |
| ----------------------------- | -------------- | ------------------ | ---------------------------- |
| PDF (10 pages, 2 tables)      | Page-based     | Technical manual   | 10 text + 2 table = **12**   |
| PPTX (6 slides, 1 table)      | Page-based     | Sales deck         | 6 text + 1 table = **7**     |
| PPT (4 slides)                | Page-based     | Training slides    | **4**                        |
| DOCX (4 `##` sections)        | Markdown-aware | Analysis report    | **~4** (split on H2)         |
| DOCX (no headings, 26K chars) | Markdown-aware | Plain letter       | **1** (no headings to split) |
| DOC (3 sections)              | Markdown-aware | Legacy Word file   | **~3**                       |
| HTML (5 `##` headings)        | Markdown-aware | Documentation page | **~5**                       |
| PNG (scanned document)        | Page-based     | Scanned receipt    | **1** (OCR text)             |
| JPEG/JPG                      | Page-based     | Photo of document  | **1** (OCR text)             |
| TIFF/BMP/WEBP                 | Page-based     | Scan / screenshot  | **1** (OCR text)             |

**Document Upload API — Legacy Path:**

| Format                     | Chunking       | Example Input | Chunks Created       |
| -------------------------- | -------------- | ------------- | -------------------- |
| TXT (5K words)             | Page-based     | Meeting notes | **1** (entire file)  |
| Markdown (6 `##` sections) | Markdown-aware | README        | **~6** (split on H2) |

**Structured Data API — Separate Pipeline:**

| Format                      | Chunking          | Example Input         | Chunks  | Data Storage      |
| --------------------------- | ----------------- | --------------------- | ------- | ----------------- |
| CSV (100K rows)             | Metadata-only     | Customer table        | **1**   | Rows → ClickHouse |
| JSON array (5K objects)     | Metadata-only     | Product catalog       | **1**   | Rows → ClickHouse |
| JSON (large single object)  | Object + overflow | Config with big field | **1+N** | N/A               |
| Excel .xlsx/.xls (50K rows) | Metadata-only     | Sales spreadsheet     | **1**   | Rows → ClickHouse |

**Web Crawler Path:**

| Source      | Chunking       | Example Input              | Chunks Created |
| ----------- | -------------- | -------------------------- | -------------- |
| Crawled URL | Markdown-aware | Blog post, 3 `##` sections | **~3**         |

### What Content Gets Embedded

The embedding worker sends `chunk.content` to `embeddingProvider.embedBatch()`. Here is what that field contains:

| Chunk Type          | Source               | What Gets Embedded                        | Example                                                          |
| ------------------- | -------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Page (PDF/PPTX)     | Docling page         | Markdown text of that page/slide          | `"# Q3 Results\n\n- Revenue: $12M"`                              |
| Page (OCR)          | Image                | All text extracted by OCR                 | `"INVOICE #12345\nTotal: $99.99"`                                |
| Page (TXT)          | Text file            | Entire file as-is                         | `"Meeting notes: Alice, Bob..."`                                 |
| Table               | PDF/PPTX tables      | `table.markdown`                          | `"\| Name \| Price \|\n\|---\|---\|\n\| Widget \| $9.99 \|"`     |
| Markdown section    | DOCX/HTML/MD/Crawled | Section split on H1/H2                    | `"## Installation\n\nRun: npm install"`                          |
| Token-based         | Any (override)       | Token-count-sized text                    | `"...sentence end. This chunk continues..."`                     |
| Table metadata      | CSV/Excel/JSON array | `JSON.stringify(schema + 20 sample rows)` | `'{"tableName":"customers","columns":[...],"sampleRows":[...]}'` |
| JSON object (small) | JSON < 8K tokens     | `JSON.stringify(fullObject)`              | `'{"id":"review-1","rating":5}'`                                 |
| JSON object (large) | JSON > 8K tokens     | JSON with large fields replaced           | `'{"id":"art-1","body":"[Large field - see separate chunks]"}'`  |
| JSON overflow       | Large field text     | Raw text, sentence-aligned                | `"AI is transforming healthcare..."`                             |
| Chunk question      | Generated            | Question text                             | `"What are the system requirements?"`                            |
| Doc question        | Generated            | Holistic question                         | `"What is the purpose of this document?"`                        |

### Known Limitations

| Limitation                      | Impact                                                   | Workaround                                                       |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| DOCX/HTML without `##` headings | Produces 1 chunk (entire document)                       | Enable `tokenChunkStrategy` on the index                         |
| TXT files                       | Always 1 chunk regardless of size                        | Enable `tokenChunkStrategy`                                      |
| Image refs in DOCX/HTML chunks  | Markdown section chunks don't carry `hasImages` metadata | Images accessible via `DocumentPage.images[]` using `documentId` |
| DOCX tables in markdown chunks  | Tables flow into markdown text, not extracted separately | PDF/PPTX extract tables as separate chunks                       |
| Structured data                 | Only metadata + 20 sample rows are embedded              | Actual data rows are in ClickHouse for SQL queries               |

---

## Appendix: Implementation Status

A summary of what is available today versus what is planned.

| Feature                                                       | Status | Notes                                                 |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| Pipeline data model (SearchPipelineDefinition)                | ✅     | Full schema with flows, stages, rules, validation     |
| Draft → Active lifecycle                                      | ✅     | Version incrementing, status transitions              |
| Flow selection (simple & compound rules)                      | ✅     | Priority-based evaluation                             |
| Flow selection (CEL expressions)                              | 🚧     | Implemented, tests being enabled                      |
| 4-checkpoint reindexing                                       | ✅     | Routing, pre-chunk, post-chunk, embedding             |
| Pipeline editor UI (Studio)                                   | ✅     | Full CRUD with skeleton loading                       |
| Embedding configuration (pipeline-level)                      | ✅     | BGE-M3, OpenAI, Cohere, Custom providers              |
| Per-flow embedding providers                                  | 🔮     | Not supported — pipeline-level only                   |
| Circuit breaker (per-provider)                                | ✅     | Redis-backed, per-tenant isolation                    |
| Backpressure (queue depth checks)                             | ✅     | Prevents Redis OOM                                    |
| Provider registry interface                                   | ✅     | `PipelineStageProvider` interface defined             |
| Provider registry adapters (extraction, chunking, enrichment) | 🚧     | Services exist, registry adapters being built         |
| Visual processing workers (vision + multimodal)               | ✅     | Standalone workers, not yet wired through flow system |
| Multimodal stage type in flow builder                         | 🔮     | In schema, flow system integration planned            |
| Per-index LLM feature configuration (Settings tab)            | ✅     | Tier-based auto-resolution with fallback              |
| Shared stages (cross-flow)                                    | 🔮     | In schema, not implemented                            |
| Publish confirmation UI (reindex estimates)                   | ✅     | Shows affected documents, checkpoints                 |
| Fallback providers                                            | ✅     | Schema supports `fallbackProvider` + `fallbackConfig` |
| PPTX per-slide extraction (Scene 11)                          | ✅     | Each slide = 1 DocumentPage = 1 chunk                 |
| DOCX/HTML markdown-aware chunking (Scene 11)                  | ✅     | Splits on H1/H2 headings from Docling markdown export |
| Accurate token counting — tiktoken (Scene 11)                 | ✅     | Replaces chars/4 estimate in extraction + chunking    |
| Per-MIME-type chunking reference (Scene 11)                   | ✅     | All 19 MIME types documented with chunk counts        |
