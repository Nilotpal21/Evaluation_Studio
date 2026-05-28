# Test Specification: Grok Realtime S2S Voice Provider

**Feature Spec**: [`docs/features/sub-features/grok-realtime-s2s-voice.md`](../features/sub-features/grok-realtime-s2s-voice.md)
**HLD**: _Not yet created_
**LLD**: _Not yet created_
**Status**: PLANNED
**Last Updated**: 2026-03-31

---

## 1. Coverage Matrix

| FR    | Description                                          | Unit | Integration | E2E | Manual | Status  |
| ----- | ---------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Implement GrokRealtimeSession adapter                | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-2  | Register grok_realtime provider                      | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-3  | Add 's2s:grok' to S2SProviderType                    | ✅   | ✅          | ❌  | ❌     | PLANNED |
| FR-4  | Add 's2s:grok' to service type validation            | ❌   | ✅          | ✅  | ❌     | PLANNED |
| FR-5  | VoiceServiceFactory.resolveS2SCredentials() for Grok | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-6  | Studio Voice Services UI - Grok entry                | ❌   | ❌          | ✅  | ✅     | PLANNED |
| FR-7  | Encrypt Grok API keys at rest                        | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-8  | Validate Grok API key format                         | ✅   | ✅          | ❌  | ❌     | PLANNED |
| FR-9  | Tool calling protocol integration                    | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-10 | Emit trace events for Grok sessions                  | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-11 | Reconnection with exponential backoff                | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-12 | Tenant isolation for credentials                     | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-13 | Audio format support (PCM16, g711)                   | ✅   | ✅          | ✅  | ✅     | PLANNED |
| FR-14 | Dynamic system prompt/tools updates                  | ✅   | ✅          | ✅  | ❌     | PLANNED |
| FR-15 | Provider type dimension in analytics                 | ❌   | ✅          | ✅  | ❌     | PLANNED |

**Legend**: ✅ Required | ❌ Not required

---

## 2. E2E Test Scenarios (MANDATORY)

**CRITICAL**: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Only external third-party services (Grok API) may be mocked via dependency injection.

### E2E-1: Complete Voice Session Lifecycle with Grok

**Objective**: Verify end-to-end voice session using Grok realtime provider from credential configuration through voice conversation to session teardown.

**Preconditions**:

- MongoDB, Redis, ClickHouse running via Docker
- Studio and Runtime services running on test ports
- Test tenant created with tenant ID `test-tenant-grok-e2e-1`
- Mock Grok WebSocket server running on localhost:9999 (implements OpenAI-compatible protocol)

**Steps**:

1. **POST** `/api/tenants/test-tenant-grok-e2e-1/service-instances`
   - Body: `{ "displayName": "Test Grok Credentials", "serviceType": "s2s:grok", "apiKey": "xai-test-key-123", "config": { "model": "grok-realtime-1", "voice": "default" } }`
   - Auth: Tenant admin JWT
   - Assert: 201 Created, response includes `{ success: true, instance: { id: <uuid>, serviceType: "s2s:grok", isActive: true } }`

2. **GET** `/api/tenants/test-tenant-grok-e2e-1/service-instances`
   - Auth: Tenant admin JWT
   - Assert: 200 OK, response includes Grok instance with `displayName`, `serviceType`, API key **NOT** present (encrypted)

3. **POST** `/api/projects/<project-id>/deployments`
   - Body: `{ "agentName": "voice_agent", "environment": "test", "voiceConfig": { "mode": "realtime", "provider": "grok_realtime" } }`
   - Auth: Project developer JWT
   - Assert: 201 Created, deployment ID returned

4. **WebSocket** connect to `wss://runtime/sdk/voice?deploymentId=<deployment-id>&tenantId=test-tenant-grok-e2e-1`
   - Auth: Session token with project scope
   - Send: `{ type: "audio", data: <base64-pcm16-hello> }`
   - Assert: Receive `{ type: "audio", data: <base64-pcm16-response> }` from Grok
   - Assert: Receive `{ type: "transcript", role: "assistant", text: "Hello! How can I help you?" }`

5. **GET** `/api/sessions/<session-id>/traces?tenantId=test-tenant-grok-e2e-1`
   - Auth: Tenant admin JWT
   - Assert: 200 OK, traces include `realtime_session_start`, `realtime_turn_complete` events with `providerType: "grok_realtime"`

6. **POST** `/api/sessions/<session-id>/end?tenantId=test-tenant-grok-e2e-1`
   - Auth: Session token
   - Assert: 200 OK, session disposition is "completed"

7. **GET** `/api/tenants/test-tenant-grok-e2e-1/analytics/voice-sessions?provider=grok_realtime`
   - Auth: Tenant admin JWT
   - Assert: 200 OK, count >= 1, sessions include Grok-specific metrics (input_tokens, output_tokens, audio_duration_ms)

**Expected Results**:

- All HTTP responses return expected status codes
- Grok credentials encrypted at rest (not returned in GET response)
- WebSocket audio streaming works bidirectionally
- Trace events captured with correct providerType dimension
- Session metrics recorded in ClickHouse

**Tenant Isolation Check**:

- GET `/api/tenants/other-tenant-id/service-instances/<grok-instance-id>` returns **404** (not 403)
- GET `/api/sessions/<session-id>/traces?tenantId=other-tenant-id` returns **404**

**Auth Context**: Tenant admin JWT (tenant scope), project developer JWT (project scope), session token (session scope)

---

### E2E-2: KoreVG Telephony Voice Session with Grok S2S

**Objective**: Verify KoreVG telephony integration using Grok S2S provider via llm verb.

**Preconditions**:

- KoreVG infrastructure running (FreeSWITCH, Drachtio, feature-server) or mocked
- ChannelConnection configured with `s2sProvider: "s2s:grok"`
- Test tenant has Grok credentials configured
- Agent with `voice_optimized: true` IR hint

**Steps**:

1. **POST** `/api/tenants/test-tenant-grok-e2e-2/service-instances`
   - Body: `{ "serviceType": "s2s:grok", "apiKey": "xai-korevg-key", "config": { "model": "grok-realtime-1" } }`
   - Assert: 201 Created

2. **POST** `/api/projects/<project-id>/channels`
   - Body: `{ "type": "korevg", "config": { "s2sProvider": "s2s:grok", "s2sModel": "grok-realtime-1", "s2sVoice": "default" } }`
   - Auth: Project developer JWT
   - Assert: 201 Created, channel ID returned

3. **WebSocket Upgrade** to `/korevg?channelId=<channel-id>&token=<ingress-token>&caller=+15551234567`
   - KoreVG sends `session.new` message with call_sid, from, to
   - Runtime responds with `session.created` and llm verb payload
   - Assert: llm verb includes `{ vendor: "grok", model: "grok-realtime-1", auth: { apiKey: <encrypted-key> } }`

4. Mock KoreVG sends audio frames via WebSocket
   - Runtime forwards to Grok S2S session
   - Grok S2S returns audio frames
   - Runtime forwards to KoreVG

