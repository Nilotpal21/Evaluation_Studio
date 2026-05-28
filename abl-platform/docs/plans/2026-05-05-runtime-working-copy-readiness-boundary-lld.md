# LLD: Runtime Working-Copy Readiness Boundary

**Status**: IMPLEMENTED
**Date**: 2026-05-05

---

## 1. Design Decisions

| #   | Decision                                                                            | Rationale                                                                                                              | Alternatives Rejected                                                                                 |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D-1 | Enforce project execution readiness inside `compileProjectWorkingCopy()`.           | All HTTP chat, internal chat, Studio debug WebSocket, resume, and fallback paths eventually compile working-copy DSLs. | Repeating `evaluateProjectExecutionReadiness()` in every route leaves future bypasses likely.         |
| D-2 | Preserve draft readiness metadata in `ProjectWorkingCopyAgentSource`.               | A centralized readiness gate needs `dslValidationStatus` and diagnostics after route-to-source mapping.                | Re-querying ProjectAgent in every compile call duplicates DB work and complicates non-DB test paths.  |
| D-3 | Treat persisted runtime-config validation failures as fatal, not graceful defaults. | Export blocks invalid runtime config; deployed runtime execution must not silently ignore the same invalid state.      | Keeping DB outages and invalid user config in the same `undefined` fallback path hides data problems. |
| D-4 | Keep DB outage/no-record fallback behavior for runtime config resolver.             | Missing config and transient DB unavailability still need backward-compatible defaults.                                | Throwing on every resolver error would regress availability for projects with no runtime config.      |

## 2. File-Level Change Map

| File                                                                   | Change Description                                                  | Risk   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| `apps/runtime/src/services/project-working-copy-compiler.ts`           | Add readiness gate and preserve source metadata.                    | Medium |
| `apps/runtime/src/services/config/project-runtime-config-resolver.ts`  | Validate saved runtime config and throw typed invalid-config error. | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                        | Re-throw typed invalid runtime-config errors during session init.   | Medium |
| `apps/runtime/src/websocket/handler.ts`                                | Preserve WebSocket working-copy readiness metadata for the gate.    | Medium |
| `apps/runtime/src/__tests__/project-working-copy-compiler.test.ts`     | Lock unvalidated draft and invalid runtime-config compile rejects.  | Low    |
| `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`   | Lock invalid runtime-config resolver behavior.                      | Low    |
| `docs/plans/2026-05-05-runtime-working-copy-readiness-boundary-lld.md` | Design and implementation plan.                                     | Low    |

## 3. Implementation Phases

### Phase 1: Working-Copy Compile Boundary

**Goal**: Make `compileProjectWorkingCopy()` fail closed before parsing/compiling unready project drafts.

**Tasks**:

1. Add failing tests for unvalidated agent metadata and invalid saved runtime config.
2. Preserve `dslValidationStatus` and `dslDiagnostics` in `buildProjectWorkingCopyAgentSources()`.
3. Call `evaluateProjectExecutionReadiness()` from `compileProjectWorkingCopy()`.

**Exit Criteria**:

- [x] `project-working-copy-compiler.test.ts` rejects unvalidated drafts.
- [x] `project-working-copy-compiler.test.ts` rejects invalid saved runtime config.
- [x] Existing working-copy compiler tests pass with explicit valid metadata.

### Phase 2: Deployed Runtime Config Strictness

**Goal**: Prevent deployed sessions from silently degrading invalid saved runtime config to defaults.

**Tasks**:

1. Add failing resolver test for invalid runtime config.
2. Add typed invalid-config error from `resolveProjectRuntimeConfig()`.
3. Re-throw typed invalid-config errors from runtime session initialization.

**Exit Criteria**:

- [x] `project-runtime-config-resolver.test.ts` rejects invalid runtime config.
- [x] Resolver still returns `undefined` for no record, DB not ready, or DB read errors.
- [ ] Runtime build passes.

Build note: `pnpm --filter @agent-platform/runtime build` currently fails on pre-existing dirty
type errors in `apps/runtime/src/routes/guardrail-providers.ts` at lines 326 and 458. The touched
files in this slice no longer emit build errors.

## 4. Wiring Checklist

- [x] Working-copy source metadata is preserved by the shared builder.
- [x] `compileProjectWorkingCopy()` checks agent and runtime-config readiness.
- [x] Runtime-config resolver validates persisted config before mapping to IR.
- [x] Runtime executor does not swallow typed invalid-config failures.
- [x] Legacy WebSocket working-copy loaders preserve readiness metadata before compile.

## 5. Acceptance Criteria

- [ ] Affected runtime package builds.
- [x] Focused runtime tests pass.
- [x] Existing dirty work outside this slice is not reverted.
