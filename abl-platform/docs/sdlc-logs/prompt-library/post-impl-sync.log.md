# SDLC Log: Prompt Library — Post-Implementation Sync

**Feature**: prompt-library
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-28

---

## Documents Updated

- [x] Feature spec: `docs/features/prompt-library.md`
  - Status: PLANNED → ALPHA
  - Last Updated: 2026-04-28
  - §10 UI Components: Replaced 3 non-existent Next.js page.tsx entries with actual SPA component paths (`PromptLibraryListPage.tsx`, `PromptLibraryDetailPage.tsx`, `PromptLibraryComparePage.tsx`); added `AppShell.tsx` (MODIFIED) and `apps/studio/src/api/prompt-library.ts` (NEW)
  - §10 Routes: Fixed Studio proxy paths from `[projectId]` to `[id]`
  - §10 Tests: Fixed 2 database test file paths to actual `packages/database/src/__tests__/model-prompt-library-*.test.ts` paths
  - §17 Testing Coverage: Updated all 12 scenarios from "NOT TESTED" to COVERED/PARTIAL with rationale
  - §18 References: Removed "(forthcoming)" placeholder from HLD reference

- [x] Test spec: `docs/testing/prompt-library.md`
  - Status: PLANNED → ALPHA
  - Last Updated: 2026-04-28
  - §1 Current State: Updated from "zero implementation" to actual completion state
  - Coverage Matrix: All 15 FRs updated from NOT → PASS or PARTIAL with deferred rationale
  - INT-12 boundary path: Fixed `[projectId]` → `[id]` in scenario description and §10 file mapping
  - §10 File Mapping: Fixed 2 database test file paths and INT-12 proxy path
  - §13 References: Removed "(forthcoming)" from HLD/LLD; resolved `<date>` placeholder to `2026-04-27`

- [x] Testing index: `docs/testing/README.md`
  - Updated prompt-library row: `7 planned / 12 planned / PLANNED 04-27` → `7 implemented / 12 implemented / ALPHA 04-28`
  - Updated Last Updated: 2026-04-27 → 2026-04-28

- [x] Features index: `docs/features/README.md`
  - Updated prompt-library row: `PLANNED / SPEC 04-27` → `ALPHA / IMPL 04-28`

- [x] HLD: `docs/specs/prompt-library.hld.md`
  - Status: APPROVED → IMPLEMENTED
  - Added Completed date: 2026-04-28

- [x] LLD: `docs/plans/2026-04-27-prompt-library-impl-plan.md`
  - Status: APPROVED → DONE
  - Added §8 Post-Implementation Notes with 5 documented deviations

- [x] Package agents.md files (4 packages):
  - `apps/runtime/agents.md`: 4 learnings (singleton factory, promote idempotency, LLM error sanitization, sourceHash coverage)
  - `packages/database/agents.md`: 2 learnings (tenantIsolationPlugin pattern, test file location convention)
  - `packages/compiler/agents.md`: 1 learning (dynamic field injection for compiler hook)
  - `packages/shared-auth/agents.md`: 1 learning (PERMISSION_REGISTRY + aliases map pair update)

---

## Coverage Delta

| Type        | Before | After         |
| ----------- | ------ | ------------- |
| Unit tests  | 0      | 8 test files  |
| Integration | 0      | 8 test files  |
| E2E         | 0      | 4 test files  |
| Helper      | 0      | 1 helper file |
| Perf bench  | 0      | 1 perf file   |

---

## Remaining Gaps (Deferred to Post-ALPHA)

- E2E-1 steps 3-7: agent deploy + session execution path (requires full agent deploy + session harness)
- E2E-6: per-role project member provisioning for tester/viewer role enforcement
- INT-10 HTTP 500 sub-scenario: partial pane failure with real provider 500 response
- Trace events: `prompt-library.test.start/pane.start/pane.complete` not yet emitted (observability enhancement, not correctness requirement)

---

## Deviations from Plan (Documented)

1. Studio pages are SPA-routed via `AppShell.tsx` `case 'prompt-library'`, not Next.js file-system pages as originally planned
2. Test endpoint API uses `panes: [{ promptVersionId, tenantModelId }]` flat array (not `mode`/`tenantModelIds` as in original test spec)
3. `AgentBasedDocument.systemPromptLibraryRef` injected dynamically via `as unknown as` cast (compiler stays pure)
4. Promote idempotency added (already-active version returns 200, not 409)
5. `usageCount` decrement descoped to v1.5 (increment-only in v1)

---

## Audit Findings Fixed

- CRITICAL PS-1: 6 stale database test file paths fixed across feature spec + test spec
- CRITICAL PS-2: `[projectId]` → `[id]` in feature spec Studio proxy paths (2 locations)
- HIGH PS-3: Test spec status updated to ALPHA
- HIGH PS-4: "(forthcoming)" placeholders removed from test spec §13
- HIGH PS-6: agents.md learnings added for all 4 affected packages
- MEDIUM PS-5: Testing README Last Updated updated to 2026-04-28
- MEDIUM PS-7: FR-5 PARTIAL annotated with specific deferred sub-scenario
