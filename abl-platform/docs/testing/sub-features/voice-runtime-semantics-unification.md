# Test Specification: Voice Runtime Semantics Unification

**Feature Spec**: [docs/features/sub-features/voice-runtime-semantics-unification.md](../../features/sub-features/voice-runtime-semantics-unification.md)
**HLD**: [docs/specs/voice-runtime-semantics-unification.hld.md](../../specs/voice-runtime-semantics-unification.hld.md)
**LLD**: [docs/plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md](../../plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md)
**Status**: PARTIAL
**Last Updated**: 2026-04-24

---

## 1. Coverage Matrix

| FR    | Description                                                                              | Unit | Integration | E2E | Manual | Status  |
| ----- | ---------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Canonical semantic execution contract for voice turns                                    | YES  | YES         | YES | NO     | PARTIAL |
| FR-2  | Provider-native events normalize into a canonical voice event model                      | YES  | YES         | NO  | NO     | PARTIAL |
| FR-3  | Distinct pipeline vs realtime prompt profiles                                            | YES  | YES         | NO  | NO     | PARTIAL |
| FR-4  | Realtime prompt/tool surfaces use canonical runtime builders or wrappers                 | YES  | YES         | NO  | NO     | PARTIAL |
| FR-5  | DSL construct parity classification across voice families                                | YES  | YES         | NO  | NO     | PARTIAL |
| FR-6  | Explicit provider capability profiles                                                    | YES  | YES         | NO  | NO     | PARTIAL |
| FR-7  | Fail-closed or deterministic degradation for missing provider capabilities               | YES  | YES         | NO  | NO     | PARTIAL |
| FR-8  | Canonical voice turn result shape                                                        | YES  | YES         | YES | NO     | PARTIAL |
| FR-9  | Tenant / project / user isolation preserved                                              | NO   | YES         | YES | NO     | PARTIAL |
| FR-10 | Sanitized diagnostics for prompt-profile selection, capability drops, and fallback       | YES  | YES         | NO  | NO     | PARTIAL |
| FR-11 | Incremental rollout with `off` / `shadow` / `enforce` modes                              | YES  | YES         | NO  | NO     | PARTIAL |
| FR-12 | Pipeline voice remains the baseline contract with no regression while realtime converges | YES  | YES         | YES | NO     | PARTIAL |

### Current Baseline

The repository already provides a useful baseline for this feature:

- pipeline voice paths in Twilio and LiveKit already route through `executeMessage()` and `buildExecutionOutcome()`
- realtime provider adapters already emit a minimal shared event surface
- `RealtimeVoiceExecutor` already has unit/integration coverage for tool calls, transcripts, and handoffs

What is missing is explicit semantic parity coverage. Current tests prove pieces of the stack work; they do not prove that the same DSL constructs mean the same thing across pipeline voice, realtime voice, and bridge voice families.

### Current Validation Snapshot (2026-04-24)

- `pnpm build --filter=./packages/compiler --filter=./apps/runtime --filter=./packages/web-sdk` passed.
- Focused voice-runtime regression suite passed: `18` files, `317` tests.
  - Canonical/parity coverage: `channel-adapter.test.ts`, `voice-turn-coordinator.test.ts`, `live-voice-runtime-bridge.test.ts`, `channel-behavior-contract.test.ts`, `voice-dsl-parity.test.ts`
  - Realtime convergence coverage: `voice-semantic-convergence.test.ts`, `voice-prompt-profile.test.ts`, `realtime-voice-executor.test.ts`, `realtime-voice-executor-parity.test.ts`, `voice-session-resolver.test.ts`, `ws-sdk-handler.test.ts`, `ws-twilio-handler.test.ts`
  - Final delivery coverage: `channel-voice-ingress-auth.test.ts`, `channel-audiocodes-auth.test.ts`, `livekit-agent-worker.test.ts`, `livekit-llm-adapter.test.ts`, `livekit-voice.integration.test.ts`, `korevg-session-stt-model.test.ts`, `korevg-session-orpheus-streaming.test.ts`
