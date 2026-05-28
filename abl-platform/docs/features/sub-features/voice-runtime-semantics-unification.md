# Feature: Voice Runtime Semantics Unification

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md) / [Channels](../channels.md)
**Status**: IMPLEMENTED
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `integrations`, `observability`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/web-sdk`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/voice-runtime-semantics-unification.md](../../testing/sub-features/voice-runtime-semantics-unification.md)
**Last Updated**: 2026-04-24

---

## 1. Introduction / Overview

### Problem Statement

The platform already describes voice channels as one semantic family in the runtime contract, but the actual execution paths are split.

- Pipeline-style voice paths already use the canonical runtime turn path: `executeMessage()` plus `buildExecutionOutcome()`.
- Realtime voice paths currently normalize provider events into a smaller abstraction and then rebuild a separate prompt/tool/runtime surface inside `RealtimeVoiceExecutor`.
- Different realtime providers expose materially different native event grammars and mid-call capabilities, so "make realtime identical to pipeline" is not a safe design goal.

The result is semantic drift. Existing DSL constructs such as `voice_config`, `on_start`, flow-step `respond`, digressions, sub-intents, call-result branches, handoff/delegate behavior, escalation, and voice-specific output shaping have a clearer baseline in pipeline voice than in realtime voice. Operators see that as "pipeline seems OK, realtime does not," even though both families are supposed to honor the same agent contract.

### Goal Statement

Create one canonical runtime semantics layer for voice turns across all voice channels while explicitly preserving provider-specific transport behavior and prompt-shaping differences. The platform should unify what DSL constructs mean in voice, not pretend that every provider emits the same raw events or should receive the same prompt format.

### Summary

Voice Runtime Semantics Unification introduces a shared semantic layer for voice execution with three explicit boundaries:

1. **Provider event normalization** for realtime providers and telephony bridges
2. **Mode-specific prompt profiles** for pipeline voice and realtime voice
3. **Canonical voice turn semantics** for DSL constructs and runtime outcomes

The feature keeps transport/media concerns in provider/channel adapters, but moves semantic ownership back into shared runtime services. Pipeline voice remains the baseline reference behavior. Realtime providers converge onto that semantic contract through normalized events, explicit provider capability profiles, and a canonical voice turn coordinator.

### Current Implementation Status (2026-04-24)

The runtime implementation for phases 1-6 is now in place.

- Pipeline voice families route finalized turns through the shared `executeVoiceTurn()` coordinator, including Twilio pipeline voice, LiveKit pipeline voice, KoreVG pipeline voice, VXML, and AudioCodes.
- SDK realtime voice and Twilio realtime voice can switch onto the coordinator-tool path when `VOICE_SEMANTIC_CONVERGENCE_MODE` is enabled for the family and the provider supports tool-result injection.
- Realtime coordinator-tool payloads now resolve spoken `response_text` through the shared channel adapter registry, so supported realtime providers honor plain-text `voiceConfig` delivery the same way pipeline voice does.
- Bridge-family final delivery now resolves `voiceConfig.plain_text` through the same adapter surface for VXML, AudioCodes, LiveKit final turns, and terminal/non-streaming KoreVG delivery.
- Providers that cannot honor the coordinator-tool contract remain explicit `partial` families on the legacy realtime path instead of silently drifting, and KoreVG custom S2S/realtime or already-streamed token paths remain accepted partials.
- The construct-by-family parity registry is now explicit in `apps/runtime/src/services/voice/voice-dsl-parity.ts`.
- Rollout remains safe-by-default: `VOICE_SEMANTIC_CONVERGENCE_MODE` defaults to `off`, and no family is force-enabled by default in repo configuration.

---

## 2. Scope

### Goals

- Define one semantic execution contract for all supported voice channel families.
- Separate raw provider events from DSL/runtime semantics through a canonical normalized voice event model.
- Support different prompt profiles for `pipeline` and `realtime` voice without forking the semantic meaning of DSL constructs.
- Converge realtime prompt/tool construction onto canonical runtime builders or a canonical voice-specific wrapper around them.
- Make provider capability gaps explicit and fail closed when a voice family cannot honor a semantic contract.
- Add a construct-by-family parity matrix so voice behavior is described as `working`, `partial`, or `gap` by design rather than by accident.
- Roll the feature out incrementally with shadow-mode diagnostics before enforce-mode cutover.

### Non-Goals (Out of Scope)

- Forcing all voice providers to emit identical raw events.
- Replacing Twilio, LiveKit, KoreVG, AudioCodes, VXML, or realtime providers with a platform-owned media stack.
- Making pipeline prompts and realtime prompts identical word-for-word.
- Adding a new agent authoring DSL in phase 1; this feature operates on existing IR/runtime seams.
- Eliminating existing voice transport differences such as provider VAD, barge-in, or telephony session closure semantics.
- Guaranteeing full parity for providers whose APIs are structurally immutable mid-call; those providers may remain explicit partials.

---

## 3. User Stories

1. As a **runtime engineer**, I want one semantic authority for voice turns so realtime providers stop re-implementing parts of the agent contract.
2. As a **voice designer**, I want existing DSL constructs such as `voice_config`, handoffs, digressions, and repairs to behave consistently across pipeline voice and realtime voice.
3. As a **platform operator**, I want capability drops and fallback decisions to be explicit in diagnostics so realtime voice issues are debuggable without source diving.
4. As a **QA engineer**, I want a parity matrix for voice families so I can tell whether a gap is intentional, partial by provider capability, or an implementation bug.
5. As an **end user**, I want voice agents to behave consistently whether I talk through SDK voice, telephony, or realtime sessions.

---

## 4. Functional Requirements

1. **FR-1**: The system must define one canonical semantic execution contract for voice turns across all supported voice channels.
2. **FR-2**: The system must map provider-native realtime events and telephony/runtime voice events into a canonical normalized voice event model before DSL construct handling.
3. **FR-3**: The system must support distinct prompt profiles for `pipeline` and `realtime` voice, with shared semantic inputs but different latency and formatting rules.
4. **FR-4**: The system must build realtime prompt and tool surfaces from canonical runtime/session builders or a canonical voice-specific wrapper around them rather than ad hoc per-provider builders.
5. **FR-5**: The system must preserve and explicitly classify DSL construct parity for `on_start`, `voice_config`, flow-step `respond`, gather prompts, digressions, sub-intents, call-result branches, handoff/delegate/return, escalation, completion, and auth/error outcomes across voice families.
6. **FR-6**: The system must represent provider capabilities explicitly, including prompt refresh, tool refresh, tool-result injection, partial assistant transcripts, provider turn detection, and interruption semantics.
7. **FR-7**: The system must fail closed or degrade deterministically when a provider capability is missing, rather than silently drifting to a reduced semantic subset.
8. **FR-8**: The system must produce one canonical voice turn result shape that preserves `response`, `voiceConfig`, `action`, diagnostics, and traceability across voice families.
9. **FR-9**: The system must preserve existing tenant, project, and user isolation guarantees and must not bypass scoped session lookup, channel lookup, or credential boundaries.
10. **FR-10**: The system must surface sanitized diagnostics for prompt-profile selection, capability gating, fallback, and parity drops without leaking credentials, model IDs, or tenant-specific remediation details.
11. **FR-11**: The system must support incremental rollout with explicit `off`, `shadow`, and `enforce` convergence modes and optional voice-family allowlists.
12. **FR-12**: The system must keep current pipeline voice behavior as the baseline contract and must not regress existing pipeline semantics while converging realtime implementations.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Existing project/deployment voice settings drive rollout and mode selection               |
| Agent lifecycle            | PRIMARY      | Voice turn semantics determine how agent IR executes on voice surfaces                    |
| Customer experience        | PRIMARY      | Users experience these semantics directly across SDK voice, telephony, and realtime voice |
| Integrations / channels    | PRIMARY      | The feature spans SDK voice, Twilio, LiveKit, KoreVG, AudioCodes, and VXML families       |
| Observability / tracing    | PRIMARY      | Prompt profile, capability gating, and parity diagnostics must be traceable               |
| Governance / controls      | SECONDARY    | Fail-closed capability handling and sanitized diagnostics are required                    |
| Enterprise / compliance    | SECONDARY    | Credential handling, transcript retention, and tenant isolation remain in force           |
| Admin / operator workflows | SECONDARY    | Operators need observability and rollout controls more than new CRUD surfaces in phase 1  |

### Related Feature Integration Matrix

| Related Feature                                                        | Relationship Type | Why It Matters                                                                                 | Key Touchpoints                                                                | Current State |
| ---------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------- |
| [Voice Capabilities](../voice-capabilities.md)                         | extends           | This is the runtime semantics layer inside the broader voice feature                           | `resolveVoiceSession`, `RealtimeVoiceExecutor`, LiveKit/Twilio/KoreVG paths    | ALPHA         |
| [Channels](../channels.md)                                             | depends on        | Voice families, ingress modes, and behavior profiles are already modeled in the channel layer  | `CHANNEL_MANIFEST`, `CHANNEL_BEHAVIOR_CONTRACT`, voice routes/handlers         | ALPHA         |
| [Conversation Behavior](conversation-behavior.md)                      | depends on        | Future authored speaking/listening behavior needs a reliable runtime vehicle on voice channels | voice capability gating, prompt shaping, resolved per-turn behavior            | PLANNED       |
| [Localized Interaction Context](localized-interaction-context.md)      | depends on        | Prompt profiles and voice semantics must consume canonical locale/language inputs              | per-turn interaction context, voice-response rules, metadata normalization     | PLANNED       |
| [Voice Analytics](../voice-analytics.md)                               | emits into        | Normalized event and capability traces should power analytics and debugging                    | voice trace events, realtime turn metrics, terminal outcome evidence           | ALPHA         |
| [ABL Contract Hardening](../abl-contract-hardening.md)                 | extends           | The feature continues the broader work of making DSL/runtime contracts explicit and testable   | fail-closed validation, parity classification, runtime contract documentation  | BETA          |
| [Omnichannel Session Continuity](../omnichannel-session-continuity.md) | shares data with  | Voice sessions still depend on canonical session identity and continuity behavior              | session linking, caller identity, session lifecycle, closure/outcome semantics | ALPHA         |

---

## 6. Design Considerations (Optional)

### 6.1 Design Principles

- **Unify semantics, not raw transport events**.
- **Prompt profiles are mode-specific by design**.
- **Provider limitations must be first-class contract inputs**.
- **Pipeline voice is the baseline reference, not a stack to be bypassed**.
- **Realtime transport optimizations are valid only if semantic behavior stays explainable**.

### 6.2 Terminology

| Term                      | Meaning                                                                                 | Owner                                  |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| Provider-native event     | Raw event grammar emitted by OpenAI Realtime, Gemini Live, Ultravox, or bridge adapters | provider/channel adapter               |
| Normalized voice event    | Canonical event shape consumed by shared voice runtime semantics                        | runtime voice layer                    |
| Voice prompt profile      | Mode-aware prompt/tool packaging for `pipeline` or `realtime` voice                     | runtime prompt layer                   |
| Voice provider capability | Explicit statement of what a provider can honor mid-session                             | provider adapter + runtime voice layer |
| Voice turn coordinator    | Shared semantic executor for voice turns and outcomes                                   | runtime voice layer                    |

### 6.3 Current Code Evidence

- `apps/runtime/src/services/voice/voice-session-resolver.ts` already centralizes pipeline vs realtime mode selection and executor construction.
- `apps/runtime/src/services/voice/voice-mode-resolver.ts` already treats deployment config, S2S provider selection, and `voice_optimized` hints as separate resolution inputs.
- `apps/runtime/src/services/voice/voice-prompt-profile.ts` and `apps/runtime/src/services/voice/realtime-voice-executor.ts` now resolve canonical voice prompt/tool state with provider-capability gating instead of rebuilding ad hoc realtime-only prompt surfaces.
- `apps/runtime/src/services/voice/voice-turn-coordinator.ts` and `apps/runtime/src/services/voice/live-voice-runtime-bridge.ts` now provide the semantic authority for pipeline and coordinator-tool realtime turns.
- `apps/runtime/src/services/channel/channel-adapter.ts`, `apps/runtime/src/routes/channel-vxml.ts`, `apps/runtime/src/routes/channel-audiocodes.ts`, `apps/runtime/src/services/voice/korevg/korevg-session.ts`, and `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` now share canonical final voice-text shaping.
- `apps/runtime/src/websocket/sdk-handler.ts` and `apps/runtime/src/websocket/twilio-media-handler.ts` wire supported realtime families into the shared coordinator-tool path.
- `apps/runtime/src/services/voice/voice-dsl-parity.ts` plus `apps/runtime/src/channels/channel-behavior-contract.ts` now provide the explicit construct/family parity and channel delivery contract.
- `packages/compiler/src/platform/llm/realtime/types.ts` still deliberately exposes a minimal shared realtime session interface; provider differences are carried through normalized events and capability profiles rather than widening the transport contract.

---

## 7. Technical Considerations (Optional)

### 7.1 Architectural Direction

The platform should converge on four explicit layers for voice execution:

1. **Transport / media layer**: audio frames, VAD, interruption, telephony/session lifecycle, provider socket APIs
2. **Provider event normalization layer**: canonical normalized voice events plus explicit capability metadata
3. **Semantic turn layer**: canonical handling of DSL constructs and runtime outcomes
4. **Rendering / delivery layer**: channel adapters and provider-specific audio/text output shaping

### 7.2 Shipped Runtime Additions

- A canonical normalized voice event type for realtime and telephony-adjacent voice flows
- A `VoiceProviderCapabilities` contract for realtime and bridge families
- A `VoicePromptProfileResolver` that derives prompt packaging from common runtime semantics
- A `VoiceTurnCoordinator` / `executeVoiceTurn()` entry point that acts as the semantic authority for voice turns
- Shared channel-adapter voice-text resolution for coordinator-tool realtime, LiveKit, VXML, AudioCodes, and terminal KoreVG delivery
- Shadow-mode divergence diagnostics so rollout can compare old vs new semantics before cutover

### 7.3 Boundary Decisions

- Existing `voice_config` and `voice_response_rules` remain the source material; this feature changes execution semantics, not authoring ownership.
- Provider prompts may differ in wording and brevity between pipeline and realtime modes, but they must still be derived from one canonical semantic input set.
- Providers that cannot update prompt/tools or accept server-side tool results mid-call remain explicit partials until a dedicated immutable-session path exists.

---

## 8. How to Consume

### Studio UI

Phase 1 introduces no new top-level Studio authoring surface. Users consume the feature indirectly through existing voice-related surfaces:

- deployment/channel voice mode settings (`voicePipeline`)
- tenant voice model configuration and provider credentials
- Preview / observability / transcript surfaces that surface parity diagnostics and capability drops

Future Studio work may add explicit parity and capability diagnostics in deployment voice settings, but the initial feature is runtime-first.

### Surface Semantics Matrix

| Asset / Entity Type          | Source of Truth / Ownership            | Design-Time Surface(s)                                    | Editable or Read-Only? | Consumer Reference / Binding Model                        | Runtime Materialization / Resolution                                 | Notes / Unsupported State                           |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------- | ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Provider-native voice events | realtime provider or telephony adapter | none; derived from provider/session implementation        | Read-only              | `RealtimeVoiceSession` and bridge adapter callbacks       | normalized voice events                                              | Raw event grammars intentionally differ by provider |
| Voice prompt profile         | runtime prompt resolver                | deployment voice mode, agent hints, behavior/profile data | Partially editable     | selected by voice mode + provider capability              | `pipeline` or `realtime` prompt profile with provider-aware variants | Profiles are not guaranteed to be text-identical    |
| Provider capability profile  | provider adapter + runtime registry    | diagnostics / observability only in phase 1               | Read-only              | resolved by provider type and session mode                | capability-gated semantic execution                                  | Some providers remain explicit partials             |
| Canonical voice turn result  | runtime semantic executor              | none                                                      | Read-only              | returned to channel outcome layer and audio/text adapters | `response`, `voiceConfig`, `action`, diagnostics, trace metadata     | Existing pipeline voice is the baseline             |

### Design-Time vs Runtime Behavior

- **Design-time**: authors continue using existing voice-related inputs such as `voice_config`, `voice_response_rules`, deployment/channel `voicePipeline`, and agent `voice_optimized` hints.
- **Runtime**: mode resolution selects pipeline or realtime, provider events are normalized, provider capabilities are resolved, a voice prompt profile is chosen, and one canonical semantic layer produces the voice turn outcome.
- **Control-plane vs data-plane**: the feature does not add a new persistent authoring model in phase 1. It strengthens the runtime meaning of already-authored data.

### API (Runtime)

No new external runtime endpoint is required in phase 1. The feature changes the semantics behind existing voice surfaces.

| Method | Path                                              | Purpose                                                                                     |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| WS     | `/ws/sdk`                                         | SDK voice sessions consume the converged prompt-profile and semantic turn logic             |
| POST   | `/api/v1/voice/connect`                           | Twilio call bootstrap resolves pipeline vs realtime voice semantics                         |
| WS     | `/voice/media`                                    | Twilio media stream carries pipeline or realtime voice turns into the shared semantic layer |
| POST   | `/api/v1/channels/vxml/hooks/:streamId`           | Sync voice bridge consumes canonical voice output shaping                                   |
| POST   | `/api/v1/channels/audiocodes/webhook/:identifier` | AudioCodes bootstrap participates in the same voice-family semantic contract                |

### API (Studio)

No new Studio API route is required in phase 1. Existing deployment, preview, and observability surfaces remain the control-plane entry points.

### Admin Portal

No dedicated admin workflow is added in phase 1. Existing voice model/provider configuration remains the administrative dependency for realtime voice behavior.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is voice-specific. It applies to:

- SDK voice surfaces: `voice`, `voice_pipeline`, `voice_realtime`
- telephony/bridge voice surfaces: `voice_twilio`, `korevg`, `audiocodes`, `voice_vxml`
- LiveKit voice surface: `voice_livekit`

It does not introduce new behavior for A2A or MCP directly, although the general contract discipline mirrors recent cross-channel parity work.

---

## 9. Data Model

### Collections / Tables

The initial rollout requires no new MongoDB collection or SQL table. It reuses existing voice- and session-related records plus new in-memory runtime structures.

```text
Collection: SDKChannel / channel connection records (existing)
Fields:
  - tenantId: string
  - projectId: string
  - config.voicePipeline: 'pipeline' | 'realtime' | 'auto'
