# SDLC Log: workflow-as-tool — UI E2E Implementation Phase

**Feature**: workflow-as-tool (FR-8/FR-9 BETA gap)
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-14-workflow-as-tool-ui-e2e-impl-plan.md`
**Date Started**: 2026-04-14
**Date Completed**: 2026-04-14

---

## Preflight

- [x] LLD file paths verified — all 5 component files exist at expected paths
- [x] Function signatures current — Select, Tabs, Badge, Button checked for prop passthrough
- [x] No conflicting recent changes — working tree clean on Workflow_Tool branch
- Discrepancies: none

## Phase Execution

### LLD Phase 1: Testid Additions

- **Status**: DONE
- **Commit**: `e3c99ddf4c`
- **Exit Criteria**: all met (build clean, 13 testid patterns confirmed via grep, prettier clean)
- **Deviations**: Extended shared UI primitives (Select, Tabs, Badge) with optional `testid` props rather than wrapping in divs — cleaner approach than LLD suggested wrappers. 10 "deletions" in diff are from multi-line prop destructure rewrites, not removed behavior.
- **Files Changed**: 10 (5 tool components + 3 UI primitives + NewToolDropdown + ToolCard)

### LLD Phase 2a: Seed Helper + Config Specs (UI-E2E-1, UI-E2E-2)

- **Status**: DONE
- **Commit**: `a2bd9b2ad4`
- **Exit Criteria**: all met (no vi.mock, no direct DB access, prettier clean, 3 files + 1 modified)
- **Deviations**:
  - Used `status: 'archived'` instead of `status: 'draft'` for the non-visible workflow fixture — route-level Zod rejects `draft` (only `active|paused|archived` accepted). Archived achieves the same test effect (not shown in picker that filters `status === 'active'`).
  - Test exercises picker behavior via navigation to `/tools/new?type=workflow` rather than through ToolCreateDialog modal — the create dialog isn't easily opened for workflow type since it's not in NewToolDropdown. Adapted flow preserves all assertions.
- **Files Changed**: 3 new + 1 modified

### LLD Phase 2b: List Specs (UI-E2E-3, UI-E2E-4)

- **Status**: DONE
- **Commit**: `95683cbed1`
- **Exit Criteria**: all met (no mocks, no DB access, design-token color assertion reads from computed style not hex, prettier clean)
- **Deviations**: Cross-project isolation tests use `test.skip` when no second project is available rather than failing — graceful degradation for environments with single project.
- **Files Changed**: 1 new

### LLD Phase 3: Doc Sync

- **Status**: DONE
- **Commit**: `c39592f0fc`
- **Exit Criteria**: all met (every item annotated with either `[automated by UI-E2E-N]` or `[manual-only — visual/UX regression]`)
- **Deviations**: none
- **Files Changed**: 1 modified

## Wiring Verification

- [x] `workflow-seed.ts` helpers exported from `e2e/helpers/index.ts`
- [x] Both new spec files match Playwright's `testMatch` glob (`**/*.spec.ts`)
- [x] Testids compile into production bundle (not behind test guard)
- [x] ToolsListPage URL-param whitelist includes `'workflow'` (verified at line 119)
- [x] No new routes, DI registrations, model exports, or middleware
- [x] Manual smoke doc cross-references annotated (Phase 3)
- [x] `agents.md` in `apps/studio/` — updated after review rounds

## Review Rounds

| Round | Verdict        | Critical | High | Medium | Low |
| ----- | -------------- | -------- | ---- | ------ | --- |
| 1     | APPROVED       | 0        | 0    | 4      | 3   |
| 2     | APPROVED       | 0        | 0    | 4      | 4   |
| 3     | NEEDS_REVISION | 0        | 3    | 5      | 3   |
| 4     | APPROVED       | 0        | 0    | 2      | 1   |
| 5     | PASS           | 0        | 0    | 0      | 2   |

### Fix Commits

- `80b9f79c26` — R1: replace waitForTimeout with condition-based waits, convert pickerVisible guards to hard assertions
- `e3c9fcfddd` — R2: badge count assertion, empty-state text, save+refresh persistence
- `68eb5f9d5c` — R3: harden soft guards on save button, binding panel text assertions
- `194a3cbc87` — R4: re-authenticate in afterAll to prevent stale token cleanup failures
- `02128e73bd` — R5: remove dead helper, replace remaining waitForTimeout in beforeAll

### Deferred Findings

- **R2-02**: Picker-level cross-project isolation — server-side validation, covered by runtime integration tests
- **R2-04**: No-flash continuous assertion — deferred per LLD D-5, to MutationObserver if flakes observed
- **R3-01**: Create Tool dialog flow for workflow — invalid finding, no UI path exists (workflow tab has no Create button)
- **R3-03**: Draft status fixture — invalid finding, Zod rejects `draft`, `archived` achieves same test effect
- **R4-02**: Dynamic testid in ToolCard with tool ID — accepted, tool IDs already exposed in URLs
- **R4-03**: Cross-project test.skip when single project — accepted, `test.skip` pattern is standard

## Acceptance Criteria

- [x] Phase 1 testids commit landed; `pnpm build --filter=@agent-platform/studio` clean
- [x] Phase 2a spec file lands
- [x] Phase 2b spec file lands
- [ ] UI-E2E-1..4 pass 3 consecutive local runs (blocked on dev environment — specs written, not yet executed)
- [x] `grep -rn "vi.mock|jest.mock" apps/studio/e2e/workflow-tool-*.spec.ts` → 0 hits (excluding comments)
- [x] `grep -rn "mongoose|from '@agent-platform/database/models'" apps/studio/e2e/workflow-tool-*.spec.ts` → 0 hits
- [x] Phase 3 doc annotations complete
- [ ] `/post-impl-sync workflow-as-tool` flips FR-8/FR-9 → BETA (after review rounds)

## Learnings

- Shared UI primitives (Select, Tabs, Badge) lacked `data-testid` passthrough — extending with optional `testid` prop is cleaner than wrapper divs
- Route-level Zod for workflow creation accepts `active|paused|archived` but NOT `draft` — use `archived` in E2E fixtures as equivalent of "not visible in active-only pickers"
- Workflow tool creation through ToolCreateDialog requires full config (workflowId + triggerId) before submit is enabled — picker testing must happen inside the dialog flow, not on the detail page
- ToolsListPage's workflow tab has no "Create Tool" button (primaryAction is undefined for workflow/searchai tabs) — the `/tools/new?type=workflow` URL is the correct entry point for E2E
- Re-authenticate in afterAll to prevent cleanup failures from expired JWT tokens in long-running serial test suites
- Prefer condition-based waits (firstCard.waitFor, expect().toBeVisible) over waitForTimeout everywhere including beforeAll — eliminates fixed 2s delays and CI flakiness