- Bridge/public ingress E2E coverage passed: `3` files, `13` tests.
  - `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`
  - `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`
  - `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts`
- A separate slow-config rerun of `livekit-voice.integration.test.ts` was not used as closure evidence because it did not complete cleanly in local verification.
- This testing guide remains `PARTIAL` because there is still no dedicated public SDK/Twilio realtime end-to-end suite for the coordinator-tool path, and manual shadow/enforce rollout review has not been completed yet.

---

## 2. E2E Test Scenarios (MANDATORY)

### E2E-1: SDK voice pipeline preserves canonical flow-step voice semantics

- **Preconditions**: Project A has an SDK channel configured with `voicePipeline=pipeline` and an agent that uses `on_start`, flow-step `respond`, and `voice_config`.
- **Steps**:
  1. `POST /api/v1/sdk/init` with Project A's public key.
  2. Open `ws://<runtime>/ws/sdk` with the returned session token.
  3. Start a voice session and stream a caller utterance that triggers `on_start`, one flow step, and one digression.
  4. Assert final transcript and spoken response payloads.
- **Expected Result**: The session uses the canonical pipeline baseline (`executeMessage()` + outcome builder) and returns one consistent voice result shape.
- **Auth Context**: Tenant A, Project A, SDK public key, anonymous SDK end user.
- **Isolation Check**: Reuse the same session artifact with Project B's key; expect session rejection or 404-equivalent failure.

### E2E-2: SDK voice realtime preserves tool-call and handoff semantics

- **Preconditions**: Project A has an SDK channel configured with `voicePipeline=realtime` and a realtime-capable tenant model. The agent has a tool call and a handoff/delegate path.
- **Steps**:
  1. `POST /api/v1/sdk/init` for Project A.
  2. Open `ws://<runtime>/ws/sdk` and establish a realtime voice session.
  3. Stream a user utterance that triggers one tool call and then a handoff or delegate.
  4. Assert the active agent changes, tool result is acknowledged, and the final response reflects the new agent.
- **Expected Result**: Realtime voice uses the canonical prompt/tool wrapper and returns the same semantic result shape the pipeline baseline would produce, unless an explicit provider capability gate blocks a step.
- **Auth Context**: Tenant A, Project A, SDK voice session, authenticated session token.
- **Isolation Check**: Join the session from a token scoped to another project; expect close/denial without cross-project data exposure.

### E2E-3: SDK voice realtime immutable-provider path reports an explicit capability drop

- **Preconditions**: Project A uses a realtime provider that does not support mid-call prompt/tool refresh.
- **Steps**:
  1. `POST /api/v1/sdk/init` and open `ws://<runtime>/ws/sdk`.
  2. Trigger a turn that requires prompt/tool refresh after a handoff or semantic state change.
  3. Inspect returned diagnostics and final voice behavior.
- **Expected Result**: The system emits an explicit capability/fallback diagnostic and degrades deterministically; it does not silently keep using stale semantics.
- **Auth Context**: Tenant A, Project A, SDK session token.
- **Isolation Check**: Wrong tenant model or channel binding must not expose capability metadata or credentials across tenants.

### E2E-4: Twilio voice pipeline preserves `voice_config` and canonical outcome shaping

- **Preconditions**: Project A has a Twilio voice deployment configured for pipeline voice and an agent with `voice_config` on `on_start` and a flow-step branch.
- **Steps**:
  1. `POST /api/v1/voice/connect` with a valid Twilio-signed webhook for Project A.
  2. Establish the media stream on `/voice/media`.
  3. Send caller audio that triggers `on_start`, a flow step, and one call-result branch.
  4. Observe spoken text and terminal session state.
