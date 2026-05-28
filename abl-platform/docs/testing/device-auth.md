# Feature Test Guide: Device Authorization

**Feature**: Device Auth -- OAuth 2.0 Device Authorization Grant (RFC 8628) for CLI/MCP tools
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/device-auth.md](../features/device-auth.md)
**First tested**: 2026-03-15
**Last updated**: 2026-03-23
**Overall status**: PARTIAL -- service and route unit tests cover core flow; E2E and integration gaps remain

---

## Current State (as of 2026-03-23)

Device auth has unit tests for both the service layer (create, lookup, authorize, poll, token pair creation) and the route layer (all 4 endpoints including rate limiting). Tests mock Mongoose models and JWT utilities. No E2E test for the full CLI-to-browser-to-token flow. Route test has a mock discrepancy where `req.user = { sub }` is used instead of `{ id }`.

### Quick Health Dashboard

| Area                             | Status     | Last Verified | Notes                                              |
| -------------------------------- | ---------- | ------------- | -------------------------------------------------- |
| Device auth service (create)     | PASS       | 2026-03-22    | Code generation, hashing, DB creation              |
| Device auth service (lookup)     | PASS       | 2026-03-22    | User code lookup                                   |
| Device auth service (authorize)  | PASS       | 2026-03-22    | User approval, atomic update                       |
| Device auth service (poll)       | PASS       | 2026-03-22    | Pending, authorized, expired, consumed states      |
| Device auth service (token pair) | PASS       | 2026-03-22    | JWT creation, refresh token                        |
| Route: POST / (initiate)         | PASS       | 2026-03-22    | Device code + user code generation                 |
| Route: GET /lookup               | PASS       | 2026-03-22    | Code lookup for browser display                    |
| Route: POST /authorize           | PASS       | 2026-03-22    | Approve/deny with auth (mock discrepancy: GAP-006) |
| Route: POST /token               | PASS       | 2026-03-22    | Token polling with status codes                    |
| Rate limiting (token endpoint)   | PASS       | 2026-03-22    | 12 req/min per IP, separate IP limits              |
| Studio DeviceAuth page           | NOT TESTED | -             | No UI tests                                        |
| E2E full flow                    | NOT TESTED | -             | No E2E test                                        |
| Auth middleware integration      | NOT TESTED | -             | Real auth middleware not tested                    |
| TOCTOU race (concurrent poll)    | NOT TESTED | -             | Concurrent poll safety untested                    |

---

## Test Inventory

### Unit Tests

| Test File                                                | Suites | Status | Key Scenarios                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/device-auth-service.test.ts` | ~8     | PASS   | generateUserCode, hashToken, createDeviceAuthRequest, getDeviceAuthByUserCode, authorizeDeviceRequest, pollDeviceToken (all 4 states), createDeviceTokenPair (success, user not found, no membership)                                                                     |
| `apps/runtime/src/__tests__/device-auth-routes.test.ts`  | ~8     | PASS   | POST / (initiate, default scopes), GET /lookup (valid, missing code, unknown, expired, already authorized), POST /authorize (approve, deny, missing user_code), POST /token (pending, expired, consumed, authorized, missing device_code, rate limit, separate IP limits) |

### Integration Tests (Required, Not Yet Implemented)

| #   | Scenario                                  | Description                                                                                  | Priority |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| I1  | Real auth middleware + authorize endpoint | Start real Express server with real auth middleware; verify JWT-authenticated authorize flow | HIGH     |
| I2  | MongoDB TTL auto-cleanup                  | Create expired device auth request, wait for TTL, verify document removed                    | MEDIUM   |
| I3  | Concurrent poll race condition            | Two concurrent pollDeviceToken calls for same authorized code; verify only one gets tokens   | HIGH     |
| I4  | Device code hash verification             | Create request, verify DB stores SHA-256 hash, verify poll with raw code resolves correctly  | MEDIUM   |
| I5  | User code collision handling              | Force a user code collision scenario; verify unique index enforcement                        | LOW      |
| I6  | Rate limiter Map cleanup                  | Verify stale entries are cleaned up after 5-minute interval                                  | LOW      |
| I7  | Token pair with no tenant membership      | Real user with no memberships; verify JWT issued without tenant context                      | MEDIUM   |

### E2E Tests (Required, Not Yet Implemented)

| #   | Scenario                                  | Description                                                                                                       | Priority |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| E1  | Full happy path (CLI -> browser -> token) | POST /device -> lookup by user_code -> authorize -> poll with device_code -> receive JWT tokens                   | HIGH     |
| E2  | Expired code flow                         | POST /device -> wait for expiry -> poll returns expired_token (410)                                               | HIGH     |
| E3  | Denied authorization flow                 | POST /device -> lookup -> deny -> poll returns pending (code not consumed)                                        | HIGH     |
| E4  | Already consumed code                     | Full happy path -> second poll returns token_already_used (409)                                                   | HIGH     |
| E5  | Rate limiting enforcement                 | 12 rapid polls from same IP -> 13th returns slow_down (429) -> different IP still works                           | MEDIUM   |
| E6  | verification_uri_complete auto-fill       | Verify lookup with code from URL param works correctly                                                            | MEDIUM   |
| E7  | Invalid/malformed codes                   | Lookup with nonexistent code (404), poll with invalid device code (expired), authorize with empty user_code (400) | MEDIUM   |
| E8  | Token validation                          | Complete flow -> use issued JWT to call a protected endpoint -> verify access granted                             | HIGH     |
| E9  | Unauthorized authorize attempt            | POST /authorize without JWT auth header -> verify 401                                                             | HIGH     |
| E10 | Scope propagation                         | POST /device with custom scopes -> lookup shows those scopes -> token response includes scope string              | MEDIUM   |

---

## How to Run

```bash
# All device auth tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "device"

