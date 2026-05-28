# LLD: Crawler UX Objectives (O1–O8 + Multi-User)

**Feature Spec**: `docs/features/web-crawling.md`
**HLD**: `docs/specs/web-crawling.hld.md`
**Design Doc**: `docs/searchai/design/CRAWLER-UX-OBJECTIVES-IMPL-PLAN.md`
**Prior LLDs**: Phase 2b (`docs/plans/2026-04-27-crawler-ux-phase2b-impl-plan.md`), Phase 3 (`docs/plans/2026-04-27-crawler-ux-phase3-impl-plan.md`)
**Status**: APPROVED
**Date**: 2026-05-01

---

## 0. Constraints

1. **No new libraries** — use existing npm packages already in the monorepo. Exception: `robots-parser` for O8 (widely used, MIT, no existing alternative).
2. **No new paths** — all utilities go into existing files (`tree-utils.ts`, `coverage-utils.ts`, `url-set.ts`). No new `utils/` or `lib/` directories.
3. **Build on existing flows** — extend existing components, props, state. No parallel implementations.
4. **Only 3 truly new component files**: `DiscoveryActivityBar.tsx`, `BatchPreviewPanel.tsx`, `discovery-store.ts` (Zustand store — required because activity bar and CrawlFlowPanel are in separate component trees).
5. **All other "new" components** inline into existing files or are small enough to be part of an existing component.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                          | Rationale                                                                                                                                   | Alternatives Rejected                               |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| D-1  | Add `computeSubtreeCounts` to existing `tree-utils.ts`            | Fits alongside `walkTree`, `countNodes`, `flattenTree` — same pure-function pattern                                                         | New file `subtree-utils.ts` (unnecessary split)     |
| D-2  | Zustand store for backgrounded discovery tracking                 | Activity bar (`KBDetailLayout`) and CrawlFlowPanel (`AddSourceButton`) are in separate component trees — prop-drilling is impossible        | Context API (heavier), Redux (not used in codebase) |
| D-3  | `LiveSubStatus` inlines into `DiscoveryTimeline.tsx`              | < 40 lines of JSX, no reuse case                                                                                                            | Separate file (file bloat for 40 lines)             |
| D-4  | `RobotsTxtCard` inlines into `State3Configure.tsx`                | < 60 lines, only used once, extends existing configure UI                                                                                   | Separate file                                       |
| D-5  | `FileTypeSelector` inlines into `State2Analysis.tsx`              | < 50 lines, renders below section checklist, only used once                                                                                 | Separate file                                       |
| D-6  | `CrawlCompletionSummary` inlines into `State4Crawl.tsx`           | < 80 lines, renders after crawl completes, only used once                                                                                   | Separate file                                       |
| D-7  | `PipelinePhase` type consolidated into `types.ts`                 | Currently duplicated in `DiscoveryTimeline.tsx:49` and `State2Analysis.tsx:110`                                                             | Leave duplicated (drift risk)                       |
| D-8  | `robots-parser` npm package for O8                                | 1M+ weekly downloads, MIT, handles all edge cases                                                                                           | Custom parser (reimplements solved problem)         |
| D-9  | `discoveryStatus` field added to CrawlDraft Mongoose model        | Activity bar needs to query MongoDB after page refresh — in-memory state alone is insufficient                                              | In-memory only (lost on refresh)                    |
| D-10 | Preparatory refactor of State2Analysis before feature work        | 1,706 lines — per CLAUDE.md "never rewrite >200 lines in one pass". Extract section list (~200 lines) into `SectionChecklist` sub-component | Add features directly to 1,706-line file            |
| D-11 | `pickPreviewUrls` goes into existing `coverage-utils.ts`          | Preview URL selection is a coverage/sampling concern                                                                                        | New file                                            |
| D-12 | `normalizePattern` and `isSubsetOf` go into existing `url-set.ts` | Pattern normalization is URL manipulation — fits with `normalizeDiscoveryUrl`                                                               | New file or tree-utils                              |
| D-13 | Section merge/dedup logic goes into existing `scope-utils.ts`     | Scope management already handles included/excluded prefixes                                                                                 | New file                                            |

### Key Interfaces & Types

All new types go into `apps/studio/src/components/search-ai/crawl-flow/types.ts`:

```typescript
// Consolidate duplicated PipelinePhase
export type PipelinePhase = 'idle' | 'browser-running' | 'http-running' | 'complete';

// O1: Live progress forwarded from DiscoveryPanel → DiscoveryTimeline
export interface LiveProgressStats {
  currentUrl?: string;
  pagesVisited: number;
  pageBudget: number;
  discoveryRate: number;
  discoveryTrend: 'productive' | 'declining' | 'stalled';
  hubCount: number;
  leafCount: number;
  skippedCount: number;
}

// O7: File type tracking during discovery
export interface FileTypeCount {
  extension: string;
  label: string;
  count: number;
  processingMethod: 'docling' | 'table-extract' | 'skip';
  included: boolean;
}

// O8: robots.txt analysis result
export interface RobotsTxtAnalysis {
  found: boolean;
  crawlDelay?: number;
  disallowedPaths: string[];
  allowedPaths: string[];
  sitemapUrls: string[];
  affectedSections: string[];
}

// Extend existing TimelineEntry (DiscoveryTimeline.tsx:64-75)
// Add to existing interface, not a new interface:
//   subStatus?: string;
//   progress?: { current: number; total: number };
//   discoveryRate?: number;
//   healthIndicators?: Array<{ label: string; value: number; variant: string }>;

// Extend existing CrawlSection (types.ts:13-28)
// Add to existing interface:
//   fileTypeCounts?: Record<string, number>;

// Extend existing CrawlConfig (types.ts:98-110)
// No changes — requestDelay, respectRobotsTxt already exist

// Discovery store state (for discovery-store.ts)
export interface BackgroundedDiscovery {
  draftId: string;
  domain: string;
  discoveredCount: number;
  sectionCount: number;
  status: 'running' | 'complete' | 'stopped';
  ownerName: string;
  ownerId: string;
  type: 'discovery' | 'crawl';
  jobId?: string; // for crawl items
  crawlProgress?: { crawled: number; total: number; failed: number };
}
```

### Module Boundaries

