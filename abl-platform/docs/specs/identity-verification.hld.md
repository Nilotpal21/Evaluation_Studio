# Identity Verification -- High-Level Design

**Feature**: Identity Verification
**Feature Spec**: [../features/identity-verification.md](../features/identity-verification.md)
**Test Spec**: [../testing/identity-verification.md](../testing/identity-verification.md)
**Status**: BETA
**Last Updated**: 2026-04-23

---

## What

A hexagonal-architecture identity verification system that supports six verification methods (HMAC, OTP, OAuth with PKCE, email link, provider assertion, webhook challenge) to promote users through a three-tier identity model (anonymous, recognized, verified). The system uses port/adapter separation to allow new verification methods without changing core domain logic. Verification state is stored in Redis with TTL-based expiry, and session resolution maps verified identity artifacts to project-safe session locators plus durable provenance for continuity across reconnects.

## Why

Agent sessions need to know who they are talking to at varying confidence levels. Anonymous users get limited access, recognized users (via cookie or caller ID) get session continuity, and verified users (via OTP, OAuth, HMAC) get full access to sensitive operations. Enterprise customers require cryptographic identity verification for compliance (SOC2, PCI DSS). The platform must support multiple verification methods because different channels (web chat, voice, SMS, WhatsApp) have different identity signals available.

---

## 1. Architecture Approach

### Packages Changed

| Package                       | Scope                                                                | Change Type                                                          |
| ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/runtime`                | `src/contexts/identity/` (domain, use cases, infrastructure, routes) | Primary -- all verification logic                                    |
| `@agent-platform/shared-auth` | `src/types/index.ts`                                                 | Types -- `VerificationMethod`, `ChannelArtifactType`, `IdentityTier` |
| `@abl/core`                   | `src/types/agent-based.ts` (BETA)                                    | Types -- `identityTierRequired` on `AgentTool`                       |
| `@abl/compiler`               | `src/platform/ir/`, `src/platform/constructs/executors/` (BETA)      | IR field + identity tier gate middleware                             |

### Hexagonal Architecture Layers

```
+---------------------------------------------------------------------+
|  DOMAIN (pure logic, no dependencies)                               |
|  - IdentityVerifier port interface (initiate/complete/supports)     |
|  - VerificationDeliveryService port (deliverCode) (BETA)            |
|  - VerificationAttempt value object (create, isExpired, canAttempt) |
|  - IdentityTier (canPromoteTo, tierFromVerification)                |
|  - IdentityArtifact (SHA-256 hash, create)                          |
|  - SessionResolutionKey (buildResolutionKeyId)                      |
+---------------------------------------------------------------------+
|  USE CASES (orchestration)                                          |
|  - VerifyIdentity: dispatcher to correct verifier via supports()    |
|  - PromoteTier: validate tier transitions (pure domain logic)       |
|  - ResolveSession: find session by artifact hash via store port     |
|  - RegisterResolutionKey: save artifact->session mapping            |
+---------------------------------------------------------------------+
|  INFRASTRUCTURE (adapters)                                          |
|  - HmacVerifier: single-step HMAC-SHA256 verification               |
|  - OtpVerifier: two-step with otplib + HMAC-SHA256 + timingSafeEqual|
|  - OAuthVerifier: two-step with PKCE + Arctic v3 provider          |
|  - EmailLinkVerifier: two-step magic link with HMAC token hash      |
|  - ProviderVerifier: sync channel-provider artifact check           |
|  - WebhookVerifier: async challenge/response via external endpoint  |
|  - EmailDeliveryAdapter: bridges VerificationDeliveryService to     |
|    EmailService via DI (BETA)                                        |
|  - RedisVerificationTokenStore: attempt state with TTL              |
|  - RedisResolutionKeyStore: artifact->session mapping with TTL      |
+---------------------------------------------------------------------+
|  ROUTES (HTTP boundary)                                             |
|  - POST /api/identity/verify/initiate                               |
|  - POST /api/identity/verify/complete                               |
|  - GET /api/identity/verify/:attemptId                              |
+---------------------------------------------------------------------+
|  FACTORY                                                            |
|  - createIdentityContext(deps) -> { verifyIdentity, resolveSession, |
|    registerResolutionKey, promoteTier }                              |
+---------------------------------------------------------------------+
```

### Data Flow

```
  Client (SDK / Channel Adapter)
        |
        v
  POST /api/identity/verify/initiate
        |
        v
  Express Router (auth middleware -> tenantContext extraction)
        |
        v
  VerifyIdentity.execute(input)         <--- Use case dispatcher
        |
        +--- iterates verifiers Map<VerificationMethod, IdentityVerifier>
        |    calls supports(input) on each, dispatches to first match
        |
        v
  IdentityVerifier.initiate(input)      <--- Port interface
        |
        +--------+--------+---------+---------+---------+
        |        |        |         |         |         |
        v        v        v         v         v         v
      HMAC     OTP     OAuth    EmailLink  Provider  Webhook
    (sync)   (2-step) (2-step)  (2-step)   (sync)   (2-step)
        |        |        |         |         |         |
        +--------+--------+---------+---------+---------+
        |
        v
  VerificationTokenStore.create(attempt + codeHash)  <--- Redis TTL
        |
        v
  Return { success, attemptId?, challengeData? }
        |
        v
  ... client performs challenge (enter OTP, redirect OAuth, etc.) ...
        |
        v
  POST /api/identity/verify/complete
        |
        v
  IdentityVerifier.complete(attemptId, proof)
        |
        +--- tokenStore.get(tenantId, attemptId)    -- load stored attempt
        +--- validate expiry, rate limit, code/state
        +--- tokenStore.markVerified(tenantId, attemptId)
        |
        v
  Return { success, identityTier, verifiedIdentity }
