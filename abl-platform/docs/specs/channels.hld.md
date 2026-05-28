# High-Level Design: Channels

**Feature**: Channels
**Status**: STABLE
**Author**: SDLC Pipeline
**Date**: 2026-04-03
**Feature Spec**: `docs/features/channels.md`

---

## 1. Executive Summary

The Channels system is the ABL platform's unified abstraction for connecting agents to external messaging platforms, voice gateways, SDK embeddings, and inter-agent protocols. It uses a manifest-driven, adapter-pattern architecture that currently supports 27 channel types across 5 categories. The design prioritizes fast webhook acknowledgement (< 3s for Slack/WhatsApp), secure credential management, multi-tenant isolation, and extensibility through a single-entry-point manifest.

---

## 2. Architecture Overview

### 2.1 System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                        External Platforms                           │
│  Slack  WhatsApp  Teams  Telegram  LINE  Email  Genesys  ...      │
└─────────┬───────────┬───────┬────────┬─────┬──────┬────────┬──────┘
          │           │       │        │     │      │        │
          ▼           ▼       ▼        ▼     ▼      ▼        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ABL Runtime Service                             │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
│  │ Webhook      │  │ Channel       │  │ Sync Channel Routes      │ │
│  │ Routes       │  │ OAuth Routes  │  │ (VXML, Genesys, AC)      │ │
│  └──────┬───────┘  └───────────────┘  └──────────┬───────────────┘ │
│         │                                         │                 │
│         ▼                                         │                 │
│  ┌──────────────┐                                 │                 │
│  │ Channel      │◄────────────────────────────────┘                 │
│  │ Registry     │                                                   │
│  └──────┬───────┘                                                   │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ Connection   │    │ BullMQ       │    │ Session              │  │
│  │ Resolver     │    │ Queues       │    │ Resolver             │  │
│  └──────────────┘    │              │    └──────────────────────┘  │
│                      │ ┌──────────┐ │                              │
│                      │ │ Inbound  │ │                              │
│                      │ │ Worker   │ │                              │
│                      │ └────┬─────┘ │                              │
│                      │      │       │                              │
│                      │ ┌────▼─────┐ │    ┌──────────────────────┐  │
│                      │ │ Delivery │ │    │ Runtime              │  │
│                      │ │ Worker   │ │    │ Executor             │  │
│                      │ └──────────┘ │    └──────────┬───────────┘  │
│                      └──────────────┘               │              │
│                                                     ▼              │
│                                            ┌──────────────────┐    │
│                                            │ Channel          │    │
│                                            │ Dispatcher       │    │
│                                            │ (3-tier)         │    │
│                                            └──────────────────┘    │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Channel Conn │  │ Channel      │  │ SDK Channel              │ │
│  │ CRUD API     │  │ Session DB   │  │ CRUD API                 │ │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
           ┌─────────┐  ┌─────────┐  ┌──────────┐
           │ MongoDB  │  │ Redis   │  │ Jambonz  │
           └─────────┘  └─────────┘  └──────────┘
