# SDLC Log: workflow-triggers — Post-Impl-Sync

**Feature**: workflow-triggers
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-19
**Branch**: `feat/workflow-version`

---

## Iteration 1 (2026-04-19) — Trigger-surface polish

**Implementation commit**: `a98c6fa5ab [ABLP-2] fix(workflow-engine): persist canonical cron config and harden trigger UI`

This is the first post-impl-sync entry for the workflow-triggers sub-feature. The feature spec itself is still `Status: PLANNED` because the main body of work (Process API, callback delivery, external-app catalog) has not been promoted through the SDLC pipeline yet. This sync captures a narrow polish pass on the existing `TriggerEngine.register()` + `WorkflowTriggersTab` surfaces.

### Files Changed (Implementation)

| File                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/services/trigger-engine.ts`               | `register()` now resolves preset/cronExpression once and writes the canonical expression to both `config.cronExpression` (primary) and legacy top-level `cronExpression`. Preset-resolution errors caught and logged (trigger persists). Cron triggers registered without a BullMQ scheduler are persisted with an explicit `log.warn`. `resume()` reads `config.cronExpression` first, with fallback to `trigger.cronExpression`; emits the same warn log when scheduler absent. |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` | Collapsible trigger cards (`aria-expanded` + `aria-controls`); `formatCronPreset()` human-readable fallback for preset-only records; `handleFire()` fail-fast on non-active triggers; `normalizeTrigger()` multi-shape cron lookup; Skeleton-based loading state (`data-testid="triggers-loading"`); lifecycle actions switched to `Button size="sm"` for alignment.                                                                                                              |

### Documents Updated

- **Feature spec `docs/features/sub-features/workflow-triggers.md`**:
  - Last Updated → 2026-04-19
  - §10 Domain/Core Logic: `trigger-engine.ts` row extended with 2026-04-19 notes
  - §10 UI Components: `WorkflowTriggersTab.tsx` row extended with 2026-04-19 notes
  - §16 added GAP-008, GAP-009, GAP-010, GAP-011 as Mitigated with descriptions
  - §16 new "Mitigation Notes (2026-04-19)" block
  - §17 added rows 16–19 (all NOT TESTED — follow-up test work)
- **Test spec `docs/testing/sub-features/workflow-triggers.md`**:
  - Last Updated → 2026-04-19
  - Appended "Post-ALPHA Trigger-Surface Polish (2026-04-19)" block with G-008..G-011 mini-matrix (all uncovered) + test-writing recommendations
- **HLD `docs/specs/workflow-triggers.hld.md`**:
  - Added `Last Updated: 2026-04-19`
  - New "Post-Implementation Notes (2026-04-19 — trigger-surface polish)" section describing the four gap closures; explicitly notes no architectural decisions overturned

### Coverage Delta

| Type              | Before              | After                                                     |
| ----------------- | ------------------- | --------------------------------------------------------- |
| Unit tests        | 0 (on this surface) | 0 (no new tests — rows 16–19 are NOT TESTED placeholders) |
| Integration tests | 0                   | 0                                                         |
| E2E tests         | 0                   | 0                                                         |

No net test coverage added. The commit is intentionally fix-only; follow-up work in `apps/workflow-engine/src/__tests__/trigger-engine.test.ts` and `apps/studio/e2e/workflows/` is recommended (see test spec's trigger-surface block for specifics).

### Remaining Gaps

All workflow-triggers baseline gaps (GAP-001..GAP-007) remain **Open** — none addressed by this commit. The new GAP-008..GAP-011 are all **Mitigated**.

### Deviations from Plan

- **No test coverage shipped with the polish commit**: deliberate — the engine and UI behaviors are defensive and verified by manual smoke test + Coroot warn-log assertions. Adding test-side work in the same commit would push it over the per-package scope limit and delay the user-visible UI fix. Follow-up Vitest + Playwright rows tracked in the test spec.
- **Feature spec stays at `Status: PLANNED`**: the broader Process API + callback delivery + external-app catalog is still pre-ALPHA. This polish does not promote the feature.

### Audit

- `phase-auditor` round 1 of 1 — **APPROVED** (0 CRITICAL, 0 HIGH, 1 LOW on GAP-009 quoted log text — fixed in same sync commit to say `"Cron trigger persisted/resumed but scheduler is unavailable …"` matching actual `log.warn` output; 2 MEDIUM agents.md gaps addressed in same commit).

### Feature Status Lifecycle

- **Status unchanged**: PLANNED. Polish is additive over existing partially-landed trigger infrastructure; no lifecycle transition warranted.
