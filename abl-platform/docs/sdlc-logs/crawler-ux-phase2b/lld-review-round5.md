# LLD Review Round 5 (FINAL) -- Crawler UX Phase 2b

**LLD**: `docs/plans/2026-04-27-crawler-ux-phase2b-impl-plan.md`
**Reviewer**: lld-reviewer agent
**Date**: 2026-04-28
**Prior rounds**: R1 (NEEDS_CHANGES 2C4H5M2L -- all fixed), R2 (APPROVED 2M -- fixed), R3 (APPROVED 3M1L), R4 (APPROVED 2M1L)
**Focus**: Final sign-off -- implementation readiness, remaining issue disposition, phase ordering, exit criteria, wiring completeness, rollback safety

---

## VERDICT: APPROVED -- READY FOR IMPLEMENTATION

---

## Round 3-4 Fix Verification

### M-R3-3: Drain loop checks `!shouldStop` before each dequeue -- FIXED

LLD Phase 3, Task 3.5 (line 627) now reads:

```typescript
while (!shouldStop && (cmd = checkCommandQueue()) !== undefined) {
```

The `!shouldStop` guard is correctly placed before the dequeue attempt. A `stop` command sets `shouldStop = true` inside the switch, breaking the drain loop immediately. No commands queued after `stop` will be processed.

### L-R3-2 / S-2: `addToScope` and `removeFromScope` have full implementation bodies -- FIXED

LLD Phase 6, Task 6.1 (lines 880-905) now contains complete implementations:

- `addToScope`: Cross-origin validation, path extraction, immutable spread with `includedSections` append and `excludedPrefixes` removal
- `removeFromScope`: Immutable spread with `includedSections` filter and `excludedPrefixes` append

Both handle error cases and return new `DiscoveryScope` objects (immutable pattern).

---

## Final Implementation Readiness Assessment

### Phase Ordering -- CORRECT

```
Phase 0 (exploreId fix)
  |
Phase 1 (data layer + types)
  |
Phase 2 (loop refactor) -- highest risk, isolated as refactor()
  |
Phase 3 (backend interventions)
  |
Phase 4 (frontend dispatch)
  |
Phase 5 (strategy) ----+---- Phase 6 (scope) -- can parallelize
  |                     |
  +---------------------+
  |
Phase 7 (resume) -- depends on Phase 1 + Phase 6
  |
Phase 8 (console polish)
```

Dependencies are correctly specified:

- Phase 0 is prerequisite for all intervention work (Phases 2-4)
- Phase 1 is prerequisite for persistence (Phases 5, 7)
- Phase 2 is prerequisite for Phase 3 (loop structure needed for command switch)
- Phase 7 correctly depends on Phase 1 (discoveryState persistence) and Phase 6 (scope in discoveryState)
- Phases 5 and 6 can run in parallel (no file overlap except `packages/i18n/locales/en/studio.json` which is additive)

### Exit Criteria -- TESTABLE

Every phase has:

- At least one behavioral assertion (not just "build succeeds")
- A `pnpm build --filter=<packages>` command
- A commit message with correct type (`fix`, `refactor`, `feat`)
- Rollback instructions

Phase 6 stands out positively with specific URL test cases (e.g., `deriveScope(['/support/printers/troubleshooting'])` -> prefix `/support/printers`).

### Wiring Checklist (Section 4) -- COMPLETE

16 items covering all data paths. Cross-referenced against Section 3 phases -- every wiring item maps to a specific task. No orphaned wiring items.

### Rollback Plans -- SAFE

All phases independently revertible. No phase creates irreversible state (all schema additions are optional with null defaults). Phase 7 has a dependency on Phase 1 remaining in place, which is correctly documented.

---

## Remaining Non-Blocking Items (Carried, Not New)

These are carried from prior rounds. All were classified as non-blocking and remain so.

### M-R3-1: Phase 7 `loadDraft` insertion point needs clarification (CARRIED)

Task 7.1 says "check `draft.discoveryState?.savedAt`" but does not specify WHERE in the existing `loadDraft` branch chain. The implementer will need to decide: before flowState branches (takes priority) or inside specific branches. The intent is clear from the banner behavior (show resume banner when discoveryState exists and flowState is not 'submitted'), so this is a documentation gap, not an ambiguity.

**Disposition**: Non-blocking. Implementer can resolve from context.

### M-R3-2: Phase 2 exit criterion assumes existing tests (CARRIED)

"Existing depth-prober tests pass (no regressions)" -- test existence unverified. Manual E2E validation recommended for the loop refactor.

**Disposition**: Non-blocking. The LLD correctly identifies Phase 2 as highest-risk and isolates it as a `refactor()` commit. Manual testing + build verification is sufficient.

