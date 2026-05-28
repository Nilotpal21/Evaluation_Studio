# Test Enrichment Review: Wave 1 LLD-Derived Scenarios

**Reviewer:** Phase Auditor
**Date:** 2026-03-24
**Artifact:** `docs/specs/sharepoint-connector-ux/testing/base-test-scenarios.md` (lines 278-784)
**Reference:** `docs/specs/sharepoint-connector-ux/wave1.lld.md` (T-01 through T-12 Acceptance Criteria)

---

## VERDICT: PASS with 3 minor coverage table inaccuracies

The 39 LLD-derived scenarios (LLD-W1-01 through LLD-W1-39) are well-structured, concrete, and appropriately typed. No duplicate coverage with the base E2E/INT scenarios was found -- the LLD scenarios correctly focus on implementation details (function signatures, cache behavior, Mongoose validation, Zod routes) while the base scenarios cover user journeys and service-boundary integration.

---

## Findings

### Coverage Table Inaccuracies (LOW -- cosmetic, no missing test logic)

1. **T-09 AC-02 mapped to LLD-W1-27 is incorrect.**
   AC-02 is `closePanel()` resets all panel state fields. LLD-W1-27 tests `openPanel()` only -- it never calls or asserts `closePanel()`. No scenario in the entire LLD-derived section tests `closePanel()`.
   **Fix:** Add LLD-W1-40 for `closePanel()` (Unit, verify `panelOpen: false`, `activeConnectorId: null` after calling `closePanel()`), and update the coverage table row to reference it.

2. **T-11 AC-03 mapped to LLD-W1-35 is incorrect.**
   AC-03 is `onCancel is called when Cancel button is clicked`. LLD-W1-35 tests confirm button enable/disable behavior -- it never clicks Cancel or asserts `onCancel`. LLD-W1-37 mentions Cancel but only in a disabled/loading context.
   **Fix:** Add LLD-W1-41 for Cancel button behavior (Component, mount with `onCancel` spy, click Cancel, verify callback invoked). Update the coverage table row.

3. **T-01 AC-03, T-04 AC-03, T-05 AC-04 all mapped to LLD-W1-39 is misleading.**
   LLD-W1-39 is specifically the `pnpm build --filter=studio` check for T-12. T-01 AC-03 requires `--filter=@agent-platform/connector-sharepoint --filter=@agent-platform/database`. T-04 AC-03 requires `--filter=@agent-platform/database`. T-05 AC-04 requires `--filter=@agent-platform/connector-sharepoint`. These are build verification steps, not functional scenarios, so this is low severity -- but the mapping implies they are covered when they are not by that specific scenario.
   **Fix:** Either add per-task build verification scenarios, or note in the table that build ACs are verified during implementation (not via test scenarios) and mark them as `Implementation-verified` rather than `Covered`.

---

## Checks Passed

- [x] **Every LLD AC from T-01 to T-12 maps to at least one scenario** -- all 42 ACs across 12 tasks appear in the coverage table (with the 3 inaccuracies noted above)
- [x] **No duplicate coverage with base scenarios** -- LLD scenarios test implementation internals (resolveScopes matrix, Mongoose enum validation, Redis SET NX PX, cache eviction, Zod route validation), while base E2E/INT scenarios test user journeys and service boundaries
- [x] **Test types are appropriate** -- Unit for pure functions (resolveScopes, Mongoose validation, store actions, cache), Integration for API/DB (audit routes, version routes, pause/resume with Redis), Component for React (panel width, tabs, TypeToConfirmInput)
- [x] **Assertions are concrete** -- every scenario has numbered assertions with specific expected values (scope arrays, error codes, CSS widths, state fields)
- [x] **Numbering is consistent** -- LLD-W1-01 through LLD-W1-39, no gaps or duplicates
- [x] **Cross-tenant isolation tested** -- LLD-W1-18 (audit) and LLD-W1-23 (versions) both verify 404 on cross-tenant access
- [x] **Platform invariants reflected** -- tenant scoping in LLD-W1-14/W1-15, no FullControl.All in LLD-W1-01, ConnectorError wrapping in LLD-W1-07

---

## Summary

39 scenarios, 2 missing (closePanel and onCancel), 3 misleading build-AC mappings. Otherwise clean. Adding 2 scenarios and fixing 3 table rows would make this fully accurate.
