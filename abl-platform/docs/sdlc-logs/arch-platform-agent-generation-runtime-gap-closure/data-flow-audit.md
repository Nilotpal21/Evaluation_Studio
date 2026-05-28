# Data Flow Audit: Model Capability Runtime Parameters

Date: 2026-05-16

## Scope

This audit covers the provider/catalog-driven model parameter slice that replaces hardcoded assumptions like "every model supports temperature/maxTokens" with a model capability and hyperparameter contract.

## Fields Traced

| Field                                         | Definition                                                       | Presentation                                                    | Persistence                                              | Runtime Consumption                                        | Verdict |
| --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| `hyperParameters`                             | Model registry, `TenantModel`, `ModelConfig`, `AgentModelConfig` | Model capabilities route, Studio model dialogs, agent model tab | Tenant model routes, project model routes, import/export | `ModelResolutionService.extractHyperParameterValues`       | Wired   |
| `useResponsesApi`                             | Tenant/project/agent model config                                | Studio model settings                                           | Tenant model and project model routes                    | Session OpenAI provider selection/history mode             | Wired   |
| `useStreaming`                                | Tenant/project/agent model config                                | Studio model settings                                           | Tenant model and project model routes                    | Session streaming/non-streaming call path                  | Wired   |
| `supportsReasoningEffort`                     | Registry capabilities                                            | `/api/model-capabilities/:modelId`                              | N/A                                                      | Runtime strips unsupported `reasoningEffort`               | Wired   |
| `supportsThinking` / `supportsThinkingBudget` | Registry capabilities                                            | `/api/model-capabilities/:modelId`                              | N/A                                                      | Runtime maps provider thinking options only when supported | Wired   |
| `temperatureDisabled` / `topPDisabled`        | Registry capabilities                                            | Filtered UI metadata                                            | N/A                                                      | Runtime strips disabled parameters before provider calls   | Wired   |

## Boundary Checks

| Boundary                            | Evidence                                                                                                               | Result |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| Registry -> capabilities route      | `getHyperParameters(modelId)` filters unsupported parameter controls before route response.                            | Pass   |
| Capabilities route -> Studio UI     | `HyperParameterForm` supports nested sections, toggles, text/textArea, radio option children, and runtime key aliases. | Pass   |
| Studio UI -> tenant route           | Tenant model create/update schemas and proxies accept `hyperParameters`, `useResponsesApi`, and `useStreaming`.        | Pass   |
| Platform admin -> tenant model      | Provisioned model create/update schemas and sanitizers preserve dynamic parameters and execution toggles.              | Pass   |
| Tenant route -> DB                  | `TenantModel` already stores `hyperParameters`; route create/update forwards the field.                                | Pass   |
| Studio model config -> DB           | `ModelConfig` schema, Studio API schemas, and project repo update paths include `hyperParameters`.                     | Pass   |
| DB -> runtime resolution            | Tenant, project, and agent model configs are parsed into `ResolvedModelParameters`.                                    | Pass   |
| Runtime resolution -> provider call | Session LLM client forwards generic supported parameters and provider-specific thinking/reasoning options.             | Pass   |
| Project import/export               | Core assembler exports `hyperParameters`; import schemas accept it.                                                    | Pass   |

## Hidden Issues Found

1. `getDefaultHyperParameterValues()` initially defaulted every nested `radioButton` option, which would persist mutually exclusive alternatives like `temperature` and `top_p` together. Fixed by rendering radio option defaults for display while persisting option values only when a stored/user value exists.
2. Vertex and Microsoft Foundry catalog entries needed provider-specific browse identities without hardcoding those choices into Arch generation. The catalog alias layer keeps those identities in the model registry/catalog, while Arch remains model-class driven.
3. Platform-admin provisioning accepted `hyperParameters` but did not forward `useResponsesApi` or `useStreaming`; provisioned models could not be fully configured for runtime execution. Fixed the schema/create/update/sanitize path and added an E2E regression.

## Residual Risks

- The current radio control still renders alternative sliders side by side; the follow-up UX improvement is to add an actual selected-option control so users cannot intentionally submit mutually exclusive alternatives together.
- Tenant model scalar `temperature` and `maxTokens` remain required legacy DB fields. Runtime suppresses scalar sampling when a dynamic hyperparameter bag exists; a schema migration to nullable scalars would be a larger compatibility slice.
- Studio proxy route OpenAPI schemas remain intentionally minimal in a few places, but dynamic parameter fields now align for create/update/detail paths and the routes proxy runtime JSON directly.

---

# Data Flow Audit: Customer Continuity Events

Date: 2026-05-17

## Scope

