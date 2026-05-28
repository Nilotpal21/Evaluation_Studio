# Unified Document Extraction Service

FastAPI microservice for extracting structured content from documents using [IBM Docling](https://github.com/DS4SD/docling) (PDFs, Office docs, images, markdown, CSV) and [LlamaIndex](https://www.llamaindex.ai/) (plain text, JSON, XML).

## Features

- **14 supported formats** - Unified API for all document types
- **Intelligent routing** - Auto-routes to Docling or LlamaIndex based on format
- **Page-by-page extraction** with layout preservation
- **Table detection** with structure (headers, rows, cells)
- **Image extraction** per page with OCR
- **Structure preservation** for markdown (headings, code blocks, tables)
- **Page screenshots** rendering
- **Heading hierarchy** detection
- **High-quality language detection** - Handles mixed-language content (e.g., English terms in Chinese documents)
  - Hierarchical detection strategy (fasttext → sampling → lingua → script)
  - Multi-sample voting for accurate detection
  - Supports 50+ languages with confidence scores
  - Explicit language override via API
- **Document metadata extraction** - Extracts author, dates, title, subject, keywords from documents
  - Automatic extraction from PDF, DOCX, PPTX properties
  - Explicit metadata override via API parameters
  - ISO 8601 date format support

## Supported Formats (14 Total)

### Docling Path (13 formats)

IBM Docling handles complex document formats with layout, tables, and images:

- **PDF** - Layout, tables, images, OCR, screenshots
- **Microsoft Office**
  - DOCX/DOC - Text, tables, images
  - PPTX/PPT - Slides, text, tables, images
- **Web**
  - HTML - Text, tables, structure
- **Images** - PNG, JPEG, JPG, TIFF, BMP, WEBP (with OCR)
- **Structured Text**
  - **Markdown** - Native support with structure preservation

### LlamaIndex Path (1 format)

LlamaIndex handles plain text:

- **TXT** - Plain text extracted as single page, chunked downstream in page-processing worker

**Note**: TXT files are NOT chunked during extraction to avoid double chunking. They are extracted as a single page and chunked using the same strategy as other formats in the page-processing pipeline.

### Unsupported (Requires Hierarchical Tree Extraction)

These formats need specialized structured data handling (task #15):

- **CSV** - Requires table-aware extraction, row-based chunking, column metadata
- **JSON** - Requires nested structure preservation, JSON path indexing
- **XML** - Requires element hierarchy preservation, structure-aware chunking

## Architecture

```
┌─────────────────┐
│  /extract API   │
└────────┬────────┘
         │
         ↓
  ┌──────────────┐
  │Content-Type  │
  │   Routing    │
  └──────┬───────┘
         │
    ┌────┴─────┐
    ↓          ↓
┌────────┐  ┌───────────┐
│Docling │  │LlamaIndex │
│        │  │           │
│PDF     │  │TXT        │
│Office  │  │JSON       │
│HTML    │  │XML        │
│Images  │  │           │
│Markdown│  │           │
│CSV     │  │           │
└────┬───┘  └─────┬─────┘
     │            │
     └─────┬──────┘
           ↓
    ┌─────────────┐
    │  Unified    │
    │  PageData   │
    │  Response   │
    └─────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+ (or Docker)
- [uv](https://github.com/astral-sh/uv) - Fast Python package manager

### Option 1: Docker (Recommended)

```bash
# Build and run
docker build -t docling-service .
docker run -p 8080:8080 docling-service

# Or use docker-compose
docker-compose up docling-service

# Test
curl http://localhost:8080/health
```

### Option 2: Local Development with uv

```bash
# Install uv if not already installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -e .

# Install system dependencies (Ubuntu/Debian)
sudo apt-get install -y poppler-utils tesseract-ocr

# Run service
python app.py
```

## Configuration

### Environment Variables

```bash
# Token Counting (Optional)
# Tokenizer model for accurate token counting (default: cl100k_base)
# Options: cl100k_base (GPT-4), p50k_base (GPT-3), r50k_base (GPT-3 older)
TOKENIZER_MODEL=cl100k_base
```

## Usage

### Health Check

```bash
curl http://localhost:8080/health
```

Response shows both engines and features:

```json
{
  "status": "healthy",
  "service": "unified-extraction-service",
  "version": "2.1.0",
  "engines": {
    "docling": {
      "available": true,
      "formats": 13
    },
    "llamaindex": {
      "available": true,
      "formats": 1
    }
  },
  "features": {
    "language_detection": true
  },
  "total_formats": 14
}
```

### Extract PDF (Docling)

```bash
curl -X POST http://localhost:8080/extract \
  -F "file=@sample.pdf" \
  -F 'options={"extractImages": true, "extractTables": true, "renderScreenshots": true}'
```

### Extract Markdown (Docling)

```bash
curl -X POST http://localhost:8080/extract \
  -F "file=@document.md" \
  -F 'options={"extractImages": false, "extractTables": true}'
```

### Extract Plain Text (LlamaIndex)

```bash
curl -X POST http://localhost:8080/extract \
  -F "file=@article.txt" \
  -F 'options={"extractImages": false, "extractTables": false}'
```

### Language Detection (Automatic)

```bash
# Auto-detect language (default behavior)
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"extractImages": true, "extractTables": true}'
```

### Language Detection (Explicit Override)

```bash
# Override detected language with explicit ISO 639-1 code
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"extractImages": true}' \
  -F "language=zh"
