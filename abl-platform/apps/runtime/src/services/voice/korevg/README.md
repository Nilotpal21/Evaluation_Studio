# Korevg/Jambonz Voice Integration

This module provides integration between ABL Platform and Korevg/Jambonz for voice-based agent interactions.

## Architecture

```
┌─────────────┐         WebSocket          ┌──────────────┐
│  Korevg/    │  ──────────────────────>   │ ABL Runtime  │
│  Jambonz    │  session:new, verb:hook    │ (/api/korevg │
│             │  <──────────────────────   │  /ws)        │
│             │  ack (Jambonz verbs)       │              │
└─────────────┘                            └──────────────┘
      │                                            │
      │ (Audio)                                    │ (Text)
      ▼                                            ▼
┌─────────────┐                            ┌──────────────┐
│ STT (Deepgram)│                          │RuntimeExecutor│
│ TTS (ElevenLabs)│                        │ (ABL Agent)  │
└─────────────┘                            └──────────────┘
```

## Components

### 1. **verb-builder.ts**

Builds Jambonz verb responses from ABL agent outputs:

- `say`: Text-to-speech with streaming support
- `gather`: Collect speech input with STT
- `listen`: Continuous transcription
- `hangup`: End the call

### 2. **korevg-session.ts**

Manages individual call sessions:

- Handles `session:new` events (new calls)
- Handles `verb:hook` events (STT results)
- Uses `RuntimeExecutor` to process text with ABL agents
- Returns Jambonz verbs based on agent responses
- Supports streaming text-to-speech

### 3. **korevg-router.ts**

WebSocket router for incoming Korevg/Jambonz connections:

- Handles WebSocket upgrades with protocol negotiation
- Routes calls to `KorevgSession` instances
- Manages session lifecycle

## WebSocket URL Format

```
ws://localhost:3112/api/korevg/ws/:projectId/:deploymentId?agentId=xxx&callSid=yyy&caller=zzz
```

**Path Parameters:**

- `projectId`: ABL project ID
- `deploymentId`: ABL deployment ID

**Query Parameters:**

- `agentId` (optional): Specific agent ID (defaults to deploymentId)
- `callSid` (optional): Call identifier from Jambonz
- `caller` (optional): Caller phone number
- `called` (optional): Called phone number
- `ttsVendor` (optional): TTS provider (default: elevenlabs)
- `ttsVoice` (optional): TTS voice (default: rachel)
- `sttVendor` (optional): STT provider (default: deepgram)

## Message Protocol

### Incoming Messages (Jambonz → ABL)

#### session:new

```json
{
  "type": "session:new",
  "msgid": "msg-123",
  "call_sid": "call-456",
  "data": {
    "caller": "+1234567890",
    "called": "+0987654321"
  }
}
```

#### verb:hook

```json
{
  "type": "verb:hook",
  "msgid": "msg-124",
  "call_sid": "call-456",
  "hook": "/gather",
  "data": {
    "speech": {
      "transcript": "Hello, I need help",
      "confidence": 0.95,
      "language_code": "en-US"
    }
  }
}
```

### Outgoing Messages (ABL → Jambonz)

#### ack (verb response)

```json
{
  "type": "ack",
  "msgid": "msg-123",
  "data": [
    {
      "verb": "say",
      "text": "Hello! How can I help you?",
      "stream": true,
      "synthesizer": {
        "vendor": "elevenlabs",
        "voice": "rachel"
      }
    },
    {
      "verb": "gather",
      "input": ["speech"],
      "actionHook": "http://localhost:3112/api/korevg/hook/session-789",
      "timeout": 60,
      "speechTimeout": 10,
      "recognizer": {
        "vendor": "deepgram",
        "language": "en-US"
      }
    }
  ]
}
```

## Configuration in Korevg/Jambonz

### Application Configuration

In your Korevg/Jambonz application configuration, set the WebSocket URL:

```json
{
  "type": "application",
  "name": "ABL Agent Integration",
  "app_json": {
    "webhook": {
      "url": "ws://your-abl-runtime:3112/api/korevg/ws/proj-123/deploy-456?agentId=agent-789",
      "method": "WS"
    },
    "speech_synthesis_vendor": "elevenlabs",
    "speech_synthesis_voice": "rachel",
    "speech_recognizer_vendor": "deepgram",
    "speech_recognizer_language": "en-US"
  }
}
```

### SIP Number Routing

Point your SIP number to the ABL application in Korevg/Jambonz portal:

1. Navigate to **Phone Numbers** in Korevg portal
2. Select your DID/phone number
3. Set **Application** to your ABL Agent Integration application
4. Save changes

## Supported Verbs

| Verb     | Description              | Streaming | Example Use Case      |
| -------- | ------------------------ | --------- | --------------------- |
| `say`    | Text-to-speech           | Yes       | Agent responses       |
| `gather` | Collect speech input     | N/A       | User input collection |
| `listen` | Continuous transcription | Yes       | Real-time monitoring  |
| `hangup` | End call                 | N/A       | Completion/errors     |

## Example Flow

1. **Incoming Call**
   - Korevg sends `session:new` event
   - ABL initializes RuntimeExecutor session
   - ABL sends greeting: `say` + `gather`

2. **User Speaks**
   - Korevg transcribes speech (Deepgram)
   - Korevg sends `verb:hook` with transcript
   - ABL processes text with agent
   - ABL streams response: `say` + `gather`

3. **Conversation Continues**
   - Repeat step 2 for each turn
   - Agent can access full conversation history

4. **Completion**
   - Agent signals completion
   - ABL sends final `say` + `hangup`
   - Korevg ends the call

## Error Handling

- **No transcript in verb:hook**: Re-prompt with "I didn't catch that"
- **RuntimeExecutor error**: Send apology + re-prompt
- **WebSocket error**: Log error, close connection gracefully
- **Invalid URL format**: Close WebSocket with 1008 error

## Testing

### 1. Test WebSocket Connection

```bash
wscat -c "ws://localhost:3112/api/korevg/ws/proj-test/deploy-test?agentId=agent-test" \
  --subprotocol ws.jambonz.org
```

### 2. Send Test session:new

```json
{
  "type": "session:new",
  "msgid": "test-msg-1",
  "call_sid": "test-call-1",
  "data": {}
}
```

### 3. Send Test verb:hook

```json
{
  "type": "verb:hook",
  "msgid": "test-msg-2",
  "call_sid": "test-call-1",
  "hook": "/gather",
  "data": {
    "speech": {
      "transcript": "Hello",
      "confidence": 0.95
    }
  }
}
```

## Monitoring

Check logs for Korevg events:

```bash
docker logs abl-runtime | grep korevg
```

Monitor active sessions:

```bash
curl http://localhost:3112/health
# Check korevgRouter.getSessionCount()
```

## Configuration

The Korevg router is initialized in [server.ts](../../../server.ts) with:

```typescript
const korevgRouter = new KorevgRouter({
  baseUrl: config.server.publicUrl || `http://localhost:${config.server.port}`,
});
```

To customize:

- Set `PUBLIC_URL` environment variable for public-facing deployments
- TTS/STT vendors can be overridden via URL query parameters

## Future Enhancements

- [ ] Support for DTMF input (`gather` with `input: ['dtmf']`)
- [ ] Mid-call verb updates via `command` messages
- [ ] Conference integration for multi-party calls
- [ ] Real-time transcription streaming (`listen` verb)
- [ ] Agent transfer between different ABL agents
- [ ] Call recording and playback integration