5. Mock KoreVG sends `tool_call` event
   - Body: `{ type: "function_call", name: "get_weather", arguments: "{\"location\":\"San Francisco\"}" }`
   - Runtime invokes ABL ToolExecutor
   - Assert: Tool result returned to KoreVG as `tool_result` event

6. **GET** `/api/sessions/<session-id>/traces?tenantId=test-tenant-grok-e2e-2`
   - Assert: Traces include `voice_session_start`, `voice_turn`, `voice_session_end` with `provider: "grok_realtime"`

7. Check Homer/HEP quality metrics (if Homer integration enabled)
   - Query: `SELECT MOS, jitter, packet_loss FROM hep_proto_5_default WHERE call_id = '<call-sid>'`
   - Assert: Metrics captured for KoreVG call

**Expected Results**:

- KoreVG llm verb payload correctly formatted for Grok
- Grok credentials resolved via VoiceServiceFactory.resolveS2SCredentials()
- Audio streaming bidirectional between KoreVG and Grok
- Tool calls routed through ABL ToolExecutor
- Voice quality metrics captured via Homer/HEP

**Tenant Isolation Check**:

- Credential resolution with wrong tenantId returns null
- Session traces scoped to correct tenantId

**Auth Context**: Ingress token (KoreVG → Runtime), tenant-scoped JWT for trace queries

---

### E2E-3: Studio UI Credential Management for Grok

**Objective**: Verify tenant admins can configure, edit, and delete Grok credentials via Studio UI.

**Preconditions**:

- Studio running on test port
- Test tenant with admin user authenticated
- No existing Grok credentials

**Steps**:

1. **UI**: Navigate to Admin → Voice Services
   - Assert: "Grok (xAI) - Realtime Voice" card shows "Not Configured" badge

2. **UI**: Click "Configure" button on Grok card
   - Assert: Dialog opens with fields: Display Name, API Key, Model, Voice
   - Assert: API Key field is `type="password"` (masked)

3. **UI**: Fill form
   - Display Name: "Production Grok Credentials"
   - API Key: "xai-prod-key-abc123"
   - Model: "grok-realtime-1"
   - Voice: "default"
   - Click "Save"

4. **HTTP**: Verify POST `/api/service-instances?tenantId=<tenant-id>` was called
   - Assert: Request body includes `{ displayName: "Production Grok Credentials", serviceType: "s2s:grok", apiKey: "xai-prod-key-abc123", config: { model: "grok-realtime-1", voice: "default" } }`
   - Assert: Response 201 Created

5. **UI**: Verify success toast: "Grok (xAI) - Realtime Voice credentials saved"
   - Assert: Grok card now shows "Configured" badge (green)
   - Assert: Displays "Name: Production Grok Credentials"

6. **UI**: Click "Edit" button
   - Assert: Dialog opens with existing values pre-filled (API key masked as `********`)
   - Change Display Name to "Updated Grok Credentials"
   - Click "Update"

7. **HTTP**: Verify PATCH `/api/service-instances/<instance-id>?tenantId=<tenant-id>` was called
   - Assert: Request body includes `{ displayName: "Updated Grok Credentials" }`
   - Assert: Response 200 OK

8. **UI**: Click "Remove Credentials" button, confirm deletion
   - Assert: DELETE request sent, response 200 OK
   - Assert: Grok card returns to "Not Configured" state

**Expected Results**:

- UI renders Grok provider card in Voice Services page
- Credential CRUD operations work correctly
- API keys encrypted at rest (not returned in GET responses)
- Success/error toasts displayed appropriately
- Credential changes reflected immediately in UI

**Tenant Isolation Check**:

- User from Tenant A cannot see/edit Tenant B's Grok credentials
- API returns 404 for cross-tenant access attempts

**Auth Context**: Tenant admin JWT with `tenant:admin` role

---

### E2E-4: Grok Session Reconnection and Error Handling

**Objective**: Verify Grok WebSocket session survives transient network failures and handles API errors gracefully.

**Preconditions**:

- Mock Grok WebSocket server with controllable disconnect/error simulation
- Active Grok voice session (user speaking with agent)

**Steps**:

1. Start Grok voice session via WebSocket (steps from E2E-1)
   - Establish connection, send/receive initial audio

2. **Simulate network disconnect**: Mock Grok server closes WebSocket with code 1006 (abnormal closure)
   - Assert: Runtime logs `[CONNECTION] Grok WebSocket closed, attempting reconnection...`
   - Assert: Reconnection attempt 1 after 1000ms (exponential backoff base delay)

3. **Reconnection attempt 1 fails**: Mock server rejects connection
   - Assert: Reconnection attempt 2 after 2000ms (backoff: 1000 \* 2^1)

4. **Reconnection attempt 2 succeeds**: Mock server accepts connection
   - Assert: Session resumes, audio streaming continues
   - Assert: Session state NOT lost (conversation context preserved)

5. **Simulate Grok API 429 rate limit error**: Mock server sends error event
   - Body: `{ type: "error", error: { type: "rate_limit_exceeded", message: "Too many requests" } }`
   - Assert: Runtime emits trace event with `error_type: "rate_limit_exceeded"`
   - Assert: Session enters error state, user receives error message

6. **Simulate Grok API 401 auth error**: Mock server sends auth error
   - Body: `{ type: "error", error: { type: "invalid_api_key", message: "Invalid API key" } }`
   - Assert: Runtime does NOT retry (auth errors are not transient)
   - Assert: Session terminates, trace event emitted with `error_type: "invalid_api_key"`

7. **Query trace events**:
   - GET `/api/sessions/<session-id>/traces?tenantId=<tenant-id>`
   - Assert: Traces include `realtime_connection_error` events with error details
   - Assert: Reconnection attempts logged with attempt count

**Expected Results**:

- Transient network failures trigger exponential backoff reconnection (max 3 attempts)
- Reconnection succeeds and session resumes without data loss
- Rate limit errors emitted as trace events
- Auth errors terminate session immediately (no retry)
- All errors logged with structured context (sessionId, tenantId, errorType, message)

**Tenant Isolation Check**: N/A (single tenant scenario)

**Auth Context**: Session token (session scope)

---

### E2E-5: Multi-Tenant Concurrent Grok Sessions

**Objective**: Verify multiple tenants can use Grok concurrently without credential leakage or session cross-contamination.

**Preconditions**:

- 3 test tenants: `tenant-a-grok`, `tenant-b-grok`, `tenant-c-grok`
- Each tenant has different Grok API key configured
- Load testing harness ready

**Steps**:

1. **Setup Phase**: Configure credentials for 3 tenants
   - POST `/api/tenants/tenant-a-grok/service-instances` with `apiKey: "xai-tenant-a-key"`
   - POST `/api/tenants/tenant-b-grok/service-instances` with `apiKey: "xai-tenant-b-key"`
   - POST `/api/tenants/tenant-c-grok/service-instances` with `apiKey: "xai-tenant-c-key"`
   - Assert: All 201 Created

2. **Load Phase**: Start 10 concurrent voice sessions per tenant (30 total)
   - Use load testing tool (k6, Artillery, or custom script)
   - Each session: WebSocket connect → send audio → receive response → disconnect
   - Sessions run in parallel across all 3 tenants

