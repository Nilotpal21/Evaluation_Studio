# Studio Authentication Architecture

**Date**: 2026-02-19
**Status**: Implemented
**Scope**: All user-facing authentication flows in the Studio web application

**Related docs:**

- [Centralized Auth Design](plans/2026-02-22-centralized-auth-design.md) — runtime auth (JWT/SDK/API key), session ownership, RBAC
- [Session Identity Design](design/SESSION_IDENTITY_DESIGN.md) — end-user identity tiers and session resolution
- [SECURITY.md](SECURITY.md) — unified auth middleware and rate limiting
- [mongo-users.md](db/mongo-users.md) — User, RefreshToken, EmailVerificationToken, PasswordResetToken schemas

---

## Table of Contents

1. [Overview](#1-overview)
2. [Auth Flows](#2-auth-flows)
   - [Email/Password](#21-emailpassword)
   - [Google OAuth](#22-google-oauth)
   - [Microsoft OAuth](#23-microsoft-oauth)
   - [LinkedIn OAuth](#24-linkedin-oauth)
   - [SSO (SAML)](#25-sso-saml)
   - [SSO (OIDC)](#26-sso-oidc)
   - [Device Authorization (CLI)](#27-device-authorization-cli)
3. [Multi-Factor Authentication (MFA)](#3-multi-factor-authentication-mfa)
4. [Session Management](#4-session-management)
5. [Account Security](#5-account-security)
6. [Workspace & Tenant Context](#6-workspace--tenant-context)
7. [Configuration Reference](#7-configuration-reference)
8. [API Endpoint Reference](#8-api-endpoint-reference)
9. [Key Files](#9-key-files)

---

## 1. Overview

Studio supports multiple authentication methods, all converging to a JWT-based session:

```
                           ┌──────────────────┐
Email/Password ───────────►│                  │
Google OAuth ─────────────►│  Auth Endpoint   │──► JWT Access Token
Microsoft OAuth ──────────►│  (issues tokens) │    + httpOnly Refresh Cookie
LinkedIn OAuth ───────────►│                  │
SAML SSO ─────────────────►│                  │
OIDC SSO ─────────────────►│                  │
Device Auth (CLI) ────────►└──────────────────┘
```

**Principles:**

- **Tokens never in URLs.** OAuth callbacks use one-time auth codes exchanged server-side.
- **Refresh tokens in httpOnly cookies.** Access tokens returned in response body. Refresh tokens set as `httpOnly; Secure; SameSite=Lax` cookies — never exposed to JavaScript.
- **Email enumeration prevention.** Login, signup, and forgot-password all return generic responses that don't reveal whether an email is registered.
- **Timing attack protection.** Forgot-password enforces a minimum response time to prevent timing-based email enumeration.
- **Atomic token consumption.** Password reset tokens, email verification tokens, OIDC state, and SSO auth codes are all consumed atomically to prevent race conditions and replay attacks.
- **Centralized config.** Rate limits, token TTLs, OAuth URLs, password rules, and MFA settings are all read from the centralized config system (`packages/config`) with sensible fallback defaults.

---

## 2. Auth Flows

### 2.1. Email/Password

#### Signup

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/signup─────────►│                                │
  │ { email, password, name? }     │                                │
  │                                ├─validate email format──────────┤
  │                                ├─validate password strength─────┤
  │                                ├─check rate limit (5/15min/IP)──┤
  │                                ├─hash password (bcrypt, cost 12)│
  │                                ├─create user (emailVerified=false)
  │                                ├─generate verification token────┤
  │                                ├─hash token (SHA-256), store────►│
  │                                ├─send verification email─────────►
  │◄─200 { success, message }──────┤                                │
```

- Password must pass strength validation: minimum 8 characters, uppercase, lowercase, digit required (configurable). Checked against common password list.
- Returns the same success message whether the email is new or already registered (enumeration protection).
- Verification token: 64 random bytes, hashed with SHA-256 before storage. Raw token sent in email link. Token expires in 24 hours (configurable via `auth.password.verificationTokenTtlMs`).

#### Email Verification

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/verify-email───►│                                │
  │ { token }                      │                                │
  │                                ├─hash token (SHA-256)───────────┤
  │                                ├─atomic: find & mark as used────►│
  │                                │  (usedAt=null, expiresAt>now)  │
  │                                ├─set emailVerified=true──────────►│
  │                                ├─resolve tenant context─────────┤
  │                                ├─issue JWT token pair────────────┤
  │◄─200 { user, accessToken }─────┤                                │
  │  + Set-Cookie: refresh_token   │                                │
```

- Token validation is atomic (`updateMany` with condition check) — prevents TOCTOU race conditions.
- On success, the user is logged in immediately (tokens issued).
- Returns `needsOnboarding: true` if the user has no workspace yet.
- Returns `pendingInvitations` count if workspace invitations exist.

#### Login

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/login──────────►│                                │
  │ { email, password }            │                                │
  │                                ├─rate limit (10/15min/IP)───────┤
  │                                ├─normalize email────────────────┤
  │                                ├─find user by email─────────────►│
  │                                ├─check authProvider='email'─────┤
  │                                ├─check emailVerified────────────┤
  │                                ├─check account lockout──────────┤
  │                                ├─verify password (bcrypt)───────┤
  │                                │                                │
  │                                │  ┌─If password wrong──────────┐│
  │                                │  │ atomic increment + lock    ││
  │                                │  │ if count >= 5 → lock 15min ││
  │                                │  └────────────────────────────┘│
  │                                │                                │
  │                                │  ┌─If MFA enabled─────────────┐│
  │                                │  │ Set mfa_partial cookie     ││
  │                                │  │ Return { mfaRequired }     ││
  │                                │  └────────────────────────────┘│
  │                                │                                │
  │                                ├─reset failed attempts──────────►│
  │                                ├─resolve tenant context─────────┤
  │                                ├─issue JWT token pair────────────┤
  │◄─200 { user, accessToken }─────┤                                │
  │  + Set-Cookie: refresh_token   │                                │
```

- All failure cases return the same generic `"Invalid email or password"` (401) — no way to distinguish "email not found" from "wrong password" from "unverified" from "locked".
- Account lockout: after 5 failed attempts, account is locked for 15 minutes. The increment and lock are atomic (single `findOneAndUpdate`) to prevent burst bypass.
- If MFA is enabled, a partial token is set as an httpOnly cookie scoped to `/api/mfa` (5 minute TTL). The user must complete MFA verification before receiving full tokens.

#### Forgot Password

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/forgot-password►│                                │
  │ { email }                      │                                │
  │                                ├─rate limit (3/15min/email)─────┤
  │                                ├─find user (if exists)──────────►│
  │                                ├─generate reset token───────────┤
  │                                ├─hash token, store (1h TTL)─────►│
  │                                ├─send reset email────────────────►
  │                                ├─enforce min 200ms response─────┤
  │◄─200 { success, message }──────┤  (timing attack protection)   │
```

- Always returns success (even if email doesn't exist).
- Enforces minimum 200ms response time to prevent timing attacks that could reveal email existence.
- Token expires in 1 hour (configurable via `auth.password.resetTokenTtlMs`).

#### Reset Password

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/reset-password─►│                                │
  │ { token, newPassword }         │                                │
  │                                ├─rate limit (5/15min/IP)────────┤
  │                                ├─validate password strength─────┤
  │                                ├─hash token, look up────────────►│
  │                                ├─check password history──────────►│
  │                                │  (reject reuse of last 5)     │
  │                                ├─atomic: consume token──────────►│
  │                                │  (prevents TOCTOU race)       │
  │                                ├─push OLD hash to history───────►│
  │                                ├─update passwordHash────────────►│
  │                                ├─revoke all refresh tokens──────►│
  │◄─200 { success }──────────────┤                                │
```

- Password history check happens BEFORE token consumption — if the user picks a recently-used password, the token stays valid for another attempt.
- Token consumption is atomic (`updateMany` with condition) — only one concurrent request can consume the token.
- All existing refresh tokens are revoked, forcing re-login on all devices.

---

### 2.2. Google OAuth

```
Browser              Studio API            Google                 Database
  │                     │                     │                     │
  ├─GET /api/auth/google►                     │                     │
  │                     ├─generate CSRF state──┤                     │
  │                     ├─set oauth_state cookie                     │
  │◄─302 Redirect──────┤                     │                     │
  │                     │                     │                     │
  ├─(user consents at Google)────────────────►│                     │
  │                     │                     │                     │
  │◄─302 /api/auth/callback?code=X&state=Y───┤                     │
  │                     │                     │                     │
  ├─GET /api/auth/callback──────────────────►│                     │
  │                     ├─validate CSRF state──┤                     │
  │                     ├─exchange code──────►│                     │
  │                     │◄─tokens────────────┤                     │
  │                     ├─verify id_token────►│                     │
  │                     ├─find/create user────┤────────────────────►│
  │                     ├─check SSO enforcement                     │
  │                     ├─check MFA──────────┤────────────────────►│
  │                     ├─issue token pair────┤                     │
  │                     ├─store one-time auth code────────────────►│
  │◄─302 /auth/callback?code=Z──────────────┤                     │
  │                     │                     │                     │
  ├─POST /api/sso/exchange──────────────────►│                     │
  │  { code: Z }        ├─consume auth code (atomic)──────────────►│
  │◄─200 { tokens }────┤                     │                     │
```

- CSRF protection via state parameter stored in httpOnly cookie.
- One-time auth code pattern: tokens never appear in URLs. The callback stores tokens server-side behind a random code, then redirects the browser with just the code. The frontend exchanges the code for tokens via a separate API call.
- Auth codes are consumed atomically via Redis `GETDEL` (or in-memory delete for non-Redis deployments).

---

### 2.3. Microsoft OAuth

Same flow as Google with Microsoft-specific details:

- **Init route**: `GET /api/auth/microsoft` — redirects to `login.microsoftonline.com`
- **Callback route**: `GET /api/auth/microsoft/callback` — exchanges code via Microsoft token endpoint, fetches profile from MS Graph (`graph.microsoft.com/v1.0/me`)
- **Email extraction**: Uses `profile.mail` first, falls back to `profile.userPrincipalName`
- **Email verification check**: Decodes `id_token` JWT payload and rejects if `email_verified === false` (personal MS accounts may have unverified emails)
- **SSO enforcement**: Checks if user's organization requires SSO via `forceSso` flag
- **CSRF state**: Stored in `oauth_state_ms` cookie, scoped to `/api/auth/microsoft`
- **OAuth URLs**: Configurable via `oauth.microsoft.authorizeUrl` / `tokenUrl` / `profileUrl` in config schema, with HTTPS + hostname allowlist validation (SSRF protection)

---

### 2.4. LinkedIn OAuth

Same flow as Google/Microsoft with LinkedIn-specific details:

- **Init route**: `GET /api/auth/linkedin` — redirects to `linkedin.com/oauth/v2/authorization`
- **Callback route**: `GET /api/auth/linkedin/callback` — exchanges code, fetches profile from `api.linkedin.com/v2/userinfo`
- **Email verification check**: Rejects if `profile.email_verified === false`
- **Display name**: Extracted from `given_name` + `family_name` fields
- **CSRF state**: Stored in `oauth_state_li` cookie, scoped to `/api/auth/linkedin`
- **HTTP client**: Uses Node.js `https` module directly (not `fetch`) with `family: 4` to avoid ETIMEDOUT on dual-stack hosts

---

### 2.5. SSO (SAML)

```
Browser              Studio API            SAML IdP               Database
  │                     │                     │                     │
  ├─GET /api/sso/init?email=user@corp.com───►│                     │
  │                     ├─extract domain──────┤                     │
  │                     ├─lookup domain→org───┤────────────────────►│
  │                     ├─find SSO config─────┤────────────────────►│
  │                     ├─decrypt config──────┤                     │
  │◄─200 { ssoEnabled, redirectUrl }─────────┤                     │
  │                     │                     │                     │
  ├─(browser redirects to IdP SSO URL)───────►                     │
  │                     │                     │                     │
  │◄─POST /api/sso/saml/callback (SAMLResponse + RelayState)──────┤
  │                     │                     │                     │
  ├─POST /api/sso/saml/callback─────────────►│                     │
  │  (form-encoded)     ├─resolve org ID──────┤                     │
  │                     │  SP-init: from RelayState                 │
  │                     │  IdP-init: parse issuer from XML          │
  │                     ├─find SSO config─────┤────────────────────►│
  │                     ├─decrypt config──────┤                     │
  │                     ├─validate SAML assertion──────────────────►│
  │                     │  (@node-saml: signature, timestamps,     │
  │                     │   audience, wantAssertionsSigned)         │
  │                     ├─replay protection───┤────────────────────►│
  │                     │  (assertion ID dedup)│                     │
  │                     ├─extract email────────┤ (custom attribute mapping)
  │                     ├─extract display name──┤                    │
  │                     ├─find/create user─────┤───────────────────►│
  │                     ├─issue tokens─────────┤                     │
  │                     ├─store auth code───────┤───────────────────►│
  │◄─302 /auth/callback?code=Z───────────────┤                     │
```

**Key details:**

- **SP-initiated flow**: `RelayState` carries the orgId from the init endpoint.
- **IdP-initiated flow**: No RelayState — the callback parses the SAML response XML to extract the issuer, then looks up the organization by issuer URL.
- **Validation**: Uses `@node-saml/node-saml` for XML signature verification, assertion timestamp checks (NotBefore/NotOnOrAfter), and audience restriction. `wantAssertionsSigned: true` is enforced.
- **Replay protection**: Assertion IDs are tracked (in Redis or in-memory). A replayed assertion returns 400.
- **Email extraction**: Supports configurable attribute mapping. Checks `profile.email`, `profile.nameID`, then a configurable list of SAML attributes (default: `email`, `mail`, `emailAddress`, standard SAML claim URIs).
- **Config encryption**: SSO configs are encrypted at rest using `EncryptionService` with tenant-scoped DEKs. Falls back to plain JSON for backward compatibility with pre-encryption configs.

---

### 2.6. SSO (OIDC)

```
Browser              Studio API            OIDC Provider          Database
  │                     │                     │                     │
  ├─GET /api/sso/init?email=user@corp.com───►│                     │
  │                     ├─find SSO config (protocol=oidc)──────────►│
  │                     ├─generate OIDC state──┤                     │
  │                     ├─store state (CSRF)───┤───────────────────►│
  │                     ├─build authorize URL───┤                    │
  │◄─200 { ssoEnabled, redirectUrl }─────────┤                     │
  │                     │                     │                     │
  ├─(browser redirects to OIDC provider)─────►                     │
  │                     │                     │                     │
  │◄─302 /api/sso/oidc/callback?code=X&state=Y                    │
  │                     │                     │                     │
  ├─GET /api/sso/oidc/callback──────────────►│                     │
  │                     ├─consume state (atomic GETDEL)────────────►│
  │                     ├─exchange code for tokens────────────────►│
  │                     │◄─tokens────────────────────────────────┤│
  │                     ├─fetch userinfo────►│                     │
  │                     │◄─user profile──────┤                     │
  │                     ├─validate email──────┤                     │
  │                     ├─find/create user─────┤───────────────────►│
  │                     ├─issue tokens─────────┤                     │
  │                     ├─store auth code───────┤───────────────────►│
  │◄─302 /auth/callback?code=Z───────────────┤                     │
```

- **State consumption is atomic**: Uses Redis `GETDEL` to prevent race conditions where two concurrent callbacks both read the same state.
- **Config decryption**: Same pattern as SAML — encrypted at rest, fallback to plain JSON.

---

### 2.7. Device Authorization (CLI)

Implements RFC 8628 (OAuth 2.0 Device Authorization Grant) for CLI login without browser-based redirect.

```
CLI                  Studio API            Browser                Database
 │                     │                     │                     │
 ├─POST /api/auth/device─────────────────►│                     │
 │ { scopes? }         ├─generate device_code + user_code────────►│
 │◄─200 {              │  (10 min expiry)   │                     │
 │   device_code,      │                     │                     │
 │   user_code,        │                     │                     │
 │   verification_uri, │                     │                     │
 │   expires_in: 600,  │                     │                     │
 │   interval: 5       │                     │                     │
 │ }                   │                     │                     │
 │                     │                     │                     │
 │ (display user_code to user)              │                     │
 │                     │                     │                     │
 │                     │  ┌─User opens verification_uri in browser─┐
 │                     │  │                  │                     │
 │                     │  ├─GET /api/auth/device/lookup?code=ABCD─►│
 │                     │  │◄─200 { scopes }──┤────────────────────►│
 │                     │  │                  │                     │
 │                     │  ├─POST /api/auth/device/authorize────────►│
 │                     │  │ { user_code, allow: true }             │
 │                     │  │ (requires user to be logged in)        │
 │                     │  │◄─200 { success }─┤────────────────────►│
 │                     │  └────────────────────────────────────────┘
 │                     │                     │                     │
 ├─POST /api/auth/device/token──────────────►│                     │
 │ { device_code }     ├─check authorized────┤────────────────────►│
 │◄─200 {              │                     │                     │
 │   access_token,     │                     │                     │
 │   refresh_token,    │                     │                     │
 │   token_type,       │                     │                     │
 │   expires_in,       │                     │                     │
 │   scope             │                     │                     │
 │ }                   │                     │                     │
```

- CLI polls `/device/token` every 5 seconds. Returns `authorization_pending` until user authorizes.
- Device codes expire after 10 minutes. Single-use (consumed on token exchange).
- Rate limited at 12 requests per IP per minute to prevent brute-force polling.

---

## 3. Multi-Factor Authentication (MFA)

### Setup Flow

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/mfa/setup───────────►│                                │
  │  (requires auth)               ├─check MFA not already enabled──►│
  │                                ├─generate TOTP secret (20 bytes, base32)
  │                                ├─encrypt secret (tenant DEK)─────►│
  │                                ├─generate 10 recovery codes──────┤
  │                                │  (8 chars, A-Z 2-9 excl O/0/I/1)
  │                                ├─hash recovery codes (bcrypt 10)──►│
  │                                ├─store unverified MFA────────────►│
  │◄─200 { secret, otpauthUrl,    │                                │
  │        recoveryCodes[] }───────┤                                │
  │                                │                                │
  │ (user scans QR code, enters first TOTP code)                   │
  │                                │                                │
  ├─POST /api/mfa/verify──────────►│                                │
  │  { type: 'setup', code }       ├─verify TOTP code───────────────┤
  │                                │  (timing-safe comparison)     │
  │                                ├─mark MFA as verified/enabled──►│
  │◄─200 { success }──────────────┤                                │
```

### Login with MFA

```
Browser                          Studio API                       Database
  │                                │                                │
  ├─POST /api/auth/login──────────►│                                │
  │ { email, password }            ├─(password verified OK)─────────┤
  │                                ├─check MFA enabled──────────────►│
  │◄─200 { mfaRequired: true }────┤                                │
  │  + Set-Cookie: mfa_partial     │  (httpOnly, 5min TTL,         │
  │    (path=/api/mfa)             │   scoped to /api/mfa)         │
  │                                │                                │
  ├─POST /api/mfa/verify──────────►│                                │
  │  { type: 'totp', code }        ├─read mfa_partial cookie────────┤
  │  + Cookie: mfa_partial         ├─verify TOTP (±30s window)─────┤
  │                                ├─issue full token pair──────────┤
  │◄─200 { accessToken }──────────┤                                │
  │  + Set-Cookie: refresh_token   │                                │
```

### TOTP Verification Details

- **Algorithm**: HMAC-SHA1 per RFC 6238
- **Digits**: 6
- **Period**: 30 seconds
- **Window**: ±1 period (accepts codes from previous, current, and next 30-second interval)
- **Comparison**: `crypto.timingSafeEqual` to prevent timing side-channels
- **Secret storage**: Encrypted with `EncryptionService` using tenant-scoped DEKs

### Recovery Codes

- 10 codes generated at MFA setup
- 8 characters each, using non-ambiguous charset: `A-Z, 2-9` (excludes `O`, `0`, `I`, `1`)
- Hashed with bcrypt (cost 10) before storage
- Single-use: marked with `usedAt` timestamp on consumption
- Using a recovery code resets the failed attempt counter (unlocks account if locked)
- Can be regenerated via `POST /api/mfa/regenerate` (invalidates all previous codes)

### MFA Lockout

- After 10 consecutive failed TOTP/recovery verifications, the MFA is locked for 30 minutes.
- Successful recovery code use resets the counter.
- Lockout is tracked separately from login lockout.

---

## 4. Session Management

### Token Architecture

| Token                  | Storage                           | Lifetime                     | Purpose                                  |
| ---------------------- | --------------------------------- | ---------------------------- | ---------------------------------------- |
| **Access token** (JWT) | Response body / client memory     | Configurable (default 15min) | API authorization                        |
| **Refresh token**      | httpOnly cookie (`/` path)        | 7 days (configurable)        | Silent token renewal                     |
| **MFA partial token**  | httpOnly cookie (`/api/mfa` path) | 5 minutes                    | MFA verification step                    |
| **One-time auth code** | Redis / in-memory                 | 60 seconds                   | OAuth callback → frontend token exchange |

### Token Refresh

`POST /api/auth/refresh` — rate limited at 30 requests per IP per minute.

- Accepts refresh token from httpOnly cookie OR request body (supports both browser and programmatic flows).
- Cookie flow: returns new access token in body, sets new refresh cookie.
- Body flow: returns both tokens in body (for CLI/SDK clients).

### Logout

`POST /api/auth/logout` — revokes refresh tokens and clears cookies.

- Revokes token from cookie and body (handles both).
- Clears refresh_token cookie at current path (`/`) and legacy path (`/api/auth`).

### Current User

`GET /api/auth/me` — returns authenticated user's profile (id, email, name, isSuperAdmin).

---

## 5. Account Security

### Rate Limiting

All rate limits are configurable via `auth.rateLimits.*` in the config schema.

| Endpoint               | Key   | Default     | Window |
| ---------------------- | ----- | ----------- | ------ |
| Login                  | IP    | 10 attempts | 15 min |
| Signup                 | IP    | 5 attempts  | 15 min |
| Forgot Password        | email | 3 attempts  | 15 min |
| Reset Password         | IP    | 5 attempts  | 15 min |
| Verify Email           | IP    | 10 attempts | 15 min |
| Resend Verification    | IP    | 3 attempts  | 15 min |
| Refresh                | IP    | 30 attempts | 1 min  |
| Device Token (polling) | IP    | 12 attempts | 1 min  |
| MFA Recovery           | IP    | 5 attempts  | 15 min |
| Create Workspace       | user  | 5 attempts  | 1 hour |
| SSO Domains            | user  | 10 attempts | 1 hour |

### Account Lockout

- **Trigger**: 5 consecutive failed login attempts (configurable via `auth.lockout.maxFailedAttempts`)
- **Duration**: 15 minutes (configurable via `auth.lockout.lockDurationMs`)
- **Implementation**: Atomic `findOneAndUpdate` — increment counter and set lock in a single operation to prevent burst bypass
- **Reset**: Counter resets to 0 on successful login
- **Response**: Same generic error as all other login failures (no enumeration)

### Password Policy

Configurable via `auth.password.*`:

| Rule                  | Default    | Config Key                     |
| --------------------- | ---------- | ------------------------------ |
| Minimum length        | 8          | `password.minLength`           |
| Maximum length        | 128        | `validation.maxPasswordLength` |
| Require uppercase     | true       | `password.requireUppercase`    |
| Require lowercase     | true       | `password.requireLowercase`    |
| Require digit         | true       | `password.requireDigit`        |
| Require special char  | false      | `password.requireSpecialChar`  |
| Common password check | 20 entries | `password.commonPasswords`     |
| History count         | 5          | `password.historyCount`        |
| Bcrypt cost           | 12         | `password.bcryptCost`          |

### Password History

- On password reset, the OLD password hash is pushed to history before overwriting.
- History uses MongoDB `$push` with `$slice: -N` for atomic capped array.
- New passwords are checked against the current hash + last N history entries.
- If a recently-used password is chosen, the reset token is NOT consumed (user can retry).

### Email Verification

- Required for email/password accounts. Unverified users cannot log in.
- Verification token: 64 random bytes → SHA-256 hash stored in DB. Raw token in email link.
- Token TTL: 24 hours (configurable).
- Atomic consumption prevents TOCTOU race conditions.
- Resend endpoint: `POST /api/auth/resend-verification` (rate limited 3/15min).

### OAuth Security

- **CSRF**: State parameter stored in httpOnly cookie, validated on callback.
- **Email verification**: Microsoft and LinkedIn callbacks reject `email_verified === false`.
- **One-time auth codes**: Tokens never appear in redirect URLs. Consumed atomically via Redis `GETDEL`.
- **SSRF protection**: OAuth URL config fields validated with HTTPS requirement + hostname allowlist (e.g., `login.microsoftonline.com`, `graph.microsoft.com` for Microsoft).
- **SSO enforcement**: OAuth callbacks check if the user's organization requires SSO (`forceSso` flag). If so, non-SSO login is blocked.

### SSO Config Encryption

- SSO configurations (client secrets, certificates) are encrypted at rest using `EncryptionService` with tenant-scoped Data Encryption Keys (DEKs).
- Decryption happens on-demand during SSO flows.
- Backward compatibility: falls back to plain JSON for configs stored before encryption was added.

---

## 6. Workspace & Tenant Context

### Create Workspace

`POST /api/auth/create-workspace` — requires authentication.

- Validates name (2-100 chars).
- Enforces per-user workspace limit (default 10, configurable via `auth.workspace.maxPerUser`).
- Generates URL-safe slug. Appends timestamp suffix on collision.
- Creates tenant + user membership (OWNER role).
- Issues new token pair scoped to the new workspace.
- Rate limited: 5 per user per hour.

### Tenant Switching

- `GET /api/auth/tenants` — list user's workspaces
- `POST /api/auth/tenants/switch` — switch active workspace (re-issues tokens)

### SSO Domain Claims

`POST /api/sso/domains` — OWNER/ADMIN only.

- Claim a domain for SSO (e.g., `corp.com`).
- DNS verification required: add TXT record `_kore-verification.corp.com` with generated token.
- Prevents duplicate domain claims (409 Conflict).

---

## 7. Configuration Reference

All auth configuration lives in `packages/config/src/schemas/auth.schema.ts` and `oauth.schema.ts`.

### Environment Variables

| Variable                  | Purpose                                | Used By                     |
| ------------------------- | -------------------------------------- | --------------------------- |
| `GOOGLE_CLIENT_ID`        | Google OAuth client ID                 | Google callback             |
| `GOOGLE_CLIENT_SECRET`    | Google OAuth client secret             | Google callback             |
| `MICROSOFT_CLIENT_ID`     | Microsoft OAuth client ID              | Microsoft init/callback     |
| `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth client secret          | Microsoft init/callback     |
| `MICROSOFT_TENANT_ID`     | Microsoft tenant (default: `common`)   | Microsoft init/callback     |
| `LINKEDIN_CLIENT_ID`      | LinkedIn OAuth client ID               | LinkedIn init/callback      |
| `LINKEDIN_CLIENT_SECRET`  | LinkedIn OAuth client secret           | LinkedIn init/callback      |
| `FRONTEND_URL`            | Frontend base URL for redirects/emails | All OAuth callbacks, emails |

### Config Schema Keys

```
auth:
  rateLimits:
    login:            { maxAttempts: 10, windowMs: 900000 }
    signup:           { maxAttempts: 5,  windowMs: 900000 }
    forgotPassword:   { maxAttempts: 3,  windowMs: 900000 }
    resetPassword:    { maxAttempts: 5,  windowMs: 900000 }
    verifyEmail:      { maxAttempts: 10, windowMs: 900000 }
    resendVerification: { maxAttempts: 3, windowMs: 900000 }
    refresh:          { maxAttempts: 30, windowMs: 60000 }
    deviceToken:      { maxAttempts: 12, windowMs: 60000 }
    mfaRecovery:      { maxAttempts: 5,  windowMs: 900000 }
    createWorkspace:  { maxAttempts: 5,  windowMs: 3600000 }
    ssoDomains:       { maxAttempts: 10, windowMs: 3600000 }
  tokens:
    refreshCookieMaxAgeSeconds: 604800  # 7 days
    mfaCookieMaxAgeSeconds: 300         # 5 minutes
  password:
    minLength: 8
    bcryptCost: 12
    historyCount: 5
    verificationTokenTtlMs: 86400000   # 24 hours
    resetTokenTtlMs: 3600000           # 1 hour
  lockout:
    maxFailedAttempts: 5
    lockDurationMs: 900000             # 15 minutes
  mfa:
    totpWindow: 1
    totpDigits: 6
    totpPeriod: 30
    recoveryCodeCount: 10
    recoveryCodeLength: 8
    lockThreshold: 10
    lockDurationMs: 1800000            # 30 minutes
  sso:
    oidcStateTtlSeconds: 600
    authCodeTtlSeconds: 60
    samlAssertionTtlSeconds: 3600
  workspace:
    maxPerUser: 10
  validation:
    maxEmailLength: 254
    maxPasswordLength: 128
    emailRegex: '^[^\s@]+@[^\s@]+\.[^\s@]+$'

oauth:
  google:   { clientId, clientSecret }
  microsoft:
    clientId, clientSecret, tenantId
    authorizeUrl, tokenUrl, profileUrl   # HTTPS + hostname allowlist
    scope: 'openid email profile User.Read'
    stateCookieTtlSeconds: 600
  linkedin:
    clientId, clientSecret
    authorizeUrl, tokenUrl, profileUrl   # HTTPS + hostname allowlist
    scope: 'openid profile email'
    stateCookieTtlSeconds: 600
```

---

## 8. API Endpoint Reference

| Method | Path                            | Auth | Purpose                      |
| ------ | ------------------------------- | ---- | ---------------------------- |
| POST   | `/api/auth/signup`              | No   | Email/password registration  |
| POST   | `/api/auth/login`               | No   | Email/password login         |
| POST   | `/api/auth/verify-email`        | No   | Verify email with token      |
| POST   | `/api/auth/resend-verification` | No   | Resend verification email    |
| POST   | `/api/auth/forgot-password`     | No   | Request password reset       |
| POST   | `/api/auth/reset-password`      | No   | Reset password with token    |
| POST   | `/api/auth/refresh`             | No   | Refresh access token         |
| POST   | `/api/auth/logout`              | No   | Revoke tokens, clear cookies |
| GET    | `/api/auth/me`                  | Yes  | Get current user profile     |
| GET    | `/api/auth/tenants`             | Yes  | List user's workspaces       |
| POST   | `/api/auth/tenants/switch`      | Yes  | Switch workspace             |
| POST   | `/api/auth/create-workspace`    | Yes  | Create new workspace         |
| GET    | `/api/auth/google`              | No   | Google OAuth redirect        |
| GET    | `/api/auth/callback`            | No   | Google OAuth callback        |
| GET    | `/api/auth/microsoft`           | No   | Microsoft OAuth redirect     |
| GET    | `/api/auth/microsoft/callback`  | No   | Microsoft OAuth callback     |
| GET    | `/api/auth/linkedin`            | No   | LinkedIn OAuth redirect      |
| GET    | `/api/auth/linkedin/callback`   | No   | LinkedIn OAuth callback      |
| POST   | `/api/auth/device`              | No   | Start device auth flow       |
| GET    | `/api/auth/device/lookup`       | No   | Check device code status     |
| POST   | `/api/auth/device/authorize`    | Yes  | Authorize device             |
| POST   | `/api/auth/device/token`        | No   | Exchange device code         |
| GET    | `/api/sso/init`                 | No   | Detect SSO for email domain  |
| POST   | `/api/sso/saml/callback`        | No   | SAML assertion callback      |
| GET    | `/api/sso/oidc/callback`        | No   | OIDC authorization callback  |
| POST   | `/api/sso/domains`              | Yes  | Claim domain for SSO         |
| POST   | `/api/mfa/setup`                | Yes  | Generate TOTP secret         |
| POST   | `/api/mfa/verify`               | Yes  | Verify TOTP/recovery code    |
| POST   | `/api/mfa/recovery`             | No\* | Login via recovery code      |

\*Accepts auth OR MFA-pending partial token.

---

## 9. Key Files

### Route Handlers

| File                                                       | Purpose                  |
| ---------------------------------------------------------- | ------------------------ |
| `apps/studio/src/app/api/auth/login/route.ts`              | Email/password login     |
| `apps/studio/src/app/api/auth/signup/route.ts`             | Registration             |
| `apps/studio/src/app/api/auth/verify-email/route.ts`       | Email verification       |
| `apps/studio/src/app/api/auth/forgot-password/route.ts`    | Password reset request   |
| `apps/studio/src/app/api/auth/reset-password/route.ts`     | Password reset execution |
| `apps/studio/src/app/api/auth/refresh/route.ts`            | Token refresh            |
| `apps/studio/src/app/api/auth/callback/route.ts`           | Google OAuth callback    |
| `apps/studio/src/app/api/auth/microsoft/route.ts`          | Microsoft OAuth init     |
| `apps/studio/src/app/api/auth/microsoft/callback/route.ts` | Microsoft OAuth callback |
| `apps/studio/src/app/api/auth/linkedin/route.ts`           | LinkedIn OAuth init      |
| `apps/studio/src/app/api/auth/linkedin/callback/route.ts`  | LinkedIn OAuth callback  |
| `apps/studio/src/app/api/auth/device/route.ts`             | Device auth init         |
| `apps/studio/src/app/api/auth/device/token/route.ts`       | Device token exchange    |
| `apps/studio/src/app/api/sso/init/route.ts`                | SSO flow detection       |
| `apps/studio/src/app/api/sso/saml/callback/route.ts`       | SAML assertion handler   |
| `apps/studio/src/app/api/sso/oidc/callback/route.ts`       | OIDC callback handler    |
| `apps/studio/src/app/api/mfa/setup/route.ts`               | MFA enrollment           |
| `apps/studio/src/app/api/mfa/verify/route.ts`              | MFA verification         |
| `apps/studio/src/app/api/mfa/recovery/route.ts`            | MFA recovery login       |

### Services & Libraries

| File                                                | Purpose                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/studio/src/services/auth/password-service.ts` | Password hashing, strength validation, history check                                         |
| `apps/studio/src/services/auth/mfa-service.ts`      | TOTP generation/verification, recovery codes                                                 |
| `apps/studio/src/services/auth-service.ts`          | Token pair creation, user find/create, tenant context                                        |
| `apps/studio/src/repos/auth-repo.ts`                | MongoDB operations (users, tokens, lockout, history)                                         |
| `apps/studio/src/lib/auth-constants.ts`             | Centralized constants: SAML attributes, Redis prefixes, MFA charsets, OAuth cookie names     |
| `apps/studio/src/lib/auth-helpers.ts`               | Shared helpers: `getFrontendUrl`, `getEmailRegex`, `getMicrosoftConfig`, `getLinkedInConfig` |
| `apps/studio/src/lib/sso-helpers.ts`                | Shared SSO helper: `decryptSSOConfig`                                                        |
| `apps/studio/src/lib/sso-auth-codes.ts`             | One-time auth code store/consume                                                             |
| `apps/studio/src/lib/sso-state-store.ts`            | OIDC state store/consume                                                                     |
| `apps/studio/src/services/sso/sso-state-store.ts`   | Redis/in-memory hybrid store for SSO state, auth codes, SAML assertions                      |
| `apps/studio/src/lib/redis-client.ts`               | Redis singleton for Studio                                                                   |
| `apps/studio/src/lib/rate-limit.ts`                 | Rate limiting implementation                                                                 |
| `apps/studio/src/lib/token-hash.ts`                 | SHA-256 token hashing                                                                        |
| `apps/studio/src/lib/oauth-http.ts`                 | HTTPS client for OAuth (IPv4-first)                                                          |
| `apps/studio/src/services/encryption-service.ts`    | Encryption service (tenant-scoped DEKs)                                                      |
| `apps/studio/src/services/audit-service.ts`         | Audit event logging                                                                          |

### Constants

All hardcoded values are centralized in `apps/studio/src/lib/auth-constants.ts`:

| Constant Group           | Examples                                                     | Used By                    |
| ------------------------ | ------------------------------------------------------------ | -------------------------- |
| SAML attribute mappings  | `SAML_EMAIL_ATTRIBUTES`, `SAML_FIRST_NAME_ATTRIBUTES`        | SAML callback              |
| SAML identifiers         | `SAML_ISSUER_REGEX`, `SAML_DEFAULT_ENTITY_ID`                | SAML callback              |
| SSO provider prefixes    | `SSO_SAML_PROVIDER_PREFIX`, `SSO_OIDC_PROVIDER_PREFIX`       | SAML/OIDC callbacks        |
| Redis key prefixes       | `REDIS_PREFIX_SAML_ASSERTION`, `REDIS_PREFIX_OIDC_STATE`     | SSO state store            |
| MFA character sets       | `MFA_RECOVERY_CHARS`, `BASE32_CHARS`                         | MFA service                |
| OAuth HTTP settings      | `OAUTH_HTTP_TIMEOUT_MS`, `OAUTH_HTTP_IP_FAMILY`              | OAuth HTTP client          |
| OAuth cookie names/paths | `OAUTH_STATE_COOKIE_LINKEDIN`, `OAUTH_COOKIE_PATH_MICROSOFT` | OAuth init/callback routes |
| MFA cookie names/paths   | `MFA_PARTIAL_COOKIE_NAME`, `MFA_COOKIE_PATH`                 | OAuth/MFA callback routes  |

### Config Schemas

| File                                          | Purpose                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `packages/config/src/schemas/auth.schema.ts`  | Rate limits, tokens, password, lockout, MFA, SSO, workspace config |
| `packages/config/src/schemas/oauth.schema.ts` | Google, Microsoft, LinkedIn OAuth config with URL validation       |

### Build Configuration

| File                          | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `apps/studio/next.config.mjs` | Webpack externals for `@agent-platform/database` (prevents OverwriteModelError) |

**Webpack externals for database package**: `@agent-platform/shared` is in `transpilePackages` and its compiled dist imports `@agent-platform/database/models`. Without the webpack externals fix, webpack follows this import chain and bundles Mongoose models into each route's chunk, causing `OverwriteModelError: Cannot overwrite 'User' model once compiled` when multiple routes load in the same process. The fix in `next.config.mjs` uses an async externals function with `import` type (not `commonjs`, since the database package is ESM-only) to force `@agent-platform/database` as a native import, ensuring models are registered exactly once.
