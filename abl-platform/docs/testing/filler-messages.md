# Feature Test Guide: Filler Messages

**Feature**: Contextual status messages during long agent operations (tool calls, handoffs, reasoning)
**Owner**: Platform team
**First tested**: 2026-03-11
**Last updated**: 2026-04-29
**Overall status**: STABLE (Phase 1), ALPHA (Phase 2 channel-config layer), PLANNED (Phase 2 voice adapters / Phase 3)

---

## Current State (as of 2026-04-29)

Phase 1 MVP is complete and stable. ABLP-710 added channel-aware filler config resolution: 61 tests now pass across 6 test files covering FillerMessageService core, static message pools, trace event integration, status tag parsing, channel-type config resolution (20 tests), and config propagation into service behavior (5 tests). The filler system resolves channel-appropriate config (chat / voice_pipeline / none) per session. Voice channel adapters (TTS emission, barge-in) remain Phase 2 work. The shared prompt builder no longer injects the `<status>` authoring instruction for voice channels as it degraded realtime spoken behavior. Phase 2 (voice adapters, DSL) and Phase 3 (Web SDK rendering, Studio panel) are not yet implemented.

### Quick Health Dashboard

| Area                         | Status | Last Verified   | Notes                                                                   |
| ---------------------------- | ------ | --------------- | ----------------------------------------------------------------------- |
| FillerMessageService core    | PASS   | 2026-03-11      | 15 unit tests                                                           |
| Static message pools         | PASS   | 2026-03-11      | 4 unit tests                                                            |
| Trace event integration      | PASS   | 2026-03-11      | 5 integration tests                                                     |
| Status tag parser            | PASS   | 2026-03-11      | 12 unit tests                                                           |
| Pipeline filler (LLM call)   | PASS   | 2026-03-11      | Covered in service tests                                                |
| WebSocket event emission     | PASS   | 2026-03-11      | Wired in handler.ts                                                     |
| RuntimeExecutor wiring       | PASS   | 2026-04-29      | Channel-type-aware config; guard skips filler block for `none` channels |
| Channel config resolution    | PASS   | 2026-04-29      | 20 contract tests; all 28 channel types mapped                          |
| Config propagation (service) | PASS   | 2026-04-29      | 5 propagation tests; disabled/chat-delay/maxPerTurn/cooldown verified   |
| Voice adapter (KoreVG)       | --     | Not implemented | Phase 2; no `<status>` prompt injection on voice bootstrap              |
| Voice adapter (Twilio)       | --     | Not implemented | Phase 2                                                                 |
| Voice adapter (LiveKit)      | --     | Not implemented | Phase 2                                                                 |
| DSL CHANNEL_SETTINGS parser  | --     | Not implemented | Phase 2                                                                 |
| Web SDK statusUpdate event   | --     | Not implemented | Phase 3                                                                 |
| ChatWidget status rendering  | --     | Not implemented | Phase 3                                                                 |
| Studio debug panel           | --     | Not implemented | Phase 3                                                                 |

---

## Test Coverage Map

### Unit Tests -- FillerMessageService (`filler-service.test.ts`)

- [x] Emits status event after delay -- `PASS`
- [x] Discards filler if cancelled before delay -- `PASS`
- [x] Respects cooldown between emissions -- `PASS`
- [x] Respects maxPerTurn limit -- `PASS`
- [x] New filler replaces pending filler -- `PASS`
- [x] Reset clears pending filler (output reached user) -- `PASS`
- [x] Destroy clears all timers -- `PASS`
- [x] Does nothing when disabled -- `PASS`
- [x] ResetTurn resets turn counter for new execution -- `PASS`
- [x] setPipelineFiller stores filler and consumePipelineFiller returns it once -- `PASS`
- [x] consumePipelineFiller returns null when no pipeline filler set -- `PASS`
- [x] Pipeline source fillers skip cooldown -- `PASS`
- [x] Pipeline filler emits immediately and cancels pending static -- `PASS`
- [x] Static filler fires after delay if no pipeline filler arrives -- `PASS`
- [x] isDestroyed returns true after destroy -- `PASS`

### Unit Tests -- Message Pools (`filler-message-pools.test.ts`)

- [x] Returns a message for each operation type (7 types) -- `PASS`
- [x] Returns message from the correct pool -- `PASS`
- [x] Avoids repeating recent messages -- `PASS`
- [x] tool_call with toolName returns tool-specific message -- `PASS`

### Unit Tests -- Status Tag Parser (`status-tag-parser.test.ts`)

