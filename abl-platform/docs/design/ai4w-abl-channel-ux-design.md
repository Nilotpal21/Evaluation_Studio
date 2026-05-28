# AI4W-ABL Channel Integration — Revised Design

**Date**: 2026-04-22
**Status**: AGREED (pending spec updates)
**Context**: Design review conversation with Ajay + security hardening pass. Supersedes auth model, Studio UX, and connection resolution patterns in the original feature spec / HLD / LLD.

---

## 1. Design Principles

1. **ABL owns all secrets** — ABL generates connection credentials. AI4W stores and uses them. No AI4W secrets stored in ABL.
2. **Minimum copy** — ABL admin copies 2 values to AI4W: connectionId + connectionSecret. AI4W admin copies 1 value to ABL: callback URL.
3. **Design-time vs runtime separation** — different auth contexts, different JWTs, different APIs.
4. **ABL admin controls access** — creating a connection = granting AI4W access to an agent. Revoking = deactivating or deleting the connection.
5. **Uniform error responses** — all auth failures return 401 with the same body. Never leak which auth layer failed or whether a connectionId exists.

---

## 2. Auth Model (Revised)

### Two layers at runtime

| Layer             | Mechanism                                               | Proves                                                  | Validated by                                                                                  |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Identity**      | AI4W-issued JWT (per request, short-lived)              | Which end-user is sending this message                  | Global `AI4W_JWKS_URI` env var (default `https://work.kore.ai/oidc/jwks`)                     |
| **Authorization** | HMAC request signing with ABL-issued `connectionSecret` | This request is authorized for this specific connection | ABL looks up connection by `connectionId` from URL path, validates HMAC against stored secret |

### Runtime JWT shape (issued by AI4W per request)

```json
{
  "sub": "u-7280d850-b389-560c-bc6d-d9ed47f0878c",
  "email": "enduser@company.com",
  "accountId": "acc_abc123",
  "iss": "https://work.kore.ai",
  "aud": "urn:kore:agentic",
  "scope": "login racl",
  "product": "AIforWork",
  "iat": 1772448357,
  "exp": 1772448657
}
```

Key claims used by ABL:

- `email` — session scoping (session key includes base64url-encoded email)
- `accountId` — enforced against connection binding after first request (see §2.4)
- `iss` — validated: must equal `AI4W_JWT_ISSUER` env var (default `https://work.kore.ai`). Rejects JWTs from unexpected issuers.
- `aud` — validated: must equal `AI4W_JWT_AUDIENCE` env var (default `urn:kore:agentic`). Rejects tokens with unexpected audiences.

Claims NOT used by ABL: `sub` (AI4W internal userId), `scope`, `product`.

### HMAC request signing

AI4W signs each request using the ABL-issued `connectionSecret`:

```
X-Signature-Nonce: <UUID>
X-Timestamp: 1772448357
X-Signature: sha256=HMAC-SHA256(connectionSecret, "inbound:" + requestId + "." + timestamp + "." + requestBody)
```

The HMAC input includes three components:

- `X-Signature-Nonce` — UUID generated per request (replay protection nonce)
- `X-Timestamp` — epoch seconds (clock skew protection)
- Raw request body bytes (payload integrity)

### HMAC validation (ABL side)

1. Parse `connectionId` from URL path
2. Look up `ChannelConnection` by `connectionId` field (NOT `_id` — see §4)
   → **401** if not found or inactive (same response as auth failure — no existence oracle)
3. Decrypt `connectionSecret` from `connection.encryptedCredentials`
4. Reject if `X-Timestamp` is outside ±30 second window → **401**
5. Check `X-Signature-Nonce` against Redis SET `ai4w:nonce:{connectionId}` (TTL = 60s)
   → **409 Conflict** if duplicate (replay detected). Add to set if new.
6. Compute expected HMAC: `HMAC-SHA256(secret, "inbound:" + requestId + "." + timestamp + "." + rawBody)`
7. Constant-time compare with `X-Signature` → **401** if mismatch