| Module                           | Responsibility                                               | Depends On                        |
| -------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `discovery-store.ts` (NEW)       | Track backgrounded discoveries/crawls across component trees | Zustand (already in monorepo)     |
| `DiscoveryActivityBar.tsx` (NEW) | Render KB-level activity bar, poll draft API                 | `discovery-store.ts`, crawl API   |
| `BatchPreviewPanel.tsx` (NEW)    | Multi-page extraction preview                                | Existing `previewExtraction` API  |
| `tree-utils.ts` (EXTEND)         | Add `computeSubtreeCounts`                                   | Existing `DiscoveryTreeNode` type |
| `url-set.ts` (EXTEND)            | Add `normalizePattern`, `isSubsetOf`                         | None                              |
| `scope-utils.ts` (EXTEND)        | Add `mergeSections`                                          | `normalizePattern` from url-set   |
| `coverage-utils.ts` (EXTEND)     | Add `pickPreviewUrls`                                        | Existing `CrawlSection` type      |

---

## 2. File-Level Change Map

### New Files (3 only)

| File                                                                       | Purpose                                              | LOC Est |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ------- |
| `apps/studio/src/store/discovery-store.ts`                                 | Zustand store: backgrounded discovery/crawl tracking | ~80     |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryActivityBar.tsx` | KB-level activity bar between nav and content        | ~180    |
| `apps/studio/src/components/search-ai/crawl-flow/BatchPreviewPanel.tsx`    | Multi-page extraction preview for Step 3             | ~150    |

### Modified Files

| File                                                      | Change Description                                                                                                                                    | Phase | Risk |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| `types.ts` (722 lines)                                    | Add `PipelinePhase`, `LiveProgressStats`, `FileTypeCount`, `RobotsTxtAnalysis`, `BackgroundedDiscovery`. Extend `CrawlSection` with `fileTypeCounts`. | 1-4   | Low  |
| `discovery/tree-utils.ts` (521 lines)                     | Add `computeSubtreeCounts` (~25 lines)                                                                                                                | 1     | Low  |
| `discovery/url-set.ts`                                    | Add `normalizePattern`, `isSubsetOf` (~20 lines)                                                                                                      | 2     | Low  |
| `discovery/scope-utils.ts`                                | Add `mergeSections` (~20 lines)                                                                                                                       | 2     | Low  |
| `discovery/coverage-utils.ts`                             | Add `pickPreviewUrls` (~20 lines)                                                                                                                     | 3     | Low  |
| `DiscoveryTimeline.tsx` (278 lines)                       | Add `liveProgress` prop, inline LiveSubStatus rendering, import `PipelinePhase` from types.ts                                                         | 1     | Low  |
| `DiscoveryPanel.tsx` (891 lines)                          | Add `treeStats` memo, `onLiveStats` callback, `onSectionsAutoAdded` prop, file type tracking ref                                                      | 1-2   | Med  |
| `BrowserDiscoveryInline.tsx` (574 lines)                  | Forward `onLiveStats`, `onSectionsAutoAdded` props                                                                                                    | 1-2   | Low  |
| `DiscoveryTree.tsx` (720 lines)                           | Use subtree counts, add `[+]` button, inline per-node action buttons                                                                                  | 1-2   | Med  |
| `State2Analysis.tsx` (1706 lines)                         | `isMinimized` state, collapse/expand toggle, section source badges, grand total, inline FileTypeSelector                                              | 1-2,4 | High |
| `CrawlFlowV5.tsx` (945 lines)                             | Section merge handler, section mapping in batch submit                                                                                                | 2-3   | Med  |
| `AddSourceButton.tsx` (552 lines)                         | Close confirmation dialog when discovery running                                                                                                      | 2     | Med  |
| `KBDetailLayout.tsx` (201 lines)                          | 1 conditional render line for `<DiscoveryActivityBar />`                                                                                              | 2     | Low  |
| `State3Configure.tsx` (563 lines)                         | Integrate `BatchPreviewPanel`, inline `RobotsTxtCard`, crawl speed slider                                                                             | 3-4   | Med  |
| `State4Crawl.tsx` (518 lines)                             | Inline completion summary card, minimize-to-bar handler                                                                                               | 3     | Med  |
| `apps/search-ai/src/routes/crawl.ts` (2876 lines)         | Accept `sectionMapping` in batch endpoint, `/robots` route handler                                                                                    | 3-4   | Med  |
| `apps/search-ai/src/services/crawler/robots-analyzer.ts`  | New: `analyzeRobotsTxt` wrapper around `robots-parser`                                                                                                | 4     | Low  |
| `apps/search-ai/src/routes/crawl-discover.ts` (518 lines) | Stop dropping file URLs, add `fileType` to SSE events                                                                                                 | 4     | Med  |
| `apps/search-ai/src/routes/crawl-drafts.ts`               | Add `discoveryStatus` field, `GET /drafts/active` endpoint, duplicate domain check endpoint                                                           | 2     | Med  |
| `packages/database/src/models/crawl-draft.model.ts`       | Add `discoveryStatus` enum field to schema                                                                                                            | 2     | Low  |
| `apps/studio/src/api/crawl.ts`                            | Add `analyzeRobotsTxt` client function, `getActiveDrafts`, `getDraftStatus`                                                                           | 2,4   | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Preparatory Refactor (~0.5 day)

**Goal**: Extract the section checklist from State2Analysis.tsx to reduce file size before adding features.

**Tasks**:
0.1. Extract section list rendering (~200 lines at State2Analysis.tsx ~1400-1600) into inline sub-component `SectionChecklist` within the same file (no new file — just a function component defined above the main export).
0.2. Consolidate `PipelinePhase` type: export from `types.ts`, import in `DiscoveryTimeline.tsx` and `State2Analysis.tsx` (remove local definitions).

**Files Touched**:

- `types.ts` — add `PipelinePhase` export
- `State2Analysis.tsx` — extract SectionChecklist, import PipelinePhase
- `DiscoveryTimeline.tsx` — import PipelinePhase from types

**Exit Criteria**:

- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] State2Analysis.tsx main component body reduced by ~200 lines
- [ ] `PipelinePhase` is defined in exactly 1 place (types.ts)
- [ ] No behavior change — UI renders identically

**Test Strategy**:

- Manual: verify crawl flow renders identically in all states
- Automated: existing crawl-flow tests still pass (if any)

**Rollback**: Revert the refactor commit.

---

### Phase 1: Foundation — O3 Recursive Counts + O1 Live Transparency (~2.5 days)

**Goal**: Tree nodes show recursive page counts with time estimates. Timeline shows live visiting URL, yield rate, and health indicators.

**Tasks**:

1.1. **Add `computeSubtreeCounts` to `tree-utils.ts`** (~25 lines)

- Post-order traversal: node count = 1 (if not skipped) + sum(children counts)
- Returns `Map<string, number>` for O(1) lookup
- Memoize in `DiscoveryTree.tsx` via `useMemo` on `nodes`

  1.2. **Wire subtree counts into `DiscoveryTree.tsx`**

- Replace `linkCount` display (~line 303-305) with recursive count + time estimate
- Show: `142 pages · ~45m` instead of `(42)`
- Only show for nodes with subtreeCount > 1

  1.3. **Add `LiveProgressStats` type to `types.ts`**

- Interface with `currentUrl`, `pagesVisited`, `pageBudget`, `discoveryRate`, `discoveryTrend`, `hubCount`, `leafCount`, `skippedCount`

  1.4. **Add `treeStats` memo to `DiscoveryPanel.tsx`**

- Use existing `walkTree` to compute hub/leaf/skipped counts from `treeNodes`
- Add `onLiveStats` callback prop to `DiscoveryPanelProps`
- Call `onLiveStats` when progress or treeStats change

  1.5. **Forward `onLiveStats` through `BrowserDiscoveryInline.tsx`**

- Add `onLiveStats` to `BrowserDiscoveryInlineProps` (or use existing pattern — check types.ts)
- Forward from `State2Analysis` → `BrowserDiscoveryInline` → `DiscoveryPanel`

  1.6. **Enhance `DiscoveryTimeline.tsx` with live data**

- Add `liveProgress?: LiveProgressStats` to `DiscoveryTimelineProps`
- Extend `TimelineEntry` interface with `subStatus`, `progress`, `discoveryRate`, `healthIndicators`
- Inline `LiveSubStatus` rendering: compact path, mini progress bar, rate badge, health chips
- Rate badge: green when productive, amber when declining, red when stalled

  1.7. **Wire in `State2Analysis.tsx`**

- Add `liveProgress` state: `useState<LiveProgressStats | null>(null)`
- Pass `onLiveStats` callback to `BrowserDiscoveryInline`
- Pass `liveProgress` to `DiscoveryTimeline`

  1.8. **Section cards show recursive counts**

- When sections created from tree (auto-add or manual), use subtree count not cluster count
- Add time estimate range display: "30–50 min" for sections > 10 pages

**Files Touched**:

- `discovery/tree-utils.ts` — add `computeSubtreeCounts`
- `types.ts` — add `LiveProgressStats`, extend `TimelineEntry` fields
- `DiscoveryTree.tsx` — use subtree counts in `TreeNodeRow`
- `DiscoveryPanel.tsx` — add `treeStats` memo, `onLiveStats` callback
- `BrowserDiscoveryInline.tsx` — forward `onLiveStats`
- `DiscoveryTimeline.tsx` — add `liveProgress` prop, inline sub-status rendering
- `State2Analysis.tsx` — add `liveProgress` state, wire callbacks

**Exit Criteria**:

- [ ] Tree nodes display recursive counts (e.g., "142 pages · ~45m") instead of linkCount
- [ ] DiscoveryTimeline shows live visiting URL during browser discovery
- [ ] Discovery rate badge changes color based on trend (productive/declining/stalled)
- [ ] Health chips show hub/leaf/skipped counts
- [ ] `pnpm build --filter=apps/studio` succeeds with 0 errors
- [ ] No SSE/API changes required — all data from existing `BrowserExploreProgress`

**Test Strategy**:

- Unit: `computeSubtreeCounts` pure function tests in `tree-utils.test.ts`
  - Empty tree → empty map
  - Single node → count 1
  - Nested tree → parent count = sum of children + 1
  - Skipped nodes → count 0
  - 10K nodes → < 10ms performance assertion
- Integration: Manual verify live stats flow from SSE → DiscoveryPanel → Timeline
- E2E: Start browser discovery on a test site, verify tree shows recursive counts

**Rollback**: Revert Phase 1 commits; tree reverts to linkCount display.

---

### Phase 2: Core UX — O2 Auto-Sections + O4 Backgrounding + Multi-User (~5 days)

**Goal**: Discovery auto-creates sections from tree. Panel collapses inline. Activity bar tracks N discoveries. Multi-user visibility with duplicate domain prevention.

**Tasks**:

2.1. **Add `normalizePattern` and `isSubsetOf` to `url-set.ts`** (~20 lines)

- Lowercase, strip leading/trailing slashes
- isSubsetOf: child starts with parent + '/'

  2.2. **Add `mergeSections` to `scope-utils.ts`** (~20 lines)

- Deduplicate by normalized pattern
- Allow subset sections (user might want `/support/printers` but not all `/support`)

  2.3. **Wire auto-section creation in `DiscoveryPanel.tsx`**

- In the existing auto-add block (~line 348-364), create actual `CrawlSection` objects
- Add `onSectionsAutoAdded` callback prop
- Forward through BrowserDiscoveryInline → State2Analysis → CrawlFlowV5.handleSectionsChange

  2.4. **Add `[+]` button to `DiscoveryTree.tsx` hub nodes**

- On hover, show Plus icon for hub nodes with children > 0 and subtreeCount > 5
- Add `onAddAsSection` prop to `DiscoveryTreeProps`
- Tooltip: "Add as section" (via title attribute)

  2.5. **Add inline per-node action buttons to `DiscoveryTree.tsx`**

- Hover shows Explore (compass) and Skip (X) icons per node
- Use existing `onExplore`, `onSkip` callbacks — no new props needed

  2.6. **Section card enhancements in `State2Analysis.tsx`**

- Source badge: `[sitemap]` / `[explored]` / `[auto]` per section
- "Selected X / Available Y" counter at section list header
- Grand total row at bottom

  2.7. **Add `discoveryStatus` to CrawlDraft model**

- Add to `ICrawlDraft` TypeScript interface: `discoveryStatus?: 'idle' | 'running' | 'complete' | 'stopped'`
- Schema field: `discoveryStatus: { type: String, enum: ['idle', 'running', 'complete', 'stopped'], default: 'idle' }`
- Add to `updateDraftSchema` Zod object: `discoveryStatus: z.enum(['idle', 'running', 'complete', 'stopped']).optional()`
- Add compound index: `{ tenantId: 1, indexId: 1, discoveryStatus: 1, updatedAt: -1 }`
- Set on discovery start/stop/complete events
- Add staleness check: if `discoveryStatus === 'running'` and `updatedAt < 30min ago`, treat as stale (pod may have crashed)

  2.7b. **Add `'auto'` to section source enum (cascading change)**

- `ICrawlDraftSection.source` type: add `'auto'` → `'sitemap' | 'explored' | 'auto'`
- Mongoose `sectionSchema.source` enum: add `'auto'` → `['sitemap', 'explored', 'auto']`
- Zod `sectionSchema.source` in route validation: add `'auto'` → `z.enum(['sitemap', 'explored', 'auto'])`
- Zod `sectionSchema.source` in `apps/search-ai/src/routes/crawl-drafts.ts:37` (updateDraftSchema): add `'auto'`
- Frontend `CrawlSection.source` type in `types.ts`: add `'auto'`
- Studio API client `CrawlDraftSection.source` at `apps/studio/src/api/crawl.ts:1035`: add `'auto'`
- All 6 changes in same commit — atomic update

  2.8. **Add `GET /drafts/active` endpoint to `crawl-drafts.ts`**

- **CRITICAL: Register BEFORE `GET /drafts/:draftId`** — insert between existing `GET /drafts` (line ~278) and `GET /drafts/:draftId` (line ~282). `GET /drafts/check-domain` goes here too.
- Zod query validation: `z.object({ indexId: z.string().min(1) })`
- Query: `CrawlDraft.find({ tenantId, indexId, discoveryStatus: { $in: ['running', 'complete'] }, updatedAt: { $gt: oneHourAgo } })`
- Projection: `.select('_id url discoveryStatus createdBy updatedAt sections')` — never return `discoveryState` (up to 5MB)
- Return: `{ success: true, data: [{ draftId, domain, discoveredCount, sectionCount, discoveryStatus, createdBy, createdByName }] }`
- Cross-user visibility (not filtered by createdBy) — this is a **read-only** view endpoint
- **Cross-user access model**: [Resume] for own drafts uses full `GET /drafts/:draftId` (filtered by `createdBy`). For other users' drafts, [View] uses only the lightweight `GET /drafts/:id/status` endpoint (read-only, no `createdBy` filter). Only the draft owner can modify or resume SSE.
- User name resolution: lookup `User.findOne({ _id: createdBy }).select('name')` or denormalize `createdByName` on draft creation
- Staleness check: if `discoveryStatus === 'running'` and `updatedAt < 30min ago`, mark as `'stopped'`

  2.9. **Add `GET /drafts/:id/status` endpoint to `crawl-drafts.ts`**

- **Cross-user read-only endpoint**: query by `{ _id: draftId, tenantId }` (no `createdBy` filter — anyone can poll status)
- Projection: `.select('discoveryStatus sections url updatedAt createdBy')` — lightweight, no discoveryState
- Returns `{ success: true, data: { discoveredCount, sectionCount, discoveryStatus, isOwner: createdBy === userId } }` only
- `isOwner` flag tells the activity bar whether to show [Resume] or [View]
- Used by activity bar to poll every 10s when panel is closed

  2.10. **Add duplicate domain check endpoint**

- **CRITICAL: Register BEFORE `GET /drafts/:draftId`** — insert between `GET /drafts` (line ~278) and `GET /drafts/:draftId` (line ~282), alongside `GET /drafts/active`
- Zod query validation: `z.object({ indexId: z.string().min(1), domain: z.string().min(1) })`
- Returns existing drafts on same domain in same KB
- UI shows warning in State1UrlEntry

  2.11. **Create `discovery-store.ts` (Zustand)**

- State: `backgroundedItems: BackgroundedDiscovery[]`, `activePanelDraftId: string | null`
- Actions: `addItem`, `removeItem`, `updateItem`, `setActivePanelDraft`
- No persistence (session-scoped) — on mount, activity bar queries draft API to restore

  2.12. **Create `DiscoveryActivityBar.tsx`**

- Renders between KBSectionNav and content area
- Single discovery: compact one-line bar with [Resume] [Stop]
- Multiple: expandable list, auto-collapse > 3 items
- Completed: "✓ Done — [Review Results] [Dismiss]"
- Other users' items: view-only (no action buttons), shows owner name
- Polls `GET /drafts/:id/status` every 10s for each running item

  2.13. **Mount in `KBDetailLayout.tsx`**

- 1 conditional render line: `{activeDiscoveries.length > 0 && <DiscoveryActivityBar />}`
- Between KBSectionNav and content div

  2.14. **Add `isMinimized` state to `State2Analysis.tsx`**

- Toggle button: [▲ Collapse] / [▼ Expand]
- When minimized: hide discovery tree/console (CSS `hidden`), show compact status bar
- SSE stays connected (component still mounted, just hidden)
- Sections remain visible and editable below

  2.15. **Close confirmation dialog in `AddSourceButton.tsx`**

- Use base `Dialog` component (NOT `ConfirmDialog` — that only supports 2 actions)
- When user clicks [×] while discovery running, show 3 options:
  - "Minimize to activity bar" → close panel, add to discovery store
  - "Stop & save" → send stop, save draft, close
  - "Discard" → send stop, delete draft, close

    2.16. **Duplicate domain check in State1UrlEntry / CrawlFlowV5**

- On URL submit, query `GET /drafts/check-domain`
- Show warning if same domain is being discovered by another user
- Offer [View progress] or [Start anyway]

  2.17. **Yield-drop suggestion in `DiscoveryPanel.tsx`**

- Hook into existing `suggestMoreDiscovery` state (DiscoveryPanel.tsx:148)
- When yield drops (existing `shouldSuggestMoreDiscovery()` returns true), show inline suggestion:
  "Discovery is slowing down. Try adding a URL from a different section of the site."
- Render near the existing "Discover More" banner (DiscoveryPanel.tsx:518)
- Links to the existing `AddSampleUrlInput` component (already built in DiscoveryTree.tsx:393-436)

  2.18. **Step 3 mini-bar when discovery still running**

- When user clicks [Continue to Configure →] from State 2a (collapsed), discovery is still running
- Show a compact status bar at the top of `State3Configure.tsx`:
  "🟢 Discovery still running — 187 URLs found · productive · 3 sections growing [Back to Review] [Stop]"
- Warning below: "Starting now will crawl the N URLs found so far."
- Pass `discoveryRunning: boolean` and `discoveryStats: { urlCount, sectionCount }` from CrawlFlowV5 to State3Configure
- [Back to Review] → `onBack()`, [Stop] → sends stop signal via existing API

  2.19. **Panel-switch confirmation when resuming backgrounded discovery**

- When user clicks [Resume] on activity bar while another panel is open:
  "You have hp.com open. Save progress and switch to epson.com?" with [Switch] [Cancel]
- Check `activePanelDraftId` in Zustand store — if set and different from resume target, show prompt
- Use base `Dialog` component (same pattern as Task 2.15)

  2.20. **Auto-Source creation on discovery complete**

- When discovery completes, auto-call `addSource()` with `status: "pending"`
- Source appears in SourcesTable for all team members
- Draft.sourceId linked to the new Source
- Owner sees [Configure & Crawl], others see view-only
- **Traceability**: emit audit event `crawl.source.auto_created` with `{ draftId, sourceId, domain, sectionCount }` using existing SearchAI audit logging pattern (Core Invariant #4)

**Files Touched**:

- `discovery/url-set.ts` — `normalizePattern`, `isSubsetOf`
- `discovery/scope-utils.ts` — `mergeSections`
- `DiscoveryPanel.tsx` — auto-section creation, `onSectionsAutoAdded`
- `DiscoveryTree.tsx` — `[+]` button, inline action buttons
- `BrowserDiscoveryInline.tsx` — forward new prop
- `State2Analysis.tsx` — section badges, grand total, `isMinimized`, collapse/expand
- `CrawlFlowV5.tsx` — section merge handler, auto-Source creation
- `data/AddSourceButton.tsx` (in `search-ai/data/`, not `crawl-flow/`) — close confirmation dialog, panel-switch prompt
- `KBDetailLayout.tsx` — activity bar mount (1 line)
- `packages/database/src/models/crawl-draft.model.ts` — `discoveryStatus` field
- `apps/search-ai/src/routes/crawl-drafts.ts` — 3 new endpoints
- `apps/studio/src/api/crawl.ts` — `getActiveDrafts`, `getDraftStatus`, `checkDomain`
- `apps/studio/src/store/discovery-store.ts` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryActivityBar.tsx` — NEW
- `types.ts` — `BackgroundedDiscovery`, extend `CrawlSection`

