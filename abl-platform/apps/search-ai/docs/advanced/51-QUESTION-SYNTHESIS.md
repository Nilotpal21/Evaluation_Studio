# Question Synthesis

**Status:** ✅ Production
**Feature:** ATLAS-KG Phase 5
**Service:** `QuestionSynthesisService`
**Cost:** ~$0.00017/chunk (Gemini Flash)
**Last Updated:** 2026-02-24

---

## Overview

Question Synthesis pre-generates answerable questions for each chunk of content, enabling question-based retrieval and query matching. Instead of only matching user queries against document content, the system can match against questions that the content answers — dramatically improving Q&A accuracy.

**Key Concept:**

```
Chunk Content:
"JWT tokens are obtained via the /auth/login endpoint..."

Generated Questions:
1. How do I get a JWT token in ATLAS?        (procedural)
2. What endpoint issues authentication tokens? (factual)
3. Where do I authenticate to use the API?    (procedural)
```

**When a user asks:** "How to authenticate?"
→ Match against Question #3: "Where do I authenticate to use the API?"
→ Return chunk with high confidence

**Benefits:**

- **Better Q&A matching**: User questions match pre-generated questions better than raw content
- **Improved ranking**: Chunks with question matches rank higher
- **Coverage diversity**: Multiple questions per chunk capture different angles
- **Question type classification**: Filter by question type (factual, procedural, conceptual, analytical)
- **Cost-effective**: Gemini Flash generates 3-5 questions for $0.00017/chunk

---

## When to Use Question Synthesis

### ✅ Best For

| Use Case              | Why Question Synthesis Helps                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| **Documentation**     | Users ask "How do I...?" — pre-generated procedural questions match perfectly |
| **FAQs**              | Convert content into Q&A format automatically                                 |
| **Knowledge bases**   | Support article searches benefit from question-based matching                 |
| **API documentation** | Technical "what/how" questions match generated questions                      |
| **Tutorials**         | Step-by-step guides generate clear procedural questions                       |
| **Research papers**   | "What did they find?" matches analytical questions                            |

### ⚠️ Skip For

| Use Case                   | Why Disable                                |
| -------------------------- | ------------------------------------------ |
| **Logs/dumps**             | No Q&A structure, pure data                |
| **CSV/JSON**               | Tabular data doesn't answer questions      |
| **Code repositories**      | Code content, not explanatory text         |
| **High-volume, low-value** | Cost adds up (1M chunks × $0.00017 = $170) |
| **Non-English content**    | LLM question quality varies by language    |

---

## Architecture

### Processing Flow

```
┌─────────────────────────────────────────────────────────────┐
│                Document Upload & Chunking                   │
│                (Creates N chunks)                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────┐
         │   For each chunk        │
         │   (parallel batches)    │
         └─────────┬───────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────────┐
    │  Send chunk to QuestionSynthesisService  │
    │  LLM generates 3-5 questions             │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Parse LLM response (JSON)               │
    │  Extract questions, types, confidence    │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Store in ChunkQuestion collection       │
    │  (MongoDB, linked to chunk)              │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  (Optional) Embed questions              │
    │  Generate vector embeddings              │
    └──────────┬───────────────────────────────┘
               │
               ▼
    ┌──────────────────────────────────────────┐
    │  Questions used in retrieval pipeline    │
    │  Match user queries against questions    │
    └──────────────────────────────────────────┘
```

### Data Flow

**Input to Question Synthesis Service:**

```typescript
{
  chunkContent: string,       // Chunk text (full content)
  context: {
    documentTitle: string,    // "API Documentation"
    documentType: string,     // "documentation"
    sectionHeading: string    // "Authentication"
  }
}
```

**LLM Prompt (sent to Gemini Flash):**

