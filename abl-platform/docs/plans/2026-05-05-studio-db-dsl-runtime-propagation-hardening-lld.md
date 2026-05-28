# LLD: Studio DB DSL Runtime Propagation Hardening

**Source Audit**: `docs/audits/2026-05-05-studio-db-dsl-runtime-propagation-audit.md`
**Status**: IMPLEMENTED + EXPANDED AUDIT EXTENSION COMPLETE
**Date**: 2026-05-05

---

## 1. Design Decisions

| #   | Decision                                                                                                       | Rationale                                                                                                                                                         | Alternatives Rejected                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D-1 | Treat invalid persisted runtime config as a blocking compiler-context error everywhere.                        | Runtime/export already fail closed; Studio compile and draft metadata must not present false readiness.                                                           | Downgrading invalid user config to warnings keeps split-brain behavior.                   |
| D-2 | Pass one canonical compiler options object through YAML materialization and module release compilation.        | YAML export and release IR should represent the same agent identity runtime executes.                                                                             | Reconstructing partial compiler options at each caller repeats the omission class.        |
| D-3 | Use a structured delivery envelope for WebSocket live, cross-pod, pending, and DB persistence paths.           | Text, rich content, actions, voice config, and provenance must travel together.                                                                                   | Adding one-off parameters to only one delivery path leaves future drift.                  |
| D-4 | Preserve backward compatibility for `tryThreadReturn(session, string)` while adding structured-result support. | Many existing callers pass plain strings; the migration should be safe and incremental.                                                                           | Forcing every caller to construct a full result immediately is high-risk churn.           |
| D-5 | Treat every authored response surface as the same structured response contract.                                | `ON_START`, `COMPLETE`, `ACTION_HANDLERS`, branches, sub-intents, hooks, errors, and gathers should preserve text, voice, rich content, and actions consistently. | Fixing only one keyword creates the same hidden-seam class on the next lifecycle surface. |
| D-6 | Require project authorization before loading any Studio compile context.                                       | Project-aware compile reads sibling DSL, config variables, prompt refs, tools, and runtime config.                                                                | TenantId-only queries leak project context to same-tenant users without project access.   |
| D-7 | Accept legacy/cross-format voice aliases at input boundaries while normalizing to canonical IR.                | YAML/import surfaces can contain both `plain_text` and `plainText`; runtime should not silently drop either.                                                      | Making every runtime caller know all historical aliases spreads compatibility logic.      |

## 2. File-Level Change Map

| File                                                                | Change Description                                                                                     | Risk   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| `apps/studio/src/lib/abl/studio-compiler-options.ts`                | Add runtime-config readiness validation and explicit `errors` result.                                  | Medium |
| `apps/studio/src/lib/abl/project-aware-compile.ts`                  | Propagate compiler-option errors into compile/diagnostic results.                                      | Medium |
| `apps/studio/src/lib/abl/project-agent-draft-metadata.ts`           | Propagate compiler-option errors into draft metadata context errors.                                   | Medium |
| `apps/studio/src/app/api/abl/compile/route.ts`                      | Fail compile requests when Studio compiler options report blocking errors.                             | Low    |
| `packages/project-io/src/export/agent-export-materializer.ts`       | Accept and use canonical compiler options during YAML materialization.                                 | Medium |
| `packages/project-io/src/export/layer-assemblers/core-assembler.ts` | Build export compiler options from config variables and runtime config.                                | Medium |
| `apps/studio/src/app/api/projects/[id]/module/releases/route.ts`    | Use canonical Studio compiler options for module release IR and compile function.                      | Medium |
| `apps/runtime/src/services/execution/channel-dispatcher.ts`         | Persist structured content envelopes and keep cross-pod structured fields whole.                       | Medium |
| `apps/runtime/src/websocket/handler.ts`                             | Forward voice config and handoff progress from cross-pod pubsub delivery.                              | Low    |
| `apps/runtime/src/services/execution/types.ts`                      | Allow `tryThreadReturn()` to preserve structured child results in parent history.                      | Medium |
| `packages/core/src/types/agent-based.ts`                            | Add structured `actions` to ordered action-handler actions.                                            | Low    |
| `packages/core/src/parser/agent-based-parser.ts`                    | Preserve nested `ACTIONS` under `ON_ACTION DO RESPOND`; default arrow button values to action ids.     | Medium |
| `packages/core/src/parser/yaml-parser.ts`                           | Preserve `actions` in direct and ordered action handlers.                                              | Low    |
| `packages/compiler/src/platform/ir/schema.ts`                       | Add `actions` to `ActionHandlerActionIR` and keep lifecycle action contracts typed.                    | Low    |
| `packages/compiler/src/platform/ir/compiler.ts`                     | Compile action-handler, `ON_START`, and `COMPLETE` actions; tolerate voice aliases.                    | Medium |
| `apps/runtime/src/services/execution/flow-step-executor.ts`         | Return `ON_START`, `THEN: COMPLETE`, and action-handler structured actions through protected delivery. | Medium |
| `apps/runtime/src/services/execution/routing-executor.ts`           | Execute `COMPLETE.actions` as part of completion results.                                              | Medium |
| `apps/studio/src/app/api/abl/compile/route.ts`                      | Verify project access before project-aware compile reads project context.                              | Medium |
| Focused tests                                                       | Lock each slice before implementation.                                                                 | Low    |

