# Arch and Runtime Agent Gap Closure - Implementation Plan

**Feature Spec**: None yet. This plan is grounded in the VoltMart agent-build session findings and should become the source input for a later feature spec if the work is split.
**HLD**: None yet.
**Test Spec**: `docs/testing/arch-platform-agent-generation-runtime-gap-closure.md`
**Status**: IN PROGRESS
**Date**: 2026-05-16
**Grounded Against**: `origin/develop@3f57414b22` merged locally at `20ca49c675`

---

## 1. Problem Summary

The session exposed two coupled classes of defects:

1. Arch generated plausible-looking ABL from SOP prose, but the generated project did not encode the operational contract needed for production support agents: structured tool schemas, routing state, consent, channel-specific behavior, business invariants, realistic test fixtures, model policy, and customer-experience topology.
2. Runtime and Studio surfaces allowed those generation defects to become hard failures: OpenAI Responses API reasoning history was not preserved across turns, confirmation prompts interrupted natural consent, errors were opaque, static tool-test responses were write-once, and invalid HANDOFF conditions could be masked by reasoning fallback.

The target architecture is not "collapse all agents into one" and not "make every child invisible." The target is to model customer experience independently from runtime topology.

## 2. Target Topology Model

Arch should support three intentional topology modes:

| Mode                   | Customer Experience                                                                  | Runtime Behavior                                                                                            | Default Use                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `shared_voice_handoff` | Customer perceives one continuous agent, even though ownership moves to a specialist | HANDOFF transfers active speaker; child inherits the same perceived persona and must not reintroduce itself | Orders, billing, returns, technical specialists                         |
| `visible_handoff`      | Customer hears an intentional transfer to a named or differently scoped specialist   | HANDOFF transfers active speaker and may change display name, voice, or persona                             | Human escalation, legal/compliance escalation, senior support           |
| `silent_delegate`      | Customer does not hear the child                                                     | Parent invokes child as internal reasoning/action planner and receives structured output                    | Policy advice, eligibility analysis, fraud review, back-office planning |

This resolves the earlier false choice between a bloated single supervisor and leaking specialist internals. HANDOFF is correct when the child should own the next customer-facing phase. DELEGATE is correct when the child should reason internally and return structured state.

## 3. Latest Code Grounding

| Area                       | Current Evidence In Latest                                                                                                                                                                                         | Gap                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arch contract layer        | `packages/arch-ai/src/blueprint/source-architecture-contract.ts` exists and already extracts declared agents, tools, channels, memory, topology confidence, and preservation checks.                               | Contract does not yet encode customer-experience mode, perceived persona, channel budgets, consent, model policy, invariants, emotional handling, or scenario fixtures.                                                                                  |
| Arch planning layer        | `packages/arch-ai/src/planning/intelligence-plan.ts` and `packages/arch-ai/src/planning/construct-plan.ts` exist.                                                                                                  | `construct-plan.ts` still falls back to generic tool signatures and canned flow text.                                                                                                                                                                    |
| Generic tool fallback      | `packages/arch-ai/src/planning/construct-plan.ts`, `packages/arch-ai/src/blueprint/renderer.ts`, and Studio scaffold code still contain `(input: string) -> { result: string }` fallback signatures.               | Tool contracts must become schema-derived or generation should fail a quality gate.                                                                                                                                                                      |
| Canned FLOW fallback       | `packages/arch-ai/src/planning/construct-plan.ts` and `apps/studio/src/lib/arch-ai/scaffold/runtime-flow.ts` still emit generic responses like "I will use the available project tools..."                         | Customer-facing filler must not be generated as scripted business logic.                                                                                                                                                                                 |
| DELEGATE plumbing          | `packages/compiler/src/platform/constructs/executors/delegate-executor.ts` and runtime delegate tests exist.                                                                                                       | The platform still needs a fully specified, customer-silent agent invocation contract, Studio surfacing, trace semantics, and possibly a persisted `agent` tool type if we choose the tool abstraction.                                                  |
| Tool type enum             | `packages/database/src/models/project-tool.model.ts` and `packages/shared/src/tools/project-tool-persistence.ts` list `http`, `mcp`, `sandbox`, `searchai`, `workflow`, but no `agent`.                            | If DELEGATE is exposed as agent-as-tool, persistence/import/export/tool validation must accept it. If DELEGATE stays IR-native, docs and Studio must make that explicit.                                                                                 |
| OpenAI Responses history   | `apps/runtime/src/services/llm/session-llm-client.ts`, `packages/llm/src/provider-factory.ts`, and `packages/llm/src/tool-adapters.ts` own provider selection and message conversion.                              | Reasoning items emitted before function calls need to survive the next request or use `previous_response_id`.                                                                                                                                            |
| Confirmation               | `apps/runtime/src/services/execution/tool-confirmation.ts` currently treats `when_side_effects` as a static side-effect check.                                                                                     | Confirmation needs a consent contract and conversation-aware decision before prompting.                                                                                                                                                                  |
| Static tool-test responses | `apps/studio/src/lib/tool-test-endpoint-service.ts` has `upsertToolTestEndpoint`; `ToolTestPanel.tsx` exists.                                                                                                      | No full edit surface for `staticResponse` and `sampleInput` after bootstrap.                                                                                                                                                                             |
| Diagnostics                | `apps/runtime/src/services/llm/classify-llm-error.ts` and channel surfaces already classify some errors.                                                                                                           | Need structured runtime error envelopes with sanitized customer message plus operator hint and trace link.                                                                                                                                               |
| Fallback observability     | Runtime trace payloads may carry fallback markers such as `isReasoningFallback`, `reasoningFallback`, or `routingSource: reasoning_fallback`.                                                                      | Trace explorer rows need a normalized warning envelope so Studio can flag possible routing misconfiguration without exposing raw event payloads.                                                                                                         |
| Behavior profiles          | `apps/runtime/src/services/execution/profile-resolver.ts` builds profile context.                                                                                                                                  | Interaction state such as sentiment, emotion, and turn topic is not first-class profile context.                                                                                                                                                         |
| Customer continuity events | `apps/runtime/src/channels/adapters/http-async-adapter.ts`, `apps/runtime/src/channels/manifest.ts`, channel adapters, and Arch-authored behavior/profile output define how customer-visible progress is consumed. | Arch-authored agents do not yet have a first-class continuity contract for pre-action bridge language, status events, handoff continuity, and long-running work across consuming channels. `http_async` buffering is one symptom, not the whole problem. |
| Lockfile integrity         | Project import/export routes and version services compute source hashes and lockfiles.                                                                                                                             | Need documented recompute/repair command instead of manual `null` edits.                                                                                                                                                                                 |

## 4. Design Decisions

| #   | Decision                                                                                                              | Rationale                                                                                                             | Alternatives Rejected                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D-1 | Model customer-perceived voice separately from runtime agent identity.                                                | Shared-voice HANDOFF lets specialists own tools and domain logic while the customer experiences one continuous agent. | Collapsing all tools into one supervisor; forcing all children silent.        |
| D-2 | Use shared-voice HANDOFF as the default for customer-facing specialist flows.                                         | It embraces current HANDOFF semantics and scales better than a stuffed supervisor persona.                            | Treating HANDOFF as necessarily multi-voice.                                  |
| D-3 | Use silent DELEGATE only when the child should return structured internal output.                                     | Internal policy/advisory work needs suppression and state return; customer resolution usually does not.               | Using DELEGATE for every specialist flow.                                     |
| D-4 | Extend the existing Arch source contract instead of creating a parallel contract system.                              | Latest already has `SourceArchitectureContract`, source extraction, and preservation validation.                      | New sidecar schema disconnected from the current blueprint pipeline.          |
| D-5 | Make tool schema inference a hard quality gate.                                                                       | Generic `(input: string)` tools caused runtime reasoning starvation and useless static fixtures.                      | Continuing placeholder schemas for "round-trip only" demos.                   |
| D-6 | Prefer `previous_response_id` for OpenAI Responses when available, with provider-aware item preservation as fallback. | It avoids resending provider-specific reasoning payloads and preserves adjacency rules.                               | Flattening provider items into generic text/tool blocks.                      |
| D-7 | Keep customer-facing errors sanitized, but expose operator hints in Studio diagnostics.                               | Users should not see provider internals; operators need actionable signal.                                            | Leaking raw provider messages or hiding everything behind generic text.       |
| D-8 | Put confirmation policy in tool contracts, not global generation defaults.                                            | Some write tools need consent, some idempotent updates do not, and DELEGATE should bypass consent prompts.            | `confirm: never` everywhere or static `when_side_effects` prompts everywhere. |