```
System Prompt:
You are a question generation expert. Your task is to generate 3 clear, answerable questions based on the provided text chunk.

Guidelines:
1. Questions must be DIRECTLY ANSWERABLE from the chunk content
2. Cover different aspects: facts, concepts, procedures, analysis
3. Vary complexity: some simple, some deeper
4. Use natural language, avoid yes/no questions when possible
5. Each question should be self-contained

Classify each question as:
- factual: asks for specific facts, data, names, dates
- conceptual: asks about definitions, meanings, relationships
- procedural: asks how to do something, steps, processes
- analytical: asks for interpretation, comparison, reasoning
- other: doesn't fit above categories

Return JSON array with format:
[
  { "question": "What is X?", "type": "conceptual", "confidence": 0.9 },
  ...
]

User Prompt:
Document: API Documentation
Type: documentation
Section: Authentication

Text chunk:
JWT tokens are obtained via the /auth/login endpoint by providing username and password. The endpoint returns a token valid for 24 hours. Include the token in the Authorization header for all subsequent API calls.

Generate 3 questions.
```

**LLM Response (JSON):**

```json
[
  {
    "question": "How do I obtain a JWT token in the ATLAS API?",
    "type": "procedural",
    "confidence": 0.95
  },
  {
    "question": "What endpoint is used for authentication?",
    "type": "factual",
    "confidence": 0.92
  },
  {
    "question": "How long are JWT tokens valid?",
    "type": "factual",
    "confidence": 0.98
  }
]
```

**Storage (ChunkQuestion collection):**

```typescript
// MongoDB documents
[
  {
    _id: ObjectId('...'),
    tenantId: 'tenant-123',
    indexId: 'index-456',
    documentId: 'doc-789',
    chunkId: ObjectId('chunk-abc'),
    question: 'How do I obtain a JWT token in the ATLAS API?',
    questionType: 'procedural',
    confidence: 0.95,
    scope: 'chunk',
    vectorId: 'vec-123', // If embedding enabled
  },
  {
    _id: ObjectId('...'),
    tenantId: 'tenant-123',
    indexId: 'index-456',
    documentId: 'doc-789',
    chunkId: ObjectId('chunk-abc'),
    question: 'What endpoint is used for authentication?',
    questionType: 'factual',
    confidence: 0.92,
    scope: 'chunk',
    vectorId: 'vec-124',
  },
  {
    _id: ObjectId('...'),
    tenantId: 'tenant-123',
    indexId: 'index-456',
    documentId: 'doc-789',
    chunkId: ObjectId('chunk-abc'),
    question: 'How long are JWT tokens valid?',
    questionType: 'factual',
    confidence: 0.98,
    scope: 'chunk',
    vectorId: 'vec-125',
  },
];
```

---

## Configuration

### Enable Question Synthesis

**Per-Index LLM Configuration:**

```typescript
// POST /api/indexes/:indexId
{
  llmConfig: {
    useCases: {
      questionSynthesis: {
        enabled: true,                       // Enable feature
        provider: 'google',                  // LLM provider (google, anthropic, openai)
        model: 'gemini-1.5-flash',          // Fast, cheap model
        questionsPerChunk: 3,                // Number of questions (3-5 recommended)
        maxTokens: 150,                      // Generation length
        enableEmbedding: true                // Embed questions for semantic search
      }
    }
  }
}
```

### Configuration Parameters

| Parameter           | Default            | Description                              | Impact                             |
| ------------------- | ------------------ | ---------------------------------------- | ---------------------------------- |
| `enabled`           | `false`            | Enable question synthesis                | Cost + latency                     |
| `provider`          | `google`           | LLM provider (google, anthropic, openai) | Model quality + cost               |
| `model`             | `gemini-1.5-flash` | Model ID                                 | Speed vs quality tradeoff          |
| `questionsPerChunk` | `3`                | Number of questions (3-5)                | Coverage vs cost                   |
| `maxTokens`         | `150`              | Generation length                        | Longer allows more questions       |
| `enableEmbedding`   | `true`             | Embed questions                          | Enables semantic question matching |

### Model Selection

| Model                          | Speed       | Cost (per chunk) | Quality   | Best For                  |
| ------------------------------ | ----------- | ---------------- | --------- | ------------------------- |
| **gemini-1.5-flash**           | ⚡⚡⚡ Fast | $0.00017         | Good      | Production (default)      |
| **claude-3-5-haiku-20241022**  | ⚡⚡⚡ Fast | $0.0002          | Good      | Slightly better quality   |
| **gpt-4o-mini**                | ⚡⚡ Medium | $0.00025         | Good      | OpenAI ecosystem          |
| **claude-3-5-sonnet-20241022** | ⚡⚡ Medium | $0.0015          | Excellent | Premium quality questions |
| **gpt-4o**                     | ⚡ Slow     | $0.003           | Excellent | Highest quality           |

