# Feature: A2A Integration (Agent-to-Agent Protocol)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `integrations`, `observability`, `enterprise`
**Package(s)**: `@agent-platform/a2a`, `apps/runtime`, `@agent-platform/execution`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/a2a-integration.md](../testing/a2a-integration.md)
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

Multi-agent systems require a standardized, secure way for agents to discover and invoke each other across organizational and runtime boundaries. Without A2A integration, ABL agents cannot participate in the broader Google A2A ecosystem: external agents cannot discover or invoke deployed ABL agents through a standard protocol, and ABL agents cannot reliably call remote agents with session continuity, trace propagation, SSRF protection, or support for long-running async operations (push notifications, human-in-the-loop).

### Goal Statement

Make ABL agents first-class participants in the Google Agent-to-Agent (A2A) protocol ecosystem, both as inbound servers and outbound clients, while preserving tenant isolation, secure connection management, multi-turn session continuity, and platform-grade observability across sync, streaming, and async execution patterns.

### Summary

A2A Integration implements Google's Agent-to-Agent protocol (v0.3.0+) so platform agents can be discovered and invoked by remote agents (inbound) and can call external A2A agents during execution (outbound). The implementation is built on `@a2a-js/sdk` (v0.2.5+) and follows the platform's hexagonal architecture pattern.

**Inbound path**: Exposes each agent through a connection-scoped JSON-RPC endpoint with an auto-generated agent card, SSE streaming, multi-turn session continuity via `contextId` mapping, push-notification callbacks for long-running tasks, and optional per-connection Bearer-token authentication.

**Outbound path**: Supports agent discovery (`discoverAgent`), synchronous task dispatch (`sendTask`), streaming dispatch (`sendTaskStreaming`), async non-blocking dispatch with push notifications (`sendTaskAsync`), task polling (`pollTask`), and task cancellation (`cancelRemoteTask`) -- all with SSRF endpoint validation and trace propagation.

**Async execution**: When execution encounters an async boundary (remote agent with push notifications, async tool, human approval), it suspends -- persisting the continuation point to MongoDB and registering a callback in Redis. When the external system calls back, execution resumes on any pod, delivering the result to the original channel.

---

## 2. Scope

### Goals

- Expose deployed ABL agents as connection-scoped A2A endpoints with valid agent cards and full JSON-RPC handling (sync, streaming, cancel, get).
- Let platform agents discover and call remote A2A agents with SSRF protection, HMAC-authenticated callbacks, and trace propagation.
- Preserve multi-turn session continuity by mapping A2A `contextId` values to runtime session IDs through an atomic session resolver.
- Support async execution patterns: push notifications (inbound and outbound), human-input-required state, and suspension/resumption across pod restarts.
- Provide structured tracing for inbound calls, outbound calls, callback handling, and session resolution.

### Non-Goals (Out of Scope)

- User-scoped credential resolution for A2A -- credentials remain tenant-scoped.
- DSL-based A2A connection configuration -- connections are managed through channel connection CRUD, not the agent DSL.
- Full stream interruption / client-disconnect handling (partially implemented but not fully verified).
- Admin-level audit history or per-connection rate limiting for A2A endpoints.

---

## 3. User Stories

1. As a platform operator, I want to expose an agent through a standard A2A endpoint so that external agents can discover its capabilities and invoke it via JSON-RPC.
2. As an agent builder, I want my runtime agent to call remote A2A agents safely during execution so that I can compose cross-service workflows with SSRF protection and trace propagation.
3. As an engineer debugging multi-agent flows, I want inbound/outbound tracing, session continuity, and task history so that I can understand what happened across protocol boundaries.
4. As a platform operator, I want async A2A support (push notifications, human input required) so that long-running cross-agent operations do not block the caller or require polling.
5. As a security engineer, I want per-connection inbound Bearer authentication and HMAC-signed callbacks so that A2A endpoints are not open to unauthorized access.

---

## 4. Functional Requirements