## 5. Target Contract Additions

Add these fields to the Arch contract layer and propagate them through planning and ABL generation:

```ts
type CustomerExperienceMode =
  | 'shared_voice_handoff'
  | 'visible_handoff'
  | 'silent_delegate'
  | 'human_escalation';

interface SourceContractRelationship {
  from: string;
  to: string;
  mode: CustomerExperienceMode;
  conditionVariable: string;
  conditionExpression: string;
  perceivedPersonaId?: string;
  continuityPolicy?: 'continue_without_reintroducing' | 'announce_transfer';
  bridgePolicy?: 'none' | 'short_transition_line' | 'tool_call_narration';
  returnShape?: Record<string, unknown>;
}

interface SourceContractChannelProfile {
  channel: 'voice' | 'web_chat' | 'sms' | 'email' | string;
  welcomeMaxWords?: number;
  welcomeMaxSeconds?: number;
  responseMaxWords?: number;
  abbreviationPolicy?: 'expand_for_voice' | 'preserve_text';
  toolLatencyBridge?: boolean;
}

interface SourceContractToolPolicy {
  name: string;
  callWhen: string[];
  doNotCallWhen: string[];
  freshnessWindow?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sideEffect: boolean;
  consent?: {
    mode: 'never' | 'always' | 'when_side_effects';
    requiredIn?: 'conversation' | 'explicit_prompt';
    scopeFields?: string[];
    fallback?: 'explicit_prompt' | 'block';
  };
}

interface SourceContractModelPolicy {
  agentName: string;
  agentType: 'classifier' | 'support' | 'dispatcher' | 'research' | 'reasoning';
  reasoningRequired: boolean;
  defaultModelClass: 'fast_tool_capable' | 'reasoning' | 'research';
}
```

Additional contract fields:

- `businessInvariants`: replacement XOR refund, goodwill cap, no duplicate write action.
- `scenarioFixtures`: realistic static responses and sample inputs for tool-test endpoints.
- `emotionalHandling`: empathy triggers, forbidden phrases, one-empathy-beat-per-emotional-moment rule.
- `behaviorProfiles`: shared brand voice, channel deltas, and interaction-conditioned profiles.

## 6. Implementation Phases

### Phase 0: Baseline And Worktree Safety

**Goal**: Land each item on top of current `develop` without trampling existing local Arch changes.

**Tasks**:

1. Reconcile the current dirty files before implementation starts.
2. For each sprint item, make a small branch or worktree only after explicit user approval.
3. Preserve unrelated edits and avoid branch switching unless the user explicitly permits it.
4. For every source change, run `npx prettier --write <files>` before commit.

**Exit Criteria**:

- Current modified source files are either intentionally included in the work or left untouched.
- Each implementation slice has a named owner and file scope.
- `pnpm build` precedes any `pnpm test` run.

**Rollback**: Docs-only plan can be reverted independently. Code phases should be independently revertible by commit.

---

### Phase 1: OpenAI Responses API Reasoning History

**Priority**: P0, Sprint 1

**Goal**: Reasoning-model agents can perform multi-turn tool use without OpenAI rejecting `function_call` items that lost their required reasoning item.

**Files Touched**:

- `apps/runtime/src/services/llm/session-llm-client.ts` - provider-aware history assembly.
- `packages/llm/src/provider-factory.ts` - Responses API capability and previous-response handling.
- `packages/llm/src/tool-adapters.ts` - provider-native item conversion.
- `packages/compiler/src/platform/llm/types.ts` or shared LLM message types - provider-native history item support.
- `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts` - regression coverage.
- New focused tests under `apps/runtime/src/__tests__/llm/` or `packages/llm/src/__tests__/`.

**Tasks**:

1. Add a provider-native history envelope for OpenAI Responses items.
2. Persist `response_id` and tool-call adjacency metadata per assistant turn.
3. Prefer sending `previous_response_id` for Responses-compatible OpenAI models.
4. If previous-response round-tripping is unavailable, replay `rs_*` reasoning items adjacent to their `fc_*` function calls.
5. Keep Anthropic, Gemini, Bedrock, and chat-completions adapters unchanged except for type compatibility.
6. Add sanitized provider-error classification for the exact missing-reasoning-item error.

**Exit Criteria**:

- A reasoning OpenAI model can emit reasoning -> function_call -> tool_result -> follow-up function_call across turns.
- Next-turn OpenAI request includes either `previous_response_id` or adjacent reasoning/function call items.
- Non-OpenAI providers preserve existing message shape.
- Build passes for runtime and llm packages.

**Rollback**: Feature-flag Responses item preservation by provider option; fall back to non-reasoning model pin if disabled.

---

### Phase 2: Compile-Time Symbol And Contract Validation

**Priority**: P1/P2, Sprint 2

**Goal**: Invalid HANDOFF, GATHER, MEMORY, COMPLETE, and ON_RETURN references fail at compile/import time instead of becoming reasoning fallback at runtime.

**Files Touched**:

- `packages/core/src/parser/agent-based-parser.ts` - preserve enough source location and expression AST metadata.
- `packages/compiler/src/platform/ir/compiler.ts` - invoke validation and report diagnostics.
- `packages/compiler/src/platform/ir/validate-field-refs.ts` - dotted-path and producer/consumer validation.
- `packages/compiler/src/__tests__/validate-field-refs.test.ts`
- `packages/compiler/src/__tests__/validate-field-refs-tool-returns.test.ts`
- `packages/arch-ai/src/diagnostics/semantic-validators.ts` - Arch-facing diagnostic classification.

**Tasks**:

1. Build a symbol table for MEMORY, GATHER, FLOW outputs, COMPLETE state, child return state, and known runtime context roots.
2. Validate dotted expressions such as `intent.category`; every root must be declared or a known runtime root.
3. Require classifier/routing producers when generated HANDOFF rules depend on `intent.category`.
4. Warn on GATHER fields with no consumer.
5. Error on ON_RETURN MAP keys that the child cannot produce.
6. Surface import-time diagnostics in Studio with severity and file/line when available.
7. Distinguish valid semantic fallback from broken rule fallback in trace diagnostics.

**Exit Criteria**:

- `intent.category` is valid only when the project declares a producer or supported runtime classifier context.
- `routing_intent != null AND intent.category == ...` without `intent` producer fails validation.
- Unused required GATHER slots warn before runtime.
- Existing valid docs/examples remain accepted or are migrated in the same change.

**Rollback**: Gate new validation behind a project import mode of `warn` before enforcing on all imports.

---

### Phase 3: Customer-Experience Topology And DELEGATE

**Priority**: P0/P1, Sprint 3

**Goal**: Make topology intentional: shared-voice HANDOFF for customer-facing specialists, visible HANDOFF for real transfers, and silent DELEGATE for internal agent-as-tool work.

**Files Touched**:

