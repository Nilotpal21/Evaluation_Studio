# Test Specification: Voice Long-Pause Detection & Proactive Reprompt

**Feature Spec**: [docs/features/sub-features/voice-long-pause-detection.md](../../features/sub-features/voice-long-pause-detection.md)
**HLD**: TBD (`docs/specs/voice-long-pause-detection.hld.md`)
**LLD**: TBD (`docs/plans/<date>-voice-long-pause-detection-impl-plan.md`)
**Status**: PLANNED
**Last Updated**: 2026-05-14
**JIRA**: [ABLP-665](https://kore-ai.atlassian.net/browse/ABLP-665)

---

## 1. Coverage Matrix

Every FR from the feature spec maps to at least one test below. No FR is left uncovered.

| FR    | Description                                                                                             | Unit | Integration | E2E | Manual | Status  | Mapped Scenarios                    |
| ----- | ------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- | ----------------------------------- |
| FR-1  | Arm timer on every bot-utterance-complete when `on_long_pause.enabled !== false`                        | YES  | YES         | YES | NO     | PLANNED | UNIT-1, UNIT-2, INT-5, E2E-1        |
| FR-2  | Timer duration sourced from IR `long_pause_ms` else platform default 10000 ms                           | YES  | NO          | YES | NO     | PLANNED | UNIT-1, E2E-1, E2E-2                |
| FR-3  | Cancel on user speech-start, ASR partial, DTMF, barge-in, bot-utterance-start, teardown, disconnect     | YES  | YES         | YES | NO     | PLANNED | UNIT-3, INT-7, E2E-1, E2E-9         |
| FR-4  | Fire hook-driven (default) reprompt sub-100 ms, no LLM; agent-driven mode via `executeVoiceTurn`        | YES  | YES         | YES | NO     | PLANNED | UNIT-4, INT-1, INT-2, E2E-1, E2E-5  |
| FR-5  | Retry budget decrement and terminal action (`hangup` / `transfer` / `final_utterance`)                  | YES  | YES         | YES | NO     | PLANNED | UNIT-4, INT-3, E2E-2                |
| FR-6  | Locale precedence: variant → template → project default → built-in English                              | YES  | YES         | YES | NO     | PLANNED | UNIT-6, UNIT-7, INT-4, E2E-4        |
| FR-7  | Threshold-inversion guard: `long_pause_ms ≤ end_of_utterance_ms` forced to `end_of_utterance_ms + 5000` | YES  | YES         | YES | NO     | PLANNED | UNIT-5, INT-2, E2E-7                |
| FR-8  | All 6 `TraceEvent`s emitted with proper context                                                         | YES  | YES         | YES | NO     | PLANNED | UNIT-2, UNIT-3, INT-8, E2E-1, E2E-2 |
| FR-9  | Metric 211 emission and segmentation by project/transport/locale                                        | NO   | YES         | NO  | NO     | PLANNED | INT-9, ISO-1                        |
| FR-10 | `enabled: false` arms no timer, emits no events beyond startup config                                   | YES  | NO          | YES | NO     | PLANNED | UNIT-1, E2E-3                       |
| FR-11 | AudioCodes migration: Phase 1 shadow with double-send suppression                                       | NO   | YES         | YES | NO     | PLANNED | INT-4 (double-send), E2E-6          |
| FR-12 | Per-connection in-memory state; pod restart resets timer cleanly                                        | YES  | YES         | NO  | NO     | PLANNED | UNIT-4, INT-10                      |
| FR-13 | IR schema `on_long_pause` shape validation                                                              | YES  | NO          | NO  | NO     | PLANNED | UNIT-8                              |
| FR-14 | Shared `InactivityMonitor` helper used by all four transports                                           | YES  | YES         | YES | NO     | PLANNED | UNIT-1, INT-5, INT-6, INT-7, E2E-8  |
| FR-15 | No-signal degraded mode: timer not armed, `voice.long_pause.disabled_no_signal` emitted                 | YES  | NO          | YES | NO     | PLANNED | UNIT-4, E2E-10                      |

### Current Baseline

The repository ships partial baseline material this feature extends:

- AudioCodes hardcoded reprompt at `apps/runtime/src/routes/channel-audiocodes.ts:316-321` — **zero test coverage today** (verified via `grep "Are you still there" apps/runtime/src/__tests__/` → 0 hits). This is the legacy path FR-11 migrates away from.
- Twilio Media EOU `silenceTimer` at `apps/runtime/src/websocket/twilio-media-handler.ts:287-320` — endpointing timer is exercised by existing twilio-media tests; the long-pause timer is new.
- KoreVG silence analytics at `apps/runtime/src/services/voice/korevg/korevg-session.ts:421-431,439` — Metric 205 only, no action triggered.
- LiveKit `user_state_changed` at `apps/runtime/src/services/voice/livekit/agent-worker.ts:772-779` — used today for analytics; we will additionally consume it as the speech-start cancel signal.
- `ConversationListeningIR` at `packages/compiler/src/platform/ir/schema.ts:545-551` — host for the new `on_long_pause` field.
- TraceStore helper precedent: `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts:33,208,1400` (`getTraceStore` / `resetTraceStore`).
- E2E harness precedent: `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`, `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`.

None of these prove a unified long-pause behavior across transports.

### Form-Error and Wiring-Verification — N/A justification

The skill quality gate mandates a Form-Error E2E and a Wiring-Verification E2E for features that add a new Studio form or a new Studio API route, respectively. **Neither applies here**:

- **No new Studio form**: feature spec §6 explicitly bounds Studio work to the existing schema-driven form-renderer (which has its own test suite covering form-error paths). No bespoke form component is added in v1; a visual designer experience is tracked as a follow-up (R6) under a separate ticket and will own its own Form-Error coverage at that time.
- **No new Studio API route**: feature spec §8 confirms zero new Studio endpoints in v1. All runtime API paths in §8 are pre-existing voice WS / channel routes whose wiring is already exercised by current E2E suites. There is no new route to verify reachability for.

If either condition changes during HLD/LLD, this section must be revised and concrete Form-Error / Wiring-Verification scenarios added.

---

## 2. E2E Test Scenarios (MANDATORY — minimum 5)

CRITICAL — every E2E below: real HTTP/WS to an in-process Express server on `port: 0` via the `RuntimeApiHarness` (`apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`). Full middleware chain executes. No `vi.mock` of internal modules. Only external SDKs (`@livekit/agents`, `twilio`, TTS provider SDKs, AudioCodes HTTP client) are DI'd at the boundary. Trace assertions go through `getTraceStore().getEvents(sessionId)`. E2E uses **real wall-clock with `long_pause_ms` shortened to 2000 ms** per test agent unless otherwise noted.

### E2E-1: Twilio Media — hook-driven reprompt fires after long_pause and cancels on user speech

- **Preconditions**: Tenant + project + agent created via `bootstrapProject` (helper in `channel-e2e-bootstrap.ts`). Agent IR contains one conversation node with `on_long_pause: { long_pause_ms: 2000, retries: 1, terminal: 'hangup', template: 'Are you still there?' }`. Twilio Media WS endpoint mounted on the harness. TTS provider DI'd to a no-op `{ tts: { speak: vi.fn() } }`.
- **Auth Context**: tenant + project + super-admin user (created via `setSuperAdmins`).
- **Steps**:
  1. POST a synthetic Twilio call-start event to the harness; capture `sessionId`.
  2. Open the inbound Twilio Media WS; send a `start` event + bot-utterance-complete event for the opening turn.
  3. Hold silence (no audio frames) on the inbound WS for 2.5 s.
  4. Assert `getTraceStore().getEvents(sessionId)` contains, in order: `voice.long_pause.timer_armed`, `voice.long_pause.fired`, `voice.long_pause.reprompt_sent` (with `mode: 'hook'`).
  5. Assert the DI'd TTS `speak` mock was called with the literal template `"Are you still there?"` exactly once.
  6. Send a synthetic μ-law audio frame on the inbound WS.
  7. Assert a new `voice.long_pause.timer_armed` was issued at the next bot-utterance-complete, then `voice.long_pause.canceled` with `cause: 'user_speech'`.
- **Expected Result**: Trace lineage correct; reprompt audio dispatch path entered; call survives.
- **Isolation Check**: Spawn a second tenant/session in parallel; assert no cross-tenant TraceEvents leak (`getEvents(otherSessionId)` returns 0 long-pause events).

### E2E-2: Twilio Media — retry budget exhausted → terminal hangup

- **Preconditions**: Same harness. Agent IR with `on_long_pause: { long_pause_ms: 1500, retries: 1, terminal: 'hangup' }`.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open Twilio Media WS; emit bot-utterance-complete.
  2. Stay silent 2 s → expect first `voice.long_pause.fired` + `voice.long_pause.reprompt_sent`.
  3. After reprompt TTS dispatch, stay silent another 2 s.
  4. Assert `voice.long_pause.fired` (2nd time), then `voice.long_pause.retry_budget_exhausted` with `terminal_action: 'hangup'`.
  5. Assert the WS receives a Twilio hangup signal (mock `twilio` client's hangup method invoked).
- **Expected Result**: Two fire cycles, terminal dispatched, full lineage.

### E2E-3: `enabled: false` disables the feature on the target node

- **Preconditions**: Agent IR with `on_long_pause: { enabled: false }` on the target node.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open Twilio Media WS; emit bot-utterance-complete.
  2. Hold silence 5 s.
  3. Assert `getTraceStore().getEvents(sessionId)` contains **no** `voice.long_pause.*` events except optionally a startup-config log (`disabled_by_config`).
  4. Assert the DI'd TTS `speak` mock was **not** called.
- **Expected Result**: Call stays open; no reprompt; clean trace.

### E2E-4: Locale-variant resolution across en-US / es-ES / ja-JP

- **Preconditions**: Agent IR with `on_long_pause: { long_pause_ms: 2000, template: 'Are you still there?', locale_variants: { 'es-ES': '¿Sigue ahí?', 'de-DE': 'Sind Sie noch da?' } }`.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Start session 1 with Twilio call `from: '+1...'` and connection `language: 'en-US'`; trigger long-pause; assert TTS `speak` called with `"Are you still there?"`.
  2. Start session 2 with `language: 'es-ES'`; trigger long-pause; assert `"¿Sigue ahí?"`.
  3. Start session 3 with `language: 'ja-JP'` (unmapped); trigger long-pause; assert fallback to `"Are you still there?"`.
- **Expected Result**: Per-FR-6 precedence; reprompt text matches resolved locale; no cross-locale leakage.

### E2E-5: Agent-driven mode emits contextual reprompt via `executeVoiceTurn`

- **Preconditions**: Agent IR with `on_long_pause: { mode: 'agent', long_pause_ms: 2000, retries: 1 }`. LLM provider DI'd via `MockAnthropicClient` (precedent from `livekit-voice.integration.test.ts`) configured to respond with a fixed reprompt referencing the prior question.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open Twilio Media WS; emit a bot-utterance-complete that contained a specific question (e.g., "What is your account number?").
  2. Hold silence 2.5 s.
  3. Assert `voice.long_pause.fired`, then a synthetic system turn was enqueued through `executeVoiceTurn` carrying `metadata.__longPause === true`.
  4. Assert `voice.long_pause.reprompt_sent` with `mode: 'agent'` was emitted **after** the LLM mock returned and TTS dispatched.
- **Expected Result**: Agent path runs through the same executor pipeline; `__longPause` flag flows in metadata (not as synthetic user content); reprompt is the LLM-generated string from the mock.

### E2E-6: AudioCodes Phase-1 shadow — upstream `noInput` wins double-send race

- **Preconditions**: AudioCodes router mounted on harness. Environment `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT=false`. Agent IR includes `on_long_pause: { long_pause_ms: 2000 }`.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Initiate an AudioCodes session via POST to `/api/v1/channels/audiocodes` with start activity.
  2. POST a bot-utterance-complete event.
  3. After ~1500 ms (before the 2000 ms platform timer), POST an upstream `{ type: 'event', name: 'noInput' }` activity.
  4. Assert exactly **one** reprompt was sent down the conversation (existing legacy hardcoded "Are you still there?" — Phase 1 preserves the legacy path).
  5. Assert `voice.long_pause.canceled` was emitted with `cause: 'upstream_noinput'`.
  6. Repeat with `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT=true`: the platform timer wins at 2000 ms and emits `voice.long_pause.fired` + `voice.long_pause.reprompt_sent`.
- **Expected Result**: No double-prompt under any race; cause field correctly distinguishes the winner.

### E2E-7: Threshold-inversion guard forces a safe value on misconfigured IR

- **Preconditions**: Agent IR with `on_long_pause.long_pause_ms: 500` AND `on_pause: "BRIEF"` (resolves to 800 ms EOU).
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open Twilio Media WS; observe startup-time `log.warn` (captured via `loggerSink` test helper, established in voice tests).
  2. Assert the warning message references the forced override and the resolved values.
  3. Trigger a bot-utterance-complete and stay silent.
  4. Assert no `voice.long_pause.fired` arrives until **at least** 5500 ms (800 EOU + 5000 gap), and arrives before ~6500 ms.
- **Expected Result**: Forced safe value applied; warning observable; timing falls in the guarded window.

### E2E-8: KoreVG transport-parity smoke

- **Preconditions**: Same E2E-1 agent IR. KoreVG routes mounted on harness.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open a KoreVG WS session (synthetic Jambonz events per `korevg-grok-handoff.e2e.test.ts` pattern).
  2. Emit bot-utterance-complete.
  3. Hold silence 2.5 s.
  4. Assert the same trace lineage as E2E-1 (`timer_armed` → `fired` → `reprompt_sent` with `mode: 'hook'`).
- **Expected Result**: Transport-parity with Twilio at the trace and TTS dispatch level.

### E2E-9: LiveKit cancel-on-user-speech via `user_state_changed`

- **Preconditions**: Same agent IR. LiveKit SDK DI-mocked. Agent-worker entry-point reachable via the harness.
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Start a LiveKit session (mock `Room` + `Participant`).
  2. Emit bot-utterance-complete; verify `voice.long_pause.timer_armed`.
  3. After 1 s, programmatically emit a `user_state_changed` event from `listening` → `speaking`.
  4. Assert `voice.long_pause.canceled` with `cause: 'user_speech'` arrived before the 2 s timer would have fired.
  5. Assert TTS `speak` mock was not called.
- **Expected Result**: Timer canceled by LiveKit-native speech-state signal; no reprompt sent.

### E2E-10: VXML / degraded transport enters no-signal mode

- **Preconditions**: A simulated transport adapter that emits no speech-start events (drop them at the boundary).
- **Auth Context**: tenant + project + super-admin.
- **Steps**:
  1. Open a session over the degraded transport.
  2. Assert `voice.long_pause.disabled_no_signal` emitted at session start with `reason: 'no_speech_events'`.
  3. Hold silence 5 s.
  4. Assert no other `voice.long_pause.*` events arrive.
- **Expected Result**: Fails closed; operators have visibility via the disabled-mode event; no false reprompts dispatched.

---

## 3. Integration Test Scenarios (MANDATORY — minimum 5)

CRITICAL — integration tests use the real wiring on the boundary under test. External third-party SDKs may be DI'd; **never** mock the `InactivityMonitor` itself or any other internal module. Time control via `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` is required for race scenarios.

### INT-1: `InactivityMonitor` → TTS pipeline (hook-mode dispatch latency)

- **Boundary**: `InactivityMonitor.fire()` → `reprompt-renderer.render()` → `tts.speak()` (DI'd).
- **Setup**: Real `InactivityMonitor`, real `reprompt-renderer`, DI'd TTS provider with a synchronous `speak` mock that records the call timestamp via `performance.now()`.
- **Steps**:
  1. Configure `InactivityMonitor` with `long_pause_ms: 50`, `retries: 1`, `template: 'Hello'`.
  2. Use fake timers; arm the monitor.
  3. Capture `t0 = performance.now()` immediately before `vi.advanceTimersByTimeAsync(50)`.
  4. Capture `t1 = performance.now()` when the TTS mock fires.
  5. Assert `t1 - t0 < 100` and no LLM call was made.
- **Expected Result**: Hook dispatch under 100 ms; no LLM invocation; reprompt template rendered correctly.
- **Failure Mode**: If the renderer accidentally invokes the LLM (e.g., a stray `agent` branch), the LLM mock would record a call and the assertion would fail.

### INT-2: Threshold-inversion guard against real `conversation-behavior-resolver`

- **Boundary**: `InactivityMonitor` config resolution ↔ `parsePauseTimeoutMs` at `conversation-behavior-resolver.ts:573`.
- **Setup**: Real resolver, real `InactivityMonitor` constructor.
- **Steps**:
  1. Build a config with `on_pause: 'BRIEF'` (resolves to 800 ms) and `on_long_pause.long_pause_ms: 500`.
  2. Pass through resolver and instantiate `InactivityMonitor`.
  3. Capture the warning log via the standard `loggerSink` helper.
  4. Assert the monitor's effective `long_pause_ms === 5800` (800 + 5000 gap).
  5. Repeat with `on_pause: 'LONG'` (2500 ms) and `long_pause_ms: 2000` → assert effective value is 7500.
  6. Repeat with `long_pause_ms: 10000` (safe) → assert effective value unchanged at 10000.
- **Expected Result**: Guard fires only when inversion present; preserves safe configs; warning observable.

### INT-3: Retry budget + terminal-action dispatch

- **Boundary**: `InactivityMonitor.fire()` lifecycle → terminal handler (real, with DI'd transport hangup/transfer).
- **Setup**: Real monitor, DI'd transport with `hangup` / `transferTo` mocks.
- **Steps**:
  1. Config `retries: 2`, `terminal: { type: 'final_utterance', template: 'Goodbye' }`.
  2. Fake timers; cycle: arm → advance → fire → re-arm → advance → fire → re-arm → advance → fire (3rd time, budget exhausted).
  3. Assert `voice.long_pause.retry_budget_exhausted` emitted with `terminal_action: 'final_utterance'`.
  4. Assert TTS mock called with `"Goodbye"` once.
  5. Assert hangup mock called once after the final utterance dispatched.
  6. Repeat with `terminal: 'transfer'` and assert `transferTo` mock invoked (with fallback to `hangup` when no transfer target is configured — assert that path too).
- **Expected Result**: Three fire cycles; final-utterance + hangup sequence; transfer fallback works.

### INT-4: AudioCodes double-send suppression (fake-timer race)

- **Boundary**: `InactivityMonitor` arm ↔ AudioCodes `noInput` activity handler.
- **Setup**: Real audiocodes route handler, real monitor, fake timers. Flag `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT=false`.
- **Steps**:
  1. Open AudioCodes session; bot-utterance-complete arms the monitor at `t=0` with `long_pause_ms: 500`.
  2. `vi.advanceTimersByTimeAsync(450)` — within the 500 ms double-send guard window but before fire.
  3. Inject an upstream `noInput` activity.
  4. `vi.advanceTimersByTimeAsync(100)` — past the original fire point.
  5. Assert exactly one outbound reprompt (legacy hardcoded path).
  6. Assert `voice.long_pause.canceled` with `cause: 'upstream_noinput'`.
  7. Re-run with the upstream `noInput` arriving 600 ms (outside the guard window) — platform timer fires first, upstream `noInput` arrives later and is **suppressed** (no double-prompt).
- **Expected Result**: Deterministic race resolution in both directions; cause field accurate.

### INT-5: Twilio Media `MediaSession` ↔ `InactivityMonitor` wiring

- **Boundary**: `twilio-media-handler.ts` `MediaSession` lifecycle ↔ `InactivityMonitor`.
- **Setup**: Real `MediaSession` on a real WS server (`port: 0`). DI'd Twilio signaling client.
- **Steps**:
  1. Establish a Media WS; emit a `start` event.
  2. Emit a bot-utterance-complete event from the runtime side.
  3. Assert `InactivityMonitor.arm()` was called (verified via in-memory TraceStore `timer_armed` event).
  4. Send an inbound μ-law packet decoded as speech-start.
  5. Assert `InactivityMonitor.cancel('user_speech')` fired, no reprompt dispatched.
- **Expected Result**: Twilio audio events drive monitor lifecycle correctly.

### INT-6: KoreVG session ↔ `InactivityMonitor` wiring

- **Boundary**: `korevg-session.ts` event stream ↔ `InactivityMonitor`.
- **Setup**: Real KoreVG session class with synthetic Jambonz events; DI'd Jambonz HTTP client.
- **Steps**:
  1. Open the session; emit a bot-utterance-complete equivalent.
  2. Assert `InactivityMonitor.arm()` fired.
  3. Emit a Jambonz speech-detected event.
  4. Assert `InactivityMonitor.cancel('user_speech')` fired.
- **Expected Result**: Parity with INT-5 over the KoreVG event surface.

### INT-7: LiveKit agent-worker ↔ `InactivityMonitor` wiring via `user_state_changed`

- **Boundary**: `livekit/agent-worker.ts` event hook ↔ `InactivityMonitor` ↔ LiveKit SDK `userAwayTimeout` (configured but NOT independently armed).
- **Setup**: Real agent-worker module, LiveKit SDK DI-mocked. Spy on `AgentSession.constructor` to capture `userAwayTimeout` option.
- **Steps**:
  1. Construct the agent session; assert the LiveKit SDK received `userAwayTimeout = long_pause_ms / 1000` (e.g., 10 if `long_pause_ms=10000`).
  2. Emit a bot-utterance-complete; assert `voice.long_pause.timer_armed`.
  3. Emit `user_state_changed: listening → speaking`; assert `voice.long_pause.canceled` with `cause: 'user_speech'`.
  4. Verify no parallel `setTimeout` was scheduled (`vi.getTimerCount()` excluding LiveKit-managed timers).
- **Expected Result**: LiveKit-native primitive wrapped, not duplicated. SDK timer is the source; our `cancel()` is event-driven from `user_state_changed`.

### INT-8: TraceEvent emission contract — all 6 names + required fields

- **Boundary**: `InactivityMonitor` ↔ real `TraceStore`.
- **Setup**: Real `getTraceStore()`; `resetTraceStore()` in `beforeEach`.
- **Steps**:
  1. Drive a complete lifecycle through 2 fire cycles + exhaustion + a degraded-mode session.
  2. Collect all events via `getTraceStore().getEvents(sessionId)`.
  3. Assert each of the 6 event names occurred at least once: `timer_armed`, `canceled`, `fired`, `reprompt_sent`, `retry_budget_exhausted`, `disabled_no_signal`.
  4. Assert each carries `sessionId`, `conversationId`, `projectId`, `tenantId`, `retries_remaining`, `long_pause_ms`.
  5. Assert `cause` enum on `canceled` only takes the documented 7 values; `terminal_action` on `retry_budget_exhausted` only takes 3.
- **Expected Result**: Full event surface emitted with no field drops.

### INT-9: Metric 211 derivation correctness

- **Boundary**: TraceStore stream → Metric 211 aggregator.
- **Setup**: Real TraceStore; generate 100 synthetic sessions across 2 projects and 3 transports with deterministic fire/non-fire mix.
- **Steps**:
  1. Drive 50 sessions where `voice.long_pause.fired` emits at least once; 50 where it does not (cancel before fire).
  2. Run the Metric 211 aggregation pass for the time window covering all 100 sessions.
  3. Assert overall rate = 0.50.
  4. Assert per-project rates match the synthetic distribution (e.g., project A has 30/50 fired = 0.60; project B has 20/50 fired = 0.40).
  5. Assert per-transport segmentation matches; per-locale segmentation matches.
- **Expected Result**: Rate calculation correct; segmentation correct; no cross-project leakage.

### INT-10: Pod-restart timer hygiene

- **Boundary**: `InactivityMonitor` lifecycle ↔ session dispose.
- **Setup**: Fake timers, real monitor.
- **Steps**:
  1. Create a session, instantiate `InactivityMonitor`, arm it.
  2. Assert `vi.getTimerCount() === 1`.
  3. Call session's `dispose()`.
  4. Assert `vi.getTimerCount() === 0` (no leaked timer).
  5. Create a fresh session/monitor with the same config.
  6. Trigger a bot-utterance-complete; assert a new timer arms cleanly and emits `voice.long_pause.timer_armed` with a different `sessionId`.
- **Expected Result**: Per-connection state cleaned up; new session starts clean.

---

## 4. Unit Test Scenarios

### UNIT-1: `InactivityMonitor` constructor defaults & `enabled` gating

- **Module**: `apps/runtime/src/services/voice/inactivity-monitor.ts`.
- **Input**: Various config permutations.
- **Expected Output**:
  - No config → `long_pause_ms = 10000`, `retries = 1`, `terminal = 'hangup'`, `enabled = true`, `mode = 'hook'`.
  - `{ enabled: false }` → `arm()` is a no-op; `getTraceStore().getEvents()` is empty.
  - `{ enabled: true, long_pause_ms: 5000 }` → resolved `long_pause_ms === 5000`.

### UNIT-2: `arm()` schedules timer + emits `timer_armed`

- **Input**: Default config; call `arm()` under fake timers.
- **Expected Output**: `setTimeout` invoked with `long_pause_ms`; `getTraceStore().getEvents()` contains exactly one `voice.long_pause.timer_armed` event with all required fields.

### UNIT-3: `cancel(cause)` clears timer + emits `canceled` with cause

- **Input**: 7 cancel causes — `user_speech`, `dtmf`, `barge_in`, `bot_speaking`, `session_end`, `disconnect`, `upstream_noinput`.
- **Expected Output**: For each, `clearTimeout` invoked; trace event carries the matching `cause`. Invalid cause value → TypeScript error at compile time (verified by `tsc --noEmit`).

### UNIT-4: Fire-and-decrement loop + terminal action + degraded mode

- **Input**: Multiple `arm()` → fire cycles under fake timers; one config with `disabled_no_signal` startup flag.
- **Expected Output**:
  - Each fire decrements remaining budget; `retries_remaining` in events matches.
  - Budget exhaustion dispatches the configured terminal action.
  - Degraded-mode (`disabled_no_signal: true`) instance emits the startup event and never schedules a timer (`vi.getTimerCount() === 0`).

### UNIT-5: Threshold-inversion guard (pure function)

- **Module**: `inactivity-monitor.ts` `applyThresholdInversion(longPauseMs, eouMs)`.
- **Input**:
  - `(500, 1500)` → returns `6500`, warning flag true.
  - `(1500, 1500)` → returns `6500`, warning flag true (≤ also triggers).
  - `(10000, 1500)` → returns `10000`, no warning.
  - `(undefined, 1500)` → returns the platform default 10000.
- **Expected Output**: Pure mapping; no side effects beyond the return value + warning flag.

### UNIT-6: `reprompt-renderer` locale precedence

- **Module**: `apps/runtime/src/services/voice/reprompt-renderer.ts`.
- **Input**: Four cases —
  1. `locale_variants: { 'es-ES': 'X' }`, `template: 'Y'`, locale `es-ES` → returns `'X'`.
  2. `locale_variants: { 'es-ES': 'X' }`, `template: 'Y'`, locale `en-US` → returns `'Y'`.
  3. No `locale_variants`, no `template`, project default `'Z'`, locale `en-US` → returns `'Z'`.
  4. None of the above present → returns built-in fallback (English).
- **Expected Output**: Precedence per FR-6.

### UNIT-7: BCP-47 locale normalization

- **Input**: `en_US`, `en-us`, `EN-US` all map to `en-US` at lookup time.
- **Expected Output**: All four normalize to the canonical form before the `locale_variants` lookup.

### UNIT-8: IR schema validation (Zod or equivalent at the schema boundary)

- **Module**: `packages/compiler/src/platform/ir/schema.ts` Zod schema for `on_long_pause`.
- **Input**:
  - Valid bare-string terminals (`'hangup'`, `'transfer'`, `'final_utterance'`).
  - Valid object terminal (`{ type: 'final_utterance', template: 'Bye' }`).
  - Invalid: `terminal: 'unknown'`, `retries: -1`, `long_pause_ms: 0`.
- **Expected Output**: Valid shapes parse; invalid shapes reject with a clear error path.

---

## 5. Security & Isolation Tests

Standard cross-tenant/project/user 404 tests do **not** apply because this feature adds no new API endpoint and no new Mongo collection. The applicable isolation gates are below.

### ISO-1: Tenant scoping on every TraceEvent

- **Test**: Drive two parallel sessions for different tenants through full long-pause lifecycles.
- **Assert**: Every emitted `voice.long_pause.*` event carries the correct `tenantId`; `getTraceStore().getEvents(sessionA)` returns no events for tenant B and vice versa.
- **Why it matters**: A bug that copies `tenantId` from a shared module-level variable rather than the session would aggregate Metric 211 across tenants.

### ISO-2: Project scoping on Metric 211 aggregation

- **Test**: Same as ISO-1 but split by project within one tenant.
- **Assert**: Metric 211 segmented by `projectId` matches the per-project synthetic distribution; no cross-project leakage.

### ISO-3: Project-default template scoping

- **Test**: Set a project-default template for project A; configure project B with a different default.
- **Assert**: A session on project A renders project A's default; project B renders project B's default. A session with neither node-level nor project-level config falls through to the platform default — the platform default is identical across tenants (per design).
- **Why it matters**: The v1 implementation uses an env var for the project default; future work will move this to a tenant-/project-scoped setting (R6). The test guards the contract that defaults never leak across projects.

### ISO-4: Auth context required for session creation paths that exercise long-pause

- **Test**: Hit the existing voice WS / channel routes without auth.
- **Assert**: Existing middleware returns 401 / 403 before any `InactivityMonitor` is constructed; no long-pause TraceEvents emit.
- **Why it matters**: We must not bypass the existing centralized auth (Core Invariant #2) just because long-pause is "session-internal."

### ISO-5: Input validation rejects malformed `on_long_pause`

- **Test**: Submit agent IR with `on_long_pause: { long_pause_ms: 'foo' }` and `{ terminal: 'invalid' }`.
- **Assert**: Compiler / runtime normalization rejects with a clear error; no execution path proceeds with a malformed config.
- **Why it matters**: Defense-in-depth between authoring and runtime.

---

## 6. Performance & Load Tests

### PERF-1: Hook-driven reprompt latency distribution

- **Setup**: Real `InactivityMonitor` + real `reprompt-renderer`; DI'd TTS provider with a 0 ms synchronous stub.
- **Method**: Fire 50 sequential reprompts; measure `t_dispatch - t_fire` via `performance.now()` deltas.
- **Assert**: p95 < 100 ms; max < 250 ms. Records a baseline for regression detection. (Integration tier, deterministic.)

### PERF-2: Long-running session memory footprint

- **Setup**: Spin up 100 voice sessions in parallel, each with `InactivityMonitor` armed and re-armed for 200 cycles.
- **Assert**: No timer leaks (`vi.getTimerCount() <= 100` at the end); steady-state heap growth bounded.
- **Why it matters**: A leak in the helper would compound across thousands of concurrent calls in production.

E2E perf testing against live infrastructure is out of scope for v1.

---

## 7. Test Infrastructure

### Required services

- **MongoMemoryServer**: auto-provisioned by `startRuntimeApiHarness`.
- **Redis**: optional; integration tests that exercise the TraceStore Redis path set `REDIS_ENABLED=1` and require a local redis-server (CI pattern from existing voice tests).
- **No live external dependencies** — all TTS / LLM / Twilio / LiveKit / AudioCodes / KoreVG are DI'd at the boundary.

### Data seeding

- Helpers: `bootstrapProject`, `createChannelConnection`, `createDeployment`, `provisionTenantModel`, `setSuperAdmins`, `uniqueEmail`, `uniqueSlug`, `requestJson` — all from `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts`.
- Agent IR fixtures: define inline per test or in a shared `apps/runtime/src/__tests__/fixtures/voice-long-pause/` directory (to be created during impl).

### Environment variables

| Variable                                             | Purpose                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV=test`                                      | Standard.                                                                       |
| `MONGODB_URL`                                        | Managed by `RuntimeApiHarness`.                                                 |
| `JWT_SECRET`, `AUTH_SDK_*`                           | Managed by harness.                                                             |
| `ENCRYPTION_MASTER_KEY`                              | Managed.                                                                        |
| `REDIS_ENABLED=0`                                    | Default for unit/integration; flip to `1` for tests asserting Redis trace path. |
| `VOICE_LONG_PAUSE_DEFAULT_MS`                        | Per-test override; default `10000`.                                             |
| `VOICE_LONG_PAUSE_DEFAULT_RETRIES`                   | Per-test override; default `1`.                                                 |
| `VOICE_LONG_PAUSE_PROJECT_DEFAULT_TEMPLATE`          | Project-level default template (v1 env-driven).                                 |
| `VOICE_LONG_PAUSE_DISABLE_LEGACY_AUDIOCODES_NOINPUT` | AudioCodes migration gate; default `false` in tests unless asserting Phase 2/3. |
| `VOICE_LONG_PAUSE_THRESHOLD_INVERSION_GUARD_GAP_MS`  | Per-test override; default `5000`.                                              |

### CI configuration

- Unit tier: `pnpm --filter @agent-platform/runtime test` (uses `vitest.config.ts`).
- Integration tier: `pnpm --filter @agent-platform/runtime test:integration`.
- E2E tier: `pnpm --filter @agent-platform/runtime test:e2e`. **CRITICAL**: append new E2E files to `vitest.e2e.config.ts` `defaultInclude` array or they silently skip in CI.

### Time control

- Unit + Integration: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`. Pattern precedent: `sync-execution.test.ts:51-70`, `runtime-mcp-provider.test.ts`.
- E2E: real wall-clock with `long_pause_ms` shortened to 2000 ms in test agent fixtures.

### Trace assertion pattern

```typescript
import { getTraceStore, resetTraceStore } from '../services/trace-store.js';

beforeEach(() => resetTraceStore());

// In a test:
const events = getTraceStore().getEvents(sessionId);
expect(events.map((e) => e.name)).toEqual([
  'voice.long_pause.timer_armed',
  'voice.long_pause.fired',
  'voice.long_pause.reprompt_sent',
]);
```

Precedent: `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts:33,208,1400`.

---

## 8. Test File Mapping

| Test File                                                                                 | Type        | Covers                                   |
| ----------------------------------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `apps/runtime/src/services/voice/__tests__/inactivity-monitor.test.ts` (NEW)              | unit        | UNIT-1 .. UNIT-5, ISO-5                  |
| `apps/runtime/src/services/voice/__tests__/reprompt-renderer.test.ts` (NEW)               | unit        | UNIT-6, UNIT-7                           |
| `packages/compiler/src/platform/ir/__tests__/conversation-listening-schema.test.ts` (NEW) | unit        | UNIT-8                                   |
| `apps/runtime/src/__tests__/voice/inactivity-monitor-tts.integration.test.ts` (NEW)       | integration | INT-1, PERF-1                            |
| `apps/runtime/src/__tests__/voice/threshold-inversion.integration.test.ts` (NEW)          | integration | INT-2                                    |
| `apps/runtime/src/__tests__/voice/retry-and-terminal.integration.test.ts` (NEW)           | integration | INT-3                                    |
| `apps/runtime/src/__tests__/voice/audiocodes-double-send.integration.test.ts` (NEW)       | integration | INT-4                                    |
| `apps/runtime/src/__tests__/voice/twilio-media-monitor.integration.test.ts` (NEW)         | integration | INT-5                                    |
| `apps/runtime/src/__tests__/voice/korevg-monitor.integration.test.ts` (NEW)               | integration | INT-6                                    |
| `apps/runtime/src/__tests__/voice/livekit-monitor.integration.test.ts` (NEW)              | integration | INT-7                                    |
| `apps/runtime/src/__tests__/voice/trace-event-contract.integration.test.ts` (NEW)         | integration | INT-8, ISO-1, ISO-2, ISO-3               |
| `apps/runtime/src/__tests__/voice/metric-211.integration.test.ts` (NEW)                   | integration | INT-9                                    |
| `apps/runtime/src/__tests__/voice/pod-restart.integration.test.ts` (NEW)                  | integration | INT-10, PERF-2                           |
| `apps/runtime/src/__tests__/channels/voice-long-pause-twilio.e2e.test.ts` (NEW)           | e2e         | E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-7 |
| `apps/runtime/src/__tests__/channels/voice-long-pause-audiocodes.e2e.test.ts` (NEW)       | e2e         | E2E-6                                    |
| `apps/runtime/src/__tests__/channels/voice-long-pause-korevg.e2e.test.ts` (NEW)           | e2e         | E2E-8                                    |
| `apps/runtime/src/__tests__/channels/voice-long-pause-livekit.e2e.test.ts` (NEW)          | e2e         | E2E-9                                    |
| `apps/runtime/src/__tests__/channels/voice-long-pause-degraded.e2e.test.ts` (NEW)         | e2e         | E2E-10                                   |
| Auth-context test (extends existing voice-route auth tests, no new file)                  | e2e         | ISO-4                                    |

All new E2E files must be appended to `apps/runtime/vitest.e2e.config.ts` `defaultInclude` in the same change that adds them (CI silently skips otherwise — established gotcha in `apps/runtime/agents.md`).

---

## 9. Acceptance for Status Transitions

| Transition      | Required                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLANNED → ALPHA | All UNIT scenarios passing; E2E-1 (Twilio happy path) passing.                                                                                                       |
| ALPHA → BETA    | All UNIT + INT-1..INT-5 + INT-8 + E2E-1..E2E-5 + E2E-7 + ISO-1, ISO-2, ISO-4 passing. AudioCodes Phase-1 shadow merged with one production observation window clean. |
| BETA → STABLE   | All scenarios in this doc passing, including INT-9 (Metric 211), INT-10, E2E-6, E2E-8, E2E-9, E2E-10, ISO-3, ISO-5, PERF-1, PERF-2. R4 (AudioCodes gated) shipped.   |

---

## 10. Open Testing Questions

1. **TTS dispatch latency measurement boundary** — FR-4 says "< 100 ms (excluding TTS audio length)". The PERF-1 design measures `t_fire → t_TTS_pipeline_entry`. If the team prefers to measure to `t_first_audio_packet_out`, we must change the synthetic TTS stub to emit a fake audio frame and add a latency variance budget. Tracked for HLD review.
2. **Live LiveKit server in CI** — current design DI-mocks LiveKit. If the team later wants an integration tier against a real `livekit-server` container, INT-7 would need an extended variant. Out of scope for v1 unless the SDK contract evolves.
3. **Metric 211 aggregation owner** — INT-9 assumes an aggregator runs over the TraceStore stream. The actual aggregation surface (real-time stream consumer vs scheduled batch) is HLD territory. The test interface (consume stream, emit segmented rates) is stable regardless.
4. **Project-default template scope in v1** — currently env-driven; ISO-3's "no leakage across projects" assertion is trivial when there's only one global default. When R6 introduces a per-project default, ISO-3 must be expanded to assert true per-project isolation. Add a TODO to revisit this test then.

---

## 11. References

- Feature spec: [../features/sub-features/voice-long-pause-detection.md](../../features/sub-features/voice-long-pause-detection.md)
- Parent feature: [../features/voice-capabilities.md](../../features/voice-capabilities.md)
- JIRA: [ABLP-665](https://kore-ai.atlassian.net/browse/ABLP-665)
- CLAUDE.md Test Architecture rules — Universal + E2E sections.
- Test infra helpers:
  - `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`
  - `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts`
- Trace assertion precedent: `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts:33,208,1400`
- E2E pattern precedent: `apps/runtime/src/__tests__/channels/audiocodes-interaction-context.e2e.test.ts`, `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`
- LLM mocking precedent: `apps/runtime/src/__tests__/channels/livekit-voice.integration.test.ts` `MockAnthropicClient`
- Fake-timer pattern precedent: `apps/runtime/src/__tests__/sync-execution.test.ts:51-70`
