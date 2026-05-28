# LLD + Implementation Plan: SSO / Enterprise Auth

**Feature Spec**: `../features/sso-enterprise-auth.md`
**HLD**: `../specs/sso-enterprise-auth.hld.md`
**Test Spec**: `../testing/sso-enterprise-auth.md`
**Date**: 2026-03-22
**Status**: IN PROGRESS
**Last Updated**: 2026-04-14

---

## 1. Design Decisions

### Decision Log

| Decision                                         | Rationale                                                            | Alternatives Rejected                                            |
| ------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Keep SSO in Studio (not standalone service)      | 60-70% implemented; tight coupling with auth-repo/org-repo           | Standalone auth microservice (excessive refactoring)             |
| Use `@node-saml/node-saml` for SAML validation   | Already imported in SAML callback; proper XML signature verification | Custom XML parsing (insecure), external SaaS (cost)              |
| Add OIDC JWKS verification via `jose` library    | Industry standard, handles key rotation and caching                  | Continue with decode-only (insecure), `openid-client` (heavier)  |
| Encrypted SSO config via EncryptionService       | Consistent with MFA secret encryption; supports key rotation         | Separate Vault integration (over-engineered for current scale)   |
| Redis-first state store with in-memory fallback  | Production-grade distributed state with dev-mode simplicity          | Redis-only (blocks local dev), in-memory-only (breaks multi-pod) |
| One-time auth code pattern for SSO callback      | Prevents token leakage in browser history/URL bars                   | Direct token in redirect URL (security risk)                     |
| Standardize on `createLogger` for all SSO routes | Consistency with platform logging patterns                           | Keep mixed console/logger (technical debt)                       |

### Key Interfaces & Types

```typescript
// Existing (no changes needed)
interface SAMLConfig {
  entityId: string;
  ssoUrl: string;
  certificate: string;
  signRequests: boolean;
  nameIdFormat: 'email' | 'persistent' | 'transient';
}
interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  jwksUri: string;
  scopes: string[];
}
interface SSOConfigData {
  protocol: 'saml' | 'oidc';
  saml?: SAMLConfig;
  oidc?: OIDCConfig;
}
interface SSOUser {
  email: string;
  name?: string;
  externalId: string;
  provider: 'saml' | 'oidc';
  attributes?: Record<string, string>;
}

// New: OIDC JWKS verification
interface JWKSVerificationResult {
  valid: boolean;
  payload: Record<string, unknown>;
  error?: string;
}

// New: SSO config management API
interface SSOConfigCreateRequest {
  protocol: 'saml' | 'oidc';
  config: SAMLConfig | OIDCConfig;
  forceSso?: boolean;
  allowGoogleFallback?: boolean;
}
interface SSOConfigResponse {
  id: string;
  protocol: string;
  forceSso: boolean;
  allowGoogleFallback: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// New: Domain management API
interface DomainClaimRequest {
  domain: string;
}
interface DomainClaimResponse {
  domain: string;
  verificationToken: string;
  verified: boolean;
}
interface DomainVerifyRequest {
  domain: string;
}
```

### Module Boundaries

| Module                                     | Responsibility                                | Dependencies                           |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------- |
| `apps/studio/src/services/sso/`            | SSO service layer (SAML, OIDC, domain, state) | org-repo, auth-repo, encryption, Redis |
| `apps/studio/src/services/auth/`           | MFA and password services                     | mfa-repo, encryption, config           |
| `apps/studio/src/services/auth-service.ts` | JWT, token pairs, tenant context              | auth-repo, config                      |
| `apps/studio/src/app/api/sso/`             | SSO route handlers (Next.js API routes)       | SSO services, auth-service             |
| `apps/studio/src/app/api/auth/mfa/`        | MFA route handlers                            | mfa-service, auth-service              |
| `apps/studio/src/repos/`                   | Data access layer                             | @agent-platform/database               |
| `packages/shared-auth/`                    | Cross-app auth middleware                     | express, jsonwebtoken                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                | Purpose                                          | LOC Estimate |
| ------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| `apps/studio/src/app/api/sso/exchange/route.ts`                     | Auth code exchange endpoint                      | ~60          |
| `apps/studio/src/app/api/sso/config/route.ts`                       | SSO config CRUD (GET, PUT, DELETE)               | ~150         |
| `apps/studio/src/app/api/sso/domains/route.ts`                      | Domain list + claim (GET, POST)                  | ~100         |
| `apps/studio/src/app/api/sso/domains/verify/route.ts`               | Domain verification (POST)                       | ~50          |
| `apps/studio/src/services/sso/jwks-verifier.ts`                     | OIDC JWKS key fetching and ID token verification | ~120         |
| `apps/studio/src/__tests__/unit/oidc-pkce.test.ts`                  | Unit tests: PKCE generation                      | ~80          |
| `apps/studio/src/__tests__/unit/ssrf-validation.test.ts`            | Unit tests: SSRF URL validation                  | ~100         |
| `apps/studio/src/__tests__/unit/mfa-totp.test.ts`                   | Unit tests: TOTP, recovery code, MFA enforcement | ~200         |
| `apps/studio/src/__tests__/integration/sso-state-store.test.ts`     | Integration tests: state store ops               | ~150         |
| `apps/studio/src/__tests__/integration/domain-verification.test.ts` | Integration tests: domain service                | ~150         |
| `apps/studio/src/__tests__/integration/mfa-enforcement.test.ts`     | Integration tests: MFA lifecycle                 | ~200         |