1. **FR-1**: The system must expose inbound A2A endpoints per active channel connection, including JSON-RPC (`POST /a2a/:connectionId`), SSE streaming (`GET /a2a/:connectionId/sse`), and agent card discovery (`GET /a2a/:connectionId/.well-known/agent-card.json`).
2. **FR-2**: The system must auto-generate agent cards from connection configuration and project metadata, while supporting connection-level card overrides via `config.card`.
3. **FR-3**: The system must support sync (`sendTask`), streaming (`sendTaskStreaming`), async (`sendTaskAsync`), polling (`pollTask`), and cancel (`cancelRemoteTask`) flows for outbound A2A calls.
4. **FR-4**: The system must preserve multi-turn session continuity by mapping A2A `contextId` values to runtime session IDs through an atomic session resolver (`A2ASessionResolverPort`).
5. **FR-5**: The system must support per-connection inbound Bearer authentication with encrypted API-key storage, returning 401 for invalid or missing tokens when a key is configured.
6. **FR-6**: The system must validate outbound endpoints against SSRF rules via `EndpointValidator` before attempting any remote A2A call.
7. **FR-7**: The system must emit structured trace data for inbound calls, outbound calls, session resolution, and callback handling via `A2ATracingPort`.
8. **FR-8**: The system must handle A2A task state transitions correctly: `submitted -> working -> input-required -> completed/failed/canceled`, mapping platform suspension reasons (`human_approval`, `human_input`) to `input-required` and async operations to `working`.
9. **FR-9**: The system must support push notification callbacks (inbound at `POST /a2a/callbacks/:callbackId`) with atomic claim (idempotent), Bearer token verification, and BullMQ resume job enqueuing.
10. **FR-10**: The system must support content extraction from A2A message parts: TextPart (concatenated), DataPart (JSON serialized), and FilePart (attachment metadata).
11. **FR-11**: The system must support per-message metadata parity across all channels (A2A, REST chat, WebSocket SDK). Inbound A2A callers pass metadata under `message.metadata.messageMetadata`; the adapter extracts it without leaking reserved `history` metadata, validates it server-side, and forwards it to the runtime execution pipeline as `messageMetadata`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                       |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | A2A endpoints are provisioned through project-scoped channel connections.                   |
| Agent lifecycle            | PRIMARY      | Remote dispatch, multi-turn context continuity, and inbound execution affect agent behavior |
| Customer experience        | SECONDARY    | End users experience A2A indirectly through cross-agent workflows and responses.            |
| Integrations / channels    | PRIMARY      | A2A is itself a protocol channel and a remote-agent integration surface.                    |
| Observability / tracing    | PRIMARY      | Inbound/outbound tracing, callback tracing, and session logs are core operational outputs.  |
| Governance / controls      | SECONDARY    | Inbound auth, endpoint validation, and tenant scoping shape operational controls.           |
| Enterprise / compliance    | SECONDARY    | Multi-pod persistence, secure key storage, and SSRF protection matter for enterprise use.   |
| Admin / operator workflows | SECONDARY    | Operators manage connections; audit/rate-limit controls not yet implemented.                |

### Related Feature Integration Matrix

| Related Feature              | Relationship Type | Why It Matters                                                                    | Key Touchpoints                                                      | Current State                                  |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Channels                     | configured by     | A2A is provisioned and updated as a channel connection.                           | `channel_connections` collection, channel CRUD routes                | Implemented                                    |
| Multi-Agent Orchestration    | extends           | Remote handoffs and fan-out branches depend on outbound A2A calls.                | `RoutingExecutor`, `sendTask`, `sendTaskAsync`, `AgentCardCache`     | Implemented for orchestration-family use cases |
| Session Management           | shares data with  | A2A maps `contextId` to runtime sessions for continuity and recovery.             | `A2ASessionResolverPort`, `MemoryA2ASessionResolver`, Redis resolver | Implemented                                    |
| Async Execution Architecture | depends on        | Suspension/resumption engine provides callback registry, BullMQ resume, barriers. | `SuspendedExecution`, `RedisCallbackRegistry`, `ChannelDispatcher`   | Implemented                                    |
| Tracing & Observability      | emits into        | Inbound/outbound calls and callbacks must be visible in traces and logs.          | `A2ATracingPort`, structured logging                                 | Implemented                                    |

