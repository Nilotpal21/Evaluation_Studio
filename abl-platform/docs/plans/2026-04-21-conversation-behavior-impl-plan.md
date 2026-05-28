# LLD: Conversation Behavior

**Feature Spec**: [docs/features/sub-features/conversation-behavior.md](../features/sub-features/conversation-behavior.md)
**HLD**: [docs/specs/conversation-behavior.hld.md](../specs/conversation-behavior.hld.md)
**Test Spec**: [docs/testing/sub-features/conversation-behavior.md](../testing/sub-features/conversation-behavior.md)
**Status**: DRAFT
**Date**: 2026-04-21

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                          | Rationale                                                                                   | Alternatives Rejected                                     |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D-1 | Use `CONVERSATION:` as an ABL-native block at agent and behavior-profile scope                                    | Preserves ABL as the only authoring language and reuses existing profile activation rules   | standalone sidecar document                               |
| D-2 | Keep `speaking`, `listening`, and `interaction` as the stable top-level groups even when some fields are deferred | The grouping is the core mental model and should not change between launch and later phases | phase-by-phase renaming or regrouping                     |
| D-3 | Model language as `language_policy` resolved through `InteractionContext`                                         | Prevents a second language source of truth and keeps runtime locale behavior canonical      | standalone `speaking.language` ownership                  |
| D-4 | Reference phrase and pronunciation content from project assets                                                    | Avoids copy duplication, supports localization, and preserves shared ownership              | large inline phrase/pronunciation maps                    |
| D-5 | Resolve one `ResolvedConversationBehavior` object per turn                                                        | Gives prompt building, repair logic, and diagnostics one explainable runtime contract       | compile-only prompt text with no resolved runtime object  |
| D-6 | Gate voice-only behavior by channel family / behavior profile                                                     | Keeps authoring provider-agnostic and avoids channel-name-specific logic                    | ad hoc channel string checks                              |
| D-7 | Launch a bounded subset first and treat advanced fields as deferred                                               | Keeps runtime/test surface realistic and future-safe                                        | attempting the entire conceptual field catalog in phase 1 |

### Key Interfaces & Types

```typescript
interface ConversationBehaviorIR {
  speaking?: {
    style?: string;
    tone?: string;
    emotion?: string;
    pace?: string;
    language_policy?: 'interaction_context' | 'agent_default' | 'fixed';
    fixed_language?: string;
    max_sentences?: number;
    one_thing_at_a_time?: boolean;
    tool_lead_in?: string;
    tool_results?: {
      style?: string;
      max_points?: number;
    };
    readback?: {
      numbers?: string;
      codes?: string;
      critical_details?: string;
    };
    phrases_ref?: string;
    pronunciations_ref?: string;
  };
  listening?: {
    barge_in?: string;
    on_pause?: string;
    on_overlap?: string;
    on_unclear_audio?: string;
    on_self_correction?: string;
  };
  interaction?: {
    answer_shape?: string;
    detail?: string;
    initiative?: string;
    grounding?: Record<string, unknown>;
    clarification?: Record<string, unknown>;
    confirmation?: Record<string, unknown>;
    uncertainty?: Record<string, unknown>;
    empathy?: string;
    context?: Record<string, unknown>;
    repair?: Record<string, unknown>;
    closure?: string;
  };
}

interface ResolvedConversationBehavior {
  source_chain: string[];
  asset_refs: string[];
  capability_drops: string[];
  speaking: Record<string, unknown>;
  listening: Record<string, unknown>;
  interaction: Record<string, unknown>;
}
```

### Module Boundaries

