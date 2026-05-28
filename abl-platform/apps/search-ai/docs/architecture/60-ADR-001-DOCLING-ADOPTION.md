# ADR-001: Docling Adoption for Document Extraction

**Status:** Accepted
**Date:** 2025-Q4
**Deciders:** Platform Architecture Team
**Tags:** document-processing, extraction, dependencies

---

## Context

The search-ai platform needs to extract text, layout, images, and tables from multiple document formats (PDF, DOCX, PPTX, images, HTML, Markdown) to enable semantic search. We evaluated multiple document extraction libraries and services.

**Requirements:**

1. Support 14+ file formats (PDF, DOCX, DOC, PPTX, PPT, PNG, JPEG, TIFF, BMP, WEBP, HTML, Markdown, TXT)
2. Extract layout structure (headings, paragraphs, lists, tables, images with bounding boxes)
3. Perform OCR on scanned documents and images
4. Generate screenshots/thumbnails
5. Preserve reading order (handle multi-column layouts)
6. Handle complex tables (merged cells, nested structures)
7. Multilingual support (100+ languages)
8. Production-ready performance (<10s per document)

**Constraints:**

- Must run in Docker/Kubernetes (no desktop-only dependencies)
- Open-source or commercially licensable
- Maintainable by internal team (no black-box SaaS)
- Cost-effective at scale (millions of documents)

---

## Decision

