# LLD Review Round 1 — Crawler UX Phase 2b

**LLD**: `docs/plans/2026-04-27-crawler-ux-phase2b-impl-plan.md`
**Reviewer**: lld-reviewer agent
**Date**: 2026-04-28
**Focus**: Architecture compliance, pattern consistency, 3-layer sync, completeness

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

**C-1: Task 1.5 references `draftId` and `draftVersionRef` that do not exist in `BrowserDiscoveryInline` scope**

The LLD says:

```typescript
const handleSaveDiscoveryState = useCallback(
  async (state: CrawlDraftDiscoveryState) => {
    if (!draftId || !draftVersionRef.current) return;
    await updateCrawlDraft(draftId, { version: draftVersionRef.current, discoveryState: state });
  },
  [draftId],
);
```

Verified: `BrowserDiscoveryInline` props (line 73-81) are `{ baseUrl, sampleUrls, depthProbing, onSectionsDiscovered, onLayerComplete, onApiPatternsFound, onClose }`. No `draftId`. No `draftVersionRef`. `State2Analysis` (lines 1149-1163) passes none of these either.

File: `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx:73-81`
File: `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx:1149-1163`

Fix: Task 1.5 must specify:

1. Add `draftId?: string` and `draftVersion?: number` to `BrowserDiscoveryInlineProps`
2. Thread from `CrawlFlowV5` -> `State2Analysis` (add to `State2AnalysisProps`) -> `BrowserDiscoveryInline`
3. Or alternatively, lift the save callback to `State2Analysis` and pass `onSaveDiscoveryState` as a prop to `BrowserDiscoveryInline`, which then passes it to `DiscoveryPanel` (where it already exists as a prop)

This is the **4th occurrence** of the 3-layer-plus-prop-threading gap pattern in crawl-flow LLDs.

---

**C-2: Task 1.3 mischaracterizes the `updateDraftSchema` — `discoveryState` is NOT freely accepted via `.passthrough()`**

The LLD says "Verify `discoveryState` is already accepted via `.passthrough()`". In reality, `updateDraftSchema` (crawl-drafts.ts:84-108) has a **structured** `discoveryState` field with:

- A required `iterations` array with typed objects (`id`, `seedUrl`, `sampleUrls`, `newUrlsDiscovered`, `pagesVisited`, `durationMs`, `timestamp`, `trigger`)
- `.passthrough()` on the iterations sub-object (not the top-level schema)
- A 5MB size refine check

The `discoveryState` Zod schema does NOT include:

- `tree` (array of `DiscoveryTreeNode`)
- `discoveredUrls` (array of URL objects)
- `objectives` (array)
- `navStructure`
- `coverage`
- `savedAt` (number)
- `scope` (the new `DiscoveryScope` being added in Task 1.4)

These fields from `CrawlDraftDiscoveryState` are currently passed through via `.passthrough()` on the inner object, but the **outer** `discoveryState` is a `z.object({...}).passthrough()`, so extra fields DO survive Zod validation. However, the LLD should explicitly document this dependency on `.passthrough()` behavior and note that `scope` will also pass through this way. If Zod validation is ever tightened to `.strict()`, all these fields will be silently rejected.

File: `apps/search-ai/src/routes/crawl-drafts.ts:84-108`

Fix: Task 1.3 should:

1. Explicitly document that `CrawlDraftDiscoveryState` fields (tree, discoveredUrls, objectives, navStructure, coverage, savedAt, scope) survive only because of `.passthrough()` — not because they are in the schema
2. Note the risk: if `.passthrough()` is ever removed, auto-save breaks silently
3. Consider adding `scope` to the Zod schema explicitly (since it is a new structured type being introduced in this LLD)

---

### HIGH

**H-1: `sendBrowserIntervention` error message leaks HTTP status code to caller**

```typescript
throw new Error(`Intervention failed: ${response.status}`);
```

Platform rule: "No user input interpolated in error messages." While `response.status` is server-generated (not user input), the error propagates to the UI catch block which may display it. The pattern should use structured errors.

File: LLD Task 4.1 (`sendBrowserIntervention` function)

Fix: Use consistent error codes like `QUEUE_FULL` and `NOT_FOUND` already in the function:

```typescript
throw new Error('INTERVENTION_FAILED');
```

And handle display text via i18n in the catch block.

---

**H-2: `handleDiscoveryAction` dependency array is incomplete**

The LLD's Task 4.2 shows:

```typescript
const handleDiscoveryAction = useCallback(
  async (action: ConsoleAction) => { ... },
  [handleStop, onClose],
);
```

But the function body references `exploreIdRef.current` and calls `sendBrowserIntervention`. Since `sendBrowserIntervention` is a module-level import (stable), it does not need to be in deps. But the function is `async` while the current version is sync — verify React hook rules are respected (useCallback with async is fine, but note the change from sync to async signature for `onAction` consumers).

File: `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx:146-162`

