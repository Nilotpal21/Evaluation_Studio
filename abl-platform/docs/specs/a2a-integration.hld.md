# HLD: A2A Integration (Agent-to-Agent Protocol)

**Feature**: [docs/features/a2a-integration.md](../features/a2a-integration.md)
**Test Spec**: [docs/testing/a2a-integration.md](../testing/a2a-integration.md)
**Status**: BETA
**Last Updated**: 2026-04-14

---

## 1. Problem Statement

ABL agents need a standardized, secure protocol to participate in multi-agent systems beyond a single runtime process. Without A2A integration:

- External agents cannot discover or invoke deployed ABL agents via a standard protocol.
- ABL agents cannot call remote agents with SSRF protection, trace propagation, or session continuity.
- Long-running cross-agent operations (push notifications, human-in-the-loop) have no standard suspension/resumption pattern.
- There is no connection-scoped identity model for exposing agents as protocol endpoints.

The implementation must preserve the platform's core invariants: tenant isolation at the query level, centralized auth, stateless distributed execution, traceability, and compliance with encryption and data minimization requirements.

---

## 2. Alternatives Considered

### Alternative A: Global Agent Mounting (Single A2A Endpoint per Agent)

**Description**: Mount one global A2A endpoint per deployed agent (e.g., `/a2a/agents/:agentName`). The agent's identity, auth, and card would be tied to the agent definition.

**Pros**:

- Simpler routing (no connection resolution middleware)
- Direct mapping between agent and protocol endpoint

**Cons**:

- No connection-scoped identity (different configurations for the same agent require separate agent definitions)
- Auth configuration tied to agent, not deployment
- Card customization requires agent redefinition
- Cannot have multiple A2A endpoints for the same agent with different auth/card configurations

**Effort**: M

### Alternative B: Connection-Scoped A2A Endpoints (Chosen)

**Description**: Mount A2A endpoints per channel connection (e.g., `/a2a/:connectionId`). Identity, auth, and card metadata are tied to the connection record. Multiple connections can point to the same agent with different configurations.

**Pros**:

- Decouples protocol identity from agent identity
- Per-connection auth and card customization
- Follows the existing channel connection model (consistency with WebSocket, webhook, etc.)
- Multiple deployments of the same agent can have different A2A configurations
- Connection status (active/inactive) controls endpoint availability

**Cons**:

- Extra resolution step (connectionId -> agentId) on every request
- Connection CRUD adds management overhead
- Connection-to-agent mapping adds a level of indirection

**Effort**: L (already implemented)

### Alternative C: SDK-Native Server Integration

**Description**: Use the A2A SDK's built-in server directly (e.g., `A2AServer.start()`) instead of wrapping it in Express handlers.

**Pros**:

- Less custom code
- Automatic protocol compliance

**Cons**:

- Cannot integrate with the runtime's existing Express middleware chain (auth, rate limiting, tenant isolation)
- No control over startup lifecycle (LazyTaskStore, async infra upgrade)
- Cannot share the runtime's Express instance (port conflict)

**Effort**: S

### Recommendation

**Alternative B** is the chosen approach. It provides the best balance of flexibility, consistency with the existing channel model, and operational control. The extra resolution step is mitigated by connection caching. This is already fully implemented.

---

## 3. Architecture

### System Context Diagram

