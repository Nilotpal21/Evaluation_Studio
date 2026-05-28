# ABLP-128: LLM Validation — Findings & Action Items

## Flow #1: Progressive Summarization — ✅ PASSED

- **Model used**: GPT-4o (balanced tier fallback — no fast tier model configured)
- **Resolver**: `resolveEnhancedIndexLLMConfig` (enhanced path with status tracking)
- **Where to see**: Chunk metadata → `metadata.progressiveSummary`
- **Toggle**: Studio → KB Settings → LLM Features → Core → Progressive Summarization

## Flow #3: Tree Building — ✅ WORKS but NOT CONSUMED

- **Model used**: GPT-4o (piggybacks on progressiveSummarization config)
- **Resolver**: `resolveIndexLLMConfig` (legacy — not enhanced)
- **Gates**: TWO gates — (1) `TREE_BUILDER_ENABLED=true` in env, (2) LLM config enabled
- **Where stored**: `chunk_hierarchies` collection + `document.metadata.treeStats`
- **Problem**: Tree is built and stored but **nothing reads it**. Query pipeline does flat kNN+BM25 — no hierarchical retrieval.

### Action Items for Tree Building

#### Level 1: Context Enrichment (Quick Win — 2-3 days)

After query pipeline Stage 3 returns results, look up each chunk's hierarchy:

- Fetch parent/root summaries from `chunk_hierarchies`
- Attach `hierarchyContext: { sectionSummary, documentSummary }` to each `SearchResult`
- Agent/LLM gets section + document context alongside each chunk
- **Files**: `query-pipeline.ts` (new Stage 3.7), `SearchResult` type in `search-ai-sdk`

#### Level 2: Hierarchical Retrieval (Medium — 1-2 weeks)

Index tree node summaries into OpenSearch:

- Embed root/internal node summaries alongside leaf chunks
- Add `nodeType` field to OpenSearch mappings
- Search across all tree levels, deduplicate by document
- **Files**: `tree-building-worker.ts`, `opensearch-mappings.ts`, `query-pipeline.ts`

#### Level 3: RAPTOR-style Recursive Retrieval (Full — 3-4 weeks)

Multi-hop coarse→fine retrieval using tree structure:

- First pass on root/internal summaries to find relevant docs/sections
- Second pass drilling into matching subtrees for precise chunks
- Integrate with scope classification (Flow #5)
- **Files**: New retrieval service, query classifier, `chunk-scope` + hierarchy wiring

### Other Issues Found

- Tree worker uses `resolveIndexLLMConfig` (legacy) — should use `resolveEnhancedIndexLLMConfig`
- Tree worker missing `withTenantContext()` wrapping (works due to explicit tenantId in queries, but inconsistent with other workers)
- Chunks don't have `position` field — `.sort({position: 1})` in tree worker is a no-op
- `TREE_BUILDER_ENABLED` defaults to `false` — easy to miss

---

## Flow #5: Scope Classification — ✅ PASSED (after fix)

- **Model used**: GPT-4o (balanced tier fallback from fast)
- **Resolver**: `resolveIndexLLMConfig` (legacy — not enhanced)
- **Default**: `enabled: false` (opt-in)
- **Gate**: LLM config only (no env var gate)
- **Where stored**: `chunk_scopes` collection + `document.metadata.scopeClassificationStats`
- **Problem**: Like tree building, **NOT consumed by query pipeline**. Data written but never read.

### Bug Found & Fixed

- **`maxTokens: 50` too low for GPT-4o** — response truncated mid-JSON → parse error → heuristic fallback
- **Prompt lacked strict JSON instruction** — GPT-4o adds preamble text before JSON
- **Before fix**: 6/14 successful (43%), all classified as `chunk` only
- **After fix**: 14/14 successful (100%), distribution: chunk=10, section=4
- **Files changed**:
  - `apps/search-ai/src/prompts/v1/scope-classifier.yaml` — maxTokens 50→150, added "Return ONLY valid JSON"
  - `apps/search-ai/src/services/llm-config/defaults.ts` — scopeClassification maxTokens 50→150
  - `apps/search-ai/src/services/scope-classifier/index.ts` — default maxTokens 50→150

### Action Items for Scope Classification

- Wire `retrievalStrategy` from `chunk_scopes` into query pipeline Stage 3
- For `with_context` strategy: attach parent summary from `chunk_hierarchies` (ties into Tree Building Level 1)
- For `hierarchical` strategy: return parent summary + top K children (ties into Tree Building Level 3)
- Scope classification + tree building together = smart retrieval (the intended design)

---

## Design Gaps — Scope + Tree Integration (for future implementation)

### Gap 1: 🔴 CRITICAL — Tree parentId/childIds use throwaway IDs

```
Leaf _id (MongoDB):  "019d4021-c222-7e6d..."   ← real MongoDB _id
Leaf parentId:       "node_14"                  ← internal build-time ID
Internal childIds:   ["node_0", "node_1", ...]  ← also internal IDs
```

`constrained-balancer.ts` generates `node_0`, `node_1`... during tree construction and stores them as-is in MongoDB. **You cannot look up a parent**: `findOne({_id: "node_14"})` returns null. The tree hierarchy is stored but unjoinable.

**Fix**: Change `constrained-balancer.ts` to generate real UUIDs for node IDs. Update `toChunkHierarchy()` to map parentId/childIds to MongoDB `_id`s before insertion.
**Files**: `apps/search-ai/src/services/tree-builder/constrained-balancer.ts`
**Effort**: ~30 min

### Gap 2: 🔴 CRITICAL — Root node summary is empty

```
Root summary: ""   ← should be a document-level summary
```

`generateSummaries()` in `tree-builder/index.ts` calls `getChildTexts()` which looks up children by `node.id` matching `allNodes.find(n => n.id === childId)`. Because `childIds` are `node_X` strings but `allNodes[].id` are also `node_X` strings, this SHOULD work internally — but the root has 2 children (the internal nodes), and their summaries may not be populated yet when root tries to read them (ordering issue in the summary generation loop).

**Root cause**: `generateSummaries()` processes all internal+root nodes in batch. If the root is processed BEFORE its children are summarized, the root gets empty child texts → empty summary.
**Fix**: Process nodes bottom-up (lowest depth first) in `generateSummaries()`, or process internal nodes first, then root separately.
**Files**: `apps/search-ai/src/services/tree-builder/index.ts` — `generateSummaries()` method
**Effort**: ~10 min

### Gap 3: 🟡 HIGH — No link between scope classification and tree hierarchy

```
chunk_scopes:       { chunkId, scopeLevel, retrievalStrategy: "with_context" }
                      ↑ no treeNodeId, no parentNodeId
chunk_hierarchies:  { chunkId, parentId, nodeType: "leaf" }
                      ↑ has the parent link (once Gap 1 is fixed)
```

Scope classification says "this chunk needs context" but doesn't reference the tree. The query pipeline would need to JOIN them at search time:

1. Get search results (chunks) from OpenSearch
2. Batch-lookup `chunk_scopes` by chunkIds → get retrieval strategies
3. For `with_context` chunks: batch-lookup `chunk_hierarchies` by chunkIds → get parentIds
4. Batch-lookup parent nodes → get summaries
5. Attach `{ sectionSummary, documentSummary }` to each SearchResult

**Fix — New Stage 3.7 in query pipeline** (`apps/search-ai-runtime/src/services/query/query-pipeline.ts`):

```
Stage 3:   Build + Execute Search (existing)
Stage 3.5: Score-Gap Filtering (existing)
Stage 3.7: Context Enrichment (NEW)
           - Read chunk_scopes for result chunkIds
           - For with_context/hierarchical: read chunk_hierarchies
           - Attach parent/root summaries to SearchResult
Stage 4:   Rerank (existing)
```

**Type changes needed** (`packages/search-ai-sdk`):

```typescript
// Add to SearchResult type
interface SearchResult {
  // ... existing fields
  hierarchyContext?: {
    scopeLevel: 'chunk' | 'section' | 'document';
    retrievalStrategy: 'direct' | 'with_context' | 'summary' | 'hierarchical';
    sectionSummary?: string; // parent internal node summary
    documentSummary?: string; // root node summary
  };
}
```

**DB access from search-ai-runtime**: Currently `search-ai-runtime` doesn't connect to `search_ai` content DB. It reads from OpenSearch. Options:

- A) Add MongoDB content DB connection to search-ai-runtime (invasive)
- B) Add a REST endpoint in search-ai that returns context for a list of chunkIds (cleaner, service boundary)
- C) Store scope + parent summary directly in OpenSearch during ingestion (fastest at query time, but denormalized)

