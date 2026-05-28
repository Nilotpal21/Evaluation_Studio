# LLD + Implementation Plan: Tool Invocation Round-Trip Hardening

**Feature**: [Tool Invocations](../features/tool-invocations.md)
**HLD**: [Tool Invocations HLD](../specs/tool-invocations.hld.md)
**Test Spec**: [Tool Invocations Test Spec](../testing/tool-invocations.md)
**Date**: 2026-05-02
**Status**: IN PROGRESS

---

## 1. Problem Statement

The canonical tool invocation rollout fixed parser, IR, and runtime execution semantics, but Studio and YAML authoring still contain lossy round-trip paths:

- Studio flow saves can rewrite entire `FLOW` blocks from reduced section models and silently drop advanced execution constructs.
- Studio lifecycle saves can flatten `ON_START` and `HOOKS` into a reduced representation and persist destructive rewrites.
- YAML parse/serialize support is asymmetric for advanced flow constructs, so YAML round-trips can still drop executable behavior.

The hard requirement for this hardening work is:

**No structured authoring path may silently delete executable DSL behavior.**

When Studio can faithfully round-trip a construct, it should preserve it in canonical form. When it cannot, save must fail closed with an explicit reason and direct the user to the DSL editor.

---

## 2. Design Decisions

| #   | Decision                                                                                | Rationale                                                                                       | Alternatives Rejected                                 |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| D-1 | Keep raw `dslContent` as the source of truth                                            | DB and runtime already preserve raw DSL correctly; the risk is authoring rewrites, not storage  | Replacing raw DSL with a Studio-owned normalized form |
| D-2 | Structured editors must fail closed on unsupported constructs                           | Data loss is worse than temporary edit restrictions                                             | Silent best-effort rewrites                           |
| D-3 | Preserve canonical `call_spec` where the UI can truly round-trip it                     | Enables forward progress without blocking all invocation work behind a full editor rewrite      | Blocking every non-trivial call shape                 |
| D-4 | Split lifecycle persistence by section instead of serializing the whole lifecycle group | Prevents unrelated edits from rewriting `ON_START` / `HOOKS` / `ON_ERROR` / `COMPLETE` together | Keeping one coarse lifecycle serializer               |
| D-5 | Add compatibility analyzers over compiled IR, not regex over raw DSL                    | IR already normalizes syntax variants and exposes the real executable shape                     | Ad hoc DSL string matching                            |
| D-6 | Make YAML parser/serializer parity explicit with regression tests                       | YAML authoring must obey the same “no silent loss” contract as Studio                           | Treating YAML as secondary and allowing drift         |

---

## 3. Future-Ready Architecture

### 3.1 Round-Trip Fidelity Contract

Every authoring surface gets one of three behaviors per construct:

1. **Supported**: parse into section state, render/edit, and serialize back without loss.
2. **Preserved but read-only**: surface may display summary data, but save path must not rewrite the construct unless it can fully serialize it.
3. **Blocked**: if a dirty section would rewrite unsupported constructs, save is rejected with an explicit message that points the user to the DSL editor.

### 3.2 Canonical Studio Invocation Model

Studio section models should converge on one canonical invocation shape:

```ts
interface StudioToolInvocation {
  tool: string;
  with?: Record<string, string>;
  as?: string;
}
```

This mirrors the AST/IR `callSpec` / `call_spec` model and avoids further string-only drift.

### 3.3 Save-Safety Rules

- `FLOW` visual save supports only:
  - step-level `CALL`
  - step-level `CALL WITH/AS`
  - existing reasoning fields already modeled by the flow editor
- `FLOW` visual save is blocked when compiled IR for a dirty flow contains:
  - `on_input`
  - `on_result`
  - `on_success` / `on_failure` branch actions
  - `digressions`
  - `sub_intents`
  - `on_action`
  - any other execution sub-structure the flow editor does not model
- Lifecycle saves are split by section:
  - `ON_START` writes only `ON_START`
  - `ON_ERROR` writes only `ON_ERROR`
  - `COMPLETE` writes only `COMPLETE`
  - hooks are not rewritten unless a future hook editor owns them
