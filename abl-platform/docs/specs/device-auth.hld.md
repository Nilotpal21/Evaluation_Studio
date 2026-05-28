# HLD: Device Authorization (RFC 8628)

**Feature**: Device Authorization
**Status**: BETA
**Author**: Platform team
**Date**: 2026-03-23
**Feature Spec**: [docs/features/device-auth.md](../features/device-auth.md)
**Test Spec**: [docs/testing/device-auth.md](../testing/device-auth.md)

---

## 1. Problem Statement

CLI tools and MCP (Model Context Protocol) clients are headless -- they have no browser for interactive login. Traditional API keys are long-lived secrets that are harder to manage, rotate, and audit. The platform needs a secure, time-limited authentication mechanism where users approve access from a familiar browser context.

The OAuth 2.0 Device Authorization Grant (RFC 8628) solves this by decoupling the authentication surface (browser) from the client surface (CLI/terminal). The user approves a device code in Studio, and the CLI receives time-limited JWT tokens via polling.

---

## 2. Alternatives Considered

### Alternative A: Long-Lived API Keys Only

**Description**: CLI tools authenticate using manually-created API keys with no browser-based approval flow.

**Pros**:

- Simplest implementation (already exists in the platform via `abl_*` keys)
- No new endpoints, UI pages, or database models
- Works offline (no browser needed)

**Cons**:

- Long-lived secrets are higher risk if compromised (no automatic expiry)
- Manual key management burden on developers
- No per-session scope control
- No audit trail of when a specific session was authorized

**Effort**: None (already exists)

### Alternative B: OAuth 2.0 Authorization Code Flow with PKCE

**Description**: CLI opens a local HTTP server, redirects user to browser for auth, receives callback with authorization code.

**Pros**:

- Industry-standard OAuth 2.0 flow
- Tighter security (PKCE prevents interception)
- Immediate token delivery (no polling)

**Cons**:

- Requires local HTTP server on CLI side (port binding issues)
- Complex redirect URI handling (localhost ports, deep links)
- Poor UX in remote/SSH sessions where localhost is not accessible
- Not suitable for truly headless environments (Docker containers, CI pipelines)

**Effort**: L (local HTTP server, redirect handling, PKCE)

### Alternative C: Device Authorization Grant (RFC 8628) -- Chosen

**Description**: CLI requests a device code, user enters the code in a browser page, CLI polls for tokens.

**Pros**:

- Works in all environments (SSH, Docker, CI, headless)
- No local server or redirect URIs needed
- User-friendly (type a short code in browser)
- Time-limited codes (15-minute expiry)
- Industry standard (RFC 8628)

**Cons**:

- Requires polling (slight latency vs. callback)
- Rate limiting needed for poll endpoint
- Additional UI page in Studio

**Effort**: M (4 endpoints, 1 model, 1 UI page)

### Recommendation: Alternative C

RFC 8628 Device Authorization Grant is the right choice because it works in all headless environments (the primary use case), requires no complex redirect infrastructure, and provides a clean UX. The polling overhead is minimal with a 5-second interval.

---

## 3. Architecture

### Data Flow

```
[CLI / MCP Client]
    |
    |--- POST /api/auth/device ---> { device_code (raw), user_code }
    |                                       |
    |                                       v
    |                              [MongoDB: device_auth_requests]
    |                              (deviceCode = SHA-256 hash)
    |
    |   [User opens verification_uri in browser]
    |          |
    |          v
    |   [Studio DeviceAuth page (/auth/device)]
    |          |--- GET /api/auth/device/lookup?code=XXXX-XXXX ---> display scopes
    |          |--- POST /api/auth/device/authorize (JWT auth) ---> approve/deny
    |          |                                                         |
    |          |                                                         v
    |          |                                              [MongoDB: set userId, authorizedAt]
    |
    |--- POST /api/auth/device/token (poll, rate-limited)
    |          |
    |          v
    |   [authorization_pending (428)] -> keep polling
    |   [authorized] -> issue JWT access + refresh token, mark consumedAt
    |   [expired (410)] -> flow expired
    |   [consumed (409)] -> already used
```