This audit covers the first customer-continuity slice for Arch-authored agents:

- Arch authors shared-voice handoff behavior through a managed behavior profile.
- Runtime classifies how each channel consumes customer-visible continuity.
- HTTP Async consumes pre-action bridge text as an opt-in `agent.status` event.
- Customer-visible status text is sanitized so implementation language from generated agents cannot leak to end customers.

## Fields Traced

| Field / Value                      | Definition                                                          | Transformation                                                                                         | Delivery / Consumption                                                                        | Verdict |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------- |
| `CustomerContinuityKind`           | `apps/runtime/src/channels/customer-continuity.ts`                  | `enqueueHttpAsyncStatusDelivery()` uses `pre_action_bridge` for bridge text emitted before tool calls. | HTTP Async status metadata includes `continuity_kind: pre_action_bridge`.                     | Wired   |
| `CustomerContinuityDeliveryMode`   | `apps/runtime/src/channels/customer-continuity.ts`                  | `resolveCustomerContinuityDelivery()` maps `http_async` to `status_event`, streaming channels to text. | HTTP Async builds `agent.status`; streaming/typing/final-only modes intentionally no-op here. | Wired   |
| `message` / `response` status text | First streamed customer-visible bridge chunk from runtime execution | `normalizeCustomerContinuityText()` trims, caps length, and replaces implementation wording.           | `WebhookDelivery.payload` carries customer-safe `message` and `response`.                     | Wired   |
| `metadata.status_kind`             | Customer-continuity payload builder                                 | Fixed value `continuity`.                                                                              | HTTP Async callback consumers can identify non-final progress payloads.                       | Wired   |
| `metadata.visibility`              | Customer-continuity payload builder                                 | Fixed value `customer_visible`.                                                                        | Prevents ambiguity between internal trace/status events and customer-facing status.           | Wired   |
| `metadata.source`                  | Customer-continuity payload builder                                 | Fixed value `agent_authored`.                                                                          | Distinguishes generated/agent-authored bridge text from runtime-generated operational status. | Wired   |
| Shared-voice bridge instruction    | `packages/arch-ai/src/blueprint/managed-profiles.ts`                | Renderer attaches `USE BEHAVIOR_PROFILE: shared_voice_handoff` to shared-voice handoff targets.        | Generated specialists inherit bridge-language rules without duplicating persona prose.        | Wired   |

## Boundary Checks

| Boundary                           | Evidence                                                                                                                   | Result |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| Arch behavior profile -> ABL       | `v2-renderer.test.ts` asserts the shared profile contains bridge-language guidance and remains parseable/compilable.       | Pass   |
| Runtime chunk -> continuity helper | `inbound-worker.ts` now delegates status payload construction to `buildCustomerContinuityStatusPayload()`.                 | Pass   |
| Helper -> HTTP Async delivery      | `inbound-worker.test.ts` asserts `agent.status` payload fields and continuity metadata survive into `WebhookDelivery`.     | Pass   |
| Sanitizer -> customer surface      | `customer-continuity.test.ts` and `inbound-worker.test.ts` assert internal/tool wording becomes a neutral customer phrase. | Pass   |
| Non-HTTP channel handling          | `customer-continuity.test.ts` asserts Slack streams, LINE uses typing indicators, and sync API remains final-only.         | Pass   |

## Hidden Issues Found

1. The existing HTTP Async status path treated the first streamed chunk as customer-safe by default. That protected against buffering, but not against Arch-generated implementation language such as "call the tool." Fixed by centralizing status payload construction and sanitizing bridge text.
2. The previous plan wording framed the fix as Web Chat / `http_async` streaming. Updated the implementation plan so HTTP Async is one consumer of the broader customer-continuity contract.
3. Shared-voice handoff profiles covered handoff continuity but did not explicitly author pre-action bridge behavior. Added profile guidance so generated specialists produce natural bridge language before longer lookups/actions.

## Residual Risks

- Runtime currently builds only `pre_action_bridge` status payloads. `long_running_status` and `handoff_transition` are defined as contract values but still need execution emitters and channel rendering.
- HTTP Async has focused unit coverage for status delivery. Full callback E2E coverage for `agent.status` remains a later slice because it needs Redis/queue integration wiring.
- Voice/live channels already consume streamed text differently from HTTP Async, but this slice does not add new voice-specific timing evidence.

---

# Data Flow Audit: Runtime Topology Continuity Semantics

Date: 2026-05-17

## Scope

This audit covers the second customer-continuity slice:

- Runtime handoff/delegate traces preserve topology `experienceMode`.
- Runtime derives whether the coordination event is customer-visible or internal.
- Visible transfer transitions are emitted through the right channel consumption path.
- Silent delegates remain internal and do not expose child output to the customer.

