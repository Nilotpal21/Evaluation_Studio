# Chunks Tab Grouped Redesign — High-Level Design

## What

Replace the flat ChunksTable (paginated table + popup ChunkExplorerDialog) with a document-grouped accordion view. Documents appear as collapsible rows; expanding a document shows its chunks inline using the existing ChunkExplorer flow-view pattern. Each expanded document section includes a per-document chunk search bar. Global search across all documents and status filters remain at the top level.

## Architecture Approach

### Packages Changed

- `apps/studio` — new component, update DataSection wiring, i18n keys
- `packages/i18n` — new translation keys for the grouped view

### Data Flow

```
DataSection
  └─ ChunksGroupedView (NEW — replaces ChunksTable when activeView === 'chunks')
       ├─ Global search bar + status chips + sort dropdown
       ├─ fetchDocuments(indexId) → document list
       └─ Per document accordion row:
            ├─ Document header: icon, name, chunkCount, totalTokens, status badge
            └─ Expanded section (lazy loaded on expand):
                 ├─ Stats cards (Total/Avg/Min/Max tokens)
                 ├─ Token distribution bar (collapsible)
                 ├─ Per-document search bar
                 └─ ChunkFlowCards (reuse pattern from ChunkExplorer)
                      └─ fetchChunks(indexId, docId) via SWR
```

### Key Integration Points

- **DataSection.tsx** (line 257): Replace `<ChunksTable indexId={indexId} />` with `<ChunksGroupedView indexId={indexId} />`
- **API**: Uses existing `fetchDocuments` + `fetchChunks` — NO backend changes
- **Components reused**: Badge, Input, EmptyState, Skeleton from ui/; HighlightedText & MetadataSection patterns from ChunkExplorer (will extract or duplicate the pure functions)
- **Accordion**: Radix `type="multiple"` for multi-expand

## Decisions & Tradeoffs

- **Chose custom accordion over Radix Accordion component**: The shadcn Accordion has built-in styles (underline hover, specific padding) that don't match our card-based design. Building with native div + state is simpler and gives full control over animations.
- **Chose lazy chunk loading per document over preloading all**: SWR-cached `fetchChunks` on expand keeps initial render fast (only document list). Each doc's chunks are cached after first load.
- **Chose batched loading (20 initial + 50 more) over virtual scroll**: For variable-height expandable chunk cards, VirtualList adds complexity. Batched loading is simpler and sufficient per PM decision.
- **Kept ChunkExplorer patterns inline (not imported)**: ChunkExplorer is tightly coupled to its Dialog wrapper. We'll replicate the flow-card pattern (HighlightedText, stats, token bar) rather than refactoring ChunkExplorer for reuse — less risk of breaking existing popup usage.

## Task Decomposition

| Task                                    | Package(s) | Independent?  | Est. Files |
| --------------------------------------- | ---------- | ------------- | ---------- |
| T-1: Create ChunksGroupedView component | studio     | Yes           | 1-2        |
| T-2: Add i18n keys                      | i18n       | Yes           | 1          |
| T-3: Wire into DataSection              | studio     | No (T-1, T-2) | 1          |

## Out of Scope

- Backend API changes — all needed endpoints exist
- ChunkExplorer refactoring — existing popup remains unchanged
- Virtual scrolling — batched loading is sufficient
- Keyboard navigation — will use native focus management, not custom key handlers