---

## 6. Design Considerations (Optional)

- A2A is connection-scoped rather than globally mounted per agent, keeping identity, auth, and card metadata tied to a specific deployment/configuration record.
- Runtime mounts synchronous protocol routes immediately via `LazyTaskStore`/`MemoryA2ASessionResolver`, then upgrades to Redis-backed implementations asynchronously when `wireAsyncInfra()` completes.
- The current implementation favors protocol correctness and compatibility over a bespoke platform UX; Studio acts as the CRUD/control-plane surface.
- Hexagonal architecture: domain ports (`A2ATracingPort`, `AgentExecutionPort`, `A2ASessionResolverPort`, `EndpointValidator`) define contracts; infrastructure adapters implement them; runtime wiring composes them.

---

## 7. Technical Considerations (Optional)

- `@a2a-js/sdk` v0.2.5+ provides `A2AExpressApp`, `DefaultRequestHandler`, `InMemoryTaskStore`, and client types. The SDK has known constraints: relative card URLs complicate `ClientFactory.createFromUrl()`, and `getTask` clears history unless `historyLength` is explicitly supplied.
- Runtime starts with `InMemoryTaskStore` wrapped in `LazyTaskStore` and upgrades to `RedisA2ATaskStore` after async infra wiring.
- Callback routing uses placeholder routers (503 "not ready") that are replaced in-place when Redis + BullMQ infrastructure becomes available.
- The authenticated outbound client factory (`createA2AClientWithAuth`) currently patches `globalThis.fetch` -- an open hardening concern.
- `sendTaskStreaming` is available but currently unused in the routing executor because the SDK's async generator hangs on cleanup; a sync+forward fallback (`sendTask` + `onChunk` forwarding) is used instead.
- The `AgentExecutorAdapter` implements suspension detection via `Promise.race` between the execution promise and a suspension promise that resolves when an `execution_suspended` trace event fires.

---

## 8. How to Consume

### Studio UI

A2A connections are managed through the Studio channel connection UI under Deployments > Channels:

1. Navigate to a project's Deployments area.
2. Select `Agent-to-Agent (A2A)` as the channel type.
3. Create a connection with a display name and any card overrides in `config.card`.
4. Copy the generated endpoint URL and optionally set an inbound API key.
5. Use the resulting connection as the external A2A entry point for the deployed agent.

### API (Runtime)

#### A2A Protocol Endpoints

| Method | Path                                             | Purpose                                                               |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| POST   | `/a2a/:connectionId`                             | JSON-RPC endpoint for `message/send`, `tasks/get`, and `tasks/cancel` |
| GET    | `/a2a/:connectionId/sse`                         | SSE endpoint for streaming message responses                          |
| GET    | `/a2a/:connectionId/.well-known/agent-card.json` | Agent card discovery                                                  |
| POST   | `/a2a/callbacks/:callbackId`                     | Push-notification callback intake                                     |

#### Per-Message Metadata (A2A and REST Chat)

Both the A2A inbound path and the REST chat endpoint (`POST /api/v1/chat/agent`) support per-message metadata. The metadata is validated server-side, available only for the current turn, and accessible via `session.messageMetadata` (canonical) and `message_metadata` (tool-context alias).

- **A2A inbound**: Send metadata under `message.metadata.messageMetadata` in the JSON-RPC `message/send` payload. The sibling key `message.metadata.history` is reserved for forwarded conversation history.
- **REST chat**: Send metadata in the `metadata` field of the `POST /api/v1/chat/agent` request body.
- **WebSocket SDK**: Send metadata in the `metadata` field of the `chat_message` WebSocket frame.

#### Unified Callback Endpoint

