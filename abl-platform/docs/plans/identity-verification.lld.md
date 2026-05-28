# Identity Verification -- Low-Level Design

**Status**: Implemented (ALPHA)
**Feature Spec**: [docs/features/identity-verification.md](../features/identity-verification.md)
**HLD**: [docs/specs/identity-verification.hld.md](../specs/identity-verification.hld.md)
**Testing Guide**: [docs/testing/identity-verification.md](../testing/identity-verification.md)

---

## Task T-1: IdentityVerifier Port + Domain Types

### Files Modified

- `apps/runtime/src/contexts/identity/domain/identity-verifier.ts` -- Port interface, supporting types

### Function Signatures

- `IdentityVerifier.initiate(input: VerificationInput): Promise<VerificationInitResult>` -- Start a verification flow
- `IdentityVerifier.complete(attemptId: string, proof: VerificationProof): Promise<VerificationResult>` -- Complete with proof
- `IdentityVerifier.supports(input: VerificationInput): boolean` -- Check if verifier handles the input
- `readonly method: VerificationMethod` -- The method this verifier handles

### Key Implementation Details

- **VerificationInput**: 6 fields -- tenantId, sessionId, channelType (ChannelType), identityValue, identityType (ChannelArtifactType), metadata (optional Record)
- **VerificationInitResult**: success, attemptId?, challengeData? (Record), error? ({ code, message })
- **VerificationProof**: type (discriminated union: `otp_code | hmac_signature | oauth_token | provider_assertion`), value, timestamp?, metadata?
- **VerificationResult**: success, identityTier? (number), verifiedIdentity? (string), error?
- **Shared types** imported from `@agent-platform/shared-auth`: VerificationMethod, ChannelArtifactType, IdentityTier

---

## Task T-2: VerificationAttempt Value Object

### Files Modified

- `apps/runtime/src/contexts/identity/domain/verification-attempt.ts` -- Value object with factory and helpers

### Function Signatures

- `createVerificationAttempt(input: CreateVerificationAttemptInput): VerificationAttempt` -- Factory with UUID id generation
- `isExpired(attempt: VerificationAttempt): boolean` -- Check if past expiresAt
- `canAttempt(attempt: VerificationAttempt): boolean` -- Status is pending AND attempts < maxAttempts AND not expired

### Key Implementation Details

- **VerificationStatus**: `'pending' | 'verified' | 'expired' | 'failed'`
- **VerificationAttempt**: 10 fields -- id (randomUUID), tenantId, sessionId, method, identityValue, identityType, status, attempts, maxAttempts, createdAt, expiresAt
- **DEFAULT_MAX_ATTEMPTS**: 5
- **CreateVerificationAttemptInput**: tenantId, sessionId, method, identityValue, identityType, expiresAt, maxAttempts? (defaults to 5)

---

## Task T-3: IdentityTier Promotion Logic

### Files Modified

- `apps/runtime/src/contexts/identity/domain/identity-tier.ts` -- Tier constants, promotion rules, verification-to-tier mapping

### Function Signatures

- `canPromoteTo(current: IdentityTier, target: IdentityTier): boolean` -- Strictly upward: target > current
- `tierFromVerification(method: VerificationMethod): IdentityTier` -- Lookup from VERIFICATION_TIER_MAP

### Key Implementation Details

- **Three tiers**: 0 (anonymous), 1 (recognized), 2 (verified)
- **VERIFICATION_TIER_MAP**: `none->0`, `cookie->1`, `caller_id->1`, `provider->1`, `hmac->2`, `otp->2`, `oauth->2`
- **Promotion**: Strictly upward only. 0->1, 0->2, 1->2 allowed. Same-tier and downgrades rejected.
- **Types** imported from `@agent-platform/shared-auth`

---

## Task T-4: IdentityArtifact Hashing

### Files Modified

- `apps/runtime/src/contexts/identity/domain/identity-artifact.ts` -- SHA-256 hash, artifact factory

### Function Signatures

