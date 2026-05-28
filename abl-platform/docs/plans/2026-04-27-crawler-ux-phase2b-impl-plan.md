# LLD: Crawler UX Phase 2b — Strategy Selection, Mid-Stream Interventions, Scope Rules, Resume Flow

**Feature Spec**: `docs/features/web-crawling.md`
**HLD**: `docs/specs/web-crawling.hld.md`
**Test Spec**: `docs/testing/web-crawling.md`
**Design Doc**: `docs/searchai/design/DISCOVERY-PANEL-DESIGN.md`
**Phase 1 LLD**: `docs/plans/2026-04-23-crawler-discovery-panel-impl-plan.md` (DONE)
**Phase 3 LLD**: `docs/plans/2026-04-24-crawler-ux-phase3-impl-plan.md` (DONE)
**Supersedes**: `docs/plans/2026-04-26-crawler-ux-phase2-impl-plan.md` (SUPERSEDED — conflicts with Phase 3 implementation)
**Status**: APPROVED (5 review rounds — 2026-04-28)
**Date**: 2026-04-27

---

## 0. Context — What This LLD Covers

Phase 1 built the core Discovery Panel (tree, console, decision cards, coverage, nav extraction, basic interventions).
Phase 3 added explainability (enriched progress), extraction preview, and iterative discovery (stop+restart with resumeContext).

This Phase 2b LLD covers the **remaining objectives** that Phase 3 did not address:

| Feature                                  | Design Doc Section   | Objectives Served                |
| ---------------------------------------- | -------------------- | -------------------------------- |
| Phase 0: `exploreId` plumbing fix        | —                    | All interventions (prerequisite) |
| Phase 1: Data layer + types              | —                    | All features (prerequisite)      |
| Phase 2: Depth-prober loop refactor      | §6                   | G2 (intervention infra)          |
| Phase 3: Backend intervention completion | §6                   | UJ-7, UJ-9, UJ-10, UJ-11, G2     |
| Phase 4: Frontend intervention dispatch  | §6.5                 | UJ-7 to UJ-12, G2, G3            |
| Phase 5: Strategy selection (D7)         | §22                  | UJ-2 (choose approach)           |
| Phase 6: Scope rules                     | §23 Resolution #1    | UJ-4, UJ-16                      |
| Phase 7: Resume discovery flow           | §17.1b               | UJ-18 (resume later)             |
| Phase 8: Console polish                  | §23 Resolutions #2-5 | G1 (transparency)                |

### What Already Exists (from Phase 1 + Phase 3)

| Component                              | Status | Notes                                                                                          |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| DiscoveryPanel.tsx (708 lines)         | Built  | Orchestrates Console + Tree + Coverage + auto-save timer                                       |
| DiscoveryTree.tsx                      | Built  | Auto-collapse, breadcrumbs, node actions (explore, skip, undo-skip, explore-all, add-to-scope) |
| DiscoveryConsole.tsx                   | Built  | Scrollable log, action chips, 200-entry cap                                                    |
| DecisionCards.tsx                      | Built  | Card renderer, Browse Titles                                                                   |
| CoverageSummary.tsx                    | Built  | Category coverage display                                                                      |
| types.ts (622 lines)                   | Built  | InterventionType, ConsoleAction, CrawlDraftDiscoveryState                                      |
| discovery/ utilities (7 files)         | Built  | tree-utils, decision-utils, coverage-utils, console-utils, url-set, crawl-queue-utils          |
| depth-prober.ts (1618 lines)           | Built  | 5-phase exploration, enriched progress, YieldTracker, command queue check                      |
| command-queue.ts (133 lines)           | Built  | enqueue/dequeue/peek/clear, 50 cap, 30min TTL, MAX_EXPLORATIONS=100                            |
| yield-tracker.ts                       | Built  | Signal-based stopping                                                                          |
| crawl-browser-discover.ts (757 lines)  | Built  | SSE proxy, POST intervention endpoint, SSRF protection, local intervention queue               |
| nav-extractor.ts                       | Built  | Site navigation extraction                                                                     |
| BrowserDiscoveryInline.tsx (558 lines) | Built  | SSE shell, reconnection, iterative discovery (stop+restart)                                    |
| CrawlFlowV5.tsx (841 lines)            | Built  | State machine: url-entry → analyzing → configure → crawling → done                             |
| server.ts (865 lines)                  | Built  | /api/explore-deep (SSE), /api/explore/:id/command (POST)                                       |

### Critical Bugs Found During Analysis

| Bug                                                                                                | Impact                                                                                                                                                                                                                                                  | Fix Phase |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **`exploreId` never set in `depthConfig`** (server.ts:554-569)                                     | Command queue completely disconnected — `checkCommandQueue()` always returns `undefined`. All interventions except `stop` (abort controller) are broken.                                                                                                | Phase 0   |
| **`discoveryState` silently dropped by Mongoose**                                                  | `ICrawlDraft` and Mongoose schema have no `discoveryState` field. Default `strict: true` drops the field on save even though Zod `.passthrough()` accepts it. Auto-save (every 30s) writes to an endpoint that roundtrips through Mongoose → data loss. | Phase 1   |
| **`handleDiscoveryAction` silently drops most interventions** (BrowserDiscoveryInline.tsx:146-162) | Only handles `explore-branch` (calls handleStop which closes panel) and `proceed-to-crawl` (calls onClose). All other interventions dispatched by DiscoveryPanel tree actions are silently ignored.                                                     | Phase 4   |
| **`onSaveDiscoveryState` never wired**                                                             | DiscoveryPanel's auto-save timer fires every 30s but the `onSaveDiscoveryState` callback is never passed by BrowserDiscoveryInline. Discovery state is never persisted.                                                                                 | Phase 1   |

### What's Missing (this LLD)

| Gap                        | Current State                                                                      | Needed                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| exploreId plumbing         | `depthConfig` never sets `exploreId`, `connectToExplorer` doesn't pass it          | Pass exploration UUID through the full chain                                            |
| discoveryState persistence | Mongoose schema missing field, auto-save callback unwired                          | Add to Mongoose schema, wire callback                                                   |
| Strategy selection         | User goes straight to discovery after profiling                                    | D7: Show strategy cards (Crawl Full Sitemap / Guided Discovery)                         |
| Backend interventions      | depth-prober only handles `stop` and `skip-branch` in a `for...of` loop            | Full command switch in `while` loop: explore-branch, add-sample, explore-all, undo-skip |
| Frontend dispatch          | `handleDiscoveryAction` only handles explore-branch (as stop) and proceed-to-crawl | Full switch + `sendBrowserIntervention` API client                                      |
| Scope rules                | No scope tracking — everything discovered is flat                                  | Scope flows DOWN from samples; parents = discovery only; siblings = user decides        |
| Resume flow                | Draft persistence exists but no resume UI or discoveryState restore                | Banner: Continue / Start Fresh / Proceed to Crawl                                       |
| Console polish             | No FIFO counter, no boundary language                                              | "200 of 1,247 events", boundary qualifiers                                              |

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                              | Rationale                                                                                                                                                                                                                                                                             | Alternatives Rejected                                                                       |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| D-1 | Phase 0 as standalone `fix()` commit before all other work                            | The exploreId bug disconnects the entire command queue. Every intervention test will fail without this fix. 3 files touched overlap with later phases but the fix is tiny and orthogonal.                                                                                             | Bundling with Phase 2 (delays validation of the fix)                                        |
| D-2 | Refactor depth-prober loop to `while (pendingCrumbs.length > 0)` using `Breadcrumb[]` | The superseded LLD used `pendingUrls: string[]` which loses `text` and `depth` metadata. `Breadcrumb` has `{ href, text, depth }` — all needed for progress reporting and logging.                                                                                                    | `PendingUrl` type (unnecessary wrapper when `Breadcrumb` already exists)                    |
| D-3 | Hybrid intervention architecture: steering via POST, iteration via stop+restart       | Phase 3 built stop+restart with `resumeContext` for iteration commands (`add-sample-and-discover`, `explore-remaining`). Steering commands (`skip-branch`, `explore-branch`, `explore-all`, `undo-skip`) work mid-stream via POST to command queue. Don't rewrite what Phase 3 built. | All-POST (breaks Phase 3's restart pattern), all stop+restart (latency for simple steering) |
| D-4 | Strategy selection as sub-state in State2Analysis                                     | §22.5 says "new sub-state within analyzing". No flow-level state change needed.                                                                                                                                                                                                       | Separate flow state (over-engineers), separate route (breaks back-nav)                      |
| D-5 | Scope state lives in `CrawlDraftDiscoveryState` (not top-level on draft)              | Scope is a frontend concern tied to discovery. Already has `.passthrough()` + 5MB limit.                                                                                                                                                                                              | Top-level `scope` field on draft (requires schema migration for a frontend concept)         |
| D-6 | Resume banner in `analyzing` flow state (not a new flow state)                        | Design doc §17.1b says "No changes to CrawlFlowState type". 2 of 3 resume actions stay within analyzing.                                                                                                                                                                              | New flow state (changes state machine), modal dialog (too heavy)                            |
| D-7 | Single generic `sendBrowserIntervention()` function                                   | Matches the single backend endpoint. One function, one HTTP path, one error handling pattern.                                                                                                                                                                                         | Separate functions per intervention (unnecessary proliferation for a single endpoint)       |
| D-8 | Remove `add-to-scope` + `add-children-to-scope` from backend schemas                  | These are frontend-only scope operations. Keeping them in Zod/command-queue adds dead code paths.                                                                                                                                                                                     | Keep as no-ops (confusing — accepted but never processed)                                   |
| D-9 | Remove `background` + `edit-pause` from `InterventionType`                            | Not in any backend schema, not implemented, not planned for this phase. Placeholders create dead code.                                                                                                                                                                                | Keep as "coming soon" (no consumer, no timeline)                                            |