Used for:
  - voice mode resolution in `resolveVoiceSession()`

Collection: TenantModel (existing)
Fields:
  - tenantId: string
  - modelId: string
  - capabilities: string[]
  - connections[].encryptedApiKey: string
  - realtimeConfig: object
Used for:
  - realtime provider selection, credentials, and session config

Session state: RuntimeSession / SessionService / ConversationStore (existing)
Fields:
  - id: string
  - agentIR: object
  - callerContext: object
  - data.values: object
  - tracer: object
Planned in-memory-only additions:
  - voice.promptProfile
  - voice.providerCapabilities
  - voice.semanticDiagnostics
```

### Key Relationships

- channel/deployment voice settings influence `resolveVoiceMode()`
- tenant voice model state influences realtime provider and session config
- provider capability profile influences prompt refresh, tool refresh, and fallback behavior
- canonical voice turn outcome flows into channel outcome normalization and voice adapters

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                               | Purpose                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/runtime/src/services/voice/voice-session-resolver.ts`        | Current mode resolver and realtime executor bootstrap                |
| `apps/runtime/src/services/voice/voice-mode-resolver.ts`           | Existing voice mode priority chain                                   |
| `apps/runtime/src/services/voice/voice-provider-capabilities.ts`   | Explicit realtime capability profiles by provider                    |
| `apps/runtime/src/services/voice/voice-prompt-profile.ts`          | Canonical pipeline vs realtime prompt/tool packaging                 |
| `apps/runtime/src/services/voice/voice-turn-coordinator.ts`        | Canonical semantic executor for voice turns                          |
| `apps/runtime/src/services/voice/realtime-voice-executor.ts`       | Realtime transport orchestration on top of canonical voice semantics |
| `apps/runtime/src/services/voice/voice-dsl-parity.ts`              | Construct-by-family parity registry and rationale                    |
| `apps/runtime/src/services/execution/prompt-builder.ts`            | Canonical runtime prompt and tool builders                           |
| `apps/runtime/src/services/runtime-executor.ts`                    | Canonical turn execution and realtime tool execution entry points    |
| `apps/runtime/src/services/channel/outcome.ts`                     | Canonical channel outcome normalization                              |
| `apps/runtime/src/services/channel/channel-adapter.ts`             | Voice output shaping by engine/channel                               |
| `packages/compiler/src/platform/llm/realtime/types.ts`             | Shared realtime session contract and event surface                   |
| `packages/compiler/src/platform/llm/realtime/openai-realtime.ts`   | OpenAI Realtime provider event mapping                               |
| `packages/compiler/src/platform/llm/realtime/gemini-live.ts`       | Gemini Live provider event mapping                                   |
| `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts` | Ultravox provider capability edge case (immutable mid-call state)    |
| `packages/compiler/src/platform/ir/schema.ts`                      | Existing voice-related DSL/IR ownership points                       |
| `packages/compiler/src/platform/ir/compiler.ts`                    | Lowering of voice-related DSL constructs into IR                     |

