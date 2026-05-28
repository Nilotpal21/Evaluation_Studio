# Arch Knowledge Retrieval Improvements

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Arch AI's in-project knowledge pipeline so general platform questions (APIs, SDKs, channels, admin, deployment) are answered from real docs instead of hallucinated from training data.

**Architecture:** Three layered fixes: (1) Add stopword filtering to BM25 tokenizer so content-word signal isn't drowned by common words, (2) Switch L3 retrieval from scattered top-N chunks to file-grouped retrieval that injects coherent document sections, (3) Add a `search_docs` LLM tool as an active fallback when passive prefill misses — the LLM can formulate precise queries and refine. Plus a grounding guard in the generalist prompt.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Root Cause Analysis:** Queries like "how to use the conversation api" tokenize to `[how, use, the, conversation, api]`. Without stopwords, `how` (df=191), `use` (df=365), `the` (df=1090) dominate BM25 scoring, pushing FAQ fragments above the actual `conversation-api.mdx` content. Even with perfect scoring, chunk-level retrieval scatters 1 relevant chunk among 9 irrelevant fragments from different files. The LLM fills gaps from training data with zero grounding guardrail.

---

## File Structure

```
MODIFIED FILES:
  packages/arch-ai/src/knowledge/l3-search.ts:30-37          — add stopword set + filter to tokenize()
  packages/arch-ai/src/knowledge/card-router.ts:833-860       — file-grouped L3 retrieval
  packages/arch-ai/src/knowledge/index.ts                     — export searchDocsForTool
  packages/arch-ai/src/types/tools.ts:10-51                   — add 'search_docs' to ToolName union
  packages/arch-ai/src/types/tools.ts:134-152                 — add search_docs to specialist tool maps
  packages/arch-ai/src/tools/adapters/classification.ts       — add search_docs: 'internal'
  packages/arch-ai/src/tools/schemas/in-project-schemas.ts    — add search_docs input schema
  packages/arch-ai/src/prompts/specialists/in-project-generalist.ts — add grounding guard + search_docs capability
  packages/arch-ai/src/prompts/phases/in-project.ts           — add search_docs to capabilities list
  apps/studio/src/lib/arch-ai/tools/in-project-tools.ts       — add search_docs tool definition + execute

TEST FILES:
  packages/arch-ai/src/__tests__/l3-search.test.ts            — add stopword filtering tests
  packages/arch-ai/src/__tests__/l3-file-retrieval.test.ts    — NEW: file-grouped retrieval tests
  packages/arch-ai/src/__tests__/search-docs-tool.test.ts     — NEW: search_docs tool unit tests
```

---

### Task 1: Add Stopword Filtering to BM25 Tokenizer

**Files:**

- Modify: `packages/arch-ai/src/knowledge/l3-search.ts:30-37`
- Test: `packages/arch-ai/src/__tests__/l3-search.test.ts`

**Context:** The `tokenize()` function at line 30 of `l3-search.ts` splits text into lowercase alpha-numeric tokens >2 chars but does no stopword removal. High-df words like "how" (191), "use" (365), "the" (1090) dominate BM25 scoring and push relevant results below noise.

- [ ] **Step 1: Write failing tests for stopword filtering**

Add to `packages/arch-ai/src/__tests__/l3-search.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildBm25Index, searchBm25, type L3Chunk } from '../knowledge/l3-search.js';

// ... existing SAMPLE_CHUNKS and tests ...

describe('stopword filtering', () => {
  const STOPWORD_CHUNKS: L3Chunk[] = [
    {
      file: 'api-reference/conversation-api.mdx',
      heading: 'Conversation API',
      text: 'The conversation API provides three interaction modes: agent-backed chat, streaming LLM completions, and non-streaming completions. POST /api/v1/chat/agent sends a message to an agent.',
      words: 28,
    },
    {
      file: 'faq/faq.mdx',
      heading: 'How do I use the REST API channel?',
      text: 'How do I use the REST API channel? You can use the REST API to send messages programmatically. The API requires authentication via JWT or API key.',
      words: 28,
    },
    {
      file: 'guides/channels.mdx',
      heading: 'Channel setup',
      text: 'Configure channels for your agent including web chat, WhatsApp, SMS, and voice. Each channel has its own authentication and webhook setup requirements.',
      words: 22,
    },
  ];

  const index = buildBm25Index(STOPWORD_CHUNKS);

  it('ranks conversation-api above FAQ for "how to use the conversation api"', () => {
    const results = searchBm25(index, 'how to use the conversation api', 3);
    expect(results[0].file).toBe('api-reference/conversation-api.mdx');
  });

  it('does not treat common words as high-signal', () => {
    // "the" appears in all 3 chunks — should not dominate scoring
    const results = searchBm25(index, 'conversation api', 3);
    const convResult = results.find((r) => r.file === 'api-reference/conversation-api.mdx');
    expect(convResult).toBeDefined();
    expect(results[0].file).toBe('api-reference/conversation-api.mdx');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-search.test.ts --reporter=verbose`
