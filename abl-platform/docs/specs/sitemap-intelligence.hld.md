# Sitemap Intelligence — High-Level Design

## What

Enhance the crawl setup flow with sitemap transparency, multi-source discovery, user override, and an animated profiling trail. Today the system checks only `/sitemap.xml`, discards provenance data, and shows users a binary "sitemap found / not found" with no detail. This feature makes the system show its reasoning, discover sitemaps from robots.txt, let users provide custom sitemap URLs, group sections by their source sitemap file, and display the full discovery trail.

**User journeys:** `docs/specs/sitemap-intelligence-user-journeys.md` — 10 journeys, 4 design decisions (D-1 through D-4).

## Architecture Approach

### Packages That Change

| Package            | What Changes                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/crawler` | `fast-profiler.ts` — wire robots.txt sitemaps, preserve per-file provenance, return discovery trail                                                                                                                      |
| `apps/search-ai`   | `crawl.ts` — profile endpoint returns `sitemapDiscovery`, cluster endpoint tags groups with `sitemapFile`, new validate-sitemap endpoint                                                                                 |
| `apps/studio`      | `StrategySelector.tsx` — three-state card. `State2Analysis.tsx` — adaptive grouping, search extension. `CrawlFlowV5.tsx` — wire custom sitemap flow, fix strategy restore on resume. New `ProfilingTrail.tsx` component. |
| `packages/i18n`    | New keys for profiling trail steps, card states, group badges                                                                                                                                                            |

### Data Flow

```
                         POST /profile
User enters URL ──────────────────────────> search-ai
                                              │
                    ┌─────────────────────────┘
                    │ FastProfiler.profile()
                    │   ├── fetchHTML()
                    │   ├── fetchRobotsTxt() ──── NEW: parse Sitemap: directives
                    │   └── extractSitemapUrls()
                    │         ├── /sitemap.xml (existing)
                    │         └── robots.txt sitemaps (NEW)
                    │              └── resolve indexes recursively
                    │                   └── NEW: track per-file provenance
                    │
                    └──> ProfileResponse
                           ├── hasSitemap: boolean (existing, now also true for robots.txt sitemaps)
                           └── sitemapDiscovery: { steps[], sitemapFiles[], totalUrls } (NEW)
                                  │
                    ┌──────────────┘
                    ▼
              Studio receives profile
                    │
                    ├── ProfilingTrail (NEW) ── animated reveal of steps
                    │     └── compacts to expandable summary
                    │
                    ├── StrategySelector
                    │     ├── Sitemap card enabled/disabled (existing logic, now includes robots.txt)
                    │     ├── "I have a sitemap" link (NEW — D-3 State 1)
                    │     ├── Validate input (NEW — D-3 State 2, calls POST /validate-sitemap)
                    │     └── Card transforms to enabled (NEW — D-3 State 3)
                    │
                    └── Phase B: POST /cluster-urls (fire-and-forget)
                          │
                          ├── Backend clusters per-sitemap-file (NEW)
                          │     └── Each UrlGroup tagged with sitemapFile + sitemapOrigin
                          │
                          └── POST /sample-groups (unchanged)
                                │
                                ▼
                          mapGroupsToSections()
                            ├── CrawlSection.sitemapFile (NEW)
                            └── CrawlSection.sitemapOrigin (NEW)
                                  │
                                  ▼
                            State2Analysis SectionChecklist
                              ├── Adaptive grouping (NEW)
                              │     ├── Multi-sitemap: group by sitemapFile
                              │     └── Single-sitemap: group by path-segment (existing)
                              ├── Search matches sitemapFile (NEW)
                              ├── Origin badges on group headers (NEW)
                              └── Footer: sitemap count + dedup count (NEW)
                                    │
                                    ▼
                              State3Configure → handleStartCrawl (UNCHANGED)
