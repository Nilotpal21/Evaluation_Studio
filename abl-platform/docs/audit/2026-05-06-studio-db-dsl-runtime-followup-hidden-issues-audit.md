# Studio to Runtime Follow-up Hidden Issues Audit

Date: 2026-05-06

Scope: Follow-up audit after the structured-output fixes in the current workspace. This pass focuses on adjacent runtime/read-surface seams that still propagate a narrower payload than the canonical `ExecutionResult` and persisted message envelope.

Mode: Audit plus implementation tracker. The issues below were implemented with test-first regression locks in the current workspace.

## Summary

The latest workspace has fixed the previously reported action interpolation, WebSocket structured-content helper bypass, trace replay text-only synthesis, and `dsl_respond.rendered` summary issues. The remaining hidden gaps are now mostly in secondary execution/read paths:

| Finding                                                                                   | Severity | Status |
| ----------------------------------------------------------------------------------------- | -------- | ------ |
| FUP-001: Async resumption drops structured response payloads                              | P1       | Fixed  |
| FUP-002: Event bus skips structured-only agent responses                                  | P1       | Fixed  |
| FUP-003: Internal chat API returns text-only runtime output                               | P2       | Fixed  |
| FUP-004: Session merge can still suppress equal-richness envelope changes                 | P2       | Fixed  |
| FUP-005: Studio trace replay only fills missing envelopes, not stale or partial envelopes | P2       | Fixed  |
| FUP-006: ChannelDispatcher has no localization field in its delivery contract             | P2       | Fixed  |

## Future-ready Design

The implementation follows one contract: `ExecutionResult` is the canonical runtime response shape until the final channel/read-surface boundary. Every secondary path should either carry the full structured payload (`richContent`, `actions`, `voiceConfig`, `localization`, `responseMetadata`) or explicitly convert it through the canonical envelope/outcome helpers.

Canonical seams used by this pass:

| Concern                         | Canonical seam                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Async delivery payload          | `DispatchableResult` plus `buildStructuredResponseFields()` in `channel-dispatcher.ts`              |
| Event-bus agent message payload | `emitRenderableAgentMessage()` plus `buildMessageAgentPayload()` in `runtime-executor.ts`           |
| API response normalization      | `buildExecutionOutcome()` and `buildExecutionResultContentEnvelope()` in `internal-chat.ts`         |
| Session read-surface merging    | `preferRicherEquivalentSessionMessage()` in `sessions.ts`                                           |
| Trace replay enrichment         | candidate-vs-current envelope richness comparison in `replay-trace-events.ts`                       |
| Localization propagation        | `PersistedMessageLocalizationOwnershipV1` carried with the same structured response fields as voice |

Implementation slices:

| Slice | Result                                                                                          | Regression lock                 |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| 1     | Async resumption now returns a dispatchable result with rich content, actions, voice, locale.   | `async-handoff-resume.test.ts`  |
| 2     | ChannelDispatcher now includes localization in WebSocket, A2A, and persisted structured fields. | `channel-dispatcher.test.ts`    |
| 3     | Runtime event bus emits `message.agent` for structured-only responses.                          | `runtime-executor.test.ts`      |
| 4     | Internal chat returns the same structured outcome/envelope family as public runtime surfaces.   | `internal-chat.test.ts`         |
| 5     | Session merge prefers active runtime envelopes when richness ties.                              | `session-message-merge.test.ts` |
| 6     | Studio replay upgrades stale or partial persisted envelopes from richer trace candidates.       | `replay-trace-events.test.ts`   |

## Findings

### FUP-001: Async resumption drops structured response payloads

| Field           | Value                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Severity        | P1                                                                                                         |
| Status          | Confirmed                                                                                                  |
| Source file     | `apps/runtime/src/services/execution/resumption-service.ts`                                                |
| Affected path   | Async tool result resume, remote handoff resume, human input resume, channel delivery, message persistence |
| Regression lock | Added                                                                                                      |

Evidence: `resumeToolResult()`, `resumeRemoteHandoff()`, and `resumeHumanInput()` call `executeMessageWithProvenance()`, but each returns only `{ response, responseMetadata }` to `ChannelDispatcher`. Any `richContent`, `actions`, `voiceConfig`, or `localization` on the resumed `ExecutionResult` is discarded before delivery and before `ChannelDispatcher` persists the resumed assistant message.

Impact: If an async continuation resumes into a flow step or agent response that produces buttons, cards, voice settings, or localized ownership metadata, the live response and durable message history become text-only.

Test lock: `async-handoff-resume.test.ts` now covers `response`, `richContent`, `actions`, `voiceConfig`, and `localization` through resumed channel dispatch.

### FUP-002: Event bus skips structured-only agent responses

| Field           | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Severity        | P1                                                                                                        |
| Status          | Confirmed                                                                                                 |
| Source file     | `apps/runtime/src/services/runtime-executor.ts`                                                           |
| Affected path   | `message.agent` platform events, analytics, trace/event consumers, replay surfaces fed by platform events |
| Regression lock | Added                                                                                                     |

Evidence: Runtime emits `message.agent` only under `if (flowResult.response)` for flow results and `if (result.response)` for normal results. The canonical persistence path already treats `result.response || assistantStructuredContent` as renderable, but the event-bus path still requires text.

