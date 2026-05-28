# HLD: AI4W-ABL Channel Integration

**Feature Spec**: `docs/features/ai4w-abl-channel-integration.md`
**Test Spec**: `docs/testing/ai4w-abl-channel-integration.md`
**Status**: APPROVED
**Author**: Ajay Gummalla
**Date**: 2026-04-22
**Jira**: ABLP-420

---

## 1. Problem Statement

AIforWork (AI4W / KoreServer) orchestrates AI agents across multiple platforms but cannot invoke ABL-built agents. AI4W users must duplicate agent logic or maintain separate interfaces. ABL agents cannot reach AI4W users for proactive tasks like human approvals or notifications. This feature creates a bidirectional integration bridge: AI4W gets a new `ablAgent` type to invoke ABL agents, and ABL gets a new `ai4w` channel type to receive messages from and deliver responses/notifications to AI4W.

**ABL scope (ABLP-420)**: This HLD focuses on ABL Platform changes — the `ai4w` channel adapter, inbound routes, internal discovery/provisioning APIs, session management, and outbound delivery. AI4W is treated as an external consumer.

---

## 2. Alternatives Considered

### Option A: Zero-Change — AI4W Uses Existing ABL APIs Directly

- **Description**: AI4W's `aaAgent` pattern calls ABL's existing `/api/v1/chat/agent` (sync) and `http_async` channel (async callbacks). No code changes on ABL side.
- **Pros**: Zero ABL development cost. Immediate availability. Uses battle-tested APIs.
- **Cons**: Complex setup (separate API key, webhook subscription, no 1-click flow). No user-scoped sessions (API keys are tenant-scoped). No proactive notifications. No agent discovery. Forces AI4W to understand ABL's internal API contracts.
- **Effort**: S

### Option B: Custom `ai4w` Channel Type (Recommended)

- **Description**: New `ai4w` entry in `CHANNEL_MANIFEST` with dedicated adapter, dual-layer auth (HMAC request signing + JWT identity), three response modes (sync/SSE/async), proactive notification delivery, internal discovery API, and 1-click provisioning.
- **Pros**: Simplified UX (browse + 1-click). User-scoped sessions via JWT email claims. Protocol abstraction (can evolve without breaking AI4W config). Proactive notifications. Platform convergence path. HMAC provides payload integrity and prevents tampering.
- **Cons**: Non-trivial development across 6 phases. New adapter code to maintain.
- **Effort**: L

### Option C: A2A Protocol Integration

- **Description**: AI4W implements a full A2A JSON-RPC client and communicates with ABL's existing `a2a` channel.
- **Pros**: Standards-based interop. Reuses ABL's A2A infrastructure. Task state machine handles async naturally.
- **Cons**: AI4W must implement A2A client (JSON-RPC, SSE event protocol, task state machine) — significant work. AI4W's internal patterns (`RequestAgent`, `makeRequest`) are HTTP-REST-based, not JSON-RPC. Proactive notifications still need custom delivery. Overkill for single-platform integration.
- **Effort**: L

### Recommendation: Option B — Custom `ai4w` Channel Type

**Rationale**: Option A is insufficient (no user-scoped sessions, no proactive delivery, no discovery UX). Option C forces AI4W to adopt an unfamiliar protocol for a single-platform integration. Option B provides the best UX, cleanest protocol abstraction, and a convergence path. The custom channel follows ABL's existing manifest-driven architecture and the effort is justified by the integration depth (6 phases from sync to cross-environment).

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AI4W (KoreServer)                                 │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ KoraConversation │  │ ABLGateway       │  │ KANotification   │  │
│  │ Service          │──│ Service          │  │ Service          │  │
│  │ (orchestrator)   │  │ (HTTP client)    │  │ (push/bell)      │  │
│  └──────────────────┘  └────────┬─────────┘  └───────▲──────────┘  │
│                                 │                     │             │
└─────────────────────────────────┼─────────────────────┼─────────────┘
                                  │ HTTP                │ HTTP
                    ┌─────────────┼─────────────────────┼──────┐
                    │ Network     │ (same VPC / cross)   │      │
                    └─────────────┼─────────────────────┼──────┘
                                  │                     │
