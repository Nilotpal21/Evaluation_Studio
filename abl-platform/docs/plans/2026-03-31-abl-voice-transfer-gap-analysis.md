# ABL Voice Transfer to Agent — Gap Analysis

**Date:** 2026-03-31
**Updated:** 2026-04-10 (voice payload gap resolved — conversations API now sends full voice fields)
**Branch:** `agent-transfer-voice`
**Status:** REVIEWED

---

## Summary

This document identifies the gaps between ABL's current voice infrastructure and what's needed to support full voice-to-agent transfers via SmartAssist/AgentAssist.

ABL already has substantial voice infrastructure (gateway abstractions, voice tools, channel detection, SIP config) **and Studio UI** (project-level voice gateway settings, per-agent escalation voice settings, voice channel deployment). The primary gap is: **KoreServer acts as a relay between AgentAssist and the voice gateway via Redis pub/sub + WebSocket. ABL must replicate this relay for voice events received via the callback webhook.**

---

## Current State — What ABL Already Has

### Voice Gateway Abstraction

- `VoiceGatewaySession` interface: `sendAgentMessage()`, `isActive()`, `transferCall?()`, `hangup?()`, `sendDTMF?()`
- `VoiceGateway` interface with `getSession()`, `isAvailable()`
- `VoiceGatewayRegistry` singleton — provider-agnostic session lookup
- Concrete implementations: KoreVG (`korevg-session.ts`), LiveKit, Twilio
- **Note:** `KorevgSession` does NOT formally `implement VoiceGatewaySession`. It is structurally compatible (duck-typed). The message bridge uses a two-path lookup: registry-based (returns `VoiceGatewaySession`) then direct fallback to `getVoiceSession()` (returns `KorevgSession`).

### Voice Tools (4)

| Tool                | Purpose                          |
| ------------------- | -------------------------------- |
| `CallTransferTool`  | SIP REFER or PSTN dial transfers |
| `IVRMenuTool`       | DTMF menu presentation           |
| `IVRDigitInputTool` | Multi-digit DTMF collection      |
| `DeflectToChatTool` | Voice-to-chat channel deflection |

All tools are **pure data builders** — they produce `VoiceToolResult` discriminated union values but do NOT execute side effects. `KorevgSession.handleVoiceToolResult()` dispatches by type: `gather` → `verbBuilder.gather()`, `transfer` → `verbBuilder.refer()` (SIP) or `verbBuilder.dial()` (PSTN), `deflect` → farewell + hangup, `hangup` → `verbBuilder.hangup()`.

### Channel Detection & Mapping

- `VOICE_CHANNELS`: `voice`, `korevg`, `audiocodes`, `twilio`, `ivr`
- `mapChannelToSource('voice')` → `'voice'`
- `mapChannelToConversationType('voice')` → `'call'`
- Voice TTL = 0 (session duration)

### Studio UI — Voice Transfer Configuration (Already Complete)

**Project-level** (`AgentTransferSettingsPage.tsx`):

- Voice Gateway section: gateway type (`korevg`/`audiocodes`/`jambonz`), transfer method (`invite`/`refer`/`bye`), header passthrough toggle, recording enabled toggle
- Voice-specific session TTL (default 0 = call duration)
- PII de-tokenization settings

**Per-agent** (`EscalationEditor.tsx` → `RoutingEditor` → `VoiceSettingsEditor`):

- Transfer method override per agent (`invite`/`refer`/`bye`)
- Custom SIP headers (dynamic key-value pairs)
- Standard routing: connection, queue, skills, priority, post-agent action

**Voice channel deployment** (`ConfigurationTab.tsx`):

- Provider (Kore VGW / BYOC SIP), phone numbers (Twilio/Telnyx), SIP gateway IP
- STT/TTS provider selection, barge-in, speech timeout, welcome message

**Admin** (`VoiceServicesPage.tsx`): 7 voice credential cards (Deepgram, ElevenLabs, OpenAI Realtime, etc.)

**Monitoring** (`TransferSessionsPage.tsx`): filterable by channel (Voice), status, provider

### Webhook Event Handling

- Route: `POST /api/v1/agent-transfer/webhooks/:provider`
- HMAC signature verification with nonce replay protection
- Tenant isolation validation (returns 404, not 403)
- Event normalization: `eventName` → `type`, `payload` → `data`, extracts `conversationId`, `orgId`, `botId`, `agentInfo`
- Normalization happens in the route handler; semantic field extraction happens in the adapter's `processEvent()`

