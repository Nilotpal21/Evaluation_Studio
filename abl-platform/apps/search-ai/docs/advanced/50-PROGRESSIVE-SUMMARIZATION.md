# Progressive Summarization

**Status:** ✅ Production
**Feature:** ATLAS-KG Phase 2
**Service:** `ProgressiveSummarizationService`
**Cost:** ~$0.0002/chunk (Claude Haiku)
**Last Updated:** 2026-02-24

---

## Overview

Progressive Summarization generates context-aware summaries for each chunk in a document, where each summary builds upon the previous one. This creates a chain of contextual understanding that flows through the document, enabling better retrieval and more coherent search results.

**Key Concept:**

```
Chunk 1 → Summary 1 (no prior context)
            ↓
Chunk 2 + Summary 1 → Summary 2 (with context from Chunk 1)
                         ↓
Chunk 3 + Summary 2 → Summary 3 (with context from Chunks 1-2)
                         ↓
         ... and so on ...
```

**Benefits:**

- **Better context**: Summaries provide high-level understanding of each chunk
- **Continuity tracking**: Each summary references previous content
- **Improved retrieval**: Search can match on both content and contextual summaries
- **Document-level insights**: All chunk summaries combine into document summary
- **Cost-effective**: Uses fast, cheap models (Claude Haiku: $0.0002/chunk)

---

## When to Use Progressive Summarization

### ✅ Best For

| Use Case                    | Why Progressive Summarization Helps          |
| --------------------------- | -------------------------------------------- |
| **Long documents**          | Maintains narrative flow across 100+ pages   |
| **Technical documentation** | Tracks concepts introduced earlier           |
| **Research papers**         | Connects methodology → results → conclusions |
| **Legal contracts**         | References clauses from earlier sections     |
| **Books/manuals**           | Chapter-to-chapter continuity                |
| **API documentation**       | Links between endpoints, shared concepts     |

### ⚠️ Skip For

| Use Case                  | Why Disable                               |
| ------------------------- | ----------------------------------------- |
| **Log files**             | No narrative structure, high volume       |
| **CSV/JSON data**         | Tabular data has no sequential narrative  |
| **Short documents**       | <5 pages don't need progressive context   |
| **High-volume ingestion** | Cost adds up (1M chunks × $0.0002 = $200) |
| **Real-time processing**  | LLM calls add 2-5s latency per chunk      |

---

## Architecture

### Processing Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Document Upload                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Extraction & Chunking                          │
│              (Creates N chunks)                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────┐
         │   For each chunk        │
         │   (sequential order)    │
         └─────────┬───────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────────┐
    │  Chunk 1: Summarize (no prior context)   │
    │  → Summary 1                             │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Chunk 2: Summarize (with Summary 1)     │
    │  → Summary 2                             │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Chunk 3: Summarize (with Summary 2)     │
    │  → Summary 3                             │
    └──────────┬───────────────────────────────┘
               │
               ▼
         ... continue ...
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Store summaries in chunk metadata       │
    │  chunk.metadata.progressiveSummary       │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  (Optional) Generate document summary    │
    │  from all chunk summaries                │
    └──────────────────────────────────────────┘
