# LiveKit Voice Pipeline — Handshake & Agent Worker State Machine

## Overview

The LiveKit integration uses an **in-process model** (v1.0) where all agents run embedded
in the runtime server process. This eliminates cross-process adapter registry issues and
enables direct memory references for session data.

```
Browser (WebRTC via LiveKit SDK)
    |
LiveKit Server (media routing)
    |
Runtime Server (Node.js, in-process)
    +-- REST API (token generation)
    +-- LiveKit Worker (agent lifecycle)
    +-- Agent Worker (voice.Agent + AgentSession)
    +-- RuntimeLLMAdapter (bridge to RuntimeExecutor)
    +-- RuntimeExecutor (DSL execution engine)
```

---

## Complete State Machine

```
                    +---------------------------+
                    | CLIENT                    |
                    | POST /api/livekit/token   |
                    | { sessionId, projectId,   |
                    |   agentName?,             |
                    |   deploymentId? }         |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | 1. INPUT VALIDATION       |
                    |    ID pattern check       |
                    |    ^[a-zA-Z0-9_\-]{1,128} |
                    |    400 if invalid         |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | 2. CONCURRENCY CHECK      |
                    |    activeRoomCount()      |
                    |    >= maxConcurrentRooms? |
                    |    429 if exceeded        |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | 3. CREDENTIAL PRE-FLIGHT  |
                    |    resolveVoiceCredentials |
                    |    STT (Deepgram) present?|
                    |    TTS (ElevenLabs) ok?   |
                    |    422 if missing         |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | 4. TOKEN GENERATION       |
                    |    Room: voice_{tenant}_  |
                    |      {project}_{session}  |
                    |    TTL: configurable      |
                    |    Grants: publish,       |
                    |      subscribe, join      |
                    +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | 5. RESPONSE (HTTP 200)    |
                    |    { token, roomName,     |
                    |      url, identity }      |
                    +--+------------------------+
                       |
          +------------+------------+
          |                         |
          v                         v
+-------------------+   +-------------------------+
| CLIENT            |   | 6. SPAWN AGENT          |
| Join room with    |   |    (fire-and-forget)    |
| token via         |   |    spawnAgentForRoom()  |
| LiveKit SDK       |   |    Non-blocking         |
+-------------------+   +------------+------------+
                                     |
                                     v
                    +-------------------------------+
                    | 7. AGENT WORKER INIT          |
                    |    (startAgentInRoom)         |
                    |                               |
                    |  a. Initialize logger         |
                    |  b. Create RuntimeLLMAdapter  |
                    |     +-- Deployment path       |
                    |     |   (DeploymentResolver)  |
                    |     +-- Legacy path           |
                    |         (DSL cache + compile) |
                    |  c. Register adapter          |
                    |  d. Resolve voice credentials |
                    |  e. Generate agent token      |
                    |  f. Connect to room           |
                    |  g. Load Deepgram STT plugin  |
                    |  h. Load ElevenLabs TTS plugin|
                    |  i. Load Silero VAD plugin    |
                    |  j. Create RuntimeBridgeAgent |
                    |  k. Create AgentSession       |
                    |  l. Start pipeline            |
                    +---------------+---------------+
                                    |
                                    v
                    +-------------------------------+
                    | 8. AUDIO PIPELINE ACTIVE      |
                    |                               |
                    |  User speaks                  |
                    |    -> Silero VAD (turn detect) |
                    |    -> Deepgram STT (speech    |
                    |       to text)                |
                    |    -> agent.llmNode() called  |
                    |    -> RuntimeLLMAdapter.chat() |
                    |    -> RuntimeExecutor          |
                    |       .executeMessage()       |
                    |    -> Streaming chunks        |
                    |    -> ElevenLabs TTS          |
                    |    -> Audio back to user      |
                    |                               |
                    |  Data channel:                |
                    |    transcript + timing        |
                    +---------------+---------------+
                                    |
                                    v
                    +-------------------------------+
                    | 9. CLEANUP                    |
                    |                               |
                    |  a. AgentSession.close()      |
                    |  b. Room.disconnect()         |
                    |  c. Unregister adapter        |
                    |  d. Adapter.dispose()         |
                    |     -> executor.endSession()  |
                    +-------------------------------+
```

---

## Phase 1: Client Request — Token Generation

### Endpoint

