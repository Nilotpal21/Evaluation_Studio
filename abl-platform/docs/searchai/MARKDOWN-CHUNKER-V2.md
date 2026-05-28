# Markdown Chunker v2 — Strategy & Architecture

## Overview

Token-based, structure-aware chunking engine for HTML, DOCX, Markdown, and plain text. Uses unified/remark AST parser. Produces self-contained chunks optimized for BGE-M3 vector search.

**Token counting:** `tiktoken` (cl100k_base) — exact measurement, no character estimation.

---

## Token Constants

| Constant            | Value        | Purpose                                                                                                    |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| MAX_CHUNK_TOKENS    | 5000         | Max tokens per chunk. Trigger for force-split. BGE-M3 supports 8192; 5000 leaves room for query + metadata |
| MERGE_TARGET_TOKENS | 1500         | Merge threshold. Adjacent small chunks combine up to this limit                                            |
| TARGET_SPLIT_TOKENS | 5000 (= MAX) | When force-splitting a large section, fill each chunk to 5000. E.g., 8000 tokens → 5000 + 3000             |
| OVERLAP_TOKENS      | 200          | Context overlap between force-split chunks                                                                 |
| MIN_CHUNK_TOKENS    | 100          | Minimum viable chunk. Anything smaller is absorbed into its neighbor                                       |

---

## The Pipeline (7 Steps)

```
Input (HTML/DOCX/MD/TXT)
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 1: PARSE TO AST                                        │
│  unified + remark-parse + remark-gfm → full AST             │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 2: BUILD SECTION HIERARCHY                             │
│  Split on H1/H2/H3 → tree of sections with parent-child     │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 3: FLATTEN SECTIONS INTO CHUNKS                        │
│  • Prepend heading to content: "## Heading\n\n<body>"        │
│  • ≤ 5000 tokens → keep as ONE chunk                         │
│  • > 5000 tokens → force-split at paragraph boundaries       │
│    (fills to 5000 per chunk, 200 overlap)                    │
│  • Heading-only sections (no body, has children) → prepend   │
│    heading to first child's text (no orphan chunks)          │
│  • Atomic: code blocks, tables, lists NEVER split            │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 4: SIBLING MERGE                                       │
│  Adjacent chunks under SAME parent:                          │
│    both < 1500 AND combined ≤ 1500 → merge                   │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 5: AGGRESSIVE MERGE (hierarchy-agnostic)               │
│  ANY adjacent chunks:                                        │
│    both < 1500 AND combined ≤ 1500 → merge                   │
│  Catches: parent+child, cross-H1, orphan footers             │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 6: MICRO-CHUNK ABSORPTION                              │
│  Any chunk < 100 tokens → force-merge into nearest neighbor  │
│  Safety net for: heading orphans, image placeholders,        │
│  cookie banners, copyright footers, nav menus                │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 7: RE-INDEX & OUTPUT                                   │
│  Sequential chunkIndex (0, 1, 2, ...)                        │
│  Metadata: sectionPath, containsCode/Table/List, lines       │
└──────────────────────────────────────────────────────────────┘
```

---

## Force-Split Behavior (No Headers, Large Content)

When a single section exceeds 5000 tokens (no sub-headings to break it up):

```
8000 tokens, one heading:
  Chunk 0: # Heading + [first 5000 tokens, ends at paragraph boundary]
  Chunk 1: [200 overlap] + [remaining ~3000 tokens]

12000 tokens, no headings:
  Chunk 0: [first 5000 tokens]
  Chunk 1: [200 overlap] + [next ~5000 tokens]
  Chunk 2: [200 overlap] + [remaining ~2000 tokens]
```

Split hierarchy (tried in order):

1. `\n\n` — paragraph boundaries (preferred)
2. `\n` — line boundaries
3. `. ` / `! ` / `? ` — sentence boundaries
4. Character boundary (last resort)

---

## Merge Behavior (Small Sections)

**Step 4 (Sibling merge):** respects hierarchy

```
# Doc
## Section A (50 tok) ─┐
## Section B (60 tok) ─┤─ same parent "Doc" → merge (110 < 1500)
## Section C (40 tok) ─┘
→ 1 chunk (150 tokens)
```

**Step 5 (Aggressive merge):** hierarchy-agnostic

```
# Page Title (200 tok) ─┐
## Child Section (170 tok) ─┘─ different levels but both small → merge (370 < 1500)
→ 1 chunk (370 tokens)
```

**Step 6 (Absorption):** catches remaining micro-chunks

```
## Main Content (800 tok)
### Footer (25 tok) ← too small to exist alone, absorbed into Main Content
→ 1 chunk (825 tokens)
```

---

## What Never Gets Split

| Structure          | Guarantee                                   |
| ------------------ | ------------------------------------------- |
| Code blocks (```)  | Entire block in one chunk                   |
| Tables (\| row \|) | All rows together                           |
| Lists (- item)     | All items including nested                  |
| Headings           | Always prepended to chunk text (never lost) |

---

## Content Type Routing

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Upload/    │────▶│  Docling or      │────▶│  page-processing-   │
│  Crawl      │     │  raw extraction  │     │  worker.ts          │
└─────────────┘     └──────────────────┘     └─────────┬───────────┘
                                                        │
                                              ┌─────────▼───────────┐
                                              │  Content type check  │
                                              └─────────┬───────────┘
                                                        │
                         ┌──────────────────────────────┼──────────────────┐
                         │                              │                  │
              ┌──────────▼──────────┐      ┌───────────▼────────┐  ┌─────▼──────┐
              │ HTML/DOCX/MD/TXT    │      │ Pipeline explicitly │  │ PDF/Images │
              │ → chunkMarkdown()   │      │ says fixed/semantic │  │ → page-    │
              │ (ALWAYS first       │      │ → ChunkingService   │  │   based    │
              │  priority)          │      │ (user override)     │  │            │
              └─────────────────────┘      └────────────────────┘  └────────────┘
```

ALL text-based content types (HTML, DOCX, MD, TXT) use `chunkMarkdown()` by default. Only if the pipeline explicitly configures `fixed-size` or `semantic` chunking does it bypass the markdown chunker.

---

## Configuration API

```typescript
import { chunkMarkdown } from '@agent-platform/search-ai-internal/chunking';

const chunks = chunkMarkdown(markdownText, {
  headingLevels: [1, 2, 3], // Which headings trigger section splits
  preserveCodeBlocks: true, // Code blocks are atomic (default: true)
  preserveTables: true, // Tables are atomic (default: true)
  preserveLists: true, // Lists are atomic (default: true)
  maxChunkTokens: 5000, // Override: when to force-split
  mergeTargetTokens: 1500, // Override: merge threshold
});
```

---

## Decision Log

| Decision          | Chose                         | Over                  | Why                                                             |
| ----------------- | ----------------------------- | --------------------- | --------------------------------------------------------------- |
| Token measurement | tiktoken (cl100k_base)        | Character estimation  | Exact, matches embedding model                                  |
| Split target      | 5000 (fill to max)            | 1500 (many small)     | Same topic = maximize context per chunk                         |
| Merge strategy    | Hierarchy-agnostic final pass | Strict hierarchy only | Real web pages have orphan footers, parent-child small sections |
| Min chunk size    | 100 tokens                    | No minimum            | <100 tokens is useless for retrieval, adds noise                |
| Atomic structures | Code/table/list never split   | Allow splitting       | Fragments are useless; whole structures are searchable          |
| Heading in text   | Always prepended to chunk     | Metadata only         | Embedding model needs to see the topic label                    |
