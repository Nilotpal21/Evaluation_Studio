# Sitemap Intelligence — Task Tracker

**HLD:** `docs/specs/sitemap-intelligence.hld.md`
**User Journeys:** `docs/specs/sitemap-intelligence-user-journeys.md`
**Workflow:** Sequential — mini-LLD → review → implement → review → next task

## Execution Order

```
T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7
```

## Integration Review Protocol

From T-2 onwards, every task's LLD and implementation review MUST verify integration with all previously completed tasks:

- **LLD review:** Does the design correctly consume outputs from prior tasks? Are types/shapes compatible?
- **Impl review:** Does the code actually wire to prior task outputs? Can you trace data end-to-end from T-1 through current task?

## Tasks

### T-1: Profiler sitemap intelligence

- **Package:** `packages/crawler`
- **Files:** `fast-profiler.ts`, `interfaces.ts`, `fast-profiler.test.ts`
- **Status:** ✅ Complete
- **LLD:** Inline (mini-LLD in session)
- **Commit:** Pending (will batch with T-2)
- **Integration:** N/A (first task)
- **Changes:** Added `SitemapDiscoveryResult`, `SitemapDiscoveryStep`, `SitemapFile` types to interfaces.ts. Refactored `extractSitemapUrls` to return structured result instead of `string[]`. Added `parseSitemapDirectives` for robots.txt parsing. Refactored `fetchSitemapUrls` → `fetchSitemapFiles` with provenance. Profile() now wires robots.txt sitemaps and stores `sitemapDiscovery` in metadata. All 997 tests pass.

### T-2: Profile + cluster endpoints

- **Package:** `apps/search-ai`
- **Files:** `crawl.ts`, `intelligence.ts`
- **Status:** ✅ Complete
- **LLD:** Inline (mini-LLD in session)
- **Commit:** Pending (will batch)
- **Integration check:** ✅ T-1's SitemapDiscoveryResult consumed by profile endpoint (maps sitemapDiscovery to response), cluster endpoint (uses .allUrls, tags groups with sitemapFile/sitemapOrigin), preview-urls endpoint (.allUrls), batch expand (.allUrls), intelligence.ts (.allUrls). All 4 call sites updated. Build passes clean.

### T-3: Validate-sitemap endpoint

- **Package:** `apps/search-ai`
- **Files:** `crawl.ts`
- **Status:** ✅ Complete
- **LLD:** Inline
- **Commit:** Pending
- **Integration check:** ✅ Reuses T-1's extractSitemapUrls with additionalSitemapUrls param. Route mounts at POST /validate-sitemap alongside T-2's changes. Response shape: `{ valid, urlCount, sitemapFiles, type, error? }` — ready for T-6's validateSitemap() API. Error classification: timeout/unreachable/invalid/no_urls.

### T-4: Frontend types + mapper + draft round-trip

- **Package:** `apps/studio`
- **Files:** `types.ts`, `api/crawl.ts`, `CrawlFlowV5.tsx`
- **Status:** ⬜ Not started
- **LLD:** —
- **Commit:** —
- **Integration check:** T-2 profile response → ProfileResponse type, T-2 cluster response → UrlGroup type, draft round-trip preserves sitemapFile/sitemapOrigin

### T-5: Profiling discovery trail UI

- **Package:** `apps/studio`
- **Files:** New `ProfilingTrail.tsx`, `State2Analysis.tsx`, i18n `studio.json`
- **Status:** ✅ Complete
- **LLD:** Inline (mini-LLD in session)
- **Commit:** Pending (will batch)
- **Integration check:** ✅ T-4 ProfileResponse.sitemapDiscovery → ProfilingTrail props (SitemapDiscovery type). Renders ABOVE StrategySelector, same gate (`pipelinePhase === 'idle' && profile`). Steps use SitemapDiscoveryStep shape from T-1→T-2→T-4. Badge shows file count + total URLs from T-2's profile response mapping. Animation uses shared springs/STAGGER_DELAY. All i18n keys added. tsc --noEmit clean.

### T-6: StrategySelector three-state card

- **Package:** `apps/studio`
- **Files:** `StrategySelector.tsx`, `api/crawl.ts`, `CrawlFlowV5.tsx`, `types.ts`, `State2Analysis.tsx`, i18n `studio.json`
- **Status:** ✅ Complete
- **LLD:** Inline (mini-LLD in session)
- **Commit:** Pending (will batch)
- **Integration check:** ✅ T-3 validate-sitemap endpoint → `validateSitemap()` API function added to `api/crawl.ts` with `ValidateSitemapResponse` type matching backend shape. T-2 cluster re-trigger → `handleCustomSitemapValidated` in CrawlFlowV5 re-runs `clusterUrls` + `sampleGroups` + `mapGroupsToSections`. T-4 card enable/disable → `customValidated` state feeds into `sitemapEnabled` logic. T-5 trail coexistence → ProfilingTrail renders ABOVE StrategySelector, independent. Three-state sitemap card: enabled (normal), needs-help (input), validating. Props threaded: CrawlFlowV5 → State2Analysis → StrategySelector via `onCustomSitemapValidated`. tsc --noEmit clean.

### T-7: Adaptive section grouping

- **Package:** `apps/studio`
- **Files:** `State2Analysis.tsx`
- **Status:** ✅ Complete
- **LLD:** Inline (mini-LLD in session)
- **Commit:** Pending (will batch)
- **Integration check (FULL E2E):** ✅ T-1→T-2→T-4 data flow: `sitemapFile`/`sitemapOrigin` on CrawlSection (T-4) drives adaptive grouping — `hasSitemapGrouping` detects multi-sitemap and switches groupKey from path-segment to sitemapFile. T-6 custom sitemap → sections: re-clustering updates sections with new sitemapFile, grouping adapts. Search filter extended to match `sitemapFile`. Origin badges (`sitemapOrigin`) shown on group headers when sitemap-grouped. tsc --noEmit clean.

## Session Handoff Notes

_Updated after each task completion with commit SHAs, decisions made, and anything the next session needs to know._