**Recommendation:** Use Gemini 1.5 Flash for production — fastest and cheapest, excellent question quality.

---

## Question Types

Questions are automatically classified into five types:

### 1. Factual Questions

**Ask for:** Specific facts, data, names, dates, numbers

**Examples:**

- "What is the default port for the API?" → 3005
- "Who created the ATLAS platform?" → Kore.ai team
- "When was version 2.0 released?" → February 2026
- "How many file formats are supported?" → 14 formats

**Characteristics:**

- Definitive answers
- No interpretation required
- Often start with: What, Who, When, How many, Which

### 2. Conceptual Questions

**Ask for:** Definitions, meanings, relationships, explanations

**Examples:**

- "What is progressive summarization?"
- "What does JWT stand for?"
- "What is the purpose of chunking?"
- "What is the relationship between indices and knowledge bases?"

**Characteristics:**

- Require understanding, not just recall
- Often start with: What is, What does, Define, Explain

### 3. Procedural Questions

**Ask for:** Steps, processes, how-to instructions

**Examples:**

- "How do I upload a file to ATLAS?"
- "What are the steps to create a new index?"
- "How do I enable progressive summarization?"
- "What is the process for authentication?"

**Characteristics:**

- Action-oriented
- Step-by-step answers
- Often start with: How do I, How to, What steps, How can I

### 4. Analytical Questions

**Ask for:** Interpretation, comparison, reasoning, evaluation

**Examples:**

- "Why is Docling preferred over PyPDF2?"
- "What are the trade-offs between shared and dedicated indices?"
- "How does progressive summarization improve retrieval?"
- "What factors should I consider when choosing a model?"

**Characteristics:**

- Require reasoning, not just facts
- Often start with: Why, How does, What are the trade-offs, Compare

### 5. Other

**Fallback category** for questions that don't fit above types.

---

## How It Works

### Generation Process

**Step 1: Build System Prompt**

```typescript
const systemPrompt = `You are a question generation expert. Your task is to generate 3 clear, answerable questions based on the provided text chunk.

Guidelines:
1. Questions must be DIRECTLY ANSWERABLE from the chunk content
2. Cover different aspects: facts, concepts, procedures, analysis
3. Vary complexity: some simple, some deeper
4. Use natural language, avoid yes/no questions when possible
5. Each question should be self-contained (no pronouns like "it" or "they" without context)

Classify each question as:
- factual: asks for specific facts, data, names, dates
- conceptual: asks about definitions, meanings, relationships
- procedural: asks how to do something, steps, processes
- analytical: asks for interpretation, comparison, reasoning
- other: doesn't fit above categories

Return JSON array with format:
[
  { "question": "What is X?", "type": "conceptual", "confidence": 0.9 },
  ...
]`;
```

**Step 2: Build User Prompt with Context**

```typescript
let userPrompt = '';

if (context.documentTitle) {
  userPrompt += `Document: ${context.documentTitle}\n`;
}
if (context.documentType) {
  userPrompt += `Type: ${context.documentType}\n`;
}
if (context.sectionHeading) {
  userPrompt += `Section: ${context.sectionHeading}\n`;
}

userPrompt += `\nText chunk:\n${chunkContent}\n\nGenerate 3 questions.`;
```

**Step 3: Call LLM**

```typescript
const response = await llmClient.chat(systemPrompt, [{ role: 'user', content: userPrompt }], {
  model: 'gemini-1.5-flash',
  maxTokens: 150,
});
```

**Step 4: Parse JSON Response**

````typescript
// Extract JSON (handle markdown code blocks)
let jsonStr = response.trim();
if (jsonStr.startsWith('```json')) {
  jsonStr = jsonStr.slice(7, -3).trim();
}

const parsed = JSON.parse(jsonStr);
// [{ question: "...", type: "factual", confidence: 0.95 }, ...]
````

**Step 5: Store in Database**