3. **Credential Verification**: Capture WebSocket connection headers
   - Assert: Tenant A sessions use `Authorization: Bearer xai-tenant-a-key`
   - Assert: Tenant B sessions use `Authorization: Bearer xai-tenant-b-key`
   - Assert: Tenant C sessions use `Authorization: Bearer xai-tenant-c-key`
   - Assert: No cross-tenant credential leakage

4. **Session Isolation Verification**: Check trace events
   - GET `/api/tenants/tenant-a-grok/analytics/voice-sessions?provider=grok_realtime`
   - Assert: Only Tenant A sessions returned (count = 10)
   - GET `/api/tenants/tenant-b-grok/analytics/voice-sessions?provider=grok_realtime`
   - Assert: Only Tenant B sessions returned (count = 10)
   - GET `/api/tenants/tenant-c-grok/analytics/voice-sessions?provider=grok_realtime`
   - Assert: Only Tenant C sessions returned (count = 10)

5. **Credential Cache Verification**: Check VoiceServiceFactory cache behavior
   - Assert: Cache segregated by tenantId (cache key format: `<tenantId>:s2s:grok`)
   - Assert: No cache hits for wrong tenantId

6. **Cleanup Phase**: End all sessions
   - POST `/api/sessions/<session-id>/end` for all 30 sessions
   - Assert: All sessions end cleanly, no memory leaks

7. **Resource Usage Verification**: Check Docker container metrics
   - Assert: Memory usage returns to baseline after sessions end
   - Assert: No leaked WebSocket connections (`netstat` shows 0 CLOSE_WAIT)

**Expected Results**:

- 30 concurrent sessions succeed without errors
- Credentials correctly resolved per tenant (no leakage)
- VoiceServiceFactory cache segregated by tenantId
- Trace events isolated by tenant (no cross-contamination)
- No resource leaks after session cleanup

**Tenant Isolation Check**:

- Tenant A cannot query Tenant B's session traces (404)
- Tenant B cannot access Tenant C's credentials (404)
- ClickHouse queries filtered by tenantId return correct data

**Auth Context**: 30 different session tokens, each scoped to tenant + project

---

### E2E-6: Grok Tool Calling Integration

**Objective**: Verify Grok realtime sessions correctly handle tool calls and route them through ABL ToolExecutor.

**Preconditions**:

- Agent with tools defined: `get_weather(location: string) -> WeatherInfo`
- Grok session active with tool definitions sent

**Steps**:

1. Start Grok voice session with tool-enabled agent (steps from E2E-1)
   - Send system prompt including tool definitions via `updateTools()`

2. **User utterance triggers tool call**: Send audio "What's the weather in San Francisco?"
   - Mock Grok server returns `function_call` event:

   ```json
   {
     "type": "response.function_call_arguments.done",
     "call_id": "call_abc123",
     "name": "get_weather",
     "arguments": "{\"location\":\"San Francisco\"}"
   }
   ```

3. **Runtime invokes ToolExecutor**:
   - Assert: ToolExecutor.execute() called with tool name `get_weather` and arguments `{ location: "San Francisco" }`
   - Mock tool returns: `{ temperature: 68, condition: "Sunny" }`

4. **Runtime submits tool result to Grok**:
   - Assert: GrokRealtimeSession.submitToolResult() called with:

   ```json
   {
     "type": "conversation.item.create",
     "item": {
       "type": "function_call_output",
       "call_id": "call_abc123",
       "output": "{\"temperature\":68,\"condition\":\"Sunny\"}"
     }
   }
   ```

5. **Grok incorporates tool result**: Mock Grok returns audio response
   - "The weather in San Francisco is 68 degrees and sunny."
   - Assert: Audio received via WebSocket, transcript includes tool result

6. **Verify trace events**:
   - GET `/api/sessions/<session-id>/traces?tenantId=<tenant-id>`
   - Assert: Trace includes `realtime_tool_call` event with:
     - `tool_name: "get_weather"`
     - `tool_arguments: "{\"location\":\"San Francisco\"}"`
     - `tool_result: "{\"temperature\":68,\"condition\":\"Sunny\"}"`
     - `tool_execution_ms: <latency>`

**Expected Results**:

- Grok function_call events correctly parsed
- Tool execution routed through ABL ToolExecutor
- Tool results submitted back to Grok in correct format
- Grok continues conversation with tool context
- Trace events capture tool call lifecycle

**Tenant Isolation Check**: Tool execution uses tenant-scoped context (tools may access tenant data)

**Auth Context**: Session token (session scope)

---

### E2E-7: Grok Provider Selection in Voice Mode Resolver

**Objective**: Verify voice mode resolver correctly selects Grok when tenant has Grok configured and agent IR indicates realtime mode.

**Preconditions**:

- Tenant has Grok credentials configured
- Agent IR includes `voice_optimized: true` hint
- Deployment config specifies `voiceConfig: { mode: "realtime" }`

**Steps**:

1. **Setup**: Configure Grok credentials
   - POST `/api/tenants/test-tenant-resolver/service-instances` with Grok credentials

2. **Create Agent**: POST `/api/projects/<project-id>/agents`
   - Body includes DSL with `AGENT voice_agent WITH voice_optimized = true`
   - Assert: Agent compiled, IR includes `voice_optimized: true`

3. **Deploy Agent**: POST `/api/projects/<project-id>/deployments`
   - Body: `{ agentName: "voice_agent", voiceConfig: { mode: "realtime" } }`
   - Assert: Deployment created

4. **Resolve Voice Mode**: Internal call to `VoiceServiceFactory.resolveVoiceMode()`
   - Context: `{ tenantId, projectId, agentIR, deploymentConfig }`
   - Assert: Returns `{ mode: "realtime", providerType: "grok_realtime" }`

5. **Start Voice Session**: WebSocket connect with deployment ID
   - Assert: Runtime creates `RealtimeVoiceExecutor` with `GrokRealtimeSession`
   - Assert: Session state shows `connectionState: "connected"`, `providerType: "grok_realtime"`

6. **Verify fallback behavior**: Delete Grok credentials
   - DELETE `/api/tenants/test-tenant-resolver/service-instances/<grok-instance-id>`
   - Start new voice session
   - Assert: Voice mode resolver falls back to pipeline mode (STT + LLM + TTS)

**Expected Results**:

- Voice mode resolver detects Grok credentials and realtime mode
- Correct provider selected (grok_realtime)
- RealtimeVoiceExecutor instantiated with GrokRealtimeSession
- Graceful fallback to pipeline mode if Grok not configured

**Tenant Isolation Check**: Voice mode resolution scoped to tenantId

**Auth Context**: Deployment token (project scope)

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: GrokRealtimeSession Contract Compliance

**Objective**: Verify `GrokRealtimeSession` fully implements `RealtimeVoiceSession` interface.

**Boundary**: GrokRealtimeSession adapter ↔ RealtimeVoiceSession interface

**Setup**:

- Instantiate `GrokRealtimeSession` with test config
- Mock WebSocket connection to localhost mock server

**Steps**:

