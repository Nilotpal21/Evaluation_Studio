# Document Chunking - PDF, DOCX, PPTX

**Applies To:** PDF, DOCX, PPTX, TXT, Markdown
**Strategy:** Sentence-aligned chunking with progressive summarization
**Worker:** `docling-extraction-worker.ts` → `page-processing-worker.ts`

---

## Overview

Document chunking uses a **progressive, sentence-aligned strategy** that preserves semantic boundaries while maintaining optimal chunk sizes for embedding and retrieval.

**Key Features:**

- Sentence-aligned boundaries (never splits mid-sentence)
- Progressive summarization (each page includes context from previous pages)
- Vision enrichment for images and diagrams
- Table extraction as separate chunks
- Adaptive chunking for markdown vs PDF

---

## Pipeline Stages

```
┌─────────────────┐
│ 1. Extraction   │ → Docling extracts text, layout, images, tables
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Page         │ → Pages converted to DocumentPage records
│    Processing   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Chunking     │ → Text split into sentence-aligned chunks
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Progressive  │ → Each chunk gets summary of previous content
│    Summarization│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Vision       │ → Images analyzed with vision LLM (if enabled)
│    Enrichment   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 6. Question     │ → Questions generated for each chunk
│    Synthesis    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 7. Embedding    │ → Vector embeddings generated
└─────────────────┘
```

---

## Stage 1: Extraction (Docling)

**Worker:** `docling-extraction-worker.ts`
**Service:** `docling-service` (Python microservice)
**Supported Formats:** 14 formats

**Input:**

- Document file (PDF, DOCX, etc.)
- Tenant ID + Index ID
- Document metadata

---

### Docling Service Integration

**Docling** is a Python microservice (FastAPI) that provides unified document extraction across 14 formats using IBM's Docling library. It handles layout analysis, OCR, table extraction, image extraction, and screenshot rendering.

**Service Architecture:**

```
┌────────────────────────────────────────────────────────────────┐
│ docling-extraction-worker.ts (search-ai)                       │
└────────────────────┬───────────────────────────────────────────┘
                     │ HTTP POST /extract (multipart/form-data)
                     ▼
┌────────────────────────────────────────────────────────────────┐
│ docling-service (Python + FastAPI)                            │
│                                                                │
│  1. Format Detection → 2. Layout Analysis → 3. OCR (if needed)│
│  4. Table Extraction → 5. Image Extraction → 6. Screenshot    │
└────────────────────┬───────────────────────────────────────────┘
                     │ JSON response with pages, images, tables
                     ▼
┌────────────────────────────────────────────────────────────────┐
│ docling-extraction-worker.ts                                   │
│ - Upload images/screenshots to S3                              │
│ - Create DocumentPage records in MongoDB                       │
│ - Enqueue page-processing jobs                                 │
└────────────────────────────────────────────────────────────────┘
```

---

### Supported Formats (14 Total)

**Documents (5):**

- PDF (.pdf) - Full layout analysis + OCR
- DOCX (.docx) - Microsoft Word (Office Open XML)
- DOC (.doc) - Legacy Microsoft Word
- PPTX (.pptx) - Microsoft PowerPoint
- PPT (.ppt) - Legacy PowerPoint

**Images (6):**

- PNG (.png)
- JPEG (.jpeg, .jpg)
- TIFF (.tiff, .tif)
- BMP (.bmp)
- WEBP (.webp)

**Markup (2):**

- HTML (.html, .htm)
- Markdown (.md)

**Text (1):**

- TXT (.txt) - Plain text via LlamaIndex

---

### Docling Processing Stages

#### Stage 1a: Format Detection

**Purpose:** Determine document type and select appropriate parser

**Logic:**

```python
# Content type detection (from upload)
content_type = file.content_type  # e.g., 'application/pdf'

# Extension detection (from filename)
extension = filename.split('.')[-1].lower()

# Route to parser
if extension in ['pdf', 'docx', 'pptx', ...]:
    parser = DoclingParser(format=extension)
elif extension in ['png', 'jpg', 'jpeg', ...]:
    parser = ImageParser(format=extension)
elif extension == 'txt':
    parser = LlamaIndexParser()
elif extension == 'md':
    parser = MarkdownParser()
```

**Output:** Selected parser for document

---

#### Stage 1b: Layout Analysis