```
POST /api/livekit/token
Authorization: Bearer <JWT> | X-API-Key: <api-key>

{
  "sessionId":     "sess-abc123",        // required, alphanumeric 1-128 chars
  "projectId":     "proj-traveldesk",    // required, alphanumeric 1-128 chars
  "agentName":     "greeting_agent",     // optional, alphanumeric 1-64 chars
  "deploymentId":  "deploy-prod-v2"      // optional, alphanumeric 1-128 chars
}
```

**Source:** `routes/livekit.ts`

### Validation

All IDs are validated against `/^[a-zA-Z0-9_\-]{1,128}$/` (agentName limit is 64).
Rejects path traversal, special characters, SQL injection payloads.
Returns **400** on invalid input.

### Concurrency Guard

```typescript
const maxRooms = config.voice.livekit.maxConcurrentRooms; // default: 50
if (activeRoomCount() >= maxRooms) {
  return res.status(429).json({ error: 'Maximum concurrent voice sessions reached' });
}
```

`activeRoomCount()` reads from the `activeAdapters` Map in `worker-entry.ts`.

### Credential Pre-Flight

Before generating a token, the route verifies that the tenant has voice credentials
configured. This prevents the user from joining a room where no agent can start.

```typescript
const creds = await voiceFactory.resolveVoiceCredentials(tenantId);
if (!creds.stt || !creds.tts) {
  return res.status(422).json({
    error: 'Voice credentials not configured',
    details: {
      stt: !creds.stt ? 'Deepgram STT credentials missing' : 'ok',
      tts: !creds.tts ? 'ElevenLabs TTS credentials missing' : 'ok',
    },
    hint: 'Configure voice service credentials in Workspace Settings > Voice Services',
  });
}
```

Credentials are tenant-scoped, encrypted at rest (AES-256-GCM), decrypted on demand,
and cached for 10 minutes in `VoiceServiceFactory`.

### Room Name & Token

**Room name format:** `voice_{tenantId}_{projectId}_{sessionId}`

Tenant-scoped to prevent cross-tenant collision.

**User token grants:**

| Grant            | Value | Purpose                        |
| ---------------- | ----- | ------------------------------ |
| `roomJoin`       | true  | Can join the room              |
| `canPublish`     | true  | Can send audio (microphone)    |
| `canSubscribe`   | true  | Can receive audio (speaker)    |
| `canPublishData` | false | Users cannot publish data msgs |

**TTL:** Configurable via `voice.livekit.tokenTtlSeconds` (default: 3600s).

### Response

```json
{
  "token": "eyJhbGciOi...",
  "roomName": "voice_org-acme_proj-travel_sess-user123",
  "url": "wss://livekit.example.com",
  "identity": "user_a1b2c3d4"
}
```

The LiveKit server URL is only exposed here, never in the `/capabilities` endpoint
(infrastructure topology kept private).

### Agent Spawn (Fire-and-Forget)

Immediately after returning the token, the route spawns an agent in the background:

```typescript
spawnAgentForRoom(roomName, metadata).catch((err) => {
  log.error('Failed to spawn agent for room', { roomName, error: err.message });
});
```

Non-blocking: the HTTP response returns before the agent connects. The agent should
connect before or shortly after the user joins.

---

## Phase 2: Agent Worker Initialization

**Entry:** `spawnAgentForRoom()` in `worker-entry.ts` -> `startAgentInRoom()` in `agent-worker.ts`

### Guards

1. **Worker running:** `workerRunning` flag must be true (set during server startup)
2. **Duplicate prevention:** `activeConnections.has(roomName)` rejects if agent already active

### Initialization Sequence

Each step is ordered — failure at any step aborts the entire sequence and cleans up
resources allocated by prior steps.

#### Step A: Logger

```typescript
const agents = await import('@livekit/agents');
agents.initializeLogger({ pretty: false, level: 'warn' });
```

Required before creating any v1.0 plugins (STT/TTS/VAD call logging internally).

#### Step B: RuntimeLLMAdapter

```typescript
const adapter = new RuntimeLLMAdapter({
  sessionId,
  projectId,
  agentName,
  tenantId,
  deploymentId,
});
await adapter.initialize();
```