1. **Connection Lifecycle**:
   - Call `session.connect({ apiKey, model, systemPrompt, tools })`
   - Assert: WebSocket connection established to Grok endpoint
   - Assert: Session sends `session.update` event with config
   - Assert: `connectionState` transitions: `disconnected` → `connecting` → `connected`

2. **Audio Streaming**:
   - Call `session.sendAudio(pcm16Buffer)`
   - Assert: WebSocket sends `input_audio_buffer.append` event with base64 audio
   - Mock server responds with `response.audio.delta` event
   - Assert: `onAudio` event handler called with decoded audio buffer

3. **Transcript Handling**:
   - Mock server sends `response.audio_transcript.delta` event
   - Assert: `onTranscript` handler called with `{ text, role: "assistant", isFinal: false }`
   - Mock server sends `response.audio_transcript.done` event
   - Assert: `onTranscript` handler called with `{ text, role: "assistant", isFinal: true }`

4. **Tool Result Submission**:
   - Call `session.submitToolResult("call_123", "{\"result\":\"success\"}")`
   - Assert: WebSocket sends `conversation.item.create` with `function_call_output`
   - Assert: WebSocket sends `response.create` to trigger new response

5. **Session Updates**:
   - Call `session.updateSystemPrompt("New instructions")`
   - Assert: WebSocket sends `session.update` with `{ instructions: "New instructions" }`
   - Call `session.updateTools([newTool])`
   - Assert: WebSocket sends `session.update` with `{ tools: [...] }`

6. **Disconnection**:
   - Call `session.disconnect()`
   - Assert: WebSocket closed with code 1000
   - Assert: `connectionState` transitions to `disconnected`

**Expected Result**:

- All `RealtimeVoiceSession` interface methods implemented
- State transitions follow spec (disconnected → connecting → connected → disconnected)
- Event handlers called correctly
- No unhandled promise rejections

**Failure Mode**: If GrokRealtimeSession does not implement interface correctly, TypeScript compilation fails

---

### INT-2: VoiceServiceFactory Grok Credential Resolution

**Objective**: Verify `VoiceServiceFactory.resolveS2SCredentials()` correctly resolves and decrypts Grok credentials.

**Boundary**: VoiceServiceFactory ↔ TenantServiceInstance (MongoDB)

**Setup**:

- MongoDB test database with TenantServiceInstance collection
- Encryption service configured with test KMS key
- Insert test record:
  ```json
  {
    "_id": ObjectId("..."),
    "tenantId": "test-tenant-factory",
    "serviceType": "s2s:grok",
    "encryptedCredentials": "<encrypted-blob>",
    "status": "active"
  }
  ```

**Steps**:

1. **Successful Resolution**:
   - Call `factory.resolveS2SCredentials("test-tenant-factory", "s2s:grok")`
   - Assert: Returns `{ credentials: { apiKey: "xai-test-key", config: { model: "grok-realtime-1" } } }`
   - Assert: Credentials decrypted correctly (plaintext API key returned)

2. **Credential Caching**:
   - Call `resolveS2SCredentials()` twice for same tenant
   - Assert: MongoDB query executed only once (cache hit on second call)
   - Assert: Cache key is `test-tenant-factory:s2s:grok`

3. **Cache Invalidation**:
   - Call `factory.invalidate("test-tenant-factory", "s2s:grok")`
   - Call `resolveS2SCredentials()` again
   - Assert: MongoDB query executed (cache miss)

4. **Missing Credentials**:
   - Call `factory.resolveS2SCredentials("nonexistent-tenant", "s2s:grok")`
   - Assert: Returns `null` (no credentials found)
   - Assert: Warning logged: "Failed to resolve S2S credentials"

5. **Decryption Failure**:
   - Insert record with corrupted encrypted blob
   - Call `resolveS2SCredentials()`
   - Assert: Returns `null`
   - Assert: Error logged with decryption failure details

**Expected Result**:

- Credentials resolved and decrypted correctly
- Caching reduces DB queries
- Cache segregated by tenantId (no cross-tenant cache hits)
- Graceful handling of missing/corrupted credentials

**Failure Mode**: If decryption fails, returns null (does not throw exception)

---

### INT-3: KoreVG LLM Verb Payload for Grok

**Objective**: Verify KoreVG llm verb payload correctly formatted for Grok S2S provider.

**Boundary**: KorevgRouter ↔ VoiceServiceFactory ↔ Grok llm verb builder

**Setup**:

- Mock VoiceServiceFactory returning Grok credentials
- Agent IR with system prompt and tools
- KoreVG session config with `s2sProvider: "s2s:grok"`

**Steps**:

1. **Build LLM Verb Payload**:
   - Call `buildRealtimeLlmVerbPayload({ apiKey, instructions, s2sConfig, tools })`
   - Assert: Returns payload structure:

   ```json
   {
     "verb": "llm",
     "vendor": "openai",  // or "grok" if KoreVG supports natively
     "model": "grok-realtime-1",
     "auth": { "apiKey": "xai-..." },
     "eventHook": "/llm-event",
     "toolHook": "/llm-tool",
     "events": ["conversation.item.*", "response.audio_transcript.delta", ...],
     "llmOptions": {
       "session_update": {
         "modalities": ["text", "audio"],
         "instructions": "...",
         "voice": "default",
         "output_audio_format": "pcm16",
         "tools": [...],
         "turn_detection": { "type": "server_vad", "threshold": 0.5, ... }
       }
     }
   }
   ```

2. **Tool Definitions Format**:
   - Assert: Tools array formatted as OpenAI function definitions:

   ```json
   {
     "type": "function",
     "name": "get_weather",
     "description": "Get weather for a location",
     "parameters": {
       "type": "object",
       "properties": { "location": { "type": "string" } },
       "required": ["location"]
     }
   }
   ```

3. **Voice Config Overrides**:
   - Call with custom config: `{ s2sModel: "grok-custom", s2sVoice: "voice-2", s2sTemperature: 0.9 }`
   - Assert: Payload includes overrides in `llmOptions.session_update`

4. **Empty Tools Handling**:
   - Call with no tools
   - Assert: `toolHook` field is `undefined` (not included)
   - Assert: `tools` and `tool_choice` fields excluded from `session_update`

**Expected Result**:

- LLM verb payload correctly formatted for Grok
- Tools serialized in OpenAI-compatible format
- Config overrides applied correctly
- Payload matches KoreVG llm verb specification

**Failure Mode**: If payload malformed, KoreVG rejects with error

---

### INT-4: Grok Trace Event Emission

**Objective**: Verify Grok sessions emit comprehensive trace events to TraceStore and ClickHouse.

**Boundary**: GrokRealtimeSession ↔ TraceStore ↔ ClickHouse

**Setup**:

- Real ClickHouse instance (Docker)
- Real TraceStore configured
- GrokRealtimeSession with mock WebSocket

**Steps**:

1. **Session Start Event**:
   - Call `session.connect()`
   - Assert: Trace event emitted: `realtime_session_start`
     - Fields: `sessionId`, `tenantId`, `projectId`, `providerType: "grok_realtime"`, `model`, `voice`
   - Query ClickHouse: `SELECT * FROM voice_trace_events WHERE event_type = 'realtime_session_start' AND provider_type = 'grok_realtime'`
   - Assert: Row exists with correct fields