**Recommended**: Option C — during tree building, write `parentSummary` and `scopeLevel` as fields on the OpenSearch document alongside the chunk vector. Zero query-time DB lookups.

**Files**:

- `apps/search-ai/src/workers/tree-building-worker.ts` — write parentSummary to OpenSearch after tree build
- `apps/search-ai/src/workers/scope-classification-worker.ts` — write scopeLevel to OpenSearch after classification
- `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts` — add fields
- `apps/search-ai-runtime/src/services/query/query-pipeline.ts` — read fields from search results
- `packages/search-ai-sdk/src/types.ts` — update SearchResult type
  **Effort**: ~2-3 hours

### Gap 4: 🟡 HIGH — Parallel execution ordering

Tree building and scope classification are both enqueued from `enrichment-worker.ts` in parallel:

```
enrichment-worker → enqueue tree-building job      ← parallel
enrichment-worker → enqueue scope-classification job ← parallel
```

If scope classification needs tree data (e.g., to store parentNodeId), tree building must finish first.

**Current state**: Not a problem since they're independent — neither reads the other's output.
**Future state (with Option C from Gap 3)**: If tree building writes parentSummary to OpenSearch and scope classification writes scopeLevel to OpenSearch, they can remain parallel — each writes its own field.
**Alternative**: If we want scope to reference tree, sequence them: enrichment → tree building → scope classification (change enrichment-worker to enqueue scope AFTER tree completes, or use BullMQ flow dependencies).

**Fix**: Change enrichment-worker.ts to enqueue scope classification AFTER tree building completes (BullMQ parent-child flow), OR keep parallel if using Option C.
**Files**: `apps/search-ai/src/workers/enrichment-worker.ts`
**Effort**: ~30 min

### Total Effort Estimate: ~4-5 hours

| Gap                          | Severity    | Effort  | Dependency                |
| ---------------------------- | ----------- | ------- | ------------------------- |
| Gap 1: Tree node IDs         | 🔴 Critical | 30 min  | None — fix first          |
| Gap 2: Root summary          | 🔴 Critical | 10 min  | After Gap 1               |
| Gap 3: Query pipeline wiring | 🟡 High     | 2-3 hrs | After Gap 1+2             |
| Gap 4: Execution ordering    | 🟡 High     | 30 min  | Depends on Gap 3 approach |
| Testing end-to-end           | —           | 30 min  | After all                 |

## Flow #7: Multimodal Enrichment — ✅ FIXED (5 bugs)

- **Model used**: GPT-4o (balanced tier — multimodal use case)
- **Resolver**: `resolveIndexLLMConfig` (legacy — not enhanced)
- **Where to see**: Chunk metadata → `metadata.imageDescriptions`, `metadata.tableSummaries`
- **Toggle**: Studio → KB Settings → LLM Features → Balanced → Multimodal
- **Default**: `enabled: false` (opt-in, expensive)
- **Gate**: DUAL — (1) `MULTIMODAL_ENABLED=true` env var in enrichment-worker, (2) LLM config enabled per-index
- **Verified**: 8 images across 3 chunks described by GPT-4o from Model Library ✅

### Bugs Found & Fixed

1. **Table summarizer used hardcoded env vars instead of Model Library**
   - Vision provider correctly used resolver, BUT table summarizer used `globalConfig.multiModal.tableSummarizerProvider/ApiKey/Model` from env vars
   - **Fix**: Use `llmConfig.useCases.multimodal.*` for both vision AND table summarizer

2. **Images never copied from pages to chunks**
   - Docling extracts images to `document_pages.images[]` but `page-processing-worker` never copied them to `chunk.metadata.images`
   - Multimodal worker reads from chunks → always found 0 images
   - **Fix**: Copy `page.images` and `page.tables` to chunk metadata during page-based chunking

3. **`extractImagesFromChunk` didn't handle Docling's `s3Url` field**
   - Docling stores images with `{s3Url, format, bbox}` but extractor only checked `{base64, url}`
   - **Fix**: Added `img.s3Url` as fallback source, derive mimeType from `img.format`

