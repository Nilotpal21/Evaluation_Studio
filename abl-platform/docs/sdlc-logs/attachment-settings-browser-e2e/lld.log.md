# LLD Log: Attachment Settings Browser E2E

**Feature**: attachment-settings-browser-e2e (closes GAP-003)
**Date**: 2026-03-22

---

## Oracle Decisions (Phase 2)

| #   | Question                         | Classification | Decision                                                                     |
| --- | -------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| 1   | Config file choice               | INFERRED       | Use default `playwright.config.ts` (matches all existing specs)              |
| 2   | Shared fixture vs inline helpers | DECIDED        | Inline helpers per spec (matches all existing specs)                         |
| 3   | Minimum browser E2E scenarios    | DECIDED        | 6 scenarios covering UI-specific gaps (form, indicators, MIME, reset, toast) |
| 4   | Fresh project vs reuse           | DECIDED        | Reuse first available project; cleanup via API reset                         |
| 5   | CI vs manual                     | INFERRED       | Manual-only (matches all existing Playwright specs)                          |
| 6   | PM2 vs webServer                 | INFERRED       | Assume PM2/pnpm dev manages services externally                              |
| 7   | Data seeding approach            | DECIDED        | Hybrid: UI for primary flows, API for setup/teardown                         |
| 8   | Save-reload-verify               | DECIDED        | Full round-trip (primary value of browser E2E)                               |
| 9   | Selector strategy                | DECIDED        | Prefer aria-label selectors (getByLabel); fallback to text/role              |
| 10  | Visual regression                | DECIDED        | No baselines in this spec (separate visual-baseline.spec.ts)                 |
| 11  | Login pattern                    | DECIDED        | API-based login (model-guardrails pattern, more robust)                      |
| 12  | Sidebar auto-expand              | INFERRED       | Yes, navigating to URL auto-expands Settings group                           |
| 13  | Error toast testing              | DECIDED        | Out of scope (already covered by unit tests)                                 |

No AMBIGUOUS items. All resolved from codebase patterns and documentation.

---

## Audit Rounds

### Round 1: Architecture Compliance (lld-reviewer)

**Verdict**: APPROVED
**Findings**: 1 MEDIUM (BRW-2 badge assertions unscoped), 2 LOW (D-1 count, BRW-4 note)
**Resolutions**: Scoped BRW-2 to field containers, corrected D-1 count, added BRW-4 intent note

### Round 2: Pattern Consistency (lld-reviewer)

**Verdict**: NEEDS_CHANGES
**Findings**: 2 HIGH (missing test.describe.serial, wrong config file), 4 MEDIUM (missing setTimeout, devLogin abbreviated, Tailwind class selectors, non-idiomatic assertions)
**Resolutions**: Added test.describe.serial + test.setTimeout(120_000), switched to default playwright.config.ts, added devLogin 70-line copy note, replaced Tailwind selectors with semantic locators, used toHaveAttribute/toHaveValue/toBeDisabled

### Round 3: Completeness (lld-reviewer)

**Verdict**: NEEDS_CHANGES
**Findings**: 1 HIGH (page closed in beforeAll — tests get fresh page without auth), 2 MEDIUM (maxFileSizeBytes no browser coverage, container locator ambiguity), 2 LOW (afterAll redundant, BRW-4 wrong cross-ref)
**Resolutions**: Shared page across tests (kept open), added maxFileSizeBytes to BRW-3, added .first() to container locators, simplified afterAll, fixed BRW-4 cross-ref

### Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict**: APPROVED
**Findings**: 3 MEDIUM (FR-9/10 not explicitly delegated, BRW-4 wrong E2E cross-ref, D-9 missing full path)
**Resolutions**: Added FR Coverage Delegation table, fixed BRW-4 to E2E-6/E2E-10, added full path to visual-baseline.spec.ts

### Round 5: Final Sweep (lld-reviewer)

**Verdict**: APPROVED
**Findings**: 2 LOW (container selector .first() picks outermost div, test count may drift)
**Resolutions**: Non-blocking — documented as implementer notes. Both are functionally correct for current test preconditions.

### Summary

- 5 rounds completed
- 0 CRITICAL findings across all rounds
- 3 HIGH findings — all resolved
- 10 MEDIUM findings — all resolved
- 6 LOW findings — 4 resolved, 2 non-blocking
- All prior-round fixes verified in subsequent rounds