### Modified Files

| File                                                 | Change Description                                                 | Risk   |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| `apps/studio/src/app/api/sso/oidc/callback/route.ts` | Add JWKS ID token verification; standardize logging                | Medium |
| `apps/studio/src/app/api/sso/saml/callback/route.ts` | Standardize logging (replace console.error/warn with createLogger) | Low    |
| `apps/studio/src/app/api/sso/init/route.ts`          | Add PKCE code challenge to OIDC redirect; standardize logging      | Low    |
| `apps/studio/src/services/sso/oidc-service.ts`       | Add JWKS-based ID token validation; add fetch timeout              | Medium |
| `apps/studio/src/services/sso/sso-state-store.ts`    | Add max size guard for in-memory Maps                              | Low    |
| `apps/studio/src/services/sso/sso-types.ts`          | Add `jwksUri` field validation note                                | Low    |
| `apps/studio/src/lib/sso-state-store.ts`             | Ensure wrapper delegates to service sso-state-store                | Low    |
| `apps/studio/src/lib/sso-auth-codes.ts`              | Ensure wrapper delegates correctly                                 | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Missing Route Implementations + Auth Code Exchange

**Goal**: Implement the SSO management routes and auth code exchange endpoint that are currently stubs.

**Tasks**:
1.1. Implement `POST /api/sso/exchange` -- consume auth code, return tokens
1.2. Implement `GET /api/sso/config` -- read SSO config for authenticated org admin
1.3. Implement `PUT /api/sso/config` -- create/update SSO config with encryption
1.4. Implement `DELETE /api/sso/config` -- deactivate SSO config
1.5. Implement `GET /api/sso/domains` -- list domains for org
1.6. Implement `POST /api/sso/domains` -- claim domain with verification token
1.7. Implement `POST /api/sso/domains/verify` -- trigger DNS verification
1.8. Implement `DELETE /api/sso/domains/:domain` -- remove domain claim

**Files Touched**:

- `apps/studio/src/app/api/sso/exchange/route.ts` -- new: auth code exchange
- `apps/studio/src/app/api/sso/config/route.ts` -- new: SSO config CRUD
- `apps/studio/src/app/api/sso/domains/route.ts` -- new: domain list + claim
- `apps/studio/src/app/api/sso/domains/verify/route.ts` -- new: domain verification

**Exit Criteria**:

- [ ] `POST /api/sso/exchange` with valid code returns 200 with `{ accessToken, refreshToken, expiresIn }`
- [ ] `POST /api/sso/exchange` with invalid/expired code returns 401
- [ ] `GET /api/sso/config` returns decrypted SSO config for authenticated org admin
- [ ] `GET /api/sso/config` returns 401 for unauthenticated requests
- [ ] `PUT /api/sso/config` encrypts and stores SSO config
- [ ] `POST /api/sso/domains` returns verification token for new domain
- [ ] `POST /api/sso/domains/verify` returns verification result
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors

**Test Strategy**:

- Unit: Auth code consume logic
- Integration: Full route handler tests with seeded org data

**Rollback**: Delete new route files. Existing SSO callback flows unaffected.

### Phase 2: OIDC JWKS Signature Verification

**Goal**: Close GAP-001 by adding proper ID token signature verification via JWKS.

**Tasks**:
2.1. Create `jwks-verifier.ts` service with JWKS key fetching and caching
2.2. Update `oidc-service.ts` `validateIdToken` to use JWKS verification
2.3. Update OIDC callback to use verified ID token claims (not decoded-only)
2.4. Add `jose` dependency to Studio package.json (for `jwtVerify`, `createRemoteJWKSet`)
2.5. Add 10-second timeout to outbound OIDC fetch calls

