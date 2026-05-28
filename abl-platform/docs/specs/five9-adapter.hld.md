# HLD: Five9 Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/five9-adapter.md`
**Test Spec**: `docs/testing/sub-features/five9-adapter.md`
**Parent HLD**: `docs/specs/agent-transfer.hld.md`
**Status**: APPROVED
**Author**: Platform Team
**Date**: 2026-03-24

---

## 1. Overview

Add Five9 as a second CCaaS provider to the ABL platform's agent transfer subsystem, enabling enterprise customers on Five9's Virtual Contact Center to receive AI-to-human escalations. The goal is to ship a production-ready `Five9Adapter` following the proven KoreAdapter architecture, with no changes to existing data models or new API endpoints.

---

## 2. Problem Statement

The ABL platform's agent transfer subsystem only has a production adapter for Kore SmartAssist. Enterprise customers using Five9 — a major CCaaS provider — cannot transfer AI conversations to human agents on Five9's Virtual Contact Center. This blocks go-live for any customer whose contact center runs on Five9.

Additionally, the Agent Transfer settings page lacks inline connection editing — users must navigate away to modify credentials or configuration, creating unnecessary friction for all providers.

This HLD covers:

1. A `Five9Adapter` implementing `AgentDesktopAdapter` for core escalation (create conversation, relay messages, end session)
2. Webhook route enhancement for Five9 payload normalization
3. A cross-provider `EditConnectionDialog` for inline connection editing in Studio

---

## 3. Alternatives Considered

### Option A: Standalone Five9Adapter (KoreAdapter Pattern)

- **Description**: Implement `Five9Adapter` as a parallel adapter following the exact same architecture as `KoreAdapter`: dedicated client class, event handler, Zod schema, registered in the same `AdapterRegistry`, sharing the same `TransferSessionStore`, `MessageBridge`, and webhook route.
- **Pros**: Proven pattern, no new infrastructure, minimal blast radius, clear separation of concerns, reuses all existing session/bridge/encryption infrastructure
- **Cons**: Five9-specific quirks (no `orgId` in webhook payload, per-conversation auth) require webhook route modification — not purely additive
- **Effort**: M (5 new files, 2 modified files in runtime, 2 new/modified in Studio)

### Option B: Abstract Base Adapter

- **Description**: Extract common adapter logic from `KoreAdapter` into an `AbstractAgentDesktopAdapter` base class, then implement `Five9Adapter` and refactored `KoreAdapter` as subclasses.
- **Pros**: DRY for session store wiring, event handler dispatch, TTL extension logic
- **Cons**: Premature abstraction with only 2 adapters. Kore and Five9 have different auth models, event formats, and transport quirks. The "shared" logic is small (~30 lines of wiring) vs the "different" logic (everything else). Refactoring KoreAdapter risks regressions in production code.
- **Effort**: L (requires KoreAdapter refactor + Five9 implementation + regression testing)

### Option C: Five9 as a Separate Microservice Behind a Queue

- **Description**: Deploy Five9 integration as an independent microservice that communicates with the runtime via a Redis message queue. The microservice handles all Five9 API calls, auth flows, and session management independently, with the runtime treating it as a black-box provider.
- **Pros**: Complete isolation from runtime. Independent scaling and deployment. Failures in Five9 integration cannot affect Kore or runtime stability.
- **Cons**: Massive infrastructure overhead for a single adapter. Introduces message queue latency (50-100ms per hop) into a time-sensitive transfer flow. Duplicates session management logic (the microservice would need its own session store or cross-service Redis coordination). Operational complexity: new deployment target, new monitoring, new CI pipeline. For v1 with a single Five9 provider, this is over-engineering by an order of magnitude.
- **Effort**: XL (new service, queue infrastructure, deployment pipeline, monitoring)

### Recommendation: Option A — Standalone Five9Adapter

**Rationale**: The KoreAdapter pattern is proven and well-tested (32 unit tests, 4 integration, 1 E2E). Five9's auth model and webhook payload format are different enough from Kore to warrant a dedicated adapter, but the infrastructure (session store, message bridge, webhook route, encryption) is identical. Option B's abstraction is premature — wait until a third adapter is needed. Option C cannot handle Five9's multi-step auth flow.

---

## 4. Architecture

### 4.1 System Context Diagram