```
                    ┌──────────────────────────────────────────┐
                    │           External A2A Agents             │
                    │  (Google, third-party, other platforms)   │
                    └──────────┬───────────────┬───────────────┘
                               │               │
                    Discovery  │    JSON-RPC    │  Push Notifications
                    (GET card) │  (POST tasks)  │  (POST callbacks)
                               │               │
                    ┌──────────▼───────────────▼───────────────┐
                    │          ABL Runtime (Express)            │
                    │                                          │
                    │  ┌─────────────────────────────────────┐ │
                    │  │   A2A Protocol Layer                 │ │
                    │  │   /a2a/:connectionId (JSON-RPC, SSE) │ │
                    │  │   /a2a/callbacks/:callbackId         │ │
                    │  └────────────┬────────────────────────┘ │
                    │               │                          │
                    │  ┌────────────▼────────────────────────┐ │
                    │  │  @agent-platform/a2a (Hexagonal)     │ │
                    │  │  domain/ports.ts (contracts)         │ │
                    │  │  application/ (use cases)            │ │
                    │  │  infrastructure/ (adapters)          │ │
                    │  └────────────┬────────────────────────┘ │
                    │               │                          │
                    │  ┌────────────▼────────────────────────┐ │
                    │  │  Runtime Execution Engine             │ │
                    │  │  RuntimeExecutor / RoutingExecutor    │ │
                    │  │  Session / Thread Management          │ │
                    │  └──────┬──────────────────┬───────────┘ │
                    └─────────┼──────────────────┼─────────────┘
                              │                  │
                    ┌─────────▼──────┐  ┌────────▼─────────┐
                    │   MongoDB       │  │     Redis         │
                    │ channel_conns   │  │ sessions, tasks   │
                    │ suspended_exec  │  │ callbacks, cache  │
                    └────────────────┘  └──────────────────┘
```

### Component Diagram

```
@agent-platform/a2a (packages/a2a/)
├── domain/
│   └── ports.ts                    # AgentExecutionPort, A2ATracingPort,
│                                   # A2ASessionResolverPort, EndpointValidator
├── application/
│   ├── send-task.ts                # Outbound sync dispatch
│   ├── send-task-async.ts          # Outbound async + push notification
│   ├── send-task-streaming.ts      # Outbound SSE streaming
│   ├── discover-agent.ts           # Agent card discovery
│   ├── poll-task.ts                # Task status polling
│   ├── cancel-task.ts              # Task cancellation
│   └── push-notification-delivery.ts  # Outbound push notifications
├── infrastructure/
│   ├── agent-executor-adapter.ts   # SDK AgentExecutor -> platform bridge
│   ├── express-handlers.ts         # A2A Express route factory
│   ├── a2a-callback-handler.ts     # Callback router
│   ├── redis-task-store.ts         # Redis-backed task persistence
│   ├── lazy-task-store.ts          # InMemory -> Redis upgrade proxy
│   ├── agent-card-cache.ts         # Card cache with TTL/eviction
│   ├── client-factory.ts           # SDK client creation
│   ├── authenticated-client-factory.ts  # Auth-injected client
│   ├── traced-client.ts            # SSRF + tracing interceptor
│   └── ssrf-interceptor.ts         # SSRF validation adapter
└── index.ts                        # Public API surface
```

### Data Flow: Inbound A2A Request

```
1. External agent sends POST /a2a/:connectionId (JSON-RPC)
2. Express middleware resolves connectionId -> ChannelConnection
3. If connection has encryptedA2aApiKey, verify Bearer token -> 401 if invalid
4. A2AExpressApp routes JSON-RPC to DefaultRequestHandler
5. DefaultRequestHandler extracts method and delegates:
   - message/send -> AgentExecutorAdapter.execute()
   - tasks/get -> TaskStore.load()
   - tasks/cancel -> AgentExecutorAdapter.cancelTask()
6. AgentExecutorAdapter:
   a. Extracts text/data/file parts from message
   b. Resolves contextId -> sessionId via A2ASessionResolverPort
   c. Publishes status-update(working) event
   d. Delegates to AgentExecutionPort.executeMessage(sessionId, text)
   e. On completion: publishes message + status-update(completed, final=true)
   f. On suspension: publishes status-update(input-required or working, final=true)
   g. On error: publishes status-update(failed, final=true)
7. TaskStore persists task state
8. Response sent to caller (JSON-RPC result or SSE stream)
```

### Data Flow: Outbound A2A Call (Remote Handoff)