| Method | Path                            | Purpose                                                      |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/v1/callbacks/:callbackId` | Unified callback for async tools, approvals, remote handoffs |

#### Channel Connection Management

| Method | Path                                               | Purpose                          |
| ------ | -------------------------------------------------- | -------------------------------- |
| POST   | `/api/projects/:projectId/channel-connections`     | Create an A2A connection         |
| GET    | `/api/projects/:projectId/channel-connections`     | List project connections         |
| GET    | `/api/projects/:projectId/channel-connections/:id` | Read a specific connection       |
| PATCH  | `/api/projects/:projectId/channel-connections/:id` | Update connection or inbound key |
| DELETE | `/api/projects/:projectId/channel-connections/:id` | Deactivate the connection        |

### API (Studio)

| Method | Path                           | Purpose                   |
| ------ | ------------------------------ | ------------------------- |
| POST   | `/api/channel-connections`     | Create connection (proxy) |
| GET    | `/api/channel-connections`     | List connections (proxy)  |
| PATCH  | `/api/channel-connections/:id` | Update connection (proxy) |

### Admin Portal

No admin-only A2A management routes today. A2A remains a project-scoped operational feature managed through channel connection CRUD and runtime configuration.

### Channel / SDK / Voice / A2A / MCP Integration

A2A is both a channel type and an integration surface:

- Inbound A2A requests enter as channel traffic with `channelType: 'a2a'`.
- Outbound A2A calls are triggered from the `RoutingExecutor` during remote handoff/delegate/fan-out.
- SDK, voice, webhook, and other channels may appear in A2A-adjacent coordination flows, but A2A itself does not depend on those channels for core operation.

---

## 9. Data Model

### Collections / Tables

```text
Collection: channel_connections
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - channelType: 'a2a'
  - externalIdentifier: string
  - displayName: string | null
  - deploymentId: string | null
  - environment: string | null
  - encryptedCredentials: string | null
  - config.card?: { name?, description?, version?, skills?, defaultInputModes?, defaultOutputModes? }
  - config.encryptedA2aApiKey?: string
  - status: 'active' | 'inactive'
Indexes:
  - { channelType: 1, externalIdentifier: 1 } unique when active
  - { tenantId: 1, channelType: 1 }
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, deploymentId: 1 }
```

```text
Collection: suspended_executions (MongoDB)
Fields:
  - suspensionId: string
  - executionId: string
  - sessionId: string
  - tenantId: string (required)
  - projectId: string
  - reason: SuspensionReason (remote_handoff_result | tool_result | human_input | human_approval)
  - continuation: SuspendedContinuation
  - channelBinding: ChannelBinding
  - callbackId: string
  - callbackSecret: string (encrypted)
  - barrierId?: string
  - status: SuspensionStatus
  - expiresAt: Date
```

```text
Redis session and task keys:
Session resolver:
  a2a:session:{tenantId}:{contextId} -> sessionId
Task store:
  a2a:task:{taskId} -> JSON(Task)                    TTL: 24h (configurable)
Push config:
  a2a:push:{taskId} -> JSON(PushNotificationConfig)  TTL: 24h
Context-task index:
  a2a:ctx-tasks:{tenantId}:{contextId} -> ZSET(taskId, timestamp)  TTL: 24h
Callback registry:
  callback:{callbackId} -> JSON({suspensionId, sessionId, tenantId})