**Raw body preservation**: The ai4w route MUST use `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` to preserve the exact bytes for HMAC verification. JSON serialization is not stable — `{"a":1}` and `{ "a": 1 }` hash differently.

### JWT-connection binding (accountId enforcement)

After the first request backfills `config.ai4wAccountId`, ABL enforces it on all subsequent requests:

```typescript
if (connection.config.ai4wAccountId && jwt.accountId !== connection.config.ai4wAccountId) {
  // JWT from a different AI4W account than the one bound to this connection
  return 401; // same error as any other auth failure
}
```

This prevents: stolen connectionSecret + JWT from a different AI4W account = access. The HMAC proves "you have the secret," the accountId binding proves "you're the right organization."

### Auth failure rate limiting

Track consecutive HMAC/JWT failures per source IP + connectionId in Redis:

- Key: `ai4w:auth:fail:{sourceIp}:{connectionId}`, TTL 60s, INCR on each failure
- After 10 failures in 60 seconds → block connectionId for 5 minutes (Redis SET with TTL)
- Emit `ai4w.auth.blocked` trace event with connectionId and source IP
- Reset counter on successful authentication
- Blocked requests return 401 (same response — attacker can't distinguish "blocked" from "invalid")

### JWKS — global env var

```
AI4W_JWKS_URI=https://work.kore.ai/oidc/jwks   # default
```

Single `createRemoteJWKSet` instance cached at module level. No per-connection JWKS cache needed. On-prem overrides the env var.

---

## 3. Studio UX

### Create flow (2 fields + deployment selector)

```
┌──────────────────────────────────────────────────────────────┐
│  AI4W Channel Connection                                     │
│                                                              │
│  Display Name                                                │
│  [AI4W Production  ]                                         │
│                                                              │
│  Callback URL                                                │
│  [https://work.kore.ai/api/public/agents/:agentId ]                   │
│  Where ABL sends async responses and notifications.          │
│                                                              │
│  Deployment                                                  │
│  [Latest in production           ▼]                          │
│                                                              │
│                                     [Cancel] [Create]        │
└──────────────────────────────────────────────────────────────┘
```

**Callback URL validation on create/update:**

- Must be HTTPS (except `localhost` / `127.0.0.1` in dev)
- Block private IP ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, loopback, link-local
- For same-VPC deployments: allowlist via `AI4W_TRUSTED_CALLBACK_CIDRS` env var (overrides private-IP block for specific ranges)
- Validated on both creation and update (not just creation)

### Post-creation credential reveal (SDK `hosted_exchange` pattern)

```
┌──────────────────────────────────────────────────────────────┐
│  ✓ Connection Created                                        │
│                                                              │
│  Copy these into your AI4W agent configuration:              │
│                                                              │
│  ABL Endpoint                                                │
│  ┌────────────────────────────────────────────────────── 📋 ┐│
│  │ https://runtime.abl.com/api/v1/channels/ai4w             ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  Connection ID                                               │
│  ┌────────────────────────────────────────────────────── 📋 ┐│
│  │ ai4w_c_7f3a9b2e4d1c8f5a6b0e3d2c1a9f8e7d                ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  Connection Secret                                           │
│  ┌────────────────────────────────────────────────────── 📋 ┐│
│  │ abl_cs_8f2b4c6d8f0a1b3c5d7e9f...                        ││
│  └──────────────────────────────────────────────────────────┘│
│  ⚠ This secret will only be shown once. Store it securely.   │
│    You can rotate it later from the Security tab.            │
│                                                              │
│  AI4W constructs the request URL as:                         │
│  {endpoint}/{connectionId}/message                           │
│                                                              │
│                                                    [Done]    │
└──────────────────────────────────────────────────────────────┘
```

### Connection list (Level 2)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Name                  Status    Deployment         Last Active    Source    │
│ ────────────────────────────────────────────────────────────────────────────│
│ AI4W Production       ● Active  v2.1 (production)  2 hours ago    Manual   │
│ AI4W QA               ● Active  v1.9 (staging)     5 days ago     API      │
└──────────────────────────────────────────────────────────────────────────────┘
```

`Source` column: `Manual` (created in Studio) vs `API` (created via provisioning endpoint P4).

### Connection detail tabs (Level 3)

| Tab               | Content                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**      | Status, dates, deployment info, endpoint URL (copyable), connection ID (copyable), setup instructions. Health diagnostics: last successful request timestamp, error rate (last 24h), auth block status indicator. |
| **Configuration** | Display name, callback URL (with SSRF validation), notification URL (optional), response mode. Callback URL change requires confirmation dialog: "This will redirect all async responses to the new URL."         |
| **Deployment**    | Pin-to-deployment or environment-based auto-resolve                                                                                                                                                               |
| **Security**      | Connection secret status, prefix, created date, last used. **Rotate Secret** button (hard cut — old secret invalidated immediately, new secret shown once).                                                       |

No Credentials tab (ABL doesn't store AI4W credentials).

### Key rotation (Security tab — hard cut, no grace period)

```
  Connection Secret
  ────────────────
  Status:    ● Active
  Prefix:    abl_cs_8f2b...
  Created:   Apr 19, 2026
  Last used: 2 hours ago

  [Rotate Secret]
```

After rotating:

```
  New Connection Secret
  ┌──────────────────────────────────────────── 📋 ┐
  │ abl_cs_9e2b4c6d8f0a1b3c5d7e9f...              │
  └────────────────────────────────────────────────┘
  ⚠ Copy now — this won't be shown again.

  Previous key was invalidated immediately.
  Update your AI4W agent configuration now — requests
  signed with the old key will fail.
```

Rotation is a hard cut: old secret is overwritten, not preserved. This is simpler and more secure than grace-period logic. If AI4W needs zero-downtime rotation, coordinate the timing (rotate in ABL, immediately update AI4W config).

### Registry capabilities

```typescript
{
  id: 'ai4w',
  name: 'AI4W',
  description: 'AIforWork platform integration',
  icon: Globe,
  available: true,
  category: 'messaging',
  capabilities: {
    multiConnection: true,
    hasCredentials: false,       // ABL generates creds, not user-entered
    hasWebhookUrl: false,
    supportsTest: false,         // P1+
    supportsDeliveryLog: false,  // P1+
    autoGenerateIdentifier: true,
    supportsPauseResume: true,
  },
  credentialFields: [],          // empty — no user-entered credentials
  externalIdentifierLabel: 'Connection ID',
  externalIdentifierPlaceholder: 'Auto-generated',
  webhookPath: null,
  setupInstructions: /* JSX: copy endpoint + connectionId + secret into AI4W */,
}
```

---

## 4. Endpoint Design (Revised)

### connectionId format

The `connectionId` is a **separate field** on `ChannelConnection`, NOT the MongoDB `_id`. This prevents:

- **Enumeration**: ObjectIds are partially predictable (timestamp + counter)
- **Information leak**: ObjectId encodes creation time

Format: `ai4w_c_` + `crypto.randomBytes(16).toString('hex')` (32 hex chars).
Example: `ai4w_c_7f3a9b2e4d1c8f5a6b0e3d2c1a9f8e7d`

Indexed: `{ connectionId: 1 }` unique index on `channel_connections`.

### Runtime (message flow)

```
POST /api/v1/channels/ai4w/{connectionId}/message
```

connectionId in the path enables:

- LB per-connection rate limiting (nginx `limit_req_zone` keyed on URI segment)
- WAF rules per connection
- Access log correlation without header parsing
- Route-level metrics in Grafana

### Request schema (simplified — no agent identifiers)

```typescript
const AI4WMessageSchema = z.object({
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
    .max(100) // cap history length
    .optional(),
  files: z
    .array(
      z.object({
        name: z.string().max(255),
        mimeType: z.string().max(127),
        signedUrl: z.string().url().max(2048),
      }),
    )
    .max(10) // cap file count
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});
```

`projectId`, `agentName`, `deploymentId` are all resolved from the connection — not in the request body.

**Body size limit**: `express.json({ limit: '1mb' })` on the ai4w route. Rejects oversized payloads before parsing.

### Info / health-check endpoint (P4 — public HMAC + JWT)

```
GET /api/v1/channels/ai4w/{connectionId}/info
```

Uses the same HMAC + JWT auth chain as `/message` (no internal service token required). HMAC is signed over the empty body (`"inbound:" + requestId + "." + timestamp + "." + ""`). Returns tenant/project meta, pinning, and the live-resolved `currentDeployment` — so AI4W renders the linked-app banner and validates the setup in one round-trip. No session, no agent execution, no trace writes, no tenant-rate-limit consumption.

This endpoint replaces both the former standalone `POST /ping` and the internal `GET /api/internal/v1/connections/{connectionId}/info`.

### Internal APIs (P4+P7 — service-token + JWT)

```
GET    /api/internal/v1/tenants/by-membership?email={email}                     — tenants (sorted by name asc)
GET    /api/internal/v1/tenants/{tenantId}/projects/discoverable                — projects with agentCount; ?limit/?cursor/?q/?sort
POST   /api/internal/v1/channel-connections/provision                           — project-level auto-create
POST   /api/internal/v1/channel-connections/{connectionId}/deactivate           — soft-disable (P7)
DELETE /api/internal/v1/channel-connections/{connectionId}                      — hard-remove (P7, for orphan reaper)
```

All on internal API port (`:3113`), gated by `AI4W_INTERNAL_API_ENABLED`. The provisioning API returns `connectionId` + `connectionSecret` in the response body — this is a one-time return over the internal network only.

**Key revision (2026-04-22)**:

- Agent-level discovery was replaced with project-level discovery because AI4W's V2 autonomous-agent builder maps one AI4W "agent" to one ABL project. Provisioning does **not** accept `agentId` — connections bind to a project, and the runtime resolves the live deployment via the shared `DeploymentResolver` (same pattern as Genesys / VXML / Audiocodes). The admin tunes `environment` / `deploymentId` post-provision via the existing ABL channel-customization UI.
- `/info` was moved from the internal namespace to `GET /api/v1/channels/ai4w/{connectionId}/info` (HMAC + JWT), and the separate `/ping` endpoint was folded into `/info`.

---

## 5. Runtime Flow

```
AI4W end-user → sends message → AI4W agent delegates to ABL

AI4W backend:
  1. Generate short-lived JWT with end-user email + accountId
  2. Generate X-Signature-Nonce (UUID)
  3. Sign: HMAC-SHA256(connectionSecret, "inbound:" + requestId + "." + timestamp + "." + body)
  4. POST /api/v1/channels/ai4w/{connectionId}/message
     Authorization: Bearer <JWT>
     X-Signature-Nonce: <UUID>
     X-Timestamp: <epoch>
     X-Signature: sha256=<HMAC>
     X-Response-Mode: sync|stream|async
     { text, agentContextId, ... }

ABL runtime:
  1. Check auth failure rate limit for connectionId → 401 if blocked
  2. Look up ChannelConnection by connectionId field → 401 if not found or inactive
  3. Validate HMAC (X-Signature, X-Signature-Nonce, X-Timestamp, rawBody, stored secret)
     → 401 if invalid signature
     → 401 if timestamp outside ±30s window
     → 409 if X-Signature-Nonce already seen (replay)
  4. Validate JWT against AI4W_JWKS_URI → extract email, accountId
     → 401 if invalid or expired
     → Validate aud = "urn:kore:agentic"
  5. Enforce accountId binding: if connection has ai4wAccountId set, jwt.accountId must match → 401
  6. Backfill config.ai4wAccountId if null (findOneAndUpdate, idempotent)
  7. Rate limit by tenantId (getHybridRateLimiter().check())
  8. Build session key: ai4w:{connectionId}:{base64url(email)}:{agentContextId}
  9. Resolve/create session, execute agent
  10. Return response per X-Response-Mode

All 401 responses use identical body:
  { success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } }
  (specific failure reason logged server-side only with connectionId + source IP)