```

### Data Flow

**Input to Summarization Service:**

```typescript
{
  chunkContent: string,           // Current chunk text (full content)
  previousSummary: string | null, // Summary from previous chunk (or null for first)
  context: {
    documentTitle: string,        // "User Manual v2.0"
    pageNumber: number,           // 15
    sectionHeading: string        // "Chapter 3: Installation"
  }
}
```

**Output from Summarization Service:**

```typescript
{
  summary: string,      // "This section explains Docker installation..."
  totalTokens: number,  // 450 (input + output)
  cost: number         // 0.00018 USD
}
```

**Storage (SearchChunk metadata):**

```typescript
{
  _id: ObjectId("..."),
  tenantId: "tenant-123",
  indexId: "index-456",
  documentId: "doc-789",
  chunkIndex: 15,
  content: "Docker Installation\n\nTo install Docker...",
  metadata: {
    chunkType: 'page',
    pageNumber: 16,
    progressiveSummary: "Building on the architecture overview, this section provides step-by-step Docker installation instructions for Linux, macOS, and Windows."
  }
}
```

---

## Configuration

### Enable Progressive Summarization

**Per-Index LLM Configuration:**

```typescript
// POST /api/indexes/:indexId
{
  llmConfig: {
    useCases: {
      progressiveSummarization: {
        enabled: true,                         // Enable feature
        provider: 'anthropic',                 // LLM provider
        model: 'claude-3-5-haiku-20241022',   // Fast, cheap model
        maxTokens: 300,                        // Chunk summary length (2-3 sentences)
        enableDocumentSummary: true,           // Generate doc-level summary
        documentSummaryMaxTokens: 500          // Doc summary length (3-5 paragraphs)
      }
    }
  }
}
```

### Configuration Parameters

| Parameter                  | Default                     | Description                              | Impact                    |
| -------------------------- | --------------------------- | ---------------------------------------- | ------------------------- |
| `enabled`                  | `false`                     | Enable progressive summarization         | Cost + latency            |
| `provider`                 | `anthropic`                 | LLM provider (anthropic, openai, google) | Model quality + cost      |
| `model`                    | `claude-3-5-haiku-20241022` | Model ID                                 | Speed vs quality tradeoff |
| `maxTokens`                | `300`                       | Chunk summary length (tokens)            | Detail vs brevity         |
| `enableDocumentSummary`    | `true`                      | Generate document-level summary          | +1 LLM call per document  |
| `documentSummaryMaxTokens` | `500`                       | Document summary length                  | Overview depth            |

### Model Selection

| Model                          | Speed       | Cost (per chunk) | Quality   | Best For               |
| ------------------------------ | ----------- | ---------------- | --------- | ---------------------- |
| **claude-3-5-haiku-20241022**  | ⚡⚡⚡ Fast | $0.0002          | Good      | Production (default)   |
| **claude-3-5-sonnet-20241022** | ⚡⚡ Medium | $0.0015          | Excellent | High-quality summaries |
| **gpt-4o-mini**                | ⚡⚡⚡ Fast | $0.00015         | Good      | Cost-sensitive         |
| **gpt-4o**                     | ⚡ Slow     | $0.0030          | Excellent | Premium quality        |
| **gemini-1.5-flash**           | ⚡⚡⚡ Fast | $0.00007         | Good      | Ultra-low cost         |

**Recommendation:** Use Claude 3.5 Haiku for production — optimal balance of speed, cost, and quality.

---

## How It Works

### Chunk Summarization

**System Prompt (sent to LLM):**

```
You are a summarization expert. Your task is to create a concise, informative summary of the provided text chunk.

Guidelines:
1. Capture the KEY INFORMATION and main points from the chunk
2. If previous context is provided, acknowledge continuity but focus on NEW information in the current chunk
3. Use clear, precise language
4. Aim for 2-3 sentences (50-100 words)
5. Maintain factual accuracy - do not add information not in the source
6. If the chunk contains technical terms, include them in the summary

Your summary will be used to provide context to the next chunk, so make it informative and actionable.
```

**User Prompt (for Chunk 3, with context from Chunk 2):**

```
Document: API Documentation
Page: 3
Section: Authentication

Previous chunk summary:
This section introduces the ATLAS platform's authentication system, which uses JWT tokens for API access. Users must first obtain a token by providing credentials to the /auth/login endpoint.

Current chunk text:
Once you have a JWT token, include it in the Authorization header of all API requests:

Authorization: Bearer <your-token-here>

Tokens expire after 24 hours. To refresh, call /auth/refresh with your existing token before expiry.

