# High-Level Design: Agent Transfer

- **Feature ID:** F014
- **Feature Spec:** `docs/features/agent-transfer.md`
- **Test Spec:** `docs/testing/agent-transfer.md`
- **Status:** ALPHA
- **Created:** 2026-03-23
- **Last Updated:** 2026-04-14

---

## 1. Overview

The Agent Transfer subsystem enables seamless handoff of conversations from AI agents to human agents on external agent desktop platforms (Kore SmartAssist, and extensible to Salesforce, ServiceNow, etc.). It manages the complete transfer lifecycle across multiple channels (chat, voice, email, messaging) with enterprise-grade session management, security, observability, and reliability. The current implementation includes partial gaps around project-enforced TTLs and post-agent disposition metadata capture, which are being addressed by [Session Timeout & Disposition Unification](../features/sub-features/session-timeout-disposition-unification.md).

### 1.1 Design Goals

1. **Pluggable Adapters:** New agent desktop integrations are added by implementing the `AgentDesktopAdapter` interface without modifying core code.
2. **Channel-Agnostic Bridge:** The message bridge routes agent events to users regardless of their channel (WebSocket, Slack, WhatsApp, voice).
3. **Atomic Session Management:** Redis Lua scripts ensure session creation, update, and cleanup are race-condition-free.
4. **Encryption at Rest:** Sensitive session fields are encrypted per-tenant before Redis storage.
5. **Graceful Degradation:** Circuit breakers, fallback adapters, durable event queues, and dead-letter stores ensure no message loss.
6. **Zero Pod-Local State:** All session state lives in Redis. Any pod can serve any session.

---

## 2. Architecture

### 2.1 Component Diagram

```
                                 ┌────────────────────────────────┐
                                 │          Studio UI             │
                                 │  Settings │ Sessions │ Detail  │
                                 └──────┬──────────┬─────────────┘
                                        │          │
                              Studio API Proxy Routes
                                        │          │
          ┌─────────────────────────────▼──────────▼──────────────────┐
          │                     ABL Runtime                            │
          │                                                           │
          │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
          │  │ Webhook      │  │ Sessions     │  │ Settings        │ │
          │  │ Routes       │  │ Routes       │  │ Routes          │ │
          │  │ POST /:prov  │  │ GET / END    │  │ GET / PUT       │ │
          │  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘ │
          │         │                 │                    │          │
          │  ┌──────▼─────────────────▼────────────────────▼────────┐ │
          │  │              Agent Transfer Boot Service              │ │
          │  │  - SessionStore    - AdapterRegistry                  │ │
          │  │  - MessageBridge   - SessionRecovery                  │ │
          │  │  - TimeoutQueue    - DurableEventQueue                │ │
          │  │  - TraceEmitter    - KeyspaceSubscriber                │ │
          │  └──────┬──────────────────┬───────────────────┬────────┘ │
          │         │                  │                   │          │
          │  ┌──────▼──────┐    ┌──────▼──────┐     ┌─────▼───────┐ │
          │  │   Kore      │    │   Message   │     │  Transfer   │ │
          │  │   Adapter   │    │   Bridge    │     │  Tool       │ │
          │  │             │    │             │     │  Executor   │ │
          │  └──────┬──────┘    └──────┬──────┘     └─────┬───────┘ │
          └─────────┼──────────────────┼──────────────────┼──────────┘
                    │                  │                   │
          ┌─────────▼──────┐  ┌────────▼────────┐ ┌──────▼──────────┐
          │   SmartAssist  │  │  User Channels  │ │  DSL Execution  │
          │   API          │  │  WS│Slack│Voice │ │  Pipeline       │
          └────────────────┘  └─────────────────┘ └─────────────────┘

          ┌─────────────────────────────────────────────────────────┐
          │                    Redis                                 │
          │  - Session Hashes (agent_transfer:*)                    │
          │  - Provider Index (at_by_provider:*)                    │
          │  - Active Sessions Set (at_active_sessions)             │
          │  - Pod Sessions (at_pod:*)                              │
          │  - BullMQ Queues (timeout, events)                      │
          │  - Rate Limit Counters                                  │
          │  - Nonce Store (webhook replay)                          │
          └─────────────────────────────────────────────────────────┘
```

### 2.2 Package Decomposition

