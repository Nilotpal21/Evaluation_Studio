# TikToken Migration Plan

## Overview

Replace all character-based token estimation (`chars / 4`) with accurate tiktoken-based token counting across the entire codebase.

**Status:** ✅ Tokenizer modules created
**Date:** 2026-03-12

---

## Created Modules

### Python Module

- **File:** `services/docling-service/tokenizer.py`
- **Usage:**

  ```python
  from tokenizer import count_tokens

  token_count = count_tokens(text)
  ```

### TypeScript Module

- **File:** `packages/search-ai-internal/src/tokenizer/index.ts`
- **Usage:**

  ```typescript
  import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

  const tokenCount = countTokens(text);
  ```

### Configuration

- **Environment Variable:** `TOKENIZER_MODEL`
- **Default:** `cl100k_base` (GPT-4/GPT-3.5-turbo compatible)
- **Options (tiktoken 1.0.x):**
  - `cl100k_base` - GPT-4, GPT-3.5-turbo, text-embedding-ada-002
  - `p50k_base` - GPT-3 (Davinci, Curie, Babbage, Ada)
  - `r50k_base` - GPT-3 (older models)
- **Note:** `o200k_base` (GPT-4o) requires tiktoken 1.1+ (not yet available)

---

## Files to Update

### 🔴 Priority 1: Core Extraction & Chunking

#### 1. **services/docling-service/app.py**

**Lines to change:**

- Line 666: `tokenCount=len(full_text) // 4`

  ```python
  # BEFORE
  tokenCount=len(full_text) // 4

  # AFTER
  from tokenizer import count_tokens
  tokenCount=count_tokens(full_text)
  ```

#### 2. **apps/search-ai/src/workers/docling-extraction-worker.ts**

**Lines to change:**

- Line 309: `tokenCount: Math.ceil(page.text.length / 4)`

  ```typescript
  // BEFORE
  tokenCount: Math.ceil(page.text.length / 4);

  // AFTER
  import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
  tokenCount: countTokens(page.text);
  ```

#### 3. **apps/search-ai/src/workers/page-processing-worker.ts**

**Lines to change:**

- Line 237: Token-based chunking (inside ChunkingService)
- Line 365: `tokenCount: Math.ceil(mdChunk.text.length / 4)` - Markdown chunks
- Line 473: `tokenCount: Math.ceil(page.text.length / 4)` - Page chunks
- Line 547: `tokenCount: Math.ceil(table.markdown.length / 4)` - Table chunks

```typescript
// BEFORE
tokenCount: Math.ceil(content.length / 4);

// AFTER
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
tokenCount: countTokens(content);
```

#### 4. **apps/search-ai/src/services/chunking/index.ts**

**Lines to change:**

- Line 46: `const CHARS_PER_TOKEN = 4` - Remove constant
- Line 87-88: `windowSize`, `overlapSize` calculations
- Line 103, 117, 177, 212, 243, 258, 275: All `tokenCount` calculations
- Line 322-323: `estimateTokens()` function

```typescript
// BEFORE
const CHARS_PER_TOKEN = 4;
const windowSize = options.chunkSize * CHARS_PER_TOKEN;
private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// AFTER
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

// Calculate character size based on token target
const avgCharsPerToken = 4; // For size estimation only
const windowSize = options.chunkSize * avgCharsPerToken;

private estimateTokens(text: string): number {
    return countTokens(text);
}
```

#### 5. **packages/search-ai-internal/src/chunking/markdown-chunker.ts**

**Lines to change:**

- Line 360: `maxChunkSize: options.maxChunkSize ?? 1024` - This is CHARACTERS
- Line 248, 286: `content.length > options.maxChunkSize` - Character comparison

**Decision needed:** Should `maxChunkSize` be in TOKENS or CHARACTERS?

- **Option A:** Keep as characters (no change) - simpler, works
- **Option B:** Change to tokens - more accurate but requires token counting during chunking

**Recommendation:** Keep as characters for performance, but add a `maxChunkTokens` option later.

---

### 🟡 Priority 2: Summarization & Question Synthesis

#### 6. **apps/search-ai/src/services/progressive-summarization/index.ts**

**Lines to change:**

- Line 88-89: `estimateTokens()` calls
- Line 140-141: `estimateTokens()` calls
- Line 290-291: `estimateTokens()` implementation

```typescript
// BEFORE
private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// AFTER
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

private estimateTokens(text: string): number {
    return countTokens(text);
}
```

#### 7. **apps/search-ai/src/services/question-synthesis/index.ts**

**Lines to change:**

- Line 88-89, 283: Similar to progressive-summarization

---

### 🟢 Priority 3: Embedding Providers (Interface Consistency)

