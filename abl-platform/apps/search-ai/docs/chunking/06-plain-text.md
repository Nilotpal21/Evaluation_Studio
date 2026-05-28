# Plain Text File Chunking (.txt)

**Applies To:** Plain text files (.txt)
**Strategy:** Sentence-aligned chunking with optional progressive summarization
**Worker:** `extraction-worker.ts` → `page-processing-worker.ts`
**MIME Type:** `text/plain`

---

## Overview

Plain text files are handled via a **legacy extraction path** that provides simple, reliable text extraction without layout analysis overhead. Text is extracted as a single page, then chunked using sentence-aligned boundaries for optimal retrieval.

**Key Features:**

- Simple, fast extraction (no OCR or layout parsing)
- Sentence-aligned chunking (never splits mid-sentence)
- Support for large files (up to 100MB)
- UTF-8 encoding support
- Progressive summarization (optional)
- Question generation (optional)

---

## When to Use Plain Text Format

### ✅ Best For

| Use Case           | Why Plain Text                         |
| ------------------ | -------------------------------------- |
| **Code files**     | Source code, configuration files, logs |
| **Documentation**  | README, changelog, license files       |
| **Data files**     | Large text dumps, exports, raw data    |
| **Legacy content** | Plain text notes, meeting minutes      |
| **Email exports**  | .txt email backups                     |
| **Log files**      | Application logs, system logs          |

### ⚠️ Consider Other Formats If

| Scenario            | Better Format                                          |
| ------------------- | ------------------------------------------------------ |
| **Rich formatting** | Use Markdown (.md) for headers, lists, code blocks     |
| **Tables**          | Use CSV for tabular data                               |
| **Office docs**     | Use native formats (DOCX, PDF) for layout preservation |
| **Mixed content**   | Use HTML for complex structure                         |

---

## Pipeline Stages

```
┌─────────────────┐
│ 1. Upload       │ → User uploads .txt file (text/plain MIME type)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Extraction   │ → extraction-worker.ts reads raw text
└────────┬────────┘   - No OCR needed
         │             - No layout parsing
         ▼             - Entire file as single "page"
┌─────────────────┐
│ 3. Chunking     │ → page-processing-worker.ts chunks text
└────────┬────────┘   - Sentence-aligned boundaries
         │             - Target: 512 tokens per chunk
         ▼             - Max: 1024 tokens per chunk
┌─────────────────┐
│ 4. Progressive  │ → Optional: Generate summaries
│    Summarization│    (if enabled in LLM config)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Question     │ → Optional: Generate questions
│    Synthesis    │    (if enabled in LLM config)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 6. Embedding    │ → Generate vector embeddings
└─────────────────┘
```

---

## Stage 1: Extraction

**Worker:** `extraction-worker.ts`

### Process

1. **Load Document**

   ```typescript
   const document = await SearchDocument.findOne({
     _id: documentId,
     indexId,
     tenantId,
   });
   ```

2. **Extract Text**

   ```typescript
   // Read raw text from uploaded file
   let extractedText = document.extractedText;

   // Fallback: read from sourceMetadata if not already extracted
   if (!extractedText && document.sourceMetadata) {
     if (typeof document.sourceMetadata === 'string') {
       extractedText = document.sourceMetadata;
     } else if (typeof document.sourceMetadata === 'object') {
       extractedText = Object.values(document.sourceMetadata)
         .filter((v): v is string => typeof v === 'string')
         .join('\n\n');
     }
   }
   ```

3. **Validate Content**

   ```typescript
   if (!extractedText || extractedText.trim().length === 0) {
     throw new Error('No extractable content found');
   }
   ```

4. **Update Document Status**
   ```typescript
   await SearchDocument.findByIdAndUpdate(documentId, {
     extractedText,
     contentSizeBytes: Buffer.byteLength(extractedText, 'utf-8'),
     status: DocumentStatus.EXTRACTED,
   });
   ```

**Output:**

- Document status: `EXTRACTED`
- Extracted text stored in `SearchDocument.extractedText`
- Content size calculated

---

## Stage 2: Chunking

**Worker:** `page-processing-worker.ts`

### Chunking Strategy

Plain text uses **sentence-aligned chunking** to preserve semantic boundaries:

```typescript
const chunks = sentenceAligner.alignIntoChunks(sentences, {
  targetChunkSize: 512, // Target tokens per chunk
  maxChunkSize: 1024, // Maximum tokens per chunk
  minChunkSize: 128, // Minimum tokens per chunk
});
```

### Sentence Boundary Detection

**Rules:**

- Split on: `.` `!` `?` followed by whitespace
- Preserve: Abbreviations (Dr., Mr., etc.)
- Preserve: Numbers (3.14, $1.50, etc.)
- Preserve: URLs (example.com)
- Handle: Multiple sentences per chunk (if under token limit)

**Example:**

Input text:

```
Dr. Smith published a study in 2024. The results were significant.
He found that the correlation was 0.95. This is remarkable.
```

Chunks created (assuming 512 token target):

```
Chunk 0: "Dr. Smith published a study in 2024. The results were significant."
Chunk 1: "He found that the correlation was 0.95. This is remarkable."
```

### Chunk Structure

```typescript
{
  tenantId: string,
  indexId: string,
  documentId: string,
  chunkIndex: number,
  content: string,  // Chunk text
  tokenCount: number,  // Estimated tokens (length / 4)
  metadata: {
    chunkType: 'page',
    pageNumber: 1,  // Always 1 for plain text (single page)
    hasImages: false,  // Plain text has no images
    hasTables: false,  // Plain text has no tables
    progressiveSummary: string | null,  // If enabled
  },
  status: ChunkStatus.PENDING
}
```

---

## Stage 3: Progressive Summarization (Optional)

**Service:** `ProgressiveSummarizationService`
**Cost:** ~$0.0002/chunk (using Claude Haiku)

If enabled, each chunk gets a summary with context from previous chunks:

```typescript
// First chunk
const summary1 = await summarizeChunk(chunk1Text, null);
// "This text introduces the ATLAS platform..."

// Second chunk (with context from first)
const summary2 = await summarizeChunk(chunk2Text, summary1);
// "Building on the platform introduction, this section explains architecture..."
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

## Stage 4: Question Synthesis (Optional)

**Service:** `QuestionSynthesisService`
**Cost:** ~$0.00017/chunk (using Gemini Flash)

If enabled, generates 3-5 answerable questions per chunk:

```typescript
const questions = await generateQuestions(chunkText, {
  documentTitle: 'README.md',
  documentType: 'documentation',
});