- `ON_START` structured save supports:
  - `RESPOND`
  - canonical tool invocation (`CALL`, `WITH`, `AS`)
  - existing `SET` assignments already parsed into the editor state
- YAML parser/serializer must round-trip:
  - `call_spec`
  - `digressions`
  - `sub_intents`
  - `on_action`

---

## 4. File-Level Change Map

### Studio

| File                                                                   | Change                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/studio/src/lib/abl-serializers.ts`                               | Preserve canonical step/on-start invocation shape; split lifecycle serializers      |
| `apps/studio/src/store/agent-detail-store.ts`                          | Extend section models with canonical invocation data and compatibility metadata     |
| `apps/studio/src/components/agent-editor/hooks/useEditorSave.ts`       | Serialize lifecycle sections independently; remove destructive lifecycle flattening |
| `apps/studio/src/components/agent-editor/hooks/useAgentEditorStore.ts` | Load richer `onStart` invocation state from IR                                      |
| `apps/studio/src/components/agent-editor/types.ts`                     | Add canonical invocation types to editor section state                              |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`              | Save blockers for unsupported flow/lifecycle constructs                             |
| `apps/studio/src/components/agents/AgentDetailPage.tsx`                | Apply the same save blockers to legacy agent-detail saves                           |
| `apps/studio/src/lib/abl/flow-visual-editor-compat.ts`                 | New flow compatibility analyzer                                                     |
| `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts`            | New lifecycle compatibility analyzer                                                |

### Core / Language Service

| File                                              | Change                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/parser/yaml-parser.ts`         | Parse digressions, sub-intents, and action handlers in YAML flow        |
| `packages/language-service/src/serialize-yaml.ts` | Serialize `on_action` and keep YAML parity for advanced flow constructs |

### Tests

| File                                                             | Change                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/abl-serializers.test.ts`              | Serializer regression tests for canonical invocation and lifecycle splitting  |
| `apps/studio/src/__tests__/editor-save-adapter.test.ts`          | Save-adapter tests for section isolation and non-destructive lifecycle writes |
| `apps/studio/src/__tests__/stores/agent-editor-store.test.ts`    | Store parsing tests for `call_spec` and compatibility flags                   |
| `apps/studio/src/__tests__/components/agent-editor*.test.tsx`    | Save-blocking UX coverage where relevant                                      |
| `packages/core/src/__tests__/yaml-parser.test.ts`                | YAML parser parity tests for digressions/sub-intents/on_action                |
| `packages/language-service/src/__tests__/serialize-yaml.test.ts` | YAML serializer parity tests for advanced flow constructs                     |

---

## 5. Slice-by-Slice Test-Locking Plan

### Slice 1: Flow Save Safety

**Goal**: `FLOW` visual saves must never silently drop advanced execution behavior.

**Tests first**:

1. Add a failing serializer/store test showing step-level `CALL WITH/AS` is preserved.
2. Add a failing compatibility test showing `on_input`, `digressions`, `sub_intents`, or `on_action` mark the flow as unsafe for visual save.
3. Add a failing editor save test showing dirty `flow` sections are blocked when unsupported constructs exist.

**Implementation**:

- Extend flow section state to carry canonical step-level invocation data.
- Teach `serializeFlowToABL()` to emit `CALL` with nested `WITH:` / `AS:` for supported step-level calls.
- Introduce `flow-visual-editor-compat.ts` and block `flow` saves in both AgentEditor and legacy AgentDetail page when unsupported flow constructs are present.

**Exit criteria**:

- Flow serializer round-trips supported step-level invocation fields.
- Dirty flow saves fail closed when advanced flow execution constructs are present.
- No existing simple flow authoring regression.

### Slice 2: Lifecycle Save Isolation

**Goal**: Lifecycle edits must stop rewriting unrelated lifecycle sections.

**Tests first**:

1. Add a failing save-adapter test showing `onStart` dirty emits only `ON_START`, `errorHandling` dirty emits only `ON_ERROR`, and `completion` dirty emits only `COMPLETE`.
2. Add a failing serializer/store test showing `ON_START CALL WITH/AS` is preserved.
3. Add a failing regression test showing hook bodies are not rewritten when saving non-hook lifecycle sections.

**Implementation**:

- Split lifecycle serialization into per-section helpers.
- Update the editor save adapter to stop constructing one coarse `LifecycleSectionData` save payload.
- Extend `OnStartSectionData` to preserve canonical invocation data and existing `SET` assignments.

**Exit criteria**:

- Editing `completion` or `errorHandling` no longer rewrites `HOOKS`.
- `ON_START` supports canonical invocation round-trip.
- Lifecycle saves fail closed or preserve behavior; they never flatten hooks implicitly.

### Slice 3: Lifecycle Compatibility Guard

**Goal**: Prevent lossy writes when lifecycle constructs remain unsupported by the visual editor.

**Tests first**:

1. Add failing analyzer tests for unsupported hook bodies or unsupported `ON_START` shapes.
2. Add failing editor tests showing save is blocked with a clear message when those constructs are present and the relevant section is dirty.

**Implementation**:

- Add `lifecycle-visual-editor-compat.ts`.
- Use analyzer output in AgentEditor and legacy AgentDetail save paths.
- Keep the DSL editor path unrestricted.

**Exit criteria**:

- Unsupported lifecycle constructs surface a deterministic save-block reason.
- Visual editors no longer perform destructive best-effort writes.

### Slice 4: YAML Parity

**Goal**: YAML authoring must round-trip the same advanced flow constructs we now preserve in ABL.

**Tests first**:

1. Add failing YAML parser tests for `digressions`, `sub_intents`, and `on_action`.
2. Add failing YAML serializer tests for `on_action`.
3. Add a round-trip-style test proving parse -> compile -> serialize keeps these constructs visible.

**Implementation**:

- Extend `parseFlowStep()` and supporting helpers in `yaml-parser.ts`.
- Extend `serializeToYAML()` for `on_action`.
- Keep canonical `call_spec` emission aligned with the parser.

**Exit criteria**:

- YAML parser recognizes advanced flow constructs.
- YAML serializer emits them.
- No asymmetric omissions remain for the tested surfaces.

---

## 6. Wiring Checklist

- [ ] New compatibility analyzers are imported by both `AgentEditor` and `AgentDetailPage`
- [ ] Editor section types expose canonical invocation data where serialization depends on it
- [ ] Save adapter uses per-section lifecycle serializers
- [ ] Existing DSL editor (`FULL` save) remains the escape hatch for unsupported constructs
- [ ] YAML parser and serializer support the same advanced flow constructs in tests

---

## 7. Verification Strategy

### Targeted test locks

- `apps/studio/src/__tests__/abl-serializers.test.ts`
- `apps/studio/src/__tests__/editor-save-adapter.test.ts`
- `apps/studio/src/__tests__/stores/agent-editor-store.test.ts`
- any targeted AgentEditor / AgentDetail component tests impacted by save blockers
- `packages/core/src/__tests__/yaml-parser.test.ts`
- `packages/language-service/src/__tests__/serialize-yaml.test.ts`

### Build / test loop

1. Add failing tests for a slice.
2. Implement the slice until those tests pass.
3. Run focused package builds immediately after code changes.
4. Move to the next slice only when the current slice is green.

### Final verification

- `npx prettier --write <changed files>`
- `pnpm build --filter @abl/core --filter @abl/language-service --filter @abl/compiler --filter @agent-platform/studio`
- focused vitest suites for Studio, core YAML parsing, and YAML serialization

---

## 8. Non-Goals for This Pass

- Full visual editing support for `on_input`, `on_result`, `digressions`, `sub_intents`, and `on_action`
- A brand-new AST-native flow editor
- Replacing the raw DSL storage model

This pass hardens round-trip safety first, adds canonical invocation support where the UI can honestly preserve it, and blocks the rest until a dedicated editor model exists.
