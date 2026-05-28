# Channel Parity Matrix

**Date:** 2026-03-31  
**Status:** In Progress — near-complete parity audit artifact  
**Scope:** Final cross-channel parity review for auth, session lifecycle, omnichannel history, identity/contact, payloads/actions/attachments/forms, streaming/typing/thoughts, proactive notifications, session closure, and terminal outcome evidence.

## Notes

- This matrix groups by **channel family**, not by every individual route or adapter.
- `sdk_chat`, `sdk_websocket`, and `web_chat` should be treated as one logical SDK conversational family; protocol and transport are the main intentional differences, while forms, attachments, and proactive notifications are explicit parity checks. In the runtime manifest today, `sdk_chat` is a logical family label rather than a separate channel key.
- Voice transport families are intentionally split for delivery/runtime reasons, but `voice_vxml`, `korevg`, `audiocodes`, `voice_twilio`, and `voice_livekit` now share an explicit `voice_core` semantic behavior profile in the runtime contract. That means parity review should distinguish transport gaps from shared voice-runtime behavior.
- The runtime contract now also distinguishes **session closure semantics** from **terminal outcome evidence**. That matters most for voice: Twilio and KoreVG can derive stronger final disposition than AudioCodes/VXML/LiveKit, even when all of them eventually close the underlying session.
- **Preview is the only active SDK consumer today**, so the SDK-facing rows focus on Preview-relevant behavior rather than hypothetical downstream SDK adopters.
- `a2a` is in scope for the final audit and must be represented explicitly rather than folded into a generic “special stack” bucket.
- The explicit runtime contract in [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts) is now the primary source of truth for: attachments, forms, proactive delivery, presence semantics, session closure, and session outcome evidence. The checklist below expands the audit for the remaining cross-cutting concerns that are not fully obvious from the per-channel row alone.
- Status legend:
  - `Working`: behavior is explicit, implemented, and backed by the current contract
  - `Partial`: behavior exists but is inconsistent, limited to some channels in the family, or lacks the desired UX/contract completeness
  - `Gap`: missing or still effectively outside the intended contract

## Family Matrix

| Family                          | Channels                                                                                                       | Auth / Auth Profiles / OAuth | Session Lifecycle / History | Identity / Verification / Contact | Payloads / Actions / Attachments / Forms | Streaming / Typing / Thoughts / Presence | Proactive / Session Closure / Traceability | Overall |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------- | --------------------------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------------------ | ------- |
| Studio debug                    | `web_debug`                                                                                                    | Working                      | Partial                     | Partial                           | Working                                  | Partial                                  | Working                                    | Partial |
| SDK conversational surfaces     | `sdk_chat`, `sdk_websocket`, `web_chat`                                                                        | Partial                      | Partial                     | Partial                           | Working                                  | Partial                                  | Working                                    | Partial |
| SDK voice surfaces              | `voice`, `voice_pipeline`, `voice_realtime`                                                                    | Partial                      | Partial                     | Partial                           | Partial                                  | Partial                                  | Partial                                    | Partial |
| HTTP sync                       | `api`, `http`                                                                                                  | Working                      | Working                     | Working                           | Working                                  | Gap                                      | Working                                    | Working |
| HTTP async                      | `http_async`                                                                                                   | Working                      | Working                     | Partial                           | Working                                  | Gap                                      | Partial                                    | Partial |
| Messaging async adapters        | `slack`, `line`, `msteams`, `whatsapp`, `messenger`, `instagram`, `telegram`, `zendesk`, `twilio_sms`, `email` | Partial                      | Partial                     | Partial                           | Partial                                  | Partial                                  | Partial                                    | Partial |
| Sync webhook / telephony bridge | `genesys`, `voice_vxml`, `audiocodes`, `voice_twilio`, `korevg`                                                | Partial                      | Partial                     | Partial                           | Partial                                  | Partial                                  | Partial                                    | Partial |
| LiveKit voice                   | `voice_livekit`                                                                                                | Partial                      | Partial                     | Partial                           | Partial                                  | Partial                                  | Partial                                    | Partial |
| A2A                             | `a2a`                                                                                                          | Partial                      | Working                     | Gap                               | Partial                                  | Partial                                  | Partial                                    | Partial |
| AG-UI / special stack           | `ag_ui`                                                                                                        | Gap                          | Partial                     | Partial                           | Partial                                  | Gap                                      | Partial                                    | Partial |

