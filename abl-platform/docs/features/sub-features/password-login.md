# Feature: Password Login

**Doc Type**: SUB-FEATURE
**Parent Feature**: Auth Profiles
**Status**: STABLE
**Feature Area(s)**: `customer experience`, `governance`, `admin operations`
**Package(s)**: `apps/studio`, `packages/database`, `packages/config`
**Owner(s)**: `Auth team`
**Testing Guide**: [docs/testing/sub-features/password-login.md](../../testing/sub-features/password-login.md)
**Last Updated**: 2026-03-21

---

## 1. Introduction / Overview

### Problem Statement

Studio needs a native first-party authentication path for users who are not coming in through social login or enterprise SSO. Without a password-based flow, signup, verification, reset, and recovery become fragmented, and downstream Studio/Admin/Runtime JWT trust would rely entirely on external identity providers.

### Goal Statement

The goal of Password Login is to provide a secure, first-party email/password authentication flow for Studio that covers signup, verification, login, refresh/logout, password reset, and lockout protection while keeping credential entry and session lifecycle centralized in one place.

### Summary

Password Login is the first-party account authentication flow for the Studio application. It gives users a native email/password path alongside social and SSO entry points, covering account creation, email verification, login, refresh-token session management, password reset, and account lockout protection.

The feature is implemented in the Studio app because that is where user-facing auth pages, cookies, and onboarding live. Runtime and Admin do not run their own password login flows; they trust the access tokens and refresh tokens minted here. That keeps credential entry, email delivery, and user session lifecycle centralized in one place.

The module is security-heavy by design: passwords are bcrypt-hashed before storage, the resulting `passwordHash` is encrypted at rest by the database plugin, reset and verification tokens are stored as hashes with TTL indexes, login attempts are rate-limited, and repeated failures trigger clear lockout responses rather than silent looping on bad credentials.

### Goals

- Provide a secure email/password signup and login flow for Studio users.
- Keep verification, reset, and refresh/logout behavior centralized in Studio-auth routes.
- Enforce lockout, rate limiting, password-history, and anti-enumeration protections.
- Produce JWTs and refresh cookies that Runtime and Admin can trust downstream.

### Non-Goals (Out of Scope)

- This feature does not replace social-login or enterprise SSO providers.
- This feature does not add a separate password-login stack inside Runtime or Admin.
- This feature does not fully solve MFA challenge/recovery coverage yet; that remains a documented test gap.

### User Stories

1. As a Studio user, I want to sign up and verify my email so that I can access the platform with a native account.
2. As a returning user, I want lockout-safe login, refresh, and password-reset flows so that I can recover access without leaking account state to attackers.
3. As a platform operator, I want password hashes, reset tokens, and verification tokens handled safely so that the user-auth surface stays secure and auditable.

### Functional Requirements

1. **FR-1**: The system must allow users to sign up with email/password and send a verification email.
2. **FR-2**: The system must verify email tokens atomically and auto-login verified users.
3. **FR-3**: The system must authenticate valid passwords while enforcing rate limits and account lockout thresholds.
4. **FR-4**: The system must support resend-verification and forgot-password flows with anti-enumeration behavior.
5. **FR-5**: The system must reject password reuse during reset and revoke refresh tokens on successful password change.
6. **FR-6**: The system must mint access tokens and refresh cookies that downstream Studio/Admin/Runtime surfaces can validate.

### Feature Classification & Integration Matrix

#### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Verification/login flows resolve onboarding and tenant-membership context after auth succeeds.             |
| Agent lifecycle            | NONE         | Password Login does not directly affect runtime agent execution.                                           |
| Customer experience        | PRIMARY      | Signup, login, verification, and reset are direct user-facing flows.                                       |
| Integrations / channels    | NONE         | This is a Studio web-authentication feature, not a channel adapter.                                        |
| Observability / tracing    | SECONDARY    | Audit events and structured auth logging are part of the lifecycle.                                        |
| Governance / controls      | PRIMARY      | Lockout, rate limiting, password history, and provider-mismatch handling are governance/security controls. |
| Enterprise / compliance    | SECONDARY    | It complements, but does not replace, SSO or external IdP strategies.                                      |
| Admin / operator workflows | NONE         | Admin consumes the resulting JWTs but does not host the password-login surface itself.                     |

