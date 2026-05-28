# SearchAI Chunking & Embedding Reference

**Date:** 2026-03-16
**Branch:** feature/searchai-extraction

---

## Summary

Improvements to how documents are chunked across all 19 supported MIME types, plus a complete reference for what content gets sent to the embedding service for each format.

**Changes made:**

1. PPTX per-slide extraction (was merging all slides into 1 chunk)
2. Markdown-aware chunking for DOCX/HTML (was producing 1 giant chunk)
3. Accurate token counting with tiktoken (was using `chars/4` estimate)
4. Runtime kNN field alignment (`embedding` -> `vector`)
5. PromptLoaderService test mock fix (pre-existing 27 test failures on develop)

---

## Pipeline Flow

```
Document Upload API (/api/documents/upload)
      |
      v
  Route by MIME type (document-upload.ts)
      |
      +---> Docling Path (PDF, DOCX, DOC, PPTX, PPT, HTML, images)
      |         |
      |         v
      |     docling-extraction-worker.ts
      |         |
      |         +---> PDF/Images: result.pages -> N DocumentPages (1 per page)
      |         +---> PPTX/PPT:   doc.pages -> N DocumentPages (1 per slide)
      |         +---> DOCX/HTML:  single page -> 1 DocumentPage (flow doc)
      |
      +---> Legacy Path (TXT, Markdown)
      |         |
      |         v
      |     extraction-worker.ts -> 1 DocumentPage
      |
      +---> Structured Data Path (CSV, JSON, Excel)
      |         |
      |         v
      |     structured-data-ingestion-worker.ts -> No DocumentPages
      |     (schema analysis + ClickHouse storage)
      |
      +---> Crawler Path (crawled URLs)
                |
                v
            crawler-ingestion-worker.ts
            Readability cleans HTML -> extraction-worker -> 1 DocumentPage
                |
                v
        page-processing-worker.ts (chunking decision)
                |
                +---> tokenChunkStrategy set on index?
                |         YES -> ChunkingService (all pages concatenated, split by tokens)
                |
                +---> contentType in [markdown, docx, doc, html]?
                |         YES -> chunkMarkdown() (split on H1/H2 headings)
                |
                +---> Default: page-based chunking
                          Each page -> 1 text chunk
                          Each table -> 1 table chunk
                |
                v
        canonical-mapper-worker -> enrichment-worker -> embedding-worker
                                                            |
                                                            v
                                                    embeddingProvider.embedBatch(texts)
                                                    vectorStore.upsert(records)
```

---

## Complete MIME Type Reference (All 19 Types)

### Document Upload API — Docling Path

| #   | MIME Type                                                                   | Ext        | Extraction        | Docling Pages   | Chunking       | Example Input         | Chunks                     |
| --- | --------------------------------------------------------------------------- | ---------- | ----------------- | --------------- | -------------- | --------------------- | -------------------------- |
| 1   | `application/pdf`                                                           | .pdf       | Docling per-page  | N (1 per page)  | Page-based     | 10-page PDF, 2 tables | 10 text + 2 table = **12** |
| 2   | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | .pptx      | Docling per-slide | N (1 per slide) | Page-based     | 6 slides, 1 table     | 6 text + 1 table = **7**   |
| 3   | `application/vnd.ms-powerpoint`                                             | .ppt       | Docling per-slide | N (1 per slide) | Page-based     | 4 slides              | **4**                      |
| 4   | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   | .docx      | Docling 1 page    | 1 (flow doc)    | Markdown-aware | 4 `##` sections       | **~4**                     |
| 5   | `application/msword`                                                        | .doc       | Docling 1 page    | 1 (flow doc)    | Markdown-aware | 3 sections            | **~3**                     |
| 6   | `text/html`                                                                 | .html      | Docling 1 page    | 1 (flow doc)    | Markdown-aware | 5 `##` headings       | **~5**                     |
| 7   | `image/png`                                                                 | .png       | Docling OCR       | 1 (OCR text)    | Page-based     | Scanned receipt       | **1**                      |
| 8   | `image/jpeg`                                                                | .jpeg/.jpg | Docling OCR       | 1 (OCR text)    | Page-based     | Photo of document     | **1**                      |
| 9   | `image/tiff`                                                                | .tiff      | Docling OCR       | 1 (OCR text)    | Page-based     | High-res scan         | **1**                      |
| 10  | `image/bmp`                                                                 | .bmp       | Docling OCR       | 1 (OCR text)    | Page-based     | Bitmap image          | **1**                      |
| 11  | `image/webp`                                                                | .webp      | Docling OCR       | 1 (OCR text)    | Page-based     | Web screenshot        | **1**                      |