4. **`isAvailable()` always returned false — lazy init bug**
   - Clients initialized lazily in `initialize()` (called from `processChunk()`), but `isAvailable()` checked `this.visionClient !== null` BEFORE init
   - **Fix**: Removed lazy init — create `WorkerLLMClient` in constructor, `isAvailable()` now checks actual client instances

5. **`LLMClient` from `@abl/compiler` deprecated — `createProvider()` removed**
   - `MultiModalEnricher` used old `LLMClient` which throws `createProvider() is deprecated`
   - **Fix**: Migrated entire service to `WorkerLLMClient` from `@agent-platform/llm` with vision support via content blocks

### Files Changed

- `apps/search-ai/src/workers/multimodal-worker.ts` — Model Library config, s3Url support, debug logging
- `apps/search-ai/src/workers/page-processing-worker.ts` — copy page images/tables to chunk metadata
- `apps/search-ai/src/services/multimodal/index.ts` — full migration from deprecated LLMClient to WorkerLLMClient

### Also Verified

- **Flow #6: Visual Enrichment** (`visual-enrichment-worker.ts`) — correctly uses Model Library via `llmConfig` passed to `VisionService`. No fix needed.

---

## Design Gap — Multimodal Descriptions Not Consumed (for future implementation)

### Gap 5: 🟡 HIGH — Image descriptions stored but not searchable or retrievable

Image descriptions are generated by GPT-4o and stored in `chunk.metadata.imageDescriptions` in MongoDB. But they are:

- ❌ **Not embedded** — not part of chunk `content` that gets vectorized
- ❌ **Not in OpenSearch** — not searchable by BM25 or kNN
- ❌ **Not in search results** — query pipeline doesn't read or return them
- ❌ **Not shown to agent** — RAG chunks don't include image context

**Impact**: If a user asks "what does the revenue chart show?" — the system can't answer because the image description isn't searchable.

### Action Items for Multimodal Consumption

#### Option A: Append to chunk content before embedding (Simplest — 1 hour)

- After multimodal worker completes, append image descriptions to chunk `content`
- Re-embed the enriched chunk (or embed during initial embedding if ordering allows)
- Descriptions become searchable via both kNN and BM25
- **Downside**: Increases chunk token count, may affect retrieval ranking
- **Files**: `multimodal-worker.ts` (append to content), `embedding-worker.ts` (ensure re-embed)

#### Option B: Store in OpenSearch as separate fields (Better — 2 hours)

- Write `imageDescriptions` as a searchable text field in OpenSearch during embedding
- Add to BM25 `multi_match` fields with lower boost
- Keeps chunk content clean, image descriptions searchable separately
- **Files**: `embedding-worker.ts`, `opensearch-mappings.ts`, `HybridSearchBuilder`

#### Option C: Embed as separate vectors (Best for precision — 3 hours)

- Each image description gets its own vector in OpenSearch
- Tag with `contentType: 'image-description'` and parent `chunkId`
- Search matches image descriptions directly, returns parent chunk
- **Files**: `multimodal-worker.ts` or `embedding-worker.ts`, `opensearch-mappings.ts`, `query-pipeline.ts`

**Recommended**: Option B — searchable without changing chunk content or adding extra vectors.

| Gap                                      | Severity | Effort | Dependency                  |
| ---------------------------------------- | -------- | ------ | --------------------------- |
| Gap 5: Image descriptions not searchable | 🟡 High  | 2 hrs  | After multimodal fix (done) |

---

## Flow #2: Question Synthesis — ✅ PASSED

- **Model used**: GPT-4o (balanced tier fallback from fast)
- **Resolver**: `resolveIndexLLMConfig` (legacy)
- **Where stored**: `chunk_questions` collection + `document.metadata.questionSynthesisStats`
- Uses `WorkerLLMClient` with resolved provider/apiKey/model — all from Model Library ✅
- No hardcoded env var models

## Flow #4: Noise Detection — ✅ PASSED

- **Model used**: GPT-4o (balanced tier fallback from fast)
- **Resolver**: `resolveIndexLLMConfig` (legacy)
- **Default**: `enabled: false` (opt-in)
- Uses `WorkerLLMClient` with resolved provider/apiKey/model — all from Model Library ✅
- No hardcoded env var models
- Note: Filtering is disabled (`if (false)`) — all chunks pass to enrichment regardless

## Flows #8-23 — (pending)
