# Knowledge Auto-Generation + L3 RAG — Design Spec

**Date:** 2026-04-24
**Status:** Draft
**Author:** Sri Harsha + Claude
**Builds on:** `2026-04-24-arch-knowledge-rework-design.md` (L0 expansion + L2 consolidation)

## Problem

The Arch knowledge card system and `apps/docs-internal/` contain overlapping content maintained independently. An audit found:

- docs-internal is **25x larger** (2 MB / 41,857 lines vs 78 KB / 2,613 lines) and **5-21x deeper** on every overlapping topic.
- Cards cite deleted source files (`abl-anatomy-complete.html`).
- When someone edits docs-internal MDX, the corresponding knowledge card stays stale until manually updated.
- Topics not covered by any card (long-tail queries) force the LLM to hallucinate from training data.

## Approach

**Approach C: Hand-curated L0 + Auto-generated L2 + BM25 L3 RAG**

- **L0** (platform-limits.ts): Hand-curated. Contains rejected constructs, anti-patterns, CEL critical rules. NOT auto-generated — adversarial content needs human curation.
- **L2** (construct cards): Auto-generated at build time from docs-internal MDX. Same regex intent-matching, same card IDs, same token budget. Content derived from the docs instead of hand-written.
- **L3** (NEW): BM25 keyword index over all docs-internal chunks. Fills remaining token budget after L0+L2 with relevant doc chunks. Pre-built at build time, loaded once at startup.

## Design Decisions

| Decision               | Choice                                                             | Rationale                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L3 retrieval algorithm | BM25/TF-IDF keyword scoring                                        | 0.4ms query time, 1 MB memory, zero dependencies. Benchmarked against actual corpus: 10/10 correct top-1 hits on representative queries. Embeddings add 50-200MB memory + cold start for marginal gain on a 1,422-chunk corpus. |
| Index storage          | Pre-built JSON artifact committed to repo                          | Matches existing `abl:docs:generate` pattern. CI freshness check prevents drift. ~1 MB file.                                                                                                                                    |
| L2 generation strategy | Build-time script in `tools/abl-docs/`                             | Extends existing generation infrastructure (`generate.ts`, `check.ts`, `shared.ts`). Same developer workflow: edit MDX → run generate → commit.                                                                                 |
| L2 card structure      | Same card IDs, same regex patterns, new content                    | Backward-compatible. `card-router.ts` imports change path but API is identical. No consumer changes.                                                                                                                            |
| L0 handling            | Untouched, hand-curated                                            | Anti-hallucination content (rejected constructs, anti-patterns) is adversarial — needs human judgment, not auto-extraction.                                                                                                     |
| Deduplication          | L3 skips chunks from MDX files already covered by matched L2 cards | Prevents budget waste on redundant content. Mapping config declares which MDX files feed which card.                                                                                                                            |
| Corpus scope           | All 81 MDX files in `apps/docs-internal/content/`                  | Includes ABL reference, guides, tutorials, API reference, admin docs. Broad corpus means L3 can answer long-tail questions about Studio UI, admin config, API endpoints.                                                        |

## Architecture

```
Request arrives → selectKnowledgeCards(userMessage)
│
├─ L0: Always load platform-limits.ts (~500 tokens)
│   Subtract from budget.
│
├─ L1: Specialist prompts (unchanged, not managed here)
│
├─ L2: Regex-match user message against CARD_REGISTRY
│   Load matched cards from cards/generated/*.ts
│   Subtract from budget.
│
└─ L3: If remaining budget > 0:
    Tokenize user message → BM25 score against l3-index.json
    → Rank chunks
    → Skip chunks from MDX files already covered by matched L2 cards
    → Fill remaining budget with top-K chunks
    → Append to content

Return combined L0 + L2 + L3 content (capped at 6,000 tokens)
```

### Token Budget Flow Example

```
6,000 token budget
  - 500  L0 (platform-limits, always loaded)
  - 800  L2 (gather-fields card, regex matched)
  - 400  L2 (gather-validation-pii card, regex matched)
= 4,300 remaining for L3
  → BM25 retrieves top-K chunks (~500-800 tokens each)
  → ~5-8 chunks injected from related docs
```

## Build-Time Pipeline

### L2 Card Generator

**New file:** `tools/abl-docs/card-generator.ts`