- `hash(rawValue: string): string` -- SHA-256 hex digest (64-char string)
- `create(rawValue: string, artifactType: ChannelArtifactType): IdentityArtifact` -- Factory with auto-hash

### Key Implementation Details

- **IdentityArtifact**: rawValue, artifactType, hashedValue
- Uses Node.js `crypto.createHash('sha256')` -- no external dependencies
- Raw values hashed before persistence; plaintext never stored in Redis or MongoDB

---

## Task T-5: HmacVerifier Adapter

### Files Modified

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts` -- Single-step HMAC verification

### Function Signatures

- `constructor(secretKey: string)` -- Server-side HMAC secret
- `initiate(input: VerificationInput): Promise<VerificationInitResult>` -- Performs verification immediately (no two-step)
- `complete(_attemptId, _proof): Promise<VerificationResult>` -- No-op, returns success with tier 2
- `supports(input: VerificationInput): boolean` -- True when metadata contains hmac (string) + timestamp (number)

### Key Implementation Details

- **Single-step flow**: initiate() performs the HMAC check; complete() is a no-op
- **Delegates to** `verifyHMAC()` from `services/identity/artifact-hasher.ts` -- does not duplicate logic
- **HMAC format**: `HMAC-SHA256(userId + ":" + timestamp, secretKey)`
- **Metadata requirements**: `metadata.hmac` (string) and `metadata.timestamp` (number) must be present
- **supports()**: Returns true only when HMAC metadata is present, preventing false dispatch

---

## Task T-6: OtpVerifier Adapter + Token Store

### Files Modified

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts` -- Two-step OTP verification
- `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts` -- Port interface

### Function Signatures

- `OtpVerifier.constructor(tokenStore: VerificationTokenStore, hmacSecret: string)` -- Store + server secret
- `OtpVerifier.initiate(input): Promise<VerificationInitResult>` -- Generate code, hash, store, return code in challengeData
- `OtpVerifier.complete(attemptId, proof): Promise<VerificationResult>` -- Hash submitted code, timing-safe compare
- `OtpVerifier.supports(_input): boolean` -- Always true (OTP is orchestration-triggered)
- `VerificationTokenStore.create(attempt: StoredVerificationAttempt): Promise<void>` -- Persist with TTL
- `VerificationTokenStore.get(tenantId, attemptId): Promise<StoredVerificationAttempt | null>` -- Tenant-scoped lookup
- `VerificationTokenStore.incrementAttempts(tenantId, attemptId): Promise<void>` -- Rate limit counter
- `VerificationTokenStore.markVerified(tenantId, attemptId): Promise<void>` -- Terminal state

### Key Implementation Details

- **OTP_MAX_ATTEMPTS**: 5
- **OTP_TTL_SECONDS**: 600 (10 minutes)
- **Code generation**: Uses `otplib.generateSecret()` + `otplib.generate()` for 6-digit codes
- **Code hashing**: `HMAC-SHA256(code, hmacSecret)` -- codes never stored in plaintext
- **Timing-safe compare**: `crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))` -- prevents timing side-channel
- **Rate limiting**: `canAttempt()` checks status=pending AND attempts < maxAttempts AND not expired
- **StoredVerificationAttempt**: Extends VerificationAttempt with `readonly codeHash: string`

---

## Task T-7: OAuthVerifier Adapter (PKCE)

