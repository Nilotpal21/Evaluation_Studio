# LLD: Voice Runtime Semantics Unification

**Feature Spec**: `docs/features/sub-features/voice-runtime-semantics-unification.md`
**HLD**: `docs/specs/voice-runtime-semantics-unification.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-runtime-semantics-unification.md`
**Status**: IMPLEMENTED
**Date**: 2026-04-22
**Last Updated**: 2026-04-24

---

## 0. Overview / Goal

This implementation plan turns the HLD into deployable slices. The core problem is not "realtime voice is broken everywhere"; it is that voice semantics currently have two authorities:

- pipeline voice already uses canonical runtime turn execution
- realtime voice still rebuilds parts of the semantic contract inside `RealtimeVoiceExecutor`

The implementation therefore proceeds in six phases:

1. make current capabilities and parity gaps explicit,
2. normalize provider events,
3. converge prompt/tool construction,
4. wrap the existing pipeline baseline in a shared coordinator,
5. adopt the shared coordinator for realtime families,
6. bring bridge families and rollout controls to closure.

Each phase is independently deployable and testable. No phase is allowed to leave voice surfaces in a hidden mixed state without diagnostics.

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                             | Rationale                                                                                   | Alternatives Rejected                            |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D-1 | Separate provider event normalization from semantic execution                                        | Provider grammars differ too much to make raw event parity the contract                     | Force one raw event grammar across all providers |
| D-2 | Introduce a `VoicePromptProfileResolver` instead of reusing one identical prompt for all voice modes | Realtime voice needs different prompt packaging and latency constraints than pipeline voice | One universal prompt string for every voice path |
| D-3 | Treat provider capability profiles as first-class runtime inputs                                     | Explicit partials are safer than silent semantic drift                                      | Hard-coded assumptions inside handlers/executor  |
| D-4 | Keep pipeline voice as the baseline and migrate realtime toward it incrementally                     | Pipeline already proves the canonical runtime semantics path works                          | Rewrite all voice families in one flag day       |
| D-5 | Roll out with `off` / `shadow` / `enforce` modes and optional family allowlists                      | Needed for parity proof, rollback, and provider-specific cutover                            | Immediate global enablement                      |

### Key Interfaces & Types

```typescript
type VoicePromptMode = 'pipeline' | 'realtime';

interface VoiceProviderCapabilities {
  supportsPromptRefresh: boolean;
  supportsToolRefresh: boolean;
  supportsToolResultInjection: boolean;
  supportsPartialAssistantTranscript: boolean;
  supportsProviderTurnDetection: boolean;
  supportsBargeInSignal: boolean;
}

interface NormalizedVoiceEvent {
  type:
    | 'user_transcript_partial'
    | 'user_transcript_final'
    | 'assistant_transcript_partial'
    | 'assistant_transcript_final'
    | 'tool_call_requested'
    | 'turn_interrupted'
    | 'turn_completed'
    | 'provider_error';
  providerType: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

interface VoicePromptProfile {
  mode: VoicePromptMode;
  systemPrompt: string;
  tools: import('@abl/compiler/platform/llm/types.js').ToolDefinition[];
  diagnostics: string[];
}

interface VoiceTurnInput {
  sessionId: string;
  mode: VoicePromptMode;
  transcriptText?: string;
  normalizedEvents?: NormalizedVoiceEvent[];
  capabilities: VoiceProviderCapabilities;
}

interface VoiceTurnResult {
  response: string;
  voiceConfig?: import('@abl/compiler').VoiceConfigIR;
  action?: { type: string; [key: string]: unknown };
  diagnostics: Array<{ code: string; message: string }>;
}
```

### Module Boundaries