| Package                                 | Responsibility                                                                                      | Dependencies                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/agent-transfer`               | Core SDK: types, adapters, session store, tools, security, events, voice, post-agent, observability | `@abl/compiler`, `@agent-platform/circuit-breaker`, `@agent-platform/shared`, `ioredis`, `zod` |
| `apps/runtime` (agent-transfer service) | Boot, message bridge, timeout queue, event queue, webhook/session/settings routes                   | `@agent-platform/agent-transfer`, `@agent-platform/database`                                   |
| `apps/studio` (agent-transfer UI)       | Settings page, session list, session detail, API client                                             | Studio framework (`next-intl`, `swr`, `zustand`)                                               |

### 2.3 Key Interfaces

#### AgentDesktopAdapter

```typescript
interface AgentDesktopAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  initialize(config: ProviderConfig): Promise<void>;
  execute(payload: TransferPayload): Promise<TransferResult>;
  sendUserMessage(sessionId: string, message: UserMessage): Promise<void>;
  endSession(sessionId: string, reason: string): Promise<void>;
  onAgentMessage(handler: AgentMessageHandler): void;
  onSessionEvent(handler: SessionEventHandler): void;
  handleInboundEvent(event: XOEvent, tenantId: string): Promise<void>;
  checkHealth?(): Promise<boolean>;
  close?(): Promise<void>;
}
```

#### TransferSessionStore

```
create(input) -> CreateSessionResult     // Lua atomic
get(key) -> TransferSessionData | null
update(key, fields) -> boolean           // Lua atomic
end(key) -> boolean                      // Lua atomic (cleans all indexes)
extendTTL(key) -> void
getByProvider(provider, tenantId, providerSessionId) -> TransferSessionData | null
getActiveSessions(tenantId) -> string[]
```

---

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

- **Session Store:** Every Redis key includes `tenantId` in its path (`agent_transfer:{tenantId}:...`). Provider index includes `tenantId` (`at_by_provider:{provider}:{tenantId}:...`).
- **Webhook Routes:** Validate `event.orgId` matches `session.tenantId`. Return 404 on mismatch (not 403).
- **Session Routes:** Extract `tenantId` from authenticated context (`req.tenantContext.tenantId`). Double-check session's `tenantId` matches.
- **Settings Routes:** Scoped to `projectId + tenantId`.

### 3.2 Authentication and Authorization

- **Webhook Routes:** No user auth (machine-to-machine). HMAC signature verification with webhook secret + timestamp + nonce replay protection.
- **Session Routes:** `authMiddleware` + `requireProjectPermission('connection:read'/'connection:write')`.
- **Settings Routes:** Same auth chain as session routes.
- **Adapter Auth:** `KoreAdapter` uses `InternalKeyAuth` (API key). Other auth types supported: OAuth2, JWT, Basic, Bearer, OIDC, Session Header.

### 3.3 Data Model and Persistence

- **Primary Store:** Redis (ephemeral session data). Sessions auto-expire via store TTLs, but project settings are not yet the authoritative live source of those TTL values.
- **Persistent Config:** MongoDB via `ProjectSettings` model (agent transfer settings per project).
- **No MongoDB for sessions:** Sessions are inherently ephemeral (30min-24hr). Redis provides the required atomicity and speed.
- **Field-level Encryption:** `metadata` and `providerData` fields encrypted via `TenantScopedSessionEncryptor` before Redis HSET.
- **Post-agent metadata gap:** `dispositionCode` and `wrapUpNotes` fields exist in the store shape, but runtime does not yet wire a supported write path before end cleanup.

### 3.4 API Design

| Endpoint                                    | Method | Auth           | Purpose                 |
| ------------------------------------------- | ------ | -------------- | ----------------------- |
| `/api/v1/agent-transfer/webhooks/:provider` | POST   | HMAC signature | Receive provider events |
| `/api/v1/agent-transfer/sessions`           | GET    | Bearer + RBAC  | List active sessions    |
| `/api/v1/agent-transfer/sessions/:id/end`   | POST   | Bearer + RBAC  | End a session           |
| `/api/v1/agent-transfer/settings`           | GET    | Bearer + RBAC  | Get project settings    |
| `/api/v1/agent-transfer/settings`           | PUT    | Bearer + RBAC  | Update project settings |

All responses follow the envelope: `{ success: boolean, data?: T, error?: { code: string, message: string }, pagination?: { page, limit, total } }`.

Current gap: `POST /api/v1/agent-transfer/sessions/:id/end` ends the session without accepting structured reason or wrap-up metadata yet.

### 3.5 Error Handling

- **Structured Error Envelope:** All errors return `{ success: false, error: { code, message } }` with appropriate HTTP status.
- **Error Codes:** `NOT_INITIALIZED` (503), `UNKNOWN_PROVIDER` (404), `INVALID_SIGNATURE` (401), `MISSING_TENANT` (400), `SESSION_NOT_FOUND` (404), `RATE_LIMIT_EXCEEDED` (429), `PROCESSING_ERROR` (500).
- **Circuit Breaker:** SmartAssist HTTP calls wrapped in circuit breaker. Opens after configurable failure threshold. Half-open probes after cooldown.
- **Dead Letter:** Events that fail after BullMQ retries are stored in a Redis-backed dead-letter store for manual investigation.
- **Fallback Executor:** If primary adapter fails, `executeWithFallback()` tries registered fallback adapters in order.

### 3.6 Observability

- **Structured Logging:** `createLogger('agent-transfer')` using the platform logger (NOT pino-style). Contextual fields: `tenantId`, `sessionKey`, `provider`, `eventType`.
- **Trace Events:** `TraceEventEmitter` emits to platform `TraceStore`: `transfer:initiated`, `transfer:completed`, `transfer:failed`, `agent:connected`, `agent:disconnected`, `csat:completed`.
- **Metrics:** Transfer count, latency histograms, active session gauge, dead-letter depth (via `packages/agent-transfer/src/observability/metrics.ts`).
- **Log Redaction:** `REDACT_FIELDS` list ensures API keys, tokens, and PII are redacted from structured logs.

### 3.7 Performance

- **Lua Atomicity:** Session create/update/end use Lua scripts for single-round-trip atomic operations (~1ms).
- **Connection Reuse:** All components share the runtime's existing Redis client. No new connections created at boot.
- **Batch Operations:** `getActiveSessions()` uses SMEMBERS on the active set, then parallel HGETALL for each session.
- **TTL Management:** Channel-specific TTL defaults prevent session accumulation (chat: 30min, email: 24hr, voice: session-duration), but streamlining work is still required to make project settings authoritative in the live store path.
- **Rate Limiting:** Sliding window rate limiter (Redis INCR + EXPIRE) prevents transfer abuse.

### 3.8 Security

- **HMAC Webhook Verification:** `verifyWebhookSignature()` validates HMAC-SHA256 signature over raw body + timestamp. Configurable tolerance window (default 5 minutes).
- **Nonce Replay Protection:** Redis-backed nonce store prevents event replay attacks.
- **SSRF Guard:** `assertAllowedUrl()` validates adapter HTTP call targets against a blocklist of private IP ranges.
- **Session Field Encryption:** `TenantScopedSessionEncryptor` encrypts `metadata` and `providerData` using per-tenant keys from the platform encryption service.
- **Prototype Pollution Protection:** Settings PUT endpoint rejects `__proto__`, `constructor`, `prototype` keys.
- **Input Validation:** Zod schemas validate all config inputs. Session key components reject colons to prevent key injection.

### 3.9 Scalability

- **Stateless Pods:** Any pod can serve any transfer session (Redis is the source of truth). No pod affinity required.
- **Session Recovery:** Leader-elected recovery service redistributes orphaned sessions from crashed pods.
- **BullMQ Queues:** Durable event queue and timeout queue scale horizontally with worker concurrency.
- **10K WS Limit:** In-memory WebSocket map capped at 10,000 entries with TTL eviction and LRU force-eviction.

### 3.10 Extensibility

- **Adapter Pattern:** New agent desktops (Salesforce, ServiceNow, Genesys) implement `AgentDesktopAdapter` and register via `AdapterRegistry.register()`.
- **Auth Strategies:** 7 auth strategies (Internal Key, OAuth2, JWT, Basic, Bearer, OIDC, Session Header) cover all common provider auth patterns.
- **History Strategies:** `getHistoryStrategy()` returns provider-specific formatters. New providers add their own strategy.
- **Voice Gateways:** `VoiceGatewayRegistry` abstracts voice provider lookup. KoreVG is the current implementation; AudioCodes and Jambonz are registry-ready.
- **Config Reloader:** `AgentTransferConfigReloader` enables runtime config changes via Redis pub/sub without restarts.

### 3.11 Compliance

- **Data Minimization:** Sessions auto-expire via Redis TTL, but authoritative TTL policy still needs to converge with project settings and post-agent lifecycle semantics.
- **Encryption at Rest:** Sensitive session fields encrypted using platform encryption service with tenant-scoped keys.
- **Right to Erasure:** Session `end()` atomically removes all Redis keys (session hash, provider index, pod set membership, active set membership).
- **Audit Trail:** All transfer lifecycle events emitted to TraceStore for audit logging.
- **PII Handling:** Studio settings allow configuring PII de-tokenization before transfer. Log redaction strips sensitive fields.

### 3.12 Migration and Backward Compatibility

- **XO Event Normalization:** `KoreEventHandler.mapEventType()` translates XO-format event types (`agent_message`) to ABL format (`agent:message`).
- **Legacy URL Support:** Config loader accepts both `SMARTASSIST_API_URL` (canonical) and `SMARTASSIST_URL` (legacy alias).
- **Backward Compat Tests:** `integration/backward-compat.test.ts` validates existing behavior is preserved.
- **Feature Flag:** `AGENT_TRANSFER_ENABLED=true` env var controls subsystem boot. Disabled by default for zero-impact deployment.

---

## 4. Data Flow Diagrams

### 4.1 Transfer Initiation Flow

```
AI Agent (DSL ESCALATE)
    │
    ▼