#### 8. **packages/search-ai-internal/src/embedding/bge-m3.ts**

**Lines to change:**

- `estimateTokens()` method

```typescript
// BEFORE
estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// AFTER
import { countTokens } from '../tokenizer/index.js';

estimateTokens(text: string): number {
    return countTokens(text);
}
```

#### 9. **packages/search-ai-internal/src/embedding/openai.ts**

- Same as above

#### 10. **packages/search-ai-internal/src/embedding/cohere.ts**

- Same as above

#### 11. **packages/search-ai-internal/src/embedding/custom.ts**

**Lines to change:**

- Line 68-70

---

### 🔵 Priority 4: Other Services

#### 12. **apps/search-ai/src/services/tree-builder/sentence-aligner.ts**

**Lines to change:**

- Token estimation function

#### 13. **apps/search-ai/src/services/structured-data/json-chunking-strategy.ts**

**Lines to change:**

- Line 264: Token estimation

---

## Migration Steps

### Step 1: Install Dependencies ✅

```bash
# Python
cd services/docling-service
uv add tiktoken

# TypeScript
cd packages/search-ai-internal
pnpm add tiktoken
```

### Step 2: Update Core Files (Priority 1)

1. Update `app.py` (Docling service)
2. Update `docling-extraction-worker.ts`
3. Update `page-processing-worker.ts`
4. Update `ChunkingService`

### Step 3: Update Services (Priority 2)

1. Update `progressive-summarization`
2. Update `question-synthesis`

### Step 4: Update Embedding Providers (Priority 3)

1. Update all providers to use tiktoken

### Step 5: Update Remaining Services (Priority 4)

1. Update tree-builder
2. Update json-chunking-strategy

### Step 6: Set Environment Variable

```bash
# .env file
TOKENIZER_MODEL=cl100k_base
```

### Step 7: Test

1. Run extraction on sample documents
2. Compare token counts (old vs new)
3. Verify chunking sizes
4. Check summarization costs

---

## Testing Checklist

- [ ] PDF extraction - token counts accurate
- [ ] DOCX extraction - token counts accurate
- [ ] Markdown chunking - chunk sizes correct
- [ ] HTML extraction - token counts accurate
- [ ] TXT files - token counts accurate
- [ ] Progressive summarization - cost estimates accurate
- [ ] Question synthesis - cost estimates accurate
- [ ] Embedding batching - token limits respected
- [ ] ChunkingService - chunk boundaries correct

---

## Expected Impact

### Token Count Accuracy

| Content Type  | Character-Based (Old) | TikToken (New)         | Accuracy Gain |
| ------------- | --------------------- | ---------------------- | ------------- |
| English text  | ~1 token per 4 chars  | Actual count           | ±10-20%       |
| Code (Python) | ~1 token per 4 chars  | ~1 token per 3.1 chars | ±25%          |
| Tables        | ~1 token per 4 chars  | ~1 token per 2.8 chars | ±30%          |
| Chinese text  | ~1 token per 4 chars  | ~1 token per 1.5 chars | ±60%          |
| JSON          | ~1 token per 4 chars  | ~1 token per 3.5 chars | ±15%          |

### Cost Impact

- **LLM costs** (summarization, questions): More accurate estimates
- **Embedding costs**: Better batch sizing (avoid exceeding token limits)
- **Chunking**: More consistent chunk sizes relative to BGE-M3's 3-5K token sweet spot

---

## Rollback Plan

If tiktoken causes issues:

1. Keep fallback logic in tokenizer modules (already implemented)
2. If tiktoken unavailable, automatically falls back to `chars / 4`
3. No breaking changes - graceful degradation

---

## Notes

### Character-Based Size Estimation Still Valid For:

- **Markdown chunking** (`maxChunkSize: 1024` characters)
  - Reason: Performance - counting tokens during AST parsing is expensive
  - Keep as-is, add token counting AFTER chunks created

- **Initial size checks** (e.g., "is this text > 10MB?")
  - Reason: Character length is faster for gross size checks
  - Use tiktoken only when accurate token count needed

### When to Use TikToken:

- ✅ Storing `tokenCount` in database
- ✅ LLM API calls (cost estimation)
- ✅ Embedding batch size validation
- ✅ Reporting and metrics
- ❌ Real-time chunking decisions (too slow)
- ❌ Size limits in MB (use byte length)

---

## Completion Criteria

- [ ] All Priority 1 files updated
- [ ] All Priority 2 files updated
- [ ] All Priority 3 files updated
- [ ] All Priority 4 files updated
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Environment variable documented in README
- [ ] Run `npx prettier --write` on all changed TypeScript files
- [ ] Run `ruff format` on all changed Python files