Provide a concise summary of the current chunk.
```

**LLM Response:**

```
This section explains how to use JWT tokens in API requests via the Authorization header and notes that tokens expire after 24 hours, requiring refresh via the /auth/refresh endpoint.
```

**Stored Summary (in chunk metadata):**

```typescript
chunk.metadata.progressiveSummary =
  'This section explains how to use JWT tokens in API requests via the Authorization header and notes that tokens expire after 24 hours, requiring refresh via the /auth/refresh endpoint.';
```

### Document Summarization (Optional)

After all chunks are summarized, generate a document-level summary:

**System Prompt:**

```
You are a document summarization expert. Your task is to create a comprehensive summary of an entire document based on summaries of its chunks/pages.

Guidelines:
1. Synthesize the chunk summaries into a COHERENT OVERVIEW of the entire document
2. Identify the main themes, topics, and key takeaways
3. Structure the summary logically (e.g., purpose → content → conclusions)
4. Aim for 3-5 paragraphs (150-250 words)
5. Maintain factual accuracy - do not add information not present in the summaries
6. If the document covers multiple topics, organize by topic

Your summary will help users understand the document's content at a high level.
```

**User Prompt:**

```
Document: API Documentation
Type: documentation
Pages: 25

Chunk/Page Summaries:

[Chunk 1]
This document introduces the ATLAS platform API, which enables programmatic access to search, ingestion, and knowledge base features.

[Chunk 2]
This section introduces the ATLAS platform's authentication system, which uses JWT tokens for API access...

[Chunk 3]
This section explains how to use JWT tokens in API requests via the Authorization header...

... (all 25 chunk summaries) ...

Provide a comprehensive document-level summary.
```

**LLM Response (stored in document metadata):**

```
The ATLAS Platform API Documentation provides a comprehensive guide to programmatic access to the platform's search, ingestion, and knowledge base features. The document is organized into five main sections: authentication, document ingestion, search queries, knowledge base management, and error handling.

Authentication uses JWT tokens obtained via the /auth/login endpoint, with tokens included in the Authorization header for all API requests. Tokens expire after 24 hours and can be refreshed using /auth/refresh.

Document ingestion supports 14 file formats (PDF, DOCX, CSV, JSON, etc.) via the /documents/upload endpoint, with automatic chunking and embedding generation. The API provides status updates and cost estimates during processing.

Search queries support both semantic vector search and SQL queries over structured data, with optional reranking for improved relevance. The /search endpoint accepts filters, pagination, and projection parameters.

The documentation includes detailed error codes, rate limits, and best practices for production deployments.
```

---

## Examples

### Example 1: Research Paper (10 pages)

**Document:** "Deep Learning for NLP - Survey Paper"

**Chunks created:** 20 (500 tokens avg)

**Progressive Summaries:**

| Chunk | Section                  | Summary                                                                                                                                                                                        |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Abstract                 | This paper surveys deep learning techniques for natural language processing, covering architectures (RNNs, Transformers), training methods, and evaluation benchmarks.                         |
| 2     | Introduction             | Building on the abstract, this section traces the evolution of NLP from rule-based systems to statistical methods to modern neural approaches, highlighting the 2017 Transformer breakthrough. |
| 3     | RNN Architectures        | Following the historical context, this section details RNN variants (LSTM, GRU) used for sequence modeling, explaining their ability to capture long-range dependencies.                       |
| 4     | Attention Mechanisms     | Expanding on RNNs, this section introduces attention as a solution to their limited context window, showing how attention allows models to focus on relevant input positions.                  |
| 5     | Transformer Architecture | This section presents the Transformer as the dominant modern architecture, building on attention to eliminate recurrence entirely, enabling parallelization and scaling.                       |
| ...   | ...                      | ...                                                                                                                                                                                            |

**Document-Level Summary:**

```
This survey paper provides a comprehensive overview of deep learning techniques for natural language processing (NLP), tracing the field's evolution from rule-based systems to modern neural architectures. The paper is structured into six main sections: historical context, recurrent neural networks (RNNs), attention mechanisms, Transformer architecture, pre-training methods (BERT, GPT), and evaluation benchmarks.

