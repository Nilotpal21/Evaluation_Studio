# Feature: SSO / Enterprise Auth

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `enterprise`, `governance`, `admin operations`
**Package(s)**: `@agent-platform/shared-auth`, `@agent-platform/auth-enterprise`, `@agent-platform/database`, `apps/studio`, `apps/admin`
**Owner(s)**: `platform-auth`
**Testing Guide**: `../testing/sso-enterprise-auth.md`
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

Enterprise customers require centralized identity management through their existing identity providers (IdPs). Without SSO, each user must maintain a separate email/password credential in the platform, creating security gaps (credential reuse, no centralized revocation), compliance failures (SOC 2, ISO 27001 mandate centralized IdM), and operational overhead for IT admins managing hundreds of platform users. Additionally, enterprises require MFA enforcement at the organization level, domain ownership verification for SSO routing, and session management policies aligned with their security posture.

### Goal Statement

Provide a complete enterprise authentication subsystem that supports SAML 2.0 and OIDC single sign-on, organization-level MFA enforcement, verified domain-to-org routing, SCIM-ready user provisioning hooks, and session policy controls -- all integrated with the existing unified auth middleware and RBAC permission system.

### Summary

SSO/Enterprise Auth extends the platform's existing JWT-based authentication (`@agent-platform/shared-auth`) with federated identity flows. An organization admin configures SSO (SAML 2.0 or OIDC) via Studio, claims and verifies email domains via DNS TXT records, and optionally enforces MFA for all org members. When a user logs in with an SSO-mapped email domain, the platform redirects them through the IdP, validates the assertion/token, provisions or matches the user account, and issues a standard JWT with tenant context. The feature reuses the existing `createUnifiedAuthMiddleware` pipeline and RBAC resolver -- SSO is a new identity source, not a replacement for the auth framework.

---

## 2. Scope

### Goals

- **G-1**: Support SAML 2.0 SP-initiated and IdP-initiated SSO flows with XML signature verification via `@node-saml/node-saml`
- **G-2**: Support OIDC Authorization Code + PKCE flow with ID token and UserInfo validation
- **G-3**: Organization-level MFA enforcement (TOTP + recovery codes) with plan-gated policies (BUSINESS+ require MFA)
- **G-4**: DNS TXT-based domain ownership verification for email-domain-to-org routing
- **G-5**: SSO configuration CRUD with encrypted storage (using platform `EncryptionService`)
- **G-6**: Force-SSO mode with optional Google OAuth fallback per organization
- **G-7**: Assertion replay protection (SAML) and CSRF state validation (OIDC) via Redis/in-memory hybrid store
- **G-8**: One-time auth code exchange for secure token delivery after IdP redirect

### Non-Goals (Out of Scope)

- **NG-1**: SCIM 2.0 user/group provisioning (planned as a follow-up feature)
- **NG-2**: Multi-IdP per organization (only one active SSO config per org)
- **NG-3**: Custom RBAC role mapping from IdP group claims (roles come from tenant membership, not IdP)
- **NG-4**: WebAuthn/FIDO2 passwordless authentication (separate feature)
- **NG-5**: Session federation across multiple ABL platform instances

---

## 3. User Stories

1. As an **enterprise IT admin**, I want to configure SAML 2.0 or OIDC SSO for my organization so that users authenticate through our corporate identity provider.
2. As an **enterprise IT admin**, I want to verify domain ownership via DNS TXT records so that only my organization controls SSO for our email domain.
3. As an **enterprise IT admin**, I want to enforce MFA for all organization members so that our compliance requirements (SOC 2, ISO 27001) are met.
4. As a **platform user**, I want to log in via my corporate SSO so that I do not need a separate email/password credential.
5. As a **platform user**, I want MFA setup with a TOTP authenticator app and recovery codes so that I have a secure second factor.
6. As an **enterprise IT admin**, I want to enable force-SSO mode so that users in my organization cannot bypass SSO with email/password login.
7. As a **platform admin (super-admin)**, I want to view and manage SSO configurations across all organizations from the admin portal.

---

## 4. Functional Requirements