```

### Key Relationships

- `ChannelConnection` records provide the connection-scoped identity, card metadata, inbound auth configuration, and deployment binding for A2A.
- The session resolver maps A2A `contextId` values to runtime session IDs so A2A turns can continue an existing runtime conversation.
- Redis task records and callback configuration provide continuity for `getTask`, async resume, and push-notification flows.
- `SuspendedExecution` records in MongoDB persist the continuation point for long-running async A2A operations.
- `A2ARequestContext.messageMetadata` carries per-message turn-scoped metadata extracted from `message.metadata.messageMetadata` (A2A), the `metadata` request body field (REST chat), or the `metadata` frame field (WebSocket SDK). It is validated by `normalizeSdkMessageMetadata` and written to `session.messageMetadata` for the current turn only.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                   | Purpose                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `packages/a2a/src/domain/ports.ts`     | Execution, tracing, session, and endpoint-validation port contracts      |
| `packages/a2a/src/index.ts`            | Public package exports for all A2A use cases and infrastructure adapters |
| `packages/execution/src/suspension.ts` | SuspendedExecution type definitions for async operations                 |
| `packages/execution/src/types.ts`      | SuspensionReason, ChannelBinding, SuspendedContinuation types            |

### Routes / Handlers

| File                                                         | Purpose                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `packages/a2a/src/infrastructure/express-handlers.ts`        | Inbound A2A HTTP handler factory, SDK wiring, route setup                 |
| `packages/a2a/src/infrastructure/a2a-callback-handler.ts`    | Callback router for push-notification delivery (inbound)                  |
| `packages/a2a/src/infrastructure/agent-executor-adapter.ts`  | Bridges A2A SDK AgentExecutor to platform AgentExecutionPort (450 LOC)    |
| `apps/runtime/src/server.ts`                                 | Route mounting, async infra upgrade, callback wiring, runtime integration |
| `apps/runtime/src/routes/chat.ts`                            | REST chat endpoint with per-message metadata validation and forwarding    |
| `apps/runtime/src/routes/callbacks.ts`                       | Unified callback router for all async execution patterns                  |
| `apps/runtime/src/services/execution/routing-executor.ts`    | Outbound A2A calls during remote handoff/delegate/fan-out                 |
| `apps/runtime/src/services/identity/sdk-message-metadata.ts` | Per-message metadata normalization and validation shared across channels  |

### Application Use Cases

| File                                                         | Purpose                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `packages/a2a/src/application/send-task.ts`                  | Outbound sync task dispatch with SSRF validation and tracing  |
| `packages/a2a/src/application/send-task-async.ts`            | Outbound async dispatch with push notification configuration  |
| `packages/a2a/src/application/send-task-streaming.ts`        | Outbound SSE streaming via AsyncGenerator                     |
| `packages/a2a/src/application/discover-agent.ts`             | Remote agent card discovery with SSRF validation              |
| `packages/a2a/src/application/poll-task.ts`                  | Task status polling (fallback for push notification failures) |
| `packages/a2a/src/application/cancel-task.ts`                | Remote task cancellation                                      |
| `packages/a2a/src/application/push-notification-delivery.ts` | Outbound push notification delivery service                   |

### Infrastructure Adapters

| File                                                              | Purpose                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/a2a/src/infrastructure/redis-task-store.ts`             | Redis-backed A2A task persistence with ZSET context indexing |
| `packages/a2a/src/infrastructure/lazy-task-store.ts`              | Startup-safe task store proxy (InMemory -> Redis upgrade)    |
| `packages/a2a/src/infrastructure/traced-client.ts`                | SSRF validation + outbound trace instrumentation interceptor |
| `packages/a2a/src/infrastructure/agent-card-cache.ts`             | Agent card cache with TTL and max-size eviction              |
| `packages/a2a/src/infrastructure/client-factory.ts`               | A2A SDK client creation                                      |
| `packages/a2a/src/infrastructure/authenticated-client-factory.ts` | Authenticated A2A client with outbound auth config           |
| `packages/a2a/src/infrastructure/ssrf-interceptor.ts`             | SSRF endpoint validation adapter                             |

### UI Components