**Files Touched**:

- `apps/studio/src/services/sso/jwks-verifier.ts` -- new: JWKS verification service
- `apps/studio/src/services/sso/oidc-service.ts` -- modify: replace decode-only with JWKS verify
- `apps/studio/src/app/api/sso/oidc/callback/route.ts` -- modify: use verified claims
- `apps/studio/package.json` -- modify: add `jose` dependency

**Exit Criteria**:

- [ ] OIDC callback verifies ID token signature against JWKS endpoint
- [ ] Invalid signatures are rejected with 401
- [ ] JWKS keys are cached (1 hour default, configurable)
- [ ] Outbound OIDC requests have 10-second timeout
- [ ] Existing OIDC flow still works end-to-end with mock provider
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors

**Test Strategy**:

- Unit: JWKS key fetch + cache, token verification with known keys
- Integration: OIDC callback with mock provider that serves JWKS

**Rollback**: Revert to decode-only validation (remove JWKS verifier import).

### Phase 3: Logging Standardization + Error Envelope

**Goal**: Fix GAP-003 and GAP-006 by standardizing logging and improving error responses across all SSO routes.

**Tasks**:
3.1. Replace `console.error`/`console.warn` with `createLogger('sso')` in SAML callback
3.2. Replace `console.error` with `createLogger('sso')` in SSO init route
3.3. Add structured error context to all SSO error responses
3.4. Add request ID forwarding to SSO error responses
3.5. Add max size guard (1000 entries) for in-memory SSO state Maps
3.6. Add max size guard for OIDC discovery document cache

**Files Touched**:

- `apps/studio/src/app/api/sso/saml/callback/route.ts` -- modify: replace console with logger
- `apps/studio/src/app/api/sso/init/route.ts` -- modify: replace console with logger
- `apps/studio/src/services/sso/sso-state-store.ts` -- modify: add Map size guards
- `apps/studio/src/services/sso/oidc-service.ts` -- modify: add discovery cache size guard

**Exit Criteria**:

- [ ] Zero `console.error` or `console.warn` calls in SSO route handlers
- [ ] All SSO routes use `createLogger('sso')` for structured logging
- [ ] In-memory Maps have max size of 1000 entries with LRU-like eviction
- [ ] OIDC discovery cache has max 100 entries
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors

**Test Strategy**:

- Unit: Map size guard eviction behavior
- Integration: Verify log output structure in SSO callback tests

**Rollback**: Revert logging changes. No functional impact.

### Phase 4: Unit Tests

**Goal**: Achieve 80% unit test coverage for SSO/MFA service logic.

**Tasks**:
4.1. Write OIDC PKCE tests (`oidc-pkce.test.ts`): code verifier/challenge generation, authorization URL construction
4.2. Write SSRF validation tests (`ssrf-validation.test.ts`): all URL patterns from IT-11
4.3. Write MFA TOTP tests (`mfa-totp.test.ts`): TOTP generation against known vectors, timing-safe comparison, recovery code hash/compare, MFA enforcement logic
4.4. Write SSO encryption tests: encrypt/decrypt round-trip, plaintext fallback

**Files Touched**:

- `apps/studio/src/__tests__/unit/oidc-pkce.test.ts` -- new
- `apps/studio/src/__tests__/unit/ssrf-validation.test.ts` -- new
- `apps/studio/src/__tests__/unit/mfa-totp.test.ts` -- new
- `apps/studio/src/__tests__/unit/sso-encryption.test.ts` -- new

**Exit Criteria**:

- [ ] All unit tests pass: `pnpm test --filter=studio -- --testPathPattern='unit/(oidc-pkce|ssrf-validation|mfa-totp|sso-encryption)'`
- [ ] TOTP tests verify at least 3 known time-based test vectors
- [ ] SSRF tests cover: HTTPS valid, HTTP reject, localhost, 127.0.0.1, private 10.x, private 172.x, private 192.168.x, link-local 169.254.x, IPv6 mapped
- [ ] Recovery code tests verify single-use, case insensitivity, bcrypt round-trip

**Test Strategy**: Pure unit tests, no external dependencies.

**Rollback**: Delete test files. No production impact.

### Phase 5: Integration Tests

**Goal**: Test SSO flows with mock IdPs and real service boundaries.

**Tasks**:
5.1. Write SSO state store integration tests: Redis and in-memory modes, TTL expiry, atomic consume
5.2. Write domain verification integration tests: claim, verify (mocked DNS), conflict detection
5.3. Write MFA enforcement integration tests: plan-gated enforcement, recovery code lifecycle, lockout
5.4. Write auth code exchange integration tests: single-use, TTL expiry, concurrent consume