#### Related Feature Integration Matrix

| Related Feature                               | Relationship Type | Why It Matters                                                                                                                  | Key Touchpoints                                | Current State                |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| [Auth Profiles](../auth-profiles.md)          | adjacent to       | Password Login handles first-party user authentication, while Auth Profiles manages service credentials and OAuth integrations. | shared Studio auth context, JWT trust          | Explicitly separate concerns |
| [Workspace Sharing](../workspace-sharing.md)  | hands off to      | Verified/login users may need onboarding or invitation-driven tenant membership resolution.                                     | `needsOnboarding`, invitation context          | Active integration           |
| [SDK](../sdk.md) / [Channels](../channels.md) | enables access to | Studio-authenticated users manage tenant-scoped SDK/channel resources after login.                                              | bearer token trust across Studio/Admin/Runtime | Indirect integration         |

### Design Considerations (Optional)

- Auth pages need clear messaging for lockout, verification, reset, and provider-mismatch cases.
- Verification and reset flows depend on email-delivered tokens but should remain usable without leaking account existence.
- The flow intentionally centralizes cookies and browser-facing auth behavior in Studio.

### Technical Considerations (Optional)

- Password hashes are bcrypt-based and then stored through the encrypted database field/plugin layer.
- Verification/reset tokens are stored as hashes with TTL indexes and consumed atomically.
- Rate limiting is Redis-backed with bounded in-memory fallback, and lockout behavior returns `423` with explicit account-lock semantics.
- MFA uses partial-token cookie handoff, but end-to-end challenge and recovery coverage remains incomplete.

### Key Capabilities

- Email/password signup with strength validation and duplicate-email handling
- Email verification with single-use hashed tokens and auto-login after verification
- Login with rate limiting, failed-attempt counters, and timed account lockout
- Resend verification flow with anti-enumeration behavior and old-token invalidation
- Forgot-password flow with timing protection and generic success responses
- Reset-password flow with atomic token consumption, password-history checks, and refresh-token revocation
- JWT access-token and refresh-token issuance for downstream Runtime/Admin requests
- MFA handoff support via partial-token cookie when MFA is enabled for the user

---

## 2. How to Consume

### Studio UI

The primary UI lives in the public auth pages under `apps/studio/src/app/auth/`:

- `/auth/signup` creates a password-based user account
- `/auth/verify-email` consumes the emailed verification token
- `/auth/login` authenticates the account and sets the refresh-token cookie
- `/auth/reset-password` accepts forgot-password tokens and new passwords
- `/onboarding` is the next stop when a verified user has no tenant membership yet

The login page also uses account-resolution logic to redirect users toward the correct flow when an email is already tied to another auth provider or invitation state.

### API (Runtime)

Password Login does not expose dedicated Runtime endpoints. Instead, Runtime consumes the JWT access token minted by Studio auth routes on later authenticated requests.

### API (Studio)

| Method | Path                            | Purpose                                               |
| ------ | ------------------------------- | ----------------------------------------------------- |
| POST   | `/api/auth/signup`              | Create a password-based user and send verification    |
| POST   | `/api/auth/login`               | Validate credentials, enforce lockout, mint tokens    |
| POST   | `/api/auth/verify-email`        | Verify token, mark email verified, auto-login         |
| POST   | `/api/auth/resend-verification` | Resend verification email for unverified accounts     |
| POST   | `/api/auth/forgot-password`     | Send reset email with anti-enumeration behavior       |
| POST   | `/api/auth/reset-password`      | Consume reset token, rotate password, revoke sessions |
| POST   | `/api/auth/refresh`             | Rotate access/refresh tokens from refresh cookie      |
| POST   | `/api/auth/logout`              | Revoke refresh token and clear cookies                |

### Admin Portal

There is no separate password-login stack in `apps/admin`. The admin app trusts the same JWTs created here and validates them with the shared `JWT_SECRET`.

### Channel Integration

This is a web-authentication feature, not a channel adapter. Its output is a user-scoped bearer token and refresh cookie that can be presented to Studio, Runtime, and Admin APIs. SDK channels, public API keys, and A2A flows use separate auth mechanisms.