**Exit Criteria**:

- [ ] Auto-sections created from prefix groups during discovery (threshold: 5+ URLs)
- [ ] Manual `[+]` button on tree nodes creates sections
- [ ] Section cards show source badges and grand total
- [ ] Collapse toggle hides discovery tree, keeps SSE connected, sections editable
- [ ] Closing panel during discovery shows confirmation dialog with 3 options
- [ ] Activity bar appears in KBDetailLayout with running discoveries
- [ ] Activity bar polls draft status every 10s
- [ ] [Resume] on activity bar reopens CrawlFlowPanel with draft
- [ ] Other users see view-only items in activity bar
- [ ] Duplicate domain warning shown on URL submit
- [ ] Yield-drop suggestion shown when discovery slows down
- [ ] Step 3 mini-bar shows discovery status when navigating to Configure during active discovery
- [ ] Panel-switch confirmation shown when resuming while another panel is open
- [ ] Source auto-created on discovery complete with "pending" status
- [ ] `pnpm build --filter=apps/studio --filter=apps/search-ai --filter=@abl/database` succeeds

**Test Strategy**:

- Unit:
  - `normalizePattern`: edge cases (trailing slashes, mixed case, empty string)
  - `isSubsetOf`: parent/child, same, unrelated
  - `mergeSections`: dedup exact matches, allow subsets
  - Discovery store: add/remove/update items