1. **FR-1**: The system must support SAML 2.0 SP-initiated SSO with AuthnRequest generation, XML signature verification against the IdP X.509 certificate, audience restriction, and NotBefore/NotOnOrAfter timestamp validation using `@node-saml/node-saml`.
2. **FR-2**: The system must support SAML 2.0 IdP-initiated SSO by resolving the organization from the SAML assertion issuer when no RelayState is present.
3. **FR-3**: The system must support OIDC Authorization Code flow with PKCE (S256), ID token validation (issuer, audience, expiration, nonce), and UserInfo endpoint fetching.
4. **FR-4**: The system must store SSO configuration encrypted at rest using the platform `EncryptionService` (`encryptForTenant`/`decryptForTenant`), with plaintext JSON fallback for legacy data.
5. **FR-5**: The system must provide DNS TXT-based domain ownership verification: claim a domain, generate a verification token (`kore-verify=<hex>`), verify via `_kore-verification.<domain>` TXT lookup.
6. **FR-6**: The system must enforce organization-level MFA when the org setting `requireMfa` is true or the subscription plan is BUSINESS or ENTERPRISE.
7. **FR-7**: The system must implement TOTP (RFC 6238) with configurable digits/period/window, encrypted secret storage, and timing-safe comparison.
8. **FR-8**: The system must implement single-use bcrypt-hashed recovery codes with configurable count and length.
9. **FR-9**: The system must implement SAML assertion replay protection via consumed assertion ID tracking (Redis with TTL, in-memory fallback).
10. **FR-10**: The system must implement OIDC CSRF protection via random state parameter stored in Redis (with in-memory fallback) and atomic consume-on-use via `GETDEL`.
11. **FR-11**: The system must implement one-time auth code exchange: after IdP redirect, issue a short-lived code (60s TTL), which the frontend exchanges for JWT tokens via `/api/sso/exchange`.
12. **FR-12**: The system must support force-SSO mode per organization, with an optional `allowGoogleFallback` toggle.
13. **FR-13**: The system must apply SSRF protections on all outbound OIDC requests (token endpoint, userinfo endpoint): reject private IPs, localhost, link-local, and non-HTTPS URLs.
14. **FR-14**: The system must issue standard JWT access tokens with tenant context (tenantId, role, orgId) after successful SSO login, using the existing `createTokenPair` / `resolveUserContextOrAutoAcceptInvite` pipeline.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                             |
| -------------------------- | ------------ | ----------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Projects are accessed after auth; SSO changes login, not projects |
| Agent lifecycle            | NONE         | Agent execution uses SDK tokens, not user SSO                     |
| Customer experience        | PRIMARY      | Enterprise login UX, MFA enrollment, domain verification          |
| Integrations / channels    | NONE         | Channel auth uses SDK session tokens, independent of SSO          |
| Observability / tracing    | SECONDARY    | Auth events emitted via `onAuthEvent` callback                    |
| Governance / controls      | PRIMARY      | MFA enforcement, session policies, force-SSO                      |
| Enterprise / compliance    | PRIMARY      | SOC 2, ISO 27001 requirements drive this feature                  |
| Admin / operator workflows | PRIMARY      | SSO config, domain management, MFA policy in admin portal         |

### Related Feature Integration Matrix

| Related Feature      | Relationship Type | Why It Matters                                                                      | Key Touchpoints                                                 | Current State |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| Unified Auth         | extends           | SSO feeds into the same `createUnifiedAuthMiddleware` pipeline                      | `unified-auth.ts`, `auth-context-bridge.ts`                     | STABLE        |
| RBAC Permissions     | depends on        | SSO users get permissions from tenant membership, resolved by `permission-resolver` | `permission-resolver.ts`, `permission-guard.ts`                 | STABLE        |
| Tenant Configuration | shares data with  | MFA enforcement gated by plan tier (FREE/TEAM/BUSINESS/ENTERPRISE)                  | `tenant-config.ts`, `compliance-repo.ts`                        | STABLE        |
| Invitation Service   | shares data with  | SSO callback auto-accepts single pending invitation for new users                   | `invitation-service.ts`, `resolveUserContextOrAutoAcceptInvite` | STABLE        |
| Audit Logging        | emits into        | Auth events (SSO login, MFA verify, domain claim) should be audit-logged            | `audit-service.ts`, `AuthEvent` type                            | ALPHA         |

---

## 6. Design Considerations (Optional)

**Studio UI flows:**

- Login page: email input triggers `/api/sso/init` to detect SSO domain; if SSO enabled, redirect to IdP
- MFA enrollment: settings page with QR code display, TOTP code confirmation, recovery code download
- SSO configuration: org admin settings page with SAML/OIDC form, domain management, test connection
- Domain verification: step-by-step wizard showing DNS TXT record value, manual verify button

**Security considerations:**

