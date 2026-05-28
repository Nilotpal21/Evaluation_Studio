---
name: korevg-voice-gateway
description: Use when working on voice/IVR features, KoreVG WebSocket integration, Jambonz verb generation, TTS/STT streaming, DTMF handling, voice agent transfer, or any voice channel work in ABL or XO.
---

# KoreVG Voice Gateway Reference

KoreVG is Kore.ai's Jambonz-based voice gateway. XO has the full production server; ABL has a modern TypeScript integration layer. Both share the same Jambonz WebSocket protocol.

## Architecture Overview

```
                    ┌──────────────┐
  PSTN/SIP ───────→│   Jambonz    │←─── SIP Trunks / Carriers
                    │  (mediator)  │
                    └──────┬───────┘
                           │ WebSocket (ws.jambonz.org)
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼─────────┐    ┌─────────▼─────────┐
    │  XO KoreVGServer   │    │  ABL korevg-router │
    │  (koreserver/      │    │  (apps/runtime/    │
    │   KoreVGServer/)   │    │   services/voice/) │
    └────────────────────┘    └────────────────────┘
```

## Jambonz WebSocket Protocol

### Message Types (Jambonz → Runtime)

**session:new** — New incoming call:

```json
{
  "type": "session:new",
  "msgid": "unique-id",
  "call_sid": "call-identifier",
  "data": {
    "from": "+1234567890",
    "to": "+0987654321",
    "direction": "inbound",
    "account_sid": "ACC-123",
    "application_sid": "APP-456",
    "sip": { "headers": { "call-id": "...", "user-agent": "..." } },
    "defaults": {
      "synthesizer": { "vendor": "elevenlabs", "voice": "..." },
      "recognizer": { "vendor": "deepgram", "language": "en-US" }
    }
  }
}
```

**verb:hook** — User speech/DTMF captured:

```json
{
  "type": "verb:hook",
  "msgid": "msg-456",
  "call_sid": "call-id",
  "hook": "/ws/korevg/{streamId}",
  "data": {
    "speech": {
      "alternatives": [{ "transcript": "hello", "confidence": 0.95 }],
      "language_code": "en-US"
    }
  }
}
```

**verb:status** — Verb completion metrics:

```json
{
  "type": "verb:status",
  "data": {
    "event": "start-playback|synthesized-audio|completed",
    "verb": "say",
    "elapsedTime": 145,
    "vendor": "elevenlabs",
    "characters": 1204,
    "servedFromCache": false
  }
}
```

**tts:streaming-event** — TTS stream lifecycle:

```json
{ "type": "tts:streaming-event", "data": { "event_type": "stream_open|stream_close|stream_error" } }
```

**call:status** — Call state change:

```json
{ "type": "call:status", "data": { "call_status": "in-progress|completed|no-answer|busy" } }
```

### Response Types (Runtime → Jambonz)

**ACK** (verb array response to any inbound message):

```json
{
  "type": "ack",
  "msgid": "incoming-msg-id",
  "data": [
    { "verb": "config", ... },
    { "verb": "say", "text": "Hello!", "stream": true },
    { "verb": "gather", ... }
  ]
}
```

**Command** (proactive verb push):

```json
{
  "type": "command",
  "command": "redirect",
  "queueCommand": false,
  "data": [
    /* verb array */
  ]
}
```

**TTS Tokens** (streaming):

```json
{
  "type": "command",
  "command": "tts:tokens",
  "queueCommand": false,
  "data": { "id": 1, "tokens": "hello " }
}
```

**TTS Flush** (end of streaming):

```json
{ "type": "command", "command": "tts:flush", "queueCommand": false }
```

## Jambonz Verb Reference

| Verb          | Purpose                  | Key Properties                                                                         |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `say`         | Text-to-speech           | `text`, `stream`, `synthesizer: { vendor, voice, language }`                           |
| `gather`      | Capture speech/DTMF      | `input`, `timeout`, `bargein`, `listenDuringPrompt`, `actionHook`, `say`, `recognizer` |
| `config`      | Set session defaults     | `synthesizer`, `recognizer`, `bargeIn`, `ttsStream`, `notifyEvents`                    |
| `hangup`      | End call                 | `headers` (X-KoreReason, X-KoreBotId)                                                  |
| `answer`      | Answer incoming call     | (no properties)                                                                        |
| `listen`      | Continuous transcription | `url` (WebSocket), `mixType`, `transcribe`                                             |
| `play`        | Audio playback           | `url`                                                                                  |
| `pause`       | Silence                  | duration (ms)                                                                          |
| `redirect`    | Transfer call            | `method`, URL                                                                          |
| `tag`         | Custom metadata          | `data` object                                                                          |
| `sip_request` | SIP INFO                 | `method`, `headers` (X-AC-Action for SIPREC)                                           |

## XO KoreVGServer Implementation