**Input:** MDX files from `apps/docs-internal/content/abl-reference/` and `apps/docs-internal/content/guides/`

**Processing per card:**

1. Read MDX source files declared in the card's mapping config
2. Parse: strip frontmatter, preserve code fences and tables
3. Extract key sections: syntax tables, property tables, anti-patterns, code examples
4. Compress to LLM-optimized format: tables stay as markdown tables, prose compressed to bullet points, code blocks trimmed to essential examples only
5. Enforce per-card token cap (~400-800 tokens, matching current card sizes)
6. Write as TypeScript string export in `cards/generated/`

**Output:** `.ts` files in `packages/arch-ai/src/knowledge/cards/generated/`

**Mapping config:** `cards/_mapping.ts` declares for each card:

- `id`: Card ID (e.g., `flow-patterns`)
- `sources`: Array of MDX file paths + optional section selectors (H2 heading names)
- `patterns`: Regex patterns for card-router matching (preserved from current cards)
- `preserveSections`: Content blocks from current hand-written cards that MUST be included even if the MDX doesn't contain them (e.g., auth error codes, extraction pipeline internals, token cost annotations)
- `maxTokens`: Per-card token cap

**MDX-to-Card mapping (30 cards):**

| Card ID                      | Primary MDX Sources                                                          | Secondary Sources                            |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| `abl-anatomy`                | `abl-reference/language-overview.mdx`, `abl-reference/agent-declaration.mdx` |                                              |
| `execution-config`           | `abl-reference/agent-declaration.mdx` §Execution                             |                                              |
| `limitations-vs-constraints` | `abl-reference/memory-and-constraints.mdx` §Constraints                      | `abl-reference/guardrails.mdx`               |
| `flow-patterns`              | `abl-reference/flow.mdx`                                                     |                                              |
| `flow-reasoning-zones`       | `abl-reference/flow.mdx` §Reasoning zones                                    |                                              |
| `flow-transform`             | `abl-reference/flow.mdx` §TRANSFORM                                          | `guides/memory-and-state.mdx` §TRANSFORM     |
| `flow-digressions`           | `abl-reference/flow.mdx` §Digressions                                        |                                              |
| `gather-fields`              | `abl-reference/gather.mdx`                                                   | `guides/data-collection-with-gather.mdx`     |
| `gather-validation-pii`      | `abl-reference/gather.mdx` §Validation, §Sensitive                           |                                              |
| `tool-binding-auth`          | `abl-reference/tools.mdx`                                                    | `guides/tools-and-integrations.mdx`          |
| `tool-resolution`            | `abl-reference/tools.mdx` §Resolution                                        |                                              |
| `tool-templates`             | `abl-reference/rich-content-and-expressions.mdx` §Templates                  |                                              |
| `handoff-delegate`           | `abl-reference/multi-agent-and-supervisor.mdx` §HANDOFF, §DELEGATE           | `guides/agent-collaboration-and-handoff.mdx` |
| `routing-intents`            | `abl-reference/multi-agent-and-supervisor.mdx` §Routing, §SUPERVISOR         | `guides/multi-agent-orchestration.mdx`       |
| `cross-agent-contracts`      | `abl-reference/multi-agent-and-supervisor.mdx` §Contracts                    |                                              |
| `guardrails-tiers`           | `abl-reference/guardrails.mdx`                                               | `guides/safety-and-guardrails.mdx`           |
| `error-handling`             | `abl-reference/lifecycle-and-hooks.mdx` §ON_ERROR                            |                                              |
| `escalate-a2a`               | `abl-reference/multi-agent-and-supervisor.mdx` §ESCALATE                     |                                              |
| `cel-functions`              | `abl-reference/rich-content-and-expressions.mdx` §Expressions, §Functions    | `abl-reference/data-types-and-utilities.mdx` |
| `cel-pitfalls`               | `abl-reference/data-types-and-utilities.mdx` §Pitfalls                       |                                              |
| `memory-full`                | `abl-reference/memory-and-constraints.mdx` §Memory                           | `guides/memory-and-state.mdx`                |
| `nlu-entities`               | `abl-reference/nlu.mdx`                                                      |                                              |
| `behavior-profiles`          | `abl-reference/agent-declaration.mdx` §BEHAVIOR_PROFILE                      |                                              |
| `hooks-lifecycle`            | `abl-reference/lifecycle-and-hooks.mdx`                                      |                                              |
| `rich-content`               | `abl-reference/rich-content-and-expressions.mdx` §Rich Content               |                                              |
| `attachments-kb`             | `abl-reference/agent-declaration.mdx` §Attachments                           | `guides/knowledge-bases.mdx`                 |
| `project-config`             | `guides/publishing-and-operations.mdx`                                       | `admin/workspace-configuration.mdx`          |
| `diagnostics-workflow`       | `guides/testing-and-evaluation.mdx` §Diagnostics                             |                                              |
| `observer-analytics`         | `guides/testing-and-evaluation.mdx` §Analytics                               |                                              |
| `testing-workflow`           | `guides/testing-and-evaluation.mdx`                                          |                                              |