- SAML assertion signatures MUST be verified via `@node-saml/node-saml` -- the basic regex-based extraction in `saml-service.ts` is a development fallback only
- OIDC ID token signature verification via JWKS is noted as a production TODO -- current implementation decodes without signature check
- One-time auth codes prevent token leakage in browser URL bars
- SSO configs are encrypted with `EncryptionService.encryptForTenant` because they live in Organization subdocuments outside the Mongoose encryption plugin scope

---

## 7. Technical Considerations (Optional)

- **SSO state storage**: Hybrid Redis/in-memory via `sso-state-store.ts`. In production, Redis is required for distributed state. The in-memory fallback is single-pod only and will cause state loss on restart.
- **IdP-initiated SAML**: Requires `findOrgBySAMLIssuer` index on `ssoConfigs.idpEntityId` -- currently done via array elemMatch query on Organization collection.
- **User matching**: SSO users are matched by email. The `googleId` field is overloaded with provider prefixes (`sso-saml:`, `sso-oidc:`) plus a random UUID to avoid collisions. This is a schema workaround -- a proper `externalId` + `authProvider` pair would be cleaner.
- **MFA lockout**: Configurable threshold (default 10 attempts) and duration (default 30 min). Lockout state is stored on the User document (`mfa.failedAttempts`, `mfa.lockedUntil`).
- **Password service**: Configurable strength rules (min length, uppercase, lowercase, digit, special char), common password blocklist, password history check.

---

## 8. How to Consume

### Studio UI

| Route / Screen           | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `/login`                 | Email input, SSO detection via init API |
| `/auth/callback`         | Auth code exchange after IdP redirect   |
| `/settings/security`     | MFA setup/disable, recovery code mgmt   |
| `/settings/organization` | SSO config, domain management (admin)   |

### API (Studio)

| Method | Path                             | Purpose                                          |
| ------ | -------------------------------- | ------------------------------------------------ |
| GET    | `/api/sso/init?email=<email>`    | Detect SSO for email domain, return redirect URL |
| GET    | `/api/sso/oidc/callback`         | OIDC authorization code callback                 |
| POST   | `/api/sso/saml/callback`         | SAML assertion POST callback                     |
| POST   | `/api/sso/exchange`              | Exchange one-time auth code for JWT tokens       |
| GET    | `/api/sso/config`                | Get SSO config for current org                   |
| PUT    | `/api/sso/config`                | Create/update SSO config                         |
| POST   | `/api/sso/domains`               | Claim a domain for verification                  |
| POST   | `/api/sso/domains/verify`        | Trigger DNS TXT verification for domain          |
| GET    | `/api/sso/domains`               | List domains for org                             |
| POST   | `/api/auth/mfa/setup`            | Start MFA enrollment (returns secret + QR)       |
| POST   | `/api/auth/mfa/confirm`          | Confirm MFA with first TOTP code                 |
| POST   | `/api/auth/mfa/verify`           | Verify TOTP code during login                    |
| POST   | `/api/auth/mfa/recovery`         | Verify recovery code                             |
| POST   | `/api/auth/mfa/regenerate-codes` | Regenerate recovery codes                        |
| DELETE | `/api/auth/mfa`                  | Disable MFA                                      |
| GET    | `/api/auth/mfa/status`           | Get MFA status                                   |

### API (Runtime)

SSO does not directly affect Runtime APIs. Runtime uses SDK session tokens (`X-SDK-Token`) and API keys (`Authorization: Bearer abl_*`), which are independent of the user SSO flow.

### Admin Portal

| Route / Screen              | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `/login`                    | Admin login page with email/password, Google, Microsoft, and SSO login  |
| `/api/auth/login`           | Email/password login proxied through Studio                             |
| `/api/auth/google`          | Google OAuth redirect (proxied through Studio with admin callback)      |
| `/api/auth/microsoft`       | Microsoft OAuth redirect (proxied through Studio with admin callback)   |
| `/api/auth/sso`             | SSO init redirect (proxied through Studio SSO init with admin callback) |
| `/api/auth/studio/callback` | Studio auth code callback -- exchanges code for admin session           |
| `/api/auth/dev-login`       | Dev-only login bypass (existing, updated for new auth flow)             |

### Channel / SDK / Voice / A2A / MCP Integration

SSO is not channel-aware. Channel authentication uses SDK session tokens issued after `pk_*` API key exchange, which is independent of the user SSO flow.

---

## 9. Data Model

### Collections / Tables