## Dimension Checklist

| Dimension                                                | Current State         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Main Remaining Gap                                                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth profiles / preflight / JIT auth                     | **Partial**           | Interactive preflight/JIT flows are explicit on websocket surfaces in [apps/runtime/src/websocket/handler.ts](../../apps/runtime/src/websocket/handler.ts) and [apps/runtime/src/websocket/sdk-handler.ts](../../apps/runtime/src/websocket/sdk-handler.ts); outcome-only preflight exists on HTTP/messaging/voice families via the shared auth preflight and outcome path.                                                                                                                                                                                                                                                            | The remaining work is parity proof and documentation on non-chat families: some channels intentionally stay `unsupported`, but that needs to be clearly treated as an intentional contract difference rather than an implicit omission.         |
| Async OAuth / callback resumption                        | **Partial**           | JIT OAuth and callback resumption are centralized in [apps/runtime/src/services/tool-oauth-service.ts](../../apps/runtime/src/services/tool-oauth-service.ts), with websocket initiation in [apps/runtime/src/websocket/handler.ts](../../apps/runtime/src/websocket/handler.ts) and [apps/runtime/src/websocket/sdk-handler.ts](../../apps/runtime/src/websocket/sdk-handler.ts); channel OAuth exists separately in [apps/runtime/src/services/channel-oauth](../../apps/runtime/src/services/channel-oauth).                                                                                                                        | The runtime behavior exists, but the audit still needs one explicit cross-family statement about where async OAuth is first-class (SDK/debug/auth-profile flows) versus where connection/provider OAuth is a separate control-plane concern.    |
| Session lifecycle / omnichannel history                  | **Partial**           | Canonical session continuity is explicit in [apps/runtime/src/routes/chat.ts](../../apps/runtime/src/routes/chat.ts), [apps/runtime/src/channels/session-resolver.ts](../../apps/runtime/src/channels/session-resolver.ts), [packages/web-sdk/src/core/SessionManager.ts](../../packages/web-sdk/src/core/SessionManager.ts), and A2A `contextId -> sessionId` mapping in [packages/a2a/src/infrastructure/agent-executor-adapter.ts](../../packages/a2a/src/infrastructure/agent-executor-adapter.ts). Omnichannel recall/join is explicit in [apps/runtime/src/routes/omnichannel.ts](../../apps/runtime/src/routes/omnichannel.ts). | Messaging and voice continuity are materially better than before, but the final audit still needs to pin down which families support full omnichannel history/join versus artifact-only continuity.                                             |
| Identity management / verification / contact support     | **Partial**           | Provider verification strength is explicit in [apps/runtime/src/routes/channel-connection-identity-utils.ts](../../apps/runtime/src/routes/channel-connection-identity-utils.ts), identity/contact linking is implemented in [apps/runtime/src/channels/session-resolver.ts](../../apps/runtime/src/channels/session-resolver.ts), and contact context support exists in [apps/runtime/src/services/contact-context-service.ts](../../apps/runtime/src/services/contact-context-service.ts).                                                                                                                                           | The main remaining parity work is voice-family and A2A positioning: A2A still has conversation continuity without end-user identity/contact parity, and voice families vary between artifact-only linkage and stronger contact semantics.       |
| Payloads / actions / attachments / forms / normalization | **Partial**           | The runtime contract now explicitly models attachment, form, and rich payload modes; SDK chat/Preview attachment parity is landed, messaging adapters preserve channel-native transforms, and A2A now preserves `richContent`, `actions`, and inline file parts through [packages/a2a/src/infrastructure/agent-executor-adapter.ts](../../packages/a2a/src/infrastructure/agent-executor-adapter.ts) and [apps/runtime/src/services/a2a/attachment-ingestor.ts](../../apps/runtime/src/services/a2a/attachment-ingestor.ts).                                                                                                           | The remaining work is mostly documentation/audit quality: some families intentionally normalize into artifacts, telephony text, or channel-native cards rather than the chat widget payload model, and those differences need to stay explicit. |
| Streaming / typing / thoughts / presence                 | **Partial**           | SDK chat and voice surfaces expose typing/thought events via [packages/web-sdk/src/core/types.ts](../../packages/web-sdk/src/core/types.ts), [packages/web-sdk/src/react/AgentProvider.tsx](../../packages/web-sdk/src/react/AgentProvider.tsx), and [packages/web-sdk/src/voice/VoiceClient.ts](../../packages/web-sdk/src/voice/VoiceClient.ts). Messaging/telephony families vary by adapter, and A2A exposes status/artifact/task streaming rather than chat thoughts.                                                                                                                                                             | The open issue is not “no implementation”; it is making the remaining intentional family differences explicit and auditing whether any voice or messaging family is over-claiming presence semantics.                                           |
| Proactive delivery / outbound updates                    | **Working / Partial** | SDK chat now supports `ON_START` plus live/reconnect async updates via [apps/runtime/src/websocket/sdk-handler.ts](../../apps/runtime/src/websocket/sdk-handler.ts) and [apps/runtime/src/services/execution/channel-dispatcher.ts](../../apps/runtime/src/services/execution/channel-dispatcher.ts). Messaging remains `channel_native`, and A2A push notification delivery is explicit in [packages/a2a/src/application/push-notification-delivery.ts](../../packages/a2a/src/application/push-notification-delivery.ts).                                                                                                            | The core mechanics are in place; the remaining work is documenting the transport-specific differences so “proactive” is not interpreted as identical across SDK chat, A2A push, and channel-native messaging.                                   |
| Session closure / terminal outcome evidence              | **Partial**           | Session closure and outcome evidence are now distinct contract dimensions in [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts). Twilio status callbacks, KoreVG disconnect attribution, and shared voice lifecycle cleanup have all been tightened.                                                                                                                                                                                                                                                                                                               | The last open issue is a final voice-family comparison so closure semantics, disposition confidence, and contact-side expectations are documented precisely enough for operations and product teams.                                            |

