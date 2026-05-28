# HTML & Markdown File Chunking

**Applies To:** HTML files (.html, .htm), Markdown files (.md)
**Strategy:** Structure-aware chunking with heading hierarchy preservation
**Worker:** `docling-extraction-worker.ts` (HTML) → `page-processing-worker.ts` (Markdown chunking)
**MIME Types:** `text/html`, `text/markdown`

---

## Overview

HTML and Markdown files receive special structure-aware processing that preserves document hierarchy and formatting. Unlike plain text, these formats have explicit structure (headings, code blocks, tables, lists) that must be preserved during chunking to maintain semantic coherence.

**Key Features:**

- **HTML**: Layout extraction via Docling, DOM-based parsing
- **Markdown**: AST-based parsing with unified/remark, heading hierarchy preservation
- **Structure preservation**: Code blocks, tables, lists kept intact
- **Section-aware chunking**: Never splits mid-section, respects heading boundaries
- **Metadata enrichment**: Section paths, content type flags (code, tables, lists)
- **Progressive summarization**: Optional LLM-based context enrichment
- **Question synthesis**: Optional FAQ generation per chunk

---

## When to Use HTML/Markdown

### ✅ Best For

| Use Case              | Why HTML/Markdown                          |
| --------------------- | ------------------------------------------ |
| **Documentation**     | README.md, Wiki pages, API docs            |
| **Technical content** | Code examples, tutorials, guides           |
| **Blogs & articles**  | Content with headings, lists, emphasis     |
| **Web pages**         | Static sites, landing pages, content pages |
| **Knowledge bases**   | Support articles, FAQs, how-to guides      |
| **GitHub content**    | Issues, PRs, markdown files in repos       |

### ⚠️ Consider Other Formats If

| Scenario            | Better Format                     |
| ------------------- | --------------------------------- |
| **Rich formatting** | Use PDF/DOCX for complex layouts  |
| **Tables**          | Use CSV/Excel for tabular data    |
| **Plain notes**     | Use TXT for unformatted text      |
| **Mixed media**     | Use PDF for documents with images |

---

## Processing Paths

### HTML Processing (Docling Path)

```
┌─────────────────┐
│ 1. Upload       │ → User uploads .html file (text/html MIME type)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Docling      │ → docling-extraction-worker.ts
│    Extraction   │   - DOM parsing
└────────┬────────┘   - Layout extraction
         │             - Element hierarchy
         ▼
┌─────────────────┐
│ 3. Page         │ → Text extracted as single page
│    Creation     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Chunking     │ → page-processing-worker.ts
│                 │   - Sentence-aligned (default for HTML)
└────────┬────────┘   - Target: 512 tokens
         │             - Max: 1024 tokens
         ▼
┌─────────────────┐
│ 5. Enrichment   │ → Optional: Summarization + Questions
└─────────────────┘
```

### Markdown Processing (Structure-Aware Path)

```
┌─────────────────┐
│ 1. Upload       │ → User uploads .md file (text/markdown MIME type)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Docling      │ → docling-extraction-worker.ts
│    Extraction   │   - Reads markdown as text
└────────┬────────┘   - Preserves formatting
         │
         ▼
┌─────────────────┐
│ 3. Page         │ → Full markdown stored as single page
│    Creation     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Markdown     │ → markdown-chunker.ts (unified/remark)
│    Chunking     │   - Parse markdown to AST
└────────┬────────┘   - Build heading hierarchy
         │             - Split at H1/H2 boundaries
         │             - Preserve code blocks, tables, lists
         ▼
┌─────────────────┐
│ 5. Chunk        │ → Create SearchChunk documents
│    Creation     │   - Section path metadata
└────────┬────────┘   - Content type flags
         │
         ▼
┌─────────────────┐
│ 6. Enrichment   │ → Optional: Summarization + Questions
└─────────────────┘
```

---

## Markdown Chunking Strategy

### Heading-Level Splits

Markdown documents are split at configurable heading levels (default: H1, H2):

```markdown
# Introduction ← H1: New chunk starts here

This is intro text.

## Prerequisites ← H2: New chunk starts here

You need Node.js.

### Installation ← H3: Part of "Prerequisites" chunk (not a split point)

Run `npm install`.

## Usage ← H2: New chunk starts here

Import the module.
```

**Chunks created (default config):**