## Fields Traced

| Field / Value              | Definition Layer                                                                                | Transformation Layer                                                                                                                                             | Consumption Layer                                                                                        | Verdict |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `experienceMode`           | Compiler IR handoff/delegate config, exposed to runtime as `HandoffConfig` / `DelegateConfigIR` | `resolveHandoffExperienceMode()` defaults missing handoffs to `shared_voice_handoff`; `resolveDelegateExperienceMode()` defaults delegates to `silent_delegate`. | Handoff, `agent_switch`, `delegate_start`, and `delegate_complete` trace payloads.                       | Wired   |
| `visibility`               | Runtime-derived from `experienceMode`                                                           | Handoffs are customer-visible except `silent_delegate`; delegates are forced internal.                                                                           | Trace payloads and HTTP Async handoff-transition filtering.                                              | Wired   |
| `suppressChildOutput`      | Runtime-derived coordination contract                                                           | Handoffs set `false`; delegates set `true`.                                                                                                                      | Operator traces distinguish customer-speaking child handoffs from silent delegates.                      | Wired   |
| `continuity.kind`          | Runtime `buildHandoffTransitionContinuity()`                                                    | `visible_handoff` / `human_escalation` produce `handoff_transition`; shared voice stays internal.                                                                | HTTP Async status queue and streaming-channel transition chunk emission.                                 | Wired   |
| `continuity.message`       | Runtime customer-visible transition text                                                        | Sanitized through `normalizeCustomerContinuityText()` before status payloads or streamed chunks.                                                                 | `agent.status.message` for HTTP Async and `onChunk()` for streaming-text channels.                       | Wired   |
| `metadata.continuity_kind` | HTTP Async status payload builder                                                               | Preserves `pre_action_bridge`, `handoff_transition`, or future `long_running_status`.                                                                            | Webhook consumers can tell bridge text from topology transition status without inspecting copy.          | Wired   |
| `metadata.source`          | HTTP Async status payload builder                                                               | Defaults to `agent_authored`; runtime topology events pass `runtime_topology`.                                                                                   | Webhook consumers and tests can distinguish authored bridge text from runtime-generated topology status. | Wired   |

## Boundary Checks

| Boundary                                   | Evidence                                                                                                                                     | Result |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| ABL/compiler IR -> runtime types           | `DelegateConfigIR` now includes `experienceMode`; `HandoffConfig` already carried it through compiler work from the prior slice.             | Pass   |
| Runtime config -> handoff trace            | Focused routing test asserts shared voice carries `experienceMode`, top-level `visibility`, `suppressChildOutput`, and internal continuity.  | Pass   |
| Runtime config -> delegate trace           | Focused routing test asserts delegates emit `silent_delegate`, `internal`, and `suppressChildOutput: true`.                                  | Pass   |
| Handoff trace -> HTTP Async status payload | Inbound worker consumes only `continuity.kind: handoff_transition` with `visibility: customer_visible` and emits `source: runtime_topology`. | Pass   |
| Handoff continuity -> streaming channels   | Routing executor emits visible handoff transition through `onChunk()` only when the channel resolves to `stream_text`.                       | Pass   |
| Sanitizer -> normal support copy           | Customer-continuity test verifies "carrier response" remains customer-safe while implementation terms still collapse to neutral text.        | Pass   |

## Hidden Issues Found

1. The first continuity slice defined `handoff_transition`, but only HTTP Async pre-action bridges had a live emitter. This left visible handoff topology semantics in traces only. Fixed by adding runtime topology continuity envelopes and an HTTP Async handoff-transition consumer.
2. Non-HTTP streaming channels needed a customer-visible chunk, not just trace metadata. Fixed by emitting the visible transfer message through `onChunk()` only for `stream_text` channels, avoiding typing-only and sync-response channels where a partial chunk would be folded into the final answer.
3. The internal-language sanitizer was too broad: it treated the word "response" as internal even in normal customer language like "carrier response." Fixed by narrowing that check to implementation phrases such as `api response`, `http response`, `json response`, and `raw response`.

## Residual Risks

- `long_running_status` is still a payload contract value, not yet emitted by a runtime timer or long-action watchdog.
- HTTP Async has focused unit coverage, but not a Redis-backed callback E2E proving `agent.status` delivery ordering through the public callback path.
- Voice/live channels rely on existing voice handoff and streaming behavior; this slice does not add provider-specific timing evidence for OpenAI/Google/Grok realtime voice.
- Full `reasoning-gather-handoff.test.ts` still exposes older multi-delegate result-merge failures unrelated to topology continuity. Those should be handled as a separate runtime delegate reliability slice.