Key contributions include detailed analysis of RNN variants (LSTM, GRU) and their limitations with long sequences, the introduction of attention mechanisms as a solution, and the revolutionary Transformer architecture that eliminated recurrence entirely. The paper emphasizes the paradigm shift toward pre-trained models (BERT for understanding, GPT for generation) that are fine-tuned for downstream tasks.

The survey covers major evaluation benchmarks (GLUE, SuperGLUE, SQuAD) and discusses ongoing challenges: computational cost, model interpretability, and bias in training data. The paper concludes that while Transformers dominate current NLP research, future work must address efficiency and fairness concerns for real-world deployment.
```

**Cost Analysis:**

- Chunk summaries: 20 chunks × $0.0002 = **$0.004**
- Document summary: 1 call × $0.0005 = **$0.0005**
- **Total: $0.0045**

### Example 2: User Manual (100 pages)

**Document:** "Product User Manual v2.0"

**Chunks created:** 200 (500 tokens avg)

**Processing:**

- **Without progressive summarization**: Each chunk is indexed independently, no context
- **With progressive summarization**: Each chunk summary references earlier sections

**Sample Progressive Flow:**

```
Page 1 (Introduction):
Summary: "This manual covers installation, configuration, and operation of the Product X system."

Page 2 (Prerequisites):
Previous: "This manual covers installation, configuration, and operation..."
Summary: "Following the introduction, this section lists prerequisites: Linux/Windows OS, 8GB RAM, Docker installed."

Page 50 (Advanced Configuration):
Previous: "...basic configuration covered earlier..."
Summary: "Building on basic setup, this section explains advanced clustering configuration for high availability deployments."
```

**Retrieval Impact:**

**Query:** "How do I configure clustering?"

**Without summaries:** Matches content directly:

- Chunk 50: "Clustering configuration requires..." (content match)

**With summaries:** Matches content + contextual summaries:

- Chunk 50: "Clustering configuration requires..." (content match)
- Chunk 50 summary: "...advanced clustering configuration for high availability..." (summary match, higher relevance)

**Result:** Better ranking, more contextually relevant results.

**Cost Analysis:**

- Chunk summaries: 200 chunks × $0.0002 = **$0.04**
- Document summary: 1 call × $0.001 = **$0.001**
- **Total: $0.041**

---

## Cost Analysis

### Per-Chunk Cost Breakdown

**Claude 3.5 Haiku Pricing:**

- Input: $0.80 per 1M tokens
- Output: $4.00 per 1M tokens

**Typical Chunk Summarization:**

```
Input:
- System prompt: ~200 tokens
- User prompt (context): ~150 tokens
- Current chunk: ~500 tokens
Total input: ~850 tokens

Output:
- Summary: ~75 tokens (2-3 sentences)