**Files Touched**:

- `apps/studio/src/__tests__/integration/sso-state-store.test.ts` -- new
- `apps/studio/src/__tests__/integration/domain-verification.test.ts` -- new
- `apps/studio/src/__tests__/integration/mfa-enforcement.test.ts` -- new
- `apps/studio/src/__tests__/integration/auth-code-exchange.test.ts` -- new

**Exit Criteria**:

- [ ] All integration tests pass: `pnpm test --filter=studio -- --testPathPattern='integration/(sso-state|domain-verification|mfa-enforcement|auth-code)'`
- [ ] State store tests cover: set/get/consume/expire for all 3 state types (SAML assertion, OIDC state, auth code)
- [ ] Domain tests cover: claim, verify success, verify failure, conflict, normalization
- [ ] MFA tests cover: setup, confirm, verify, lockout, recovery, regenerate
- [ ] Auth code tests cover: store, consume, re-consume (null), TTL expiry

**Test Strategy**: Integration with MongoMemoryServer. DNS mocked via module mock. Redis optional (in-memory fallback for CI).

**Rollback**: Delete test files. No production impact.

### Phase 6: Force-SSO and Admin Portal Foundations

**Goal**: Implement force-SSO enforcement on login and prepare admin portal SSO management.

**Tasks**:
6.1. Add force-SSO check to email/password login route: if user's org has `forceSso: true`, reject login with SSO redirect hint
6.2. Add `allowGoogleFallback` check to Google OAuth route
6.3. Add SSO status field to admin organization list API
6.4. Add SSO config read endpoint for admin portal (super-admin only)

**Files Touched**:

- `apps/studio/src/app/api/auth/login/route.ts` -- modify: add force-SSO check
- `apps/studio/src/app/api/auth/google/callback/route.ts` -- modify: add Google fallback check
- `apps/admin/src/app/api/tenants/[tenantId]/route.ts` -- modify: include SSO status
- `apps/studio/src/services/sso/domain-service.ts` -- modify: add `lookupUserOrgSSOPolicy` helper

**Exit Criteria**:

- [ ] Email/password login returns 403 with `{ error: "SSO required", ssoEnabled: true }` for force-SSO orgs
- [ ] Google OAuth login is blocked when `allowGoogleFallback: false` for force-SSO orgs
- [ ] Admin tenant detail includes SSO status (enabled/disabled, protocol)
- [ ] Non-force-SSO orgs are unaffected by force-SSO checks
- [ ] `pnpm build --filter=studio --filter=admin` succeeds with 0 type errors

**Test Strategy**:

- Integration: Force-SSO login block test, Google fallback block test
- E2E: Full force-SSO scenario (E2E-6 from test spec)

**Rollback**: Remove force-SSO check from login route. Users can log in with email/password again.

---

## 4. Wiring Checklist

- [ ] New route files (`exchange`, `config`, `domains`, `domains/verify`) are in correct Next.js app router directory structure (auto-registered)
- [ ] `jwks-verifier.ts` is imported and called from `oidc-service.ts` `validateIdToken`
- [ ] `jose` package added to `apps/studio/package.json` dependencies
- [ ] `createLogger('sso')` imported from `@abl/compiler/platform` in all modified SSO routes
- [ ] Force-SSO check added to login route middleware chain (before password verification, after email lookup)
- [ ] Force-SSO check added to Google OAuth callback (before user creation/update)
- [ ] Admin API SSO status query added to tenant detail response
- [ ] All new test files are in directories matched by vitest config include patterns
- [ ] Environment variables documented in `.env.example` for `ENCRYPTION_MASTER_KEY`

---

## 5. Cross-Phase Concerns

### Database Migrations

No database migrations required. All data model changes use existing Organization and User document schemas that already support `ssoConfigs[]`, `domainMappings[]`, and `mfa` subdocuments.

### Feature Flags

No feature flags needed. SSO is opt-in per organization (admin configures SSO to enable it). Force-SSO is opt-in per org setting.

### Configuration Changes