### Routes / Handlers

| File                                                             | Purpose                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/runtime/src/websocket/sdk-handler.ts`                      | SDK voice transport integration and realtime executor wiring              |
| `apps/runtime/src/websocket/twilio-media-handler.ts`             | Twilio media path for pipeline and realtime voice                         |
| `apps/runtime/src/services/voice/live-voice-runtime-bridge.ts`   | Coordinator-tool bridge between canonical outcomes and realtime providers |
| `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` | LiveKit voice path that already uses canonical turn execution             |
| `apps/runtime/src/services/voice/livekit/agent-worker.ts`        | LiveKit worker fallback delivery path for final voice output              |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`       | KoreVG pipeline turn handling and final speech delivery                   |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts`        | Voice bridge family integration point                                     |
| `apps/runtime/src/routes/channel-vxml.ts`                        | Sync voice bridge routing                                                 |
| `apps/runtime/src/routes/channel-audiocodes.ts`                  | AudioCodes bridge routing                                                 |

### UI Components

| File                                        | Purpose                                                       |
| ------------------------------------------- | ------------------------------------------------------------- |
| `apps/studio/src/app/preview/page.tsx`      | Existing Preview surface for SDK/session behavior diagnostics |
| `packages/web-sdk/src/voice/VoiceClient.ts` | SDK voice client surface and transcript/event handling        |

### Jobs / Workers / Background Processes

| File  | Purpose                                          |
| ----- | ------------------------------------------------ |
| `N/A` | No new background worker is required for phase 1 |

### Tests

| File                                                                                   | Type               | Coverage Focus                                                  |
| -------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts`                        | integration        | prompt profile selection and capability gating                  |
| `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts`                      | integration        | canonical semantic turn execution                               |
| `apps/runtime/src/__tests__/voice/realtime-voice-executor.test.ts`                     | integration        | realtime convergence on canonical prompt/tool/outcome semantics |
| `apps/runtime/src/__tests__/voice/live-voice-runtime-bridge.test.ts`                   | integration        | coordinator-tool result serialization and channel context       |
| `apps/runtime/src/__tests__/channels/channel-adapter.test.ts`                          | unit / integration | shared voice-text adapter resolution                            |
| `apps/runtime/src/__tests__/channels/voice-dsl-parity.test.ts`                         | unit / integration | construct-by-family parity matrix                               |
| `apps/runtime/src/__tests__/channels/channel-voice-ingress-auth.test.ts`               | integration        | VXML/plain-text bridge delivery regression                      |
| `apps/runtime/src/__tests__/channels/channel-audiocodes-auth.test.ts`                  | integration        | AudioCodes/plain-text bridge delivery regression                |
| `apps/runtime/src/__tests__/channels/livekit-llm-adapter.test.ts`                      | integration        | LiveKit final voice-text delivery and runtime coordination      |
| `apps/runtime/src/__tests__/korevg-session-stt-model.test.ts`                          | integration        | KoreVG final speech delivery and trace preservation             |
| `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts` | unit / integration | normalized provider event mapping and capability profiles       |
| `packages/compiler/src/__tests__/realtime-providers.test.ts`                           | unit / integration | provider capability/profile regression coverage                 |