### Message Bridge

- `routeAgentEvent()` dispatches by channel type
- `deliverViaVoiceGateway()` — currently only handles `agent:message` (TTS delivery)
- Voice session lookup: registry first, then direct `getVoiceSession()` fallback
- **Critical:** `event.sessionId` is overwritten with ABL session key (`agent_transfer:{tenantId}:{contactId}:{channel}`) in `index.ts:227`. Downstream code receives the ABL key, not the provider's `conversationId` or the voice `callSid`.

### Config Schema

- `VoiceGatewayConfigSchema`: type (audiocodes/korevg/jambonz), SIP defaults (invite/refer/bye), recording, header passthrough

### SmartAssist Adapter

- `initTransfer()` sends `source: 'voice'` and `conversationType: 'call'` for voice channels
- `sendEvent()` and `sendUserMessage()` are channel-agnostic (same protocol for voice and chat)
- ~~No voice-specific payload fields (ANI/DNIS, SIP headers, call duration) are sent in the transfer body~~ **RESOLVED (2026-04-10):** `VoiceCallData` added to `TransferPayload`, `initTransfer()` now sends `phoneNumber`, `CallIDData`, `botSIPURI`, voice language fields, and `metaInfo.caller/callee/dialedNumber` when `voiceData` is present. Voice data extracted from active `KorevgSession` in routing-executor ESCALATE handler.
- No method to bridge/conference a voice call to the agent's phone endpoint

---

## The Relay Gap

### How KoreServer relays voice events (current flow)

```
AgentAssist → HTTP POST /events/handle → AgentAssistService.handleEvents()
  → RabbitMQ (agentDesktopQ)
    → agent_desktop_listener.js
      → Redis pub/sub per event type
        → koreVoiceAgent.js (subscribes)
          → WebSocket send to Voice Gateway (KoreVG/AudioCodes)
```

Key events in koreserver:

- `AGENT_ACCEPTANCE_OBSERVER` — agent accepted/rejected (triggers SIP dial)
- `WAITING_MSG_TO_USER` — waiting messages while in queue
- `KOREVG_RECORDING_CONTROL` — recording start/stop/pause
- `KOREVG_TRANSCRIBE_CONTROL` — transcription controls
- `KOREVG_CONFERENCE_ACTIONS` — conference join/leave/mute
- `KOREVG_SIPREC_CONTROL` — SIPREC recording controls

### How ABL needs to handle voice events (target flow)

```
AgentAssist → HTTP POST /api/v1/agent-transfer/webhooks/smartassist (callback)
  → Route normalizes eventName → type, payload → data
    → KoreEventHandler.processEvent() — semantic field extraction
      → onAgentMessage callback (index.ts:212-253)
        → bridge.routeAgentEvent() — dispatches by channel
          → deliverViaVoiceGateway()
            → VoiceGatewaySession methods (direct, per-pod)
            → If not found locally: Redis pub/sub relay to owning pod
```

ABL has direct access to voice gateway sessions via the registry on the local pod. In multi-pod deployments, a Redis pub/sub cross-pod relay (`at:cross_pod:agent_events` channel) forwards undeliverable events to the pod that owns the WebSocket or voice session. This is lighter than KoreServer's per-event-type Redis pub/sub — ABL uses a single channel with source-pod filtering and tenant isolation validation.

### Session ID Flow (Critical for Implementation)

```
AgentAssist webhook: event.conversationId (SmartAssist conversation ID)
  → webhook route: event passes through
    → adapter.handleInboundEvent()
      → processEvent() fires handlers with sessionId = event.conversationId
        → onAgentMessage callback (index.ts):
            1. Looks up transfer session by provider + tenantId + conversationId
            2. Builds ablKey = sessionKey(tenantId, contactId, channel)
            3. OVERWRITES event.sessionId = ablKey
        → bridge.routeAgentEvent(ablKey, event)
          → deliverViaVoiceGateway(event)
            → Must extract callSid from transfer session's voiceData
            → Lookup voice session by callSid, NOT by ablKey
```

This means `findVoiceSession()` cannot use `event.sessionId` directly — it must look up the transfer session first, extract `voiceData.callSid`, then find the voice gateway session by callSid.

---

## Gap 1: Voice Event Types Not Mapped in KoreEventHandler