// Generated questions:
[
  { question: 'What is the ATLAS platform?', type: 'factual', confidence: 0.95 },
  { question: 'How do I install ATLAS?', type: 'procedural', confidence: 0.92 },
  { question: 'What are the key features?', type: 'conceptual', confidence: 0.88 },
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

## Configuration

### File Upload Limits

```typescript
// From document-upload.ts
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  },
});
```

### Chunking Configuration

```typescript
{
  sentenceAlignment: {
    targetChunkSize: 512,  // Target tokens per chunk
    maxChunkSize: 1024,    // Max tokens per chunk
    minChunkSize: 128      // Min tokens per chunk (avoid tiny chunks)
  }
}
```

### Encoding

- **Supported:** UTF-8 (default)
- **Unsupported:** UTF-16, Latin-1 (convert before upload)

---

## Examples

### Example 1: Small README (5KB)

**Input:** `README.txt` (5KB, ~1,250 tokens)

**Processing:**

- Extraction: <1s
- Chunking: Creates 3 chunks (400-500 tokens each)
- Progressive summarization: Off
- Question synthesis: Off
- Embedding: 3 embeddings

**Cost:**

- Extraction: $0 (no LLM)
- Embedding: $0.0001 (text-embedding-3-large)
- **Total: ~$0.0001**

**Chunks Created:** 3
**Storage:** ~5KB (text) + 36KB (embeddings 3 × 12KB) = 41KB

---

### Example 2: Large Log File (10MB)

**Input:** `application.log` (10MB, ~2.5M tokens)

**Processing:**

- Extraction: ~2s
- Chunking: Creates ~5,000 chunks (500 tokens avg)
- Progressive summarization: Off (too expensive for logs)
- Question synthesis: Off
- Embedding: 5,000 embeddings

**Cost:**

- Extraction: $0
- Embedding: $0.20 (5K embeddings × $0.00004)
- **Total: ~$0.20**

**Chunks Created:** 5,000
**Storage:** ~10MB (text) + 60MB (embeddings) = 70MB

**Performance:** ~5 minutes total processing time

---

### Example 3: Documentation with All Features Enabled (50KB)

**Input:** `GUIDE.txt` (50KB, ~12,500 tokens)

**Processing:**

- Extraction: <1s
- Chunking: Creates 25 chunks (500 tokens avg)
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

## Best Practices

### 1. Preprocessing

**Before uploading large text files:**

```bash
# Remove excessive whitespace
sed 's/[[:space:]]\+/ /g' input.txt > clean.txt

# Remove empty lines
grep -v '^$' input.txt > clean.txt

# Convert to UTF-8
iconv -f ISO-8859-1 -t UTF-8 input.txt > clean.txt
```

### 2. File Size Optimization

| File Size       | Recommendation                                      |
| --------------- | --------------------------------------------------- |
| **<100KB**      | Upload as-is                                        |
| **100KB - 1MB** | Disable progressive summarization (cost)            |
| **1MB - 10MB**  | Disable summarization + question synthesis          |
| **>10MB**       | Split into smaller files or use streaming ingestion |

### 3. Encoding Issues

**Problem:** File displays garbled text after upload

**Solution:** Convert to UTF-8 before upload:

```bash
file input.txt  # Check encoding
iconv -f WINDOWS-1252 -t UTF-8 input.txt > output.txt
```

### 4. Large Files

**Problem:** 10MB log file takes too long to process

**Solution:**

- Split into smaller files (e.g., daily logs)
- Disable optional features (summarization, questions)
- Use batch upload API

---

## Troubleshooting

### Issue: Empty Chunks After Upload

**Symptoms:**

- File uploaded successfully
- Document status: `EXTRACTED`
- No chunks created

**Diagnosis:**

```typescript
const doc = await SearchDocument.findById(documentId);
console.log('Extracted text length:', doc.extractedText?.length);
console.log('Content:', doc.extractedText?.slice(0, 100));
```

**Common Causes:**

1. **Binary file uploaded as text** → Check MIME type
2. **Empty file** → Verify file content
3. **Encoding issue** → Convert to UTF-8

**Solution:**

```bash
# Verify file is plain text
file input.txt  # Should show "ASCII text" or "UTF-8 Unicode text"

# Check for hidden characters
hexdump -C input.txt | head
```

---

### Issue: Chunks Too Large

**Symptoms:**

- Chunks exceed 1024 tokens
- Embedding generation fails

**Diagnosis:**

```typescript
const chunks = await SearchChunk.find({ documentId });
const oversized = chunks.filter((c) => c.tokenCount > 1024);
console.log(`Oversized chunks: ${oversized.length}`);
```

**Solution:**

- Reduce `maxChunkSize` in config
- Ensure sentence boundary detection is working
- Check for very long sentences (>1000 tokens)

---

### Issue: Processing Takes Too Long

**Symptoms:**

- Small file (50KB) takes >5 minutes to process

**Diagnosis:**

```bash
# Check worker queue
npx bull-board --redis redis://localhost:6379
# Look for stuck jobs in QUEUE_PAGE_PROCESSING
```

**Common Causes:**

1. **Progressive summarization enabled** → LLM calls add latency
2. **Question synthesis enabled** → More LLM calls
3. **Worker concurrency too low** → Increase concurrency

**Solution:**

```bash
# Disable optional features for faster processing
{
  "useCases": {
    "progressiveSummarization": { "enabled": false },
    "questionSynthesis": { "enabled": false }
  }
}
```

---

## Performance Characteristics

### Processing Time

| File Size | Chunks | Extraction | Chunking | Summarization (opt) | Total |
| --------- | ------ | ---------- | -------- | ------------------- | ----- |
| **5KB**   | 3      | <1s        | <1s      | +2s                 | ~2s   |
| **50KB**  | 25     | <1s        | ~1s      | +15s                | ~16s  |
| **500KB** | 250    | ~1s        | ~3s      | +150s               | ~154s |
| **5MB**   | 2,500  | ~2s        | ~10s     | N/A (disabled)      | ~12s  |

### Cost (per file)

| Feature                  | Cost per Chunk | 25-Chunk File | 250-Chunk File |
| ------------------------ | -------------- | ------------- | -------------- |
| **Extraction**           | $0             | $0            | $0             |
| **Embedding**            | $0.00004       | $0.001        | $0.01          |
| **Summarization**        | $0.0002        | $0.005        | $0.05          |
| **Questions**            | $0.00017       | $0.004        | $0.04          |
| **Total (all features)** | $0.00061       | $0.01         | $0.10          |

---

## Related Documentation

- [Document Chunking (PDF, DOCX)](./01-documents-pdf-docx.md) - For rich documents
- [HTML/Markdown](./07-html-markdown.md) - For structured markup
- [Architecture Overview](./10-architecture-overview.md) - Full system architecture
- [Worker Pipeline](./14-worker-pipeline-detailed.md) - Complete pipeline details
- [Progressive Summarization](../advanced/50-PROGRESSIVE-SUMMARIZATION.md) - Summarization guide
- [Question Synthesis](../advanced/51-QUESTION-SYNTHESIS.md) - Question generation guide

---

## Key Takeaways

**1. Plain Text is Fast and Simple**

- No OCR, no layout parsing
- Fastest extraction path
- Lowest cost (if optional features disabled)

**2. Sentence-Aligned Chunking Preserves Meaning**

- Never splits mid-sentence
- Target 512 tokens (ideal for embeddings)
- Max 1024 tokens (balance size vs. context)

**3. Optional Features Add Value at Cost**

- Progressive summarization: +$0.0002/chunk, better context
- Question synthesis: +$0.00017/chunk, better Q&A retrieval
- Disable for logs, enable for documentation

**4. Large Files Need Optimization**

- Split >10MB files into smaller pieces
- Disable optional features for logs
- Preprocess to remove noise

**5. UTF-8 Encoding is Critical**

- Always convert to UTF-8 before upload
- Check encoding with `file` command
- Use `iconv` for conversion

---

**Next:** [HTML & Markdown Guide](./07-html-markdown.md) →
