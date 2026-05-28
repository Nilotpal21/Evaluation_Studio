# HLD: Kore SmartAssist Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/kore-adapter.md`
**Test Spec**: `docs/testing/sub-features/kore-adapter.md`
**Parent HLD**: `docs/specs/agent-transfer.hld.md`
**Status**: DRAFT
**Author**: Platform Team
**Date**: 2026-03-30

---

## 1. Overview

Enhance the Kore SmartAssist adapter (`KoreAdapter`) to production quality within the ABL platform's agent transfer subsystem. The adapter is the primary CCaaS integration — it connects to Kore SmartAssist/AgentAssist APIs for AI-to-human escalation, supporting 8 API integrations, 22 XO event type mappings, lazy orgId resolution, HMAC webhook verification, bidirectional message relay, and two ABL tools for agent-controlled transfer routing.

This HLD covers:

1. The `KoreAdapter` implementing `AgentDesktopAdapter` with pre-checks, synthetic user creation, transfer initiation, message relay, and session management
2. The `SmartAssistClient` HTTP client with dual transport (undici Pool for SmartAssist, native fetch for KoreServer)
3. Webhook route with HMAC verification, XO event normalization, and tenant isolation
4. Lazy orgId resolution with DB persistence callback
5. ABL tools (`check-hours`, `set-queue`) for agent-controlled transfer routing
6. Singleton adapter risk mitigation (GAP-008)

---

## 2. Problem Statement

Enterprise customers using Kore.ai SmartAssist as their contact center platform need seamless AI-to-human escalation. The existing adapter implementation is functional (BETA) but has gaps: lazy orgId resolution lacks test coverage (FR-7), the singleton adapter architecture risks cross-tenant credential contamination (GAP-008), HMAC webhook verification is optional and untested in integration, and ABL tools lack integration test coverage. This HLD defines the architecture for closing these gaps and promoting the adapter from BETA to STABLE.

---

## 3. Alternatives Considered

### Option A: Enhanced Singleton with Per-Execution Config Snapshot (Current Pattern)

- **Description**: Keep the existing singleton `KoreAdapter` registered once per process. On each `execute()` call, the routing-executor calls `adapter.initialize(decryptedCredentials)` which replaces `this.smartAssistConfig` and creates a new `SmartAssistClient`. The `execute()` method captures a local reference to the config at invocation time to avoid mid-execution contamination.
- **Pros**: Minimal code change. Matches the current architecture. No new allocation per escalation. Five9 uses the same pattern.
- **Cons**: `initialize()` still mutates shared state — a concurrent `initialize()` from Tenant B replaces the `SmartAssistClient` used by Tenant A's in-flight `sendUserMessage()` or `endSession()`. The config snapshot only protects `execute()`, not subsequent per-session operations.
- **Effort**: S (config snapshot in execute, no structural change)

### Option B: Per-Execution Adapter Clone

- **Description**: Modify the adapter registry to return a **cloned adapter instance** per escalation. `AdapterRegistry.get('smartassist')` returns the template instance. `routing-executor.handleEscalate()` calls `adapter.clone()` which creates a new `KoreAdapter` with its own `SmartAssistClient`. The cloned instance is used for the entire escalation lifecycle (execute, sendUserMessage, endSession) and discarded after session end.
- **Pros**: Complete tenant isolation — no shared mutable state. Each escalation has its own client with its own credentials. Eliminates GAP-008 entirely. `sendUserMessage()` and `endSession()` use the correct credentials even under concurrent multi-tenant load.
- **Cons**: Object allocation per escalation (lightweight — SmartAssistClient + undici Pool). Requires routing-executor to pass the cloned adapter to the session for subsequent operations. Needs adapter interface change (`clone(): AgentDesktopAdapter`).
- **Effort**: M (clone method, routing-executor wiring, session→adapter association)

### Option C: Adapter-per-Connection Registry

- **Description**: Replace the singleton registry with a connection-keyed registry: `AdapterRegistry.get('smartassist', connectionId)`. Each connection gets its own adapter instance, created lazily on first escalation and cached. Connection credential updates trigger adapter re-initialization.
- **Pros**: Natural mapping between connections and adapters. Amortizes initialization cost across escalations for the same connection.
- **Cons**: Memory growth proportional to active connections. Cache invalidation complexity when credentials change. Requires refactoring `AdapterRegistry` from `Map<string, Adapter>` to `Map<string, Map<string, Adapter>>`. Cross-cutting change affecting Five9 adapter.
- **Effort**: L (registry redesign, cache management, Five9 adapter impact)