The `XO_EVENT_MAP` in `event-handler.ts` (lines 29-54) has 24 entries, all chat/messaging-oriented. Voice-specific events from AgentAssist are missing:

| AgentAssist Event                  | What KoreServer Does                     | ABL Mapping Needed               | Phase |
| ---------------------------------- | ---------------------------------------- | -------------------------------- | ----- |
| `call_status_notifications`        | Hangup, disconnect reason                | New `agent:call_status` type     | 1     |
| `wait_time_voice_message_for_user` | TTS/audio playback to caller in queue    | New `agent:waiting_message` type | 1     |
| `conference_actions`               | Hold/unhold/whisper/DTMF per participant | New event type(s) needed         | 3     |
| `korevg_recording_controls`        | Start/stop/pause/resume recording        | New event type needed            | 2     |
| `conference_notifications`         | Conference join/leave                    | New event type needed            | 3     |
| `korevg_start_transcribe`          | Start transcription                      | New event type needed            | 2     |

### Events already mapped (work for voice too)

- `agent_accepted` → `agent:connected` ✓ (but voice payload fields like `transferURI` are not extracted — see Gap 3)
- `agent_message` → `agent:message` ✓
- `conversation_closed` / `agent_disconnect` → `agent:disconnected` ✓
- `typing` / `stop_typing` → `agent:typing` / `agent:typing_stop` ✓
- `conversation_queued` → `agent:queued` ✓

### `assign_kore_agent_for_user` event

In koreserver, `assign_kore_agent_for_user` is the event sent from AgentAssist to KoreVG when an agent accepts a voice call. It contains `transferURI`, `sipHeaders`, and `dialHeaders`. This event may arrive via the webhook as `agent_accepted` or as `assign_kore_agent_for_user`. The `agent_accepted` mapping exists but **does not extract voice-specific payload fields**. The `processEvent()` method (lines 89-99) only extracts `message`, `agentInfo`, and `attachments` — not `transferURI` or `sipHeaders`.

---

## Gap 2: AgentEventType Union Missing Voice Types

Current (`packages/agent-transfer/src/types.ts`, lines 80-91):

```ts
export type AgentEventType =
  | 'agent:message'
  | 'agent:connected'
  | 'agent:joined'
  | 'agent:exited' // TODO: wire XO mapping when SmartAssist exposes agent_exited event
  | 'agent:queued'
  | 'agent:disconnected'
  | 'agent:typing'
  | 'agent:typing_stop'
  | 'agent:delivery_receipt'
  | 'agent:form'
  | 'agent:assist_suggestion';
```

Missing voice-specific types needed per phase:

| Type                          | Phase | Purpose                                                                                                                                                   |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent:call_status`           | 1     | Call lifecycle events (hangup, disconnect reason) — distinct from `agent:disconnected` because it carries reasons and informational states like `ringing` |
| `agent:waiting_message`       | 1     | Queue hold TTS/audio — distinct from `agent:message` because it has different barge-in behavior and is not agent conversation                             |
| `agent:hold` / `agent:unhold` | 2     | Call hold/resume                                                                                                                                          |
| `agent:recording_control`     | 2     | Recording start/stop/pause/resume                                                                                                                         |
| `agent:conference_action`     | 3     | Conference join/leave/mute/whisper                                                                                                                        |

Also note: `VOICE_EVENT_TYPES` constant in `voice/index.ts` (lines 23-30) defines `voice:dtmf`, `transfer:status`, `oob:agent_transfer`, etc. — these are NOT part of `AgentEventType` and cannot be used with the typed event handler system. They exist as labels for OOB flag processing only.

---

## Gap 3: `agent:connected` Does Not Extract Voice Payload Fields

`processEvent()` in `event-handler.ts` (lines 89-99) builds the event `data` object from:

- `xoEvent.data` (spread)
- `message` (from `xoEvent.message || xoEvent.payload?.value || xoEvent.data?.value`)
- `agentInfo` (from 3 fallback locations)
- `attachments` (from `xoEvent.data.attachments`)

For voice agent acceptance, AgentAssist sends additional fields in the payload:

- `transferURI` — agent's SIP endpoint
- `sipHeaders` — SIP headers for the INVITE/REFER
- `dialHeaders` — additional dial headers (e.g., `X-conversationId`)
- `agentSipURI` — alternative field for agent endpoint

These fields are NOT extracted by `processEvent()`. They may exist in `xoEvent.data` if AgentAssist puts them there, but this is not guaranteed — they may be in `xoEvent.payload` which is only partially promoted.

**Impact:** Even though `agent_accepted` maps to `agent:connected`, the voice-specific data needed to bridge the call is lost.

---

## Gap 4: Message Bridge Drops All Non-Message Voice Events

`deliverViaVoiceGateway()` in `message-bridge.ts` (line 487):

```ts
if (event.type !== 'agent:message') {
  log.info('Non-message voice event (no TTS delivery)', { ... });
  return;  // ← ALL non-message voice events are silently dropped
}
```

Events dropped for voice channels:

- `agent:connected` — **agent acceptance never triggers call bridging** (CRITICAL)
- `agent:disconnected` — agent hangup not signaled to voice gateway
- `agent:queued` — queue position/wait time not communicated to caller
- `agent:form` — form data not spoken or converted
- All future voice event types

**Additional complexity:** The `findVoiceSession()` lookup uses `event.sessionId`, but as noted in the Session ID Flow section above, `event.sessionId` is the ABL session key, not the voice `callSid`. The current fallback to `getVoiceSession(event.sessionId)` works for `agent:message` only because `sendAgentMessage` tolerates session lookup by various ID formats. For `dialAgent()`, the lookup must use the correct `callSid`.

---

## Gap 5: Transfer Session Missing Voice-Specific Fields

`TransferSessionData` (lines 23-49 of `session/types.ts`) has no voice-specific fields. For voice transfers, the session needs:

| Field              | Purpose                                            | When Set            |
| ------------------ | -------------------------------------------------- | ------------------- |
| `callSid`          | Voice gateway call identifier (for session lookup) | Transfer initiation |
| `sipCallId`        | SIP Call-ID header (for tracing)                   | Transfer initiation |
| `agentSipURI`      | Agent's SIP endpoint                               | Agent accepts       |
| `disconnectReason` | Why the call ended                                 | Call ends           |

Phase 2+ additions: `isRecording`, `isOnHold`, `conferenceState`.

Currently voice context goes into the opaque `metadata: Record<string, unknown>` and `providerData: Record<string, unknown>` fields, but:

1. No typed schema for voice data
2. **`providerData` is stringified in Redis** — when read back, values need JSON parsing

The `callSid` must be populated at transfer initiation time (in `KoreAdapter.execute()`) before any webhook arrives, since the voice gateway session is already established when the bot triggers transfer.

`UpdateTransferSessionFields` (lines 71-89) must also include `voiceData` to support partial updates (setting `agentSipURI` on acceptance, `disconnectReason` on hangup).

---

## Gap 6: SIP REFER Endpoint Not Handled

AgentAssist's `notifyReferInitiated()` calls KoreServer's `POST /api/1.1/internal/agentassist/siprefer`. This endpoint is a **validation-only** check — it verifies an active agent session exists before telling the voice gateway to send SIP REFER.

For ABL:

- **Option A:** New webhook route `POST /api/v1/agent-transfer/webhooks/smartassist/siprefer`
- **Option B:** Handle entirely within ABL since we own the voice gateway session directly — no need for external validation endpoint

**Option B is preferred** — ABL has direct `VoiceGatewaySession` access. The validation (is the call still active?) can be done inline when `dialAgent()` is called.

---

## Gap 7: Conference/Multi-Party Support Does Not Exist

KoreServer has full conference support via koreVoiceAgent.js:

- Supervisor listen, whisper, barge-in
- Per-participant call state tracking
- Consult call flow (dial second agent, merge, exit)
- Conference-level recording/transcription control
- Feature-flagged via `config.xofeatures.defaultConferenceEnabled`

AgentAssist has ~15 socket events for conference controls:

- `conversation_consult_request/accepted/exit`
- `conversation_consult_merge_request`
- `conference_exit`, `request_join_conference`
- `conversation_whisper_status`, `consult_swap`, `consult_forward`

ABL has **none** of this. This is the largest gap and should be phased separately.

---

## Phased Implementation Recommendation

| Phase                             | Scope                                                                | Gaps Addressed | Complexity |
| --------------------------------- | -------------------------------------------------------------------- | -------------- | ---------- |
| **Phase 1: Basic Voice Transfer** | Agent acceptance → SIP dial, agent hangup → hangup, waiting messages | 1, 2, 3, 4, 5  | Medium     |
| **Phase 2: Call Controls**        | Hold/unhold, recording start/stop/pause/resume                       | 1, 2           | Medium     |
| **Phase 3: Conference**           | Supervisor listen, whisper, barge-in                                 | 7              | High       |
| **Phase 4: Advanced Transfers**   | Consult/warm transfer, agent-to-agent, SIP REFER validation          | 6, 7           | High       |

Phase 1 alone delivers a working voice-to-agent flow end-to-end.

---

## Files Affected (Phase 1 Scope)

| #   | File                                                         | Change                                          |
| --- | ------------------------------------------------------------ | ----------------------------------------------- |
| 1   | `packages/agent-transfer/src/types.ts`                       | Add voice event types to `AgentEventType`       |
| 2   | `packages/agent-transfer/src/adapters/kore/event-handler.ts` | Map voice events + extract voice payload fields |
| 3   | `packages/agent-transfer/src/voice/voice-gateway.ts`         | Expand `VoiceGatewaySession` interface          |
| 4   | `packages/agent-transfer/src/session/types.ts`               | Add `voiceData` to session types                |
| 5   | `apps/runtime/src/services/agent-transfer/message-bridge.ts` | Route voice events in `deliverViaVoiceGateway`  |
| 6   | `apps/runtime/src/services/voice/korevg/korevg-session.ts`   | Implement `dialAgent` and `playMessage` methods |

**Note:** `apps/runtime/src/routes/agent-transfer-webhooks.ts` does NOT need changes — normalization already handles voice events correctly. `apps/runtime/src/services/agent-transfer/index.ts` needs minor changes to pass voice session data through the event pipeline.

---

## KoreServer Voice Config Reference

For completeness, these are the voice transfer configuration fields that koreserver reads at runtime:

### Bot-Level Voice Agent Config (`SmartAssistBotSettings.liveAgent.voiceAgent`)

| Field                           | Type    | Description                                                                         |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `name`                          | string  | Agent type: `sipTransfer`, `callNumber`, `koreAgent`, `genesysVoice`, `customVoice` |
| `config.sipTransferId`          | string  | SIP URI transfer target                                                             |
| `config.phoneNumber`            | string  | Phone number transfer target                                                        |
| `config.sipTransferMethod`      | string  | `SIP_INVITE`, `SIP_REFER`, or `SIP_BYE`                                             |
| `config.additionalContext`      | array   | `[{ enabled, name, value }]` — custom SIP headers                                   |
| `config.userToUser`             | object  | `{ enabled, payload }` — UUI header data                                            |
| `config.sendKoreChatHistoryURL` | boolean | Generate chat history URL for agent                                                 |

### Callflow Node Config (`AgentTransferTaskDefinition`)

| Field                          | Type     | Description                       |
| ------------------------------ | -------- | --------------------------------- |
| `queueId`                      | string   | Target queue                      |
| `waitingExperienceId`          | string   | Waiting experience to play        |
| `inQueueTransferFlowId`        | string   | In-queue flow while waiting       |
| `agentTransfer.skills`         | [string] | Skill IDs for routing             |
| `agentTransfer.overrideAgents` | boolean  | Override agent selection          |
| `postAgentConversation.action` | string   | `returnToFlow` or `triggerDialog` |
| `agentAssistEvents.start/end`  | object   | `{ botId, dialogId, isEnabled }`  |

### Runtime Override Chain (set via script nodes in `_metaInfo` or `cfContext`)

Priority: base config → callflow context → bot session → child bot session

| Override Field                  | Purpose                                    |
| ------------------------------- | ------------------------------------------ | ------ | ------- | ----------- |
| `sipTransferURI`                | Override SIP URI target                    |
| `sipTransferNumber`             | Override phone number target               |
| `voiceTransferType`             | Override method (`invite`, `refer`, `bye`) |
| `callerId`                      | Override caller ID                         |
| `referredBy`                    | SIP Referred-By header                     |
| `externalAgentTranscribe`       | `{ transcribe, transcriptionOptions }`     |
| `externalAgentRecordingControl` | `{ record: 'start'                         | 'stop' | 'pause' | 'resume' }` |

ABL Studio already captures the equivalent of the bot-level config (project settings + per-agent escalation). The callflow node config is captured via the escalation editor's routing section. Runtime overrides would need to be surfaced through agent IR metadata if needed.