- Integration:
  - `GET /drafts/active` returns cross-user drafts filtered by indexId
  - `GET /drafts/:id/status` returns lightweight status
  - `GET /drafts/check-domain` finds existing domain drafts
  - `discoveryStatus` field persists correctly in CrawlDraft
  - Auto-Source creation: `addSource` called when discovery completes, Source appears in SourcesTable
- E2E:
  - Start discovery → collapse → verify SSE stays connected → expand → tree is live
  - Close panel during discovery → "Minimize" → verify activity bar appears
  - Activity bar [Resume] → panel reopens with draft loaded
  - Second user sees view-only items in activity bar
  - Duplicate domain check shows warning for same domain
  - Discovery complete → Source appears with "pending" status
- Resilience:
  - Integration: draft with `updatedAt` 31 min ago is auto-marked as `'stopped'` by staleness check
  - Unit: activity bar handles poll 500 error — shows last known state, does not crash
  - Integration: `GET /drafts/active` and `GET /drafts/check-domain` do NOT match as `:draftId` (route ordering regression test)
  - E2E: [Resume] when discovery pod is unreachable → shows "cannot resume" message, not silent failure
  - Unit: `useEffect` cleanup clears all intervals (React StrictMode double-mount test)

**Rollback**: Revert Phase 2 commits. Activity bar disappears, sections revert to manual-only.