### Document Upload API — Legacy Path

| #   | MIME Type       | Ext  | Extraction          | Pages | Chunking       | Example Input  | Chunks |
| --- | --------------- | ---- | ------------------- | ----- | -------------- | -------------- | ------ |
| 12  | `text/plain`    | .txt | fs.readFile (UTF-8) | 1     | Page-based     | 5000-word file | **1**  |
| 13  | `text/markdown` | .md  | fs.readFile (UTF-8) | 1     | Markdown-aware | README, 6 `##` | **~6** |

### Structured Data API — Separate Pipeline (No DocumentPages)

| #   | MIME Type          | Ext   | Pipeline               | Chunking                                                 | Example Input       | Chunks  | Data Storage       |
| --- | ------------------ | ----- | ---------------------- | -------------------------------------------------------- | ------------------- | ------- | ------------------ |
| 14  | `text/csv`         | .csv  | structured-data worker | Metadata-only                                            | 100K rows, 20 cols  | **1**   | Rows -> ClickHouse |
| 15  | `application/csv`  | .csv  | structured-data worker | Metadata-only                                            | Same                | **1**   | Rows -> ClickHouse |
| 16  | `application/json` | .json | structured-data worker | Metadata-only (array) or JSON object + overflow (single) | 5K-object array     | **1**   | Rows -> ClickHouse |
| 17  | `application/json` | .json | structured-data worker | JSON object + overflow                                   | 1 large object      | **1+N** | N/A                |
| 18  | `.xlsx`            | .xlsx | structured-data worker | Metadata-only                                            | 50K-row spreadsheet | **1**   | Rows -> ClickHouse |
| 19  | `.xls`             | .xls  | structured-data worker | Metadata-only                                            | Legacy Excel        | **1**   | Rows -> ClickHouse |

### Web Crawler Path

| Source       | Content Type | Preprocessing                       | Chunking       | Example                    | Chunks |
| ------------ | ------------ | ----------------------------------- | -------------- | -------------------------- | ------ |
| Crawled URLs | `text/html`  | Readability removes ads/nav/footers | Markdown-aware | Blog post, 3 `##` sections | **~3** |

### Override

When `index.tokenChunkStrategy` is set on the SearchIndex, ALL document types (not structured data) use token-based chunking via ChunkingService regardless of the above defaults.

---

## What Gets Sent to Embeddings

The embedding worker calls `embeddingProvider.embedBatch(texts)` where `texts = chunks.map(c => c.content)`. Here is exactly what each chunk type's `content` field contains:

### Document Chunks

| Chunk Type                                         | Source Formats                          | `content` = What Gets Embedded               | Example                                                                     |
| -------------------------------------------------- | --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Page chunk (`chunkType: 'page'`)                   | PDF, PPTX, PPT, Images (OCR)            | Raw page/slide text as markdown from Docling | `"# Slide Title\n\n- Bullet 1\n- Bullet 2\n\nParagraph text."`              |
| Table chunk (`chunkType: 'table'`)                 | PDF, PPTX (pages with tables)           | `table.markdown` — the table as markdown     | `"\| Name \| Price \|\n\|---\|---\|\n\| Widget \| $9.99 \|"`                |
| Markdown section (`chunkType: 'markdown-section'`) | DOCX, DOC, HTML, Markdown, Crawled HTML | Section text split on H1/H2 headings         | `"## Installation\n\nRun:\n\`\`\`bash\nnpm install\n\`\`\`"`                |
| Token-based (`chunkType: 'token-based'`)           | Any (when tokenChunkStrategy set)       | Text split by token count with overlap       | `"...previous sentence. This chunk starts here. The system uses..."`        |
| Page (plain text)                                  | TXT                                     | Entire file content as-is                    | `"Meeting notes from March 15:\nAttendees: Alice, Bob\n1. Review proposal"` |
| Page (OCR)                                         | PNG, JPEG, TIFF, BMP, WEBP              | OCR-extracted text from the image            | `"INVOICE #12345\nDate: 2026-03-15\nItem: Widget\nTotal: $99.99"`           |