```
                      ┌──────────────────────────────────────┐
                      │             Studio UI                  │
                      │  Connections │ Agent Transfer Settings │
                      │  [Five9 Provider] [EditConnectionDialog]│
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
                   │   API     │ │  REST API  │  │WS│Slack│Voice│
                   └───────────┘ └────────────┘  └─────────────┘

                      ┌──────────────────────────────────────┐
                      │              Redis                     │
                      │  Sessions │ Provider Index │ Encryption│
                      └──────────────────────────────────────┘
```

### 4.2 Component Diagram — Five9 Adapter Internals

```
packages/agent-transfer/src/adapters/five9/
├── index.ts              ← Five9Adapter (AgentDesktopAdapter impl)
├── five9-client.ts       ← Five9Client (REST API: auth, conversations, messages)
├── five9-event-handler.ts← Five9EventHandler (event type mapping)
└── types.ts              ← Five9Credentials, Five9AuthResult, Five9WebhookPayload

Dependency graph:

  Five9Adapter
    ├── Five9Client          (injected, handles HTTP to Five9)
    ├── Five9EventHandler    (pure functions for event mapping)
    ├── TransferSessionStoreHandle  (shared with KoreAdapter)
    └── AgentMessageHandler[]  (callbacks wired by boot service)

  Five9Client
    ├── native fetch()       (no SDK, no npm dependency)
    └── SSRF guard           (existing assertAllowedUrl)
```

### 4.3 Data Flow — Transfer Lifecycle

```
1. INITIATION (AI agent → Five9)

   transfer_to_agent tool
          │
          ▼
   TransferToolExecutor
          │ resolve adapter by provider name
          ▼
   Five9Adapter.execute(payload)
          │
          ├── Step 1: Five9Client.authenticate(tenantName, authMode)
          │      POST /appsvcs/rs/svc/auth/anon?cookieless=true
          │      → { tokenId, orgId, farmId, targetHost }
          │
          ├── Step 2: Five9Client.discoverMetadata(authHost, token)
          │      GET /appsvcs/rs/svc/auth/metadata
          │      → { orgId, farmId, targetHost } (active datacenter)
          │
          ├── Step 3: Five9Client.checkAgentAvailability(authHost, tokenId, [campaign])
          │      GET /appsvcs/rs/svc/agents/{tokenId}/logged_in_profiles?profiles=...
          │      → [{ agentLoggedIn, profileName, openForBusiness }]
          │      If 435 → handleServiceMigrated() → retry on new host
          │      If no agents logged in → return { success: false, FIVE9_NO_AGENTS_AVAILABLE }
          │      If check fails → non-fatal, proceed to Step 4
          │
          ├── Step 4: Five9Client.createConversation(metadataHost, ...)
          │      POST /appsvcs/rs/svc/conversations
          │      body: { campaignName, callbackUrl, contactInfo, attributes }
          │      If 435 → handleServiceMigrated() → retry on new host
          │      → { conversationId }
          │
          └── Step 5: TransferSessionStore.create({
                provider: 'five9',
                providerSessionId: conversationId,
                providerData: { token, targetHost, farmId, orgId }
                // providerData blob encrypted by SessionFieldEncryptor
              })
              → Redis HASH + Provider Index


2. USER → AGENT (message relay)

   User sends message
          │
          ▼
   RuntimeExecutor.executeMessage()
          │
          ├── Check: session.transferInitiated && session.isEscalated?
          │      If YES → intercept message, skip bot processing:
          │
          ├── Lookup transfer session in Redis by sessionKey
          │
          ├── Resolve adapter from registry by provider name
          │
          └── Five9Adapter.sendUserMessage(sessionKey, message)
                 │
                 ├── SessionStore.get(sessionKey) → { conversationId, token, targetHost }
                 │
                 ├── Five9Client.sendMessage(targetHost, conversationId, token, content)
                 │      POST /appsvcs/rs/svc/conversations/{id}/messages
                 │      If 435 → handleServiceMigrated() → retry on new host
                 │      If 401/403 → re-authenticate → retry once
                 │
                 └── SessionStore.extendTTL(sessionKey)


3. AGENT → USER (webhook)

   Five9 sends event
          │
          ▼
   POST /api/v1/agent-transfer/webhooks/five9?tid={tenantId}
          │
          ├── [NEW] Extract tid from query string, inject as orgId
          ├── Validate type + conversationId present
          ├── SessionStore.getByProvider('five9', tid, conversationId)
          ├── Validate session.tenantId === tid (else 404)
          ├── [NEW] Five9EventHandler.mapEventType(event.type)
          │
          └── Five9Adapter.handleInboundEvent(normalizedEvent, tenantId)
                    │
                    ├── Extend session TTL
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
          ├── Five9Client.endConversation(targetHost, conversationId, token)
          │      DELETE /appsvcs/rs/svc/conversations/{id}
          │      (best-effort — failure logged at WARN, not thrown)
          │
          └── SessionStore.end(sessionKey)
                → Remove HASH + Provider Index + Active Set
```