- `packages/arch-ai/src/blueprint/source-architecture-contract.ts` - relationship mode and perceived persona fields.
- `packages/arch-ai/src/planning/intelligence-plan.ts` - infer topology mode from SOP language.
- `packages/arch-ai/src/planning/construct-plan.ts` - compile relationship modes into HANDOFF or DELEGATE.
- `packages/arch-ai/src/generation/abl-pipeline.ts` - emit correct ABL constructs.
- `apps/studio/src/lib/arch-ai/scaffold/assembler.ts` and scaffold tests - Studio generated ABL.
- `packages/core/src/parser/agent-based-parser.ts` - parser support if DELEGATE syntax needs extension.
- `packages/compiler/src/platform/constructs/executors/delegate-executor.ts` - executor contract hardening.
- `apps/runtime/src/services/execution/routing-executor.ts` and `reasoning-executor.ts` - child thread execution, response suppression, traces.
- Optional if choosing persisted agent tools: `packages/database/src/models/project-tool.model.ts`, `packages/shared/src/tools/project-tool-persistence.ts`, import/export schemas, Studio tool UI.

**Tasks**:

1. Add relationship modes to the Arch contract.
2. Generate shared base persona plus specialist deltas for `shared_voice_handoff`.
3. Ensure shared-voice child instructions say: continue naturally, do not reintroduce, do not repeat prior empathy unless new emotion appears.
4. Emit visible transfer language only for `visible_handoff` and `human_escalation`.
5. Standardize silent DELEGATE invocation semantics:
   - structured payload input,
   - no child RESPOND output to customer channel,
   - child final state returned to parent,
   - trace events show parent/child correlation,
   - consent gate bypasses delegate calls.
6. Decide whether DELEGATE is IR-native only or also exposed as `toolType: 'agent'`.
7. Update docs and Studio topology visuals so users can see the difference between shared voice, visible handoff, and silent delegate.

**Exit Criteria**:

- VoltMart generated topology can keep one perceived "Alex" voice across Reception and Orders agents.
- Human escalation remains visibly transferred.
- Silent DELEGATE returns structured state without customer-visible child text.
- Trace UI distinguishes HANDOFF, shared-voice HANDOFF, visible HANDOFF, and DELEGATE.

**Rollback**: Keep HANDOFF behavior unchanged for existing projects; enable relationship modes only for newly generated or migrated projects.

---

### Phase 4: Consent-Aware Confirmation Gate

**Priority**: P1, Sprint 4

**Goal**: Preserve safety for side effects without injecting redundant "reply yes" prompts after the model already obtained specific consent.

**Files Touched**:

- `apps/runtime/src/services/execution/tool-confirmation.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/__tests__/tool-confirmation-validation.test.ts`
- `apps/runtime/src/__tests__/tools-deployment/tool-confirmation-gate.test.ts`
- `packages/arch-ai/src/blueprint/source-architecture-contract.ts`
- `packages/arch-ai/src/planning/construct-plan.ts`

**Tasks**:

1. Extend confirmation schema with consent source, scope fields, fallback behavior, and bypass rules.
2. Add a consent detection pass before dispatching write tools.
3. Bind consent to immutable action parameters such as `order_id`, `refund_amount`, and `replacement_sku`.
4. Prompt only when consent is missing, stale, ambiguous, or scoped to a different action.
5. Bypass confirmation for silent DELEGATE and read-only tools.
6. Generate consent policy from Arch contract instead of defaulting every write to `when_side_effects`.

**Exit Criteria**:

- "Replacement, please" permits `create_replacement` for the same order without a redundant prompt.
- A refund call after replacement consent is blocked or reprompted.
- Missing consent still prompts.
- The prompt is channel-appropriate and sanitized.

**Rollback**: Keep legacy `when_side_effects` as fallback when no consent contract is present.

---

### Phase 5: Structured Diagnostics And Static Tool Fixtures

**Priority**: P1, Sprint 4 plus parallel small slice

**Goal**: Operators get actionable, sanitized runtime diagnostics, and tool-test fixtures become editable scenario artifacts.

**Files Touched**:

- `apps/runtime/src/services/llm/classify-llm-error.ts`
- `apps/runtime/src/services/runtime-executor.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/routes/chat.ts`
- Channel adapters under `apps/runtime/src/channels/`
- `apps/studio/src/components/traces/TracesPage.tsx`
- `apps/studio/src/components/tools/ToolTestPanel.tsx`
- `apps/studio/src/app/api/tool-test/[projectId]/[toolId]/route.ts`
- `apps/studio/src/lib/tool-test-endpoint-service.ts`

**Tasks**:

1. Define a runtime error envelope with `code`, `customer_message`, `operator_hint`, `trace_id`, and no raw provider error.
2. Thread the envelope through channel responses and Studio traces.
3. Add known hints for Responses reasoning-item errors, credential failures, model incompatibility, tool timeout, policy block, and schema mismatch.
4. Add `PATCH /api/tool-test/:projectId/:toolId` or extend the existing route to update `staticResponse` and `sampleInput`.
5. Add JSON editor UI with validation, format button, reset to generated fixture, and preview.
6. Scope all Studio route queries by `tenantId` and `projectId`.

**Exit Criteria**:

- Customer sees a safe message.
- Studio operator sees code, hint, trace link, and affected agent/tool.
- Tool-test endpoint response can be edited without rerunning Arch or deploying external stubs.
- Cross-project tool-test edit returns non-leaky 404.

**Rollback**: Keep existing generic message path if envelope creation fails; retain generated static response as default.

---

### Phase 6: Contract-Driven Arch Generation

**Priority**: P2, Sprint 5

**Goal**: Arch generates from an explicit intermediate project contract, not directly from SOP prose.

**Files Touched**:

- `packages/arch-ai/src/blueprint/source-architecture-contract.ts`
- `packages/arch-ai/src/blueprint/v2-schema.ts`
- `packages/arch-ai/src/blueprint/renderer.ts`
- `packages/arch-ai/src/blueprint/fixtures.ts`
- `packages/arch-ai/src/planning/intelligence-plan.ts`
- `packages/arch-ai/src/planning/construct-plan.ts`
- `packages/arch-ai/src/generation/abl-pipeline.ts`
- `apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts`
- `apps/studio/src/lib/arch-ai/scaffold/runtime-flow.ts`
- `apps/studio/src/lib/arch-ai/tool-bootstrap-synthesizer.ts`
- `packages/shared/src/prompts/prompt-catalog.ts`

**Tasks**:

1. Extend the contract schema with topology, channel, persona, tool, consent, invariant, fixture, and model policy fields.
2. Update intelligence planning to extract these fields from SOPs and source docs.
3. Remove generic signature fallbacks; require inferred schemas or explicit unresolved-contract diagnostics.
4. Remove canned FLOW responses; use reasoning flow or generated task-specific states.
5. Generate tool descriptions from `callWhen`, `doNotCallWhen`, freshness, and required-context policy, not from generic action names.
6. Generate behavior profiles for shared voice, channel deltas, emotional handling, and interaction-conditioned rules.
7. Convert "the supervisor gives you X" SOP language into handoff/delegate payload context, not required customer-facing GATHER slots.
8. Avoid duplicate implementations: do not generate `consult_policy_advisor` or `delegate_to_fulfillment` HTTP tools when a real HANDOFF or DELEGATE relationship exists.
9. Generate realistic scenario fixtures from tool output schemas and SOP examples.
10. Generate default model policy as non-reasoning unless `reasoningRequired` is true.
11. Run compiler validation from Phase 2 before producing final project artifacts.

**Exit Criteria**:

- Generated VoltMart project includes structured schemas for `get_order`, `search_policies`, `create_replacement`, `issue_refund`, and `apply_goodwill_credit`.
- It enforces replacement XOR refund and goodwill cap.
- It emits short voice/chat welcomes.
- It emits shared-voice HANDOFF for Orders/Billing and visible handoff for HumanEscalation.
- It does not emit generic flow filler or placeholder static responses.

**Rollback**: Keep old scaffold generator behind a legacy mode for existing tests until golden fixtures migrate.

---

### Phase 7: Model Defaults And Reasoning Opt-In

