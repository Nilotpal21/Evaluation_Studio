# Post-Implementation Sync Log: Attachments (Round 2)

**Date**: 2026-03-22
**Phase**: POST-IMPL-SYNC
**Feature**: Attachments — attachment settings UI, browser E2E, gap closures

---

## Trigger

Sync after attachment settings UI implementation, browser E2E tests, and gap closures (commits 97c6f0902 through 08e656920).

## Documents Updated

| Document      | Path                            | Changes                                                                                              |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Feature Spec  | `docs/features/attachments.md`  | Status ALPHA→BETA, GAP-001 resolved, §8 Studio Settings added, §10 settings UI files, §17 test notes |
| Test Spec     | `docs/testing/attachments.md`   | FR matrix re-aligned to spec FR-1–FR-15, 8 new test files, FR-28→T-3 PASS, GAP-T4 resolved           |
| HLD           | `docs/specs/attachments.hld.md` | Status→BETA, Post-Implementation Notes section added                                                 |
| Testing Index | `docs/testing/README.md`        | Added Attachments entry (BETA, 5 gaps)                                                               |

## Coverage Delta

| Type              | Before            | After                      | Notes                                          |
| ----------------- | ----------------- | -------------------------- | ---------------------------------------------- |
| Unit tests        | ~174 across 51    | ~197 across 53 files       | +23 attachment settings tab/save tests         |
| Integration tests | 28 across 7 files | 46 across 9 files          | +14 config validation + 4 Studio proxy         |
| E2E tests (API)   | 26 across 4 files | 36 across 5 files          | +10 config API CRUD/permissions/isolation      |
| Browser E2E       | 0                 | 6 across 1 Playwright spec | Attachment settings UI load, save, MIME, reset |

## GAP Status Changes

| GAP     | Previous  | Current   | Notes                                                          |
| ------- | --------- | --------- | -------------------------------------------------------------- |
| GAP-001 | Open      | Resolved  | Studio settings UI built (AttachmentSettingsTab + proxy route) |
| GAP-002 | Open      | Open      | PII block/allow full-path E2E still skipped (E2E-0.3/0.4)      |
| GAP-003 | Open      | Open      | No admin UI for tenant-level config                            |
| GAP-004 | Mitigated | Mitigated | External services still not in CI                              |
| GAP-005 | Open      | Open      | AWAIT_ATTACHMENT not fully wired in runtime production code    |
| GAP-006 | Open      | Open      | multimodal-service still uses console.error (no createLogger)  |
| GAP-T4  | Open      | Resolved  | Studio attachment settings UI tests now comprehensive          |

## Phase Auditor Findings

Round 1 of 1:

- **PS-1 (CRITICAL)**: FR numbering misalignment → FIXED (re-mapped to FR-1–FR-15 with sub-items, T-\* for test-only items)
- **PS-2 (HIGH)**: SDK paths wrong (`packages/sdk/` → `packages/web-sdk/`) → FIXED
- **PS-3 (HIGH)**: HLD status inconsistent → FIXED (changed to BETA)
- **PS-6 (MEDIUM)**: Cross-cutting agents.md processing mode enum divergence → DEFERRED (not blocking)

## Key Learnings

- The parent feature spec's GAP-004/005/006 and the sub-feature spec's GAP-004/005/006 are DIFFERENT issues with the same IDs — caused confusion during closure tracking
- Test spec FR numbering must trace to the authoritative feature spec — divergent numbering was caught by phase-auditor
- SDK package was renamed from `packages/sdk/` to `packages/web-sdk/` but test spec paths were never updated — stale references