1. **Chunk 0**: "# Introduction\n\nThis is intro text."
2. **Chunk 1**: "## Prerequisites\n\nYou need Node.js.\n\n### Installation\n\nRun `npm install`."
3. **Chunk 2**: "## Usage\n\nImport the module."

### Structure Preservation

**Code blocks** remain intact:

````markdown
## Example

Here's a function:

```typescript
function greet(name: string) {
  return `Hello, ${name}!`;
}
```
````

More text here.

````

**Result**: Entire section (text + code block + text) kept together in one chunk.

**Tables** remain intact:

```markdown
## Comparison

| Feature | Status |
|---------|--------|
| Auth    | ✅     |
| Search  | 🚧     |

Analysis below.
````

**Result**: Table + surrounding text in one chunk.

**Lists** remain intact:

```markdown
## Steps

1. Clone repo
2. Install deps
3. Run server

That's it.
```

**Result**: Full list + surrounding text in one chunk.

### Token Limits

Even with structure preservation, chunks are capped at `maxChunkSize` (default: 1024 tokens):

- If a section exceeds the limit, it's split at paragraph boundaries within that section
- Code blocks >1024 tokens are split (rare, but handled)
- Tables >1024 tokens are split at row boundaries

### Chunk Metadata

Each markdown chunk includes structural metadata:

```typescript
{
  content: "## Prerequisites\n\nYou need Node.js...",
  metadata: {
    chunkType: 'page',
    pageNumber: 1,
    sectionPath: ['Introduction', 'Prerequisites'],  // Heading hierarchy
    containsCode: true,       // Has code blocks
    containsTable: false,     // Has tables
    containsList: true,       // Has lists
    startLine: 15,            // Source line number
    endLine: 42,
    chunkIndex: 1
  }
}
```

**Use in retrieval:**

- `sectionPath` enables hierarchical search ("find in Prerequisites section")
- `containsCode` prioritizes code-heavy chunks for technical queries
- `containsTable` identifies data-focused sections

---

## HTML Chunking Strategy

HTML documents are processed by Docling for layout extraction, then chunked using **sentence-aligned strategy** (same as plain text):

### Extraction Phase

Docling extracts:

- **Text content**: Stripped of HTML tags
- **Headings**: Identified by `<h1>` through `<h6>` tags
- **Structure**: Paragraph boundaries, list items, table cells
- **Semantic elements**: `<article>`, `<section>`, `<nav>`, `<aside>`

### Chunking Phase

After extraction, HTML text is chunked via sentence alignment:

```typescript
const chunks = sentenceAligner.alignIntoChunks(sentences, {
  targetChunkSize: 512, // Target tokens per chunk
  maxChunkSize: 1024, // Maximum tokens per chunk
  minChunkSize: 128, // Minimum tokens per chunk
});
```

**Sentence boundary detection:**

- Split on: `.` `!` `?` followed by whitespace
- Preserve: Abbreviations (Dr., Mr., Inc.)
- Preserve: Numbers (3.14, $1.50)
- Preserve: URLs (example.com/page.html)

**Example HTML:**

```html
<h1>Product Overview</h1>
<p>Our product is the best. It has many features.</p>
<p>Customers love it. Try it today!</p>

<h2>Features</h2>
<ul>
  <li>Fast performance</li>
  <li>Easy to use</li>
</ul>
```

**Extracted text:**

```
Product Overview

Our product is the best. It has many features.

Customers love it. Try it today!

Features

