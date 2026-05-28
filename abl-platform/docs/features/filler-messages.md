# Feature Spec: Filler Messages

**Feature slug**: filler-messages
**Status**: STABLE (Phase 1 MVP), ALPHA (Phase 2-3)
**Owner**: Platform team
**Backlog item**: #73
**Created**: 2026-03-23
**Last updated**: 2026-04-29

---

## Problem Statement

When an ABL agent processes a user request that involves tool calls, multi-step reasoning, handoffs, or entity extraction, there is a gap of 2-30 seconds where no output reaches the user. On voice channels this creates dead-air silence that causes callers to hang up. On chat/WebSocket channels the user sees only a generic typing indicator (bouncing dots) with no context about what is happening. This perceived latency degrades user experience and reduces trust in the agent.

### Impact

| Channel Family                      | Current UX During Gap | Business Impact                                   |
| ----------------------------------- | --------------------- | ------------------------------------------------- |
| **Voice** (Twilio, KoreVG, LiveKit) | Silence               | Critical -- callers hang up after 3-5s of silence |
| **Chat** (WebSocket, Web SDK)       | Bouncing dots only    | Medium -- users wonder if agent is stuck          |
| **Async** (Slack, Teams, Email)     | Expected delay        | Low -- users expect async latency                 |

### Root Cause

The `onChunk` callback in `ReasoningExecutor` streams text during LLM generation, but **between** LLM calls (during tool execution, handoffs, constraint checks), no output reaches any channel. The existing `typing_start` WebSocket event has no status text and no operation context.

---

## Scope

### In Scope (Phase 1 -- COMPLETED)

- Per-session `FillerMessageService` with delay gate, cooldown, cancel, maxPerTurn, destroy lifecycle
- Operation-aware static message pools (7 categories: tool_call, reasoning, handoff, delegation, extraction, constraint_check, general)
- Tool-name-specific messages for well-known tools (product_search, policy_search, order_lookup, etc.)
- Message dedup against recent history to avoid repetition
- WebSocket `status_update` / `status_clear` server events
- Integration with `RuntimeExecutor` trace event pipeline
- Pipeline-generated contextual fillers via parallel LLM call (best-effort, falls back to static)
- LLM-piggybacked `<status>` tag parsing from primary model stream
- `StatusTagParser` for streaming extraction of `<status>...</status>` tags across chunk boundaries
- Three filler source priority: pipeline-generated > LLM piggybacked > static fallback

Current runtime note:

- The shared prompt builder still supports piggybacked `<status>` parsing, but it no longer injects the `<status>` authoring instruction for voice channels because that prompt pattern produced poor spoken behavior in realtime S2S calls. Non-voice channels still receive the prompt instruction.

### In Scope (Phase 2 -- PLANNED)

- Voice channel adapter (TTS filler emission via KoreVG, Twilio, LiveKit)
- Voice handler `sendFiller()` / `cancelFiller()` methods with barge-in support
- Voice session registry for mapping session IDs to voice output handlers
- DSL parser for `CHANNEL_SETTINGS` section with status message configuration
- Project-level filler settings in `ProjectSettings`
- IR schema extension: `channel_settings.status_messages` on `AgentIR`

### In Scope (Phase 3 -- PLANNED)

- Web SDK `ChatClient` statusUpdate/statusClear event handling
- React `AgentProvider` exposing `statusText` state
- `ChatWidget` transient status text rendering below typing indicator
- Studio debug panel filler display
- Trace event logging for fillers (observability)

### Out of Scope

- Realtime voice mode (OpenAI Realtime / Gemini Live) filler injection -- model handles its own audio
- Custom per-tenant message pool administration UI
- A/B testing framework for filler message effectiveness
- Analytics/metrics dashboard for filler emission rates

---

## Requirements

### Functional Requirements

