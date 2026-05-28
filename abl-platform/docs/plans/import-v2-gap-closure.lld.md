# LLD: Import v2 Gap Closure

**Status**: IN PROGRESS
**Date**: 2026-05-06
**Ticket**: ABLP-869

## 1. Design Decisions

| #   | Decision                                                                                             | Rationale                                                                                                               | Alternatives Rejected                                         |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| D-1 | Studio import uses one layered v2 path for preview and apply.                                        | Prevents UI/backend drift and lets every layer share staging, cross-ref, and activation semantics.                      | Keeping core-direct-apply as a UI fallback.                   |
| D-2 | `deleteUnmatched` maps to conflict strategy instead of being passed as an independent behavior flag. | v2 owns replacement semantics at layer/disassembler boundaries.                                                         | Separate delete path bolted onto Studio routes.               |
| D-3 | Default import strategy is `merge`; explicit delete-unmatched is `replace`.                          | Default imports should be non-destructive and update matching records only. Full archive replacement remains available. | Always using `replace`, which hides unrelated active records. |
| D-4 | Layered staging stays hidden through shadow project ids plus `__ablImport` lifecycle metadata.       | Avoids leaking staged records through normal project-scoped reads, even for collections with no lifecycle schema field. | Staging in the real project with `status: staged`.            |
| D-5 | Rollback/status should read the same `ImportOperation` lifecycle as apply.                           | Future import features need resumable operations and clear UI diagnostics.                                              | Snapshot-only rollback tied to the legacy direct path.        |

## 2. Module Boundaries

| Module                                                         | Responsibility                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/import/*`               | Validate request shape, map UI intent to v2 options, return stable UI response envelope.             |
| `apps/studio/src/lib/project-import/layered-import-support.ts` | Studio adapter for import v2 dependencies, raw Mongo lifecycle staging, preview/apply orchestration. |
| `packages/project-io/src/import/project-importer-v2.ts`        | Layered import orchestration, dry-run preview, staging, cross-ref, activation, rollback.             |
| `packages/project-io/src/import/layer-disassemblers/*`         | Convert archive files into records and superseded targets for `replace`, `merge`, or `skip`.         |
| `apps/studio` import dialog                                    | Present import mode, acknowledgement, blocking issues, and operation failures.                       |

## 3. Implementation Phases

### Phase 1: Strategy Parity Lock

**Goal**: Lock the cross-boundary mapping from Studio request fields to import v2 behavior.

**Tasks**:

1. Add a route-level parity test for `deleteUnmatched -> conflictStrategy`.
2. Add data-flow audit notes for the boundary.
3. Keep existing helper/disassembler tests green.

**Exit Criteria**:

- [ ] Default preview/apply requests call layered import with `conflictStrategy: "merge"`.
- [ ] `deleteUnmatched: true` preview/apply requests call layered import with `conflictStrategy: "replace"`.
- [ ] Data-flow audit is recorded under `docs/sdlc-logs/import-v2-gap-closure/`.

### Phase 2: Rollback And Status

**Goal**: Make layered import operations observable and reversible from Studio.

**Tasks**:

1. Extend `/import/status` to read layered v2 operation lifecycle and per-layer state.
2. Extend `/import/revert` to call layered rollback for staged/superseded records.
3. Preserve legacy snapshot revert for older completed direct-import operations.

**Exit Criteria**:

- [ ] Status route returns layered operation phase, layer statuses, warnings, and sanitized errors.
- [ ] Revert route can restore superseded records for a completed layered operation.
- [ ] Legacy snapshot revert tests still pass.

### Phase 3: Full Archive API Regression

**Goal**: Prove a multi-layer archive is accepted through public Studio API routes.

**Tasks**:

1. Add an API-level import regression fixture covering connections, core, prompts, workflows, guardrails, search, evals, channels, and vocabulary.
2. Verify preview blocking/non-blocking issue shape.
3. Verify apply stages records and activates all requested layers with cross-ref resolution.

**Exit Criteria**:

- [ ] Preview returns v2 layer changes for all supported layers.
- [ ] Apply persists staged records with no direct reads of staged shadow project ids.
- [ ] Cross-layer refs resolve for workflow versions, guardrails, search, evals, and channels.

### Phase 4: Natural-Key Coverage Audit

**Goal**: Make merge semantics durable as new collections and indexes arrive.

**Tasks**:

1. Document each collection's merge key and backing uniqueness/index expectation.
2. Add disassembler tests for any currently untested layer natural keys.
3. Flag collections that need schema/index migrations before strict merge guarantees.

**Exit Criteria**:

- [ ] Every import v2 collection has an explicit merge key or documented replace-only behavior.
- [ ] Tests cover at least one merge replacement and one preserve-unrelated case per layer family.

### Phase 5: UI Messaging Cleanup

**Goal**: Make the import dialog explain exactly what will happen.

**Tasks**:

1. Rename/clarify import mode controls around merge vs replace.
2. Surface blocking issues and acknowledgement requirements without implying unsupported layer toggles.
3. Show operation id and layer state on apply failures.

**Exit Criteria**:

- [ ] Dialog copy matches v2 behavior.
- [ ] Blocking issues are actionable.
- [ ] Apply failures show sanitized, operation-correlated diagnostics.

## 4. Wiring Checklist

- [x] Studio preview route calls layered v2 preview helper.
- [x] Studio apply route calls layered v2 apply helper.
- [x] `ImportConflictStrategyV2` exported from project-io.
- [x] Disassembler context accepts `merge`.
- [ ] Status route reads layered operation state.
- [ ] Revert route restores layered operation state.
- [ ] UI import dialog reflects merge/replace mode.

## 5. Test-Locking Approach

Every slice starts by adding or updating the narrowest failing/locking test for the boundary being touched, then making production code satisfy it. Tests should lock behavior at the highest practical boundary:

- Route parity for UI request fields.
- Import helper tests for v2 option forwarding.
- Disassembler tests for natural-key merge semantics.
- API route tests for full archive behavior.
- UI tests only when visible copy/state changes.