---

### Phase 3: Tail of Flow — O5 Extraction Preview + O6 Crawl Progress (~3.5 days)

**Goal**: Preview extraction quality before crawling. Crawl progress shows per-section bars, completion summary, and backgrounding via activity bar.

**Tasks**:

3.1. **Add `pickPreviewUrls` to `coverage-utils.ts`** (~20 lines)

- Select 2-3 sample URLs from included sections
- Prefer deepest paths (leaf content, not hub/index pages)
- One URL per section, max 3

  3.2. **Create `BatchPreviewPanel.tsx`**

- Props: `sections`, `baseUrl`, `renderingMode` (display-only)
- Auto-samples 2-3 URLs via `pickPreviewUrls` on mount
- **Manual override**: dropdown per section showing available pages — user can swap the auto-selected URL for any page in that section
- Calls existing `previewExtraction` API for selected URLs
- Renders sequentially as results arrive (skeleton → filled card)
- Quality bar visualization (5-segment, green/grey)
- JS rendering advisory: informational note when `jsRenderingAdvised === true`
- No "Switch to Browser Mode" button — worker auto-decides

  3.3. **Integrate `BatchPreviewPanel` in `State3Configure.tsx`**

- Collapsible section above "Start Crawl" button
- `<BatchPreviewPanel sections={sections} baseUrl={baseUrl ?? ""} renderingMode={config.rendering} />`

  3.4. **Add section mapping to batch crawl submit**

- In `CrawlFlowV5.handleStartCrawl`: include `sectionMapping` array with sectionId, pattern, name, urls
- Backend `crawl.ts` batch endpoint: accept optional `sectionMapping` field, store in job metadata

  3.5. **Per-section progress bars in `State4Crawl.tsx`**