### Key Interfaces & Types

```typescript
// ── New types to add to types.ts ──────────────

/** Strategy selection (D7) */
type DiscoveryStrategy = 'crawl-sitemap' | 'guided-discovery';

interface StrategySelectionState {
  selected: boolean;
  strategy: DiscoveryStrategy | null;
  hasSitemap: boolean;
  sitemapPageCount: number;
}

/** Scope tracking (§23 Resolution #1) */
interface DiscoveryScope {
  sampleUrls: string[];
  /** URL prefixes auto-included (derived from sample parent directories) */
  includedPrefixes: string[];
  /** URL prefixes explicitly excluded by user */
  excludedPrefixes: string[];
  /** Sections explicitly included by user (from [NEW] toggle) */
  includedSections: string[];
}

/** Resume discovery banner state */
interface ResumeDiscoveryBanner {
  show: boolean;
  discoveredCount: number;
  sectionCount: number;
  includedCount: number;
  savedAt: number;
}

/**
 * Backend command types — sent via POST to intervention endpoint.
 * Frontend-only operations (scope changes, UI state) never POST to backend.
 */
type BackendInterventionType =
  | 'stop'
  | 'skip-branch'
  | 'explore-branch'
  | 'add-sample'
  | 'explore-all'
  | 'undo-skip';

/** Override warning data (§23 Resolution #5) — callbacks defined in component, not state */
interface OverrideWarningData {
  branch: string;
  discoveryRate: string; // e.g., "2 new in last 15"
}
// Usage: const [overrideWarning, setOverrideWarning] = useState<OverrideWarningData | null>(null);
// Handlers: onConfirm/onCancel defined inline in render — avoids stale closure anti-pattern
```

### Module Boundaries

| Module                       | Responsibility                                               | Depends On                                  |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `StrategySelector.tsx`       | NEW — Strategy cards after profiling                         | StrategySelectionState, profile data        |
| `scope-utils.ts`             | NEW — Scope derivation from samples + tree                   | DiscoveryScope, tree-utils                  |
| `depth-prober.ts`            | EXTEND — Loop refactor + full command switch                 | command-queue (existing)                    |
| `server.ts`                  | FIX — Pass exploreId to depthConfig                          | DepthProbeConfig (existing)                 |
| `crawl-browser-discover.ts`  | FIX — Pass exploreId in MCP request; narrow Zod              | connectToExplorer, interventionSchema       |
| `BrowserDiscoveryInline.tsx` | EXTEND — Full dispatch switch + wire onSaveDiscoveryState    | DiscoveryPanel, sendBrowserIntervention API |
| `DiscoveryPanel.tsx`         | EXTEND — Scope state, override warning, initialState restore | scope-utils, DiscoveryScope                 |
| `CrawlFlowV5.tsx`            | EXTEND — Resume banner, strategy routing                     | CrawlDraft API                              |
| `State2Analysis.tsx`         | EXTEND — Strategy sub-state                                  | StrategySelector                            |
| `crawl-queue-utils.ts`       | EXTEND — Scope-aware filtering                               | DiscoveryScope                              |
| `api/crawl.ts`               | EXTEND — sendBrowserIntervention + updateCrawlDraft types    | BackendInterventionType                     |

---

## 2. File-Level Change Map

### New Files

| File                                                                                      | Purpose                                                                       | LOC Estimate |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx`                    | D7 strategy cards — Crawl Full Sitemap / Guided Discovery                     | ~180         |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/scope-utils.ts`                | Scope derivation: `deriveScope`, `isInScope`, `addToScope`, `removeFromScope` | ~120         |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/scope-utils.test.ts` | Unit tests for scope derivation                                               | ~150         |

### Modified Files

| File                                                                             | Change Description                                                                                                                                                                                                                 | Risk     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/crawler-mcp-server/src/server.ts`                                          | **Phase 0**: Add `exploreId` to `depthConfig` (line 554-569) and accept it in request schema. **Phase 2**: Narrow `CommandSchema` Zod to 6 backend types.                                                                          | Low      |
| `apps/search-ai/src/routes/crawl-browser-discover.ts`                            | **Phase 0**: Pass `state.id` as `exploreId` in MCP request body (line 443). **Phase 2**: Narrow `interventionSchema` Zod to 6 backend types.                                                                                       | Low      |
| `apps/crawler-mcp-server/src/explore/depth-prober.ts`                            | **Phase 2**: Refactor Phase 2 loop from `for...of sortedCrumbs` to `while (pendingCrumbs.length > 0)` with `Breadcrumb[]`. **Phase 3**: Extend `checkCommandQueue` switch with explore-branch, add-sample, explore-all, undo-skip. | **High** |
| `apps/crawler-mcp-server/src/explore/command-queue.ts`                           | **Phase 2**: Narrow `Intervention.type` to `BackendInterventionType` (remove add-to-scope, add-children-to-scope).                                                                                                                 | Low      |
| `apps/studio/src/api/crawl.ts`                                                   | **Phase 1**: Add `discoveryState` and `strategy` to `updateCrawlDraft` param type. **Phase 4**: Add `sendBrowserIntervention()` function.                                                                                          | Low      |
| `apps/search-ai/src/routes/crawl-drafts.ts`                                      | **Phase 1**: Add `strategy` field to `updateDraftSchema` Zod. Verify `discoveryState` already accepted.                                                                                                                            | Low      |
| `packages/database/src/models/crawl-draft.model.ts`                              | **Phase 1**: Add `discoveryState: { type: Schema.Types.Mixed, default: null }` and `strategy: { type: String, default: null }` to Mongoose schema + `ICrawlDraft` interface.                                                       | Low      |
| `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`     | **Phase 1**: Wire `onSaveDiscoveryState` to DiscoveryPanel. **Phase 4**: Extend `handleDiscoveryAction` with full switch + `sendBrowserIntervention`.                                                                              | Medium   |
| `apps/studio/src/components/search-ai/crawl-flow/types.ts`                       | **Phase 1**: Add DiscoveryStrategy, StrategySelectionState, DiscoveryScope, BackendInterventionType, OverrideWarning. Remove `background` and `edit-pause` from InterventionType.                                                  | Low      |
| `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`                | **Phase 7**: Resume banner, discoveryState check on draft load, strategy routing.                                                                                                                                                  | Medium   |
| `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx`             | **Phase 5**: Strategy sub-state after profiling completes.                                                                                                                                                                         | Medium   |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`             | **Phase 4**: Override warning state. **Phase 6**: Scope state. **Phase 7**: `initialState` prop for restore.                                                                                                                       | Medium   |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryTree.tsx`              | **Phase 6**: Scope visual indicators (in-scope, out-of-scope, discovery hub).                                                                                                                                                      | Low      |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx`           | **Phase 8**: FIFO counter, boundary language.                                                                                                                                                                                      | Low      |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/crawl-queue-utils.ts` | **Phase 6**: Scope-aware `maybeQueueForCrawl`.                                                                                                                                                                                     | Low      |
| `packages/i18n/locales/en/studio.json`                                           | ~30 new i18n keys across all phases.                                                                                                                                                                                               | Low      |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Fix `exploreId` Plumbing — ~0.5 day