## Evidence And Remaining Gaps

### Studio debug

**Evidence**

- Contract row: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)
- Config banner + observability projection: [apps/studio/src/hooks/useSessionHealth.ts](../../apps/studio/src/hooks/useSessionHealth.ts), [apps/studio/src/store/session-store.ts](../../apps/studio/src/store/session-store.ts)
- Interactive auth semantics and event payloads: [apps/runtime/src/websocket/events.ts](../../apps/runtime/src/websocket/events.ts), [apps/runtime/src/websocket/handler.ts](../../apps/runtime/src/websocket/handler.ts)

**Why partial**

- Session lifecycle is stronger than most channels (`create_resume_join`), but identity/contact behavior is intentionally weaker than SDK/session-linked paths.
- Thoughts stream into Studio debug traces and message state, but typing/thought UX is still not represented in the explicit channel contract.

**Next slice**

- Add thoughts/typing/session-closure semantics into the explicit parity contract, not just the runtime/store implementation.

### SDK conversational surfaces

**Evidence**

- Transport contract: [packages/web-sdk/src/transport/types.ts](../../packages/web-sdk/src/transport/types.ts), [packages/web-sdk/src/transport/DefaultTransport.ts](../../packages/web-sdk/src/transport/DefaultTransport.ts)
- Session lifecycle / omnichannel history: [packages/web-sdk/src/core/SessionManager.ts](../../packages/web-sdk/src/core/SessionManager.ts), [packages/web-sdk/src/core/AgentSDK.ts](../../packages/web-sdk/src/core/AgentSDK.ts)
- Chat / action / upload behavior: [packages/web-sdk/src/chat/ChatClient.ts](../../packages/web-sdk/src/chat/ChatClient.ts)
- Runtime websocket chat path (including attachments, queued-behind-auth messages, `ON_START` greetings, reconnect replay, and live async update delivery): [apps/runtime/src/websocket/sdk-handler.ts](../../apps/runtime/src/websocket/sdk-handler.ts)
- Async delivery bridge: [apps/runtime/src/services/execution/channel-dispatcher.ts](../../apps/runtime/src/services/execution/channel-dispatcher.ts)
- Explicit parity contract rows and guardrail test:
  - [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)
  - [apps/runtime/src/**tests**/channels/channel-behavior-contract.test.ts](../../apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts)
