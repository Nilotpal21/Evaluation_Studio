# LLD: Action Handler Canonical Hardening

**Feature Specs**:

- `docs/features/abl-spec-impl-parity.md`
- `docs/features/message-templates.md`
- `docs/features/memory-sessions.md`

**HLDs**:

- `docs/specs/abl-spec-impl-parity.hld.md`

**Test Specs**:

- `docs/testing/abl-spec-impl-parity.md`
- `docs/testing/message-templates.md`
- `docs/testing/memory-sessions.md`

**Status**: DONE
**Date**: 2026-05-02

---

## 1. Problem Statement

The runtime now treats ordered `ON_ACTION DO` actions as the canonical execution surface, but some older compiler post-processing and validation still read legacy top-level handler fields (`respond`, `set`, `transition`). That creates split-brain behavior where:

- parsing and IR compilation succeed,
- runtime dispatch works for canonical `do[]`,
- but template resolution, rich-content propagation, and field-reference validation can silently miss canonical action-handler content.

This is the same failure class as prior parser-vs-post-processing drift: the canonical shape exists, but downstream passes still inspect compatibility mirrors.

---

## 2. Design Decisions

| #   | Decision                                                                                         | Rationale                                                                                                             | Alternatives Rejected                                                                                         |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| D-1 | Treat `ActionHandlerIR.do[]` as the single canonical authored action sequence after compilation. | Runtime already executes `do[]` first, and compiler lowering already materializes legacy fields into `do[]`.          | Continuing to dual-read sidecar fields in every downstream pass would keep the drift risk alive.              |
| D-2 | Keep legacy `respond`, `set`, and `transition` fields only as compatibility mirrors on IR.       | Preserves older tests, serializers, and any compatibility consumers without changing stored IR shape in one step.     | Removing sidecars in this fix would enlarge scope and risk unrelated regressions.                             |
| D-3 | Centralize compiler-side action-handler traversal in a shared helper for read-only passes.       | Future action fields should only require one traversal update, not one per validator/post-pass.                       | Repeating bespoke loops in each validator keeps the exact split-brain class we are fixing.                    |
| D-4 | Lock each behavior slice with tests before implementation.                                       | The bug class is omission drift; tests must prove canonical surfaces are observed end-to-end by each pass.            | One broad integration test would not isolate which compiler phase drifted.                                    |
| D-5 | Scope this change to compiler validation/post-processing and targeted docs.                      | The runtime dispatch path already prefers canonical actions and should remain unchanged unless tests prove otherwise. | Touching runtime execution paths without evidence would increase conflict risk in the current dirty worktree. |

---

## 3. File-Level Change Map

### New Files