**Purpose:** Detect document structure (headings, paragraphs, lists, tables, images)

**When:** All formats except TXT

**Process:**

1. **Load Document:**

   ```python
   document = DoclingDocument.load(file_path)
   ```

2. **Analyze Layout:**
   - Heading detection (H1-H6)
   - Paragraph segmentation
   - List detection (ordered, unordered)
   - Table detection (bounding boxes)
   - Image detection (bounding boxes, captions)
   - Reading order detection (column-aware)

3. **Extract Hierarchical Structure:**
   ```python
   outline = document.get_outline()
   # Returns: [
   #   {'level': 1, 'text': 'Introduction', 'pageNumber': 1},
   #   {'level': 2, 'text': 'Background', 'pageNumber': 1},
   #   ...
   # ]
   ```

**Output:**

- Document outline (heading hierarchy)
- Bounding boxes for all elements
- Reading order for multi-column layouts

---

#### Stage 1c: OCR (Optical Character Recognition)

**Purpose:** Extract text from scanned PDFs or images

**When:**

- PDF is image-based (no embedded text)
- Input is an image file (PNG, JPEG, etc.)
- Explicitly requested via `ocrEnabled=true`

**OCR Engine:** Tesseract (via docling)

**Language Support:** 50+ languages (auto-detected)

**Process:**

1. **Detect if OCR needed:**

   ```python
   if not document.has_embedded_text():
       requires_ocr = True
   ```

2. **Run OCR:**

   ```python
   ocr_result = document.extract_with_ocr(
       language='auto',  # Auto-detect from 50+ languages
       dpi=300
   )
   ```

3. **Merge OCR text with layout:**
   - OCR text mapped to bounding boxes
   - Reading order preserved
   - Confidence scores per text block

**Output:**

- Extracted text with bounding boxes
- Confidence scores (0-1 per block)
- Language detection result

---

#### Stage 1d: Table Extraction

**Purpose:** Extract tables as structured data (rows × columns)

**When:** Tables detected in layout analysis

**Process:**

1. **Detect Tables:**

   ```python
   tables = document.find_tables()
   # Returns bounding boxes for each table
   ```

2. **Extract Table Structure:**
   - Header row detection
   - Cell extraction (text per cell)
   - Merged cell handling
   - Row/column span detection

3. **Generate Multiple Formats:**
   ```python
   for table in tables:
       table_data = {
           'rows': [['Cell1', 'Cell2'], ...],
           'headers': ['Column1', 'Column2'],
           'html': table.to_html(),
           'markdown': table.to_markdown(),
           'bbox': {'x0': 100, 'y0': 200, ...},
           'isComplete': table.all_cells_extracted
       }
   ```

**Output:**

- Rows as 2D array
- Headers extracted
- HTML format (with styling)
- Markdown format (for embedding)
- Bounding box coordinates
- Completeness flag (partial extraction warning)

---

#### Stage 1e: Image Extraction

**Purpose:** Extract embedded images from document

**When:** Images detected in layout analysis

**Process:**

1. **Detect Images:**

   ```python
   images = document.find_images()
   ```

2. **Extract Image Data:**

   ```python
   for image in images:
       image_data = {
           'data': base64.b64encode(image.bytes),  # Base64
           'format': image.format,  # 'png', 'jpeg', etc.
           'width': image.width,
           'height': image.height,
           'bbox': {'x0': 100, 'y0': 200, ...},
           'caption': image.get_caption()  # If available
       }
   ```

3. **Extract Captions:**
   - Text immediately below/above image
   - Figure numbers (Figure 1, Fig. 2, etc.)
   - Caption text extraction

**Output:**

- Base64-encoded image data
- Image format (PNG, JPEG, etc.)
- Dimensions (width × height)
- Bounding box coordinates
- Caption text (if available)

---

#### Stage 1f: Screenshot Rendering

**Purpose:** Render full-page screenshots for visual context

**When:** `renderScreenshots=true` (default for PDFs)

**Process:**

1. **Render Page to Image:**

   ```python
   screenshot = page.render_to_image(
       dpi=150,  # Balance quality vs file size
       format='png'
   )
   ```

2. **Encode Screenshot:**
   ```python
   screenshot_data = {
       'data': base64.b64encode(screenshot.bytes),
       'format': 'png',
       'width': screenshot.width,
       'height': screenshot.height
   }
   ```