┌─────────────────────────────────┼─────────────────────┼─────────────┐
│                    ABL Platform (Runtime)              │             │
│                                 │                     │             │
│  ┌──────────────────┐  ┌───────▼─────────┐  ┌────────┴─────────┐  │
│  │ ai4w Route       │  │ ai4w Adapter    │  │ Channel          │  │
│  │ Handler          │──│ (verify/parse/  │  │ Dispatcher       │  │
│  │ (sync/SSE/async) │  │  send/transform)│  │ (3-tier delivery)│  │
│  └──────────────────┘  └────────┬────────┘  └────────┬─────────┘  │
│                                 │                     │             │
│  ┌──────────────────┐  ┌───────▼─────────┐  ┌────────▼─────────┐  │
│  │ Internal         │  │ Session         │  │ Webhook Delivery │  │
│  │ Discovery API    │  │ Resolver        │  │ Worker (BullMQ)  │  │
│  │ (see OQ-1)       │  │                 │  │                  │  │
│  └──────────────────┘  └─────────────────┘  └──────────────────┘  │
│                                                                     │
│  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Redis-backed     │  │ Connection      │  │ Runtime          │  │
│  │ Circuit Breaker  │  │ Resolver        │  │ Executor         │  │
│  │ (per connectionId│  │ (decrypt creds) │  │                  │  │
│  └──────────────────┘  └─────────────────┘  └──────────────────┘  │
│                                                                     │
│        ┌──────────┐        ┌──────────┐        ┌──────────┐       │
│        │ MongoDB  │        │ Redis    │        │ BullMQ   │       │
│        └──────────┘        └──────────┘        └──────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
ai4w-channel.ts (route handler — public HMAC + JWT)
  ├── POST /api/v1/channels/ai4w/{connectionId}/message  → sync, SSE, or async
  ├── GET  /api/v1/channels/ai4w/{connectionId}/info     → meta + live currentDeployment
  │                                                         (also serves as health check —
  │                                                          HMAC signed over empty body)
  └── Uses:
       ├── ai4w-adapter.ts
       │   ├── buildNormalizedMessage() → NormalizedIncomingMessage (session key,
       │   │                               downloaded-file summaries, sessionMetadata)
       │   ├── downloadIncomingFiles()  → SSRF-validated fetch of signed URLs
       │   ├── sendResponse()           → async: HMAC-signed callback headers (sync/
       │   │                               stream are handled directly by the route)
       │   └── transformOutput()        → RichContentIR → markdown
       │   (verifyRequest is intentionally a hard-throw: AI4W auth lives in
       │    the route handler, not in the generic webhook pipeline.)
       │
       ├── ai4w-auth.ts
       │   ├── verifyHmac()      → HMAC-SHA256(secret, "inbound:" + requestId.timestamp.rawBody)
       │   ├── initAI4WAuth()    → startup: parse AI4W_TRUSTED_ISSUERS into an
       │   │                        allowlist + apply AI4W_ISSUER_JWKS_OVERRIDES.
       │   │                        Pure config validation — NO network calls. Pod
       │   │                        always boots clean even when every upstream
       │   │                        issuer is down. (A best-effort background warm
       │   │                        is fine but never gates startup.)
       │   ├── registerIssuer()  → lazy: triggered on the first JWT for an
       │   │                        unregistered issuer. Runs OIDC discovery,
       │   │                        validates self-reported `issuer`, builds
       │   │                        jose createRemoteJWKSet, caches indefinitely.
       │   │                        Single-flight: concurrent requests share one
       │   │                        in-flight Promise. Failure is recorded with
       │   │                        timestamp; subsequent attempts are deferred
       │   │                        until the AI4W_JWKS_COOLDOWN_MS window passes,
       │   │                        then automatically retried. No pod restart is
       │   │                        required to recover when an issuer comes back.
       │   ├── verifyJwt()       → decode iss, reject if iss ∉ allowlist (401
       │   │                        WRONG_ISSUER). If registered → verify with
       │   │                        cached JWKS. If not registered and outside
       │   │                        cooldown → registerIssuer() then verify. If
       │   │                        inside cooldown → 401 WRONG_ISSUER (cached
       │   │                        failure). Audience validated against
       │   │                        AI4W_JWT_AUDIENCE (default urn:kore:agentic).
       │   ├── checkReplay()     → Redis SET nonce dedup (60s TTL; distinct namespace per endpoint)
       │   ├── enforceBinding()  → jwt.accountId === connection.config.ai4wAccountId
       │   └── checkAuthBlock()  → Redis counter per source-IP+connectionId (10/60s → 5min block)
       │
       ├── connection lookup     → find by connectionId field (NOT _id), decrypt creds
       ├── session-resolver.ts   → external key → ABL session
       │                            key: ai4w:{connectionId}:{base64url(email)}:{contextId}
       └── runtime-executor      → standard agent execution pipeline

internal-discovery.ts (service-token + JWT; separate port :3113 — see OQ-1)
  ├── GET    /api/internal/v1/tenants/by-membership                            → tenants accessible by email (name asc)
  ├── GET    /api/internal/v1/tenants/{tenantId}/projects/discoverable         → RBAC-filtered projects with agentCount
  │                                                                               ?limit/?cursor/?q/?sort=recent
  ├── POST   /api/internal/v1/channel-connections/provision                    → project-level auto-create
  ├── POST   /api/internal/v1/channel-connections/{connectionId}/deactivate    → soft-disable ai4w connection
  └── DELETE /api/internal/v1/channel-connections/{connectionId}               → hard-remove ai4w connection (orphan reaper)

Channel Dispatcher (outbound — proactive notifications + async callbacks)
  └── ai4w adapter.sendProactive() / sendAsync()
       ├── HTTP POST to AI4W callback/notification endpoint
       ├── Redis circuit breaker (key: ai4w:{connectionId})
       ├── HMAC-SHA256 signature (same connectionSecret, "outbound:" direction prefix)
       └── Dedup via Redis SET NX on notificationId
```

### Data Flow: Sync Message

```
AI4W                                    ABL Runtime
  │                                        │
  │  POST /channels/ai4w/{connId}/message  │
  │  Authorization: Bearer <JWT>           │
  │  X-Signature-Nonce: <UUID>                  │
  │  X-Timestamp: <epoch>                  │
  │  X-Signature: sha256=<HMAC>             │
  │  X-Response-Mode: sync                 │
  │───────────────────────────────────────►│
  │                                        │  1. Check auth failure rate limit for IP+connId
  │                                        │  2. Lookup connection by connectionId field
  │                                        │  3. Verify HMAC (nonce + timestamp + rawBody)
  │                                        │  4. Verify JWT: decode iss, pick JWKS from trusted-issuer registry, verify sig + aud
  │                                        │  5. Enforce accountId binding
  │                                        │  6. Rate limit by tenantId
  │                                        │  7. Session resolve (key: ai4w:{connId}:{email}:{ctx})
  │                                        │  8. Execute agent
  │                                        │  9. transformOutput()
  │  200 OK                                │
  │  X-Response-Mode-Used: sync            │
  │  { response, sessionId }               │
  │◄───────────────────────────────────────│
```

### Data Flow: SSE Streaming

```
AI4W                                    ABL Runtime
  │                                        │
  │  POST /channels/ai4w/{connId}/message  │
  │  X-Response-Mode: stream               │
  │  (+ HMAC + JWT headers)                │
  │───────────────────────────────────────►│
  │                                        │  1-7. Same as sync (auth, resolve, session)
  │  200 OK                       │
  │  Content-Type: text/event-    │
  │    stream                     │
  │  X-Response-Mode-Used: stream │
  │◄──────────────────────────────│
  │  event: chunk                 │  4. Agent produces tokens
  │  data: {"text":"Hello"}       │
  │◄──────────────────────────────│
  │  event: chunk                 │
  │  data: {"text":" world"}      │
  │◄──────────────────────────────│
  │  event: done                  │  5. Agent completes
  │  data: {"response":"..."}     │
  │◄──────────────────────────────│
  │  (connection closed)          │
```

### Data Flow: Async Callback

```
AI4W                           ABL Runtime                    BullMQ
  │                               │                              │
  │  POST /channels/ai4w/         │                              │
  │    {connId}/message           │                              │
  │  X-Response-Mode: async       │                              │
  │  (+ HMAC + JWT headers)       │                              │
  │──────────────────────────────►│                              │
  │  202 Accepted                 │  1. Verify HMAC+JWT, resolve │
  │  { requestId }                │  2. Enqueue to channel-      │
  │◄──────────────────────────────│     inbound queue            │
  │                               │──────────────────────────────►│
  │                               │                              │ 3. Inbound worker:
  │                               │                              │    session, execute
  │                               │                              │ 4. Enqueue to webhook-
  │                               │                              │    delivery queue
  │  POST <callbackUrl>           │                              │
  │  X-Signature: sha256=<hmac>   │◄──────────────────────────────│ 5. Delivery worker:
  │  { response, requestId }      │                              │    SSRF check, sign,
  │◄──────────────────────────────│                              │    POST to callback
```

### Data Flow: Proactive Notification (Human Approval)

```
ABL Agent                     ABL Runtime                    AI4W
  │                               │                            │
  │  suspend(human_approval,      │                            │
  │    { callbackId, userEmail }) │                            │
  │──────────────────────────────►│                            │
  │                               │ 1. Store SuspendedExecution│
  │                               │ 2. Register callback       │
  │                               │ 3. ChannelDispatcher →     │
  │                               │    ai4w adapter            │
  │                               │ 4. Redis SET NX dedup      │
  │                               │ 5. Circuit breaker check   │
  │                               │ 6. POST notification       │
  │                               │──────────────────────────►│
  │                               │                            │ 7. KANotification
  │                               │                            │    Service delivers
  │                               │                            │    (push+bell+presence)
  │                               │                            │
  │                               │  POST /callbacks/:id       │ 8. User approves
  │                               │  { result: "approved" }    │
  │                               │◄────────────────────────────│
  │                               │ 9. ResumptionService       │
  │  resume(result)               │    resumes execution       │
  │◄──────────────────────────────│                            │
```

### Data Flow: File Ingestion via Signed URL (P2 — FR-11)

```
AI4W                           ABL Runtime
  │                               │
  │  POST /channels/ai4w/message  │
  │  { files: [{ signedUrl,      │
  │    name, mimeType }] }       │
  │──────────────────────────────►│
  │                               │  1. JWT verify, connection resolve
  │                               │  2. For each file in payload:
  │                               │     a. Validate signedUrl against
  │                               │        connection.trustedCallbackUrls
  │                               │     b. HTTP GET signedUrl (download NOW,
  │                               │        not at execution time)
  │                               │     c. Ingest via multimodal pipeline
  │                               │        (existing file processing)
  │                               │  3. Execute agent with ingested files
  │                               │  4. If agent produces files:
  │                               │     a. Generate signed download URLs
  │                               │        (ABL-hosted, short-lived)
  │  200 OK                       │
  │  { files: [{ signedUrl }] }   │
  │◄──────────────────────────────│
```

**Key decision**: Files are downloaded at **ingestion time** (step 2b), not execution time. This prevents signed URL expiry during async/queued processing. The adapter's `parseIncoming()` method handles the download and passes local file references to the executor.

### Data Flow: Auth Challenge (P5 — FR-12)

```
ABL Agent                     ABL Runtime                    AI4W
  │                               │                            │
  │  suspend(human_input,         │                            │
  │    { authUrl, callbackId })   │                            │
  │──────────────────────────────►│                            │
  │                               │ 1. Store SuspendedExecution│
  │                               │    (reason: human_input)   │
  │                               │ 2. Register callback       │
  │                               │ 3. ChannelDispatcher →     │
  │                               │    ai4w adapter            │
  │                               │ 4. POST notification       │
  │                               │    type: 'auth_challenge'  │
  │                               │    payload.authUrl = <url> │
  │                               │──────────────────────────►│
  │                               │                            │ 5. Render OAuth
  │                               │                            │    button/link in UI
  │                               │                            │ 6. User completes
  │                               │                            │    OAuth flow
  │                               │  POST /callbacks/:id       │
  │                               │  { result: { token, ... }} │ 7. AI4W POSTs result
  │                               │◄────────────────────────────│
  │                               │ 8. ResumptionService       │
  │  resume(authResult)           │    resumes with auth data  │
  │◄──────────────────────────────│                            │
```

**Design note**: Auth challenge reuses the same proactive notification mechanism as human approval (same endpoint, same HMAC signing, same dedup). The `type: 'auth_challenge'` discriminator tells AI4W to render an OAuth button instead of approval actions. The callback payload includes the auth result (token, granted scopes). Suspension timeout (default 10 min) applies — if the user doesn't complete OAuth in time, ABL sends a timeout notification.

### Data Flow: Cross-Environment OAuth2 (P6 — FR-17)

```
AI4W (external env)            ABL Runtime (different env)
  │                               │
  │  POST /oauth/token            │  (ABL's token endpoint)
  │  grant_type=client_credentials│
  │  client_id=<provisioned>      │
  │  client_secret=<provisioned>  │
  │──────────────────────────────►│
  │  { access_token, expires_in } │  1. Validate client credentials
  │◄──────────────────────────────│  2. Issue short-lived bearer token
  │                               │
  │  POST /channels/ai4w/message  │
  │  Authorization: Bearer <token>│  (NOT JWT — OAuth2 bearer token)
  │──────────────────────────────►│
  │                               │  3. ai4w-auth.ts validates bearer
  │                               │     token (different path from JWKS)
  │                               │  4. Extract accountId from token
  │                               │     claims (not JWT email)
  │                               │  5. Standard execution flow
  │  Response                     │
  │◄──────────────────────────────│
```

**Key differences from same-VPC JWKS**: (a) OAuth2 client-credentials replaces mutual JWT — AI4W provisions credentials in ABL's OAuth provider. (b) SSRF policy switches from allowlist to default blocklist (cross-env endpoints are on the public internet). (c) Bearer token validation path in `ai4w-auth.ts` is distinct from JWKS path. (d) P6 may warrant a separate mini-spec (Open Question #3 in feature spec).

### Offline User Notification Fallback (FR-18)

When ABL delivers a proactive notification or async result to AI4W and the target user has no active WebSocket connection, the delivery path is:

1. ABL POSTs notification to AI4W's `notificationUrl` (same as online path — ABL has no visibility into AI4W's user presence).
2. AI4W receives the notification and checks user presence (Redis pub/sub).
3. If user is **online**: deliver via Socket.IO `liveUpdates.notifyViewers()`.
4. If user is **offline**: AI4W falls back to `KANotificationService.notify()` with `publishTo: ["push", "bell", "presence"]` — push notification (SNS/GCM), bell icon badge, and presence-triggered delivery when the user reconnects.

**ABL-side implication**: None — ABL's delivery path is identical regardless of user online/offline status. The offline fallback is entirely AI4W's responsibility. ABL only cares about the HTTP response from AI4W's notification endpoint (200 = accepted, 404 = user not found, etc. — see proactive notification error contract in feature spec §7).

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every query includes `tenantId`. Connection lookup is by `connectionId` field (random UUID, not MongoDB `_id`), which resolves to a specific `tenantId` + `projectId`. Discovery API filters by tenant first (trust), then by project membership (RBAC). Cross-tenant access returns 404 (not 403). The composite session key `ai4w:{connectionId}:{base64url(email)}:{agentContextId}` ensures no cross-connection session collision. JWT-connection binding (`config.ai4wAccountId`) enforced after first request prevents stolen-secret+wrong-account attacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **Data Access Pattern** | Connection lookup by `connectionId` field (unique index) with credential decryption for HMAC validation. Uses existing `SessionResolver` for session mapping. No new repository layer needed — ai4w creates standard `ChannelConnection` documents (with new `connectionId` field) and `Session` documents in existing collections. Global JWKS via single `createRemoteJWKSet` instance (module-level cache, no per-connection JWKS). New `{ connectionId: 1 }` unique index on `channel_connections`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **API Contract**        | Two public channel endpoints (HMAC + JWT): `POST /api/v1/channels/ai4w/{connectionId}/message` (sync/SSE/async via `X-Response-Mode`) and `GET /api/v1/channels/ai4w/{connectionId}/info` (meta + live `currentDeployment` + auth-health check in one round-trip). Five internal endpoints (service-token + JWT): tenants-by-membership (sorted), **project** discovery (paginated + searchable), project-level provisioning (no agentId), deactivate, unlink. Inbound message body simplified — no `projectId`/`agentName`/`deploymentId` (resolved from connection via shared `DeploymentResolver`). Request/response schemas defined with Zod. All auth failures return uniform 401 (no existence oracle). `X-Response-Mode` / `X-Response-Mode-Used` headers for mode negotiation. AI4W agent ↔ ABL project (not agent/deployment) — admin tunes environment/deploymentId post-provision via existing channel-customization UI. JWT `iss` must appear in the comma-separated `AI4W_TRUSTED_ISSUERS` list; each issuer's JWKS is discovered from `{iss}/.well-known/openid-configuration` at startup and cached per-issuer. JWT `aud` is validated against the single ABL-controlled `AI4W_JWT_AUDIENCE` (default `urn:kore:agentic`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Security Surface**    | **Inbound auth**: Dual-layer — (a) HMAC request signing with ABL-issued `connectionSecret` (authorization + payload integrity), (b) AI4W-issued JWT whose `iss` must appear in `AI4W_TRUSTED_ISSUERS`; JWKS is discovered per-issuer via OIDC (`{iss}/.well-known/openid-configuration`) **lazily on first JWT for that issuer** and cached. One unhealthy issuer cannot poison verification for the others — startup is config-validation only, no network — and a transiently-down issuer self-heals on the first request after it's reachable again (single-flight + failure cooldown via `AI4W_JWKS_COOLDOWN_MS`, default 30s). No pod restart required for recovery. **Best-effort background warmup** at startup attempts to register every allowed issuer (rejections logged at debug, not fatal) so the steady-state happy path pays no first-request discovery RTT. **Cooldown failures are infra failures, not client failures** — `verifyAI4WJWT` throws `ISSUER_UNAVAILABLE` (vs `WRONG_ISSUER` for an unrecognized `iss`), and route handlers do NOT count `ISSUER_UNAVAILABLE` toward the auth-block rate limiter, so an upstream OIDC outage cannot rate-limit-block legitimate clients. **Timing oracle on first-request discovery (accepted risk)**: when warmup is disabled or was failing at boot, the first JWT for an unregistered allowed issuer pays an OIDC discovery RTT (~hundreds of ms) while a JWT for a not-allowlisted `iss` rejects instantly. An attacker with any decoded JWT could use this gap to enumerate which issuers are configured. Accepted because issuer URLs are not secret (they identify Kore SaaS environments), the gap closes after first successful registration, and warmup keeps the gap closed in steady state. HMAC: `SHA256(secret, "inbound:" + requestId + "." + timestamp + "." + rawBody)` with nonce replay protection (Redis SET, 60s TTL) and ±30s timestamp window. The `inbound:` direction prefix prevents cross-direction replay (outbound signatures use `outbound:` prefix). **Timing side-channel**: When a connection is not found, a synthetic HMAC computation delay is applied (constant-time stub with the same cost as a real HMAC verify) to prevent timing oracle attacks that reveal connection existence. JWT: short-lived (5-min), claims: `sub` (AI4W userId), `email`, `accountId`, `aud: urn:kore:agentic`. **JWT issuer validation**: The `iss` claim is matched against the normalized `AI4W_TRUSTED_ISSUERS` list (defaults to `https://work.kore.ai/oidc`; multi-issuer supported). Unlisted issuers are rejected with 401 `WRONG_ISSUER`. The per-issuer discovery doc must self-report the same `issuer` field, preventing a rogue endpoint from claiming someone else's issuer identity. **accountId binding**: First request backfills `config.ai4wAccountId`, subsequent requests enforce match. **Auth failure rate limiting**: 10 failures/60s per source-IP + connectionId pair → 5min block. Keying on IP+connectionId prevents a single attacker from blocking a legitimate connection while still rate-limiting brute force from any single source. **Uniform 401**: All auth failures return identical response. **Credential storage**: ABL-generated `connectionSecret` encrypted AES-256-GCM in `encryptedCredentials`. Shown once (SDK `hosted_exchange` pattern). Hard cut on rotation. **SSRF**: Callback URLs validated on create + update + delivery. Block private IPs, override via `AI4W_TRUSTED_CALLBACK_CIDRS` (validated on startup — invalid entries and prefixes broader than /8 IPv4 or /32 IPv6 are rejected). **DNS rebinding mitigation**: Callback URL delivery resolves DNS explicitly, validates the resolved IP against the private-IP blocklist, and connects to the validated IP (not the hostname) to prevent DNS rebinding attacks where a hostname resolves to a public IP at validation time but a private IP at delivery time. **Raw body**: `express.json({ verify })` preserves bytes for HMAC. **Internal APIs**: Separate port `:3113`, not exposed via K8s ingress. **Outbound auth**: ABL signs callbacks/notifications with same `connectionSecret` (symmetric HMAC, `outbound:` direction prefix in HMAC input). **Input validation**: Zod schemas at route boundary. `z.string().min(1)` for all IDs. 1MB body limit. **JWKS compromise scope**: Each trusted issuer's JWKS is a blast-radius surface independently. Compromise of one issuer's JWKS affects only tokens claiming that `iss` — other issuers' tokens are rejected even if forged with the wrong key (wrong kid / wrong iss). Mitigations: jose's `cooldownDuration` bounds re-fetch rate on `kid` miss; operators rotate keys at the issuer; discovery is re-attempted automatically when an unregistered issuer's `AI4W_JWKS_COOLDOWN_MS` window elapses, and on pod restart. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | All auth failures (HMAC invalid, JWT invalid, connection not found, inactive, blocked) → uniform 401 `{ code: "UNAUTHORIZED", message: "Authentication failed" }` — specific failure reason logged server-side only. Replay detected → 409 Conflict. Rate limited → 429 with `Retry-After`. Agent execution error → 500 with sanitized message (no tenant/model IDs). SSE errors → `event: error` then close. Inbound processing failures (`channel-inbound` queue) → BullMQ retry (3 attempts). Outbound async delivery failures (`webhook-delivery` queue) → BullMQ retry (5 attempts, exponential backoff 3s→48s). Proactive notification errors → circuit breaker + `PendingDeliveryStore` (24h TTL).                                                 |
| 6   | **Failure Modes** | **AI4W unreachable**: Circuit breaker opens after 10 failures (per `connectionId`). Async results stored in `PendingDeliveryStore`. **SSE disconnect**: ABL detects broken pipe, marks for async delivery via callback URL. SSE connections authenticated at request time stay valid through completion — key rotation does NOT terminate open SSE. **Secret rotation**: Hard cut — old key immediately invalid, new key shown once. Coordinate timing out-of-band. **Suspension timeout**: `suspension-timeout-worker` expires after configurable timeout (default 10 min), sends timeout notification to AI4W. **Auth brute force**: Rate limiting blocks source-IP+connectionId pair after 10 failures/60s for 5 minutes.                              |
| 7   | **Idempotency**   | **Proactive notifications**: Redis `SET NX` on `notificationId` with 1h TTL. Duplicate notifications silently dropped. **Async delivery**: BullMQ's built-in job dedup by `requestId`. **Session creation**: `findOrCreate` pattern on composite key — idempotent by design. **Callback processing**: `RedisCallbackRegistry` uses `SET NX` — duplicate callback submissions ignored.                                                                                                                                                                                                                                                                                                                                                                     |
| 8   | **Observability** | Trace events via `TraceStore`: `ai4w.inbound`, `ai4w.delivery.sync`, `ai4w.delivery.stream`, `ai4w.delivery.async`, `ai4w.delivery.proactive`, `ai4w.callback.received`. AI4W includes `traceparent` header (W3C Trace Context) for cross-platform correlation. Circuit breaker state transitions logged and metered. All events include `tenantId`, `connectionId`, `sessionId` for scoped querying. **Connection health diagnostics**: Each connection tracks `lastSuccessfulRequestAt`, `lastErrorAt`, rolling `recentErrorRate` (5-min window), and `authBlockedUntil` — queryable via the channel-namespace `GET /api/v1/channels/ai4w/{connectionId}/info` endpoint (which also doubles as a health probe) for operational dashboards and alerting. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Sync P95 < 3s (non-reasoning agents), up to 30s (complex agents, matching existing chat API). SSE time-to-first-byte < 1s. Rate limit: 100 req/min per tenant (shared with other channels). JWKS cache: 5-min TTL avoids per-request key fetch. Max SSE connection hold time: 120s (`CHANNEL_EXECUTE_TIMEOUT_MS`). Max concurrent SSE connections: 50 per tenant (configurable via `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT`, enforced in route handler — returns 503 when exceeded). Payload size: validated at route boundary (max 1MB request body).                                               |
| 10  | **Migration Path**     | Purely additive — no data migration. New `ChannelConnection` documents with `channelType: 'ai4w'` in existing collection. New sessions with ai4w channel binding in existing collection. The `/api/v1/channels/ai4w` route is always mounted (no feature flag). `AI4W_INTERNAL_API_ENABLED` gates discovery/provisioning endpoints separately since those carry a different auth surface (service token). Tenant-level `tenantConfig.channels.ai4w.enabled` provides per-tenant rollout.                                                                                                          |
| 11  | **Rollback Plan**      | 1. Set every ai4w `ChannelConnection` to `status: 'inactive'` (kills inbound traffic without redeploy). 2. Existing ai4w sessions become inert (no new messages). 3. `AI4W_INTERNAL_API_ENABLED=false` disables new provisioning. 4. No data migration to reverse. 5. AI4W side: disable `ablAgent` type or disconnect `abl_connections`.                                                                                                                                                                                                                                                         |
| 12  | **Test Strategy**      | **E2E (6 scenarios)**: Real ABL runtime on random port, full middleware chain, HTTP API only. AI4W side simulated with lightweight Express servers (callback receiver, notification receiver). Tests: sync round-trip, SSE streaming, async callback, proactive notification, agent discovery, session isolation. **Integration (6 scenarios)**: JWT/JWKS verification (valid/expired/wrong key), circuit breaker activation, SSRF enforcement, rate limiting, notification dedup, offline fallback. **No mocking** of ABL platform components. Only AI4W endpoints simulated (they're external). |

---

## 5. Data Model

### New Collections/Tables

None — all ABL-side data uses existing collections with new document types.

### Schema Modifications Required

The following changes to existing schemas/types are required before implementing this feature:

1. **`connectionId` field on `IChannelConnection`**: The `connectionId` field does not exist on the current `IChannelConnection` interface or Mongoose schema in `channel-connection.model.ts`. It must be added as an optional field (`connectionId?: string`) since only ai4w connections use it. Other channel types continue without it.
2. **`'ai4w'` in `CHANNEL_CONNECTION_TYPES`**: The `CHANNEL_CONNECTION_TYPES` array in `channel-connection.model.ts` (L14-36) does not currently include `'ai4w'`. It must be added to the array so that `channelType: 'ai4w'` documents pass Mongoose enum validation.
3. **`'hmac_jwt'` in `AuthMode`**: The `AuthMode` type in `apps/runtime/src/channels/types.ts` is currently `'hmac' | 'jwt' | 'token' | 'api_key' | 'sdk_auth' | 'none'`. It must be extended to include `'hmac_jwt'` for the ai4w adapter's dual-layer auth mode.
4. **`resolveConnectionByConnectionId` function**: The existing `resolveConnectionByIdInternal` queries by MongoDB `_id`, not by the `connectionId` field. A dedicated `resolveConnectionByConnectionId(connectionId: string)` function is needed that queries by the `connectionId` field, decrypts credentials, and returns the full connection document. This can live alongside the existing resolver or be added as a method on the connection repository.

### Modified Collections/Tables

#### `channel_connections` (existing collection — new `channelType: 'ai4w'` documents)

```typescript
// New fields on ChannelConnection for ai4w
interface AI4WChannelConnection {
  _id: ObjectId; // internal, never exposed externally
  connectionId: string; // public, in URL path — 'ai4w_c_' + crypto.randomBytes(16).hex
  tenantId: string;
  projectId: string;
  channelType: 'ai4w';
  externalIdentifier: string; // auto-generated UUID, not used for lookup
  displayName: string; // e.g., 'AI4W Production'
  status: 'active' | 'inactive';
  // agentId is null for ai4w — connections bind to a project, not an agent.
  // Runtime resolves the live deployment via the shared `DeploymentResolver`
  // (same pattern as Genesys / VXML / Audiocodes).
  deploymentId: string | null; // Pinned deployment (mutually exclusive with `environment`)
  environment: string | null; // Environment name — resolves to the latest active Deployment at message time
  encryptedCredentials: string; // AES-256-GCM encrypted { connectionSecret }
  // connectionSecret: 'abl_cs_' + base64url(crypto.randomBytes(32))
  // ABL generates, shown once after creation, never retrievable
  // Hard cut on rotation (no grace period)
  config: AI4WConnectionConfig;
}

interface AI4WConnectionConfig {
  callbackBaseUrl: string; // AI4W's callback endpoint (SSRF validated on create+update+delivery)
  notificationUrl?: string; // AI4W's proactive notification endpoint (P3)
  responseMode: 'sync' | 'stream' | 'async'; // Default preference
  ai4wAccountId: string | null; // Backfilled from JWT on first request, enforced after
  provisionedBy: 'manual' | 'api'; // How connection was created
  lastUsedAt: Date | null; // Updated periodically (sampled)
  // Connection health diagnostics (updated by adapter, queryable via internal API)
  healthDiagnostics?: {
    lastSuccessfulRequestAt: Date | null; // Timestamp of last successful inbound request
    lastErrorAt: Date | null; // Timestamp of last failed request
    recentErrorRate: number; // Rolling error rate (errors / total) over last 5 min window
    authBlockedUntil: Date | null; // Non-null if connection is currently auth-blocked
  };
}

// Indexes:
//   { connectionId: 1 }  (new, unique, partialFilterExpression: { connectionId: { $type: 'string' } })
//     — partial filter because only ai4w connections have connectionId; other channel types omit it
//   { tenantId: 1, projectId: 1, channelType: 1 }     (existing)
```

#### `sessions` (existing collection — new ai4w channel binding)

```typescript
// Session with ai4w binding
interface AI4WSessionBinding {
  connectionId: string;
  userEmail: string;
  agentContextId: string;
}

// externalSessionKey: 'ai4w:{connectionId}:{base64url(email)}:{agentContextId}'
// channelType: 'ai4w'
// channelBinding: AI4WSessionBinding
// Indexes: { tenantId: 1, externalSessionKey: 1 } (existing, covers ai4w)
```

### Key Relationships

```
channel_connections.connectionId ←── URL path param (public identifier)
channel_connections.connectionId ←── sessions.channelBinding.connectionId
channel_connections.config.ai4wAccountId ←── JWT claim (accountId, backfilled)
channel_connections.tenantId + projectId ←── standard project scope
```

---

## 6. API Design

### New Endpoints

| Method | Path                                                             | Purpose                                                                                                                                                           | Auth                     | Phase |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----- |
| POST   | `/api/v1/channels/ai4w/{connectionId}/message`                   | Inbound message (sync/SSE/async via `X-Response-Mode`)                                                                                                            | HMAC + JWT               | P0    |
| GET    | `/api/v1/channels/ai4w/{connectionId}/info`                      | Connection meta + pinning + live `currentDeployment`. Doubles as health check. HMAC signed over empty body. No session/exec/trace/tenant-rate-limit side effects. | HMAC + JWT               | P4    |
| GET    | `/api/internal/v1/tenants/by-membership?email={email}`           | Discover tenants accessible by email; `name` ascending                                                                                                            | AI4W JWT + service token | P4    |
| GET    | `/api/internal/v1/tenants/{tenantId}/projects/discoverable`      | Project discovery (RBAC filtered, paginated, searchable)                                                                                                          | AI4W JWT + service token | P4    |
| POST   | `/api/internal/v1/channel-connections/provision`                 | Project-level 1-click provisioning (agentId not accepted)                                                                                                         | AI4W JWT + service token | P4    |
| POST   | `/api/internal/v1/channel-connections/{connectionId}/deactivate` | Soft-disable (status=`inactive`), row retained                                                                                                                    | AI4W JWT + service token | P7    |
| DELETE | `/api/internal/v1/channel-connections/{connectionId}`            | Hard-remove an ai4w connection (orphan reaper)                                                                                                                    | AI4W JWT + service token | P7    |

**Removed**:

- `GET /api/internal/v1/tenants/{tenantId}/agents/discoverable` — superseded by `/projects/discoverable`.
- `GET /api/internal/v1/connections/{connectionId}/info` — moved to the public channel namespace at `GET /api/v1/channels/ai4w/{connectionId}/info` so callers holding the connection credentials do not need the internal service token.
- `POST /api/v1/channels/ai4w/{connectionId}/ping` — folded into `/info`, which runs the same auth chain with the same zero-side-effect profile and additionally returns metadata in one round-trip.

### Inbound Message Schema (POST /api/v1/channels/ai4w/{connectionId}/message)

```typescript
// Request — simplified: no projectId, agentName, deploymentId (resolved from connection)
const AI4WMessageSchema = z.object({
  text: z.string().min(1).max(10000),
  agentContextId: z.string().min(1).max(255), // AI4W conversation thread ID
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(50000),
        timestamp: z.string().optional(),
      }),
    )
    .max(100)
    .optional(),
  files: z
    .array(
      z.object({
        name: z.string().max(255),
        mimeType: z.string().max(127),
        signedUrl: z.string().url().max(2048),
      }),
    )
    .max(10)
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Body size limit: express.json({ limit: '1mb' }) on the ai4w route

// Headers
// Authorization: Bearer <AI4W JWT>
// X-Signature-Nonce: <UUID> (nonce for replay protection)
// X-Timestamp: <epoch seconds> (clock skew protection, ±30s window)
// X-Signature: sha256=HMAC-SHA256(connectionSecret, "inbound:" + requestId + "." + timestamp + "." + rawBody)
// X-Response-Mode: sync | stream | async (optional, default from connection config)

// Sync Response (200)
interface AI4WSyncResponse {
  success: true;
  data: {
    response: string;
    sessionId: string;
    contentBlocks?: ContentBlock[]; // Rich content if applicable
    files?: { name: string; signedUrl: string; mimeType: string }[];
  };
}

// SSE Response (200, Content-Type: text/event-stream)
// event: chunk\ndata: {"text":"partial"}\n\n
// event: done\ndata: {"response":"full","sessionId":"..."}\n\n

// Async Response (202)
interface AI4WAsyncAccepted {
  success: true;
  data: {
    requestId: string;
  };
}
```

### Proactive Notification Schema (ABL → AI4W)

```typescript
// ABL POSTs to AI4W's notificationUrl
interface AI4WProactiveNotification {
  notificationId: string; // Unique ID for dedup
  type: 'human_approval' | 'execution_result' | 'auth_challenge';
  targetEmail: string; // AI4W user email
  connectionId: string; // ABL channel connection ID
  payload: {
    callbackId: string; // ABL callback URL for response
    callbackUrl: string; // Full URL: {ablBaseUrl}/api/v1/callbacks/{callbackId}
    title: string;
    description: string;
    actions?: { label: string; value: string }[];
    authUrl?: string; // For auth_challenge type
    expiresAt: string; // ISO timestamp
  };
}

// Headers (same HMAC pattern as inbound, symmetric bidirectional)
// X-Notification-Id: <notificationId>
// X-Timestamp: <epoch>
// X-Signature: sha256=HMAC-SHA256(connectionSecret, "outbound:" + notificationId + "." + timestamp + "." + body)
```

### Project Discovery Schema (GET /api/internal/v1/tenants/{tenantId}/projects/discoverable)

```typescript
// Query params
// ?limit=50                       (default 50, max 200)
// ?cursor=<opaque>                (keyset pagination on (name, _id))
// ?q=<substring>                  (case-insensitive substring on name/description)
// ?sort=name|recent               (default 'name')
// Authorization: Bearer <AI4W JWT with email claim for RBAC>
// X-Service-Token: <shared secret>

// Response (200)
interface DiscoverableProjectsResponse {
  success: true;
  data: {
    projects: {
      id: string;
      name: string;
      description: string;
      agentCount: number; // live count of active deployments in the project
    }[];
    nextCursor: string | null;
  };
}
```

### Tenants-by-Membership Schema (GET /api/internal/v1/tenants/by-membership)

Returns the list of tenants accessible to the caller's email, sorted by `name` ascending. No pagination — tenant counts per user are always small.

### Provisioning Schema (POST /api/internal/v1/channel-connections/provision)

```typescript
// Request — project-level binding; environment/deploymentId are mutually exclusive
const ProvisionConnectionSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    connectionName: z.string().min(1).max(100).optional(), // defaults to `Connection N+1`
    environment: z.string().min(1).optional(), // e.g., 'production'
    deploymentId: z.string().min(1).optional(), // pinned deployment
    callbackBaseUrl: z.string().url().max(2048),
    responseMode: z.enum(['sync', 'stream', 'async']).optional(),
    notificationUrl: z.string().url().optional(),
  })
  .refine((v) => !(v.environment && v.deploymentId), {
    message: 'environment and deploymentId are mutually exclusive',
    path: ['environment'],
  });

// Note: callbackBaseUrl is SSRF-validated before creation.
// `agentId` is not accepted — ai4w connections are bound to a project, not an agent.

// Headers
// Authorization: Bearer <AI4W JWT>
// X-Service-Token: <shared secret>

// Response (201 Created) — returns connectionId + connectionSecret (one-time, internal network only)
interface ProvisionConnectionResponse {
  success: true;
  data: {
    connectionId: string; // 'ai4w_c_' + random hex
    connectionSecret: string; // 'abl_cs_' + base64url — shown once, never again
  };
}
```

### Connection Info / Health Check Schema (GET /api/v1/channels/ai4w/{connectionId}/info)

Public channel endpoint with the same HMAC + JWT + accountId-binding auth chain as `/message`. HMAC is computed over an **empty** request body:

```
payload   = "inbound:" + requestId + "." + timestamp + "." + ""
signature = HMAC-SHA256(connectionSecret, payload)
```

Side-effect profile: full auth chain, **no** session resolution, **no** agent execution, **no** trace writes, **no** tenant-rate-limit consumption. The auth-failure counter still increments on failure so bad creds are blocked after the threshold.

```typescript
interface ConnectionInfoResponse {
  success: true;
  data: {
    connectionId: string;
    channelType: 'ai4w';
    status: 'active' | 'inactive';
    displayName: string | null;
    tenantId: string;
    tenantName: string | null;
    projectId: string;
    projectName: string | null;
    agentCount: number; // live count of active deployments in the project
    config: {
      callbackBaseUrl: string | null;
      responseMode: 'sync' | 'stream' | 'async';
    };
    pinning: {
      deploymentId: string | null;
      environment: string | null; // exactly one non-null, or both null (unpinned)
    };
    currentDeployment: {
      deploymentId: string;
      entryAgentName: string;
      label: string | null;
      createdAt: string;
    } | null; // null when the project has no resolvable active deployment
  };
}
```

`currentDeployment` is resolved live via the same query path as `DeploymentResolver`. `connectionSecret` is never returned. On auth failure the response is a uniform 401 identical in shape to `/message` (no existence oracle).

This endpoint replaces both the former internal `GET /api/internal/v1/connections/{connectionId}/info` and the standalone `POST /ping` — it performs the same auth chain as `/ping` and returns the metadata the linked-app banner needs in one round-trip.

### Deactivate / Unlink Schemas

- `POST /api/internal/v1/channel-connections/{connectionId}/deactivate` — sets `status='inactive'`; in-flight sessions drain naturally; new requests rejected with uniform 401. Response: `{success:true, data:{status:'inactive'}}`. Reactivation happens through the existing ABL channel-customization UI.
- `DELETE /api/internal/v1/channel-connections/{connectionId}` — hard-removes the row. Scoped to `channelType='ai4w'` (rejects attempts on other channel types with 404). Response: `{success:true, data:{deleted:true}}`.

### Error Responses

| Code | Condition                                                                 | Response                                                                                     |
| ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400  | Invalid request body / missing fields                                     | `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }`                    |
| 401  | HMAC invalid, JWT invalid/expired, connection not found/inactive, blocked | `{ success: false, error: { code: "UNAUTHORIZED", message: "Authentication failed" } }`      |
| 409  | Replay detected (duplicate X-Signature-Nonce)                             | `{ success: false, error: { code: "CONFLICT", message: "Duplicate request" } }`              |
| 429  | Tenant rate limit exceeded                                                | `{ success: false, error: { code: "RATE_LIMITED", message: "..." } }` + `Retry-After` header |
| 500  | Agent execution error                                                     | `{ success: false, error: { code: "EXECUTION_ERROR", message: "<sanitized>" } }`             |
| 503  | Circuit breaker open / SSE connections exhausted                          | `{ success: false, error: { code: "SERVICE_UNAVAILABLE", message: "..." } }`                 |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Security-sensitive operations emit audit events: `ai4w.connection.created`, `ai4w.connection.rotated`, `ai4w.connection.deactivated`, `ai4w.connection.deleted`, `ai4w.connection.callback_changed`, `ai4w.auth.failed`, `ai4w.auth.blocked`, `ai4w.connection.account_bound`. Discovery API calls logged with requesting email and filtered agent count. Provisioning operations logged with `accountId`, `projectId`, and created `connectionId`.
- **Rate Limiting**: Shared tenant rate limit (`100 req/min` default) via `getHybridRateLimiter().check()`. AI4W requests count against the same tenant quota as other channels. Auth failure rate limiting: Redis counter per source-IP+connectionId pair, block after 10 failures in 60s for 5 minutes.
- **Caching**: Per-issuer JWKS resolvers cached lazily in a module-level `Map<issuer, createRemoteJWKSet>` (jose handles kid-level caching + cooldown internally). Successful registrations cached indefinitely; failed registrations cached only for `AI4W_JWKS_COOLDOWN_MS` (default 30s) before automatic retry on the next request. A concurrent-registration guard (single-flight Promise per issuer) prevents thundering herd during a recovery event. Connection lookup by `connectionId` unique index (no additional cache needed). No per-connection JWKS cache.
- **Encryption**: ABL-generated `connectionSecret` encrypted AES-256-GCM in `encryptedCredentials` (reversible — needed for HMAC validation). JWT tokens in transit over TLS. No PII beyond email in JWT claims.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                          | Type                                      | Risk                                   |
| --------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Channel Manifest + Adapter Interface                | Core pattern                              | None — STABLE, well-documented         |
| `jose` (npm, already in runtime)                    | JWT/JWKS verification                     | None — already used by msteams-adapter |
| `SessionResolver`                                   | Session management                        | None — STABLE                          |
| `ConnectionResolver` + `encryptionPlugin`           | Connection lookup + credential decryption | None — STABLE                          |
| `RedisCircuitBreaker` (`packages/circuit-breaker/`) | Outbound resilience                       | Low — ALPHA but used by other features |
| `HybridRateLimiter`                                 | Rate limiting                             | None — STABLE                          |
| `ChannelDispatcher` (3-tier delivery)               | Proactive notification routing            | Low — STABLE for existing channels     |
| BullMQ `webhook-delivery` queue                     | Async callback delivery                   | None — STABLE, used by http_async      |
| `SuspendedExecution` + `RedisCallbackRegistry`      | Human approval flow                       | Low — used by A2A (BETA)               |
| `PendingDeliveryStore`                              | Offline delivery buffering                | None — exists, Redis LIST per session  |

### Downstream (depends on this feature)

| Consumer                            | Impact                                                |
| ----------------------------------- | ----------------------------------------------------- |
| AI4W `ABLGatewayService` (external) | Primary consumer — sends messages, receives callbacks |
| AI4W `ablAgent` type (external)     | Agent type that invokes ABL via this channel          |
| Studio channel catalog              | UI entry for ai4w connection setup                    |

---

## 9. Open Questions & Decisions Needed

0. **`/info` rate-limit policy (EVA-6527)**: `GET /api/v1/channels/ai4w/{connectionId}/info` currently does not consume tenant rate-limit quota. Should it remain exempt (cheap periodic health probes), share the `/message` bucket, or sit on its own generous bucket (e.g. 60/min)? All options still feed the auth-failure counter. Tracked in `docs/sdlc-logs/ai4w-abl-channel-integration/open-items-eva-6527.log.md`. Default until decided: option (a) — exempt.
1. **Internal API port strategy**: Should discovery/provisioning APIs run on a separate Express port (`:3113`) or use middleware-based enforcement on the main port? Separate port is more secure but adds deployment complexity. **Recommendation**: Separate port for P4, with middleware fallback option.
2. **ABL tenant ↔ AI4W account mapping cardinality**: 1:1 or 1:N? Multiple tenants per AI4W account complicates discovery filtering. **Recommendation**: 1:1 for P0-P4, revisit for P6 (cross-environment).
3. **Proactive messaging infrastructure**: Feature spec notes proactive messaging is PLANNED (GAP-005). For P3, should the ai4w adapter implement custom proactive delivery, or wait for the proactive messaging pipeline? **Recommendation**: Custom delivery in ai4w adapter for P3, integrate with proactive messaging pipeline when it ships.
4. **FR-5/FR-6/FR-7 (AI4W-side FRs)**: These functional requirements are AI4W-scoped (`ablAgent` type, `ABLGatewayService`, `liveUpdates` streaming) — N/A for this ABL-scoped HLD. Implementation lives in KoreServer repo.
5. **Shared BullMQ queue blast radius**: ai4w async messages share `channel-inbound` queue with other channels. A poisoned ai4w job could affect other channels. **Recommendation**: Acceptable for P0-P1. Monitor. Per-channel-type queue partitioning available as future mitigation if needed.

---

## 10. References

- Feature spec: `docs/features/ai4w-abl-channel-integration.md`
- Design doc (authoritative for auth, Studio UX, endpoints): `docs/design/ai4w-abl-channel-ux-design.md`
- Test spec: `docs/testing/ai4w-abl-channel-integration.md`
- Channels HLD: `docs/specs/channels.hld.md`
- Channel manifest: `apps/runtime/src/channels/manifest.ts`
- Channel adapter interface: `apps/runtime/src/channels/types.ts`
- MS Teams adapter (JWKS reference): `apps/runtime/src/channels/adapters/msteams-adapter.ts`
- HTTP Async channel (async reference): `apps/runtime/src/routes/http-async-channel.ts`
- Channel dispatcher: `apps/runtime/src/services/execution/channel-dispatcher.ts`
- Webhook delivery worker: `apps/runtime/src/services/queues/delivery-worker.ts`
- Callback registry: `packages/execution/src/callback-registry.ts`
- Circuit breaker: `packages/circuit-breaker/src/redis-circuit-breaker.ts`