| File                                                              | Purpose                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/plans/2026-05-02-action-handler-canonical-hardening.lld.md` | Focused design and slice plan for canonical action-handler hardening      |
| `packages/compiler/src/platform/ir/action-handler-utils.ts`       | Shared canonical action-handler traversal helper for compiler-side passes |

### Modified Files

| File                                                          | Change                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/compiler.ts`               | Resolve templates/rich-content for canonical step-level and agent-level action-handler actions |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`    | Register canonical action-handler `set` keys and `on_return.map` outputs as known variables    |
| `packages/compiler/src/platform/ir/validate-ir.ts`            | Reuse shared traversal helper for action-handler semantic validation                           |
| `packages/compiler/src/platform/ir/validate-cross-agent.ts`   | Reuse shared traversal helper for handoff/delegate target checks                               |
| `packages/compiler/src/__tests__/template-resolution.test.ts` | Add test locks for canonical action-handler template/rich-content resolution                   |
| `packages/compiler/src/__tests__/validate-field-refs.test.ts` | Add test locks for canonical action-handler field propagation                                  |

---

## 4. Slice Plan

### Slice 1: Template Resolution Lock

**Goal**: Prove canonical `ON_ACTION DO` responds participate in compiler template resolution and rich-content propagation.

**Tasks**:

1. Add a step-level `ON_ACTION DO -> RESPOND: TEMPLATE(...)` regression test.
2. Add an agent-level `ACTION_HANDLERS DO -> RESPOND: TEMPLATE(...)` regression test.
3. Assert both resolved text and rich-content formats are present.
4. Assert the referenced template is not reported as unused.

**Exit Criteria**:

- [ ] New canonical action-handler template tests fail before implementation.
- [ ] Tests pass after the compiler fix.
- [ ] No legacy `ON_ACTION` template-resolution tests regress.

**Verification**:

- `pnpm --filter @abl/compiler exec vitest run src/__tests__/template-resolution.test.ts -t "ON_ACTION handler respond resolves|ON_ACTION DO|ACTION_HANDLERS DO"`

**Rollback**:

- Revert the new action-handler template traversal only. Existing legacy response resolution stays intact.

### Slice 2: Field-Reference Lock

**Goal**: Prove canonical action-handler writes are visible to field-reference validation.

**Tasks**:

1. Add a regression test for step-level `on_action[].do[].set`.
2. Add a regression test for agent-level `action_handlers[].do[].set`.
3. Add regression coverage for action-handler `do[].on_return.map`.
4. Keep digression and handoff tests untouched as control cases.

**Exit Criteria**:

- [ ] New field-reference regression tests fail before implementation.
- [ ] Canonical action-handler `set` and `on_return.map` variables no longer produce undefined-var warnings.
- [ ] Existing validator tests remain green.

**Verification**:

- `pnpm --filter @abl/compiler exec vitest run src/__tests__/validate-field-refs.test.ts -t "known variables from SET, mappings, and coordination return contracts are not flagged|canonical step ON_ACTION DO|canonical agent ACTION_HANDLERS DO"`

**Rollback**:

- Revert validator traversal changes only. No parser/runtime behavior is affected.

### Slice 3: Shared Canonical Traversal

**Goal**: Remove bespoke compiler loops so future action-handler action fields have one compiler-side traversal contract.

**Tasks**:

1. Add a shared `getActionHandlerActions()` helper for compiler-side consumers.
2. Migrate field-ref, runtime-semantics, and cross-agent validators to the helper.
3. Update template-resolution post-processing to walk canonical handler actions and agent-level action handlers.
4. Clarify in code comments that sidecar fields are compatibility mirrors, not canonical post-processing inputs.

**Exit Criteria**:

- [ ] No remaining compiler validator/post-pass reads only legacy top-level handler action fields where canonical `do[]` exists.
- [ ] Shared helper is used by all touched compiler-side action-handler traversals.
- [ ] The targeted compiler build succeeds.

**Verification**:

- `pnpm build --filter=@abl/compiler`

**Rollback**:

- Revert helper adoption while keeping the test locks for future follow-up.

### Slice 4: Regression Verification

**Goal**: Prove the hardened compiler behavior holds together without broadening scope into unrelated local edits.

**Tasks**:

1. Run the targeted compiler test files.
2. Run a scoped compiler build.
3. Confirm no runtime code changes were required for these issues.

**Exit Criteria**:

- [ ] `packages/compiler` builds successfully.
- [ ] New regression tests pass.
- [ ] No unrelated files were modified as part of this slice set.

**Verification**:

- `pnpm build --filter=@abl/compiler`
- `pnpm --filter @abl/compiler exec vitest run src/__tests__/template-resolution.test.ts src/__tests__/validate-field-refs.test.ts -t "ON_ACTION handler respond resolves|known variables from SET, mappings, and coordination return contracts are not flagged|ON_ACTION DO|ACTION_HANDLERS DO|canonical step ON_ACTION DO|canonical agent ACTION_HANDLERS DO"`

---

## 5. Future-Ready Guardrails

- Any new compiler pass that reads action-handler actions must consume the shared traversal helper.
- New action-handler action fields must be added to:
  - IR schema
  - compiler lowering
  - shared traversal helper
  - at least one regression test that uses canonical `do[]`
- Compatibility mirrors may remain serialized, but they must not be the only source inspected by post-compilation logic.
- Agent-level `ACTION_HANDLERS` must always be treated as a first-class action-handler surface in compiler passes, not a flow-only special case.

---

## 6. Acceptance Criteria

- [ ] Canonical step-level `ON_ACTION DO` template responds resolve text and rich-content formats.
- [ ] Canonical agent-level `ACTION_HANDLERS DO` template responds resolve text and rich-content formats.
- [ ] Canonical action-handler `do[].set` outputs are recognized by field-reference validation.
- [ ] Canonical action-handler `do[].on_return.map` outputs are recognized by field-reference validation.
- [ ] Compiler-side action-handler traversal uses a shared helper across touched validators/post-processing.
- [ ] `pnpm build --filter=@abl/compiler` succeeds.
- [ ] Targeted compiler regression tests pass.