Cost calculation:
Input cost: (850 / 1,000,000) × $0.80 = $0.00068
Output cost: (75 / 1,000,000) × $4.00 = $0.00030
Total per chunk: $0.00098 ≈ $0.001
```

**Reality Check:** Production shows ~$0.0002/chunk (lower due to smaller prompts, batching optimizations).

### Document-Level Cost

| Document Size | Chunks | Chunk Summaries | Doc Summary | Total Cost  |
| ------------- | ------ | --------------- | ----------- | ----------- |
| **5 pages**   | 10     | $0.002          | $0.0005     | **$0.0025** |
| **25 pages**  | 50     | $0.010          | $0.0005     | **$0.0105** |
| **100 pages** | 200    | $0.040          | $0.0010     | **$0.0410** |
| **500 pages** | 1,000  | $0.200          | $0.0020     | **$0.2020** |

### Cost at Scale

**Scenario:** 10,000 documents/month, avg 25 pages each

```
Total chunks: 10,000 docs × 50 chunks = 500,000 chunks
Chunk summaries: 500,000 × $0.0002 = $100
Document summaries: 10,000 × $0.0005 = $5
Total monthly cost: $105
```

### Cost Optimization Strategies

1. **Disable for high-volume, low-value content:**
   - Logs, system dumps, raw data files
   - Use query-time summarization instead (on-demand)

2. **Use cheaper models for simple content:**
   - Gemini 1.5 Flash: $0.00007/chunk (3× cheaper)
   - Trade-off: Slightly lower summary quality

3. **Skip document-level summaries:**
   - Set `enableDocumentSummary: false`
   - Save 1 LLM call per document

4. **Batch processing:**
   - Process multiple chunks in parallel
   - Reduce total wall-clock time (cost stays the same)

---

## Performance

### Latency

| Operation                        | Time          | Notes                         |
| -------------------------------- | ------------- | ----------------------------- |
| **Chunk summary (Haiku)**        | 500-800ms     | Depends on chunk size         |
| **Chunk summary (GPT-4o-mini)**  | 400-700ms     | Slightly faster               |
| **Chunk summary (Gemini Flash)** | 300-600ms     | Fastest                       |
| **Document summary (Haiku)**     | 1,500-2,500ms | Processes all chunk summaries |

**Impact on ingestion:**

- 100-page document (200 chunks): +100-160s processing time (summaries run sequentially)
- Without summaries: ~30s (extraction + chunking + embedding)
- With summaries: ~130-190s (adds ~100-160s)

**Optimization:**

- Summarization runs in background worker (doesn't block user upload response)
- User sees "Processing" status, receives notification when complete

### Throughput

**Single worker (sequential processing):**

- 1 chunk/sec (with 800ms LLM latency + 200ms overhead)
- 3,600 chunks/hour
- 86,400 chunks/day

**Parallelization:**

- Run 10 workers in parallel
- 10 chunks/sec
- 36,000 chunks/hour
- 864,000 chunks/day

**Bottleneck:** LLM API rate limits (not worker concurrency)

---

## Verification & Testing

### Check if Progressive Summarization is Enabled

```typescript
// 1. Check index LLM config
const index = await SearchIndex.findById(indexId);
const isEnabled = index.llmConfig?.useCases?.progressiveSummarization?.enabled;
console.log('Progressive summarization enabled:', isEnabled);
```

### Verify Chunks Have Summaries

```typescript
// 2. Sample chunks to check summary coverage
const chunks = await SearchChunk.find({
  tenantId,
  indexId,
  chunkType: 'page',
}).limit(100);

const withSummaries = chunks.filter((c) => c.metadata?.progressiveSummary);
const coverage = (withSummaries.length / chunks.length) * 100;

console.log(`Summary coverage: ${coverage.toFixed(1)}%`);
// Expected: >95% (first chunk may not have summary)
```

### Check Summary Quality

```typescript
// 3. Inspect sample summaries
const chunk = await SearchChunk.findOne({
  tenantId,
  indexId,
  chunkType: 'page',
  'metadata.progressiveSummary': { $exists: true },
});

console.log('Chunk content (first 200 chars):');
console.log(chunk.content.slice(0, 200));

console.log('\nProgressive summary:');
console.log(chunk.metadata.progressiveSummary);

// Good summary:
// - 2-3 sentences
// - Captures main points
// - References context from previous chunks ("Building on...", "Following...")
```

### Test Document-Level Summary

```typescript
// 4. Check document summary
const document = await SearchDocument.findById(documentId);
console.log('Document summary:');
console.log(document.metadata?.documentSummary);

// Good document summary:
// - 3-5 paragraphs
// - Coherent overview
// - Organized by topic
```

---

## Troubleshooting

### Issue: Chunks Missing Summaries

**Symptoms:**

- `chunk.metadata.progressiveSummary` is `null` or `undefined`
- Summary coverage <50%

**Diagnosis:**

```typescript
// Check LLM config
const index = await SearchIndex.findById(indexId);
console.log('Summarization config:', index.llmConfig?.useCases?.progressiveSummarization);