Fix: Confirm `DiscoveryPanelProps.onAction` type (`(action: ConsoleAction) => void`) is compatible with an async handler. Since the return type is `void`, an async function returning `Promise<void>` is assignment-compatible. Document this is safe.

---

**H-3: `explore-all` command creates `Breadcrumb` objects with URL as `text` — confusing for progress reporting**

In Task 3.1, all command-created breadcrumbs use `text: url` or `text: cmd.payload.url`:

```typescript
const pivotCrumb: Breadcrumb = {
  href: cmd.payload.url,
  text: cmd.payload.url, // URL as text since we don't have nav text
  depth: crumb.depth,
};
```

The depth-prober uses `crumb.text` in progress messages: `progress.currentAction = "Visiting breadcrumb hub: ${crumb.text}"` (line 518) and `progress.currentGroup = crumb.text` (line 521). This means the user will see full URLs instead of meaningful names in the console.

File: LLD Task 3.1 (command switch, all cases)

Fix: Use a truncated/simplified version:

```typescript
text: new URL(cmd.payload.url).pathname.split('/').pop() || cmd.payload.url,
```

Or add a comment acknowledging this is acceptable for user-initiated interventions.

---

**H-4: `State2AnalysisProps` missing `draftId`, `draftVersion`, and `initialDiscoveryState`**

The LLD's Phase 5 (Task 5.2) and Phase 7 (Task 7.3) require new props on `State2Analysis`:

- Task 5.2: needs `draftId` and `version` to call `updateCrawlDraft(draftId, { version, strategy })`
- Task 7.3: needs `initialDiscoveryState` prop
- Task 7.5: needs to skip profiling/strategy when `initialDiscoveryState` is provided

But `State2AnalysisProps` (types.ts:104-114) currently has: `url, indexId, profile, sections, onSectionsChange, onContinue, isAnalyzing, analysisSteps, groupStrategies`. None of the needed props exist.

File: `apps/studio/src/components/search-ai/crawl-flow/types.ts:104-114`

Fix: Task 1.4 (types phase) should add to `State2AnalysisProps`:

```typescript
draftId?: string;
draftVersion?: number;
initialDiscoveryState?: CrawlDraftDiscoveryState | null;
```

---

### MEDIUM

**M-1: `command-queue.ts` uses local `console.error` wrapper instead of platform `createLogger`**

The file defines its own `createLogger` function (line 30-38) that wraps `console.error`. Platform rule: "No console.log in server code — use `createLogger('module')` from `@abl/compiler/platform`."

File: `apps/crawler-mcp-server/src/explore/command-queue.ts:30-38`

Fix: Note in Task 2.6 that the local `createLogger` should be replaced with the platform logger import. This is pre-existing tech debt but the LLD is modifying this file.

---

**M-2: `MAX_EXPLORE_ALL = 20` is an inline magic number**

Task 3.1 defines `const MAX_EXPLORE_ALL = 20;` inside the command switch block. Platform rule: "No inline magic numbers — named constants or config."

File: LLD Task 3.1

Fix: Define as a module-level named constant in depth-prober.ts alongside other constants, or in command-queue.ts alongside `MAX_QUEUED_COMMANDS`.

---

**M-3: No Zod validation on `exploreId` path parameter in `sendBrowserIntervention`**

The LLD's `sendBrowserIntervention` (Task 4.1) interpolates `exploreId` directly into the URL path:

```typescript
crawlUrl(`/discover/browser/${exploreId}/intervention`);
```

Platform rule: "Every route parameter validated with Zod `.safeParse()`." The backend validates `:id` with `z.string().min(1).safeParse(req.params.id)`, but the frontend should also validate the exploreId before sending (defense in depth).

File: LLD Task 4.1

Fix: Add `z.string().min(1).safeParse(exploreId)` guard before the fetch, or note this is acceptable since `exploreIdRef` is set from `startBrowserExplore` return value which is server-generated.

---

**M-4: Phase 6 `scope-utils.ts` uses `new URL()` which throws on invalid input**

`deriveScope` and `isInScope` both use `new URL(url)` without try-catch:

```typescript
export function deriveScope(sampleUrls: string[]): DiscoveryScope {
  const includedPrefixes = sampleUrls.map(url => {
    const parsed = new URL(url);
```

If a sample URL is malformed (e.g., relative path, missing protocol), this will throw and crash the scope derivation.

File: LLD Task 6.1

Fix: Wrap in try-catch or validate URLs before calling. Since sample URLs come from the backend's `sampleUrls` array which is already `z.string().url()` validated, document this as a precondition.

---

**M-5: `OverrideWarning` interface includes `onConfirm` and `onCancel` callbacks in the state type**

```typescript
interface OverrideWarning {
  show: boolean;
  branch: string;
  discoveryRate: string;
  onConfirm: () => void;
  onCancel: () => void;
}
```

Storing callbacks in React state is an anti-pattern — they can become stale closures. The standard pattern is to store data in state and define handlers separately.

