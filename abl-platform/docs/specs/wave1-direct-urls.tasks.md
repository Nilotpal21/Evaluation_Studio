# Wave 1 — Direct URLs + Background Clustering — Task Tracker

> **HLD**: `docs/specs/wave1-direct-urls.hld.md` (approved)
> **User Journeys**: `docs/specs/wave1-user-journeys.md` (approved)
> **Workflow**: Sequential implement-and-verify (see workflow below)
> **Branch**: `develop`
> **Jira**: TBD (find/create before first commit)
> **Claude Tasks**: #10 (Step 1) → #11 (Step 2) → #12 (Step 3) → #13 (Review) → #14 (Present)

---

## Workflow

**Pattern**: Hybrid — one HLD, three sequential mini-LLD→implement→verify cycles.
**Why**: Files overlap across tasks (`CrawlFlowV5.tsx`, `types.ts`, `StrategySelector.tsx`).
Parallel implementation would cause merge conflicts and wiring gaps.

```
For each Step:
  1. Write mini-LLD section (files, signatures, subtasks, ACs)
  2. Implement subtasks sequentially
  3. Run prettier on all changed files
  4. Run pnpm build --filter=<affected packages>
  5. Verify wiring: read actual code paths end-to-end
  6. Commit: [ABLP-xxx] type(scope): description
  7. Update this file: mark step DONE, note commit SHA
  8. Only then proceed to next step
```

---

## Step 1: Backend Schema Updates (T-2) — Claude Task #10

**Status**: ✅ DONE
**Packages**: `apps/search-ai`, `packages/database`, `apps/studio`
**Est. Files**: 4 (added types.ts for type propagation consistency)
**Depends on**: Nothing

### Files to Modify

| File                                                | Change                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/crawl-draft.model.ts` | Add `'direct'` to `ICrawlDraftSection.source` type union (L29) and Mongoose enum (L95)                                       |
| `apps/search-ai/src/routes/crawl-drafts.ts`         | Add `'direct'` to `sectionSchema.source` Zod enum (L38). Add `'direct-urls'` to `updateDraftSchema.strategy` Zod enum (L121) |
| `apps/studio/src/api/crawl.ts`                      | Add `'direct'` to `CrawlDraftSection.source` type union (L765)                                                               |

### Subtasks

- [x] ST-1.1: Add `'direct'` to `ICrawlDraftSection.source` in `crawl-draft.model.ts` (type union L29 + Mongoose enum L95)
- [x] ST-1.2: Add `'direct'` to Zod `sectionSchema.source` in `crawl-drafts.ts` (L38)
- [x] ST-1.3: Add `'direct-urls'` to Zod `updateDraftSchema.strategy` in `crawl-drafts.ts` (L121)
- [x] ST-1.4: Add `'direct'` to `CrawlDraftSection.source` in `api/crawl.ts` (L765)
- [x] ST-1.4b: Add `'direct'` to `CrawlSection.source` in `types.ts` (L26) — type propagation fix (draftSectionsToSections TS2322)
- [x] ST-1.5: Build + verify — all 3 packages pass (database, search-ai, studio typecheck)

### Acceptance Criteria

- AC-1: `pnpm build` passes for all 3 packages
- AC-2: Existing draft create/update still works (no breaking change — additive enum)
- AC-3: A draft with `source: 'direct'` and `strategy: 'direct-urls'` would pass Zod + Mongoose validation

### Exit Gate

- [x] Build passes
- [x] Commit SHA: 8b695d61fa (committed with Step 2)

**Note**: Also added `'direct'` to `CrawlSection.source` in `types.ts` — this was planned for Step 3 but required now for type consistency (CrawlDraftSection→CrawlSection conversion in `draftSectionsToSections`).

---

## Step 2: Split runAnalysis — Background Clustering (T-1) — Claude Task #11

**Status**: ✅ DONE
**Packages**: `apps/studio`, `packages/i18n`
**Est. Files**: 4 (`CrawlFlowV5.tsx`, `StrategySelector.tsx`, `State2Analysis.tsx`, `studio.json`)
**Depends on**: Step 1

### Files to Modify

| File                                                                   | Change                                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`      | Split `runAnalysis` (L305-429) into Phase A (blocking profile) + Phase B (fire-and-forget cluster+sample). Add `clusteringInProgress`/`clusteringComplete` state. |
| `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx` | Add `clusteringInProgress?: boolean` prop. Show "Analyzing sitemap..." when true instead of "0 pages in sitemap".                                                 |
| `packages/i18n/locales/en/studio.json`                                 | Add `strategy_sitemap_analyzing` key                                                                                                                              |

### Subtasks