| Module                | Responsibility                                                       | Depends On                                                         |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core`       | Parse `CONVERSATION:` into AST and extend behavior-profile AST       | existing agent-based parser/types                                  |
| `packages/compiler`   | Lower AST to IR and validate ownership / field combinations          | AST, IR schema, asset-ref validator                                |
| `apps/runtime`        | Resolve and capability-gate effective Conversation Behavior per turn | agent IR, active profiles, `InteractionContext`, channel contracts |
| `apps/studio`         | Structured editing, raw ABL serialization, diagnostics display       | compiler schema, serializers, localization surfaces                |
| `packages/project-io` | Preserve authoring and asset references through import/export/bundle | serializer, dependency extraction, validators                      |

---

## 2. File-Level Change Map

### New Files

| File                                                                        | Purpose                                                                            | LOC Estimate |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| `packages/compiler/src/platform/ir/compile-conversation-behavior.ts`        | Shared lowering helpers for `ConversationBehaviorAST -> ConversationBehaviorIR`    | 220          |
| `packages/compiler/src/platform/ir/validate-conversation-behavior.ts`       | Ownership, asset-ref, and field-combination validation                             | 180          |
| `apps/runtime/src/services/execution/conversation-behavior-resolver.ts`     | Merge base behavior, profile overrides, interaction context, and capability gating | 260          |
| `apps/runtime/src/services/execution/conversation-behavior-diagnostics.ts`  | Build trace/debug payloads for resolved behavior                                   | 120          |
| `apps/studio/src/components/profiles/ConversationBehaviorSection.tsx`       | Structured UI section for `speaking` / `listening` / `interaction`                 | 260          |
| `packages/core/src/__tests__/conversation-behavior-parser.test.ts`          | Parser coverage for new syntax                                                     | 180          |
| `packages/compiler/src/__tests__/ir/conversation-behavior-ir.test.ts`       | IR lowering and validator coverage                                                 | 220          |
| `apps/runtime/src/__tests__/conversation-behavior-resolver.test.ts`         | Runtime merge and gating coverage                                                  | 240          |
| `packages/project-io/src/__tests__/conversation-behavior-roundtrip.test.ts` | Project I/O round-trip coverage for authoring and asset refs                       | 180          |

### Modified Files

| File                                                            | Change Description                                                               | Risk   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `packages/core/src/types/agent-based.ts`                        | Add AST types for Conversation Behavior and behavior-profile embedding           | Medium |
| `packages/core/src/parser/agent-based-parser.ts`                | Parse `CONVERSATION:` blocks at agent/profile scope                              | High   |
| `packages/compiler/src/platform/ir/schema.ts`                   | Add `ConversationBehaviorIR` and wire it into `AgentIR` / `BehaviorProfileIR`    | Medium |
| `packages/compiler/src/platform/ir/compiler.ts`                 | Compile agent-level Conversation Behavior                                        | High   |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Compile behavior-profile Conversation Behavior and align voice/profile ownership | High   |
| `apps/runtime/src/services/execution/profile-resolver.ts`       | Merge `ConversationBehaviorIR` with active profiles and expose resolved behavior | High   |
| `apps/runtime/src/services/execution/prompt-builder.ts`         | Consume resolved behavior for prompt shaping and language-policy hints           | Medium |
| `apps/runtime/src/services/execution/flow-step-executor.ts`     | Honor repair / clarification semantics that affect flow behavior                 | Medium |
| `apps/runtime/src/channels/channel-behavior-contract.ts`        | Add metadata or helpers for Conversation Behavior capability gating where needed | Medium |
| `apps/studio/src/components/profiles/ProfileDetailPage.tsx`     | Mount structured Conversation Behavior editing in the profile editor             | Medium |
| `apps/studio/src/components/agent-detail/BehaviorSection.tsx`   | Surface baseline Conversation Behavior on the agent page                         | Medium |
| `apps/studio/src/store/profile-store.ts`                        | Track conversation behavior state and summaries                                  | Low    |
| `apps/studio/src/store/agent-detail-store.ts`                   | Parse conversation behavior from compiled IR into Studio state                   | Medium |
| `apps/studio/src/lib/abl-serializers.ts`                        | Serialize `CONVERSATION:` blocks and preserve round-trip behavior                | High   |
| `packages/project-io/src/dependencies/dependency-extractor.ts`  | Track asset references declared by Conversation Behavior                         | Medium |
| `packages/project-io/src/import/import-validator.ts`            | Validate syntax, asset refs, and ownership rules during import                   | Medium |

### Deleted Files (if any)

| File | Reason                          |
| ---- | ------------------------------- |
| N/A  | No deletion required in phase 1 |

---

## 3. Implementation Phases

### Phase 1: Contract, Ownership, and Validation Foundation

**Goal**: Establish the stable authoring contract and validator rules before parser/runtime work begins.

**Tasks**:
1.1. Add AST and IR type definitions for Conversation Behavior groupings.
1.2. Define the ownership validator for persona, acoustic voice, `InteractionContext`, localization assets, and channel transport behavior.
1.3. Define field-combination validation for launch fields and deferred fields.
1.4. Align behavior-profile voice compilation with current `VoiceConfigAST` / `VoiceConfigIR` capabilities where necessary so ownership is coherent.

**Files Touched**:

- `packages/core/src/types/agent-based.ts` — add AST types and field unions
- `packages/compiler/src/platform/ir/schema.ts` — add `ConversationBehaviorIR`
- `packages/compiler/src/platform/ir/validate-conversation-behavior.ts` — new validators
- `packages/compiler/src/platform/ir/compile-behavior-profile.ts` — profile voice/conversation alignment

**Exit Criteria**:

- [ ] Stable `ConversationBehaviorAST` and `ConversationBehaviorIR` types are defined
- [ ] Ownership conflicts produce deterministic validator errors
- [ ] Deferred fields are explicitly recognized and gated, not silently accepted
- [ ] Voice/profile ownership gaps relevant to Conversation Behavior are documented or fixed
- [ ] `pnpm build --filter=@abl/core --filter=@abl/compiler` succeeds

**Test Strategy**:

- Unit: validator helpers and type guards
- Integration: compiler tests covering ownership and field-combination diagnostics

**Rollback**: Revert type additions and validator wiring; existing behavior-profile and voice constructs continue to work.

---

### Phase 2: Parser and Compiler Lowering

**Goal**: Parse `CONVERSATION:` authoring at agent and behavior-profile scope and lower it into canonical IR.

**Tasks**:
2.1. Parse `CONVERSATION:` on agents and behavior profiles.
2.2. Parse nested `SPEAKING`, `LISTENING`, and `INTERACTION` blocks and launch fields.
2.3. Implement lowering helpers in `compile-conversation-behavior.ts`.
2.4. Attach compiled `conversation_behavior` to `AgentIR` and `BehaviorProfileIR`.
2.5. Emit preview/apply diagnostics for unknown fields, ownership violations, and invalid asset refs.

**Files Touched**:

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/compile-conversation-behavior.ts`
- `packages/compiler/src/platform/ir/compile-behavior-profile.ts`
- `packages/compiler/src/platform/ir/validate-conversation-behavior.ts`