- Fast performance
- Easy to use
```

**Chunks created (assuming 512 token target):**

1. **Chunk 0**: "Product Overview\n\nOur product is the best. It has many features.\n\nCustomers love it. Try it today!"
2. **Chunk 1**: "Features\n\n- Fast performance\n- Easy to use"

---

## Configuration

### Markdown Chunking Options

```typescript
// In page-processing-worker.ts
const markdownChunks = chunkMarkdown(fullMarkdown, {
  maxChunkSize: 1024, // Max tokens per chunk
  headingLevels: [1, 2], // Split at H1 and H2 (not H3+)
  preserveCodeBlocks: true, // Keep code blocks intact
  preserveTables: true, // Keep tables intact
  preserveLists: true, // Keep lists intact
});
```

**Heading levels explained:**

- `[1, 2]`: Split at H1 and H2, keep H3+ within parent chunk
- `[1]`: Split only at H1, H2+ within parent chunk (larger chunks)
- `[1, 2, 3]`: Split at H1, H2, H3 (smaller, more granular chunks)

**Trade-offs:**

| Setting     | Chunk Size | Context                | Use Case                  |
| ----------- | ---------- | ---------------------- | ------------------------- |
| `[1]`       | Large      | More context per chunk | Long-form articles, books |
| `[1, 2]`    | Medium     | Balanced               | Documentation (default)   |
| `[1, 2, 3]` | Small      | Fine-grained           | FAQs, API references      |

### HTML Extraction Options

HTML extraction is handled by Docling with default settings:

- **Layout analysis**: Enabled (identifies document structure)
- **Table extraction**: Enabled (preserves table structure)
- **Image extraction**: Enabled (extracts alt text, captions)
- **Link preservation**: URLs extracted as text references

---

## Progressive Summarization (Optional)

**Service:** `ProgressiveSummarizationService`
**Cost:** ~$0.0002/chunk (using Claude Haiku)

If enabled, each chunk gets a context-aware summary:

```typescript
// First chunk (no prior context)
const summary1 = await summarizeChunk(chunk1Text, null);
// "This markdown introduces the ATLAS platform architecture..."

// Second chunk (with context from first)
const summary2 = await summarizeChunk(chunk2Text, summary1);
// "Building on the architecture intro, this section details installation..."
```

**Enable via LLM Config:**

```typescript
{
  useCases: {
    progressiveSummarization: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 300,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 500
    }
  }
}
```

**Stored in:**

```typescript
chunk.metadata.progressiveSummary = 'This section discusses...';
```

---

## Question Synthesis (Optional)

**Service:** `QuestionSynthesisService`
**Cost:** ~$0.00017/chunk (using Gemini Flash)

If enabled, generates 3-5 answerable questions per chunk:

```typescript
const questions = await generateQuestions(chunkText, {
  documentTitle: 'Installation Guide.md',
  documentType: 'documentation',
});

// Generated questions:
[
  { question: 'What are the prerequisites for ATLAS?', type: 'factual', confidence: 0.95 },
  { question: 'How do I install ATLAS?', type: 'procedural', confidence: 0.92 },
  { question: 'What Node.js version is required?', type: 'factual', confidence: 0.9 },
];
```

**Enable via LLM Config:**

```typescript
{
  useCases: {
    questionSynthesis: {
      enabled: true,
      provider: 'google',
      model: 'gemini-1.5-flash',
      questionsPerChunk: 3,
      maxTokens: 150,
      enableEmbedding: true
    }
  }
}
```

**Stored in:**

- `ChunkQuestion` collection (MongoDB)
- Linked to chunk via `chunkId`

---

## Examples

### Example 1: GitHub README.md (10KB)

**Input:** `README.md` (10KB, ~2,500 tokens)

**Structure:**

```markdown
# Project Name

## Installation

### Prerequisites

### Steps

## Usage

### Basic Example

### Advanced Example

## API Reference

### Methods

### Types

## Contributing
```

**Processing:**

- Extraction: <1s
- Markdown chunking: Creates 6 chunks (H2 splits)
  - Chunk 0: "# Project Name" (intro)
  - Chunk 1: "## Installation" (includes H3 Prerequisites + Steps)
  - Chunk 2: "## Usage" (includes both H3 examples)
  - Chunk 3: "## API Reference" (includes Methods + Types)
  - Chunk 4: "## Contributing"
- Progressive summarization: Off
- Question synthesis: Off
- Embedding: 6 embeddings

**Cost:**

- Extraction: $0
- Embedding: $0.0002 (6 embeddings × $0.00004)
- **Total: ~$0.0002**

**Chunks Created:** 6
**Storage:** ~10KB (text) + 72KB (embeddings 6 × 12KB) = 82KB

---

### Example 2: Technical Documentation (50KB) with All Features

**Input:** `ARCHITECTURE.md` (50KB, ~12,500 tokens)

**Structure:**

```markdown
# Architecture Overview

## Core Components

### Frontend

### Backend

### Database

## Security

### Authentication

### Authorization

## Deployment

### Docker