2. **Turn Complete Event**:
   - Simulate Grok turn: audio in → audio out → transcript
   - Assert: Trace event emitted: `realtime_turn_complete`
     - Fields: `turnLatency`, `inputTokens`, `outputTokens`, `totalTokens`, `audioDurationInMs`, `audioDurationOutMs`
   - Query ClickHouse: `SELECT * FROM voice_trace_events WHERE event_type = 'realtime_turn_complete'`
   - Assert: Usage metrics recorded

3. **Tool Call Event**:
   - Mock Grok sends `function_call` event
   - Assert: Trace event emitted: `realtime_tool_call`
     - Fields: `toolName`, `toolArguments`, `toolCallId`, `executionTimeMs`
   - Query ClickHouse
   - Assert: Tool call details captured

4. **Session End Event**:
   - Call `session.disconnect()`
   - Assert: Trace event emitted: `realtime_session_end`
     - Fields: `totalTurnCount`, `totalInputTokens`, `totalOutputTokens`, `connectionDurationMs`
   - Query ClickHouse
   - Assert: Session summary recorded

5. **Error Event**:
   - Mock Grok sends error event (429 rate limit)
   - Assert: Trace event emitted: `realtime_connection_error`
     - Fields: `errorType`, `errorMessage`, `errorCode`, `providerType: "grok_realtime"`
   - Query ClickHouse
   - Assert: Error details captured

**Expected Result**:

- All Grok session lifecycle events emitted
- Trace events include `providerType: "grok_realtime"` dimension
- ClickHouse queries can filter by provider
- Usage metrics (tokens, audio duration) recorded accurately

**Failure Mode**: If TraceStore fails, events lost (no crash)

---

### INT-5: Grok Credential Encryption at Rest

**Objective**: Verify Grok API keys encrypted at rest in MongoDB using tenant-scoped encryption.

**Boundary**: TenantServiceInstance model ↔ EncryptionService ↔ MongoDB

**Setup**:

- Real MongoDB instance (Docker)
- Real EncryptionService with test KMS key
- Tenant ID: `test-tenant-encryption`

**Steps**:

1. **Encrypt and Store**:
   - Call TenantServiceInstance.create():

   ```typescript
   await TenantServiceInstance.create({
     tenantId: 'test-tenant-encryption',
     serviceType: 's2s:grok',
     encryptedCredentials: {
       apiKey: 'xai-plaintext-key-123',
       config: { model: 'grok-realtime-1' },
     },
   });
   ```

   - Assert: Document inserted successfully

2. **Verify Encrypted in DB**:
   - Direct MongoDB query: `db.tenant_service_instances.findOne({ tenantId: "test-tenant-encryption", serviceType: "s2s:grok" })`
   - Assert: `encryptedCredentials` field is binary blob (not plaintext)
   - Assert: Plaintext API key NOT present in raw document

3. **Decrypt via Mongoose**:
   - Query via Mongoose (auto-decryption): `TenantServiceInstance.findOne({ tenantId: "test-tenant-encryption", serviceType: "s2s:grok" })`
   - Assert: Returns decrypted credentials: `{ apiKey: "xai-plaintext-key-123", config: { model: "grok-realtime-1" } }`

4. **Cross-Tenant Decryption Failure**:
   - Attempt to decrypt with wrong tenantId context
   - Assert: Decryption fails (returns null or throws error)

5. **Encryption Key Rotation**:
   - Rotate encryption key in KMS
   - Re-encrypt credentials via `TenantServiceInstance.reEncrypt()`
   - Assert: Credentials still readable after rotation

**Expected Result**:

- API keys encrypted at rest in MongoDB
- Plaintext never stored in database
- Mongoose auto-decryption works correctly
- Tenant-scoped encryption prevents cross-tenant decryption
- Key rotation supported

**Failure Mode**: If encryption service unavailable, create() throws exception

---

### INT-6: Grok Reconnection Logic with Exponential Backoff

**Objective**: Verify GrokRealtimeSession reconnection logic correctly implements exponential backoff.

**Boundary**: GrokRealtimeSession ↔ WebSocket ↔ Mock Grok Server

**Setup**:

- Mock Grok WebSocket server that can simulate disconnects
- GrokRealtimeSession configured with reconnection enabled

**Steps**:

1. **Initial Connection**:
   - Call `session.connect()`
   - Assert: WebSocket connection established

2. **Disconnect Simulation**:
   - Mock server closes connection with code 1006 (abnormal)
   - Assert: `connectionState` transitions to `reconnecting`
   - Assert: Reconnection attempt 1 scheduled after 1000ms (base delay)

3. **First Retry Fails**:
   - Mock server rejects connection
   - Assert: Reconnection attempt 2 scheduled after 2000ms (1000 \* 2^1)

4. **Second Retry Fails**:
   - Mock server rejects connection
   - Assert: Reconnection attempt 3 scheduled after 4000ms (1000 \* 2^2)

5. **Third Retry Succeeds**:
   - Mock server accepts connection
   - Assert: `connectionState` transitions to `connected`
   - Assert: Reconnection counter reset to 0

6. **Max Retries Exhausted**:
   - Disconnect again
   - Mock server rejects all 3 attempts
   - Assert: `connectionState` transitions to `error`
   - Assert: `onError` event emitted with "Max reconnection attempts reached"

7. **Intentional Disconnect No Retry**:
   - Call `session.disconnect()`
   - Mock server closes connection
   - Assert: No reconnection attempts (intentional disconnect flag set)

**Expected Result**:

- Reconnection attempts follow exponential backoff (1s, 2s, 4s)
- Max 3 retries enforced
- Successful reconnection resets counter
- Intentional disconnects do not trigger retry
- State transitions logged correctly

**Failure Mode**: If max retries exhausted, session enters error state (does not crash)

---

### INT-7: Studio Voice Services UI - Grok Card Rendering

**Objective**: Verify Studio Voice Services page correctly renders Grok provider card and handles CRUD operations.

**Boundary**: VoiceServicesPage (React) ↔ Studio API ↔ Runtime API

**Studio Components to Modify** (from codebase analysis):

- `apps/studio/src/components/admin/VoiceServicesPage.tsx` - Add Grok to SERVICE_CARDS array (lines 76-323)
- `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` - Add 's2s:grok' to PROVIDER_LABELS (line 21)
- `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx` - Add case 's2s:grok' (line 22)
- `apps/studio/src/components/deployments/channels/GrokS2SFields.tsx` - **NEW FILE**: Provider-specific config component (mirror OpenAIS2SFields.tsx structure)
- `apps/studio/src/api/voice-services.ts` - Add 's2s:grok' to S2SProvider type union (line 14)

**Setup**:

- React Testing Library with mocked fetch
- TanStack Query hooks mocked
- Tenant: `test-tenant-studio-ui`

**Steps**:

1. **Initial Render - No Grok Configured**:
   - Mock API response: `GET /api/service-instances?tenantId=test-tenant-studio-ui` returns `{ instances: [] }`
   - Render `<VoiceServicesPage />`
   - Assert: Grok card visible with label "xAI Grok Realtime (S2S)"
   - Assert: Badge shows "Not Configured" (warning variant)
   - Assert: Button text is "Configure"

2. **Open Configuration Dialog**:
   - Click "Configure" button
   - Assert: Dialog opens with title "Configure xAI Grok Realtime (S2S)"
   - Assert: Form fields rendered:
     - Display Name (text input)
     - API Key (password input, masked)
     - Model (text input with hint)
     - Voice (text input with hint)
   - Assert: Eye icon button present to toggle API key visibility

3. **Submit Valid Credentials**:
   - Fill form: `displayName: "Test Grok", apiKey: "xai-test-key", model: "grok-realtime-1", voice: "default"`
   - Click "Save"
   - Mock API: `POST /api/service-instances` returns `{ success: true, instance: { id: "inst-123", serviceType: "s2s:grok" } }`
   - Assert: Success toast displayed: "xAI Grok Realtime (S2S) credentials saved"
   - Assert: Dialog closes
   - Assert: Grok card updates to "Configured" badge (success variant)

4. **Edit Existing Credentials**:
   - Mock API: `GET /api/service-instances` returns `{ instances: [{ id: "inst-123", serviceType: "s2s:grok", displayName: "Test Grok", config: { model: "grok-realtime-1" } }] }`
   - Re-render component
   - Click "Edit" button
   - Assert: Dialog opens with pre-filled values (API key shows `********`)
   - Change display name to "Updated Grok"
   - Click "Update"
   - Mock API: `PATCH /api/service-instances/inst-123` returns `{ success: true }`
   - Assert: Success toast displayed: "xAI Grok Realtime (S2S) credentials updated"

5. **Delete Credentials**:
   - Click "Remove Credentials" button
   - Assert: Confirmation prompt appears
   - Confirm deletion
   - Mock API: `DELETE /api/service-instances/inst-123` returns `{ success: true }`
   - Assert: Success toast displayed: "xAI Grok Realtime (S2S) credentials removed"
   - Assert: Grok card returns to "Not Configured" state

6. **Error Handling**:
   - Attempt to save with empty API key
   - Assert: Client-side validation error: "API key required"
   - Submit form with API key
   - Mock API returns 400: `{ error: "Invalid API key format" }`
   - Assert: Error toast displayed with API error message

**Expected Result**:

- Grok card renders in Voice Services page
- CRUD operations trigger correct API calls
- Form validation works correctly
- Success/error toasts displayed
- API key masked by default (password input)

**Failure Mode**: If API calls fail, error toast displayed (UI does not crash)

---

## 4. Unit Test Scenarios

### UT-1: GrokRealtimeSession Constructor and Initialization

**Module**: `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`

**Input**: `new GrokRealtimeSession()`

**Expected Output**:

- Instance created with default state
- `providerType === 'grok_realtime'`
- `connectionState === 'disconnected'`
- `reconnectAttempts === 0`
- Event handler sets initialized (empty)

---

### UT-2: GrokRealtimeSession WebSocket Message Routing

**Module**: `GrokRealtimeSession.routeServerEvent()`

**Input**: Various Grok server events (session.created, audio.delta, transcript.done, function_call, error)

**Expected Output**:

- Events routed to correct handlers
- `onAudio` handler called for audio events
- `onTranscript` handler called for transcript events
- `onToolCall` handler called for function_call events
- `onError` handler called for error events

---

### UT-3: VoiceServiceFactory Cache Key Generation

**Module**: `VoiceServiceFactory.resolveS2SCredentials()`

**Input**: `tenantId: "tenant-123", provider: "s2s:grok"`

**Expected Output**:

- Cache key: `"tenant-123:s2s:grok"`
- Cache lookup before DB query
- Cache set after successful resolution

---

### UT-4: Grok API Key Validation

**Module**: `tenant-service-instances.ts` route handler

**Input**: `POST /api/service-instances` with various API key formats

**Expected Output**:

- Valid key: `"xai-abc123..."` → 201 Created
- Empty key: `""` → 400 Bad Request ("API key required")
- Invalid format: `"invalid"` → 400 Bad Request ("Invalid API key format")

---

### UT-5: Exponential Backoff Delay Calculation

**Module**: `GrokRealtimeSession.attemptReconnect()`

**Input**: Reconnection attempt counts: 1, 2, 3

**Expected Output**:

- Attempt 1: delay = 1000ms (1000 \* 2^0)
- Attempt 2: delay = 2000ms (1000 \* 2^1)
- Attempt 3: delay = 4000ms (1000 \* 2^2)
- Attempt 4: No retry (max 3 attempts exceeded)

---

### UT-6: Tool Call Event Parsing

**Module**: `GrokRealtimeSession.handleFunctionCall()`

**Input**: Grok function_call event:

```json
{
  "type": "response.function_call_arguments.done",
  "call_id": "call_abc123",
  "name": "get_weather",
  "arguments": "{\"location\":\"San Francisco\"}"
}
```

**Expected Output**:

- `onToolCall` handler called with `{ callId: "call_abc123", name: "get_weather", arguments: "{\"location\":\"San Francisco\"}" }`

---

### UT-7: System Prompt Update WebSocket Message

**Module**: `GrokRealtimeSession.updateSystemPrompt()`

**Input**: `updateSystemPrompt("New system prompt")`

**Expected Output**:

- WebSocket sends message:

```json
{
  "type": "session.update",
  "session": {
    "instructions": "New system prompt"
  }
}
```

---

### UT-8: Audio Buffer Base64 Encoding

**Module**: `GrokRealtimeSession.sendAudio()`

**Input**: `Buffer.from([0x00, 0x01, 0x02, 0x03])`

**Expected Output**:

- WebSocket sends message:

```json
{
  "type": "input_audio_buffer.append",
  "audio": "AAECAw=="
}
```

---

## 5. Security & Isolation Tests

### SEC-1: Cross-Tenant Credential Access

**Test**: Tenant A attempts to access Tenant B's Grok credentials

**Steps**:

1. Tenant A creates Grok credentials
2. Tenant B attempts: `GET /api/tenants/tenant-a-id/service-instances/<grok-instance-id>`
3. Auth: Tenant B admin JWT

**Expected**: 404 Not Found (not 403 Forbidden)

---

### SEC-2: Cross-Project Voice Session Access

**Test**: Project A user attempts to access Project B's voice session traces

**Steps**:

1. Project B starts Grok voice session
2. Project A user attempts: `GET /api/sessions/<project-b-session-id>/traces?tenantId=shared-tenant-id&projectId=project-a-id`
3. Auth: Project A user JWT

**Expected**: 404 Not Found

---

### SEC-3: Missing Auth Token

**Test**: Unauthenticated request to create Grok credentials

**Steps**:

1. `POST /api/tenants/tenant-123/service-instances`
2. No `Authorization` header

**Expected**: 401 Unauthorized

---

### SEC-4: Insufficient Permissions

**Test**: Non-admin user attempts to configure Grok credentials

**Steps**:

1. `POST /api/tenants/tenant-123/service-instances`
2. Auth: User JWT with `tenant:user` role (not `tenant:admin`)

**Expected**: 403 Forbidden

---

### SEC-5: API Key Stored in Plaintext Check

**Test**: Verify API key never stored as plaintext in MongoDB

**Steps**:

1. Create Grok credentials via API
2. Direct MongoDB query: `db.tenant_service_instances.findOne({ serviceType: "s2s:grok" })`
3. Inspect raw document

**Expected**: `encryptedCredentials` field is binary blob, plaintext API key NOT present

---

### SEC-6: Credential Cache Isolation

**Test**: Tenant A's credential cache hit cannot serve Tenant B's request

**Steps**:

1. Tenant A calls `resolveS2SCredentials("tenant-a-id", "s2s:grok")` (cache miss, DB query)
2. Tenant B calls `resolveS2SCredentials("tenant-b-id", "s2s:grok")` (should be cache miss, not hit Tenant A's cache)

**Expected**: Tenant B's request queries DB (no cross-tenant cache hit)

---

### SEC-7: Session Token Scope Enforcement

**Test**: Session token cannot access other tenant's data

**Steps**:

1. Session token issued for Tenant A, Session 123
2. Attempt: `GET /api/sessions/session-456/traces?tenantId=tenant-b-id`
3. Auth: Tenant A session token

**Expected**: 404 Not Found (session token scope mismatch)

---

### SEC-8: Input Validation - Malformed API Key

**Test**: Reject malformed API keys

**Steps**:

1. `POST /api/tenants/tenant-123/service-instances`
2. Body: `{ "apiKey": "<script>alert('xss')</script>" }`

**Expected**: 400 Bad Request with validation error

---

### SEC-9: SQL Injection in ClickHouse Query

**Test**: Ensure parameterized queries prevent SQL injection

**Steps**:

1. Malicious query: `GET /api/tenants/tenant-123/analytics/voice-sessions?provider=grok_realtime'; DROP TABLE voice_trace_events; --`

**Expected**: Query fails safely (no table dropped), 400 Bad Request or empty result

---

### SEC-10: Rate Limiting for Credential Endpoints

**Test**: Rate limit credential CRUD operations

**Steps**:

1. Send 100 rapid requests: `POST /api/tenants/tenant-123/service-instances`
2. Auth: Valid tenant admin JWT

**Expected**: After ~10 requests, receive 429 Too Many Requests

---

## 6. Performance & Load Tests

### PERF-1: Concurrent Session Throughput

**Objective**: Verify platform handles 50+ concurrent Grok voice sessions

**Steps**:

1. Use k6 or Artillery to spawn 50 concurrent WebSocket connections
2. Each connection: start voice session → send 10 audio frames → receive 10 audio frames → end session
3. Monitor: CPU usage, memory usage, WebSocket connection count

**Expected**:

- All 50 sessions succeed without errors
- p95 turn latency < 600ms
- Memory usage linear growth (no leaks)

---

### PERF-2: Credential Cache Hit Rate

**Objective**: Verify credential cache reduces DB queries

**Steps**:

1. Start 100 voice sessions for same tenant (sequential)
2. Monitor: MongoDB query count, cache hit/miss ratio

**Expected**:

- MongoDB query count: 1 (first session cache miss, rest cache hits)
- Cache hit rate: 99%

---

### PERF-3: Audio Streaming Latency

**Objective**: Measure audio round-trip latency (user audio → Grok → response audio)

**Steps**:

1. Send PCM16 audio frame (timestamp T1)
2. Receive first audio response frame (timestamp T2)
3. Calculate latency: T2 - T1

**Expected**:

- p50 latency < 300ms
- p95 latency < 600ms
- p99 latency < 1000ms

---

### PERF-4: Trace Event Write Throughput

**Objective**: Verify ClickHouse handles high-volume trace event writes

**Steps**:

1. Start 50 concurrent Grok sessions
2. Each session: 10 turns (500 total turns)
3. Monitor: ClickHouse write latency, queue depth

**Expected**:

- All trace events written successfully
- ClickHouse write p95 < 50ms
- No event drops

---

### PERF-5: Reconnection Impact on Latency

**Objective**: Measure latency increase during reconnection

**Steps**:

1. Start voice session, send audio (measure baseline latency)
2. Simulate disconnect → reconnect
3. Send audio immediately after reconnection (measure reconnection latency)

**Expected**:

- Reconnection latency < baseline + 2000ms (max backoff delay)
- Session state preserved (no data loss)

---

## 7. Test Infrastructure

### Required Services

- **MongoDB** (Docker): `docker-compose up -d abl-mongo`
  - Port: 27018
  - Database: `abl_platform`
  - Auth: `abl_admin` / `abl_dev_password`

- **Redis** (Docker): `docker-compose up -d abl-redis`
  - Port: 6380

- **ClickHouse** (Docker): `docker-compose up -d abl-clickhouse`
  - Port: 8124
  - Database: `abl_observability`

- **Runtime Service** (local or Docker):
  - Port: 3112
  - Env: `NODE_ENV=test`, `GROK_API_ENDPOINT=ws://localhost:9999/v1/realtime` (mock)

- **Studio Service** (local or Docker):
  - Port: 5173
  - Env: `NEXT_PUBLIC_RUNTIME_URL=http://localhost:3112`

- **Mock Grok Server** (test fixture):
  - Port: 9999
  - Implements OpenAI-compatible WebSocket protocol
  - Controllable responses, disconnects, errors

### Data Seeding

**Seed Script**: `apps/runtime/src/__tests__/helpers/seed-grok-test-data.ts`

```typescript
export async function seedGrokTestData() {
  // Create test tenants
  await Tenant.create([
    { _id: 'test-tenant-grok-e2e-1', name: 'Grok Test Tenant 1' },
    { _id: 'test-tenant-grok-e2e-2', name: 'Grok Test Tenant 2' },
  ]);

  // Create Grok credentials
  await TenantServiceInstance.create([
    {
      tenantId: 'test-tenant-grok-e2e-1',
      serviceType: 's2s:grok',
      displayName: 'Test Grok Credentials',
      encryptedCredentials: { apiKey: 'xai-test-key-e2e-1', config: { model: 'grok-realtime-1' } },
      isDefault: true,
      isActive: true,
    },
  ]);

  // Create test project
  await Project.create({
    _id: 'test-project-grok-e2e',
    tenantId: 'test-tenant-grok-e2e-1',
    name: 'Grok E2E Test Project',
  });

  // Create test agent with voice_optimized hint
  await Agent.create({
    projectId: 'test-project-grok-e2e',
    name: 'voice_agent',
    dslContent:
      'AGENT voice_agent WITH voice_optimized = true\nGOAL: "Test voice agent"\nTOOLS: get_weather(location: string)',
  });
}
```

### Environment Variables

**Runtime** (`.env.test`):

```bash
NODE_ENV=test
MONGO_URI=mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform_test?authSource=admin
REDIS_URL=redis://localhost:6380
CLICKHOUSE_URL=http://localhost:8124
GROK_API_ENDPOINT=ws://localhost:9999/v1/realtime
ENCRYPTION_KEY_BASE64=<test-key>
```

**Studio** (`.env.test`):

```bash
NEXT_PUBLIC_RUNTIME_URL=http://localhost:3112
NEXT_PUBLIC_API_BASE_URL=http://localhost:3112/api
```

### CI Configuration

**GitHub Actions** (`.github/workflows/test-grok-voice.yml`):

```yaml
name: Grok Voice Tests

on:
  pull_request:
    paths:
      - 'packages/compiler/src/platform/llm/realtime/grok-realtime.ts'
      - 'apps/runtime/src/services/voice/**'
      - 'apps/studio/src/components/admin/VoiceServicesPage.tsx'

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      mongodb:
        image: mongo:7
        ports: ['27018:27017']
      redis:
        image: redis:7
        ports: ['6380:6379']
      clickhouse:
        image: clickhouse/clickhouse-server:latest
        ports: ['8124:8123']

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - name: Run Unit Tests
        run: pnpm --filter @abl/compiler test grok-realtime.test.ts

      - name: Run Integration Tests
        run: pnpm --filter @agent-platform/runtime test grok-voice-integration.test.ts

      - name: Run E2E Tests
        run: pnpm --filter @agent-platform/runtime test:e2e grok-e2e.test.ts
```

---

## 8. Test File Mapping

| Test File                                                                     | Type        | Covers FRs               | Description                                                    |
| ----------------------------------------------------------------------------- | ----------- | ------------------------ | -------------------------------------------------------------- |
| `packages/compiler/src/platform/llm/realtime/__tests__/grok-realtime.test.ts` | Unit        | FR-1, FR-2, FR-11, FR-14 | GrokRealtimeSession contract compliance, reconnection logic    |
| `apps/runtime/src/__tests__/channels/grok-voice-integration.test.ts`          | Integration | FR-5, FR-7, FR-12        | VoiceServiceFactory credential resolution, encryption, caching |
| `apps/runtime/src/__tests__/korevg/grok-s2s-integration.test.ts`              | Integration | FR-3, FR-4, FR-5         | KoreVG S2S payload generation, llm verb builder                |
| `apps/runtime/src/__tests__/observability/grok-voice-trace.test.ts`           | Integration | FR-10, FR-15             | Trace event emission, ClickHouse writes                        |
| `apps/runtime/src/__tests__/e2e/grok-voice-e2e.test.ts`                       | E2E         | FR-1 to FR-15            | Complete voice session lifecycle E2E                           |
| `apps/runtime/src/__tests__/e2e/grok-korevg-e2e.test.ts`                      | E2E         | FR-3, FR-5, FR-9, FR-10  | KoreVG telephony with Grok S2S                                 |
| `apps/studio/src/__tests__/admin/voice-services-grok.test.tsx`                | Integration | FR-6, FR-8               | Studio UI Grok card rendering and CRUD                         |
| `apps/runtime/src/__tests__/security/grok-isolation.test.ts`                  | Integration | FR-12                    | Cross-tenant credential access 404 tests                       |
| `apps/runtime/src/__tests__/performance/grok-concurrent-sessions.test.ts`     | Load        | FR-1, FR-5, FR-12        | 50+ concurrent sessions, cache hit rate                        |

---

## 9. Open Testing Questions

1. **Grok API Mock Server**: Should we build a full OpenAI-compatible mock server, or use a lightweight stub for E2E tests? Full mock enables protocol validation, stub is faster to build.

2. **Load Test Thresholds**: What's the target concurrent session count for production? 50 sessions is baseline, should we test 100+, 500+?

3. **Audio Test Data**: Do we need diverse audio samples (accents, languages, background noise) for realistic E2E tests, or is synthetic PCM16 sufficient?

4. **Grok API Rate Limits**: Without official Grok documentation, how do we set realistic rate limit expectations in tests? Mock conservative limits (100 req/min)?

5. **Studio E2E Browser Tests**: Should we use Playwright for full browser E2E tests of Studio UI, or is React Testing Library integration testing sufficient?

6. **ClickHouse Test Data Retention**: How long should we keep test data in ClickHouse? Truncate after each test run, or persist for debugging?

7. **CI Test Parallelization**: Can we run E2E tests in parallel, or do they need sequential execution due to shared MongoDB/ClickHouse state?

8. **Grok API Test Account**: Do we need a real xAI API key for CI tests, or always use mock? If real API, how do we secure the key in CI?

9. **Tool Calling Test Coverage**: How many tool types should we test (simple string params, complex objects, arrays)? Current plan tests 1 tool type.

10. **Homer/HEP Integration Tests**: Should we test Homer quality metrics integration, or mark it as optional (depends on Homer infrastructure availability)?

---

## 10. Test Execution Order

### Phase 1: Unit Tests (Parallel)

- Run all unit tests in `packages/compiler` and `apps/runtime`
- No external dependencies (mocked)
- Duration: ~2 minutes

### Phase 2: Integration Tests (Sequential within package, parallel across packages)

- Compiler package integration tests
- Runtime package integration tests
- Studio package integration tests
- Requires: MongoDB, Redis, ClickHouse running
- Duration: ~5 minutes

### Phase 3: E2E Tests (Sequential)

- E2E-1: Complete lifecycle
- E2E-2: KoreVG telephony
- E2E-3: Studio UI
- E2E-4: Reconnection
- E2E-5: Multi-tenant concurrency
- E2E-6: Tool calling
- E2E-7: Voice mode resolver
- Requires: All services running (Runtime, Studio, Mock Grok)
- Duration: ~10 minutes

### Phase 4: Performance/Load Tests (Sequential)

- PERF-1: Concurrent sessions
- PERF-2: Cache hit rate
- PERF-3: Audio latency
- PERF-4: Trace throughput
- PERF-5: Reconnection impact
- Requires: All services + load harness
- Duration: ~5 minutes

**Total Estimated Duration**: ~22 minutes (CI full suite)

---

## 11. Test Coverage Targets

| FR Category            | Target Coverage | Current | Gap     |
| ---------------------- | --------------- | ------- | ------- |
| Core Adapter (FR-1,2)  | 90%+ lines      | 0%      | 90%     |
| Credentials (FR-5,7,8) | 85%+ lines      | 0%      | 85%     |
| Tool Calling (FR-9)    | 80%+ lines      | 0%      | 80%     |
| Observability (FR-10)  | 75%+ lines      | 0%      | 75%     |
| Studio UI (FR-6)       | 70%+ lines      | 0%      | 70%     |
| **Overall Target**     | **80%+ lines**  | **0%**  | **80%** |

**E2E Scenario Coverage**: 7 mandatory scenarios (above minimum 5)
**Integration Scenario Coverage**: 7 scenarios (above minimum 5)

---

## 12. Test Maintenance Plan

1. **Weekly**: Review flaky tests, add retries or fix race conditions
2. **Per PR**: Run full test suite in CI before merge
3. **Post-Release**: Add regression tests for any production bugs found
4. **Quarterly**: Review test coverage, add tests for under-covered modules

---

**End of Test Specification**