- **Expected Result**: Twilio pipeline voice uses canonical outcome shaping and voice adapter resolution; `voice_config` survives through to spoken output.
- **Auth Context**: Tenant A, Project A, Twilio HMAC-signed inbound request.
- **Isolation Check**: Wrong connection/deployment mapping returns 404-equivalent failure with no cross-project session linkage.

### E2E-5: LiveKit voice preserves canonical turn semantics while surfacing prompt-profile diagnostics

- **Preconditions**: Project A has a LiveKit-enabled voice deployment and an agent that exercises a digression or call-result branch.
- **Steps**:
  1. Provision a valid LiveKit participant token for Project A.
  2. Join the room and produce one user utterance that triggers a non-trivial branch.
  3. Inspect returned transcript, final response text, and any surfaced diagnostics.
- **Expected Result**: LiveKit continues to use canonical turn execution and surfaces which voice prompt profile was selected for the turn.
- **Auth Context**: Tenant A, Project A, LiveKit participant token.
- **Isolation Check**: Cross-project participant metadata or token mismatch is rejected before session execution.

### E2E-6: Bridge voice family honors canonical semantics for supported constructs and explicit partials for unsupported ones

- **Preconditions**: Project A has a KoreVG, AudioCodes, or VXML bridge configured with an agent that uses one supported construct and one unsupported presence-style behavior.
- **Current Evidence (2026-04-24)**: `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts`, `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`, and `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts` all passed in the latest rerun. `apps/runtime/src/__tests__/channels/channel-voice-ingress-auth.test.ts` and `apps/runtime/src/__tests__/channels/channel-audiocodes-auth.test.ts` additionally verify that VXML and AudioCodes final delivery use `voiceConfig.plain_text` rather than raw markdown. KoreVG custom S2S/realtime branches remain expected partials outside this baseline pipeline scenario.
- **Steps**:
  1. Establish the bridge session using the public bridge endpoint/connection flow for the selected family.
  2. Send one utterance that exercises a supported DSL construct and observe the rendered response.
  3. Trigger a behavior that is intentionally unsupported for that family and inspect diagnostics.
- **Expected Result**: Supported constructs produce the canonical voice outcome; unsupported semantics are explicitly partial and fail closed or degrade with diagnostics.
- **Auth Context**: Tenant A, Project A, bridge-specific token/signature/identifier.
- **Isolation Check**: Invalid bridge identifier or token returns 404/denial and does not leak session existence.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: OpenAI Realtime raw events normalize into canonical voice events

- **Boundary**: `packages/compiler` provider adapter -> normalized voice event contract
- **Setup**: Feed representative OpenAI Realtime server events including audio delta, transcript delta, transcript final, function-call completion, response completion, and interruption.
- **Expected Result**: Adapter emits legacy compatibility events plus a normalized voice event stream with explicit provider capabilities.
- **Failure Mode**: Unknown provider event types do not crash the session; they are logged or surfaced as unmapped diagnostics.

### INT-2: Gemini Live and Ultravox capability profiles remain explicit and provider-specific

- **Boundary**: realtime adapter implementations -> capability registry / normalized event layer
- **Setup**: Simulate Gemini Live and Ultravox sessions, including immutable mid-call update behavior.
- **Expected Result**: Both adapters expose explicit capability profiles and normalized events even though their native grammars differ materially.
- **Failure Mode**: Unsupported mid-call refresh operations surface deterministic capability diagnostics.

### INT-3: Prompt profile resolver derives pipeline vs realtime packaging from canonical runtime inputs

- **Boundary**: runtime session + agent IR + interaction context -> voice prompt profile
- **Setup**: Build runtime sessions for pipeline voice, realtime voice, and provider-specific partials.
- **Expected Result**: Resolver selects the correct profile, applies voice-specific rules, and keeps semantic inputs shared across modes.
- **Failure Mode**: Missing or conflicting inputs fail with sanitized diagnostics, not silently to a generic prompt.