---

## 11. Configuration

### Environment Variables

| Variable                              | Default | Description                                                      |
| ------------------------------------- | ------- | ---------------------------------------------------------------- |
| `REALTIME_VOICE_ENABLED`              | `true`  | Existing realtime voice kill switch used by `resolveVoiceMode()` |
| `VOICE_SEMANTIC_CONVERGENCE_MODE`     | `off`   | Rollout mode: `off`, `shadow`, or `enforce`                      |
| `VOICE_SEMANTIC_CONVERGENCE_FAMILIES` | empty   | Optional allowlist for per-family convergence rollout            |

### Runtime Configuration

- Existing:
  - deployment/channel `voicePipeline`
  - deployment/provider selection (`s2s:*` providers and tenant realtime models)
  - agent `execution.hints.voice_optimized`
  - tenant voice `realtimeConfig`
- Implemented:
  - voice semantic convergence rollout mode
  - optional per-family allowlist
  - prompt-profile and capability diagnostics for shadow / enforce review

### DSL / Agent IR / Schema

This feature does not introduce new authoring syntax in phase 1. It changes how existing voice-related runtime inputs are executed:

- `execution.hints.voice_optimized`
- `identity.voice_response_rules`
- `StartConfig.voice_config`
- `FlowStep.voice_config`
- `Digression.voice_config`
- `SubIntent.voice_config`
- `ActionHandlerIR.voice_config`
- `CallResultBlock.voice_config`

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Project isolation | Every project-scoped read/write must include `projectId` and cross-project access must return 404.      |
| Tenant isolation  | Every tenant-scoped read/write must include `tenantId` and cross-tenant access must return 404.         |
| User isolation    | User-owned resources must be filtered by `createdBy` / `ownerId` and cross-user access must return 404. |

