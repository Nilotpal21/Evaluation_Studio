# LLD Review Round 2 — Crawler UX Phase 2b

**LLD**: `docs/plans/2026-04-27-crawler-ux-phase2b-impl-plan.md`
**Reviewer**: lld-reviewer agent
**Date**: 2026-04-28
**Focus**: Verify Round 1 fixes, check for regressions, remaining items, implementation readiness

---

## VERDICT: APPROVED

---

## Round 1 Fix Verification

### C-1: draftId prop threading (CRITICAL) -- FIXED

Task 1.5 now specifies the full 3-level prop threading chain:

1. `CrawlFlowV5` passes `draftId` and `draft?.version` to `State2Analysis` (line 328-331)
2. `State2Analysis` creates `handleSaveDiscoveryState` callback using Option A (lines 337-348) -- callback is created here, keeping BrowserDiscoveryInline unaware of draft persistence
3. `State2Analysis` passes `onSaveDiscoveryState` to `BrowserDiscoveryInline` as a new prop (line 350)
4. `BrowserDiscoveryInline` passes through to `DiscoveryPanel` which already accepts the prop (line 77 verified)

Task 1.4 also correctly adds `draftId`, `draftVersion`, `initialDiscoveryState` to `State2AnalysisProps` (lines 314-319).

**Verified against actual code**: `State2AnalysisProps` (types.ts:104-114) currently has none of these. `BrowserDiscoveryInlineProps` (types.ts:178+) also has none. `DiscoveryPanel.onSaveDiscoveryState` exists at line 77. Chain is complete.

### C-2: discoveryState passthrough fragility (CRITICAL) -- FIXED

Task 1.3 now:

1. Documents the fragility explicitly (line 286-288) -- "Additional fields survive only because the outer object uses `.passthrough()`"
2. Includes `FRAGILITY WARNING` callout about `.strict()` breakage risk
3. Adds `scope` to the Zod schema explicitly as a structured type (lines 290-300)
4. Specifies a CAUTION code comment above `.passthrough()` (lines 302-307)

This is a thorough fix. The new `scope` field is properly typed in Zod rather than relying on passthrough.

### H-1: sendBrowserIntervention error codes -- FIXED

Task 4.1 (line 679) now throws `new Error('INTERVENTION_FAILED')` -- structured error code, no HTTP status leakage. Error handling in Task 4.2 (lines 708-713) catches by error code string. Correct.

### H-2: async handler compatibility -- FIXED

Task 4.2 (line 686) now includes explicit documentation: "An async function returning `Promise<void>` is assignment-compatible with `void` return type in TypeScript -- this is safe. Fire-and-forget semantics are correct here since errors are caught internally." Correct.

### H-3: Command-created Breadcrumbs use urlToLabel -- FIXED

Task 3.1 (lines 514-528) adds module-level `urlToLabel()` helper that extracts the last path segment, decoded, with try-catch fallback. All command-created breadcrumbs use `text: urlToLabel(cmd.payload.url)` (lines 554, 565, 579, 591). Progress messages will show readable labels instead of full URLs.

### H-4: State2AnalysisProps gaps -- FIXED

Task 1.4 (lines 314-319) adds `draftId?: string`, `draftVersion?: number`, `initialDiscoveryState?: CrawlDraftDiscoveryState | null` to `State2AnalysisProps`. Verified these are needed by Phase 5 (save strategy), Phase 7 (resume), and Phase 1 (auto-save callback creation).

### M-1: console.error logger in command-queue.ts -- NOTED

Task 2.9 (line 483) explicitly addresses this: "Replace the local `createLogger` wrapper in `command-queue.ts` with the platform logger." Includes caveat about checking if `crawler-mcp-server` uses a local logger pattern. Acceptable.

### M-2: MAX_EXPLORE_ALL inline magic number -- FIXED

Task 3.1 (lines 517-518) defines `const MAX_EXPLORE_ALL_URLS = 20;` as a module-level constant with doc reference: "design doc section 6.6, I-6". Used at line 575. Correct.

### M-4: scope-utils URL parsing -- FIXED

Task 6.1 (lines 839-855) wraps `deriveScope`'s `new URL()` calls in try-catch with `flatMap` pattern -- malformed URLs return `[]` and are skipped instead of crashing. Precondition documented.

### M-5: OverrideWarning callbacks in state -- FIXED

Key Interfaces (lines 141-147) now define `OverrideWarningData` (data only, no callbacks) with explicit comment: "callbacks defined in component, not state" and usage pattern showing `useState<OverrideWarningData | null>`. Task 4.3 (lines 746-749) shows `pendingIntervention` state + inline confirm/cancel handlers. Correct anti-pattern avoidance.

---

## Remaining Round 1 Items

### M-3: No Zod validation on exploreId in sendBrowserIntervention -- ACCEPTED AS-IS

Round 1 flagged that `exploreId` is interpolated into the URL without Zod validation on the frontend. The LLD does not add validation. This is acceptable because:

- `exploreId` comes from `exploreIdRef.current` which is set from the `startBrowserExplore` API response (server-generated UUID)
- The backend validates `:id` with `z.string().min(1).safeParse(req.params.id)`
- Defense-in-depth on the frontend is nice-to-have, not blocking

**Status**: ACCEPTED (LOW risk)

### L-1: Phase 0 commit scope -- ACCEPTED AS-IS

Minor style concern about commit scope naming. Not blocking.

**Status**: ACCEPTED

### L-2: Intervention type narrowing removal safety -- ADDRESSED

