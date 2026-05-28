# agents.md — apps / crawler-mcp-server

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-23 — Discovery Panel Implementation (Crawler UX)

**Category**: architecture
**Learning**: `depth-prober.ts` enriches progress events with `currentUrl`, `discoveredOnPage[]`, `siblings[]`, `currentRole`, `yieldTrend`. These fields are consumed by the frontend DiscoveryPanel to build the tree, console, and coverage views. The YieldTracker (`yield-tracker.ts`) provides adaptive stopping signals — `shouldContinue()` replaces static page caps. Both are in `src/explore/` (formerly `src/intelligence/`).
**Files**: `src/explore/depth-prober.ts`, `src/explore/yield-tracker.ts`, `src/explore/nav-extractor.ts`
**Impact**: Any change to progress event shape must be coordinated with Studio's `BrowserExploreProgress` type in `apps/studio/src/lib/api/crawl.ts`.

**Category**: gotcha
**Learning**: This package uses `console.error` for logging because it does not have access to `@abl/compiler/platform`'s `createLogger`. If platform logger is ever added as a dependency, migrate all `console.error` calls to structured logging.
**Files**: `src/explore/depth-prober.ts`, `src/explore/nav-extractor.ts`
**Impact**: Don't flag console.error as a bug in this package — it's the only available logging mechanism.

**Category**: pattern
**Learning**: `nav-extractor.ts` uses Playwright to hover over nav elements and discover mega-menus. It emits a `nav-extracted` SSE event that the frontend processes separately from progress events. The extraction runs once at the start of depth probing and populates the tree with `projected` confidence nodes.
**Files**: `src/explore/nav-extractor.ts`
**Impact**: Nav extraction is time-bounded and best-effort — don't depend on it always succeeding.

## 2026-05-10 — BFS Discovery Engine (Discovery Build 1, T-2)

**Category**: architecture
**Learning**: `bfs-discovery.ts` is the core BFS orchestrator that replaces the older `depth-prober.ts` approach. It runs 5 phases (0, 1a, 1b, 2, 3) and emits typed `BfsProgressEvent` union events for SSE streaming. Phase 3 uses `yield-tracker.ts` for adaptive stopping. The engine checks the `command-queue.ts` between every page visit for user interventions (stop, explore-branch, explore-all, skip-branch).
**Files**: `src/explore/bfs-discovery.ts`, `src/explore/url-normalizer.ts`
**Impact**: BFS event types (`BfsPhaseEvent`, `BfsPageVisitEvent`, etc.) will need corresponding frontend types in Studio.

**Category**: gotcha
**Learning**: The package has its own `createLogger` in `src/logger.ts` (used by `command-queue.ts`), but `nav-extractor.ts` defines its own inline logger using `console.error`. `bfs-discovery.ts` uses `console.error` only in the finally block for cleanup failures, matching the package convention.
**Files**: `src/logger.ts`, `src/explore/bfs-discovery.ts`
**Impact**: When adding new files, check whether to import from `../logger.js` or use `console.error` directly — both patterns exist.

**Category**: pattern
**Learning**: `url-normalizer.ts` provides 4 pure functions (`normalizeUrl`, `isSameDomain`, `extractDomain`, `urlToLabel`) used by the BFS engine for URL deduplication and tree label generation. All functions are error-safe (return sensible defaults on parse failure).
**Files**: `src/explore/url-normalizer.ts`
**Impact**: Always normalize URLs through `normalizeUrl()` before using them as map keys to avoid duplicates from trailing slashes, fragments, or tracking params.

## 2026-05-10 — BFS REST Endpoints (Discovery Build 1, T-3)

**Category**: pattern
**Learning**: BFS discovery routes (`POST /api/bfs-discover`, `POST /api/bfs-discover/:id/command`) follow the same SSE pattern as `/api/explore` and `/api/explore-deep`. Key difference: BFS events are throttled at 300ms (vs 200ms for explore), and phase/complete/error events are always sent immediately without throttling. The `result` SSE event serializes `Map` as entries array since JSON.stringify cannot handle Maps.
**Files**: `src/server.ts`, `src/explore/bfs-discovery.ts`
**Impact**: Frontend consuming BFS SSE must deserialize `discoveredUrls` from `[key, value][]` entries back into a Map.

## 2026-05-10 — BFS Engine Tests (Discovery Build 1, T-5)

**Category**: testing
**Learning**: BFS engine integration tests use a mock Playwright `Page` created via factory function (not `vi.mock`), compliant with codebase test rules. The mock's `evaluate()` uses pattern matching on string-based script content to return appropriate minimal data for internal modules (nav-extractor, breadcrumb-extractor, page-classifier, navigation-explorer). This lets all internal modules execute without errors while returning empty results.
**Files**: `src/explore/__tests__/bfs-discovery.test.ts`, `src/explore/__tests__/url-normalizer.test.ts`
**Impact**: When adding new `page.evaluate()` calls in internal modules with novel string patterns, the mock Page in `bfs-discovery.test.ts` may need a new pattern-match case added to its evaluate handler.

