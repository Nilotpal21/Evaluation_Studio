# Implementation Plan: ABL Voice Transfer Phase 1 — Basic Voice-to-Agent Flow

**Date:** 2026-03-31
**Updated:** 2026-04-10 (added Step 9: voice payload for conversations API — koreserver parity)
**Branch:** `agent-transfer-voice`
**Status:** REVIEWED — ready for implementation
**Gap Analysis:** [2026-03-31-abl-voice-transfer-gap-analysis.md](./2026-03-31-abl-voice-transfer-gap-analysis.md)

---

## Summary

Phase 1 delivers the minimum working voice-to-agent transfer flow end-to-end:

1. ABL initiates transfer to SmartAssist with `conversationType: 'call'`
2. Agent accepts → AgentAssist sends `agent_accepted` (or `assign_kore_agent_for_user`) with voice payload to ABL callback webhook
3. ABL receives the event, looks up the active voice gateway session, sends SIP dial/REFER to connect agent to caller
4. Agent sends messages → TTS to caller (already works)
5. Agent hangs up → ABL receives `call_status_notifications`, sends hangup to voice gateway
6. Queue waiting messages → ABL receives `wait_time_voice_message_for_user`, plays TTS to caller

**Not in Phase 1:** Hold/unhold, recording controls, conference, whisper, consult transfer, SIP REFER validation endpoint, AudioCodes-specific handling.

---

## Architecture Overview

```
Caller ←→ Voice Gateway (KoreVG/Jambonz) ←→ ABL Runtime ←→ AgentAssist
                   ↕                              ↕
              SIP/WebSocket                  HTTP callback webhook
              (Jambonz verbs)                (agent_accepted, call_status, etc.)
```

**Key design principle:** ABL has direct access to VoiceGatewaySession via registry on the local pod. Voice events from AgentAssist flow through the same callback webhook as chat events, but the message bridge routes them to the voice gateway instead of a chat channel. In multi-pod deployments, a Redis pub/sub relay (`at:cross_pod:agent_events`) forwards events to the pod that owns the WebSocket or voice session when the webhook lands on a different pod.

### Session ID Flow (Critical)

```
AgentAssist webhook: event.conversationId (SmartAssist conversation ID)
  → webhook route normalizes event
    → adapter.handleInboundEvent()
      → processEvent() fires handlers with sessionId = event.conversationId
        → onAgentMessage callback (index.ts:212-253):
            1. sessionStore.getByProvider('smartassist', tenantId, conversationId)
            2. ablKey = sessionKey(tenantId, contactId, channel)
            3. event.sessionId = ablKey  ← OVERWRITES with ABL key
        → bridge.routeAgentEvent(ablKey, event)
          → deliverViaVoiceGateway(event)
            → Must resolve callSid from transfer session's voiceData
            → Voice session lookup by callSid via VoiceGatewayRegistry
```

**IMPORTANT:** `event.sessionId` is the ABL session key (`agent_transfer:{tenantId}:{contactId}:{channel}`), NOT the voice `callSid`. The voice session lookup must first retrieve the transfer session to get `voiceData.callSid`, then find the voice gateway session.

---

## Step 1: Expand AgentEventType Union

### File: `packages/agent-transfer/src/types.ts` (lines 80-91)

**Change:** Add voice-specific event types to `AgentEventType`:

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
  | 'agent:assist_suggestion'
  // Voice-specific events (Phase 1)
  | 'agent:call_status' // call_status_notifications — hangup, disconnect reason
  | 'agent:waiting_message'; // wait_time_voice_message_for_user — queue TTS/audio
```

**Note:** `agent:hold`, `agent:unhold`, `agent:recording_control`, `agent:conference_action` are Phase 2/3.

### Rationale

- `agent:call_status` — distinct from `agent:disconnected` because call status events carry disconnect reasons (`agent_hangup`, `user_hangup`, `no_answer`, `busy`, `failed`) and may include informational states like `ringing` that are not disconnects
- `agent:waiting_message` — distinct from `agent:message` because waiting messages are queue-hold TTS, not agent conversation messages, and should play with different barge-in behavior (looping, interruptible)

### Exit Criteria

- [ ] `AgentEventType` includes `agent:call_status` and `agent:waiting_message`
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` passes