### Security & Compliance

- Voice model credentials remain tenant-scoped and encrypted at rest.
- Provider payloads and runtime diagnostics must be sanitized before they reach user-visible surfaces.
- Capability gating must not leak internal provider limitations as raw exception strings.
- Transcript and trace capture remain subject to existing retention, masking, and compliance rules.

### Performance & Scalability

- Added normalization and prompt-profile work must stay on the in-memory hot path and avoid new network calls during turn execution.
- Realtime voice convergence must keep latency-sensitive work bounded and must not turn provider event handling into a pipeline-style batch path.
- Capability lookups should be static or cached per provider/session rather than recomputed expensively per event.

### Reliability & Failure Modes

- Missing provider capabilities must trigger deterministic fallback or explicit partial behavior, never silent drift.
- Provider disconnects and invalid realtime session states must preserve pipeline fallback where the current channel semantics allow it.
- Shadow rollout must be able to compare old vs new semantics without changing user-visible output.

### Observability

- Trace events should capture normalized voice events, prompt profile selection, provider capability profile, and fallback reasons.
- Metrics should distinguish pipeline baseline behavior from realtime convergence behavior.
- Operators should be able to see when a provider stayed partial by design versus when the runtime failed unexpectedly.

### Data Lifecycle

- Phase 1 adds no new durable data store.
- Existing session, transcript, and trace retention policies remain the source of truth.
- Any shadow-mode divergence artifacts should follow the same TTL and masking discipline as other diagnostic traces.