### Kubernetes
```

**Processing:**

- Extraction: <1s
- Markdown chunking: Creates 25 chunks (H2 + H3 splits, config: `[1, 2, 3]`)
- Progressive summarization: Enabled (~$0.005)
- Question synthesis: Enabled (~$0.004)
- Embedding: 25 embeddings (~$0.001)

**Cost:**

- Extraction: $0
- Summarization: $0.005 (25 chunks × $0.0002)
- Questions: $0.004 (25 chunks × $0.00017)
- Embedding: $0.001
- **Total: ~$0.01**

**Chunks Created:** 25
**Questions Generated:** 75 (3 per chunk)
**Storage:** ~50KB (text) + 300KB (embeddings) = 350KB

---

### Example 3: HTML Landing Page (5KB)

**Input:** `index.html` (5KB, ~1,250 tokens)

**Processing:**

- Extraction via Docling: ~2s (layout analysis)
- Sentence-aligned chunking: Creates 3 chunks (400-500 tokens each)
- Progressive summarization: Off
- Question synthesis: Off
- Embedding: 3 embeddings

**Cost:**

- Extraction: $0
- Embedding: $0.0001 (3 embeddings × $0.00004)
- **Total: ~$0.0001**

**Chunks Created:** 3
**Storage:** ~5KB (text) + 36KB (embeddings) = 41KB

---

## Best Practices

### 1. Choose Heading Levels Wisely

**For documentation with clear sections:**

```typescript
headingLevels: [1, 2]; // Default — balanced chunk size
```

**For API references (fine-grained access):**

```typescript
headingLevels: [1, 2, 3]; // Smaller chunks, more granular
```

**For books/long-form (preserve context):**

```typescript
headingLevels: [1]; // Larger chunks, more context per chunk
```

### 2. Clean Markdown Before Upload

**Remove excessive blank lines:**

```bash
# Consolidate multiple blank lines to single
sed '/^$/N;/^\n$/D' input.md > clean.md
```

**Fix broken headings:**

```markdown
# Correct (space after #)

# My Heading

#Incorrect (no space)
#My Heading
```

**Use proper code fence syntax:**

````markdown
# Correct (language specified)

```typescript
const x = 1;
```
````

# Incorrect (no language)

```
const x = 1;
```

````

### 3. Optimize for Search

**Use descriptive headings:**
```markdown
# ✅ Good: "Authentication Flow with JWT"
# ❌ Bad: "Section 1"
````

**Include keywords in first paragraph:**

```markdown
## API Endpoints

The ATLAS platform exposes REST API endpoints for document upload,
search queries, and knowledge base management.
```

### 4. Code Block Handling

**Keep code examples concise:**

- Max ~50 lines per code block (stays within 1024 token limit)
- Split long examples across multiple sections

**Add context around code:**

````markdown
## Example

This function authenticates users:

```typescript
function authenticate(token: string) { ... }
```
````

Call it during login.

````

### 5. Table Optimization

**Keep tables under 1024 tokens:**
- Max ~20 rows with 5 columns
- Split large tables into multiple sections

**Use markdown tables (not HTML):**
```markdown
# ✅ Good: Markdown table
| Feature | Status |
|---------|--------|
| Auth    | ✅     |

# ❌ Avoid: HTML tables in markdown
<table>...</table>
````

---

## Troubleshooting

### Issue: Chunks Split Mid-Code Block

**Symptoms:**

- Code blocks appear incomplete in search results
- Syntax highlighting broken

**Diagnosis:**

````typescript
const chunks = await SearchChunk.find({ documentId });
chunks.forEach((c, i) => {
  console.log(`Chunk ${i}:`, c.content.includes('```'));
});
````

**Common Causes:**

1. **Code block >1024 tokens** → Exceeds max chunk size
2. **Malformed code fence** → Missing closing ``` delimiter
3. **Markdown parser failure** → Check for syntax errors

**Solution:**

- Split long code examples into smaller functions
- Verify code fences are properly closed
- Test markdown syntax: `npx remark --use remark-gfm input.md`

---

### Issue: Heading Hierarchy Lost

**Symptoms:**

- Section path metadata is flat: `['Section Name']` instead of `['Chapter', 'Section', 'Subsection']`

**Diagnosis:**

```typescript
const chunks = await SearchChunk.find({ documentId });
chunks.forEach((c, i) => {
  console.log(`Chunk ${i} path:`, c.metadata.sectionPath);
});
```

**Common Causes:**

1. **Inconsistent heading levels** → Skips from H1 to H3 (no H2)
2. **Heading config mismatch** → `headingLevels: [1]` but doc uses H2+
3. **Non-standard heading syntax** → `### Heading` followed by `#Heading`