**Location:** `xo-platform/koreserver/KoreVGServer/`

**Core files:**

- `index.js` (2,285 lines) — WebSocket server, session lifecycle, ClientMap
- `eventSynchronizer.js` — Redis pub/sub queue with distributed locks
- `agenticResponseHandler.js` — Future agentic response handling

**ClientMap** (global session store):

```javascript
ClientMap[conversationId] = {
  ws, // WebSocket connection
  appId, // Jambonz application ID
  connected: true,
  messageTimestamps: [], // For latency tracking
  lastUserInput: '',
  ringDurationObj,
  connectDurationObj,
  childCallIds: [], // For conferencing
};
```

**Response pipeline:**

```
Bot response → Redis pub (KOREVG_OBSERVER) → KoreVGListener
    → KoreVGConverter.initiateConversion()
    → kvgTags helper (verb array)
    → Redis pub back → KoreVGServer → WebSocket send
```

**KoreVGConverter** (`Templates/services/KoreVGConverter.js`, 2,285 lines):

- `initiateConversion()` — main entry, routes based on OOB flags
- `kvgTags` helper class — wraps Jambonz WebhookResponse, builds verb arrays
- `recordingCtrl` class — SIPREC control (start/stop/pause/resume via SIP INFO)
- `savgRecordingCtrl` class — SmartAssist Voice Gateway recording
- IVR options: `mergeAllMessages()`, `prepareSpeechContext()`, `prepareGatherElements()`
- Hint validation: max 500 hints, <100 chars each

**KoreVGListener** (`Templates/Adapters/KoreVGListener.js`, 459KB):

- Redis subscriptions: `cs_response`, `agentic_realtime`, `noinput_message`, `voice_biometrics`, `collect_user_input`
- Session keys: `kvg:{callSid}`, `kvg:{callSid}:timestamps`, `kvg:{callSid}:noinput`
- Routes to: `handleVerbHook()`, `handleNoInput()`, `handleBiometric()`

**VoiceAgentExecutor** (`Templates/services/VoiceAgentExecutor/`):

- Plugin pattern: `require("./lib/" + agentName + "VoiceAgent.js")`
- Handlers: `koreVoiceAgent`, `genesysVoiceAgent`, `customVoiceAgent`, `customVoiceVoiceAgent`
- Routes based on SmartAssistBotSettings: `"koreAgent"`, `"sipTransfer"`, `"callNumber"`

## ABL KoreVG Implementation

**Location:** `apps/runtime/src/services/voice/korevg/`

### korevg-router.ts — WebSocket Gateway

- **Path:** `/ws/korevg/{streamId}?token=XXX&agentId=XXX&ttsVendor=XXX&sttVendor=XXX`
- **Auth:** Token from query param or header, matched against connection config
- **Session limit:** `MAX_KOREVG_SESSIONS` (default 500, configurable via env)
- **Early ACK pattern:** Immediate `[{ verb: 'answer' }]` to prevent Jambonz timeout, then async setup
- **Registry:** `Map<sessionId, KorevgSession>` per call

**Setup flow:**

1. WebSocket upgrade → register early handler
2. Capture `session:new` msgid → send `[{ verb: 'answer' }]` immediately
3. Parse URL, validate auth, resolve deployment, create RuntimeExecutor session
4. Create `KorevgSession` instance
5. `session.sendGreeting()` → config verb + streaming say verb

**Vendor resolution (priority):**

```
connectionConfig.{vendor} || urlParam.{vendor} || DEFAULT_KOREVG_{VENDOR}
```

Defaults: TTS=elevenlabs (Bella voice), STT=deepgram

### korevg-session.ts — Per-Call Handler

**Message queue:** Sequential processing, `MAX_KOREVG_QUEUE_SIZE = 50`

**State machine:**

```
session:new → (early ack) → sendGreeting() → config + say → verb:hook loop
verb:hook → executeMessage() → (streaming: tts:tokens) → redirect/say → loop or hangup
```

**TTS streaming state:**

```typescript
ttsStreamOpen: boolean          // Is stream currently connected?
ttsBuffer: string[]             // Chunks waiting for stream open
ttsConnectionRequestTime: number // When stream_open was requested
```

**Voice turn instrumentation (OTEL + TraceStore + ClickHouse):**

```
startVoiceTurn() → completeSTTPhase() → startLLMPhase() → completeLLMPhase()
    → startTTSPhase() → completeTTSPhase() → completeVoiceTurn()
```

Each phase emits: `voice_stt`, `voice_tts`, `voice_turn` trace events with latency breakdown.

**DB session linking:** `createAndLinkDBSession({ channel: 'voice', callSid, caller, ... })`

**Streaming mode:** Resolved per-agent at call start from `findAgentModelConfig()`. When true: TTS stream stays open, tokens flow continuously. When false: separate say verbs per response.