```text
Collection: organizations
Fields:
  - _id: string (org ID)
  - name: string
  - slug: string (unique, indexed)
  - ownerId: string (user ID)
  - billingEmail: string | null
  - billingConfig: Mixed
  - compliance: Mixed[]
  - settings: Mixed (includes { requireMfa: boolean })
  - ssoConfigs: ISsoConfig[] (embedded subdocument array)
    - id: string (uuidv7)
    - protocol: 'saml' | 'oidc'
    - encryptedConfig: string (JSON encrypted via EncryptionService)
    - idpEntityId: string (for SAML IdP-initiated lookup)
    - forceSso: boolean (default false)
    - allowGoogleFallback: boolean (default true)
    - isActive: boolean (default true)
    - createdAt: Date
    - updatedAt: Date
  - domainMappings: IDomainMapping[] (embedded subdocument array)
    - id: string (uuidv7)
    - domain: string (lowercase, unique sparse index)
    - verified: boolean
    - verificationToken: string (kore-verify=<hex>)
    - verifiedAt: Date | null
    - createdAt: Date
  - _v: number
Indexes:
  - { slug: 1 } (unique)
  - { ownerId: 1 }
  - { 'domainMappings.domain': 1 } (unique, sparse)
  - { 'ssoConfigs.isActive': 1, 'ssoConfigs.protocol': 1, 'ssoConfigs.idpEntityId': 1 } (for IdP-initiated lookup)

Collection: users (MFA subdocument)
Fields:
  - mfa: embedded subdocument
    - encryptedSecret: string (TOTP secret, encrypted via EncryptionService)
    - verified: boolean
    - enabledAt: Date | null
    - lastUsedAt: Date | null
    - failedAttempts: number
    - lockedUntil: Date | null
    - recoveryCodes: Array<{ codeHash: string, createdAt: Date, usedAt: Date | null }>
```

### Key Relationships

- Organization 1:N Tenants (via `tenant.organizationId`)
- Organization embeds 0:N SSOConfigs and 0:N DomainMappings
- User embeds 0:1 MFA subdocument
- TenantMember links User to Tenant with role (resolved for JWT after SSO login)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                | Purpose                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/studio/src/services/sso/sso-types.ts`         | SSO type definitions (SAMLConfig, OIDCConfig, SSOUser, etc.)             |
| `apps/studio/src/services/sso/sso-state-store.ts`   | Hybrid Redis/in-memory store for SAML assertions, OIDC state, auth codes |
| `apps/studio/src/services/sso/oidc-service.ts`      | OIDC PKCE flow, authorization URL, token exchange, ID token validation   |
| `apps/studio/src/services/sso/saml-service.ts`      | SAML SP metadata, AuthnRequest generation, assertion validation          |
| `apps/studio/src/services/sso/domain-service.ts`    | Domain claim, DNS TXT verification, domain lookup                        |
| `apps/studio/src/services/auth/mfa-service.ts`      | TOTP (RFC 6238), recovery codes, MFA lifecycle                           |
| `apps/studio/src/services/auth/password-service.ts` | Password hashing, validation, history check                              |
| `apps/studio/src/services/auth-service.ts`          | JWT creation, token refresh, tenant context resolution                   |
| `apps/studio/src/lib/sso-helpers.ts`                | SSO config encryption/decryption helper                                  |
| `apps/studio/src/lib/sso-state-store.ts`            | Wrapper for SSO state store operations (OIDC state with admin redirect)  |
| `apps/studio/src/lib/sso-auth-codes.ts`             | Auth code store/consume operations                                       |
| `apps/studio/src/lib/admin-auth-handoff.ts`         | Admin auth handoff: relay state, redirect cookies, auth code redirect    |

### Routes / Handlers (Studio)

| File                                                       | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/studio/src/app/api/sso/init/route.ts`                | SSO detection by email domain (updated: admin redirect + mode param) |
| `apps/studio/src/app/api/sso/oidc/callback/route.ts`       | OIDC callback handler (updated: admin redirect cookie support)       |
| `apps/studio/src/app/api/sso/saml/callback/route.ts`       | SAML callback handler (updated: admin redirect via relay state)      |
| `apps/studio/src/app/api/auth/callback/route.ts`           | Auth callback page (updated: admin redirect after exchange)          |
| `apps/studio/src/app/api/auth/google/route.ts`             | Google OAuth (updated: admin redirect param passthrough)             |
| `apps/studio/src/app/api/auth/microsoft/route.ts`          | Microsoft OAuth init (updated: admin redirect param passthrough)     |
| `apps/studio/src/app/api/auth/microsoft/callback/route.ts` | Microsoft OAuth callback (updated: admin redirect cookie support)    |
| `apps/studio/src/app/api/sso/config/route.ts`              | SSO config CRUD (planned -- not yet implemented)                     |
| `apps/studio/src/app/api/sso/domains/route.ts`             | Domain management (planned -- not yet implemented)                   |
| `apps/studio/src/app/api/sso/domains/verify/route.ts`      | Domain verification (planned -- not yet implemented)                 |
| `apps/studio/src/app/api/sso/exchange/route.ts`            | Auth code exchange (planned -- not yet implemented)                  |