---

# Data Flow Audit: Long-Running Continuity And Complete Filler Phrases

Date: 2026-05-17

## Scope

This audit covers the third customer-continuity slice:

- HTTP Async gets a delayed status event when a tool/action remains open past the silence threshold.
- Status events preserve ordering before the final response.
- Runtime-generated filler/status text is completed into spoken-safe phrases before emission.
- Voice/live synthetic timers are intentionally not introduced until transport evidence proves they queue behind active speech.

## Fields Traced

| Field / Value                             | Definition Layer                                       | Transformation Layer                                                                                                        | Consumption Layer                                                                                   | Verdict |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| `HTTP_ASYNC_LONG_RUNNING_STATUS_DELAY_MS` | Inbound worker runtime constant / environment override | `armHttpAsyncLongRunningStatus()` starts one timer on tool-call start traces and clears it on tool result/error/completion. | A delayed `agent.status` is queued only when the action stays open past the threshold.              | Wired   |
| `continuity_kind: long_running_status`    | `CustomerContinuityKind`                               | Inbound worker passes the kind into `buildCustomerContinuityStatusPayload()`.                                               | HTTP Async callback consumers can distinguish long-running work from pre-action bridge and handoff. | Wired   |
| `metadata.source: runtime_topology`       | Inbound worker long-running emitter                    | Preserved through status payload construction.                                                                              | Consumers can tell this is runtime-authored continuity, not model-authored text.                    | Wired   |
| Per-kind idempotency key                  | `enqueueHttpAsyncStatusDelivery()`                     | Appends the continuity kind to the delivery idempotency key.                                                                | Pre-action bridge and long-running status can both deliver once for the same inbound message.       | Wired   |
| Status queue order                        | `pendingHttpAsyncStatusDelivery` promise chain         | Status deliveries are chained before final response handling awaits the pending status work.                                | Focused worker test asserts `agent.status` is queued before `agent.response`.                       | Wired   |
| Complete phrase normalization             | `completeCustomerContinuityPhrase()`                   | Rewrites common fragments such as `Pulling...`, `Checking...`, and `Transferring...` into complete first-person sentences.  | Customer-continuity payloads, filler-service emissions, and runtime-authored handoff chunks.        | Wired   |
| Filler fallback pools                     | `apps/runtime/src/services/filler/message-pools.ts`    | Static pools now contain complete phrases by default, with emission-time normalization as a final guard.                    | Chat and voice pipeline filler events receive complete phrases.                                     | Wired   |

## Boundary Checks

| Boundary                                   | Evidence                                                                                                                                                | Result |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Tool trace -> long-running timer           | `inbound-worker.test.ts` emits `tool_call_start`, advances fake timers, and verifies no delivery before the threshold and one delivery after it.        | Pass   |
| Timer -> HTTP Async delivery               | `inbound-worker.test.ts` verifies payload metadata: `continuity_kind: long_running_status`, `visibility: customer_visible`, `source: runtime_topology`. | Pass   |
| Status -> final response ordering          | `inbound-worker.test.ts` verifies delivery queue order is `agent.status` then `agent.response`.                                                         | Pass   |
| Normalizer -> customer-continuity payloads | `customer-continuity.test.ts` verifies fragments are rewritten into complete spoken phrases and internal language is still replaced with neutral copy.  | Pass   |
| Filler service -> status event             | Filler service/integration/config propagation tests verify static, pipeline, trace-derived, and channel-configured fillers emit complete phrases.       | Pass   |
| Runtime handoff bridge -> stream chunk     | Focused routing tests verify project/localized handoff bridge messages are emitted as completed phrases.                                                | Pass   |

## Hidden Issues Found

1. The previous continuity helper only appended punctuation, which still left voice fragments such as "Pulling that up now." Fixed by rewriting common filler fragments into first-person sentences.
2. The older filler subsystem bypassed the new continuity helper and still emitted fragment-style text such as "Searching..." and "Transferring...". Fixed with emission-time normalization and complete fallback pools.
3. Runtime-authored handoff bridge copy could be streamed without final punctuation. Fixed by passing those bridge chunks through the same phrase-completion guard.
4. HTTP Async status idempotency was per message/event type, which would have dropped a later long-running status after a pre-action bridge. Fixed by adding continuity kind to the idempotency key.

## Residual Risks