```
1. RoutingExecutor encounters HANDOFF with PROTOCOL A2A
2. Checks AgentCardCache for remote agent capabilities
3. If card not cached, calls discoverAgent (SSRF-validated)
4. If card.capabilities.pushNotifications && ASYNC:
   a. Generates callbackId and callbackSecret
   b. Creates SuspendedExecution in MongoDB
   c. Registers callback in Redis
   d. Calls sendTaskAsync with pushNotificationUrl
   e. Returns suspended result to caller
5. If sync or card doesn't support push:
   a. Calls sendTask with SSRF-validated endpoint
   b. Races against timeout (configurable per handoff)
   c. Extracts text from response Task/Message
   d. Returns result to caller
6. TracedCallInterceptor records duration and status
```

### Data Flow: Push Notification Callback

```
1. Remote agent POSTs to /a2a/callbacks/:callbackId
2. Callback handler atomically claims from Redis (GET+DEL)
3. If already claimed, returns 200 { status: 'already_processed' }
4. If suspensionLookup available, verifies Bearer token against encrypted secret
5. Enqueues resume job to BullMQ 'execution-resume' queue
6. On enqueue failure, re-registers callback (retry safety)
7. BullMQ worker loads session from Redis
8. Execution resumes at continuation point
9. Result delivered via ChannelDispatcher (WebSocket, cross-pod pubsub, or pending delivery)
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

All A2A data is tenant-scoped at the query level:

- **Session resolver**: Redis key `a2a:session:{tenantId}:{contextId}` includes tenantId -- same contextId for different tenants maps to different sessions.
- **Task store**: Context-task index key `a2a:ctx-tasks:{tenantId}:{contextId}` includes tenantId -- `listByContext` filters by tenant.
- **Connection resolution**: Channel connections are queried with `{ _id: connectionId, channelType: 'a2a', status: 'active' }` and connection.tenantId is used for downstream operations.
- **Callback registry**: Claimed callbacks include tenantId; resume jobs carry tenantId for session loading.
- **Cross-tenant access**: Returns 404 (not 403) per platform invariant #1.

#### 2. Data Access Pattern

- **Channel connections**: Direct Mongoose model access in route handlers (no dedicated repository layer yet). Queries always include tenantId.
- **Task store**: `RedisA2ATaskStore` implements the SDK's `TaskStore` interface. Uses JSON serialization with configurable TTL.
- **Session resolver**: Atomic `SET NX` for first-turn registration; `GET` for subsequent turns.
- **Callbacks**: `RedisCallbackRegistry` with atomic claim (GET+DEL Lua script).
- **Caching**: `AgentCardCache` with 5-min TTL, 100-entry max, LRU eviction.

#### 3. API Contract

**Inbound** (JSON-RPC over HTTP):

- `message/send`: Accepts `MessageSendParams`, returns `Task` or `Message`
- `tasks/get`: Accepts `TaskQueryParams`, returns `Task`
- `tasks/cancel`: Accepts `TaskIdParams`, returns `Task`
- Error envelope: JSON-RPC error with negative code, message, and optional data

**Outbound** (via SDK client):

- Same JSON-RPC contract as inbound, consumed via `A2AClient` methods
- All outbound calls return typed `Task | Message` or throw

**SSE Streaming**:

- Event types: `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `Message`
- Event sequence: working -> artifact chunks -> message (SDK does not yield final completed status)

#### 4. Security Surface

- **Inbound auth**: Per-connection Bearer token with encrypted API key storage (`config.encryptedA2aApiKey`)
- **Outbound SSRF**: All remote endpoints validated via `SsrfEndpointValidator` / `assertUrlSafeForSSRF` before HTTP calls
- **Callback auth**: Bearer token verification against encrypted `callbackSecret` in `SuspendedExecution`
- **Unified callback HMAC**: `x-callback-signature` header with HMAC-SHA256 on unified callback route
- **Encryption at rest**: API keys and callback secrets encrypted via platform encryption service
- **Input validation**: connectionId format validation (rejects path traversal), JSON-RPC schema validation by SDK