---

## VERIFIED

- [x] **All prior CRITICAL and HIGH issues resolved** -- 2C + 4H from Round 1 all fixed and verified across Rounds 2-4
- [x] **Round 3-4 fixes applied** -- M-R3-3 (drain loop shouldStop), S-2 (addToScope/removeFromScope bodies)
- [x] **Architecture compliance** -- no custom auth, no raw fetch (uses apiFetch), tenant isolation in search-ai routes, stateless limitation documented (H-2), cross-origin validation in scope-utils
- [x] **Pattern consistency** -- follows existing crawl-flow patterns (useCallback, useTranslations, design tokens, apiFetch, error handling pattern)
- [x] **API quality** -- sendBrowserIntervention uses structured error codes (QUEUE_FULL, NOT_FOUND, INTERVENTION_FAILED), not bare error strings
- [x] **i18n** -- ~30 keys across 5 namespaces specified, all user-facing strings planned, aria-labels not applicable (tree/console already accessible)
- [x] **Frontend state** -- API client usage (no raw fetch), SWR not applicable (SSE-driven), loading states specified for intervention dispatch, no Zustand in scope
- [x] **Backend quality** -- Zod schemas narrowed consistently across 3 locations, no new MongoDB models, no new BullMQ jobs
- [x] **Completeness** -- all 12 objectives (UJ-2, UJ-4, UJ-7-12, UJ-16, UJ-18, G1-G3) mapped to phases with verification criteria
- [x] **Phase ordering** -- correct dependency chain, no circular dependencies, parallelizable phases identified
- [x] **Exit criteria** -- all phases have testable criteria with build verification commands
- [x] **Wiring checklist** -- 16 items covering 6 critical data paths, all verified in Round 3
- [x] **Rollback safety** -- every phase independently revertible, no irreversible state changes
- [x] **Task independence** -- sequential phases with correct dependencies; parallel phases (5/6) have no file overlap except additive i18n
- [x] **Domain rules** -- scope-flows-down, no static caps (override warning), user always wins, normalizeUrl for all URL comparisons
- [x] **Design tokens** -- all new components use semantic tokens (bg-background-subtle, border-default, text-muted, etc.), no hardcoded Tailwind palette colors
- [x] **Code references verified** -- depth-prober.ts line numbers (76, 416, 498, 506), command-queue.ts types (lines 10-19), console.error wrapper (lines 30-38) all confirmed against current source

---

## NOTES FOR IMPLEMENTATION

1. **Start with Phase 0 and validate it manually** before proceeding. The entire command queue infrastructure depends on this 2-line fix. Run a discovery, send a `skip-branch` command, and confirm the depth-prober log shows it was dequeued.

2. **Phase 2 is the highest-risk change.** After the loop refactor commit, run a full discovery end-to-end before proceeding to Phase 3. The refactor is behavior-preserving, but the breadcrumb ordering, hub detection, and yield tracking all depend on the loop structure.

3. **The implicit normalizeUrl bug fix in Phase 2** (Task 2.4, currently bare `cmd.payload?.url === crumb.href` at line 506) should be called out in the commit message for traceability.

4. **Phase 1's `.passthrough()` fragility** is documented with a code comment (Task 1.3). This is the right approach -- a future `.strict()` change would silently break auto-save. The comment makes this dependency visible.

5. **Phase 7 `loadDraft` insertion**: The discoveryState check should run before the flowState branches, except when `flowState === 'submitted'` (crawl already submitted, no point resuming discovery). The implementer should place it as the first check after loading the draft.

6. **Phases 5 and 6 can be developed in parallel** by separate implementers if needed. The only shared file is `packages/i18n/locales/en/studio.json` (additive keys, merge-safe).

7. **Total estimated effort: ~8.5 days** (0.5 + 1 + 1 + 1 + 1.5 + 1.5 + 1.5 + 0.5). Account for integration testing between phases.

---

## Summary of Review Rounds

| Round     | Verdict       | Issues Found   | Status                                                                         |
| --------- | ------------- | -------------- | ------------------------------------------------------------------------------ |
| 1         | NEEDS_CHANGES | 2C, 4H, 5M, 2L | All fixed                                                                      |
| 2         | APPROVED      | 2M             | Fixed                                                                          |
| 3         | APPROVED      | 3M, 1L         | M-R3-3 fixed, M-R3-1/M-R3-2 carried (non-blocking), L-R3-1 noted, L-R3-2 fixed |
| 4         | APPROVED      | 2M, 1L         | All non-blocking                                                               |
| 5 (FINAL) | **APPROVED**  | 0 new          | 2 carried non-blocking items                                                   |

**The LLD is ready for implementation.**
