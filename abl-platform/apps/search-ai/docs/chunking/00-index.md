# ATLAS Search - Chunking & Extraction Documentation

**Version:** 2.0
**Last Updated:** 2026-02-23
**Status:** Production

---

## Overview

This documentation covers the complete chunking and extraction pipeline for all supported file types in ATLAS Search. Each document type has been optimized for semantic search with careful consideration of structure preservation, tenant isolation, and retrieval quality.

---

## Documentation Structure

### By Mime Type

| Document Type      | File                                                             | Description                                      |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| **Documents**      | [01-documents-pdf-docx.md](./01-documents-pdf-docx.md)           | PDF, DOCX, PPTX, and other document formats      |
| **CSV Tables**     | [02-structured-csv.md](./02-structured-csv.md)                   | CSV files with table-aware extraction            |
| **JSON (Nested)**  | [03-structured-json-nested.md](./03-structured-json-nested.md)   | Nested JSON objects with hierarchical extraction |
| **JSON (Tabular)** | [04-structured-json-tabular.md](./04-structured-json-tabular.md) | JSON arrays of flat objects (table-like)         |
| **Excel**          | [05-structured-excel.md](./05-structured-excel.md)               | Excel spreadsheets (references CSV extraction)   |

### Cross-Cutting Concerns

| Topic                | File                                                                 | Description                                |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| **Architecture**     | [10-architecture-overview.md](./10-architecture-overview.md)         | System architecture and worker pipeline    |
| **Tenant Isolation** | [11-security-tenant-isolation.md](./11-security-tenant-isolation.md) | Multi-tenant security patterns             |
| **Retrieval**        | [20-retrieval-checklist.md](./20-retrieval-checklist.md)             | Improvements checklist and recommendations |

---

## Quick Start

### For Engineers Onboarding

**Step 1:** Read the [Architecture Overview](./10-architecture-overview.md) to understand the worker pipeline.

**Step 2:** Choose your document type and read the corresponding guide:

- Working with PDFs? → [Documents Guide](./01-documents-pdf-docx.md)
- Working with CSVs? → [CSV Guide](./02-structured-csv.md)
- Working with JSON? → [Nested JSON](./03-structured-json-nested.md) or [Tabular JSON](./04-structured-json-tabular.md)

**Step 3:** Review [Tenant Isolation](./11-security-tenant-isolation.md) for security patterns.

**Step 4:** Check the [Retrieval Checklist](./20-retrieval-checklist.md) when implementing search features.

---

## Key Concepts

### Chunking Philosophy

**Goal:** Balance between chunk size, semantic coherence, and retrieval accuracy.

**Principles:**

1. **Semantic Boundaries** - Chunks respect natural content boundaries (sentences, paragraphs, sections)
2. **Context Preservation** - Include enough context for standalone understanding
3. **Size Optimization** - Target 512 tokens, max 1024 tokens per chunk
4. **Structure Awareness** - Different strategies for structured (tables/JSON) vs unstructured (documents) data
5. **Tenant Isolation** - Every chunk includes tenantId + indexId for multi-tenant security

---

## Pipeline Stages

All documents flow through a standardized pipeline:

```
┌──────────────┐
│  Ingestion   │ → Document uploaded, metadata extracted
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Extraction  │ → Content extracted (Docling/CSV parser/JSON parser)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Chunking   │ → Content split into semantic chunks
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Enrichment  │ → Canonical mapping, entity extraction, etc.
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Embedding   │ → Vector embeddings generated
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Indexed    │ → Ready for search
└──────────────┘
```

**Document-Specific Variations:**

- **Documents:** Includes vision enrichment for images/diagrams
- **CSV/Tables:** Includes schema analysis and ClickHouse storage
- **JSON (Nested):** Includes path extraction for hierarchical queries
- **JSON (Tabular):** Treated as table with automatic schema detection

---

## Worker Architecture

```
┌─────────────────┐
│ Ingestion Worker│ Entry point, fanout to extraction
└────────┬────────┘
         │
         ├─────────────────────────────────────┐
         │                                     │
         ▼                                     ▼
┌────────────────────┐              ┌──────────────────────┐
│ Docling Extraction │              │ Structured Data      │
│ Worker (PDFs)      │              │ Ingestion Worker     │
└─────────┬──────────┘              │ (CSV/JSON/Excel)     │
          │                         └──────────┬───────────┘
          ▼                                    │
┌────────────────────┐                         │
│ Page Processing    │                         │
│ Worker (Chunking)  │                         │
└─────────┬──────────┘                         │
          │                                    │
          └──────────────┬─────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ Canonical Mapper     │
              │ Worker (Enrichment)  │
              └──────────┬───────────┘
                         │
                         ├───────────────────────────────┐
                         │                               │
                         ▼                               ▼
              ┌──────────────────────┐      ┌──────────────────────┐
              │ Vision Enrichment    │      │ Entity Extraction    │
              │ Worker (Images)      │      │ (Optional)           │
              └──────────┬───────────┘      └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ Embedding Worker     │
              │ (Vector Generation)  │
              └──────────────────────┘
```