---

## Step 2: Map Voice Events in KoreEventHandler

### File: `packages/agent-transfer/src/adapters/kore/event-handler.ts` (lines 29-54, 71-127)

**Change 1:** Add voice event mappings to `XO_EVENT_MAP` (after line 53):

```ts
const XO_EVENT_MAP = new Map<string, AgentEventType>([
  // ... existing 24 chat mappings (lines 31-53) ...

  // Voice-specific events (Phase 1)
  ['call_status_notifications', 'agent:call_status'],
  ['wait_time_voice_message_for_user', 'agent:waiting_message'],
  // assign_kore_agent_for_user is the voice-specific acceptance event —
  // maps to same agent:connected as agent_accepted (line 38)
  ['assign_kore_agent_for_user', 'agent:connected'],
]);
```

**Change 2:** Enhance `processEvent()` (after line 99) to extract voice-specific payload fields.

Currently `processEvent()` only extracts `message`, `agentInfo`, and `attachments`. The voice-specific fields (`transferURI`, `sipHeaders`, `dialHeaders`) are in `xoEvent.payload` or `xoEvent.data` depending on how AgentAssist sends them. We must explicitly promote them:

```ts
// After existing data construction (line 99), before building AgentEvent:

// Voice acceptance: extract SIP dial data
const xoType = xoEvent.type;
if (xoType === 'assign_kore_agent_for_user' || xoType === 'agent_accepted') {
  const payload = xoEvent.payload ?? xoEvent.data ?? {};
  if (payload.transferURI) data.transferURI = payload.transferURI;
  if (payload.sipHeaders) data.sipHeaders = payload.sipHeaders;
  if (payload.dialHeaders) data.dialHeaders = payload.dialHeaders;
  if (payload.agentSipURI) data.agentSipURI = payload.agentSipURI;
  data.isVoice = !!payload.transferURI;
}

// Voice call status: extract disconnect reason
if (xoType === 'call_status_notifications') {
  const payload = xoEvent.payload ?? xoEvent.data ?? {};
  data.callStatus = payload.callStatus || payload.event;
  data.disconnectReason = payload.reason;
  data.sipCallId = payload.sipCallId;
}

// Voice waiting message: extract TTS text and audio config
if (xoType === 'wait_time_voice_message_for_user') {
  const payload = xoEvent.payload ?? xoEvent.data ?? {};
  data.message = payload.value || payload.message || data.message;
  data.audioUrl = payload.audioUrl;
  data.bargeIn = payload.bargeIn ?? true;
  data.bargeInOnDTMF = payload.bargeInOnDTMF ?? true;
}
```

### Exit Criteria

- [ ] `XO_EVENT_MAP` includes 3 new voice entries
- [ ] `processEvent()` extracts `transferURI`, `sipHeaders`, `dialHeaders` for acceptance events
- [ ] `processEvent()` extracts `callStatus`, `disconnectReason` for call status events
- [ ] `processEvent()` extracts `message`, `audioUrl`, `bargeIn` for waiting message events
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` passes

---

## Step 3: Expand VoiceGatewaySession Interface

### File: `packages/agent-transfer/src/voice/voice-gateway.ts` (lines 20-38)

**Change:** Add Phase 1 methods to `VoiceGatewaySession`:

```ts
export interface VoiceGatewaySession {
  /** Unique session identifier */
  readonly sessionId: string;

  /** Send a text message to be spoken via TTS */
  sendAgentMessage(text: string): void;

  /** Check if the session is still active */
  isActive(): boolean;