### Routes / Handlers (Admin)

| File                                                   | Purpose                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/admin/src/app/api/auth/login/route.ts`           | Email/password login proxied through Studio                   |
| `apps/admin/src/app/api/auth/google/route.ts`          | Google OAuth redirect via Studio with admin callback          |
| `apps/admin/src/app/api/auth/microsoft/route.ts`       | Microsoft OAuth redirect via Studio with admin callback       |
| `apps/admin/src/app/api/auth/sso/route.ts`             | SSO init redirect via Studio SSO init with admin callback     |
| `apps/admin/src/app/api/auth/studio/callback/route.ts` | Studio auth code callback -- exchanges code for admin session |
| `apps/admin/src/app/api/auth/dev-login/route.ts`       | Dev-only login bypass (updated for new auth flow)             |
| `apps/admin/src/lib/admin-auth-redirect.ts`            | Admin URL builders (login, post-login, studio callback)       |
| `apps/admin/src/lib/studio-admin-auth.ts`              | Admin session payload, super-admin validation, cookie mgmt    |
| `apps/admin/src/lib/with-admin-route.ts`               | Admin route guard (updated for session cookie auth)           |
| `apps/admin/src/app/(auth)/login/page.tsx`             | Admin login page UI (updated: social login + SSO buttons)     |

### Middleware / Auth

| File                                                         | Purpose                                             |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `packages/shared-auth/src/middleware/unified-auth.ts`        | Unified auth dispatcher (JWT, SDK, API key)         |
| `packages/shared-auth/src/middleware/auth-context-bridge.ts` | Maps TenantContextData to discriminated AuthContext |
| `packages/shared-auth/src/rbac/permission-resolver.ts`       | Permission resolution and caching                   |
| `packages/auth-enterprise/src/saml-auth.ts`                  | Enterprise SAML auth for tool authentication        |

### Data Access

| File                                                 | Purpose                                             |
| ---------------------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/repos/org-repo.ts`                  | Organization, DomainMapping, SSOConfig CRUD         |
| `apps/studio/src/repos/mfa-repo.ts`                  | MFA and recovery code CRUD (User subdoc)            |
| `apps/studio/src/repos/auth-repo.ts`                 | User, RefreshToken, TenantMember CRUD               |
| `packages/database/src/models/organization.model.ts` | Organization Mongoose model with SSO/domain schemas |

### Tests

| File                                                                 | Type | Coverage Focus                                                            |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `apps/admin/src/__tests__/auth-routes.test.ts`                       | unit | Admin auth routes (login, studio callback, SSO) -- 9 tests                |
| `apps/admin/src/__tests__/with-admin-route.test.ts`                  | unit | Admin route guard (session cookie validation) -- 2 tests                  |
| `apps/studio/src/__tests__/api-routes/api-admin-social-auth.test.ts` | unit | Admin social auth handoff (Google, Microsoft, admin redirect) -- 11 tests |
| `apps/studio/src/__tests__/api-routes/api-sso-routes.test.ts`        | unit | SSO init, OIDC callback, SAML callback routes -- 52 tests                 |
| `apps/studio/src/__tests__/lib-sso.test.ts`                          | unit | SSO auth codes, state store, ensure-db -- 25 tests                        |
| `packages/shared-auth/src/__tests__/unified-auth.test.ts`            | unit | Auth middleware dispatch                                                  |
| `packages/shared-auth/src/__tests__/permission-resolver.test.ts`     | unit | RBAC permission resolution                                                |
| `packages/shared-auth/src/__tests__/jwt-verify.test.ts`              | unit | JWT token verification                                                    |
| `packages/auth-enterprise/src/__tests__/saml-auth.test.ts`           | unit | SAML assertion generation                                                 |
| `packages/database/src/__tests__/model-auth.test.ts`                 | unit | Auth-related model tests                                                  |

---

## 11. Configuration

### Environment Variables