```

---

## 2. Alternatives Considered

### Alternative A: Middleware-Based Verification

**Description**: Implement identity verification as Express middleware functions that run in the request pipeline, rather than a bounded context with ports and adapters.

**Pros**:

- Simpler initial implementation; less boilerplate
- Direct access to request/response objects
- Familiar Express middleware pattern

**Cons**:

- Adding new verification methods requires modifying the middleware chain
- Tight coupling to Express; harder to test in isolation
- Verification logic mixed with HTTP concerns
- No clear domain model for verification attempts

**Decision**: Rejected. The hexagonal approach is more extensible and testable, which matters given the six different verification methods.

### Alternative B: MongoDB for Verification State

**Description**: Store verification attempts in MongoDB instead of Redis.

**Pros**:

- Durable storage; survives Redis restarts
- Built-in querying for audit and analytics
- Consistent with other platform data models

**Cons**:

- Verification attempts are ephemeral (5-10 minute TTL); MongoDB is overkill
- MongoDB doesn't have native TTL-based key expiry as elegantly as Redis
- Higher latency for the frequent read/write pattern of verification attempts
- No need for complex queries on verification state

**Decision**: Rejected. Redis is the right fit for ephemeral, TTL-based state with high-frequency access. Long-term audit data should be separate.

### Alternative C: Binary Auth Model (Authenticated / Not Authenticated)

**Description**: Two-level model instead of three tiers.

**Pros**:

- Simpler logic
- Easier for agent developers to reason about

**Cons**:

- Cannot distinguish between "I recognize this user from a cookie" and "this user proved their identity with OTP"
- Channels like WhatsApp provide recognized-but-not-cryptographically-verified identities
- Enterprise compliance often requires distinguishing recognition from verification

**Decision**: Rejected. The three-tier model (anonymous, recognized, verified) reflects real-world trust levels that enterprise customers need.

---

## 3. Architectural Concerns

### Concern 1: Tenant Isolation

Every data access is tenant-scoped:

- Redis keys include tenantId: `verify:{tenantId}:{projectId}:{attemptId}`, `session_resolution:{tenantId}:{projectId}:{channelId}:{artifactHash}`
- `VerificationTokenStore.get(tenantId, projectId, attemptId)` (or equivalent stored-scope validation) requires canonical scope inputs before returning attempt state
- Route middleware extracts `tenantId` from `tenantContext` before any operation
- Cross-tenant access returns null (not 403) to avoid leaking resource existence

### Concern 2: Project Isolation

Project isolation is required anywhere verification can affect continuity, recall, join, or authorization:

- `VerificationAttempt` persists `projectId` and `sessionPrincipalId` alongside `tenantId` and `sessionId`
- the status route must validate the caller's project scope before returning attempt state
- session-resolution keys include `projectId`, because continuity is project-scoped even when the underlying contact registry is tenant-scoped
- resolution returns a `SessionResolutionRecord` envelope, not a bare `sessionId`, so downstream consumers do not reconstruct project or provenance later

### Concern 3: User Isolation

Verification attempts are scoped by both the active session and the runtime-generated session principal. `GET /:attemptId` must verify the caller matches the stored `tenantId`, `projectId`, and `sessionPrincipalId` (or arrives through an explicit privileged internal service contract). Wrong-project or wrong-session lookups return non-leaky `404`.

### Concern 4: Authentication & Authorization

- All routes require `tenantContext.tenantId` via middleware check (401 if missing)
- Auth is provided by the unified auth middleware (SDK session tokens, API keys)
- No additional role-based authorization -- verification is available to any authenticated session

### Concern 5: Stateless & Distributed

- All verification state is in Redis (no in-memory state in the runtime process)
- Any runtime pod can handle any verification request (stateless)
- Session resolution keys are in Redis, shared across all pods
- Factory wiring (`createIdentityContext`) uses injected dependencies, no singletons

### Concern 6: Traceability

The target contract requires durable provenance on every verification lifecycle event:

- `TraceEvent`s for initiate, complete, status, and session-resolution registration
- counters for verification success/failure by method, policy source, and grant scope
- privacy-safe audit rows containing `verificationAttemptId`, `tenantId`, `projectId`, `sessionPrincipalId`, `traceId`, `verificationMethod`, `policySource`, and `grantScope`

### Concern 7: Compliance & Encryption

- OTP codes: HMAC-SHA256 hashed before storage (never plaintext)
- OAuth state + PKCE code verifier: stored as JSON in `codeHash` field
- Identity artifacts: SHA-256 hashed before persistence
- Timing-safe comparison: `crypto.timingSafeEqual` in `OtpVerifier` (but NOT in `EmailLinkVerifier` or `WebhookVerifier` -- security gap GAP-013/GAP-014)
- Rate limiting: max 5 attempts per verification flow
- TTL-based automatic cleanup: no manual data retention management needed
- Right to erasure: verification attempts are ephemeral (auto-expire)

### Concern 8: Performance

- Redis sub-millisecond read/write for verification state
- SHA-256 and HMAC-SHA256 are hardware-accelerated on modern CPUs
- No external API calls in the hot path (except OAuth token exchange and webhook challenge)
- `VerifyIdentity` dispatcher iterates a small Map (6 entries max); O(n) is negligible

### Concern 9: Error Handling

Every failure returns a structured error envelope: `{ success: false, error: { code, message } }`. Error codes are specific to each failure mode:

| Error Code                                                               | Source            | Meaning                    |
| ------------------------------------------------------------------------ | ----------------- | -------------------------- |
| `UNAUTHORIZED`                                                           | Route middleware  | Missing tenantContext      |
| `INVALID_INPUT`                                                          | Route handler     | Missing required fields    |
| `NO_VERIFIER`                                                            | VerifyIdentity    | No verifier supports input |
| `HMAC_INVALID` / `HMAC_MISSING_METADATA`                                 | HmacVerifier      | HMAC validation failed     |
| `OTP_EXPIRED` / `OTP_MAX_ATTEMPTS` / `OTP_INVALID`                       | OtpVerifier       | OTP flow errors            |
| `OAUTH_STATE_MISMATCH` / `OAUTH_EXPIRED` / `OAUTH_TOKEN_EXCHANGE_FAILED` | OAuthVerifier     | OAuth flow errors          |
| `TOKEN_EXPIRED` / `TOKEN_MISMATCH` / `ALREADY_VERIFIED`                  | EmailLinkVerifier | Email link errors          |
| `WEBHOOK_EXPIRED` / `WEBHOOK_CHALLENGE_MISMATCH` / `WEBHOOK_SEND_FAILED` | WebhookVerifier   | Webhook errors             |
| `PROVIDER_NOT_VERIFIED`                                                  | ProviderVerifier  | Provider assertion failed  |

Route handlers catch all exceptions and return 500 with `INTERNAL_ERROR`.

### Concern 10: Observability

Observability is part of the steady-state contract, not optional hardening:

- emit `TraceEvent` for verification initiate, complete, status, and resolution-key registration
- add verification success/failure counters keyed by `verificationMethod`, `identityTier`, `policySource`, and `grantScope`
- ensure every verifier and Redis adapter logs with `tenantId`, `projectId`, `sessionPrincipalId`, and `verificationAttemptId` context

### Concern 11: Rollback Plan

The identity verification context is a self-contained bounded context. Rollback strategy:

- **Route level**: Remove the `app.use('/api/identity/verify', ...)` line from `server.ts`
- **Context level**: The entire `src/contexts/identity/` directory can be deleted without affecting other contexts
- **Type level**: The shared-auth types (`VerificationMethod`, etc.) are used by `CallerIdentity` in auth contexts, so those must remain

### Concern 12: Test Strategy

| Layer          | Test Type   | What's Tested                                  | Status                       |
| -------------- | ----------- | ---------------------------------------------- | ---------------------------- |
| Domain         | Unit        | Value objects, tier logic, artifact hashing    | DONE (6 test files)          |
| Use cases      | Unit        | Dispatcher, tier promotion, session resolution | DONE (4 test files)          |
| Infrastructure | Unit        | Redis stores with mocked Redis                 | DONE (2 test files)          |
| Routes         | Integration | Express endpoints with mocked use cases        | DONE (1 test file)           |
| Full lifecycle | Integration | HMAC -> contact -> session (in-memory stores)  | DONE (1 test file)           |
| HTTP API       | E2E         | Real server + InMemoryRedis + auth middleware  | DONE (7 scenarios, 13 tests) |

---

## 4. Data Model

### Redis Data Structures

**Verification Attempts**:

```
Key:   verify:{tenantId}:{projectId}:{attemptId}
Value: JSON { id, tenantId, projectId, sessionId, sessionPrincipalId, channelId,
              traceId, method, identityValue, identityType, status, attempts,
              maxAttempts, codeHash, createdAt, expiresAt, policySource,
              grantScope, verifiedAt? }
