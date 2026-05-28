# Web SDK JWT & JWE Authentication Plan

**Status:** Historical / partially superseded | **Date:** 2026-03-14

> Status note (2026-03-19): The live browser SDK transport work is now implemented differently than this draft assumed. `packages/web-sdk/` exists, `/api/v1/sdk/init` is live, and `/ws/sdk` now requires `Sec-WebSocket-Protocol: sdk-auth,<token>` with the old query-token fallback removed. Use `docs/security/abl-platform-threat-model.md`, `docs/features/sdk.md`, and `docs/plans/2026-03-19-cross-channel-auth-threat-model-consolidation-plan.md` as the current source of truth. Keep this file only as historical design context for the customer-JWT/JWE extension ideas.

---

## 1. Problem Statement

The Web SDK's current authentication has critical gaps:

| Gap                           | Severity | Impact                                                         |
| ----------------------------- | -------- | -------------------------------------------------------------- |
| `pk_*` key in client HTML     | High     | Long-lived credential; theft enables session creation          |
| No verified end-user identity | High     | `userContext.userId` is self-declared (identityTier=1)         |
| Session token in WS URL       | Medium   | Logged by proxies, CDNs, nginx access logs                     |
| All JWT claims readable       | High     | base64 payload readable; PII passed as user context is exposed |

The `packages/web-sdk/` package does not exist yet. Phase 1 creates it with the correct token-based auth flow. The existing `sdk-handler.ts` reads `url.searchParams.get('token')` (a session token from `/api/v1/sdk/init`), which is working as designed.

**Solution:** Customer-signed JWTs (RS256/ES256) presented at `/api/v1/sdk/init`, with optional JWE-encrypted private claims for PII. Runtime validates the customer JWT and issues the same internal HS256 session token as before — downstream WebSocket handling is unchanged.

---

## 2. Architecture

### 2.1 Auth Flow

```
Customer Backend                Runtime                           Web SDK
      |                           |                                  |
      |  Sign JWT (RS256/ES256)   |                                  |
      |  with customer private key|                                  |
      |                           |                                  |
      |  ---- Customer JWT -----> |                                  |
      |  POST /api/v1/sdk/init       |                                  |
      |  X-Customer-JWT: eyJ...   |                                  |
      |                           |                                  |
      |                      1. Decode header (kid, alg)             |
      |                      2. Decode payload (tenantId, projectId) |
      |                      3. Lookup SDKSigningKey in DB           |
      |                      4. Reject HS256                         |
      |                      5. Resolve public key (PEM or JWKS)     |
      |                      6. jose.jwtVerify() — iss, aud, alg, clockTolerance: 30s |
      |                      7. Enforce exp-iat <= maxTokenAgeSec    |
      |                      8. Check jti replay (Redis SET NX PX)   |
      |                      9. Decrypt privateClaims JWE (optional) |
      |                     10. Issue internal HS256 session token    |
      |                           |                                  |
      |  <-- { token, ... } ----- |                                  |
      |                           |                                  |
      |  --- session token -----> |  ---- WS: Sec-WebSocket-Protocol |
      |                           |       ['sdk-auth', token] -----> |
      |                           |                                  |
      |                      handleTokenAuth() — unchanged           |
```

### 2.2 SDKAuthConfig (Discriminated Union)

```typescript
export type SDKAuthConfig = ApiKeyAuth | TokenEndpointAuth | PreFetchedTokenAuth;

interface ApiKeyAuth {
  type: 'api_key';
  apiKey: string;
}
interface TokenEndpointAuth {
  type: 'token_endpoint';
  tokenEndpoint: string;
  tokenEndpointHeaders?: Record<string, string>;
  refreshThresholdSec?: number; // Default: 300
}
interface PreFetchedTokenAuth {
  type: 'token';
  getToken: () => Promise<string>;
}
```

### 2.3 customerJwtMiddleware Flow

The `sdkInitOrJwtMiddleware()` dispatcher checks headers:

- `X-Customer-JWT` present -> `customerJwtMiddleware()`
- `X-Public-Key` present -> existing `sdkInitMiddleware()`
- Neither -> uniform 401

Both paths produce an identical `req.sdkInit` shape. The route handler and WS handler are unchanged.

> **Requirement (A5):** Extend `SDKInitData` in `packages/shared-kernel/src/types/index.ts` with: `authMethod?: 'jwt' | 'jwe' | 'pk'`, `jwtSubject?: string`, `jtiClaim?: string`, `privateClaims?: Record<string, unknown>`. The `sdk-init.ts` route handler must populate these fields for both the JWT and pk\_\* paths.

**`SDKSessionTokenPayload` must be extended** in `packages/shared-auth/src/types/index.ts` with the following fields:

```typescript
authMethod: 'jwt' | 'jwe' | 'pk';
verifiedSub?: string; // Copied from customer JWT `sub` claim when authMethod === 'jwt'
signingKeyId?: string; // The `kid` used to verify the customer JWT (for revocation checks on refresh)
```

> **Requirement (S1 — BLOCKER):** When `authMethod === 'jwt'`, copy `sub` from the customer JWT into `verifiedSub`. In `handleTokenAuth()` (sdk-handler.ts), prefer `verifiedSub` over `userContext.userId` for identity. Set `identityTier = 2` only when `verifiedSub` is present. In `handleTokenAuth()`, when building `callerContext` (~line 418-426), use `payload.verifiedSub ?? payload.userContext?.userId` for `customerId` when `identityTier === 2`. Also set `identityTier = 2` when `verifiedSub` is present, regardless of HMAC verification.

This field records which authentication method was used to create the session token. `'jwt'` for customer-signed JWTs, `'jwe'` for JWTs with encrypted private claims, and `'pk'` for the existing `pk_*` public key flow. The middleware sets this field when constructing the session token payload.

> **Requirement (A12 — Implementation):** (1) In `sdkInitMiddleware()` (sdk-auth.ts), set `req.sdkInit.authMethod = 'pk'`. (2) In the route handler (sdk-init.ts ~line 247), copy `authMethod` from `req.sdkInit.authMethod` into `tokenPayload.authMethod`. (3) In `customerJwtMiddleware()`, set `req.sdkInit.authMethod = 'jwt'` (or `'jwe'`). The route handler copies it the same way for both paths.

---

## 3. Key Design Decisions

### RS256/ES256 signing (no HS256)

| Algorithm    | Key Type          | Notes                                      |
| ------------ | ----------------- | ------------------------------------------ |
| RS256        | RSA-2048+         | Recommended — widely supported             |
| RS384, RS512 | RSA-2048+         | Higher security margin                     |
| ES256        | ECDSA P-256       | Smaller tokens                             |
| ES384, ES512 | ECDSA P-384/P-521 | Higher security margin                     |
| HS256        | Symmetric         | **Rejected** — requires sharing the secret |

### jose library

`jose` is the only standards-compliant RS256/ES256/JWE library for Node.js. `jsonwebtoken` has no JWE support. `jose` is added to `apps/runtime/` only — the Web SDK does not need it.

> **Note (A11):** The runtime will have two JWT libraries: `jsonwebtoken` (existing, for session tokens) and `jose` (new, for customer JWT verification). Track a follow-up task to migrate session token signing/verification from `jsonwebtoken` to `jose` for consistency.

### SDKSigningKey model with EncryptionService

```typescript
interface SDKSigningKeyDoc {
  id: string;
  tenantId: string;
  projectId: string;
  keyAlias: string;
  algorithm: 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';
  expectedIssuer: string;
  publicKeyPem?: string; // Encrypted at rest
  jwksUrl?: string; // Encrypted at rest
  jwksKid?: string;
  jwePrivateKeyPem?: string; // Encrypted at rest
  jwePublicKeyPem?: string; // Given to customer
  isActive: boolean;
  expiresAt?: Date;
  maxTokenAgeSec: number; // Default and max: 900
  dekVersion?: number; // Tracks key encryption key version for master key rotation (S6)
  createdAt: Date;
  updatedAt: Date;
}
```

All sensitive fields encrypted via the existing Mongoose schema-level encryption plugin (same pattern as `LLMCredential` model in `packages/database/src/mongo/plugins/encryption.plugin.ts`) rather than manual `encryptForTenant()` calls. Compound index on `(tenantId, projectId, isActive)`.

### Sec-WebSocket-Protocol for token transport