### Behavioral Concerns

#### 5. Error Model

| Error Case                      | HTTP Status | JSON-RPC Code | User Experience                   |
| ------------------------------- | ----------- | ------------- | --------------------------------- |
| Invalid connectionId format     | 400         | N/A           | Client retries with valid ID      |
| Connection not found / inactive | 404         | N/A           | Client discovers correct endpoint |
| Auth required, no token         | 401         | N/A           | Client adds Bearer header         |
| Malformed JSON body             | 200         | -32700        | Client fixes payload              |
| Unknown method                  | 200         | -32601        | Client uses supported method      |
| Task not found                  | 200         | -32602        | Client verifies task ID           |
| Execution fails                 | 200         | N/A           | Task state -> failed              |
| SSRF validation fails           | N/A         | N/A           | Error propagated to caller        |
| Callback claim fails            | 200         | N/A           | Idempotent response               |

#### 6. Failure Modes

- **Redis down at startup**: LazyTaskStore and MemoryA2ASessionResolver provide degraded-but-functional A2A surface. Async operations unavailable (503 from placeholder routers).
- **Redis down mid-operation**: Task save after execution may fail. Session resolver falls back to ephemeral in-memory (if not yet upgraded).
- **BullMQ enqueue failure**: Callback re-registered in Redis for retry. 503 returned to caller.
- **Remote agent unreachable**: sendTask throws; routing executor catches and returns error to session. Timeout race prevents indefinite hang.
- **SDK generator hang**: Mitigated by sync+forward fallback (sendTask instead of sendTaskStreaming).

#### 7. Idempotency

- **Callback claim**: Atomic GET+DEL ensures exactly-once processing. Duplicate callbacks receive `{ ok: true, status: 'already_processed' }`.
- **Session resolver**: `SET NX` ensures at most one session is created per contextId+tenantId. Concurrent first-turns converge to the winner's session.
- **Task store save**: `SET EX` overwrites; last-write-wins is acceptable for task state updates (state machine is monotonic).

#### 8. Observability

- **A2ATracingPort**: `traceInbound` and `traceOutbound` emit structured log entries with tenantId, taskId, agentName, durationMs, and status.
- **Structured logging**: All A2A operations use `createLogger('a2a')` with context fields.
- **Decision events**: `RoutingExecutor` emits `emitDecisionEvent` for handoff/delegate/fan-out decisions.
- **Session resolution logging**: Logs contextId -> sessionId mapping, race resolution, and first-turn creation.

### Operational Concerns

#### 9. Performance Budget

| Operation                       | Target Latency | Notes                         |
| ------------------------------- | -------------- | ----------------------------- |
| Agent card discovery (cached)   | <5ms           | AgentCardCache hit            |
| Agent card discovery (uncached) | <500ms         | DB lookup + card construction |
| Inbound message/send (sync)     | Depends on LLM | LLM latency dominates         |
| Outbound sendTask (sync)        | <30s           | Configurable timeout          |
| Session resolver (Redis)        | <10ms          | Single SET NX or GET          |
| Task store save (Redis)         | <10ms          | SET with TTL                  |
| Callback claim                  | <5ms           | Atomic GET+DEL                |
| Context-task list (Redis)       | <50ms          | ZRANGEBYSCORE + MGET          |

**Payload limits**: Not explicitly enforced on A2A endpoints. JSON body size limited by Express `json()` middleware default (100KB). Large payloads (file attachments) should use URI references instead of inline bytes.

#### 10. Migration Path

Current state: A2A is fully implemented and operational (BETA).

Migration to STABLE requires:

1. Close GAP-001 (cross-tenant E2E verification)
2. Close GAP-002 (tasks/cancel E2E)
3. Close GAP-003 (restart persistence verification)
4. Replace globalThis.fetch patching in authenticated client factory
5. Re-enable sendTaskStreaming when SDK generator issue is resolved