Task 2.6-2.8 narrow the types across all 3 schemas. The LLD's Critical Bugs section (line 220) confirms the command queue is completely disconnected today (exploreId never set), meaning `add-to-scope` and `add-children-to-scope` have zero backend consumers. The removal is safe. The LLD also correctly identifies these as "frontend-only scope operations" in D-8.

**Status**: VERIFIED SAFE

---

## New Issues Found in Round 2

### MEDIUM

**M-R2-1: `isInScope` still has unguarded `new URL()` -- inconsistent with `deriveScope` fix**

`deriveScope` was fixed with try-catch (M-4), but `isInScope` (line 867) still uses bare `new URL(url).pathname` without try-catch:

```typescript
export function isInScope(url: string, scope: DiscoveryScope): boolean {
  const path = new URL(url).pathname;  // throws on malformed URL
```

While `isInScope` is called on URLs that are typically already validated (they come from the discovery tree), defensive coding should be consistent within the same module. If `deriveScope` has try-catch, `isInScope` should too.

File: LLD Task 6.1 (line 866-872)

Fix: Wrap in try-catch, return `false` for malformed URLs:

```typescript
export function isInScope(url: string, scope: DiscoveryScope): boolean {
  try {
    const path = new URL(url).pathname;
    ...
  } catch {
    return false;
  }
}
```

---

**M-R2-2: Task 1.4 contradicts Task 1.5 on BrowserDiscoveryInlineProps extensions**

Task 1.4 (line 320) says:

> **Extend `BrowserDiscoveryInlineProps`** -- add `draftId?: string` and `draftVersion?: number` for auto-save wiring

But Task 1.5 uses Option A where the save callback is created in `State2Analysis`, and `BrowserDiscoveryInline` only receives `onSaveDiscoveryState`. The props summary in Task 1.5 (line 362) correctly says:

> `BrowserDiscoveryInlineProps`: `onSaveDiscoveryState?: (state: CrawlDraftDiscoveryState) => void`

Task 1.4 should say `onSaveDiscoveryState` instead of `draftId`/`draftVersion` for `BrowserDiscoveryInlineProps`. Having both instructions creates confusion for the implementer about what BrowserDiscoveryInline actually needs.

File: LLD Task 1.4, line 320

Fix: Change line 320 to:

```
- **Extend `BrowserDiscoveryInlineProps`** -- add `onSaveDiscoveryState?: (state: CrawlDraftDiscoveryState) => void` for auto-save wiring
```

---

### LOW

**L-R2-1: `addToScope` and `removeFromScope` have no implementation body**

Task 6.1 (lines 874-878) shows only type signatures for these two functions:

```typescript
export function addToScope(
  scope: DiscoveryScope,
  prefix: string,
  crawlOrigin: string,
): DiscoveryScope;
export function removeFromScope(scope: DiscoveryScope, prefix: string): DiscoveryScope;
```

These are used in Task 6.3 (DiscoveryPanel wiring). The implementer will need to write the bodies. Since they are trivial (immutable spread + push/filter on arrays), this is acceptable but worth noting.

**Status**: Implementation detail, not blocking

---

## VERIFIED

- [x] **C-1 fix complete** -- full 3-level prop chain specified with Option A, every step verified against actual code
- [x] **C-2 fix complete** -- fragility documented, CAUTION comment specified, `scope` added to Zod explicitly
- [x] **All HIGH fixes verified** -- H-1 through H-4 addressed correctly
- [x] **M-1, M-2, M-4, M-5 fixes verified** -- all applied as specified
- [x] **Architecture compliance** -- tenant isolation in crawl-browser-discover.ts, no custom auth, stateless limitation documented (H-2), TraceEvent gap documented (M-4)
- [x] **Pattern consistency** -- uses `apiFetch` (not raw fetch), `useCallback` with correct deps, `useTranslations`, design tokens throughout
- [x] **i18n coverage** -- ~30 keys planned across 5 namespaces, all components specify i18n usage
- [x] **Phase ordering** -- correct dependency chain: Phase 0 (fix) -> 1 (data) -> 2 (refactor) -> 3 (backend) -> 4 (frontend) -> 5/6 (features) -> 7 (resume, depends on 1+6) -> 8 (polish)
- [x] **Task independence** -- phases are sequential with correct dependencies; no parallel file conflicts
- [x] **Exit criteria** -- every phase has testable exit criteria with build verification commands
- [x] **Wiring checklist** -- 16 items covering all data flows end-to-end
- [x] **Objective mapping** -- all HLD objectives (UJ-2, UJ-4, UJ-7-12, UJ-16, UJ-18, G1-G3) mapped to specific phases
- [x] **Rollback plans** -- every phase has explicit rollback instructions
- [x] **Domain rules** -- scope-flows-down, no static caps (override warning), user always wins

---

## NOTES

1. **M-R2-1 and M-R2-2 are non-blocking.** M-R2-1 is a defensive coding consistency issue in a new file. M-R2-2 is a documentation contradiction that the implementer can resolve by following Task 1.5 (which is authoritative). Neither should block implementation.

2. **Implementation recommendation**: Follow the LLD's phase order strictly. Phase 2 (loop refactor) is the highest-risk change. Test it thoroughly before proceeding to Phase 3. The LLD correctly isolates it as a `refactor()` commit.

3. **The passthrough fragility is now well-documented** but remains a medium-term concern. Consider a follow-up ticket to fully type the `discoveryState` Zod schema (add `tree`, `discoveredUrls`, `objectives`, `navStructure`, `coverage`, `savedAt` explicitly) in a future LLD.

4. **Prop threading pattern is now the cleanest version seen across crawl-flow LLDs.** Option A (callback created at the persistence-aware layer, threaded as opaque callback) is the correct abstraction boundary.