### Structured Data Chunks

| Chunk Type                    | Source Formats                       | `content` = What Gets Embedded                                                                            | Example                                                                                          |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Table metadata                | CSV, Excel (.xlsx/.xls), JSON arrays | `JSON.stringify(metadataChunk)` — schema + 10-20 sample rows as JSON string                               | See CSV example below                                                                            |
| JSON object (small)           | JSON (single object < 8000 tokens)   | `JSON.stringify(fullObject)` — all keys and values as JSON string                                         | `'{"id":"review-1","rating":5,"title":"Great!","text":"This product..."}'`                       |
| JSON object (large, metadata) | JSON (single object > 8000 tokens)   | `JSON.stringify(objectWithLargeFieldsReplaced)` — large fields show `[Large field - see separate chunks]` | `'{"id":"article-1","title":"AI in Healthcare","body":"[Large field - see separate chunks]"}'`   |
| JSON field overflow           | JSON (overflow from large fields)    | Raw text of the large field, sentence-aligned chunks                                                      | `"Artificial intelligence is transforming healthcare. ML algorithms detect diseases earlier..."` |

### Question Chunks (Embedded Alongside Document Chunks)

| Chunk Type              | `content` = What Gets Embedded                             | Example                                                |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Chunk-level question    | `question.question` — the generated question text          | `"What are the system requirements for installation?"` |
| Document-level question | `question.question` — holistic question about the document | `"What is the main purpose of this document?"`         |

---

## Embedding Content Examples

### PDF (10 pages, 2 tables) — 12 chunks embedded

```
Chunk  0: "# Chapter 1: Introduction\n\nThis document covers..." (page 1 text)
Chunk  1: "## Background\n\nThe history of..." (page 2 text)
Chunk  2: "| Metric | Value | Unit |\n|---|---|---|\n| CPU | 95% | % |" (table on page 2)
Chunk  3: "## Methodology\n\nWe used the following approach..." (page 3 text)
...
Chunk  9: "# Appendix\n\nAdditional data tables..." (page 10 text)
Chunk 10: "| Test | Result | Pass |\n|---|---|---|\n| Unit | 98% | Yes |" (table on page 8)
Chunk 11: "| Config | Value |\n|---|---|\n| Timeout | 30s |" (table on page 10)
```

### PPTX (6 slides, no tables) — 6 chunks embedded

```
Chunk 0: "# Slide 1: Company Overview\n\n- Founded 2020\n- 500 employees" (slide 1)
Chunk 1: "# Slide 2: Problem Statement\n\nCustomers face..." (slide 2)
Chunk 2: "# Slide 3: Our Solution\n\n- Feature A\n- Feature B" (slide 3)
Chunk 3: "# Slide 4: Architecture\n\nThe platform uses..." (slide 4)
Chunk 4: "# Slide 5: Results\n\n- 40% faster\n- 99.9% uptime" (slide 5)
Chunk 5: "# Slide 6: Next Steps\n\n1. Phase 2 rollout\n2. Scale" (slide 6)
```

### DOCX (4 sections) — ~4 chunks embedded

```
Chunk 0: "## Part 1: Features\n\n### Tool Management\nMulti-type tool..." (section 1)
Chunk 1: "## Part 2: Integration Flow\n\nThe complete flow from..." (section 2)
Chunk 2: "## Part 3: Remaining Gaps\n\n### Critical\nSecurity..." (section 3)
Chunk 3: "## Part 4: Priority Order\n\n### Tier 1\nFix before..." (section 4)
```

### TXT (5000 words) — 1 chunk embedded

```
Chunk 0: "Meeting notes from March 15, 2026\n\nAttendees: Alice, Bob, Carol\n\nAgenda:\n1. Review Q1 results\n2. Plan Q2 roadmap\n...[entire 5000-word file]..."
```

### PNG image (scanned invoice) — 1 chunk embedded