No data migration is required. All Redis data has bounded TTLs and can be regenerated.

#### 11. Rollback Plan

- **Connection-level**: Deactivate A2A connections via `PATCH /channel-connections/:id { status: 'inactive' }`. Inactive connections are immediately unreachable.
- **Feature-level**: Remove A2A route mounting from `server.ts` and skip wireAsyncInfra A2A sections. Redis/MongoDB data expires naturally via TTL.
- **SDK-level**: Pin `@a2a-js/sdk` to a known-good version in `package.json`.
- **No data migration needed**: All A2A data is ephemeral (TTL-bound) and can be regenerated.

#### 12. Test Strategy

| Layer       | Coverage                                                                                                 | Target                                 |
| ----------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Unit        | 13 test files in `packages/a2a/src/__tests__/` + `chat-routes.test.ts` metadata tests                    | Each use case and adapter tested       |
| Integration | Streaming integration, adapter state transitions, callback handling                                      | All INT-1 through INT-7 from test spec |
| E2E         | 35 live tests passing (agent card, message lifecycle, multi-turn, streaming, auth, rich content, memory) | All E2E-1 through E2E-7 from test spec |
| Security    | SSRF validation, auth enforcement, callback token verification                                           | Unit + E2E                             |
| Performance | Not yet automated                                                                                        | Define baselines for key operations    |

---

## 5. Data Model

### New Collections/Tables

None -- A2A uses the existing `channel_connections` collection and `suspended_executions` collection.

### Modified Collections/Tables

**channel_connections** (extended for A2A):

```typescript
{
  channelType: 'a2a',
  config: {
    card?: {
      name?: string;
      description?: string;
      version?: string;
      skills?: Array<{ id: string; name: string; description?: string }>;
      defaultInputModes?: string[];
      defaultOutputModes?: string[];
    };
    encryptedA2aApiKey?: string;  // Encrypted inbound Bearer token
  }
}
```

### Redis Key Schema

| Key Pattern                            | Type          | TTL                | Purpose                        |
| -------------------------------------- | ------------- | ------------------ | ------------------------------ |
| `a2a:session:{tenantId}:{contextId}`   | STRING        | 24h                | contextId -> sessionId mapping |
| `a2a:task:{taskId}`                    | STRING (JSON) | 24h                | Task state persistence         |
| `a2a:push:{taskId}`                    | STRING (JSON) | 24h                | Push notification config       |
| `a2a:ctx-tasks:{tenantId}:{contextId}` | ZSET          | 24h                | Task index per context         |
| `callback:{callbackId}`                | STRING (JSON) | Matches suspension | Callback -> suspension mapping |

---

## 6. API Design

### New Endpoints

None planned for this HLD cycle. All endpoints are implemented and operational.

### Existing Endpoints

See feature spec section 8 for the full endpoint inventory.

### Error Responses

All errors follow the JSON-RPC 2.0 error format for protocol endpoints:

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

Non-protocol endpoints (connection CRUD) use the platform standard: `{ success: false, error: { code, message } }`.

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Not yet implemented for A2A-specific operations. Inbound/outbound calls are traced via `A2ATracingPort` but not persisted to an audit log.
- Recommendation: Integrate with platform audit logging when it matures (see `docs/features/audit-logging.md`).

### Rate Limiting

- Not yet implemented for A2A inbound endpoints.
- Platform-level Express rate limiting applies but is not A2A-specific.
- Recommendation: Add per-connection rate limiting as a connection configuration field.

### Caching

- **Agent card cache**: 5-min TTL, 100-entry max, LRU eviction. Used for outbound discovery.
- **Connection resolution**: Currently resolved per-request from DB. Could benefit from a short-TTL cache.

### Encryption