- The inbound-worker and delivery-worker tests now cover both halves of queue ordering, but not a deployed Redis-backed callback E2E.
- Voice/live channels still rely on existing streaming and filler infrastructure. Timer-driven synthetic voice fillers remain blocked until evidence confirms the transport queues complete utterances instead of interrupting active TTS.
- LLM-authored streaming chunks are not buffered until sentence boundaries; that would add latency and belongs in a separate voice transport design if needed.

---

# Data Flow Audit: HTTP Async Callback Ordering

Date: 2026-05-17

## Scope

This audit covers the callback-side proof for HTTP Async continuity:

- Inbound worker queue order is already locked for `agent.status` before `agent.response`.
- Delivery worker now has a focused regression proving callback POST order when those jobs are processed in that order.
- Long-running continuity metadata survives through callback payload serialization.

## Boundary Checks

| Boundary                              | Evidence                                                                                                                                   | Result |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Inbound worker -> delivery queue      | `inbound-worker.test.ts` verifies queue add order is `agent.status` then `agent.response`.                                                 | Pass   |
| Delivery worker -> callback POST body | `delivery-worker.test.ts` processes status then response jobs and verifies callback body order is `agent.status`, `agent.response`.        | Pass   |
| Payload metadata -> callback consumer | `delivery-worker.test.ts` verifies `continuity_kind: long_running_status` survives in the callback body.                                   | Pass   |
| Delivery status update isolation      | `delivery-worker.test.ts` verifies delivered status updates include both `_id` and `tenantId`.                                             | Pass   |
| Real callback consumer boundary       | `delivery-worker.test.ts` posts status and final response payloads to a local HTTP sink and verifies the final response text appears once. | Pass   |

## Residual Risks

- This still uses focused worker tests instead of a live Redis-backed delivery worker E2E. That keeps the lock deterministic and fast, but a deployment-level smoke test would still be valuable for queue configuration drift.
- Web Chat rendering uses websocket `status_update` / `status_clear` rather than HTTP Async `agent.status`; full browser rendering proof remains a separate gap.

---

# Data Flow Audit: Voice Continuity Evidence

Date: 2026-05-17

## Scope

This audit records voice/live continuity evidence after the phrase-completion and HTTP Async status slices:

- Existing realtime handoff orchestration already waits for transfer speech completion signals before updating the live session.
- Existing voice filler paths route through TTS playback/streaming paths instead of abrupt text cancellation.
- New timer-driven voice fillers remain deferred until transport-specific queueing proof exists.

## Boundary Checks

| Boundary                                    | Evidence                                                                                                                                                                                                                             | Result   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Grok transfer speech -> live session update | `korevg-router-grok.test.ts` verifies inline session update occurs after `response.output_audio_transcript.done` and matching `response.done`, including the race where response completion arrives before tool scheduling finishes. | Pass     |
| Grok internal speech suppression            | `korevg-router-grok.test.ts` verifies authored internal handoff speech is not repeated after the live session swap.                                                                                                                  | Pass     |
| KoreVG filler playback -> final response    | Source audit: `KorevgSession` chains filler playback promises and awaits `inFlightFillerPlayback` before final response delivery in non-streaming turns.                                                                             | Evidence |
| LiveKit status -> TTS stream                | Source audit: `LiveKitRuntimeLlmAdapter` forwards `status_update` text into the same `onChunk` path consumed by the TTS stream.                                                                                                      | Evidence |

## Residual Risks

- The proof is source/focused-test evidence, not a provider-recorded audio capture.
- Timer-driven synthetic voice fillers are still intentionally blocked until OpenAI/Google/Grok realtime transports prove queued, non-interruptive playback behavior under active TTS.

---

# Data Flow Audit: Continuity Consumer Matrix

Date: 2026-05-17

## Scope

This audit covers current channel consumer behavior for customer continuity:

- HTTP Async receives retryable `agent.status` callback events.
- Streaming channels receive visible continuity text through stream chunks.
- Typing-capable non-streaming channels rely on native typing indicators instead of synthesized text status.
- Sync/final-response channels do not receive partial continuity payloads.

## Boundary Checks

| Boundary                          | Evidence                                                                                                                                   | Result |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Manifest -> continuity resolver   | `customer-continuity.test.ts` iterates every `CHANNEL_MANIFEST` row and verifies the derived continuity mode matches channel capabilities. | Pass   |
| Typing-only channels -> no text   | `customer-continuity.test.ts` verifies LINE/Telegram do not produce `agent.status` text payloads.                                          | Pass   |
| Final-only channels -> no partial | `customer-continuity.test.ts` verifies API/VXML-style final-response channels do not produce status payloads.                              | Pass   |

## Residual Risks

- Native typing indicators are currently sent at turn start. Long-running typing refresh timers are still a separate product decision because some providers rate-limit typing indicators differently.