```

---

## 6. Outbound Delivery (ABL → AI4W)

### Async callback signing

ABL signs outbound callbacks with the same `connectionSecret` (symmetric — same key for both directions):

```
POST {connection.config.callbackBaseUrl}
X-Timestamp: <epoch>
X-Signature-Nonce: <requestId from original inbound request>
X-Signature: sha256=HMAC-SHA256(connectionSecret, "outbound:" + requestId + "." + timestamp + "." + responseBody)
Content-Type: application/json

{ response, sessionId, requestId }
```

AI4W validates using its stored connectionSecret. Rejects if HMAC doesn't match or timestamp is stale.

### Proactive notification signing

Same pattern for proactive notifications (human approval, auth challenge):

```
POST {connection.config.notificationUrl}
X-Notification-Id: <notificationId>
X-Timestamp: <epoch>
X-Signature: sha256=HMAC-SHA256(connectionSecret, "outbound:" + notificationId + "." + timestamp + "." + body)
```

### SSE + key rotation interaction

SSE connections are authenticated at request time and stay valid until completion or disconnect. Key rotation does NOT terminate open SSE connections — the auth was valid when the connection was established. New requests after rotation must use the new key.

**SSE heartbeat**: ABL sends a `:heartbeat\n\n` comment frame every 15 seconds on open SSE connections to prevent proxy/LB idle timeouts and allow clients to detect stale connections.

---

## 7. Data Model (Revised)

### ChannelConnection fields for ai4w

```typescript
{
  _id: ObjectId('...'),                            // internal, never exposed
  connectionId: 'ai4w_c_7f3a9b2e4d1c8f5a6b0e3d2c1a9f8e7d',  // public, in URL path
  tenantId: 'tenant_xxx',
  projectId: 'project_yyy',
  channelType: 'ai4w',
  externalIdentifier: 'auto-uuid-123',             // auto-generated, not meaningful
  displayName: 'AI4W Production',
  status: 'active',
  deploymentId: 'dep_zzz',                         // or null (environment-based)
  environment: 'production',                        // or null (deployment-pinned)
  encryptedCredentials: '...',                      // AES-256-GCM encrypted { connectionSecret }
  config: {
    callbackBaseUrl: 'https://work.kore.ai/api/public/agents/:agentId',
    notificationUrl: null,                          // optional, for proactive (P3)
    responseMode: 'sync',                           // default, overridable per-request
    ai4wAccountId: null,                            // backfilled from JWT on first request, enforced after
    provisionedBy: 'manual',                        // 'manual' | 'api'
    lastUsedAt: null,                               // updated periodically (sampled, not every request)
  },
}
```

New index: `{ connectionId: 1 }` unique.

### Connection secret lifecycle

- **Generated**: `crypto.randomBytes(32)` → `abl_cs_` + base64url encoding
- **Stored**: AES-256-GCM encrypted in `encryptedCredentials` (reversible — HMAC validation requires plaintext). Uses ABL's existing credential encryption pipeline.
- **Shown**: once after creation (plaintext), never retrievable again
- **Rotated**: hard cut. New secret generated, old overwritten immediately. New secret shown once.
- **Used bidirectionally**: AI4W signs inbound requests (HMAC), ABL signs outbound callbacks (HMAC). Same key, symmetric.

---

## 8. Configuration (Revised)

| Variable                              | Default                          | Description                                                 |
| ------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `AI4W_CHANNEL_ENABLED`                | `false`                          | Enable ai4w channel (route mounting + adapter registration) |
| `AI4W_JWKS_URI`                       | `https://work.kore.ai/oidc/jwks` | Global JWKS endpoint for JWT validation                     |
| `AI4W_JWT_ISSUER`                     | `https://work.kore.ai`           | Expected JWT issuer for `iss` claim validation              |
| `AI4W_JWT_AUDIENCE`                   | `urn:kore:agentic`               | Expected JWT audience for `aud` claim validation            |
| `AI4W_INTERNAL_API_ENABLED`           | `false`                          | Enable discovery + provisioning APIs (P4)                   |
| `AI4W_HMAC_TIMESTAMP_TOLERANCE_MS`    | `30000`                          | Max age of X-Timestamp (±30 seconds)                        |
| `AI4W_MAX_SSE_CONNECTIONS_PER_TENANT` | `50`                             | Concurrent SSE connections per tenant                       |
| `AI4W_CALLBACK_TIMEOUT_MS`            | `30000`                          | Outbound HTTP timeout for async/proactive delivery          |
| `AI4W_TRUSTED_CALLBACK_CIDRS`         | (empty)                          | Allowlist for private-range callback URLs (same-VPC)        |
| `AI4W_AUTH_BLOCK_THRESHOLD`           | `10`                             | Consecutive auth failures before blocking connectionId      |
| `AI4W_AUTH_BLOCK_DURATION_MS`         | `300000`                         | Block duration after threshold (5 minutes)                  |
| `AI4W_CIRCUIT_BREAKER_LEVEL`          | `tool_service`                   | Circuit breaker granularity for outbound calls              |