| Variable                | Default                 | Description                                                       |
| ----------------------- | ----------------------- | ----------------------------------------------------------------- |
| `JWT_SECRET`            | random (dev only)       | JWT signing secret                                                |
| `JWT_ACCESS_EXPIRY`     | `15m`                   | Access token TTL                                                  |
| `JWT_REFRESH_EXPIRY`    | `7d`                    | Refresh token TTL                                                 |
| `ENCRYPTION_MASTER_KEY` | (none)                  | Required in production for MFA secret/SSO config encryption       |
| `FRONTEND_URL`          | `http://localhost:5173` | Frontend URL for SSO callback redirects                           |
| `API_URL`               | (none)                  | API base URL for SSO callbacks (falls back to FRONTEND_URL)       |
| `REDIS_URL`             | (none)                  | Redis for distributed SSO state store                             |
| `STUDIO_API_URL`        | `http://localhost:5173` | Admin service: Studio API URL for auth proxy (code exchange, /me) |
| `NEXT_PUBLIC_ADMIN_URL` | (none)                  | Admin portal public URL (for callback URL validation)             |
| `ADMIN_URL`             | (none)                  | Admin portal URL fallback (for callback URL validation)           |
| `NEXT_PUBLIC_BASE_URL`  | (none)                  | Admin portal base URL (for redirect URL construction)             |

### Runtime Configuration

Config path: `config.auth` (via `getConfig()`)

```typescript
auth: {
  mfa: {
    totpWindow: 1,
    totpDigits: 6,
    totpPeriod: 30,
    recoveryCodeCount: 10,
    recoveryCodeLength: 8,
    recoveryCodeBcryptCost: 10,
    lockThreshold: 10,
    lockDurationMs: 1800000,       // 30 min
    partialTokenTtlSeconds: 300,   // 5 min
    issuer: 'KorePlatform',
  },
  sso: {
    authCodeTtlSeconds: 60,
    oidcStateTtlSeconds: 600,
    samlAssertionTtlSeconds: 3600,
  },
  password: {
    bcryptCost: 12,
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSpecialChar: false,
    historyCount: 5,
  },
  lockout: {
    maxFailedAttempts: 5,
    lockDurationMs: 900000,        // 15 min
  },
}
```

### DSL / Agent IR / Schema

N/A -- SSO/Enterprise Auth is a platform-level feature, not configurable in ABL DSL or agent IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | SSO is org-level, not project-level. Projects are accessed after auth via tenant membership.                                                 |
| Tenant isolation  | SSO config is scoped to Organization. Domain mappings are globally unique (one org per domain). Cross-org SSO config access must return 404. |
| User isolation    | MFA data is embedded in the User document. Users can only manage their own MFA. Recovery codes are user-scoped.                              |

### Security & Compliance

- **SAML assertion signatures**: MUST be verified via `@node-saml/node-saml` with the IdP X.509 certificate
- **OIDC ID token validation**: Currently basic (decode-only); production requires JWKS signature verification
- **SSO config encryption**: Uses `EncryptionService.encryptForTenant`; plaintext fallback for legacy data
- **SSRF protection**: All outbound OIDC requests validate URLs (no private IPs, no localhost, HTTPS-only)
- **Assertion replay**: Consumed assertion IDs stored with TTL in Redis; in-memory fallback
- **Auth code**: 32-byte random, 60-second TTL, atomic consume via `GETDEL`
- **MFA secret encryption**: TOTP secrets encrypted with user-scoped key; `UNENC:` prefix for dev-only plaintext
- **Recovery codes**: bcrypt-hashed, single-use, marked with `usedAt` timestamp
- **MFA lockout**: Configurable threshold and duration prevent brute-force
- **Password policy**: Configurable strength, common password blocklist, history check
- **Timing-safe comparison**: TOTP verification uses `crypto.timingSafeEqual`

### Performance & Scalability

- SSO flows add 1-2 external HTTP calls (IdP token exchange + userinfo) -- expect 200-500ms additional latency
- OIDC discovery document cached for 1 hour per issuer
- Permission resolver caches per tenant+user pair with 60s TTL
- SAML assertion consumed set uses Redis SET with TTL (no unbounded growth)
- In-memory fallback stores have periodic cleanup intervals

### Reliability & Failure Modes

- Redis unavailable: falls back to in-memory stores (single-pod limitation documented)
- IdP unavailable: SSO login fails with 503; email/password login unaffected (unless force-SSO)
- Encryption service unavailable: MFA setup fails in production (required); SSO config decrypt falls back to plaintext
- DNS lookup failure: domain verification returns `false` (not an error)
- Token exchange failure: returns 401 to frontend with error context