Moves the session token out of the URL (where it's logged by proxies) into a protocol negotiation header:

```typescript
// NEW: not logged by most proxies
this.ws = new WebSocket(wsUrl, ['sdk-auth', token]);
// Runtime reads: req.headers['sec-websocket-protocol']
```

> **Requirement (Ops):** Runtime must be deployed first with dual-transport support (both `Sec-WebSocket-Protocol` header and `?token=` URL param). Then SDK is updated. Failure to sequence correctly breaks all SDK sessions.

> **Requirement (A10):** Pass `handleProtocols: (protocols) => protocols.has('sdk-auth') ? 'sdk-auth' : false` to the `wssSDK = new WebSocketServer(...)` constructor at server.ts line 910. This works with `noServer: true` in ws@8.x — the callback is invoked during `handleUpgrade`. Without this, the WebSocket handshake fails for clients using `Sec-WebSocket-Protocol`.

### JWKS caching in Redis

Pattern from `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`. Cache key: `sdk:jwks:{tenantId}:{projectId}:{kid}`, TTL: 1 hour.

> **Note (A3):** The IDP validator uses `jwks-rsa` + `jsonwebtoken`, not `jose`. With `jose`, use `jose.importJWK()` for cached JWK entries from Redis, not PEM strings. Cache raw JWK JSON objects in Redis, import them to `KeyLike` on read.

> **Requirement (Security):** JWKS URL must be HTTPS-only. Apply `assertUrlSafeForSSRF()` (import from `@agent-platform/shared-kernel/security`) at registration time. Validate in Studio admin UI.

> **Requirement (Arch):** Apply a 5-second timeout to JWKS fetches. Return structured 503 if unreachable, rather than blocking `/api/v1/sdk/init` indefinitely.

---

## 4. Implementation

### Phase 0: Bootstrap `packages/web-sdk/` Package (P0 — BLOCKER)

`packages/web-sdk/` does not exist yet. This phase MUST be completed before any other phase.

- [ ] **P0-1** `mkdir -p packages/web-sdk/src` and run `pnpm init` in `packages/web-sdk/`
- [ ] **P0-2** Set `package.json` name to `@agent-platform/web-sdk`, add build scripts, set `main`/`types` entry points
- [ ] **P0-3** Configure `tsconfig.json` with browser-appropriate settings: `target: ES2022`, `lib: [DOM, ES2022]`, `moduleResolution: bundler`. Add esbuild/rollup build config for producing a browser-ready ESM bundle. (Note: no need to add to `pnpm-workspace.yaml` — the `packages/*` glob already matches.)
- [ ] **P0-5** Add `COPY packages/web-sdk/package.json packages/web-sdk/package.json` to **every** Dockerfile under `apps/` (`apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`) — per CLAUDE.md Dockerfile package.json sync rule. Without this, `pnpm install --frozen-lockfile` cannot resolve the dependency graph.
- [ ] **P0-6** Run `pnpm install` from root to update lockfile
- [ ] **P0-7** Verify `pnpm build --filter=@agent-platform/web-sdk` succeeds with empty output

### Phase 1: Fix SDK Bug + API Key Flow Normalization

- [ ] **P1-1** Create `TokenManager` (`packages/web-sdk/src/core/TokenManager.ts`) — fetch, cache in memory, proactive refresh, backoff on failure. Validate `tokenEndpoint` starts with `https://` (reject `http://` except `localhost` in development). If `TokenManager` is ever used server-side (Next.js SSR), `assertUrlSafeForSSRF()` must be applied.
- [ ] **P1-2** Extend `SDKConfig` types — `SDKAuthConfig` union, `SDKEvents.authExpired`, `TokenManagerEvents`
- [ ] **P1-3** Update `SessionManager` — accept `TokenManager`, use `Sec-WebSocket-Protocol` header, handle `tokenRefreshed`/`tokenExpired`
- [ ] **P1-4** Update `AgentSDK` — instantiate `TokenManager`, inject into `SessionManager`, add `normalizeConfig()` for legacy `apiKey` compat
- [ ] **P1-5** Update `AgentProvider` — add `onAuthExpired?: () => void` prop
- [ ] **P1-6** Update WS handler token extraction (`sdk-handler.ts`) — read from header first, URL query param as fallback. In `handleSDKConnection()` at `apps/runtime/src/websocket/sdk-handler.ts`, add `Sec-WebSocket-Protocol` header parsing BETWEEN the URL param extraction (line 310) and the null guard (line 316). Extract second protocol value from `req.headers['sec-websocket-protocol']` as fallback when `url.searchParams.get('token')` returns null.
- [ ] **P1-7** Tests: `packages/web-sdk/src/__tests__/token-manager.test.ts` — all auth variants, refresh, expiry, backwards compat
- [ ] **P1-8** Build: `pnpm build --filter=@agent-platform/web-sdk`

> **Requirement (Security — H7):** `TokenManager` must use ES2022 `#token` private class field, not TypeScript `private`. TypeScript `private` is erased at runtime — `#token` is enforced by the JS engine and inaccessible even through `window.__agentSDK`. If the build target does not support `#`, use a `WeakMap<TokenManager, string>` closure pattern.

**TokenManager key interface:**

```typescript
// TypedEventEmitter does not exist in the codebase. Use Node.js built-in EventEmitter
// with a typed wrapper, or use the browser-compatible `EventTarget` API.
// Recommended: implement a minimal typed wrapper in packages/web-sdk/src/core/typed-event-emitter.ts
// using EventTarget (browser-compatible) or the 'eventemitter3' npm package (~1 KB).
export class TokenManager extends TypedEventEmitter<TokenManagerEvents> {
  #token: string | null = null; // ES2022 private field — never persisted
  #tokenExp: number | null = null;

  async getToken(): Promise<string>; // Returns cached or fetches
  async refresh(): Promise<void>; // Force refresh before reconnect
  destroy(): void; // Clear timers
}
```

Token stored only in `#token`. No `localStorage`, `sessionStorage`, or cookies. Lost on page reload — correct behavior.

### Phase 2: Customer JWT Verification in Runtime

- [ ] **P2-1** Verify `jose` is available in `apps/runtime/package.json` (already a dependency at `^5.10.0` — no install needed)
- [ ] **P2-2** Create `SDKSigningKey` Mongoose model (`packages/database/src/models/SDKSigningKey.ts`) — register in index
- [ ] **P2-3** Extend the existing Express Request augmentation at `packages/shared/src/types/index.ts` (or `packages/shared-kernel/src/types/index.ts` where `SDKInitData` is defined at line 101). Do NOT create a new `.d.ts` file. Extend `SDKInitData` with JWT-specific fields: `authMethod`, `jwtSubject`, `jtiClaim`, `privateClaims`.
- [ ] **P2-4** Create repository (`apps/runtime/src/repos/sdk-signing-key-repo.ts`) — tenant-scoped CRUD
- [ ] **P2-5** Create JWT verifier (`apps/runtime/src/services/customer-jwt/verifier.ts`) — `verifyCustomerJwt()`, `decryptPrivateClaims()`, `generateJweKeyPair()`. Pass `clockTolerance: 30` (seconds) to `jose.jwtVerify()` options. Reject tokens where `iat > now + 30s`. Add `nbf` as an optional claim in the schema; validate if present.
- [ ] **P2-6** Create JWKS cache (`apps/runtime/src/services/customer-jwt/jwks-cache.ts`) — Redis-backed, 1h TTL. After fetching from JWKS, validate that the key's `kty` and `alg` match the expected algorithm in `SDKSigningKeyDoc`. For RS256, `kty` must be `RSA`; for ES256, `kty` must be `EC` with `crv: P-256`. Reject mismatches.
- [ ] **P2-7** Create customer JWT middleware (`apps/runtime/src/middleware/sdk-customer-jwt.ts`)
- [ ] **P2-8** Add `sdkInitOrJwtMiddleware()` to `sdk-auth.ts`
- [ ] **P2-8a** Refactor `sdkInitMiddleware()` to return the same uniform `{ success: false, error: { code: 'invalid_token', message: 'Authentication failed' } }` for all failure modes. The 403 for origin check should become 401 with the same body. Both `sdk-customer-jwt.ts` and `sdk-auth.ts` middleware must share the same error response shape.
- [ ] **P2-9** Update `/api/v1/sdk/init` route — switch middleware, propagate JWT identity. **On token refresh (re-init):** when `payload.authMethod === 'jwt'`, look up `SDKSigningKey` by `kid` (stored as `signingKeyId` in session token) and verify `isActive: true && !expired`. If revoked, reject with 401. Add `signingKeyId` to `SDKSessionTokenPayload` for JWT-issued tokens. Add an `isKeyRevoked(kid, tenantId, projectId)` check in the verification flow that returns `true` if the key is inactive or expired. **When `authMethod === 'jwt'`, body fields `deploymentSlug` and `channelName` are optional — prefer values from JWT claims (`CustomerJWTClaims.deploymentSlug`, `CustomerJWTClaims.channelName`) over body values. If both present, JWT claims take precedence (signed vs unsigned). Document this precedence.**
- [ ] **P2-9b** Update the refresh handler's `newPayload` construction (sdk-init.ts ~line 369) to include `authMethod: payload.authMethod`, `verifiedSub: payload.verifiedSub`, and `signingKeyId: payload.signingKeyId`. Without this, refreshed tokens lose JWT identity fields and signing key revocation checks break.
- [ ] **P2-10a** Import `requireProjectPermission` from `../middleware/rbac.js`. Add `sdk_signing_key:manage` to the permission resolution logic in `apps/runtime/src/middleware/rbac.ts`. Assign to project admin roles and use `requireProjectPermission(req, res, 'sdk_signing_key:manage')` in admin routes.
- [ ] **P2-10** Create admin routes (`/api/projects/:projectId/sdk-signing-keys`) — CRUD + generate-jwe-keypair + invalidate-jwks-cache. Require: (1) `requireAuth` middleware on the router, (2) `requireProjectPermission(req, res, 'sdk_signing_key:manage')` on mutating endpoints, (3) `tenantId` + `projectId` scoping on all queries per core invariant #1. Rate limit signing key CRUD: 10 creates/hour per project, 5 JWKS cache invalidations/minute per project. Maximum 5 signing keys per project (active + inactive).
- [ ] **P2-11** Mount route in `server.ts`
- [ ] **P2-12** Tests: middleware unit tests (uniform 401 verification), cross-tenant authz tests, E2E init-with-RS256-JWT test
- [ ] **P2-13** Update Dockerfiles if workspace packages added
- [ ] **P2-14** Build: `pnpm build --filter=@agent-platform/runtime`

> **Requirement (Ops):** Gate behind `SDK_CUSTOMER_JWT_ENABLED=false` feature flag. Enable only after staging validation. Rollback: set flag to `false`, no redeploy needed.

**Customer JWT Claims Schema:**

```typescript
interface CustomerJWTClaims {
  iss: string; // Must match expectedIssuer on signing key
  aud: string; // Must be "abl-sdk"
  sub: string; // End-user identifier (cryptographically bound)
  iat: number;
  exp: number; // exp - iat must be <= 900 seconds
  jti: string; // MANDATORY — replay protection via Redis SET NX PX
  projectId: string; // Must match signing key's project
  tenantId: string; // Must match signing key's tenant
  email?: string;
  roles?: string[];
  channelName?: string;
  deploymentSlug?: string;
  privateClaims?: string; // JWE compact serialization (optional)
}
```

> **Requirement (Security — H3):** `jti` replay protection is mandatory from Phase 2, not optional Phase 3. Store seen `jti` values in Redis with `SET NX PX 900000`. Reject if `SET NX` fails. Cost: one Redis `SET NX` per init call — negligible. **The jti Redis key must be scoped as `sdk:jti:{tenantId}:{projectId}:{jti}`** (not `sdk:jti:{jti}`) to prevent cross-tenant jti collisions and make key rotation safe.

**Uniform Error Response (Tenant Enumeration Prevention):**

All failure paths return an identical 401:

```typescript
const JWT_AUTH_FAILURE_RESPONSE = {
  success: false,
  error: { code: 'invalid_token', message: 'Invalid customer JWT' },
} as const;
```

Every failure — invalid format, missing claims, no signing key, bad signature, expired, wrong audience, wrong issuer, HS256 rejected, JWE decrypt failure — produces this same response. Specific reasons logged server-side only via `log.warn('Customer JWT auth failed', { reason, tenantId, projectId })`.

> **Requirement (Security — C2 RESOLVED):** The architecture audit identified differential error responses as a critical finding. The uniform `JWT_AUTH_FAILURE_RESPONSE` constant was added to the plan, resolving this. Tests must verify byte-identical response bodies across all failure modes.

> **Requirement (Security — H8-ext):** The uniform 401 error handling must also be extended to the **existing `pk_*` (public key) authentication path**. The current `sdkInitMiddleware()` should be updated to return the same structured `{ success: false, error: { code: 'invalid_token', message: '...' } }` shape for all failure modes (invalid key, expired key, wrong tenant, missing key). This prevents attackers from distinguishing between JWT and pk\_\* auth methods based on error response format. Update both `sdk-customer-jwt.ts` and `sdk-auth.ts` middleware to share the same error response shape.

> **Requirement (Security — H4):** Signing key addition/activation/deactivation must emit an audit log entry. Alert on new signing key addition in production projects. The `sdk_signing_key:manage` permission boundary must be restricted to project admins.

### Phase 3: JWE Encrypted Private Claims

- [ ] **P3-1** Wire JWE key pair generation through Studio admin route
- [ ] **P3-2** Implement JWE key rotation with configurable retention period and `forceRotate` flag
- [ ] **P3-3** Document JWE payload format and encryption code samples (Node.js, Python, Java)

**JWE Scheme:**

| Parameter          | Value                                           |
| ------------------ | ----------------------------------------------- |
| Key management     | `RSA-OAEP-256`                                  |
| Content encryption | `A256GCM`                                       |
| Key pair owner     | Runtime-generated; customer receives public key |
| Max decrypted size | 4 KB                                            |

Runtime generates a per-project RSA-2048 key pair. Customer encrypts `privateClaims` with the public key before signing the outer JWT. Decrypted claims merge into `userContext.customAttributes`. Audit logs record only `hasPrivateClaims: true`.

> **Requirement (Security):** JWE size check must be pre-decryption, not post. Reject `privateClaims` JWE compact serializations exceeding 2,048 bytes before attempting RSA-OAEP decryption. A 4 KB plaintext produces ~600 bytes ciphertext. This prevents DoS via large-payload decryption.

> **Requirement (Security — H8):** JWE key rotation must support `forceRotate: true` flag that immediately deletes the old private key (no retention period). Default 24h retention is acceptable for normal rotation but too long after a compromise. Make retention period configurable down to zero.

> **Requirement (Security — S6):** `EncryptionService.encryptForTenant()` uses HKDF to derive per-tenant keys. Add a master key rotation procedure: re-encrypt all `jwePrivateKeyPem` values when the master key changes. Add `dekVersion` field to `SDKSigningKeyDoc` to track key encryption key version. Future: recommend HSM-backed storage.

### Phase 4: Observability, Audit Logging, Hardening

- [ ] **P4-1** Audit log entries for customer JWT events (issuer, tenantId — no PII)
- [ ] **P4-2** `sdk_auth_method` label (`api_key` vs `customer_jwt`) on `session.init` metric
- [ ] **P4-3** Alert: customer JWT verify failure rate > 10% for a project
- [ ] **P4-4** Key expiry warning notifications (7-day lead time)

---

## 5. Security Requirements

All security audit findings consolidated as requirements:

| ID  | Status                   | Requirement                                                                                                                                                                                            |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C2  | **RESOLVED**             | Uniform 401 for all JWT failure paths. `JWT_AUTH_FAILURE_RESPONSE` constant added to plan. Tests must verify byte-identical responses across all 9+ failure modes.                                     |
| H3  | **Mandatory Phase 2**    | `jti` replay protection via Redis `SET NX PX`. Stolen 15-minute tokens must not allow unlimited session creation.                                                                                      |
| H4  | **Mandatory Phase 2**    | Signing key CRUD must emit audit log entries. Alert on new key addition in production projects.                                                                                                        |
| H5  | Cross-ref                | Debug Runtime node affinity — same node pool as production Runtime (see separate-runtime-deployments plan).                                                                                            |
| H7  | **Mandatory Phase 1**    | Use ES2022 `#token` private field in `TokenManager`, not TypeScript `private`. Prevents XSS token exfiltration via `window.__agentSDK`.                                                                |
| H8  | **Mandatory Phase 3**    | JWE key rotation `forceRotate` flag for compromise scenarios. Configurable retention down to zero.                                                                                                     |
| —   | **Mandatory Phase 2**    | JWKS URL must be HTTPS-only + SSRF-checked via `assertUrlSafeForSSRF()` (from `@agent-platform/shared-kernel/security`) at registration time.                                                          |
| —   | **Mandatory Phase 3**    | JWE size check must be pre-decryption (reject >2,048 byte compact serialization).                                                                                                                      |
| —   | **Phase 2**              | Algorithm binding from DB (`SDKSigningKeyDoc.algorithm`), not JWT `alg` header. `jose.jwtVerify()` with `algorithms: [signingKey.algorithm]`.                                                          |
| —   | **Phase 2**              | Algorithm `none` and HS256 rejected before verification attempt.                                                                                                                                       |
| —   | **Phase 2**              | Negative Redis cache for "no signing key" lookups (30s TTL) to mitigate key exhaustion attacks.                                                                                                        |
| —   | **Phase 2**              | Rate limit on `/api/v1/sdk/init` — existing 30 req/min per tenant via `tenantRateLimit()`.                                                                                                             |
| S1  | **BLOCKER Phase 2**      | Bind customer JWT `sub` claim into internal session token as `verifiedSub`. Prefer `verifiedSub` over `userContext.userId` in `handleTokenAuth()`. `identityTier = 2` only when `verifiedSub` present. |
| S2  | **Mandatory Phase 2**    | Scope jti Redis key as `sdk:jti:{tenantId}:{projectId}:{jti}` — prevents cross-tenant collisions.                                                                                                      |
| S3  | **Mandatory Phase 2**    | Customer JWT MUST include `kid` header. Verifier looks up by `(tenantId, projectId, kid)` directly — no iteration. Reject missing `kid`.                                                               |
| S4  | **Mandatory Phase 2**    | After JWKS fetch, validate key `kty`/`alg` match `SDKSigningKeyDoc.algorithm`. Reject mismatches.                                                                                                      |
| S5  | **Mandatory Phase 2**    | Token refresh must verify signing key not revoked. Store `signingKeyId` in `SDKSessionTokenPayload`.                                                                                                   |
| S6  | **Mandatory Phase 3**    | Master key rotation procedure for `jwePrivateKeyPem`. `dekVersion` field on `SDKSigningKeyDoc`. Future: HSM-backed storage.                                                                            |
| S7  | **Mandatory Phase 2**    | `jose.jwtVerify()` with `clockTolerance: 30`. Reject `iat > now + 30s`. Validate `nbf` if present.                                                                                                     |
| S8  | **Prerequisite Phase 1** | Ops must confirm ALB/nginx log redaction of `Sec-WebSocket-Protocol` before enabling feature flag. Block if not verified.                                                                              |
| S9  | **Mandatory Phase 2**    | Refactor `sdkInitMiddleware()` to return uniform error shape matching JWT path. No differential errors between auth methods.                                                                           |
| S10 | **Mandatory Phase 1**    | `TokenManager` validates `tokenEndpoint` starts with `https://` (except localhost in dev). Apply SSRF check if used server-side.                                                                       |
| S11 | **Mandatory Phase 2**    | Rate limit signing key CRUD: 10 creates/hour, 5 JWKS invalidations/min per project. Max 5 signing keys per project.                                                                                    |

**Token storage:** Memory-only (`#token` private field). No `localStorage`, `sessionStorage`, or cookies. `AgentSDK.init()` stores SDK instance on `window.__agentSDK` but the token itself is inaccessible from outside `TokenManager`.

---

## 6. Operations Requirements

All operations audit findings consolidated:

### Deployment Sequencing

1. **Runtime first, SDK second** for `Sec-WebSocket-Protocol` transport change. Runtime must support both `?token=` URL param and `Sec-WebSocket-Protocol` header simultaneously during migration.
2. **Feature flag:** `SDK_CUSTOMER_JWT_ENABLED=false` for Phase 2. Enable after staging validation with real RS256 JWT.
3. **This plan (Web SDK JWT/JWE Auth) is independent of the consolidated `studio-runtime-isolation.md` plan** (which covers the scope of the former Plans 1-3; Plan 4 was superseded). Can be deployed in any position relative to the isolation plan. Modifies `packages/web-sdk`, `apps/runtime/src/middleware/sdk-auth.ts`, `apps/runtime/src/routes/sdk-init.ts`, and adds a new MongoDB model — no overlap.

### Monitoring

| Metric/Alert                              | Phase   | Detail                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.jwks.fetch_failure` counter          | Phase 2 | Labels: `tenantId`, `projectId`. Alert on >3 consecutive failures in 5 minutes.                                                                                                                                                                                       |
| `sdk_auth_method` label on `session.init` | Phase 4 | Track adoption of `api_key` vs `customer_jwt`.                                                                                                                                                                                                                        |
| `customer_jwt_verify_failure_rate > 10%`  | Phase 4 | Per-project alert for misconfigured customers.                                                                                                                                                                                                                        |
| JWE decryption failure logging            | Phase 3 | Log with `reason: 'jwe_decrypt_failed'` at warn level. Generic 401 to client.                                                                                                                                                                                         |
| `Sec-WebSocket-Protocol` header scrubbing | Phase 1 | **PREREQUISITE (not just documentation):** Before enabling `Sec-WebSocket-Protocol` token transport in production, ops must confirm ALB/nginx access logs are configured to redact the `Sec-WebSocket-Protocol` header value. Block the feature flag if not verified. |

### Dual-Runtime Note

When Plan 2 (Separate Runtime Deployments) is active, customer backends must use the production Runtime URL for SDK authentication. Debug Runtime rejects `/ws/sdk` connections (`RUNTIME_MODE=debug`).

### Resource Impact

- `jose` adds ~45 KB to Runtime bundle (server-side only, not in Web SDK browser bundle)
- JWKS cache: ~5 MB Redis for 10,000 projects (negligible)
- `SDKSigningKey` collection: ~15 MB MongoDB for 10,000 projects (negligible)
- JWE decryption: ~0.5-2ms per call, <2 CPU-seconds/minute at 1,000 init calls/min

---

## 7. Open Items

1. **JWT verifier placement:** Currently in `apps/runtime/src/services/customer-jwt/`. If `search-ai-runtime` or `admin` later need customer JWT validation, extract to `packages/shared-auth/`.
2. **JWKS cache TTL vs. revocation speed:** 1-hour cache delays key revocation. The `invalidate-jwks-cache` admin endpoint (P2-10) provides immediate revocation path. Document in key rotation runbook.
3. **JWE private key caching:** Consider caching decrypted `jwePrivateKeyPem` as a `CryptoKey` object (from `importPKCS8()`) in an in-memory LRU with 5-minute TTL and **`maxEntries: 100`** to avoid repeated RSA key import on every request. Per core invariant: every in-memory `Map` needs max size, TTL, and eviction. The same max-size bound applies to the JWKS `CryptoKey` cache — use `maxEntries: 100` and 1-hour TTL to match the Redis JWKS cache TTL.
4. **Multiple active signing keys:** ~~Runtime tries up to 3 active keys per project for verification.~~ **Customer JWT MUST include a `kid` header claim.** The verifier MUST look up the signing key by `(tenantId, projectId, kid)` directly — never iterate through all active keys. Reject JWTs with missing `kid`. This eliminates timing side-channels and key confusion attacks. Key addition audit logging (H4) is the primary control against unauthorized key injection.

---

## 8. Rollback Procedures

### Phase 1 (SDK + WS handler)

- **SDK:** Revert SDK package version. Runtime's dual-transport support (URL param fallback) ensures existing clients continue working.
- **WS handler:** Runtime image redeploy. ~3 minutes.

### Phase 2 (Customer JWT middleware)

- **Fast rollback:** Set `SDK_CUSTOMER_JWT_ENABLED=false`. No redeploy needed. Existing `pk_*` path unaffected.
- **Full rollback:** Runtime image redeploy. ~3 minutes.
- **DB:** `SDKSigningKey` collection is new and empty/harmless after rollback.
- **Risk:** A bug in `sdkInitOrJwtMiddleware()` dispatch logic could break ALL SDK init calls (including `pk_*`). Unit tests for the dispatcher are critical.

### Phase 3 (JWE)

- **Disable:** Remove JWE private keys from signing key config. Tokens with `privateClaims` will fail with generic 401.
- **Key rotation rollback:** Old JWE private key retained for configurable period. `forceRotate` flag available for emergency.
- **Backward compatibility risk:** If Phase 3 is rolled back, customers who were sending `privateClaims` via JWE will receive blanket 401s because the runtime can no longer decrypt the JWE payload. **Mitigation:** During rollback, enable a grace period (configurable per tenant via feature flag `SDK_JWE_GRACE_MODE`) where the runtime accepts JWTs containing `privateClaims` but skips decryption — the encrypted `privateClaims` field is ignored (treated as absent) rather than causing a 401. Log a warning: `'JWE grace mode: privateClaims ignored for tenant {tenantId}'`. This allows customers time to remove `privateClaims` from their JWTs. Grace period default: 7 days. After grace period expiry, JWTs with `privateClaims` are rejected normally.

---

## Appendix A: File Manifest

**New Files:**

| File                                                   | Purpose                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/web-sdk/src/core/TokenManager.ts`            | Token fetch, cache, refresh lifecycle                                                                                          |
| `packages/database/src/models/SDKSigningKey.ts`        | Mongoose model for signing keys                                                                                                |
| ~~`apps/runtime/src/types/sdk-init.d.ts`~~             | ~~Express namespace augmentation~~ — removed; extend `SDKInitData` in `packages/shared-kernel/src/types/index.ts` instead (A1) |
| `apps/runtime/src/repos/sdk-signing-key-repo.ts`       | Tenant-scoped CRUD                                                                                                             |
| `apps/runtime/src/services/customer-jwt/verifier.ts`   | jose-based JWT verify and JWE decrypt                                                                                          |
| `apps/runtime/src/services/customer-jwt/jwks-cache.ts` | Redis-backed JWKS cache                                                                                                        |
| `apps/runtime/src/middleware/sdk-customer-jwt.ts`      | Customer JWT -> `req.sdkInit` middleware                                                                                       |
| `apps/runtime/src/routes/sdk-signing-keys.ts`          | Admin CRUD routes                                                                                                              |

**Modified Files:**

| File                                           | Changes                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `packages/web-sdk/src/core/types.ts`           | `SDKAuthConfig` union, `SDKEvents.authExpired`                       |
| `packages/web-sdk/src/core/SessionManager.ts`  | `TokenManager` dep, `Sec-WebSocket-Protocol`                         |
| `packages/web-sdk/src/core/AgentSDK.ts`        | `TokenManager` init, `normalizeConfig()`                             |
| `packages/web-sdk/src/react/AgentProvider.tsx` | `onAuthExpired` prop                                                 |
| `apps/runtime/src/middleware/sdk-auth.ts`      | `sdkInitOrJwtMiddleware()`                                           |
| `apps/runtime/src/routes/sdk-init.ts`          | Switch middleware, propagate JWT identity                            |
| `apps/runtime/src/websocket/sdk-handler.ts`    | Read token from protocol header                                      |
| `apps/runtime/src/server.ts`                   | Mount signing keys router                                            |
| `packages/shared-auth/src/types/index.ts`      | Add `authMethod: 'jwt' \| 'jwe' \| 'pk'` to `SDKSessionTokenPayload` |
| `packages/database/src/models/index.ts`        | Register `SDKSigningKey`                                             |
| `apps/runtime/package.json`                    | `jose` already present (`^5.10.0`) — no change needed                |