### Files Modified

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts` -- Two-step OAuth with PKCE

### Function Signatures

- `OAuthVerifier.constructor(tokenStore: VerificationTokenStore, provider: OAuthProviderAdapter)` -- Store + Arctic provider
- `OAuthVerifier.initiate(input): Promise<VerificationInitResult>` -- Generate state + PKCE code verifier, store, return redirect URL
- `OAuthVerifier.complete(attemptId, proof): Promise<VerificationResult>` -- Validate state, exchange code, fetch email
- `OAuthProviderAdapter.createAuthorizationURL(state, codeVerifier): URL` -- Provider-agnostic auth URL builder
- `OAuthProviderAdapter.validateAuthorizationCode(code, codeVerifier): Promise<{ accessToken }>` -- Token exchange
- `OAuthProviderAdapter.fetchUserEmail(accessToken): Promise<string>` -- Userinfo email extraction

### Key Implementation Details

- **OAUTH_TTL_MS**: 600,000 (10 minutes)
- **STATE_BYTE_LENGTH**: 32 bytes -> 64 hex chars
- **CODE_VERIFIER_BYTE_LENGTH**: 32 bytes -> 64 hex chars
- **Storage trick**: `codeHash` stores `JSON.stringify({ state, codeVerifier })` -- reuses the codeHash field for OAuth state
- **CSRF protection**: State parameter compared on complete() -- mismatch returns `OAUTH_STATE_MISMATCH`
- **PKCE**: Code verifier passed to `validateAuthorizationCode()` for proof-of-possession
- **Error codes**: `OAUTH_ATTEMPT_NOT_FOUND`, `OAUTH_EXPIRED`, `OAUTH_STATE_MISMATCH`, `OAUTH_TOKEN_EXCHANGE_FAILED`, `OAUTH_USERINFO_FAILED`
- **Tenant isolation**: complete() loads attempt by tenantId from proof.metadata -- cross-tenant returns NOT_FOUND

---

## Task T-8: EmailLinkVerifier Adapter

### Files Modified

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` -- Two-step magic link verification

### Key Implementation Details

- **initiate()**: Generates random token, stores HMAC-SHA256 hash in codeHash, returns raw token in challengeData
- **complete()**: Hashes submitted token, compares against stored hash, marks verified
- **supports()**: Returns true for any input (orchestration-triggered)
- **Already-used protection**: Verifies attempt status is still `pending` before accepting
- **Expiry**: Uses same VerificationAttempt expiry mechanism as OTP

---

## Task T-9: ProviderVerifier + WebhookVerifier

### Files Modified

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/provider-verifier.ts` -- Sync channel-provider check
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts` -- Async webhook challenge/response

### Key Implementation Details

- **ProviderVerifier**: Single-step sync verification for channel-provided identity artifacts (e.g., WhatsApp verified phone). Returns tier 1 (recognized).
- **WebhookVerifier**: Two-step flow. initiate() sends challenge payload to customer-configured webhook endpoint with HMAC signature. complete() validates the webhook response proof. Uses `fetch()` for HTTP calls. Supports configurable timeout.
- **SendChallengeFn**: `(payload: SendChallengePayload) => Promise<void>` -- external dispatch function injected via constructor

---

## Task T-10: VerifyIdentity Dispatcher Use Case

### Files Modified

- `apps/runtime/src/contexts/identity/use-cases/verify-identity.ts` -- Dispatcher to correct verifier

### Function Signatures

- `VerifyIdentity.constructor(verifiers: Map<VerificationMethod, IdentityVerifier>)` -- Registry
- `VerifyIdentity.execute(input: VerificationInput): Promise<VerificationInitResult>` -- Iterate, find first supporting verifier

### Key Implementation Details

- **Dispatch strategy**: Iterates `verifiers.values()`, calls `verifier.supports(input)`, delegates to first match
- **No-verifier fallback**: Returns `{ success: false, error: { code: 'NO_VERIFIER', message: '...' } }`
- **Not method-keyed lookup**: Uses `supports()` check rather than direct map key access -- allows verifiers to accept/reject based on input characteristics

---

## Task T-11: Session Resolution (Use Case + Store)

### Files Modified

- `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts` -- ResolveSession use case + SessionResolutionStore port
- `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts` -- RegisterResolutionKey use case
- `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts` -- Redis-backed store
- `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts` -- Key format

### Function Signatures