### Observability

- `AuthEvent` emitted via `onAuthEvent` callback for each auth flow outcome (success/failure)
- Auth events include: authType, userId, tenantId, IP, userAgent, requestId, failure reason
- SSO errors logged via `createLogger('auth-sso')` in OIDC callback, console.error in SAML callback (inconsistency noted in GAP-003)

### Data Lifecycle

- SAML consumed assertions: TTL-based (default 1 hour)
- OIDC state: TTL-based (default 10 minutes)
- Auth codes: TTL-based (default 60 seconds)
- MFA recovery codes: persisted until used or regenerated
- Refresh tokens: TTL-based (default 7 days), revoked on rotation
- In-memory cleanup interval: `SSO_STATE_CLEANUP_INTERVAL_MS`

---

## 13. Delivery Plan / Work Breakdown

1. **SSO Core (SAML + OIDC)** -- IMPLEMENTED (pre-ABLP-346)
   1.1 SAML 2.0 SP-initiated flow with `@node-saml` signature verification
   1.2 SAML 2.0 IdP-initiated flow with issuer-based org resolution
   1.3 OIDC Authorization Code + PKCE flow
   1.4 One-time auth code exchange endpoint
   1.5 SSO state store (Redis + in-memory hybrid)

2. **Domain Management** -- IMPLEMENTED (pre-ABLP-346)
   2.1 Domain claim API with verification token generation
   2.2 DNS TXT verification endpoint
   2.3 Domain-to-org lookup for SSO routing

3. **MFA** -- IMPLEMENTED (pre-ABLP-346)
   3.1 TOTP setup, confirmation, and verification
   3.2 Recovery code generation, verification, and regeneration
   3.3 Organization-level MFA enforcement (plan-gated)
   3.4 MFA lockout and unlock

4. **SSO Configuration Management** -- PARTIALLY IMPLEMENTED
   4.1 SSO config CRUD endpoints (encrypted storage) -- NOT YET (GAP-008)
   4.2 Force-SSO mode with Google fallback toggle -- NOT YET
   4.3 SSO test connection endpoint -- NOT YET

5. **Studio UI** -- PARTIALLY IMPLEMENTED
   5.1 SSO-aware login page -- DONE (SSO init detection)
   5.2 MFA enrollment and management in settings -- NOT YET
   5.3 SSO configuration admin page -- NOT YET
   5.4 Domain management admin page -- NOT YET

6. **Platform Auth Handoff (ABLP-346)** -- IMPLEMENTED
   6.1 Admin login page with email/password, Google, Microsoft, and SSO options
   6.2 Admin auth proxy routes (login, Google, Microsoft, SSO) to Studio
   6.3 Studio callback handler for admin auth code exchange
   6.4 Admin session cookie management with super-admin validation
   6.5 Admin redirect cookie for cross-app auth flow preservation
   6.6 SAML relay state encoding/decoding for admin redirect
   6.7 OIDC state store extended with admin redirect metadata
   6.8 SSO init route updated for redirect mode and admin callback params

7. **Hardening** -- NOT STARTED
   7.1 OIDC ID token JWKS signature verification (GAP-001)
   7.2 Consistent structured logging across all SSO routes (GAP-003, GAP-006, GAP-009)
   7.3 SCIM hooks (placeholder for provisioning) (GAP-005)
   7.4 Session policy controls (max session duration, idle timeout)

---

## 14. Success Metrics

| Metric                          | Baseline | Target   | How Measured                     |
| ------------------------------- | -------- | -------- | -------------------------------- |
| SSO login success rate          | N/A      | > 98%    | Auth events (success vs failure) |
| MFA enrollment rate (BUSINESS+) | 0%       | > 80%    | User MFA status query            |
| SSO config setup time           | N/A      | < 15 min | Admin workflow timing            |
| Domain verification time        | N/A      | < 24 hrs | Time from claim to verified      |
| Auth-related support tickets    | Baseline | -50%     | Support ticket categorization    |

---

## 15. Open Questions