File: LLD Section 1 Key Interfaces

Fix: Split into data + handlers:

```typescript
interface OverrideWarningData {
  branch: string;
  discoveryRate: string;
}
// State: overrideWarning: OverrideWarningData | null
// Handlers defined inline in the component
```

---

### LOW

**L-1: Phase 0 commit type should be `fix()` not just noted as such**

The LLD correctly identifies this as `fix(search-ai): wire exploreId through MCP request to depth-prober command queue` but the commit touches both `search-ai` and `crawler-mcp-server`. Commit scope guard allows max 3 packages, so this is fine, but the scope should be `fix(search-ai,crawler)` or just `fix(search-ai)` since the crawler change is receiving, not originating.

Fix: Minor — clarify commit scope is `fix(search-ai)` (the originating fix is in search-ai).

---

**L-2: `Intervention.type` narrowing in Task 2.6 removes types but existing code may have references**

When removing `add-to-scope` and `add-children-to-scope` from `Intervention.type` in command-queue.ts, verify no existing code handles these cases.

Fix: Grep for `add-to-scope` and `add-children-to-scope` in server.ts and depth-prober.ts before removing.

---

## VERIFIED

- [x] **Architecture compliance** — tenant isolation: crawl-browser-discover.ts checks `req.tenantContext` at line 609; command queue is pod-local (documented as H-2 limitation); no custom auth; stateless acknowledged with deferred Redis migration (G25)
- [x] **Bug analysis accuracy** — all 4 critical bugs (exploreId, discoveryState Mongoose, handleDiscoveryAction, onSaveDiscoveryState) verified against actual code with correct line references
- [x] **Phase ordering minimizes risk** — Phase 0 (fix) -> Phase 1 (data) -> Phase 2 (refactor) -> Phase 3 (backend) -> Phase 4 (frontend) -> Phase 5-8 (features). Highest-risk changes (loop refactor) isolated as refactor() commits.
- [x] **Phase 3 field preservation** — `previouslyVisitedUrls`, `resumedFrom`, `lastSkipReason`, `hubYields`, `yieldReason`, `autoAddReason` all analyzed with correct safety assessments
- [x] **3-layer sync (Mongoose)** — Task 1.1 correctly adds `discoveryState: Schema.Types.Mixed` and `strategy: String` to Mongoose schema. Backward compatible with null defaults.
- [x] **3-layer sync (Zod)** — Task 1.3 adds `strategy` to `updateDraftSchema`. `discoveryState` already present with `.passthrough()`.
- [x] **3-layer sync (API client)** — Task 1.2 adds both fields to `updateCrawlDraft` param type.
- [x] **Breadcrumb type** — LLD correctly uses `Breadcrumb` from `breadcrumb-extractor.ts` with `{text, href, depth}` fields
- [x] **Command queue types** — narrowing from 8 to 6 types is correct; `add-to-scope` and `add-children-to-scope` have no backend consumers
- [x] **InterventionType cleanup** — removing `background` and `edit-pause` is correct; no consumers exist
- [x] **URL path routing** — `crawlUrl('/discover/browser/${exploreId}/intervention')` produces correct path matching backend route `/discover/browser/:id/intervention`
- [x] **Design tokens** — all new components specify semantic tokens, no hardcoded Tailwind colors
- [x] **i18n** — ~30 keys planned across 5 namespaces, using `useTranslations('search_ai.crawl_flow')`
- [x] **Express route ordering** — no new routes that could conflict
- [x] **Domain rules** — scope-flows-down, no static caps (override warning), user always wins
- [x] **Task independence** — parallel tasks have minimal file overlap; Phase 0 and Phase 1 touch different files; later phases are sequential
- [x] **Wiring checklist** — 16 items, comprehensive coverage

---

## NOTES

1. **Recurring pattern (4th occurrence)**: LLD references component state/props without verifying they exist in the actual component signature. Every future crawl-flow LLD review must verify prop threading end-to-end for any data that flows across 2+ component boundaries.

2. **Pre-existing tech debt in command-queue.ts**: The local `createLogger` using `console.error` should be fixed opportunistically since we're modifying this file. Not blocking but worth noting.

3. **Phase 2 loop refactor is well-analyzed**: The LLD correctly identifies that `sortedCrumbs.push()` + `sortedCrumbs.sort()` inside a `for...of` loop is mutation during iteration (lines 556-564). The `while` + `pendingCrumbs.shift()` replacement is safer and enables proper command queue integration.

4. **The `discoveryState` passthrough dependency is fragile**: The entire auto-save feature relies on Zod `.passthrough()` allowing unschema'd fields. If any future PR changes this to `.strict()`, auto-save silently drops all discovery state except `iterations`. Consider making this explicit in the schema.

5. **Implementation order recommendation**: Phase 0 -> Phase 1 -> Phase 2 (test thoroughly before continuing) -> Phase 3 -> Phase 4 -> Phase 5/6 (can parallelize) -> Phase 7 -> Phase 8.