**Output:**

- Base64-encoded PNG screenshot
- Dimensions (width × height)
- Used for vision enrichment (GPT-4o, Claude 3.5 Sonnet)

---

### API Contract

**Endpoint:** `POST /extract`
**Content-Type:** `multipart/form-data`

**Request:**

```http
POST /extract
Content-Type: multipart/form-data

file: [binary file data]
extractImages: true
extractTables: true
renderScreenshots: true
ocrEnabled: true
```

**Response:**

```json
{
  "pages": [
    {
      "pageNumber": 1,
      "text": "Page text content...",
      "layout": {
        "headings": [
          {"level": 1, "text": "Introduction", "bbox": {...}}
        ],
        "structure": {...}
      },
      "tables": [
        {
          "rows": [["Cell1", "Cell2"], ["Cell3", "Cell4"]],
          "headers": ["Column1", "Column2"],
          "html": "<table>...</table>",
          "markdown": "| Column1 | Column2 |\n|---------|---------|...",
          "bbox": {"x0": 100, "y0": 200, "x1": 500, "y1": 400},
          "isComplete": true
        }
      ],
      "images": [
        {
          "data": "iVBORw0KGgoAAAANSUhEUgAA...",  // Base64
          "format": "png",
          "bbox": {"x0": 50, "y0": 100, "x1": 300, "y1": 250}
        }
      ],
      "screenshot": "iVBORw0KGgoAAAANSUhEUgAA..."  // Base64 PNG
    }
  ],
  "metadata": {
    "pageCount": 10,
    "hasOCR": false,
    "totalTables": 3,
    "totalImages": 5,
    "processingTime": 2.5,  // seconds
    "documentType": "pdf"
  },
  "structure": {
    "outline": [
      {"level": 1, "text": "Introduction", "pageNumber": 1},
      {"level": 2, "text": "Background", "pageNumber": 1}
    ],
    "documentType": "report"
  }
}
```

---

### Worker Integration

**File:** `apps/search-ai/src/workers/docling-extraction-worker.ts`

**Process:**

1. **Download Document:**

   ```typescript
   const documentBuffer = await downloadDocument(sourceUrl);
   // sourceUrl can be S3 URL or HTTP URL
   ```

2. **Call Docling Service:**

   ```typescript
   const formData = new FormData();
   formData.append('file', documentBuffer, filename);
   formData.append('extractImages', 'true');
   formData.append('extractTables', 'true');
   formData.append('renderScreenshots', 'true');
   formData.append('ocrEnabled', 'true');

   const response = await axios.post(`${DOCLING_SERVICE_URL}/extract`, formData, {
     headers: formData.getHeaders(),
     timeout: 300_000, // 5 minute timeout
     maxContentLength: 100 * 1024 * 1024, // 100MB max response
   });

   const result: DoclingExtractionResult = response.data;
   ```

3. **Upload Assets to S3:**

   ```typescript
   // Upload images
   for (const page of result.pages) {
     const imageUrls: string[] = [];

     for (const image of page.images) {
       const imageKey = `${tenantId}/${indexId}/${documentId}/page-${page.pageNumber}-img-${idx}.${image.format}`;
       const imageUrl = await uploadBase64ToS3(image.data, imageKey, `image/${image.format}`);
       imageUrls.push(imageUrl);
     }

     // Upload screenshot
     let screenshotUrl: string | null = null;
     if (page.screenshot) {
       const screenshotKey = `${tenantId}/${indexId}/${documentId}/page-${page.pageNumber}-screenshot.png`;
       screenshotUrl = await uploadBase64ToS3(page.screenshot, screenshotKey, 'image/png');
     }
   }
   ```

4. **Create DocumentPage Records:**

   ```typescript
   for (const page of result.pages) {
     await DocumentPage.create({
       tenantId,
       indexId,
       documentId,
       pageNumber: page.pageNumber,
       text: page.text,
       tokenCount: estimateTokens(page.text),
       layout: {
         headings: page.layout.headings,
         structure: page.layout.structure,
       },
       tables: page.tables,
       imageUrls: imageUrls, // S3 URLs
       screenshotUrl: screenshotUrl, // S3 URL
       status: 'pending',
     });
   }
   ```

