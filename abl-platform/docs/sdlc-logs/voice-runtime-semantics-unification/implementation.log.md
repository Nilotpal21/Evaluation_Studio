# SDLC Log: voice-runtime-semantics-unification — Implementation Phase

**Feature**: voice-runtime-semantics-unification
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md`
**Date Started**: 2026-04-22
**Date Completed**: TBD

---

## Preflight

- [x] LLD file paths verified
- [x] Function signatures current for Phase 1 targets
- [x] No conflicting recent changes on exact Phase 1 target files
- Discrepancies:
  - `apps/runtime/src/services/voice/voice-provider-capabilities.ts` and `apps/runtime/src/services/voice/voice-dsl-parity.ts` do not exist yet, which matches the LLD new-file map.
  - The working tree contains unrelated untracked files outside this feature slice; they were left untouched during preflight.

## Phase Execution

### LLD Phase 1: Capability And Parity Contract

- **Status**: DONE
- **Commit**: `8c9e7da84`
- **Goal**: Make current voice-family capabilities and DSL construct parity explicit without changing user-visible runtime behavior.
- **Exit Criteria**: all met
  - explicit capability profiles added for `openai_realtime`, `gemini_live`, and `ultravox`
  - explicit parity classification added for every Phase 1 construct/family combination
  - CI-facing tests now fail when voice channels or realtime providers are added without coverage
  - `pnpm build --filter=./packages/compiler --filter=./apps/runtime` passed
- **Files Changed**: 7 (2 new runtime services, 1 new test, 4 modified files)
  - NEW: `apps/runtime/src/services/voice/voice-provider-capabilities.ts` — typed provider capability registry plus trace/helper accessors
  - NEW: `apps/runtime/src/services/voice/voice-dsl-parity.ts` — construct-by-family parity registry, coverage validation, and trace snapshot helpers
  - NEW: `apps/runtime/src/__tests__/channels/voice-dsl-parity.test.ts` — provider/parity completeness regression tests
  - MOD: `packages/compiler/src/platform/llm/realtime/types.ts` — shared capability-profile types
  - MOD: `apps/runtime/src/channels/channel-behavior-contract.ts` — explicit voice behavior-profile helpers for parity work
  - MOD: `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts` — voice behavior-profile coverage assertions
  - MOD: `docs/sdlc-logs/voice-runtime-semantics-unification/implementation.log.md` — this log
- **Validation**:
  - Build: `pnpm build --filter=./packages/compiler --filter=./apps/runtime`
  - Tests: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/channels/channel-behavior-contract.test.ts src/__tests__/channels/voice-dsl-parity.test.ts`

### LLD Phase 2: Provider Event Normalization

- **Status**: DONE
- **Commit**: `952d9e8dc`
- **Goal**: Emit canonical normalized voice events and capability metadata from realtime providers while preserving existing compatibility callbacks.
- **Exit Criteria**: all met
  - `OpenAIRealtimeSession` now emits normalized transcript, tool-call, interruption, turn-complete, and provider-error events
  - `GeminiLiveSession` now emits normalized transcript, tool-call, interruption, turn-complete, and provider-error events with explicit capability metadata
  - `UltravoxRealtimeSession` now exposes immutable capability metadata and deterministic terminal lifecycle normalization for ended/error paths
  - existing realtime executor/runtime regression suites still pass without changing their legacy callback expectations
  - `pnpm build --filter=./packages/compiler --filter=./apps/runtime` passed
- **Files Changed**: 7 (1 new compiler test, 4 modified provider/type files, 1 modified package learnings file, 1 modified log)
  - NEW: `packages/compiler/src/platform/llm/realtime/__tests__/provider-normalization.test.ts` — raw-provider normalization and compatibility callback regression coverage
  - MOD: `packages/compiler/src/platform/llm/realtime/types.ts` — normalized voice-event types, optional hook, and capability-profile accessor on realtime sessions
  - MOD: `packages/compiler/src/platform/llm/realtime/openai-realtime.ts` — normalized event emission for transcript/tool/interruption/completion/error paths
  - MOD: `packages/compiler/src/platform/llm/realtime/gemini-live.ts` — normalized event emission for transcript/tool/interruption/completion/error paths
  - MOD: `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts` — explicit immutable capability profile plus deterministic terminal lifecycle normalization
  - MOD: `packages/compiler/agents.md` — Phase 2 implementation learning
  - MOD: `docs/sdlc-logs/voice-runtime-semantics-unification/implementation.log.md` — this log
