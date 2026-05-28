# Feature: Device Authorization (RFC 8628)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `enterprise`, `integrations`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`
**Owner(s)**: Platform team
**Testing Guide**: `../testing/device-auth.md`
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

CLI tools and MCP (Model Context Protocol) clients need to authenticate with the platform, but they lack a browser for interactive login. Traditional API key approaches are less secure (long-lived secrets) and less convenient (manual key management). The OAuth 2.0 Device Authorization Grant (RFC 8628) solves this by allowing headless clients to authenticate through a browser-based approval flow.

### Goal Statement

Implement the full OAuth 2.0 Device Authorization Grant flow (RFC 8628) for CLI/MCP tool authentication, including device code generation, browser-based approval, token polling, and JWT access/refresh token issuance.

### Summary

Device Auth provides a 4-endpoint flow: (1) CLI requests a device code via `POST /api/auth/device`, (2) user enters the code on a Studio authorization page at `/auth/device`, (3) user approves the device via `POST /api/auth/device/authorize`, (4) CLI polls `POST /api/auth/device/token` and receives JWT tokens. Device codes are SHA-256 hashed before storage. User codes are human-friendly (XXXX-XXXX format, no ambiguous characters). Codes expire after 15 minutes with MongoDB TTL auto-cleanup. Token polling is rate-limited (12 req/min per IP). The Studio `DeviceAuth` page handles the browser-side approval flow with i18n support.

---

## 2. Scope

### Goals

