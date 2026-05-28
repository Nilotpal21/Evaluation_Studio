# SDLC Log: Auth Profile Phase 2 Core Auth Types — Post-Implementation Sync

**Feature**: `auth-profile-phase2-core-auth-types`
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-24

---

## Documents Updated

- [x] Feature spec: `docs/features/sub-features/auth-profile-phase2-core-auth-types.md` — status `PLANNED` -> `ALPHA`, synced shipped Studio/runtime surfaces, updated implementation files, converted open questions into resolved implementation decisions, and refreshed the remaining-gap table
- [x] Test spec: `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md` — status `PARTIAL` -> `IN PROGRESS`, marked actual E2E/integration coverage, added surface-semantics + production-wiring verification, and refreshed test file mapping
- [x] Testing index: `docs/testing/README.md` — updated both feature rows to current E2E/integration counts and `IN PROGRESS (ALPHA)` status
- [x] HLD: `docs/specs/auth-profile-phase2-core-auth-types.hld.md` — status `DRAFT` -> `APPROVED`, added post-implementation notes and resolved implementation decisions
- [x] LLD: `docs/plans/2026-04-23-auth-profile-phase2-core-auth-types-impl-plan.md` — status `DRAFT` -> `DONE`, updated docs acceptance criterion, resolved implementation questions, and added wiring evidence / post-implementation notes
- [x] Package learnings: `apps/runtime/agents.md`, `apps/studio/agents.md`, `packages/shared/agents.md`, `packages/compiler/agents.md` — appended post-implementation learnings discovered during the doc audit

## Coverage Delta

| Type              | Before     | After                                  |
| ----------------- | ---------- | -------------------------------------- |
| Unit tests        | 0 verified | 5 mapped files                         |
| Integration tests | 0 verified | 6 passing scenario families            |
| E2E tests         | 0 verified | 1 runtime harness covering 6 scenarios |

## Remaining Gaps

- Repo-wide `pnpm build` followed by broader affected-package `pnpm test` was not rerun in this pass; verification used affected-package builds plus targeted suites.
- `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts` exists, but the browser-level Playwright smoke path was not rerun in this pass.
- Five structured review rounds / equivalent PR review are still pending, so the feature remains `ALPHA` instead of promoting to `BETA`.
- Feature-specific public-API isolation regressions for this exact slice are still partial; current isolation evidence is inherited from broader auth-profile route coverage plus sanitized failure assertions.

## Deviations from Plan

1. Phase 5 E2E landed in the existing Studio tool-invocation E2E harness (`apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`) instead of a brand-new dedicated auth-profile E2E file.
2. Verification used affected-package builds and targeted suites rather than a repo-wide `pnpm build` / `pnpm test` sweep.
3. Browser-level UI smoke coverage was added as `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts`, but it remains a follow-up verification item rather than a completed part of this pass.

## Status Transition Justification

**PLANNED -> ALPHA** because:

- [x] All five implementation phases are complete in this worktree
- [x] Core happy paths work for `basic`, `custom_header`, `aws_iam`, and `mtls`
- [x] Affected-package `pnpm build` passed before the targeted test runs
- [x] Real E2E coverage now demonstrates the shipped runtime path end to end
- [x] Feature spec, test spec, testing index, HLD, and LLD now reflect the implementation reality
- [x] Remaining gaps are documented explicitly

**Not promoted to BETA** because:

- [ ] Structured review / PR review equivalent is not complete
- [ ] Browser-level UI smoke spec was not rerun in this pass
- [ ] Broader repo-wide validation is still pending

## Verification Pass

- [x] Coverage matrix entries match actual test files listed in the refreshed test-file mapping
- [x] Feature-spec file paths were rechecked against the repo before being copied into inventories
- [x] Studio and runtime surfaces distinguish attach-only raw-connection behavior from the supported honored HTTP tool path
- [x] Production wiring verification is documented in the test spec
- [x] Status fields are consistent across feature spec, test spec, testing index, HLD, and LLD
- [x] Deviations from the original plan are documented

## Phase Handoff Packet

**Phase**: Post-Impl Sync
**Status**: COMPLETE

**Objective**:

- Sync the feature, testing, and design docs to the actual Phase 2 core auth-type implementation
- Record the remaining work that still blocks BETA / broader closure

**Scope**:

- Feature spec, test spec, testing README, HLD, LLD, and package learnings
- No new product code, build logic, or test behavior changes

**Evidence Files**:

- `docs/features/sub-features/auth-profile-phase2-core-auth-types.md`
- `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md`
- `docs/specs/auth-profile-phase2-core-auth-types.hld.md`
- `docs/plans/2026-04-23-auth-profile-phase2-core-auth-types-impl-plan.md`
- `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

**Key Decisions**:

- [DECIDED] Feature status is `ALPHA`, not `BETA`, because review rounds and broader closure proofs are still pending
- [DECIDED] Raw connection support for `aws_iam` and `mtls` is documented as attach-only, with the supported honored runtime path remaining the HTTP tool executor
- [DECIDED] The shared support matrix in `packages/shared/src/validation/auth-profile-support-matrix.ts` is the canonical compatibility source for Studio and Runtime

**Open Ambiguities**:

- Whether browser-level Playwright smoke coverage should become a mandatory proof for auth-profile UI post-impl sync
- Whether a dedicated public-API isolation regression should land in Studio E2E or a runtime HTTP harness first

**Invariants**:

- Do not treat raw connection attachment as proof of SigV4 or mTLS honoring
- Preserve fail-closed behavior for incomplete AWS IAM signing context and plain-HTTP `mtls`
- Keep compatibility decisions centralized in the shared support matrix

**Next-Phase Obligations**:

- Rerun broader validation (`pnpm build` / affected-package `pnpm test`) if the feature is being promoted beyond current ALPHA closure
- Run the pending Playwright UI smoke spec and record the result
- Complete the required review rounds / PR review equivalent before claiming BETA