### Recommendation: Option A — Enhanced Singleton with Per-Execution Config Snapshot

**Rationale**: Option A is the pragmatic choice for this enhancement cycle. The singleton pattern is proven and shared with Five9. While Option B provides stronger isolation, the concurrent multi-tenant scenario (simultaneous escalations from different tenants hitting the same pod within a <5s window) is rare in current production traffic. Option A's config snapshot in `execute()` mitigates the most common case. GAP-008 is documented as a known risk with a path to Option B if traffic patterns change. Option C is over-engineered for 2 adapters.

---

## 4. Architecture

### 4.1 System Context Diagram

```
                      ┌──────────────────────────────────────┐
                      │             Studio UI                  │
                      │  Connections │ Agent Transfer Settings │
                      │  [SmartAssist Provider]                │
                      └──────────┬────────────────────────────┘
                                 │ CRUD API
                      ┌──────────▼────────────────────────────┐
                      │             ABL Runtime                 │
                      │                                        │
                      │  ┌────────────┐   ┌─────────────────┐ │
                      │  │  Webhook   │   │  Transfer Tool   │ │
                      │  │  Route     │   │  Executor        │ │
                      │  │ POST /:prov│   │ transfer_to_agent│ │
                      │  └─────┬──────┘   └───────┬──────────┘ │
                      │        │                   │            │
                      │  ┌─────▼───────────────────▼──────────┐│
                      │  │     Agent Transfer Boot Service     ││
                      │  │  AdapterRegistry │ SessionStore     ││
                      │  │  MessageBridge   │ TraceEmitter     ││
                      │  └──┬──────────┬───────────────────┬──┘│
                      │     │          │                   │   │
                      │  ┌──▼───┐  ┌───▼────┐        ┌────▼──┐│
                      │  │ Kore │  │ Five9  │        │Message││
                      │  │Adapt.│  │Adapter │        │Bridge ││
                      │  └──┬───┘  └───┬────┘        └───┬───┘│
                      └─────┼──────────┼─────────────────┼────┘
                            │          │                 │
                   ┌────────▼──┐ ┌─────▼──────┐  ┌──────▼──────┐
                   │SmartAssist│ │  Five9     │  │User Channels│
                   │ API       │ │  REST API  │  │WS│Slack│Voice│
                   └─────┬─────┘ └────────────┘  └─────────────┘
                         │
                   ┌─────▼─────┐
                   │KoreServer │
                   │   API     │
                   └───────────┘

                      ┌──────────────────────────────────────┐
                      │              Redis                     │
                      │  Sessions │ Provider Index │ Alias    │
                      │  Nonce Store │ Encryption             │
                      └──────────────────────────────────────┘
```

### 4.2 Component Diagram — Kore Adapter Internals

```
packages/agent-transfer/src/adapters/kore/
├── index.ts              ← KoreAdapter (AgentDesktopAdapter impl, 623 lines)
├── smartassist-client.ts ← SmartAssistClient (HTTP client, 665 lines)
├── event-handler.ts      ← KoreEventHandler (XO event mapping, 136 lines)
└── (types from config/schema.ts)

packages/agent-transfer/src/tools/
├── check-hours.ts        ← CheckHoursTool (ABL tool)
└── set-queue.ts          ← SetQueueTool (ABL tool)

Dependency graph:

  KoreAdapter
    ├── SmartAssistClient          (created in initialize(), handles all HTTP)
    ├── KoreEventHandler           (pure functions for event mapping)
    ├── TransferSessionStoreHandle (shared with Five9Adapter)
    ├── AgentMessageHandler[]      (callbacks wired by boot service)
    └── onOrgIdResolved callback   (wired by routing-executor)

  SmartAssistClient
    ├── undici.Pool               (50 connections, SmartAssist API calls)
    ├── native fetch()            (KoreServer API calls — different host)
    ├── CircuitBreaker            (wraps SmartAssist calls)
    ├── retry logic               (exponential backoff, non-retryable guard)
    └── SSRF guard                (assertAllowedUrlSync)

  CheckHoursTool / SetQueueTool
    └── SmartAssistClient          (injected via constructor)
```

### 4.3 Data Flow — Transfer Lifecycle