### Packages Changed

- `apps/runtime` -- device auth routes (`device-auth.ts`) and service (`device-auth-service.ts`)
- `apps/studio` -- DeviceAuth browser page (`DeviceAuth.tsx`)
- `packages/database` -- DeviceAuthRequest Mongoose model (`device-auth-request.model.ts`)

### Key Integration Points

- **DeviceAuthRequest model**: MongoDB with TTL index for auto-cleanup (15min), UUIDv7 `_id`, unique indexes on `deviceCode` and `userCode`
- **JWT utilities**: `resolveFirstMembership`, `buildAccessTokenPayload`, `signAccessToken`, `createStoredRefreshToken` from `jwt-utils.ts`
- **Auth middleware**: `authMiddleware` from `middleware/auth.ts` for the `authorize` endpoint (wraps `createUnifiedAuthMiddleware` + `requireAuth`)
- **OpenAPI registration**: Routes registered via `createOpenAPIRouter` from `@agent-platform/openapi/express`
- **Studio page**: React component at `/auth/device` with `useAuthStore`, `useTranslations`, `KoreIcon`

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 4.1 Tenant Isolation

Device auth requests are **not tenant-scoped**. The `device_auth_requests` collection has no `tenantId` field. Tenant context is resolved only at token issuance time via `resolveFirstMembership(user.id)`, which finds the user's first tenant membership and builds the JWT payload accordingly.

**Justification**: Device codes are tied to users, not tenants. A user authenticates their CLI tool, and the tenant is resolved from their membership. This is correct for the device auth use case where the CLI tool does not know which tenant to target at initiation time.

**Risk**: If a user has multiple tenant memberships, `resolveFirstMembership` picks the first one non-deterministically. The CLI has no way to specify which tenant it wants access to.

#### 4.2 Data Access Pattern

- **Direct model access**: The service layer uses dynamic `import('@agent-platform/database/models')` for lazy loading of the `DeviceAuthRequest` model.
- **No repository layer**: Unlike other features (auth-repo, session-repo), device auth has no dedicated repository. Service functions directly call Mongoose methods (`create`, `findOne`, `updateOne`).
- **No caching**: Device auth requests are not cached. Each lookup and poll hits MongoDB directly. This is acceptable given the short-lived nature (15 minutes) and low request volume.

#### 4.3 API Contract

Four endpoints, all under `/api/auth/device`:

| Endpoint        | Auth Required     | Request Shape                  | Success Response                                                                                | Error Responses              |
| --------------- | ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| POST /          | No                | `{ scopes?: string[] }`        | `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }` | 500                          |
| GET /lookup     | No                | `?code=XXXX-XXXX`              | `{ userCode, scopes, expiresAt }`                                                               | 400, 404, 409, 410, 500      |
| POST /authorize | Yes (JWT)         | `{ user_code, allow }`         | `{ success, message? }`                                                                         | 400, 401, 404, 500           |
| POST /token     | No (rate-limited) | `{ device_code, grant_type? }` | `{ access_token, refresh_token, token_type, expires_in, scope }`                                | 400, 409, 410, 428, 429, 500 |

**Error envelope**: Routes do NOT consistently use the platform's `{ success, data?, error?: { code, message } }` envelope. Initiate uses `{ error: string }`. Token uses RFC 8628 `{ error, error_description }`. Authorize uses `{ error: string }`. This should be standardized.

#### 4.4 Security Surface

- **Device code hashing**: SHA-256 hash before storage; raw code returned to CLI once, never persisted
- **User code entropy**: 8 characters from 28-char alphabet = 28^8 = ~28 billion combinations
- **Rate limiting**: 12 req/min per IP on token endpoint (in-memory, per-pod)
- **Auth on authorize**: JWT authentication required via `authMiddleware`
- **Code expiry**: 15-minute TTL with MongoDB auto-cleanup
- **No CSRF protection**: The authorize endpoint relies on JWT auth header, not cookies, so CSRF is not applicable
- **Input validation**: Zod schemas on all endpoints via `createOpenAPIRouter`
- **Missing**: Audit logging for security events, IP logging on authorize, brute-force protection on user code lookup

