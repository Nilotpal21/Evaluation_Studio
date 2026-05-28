# Chunks Tab Redesign — Document-Grouped Collapsible View

## Problem Statement

Current Chunks tab has three UX issues:

1. **Repeated document names** — Every chunk row repeats its parent document title, wasting vertical space
2. **Popup blocks context** — Clicking a row opens a modal dialog, hiding the document list behind an overlay
3. **Search is siloed** — Global search returns flat chunk matches; per-document search only works inside the popup, not across all documents simultaneously

## Design Goal

Replace the flat chunk table + popup with an **inline, document-grouped accordion** where:

- Documents are collapsible section headers (no popup needed)
- Chunks are nested under their parent document
- Search is global: filters documents, auto-expands first match, highlights all matches

---

## Wireframe 1: Default State (All Collapsed)

All documents shown as collapsible rows. Each shows chunk count, total tokens, and status summary.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Sources   Documents   Chunks                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Total: 208 chunks across 5 documents     Indexed: 200   Pending: 8         │
│                                                                             │
│ ┌─ 🔍 Search chunks across all documents...  ─┐  [All] [indexed] [pending] │
│ └──────────────────────────────────────────────┘  [embedded] [error]        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ▸  📄 Manthan Mehta_4.5 yrs of exp-Chatbot...   1 chunk    914 tok  10 Apr│
│     ● indexed                                                               │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 confluence_prod_space_counts.csv           1 chunk      0 tok  10 Apr│
│     ● indexed                                                               │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 Amlesh - Technical Feedback Form.docx     3 chunks  1,110 tok 10 Apr│
│     ● indexed (3)                                                           │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 Resume_Rushikesh.pdf                       3 chunks    952 tok 10 Apr│
│     ● indexed (3)                                                           │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 amswer.txt                               200 chunks 38,784 tok10 Apr│
│     ● indexed (200)                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Document row anatomy:**

```
  ▸  📄 {Document Name}                    {N} chunks   {Total Tokens} tok  {Date}
     ● {status} ({count})
```

**Key details:**

- File icon derived from content type (📄 PDF, 📊 CSV, 📝 TXT, etc.)
- Chevron (▸/▾) indicates expand/collapse
- Token count is sum across all chunks in that document
- Status shows dominant status + count
- Sorted by document name (default), optionally by chunk count or date

---

## Wireframe 2: Single Document Expanded

Click a document row to expand it inline. Shows token stats, distribution bar, and chunk list.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Total: 208 chunks across 5 documents     Indexed: 200   Pending: 8         │
│ ┌─ 🔍 Search chunks...  ─┐              [All] [indexed] [pending] [error]  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ▸  📄 Manthan Mehta_4.5 yrs of exp...           1 chunk    914 tok        │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▾  📄 Resume_Rushikesh.pdf                       3 chunks   952 tok       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │   │
│  │ │ # 952    │ │ ⌀ 317    │ │ T  93    │ │ ≡ 750    │                │   │
│  │ │ Total    │ │ Avg /    │ │ Smallest │ │ Largest  │                │   │
│  │ │ Tokens   │ │ Chunk    │ │          │ │          │                │   │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘                │   │
│  │                                                                     │   │
│  │ Token Distribution                                                  │   │
│  │ [████████████████████████████████████][██████████][████████]         │   │
│  │  Chunk 0                              Chunk 1     Chunk 2           │   │
│  │                                                                     │   │
│  │  ○ │ ▸ #0  ## Education | Indian Institute of...    750  ● indexed  │   │
│  │    │                                                                │   │
│  │  ○ │ ▸ #1  | Indian Institute of Technology...      109  ● indexed  │   │
│  │    │                                                                │   │
│  │  ○ │ ▸ #2  ## Publication - Title: Tools for...      93  ● indexed  │   │
│  │                                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 Amlesh - Technical Feedback Form.docx     3 chunks  1,110 tok      │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ▸  📄 amswer.txt                               200 chunks  38,784 tok    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key details:**

