# Pre-existing test failures — arch-v0.3 7→9 ship-gate run

**Branch:** `arch/promptrefine`
**Baseline captured:** 2026-04-16 (before CP1 commits)
**Baseline source:** `test-reports/SUMMARY.md`

These failures exist on the branch **before** any CP1/CP2/CP3/CP4/CP5 commits.
They are NOT regressions introduced by this multi-checkpoint run. They are
logged here so CP reviewers can distinguish inherited breakage from new
breakage.

## Totals (baseline)

| Metric          | Count |
| --------------- | ----- |
| Total tests     | 34019 |
| Passed          | 33670 |
| **Failed**      | **5** |
| Skipped         | 0     |
| Packages tested | 46    |

## Failing packages

| Package                     | Failed | Total | Duration |
| --------------------------- | ------ | ----- | -------- |
| `apps-studio--unit-shard-1` | 3      | 798   | 10.0s    |
| `packages-shared-kernel`    | 2      | 483   | 5.0s     |

## Failure details

### 1. `apps-studio--unit-shard-1` — data-hooks.test.ts (2 failures)

**File:** `apps/studio/src/__tests__/hooks/data-hooks.test.ts`

- `useKnowledgeBase should pass null keys when kbId is null`
- `useKnowledgeBase should construct correct SWR key for KB detail`

Both are SWR key-construction assertion mismatches. Mock spy expectation drift.
Unrelated to v0.3 arch work or CP1 docs.

### 2. `apps-studio--unit-shard-1` — data-section.test.tsx (1 failure)

**File:** `apps/studio/src/__tests__/search-ai/data-section.test.tsx`

- `DocumentTable renders document rows with title, source type, status badge, date, size`

Testing-Library can't find the text "file" — likely a UI string drift in the
search-ai DocumentTable component. Unrelated to v0.3 arch.

### 3. `packages-shared-kernel` — architecture-fitness.test.ts (2 failures)

**Files:**

- `packages/shared-kernel/dist/__tests__/architecture-fitness.test.js`
- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`

Same underlying ratchet:

- `Ratchet: Workspace Package Count total workspace packages = 44 (update when adding/removing)`
- `AssertionError: Found 47 packages (expected 46): expected 47 to be 46`

The workspace package count ratchet is stale — 47 packages exist but the
constant says 46 (and the test comment says 44). This is an intentional
"update me when adding packages" ratchet and is tripped by branch history, not
by CP1 docs. Fix is a 1-line constant bump; out of scope for this run.

## Post-commit re-check

After each CP commit, re-run `pnpm test:report` and compare. If new failures
appear beyond these 5, they are regressions caused by that commit and must be
fixed forward before the handoff.
