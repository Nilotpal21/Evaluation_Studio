# KB UX Enhancement — Gap Tracker

**Last updated:** 2026-03-20
**Branch:** develop
**Wireframes:** `docs/design/UX-KB-ENHANCED-WIREFRAMES.md`
**HTML Mockup:** `docs/design/mockups/kb-ux-mockup.html`

---

## Gap Status Board

| #   | Gap                                         | Sev  | Effort | Phase | Status   | Notes                                                     |
| --- | ------------------------------------------- | ---- | ------ | ----- | -------- | --------------------------------------------------------- |
| G3  | ActivityFeed "View" button for null targets | Bug  | XS     | 1     | DONE     | Button hidden when targetSection is null                  |
| G4  | ActivityFeed no sub-section navigation      | UX   | S      | 1     | DONE     | targetSubSection in ACTION_REGISTRY + setTabAndSubSection |
| G9  | ConnectorsTab sends 'file' not 'manual'     | Bug  | XS     | 1     | DONE     | sourceType normalized in ConnectorsTab                    |
| G1  | Header metrics not clickable                | Low  | XS     | 2     | DONE     | KBHeader metrics are clickable buttons with navigation    |
| G2  | Home stat cards not clickable               | Low  | XS     | 2     | DONE     | OperationsDashboard StatCards navigate to Data tab        |
| G17 | Document status counts not clickable        | Med  | XS     | 2     | DONE     | Status counts navigate with filter context                |
| G25 | WCAG/a11y on new interactive elements       | High | S      | 2     | DONE     | aria-labels, role, aria-pressed, focus-visible across all |
| G5  | ProgressView zero action links              | UX   | S      | 3     | DONE     | Action links navigate to relevant sections                |
| G8  | No cross-tab filter context                 | UX   | S      | 4     | DONE     | useDataTabFilterStore (setPendingFilter → consumeFilter)  |
| G7  | ChunkExplorer not reachable from viewer     | Med  | S      | 5     | DONE     | "Explore Chunks" button in CrawledPageViewer              |
| G26 | File upload per-file retry                  | Low  | S      | 6     | DONE     | Per-file retry button in FileUploadDialog                 |
| G6  | No source management in Data tab            | High | M      | 7     | DONE     | SourcesTable with delete, upload, view docs actions       |
| G10 | Non-enterprise sources no detail panel      | Med  | M      | 7     | DONE     | SourceDetailPanel for non-enterprise sources              |
| G15 | Sources config view lost in redesign        | High | M      | 7     | DONE     | 3-way SegmentedControl: Documents / Chunks / Sources      |
| G14 | No "All Chunks" view                        | High | L      | 8–9   | DONE     | Backend route + ChunksTable with filter/search/pagination |
| G13 | CrawlerTab unreachable                      | High | —      | —     | DEFERRED | Pending crawler feature scope decision                    |

**Legend:** TODO → IN PROGRESS → REVIEW → DONE → VERIFIED

---

## Phase Execution Tracker

### Phase 1: Bug Fixes (G3, G4, G9) — DONE

| Step     | Description                                                    | File(s)             | Status |
| -------- | -------------------------------------------------------------- | ------------------- | ------ |
| 1a       | G3+G4: Hide button for null targets, add `setTabAndSubSection` | `ActivityFeed.tsx`  | DONE   |
| 1b       | G4: Add `targetSubSection` to ACTION_REGISTRY entries          | `ActivityFeed.tsx`  | DONE   |
| 1c       | G9: Map `'file'` → `'manual'` in ConnectorsTab addSource call  | `ConnectorsTab.tsx` | DONE   |
| 1-review | Build check + visual verification                              | —                   | DONE   |

### Phase 2: Clickable Metrics (G1, G2, G17, G25) — DONE

| Step     | Description                                                            | File(s)                   | Status |
| -------- | ---------------------------------------------------------------------- | ------------------------- | ------ |
| 2a       | Add `onNavigate` prop to KBHeader, make metrics `<button>`             | `KBHeader.tsx`            | DONE   |
| 2b       | Pass `onNavigate` to KBHeader from KBDetailLayout                      | `KBDetailLayout.tsx`      | DONE   |
| 2c       | Add `onNavigate` prop to OperationsDashboard, make StatCards clickable | `OperationsDashboard.tsx` | DONE   |
| 2d       | Make document status counts clickable                                  | `OperationsDashboard.tsx` | DONE   |
| 2e       | Pass `onNavigate` to OperationsDashboard from HomeSection              | `HomeSection.tsx`         | DONE   |
| 2f       | Add aria-labels, focus-visible rings, keyboard handlers                | All above                 | DONE   |
| 2g       | Add i18n keys for aria labels                                          | `studio.json`             | DONE   |
| 2-review | Build check + visual verification + keyboard nav test                  | —                         | DONE   |

### Phase 3: ProgressView Actions (G5) — DONE

| Step     | Description                                             | File(s)            | Status |
| -------- | ------------------------------------------------------- | ------------------ | ------ |
| 3a       | Add `onNavigate` prop to ProgressView, add action links | `ProgressView.tsx` | DONE   |
| 3b       | Pass `onNavigate` to ProgressView from HomeSection      | `HomeSection.tsx`  | DONE   |
| 3c       | Add i18n keys for action labels                         | `studio.json`      | DONE   |
| 3-review | Build check + visual verification                       | —                  | DONE   |

### Phase 4: Filter Context Store (G8) — DONE