5. **Enqueue Page Processing:**

   ```typescript
   const pageProcessingQueue = createQueue(QUEUE_PAGE_PROCESSING);

   // Batch pages (10 per job for efficiency)
   for (let i = 0; i < pageIds.length; i += 10) {
     const batch = pageIds.slice(i, i + 10);

     await pageProcessingQueue.add(`process-pages:${documentId}:${i}`, {
       indexId,
       documentId,
       tenantId,
       pageIds: batch,
       previousPageSummary: null, // First batch has no context
     });
   }
   ```

---

### Error Handling

**Timeout Handling:**

```typescript
try {
  const result = await axios.post(url, formData, { timeout: 300_000 });
} catch (error) {
  if (error.code === 'ECONNABORTED') {
    // Timeout after 5 minutes
    throw new Error(`Docling extraction timed out for document ${documentId}`);
  }
  throw error;
}
```

**Retry Logic:**

- **Attempts:** 3
- **Backoff:** Exponential (5s, 25s, 125s)
- **Retryable Errors:** Network errors, 500/502/503 responses
- **Non-Retryable:** 400/413 (bad request, file too large)

**Partial Extraction:**

- If tables fail to extract: Log warning, continue with text
- If images fail: Log warning, continue without images
- If OCR fails: Return empty text with error flag

---

### Performance Characteristics

**Processing Time:**

| Document Type | Pages | Time | Notes                    |
| ------------- | ----- | ---- | ------------------------ |
| PDF (text)    | 10    | 5s   | Fast - no OCR            |
| PDF (scanned) | 10    | 45s  | Slow - OCR required      |
| DOCX          | 20    | 8s   | Fast - structured format |
| Image (PNG)   | 1     | 3s   | OCR on single image      |
| Markdown      | 50    | 2s   | Very fast - plain text   |

**Resource Usage:**

- **CPU:** High during OCR (Tesseract)
- **Memory:** ~500MB per document
- **Disk:** Temporary files (cleaned up after)

**Concurrency:** 2 workers (controlled by BullMQ)

- Low concurrency due to CPU-intensive processing
- Each document takes full CPU core

---

### Configuration

**Environment Variables:**

```bash
# Docling service URL
DOCLING_SERVICE_URL=http://docling-service:8000

# S3 configuration (for image/screenshot uploads)
USE_S3_STORAGE=true
S3_BUCKET=abl-platform-documents
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...

# Worker configuration
DOCLING_EXTRACTION_CONCURRENCY=2
DOCLING_EXTRACTION_TIMEOUT=300000  # 5 minutes
```

**Per-Index Configuration:**

```typescript
// Stored in SearchIndex.config
{
  extraction: {
    enableOCR: boolean; // Default: true
    extractTables: boolean; // Default: true
    extractImages: boolean; // Default: true
    renderScreenshots: boolean; // Default: true
    ocrLanguage: string; // Default: 'auto'
  }
}
```

---

### Output

**Created Records:**

1. **SearchDocument** (updated):
   - status: `EXTRACTING` → `EXTRACTED`
   - pageCount: Total pages extracted
   - metadata: {hasOCR, totalTables, totalImages, processingTime}

2. **DocumentPage** (created):
   - One record per page
   - Contains: text, layout, tables, imageUrls, screenshotUrl
   - Status: `pending` (awaiting page processing)

**Next Stage:**

Jobs enqueued for `page-processing-worker` (batches of 10 pages)

---

## Stage 2: Page Processing & Chunking

**Worker:** `page-processing-worker.ts`

### Decision Tree: Markdown vs PDF

```
┌────────────────────┐
│ Is Markdown?       │
└─────────┬──────────┘
          │
    ┌─────┴─────┐
   YES          NO
    │            │
    ▼            ▼
┌───────────┐  ┌──────────────┐
│ Markdown  │  │ PDF/DOCX     │
│ Chunking  │  │ Page Chunking│
└───────────┘  └──────────────┘
```

### Markdown Chunking

**When:** Document is markdown format

**Strategy:** Section-based chunking

**Steps:**

1. Parse markdown AST (headings, code blocks, lists, tables)
2. Split by sections (H1, H2, H3 boundaries)
3. Keep code blocks intact
4. Keep tables intact
5. Split large sections by paragraph boundaries

**Chunk Structure:**