```typescript
for (const q of parsed) {
  await ChunkQuestion.create({
    tenantId,
    indexId,
    documentId,
    chunkId: chunk._id,
    question: q.question,
    questionType: q.type,
    confidence: q.confidence,
    scope: 'chunk',
  });
}
```

**Step 6: (Optional) Embed Questions**

```typescript
if (config.enableEmbedding) {
  const embedding = await embedService.embed(q.question);
  await ChunkQuestion.findByIdAndUpdate(questionId, {
    vectorId: await storeEmbedding(embedding),
  });
}
```

### Fallback Parsing

If LLM returns non-JSON (malformed), use fallback:

```typescript
// Extract lines containing "?"
const lines = response.split('\n').filter((line) => line.includes('?'));

// Take first 3 questions
const questions = lines.slice(0, 3).map((line) => ({
  question: line.replace(/^\d+[\.\)]\s*/, ''), // Remove numbering
  questionType: 'other',
  confidence: 0.6, // Lower confidence
}));
```

---

## Examples

### Example 1: API Documentation (25 chunks)

**Document:** "ATLAS Platform API Documentation"

**Chunk 1: Authentication**

```
Content:
"Authentication uses JWT tokens obtained via POST /auth/login with username and password. Tokens expire after 24 hours. Include in Authorization header."

Generated Questions:
1. How do I authenticate to the ATLAS API? (procedural, 0.95)
2. What endpoint is used for login? (factual, 0.92)
3. How long are authentication tokens valid? (factual, 0.98)
```

**Chunk 2: File Upload**

```
Content:
"Upload files via POST /documents/upload. Supports PDF, DOCX, CSV, JSON. Max 100MB. Returns documentId."

Generated Questions:
1. How do I upload a document to ATLAS? (procedural, 0.94)
2. What file formats are supported? (factual, 0.96)
3. What is the maximum file size? (factual, 0.99)
```

**Chunk 3: Search Queries**

```
Content:
"Search via POST /search with query text. Returns top 10 results by default. Supports filters, reranking, pagination."

Generated Questions:
1. How do I search documents in ATLAS? (procedural, 0.93)
2. What is the default number of search results? (factual, 0.97)
3. What advanced features does search support? (conceptual, 0.88)
```

**Total Questions Generated:** 75 (25 chunks × 3 questions)

**Cost:**

- Question generation: 25 chunks × $0.00017 = **$0.00425**
- Question embedding: 75 questions × $0.00004 = **$0.003**
- **Total: $0.00725**

### Example 2: Research Paper (50 chunks)

**Document:** "Deep Learning for NLP - Survey Paper"

**Chunk 10: Attention Mechanisms**

```
Content:
"Attention mechanisms allow models to focus on relevant input positions when generating each output. Unlike RNNs which process sequentially, attention computes weighted combinations of all input positions in parallel."

Generated Questions:
1. What do attention mechanisms do? (conceptual, 0.94)
2. How do attention mechanisms differ from RNNs? (analytical, 0.91)
3. How are input positions processed in attention? (procedural, 0.89)
```

**Chunk 25: BERT Pre-training**

```
Content:
"BERT pre-training uses masked language modeling (MLM) and next sentence prediction (NSP). MLM masks 15% of tokens, model predicts masked tokens. Trained on BooksCorpus and Wikipedia."

Generated Questions:
1. What pre-training tasks does BERT use? (factual, 0.96)
2. How does masked language modeling work? (procedural, 0.93)
3. What datasets was BERT trained on? (factual, 0.98)
```

**Total Questions Generated:** 150 (50 chunks × 3 questions)

**Cost:** $0.0255

### Example 3: User Manual (100 chunks) with 5 Questions/Chunk

**Document:** "Product X User Manual v2.0"

**Configuration:**

```typescript
{
  questionSynthesis: {
    enabled: true,
    questionsPerChunk: 5,  // Higher coverage
    maxTokens: 200         // Allow longer generation
  }
}
```

**Sample Chunk: Installation**

```
Generated Questions:
1. What are the prerequisites for installing Product X? (factual, 0.96)
2. How do I install Product X on Linux? (procedural, 0.94)
3. How do I install Product X on Windows? (procedural, 0.95)
4. What should I do if installation fails? (procedural, 0.88)
5. How do I verify the installation succeeded? (procedural, 0.92)
```