- Stats bar (Total Tokens, Avg/Chunk, Smallest, Largest) shown inline — same 4-card pattern as current popup
- Token Distribution heatmap bar — same as current popup
- Chunk flow list with connector line — reuses existing ChunkFlowView pattern
- Each chunk row: #index, content preview (truncated), token count, status badge
- Chunks are lazy-loaded on expand (one API call per document)
- Multiple documents can be expanded simultaneously

---

## Wireframe 3: Chunk Expanded (Full Content)

Click a chunk row to expand it and see full content + metadata.

```
│  ▾  📄 Resume_Rushikesh.pdf                       3 chunks   952 tok       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ [Stats bar...]                                                      │   │
│  │ [Token distribution bar...]                                         │   │
│  │                                                                     │   │
│  │  ○ │ ▾ #0  ## Education | Indian Institute of...    750  ● indexed  │   │
│  │    │ ┌────────────────────────────────────────────────────────────┐  │   │
│  │    │ │ Content                                            [Copy] │  │   │
│  │    │ │ ┌──────────────────────────────────────────────────────┐  │  │   │
│  │    │ │ │ ## Education | Indian Institute of Technology Patna  │  │  │   │
│  │    │ │ │ Masters of Technology - Mechatronics Courses -       │  │  │   │
│  │    │ │ │ Deep Learning, Computer Vision, IoT                 │  │  │   │
│  │    │ │ │ ...                                                  │  │  │   │
│  │    │ │ └──────────────────────────────────────────────────────┘  │  │   │
│  │    │ │ ▸ Metadata (3 fields)                                    │  │   │
│  │    │ │ ▸ Canonical Metadata (5 fields)                          │  │   │
│  │    │ │ ID: abc123  Created: Apr 10, 17:55                       │  │   │
│  │    │ └────────────────────────────────────────────────────────────┘  │   │
│  │    │                                                                │   │
│  │  ○ │ ▸ #1  | Indian Institute of Technology...      109  ● indexed  │   │
│  │    │                                                                │   │
│  │  ○ │ ▸ #2  ## Publication - Title: Tools for...      93  ● indexed  │   │
│  │                                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
```

**Key details:**

- Chunk expansion happens INLINE within the document's expanded area
- Full content shown in a code-style box with copy button
- Metadata sections collapsible (same as current ChunkExplorer)
- Chunk ID and timestamps shown at bottom
- Scroll contained within the document section if content is very long (max-height)

---

## Wireframe 4: Search Active — Matching Documents Filtered

User types "education" in search. Only documents with matching chunks are shown.
First matching document auto-expands. First matching chunk auto-expands with highlighted text.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2 of 5 documents match "education"       7 matching chunks                 │
│ ┌─ 🔍 education                    ✕ ─┐  [All] [indexed] [pending]        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ▾  📄 Resume_Rushikesh.pdf              3 chunks (2 match)                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  ○ │ ▾ #0  ## ██Education██ | Indian Institute...  750  ● indexed   │   │
│  │    │ ┌────────────────────────────────────────────────────────────┐  │   │
│  │    │ │ ## ██Education██ | Indian Institute of Technology Patna   │  │   │
│  │    │ │ Masters of Technology - Mechatronics Courses -            │  │   │
│  │    │ │ Deep Learning, Computer Vision, IoT                      │  │   │
│  │    │ │                                                           │  │   │
│  │    │ │ ██Education██:                                            │  │   │
│  │    │ │ B.Tech in Mechanical Engineering...                      │  │   │
│  │    │ └────────────────────────────────────────────────────────────┘  │   │
│  │    │                                                                │   │
│  │  ● │ ▸ #1  | Indian Institute... ██Education██...  109  ● indexed   │   │
│  │    │       ↑ highlighted match indicator (● = has match)            │   │
│  │    │                                                                │   │
│  │    │   #2  ## Publication - Title: Tools for...      93  ● indexed  │   │
│  │    │       ↑ dimmed — no match in this chunk                        │   │
│  │                                                                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ▸  📄 amswer.txt                        200 chunks (5 match)              │
│                                                                             │
│  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
│  3 documents hidden (no matches)                          [Show all ▸]     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Search behavior — step by step:**