```typescript
{
  tenantId: string,
  indexId: string,
  documentId: string,
  chunkIndex: number,
  content: string,  // Section text
  metadata: {
    chunkType: 'markdown-section',
    sectionPath: string[],  // ['Introduction', 'Getting Started']
    containsCode: boolean,
    containsTable: boolean,
    containsList: boolean,
    startLine: number,
    endLine: number,
  }
}
```

**Example:**

````markdown
# Getting Started

## Installation

To install, run:

```bash
npm install @agent-platform/search
```
````

## Usage

Import the library:

````

**Chunks Created:**
- Chunk 0: "# Getting Started" (heading)
- Chunk 1: "## Installation\nTo install, run:\n```bash\nnpm install...```" (section with code)
- Chunk 2: "## Usage\nImport the library:" (section)

---

### PDF/DOCX Chunking

**When:** Document is PDF, DOCX, PPTX, or other non-markdown format

**Strategy:** Sentence-aligned page-based chunking

**Steps:**

1. **Load Page Content**
   ```typescript
   const page = await DocumentPage.findById(pageId);
   const text = page.text;
````

2. **Split into Sentences**

   ```typescript
   const sentences = sentenceAligner.splitIntoSentences(text);
   // Uses period, exclamation, question mark boundaries
   // Handles abbreviations (Dr., Mr., etc.)
   ```

3. **Group Sentences into Chunks**
   - Target: 512 tokens per chunk
   - Max: 1024 tokens per chunk
   - Never split mid-sentence
   - Preserve paragraph boundaries when possible

   ```typescript
   const chunks = sentenceAligner.alignIntoChunks(sentences, {
     targetChunkSize: 512,
     maxChunkSize: 1024,
     minChunkSize: 128,
   });
   ```

4. **Create Page Chunk**

   ```typescript
   {
     tenantId,
     indexId,
     documentId,
     chunkIndex: chunkIndex++,
     content: page.text,
     tokenCount: page.tokenCount,
     metadata: {
       pageNumber: page.pageNumber,
       pageId: page._id,
       chunkType: 'page',
       hasImages: page.images.length > 0,
       hasTables: page.tables.length > 0,
       headings: page.layout.headings,
       progressiveSummary: null,  // Added in next stage
     }
   }
   ```

5. **Extract Tables as Separate Chunks**
   ```typescript
   for (const table of page.tables) {
     chunks.push({
       tenantId,
       indexId,
       documentId,
       chunkIndex: chunkIndex++,
       content: table.markdown,
       tokenCount: estimateTokens(table.markdown),
       metadata: {
         pageNumber: page.pageNumber,
         chunkType: 'table',
         tableIndex: tableIdx,
         tableHeaders: table.headers,
         isComplete: table.isComplete,
       },
     });
   }
   ```

**Chunk Structure (Page):**

```typescript
{
  tenantId: string,
  indexId: string,
  documentId: string,
  chunkIndex: number,
  content: string,  // Full page text
  tokenCount: number,
  metadata: {
    pageNumber: number,
    pageId: ObjectId,
    chunkType: 'page',
    hasImages: boolean,
    hasTables: boolean,
    headings: Array<{ level: number, text: string }>,
    progressiveSummary: string | null,
  }
}
```

---

## Stage 3: Progressive Summarization

**When:** After chunks are created, before vision enrichment

**Purpose:** Provide context from previous pages to each chunk

**Strategy:**

1. Start with first page
2. Generate summary of page content using LLM
3. Pass summary to next page as context
4. Each page summary includes previous page context
5. Store summary in chunk metadata

**LLM Prompt:**

```
You are summarizing a page of a document for semantic search context.

Previous Context:
{previousSummary}

Current Page (Page {pageNumber}):
{pageText}