TTL:   Method-specific (OTP: 600s, OAuth: 600s, email: 3600s, webhook: 300s)
```

**Session Resolution Keys**:

```
Key:   session_resolution:{tenantId}:{projectId}:{channelId}:{artifactHash}
Value: JSON {
         sessionLocator: { tenantId, projectId, sessionId },
         sessionPrincipalId,
         verificationAttemptId,
         identityTier,
         verificationMethod,
         policySource,
         grantScope,
         verifiedAt,
         traceId
       }
TTL:   Configurable (default: 86400s / 24h)
```

### Domain Value Objects (not persisted directly)

```typescript
interface VerificationAttempt {
  id: string; // UUID
  tenantId: string;
  projectId: string;
  sessionId: string;
  sessionPrincipalId: string;
  channelId: string;
  traceId: string;
  method: VerificationMethod;
  identityValue: string;
  identityType: ChannelArtifactType;
  status: 'pending' | 'verified' | 'expired' | 'failed';
  attempts: number;
  maxAttempts: number; // default: 5
  createdAt: Date;
  expiresAt: Date;
  policySource: 'runtime_default' | 'channel_policy' | 'project_policy' | 'tenant_policy';
  grantScope: 'session' | 'same_channel' | 'project_contact' | 'cross_channel' | 'service';
  verifiedAt?: Date;
}