TransferToolExecutor.execute('transfer_to_agent', payload)
    │
    ├── Rate limit check (Redis INCR + EXPIRE)
    │
    ▼
TransferToAgentTool.execute(payload, context)
    │
    ├── Validate required fields (tenantId, projectId, channel, contactId)
    ├── Format conversation history (KoreHistoryStrategy)
    │
    ▼
KoreAdapter.execute(transferPayload)
    │
    ├── Create session in Redis (Lua atomic: session hash + provider index + pod set + active set)
    ├── POST to SmartAssist API (circuit breaker wrapped)
    │
    ▼
TransferResult { success, status, sessionId, providerSessionId, estimatedWaitTime }
```

### 4.2 Inbound Webhook Flow

```
SmartAssist Agent Desktop
    │
    ▼
POST /api/v1/agent-transfer/webhooks/kore
    │
    ├── Verify HMAC signature + nonce
    ├── Validate event format (type, conversationId, orgId)
    ├── Lookup session by provider index
    ├── Validate tenant isolation (orgId == session.tenantId)
    │
    ▼
KoreAdapter.handleInboundEvent(event, tenantId)
    │
    ├── Normalize event type (agent_message -> agent:message)
    ├── Extend session TTL
    ├── Fire onAgentMessage callbacks
    │
    ▼