**Total Questions Generated:** 500 (100 chunks × 5 questions)

**Cost:** $0.085

---

## Cost Analysis

### Per-Chunk Cost Breakdown

**Gemini 1.5 Flash Pricing:**

- Input: $0.075 per 1M tokens
- Output: $0.30 per 1M tokens

**Typical Question Generation:**

```
Input:
- System prompt: ~200 tokens
- User prompt (context): ~100 tokens
- Chunk content: ~500 tokens
Total input: ~800 tokens

Output:
- 3 questions (JSON): ~100 tokens

Cost calculation:
Input cost: (800 / 1,000,000) × $0.075 = $0.00006
Output cost: (100 / 1,000,000) × $0.30 = $0.00003
Total per chunk: $0.00009 ≈ $0.0001
```

**With embedding (optional):**

```
Question embedding cost: 3 questions × 20 tokens avg × $0.00004/1K tokens
= 3 × 0.00008 = $0.00024

Total with embedding: $0.0001 + $0.00024 = $0.00034
```

**Production average:** ~$0.00017/chunk (includes batching optimizations)

### Document-Level Cost

| Document Size | Chunks | Questions | Generation | Embedding | Total Cost |
| ------------- | ------ | --------- | ---------- | --------- | ---------- |
| **5 pages**   | 10     | 30        | $0.002     | $0.001    | **$0.003** |
| **25 pages**  | 50     | 150       | $0.008     | $0.006    | **$0.014** |
| **100 pages** | 200    | 600       | $0.034     | $0.024    | **$0.058** |
| **500 pages** | 1,000  | 3,000     | $0.170     | $0.120    | **$0.290** |

### Cost at Scale

**Scenario:** 10,000 documents/month, avg 25 pages each

```
Total chunks: 10,000 docs × 50 chunks = 500,000 chunks
Question generation: 500,000 × $0.00017 = $85
Question embedding: 500,000 × 3 questions × $0.00004 = $60
Total monthly cost: $145
```

### Cost Comparison with Other Models

| Model                 | Cost/Chunk | 500K Chunks/Month |
| --------------------- | ---------- | ----------------- |
| **Gemini 1.5 Flash**  | $0.00017   | $85               |
| **Claude 3.5 Haiku**  | $0.0002    | $100              |
| **GPT-4o Mini**       | $0.00025   | $125              |
| **Claude 3.5 Sonnet** | $0.0015    | $750              |
| **GPT-4o**            | $0.003     | $1,500            |

**Recommendation:** Gemini Flash provides best cost/performance ratio.

---

## Performance

### Latency

| Operation                              | Time              | Notes                 |
| -------------------------------------- | ----------------- | --------------------- |
| **Question generation (Gemini Flash)** | 300-600ms         | 3 questions per chunk |
| **Question generation (Claude Haiku)** | 500-800ms         | Slightly slower       |
| **Question generation (GPT-4o Mini)**  | 400-700ms         | Mid-range             |
| **Question embedding (BGE-M3)**        | 15ms per question | 3 questions = 45ms    |

**Impact on ingestion:**

- 100-page document (200 chunks): +60-120s (questions run in parallel batches)
- Without questions: ~30s (extraction + chunking + embedding)
- With questions: ~90-150s (adds ~60-120s)

**Optimization:**

- Questions generated in background worker (non-blocking)
- Batch processing: 5 chunks in parallel
- User sees "Processing" status, notified when complete

### Throughput

**Single worker (batched processing):**

- Batch size: 5 chunks (parallel LLM calls)
- 1 batch/sec (with 600ms LLM latency + 400ms overhead)
- 5 chunks/sec
- 18,000 chunks/hour
- 432,000 chunks/day

**10 workers in parallel:**

- 50 chunks/sec
- 180,000 chunks/hour
- 4.3M chunks/day

**Bottleneck:** LLM API rate limits (Gemini: 2,000 requests/min)

---

## Verification & Testing

### Check if Question Synthesis is Enabled