  /** Transfer the call (SIP REFER or PSTN dial) — optional capability */
  transferCall?(target: string, headers?: Record<string, string>): Promise<void>;

  /** Hang up the call — optional capability */
  hangup?(reason?: string): void;

  /** Send DTMF tones — optional capability */
  sendDTMF?(digits: string): void;

  // ── Phase 1: Voice-to-Agent Transfer ────────────────────────────────

  /**
   * Connect an agent to the caller via SIP INVITE or REFER.
   * Called when AgentAssist sends agent_accepted event with transferURI.
   *
   * @param sipUri - SIP URI of the agent (e.g., sip:agent@sbc.example.com)
   * @param options - SIP headers, dial config
   */
  dialAgent?(sipUri: string, options?: DialAgentOptions): Promise<void>;

  /**
   * Play a message to the caller via TTS.
   * Used for queue waiting messages and system messages.
   * Phase 1: TTS only via say verb. Phase 2: audio URL playback via play verb.
   */
  playMessage?(text: string, options?: PlayMessageOptions): void;
}

/** Options for dialing an agent into the call */
export interface DialAgentOptions {
  /** SIP headers to include in the INVITE/REFER */
  sipHeaders?: Array<{ name: string; value: string }>;
  /** Additional dial headers (e.g., X-conversationId) */
  dialHeaders?: Record<string, string>;
  /** Whether to abort current prompts before dialing */
  abortPrompts?: boolean;
}

/** Options for playing a message */
export interface PlayMessageOptions {
  /** Audio URL — Phase 1: ignored (TTS only). Phase 2: will use play verb. */
  audioUrl?: string;
  /** Allow caller to interrupt with speech (default: true) */
  bargeIn?: boolean;
  /** Allow caller to interrupt with DTMF (default: true) */
  bargeInOnDTMF?: boolean;
}
```

**Note on `hangup()` signature change:** Added optional `reason?: string` parameter. This is backwards-compatible — existing callers that pass no args still work.

**Note on KorevgSession:** `KorevgSession` does NOT formally `implement VoiceGatewaySession` — it's structurally compatible (duck-typed). The new `dialAgent()` and `playMessage()` methods will be added to `KorevgSession` directly, matching the interface structurally.

### Exit Criteria

- [ ] `VoiceGatewaySession` includes `dialAgent?()` and `playMessage?()`
- [ ] `DialAgentOptions` and `PlayMessageOptions` interfaces exported
- [ ] `hangup?()` signature updated to `hangup?(reason?: string): void`
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` passes

---

## Step 4: Add Voice Data to Transfer Session

### File: `packages/agent-transfer/src/session/types.ts` (lines 23-49, 51-68, 71-89)

**Change 1:** Add `VoiceTransferData` type and `voiceData` field to `TransferSessionData`:

```ts
/** Voice-specific transfer session data — present only for voice channel transfers */
export interface VoiceTransferData {
  /** Voice gateway call identifier (e.g., KoreVG callSid / Jambonz callSid) */
  callSid: string;
  /** SIP Call-ID header for tracing */
  sipCallId?: string;
  /** Agent's SIP URI — set when agent accepts */
  agentSipURI?: string;
  /** Disconnect reason — set when call ends */
  disconnectReason?: string;
}

export interface TransferSessionData {
  // ... existing fields (lines 24-49) ...

  /** Voice-specific session data — present only for voice channel transfers */
  voiceData?: VoiceTransferData;
}
```

**Change 2:** Add to `CreateTransferSessionInput` (after line 68):

```ts
export interface CreateTransferSessionInput {
  // ... existing fields ...
  voiceData?: Pick<VoiceTransferData, 'callSid' | 'sipCallId'>;
}
```

**Change 3:** Add to `UpdateTransferSessionFields` (after line 89):

```ts
export interface UpdateTransferSessionFields {
  // ... existing fields ...
  voiceData?: Partial<VoiceTransferData>;
}
```