**Priority**: P2/P3, parallel small slice

**Goal**: New Arch-generated support agents use fast tool-capable non-reasoning models by default; reasoning is opt-in by role and contract.

**Files Touched**:

- `packages/arch-ai/src/blueprint/v2-schema.ts`
- `packages/arch-ai/src/blueprint/renderer.ts`
- `packages/arch-ai/src/generation/abl-pipeline.ts`
- `packages/arch-ai/src/model-policy.ts`
- `packages/arch-ai/src/prompts/phases/build.ts`
- `packages/arch-ai/src/prompts/index.ts`
- `packages/arch-ai/src/index.ts`
- `packages/arch-ai/src/__tests__/model-policy.test.ts`
- `packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`
- `packages/arch-ai/src/__tests__/blueprint/v2-renderer.test.ts`
- `packages/arch-ai/src/__tests__/generation/abl-pipeline.test.ts`

**Tasks**:

1. Add `modelPolicy.agentType` and `modelPolicy.reasoningRequired` to the Blueprint v2 agent contract.
2. Add overridable model-class defaults (`fastToolCapable`, `reasoning`, `research`) at the blueprint/render policy boundary.
3. Map ordinary Arch support, classifier, dispatcher, scripted, and specialist skeletons to the configured fast tool-capable model by default.
4. Map `research` and `reasoning` to the configured reasoning/research default only when `agentType`, `reasoningRequired`, or a reasoning/research model class is explicit.
5. Preserve explicit `agent.model` values over inferred defaults.
6. Update build-prompt guidance so generated ABL includes the configured fast tool-capable model for normal support flows and treats o-series models as opt-in.
7. Leave runtime model-resolution and tenant/project overrides unchanged in this slice.

**Exit Criteria**:

- New support flow agents no longer need manual `EXECUTION` patches to avoid reasoning-model defaults.
- Model IDs are not embedded in renderer/skeleton logic; they flow through model-class policy defaults with caller and blueprint override seams.
- Reasoning models remain available for explicit reasoning roles.
- Existing model-resolution user-scoped cache contract is preserved.

**Rollback**: Tenant/project model overrides continue to win over Arch hints.

---

### Phase 8: Interaction Profiles, Customer Continuity Events, Fallback Warnings, Lockfile Repair

**Priority**: P3/backlog, parallelizable

**Goal**: Close gaps that affect operator confidence and the end-customer's perceived continuity across Arch-authored agents, runtime topology, and consuming channels.

**Files Touched**:

- `apps/runtime/src/services/execution/profile-resolver.ts`
- `apps/runtime/src/channels/adapters/http-async-adapter.ts`
- `apps/runtime/src/channels/manifest.ts`
- Runtime channel adapters that consume response/status events
- Arch generation paths that author behavior profiles, pre-action bridge language, and topology experience modes
- `apps/studio/src/contexts/WebSocketContext.tsx`
- `apps/studio/src/components/traces/TracesPage.tsx`
- `packages/kore-platform-cli/src/`
- `apps/studio/content/abl-reference/` and `apps/docs-internal/content/`

**Tasks**:

1. Extend `ProfileContext` with `interaction.sentiment_score`, `interaction.emotion_label`, and `interaction.turn_topic`.
2. Populate interaction fields from existing sentiment/intent classifiers where available.
3. Define a channel-neutral customer-continuity event contract for Arch-authored agents: pre-action bridge text, long-running action/status updates, handoff transition behavior, and final response delivery.
4. Teach Arch generation to author continuity behavior through behavior profiles/topology experience modes rather than transport-specific prompt hacks.
5. Map the continuity contract into every consuming channel. For `http_async`, this includes mid-turn flush or status events when an agent emits bridge text before a long action; voice/live channels should preserve spoken bridge timing; chat clients should render status without duplicating final responses.
6. Render `isReasoningFallback: true` as a Studio warning with a possible-misconfiguration hint.
7. Add `kore lockfile recompute <project>` or equivalent CLI command.
8. Document lockfile repair and the `null` source-hash recompute behavior if it remains supported.

**Exit Criteria**:

- Behavior profiles can condition on interaction state.
- Arch-authored agents produce an explicit customer-continuity contract for bridge/status/handoff behavior, and runtime/channel consumers preserve that contract.
- Web chat/http_async sees a bridge/status message before long actions without duplicating the final response.
- Voice/live channels preserve natural bridge timing and do not force customer-visible implementation language.
- Reasoning fallback is visible in Studio without raw trace spelunking.
- Operators have a documented lockfile repair path.

**Rollback**: Profile interaction fields are optional; continuity events can be disabled per channel, falling back to final-response-only delivery while retaining authored behavior/profile metadata.

## 7. Sprint Order

| Sprint           | Item                                                                                                                              | Why                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1                | Responses API serialization                                                                                                       | Platform-wide blocker for reasoning-model tool use.                                         |
| 2                | Compile-time validation                                                                                                           | Cheap, high-leverage, and makes generated topology safer.                                   |
| 3                | Customer-experience topology plus DELEGATE                                                                                        | Shared-voice HANDOFF fixes customer specialist flow; DELEGATE unlocks silent advisory flow. |
| 4                | Consent-aware confirmation plus structured diagnostics                                                                            | Removes user-visible interruptions and makes failures actionable.                           |
| 5                | Contract-driven Arch generation                                                                                                   | Larger work that stops repeated hand edits.                                                 |
| Backlog/parallel | Static response editor, default model policy, profile interaction state, http_async continuity, fallback warning, lockfile repair | Smaller slices that can be picked up independently.                                         |

## 7.1 Implementation Status