---

## 9. What AI4W Needs to Configure

To connect an AI4W agent to an ABL agent, AI4W needs exactly **3 values**:

| Value             | Source                                           | Example                                        |
| ----------------- | ------------------------------------------------ | ---------------------------------------------- |
| ABL Endpoint      | Static per ABL environment (from docs or Studio) | `https://runtime.abl.com/api/v1/channels/ai4w` |
| Connection ID     | Generated by ABL (shown after creation)          | `ai4w_c_7f3a9b2e4d1c8f5a6b0e3d2c1a9f8e7d`      |
| Connection Secret | Generated by ABL (shown once)                    | `abl_cs_8f2b4c6d8f...`                         |

AI4W constructs request URL: `{endpoint}/{connectionId}/message`

For auto-provisioning (P4), all 3 values are returned by the provisioning API — zero manual copy.

---

## 10. Security Considerations

### Trust boundary

ABL trusts AI4W as an identity provider for user email. Session isolation depends on AI4W issuing correct `email` claims in its JWTs. A compromised AI4W JWKS private key would allow impersonation of any user across all connections validated against that JWKS endpoint. This is an inherent trust boundary of the JWT-based identity model.

**Mitigation**: The accountId binding (§2.4) limits blast radius — a compromised JWT from account A cannot use a connection bound to account B, even if the JWKS validates it.

