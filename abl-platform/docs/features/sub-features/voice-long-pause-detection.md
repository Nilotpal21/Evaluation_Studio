# Feature: Voice Long-Pause Detection & Proactive Reprompt

**Doc Type**: SUB-FEATURE
**Parent Feature**: [voice-capabilities.md](../voice-capabilities.md)
**Status**: PLANNED
**Feature Area(s)**: `customer experience`, `agent lifecycle`, `integrations`, `observability`
**Package(s)**: `apps/runtime`, `packages/compiler`, `apps/studio`
**Owner(s)**: Voice runtime team
**Testing Guide**: [../../testing/sub-features/voice-long-pause-detection.md](../../testing/sub-features/voice-long-pause-detection.md)
**Last Updated**: 2026-05-14
**JIRA**: [ABLP-665](https://kore-ai.atlassian.net/browse/ABLP-665)

---

## 1. Introduction / Overview

### Problem Statement

In voice conversations, users sometimes fall silent for extended periods (10+ seconds) after the bot finishes speaking — they may be thinking, distracted, looking up information, or have effectively disengaged. Today the platform has **no first-class long-pause handler**:

- **AudioCodes** has a single hardcoded English fallback at `apps/runtime/src/routes/channel-audiocodes.ts:316-321` ("Are you still there? Please say something or press a key.") triggered by an externally-sourced `noInput` event — not a platform-driven timer, not configurable, not localized, not author-controlled.
- **Twilio Media Streams** (`apps/runtime/src/websocket/twilio-media-handler.ts`) only tracks an EOU (end-of-utterance) silence timer at 1500 ms — useful for endpointing, but it has no notion of a longer "user disengaged" pause.
- **KoreVG** tracks silence/processing/speaking durations as Metric 205 analytics (`apps/runtime/src/services/voice/korevg/korevg-session.ts:421-431,439`) but never triggers any action.
- **LiveKit** captures speech start/stop timestamps (`apps/runtime/src/services/voice/livekit/agent-worker.ts:772-779`) for analytics only.
- **VXML** legacy transports may provide a `noinput` event but lack reliable speech-start signals — best-effort coverage only (see §8 channel table and GAP-004).

Author intent expressed in the `ConversationListeningIR.on_pause` field (`packages/compiler/src/platform/ir/schema.ts:545-551`) is reserved for **brief endpointing pauses** (~800/1500/2500 ms via `parsePauseTimeoutMs` in `apps/runtime/src/services/execution/conversation-behavior-resolver.ts:26,268,573`) and is **not** a long-pause hook.

Result: voice agents cannot proactively re-engage silent users in a consistent, configurable, localized, observable way across channels.

### Goal Statement

Introduce a unified, channel-agnostic **long-pause detection and proactive reprompt** capability for voice channels: a configurable per-conversation timer that, after a sustained user silence following the bot's last utterance, fires a templated reprompt (hook-driven, sub-100 ms, no LLM) or a synthetic system turn (agent-driven) with a bounded retry budget and a terminal action when the budget is exhausted. The behavior must be authored in `ConversationListeningIR.on_long_pause`, emit `TraceEvent`s, surface a new analytics metric, and degrade gracefully across all four voice transports (AudioCodes, Twilio Media Streams, KoreVG, LiveKit, VXML where applicable).

### Summary

When the user stays silent for a configured duration (`long_pause_ms`, default **10 000 ms**) after the bot finishes speaking, the runtime fires a long-pause action chosen by the author in IR:

1. **Hook-driven reprompt** (default): a templated utterance is rendered locally (locale-aware), sent through the same TTS path as a normal bot turn, with no LLM round-trip — kept sub-100 ms.
2. **Agent-driven reprompt**: a synthetic system utterance is fed back through `executeVoiceTurn`, letting the agent generate context-aware re-engagement language.

The timer is armed on every bot-utterance completion, canceled on any user speech-start (or barge-in), and respects a `retries` budget. When the budget is exhausted, a `terminal` action runs (configurable: hang-up, transfer-to-human, or final closing utterance).

Implementation lives on a per-connection `InactivityMonitor` helper colocated with each voice transport's session object — **NOT** in the stateless agent DSL runtime, **NOT** in the workflow engine. This preserves Core Invariant #4 (stateless agent runtime); long-pause is a transport-level concern, not a durable async pattern.

---

## 2. Scope

### Goals

- Detect user inactivity exceeding a configurable threshold (default **10 s**) after the bot's last utterance ends, across all voice transports.
- Provide an authored IR contract (`ConversationListeningIR.on_long_pause`) with a sane shape: `{ template?, long_pause_ms?, retries?, terminal?, enabled?, locale_variants? }`.
- Default to a hook-driven reprompt path (templated, sub-100 ms, no LLM) with an opt-in agent-driven path.
- Support locale-aware reprompt text via `locale_variants: Record<string, string>` map, falling back to `template` then a project-level default.
- Bound retries with a default `retries: 1` and a configurable `terminal` action (hang-up | transfer | final-utterance) when the budget is exhausted.
- Cancel the timer on user speech start, barge-in, ASR partial, DTMF, or session teardown.
- Emit `TraceEvent`s: `voice.long_pause.timer_armed`, `voice.long_pause.canceled`, `voice.long_pause.fired`, `voice.long_pause.reprompt_sent`, `voice.long_pause.retry_budget_exhausted`.
- Surface a new analytics metric — **Metric 211: Long Pause / User Disengagement Rate** — distinct from existing Metric 205 (silence duration).
- Provide a backwards-compatible AudioCodes migration path (3 phases: integrate → deprecate hardcoded fallback → remove fallback).
- Stay strictly within the **stateless agent runtime** invariant: timers live on per-connection session objects, never in agent IR execution or workflow state.

### Non-Goals (Out of Scope)

- Replacing or extending the EOU (end-of-utterance) endpointing timer — long-pause is layered on top, with strict threshold inversion (`long_pause_ms > end_of_utterance_ms`).
- Replacing the session-level inactivity / `expiresSeconds` timeout — these remain orthogonal upper bounds.
- Voice activity detection (VAD) algorithm changes — we consume existing transport-emitted speech events.
- Cross-session correlation, sentiment analysis, or LLM-driven disengagement classification — out of scope for v1.
- Text channels (chat, SMS, A2A) — long-pause semantics are voice-specific; text uses the existing session-timeout pattern.
- Workflow-engine long-running waits — out of scope by design (Core Invariant #4).
- Author-time UX in Studio beyond surfacing the new IR field — a richer designer experience is a follow-up.

---

## 3. User Stories

1. As an **agent author**, I want to configure "if the user is silent for 10 seconds, say 'Are you still with me?'" once in my agent IR, so that the platform handles re-engagement consistently across every voice transport without me writing per-channel code.
2. As an **agent author**, I want to provide locale variants for the reprompt text (`en-US`, `es-ES`, `de-DE`, etc.) so that a single configuration serves multilingual voice traffic.
3. As an **agent author**, I want to bound how many times the bot reprompts before giving up and either ending the call, transferring, or playing a final closing line, so that silent or disconnected users don't loop indefinitely.
4. As an **agent author**, I want to disable long-pause reprompts entirely for a specific node (e.g., during a long-form data-entry IVR) via `enabled: false`, without removing the field or losing the project default.
5. As an **agent author**, I want the option to let the agent generate the reprompt with full conversation context (agent-driven) instead of using a templated string (hook-driven), when contextual phrasing matters.
6. As a **support engineer**, I want every long-pause event traced (armed / canceled / fired / sent / exhausted) with the session/conversation IDs, so that I can debug "the bot interrupted the user" vs "the bot never reprompted" tickets from production sessions.
7. As an **observability owner**, I want a Long Pause / User Disengagement Rate metric (Metric 211) aggregated per project so that I can see which agents are seeing increasing disengagement over time.
8. As a **platform operator**, I want long-pause behavior to degrade gracefully when a transport doesn't emit the speech events I need (e.g., a partial AudioCodes deployment), so that broken timers never accidentally hang up real users.

---

## 4. Functional Requirements

1. **FR-1**: The runtime MUST arm a long-pause timer on every bot-utterance completion event for any voice session whose resolved `ConversationListeningIR.on_long_pause.enabled !== false`.
2. **FR-2**: The timer duration MUST come from `on_long_pause.long_pause_ms` if set, otherwise the platform default of **10 000 ms**.
3. **FR-3**: The runtime MUST cancel the timer on any of: user speech-start event, ASR partial result, DTMF input, barge-in, bot-utterance start, session teardown, or transport disconnect. An ASR partial result is treated as `cause: 'user_speech'` for cancellation and tracing purposes (no distinct `asr_partial` cause).
4. **FR-4**: When the timer fires AND the retry budget is not exhausted, the runtime MUST emit the reprompt via the configured mode:
   - **Hook-driven (default)**: render `template` (after locale resolution) and play it through the same TTS pipeline as a regular bot utterance, **without invoking the LLM**, with end-to-end latency budget < 100 ms (excluding TTS audio length).
   - **Agent-driven**: enqueue a synthetic system turn through `executeVoiceTurn` carrying a `__longPause` signal so the agent generates a context-aware reprompt.
5. **FR-5**: The runtime MUST decrement the retry budget on each fire. When `retries` is reached and another long-pause fires, the runtime MUST execute the configured `terminal` action: `hangup` | `transfer` | `final_utterance` (with `final_utterance` rendering a final templated line then hanging up). When `terminal` is the bare string `'final_utterance'`, the runtime renders the outer `on_long_pause.template` / `locale_variants` as the final line; authors who need a distinct closing message must use the object form `{ type: 'final_utterance', template: '...', locale_variants?: {...} }`.
6. **FR-6**: Locale resolution MUST follow this precedence: `on_long_pause.locale_variants[<resolved_locale>]` → `on_long_pause.template` → project-level default template → built-in English fallback. The resolved locale comes from session metadata (e.g., AudioCodes `language`, KoreVG `lang`, LiveKit `language`).
7. **FR-7**: The runtime MUST enforce **threshold inversion**: at session start (and on IR hot-reload), if `on_long_pause.long_pause_ms <= end_of_utterance_ms` (resolved via `parsePauseTimeoutMs`), the platform MUST log a warning AND fall back to `end_of_utterance_ms + 5000 ms` to prevent a long-pause timer from firing before EOU completes.
8. **FR-8**: The runtime MUST emit the following lifecycle `TraceEvent`s with `sessionId`, `conversationId`, `projectId`, `tenantId`, current retry-budget remaining, and configured `long_pause_ms`:
   - `voice.long_pause.timer_armed`
   - `voice.long_pause.canceled` (with `cause: 'user_speech' | 'dtmf' | 'barge_in' | 'bot_speaking' | 'session_end' | 'disconnect' | 'upstream_noinput'`)
   - `voice.long_pause.fired`
   - `voice.long_pause.reprompt_sent` (with `mode: 'hook' | 'agent'`)
   - `voice.long_pause.retry_budget_exhausted` (with `terminal_action: 'hangup' | 'transfer' | 'final_utterance'`)
     FR-15 defines a 6th startup-guard event (`voice.long_pause.disabled_no_signal`) for degraded transports; total emitted event names = 6.
9. **FR-9**: The runtime MUST contribute to **Metric 211 (Long Pause / User Disengagement Rate)**: count of sessions where `voice.long_pause.fired` occurred at least once, divided by total voice sessions in the window, segmented by `projectId`, transport, and locale.
10. **FR-10**: When `on_long_pause.enabled === false`, the runtime MUST NOT arm a timer for that node and MUST NOT emit any long-pause `TraceEvent` other than session-startup config logging.
11. **FR-11**: AudioCodes migration MUST be staged: Phase 1 the new platform timer runs **in parallel** with the existing hardcoded `noInput` fallback and shadows it (logs but does not double-send if the upstream `noInput` arrived first); Phase 2 the new path becomes authoritative and the hardcoded fallback is gated behind a `disableLegacyAudioCodesNoInput=false` flag (default true); Phase 3 the hardcoded fallback is removed.
12. **FR-12**: The runtime MUST treat the long-pause timer as **per-connection, in-memory** state on the voice session object — never as durable Redis/Mongo state, never inside agent DSL execution, never inside the workflow engine. On pod restart or session resume the timer is **lost** and a new one is armed on the next bot utterance.
13. **FR-13**: The IR schema MUST add an optional `on_long_pause` object on `ConversationListeningIR` with the shape: `{ template?: string; long_pause_ms?: number; retries?: number; terminal?: 'hangup' | 'transfer' | 'final_utterance' | { type: 'final_utterance'; template: string; locale_variants?: Record<string, string> }; enabled?: boolean; locale_variants?: Record<string, string>; mode?: 'hook' | 'agent' }`. All fields are optional; the field's presence with no overrides yields platform defaults.
14. **FR-14**: A shared `InactivityMonitor` helper MUST encapsulate timer arming/canceling/firing across the four voice session types (AudioCodes, Twilio Media, KoreVG, LiveKit) so that channel-specific code only wires events in/out and the timer logic lives in one place.
15. **FR-15**: When the transport does not emit reliable speech-start events (degraded mode), the runtime MUST NOT arm the timer for that session and MUST emit a `voice.long_pause.disabled_no_signal` trace event at session start so operators can see the silent fallback.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                          |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project-level default template/locale map; per-project Metric 211 segmentation.                                                |
| Agent lifecycle            | PRIMARY      | New `on_long_pause` field on `ConversationListeningIR`; authored per node.                                                     |
| Customer experience        | PRIMARY      | Direct change to caller-perceived voice behavior — proactive re-engagement.                                                    |
| Integrations / channels    | PRIMARY      | All four voice transports (AudioCodes, Twilio Media, KoreVG, LiveKit) plus VXML where applicable.                              |
| Observability / tracing    | PRIMARY      | 6 new `TraceEvent` types (5 lifecycle + 1 startup-guard); Metric 211 allocation.                                               |
| Governance / controls      | SECONDARY    | Project-default templates may be governed; `enabled` flag respects authoring permissions.                                      |
| Enterprise / compliance    | SECONDARY    | Reprompt text considered conversational content for transcript/PII purposes; locale variants honored by enterprise tenancy.    |
| Admin / operator workflows | SECONDARY    | Operators get Metric 211 in dashboards; AudioCodes migration flag (`disableLegacyAudioCodesNoInput`) is an operator-flippable. |

### Related Feature Integration Matrix

| Related Feature                                        | Relationship Type | Why It Matters                                                                                       | Key Touchpoints                                                            | Current State                                      |
| ------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| [voice-capabilities.md](../voice-capabilities.md)      | extends           | Parent feature; this sub-feature adds a new listening hook to the voice contract.                    | `ConversationListeningIR`, `InactivityMonitor`, transport sessions         | Parent ALPHA; this sub-feature PLANNED             |
| End-of-Utterance (EOU) Endpointing                     | depends on        | Threshold inversion guard (`long_pause_ms > end_of_utterance_ms`) prevents conflict with EOU timers. | `parsePauseTimeoutMs`, `on_pause`                                          | EOU shipped (800/1500/2500 ms presets)             |
| Session Timeout (`expiresSeconds`)                     | shares data with  | Distinct upper-bound timer; long-pause must complete its retry budget before session timeout fires.  | `AudioCodesChannelConfig.expiresSeconds`, equivalents on other transports  | Shipped                                            |
| Traceability ([Core Invariant #5](../../../CLAUDE.md)) | emits into        | All long-pause state transitions emit `TraceEvent`s through the shared `TraceStore`.                 | `TraceStore.append`, span/event correlation                                | Shipped                                            |
| Stateless Agent Runtime (Core Invariant #4)            | constrained by    | Long-pause timers MUST live on connection-scoped session objects, NOT in agent DSL execution.        | `apps/runtime/src/services/voice/**/*session.ts`, NOT `packages/compiler/` | Invariant enforced                                 |
| Workflow Engine                                        | NOT integrated    | Explicit non-integration: long-pause is connection-level, not durable. No workflow tool dispatched.  | n/a                                                                        | n/a                                                |
| Voice Analytics (Metrics 201-210)                      | extends           | Adds Metric 211, distinct from Metric 205 (silence duration).                                        | Analytics emission path, dashboards                                        | Metric 205 shipped; 211 free                       |
| Studio Authoring                                       | configured by     | Studio surface (form schema) exposes `on_long_pause` for authoring.                                  | Form schema, conversation node editor                                      | Not yet surfaced — follow-up task                  |
| AudioCodes legacy `noInput` fallback                   | replaces (staged) | Phase-3 deletion of the hardcoded reprompt in `channel-audiocodes.ts:316-321`.                       | `apps/runtime/src/routes/channel-audiocodes.ts`                            | Currently shipped hardcoded; migration plan in §13 |

---

## 6. Design Considerations

This feature is primarily runtime + IR; the Studio-side authoring UX is intentionally scoped as a follow-up. For v1:

- **No new Studio surface beyond schema-driven form rendering.** The conversation node editor already renders `ConversationListeningIR` fields; adding `on_long_pause` to the form schema produces a basic editor automatically. A purpose-built designer experience (visual timer slider, terminal-action picker with previews, locale-variant table) is a follow-up task tracked in §13.
- **Trace UI**: existing TraceEvent rendering surfaces the new events with no changes; we'll just ensure the event names render readably (`voice.long_pause.fired` → "Long pause fired" via the existing humanizer).
- **Studio default-template management** belongs in Project Settings → Voice Defaults (follow-up). For v1 the project default lives as a single env-or-tenant-setting field.
- **No accessibility concerns** for the runtime itself (audio-only); the Studio authoring form must follow existing design-token rules.

---

## 7. Technical Considerations

### Architectural decisions (DECIDED — see also §15 historical Open Questions)

1. **Timer location**: per-connection session object (e.g., the existing `MediaSession` in `twilio-media-handler.ts:287`; equivalent in `korevg-session.ts`, `audiocodes-adapter.ts`, LiveKit agent session). **NOT** the agent DSL runtime, **NOT** the workflow engine. This is a hard line driven by Core Invariant #4.
2. **Shared helper**: `InactivityMonitor` class in `apps/runtime/src/services/voice/inactivity-monitor.ts` (new), instantiated once per voice session. Encapsulates `arm()`, `cancel(cause)`, `disarm()`, `onFire(callback)`, retry-budget tracking, trace-event emission, threshold-inversion guard, and graceful no-signal mode (FR-15).
3. **Reprompt mode**: hook-driven by default (no LLM); agent-driven opt-in. The hook path renders the template synchronously and sends through the existing TTS pipeline; the agent path enqueues a synthetic system turn through `executeVoiceTurn` with a `__longPause: true` flag so the agent can branch.
4. **Threshold inversion guard** (FR-7): if `long_pause_ms <= end_of_utterance_ms`, log a warning and force `long_pause_ms = end_of_utterance_ms + 5000`. This sanity check runs at session start and on any IR hot-reload.
5. **Locale resolution** (FR-6): `locale_variants[locale] → template → project_default → built-in English`. The runtime resolves the locale once per session from the transport's session metadata and caches it.
6. **AudioCodes migration** (FR-11): three explicit phases, gated by a single config flag `disableLegacyAudioCodesNoInput` (default `false` in Phase 1, `true` in Phase 2, removed in Phase 3). Each phase is an independent commit with its own JIRA ticket; this sub-feature only ships Phase 1.
7. **Idempotency / double-send guard**: in Phase 1 of the AudioCodes migration, if the upstream `noInput` arrives first AND the platform timer also fires within a 500 ms window, the second emission is suppressed. We choose the upstream `noInput` as the winner (legacy behavior preserved) and the platform timer logs `voice.long_pause.canceled` with `cause: 'upstream_noinput'`.
8. **Default values**: `long_pause_ms = 10000`, `retries = 1`, `terminal = 'hangup'`, `enabled = true` (when the field is present; absence means inherit project default; project default absence means feature OFF for backwards compatibility). The default-on-presence behavior matches the existing `bargeIn !== false` precedent.

### Transport-native primitives to reuse

LiveKit Agents SDK and AudioCodes Bot API already ship long-pause / no-input primitives the runtime should **wrap rather than re-implement**:

- **LiveKit** (`@livekit/agents` `dist/voice/agent_session.cjs:47,538-552`): exposes `userAwayTimeout?: number | null` (default 15 s) on `AgentSession`, with `setTimeout` / `clearTimeout` already wired against speech-state transitions. Our `InactivityMonitor` for the LiveKit transport SHOULD configure `userAwayTimeout` to our resolved `long_pause_ms / 1000` and subscribe to LiveKit's "user away" state transition; it MUST NOT arm a parallel Node `setTimeout` that would race the SDK timer.
- **AudioCodes** (`apps/runtime/src/channels/adapters/audiocodes-adapter.ts:62-71`): the existing `AudioCodesChannelConfig` already accepts `userNoInputTimeoutMs` and `userNoInputRetries`. The shadow Phase-1 integration MUST propagate the resolved `long_pause_ms` into `userNoInputTimeoutMs` on outbound session config so AudioCodes' own timer aligns with the platform's resolved value; the platform `InactivityMonitor` then plays the same-window role (winner determined by §7.7 double-send guard).
- **Twilio Media Streams & KoreVG** (no native long-pause primitive): the `InactivityMonitor` owns the Node `setTimeout` directly for these transports.

This dual-source design keeps the IR a single source of truth (`on_long_pause`) while honoring each transport's native plumbing where one exists.

### Rollout sequencing

- **R1** — IR schema field + `InactivityMonitor` helper + Twilio Media Streams integration (lowest-risk transport, in-house event model).
- **R2** — KoreVG integration (existing Metric 205 wiring makes the signals available) + LiveKit integration.
- **R3** — AudioCodes Phase 1 (shadow mode alongside legacy `noInput`).
- **R4** — AudioCodes Phase 2 (legacy gated by flag, default off).
- **R5** — AudioCodes Phase 3 (delete legacy hardcoded fallback).
- **R6** — Studio purpose-built authoring UX.

R1–R3 ship under ABLP-665. R4–R6 spawn follow-up tickets.

---

## 8. How to Consume

### Studio UI

In v1, the new IR field appears in the conversation node editor wherever `ConversationListeningIR` is rendered. The Studio form is schema-driven: adding `on_long_pause` to the form schema yields a basic editor automatically (object with sub-fields). Authors set `template`, `long_pause_ms`, `retries`, `terminal`, `enabled`, and per-locale variants via the same generic schema-form components used elsewhere.

A dedicated designer experience (visual slider for `long_pause_ms`, terminal-action picker, locale-variant table, preview-with-TTS) is tracked as a follow-up task in §13.

### Surface Semantics Matrix

| Asset / Entity Type                                | Source of Truth / Ownership                 | Design-Time Surface(s)                                 | Editable or Read-Only? | Consumer Reference / Binding Model                                                         | Runtime Materialization / Resolution                                                                      | Notes / Unsupported State                                                              |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `on_long_pause` config (per conversation node)     | Agent author (project-scoped)               | Conversation node editor in Studio                     | Editable               | Inline literal object on the IR node (no external reference)                               | Compiled into `ConversationListeningIR.on_long_pause` and applied by `InactivityMonitor` at session start | Not yet surfaced in custom Studio designer; relies on generic schema-form in v1        |
| `locale_variants` map                              | Agent author                                | Same node editor (sub-form)                            | Editable               | Inline `Record<string, string>` keyed by BCP-47 locale code                                | Resolved per-session against transport-emitted locale; falls back to `template` then project default      | Locale codes are not validated at author time in v1 — invalid codes silently fall back |
| Project-default reprompt template                  | Project owner (Project Settings → Voice)    | Project Settings (follow-up; env/tenant setting in v1) | Editable (follow-up)   | Project-level config, resolved when node-level `template` and `locale_variants` are absent | Cached on session start                                                                                   | v1 uses an env-or-tenant setting; full Studio Project Settings UX is a follow-up       |
| Built-in English fallback string                   | Platform constant                           | n/a                                                    | Read-only              | Source code constant in `InactivityMonitor`                                                | Last-resort fallback                                                                                      | Cannot be removed; localizable only by overriding higher levels                        |
| Legacy AudioCodes hardcoded "Are you still there?" | Platform code (`channel-audiocodes.ts:316`) | n/a                                                    | Read-only              | Internal only — not author-visible                                                         | Gated behind `disableLegacyAudioCodesNoInput` flag in Phase 2; deleted in Phase 3                         | Backwards-compatibility shim only; removed by R5                                       |

### Design-Time vs Runtime Behavior

- **Design-time**: author edits `on_long_pause` on a conversation node in Studio. The IR is compiled and deployed as part of normal agent versioning.
- **Runtime**: on every voice session, the `InactivityMonitor` is instantiated with the resolved (compiled) config. Locale is resolved once from transport metadata. The monitor is armed on every bot-utterance-completion event, canceled on user-speech-start/DTMF/barge-in, and fires after `long_pause_ms` of sustained silence.
- The author-facing field name (`on_long_pause`) and the compiled IR field are identical — no renaming/aliasing. The platform default values (10 s / 1 retry / hangup) live in `InactivityMonitor` and are documented in code with a constant block.

### API (Runtime)

No new public REST endpoints. The feature is consumed entirely through the IR on the existing voice WS / channel routes. Internal-only changes:

| Method | Path                                       | Purpose                                                                               |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| WS     | `/ws/voice/twilio`                         | Existing — `MediaSession` now wires `InactivityMonitor`.                              |
| WS     | `/ws/voice/livekit` (LiveKit agent worker) | Existing — agent-worker wires `InactivityMonitor` via session lifecycle hooks.        |
| WS     | KoreVG voice WS                            | Existing — `korevg-session.ts` wires `InactivityMonitor`.                             |
| POST   | `/api/channels/audiocodes/*`               | Existing — AudioCodes adapter wires `InactivityMonitor` in shadow/authoritative mode. |

### API (Studio)

No new Studio API endpoints in v1. Schema-form rendering picks up the new field via the existing form-schema pipeline.

### Admin Portal

No new admin endpoints. The migration flag `disableLegacyAudioCodesNoInput` is exposed as a tenant-level config visible in Admin under Voice → Channel Defaults (follow-up); v1 uses a platform env var.

### Channel / SDK / Voice / A2A / MCP Integration

| Channel                             | Long-pause support in v1                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twilio Media Streams                | Full (reference implementation, R1)                                                                                                                                 |
| KoreVG / Jambonz                    | Full (R2)                                                                                                                                                           |
| LiveKit                             | Full (R2)                                                                                                                                                           |
| AudioCodes                          | Shadow alongside legacy `noInput` (R3, Phase 1); full ownership in R4–R5                                                                                            |
| VXML                                | Best-effort: if VXML's `noinput` event is available, treat it as user-silence; otherwise enter no-signal mode (FR-15) and log `voice.long_pause.disabled_no_signal` |
| Text channels (chat, SMS, A2A, MCP) | **Not supported** — feature is voice-only by design                                                                                                                 |

---

## 9. Data Model

This feature introduces **no new collections**. It extends an existing IR schema and emits `TraceEvent`s into the existing store.

### IR schema extension

```text
ConversationListeningIR (packages/compiler/src/platform/ir/schema.ts)
  on_long_pause?: {
    enabled?: boolean;                                      // default true when field present
    long_pause_ms?: number;                                 // default 10000
    retries?: number;                                       // default 1
    template?: string;                                      // default fallback "Are you still there?"
    locale_variants?: Record<string, string>;               // BCP-47 → template
    mode?: 'hook' | 'agent';                                // default 'hook'
    terminal?: 'hangup' | 'transfer' |
               { type: 'final_utterance';
                 template: string;
                 locale_variants?: Record<string, string> };  // default 'hangup'
  };
```

### TraceEvent additions

Stored via the existing `TraceStore`. New event names (no schema change to `TraceEvent` itself, since the existing `name` field is open string):

```text
voice.long_pause.timer_armed
voice.long_pause.canceled
voice.long_pause.fired
voice.long_pause.reprompt_sent
voice.long_pause.retry_budget_exhausted
voice.long_pause.disabled_no_signal
```

### Metric 211

```text
Metric ID: 211
Name: Long Pause / User Disengagement Rate
Definition: count(distinct sessionId where voice.long_pause.fired emitted >= 1 within the window)
          / count(distinct sessionId for voice sessions within the same window)
Segmentation: projectId, transport, locale, time window
Source: aggregated from TraceEvent stream
```

### Key Relationships

- `on_long_pause` lives on a conversation node in agent IR — versioned with the agent.
- `InactivityMonitor` instances are per-connection, in-memory only — explicitly **not** persisted.
- TraceEvents reference `sessionId`, `conversationId`, `projectId`, `tenantId` via the existing schema.
- Metric 211 derives entirely from emitted TraceEvents — no separate write path.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                    | Purpose                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/runtime/src/services/voice/inactivity-monitor.ts` (NEW)           | Shared `InactivityMonitor` class — timer lifecycle, retry budget, trace emission. |
| `packages/compiler/src/platform/ir/schema.ts`                           | Add `on_long_pause` field to `ConversationListeningIR`.                           |
| `packages/compiler/src/platform/ir/normalize.ts` (likely)               | Apply defaults / threshold-inversion guard during normalization.                  |
| `apps/runtime/src/services/execution/conversation-behavior-resolver.ts` | Resolve `on_long_pause` per node; expose to session wiring.                       |
| `apps/runtime/src/services/voice/reprompt-renderer.ts` (NEW)            | Locale-aware template resolution + TTS dispatch (hook mode).                      |

### Routes / Handlers (transport wiring)

| File                                                       | Purpose                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/websocket/twilio-media-handler.ts`       | Wire `InactivityMonitor` into `MediaSession`; arm on bot-utterance-complete, cancel on user-speech.     |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts` | Wire `InactivityMonitor` into KoreVG session.                                                           |
| `apps/runtime/src/services/voice/livekit/agent-worker.ts`  | Wire `InactivityMonitor` via existing `user_state_changed` hook.                                        |
| `apps/runtime/src/routes/channel-audiocodes.ts`            | AudioCodes Phase-1 shadow integration; gating flag for Phase 2+; hardcoded fallback removed in Phase 3. |
| `apps/runtime/src/channels/adapters/audiocodes-adapter.ts` | Surface speech-start / speech-stop / noInput events through a common interface.                         |

### UI Components

| File                                   | Purpose                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| Conversation node form schema (Studio) | Adds `on_long_pause` as a schema-driven sub-form. No new bespoke components in v1. |

### Jobs / Workers / Background Processes

| File | Purpose                                                          |
| ---- | ---------------------------------------------------------------- |
| n/a  | No new jobs/workers — timers are in-memory, per-connection only. |

### Tests

| File                                                                      | Type        | Coverage Focus                                                                  |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `apps/runtime/src/services/voice/inactivity-monitor.test.ts` (NEW)        | unit        | Arm/cancel/fire lifecycle, retry budget, threshold-inversion guard, no-signal.  |
| `apps/runtime/src/services/voice/reprompt-renderer.test.ts` (NEW)         | unit        | Locale resolution precedence (variant → template → project default → fallback). |
| `apps/runtime/test/integration/voice-long-pause-twilio.test.ts` (NEW)     | integration | Real Twilio Media WS flow: arm/cancel/fire with simulated audio frames.         |
| `apps/runtime/test/integration/voice-long-pause-audiocodes.test.ts` (NEW) | integration | Phase-1 shadow mode + double-send suppression vs legacy `noInput`.              |
| `apps/runtime/test/e2e/voice-long-pause-end-to-end.test.ts` (NEW)         | e2e         | Full call: bot speaks → user silent 10s → reprompt → silent → terminal hangup.  |

(Test specs detailed in [the testing guide](../../testing/sub-features/voice-long-pause-detection.md).)

---

## 11. Configuration

### Environment Variables

| Variable                                             | Default                  | Description                                                                                        |
| ---------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `VOICE_LONG_PAUSE_DEFAULT_MS`                        | `10000`                  | Platform default `long_pause_ms` when neither node-level nor project-level override is set.        |
| `VOICE_LONG_PAUSE_DEFAULT_RETRIES`                   | `1`                      | Platform default retry budget.                                                                     |
| `VOICE_LONG_PAUSE_PROJECT_DEFAULT_TEMPLATE`          | `"Are you still there?"` | Project-level (env-driven in v1) default reprompt template when node has none.                     |
| `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT` | `false`                  | AudioCodes migration gating flag (Phase 1=false, Phase 2=true, Phase 3=flag removed).              |
| `VOICE_LONG_PAUSE_THRESHOLD_INVERSION_GUARD_GAP_MS`  | `5000`                   | If `long_pause_ms <= end_of_utterance_ms`, force `long_pause_ms = end_of_utterance_ms + this gap`. |

### Runtime Configuration

- **Per-conversation-node (IR)**: `on_long_pause` object — see §9.
- **Per-project (follow-up)**: project default template and locale variants in Project Settings → Voice. v1 uses env var `VOICE_LONG_PAUSE_PROJECT_DEFAULT_TEMPLATE`.
- **Per-tenant**: no tenant-specific configuration in v1.
- **No feature flag for the feature itself**: presence of `on_long_pause` on a node opts in; absence opts out (matches existing IR field conventions).

### DSL / Agent IR / Schema

```typescript
// packages/compiler/src/platform/ir/schema.ts
export interface ConversationListeningIR {
  barge_in?: string;
  on_pause?: string;
  on_overlap?: string;
  on_unclear_audio?: string;
  on_self_correction?: string;
  on_long_pause?: {
    enabled?: boolean;
    long_pause_ms?: number;
    retries?: number;
    template?: string;
    locale_variants?: Record<string, string>;
    mode?: 'hook' | 'agent';
    terminal?:
      | 'hangup'
      | 'transfer'
      | { type: 'final_utterance'; template: string; locale_variants?: Record<string, string> };
  };
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `on_long_pause` config is per-agent / per-node, scoped within the agent's project. No cross-project read or write paths. Metric 211 segmented by `projectId`.                                                          |
| Tenant isolation  | TraceEvents include `tenantId`; Metric 211 segmentation never aggregates across tenants. Project-default template (v1 env var) is platform-wide in v1; follow-up Project Settings work makes it tenant/project-scoped. |
| User isolation    | n/a — this is a session-level feature with no user-owned resource. End-user (caller) identity flows via existing session-source rules (Core Invariant #1).                                                             |

### Security & Compliance

- The reprompt text is **conversational content** and follows existing voice-channel content rules (encrypted in transit and at rest via the same transcript storage path; redaction policies apply identically).
- No secrets / credentials involved.
- Locale templates are author-supplied strings — same XSS/injection considerations as other authored content (no executable code path).
- Audit logging: each `voice.long_pause.fired` and `voice.long_pause.reprompt_sent` event is a `TraceEvent` with full session context — sufficient for compliance / dispute resolution.
- Right-to-erasure: TraceEvents are subject to the existing voice-trace retention/erasure pipeline; no new data class introduced.

### Performance & Scalability

- **Hook-driven reprompt latency budget**: < 100 ms from timer-fire to first TTS audio frame leaving runtime. No LLM call.
- **Agent-driven reprompt latency**: bounded by normal `executeVoiceTurn` SLA (no separate budget — author opt-in).
- **Memory**: one `InactivityMonitor` per active voice session — a single `setTimeout` handle, a few numeric fields. Negligible.
- **Distributed coordination**: none — per-connection in-memory state, no Redis/Mongo writes.
- **Throughput**: no impact on TPS; the feature adds no synchronous I/O on the hot path.

### Reliability & Failure Modes

- **Pod restart / session resume**: timer is lost; new timer arms on next bot utterance. Acceptable because the feature is best-effort re-engagement, not a guaranteed durable behavior.
- **TTS failure on hook-driven reprompt**: the reprompt is dropped silently; `voice.long_pause.reprompt_sent` is **not** emitted (only `voice.long_pause.fired`), allowing observability of the mismatch.
- **Transport degradation (no speech-start events)**: no-signal mode (FR-15) — timer never arms; `voice.long_pause.disabled_no_signal` emitted at session start. Fails closed.
- **Threshold inversion** (`long_pause_ms ≤ end_of_utterance_ms`): guard forces a safe value; warning logged. Fails safe.
- **Terminal `hangup`**: dispatched through the same channel hangup primitive used elsewhere — failure modes inherit from transport.
- **Terminal `transfer`**: requires the agent IR to define a transfer target; if absent, falls back to `hangup` and logs.

### Observability

- 6 new `TraceEvent` names (§9).
- Metric 211 derived from TraceEvent stream (§9).
- Logs: structured `log.info` / `log.warn` for armed/fired/inversion-guard events at INFO; errors at ERROR.
- Existing voice debug session viewer in Admin/Studio surfaces these events with no code changes.

### Data Lifecycle

- Inherits voice-transcript retention. No new data class.
- No new TTL or migration concerns.

---

## 13. Delivery Plan / Work Breakdown

1. **R1 — Foundations + Twilio reference impl** (ABLP-665 lead-ticket scope)
   1.1 Add `on_long_pause` field to `ConversationListeningIR` schema in `packages/compiler/src/platform/ir/schema.ts`.
   1.2 Implement IR normalization defaults and threshold-inversion guard in compiler.
   1.3 Build `InactivityMonitor` helper in `apps/runtime/src/services/voice/inactivity-monitor.ts` with full unit-test coverage.
   1.4 Build `reprompt-renderer.ts` for locale resolution and hook-driven dispatch.
   1.5 Wire `InactivityMonitor` into Twilio Media `MediaSession` (R1 reference transport).
   1.6 Emit all 6 `TraceEvent` names; verify TraceStore append path.
   1.7 Add Metric 211 emission and dashboard entry.
   1.8 Integration tests for Twilio path: arm/cancel/fire/exhaust/terminal.
   1.9 Update `docs/feature-matrix.md` and `agents.md` in `apps/runtime/` and `packages/compiler/`.

2. **R2 — KoreVG + LiveKit transports**
   2.1 Wire `InactivityMonitor` into `korevg-session.ts`.
   2.2 Wire `InactivityMonitor` into LiveKit `agent-worker.ts` via `user_state_changed`.
   2.3 Integration tests per transport.
   2.4 No-signal mode validation on a transport with degraded events.

3. **R3 — AudioCodes Phase 1 (shadow)**
   3.1 Wire `InactivityMonitor` into the AudioCodes adapter alongside the legacy `noInput` fallback.
   3.2 Implement double-send suppression with `cause: 'upstream_noinput'` cancel reason.
   3.3 Shadow-mode trace-only emission; no behavior change in user-perceived output.
   3.4 Integration test confirming both paths coexist without double prompts.

4. **R4 — AudioCodes Phase 2 (legacy gated)** — separate ticket
   4.1 Flip the default of `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT` from `false` to `true` after one production observation window (flag itself is already introduced in R1 / §11).
   4.2 Update operational docs.

5. **R5 — AudioCodes Phase 3 (delete legacy)** — separate ticket
   5.1 Remove the hardcoded reprompt block at `apps/runtime/src/routes/channel-audiocodes.ts:316-321`.
   5.2 Remove the gating flag.
   5.3 Migration note in changelog.

6. **R6 — Studio purpose-built authoring UX** — separate ticket
   6.1 Visual slider for `long_pause_ms`, terminal-action picker, locale-variant table editor.
   6.2 Project Settings → Voice Defaults page (replaces env var for project default template).

---

## 14. Success Metrics

| Metric                                                       | Baseline                   | Target                                | How Measured                                                                             |
| ------------------------------------------------------------ | -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Reprompt dispatch latency (hook-driven)                      | n/a                        | p95 < 100 ms (timer-fire → audio out) | New per-event histogram from `voice.long_pause.fired` → `voice.long_pause.reprompt_sent` |
| % of voice sessions with at least one long pause             | unknown                    | Tracked (Metric 211); no target       | Metric 211, segmented by project & transport                                             |
| % of long-pause-fired sessions ending in successful recovery | unknown                    | Trend up                              | Sessions with `fired` AND subsequent user speech-start before `retry_budget_exhausted`   |
| Cross-channel parity                                         | 0/4 transports unified     | 4/4 (post R1–R3)                      | Transport coverage table in testing guide                                                |
| Threshold-inversion incidents in production                  | n/a                        | 0                                     | Count of `threshold inversion forced` warning logs in production                         |
| Hardcoded `noInput` fallback usage (AudioCodes)              | 100% of AudioCodes traffic | 0% post-R5                            | Count of legacy-path executions, decommissioned in R5                                    |

---

## 15. Open Questions

All major open questions were resolved during the architectural review (GPT-5.5 round) and product-oracle resolution. Recorded here for traceability:

1. **D-Q1 — Default `long_pause_ms` per channel?** Resolved: unified **10 000 ms** at launch across all transports; per-channel defaults are a follow-up only if Metric 211 segmentation shows divergence.
2. **D-Q2 — Shape of the IR field?** Resolved: object-shaped `on_long_pause` (NOT a bare string), with `{ template?, long_pause_ms?, retries?, terminal?, enabled?, locale_variants?, mode? }`.
3. **D-Q3 — Locale handling?** Resolved: `locale_variants: Record<string, string>` (BCP-47 keys), falling back to `template` → project default → built-in English.
4. **D-Q4 — How to disable per-node?** Resolved: explicit `enabled: false` flag (matches `bargeIn !== false` precedent). Setting `long_pause_ms = 0` is **NOT** the disable convention.
5. **D-Q5 — AudioCodes legacy fallback migration?** Resolved: three explicit phases (shadow → gated → removed), each its own ticket.
6. **D-Q6 — Analytics metric ID?** Resolved: **Metric 211** ("Long Pause / User Disengagement Rate"). Metric 208 was incorrectly proposed; it is already reserved for language-segmented ASR quality (verified via grep).

Remaining open items (low-severity, deferrable):

7. Should the agent-driven mode pass a structured `__longPause` signal in metadata or as a synthetic user message? — Decided: structured metadata, **NOT** synthetic user content (avoids polluting transcripts). Confirmed during LLD.
8. VXML support: best-effort or full first-class? — Decided: **best-effort** in v1 (FR-15 no-signal mode handles missing speech-start events).

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                       | Severity | Status                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------- |
| GAP-001 | No persistent durability — timer is lost on pod restart or session resume. Acceptable by design (Core Invariant #4).              | Low      | Accepted by design         |
| GAP-002 | Studio designer experience is schema-form only in v1; no visual slider / preview. Authoring is functional but not polished.       | Medium   | Open (R6 follow-up)        |
| GAP-003 | Project-default template lives in env var in v1, not in Project Settings UI.                                                      | Medium   | Open (R6 follow-up)        |
| GAP-004 | VXML support is best-effort; some VXML deployments emit no usable speech-start events and will enter no-signal mode silently.     | Low      | Accepted (FR-15)           |
| GAP-005 | AudioCodes legacy hardcoded fallback remains in code until R5; Phase 1 ships with both paths active (suppression guard in place). | Medium   | Open (R4–R5)               |
| GAP-006 | No per-tenant override of platform defaults in v1.                                                                                | Low      | Accepted (deferred)        |
| GAP-007 | `mode: 'agent'` latency is bounded only by general `executeVoiceTurn` SLA, not by a long-pause-specific budget. Author opt-in.    | Low      | Accepted by design         |
| GAP-008 | Locale-code validation at author time is not provided; invalid codes silently fall back at runtime.                               | Low      | Open (Studio R6 follow-up) |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                    | Coverage Type | Status     | Test File / Note                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------ |
| 1   | `InactivityMonitor` arms / cancels / fires per spec; retry budget decrements                                | unit          | NOT TESTED | `apps/runtime/src/services/voice/inactivity-monitor.test.ts` |
| 2   | Threshold-inversion guard forces safe value and logs warning                                                | unit          | NOT TESTED | `inactivity-monitor.test.ts`                                 |
| 3   | Locale resolution precedence (variant → template → project default → built-in)                              | unit          | NOT TESTED | `reprompt-renderer.test.ts`                                  |
| 4   | Twilio Media: bot speaks, user silent 10s, hook-driven reprompt sent < 100 ms timer-fire → audio out        | integration   | NOT TESTED | `voice-long-pause-twilio.test.ts`                            |
| 5   | KoreVG: full arm/cancel/fire/exhaust/terminal-hangup lifecycle                                              | integration   | NOT TESTED | TBD in test spec                                             |
| 6   | LiveKit: cancel-on-user-speech via `user_state_changed`                                                     | integration   | NOT TESTED | TBD in test spec                                             |
| 7   | AudioCodes Phase 1 shadow: legacy `noInput` wins double-send race; new path emits `cause: upstream_noinput` | integration   | NOT TESTED | `voice-long-pause-audiocodes.test.ts`                        |
| 8   | E2E voice call: silent 10s → reprompt → silent again → terminal hangup                                      | e2e           | NOT TESTED | `voice-long-pause-end-to-end.test.ts`                        |
| 9   | E2E voice call: silent 10s → user speaks → timer canceled → call continues normally                         | e2e           | NOT TESTED | TBD in test spec                                             |
| 10  | E2E voice call: `enabled: false` on a node → no timer armed, no trace events beyond startup config          | e2e           | NOT TESTED | TBD in test spec                                             |
| 11  | E2E voice call: locale-variant resolution (en-US vs es-ES on same agent)                                    | e2e           | NOT TESTED | TBD in test spec                                             |
| 12  | E2E voice call: agent-driven mode emits a contextual reprompt via `executeVoiceTurn`                        | e2e           | NOT TESTED | TBD in test spec                                             |
| 13  | Metric 211 emission: aggregated over a synthetic session batch with mixed fired/not-fired outcomes          | integration   | NOT TESTED | TBD in test spec                                             |

### Testing Notes

This is a PLANNED feature — no code exists yet. The testing guide enumerates the full coverage matrix (minimum 5 E2E + 5 integration scenarios per CLAUDE.md). All scenarios above are required for ALPHA → BETA promotion.

> Full testing details: [../../testing/sub-features/voice-long-pause-detection.md](../../testing/sub-features/voice-long-pause-detection.md)

---

## 18. References

- Parent feature: [docs/features/voice-capabilities.md](../voice-capabilities.md)
- Authoring guide: [docs/features/AUTHORING_GUIDE.md](../AUTHORING_GUIDE.md)
- SDLC pipeline: [docs/sdlc/pipeline.md](../../sdlc/pipeline.md)
- JIRA ticket: [ABLP-665](https://kore-ai.atlassian.net/browse/ABLP-665)
- Core Invariants reference: [CLAUDE.md](../../../CLAUDE.md) (Resource Isolation, Centralized Auth, Stateless Distributed, Stateless Agent Runtime, Traceability)
- Existing voice transport files:
  - `apps/runtime/src/routes/channel-audiocodes.ts:316-321` — legacy hardcoded reprompt
  - `apps/runtime/src/services/voice/korevg/korevg-session.ts:421-431,439` — Metric 205 analytics
  - `apps/runtime/src/websocket/twilio-media-handler.ts:287-320` — `MediaSession` with EOU silenceTimer
  - `apps/runtime/src/channels/adapters/audiocodes-adapter.ts:62-71,210-211` — AudioCodes config + `noInput` plumbing
  - `apps/runtime/src/services/voice/livekit/agent-worker.ts:772-779` — LiveKit user_state_changed
  - `packages/compiler/src/platform/ir/schema.ts:545-551` — `ConversationListeningIR`
  - `apps/runtime/src/services/execution/conversation-behavior-resolver.ts:26,268,573` — `parsePauseTimeoutMs`
- Architectural review history: docs/sdlc-logs/ABLP-665-voice-long-pause-detection/feature-spec.log.md (to be written at commit time)