| Slice | Status      | Commit       | Notes                                                                                                                                                                                                                                    |
| ----- | ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Implemented | `2479eb4520` | OpenAI Responses requests use `previousResponseId` and prune replayed history after the referenced response while preserving tool-name lookup.                                                                                           |
| 2     | Partial     | `f6e8a92345` | Compiler now warns on mixed `routing_intent`/`intent.category` routing state; full symbol-table validation remains open.                                                                                                                 |
| 3     | Implemented | `f01a015589` | Behavior profile context exposes neutral-default interaction sentiment, emotion, and turn-topic fields.                                                                                                                                  |
| Merge | Complete    | `20ca49c675` | Latest `origin/develop` integrated after Slice 3; focused regression locks were rerun on the merged tree.                                                                                                                                |
| 4     | Partial     | `853617c4a4` | Studio backend can read/update tool-test static responses and sample inputs; full UI editor remains open.                                                                                                                                |
| 5     | Partial     | `9b8b0cc978` | LLM classifier sanitizes OpenAI Responses missing-reasoning-item errors and attaches an operator diagnostic; trace/UI envelope remains open.                                                                                             |
| 6     | Partial     | `a3c3c71b07` | CLI can recompute local v2 `abl.lock` source hashes, layer hashes, and integrity; broader docs site guidance remains open.                                                                                                               |
| 7     | Partial     | `74c6a12423` | Runtime confirmation gate can accept explicit same-action conversation consent and still prompt on missing or mismatched consent.                                                                                                        |
| 8     | Partial     | `dc1d2ef460` | ABL parser/compiler preserve consent-aware confirmation fields and Arch emits them for side-effecting generated tools; full contract generator remains open.                                                                             |
| 9     | Partial     | `04e2b22fca` | Arch model defaults route through a model-class policy with caller/blueprint override seams; broader contract-driven model selection remains open.                                                                                       |
| 10    | Partial     | `f0a76720a2` | Runtime trace explorer normalizes reasoning-fallback markers into warnings and Studio renders them with a possible-misconfiguration hint.                                                                                                |
| 11    | Partial     | `6ba680541a` | HTTP Async supports opt-in `agent.status` deliveries and emits one status payload from the first visible bridge chunk before the final response.                                                                                         |
| 12    | Partial     | `92185db188` | Model parameters flow through registry/catalog capabilities, Studio dynamic hyperparameters, tenant/project persistence, and runtime provider mapping.                                                                                   |
| 13    | Partial     | `6e7ac4c747` | Compiler validates dotted condition roots so undefined paths such as `action_request.kind` no longer bypass field-reference checks.                                                                                                      |
| 14    | Implemented | `8d998a4abd` | Studio exposes hosted tool-test fixture editing for `staticResponse` and `sampleInput`, including null-preserving fixture saves.                                                                                                         |
| 15    | Partial     | `ce8f82a229` | Runtime trace events and Studio trace rows surface sanitized LLM operator diagnostics for known Responses missing-reasoning-item errors.                                                                                                 |
| 16    | Partial     | `c0e9bd5e7f` | DELEGATE parent and child trace events share a stable `delegationId` for operator auditability.                                                                                                                                          |
| 17    | Implemented | This commit  | Arch scaffold and construct-plan defaults no longer emit canned normal-path FLOW progress/completion responses.                                                                                                                          |
| 18    | Implemented | This commit  | Arch package fallbacks and Studio scaffold tool stubs infer structured signatures instead of `(input: string) -> { result: string }`.                                                                                                    |
| 19    | Implemented | This commit  | Studio scaffold entry welcomes are short and channel-shaped for web chat and voice.                                                                                                                                                      |
| 20    | Implemented | This commit  | Generated failure and legacy builder responses avoid implementation language such as tool, step, workflow, context, retry, and escalation.                                                                                               |
| 21    | Implemented | This commit  | Arch package renderers and Studio scaffold generation filter duplicate consult/delegate helper tools when a HANDOFF/DELEGATE relationship already exists.                                                                                |
| 22    | Implemented | This commit  | Blueprint gather fields are source-aware, and Arch/Studio generation no longer renders context, memory, tool, or incoming handoff payload fields as prompts.                                                                             |
| 23    | Implemented | This commit  | Arch construct-expert and Studio handbook prompts describe return targets as needing completion state, not mandatory customer-facing GATHER fields.                                                                                      |
| 24    | Partial     | `4a780c54b8` | Blueprint topology can mark handoff experience mode; shared-voice handoff targets reference a generated standalone behavior profile that Studio persists.                                                                                |
| 25    | Partial     | This commit  | Handoff experience mode now survives source-contract synthesis, deterministic topology fallbacks, Studio topology extraction, and BUILD validation inputs.                                                                               |
| 26    | Partial     | This commit  | The topology architect prompt and Studio topology tools now ask generation to set handoff experience mode instead of relying on renderer fallback.                                                                                       |
| 27    | Partial     | This commit  | Blueprint validation now warns when a topology edge omits customer handoff experience mode while keeping legacy imports non-blocking.                                                                                                    |
| 28    | Partial     | This commit  | Studio `generate_topology` validation now rejects missing or incompatible handoff experience modes so draft generation retries before persistence.                                                                                       |
| 29    | Partial     | This commit  | Studio topology runtime validation is centralized and unit-tested so legacy and v4 `generate_topology` paths cannot drift.                                                                                                               |
| 30    | Partial     | This commit  | Studio blueprint rebuild now has regression coverage proving generated behavior profiles are persisted and protected by overwrite confirmation.                                                                                          |
| 31    | Partial     | This commit  | Studio blueprint rebuild now invalidates Arch project caches after generated behavior-profile upserts, so the next Arch turn sees refreshed profile context.                                                                             |
| 32    | Partial     | This commit  | Topology generation now treats shared/visible handoff experience as customer-facing transfer semantics and reserves delegate edges for silent delegation.                                                                                |
| 33    | Partial     | This commit  | Studio blueprint rebuild reconciles stale Arch-managed behavior profiles when topology no longer needs shared-voice continuity.                                                                                                          |
| 34    | Partial     | `f5250c4640` | Studio agent-generation prompts now preserve edge `experienceMode` and require shared-voice handoff targets to attach the reusable behavior profile.                                                                                     |
| 35    | Partial     | `fa6c7dd6d7` | Studio scaffold slot-fill fallbacks now strip implementation/internal language from deterministic fallback prompts, responses, and derived categories.                                                                                   |
| 36    | Partial     | `7b4ea56a39` | Arch and Studio deterministic topology fallback summaries now use product-facing copy and avoid generator/debug phrasing.                                                                                                                |
| 37    | Partial     | `95f77c619c` | Arch skeleton generation no longer emits canned scripted/hybrid responses, and deterministic delegate prompts avoid internal continuation wording.                                                                                       |
| 38    | Partial     | `c495f14dd6` | Arch construct-plan defaults preserve tool failure branches without generating canned customer failure response text.                                                                                                                    |
| 39    | Partial     | This commit  | Studio scaffold runtime-flow failure responses now avoid awkward transfer/process phrasing and internal vocabulary.                                                                                                                      |
| 40    | Partial     | This commit  | Shared-voice behavior profiles are now rendered from a single Arch-managed helper and wired through Blueprint rendering, Studio scaffold assembly, isolated compile validation, BUILD validation, and project finalization persistence.  |
| 41    | Partial     | This commit  | Studio scaffold welcomes and construct prompt examples now use short human-facing copy, and scaffold tests lock structured tool signatures instead of legacy generic `(input: string)` contracts.                                        |
| 42    | Implemented | This commit  | Studio scaffold failure branches keep control-flow recovery but omit synthesized customer-facing failure/retry copy entirely.                                                                                                            |
| 43    | Implemented | This commit  | Runtime behavior-profile resolution now carries sanitized current-turn sentiment, emotion, and topic hints from metadata/session state into live profile evaluation.                                                                     |
| 44    | Partial     | This commit  | Runtime DELEGATE now treats typed `delegate_to_*` arguments as child payload, returns a structured child envelope, and locks customer-silent child execution with regressions.                                                           |
| 45    | Implemented | This commit  | Studio hosted tool-test fixtures can now be created from the fixture editor when missing, and explicit `staticResponse: null` / `sampleInput: null` values are preserved.                                                                |
| 46    | Partial     | This commit  | Compiler cross-agent validation now warns when local HANDOFF `ON_RETURN` or DELEGATE `RETURNS` maps fields the child agent does not declare or obviously produce.                                                                        |
| 47    | Partial     | This commit  | CLI lockfile recompute now matches v2 prompt companion agent hashing, prompt layer hashing, and empty declared layer hashes, with regressions for `null` hash repair.                                                                    |
| 48    | Partial     | This commit  | HTTP Async inbound delivery now emits opt-in human-clean `agent.status` continuity messages only when a visible bridge chunk is paired with an LLM tool-call trace, while final responses stay result-sourced.                           |
| 49    | Partial     | This commit  | Runtime errors now carry sanitized envelopes with human-clean customer messages and operator diagnostics that Studio trace rows can surface without raw provider, model, tenant, or endpoint details.                                    |
| 50    | Partial     | This commit  | Arch/Studio model policy selection now capability-gates project/tenant catalog defaults so support/classifier/dispatcher exclude reasoning families by default, while reasoning/research opt-in is preserved.                            |
| 51    | Partial     | This commit  | Arch turn-engine model/configuration failures now surface sanitized builder-facing technical diagnostics instead of raw model-resolution messages, while preserving technical error codes for tracing.                                   |
| 52    | Partial     | This commit  | Coordination `experienceMode` now survives authored ABL parsing, compiler IR, static app graph extraction, Arch blueprint rendering, and Studio topology API responses. Runtime enforcement remains open.                                |
| 53    | Partial     | This commit  | Runtime now derives customer/internal topology visibility from `experienceMode`, emits visible handoff-transition continuity to HTTP Async status events and streaming-text channels, and keeps delegates internal/suppressed in traces. |
| 54    | Partial     | This commit  | HTTP Async now emits delayed `long_running_status` continuity for open tool/action windows, and runtime-generated fillers/handoff bridges are completed into spoken-safe phrases before customer emission.                               |
| 55    | Partial     | This commit  | HTTP Async delivery-worker tests now prove queued `agent.status` callbacks are posted before final `agent.response` callbacks, preserving long-running continuity metadata through callback serialization.                               |
| 56    | Partial     | This commit  | Voice continuity evidence now verifies Grok realtime handoff waits for transfer speech completion and records why timer-driven synthetic voice fillers remain transport-evidence gated.                                                  |
| 57    | Partial     | This commit  | Manifest-wide continuity tests now lock every consuming channel to status events, streamed text, native typing indicators, or final-response-only delivery, preventing unsafe synthesized status text on typing-only/final channels.     |
| 58    | Implemented | This commit  | Import/export reference docs now document the supported `kore-platform-cli lockfile recompute` repair path for stale or `null` v2 `abl.lock` hashes instead of manual hash edits.                                                        |
| 59    | Partial     | This commit  | Compiler validation now rejects invalid local HANDOFF `ON_RETURN MAP` child keys as compilation errors instead of warning and allowing import/build to proceed.                                                                          |
| 60    | Partial     | This commit  | Runtime DELEGATE now runs target-agent auth preflight before child stack/thread/activation/execution and emits blocked delegate trace metadata without exposing child output.                                                            |
| 61    | Partial     | This commit  | Arch topology fallbacks, source-contract synthesis, prompts, and system-agent skeletons now carry provider-neutral `modelPolicy` hints for fast support defaults and explicit reasoning/research opt-in.                                 |
| 62    | Partial     | This commit  | Compiler validation now warns when required GATHER fields have no known consumers across COMPLETE, MEMORY, FLOW, handoff/delegate inputs, tool inputs, and return mappings.                                                              |
| 63    | Partial     | This commit  | Runtime channel outcomes now reuse sanitized runtime error envelopes for inbound failures, preserving customer-clean messages and trace-attached operator diagnostics.                                                                   |
| 64    | Partial     | This commit  | HTTP Async delivery now has a real local callback-sink regression proving `agent.status` reaches the callback before the final `agent.response` without duplicating final answer text.                                                   |
| 65    | Partial     | This commit  | Arch-managed shared-voice behavior profiles now persist from system-agent topology finalization and reconcile stale managed profiles when topology no longer needs shared-voice continuity.                                              |
| 66    | Partial     | This commit  | Arch model policy remains provider-neutral capability intent: explicit author choices still win, but Arch no longer picks concrete reasoning/research model IDs that a customer may not have access to.                                  |
| 67    | Partial     | This commit  | Runtime model resolution now treats dynamic hyperparameter bags as authoritative for agent-level parameters and avoids resurrecting stale legacy scalar temperature values.                                                              |
| 68    | Partial     | This commit  | Source architecture contracts now expose welcome shape, channel rules, consent policies, scenario fixtures, and provider-neutral per-agent model-policy intent, with VoltMart-like extraction coverage.                                  |
| 69    | Partial     | This commit  | Slack outbound delivery failures now return sanitized channel-delivery diagnostics instead of raw provider/network strings; other direct-send adapters remain to normalize.                                                              |
| 70    | Partial     | This commit  | Web SDK React chat now renders transient status updates outside message history and clears them on final responses, with DOM coverage proving no duplicate final answer text.                                                            |
| 71    | Partial     | This commit  | Compiler validation now warns when explicit non-condition consumers reference variables with no known producer, while keeping compatibility by avoiding bare string input guesses.                                                       |
| 72    | Partial     | This commit  | Runtime model parameter filtering now falls back to provider-level supported parameter classes for unknown model IDs and fails closed for unknown providers without hardcoding customer model IDs.                                       |
| 73    | Partial     | This commit  | Blueprint rendering now consumes source-contract consent policies and channel declarations when rebuilding agents, so SOP-derived consent scope/fallback and shared-voice channel behavior flow into generated ABL.                      |
| 74    | Partial     | This commit  | Studio project finalization now feeds source-contract scenario fixtures into hosted tool-test static responses, so SOP example outcomes seed deterministic Test API fixtures instead of generic placeholder responses.                   |
| 75    | Partial     | This commit  | Source scenario fixtures now carry optional per-tool sample inputs and Studio bootstrap merges explicit/inferred source-grounded request examples into hosted Tool Test API sample inputs.                                               |
| 76    | Partial     | This commit  | Telegram, LINE, Instagram, Twilio SMS, Zendesk, and Microsoft Teams direct-send failures now return sanitized channel-delivery diagnostics instead of raw provider/config/network strings.                                               |
| 77    | Partial     | This commit  | Email, AI4W async mode, and WhatsApp Meta Cloud/Infobip/Netcore/Gupshup provider sends now return sanitized channel-delivery diagnostics for configuration, metadata, provider rejection, network, and timeout failures.                 |
| 78    | Partial     | This commit  | Studio hosted Tool Test API bootstrap now walks object/array parameter schemas to synthesize nested source-grounded sample inputs, with explicit scenario fixture `sampleInput` deeply merged over generated nested values.              |
| 79    | Partial     | This commit  | Studio deterministic scaffold BUILD workers now propagate per-agent abort signals into Sonnet-backed structured-output calls and emit terminal builder diagnostics instead of leaving an agent row spinning indefinitely.                |

