# HLD: SSO / Enterprise Auth

**Feature Spec**: `../features/sso-enterprise-auth.md`
**Test Spec**: `../testing/sso-enterprise-auth.md`
**Status**: ALPHA
**Last Updated**: 2026-04-14

---

## 1. Problem Statement

Enterprise customers require federated authentication through corporate identity providers (SAML 2.0 / OIDC), organization-level MFA enforcement, and domain-based SSO routing. The existing platform auth (`@agent-platform/shared-auth`) supports JWT, SDK session tokens, and API keys but has no IdP integration for user login. Without SSO, enterprise users maintain separate credentials, IT admins cannot enforce centralized security policies, and the platform fails SOC 2/ISO 27001 requirements for centralized identity management.

The SSO subsystem must integrate into the existing unified auth middleware pipeline, reuse the RBAC permission resolver, and work with the tenant/organization/user hierarchy. Implementation is partially complete: SAML/OIDC services, state store, callback routes, and MFA service exist in `apps/studio`, but several routes are stubs, OIDC lacks JWKS signature verification, and no E2E tests cover the flows.

---

## 2. Alternatives Considered

### Alternative A: External Identity Service (Auth0 / Clerk)

**Description:** Delegate all SSO, MFA, and user management to an external SaaS identity provider.

**Pros:**

- Immediate compliance certifications (SOC 2, HIPAA)
- Maintained SAML/OIDC libraries and MFA implementations
- Reduced engineering effort for auth features

**Cons:**

- Per-user SaaS pricing at enterprise scale (potentially $50K-200K/year)
- Loss of control over auth flow customization (force-SSO, domain routing)
- Data residency concerns for enterprise customers
- Additional external dependency and latency
- Migration complexity from existing JWT-based auth

**Effort:** S (integration) but ongoing cost

### Alternative B: Native SSO with Dedicated Auth Service (Microservice)

**Description:** Extract all auth logic (SSO, MFA, user management) into a standalone microservice with its own API, separate from Studio.

**Pros:**

- Clean separation of concerns
- Independent scaling of auth service
- Reusable across multiple platform apps

**Cons:**

- Significant refactoring: auth routes, repos, services all currently in Studio
- New service to deploy, monitor, and maintain
- Inter-service communication overhead for every auth check
- Existing Studio routes tightly coupled to auth-repo and auth-service

**Effort:** L

### Alternative C: Native SSO Integrated in Studio (Current Architecture) -- RECOMMENDED

**Description:** Continue building SSO within the Studio application, leveraging existing services (`sso/`, `auth/`), repos (`org-repo`, `mfa-repo`, `auth-repo`), and the shared-auth middleware package. Extract reusable auth logic to `@agent-platform/shared-auth` and `@agent-platform/auth-enterprise` packages.

**Pros:**

- Builds on existing implementation (SAML/OIDC services, state store, MFA already exist)
- No new service deployment; reuses Studio's MongoDB connection and Redis
- Shared-auth middleware already consumed by Runtime, Admin, and Studio
- Incremental hardening (JWKS verification, consistent logging) without architectural disruption
- No per-user SaaS cost

**Cons:**

- Auth logic remains in Studio monolith (not independently scalable)
- Studio restart affects auth availability
- Testing requires Studio server setup for E2E

**Effort:** M

### Recommendation

**Alternative C** (Native SSO in Studio). The implementation is 60-70% complete. The remaining work is hardening (JWKS verification, consistent logging, missing route implementations), test coverage, and configuration management. The architectural overhead of extracting a standalone auth service (Alternative B) is not justified given that Studio is already the auth entry point and the shared-auth package provides cross-app middleware. The external SaaS option (Alternative A) introduces cost and control concerns that conflict with enterprise customer requirements.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          External Systems                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  SAML IdP    │  │  OIDC IdP    │  │  DNS (TXT verification) │  │
│  │  (Okta/ADFS) │  │  (Azure AD)  │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬──────────────┘  │
└─────────┼──────────────────┼─────────────────────┼──────────────────┘
          │                  │                     │
          │ SAML Assertion   │ Auth Code + Token   │ DNS TXT Lookup
          │ (POST)           │ Exchange (HTTPS)    │
          ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Studio (Next.js)                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   SSO Route Handlers                         │    │