| Config Key                     | Phase   | Description                                   |
| ------------------------------ | ------- | --------------------------------------------- |
| `auth.sso.authCodeTtlSeconds`  | Phase 1 | Auth code TTL (already in config)             |
| `auth.sso.oidcStateTtlSeconds` | Phase 1 | OIDC state TTL (already in config)            |
| `auth.sso.jwksCacheTtlMs`      | Phase 2 | JWKS cache TTL (new, default 3600000)         |
| `auth.sso.fetchTimeoutMs`      | Phase 2 | Outbound request timeout (new, default 10000) |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with exit criteria met
- [ ] E2E scenarios E2E-1 through E2E-7 from test spec are passing
- [ ] Integration scenarios IT-1 through IT-12 from test spec are passing
- [ ] Unit tests achieve 80% line coverage for `services/sso/` and `services/auth/`
- [ ] No regressions in existing auth tests (`shared-auth`, `auth-enterprise`)
- [ ] `pnpm build` succeeds for all affected packages
- [ ] `pnpm test` passes for `studio`, `shared-auth`, `auth-enterprise`
- [ ] Feature spec updated with implementation details (file paths, test coverage)
- [ ] Testing matrix updated with actual coverage status
- [ ] OIDC JWKS verification working (GAP-001 closed)
- [ ] Consistent logging across all SSO routes (GAP-003, GAP-006 closed)
- [ ] SSO config management routes operational (GAP-008 closed)
- [ ] Force-SSO enforcement working

---

## 7. Open Questions

1. Should `jose` library be added to `packages/shared-auth` or kept in `apps/studio`? Decision: keep in Studio (JWKS verification is an SSO concern, not a general auth middleware concern).
2. Should auth code exchange support CORS for cross-origin SSO callbacks? Decision: not needed -- callback and exchange happen on the same origin (Studio).
3. Should Phase 6 force-SSO check resolve the user's organization before checking SSO policy? Decision: yes -- lookup user email domain, then check org SSO config.
4. What is the test database strategy for integration tests? Decision: MongoMemoryServer for CI, Docker MongoDB for local dev.
5. Should the admin portal SSO management be a separate LLD? Decision: defer to a sub-feature LLD -- this LLD covers the backend API only.

---

## 8. Post-Implementation Notes (2026-04-14)

### Phase Progress

| Phase | Description                               | Status      | Notes                                                   |
| ----- | ----------------------------------------- | ----------- | ------------------------------------------------------- |
| 1     | Missing Route Implementations + Auth Code | NOT STARTED | GAP-008 remains open                                    |
| 2     | OIDC JWKS Signature Verification          | NOT STARTED | GAP-001 remains open                                    |
| 3     | Logging Standardization + Error Envelope  | NOT STARTED | GAP-003, GAP-006 remain open                            |
| 4     | Unit Tests                                | NOT STARTED | Planned unit test files not created                     |
| 5     | Integration Tests                         | NOT STARTED | Planned integration test files not created              |
| 6     | Force-SSO and Admin Portal Foundations    | PARTIAL     | Admin auth handoff implemented (ABLP-346), no force-SSO |

### ABLP-346: Platform Auth Handoff (out-of-plan addition)

ABLP-346 added platform auth handoff and social login support in the admin service. This was not in the original 6-phase plan but addresses Phase 6 partially -- admin can now authenticate via Studio's auth system (email/password, Google, Microsoft, SSO).

**Files added (not in original plan):**

- `apps/admin/src/app/api/auth/login/route.ts` -- email/password login proxy
- `apps/admin/src/app/api/auth/google/route.ts` -- Google OAuth redirect
- `apps/admin/src/app/api/auth/microsoft/route.ts` -- Microsoft OAuth redirect
- `apps/admin/src/app/api/auth/sso/route.ts` -- SSO init redirect
- `apps/admin/src/app/api/auth/studio/callback/route.ts` -- Studio callback handler
- `apps/admin/src/lib/admin-auth-redirect.ts` -- URL builders
- `apps/admin/src/lib/studio-admin-auth.ts` -- Session payload, super-admin validation
- `apps/studio/src/lib/admin-auth-handoff.ts` -- Cross-app auth handoff utilities

**Files modified (in original plan but for different reasons):**

- `apps/studio/src/app/api/sso/init/route.ts` -- added `mode=redirect` and `admin_redirect` params
- `apps/studio/src/app/api/sso/oidc/callback/route.ts` -- admin redirect cookie support
- `apps/studio/src/app/api/sso/saml/callback/route.ts` -- admin redirect via relay state
- `apps/studio/src/lib/sso-state-store.ts` -- admin redirect metadata in OIDC state
- `apps/studio/src/services/auth-service.ts` -- extended token context
- `apps/studio/src/services/sso/sso-state-store.ts` -- admin redirect storage

**Remaining for Phase 6 completion:**

- Force-SSO login block on email/password route
- `allowGoogleFallback` check on Google OAuth route
- Admin SSO config management UI