**Exit Criteria**:

- [ ] Parser accepts canonical `CONVERSATION:` syntax on agents and behavior profiles
- [ ] Compiler emits `conversation_behavior` in IR when authored
- [ ] Unknown fields and invalid combinations fail deterministically
- [ ] Parser and compiler integration tests pass
- [ ] `pnpm build --filter=@abl/core --filter=@abl/compiler` succeeds

**Test Strategy**:

- Unit: parser field validation
- Integration: AST -> IR lowering golden tests

**Rollback**: Revert parser/compiler additions; agents fall back to existing flat constructs.

---

### Phase 3: Runtime Resolution and Capability Gating

**Goal**: Resolve one effective Conversation Behavior view per turn and gate unsupported behavior by channel family.

**Tasks**:
3.1. Add `conversation-behavior-resolver.ts` for merge logic.
3.2. Define runtime precedence between agent-scoped behavior, active profiles, `InteractionContext`, and safety/runtime constraints.
3.3. Use channel behavior contracts to gate voice-only and transport-aware policies.
3.4. Feed resolved behavior into prompt building and repair / clarification consumers.
3.5. Emit resolved-behavior diagnostics and capability-drop traces.

**Files Touched**:

- `apps/runtime/src/services/execution/conversation-behavior-resolver.ts`
- `apps/runtime/src/services/execution/profile-resolver.ts`
- `apps/runtime/src/services/execution/prompt-builder.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/conversation-behavior-diagnostics.ts`
- `apps/runtime/src/channels/channel-behavior-contract.ts`

**Exit Criteria**:

- [ ] Runtime resolves one deterministic `ResolvedConversationBehavior` per turn
- [ ] Voice-only policies are gated according to channel-family capability rules
- [ ] `language_policy` is covered by integration tests using `InteractionContext`
- [ ] Runtime emits resolved-behavior diagnostics for feature-active turns
- [ ] `pnpm build --filter=runtime` succeeds

**Test Strategy**:

- Unit: merge precedence helpers
- Integration: resolver + capability gating + prompt interaction tests

**Rollback**: Disable new resolver consumption and fall back to existing profile instructions/voice/response behavior.

---

### Phase 4: Studio, Project I/O, and Asset References

**Goal**: Make the feature usable end-to-end in Studio and preserve it through project round-trip.

**Tasks**:
4.1. Add structured authoring UI for Conversation Behavior in profile and agent surfaces.
4.2. Serialize Conversation Behavior to raw ABL and parse it back into Studio state.
4.3. Define and validate phrase/pronunciation asset references.
4.4. Preserve authoring and asset references through project export/import/bundle flows.
4.5. Add diagnostics for missing or cross-owned assets.

**Files Touched**:

- `apps/studio/src/components/profiles/ConversationBehaviorSection.tsx`
- `apps/studio/src/components/profiles/ProfileDetailPage.tsx`
- `apps/studio/src/components/agent-detail/BehaviorSection.tsx`
- `apps/studio/src/store/profile-store.ts`
- `apps/studio/src/store/agent-detail-store.ts`
- `apps/studio/src/lib/abl-serializers.ts`
- `packages/project-io/src/dependencies/dependency-extractor.ts`
- `packages/project-io/src/import/import-validator.ts`

