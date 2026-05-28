# Identity Verification -- Low-Level Design & Implementation Plan

**Feature Spec**: [../features/identity-verification.md](../features/identity-verification.md)
**HLD**: [../specs/identity-verification.hld.md](../specs/identity-verification.hld.md)
**Test Spec**: [../testing/identity-verification.md](../testing/identity-verification.md)
**Date**: 2026-03-22
**Status**: DONE

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                            | Rationale                                                                                                      | Alternatives Rejected                                       |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D-1 | Fix timing-safe comparison in EmailLinkVerifier and WebhookVerifier | Security requirement: hash comparison must use `timingSafeEqual` to prevent timing attacks (GAP-013, GAP-014)  | Leave as-is (unacceptable security risk)                    |
| D-2 | Add `email_link` and `webhook` to `VerificationMethod` union type   | Fix method collision: EmailLinkVerifier currently uses `'otp'` and WebhookVerifier uses `'provider'` (GAP-008) | Keep workaround (breaks when multiple verifiers registered) |
| D-3 | Replace `console.error` with `createLogger` in routes               | Platform standard (CLAUDE.md): never use console.log/error in server code (GAP-001)                            | Leave as-is (violates platform invariant)                   |
| D-4 | Replace `(req as any).tenantContext` with typed request             | Type safety: eliminates `any` cast (GAP-002)                                                                   | Leave as-is (minor type safety issue)                       |
| D-5 | Wire real dependencies in `server.ts`                               | Feature is non-functional with stub deps (GAP-010). Must wire real verifier registry and Redis token store.    | Keep stubs (feature remains non-functional)                 |
| D-6 | Add Zod validation on route request bodies                          | Platform standard: validate at boundaries (GAP-011)                                                            | Keep manual field checks (less robust)                      |
| D-7 | Make `channelType` dynamic from request context                     | Currently hardcoded to `'web_chat'` (GAP-005). Should derive from session/channel context.                     | Keep hardcoded (wrong for non-web channels)                 |
| D-8 | Use atomic Redis INCR for rate limiting                             | Current GET+SET is non-atomic (GAP-009). Redis INCR + Lua script prevents race conditions.                     | Keep GET+SET (acceptable for low concurrency)               |

### Key Interfaces & Types

**New type additions to `@agent-platform/shared-auth`**:

```typescript
// packages/shared-auth/src/types/index.ts
export type VerificationMethod =
  | 'none'
  | 'cookie'
  | 'caller_id'
  | 'provider'
  | 'hmac'
  | 'otp'
  | 'oauth'
  | 'email_link' // NEW
  | 'webhook'; // NEW
```

**New typed request interface for identity routes**:

```typescript
// apps/runtime/src/routes/identity-verification.ts
interface IdentityRequest extends Request {
  tenantContext: {
    tenantId: string;
    sessionId?: string;
  };
}
```

**Zod validation schemas for route bodies**:

```typescript
// apps/runtime/src/routes/identity-verification.ts
const initiateSchema = z.object({
  method: z.string().min(1),
  identityValue: z.string().min(1),
  identityType: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const completeSchema = z.object({
  attemptId: z.string().min(1),
  proof: z.object({
    type: z.string().min(1),
    value: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
  }),
});
```

### Module Boundaries

| Module                            | Responsibility                            | Dependencies                                  |
| --------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `domain/`                         | Pure types, value objects, tier logic     | None (zero dependencies)                      |
| `use-cases/`                      | Orchestration, dispatch, validation       | Domain types only                             |
| `infrastructure/verifiers/`       | Verification method adapters              | Domain types + external libs (otplib, crypto) |
| `infrastructure/*-store.ts`       | Redis-backed persistence                  | Domain types + Redis client                   |
| `routes/identity-verification.ts` | HTTP boundary, validation, error handling | Use cases + stores (via DI)                   |
| `server.ts`                       | Wiring, DI, route mounting                | All of the above                              |

---

## 2. File-Level Change Map

### Modified Files