---

## Performance Characteristics

| Document Type       | Extraction Speed | Chunk Count (per 100 pages) | Embedding Cost (per 100 pages) |
| ------------------- | ---------------- | --------------------------- | ------------------------------ |
| **PDF**             | 2-5 sec/page     | 150-300 chunks              | $0.05-$0.15                    |
| **CSV (1K rows)**   | <1 sec           | 1 metadata chunk            | $0.001                         |
| **CSV (100K rows)** | 1-2 sec          | 1 metadata chunk            | $0.001                         |
| **JSON (nested)**   | <1 sec/object    | 1-5 chunks                  | $0.005-$0.02                   |
| **JSON (tabular)**  | <1 sec           | 1 metadata chunk            | $0.001                         |
| **Excel**           | 1-3 sec/sheet    | 1 chunk/sheet               | $0.001-$0.005                  |

**Note:** Structured data (CSV, JSON tabular, Excel) uses metadata-only chunking with ClickHouse storage for actual data, resulting in 99.9% chunk reduction vs naive row-by-row chunking.

---

## Common Patterns

### 1. Metadata-Only Chunking (Structured Data)

**Used For:** CSV, Excel, JSON arrays of flat objects

**Strategy:**

- Store actual data in ClickHouse (column-oriented, optimized for analytics)
- Create single metadata chunk per table with schema + sample rows
- Embed metadata chunk for semantic table discovery
- Query actual data via text-to-SQL

**Benefits:**

- 99.9% chunk reduction (100K rows → 1 chunk)
- Sub-second table queries via ClickHouse
- Preserves full relational query capabilities

---

### 2. Hierarchical Chunking (Nested JSON)

**Used For:** Deeply nested JSON objects, API responses, config files

**Strategy:**

- Store full object as primary chunk
- Extract all paths to ClickHouse path index
- Support both semantic search (on full object) and path-based queries

**Benefits:**

- Path-based queries: `users[0].email`
- Pattern matching: `users[].name`
- Preserves full object context

---

### 3. Sentence-Aligned Chunking (Documents)

**Used For:** PDFs, DOCX, text documents

**Strategy:**

- Split by natural boundaries (paragraphs, headings)
- Never split mid-sentence
- Target 512 tokens, max 1024 tokens
- Include progressive summaries for context

**Benefits:**

- Semantically coherent chunks
- High retrieval accuracy
- Context-aware with progressive summaries

---

## Security & Isolation

**Every chunk includes:**

- `tenantId` - Tenant identifier
- `indexId` - Index identifier (multi-index per tenant)
- `documentId` - Document identifier

**All queries MUST filter by:**

```typescript
SearchChunk.find({
  tenantId,
  indexId,
  // ... other filters
});
```

**Never use:**

- `SearchChunk.findById(id)` - No tenant isolation!
- `SearchChunk.find({ documentId })` - Missing tenant/index!

See [Tenant Isolation Guide](./11-security-tenant-isolation.md) for details.

---

## Testing & Quality

### Unit Tests

Each chunking strategy has comprehensive unit tests:

- `chunking-strategy.test.ts` - CSV/Table chunking
- `json-chunking-strategy.test.ts` - JSON chunking
- `path-extractor.test.ts` - Path extraction
- `foreign-key-detector.test.ts` - FK detection

### Integration Tests

End-to-end pipeline tests:

- `phase2-integration.test.ts` - Document processing pipeline
- `structured-data-integration.test.ts` - Structured data pipeline
- `end-to-end-validation.test.ts` - Quality validation

### Quality Metrics

We track:

- **Chunk count efficiency** - Fewer chunks = lower cost
- **Retrieval accuracy** - Semantic search precision
- **Processing time** - End-to-end latency
- **Embedding cost** - Per document/table

---

## Contributing

When adding support for new document types:

1. **Read existing guides** - Follow established patterns
2. **Choose chunking strategy** - Metadata-only vs full chunking
3. **Implement worker** - Follow worker architecture
4. **Add tests** - Unit + integration tests
5. **Document** - Add guide following this structure
6. **Update checklist** - Add retrieval considerations

---

## Support

**Questions?** Check the [Architecture Overview](./10-architecture-overview.md)

**Security Concerns?** See [Tenant Isolation](./11-security-tenant-isolation.md)

**Retrieval Issues?** Review [Retrieval Checklist](./20-retrieval-checklist.md)

---

**Next:** Start with [Architecture Overview](./10-architecture-overview.md) →
