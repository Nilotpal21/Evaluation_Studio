# Multimodal Processing -- Low-Level Design

**Feature Spec**: `docs/features/multimodal-processing.md`
**HLD**: `docs/specs/multimodal-processing.hld.md`
**Testing Guide**: `docs/testing/multimodal-processing.md`
**Status**: BETA

---

## Implementation Structure

### Services

| File                                              | Purpose                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/services/multimodal/index.ts` | MultiModalEnricher class: lazy LLMClient init, `processChunk()`, `describeImage()`, `summarizeTable()`, HTML extraction utilities, table metadata                |
| `apps/search-ai/src/services/vision/index.ts`     | VisionService class: Phase 3a (analyzeWithContext, enrichSummary, enhanceQuestions), Phase 3b (enrichDocumentSummary, enhanceDocumentQuestions), cost estimation |
| `apps/search-ai/src/types/document-image.ts`      | `DocumentImageContent` type, `toImageContent()` converter, `isDocumentImageContent()` type guard                                                                 |

### Workers

| File                                                              | Queue                | Job Data                                                                         | Concurrency      | Purpose                                       |
| ----------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- | ---------------- | --------------------------------------------- |
| `apps/search-ai/src/workers/docling-extraction-worker.ts`         | `docling-extraction` | `DoclingExtractionJobData { indexId, documentId, sourceUrl, tenantId }`          | 3                | Docling service call, S3 upload, page storage |
| `apps/search-ai/src/workers/multimodal-worker.ts`                 | `multimodal`         | `MultiModalJobData { indexId, documentId, chunkIds, tenantId }`                  | 2                | Chunk-level image/table enrichment            |
| `apps/search-ai/src/workers/visual-enrichment-worker.ts`          | `visual-enrichment`  | `VisualEnrichmentJobData { tenantId, indexId, documentId, pageNumber, chunkId }` | 3 (rate: 10/min) | Phase 3a page-level visual enrichment         |
| `apps/search-ai/src/workers/document-visual-enrichment-worker.ts` | `visual-enrichment`  | `DocumentVisualEnrichmentJobData { tenantId, indexId, documentId }`              | 2 (rate: 5/min)  | Phase 3b document-level visual enrichment     |

### Config

| File                                 | Schema                   | Key Fields                                                                                                                                         |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai/src/config/index.ts` | `MultiModalConfigSchema` | enabled, visionProvider, visionApiKey, visionModel, tableSummarizerProvider/ApiKey/Model, maxImageSizeBytes, maxTableSizeBytes, rateLimitPerMinute |

---

## MultiModalEnricher Detail

The `MultiModalEnricher` class in `apps/search-ai/src/services/multimodal/index.ts` provides chunk-level multimodal processing:

### Initialization (Lazy)

Called on first `processChunk()`:

1. **Vision client**: If `enableImageDescription` and `visionApiKey` are set, creates `LLMClient({ provider, apiKey })`. Verifies `supportsFeature('vision')`. Sets to null if check fails.
2. **Table summarizer client**: If `enableTableSummarization` and `tableSummarizerApiKey` are set, creates `LLMClient({ provider, apiKey })`.

### processChunk()

Processes images and tables from a single chunk:

1. Iterates over `images[]`, calls `describeImage()` for each. Catches errors per image, stores error placeholder.
2. Iterates over `tables[]`, calls `summarizeTable()` for each. Catches errors per table, stores error placeholder.
3. Accumulates `totalCostUsd` and `totalTokens` across all items.

### describeImage()

1. Converts `ImageData` to `DocumentImageContent` via format-specific construction (base64 vs URL).
2. Builds user prompt: "Describe this image in detail..." with optional context.
3. Calls `provider.complete()` with system prompt, messages containing `[text, image]` content blocks.
4. Model: `visionModel`, maxTokens: 300, timeout: 30s.

### summarizeTable()

1. Builds prompt with table content (truncated via `formatTableContent()` if exceeding `maxTableSizeBytes`).
2. Calls `tableSummarizerClient.chat()` with system prompt for data analyst role.
3. Model: `tableSummarizerModel`, maxTokens: 300, timeout: 20s.

### Table Truncation