- Full RFC 8628 device authorization flow (device code, user code, verification URI, token exchange)
- Secure device code storage (SHA-256 hashed via `crypto.createHash('sha256')`)
- Human-friendly user codes (XXXX-XXXX, restricted charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
- 15-minute code expiry with MongoDB TTL auto-cleanup
- Token polling rate limiting (12 req/min per IP)
- JWT access token (24hr) and refresh token issuance
- Studio authorization page with scope display and approve/deny
- Configurable OAuth scopes (default: `read_traces`, `read_state`, `subscribe`)

### Non-Goals (Out of Scope)

- PKCE (not needed for device flow per RFC 8628)
- Client credentials flow
- Scope enforcement at resource level (scopes stored but not enforced on API calls)
- Admin management of active device authorizations
- Distributed (Redis-backed) rate limiting
- Refresh token rotation on device token usage

---

## 3. User Stories

1. As a **developer**, I want to authenticate my CLI tool with the platform by entering a code in my browser so that I can access debugging and tracing APIs securely.
2. As a **MCP client**, I want to poll for tokens after the user approves so that I can automatically receive credentials without user interaction on the CLI.
3. As a **user**, I want to see what scopes a device is requesting before I approve so that I can make an informed decision.
4. As a **security team**, I want device codes to expire quickly (15 minutes) and be hashed at rest so that compromised codes have limited blast radius.
5. As a **operator**, I want expired device authorization requests to be automatically cleaned up so that the database does not accumulate stale records.

---

## 4. Functional Requirements

1. **FR-1**: The system must generate device codes (32-byte random hex via `crypto.randomBytes(32)`, SHA-256 hashed for storage) and user codes (XXXX-XXXX format using restricted charset).
2. **FR-2**: The system must provide a `verification_uri` and `verification_uri_complete` pointing to the Studio authorization page, with `verification_uri_complete` including the `?code=` query parameter.
3. **FR-3**: The system must allow authenticated users to approve or deny device authorization requests via the browser authorization page.
4. **FR-4**: The system must support token polling with status responses: `authorization_pending` (428), `expired_token` (410), `token_already_used` (409), `slow_down` (429).
5. **FR-5**: The system must issue JWT access tokens (24hr TTL) and refresh tokens on successful authorization, resolving tenant context from user's first membership.
6. **FR-6**: The system must rate-limit token polling at 12 requests per 60-second window per IP address.
7. **FR-7**: The system must expire device codes after 15 minutes with automatic MongoDB TTL cleanup via `expiresAt` index with `expireAfterSeconds: 0`.
8. **FR-8**: The system must atomically mark device codes as consumed (set `consumedAt`) after token issuance to prevent replay.
9. **FR-9**: The authorize endpoint must atomically verify the request is un-authorized, un-consumed, and un-expired before setting `userId` and `authorizedAt`.
10. **FR-10**: The system must return a recommended polling interval of 5 seconds in the initiation response.
11. **FR-11**: The Studio DeviceAuth page must support auto-fill from `?code=XXXX-XXXX` URL parameter for `verification_uri_complete` flow.
12. **FR-12**: The Studio DeviceAuth page must redirect to login if the user is not authenticated, preserving the device code in the return URL.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                         |
| -------------------------- | ------------ | --------------------------------------------- |
| Project lifecycle          | NONE         | Device auth is user-level, not project-scoped |
| Agent lifecycle            | NONE         | No impact on agents                           |
| Customer experience        | NONE         | Developer/operator feature                    |
| Integrations / channels    | PRIMARY      | Enables CLI/MCP tool integration              |
| Observability / tracing    | SECONDARY    | CLI tools use tokens to access trace APIs     |
| Governance / controls      | SECONDARY    | Scoped access tokens                          |
| Enterprise / compliance    | PRIMARY      | Secure authentication for headless clients    |
| Admin / operator workflows | SECONDARY    | Developer tooling authentication              |

### Related Feature Integration Matrix

| Related Feature | Relationship Type | Why It Matters                            | Key Touchpoints                                             | Current State |
| --------------- | ----------------- | ----------------------------------------- | ----------------------------------------------------------- | ------------- |
| Auth System     | depends on        | Token issuance uses JWT infrastructure    | `signAccessToken`, `resolveFirstMembership`, `findUserById` | Integrated    |
| Studio          | extends           | Browser-based authorization page          | `DeviceAuth.tsx`, auth-store, i18n                          | Integrated    |
| MCP Integration | configured by     | MCP clients use device auth for CLI login | CLI token polling                                           | Integrated    |

---

## 6. Design Considerations (Optional)

The Studio `DeviceAuth` page (`/auth/device`) is a React component with 6 status states: `input | loading | confirm | success | error | denied`. It supports `?code=XXXX-XXXX` URL param for auto-fill from `verification_uri_complete`. The page redirects to login if not authenticated, preserving the return URL with the code. Scope descriptions use i18n support (`auth.device_page` namespace) with 4 scope labels defined (`read_traces`, `read_state`, `subscribe`, `execute_tools`). The page uses the `useAuthStore` hook for authentication state and `KoreIcon` for branding.

---

## 7. Technical Considerations (Optional)

- Device codes are 32-byte random hex values (64 hex characters), SHA-256 hashed before storage. The raw code is returned to the CLI once and never persisted.
- User codes use `crypto.randomInt(chars.length)` for each character, providing cryptographically secure randomness.
- Rate limiting on the token endpoint uses an in-memory `Map<string, { count: number; resetAt: number }>` (not distributed via Redis), which means rate limits are per-pod, not global (GAP-002). Cleanup runs every 5 minutes via `setInterval().unref()`.
- The `authorize` endpoint correctly uses `req.user?.id` which maps to the `AuthUser.id` property set by `createUnifiedAuthMiddleware`. However, the route test mock incorrectly sets `req.user = { sub: 'user-1' }` instead of `{ id: 'user-1' }`, masking potential integration issues (GAP-006).
- Token pair creation resolves the user's first tenant membership via `resolveFirstMembership` to build the JWT payload. If no membership exists, `buildAccessTokenPayload` receives `null`.
- The `pollDeviceToken` function atomically marks records as consumed via `updateOne({ _id })` but does NOT use a conditional update (no `{ consumedAt: null }` filter), creating a theoretical TOCTOU race where two concurrent poll requests could both consume the same code and receive tokens (GAP-007).
- Device auth routes use `createOpenAPIRouter` from `@agent-platform/openapi/express` for OpenAPI registration.

---

## 8. How to Consume

### Studio UI

- **Device Auth Page**: `/auth/device` -- enter user code, view scopes, approve/deny
- Supports `?code=XXXX-XXXX` URL param for auto-fill from `verification_uri_complete`
- Redirects to login if not authenticated, preserving return URL

### API (Runtime)

| Method | Path                         | Purpose                                                                 |
| ------ | ---------------------------- | ----------------------------------------------------------------------- |
| POST   | `/api/auth/device`           | Initiate device flow (returns device_code, user_code, verification_uri) |
| GET    | `/api/auth/device/lookup`    | Look up request by user code (for browser display)                      |
| POST   | `/api/auth/device/authorize` | User approves/denies (requires JWT auth via `authMiddleware`)           |
| POST   | `/api/auth/device/token`     | CLI polls for token (rate-limited, 12 req/min per IP)                   |

### API (Studio)

No Studio-side API routes. Studio DeviceAuth page communicates directly with Runtime API via `fetch` to `NEXT_PUBLIC_API_URL`.

### Admin Portal

No admin-facing pages for device authorization management.

### Channel / SDK / Voice / A2A / MCP Integration

Device auth is specifically designed for CLI tools and MCP clients. The issued JWT tokens can be used with any platform API endpoint that accepts JWT authentication.

---

## 9. Data Model

### Collections / Tables

```text
Collection: device_auth_requests (MongoDB)
Fields:
  - _id: string (UUIDv7 via base-document.uuidv7)
  - deviceCode: string (SHA-256 hash, unique)
  - userCode: string (XXXX-XXXX format, unique)
  - scopes: string[]
  - expiresAt: Date (required, TTL index)
  - userId: string | null
  - authorizedAt: Date | null
  - consumedAt: Date | null
  - _v: number (default: 1)
  - createdAt: Date (auto via timestamps)
  - updatedAt: Date (auto via timestamps)
Indexes:
  - { deviceCode: 1 } (unique)
  - { userCode: 1 } (unique)
  - { expiresAt: 1 } (TTL, expireAfterSeconds: 0)
```

### Key Relationships

- Device auth requests link to users via `userId` (set on authorization).
- Token pair creation resolves user's tenant membership via `resolveFirstMembership(user.id)`.
- `findUserById` resolves user record from `auth-repo.ts`.
- Studio DeviceAuth page uses the runtime lookup and authorize APIs.

---

## 10. Key Implementation Files

### Routes / Handlers

| File                                     | Purpose                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `apps/runtime/src/routes/device-auth.ts` | Device auth endpoints (4 endpoints) via `createOpenAPIRouter` |

### Domain / Core Logic

| File                                                        | Purpose                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/runtime/src/services/device-auth-service.ts`          | Device auth service (create, lookup, authorize, poll, token) |
| `packages/database/src/models/device-auth-request.model.ts` | DeviceAuthRequest Mongoose model with TTL index              |

### UI Components

| File                                        | Purpose                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `apps/studio/src/components/DeviceAuth.tsx` | Browser authorization page (React, i18n, auth) |

### Tests

| File                                                     | Type | Coverage Focus                                         |
| -------------------------------------------------------- | ---- | ------------------------------------------------------ |
| `apps/runtime/src/__tests__/device-auth-service.test.ts` | unit | Service logic (create, lookup, authorize, poll, token) |
| `apps/runtime/src/__tests__/device-auth-routes.test.ts`  | unit | Route handlers (all 4 endpoints, rate limiting)        |

---

## 11. Configuration

### Environment Variables

| Variable              | Default                 | Description                     |
| --------------------- | ----------------------- | ------------------------------- |
| `STUDIO_URL`          | `http://localhost:5173` | Studio URL for verification_uri |
| `JWT_SECRET`          | --                      | JWT signing secret (required)   |
| `NEXT_PUBLIC_API_URL` | `''`                    | Runtime API URL for Studio      |

### Runtime Configuration

- `config.server.frontendUrl` is used as fallback if `STUDIO_URL` env var is not set.
- No feature flags -- device auth is always enabled when routes are mounted.

### DSL / Agent IR / Schema

Not applicable. Device auth is an infrastructure-level authentication feature, not configurable via DSL or agent IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern          | Requirement / Expectation                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Tenant isolation | Token issuance resolves tenant from user's membership. Device codes are not tenant-scoped. |
| User isolation   | Each device code is tied to the authorizing user via `userId`.                             |

### Security & Compliance

- Device codes hashed (SHA-256) before storage -- raw code only visible to CLI at creation
- User codes exclude ambiguous characters (0, O, 1, I)
- 15-minute expiry with MongoDB TTL auto-cleanup
- Token polling rate limited (12 req/min per IP, in-memory Map with 5-min cleanup)
- `authorize` endpoint requires JWT authentication via `authMiddleware`
- Consumed device codes cannot be reused
- Access tokens: 24-hour TTL
- Error responses use standard error codes (`authorization_pending`, `expired_token`, `token_already_used`, `slow_down`, `invalid_request`)

### Performance & Scalability

- MongoDB TTL index on `expiresAt` provides automatic cleanup of expired device codes.
- Token polling rate limiting prevents abuse (12 req/min per IP).
- In-memory rate limiter does not scale across pods (GAP-002). No max-size or eviction on the rate limiter Map (GAP-008).

### Reliability & Failure Modes

- Device codes auto-expire after 15 minutes via MongoDB TTL.
- Consumed codes cannot be reused (atomic `consumedAt` update).
- Rate limiter cleanup runs every 5 minutes via `setInterval.unref()`.
- Token pair creation fails gracefully with `AppError` if user not found.
- Theoretical TOCTOU race on `pollDeviceToken` consume step (GAP-007).

### Observability

- Device auth routes use `console.error` instead of `createLogger` (GAP-003). This violates the platform's "never console.log in server code" invariant.
- No dedicated metrics or trace events for device auth operations.
- No audit logging for device auth events (creation, authorization, token issuance).

### Data Lifecycle

- Device auth requests auto-expire via MongoDB TTL index (15 minutes).
- No long-term retention of device auth history.
- No audit trail for device auth events.

---

## 13. Delivery Plan / Work Breakdown

1. DeviceAuthRequest model (DONE)
   1.1 Mongoose model with UUIDv7, TTL index
   1.2 Unique indexes on deviceCode and userCode
2. Device auth service (DONE)
   2.1 Code generation (device code hashing, user code format)
   2.2 Lookup, authorize, poll, token pair creation
3. Device auth routes (DONE)
   3.1 POST / (initiate), GET /lookup, POST /authorize, POST /token
   3.2 Rate limiting on token endpoint
4. Studio DeviceAuth page (DONE)
   4.1 Multi-state flow (input, loading, confirm, success, error, denied)
   4.2 i18n support, auto-fill from URL param
5. Hardening (TODO)
   5.1 Replace console.error with createLogger (GAP-003)
   5.2 Add TOCTOU-safe consume (GAP-007)
   5.3 Add max-size/eviction to rate limiter Map (GAP-008)
   5.4 Add audit logging for device auth events
   5.5 Fix route test mock to use `{ id: 'user-1' }` instead of `{ sub: 'user-1' }` (GAP-006)

---

## 14. Success Metrics

| Metric                   | Baseline | Target  | How Measured                       |
| ------------------------ | -------- | ------- | ---------------------------------- |
| Device auth success rate | N/A      | > 95%   | Approved / initiated ratio         |
| Code expiry rate         | N/A      | < 20%   | Expired / initiated ratio          |
| Token polling latency    | N/A      | < 200ms | Request timing                     |
| E2E flow completion time | N/A      | < 3 min | Initiated to token issued duration |

---

## 15. Open Questions

1. Should rate limiting be distributed via Redis for multi-pod deployments?
2. Should scopes be enforced at the API resource level (not just stored)?
3. Should there be an admin UI for viewing/revoking active device authorizations?
4. Should refresh tokens issued via device auth have a shorter TTL than standard refresh tokens?
5. Should deny actions be recorded in the database (currently no DB update on deny)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                        | Severity | Status |
| ------- | ---------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No E2E test for full device auth flow (CLI -> browser -> token)                    | High     | Open   |
| GAP-002 | Rate limiter uses in-memory Map (not distributed across pods)                      | Medium   | Open   |
| GAP-003 | Device auth routes use `console.error` instead of `createLogger`                   | Medium   | Open   |
| GAP-004 | Scopes are stored but not enforced at API resource level                           | Medium   | Open   |
| GAP-005 | No admin UI for viewing/revoking active device authorizations                      | Low      | Open   |
| GAP-006 | Route test mock sets `req.user = { sub }` but code reads `req.user?.id`            | Medium   | Open   |
| GAP-007 | TOCTOU race in pollDeviceToken: consume update lacks `{ consumedAt: null }` filter | Medium   | Open   |
| GAP-008 | In-memory rate limiter Map has no max-size or eviction policy                      | Medium   | Open   |
| GAP-009 | No audit logging for device auth events (create, authorize, token issue)           | Medium   | Open   |
| GAP-010 | Deny action does not update DB record (no denial tracking)                         | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                | Coverage Type | Status     | Test File / Note                                |
| --- | --------------------------------------- | ------------- | ---------- | ----------------------------------------------- |
| 1   | Device auth service logic               | unit          | PASS       | `runtime/__tests__/device-auth-service.test.ts` |
| 2   | Device auth route handlers              | unit          | PASS       | `runtime/__tests__/device-auth-routes.test.ts`  |
| 3   | Rate limiting (12 req/min per IP)       | unit          | PASS       | Tested in route tests (rate limit scenario)     |
| 4   | Studio DeviceAuth page                  | unit          | NOT TESTED | No UI tests                                     |
| 5   | E2E full device auth flow               | e2e           | NOT TESTED | CLI -> browser -> token roundtrip untested      |
| 6   | TOCTOU race condition (concurrent poll) | integration   | NOT TESTED | Concurrent poll safety untested                 |
| 7   | Auth middleware integration             | integration   | NOT TESTED | Real auth middleware not tested (mocked)        |

### Testing Notes

Device auth has unit test coverage for both service and route layers. Key gaps are: (a) E2E flow testing, (b) real auth middleware integration, (c) concurrent poll race condition testing, and (d) Studio UI testing.

> Full testing details: `../testing/device-auth.md`

---

## 18. References

- Design docs: `docs/specs/device-auth.hld.md`, `docs/plans/device-auth.lld.md`
- RFC 8628: OAuth 2.0 Device Authorization Grant
- Auth system: `packages/shared-auth/src/middleware/unified-auth.ts`