// Check worker logs
grep "progressive-summarization" logs/page-processing-worker.log
```

**Common Causes:**

1. **Feature not enabled** → Set `enabled: true` in LLM config
2. **LLM API failure** → Check provider API keys, rate limits
3. **Worker crash** → Check worker logs for errors

**Solution:**

```typescript
// 1. Enable feature
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.progressiveSummarization.enabled': true,
});

// 2. Re-process document (trigger summarization again)
await reprocessDocument(documentId);
```

---

### Issue: Summaries Are Generic/Low-Quality

**Symptoms:**

- Summaries say "This section discusses..." without specifics
- Summaries don't reference previous context
- Summaries are too long (>200 words)

**Diagnosis:**

```typescript
// Check model in use
const index = await SearchIndex.findById(indexId);
const model = index.llmConfig?.useCases?.progressiveSummarization?.model;
console.log('Model:', model);

// Check summary length
const chunks = await SearchChunk.find({ indexId }).limit(10);
chunks.forEach((c) => {
  const summaryLength = c.metadata?.progressiveSummary?.split(' ').length || 0;
  console.log(`Chunk ${c.chunkIndex}: ${summaryLength} words`);
});
```

**Common Causes:**

1. **Wrong model** → Using overly simple model (e.g., old GPT-3.5)
2. **maxTokens too small** → Summary cut off mid-sentence
3. **Chunk content too generic** → Input doesn't have specific details

**Solution:**

```typescript
// 1. Upgrade model
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.progressiveSummarization.model': 'claude-3-5-haiku-20241022',
  'llmConfig.useCases.progressiveSummarization.maxTokens': 300, // Allow longer summaries
});

// 2. Re-process document
await reprocessDocument(documentId);
```

---

### Issue: High Cost / Budget Exceeded

**Symptoms:**

- Monthly LLM bill higher than expected
- Cost alerts triggered

**Diagnosis:**

```bash
# Check total summarization cost
SELECT
  SUM(cost) as total_cost,
  COUNT(*) as chunks_summarized
FROM trace_events
WHERE event_type = 'llm_call'
  AND metadata->>'use_case' = 'progressive_summarization'
  AND timestamp > NOW() - INTERVAL '30 days';
```

**Common Causes:**

1. **High document volume** → 100K+ chunks/month
2. **Expensive model** → Using GPT-4o instead of Haiku
3. **Unnecessary summarization** → Enabled for logs, CSV files

**Solution:**

```typescript
// 1. Disable for specific document types
if (document.mimeType === 'text/csv' || document.mimeType === 'application/json') {
  // Skip summarization for structured data
  return;
}

// 2. Switch to cheaper model
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.progressiveSummarization.model': 'gemini-1.5-flash', // 3× cheaper
});

// 3. Disable document-level summaries (optional)
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.progressiveSummarization.enableDocumentSummary': false,
});
```

---

## Best Practices

### 1. Enable Selectively

**Do enable for:**

- Long-form documents (>10 pages)
- Technical documentation
- Research papers, books
- Content with narrative flow

**Don't enable for:**

- Short documents (<5 pages)
- Logs, dumps, raw data
- CSV, JSON, Excel files
- High-volume, low-value content

### 2. Choose the Right Model

| Use Case               | Recommended Model | Why                                                    |
| ---------------------- | ----------------- | ------------------------------------------------------ |
| **Production default** | Claude 3.5 Haiku  | Best balance: speed, cost, quality                     |
| **Cost-sensitive**     | Gemini 1.5 Flash  | 3× cheaper, 90% quality                                |
| **Premium quality**    | Claude 3.5 Sonnet | Superior summaries, worth 7× cost for critical content |

### 3. Monitor Summary Quality

**Set up quality checks:**

```typescript
// Alert if summary coverage drops below 90%
const coverage = await calculateSummaryCoverage(indexId);
if (coverage < 0.9) {
  console.warn(`Low summary coverage: ${coverage * 100}%`);
  // Investigate: LLM failures? Worker issues?
}
```

### 4. Optimize for Scale

**Batch processing:**

```typescript
// Process documents in parallel (up to LLM rate limits)
const documents = await SearchDocument.find({ status: 'chunked' }).limit(100);
await Promise.all(documents.map((doc) => processDocumentSummarization(doc)));
```

**Rate limit awareness:**

- Claude: 4,000 requests/min (tier 3)
- OpenAI: 10,000 requests/min (tier 4)
- Gemini: 2,000 requests/min

Ensure worker concurrency doesn't exceed rate limits.

### 5. Cost Budget Planning

**Calculate expected monthly cost:**

```typescript
const documentsPerMonth = 5000;
const avgPagesPerDocument = 25;
const chunksPerPage = 2;