```
1. INITIATION (AI agent → SmartAssist)

   transfer_to_agent tool
          │
          ▼
   routing-executor.handleEscalate()
          │
          ├── Step 0: Decrypt ConnectorConnection credentials
          ├── Step 1: adapter.initialize({...creds})
          │      → Creates new SmartAssistClient with undici.Pool
          ├── Step 1b: adapter.setOnOrgIdResolved(callback)
          │      → callback re-encrypts credentials with orgId to DB
          │
          ▼
   KoreAdapter.execute(payload)
          │
          ├── Step 2: resolveOrgId()
          │      POST <koreHost>/api/1.1/internal/agentassist/accounts/getAccountIdByBotId
          │      { streamId: appId } → { orgId, accountId }
          │      → Sets this.smartAssistConfig.orgId (in-memory)
          │      → Fires onOrgIdResolved(orgId) → DB write-back
          │
          ├── Step 3: runPreChecks(payload)
          │      ├── checkBusinessHours(hoursId)  // botId from config
          │      │      POST /agentassist/api/v1/internal/flows/nodes/businessHours
          │      ├── checkAgentAvailability(payload)  // botId, orgId from config
          │      │      POST /agentassist/api/v1/internal/flows/nodes/agentsAvailability
          │      └── validateQueue(queueId)  // botId from config
          │             POST /agentassist/api/v1/internal/flows/nodes/queueAvailability
          │
          ├── Step 4: createSyntheticUser(appId, contactId)
          │      POST <koreHost>/api/1.1/internal/agentassist/user
          │      → userId (u-xxxx) or fallback to contactId
          │
          ├── Step 5: initTransfer(fullXoPayload)
          │      POST /agentassist/api/v1/conversations
          │      body: { orgId, userId, accountId, botId, source, language,
          │              metaInfo: { contact, history, abl: { webhookUrl } },
          │              queue, skills, skillsIds, automationBotId }
          │      → { conversationId }
          │
          └── Step 6: TransferSessionStore.create({
                provider: 'smartassist',
                providerSessionId: conversationId,
                providerData: { syntheticUserId, orgId, botId }
              })
              → Redis HASH + Provider Index + Alias Index (by koreOrgId)


2. USER → AGENT (message relay)

   User sends message (WebSocket or channel)
          │
          ▼
   RuntimeExecutor.executeMessage()
          │
          ├── Check: session.transferInitiated && session.isEscalated?
          │      If YES → intercept, skip bot processing:
          │
          ├── Resolve adapter from registry by provider name
          │
          └── KoreAdapter.sendUserMessage(sessionKey, message)
                 │
                 ├── SessionStore.get(sessionKey) → { conversationId, config }
                 │
                 ├── SmartAssistClient.sendEvent(conversationId, {
                 │      eventName: 'start_kore_agent_chat_message_for_agent',
                 │      body: message, attachments
                 │   })
                 │      POST /agentassist/api/v1/internal/events/handle/?sid=&cId=
                 │
                 └── SessionStore.extendTTL(sessionKey)


3. AGENT → USER (webhook)

   SmartAssist sends event
          │
          ▼
   POST /api/v1/agent-transfer/webhooks/smartassist
          │
          ├── HMAC verification (if webhookSecret configured)
          │      x-kore-signature + x-kore-timestamp + nonce replay check
          │
          ├── XO payload normalization
          │      Extract orgId from event.orgId || event.payload.orgId
          │      Extract eventName, conversationId from nested payload
          │
          ├── SessionStore.getByProvider('smartassist', orgId, conversationId)
          │      Try primary index (at_by_provider:smartassist:{tenantId}:{convId})
          │      Fallback: alias index (at_by_provider:smartassist:{koreOrgId}:{convId})
          │
          ├── Tenant validation
          │      event.orgId must match session.tenantId OR session.providerData.orgId
          │      Mismatch → 404
          │
          ├── KoreEventHandler.mapEventType(eventName)
          │      22 XO entries → 10 ABL AgentEventType values
          │
          └── KoreAdapter.handleInboundEvent(normalizedEvent, tenantId)
                    │
                    ├── Extend session TTL
                    ├── Check post-agent action (return vs end)
                    └── Fire onAgentMessage callbacks
                              │
                              ▼
                        MessageBridge.routeAgentEvent(ablKey, event)
                              │
                              ├── WebSocket (Studio debug)
                              ├── Channel Adapter (Slack, WhatsApp, etc.)
                              └── Voice Gateway


4. SESSION END

   adapter.endSession(sessionKey, reason)
          │
          ├── SmartAssistClient.sendEvent(conversationId, {
          │      eventName: 'close_conversation'
          │   })
          │      (best-effort — failure logged at WARN)
          │
          └── SessionStore.end(sessionKey)
                → Remove HASH + Provider Index + Alias Index + Active Set
```

