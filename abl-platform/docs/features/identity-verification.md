# Feature: Identity Verification

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `customer experience`, `governance`, `enterprise`
**Package(s)**: `apps/runtime` (`src/contexts/identity/`), `@abl/compiler` (`src/platform/`), `@abl/core` (`src/types/`), `@agent-platform/shared-auth`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/identity-verification.md](../testing/identity-verification.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

Agent platforms interact with end users across multiple channels (web chat, SMS, voice, SDK). Users arrive at different levels of trust: anonymous visitors, recognized returning users (via cookies or device IDs), and verified users (via OAuth, OTP, or HMAC signatures). Without a structured identity verification system, agents cannot gate access to sensitive operations (account changes, PII disclosure, payments) based on the user's verification level. The lack of a unified identity model forces each agent developer to build ad-hoc verification logic, leading to inconsistent security postures and compliance gaps.

### Goal Statement

Provide a multi-method, multi-tier identity verification system that allows agents to verify end-user identity through HMAC signatures, OTP codes, OAuth flows, email links, provider assertions, and webhook-based challenges, while producing project-safe session-resolution records and durable provenance for continuity, authorization, and audit.

### Summary

The identity verification system is implemented as a bounded context (`apps/runtime/src/contexts/identity/`) following hexagonal architecture (ports and adapters). The domain layer defines an `IdentityVerifier` port interface with `initiate()`, `complete()`, and `supports()` methods, a three-tier identity model (anonymous -> recognized -> verified), and a `VerificationAttempt` value object tracking attempt lifecycle with expiry and rate limits. Six verifier adapters implement the port: HMAC (single-step cryptographic), OTP (two-step with HMAC-hashed codes), OAuth (two-step with PKCE + state via Arctic v3), email link (two-step with HMAC-hashed tokens), provider assertion (single-step channel-verified), and webhook challenge (two-step with external endpoint). A REST API exposes initiate/complete/status endpoints via an Express router factory. The `VerificationTokenStore` port persists attempt state in Redis with TTL-based expiry. Session resolution maps verified identity artifacts (hashed with SHA-256) to project-safe `SessionResolutionRecord` envelopes so omnichannel continuity and session-scope enforcement can consume canonical provenance instead of reconstructing it later.

---

## 2. Scope

### Goals

- Three-tier identity model: Tier 0 (anonymous), Tier 1 (recognized via cookie/caller_id/provider), Tier 2 (verified via HMAC/OTP/OAuth)
- Six verification methods: HMAC, OTP, OAuth, email link, provider assertion, webhook
- Initiate/complete two-step verification pattern for all challenge-response methods
- Rate limiting via attempt counter with configurable max attempts (default: 5)
- Expiry windows for verification attempts (OTP/OAuth: 10 minutes, email link: 1 hour, webhook: 5 minutes)
- Secure code storage: OTP codes hashed with HMAC-SHA256, never stored in plaintext
- OAuth PKCE + state parameter protection against CSRF and code interception
- Tenant-scoped and project-scoped verification attempts for continuity-sensitive flows
- Session resolution via hashed identity artifacts (SHA-256) with project-safe locator + provenance envelopes
- Durable provenance for verification lifecycle events (`verificationAttemptId`, `sessionPrincipalId`, `traceId`, `policySource`, `grantScope`)
- Hexagonal architecture enabling new verification methods without modifying core logic

### Non-Goals (Out of Scope)

- Biometric verification (fingerprint, face recognition)
- Multi-factor authentication (MFA) stacking (each verification flow is independent)
- Admin UI for managing verification policies
- Verification result caching across sessions
- Phone call verification (IVR-based)
- SMS delivery adapter (Twilio/generic SMS bridge deferred — see GAP-017)

### BETA Scope Additions

The following items were originally listed as Non-Goals but have been promoted to Goals for BETA:

- **Email delivery infrastructure** (BETA): OTP codes and magic-link tokens are delivered via the existing `EmailService` from `packages/shared`. A `VerificationDeliveryService` port in the identity context delegates to an `EmailDeliveryAdapter` injected via DI. Raw codes/tokens are stripped from HTTP responses when delivery is configured. SMS delivery is deferred (GAP-017).
- **Verification policy configuration via DSL** (BETA): Agent tool definitions can declare `identityTierRequired: 0 | 1 | 2` to gate tool access by identity tier. An `identityTierGateMiddleware` in the compiler's tool middleware chain enforces the gate at execution time. This is the primary consumer of the identity verification system (User Story 1).

---

## 3. User Stories

1. As an **agent developer**, I want to require identity verification before sensitive operations so that only verified users can access account information.
2. As an **end user**, I want to verify my identity via OTP code so that I can access my account securely without remembering a password.
3. As an **end user**, I want to sign in via OAuth (Google, Microsoft, GitHub) so that I can verify my identity using an existing social account.
4. As an **SDK integrator**, I want to pass HMAC signatures for pre-authenticated users so that verified identity is established at connection time without user interaction.
5. As a **platform operator**, I want verification attempts rate-limited and time-bound so that brute-force attacks are prevented automatically.
6. As a **security engineer**, I want OTP codes hashed before storage and compared with timing-safe equality so that the verification system is resistant to database leaks and timing attacks.
7. As a **channel adapter developer**, I want to register new verification methods by implementing a single port interface so that new identity signals can be added without modifying existing code.

---

## 4. Functional Requirements

1. **FR-1**: The system must support six verification methods: `hmac`, `otp`, `oauth`, `email_link`, `provider`, `webhook`.
2. **FR-2**: The system must implement a three-tier identity model where Tier 0 = anonymous, Tier 1 = recognized (cookie, caller_id, provider), Tier 2 = verified (hmac, otp, oauth).
3. **FR-3**: Tier promotion must be strictly upward: 0->1, 0->2, 1->2. Same-tier and downgrade must be rejected by `canPromoteTo()`.
4. **FR-4**: OTP codes must be hashed with HMAC-SHA256 before storage and compared using `crypto.timingSafeEqual` to prevent timing attacks.
5. **FR-5**: OAuth flows must use PKCE (code verifier/challenge) and state parameters, both stored in the `VerificationTokenStore`, with state validated on completion.
6. **FR-6**: Each verification attempt must enforce a maximum attempt count (default: 5) and an expiry window (OTP: 10 min, OAuth: 10 min, email link: 1 hour, webhook: 5 min).
7. **FR-7**: Identity artifacts must be hashed with SHA-256 before storage (raw values never persisted in plaintext).
8. **FR-8**: All verification operations must be tenant-scoped, and any verification flow that can affect continuity, recall, live-session join, or authorization must also be project-scoped. Cross-tenant and cross-project access must return null/404.
9. **FR-9**: The REST API must expose `POST /api/identity/verify/initiate`, `POST /api/identity/verify/complete`, and `GET /api/identity/verify/:attemptId` endpoints.
10. **FR-10**: The `VerifyIdentity` use case must iterate registered verifiers and dispatch to the first one whose `supports()` returns true for the given input.
11. **FR-11**: The webhook verifier must send a random challenge to a customer-configured URL and verify the response matches the stored HMAC-hashed challenge.
12. **FR-12**: Session resolution must map `(tenantId, projectId, channelId, artifactHash)` tuples to project-safe `SessionResolutionRecord` envelopes `{ sessionLocator, sessionPrincipalId, verificationAttemptId, verificationMethod, identityTier, policySource, grantScope, verifiedAt, traceId }`, stored in Redis with configurable TTL.
13. **FR-13**: `GET /api/identity/verify/:attemptId` must verify the caller matches the stored `tenantId`, `projectId`, and `sessionPrincipalId`, unless the request uses an explicit privileged internal-service contract. Wrong-project or wrong-session reads must return non-leaky `404`.
14. **FR-14**: Verification initiate, complete, status, and resolution-key registration must emit durable provenance to traces and privacy-safe audit storage. At minimum this includes `verificationAttemptId`, `tenantId`, `projectId`, `sessionPrincipalId`, `traceId`, `verificationMethod`, `policySource`, and `grantScope`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                       |
| -------------------------- | ------------ | --------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Continuity-sensitive verification and session resolution are project-scoped |
| Agent lifecycle            | SECONDARY    | Agents can gate operations on identity tier via use cases                   |
| Customer experience        | PRIMARY      | End users verify identity during conversations                              |
| Integrations / channels    | PRIMARY      | HMAC for SDK, OAuth for web, OTP for SMS/email, provider for WhatsApp       |
| Observability / tracing    | SECONDARY    | Verification attempts tracked; PII audit log integration                    |
| Governance / controls      | PRIMARY      | Identity verification is a core security control                            |
| Enterprise / compliance    | PRIMARY      | KYC requirement; SOC2/PCI DSS compliance driver                             |
| Admin / operator workflows | NONE         | No admin UI for verification management (gap)                               |

### Related Feature Integration Matrix

| Related Feature        | Relationship Type | Why It Matters                                    | Key Touchpoints                                             | Current State |
| ---------------------- | ----------------- | ------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| Session Management     | depends on        | Verification tied to session lifecycle            | `sessionId` in `VerificationInput`, session resolution keys | STABLE        |
| Contact Management     | extends           | Verified identity links to contact records        | `promote-and-link.ts` in orchestration context              | BETA          |
| Audit Logging          | emits into        | PII access events from verification flows         | `pii-audit-log.model.ts`                                    | BETA          |
| Channels (SDK/Web/SMS) | configured by     | Channel determines available verification methods | `channelType` in `VerificationInput`, `ChannelArtifactType` | STABLE        |
| Omnichannel Continuity | depends on        | Session resolution uses identity artifact hashes  | `resolution-key-store.ts`, `RedisResolutionKeyStore`        | ALPHA         |
| Auth Middleware        | depends on        | Routes require `tenantContext` from unified auth  | `req.tenantContext` (typed via Express declaration merging) | STABLE        |

---

## 6. Design Considerations (Optional)

N/A -- Identity verification is a backend-only feature. The verification UX (OTP input, OAuth redirect) is handled by the client SDK or channel adapter. No Studio UI components are needed.

---

## 7. Technical Considerations (Optional)

- **Hexagonal architecture**: The identity context follows ports-and-adapters. Domain types (`IdentityVerifier`, `VerificationAttempt`) live in `domain/`, use cases in `use-cases/`, adapters in `infrastructure/verifiers/`. New verification methods are added by implementing the `IdentityVerifier` interface without modifying existing code.
- **PKCE for OAuth**: The `OAuthVerifier` generates a random code verifier (32 bytes) and stores it alongside the state parameter (32 bytes) as JSON in `codeHash`. The `OAuthProviderAdapter` port abstracts Arctic v3 providers (Google, Microsoft, GitHub).
- **Timing-safe comparison**: All verifiers with hash comparison (OTP, email link, webhook) use `crypto.timingSafeEqual` on hex-encoded HMAC hashes to prevent timing attacks. Length check guards the comparison.
- **Factory wiring**: `createIdentityContext(deps)` wires all use cases with injected dependencies, making the context fully testable with mock stores and providers.
- **Server.ts wiring**: `server.ts` mounts identity verification routes with real dependencies: `RedisVerificationTokenStore` backed by the Redis client, 5 verifiers (HMAC, OTP, provider, email_link, webhook), HMAC secret from `IDENTITY_HMAC_SECRET` or `ENCRYPTION_MASTER_KEY` env vars. Routes are guarded — they won't mount if no secret is configured.
- **SSRF protection**: The `WebhookVerifier` validates user-provided webhook URLs, blocking private IPs, localhost, cloud metadata endpoints, and non-http/https schemes.
- **Atomic Redis operations**: `incrementAttempts()` and `markVerified()` use Lua scripts (`cjson.decode/encode`) for atomic JSON field updates, preventing race conditions.
- **VerificationMethod union**: All 9 values (`none`, `cookie`, `caller_id`, `hmac`, `otp`, `oauth`, `provider`, `email_link`, `webhook`) are present in both `@agent-platform/shared-auth` and `@agent-platform/shared-kernel`.

---

## 8. How to Consume

### Studio UI

N/A -- Verification flows are initiated by the agent runtime or client SDK, not Studio.

### API (Runtime)

| Method | Path                              | Purpose                                                            |
| ------ | --------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/identity/verify/initiate`   | Initiate a verification flow                                       |
| POST   | `/api/identity/verify/complete`   | Complete a verification with proof                                 |
| GET    | `/api/identity/verify/:attemptId` | Get verification attempt status for the same project/session scope |

**POST /initiate** body:

```json
{
  "method": "otp",
  "identityValue": "user@example.com",
  "identityType": "email",
  "metadata": {}
}
```

**POST /complete** body:

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

**GET /:attemptId** response:

```json
{
  "success": true,
  "data": {
    "attemptId": "uuid",
    "status": "pending",
    "method": "otp",
    "expiresAt": "2026-03-22T12:10:00.000Z"
  }
}
```

### API (Studio)

N/A -- No Studio-side API routes for identity verification.

### Admin Portal

N/A -- No admin verification management UI currently. This is identified as GAP-008.

### Channel / SDK / Voice / A2A / MCP Integration

- **SDK (web chat)**: HMAC verification at connection time via `metadata.hmac` and `metadata.timestamp`. The `HmacVerifier` performs single-step verification in `initiate()`.
- **OAuth**: Redirect flow for web channels. `OAuthVerifier.initiate()` returns `challengeData.redirectUrl`. After the OAuth callback, `complete()` exchanges the authorization code for tokens and fetches the verified email.
- **SMS/Voice**: OTP code generated by `OtpVerifier.initiate()` and returned in `challengeData.code`. Delivery is delegated to the orchestration layer via the appropriate channel adapter.
- **WhatsApp/Provider**: `ProviderVerifier` checks `metadata.providerVerified === true`. WhatsApp provides verified phone numbers natively.
- **Webhook**: `WebhookVerifier` sends a random challenge to `metadata.webhookUrl` and verifies the customer's response.

---

## 9. Data Model

### VerificationAttempt (Redis, TTL-based)

```text
Key: verify:{tenantId}:{projectId}:{attemptId}
Value: JSON {
  id: string (UUID)
  tenantId: string
  projectId: string
  sessionId: string
  sessionPrincipalId: string
  channelId: string
  traceId: string
  method: VerificationMethod ('hmac' | 'otp' | 'oauth' | 'email_link' | 'provider' | 'webhook')
  identityValue: string
  identityType: ChannelArtifactType ('email' | 'phone' | 'device_id' | 'cookie' | 'caller_id' | ...)
  status: 'pending' | 'verified' | 'expired' | 'failed'
  attempts: number (current attempt count)
  maxAttempts: number (default: 5)
  codeHash: string (HMAC-SHA256 of OTP code, or JSON of OAuth state+codeVerifier)
  createdAt: ISO string
  expiresAt: ISO string
  policySource: 'runtime_default' | 'channel_policy' | 'project_policy' | 'tenant_policy'
  grantScope: 'session' | 'same_channel' | 'project_contact' | 'cross_channel' | 'service'
  verifiedAt?: ISO string
}
TTL: Matches expiresAt (OTP: 600s, OAuth: 600s, email link: 3600s, webhook: 300s)
```

### Session Resolution Key (Redis, TTL-based)

```text
Key: session_resolution:{tenantId}:{projectId}:{channelId}:{artifactHash}
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
TTL: Configurable, default 86400s (24 hours), minimum 1s
```

### Identity Artifact (value object, not persisted directly)

```text
Fields:
  rawValue: string (never persisted)
  artifactType: ChannelArtifactType
  hashedValue: string (SHA-256 hex, 64 chars, used for session resolution)
```

### Identity Tier Model

```text
Tier 0 (anonymous): No identity artifacts
Tier 1 (recognized): cookie, caller_id, provider assertion
Tier 2 (verified): hmac, otp, oauth (cryptographic proof)
```

### Key Relationships

- `VerificationAttempt.sessionId` links to the active session in the session management system
- `VerificationAttempt.projectId` and `sessionPrincipalId` keep status reads and continuity decisions project-safe and provenance-bearing
- `VerificationAttempt.tenantId` enforces tenant isolation at the data layer
- Session resolution keys map `(tenantId, projectId, channelId, artifactHash)` to project-safe session locator/provenance envelopes for cross-reconnect continuity
- Verified identity feeds into contact management via `promote-and-link.ts` in the orchestration context

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/contexts/identity/domain/identity-verifier.ts`      | Port interface: `IdentityVerifier`, `VerificationInput`, `VerificationProof`, `VerificationResult`       |
| `apps/runtime/src/contexts/identity/domain/verification-attempt.ts`   | `VerificationAttempt` value object, `createVerificationAttempt()` factory, `isExpired()`, `canAttempt()` |
| `apps/runtime/src/contexts/identity/domain/identity-tier.ts`          | Tier promotion logic: `canPromoteTo()`, `tierFromVerification()`, `VERIFICATION_TIER_MAP`                |
| `apps/runtime/src/contexts/identity/domain/identity-artifact.ts`      | Identity artifact with SHA-256 hashing: `hash()`, `create()` functions                                   |
| `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts` | `SessionResolutionKey` type and `buildResolutionKeyId()` key builder                                     |
| `apps/runtime/src/contexts/identity/domain/verification-delivery.ts`  | `VerificationDeliveryService` port interface for code/token delivery                                     |

### Compiler / DSL (BETA)

| File                                                                                   | Purpose                                                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                                               | `AgentTool.identityTierRequired` AST field (`0 \| 1 \| 2`)                          |
| `packages/compiler/src/platform/ir/schema.ts`                                          | `ToolDefinition.identity_tier_required` IR field                                    |
| `packages/compiler/src/platform/ir/compiler.ts`                                        | AST→IR mapping in `compileTools()` + `mergeAgentToolBehavior()`                     |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts`                        | AST→IR mapping in `compileToolDefinitionAST()` for behavior profiles                |
| `packages/compiler/src/platform/constructs/executors/identity-tier-gate-middleware.ts` | `createIdentityTierGateMiddleware()` — blocks tool execution when tier insufficient |
| `apps/runtime/src/services/execution/llm-wiring.ts`                                    | Identity tier gate wired into tool middleware chain                                 |

### Use Cases

| File                                                                      | Purpose                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/contexts/identity/use-cases/verify-identity.ts`         | `VerifyIdentity` dispatcher: iterates verifiers, calls `supports()` + `initiate()`                                  |
| `apps/runtime/src/contexts/identity/use-cases/promote-tier.ts`            | `PromoteTier`: validates tier transitions via domain logic                                                          |
| `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts`         | `ResolveSession`: finds project-safe session-resolution records by `(tenantId, projectId, channelId, artifactHash)` |
| `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts` | `RegisterResolutionKey`: stores artifact-to-session-resolution mapping with provenance                              |

### Infrastructure / Adapters

| File                                                                                  | Purpose                                                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts`        | HMAC single-step verifier; wraps `verifyHMAC` from `artifact-hasher.ts`     |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts`         | OTP two-step verifier; uses otplib + HMAC-SHA256 + `timingSafeEqual`        |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts`       | OAuth two-step verifier; PKCE + state via `OAuthProviderAdapter` port       |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts`  | Email magic link; HMAC-hashed token with 1-hour TTL                         |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/provider-verifier.ts`    | Channel provider assertion; single-step `providerVerified` check            |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`     | Webhook challenge/response; external endpoint with `SendChallengeFn`        |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-adapters.ts`       | Arctic v3 adapters: Google, Microsoft, GitHub with DI constructor overloads |
| `apps/runtime/src/contexts/identity/infrastructure/email-delivery-adapter.ts`         | `EmailDeliveryAdapter` — sends OTP/magic-link emails via `EmailSender` DI   |
| `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts`       | `VerificationTokenStore` port interface + `StoredVerificationAttempt` type  |
| `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts` | Redis-backed token store with JSON serialization and TTL                    |
| `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`           | `RedisResolutionKeyStore`: Redis-backed session resolution                  |

### Routes / Handlers

| File                                               | Purpose                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/runtime/src/routes/identity-verification.ts` | Express router factory: `POST /initiate`, `POST /complete`, `GET /:attemptId` |

### Factory / Barrel

| File                                          | Purpose                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/runtime/src/contexts/identity/index.ts` | Public API: re-exports all types, `createIdentityContext()` factory function |

### UI Components

N/A -- No dedicated UI. Verification flows are triggered by the agent runtime or client SDK.

### Jobs / Workers / Background Processes

N/A -- No background jobs. All verification is synchronous request/response via Redis.

### Tests

| File                                                                                  | Type        | Coverage Focus                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/contexts/identity/hmac-verifier.test.ts`                  | unit        | HMAC signature validation, missing metadata, secret key correctness                                                                                         |
| `apps/runtime/src/__tests__/contexts/identity/otp-verifier.test.ts`                   | unit        | OTP code generation, HMAC hash, timing-safe compare, rate limit, expiry                                                                                     |
| `apps/runtime/src/__tests__/contexts/identity/oauth-verifier.test.ts`                 | unit        | OAuth initiate (PKCE + state), complete (state validation, token exchange)                                                                                  |
| `apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts`            | unit        | Magic link token generation, hash comparison, expiry, already-verified                                                                                      |
| `apps/runtime/src/__tests__/contexts/identity/provider-verifier.test.ts`              | unit        | Provider-verified flag check, supports() routing                                                                                                            |
| `apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts`                | unit        | Artifact hashing, tier promotion, attempt lifecycle                                                                                                         |
| `apps/runtime/src/__tests__/contexts/identity/promote-tier.test.ts`                   | unit        | Valid promotions, rejections (same-tier, downgrade)                                                                                                         |
| `apps/runtime/src/__tests__/contexts/identity/verify-identity.test.ts`                | unit        | Dispatcher routing, no-verifier fallback                                                                                                                    |
| `apps/runtime/src/__tests__/contexts/identity/resolve-session.test.ts`                | unit        | Key lookup, not-found response                                                                                                                              |
| `apps/runtime/src/__tests__/contexts/identity/redis-verification-token-store.test.ts` | unit        | CRUD, TTL, tenant isolation, Date serialization round-trip                                                                                                  |
| `apps/runtime/src/__tests__/contexts/identity/resolution-key-store.test.ts`           | unit        | Key format, TTL, tenant isolation                                                                                                                           |
| `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts`            | integration | Express routes with mocked deps, auth check (401), input validation (400)                                                                                   |
| `apps/runtime/src/__tests__/contexts/integration/identity.e2e.test.ts`                | integration | Full HMAC identity -> contact -> session resolution cycle (in-memory stores)                                                                                |
| `apps/runtime/src/__tests__/contexts/identity/oauth-adapters.test.ts`                 | unit        | Google/Microsoft/GitHub OAuth adapters: DI-injected Arctic providers, userinfo fetch, error paths (16 tests)                                                |
| `apps/runtime/src/__tests__/contexts/identity/email-delivery-adapter.test.ts`         | unit        | EmailDeliveryAdapter: OTP/magic-link templates, error handling, XSS escaping (8 tests)                                                                      |
| `apps/runtime/src/__tests__/contexts/identity/delivery-integration.test.ts`           | integration | Delivery service wiring: code delivery + response stripping, backward compat, failure resilience (5 tests)                                                  |
| `packages/compiler/src/__tests__/compiler-identity-tier.test.ts`                      | unit        | identityTierRequired→identity_tier_required: compileTools, compileToolDefinitionAST, mergeAgentToolBehavior (9 tests)                                       |
| `packages/compiler/src/__tests__/identity-tier-gate-middleware.test.ts`               | unit        | Identity tier gate middleware: blocks insufficient tier, passes sufficient/absent, error response format (10 tests)                                         |
| `apps/runtime/src/__tests__/contexts/identity/identity-e2e-http.test.ts`              | e2e         | 7 scenarios (13 tests): HMAC, OTP complete flow, rate limiting + TTL expiry, cross-tenant isolation, OAuth, input validation, webhook with real HTTP server |

---

## 11. Configuration

### Environment Variables

| Variable                | Default                               | Description                                                                               |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `IDENTITY_HMAC_SECRET`  | Falls back to `ENCRYPTION_MASTER_KEY` | HMAC secret key for HMAC/OTP/email-link/webhook verifiers. Routes won't mount without it. |
| (OAuth provider config) | (see BETA additions below)            | OAuth client ID, client secret, redirect URI — wired via Arctic v3 adapters in BETA       |

### Runtime Configuration

- `VERIFICATION_TIER_MAP` in `identity-tier.ts`: Maps each `VerificationMethod` to its identity tier
- OTP max attempts: `OTP_MAX_ATTEMPTS = 5` (hardcoded in `otp-verifier.ts`)
- OTP TTL: `OTP_TTL_SECONDS = 600` (10 minutes)
- OAuth TTL: `OAUTH_TTL_MS = 600_000` (10 minutes)
- Email link TTL: `TOKEN_TTL_MS = 3_600_000` (1 hour)
- Webhook TTL: `WEBHOOK_TTL_MS = 300_000` (5 minutes)
- PKCE code verifier: `CODE_VERIFIER_BYTE_LENGTH = 32` bytes
- OAuth state parameter: `STATE_BYTE_LENGTH = 32` bytes
- Resolution key default TTL: `DEFAULT_TTL_SECONDS = 86_400` (24 hours)

### DSL / Agent IR / Schema

- **`identityTierRequired`** on `AgentTool` AST type (`@abl/core`): Declares the minimum identity tier (0, 1, or 2) required to execute a tool. Set on the tool definition in the agent DSL.
- **`identity_tier_required`** on `ToolDefinition` IR type (`@abl/compiler`): Compiled IR representation. Mapped from AST by `compileTools()` in `compiler.ts` and `compileToolDefinitionAST()` in `compile-behavior-profile.ts`. Also handled by `mergeAgentToolBehavior()` for project_tools merge.
- **`createIdentityTierGateMiddleware()`**: Runtime middleware in the compiler's tool middleware chain (`llm-wiring.ts`). Blocks tool execution when the session's current identity tier is below `identity_tier_required`. Returns an error response with `required_tier` and `current_tier`.

### Environment Variables (BETA additions)

| Variable                                  | Default    | Description                                                                  |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `IDENTITY_OAUTH_PROVIDER`                 | (not set)  | OAuth provider name (`google`, `microsoft`, `github`). Enables OAuth wiring. |
| `IDENTITY_OAUTH_<PROVIDER>_CLIENT_ID`     | (not set)  | OAuth client ID (e.g., `IDENTITY_OAUTH_GOOGLE_CLIENT_ID`)                    |
| `IDENTITY_OAUTH_<PROVIDER>_CLIENT_SECRET` | (not set)  | OAuth client secret (e.g., `IDENTITY_OAUTH_GOOGLE_CLIENT_SECRET`)            |
| `IDENTITY_OAUTH_<PROVIDER>_REDIRECT_URI`  | (not set)  | OAuth redirect URI (e.g., `IDENTITY_OAUTH_GOOGLE_REDIRECT_URI`)              |
| `IDENTITY_OAUTH_MICROSOFT_TENANT`         | `"common"` | Microsoft Entra ID tenant (only used for Microsoft provider)                 |

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | All `VerificationTokenStore` operations require canonical tenant scope. Redis keys are prefixed with `tenantId`. Cross-tenant attempt access returns null. Route middleware enforces `tenantContext.tenantId` presence. |
| Project isolation | Continuity-sensitive verification flows are project-scoped. Attempt state and resolution records must carry `projectId`, and cross-project access returns non-leaky `404`.                                              |
| User isolation    | Verification attempts are scoped by `sessionId` plus `sessionPrincipalId`. The `GET /:attemptId` endpoint must validate the caller's `tenantId`, `projectId`, and `sessionPrincipalId` before returning state.          |

### Security & Compliance

- OTP codes hashed with HMAC-SHA256 before storage (never stored in plaintext)
- Timing-safe comparison (`crypto.timingSafeEqual`) prevents timing side-channel attacks
- OAuth PKCE protects against authorization code interception attacks
- OAuth state parameter prevents CSRF attacks on redirect flows
- Identity artifacts hashed with SHA-256 before persistence (raw values never stored)
- Rate limiting: max 5 attempts per verification flow (enforced by `canAttempt()`)
- Expiry: TTL-based automatic cleanup via Redis TTL
- All route handlers check `tenantContext.tenantId` presence (401 if missing)

### Performance & Scalability

- Redis-backed token store for sub-millisecond read/write
- Stateless verification: no in-memory state; all attempts stored in Redis
- SHA-256 and HMAC-SHA256 are hardware-accelerated on modern CPUs
- `RedisVerificationTokenStore.incrementAttempts()` uses atomic Lua scripts for thread-safe JSON field updates

### Reliability & Failure Modes

- Redis unavailable -> verification initiate/complete returns 500 (caught by try/catch in route handlers)
- OAuth provider down -> `OAUTH_TOKEN_EXCHANGE_FAILED` error returned to caller
- Expired attempt -> `OTP_EXPIRED` / `OAUTH_EXPIRED` / `TOKEN_EXPIRED` / `WEBHOOK_EXPIRED` error
- Max attempts exceeded -> `OTP_MAX_ATTEMPTS` error
- Missing auth -> 401 response from route middleware
- No verifier found -> `NO_VERIFIER` error from `VerifyIdentity` use case
- Webhook send failure -> `WEBHOOK_SEND_FAILED` error

### Observability

- Route handlers use `createLogger('identity-verification')` for structured error logging with `tenantId`, `attemptId`, and `method` context
- OTP verifier uses `createLogger('otp-verifier')` for structured logging with `{ tenantId, attemptId, method }` context
- OAuth verifier uses `createLogger('oauth-verifier')` for structured logging with `{ tenantId, attemptId, method }` context
- Email link verifier uses `createLogger('email-link-verifier')` for structured logging with `{ tenantId, attemptId, method }` context
- OAuth adapters use `createLogger('oauth-adapters')` for userinfo fetch latency and error logging
- Webhook verifier uses `createLogger('webhook-verifier')` for challenge delivery logging
- Redis token store uses `createLogger('redis-verification-token-store')` for deserialization warnings
- PII audit log tracks identity access events
- Verification attempt status queryable via `GET /:attemptId`
- No dedicated metrics or trace events emitted (gap -- future work)

### Data Lifecycle

- Verification attempts expire based on TTL (OTP/OAuth: 10 min, email link: 1 hour, webhook: 5 min)
- Redis TTL ensures automatic cleanup; no manual garbage collection needed
- Session resolution keys expire after 24 hours by default
- No long-term persistence of verification attempts (ephemeral by design)

---

## 13. Delivery Plan / Work Breakdown

Feature is implemented at the code level. Remaining work is production wiring and hardening.

1. **Domain Layer** (DONE)
   1.1 `IdentityVerifier` port interface with `initiate()`, `complete()`, `supports()`
   1.2 `VerificationAttempt` value object with `createVerificationAttempt()`, `isExpired()`, `canAttempt()`
   1.3 Identity tier model with `canPromoteTo()`, `tierFromVerification()`, `VERIFICATION_TIER_MAP`
   1.4 Identity artifact with SHA-256 `hash()` and `create()` functions
   1.5 Session resolution key with `buildResolutionKeyId()`

2. **Verifier Adapters** (DONE)
   2.1 `HmacVerifier` -- single-step, wraps existing `verifyHMAC()`
   2.2 `OtpVerifier` -- two-step with otplib + HMAC-SHA256 hash + timing-safe compare
   2.3 `OAuthVerifier` -- two-step with PKCE + state via `OAuthProviderAdapter`
   2.4 `EmailLinkVerifier` -- two-step magic link with HMAC-hashed token
   2.5 `ProviderVerifier` -- single-step channel-provider assertion
   2.6 `WebhookVerifier` -- two-step challenge/response via external endpoint

3. **Infrastructure** (DONE)
   3.1 `VerificationTokenStore` port and `RedisVerificationTokenStore` implementation
   3.2 `RedisResolutionKeyStore` for session resolution

4. **Use Cases** (DONE)
   4.1 `VerifyIdentity` dispatcher (iterates verifiers by `supports()`)
   4.2 `PromoteTier` validation (domain logic only)
   4.3 `ResolveSession` by artifact hash
   4.4 `RegisterResolutionKey` for session continuity

5. **API Routes** (DONE, with gaps)
   5.1 Express router factory (`createIdentityVerificationRouter`)
   5.2 Auth middleware (tenantContext check)

6. **Production Wiring** (DONE)
   6.1 Real verifier registry (HMAC, OTP, provider, email_link, webhook) wired in `server.ts`
   6.2 `RedisVerificationTokenStore` backed by production Redis client
   6.3 HMAC secret from `IDENTITY_HMAC_SECRET` or `ENCRYPTION_MASTER_KEY`
   6.4 `EmailLinkVerifier.method` fixed to `'email_link'`; `WebhookVerifier.method` fixed to `'webhook'`
   6.5 OAuth wired via Arctic v3 adapters (Google, Microsoft, GitHub) when `IDENTITY_OAUTH_PROVIDER` env var is set (BETA)

7. **Hardening** (DONE)
   7.1 `createLogger('identity-verification')` in routes, `createLogger('webhook-verifier')`, `createLogger('redis-verification-token-store')`
   7.2 Typed `req.tenantContext` (no `(req as any)` casts)
   7.3 Dynamic `channelType` from metadata → channelId → fallback `'web_chat'`
   7.4 `email_link` and `webhook` added to `VerificationMethod` in shared-auth and shared-kernel
   7.5 Atomic Lua scripts for `incrementAttempts()` and `markVerified()`
   7.6 SSRF protection on webhook URLs (private IPs, localhost, metadata endpoints blocked)
   7.7 10s timeout on webhook fetch calls
   7.8 Try/catch on Redis deserialization and OAuth codeHash parsing
   7.9 Zod validation on all route request bodies

8. **E2E Tests** (DONE)
   8.1 7 E2E scenarios with 13 test cases in `identity-e2e-http.test.ts`
   8.2 HMAC, OTP complete flow, rate limiting + TTL expiry, cross-tenant isolation, OAuth, input validation, webhook
   8.3 Real Express servers on random ports, real verifier implementations, InMemoryRedis
   8.4 E2E-8 (DSL tier gate E2E) deferred to STABLE — covered by 19 compiler unit tests + 10 middleware unit tests

---

## 14. Success Metrics

| Metric                         | Baseline | Target                        | How Measured                                  |
| ------------------------------ | -------- | ----------------------------- | --------------------------------------------- |
| Verification methods supported | 0        | 6 (all adapters functional)   | Verifier adapter count in production wiring   |
| Identity tier accuracy         | N/A      | 100% correct tier assignment  | Unit test coverage of `VERIFICATION_TIER_MAP` |
| OTP brute-force resistance     | N/A      | Max 5 attempts, 10-min expiry | Rate limit enforcement tests                  |
| OAuth flow security            | N/A      | PKCE + state in every flow    | OAuth verifier test coverage                  |
| E2E test coverage              | 0        | 5+ E2E scenarios passing      | E2E test suite results                        |
| Production wiring completeness | 0%       | 100% (no stub deps)           | `server.ts` wiring audit                      |

---

## 15. Decisions Closed For This Feature

1. ~~Should verification policies be configurable per-project or per-agent via DSL?~~ **RESOLVED (BETA)**: Agent tool definitions declare `identityTierRequired: 0 | 1 | 2` in the DSL. The compiler maps this to `identity_tier_required` in the IR. The `identityTierGateMiddleware` enforces the gate at tool execution time.
2. **Audit durability**: Verification lifecycle events must emit durable PII audit rows plus traces and counters. Long-term analytics rollups may remain future work, but audit persistence is not optional.
3. ~~How should OTP codes be delivered to end users?~~ **RESOLVED (BETA)**: A `VerificationDeliveryService` port delegates to `EmailDeliveryAdapter` (injected via DI). Raw codes/tokens are stripped from HTTP responses when delivery is configured. SMS delivery deferred (GAP-017).
4. ~~Should `email_link` and `webhook` be added to the `VerificationMethod` union type?~~ **RESOLVED**: Both added to `@agent-platform/shared-auth` and `@agent-platform/shared-kernel`.
5. ~~Should rate limiting use atomic Redis INCR?~~ **RESOLVED**: Uses Lua scripts for atomic JSON field updates.
6. **Status-read isolation**: `GET /:attemptId` must verify the requesting production scope matches the stored `tenantId`, `projectId`, and `sessionPrincipalId`, unless the caller uses an explicit privileged internal-service contract.
7. **Resolution contract**: Session resolution returns a project-safe `SessionResolutionRecord` envelope rather than a bare `sessionId`.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                | Severity | Status    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Route handlers use `console.error` instead of `createLogger('identity-verification')`                                                                                                                                      | Low      | Mitigated |
| GAP-002 | Route handlers use `(req as any).tenantContext` type assertion instead of typed middleware                                                                                                                                 | Low      | Mitigated |
| GAP-003 | No E2E tests that exercise full verification flow through HTTP API with real Redis                                                                                                                                         | High     | Mitigated |
| GAP-004 | `EmailLinkVerifier.method` is `'otp'` instead of `'email_link'`; collision if both registered                                                                                                                              | Medium   | Mitigated |
| GAP-005 | `channelType` hardcoded to `'web_chat'` in initiate route instead of derived from request/session                                                                                                                          | Medium   | Mitigated |
| GAP-006 | No integration with agent DSL for verification policy declaration                                                                                                                                                          | Medium   | Mitigated |
| GAP-007 | OTP code returned in `challengeData.code`; delivery mechanism not integrated                                                                                                                                               | Medium   | Mitigated |
| GAP-008 | `WebhookVerifier.method` is `'provider'` instead of `'webhook'`; `VerificationMethod` type missing `webhook` and `email_link`                                                                                              | Medium   | Mitigated |
| GAP-009 | `RedisVerificationTokenStore.incrementAttempts()` uses non-atomic GET+SET; race condition under concurrency                                                                                                                | Medium   | Mitigated |
| GAP-010 | `server.ts` wires identity routes with **stub dependencies** (empty verifier map, no-op token store)                                                                                                                       | High     | Mitigated |
| GAP-011 | No Zod validation on request bodies in route handlers; relies on manual field checks                                                                                                                                       | Medium   | Mitigated |
| GAP-012 | `complete()` route does not verify tenantId matches the stored attempt's tenantId (delegates to verifier)                                                                                                                  | Medium   | Mitigated |
| GAP-013 | `EmailLinkVerifier.complete()` uses non-timing-safe string comparison (`!==`) for hash comparison                                                                                                                          | High     | Mitigated |
| GAP-014 | `WebhookVerifier.complete()` uses non-timing-safe string comparison (`!==`) for hash comparison                                                                                                                            | High     | Mitigated |
| GAP-015 | OAuth verifier not wired in production (no `OAuthProviderAdapter` configured)                                                                                                                                              | Medium   | Mitigated |
| GAP-016 | No `createLogger` in OTP, OAuth, or email-link verifiers (webhook and routes have logging)                                                                                                                                 | Low      | Mitigated |
| GAP-017 | SMS delivery adapter not implemented (Twilio/generic SMS bridge deferred)                                                                                                                                                  | Low      | Open      |
| GAP-018 | Verification attempts and resolution keys are still tenant-centric in parts of the implementation; the target contract requires `projectId` + `sessionPrincipalId` provenance on both attempt state and resolution records | High     | Open      |
| GAP-019 | `GET /:attemptId` status reads are not yet fully constrained to the same `projectId` + `sessionPrincipalId` as the requesting production scope                                                                             | High     | Open      |
| GAP-020 | Verification lifecycle events do not yet emit durable audit rows and `TraceEvent`s with `verificationAttemptId`, `policySource`, `grantScope`, and `traceId` across all paths                                              | High     | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                        | Coverage Type | Status     | Test File / Note                                   |
| --- | ----------------------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------- |
| 1   | HMAC verifier (signature validation, missing metadata)                                          | unit          | PASS       | `hmac-verifier.test.ts`                            |
| 2   | OTP verifier (code generation, hash, rate limit, expiry)                                        | unit          | PASS       | `otp-verifier.test.ts`                             |
| 3   | OAuth verifier (PKCE + state, token exchange, expiry)                                           | unit          | PASS       | `oauth-verifier.test.ts`                           |
| 4   | Email link verifier (token hash, expiry, already-verified)                                      | unit          | PASS       | `email-link-verifier.test.ts`                      |
| 5   | Provider verifier (channel assertion, supports routing)                                         | unit          | PASS       | `provider-verifier.test.ts`                        |
| 6   | Identity domain (artifact hash, tier, attempt lifecycle)                                        | unit          | PASS       | `identity-domain.test.ts`                          |
| 7   | Promote tier use case (valid promotions, rejections)                                            | unit          | PASS       | `promote-tier.test.ts`                             |
| 8   | VerifyIdentity dispatcher (method routing, no-verifier)                                         | unit          | PASS       | `verify-identity.test.ts`                          |
| 9   | Redis token store (CRUD, TTL, tenant isolation)                                                 | unit          | PASS       | `redis-verification-token-store.test.ts`           |
| 10  | Redis resolution key store (key format, TTL)                                                    | unit          | PASS       | `resolution-key-store.test.ts`                     |
| 11  | Resolve session use case (key lookup, not-found)                                                | unit          | PASS       | `resolve-session.test.ts`                          |
| 12  | Express routes (initiate, complete, get, 401, 400)                                              | integration   | PASS       | `verification-routes.test.ts`                      |
| 13  | Full HMAC identity -> contact -> session resolution                                             | integration   | PASS       | `identity.e2e.test.ts`                             |
| 14  | HMAC E2E (valid/invalid/no-auth)                                                                | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-1                  |
| 15  | OTP complete flow E2E (initiate → status → complete → verified)                                 | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-2                  |
| 16  | OTP rate limiting + TTL expiry E2E                                                              | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-3                  |
| 17  | Cross-tenant isolation E2E                                                                      | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-4                  |
| 18  | OAuth PKCE + state E2E (mock provider)                                                          | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-5                  |
| 19  | Input validation E2E                                                                            | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-6                  |
| 20  | Webhook complete flow E2E (real HTTP test server)                                               | e2e           | PASS       | `identity-e2e-http.test.ts` E2E-7                  |
| 21  | OAuth adapters (Google/Microsoft/GitHub DI, userinfo, errors)                                   | unit          | PASS       | `oauth-adapters.test.ts` (16 tests)                |
| 22  | Email delivery adapter (templates, errors, XSS escaping)                                        | unit          | PASS       | `email-delivery-adapter.test.ts` (8 tests)         |
| 23  | Delivery integration (code delivery + response stripping)                                       | integration   | PASS       | `delivery-integration.test.ts` (5 tests)           |
| 24  | Compiler identity tier (compileTools, profile, merge)                                           | unit          | PASS       | `compiler-identity-tier.test.ts` (9 tests)         |
| 25  | Identity tier gate middleware (block/pass/absent/error)                                         | unit          | PASS       | `identity-tier-gate-middleware.test.ts` (10 tests) |
| 26  | Session resolution records remain project-scoped and return provenance, not a bare session ID   | integration   | NOT TESTED | Planned resolution-key and continuity coverage     |
| 27  | `GET /:attemptId` rejects wrong-project or wrong-session-principal callers with non-leaky `404` | e2e           | NOT TESTED | Planned verification status isolation coverage     |
| 28  | Verification initiate/complete/status emit durable audit + trace provenance fields              | integration   | NOT TESTED | Planned audit/trace instrumentation coverage       |

### Testing Notes

All six verifier adapters have dedicated unit tests. Domain logic is thoroughly tested. Route-level tests validate Express endpoints with mocked use cases. Infrastructure stores have tests with mocked Redis. 7 E2E scenarios (13 test cases) exercise the full HTTP API with real Express servers, real verifier implementations, and an InMemoryRedis implementation. Cross-tenant isolation, rate limiting with TTL expiry, SSRF protection, and webhook flows are all covered. The OAuth E2E uses a mock `OAuthProviderAdapter` (acceptable — external third-party service).

**BETA additions:** OAuth adapters use DI constructor overloads (`ArcticLikeProvider` interface) for testing without `vi.mock()`. Email delivery adapter tested with injected `EmailSender`. Delivery integration tests exercise real route handler → delivery service → response stripping pipeline. Compiler tests cover all three compilation paths (`compileTools`, `compileToolDefinitionAST`, `mergeAgentToolBehavior`). Identity tier gate middleware tests exercise block/pass/absent/error scenarios. E2E-8 (DSL tier gate E2E) deferred — requires ToolBindingExecutor test infrastructure not yet available; unit + integration tests provide coverage for BETA. Total: 244 tests (225 runtime + 19 compiler).

> Full testing details: [../testing/identity-verification.md](../testing/identity-verification.md)

---

## 18. References

- Identity context barrel: `apps/runtime/src/contexts/identity/index.ts`
- Server wiring: `apps/runtime/src/server.ts` (lines 1356-1455)
- Artifact hasher: `apps/runtime/src/services/identity/artifact-hasher.ts`
- Shared auth types: `packages/shared-auth/src/types/index.ts` (`VerificationMethod`, `ChannelArtifactType`, `IdentityTier`)
- Auth context types: `packages/shared-auth/src/types/auth-context.ts` (`CallerIdentity`)
- Orchestration promote-and-link: `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`
- Related feature: Omnichannel Session Continuity
- Related feature: Contact Management