### INT-4: Realtime voice executor refreshes prompt/tool state through canonical builders

- **Boundary**: `RealtimeVoiceExecutor` -> prompt/tool wrapper -> runtime executor
- **Setup**: Simulate a realtime handoff that requires agent/tool refresh.
- **Expected Result**: Executor requests canonical prompt/tool state and only falls back when provider capabilities explicitly prevent refresh.
- **Failure Mode**: Provider without refresh capability yields an explicit partial result rather than stale semantic behavior.

### INT-5: Voice turn coordinator returns one canonical outcome shape for pipeline and realtime turns

- **Boundary**: voice turn coordinator -> `executeMessage()` / outcome builder -> voice adapters
- **Setup**: Feed one finalized pipeline utterance and one normalized realtime utterance with equivalent DSL behavior.
- **Expected Result**: Both paths return the same semantic result structure (`response`, `voiceConfig`, `action`, diagnostics) even if transport details differ. Bridge adapters that need post-turn inspection may also consume the raw canonical `ExecutionResult` returned alongside the normalized outcome.
- **Failure Mode**: Divergence is recorded in shadow-mode diagnostics.

### INT-6: Compiler/runtime parity audit covers every in-scope voice-aware DSL construct

- **Boundary**: compiler IR lowering -> runtime semantic layer
- **Setup**: Build fixtures covering `StartConfig`, `FlowStep`, `Digression`, `SubIntent`, `ActionHandlerIR`, and `CallResultBlock` voice-aware fields.
- **Expected Result**: Every construct has an explicit parity classification by voice family and an automated regression check.
- **Failure Mode**: New construct or voice family additions fail CI until parity classification is updated.

---

## 4. Unit Test Scenarios

### UT-1: Provider capability registry

- **Module**: voice provider capability helpers
- **Input**: provider type + optional runtime override
- **Expected Output**: stable capability profile with no implicit defaults for unsupported features

### UT-2: Normalized voice event mapper

- **Module**: provider event normalization helpers
- **Input**: representative provider-native event payloads
- **Expected Output**: canonical event types and sanitized diagnostic payloads

### UT-3: Voice prompt profile resolver

- **Module**: prompt profile selection helpers
- **Input**: voice mode, agent IR hints, voice response rules, interaction context, provider capabilities
- **Expected Output**: deterministic `pipeline` or `realtime` prompt profile with the correct constraints

### UT-4: Voice turn outcome normalizer

- **Module**: voice turn coordinator / outcome shaping helpers
- **Input**: canonical execution results
- **Expected Output**: one voice result shape preserving `voiceConfig`, `action`, diagnostics, and adapted text payload

### UT-5: Construct parity matrix validator

- **Module**: voice DSL construct parity map
- **Input**: construct list + voice family rows
- **Expected Output**: complete classification with no missing family/construct combinations

---

## 5. Security & Isolation Tests

- **Cross-tenant voice bootstrap returns 404**: voice channel/session resolution must remain tenant-scoped.
- **Cross-project voice artifacts return 404 or connection denial**: session artifacts and channel IDs must not bridge across projects.
- **Cross-user SDK voice resume is rejected**: user-owned voice sessions must honor existing session-ownership checks.
- **Missing auth returns 401 / invalid signature returns denial**: SDK tokens, Twilio HMAC, and bridge tokens keep their current fail-closed behavior.
- **Diagnostics stay sanitized**: provider capabilities, prompt profile failures, and fallback reasons must not leak API keys, model IDs, or tenant-specific remediation text.
- **No capability bypass through raw provider events**: malformed or unexpected provider payloads must not trigger unscoped tool execution or stale-session reuse.

---

## 6. Performance & Load Tests (if applicable)

- Measure added normalization + prompt-profile overhead for realtime control-path turns and keep it below the agreed runtime budget.
- Measure shadow-mode divergence reporting overhead separately from enforce-mode turn latency.
- Validate that capability lookups and normalized-event emission do not introduce new external calls in the hot path.
- Validate no regression to pipeline voice latency relative to the existing Twilio/LiveKit baseline.