```

### Key Integration Points

1. **Profiler → Profile Endpoint** — `SiteProfile` interface gains new fields. Profile endpoint maps them to response.
2. **Profile Endpoint → Frontend** — `ProfileResponse` gains `sitemapDiscovery`. Existing fields unchanged.
3. **Profiler → Cluster Endpoint** — `extractSitemapUrls` return type changes from `string[]` to structured type with provenance. Cluster endpoint consumes the new shape.
4. **Cluster Response → mapGroupsToSections** — `UrlGroup` gains `sitemapFile`/`sitemapOrigin`. Mapper propagates to `CrawlSection`.
5. **CrawlSection → SectionChecklist** — Grouping logic reads `sitemapFile`. Search filter reads `sitemapFile`.
6. **CrawlSection → Draft Persistence** — `sitemapFile`/`sitemapOrigin` added to `CrawlDraftSection` and Zod schema.
7. **CrawlSection → handleStartCrawl** — New fields are **not consumed** by crawl submission. Safe addition.
8. **Draft Resume → Strategy Restore** — Fix existing bug: `selectedStrategy` not restored on resume.

## Decisions & Tradeoffs

### D-1: Animated reveal from single API response (not SSE streaming)

**Chose:** Frontend animated reveal (150-200ms staggered) after profile response arrives.
**Over:** SSE streaming from profile endpoint.
**Because:** Profile call is 2-5s — too short for real streaming benefit. Backend runs three tasks in parallel (HTML, robots, sitemap) so step order is unpredictable. The response already has all the data; presentation is a frontend concern. Zero backend streaming infrastructure needed.

### D-2: Adaptive grouping reusing existing SectionChecklist group UI

**Chose:** Change the `groupKey` derivation based on sitemap count — `sitemapFile` for multi-sitemap, first path segment for single-sitemap.
**Over:** New thin separator rows (passive, non-interactive) or two-level tree (complex).
**Because:** Existing grouped tree view is already polished (collapsible, interactive checkboxes, badges). Users gain sitemap-level include/exclude with one click. Single-sitemap sites (most common) see zero UX change.

### D-3: Three-state card transformation (not dialog, not below-cards input)

**Chose:** Card transforms through Disabled → Input → Enabled states within the same card footprint.
**Over:** Modal dialog for URL input, or a separate input row below the cards.
**Because:** No context switch. The card tells a story. The user stays in strategy selection context throughout.

### D-4: Gzip sitemap support deferred

**Chose:** Not in scope.
**Because:** Independent concern. Can be added to profiler's fetch pipeline later without UI changes.

### D-5: Profiler wires robots.txt internally (not separate frontend call)

**Chose:** `FastProfiler.profile()` internally consults robots.txt `Sitemap:` directives as part of its existing `fetchRobotsTxt()` call.
**Over:** Frontend calling POST `/robots` separately then passing sitemapUrls to the cluster endpoint.
**Because:** The profiler already fetches robots.txt (line 64). It currently discards the content after setting `hasRobotsTxt: boolean`. Parsing Sitemap directives from the already-fetched content is trivial. Keeps the intelligence in the profiler where it belongs. Avoids extra HTTP round trip from frontend.

### D-6: `extractSitemapUrls` return type changes to structured (breaking internal change)

**Chose:** Change `extractSitemapUrls` from returning `string[]` to `SitemapDiscoveryResult` containing per-file URL lists with provenance.
**Over:** Adding a separate method and keeping the old signature.
**Because:** The old return type is the root cause of provenance loss — flattening URLs destroys per-file information. All callers must be updated: `profile()` method (1 call site), cluster-urls endpoint (1 call site). Both are in our scope. No external consumers — this is an internal package API.

### D-7: Fix strategy restore on resume (pre-existing bug, fix in this scope)

The current code does not restore `selectedStrategy` from `draft.strategy` on resume. This is a pre-existing bug, but sitemap intelligence depends on it (the grouping is strategy-aware). Fix it in this scope rather than deferring.

## Task Decomposition

Sequential execution: each task gets its own mini-LLD → implement → review cycle before moving to the next. i18n keys are added within each task as needed (not a separate task). This is the workflow that made Wave 1 (Direct URLs) succeed — thorough exploration, clear LLD per task, implement, review, next.

### Execution Order

| #       | Task                                       | Package(s)         | Est. Files | Description                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------ | ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-1** | Profiler sitemap intelligence              | `packages/crawler` | 3          | Wire robots.txt `Sitemap:` directives into profiler, preserve per-file provenance in `extractSitemapUrls`, return `SitemapDiscoveryResult` with discovery steps + sitemap files list                                                                                                                                                        |
| **T-2** | Profile + cluster endpoints                | `apps/search-ai`   | 2          | Profile endpoint returns `sitemapDiscovery` trail, cluster endpoint tags each `UrlGroup` with `sitemapFile`/`sitemapOrigin`, cross-sitemap dedup with count                                                                                                                                                                                 |
| **T-3** | Validate-sitemap endpoint                  | `apps/search-ai`   | 1          | New POST route: fetch user-provided sitemap URL, parse, validate (XML? has URLs?), return count + error classification. Reuses profiler's `extractSitemapUrls` with single-URL input.                                                                                                                                                       |
| **T-4** | Frontend types + mapper + draft round-trip | `apps/studio`      | 3          | Extend `ProfileResponse`, `CrawlSection`, `CrawlDraftSection`, `UrlGroup` types. Update `mapGroupsToSections` to propagate `sitemapFile`/`sitemapOrigin`. Update `sectionsToDraftSections`/`draftSectionsToSections` for round-trip. Fix strategy restore on resume (D-7). Fix `source` hardcoded to `'sitemap'` (reads `discoveryMethod`). |
| **T-5** | Profiling discovery trail                  | `apps/studio`      | 1          | New `ProfilingTrail.tsx` component: receives `sitemapDiscovery` from profile response, animated reveal of discovery steps (150-200ms stagger), compacts to expandable summary above strategy cards. Wired into State2Analysis.                                                                                                              |
| **T-6** | StrategySelector three-state card          | `apps/studio`      | 2          | Restructure sitemap card from `<motion.button disabled>` to `<div>` with three states (needs-help → input → enabled). Add `validateSitemap()` API function. Wire: validate → on success, re-trigger clustering with user-provided sitemap URL → card becomes enabled.                                                                       |
| **T-7** | Adaptive section grouping                  | `apps/studio`      | 1          | Change SectionChecklist grouping: `sitemapFile` as groupKey when sections have multiple distinct sitemapFiles, else path-segment grouping (existing). Extend search to match `sitemapFile`. Origin badges on group headers. Footer: sitemap count + dedup count.                                                                            |

### Per-Task Workflow

```
For each T-N:
  1. Design mini-LLD (exact files, lines, function signatures, subtasks)
  2. Review LLD — clarify questions if any
  3. Implement subtask by subtask
  4. Review implementation
  5. ✅ Move to T-(N+1)