**Solution:**

- Use sequential heading levels (H1 → H2 → H3, don't skip)
- Adjust `headingLevels` config to match document structure
- Fix markdown syntax: ensure space after `#`

---

### Issue: HTML Extraction Missing Content

**Symptoms:**

- Text missing after upload
- Images/tables not extracted

**Diagnosis:**

```bash
# Check Docling worker logs
grep "document-id-here" logs/docling-extraction-worker.log
```

**Common Causes:**

1. **JavaScript-rendered content** → Docling extracts server-side HTML only
2. **Embedded iframes** → Content in iframes not extracted
3. **CSS display:none** → Hidden content skipped

**Solution:**

- Export JavaScript-heavy pages to PDF before upload
- Extract iframe content separately
- Remove `display:none` from content that should be indexed

---

### Issue: Large Markdown Files Timeout

**Symptoms:**

- Files >10MB fail during chunking
- Worker timeout errors in logs

**Diagnosis:**

```bash
# Check file size
ls -lh input.md

# Check worker timeout
grep "timeout" logs/page-processing-worker.log
```

**Solution:**

- Split large files into separate documents (e.g., one chapter per file)
- Increase worker timeout (default: 5 minutes)
- Disable progressive summarization for large files (speeds up processing)

---

## Performance Characteristics

### Processing Time

| File Size | Format   | Chunks | Extraction    | Chunking | Summarization (opt) | Total |
| --------- | -------- | ------ | ------------- | -------- | ------------------- | ----- |
| **5KB**   | Markdown | 3      | <1s           | <1s      | +2s                 | ~2s   |
| **10KB**  | Markdown | 6      | <1s           | <1s      | +4s                 | ~5s   |
| **50KB**  | Markdown | 25     | <1s           | ~1s      | +15s                | ~16s  |
| **5KB**   | HTML     | 3      | ~2s (Docling) | <1s      | +2s                 | ~4s   |
| **50KB**  | HTML     | 25     | ~5s (Docling) | ~1s      | +15s                | ~21s  |

### Cost (per file)

| Feature                  | Cost per Chunk | 6-Chunk File | 25-Chunk File |
| ------------------------ | -------------- | ------------ | ------------- |
| **Extraction**           | $0             | $0           | $0            |
| **Embedding**            | $0.00004       | $0.0002      | $0.001        |
| **Summarization**        | $0.0002        | $0.0012      | $0.005        |
| **Questions**            | $0.00017       | $0.001       | $0.004        |
| **Total (all features)** | $0.00061       | $0.0024      | $0.01         |

---

## Related Documentation

- [Document Chunking (PDF, DOCX)](./01-documents-pdf-docx.md) - For rich documents
- [Plain Text Files](./06-plain-text.md) - For .txt files
- [Architecture Overview](./10-architecture-overview.md) - Full system architecture
- [Worker Pipeline](./14-worker-pipeline-detailed.md) - Complete pipeline details
- [Progressive Summarization](../advanced/50-PROGRESSIVE-SUMMARIZATION.md) - Summarization guide
- [Question Synthesis](../advanced/51-QUESTION-SYNTHESIS.md) - Question generation guide

---

## Key Takeaways

**1. Structure-Aware Chunking Preserves Meaning**

- Markdown: Split at heading boundaries, preserve hierarchy
- HTML: Layout extraction via Docling, sentence-aligned chunking
- Code blocks, tables, lists kept intact

**2. Markdown Gets Special Treatment**

- AST-based parsing (unified/remark)
- Heading hierarchy tracked in metadata
- Configurable split levels (H1, H2, H3)

**3. HTML Relies on Docling**

- DOM parsing extracts text content
- Layout analysis identifies structure
- Sentence-aligned chunking after extraction

**4. Optional Features Add Value at Cost**

- Progressive summarization: +$0.0002/chunk, better context
- Question synthesis: +$0.00017/chunk, better Q&A retrieval
- Enable for documentation, disable for large files

**5. Configuration Matters**

- Choose heading levels based on document type
- Adjust `maxChunkSize` for code-heavy docs
- Clean markdown syntax before upload

---

**Next:** [Images & OCR Guide](./08-images-ocr.md) →