```

### 2.2 Component Responsibilities

| Component                   | Responsibility                                                                                             | Key File(s)                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Channel Manifest**        | Single source of truth for all channel capabilities, auth modes, ingress/delivery, credential requirements | `apps/runtime/src/channels/manifest.ts`                               |
| **Behavior Contract**       | Source-of-truth parity contract layered on top of the manifest for family-wide expectations                | `apps/runtime/src/channels/channel-behavior-contract.ts`              |
| **Channel Registry**        | Singleton adapter registry; resolves channel type to adapter                                               | `apps/runtime/src/channels/registry.ts`                               |
| **Channel Adapters**        | Per-channel: verify requests, normalize messages, transform output, send responses                         | `apps/runtime/src/channels/adapters/*.ts`                             |
| **Webhook Routes**          | HTTP ingress for external webhooks (POST/GET)                                                              | `apps/runtime/src/routes/channel-webhooks.ts`                         |
| **Connection Resolver**     | DB lookup + credential decryption with auth profile dual-read                                              | `apps/runtime/src/channels/connection-resolver.ts`                    |
| **Session Resolver**        | Map external session keys to runtime sessions; email threading                                             | `apps/runtime/src/channels/session-resolver.ts`                       |
| **BullMQ Queues**           | `channel-inbound` (incoming) and `webhook-delivery` (outgoing)                                             | `apps/runtime/src/services/queues/channel-queues.ts`                  |
| **Inbound Worker**          | Dedup, session resolve, runtime execute, delivery enqueue                                                  | `apps/runtime/src/services/queues/inbound-worker.ts`                  |
| **Delivery Worker**         | SSRF check, HMAC sign, POST to callback, retry logic                                                       | `apps/runtime/src/services/queues/delivery-worker.ts`                 |
| **Channel Dispatcher**      | 3-tier outbound: WebSocket -> Redis Pub/Sub -> PendingDeliveryStore                                        | `apps/runtime/src/services/execution/channel-dispatcher.ts`           |
| **Connection Manager**      | Bounded SDK/debug WebSocket connection tracking with cleanup                                               | `apps/runtime/src/websocket/connection-manager.ts`                    |
| **Channel Connection CRUD** | Project-scoped REST API for connection management                                                          | `apps/runtime/src/routes/channel-connections.ts`                      |
| **SDK Channels**            | Web/Mobile SDK channel config with HMAC identity verification                                              | `apps/runtime/src/routes/sdk-channels.ts`                             |
| **Channel OAuth**           | Generic OAuth 2.0 flow with provider adapters                                                              | `apps/runtime/src/services/channel-oauth/`                            |
| **Channel Adapter (Voice)** | Voice-specific text adaptation (strip markdown, SSML)                                                      | `apps/runtime/src/services/channel/channel-adapter.ts`                |
| **Switch Channel**          | Cross-channel session continuity for verified users                                                        | `apps/runtime/src/contexts/orchestration/use-cases/switch-channel.ts` |

---

## 3. Twelve Architectural Concerns

### 3.1 Resource Isolation

**Tenant Isolation**: Every database query includes `tenantId`. The `tenantIsolationPlugin` on all Mongoose models (`ChannelConnection`, `ChannelSession`, `SDKChannel`) enforces this at the model layer. Cross-tenant access returns 404.

**Project Isolation**: Channel connection CRUD routes use `requireProjectScope('projectId')` middleware. Every query filter includes `projectId`. The connection list endpoint filters by `{tenantId, projectId}`.

**User Isolation**: Channel connections are project-level resources (not user-specific). However, the OAuth flow tracks `userId` in the state to prevent cross-user session hijacking.

**Connection-level uniqueness**: The `{channelType, externalIdentifier}` unique index (partial on `status: active`) prevents duplicate active connections for the same external workspace/app.

### 3.2 Authentication & Authorization

**Inbound Webhook Auth**: Per-channel signature verification via `adapter.verifyRequest()`:

- HMAC-SHA256: Slack (`x-slack-signature`), WhatsApp (`x-hub-signature-256`), Messenger, Instagram, Twilio SMS
- JWT: MS Teams (Bot Framework tokens validated against `login.microsoftonline.com` JWKS)
- Token: Telegram (secret_token header), Genesys (client_secret), VXML, AudioCodes
- SDK Auth: AG-UI, SDK WebSocket (public API key + optional HMAC)
- None: Email (SMTP, no webhook), Web Debug (studio internal)

**CRUD Auth**: `authMiddleware` + `requireProjectScope()` on all channel connection routes. `tenantRateLimit('request')` prevents abuse.

**OAuth CSRF**: Random 32-byte state token stored in Redis with 10-minute TTL. State is consumed on callback (one-time use).

### 3.3 Stateless Distributed Design

**No pod-local state as truth**: All channel state lives in MongoDB (connections, sessions) and Redis (dedup keys, session locks, BullMQ jobs, OAuth state).

**Session Locks**: `acquireSessionLock()` uses Redis `SET NX PX` to prevent concurrent message processing for the same session across workers/pods.

**Cross-pod delivery**: `ChannelDispatcher` Tier 2 uses Redis Pub/Sub (`ws:deliver:${sessionId}`) for WebSocket delivery to clients connected on other pods.

**BullMQ**: Both inbound and delivery queues use shared Redis, enabling any worker pod to process any job.

### 3.4 Traceability

**Structured Logging**: Every component creates a named logger: `createLogger('channel-webhooks')`, `createLogger('inbound-worker')`, `createLogger('delivery-worker')`, etc.

**Key Trace Points**:

- Webhook received: `channelType`, `messageCount`, `connectionId`
- Session created/reused: `channelSessionId`, `sessionId`, `isNew`
- Delivery success/failure: `deliveryId`, `httpStatus`, `attempts`
- Dedup skipped: `messageId`, `connectionId`
- Stale session recovery: `staleSessionId`, `newSessionId`

**Runtime Execution**: Standard `TraceEvent` emission via `TraceStore` during agent execution (leverages existing traceability infrastructure).

**Gap**: No dedicated trace event type for channel-specific lifecycle (webhook -> queue -> session -> execute -> deliver). This is currently covered by structured logs but not queryable via the Observatory.

### 3.5 Compliance & Data Protection

**Encryption at Rest**: Channel credentials stored in `ChannelConnection.encryptedCredentials` via the `encryptionPlugin`. Additional `encryptedInboundAuthToken` in the Mixed `config` field handled manually via `encryptForTenant/decryptForTenant`.

**Auth Profile Migration**: `dualReadCredentials()` provides a migration path from direct encrypted credentials to the centralized Auth Profile system, with automatic fallback.

**Verify Token Hashing**: Meta verify tokens stored as SHA-256 hashes (never plaintext) for indexed lookup.

**SDK Secret Key**: HMAC secrets for identity verification stored encrypted on `SDKChannel.secretKey`.

**SSRF Protection**: `assertAllowedCallbackUrl()` validates webhook delivery URLs. In production, blocks private IP ranges (10.x, 172.16-31.x, 192.168.x, localhost, link-local).

**Data Minimization**: `CHANNEL_SESSION_RETENTION_DAYS` env var enables TTL-based automatic cleanup of channel session mappings. `removeOnComplete: 1000` / `removeOnFail: 5000` limits BullMQ job retention.

**Right to Erasure**: `cascade-delete.ts` in `@agent-platform/database` includes channel connections and sessions in the tenant/project cascade delete chain.

### 3.6 Performance

**Fast Webhook ACK**: Webhook routes enqueue to BullMQ and return 200 immediately. Critical for Slack (3s timeout) and WhatsApp.

**Concurrency Limits**:

- `MAX_MEDIA_SESSIONS`: 10,000 (Twilio voice)
- `MAX_SDK_CLIENTS`: 50,000 (WebSocket)
- `MAX_KOREVG_SESSIONS`: 500 (Kore VG voice)
- Delivery worker concurrency: 10

**Timeouts**:

- `CHANNEL_EXECUTE_TIMEOUT_MS`: 120s (runtime execution)
- `MEDIA_BATCH_TIMEOUT_MS`: 60s (media download batching)
- Webhook delivery: 30s (fetch timeout with `AbortSignal.timeout`)
- `WS_MESSAGE_TIMEOUT_MS`: 90s (WebSocket message processing)

**Retry Strategy**: BullMQ exponential backoff:

- Inbound: 3 attempts, 2s initial delay
- Delivery: 5 attempts, 3s initial delay

**Performance Gap**: Connection resolution does a MongoDB query per webhook with no caching. For high-volume channels, a Redis L2 cache with TTL could reduce DB load.

### 3.7 Scalability

**Horizontal Scaling**: BullMQ workers can run on any pod. Adding more runtime pods increases processing capacity linearly.

**Queue Partitioning**: Currently a single `channel-inbound` queue for all channel types. For extreme scale, per-channel-type queues could be introduced.

**Connection Resolution**: O(1) lookup via unique index `{channelType, externalIdentifier}`. Verify token lookup via indexed `{channelType, verifyTokenHash}`.

**Session Resolution**: O(1) lookup via unique index `{tenantId, externalSessionKey}`. Email threading uses compound index on `{tenantId, channelConnectionId, emailMessageIds}`.

### 3.8 Reliability

**Message Deduplication**: Redis `SET NX` with TTL on `${tenantId}:${subscriptionId}:${idempotencyKey}`. First-attempt-only dedup; BullMQ retries bypass to prevent message loss.

**Stale Session Recovery**: `reuseOrRefreshSession()` detects when a channel session's runtime session has expired in Redis. Automatically creates a new runtime session and updates the mapping.

**Delivery Retry**: 5 attempts with exponential backoff. Terminal failures marked after all retries exhausted. 410 Gone triggers subscription deactivation.

**Graceful Degradation**: If BullMQ/Redis unavailable, webhook routes return 503 (not 500). If encryption service unavailable, credentials return null (logged, not crashed).

**Pending Delivery**: `PendingDeliveryStore` catches messages when WebSocket is disconnected and Redis Pub/Sub has no subscribers.

### 3.9 Extensibility

**Manifest-Driven**: Adding a new channel requires:

1. Add entry to `CHANNEL_MANIFEST` (ingress, delivery, auth, capabilities)
2. Implement `ChannelAdapter` interface
3. Register in `ChannelRegistry`
4. (Optional) Add Studio `ChannelTypeDef` for UI

All derived sets (webhook types, connection types, voice types) update automatically.

**WhatsApp Multi-Provider**: Provider pattern (`whatsapp-provider.ts`) allows multiple providers (Meta Cloud, Infobip, Gupshup, Netcore) for the same channel type with provider-specific routing via URL path (`/:channelType/:provider/webhook`).

**Rich Output**: `transformOutput(text, actions?, richContent?)` on the adapter interface enables per-channel rich content (Block Kit, Adaptive Cards, etc.) without changing the core pipeline.

**Phase 2 Reserved**: `RichConfigIR` field reserved in `channel-adapter.ts` for future rich content capabilities.

### 3.10 Testing

**Current State**: The branch now has broad existing coverage, including control-plane E2E (`channels-control-plane.e2e.test.ts`), HTTP Async identity continuity E2E (`http-async-identity-continuity.e2e.test.ts`), voice ingress E2E, SDK WebSocket handler coverage, dispatcher coverage, and deep adapter/provider/manifest suites.

**Ongoing hardening**: The test spec still defines a target matrix, but it now sits on top of substantial real coverage rather than a zero-coverage baseline.

**Testing Challenges**:

- E2E tests need real BullMQ, Redis, and MongoDB
- Webhook signature generation requires per-channel HMAC utilities
- OAuth code exchange needs mock external APIs (Slack, Teams)
- WebSocket delivery testing requires real WS connections

### 3.11 Observability

**Logging**: Structured JSON logging via `createLogger()` with context fields (channelType, tenantId, connectionId, sessionId, etc.).

**BullMQ Dashboard**: Job counts, failure rates, and retry metrics available via BullMQ's built-in monitoring.

**Health Indicators**:

- Queue depth (inbound + delivery)
- Worker processing rate
- Delivery success/failure ratio
- Stale session recovery rate

**Gap**: No dedicated Prometheus metrics for channel operations. No channel-specific spans in the trace system. Delivery success rates must be computed from structured logs rather than aggregated metrics.

### 3.12 Backward Compatibility

**Auth Profile Dual-Read**: Seamless migration from direct encrypted credentials to Auth Profile system. `dualReadCredentials()` tries new system first, falls back to legacy.

**Verify Token Hash**: Migration script `20260304_008_fix_verify_token_hash_index.ts` ensures existing connections have their verify token hashes computed and indexed.

**SDK Channel Environment**: `followEnvironment` flag on SDKChannel provides backward compatibility -- existing channels that didn't specify an environment continue to work.

**Channel Manifest Additions**: New channels can be added without breaking existing integrations. Derived sets auto-update.

---

## 4. Data Flow: Inbound Webhook Message

```
1. External Platform sends POST to /api/v1/channels/:type/webhook/:id
2. channel-webhooks.ts route handler:
   a. Resolve adapter from ChannelRegistry
   b. Handle verification challenge (Slack url_verification)
   c. Pre-filter (skip bot messages via adapter.shouldProcess)
   d. Resolve connection (DB lookup → decrypt credentials)
   e. Verify request signature (adapter.verifyRequest with rawBody)
   f. Normalize message (adapter.buildNormalizedMessage)
   g. Enqueue to BullMQ channel-inbound (with idempotencyKey)
   h. Return 200 immediately
3. inbound-worker processes job:
   a. Dedup via Redis SET NX (first attempt only)
   b. Acquire session lock (Redis SET NX PX)
   c. Download media attachments if present
   d. Resolve/create session (session-resolver.ts)
   e. Execute via runtime executor
   f. Send typing indicator (if adapter supports)
   g. Transform output (adapter.transformOutput)
   h. Send response (adapter.sendResponse)
   i. Create delivery record (for webhook subscriptions)
   j. Enqueue to webhook-delivery queue (if applicable)
   k. Release session lock
4. delivery-worker processes delivery job:
   a. Load subscription (tenant-scoped)
   b. SSRF check on callback URL
   c. Decrypt HMAC secret (auth profile dual-read)
   d. Build HMAC signature headers
   e. POST to callback URL (30s timeout, redirect: manual)
   f. Handle response: 2xx=success, 410=deactivate, 4xx=fail, 5xx=retry
```

---

## 5. Data Flow: Outbound (Channel Dispatcher)

```
1. Runtime execution completes with response text
2. ChannelDispatcher.deliver(binding, sessionId, result):
   a. Switch on binding.channelType:
      - web_debug/sdk_websocket → deliverViaWebSocket
      - a2a → deliverViaA2APush
      - slack/whatsapp/http_async/msteams/email → marked delivered (pipeline handles)
   b. Always persist to message history
   c. If not delivered → store in PendingDeliveryStore

3. deliverViaWebSocket (3 tiers):
   Tier 1: Check local WS registry, send via Studio protocol
   Tier 2: Publish to Redis Pub/Sub (ws:deliver:${sessionId})
   Tier 3: Store in PendingDeliveryStore for later pickup

4. Studio protocol:
   → response_start { sessionId, messageId }
   → response_chunk { sessionId, messageId, chunk }
   → response_end { sessionId, messageId, fullText }
   (Optional: handoff_progress before response_start)
```

---

## 6. Security Architecture

### 6.1 Credential Lifecycle

```
Create Connection:
  1. Client sends plaintext credentials in POST body
  2. Route validates required credentials per manifest
  3. encryptionPlugin encrypts to encryptedCredentials
  4. For Meta channels: hash verify_token → verifyTokenHash
  5. Store in MongoDB (credentials encrypted at rest)

Resolve Connection (runtime):
  1. DB lookup by {channelType, externalIdentifier}
  2. dualReadCredentials():
     a. If authProfileId → resolve via AuthProfile service
     b. Else → decryptJsonForTenant(encryptedCredentials)
  3. Return ResolvedConnection with decrypted credentials
  4. Credentials used in-memory only, never re-persisted in plaintext
```

### 6.2 Threat Mitigations

| Threat                           | Mitigation                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Credential exposure in responses | API response includes `hasCredentials: boolean`, never raw secrets            |
| Webhook replay attacks           | Per-channel HMAC/JWT verification with raw body                               |
| OAuth CSRF                       | Random 32-byte state, 10-minute TTL, one-time use                             |
| SSRF via webhook delivery        | `assertAllowedCallbackUrl()` blocks private IPs in production                 |
| Cross-tenant data access         | `tenantIsolationPlugin` + 404 on cross-tenant access                          |
| Verify token enumeration         | SHA-256 hash stored/indexed instead of plaintext                              |
| Message injection                | Input normalization through adapter.buildNormalizedMessage                    |
| DDoS via webhooks                | `tenantRateLimit('request')` on CRUD; fast ACK prevents connection exhaustion |

---

## 7. Alternatives Considered

### 7.1 Direct HTTP Handlers vs. BullMQ Queue

**Chosen**: BullMQ async processing.
**Alternative**: Process webhooks synchronously in the HTTP handler.
**Rationale**: Slack requires < 3s ACK. Runtime execution can take 10-120s. Async processing decouples ingress from execution, enabling fast ACK and retry capability.

### 7.2 Per-Channel Routes vs. Generic Webhook Route

**Chosen**: Hybrid -- generic route with channel type in path, plus dedicated routes for channels with special needs (VXML, Genesys, AudioCodes).
**Alternative**: Fully per-channel route files.
**Rationale**: Generic route handles 80% of channels. Special routes only for sync channels that need request/response in a single HTTP round-trip.

### 7.3 Adapter Interface vs. Event-Driven Plugins

**Chosen**: Adapter interface with singleton registry.
**Alternative**: Event-driven plugin system where adapters subscribe to channel events.
**Rationale**: Adapter interface is simpler, type-safe, and sufficient. Event-driven adds complexity without clear benefit when adapters are compiled into the application.

### 7.4 Connection-Level Encryption vs. Auth Profiles

**Chosen**: Both (dual-read pattern).
**Alternative**: Migrate all credentials to Auth Profiles immediately.
**Rationale**: Auth Profiles are newer and not yet fully rolled out. Dual-read enables gradual migration without a flag-day cutover.

---

## 8. Risks and Mitigations

| Risk                                            | Probability | Impact | Mitigation                                                    |
| ----------------------------------------------- | ----------- | ------ | ------------------------------------------------------------- |
| Connection resolution DB bottleneck at scale    | Medium      | High   | Add Redis L2 cache with 60s TTL (Q2 in feature spec)          |
| BullMQ queue backlog during traffic spikes      | Medium      | Medium | Horizontal scaling of workers, per-channel queue partitioning |
| Stale session accumulation (no cleanup)         | Low         | Low    | `CHANNEL_SESSION_RETENTION_DAYS` TTL index                    |
| Adapter-specific bugs in signature verification | Medium      | High   | Per-adapter integration tests with real signatures            |
| OAuth state store Redis failure                 | Low         | Medium | 503 response, user retries OAuth flow                         |
| Webhook delivery to down callbacks              | Medium      | Low    | Exponential backoff, subscription deactivation on 410         |
| Missing trace events for debugging              | High        | Medium | Add channel-specific trace event types (see Gap in 3.4)       |

---

## 9. Open Design Decisions

| ID    | Decision                                     | Status      | Notes                                             |
| ----- | -------------------------------------------- | ----------- | ------------------------------------------------- |
| HLD-1 | Redis L2 cache for connection resolution     | DEFERRED    | Needs performance profiling first                 |
| HLD-2 | Prometheus metrics for channel operations    | DEFERRED    | Depends on observability platform maturity        |
| HLD-3 | Per-channel-type BullMQ queues for isolation | DEFERRED    | Current single queue sufficient for current scale |
| HLD-4 | Channel-specific trace event types           | RECOMMENDED | Would improve debugging via Observatory           |
| HLD-5 | Connection health checks (periodic ping)     | DEFERRED    | Not yet needed; reactive approach sufficient      |