```

### Task Dependencies

```
T-1 → T-2 → T-3 → T-4 → T-5 → T-6 → T-7
```

Strictly sequential. Each task builds on the previous. No parallel forks — this ensures:

- No file merge conflicts (tasks that share files execute in order)
- Each review catches issues before they propagate
- Context is fresh for each task's LLD

### Files Modified Per Task

| File                                                                   | T-1 | T-2 | T-3 | T-4 | T-5 | T-6 | T-7 |
| ---------------------------------------------------------------------- | --- | --- | --- | --- | --- | --- | --- |
| `packages/crawler/src/profiler/fast-profiler.ts`                       | ✏️  |     |     |     |     |     |     |
| `packages/crawler/src/profiler/interfaces.ts`                          | ✏️  |     |     |     |     |     |     |
| `packages/crawler/src/profiler/__tests__/fast-profiler.test.ts`        | ✏️  |     |     |     |     |     |     |
| `apps/search-ai/src/routes/crawl.ts`                                   |     | ✏️  | ✏️  |     |     |     |     |
| `apps/studio/src/api/crawl.ts`                                         |     |     |     | ✏️  |     | ✏️  |     |
| `apps/studio/src/components/search-ai/crawl-flow/types.ts`             |     |     |     | ✏️  |     |     |     |
| `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`      |     |     |     | ✏️  |     | ✏️  |     |
| `apps/studio/src/components/search-ai/crawl-flow/ProfilingTrail.tsx`   |     |     |     |     | 🆕  |     |     |
| `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx`   |     |     |     |     | ✏️  |     | ✏️  |
| `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx` |     |     |     |     |     | ✏️  |     |
| `packages/i18n/locales/en/studio.json`                                 |     |     |     |     | ✏️  | ✏️  | ✏️  |

No file is modified by two tasks simultaneously — sequential execution eliminates all conflicts.

## Existing Code Reality — What Must Not Regress

### Profiler (`fast-profiler.ts`)

| Current Behavior                                                       | Must Preserve                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `profile()` returns `SiteProfile` with `metadata.hasSitemap`           | ✅ Field still set, now also true when robots.txt sitemaps found                                                    |
| `extractSitemapUrls(url, maxUrls, timeout)` returns `string[]`         | ⚠️ **Return type changes** to `SitemapDiscoveryResult`. Both call sites (profile, cluster-urls) updated in T-1/T-2. |
| Recursive index resolution with cycle protection (`visited` Set)       | ✅ Preserved — enhanced to track per-file provenance                                                                |
| URLs sorted by priority desc, lastmod desc                             | ✅ Preserved within each sitemap file                                                                               |
| `fetchRobotsTxt()` returns content for `hasRobotsTxt` check            | ✅ Preserved — content now also parsed for Sitemap: directives                                                      |
| Max 5 parallel child sitemap fetches                                   | ✅ Preserved                                                                                                        |
| Tests: `packages/crawler/src/__tests__/profiler/fast-profiler.test.ts` | ✅ Must pass. Add new tests for robots.txt sitemaps + provenance.                                                   |

### Profile Endpoint (`crawl.ts` POST /profile)

| Current Behavior                                                                                                          | Must Preserve                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Returns `{ success, domain, siteType, estimatedSize, hasSitemap, jsRequired, avgResponseTime, recommendedStrategy, ... }` | ✅ All existing fields unchanged                |
| `hasSitemap` derived from profiler                                                                                        | ✅ Now also true when robots.txt sitemaps exist |
| `estimatedSize` uses sitemap URL count when available                                                                     | ✅ Now uses total across all sitemap sources    |

### Cluster Endpoint (`crawl.ts` POST /cluster-urls)

| Current Behavior                                                 | Must Preserve                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Three-tier URL resolution (provided → profiler → DiscoveryChain) | ✅ Tier 1 and 3 unchanged. Tier 2 updated to use new `extractSitemapUrls` return. |
| `UrlClusterer.cluster(urls)` produces `UrlGroup[]`               | ✅ Clusterer itself unchanged. Post-clustering, groups tagged with provenance.    |
| `storeBucketUrlsForGroups()` persists full URL lists             | ✅ Unchanged — still operates on flat URL lists                                   |
| Response: `{ success, groups, discoveryMethod, discoverySteps }` | ✅ All existing fields. Groups gain `sitemapFile`/`sitemapOrigin` (additive).     |

### Frontend — CrawlFlowV5

| Current Behavior                                                                   | Must Preserve                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Phase A (blocking): `profileSite()` → show strategy cards                          | ✅ Enhanced: also renders ProfilingTrail                           |
| Phase B (fire-and-forget): `clusterUrls()` → `sampleGroups()` → `setSections()`    | ✅ Enhanced: sections now carry sitemapFile                        |
| Phase B gate: `if (!hasSitemap) skip`                                              | ✅ Still works — `hasSitemap` now true for robots.txt sitemaps too |
| `mapGroupsToSections()` maps UrlGroup to CrawlSection                              | ✅ Enhanced: propagates sitemapFile/sitemapOrigin                  |
| `sectionsToDraftSections()` / `draftSectionsToSections()` round-trip               | ✅ Enhanced: new fields added to both directions                   |
| Draft resume: profile cached, sections restored, pages empty                       | ✅ Preserved. Strategy restore fixed (D-7).                        |
| Direct URLs: `handleDirectUrlsConfigure()` creates section with `source: 'direct'` | ✅ Unchanged — direct URLs have no sitemapFile                     |

### Frontend — StrategySelector

| Current Behavior                                             | Must Preserve                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 3 cards in grid-cols-3 layout                                | ✅ Same layout                                                                                                   |
| `sitemapEnabled` logic: `hasSitemap && sitemapPageCount > 0` | ✅ Same logic — but `hasSitemap` now true for robots.txt sitemaps                                                |
| Recommendation logic: `deriveRecommendation()`               | ✅ Unchanged                                                                                                     |
| Disabled card: `<motion.button disabled>`                    | ⚠️ **Changes to `<div>` with three states** for the sitemap card only. Other two cards remain `<motion.button>`. |
| Click handler: `onStrategySelected(card.key)`                | ✅ Still fires for enabled cards and State 3 of sitemap card                                                     |

### Frontend — State2Analysis SectionChecklist

| Current Behavior                                         | Must Preserve                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Search filter: matches name, pattern, page URLs, titles  | ✅ Enhanced: also matches sitemapFile                                      |
| Grouping: first path segment as groupKey                 | ✅ Preserved for single-sitemap. Changed to sitemapFile for multi-sitemap. |
| Tree view threshold: `> 5` groups + ungrouped            | ✅ Unchanged                                                               |
| Group header: chevron, checkbox, titleCased name, badges | ✅ Enhanced: origin badge added for non-standard sitemaps                  |
| Section row rendering: all existing fields consumed      | ✅ Unchanged — new fields are additive                                     |
| Source badge: `'explored'`, `'auto'`, `'sitemap'`        | ✅ Unchanged                                                               |

### Backend — Draft Persistence (`crawl-drafts.ts`)

| Current Behavior                                                                                                     | Must Preserve                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `sectionSchema` Zod validates: sectionId, pattern, name, source, depth, pageCount, included, estimatedTime, warnings | ✅ Enhanced: add sitemapFile, sitemapOrigin as optional |
| Source enum: `['sitemap', 'explored', 'auto', 'direct']`                                                             | ✅ Unchanged                                            |
| URL bucket persistence: separate collection, linked by draftId + sectionId                                           | ✅ Unchanged                                            |

### Backend — Crawl Submission (`crawl.ts` POST /batch)

| Current Behavior                                                  | Must Preserve                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `sectionMapping` schema: sectionId, pattern, name, urls, strategy | ✅ Unchanged — new fields NOT sent to batch endpoint |
| Crawl job creation from sectionMapping                            | ✅ Unchanged                                         |

## Out of Scope

- Gzip sitemap decompression (D-4 — deferred)
- Sitemap TXT format support
- Alternative sitemap paths beyond `/sitemap.xml` and robots.txt declarations (e.g., common-path probing)
- Sitemap lastmod/priority display in UI (data preserved in backend but not surfaced)
- Sitemap change detection / re-crawl triggers
- Per-URL provenance display (which specific sitemap file a URL came from) — only section-level provenance
- Draft elimination (Wave 8 — separate feature)

## Agents.md Learnings Applied

| Source                              | Learning                                                               | How Applied                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/search-ai/agents.md`          | Route pattern: Zod safeParse, handleError, mount under existing path   | T-3 validate-sitemap follows existing crawl route patterns                        |
| `apps/search-ai/agents.md`          | `getLazyModel` pattern for model access                                | T-2/T-3 use existing model access patterns                                        |
| `apps/studio/agents.md`             | i18n: pure utils return i18n keys, not English strings                 | T-5 ProfilingTrail uses i18n keys for step labels                                 |
| `apps/studio/agents.md`             | CrawlFlowV5 is entry point for all crawl UI                            | T-4/T-5/T-6/T-7 all integrate through CrawlFlowV5                                 |
| `apps/studio/CLAUDE.md`             | Semantic tokens from design-tokens, no hardcoded Tailwind palette      | T-5/T-6/T-7 use semantic tokens                                                   |
| `apps/studio/CLAUDE.md`             | Never `bg-accent text-foreground`                                      | T-6 card styling uses correct token pairs                                         |
| `packages/database/agents.md`       | Mongoose strict:true strips unknown fields — add to both TS + Mongoose | T-4 adds sitemapFile/sitemapOrigin to CrawlDraftSection Zod + any Mongoose schema |
| `packages/database/agents.md`       | Nested enum inference failures — use `type: String` without enum       | T-4 uses String type for sitemapOrigin in Mongoose subdoc                         |
| `packages/i18n/agents.md`           | New features allocate dedicated namespace                              | T-8 uses `sitemap_intelligence.*` namespace                                       |
| `apps/crawler-mcp-server/agents.md` | URL normalization via `normalizeUrl()` before map keys                 | T-1 normalizes sitemap URLs before dedup                                          |

## Pre-existing Bugs Found During Exploration (Fix in Scope)

1. **Strategy not restored on resume** — `handleResumeDraft` and initial draft load do not call `setSelectedStrategy(draft.strategy)`. Fix in T-4.
2. **`source` hardcoded to `'sitemap'` in `mapGroupsToSections`** — even when DiscoveryChain (tier 3) was used. Fix in T-4 by reading `discoveryMethod` from cluster response.