Generate a concise summary (2-3 sentences) that:
1. Captures the main points of THIS page
2. Connects to the previous context if relevant
3. Uses clear, searchable language
```

**Example:**

**Page 1 Summary:**
"This document introduces the Agent Blueprint Language (ABL), a DSL for building AI agents. ABL allows developers to define agent behaviors using a declarative syntax."

**Page 2 Summary (includes P1 context):**
"Building on the ABL introduction, this page explains the core concepts: agents, tools, and flows. Agents are defined with a name, description, and list of available tools."

**Page 3 Summary (includes P1+P2 context):**
"Continuing from the agent and tool definitions, this page details how flows work. Flows are step-by-step execution paths that agents follow to accomplish tasks."

**Stored In:**

```typescript
chunk.metadata.progressiveSummary = 'Building on the ABL introduction...';
```

---

## Stage 4: Vision Enrichment

**When:** Vision is enabled in LLM config (`useCases.vision.enabled = true`)

**Worker:** `visual-enrichment-worker.ts`

**Process:**

1. **Load Page Images**

   ```typescript
   const page = await DocumentPage.findById(pageId);
   const images = page.images; // Array of base64 encoded images
   ```

2. **Analyze Images with Vision LLM**
   - Model: `gpt-4o` or `claude-3.5-sonnet`
   - Input: Image + text summary + previous visual context
   - Output: Image description + visual insights

   **Prompt:**

   ```
   Previous Visual Context:
   {previousVisualContext}

   Text Context:
   {textSummary}

   Analyze the images on this page and provide:
   1. What do the images show?
   2. How do they relate to the text?
   3. What insights do they add?
   ```

3. **Store Visual Analysis**

   ```typescript
   chunk.metadata.visualAnalysis = {
     visualContext: "...",       // Visual summary
     imageDescriptions: [...],   // Per-image descriptions
     visualInsights: "...",      // Insights for search
   };
   ```

4. **Update Chunk for Embedding**
   - Embed: `{text} + {visualInsights}`
   - This allows semantic search to find pages based on visual content

**Example:**

**Text:** "Figure 3 shows the architecture of the system."

**Image:** [Diagram of system architecture]

**Visual Analysis:**

```json
{
  "visualContext": "System architecture diagram showing client, API gateway, and microservices",
  "imageDescriptions": [
    "Architecture diagram with 3 layers: frontend (React), API layer (Node.js), and data layer (PostgreSQL + Redis)"
  ],
  "visualInsights": "The architecture follows a standard 3-tier pattern with clear separation between presentation, logic, and data layers. Notable: uses Redis for caching and session storage."
}
```

**Embedded Content:**

```
Figure 3 shows the architecture of the system. [Visual: System architecture diagram showing client, API gateway, and microservices. The architecture follows a standard 3-tier pattern with clear separation between presentation, logic, and data layers. Notable: uses Redis for caching and session storage.]
```

---

## Stage 5: Question Synthesis

**When:** After vision enrichment (or after chunking if vision disabled)

**Purpose:** Generate questions that this chunk can answer

**Worker:** `question-synthesis-worker.ts`

**Process:**

1. **Generate Questions with LLM**

   ```
   Generate 3-5 questions that this content can answer:

   Content:
   {chunkContent}

   Questions should be:
   - Specific to this content
   - Answerable from the text
   - Use natural language
   - Cover main points
   ```

2. **Store Questions**

   ```typescript
   ChunkQuestion.create({
     tenantId,
     indexId,
     documentId,
     chunkId: chunk._id,
     question: 'What is the Agent Blueprint Language?',
     scope: 'chunk',
     questionType: 'factual',
     confidence: 0.95,
   });
   ```

3. **Use in Retrieval**
   - Questions are embedded alongside chunk content
   - Helps with query-question matching
   - Improves retrieval for question-based queries

---

## Stage 6: Embedding

**Worker:** `embedding-worker.ts`

**Process:**

1. **Prepare Embedding Text**

   ```typescript
   let embeddingText = chunk.content;

   // Add progressive summary for context
   if (chunk.metadata.progressiveSummary) {
     embeddingText = `${chunk.metadata.progressiveSummary}\n\n${embeddingText}`;
   }

   // Add visual insights
   if (chunk.metadata.visualAnalysis?.visualInsights) {
     embeddingText += `\n\n[Visual: ${chunk.metadata.visualAnalysis.visualInsights}]`;
   }
   ```

2. **Generate Embedding**

   ```typescript
   const embedding = await embeddingProvider.embed(embeddingText);
   // OpenAI text-embedding-3-large: 3072 dimensions
   // Cohere embed-english-v3.0: 1024 dimensions
   ```

3. **Store Embedding**
   ```typescript
   await SearchChunk.findByIdAndUpdate(chunk._id, {
     embedding: embedding.vector,
     embeddingModel: embedding.model,
     embeddingDimensions: embedding.dimensions,
   });
   ```

---

## Configuration

### Per-Index LLM Config

```typescript
{
  useCases: {
    vision: {
      enabled: boolean,          // Enable vision enrichment
      model: string,             // 'gpt-4o' | 'claude-3.5-sonnet'
    },
    summarization: {
      enabled: boolean,          // Enable progressive summarization
      model: string,             // 'gpt-4o-mini' | 'claude-haiku'
    },
    questionSynthesis: {
      enabled: boolean,          // Enable question generation
      model: string,             // 'gpt-4o-mini'
    },
  }
}
```

### Chunking Config

```typescript
{
  sentenceAlignment: {
    targetChunkSize: 512,      // Target tokens per chunk
    maxChunkSize: 1024,        // Max tokens per chunk
    minChunkSize: 128,         // Min tokens per chunk
  }
}
```

---

## Examples

### Example 1: Technical Documentation

**Input:** 50-page PDF technical guide

**Processing:**

- Docling extracts 50 pages
- Page processing creates ~75 chunks (1.5 per page avg)
  - 50 page chunks
  - 15 table chunks
  - 10 code block chunks
- Progressive summarization: 49 LLM calls (skip first page)
- Vision enrichment: 20 LLM calls (20 pages with diagrams)
- Question synthesis: 75 LLM calls (1 per chunk)
- Embedding: 75 embeddings

**Cost Estimate:**

- Summarization: $0.05 (gpt-4o-mini)
- Vision: $0.15 (gpt-4o)
- Questions: $0.05 (gpt-4o-mini)
- Embeddings: $0.02 (text-embedding-3-large)
- **Total: ~$0.27**

**Chunks Created:** 75
**Storage:** ~150KB (text) + 900KB (embeddings) = 1.05MB

---

### Example 2: Simple Text Document

**Input:** 5-page contract (text only, no images)

**Processing:**

- Docling extracts 5 pages
- Page processing creates 5 chunks (1 per page)
- Progressive summarization: 4 LLM calls
- No vision enrichment (no images)
- Question synthesis: 5 LLM calls
- Embedding: 5 embeddings

**Cost:** ~$0.03
**Chunks:** 5
**Storage:** ~30KB

---

## Retrieval Considerations

### Best Practices

1. **Use Progressive Summaries**
   - Include in retrieval for context-aware search
   - Helps match queries about "overall document theme"

2. **Leverage Questions**
   - Match user queries against generated questions
   - Improves accuracy for Q&A workloads

3. **Filter by Metadata**
   - `hasImages: true` for visual content
   - `hasTables: true` for structured content
   - `pageNumber` for pagination

4. **Hybrid Search**
   - Combine vector search with keyword search
   - Use BM25 for exact term matching

### Query Examples

**Query:** "How does the authentication flow work?"

**Retrieval:**

1. Vector search on query
2. Rerank by question similarity
3. Return top 5 chunks

**Query:** "Show me diagrams of the system architecture"

**Retrieval:**

1. Vector search on query
2. Filter `hasImages: true`
3. Look for visual context mentioning "architecture", "diagram"
4. Return chunks with high visual relevance

---

## Performance Tuning

### Reduce Costs

- **Disable vision** for text-only documents
- **Disable questions** if not using Q&A features
- **Use smaller models** for summarization (gpt-4o-mini vs gpt-4o)

### Improve Speed

- **Parallel processing** - Process multiple pages concurrently
- **Batch embeddings** - Embed multiple chunks in one API call
- **Skip summarization** - Trade context for speed

### Improve Quality

- **Enable all features** - Vision + summarization + questions
- **Use larger models** - gpt-4o for vision vs gpt-4o-mini
- **Increase context** - Include more previous page summaries

---

## Troubleshooting

### Issue: Chunks too large (>1024 tokens)

**Solution:** Reduce `maxChunkSize` in config

### Issue: Sentences split incorrectly

**Solution:** Update sentence boundary detection in `sentence-aligner.ts`

### Issue: Tables not extracted

**Solution:** Check Docling config `useTables: true`

### Issue: Vision enrichment slow

**Solution:** Reduce image resolution or disable vision

### Issue: Missing context between pages

**Solution:** Enable progressive summarization

---

## Related Documentation

- [Architecture Overview](./10-architecture-overview.md)
- [Tenant Isolation](./11-security-tenant-isolation.md)
- [Retrieval Checklist](./20-retrieval-checklist.md)

---

**Next:** [CSV Tables Guide](./02-structured-csv.md) →
