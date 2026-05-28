# Studio -> DB -> DSL -> Runtime Hidden Issues Audit, Pass 2

Date: 2026-05-06

Mode: Audit, design, and implementation. Changes were implemented test-first by slice with additive/backward-compatible response fields.

Scope: Follow-up matrix pass after read-surface hardening. This pass revalidates the current follow-up issue register and expands the search into lazy initialization, async resume, event bus emission, internal service API parity, session/readback merge behavior, Studio replay enrichment, and channel delivery contracts.

## Summary

The previous read-surface failures for REST chat, internal chat traces, and transcript export trace/message rendering are now closed in the master audit. This pass found that the six follow-up findings remained valid in the pre-fix tree and added one new confirmed hidden issue in the lazy ON_START execution lane. The implementation below closes the seven findings with additive contracts so existing text-only callers remain compatible.

| ID      | Severity | Area                                                                          | Status |
| ------- | -------- | ----------------------------------------------------------------------------- | ------ |
| FUP-001 | P1       | Async resumption drops structured response payloads                           | Closed |
| FUP-002 | P1       | Event bus skips structured-only agent responses                               | Closed |
| FUP-003 | P2       | Internal chat API returns text-only runtime output                            | Closed |
| FUP-004 | P2       | Session merge can suppress equal-richness envelope changes                    | Closed |
| FUP-005 | P2       | Studio trace replay only fills missing envelopes, not stale/partial envelopes | Closed |
| FUP-006 | P2       | ChannelDispatcher has no localization field in delivery contract              | Closed |
| FUP-007 | P1       | Lazy first-message ON_START drops structured-only init output                 | Closed |

## Coverage Matrix

| Lane / seam                                                    | Text | Rich content | Actions | Voice config | Localization | Persistence/readback | Status           |
| -------------------------------------------------------------- | ---- | ------------ | ------- | ------------ | ------------ | -------------------- | ---------------- |
| Studio DSL/import -> compiler IR                               | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | No new gap found |
| Lazy first-message `initializeSession()` -> `executeMessage()` | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |
| Async resume -> ChannelDispatcher                              | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |
| Runtime `message.agent` event bus                              | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |
| Internal chat service API                                      | PASS | PASS         | PASS    | PASS         | PASS         | N/A                  | Test locked      |
| Session active/persisted merge                                 | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |
| Studio trace replay enrichment                                 | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |
| ChannelDispatcher async delivery                               | PASS | PASS         | PASS    | PASS         | PASS         | PASS                 | Test locked      |

## Future-Ready Compatibility Design

The implementation keeps the stable text contract and adds optional structured fields at each boundary rather than replacing existing fields.

| Slice | Contract design                                                                                                                                          | Backward compatibility rule                                                                                            | Test lock                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1     | Resumption returns a full dispatchable result: text, action, rich content, actions, voice config, localization, metadata.                                | Existing `response` and `responseMetadata` stay unchanged. New fields are optional.                                    | `async-handoff-resume.test.ts`                                 |
| 2     | ChannelDispatcher treats localization as a first-class structured field for WebSocket, Redis pub/sub, A2A data parts, persistence, and pending delivery. | Existing web/A2A text parts are still emitted when text exists. Structured-only A2A avoids forced empty text parts.    | `channel-dispatcher.test.ts`                                   |
| 3     | Runtime event emission gates on renderable payload, not only non-empty text. Lazy init returns and emits structured-only initialization results.         | Existing text responses follow the same path. Structured-only turns now use the same `message.agent` payload builder.  | `runtime-executor.test.ts`                                     |
| 4     | Internal chat returns public channel outcome shape plus legacy fields.                                                                                   | Existing `agentResponse`, `response`, `action`, `traceEvents`, `responseMetadata`, `sessionEnded`, and `state` remain. | `internal-chat.test.ts`                                        |
| 5     | Readback and replay prefer richer or equal-richness newer envelopes when equivalent assistant text matches.                                              | Text equivalence still suppresses duplicates; only the chosen payload is upgraded.                                     | `session-message-merge.test.ts`, `replay-trace-events.test.ts` |

## Findings

