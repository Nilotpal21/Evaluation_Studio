# Wave 1 — Direct URLs + Background Clustering — High-Level Design

## What

Add a third crawl strategy "Direct URLs" that lets users paste up to 2,000 URLs and skip directly to the Configure step, plus split the analysis pipeline so strategy cards appear after profiling (~2-3s) instead of waiting for the full profile→cluster→sample sequence (~8-15s). These two changes make the crawl setup faster for all users and add a new entry path for users who already know which pages they want to crawl.

## Architecture Approach

### Packages That Change

| Package             | What Changes                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio`       | New `DirectUrlsPanel` component, modified `StrategySelector` (3rd card), `CrawlFlowV5` (split `runAnalysis`, new strategy branch), `State2Analysis` (strategy conditionals), types, i18n keys |
| `apps/search-ai`    | `crawl-drafts.ts` Zod schemas: add `'direct'` to section source enum, `'direct-urls'` to strategy enum                                                                                        |
| `packages/database` | `crawl-draft.model.ts`: add `'direct'` to section source Mongoose enum, add `'direct'` to `ICrawlDraftSection.source` type                                                                    |

### Data Flow — Background Clustering

```
State 1: User enters URL
  │
  ▼
State 2: runAnalysis(url) — SPLIT into Phase A + Phase B
  │
  ├── Phase A (BLOCKING, ~2-3s):
  │     profileSite(url) → ProfileResponse
  │     → setProfile(), set rendering mode
  │     → Show strategy cards immediately
  │     → Sitemap card shows "Analyzing sitemap..." placeholder
  │
  └── Phase B (FIRE-AND-FORGET, ~5-12s):
        clusterUrls(url) → UrlGroup[]
        sampleGroups(groups) → GroupStrategy[]
        mapGroupsToSections() → CrawlSection[]
        → setSections(), update sitemap card desc with real count
        → If user already clicked "Continue" → auto-apply sections
```

### Data Flow — Direct URLs

```
State 2: User selects "Direct URLs" card
  │
  ▼
DirectUrlsPanel appears (inline, same layout as section checklist):
  │  Textarea: paste URLs (max 2,000)
  │  ├── Parse: split by newlines, trim
  │  ├── Normalize: lowercase scheme+host, remove trailing slash, sort query params, keep fragments
  │  ├── Domain enforce: reject URLs not matching root domain (subdomains OK)
  │  ├── Dedup: full normalized URL (including query + fragments)
  │  ├── Cap: keep first 2,000, show toast "Kept 2,000 of N"
  │  └── Show: valid count, rejected count, duplicate count
  │
  ▼
User clicks "Configure Crawl" → Continue
  │  Create single CrawlSection:
  │    sectionId: 'sec-direct-0'
  │    pattern: '/*'
  │    name: 'Direct URLs'
  │    source: 'direct'
  │    pageCount: validUrls.length
  │    pages: validUrls.map(u => ({ url: u, title: '' }))
  │    included: true
  │  Save section URLs to draft bucket
  │
  ▼
State 3: Configure (existing) — shows "Direct URLs — N pages"
  │
  ▼