### L3 Index Builder

**New file:** `tools/abl-docs/l3-index-builder.ts`

**Input:** All 81 MDX files from `apps/docs-internal/content/`

**Chunking strategy:**

1. Split each MDX by `##` (H2) heading boundaries
2. If chunk exceeds 600 words, sub-split by `###` (H3) boundaries
3. Minimum chunk: 10 words (skip empty fragments)
4. Strip frontmatter; preserve code blocks and tables verbatim
5. Each chunk carries metadata: `{ file, heading, wordCount }`

**Index construction:**

1. Tokenize: lowercase, strip markdown syntax, split on non-alphanumeric, drop tokens < 3 chars
2. Compute per-chunk term frequencies, corpus-wide document frequencies
3. BM25 parameters: k1=1.5, b=0.75 (standard defaults, proven on this corpus)
4. Store chunk text alongside TF data (text needed for prompt injection)

**Output:** `packages/arch-ai/src/knowledge/l3-index.json` (~1 MB)

**Index schema:**

```typescript
interface L3Index {
  version: number; // Schema version for future changes
  generatedAt: string; // ISO timestamp
  chunks: L3Chunk[];
  df: Record<string, number>; // Document frequency per term
  avgdl: number; // Average document length (tokens)
  N: number; // Total chunk count
}

interface L3Chunk {
  file: string; // Relative path from content/
  heading: string; // H2 or H3 heading text
  text: string; // Raw chunk content (code blocks, tables preserved)
  words: number; // Word count
  tf: Record<string, number>; // Term frequencies for this chunk
}
```

### Integration with Existing Generation Pipeline

`tools/abl-docs/generate.ts` currently calls `writeGeneratedArtifacts()` which produces:

- `docs/reference/generated/abl-contract.json`
- `docs/reference/generated/abl-contract-facts.md`
- `apps/docs-internal/content/abl-reference/contract-facts.mdx`
- `apps/studio/content/abl-reference/contract-facts.mdx`
- `apps/docs-internal/content/abl-reference/full-specification.mdx`
- `apps/studio/content/abl-reference/full-specification.mdx`

**Extension:** Add to the same pipeline:

- `packages/arch-ai/src/knowledge/cards/generated/*.ts` (30 card files)
- `packages/arch-ai/src/knowledge/l3-index.json` (BM25 index)

Single command: `pnpm abl:docs:generate` produces all artifacts.

## Runtime Changes

### l3-search.ts (~80 lines)

**New file:** `packages/arch-ai/src/knowledge/l3-search.ts`

```typescript
export interface L3SearchResult {
  file: string;
  heading: string;
  text: string;
  score: number;
}

export function loadL3Index(): L3Index;
export function searchL3(index: L3Index, query: string, topK: number): L3SearchResult[];
```

- `loadL3Index()`: Reads and parses `l3-index.json`. Called once at module load (lazy singleton).
- `searchL3()`: Tokenizes query, computes BM25 scores against all chunks, returns top-K ranked results.

**Performance (benchmarked against actual corpus):**

- Query latency: **0.4ms average** (0.26-0.58ms range)
- Memory: **~1 MB** resident heap
- Cold start: **~46ms** (JSON parse, one-time)

### card-router.ts Changes

Existing function signature stays identical:

```typescript
export function selectKnowledgeCards(
  userMessage?: string,
  maxTokens?: number,
  forceCardIds?: string[],
): CardSelection;
```

**Changes to return type:**

```typescript
export interface CardSelection {
  selectedIds: string[];
  skippedIds: string[];
  l3Chunks: L3SearchResult[]; // NEW — L3 chunks that were injected
  content: string;
  estimatedTokens: number;
}
```