1. Should OIDC ID token JWKS signature verification be mandatory before GA, or is the current decode-only approach acceptable for ALPHA?
2. Should the `googleId` field overloading with SSO provider prefixes be cleaned up with a proper `externalId` + `authProvider` schema migration?
3. Should session idle timeout and max duration be configurable per organization, or is a platform-wide setting sufficient?
4. What is the expected volume of concurrent SSO logins during peak? (Affects Redis sizing for state store.)
5. Should audit logging for SSO events use the existing `onAuthEvent` callback or a dedicated audit log table?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                          | Severity | Status    |
| ------- | ---------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | OIDC ID token validation does not verify JWT signature via JWKS -- decodes payload only              | High     | Open      |
| GAP-002 | `googleId` field overloaded with SSO provider prefixes (`sso-saml:`, `sso-oidc:`) + UUID             | Medium   | Open      |
| GAP-003 | Inconsistent logging: OIDC callback uses `createLogger`, SAML callback uses `console.error`          | Medium   | Open      |
| GAP-004 | In-memory SSO state store is single-pod only -- Redis required for production multi-pod              | High     | Mitigated |
| GAP-005 | No SCIM provisioning -- users must be manually invited or auto-created on first SSO login            | Medium   | Open      |
| GAP-006 | SAML callback uses `console.warn` instead of structured logger in several places                     | Low      | Open      |
| GAP-007 | Discovery document cache (`discoveryCache`) has no max size or eviction policy                       | Low      | Open      |
| GAP-008 | SSO config routes (`/api/sso/config`, `/api/sso/domains/*`, `/api/sso/exchange`) not yet implemented | High     | Open      |
| GAP-009 | Admin auth routes use `console.error` instead of structured logger                                   | Low      | Open      |
| GAP-010 | No E2E or integration tests for admin auth handoff or social login flows                             | Medium   | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                 | Coverage Type | Status     | Test File / Note                           |
| --- | ---------------------------------------- | ------------- | ---------- | ------------------------------------------ |
| 1   | SAML SP-initiated login end-to-end       | e2e           | NOT TESTED | Requires IdP mock                          |
| 2   | SAML IdP-initiated login                 | e2e           | NOT TESTED | Requires IdP mock                          |
| 3   | OIDC login with PKCE                     | e2e           | NOT TESTED | Requires OIDC provider mock                |
| 4   | Domain claim and DNS verification        | integration   | NOT TESTED |                                            |
| 5   | MFA TOTP setup + verify + recovery       | integration   | NOT TESTED |                                            |
| 6   | Force-SSO blocks email/password login    | e2e           | NOT TESTED |                                            |
| 7   | Cross-org SSO config access returns 404  | e2e           | NOT TESTED |                                            |
| 8   | Assertion replay blocked                 | integration   | NOT TESTED |                                            |
| 9   | OIDC CSRF state validation               | integration   | NOT TESTED |                                            |
| 10  | Auth code exchange (valid + expired)     | integration   | NOT TESTED |                                            |
| 11  | Admin auth handoff via Studio            | unit          | COVERED    | `api-admin-social-auth.test.ts` (11 tests) |
| 12  | SSO init with admin redirect params      | unit          | COVERED    | `api-sso-routes.test.ts` (52 tests)        |
| 13  | SSO auth code store/consume lifecycle    | unit          | COVERED    | `lib-sso.test.ts` (25 tests)               |
| 14  | Admin route guard (session cookie)       | unit          | COVERED    | `with-admin-route.test.ts` (2 tests)       |
| 15  | Admin auth routes (login, callback, SSO) | unit          | COVERED    | `auth-routes.test.ts` (9 tests)            |

### Testing Notes

Unit tests now cover the admin auth handoff flow (ABLP-346): social login proxy routes in admin, auth code exchange via Studio callback, SSO init with admin redirect parameters, and SSO state store operations. Test count: 99 unit tests across 5 test files.

Existing unit tests also cover the middleware layer (`unified-auth.test.ts`, `permission-resolver.test.ts`, `jwt-verify.test.ts`) and enterprise auth types (`saml-auth.test.ts`).

No E2E or integration tests exist for SSO flows, admin auth handoff E2E, or MFA service. The unit tests use `vi.mock` for platform dependencies, which limits confidence -- real E2E and integration tests exercising the full middleware chain remain the primary gap.

> Full testing details: `../testing/sso-enterprise-auth.md`

---

## 18. References

- Design docs: `docs/enterprise/ENTERPRISE_ROADMAP.md`, `docs/enterprise/XO_ENTERPRISE_GAP_ANALYSIS.md`
- Auth middleware: `packages/shared-auth/src/middleware/unified-auth.ts`
- Enterprise auth types: `packages/auth-enterprise/src/index.ts`
- SSO services: `apps/studio/src/services/sso/`
- MFA service: `apps/studio/src/services/auth/mfa-service.ts`
- Organization model: `packages/database/src/models/organization.model.ts`