---

## 13. Delivery Plan / Work Breakdown

1. Define the canonical voice semantic contract.
   1.1 Inventory DSL constructs and current behavior by voice family.
   1.2 Add explicit provider capability profiles and construct parity classification.
   1.3 Add contract tests so voice-family drift is visible in CI.
2. Normalize realtime and bridge event inputs.
   2.1 Introduce a canonical normalized voice event model.
   2.2 Update realtime provider adapters to emit normalized events and capability metadata.
   2.3 Preserve compatibility wrappers for existing handlers during rollout.
3. Converge prompt and tool surfaces.
   3.1 Introduce a `VoicePromptProfileResolver` for pipeline vs realtime voice.
   3.2 Refactor realtime prompt/tool construction onto canonical runtime builders or wrappers.
   3.3 Add explicit capability gating for providers that cannot refresh prompt/tool state mid-call.
4. Introduce the shared voice semantic executor.
   4.1 Add a `VoiceTurnCoordinator` or `executeVoiceTurn()` entry point.
   4.2 Route pipeline and realtime voice families through the shared semantic result shape.
   4.3 Reuse canonical outcome shaping and voice adapters for final delivery.
5. Roll out safely with diagnostics and tests.
   5.1 Add `off` / `shadow` / `enforce` rollout controls.
   5.2 Add parity diagnostics, divergence traces, and operator-facing evidence.
   5.3 Add unit, integration, and E2E coverage across SDK voice, telephony, and realtime providers.