- [x] Extracts status tag and strips from output -- `PASS`
- [x] Passes through text without status tags -- `PASS`
- [x] Strips tag and preserves surrounding text -- `PASS`
- [x] Handles tag split across two chunks -- `PASS`
- [x] Handles closing tag split across chunks -- `PASS`
- [x] Handles content split across chunks inside tag -- `PASS`
- [x] Flushes incomplete tag as regular text -- `PASS`
- [x] Flushes partial opening tag as regular text -- `PASS`
- [x] Handles multiple status tags in one chunk (uses last) -- `PASS`
- [x] Trims whitespace from extracted status text -- `PASS`
- [x] Handles empty status tag gracefully -- `PASS`
- [x] Handles chunk that is just the opening tag -- `PASS`

### Unit Tests -- Channel Config Resolver (`filler-config-resolver.test.ts`)

- [x] `undefined` channelType returns chat defaults -- `PASS`
- [x] Unregistered channel string returns chat defaults -- `PASS`
- [x] Empty string returns chat defaults -- `PASS`
- [x] `web_chat` returns `DEFAULT_FILLER_CONFIG` -- `PASS`
- [x] `sdk_websocket` returns `DEFAULT_FILLER_CONFIG` -- `PASS`
- [x] `slack` returns `DEFAULT_FILLER_CONFIG` -- `PASS`
- [x] `a2a` returns `DEFAULT_FILLER_CONFIG` -- `PASS`
- [x] `voice_realtime` returns `enabled:false` -- `PASS`
- [x] `voice_vxml` returns `enabled:false` -- `PASS`
- [x] `none` mode preserves other `DEFAULT_FILLER_CONFIG` fields except `enabled` -- `PASS`
- [x] `voice_pipeline` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `korevg` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `audiocodes` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `voice_twilio` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `voice_livekit` returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `voice` (generic) returns `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` -- `PASS`
- [x] `voice_pipeline` config has `voiceDelayMs:500` -- `PASS`
- [x] `voice_pipeline` config has `maxPerTurn:3` -- `PASS`
- [x] `voice_pipeline` config has `cooldownMs:5000` -- `PASS`
- [x] `voice_pipeline` config is enabled -- `PASS`

### Integration Tests -- Config Propagation (`filler-config-propagation.test.ts`)

- [x] `voice_realtime` config produces no emissions (disabled guard) -- `PASS`
- [x] `voice_vxml` config produces no emissions (disabled guard) -- `PASS`
- [x] `web_chat` filler fires after `chatDelayMs` (1200ms) -- `PASS`
- [x] `voice_pipeline` config enforces `maxPerTurn:3` -- `PASS`
- [x] `voice_pipeline` config has longer `cooldownMs` than chat -- `PASS`

### Integration Tests -- Trace Event Integration (`filler-integration.test.ts`)

- [x] tool_call trace event queues a filler that fires after delay -- `PASS`
- [x] handoff trace event queues handoff filler -- `PASS`
- [x] Fast tool completion cancels filler before user sees it -- `PASS`
- [x] Sequence: tool_call -> delay -> filler shown -> response cancels -- `PASS`
- [x] Unknown trace event types are ignored -- `PASS`

---

## E2E Test Scenarios (Phase 1 -- WebSocket)

These scenarios exercise the real system through its HTTP/WebSocket API. No mocks, no direct DB access.

### E2E-1: Status Update Emitted During Long Tool Call

**Precondition**: Agent with a tool that takes > 2s (e.g., slow HTTP endpoint).

1. Connect to WebSocket, authenticate, create session
2. Send `send_message` with query that triggers the slow tool
3. Verify `status_update` event received with:
   - `type === 'status_update'`
   - `text` is a non-empty string
   - `operation === 'tool_call'`
   - `transient === true`
4. Verify `status_clear` received when response starts streaming
5. Verify `response_chunk` events follow with actual content

### E2E-2: No Status Update for Fast Tool Completion

**Precondition**: Agent with a tool that completes in < 500ms.

1. Connect to WebSocket, authenticate, create session
2. Send `send_message` with query that triggers the fast tool
3. Verify NO `status_update` event is received
4. Verify `response_chunk` events arrive normally

### E2E-3: Multiple Sequential Tool Calls

**Precondition**: Agent with multi-step workflow (3+ sequential tool calls).

1. Connect to WebSocket, authenticate, create session
2. Send `send_message` that triggers multiple tools sequentially
3. Collect all `status_update` events
4. Verify status updates are spaced by at least `cooldownMs` (3000ms default)
5. Verify total count does not exceed `maxPerTurn` (5 default)
6. Verify each has correct `operation` field

### E2E-4: Handoff Triggers Handoff-Specific Filler

**Precondition**: Agent network with handoff configured.

1. Connect to WebSocket, authenticate, create session
2. Send message that triggers handoff to another agent
3. Verify `status_update` received with `operation === 'handoff'`
4. Verify handoff completes successfully after filler