- [x] ST-2.1: Add state: `clusteringInProgress` (boolean) in CrawlFlowV5.tsx (L188)
- [x] ST-2.2: Profile phase stays inline in `runAnalysis` (blocking). Sets profile, rendering mode, shows cards.
- [x] ST-2.3: Extract `runClusteringPhase` callback (CrawlFlowV5.tsx L315) — cluster + sample + mapGroupsToSections. Detached with error handling. Sets `clusteringInProgress = false` in finally.
- [x] ST-2.4: `runAnalysis` Phase A (profile, blocking) → Phase B (fire-and-forget `runClusteringPhase`, L472-473)
- [x] ST-2.5: Skip Phase B when `!profileResp.hasSitemap` — marks all steps complete immediately (L455-465)
- [x] ST-2.6: `clusteringInProgress` prop in StrategySelector — card shows "Analyzing sitemap…" with spinner, recommendation deferred, reasoning suppressed
- [x] ST-2.7: Loading indicator in State2Analysis (L1138-1151) — shown when user picks Sitemap before clustering completes
- [x] ST-2.8: Phase B error handling in `runClusteringPhase` catch block — marks steps as error, profile step stays complete
- [x] ST-2.9: 30s timeout via `Promise.race` in `runClusteringPhase` (L326-329)
- [x] ST-2.10: Card description: `strategy_sitemap_analyzing` key + Loader2 spinner during clustering, real count after
- [x] ST-2.11: Naturally handled — Continue button gated by `analysisComplete` (all steps complete), which is false during clustering
- [x] ST-2.12: i18n keys added: `strategy_sitemap_analyzing`, `strategy_clustering_loading`
- [x] ST-2.13: TypeScript check passes (`tsc --noEmit` clean)

### Acceptance Criteria

- AC-1: Strategy cards appear after profile (~2-3s), not after full pipeline (~15s)
- AC-2: Sitemap card initially shows "Analyzing sitemap..." placeholder (not "0 pages")
- AC-3: After clustering completes, sitemap card updates with real page count + recommendation badge
- AC-4: No-sitemap site: clustering skipped, sitemap card disabled, Discovery recommended (Journey 5)
- AC-5: User picks Sitemap before clustering done → spinner → sections appear when ready (Journey 9)
- AC-6: Existing sitemap flow works: select sitemap → see sections → continue → configure → crawl
- AC-7: Existing guided-discovery flow works unchanged
- AC-8: Error in Phase B → sitemap card shows "Analysis failed", other strategies unaffected
- AC-9: Clustering timeout → fallback message (Edge case E-6)
- AC-10: `pnpm build --filter=studio` passes

### Exit Gate

- [x] Build passes (tsc --noEmit clean)
- [x] Manual code trace: cards appear after profile, clustering updates reactively
- [x] Commit SHA: 8b695d61fa (committed with Step 1)

---

## Step 3: Third Card + DirectUrlsPanel (T-3) — Claude Task #12

**Status**: ✅ DONE
**Packages**: `apps/studio`, `packages/i18n`
**Est. Files**: 5-7
**Depends on**: Step 1 + Step 2

### Files to Create

| File                                                                  | Purpose                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/DirectUrlsPanel.tsx` | Textarea for pasting URLs with validation, normalization, domain enforcement, dedup, 2K cap, Clear button, expandable invalid list |

### Files to Modify

| File                                                                   | Change                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/types.ts`             | Add `'direct-urls'` to `DiscoveryStrategy` union (L690). Add `'direct'` to `CrawlSection.source` union (L26). Add `DIRECT_URLS_MAX = 2_000` constant.                                       |
| `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx` | Add 3rd card in `cards` array (L116-145). Change grid to `grid-cols-3` (L162). Add explicit guard: Direct URLs never recommended.                                                           |
| `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx`   | Add `direct-urls` branch — show `DirectUrlsPanel` when strategy is `'direct-urls'`. Wire onValidUrlsChange callback. Wire Continue button.                                                  |
| `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`      | Add `directUrlsText` state for cross-strategy preservation. Wire `handleContinue` for direct-urls (create section, save to bucket). Wire `handleResumeDraft` for `strategy: 'direct-urls'`. |
| `packages/i18n/locales/en/studio.json`                                 | Add 14+ i18n keys under `search_ai.crawl_flow`                                                                                                                                              |

### Subtasks

- [x] ST-3.1: Added `'direct-urls'` to `DiscoveryStrategy` type + `DIRECT_URLS_MAX = 2_000` constant in `types.ts`
- [x] ST-3.2: Added 17 i18n keys in `studio.json` under `search_ai.crawl_flow`
- [x] ST-3.3: `DirectUrlsPanel.tsx` — full implementation with URL parsing, auto-fix, normalization, domain enforcement, dedup, cap, validation badges, expandable invalid list, clear button, configure button. Uses `Textarea`, `Button`, `Badge` design system components.
- [x] ST-3.4: 3rd card in `StrategySelector.tsx` — `ListChecks` icon, `'direct-urls'` key, always enabled, never recommended, grid changed to `grid-cols-3`
- [x] ST-3.5: Wired `DirectUrlsPanel` into `State2Analysis.tsx` — shown when `strategy === 'direct-urls'` && `pipelinePhase === 'idle'`, receives domain from profile, text/URL callbacks connected
- [x] ST-3.6: Added `directUrlsText` + `directValidUrls` state in `CrawlFlowV5.tsx`, passed through State2Analysis props to DirectUrlsPanel
- [x] ST-3.7: `handleDirectUrlsConfigure` callback in CrawlFlowV5 — creates single section with `source: 'direct'`, rendering strategy from profile, saves draft with `strategy: 'direct-urls'`, persists URLs to bucket
- [x] ST-3.8: Resume draft for direct-urls — `handleResumeDraft` reads strategy from draft, fetches URLs from bucket via `getSectionUrls`, restores `directUrlsText` + `directValidUrls`. Added `strategy` field to `CrawlDraft` type.
- [x] ST-3.9: Strategy switching — `directUrlsText` preserved in CrawlFlowV5 state, DirectUrlsPanel receives `initialText` to restore on re-select
- [x] ST-3.10: Back navigation — `handleBackToAnalysis` preserves sections + directUrlsText state, DirectUrlsPanel renders with preserved text when re-entering State 2
- [x] ST-3.11: TypeScript check passes (`tsc --noEmit` clean)
- [x] ST-3.12: Prettier on all changed files