- Preview app handling: [apps/studio/src/app/preview/page.tsx](../../apps/studio/src/app/preview/page.tsx), [apps/studio/src/app/preview/[projectId]/page.tsx](../../apps/studio/src/app/preview/[projectId]/page.tsx)
- Preview attachment upload path: [apps/studio/src/components/preview/PreviewChatComposer.tsx](../../apps/studio/src/components/preview/PreviewChatComposer.tsx), [apps/studio/src/components/preview/preview-attachment-upload.ts](../../apps/studio/src/components/preview/preview-attachment-upload.ts)
- Rich form/action renderers:
  - [packages/web-sdk/src/templates/renderers/form.ts](../../packages/web-sdk/src/templates/renderers/form.ts)
  - [packages/web-sdk/src/templates/renderers/actions.ts](../../packages/web-sdk/src/templates/renderers/actions.ts)
- React widget attachment/input UX:
  - [packages/web-sdk/src/react/components/ChatInput.tsx](../../packages/web-sdk/src/react/components/ChatInput.tsx)
  - [packages/web-sdk/src/react/components/ChatWidget.tsx](../../packages/web-sdk/src/react/components/ChatWidget.tsx)

**Why partial**

- This family should be treated as one logical contract across `sdk_chat`, `sdk_websocket`, and `web_chat`; the remaining partial status is mostly about making those protocol differences explicit rather than leaving them implied.
- Preflight/JIT auth payloads are now materially better in Preview, but session lifecycle and live-session history are still stronger in the SDK core than in the current Preview UX.
- Thoughts and typing already exist in the SDK event model and React widget/provider surface, but the family still lacks an explicit parity statement for thought streaming, typing indicators, and presence semantics across all three transports.
- Attachment upload now exists across the SDK conversational family, including Preview, form/action rendering exists in the template/rendering layer, session-closure UX is explicit in both Preview surfaces, and the runtime now supports both `ON_START` greetings and async/reconnect updates for the websocket-backed SDK family.
- The main remaining gap in this family is no longer outbound delivery itself; it is making typing/thought/presence semantics and transport-only differences explicit across Preview, SDK websocket, and SDK chat surfaces.

**Next slice**

- SDK-family audit focused on: protocol differences, thought/typing semantics, and any remaining transport-only behavioral drift.

### SDK voice surfaces

**Evidence**

- Voice transport/event model: [packages/web-sdk/src/voice/VoiceClient.ts](../../packages/web-sdk/src/voice/VoiceClient.ts)
- Shared SDK contracts: [packages/web-sdk/src/core/types.ts](../../packages/web-sdk/src/core/types.ts), [packages/web-sdk/src/transport/types.ts](../../packages/web-sdk/src/transport/types.ts)
- Preview voice handling: [apps/studio/src/app/preview/page.tsx](../../apps/studio/src/app/preview/page.tsx)

**Why partial**

- These surfaces share auth/session identity assumptions with the SDK conversational family, but have distinct streaming, transcript, and session-closure behavior.
- Attachment/form semantics are intentionally narrower than chat, but that narrowing is not yet captured explicitly in the audit contract.
- Proactive/outbound initiation and closure semantics still need a family-level decision.

**Next slice**

- Voice-surface audit focused on realtime/pipeline protocol differences, closure semantics, and how much parity with chat is intentional.

### HTTP sync

**Evidence**

- Route contract and outcome payloads: [apps/runtime/src/routes/chat.ts](../../apps/runtime/src/routes/chat.ts)
- Outcome normalization: [apps/runtime/src/services/channel/outcome.ts](../../apps/runtime/src/services/channel/outcome.ts)
- Contract row: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)

**Why working**

- Auth profiles are explicit and outcome-based.
- Session lifecycle is canonical `create_resume`.
- Identity/contact linking is stronger here than most messaging/voice channels.
- Payloads include rich content and `voiceConfig`.
- Trace data is inline, which makes closure/traceability strong.

**Main gap**

- No streaming/typing/thought UX by design on the sync HTTP surface.

### HTTP async

**Evidence**