- Use existing `categoryCrawlStatus` prop (already defined in `State4CrawlProps`)
- Add progress bar per section showing crawled/total
- Collapse to summary if > 10 sections

  3.6. **Inline completion summary in `State4Crawl.tsx`**

- After crawl completes, render summary card:
  - Pages crawled, thin content count, failed count
  - Quality percentage bar
  - Time taken
  - [View thin pages] → links to Documents view with status filter
  - [View Results →] → calls `onViewResults`

    3.7. **Crawl backgrounding via activity bar** (reuse O4 infrastructure)

- Close confirmation during crawl → same 3-option dialog as discovery
- Add crawl items to `useDiscoveryStore` (type: 'crawl')
- Activity bar shows: "🔵 epson.com — Crawling: 142/305 pages (47%) [Resume] [Cancel]"

**Files Touched**:

- `discovery/coverage-utils.ts` — `pickPreviewUrls`
- `BatchPreviewPanel.tsx` — NEW
- `State3Configure.tsx` — integrate BatchPreviewPanel
- `CrawlFlowV5.tsx` — section mapping in batch submit
- `apps/search-ai/src/routes/crawl.ts` — accept `sectionMapping` in batch endpoint
- `State4Crawl.tsx` — per-section progress bars, completion summary, minimize handler
- `types.ts` — no new types (reuse `BackgroundedDiscovery` with type: 'crawl')

**Exit Criteria**:

- [ ] [Run Preview] shows 2-3 sample extractions with quality bars
- [ ] Preview cards render sequentially (skeleton → content)
- [ ] JS rendering advisory shows as informational note
- [ ] Batch submit includes section mapping
- [ ] Per-section progress bars render during crawl
- [ ] Completion summary shows after crawl finishes with actionable stats
- [ ] [View thin pages] navigates to Documents view with status filter
- [ ] Crawl backgrounding works via same activity bar as discovery
- [ ] `pnpm build --filter=apps/studio --filter=apps/search-ai` succeeds

**Test Strategy**:

- Unit:
  - `pickPreviewUrls`: prefers deepest paths, max 3, one per section, skips excluded sections
- Integration:
  - `POST /crawl/batch` with `sectionMapping` stores mapping in job
  - Preview API returns expected fields for test URLs
  - Section progress events emitted via WebSocket
- E2E:
  - Navigate to Step 3 Configure → expand preview → verify 2-3 sample cards render
  - Start crawl → verify per-section progress bars appear
  - Crawl completes → verify summary card with stats
  - Close panel during crawl → verify activity bar shows crawl progress

**Rollback**: Revert Phase 3 commits. Step 3 reverts to no preview, Step 4 reverts to current progress view.

---

### Phase 4: Backend-Dependent — O7 File Types + O8 robots.txt (~4 days)

**Goal**: PDFs and documents discovered during crawling. robots.txt fetched, displayed, and honored. Crawl speed slider.

**Sub-phase ordering**: Backend tasks (4.1-4.2, 4.6-4.7, 4.11) must be committed and build-verified BEFORE frontend tasks (4.3-4.5, 4.8-4.10) that consume them.

**Tasks**:

4.1. **Stop dropping file URLs in `link-extractor.ts`**

- `SKIP_EXTENSIONS` is at `apps/search-ai/src/services/crawler/link-extractor.ts:40` (NOT discover-crawler.ts)
- Remove document extensions from `SKIP_EXTENSIONS` (keep binary-only: `.zip`, `.exe`, `.dmg`, `.iso`)
- Tag discovered file URLs with `fileType` field
- Don't follow file URLs for link discovery (they're leaf nodes)

  4.2. **Add `fileType` to SSE progress events in `crawl-browser-discover.ts`**

- In `discoveredOnPage` entries, include `fileType: 'pdf' | 'docx' | null`
- Detect from URL extension using existing `getExtension` or simple parsing

  4.3. **Track file types in `DiscoveryPanel.tsx`**

- Add `fileTypeCountsRef` (Map-based, like existing `discoveredUrlSetRef`)
- Update counts as URLs are discovered
- PDFs default included, other file types default excluded
- Surface via `onFileTypesUpdated` callback to State2Analysis

  4.4. **Inline `FileTypeSelector` in `State2Analysis.tsx`**

- Render below section checklist when file types exist
- Checkboxes per file type with counts: `☑ PDF files 34 files [Docling]`
- Toggle included/excluded per type
- Hidden when no file types discovered

  4.5. **Section composition badges in `State2Analysis.tsx`**

- Show mixed content: `☑ Printers 142 pages + 12 PDFs ~45m [explored]`
- Uses `fileTypeCounts` field on `CrawlSection`

  4.6. **Install `robots-parser` and create wrapper**

- `pnpm add robots-parser --filter=apps/search-ai`
- Thin wrapper: `analyzeRobotsTxt(url)` → fetch robots.txt → parse → return `RobotsTxtAnalysis`
- Place in `apps/search-ai/src/services/crawler/robots-analyzer.ts` (~30 lines) — route files should delegate to services, not contain business logic. `crawl.ts` is already 2,876 lines.

  4.7. **Add `POST /crawl/robots` endpoint to `crawl.ts`**