### verb-builder.ts — Jambonz Verb Builder

```typescript
say(text, { streaming?, voice? }): SayVerb
gather({ actionHook?, prompt?, timeout?, speechTimeout?, bargein? }): GatherVerb
listen(wsUrl, { actionHook?, timeout? }): ListenVerb
buildConfig({ ttsVendor?, ttsVoice?, sttVendor? }): ConfigVerb
buildStreamingConfig(actionHook, { streaming? }): ConfigVerb  // Full sticky gather + TTS stream
```

**Sticky gather config (keeps listening between responses):**

```typescript
{
  verb: 'config',
  bargeIn: { enable: true, sticky: true, input: ['speech'], minBargeinWordCount: 1 },
  ttsStream: { enable: true, synthesizer: { vendor, voice, language } },
  recognizer: { vendor, language, deepgramOptions: { endpointing: 600, utteranceEndMs: 1500 } }
}
```

**Language note:** ElevenLabs uses ISO 639-1 (`'en'`), NOT locale codes (`'en-US'`) — wrong format causes WebSocket rejection.

### jambonz-provisioning.service.ts — Jambonz API Client

**Methods:**

- `createApplication()` / `deleteApplication()` — Jambonz apps with webhook URLs
- `addPhoneNumber()` / `deletePhoneNumber()` — Register to applications
- `createSpeechCredential()` — STT/TTS vendor keys (Deepgram, ElevenLabs, Google, AWS, Azure)
- `createVoipCarrier()` + `addSipGateway()` — BYOC SIP carrier setup
- `getSupportedLanguagesAndVoices()` — Query available vendors/models

**Auth:** `Authorization: Bearer {apiKey}`

### korevg-adapter.ts — Channel Adapter

```typescript
class KorevgAdapter implements ChannelAdapter {
  channelType = 'korevg';
  capabilities = { supportsStreaming: true, supportsAsync: false, supportsMedia: false };
}
```

**Note:** `jambonz` is an internal infrastructure channel — NOT in CHANNEL_MANIFEST, not user-facing.

## XO vs ABL Comparison

| Aspect               | XO                                  | ABL                                                     |
| -------------------- | ----------------------------------- | ------------------------------------------------------- |
| **Architecture**     | Redis pub/sub + ClientMap           | Direct WebSocket + in-memory sessions                   |
| **Session state**    | Redis `kvg:{callSid}`               | `KorevgSession` instance (in-memory)                    |
| **Streaming TTS**    | `stream: true` in say verb          | Full TTS stream mode + sticky gather                    |
| **Token delivery**   | Not implemented                     | `tts:tokens` + `tts:flush` commands                     |
| **Tracing**          | Manual timestamps                   | OTEL spans + voice trace events                         |
| **Turn metrics**     | Manual tracking                     | Centralized `voice_turn` events                         |
| **Agent transfer**   | VoiceAgentExecutor plugin           | TransferToolExecutor → RuntimeExecutor                  |
| **Recording**        | SIPREC via SIP INFO                 | Via config verb `record` action                         |
| **Early ACK**        | Optional (full verb on session:new) | Mandatory (answer verb, then greeting)                  |
| **No-input**         | Timeout messages + retry counter    | Sticky gather with auto-restart                         |
| **Deepgram tuning**  | Basic config                        | Explicit `endpointing: 600ms`, `utteranceEndMs: 1500ms` |
| **Voice biometrics** | Redis channel + handlers            | Not implemented                                         |
| **Deployment**       | Per-bot Jambonz app                 | Per-project Jambonz connection                          |

## Key Integration Points

**ABL voice tools → verb-builder pipeline:**

```
ivr-menu.ts / ivr-digit-input.ts → should produce gather verbs via verb-builder
call-transfer.ts                 → should produce redirect/sip_request verbs
deflect-to-chat.ts               → should trigger session handoff
```

**Agent transfer on voice:**

```
Bot decides transfer → smartassist_transfer_to_agent tool
    → TransferToolExecutor.execute()
    → SmartAssist API call
    → Webhook events arrive at /api/v1/agent-transfer/webhooks
    → Event routed to korevg-session (reconnect call to bot after agent closes)
```

**OOB flag flow:**

```
Bot response has OOB flags → korevg-session intercepts
    → parseOOBFlags() in event-handler.ts
    → Route: agentTransfer → transfer flow, deflection → deflect, conversationEnd → hangup
```

## Constants

```typescript
MAX_KOREVG_SESSIONS = 500; // Concurrent voice session cap
MAX_KOREVG_QUEUE_SIZE = 50; // Per-session message buffer
DEFAULT_KOREVG_TTS_VENDOR = 'elevenlabs';
DEFAULT_KOREVG_TTS_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Bella
DEFAULT_KOREVG_STT_VENDOR = 'deepgram';
```