- **Validation**:
  - Build: `pnpm build --filter=./packages/compiler --filter=./apps/runtime`
  - Compiler tests: `pnpm --filter @abl/compiler exec vitest run src/platform/llm/realtime/__tests__/provider-normalization.test.ts src/__tests__/realtime-providers.test.ts src/__tests__/realtime-event-routing.test.ts src/__tests__/llm-realtime.test.ts`
  - Runtime tests: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/realtime-voice-executor.test.ts src/__tests__/execution/realtime-tool-call.test.ts src/__tests__/channels/voice-realtime-trace.test.ts`

### LLD Phase 3: Prompt Profile Resolver And Canonical Tool Surface

- **Status**: DONE
- **Commit**: `5e272ab7e`
- **Goal**: Eliminate local prompt/tool drift in realtime voice by resolving prompt/tool state from canonical runtime builders through a voice-aware wrapper.
- **Exit Criteria**: all met
  - `RealtimeVoiceExecutor` now resolves prompt/tool state through the canonical prompt builder surface instead of local ad hoc builders
  - mutable providers refresh prompt/tool state during handoff from the canonical voice prompt profile, while immutable providers emit explicit immutable diagnostics and skip unsupported refresh calls
  - selected prompt profile and refresh capability status are visible through executor diagnostics/logging
  - `pnpm build --filter=./apps/runtime --filter=./packages/compiler` passed
- **Files Changed**: 11 (2 new runtime tests, 1 new runtime service, 6 modified runtime files, 1 modified runtime learnings file, 1 modified log)
  - NEW: `apps/runtime/src/services/voice/voice-prompt-profile.ts` — canonical pipeline/realtime prompt-profile resolver with realtime shaping and capability diagnostics
  - NEW: `apps/runtime/src/__tests__/voice/voice-prompt-profile.test.ts` — prompt profile packaging and capability diagnostics tests
  - NEW: `apps/runtime/src/__tests__/voice/realtime-voice-executor-parity.test.ts` — mutable vs immutable provider handoff parity tests
  - MOD: `apps/runtime/src/services/execution/prompt-builder.ts` — exported canonical voice prompt/tool surface wrapper
  - MOD: `apps/runtime/src/services/voice/realtime-voice-executor.ts` — replaced local prompt/tool builders with the canonical voice prompt profile and capability-aware refresh behavior
  - MOD: `apps/runtime/src/services/voice/voice-session-resolver.ts` — forwards live runtime-session context into realtime executor prompt shaping
  - MOD: `apps/runtime/src/websocket/sdk-handler.ts` — passes runtime-session context into realtime voice resolution
  - MOD: `apps/runtime/src/websocket/twilio-media-handler.ts` — passes runtime-session context into realtime voice resolution
  - MOD: `apps/runtime/src/__tests__/realtime-voice-executor.test.ts` — aligned legacy executor assertions with the canonical prompt/tool surface
  - MOD: `apps/runtime/agents.md` — Phase 3 implementation learning
  - MOD: `docs/sdlc-logs/voice-runtime-semantics-unification/implementation.log.md` — this log
- **Validation**:
  - Build: `pnpm build --filter=./apps/runtime --filter=./packages/compiler`
  - Runtime prompt/executor tests: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/voice/voice-prompt-profile.test.ts src/__tests__/voice/realtime-voice-executor-parity.test.ts src/__tests__/realtime-voice-executor.test.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/routing/prompt-builder-voice.test.ts`
  - Runtime resolver test: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/services/voice-session-resolver.test.ts`

### LLD Phase 4: Voice Turn Coordinator Baseline On Pipeline Voice

- **Status**: DONE
- **Commit**: TBD
- **Goal**: Introduce the shared semantic coordinator without changing the existing pipeline baseline behavior.
- **Exit Criteria**: all met
  - Twilio pipeline voice now routes auth preflight, `executeMessage()`, and shared outcome shaping through `voice-turn-coordinator`
  - LiveKit now uses the same coordinator wrapper while preserving its existing chunk streaming/token accounting behavior
  - pipeline voice outcomes now carry explicit coordinator diagnostics for the canonical `pipeline` prompt profile
  - `pnpm build --filter=./apps/runtime` passed and the broader runtime voice matrix stayed green after the refactor
- **Files Changed**: 8 (2 new runtime files, 4 modified runtime files, 1 modified runtime learnings file, 1 modified log)
  - NEW: `apps/runtime/src/services/voice/voice-turn-coordinator.ts` — shared pipeline/realtime-ready coordinator for auth preflight, `executeMessage()`, timeout/error handling, and canonical outcome shaping
  - NEW: `apps/runtime/src/__tests__/voice/voice-turn-coordinator.test.ts` — coordinator regression tests for canonical pipeline execution and auth-preflight blocking
  - MOD: `apps/runtime/src/websocket/twilio-media-handler.ts` — Twilio pipeline voice now delegates turn execution to the coordinator
  - MOD: `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` — LiveKit pipeline voice now delegates turn execution to the coordinator
  - MOD: `apps/runtime/src/services/channel/outcome.ts` — shared outcome helpers now preserve coordinator diagnostics alongside existing session/tool/outcome diagnostics
  - MOD: `apps/runtime/src/services/channel/__tests__/outcome.test.ts` — regression coverage for preserved coordinator diagnostics
  - MOD: `apps/runtime/agents.md` — Phase 4 implementation learning
  - MOD: `docs/sdlc-logs/voice-runtime-semantics-unification/implementation.log.md` — this log
- **Validation**:
  - Audit gate: route coverage added for `runtimeSession` forwarding in `voice-session-resolver`, SDK voice start, and Twilio realtime voice start
  - Audit tests: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/services/voice-session-resolver.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/ws-twilio-handler.test.ts`
  - Broader pre-phase voice matrix: `pnpm --filter @abl/compiler exec vitest run src/platform/llm/realtime/__tests__/provider-normalization.test.ts src/__tests__/realtime-providers.test.ts src/__tests__/realtime-event-routing.test.ts src/__tests__/llm-realtime.test.ts`
  - Broader pre-phase runtime matrix: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/channels/channel-behavior-contract.test.ts src/__tests__/channels/voice-dsl-parity.test.ts src/__tests__/voice/voice-prompt-profile.test.ts src/__tests__/voice/realtime-voice-executor-parity.test.ts src/__tests__/realtime-voice-executor.test.ts src/__tests__/execution/realtime-tool-call.test.ts src/__tests__/services/voice-session-resolver.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/ws-twilio-handler.test.ts src/__tests__/channels/livekit-llm-adapter.test.ts src/__tests__/channels/livekit-voice.integration.test.ts src/__tests__/channels/voice-realtime-trace.test.ts src/__tests__/channels/voice-pipeline-trace.test.ts src/__tests__/channels/voice-mode-resolver.test.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/routing/prompt-builder-voice.test.ts src/services/channel/__tests__/outcome.test.ts`
  - Phase 4 build: `pnpm build --filter=./apps/runtime`
  - Phase 4 runtime matrix: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/channels/channel-behavior-contract.test.ts src/__tests__/channels/voice-dsl-parity.test.ts src/__tests__/voice/voice-prompt-profile.test.ts src/__tests__/voice/realtime-voice-executor-parity.test.ts src/__tests__/voice/voice-turn-coordinator.test.ts src/__tests__/realtime-voice-executor.test.ts src/__tests__/execution/realtime-tool-call.test.ts src/__tests__/services/voice-session-resolver.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/ws-twilio-handler.test.ts src/__tests__/channels/livekit-llm-adapter.test.ts src/__tests__/channels/livekit-voice.integration.test.ts src/__tests__/channels/voice-realtime-trace.test.ts src/__tests__/channels/voice-pipeline-trace.test.ts src/__tests__/channels/voice-mode-resolver.test.ts src/__tests__/routing/prompt-builder.test.ts src/__tests__/routing/prompt-builder-voice.test.ts src/services/channel/__tests__/outcome.test.ts`