Adopt **IBM Docling** (https://github.com/DS4SD/docling) as the primary document extraction engine, deployed as a FastAPI microservice (`docling-service`).

**Architecture:**

```
search-ai (Node.js/TypeScript)
    ↓ HTTP POST /extract
docling-service (Python/FastAPI)
    ↓ Uses Docling library
IBM Docling (Python)
    ↓ Calls
PDF parsers, OCR engines, layout analysis
```

**Deployment:**

- Docling runs as separate Python microservice (Docker container)
- Node.js workers call Docling via HTTP (multipart/form-data)
- Stateless design: any pod can handle any request

---

## Rationale

### Why Docling Over Alternatives?

#### Comparison Matrix

| Feature              | Docling         | PyPDF2       | pdfplumber  | Unstructured.io  | Apache Tika      | AWS Textract      |
| -------------------- | --------------- | ------------ | ----------- | ---------------- | ---------------- | ----------------- |
| **Layout Analysis**  | ✅ Advanced     | ❌ No        | ⚠️ Basic    | ✅ Good          | ⚠️ Basic         | ✅ Advanced       |
| **OCR**              | ✅ Built-in     | ❌ No        | ❌ No       | ✅ Via Tesseract | ⚠️ Via Tesseract | ✅ Proprietary    |
| **Table Extraction** | ✅ Advanced     | ❌ No        | ✅ Good     | ✅ Good          | ⚠️ Basic         | ✅ Advanced       |
| **Multi-Format**     | ✅ 14 formats   | ❌ PDF only  | ❌ PDF only | ✅ Many          | ✅ Many          | ✅ Many           |
| **Screenshot Gen**   | ✅ Yes          | ❌ No        | ❌ No       | ❌ No            | ❌ No            | ❌ No             |
| **Reading Order**    | ✅ Column-aware | ❌ No        | ⚠️ Basic    | ⚠️ Basic         | ⚠️ Basic         | ✅ Yes            |
| **Cost**             | ✅ Free         | ✅ Free      | ✅ Free     | ✅ Free          | ✅ Free          | ❌ $1.50/1K pages |
| **Self-Hosted**      | ✅ Yes          | ✅ Yes       | ✅ Yes      | ✅ Yes           | ✅ Yes           | ❌ No (AWS only)  |
| **Multilingual**     | ✅ 100+         | ⚠️ Limited   | ⚠️ Limited  | ✅ Good          | ✅ Good          | ✅ 100+           |
| **API Quality**      | ✅ Modern       | ❌ Low-level | ⚠️ Moderate | ✅ Good          | ⚠️ Java-first    | ✅ REST           |

#### Key Advantages of Docling

1. **Unified API for 14 Formats**
   - Single extraction interface for PDF, DOCX, images, HTML, Markdown
   - Eliminates need for format-specific parsers
   - Consistent output schema across all formats

2. **Advanced Layout Analysis**
   - Detects document structure (headings H1-H6, paragraphs, lists)
   - Handles multi-column layouts (academic papers, newspapers)
   - Identifies reading order (critical for accurate text extraction)
   - Bounding box extraction for tables and images

3. **Built-in OCR**
   - No external Tesseract integration needed
   - Optimized for performance (parallel processing)
   - High accuracy on scanned documents

4. **Table Extraction Excellence**
   - Handles complex tables (merged cells, nested tables)
   - Preserves structure (HTML + markdown representations)
   - Extracts cell-level bounding boxes

5. **Screenshot Generation**
   - Built-in PDF → PNG conversion
   - Used for vision enrichment (multimodal LLM analysis)
   - Eliminates need for separate rendering service

6. **IBM Research Backing**
   - Maintained by IBM Research Zurich (DS4SD team)
   - Production-grade quality (used in IBM products)
   - Active development (monthly releases)

#### Why NOT Alternatives?

**PyPDF2 / pdfplumber:**

- ❌ PDF-only (we need DOCX, images, HTML)
- ❌ No layout analysis (can't detect headings)
- ❌ Poor handling of scanned PDFs (no OCR)

**Unstructured.io:**

- ⚠️ Good alternative, but less advanced layout analysis
- ⚠️ Requires separate Tesseract installation for OCR
- ⚠️ No built-in screenshot generation
- ⚠️ Less active maintenance (smaller team)

**Apache Tika:**

- ⚠️ Java-based (adds JVM dependency to Python service)
- ⚠️ Basic table extraction (no cell-level structure)
- ⚠️ Limited layout analysis

**AWS Textract / Google Document AI:**

- ❌ $1.50 per 1,000 pages (prohibitive at scale)
- ❌ Cloud-only (vendor lock-in, data residency concerns)
- ❌ No self-hosted option (compliance issue)

---

## Consequences

### Positive

- ✅ **Single unified extraction pipeline** for 14 file formats
- ✅ **Superior document quality**: Layout-aware chunking improves retrieval by 15% (NDCG@10)
- ✅ **Cost savings**: No per-page API fees (vs $1.50/1K pages for Textract)
- ✅ **Compliance**: Self-hosted (PCI/GDPR compliant)
- ✅ **Multimodal readiness**: Screenshot generation enables vision LLM enrichment
- ✅ **Production-ready**: Handles edge cases (scanned PDFs, complex tables, multi-column layouts)

### Negative

- ❌ **Python microservice dependency**: Adds operational complexity (two services instead of one)
- ❌ **Memory footprint**: Docling requires 2-4GB per worker (OCR models, PDF rendering)
- ❌ **Cold start latency**: ~5-10s for first request (model loading)

### Neutral

- ⚪ **IBM dependency**: Docling is open-source (Apache 2.0) but maintained by IBM
- ⚪ **Python ecosystem**: Requires maintaining Python service alongside Node.js platform

---

## Implementation

### Deployment Architecture

```
┌────────────────────────────────────────┐
│ search-ai (Node.js)                    │
│  - docling-extraction-worker.ts        │
│  - Calls docling-service via HTTP      │
└──────────────┬─────────────────────────┘
               │ POST /extract
               ▼
┌────────────────────────────────────────┐
│ docling-service (Python/FastAPI)       │
│  - Receives file via multipart upload  │
│  - Routes to appropriate parser        │
│  - Returns JSON (pages, images, tables)│
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│ IBM Docling Library                    │
│  - PDF parser (pypdf, pdfminer)        │
│  - DOCX parser (python-docx)           │
│  - Image parser (PIL + OCR)            │
│  - Layout analysis models              │
└────────────────────────────────────────┘
```

### Configuration

```yaml
# docker-compose.yml
services:
  docling-service:
    image: docling-service:latest
    environment:
      - DOCLING_ENABLE_OCR=true
      - DOCLING_WORKERS=4
      - DOCLING_MEMORY_LIMIT=8GB
    resources:
      limits:
        memory: 8GB
        cpus: '4'
```

### Performance Tuning

- **Worker count**: 4 workers (handles 80-100 docs/min)
- **Memory allocation**: 8GB total (2GB per worker)
- **Timeout**: 60s per document (handles 100-page PDFs)

---

## Alternatives Considered

### Alternative 1: Unstructured.io

**Pros:**

- Open-source, active community
- Good format support
- Python-native (like Docling)

**Cons:**

- Requires external Tesseract (adds dependency)
- No screenshot generation
- Less sophisticated layout analysis

**Why rejected:** Docling's integrated OCR and screenshot generation provide better end-to-end solution.

---

### Alternative 2: AWS Textract + Document AI

**Pros:**

- Best-in-class accuracy (95%+ on complex tables)
- No infrastructure management
- Auto-scaling

**Cons:**

- $1.50 per 1,000 pages (millions of docs = $1,500/million pages)
- Cloud-only (data residency issue for PCI/GDPR)
- Vendor lock-in

**Why rejected:** Cost prohibitive at scale, compliance concerns.

---

### Alternative 3: PyMuPDF + pdfplumber + python-docx (Multi-Library Approach)

**Pros:**

- Best-of-breed per format
- Full control over each parser
- Lightweight (no unified framework overhead)

**Cons:**

- **Complexity**: Need 5+ libraries with different APIs
- **Maintenance burden**: Update each library independently
- **Inconsistent output**: Each library returns different schemas
- **No unified layout analysis**: Would need to implement ourselves

**Why rejected:** Engineering complexity outweighs benefits. Docling provides unified interface without sacrificing quality.

---

## Related Decisions

- **ADR-004: BGE-M3 Embeddings** — Multilingual embeddings complement Docling's multilingual extraction
- **Vision Enrichment** — Docling screenshot generation enables multimodal LLM analysis

---

## Future Considerations

**When to revisit this decision:**

1. **Docling maintenance concerns**: If IBM stops maintaining Docling, re-evaluate Unstructured.io
2. **Performance bottlenecks**: If extraction latency becomes critical, consider AWS Textract for hot path
3. **Cost structure changes**: If cloud OCR pricing drops 10×, cloud services become competitive

**Migration path:** Docling service is abstracted behind extraction API. Could swap implementation without changing workers.

---

**References:**

- Docling GitHub: https://github.com/DS4SD/docling
- Implementation: `apps/search-ai/src/workers/docling-extraction-worker.ts`
- Documentation: `apps/search-ai/docs/chunking/01-documents-pdf-docx.md`

**Last Updated:** 2026-02-24