```
Chunk 0: "INVOICE #12345\nDate: March 15, 2026\nBill To: Acme Corp\n123 Main St\n\nItem          Qty    Price\nWidget A       10     $99.90\nWidget B        5     $49.95\n\nSubtotal: $149.85\nTax: $12.74\nTotal: $162.59"
```

### CSV (100K rows, 5 columns) — 1 chunk embedded

```
Chunk 0: '{"type":"table_metadata","tableName":"customers","displayName":"Customers","description":"Customer records table with 100000 rows and 5 columns","columns":[{"name":"id","type":"integer","nullable":false},{"name":"name","type":"string","nullable":false},{"name":"email","type":"string","nullable":false},{"name":"status","type":"enum","nullable":false},{"name":"join_date","type":"date","nullable":true}],"primaryKey":"id","rowCount":100000,"sampleRows":[{"id":1,"name":"Alice Johnson","email":"alice@example.com","status":"active","join_date":"2024-01-15"},{"id":2,"name":"Bob Smith","email":"bob@example.com","status":"inactive","join_date":"2024-03-20"},...18 more sample rows...],"foreignKeys":[],"statistics":{}}'
```

The embedding captures schema info, column names, types, and sample values — so semantic queries like "find customer email data" can match this metadata chunk. The actual 100K rows are in ClickHouse for SQL queries.

### JSON single small object — 1 chunk embedded

```
Chunk 0: '{"id":"review-1","productId":"prod-123","author":{"name":"Alice Johnson","verified":true,"memberSince":"2020-01-15"},"rating":5,"title":"Excellent product!","reviewText":"This laptop exceeded my expectations. Great performance and battery life.","helpful":42,"date":"2024-01-20"}'
```

All keys and values are embedded together. Queries for "positive laptop reviews" or "Alice Johnson review" can both match.

### JSON single large object (description > 8000 tokens) — 1+N chunks

```
Chunk 0 (metadata): '{"id":"article-1","title":"AI in Healthcare","author":"Dr. Smith","description":"[Large field - see separate chunks]","category":"technology","published":"2024-06"}'

Chunk 1 (overflow): "Artificial intelligence is transforming healthcare delivery. Machine learning algorithms can now detect diseases earlier than traditional methods. In cardiology, AI systems analyze ECG readings with..."

Chunk 2 (overflow): "...clinical trials have shown 95% accuracy in detecting early-stage cancers. The integration of AI into radiology workflows has reduced diagnostic time by 40%. Hospitals adopting..."

Chunk 3 (overflow): "...future directions include personalized medicine powered by genomic AI, remote patient monitoring, and predictive analytics for hospital resource allocation..."
```

### Crawled HTML (blog post after Readability cleaning) — ~3 chunks

```
Chunk 0: "## Product Overview\n\nOur new platform enables teams to build AI agents in minutes. With drag-and-drop workflow design..."
Chunk 1: "## Key Features\n\n- Multi-agent orchestration\n- Built-in guardrails\n- Enterprise SSO integration\n- Audit logging"
Chunk 2: "## Pricing\n\n| Plan | Price | Agents |\n|---|---|---|\n| Starter | $49/mo | 5 |\n| Pro | $199/mo | 25 |"
```

---

## VectorRecord Structure

Each chunk is sent to the vector store with this structure:

```typescript
{
  id: chunk._id,
  vector: [0.123, -0.456, ...],  // embedding array (e.g., 1536 dims)
  content: chunk.content,         // the text shown in examples above
  metadata: {
    sys: { tenantId, appId, connectorId, documentId, chunkId, chunkIndex },
    doc: { name, contentType, contentHash, language, summary },
    canonical: { /* enrichment results */ },
  },
  permissions: {
    publicEverywhere, publicInDomain,
    allowedUsers, allowedGroups, allowedDomains,
    source, lastSyncedAt
  }
}
```

For questions, the metadata also includes:

```typescript
metadata: {
  sys: { ...same, questionId, questionScope },
  question: { type, confidence, scope },
  canonical: {}
}
```

---

## Before vs After (Our Changes)

### Chunk Count Changes