| ID    | Requirement                                                                                  | Priority | Phase |
| ----- | -------------------------------------------------------------------------------------------- | -------- | ----- |
| FR-1  | The system MUST emit contextual status messages during long operations (>delay threshold)    | P0       | 1     |
| FR-2  | Status messages MUST be operation-aware (tool_call, handoff, reasoning, etc.)                | P0       | 1     |
| FR-3  | Status messages MUST be transient (never persisted to conversation history)                  | P0       | 1     |
| FR-4  | If the operation completes before the delay threshold, the filler MUST be silently discarded | P0       | 1     |
| FR-5  | The system MUST support three filler sources with priority: pipeline > piggybacked > static  | P1       | 1     |
| FR-6  | Static message pools MUST avoid repeating recent messages within a session                   | P1       | 1     |
| FR-7  | The system MUST enforce a cooldown between consecutive filler emissions                      | P1       | 1     |
| FR-8  | The system MUST cap fillers per execution turn (configurable, default 5)                     | P1       | 1     |
| FR-9  | The system MUST parse `<status>` tags from LLM stream and strip them from user output        | P1       | 1     |
| FR-10 | Voice channels MUST emit fillers via TTS with barge-in support                               | P0       | 2     |
| FR-11 | Agent DSL MUST support `CHANNEL_SETTINGS.status_messages` configuration                      | P1       | 2     |
| FR-12 | Configuration resolution MUST follow agent DSL > project settings > defaults                 | P1       | 2     |
| FR-13 | Web SDK MUST expose `statusText` state and `statusUpdate`/`statusClear` events               | P1       | 3     |
| FR-14 | `ChatWidget` MUST render status text as a transient line alongside typing indicator          | P1       | 3     |

### Non-Functional Requirements

| ID    | Requirement                                                                                                                | Priority |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| NFR-1 | Filler emission adds < 1ms overhead to the execution path (timer-based, not blocking)                                      | P0       |
| NFR-2 | Pipeline filler LLM call MUST timeout after 2000ms and fail silently                                                       | P0       |
| NFR-3 | FillerMessageService MUST clean up all timers on destroy (no timer leaks)                                                  | P0       |
| NFR-4 | Static message pools incur zero LLM cost                                                                                   | P0       |
| NFR-5 | Piggybacked `<status>` tags incur zero additional LLM cost (part of existing response; prompt injection is non-voice only) | P0       |
| NFR-6 | The filler system MUST be backward compatible -- clients that don't handle `status_update` events ignore them              | P1       |

---

## User Stories

### US-1: Chat User Sees Operation Context

**As a** chat user waiting for an agent response,
**I want to** see what the agent is doing (e.g., "Searching for products..."),
**so that** I know the agent is actively working and not stuck.

**Acceptance Criteria:**

- When a tool call takes > 1.2s (default chat delay), a `status_update` WebSocket event is sent
- The status text is relevant to the operation type (not generic)
- When the response starts streaming, the status is cleared via `status_clear`
- If the tool completes within the delay, no status is shown

### US-2: Voice Caller Hears Status During Tool Execution

**As a** voice caller waiting for an agent response,
**I want to** hear a brief status message (e.g., "Let me look that up for you"),
**so that** I don't hang up thinking the call disconnected.

**Acceptance Criteria:**

- When a tool call takes > 1.2s (default voice delay), a TTS filler is played
- The caller can interrupt the filler by speaking (barge-in)
- When the real response starts, any in-progress filler TTS is cancelled

### US-3: Agent Developer Configures Filler Behavior

**As an** agent developer,
**I want to** configure filler message behavior per agent in DSL,
**so that** I can customize delays, message pools, and enable/disable fillers.

**Acceptance Criteria:**

- `CHANNEL_SETTINGS.status_messages` section in agent DSL
- Configurable: `enabled`, `delay_ms`, `chat_delay_ms`, `cooldown_ms`, `max_per_turn`
- Custom message pools per channel type (voice vs chat)
- Agent config overrides project defaults

### US-4: System Uses Contextual Pipeline Fillers

**As the** platform,
**I want to** generate context-specific filler messages from the user's query,
**so that** status messages are more relevant than generic static pools.

**Acceptance Criteria:**

- A parallel LLM call generates a query-specific filler (e.g., "Looking up red sneakers in your size...")
- Pipeline filler has highest priority over static and piggybacked
- If pipeline call times out (>2s) or fails, static pool is used as fallback
- Simple greetings (hi, hello) get `NONE` response and no filler is emitted

---

## Existing Implementation

### Phase 1 MVP (COMPLETED -- 2026-03-11)