Impact: Structured-only assistant output, for example an actions-only choice prompt or rich-card-only response, can be persisted and delivered but never emitted as a `message.agent` event. Downstream analytics, replay, and integration consumers will see an incomplete turn.

Test lock: `runtime-executor.test.ts` now verifies empty results do not emit, while actions-only structured results emit `message.agent` with `structuredContent` and `contentEnvelope`.

### FUP-003: Internal chat API returns text-only runtime output

| Field           | Value                                      |
| --------------- | ------------------------------------------ |
| Severity        | P2                                         |
| Status          | Confirmed                                  |
| Source file     | `apps/runtime/src/routes/internal-chat.ts` |
| Affected path   | Internal/service-token chat execution API  |
| Regression lock | Added                                      |

Evidence: The route executes the runtime and returns `agentResponse`, `response`, `action`, `traceEvents`, `responseMetadata`, `sessionEnded`, and `state`. It does not use `buildExecutionOutcome()` and does not return `richContent`, `actions`, `voiceConfig`, `localization`, or `contentEnvelope`.

Impact: Internal clients see a narrower execution contract than public chat/WebSocket clients. A service caller can run the same agent and lose structured UI/action payloads that are available through other runtime surfaces.

Test lock: `internal-chat.test.ts` now covers rich content, actions, voice config, localization, `contentEnvelope`, and normalized public outcome.

### FUP-004: Session merge can still suppress equal-richness envelope changes

| Field           | Value                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| Severity        | P2                                                                             |
| Status          | Confirmed                                                                      |
| Source file     | `apps/runtime/src/routes/sessions.ts`                                          |
| Affected path   | Session detail read surface when active runtime and persisted messages overlap |
| Regression lock | Added                                                                          |

Evidence: The latest fix adds richness scoring and prefers the richer equivalent message, which fixes stale text-only rows. However `sessionDetailMessagesAreEquivalent()` still treats same-role, same-text messages as equivalent without comparing `contentEnvelope` or metadata, and `preferRicherEquivalentSessionMessage()` keeps the persisted message when the scores tie.

Impact: If the persisted and runtime messages both have envelopes but the runtime envelope has different action values, updated localization, or corrected rich content with the same score, the stale persisted envelope can still win.

Test lock: `session-message-merge.test.ts` now covers identical text/equal richness with different action payloads and prefers the active runtime message.

### FUP-005: Studio trace replay only fills missing envelopes, not stale or partial envelopes

| Field           | Value                                          |
| --------------- | ---------------------------------------------- |
| Severity        | P2                                             |
| Status          | Confirmed                                      |
| Source file     | `apps/studio/src/utils/replay-trace-events.ts` |
| Affected path   | Studio session replay and trace augmentation   |
| Regression lock | Added                                          |

Evidence: Trace replay now extracts `contentEnvelope` from `agent_response` events, but enrichment only assigns `rawContent` or `contentEnvelope` when the base message lacks those fields. A persisted message with a partial or stale envelope is not upgraded from a richer trace candidate.

Impact: Studio can still show stale structured payloads after replay if the stored message already has any envelope, even when trace data contains a more complete/correct envelope.

Test lock: `replay-trace-events.test.ts` now covers upgrading a partial persisted envelope from a richer `message.agent` trace candidate.

### FUP-006: ChannelDispatcher has no localization field in its delivery contract

| Field           | Value                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Severity        | P2                                                                                                         |
| Status          | Confirmed contract gap                                                                                     |
| Source file     | `apps/runtime/src/services/execution/channel-dispatcher.ts`                                                |
| Affected path   | Async delivery via local WebSocket, Redis pub/sub, A2A push, pending delivery, resumed message persistence |
| Regression lock | Added                                                                                                      |

Evidence: `DispatchableResult` includes `response`, `richContent`, `actions`, `voiceConfig`, and `responseMetadata`, but not `localization`. `buildStructuredResponseFields()` and `buildA2AResponseParts()` likewise omit localization.

Impact: Even after resumption starts preserving structured fields, localized ownership metadata cannot survive async delivery through `ChannelDispatcher`.

Test lock: `channel-dispatcher.test.ts` now covers localization through async WebSocket delivery, canonical persistence, and A2A structured data parts.

## Recommended Fix Slices

| Slice | Scope                                                                 | Files                                            |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 1     | Preserve full `ExecutionResult` through async resumption              | `resumption-service.ts`, `channel-dispatcher.ts` |
| 2     | Emit `message.agent` for structured-only output                       | `runtime-executor.ts`, event-bus tests           |
| 3     | Normalize internal chat to the public channel outcome contract        | `internal-chat.ts`                               |
| 4     | Compare or prefer richer structured envelopes in read-surface merging | `sessions.ts`, `replay-trace-events.ts`          |
| 5     | Add localization to async channel dispatch contracts                  | `channel-dispatcher.ts`, pending delivery tests  |

## Current Non-findings From This Pass

| Area                                             | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Normal FLOW action interpolation                 | Fixed in current workspace.                                                  |
| WebSocket/SDK/chat structured persistence helper | Fixed in current workspace via `buildPersistedAssistantStructuredContent()`. |
| `dsl_respond` summary field                      | Fixed in current workspace.                                                  |
| Trace replay structured candidate extraction     | Fixed for missing-envelope cases.                                            |