- `ResolveSession.execute(tenantId, channelId, artifactHash): Promise<ResolveSessionResult>` -- Lookup by composite key
- `RegisterResolutionKey.execute(key: SessionResolutionKey): Promise<void>` -- Save artifact->session mapping
- `buildResolutionKeyId(tenantId, channelId, artifactHash): string` -- Returns `session_resolution:{tenantId}:{channelId}:{artifactHash}`
- `RedisResolutionKeyStore.findByKey(tenantId, channelId, artifactHash): Promise<{ sessionId } | null>` -- Redis GET
- `RedisResolutionKeyStore.save(key: SessionResolutionKey): Promise<void>` -- Redis SET with TTL

### Key Implementation Details

- **SessionResolutionKey**: tenantId, channelId, artifactHash, sessionId, expiresAt
- **Composite key**: `session_resolution:{tenantId}:{channelId}:{artifactHash}` -- tenant isolation at key level
- **TTL**: Calculated from `expiresAt - now` in seconds, set via Redis EX option
- **ResolveSessionResult**: `{ found: true, sessionId } | { found: false }`

---

## Task T-12: PromoteTier Use Case

### Files Modified

- `apps/runtime/src/contexts/identity/use-cases/promote-tier.ts` -- Pure domain logic

### Function Signatures

- `PromoteTier.execute(input: PromoteTierInput): PromoteTierResult` -- Validate and promote
- **PromoteTierInput**: currentTier (IdentityTier), verificationMethod (VerificationMethod)
- **PromoteTierResult**: discriminated union -- `{ success: true, newTier, verificationMethod }` or `{ success: false, error }`

### Key Implementation Details

- **Pure domain**: No infrastructure dependencies, synchronous execution
- Uses `tierFromVerification()` to resolve target tier from method
- Uses `canPromoteTo()` to validate upward-only promotion
- Returns `TIER_NOT_PROMOTED` error for invalid transitions (same tier, downgrade)

---

## Task T-13: Express Routes + Factory

### Files Modified

- `apps/runtime/src/routes/identity-verification.ts` -- Express router with factory injection
- `apps/runtime/src/contexts/identity/index.ts` -- Barrel exports + `createIdentityContext()` factory

### Function Signatures

- `createIdentityVerificationRouter(deps: IdentityVerificationRouterDeps): Router` -- Factory-created router
- `createIdentityContext(deps: IdentityContextDeps): IdentityContext` -- Wires all use cases
- **IdentityContextDeps**: verifiers (Map), resolutionStore (SessionResolutionStore), tokenStore (VerificationTokenStore)
- **IdentityContext**: verifyIdentity, resolveSession, registerResolutionKey, promoteTier

### Key Implementation Details

- **Auth middleware**: Inline check for `req.tenantContext?.tenantId` -- returns 401 if missing
- **POST /initiate**: Validates method, identityValue, identityType required. Delegates to `verifyIdentity.execute()`. Returns result directly.
- **POST /complete**: Validates attemptId and proof required. Delegates to `completeVerification()`. Returns result directly.
- **GET /:attemptId**: Tenant-scoped lookup via `tokenStore.get(tenantId, attemptId)`. Returns 404 if not found. Strips sensitive fields (codeHash not exposed).
- **Error handling**: All routes catch errors and return `{ success: false, error: { code: 'INTERNAL_ERROR', message } }`
- **GAP-001**: Routes use `console.error` instead of `createLogger` for error logging

---

## Known Gaps

| ID      | Description                                                                                 | Severity |
| ------- | ------------------------------------------------------------------------------------------- | -------- |
| GAP-001 | Routes use `console.error` instead of `createLogger('identity-verification')`               | Low      |
| GAP-002 | Route POST /initiate hardcodes `channelType: 'web_chat'` instead of extracting from request | Medium   |
| GAP-003 | No email/SMS dispatch integration -- OTP code returned in challengeData but not sent        | High     |
| GAP-004 | No webhook verifier HTTP timeout configuration (hardcoded or missing)                       | Medium   |
| GAP-005 | `email_link` and `webhook` verification methods not in VERIFICATION_TIER_MAP                | Medium   |
| GAP-006 | No audit logging integration in verification routes                                         | Medium   |
| GAP-007 | No Zod validation on route request bodies (manual field checks only)                        | Low      |