---

## 14. Success Metrics

| Metric                                                    | Baseline           | Target                                                                                                                        | How Measured                                                |
| --------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Voice DSL constructs with explicit parity classification  | Ad hoc, incomplete | 100% of in-scope constructs classified by voice family                                                                        | parity matrix and CI contract tests                         |
| Realtime providers using canonical prompt/tool resolution | 0 providers        | All supported providers resolve through canonical prompt-profile path; immutable providers are explicitly classified partials | runtime integration tests and diagnostics                   |
| Implicit provider capability drops                        | Unclassified       | 0 implicit drops in enforce mode                                                                                              | shadow/enforce divergence traces                            |
| Pipeline voice regressions during convergence             | Unknown            | 0 regressions                                                                                                                 | existing pipeline voice integration/E2E suites              |
| Voice-family outcome shape consistency                    | Partial            | All in-scope voice families return canonical voice turn diagnostics and outcome metadata                                      | integration tests across SDK/Twilio/LiveKit/bridge families |

---

## 15. Open Questions

1. Should immutable providers such as Ultravox remain permanent explicit partials, or should the platform grow a separate immutable-session semantic lane for them?
2. Should provider capability profiles be static code contracts, runtime-discovered metadata, or a hybrid?
3. How much provider-specific prompt specialization is acceptable before the semantic layer starts drifting again?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                    | Severity | Status           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------- |
| GAP-001 | Canonical prompt/tool resolution for supported realtime families is now wired through `voice-prompt-profile.ts` and the shared coordinator-tool path.                                                                          | High     | Mitigated        |
| GAP-002 | `RealtimeVoiceSession` remains intentionally thin; provider differences are carried by normalized events and capability profiles rather than by widening the transport interface.                                              | Medium   | Accepted partial |
| GAP-003 | Bridge-family final delivery is now canonical for VXML, AudioCodes, LiveKit final turns, and terminal/non-streaming KoreVG delivery, but KoreVG custom S2S/realtime and already-streamed token paths remain explicit partials. | Medium   | Accepted partial |
| GAP-004 | The construct-by-family parity matrix is now explicit in `voice-dsl-parity.ts` and enforced by regression tests.                                                                                                               | High     | Mitigated        |
| GAP-005 | Prompt-profile selection is now explicit in `voice-prompt-profile.ts`, coordinator diagnostics, and realtime parity coverage.                                                                                                  | Medium   | Mitigated        |
| GAP-006 | Dedicated public E2E coverage for SDK/Twilio coordinator-tool realtime paths is still missing; current proof remains integration-first.                                                                                        | Medium   | Open             |
| GAP-007 | Shadow/enforce rollout review remains an operator step and has not been recorded as completed in this repo.                                                                                                                    | Medium   | Open             |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                        | Coverage Type        | Status      | Test File / Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider events normalize into canonical voice events with capability metadata                  | integration          | IMPLEMENTED | `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts`, `packages/compiler/src/__tests__/realtime-providers.test.ts`                                                                                                                                                                                                                                                                                                                                                 |
| 2   | Prompt profile resolver chooses pipeline vs realtime packaging deterministically                | integration          | IMPLEMENTED | `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3   | Realtime voice executor uses canonical prompt/tool wrappers and emits explicit capability drops | integration          | IMPLEMENTED | `apps/runtime/src/__tests__/realtime-voice-executor.test.ts`, `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts`                                                                                                                                                                                                                                                                                                                                                              |
| 4   | Canonical voice turn coordinator preserves existing pipeline semantics                          | integration          | IMPLEMENTED | `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | SDK voice, Twilio, LiveKit, and bridge families surface consistent voice outcomes               | e2e / integration    | PARTIAL     | `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`, `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts`, `apps/runtime/src/__tests__/channels/livekit-voice.integration.test.ts`, `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`, `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`, `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts`; dedicated SDK/Twilio realtime public E2E still pending |
| 6   | Shadow vs enforce rollout reports divergence without changing baseline output                   | manual / integration | PARTIAL     | rollout validation remains an operator follow-up; unit/integration coverage exists for mode gating, but a documented shadow/enforce review has not been checked off yet                                                                                                                                                                                                                                                                                                                              |