---

## 7. Test Infrastructure

- **Required services**: Runtime, Studio preview (optional), MongoDB, Redis, voice provider test doubles or DI seams for third-party APIs only, Twilio/LiveKit local harnesses where available
- **Data seeding**: Tenant with one pipeline-capable voice deployment, one realtime-capable voice deployment, one immutable-provider deployment, and agents covering `on_start`, digressions, handoff, delegate, and `voice_config`
- **Environment variables**: existing realtime voice credentials or provider test doubles; rollout flag values for `off`, `shadow`, and `enforce`
- **CI configuration**: separate suites for provider normalization, runtime integration, SDK voice E2E, and telephony/bridge parity tests; skip only when required external infrastructure is provably unavailable

---

## 8. Test File Mapping

| Test File                                                                              | Type               | Covers                   |
| -------------------------------------------------------------------------------------- | ------------------ | ------------------------ |
| `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts` | unit / integration | FR-2, FR-6, FR-7         |
| `packages/compiler/src/__tests__/realtime-providers.test.ts`                           | unit / integration | FR-2, FR-6               |
| `apps/runtime/src/__tests__/voice/voice-semantic-convergence.test.ts`                  | unit               | FR-6, FR-7, FR-11        |
| `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts`                        | unit / integration | FR-3, FR-4, FR-10        |
| `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts`                      | integration        | FR-1, FR-8, FR-11, FR-12 |
| `apps/runtime/src/__tests__/realtime-voice-executor.test.ts`                           | integration        | FR-4, FR-7, FR-8         |
| `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts`              | integration        | FR-4, FR-6, FR-7         |
| `apps/runtime/src/__tests__/voice/live-voice-runtime-bridge.test.ts`                   | integration        | FR-1, FR-4, FR-8         |
| `apps/runtime/src/__tests__/services/voice-session-resolver.test.ts`                   | integration        | FR-6, FR-7, FR-11        |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                           | integration        | FR-1, FR-4, FR-8, FR-9   |
| `apps/runtime/src/__tests__/channels/ws-twilio-handler.test.ts`                        | integration        | FR-1, FR-4, FR-8, FR-9   |
| `apps/runtime/src/__tests__/channels/channel-adapter.test.ts`                          | unit / integration | FR-5, FR-8               |
| `apps/runtime/src/__tests__/channels/voice-dsl-parity.test.ts`                         | unit / integration | FR-5, FR-12              |
| `apps/runtime/src/__tests__/channels/channel-voice-ingress-auth.test.ts`               | integration        | FR-8, FR-9, FR-12        |
| `apps/runtime/src/__tests__/channels/channel-audiocodes-auth.test.ts`                  | integration        | FR-8, FR-9, FR-12        |
| `apps/runtime/src/__tests__/channels/livekit-llm-adapter.test.ts`                      | integration        | FR-1, FR-8, FR-12        |
| `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`               | e2e                | FR-1, FR-8, FR-9, FR-12  |
| `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`       | e2e                | FR-1, FR-8, FR-9         |
| `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts`               | e2e                | FR-1, FR-8, FR-12        |
| `apps/runtime/src/__tests__/channels/livekit-voice.integration.test.ts`                | integration        | FR-1, FR-8, FR-12        |
| `apps/runtime/src/__tests__/korevg-session-stt-model.test.ts`                          | integration        | FR-1, FR-8, FR-12        |

---

## 9. Open Testing Questions

1. Should immutable providers such as Ultravox have a dedicated expected-partial test suite separate from the main realtime parity suite?
2. Which bridge family should be the primary E2E representative for explicit partial semantics: KoreVG, AudioCodes, or VXML?
3. Do we want shadow-mode divergence assertions in CI, or only in manual/staging validation until the coordinator is stable?