| File                                                                                  | Change Description                                                                                          | Risk                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `packages/shared-auth/src/types/index.ts`                                             | Add `'email_link'` and `'webhook'` to `VerificationMethod` union                                            | Low -- additive type change     |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts`  | Fix `method` to `'email_link'`, add timing-safe comparison                                                  | Medium -- security fix          |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`     | Fix `method` to `'webhook'`, add timing-safe comparison                                                     | Medium -- security fix          |
| `apps/runtime/src/contexts/identity/domain/identity-tier.ts`                          | Add `email_link: 2` and `webhook: 1` to `VERIFICATION_TIER_MAP`                                             | Low -- additive                 |
| `apps/runtime/src/routes/identity-verification.ts`                                    | Replace `console.error` with `createLogger`, add Zod validation, type `tenantContext`, derive `channelType` | Medium -- route handler rewrite |
| `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts` | Add atomic increment via Redis INCR pattern                                                                 | Medium -- concurrency fix       |
| `apps/runtime/src/server.ts`                                                          | Replace stub deps with real verifier registry and Redis token store                                         | High -- production wiring       |
| `apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts`            | Update tests for method change and timing-safe comparison                                                   | Low                             |
| `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts`            | Update tests for Zod validation and logger changes                                                          | Low                             |
| `apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts`                | Add tests for new tier mappings (email_link, webhook)                                                       | Low                             |

### New Files

| File                                                                     | Purpose                                                | LOC Estimate |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------ |
| `apps/runtime/src/__tests__/contexts/identity/identity-e2e-http.test.ts` | E2E tests for HTTP API (scenarios E2E-1 through E2E-7) | ~400         |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Type Safety & Security Fixes

**Goal**: Fix security gaps and type mismatches that make the feature unsafe and prevent correct multi-verifier registration.

**Tasks**:

1.1. Add `'email_link'` and `'webhook'` to `VerificationMethod` union in `packages/shared-auth/src/types/index.ts`

1.2. Update `VERIFICATION_TIER_MAP` in `identity-tier.ts` to include `email_link: 2` and `webhook: 1`

1.3. Fix `EmailLinkVerifier.method` from `'otp'` to `'email_link'`

1.4. Add timing-safe comparison to `EmailLinkVerifier.complete()` -- replace plain `!==` with `timingSafeEqual` on hex-encoded HMAC hashes (matching the pattern in `OtpVerifier`)

1.5. Fix `WebhookVerifier.method` from `'provider'` to `'webhook'`

1.6. Add timing-safe comparison to `WebhookVerifier.complete()` -- replace plain `!==` with `timingSafeEqual` on hex-encoded HMAC hashes

1.7. Update tests: `email-link-verifier.test.ts` for method change, `identity-domain.test.ts` for new tier mappings

**Files Touched**:

- `packages/shared-auth/src/types/index.ts` -- add `email_link`, `webhook` to union
- `apps/runtime/src/contexts/identity/domain/identity-tier.ts` -- update `VERIFICATION_TIER_MAP`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` -- fix method, add timingSafeEqual
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts` -- fix method, add timingSafeEqual
- `apps/runtime/src/__tests__/contexts/identity/email-link-verifier.test.ts` -- update for method change
- `apps/runtime/src/__tests__/contexts/identity/identity-domain.test.ts` -- add tier map tests

**Exit Criteria**:

- [x] `pnpm build --filter=@agent-platform/shared-auth` succeeds with 0 errors
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] All existing identity unit tests pass: `pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/`
- [x] `EmailLinkVerifier.method === 'email_link'` (verified by test)
- [x] `WebhookVerifier.method === 'webhook'` (verified by test)
- [x] `tierFromVerification('email_link') === 2` (verified by test)
- [x] `tierFromVerification('webhook') === 1` (verified by test)
- [x] `EmailLinkVerifier.complete()` uses `timingSafeEqual` (verified by code review)
- [x] `WebhookVerifier.complete()` uses `timingSafeEqual` (verified by code review)

**Test Strategy**:

- Unit: Updated tests for email-link and webhook verifiers, new tier map tests
- Integration: Existing identity.e2e.test.ts continues to pass

**Rollback**: Revert the commit (additive type change + method fix + comparison fix are self-contained).

---

### Phase 2: Route Hardening

**Goal**: Make route handlers production-quality by adding structured logging, Zod validation, typed requests, and dynamic channel type.

**Tasks**:

2.1. Replace `console.error` with `createLogger('identity-verification')` in `identity-verification.ts`