```typescript
// 1. Check index LLM config
const index = await SearchIndex.findById(indexId);
const isEnabled = index.llmConfig?.useCases?.questionSynthesis?.enabled;
console.log('Question synthesis enabled:', isEnabled);
```

### Verify Questions Were Generated

```typescript
// 2. Count questions per chunk
const questions = await ChunkQuestion.countDocuments({
  tenantId,
  indexId,
  scope: 'chunk',
});

const chunks = await SearchChunk.countDocuments({
  tenantId,
  indexId,
  chunkType: 'page',
});

const avgQuestionsPerChunk = questions / chunks;
console.log(`Average questions/chunk: ${avgQuestionsPerChunk.toFixed(2)}`);
// Expected: ~3 (or configured questionsPerChunk value)
```

### Check Question Quality

```typescript
// 3. Sample questions
const sampleQuestions = await ChunkQuestion.find({
  tenantId,
  indexId,
}).limit(10);

sampleQuestions.forEach((q) => {
  console.log(`Q: ${q.question}`);
  console.log(`   Type: ${q.questionType}, Confidence: ${q.confidence}`);
});

// Good questions:
// - Self-contained (no pronouns without context)
// - Answerable from chunk content
// - Diverse types (not all factual)
// - Natural language
```

### Test Question-Based Retrieval

```typescript
// 4. Search using question as query
const userQuery = 'How do I upload a file?';

// Match against generated questions
const matchingQuestions = await ChunkQuestion.find({
  tenantId,
  indexId,
  question: { $regex: /upload.*file/i },
});

console.log(`Found ${matchingQuestions.length} matching questions`);
matchingQuestions.forEach((q) => {
  console.log(`- ${q.question} (chunk: ${q.chunkId})`);
});

// Retrieve associated chunks
const chunkIds = matchingQuestions.map((q) => q.chunkId);
const chunks = await SearchChunk.find({ _id: { $in: chunkIds } });
console.log(`Retrieved ${chunks.length} relevant chunks`);
```

---

## Integration with Retrieval

### Question-Based Matching

**Traditional retrieval:** Match query against chunk content

```typescript
Query: "How to authenticate?"
  ↓ embed query
  ↓ search chunk embeddings
Chunks: [chunk1, chunk2, chunk3] (by semantic similarity)
```

**Question-enhanced retrieval:** Match query against questions + content

```typescript
Query: "How to authenticate?"
  ↓ embed query
  ↓ search question embeddings (ChunkQuestion.vectorId)
Questions: [
  "How do I authenticate to the API?" (0.95 similarity),
  "What is the authentication process?" (0.91 similarity),
  "How do I get a JWT token?" (0.89 similarity)
]
  ↓ retrieve associated chunks
Chunks: [chunk_auth1, chunk_auth2, chunk_auth3]
  ↓ re-rank using content similarity
Final results: Ranked chunks
```

**Benefit:** Question embeddings are more focused than content embeddings → better semantic match.

### Hybrid Approach

**Combine question-based + content-based retrieval:**

```typescript
// 1. Search questions
const questionMatches = await searchQuestions(query, { limit: 10 });
const questionChunkIds = questionMatches.map((q) => q.chunkId);

// 2. Search content
const contentMatches = await searchChunks(query, { limit: 10 });

// 3. Merge results (union of chunk IDs)
const allChunkIds = [...new Set([...questionChunkIds, ...contentMatches.map((c) => c._id)])];

// 4. Fetch chunks
const chunks = await SearchChunk.find({ _id: { $in: allChunkIds } });

// 5. Re-rank based on:
//    - Question match score (if matched via question)
//    - Content match score (if matched via content)
//    - Boost if matched via both
const rankedChunks = rerank(chunks, query);
```

**Result:** Better coverage and accuracy.

### Filter by Question Type

```typescript
// Find procedural questions (how-to)
const proceduralQuestions = await ChunkQuestion.find({
  tenantId,
  indexId,
  questionType: 'procedural',
  question: { $regex: /install/i },
});

// Useful for: "How do I install?" queries
// → Only return chunks with procedural questions
```

### Confidence Filtering