### Behavioral Concerns

#### 4.5 Error Model

| Scenario                | HTTP Status | Error Code              | User-Facing Message                                        | Recovery Path             |
| ----------------------- | ----------- | ----------------------- | ---------------------------------------------------------- | ------------------------- |
| Device code not found   | 410         | `expired_token`         | "Device code has expired. Start a new authorization flow." | Restart flow              |
| Code expired            | 410         | `expired_token`         | "Code expired"                                             | Restart flow              |
| Code already authorized | 409         | N/A                     | "Code already authorized"                                  | Use different code        |
| Code already consumed   | 409         | `token_already_used`    | "This device code has already been used."                  | Restart flow              |
| Authorization pending   | 428         | `authorization_pending` | "User has not yet authorized this device."                 | Keep polling              |
| Rate limited            | 429         | `slow_down`             | "Too many requests. Wait before polling again."            | Increase polling interval |
| Missing parameters      | 400         | `invalid_request`       | "Missing device_code" / "Missing code"                     | Fix request               |
| Internal error          | 500         | `server_error`          | "Token exchange failed" / "Failed to create..."            | Retry                     |

#### 4.6 Failure Modes

- **MongoDB down**: All operations fail with 500. No fallback. Device auth is non-critical (not in the agent execution path), so this is acceptable.
- **JWT secret misconfigured**: Token creation fails at `signAccessToken`. Returns 500 on the token endpoint.
- **Rate limiter memory**: In-memory Map with no max-size cap. Under sustained attack from many IPs, this could grow unboundedly (GAP-008). The 5-minute cleanup interval provides some mitigation.
- **Network partition**: No concern -- all operations are single-request, single-database. No distributed coordination needed.

#### 4.7 Idempotency

- **POST /device (initiate)**: NOT idempotent. Each call creates a new device auth request. This is correct per RFC 8628.
- **GET /lookup**: Idempotent (read-only).
- **POST /authorize**: Partially idempotent. The atomic `updateOne` with `{ authorizedAt: null }` filter ensures only the first authorize succeeds. Subsequent calls return 404.
- **POST /token (poll)**: NOT idempotent. The consume step marks the record as consumed, so the first successful poll gets tokens and subsequent polls get 409. **Risk**: TOCTOU race where the find + update are not atomic (GAP-007).

#### 4.8 Observability

**Current state**: Poor. Device auth routes use `console.error` for error logging, violating the platform's `createLogger` requirement.

**What's needed**:

- Replace `console.error` with `createLogger('device-auth')` (GAP-003)
- Emit audit events: `device_auth.initiated`, `device_auth.authorized`, `device_auth.denied`, `device_auth.token_issued`, `device_auth.expired` (GAP-009)
- Add trace context for correlation with downstream JWT usage
- Log client IP and user agent on all operations

### Operational Concerns

#### 4.9 Performance Budget

| Operation  | Expected Latency | Expected Volume | Notes                                   |
| ---------- | ---------------- | --------------- | --------------------------------------- |
| Initiate   | < 50ms           | ~100/day        | Single DB insert                        |
| Lookup     | < 30ms           | ~100/day        | Single DB read                          |
| Authorize  | < 50ms           | ~100/day        | Single atomic DB update                 |
| Token poll | < 100ms          | ~1000/day       | DB read + conditional update + JWT sign |

Device auth is a low-volume feature. Performance is not a concern at current scale.

#### 4.10 Migration Path

**Current state**: Device auth is fully implemented and operational. No migration needed.

**Future migrations**:

- If rate limiting moves to Redis: add Redis dependency, migrate Map to `SET NX PX` pattern
- If scopes become enforced: add middleware that checks JWT scope claims against endpoint requirements
- If tenant selection is needed: add `tenantId` parameter to initiate endpoint, validate against user's memberships