| Document                      | Before    | After         | Why                     |
| ----------------------------- | --------- | ------------- | ----------------------- |
| PPTX (6 slides, no tables)    | 1 chunk   | **6 chunks**  | Per-slide extraction    |
| PPTX (6 slides, 2 tables)     | 3 chunks  | **8 chunks**  | Per-slide + tables      |
| DOCX (4 `##` sections)        | 1 chunk   | **~4 chunks** | Markdown-aware H2 split |
| DOCX (no headings, 26K chars) | 1 chunk   | **1 chunk**   | No headings to split on |
| HTML (5 `##` sections)        | 1 chunk   | **~5 chunks** | Markdown-aware H2 split |
| PDF (10 pages, 2 tables)      | 12 chunks | **12 chunks** | Unchanged               |
| TXT (any size)                | 1 chunk   | **1 chunk**   | Unchanged               |
| Markdown (6 sections)         | ~6 chunks | **~6 chunks** | Unchanged               |
| Images (OCR)                  | 1 chunk   | **1 chunk**   | Unchanged               |

### Token Counting Changes

| Location                                | Before                               | After                               |
| --------------------------------------- | ------------------------------------ | ----------------------------------- |
| extraction-worker.ts (DocumentPage)     | `Math.ceil(text.length / 4)`         | `countTokens(text)` (tiktoken)      |
| page-processing-worker.ts (page chunks) | `page.tokenCount` (carried estimate) | `countTokens(page.text)` (tiktoken) |

---

## Why DOCX/HTML Are 1 Docling Page

**DOCX** is a flow document format. The `.docx` file stores paragraphs, styles, and tables as XML but not pages. Pages only exist when Word renders the content based on paper size, margins, fonts, and printer driver.

**HTML** is also a flow format with no concept of pages.

**PPTX** has discrete slides stored as separate XML files (`slide1.xml`, `slide2.xml`), so Docling correctly reports them as pages.

**PDF** has explicit page boundaries in the file structure.

The Docling library's `DoclingDocument`:

- `doc.pages` = populated for PDF and PPTX (page-based formats)
- `doc.pages` = empty `{}` for DOCX and HTML (flow formats)

Since Docling can't give us page boundaries for DOCX/HTML, we use markdown-aware chunking instead (splitting on heading structure from the markdown export).

---

## Known Limitations

1. **DOCX/HTML without headings**: If a DOCX or HTML has no `##` headings, markdown chunking produces 1 chunk (entire document). Use `tokenChunkStrategy` on the index for these cases.

2. **TXT files**: Always 1 chunk regardless of size. No headings to split on. Use `tokenChunkStrategy` for large text files.

3. **Image chunks for DOCX/HTML**: When DOCX/HTML is split into markdown sections, the chunks don't carry `hasImages` metadata. Images are still stored on the `DocumentPage` and accessible via `documentId`, but individual chunks don't know which images belong to which section.

4. **Structured data embedding**: Only the metadata chunk (schema + 20 sample rows) is embedded. The actual data rows are in ClickHouse only. Semantic search finds the table, then SQL queries fetch the data.

---

## Files Changed

| File                                                                                          | Change                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `services/docling-service/app.py`                                                             | Per-slide extraction for PPTX in `process_pages()`                             |
| `apps/search-ai/src/workers/extraction-worker.ts`                                             | `countTokens()` import + usage                                                 |
| `apps/search-ai/src/workers/page-processing-worker.ts`                                        | Markdown chunking for DOCX/HTML + `countTokens()`                              |
| `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts`                  | `embedding` -> `vector` field name                                             |
| `apps/search-ai-runtime/src/services/__tests__/hybrid-search-builder.test.ts`                 | Test alignment for field rename                                                |
| `apps/search-ai/src/services/mapping-suggestion/__tests__/mapping-suggestion.service.test.ts` | Add PromptLoaderService + circuit-breaker mocks (fix 27 pre-existing failures) |

## Test Results

| Package           | Test Files           | Tests Passed            | Failed |
| ----------------- | -------------------- | ----------------------- | ------ |
| search-ai         | 85 passed, 3 skipped | 1402 passed, 14 skipped | 0      |
| search-ai-runtime | 21 passed            | 519 passed              | 0      |
| **Total**         | **106 passed**       | **1921 passed**         | **0**  |