## Wiring Verification

- [x] Phase 1 exports reachable from their intended runtime entry points
- [x] Parity metadata enforced in CI-facing tests
- [x] Phase 2 normalized event hooks remain additive and reachable through the existing realtime provider surfaces
- [x] Phase 3 prompt-profile resolver is wired through `voice-session-resolver` into both SDK and Twilio realtime voice paths
- [x] Phase 4 pipeline voice now routes Twilio and LiveKit through a shared `voice-turn-coordinator`

## Review Rounds

- Not started. Phases 1-4 completed as bounded contract/provider slices without the later realtime/bridge migrations.

## Acceptance Criteria

- [x] All Phase 1 exit criteria complete
- [x] All Phase 2 exit criteria complete
- [x] All Phase 3 exit criteria complete
- [x] All Phase 4 exit criteria complete
- [x] Scoped build passes for `./packages/compiler` and `./apps/runtime`
- [x] Phase 1 contract/parity tests pass
- [x] Phase 2 compiler/runtime realtime regression tests pass
- [x] Phase 3 runtime prompt/executor/resolver regression tests pass
- [x] Phase 4 runtime pipeline/coordinator regression tests pass
- [ ] Feature spec files accurate (requires later `/post-impl-sync`)

## Learnings

- Treating voice parity at the family level still needs an explicit alias story for `voice`, because that surface resolves into either pipeline or realtime behavior at runtime.
- Widening a `satisfies`-typed const map through a small helper function avoids brittle literal-union indexing errors when parity records are looked up dynamically.
- Normalized realtime provider events need to land as an additive session hook first so downstream runtime migration can subscribe to canonical events without breaking the legacy callback contract that current realtime executors still use.
- Canonical prompt/tool builders need the live `RuntimeSession` whenever voice channels want true semantic parity; the synthetic fallback is only a compatibility lane for isolated realtime executor usage where a full runtime session does not exist yet.
- A pipeline voice coordinator still needs to forward an internal chunk collector even when the caller does not expose streaming outward; LiveKit uses those collected chunks to preserve canonical response shaping and existing test expectations.