```

### Language Detection (Disabled)

```bash
# Disable language detection
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"extractImages": true}' \
  -F "detectLanguage=false"
```

### Document Metadata (Automatic Extraction)

```bash
# Auto-extract metadata from PDF/DOCX/PPTX properties
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"extractImages": true, "extractTables": true}'
```

### Document Metadata (Explicit Override)

```bash
# Override extracted metadata with explicit values
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"extractImages": true}' \
  -F "author=John Doe" \
  -F "title=Technical Documentation" \
  -F "subject=API Reference" \
  -F "createdDate=2024-01-15T10:30:00" \
  -F "modifiedDate=2024-02-20T15:45:00" \
  -F "keywords=API, documentation, technical"
```

## API Reference

### POST /extract

Extract structured content from any supported document format.

**Request:**

```typescript
{
  file: File,                  // Document file (any of 14 formats)
  options: {
    extractImages: boolean,     // Extract images (default: true)
    extractTables: boolean,     // Extract tables (default: true)
    preserveLayout: boolean,    // Preserve layout (default: true)
    renderScreenshots: boolean, // Render screenshots (default: true)
    ocrEnabled: boolean        // Enable OCR (default: true)
  },
  language?: string,            // Optional: Explicit language override (ISO 639-1, e.g., "en", "zh")
  detectLanguage?: boolean,     // Optional: Enable auto-detection (default: true)
  author?: string,              // Optional: Explicit author (overrides extracted metadata)
  title?: string,               // Optional: Explicit title (overrides extracted metadata)
  subject?: string,             // Optional: Explicit subject (overrides extracted metadata)
  createdDate?: string,         // Optional: Explicit creation date (ISO 8601, overrides extracted)
  modifiedDate?: string,        // Optional: Explicit modification date (ISO 8601, overrides extracted)
  keywords?: string             // Optional: Comma-separated keywords (overrides extracted)
}
```

**Response:**

```json
{
  "pages": [
    {
      "pageNumber": 1,
      "text": "Document content in Markdown...",
      "layout": {
        "headings": [
          {"level": 1, "text": "Introduction", "bbox": {...}}
        ]
      },
      "tables": [...],
      "images": [...],
      "screenshot": "base64_encoded_screenshot..."
    }
  ],
  "metadata": {
    "pageCount": 10,
    "hasOCR": false,
    "totalTables": 5,
    "totalImages": 3,
    "processingTime": 2.5,
    "documentType": "pdf",
    "language": "en",
    "languageConfidence": 0.97,
    "languageScript": "Latin",
    "languageDetectionMethod": "fasttext-confident",
    "secondaryLanguages": [{"lang": "fr", "confidence": 0.15}],
    "author": "John Doe",
    "title": "Technical Documentation",
    "subject": "API Reference",
    "createdDate": "2024-01-15T10:30:00",
    "modifiedDate": "2024-02-20T15:45:00",
    "keywords": ["API", "documentation", "technical"]
  },
  "structure": {
    "outline": [...],
    "documentType": "pdf"
  }
}
```

### GET /health

Health check endpoint showing engine availability.

**Response:**

```json
{
  "status": "healthy",
  "service": "unified-extraction-service",
  "version": "2.0.0",
  "timestamp": "2026-02-23T14:30:00",
  "engines": {
    "docling": {
      "available": true,
      "formats": 14
    },
    "llamaindex": {
      "available": true,
      "formats": 4
    }
  },
  "total_formats": 18
}
```

## Format-Specific Behavior

### Markdown (Docling)

- Native structure preservation
- Headings, code blocks, tables kept intact
- Returns markdown-formatted text in pages

### Plain Text (LlamaIndex)

- Extracted as single page (full text content)
- NO chunking during extraction (avoids double chunking)
- Chunking happens downstream in page-processing worker
- Uses consistent chunking strategy with other formats

### Language Detection

- **Automatic detection** from document content (first 5 pages sampled)
- **Mixed-language support** - Handles documents with foreign words (e.g., English terms in Chinese)
- **Detection methods**:
  - fasttext: Fast detection (< 5ms, 93% accuracy)
  - Multi-sample voting: For mixed-language content
  - lingua: High-accuracy definitive detection (99% accuracy)
  - Script analysis: Fallback for very short text
- **Explicit override** via `language` parameter (ISO 639-1 codes)
- **Enable/disable** via `detectLanguage` parameter
- **Supported languages**: 50+ (English, Spanish, French, German, Chinese, Japanese, Korean, Arabic, Russian, Hindi, and more)
- **Output**: Primary language, confidence score, script, secondary languages

### Document Metadata

- **Automatic extraction** from document properties:
  - **PDF**: Author, title, subject, keywords, creation date, modification date (via PyPDF2)
  - **DOCX**: Core properties from Office documents (via python-docx)
  - **PPTX**: Core properties from PowerPoint files (via python-pptx)
- **Explicit override** via API parameters (overrides extracted metadata):
  - `author`: Document author
  - `title`: Document title
  - `subject`: Document subject/category
  - `createdDate`: Creation date (ISO 8601 format)
  - `modifiedDate`: Modification date (ISO 8601 format)
  - `keywords`: Comma-separated keywords
- **Merging behavior**: Explicit parameters override extracted metadata
- **Date format**: ISO 8601 (e.g., `2024-01-15T10:30:00`)
- **Use cases**:
  - Preserve original document authorship in search index
  - Track document versioning with creation/modification dates
  - Organize documents by subject and keywords
  - Override incorrect or missing embedded metadata

## Development

### Setup with uv

```bash
# Create venv and install deps
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"