### E2E-5: Pipeline Filler Takes Priority Over Static

**Precondition**: Agent with pipeline model configured, slow tool call.

1. Connect to WebSocket, authenticate, create session
2. Send domain-specific query (e.g., "Show me red sneakers under $100")
3. Verify first `status_update` text is contextual (mentions query terms), not generic
4. Verify filler is emitted before first `response_chunk`

### E2E-6: Status Tag Piggybacking (LLM Integration, non-voice)

**Precondition**: Non-voice session using a model that follows `<status>` tag instruction.

1. Connect to WebSocket, authenticate, create session
2. Send message that triggers tool call
3. Verify `status_update` event with piggybacked text (extracted from LLM stream)
4. Verify the LLM response text does NOT contain raw `<status>` tags
5. Verify `response_chunk` events contain clean text only

### E2E-7: Disabled Fillers Produce No Status Events

**Precondition**: Agent or project with fillers disabled.

1. Connect to WebSocket, authenticate, create session
2. Send message triggering slow tool call
3. Verify NO `status_update` events received
4. Verify normal response flow works unchanged

---

## Integration Test Scenarios

### INT-1: FillerMessageService Lifecycle

Test the full service lifecycle without external dependencies.

1. Create `FillerMessageService` with test config (short delays)
2. Queue a filler, advance timers past delay, verify emission
3. Queue another filler, cancel before delay, verify no emission
4. Queue a filler, advance past cooldown, queue another, verify second emits
5. Hit maxPerTurn, verify further queues are rejected
6. Call resetTurn, verify counter reset
7. Call destroy, verify no further emissions

### INT-2: Pipeline Filler Priority

1. Create service with delay gate
2. Queue a static filler (goes behind delay)
3. Before delay fires, queue a pipeline filler (emits immediately)
4. Verify pipeline filler emitted, static filler cancelled
5. Verify pipeline filler skips cooldown

### INT-3: Status Tag Parser Edge Cases

1. Process chunk with complete `<status>` tag -- verify extraction and stripping
2. Process tag split across 3 chunks -- verify correct reassembly
3. Process chunk with multiple tags -- verify last tag wins
4. Flush incomplete tag -- verify flushed as regular text
5. Process empty tag -- verify graceful handling

### INT-4: Trace Event to Operation Mapping

1. Verify `tool_call` trace -> `tool_call` operation
2. Verify `handoff` trace -> `handoff` operation
3. Verify `handoff_progress` trace -> `handoff` operation
4. Verify `delegate_start` trace -> `delegation` operation
5. Verify `dsl_collect` trace -> `extraction` operation
6. Verify `constraint_check` trace -> `constraint_check` operation
7. Verify unknown trace type -> null (ignored)

### INT-5: RuntimeExecutor Filler Wiring

1. Start execution with trace events enabled
2. Verify FillerMessageService is created per session
3. Verify trace events are forwarded to filler service
4. Verify `onChunk` callback cancels pending fillers
5. Verify service is destroyed on execution completion

### INT-7: Channel-Aware Config Resolution (ABLP-710)

1. Verify `resolveFillerConfig(undefined)` → chat defaults (`enabled:true`, `chatDelayMs:1200`, `maxPerTurn:5`)
2. Verify `resolveFillerConfig('voice_realtime')` → `{ enabled: false, ...chat defaults }`
3. Verify `resolveFillerConfig('voice_vxml')` → `{ enabled: false, ...chat defaults }`
4. Verify `resolveFillerConfig('voice_pipeline')` → voice defaults (`voiceDelayMs:500`, `maxPerTurn:3`, `cooldownMs:5000`)
5. Verify `resolveFillerConfig('korevg')` → same as `voice_pipeline`
6. Verify disabled config propagates: `FillerMessageService` created with disabled config emits nothing after `queueFiller` + timer advance
7. Verify voice_pipeline maxPerTurn:3 cap: 4 queued fillers → only 3 emitted

**Test file**: `apps/runtime/src/__tests__/extraction/filler-config-propagation.test.ts` ✅

### INT-6: WebSocket Event Format Validation

1. Call `ServerMessages.statusUpdate(sessionId, text, operation, index)`
2. Verify returned object shape: `{ type, sessionId, text, operation, transient, index }`
3. Call `ServerMessages.statusClear(sessionId)`
4. Verify returned object shape: `{ type, sessionId }`

---

## Phase 2 Test Scenarios (Voice -- PLANNED)

### E2E-V1: KoreVG Voice Filler During Tool Call

1. Establish KoreVG voice session
2. Send voice utterance that triggers slow tool
3. Verify `say` verb emitted with filler text and `bargeIn: true`
4. Verify TTS audio reaches caller
5. Verify filler cancelled when response starts

### E2E-V2: Twilio Voice Filler with Barge-In