**IMPORTANT:** `callSid` must be populated at transfer initiation time in the Kore adapter's `execute()` method, before any webhook arrives. The voice gateway session is already established when the bot triggers transfer — extract the `callSid` from the active `VoiceGatewaySession.sessionId`.

**IMPORTANT:** `providerData` in the Redis store is stringified. When reading `voiceData` back, the session store's `get()` method must handle deserialization. If `voiceData` is stored as a top-level field (not nested inside `providerData`), it must be included in the store's serialization/deserialization logic.

### Exit Criteria

- [ ] `VoiceTransferData` type exported
- [ ] `TransferSessionData.voiceData` optional field added
- [ ] `CreateTransferSessionInput.voiceData` optional field added
- [ ] `UpdateTransferSessionFields.voiceData` optional field added
- [ ] Session store serializes/deserializes `voiceData` correctly
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` passes

---

## Step 5: Route Voice Events in Message Bridge

### File: `apps/runtime/src/services/agent-transfer/message-bridge.ts` (lines 485-537)

**Change 1:** Replace the current `deliverViaVoiceGateway()` (which drops all non-message events) with a voice event router:

```ts
private async deliverViaVoiceGateway(event: AgentEvent): Promise<void> {
  const voiceSession = await this.findVoiceSession(event);
  if (!voiceSession) {
    log.warn('No active voice session for event delivery', {
      eventType: event.type,
      sessionId: event.sessionId,
    });
    return;
  }

  switch (event.type) {
    case 'agent:message': {
      const message = event.data?.message as string;
      if (message) {
        voiceSession.sendAgentMessage(message);
      }
      break;
    }

    case 'agent:connected': {
      // Agent accepted — bridge caller to agent via SIP
      const transferURI = event.data?.transferURI as string;
      if (!transferURI) {
        log.info('agent:connected with no transferURI, skipping voice dial', {
          sessionId: event.sessionId,
        });
        break;
      }
      if (!voiceSession.dialAgent) {
        log.warn('Voice session does not support dialAgent', {
          sessionId: event.sessionId,
        });
        break;
      }
      await voiceSession.dialAgent(transferURI, {
        sipHeaders: event.data?.sipHeaders as DialAgentOptions['sipHeaders'],
        dialHeaders: event.data?.dialHeaders as Record<string, string>,
        abortPrompts: true,
      });
      break;
    }

    case 'agent:call_status': {
      const callStatus = event.data?.callStatus as string;
      if (['agent_hangup', 'user_hangup', 'failed', 'busy', 'no_answer'].includes(callStatus)) {
        voiceSession.hangup?.(callStatus);
      }
      // 'ringing', 'dialing' are informational — no action
      break;
    }

    case 'agent:waiting_message': {
      const message = event.data?.message as string;
      if (message && voiceSession.playMessage) {
        voiceSession.playMessage(message, {
          audioUrl: event.data?.audioUrl as string | undefined,
          bargeIn: event.data?.bargeIn as boolean | undefined,
          bargeInOnDTMF: event.data?.bargeInOnDTMF as boolean | undefined,
        });
      }
      break;
    }

    case 'agent:disconnected': {
      if (voiceSession.isActive()) {
        voiceSession.hangup?.('agent_disconnect');
      }
      break;
    }

    default:
      log.info('Unhandled voice event type', {
        eventType: event.type,
        sessionId: event.sessionId,
      });
  }
}
```

**Change 2:** Add `findVoiceSession()` helper that resolves voice session via transfer session's `voiceData.callSid`:

```ts
private async findVoiceSession(event: AgentEvent): Promise<VoiceGatewaySession | undefined> {
  try {
    // event.sessionId is the ABL key (agent_transfer:{tenantId}:{contactId}:{channel})
    // We need the voice callSid from the transfer session's voiceData
    const transferSession = await this.sessionStore.get(event.sessionId);
    const callSid = transferSession?.voiceData?.callSid;

    if (!callSid) {
      // Fallback: try event.sessionId directly (legacy path)
      log.info('No voiceData.callSid on transfer session, trying sessionId', {
        sessionId: event.sessionId,
      });
    }

    const lookupId = callSid || event.sessionId;

    // Try registry first (VoiceGatewaySession interface)
    const { getVoiceGatewayRegistry } = await import('@agent-platform/agent-transfer');
    const registry = getVoiceGatewayRegistry();
    const session = registry.findSession(lookupId);
    if (session) return session;

    // Fallback: direct KoreVG session lookup (KorevgSession, duck-typed)
    const { getVoiceSession } = await import('../voice/korevg/korevg-session.js');
    return getVoiceSession(lookupId) ?? undefined;
  } catch (err) {
    log.error('Failed to find voice session', {
      sessionId: event.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
```

### Exit Criteria

- [ ] `deliverViaVoiceGateway()` handles `agent:message`, `agent:connected`, `agent:call_status`, `agent:waiting_message`, `agent:disconnected`
- [ ] `findVoiceSession()` resolves via `voiceData.callSid` from transfer session, with fallback
- [ ] No events are silently dropped without logging
- [ ] `pnpm build --filter=runtime` passes

---

## Step 6: Implement dialAgent and playMessage in KoreVG Session

### File: `apps/runtime/src/services/voice/korevg/korevg-session.ts` (class at line 331)

**Change:** Add `dialAgent()` and `playMessage()` methods to `KorevgSession`.

These use the existing `KorevgVerbBuilder` (verb-builder.ts):

- `verbBuilder.dialSip({ sipUri, headers })` — line 523, returns `DialVerb`
- `verbBuilder.say(text)` — line 234, returns `SayVerb`
- `verbBuilder.refer({ referTo, headers })` — line 543, returns `SipReferVerb`

**IMPORTANT:** `dialSip()` takes `sipUri` as the parameter name (not `target`). `refer()` takes `referTo`. Verify against verb-builder.ts before implementing.

```ts
async dialAgent(sipUri: string, options?: DialAgentOptions): Promise<void> {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Voice gateway WebSocket not connected');
  }

  // Merge sipHeaders and dialHeaders into a flat Record for the verb builder
  const headers: Record<string, string> = {};
  if (options?.sipHeaders) {
    for (const h of options.sipHeaders) {
      headers[h.name] = h.value;
    }
  }
  if (options?.dialHeaders) {
    Object.assign(headers, options.dialHeaders);
  }

  // Use dialSip (SIP INVITE) — parameter is `sipUri`, not `target`
  const dialVerb = this.verbBuilder.dialSip({
    sipUri,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  // Send as redirect to replace current verb stack
  this.ws.send(JSON.stringify({
    type: 'command',
    command: 'redirect',
    queueCommand: false,
    payload: [dialVerb],
  }));
}

playMessage(text: string, _options?: PlayMessageOptions): void {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

  // Phase 1: TTS only via say verb. Audio URL playback deferred to Phase 2.
  const sayVerb = this.verbBuilder.say(text);

  this.ws.send(JSON.stringify({
    type: 'command',
    command: 'redirect',
    queueCommand: false,
    payload: [sayVerb],
  }));
}
```

**Note on `hangup()` update:** The existing `hangup()` implementation (if any) needs the optional `reason` parameter added. Check current implementation and add `reason` to any event/log emission.

### Exit Criteria

- [ ] `KorevgSession.dialAgent()` sends `dialSip` verb via WebSocket
- [ ] `KorevgSession.playMessage()` sends `say` verb via WebSocket
- [ ] Both check `ws.readyState` before sending
- [ ] Verb builder parameter names match exactly (`sipUri`, not `target`)
- [ ] `pnpm build --filter=runtime` passes

---

## Step 7: Verify Webhook Route Handles Voice Events

### File: `apps/runtime/src/routes/agent-transfer-webhooks.ts`

**No code changes needed.** The existing normalization (lines 79-104) already:

1. Maps `eventName` → `type` (works for voice events)
2. Extracts `payload` → `data`, `payload.value` → `message`, `payload.conversationId` → `conversationId`
3. Extracts `agentInfo` from payload

Voice-specific payload extraction (`transferURI`, `sipHeaders`, `dialHeaders`) is handled in **Step 2** (`KoreEventHandler.processEvent()`) — NOT duplicated in the route.

**Verification checklist:**

- [ ] `assign_kore_agent_for_user` event passes normalization — `type` field set, `payload` promoted to `data`
- [ ] `call_status_notifications` event passes normalization
- [ ] `wait_time_voice_message_for_user` event passes normalization — `payload.value` promoted to `message`
- [ ] All three reach `adapter.handleInboundEvent()` → `processEvent()` where voice field extraction happens

---

## Step 8: Update Transfer Session on Voice Events

### File: `apps/runtime/src/services/agent-transfer/index.ts` (lines 212-253)

**Change:** In the `onAgentMessage` callback, add voice session updates after routing the event:

```ts
// After bridge.routeAgentEvent(ablKey, event) — add session state updates for voice

if (event.type === 'agent:connected' && session.channel === 'voice') {
  const agentSipURI = event.data?.agentSipURI as string | undefined;
  if (agentSipURI) {
    await transferSessionStore.update(ablKey, {
      state: 'active',
      voiceData: {
        ...session.voiceData,
        callSid: session.voiceData?.callSid ?? '',
        agentSipURI,
      },
    });
  }
}

if (event.type === 'agent:call_status') {
  const callStatus = event.data?.callStatus as string;
  if (['agent_hangup', 'user_hangup', 'failed', 'busy', 'no_answer'].includes(callStatus)) {
    await transferSessionStore.update(ablKey, {
      state: 'ended',
      voiceData: {
        ...session.voiceData,
        callSid: session.voiceData?.callSid ?? '',
        disconnectReason: callStatus,
      },
    });
  }
}
```

### Exit Criteria

- [ ] `agent:connected` for voice updates session with `agentSipURI` and `state: 'active'`
- [ ] `agent:call_status` with hangup reasons updates session with `disconnectReason` and `state: 'ended'`
- [ ] Existing `agent:disconnected` handling (lines 232-252) still works for chat
- [ ] `pnpm build --filter=runtime` passes

---

## Step 9: Voice Payload for SmartAssist Conversations API

**Added:** 2026-04-10 — identified during koreserver payload analysis

### Problem

When ABL initiates a voice transfer via `POST /agentassist/api/v1/conversations`, the payload is missing voice-specific fields that koreserver sends. SmartAssist needs these fields to route the call correctly and provide caller context to the agent.

### KoreServer sends (ABL was missing)

| Field                   | Source              | Purpose                                    |
| ----------------------- | ------------------- | ------------------------------------------ |
| `phoneNumber`           | caller phone number | Caller ANI for agent desktop display       |
| `CallIDData`            | SIP Call-ID header  | SIP call tracing/correlation               |
| `botSIPURI`             | config              | Bot SIP endpoint for SmartAssist callbacks |
| `voiceChatAgentLang`    | language config     | Agent-side TTS language                    |
| `voiceChatUserLang`     | language config     | User-side STT language                     |
| `recognizerLang`        | language config     | Speech recognizer language                 |
| `metaInfo.caller`       | caller number       | Caller metadata for agent                  |
| `metaInfo.callee`       | dialed number       | Called number metadata                     |
| `metaInfo.dialedNumber` | dialed number       | Dialed number metadata                     |
| `metaInfo.callerName`   | SIP callerName      | Display name (if available)                |
| `metaInfo.callerHost`   | SIP originating IP  | SIP trunk origin                           |

### Files Changed

**1. `packages/agent-transfer/src/types.ts`**

- Added `VoiceCallData` interface: `callSid`, `caller`, `called`, `sipCallId`, `sipFrom`, `sipTo`, `originatingSipIp`, `direction`, `callerName`
- Added `voiceData?: VoiceCallData` to `TransferPayload`

**2. `packages/agent-transfer/src/config/schema.ts`**

- Added `botSIPURI` (optional string) to `SmartAssistConfigSchema`

**3. `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`**

- Added `voiceData` field to `KoreTransferPayload`
- In `initTransfer()`: when `voiceData` is present, populates `phoneNumber`, `CallIDData`, `botSIPURI`, voice language fields, and `metaInfo` caller/callee data

**4. `packages/agent-transfer/src/adapters/kore/index.ts`**

- Passes `voiceData` through to `initTransfer()`
- Stores `callSid`, `sipCallId`, `caller`, `called` in `providerData` on session creation

**5. `apps/runtime/src/services/voice/korevg/korevg-session.ts`**

- Added `getVoiceTransferData()` public method exposing call metadata from private config

**6. `apps/runtime/src/services/execution/routing-executor.ts`**

- In ESCALATE handler: when channel is `'voice'`, looks up active `KorevgSession` via `getVoiceSession()`, calls `getVoiceTransferData()`, passes as `voiceData` in transfer payload

### Data Flow

```
Jambonz call arrives
  → KorevgSession created (holds callSid, caller, called, callInfo)
    → Bot dialog triggers ESCALATE
      → routing-executor looks up getVoiceSession(sessionId)
        → Extracts voice data into TransferPayload.voiceData
          → KoreAdapter.execute() passes to SmartAssistClient.initTransfer()
            → initTransfer() adds phoneNumber, botSIPURI, CallIDData,
              metaInfo.caller/callee/dialedNumber to POST body
                → SmartAssist conversations API receives full voice payload
```

### Exit Criteria

- [x] `VoiceCallData` type added and exported
- [x] `TransferPayload.voiceData` optional field added
- [x] `SmartAssistConfigSchema` includes `botSIPURI`
- [x] `initTransfer()` populates voice fields when `voiceData` present
- [x] `routing-executor.ts` extracts voice data from `KorevgSession` during ESCALATE
- [x] `KorevgSession.getVoiceTransferData()` exposes call metadata
- [x] `pnpm build --filter=@agent-platform/agent-transfer` passes
- [x] `pnpm build --filter=@agent-platform/runtime` passes

---

## Execution Order

```
Step 1  →  commit: "[ABLP-XXX] feat(agent-transfer): add voice event types to AgentEventType"
Step 2  →  commit: "[ABLP-XXX] feat(agent-transfer): map voice events and extract voice payload in KoreEventHandler"
Step 3  →  commit: "[ABLP-XXX] feat(agent-transfer): expand VoiceGatewaySession with dialAgent and playMessage"
Step 4  →  commit: "[ABLP-XXX] feat(agent-transfer): add voiceData to transfer session types"
Step 5  →  commit: "[ABLP-XXX] feat(runtime): route voice events in message bridge deliverViaVoiceGateway"
Step 6  →  commit: "[ABLP-XXX] feat(runtime): implement dialAgent and playMessage in KorevgSession"
Step 7  →  (no commit — verification only)
Step 8  →  commit: "[ABLP-XXX] feat(runtime): update transfer session state on voice events"
Step 9  →  commit: "[ABLP-XXX] feat(agent-transfer): add voice payload to SmartAssist conversations API"
```

Steps 1-4, 9: `packages/agent-transfer` package (shared library)
Steps 5-6, 8-9: `apps/runtime` (runtime application)
Step 7: verification only — no code changes

**Note:** Commit messages use `[ABLP-XXX]` placeholder — replace with actual Jira ticket before committing.

---

## Testing Strategy

### Manual E2E Test Flow

1. Configure ABL with a voice agent project pointing to SmartAssist
2. Inbound voice call → bot conversation → agent transfer triggers via escalation
3. Verify: SmartAssist creates conversation with `callback` URL and `conversationType: 'call'`
4. Agent accepts in AgentAssist desktop → verify ABL receives `agent_accepted` via webhook
5. Verify: Caller hears agent's voice (SIP dial completed via Jambonz)
6. Agent sends text message → verify caller hears TTS
7. Agent closes conversation → verify caller call ends

### Event Flow Validation Checklist

| Event               | AgentAssist Sends                              | ABL Receives            | ABL Action                      | Verify                                   |
| ------------------- | ---------------------------------------------- | ----------------------- | ------------------------------- | ---------------------------------------- |
| Agent queued        | `conversation_queued`                          | `agent:queued`          | Update session state            | Session state = `queued`                 |
| Waiting message     | `wait_time_voice_message_for_user`             | `agent:waiting_message` | `playMessage()` → TTS to caller | Caller hears queue position/hold message |
| Agent accepts       | `agent_accepted` (with transferURI in payload) | `agent:connected`       | `dialAgent()` → SIP to agent    | Caller + agent audio bridged             |
| Agent message       | `agent_message`                                | `agent:message`         | `sendAgentMessage()` → TTS      | Caller hears agent text                  |
| Agent hangup        | `call_status_notifications` (agent_hangup)     | `agent:call_status`     | `hangup()`                      | Call ends                                |
| Conversation closed | `conversation_closed`                          | `agent:disconnected`    | `hangup()` if active            | Call ends, session = `ended`             |

---

## Risks & Mitigations

| Risk                                                               | Mitigation                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `transferURI` format varies by voice gateway                       | KoreVG always provides `sip:agent@domain` format. `dialSip()` takes it directly. AudioCodes may differ — deferred to Phase 2. |
| WebSocket disconnected when `dialAgent()` is called                | Check `ws.readyState` before sending. If disconnected, throw and let caller handle.                                           |
| Race condition: agent accepts before voice session registered      | Voice session is established at call start (before transfer). If missing, log warning — caller stays in queue.                |
| `event.sessionId` overwritten with ABL key, not `callSid`          | `findVoiceSession()` resolves `callSid` from transfer session's `voiceData`, with fallback to direct ID lookup.               |
| `KorevgSession` duck-types `VoiceGatewaySession` (no `implements`) | New methods added directly to class. Structural compatibility verified by TypeScript.                                         |
| `providerData` stringified in Redis                                | `voiceData` stored as separate top-level field, not inside `providerData`. Store handles serialization.                       |
| AgentAssist sends events ABL doesn't handle yet (hold, recording)  | Unrecognized events fall through to `log.info('Unhandled voice event type')` — no crash, no data loss.                        |
| `verbBuilder.say()` streaming parameter is unused                  | Phase 1 uses non-streaming TTS only. Streaming say uses separate `openStreamingSay()` method if needed later.                 |

---

## Not in Phase 1 Scope

| Capability                                   | Phase    | Reason                                                                            |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| Hold/unhold                                  | Phase 2  | Requires `conference_actions` handling                                            |
| Recording controls (start/stop/pause/resume) | Phase 2  | Requires `korevg_recording_controls` handling                                     |
| Supervisor listen/whisper/barge-in           | Phase 3  | Requires full conference support                                                  |
| Consult call / warm transfer                 | Phase 4  | Requires multi-party call state management                                        |
| Agent-to-agent voice transfer                | Phase 4  | Requires SIP REFER handling on the agent side                                     |
| SIP REFER validation endpoint                | Phase 4  | Only needed for agent-initiated transfers                                         |
| AudioCodes-specific handling                 | Phase 2+ | Phase 1 targets KoreVG only                                                       |
| Transcription start/stop                     | Phase 2  | Dependent on recording infrastructure                                             |
| Audio URL playback (play verb)               | Phase 2  | Verb builder has no `.play()` method yet                                          |
| Studio UI for voice transfer config          | N/A      | **Already complete** — project-level, per-agent, and channel-level settings exist |