# Specific test files
pnpm test --filter=runtime -- apps/runtime/src/__tests__/device-auth-service.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/device-auth-routes.test.ts
```

---

## Coverage Gaps

| Gap                                                                           | Severity | Notes                                            |
| ----------------------------------------------------------------------------- | -------- | ------------------------------------------------ |
| No E2E test for full device auth flow                                         | High     | CLI -> browser -> token roundtrip untested       |
| Route test mock uses `req.user = { sub }` instead of `{ id }` (GAP-006)       | Medium   | Test does not catch real auth integration issues |
| No test for TOCTOU race in pollDeviceToken (GAP-007)                          | Medium   | Concurrent poll safety untested                  |
| No test for rate limiter Map max-size/eviction (GAP-008)                      | Medium   | Memory leak under sustained attack untested      |
| No Studio UI test for DeviceAuth page                                         | Low      | Browser-side flow untested                       |
| No test for MongoDB TTL auto-cleanup                                          | Low      | TTL index behavior not verified                  |
| No test for deny action DB state (denial not recorded)                        | Low      | GAP-010: deny does not update DB                 |
| No test for token validation (using issued JWT to access protected endpoints) | Medium   | Token usability not verified end-to-end          |

---

## E2E Test Design Notes

### Test Infrastructure Requirements

E2E tests for device auth must:

1. **Start a real Express server** on a random port (`{ port: 0 }`) with the full middleware chain (auth, rate limiting, validation).
2. **Connect to a real MongoDB** (or MongoMemoryServer) with the `device_auth_requests` collection and TTL index.
3. **Create a real user** via the auth system for the authorize endpoint.
4. **Issue a real JWT** for the authorize request's Authorization header.
5. **NOT mock** any codebase components (`vi.mock`, `jest.mock` are forbidden in E2E tests per CLAUDE.md).
6. **Interact only via HTTP API** -- no direct Mongoose model imports.

### Test Flow Template (E1: Full Happy Path)

```
1. POST /api/auth/device { scopes: ['read_traces'] }
   -> Assert: 200, device_code, user_code, verification_uri, expires_in > 0, interval = 5

2. GET /api/auth/device/lookup?code={user_code}
   -> Assert: 200, userCode matches, scopes = ['read_traces'], expiresAt is ISO string

3. POST /api/auth/device/authorize { user_code, allow: true }
   Headers: Authorization: Bearer {valid_jwt}
   -> Assert: 200, { success: true }

4. POST /api/auth/device/token { device_code }
   -> Assert: 200, access_token, refresh_token, token_type = 'Bearer', expires_in = 86400, scope = 'read_traces'

5. POST /api/auth/device/token { device_code } (second poll)
   -> Assert: 409, error = 'token_already_used'
```

### Test Flow Template (E9: Unauthorized Authorize)

```
1. POST /api/auth/device { scopes: ['read_traces'] }
   -> Get user_code

2. POST /api/auth/device/authorize { user_code, allow: true }
   (NO Authorization header)
   -> Assert: 401
```

---

## Iteration Log

### Iteration 1 (2026-03-15) -- Initial Unit Tests

- Created `device-auth-service.test.ts` with 8 test suites covering pure utility functions and mocked DB operations
- Created `device-auth-routes.test.ts` with 6 test suites covering all 4 endpoints
- All tests passing

### Iteration 2 (2026-03-22) -- Rate Limit Tests Added

- Added rate limit tests to route tests (12 req/min per IP, separate IP limits)
- All tests passing
- Identified mock discrepancy (GAP-006): route test sets `req.user = { sub }` but code reads `req.user?.id`

### Iteration 3 (2026-03-23) -- Test Spec Generation

- Generated comprehensive test spec via SDLC pipeline
- Identified 7 integration test scenarios (I1-I7)
- Identified 10 E2E test scenarios (E1-E10)
- Documented test infrastructure requirements for E2E tests
- Updated gap analysis with TOCTOU race (GAP-007), rate limiter Map (GAP-008)