1. Establish Twilio media stream session
2. Trigger slow tool call
3. Verify filler TTS audio chunks sent to Twilio
4. Send user speech (barge-in) during filler
5. Verify filler audio interrupted and user speech processed

### E2E-V3: LiveKit Voice Filler

1. Join LiveKit room as agent
2. Receive user audio transcription triggering slow tool
3. Verify synthetic assistant text injected as filler
4. Verify filler cancelled on response

### INT-V1: Voice Session Registry

1. Register voice handler for session
2. Verify `get(sessionId)` returns handler
3. Unregister handler
4. Verify `get(sessionId)` returns undefined
5. Verify max size eviction (10,000 entries)
6. Verify TTL eviction (1 hour)

### INT-V2: DSL CHANNEL_SETTINGS Parsing

1. Parse agent DSL with `CHANNEL_SETTINGS.status_messages` section
2. Verify IR output includes `channel_settings.status_messages`
3. Verify config resolution: agent DSL > project > defaults
4. Verify custom message pools override defaults

---

## Phase 3 Test Scenarios (Web SDK -- PARTIAL)

### E2E-SDK1: ChatClient Status Events

1. Connect ChatClient to server
2. Trigger slow tool call
3. Verify `statusUpdate` event emitted with `{ text, operation, transient }`
4. Verify `statusClear` event emitted on response

### E2E-SDK2: ChatWidget Status Rendering

1. Mount ChatWidget in browser
2. Trigger slow tool call
3. Verify transient status text appears below typing indicator
4. Verify status text disappears when response arrives
5. Verify status text is NOT added to message history

**Current proof**: component-level DOM regression in
`packages/web-sdk/src/__tests__/react-components.test.tsx` mounts the real React
`AgentProvider` + `ChatWidget`, injects `status_update`, verifies the transient
status renders outside `[data-testid="message-list"]`, repeats the same update
without duplicating the indicator, then injects `response_end` and verifies the
status clears while the final response remains in history.

### E2E-SDK3: React AgentProvider statusText

1. Use `useAgent()` hook in React component
2. Trigger slow tool call
3. Verify `statusText` updates from null to filler text
4. Verify `statusText` returns to null on response

**Current proof**: `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`
covers the transport-mode React provider path used by Studio chat. It verifies
chat `statusUpdate` events populate `useChat().statusMessage` and a final
assistant message clears that state.

**Remaining gap**: a full Playwright run against a live Runtime/Studio session
that triggers a real slow tool call is still pending; the current proof is
deterministic component/browser-DOM coverage.

---

## Iteration Log

### Iteration 1 -- 2026-03-11 (MVP Implementation)

**Scope**: Phase 1 core service, message pools, WebSocket integration, RuntimeExecutor wiring

**Results**: 34/34 tests passing

- FillerMessageService: 14 tests (delay, cancel, cooldown, maxPerTurn, pipeline priority, destroy)
- Message pools: 4 tests (all operations, correct pool, dedup, tool-specific)
- Integration: 5 tests (trace mapping, fast cancel, sequence, unknown events)
- Status tag parser: 11 tests (complete tags, split chunks, flush, multiple tags, edge cases)

**Findings**: All Phase 1 scenarios passing. Pipeline filler and piggybacked filler priority correctly supersede static fallback. Status tag parser handles all cross-chunk edge cases.

### Iteration 2 -- 2026-03-23 (SDLC Formalization)

**Scope**: Formalized test spec with E2E scenarios, integration scenarios, and phase 2-3 plans

**Results**: No new test execution -- existing 34 tests confirmed still passing. Added 7 E2E scenarios, 6 integration scenarios for Phase 1, plus Phase 2 (5 scenarios) and Phase 3 (3 scenarios) plans.

### Iteration 3 -- 2026-04-29 (ABLP-710: Channel-Aware Filler Config)

**Scope**: Channel-type-aware config resolution — `ChannelFillerMode` manifest field, `resolveFillerConfig` pure function, `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`, runtime-executor wiring.

**Results**: 59/59 tests passing (+25 new tests across 2 new test files)

- Config resolver contract: 20 tests (all 28 channel types mapped, shape contract verified)
- Config propagation: 5 tests (disabled guard, chat delay gate, voice maxPerTurn cap, cooldown comparison)
- Existing 34 tests: no regressions

**Key findings**: `voice_realtime` and `voice_vxml` now skip the entire filler block (FillerMessageService, StatusTagParser, pipeline-filler call) via the `resolvedFillerConfig.enabled` guard. Voice pipeline channels (korevg, audiocodes, voice_pipeline, voice_twilio, voice_livekit, voice) get tighter config (maxPerTurn:3, cooldownMs:5000) appropriate for TTS latency characteristics.