## 8. Wiring Checklist

- [x] New Arch contract fields exported from `packages/arch-ai` public types for welcome shape, channel rules, consent policies, scenario fixtures, and provider-neutral agent model-policy intent.
- [ ] Partial: contract renderer, fixtures, and Studio scaffold now avoid generic fallback signatures; source-grounded scenario fixture responses plus explicit/inferred schema-aware nested sample inputs now seed Studio-hosted Test API fixtures during finalization, while broader generated-project fixture proof remains open.
- [ ] Studio scaffold generator consumes the same contract fields as package-level Arch pipeline.
- [ ] Partial: compiler validation warns on mixed routing state, rejects unknown local HANDOFF return fields, warns on unknown local DELEGATE return fields, flags unused required GATHER slots, and warns when explicit non-condition consumers lack a known producer; full producer/consumer reachability remains warning-level and not yet control-flow aware.
- [x] Runtime DELEGATE trace events include parent and child correlation IDs.
- [x] Runtime DELEGATE remains IR-native for same-project silent agent-as-tool invocation; no persisted `ProjectToolType: agent` was added.
- [x] Runtime DELEGATE fails closed on unsatisfied target-agent preflight auth before child execution starts.
- [ ] Partial: runtime supports opt-in conversation consent for tool confirmations and Arch emits consent policy for side-effecting generated tools; source-contract extraction now carries side-effect consent policies, scope fields, and fallback behavior for SOP-derived tools; Blueprint rendering consumes those policies when the locked blueprint is rebuilt, and Studio finalization consumes source-contract scenario fixtures for hosted static responses.
- [ ] Partial: runtime emits human-clean customer messages, inbound channel outcomes preserve sanitized error envelopes for traces, Slack/Messenger/Telegram/LINE/Instagram/Twilio SMS/Zendesk/Microsoft Teams/Email/AI4W async/WhatsApp provider delivery failures now return sanitized channel diagnostics, and Arch emits sanitized builder-facing technical diagnostics for known LLM/config/tool failures; remaining non-direct-send media, stream, and sync/voice failure surfaces still need a separate audit.
- [ ] Partial: Studio trace UI renders reasoning-fallback warnings; broader runtime operator-hint envelope remains open.
- [ ] Partial: HTTP Async can deliver opt-in `agent.status` continuity events before the final result-sourced `agent.response`; visible handoff transitions now also flow to HTTP Async status and streaming-text channels; delayed `long_running_status` emits for long open tool/action windows; delivery-worker tests and a real local callback-sink test preserve status-before-response ordering; Web SDK React renders status updates outside message history and clears them on final response; runtime-generated filler and handoff bridge phrases complete before customer emission; focused voice/live evidence proves Grok handoff waits for transfer speech completion; manifest-wide tests lock typing-only channels to native typing indicators and sync/final-response channels to final responses only; deployed callback E2E, provider-recorded audio evidence, and full live Runtime browser proof remain open.
- [x] StaticResponse edit route and Studio editor are tenant/project scoped, including create-from-missing and explicit null fixture preservation.
- [x] CLI lockfile recompute command is implemented and documented in CLI README plus import/export reference docs.
- [x] Arch renderer, construct-plan, and Studio scaffold generation filter duplicate relationship-as-tool stubs for represented handoff/delegate targets.
- [x] Arch renderer, source-contract topology synthesis, and Studio scaffold generation avoid turning supervisor/context/memory-provided fields into customer-facing GATHER prompts.
- [x] Arch and Studio generation prompts no longer force every RETURN/delegate target to add customer-facing GATHER when context, memory, flow, or tool state can satisfy completion.
- [x] Blueprint renderer emits shared-voice handoff continuity as a reusable `BEHAVIOR_PROFILE` and `USE BEHAVIOR_PROFILE` reference instead of duplicating specialist persona prose.
- [ ] Partial: Studio blueprint rebuild persists generated behavior profiles before applying generated agents, conflicts on local profile edits, removes stale Arch-managed profiles when safe, invalidates Arch project caches after profile mutations, and Studio/BUILD topology paths preserve shared/visible/silent experience modes with shared/visible modes mapped to transfer semantics; agent-generation prompts now carry `experienceMode` through to target-specific shared-voice behavior-profile instructions; full end-to-end UX proof remains open.
- [ ] Partial: Studio scaffold and BUILD validation now compile shared-voice handoff agents with companion behavior-profile documents, authored ABL/topology APIs preserve `experienceMode`, finalization persists Arch-managed profile variables, and managed profile cleanup prevents stale global shared-voice rules; full browser proof remains open.
- [ ] Model-resolution cache contract remains user-scoped only for full resolution.
- [ ] Partial: model defaults are capability-driven in runtime/Studio, while Arch emits provider-neutral model-policy intent and only honors explicit concrete model choices; source-contract extraction now carries SOP-derived `reasoningRequired` evidence for policy/research/advisory roles without assuming customer model access.