```typescript
// Only high-confidence questions (>0.9)
const highConfQuestions = await ChunkQuestion.find({
  tenantId,
  indexId,
  confidence: { $gte: 0.9 },
});

// Use for: High-precision retrieval (fewer but more accurate results)
```

---

## Troubleshooting

### Issue: No Questions Generated

**Symptoms:**

- `ChunkQuestion.count()` returns 0 for document
- Expected questions missing

**Diagnosis:**

```typescript
// Check LLM config
const index = await SearchIndex.findById(indexId);
console.log('Question synthesis config:', index.llmConfig?.useCases?.questionSynthesis);

// Check worker logs
grep "question-synthesis" logs/question-synthesis-worker.log
```

**Common Causes:**

1. **Feature not enabled** → Set `enabled: true` in config
2. **LLM API failure** → Check provider API keys, rate limits
3. **Worker not running** → Start question-synthesis-worker

**Solution:**

```typescript
// 1. Enable feature
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.enabled': true,
});

// 2. Re-process document
await reprocessDocument(documentId);
```

---

### Issue: Low-Quality Questions

**Symptoms:**

- Questions are generic: "What is this about?"
- Questions are yes/no: "Is this important?"
- Questions contain pronouns: "What does it do?"

**Diagnosis:**

```typescript
// Check sample questions
const questions = await ChunkQuestion.find({ indexId }).limit(20);
questions.forEach((q) => {
  console.log(`Q: ${q.question} (confidence: ${q.confidence})`);
});

// Look for:
// - Generic phrasing
// - Pronouns without context
// - Yes/no questions
```

**Common Causes:**

1. **Chunk content too generic** → Input lacks specifics
2. **Wrong model** → Using old/weak model
3. **Low maxTokens** → Output cut off mid-question

**Solution:**

```typescript
// 1. Upgrade model
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.model': 'claude-3-5-haiku-20241022',
  'llmConfig.useCases.questionSynthesis.maxTokens': 200,
});

// 2. Improve chunk quality (better extraction/chunking)

// 3. Re-generate questions
await reprocessDocument(documentId);
```

---

### Issue: High Cost / Budget Exceeded

**Symptoms:**

- Monthly LLM bill higher than expected
- Cost alerts triggered

**Diagnosis:**

```bash
# Check total question generation cost
SELECT
  SUM(cost) as total_cost,
  COUNT(*) as questions_generated
FROM trace_events
WHERE event_type = 'llm_call'
  AND metadata->>'use_case' = 'question_synthesis'
  AND timestamp > NOW() - INTERVAL '30 days';
```

**Common Causes:**

1. **High document volume** → 500K+ chunks/month
2. **Expensive model** → Using GPT-4o instead of Gemini Flash
3. **Too many questions/chunk** → Set to 5+ questions

**Solution:**

```typescript
// 1. Switch to cheaper model
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.model': 'gemini-1.5-flash',
});

// 2. Reduce questions per chunk
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.questionsPerChunk': 3, // Down from 5
});

// 3. Disable embedding (optional)
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.enableEmbedding': false,
});
```

---

### Issue: Questions Not Used in Retrieval

**Symptoms:**

- Questions generated, but search results unchanged
- No improvement in Q&A accuracy

**Diagnosis:**

```typescript
// Check if retrieval pipeline uses questions
const searchPipeline = await getSearchPipeline(indexId);
console.log('Uses question-based retrieval:', searchPipeline.includesQuestions);

// Check if questions have embeddings
const questionsWithEmbeddings = await ChunkQuestion.countDocuments({
  indexId,
  vectorId: { $exists: true, $ne: null },
});
console.log(`Questions with embeddings: ${questionsWithEmbeddings}`);
```

**Common Causes:**

1. **Retrieval pipeline not configured** → Enable question-based retrieval
2. **Questions not embedded** → `enableEmbedding: false` in config
3. **Wrong query type** → Keyword search doesn't use question embeddings

**Solution:**

```typescript
// 1. Enable question embedding
await SearchIndex.findByIdAndUpdate(indexId, {
  'llmConfig.useCases.questionSynthesis.enableEmbedding': true,
});

// 2. Re-generate questions with embeddings
await reprocessDocument(documentId);

// 3. Configure retrieval pipeline to use questions
// (Implementation-specific)
```