**Category**: gotcha
**Learning**: Pre-existing `logging-contract.test.ts` failure exists because `bfs-discovery.ts` uses `console.error` on line 1152 (session cleanup catch block). This is consistent with the package convention but flagged by the contract test.
**Files**: `src/__tests__/logging-contract.test.ts`, `src/explore/bfs-discovery.ts`
**Impact**: If fixing the logging contract, replace the `console.error` in bfs-discovery.ts with the package's `createLogger` from `src/logger.ts`.

## 2026-05-11 — Discovery Tree Redesign (T-1: Backend Tree Engine)

**Category**: architecture
**Learning**: BFS event model changed from incremental (tree-update, page-visit, url-discovered) to snapshot-based (tree-snapshot, progress). The engine now rebuilds the full tree on phase transitions and every 5s via `setInterval`, with a size guard at 10K URLs. `emitProgress()` is throttled at 300ms for lightweight counter updates. `findClosestAncestor` now uses O(d) Map lookups via `pathToUrlMap` instead of O(n\*d) linear scans.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: Frontend consumers must handle `tree-snapshot` and `progress` events instead of `tree-update`, `page-visit`, `url-discovered`. The `complete` event now includes `tree: TreeNode[]`.

**Category**: gotcha
**Learning**: `normalizeUrl` now strips `www.` prefix. This means `www.example.com` and `example.com` normalize to the same URL. `isSameDomain` also strips `www.` before comparison. This is critical for dedup correctness — sites using mixed www/non-www links will no longer produce duplicates.
**Files**: `src/explore/url-normalizer.ts`
**Impact**: All URL comparisons in the engine benefit from www normalization automatically.

**Category**: pattern
**Learning**: `TreeNode` is now enriched with `visited`, `renderMethod`, `pageRole?`, `status` fields populated from `DiscoveredPage`. The `buildTree` function uses a `pathToUrlMap: Map<pathname, url>` for O(d) ancestry lookup. Orphan URLs (no ancestor found) attach to root node rather than becoming spurious root nodes.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: `TreeNode` type is exported and consumed by server.ts, search-ai proxy, and studio frontend. Any consumer expecting the old 4-field TreeNode must be updated.

**Category**: gotcha
**Learning**: The snapshot timer (`setInterval`) must be cleared in ALL exit paths. The implementation clears in: `buildResult()`, `checkStop()` (user-stop, url-cap), yield-limit break, catch block, and finally block. `clearSnapshotTimer()` is idempotent (checks for null). Missing any path would leak timers.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: When adding new exit paths to the BFS engine, always call `clearSnapshotTimer()`.

**Category**: pattern
**Learning**: `bfsQueueSet: Set<string>` was added alongside `bfsQueue: string[]` for O(1) dedup checks. The array is kept for ordered iteration; the Set is used only for `has()` checks when adding new URLs. Both must be kept in sync (add to both when pushing).
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: When modifying Phase 3 queue logic, remember to update both `bfsQueue` and `bfsQueueSet`.

## 2026-05-11 — Engine Fixes (Discovery Tree V2, T-3)

**Category**: architecture
**Learning**: `checkStop()` now returns `{ stopped: boolean; exploreBranchUrls: string[] }` instead of `boolean`. All 8 call sites must destructure this. Only Phase 1b and Phase 3 should enqueue `exploreBranchUrls` (they have active visit queues). Other phases discard them.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: Any new checkStop() call site must handle the object return type and decide whether to enqueue exploreBranchUrls.

**Category**: gotcha
**Learning**: The snapshot timer now starts after Phase 0 (not Phase 3). Phase 3 no longer creates its own timer. There's only one timer instance managed by `snapshotInterval` variable.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: Don't add a second timer start in Phase 3 — it already runs from after Phase 0.

**Category**: pattern
**Learning**: `discoverySource` tracks provenance (how a URL was first found), while `foundOn` tracks which pages link to it. Synthetic values like `'seed'`, `'breadcrumb-climb'`, `'user-command'` belong in `discoverySource`, NOT in `foundOn`. `foundOn` should only contain real page URLs.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: When registering new URLs, set `discoverySource` for provenance and `foundOn` for real referring page URLs only.

**Category**: gotcha
**Learning**: `stoppedBy` union has 5 values: `'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout'`. Must be updated in 3 locations: `BfsCompleteEvent`, `BfsDiscoveryResult.stats`, and the local variable in `runBfsDiscovery`.
**Files**: `src/explore/bfs-discovery.ts`
**Impact**: Adding new stop reasons requires updating all 3 type locations.