State 4: Crawl — handleStartCrawl reads from bucket (existing logic)
```

### Key Integration Points

1. **Type system**: `DiscoveryStrategy` union gains `'direct-urls'`. `CrawlSection.source` gains `'direct'`. Both propagate to: frontend types, API client types, backend Zod schemas, Mongoose model enum.

2. **Strategy branching in State2Analysis**: Currently two branches (`crawl-sitemap` → section checklist, `guided-discovery` → discovery panel). Third branch (`direct-urls` → `DirectUrlsPanel`). The `isDiscoveryMode` guard at L680 remains unchanged — `direct-urls` falls through to the non-discovery path.

3. **Draft persistence**: Direct URLs draft saves `strategy: 'direct-urls'`, sections with `source: 'direct'`, and URLs to bucket storage. Resume reads strategy to restore the correct panel.

4. **Background clustering**: Phase B runs as a detached promise. State tracks `clusteringComplete` boolean. Sitemap card description updates reactively. If user selects sitemap before clustering finishes, sections state updates when Phase B completes.

## Decisions & Tradeoffs

| #    | Decision                      | Chose                                                           | Over                              | Because                                                                                      |
| ---- | ----------------------------- | --------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| D-1  | URL cap                       | 2,000 hard cap, auto-drop                                       | Infinite textarea / pagination    | Textarea performance; CSV import deferred for unlimited                                      |
| D-2  | Domain enforcement            | Same root domain only (subdomains OK)                           | Allow any domain                  | Prevents accidental external crawls; `support.epson.com` accepted when parent is `epson.com` |
| D-3  | Fragment handling             | Keep fragments (no stripping)                                   | Strip `#section`                  | SPA hash routing (`/#/page`) — stripping could merge distinct pages                          |
| D-4  | URL normalization             | Lowercase scheme+host, remove trailing slash, sort query params | No normalization                  | Prevents duplicates from trivial differences                                                 |
| D-5  | Profile requirement           | Always profile before showing cards                             | Skip profile for direct-urls      | Profile provides rendering recommendation (JS detection) needed for all strategies           |
| D-6  | Draft save timing             | Save on "Configure Crawl" click                                 | Save on every keystroke           | Reduces API calls; textarea content is ephemeral until confirmed                             |
| D-7  | Section count for direct URLs | Single section (`/*`)                                           | One section per domain path       | Simpler, matches current UX where State 3 shows "Sections: 1"                                |
| D-8  | Background clustering         | Phase B runs detached, UI updates reactively                    | Keep sequential blocking          | Cards appear in ~2-3s instead of ~15s                                                        |
| D-9  | No "Change" button            | Click another card to switch                                    | Explicit Change button            | Already the existing pattern (code comment at StrategySelector.tsx:159)                      |
| D-10 | Grid layout                   | `grid-cols-3` for 3 cards                                       | Keep `grid-cols-2` with 3rd below | Cleaner visual; cards are compact enough at 1/3 width                                        |

## Task Decomposition

| Task                                       | Package(s)                            | Independent?                                        | Est. Files | Description                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-1: Split runAnalysis                     | `apps/studio`                         | Yes                                                 | 2          | Split `runAnalysis` into Phase A (blocking profile) + Phase B (fire-and-forget cluster+sample). Update analysis steps UI.                                                                                          |
| T-2: Backend schema updates                | `apps/search-ai`, `packages/database` | Yes                                                 | 3          | Add `'direct'` to section source enum (Zod + Mongoose + TS). Add `'direct-urls'` to strategy enum (Zod).                                                                                                           |
| T-3: Third strategy card + DirectUrlsPanel | `apps/studio`                         | Depends on T-1 (async card state), T-2 (draft save) | 5-7        | Add `'direct-urls'` to `DiscoveryStrategy` type, third card in `StrategySelector`, new `DirectUrlsPanel` component, wire into `State2Analysis`, handle in `CrawlFlowV5` (continue, draft save, resume), i18n keys. |

### Implementation Order (Sequential)

```
Step 1: T-2 (Backend schemas) — safe, no frontend changes yet
Step 2: T-1 (Split runAnalysis) — existing flow works but faster
Step 3: T-3 (Third card + Direct URLs panel) — depends on T-1 + T-2
```

Each step: implement → prettier → build → verify wiring → commit.

## Out of Scope

- CSV import for URLs (removes 2,000 cap) — deferred
- Path group visualization — deferred (informational sugar)
- "Add from Sitemap" button on tree header (G-4) — Wave 2
- Sitemap preview dialog with real URL counts (G-8) — Wave 2
- Unified exclusion patterns module (G-9) — Wave 2
- Explore Branch post-completion toast (W-1) — Wave 2
- Direct URLs + Sitemap combo strategy — deferred