---

## Best Practices

### 1. Enable for Q&A Content

**Do enable for:**

- Documentation, tutorials, guides
- FAQ content, knowledge bases
- API references, technical docs
- Educational content

**Don't enable for:**

- Logs, dumps, raw data
- Code repositories (code, not explanations)
- Structured data (CSV, JSON)
- Non-textual content (images alone)

### 2. Choose Right Number of Questions

| Content Type                    | Questions/Chunk | Reasoning                     |
| ------------------------------- | --------------- | ----------------------------- |
| **Dense, technical**            | 5               | Many facts/concepts per chunk |
| **Documentation (default)**     | 3               | Balanced coverage             |
| **Simple content**              | 2               | Avoid redundant questions     |
| **High-volume, cost-sensitive** | 3               | Optimal cost/benefit          |

### 3. Monitor Question Quality

**Quality metrics:**

```typescript
// 1. Average confidence
const avgConfidence = await ChunkQuestion.aggregate([
  { $match: { indexId } },
  { $group: { _id: null, avg: { $avg: '$confidence' } } },
]);
console.log('Average question confidence:', avgConfidence[0].avg);
// Target: >0.90

// 2. Question type distribution
const typeDistribution = await ChunkQuestion.aggregate([
  { $match: { indexId } },
  { $group: { _id: '$questionType', count: { $sum: 1 } } },
]);
console.log('Question types:', typeDistribution);
// Target: Diverse (not all factual)
```

### 4. Embed Questions for Semantic Search

**Always enable embedding** unless:

- Cost is critical concern
- Only using keyword search (no semantic search)
- Questions used for metadata only (not retrieval)

**Benefits of embedding:**

- User queries match question embeddings (better than content)
- Question embeddings are focused, concise
- Improves ranking accuracy

### 5. Cost Budget Planning

**Calculate expected monthly cost:**

```typescript
const documentsPerMonth = 5000;
const avgPagesPerDocument = 25;
const chunksPerPage = 2;
const questionsPerChunk = 3;

const totalChunks = documentsPerMonth * avgPagesPerDocument * chunksPerPage;
const totalQuestions = totalChunks * questionsPerChunk;

const costGeneration = totalChunks * 0.00017;
const costEmbedding = totalQuestions * 0.00004;
const totalCost = costGeneration + costEmbedding;

console.log(`Estimated monthly cost: $${totalCost.toFixed(2)}`);
// Example: 5000 × 25 × 2 × $0.00017 + 3 × $0.00004 = $42.50 + $30 = $72.50/month
```

---

## Related Documentation

- [Progressive Summarization](./50-PROGRESSIVE-SUMMARIZATION.md) - Complementary context enrichment
- [Document Chunking](../chunking/01-documents-pdf-docx.md) - Where questions are generated
- [Plain Text Files](../chunking/06-plain-text.md) - Plain text with questions
- [HTML & Markdown](../chunking/07-html-markdown.md) - Markdown with questions
- [Worker Pipeline](../chunking/14-worker-pipeline-detailed.md) - Pipeline integration
- [Retrieval Checklist](../chunking/20-retrieval-checklist.md) - Verification steps

---

## Key Takeaways

**1. Question Synthesis Improves Q&A Retrieval**

- Pre-generated questions match user queries better than raw content
- Enables question-based search with high accuracy
- 3-5 questions per chunk cover different angles

**2. Cost-Effective with Gemini Flash**

- $0.00017/chunk (~$0.058 for 200-chunk document)
- 2× cheaper than Claude Haiku
- Excellent question quality

**3. Enable Selectively**

- Best for documentation, FAQs, knowledge bases
- Skip for logs, code, structured data
- Monitor cost vs. retrieval improvement

**4. Question Types Add Value**

- Factual, conceptual, procedural, analytical classification
- Filter by type for better matching
- Diverse question types improve coverage

**5. Production-Ready**

- Runs in background workers (non-blocking)
- Batch processing for efficiency
- Handles failures gracefully (questions are optional)
- Scales to millions of chunks

---

**Next:** [Reranking Strategies Guide](./52-RERANKING-STRATEGIES.md) →