### 4.4 Lazy OrgId Resolution — Sequence Diagram

```
routing-executor              KoreAdapter            SmartAssistClient         KoreServer API
      │                            │                        │                       │
      │  initialize(creds)         │                        │                       │
      │───────────────────────────>│                        │                       │
      │                            │ (no orgId in creds)    │                       │
      │  setOnOrgIdResolved(cb)    │                        │                       │
      │───────────────────────────>│                        │                       │
      │                            │                        │                       │
      │  execute(payload)          │                        │                       │
      │───────────────────────────>│                        │                       │
      │                            │  resolveOrgId()        │                       │
      │                            │                        │                       │
      │                            │  getAccountIdByBotId   │                       │
      │                            │  (appId)               │                       │
      │                            │───────────────────────>│                       │
      │                            │                        │  POST /accounts/      │
      │                            │                        │  getAccountIdByBotId   │
      │                            │                        │  { streamId: appId }   │
      │                            │                        │──────────────────────>│
      │                            │                        │                       │
      │                            │                        │  { orgId, accountId } │
      │                            │                        │<──────────────────────│
      │                            │                        │                       │
      │                            │  orgId + accountId     │                       │
      │                            │<───────────────────────│                       │
      │                            │                        │                       │
      │                            │ this.config.orgId=orgId│                       │
      │                            │                        │                       │
      │  onOrgIdResolved(orgId)    │                        │                       │
      │<───────────────────────────│                        │                       │
      │                            │                        │                       │
      │  re-encrypt creds + orgId  │                        │                       │
      │  → ConnectorConnection DB  │                        │                       │
      │                            │                        │                       │
      │                            │ (continue to prechecks)│                       │
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Kore webhook payloads include `orgId` in the event body. The webhook route validates that `event.orgId` matches EITHER the ABL `tenantId` (session key) OR the stored `providerData.orgId` (Kore org). Mismatch returns 404 (not 403, per platform invariant). Session lookup requires tenant context — the provider alias index keyed by Kore `orgId` enables lookup when Kore orgId differs from ABL tenantId. Connection credentials are project-scoped via `ConnectorConnection.projectId`. Redis session keys include `tenantId`.                            |
| 2   | **Data Access Pattern** | No new MongoDB collections. Connection credentials stored in existing `ConnectorConnection` with AES encryption via `encryptJsonForTenant`. Redis sessions use `TransferSessionStore` with atomic Lua scripts (CREATE, END, EXTEND_TTL, CLAIM, UPDATE). Provider index and alias index keys are created atomically with the session. `providerData` blob is encrypted via `TenantScopedSessionEncryptor` before Redis storage. No direct Mongoose model access from the adapter — all DB interaction goes through routing-executor callbacks (`onOrgIdResolved`). |
| 3   | **API Contract**        | **Inbound**: `POST /api/v1/agent-transfer/webhooks/smartassist` — shared route with `:provider` parameter. Response: `{ success: true }` or `{ success: false, error: { code, message } }`. Error codes: `INVALID_EVENT` (400), `HMAC_FAILED` (401), `SESSION_NOT_FOUND` (404), `PROCESSING_ERROR` (500), `NOT_INITIALIZED` (503). **Outbound**: 8 SmartAssist/KoreServer endpoints (see Section 7). No new REST endpoints — webhook is existing, session management uses existing routes.                                                                        |
| 4   | **Security Surface**    | (a) Connection credentials AES-encrypted at rest in MongoDB via `encryptionPlugin`. (b) `metadata` and `providerData` encrypted in Redis via `SessionFieldEncryptor`. (c) HMAC-SHA256 webhook verification with `x-kore-signature` + `x-kore-timestamp` headers when `webhookSecret` is configured. (d) Nonce replay detection via Redis-backed nonce store. (e) SSRF guard on all outbound URLs via `assertAllowedUrlSync`. (f) API keys passed in HTTP headers only, never logged. (g) Handler count limits (max 10) to prevent memory amplification.           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Transfer initiation failures return `TransferResult` with structured error codes: `ADAPTER_NOT_CONFIGURED`, `OUTSIDE_HOURS`, `NO_AGENTS`, `QUEUE_INVALID`, `KORE_USER_CREATION_FAILED` (non-fatal, falls back to contactId), `KORE_GET_ACCOUNT_ID_FAILED` (non-fatal, proceeds without orgId), `SMARTASSIST_ERROR` (server error after retries), `SMARTASSIST_CLIENT_ERROR` (4xx non-retryable). `sendUserMessage` failures throw to caller. `endSession` failures are best-effort (WARN log, local cleanup still occurs). Webhook errors: 400/401/404/500/503 as per API contract.                                                                                 |
| 6   | **Failure Modes** | (a) SmartAssist downtime: `execute()` fails after circuit breaker trips (5 failures, 30s reset). Routing-executor resets `session.isEscalated` and `session.transferInitiated`, bot resumes. (b) KoreServer downtime: `resolveOrgId` fails non-fatally, transfer proceeds with degraded webhook routing. `createSyntheticUser` fails non-fatally, falls back to contactId. (c) Redis unavailability: existing circuit breaker applies. (d) Lazy orgId failure + Kore orgId != ABL tenantId: webhook session lookup fails, agent→user messages lost. This is the highest-impact failure mode. (e) `initTransfer` is non-retryable (server-side idempotency unknown). |
| 7   | **Idempotency**   | Webhook processing is idempotent — reprocessing the same event extends session TTL and re-fires callbacks. Message delivery is idempotent (duplicate messages tolerable, better than dropped). Session creation uses Lua atomic guard — duplicate `execute()` for same contact+channel returns existing session. HMAC nonce replay detection rejects replayed webhooks (security, not idempotency).                                                                                                                                                                                                                                                                 |
| 8   | **Observability** | `createLogger('kore-adapter')` and `createLogger('smartassist-client')` for structured JSON logs with `tenantId`, `conversationId`, `provider` fields. Every API call logs path, status, response (truncated 500 chars). Sensitive data (keys, tokens, PII) never logged. Trace events emitted via `TraceEventEmitter` → `createTraceStoreAdapter()` → platform TraceStore. `debug_diagnose` MCP tool shows SmartAssist registration status.                                                                                                                                                                                                                        |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Transfer initiation: < 5s total (orgId resolution ~500ms + prechecks ~1.5s + synthetic user ~500ms + initTransfer ~500ms + Redis session ~5ms). Worst case with all 3 prechecks: ~3s API time. Connection pooling: undici Pool with 50 connections, 1 pipelining, 30s keep-alive. Request timeout: 5000ms with AbortController. Webhook processing: < 500ms (HMAC verification O(1) + session lookup ~5ms + event mapping O(1) + adapter dispatch). Concurrent sessions share existing 1,000 per tenant limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | **Migration Path**     | No migration needed. All enhancements are additive: new optional config fields (`koreHost`, `koreApiKey`, `ablWebhookBaseUrl`), new `providerData` fields in Redis sessions, new provider alias index keys. Existing sessions without new fields are handled gracefully (guards skip alias creation when `koreOrgId === tenantId`). Persisted orgId write-back is additive to `ConnectorConnection.encryptedCredentials`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Rollback Plan**      | Rollback = deploy previous runtime version. Kore is the primary adapter, so blast radius is higher than Five9: (a) Active sessions remain in Redis, expire via TTL (chat: 30min, email: 4hr). (b) Webhook events requiring enhanced XO normalization (nested `payload` extraction) will return 400 on old code — in-flight agent→user messages are **lost** for active sessions. SmartAssist conversations may need manual closure since endSession webhooks also fail. (c) Provider alias keys become orphaned (TTL cleanup). (d) Persisted orgId in ConnectorConnection is ignored by old code (uses `accountId` fallback). (e) No data corruption possible. (f) **Studio/runtime deployment independence**: If runtime rolls back while Studio retains the enhanced connection form, new connections may include fields (`koreHost`, `ablWebhookBaseUrl`) the old runtime ignores — graceful degradation, no error. **Prerequisite**: A backward compatibility E2E test (like Five9's E2E-6) must be PLANNED before STABLE promotion to validate old-code webhook handling. |
| 12  | **Test Strategy**      | 7 E2E scenarios (real Express, real Redis, SmartAssist mocked via DI constructor injection), 13 integration tests (service boundaries: SmartAssistClient↔mock HTTP, Adapter↔Redis, routing-executor↔adapter), 6 unit test groups (UT-1 through UT-6, ~30 individual cases covering event mapping, Zod schema, language mapping). E2E tests exercise full HTTP middleware chain including HMAC verification and tenant isolation. GAP-008 singleton isolation has a dedicated integration test (INT-13). See `docs/testing/sub-features/kore-adapter.md` for full test spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 6. Data Model

### New Collections/Tables

None. Kore adapter reuses existing infrastructure.

### Modified Collections/Tables

**ConnectorConnection** (existing MongoDB) — per-connection fields in `encryptedCredentials` JSON blob:

| Field           | Type   | Required | Source          | Description                                         |
| --------------- | ------ | -------- | --------------- | --------------------------------------------------- |
| `baseUrl`       | string | Yes      | Connection form | SmartAssist instance URL                            |
| `apiKey`        | string | No       | Connection form | SmartAssist API key (env var fallback)              |
| `appId`         | string | Yes      | Connection form | SmartAssist Bot/App ID                              |
| `orgId`         | string | No       | Auto-resolved   | Kore org ID (persisted by onOrgIdResolved callback) |
| `webhookSecret` | string | No       | Connection form | HMAC webhook verification secret                    |
| `koreHost`      | string | No       | Connection form | KoreServer host URL (defaults to baseUrl)           |
| `koreApiKey`    | string | No       | Connection form | KoreServer API key (defaults to apiKey)             |

**SmartAssistConfig** — environment-only config fields (NOT stored in ConnectorConnection):

| Field               | Type   | Env Var                | Description                                                                      |
| ------------------- | ------ | ---------------------- | -------------------------------------------------------------------------------- |
| `ablWebhookBaseUrl` | string | `ABL_WEBHOOK_BASE_URL` | ABL public URL for webhook embedding in metaInfo.abl                             |
| `initTransferPath`  | string | (hardcoded default)    | Custom path for initTransfer (default: /agentassist/api/v1/conversations)        |
| `eventHandlePath`   | string | (hardcoded default)    | Custom path for sendEvent (default: /agentassist/api/v1/internal/events/handle/) |

**Redis Session Hash** — existing `agent_transfer:{tenantId}:{contactId}:{channel}`:

| Top-Level Field     | Type   | Value for SmartAssist                  | Encrypted |
| ------------------- | ------ | -------------------------------------- | --------- |
| `provider`          | string | `'smartassist'`                        | No        |
| `providerSessionId` | string | SmartAssist `conversationId`           | No        |
| `state`             | string | pending/queued/active/post_agent/ended | No        |
| `metadata`          | JSON   | postAgentAction, sourceAgentId, etc.   | Yes       |
| `providerData`      | JSON   | See below                              | Yes       |

Kore-specific `providerData` fields:

| `providerData` Key | Type   | Description                          |
| ------------------ | ------ | ------------------------------------ |
| `syntheticUserId`  | string | KoreServer userId (u-xxxx format)    |
| `orgId`            | string | Kore organization ID (o-xxxx format) |
| `botId`            | string | SmartAssist Bot ID                   |

**Provider Index Keys**:

```
Primary:   at_by_provider:smartassist:{tenantId}:{conversationId} → session key
Alias:     at_by_provider:smartassist:{koreOrgId}:{conversationId} → session key
           (created only when koreOrgId !== tenantId)
