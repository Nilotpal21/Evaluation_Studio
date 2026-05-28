# SDLC Log: workflow-as-tool — Implementation Phase

**Feature**: workflow-as-tool
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md`
**Date Started**: 2026-04-13
**Date Completed**: IN PROGRESS

---

## Preflight

- [x] LLD file paths verified (Phase 1 target files exist: schema.ts, tool-schema-validator.ts, compiler.ts)
- [x] `WorkflowBindingIR` at schema.ts:881-886 still shape-compatible with LLD (no `triggerId` yet — will be added)
- [x] Working tree clean, branch `Workflow_Tool`, last commit `f402a22a3c` (LLD doc commit)
- [x] No conflicting recent changes in target files
- Discrepancies: none

## Phase Execution

### LLD Phase 1: IR & Validator Foundation

- **Status**: DONE
- **Commit**: `d84ba79467`
- **Exit Criteria**: all pass (build 0 errors, tool-schema-validator 29 tests, tool-binding-executor-connector 5 tests, rg consumers clean)
- **Files Changed**: 6 (schema.ts, tool-schema-validator.ts, compiler.ts, 2 test files, 1 change manifest)
- **Deviations**: Added `docs/specs/workflow-as-tool.changes.md` manifest (additive). Used `as string | undefined` cast on `tool.type` in `inferToolHints` — Phase 2 must add `'workflow'` to `@abl/core`'s `ToolType`. A separate `packages/connectors/src/executor/workflow-tool-executor.ts` already exists with its own `WorkflowBinding` interface — Phase 3 must reconcile.

### LLD Phase 2: DSL Parser, DB, Shared-Tool Plumbing

- **Status**: DONE
- **Commits**:
  - `bf7b7540be` — `feat(core): widen ToolType` (2 files)
  - `338d0c4257` — `feat(database): workflow enum + extractor` (2 files)
  - `ede3fc8353` — `feat(shared): DSL parser + adapters + Zod` (11 files across shared + shared-kernel)
- **Exit Criteria**: all pass (builds 0 errors, dsl-property-parser 62 tests / 6 new, project-tool-schemas.workflow 10 tests)
- **Deviations**: `packages/shared-kernel` modified (not in LLD file list) because `ProjectToolFormData`/`ToolFormBase` live there. Additive-only — new `WorkflowToolFormData` interface, widened union/base.
- **Phase 3 note**: `packages/connectors/src/executor/workflow-tool-executor.ts` has a pre-existing `WorkflowBinding` (no `triggerId`, different field names) — Phase 3 must reconcile or replace.

### LLD Phase 3: WorkflowToolExecutor

- **Status**: DONE
- **Commits**:
  - `63259bd64f` — `feat(runtime): WorkflowToolExecutor` (executor 400 LOC + docs)
  - `68d560366b` — `test(runtime): unit + integration tests` (563 LOC tests)
- **Exit Criteria**: all pass (build 0 errors, 27 unit tests across UT-4/UT-6, 4 integration tests INT-1/2/3/7, executor exactly 400 LOC)
- **Deviations**:
  - `WorkflowBindingIR` re-declared locally in executor — Phase 5 must add it to `packages/compiler/src/index.ts` barrel and replace local decl with proper import.
  - No existing JSONPath helper — inline minimal `$.a.b.c` resolver implemented as planned fallback (logged as tech debt in lld.log.md).
- **Phase 5 finding**: verify LLMWiringService deduplicates by `toolCallId` at the dispatch layer (v1 gap mitigation).

### LLD Phase 4: Validator & IR Loader

- **Status**: DONE
- **Commits**:
  - `338c4d08f1` — `feat(shared): sync+async validator + DB cross-check + compiler barrel`
  - `0f520d0719` — `feat(runtime): IR loader workflow case + derived parameters + executor import fix`
  - `383f115c21` — `feat(studio): wire async validator into tool-create route`
  - `52fe86053d` — `test(shared,runtime): INT-4 (9 cases) + INT-5 (2 cases)`
- **Exit Criteria**: all pass (builds 0 errors, INT-4 9/9, INT-5 2/2, cross-project returns 404)
- **Deviations**: INT-4 has 9 cases (3 sync + 6 async) vs LLD spec of 4 — extra inactive/user_level coverage. `loadProjectToolsAsIR` inner `.map()` converted to `Promise.all(async ...)`. `derivedParameterSchema` attached via `unknown` cast.
- **Phase 5 inputs**:
  - `WorkflowBindingIR` barrel export now live — can import directly from `@abl/compiler`
  - `derivedParameterSchema` on `ToolDefinition` is not typed — Phase 5 wiring should re-derive `inputVariables` or use typed accessor
  - Telemetry log at `llm-wiring.ts:~1301` needs `workflowTools` count (per LLD 5.2)

### LLD Phase 5: Wiring + Engine Isolation + Agent E2E

- **Status**: DONE
- **Commits**:
  - `716d998c3b` — `feat(runtime): llm-wiring executor + telemetry`
  - `edaab4b067` — `test(runtime): UT-5 + E2E-1..7`
  - `13c1890b54` — `test(workflow-engine): INT-6 isolation`
  - `9e5c52fa4e` — `docs: phase 5 manifest + agents.md`
- **Exit Criteria**: all pass — 17/17 tests pass (UT-5 3/3, INT-6 4/4, E2E-1/2/3/6 4/4, E2E-4/5 2/2, E2E-7 4/4); builds clean; wiring block additive
- **Deviations**: added vitest config file excludes/includes to isolate E2E vs fast runs (additive config-only).

### LLD Phase 6: Studio UI

- **Status**: DONE (with deviations — see below)
- **Commits**:
  - `295b12cc10` — `feat(studio): store, badges, list tab, detail panel`
  - `fdd618a40d` — `feat(studio): create dialog, config form, serializer, test service`
  - `c6632bbfcd` — `feat(i18n): Studio workflow tool keys`
  - `1e8115f182` — `docs(testing): manual Studio smoke test`
- **Exit Criteria**: build 0 errors, i18n keys added, design tokens clean, manual smoke test documented
- **Deviations (pr-review to address)**:
  - **FR-8 partial** — Task 6.4 implemented as read-only info panel instead of full searchable workflow picker + webhook trigger picker + mode selector + timeout input. The create-flow needs an interactive picker to surface FR-9 empty-state. **Needs remediation in pr-review loop.**
  - Task 6.9 (tool-test-service) — returns informational message instead of calling engine execute. Acceptable v1 gap if documented.
  - ToolDetailPage binding panel shows name/type/DSL but doesn't parse individual fields.
  - No `pnpm i18n:check` script exists — keys verified manually.

## Wiring Verification

- [x] All 16 wiring checklist items verified (DSL parser export, Zod schema, DB enum, extractor, IR loader case, executor instantiation, JWT mint guard, dispatcher plumbing via ToolBindingExecutor, telemetry counter, trace events, UI tool-type badge, ToolsListPage tab, ToolCreateDialog option, WorkflowConfigForm (Round 1 remediation), ToolDetailPage binding panel, abl-serializers DSL emit, i18n keys)

## Review Rounds

| Round | Focus                | Verdict       | Critical | High | Medium | Low |
| ----- | -------------------- | ------------- | -------- | ---- | ------ | --- |
| 1     | Code quality         | NEEDS_CHANGES | 1        | 2    | 2      | 1   |
| 2     | HLD compliance       | APPROVED      | 0        | 0    | 0      | 4   |
| 3     | Test coverage        | APPROVED      | 0        | 0    | 0      | 0   |
| 4     | Security & isolation | APPROVED      | 0        | 0    | 0      | 0   |
| 5     | Production readiness | APPROVED      | 0        | 0    | 0      | 4   |

### Round 1 Remediation Commits

- `9f19249816` — C-1: re-export `parseDslProperties`, `buildWorkflowBindingFromProps`, `validateWorkflowToolBinding`, `WorkflowBindingLocal` from `@agent-platform/shared` root barrel (Studio build was failing)
- `9c93612aa0` — H-2: add typed `derivedParameterSchema` to `ToolDefinition` in compiler schema; remove `as unknown` cast in load-project-tools-as-ir
- `73c76d2a90` — H-1: replace read-only info panel with interactive `WorkflowConfigForm.tsx` (workflow picker, webhook-trigger filter with FR-9 empty-state, mode selector pre-filled from trigger, sync-only timeout)

### Deferred Findings

All deferred findings are LOW severity and documented as V1 scope per HLD:

1. **ToolDetailPage binding panel** shows name/type/DSL but doesn't parse individual workflow_binding fields (Phase 6 deviation, documented).
2. **tool-test-service** returns informational message instead of calling engine execute (Phase 6 deviation — acceptable V1 gap per LLD).
3. **No `pnpm i18n:check` script** exists — keys verified manually.
4. **Companion "wait-for-workflow-execution" tool** for `mode: 'async'` — explicitly deferred to future iteration per feature spec Non-Goals.

## Acceptance Criteria

- [x] All 6 LLD phases complete (Phases 1–6 committed)
- [x] E2E tests passing (E2E-1 through E2E-7: 10/10)
- [x] Integration tests passing (INT-1 through INT-7: 20/20)
- [x] Unit tests passing (UT-2 through UT-6: 40/40; UT-1 subsumed by validator tests)
- [x] No regressions — full builds clean across @abl/compiler, @agent-platform/database, @agent-platform/shared, @abl/runtime, @abl/workflow-engine, @abl/studio
- [x] Zero platform mocks in new tests (verified Rounds 3 + 4)
- [x] 5 pr-reviewer rounds clear (Rounds 2–5 APPROVED)
- [x] Design-token compliance (verified Round 1 — semantic tokens only, no hardcoded palette)
- [ ] Feature spec status → ALPHA — deferred to `/post-impl-sync workflow-as-tool`

## Learnings

- **Barrel re-exports**: When a new utility is added to a sub-barrel (`packages/shared/src/tools/index.ts`) and consumed from another package, it also needs to be re-exported from the **root** barrel (`packages/shared/src/index.ts`). Studio imports from `@agent-platform/shared` root; a sub-barrel-only export manifests as a build-time missing-export error.
- **Typed attachments on IR types**: Attaching runtime-derived data (e.g., `derivedParameterSchema` from workflow `start.inputVariables`) via `as unknown` cast defers type errors and breaks downstream consumers. Add the field to the IR type definition in the same commit.
- **Read-only panels are not interactive pickers**: A "Workflow Binding" summary card does not satisfy FR-8 (searchable workflow picker + webhook-trigger picker + mode override). Phase 6 initially shipped a read-only info panel; remediation introduced a dedicated `WorkflowConfigForm.tsx` with the full interactive flow including FR-9 empty-state.
- **Mixed engine error envelopes**: The workflow-engine emits both flat-string errors and structured `{code,message}` envelopes for specific codes (`INVALID_EXECUTION_ID`, `INVALID_TRIGGER_TYPE`, `DUPLICATE_NODE_NAMES`, `RESTATE_START_FAILED`). Always shape-check `typeof body.error === 'string'` before destructuring.
- **JSONPath minimal resolver**: Inline `$.a.b.c` dot-notation resolver is sufficient for v1 paramMapping; full JSONPath (wildcards, slicing, filters) should be extracted to a shared utility only when a concrete consumer needs it.
- **Internal service JWT pattern**: Runtime → cross-service calls reuse the SearchAI minting pattern (`{internal:true}`, 1h TTL, HMAC `JWT_SECRET`). Keep this consolidated — do not fork per-executor.
- **Executor LOC budget**: 400 LOC is the architectural ceiling for a single `ToolExecutor` implementation. Beyond that, extract helpers (binding registry, normalizer, poll scheduler) into sibling modules.