Expected: The stopword tests FAIL because "how", "the", "use" inflate FAQ scores above conversation-api.

- [ ] **Step 3: Add stopword set and filter to tokenize()**

In `packages/arch-ai/src/knowledge/l3-search.ts`, replace the `tokenize` function (lines 30-37):

````typescript
const STOPWORDS = new Set([
  'about',
  'after',
  'all',
  'also',
  'and',
  'any',
  'are',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'each',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'her',
  'here',
  'him',
  'his',
  'how',
  'into',
  'its',
  'just',
  'like',
  'make',
  'many',
  'may',
  'more',
  'most',
  'must',
  'not',
  'now',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'said',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'too',
  'under',
  'use',
  'very',
  'want',
  'was',
  'way',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function tokenize(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[|#*_\->[\](){}]/g, ' ')
    .toLowerCase();
  return cleaned.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}
````

**IMPORTANT:** This changes tokenization for both indexing (build-time) and querying (runtime). The pre-built `l3-index.json` contains `df` and `tfPerChunk` computed with the OLD tokenizer (no stopwords). After this change, the runtime `loadL3Index` path that recomputes `tfPerChunk` when missing (lines 111-120) will use the NEW tokenizer, but the stored `df` will be stale. This is acceptable because:

- `loadL3Index` already recomputes `tfPerChunk` at runtime (line 112: `if (!raw.tfPerChunk)`)
- The `df` from the JSON is stale but BM25 is robust to slightly off df values — the ranking improvement from stopword removal far outweighs the df staleness
- The next `pnpm run generate:docs` will rebuild the index with the new tokenizer, fixing df permanently

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-search.test.ts --reporter=verbose`
Expected: ALL tests pass including the new stopword tests. Existing tests should still pass because their queries use content words ("gather collect user information fields") not stopwords.

- [ ] **Step 5: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/__tests__/l3-search.test.ts
git add packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/__tests__/l3-search.test.ts
git commit -m "[ABLP-XXX] fix(arch-ai): add stopword filtering to BM25 tokenizer

Common words (how, the, use, what) dominated BM25 scoring,
pushing relevant doc chunks below noise fragments."
```

---

### Task 2: File-Grouped L3 Retrieval

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts:833-860`
- Create: `packages/arch-ai/src/__tests__/l3-file-retrieval.test.ts`

**Context:** L3 currently picks the top-10 individual chunks across all files. For "conversation api", you get 1 chunk from conversation-api.mdx scattered among 9 unrelated fragments. The fix: rank by _best-scoring file_, then inject all chunks from the top files (in document order) until the budget is full.

- [ ] **Step 1: Write failing test for file-grouped retrieval**

Create `packages/arch-ai/src/__tests__/l3-file-retrieval.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';

describe('L3 file-grouped retrieval', () => {
  it('returns l3Chunks grouped by file rather than scattered', () => {
    // This query should NOT match any L2 card patterns,
    // so all knowledge budget (minus L0) goes to L3.
    const result = selectKnowledgeCards('conversation api endpoints');

    // L3 chunks should be present (L0 always loads, L2 won't match)
    expect(result.l3Chunks.length).toBeGreaterThan(0);

    // Count how many unique files appear in L3 results
    const l3Files = new Set(result.l3Chunks.map((c) => c.file));

    // With file-grouped retrieval, we should get multiple chunks from the
    // same file rather than 1 chunk each from 10 different files.
    // At least one file should contribute 2+ chunks.
    const fileChunkCounts = new Map<string, number>();
    for (const chunk of result.l3Chunks) {
      fileChunkCounts.set(chunk.file, (fileChunkCounts.get(chunk.file) ?? 0) + 1);
    }
    const maxChunksFromOneFile = Math.max(...fileChunkCounts.values());
    expect(maxChunksFromOneFile).toBeGreaterThanOrEqual(2);
  });

  it('does not exceed token budget', () => {
    const result = selectKnowledgeCards('deploy agent production channels');
    // Default budget is 6000 tokens
    expect(result.estimatedTokens).toBeLessThanOrEqual(6000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-file-retrieval.test.ts --reporter=verbose`
Expected: FAIL — current L3 returns scattered chunks, `maxChunksFromOneFile` is likely 1.

- [ ] **Step 3: Implement file-grouped L3 retrieval in card-router.ts**

Replace the L3 section of `selectKnowledgeCards` in `packages/arch-ai/src/knowledge/card-router.ts` (lines 833-850). The current code is:

```typescript
// L3: BM25 fallthrough — fill remaining budget with relevant doc chunks
const l3Chunks: L3SearchResult[] = [];
if (userMessage && userMessage.trim().length > 0 && totalChars < maxChars) {
  try {
    const l3Index = loadL3Index();
    const coveredFiles = getCoveredFiles(selectedIds);
    const candidates = searchBm25(l3Index, userMessage, 10);

    for (const candidate of candidates) {
      if (candidate.score === 0) break;
      if (coveredFiles.has(candidate.file)) continue;
      const chunkChars = candidate.text.length;
      if (totalChars + chunkChars > maxChars) continue;
      parts.push(candidate.text);
      l3Chunks.push(candidate);
      totalChars += chunkChars;
    }
  } catch {
    // L3 index not available — degrade gracefully to L0+L2 only
  }
}
```

Replace with:

```typescript
// L3: BM25 fallthrough — file-grouped retrieval.
// Instead of picking top-N scattered chunks, rank files by their
// best chunk score, then inject all chunks from the top files
// (in document order) until the budget is full. This gives the LLM
// coherent document sections rather than fragments from 10 files.
const l3Chunks: L3SearchResult[] = [];
if (userMessage && userMessage.trim().length > 0 && totalChars < maxChars) {
  try {
    const l3Index = loadL3Index();
    const coveredFiles = getCoveredFiles(selectedIds);
    // Cast a wider net to get enough candidates for file grouping
    const candidates = searchBm25(l3Index, userMessage, 50);

    // Group by file, rank files by best chunk score
    const fileScores = new Map<string, number>();
    const fileChunks = new Map<string, L3SearchResult[]>();
    for (const candidate of candidates) {
      if (candidate.score === 0) break;
      if (coveredFiles.has(candidate.file)) continue;
      const current = fileScores.get(candidate.file) ?? 0;
      if (candidate.score > current) {
        fileScores.set(candidate.file, candidate.score);
      }
      const chunks = fileChunks.get(candidate.file) ?? [];
      chunks.push(candidate);
      fileChunks.set(candidate.file, chunks);
    }

    // Sort files by best score descending
    const rankedFiles = Array.from(fileScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file);

    // Inject chunks from top files until budget exhausted
    for (const file of rankedFiles) {
      const chunks = fileChunks.get(file) ?? [];
      // Check if even the smallest chunk from this file fits
      const smallestChunk = Math.min(...chunks.map((c) => c.text.length));
      if (totalChars + smallestChunk > maxChars) break;

      for (const chunk of chunks) {
        if (totalChars + chunk.text.length > maxChars) continue;
        parts.push(chunk.text);
        l3Chunks.push(chunk);
        totalChars += chunk.text.length;
      }
    }
  } catch {
    // L3 index not available — degrade gracefully to L0+L2 only
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-file-retrieval.test.ts src/__tests__/l3-search.test.ts --reporter=verbose`
Expected: ALL tests pass.

- [ ] **Step 5: Run existing knowledge tests to verify no regressions**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-integration.test.ts src/__tests__/abl-contract-backed-knowledge.test.ts --reporter=verbose`
Expected: All existing tests still pass.

- [ ] **Step 6: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/__tests__/l3-file-retrieval.test.ts
git add packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/__tests__/l3-file-retrieval.test.ts
git commit -m "[ABLP-XXX] fix(arch-ai): file-grouped L3 retrieval for coherent doc injection

L3 now ranks files by best chunk score and injects all chunks from
top files instead of scattering 1 chunk from 10 different files."
```

---

### Task 3: Add `search_docs` Tool — Type Registration

**Files:**

- Modify: `packages/arch-ai/src/types/tools.ts:10-51,112-241`
- Modify: `packages/arch-ai/src/tools/adapters/classification.ts`
- Modify: `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`

**Context:** Register `search_docs` as a new internal tool available in all IN_PROJECT specialist profiles. This task only does type/schema registration — no execute implementation yet.

- [ ] **Step 1: Add `search_docs` to the ToolName union**

In `packages/arch-ai/src/types/tools.ts`, add `'search_docs'` to the `ToolName` union type (after line 50, before the `kb_documents` line):

```typescript
  | 'search_docs'
```

- [ ] **Step 2: Add search_docs to every specialist tool map**

In `packages/arch-ai/src/types/tools.ts`, add `'search_docs'` to every specialist's tool array in `IN_PROJECT_SPECIALIST_TOOL_MAP`. Add it to each array — it's a read-only knowledge tool that every specialist should access:

Add `'search_docs',` as the first entry in each of these arrays:

- `diagnostician` (line ~113)
- `'abl-construct-expert'` (line ~134)
- `'channel-voice'` (line ~153)
- `'entity-collection'` (line ~163)
- `analyst` (line ~175)
- `observer` (line ~188)
- `'multi-agent-architect'` (line ~203)
- `'testing-eval'` (line ~215)
- `'integration-methodologist'` (line ~225)

- [ ] **Step 3: Add search_docs to classification.ts**

In `packages/arch-ai/src/tools/adapters/classification.ts`, add after the `// IN_PROJECT — ops` section (after `platform_context: 'internal'`):

```typescript
  // IN_PROJECT — knowledge retrieval
  search_docs: 'internal',
```

- [ ] **Step 4: Add search_docs input schema**

In `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`, add to the `toolInputSchemas` object:

```typescript
  search_docs: z.object({
    query: z.string().min(1).describe('Search query — use specific terms, API paths, or feature names'),
    limit: z.number().int().min(1).max(20).optional().default(5).describe('Max document sections to return'),
  }),
```

- [ ] **Step 5: Build to verify type consistency**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build. The ToolName union, specialist maps, classification, and schema are all consistent.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/arch-ai/src/types/tools.ts packages/arch-ai/src/tools/adapters/classification.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts
git add packages/arch-ai/src/types/tools.ts packages/arch-ai/src/tools/adapters/classification.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts
git commit -m "[ABLP-XXX] feat(arch-ai): register search_docs tool type and schema

Adds search_docs to ToolName, all specialist tool maps,
classification, and input schema. No execute implementation yet."
```

---

### Task 4: Add `search_docs` Execute Logic

**Files:**

- Modify: `packages/arch-ai/src/knowledge/index.ts`
- Create: `packages/arch-ai/src/__tests__/search-docs-tool.test.ts`
- Modify: `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`

**Context:** Wire the actual `search_docs` tool implementation. It wraps the same BM25 index with file-grouped retrieval logic, but returns structured results the LLM can reason about (file, heading, text per result).

- [ ] **Step 1: Add searchDocsForTool function to knowledge layer**

In `packages/arch-ai/src/knowledge/l3-search.ts`, add this exported function at the end of the file (before the closing):

```typescript
export interface DocSearchResult {
  file: string;
  sections: Array<{ heading: string; text: string; score: number }>;
  bestScore: number;
}

/**
 * Search the docs corpus and return file-grouped results.
 * Designed for the search_docs tool — returns structured results
 * the LLM can reason about, not raw chunks for prompt injection.
 */
export function searchDocsGrouped(query: string, maxResults: number = 5): DocSearchResult[] {
  const index = loadL3Index();
  const candidates = searchBm25(index, query, 50);

  // Group by file, rank files by best chunk score
  const fileMap = new Map<string, Array<{ heading: string; text: string; score: number }>>();
  const fileBestScore = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate.score === 0) break;
    const sections = fileMap.get(candidate.file) ?? [];
    sections.push({
      heading: candidate.heading,
      text: candidate.text,
      score: candidate.score,
    });
    fileMap.set(candidate.file, sections);

    const current = fileBestScore.get(candidate.file) ?? 0;
    if (candidate.score > current) {
      fileBestScore.set(candidate.file, candidate.score);
    }
  }

  return Array.from(fileBestScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([file, bestScore]) => ({
      file,
      sections: fileMap.get(file) ?? [],
      bestScore,
    }));
}
```

- [ ] **Step 2: Export from knowledge index**

In `packages/arch-ai/src/knowledge/index.ts`, add the export:

```typescript
export { searchDocsGrouped } from './l3-search.js';
export type { DocSearchResult } from './l3-search.js';
```

- [ ] **Step 3: Write test for searchDocsGrouped**

Create `packages/arch-ai/src/__tests__/search-docs-tool.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { searchDocsGrouped } from '../knowledge/l3-search.js';

describe('searchDocsGrouped', () => {
  it('returns file-grouped results for conversation api query', () => {
    const results = searchDocsGrouped('conversation api chat endpoint', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);

    // Each result should have file and sections
    for (const result of results) {
      expect(result.file).toBeTruthy();
      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.bestScore).toBeGreaterThan(0);
    }

    // conversation-api.mdx should be in the top results
    const convApi = results.find((r) => r.file.includes('conversation-api'));
    expect(convApi).toBeDefined();
  });

  it('returns empty array for nonsense query', () => {
    const results = searchDocsGrouped('xyzzy frobnicator', 5);
    expect(results).toHaveLength(0);
  });

  it('respects maxResults limit', () => {
    const results = searchDocsGrouped('agent tools configuration', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('results are sorted by bestScore descending', () => {
    const results = searchDocsGrouped('deploy production channels', 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].bestScore).toBeGreaterThanOrEqual(results[i].bestScore);
    }
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/search-docs-tool.test.ts --reporter=verbose`
Expected: ALL tests pass.

- [ ] **Step 5: Add search_docs tool to Studio in-project-tools.ts**

In `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`, add inside the `buildInProjectTools` return object (after the `manage_memory` tool, before the closing `};`):

```typescript
    search_docs: tool({
      description:
        'Search platform documentation for authoritative information about APIs, SDKs, features, ' +
        'configuration, channels, admin, deployment, and any platform topic. Returns relevant ' +
        'documentation sections grouped by source file. Use this when you need factual platform ' +
        'information that is not already in your context.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Search query — use specific terms, API paths, or feature names for best results',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe('Max document sections to return'),
      }),
      execute: async (input) => {
        try {
          const { searchDocsGrouped } = await import('@agent-platform/arch-ai');
          const results = searchDocsGrouped(input.query, input.limit ?? 5);

          if (results.length === 0) {
            return {
              success: true,
              results: [],
              message:
                'No documentation found matching that query. Try different search terms or a more specific query.',
            };
          }

          return {
            success: true,
            results: results.map((r) => ({
              file: r.file,
              relevanceScore: Math.round(r.bestScore * 100) / 100,
              sections: r.sections.map((s) => ({
                heading: s.heading,
                content: s.text,
              })),
            })),
            resultCount: results.length,
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'SEARCH_DOCS_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
```

Also add the import at the top of the file (it uses dynamic import so no static import needed — this follows the pattern of other tools in the file).

- [ ] **Step 6: Build both packages**

Run: `pnpm build --filter=@agent-platform/arch-ai && pnpm build --filter=studio`
Expected: Clean builds for both.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/knowledge/index.ts packages/arch-ai/src/__tests__/search-docs-tool.test.ts apps/studio/src/lib/arch-ai/tools/in-project-tools.ts
git add packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/knowledge/index.ts packages/arch-ai/src/__tests__/search-docs-tool.test.ts apps/studio/src/lib/arch-ai/tools/in-project-tools.ts
git commit -m "[ABLP-XXX] feat(arch-ai): add search_docs tool for on-demand doc retrieval

LLM can now actively search the docs corpus when passive BM25
prefill doesn't cover the user's question. File-grouped results
give coherent answers instead of scattered fragments."
```

---

### Task 5: Add Grounding Guard and search_docs to Prompts

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`
- Modify: `packages/arch-ai/src/prompts/phases/in-project.ts`

**Context:** Two prompt changes: (1) add a grounding guard so the LLM uses `search_docs` instead of hallucinating when it doesn't know, and (2) list `search_docs` in the capabilities so the LLM knows the tool exists.

- [ ] **Step 1: Add grounding guard to generalist prompt**

In `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`, add the following section after the `## Core Capabilities` section (after line 28, before `## Agent Modification Workflow`):

```typescript
## Knowledge & Documentation
- When asked about platform APIs, SDKs, configuration, deployment, channels, admin features,
  or any platform topic you are not certain about, use search_docs to find authoritative information
- NEVER fabricate API endpoints, request/response schemas, configuration options, or SDK methods
- If search_docs returns no results and you lack confident knowledge, say so clearly and suggest
  the user check the documentation site rather than guessing
- Knowledge injected in your context above covers ABL constructs well, but may not cover all
  platform topics — use search_docs to fill gaps
```

- [ ] **Step 2: Add search_docs to in-project phase capabilities**

In `packages/arch-ai/src/prompts/phases/in-project.ts`, add to the `**Capabilities:**` list (after the manage_memory line, around line 44):

```
- Search platform documentation for authoritative answers about APIs, SDKs, features, channels, deployment, admin, and any platform topic (search_docs)
```

Also add `search_docs` to the `IN_PROJECT_TOOL_LIST` by adding it to `IN_PROJECT_TOOLS` — but this is already handled by Task 3 (adding to specialist tool maps auto-derives `IN_PROJECT_TOOLS`). Verify the phase prompt's tool list reference will pick it up.

- [ ] **Step 3: Build to verify no issues**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/specialists/in-project-generalist.ts packages/arch-ai/src/prompts/phases/in-project.ts
git add packages/arch-ai/src/prompts/specialists/in-project-generalist.ts packages/arch-ai/src/prompts/phases/in-project.ts
git commit -m "[ABLP-XXX] feat(arch-ai): add grounding guard and search_docs to prompts

Instructs the LLM to use search_docs for platform questions it is
not certain about, and to never fabricate API details."
```

---

### Task 6: Rebuild L3 Index with New Tokenizer

**Files:**

- Modify: `packages/arch-ai/src/knowledge/l3-index.json` (regenerated)

**Context:** The `l3-index.json` was built with the old tokenizer (no stopwords). The `df` values are stale. While BM25 is robust to slightly off df, rebuilding ensures optimal ranking. This task regenerates the index using the existing build pipeline.

- [ ] **Step 1: Check if generate script exists**

Run: `ls tools/abl-docs/generate.ts tools/abl-docs/l3-index-builder.ts 2>/dev/null`
Expected: Both files exist (created in the earlier knowledge-auto-gen plan).

- [ ] **Step 2: Regenerate the L3 index**

Run: `cd tools/abl-docs && npx tsx generate.ts`
Expected: Regenerates `packages/arch-ai/src/knowledge/l3-index.json` with the new tokenizer's df/tf values.

If the generate script doesn't exist or errors, manually rebuild via:

```bash
cd packages/arch-ai && npx tsx -e "
import { readFileSync, writeFileSync } from 'fs';
import { buildBm25Index } from './src/knowledge/l3-search.js';
const raw = JSON.parse(readFileSync('./src/knowledge/l3-index.json', 'utf8'));
const rebuilt = buildBm25Index(raw.chunks);
writeFileSync('./src/knowledge/l3-index.json', JSON.stringify(rebuilt));
"
```

- [ ] **Step 3: Run all knowledge tests**

Run: `cd packages/arch-ai && npx vitest run src/__tests__/l3-search.test.ts src/__tests__/l3-file-retrieval.test.ts src/__tests__/search-docs-tool.test.ts src/__tests__/l3-integration.test.ts --reporter=verbose`
Expected: ALL tests pass with the rebuilt index.

- [ ] **Step 4: Commit**

```bash
git add packages/arch-ai/src/knowledge/l3-index.json
git commit -m "[ABLP-XXX] chore(arch-ai): rebuild L3 index with stopword-aware tokenizer

Regenerated BM25 index so df values match the updated tokenizer."
```

---

### Task 7: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full arch-ai test suite**

Run: `cd packages/arch-ai && npx vitest run --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 2: Build the full dependency chain**

Run: `pnpm build --filter=@agent-platform/arch-ai && pnpm build --filter=studio`
Expected: Clean builds.

- [ ] **Step 3: Manual smoke test — simulate the original failure**

Run a quick script to verify the original problem is fixed:

```bash
cd packages/arch-ai && npx tsx -e "
import { selectKnowledgeCards } from './src/knowledge/card-router.js';
import { searchDocsGrouped } from './src/knowledge/l3-search.js';

// Test 1: Passive L3 should now find conversation-api content
const result = selectKnowledgeCards('how to use the conversation api');
console.log('=== Passive L3 ===');
console.log('Selected L2 cards:', result.selectedIds);
console.log('L3 chunks:', result.l3Chunks.length);
const convApiChunks = result.l3Chunks.filter(c => c.file.includes('conversation-api'));
console.log('L3 conversation-api chunks:', convApiChunks.length);
console.log('L3 files:', [...new Set(result.l3Chunks.map(c => c.file))]);

// Test 2: search_docs tool should find it definitively
const docs = searchDocsGrouped('conversation api POST /api/v1/chat', 3);
console.log('\n=== search_docs tool ===');
for (const d of docs) {
  console.log(d.file, '- score:', d.bestScore.toFixed(2), '- sections:', d.sections.length);
}
"
```

Expected:

- Passive L3: multiple conversation-api chunks in results
- search_docs: conversation-api.mdx is the top result