### FUP-001: Async resumption drops structured response payloads

- Severity: P1
- Status: Closed
- Source file: `apps/runtime/src/services/execution/resumption-service.ts`
- Affected functions: `resumeToolResult()`, `resumeRemoteHandoff()`, `resumeHumanInput()`
- Evidence: each function calls `executeMessageWithProvenance()` and returns only `response` plus `responseMetadata` to `ChannelDispatcher`. `richContent`, `actions`, `voiceConfig`, and `localization` from the resumed `ExecutionResult` are not forwarded.
- Impact: async continuation can successfully produce structured output in runtime execution but deliver and persist text-only output after resume.
- Test lock to add: mock `executeMessage()` returning response plus `richContent`, `actions`, `voiceConfig`, and `localization`; assert the dispatched result preserves all fields.

### FUP-002: Event bus skips structured-only agent responses

- Severity: P1
- Status: Closed
- Source file: `apps/runtime/src/services/runtime-executor.ts`
- Affected paths: flow and non-flow `message.agent` emission
- Evidence: flow path still emits `message.agent` under `if (flowResult.response)`, and non-flow path still emits under `if (result.response)`. `buildMessageAgentPayload()` can carry `structuredContent` and `contentEnvelope`, but the caller gate prevents structured-only results from reaching it.
- Impact: structured-only assistant turns can be persisted/delivered but absent from platform event consumers, analytics, and event-driven replay integrations.
- Test lock to add: structured-only `ExecutionResult` with actions/rich content emits `message.agent` containing `structuredContent` and `contentEnvelope`.

### FUP-003: Internal chat API returns text-only runtime output

- Severity: P2
- Status: Closed
- Source file: `apps/runtime/src/routes/internal-chat.ts`
- Affected path: `POST /api/internal/chat/agent`
- Evidence: response currently includes `agentResponse`, `response`, `action`, rendered `traceEvents`, `responseMetadata`, `sessionEnded`, and `state`, but does not return `richContent`, `actions`, `voiceConfig`, `localization`, or a content envelope.
- Impact: service-to-service callers get a narrower runtime contract than REST chat, WebSocket, and channel outcome paths.
- Test lock to add: executor returns rich content/actions/voice config/localization; internal API response includes them or explicitly documents a text-only contract.

### FUP-004: Session merge can suppress equal-richness envelope changes

- Severity: P2
- Status: Closed
- Source file: `apps/runtime/src/routes/sessions.ts`
- Affected functions: `sessionDetailMessagesAreEquivalent()`, `preferRicherEquivalentSessionMessage()`
- Evidence: equivalence compares role and comparable text first. If text matches, different envelopes are considered equivalent. The chooser only prefers runtime when runtime richness score is strictly greater than persisted richness score.
- Impact: if persisted and runtime messages both have envelopes with equal score but different action values, localization, or rich content, stale persisted data can win.
- Test lock to add: same-role/same-text persisted and runtime messages with equal richness but different actions/localization should prefer runtime or deterministic newest envelope.

### FUP-005: Studio trace replay only fills missing envelopes, not stale or partial envelopes

- Severity: P2
- Status: Closed
- Source file: `apps/studio/src/utils/replay-trace-events.ts`
- Affected function: replay message enrichment loop around candidate messages
- Evidence: enrichment assigns `rawContent` only when `!message.rawContent` and `contentEnvelope` only when `!message.contentEnvelope`. It does not compare richness or replace partial/stale envelopes with richer trace candidates.
- Impact: Studio replay can keep stale structured payloads even when trace events contain a richer/correct content envelope.
- Test lock to add: base assistant message with partial envelope plus trace candidate with rich content/actions should upgrade to the richer envelope.

### FUP-006: ChannelDispatcher has no localization field in its delivery contract

- Severity: P2
- Status: Closed
- Source file: `apps/runtime/src/services/execution/channel-dispatcher.ts`
- Affected surfaces: local WebSocket, Redis pub/sub delivery, A2A push, pending delivery, resume message persistence
- Evidence: `DispatchableResult` includes `response`, `richContent`, `actions`, `voiceConfig`, and `responseMetadata`, but not `localization`. `buildStructuredResponseFields()` and `buildA2AResponseParts()` also omit localization.
- Impact: even after async resumption forwards full structured fields, localized ownership/provenance metadata cannot survive async delivery through this dispatcher.
- Test lock to add: dispatcher result with `localization` survives WebSocket response end, Redis pub/sub payload, pending delivery store, and A2A data part.