**Goal**: Connect the command queue system by passing the exploration UUID from search-ai through the MCP request to depth-prober's `depthConfig`.

**Why this is Phase 0**: Every intervention except `stop` (which uses abort controller) is broken without this. The command queue infrastructure exists but is completely disconnected.

**Bug trace**:

1. `crawl-browser-discover.ts:239` — `state.id = crypto.randomUUID()` ✅ (ID created)
2. `crawl-browser-discover.ts:443` — `body: JSON.stringify(config)` ❌ (`config` doesn't include `exploreId`)
3. `server.ts:554-569` — `depthConfig` construction ❌ (no `exploreId` field set)
4. `depth-prober.ts:416` — `if (!config.exploreId) return undefined` ❌ (always short-circuits)
5. `crawl-browser-discover.ts:693` — `fetch(${CRAWLER_MCP_URL}/api/explore/${state.id}/command)` ✅ (commands are forwarded correctly)
6. `server.ts:675-700` — `enqueueCommand(exploreId, command)` ✅ (commands are enqueued correctly)
7. Result: commands pile up in the queue but depth-prober never dequeues them.

**Tasks**:

0.1. In `apps/search-ai/src/routes/crawl-browser-discover.ts`, modify `connectToExplorer()` (line 443) to include `exploreId: state.id` in the request body:

```typescript
body: JSON.stringify({ ...config, exploreId: state.id }),
```

0.2. In `apps/crawler-mcp-server/src/server.ts`, add `exploreId` to the `ExploreDeepRequestSchema` Zod and pass it to `depthConfig`:

```typescript
// In ExploreDeepRequestSchema — add field
exploreId: z.string().min(1).optional(),

// In depthConfig construction (line 554-569) — add:
exploreId: parsed.data.exploreId,
```

0.3. Verify `DepthProbeConfig.exploreId` (depth-prober.ts:76) is already optional `string` — it is. No change needed.

**Files Touched**:

- `apps/search-ai/src/routes/crawl-browser-discover.ts` — add exploreId to request body
- `apps/crawler-mcp-server/src/server.ts` — accept exploreId in schema, pass to depthConfig

**Exit Criteria**:

- [ ] `checkCommandQueue()` returns commands when they exist (not always `undefined`)
- [ ] `skip-branch` command (the only one currently handled besides `stop`) causes depth-prober to skip the targeted URL
- [ ] `pnpm build --filter=crawler-mcp-server --filter=search-ai` succeeds
- [ ] Commit: `fix(search-ai): wire exploreId through MCP request to depth-prober command queue`

**Rollback**: Revert 2 one-line changes.

---

### Phase 1: Data Layer + Type Foundation — ~1 day

**Goal**: Fix the discoveryState persistence bug, add strategy/scope types, and wire the auto-save callback. All subsequent phases depend on this data foundation.

**Tasks**:

1.1. **Fix Mongoose schema** — `packages/database/src/models/crawl-draft.model.ts`:

Add to `ICrawlDraft` interface (after line 67):

```typescript
discoveryState?: Record<string, unknown> | null;
strategy?: string | null;
```

Add to Mongoose schema (after line 144, before `version`):

```typescript
discoveryState: { type: Schema.Types.Mixed, default: null },
strategy: { type: String, default: null },
```

1.2. **Extend updateCrawlDraft API client** — `apps/studio/src/api/crawl.ts`:

Add to the `data` parameter type of `updateCrawlDraft` (line 1163-1171):

```typescript
discoveryState?: CrawlDraftDiscoveryState | null;
strategy?: string | null;
```

1.3. **Extend Zod schema** — `apps/search-ai/src/routes/crawl-drafts.ts`:

Read `updateDraftSchema` (line 77-110). The `discoveryState` field has a **structured** Zod sub-schema with typed `iterations` array (crawl-drafts.ts:84-108). Additional `CrawlDraftDiscoveryState` fields (`tree`, `discoveredUrls`, `objectives`, `navStructure`, `coverage`, `savedAt`) survive only because the outer object uses `.passthrough()` — they are NOT explicitly in the Zod schema.

**FRAGILITY WARNING**: If `.passthrough()` is ever removed or changed to `.strict()`, auto-save will silently drop all discovery state except `iterations`. This dependency must be documented in a code comment.

Add `strategy` field and `scope` to the Zod schema explicitly (since `scope` is a new structured type):

```typescript
strategy: z.enum(['crawl-sitemap', 'guided-discovery']).optional(),
// Within the discoveryState sub-schema, add:
scope: z.object({
  sampleUrls: z.array(z.string()),
  includedPrefixes: z.array(z.string()),
  excludedPrefixes: z.array(z.string()),
  includedSections: z.array(z.string()),
}).optional(),
```

Add a code comment above the `.passthrough()` call:

```typescript
// CAUTION: CrawlDraftDiscoveryState fields (tree, discoveredUrls, objectives,
// navStructure, coverage, savedAt) pass through unvalidated. Do NOT change
// to .strict() without adding these fields to the schema first.
```

1.4. **Add types to `types.ts`** — `apps/studio/src/components/search-ai/crawl-flow/types.ts`:

- Add `DiscoveryStrategy`, `StrategySelectionState`, `DiscoveryScope`, `BackendInterventionType`, `OverrideWarningData`, `ResumeDiscoveryBanner` (as defined in §1 Key Interfaces)
- Remove `background` and `edit-pause` from the `InterventionType` union (no backend consumer, no frontend implementation)
- Add `scope?: DiscoveryScope` to `CrawlDraftDiscoveryState`
- **Extend `State2AnalysisProps`** (types.ts:104-114) — add props needed for Phases 5 and 7:
  ```typescript
  draftId?: string;
  draftVersion?: number;
  initialDiscoveryState?: CrawlDraftDiscoveryState | null;
  ```
- **Extend `BrowserDiscoveryInlineProps`** — add `onSaveDiscoveryState?: (state: CrawlDraftDiscoveryState) => void` (per Task 1.5 Option A, the callback is created in State2Analysis)

  1.5. **Wire `onSaveDiscoveryState`** — full prop threading chain:

**The problem**: `DiscoveryPanel` accepts `onSaveDiscoveryState` prop (line 75) but `BrowserDiscoveryInline` never passes it. `BrowserDiscoveryInline` does not have `draftId` or `draftVersion` in its props. This requires a 3-level prop chain.

**Prop threading** (verified: none of these props exist today):

1. `CrawlFlowV5.tsx` already has `draftId` (line ~250) and `draft.version`. Pass both to State2Analysis:

   ```typescript
   <State2Analysis ... draftId={draftId} draftVersion={draft?.version} />
   ```

2. `State2Analysis.tsx` receives `draftId` and `draftVersion` (added to `State2AnalysisProps` in Task 1.4). Two options:
   - **Option A (preferred)**: Create the save callback in State2Analysis and pass it as `onSaveDiscoveryState` to BrowserDiscoveryInline → DiscoveryPanel. This keeps BrowserDiscoveryInline unaware of draft persistence.
   - **Option B**: Thread `draftId`/`draftVersion` through to BrowserDiscoveryInline.

   Using Option A:

   ```typescript
   // In State2Analysis
   const handleSaveDiscoveryState = useCallback(
     async (state: CrawlDraftDiscoveryState) => {
       if (!draftId || !draftVersion) return;
       try {
         await updateCrawlDraft(draftId, { version: draftVersion, discoveryState: state });
       } catch {
         // Best-effort — don't block discovery for save failures
       }
     },
     [draftId, draftVersion],
   );
   ```

3. `State2Analysis` passes `onSaveDiscoveryState` to `BrowserDiscoveryInline` as a new prop.

4. `BrowserDiscoveryInline` passes `onSaveDiscoveryState` through to `DiscoveryPanel`:
   ```typescript
   <DiscoveryPanel
     ...existing props...
     onSaveDiscoveryState={onSaveDiscoveryState}
   />
   ```

**Props added to each component**:

- `State2AnalysisProps`: `draftId?: string`, `draftVersion?: number` (Task 1.4)
- `BrowserDiscoveryInlineProps`: `onSaveDiscoveryState?: (state: CrawlDraftDiscoveryState) => void`
- `DiscoveryPanel`: already has the prop (line 75) — just needs the value passed

  1.6. **Add i18n key namespace stubs** — reserve `search_ai.crawl_flow.strategy.*`, `search_ai.crawl_flow.resume.*`, `search_ai.crawl_flow.scope.*` in `packages/i18n/locales/en/studio.json`.

**Files Touched**:

- `packages/database/src/models/crawl-draft.model.ts` — add discoveryState + strategy fields
- `apps/studio/src/api/crawl.ts` — extend updateCrawlDraft param type
- `apps/search-ai/src/routes/crawl-drafts.ts` — add strategy to Zod
- `apps/studio/src/components/search-ai/crawl-flow/types.ts` — new types, remove dead InterventionType values
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — wire onSaveDiscoveryState
- `packages/i18n/locales/en/studio.json` — namespace stubs

**Exit Criteria**:

- [ ] `discoveryState` survives a Mongoose roundtrip (save + find returns the field)
- [ ] `strategy` field accepted by all 3 layers (API client, Zod, Mongoose)
- [ ] Auto-save callback fires every 30s during active discovery and persists state
- [ ] `InterventionType` no longer includes `background` or `edit-pause`
- [ ] `pnpm build --filter=database --filter=search-ai --filter=studio` succeeds
- [ ] Commit: `fix(database): add discoveryState and strategy to crawl draft Mongoose schema`

**Rollback**: Revert schema additions (backward compatible — field is optional with null default).

---

### Phase 2: Depth-Prober Loop Refactor — ~1 day

**Goal**: Refactor the Phase 2 breadcrumb-climb loop from `for...of sortedCrumbs` to a dynamic `while` loop with `Breadcrumb[]` queue, enabling proper command queue integration. This is a pure `refactor()` commit — zero behavior change when no commands are queued.

**Why separate from Phase 3**: The loop refactor is the highest-risk change in the entire LLD. Isolating it as a `refactor()` commit means it can be independently tested and bisected.

**Current code** (depth-prober.ts:496-650):

```typescript
const sortedCrumbs = [...allBreadcrumbs].sort((a, b) => a.depth - b.depth);
for (const crumb of sortedCrumbs) {
  // ... visit crumb, discover new crumbs
  sortedCrumbs.push(newCrumb);      // mutates during iteration (line 560)
  sortedCrumbs.sort((a, b) => ...); // re-sorts (line 564)
}
```

**Refactored code**:

```typescript
const pendingCrumbs: Breadcrumb[] = [...allBreadcrumbs].sort((a, b) => a.depth - b.depth);
const skippedUrls = new Set<string>();

while (pendingCrumbs.length > 0) {
  const crumb = pendingCrumbs.shift()!;
  // ... same visit logic, but:
  // - New crumbs: pendingCrumbs.push(newCrumb) then re-sort
  // - Skip check: if (skippedUrls.has(normalizeUrl(crumb.href))) continue
  // - Command check: checkCommandQueue() between iterations (existing)
}
```

**Phase 3 additions that MUST survive the refactor** (verified in code):

- `previouslyVisitedUrls` pre-seeds `visitedUrls` (line 267) — **SAFE**: lives outside the loop
- `resumedFrom` progress field (lines 298-304) — **SAFE**: set before loop starts
- `lastSkipReason` (line 511) — **MUST PRESERVE**: inside the loop
- `yieldReason` (lines 367-374) — **SAFE**: separate from breadcrumb loop
- `autoAddReason` (lines 867-871) — **SAFE**: in Phase 5 projection, not Phase 2
- `hubYields` (lines 544-551, 624-631) — **MUST PRESERVE**: inside the loop

**Tasks**:

2.1. Replace `for (const crumb of sortedCrumbs)` (line 498) with `while (pendingCrumbs.length > 0)`:

- `const pendingCrumbs: Breadcrumb[] = [...allBreadcrumbs].sort((a, b) => a.depth - b.depth);`
- `const skippedUrls = new Set<string>();`
- `while (pendingCrumbs.length > 0) { const crumb = pendingCrumbs.shift()!; ... }`

  2.2. Replace the dynamic mutation (lines 556-564) to use `pendingCrumbs`:

```typescript
// Was: sortedCrumbs.push(newCrumb); sortedCrumbs.sort(...);
// Now:
pendingCrumbs.push(newCrumb);
pendingCrumbs.sort((a, b) => a.depth - b.depth);
```

2.3. Add `skippedUrls` check at loop top (before the existing `visitedUrls` check):

```typescript
if (skippedUrls.has(normalizeUrl(crumb.href))) {
  progress.lastSkipReason = { skipType: 'user-skipped', normalizedUrl: normalizeUrl(crumb.href) };
  continue;
}
```

2.4. Extend existing command handling (lines 503-507) to populate `skippedUrls`:

```typescript
const cmd = checkCommandQueue();
if (cmd) {
  if (cmd.type === 'stop') break;
  if (cmd.type === 'skip-branch' && cmd.payload?.url) {
    skippedUrls.add(normalizeUrl(cmd.payload.url));
    if (normalizeUrl(cmd.payload.url) === normalizeUrl(crumb.href)) continue;
  }
}
```

2.5. Preserve all existing behavior: `hasBudget()` check, `maxDepth` check, `visitedUrls` check, `lastSkipReason`, `hubYields`, hub sibling exploration, breadcrumb merging.

2.6. **Narrow command-queue types** — `apps/crawler-mcp-server/src/explore/command-queue.ts`:

Remove `add-to-scope` and `add-children-to-scope` from `Intervention.type` union (line 10-19):

```typescript
type:
  | 'stop'
  | 'add-sample'
  | 'explore-branch'
  | 'skip-branch'
  | 'explore-all'
  | 'undo-skip';
```

2.7. **Narrow server.ts CommandSchema** — remove `add-to-scope` and `add-children-to-scope` from `CommandSchema` Zod (line 655-665).

2.8. **Narrow search-ai interventionSchema** — remove `add-to-scope` and `add-children-to-scope` from `interventionSchema` Zod (line 585-603).

2.9. **Fix pre-existing tech debt**: Replace the local `createLogger` wrapper in `command-queue.ts` (lines 30-38) that uses `console.error` with the platform logger. The platform rule is "No console.log/error in server code". Since we're modifying this file anyway, fix opportunistically. Note: `crawler-mcp-server` may not have the `@abl/compiler/platform` logger — check if it uses a local logger pattern and align with that.

**Files Touched**:

- `apps/crawler-mcp-server/src/explore/depth-prober.ts` — loop refactor
- `apps/crawler-mcp-server/src/explore/command-queue.ts` — narrow Intervention type
- `apps/crawler-mcp-server/src/server.ts` — narrow CommandSchema
- `apps/search-ai/src/routes/crawl-browser-discover.ts` — narrow interventionSchema

**Exit Criteria**:

- [ ] `for (const crumb of sortedCrumbs)` replaced with `while (pendingCrumbs.length > 0)` using `Breadcrumb[]`
- [ ] `skippedUrls: Set<string>` initialized and checked (with `normalizeUrl()`)
- [ ] New breadcrumbs dynamically pushed + re-sorted (same behavior as before)
- [ ] `previouslyVisitedUrls`, `resumedFrom`, `lastSkipReason`, `hubYields` all preserved
- [ ] `hasBudget()` and `maxDepth` checks preserved
- [ ] `Intervention` type narrowed to 6 backend commands (all 3 schemas aligned)
- [ ] `pnpm build --filter=crawler-mcp-server --filter=search-ai` succeeds
- [ ] Existing depth-prober tests pass (no regressions)
- [ ] Commit: `refactor(crawler): convert breadcrumb loop to dynamic queue with Breadcrumb[] type`

**Rollback**: Revert depth-prober.ts loop section (command-queue.ts type narrowing is safe to keep).

---

### Phase 3: Backend Intervention Completion — ~1 day

**Goal**: Extend `checkCommandQueue` in depth-prober to handle all 6 backend command types. The loop refactor from Phase 2 provides `pendingCrumbs` and `skippedUrls` that commands can manipulate.

**Architecture**: Steering commands modify the exploration queue mid-stream. Iteration commands (`add-sample-and-discover`, `explore-remaining`) use Phase 3's stop+restart pattern — handled entirely in the frontend. This phase only handles backend steering.

**Tasks**:

3.1. Add module-level constant and helper to depth-prober.ts:

```typescript
/** Max URLs queued by a single explore-all command (design doc §6.6, I-6) */
const MAX_EXPLORE_ALL_URLS = 20;

/** Derive a readable label from a URL path — last segment, decoded */
function urlToLabel(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || path);
  } catch {
    return url;
  }
}
```

3.2. Extend the `checkCommandQueue` consumption in depth-prober's Phase 2 loop to handle all commands:

```typescript
const cmd = checkCommandQueue();
if (cmd) {
  switch (cmd.type) {
    case 'stop':
      // Break out of loop entirely
      break; // (need to set a flag since we're in a switch)

    case 'skip-branch':
      if (cmd.payload?.url) {
        skippedUrls.add(normalizeUrl(cmd.payload.url));
        // If current crumb is the skipped one, continue to next
        if (normalizeUrl(cmd.payload.url) === normalizeUrl(crumb.href)) continue;
      }
      break;

    case 'explore-branch':
      if (cmd.payload?.url) {
        // Insert at front of queue — high priority pivot
        pendingCrumbs.unshift({
          href: cmd.payload.url,
          text: urlToLabel(cmd.payload.url), // Derive readable label from URL path
          depth: crumb.depth, // Same depth as current context
        });
      }
      break;

    case 'add-sample':
      if (cmd.payload?.url) {
        // Add to end of queue — will be visited after current pending
        pendingCrumbs.push({
          href: cmd.payload.url,
          text: urlToLabel(cmd.payload.url),
          depth: 0, // Samples start at root depth
        });
      }
      break;

    case 'explore-all':
      if (cmd.payload?.urls) {
        const urls = cmd.payload.urls
          .filter((u) => !visitedUrls.has(normalizeUrl(u)))
          .slice(0, MAX_EXPLORE_ALL_URLS); // Module-level constant = 20 (§6.6)
        for (const url of urls) {
          pendingCrumbs.unshift({
            href: url,
            text: urlToLabel(url),
            depth: crumb.depth,
          });
        }
      }
      break;

    case 'undo-skip':
      if (cmd.payload?.url) {
        skippedUrls.delete(normalizeUrl(cmd.payload.url));
        pendingCrumbs.push({
          href: cmd.payload.url,
          text: urlToLabel(cmd.payload.url),
          depth: crumb.depth,
        });
      }
      break;
  }
}
```

3.3. Handle `stop` command properly — since we're inside a `switch` inside a `while`, `break` only breaks the switch. Use a `shouldStop` flag:

```typescript
let shouldStop = false;
while (pendingCrumbs.length > 0 && !shouldStop) {
  // ... command handling:
  case 'stop':
    shouldStop = true;
    break;
  // ...
  if (shouldStop) break;
}
```

3.4. Add command queue check to **Phase 1** (sample visits) — between each sample URL visit (after line 485):

```typescript
// Check for stop during sample phase
const cmd = checkCommandQueue();
if (cmd?.type === 'stop') break;
```

3.5. **Process all queued commands per iteration** — commands may accumulate while a page visit takes 2-5 seconds. Drain the queue each iteration, but stop draining immediately if a `stop` command is encountered:

```typescript
// Drain all pending commands before each page visit
let cmd: Intervention | undefined;
while (!shouldStop && (cmd = checkCommandQueue()) !== undefined) {
  // handle each command... (stop sets shouldStop = true, breaking the drain)
}
```

3.6. Add structured logging for every command processed.

**Files Touched**:

- `apps/crawler-mcp-server/src/explore/depth-prober.ts` — extend command switch, add Phase 1 check, drain loop

**Exit Criteria**:

- [ ] `explore-branch` command causes depth-prober to visit the specified URL next (unshift to front)
- [ ] `add-sample` command adds URL to exploration queue (push to back)
- [ ] `explore-all` command queues up to 20 URLs (deduped against visited), visits them next
- [ ] `undo-skip` removes URL from skip set and re-queues it
- [ ] `stop` command breaks the loop (works in Phase 1 sample visits and Phase 2 breadcrumb climb)
- [ ] Multiple queued commands are all processed (drain loop)
- [ ] All command processing has structured logging
- [ ] `hasBudget()` still respected — commands can add URLs but can't exceed visit budget
- [ ] `pnpm build --filter=crawler-mcp-server` succeeds
- [ ] Existing tests pass (no regressions)
- [ ] Commit: `feat(crawler): complete backend intervention handling for all 6 command types`

**Rollback**: Revert depth-prober.ts command switch (loop structure from Phase 2 unchanged).

---

### Phase 4: Frontend Intervention Dispatch — ~1.5 days

**Goal**: `handleDiscoveryAction` in BrowserDiscoveryInline dispatches all intervention types correctly. Backend commands POST to the intervention endpoint. Frontend-only operations (scope) are handled client-side.

**Tasks**:

4.1. **Add `sendBrowserIntervention`** to `apps/studio/src/api/crawl.ts`:

```typescript
export async function sendBrowserIntervention(
  exploreId: string,
  intervention: {
    type: BackendInterventionType;
    payload?: { url?: string; urls?: string[]; maxDepth?: number };
  },
): Promise<void> {
  const response = await apiFetch(crawlUrl(`/discover/browser/${exploreId}/intervention`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intervention),
  });
  if (response.status === 429) {
    throw new Error('QUEUE_FULL');
  }
  if (response.status === 404) {
    throw new Error('NOT_FOUND');
  }
  if (!response.ok) {
    throw new Error('INTERVENTION_FAILED');
  }
}
```

4.2. **Extend `handleDiscoveryAction`** in `BrowserDiscoveryInline.tsx` — replace the current minimal handler (lines 146-162).

**Note on async**: The handler changes from sync to async. `DiscoveryPanelProps.onAction` is typed as `(action: ConsoleAction) => void`. An async function returning `Promise<void>` is assignment-compatible with `void` return type in TypeScript — this is safe. Fire-and-forget semantics are correct here since errors are caught internally.

```typescript
const handleDiscoveryAction = useCallback(
  async (action: ConsoleAction) => {
    if (action.type === 'intervention') {
      const intervention = action.intervention;
      const exploreId = exploreIdRef.current;

      // Backend steering commands — POST to intervention endpoint
      if (
        [
          'stop',
          'skip-branch',
          'explore-branch',
          'add-sample',
          'explore-all',
          'undo-skip',
        ].includes(intervention.type) &&
        exploreId
      ) {
        try {
          if (intervention.type === 'stop') {
            await handleStop();
            return;
          }
          await sendBrowserIntervention(exploreId, {
            type: intervention.type as BackendInterventionType,
            payload: intervention.payload,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'QUEUE_FULL') {
            // Show toast: "Command queue full — wait a moment"
          } else if (msg === 'NOT_FOUND') {
            // Discovery ended — show toast
          }
        }
        return;
      }

      // Frontend-only scope operations
      if (intervention.type === 'add-to-scope' || intervention.type === 'add-children-to-scope') {
        // Handled in DiscoveryPanel via scope state — no backend POST
        return;
      }
    }

    if (action.type === 'decision-card') {
      const card = action.card;
      if (card.action.type === 'proceed-to-crawl') {
        onClose();
      }
    }
  },
  [handleStop, onClose],
);
```

4.3. **Add override warning** — before dispatching `explore-branch` or `explore-all`, check the latest progress for yield trend:

```typescript
// In DiscoveryPanel.tsx — before dispatching explore-branch/explore-all
if (progress?.yieldInfo?.trend === 'declining' || progress?.yieldInfo?.trend === 'exhausted') {
  // Store data only — handlers defined inline in the override warning dialog render
  setOverrideWarning({
    branch: intervention.payload?.url ?? 'selected branches',
    discoveryRate: `${progress.yieldInfo.recentNewLinks} new in last ${progress.yieldInfo.recentVisits} visits`,
  });
  setPendingIntervention(intervention); // Store the intervention to dispatch on confirm
  return;
  // In render: onConfirm={() => { dispatch(pendingIntervention); setOverrideWarning(null); }}
  //            onCancel={() => setOverrideWarning(null)}
}
```

4.4. **Console feedback entries** — after each intervention POST succeeds, add a console entry via the existing console dispatch mechanism. Messages per type:

- `explore-branch`: "Redirecting to {url}..."
- `skip-branch`: "Skipped {url}"
- `explore-all`: "Queued {N} URLs for exploration"
- `undo-skip`: "Restored {url} — will be explored"
- `add-sample`: "Added sample: {url}"

  4.5. Add i18n keys for intervention feedback and override warning (~15 keys).

**Files Touched**:

- `apps/studio/src/api/crawl.ts` — add sendBrowserIntervention
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — full dispatch switch
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx` — override warning state + dialog
- `packages/i18n/locales/en/studio.json` — intervention + warning keys

**Exit Criteria**:

- [ ] Every tree node action dispatches the correct intervention type
- [ ] Backend interventions POST to intervention endpoint and reach depth-prober
- [ ] Frontend-only interventions (add-to-scope, add-children-to-scope) update scope without POST
- [ ] Override warning appears when user overrides declining yield
- [ ] Console shows feedback entry for every intervention
- [ ] Error handling: 429 → "Command queue full" toast, 404 → "Discovery ended" toast
- [ ] `explore-branch` no longer calls `handleStop` (which closed the panel)
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Commit: `feat(studio): implement full intervention dispatch with backend POST and override warning`

**Rollback**: Revert BrowserDiscoveryInline.tsx handleDiscoveryAction + DiscoveryPanel.tsx override warning.

---

### Phase 5: Strategy Selection (D7) — ~1.5 days

**Goal**: After profiling completes, user sees strategy cards and chooses their approach before discovery begins.

**Tasks**:

5.1. Create `StrategySelector.tsx` (~180 LOC):

- Props: `profile: ProfileResponse`, `sitemapPageCount: number`, `onStrategySelected: (strategy: DiscoveryStrategy) => void`
- Two cards (not three — `discover-all` is deferred):
  - **Crawl Full Sitemap**: Icon Newspaper, subtitle "{N} pages in sitemap", enabled when `profile.hasSitemap && sitemapPageCount > 0`
  - **Guided Discovery**: Icon Compass, subtitle "Steer the system to find what you need", always enabled
- Recommendation badge: sitemap with >50 pages → recommend Sitemap; otherwise → recommend Guided Discovery
- Cards use design tokens: `bg-background-subtle`, `border-default`, hover `border-border-focus`, selected `border-accent`
- Animation: staggered opacity + translateY entry

  5.2. Wire into `State2Analysis.tsx`:

- Add state: `strategySelected: boolean`, `strategy: DiscoveryStrategy | null`
- After profiling completes, show `<StrategySelector>` instead of immediately starting discovery
- On strategy selected:
  - `crawl-sitemap`: Call `onContinue()` to skip discovery and go to configure. Sections already populated from sitemap profiling.
  - `guided-discovery`: Start browser discovery. Hide StrategySelector, show DiscoveryPanel.
- Save strategy to draft: `updateCrawlDraft(draftId, { version, strategy })`

  5.3. Add i18n keys (~10 keys) under `search_ai.crawl_flow.strategy.*`.

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx` — strategy sub-state
- `packages/i18n/locales/en/studio.json` — strategy keys

**Exit Criteria**:

- [ ] After profiling completes, strategy cards appear (2 cards: Sitemap + Guided Discovery)
- [ ] Recommendation badge appears on contextually appropriate card
- [ ] "Crawl Full Sitemap" bypasses discovery, proceeds to configure with sitemap sections
- [ ] "Guided Discovery" starts existing discovery flow
- [ ] Strategy choice persisted to crawl draft
- [ ] Sitemap card disabled when `!profile.hasSitemap`
- [ ] All strings use i18n
- [ ] Cards use design tokens (no hardcoded colors)
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Commit: `feat(studio): add strategy selection cards after profiling (D7)`

**Rollback**: Delete StrategySelector.tsx, revert State2Analysis changes.

---

### Phase 6: Scope Rules — ~1.5 days

**Goal**: Implement scope-flows-down-from-samples. D6 crawl-as-you-discover only crawls URLs whose parent directory matches a sample URL's parent.

**Tasks**:

6.1. Create `discovery/scope-utils.ts` (~120 LOC):

**Precondition**: All `sampleUrls` are validated as absolute URLs before reaching scope-utils (enforced by `z.string().url()` in the backend and `startBrowserExplore` which requires `http://` or `https://`). Wrap `new URL()` calls in try-catch defensively — skip malformed URLs instead of crashing:

```typescript
/** Derive scope from sample URLs — scope flows DOWN from parent of each sample */
export function deriveScope(sampleUrls: string[]): DiscoveryScope {
  const includedPrefixes = sampleUrls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      // Parent directory of sample — scope includes siblings
      const prefix =
        segments.length > 1 ? '/' + segments.slice(0, -1).join('/') : '/' + segments.join('/');
      return [prefix];
    } catch {
      return []; // Skip malformed URLs
    }
  });
  return {
    sampleUrls,
    includedPrefixes: [...new Set(includedPrefixes)],
    excludedPrefixes: [],
    includedSections: [],
  };
}

/** Check if URL is within current scope */
export function isInScope(url: string, scope: DiscoveryScope): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false; // Malformed URL is never in scope
  }
  if (scope.excludedPrefixes.some((p) => path.startsWith(p))) return false;
  if (scope.includedPrefixes.some((p) => path.startsWith(p))) return true;
  if (scope.includedSections.some((s) => path.startsWith(s))) return true;
  return false;
}

/** Add prefix to scope — validates origin matches crawl target (security: cross-origin injection) */
export function addToScope(
  scope: DiscoveryScope,
  prefix: string,
  crawlOrigin: string,
): DiscoveryScope {
  try {
    const prefixOrigin = new URL(prefix.startsWith('/') ? `${crawlOrigin}${prefix}` : prefix)
      .origin;
    if (prefixOrigin !== new URL(crawlOrigin).origin) {
      throw new Error('Cross-origin scope injection blocked');
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Cross-origin')) throw e;
    throw new Error('Invalid URL in addToScope');
  }
  const path = prefix.startsWith('/') ? prefix : new URL(prefix).pathname;
  return {
    ...scope,
    includedSections: [...scope.includedSections, path],
    excludedPrefixes: scope.excludedPrefixes.filter((p) => p !== path), // Remove from excludes if re-adding
  };
}

/** Remove prefix from scope */
export function removeFromScope(scope: DiscoveryScope, prefix: string): DiscoveryScope {
  return {
    ...scope,
    includedSections: scope.includedSections.filter((s) => s !== prefix),
    excludedPrefixes: [...scope.excludedPrefixes, prefix],
  };
}
```

6.2. Create `discovery/__tests__/scope-utils.test.ts` (~150 LOC):

- `deriveScope`: single sample, multiple samples, nested samples, root URL
- `isInScope`: sample subtree (in), parent of sample (out), sibling (out), user-included (in), excluded (out)
- `addToScope` with cross-origin prefix → throw (security)
- Edge cases: overlapping prefixes, trailing slashes

  6.3. Wire scope into `DiscoveryPanel.tsx`:

- Add state: `scope: DiscoveryScope` initialized from `deriveScope(sampleUrls)`
- When user clicks [include] on a [NEW] section → `addToScope`
- When user clicks [exclude] → `removeFromScope`
- Pass scope to tree (visual distinction) and crawl-queue-utils (filtering)
- Persist scope in `CrawlDraftDiscoveryState` (saved by auto-save)

  6.4. Extend `crawl-queue-utils.ts` — `maybeQueueForCrawl`:

- Add optional `scope?: DiscoveryScope` parameter
- Before queuing: if scope provided, check `isInScope(url.href, scope)` — skip if not in scope

  6.5. Visual scope indicators in `DiscoveryTree.tsx`:

- In scope: normal styling
- Out of scope: muted text (`text-muted`), no checkbox, "Add to scope" action
- Parents (discovery hubs): italic, "Discovery hub" label

  6.6. Add i18n keys (~4 keys) under `search_ai.crawl_flow.scope.*`.

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/discovery/scope-utils.ts` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/scope-utils.test.ts` — NEW
- `apps/studio/src/components/search-ai/crawl-flow/discovery/index.ts` — add export
- `apps/studio/src/components/search-ai/crawl-flow/discovery/crawl-queue-utils.ts` — scope-aware filtering
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx` — scope state
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryTree.tsx` — scope visuals
- `packages/i18n/locales/en/studio.json` — scope keys

**Exit Criteria**:

- [ ] `deriveScope(['/support/printers/troubleshooting'])` → prefix `/support/printers`
- [ ] `isInScope('/support/printers/drivers', scope)` → true (child of prefix)
- [ ] `isInScope('/support/scanners/faq', scope)` → false (sibling, not in scope)
- [ ] `isInScope('/support/', scope)` → false (parent, never auto-included)
- [ ] User clicking [include] on "Scanners" section adds `/support/scanners` to scope
- [ ] `maybeQueueForCrawl` skips out-of-scope URLs
- [ ] Tree shows visual distinction for in-scope vs out-of-scope
- [ ] Scope persists to crawl draft and restores on reload
- [ ] scope-utils tests pass: `pnpm test --filter=studio -- scope-utils`
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Commit: `feat(studio): implement scope-flows-down-from-samples with D6 enforcement`

**Rollback**: Delete scope-utils.ts + test, revert DiscoveryPanel/DiscoveryTree/crawl-queue-utils.

---

### Phase 7: Resume Discovery Flow (UJ-18) — ~1.5 days

**Depends on**: Phase 1 (discoveryState persistence), Phase 6 (scope in discoveryState).

**Goal**: User can return to a saved discovery and continue, start fresh, or proceed to crawl.

**Tasks**:

7.1. Add resume check in `CrawlFlowV5.tsx`:

- On draft load (existing `loadDraft` in lines 394-454): check `draft.discoveryState?.savedAt`
- If discoveryState exists and `flowState !== 'submitted'`:
  - Calculate `discoveredCount`, `sectionCount`, `includedCount` from saved state
  - Show `ResumeDiscoveryBanner`

    7.2. Implement resume banner UI:

```
"You left off with {N} discovered pages across {M} sections. {K} sections included."
[Continue Discovery] [Start Fresh] [Proceed to Crawl →]
```

- **Continue Discovery**: Set flowState = `analyzing`, pass `discoveryState` to State2Analysis. Skip profiling (use saved profile), skip strategy selection (already chose Guided Discovery).
- **Start Fresh**: Clear discoveryState: `updateCrawlDraft(draftId, { version, discoveryState: null })`, reset to `url-entry`.
- **Proceed to Crawl**: Use saved sections, skip discovery, set flowState = `configure`.

  7.3. Wire `initialState` prop through the component chain:

- `CrawlFlowV5` → `State2Analysis` (new prop: `initialDiscoveryState`)
- `State2Analysis` → `BrowserDiscoveryInline` (pass through)
- `BrowserDiscoveryInline` → `DiscoveryPanel` (new prop: `initialState`)

  7.4. Implement `restoreDiscoveryState` in `DiscoveryPanel.tsx`:

- Accept optional `initialState: CrawlDraftDiscoveryState` prop
- On mount: if provided, restore treeNodes, discoveredUrls, objectives, navStructure, coverage, scope, iterations
- Console entry: "Restored discovery from {date}. {N} pages, {M} sections."

  7.5. In `State2Analysis.tsx` — when `initialDiscoveryState` is provided:

- Skip profiling phase
- Skip strategy selection
- Go directly to discovery with restored state

  7.6. Add i18n keys (~5 keys) under `search_ai.crawl_flow.resume.*`.

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — resume banner, draft check
- `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx` — skip profiling/strategy on restore
- `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` — pass initialState
- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx` — restoreDiscoveryState
- `packages/i18n/locales/en/studio.json` — resume keys

**Exit Criteria**:

- [ ] Opening a draft with saved discoveryState shows the resume banner
- [ ] "Continue Discovery" restores tree, sections, scope, coverage from saved state
- [ ] "Start Fresh" clears discoveryState and returns to URL entry
- [ ] "Proceed to Crawl" goes directly to configure with saved sections
- [ ] Restored discovery shows console entry with restore timestamp
- [ ] New discovery on top of restored state works (new SSE run, accumulated tree)
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Commit: `feat(studio): implement resume discovery flow with continue/fresh/proceed actions`

**Rollback**: Revert CrawlFlowV5, State2Analysis, BrowserDiscoveryInline, DiscoveryPanel restore changes.

---

### Phase 8: Console Polish — ~0.5 day

**Goal**: FIFO counter and boundary language for transparency (G1).

**Tasks**:

8.1. **FIFO counter** in `DiscoveryConsole.tsx`:

- Track `totalEntries` separately from displayed entries
- When `entries.length >= MAX_CONSOLE_ENTRIES` (200), show: "Showing {displayed} of {total} events"
- Use `text-muted` styling

  8.2. **Boundary language** in `CoverageSummary.tsx` and decision cards:

- When showing content-type results: append "in explored areas"
- Show unexplored branch count: "{K} branches not yet explored may contain more"

  8.3. Add i18n keys (~5 keys).

**Files Touched**:

- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx` — FIFO counter
- `apps/studio/src/components/search-ai/crawl-flow/CoverageSummary.tsx` — boundary language
- `apps/studio/src/components/search-ai/crawl-flow/discovery/decision-utils.ts` — boundary in card text
- `packages/i18n/locales/en/studio.json` — polish keys

**Exit Criteria**:

- [ ] Console shows "Showing 200 of 1,247 events" when FIFO cap hit
- [ ] Coverage categories show "in explored areas" qualifier
- [ ] Unexplored branches count displayed
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Commit: `feat(studio): add FIFO counter and boundary language to discovery console`

**Rollback**: Revert individual component changes (each isolated).

---

## 4. Wiring Checklist

- [ ] `exploreId` flows: search-ai `state.id` → MCP request body → `depthConfig.exploreId` → `checkCommandQueue()`
- [ ] `discoveryState` survives: DiscoveryPanel auto-save → BrowserDiscoveryInline → `updateCrawlDraft` → Zod → Mongoose → MongoDB
- [ ] `strategy` survives: StrategySelector → State2Analysis → `updateCrawlDraft` → Zod → Mongoose → MongoDB
- [ ] All 6 backend command types handled in depth-prober `checkCommandQueue` switch
- [ ] All intervention types dispatched from `handleDiscoveryAction` (6 backend POST + 2 frontend-only scope)
- [ ] `BackendInterventionType` used in all 3 Zod schemas (server.ts, crawl-browser-discover.ts) and `sendBrowserIntervention` API client
- [ ] `sendBrowserIntervention` imported from `api/crawl.ts` in BrowserDiscoveryInline (components never call fetch directly)
- [ ] `StrategySelector` imported and rendered by State2Analysis after profiling
- [ ] Strategy routes: `crawl-sitemap` → configure, `guided-discovery` → discovery panel
- [ ] Scope derived from sample URLs, passed to `maybeQueueForCrawl`, persisted in `discoveryState`
- [ ] `scope-utils.ts` exported from `discovery/index.ts` barrel
- [ ] Resume banner in CrawlFlowV5 when draft has `discoveryState.savedAt`
- [ ] `initialState` threaded: CrawlFlowV5 → State2Analysis → BrowserDiscoveryInline → DiscoveryPanel
- [ ] Override warning in DiscoveryPanel when user overrides declining yield
- [ ] FIFO counter in DiscoveryConsole
- [ ] Boundary language in CoverageSummary and decision cards
- [ ] All new i18n keys used with `useTranslations('search_ai.crawl_flow')`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. `discoveryState` uses `Schema.Types.Mixed` (schemaless). `strategy` is a simple String. Both are optional with null defaults — backward compatible.

### Feature Flags

None. Strategy selection is additive — appears between profiling and discovery. Existing flow unchanged for drafts without strategy.

### Configuration Changes

No new env vars.

### Design Tokens

All new components use semantic tokens:

- StrategySelector: `bg-background-subtle`, `border-default`, hover `border-border-focus`, selected `border-accent`
- Resume banner: `bg-background-muted`, `text-foreground`, `text-accent`
- Override warning: `bg-warning/10`, `text-warning`
- FIFO counter: `text-muted`
- Scope indicators: in-scope `text-foreground`, out-of-scope `text-muted`

### i18n

~30 new keys under `search_ai.crawl_flow`:

- `.strategy.*` (~10) — card titles, subtitles, recommendation
- `.resume.*` (~5) — banner text, action labels
- `.intervention.*` (~8) — console feedback, override warning
- `.scope.*` (~4) — in scope, not in scope, discovery hub
- `.polish.*` (~3) — FIFO counter, boundary language

### Horizontal Scaling Limitation (H-2)

Both `explorations` Map in search-ai and `queues` Map in crawler-mcp-server are in-memory/pod-local. Acceptable for single-pod deployment. Future: Redis-backed command queue (G25).

### TraceEvent Gap (M-4)

No TraceEvent emission for intervention processing. To be addressed with discovery audit trail (G26). Not blocking.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 9 phases complete with exit criteria met
- [ ] `exploreId` plumbing: commands reach depth-prober (Phase 0)
- [ ] `discoveryState` persists through Mongoose roundtrip (Phase 1)
- [ ] Depth-prober loop uses dynamic `Breadcrumb[]` queue (Phase 2)
- [ ] All 6 backend command types work end-to-end (Phase 3)
- [ ] Frontend dispatches all interventions correctly (Phase 4)
- [ ] Strategy selection appears after profiling with correct recommendations (Phase 5)
- [ ] Scope rules: sample subtree in scope, parents out, siblings user-decided (Phase 6)
- [ ] D6 crawl-as-you-discover only crawls in-scope URLs (Phase 6)
- [ ] Resume banner appears, all 3 actions work (Phase 7)
- [ ] Override warning appears on declining yield (Phase 4)
- [ ] FIFO counter + boundary language (Phase 8)
- [ ] All components use design tokens (no hardcoded colors)
- [ ] All user-facing strings use i18n
- [ ] `pnpm build` succeeds across all affected packages
- [ ] No regressions in existing tests
- [ ] scope-utils tests pass (20+ new tests)

### Objective Mapping

| Objective                     | Phase(s)      | How Verified                             |
| ----------------------------- | ------------- | ---------------------------------------- |
| UJ-2 (choose approach)        | Phase 5       | Strategy cards appear, correct routing   |
| UJ-4 (precise selection)      | Phase 6       | Scope rules + section include/exclude    |
| UJ-7 (redirect exploration)   | Phase 3, 4    | explore-branch works end-to-end          |
| UJ-8 (stop anytime)           | Phase 4       | stop intervention (existing, verified)   |
| UJ-9 (point to specific page) | Phase 3, 4    | add-sample works end-to-end              |
| UJ-10 (exclude auto-included) | Phase 3, 4, 6 | skip-branch + scope exclude              |
| UJ-11 (reverse decisions)     | Phase 3, 4    | undo-skip works end-to-end               |
| UJ-12 (know if productive)    | Phase 4       | Override warning with decline rate       |
| UJ-16 (selection contract)    | Phase 6       | Scope-aware D6, pre-ingestion review     |
| UJ-18 (resume later)          | Phase 7       | Resume banner, 3 actions                 |
| G1 (transparency)             | Phase 8       | FIFO counter, boundary language          |
| G2 (intervention)             | Phase 2, 3, 4 | All 6 backend + 2 frontend interventions |
| G3 (no static caps)           | Phase 4       | Override warning, user always wins       |

---

## 7. Open Questions

1. **Strategy selection persistence on back-nav**: When user goes back from configure to analysis, should strategy selection re-appear or be remembered?
   - **DECIDED**: Remembered. Strategy saved to draft. Back-nav restores chosen strategy.

2. **Scope granularity**: For sample `/support/printers/troubleshooting`, should prefix be `/support/printers` (parent) or exact path?
   - **DECIDED**: `/support/printers` — parent directory. Includes siblings of the sample page, which is the intended "scope flows down" behavior.

3. **Resume flow for crawl-sitemap**: If user chose sitemap strategy and left mid-crawl, what does resume show?
   - **DECIDED**: Crawl progress if crawl started (`draft.crawlJobId` exists). Strategy selection if not yet started.

4. **explore-all URL cap**: Frontend caps payload to 20 URLs (§6.6). Backend enforces same via `slice(0, 20)`. If >20 siblings, truncate and show toast.
   - **DECIDED**: 20-URL cap, both layers.

5. **`discover-all` strategy**: Design doc §22 mentions 3 strategies but `discover-all` has no implementation plan.
   - **DECIDED**: Deferred. Only `crawl-sitemap` and `guided-discovery` for this phase. No "Coming Soon" card — just don't show it.

---

## 8. Deferred Items

| Item                                   | Objective      | Risk of Deferral                                                                      | Priority for Next Cycle |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| G11 (robots.txt compliance)            | Compliance     | Medium — crawling without respecting robots.txt could cause legal issues or IP blocks | **HIGH**                |
| G12 (per-URL error surface)            | UX quality     | Low — errors are logged but not surfaced to user                                      | Medium                  |
| G7 (predictable timing)                | UX quality     | Low — timing estimates are nice-to-have, not blocking                                 | Low                     |
| G5 (auto-generated scope)              | UX convenience | Low — manual scope selection works                                                    | Low                     |
| G4 (complete extraction)               | Data quality   | Low — extraction preview catches major issues                                         | Low                     |
| `discover-all` strategy                | UJ-2 variant   | Low — guided-discovery covers the use case                                            | Low                     |
| Progressive page-level disclosure (R2) | UJ-4 detail    | Low — section-level selection is sufficient                                           | Low                     |
| TraceEvent emission (M-4)              | Observability  | Low — no audit trail yet                                                              | Low                     |