| Step     | Description                                                  | File(s)                          | Status |
| -------- | ------------------------------------------------------------ | -------------------------------- | ------ |
| 4a       | Create `useDataTabFilterStore` Zustand store                 | `data-tab-filter-store.ts` (NEW) | DONE   |
| 4b       | Wire `setPendingFilter` in NeedsAttentionCard                | `NeedsAttentionCard.tsx`         | DONE   |
| 4c       | Wire `setPendingFilter` in OperationsDashboard status counts | `OperationsDashboard.tsx`        | DONE   |
| 4d       | Wire `setPendingFilter` in ProgressView error links          | `ProgressView.tsx`               | DONE   |
| 4e       | Wire `consumeFilter` in DataSection on mount                 | `DataSection.tsx`                | DONE   |
| 4-review | Build check + cross-tab navigation test                      | —                                | DONE   |

### Phase 5: ChunkExplorer Access (G7) — DONE

| Step     | Description                                    | File(s)                 | Status |
| -------- | ---------------------------------------------- | ----------------------- | ------ |
| 5a       | Import ChunkExplorerDialog, add state + button | `CrawledPageViewer.tsx` | DONE   |
| 5b       | Add i18n key for "Explore Chunks"              | `studio.json`           | DONE   |
| 5-review | Build check + visual verification              | —                       | DONE   |

### Phase 6: File Upload Retry (G26) — DONE

| Step     | Description                                             | File(s)                | Status |
| -------- | ------------------------------------------------------- | ---------------------- | ------ |
| 6a       | Add retry button per failed file, add `handleRetryFile` | `FileUploadDialog.tsx` | DONE   |
| 6b       | Add i18n key for retry label                            | `studio.json`          | DONE   |
| 6-review | Build check + upload failure test                       | —                      | DONE   |

### Phase 7: Sources Configuration (G6, G10, G15) — DONE

| Step     | Description                                                  | File(s)                       | Status |
| -------- | ------------------------------------------------------------ | ----------------------------- | ------ |
| 7a       | Add `fetchSourceSummary` client function                     | `search-ai.ts`                | DONE   |
| 7b       | Create SourcesTable component                                | `SourcesTable.tsx` (NEW)      | DONE   |
| 7c       | Create SourceDetailPanel component                           | `SourceDetailPanel.tsx` (NEW) | DONE   |
| 7d       | Add 3-way SegmentedControl to DataSection                    | `DataSection.tsx`             | DONE   |
| 7e       | Add i18n keys for sources view                               | `studio.json`                 | DONE   |
| 7-review | Build check + all source type verification + security review | —                             | DONE   |

### Phase 8–9: All Chunks View (G14) — DONE (backend Phase 8 + frontend Phase 9)

| Step     | Description                                                      | File(s)                 | Status |
| -------- | ---------------------------------------------------------------- | ----------------------- | ------ |
| 8a       | Add `GET /:indexId/chunks` backend route with security hardening | `chunks.ts` (backend)   | DONE   |
| 8b       | Add `fetchAllChunks` client function                             | `search-ai.ts`          | DONE   |
| 8c       | Extend `SearchAIChunk` with `documentId`, `documentTitle`        | `search-ai.ts`          | DONE   |
| 8d       | ChunkFilterBar integrated into ChunksTable (inline)              | `ChunksTable.tsx` (NEW) | DONE   |
| 8e       | Create ChunksTable component with filter/search/pagination       | `ChunksTable.tsx` (NEW) | DONE   |
| 8f       | Wire ChunksTable into DataSection SegmentedControl               | `DataSection.tsx`       | DONE   |
| 8g       | Add i18n keys for chunks view                                    | `studio.json`           | DONE   |
| 8-review | Build + security review (sort injection, ReDoS, negative inputs) | —                       | DONE   |

### Deferred

| Step | Description                                                     | Status   |
| ---- | --------------------------------------------------------------- | -------- |
| G13  | CrawlerTab unreachable — pending crawler feature scope decision | DEFERRED |

---

## Review Checkpoints

After each phase, verify:

1. `pnpm build --filter=@agent-platform/studio` passes (type check)
2. `pnpm build --filter=@agent-platform/search-ai` passes (if backend changed)
3. `npx prettier --write` on all changed files
4. Visual inspection in browser
5. Keyboard navigation works (Tab, Enter, Escape)
6. No console errors/warnings
7. i18n keys exist for all new user-facing strings

---

## Completion Summary (2026-03-20)

**15 of 16 gaps resolved** (G13 deferred — crawler scope TBD).

### Security Hardening Applied

- Sort field allowlist (`ALLOWED_SORT_FIELDS`) prevents MongoDB injection
- `escapeRegex()` prevents ReDoS via user search input
- `Math.max(0, ...)` guards on offset/limit prevent negative value abuse
- Connection string credential masking in SourceDetailPanel
- 2-step inline delete confirmation in SourcesTable

### Cross-Cutting Review Findings Fixed

- Debounce memory leak (useState → useRef + cleanup)
- State not reset on indexId change (ChunksTable)
- NeedsAttentionCard hardcoded statusFilter replaced with action-specific fields
- CrawledPageViewer `any` cast removed (typed API return)
- ActivityFeed non-null assertion removed
- Frontend `limit:0` truthiness bug fixed (`!= null` check)
- hasMore calculation fixed to `offset + chunks.length < total`

### "Why" Questions — Discussion Points for Product Owner

28 items identified across 9 user journeys, organized by priority:

- **HIGH (6)**: statusFilter clear UI, Edit Source, View Documents filter, ConnectorDetailPanel actions, G9 normalization scope, consumeFilter fragility
- **MEDIUM (7)**: ProgressView error actions, stat card destinations, syncing warning fatigue, client-side credential masking, page-local chunk stats, empty KB dashboard, context-blind empty states
- **LOW (10)**: Various UX polish and design considerations