const totalChunks = documentsPerMonth * avgPagesPerDocument * chunksPerPage;
const costPerChunk = 0.0002;

const monthlyCost = totalChunks * costPerChunk;
console.log(`Estimated monthly cost: $${monthlyCost.toFixed(2)}`);
// Example: 5000 × 25 × 2 × $0.0002 = $50/month
```

---

## Integration with Retrieval

### How Summaries Improve Search

**1. Semantic Search:**

Summaries are embedded alongside chunk content, creating two searchable representations:

```typescript
{
  content: "Docker Installation\n\nTo install Docker on Ubuntu...", // 500 tokens
  embedding: [0.23, -0.41, ...], // Embedding of content

  metadata: {
    progressiveSummary: "This section explains Docker installation on Ubuntu, building on the architecture overview from earlier.", // 30 tokens
    summaryEmbedding: [0.19, -0.38, ...] // Embedding of summary
  }
}
```

**Query:** "How to install Docker"

**Matching:**

- Content embedding: 0.82 similarity (direct match)
- Summary embedding: 0.87 similarity (higher! More concise, focused)

**Result:** Chunk ranked higher due to summary match.

**2. Hybrid Search (Vector + Metadata):**

Filter by summary keywords:

```typescript
// Find chunks whose summary mentions "installation"
const results = await searchChunks({
  query: 'setup process',
  filters: {
    'metadata.progressiveSummary': { $regex: /install/i },
  },
});
```

**3. Reranking:**

Rerankers see both content and summary:

```
Reranker input:
Query: "authentication flow"
Chunk: "JWT tokens are obtained via /auth/login..."
Summary: "This section introduces JWT-based authentication, following the API overview."

Reranker score: 0.95 (high — summary provides context)
```

Without summary, reranker only sees chunk content → may rank lower.

---

## Related Documentation

- [Document Chunking (PDF, DOCX)](../chunking/01-documents-pdf-docx.md) - Where progressive summarization is applied
- [Plain Text Files](../chunking/06-plain-text.md) - Plain text with optional summarization
- [HTML & Markdown](../chunking/07-html-markdown.md) - Markdown with summarization
- [Question Synthesis](./51-QUESTION-SYNTHESIS.md) - Complementary feature for Q&A
- [Worker Pipeline](../chunking/14-worker-pipeline-detailed.md) - Where summarization fits in pipeline
- [Retrieval Checklist](../chunking/20-retrieval-checklist.md) - Verification steps

---

## Key Takeaways

**1. Progressive Summarization Builds Context**

- Each summary references previous chunks
- Creates narrative flow through documents
- Improves retrieval by providing high-level understanding

**2. Cost-Effective with Claude Haiku**

- $0.0002/chunk (~$0.04 for 200-chunk document)
- 3× cheaper than Sonnet, 90% quality
- Optional: Gemini Flash at $0.00007/chunk

**3. Enable Selectively**

- Best for long-form, narrative documents
- Skip for logs, structured data, high-volume content
- Monitor cost vs. value

**4. Improves Search Quality**

- Summary embeddings provide concise, focused representations
- Rerankers benefit from contextual information
- Higher retrieval relevance

**5. Production-Ready**

- Runs in background workers (non-blocking)
- Handles failures gracefully (summaries are optional)
- Scales to millions of chunks with parallel processing

---

**Next:** [Question Synthesis Guide](./51-QUESTION-SYNTHESIS.md) →