2.2. Add Zod validation schemas for `/initiate` and `/complete` request bodies

2.3. Replace `(req as any).tenantContext` with typed `IdentityRequest` interface

2.4. Derive `channelType` from `tenantContext` or request metadata instead of hardcoding `'web_chat'`

2.5. Add session-level isolation: `GET /:attemptId` verifies `tenantId` matches stored attempt

2.6. Update route tests for Zod validation errors and logger

**Files Touched**:

- `apps/runtime/src/routes/identity-verification.ts` -- logger, Zod, types, channelType
- `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts` -- update for validation changes

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] Route handler uses `createLogger('identity-verification')` (no `console.error`)
- [x] `POST /initiate` with empty body returns `{ success: false, error: { code: "INVALID_INPUT" } }`
- [x] `POST /complete` with missing proof returns `{ success: false, error: { code: "INVALID_INPUT" } }`
- [x] No `(req as any)` casts in route handler code
- [x] All route tests pass with updated assertions

**Test Strategy**:

- Unit: Updated route tests for Zod validation
- Integration: Existing verification-routes.test.ts updated

**Rollback**: Revert the commit. Route changes are isolated to one file.

---

### Phase 3: Redis Store Hardening & Production Wiring

**Goal**: Fix the non-atomic Redis increment and wire real dependencies in `server.ts` to make the feature functional.

**Tasks**:

3.1. Refactor `RedisVerificationTokenStore.incrementAttempts()` to use atomic pattern: read current value, increment, write back with `EX` TTL in a single pipeline or Lua script. If Lua is not available, use Redis WATCH/MULTI/EXEC for optimistic locking.

3.2. Wire real dependencies in `server.ts`:

- Create `RedisVerificationTokenStore` with the runtime Redis client
- Create `HmacVerifier` with HMAC secret from config/env
- Create `OtpVerifier` with OTP HMAC secret and Redis token store
- Create `OAuthVerifier` with token store and a configurable `OAuthProviderAdapter`
- Create `ProviderVerifier` (no deps)
- Build `Map<VerificationMethod, IdentityVerifier>` and pass to `VerifyIdentity`
- Create `RedisResolutionKeyStore` with Redis client
- Wire `createIdentityContext(deps)` and pass use cases to router factory
- Remove stub token store and empty verifier map

  3.3. Add environment variable documentation for HMAC secret, OTP secret, and OAuth provider config

  3.4. Update `server.ts` integration to use `createIdentityContext()` factory

**Files Touched**:

- `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts` -- atomic increment
- `apps/runtime/src/server.ts` -- replace stubs with real deps
- `apps/runtime/src/__tests__/contexts/identity/redis-verification-token-store.test.ts` -- test atomic increment

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] `server.ts` no longer has "stub" or "TODO" comments for identity verification wiring
- [x] `RedisVerificationTokenStore.incrementAttempts()` uses atomic pattern (pipeline or Lua)
- [x] Identity verification routes are mounted with real verifier registry
- [x] Existing tests pass (no regressions)

**Test Strategy**:

- Unit: Updated Redis store tests for atomic increment behavior
- Integration: Manual verification of server startup with identity routes

**Rollback**: Revert the server.ts wiring commit. The feature falls back to stub behavior. Redis store changes are safe to keep.

---

### Phase 4: E2E Tests

**Goal**: Implement the 7 E2E test scenarios from the test spec to validate the full HTTP API stack.

**Tasks**:

4.1. Create `identity-e2e-http.test.ts` with test infrastructure:

- Start real Express server on random port with auth middleware
- Create real `RedisVerificationTokenStore` (use ioredis-mock or Docker Redis)
- Create real verifier registry with HMAC and OTP verifiers
- Create mock `OAuthProviderAdapter` (external service, acceptable to mock)
- Helper functions for authenticated HTTP requests

  4.2. Implement E2E-1: HMAC Verification via HTTP API

  4.3. Implement E2E-2: OTP Verification Complete Flow via HTTP API

  4.4. Implement E2E-3: OTP Rate Limiting and Expiry via HTTP API

  4.5. Implement E2E-4: Cross-Tenant Isolation for Verification Attempts

  4.6. Implement E2E-5: OAuth Verification Redirect Flow via HTTP API

  4.7. Implement E2E-6: Input Validation on API Endpoints

  4.8. Implement E2E-7: Webhook Verification Complete Flow (with test HTTP server)