- Queue/worker delivery path: [apps/runtime/src/services/queues/inbound-worker.ts](../../apps/runtime/src/services/queues/inbound-worker.ts)
- Session continuity: [apps/runtime/src/channels/session-resolver.ts](../../apps/runtime/src/channels/session-resolver.ts)
- Contract row: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)

**Why partial**

- Auth preflight is explicit and outcome-based, but JIT remains unsupported.
- Session continuity is good for implicit resume, but omnichannel history/join is not a first-class external contract.
- Identity/contact support is artifact-driven and policy-dependent, not full verified-contact parity.
- Payload normalization is strong (`structured_passthrough`), but traceability is correlation-based rather than inline/streamed.

**Next slice**

- Decide whether HTTP async should expose more explicit history/session-closure state, or stay correlation-only by design.

### Messaging async adapters

**Evidence**

- Family contract rows: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)
- Shared inbound/session path: [apps/runtime/src/channels/session-resolver.ts](../../apps/runtime/src/channels/session-resolver.ts), [apps/runtime/src/services/queues/inbound-worker.ts](../../apps/runtime/src/services/queues/inbound-worker.ts)
- Representative rich/streaming/typing adapters:
  - Slack: [apps/runtime/src/channels/adapters/slack-adapter.ts](../../apps/runtime/src/channels/adapters/slack-adapter.ts), [apps/runtime/src/channels/adapters/slack-stream-client.ts](../../apps/runtime/src/channels/adapters/slack-stream-client.ts)
  - Telegram typing + actions: [apps/runtime/src/channels/adapters/telegram-adapter.ts](../../apps/runtime/src/channels/adapters/telegram-adapter.ts)

**Why partial**

- Preflight auth is explicit, but JIT auth is unsupported.
- Session continuity and identity/contact are mostly artifact-based.
- Rich payloads and actions vary significantly by adapter.
- Streaming exists for some channels (for example Slack), typing indicators for some others (for example Telegram/Teams/LINE), but not as a normalized family contract.
- Thought streaming is not a meaningful family-level surface today.

**Representative adapter notes**

- Slack and Teams are the strongest structured-message members of the family: Slack emits Block Kit and supports stream finalization, while Teams emits Adaptive Cards and typing/stream activities.
- Telegram, LINE, Messenger, and Instagram support channel-native typing plus interactive quick-reply/template-style actions, but they do not expose a unified streaming/thought contract.
- WhatsApp supports strong template/button payloads and media ingest, but intentionally has no typing-indicator parity in the contract.
- Zendesk is action-limited rather than rich-template-rich, and Twilio SMS / Email remain intentionally text-first with no forms, typing, or streaming.

**Next slice**

- Decide whether any of these per-adapter differences should be promoted into stricter family guarantees, or remain adapter-specific by design.

### Sync webhook / telephony bridge

**Evidence**

- Genesys / VXML routes: [apps/runtime/src/routes/channel-genesys.ts](../../apps/runtime/src/routes/channel-genesys.ts), [apps/runtime/src/routes/channel-vxml.ts](../../apps/runtime/src/routes/channel-vxml.ts)
- AudioCodes / Twilio / KoreVG paths:
  - [apps/runtime/src/routes/channel-audiocodes.ts](../../apps/runtime/src/routes/channel-audiocodes.ts)
  - [apps/runtime/src/websocket/twilio-media-handler.ts](../../apps/runtime/src/websocket/twilio-media-handler.ts)
  - [apps/runtime/src/services/voice/korevg/korevg-router.ts](../../apps/runtime/src/services/voice/korevg/korevg-router.ts)
  - [apps/runtime/src/services/voice/korevg/korevg-session.ts](../../apps/runtime/src/services/voice/korevg/korevg-session.ts)

**Why partial**