`initialize()` has two paths (see [Session Initialization Paths](#session-initialization-paths)).
Creates the RuntimeSession that will process all messages for this voice call.

#### Step C: Adapter Registration

```typescript
registerAdapter(roomName, adapter);
```

Adds to the global `activeAdapters` Map. Enables concurrency tracking and graceful shutdown.

#### Step D: Voice Credential Resolution

```typescript
const voiceCreds = await voiceFactory.resolveVoiceCredentials(tenantId);
```

Queries `TenantServiceInstance` records from MongoDB, decrypts API keys.

Returns:

```typescript
{
  stt: { apiKey: string, model?: string },       // Deepgram
  tts: { apiKey: string, voiceId?: string, model?: string },  // ElevenLabs
}
```

If either is missing, throws (agent spawn fails).

#### Step E: Agent Token Generation

```typescript
const agentIdentity = `agent_${roomName.slice(0, 40)}_${Date.now()}`;
const at = new AccessToken(apiKey, apiSecret, { identity: agentIdentity });
at.addGrant({
  room: roomName,
  roomJoin: true,
  canPublish: true, // Agent sends audio
  canSubscribe: true, // Agent receives audio
  canPublishData: true, // Agent publishes transcript/timing
});
```

**Difference from user token:** Agent gets `canPublishData: true`.

#### Step F: Room Connection

```typescript
const room = new rtc.Room();
await room.connect(livekitUrl, agentToken);
```

WebRTC connection established. Agent is now a participant in the room.

#### Step G: STT Plugin (Deepgram)

```typescript
const stt = new deepgramPlugin.STT({
  apiKey: voiceCreds.stt.apiKey,
  model: voiceCreds.stt.model || 'nova-3',
  language: 'en',
});
```

Tenant-scoped API key and model. Language is hardcoded to English.

#### Step H: TTS Plugin (ElevenLabs)

```typescript
const tts = new elevenLabsPlugin.TTS({
  apiKey: voiceCreds.tts.apiKey,
  voiceId: voiceCreds.tts.voiceId,
  modelId: voiceCreds.tts.model || 'eleven_turbo_v2',
});
```

Voice ID is optional — ElevenLabs uses a default if not specified.

#### Step I: VAD Plugin (Silero)

```typescript
try {
  const sileroPlugin = await import('@livekit/agents-plugin-silero');
  vad = await sileroPlugin.VAD.load();
} catch {
  log.warn('Silero VAD plugin not available, proceeding without VAD');
}
```

**Graceful degradation:** Only plugin that is optional. Agent proceeds without
voice activity detection if Silero is unavailable.

#### Step J: RuntimeBridgeAgent

```typescript
class RuntimeBridgeAgent extends voice.Agent {
  constructor() {
    super({ instructions: '' }); // No LLM instructions — RuntimeExecutor owns the logic
  }

  async llmNode(chatCtx, _toolCtx, _modelSettings) {
    // Override: route through RuntimeExecutor instead of calling external LLM
    // See "LLM Bridge" section below
  }
}
```

Subclasses LiveKit's `voice.Agent`. The `llmNode()` override is the key integration
point — it intercepts all LLM calls and routes them through the RuntimeExecutor.

#### Step K: AgentSession

```typescript
const session = new voice.AgentSession({ vad, stt, tts, llm: new PipelineLLM() });
```

`PipelineLLM` is a stub that satisfies the pipeline's LLM type gate but is never
called directly — `llmNode()` override takes precedence.

#### Step L: Start Pipeline

```typescript
await session.start({ room, agent });
```

Activates the audio pipeline:

1. **Input:** Subscribe to user's audio track
2. **VAD:** Detect speech boundaries
3. **STT:** Transcribe speech to text
4. **LLM:** Call `agent.llmNode(chatCtx)` with transcript
5. **TTS:** Synthesize response text to audio
6. **Output:** Publish audio track to room

---

## Phase 3: Audio Pipeline — Per-Turn Flow

Once the pipeline is active, each user utterance triggers this sequence:

```
User speaks into microphone
    |
    v
Browser WebRTC (getUserMedia)
    |
    v
LiveKit Server (media relay)
    |
    v
Agent receives audio frames (@livekit/rtc-node)
    |
    v
Silero VAD detects speech end
    |
    v
Deepgram STT transcribes -> "I want to fly to Paris"
    |
    v
Pipeline calls agent.llmNode(chatCtx)
    |
    v
+-------------------------------------------------------+
| RuntimeBridgeAgent.llmNode()                          |
|                                                       |
| 1. Extract last user message from ChatContext         |
| 2. Start trace (traceLiveKitTurnStart)                |
| 3. Create ReadableStream<string> for TTS              |
| 4. RETURN stream immediately (TTS starts consuming)   |
|                                                       |
| 5. Background async:                                  |
|    a. adapter.chat(userText, onChunk)                 |
|       -> RuntimeExecutor.executeMessage()             |
|       -> Agent DSL execution (tools, flow, etc.)      |
|       -> Each chunk enqueued to stream                |
|    b. Close stream when done                          |
|    c. Publish transcript to data channel              |
|    d. Publish timing breakdown to data channel        |
|    e. Persist messages to DB                          |
+-------------------------------------------------------+
    |
    v (stream consumed by TTS as chunks arrive)
ElevenLabs TTS synthesizes audio
    |
    v
Audio track published to LiveKit room
    |
    v
Browser receives and plays audio
```

### Key Design Decisions

1. **Immediate stream return:** The `ReadableStream<string>` is returned to the pipeline
   before the RuntimeExecutor finishes. TTS starts synthesizing from the first chunk
   without waiting for the full response.

2. **Background processing:** Response accumulation, data channel publishing, and DB
   persistence all happen in a fire-and-forget async block.

3. **Voice text override:** If the agent's DSL includes a `VOICE: PLAIN_TEXT` block,
   that text is sent to TTS instead of the full response. This allows voice-optimized
   phrasing (e.g., shorter sentences, pronunciation hints).

4. **Fallback:** If no chunks were streamed (e.g., single-step response), the full
   response text is enqueued as one chunk before closing the stream.

### Data Channel Messages

**Transcript (after each turn):**

```json
{
  "type": "transcript",
  "userText": "I want to fly to Paris",
  "agentText": "I can help you find flights to Paris...",
  "timestamp": 1702500123456
}
```

**Timing (after each turn):**

```json
{
  "type": "timing",
  "timing": {
    "total": 3500,
    "stt": 250,
    "llm": 2800,
    "tts": 450,
    "ttsFirstChunk": 150
  }
}
```

Sent via reliable data channel (retransmit on loss). Non-critical — errors are
silently ignored.

---

## Session Initialization Paths

The `RuntimeLLMAdapter.initialize()` method has two paths for creating the
RuntimeSession that backs the voice conversation.

### Path A: Deployment-Aware (Production)

**Trigger:** `deploymentId` present in metadata.

```
adapter.initialize()
    |
    v
DeploymentResolver.resolve({
  projectId, tenantId, deploymentId, agentName
})
    |
    v
Query DeploymentVersion record (pre-compiled IR)
    |
    v
executor.createSessionFromResolved(resolved, {
  channelType: 'voice_livekit',
  deploymentId, tenantId, projectId
})
```

**Advantages:**

- No fresh DSL compilation (uses IR stored at deployment time)
- Version pinned — exact same agent behavior as deployment
- Faster initialization

**Failure:** If deployment is retired (HTTP 410), throws immediately with no fallback.
Other errors fall through to Path B.

### Path B: Legacy DSL Cache + Compile (Development)

**Trigger:** `deploymentId` missing, or Path A failed (non-410 error).

```
adapter.initialize()
    |
    v
Check DSL cache (key: "{tenantId}:{projectId}", TTL: 5 min)
    |
    +-- Cache HIT: reuse cached DSLs
    |
    +-- Cache MISS:
        |
        v
    findProjectWithAgents(projectId, tenantId)  // tenant-guarded query
        |
        v
    Extract dslContent from agents
        |
        v
    Store in cache
    |
    v
compileToResolvedAgent(dsls, entryAgentName)
    |
    v
executor.createSessionFromResolved(resolved, {
  channelType: 'voice_livekit',
  tenantId, projectId
})
```

**Cache behavior:**

- Key: `${tenantId}:${projectId}`
- TTL: 5 minutes
- Multiple voice rooms for the same project reuse compiled IR

---

## Error Handling

### Token Route Errors

| Error                  | HTTP Status | Cause                                     |
| ---------------------- | ----------- | ----------------------------------------- |
| Invalid input IDs      | 400         | Pattern validation failed                 |
| Room limit reached     | 429         | `activeRoomCount() >= maxConcurrentRooms` |
| Missing credentials    | 422         | Tenant has no STT or TTS credentials      |
| LiveKit not configured | 503         | Missing LIVEKIT_URL/API_KEY/API_SECRET    |
| Auth failure           | 401         | Invalid JWT or API key                    |

### Agent Spawn Errors

All spawn errors are logged but do not affect the HTTP response (fire-and-forget).
The user can join the room but no agent will respond.

| Error                     | Cause                                              | Recovery               |
| ------------------------- | -------------------------------------------------- | ---------------------- |
| Worker not running        | Server startup failed                              | Restart server         |
| Duplicate room            | Agent already in room                              | No action needed       |
| Adapter init failed       | Project not found, DSL invalid, deployment retired | Fix DSL or redeploy    |
| Room connect failed       | LiveKit server unreachable                         | Check LiveKit health   |
| Plugin load failed        | Missing npm dependency                             | Install plugin package |
| Credential decrypt failed | Encryption key mismatch                            | Re-encrypt credentials |

### Runtime Errors (During Conversation)

| Error                  | Handling                    | User Hears                                  |
| ---------------------- | --------------------------- | ------------------------------------------- |
| Chat timeout (30s)     | Log + trace failed turn     | "I encountered an error. Please try again." |
| ExecuteMessage error   | Log + trace failed turn     | "I encountered an error. Please try again." |
| Tool execution failure | Handled by RuntimeExecutor  | Agent's error handling response             |
| LLM API error          | Handled by SessionLLMClient | "I encountered an error. Please try again." |

### Graceful Degradation

| Component    | If Missing   | Behavior                                             |
| ------------ | ------------ | ---------------------------------------------------- |
| Silero VAD   | Optional     | Pipeline proceeds; all audio treated as speech       |
| Data channel | Non-critical | Transcript/timing not sent; audio still works        |
| DB session   | Non-critical | Messages not persisted; voice conversation continues |

---

## Cleanup & Disconnection

### Normal: User Disconnects

1. User navigates away or closes browser
2. LiveKit server detects participant left
3. Agent receives disconnect notification
4. `cleanup()` function executes (see below)

### Graceful Server Shutdown

`stopLiveKitWorker()` in `worker-entry.ts`:

1. Close all AgentSessions (`session.close()`) — stops VAD/STT/TTS pipelines
2. Disconnect all rooms (`room.disconnect()`) — closes WebRTC connections
3. Unregister all adapters — remove from tracking maps
4. Dispose all adapters (`adapter.dispose()`) — routes through shared voice lifecycle cleanup
5. Clear all maps

Uses `Promise.allSettled()` so partial failures don't block shutdown.

### Cleanup Order (Per Room)

```typescript
async cleanup() {
  await session.close();          // 1. Stop audio pipeline
  await room.disconnect();        // 2. Leave LiveKit room
  unregisterAdapter(roomName);    // 3. Remove from tracking
  await adapter.dispose();        // 4. End runtime + DB session state
}
```

Order matters: session must close before room disconnects (prevents audio artifacts),
and adapter disposal is last (runtime session cleanup is independent of LiveKit state).

### Adapter Disposal

```typescript
async dispose() {
  await handleDisconnect({
    channel: 'voice',
    sessionId: this.sessionId,
    dbSessionId: this.dbSessionId,
    tenantId: this.options.tenantId,
  });  // Clean up runtime + DB session state via shared voice lifecycle
  this.sessionId = null;
  this.initialized = false;
}
```

---

## Configuration

### Required Environment Variables

```bash
LIVEKIT_URL=wss://livekit.example.com      # LiveKit server WebSocket URL
LIVEKIT_API_KEY=devkey                      # LiveKit API key
LIVEKIT_API_SECRET=devsecret                # LiveKit API secret
FEATURE_LIVEKIT_ENABLED=true                # Feature flag (default: false)
```

### Optional Configuration

```bash
# Token TTL (seconds, default: 3600)
# voice.livekit.tokenTtlSeconds

# Max concurrent rooms (default: 50)
# voice.livekit.maxConcurrentRooms
```

### Tenant-Scoped Voice Credentials (Database)

Stored in `TenantServiceInstance` with encrypted API keys:

| Service        | Fields                                                               |
| -------------- | -------------------------------------------------------------------- |
| Deepgram STT   | `apiKey`, `model` (default: 'nova-3')                                |
| ElevenLabs TTS | `apiKey`, `voiceId` (optional), `model` (default: 'eleven_turbo_v2') |

---

## File Map

| File                                   | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `routes/livekit.ts`                    | REST API: capabilities, token generation, spawn trigger        |
| `voice/livekit/worker-entry.ts`        | Worker lifecycle: start, spawn, stop, adapter registry         |
| `voice/livekit/agent-worker.ts`        | Room connection, plugin init, RuntimeBridgeAgent, AgentSession |
| `voice/livekit/runtime-llm-adapter.ts` | Bridge to RuntimeExecutor: session init, chat(), dispose()     |
| `voice/livekit/livekit-trace-hooks.ts` | Trace integration: turn start/end, STT/LLM/TTS phases          |
| `voice/livekit/validation.ts`          | Input validation patterns                                      |
| `voice/voice-service-factory.ts`       | Tenant-scoped credential resolution with caching               |
| `voice/voice-mode-resolver.ts`         | Pipeline vs realtime mode selection                            |