### Testing Notes

Current evidence now shows the canonical voice-turn coordinator and shared adapter surface are the semantic authority for pipeline voice, supported coordinator-tool realtime voice, and bridge final delivery. The remaining test burden is therefore:

- proving no pipeline regression
- keeping provider capability gaps explicit on immutable or unsupported realtime providers
- validating dedicated public E2E coverage for coordinator-tool SDK/Twilio realtime flows
- treating KoreVG bridge convergence as two separate lanes: the pipeline/final-delivery path is now canonical, while the provider-owned S2S/realtime branches remain documented partials until they can be migrated safely

> Full testing details: [docs/testing/sub-features/voice-runtime-semantics-unification.md](../../testing/sub-features/voice-runtime-semantics-unification.md)

---

## 18. References

- Design docs: `docs/specs/voice-runtime-semantics-unification.hld.md`, `docs/plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md`
- Existing rollout / parity docs: `docs/plans/2026-03-29-runtime-channel-contract-rollout.md`, `docs/plans/2026-03-31-channel-parity-matrix.md`
- Reference docs: `docs/feature-matrix.md`, `docs/enterprise-readiness.md`
- Related feature docs: [Voice Capabilities](../voice-capabilities.md), [Channels](../channels.md), [Conversation Behavior](conversation-behavior.md), [Voice Analytics](../voice-analytics.md)