### FUP-007: Lazy first-message ON_START drops structured-only init output

- Severity: P1
- Status: Closed
- Source file: `apps/runtime/src/services/runtime-executor.ts`
- Affected lane: channels that rely on `executeMessage()` to lazily initialize sessions before the first user message
- Evidence: `executeMessage()` calls `initializeSession()` when `!session.initialized`, but only returns the init result when `initResult?.response` is truthy. `initializeSession()` itself can return an ON_START result containing `richContent`, `actions`, and `voiceConfig` with an empty response. In that case, the lazy init lane ignores the structured-only init output and continues processing the user's message.
- Impact: Studio/WebSocket direct `initializeSession()` lanes can preserve structured-only ON_START output, while lazy first-message lanes can skip cards, action prompts, and voice config from the same DSL.
- Test lock to add: create a session whose ON_START returns empty text with `richContent`, `actions`, and `voiceConfig`; call `executeMessage()` before explicit initialization and assert the init structured payload is returned before the user message is processed.

## Non-Findings / Reduced Risk

| Area                                     | Result                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST chat inline trace responses         | Closed by shared runtime read-surface renderer and route contract lock.                                                                                                                                                         |
| Internal chat inline trace rendering     | Trace field is now rendered through `renderRuntimeTraceEventsForReadSurface(...)`; the remaining internal-chat gap is structured output parity, not trace PII rendering.                                                        |
| Transcript export read-surface rendering | Closed for message/trace read-surface PII rendering before JSON export write.                                                                                                                                                   |
| HTTP async rich content passthrough      | `HttpAsyncAdapter.transformOutput()` can now return `structured_payload` with actions/rich content, and inbound worker includes `channel_output` in delivery payload. Localization remains outside the channel output contract. |
| AG-UI rich content transform             | Adapter now emits `RICH_CONTENT` events for authored `richContent.ag_ui` and generic rich content payloads.                                                                                                                     |
| Legacy Studio agent read-route isolation | Current route versions require project access before loading agent DSL from DB.                                                                                                                                                 |

## Recommended Slice Order

1. Preserve full `ExecutionResult` through async resumption and extend `ChannelDispatcher` localization support.
2. Emit `message.agent` for structured-only results in flow and non-flow runtime paths.
3. Fix lazy ON_START structured-only return behavior in `executeMessage()`.
4. Normalize internal chat response shape to the public channel outcome contract.
5. Improve active/persisted session merge and Studio replay enrichment with deterministic envelope richness/comparison.

## Audit Commands Used

```bash
rg -n "resumeToolResult|resumeRemoteHandoff|resumeHumanInput|executeMessageWithProvenance|ChannelDispatcher|dispatch" apps/runtime/src/services/execution/resumption-service.ts
rg -n "message\\.agent|flowResult\\.response|result\\.response|structuredContent|assistantStructuredContent" apps/runtime/src/services/runtime-executor.ts
rg -n "DispatchableResult|localization|buildStructuredResponseFields|buildA2AResponseParts|pending" apps/runtime/src/services/execution/channel-dispatcher.ts
rg -n "sessionDetailMessagesAreEquivalent|preferRicherEquivalentSessionMessage|contentEnvelope|rawContent" apps/runtime/src/routes/sessions.ts apps/studio/src/utils/replay-trace-events.ts
rg -n "transformOutput\\(|ChannelOutput|responseMetadata|richContent|voiceConfig|actions|contentEnvelope|structuredContent" apps/runtime/src/channels apps/runtime/src/services/channels apps/runtime/src/services/channel apps/runtime/src/services/message-persistence-queue.ts
rg -n "async initializeSession|initializeSession\\(" apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/channels/ws-handler.test.ts apps/runtime/src/__tests__/execution/runtime-executor.test.ts
```