### Audit logging

Security-sensitive operations MUST emit audit events via ABL's existing audit pipeline:

| Operation                 | Event                              | Details logged                                                      |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| Connection created        | `ai4w.connection.created`          | connectionId, projectId, tenantId, createdBy, provisionedBy         |
| Connection secret rotated | `ai4w.connection.rotated`          | connectionId, rotatedBy, timestamp                                  |
| Connection deactivated    | `ai4w.connection.deactivated`      | connectionId, deactivatedBy                                         |
| Connection deleted        | `ai4w.connection.deleted`          | connectionId, deletedBy                                             |
| Callback URL changed      | `ai4w.connection.callback_changed` | connectionId, oldUrl (domain only), newUrl (domain only), changedBy |
| Auth failure              | `ai4w.auth.failed`                 | connectionId, failureReason (HMAC/JWT/replay/blocked), sourceIP     |
| Auth blocked              | `ai4w.auth.blocked`                | connectionId, failureCount, sourceIP                                |
| accountId bound           | `ai4w.connection.account_bound`    | connectionId, ai4wAccountId                                         |

### SSRF protection for callback URLs

Callback URLs are validated on both creation and update:

1. Must be HTTPS (except `localhost` / `127.0.0.1` when `NODE_ENV=development`)
2. DNS resolution must not resolve to private IP ranges:
   - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918)
   - `169.254.0.0/16` (link-local)
   - `127.0.0.0/8` (loopback, except dev)
   - `::1`, `fc00::/7` (IPv6 private)