- **At rest**: API keys encrypted via `config.encryptedA2aApiKey`. Callback secrets encrypted in `SuspendedExecution.callbackSecret`.
- **In transit**: HTTPS required in production (`CALLBACK_BASE_URL` should use TLS). JSON-RPC payloads are plaintext within the TLS tunnel.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency               | Risk                                         | Mitigation                                               |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------- |
| `@a2a-js/sdk` v0.2.5+    | Medium (SDK bugs affect protocol compliance) | Pin version, sync+forward fallback for streaming         |
| Redis                    | Medium (required for production async)       | LazyTaskStore/MemorySessionResolver for degraded startup |
| BullMQ                   | Medium (required for callback resume)        | Callback re-registration on enqueue failure              |
| MongoDB                  | Low (connection storage)                     | Standard platform DB infra                               |
| Express middleware chain | Low (auth, rate limiting)                    | Tested via E2E                                           |

### Downstream (depends on this feature)

| Consumer                         | Impact | Notes                                                    |
| -------------------------------- | ------ | -------------------------------------------------------- |
| RoutingExecutor (remote handoff) | High   | All outbound A2A calls go through sendTask/sendTaskAsync |
| Channel system                   | Medium | A2A registered as channel type                           |
| Studio connection UI             | Low    | CRUD for A2A connections                                 |

---

## 9. Open Questions & Decisions Needed

1. **Connection-level rate limiting**: Should rate limits be configurable per A2A connection, or is platform-level rate limiting sufficient?
2. **Audit trail**: Should A2A inbound/outbound calls be persisted to an audit log beyond structured tracing?
3. **User-scoped credentials**: Should outbound A2A calls support user-scoped credential resolution (currently tenant-only)?
4. **globalThis.fetch patching**: The authenticated client factory patches the global fetch. Should this be refactored to a request-scoped pattern?
5. **SDK streaming fix**: When `@a2a-js/sdk` fixes the async generator cleanup hang, should sendTaskStreaming be re-enabled automatically via a feature flag?

---

## 10. Post-Implementation Notes (2026-04-14)

### Per-Message Metadata Parity (ABLP-133)

Two commits added per-message metadata parity between A2A inbound and the REST/WebSocket channels:

1. **`A2ARequestContext.messageMetadata`** -- New optional field on the domain port contract (`packages/a2a/src/domain/ports.ts`). The adapter extracts `message.metadata.messageMetadata` from inbound A2A messages without leaking the reserved `history` key.
2. **`AgentExecutorAdapter` extraction** -- New `extractInboundMessageMetadata` function in `agent-executor-adapter.ts` validates that metadata is a non-array object and extracts the `messageMetadata` sub-key.
3. **`server.ts` A2A execution path** -- `buildA2AExecutionOptions()` validates metadata via `normalizeSdkMessageMetadata` before passing to the runtime executor.
4. **`chat.ts` REST endpoint** -- Accepts an optional `metadata` field in the request body, validates via `normalizeSdkMessageMetadata`, and forwards as `messageMetadata` in execution options.
5. **`sdk-handler.ts` WebSocket path** -- Preserves raw metadata from the `chat_message` frame and delegates validation to `handleChatMessage`.
6. **Studio docs** -- Updated `channels.mdx`, `conversation-api.mdx`, and `sdks.mdx` to document the metadata contract and the canonical `session.messageMetadata` access path.

No deviations from the original HLD architecture. The change is additive and does not alter existing data flows.

---

## 11. References

- Feature spec: `docs/features/a2a-integration.md`
- Test spec: `docs/testing/a2a-integration.md`
- Architecture: `docs/architecture/A2A_PROTOCOL_SUPPORT.md`
- Async execution: `docs/architecture/ASYNC_EXECUTION_ARCHITECTURE.md`
- RFC: `docs/rfcs/RFC-014-agent-transfer-a2a.md`
- A2A protocol: `https://google.github.io/A2A/`
- SDK: `@a2a-js/sdk` (npm)