### 4.4 Webhook Route Enhancement — Sequence Diagram

```
Five9 Server                    Webhook Route                    Five9Adapter
     │                               │                               │
     │  POST /webhooks/five9?tid=T1  │                               │
     │  { type, conversationId, ... }│                               │
     │──────────────────────────────>│                               │
     │                               │                               │
     │                    [NEW] if provider === 'five9':              │
     │                      tid = req.query.tid                      │
     │                      event.orgId = tid                        │
     │                               │                               │
     │                    Validate: type + conversationId             │
     │                    Validate: orgId (now set from tid)          │
     │                               │                               │
     │                    SessionStore.getByProvider                  │
     │                    ('five9', tid, conversationId)              │
     │                               │                               │
     │                    Validate: session.tenantId === tid          │
     │                               │                               │
     │                    [NEW] if provider === 'five9':              │
     │                      Five9EventHandler.mapEventType()         │
     │                    else:                                       │
     │                      KoreEventHandler.mapEventType()          │
     │                               │                               │
     │                               │  handleInboundEvent(event, T1)│
     │                               │──────────────────────────────>│
     │                               │                               │
     │            200 OK             │             (fire callbacks)   │
     │<──────────────────────────────│                               │
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Five9 webhook payloads lack `orgId`. Tenant is resolved via `?tid=<tenantId>` in the callback URL. The webhook route validates `tid` matches the session's `tenantId` — mismatch returns 404 (not 403, per platform invariant). Session lookup requires BOTH `tenantId` AND `conversationId`. Provider reverse index key includes `tenantId`: `at_by_provider:five9:{tenantId}:{conversationId}`.                                                                                                                                                     |
| 2   | **Data Access Pattern** | No new data models. Five9 reuses the existing Redis `TransferSessionStore` with Lua-atomic operations for create/end/extend. Five9 adds metadata fields (`token`, `targetHost`, `farmId`, `orgId`) to the session hash. The `token` field is encrypted via `TenantScopedSessionEncryptor` using the existing `SessionFieldEncryptor` mechanism. No MongoDB changes.                                                                                                                                                                                   |
| 3   | **API Contract**        | No new endpoints. The existing `POST /api/v1/agent-transfer/webhooks/:provider` route handles Five9 via the `:provider` parameter with provider-aware pre-processing. The response envelope follows the existing pattern: `{ success: true }` or `{ success: false, error: { code, message } }`. Error codes: `INVALID_EVENT` (400), `MISSING_TENANT` (400), `SESSION_NOT_FOUND` (404), `PROCESSING_ERROR` (500).                                                                                                                                     |
| 4   | **Security Surface**    | (a) Five9 connection credentials encrypted in MongoDB via `encryptionPlugin`. (b) Bearer tokens encrypted in Redis via `TenantScopedSessionEncryptor`. (c) No webhook signature verification in v1 — security relies on callback URL uniqueness (two UUIDs), `tid` validation, and session existence check. (d) SSRF guard on all outbound `Five9Client` HTTP calls. (e) Supervisor credentials used only in HTTPS auth request body, never stored in Redis. (f) `conversationId` from Five9 treated as opaque — never used in queries or file paths. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Five9 API failures during `execute()` return `TransferResult` with `status: 'failed'` and structured error codes (`FIVE9_AUTH_FAILED`, `FIVE9_AUTH_TIMEOUT`, `FIVE9_DISCOVERY_FAILED`, `FIVE9_CONVERSATION_FAILED`). `sendUserMessage` failures throw (caller handles). `endSession` failures are best-effort (WARN log, local cleanup still occurs). Webhook errors: 400 for malformed, 404 for unknown/tenant-mismatch, 500 for adapter processing errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | **Failure Modes** | (a) Five9 downtime: transfer initiation fails with `FIVE9_AUTH_FAILED`, execution pipeline fallback executor can route to alternative adapter. (b) Token expiry mid-conversation: `sendUserMessage` detects 401/403, re-authenticates once, retries the message; if retry fails, throws to caller. (c) Redis unavailability: same failure mode as all adapters, existing Redis circuit breaker applies. (d) Five9 end conversation failure: session cleaned up locally, Five9 conversation orphaned (times out on Five9 side). No circuit breaker on Five9 API in v1. (e) **435 "Service migrated"**: Handled automatically across all Five9 API methods — re-discover metadata with `farmId` header on active datacenter, retry original call on new host. (f) **No agents available**: Availability check via `/logged_in_profiles` blocks transfer when `agentLoggedIn === false` for all profiles; user receives error message, session flags reset to resume bot. (g) **Transfer failure after escalation**: `handleEscalate` returns error synchronously, `routing-executor` resets `session.isEscalated` and `session.transferInitiated` to `false`, bot resumes on next message. |
| 7   | **Idempotency**   | Webhook processing is idempotent. Reprocessing the same event extends session TTL and re-fires `onAgentMessage` callbacks. Message delivery via the bridge is also idempotent (duplicate messages are tolerable — better than dropped messages). Session creation uses Lua atomic guard — duplicate `execute()` for same contact+channel returns existing session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8   | **Observability** | `createLogger('five9-adapter')` and `createLogger('five9-client')` for structured JSON logs with `tenantId`, `conversationId`, `provider` fields. Bearer tokens, passwords, and PII never in log context. Trace events emitted via the `TraceEventEmitter` interface (`packages/agent-transfer/src/observability/trace-events.ts`), wired through `createTraceStoreAdapter()` (`packages/agent-transfer/src/observability/trace-store-adapter.ts`) to the platform TraceStore. Reuses agent-transfer metrics with Five9 as a new `provider` label. `debug_diagnose` MCP tool shows Five9 registration status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Transfer initiation: < 4s total (auth ~500ms + metadata ~200ms + availability check ~500ms + conversation creation ~500ms against Five9, plus Redis session creation ~5ms). Availability check may add ~1s if 435 migration retry is needed. Webhook processing: < 500ms (payload normalization O(1) + session lookup ~5ms + adapter dispatch). No connection pooling in v1 (stateless `fetch`). Concurrent sessions share existing 1,000 per tenant limit.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10  | **Migration Path**     | No migration needed. Additive deployment: (1) New adapter code ships with existing runtime. (2) Five9Adapter registered at boot alongside KoreAdapter. (3) Adapter is inert until a project configures a Five9 connection. (4) Webhook route change is guarded by `provider === 'five9'` check — Kore path unchanged. No data migration, no schema changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | **Rollback Plan**      | The Five9 adapter is additive to the runtime binary. Rollback = deploy previous version. Since Five9 is opt-in (requires connection configuration), reverting removes Five9 capability but does not affect Kore transfers. The webhook route change is the only risk — verified by E2E-6 (Kore backward compatibility regression test). Active Five9 sessions during rollback: orphaned in Redis (TTL expiry cleans up), Five9 conversations orphaned (Five9's TTL policy cleans up). **Studio rollback**: Reverting Studio removes the Five9 provider from the connections list and the EditConnectionDialog. If runtime and Studio are deployed independently, a window where Studio shows Five9 but runtime lacks the adapter is possible — connections created during this window will fail at transfer time with `UNKNOWN_PROVIDER`, which is a graceful failure with no data corruption. |
| 12  | **Test Strategy**      | 9 E2E scenarios (real Express, real Redis, mocked Five9 API via DI), 12 integration tests (service boundary: Five9Client↔mock HTTP, Adapter↔Redis, UI↔PUT API), 13 unit tests (pure logic: event mapping, Zod schema, request construction). E2E-6 specifically tests Kore backward compatibility. Only Five9 external API is mocked. See `docs/testing/sub-features/five9-adapter.md` for full test spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 6. Data Model

### New Collections/Tables

None. Five9 reuses existing infrastructure.

### Modified Collections/Tables

**Redis Session Hash** — existing `agent_transfer:{tenantId}:{contactId}:{channel}`:

Five9 sessions use the typed `TransferSessionData` interface (`packages/agent-transfer/src/session/types.ts`). Top-level fields are shared with all providers:

| Top-Level Field     | Type   | Value for Five9        | Encrypted |
| ------------------- | ------ | ---------------------- | --------- |
| `provider`          | string | `'five9'`              | No        |
| `providerSessionId` | string | Five9 `conversationId` | No        |

Five9-specific fields are stored inside `providerData: Record<string, unknown>`:

| `providerData` Key | Type   | Description                                      |
| ------------------ | ------ | ------------------------------------------------ |
| `token`            | string | Five9 bearer token from auth                     |
| `targetHost`       | string | Five9 data center host (from metadata discovery) |
| `farmId`           | string | Five9 farm ID                                    |
| `orgId`            | string | Five9 org ID (from metadata discovery)           |

The `SessionFieldEncryptor` encrypts the entire `providerData` JSON blob before storing it in Redis (see `transfer-session-store.ts` lines 81-82, 237-240). This means the `token` field is encrypted as part of the blob — there is no individual field-level encryption. Decryption happens transparently on read (lines 153-154, 197-198).

**Provider Reverse Index** — existing pattern, new key:

```
at_by_provider:five9:{tenantId}:{conversationId} → session key
```

TTL inherited from parent session hash (set atomically via Lua create script).

### Key Relationships

- Five9 sessions use the identical `TransferSessionStoreHandle` interface as KoreAdapter
- Session TTLs follow existing channel-specific defaults (chat: 30min, voice: session-duration, messaging: 30min, email: 24hr)
- Encrypted `token` field uses the same `SessionFieldEncryptor` mechanism as Kore's sensitive fields

---

## 7. API Design

### New Endpoints

None.

### Modified Endpoints

**`POST /api/v1/agent-transfer/webhooks/:provider`** (existing)

Change: Provider-aware pre-processing block before existing validation:

```
if (provider === 'five9') {
  // 1. Extract tenantId from query string
  const tid = req.query.tid as string;
  if (!tid) → 400 MISSING_TENANT

  // 2. Normalize Five9 payload to XOEvent shape
  event.orgId = tid;

  // 3. Provider-aware event type mapping (after session lookup)
  normalizedType = Five9EventHandler.mapEventType(event.type);
} else {
  // Existing Kore path — unchanged
  normalizedType = KoreEventHandler.mapEventType(event.type);
}
```

This is a control-flow change, not just an additive block. The existing code at line 129-138 rejects events without `orgId` — the Five9 block must inject `orgId` BEFORE that check.

**Webhook signature verification**: The existing route has HMAC signature verification gated by `atConfig?.smartassist?.webhookSecret` (lines 74-114). For Five9, this config key is `undefined`, so verification is naturally skipped — no `provider === 'five9'` guard needed. This is acceptable for v1 because Five9's anonymous messaging API does not support webhook signing (documented as GAP-001 in the feature spec). Note: the current webhook secret config is hardcoded to the `smartassist` config path; a future provider requiring webhook signing would need a provider-keyed lookup (e.g., `atConfig?.providers?.[provider]?.webhookSecret`).

### Error Responses

| Code | Error Code          | When                                  |
| ---- | ------------------- | ------------------------------------- |
| 400  | `INVALID_EVENT`     | Missing `type` or `conversationId`    |
| 400  | `MISSING_TENANT`    | Five9 webhook without `tid` parameter |
| 404  | `SESSION_NOT_FOUND` | Unknown session or tenant mismatch    |
| 404  | `UNKNOWN_PROVIDER`  | Provider not registered               |
| 500  | `PROCESSING_ERROR`  | Adapter threw during processing       |
| 503  | `NOT_INITIALIZED`   | Agent transfer not bootstrapped       |

---

## 8. Cross-Cutting Concerns

- **Operational Logging**: Transfer initiation, session events, and webhook processing logged via `createLogger('five9-adapter')` and `createLogger('five9-client')` with structured context (`tenantId`, `conversationId`, `provider`). Sensitive data (tokens, passwords) never logged.
- **Audit Trail**: Transfer lifecycle events (`transfer:initiated`, `transfer:completed`, `transfer:failed`, `agent:connected`, `agent:disconnected`) emitted via the `TraceEventEmitter` interface to the platform `TraceStore` for compliance audit, separate from operational `createLogger` output. Wired through `createTraceStoreAdapter()` from `packages/agent-transfer/src/observability/trace-store-adapter.ts`.
- **Rate Limiting**: Five9 webhook endpoint reuses existing agent-transfer rate limiting. No Five9-specific rate limits in v1.
- **Caching**: No caching. Per-conversation authentication means tokens are not cached across conversations. Token caching with TTL is a future optimization (identified as GAP-002).
- **Encryption**: (a) Connection credentials encrypted in MongoDB via `encryptionPlugin`. (b) Five9 bearer tokens encrypted in Redis via `TenantScopedSessionEncryptor` / `SessionFieldEncryptor`. (c) All Five9 API calls over HTTPS. (d) Supervisor credentials transmitted only in HTTPS request body.

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                      | Type     | Risk   | Notes                                                                |
| ------------------------------- | -------- | ------ | -------------------------------------------------------------------- |
| `AgentDesktopAdapter` interface | Internal | Low    | Stable interface, no changes needed                                  |
| `TransferSessionStore`          | Internal | Low    | Proven Redis store with Lua scripts, reused as-is                    |
| `TenantScopedSessionEncryptor`  | Internal | Low    | Existing encryption mechanism, Five9 adds `token` field              |
| `MessageBridge`                 | Internal | Low    | Channel-agnostic routing, no changes needed                          |
| `AdapterRegistry`               | Internal | Low    | Simple Map-based registry, `register()` and `get()`                  |
| Five9 Messaging REST API        | External | Medium | Auth + metadata + conversation CRUD. Payload structure inferred      |
| `agent-desktop-registry.ts`     | Internal | Low    | Static provider definitions, additive change                         |
| Connection CRUD API             | Internal | Low    | Existing PUT API (`updateConnection()`) used by EditConnectionDialog |

### Downstream (depends on this feature)

| Consumer                   | Impact                                                   |
| -------------------------- | -------------------------------------------------------- |
| Projects configuring Five9 | Can now route `transfer_to_agent` to Five9 human agents  |
| EditConnectionDialog       | New component — no existing consumers affected           |
| Existing Kore transfers    | MUST NOT be affected — verified by E2E-6 regression test |

---

## 10. Open Questions & Decisions Needed

1. ~~**Five9 webhook payload structure**: The `Five9WebhookPayload` type is inferred from the Messaging API script.~~ **RESOLVED** — Validated against live Five9 tenant. Event types confirmed: `agent_message`, `agent_connected`, `agent_joined`, `agent_disconnected`, `conversation_queued`, `conversation_closed`, `agent_typing`, `agent_typing_stop`.
2. **Five9 token expiry duration**: Unknown for anonymous vs supervisor auth. Affects whether mid-conversation token expiry (GAP-006) is a realistic failure mode requiring proactive refresh. Token re-auth on 401/403 is implemented as mitigation.
3. **Five9 webhook retry policy**: If Five9 retries failed deliveries, should we implement deduplication beyond the current idempotent behavior (TTL extension)?
4. ~~**435 "Service migrated" handling**~~ **RESOLVED** — Implemented 3-step migration flow: (1) get metadata, (2) re-get with `farmId` header on active datacenter, (3) retry original call. Applied across all Five9 API methods.
5. ~~**Agent availability check**~~ **RESOLVED** — Added `/logged_in_profiles` endpoint call before conversation creation. Blocks transfer when no agents logged in. Uses auth host with fallback to metadata host.

### Post-Implementation Decisions

- **Async handleEscalate**: Converted from sync fire-and-forget to async return. Transfer failure messages now propagate to the user's chat window.
- **Session flag reset**: On transfer failure, `session.isEscalated` and `session.transferInitiated` are reset to `false` so the bot resumes normally.
- **Dual-host availability retry**: Availability check uses `authResult.targetHost` (original auth host) first, with fallback to `metadata.targetHost` (datacenter host) — discovered that the metadata-resolved datacenter may not be ready during migration.
- **Message forwarding**: Post-transfer user messages are intercepted in `runtime-executor.ts` and forwarded to Five9 via `sendUserMessage()` instead of bot processing.

---

## 11. References

- Feature spec: `docs/features/sub-features/five9-adapter.md`
- Test spec: `docs/testing/sub-features/five9-adapter.md`
- Parent HLD: `docs/specs/agent-transfer.hld.md`
- Design spec: `docs/superpowers/specs/2026-03-24-five9-adapter-design.md`
- Adapter interface: `packages/agent-transfer/src/adapters/interface.ts`
- Reference adapter: `packages/agent-transfer/src/adapters/kore/index.ts`
- Webhook route: `apps/runtime/src/routes/agent-transfer-webhooks.ts`
- Boot service: `apps/runtime/src/services/agent-transfer/index.ts`
- Session store: `packages/agent-transfer/src/session/transfer-session-store.ts`
