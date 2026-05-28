# LLD: AI4W-ABL Channel Integration

**Feature Spec**: `docs/features/ai4w-abl-channel-integration.md`
**HLD**: `docs/specs/ai4w-abl-channel-integration.hld.md`
**Test Spec**: `docs/testing/ai4w-abl-channel-integration.md`
**Status**: DRAFT
**Date**: 2026-04-22
**Jira**: ABLP-420

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                         | Rationale                                                                                                                                                                                                                                                                                                                                               | Alternatives Rejected                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Follow feature spec P0-P6 phasing, reorganize within each phase data-layer-first | Feature spec has explicit exit criteria per phase; data-layer-first prevents forward references                                                                                                                                                                                                                                                         | Flat implementation (loses incremental delivery)                                                                                                                                  |
| D-2  | Fully detail P0+P1, skeleton P2-P3, interface-only P4-P6                         | P0+P1 share core infra (route handler, adapter, session); P2+ are additive                                                                                                                                                                                                                                                                              | P0-only LLD (leaves P1 SSE/async unplanned — high rework risk)                                                                                                                    |
| D-3  | Always include `'ai4w'` in `ChannelType` union unconditionally                   | Compile-time type; feature flags are runtime; all existing types are unconditional                                                                                                                                                                                                                                                                      | Conditional type inclusion (not possible in TypeScript)                                                                                                                           |
| D-4  | msteams-adapter.ts as primary reference pattern                                  | Only existing adapter with JWT/JWKS auth; slack-adapter for HMAC reference                                                                                                                                                                                                                                                                              | http-async-adapter (no JWT or HMAC)                                                                                                                                               |
| D-5  | Per-issuer JWKS via OIDC discovery from each `AI4W_TRUSTED_ISSUERS` entry        | Multi-env SaaS (work / work-qa / work-sit) + on-prem share one pod; discovery resolves jwks_uri + self-verifies issuer field. Supersedes the original single-issuer `AI4W_JWKS_URI` design.                                                                                                                                                             | Single JWKS URI (insufficient for multi-env), paired issuer+jwks arrays (fragile — same effect, more config)                                                                      |
| D-5b | Lazy per-issuer JWKS registration with single-flight + failure cooldown          | Production incident: simultaneous deploys in work-dev and agent-dev caused one issuer's discovery to fail at startup, which `throw`'d out of the issuer loop and left ALL issuers unregistered until pod restart. Lazy registration isolates failures to the affected issuer and self-heals on first request after recovery (no operator intervention). | Eager-fail-fast (one issuer down → broken until restart), background TTL refresh (wastes RTT for healthy issuers), kid-level LRU (doesn't fix the issuer-registration bottleneck) |
| D-9  | Dual-layer auth: HMAC (authorization) + JWT (identity)                           | HMAC proves payload integrity + connection auth; JWT proves end-user identity (email). Separation of concerns                                                                                                                                                                                                                                           | JWT-only (no payload integrity), HMAC-only (no user identity), mTLS (complex)                                                                                                     |
| D-10 | connectionId in URL path (random UUID, not MongoDB \_id)                         | Enables LB rate limiting, WAF rules, access log correlation. Random UUID prevents enumeration                                                                                                                                                                                                                                                           | Flat endpoint (no per-connection routing), MongoDB \_id in path (predictable)                                                                                                     |
| D-11 | Simplified request body (no projectId/agentName/deploymentId)                    | All agent identity resolved from connection — fewer copy-paste errors for AI4W integrators                                                                                                                                                                                                                                                              | Full agent identity in body (redundant with connection config)                                                                                                                    |
| D-12 | Hard cut on secret rotation (no grace period)                                    | Simpler, more secure. Grace period adds complexity for marginal operational benefit                                                                                                                                                                                                                                                                     | Grace period with previousSecretHash (complex, marginal benefit)                                                                                                                  |
| D-13 | Auto-generated externalIdentifier (not used for connection lookup)               | ai4w uses connectionId from URL path for routing, unlike Slack/Teams which use externalIdentifier                                                                                                                                                                                                                                                       | ai4wAccountId as externalIdentifier (wrong — not unique across connections)                                                                                                       |
| D-6  | Reuse `writeSSE` pattern from chat.ts for SSE streaming                          | Proven pattern in codebase; no shared SSE module exists                                                                                                                                                                                                                                                                                                 | External SSE library (unnecessary dependency)                                                                                                                                     |
| D-7  | Proactive notification via direct HTTP POST, not ChannelDispatcher tiers         | ChannelDispatcher targets same-session WS/pub-sub; proactive targets external platform by email                                                                                                                                                                                                                                                         | Route through ChannelDispatcher (wrong abstraction — not session-bound)                                                                                                           |
| D-8  | Delivery worker pre-signed payloads for ai4w                                     | Avoids modifying `resolveWebhookSecret` path; adapter signs before enqueue                                                                                                                                                                                                                                                                              | Modify delivery-worker to resolve ChannelConnection creds (higher blast radius)                                                                                                   |

### Key Interfaces & Types

```typescript
// === New in apps/runtime/src/channels/types.ts ===

// Add to ChannelType union:
| 'ai4w'

// === New in apps/runtime/src/channels/adapters/ai4w-types.ts ===

export interface AI4WConnectionConfig {
  callbackBaseUrl: string;         // SSRF-validated on create + update + delivery
  notificationUrl?: string;        // For proactive notifications (P3)
  responseMode: 'sync' | 'stream' | 'async'; // Default preference, overridable per-request
  ai4wAccountId: string | null;    // Backfilled from JWT on first request, enforced after
  provisionedBy: 'manual' | 'api'; // How connection was created
  lastUsedAt: Date | null;         // Updated periodically (sampled)
}

export interface AI4WSessionBinding {
  connectionId: string;            // From URL path, NOT MongoDB _id
  userEmail: string;
  agentContextId: string;
}

export interface AI4WJWTClaims {
  sub: string;       // AI4W userId (NOT accountId — not used by ABL)
  email: string;     // Used for session scoping
  accountId: string; // AI4W org — enforced via connection binding
  iss: string;       // AI4W instance URL
  aud: string;       // Must equal 'urn:kore:agentic'
  scope?: string;
  product?: string;
  iat: number;
  exp: number;
}

export interface AI4WProactiveNotification {
  notificationId: string;
  type: 'human_approval' | 'execution_result' | 'auth_challenge';
  targetEmail: string;
  connectionId: string;
  payload: {
    callbackId: string;
    callbackUrl: string;
    title: string;
    description: string;
    actions?: { label: string; value: string }[];
    authUrl?: string;
    expiresAt: string;
  };
}
```

### Module Boundaries

| Module                  | Responsibility                                                                                                   | Depends On                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ai4w-auth.ts`          | HMAC verification, JWT/JWKS validation, replay protection (nonce), accountId binding, auth failure rate limiting | `jose`, `crypto`, Redis                                        |
| `ai4w-adapter.ts`       | ChannelAdapter impl: verify, parse, send, transform                                                              | ai4w-auth, ai4w-types                                          |
| `ai4w-channel.ts`       | Route handler: `POST /{connectionId}/message`, sync/SSE/async, raw body preservation                             | ai4w-auth, ai4w-adapter, session-resolver, connection lookup   |
| `ai4w-proactive.ts`     | Outbound proactive notification delivery + async callback signing                                                | ai4w-types, circuit-breaker, connectionSecret (symmetric HMAC) |
| `internal-discovery.ts` | Agent discovery + provisioning API (P4)                                                                          | connection model, project membership                           |

---

## 2. File-Level Change Map

### New Files

| File                                                             | Purpose                                                                                                        | LOC Estimate | Phase |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ | ----- |
| `apps/runtime/src/channels/adapters/ai4w-types.ts`               | Type definitions for AI4W connection config, JWT claims, notifications                                         | ~80          | P0    |
| `apps/runtime/src/channels/adapters/ai4w-auth.ts`                | HMAC verification, JWT/JWKS validation, nonce replay protection, accountId binding, auth failure rate limiting | ~200         | P0    |
| `apps/runtime/src/channels/adapters/ai4w-adapter.ts`             | ChannelAdapter implementation                                                                                  | ~200         | P0    |
| `apps/runtime/src/routes/ai4w-channel.ts`                        | Route handler: POST /{connectionId}/message (sync, SSE, async) + raw body preservation                         | ~300         | P0+P1 |
| `apps/runtime/src/channels/adapters/ai4w-content-transformer.ts` | Rich content transformer: RichContentIR → markdown + structured templates                                      | ~100         | P2    |
| `apps/runtime/src/channels/adapters/ai4w-proactive.ts`           | Proactive notification delivery (HTTP POST, circuit breaker, dedup)                                            | ~150         | P3    |
| `apps/runtime/src/routes/internal-discovery.ts`                  | GET discoverable agents, POST provision connection                                                             | ~200         | P4    |
| `apps/runtime/src/__tests__/ai4w-channel.e2e.test.ts`            | E2E: sync round-trip, session isolation                                                                        | ~300         | P0    |
| `apps/runtime/src/__tests__/ai4w-auth.test.ts`                   | Integration: JWT/JWKS verification scenarios                                                                   | ~200         | P0    |
| `apps/runtime/src/__tests__/ai4w-streaming.e2e.test.ts`          | E2E: SSE streaming, async callback                                                                             | ~250         | P1    |
| `apps/runtime/src/__tests__/ai4w-proactive.e2e.test.ts`          | E2E: proactive notifications, dedup                                                                            | ~300         | P3    |
| `apps/runtime/src/__tests__/ai4w-discovery.e2e.test.ts`          | E2E: agent discovery, provisioning                                                                             | ~250         | P4    |

### Modified Files

| File                                                                   | Change Description                                                                                                                                                           | Risk | Phase |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| `apps/runtime/src/channels/types.ts`                                   | Add `'ai4w'` to `ChannelType` union (L46)                                                                                                                                    | Low  | P0    |
| `apps/runtime/src/channels/manifest.ts`                                | Add `'hmac_jwt'` to `AuthMode` type (L24); add `ai4w` entry to `CHANNEL_MANIFEST`                                                                                            | Low  | P0    |
| `apps/runtime/src/channels/registry.ts`                                | Register `AI4WAdapter` in `getChannelRegistry()` (conditional on flag)                                                                                                       | Low  | P0    |
| `apps/runtime/src/channels/session-resolver.ts`                        | Add `'ai4w'` case to `mapChannelTypeToConversationChannel` (L65-92)                                                                                                          | Low  | P0    |
| `packages/database/src/models/channel-connection.model.ts`             | Add `connectionId` field (type: `String`, unique sparse index with partial filter `{ connectionId: { $type: 'string' } }`), add `'ai4w'` to `CHANNEL_CONNECTION_TYPES` array | Med  | P0    |
| `apps/runtime/src/channels/connection-resolver.ts`                     | Add `resolveConnectionByConnectionId(connectionId, channelType)` — queries by `connectionId` field (not `_id`), decrypts credentials                                         | Med  | P0    |
| `apps/runtime/src/server.ts`                                           | Mount ai4w route (L760-764 area), feature-flag gated                                                                                                                         | Low  | P0    |
| `apps/studio/src/components/deployments/channels/types.ts`             | Add `'ai4w'` to `ChannelTypeId` union                                                                                                                                        | Low  | P0    |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx` | Add `ai4w` catalog entry with credential fields                                                                                                                              | Low  | P0    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: P0 — Foundation (Sync Messaging + Auth)

**Goal**: AI4W can send a message to an ABL agent via `POST /api/v1/channels/ai4w/{connectionId}/message` with dual-layer auth (HMAC + JWT) and receive a synchronous response.

**Tasks**:

1.1. **Add `'ai4w'` to channel type system**

- Add `| 'ai4w'` to `ChannelType` union in `apps/runtime/src/channels/types.ts` (before `'a2a'` on line 46)
- Add `| 'hmac_jwt'` to `AuthMode` type in `apps/runtime/src/channels/manifest.ts` (L24, currently only has `'hmac' | 'jwt' | 'token' | 'api_key' | 'sdk_auth' | 'none'`)
- Add `'ai4w'` to `CHANNEL_CONNECTION_TYPES` array in `packages/database/src/models/channel-connection.model.ts`
- Add `ai4w` entry to `CHANNEL_MANIFEST` in `apps/runtime/src/channels/manifest.ts`:
  ```
  ai4w: {
    displayName: 'AI4W',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'hmac_jwt',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],  // ABL generates creds — no user-entered credentials
    webhookPathPattern: null,
    isVoice: false,
    supportsTypingIndicator: false,
  }
  ```
- Add `'ai4w'` case to `mapChannelTypeToConversationChannel` in `session-resolver.ts` (falls through to `default: return 'web_chat'` — no explicit case needed, but add a comment for clarity)

  1.2. **Create AI4W type definitions**

- Create `apps/runtime/src/channels/adapters/ai4w-types.ts` with:
  - `AI4WConnectionConfig` interface
  - `AI4WSessionBinding` interface
  - `AI4WJWTClaims` interface
  - Zod schemas (simplified — no projectId/agentName/deploymentId):
    ```typescript
    export const AI4WMessageSchema = z.object({
      text: z.string().min(1).max(10000),
      agentContextId: z.string().min(1).max(255),
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
    export const AI4WResponseModeSchema = z.enum(['sync', 'stream', 'async']);
    ```
  - Session key builder: `buildAI4WSessionKey(connectionId, email, agentContextId)` — applies `base64url` encoding to email
  - connectionId generator: `generateConnectionId()` → `'ai4w_c_' + crypto.randomBytes(16).toString('hex')`
  - connectionSecret generator: `generateConnectionSecret()` → `'abl_cs_' + base64url(crypto.randomBytes(32))`

    1.3. **Implement dual-layer auth (HMAC + JWT)**

- Create `apps/runtime/src/channels/adapters/ai4w-auth.ts` with:
  - **HMAC verification**: `verifyHmac(rawBody: Buffer, connectionSecret: string, requestId: string, timestamp: string, signature: string): boolean`
    - Compute expected: `HMAC-SHA256(secret, "inbound:" + requestId + "." + timestamp + "." + rawBody)` — direction prefix (`inbound:` for AI4W→ABL, `outbound:` for ABL→AI4W) prevents cross-direction signature reuse
    - Constant-time compare with `X-Signature` (strip `sha256=` prefix)
    - Validate `X-Timestamp` within ±30s window (`AI4W_HMAC_TIMESTAMP_TOLERANCE_MS`)
  - **Replay protection**: `checkReplay(connectionId: string, requestId: string): Promise<boolean>`
    - Redis `SET ai4w:nonce:{connectionId}:{requestId} EX 60 NX` — returns false if already exists (replay)
  - **JWT verification**: `verifyAI4WJWT(token: string): Promise<AI4WJWTClaims>`
    - Per-issuer `createRemoteJWKSet` registry populated **lazily** (on first JWT for an unregistered issuer); failed registrations recorded with timestamp and re-attempted automatically after `AI4W_JWKS_COOLDOWN_MS`
    - `initAI4WAuth()` at startup is **config-validation only** — parses `AI4W_TRUSTED_ISSUERS` (default `https://work.kore.ai/oidc`) into an allowlist + applies `AI4W_ISSUER_JWKS_OVERRIDES`. **NO network calls**, so the pod always boots clean even when every upstream issuer is down
    - `registerIssuer(iss)` does the OIDC discovery (`{iss}/.well-known/openid-configuration`); the discovery doc's `issuer` field must equal the configured URL (rogue-endpoint self-consistency check). Single-flight via in-flight Promise map keyed on `iss` so concurrent requests share one fetch
    - `AI4W_ISSUER_JWKS_OVERRIDES` (JSON map) bypasses discovery for issuers that don't publish OIDC metadata — these issuers register on first use without a network call to discovery
    - Decode `iss` (unverified) → reject if not in allowlist (401 `WRONG_ISSUER`). If allowed but unregistered: outside cooldown → `registerIssuer()` then verify; inside cooldown → 401 `WRONG_ISSUER` (cached failure)
    - Validate `aud === AI4W_JWT_AUDIENCE` (default `urn:kore:agentic`, single ABL-controlled value)
    - Extract `email`, `accountId` claims
    - **Recovery characteristic**: when a previously-down issuer comes back online, the **first JWT request** for that issuer triggers re-registration and succeeds in the same request (paying one OIDC discovery RTT, bounded by `AI4W_OIDC_DISCOVERY_TIMEOUT_MS`). Zero requests fail. No pod restart required.
  - **accountId binding**: `enforceAccountIdBinding(connection, jwtAccountId: string): Promise<void>`
    - If `connection.config.ai4wAccountId === null`: backfill via `findOneAndUpdate({ _id, 'config.ai4wAccountId': null }, { $set: { 'config.ai4wAccountId': jwtAccountId } })`
    - If `connection.config.ai4wAccountId !== jwtAccountId`: throw auth error
  - **Auth failure rate limiting**: `checkAuthBlock(connectionId: string, sourceIp: string): Promise<boolean>` and `recordAuthFailure(connectionId: string, sourceIp: string): Promise<void>`
    - Redis key `ai4w:auth:fail:{sourceIp}:{connectionId}` (TTL 60s, INCR on failure) — per-source-IP+connectionId pair prevents a single attacker from blocking legitimate traffic on a shared connectionId
    - After `AI4W_AUTH_BLOCK_THRESHOLD` (default 10) → set block key `ai4w:auth:block:{sourceIp}:{connectionId}` (TTL `AI4W_AUTH_BLOCK_DURATION_MS`, default 5min)
    - Emit `ai4w.auth.blocked` trace event
  - Error handling: `AI4WAuthError` class with codes: `HMAC_INVALID`, `REPLAY_DETECTED`, `TIMESTAMP_EXPIRED`, `INVALID_TOKEN`, `EXPIRED_TOKEN`, `WRONG_AUDIENCE`, `ACCOUNT_MISMATCH`, `AUTH_BLOCKED`
- Follow `msteams-adapter.ts` L73 pattern for JWKS, `slack-adapter.ts` for HMAC reference

  1.4. **Implement AI4W channel adapter**

- Create `apps/runtime/src/channels/adapters/ai4w-adapter.ts` implementing `ChannelAdapter`:
  - `channelType: 'ai4w' as ChannelType`
  - `capabilities: { supportsAsync: true, supportsStreaming: true, supportsMedia: true, supportsThreading: true }`
  - `verifyRequest(headers, body, rawBody, connection)`: Full dual-layer auth — HMAC verification (using `rawBody` and decrypted `connectionSecret`), JWT verification (global JWKS), accountId binding check. Return `true` if all pass, `false` if not. Note: `verifyRequest` returns `Promise<boolean>` per the `ChannelAdapter` interface — it does NOT attach claims. JWT claims are extracted separately by the route handler.
  - `parseIncoming(payload)`: Extract text, externalSessionKey (built from JWT claims), metadata from `InboundJobPayload`. Return `NormalizedIncomingMessage`.
  - `sendResponse(message, connection)`: For sync mode, this is a no-op (route handler sends directly). For async, enqueue to `webhook-delivery` queue with pre-signed HMAC headers.
  - `transformOutput(text, actions, richContent)`: Return `{ kind: 'text', text }` for P0. Rich content transformation deferred to P2.

    1.5. **Register adapter**

- In `apps/runtime/src/channels/registry.ts`, register unconditionally
  alongside the other channel adapters:

  ```typescript
  registryInstance.register(new AI4WAdapter());
  ```

  Import `AI4WAdapter` from `./adapters/ai4w-adapter.js`. The channel is
  always enabled; there is no feature flag on the public `/api/v1/channels/ai4w`
  path (the internal provisioning API is separately gated by
  `AI4W_INTERNAL_API_ENABLED` since it carries a service-token auth surface).

  1.6. **Create sync route handler**

- Create `apps/runtime/src/routes/ai4w-channel.ts`:
  - `Router()` with `POST /:connectionId/message` endpoint
  - Use `express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } })` — preserves raw bytes for HMAC verification
  - **No route-level `authMiddleware` or `tenantRateLimit`** — dual-layer auth handled inline, rate limiting applied AFTER connection resolution
  - Request flow:
    1. Extract `connectionId` from `req.params.connectionId`
    2. **Check auth failure rate limit** — call `checkAuthBlock(connectionId, sourceIp)`. If blocked → return uniform 401
    3. **Lookup connection** — via `resolveConnectionByConnectionId(connectionId, 'ai4w')`. If not found or inactive → add synthetic HMAC delay (`await timingSafeDummyHmac(AI4W_HMAC_DELAY_MS)`) to prevent timing side-channel that leaks connection existence, then return uniform 401. Note: `timingSafeDummyHmac` performs a dummy HMAC-SHA256 computation against a static key (not a fixed-time sleep) so the delay profile matches real HMAC verification regardless of system load or timing variability. (NOT 404 — no existence oracle). Decrypt `connectionSecret` from `encryptedCredentials`.
    4. **Verify HMAC** — extract `X-Signature-Nonce`, `X-Timestamp`, `X-Signature` headers. Call `verifyHmac(req.rawBody, connectionSecret, requestId, timestamp, signature)`. On failure → `recordAuthFailure(connectionId, sourceIp)`, return uniform 401. Validate timestamp ±30s → 401. Check replay `checkReplay(connectionId, requestId)` → 409 if duplicate.
    5. **Verify JWT** — extract `Authorization: Bearer <token>`. Call `verifyAI4WJWT(token)`, which decodes `iss`, checks it against the `AI4W_TRUSTED_ISSUERS` allowlist, lazily registers the issuer's JWKS if needed (single-flight + failure cooldown — see §1.3), then verifies signature + single ABL-controlled `aud`. On failure → `recordAuthFailure(connectionId, sourceIp)`, return uniform 401 (`WRONG_ISSUER`, `WRONG_AUDIENCE`, `EXPIRED_TOKEN`, `INVALID_TOKEN` collapse to the same wire response).
    6. **Enforce accountId binding** — call `enforceAccountIdBinding(connection, claims.accountId)`. On mismatch → 401. On first request → backfill.
    7. Derive `tenantId` from resolved connection. Set `req.tenantContext = { tenantId: connection.tenantId }`.
    8. Validate body with `AI4WMessageSchema.safeParse(req.body)`. On failure → 400.
    9. **Apply rate limiting** — `getHybridRateLimiter().check(connection.tenantId, 'request', limit, 60000)`. If not allowed → 429 with `Retry-After`.
    10. Build external session key: `buildAI4WSessionKey(connectionId, claims.email, body.agentContextId)`
    11. Resolve/create session via session pipeline (scoped by `connection.tenantId`, `connection.projectId`)
    12. Execute agent via runtime executor (using `connection.deploymentId` — resolved from connection, not request body)
    13. Return sync response: `{ success: true, data: { response, sessionId } }`
    14. Set `X-Response-Mode-Used: sync` header
  - **All 401 responses use identical body**: `{ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }` — specific failure reason logged server-side only with connectionId + source IP
  - Emit trace events: `ai4w.inbound`, `ai4w.delivery.sync`
  - **Tenant isolation**: `tenantId` derived from the resolved connection (NOT from request body). All session queries include `tenantId`. Project isolation implicit — each connection belongs to exactly one project.
  - **Auth order rationale**: HMAC verified before JWT because HMAC is cheaper (no JWKS network call) and proves request is from an authorized source. JWT only verified after HMAC passes. Auth failure rate limiting checked first (cheapest — Redis GET).

    1.7. **Mount route in server.ts**

- In `apps/runtime/src/server.ts`, mount the public AI4W channel before generic `channelWebhooksRouter` (around L760):

  ```typescript
  app.use('/api/v1/channels/ai4w', ai4wChannelRouter);
  ```

  Must be before `app.use('/api/v1/channels', channelWebhooksRouter)` to prevent catch-all

  1.8. **Add Studio channel catalog entry**

- Add `| 'ai4w'` to `ChannelTypeId` union in `apps/studio/src/components/deployments/channels/types.ts`
- In `apps/studio/src/components/deployments/channels/channel-registry.tsx`, add `ai4w` entry:
  - `id: 'ai4w'`, `name: 'AI4W'`, `description: 'AIforWork platform integration'`
  - `category: 'messaging'`
  - `available: true`
  - `capabilities: { multiConnection: true, hasCredentials: false, hasWebhookUrl: false, supportsTest: false, supportsDeliveryLog: false, autoGenerateIdentifier: true, supportsPauseResume: true }`
  - `icon`: Use `Globe` from lucide-react
  - `webhookPath: null`
  - `externalIdentifierLabel: 'Connection ID'`
  - `externalIdentifierPlaceholder: 'Auto-generated'`
  - `setupInstructions`: JSX — copy endpoint + connectionId + secret into AI4W agent config
  - `credentialFields: []` — empty (ABL generates credentials, no user-entered fields)
  - Create form fields: display name (text, required), callback URL (text, required, SSRF validated with DNS rebinding mitigation — resolve DNS, validate resolved IP is not private/internal, connect to validated IP), deployment selector
  - SSRF validation error message: "Callback URL must be a publicly routable address. Private/internal IP ranges are not allowed."
  - Post-creation credential reveal: endpoint URL + connectionId + connectionSecret (SDK `hosted_exchange` pattern, shown once)
  - Connection list view: include "Last Active" column (from `config.lastUsedAt`)
  - Connection detail tabs: Overview, Configuration, Deployment, Security (key rotation with hard cut). Integrate Security tab with `TAB_DEFINITIONS` framework.
  - **Overview tab health diagnostics**: Last successful request timestamp, error rate (24h), auth block status
  - **Rotation confirmation dialog**: "Are you sure? This will immediately invalidate the current secret. Any integration using the old secret will stop working." with Confirm / Cancel buttons
  - **Deactivation confirmation dialog**: "This will reject all incoming requests. You can reactivate later." with Confirm / Cancel buttons
  - **Deletion confirmation dialog**: "This will permanently remove the connection and all associated session data. This cannot be undone." with Delete / Cancel buttons (destructive style on Delete)
  - Add `'ai4w'` to `CHANNEL_CATALOG_ORDER` array in the messaging group

    1.9. **Write E2E and integration tests**

- `ai4w-channel.e2e.test.ts`: Start real ABL runtime on random port. Create test tenant, project, deployment, agent. Create ai4w channel connection with generated connectionId + connectionSecret. Generate valid JWT signed with test JWKS. HMAC-sign each request. Test:
  - Sync message round-trip (send HMAC-signed message with JWT, receive agent response)
  - HMAC verification failure (wrong secret, tampered body) → uniform 401
  - JWT verification failure (expired, wrong key, wrong audience) → uniform 401
  - Replay protection (duplicate X-Signature-Nonce) → 409
  - Timestamp outside window (stale request) → 401
  - accountId binding (first request backfills, second request with different accountId → 401)
  - Session creation with composite key `ai4w:{connectionId}:{email}:{contextId}`
  - Connection not found → uniform 401 (NOT 404)
  - Cross-user session isolation (different emails → different sessions)
  - Auth failure rate limiting (11+ failures → blocked for 5 min → 401)
- `ai4w-auth.test.ts`: Integration tests for `ai4w-auth.ts`:
  - Valid HMAC → passes
  - Invalid HMAC → fails
  - Replay nonce → detected
  - Valid JWT → claims returned
  - Expired JWT → fails
  - Wrong audience JWT → fails
  - Wrong signing key JWT → fails
  - accountId binding backfill (idempotent findOneAndUpdate)
  - accountId binding mismatch → fails

**Files Touched**:

- `apps/runtime/src/channels/types.ts` — add `'ai4w'` to `ChannelType` union
- `apps/runtime/src/channels/manifest.ts` — add `'hmac_jwt'` to `AuthMode` type, add manifest entry
- `apps/runtime/src/channels/registry.ts` — register adapter
- `apps/runtime/src/channels/session-resolver.ts` — add comment for ai4w (falls through to default)
- `packages/database/src/models/channel-connection.model.ts` — add `connectionId` field (String, unique partial filter index), add `'ai4w'` to `CHANNEL_CONNECTION_TYPES`
- `apps/runtime/src/channels/connection-resolver.ts` — add `resolveConnectionByConnectionId()` function
- `apps/runtime/src/channels/adapters/ai4w-types.ts` — **new**
- `apps/runtime/src/channels/adapters/ai4w-auth.ts` — **new**
- `apps/runtime/src/channels/adapters/ai4w-adapter.ts` — **new**
- `apps/runtime/src/routes/ai4w-channel.ts` — **new**
- `apps/runtime/src/server.ts` — mount route
- `apps/studio/src/components/deployments/channels/types.ts` — add `'ai4w'` to `ChannelTypeId`
- `apps/studio/src/components/deployments/channels/channel-registry.tsx` — catalog entry
- `apps/runtime/src/__tests__/ai4w-channel.e2e.test.ts` — **new**
- `apps/runtime/src/__tests__/ai4w-auth.test.ts` — **new**

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 TypeScript errors
- [ ] `pnpm build --filter=@abl/studio` succeeds with 0 TypeScript errors
- [ ] Sync message round-trip E2E test passes: HMAC-signed request + JWT → ABL → agent response → sync HTTP body
- [ ] HMAC verification tests pass: valid, invalid secret, tampered body, stale timestamp, replay nonce (5 cases)
- [ ] JWT verification tests pass: valid, expired, wrong audience, wrong key (4 cases)
- [ ] accountId binding tests pass: backfill on first request, enforce on subsequent, mismatch → 401 (3 cases)
- [ ] Session isolation E2E test passes: different emails create different sessions, connection not found returns uniform 401
- [ ] Auth failure rate limiting: 11+ failures → blocked → 401 (1 case)
- [ ] All auth failures return identical 401 response body (no existence oracle)
- [ ] `CHANNEL_MANIFEST.ai4w` exists with correct capability flags
- [ ] AI4W adapter registered in `ChannelRegistry` unconditionally; auth fails closed for any issuer not yet registered AND inside the failure-cooldown window
- [ ] `connectionId` field with unique partial filter index on ChannelConnection model
- [ ] `'ai4w'` in `CHANNEL_CONNECTION_TYPES` array
- [ ] `'hmac_jwt'` in `AuthMode` type
- [ ] `resolveConnectionByConnectionId` function in `connection-resolver.ts`
- [ ] JWT `iss` matched against the normalized `AI4W_TRUSTED_ISSUERS` registry (multi-issuer via OIDC discovery)
- [ ] HMAC uses direction prefix (`inbound:`/`outbound:`)
- [ ] Synthetic timing delay on connection-not-found path (dummy HMAC computation via `timingSafeDummyHmac`)
- [ ] Studio create form shows 2 fields + deployment selector, post-creation credential reveal shows endpoint + connectionId + secret
- [ ] Studio connection list includes "Last Active" column
- [ ] Studio Security tab integrated with `TAB_DEFINITIONS` framework
- [ ] Studio Overview tab shows connection health diagnostics
- [ ] Studio confirmation dialogs for rotation, deactivation, and deletion

**Test Strategy**:

- E2E: Real ABL runtime on random port, full middleware chain, HTTP API interaction only. HMAC-signed requests with test connectionSecret. JWT signed with test JWKS (in-process JWKS server). Redis for nonce dedup and auth rate limiting. No mocking of platform components.
- Integration: `ai4w-auth.ts` tested with real `jose` and `crypto` libraries against in-process JWKS server. Tests verify HMAC, JWT, nonce, accountId binding, rate limiting.

**Rollback**: Remove the ai4w manifest entry, adapter, route, and registry registration. Revert `ChannelType` union. As an operational rollback before code revert, block `/api/v1/channels/ai4w` at ingress/WAF; the old `AI4W_CHANNEL_ENABLED` public-route gate is intentionally removed.

---

### Phase 2: P1 — Streaming + Async

**Goal**: AI4W can receive SSE streaming responses and async callback deliveries from ABL.

**Tasks**:

2.1. **Add SSE streaming to route handler**

- In `ai4w-channel.ts`, add `X-Response-Mode` header parsing:
  - Read `X-Response-Mode` from request headers (default: connection config `responseMode`, or `'sync'`)
  - For `stream`: Set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`). Set `X-Response-Mode-Used: stream`.
  - Copy the 3-line `writeSSE` pattern from `chat.ts` into `ai4w-channel.ts` (module-private function, not exported — acceptable for 3 lines):
    ```typescript
    function writeSSE(res: Response, event: string, data: unknown): void {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    ```
  - Set up heartbeat interval (15s) to keep connection alive
  - Subscribe to agent execution stream — on each token, `writeSSE(res, 'chunk', { text })`. On completion, `writeSSE(res, 'done', { response, sessionId })`. On error, `writeSSE(res, 'error', { error: sanitizedMessage })` (aligns with chat.ts SSE error format, NOT the REST envelope format).
  - Detect broken pipe (client disconnect) — clean up heartbeat, mark for async fallback if configured
  - Track concurrent SSE connections per tenant (Redis INCR/DECR on key `ai4w:sse:count:{tenantId}`). Set TTL of 180s on the key (120s execution timeout + 60s margin), refreshed on each INCR to auto-heal leaked counters if process crashes between INCR and close handler. Return 503 if `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT` exceeded. DECR must be in a `res.on('close', ...)` handler to prevent leaks from abrupt disconnects.

    2.2. **Add async mode to route handler**

- In `ai4w-channel.ts`, handle `X-Response-Mode: async`:
  - Full dual-layer auth (HMAC + JWT), resolve connection
  - Generate `requestId` (UUID)
  - Build `InboundJobPayload` and enqueue to `channel-inbound` BullMQ queue with job options: `{ removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 5000 }, attempts: 3, backoff: { type: 'exponential', delay: 3000 } }`. Note: inbound processing uses 3 attempts; outbound delivery (webhook-delivery queue) uses 5 attempts with exponential backoff.
  - Return `202 Accepted` with `{ success: true, data: { requestId } }`
  - Set `X-Response-Mode-Used: async`
- No separate `/message/async` endpoint — `X-Response-Mode: async` header on `/{connectionId}/message` is sufficient

  2.3. **Wire async delivery through webhook-delivery queue**

- In `ai4w-adapter.ts`, update `sendResponse()` for async mode:
  - Build HMAC signature using `buildSignatureHeaders` from `@agent-platform/shared-kernel/security`
  - Enqueue `DeliveryJobPayload` to `webhook-delivery` queue with pre-signed headers in payload metadata
  - Include `requestId` in the delivery payload so AI4W can correlate
- The existing delivery worker handles POST + retry without modification (pre-signed headers bypass `resolveWebhookSecret`)

  2.4. **Add response mode fallback logic**

- In route handler, implement fallback order from HLD:
  - `stream` requested but agent doesn't support streaming → fall back to `sync`, set `X-Response-Mode-Used: sync`
  - `async` requested but agent completes instantly → return sync response with `X-Response-Mode-Used: sync`
  - SSE stream disconnect mid-execution → store result in `PendingDeliveryStore`, attempt async delivery

    2.5. **Write streaming + async E2E tests**

- `ai4w-streaming.e2e.test.ts`:
  - SSE streaming: Send message with `X-Response-Mode: stream`. Consume SSE events. Verify `event: chunk` events followed by `event: done`. Verify response content.
  - Async callback: Start lightweight callback receiver server. Send message with `X-Response-Mode: async`. Verify 202 Accepted. Wait for callback POST. Verify HMAC signature. Verify response body contains agent output.
  - Mode fallback: Request `stream` when agent doesn't support it → verify `X-Response-Mode-Used: sync`
  - Rate limiting: Send 15+ requests → verify 429 after tenant limit

**Files Touched**:

- `apps/runtime/src/routes/ai4w-channel.ts` — add SSE streaming, async mode, mode negotiation
- `apps/runtime/src/channels/adapters/ai4w-adapter.ts` — update `sendResponse()` for async delivery
- `apps/runtime/src/__tests__/ai4w-streaming.e2e.test.ts` — **new**

**Exit Criteria**:

- [ ] SSE streaming E2E: sends `event: chunk` events followed by `event: done` with full response
- [ ] Async callback E2E: 202 Accepted → callback POST received with HMAC signature verified
- [ ] Response mode fallback: `stream` → `sync` fallback works when agent doesn't support streaming
- [ ] `X-Response-Mode-Used` header correctly reflects actual mode in all responses
- [ ] Concurrent SSE connection limit enforced (503 when exceeded)
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 errors

**Test Strategy**:

- E2E: Real ABL runtime, lightweight Express callback receiver on random port. Full middleware. No mocks.
- SSE: HTTP client reads `text/event-stream` response, parses events, validates content.

**Rollback**: Revert route handler to sync-only. Feature flag still gates entire channel.

---

### Phase 3: P2 — Rich Content + Files (Skeleton)

**Goal**: ABL can ingest files from AI4W signed URLs and transform rich content output.

**Tasks**:

3.1. **Implement `downloadFromSignedUrl` in ai4w adapter**

- In `ai4w-adapter.ts`, extend `parseIncoming()` to handle `files` array:
  - For each file: validate signed URL against SSRF policy (block private IPs, allow `AI4W_TRUSTED_CALLBACK_CIDRS`) with DNS rebinding mitigation (resolve DNS, validate resolved IP is not private/internal, connect to validated IP)
  - HTTP GET to download file at ingestion time (not execution time)
  - Pass downloaded files through existing multimodal processing pipeline
  - Attach processed files to the `NormalizedIncomingMessage`

    3.2. **Implement `ai4w-content-transformer.ts`**

- Transform `RichContentIR` → markdown + structured templates for AI4W rendering
- Update `transformOutput()` in adapter to use the transformer

  3.3. **Implement signed URL file output**

- When agent produces files, generate ABL-hosted signed download URLs
- Include in response payload `files` array

  3.4. **Write file exchange E2E tests**

**Exit Criteria**:

- [ ] File upload via signed URL round-trip E2E passes
- [ ] Rich content (markdown + templates) output verified

**Rollback**: Revert file handling in adapter. Sync/SSE/async messaging unaffected.

---

### Phase 4: P3 — Proactive Notifications + Human Approval (Skeleton)

**Goal**: ABL can push human-approval notifications to AI4W users.

**Tasks**:

4.1. **Create `ai4w-proactive.ts`** — outbound notification delivery:

- `sendProactiveNotification(connection, notification: AI4WProactiveNotification)`:
  - Redis `SET NX` on `ai4w:notification:{notificationId}` with 1h TTL (dedup)
  - Circuit breaker check: `RedisCircuitBreaker` with key `ai4w:{connectionId}`
  - HMAC-SHA256 signature using same `connectionSecret` (symmetric bidirectional)
  - HTTP POST to `connection.config.notificationUrl`
  - Handle response codes per proactive notification error contract (200/404/409/410/429)

    4.2. **Wire ChannelDispatcher for ai4w proactive delivery**

- Extend `ChannelDispatcher` to recognize `ai4w` channel bindings
- Route human-approval suspensions to `sendProactiveNotification` when session has ai4w binding
- Similar pattern to A2A `PushNotificationSender` interface

  4.3. **Wire callback reception for approval results**

- Existing `/api/v1/callbacks/:callbackId` endpoint handles this via `RedisCallbackRegistry` + `ResumptionService`

  4.4. **Write proactive notification E2E tests**

**Exit Criteria**:

- [ ] Human-approval notification delivered to simulated AI4W endpoint
- [ ] Dedup prevents duplicate notifications (Redis SET NX)
- [ ] Approval callback resumes ABL execution
- [ ] Circuit breaker opens after 10 failures

**Rollback**: Remove proactive delivery. Core messaging unaffected.

---

### Phase 5: P4 — Project Discovery + Provisioning + Info

**Goal**: AI4W can browse ABL projects, auto-provision a project-bound connection, and render the linked-app banner + "Test & Continue" health check via `/info` — all without needing the internal service token for the banner path.

**Tasks**:

5.1. **Create / extend `internal-discovery.ts` route handler** (service-token + JWT)

- `GET /api/internal/v1/tenants/by-membership?email={email}`: Discover tenants accessible by email, sorted by `name` ascending
- `GET /api/internal/v1/tenants/{tenantId}/projects/discoverable`: Project discovery with `{id, name, description, agentCount}` per project; supports `?limit` (default 50, max 200), `?cursor` (keyset on `(name, _id)`), `?q` (substring on `name`/`description`), `?sort=name|recent` (default `name`). RBAC: tenant-member required; non-admins filtered by `ProjectMember`. `agentCount` = live `Deployment.countDocuments({projectId, tenantId, status:'active'})`.
- `POST /api/internal/v1/channel-connections/provision`: Accept `{tenantId, projectId, connectionName?, environment?, deploymentId?, callbackBaseUrl, responseMode?}`. Enforce `environment` / `deploymentId` mutual exclusivity (Zod `.refine`). Default `connectionName` to `"Connection " + (existingAi4wCount + 1)` per project. Store with `agentId: null`. Generate `connectionId` + `connectionSecret`, auto-generate `externalIdentifier`. Return `{connectionId, connectionSecret}` (one-time, internal network only). Do **not** accept `agentId` or `agentName`.
- Auth: AI4W JWT + `X-Service-Token` header
- Mount on separate Express port `:3113` or middleware-gated (per HLD OQ-1)

  5.2. **Implement `GET /info` endpoint in `ai4w-channel.ts`** (public HMAC + JWT)

- `GET /api/v1/channels/ai4w/:connectionId/info` — public HMAC + JWT path (same middleware chain as `/message`; no internal service token)
- HMAC signed over an **empty** body (`"inbound:" + requestId + "." + timestamp + "." + ""`); `rawBody` is `Buffer.alloc(0)` when express.json doesn't run on a bodyless GET
- Full inbound auth: auth-block check → connection resolve (with synthetic HMAC delay on not-found) → HMAC verify → timestamp ±30s → replay check (distinct nonce namespace `info:{requestId}`) → JWT verify → accountId binding
- **No** `resolveSession`, **no** `acquireSessionLock`, **no** `executeMessage`, **no** trace events, **no** tenant-rate-limit consumption. Auth-failure counter **does** increment on failure.
- Response on success (200): `{connectionId, channelType, status, displayName, tenantId, tenantName, projectId, projectName, agentCount, config:{callbackBaseUrl, responseMode}, pinning:{deploymentId, environment}, currentDeployment}`. `currentDeployment` resolved live via the same query path as `DeploymentResolver`. **Never** returns `connectionSecret`.
- Response on failure: uniform 401, identical body to `/message` 401 path
- Replaces the former internal `GET /api/internal/v1/connections/{connectionId}/info` and the separate `POST /ping` — one endpoint covers both banner-refresh and health-check flows.
- Rate-limit policy is an open item (tracked in `docs/sdlc-logs/ai4w-abl-channel-integration/open-items-eva-6527.log.md`); default behaviour until decided: exempt.

  5.3. **Sort existing list endpoints**

- `tenants/by-membership` — `.sort({ name: 1 })` on the tenant query
- `projects/discoverable` — default `.sort({ name: 1 })`, accept `?sort=recent` mapped to `updatedAt: -1`

  5.4. **Write E2E tests**

- `ai4w-discovery.e2e.test.ts`:
  - Project discovery RBAC filtering (admin vs non-admin with ProjectMember)
  - Pagination: deterministic ordering across pages, `nextCursor` round-trip
  - Search: `?q` matches substring on name and description
  - Cross-tenant discovery returns empty list (not 403)
- Provisioning:
  - Accepts `environment`-only, `deploymentId`-only, and neither (unpinned). Rejects both-together with 400.
  - Defaults `connectionName` when omitted
  - Refuses `agentId` / `agentName` fields (validation error)
- Info (in `ai4w-channel.e2e.test.ts` where HMAC signing helpers live):
  - Valid HMAC+JWT → 200 with tenant/project meta + pinning + currentDeployment (or null)
  - Wrong HMAC → uniform 401
  - Unknown connectionId → uniform 401 (no existence oracle)
  - `connectionSecret` never appears in the response
  - `/info` does not consume tenant rate-limit quota

**Exit Criteria**:

- [ ] Project discovery returns RBAC-filtered list sorted by name
- [ ] Pagination (`?cursor`) and search (`?q`) work; response includes `nextCursor`
- [ ] Provisioning rejects `environment`+`deploymentId` combined; defaults `connectionName`; stores `agentId: null`
- [ ] `GET /info` passes dual auth with HMAC signed over empty body; returns live `currentDeployment`; never returns `connectionSecret`
- [ ] `/info` increments auth-failure counter on bad creds
- [ ] `/info` response matches the schema in HLD §6
- [ ] Cross-tenant discovery returns empty list (not 403)
- [ ] `tenants/by-membership` sorted by name ascending
- [ ] `pnpm build --filter=@agent-platform/runtime` passes with 0 errors

**Rollback**: Disable `AI4W_INTERNAL_API_ENABLED` for discovery/provisioning. The public `/info` endpoint is part of the always-mounted channel surface and should be blocked at ingress/WAF if an operational rollback is needed before code revert.

---

### Phase 6: P7 — Lifecycle APIs (Deactivate + Unlink)

**Goal**: AI4W can deactivate (reversible) and unlink (hard-remove) provisioned ai4w connections for orphan reaping and admin UX parity.

**Tasks**:

6.1. **Add deactivate endpoint to `internal-discovery.ts`**

- `POST /api/internal/v1/channel-connections/:connectionId/deactivate`
- Authz: `verifyAI4WServiceAuth` + tenant-membership check on the JWT email (same pattern as provision)
- Scope: `channelType === 'ai4w'` only — return 404 for other channel types (avoids cross-channel collateral damage)
- Action: `ChannelConnection.updateOne({connectionId, channelType:'ai4w'}, {$set:{status:'inactive'}})`
- Idempotent: already-inactive connections return 200 (no-op)
- Audit event: `ai4w.connection.deactivated` (already defined in HLD §7)
- Response: `{success:true, data:{status:'inactive'}}`

  6.2. **Add unlink (DELETE) endpoint to `internal-discovery.ts`**

- `DELETE /api/internal/v1/channel-connections/:connectionId`
- Authz: same as deactivate
- Scope: `channelType === 'ai4w'` only
- Action: `ChannelConnection.deleteOne({connectionId, channelType:'ai4w'})`
- Idempotent on repeat: returns 404 the second time (row gone)
- Audit event: `ai4w.connection.deleted`
- Response: `{success:true, data:{deleted:true}}`
- **Does not** cascade to sessions — sessions TTL naturally per existing policy

  6.3. **Verify inactive-connection rejection on `/message` and `/info`**

- Existing `resolveConnectionByConnectionId` already filters by `status: 'active'` — confirm. If not, add the filter.
- Deactivated connections must receive uniform 401 on `/message` and `/info` — same body as "not found" to preserve the no-existence-oracle property.

  6.4. **Write E2E tests**

- Deactivate:
  - POST deactivate → subsequent POST `/message` returns uniform 401
  - POST deactivate → subsequent GET `/info` returns uniform 401
  - POST deactivate on already-inactive → 200 no-op
  - Reactivation via existing channel-customization PATCH endpoint restores `/message` path
- Unlink:
  - DELETE → subsequent GET `/info` returns uniform 401 (row gone; same as "not found")
  - DELETE → subsequent DELETE on same id returns 404 (scoping test still applies)
  - DELETE on non-ai4w channel type → 404
  - DELETE on missing connectionId → 404
- Cross-tenant deactivate/unlink → 403 (tenant-membership enforcement)

**Files Touched**:

- `apps/runtime/src/routes/internal-discovery.ts` — add two handlers
- `apps/runtime/src/__tests__/ai4w-lifecycle.e2e.test.ts` — **new**

**Exit Criteria**:

- [ ] Deactivated connection returns uniform 401 on `/message` and `/info`
- [ ] DELETE on ai4w connection removes the row; subsequent `/info` → uniform 401; repeat DELETE → 404
- [ ] DELETE on non-ai4w channel type → 404 (no cross-channel collateral)
- [ ] Cross-tenant attempts → 403
- [ ] Audit events emitted
- [ ] `pnpm build --filter=@agent-platform/runtime` passes with 0 errors

**Rollback**: Disable the two new routes. Existing channel-customization CRUD (which can already toggle `status`) covers the admin-UI use case.

---

### Phase 7: P5+P6 — Auth Challenge + Cross-Environment (Deferred)

**Goal**: Auth challenge rendering and cross-environment OAuth2.

These phases warrant separate mini-specs per HLD OQ-3. Interface contracts defined in `ai4w-types.ts` (`auth_challenge` notification type, OAuth2 bearer token path in `ai4w-auth.ts`). Implementation deferred.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `'ai4w'` added to `ChannelType` union in `types.ts`
- [ ] `ai4w` entry added to `CHANNEL_MANIFEST` in `manifest.ts` (with `authMode: 'hmac_jwt'`)
- [ ] `AI4WAdapter` registered in `getChannelRegistry()` in `registry.ts` unconditionally
- [ ] `'ai4w'` handled in `mapChannelTypeToConversationChannel` in `session-resolver.ts`
- [ ] ai4w route mounted in `server.ts` at `/api/v1/channels/ai4w` BEFORE generic `channelWebhooksRouter`
- [ ] ai4w route is mounted before the generic channel webhook router
- [ ] ai4w route uses `express.json({ limit: '1mb', verify })` for raw body preservation (HMAC)
- [ ] `connectionId` field added to ChannelConnection model (type: `String`) with unique index using partial filter expression `{ connectionId: { $type: 'string' } }` (sparse — only ai4w connections have this field)
- [ ] `'ai4w'` added to `CHANNEL_CONNECTION_TYPES` array in `channel-connection.model.ts`
- [ ] `'hmac_jwt'` added to `AuthMode` type in `apps/runtime/src/channels/manifest.ts` (L24)
- [ ] `resolveConnectionByConnectionId(connectionId, channelType)` added to `connection-resolver.ts` — queries by `connectionId` field (not `_id`), decrypts credentials
- [ ] Route handler looks up connection via `resolveConnectionByConnectionId` (NOT `_id`, NOT `externalIdentifier`)
- [ ] HMAC verification uses `req.rawBody` (preserved by express.json verify callback)
- [ ] JWT `iss` matched against normalized `AI4W_TRUSTED_ISSUERS`
- [ ] Each trusted issuer discovers `jwks_uri` through OIDC (lazily, on first JWT use) and verifies the discovery doc's own `issuer` field
- [ ] `initAI4WAuth()` does NO network calls at startup — pod boots clean even when every issuer is unreachable
- [ ] Failed issuer registration is cached for `AI4W_JWKS_COOLDOWN_MS` and automatically retried on the next JWT after the cooldown window
- [ ] Concurrent first-requests for the same issuer share a single in-flight discovery Promise (single-flight, no thundering herd)
- [ ] One unhealthy issuer does not break verification for healthy issuers (independent registration state)
- [ ] accountId binding enforced: backfill on first request, enforce match on subsequent
- [ ] Auth failure rate limiting: Redis counter per source-IP+connectionId pair, block after threshold
- [ ] All auth failures return uniform 401 (no existence oracle)
- [ ] Synthetic HMAC delay on connection-not-found path to prevent timing side-channel (`timingSafeDummyHmac` — dummy HMAC computation against a static key, not a fixed-time sleep)
- [ ] HMAC input uses direction prefix: `inbound:` for AI4W→ABL, `outbound:` for ABL→AI4W
- [ ] Replay protection: Redis SET nonce dedup with 60s TTL
- [ ] Callback URL SSRF validation includes DNS rebinding mitigation (resolve DNS, validate resolved IP, connect to validated IP)
- [ ] Studio channel catalog entry added in `channel-registry.tsx` (with `autoGenerateIdentifier: true`, `hasCredentials: false`, `multiConnection: true`)
- [ ] Studio create form: name + callback URL + deployment selector (2+1 fields)
- [ ] Studio post-creation: credential reveal (endpoint + connectionId + secret, shown once)
- [ ] Studio Security tab: key rotation with hard cut, integrated with `TAB_DEFINITIONS` framework
- [ ] Studio Overview tab: connection health diagnostics (last successful request, error rate 24h, auth block status)
- [ ] Studio connection list: "Last Active" column
- [ ] Studio rotation confirmation dialog with explicit invalidation warning
- [ ] Studio deactivation confirmation dialog ("reject all incoming requests, reactivate later")
- [ ] Studio deletion confirmation dialog (destructive, "permanently remove connection and session data")
- [ ] Provisioning auto-generates `externalIdentifier` (UUID, not used for routing)
- [ ] Route handler sets `req.tenantContext = { tenantId: connection.tenantId }` after connection resolution
- [ ] Rate limiting applied via `getHybridRateLimiter().check()` directly after auth (not as route middleware)
- [ ] `'ai4w'` added to `ChannelTypeId` union in Studio `types.ts`
- [ ] `ai4w-auth.ts` imported and used by route handler + adapter
- [ ] `AI4WMessageSchema` exported from `ai4w-types.ts` and used in route handler validation
- [ ] `buildAI4WSessionKey` exported from `ai4w-types.ts` and used in route handler
- [ ] Trace events emitted: `ai4w.inbound`, `ai4w.delivery.sync/stream/async`, `ai4w.auth.failed`, `ai4w.auth.blocked`, `ai4w.connection.account_bound`
- [ ] Audit events emitted: `ai4w.connection.created`, `ai4w.connection.rotated`, `ai4w.connection.deactivated`, `ai4w.connection.deleted`, `ai4w.connection.callback_changed`
- [ ] `AI4W_TRUSTED_ISSUERS` env var documented with default `https://work.kore.ai/oidc`
- [ ] OIDC discovery/JWKS timeout and cooldown env vars documented
- [ ] `AI4W_JWT_AUDIENCE` env var documented with default `urn:kore:agentic`
- [ ] `AI4W_TRUSTED_CALLBACK_CIDRS` startup validation: reject invalid entries and prefixes broader than /8 IPv4 or /32 IPv6
- [ ] `CHANNEL_CATALOG_ORDER` array updated to include `'ai4w'` in the messaging group
- [ ] Outbound HMAC signing for async callbacks uses same `connectionSecret` (symmetric)
- [ ] `/projects/discoverable` returns `{id, name, description, agentCount}` with `nextCursor`, sorted by `name` asc by default (P4)
- [ ] Provisioning rejects `environment` + `deploymentId` together; defaults `connectionName` to `Connection N+1`; stores `agentId: null` (P4)
- [ ] `GET /api/v1/channels/ai4w/:connectionId/info` (public HMAC + JWT) returns tenant/project meta + live `currentDeployment`; never returns `connectionSecret` (P4)
- [ ] `/info` HMAC signs over empty body; no session/exec/trace/tenant-rate-limit side effects; auth-failure counter still increments on bad creds (P4)
- [ ] `/info` replay nonce uses distinct namespace (`info:{requestId}`) from `/message` (P4)
- [ ] `tenants/by-membership` sorted by `name` asc (P4)
- [ ] JWT `aud` validated against `AI4W_JWT_AUDIENCE` env var (default `urn:kore:agentic`) (P0)
- [ ] `/info` rate-limit policy logged as open item (P4)
- [ ] `deactivate` route returns 200 and flips `status='inactive'`; deactivated connection rejects `/message` and `/info` with uniform 401 (P7)
- [ ] `DELETE /channel-connections/:connectionId` removes the row; scoped to `channelType='ai4w'`; idempotent 404 on repeat (P7)
- [ ] Audit events emitted on deactivate / delete (P7)

---

## 5. Cross-Phase Concerns

### Accepted Risks

| Risk                       | Severity | Mitigations                                                                                                     |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| Per-issuer JWKS compromise | High     | Issuer allowlist, OIDC issuer self-consistency check, per-issuer JWKS cache, bounded kid-miss re-fetch cooldown |

### Database Migrations

No schema migrations. All changes are additive documents in existing collections.

New unique index needed: `{ connectionId: 1 }` on `channel_connections` with partial filter expression `{ connectionId: { $type: 'string' } }` for connection lookup by public connectionId. The partial filter ensures uniqueness is only enforced on documents that have the field (only ai4w connections). The `externalIdentifier` is auto-generated (not used for routing — ai4w uses connectionId from URL path).

### Feature Flags

| Flag                                  | Default | Scope                   | What It Gates                      |
| ------------------------------------- | ------- | ----------------------- | ---------------------------------- |
| `AI4W_INTERNAL_API_ENABLED`           | `false` | Internal route mounting | Discovery + provisioning APIs (P4) |
| `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT` | `50`    | Per-tenant SSE limit    | Concurrent SSE connections (P1)    |

Note: The public AI4W channel route is always mounted and fails closed when auth is not configured. The HLD and feature spec reference a per-tenant `tenantConfig.channels.ai4w.enabled` flag for granular rollout; this remains deferred because no existing channel uses `tenantConfig.channels` today.

### Configuration Changes

| Variable                              | Default                     | Description                                                                                                                | Phase |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| `AI4W_TRUSTED_ISSUERS`                | `https://work.kore.ai/oidc` | Comma-separated trusted issuer list; each issuer's JWKS is discovered through OIDC at startup                              | P0    |
| `AI4W_JWT_AUDIENCE`                   | `urn:kore:agentic`          | Expected JWT audience (`aud` claim)                                                                                        | P0    |
| `AI4W_OIDC_DISCOVERY_TIMEOUT_MS`      | `5000`                      | OIDC discovery fetch timeout                                                                                               | P0    |
| `AI4W_JWKS_FETCH_TIMEOUT_MS`          | `5000`                      | Per-key JWKS fetch timeout                                                                                                 | P0    |
| `AI4W_JWKS_COOLDOWN_MS`               | `30000`                     | Bounded kid-miss JWKS re-fetch cooldown                                                                                    | P0    |
| `AI4W_ALLOW_HTTP_ISSUERS`             | `false`                     | Dev-only escape hatch for local HTTP issuers                                                                               | P0    |
| `AI4W_ISSUER_JWKS_OVERRIDES`          | (empty)                     | JSON issuer-to-JWKS map for issuers that cannot publish OIDC discovery                                                     | P0    |
| `AI4W_HMAC_TIMESTAMP_TOLERANCE_MS`    | `30000`                     | Max age of X-Timestamp (±30s)                                                                                              | P0    |
| `AI4W_AUTH_BLOCK_THRESHOLD`           | `10`                        | Auth failures before blocking                                                                                              | P0    |
| `AI4W_AUTH_BLOCK_DURATION_MS`         | `300000`                    | Block duration (5 min)                                                                                                     | P0    |
| `AI4W_INTERNAL_API_ENABLED`           | `false`                     | Enable internal discovery/provisioning                                                                                     | P4    |
| `AI4W_CALLBACK_TIMEOUT_MS`            | `30000`                     | Outbound HTTP timeout                                                                                                      | P1    |
| `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT` | `50`                        | Max concurrent SSE per tenant                                                                                              | P1    |
| `AI4W_TRUSTED_CALLBACK_CIDRS`         | (empty)                     | Private-range callback allowlist. Startup validation rejects invalid entries and prefixes broader than /8 IPv4 or /32 IPv6 | P0    |
| `AI4W_CIRCUIT_BREAKER_LEVEL`          | `tool_service`              | Circuit breaker preset                                                                                                     | P3    |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All P0 exit criteria met (sync messaging + dual-layer auth (HMAC + JWT) + accountId binding + replay protection + session isolation)
- [ ] All P1 exit criteria met (SSE streaming + async callback + mode negotiation)
- [ ] E2E tests from test spec passing: E2E-1 (sync), E2E-2 (streaming), E2E-3 (async callback), E2E-6 (session isolation)
- [ ] Integration tests from test spec passing: INT-1 (JWT/JWKS), INT-4 (rate limiting)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with implementation details (file paths, actual Zod schemas)
- [ ] Testing matrix updated with actual coverage
- [ ] Public AI4W channel fails closed with uniform 401 when auth is not configured or issuer discovery has not initialized
- [ ] P2-P4 exit criteria are placeholder — full exit criteria will be defined when those phases are promoted from skeleton to detailed
- [ ] E2E-4 (proactive + approval), E2E-5 (discovery), INT-2 (circuit breaker), INT-3 (SSRF), INT-5 (notification dedup), INT-6 (offline fallback) are acceptance criteria for P2-P4 and will be added when those phases are detailed

---

## 7. Open Questions

1. **Delivery worker pre-signing vs. credential resolution**: D-8 decides pre-signing, but if the delivery worker evolves to support ChannelConnection credential resolution natively, the ai4w adapter should migrate to that pattern.
2. **Studio feature flag**: **RESOLVED** — Studio catalog entry remains visible; runtime auth fails closed until operators configure trusted issuers and connection credentials.
3. **connectionId index migration**: **RESOLVED** — Use partial filter expression `{ connectionId: { $type: 'string' } }` on the unique index. This is more precise than a sparse index (which also matches `null` values) and only enforces uniqueness on documents that actually have a string `connectionId` field. Only ai4w connections will have this field.

---

## FR Traceability Matrix

| FR    | Implementation Task                                         | Phase |
| ----- | ----------------------------------------------------------- | ----- |
| FR-1  | Task 1.1 (manifest entry)                                   | P0    |
| FR-2  | Tasks 1.3, 1.4 (ai4w-auth HMAC+JWT, adapter verifyRequest)  | P0    |
| FR-3  | Tasks 1.6, 2.1, 2.2 (sync route, SSE, async)                | P0+P1 |
| FR-4  | Tasks 1.2, 1.6 (session key builder, session resolution)    | P0    |
| FR-5  | N/A — AI4W scoped                                           | —     |
| FR-6  | N/A — AI4W scoped                                           | —     |
| FR-7  | N/A — AI4W scoped                                           | —     |
| FR-8  | Tasks 4.1, 4.2 (proactive delivery)                         | P3    |
| FR-9  | Task 5.1 (discovery API)                                    | P4    |
| FR-10 | Task 5.1 (provisioning API)                                 | P4    |
| FR-11 | Tasks 3.1, 3.3 (file ingestion + output)                    | P2    |
| FR-12 | Phase 6 (auth challenge — deferred)                         | P5    |
| FR-13 | Task 4.1 (notification dedup)                               | P3    |
| FR-14 | Task 4.1 (circuit breaker)                                  | P3    |
| FR-15 | Task 1.6 (rate limiting via getHybridRateLimiter().check()) | P0    |
| FR-16 | Tasks 2.3, 3.1 (SSRF allowlist validation)                  | P1+P2 |
| FR-17 | Phase 6 (cross-env OAuth2 — deferred)                       | P6    |
| FR-18 | N/A — AI4W handles offline fallback                         | —     |