- Zod body validation: `z.object({ url: z.string().url() })`
- Returns `{ success: true, data: RobotsTxtAnalysis }` (standard structured response envelope)
- Rate-limited at 10/min/tenant (use existing rate-limit middleware)
- **SSRF defense-in-depth**:
  - `isURLAllowed()` hostname check (existing)
  - DNS resolution check: resolve hostname, reject if it resolves to private/link-local/metadata IPs (169.254.x.x, 10.x.x.x, etc.)
  - Fetch timeout: `ROBOTS_TXT_FETCH_TIMEOUT_MS` (5s)
  - Response size cap: `ROBOTS_TXT_MAX_SIZE_BYTES` (512KB, matches Google's limit) — truncate and parse if exceeded
  - **SSRF on discovered sitemapUrls**: run `isURLAllowed()` on each sitemapUrl from robots.txt before including in response — internal hosts stripped from response

    4.8. **Add `analyzeRobotsTxt` to Studio API client**

- `apps/studio/src/api/crawl.ts` — add `analyzeRobotsTxt(url)` function

  4.9. **Inline `RobotsTxtCard` in `State3Configure.tsx`**

- Fetch robots.txt when Step 3 mounts (parallel with section display)
- Show: found status, Crawl-delay, disallowed paths, affected sections count
- Loading skeleton while fetching

  4.10. **Crawl speed slider in `State3Configure.tsx`**

- Replace hardcoded `requestDelay` number input with range slider
- Left = Fast (200ms), Right = Polite (5s)
- **Crawl-delay interpretation**: "minimum delay between sequential requests to the same domain, in seconds" (Yandex convention, most conservative)
- Minimum raised to `max(200, crawlDelay * 1000)` if robots.txt specifies Crawl-delay
- Slider max adjusts: `max(5000, crawlDelay * 1000)` to accommodate large Crawl-delay values
- Warning below 500ms: "Fast speeds may trigger rate limiting"
- Warning if below Crawl-delay: "Site requests {delay}s between requests"

  4.11. **Honor settings in batch crawl**

- `POST /crawl/batch` body: accept `respectRobotsTxt`, `crawlDelay`, `maxConcurrent`
- Accept `documentUrls` array alongside `urls` — each entry has `{ url, fileType, processingMethod }` for Docling routing
- Pass through to crawl worker configuration — file URLs routed to Docling extraction pipeline

**Files Touched**:

- `apps/search-ai/src/services/crawler/link-extractor.ts` — stop dropping file URLs from `SKIP_EXTENSIONS`
- `apps/search-ai/src/routes/crawl-browser-discover.ts` — `fileType` in SSE
- `DiscoveryPanel.tsx` — `fileTypeCountsRef`, file type tracking
- `BrowserDiscoveryInline.tsx` — forward file type data
- `State2Analysis.tsx` — inline FileTypeSelector, section composition badges
- `types.ts` — `FileTypeCount`, extend `CrawlSection` with `fileTypeCounts`
- `apps/search-ai/src/services/crawler/robots-analyzer.ts` — `robots-parser` wrapper (`analyzeRobotsTxt`)
- `apps/search-ai/src/routes/crawl.ts` — `/robots` endpoint (calls `robots-analyzer`), honor settings in batch
- `apps/studio/src/api/crawl.ts` — `analyzeRobotsTxt` client
- `State3Configure.tsx` — inline RobotsTxtCard, crawl speed slider

**Exit Criteria**:

- [ ] PDF and document URLs discovered and shown with type counts
- [ ] File type checkboxes toggle inclusion (PDFs default on)
- [ ] Section cards show mixed content composition
- [ ] robots.txt fetched and displayed in Step 3 with Crawl-delay, disallowed paths
- [ ] Affected sections count shown in robots card
- [ ] Crawl speed slider with min=200ms (or Crawl-delay), max=5000ms
- [ ] Warning shown when speed < 500ms or below Crawl-delay
- [ ] `robots-parser` installed and used for parsing
- [ ] SSRF check on robots.txt URL
- [ ] `pnpm build --filter=apps/studio --filter=apps/search-ai` succeeds

**Test Strategy**:

- Unit:
  - robots.txt parsing: found, not found (404), empty, Crawl-delay extraction, disallowed path matching
  - File type detection from URL extensions
  - Slider min calculation: max(200, crawlDelay \* 1000)
- Integration:
  - `POST /crawl/robots` returns correct analysis for test domain
  - SSRF check blocks private IP robots.txt
  - Rate limit: 11th request within 1 minute returns 429
  - `discover-crawler.ts` includes `.pdf` URLs in discovered set
  - SSE `discoveredOnPage` entries have `fileType` field
- E2E:
  - Start discovery on site with PDFs → verify FileTypeSelector shows PDF count
  - Navigate to Step 3 → verify RobotsTxtCard renders with analysis
  - Move slider → verify delay value updates in config
  - Start crawl with robots.txt active → verify Crawl-delay honored

**Rollback**: Revert Phase 4 commits. File URLs dropped again, robots.txt card hidden, slider reverts to number input.

---

## 4. Wiring Checklist

- [ ] `computeSubtreeCounts` exported from `tree-utils.ts`, re-exported from `discovery/index.ts`
- [ ] `normalizePattern`, `isSubsetOf` exported from `url-set.ts`, re-exported from `discovery/index.ts`
- [ ] `mergeSections` exported from `scope-utils.ts`, re-exported from `discovery/index.ts`
- [ ] `pickPreviewUrls` exported from `coverage-utils.ts`, re-exported from `discovery/index.ts`
- [ ] `PipelinePhase` type exported from `types.ts`, imported in `DiscoveryTimeline.tsx` and `State2Analysis.tsx`
- [ ] `LiveProgressStats` type exported from `types.ts`, imported in `DiscoveryTimeline.tsx` and `State2Analysis.tsx`
- [ ] `discovery-store.ts` registered in `apps/studio/src/store/`
- [ ] `DiscoveryActivityBar.tsx` imported and rendered in `KBDetailLayout.tsx`
- [ ] `BatchPreviewPanel.tsx` imported and rendered in `State3Configure.tsx`
- [ ] `onLiveStats` callback wired: `State2Analysis` → `BrowserDiscoveryInline` → `DiscoveryPanel`
- [ ] `onSectionsAutoAdded` callback wired: `DiscoveryPanel` → `BrowserDiscoveryInline` → `State2Analysis` → `CrawlFlowV5`
- [ ] `discoveryStatus` field added to CrawlDraft Mongoose schema AND interface
- [ ] 3 new endpoints registered in `crawl-drafts.ts` router
- [ ] `/robots` endpoint registered in `crawl.ts` router
- [ ] `robots-analyzer.ts` created in `apps/search-ai/src/services/crawler/` and imported by `/robots` route
- [ ] `robots-parser` added to `apps/search-ai/package.json`
- [ ] `'auto'` source enum updated in all 6 locations (see Task 2.7b)
- [ ] API client functions added to `apps/studio/src/api/crawl.ts`
- [ ] All new type exports verified in `types.ts`

**Studio UI wiring**:

- [ ] Each new UI section has error handling (try/catch on API calls)
- [ ] Activity bar API calls have loading states
- [ ] Preview panel has loading skeletons
- [ ] No native `<select>` elements — using existing `<Select>` component
- [ ] No `bg-accent text-foreground` — using `bg-accent text-accent-foreground`
- [ ] Close confirmation dialog uses existing Dialog component pattern
- [ ] Slider uses semantic design tokens

---

## 5. Cross-Phase Concerns

### Database Changes

- Phase 2: Add `discoveryStatus` field to `crawl_drafts` collection (backward compatible — defaults to `'idle'`, no migration needed)

### Feature Flags

None — these are progressive enhancements to the existing crawl flow. Each phase is independently deployable.

### Configuration Changes

- Phase 4: `robots-parser` npm dependency added to `apps/search-ai/package.json`

### Named Constants

All magic numbers must be named constants in their respective files:

| Constant                        | Value   | Location                                                     |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `ACTIVITY_BAR_POLL_INTERVAL_MS` | 10000   | `DiscoveryActivityBar.tsx`                                   |
| `AUTO_SECTION_MIN_URLS`         | 5       | `DiscoveryPanel.tsx` (already exists as `AUTO_ADD_MIN_URLS`) |
| `MAX_PREVIEW_URLS`              | 3       | `coverage-utils.ts`                                          |
| `SLIDER_MIN_DELAY_MS`           | 200     | `State3Configure.tsx`                                        |
| `SLIDER_MAX_DELAY_MS`           | 5000    | `State3Configure.tsx`                                        |
| `ACTIVE_DRAFT_WINDOW_MS`        | 3600000 | `crawl-drafts.ts` (1 hour)                                   |
| `STALE_DISCOVERY_THRESHOLD_MS`  | 1800000 | `crawl-drafts.ts` (30 min)                                   |
| `MAX_POLLED_ITEMS`              | 5       | `DiscoveryActivityBar.tsx`                                   |
| `ROBOTS_TXT_MAX_SIZE_BYTES`     | 524288  | `crawl.ts` (512KB, matches Google's limit)                   |
| `ROBOTS_TXT_FETCH_TIMEOUT_MS`   | 5000    | `crawl.ts`                                                   |
| `SSE_HEARTBEAT_INTERVAL_MS`     | 15000   | `crawl-browser-discover.ts`                                  |

### i18n Strategy

All user-visible strings use `useTranslations('search_ai.crawl_flow')` (existing namespace used by all crawl-flow components). New keys added to the existing i18n structure following the standard workflow.

Key groups: `crawl_flow.activity_bar.*`, `crawl_flow.preview.*`, `crawl_flow.robots.*`, `crawl_flow.file_types.*`, `crawl_flow.completion.*`

### SWR Cache Invalidation

- After auto-Source creation (Task 2.20): CrawlFlowV5 calls `addSource()` directly — after success, call `mutate()` on the SWR key used by SourcesTable (`/api/search-ai/indexes/${indexId}/sources`). Alternatively, thread an `onSourceCreated` callback from DataSection → AddSourceButton → CrawlFlowV5.
- After `discoveryStatus` changes: activity bar polls independently — no SWR needed (Zustand store + polling)

### Known Limitations (ALPHA → BETA blockers)

- **Pod affinity**: In-memory `Map<string, CrawlState>` in `crawl-discover.ts` means backgrounded discoveries only survive on the same pod. **ALPHA workaround**: if [Resume] reconnects SSE and gets 404 (discovery on different pod), show explicit message: "Discovery ran on another server. Results are saved — start a new discovery or review saved sections." BETA blocker: migrate to Redis/BullMQ.
- **SSE browser connection limit**: HTTP/1.1 limits 6 concurrent EventSource connections per domain (Chrome/Firefox, won't fix). With N discoveries + polling, the budget can be exhausted. **ALPHA mitigation**: cap concurrent SSE connections at 2 (activity bar uses polling, not SSE). BETA: verify HTTP/2 in production (raises limit to ~100).
- **SSE reconnection gaps**: No `Last-Event-ID` handling — if SSE drops and reconnects, events during the gap are lost. Tree rebuilds from incoming events going forward. Sections (the data that matters) are persisted in the draft. BETA: add event IDs and server-side replay.
- Activity bar polling (10s interval) is acceptable for ALPHA. **Batch optimization**: when > `MAX_POLLED_ITEMS` (5) discoveries are backgrounded, batch status checks into a single `POST /drafts/batch-status` request. BETA: use WebSocket.
- **Polling cleanup**: All `setInterval` calls in `DiscoveryActivityBar` must pair with `clearInterval` in `useEffect` cleanup. Verified via React StrictMode double-mount test (exit criteria).
- **SSE keep-alive**: SSE endpoints must emit `: heartbeat\n\n` every 15s during idle periods to prevent proxy/LB timeout disconnections (Nginx default: 60s idle timeout).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] O1: Live discovery transparency with yield rate and health indicators
- [ ] O2: Auto-section creation from tree categories with dedup
- [ ] O3: Recursive page counts with time estimates on tree nodes
- [ ] O4: Inline collapse, KB-level activity bar, close confirmation, N concurrent discoveries
- [ ] O5: Batch extraction preview with quality bars
- [ ] O6: Per-section crawl progress, completion summary, crawl backgrounding
- [ ] O7: File type discovery (PDF, DOC) with type counts and checkboxes
- [ ] O8: robots.txt analysis, crawl speed slider, Crawl-delay enforcement
- [ ] Multi-user: owner controls, others observe, duplicate domain prevention, auto-Source creation
- [ ] No regressions in existing crawl flow
- [ ] `pnpm build` succeeds across all affected packages
- [ ] All new pure functions have unit tests
- [ ] All new endpoints have integration tests
- [ ] E2E scenarios for each objective pass

---

## 7. Review Gates

Each phase has a review gate before proceeding:

| Phase   | Review              | Criteria                                                                        |
| ------- | ------------------- | ------------------------------------------------------------------------------- |
| Phase 0 | Self-review         | Build passes, no behavior change, State2Analysis reduced                        |
| Phase 1 | Code review         | Pure functions tested, live stats flow verified manually                        |
| Phase 2 | Architecture review | Zustand store pattern, endpoint security (tenantId scoping), close dialog UX    |
| Phase 3 | Code review         | Preview API usage, section mapping correctness, completion summary UX           |
| Phase 4 | Security review     | SSRF on robots.txt URL, rate limiting on `/robots` endpoint, file type handling |

---

## 8. Open Questions

1. **Activity bar WebSocket vs polling**: Current design uses 10s polling. Should we use existing WebSocket infrastructure for real-time updates? Decision: Polling for ALPHA, WebSocket for BETA.
2. **"Use those results" for duplicate domain**: Copying sections from another user's draft — should this deep-copy the discoveredUrlSet too? Decision: Yes, copy sections + URL list. Tree is not copied (it's a navigation aid).
3. **Auto-Source "pending" status**: Does `SourcesTable` already render "pending" sources distinctly? Need to verify at `SourcesTable.tsx` line 312.