interface IdentityArtifact {
  rawValue: string; // never persisted
  artifactType: ChannelArtifactType;
  hashedValue: string; // SHA-256 hex
}

interface SessionResolutionRecord {
  sessionLocator: { tenantId: string; projectId: string; sessionId: string };
  sessionPrincipalId: string;
  verificationAttemptId: string;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  policySource: 'runtime_default' | 'channel_policy' | 'project_policy' | 'tenant_policy';
  grantScope: 'session' | 'same_channel' | 'project_contact' | 'cross_channel' | 'service';
  verifiedAt: Date;
  traceId: string;
}

type IdentityTier = 0 | 1 | 2;
// 0 = anonymous, 1 = recognized, 2 = verified
```

### Shared Types (in `@agent-platform/shared-auth`)

```typescript
type VerificationMethod =
  | 'none'
  | 'cookie'
  | 'caller_id'
  | 'provider'
  | 'hmac'
  | 'otp'
  | 'oauth'
  | 'email_link'
  | 'webhook';

type ChannelArtifactType =
  | 'caller_id'
  | 'cookie'
  | 'device_id'
  | 'email'
  | 'phone'
  | 'username'
  | 'api_client'
  | 'sip_uri';
```

---

## 5. API Design

### Endpoints

| Method | Path                              | Auth                  | Purpose                                                 |
| ------ | --------------------------------- | --------------------- | ------------------------------------------------------- |
| POST   | `/api/identity/verify/initiate`   | SDK session / API key | Start verification flow                                 |
| POST   | `/api/identity/verify/complete`   | SDK session / API key | Complete with proof                                     |
| GET    | `/api/identity/verify/:attemptId` | SDK session / API key | Query attempt status for the same project/session scope |

### Request/Response Schemas

**POST /initiate**

Request:

```json
{
  "method": "otp",
  "identityValue": "user@example.com",
  "identityType": "email",
  "metadata": {}
}
```

Success response:

```json
{
  "success": true,
  "attemptId": "uuid",
  "challengeData": { "userAction": "enter_otp", "code": "123456" }
}
```

Error response:

```json
{
  "success": false,
  "error": { "code": "INVALID_INPUT", "message": "..." }
}
```

**POST /complete**

Request:

```json
{
  "attemptId": "uuid",
  "proof": {
    "type": "otp_code",
    "value": "123456",
    "metadata": { "tenantId": "..." }
  }
}
```

Success response:

```json
{
  "success": true,
  "identityTier": 2,
  "verifiedIdentity": "user@example.com"
}
```

**GET /:attemptId**

Success response:

```json
{
  "attemptId": "uuid",
  "status": "pending",
  "method": "otp",
  "expiresAt": "2026-03-22T12:10:00.000Z"
}
```

### Error Responses

| Status Code | When                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| 400         | Missing required fields (method, identityValue, identityType, attemptId, proof) |
| 401         | Missing auth / tenantContext                                                    |
| 404         | Attempt not found or cross-tenant access                                        |
| 500         | Unexpected server error (Redis down, etc.)                                      |

---

## 6. Cross-Cutting Concerns

### Audit Logging

Verification events must emit to the PII audit log (existing integration with `pii-audit-log.model.ts`) with privacy-safe provenance fields. Durable audit is mandatory for the target contract, even if analytics rollups remain a later concern.

### Rate Limiting

Per-attempt rate limiting (max 5 attempts) is enforced by the domain layer (`canAttempt()`). No global rate limiting on the API endpoints (e.g., per-IP or per-tenant request throttling). This is a hardening concern.

### Caching

No caching needed. Verification attempts are short-lived (5-60 minutes) and read/written only during active verification flows.

### Encryption

- At rest: OTP codes HMAC-SHA256 hashed. Identity artifacts SHA-256 hashed. OAuth state/PKCE stored as JSON.
- In transit: HTTPS (platform standard). No additional encryption layer.

---

## 7. Dependencies

### Upstream (this feature depends on)

| Dependency                          | Risk                                                | Mitigation                                    |
| ----------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| Redis                               | Medium -- Redis unavailable breaks all verification | Structured error responses, retry in client   |
| Unified auth middleware             | Low -- stable, well-tested                          | Dependency injection in tests                 |
| `@agent-platform/shared-auth` types | Low -- shared type definitions                      | Type changes require coordinated update       |
| otplib (npm)                        | Low -- well-maintained OTP library                  | Pinned version in package.json                |
| Arctic v3 (npm)                     | Low -- OAuth provider library                       | Abstracted behind `OAuthProviderAdapter` port |

### Downstream (depends on this feature)

| Consumer           | Impact                                                     | Notes                                           |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------- |
| Session management | Medium -- session resolution depends on identity artifacts | Graceful fallback if identity context not wired |
| Contact management | Low -- optional identity-to-contact linking                | `promote-and-link.ts` orchestration             |
| Agent DSL gating   | Future -- agents will gate operations by identity tier     | Not yet implemented                             |

---

## 8. Key Integration Points

- **Session lifecycle**: After verification, session resolution maps verified artifact hash to existing session for continuity
- **Channel adapters**: Each channel provides different identity artifacts that feed into the verification system
- **Auth middleware**: All routes depend on `tenantContext` from unified auth middleware
- **Factory wiring**: `createIdentityContext()` wires all dependencies; `server.ts` mounts the router
- **Contact management**: Verified identity feeds into `ResolveOrCreateContact` via `promote-and-link.ts`

---

## 9. Decisions Closed For This HLD

1. **Atomic rate limiting**: `incrementAttempts()` must use atomic Redis operations.
2. **Project-safe status reads**: `GET /:attemptId` must verify the caller matches the stored `tenantId`, `projectId`, and `sessionPrincipalId`, unless the request uses an explicit privileged internal service contract.
3. **Resolution contract**: session resolution must return a project-safe `SessionResolutionRecord` envelope rather than a bare `sessionId`.
4. **Audit durability**: verification lifecycle events must emit durable PII audit rows plus `TraceEvent`s and counters with provenance fields.

---

## 10. References

- Feature spec: [../features/identity-verification.md](../features/identity-verification.md)
- Test spec: [../testing/identity-verification.md](../testing/identity-verification.md)
- Identity context barrel: `apps/runtime/src/contexts/identity/index.ts`
- Server wiring: `apps/runtime/src/server.ts` (search for "Identity & Contact Route Wiring")
- Shared auth types: `packages/shared-auth/src/types/index.ts`
- Orchestration context: `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`
