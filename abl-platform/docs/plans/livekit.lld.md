# LiveKit Integration — Low-Level Design

## Task T-1: LiveKit Routes

### Files

- `apps/runtime/src/routes/livekit.ts` — GET /capabilities, POST /token

### Capabilities Route

- Returns `{ enabled, configured }` based on feature flag and LiveKit URL/key/secret presence
- Does NOT expose LiveKit URL (security: infrastructure topology detail)

### Token Route

1. Check `features.livekitEnabled` and LiveKit config
2. Validate input: sessionId, projectId (required), agentName, deploymentId (optional)
3. Check concurrency limit: `activeRoomCount() >= maxConcurrentRooms` returns 429
4. Require tenant context (tenantId)
5. Check session access via `resolveProjectSessionAccess`
6. Pre-flight: verify voice credentials (STT + TTS) via VoiceServiceFactory
7. Build tenant-scoped room name: `voice_{tenantId}_{projectId}_{sessionId}`
8. Generate AccessToken with scoped grants (canPublish, canSubscribe, no canPublishData)
9. Return `{ token, roomName, url, identity }`
10. Fire-and-forget: `spawnAgentForRoom(roomName, metadata)`

### Security

- `authMiddleware` on all routes (JWT / SDK token / API key)
- `tenantRateLimit('request')` on all routes
- Input validation via `isValidId` and `isValidAgentName` (regex patterns)
- Scoped permissions: `session:voice` for SDK sessions, `session:execute` for others

---

## Task T-2: Worker Entry

### Files

- `apps/runtime/src/services/voice/livekit/worker-entry.ts` — Worker lifecycle management

### Exports

- `startLiveKitWorker()` — Validate config, mark worker ready
- `stopLiveKitWorker()` — Graceful shutdown: close all sessions, disconnect rooms, dispose adapters
- `isLiveKitWorkerRunning()` — Health probe
- `activeRoomCount()` — Concurrency tracking for route rate limit
- `spawnAgentForRoom(roomName, metadata)` — Start agent in specific room
- `registerAdapter(roomName, adapter)` / `unregisterAdapter(roomName)` — Adapter lifecycle

### State

- `activeAdapters: Map<roomName, RuntimeLLMAdapter>` — No max size or TTL (gap)
- `activeConnections: Map<roomName, ActiveAgentConnection>` — No max size or TTL (gap)
- `voiceFactory: VoiceServiceFactory | null` — Injected from server.ts

### Shutdown

- Calls `connection.cleanup()` for all active connections
- Calls `adapter.dispose()` for remaining adapters
- Clears both maps, marks worker stopped

---

## Task T-3: Agent Worker

### Files

- `apps/runtime/src/services/voice/livekit/agent-worker.ts` — In-process agent

### Key Function

```typescript
startAgentInRoom(config: AgentWorkerConfig, roomName: string, metadata: RoomMetadata, voiceFactory): Promise<ActiveAgentConnection>
```

### Flow

1. Dynamic import `@livekit/rtc-node` and `@livekit/agents`
2. Validate room metadata (parseAndValidateMetadata)
3. Create RuntimeLLMAdapter with session/project/agent info
4. Create Room, connect to LiveKit server
5. Create AgentSession with STT (Deepgram), TTS (ElevenLabs), VAD
6. Register adapter in worker-entry
7. Start voice pipeline
8. Return `{ room, session, adapter, cleanup }` for lifecycle management

### Metadata Validation

- `sessionId`: must match `ID_PATTERN` (/^[a-zA-Z0-9_\-]{1,128}$/)
- `projectId`: must match `ID_PATTERN`
- `agentName`: optional, must match `AGENT_NAME_PATTERN` (/^[a-zA-Z0-9_\-]{1,64}$/)
- `tenantId`: optional, must match `ID_PATTERN`

---

## Task T-4: RuntimeLLM Adapter

### Files

- `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` — LLM bridge

### Key Design

- Bridges LiveKit's agent framework LLM interface with RuntimeExecutor
- `chat(userMessage)` → `RuntimeExecutor.executeMessage()` → stream response text
- Per-project DSL cache: `projectDSLCache` (Map, 5-min TTL, max 500 entries)
- Tenant-guarded project lookup (tenantId is server-authoritative from token)
- Chat timeout prevents indefinite hangs

---

## Task T-5: Trace Hooks

### Files

- `apps/runtime/src/services/voice/livekit/livekit-trace-hooks.ts` — Voice observability

### Events

- `traceLiveKitTurnStart` — Voice turn begins
- `traceLiveKitSTT` — STT transcription received
- `traceLiveKitLLMStart` / `traceLiveKitLLMEnd` — LLM call lifecycle
- `traceLiveKitTTSStart` — TTS synthesis begins
- `traceLiveKitTurnComplete` — Full turn completed
- `traceLiveKitTurnFailed` — Turn failed with error

---

## Task T-6: Input Validation

### Files

- `apps/runtime/src/services/voice/livekit/validation.ts` — Shared validation

### Patterns

- `ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/` — sessionId, projectId, tenantId, deploymentId
- `AGENT_NAME_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/` — agentName
- `isValidId(value)` — Type guard for ID validation
- `isValidAgentName(value)` — Type guard for agent name validation

---

## Task T-7: Studio Proxy Routes

### Files

- `apps/studio/src/app/api/livekit/token/route.ts` — Proxy to runtime token endpoint
- `apps/studio/src/app/api/livekit/capabilities/route.ts` — Proxy to runtime capabilities

---

## Known Gaps

| Gap                                                           | Severity | Notes                                       |
| ------------------------------------------------------------- | -------- | ------------------------------------------- |
| activeAdapters/activeConnections Maps have no max size or TTL | Medium   | Could grow unbounded if cleanup fails       |
| All @livekit types are `any` (dynamic imports)                | Low      | No type safety for LiveKit SDK interactions |
| projectDSLCache has no eviction notification                  | Low      | Stale DSLs served for up to 5 minutes       |
| No multi-participant support                                  | Low      | Architecture assumes 1:1 user-agent         |

## Exit Criteria

- Token generation returns valid LiveKit JWT with scoped grants
- Capabilities returns correct enabled/configured state
- Input validation rejects path traversal, XSS, and oversized inputs
- Room names include tenantId for isolation
- Agent spawn does not block token response
- Graceful shutdown disposes all resources