- These channels now largely honor canonical `sessionId`, but lifecycle is still mostly implicit or telephony-session-driven.
- VXML lifecycle callbacks, AudioCodes disconnects, and Twilio stream shutdown now route through the shared voice lifecycle cleanup path, so runtime-session and DB-session teardown are materially less divergent than before.
- Twilio is now slightly stronger than the generic bridge baseline because the signed `/api/v1/voice/status` callback can map terminal Twilio call states back onto the stored DB session and correct final disposition when a DB session exists. In the explicit contract this is `sessionOutcomeEvidence: provider_terminal_status`.
- KoreVG still uses a more custom shutdown path because it derives call outcome/disposition from SIP/Homer context before ending runtime + DB session state. In the explicit contract this is `sessionOutcomeEvidence: provider_disconnect_attribution`.
- AudioCodes and VXML still only provide transport-level lifecycle closure without trustworthy provider-side disposition semantics, so they remain `sessionOutcomeEvidence: transport_lifecycle_event` rather than pretending to have the same end-state fidelity as Twilio/KoreVG.
- Identity/contact parity is now consistently stronger across voice. VXML and AudioCodes inherit verified-contact linking through the shared `resolveSession()` path, LiveKit preserves verified contact identity from SDK/stored sessions, and both KoreVG and Twilio now resolve and link verified caller/contact identity during bootstrap when the channel/provider trust policy allows it.
- Rich payload support is minimal and voice/text specific.
- Streaming/thought/typing semantics are channel-specific rather than normalized.
- Closure and traceability are better than before, but explicit contact semantics and telephony-specific end-state rules are still less uniform than websocket/HTTP sync.

**Next slice**

- Close-out conclusion: keep these channels explicitly partial by protocol, with Twilio/KoreVG carrying stronger terminal outcome evidence than VXML/AudioCodes, and avoid pretending they share one uniform telephony disposition model.

### LiveKit voice

**Evidence**

- Adapter/bootstrap path: [apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts](../../apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts)
- Contract row: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)
- Preview/SDK voice handling: [packages/web-sdk/src/voice/VoiceClient.ts](../../packages/web-sdk/src/voice/VoiceClient.ts)

**Why partial**

- Canonical `sessionId` bootstrap is now correct.
- LiveKit now preserves verified caller/contact identity from SDK-session and stored-session bootstrap, so its identity-linking semantics are stronger than the generic telephony bridges.
- Teardown now routes through the shared voice lifecycle cleanup path, so runtime-session and DB-session closure behavior is aligned with the broader voice family.
- LiveKit now explicitly sits in the middle of the voice closure spectrum: it has shared lifecycle cleanup (`sessionClosure: explicit_end_event`) but only transport-lifecycle evidence for final outcome (`sessionOutcomeEvidence: transport_lifecycle_event`), not a signed provider terminal-status feed like Twilio.
- Voice transcripts and realtime chunks exist, but the channel surface does not currently expose a normalized thought/presence stream the way the SDK voice family does.
- Identity/contact semantics are now better described than before: LiveKit inherits the shared `voice_core` behavior model and preserves caller artifact/contact context into DB-session linking, but explicit omnichannel parity and end-user identity/contact guarantees still need the final audit against the broader lifecycle architecture.

**Next slice**

- Close-out conclusion: LiveKit should remain the “shared lifecycle cleanup + transport-level outcome evidence” member of the voice family, distinct from Twilio/KoreVG provider-derived end-state semantics and from SDK voice thought/presence surfaces.

### A2A

**Evidence**

- Manifest / routing references: [apps/runtime/src/channels/manifest.ts](../../apps/runtime/src/channels/manifest.ts)
- A2A package surface:
  - [packages/a2a/src/index.ts](../../packages/a2a/src/index.ts)
  - [packages/a2a/src/application/send-task.ts](../../packages/a2a/src/application/send-task.ts)
  - [packages/a2a/src/application/send-task-async.ts](../../packages/a2a/src/application/send-task-async.ts)
  - [packages/a2a/src/application/send-task-streaming.ts](../../packages/a2a/src/application/send-task-streaming.ts)
  - [packages/a2a/src/application/poll-task.ts](../../packages/a2a/src/application/poll-task.ts)
  - [packages/a2a/src/application/cancel-task.ts](../../packages/a2a/src/application/cancel-task.ts)
- Runtime delivery / push-notification bridge:
  - [apps/runtime/src/services/execution/channel-dispatcher.ts](../../apps/runtime/src/services/execution/channel-dispatcher.ts)
  - [apps/runtime/src/server.ts](../../apps/runtime/src/server.ts)
- Existing implementation/test plan:
  - [docs/plans/2026-03-22-a2a-integration-impl-plan.md](./2026-03-22-a2a-integration-impl-plan.md)
  - [docs/testing/a2a-integration.md](../testing/a2a-integration.md)