1. User types in search box → debounce 300ms
2. API: `fetchAllChunks(indexId, { search: "education", includeContent: true })`
3. Response grouped client-side by `documentId`
4. **Document filter**: Only documents with at least 1 matching chunk are shown
5. **Auto-expand first document**: The document with the most matches expands automatically
6. **Auto-expand first matching chunk**: Within that document, the first chunk containing the search term is expanded to show full content
7. **Highlight matches**: All occurrences of "education" are highlighted (yellow background) in both the chunk preview text AND the expanded full content
8. **Match indicator**: Matching chunks have a filled dot (●), non-matching chunks have an empty dot (○) or are dimmed
9. **Match counts**: Document header shows "3 chunks (2 match)" — total chunks AND match count
10. **Hidden documents**: Non-matching documents are collapsed into a summary: "3 documents hidden (no matches) [Show all]"

---

## Wireframe 5: Multiple Documents Expanded with Search

User can manually expand additional matching documents while search is active.

```
│  ▾  📄 Resume_Rushikesh.pdf              3 chunks (2 match)                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  ● │ ▸ #0  ## ██Education██ | Indian Institute...  750  ● indexed   │   │
│  │  ● │ ▸ #1  | Indian Institute... ██Education██...  109  ● indexed   │   │
│  │    │   #2  ## Publication - Title: Tools for...      93  ● indexed  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ▾  📄 amswer.txt                        200 chunks (5 match)              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  ● │ ▸ #2   <value> 1. ALWAYS ██include██ slack...  220  ● indexed  │   │
│  │    │   #3   Extract metadata fields ONLY when...      84  ● indexed │   │
│  │  ● │ ▸ #4   **Status:** ALWAYS ██include██d for...  231  ● indexed  │   │
│  │    │   ...                                                          │   │
│  │    │   (195 more chunks — scroll to see all)                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
```

**Key details for large documents (200+ chunks):**

- When expanded with search active: show matching chunks first, then non-matching
- OR: show chunks in order but with match indicators (●) and auto-scroll to first match
- For very large documents (200+ chunks): virtualize the chunk list, show "N more chunks" with a "Load more" button
- Matching chunks have a visual accent (left border highlight or filled indicator dot)

---

## Interaction Summary

| Action                   | Result                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Page load                | All documents collapsed, stats bar shows totals                                                     |
| Click document chevron   | Expand inline: stats + distribution + chunk list (lazy-loaded)                                      |
| Click chunk chevron      | Expand chunk: full content + metadata + copy                                                        |
| Type in search           | Debounce → filter to matching docs, auto-expand first doc + first matching chunk                    |
| Clear search             | Return to default collapsed view, preserve previously expanded docs                                 |
| Click status filter chip | Filter chunks by status (updates which docs are shown — only docs with chunks matching that status) |
| Click "Show all"         | Reveal non-matching documents (still collapsed) during search                                       |

---

## Data Flow

```
                          ┌─────────────────────┐
                          │   Chunks Tab Load    │
                          └──────────┬──────────┘
                                     │
                         ┌───────────▼───────────┐
                         │ Fetch document list    │  GET /indexes/:id/documents
                         │ (name, chunkCount,     │  (already exists)
                         │  status, contentType)  │
                         └───────────┬───────────┘
                                     │
              ┌──────────────────────┤──────────────────────┐
              │                      │                      │
     ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
     │ Document Row 1  │   │ Document Row 2  │   │ Document Row N  │
     │ (collapsed)     │   │ (collapsed)     │   │ (collapsed)     │
     └────────┬────────┘   └─────────────────┘   └─────────────────┘
              │ click expand
     ┌────────▼────────────────────┐
     │ Fetch chunks for doc        │  GET /indexes/:id/documents/:docId/chunks
     │ (lazy-load on expand)       │  (already exists)
     └────────┬────────────────────┘
              │
     ┌────────▼────────┐
     │ Render inline:  │
     │ Stats + Distrib │
     │ + Chunk list    │
     └─────────────────┘


  Search Flow:
     ┌─────────────────────────┐
     │ User types search query │
     └───────────┬─────────────┘
                 │ debounce 300ms
     ┌───────────▼───────────────────┐
     │ Fetch matching chunks         │  GET /indexes/:id/chunks?search=X
     │ (flat list with documentId)   │  (already exists)
     └───────────┬───────────────────┘
                 │
     ┌───────────▼───────────────────┐
     │ Client-side: group by         │
     │ documentId, count matches     │
     │ per document                  │
     └───────────┬───────────────────┘
                 │
     ┌───────────▼───────────────────┐
     │ Auto-expand first doc         │
     │ Auto-expand first match chunk │
     │ Highlight all matches         │
     └──────────────────────────────┘
```