## 9. Acceptance Criteria

- [x] OpenAI Responses requests use response-id round-tripping to avoid missing-reasoning-item replay errors.
- [ ] Partial: invalid generated HANDOFF symbols are caught before runtime for mixed routing-state warnings and unknown local HANDOFF child return-field mappings; unused required GATHER slots now warn when Arch accidentally turns provided context into customer slot-fill prompts; explicit non-condition variable consumers now warn when no known producer exists.
- [ ] Partial: Arch can generate shared-voice HANDOFF targets backed by a behavior profile and no duplicated specialist voice prose, authored topology `experienceMode` survives parser/IR/graph/API propagation, and runtime now enforces trace/visibility/transition semantics for shared, visible, and silent topology modes; full VoltMart end-to-end topology fixture remains open.
- [x] Silent DELEGATE can call a child agent without customer-visible child RESPOND output.
- [ ] Partial: natural-language consent permits the intended write tool, ABL/Arch can express the consent contract, source-contract extraction carries consent policy/scope/fallback metadata, and runtime still prompts for missing or mismatched consent.
- [x] Studio can edit hosted tool-test static responses and sample inputs from the tool testing panel.
- [ ] Partial: known OpenAI Responses reasoning-item errors, selected runtime failures, inbound channel outcomes, and the major direct-send adapters plus WhatsApp provider sends now provide human-clean customer messages with trace/operator diagnostics, while Arch builder failures provide sanitized technical diagnostics and scaffold BUILD aborts now surface terminal builder errors.
- [ ] Partial: hosted Tool Test API fixtures are source-grounded for static responses, top-level sample inputs, and object/array schema-aware nested sample inputs from scenario fixture payloads, user messages, and common ID/status/amount/date patterns; broader generated-project fixture proof remains open.
- [ ] Partial: Arch no longer emits canned FLOW filler on generated normal paths, avoids generic tool-signature fallbacks, emits short scaffold welcomes, and keeps generated fallbacks customer-clean; Studio scaffold deterministic slot fallbacks also filter implementation/internal wording from generated prompts, responses, and derived categories; deterministic topology fallback summaries avoid generator/debug phrasing; package skeletons emit empty customer responses instead of canned scripted/hybrid filler; construct-plan tool failure branches no longer emit canned response text; Studio scaffold runtime-flow failure responses avoid internal/process wording; full channel persona contracts remain open.
- [x] Arch no longer generates duplicate delegation-as-HTTP tools for relationships represented as HANDOFF or DELEGATE in the package renderer, construct-plan fallback, and Studio scaffold paths.
- [x] Arch no longer turns supervisor-provided context into customer-facing required GATHER slots in the Blueprint v2 renderer, construct-plan fallback, source-contract topology synthesis, and Studio scaffold paths.
- [ ] Partial: Arch carries support/dispatcher/reasoning/research capability hints without selecting inaccessible concrete reasoning models; source-contract extraction now covers explicit policy synthesis/advisory reasoning evidence, while broader prompt-to-build consumption remains open.
- [ ] Partial: profile rules can use interaction state, CLI has a documented repair path for local v2 lockfiles, and Runtime/Web SDK now have a channel-neutral customer-continuity contract for pre-action bridge/status delivery, delayed long-running status delivery, phrase-complete runtime fillers, callback ordering locks, focused Grok voice/live timing evidence, manifest-wide consumer-mode locks, visible handoff-transition consumption in HTTP Async and streaming-text channels, and React status rendering outside message history; provider-recorded audio evidence, deployed callback E2E, and full live Runtime browser proof remain open.
- [ ] Partial: model parameter controls are advertised by registry capabilities, runtime strips unsupported parameters before provider calls, dynamic hyperparameter bags override stale legacy scalar temperature values, and unknown models fall back to provider-level supported parameter classes while unknown providers fail closed; legacy scalar fields remain for compatibility.

## 10. Post-Implementation Notes