│  │  /api/sso/init     /api/sso/saml/callback                   │    │
│  │  /api/sso/oidc/callback  /api/sso/exchange                  │    │
│  │  /api/sso/config   /api/sso/domains/*                       │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                              │                                       │
│  ┌───────────────┐  ┌───────┴───────┐  ┌────────────────────┐      │
│  │ SSO Services  │  │ Auth Service  │  │ MFA Service        │      │
│  │ saml-service  │  │ JWT, tokens   │  │ TOTP, recovery     │      │
│  │ oidc-service  │  │ tenant ctx    │  │ lockout            │      │
│  │ domain-service│  │               │  │                    │      │
│  └───────┬───────┘  └───────┬───────┘  └────────┬───────────┘      │
│          │                  │                    │                    │
│  ┌───────┴──────────────────┴────────────────────┴───────────┐      │
│  │                    Repository Layer                        │      │
│  │  org-repo (Organization, SSOConfig, DomainMapping)        │      │
│  │  auth-repo (User, RefreshToken, TenantMember)             │      │
│  │  mfa-repo (User.mfa subdocument)                          │      │
│  └───────┬──────────────────┬────────────────────────────────┘      │
│          │                  │                                        │
│  ┌───────┴───────┐  ┌──────┴──────┐                                │
│  │   MongoDB     │  │   Redis     │                                │
│  │ Organizations │  │ SSO State   │                                │
│  │ Users         │  │ OIDC State  │                                │
│  │ TenantMembers │  │ Auth Codes  │                                │
│  └───────────────┘  └─────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
          │
          │ JWT Token (Bearer)
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Consuming Services                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Runtime    │  │    Admin     │  │   Studio     │              │
│  │ shared-auth  │  │ shared-auth  │  │ shared-auth  │              │
│  │ middleware   │  │ middleware   │  │ middleware   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
@agent-platform/shared-auth (cross-app middleware)
├── middleware/
│   ├── unified-auth.ts          ← Auth flow dispatcher
│   ├── jwt-verify.ts            ← JWT decode/verify
│   ├── auth-context-bridge.ts   ← TenantContextData → AuthContext
│   ├── permission-guard.ts      ← Permission check middleware
│   ├── session-ownership.ts     ← Session owner check
│   └── tenant-context.ts        ← AsyncLocalStorage context
├── rbac/
│   └── permission-resolver.ts   ← Role → permissions resolution
└── types/
    ├── auth-context.ts          ← Discriminated union types
    └── express.d.ts             ← Express type augmentation

@agent-platform/auth-enterprise (enterprise auth types)
├── saml-auth.ts                 ← SAML 2.0 for tool auth
├── digest-auth.ts               ← HTTP Digest auth
├── kerberos-auth.ts             ← Kerberos auth
├── hawk-auth.ts                 ← Hawk auth
└── ws-security-auth.ts          ← WS-Security auth

apps/studio (SSO implementation)
├── services/sso/
│   ├── sso-types.ts             ← SSO type definitions
│   ├── sso-state-store.ts       ← Redis/in-memory hybrid state
│   ├── oidc-service.ts          ← OIDC PKCE flow
│   ├── saml-service.ts          ← SAML SP operations
│   └── domain-service.ts        ← Domain claim/verification
├── services/auth/
│   ├── mfa-service.ts           ← TOTP + recovery codes
│   └── password-service.ts      ← Password policy
├── services/auth-service.ts     ← JWT, tokens, tenant context
├── repos/
│   ├── org-repo.ts              ← Organization CRUD
│   ├── mfa-repo.ts              ← MFA subdocument CRUD
│   └── auth-repo.ts             ← User/token CRUD
└── app/api/sso/                 ← SSO route handlers
```

### Data Flow: SAML SP-Initiated Login

```
User          Studio Frontend          Studio API                 SAML IdP         Redis/Memory
  │                │                      │                         │                   │
  │  Enter email   │                      │                         │                   │
  ├───────────────>│                      │                         │                   │
  │                │  GET /api/sso/init   │                         │                   │
  │                ├─────────────────────>│                         │                   │
  │                │                      │ lookupDomainOrg(domain) │                   │
  │                │                      │ findSSOConfig(orgId)    │                   │
  │                │                      │ decryptSSOConfig(...)   │                   │
  │                │  { redirectUrl }     │                         │                   │
  │                │<─────────────────────│                         │                   │
  │  Redirect      │                      │                         │                   │
  │<───────────────│                      │                         │                   │
  │  AuthnRequest  │                      │                         │                   │
  ├─────────────────────────────────────────────────────────────────>│                   │
  │                │                      │                         │ Authenticate      │
  │  SAML Assertion│                      │                         │                   │
  │<────────────────────────────────────────────────────────────────│                   │
  │                │                      │                         │                   │
  │  POST /api/sso/saml/callback          │                         │                   │
  ├──────────────────────────────────────>│                         │                   │
  │                │                      │ validatePostResponse()  │                   │
  │                │                      │ replayProtection()      │                   │
  │                │                      │──────────────────────────────────────────────>│
  │                │                      │ findOrCreateUser()      │                   │
  │                │                      │ createTokenPair()       │                   │
  │                │                      │ storeAuthCode()         │                   │
  │                │                      │──────────────────────────────────────────────>│
  │  302 /auth/callback?code=<code>       │                         │                   │
  │<──────────────────────────────────────│                         │                   │
  │                │                      │                         │                   │
  │  POST /api/sso/exchange { code }      │                         │                   │
  ├──────────────────────────────────────>│                         │                   │
  │                │                      │ consumeAuthCode(code)   │                   │
  │                │                      │<─────────────────────────────────────────────│
  │  { accessToken, refreshToken }        │                         │                   │
  │<──────────────────────────────────────│                         │                   │
```

### Data Flow: MFA Verification (Post-Login)

```
User          Studio Frontend          Studio API
  │                │                      │
  │  Login         │                      │
  ├───────────────>│  POST /api/auth/login│
  │                ├─────────────────────>│
  │                │                      │ verifyPassword()
  │                │                      │ isMFARequired() → true
  │                │  { mfaRequired, partialToken }
  │                │<─────────────────────│
  │  Enter TOTP    │                      │
  ├───────────────>│  POST /api/auth/mfa/verify
  │                ├─────────────────────>│
  │                │                      │ verifyMFACode()
  │                │                      │ createTokenPair() ← full token
  │                │  { accessToken, refreshToken }
  │                │<─────────────────────│
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

SSO configuration is scoped to the Organization, which sits above Tenants in the hierarchy. Domain mappings are globally unique (enforced by `{ 'domainMappings.domain': 1 }` unique sparse index). Cross-org SSO config access is prevented by the org-repo layer, which queries by `_id = organizationId`. The SAML callback resolves org from RelayState or SAML issuer -- never from user-supplied headers.

**Key invariant:** `findSSOConfig(orgId)` always scopes to the specific org. The OIDC callback validates the `state` parameter against stored state that includes the `orgId`, preventing cross-org token exchange.

#### 2. Data Access Pattern

Repository pattern is used consistently:

- `org-repo.ts`: Organization, SSOConfig (embedded array), DomainMapping (embedded array)
- `mfa-repo.ts`: User.mfa subdocument
- `auth-repo.ts`: User, RefreshToken, TenantMember

SSO config is stored as encrypted JSON in the Organization document's `ssoConfigs[]` array. Domain mappings are embedded in `domainMappings[]`. This avoids join queries but limits config to one active SSO per org.

Caching: Permission resolver caches per `tenantId:userId` with 60s TTL. OIDC discovery documents cached for 1 hour per issuer. No caching for SSO config lookups (they're infrequent).

#### 3. API Contract

**Request/Response shapes:**

SSO Init:

```json
// GET /api/sso/init?email=user@corp.com
// Response:
{ "ssoEnabled": true, "protocol": "saml", "redirectUrl": "https://idp.example.com/..." }
// or:
{ "ssoEnabled": false, "message": "No SSO configured for this domain." }
```

Auth Code Exchange:

```json
// POST /api/sso/exchange
// Request:
{ "code": "<one-time-code>" }
// Response:
{ "accessToken": "<jwt>", "refreshToken": "<hex>", "expiresIn": 900,
  "needsOnboarding": false, "pendingInvitationChoice": false }
```

MFA Setup:

```json
// POST /api/auth/mfa/setup
// Response:
{ "secret": "<base32>", "otpauthUrl": "otpauth://totp/...", "recoveryCodes": ["ABC12345", ...] }
```

**Error envelope:** Studio Next.js routes return `{ error: "<message>" }` with HTTP status. This is inconsistent with the platform standard `{ success: false, error: { code, message } }` -- logged as a concern for future normalization.

**Versioning:** No API versioning on SSO routes. Routes are under `/api/sso/` and `/api/auth/mfa/`.

#### 4. Security Surface

- **SAML signature verification**: Uses `@node-saml/node-saml` with IdP X.509 certificate. `wantAssertionsSigned: true`.
- **OIDC token exchange**: Uses HTTPS with SSRF validation on outbound URLs. `redirect: 'error'` prevents open redirects.
- **OIDC ID token**: Currently decoded without JWKS signature verification (GAP-001). This is the highest-priority security gap.
- **SSO config encryption**: `EncryptionService.encryptForTenant(config, orgId)`. Master key required in production.
- **CSRF protection**: OIDC state parameter with random UUID, stored in Redis, consumed atomically via GETDEL.
- **Replay protection**: SAML assertion IDs tracked with TTL.
- **Auth code**: 32-byte random, 60s TTL, single-use via GETDEL atomicity.
- **MFA**: Timing-safe TOTP comparison, bcrypt-hashed recovery codes, configurable lockout.
- **Input validation**: Email regex validation on all SSO endpoints. SAML issuer validation via regex.

### Behavioral Concerns

#### 5. Error Model

| Scenario               | User Experience                            | Recovery                                       |
| ---------------------- | ------------------------------------------ | ---------------------------------------------- |
| IdP unavailable        | "SSO authentication failed" (401)          | Retry or use email/password (if not force-SSO) |
| Invalid SAML signature | "SAML assertion validation failed" (401)   | Contact IT admin to check IdP certificate      |
| OIDC state mismatch    | "Invalid or expired state parameter" (403) | Re-initiate SSO flow                           |
| MFA lockout            | "MFA temporarily locked" (403)             | Wait for lockout duration or use recovery code |
| Encryption unavailable | MFA setup fails with 503                   | Set ENCRYPTION_MASTER_KEY env var              |
| SSO config missing     | "SSO misconfigured" (ssoEnabled: false)    | Admin configures SSO in org settings           |
| Domain not verified    | SSO init returns ssoEnabled: false         | Admin verifies domain via DNS TXT              |

#### 6. Failure Modes

- **Redis unavailable**: SSO state store falls back to in-memory Maps with periodic cleanup. This is single-pod only -- in a multi-pod deployment, users may get "Invalid or expired state parameter" if the callback hits a different pod than the one that stored the state. Mitigation: sticky sessions or require Redis in production.
- **MongoDB unavailable**: All auth operations fail. No circuit breaker on auth routes.
- **IdP timeout**: Token exchange or userinfo fetch times out. Currently no explicit timeout set on `fetch()` calls -- uses Node.js default. Recommendation: add 10s timeout.
- **Concurrent SSO login**: Two tabs initiating SSO for same user. OIDC state is per-flow (different state values), so both can complete. Auth code is per-flow. No race condition.
- **Partial failure**: SAML callback succeeds but auth code storage fails. User gets a server error. No retry mechanism -- user must re-initiate SSO.

#### 7. Idempotency

- **SSO login**: Idempotent in terms of user provisioning (findOrCreate by email). Non-idempotent in terms of tokens (new token pair each time).
- **Auth code exchange**: Strictly non-idempotent (single-use). Second attempt returns null/error.
- **Domain claim**: Idempotent for same org (upsert). Rejected for different org if already claimed.
- **MFA setup**: Non-idempotent if MFA already verified (returns error).
- **MFA verify**: Idempotent (repeated valid codes succeed until lockout).

#### 8. Observability

- **Auth events**: `AuthEvent` emitted via `onAuthEvent` callback with outcome, authType, userId, tenantId, IP, userAgent, requestId, failure reason.
- **Logging**: Inconsistent -- OIDC callback uses `createLogger('auth-sso')`, SAML callback uses `console.error`. Recommendation: standardize on `createLogger` across all SSO routes.
- **Metrics to add**: SSO login success/failure rate, MFA enrollment rate, auth code exchange latency, IdP response time.
- **Debug entry points**: Auth events provide sufficient data for diagnosing login failures. MFA lockout state visible via `getMFAStatus`. SSO config decryption failures logged.

### Operational Concerns

#### 9. Performance Budget

| Operation                                 | Target (p99) | Current Estimate                    |
| ----------------------------------------- | ------------ | ----------------------------------- |
| SSO init (domain lookup)                  | < 50ms       | ~10ms (MongoDB query)               |
| SAML callback (signature verification)    | < 500ms      | ~200ms (XML parsing + signature)    |
| OIDC callback (token exchange + userinfo) | < 2000ms     | ~500-1500ms (2 external HTTP calls) |
| Auth code exchange                        | < 100ms      | ~20ms (Redis GETDEL + response)     |
| MFA TOTP verification                     | < 50ms       | ~5ms (HMAC computation)             |
| Permission resolution (cached)            | < 5ms        | ~1ms (Map lookup)                   |
| Permission resolution (uncached)          | < 100ms      | ~30ms (MongoDB query)               |

**Payload limits:** SAML assertions can be large (10-100KB). No explicit size limit on SAML POST body. Recommendation: add 256KB limit.

#### 10. Migration Path

**Current state:** Partially implemented. SAML/OIDC services, state store, callback routes, and MFA service exist. Several routes are stubs. No E2E tests.

**Target state:** Fully hardened SSO with JWKS verification, all routes implemented, consistent logging, comprehensive test coverage.

**Migration steps:**

1. Implement missing routes (`/api/sso/config`, `/api/sso/domains/*`, `/api/sso/exchange`)
2. Add OIDC JWKS signature verification
3. Standardize logging and error envelopes
4. Add E2E and integration tests
5. Add admin portal SSO management pages

**Data migration:** None required. Existing Organization documents with `ssoConfigs` and `domainMappings` arrays are backward-compatible.

#### 11. Rollback Plan

- **SSO routes**: Disable via feature flag or remove route files. Users fall back to email/password or OAuth login.
- **MFA enforcement**: Set `requireMfa: false` on org settings and update plan-level checks. Users skip MFA step.
- **Domain mappings**: Domain mappings persist in MongoDB but are inert if SSO config is deactivated (`isActive: false`).
- **State store data**: Redis keys expire naturally (TTL-based). In-memory data lost on restart.
- **User accounts**: SSO-provisioned users retain their accounts with email/password or OAuth login available.

No schema migrations are required, so rollback is purely at the application layer.

#### 12. Test Strategy

| Layer       | Coverage Target   | What Gets Tested                                                                              |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Unit        | 80% line coverage | TOTP generation, PKCE, SSRF validation, domain normalization, password validation             |
| Integration | 70%               | SAML/OIDC callbacks with mock IdPs, state store operations, MFA lifecycle, auth code exchange |
| E2E         | 7 scenarios       | Full SSO login flows (SAML + OIDC), MFA enforcement, force-SSO, tenant context                |
| Manual      | 2 scenarios       | DNS TXT verification with real DNS, IdP integration with real Okta/Azure AD                   |

See `../testing/sso-enterprise-auth.md` for detailed scenarios.

---

## 5. Data Model

### Existing Collections (Modified)

**Organization** (`organizations`):

- `ssoConfigs[]` -- embedded array of SSO configurations
  - `id: string` (uuidv7)
  - `protocol: 'saml' | 'oidc'`
  - `encryptedConfig: string` (JSON encrypted via EncryptionService)
  - `idpEntityId: string` (for SAML IdP-initiated lookup)
  - `forceSso: boolean`
  - `allowGoogleFallback: boolean`
  - `isActive: boolean`
  - `createdAt: Date`
  - `updatedAt: Date`
- `domainMappings[]` -- embedded array of domain claims
  - `id: string` (uuidv7)
  - `domain: string` (lowercase, unique sparse index)
  - `verified: boolean`
  - `verificationToken: string`
  - `verifiedAt: Date | null`
  - `createdAt: Date`

**User** (`users`):

- `mfa` -- embedded subdocument
  - `encryptedSecret: string`
  - `verified: boolean`
  - `enabledAt: Date | null`
  - `lastUsedAt: Date | null`
  - `failedAttempts: number`
  - `lockedUntil: Date | null`
  - `recoveryCodes: Array<{ codeHash, createdAt, usedAt }>`

### Ephemeral State (Redis / In-Memory)

| Key Pattern               | Purpose                               | TTL    |
| ------------------------- | ------------------------------------- | ------ |
| `sso:saml:assertion:<id>` | SAML assertion replay protection      | 1 hour |
| `sso:oidc:state:<state>`  | OIDC CSRF state + PKCE verifier       | 10 min |
| `sso:auth-code:<code>`    | One-time auth code for token exchange | 60 sec |

---

## 6. API Design

### Existing Endpoints (Implemented)

| Method | Path                     | Auth                       | Purpose                          |
| ------ | ------------------------ | -------------------------- | -------------------------------- |
| GET    | `/api/sso/init`          | None                       | Detect SSO for email domain      |
| GET    | `/api/sso/oidc/callback` | None (state-validated)     | OIDC authorization code callback |
| POST   | `/api/sso/saml/callback` | None (signature-validated) | SAML assertion callback          |

### Endpoints to Implement

| Method | Path                       | Auth            | Purpose                                |
| ------ | -------------------------- | --------------- | -------------------------------------- |
| POST   | `/api/sso/exchange`        | None            | Exchange one-time auth code for tokens |
| GET    | `/api/sso/config`          | JWT (org admin) | Get SSO config for current org         |
| PUT    | `/api/sso/config`          | JWT (org admin) | Create/update SSO config               |
| DELETE | `/api/sso/config`          | JWT (org admin) | Delete SSO config                      |
| GET    | `/api/sso/domains`         | JWT (org admin) | List domains for org                   |
| POST   | `/api/sso/domains`         | JWT (org admin) | Claim a domain                         |
| POST   | `/api/sso/domains/verify`  | JWT (org admin) | Verify domain ownership                |
| DELETE | `/api/sso/domains/:domain` | JWT (org admin) | Remove domain claim                    |

### Error Responses

| Status | Code                | When                                                  |
| ------ | ------------------- | ----------------------------------------------------- |
| 400    | Bad Request         | Invalid email, missing params, already claimed domain |
| 401    | Unauthorized        | Invalid/expired token, SAML/OIDC validation failure   |
| 403    | Forbidden           | CSRF state mismatch, MFA lockout, force-SSO block     |
| 404    | Not Found           | Cross-org access to SSO config                        |
| 501    | Not Implemented     | SAML config missing certificate                       |
| 503    | Service Unavailable | Redis/encryption service unavailable                  |

---

## 7. Cross-Cutting Concerns

### Audit Logging

Auth events should be emitted for:

- SSO login success/failure (authType, userId, tenantId, IP, provider)
- MFA setup/verify/disable events
- Domain claim/verify events
- SSO config create/update/delete events
- Force-SSO login blocks

Currently uses the `onAuthEvent` callback in unified-auth. SSO-specific events (domain, config) need a separate audit mechanism or extension of AuthEvent.

### Rate Limiting

- Login endpoints: configurable rate limit (default 10/15min per IP)
- SSO init: no rate limit (read-only, no auth)
- MFA verify: protected by lockout mechanism (10 failed attempts = 30min lock)
- Auth code exchange: implicit rate limit via single-use codes

### Caching

| What                  | Strategy                      | TTL    | Invalidation             |
| --------------------- | ----------------------------- | ------ | ------------------------ |
| OIDC discovery docs   | In-memory Map per issuer      | 1 hour | Natural expiry           |
| Permission resolution | In-memory Map per tenant+user | 60 sec | `clearPermissionCache()` |
| SSO config            | Not cached                    | N/A    | N/A (infrequent reads)   |
| Domain mappings       | Not cached                    | N/A    | N/A (infrequent reads)   |

### Encryption

- SSO config: `EncryptionService.encryptForTenant(JSON.stringify(config), orgId)` / `decryptForTenant`
- MFA TOTP secret: `EncryptionService.encrypt(secret, userId)` / `decrypt`
- Both fall back to plaintext in development when `ENCRYPTION_MASTER_KEY` is not set
- Passwords: bcrypt hashed (not encrypted)
- Recovery codes: bcrypt hashed (not encrypted)

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                                      | Risk                                    | Mitigation                                                                |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `@node-saml/node-saml`                          | Medium (optional peer dep)              | Stub assertion fallback in saml-auth.ts; real validation in saml callback |
| `@agent-platform/shared/encryption`             | High (required for production)          | Dev fallback with prefix markers                                          |
| Redis                                           | Medium (required for distributed state) | In-memory fallback (single-pod limitation)                                |
| MongoDB                                         | High (required for all auth operations) | No fallback -- auth fails if DB is down                                   |
| `@agent-platform/database` (Organization model) | Low (stable)                            | Model already includes ssoConfigs/domainMappings schemas                  |

### Downstream (Depends on This Feature)

| Consumer                   | Impact | Notes                                                     |
| -------------------------- | ------ | --------------------------------------------------------- |
| Studio login flow          | High   | SSO detection, redirect, callback handling                |
| Admin portal               | Medium | SSO config management (planned)                           |
| Runtime / SearchAI / Admin | Low    | Consume JWTs issued after SSO -- no direct SSO dependency |
| Audit logging system       | Low    | Consumes auth events                                      |

---

## 9. Open Questions & Decisions Needed

1. **OIDC JWKS verification priority**: Should this block ALPHA release? Current risk: unverified ID tokens could be forged. Recommendation: block BETA, not ALPHA.
2. **Error envelope normalization**: Should SSO routes adopt the platform standard `{ success, error: { code, message } }` envelope? Current: `{ error: "<message>" }`.
3. **Multi-IdP support**: Should we plan the data model for multiple active SSO configs per org? Current model supports multiple configs in the array but only the first active one is used.
4. **Session management policies**: Should max session duration and idle timeout be configurable per org? Currently fixed by JWT expiry (15min access, 7d refresh).
5. **SCIM provisioning timeline**: When should SCIM 2.0 support be planned? It requires significant data model extensions (groups, sync state).

---

## 10. Post-Implementation Notes (2026-04-14)

### ABLP-346: Platform Auth Handoff and Social Login

**Scope:** Added admin portal authentication that delegates to Studio as the single auth authority. This was not in the original HLD plan but extends the SSO architecture.

**Architectural approach:** Rather than duplicating auth logic in the admin service, admin auth routes proxy all authentication through Studio's existing SSO, Google OAuth, and Microsoft OAuth endpoints. After Studio completes the auth flow and generates a one-time auth code, the admin callback route exchanges the code for tokens and creates an admin session.

**Key architectural additions:**

- Cross-app auth handoff pattern: Admin stores an admin redirect cookie in Studio's domain, and Studio callbacks redirect back to admin with the auth code
- SAML RelayState encoding extended to carry admin redirect metadata (base64url-encoded JSON)
- OIDC state store extended to store admin redirect URL alongside orgId
- Admin session uses HTTP-only cookies (`admin-session`, `admin-last-activity`) with super-admin JWT claim validation

**Deviations from original plan:**

- The HLD did not plan for admin portal as a separate auth consumer -- only Studio was considered as the auth entry point. The admin handoff pattern was added to avoid duplicating auth infrastructure in the admin service.
- Phase 6 of the LLD (Force-SSO and Admin Portal Foundations) was partially addressed -- admin can now authenticate via SSO, but force-SSO enforcement on the admin login route is not yet implemented.
- No E2E tests were added for the admin auth handoff flow; only unit tests with mocked dependencies exist.

**Open questions resolved:**

- Q: Should admin have its own auth or delegate to Studio? A: Delegate to Studio. Admin is a super-admin-only portal and all user accounts originate in Studio.

---

## 11. References

- Feature spec: `docs/features/sso-enterprise-auth.md`
- Test spec: `docs/testing/sso-enterprise-auth.md`
- Enterprise roadmap: `docs/enterprise/ENTERPRISE_ROADMAP.md`
- Enterprise gap analysis: `docs/enterprise/XO_ENTERPRISE_GAP_ANALYSIS.md`
- Shared auth package: `packages/shared-auth/`
- Auth enterprise package: `packages/auth-enterprise/`
- Studio SSO services: `apps/studio/src/services/sso/`
- Studio auth services: `apps/studio/src/services/auth/`
- Organization model: `packages/database/src/models/organization.model.ts`