3. Override: `AI4W_TRUSTED_CALLBACK_CIDRS` env var allowlists specific private ranges for same-VPC deployments
4. Re-validated at delivery time (DNS can change between creation and use)

---

## 11. Changes from Original Feature Spec / HLD / LLD

| Area               | Original Design                                     | Revised Design                                                                                                                                                                             |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth               | JWT only (accountId as sub)                         | HMAC (authorization) + JWT (identity) + accountId binding                                                                                                                                  |
| JWKS               | Per-connection credential, LRU cache                | Global env var, single instance                                                                                                                                                            |
| Connection lookup  | `resolveChannelConnection('ai4w', accountId)`       | Lookup by `connectionId` field (random UUID, not MongoDB \_id)                                                                                                                             |
| Endpoint           | `POST /channels/ai4w/message` (flat)                | `POST /channels/ai4w/{connectionId}/message`                                                                                                                                               |
| Request body       | Includes projectId, agentName, deploymentId         | Only text + agentContextId (agent resolved from connection)                                                                                                                                |
| Request signing    | None                                                | HMAC-SHA256 with direction prefix + nonce + timestamp + body                                                                                                                               |
| Replay protection  | None                                                | X-Signature-Nonce nonce in Redis SET (60s TTL) + ±30s timestamp window                                                                                                                     |
| Studio form        | JWKS URI + accountId + callback URL + response mode | Display name + callback URL + deployment (2+1 fields)                                                                                                                                      |
| externalIdentifier | ai4wAccountId (for lookup)                          | Auto-generated UUID (not used for lookup)                                                                                                                                                  |
| Credentials stored | AI4W's JWKS URI + callback URLs                     | ABL-generated connectionSecret only (AES-256-GCM encrypted)                                                                                                                                |
| Secret management  | AI4W credentials in ABL                             | ABL generates, AI4W stores, HMAC proves. Hard cut on rotation.                                                                                                                             |
| Session key        | `ai4w:{accountId}:{email}:{contextId}`              | `ai4w:{connectionId}:{email}:{contextId}`                                                                                                                                                  |
| JWT sub            | ai4wAccountId (assumed)                             | AI4W userId (actual). ABL uses email claim. accountId enforced via binding.                                                                                                                |
| Connection scope   | Unclear                                             | Project-level, same as other channels. One connection = one deployment.                                                                                                                    |
| LB rate limiting   | Not possible                                        | Per-connectionId in URL path                                                                                                                                                               |
| Outbound auth      | Not specified                                       | HMAC-signed callbacks (same connectionSecret, symmetric, "outbound:" prefix)                                                                                                               |
| SSRF               | Mentioned in HLD, dropped in revision               | Full SSRF validation on callback URLs (create + update + delivery)                                                                                                                         |
| Error responses    | Varied by failure type                              | Uniform 401 for all auth failures (no existence oracle)                                                                                                                                    |
| Internal APIs      | 2 (discover agents, provision)                      | 5 internal (tenants-by-membership, projects/discoverable, provision, deactivate, delete) + 1 channel-namespace (`GET /channels/ai4w/:id/info`) covering both banner and health-check flows |
| Audit logging      | Not specified                                       | Full audit events for connection lifecycle + auth failures                                                                                                                                 |
| Body limits        | text.max(10000) only                                | 1MB body limit, array caps (history 100, files 10), field length caps                                                                                                                      |

---

## 12. Resolved Questions

1. ~~Grace period on key rotation~~: No — hard cut. Simpler, more secure. Coordinate rotation timing out-of-band.
2. **Connection info API caching**: No caching — infrequent design-time action.
3. **accountId backfill race condition**: `findOneAndUpdate` with `{ 'config.ai4wAccountId': null }` condition — idempotent, no race.
4. ~~Secret expiration~~: No — secrets don't auto-expire. Rotation is manual.