| File                                                                   | Purpose                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx` | Registers A2A as a protocol channel and describes setup |
| `apps/studio/src/components/deployments/channels/channel-icons.tsx`    | A2A icon                                                |
| `apps/studio/src/api/channel-connections.ts`                           | Studio client wrapper for connection CRUD               |

### Tests

| File                                                            | Type        | Coverage Focus                                   |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `packages/a2a/src/__tests__/agent-executor-adapter.test.ts`     | unit        | Adapter state transitions, suspension, streaming |
| `packages/a2a/src/__tests__/express-handlers.test.ts`           | unit        | Express handler factory, route setup             |
| `packages/a2a/src/__tests__/send-task.test.ts`                  | unit        | Outbound sync dispatch, error handling           |
| `packages/a2a/src/__tests__/send-task-async.test.ts`            | unit        | Async dispatch, SyncResponseForAsyncRequest      |
| `packages/a2a/src/__tests__/discover-agent.test.ts`             | unit        | Agent discovery, SSRF validation                 |
| `packages/a2a/src/__tests__/ssrf-interceptor.test.ts`           | unit        | SSRF endpoint validation                         |
| `packages/a2a/src/__tests__/traced-client.test.ts`              | unit        | Trace instrumentation                            |
| `packages/a2a/src/__tests__/ports.test.ts`                      | unit        | Port contract verification                       |
| `packages/a2a/src/__tests__/redis-task-store.test.ts`           | unit        | Redis task persistence and context indexing      |
| `packages/a2a/src/__tests__/lazy-task-store.test.ts`            | unit        | Lazy upgrade from InMemory to Redis              |
| `packages/a2a/src/__tests__/push-notification-delivery.test.ts` | unit        | Push notification delivery, SSRF, auth           |
| `packages/a2a/src/__tests__/streaming-integration.test.ts`      | integration | Streaming event flow                             |
| `packages/a2a/src/__tests__/outbound-capabilities.test.ts`      | unit        | Outbound streaming capabilities                  |

---

## 11. Configuration

### Environment Variables

| Variable                 | Default                               | Description                                                              |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------ |
| `CALLBACK_BASE_URL`      | `http://localhost:3112/a2a/callbacks` | Base URL for push notification callbacks (must be TLS in production)     |
| `DEFAULT_TENANT_ID`      | `system`                              | Tenant ID for A2A inbound requests                                       |
| `REDIS_URL` (via config) | --                                    | Enables Redis-backed session resolver, task store, and callback registry |

### Runtime Configuration

- Session resolver starts in memory with 24-hour TTL and upgrades to Redis when available.
- Task storage starts in memory through `LazyTaskStore` and upgrades to `RedisA2ATaskStore` on async infra wiring.
- Agent card caches use 5-minute TTLs with a max size of 100 entries.
- `RedisA2ATaskStore` default TTL is 86400 seconds (24 hours) for task, push config, and context-task index keys.

### DSL / Agent IR / Schema

A2A connections are not configured through the agent DSL. However, the IR schema supports remote agent locations with A2A protocol:

```typescript
interface RemoteAgentLocation {
  location: 'local' | 'remote';
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  auth?: { type: 'api_key' | 'bearer'; header?: string /* ... */ };
}
```

DSL integration for outbound A2A calls:

```
ROUTING
  HANDOFF payment_agent
    LOCATION REMOTE
    ENDPOINT "https://payment-agent.example.com"
    PROTOCOL A2A
    ASYNC true
    TIMEOUT 3600
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Connection CRUD is project-scoped (`projectId` in filter); inactive or missing connections do not leak details.    |
| Tenant isolation  | Session-resolver keys (`a2a:session:{tenantId}:{contextId}`), task state, and callback mappings are tenant-scoped. |
| User isolation    | A2A has no user-owned credential namespace today; tenant-scoped credentials are used where auth is required.       |

### Security & Compliance

- Inbound Bearer-token auth per connection with encrypted storage (`config.encryptedA2aApiKey`).
- Outbound SSRF endpoint validation via `SsrfEndpointValidator`/`assertUrlSafeForSSRF` before all remote calls.
- Callback routes verify Bearer tokens against encrypted callback secrets stored in `SuspendedExecution`.
- HMAC-SHA256 signature verification via `x-callback-signature` header on unified callback route.
- Callback claim is atomic (Redis GET+DEL) to prevent duplicate processing.
- Trace propagation uses W3C `traceparent` and `X-Trace-Id` headers.

### Performance & Scalability

- Agent card caches avoid repeated DB lookups and outbound discovery calls (5-min TTL, 100-entry max).
- `RedisA2ATaskStore.listByContext()` uses `MGET` for batch loading instead of N individual GETs.
- Streaming minimizes time-to-first-byte for long-running remote responses.
- Redis-backed session/task stores support multi-pod deployments.
- `LazyTaskStore` allows the protocol surface to mount before Redis is ready.

### Reliability & Failure Modes

- Startup uses in-memory implementations; protocol surface is available before Redis.
- If callback infrastructure is unavailable, async flows degrade (503 "not ready" from placeholder routers).
- SDK behavior forces sync+forward fallback for outbound streaming (generator cleanup hang).
- Callback re-registration on enqueue failure prevents message loss.
- Fan-out barrier uses atomic Redis Lua (HINCRBY) for exactly-once completion detection.

### Observability

- Structured logging captures tenant, connection, task, context, and session identifiers.
- Inbound, outbound, and callback flows emit trace data through `A2ATracingPort` (traceInbound/traceOutbound).
- Session resolution and race resolution are explicitly logged.
- Decision events emitted during remote handoff/delegate routing.

### Data Lifecycle

- Session, task, and callback state use bounded TTLs (default 24h) rather than indefinite retention.
- Pre-upgrade in-memory state is intentionally ephemeral during the startup window.
- `SuspendedExecution` records have explicit `expiresAt` deadlines; expired suspensions transition to `expired` status.

---

## 13. Delivery Plan / Work Breakdown

1. Protocol hardening
   1.1. Add E2E coverage for `tasks/cancel` with in-progress task cancellation.
   1.2. Add stream interruption and client-disconnect handling.
   1.3. Validate cross-tenant isolation with a second-tenant test environment.
   1.4. Verify FilePart (binary attachment) processing end-to-end.
2. Async reliability
   2.1. Verify session persistence across runtime restarts with Redis-backed infra.
   2.2. Expand async push-notification and polling-fallback verification.
   2.3. Test fan-out barrier behavior with mixed sync/async branches.
3. Operational hardening
   3.1. Replace the authenticated-client fetch patch with a safer auth-injection pattern.
   3.2. Evaluate user-scoped credentials for finer-grained A2A access control.
   3.3. Add per-connection rate limiting for inbound A2A endpoints.
4. Observability improvements
   4.1. Integrate A2A trace events with the Observatory span model.
   4.2. Add A2A-specific metrics (inbound/outbound call count, latency, error rate).

---

## 14. Success Metrics

| Metric                              | Baseline                                  | Target                        | How Measured                                      |
| ----------------------------------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------- |
| E2E test coverage for A2A flows     | 35 tests passing, 3 major gaps            | All gaps closed               | Automated test suite pass rate                    |
| Cross-tenant A2A isolation coverage | Not executed end-to-end                   | Executed and passing          | `cross-tenant-e2e.test.ts` or equivalent live run |
| Cancel-path verification            | Not tested end-to-end                     | Covered by automated tests    | Runtime/A2A test inventory                        |
| Session continuity confidence       | Covered for live multi-turn, not restarts | Restart persistence verified  | Redis-backed restart scenario                     |
| Outbound call reliability           | Sync fallback used for all streaming      | True streaming when SDK fixed | Feature flag toggle to sendTaskStreaming          |

---

## 15. Open Questions

1. Should A2A remain tenant-credential-scoped only, or should it support user-scoped credential resolution?
2. When the SDK generator issue is resolved, should streaming remote handoff paths switch back to true streaming everywhere?
3. Should A2A gain tenant-level admin controls such as audit history or per-connection rate limiting?
4. Should the authenticated client factory be refactored from `globalThis.fetch` patching to a request-scoped auth injection?
5. Should A2A callback URLs be configurable per connection rather than globally via `CALLBACK_BASE_URL`?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                       | Severity | Status               |
| ------- | --------------------------------------------------------------------------------- | -------- | -------------------- |
| GAP-001 | Cross-tenant data isolation is not yet tested with separate tenant credentials    | High     | Open                 |
| GAP-002 | `tasks/cancel` is not yet verified end-to-end                                     | Medium   | Open                 |
| GAP-003 | Session persistence across runtime restarts is not yet verified                   | Medium   | Open                 |
| GAP-004 | Stream interruption and client-disconnect handling remain incomplete              | Medium   | Open                 |
| GAP-005 | FilePart (binary attachment) processing is not yet verified                       | Low      | Open                 |
| GAP-006 | Dynamic `agentCardProvider` overrides are not exercised end-to-end                | Low      | Open                 |
| GAP-007 | User-scoped credentials are not supported; A2A remains tenant-credential-oriented | Low      | Open                 |
| GAP-008 | `ClientFactory.createFromUrl()` is constrained by relative card URLs              | Low      | Known SDK limitation |
| GAP-009 | `getTask` clears history unless `historyLength` is explicitly provided            | Low      | Known SDK behavior   |
| GAP-010 | The authenticated client factory currently patches `globalThis.fetch`             | Medium   | Open                 |
| GAP-011 | `sendTaskStreaming` unused due to SDK async generator cleanup hang                | Medium   | Known SDK limitation |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                     | Coverage Type     | Status     | Test File / Note                                              |
| --- | ------------------------------------------------------------ | ----------------- | ---------- | ------------------------------------------------------------- |
| 1   | Agent-card generation and overrides                          | e2e / integration | PASS       | `docs/testing/a2a-integration.md` -- 5 tests                  |
| 2   | Sync message lifecycle and `getTask`                         | e2e               | PASS       | `docs/testing/a2a-integration.md` -- 3 tests                  |
| 3   | Multi-turn session continuity and atomic first-turn handling | e2e / integration | PASS       | `docs/testing/a2a-integration.md` -- 3 tests + atomicity test |
| 4   | SSE streaming and mixed-mode multi-turn                      | e2e / integration | PASS       | `docs/testing/a2a-integration.md` -- 3 tests                  |
| 5   | Inbound Bearer auth                                          | e2e               | PASS       | `docs/testing/a2a-integration.md` -- 5 tests                  |
| 6   | Rich content (DataPart/mixed parts)                          | e2e               | PASS       | `docs/testing/a2a-integration.md` -- 4 tests                  |
| 7   | Memory and recall (task history)                             | e2e               | PASS       | `docs/testing/a2a-integration.md` -- 4 tests                  |
| 8   | Error handling                                               | e2e               | PASS       | `docs/testing/a2a-integration.md` -- 7 tests                  |
| 9   | Cross-tenant isolation                                       | e2e               | NOT TESTED | Existing file exists but was not executed                     |
| 10  | `tasks/cancel` and restart persistence                       | e2e               | NOT TESTED | Open gap                                                      |
| 11  | Per-message metadata parity (A2A, REST, WebSocket)           | unit              | PASS       | `agent-executor-adapter.test.ts`, `chat-routes.test.ts`       |

### Testing Notes

The current coverage is strong for live multi-turn behavior, streaming, structured-content handling, inbound auth, and session atomicity (35 E2E tests passing). Per-message metadata parity (FR-11) is covered by unit tests for the A2A adapter (metadata extraction without history leakage) and the REST chat route (metadata validation and forwarding). The remaining risk is concentrated in cross-tenant live verification, cancel-path behavior, restart persistence, and SDK-constrained async edge cases.

> Full testing details: [docs/testing/a2a-integration.md](../testing/a2a-integration.md)

---

## 18. References

- Architecture doc: `docs/architecture/A2A_PROTOCOL_SUPPORT.md`
- Async execution architecture: `docs/architecture/ASYNC_EXECUTION_ARCHITECTURE.md`
- RFC: `docs/rfcs/RFC-014-agent-transfer-a2a.md`
- Change manifests: `docs/specs/a2a-connection-card-integration.changes.md`, `docs/specs/a2a-sdk-migration-0.3.13.changes.md`, `docs/specs/a2a-session-resolver-tests.changes.md`, `docs/specs/a2a-task-lifecycle-integration.changes.md`, `docs/specs/a2a-tenant-isolation-tests.changes.md`
- A2A Protocol spec: `https://google.github.io/A2A/`
- SDK: `@a2a-js/sdk` v0.2.5+