AgentTransferMessageBridge.routeAgentEvent(sessionKey, event)
    │
    ├── WebSocket delivery (if Studio client connected)
    ├── Channel adapter delivery (if chat/messaging with connectionId)
    ├── Voice gateway delivery (if voice channel)
    │
    ▼
User receives agent message
```

### 4.3 Session Recovery Flow

```
Pod-A crashes (no heartbeat renewal)
    │
    ▼
SessionRecoveryService (on Pod-B, leader-elected)
    │
    ├── Acquire leader lock (Redis SET NX PX)
    ├── Scan pod heartbeat keys
    ├── Detect stale pods (heartbeat older than threshold)
    ├── For each stale pod's sessions:
    │   ├── Claim session (Lua atomic: update ownerPod + heartbeat)
    │   └── Notify adapter for session reconnection
    │
    ▼
Sessions now owned by healthy pod
```

---

## 5. Alternatives Considered

### 5.1 MongoDB vs Redis for Session Store

**Chose Redis.** Sessions are ephemeral (30min-24hr TTL), require sub-millisecond atomic operations (Lua scripts), and benefit from built-in TTL expiry. MongoDB would add unnecessary persistence overhead and lack native TTL precision.

### 5.2 RabbitMQ vs BullMQ for Durable Events

**Chose BullMQ.** The runtime already uses Redis heavily. Adding RabbitMQ would introduce infrastructure complexity. BullMQ provides exactly-once delivery semantics, dead-letter queues, and retry policies on the existing Redis infrastructure.

### 5.3 In-Process Callbacks vs Message Bridge

**Chose Message Bridge.** The bridge decouples the adapter layer from channel delivery. In-process callbacks would tightly couple KoreAdapter to WebSocket/channel/voice delivery, making it impossible to add new delivery mechanisms without modifying the adapter.

### 5.4 Per-Adapter Encryption vs Centralized Encryption

**Chose Centralized.** The `TenantScopedSessionEncryptor` uses the platform encryption service with per-tenant keys. Per-adapter encryption would duplicate key management and risk inconsistent encryption across adapters.

---

## 6. Risk Assessment

| Risk                                    | Likelihood | Impact   | Mitigation                                                                      |
| --------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------------- |
| SmartAssist API outage during transfer  | Medium     | High     | Circuit breaker + fallback adapter + durable event queue                        |
| Redis failure loses all active sessions | Low        | Critical | Redis Sentinel/Cluster for HA; sessions are recoverable from provider side      |
| Webhook signature verification bypassed | Low        | Critical | HMAC + timestamp + nonce replay protection; secret rotation via config reloader |
| Pod crash loses in-flight messages      | Medium     | Medium   | Session recovery service + BullMQ durable queue + dead-letter store             |
| WebSocket map memory exhaustion         | Low        | Medium   | 10K cap + TTL eviction + LRU force-eviction                                     |
| Cross-tenant session access             | Very Low   | Critical | Tenant ID in all Redis keys + query-level validation + 404 on mismatch          |

---

## 7. Open Questions

| ID    | Question                                                                                  | Status  | Decision                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| OQ-01 | Should we support concurrent transfers to multiple providers for the same contact?        | DECIDED | No. Single active transfer per contact+channel. Multi-provider can be added later.                         |
| OQ-02 | What happens when encryption service is unavailable at boot?                              | DECIDED | Boot proceeds with `NullSessionEncryptor` (no encryption). Logged as warning.                              |
| OQ-03 | Should session recovery be enabled by default?                                            | DECIDED | Yes. Leader election ensures only one pod runs recovery. Cost is one heartbeat per pod per 30s.            |
| OQ-04 | How to handle Redis `CONFIG SET` restriction in managed Redis for keyspace notifications? | DECIDED | Graceful degradation: if CONFIG SET fails, `at_active_sessions` may grow but recovery service still works. |

---

## 8. Post-Implementation Notes (2026-04-14)

Two ABLP-142 commits extended the agent transfer subsystem beyond the original HLD scope:

### 8.1 Voice Transfer Runtime Flow

The voice transfer path was ported into the `packages/agent-transfer` package:

- `KorevgSession` in the runtime now integrates with the voice gateway interface for `dialAgent()`/`endAgentCall()` capabilities
- `KoreEventHandler` expanded to 25+ XO event type mappings (including `call_status_notifications`, `wait_time_voice_message_for_user`, `assign_kore_agent_for_user`)
- `SmartAssistClient` gained configurable paths, `sendEvent`, non-retryable `initTransfer`, and improved error handling
- The message bridge now routes voice channel events through the voice gateway TTS path

### 8.2 Connection-Backed Agent Desktop Flow

A new flow was added where agent desktop adapters are resolved via the platform's connection/auth-profile system rather than static environment config:

- `AgentDesktopConnectionDialog` in Studio lets admins create connections for SmartAssist, Five9, and other agent desktop providers
- `agent-desktop-connection-utils.ts` builds the correct auth profile and connection config per provider
- `routing-executor.ts` now resolves agent desktop adapters via connection lookup, enabling per-project adapter configuration
- `connector-connection.model.ts` and `connection-service.ts` gained agent desktop connection support

### 8.3 Deviations from Original Plan

- The original HLD assumed all adapter configuration via environment variables. The connection-backed flow adds a second resolution path via the database, which is more flexible but adds complexity.
- Voice gateway integration was mentioned in the HLD but not detailed. The implementation adds concrete `VoiceGatewaySession` interface methods beyond the original abstract description.
