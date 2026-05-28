# SDLC Log: Arch AI Audit Logs — Post-Implementation Sync

**Feature**: arch-audit-logs
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-12

## Documents Updated

- [x] Feature spec: `docs/features/arch-audit-logs.md` — Status PLANNED→ALPHA, §10 test files updated with actual paths+status, §17 coverage updated (29 unit PASS, integration/E2E planned)
- [x] Test spec: `docs/testing/arch-audit-logs.md` — Status PLANNED→IN PROGRESS, LLD path added, coverage matrix updated with UNIT PASS / CODE ONLY / planned
- [x] Testing index: `docs/testing/README.md` — Status updated to IN PROGRESS (ALPHA), 29 unit passing
- [x] HLD: `docs/specs/arch-audit-logs.hld.md` — Status DRAFT→APPROVED
- [x] LLD: `docs/plans/2026-04-12-arch-audit-logs-impl-plan.md` — Status DRAFT→DONE (Phases 1-4)
- [x] Feature index: `docs/features/README.md` — Status PLANNED→ALPHA

## Coverage Delta

| Type              | Before | After                    |
| ----------------- | ------ | ------------------------ |
| Unit tests        | 0      | 29 passing (3 files)     |
| Integration tests | 0      | 0 (planned in test spec) |
| E2E tests         | 0      | 0 (planned in test spec) |

## Remaining Gaps

- Integration tests (8 scenarios) not yet written — require running Studio with real MongoDB
- E2E tests (10 scenarios) not yet written — same requirement
- Build-level audit emission limited: `onStepFinish` only wired for ONBOARDING `startStream()`, not BUILD `streamText()` (build uses `onFinish` which captures totals after completion)
- IN_PROJECT `VercelLLMStreamClient` `streamText()` does not yet have audit emission (Phase 3 focused on ONBOARDING path)
- `phase-transition.ts` not yet modified (lower priority — phase transitions are infrequent)
- Tenant-delete cascade hook not yet registered (documented in HLD, deferred)

## Deviations from Plan

- LLD Phase 3 was scoped down: only ONBOARDING `startStream()` `onStepFinish` was wired (the primary path). BUILD and IN_PROJECT emission deferred to avoid high-risk changes to the parallel generation code.
- LLD Phase 5 (E2E tests) deferred entirely — requires live server infrastructure.
- Build audit emission uses post-completion logging instead of per-step `onStepFinish` (build `streamText` runs in parallel worker functions that don't have `auditEmitter` in scope without signature changes).