#### 4.11 Rollback Plan

Device auth is a standalone feature with no dependencies from other features. Rollback is:

1. Remove device auth route registration from the runtime app
2. No data migration needed (TTL auto-cleans records)
3. No downstream impact (no other feature depends on device auth tokens being available)

#### 4.12 Test Strategy

| Layer       | Coverage | Target | Notes                                                                |
| ----------- | -------- | ------ | -------------------------------------------------------------------- |
| Unit        | Service  | 90%    | All service functions covered with mocked DB                         |
| Unit        | Routes   | 85%    | All endpoints covered with mocked service (mock discrepancy on auth) |
| Integration | DB       | 0%     | TOCTOU race, TTL cleanup, hash verification needed                   |
| E2E         | Flow     | 0%     | Full CLI-to-browser-to-token flow needed                             |

**Target**: 10 E2E scenarios (E1-E10) + 7 integration scenarios (I1-I7) as documented in the test spec.

---

## 5. Decisions & Tradeoffs

| #   | Decision                                  | Tradeoff                                                               | Rationale                                                   |
| --- | ----------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | SHA-256 hash device codes before storage  | Cannot recover raw code from DB (one-way)                              | Security: DB compromise does not expose valid codes         |
| 2   | User codes use restricted charset         | Smaller entropy (28 vs 36 chars) but 28^8 is still >28B combinations   | Usability: no ambiguous 0/O/1/I when typing from terminal   |
| 3   | In-memory rate limiter (not Redis)        | Per-pod limits only, not global; unbounded Map growth under attack     | Simplicity: low-volume feature, Redis adds operational cost |
| 4   | 15-minute code expiry                     | Short window may be inconvenient if user is slow to approve            | Security: limits window of exposure for unattended codes    |
| 5   | No tenant scoping on device codes         | User with multiple tenants gets first membership non-deterministically | Simplicity: CLI does not know tenant at initiation time     |
| 6   | No repository layer for device auth       | Service talks directly to Mongoose model                               | Simplicity: 4 simple operations, low complexity             |
| 7   | Dynamic import of DeviceAuthRequest model | Lazy loading avoids circular dependency, adds import overhead          | Required for ESM module resolution in the runtime           |

---

## 6. Task Decomposition

| Task                                                 | Package(s)        | Independent?  | Est. Files | Status |
| ---------------------------------------------------- | ----------------- | ------------- | ---------- | ------ |
| T-1: DeviceAuthRequest model                         | packages/database | Yes           | 1          | DONE   |
| T-2: Device auth service                             | apps/runtime      | No (T-1)      | 1          | DONE   |
| T-3: Device auth routes                              | apps/runtime      | No (T-2)      | 1          | DONE   |
| T-4: Studio DeviceAuth page                          | apps/studio       | No (T-3)      | 1          | DONE   |
| T-5: Hardening (logger, audit, TOCTOU, rate limiter) | apps/runtime      | No (T-2, T-3) | 2          | TODO   |
| T-6: E2E tests                                       | apps/runtime      | No (T-1..T-4) | 1          | TODO   |
| T-7: Integration tests                               | apps/runtime      | No (T-1..T-4) | 1          | TODO   |

---

## 7. Open Questions

1. Should users be able to select which tenant they authenticate to during the device flow?
2. Should the rate limiter be moved to Redis for multi-pod deployments, or is per-pod sufficient?
3. Should scopes be enforced at the middleware level (scope-based access control)?
4. Should deny actions be persisted in the database for audit purposes?
5. Should there be an API to list/revoke active device authorization requests per user?

---

## 8. Out of Scope

- PKCE (not applicable to device flow per RFC 8628)
- Client credentials flow
- Scope enforcement at API resource level
- Admin management UI for device authorizations
- Distributed (Redis-backed) rate limiting
- Refresh token rotation on device token usage
- Multi-tenant selection during device flow