**Exit Criteria**:

- [ ] Structured UI and raw ABL round-trip the same `CONVERSATION:` content
- [ ] Phrase/pronunciation asset refs validate against project ownership rules
- [ ] Project export/import/bundle preserve Conversation Behavior and its asset refs
- [ ] `pnpm build --filter=studio --filter=@abl/project-io` succeeds

**Test Strategy**:

- Integration: Studio serializer and project I/O round-trip
- E2E: authoring flow through Studio and raw ABL

**Rollback**: Keep compiler/runtime support but temporarily hide structured UI and asset-ref entry points if needed.

---

### Phase 5: Hardening, Diagnostics, and Advanced-Field Gating

**Goal**: Make the launch subset production-ready and explicitly fence advanced fields for later work.

**Tasks**:
5.1. Add trace/debug viewers or payload wiring for resolved behavior in Studio/runtime diagnostics.
5.2. Add final integration tests for capability drops and asset-resolution edge cases.
5.3. Gate advanced fields (`backchannels`, `use_audio_cues`, `adaptation`, `flow_mode`) behind explicit unsupported/deferred diagnostics.
5.4. Review prompt-size impact and reduce any unnecessary inline prompt expansion.

**Files Touched**:

- runtime diagnostics and trace surfaces
- Studio diagnostics panels if applicable
- parser/compiler validators for deferred fields
- targeted integration and E2E test files

**Exit Criteria**:

- [ ] Diagnostics clearly explain why a behavior resolved or was dropped
- [ ] Deferred fields fail with explicit "not supported in phase 1" diagnostics
- [ ] Required integration/E2E suites from the test spec are coverable and passing in scope
- [ ] `pnpm build` succeeds for all affected packages

**Test Strategy**:

- Integration: diagnostics payloads and deferred-field validation
- E2E: launch-subset authoring and execution flows

**Rollback**: Leave the core launch subset in place and disable advanced-field parsing or diagnostics if they destabilize rollout.

---

## 4. Wiring Checklist

- [ ] `ConversationBehaviorAST` exported from core types
- [ ] Parser paths for agent and behavior-profile `CONVERSATION:` blocks registered
- [ ] `ConversationBehaviorIR` exported from compiler schema index
- [ ] Agent compiler attaches base `conversation_behavior`
- [ ] Behavior-profile compiler attaches profile `conversation_behavior`
- [ ] Runtime profile resolver calls Conversation Behavior resolver
- [ ] Prompt builder reads resolved behavior where applicable
- [ ] Flow / repair execution paths consume relevant interaction/listening behavior
- [ ] Studio profile editor mounts `ConversationBehaviorSection`
- [ ] Agent detail page surfaces baseline Conversation Behavior
- [ ] Serializer emits and reads `CONVERSATION:` round-trip
- [ ] Project I/O dependency extraction tracks phrase/pronunciation refs

---

## 5. Cross-Phase Concerns

### Database Migrations

No database migration is required in phase 1. The feature is source- and IR-driven.

### Feature Flags (if applicable)

Recommended rollout flags:

- `conversationBehaviorAuthoring`: gates Studio and parser-preview surfaces
- `conversationBehaviorRuntime`: gates resolved-behavior runtime consumption

These can be omitted if rollout is repo-internal only, but the architecture should keep authoring and runtime activation separable.

### Configuration Changes

- No new environment variables are required for phase 1.
- Project asset reference validation should reuse existing localization configuration and ownership checks.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All implementation phases complete with exit criteria met
- [ ] Agent and behavior-profile `CONVERSATION:` authoring round-trips through raw ABL
- [ ] Runtime resolves one deterministic `ResolvedConversationBehavior` per turn
- [ ] `InteractionContext` remains the canonical owner of language/locale/timezone resolution
- [ ] Phrase/pronunciation assets resolve through project-owned references
- [ ] Unsupported channel-specific behavior fails closed
- [ ] Required integration and E2E tests from the test spec are passing
- [ ] No regressions in affected package builds (`pnpm build` for affected packages)

---

## 7. Open Questions

1. Which asset system should own pronunciations long term: localization assets, a vocabulary/lexicon asset type, or both?
2. Should project brand defaults be a phase-1 dependency or a later extension point?
3. Which runtime consumers beyond prompt building and repair logic should consume resolved Conversation Behavior in the first slice?