**Files Touched**:

- `apps/runtime/src/__tests__/contexts/identity/identity-e2e-http.test.ts` -- new E2E test file

**Exit Criteria**:

- [x] All 7 E2E test scenarios pass
- [x] Tests start real Express server (not mocked)
- [x] Tests use real Redis-backed token store (ioredis-mock or Docker Redis)
- [x] Tests do NOT use `vi.mock()` or `jest.mock()` for codebase components
- [x] Cross-tenant isolation verified (E2E-4)
- [x] Rate limiting verified (E2E-3)
- [x] Input validation verified (E2E-6)
- [x] OAuth flow with mock provider verified (E2E-5)

**Test Strategy**:

- E2E: All 7 scenarios from test spec
- No mocking of codebase components

**Rollback**: Delete the test file. No production code changes in this phase.

---

## 4. Wiring Checklist

- [x] `VerificationMethod` union updated in `@agent-platform/shared-auth` (Phase 1)
- [x] `VERIFICATION_TIER_MAP` updated in `identity-tier.ts` (Phase 1)
- [x] `EmailLinkVerifier.method` fixed to `'email_link'` (Phase 1)
- [x] `WebhookVerifier.method` fixed to `'webhook'` (Phase 1)
- [x] Timing-safe comparison in `EmailLinkVerifier.complete()` (Phase 1)
- [x] Timing-safe comparison in `WebhookVerifier.complete()` (Phase 1)
- [x] `createLogger('identity-verification')` replaces `console.error` in routes (Phase 2)
- [x] Zod validation schemas added to routes (Phase 2)
- [x] Typed `IdentityRequest` replaces `(req as any)` casts (Phase 2)
- [x] Dynamic `channelType` derivation in initiate route (Phase 2)
- [x] Atomic `incrementAttempts()` in Redis store (Phase 3)
- [x] Real verifier registry wired in `server.ts` (Phase 3)
- [x] Real Redis token store wired in `server.ts` (Phase 3)
- [x] Identity context factory used in `server.ts` (Phase 3)
- [x] E2E test file created and all 7 scenarios pass (Phase 4)

---

## 5. Cross-Phase Concerns

### Configuration Changes

| Phase   | Config Change                                                                            |
| ------- | ---------------------------------------------------------------------------------------- |
| Phase 3 | New env vars: `IDENTITY_HMAC_SECRET`, `IDENTITY_OTP_SECRET` (or reuse existing secrets)  |
| Phase 3 | OAuth provider config (client ID, secret, redirect URI) via existing auth profile system |

### Feature Flags

No feature flags needed. The identity verification routes are already mounted behind a distinct path (`/api/identity/verify/`). The feature is enabled/disabled by the presence of wired dependencies.

### Database Migrations

None. All state is in Redis (ephemeral, TTL-based). No MongoDB changes.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All 4 phases complete with exit criteria met
- [x] `pnpm build --filter=runtime` and `pnpm build --filter=@agent-platform/shared-auth` succeed
- [x] All existing identity unit tests pass (12 test files)
- [x] All existing identity integration tests pass (2 test files)
- [x] 7 E2E tests pass (new test file)
- [x] No regressions in runtime test suite
- [x] Feature spec updated with implementation details (delivery plan phases marked DONE)
- [x] Testing matrix updated with actual coverage
- [x] No `console.error` in identity verification code
- [x] No `(req as any)` casts in identity verification routes
- [x] No non-timing-safe hash comparisons in any verifier
- [x] `server.ts` wires real dependencies (no stubs)
- [x] `VerificationMethod` type includes all 9 values (including `email_link` and `webhook`)

---

## 7. Open Questions

1. **Redis availability for E2E tests in CI**: Should we use ioredis-mock (simpler CI) or Docker Redis (more realistic)? Decision deferred to Phase 4 implementation.
2. **OAuth provider configuration**: Should OAuth providers be configured via environment variables or the existing auth profile system? Decision deferred to Phase 3 implementation.
3. **HMAC secret management**: Should HMAC secrets be stored in the existing encryption key management system or as plain environment variables? Decision deferred to Phase 3.