| Component               | File                                                                           | Status |
| ----------------------- | ------------------------------------------------------------------------------ | ------ |
| Types & config          | `apps/runtime/src/services/filler/types.ts`                                    | Done   |
| FillerMessageService    | `apps/runtime/src/services/filler/filler-service.ts`                           | Done   |
| Static message pools    | `apps/runtime/src/services/filler/message-pools.ts`                            | Done   |
| Pipeline filler         | `apps/runtime/src/services/filler/pipeline-filler.ts`                          | Done   |
| Status tag parser       | `apps/runtime/src/services/filler/status-tag-parser.ts`                        | Done   |
| Barrel export           | `apps/runtime/src/services/filler/index.ts`                                    | Done   |
| WebSocket events        | `apps/runtime/src/websocket/events.ts` (statusUpdate, statusClear)             | Done   |
| Handler integration     | `apps/runtime/src/websocket/handler.ts` (status_update/clear forwarding)       | Done   |
| RuntimeExecutor wiring  | `apps/runtime/src/services/runtime-executor.ts` (trace event -> filler)        | Done   |
| Unit tests (service)    | `apps/runtime/src/__tests__/extraction/filler-service.test.ts` (15 tests)      | Done   |
| Unit tests (pools)      | `apps/runtime/src/__tests__/extraction/filler-message-pools.test.ts` (4 tests) | Done   |
| Integration tests       | `apps/runtime/src/__tests__/extraction/filler-integration.test.ts` (5 tests)   | Done   |
| Status tag parser tests | `apps/runtime/src/__tests__/status-tag-parser.test.ts` (12 tests)              | Done   |

### ABLP-710: Channel-Aware Filler Config (COMPLETED -- 2026-04-29)

Implements the bottom layer of FR-12: channel-type-aware defaults resolution. Lays manifest groundwork required by FR-10 and FR-12 higher layers (DSL and project-settings layers deferred to follow-up ABLP-7xx).

| Component                              | File                                                                            | Status |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| `ChannelFillerMode` type               | `apps/runtime/src/channels/manifest.ts`                                         | Done   |
| `fillerMode` on all 28 channels        | `apps/runtime/src/channels/manifest.ts`                                         | Done   |
| `voiceDelayMs` on `FillerConfig`       | `apps/runtime/src/services/filler/types.ts`                                     | Done   |
| `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` | `apps/runtime/src/services/filler/types.ts`                                     | Done   |
| `resolveFillerConfig` resolver         | `apps/runtime/src/services/filler/config-resolver.ts`                           | Done   |
| Barrel re-exports                      | `apps/runtime/src/services/filler/index.ts`                                     | Done   |
| RuntimeExecutor wiring                 | `apps/runtime/src/services/runtime-executor.ts` (channel-type guard + resolver) | Done   |
| Resolver contract tests (20)           | `apps/runtime/src/__tests__/extraction/filler-config-resolver.test.ts`          | Done   |
| Propagation integration tests (5)      | `apps/runtime/src/__tests__/extraction/filler-config-propagation.test.ts`       | Done   |

### Test Summary

- 61 tests total across 6 test files
- All passing as of 2026-04-29
- Coverage: service core, message selection, dedup, cooldown, maxPerTurn, pipeline priority, status tag parsing, channel-aware config resolution, config propagation into FillerMessageService behavior

---

## Dependencies

| Dependency                               | Type     | Status               |
| ---------------------------------------- | -------- | -------------------- |
| WebSocket handler trace event forwarding | Internal | Available            |
| `RuntimeExecutor` trace event pipeline   | Internal | Available            |
| Channel manifest `fillerMode` detection  | Internal | Available (ABLP-710) |
| Vercel AI SDK `generateText`             | External | Available            |
| Voice handlers (KoreVG, Twilio, LiveKit) | Internal | Phase 2              |
| DSL parser/compiler                      | Internal | Phase 2              |
| Web SDK ChatClient                       | Internal | Phase 3              |

---

## Risks & Mitigations

| Risk                                                   | Impact                  | Likelihood | Mitigation                                                          |
| ------------------------------------------------------ | ----------------------- | ---------- | ------------------------------------------------------------------- |
| LLM models don't reliably emit `<status>` tags         | Degraded filler quality | Medium     | Static pool fallback always available; three-source priority system |
| Pipeline filler LLM call adds latency                  | Slower first response   | Low        | 2s timeout, async fire-and-forget, falls back to static             |
| Filler timer leaks on abrupt session close             | Memory leak             | Low        | `destroy()` clears all timers; integrated into session cleanup      |
| Voice TTS latency makes fillers arrive too late        | Poor UX                 | Medium     | Voice delay aligned to 1.2s chat delay; barge-in support            |
| Status tag parser edge cases with non-compliant models | Garbled output          | Low        | Buffer limits, flush on stream end, graceful degradation            |