# Run with auto-reload
uvicorn app:app --reload

# Format code
ruff format .

# Lint code
ruff check .
```

### Run Tests

```bash
# Install dev dependencies
uv pip install -e ".[dev]"

# Run all tests
pytest

# Run specific test suite
uv run pytest test_text_formats.py -v

# Test manually
python test_extraction.py sample.pdf
```

### Test Coverage

- `test_text_formats.py` - LlamaIndex format tests (TXT, JSON, XML)
- Manual testing for Docling formats (PDF, Office, markdown, CSV)

## Integration with Search-AI

The extraction worker calls this unified service for all document types:

```typescript
// apps/search-ai/src/workers/docling-extraction-worker.ts

import axios from 'axios';
import FormData from 'form-data';

export class DoclingExtractionWorker extends Worker {
  async process(job: Job<ExtractionJobData>) {
    const { documentId, sourceUrl, contentType } = job.data;

    // Download document from S3
    const documentBuffer = await downloadFromS3(sourceUrl);

    // Call unified extraction service (auto-routes to Docling or LlamaIndex)
    const form = new FormData();
    form.append('file', documentBuffer, {
      filename: 'document',
      contentType,
    });
    form.append(
      'options',
      JSON.stringify({
        extractImages: true,
        extractTables: true,
        renderScreenshots: true,
        ocrEnabled: true,
      }),
    );

    const response = await axios.post(process.env.DOCLING_SERVICE_URL + '/extract', form, {
      headers: form.getHeaders(),
    });

    const result = response.data;

    // Store pages in MongoDB
    for (const page of result.pages) {
      await DocumentPage.create({
        documentId,
        pageNumber: page.pageNumber,
        text: page.text,
        layout: page.layout,
        tables: page.tables,
        images: page.images,
        screenshot: page.screenshot,
      });
    }
  }
}
```

## Performance

| Document Type     | Format | Engine     | Pages | Processing Time | Memory Usage |
| ----------------- | ------ | ---------- | ----- | --------------- | ------------ |
| Simple PDF        | PDF    | Docling    | 10    | 2.5s            | 600 MB       |
| Complex PDF       | PDF    | Docling    | 50    | 15s             | 1.2 GB       |
| Scanned PDF (OCR) | PDF    | Docling    | 10    | 8s              | 800 MB       |
| Markdown          | MD     | Docling    | 1     | 0.3s            | 200 MB       |
| Plain Text        | TXT    | LlamaIndex | 1     | 0.2s            | 150 MB       |
| JSON              | JSON   | LlamaIndex | 1     | 0.1s            | 100 MB       |

## Troubleshooting

### uv not found

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Tesseract not found

```bash
# Ubuntu/Debian
sudo apt-get install tesseract-ocr

# MacOS
brew install tesseract
```

### Poppler not found

```bash
# Ubuntu/Debian
sudo apt-get install poppler-utils

# MacOS
brew install poppler
```

### LlamaIndex import errors

```bash
# Reinstall dependencies
uv pip install -e .
```

### Format routing issues

Check `/health` endpoint to see engine availability:

```bash
curl http://localhost:8080/health
```

If an engine is unavailable, check logs for import errors.

## Why uv?

We use [uv](https://github.com/astral-sh/uv) as the Python package manager because:

- ⚡ **10-100x faster** than pip
- 🔒 **Reliable lockfiles** for reproducible builds
- 🎯 **Modern** dependency resolution
- 🐳 **Docker-friendly** (single binary, fast installs)
- 📦 **Compatible** with pip and pyproject.toml

## License

MIT