## 3. Implementation Phases

### Phase 1: Studio Runtime-Config Compiler Parity

**Goal**: Studio compile, diagnostics, and draft metadata fail closed on invalid saved runtime config.

**Tasks**:

1. Add red tests for `buildStudioCompilerOptions()` and diagnostic compile errors.
2. Add `errors` to the Studio compiler-options contract.
3. Validate persisted runtime config with export readiness before mapping to IR.
4. Propagate errors into compile route, project-aware diagnostics, and draft metadata.

**Exit Criteria**:

- [x] Studio compiler-options invalid runtime-config test passes.
- [x] Project-aware diagnostics reports invalid runtime config as an error.

### Phase 2: Export and Module Release IR Parity

**Goal**: YAML exports and module release precompiled IR use the same compiler context as Studio/runtime.

**Tasks**:

1. Add red tests proving export materialization receives runtime compiler options.
2. Add red tests proving module release compilation passes compiler options.
3. Extend materializer input with canonical compiler options.
4. Wire runtime config and config variables into export/module release compiles.

**Exit Criteria**:

- [x] Project IO core assembler materialization test passes.
- [x] Studio module release route compiler-options test passes.

### Phase 3: Cross-Pod Structured Delivery

**Goal**: Cross-pod WebSocket delivery preserves voice config, handoff progress, rich content, actions, and provenance.

**Tasks**:

1. Add red WebSocket pubsub delivery test for voice config and handoff progress.
2. Parse and emit the same structured delivery envelope in the Redis subscriber.

**Exit Criteria**:

- [x] WebSocket cross-pod structured delivery test passes.

### Phase 4: Structured Persistence and Thread Return

**Goal**: Async DB history and parent-thread read surfaces preserve structured output.

**Tasks**:

1. Add red channel dispatcher persistence test for structured content envelopes.
2. Add red thread-return test for child structured result preservation.
3. Widen the message persister interface to accept structured content.
4. Update `tryThreadReturn()` to accept structured execution results.

**Exit Criteria**:

- [x] Channel dispatcher persistence test passes.
- [x] Thread-return structured history test passes.

### Phase 5: Authored Lifecycle Structured Response Contract

**Goal**: Every authored lifecycle/action response surface preserves `actions` alongside text, voice, and rich content from Studio/DSL/YAML through compiler IR and runtime execution.

**Tasks**:

1. Add red parser/compiler locks for `ON_ACTION DO RESPOND ACTIONS`, direct action-handler actions, `ON_START.actions`, and `COMPLETE.actions`.
2. Add `actions` to ordered action-handler AST/IR types and compiler lowering.
3. Compile `ON_START.actions` and pass it through runtime initialization responses.
4. Pass completion-condition `actions` into `executeComplete()` and protect/interpolate them with the same helper used for other authored output.
5. Normalize voice config aliases at compiler boundaries so YAML/imported `plain_text` does not silently disappear.
6. Route `THEN: COMPLETE` transitions through the canonical completion detector before falling back to legacy silent completion.

**Exit Criteria**:

- [x] Core parser action-carousel test passes.
- [x] Compiler action-carousel/template-resolution tests pass.
- [x] Runtime focused flow/completion tests pass.

### Phase 6: Studio Project-Aware Compile Isolation

**Goal**: Project-aware compile never loads project DSL/config context without project authorization.

**Tasks**:

1. Add a route-level red lock for `/api/abl/compile` with a `projectId` whose caller lacks project access.
2. Require project access before invoking `buildProjectCompileContext()` or loading project config variables.
3. Use the authorized project tenantId for downstream context instead of trusting only `authResult.tenantId`.

**Exit Criteria**:

- [x] Studio project-aware compile tests pass.
- [x] Same-tenant unauthorized access returns non-leaky 404 before sibling/config context is loaded.

## 4. Wiring Checklist

- [x] Studio compiler option errors are consumed by every `buildStudioCompilerOptions()` caller.
- [x] Export YAML materialization receives runtime config compiler options.
- [x] Module release batch compile and per-agent compile function receive compiler options.
- [x] Cross-pod WebSocket subscriber emits the same structured fields as same-pod delivery.
- [x] Channel dispatcher message persistence forwards structured content and metadata separately.
- [x] Thread return callers pass structured results where available.
- [x] All authored response surfaces share the same typed structured response fields covered by this expanded audit slice.
- [x] `/api/abl/compile` checks project access before project-aware context reads.

## 5. Acceptance Criteria

- [x] Focused tests for first four phases pass.
- [x] Expanded audit extension focused tests pass.
- [x] Affected packages are formatted.
- [x] Affected package builds are attempted; unrelated dirty-tree blockers are reported separately.