```

TTL on all keys matches parent session hash (set atomically via Lua create script).

### Key Relationships

- `ConnectorConnection._id` referenced by `ProjectSettings.agentTransfer.defaultRouting.connectionId`
- Session `providerSessionId` maps to SmartAssist `conversationId`
- Session `providerData.syntheticUserId` maps to KoreServer `userId` (u-xxxx format)
- Session `providerData.orgId` maps to SmartAssist organization ID (o-xxxx format)
- Alias key enables webhook lookup when Kore orgId != ABL tenantId

---

## 7. API Design

### SmartAssist API Endpoints (Outbound)

| #   | Method | Path                                                                | Purpose                  | Auth     | Notes                     |
| --- | ------ | ------------------------------------------------------------------- | ------------------------ | -------- | ------------------------- |
| 1   | POST   | `/agentassist/api/v1/internal/flows/nodes/businessHours`            | Check business hours     | `apiKey` | Pre-check, optional       |
| 2   | POST   | `/agentassist/api/v1/internal/flows/nodes/agentsAvailability`       | Check agent availability | `apiKey` | Pre-check, when no queue  |
| 3   | POST   | `/agentassist/api/v1/internal/flows/nodes/queueAvailability`        | Validate queue           | `apiKey` | Pre-check, when queue set |
| 4   | POST   | `{initTransferPath}` (default: `/agentassist/api/v1/conversations`) | Initiate transfer        | `apiKey` | Non-retryable             |
| 5   | POST   | `{eventHandlePath}?sid={sid}&cId={cId}`                             | Send user events         | `apiKey` | Messages + control        |
| 6   | POST   | `/agentassist/api/v1/internal/flows/nodes/updateTransfer`           | Update transfer          | `apiKey` | Mid-conversation          |

### KoreServer API Endpoints (Outbound)

| #   | Method | Path                                                         | Purpose               | Auth                  | Notes                  |
| --- | ------ | ------------------------------------------------------------ | --------------------- | --------------------- | ---------------------- |
| 7   | POST   | `/api/1.1/internal/agentassist/accounts/getAccountIdByBotId` | Resolve orgId         | `koreApiKey`/`apiKey` | Lazy, cached in-memory |
| 8   | POST   | `/api/1.1/internal/agentassist/user`                         | Create synthetic user | `koreApiKey`/`apiKey` | Fallback to contactId  |

### Inbound Webhook Endpoint

**`POST /api/v1/agent-transfer/webhooks/smartassist`** (existing shared route via `:provider`)

Request body: XO event payload with `orgId`, `eventName`/`type`, `conversationId`, optional nested `payload`.

Processing pipeline:

1. HMAC verification (if `webhookSecret` configured)
2. XO payload normalization (extract from nested `payload` if present)
3. Session lookup via provider index (primary by tenantId, fallback by koreOrgId alias)
4. Tenant validation (event.orgId must match session context)
5. Event type mapping (22 XO → 10 ABL)
6. Adapter dispatch → MessageBridge → user channel

### Error Responses

| Code | Error Code          | When                                           |
| ---- | ------------------- | ---------------------------------------------- |
| 400  | `INVALID_EVENT`     | Missing `type`/`eventName` or `conversationId` |
| 401  | `HMAC_FAILED`       | Webhook signature verification failed          |
| 404  | `SESSION_NOT_FOUND` | Unknown session or tenant mismatch             |
| 404  | `UNKNOWN_PROVIDER`  | Provider not registered                        |
| 500  | `PROCESSING_ERROR`  | Adapter threw during processing                |
| 503  | `NOT_INITIALIZED`   | Agent transfer not bootstrapped                |

---

## 8. Tools Integration

### ABL Tools

Two ABL tools allow AI agents to control transfer routing before escalation:

**`check-hours`** — Checks SmartAssist business hours availability.

- **Input**: `{ hoursId: string }` (Zod-validated)
- **Output**: `{ isWithinHours: boolean, message: string }`
- **Integration**: Takes `SmartAssistClient` via constructor injection. Client obtained from boot service via `getSmartAssistClient()`.
- **Agent use case**: AI agent checks if support is available before attempting `transfer_to_agent`

**`set-queue`** — Validates and selects a SmartAssist queue for routing.

- **Input**: `{ queueId: string }` (Zod-validated)
- **Output**: `{ isValid: boolean, queueName: string }`
- **Integration**: Same `SmartAssistClient` injection. Calls `validateQueue()` on the client.
- **Agent use case**: AI agent selects appropriate queue based on conversation topic before escalation

Both tools require an active SmartAssist connection — they fail with `ADAPTER_NOT_CONFIGURED` if no connection is initialized.

---

## 9. Cross-Cutting Concerns

- **Operational Logging**: Transfer initiation, session events, and webhook processing logged via `createLogger('kore-adapter')` and `createLogger('smartassist-client')` with structured context (`tenantId`, `conversationId`, `provider`). Sensitive data (API keys, tokens) never logged. Request/response logging truncates to 500 chars.
- **Audit Trail**: Transfer lifecycle events (`agent_transfer_initiated`, `agent:connected`, `agent:disconnected`) emitted via `TraceEventEmitter` → `createTraceStoreAdapter()` → platform `TraceStore`. Separate from operational logging.
- **Rate Limiting**: Webhook endpoint reuses existing agent-transfer rate limiting. No SmartAssist-specific limits.
- **Caching**: OrgId cached in-memory on the adapter instance after first resolution. No Redis caching of API responses. No token caching (API key is long-lived).
- **Encryption**: (a) Connection credentials AES-encrypted in MongoDB via `encryptionPlugin`. (b) `providerData` blob encrypted in Redis via `TenantScopedSessionEncryptor`. (c) All SmartAssist/KoreServer API calls over HTTPS. (d) HMAC webhook verification with nonce replay detection.
- **SSRF Protection**: All outbound URLs validated via `assertAllowedUrlSync` — blocks internal IPs, localhost, private ranges.

---

## 10. Dependencies

### Upstream (this feature depends on)

| Dependency                        | Type     | Risk   | Notes                                                              |
| --------------------------------- | -------- | ------ | ------------------------------------------------------------------ |
| `AgentDesktopAdapter` interface   | Internal | Low    | Stable interface, no changes needed                                |
| `TransferSessionStore`            | Internal | Low    | Proven Redis store with Lua scripts, reused as-is                  |
| `TenantScopedSessionEncryptor`    | Internal | Low    | Existing encryption mechanism for providerData                     |
| `MessageBridge`                   | Internal | Low    | Channel-agnostic routing, no changes needed                        |
| `AdapterRegistry`                 | Internal | Low    | Simple Map-based registry, `register()` and `get()`                |
| `routing-executor.handleEscalate` | Internal | Medium | Wires orgId callback, manages session flags — complex integration  |
| SmartAssist Conversations API     | External | Medium | Primary transfer API, version stability unknown                    |
| KoreServer Internal API           | External | Medium | orgId resolution + synthetic user, internal API surface may change |
| `undici` (npm)                    | External | Low    | Node.js native HTTP client, stable                                 |
| `@agent-platform/circuit-breaker` | Internal | Low    | Wraps SmartAssist calls                                            |

### Downstream (depends on this feature)

| Consumer                           | Impact                                         |
| ---------------------------------- | ---------------------------------------------- |
| Projects configuring SmartAssist   | Primary adapter for AI-to-human escalation     |
| Five9 adapter                      | Shares session store, webhook route, types     |
| ABL tools (check-hours, set-queue) | Depend on SmartAssistClient from adapter       |
| Studio connections UI              | SmartAssist provider in agent-desktop-registry |

---

## 11. Open Questions & Decisions Needed

1. **Singleton isolation timeline**: When should GAP-008 (per-execution adapter clone, Option B) be prioritized? Current risk: concurrent multi-tenant escalations on same pod. Frequency: low in current traffic, but increases with scale.
2. **Webhook secret rotation**: Should the adapter support dual-secret verification during rotation (accept both old and new secrets in a transition window)?
3. **OrgId resolution failure handling**: Should the adapter block transfers when orgId resolution fails (strict mode), or proceed with degraded webhook routing (current lenient mode)?
4. **ABL tool discoverability**: Should `check-hours` and `set-queue` appear in the Studio tool catalog for visual wiring, or remain ABL DSL-only?
5. **Backward compatibility test**: Need a dedicated E2E test verifying old-code webhook handling (like Five9's E2E-6) for rollback confidence.

---

## 12. References

- Feature spec: `docs/features/sub-features/kore-adapter.md`
- Test spec: `docs/testing/sub-features/kore-adapter.md`
- Parent HLD: `docs/specs/agent-transfer.hld.md`
- Sibling HLD: `docs/specs/five9-adapter.hld.md`
- Enterprise docs: `docs/enterprise/ABL_AGENT_TRANSFER_REFERENCE.md`, `docs/enterprise/KORESERVER_AGENTASSIST_TRANSFER_FLOW.md`
- Plan docs: `docs/plans/2026-03-28-agentassist-abl-webhook-integration-plan.md`, `docs/plans/2026-03-29-agentassist-webhook-changes.md`
- Adapter interface: `packages/agent-transfer/src/adapters/interface.ts`
- Adapter implementation: `packages/agent-transfer/src/adapters/kore/index.ts`
- SmartAssist client: `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`
- Event handler: `packages/agent-transfer/src/adapters/kore/event-handler.ts`
- Config schema: `packages/agent-transfer/src/config/schema.ts`
- Webhook route: `apps/runtime/src/routes/agent-transfer-webhooks.ts`
- Boot service: `apps/runtime/src/services/agent-transfer/index.ts`
- Session store: `packages/agent-transfer/src/session/transfer-session-store.ts`