---

## 3. Data Model

### Collections / Tables

```text
Collection: users
Fields:
  - _id: string
  - email: string (unique)
  - name: string | null
  - passwordHash: string | null (bcrypt hash, encrypted at rest)
  - emailVerified: boolean
  - authProvider: string
  - lastLoginAt: Date | null
  - failedLoginAttempts: number
  - loginLockedUntil: Date | null
  - mfa: object | null
  - passwordHistory: { hash: string; changedAt: Date }[]
Indexes:
  - { email: 1 } unique
  - { googleId: 1 } unique partial
Plugins:
  - encryptionPlugin on `passwordHash`
  - auditTrailPlugin
```

```text
Collection: email_verification_tokens
Fields:
  - _id: string
  - userId: string
  - token: string (hashed)
  - expiresAt: Date
  - usedAt: Date | null
Indexes:
  - { token: 1 } unique
  - { userId: 1 }
  - { expiresAt: 1 } TTL
```

```text
Collection: password_reset_tokens
Fields:
  - _id: string
  - userId: string
  - token: string (hashed)
  - expiresAt: Date
  - usedAt: Date | null
Indexes:
  - { token: 1 } unique
  - { userId: 1 }
  - { expiresAt: 1 } TTL
```

```text
Collection: refresh_tokens
Fields:
  - _id: string
  - token: string
  - userId: string
  - familyId: string | null
  - generation: number
  - expiresAt: Date
  - revokedAt: Date | null
Indexes:
  - { token: 1 } unique
  - { userId: 1 }
  - { familyId: 1 }
  - { expiresAt: 1 } TTL
```

### Key Relationships

- `email_verification_tokens.userId` -> `users._id`
- `password_reset_tokens.userId` -> `users._id`
- `refresh_tokens.userId` -> `users._id`
- Verified users are later associated with tenant memberships and invitations via the auth service, but those relationships live outside this feature's core collections

---

## 4. Key Implementation Files

### Domain / Core Logic