**Why partial**

- `a2a` was missing from the first draft of the parity matrix, but it is now part of the explicit parity model and should be treated as a supported partial family rather than a generic “special stack” gap.
- Auth is present at the connection boundary through per-connection inbound Bearer enforcement, but it does not currently participate in the same auth-profile / preflight / JIT vocabulary as chat channels. In the explicit channel contract this should be treated as `preflightAuth: unsupported` and `jitAuth: unsupported`, not as an auth-profile outcome surface.
- Session continuity and history are strong: `contextId` maps to canonical `sessionId`, `tasks/get` exposes task history, and streaming/sync paths both preserve multi-turn context.
- Payload and streaming support are also real: A2A supports structured parts, artifact updates, SSE streaming, async tasks, polling, cancel, and push-notification delivery. Runtime `richContent` and `actions` now survive the adapter as native A2A `data` parts on the final task/message payload. Inbound inline file parts now also bridge into the runtime attachment pipeline as canonical `attachmentIds` when the host provides the A2A attachment ingestor. The remaining parity gap is that these semantics are still expressed as A2A tasks/artifacts rather than the same action/form/attachment contract used by chat channels, and URI-only file parts remain an explicit partial case.
- Task completion and session closure are intentionally different: successful task terminal states do not close the underlying `contextId → sessionId` mapping, which instead lives until TTL expiry or explicit failure cleanup. That makes A2A closer to `implicit_only` session closure than the chat-family end-session model.
- Identity/contact is still a real gap because A2A has connection-level context and tenant/project isolation, but not the end-user identity/contact model used by the omnichannel chat surfaces. `contextId` continuity is conversation state, not end-user identity linking.
- Attachment/artifact semantics and proactive/outbound update guarantees need explicit mapping because A2A can carry artifacts and push updates differently from chat channels.

**Next slice**

- Finalize the `a2a` parity statement around:
  - connection-level Bearer auth vs auth-profile vocabulary
  - URI-only file part behavior vs canonical attachment ingestion
  - push notifications as proactive/outbound delivery rather than chat-style websocket updates
  - task-finalization vs session-closure vocabulary

### AG-UI / separate stack

**Evidence**

- Contract row: [apps/runtime/src/channels/channel-behavior-contract.ts](../../apps/runtime/src/channels/channel-behavior-contract.ts)

**Why separate-stack partial**

- AG-UI is intentionally outside most of the main chat/voice transport guarantees.
- The adapter produces structured SSE event sequences for frontend agent UIs rather than chat/widget payloads, does not send network responses directly, and should not inherit auth-profile, session-closure, or presence assumptions from websocket chat by default.
- Its remaining “partial” status in the matrix is about limited overlap with the main parity dimensions, not missing implementation in the AG-UI stack itself.

## Recommended Final Slices

1. **Final parity proof pass**
   - validate the expanded checklist against current code for every family
   - make sure the doc and the runtime contract still agree
   - convert the remaining `partial` rows into either explicit intentional differences or concrete follow-up tasks
2. **Legacy compatibility quarantine**
   - leave `runtimeSessionId` only in documented storage/compatibility boundaries
   - avoid any new feature expansion around it

## Final Audit Conclusion

At this point, the parity rollout is no longer blocked on broad cross-channel implementation gaps.

- `sdk_chat` / `sdk_websocket` / `web_chat` are now one explicit logical family with parity checks around attachments, forms, proactive delivery, session closure, and presence semantics.
- A2A is now treated as a supported partial family: its remaining differences are protocol-semantic (`contextId`, task/artifact updates, push callbacks, task-terminal evidence), not missing runtime support.
- Messaging adapters are still intentionally heterogeneous, but the family now has explicit per-adapter notes for the main areas of divergence: typing, payload richness, streaming, and action semantics.
- Voice remains the highest-value remaining close-out area because terminal outcome evidence, lifecycle closure semantics, and contact expectations are stronger on some transports (Twilio, KoreVG) than others (VXML, AudioCodes, LiveKit).

The real remaining gaps are now concentrated in:

1. Voice-family final wording and any last contract tightening around closure/disposition/contact semantics.
2. Legacy compatibility quarantine for the few remaining documented `runtimeSessionId` storage/wire shims.