- **CSV**: Preserves header row, adds rows until size limit, appends `... [truncated]`.
- **HTML**: Splits on `</tr>`, adds rows until size limit, closes with `</tbody></table>`.
- **JSON**: Simple byte-level truncation with `... [truncated]`.

### Static Utilities

- `extractTablesFromHtml(html)`: Regex `/<table[\s\S]*?<\/table>/gi`.
- `extractImagesFromHtml(html)`: Regex `/<img[^>]+src=["']([^"']+)["'][^>]*>/gi`, extracts src and alt.
- `detectTableMetadata(content, format)`: Counts rows/columns from HTML `<tr>`/`<th>` tags or CSV line/comma splits.

---

## VisionService Detail

The `VisionService` class in `apps/search-ai/src/services/vision/index.ts` provides phase-based visual enrichment:

### Constructor

Takes `VisionServiceConfig { indexId, tenantId, resolvedConfig }`. Creates `LLMClient` with tenant credentials. Extracts `visionConfig` (balanced tier) and `summarizationConfig` (fast tier) from `resolvedConfig.useCases`.

### Phase 3a: analyzeWithContext()

1. **Input**: images[], screenshot, textSummary, previousVisualContext, questions[].
2. **Short-circuit**: Returns empty result if no images and no screenshot.
3. **Image contents**: Builds `DocumentImageContent[]` -- screenshot first (if `analyzeScreenshots`), then extracted images (if `analyzeImages`).
4. **Prompt**: Includes previous page visual context, current text summary, current questions. Requests JSON output with imageDescriptions[], visualContext, keyVisualElements[].
5. **LLM call**: `provider.complete()` with vision model (balanced tier), maxTokens from config (default 500), 60s timeout.
6. **Parse**: Extracts JSON from response via regex `\{[\s\S]*\}`. Falls back to empty result on parse failure.
7. **Cost**: Estimated via `estimateCost()` lookup table by model name.

### Phase 3a: enrichSummary()

1. **Short-circuit**: Returns original summary if no image descriptions.
2. **Prompt**: Original summary + image descriptions + visual context. Focus on ENRICHING (not re-describing).
3. **LLM call**: `llmClient.chat()` with fast tier model (Haiku), maxTokens from config (default 300).

### Phase 3a: enhanceQuestions()

1. **Short-circuit**: Returns original questions unchanged if no images or no questions.
2. **Prompt**: Original questions + image descriptions + visual elements. Requests JSON with enhanced and new questions.
3. **LLM call**: Fast tier model. Parse output merges `enhancedQuestions[]` and `newQuestions[]` (marked with `isNew: true`).

### Phase 3b: enrichDocumentSummary()

1. **Input**: originalDocumentSummary, enrichedPageSummaries[], allImageDescriptions[] (max 20 shown), keyVisualElements[].
2. **Prompt**: Requests document-level narrative integrating visual themes. JSON output with summary, keyVisualElements, visualNarrative, visualThemes, chartInsights.
3. **LLM call**: Vision model (balanced tier), maxTokens 1000.

### Phase 3b: enhanceDocumentQuestions()

1. **Short-circuit**: Returns unchanged if no visual elements or no questions.
2. **Prompt**: Document-level questions + enriched document summary + visual elements.
3. **LLM call**: Fast tier model.

### Cost Estimation

Lookup table (`estimateCost()`) with per-million-token pricing:

| Model                       | Input $/M | Output $/M |
| --------------------------- | --------- | ---------- |
| `claude-sonnet-4-20250514`  | 3.00      | 15.00      |
| `claude-haiku-4-5-20251001` | 0.25      | 1.25       |
| `gpt-4o`                    | 5.00      | 15.00      |
| `gpt-4o-mini`               | 0.15      | 0.60       |
| `gemini-2.5-pro`            | 1.25      | 5.00       |
| `gemini-2.0-flash`          | 0.075     | 0.30       |

---

## Docling Extraction Worker Detail

The `processDoclingExtractionJob()` function in `apps/search-ai/src/workers/docling-extraction-worker.ts`:

1. **Download document**: Calls `downloadDocumentContent(sourceUrl)` which handles S3, HTTP, and local file URLs.
2. **Call Docling service**: `POST {DOCLING_SERVICE_URL}/extract` with multipart form (file + options JSON). Options: `extractImages`, `extractTables`, `renderScreenshots`, `ocrEnabled`. Timeout: 300s (5 minutes).
3. **Detect asset storage**: Checks if any page has images or screenshots. Initializes `S3StorageService` (for s3/minio providers) or creates local directory (`{basePath}/{tenantId}/{indexId}/{documentId}/assets`).
4. **Process pages**: For each `DoclingPage`:
   - Upload images to S3 via `uploadBase64ToS3()` with structured key: `S3StorageService.buildPageAssetKey(tenantId, indexId, documentId, pageNumber, assetId, format)`.
   - Upload screenshot to S3 if present.
   - Create page record with `tenantId`, `indexId`, `documentId`, `pageNumber`, `text`, `tokenCount` (via tiktoken), `layout`, `tables`, `images` (with S3 URLs), `screenshot`.
5. **Insert pages**: Sequential `DocumentPage.create()` per page (avoids insertMany blocking on index creation). Publishes progress events for crawl jobs.
6. **Update document**: Status transition `EXTRACTING -> EXTRACTED`. Stores Docling metadata (pageCount, totalTables, totalImages, hasOCR, processingTime, documentType).
7. **Enqueue page processing**: Creates `page-processing` job with `pageIds[]` and `previousPageSummary: null`.

### Text Cleaning

`cleanDoclingText(text, layout)` handles a known Docling bug where raw metadata is returned instead of extracted text:

- Detects metadata markers (`page_no=`, `predictions=PagePredictions(`, `Size(width=`, etc.).
- Fallback 1: Extract text from `layout.headings[].text`.
- Fallback 2: Extract from `text='...'` patterns (PdfTextCell).
- Fallback 3: Filter readable lines (lines containing words separated by spaces).

### Supported Formats

| Path        | Formats                                                              |
| ----------- | -------------------------------------------------------------------- |
| Docling     | PDF, DOCX, DOC, PPTX, PPT, HTML, PNG, JPEG, JPG, TIFF, BMP, WEBP, MD |
| LlamaIndex  | TXT (single page, chunked in page-processing)                        |
| Unsupported | CSV, JSON, XML (need hierarchical tree extraction)                   |

---

## Visual Enrichment Worker Detail

The `VisualEnrichmentWorker` class in `apps/search-ai/src/workers/visual-enrichment-worker.ts`:

### Job Routing

Single BullMQ worker on `QUEUE_VISUAL_ENRICHMENT` handles two job types:

- `enrich-page` -> `processPageEnrichment()` (Phase 3a)
- `enrich-document` -> `processDocumentVisualEnrichment()` (Phase 3b, dynamically imported)

### Rate Limiting

- Concurrency: 3
- BullMQ limiter: max 10 jobs per 60s
- Job retention: completed (100 count, 1 hour), failed (1000 count, 24 hours)

### Phase 3a Page Processing Flow

1. Resolve LLM config. Skip if vision disabled.
2. Load Phase 2 chunk by `chunkId`. Skip if no `progressiveSummary`.
3. Load chunk questions (scope: `chunk`, sorted by `questionIndex`).
4. Load previous page's `visualAnalysis.visualContext` from `metadata.pageNumber - 1` chunk.
5. Load `DocumentPage` for current page. Check for images/screenshot.
6. **Cost optimization**: Skip pages with no visuals (mark as `processed: false`).
7. `VisionService.analyzeWithContext()` -- balanced tier.
8. `VisionService.enrichSummary()` -- fast tier. Updates `progressiveSummary` and sets `progressiveSummaryVersion: 2`.
9. `VisionService.enhanceQuestions()` -- fast tier. Updates existing questions (version 2, visuallyEnriched flag). Creates new visual-specific questions.
10. Update chunk with `visualAnalysis` metadata, cumulative costs.
11. Enqueue next page or `enrich-document` job.

### Page-to-Document Transition

After processing the last page (no chunk found for `pageNumber + 1`):

- Enqueues `enrich-document` job to the same `QUEUE_VISUAL_ENRICHMENT` queue.
- Document-level enrichment collects all page-level results.

---

## Document Visual Enrichment Worker Detail

The `processDocumentVisualEnrichment()` function in `apps/search-ai/src/workers/document-visual-enrichment-worker.ts`:

1. Resolve LLM config. Skip if vision disabled.
2. Load all chunks for document, sorted by `metadata.pageNumber`.
3. Filter enriched page summaries (`progressiveSummaryVersion === 2`). Skip if none.
4. Load document's text-only summary (`metadata.documentSummary`). Skip if missing.
5. Load document-level questions (scope: `document`).
6. Collect all `imageDescriptions` from all chunks' `visualAnalysis`.
7. Extract key visual elements via keyword detection: chart, bar chart, line chart, pie chart, diagram, graph, table, code snippet, screenshot, flowchart.
8. `VisionService.enrichDocumentSummary()` -- balanced tier, maxTokens 1000.
9. `VisionService.enhanceDocumentQuestions()` -- fast tier.
10. Update `SearchDocument`: enriched summary (version 2), visual document summary metadata (themes, narrative, insights), cumulative costs.
11. Update document-level `ChunkQuestion` records.
12. **Enqueue downstream workers**: Dynamically imports `getEmbeddingQueue()`, enqueues `embed-document` job with trace context propagation (`injectTrace`).

### Error Handling

- Vision processing errors are caught and logged but do not block downstream workers.
- Downstream worker enqueue errors are caught and logged but do not throw.

---

## Multimodal Worker Detail

The `processMultiModalJob()` function in `apps/search-ai/src/workers/multimodal-worker.ts`:

1. Resolve per-index LLM config via `resolveIndexLLMConfig(tenantId, indexId)`. Skip if `useCases.multimodal.enabled` is false.
2. Create `MultiModalEnricher` with combined config: per-index features (vision provider/model/key) + global infrastructure (table summarizer, rate limits, size limits).
3. Check `service.isAvailable()`. Skip if no API keys configured.
4. Load chunks by `{ _id: { $in: chunkIds }, documentId, tenantId, indexId }`.
5. For each chunk: `extractImagesFromChunk()` (from `metadata.images[]`), `extractTablesFromChunk()` (from `metadata.tables[]`). Skip chunks without visual content.
6. Call `service.processChunk({ images, tables })`.
7. Update chunk: `$set` `metadata.imageDescriptions`, `metadata.tableSummaries`, `metadata.multiModalProcessed`, cost, tokens.
8. Update document: `$set` `metadata.multiModal` with totals.

### Chunk Extraction Helpers

- `extractImagesFromChunk(chunk)`: Reads `metadata.images[]`, creates `ImageData` with base64 or URL, uses first 200 chars of chunk content as context.
- `extractTablesFromChunk(chunk)`: Reads `metadata.tables[]`, creates `TableData` with HTML or CSV format.

---

## Test Files

| Test File                                                             | What It Tests                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/search-ai/src/__tests__/multimodal.test.ts`                     | MultiModalEnricher: image description, table summarization, batch, HTML extraction, metadata detection, status, missing keys         |
| `apps/search-ai/src/services/vision/__tests__/vision-service.test.ts` | VisionService: analyzeWithContext, enrichSummary, enhanceQuestions, enrichDocumentSummary, enhanceDocumentQuestions, cost estimation |
| `apps/search-ai/src/__tests__/visual-enrichment-integration.test.ts`  | Phase 3 integration: page enrichment with images, document enrichment, downstream triggering (MongoMemoryServer)                     |

---

## Known Gaps

1. **Docling worker untested**: Zero test coverage for download, Docling service call, S3 upload, page creation, text cleaning, error recovery.
2. **Multimodal worker untested**: Zero dedicated test coverage for chunk extraction, config resolution, chunk update.
3. **Rate limit not enforced**: `rateLimitPerMinute` in `MultiModalConfigSchema` is defined but not wired to any enforcement mechanism in `MultiModalEnricher`.
4. **Token tracking incomplete**: `describeImage()` returns no `tokensUsed` or `costUsd` because `LLMClient.getProvider().complete()` usage is not consistently exposed across providers.
5. **Console logging**: MultiModalEnricher and VisionService use `console.error`/`console.warn` instead of `createLogger`.
6. **Duration tracking bug**: Docling extraction worker's completion log computes `durationMs: Date.now() - Date.now()` (always 0).
7. **Docling text contamination**: The `cleanDoclingText()` function handles metadata contamination but has no test coverage.
