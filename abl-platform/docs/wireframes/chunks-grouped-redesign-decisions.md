# Chunks Tab Redesign — PM + UX Decisions

Consolidated decisions from Product and UX perspectives, informed by codebase patterns,
enterprise user needs, and existing component library.

---

## Q1: Multiple Expand or Single Accordion?

**Decision: Multiple expand (not single accordion)**

**PM rationale:**

- Enterprise users comparing chunk quality across documents need side-by-side visibility
- The primary use case is "inspect chunks to understand why search results are good/bad" — this
  requires seeing chunks from multiple documents simultaneously
- The Documents tab already allows multi-select; consistency matters
- Single accordion creates unnecessary click friction when reviewing a knowledge base

**UX rationale:**

- The Radix Accordion component (`apps/studio/src/components/ui/shadcn/accordion.tsx`) already
  supports `type="multiple"` natively — no extra work
- The ChunkExplorer flow view inside each expanded section is self-contained with its own
  scroll boundaries, so multiple expanded docs won't cause confusion
- Keyboard: Arrow keys navigate between document rows; Enter toggles expand

**Edge case:**

- If 5+ documents are expanded with 50+ chunks each, the page could get very long. Mitigation:
  each expanded section has its own `max-height` with internal scroll (chunks area only), so the
  document list remains navigable. The stats cards and token distribution bar stay pinned at the
  top of each expanded section.

---

## Q2: Large Documents (200+ Chunks)

**Decision: Show first 20 chunks + "Show more" button (batched loading)**

**PM rationale:**

- A document with 200+ chunks means the user is unlikely to visually scan all of them — they'll
  search instead. Showing 20 chunks gives enough context without overwhelming the page.
- When search is active, ALL matching chunks are shown regardless of the 20-chunk limit (search
  overrides the initial cap)
- "Show more" loads the next 50 (not "Load all 200" at once) to keep performance predictable
- This matches the pagination pattern already used in the flat ChunksTable (PAGE_SIZE = 20)

**UX rationale:**

- Virtual scroll (`apps/studio/src/components/shared/VirtualList.tsx` using `@tanstack/react-virtual`)
  exists in the codebase but adds complexity for variable-height expandable chunk cards. Batched
  loading is simpler and sufficient for this use case.
- The "Show more" button includes a count: "Show 50 more (180 remaining)" — clear information scent
- During search: no cap needed. The search API already limits results and the highlighted matches
  are the user's focus

**Edge case:**

- A 2000-chunk document with "Show more": after 3 clicks (20+50+50+50 = 170), the expanded section
  is long. Mitigation: the internal chunk list area has `max-height: 600px` with `overflow-y: auto`.
  The document header row stays visible above the scroll area.

---

## Q3: Token Distribution Bar

**Decision: Keep it, but make it collapsible (collapsed by default)**

**PM rationale:**

- Token distribution is a differentiating feature — it visually reveals chunking quality issues
  (e.g., one giant chunk + many tiny ones) that are invisible in a text list
- Power users (AI engineers tuning retrieval) rely on this to spot problematic chunking
- But casual users just want to see chunk content — the bar adds 40px of noise for them

**UX rationale:**

- Default: show stats cards (Total/Avg/Min/Max) always; token distribution bar collapsed behind a
  "Show distribution" toggle link
- When the user clicks the toggle, animate the bar in (matching the existing Framer Motion pattern)
- The stats cards provide the same information in numeric form — the bar is a visual supplement,
  not primary content
- This matches the progressive disclosure pattern used in MetadataSection (collapsed by default
  with field count shown)

**Edge case:**

- Documents with 1 chunk: the distribution bar is a single block — not useful. Hide the toggle
  entirely when chunkCount === 1. Just show the stats cards.

---

## Q4: Sort Default

**Decision: By date (newest first), with a sort dropdown for alternatives**

**PM rationale:**

- The most common workflow is "I just uploaded documents, let me check their chunks" — newest first
  surfaces the most relevant documents immediately
- This matches the Documents tab's default sort (newest first) and the Sources tab sort
- Secondary sorts: chunk count descending (for finding problematic large documents), alphabetical
  (for finding a specific document by name)

**UX rationale:**

- Sort dropdown in the filter bar: `Sort: Newest ▾` with options: Newest, Oldest, Most Chunks,
  Name A-Z, Name Z-A
- Compact dropdown — not radio buttons or chips (sort is secondary to search and status filter)
- Sort preference persists per session (useState, not localStorage — it's not critical enough to
  persist across sessions)

**Edge case:**

- When search is active, sort by "relevance" (most matching chunks first) takes priority over the
  user's selected sort. When search is cleared, revert to the user's sort selection.

---

## Q5: Collapsed Row Data

**Decision: Current info is sufficient. Add file type icon. Remove explicit date.**

**Current:** Name, chunk count, total tokens, status badge, date
**New:** File type icon, Name, chunk count, total tokens, status badge

**PM rationale:**

- File type icon (PDF, CSV, DOCX, TXT) gives instant visual scanning without reading text
- The date is less important in the collapsed view — it's available in the expanded section and
  in the Documents tab. Removing it saves horizontal space for longer file names.
- Source name is NOT needed — the user is already scoped to a specific knowledge base, and sources
  are a layer above documents. Adding source here would add noise.

**UX rationale:**

- File type icons use the same MIME → icon mapping already implemented in SourceDetailPanel
  (PDF → FileText, CSV → Sheet, etc.)
- Layout: `▸ 📄 Document_Name.pdf     3 chunks   952 tok   ● indexed`
- On hover, show the full file name in a tooltip (for truncated names)
- The status badge uses the same dot + label pattern from the existing ChunksTable

**Edge case:**

- Documents with mixed chunk statuses (e.g., 3 indexed + 1 error): show the "worst" status as
  the badge (error > pending > embedded > indexed). On expand, the full status breakdown is visible
  in the stats section.

---

## Additional UX Recommendations

### Animation & Transitions

- Document expand: Framer Motion `height: auto` animation (same as ChunkFlowCard in ChunkExplorer)
- Chunk expand: nested animation with staggered delay (existing `STAGGER_DELAY` pattern)
- Search result filter: `AnimatePresence` to fade out non-matching documents smoothly

### Keyboard Navigation

- `Tab` moves between document rows
- `Enter` or `Space` toggles document expand
- `Arrow Down/Up` navigates within chunk list when document is expanded
- `Escape` closes expanded chunk content (not the document)
- These are built into Radix Accordion primitives — use `type="multiple"` with controlled value

### Empty State

- No chunks at all: "No chunks yet. Chunks are created when documents are processed through the
  ingestion pipeline." with an icon (existing `EmptyState` component)
- Search with no matches: "No chunks match '{query}'" with a clear-search action button

### Error State

- Document chunk load fails: show inline error within the expanded section with retry button
  (not a toast — keep the error co-located with the failed action)

### Responsive Behavior

- Below 768px: hide token count column, show only name + chunk count + status
- Stats cards: switch from 4-col grid to 2-col grid below 640px (matching SourceDetailPanel)

### Performance Budget

- Initial render: only document rows (5-50 items) — fast
- Chunk load on expand: one API call per document, cached by SWR
- Search: debounce 300ms, then one API call to chunks endpoint with `search` param
- No changes to backend APIs needed