**New logic after existing L2 matching:**

```
if (userMessage && remainingBudget > 0) {
  1. Compute L2 coverage set: MDX files covered by matched L2 cards (from _mapping.ts)
  2. BM25 search: searchL3(index, userMessage, topK=10)
  3. Filter: skip chunks whose file is in L2 coverage set
  4. Fill: add chunks in score order until budget exhausted
  5. Append chunk text to content parts
}
```

### Callers (NO changes needed)

`composeSystemPrompt()` and `composeInProjectPrompt()` in `packages/arch-ai/src/prompts/index.ts` already consume `selectKnowledgeCards().content` as an opaque string. The L3 content is appended transparently.

## CI Freshness Enforcement

Extends `tools/abl-docs/check.ts` which already runs as part of `pnpm build` for docs-internal (see `apps/docs-internal/package.json`: `"build": "pnpm --dir ../.. abl:docs:check && next build"`).

**Check 1: L2 card staleness**

1. Re-run card generator in dry-run mode (generate in memory, don't write)
2. Compare against committed `.ts` files in `cards/generated/`
3. If mismatch → error: `"L2 cards are stale. Run 'pnpm abl:docs:generate' to regenerate."`

**Check 2: L3 index staleness**

1. Re-run index builder in dry-run mode
2. Compare against committed `l3-index.json`
3. If mismatch → error: `"L3 index is stale. Run 'pnpm abl:docs:generate' to regenerate."`

**Developer workflow (unchanged from today):**

```
1. Edit MDX in apps/docs-internal/content/
2. pnpm abl:docs:generate      ← already exists, extended
3. Commit MDX changes + regenerated artifacts together
```

## File Structure

```
packages/arch-ai/src/knowledge/
├── platform-limits.ts              # L0 — hand-curated, UNCHANGED
├── contract-facts.ts               # L0 — hand-curated, UNCHANGED
├── card-router.ts                  # MODIFIED: L3 fallthrough after L2
├── l3-search.ts                    # NEW: BM25 scorer (~80 lines)
├── l3-index.json                   # NEW: pre-built BM25 index (~1 MB)
├── index.ts                        # MODIFIED: export L3 types
├── cards/
│   ├── _mapping.ts                 # NEW: MDX → card mapping config
│   └── generated/                  # NEW: auto-generated L2 cards
│       ├── abl-anatomy.ts
│       ├── execution-config.ts
│       ├── flow-patterns.ts
│       ├── gather-fields.ts
│       ├── tool-binding-auth.ts
│       └── ... (30 cards total)

tools/abl-docs/
├── generate.ts                     # MODIFIED: calls card + index generators
├── check.ts                        # MODIFIED: checks card + index freshness
├── shared.ts                       # UNCHANGED
├── card-generator.ts               # NEW: MDX → compressed card .ts files
├── l3-index-builder.ts             # NEW: MDX → BM25 index JSON
└── card-mapping.ts                 # NEW: shared mapping config (used by both generator and card-router)
```

**Deleted:** 30 hand-written card files in `packages/arch-ai/src/knowledge/cards/` (replaced by `cards/generated/` equivalents).

**Unchanged:**

- `platform-limits.ts`, `contract-facts.ts` (L0)
- All specialist prompts in `prompts/specialists/`
- All phase prompts in `prompts/phases/`
- `composeSystemPrompt()` and `composeInProjectPrompt()` signatures
- L1 specialist system (not managed by knowledge layer)

## Migration & Rollout

### Phase 1: Scaffold (no behavior change)

- Create `cards/generated/` directory
- Create `cards/_mapping.ts` with all 30 card mappings
- Create `l3-search.ts` with BM25 scorer
- Create `tools/abl-docs/card-generator.ts` and `l3-index-builder.ts`
- Wire into `tools/abl-docs/generate.ts`
- Everything builds, nothing consumed yet

### Phase 2: L2 card swap (content change, same API)

- Run generator to produce cards in `cards/generated/`
- Spot-check 5-6 generated cards against hand-written equivalents for quality
- Verify `preserveSections` content (auth error codes, extraction pipeline, token costs) is present
- Update `card-router.ts` imports to `./cards/generated/`
- Delete old hand-written card files
- Run existing tests + 10 manual Arch queries to validate no regression

### Phase 3: L3 activation (new behavior)

- Generate `l3-index.json`
- Add L3 fallthrough logic to `selectKnowledgeCards()`
- Add L3 freshness check to `abl:docs:check`
- Test: verify L3 chunks fill budget, no duplication with L2, correct ranking

### Phase 4: Cleanup

- Remove stale HTML refs in JSDoc comments (`abl-anatomy-complete.html` → MDX paths)
- Update `packages/arch-ai/agents.md`
- Update test assertions for new card imports

### Rollback

Each phase is independently revertable:

- **Phase 2:** Restore deleted hand-written card files, revert import paths.
- **Phase 3:** Remove L3 block in `selectKnowledgeCards()` — function returns L0+L2 only, identical to current behavior.

## Testing

### Existing tests to update

- `__tests__/abl-contract-backed-knowledge.test.ts` — update imports from `cards/handoff-delegate` to `cards/generated/handoff-delegate`. Same assertions (contract syntax present in card content).
- `__tests__/build-prompt-contract.test.ts` — update imports from `cards/cel-functions` to `cards/generated/cel-functions`. Same assertions.

### New tests

- **Card generator output:** For each of the 30 cards, verify generated content includes key terms from the source MDX (e.g., `flow-patterns` card contains "ON_INPUT", "ON_RESULT", "THEN", "entry_point").
- **L3 index integrity:** Verify chunk count matches MDX file count (within tolerance), no empty chunks, all chunks have valid metadata.
- **L3 search quality:** 10 representative queries (same as benchmark) must return correct top-1 file.
- **L3 deduplication:** When L2 card `gather-fields` is matched, L3 results must not include chunks from `abl-reference/gather.mdx`.
- **Token budget:** L0 + L2 + L3 combined never exceeds `MAX_KNOWLEDGE_TOKENS` (6000).
- **Freshness check:** Modify an MDX file, verify `abl:docs:check` fails without regeneration.

### Manual validation

- Query Arch with 10 representative messages, verify knowledge section in system prompt contains relevant content from both L2 cards and L3 chunks.
- Query Arch with a long-tail topic (e.g., "how do I configure workspace SSO") that has no L2 card — verify L3 retrieves relevant chunks from `admin/security-and-authentication.mdx`.

## Performance Impact

| Metric                              | Before                    | After                                   | Delta    |
| ----------------------------------- | ------------------------- | --------------------------------------- | -------- |
| Query latency (knowledge selection) | ~0ms (regex only)         | ~0.4ms (regex + BM25)                   | +0.4ms   |
| Memory (per pod)                    | ~0                        | ~1 MB (index in heap)                   | +1 MB    |
| Startup time                        | ~0ms                      | ~46ms (JSON parse)                      | +46ms    |
| Build time                          | ~2s (existing generation) | ~3s (+ card gen + index build)          | +1s      |
| Artifact size (committed)           | ~78 KB (30 .ts files)     | ~1.15 MB (30 .ts files + l3-index.json) | +1.07 MB |
| External dependencies               | 0                         | 0                                       | 0        |

All deltas are negligible relative to the LLM API call that follows (2,000-10,000ms).

## Risk Assessment

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                                               |
| --------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L2 card quality regression — auto-generated cards miss hand-written nuances | Medium     | Medium | `preserveSections` in mapping config forcibly includes critical content (auth error codes, extraction pipeline, token costs). Spot-check during Phase 2. |
| L3 returns irrelevant chunks                                                | Low        | Low    | Chunks are additive (fill remaining budget). Bad chunks waste tokens but don't replace L0/L2 content. BM25 benchmark showed 10/10 correct top-1 hits.    |
| l3-index.json size grows beyond 2 MB                                        | Low        | Low    | Current corpus is 81 files → 1 MB. Would need ~160+ files to hit 2 MB. Monitor in CI.                                                                    |
| Stale index ships to prod                                                   | Low        | Medium | CI freshness check blocks builds. Same pattern as existing `full-specification.mdx` freshness check which has been reliable.                             |
| BM25 keyword mismatch (user says "send money", docs say "wire transfer")    | Medium     | Low    | L0/L2 curated cards handle semantic mapping via regex patterns. L3 is the depth fallback for keyword-matching queries, not the primary retrieval layer.  |