| Module                                                                                  | Responsibility                                          | Depends On                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/compiler/src/platform/llm/realtime/*`                                         | Provider event mapping + capability exposure            | provider SDKs, shared realtime types                                |
| `apps/runtime/src/services/voice/voice-provider-capabilities.ts`                        | Provider capability registry and helpers                | realtime provider types                                             |
| `apps/runtime/src/services/voice/voice-prompt-profile.ts`                               | Mode-aware prompt/tool packaging                        | runtime session, canonical prompt/tool builders                     |
| `apps/runtime/src/services/voice/voice-turn-coordinator.ts`                             | Semantic authority for voice turns                      | runtime executor, prompt profile resolver, outcome builder          |
| `apps/runtime/src/services/voice/realtime-voice-executor.ts`                            | Realtime transport orchestration and tool/result bridge | normalized events, capability registry, prompt profile, coordinator |
| `apps/runtime/src/websocket/*` voice handlers                                           | Transport bootstrap and session wiring                  | session resolver, coordinator, existing auth/ownership guards       |
| `apps/runtime/src/channels/channel-behavior-contract.ts` or sibling voice parity module | Family/construct parity visibility                      | channel families, voice construct inventory                         |

---

## 2. File-Level Change Map

### New Files

| File                                                                                   | Purpose                                                | LOC Estimate |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------ |
| `apps/runtime/src/services/voice/voice-provider-capabilities.ts`                       | Provider capability registry and helper functions      | 120          |
| `apps/runtime/src/services/voice/voice-prompt-profile.ts`                              | Resolve `pipeline` vs `realtime` prompt/tool packaging | 180          |
| `apps/runtime/src/services/voice/voice-turn-coordinator.ts`                            | Canonical semantic executor for voice turns            | 250          |
| `apps/runtime/src/services/voice/voice-dsl-parity.ts`                                  | Construct-by-family parity map and validation helpers  | 120          |
| `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts`                        | Prompt profile resolver tests                          | 180          |
| `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts`                      | Coordinator tests                                      | 220          |
| `apps/runtime/src/__tests__/channels/voice-dsl-parity.test.ts`                         | Parity-map completeness tests                          | 120          |
| `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts` | Provider event normalization and capability tests      | 220          |
| `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts`              | Realtime convergence tests                             | 220          |

### Modified Files

| File                                                               | Change Description                                                                               | Risk   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------ |
| `packages/compiler/src/platform/llm/realtime/types.ts`             | Add normalized-event and capability types/hooks with backward-compatible optional fields         | High   |
| `packages/compiler/src/platform/llm/realtime/openai-realtime.ts`   | Emit normalized events and capability profile                                                    | High   |
| `packages/compiler/src/platform/llm/realtime/gemini-live.ts`       | Emit normalized events and capability profile                                                    | High   |
| `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts` | Emit explicit immutable-provider capabilities and normalized lifecycle signals where possible    | High   |
| `apps/runtime/src/services/voice/realtime-voice-executor.ts`       | Replace local prompt/tool builders with canonical prompt-profile path                            | High   |
| `apps/runtime/src/services/voice/voice-session-resolver.ts`        | Wire capability registry and rollout mode into session construction                              | Medium |
| `apps/runtime/src/services/execution/prompt-builder.ts`            | Expose or adapt reusable voice prompt/tool wrapper inputs                                        | Medium |
| `apps/runtime/src/services/runtime-executor.ts`                    | Add `executeVoiceTurn()` or equivalent coordinator seam                                          | High   |
| `apps/runtime/src/services/channel/outcome.ts`                     | Accept or preserve coordinator diagnostics and canonical result shape                            | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                        | Adopt normalized event + coordinator path for realtime voice                                     | High   |
| `apps/runtime/src/websocket/twilio-media-handler.ts`               | Route pipeline/realtime voice branches through coordinator path                                  | High   |
| `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts`   | Preserve baseline behavior while emitting coordinator diagnostics                                | Medium |
| `apps/runtime/src/channels/channel-behavior-contract.ts`           | Reference voice parity metadata or sibling registry for explicit family/construct classification | Medium |

### Deleted Files (if any)

| File  | Reason                                     |
| ----- | ------------------------------------------ |
| `N/A` | No deletion planned in the initial rollout |

---

## 3. Implementation Phases

### Phase 1: Capability And Parity Contract

**Goal**: Make current voice-family capabilities and DSL construct parity explicit without changing user-visible runtime behavior.

**Tasks**:
Task 1.1. Add `VoiceProviderCapabilities` helpers and an explicit capability row for each realtime provider.
Task 1.2. Add `VoiceConstructParityRecord` coverage for all in-scope constructs and voice families.
Task 1.3. Extend channel/voice contract tests so new families or constructs cannot be added without parity metadata.
Task 1.4. Add docs/trace hooks that can report `working`, `partial`, or `gap` status by construct and family.

**Files Touched**:

- `packages/compiler/src/platform/llm/realtime/types.ts` - add capability types
- `apps/runtime/src/services/voice/voice-provider-capabilities.ts` - new capability registry
- `apps/runtime/src/services/voice/voice-dsl-parity.ts` - new parity registry
- `apps/runtime/src/channels/channel-behavior-contract.ts` - wire explicit parity visibility
- `apps/runtime/src/__tests__/channels/voice-dsl-parity.test.ts` - new regression coverage

**Exit Criteria**:

- [x] Every in-scope voice family and realtime provider has an explicit capability profile.
- [x] Every in-scope DSL construct has a `working`, `partial`, or `gap` classification for each voice family.
- [x] CI fails when a new provider or voice construct is added without parity metadata.
- [x] `pnpm build --filter=./packages/compiler --filter=./apps/runtime` succeeds with 0 errors.

**Test Strategy**:

- Unit: capability registry and parity matrix validation helpers
- Integration: channel contract / parity completeness tests

**Rollback**: Remove the new parity/capability registries. This phase is non-invasive and changes no user-visible runtime behavior.

---

### Phase 2: Provider Event Normalization

**Goal**: Emit canonical normalized voice events and capability metadata from realtime providers while preserving existing compatibility callbacks.

**Tasks**:
Task 2.1. Extend `RealtimeVoiceSessionEvents` with optional normalized-event emission.
Task 2.2. Add provider-specific normalization for OpenAI Realtime, Gemini Live, and Ultravox.
Task 2.3. Preserve existing `onTranscript`, `onToolCall`, `onTurnEnd`, and `onInterrupted` callbacks during migration.
Task 2.4. Add provider normalization tests for raw event -> normalized event mapping and immutable-provider capability assertions.

**Files Touched**:

- `packages/compiler/src/platform/llm/realtime/types.ts` - optional normalized event hooks
- `packages/compiler/src/platform/llm/realtime/openai-realtime.ts` - normalized mapping
- `packages/compiler/src/platform/llm/realtime/gemini-live.ts` - normalized mapping
- `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts` - capability and partial normalization behavior
- `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts` - new tests

**Exit Criteria**:

- [x] OpenAI Realtime emits normalized events for transcript, tool-call, interruption, and turn-complete paths.
- [x] Gemini Live emits normalized events and explicit capability metadata.
- [x] Ultravox emits explicit immutable-provider capabilities and deterministic partial lifecycle signals.
- [x] Existing realtime executor tests continue to pass through the compatibility callbacks.
- [x] `pnpm build --filter=./packages/compiler --filter=./apps/runtime` succeeds with 0 errors.

**Test Strategy**:

- Unit: raw provider payload normalization
- Integration: provider session compatibility with legacy callbacks preserved

**Rollback**: Ignore the optional normalized event hook and capability metadata; legacy callbacks remain intact.

---

### Phase 3: Prompt Profile Resolver And Canonical Tool Surface

**Goal**: Eliminate local prompt/tool drift in realtime voice by resolving prompt/tool state from canonical runtime builders through a voice-aware wrapper.

**Tasks**:
Task 3.1. Create `voice-prompt-profile.ts` to derive `pipeline` vs `realtime` prompt packaging from runtime session inputs.
Task 3.2. Wrap canonical `buildSystemPrompt()` and `buildTools()` so voice profiles can shorten or reshape prompts without changing semantic inputs.
Task 3.3. Refactor `RealtimeVoiceExecutor.start()` and handoff refresh paths to consume the new prompt profile.
Task 3.4. Emit explicit capability diagnostics when a provider cannot refresh prompt/tool state mid-call.

**Files Touched**:

- `apps/runtime/src/services/voice/voice-prompt-profile.ts` - new resolver
- `apps/runtime/src/services/execution/prompt-builder.ts` - reusable wrapper seams
- `apps/runtime/src/services/voice/realtime-voice-executor.ts` - replace local builders
- `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts` - prompt profile tests
- `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts` - handoff/tool refresh parity

**Exit Criteria**:

- [x] `RealtimeVoiceExecutor` no longer owns an ad hoc prompt/tool builder for providers that support canonical refresh.
- [x] Realtime handoff and tool refresh use canonical builders or emit explicit capability diagnostics.
- [x] The selected voice prompt profile is visible in diagnostics/traces.
- [x] `pnpm build --filter=./apps/runtime --filter=./packages/compiler` succeeds with 0 errors.

**Test Strategy**:

- Unit: prompt profile selection and diagnostics
- Integration: realtime handoff refresh, immutable-provider fallback behavior

**Rollback**: Gate the new resolver behind rollout mode and switch affected providers/families back to the current local builder path.

---

### Phase 4: Voice Turn Coordinator Baseline On Pipeline Voice

**Goal**: Introduce the shared semantic coordinator without changing the existing pipeline baseline behavior.

**Tasks**:
Task 4.1. Create `voice-turn-coordinator.ts` as a wrapper around `executeMessage()` and canonical outcome shaping.
Task 4.2. Route Twilio pipeline voice and LiveKit through the coordinator first, since they already approximate the target architecture.
Task 4.3. Preserve current output and transcript behavior while adding semantic diagnostics and prompt-profile tracing.
Task 4.4. Add integration tests proving no pipeline voice regression.

**Files Touched**:

- `apps/runtime/src/services/voice/voice-turn-coordinator.ts` - new coordinator
- `apps/runtime/src/services/runtime-executor.ts` - coordinator entry point or helper
- `apps/runtime/src/websocket/twilio-media-handler.ts` - pipeline path integration
- `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` - coordinator integration
- `apps/runtime/src/services/channel/outcome.ts` - accept coordinator diagnostics
- `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts` - baseline regression tests

**Exit Criteria**:

- [x] Twilio pipeline voice continues to produce the same user-visible behavior as before.
- [x] LiveKit continues to use canonical runtime semantics through the coordinator wrapper.
- [x] Coordinator emits canonical result shape and semantic diagnostics for pipeline baseline turns.
- [x] Existing pipeline voice integration suites show no regression.
- [x] `pnpm build --filter=./apps/runtime` succeeds with 0 errors.

**Test Strategy**:

- Integration: Twilio pipeline and LiveKit coordinator adoption
- Manual: compare baseline vs coordinator output for representative voice flows

**Rollback**: Switch the affected handlers back to direct `executeMessage()` + `buildExecutionOutcome()` while keeping the coordinator code dormant.

---

### Phase 5: Realtime Coordinator Adoption For SDK Voice And Twilio Realtime

**Goal**: Move supported realtime families onto the semantic coordinator while preserving explicit partials for unsupported provider capabilities.

**Tasks**:
Task 5.1. Update SDK realtime voice handling to consume normalized events, capability profiles, and coordinator results.
Task 5.2. Update Twilio realtime branch to use the same coordinator path.
Task 5.3. Route realtime tool calls and handoff state refresh through coordinator-owned semantics.
Task 5.4. Keep immutable providers explicit partials with deterministic fallback behavior and diagnostics.
Task 5.5. Add shadow-mode divergence capture for realtime voice.

**Files Touched**:

- `apps/runtime/src/websocket/sdk-handler.ts` - realtime voice adoption
- `apps/runtime/src/websocket/twilio-media-handler.ts` - realtime branch adoption
- `apps/runtime/src/services/voice/realtime-voice-executor.ts` - coordinator-owned semantic path
- `apps/runtime/src/services/voice/voice-session-resolver.ts` - rollout/capability wiring
- `apps/runtime/src/services/voice/live-voice-runtime-bridge.ts` - coordinator-tool result bridge for realtime providers
- `apps/runtime/src/__tests__/voice/live-voice-runtime-bridge.test.ts` - coordinator-tool serialization coverage
- `apps/runtime/src/__tests__/services/voice-session-resolver.test.ts` - rollout and capability wiring coverage
- `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts` - SDK realtime integration coverage
- `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts` - Twilio realtime integration coverage
- `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts` - mutable vs immutable realtime parity coverage

**Exit Criteria**:

- [x] SDK realtime voice produces canonical voice turn results for supported constructs.
- [x] Twilio realtime voice produces canonical voice turn results for supported constructs.
- [x] Immutable providers remain explicit partials with deterministic fallback or diagnostics.
- [ ] Shadow-mode divergence stays below the agreed staging threshold before any enforce cutover.
- [x] `pnpm build --filter=./apps/runtime --filter=./packages/web-sdk --filter=./packages/compiler` succeeds with 0 errors.

**Test Strategy**:

- E2E: SDK realtime voice parity and isolation
- Integration: Twilio realtime parity and fallback
- Manual/Staging: shadow-vs-enforce divergence review

**Rollback**: Remove affected families from the allowlist or set rollout mode back to `off`/`shadow`; keep legacy realtime handler path callable.

---

### Phase 6: Bridge Family Adoption, Rollout Closure, And Diagnostics

**Goal**: Bring bridge voice families into explicit semantic classification and close rollout with operator-ready diagnostics.

**Tasks**:
Task 6.1. Integrate KoreVG, AudioCodes, and VXML supported constructs through the coordinator or an explicit bridge wrapper.
Task 6.2. Document and test family-specific explicit partials (for example presence semantics or provider terminal outcome evidence).
Task 6.3. Finalize dashboards/runbooks for prompt profile, capability drops, and shadow divergence.
Task 6.4. Enable `enforce` mode family-by-family and keep any remaining partial providers/families documented.

**Files Touched**:

- `apps/runtime/src/services/channel/channel-adapter.ts` - shared voice-text shaping for bridge and realtime families
- `apps/runtime/src/routes/channel-audiocodes.ts` - bridge integration
- `apps/runtime/src/routes/channel-vxml.ts` - bridge integration
- `apps/runtime/src/services/voice/korevg/korevg-session.ts` - KoreVG final delivery alignment
- `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` - LiveKit final delivery alignment
- `apps/runtime/src/services/voice/livekit/agent-worker.ts` - LiveKit worker fallback delivery alignment
- `apps/runtime/src/channels/channel-behavior-contract.ts` - bridge delivery contract alignment
- `apps/runtime/src/services/voice/voice-dsl-parity.ts` - explicit family partial/working rationale
- `apps/runtime/src/__tests__/channels/channel-voice-ingress-auth.test.ts` - VXML/plain-text bridge regression
- `apps/runtime/src/__tests__/channels/channel-audiocodes-auth.test.ts` - AudioCodes/plain-text bridge regression
- `apps/runtime/src/__tests__/channels/livekit-llm-adapter.test.ts` - LiveKit final voice-text regression
- `apps/runtime/src/__tests__/korevg-session-stt-model.test.ts` - KoreVG final voice-text regression
- `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts` - shared bridge ingress E2E
- `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts` - AudioCodes E2E
- `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts` - KoreVG bridge/pipeline E2E
- docs and rollout notes as needed

**Exit Criteria**:

- [x] Every in-scope voice family is explicitly classified as `working`, `partial`, or `gap` with test coverage or documented rationale.
- [x] Operator documentation explains rollout, fallback, and rollback by voice family.
- [ ] `enforce` mode is enabled only for families that passed shadow-mode review.
- [x] `pnpm build --filter=./apps/runtime --filter=./packages/compiler --filter=./packages/web-sdk` succeeds with 0 errors.

**Test Strategy**:

- Integration: bridge-family semantics and diagnostics
- E2E/manual: representative telephony/bridge flows with real routing/auth surfaces
- Manual: rollout checklist and dashboard verification

**Rollback**: Remove the affected bridge family from the enforce allowlist or set global mode to `shadow` or `off`.

---

## 4. Wiring Checklist

- [x] New capability and parity helpers exported from their owning modules
- [x] `RealtimeVoiceSession` optional normalized-event hooks implemented by all supported realtime providers
- [x] `RealtimeVoiceExecutor` imports the canonical prompt-profile resolver
- [x] `VoiceTurnCoordinator` is called from pipeline voice paths before enforce rollout on realtime families
- [x] SDK websocket voice path imports and uses the coordinator/normalized event path
- [x] Twilio media handler realtime branch imports and uses the coordinator/normalized event path
- [x] LiveKit adapter imports and uses the coordinator wrapper for baseline parity diagnostics
- [x] Bridge voice handlers either call the coordinator directly or call an explicit bridge wrapper that returns the same canonical result shape
- [x] Channel outcome layer preserves coordinator diagnostics and voice result metadata
- [x] New tests are wired into the existing runtime/compiler test suites and CI targets

---

## 5. Cross-Phase Concerns

### Database Migrations

No MongoDB or SQL migration is required for the initial rollout. All phase-1 through phase-6 changes are runtime/interface level only.

### Feature Flags

- `VOICE_SEMANTIC_CONVERGENCE_MODE=off|shadow|enforce`
- `VOICE_SEMANTIC_CONVERGENCE_FAMILIES=<comma-separated family allowlist>`

Recommended rollout order:

1. `off` everywhere with capability/parity metadata only
2. `shadow` on SDK realtime voice
3. `enforce` on SDK realtime voice after shadow review
4. `shadow` then `enforce` on Twilio realtime
5. bridge families last, one family at a time

### Configuration Changes

- Runtime must read the new rollout mode and family allowlist before constructing realtime voice sessions.
- Diagnostics/observability surfaces must know whether a result came from legacy, shadow, or enforce semantics.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All phases complete with exit criteria met, except the operator-owned shadow/enforce review gate
- [x] All in-scope voice families have explicit construct parity classifications
- [x] Realtime providers emit normalized events and explicit capability profiles
- [x] Realtime prompt/tool construction converges onto canonical runtime builders or explicit wrappers
- [x] Canonical voice turn result shape is used across pipeline baseline and supported realtime families
- [ ] Shadow divergence is reviewed before any family enters `enforce`
- [ ] Dedicated public E2E scenarios for the coordinator-tool SDK/Twilio realtime lanes are implemented and passing
- [x] No regressions in existing baseline voice behavior (`pnpm build` before targeted `pnpm test`)
- [x] Feature spec and testing guide are updated with actual rollout status after implementation

---

## 6A. Post-Implementation Notes (2026-04-24)

- The original Phase 5/6 plan assumed dedicated SDK/Twilio realtime E2E files would be added immediately. The shipped implementation instead proved those paths first through focused integration coverage (`ws-sdk-handler`, `ws-twilio-handler`, `live-voice-runtime-bridge`, `realtime-voice-executor-parity`) while leaving the public E2E lane as an explicit follow-up gap.
- Bridge-family closure landed through shared final-delivery shaping rather than through a single new bridge-parity test file. VXML, AudioCodes, LiveKit final delivery, and terminal/non-streaming KoreVG delivery now all resolve spoken text through `channel-adapter.ts`.
- KoreVG remains intentionally partial for custom S2S/realtime and already-streamed token paths, because those flows can emit provider-owned chunks before final `voiceConfig` shaping is available.
- Rollout remains safe-by-default. The code path is implemented, but no family is marked ready for blanket `enforce` without a separate operator shadow review.

---

## 7. Open Questions

1. Do immutable providers need a permanent alternate semantic lane, or can they stay as explicit partials indefinitely?
2. Should bridge-family normalized events be emitted at the adapter boundary or derived from a runtime wrapper around current bridge callbacks?
3. What divergence threshold is acceptable in `shadow` before a family may move to `enforce`?