| File                                                | Purpose                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/studio/src/services/auth/password-service.ts` | Password hashing, verification, strength rules, history checks   |
| `apps/studio/src/services/auth-service.ts`          | JWT creation, refresh-token lifecycle, tenant-context resolution |
| `apps/studio/src/repos/auth-repo.ts`                | MongoDB user/token CRUD, failed-login counters, password history |
| `apps/studio/src/lib/auth-constants.ts`             | Fallback auth defaults for rate limits, token TTLs, lockout      |
| `apps/studio/src/lib/rate-limit.ts`                 | Redis-first sliding-window rate limiting with memory fallback    |

### Routes / Handlers

| File                                                        | Purpose                                     |
| ----------------------------------------------------------- | ------------------------------------------- |
| `apps/studio/src/app/api/auth/signup/route.ts`              | Signup + verification-email dispatch        |
| `apps/studio/src/app/api/auth/login/route.ts`               | Login, lockout, MFA partial-token handoff   |
| `apps/studio/src/app/api/auth/verify-email/route.ts`        | Single-use verification token consumption   |
| `apps/studio/src/app/api/auth/resend-verification/route.ts` | Verification resend with anti-enumeration   |
| `apps/studio/src/app/api/auth/forgot-password/route.ts`     | Reset-token creation + email dispatch       |
| `apps/studio/src/app/api/auth/reset-password/route.ts`      | Password rotation + token revocation        |
| `apps/studio/src/app/api/auth/refresh/route.ts`             | Refresh-token rotation                      |
| `apps/studio/src/app/api/auth/logout/route.ts`              | Refresh-token revocation and cookie cleanup |

### UI Components (Studio)

| File                                               | Purpose                                   |
| -------------------------------------------------- | ----------------------------------------- |
| `apps/studio/src/app/auth/login/page.tsx`          | Password login form and redirect handling |
| `apps/studio/src/app/auth/signup/page.tsx`         | Signup form and verification handoff      |
| `apps/studio/src/app/auth/verify-email/page.tsx`   | Token verification UI                     |
| `apps/studio/src/app/auth/reset-password/page.tsx` | Reset-password form                       |

### Tests

| File                                              | Type        | Count                                         |
| ------------------------------------------------- | ----------- | --------------------------------------------- |
| `apps/studio/src/__tests__/api-auth.test.ts`      | integration | 2 iterations of end-to-end auth flow coverage |
| `apps/studio/src/__tests__/auth-services.test.ts` | unit        | service-level token/auth behavior             |
| `apps/studio/src/__tests__/auth-store.test.ts`    | unit        | auth state and refresh/logout behavior        |
| `apps/studio/src/__tests__/auth-pages.test.tsx`   | unit/UI     | auth page rendering and basic UX behavior     |

---

## 5. Configuration

### Environment Variables

| Variable                      | Default  | Description                                       |
| ----------------------------- | -------- | ------------------------------------------------- |
| `JWT_SECRET`                  | —        | Signing secret for Studio/Admin/Runtime user JWTs |
| `JWT_ACCESS_EXPIRY`           | `15m`    | Access-token expiry override                      |
| `JWT_REFRESH_EXPIRY`          | `7d`     | Refresh-token expiry override                     |
| `AUTH_BCRYPT_COST`            | `12`     | bcrypt work factor for password hashing           |
| `AUTH_PASSWORD_MIN_LENGTH`    | `8`      | Minimum accepted password length                  |
| `AUTH_PASSWORD_HISTORY_COUNT` | `5`      | Number of prior password hashes to keep           |
| `AUTH_LOCKOUT_MAX_ATTEMPTS`   | `5`      | Failed-login threshold before timed lockout       |
| `AUTH_LOCKOUT_DURATION_MS`    | `900000` | Lockout duration in milliseconds                  |

### Runtime Configuration

- `AUTH_CONFIG_DEFAULTS` defines bootstrap-safe defaults for login, signup, forgot-password, reset-password, verify-email, refresh, and resend-verification limits
- Studio rate limiting is Redis-backed when available and falls back to bounded in-memory tracking when Redis is unavailable
- Verification tokens default to 24 hours; reset tokens default to 1 hour
- Refresh cookies default to 7 days and MFA partial cookies to 5 minutes

### DSL / Agent IR

This feature is not configured through ABL DSL. Its main runtime contract is the JWT payload attached to authenticated Studio/Admin/Runtime requests.

---

## 6. Runtime Integration

### Lifecycle

1. A signup request validates email/password input, hashes the password, stores the user, creates a hashed verification token, and sends a verification email.
2. Verification consumes the token atomically, marks the user verified, resolves tenant or invitation context, and issues an access token plus refresh cookie.
3. Login enforces IP rate limiting, generic bad-credential responses, lockout checks, password verification, and token issuance.
4. Forgot-password creates a hashed reset token only for email-provider accounts but always returns a generic success response.
5. Reset-password validates password strength and history before atomically consuming the token, storing the new hash, and revoking all refresh tokens for that user.

### Dependencies

- MongoDB user and token models from `@agent-platform/database/models`
- `createEmailService()` and email templates for verification/reset delivery
- `checkRateLimit()` for Redis-backed auth throttling
- Audit logging via `logAuditEvent()`
- Invitation and tenant-membership resolution for onboarding after verification/login

### Event Flow

- Audit events emitted on signup, login, failed login, account lockout, email verification, password-reset request, and password-reset completion
- Login returns `423` with `code: "ACCOUNT_LOCKED"` when the lockout threshold has been reached
- Refresh tokens are set in an `httpOnly` cookie; MFA uses the `mfa_partial` cookie during challenge flow

---

## 7. Admin Integration

Admin does not manage password accounts directly. The relevant integration point is shared token trust: once Studio authenticates a user, the Admin app can validate the same bearer token with the shared JWT configuration.

---

## 8. Gaps, Known Issues & Limitations

| ID      | Description                                                                                 | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | MFA challenge and recovery-code flows are only partially exercised in the current test docs | Medium   | Open   |
| GAP-002 | Password-history entries written before the reset-flow fix may contain unusable ciphertext  | Low      | Open   |
| GAP-003 | UI automation for lockout, resend-verification, and reset-password forms is still missing   | Medium   | Open   |

---

## 9. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Password Login itself is not project-scoped, but post-login onboarding and invitation resolution must hand off into the correct tenant/project context. |
| Tenant isolation  | Login and reset flows should not leak tenant/workspace existence through error handling.                                                                |
| User isolation    | User tokens, refresh sessions, password history, and MFA partial flows remain user-owned and must never cross user boundaries.                          |

### Performance

Password operations are bounded by bcrypt cost and token I/O. Login/signup/reset endpoints are rate-limited, and forgot-password intentionally adds minimum response time to reduce timing side channels.

### Security

Passwords are bcrypt-hashed before persistence, then `passwordHash` is encrypted at rest. Verification and reset tokens are stored as hashes, not plaintext. Login uses generic credential failures for unknown users, unverified users, and provider mismatches. Reset-password revokes all refresh tokens on success.

### Scalability

Access tokens are stateless JWTs. Rate limiting is Redis-backed for multi-pod safety with bounded in-memory fallback. Token cleanup is handled by MongoDB TTL indexes rather than background sweeps in the app.

### Observability

The feature emits audit events for the major auth lifecycle steps. It relies more on audit trails and structured logs than on fine-grained trace spans.

### Reliability & Failure Modes

- Lockout, verification, reset, and refresh all have explicit failure paths rather than silent fallthrough behavior.
- Reset and verification tokens are single-use and expire through TTL-backed cleanup.

### Data Lifecycle

- Verification, reset, and refresh-token records expire automatically through TTL indexes.
- Password history remains bounded by `AUTH_PASSWORD_HISTORY_COUNT` so reuse checks do not grow unbounded.

---

## 10. Testing

### Coverage Checklist Summary

#### Integration

- [x] Signup, verify, resend, login, forgot-password, and reset-password routes are covered with DB assertions.
- [x] Lockout messaging, rate limiting, password history, and token-consumption semantics are covered.
- [x] Auth services, auth store lifecycles, and page redirect behavior are covered.

#### E2E

- [x] Signup -> verify-email -> login happy paths are live-verified.
- [x] Forgot-password -> reset-password -> relogin flows are live-verified.
- [x] Lockout messaging and password-reuse prevention are live-verified.

### E2E Test Scenarios

| #   | Scenario                                                            | Status     | Test File                                     |
| --- | ------------------------------------------------------------------- | ---------- | --------------------------------------------- |
| 1   | Signup -> verify-email -> login happy path                          | PASS       | `apps/studio/src/__tests__/api-auth.test.ts`  |
| 2   | Lockout after repeated failures returns `423` with warnings         | PASS       | `apps/studio/src/__tests__/api-auth.test.ts`  |
| 3   | Forgot-password -> reset-password revokes sessions and blocks reuse | PASS       | `apps/studio/src/__tests__/api-auth.test.ts`  |
| 4   | Cross-tenant/provider-mismatch hardening                            | NOT TESTED | `docs/testing/sub-features/password-login.md` |
| 5   | MFA challenge + recovery flow                                       | NOT TESTED | `docs/testing/sub-features/password-login.md` |

### Integration Test Scenarios

| #   | Scenario                                           | Status  | Test File                                         |
| --- | -------------------------------------------------- | ------- | ------------------------------------------------- |
| 1   | Password hashing, verification, and history checks | PASS    | `apps/studio/src/__tests__/auth-services.test.ts` |
| 2   | Auth store refresh/logout lifecycle                | PASS    | `apps/studio/src/__tests__/auth-store.test.ts`    |
| 3   | Login/signup/reset page rendering and redirects    | PARTIAL | `apps/studio/src/__tests__/auth-pages.test.tsx`   |

### Unit Test Coverage

| Package       | Tests                                                                                    | Passing            |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| `apps/studio` | `api-auth.test.ts`, `auth-services.test.ts`, `auth-store.test.ts`, `auth-pages.test.tsx` | Core flows passing |

> Full testing details: [docs/testing/sub-features/password-login.md](../../testing/sub-features/password-login.md)

---

## References

- Testing docs: [docs/testing/sub-features/password-login.md](../../testing/sub-features/password-login.md)
- Related features: [Auth Profiles](../auth-profiles.md), [Environment Variables & Namespaces](../environment-variables.md)
- Config mapping: `packages/config/src/env-mapping.ts`
- Core auth defaults: `apps/studio/src/lib/auth-constants.ts`