- The OpenAI Responses slice chose `previousResponseId` over serializing hidden reasoning items. That avoids shipping provider-native reasoning payloads through the generic history model and keeps non-OpenAI adapters unchanged.
- The compiler slice is intentionally narrow. It catches the exact Arch-generated mixed-state condition that caused fallback routing, but it is not the full producer/consumer symbol-table validator described in Phase 2.
- The cross-agent return-field validation slice is warning-only for compatibility. It covers local HANDOFF `ON_RETURN` and DELEGATE `RETURNS` mappings against child-declared/obviously produced fields, while remote targets and execution-order reachability remain open.
- The interaction-profile slice is complete for context assembly and CEL evaluation. It does not yet add an upstream sentiment classifier; it exposes fields when existing interaction state is supplied and defaults missing values to neutral.
- The interaction-profile wiring slice closes the live propagation gap: runtime session creation, message execution, and reasoning profile re-evaluation now merge sanitized classifier hints from metadata/session state before evaluating profile `WHEN` clauses.
- The diagnostics slice is intentionally classifier-only. It gives the known Responses API failure a stable sanitized message and operator hint, but full runtime error envelopes, trace ids, and Studio rendering remain future work.
- The runtime error-envelope slice extends diagnostics beyond classifier-only handling: traces now carry sanitized envelopes with operator hints for known LLM/config/tool failures, chat routes prefer the human-clean customer message, and Studio trace rows expose the operator diagnostic. Full channel-adapter rendering is still open.
- The lockfile repair slice supports local v2 `abl.lock` recompute from exported project folders. It preserves the existing v2 hash algorithm, including prompt-library companion hashes and empty manifest-declared layer hashes, and leaves Studio/internal docs expansion for a follow-up.
- The consent slice is runtime-first. It adds IR fields and executor behavior for conversation consent, but ABL parser syntax and Arch contract emission still need to generate those fields.
- The model-parameter slice is the future-ready answer to avoiding hardcoded model behavior: Arch chooses a model class, Studio discovers per-model controls from the registry/catalog, persistence stores provider-specific `hyperParameters`, and runtime strips unsupported parameters before provider calls.
- The model-policy slice avoids pinning generated agents to a literal support model: Arch/Studio select from configured catalog candidates by model class and capabilities, support/classifier/dispatcher reject reasoning-capable models by default, and reasoning/research remain explicit opt-ins.
- The handoff-experience slice keeps behavior profiles as the reusable voice layer. `experienceMode` is now a topology contract field that flows through Arch synthesis and Studio BUILD paths, so shared-voice continuity is not duplicated into every specialist persona.
- The topology-prompt slice closes the generation half of that contract: the architect prompt and Studio tool schemas now tell Arch to set `experienceMode` explicitly on every edge.
- The validation slice makes missing `experienceMode` visible as a warning. This keeps existing projects importable while making future generated topology drafts auditable.
- The Studio topology validation slice closes the lighter `generate_topology` path: new drafts must include compatible handoff experience modes before they are stored.
- The centralization slice removes duplicated topology runtime validation from Studio's legacy and v4 generation paths and locks the shared helper with pure unit tests.
- The behavior-profile apply slice locks the final Studio persistence boundary for shared-voice handoff: rendered standalone profiles are upserted as project config variables, draft metadata is refreshed, and locally edited profiles require explicit overwrite confirmation.
- The behavior-profile cache slice closes the immediate stale-read gap after rebuild: generated profile upserts now invalidate Arch project caches in addition to refreshing draft metadata.
- The topology-semantics slice resolves the hidden split between `edge.type` and `experienceMode`: customer-facing shared/visible handoffs are transfer edges, while `delegate` is reserved for silent internal delegation.
- The managed-profile reconciliation slice closes stale generated profile drift: rebuild deletes canonical Arch-managed profiles that are no longer rendered, while requiring overwrite confirmation before deleting locally edited managed profiles.
- The Studio handoff-prompt slice closes the last visible Studio prompt propagation gap for shared voice: `experienceMode` is rendered in topology context, and incoming `shared_voice_handoff` targets are explicitly told to attach `USE BEHAVIOR_PROFILE: shared_voice_handoff` rather than reintroducing themselves.
- The Studio slot-fallback language slice closes one recovery-path leak: if structured scaffold slot generation fails, deterministic fallbacks no longer emit route/classify/escalate/specialist/tool/workflow/step/context/retry language into generated prompts, responses, or fallback-derived categories.
- The topology-fallback summary slice closes the recovery text around deterministic blueprint drafts: package and Studio fallbacks now describe the created blueprint/topology directly, without exposing generator failure language.
- The package skeleton language slice closes the older Arch builder path: scripted and hybrid skeletons now leave explicit customer responses empty rather than sending canned progress/completion phrases, and deterministic delegate prompts use customer-facing wording.
- The construct-plan failure-language slice keeps generated failure control flow but removes canned failure response text, allowing the runtime/agent to handle recovery without leaking generic support copy.
- The customer-continuity slice reframes HTTP Async status as one consumer of a broader channel-neutral contract. Arch's shared-voice profile now tells generated specialists to author brief customer-facing bridge phrases before longer lookups/actions, runtime maps channels to continuity consumption modes, and HTTP Async status payloads sanitize implementation language before delivery.
- The Studio runtime-flow failure-language slice keeps failure handling intact while replacing awkward transfer/process phrases with short customer-safe retry copy across tool-worker, transaction, escalation, and pipeline-stage plans.
- The managed-profile propagation slice removes the last behavior-profile split brain between Blueprint and Studio generation paths: both now use the same Arch-managed `shared_voice_handoff` renderer, Studio validates generated agents with companion profile documents, and finalization persists those profiles as project config variables before the agents rely on them.
- The scaffold language lock slice keeps the first customer utterance short by channel and updates tests away from legacy generic tool signatures. It also fixed side-effect inference for transaction-style names such as `refunds_submit_refund`, so generated write actions keep confirmation policy instead of being treated as read-only lookups.
- The scaffold failure-silence slice closes the remaining user-facing retry-language leak: generated tool-backed flows still route `ON_FAILURE` to the final step, but no longer synthesize a customer-visible `RESPOND` for that branch.
- The DELEGATE hardening slice confirms the next-step architecture decision: keep DELEGATE IR-native rather than adding a persisted `agent` tool type. Runtime now preserves typed `delegate_to_*` payloads, maps `RETURNS` from child values/state updates as well as response JSON, stores a structured delegate envelope for `USE_RESULT`, and tests that child chunks stay silent.
- The hosted fixture editor slice closes the last staticResponse editor gap: a project editor can create the hosted fixture from the same panel even when Arch never bootstrapped one, and null fixture values remain intentional data rather than falling back to previous values.
- The runtime topology-continuity slice closes the enforcement gap for authored `experienceMode`: shared-voice handoffs stay one perceived voice without a transfer line, visible/human handoffs carry a customer-visible transition, HTTP Async receives that transition as `agent.status`, streaming-text channels receive it as a chunk, and delegates remain internal/suppressed in traces.
- The continuity consumer-matrix slice locks the current channel manifest to explicit continuity consumption modes: HTTP Async receives `agent.status`, streaming channels receive streamed text, typing-only channels stay on native typing indicators, and sync/final-response channels avoid partial synthesized status text.
- The lockfile docs slice closes the operator-facing repair gap: CLI README, import guide, and export v2 format docs now point builders to `kore-platform-cli lockfile recompute` and `--check` instead of manual `abl.lock` hash edits.
- The HANDOFF return-map validation slice moves local invalid child-field mappings from warning-only diagnostics to compile errors, so Arch-generated invalid return contracts cannot silently proceed to runtime.
- The delegate auth-preflight slice closes the hidden silent-child execution gap: runtime checks the delegated target's preflight auth requirements before child stack/thread/activation/execution and traces blocked attempts as internal delegate metadata.
- The Arch model-policy topology slice closes the active fallback-path gap: deterministic topology and system-agent generation now preserve provider-neutral model-policy hints, while explicit model IDs remain resolved later through policy/catalog defaults.
- The source-grounded fixture-input slice extends scenario fixtures beyond responses: source tables can now provide per-tool JSON sample inputs, and Studio bootstrap infers common top-level request values from scenario text when explicit fixture input is absent.
- The direct-send diagnostic normalization slice broadens Slack/Messenger parity to Telegram, LINE, Instagram, Twilio SMS, Zendesk, and Microsoft Teams. Those adapters now return sanitized channel-delivery envelopes while keeping raw provider details confined to logs.
- The remaining direct-send diagnostic parity slice covers Email, AI4W async callback preparation, and WhatsApp provider implementations. Lower-volume voice/sync adapters that currently return success from `sendResponse()` still need a separate route-specific audit only if their customer-visible delivery failures are surfaced outside direct `SendResult` sends.
- The nested fixture synthesis slice closes the top-level-only bootstrap gap: Studio now walks HTTP tool object/array parameter schemas, fills nested fields from source scenario evidence, and deep-merges explicit fixture inputs over generated nested payloads.

## 11. Open Decisions

1. Should remote DELEGATE use the same IR-native path, or should cross-project/external agent invocation become a separate persisted capability?
2. Should OpenAI Responses use `previous_response_id` as the default, or preserve native item arrays for full replay/debug determinism?
3. What should the product-supported last-resort fallback be when a tenant/project has no catalog model policy, and should that fallback remain package-local or move to deployment config?
4. Should contract validation initially block imports, or run in warn mode for one release?
5. Should staticResponse JSON edits be available to all project editors or only admins/owners?