**No new backend endpoints needed** — all existing APIs are sufficient:

- `GET /indexes/:id/documents` — document list for the grouped view
- `GET /indexes/:id/documents/:docId/chunks` — chunks per document on expand
- `GET /indexes/:id/chunks?search=X` — global chunk search for the search flow

---

## Component Architecture

```
ChunksGroupedView (new — replaces ChunksTable)
├── StatsBar (total chunks, status counts — reuse existing)
├── SearchBar + StatusFilterChips (reuse existing)
├── DocumentAccordion (new)
│   ├── DocumentRow (collapsed: name, chunkCount, tokens, status)
│   └── DocumentExpandedContent (on expand)
│       ├── ChunkStatsBar (4-card: total/avg/min/max — from ChunkExplorer)
│       ├── TokenDistributionBar (heatmap — from ChunkExplorer)
│       └── ChunkFlowList (connector line + cards — from ChunkExplorer)
│           └── ChunkFlowCard (expandable — from ChunkExplorer)
│               ├── Content preview (with HighlightedText)
│               └── Expanded: full content + metadata + copy
└── HiddenDocsSummary (during search: "N docs hidden")
```

**Reused from existing ChunkExplorer:**

- `ChunkFlowCard` — chunk card with expand/collapse, copy, metadata
- `HighlightedText` — search term highlighting
- `MetadataSection` — collapsible metadata viewer
- Stats computation (total, avg, min, max tokens)
- Token distribution heatmap bar

---

## Decisions (PM + UX Finalized)

> Full rationale: `docs/wireframes/chunks-grouped-redesign-decisions.md`

| #   | Question                             | Decision                                                                                                                                             |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multiple expand or single accordion? | **Multiple expand** — users compare chunks across docs. Uses Radix `type="multiple"`.                                                                |
| 2   | Large documents (200+ chunks)        | **Show first 20 + "Show 50 more (N remaining)"** button. During search: show ALL matching chunks regardless of cap.                                  |
| 3   | Token distribution bar               | **Keep but collapsed by default** behind "Show distribution" toggle. Hidden entirely for 1-chunk docs. Stats cards always visible.                   |
| 4   | Sort default                         | **Newest first** with sort dropdown (Newest, Oldest, Most Chunks, Name A-Z). During search: sort by match relevance.                                 |
| 5   | Collapsed row data                   | **Add file type icon, remove date**. Layout: `▸ 📄 name.pdf  3 chunks  952 tok  ● indexed`. Mixed statuses show "worst" (error > pending > indexed). |

### Additional UX Decisions

- **Animations**: Framer Motion height:auto for expand, AnimatePresence for search filter fade-out
- **Keyboard**: Radix Accordion primitives (Tab, Enter/Space, Escape) + ArrowUp/Down within chunks
- **Empty state**: "No chunks yet" with EmptyState component; "No matches" with clear-search button
- **Error handling**: Inline retry within expanded section (not toast) for chunk load failures
- **Responsive**: Hide token count below 768px; stats cards 2-col below 640px
- **Performance**: Initial render = document rows only (5-50 items). Chunks lazy-loaded per document via SWR. No backend changes.