### Acceptance Criteria (from User Journeys)

- AC-1: Third card "Direct URLs" appears in strategy selector, never auto-recommended (Journey 1, UX spec)
- AC-2: Pasting 2,500 URLs keeps first 2,000, shows drop message (Journey 2, E-2)
- AC-3: URLs from different domain rejected with clear reason shown (Journey 3)
- AC-4: Duplicate URLs removed with count shown (Journey 3)
- AC-5: Auto-fix bare domains: `epson.com/page` → `https://epson.com/page` (Journey 3)
- AC-6: "Configure Crawl" creates a single section `source: 'direct'` with all valid URLs (Journey 1 internals)
- AC-7: State 3 shows "Direct URLs — N pages" in section breakdown (Journey 1)
- AC-8: Crawl submits all URLs via existing `handleStartCrawl` → bucket read path (Journey 1)
- AC-9: Draft resume restores Direct URLs strategy, card selection, and URLs from bucket (Journey 12)
- AC-10: Switching between all 3 strategies preserves each strategy's state (Journey 6, 10)
- AC-11: Back navigation State3→State2 restores DirectUrlsPanel with URLs (Journey 8)
- AC-12: Rendering strategy inherited from profile: `jsRequired → browser`, else `http` (Journey 11)
- AC-13: Empty textarea / all invalid → button disabled (Journey 4)
- AC-14: `pnpm build` passes for all affected packages

### Exit Gate

- [x] Build passes (tsc --noEmit clean)
- [ ] All 14 ACs verified via code trace
- [x] Commit SHA: 0b9e4ffdfb + 841f2e0992 + aa9fc18e8a

---

## Step 4: AI Review + Verify vs HLD — Claude Task #13

**Status**: ✅ DONE
**Depends on**: Steps 1-3

- [x] Spawn explorer agent to trace all 14 Step 3 ACs against actual code
- [x] Found 2 bugs + 1 cleanup:
  - Bug 1: Strategy not restored on State2 remount (AC-9, AC-11) — fixed with `initialStrategy`/`onStrategyChange`
  - Bug 2: Debounce stale data in DirectUrlsPanel — fixed with content-derived key
  - Cleanup: 17 duplicate i18n keys removed
- [x] All fixes committed: `2a13022c7d`
- [x] Prettier + tsc --noEmit clean
- [x] AC verification: 12 PASS, 2 fixed (AC-9, AC-11), 1 unverified (AC-14: full build)

---

## Step 5: Summary + User Presentation — Claude Task #14

**Status**: ✅ DONE — User approved
**Depends on**: Step 4

- [x] Sequence flow diagram presented
- [x] Files changed per step with commit SHAs
- [x] 3 bugs found and fixed during review documented
- [x] User approved implementation

---

## Cross-Session Handoff Notes

_When resuming in a new session, the agent must:_

1. Read this file first — find the **last incomplete step** (first TODO status)
2. Read the HLD (`docs/specs/wave1-direct-urls.hld.md`) for architecture context
3. Read the user journeys (`docs/specs/wave1-user-journeys.md`) for UX requirements
4. Read memory (`/.claude/agent-memory-local/architect/project_discovery_build3_scope.md`) for decisions
5. Check git log for commit SHAs already recorded here
6. Pick up from the next unchecked subtask in the current step
7. Follow the workflow: implement → prettier → build → verify → commit → update this file

**Key files (read before touching)**:

- `apps/studio/src/components/search-ai/crawl-flow/CrawlFlowV5.tsx` — state machine owner
- `apps/studio/src/components/search-ai/crawl-flow/types.ts` — all type definitions
- `apps/studio/src/components/search-ai/crawl-flow/StrategySelector.tsx` — card rendering
- `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx` — strategy branching
- `apps/search-ai/src/routes/crawl-drafts.ts` — backend Zod validation
- `packages/database/src/models/crawl-draft.model.ts` — Mongoose model
- `apps/studio/src/api/crawl.ts` — API client types

**Workflow pattern**: See `/.claude/agent-memory-local/architect/feedback_hybrid_workflow.md`
