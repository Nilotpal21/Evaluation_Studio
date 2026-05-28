# Device Authorization -- Low-Level Design + Implementation Plan

**Feature**: Device Authorization (RFC 8628)
**Feature Spec**: `docs/features/device-auth.md`
**HLD**: `docs/specs/device-auth.hld.md`
**Test Spec**: `docs/testing/device-auth.md`
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| Decision                                     | Rationale                                                                                    | Alternatives Rejected                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| SHA-256 hash device codes before storage     | Raw code returned to CLI once; DB compromise does not expose valid codes                     | Store raw (insecure) or bcrypt (too slow for high-frequency poll lookups) |
| User codes use restricted charset (28 chars) | No ambiguous 0/O/1/I when typing from terminal; 28^8 = ~28B combinations is sufficient       | Full alphanumeric (ambiguous) or numeric-only (too few combinations)      |
| In-memory rate limiter (not Redis)           | Low-volume feature; Redis adds operational cost for minimal benefit                          | Redis `SET NX PX` (distributed but adds dependency for ~100 polls/day)    |
| 15-minute code expiry                        | Balances security (short window) with usability (enough time for browser approval)           | 5 minutes (too short), 30 minutes (too long for unattended codes)         |
| No tenant scoping on device codes            | CLI does not know tenant at initiation; resolved at token time via user's membership         | tenantId parameter (breaks headless UX; CLI may not know its tenant)      |
| No repository layer                          | 4 simple CRUD operations; repository abstraction adds overhead without benefit               | DeviceAuthRepo class (unnecessary indirection for simple operations)      |
| Atomic authorize with condition filter       | `updateOne({ authorizedAt: null, consumedAt: null, expiresAt: { $gt: now } })` prevents race | Read-then-write (TOCTOU vulnerability on authorize path)                  |
| Non-atomic consume in pollDeviceToken        | Current implementation reads then updates separately (GAP-007 to fix)                        | Atomic `findOneAndUpdate({ consumedAt: null })` -- the correct approach   |

### Key Interfaces & Types

Already defined in codebase:

```typescript
// packages/database/src/models/device-auth-request.model.ts (lines 14-26)
export interface IDeviceAuthRequest {
  _id: string;
  deviceCode: string; // SHA-256 hash
  userCode: string; // XXXX-XXXX format
  scopes: string[];
  expiresAt: Date;
  userId: string | null;
  authorizedAt: Date | null;
  consumedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// apps/runtime/src/services/device-auth-service.ts -- function signatures
export function hashToken(token: string): string;
export function generateUserCode(): string;
export async function createDeviceAuthRequest(
  scopes: string[],
): Promise<{ deviceCode: string; userCode: string; expiresAt: Date }>;
export async function getDeviceAuthByUserCode(userCode: string): Promise<IDeviceAuthRequest | null>;
export async function authorizeDeviceRequest(userCode: string, userId: string): Promise<boolean>;
export async function pollDeviceToken(deviceCode: string): Promise<{
  status: 'pending' | 'authorized' | 'expired' | 'consumed';
  userId?: string;
  scopes?: string[];
}>;
export async function createDeviceTokenPair(
  userId: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
```

### Module Boundaries

| Module                         | Responsibility                                                 | Dependencies                                                   |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `device-auth-request.model.ts` | Mongoose schema, indexes (unique, TTL), UUIDv7 \_id            | `mongoose`, `base-document.uuidv7`                             |
| `device-auth-service.ts`       | Code generation, hashing, CRUD operations, token pair creation | `DeviceAuthRequest` model, `jwt-utils`, `auth-repo`, `config`  |
| `device-auth.ts` (routes)      | HTTP endpoints, Zod validation, rate limiting, OpenAPI specs   | `device-auth-service`, `authMiddleware`, `createOpenAPIRouter` |
| `DeviceAuth.tsx` (Studio)      | Browser approval page, scope display, i18n                     | `useAuthStore`, `useTranslations`, `KoreIcon`, `sanitizeError` |

---

## 2. File-Level Change Map

### Existing Files (Already Implemented)

| File                                                        | Purpose                           | Status      | LOC |
| ----------------------------------------------------------- | --------------------------------- | ----------- | --- |
| `packages/database/src/models/device-auth-request.model.ts` | DeviceAuthRequest Mongoose model  | Implemented | 56  |
| `apps/runtime/src/services/device-auth-service.ts`          | Device auth service (5 functions) | Implemented | 171 |
| `apps/runtime/src/routes/device-auth.ts`                    | Device auth routes (4 endpoints)  | Implemented | 328 |
| `apps/studio/src/components/DeviceAuth.tsx`                 | Browser authorization page        | Implemented | 289 |

### Existing Test Files (Already Implemented)

| File                                                     | Status          |
| -------------------------------------------------------- | --------------- |
| `apps/runtime/src/__tests__/device-auth-service.test.ts` | ~18 tests, PASS |
| `apps/runtime/src/__tests__/device-auth-routes.test.ts`  | ~14 tests, PASS |

### New Files (Planned)

| File                                                                     | Purpose                                      | LOC Estimate |
| ------------------------------------------------------------------------ | -------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/e2e/device-auth-e2e.test.ts`                 | E2E test: full device auth flow via HTTP API | ~350         |
| `apps/runtime/src/__tests__/integration/device-auth-integration.test.ts` | Integration test: real DB, auth middleware   | ~250         |

### Modified Files (Planned)

| File                                                    | Change Description                                                       | Risk   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| `apps/runtime/src/services/device-auth-service.ts`      | Fix TOCTOU in pollDeviceToken; add createLogger; add audit event helpers | Medium |
| `apps/runtime/src/routes/device-auth.ts`                | Replace console.error with logger; add max-size to rate limiter Map      | Low    |
| `apps/runtime/src/__tests__/device-auth-routes.test.ts` | Fix mock discrepancy: `req.user = { id }` not `{ sub }`                  | Low    |

---

## 3. Implementation Phases

### Phase 1: Hardening -- Fix Known Bugs and Platform Violations

**Goal**: Fix the 5 highest-priority issues identified in the feature spec and HLD.

#### Tasks

| #   | Task                                                    | File(s)                      | Est. Lines | Risk   |
| --- | ------------------------------------------------------- | ---------------------------- | ---------- | ------ |
| 1.1 | Fix TOCTOU race in `pollDeviceToken` (GAP-007)          | `device-auth-service.ts`     | ~20        | Medium |
| 1.2 | Replace `console.error` with `createLogger` (GAP-003)   | `device-auth.ts` (routes)    | ~10        | Low    |
| 1.3 | Add max-size and eviction to rate limiter Map (GAP-008) | `device-auth.ts` (routes)    | ~15        | Low    |
| 1.4 | Fix route test mock: `{ id }` not `{ sub }` (GAP-006)   | `device-auth-routes.test.ts` | ~5         | Low    |
| 1.5 | Standardize error envelope on authorize endpoint        | `device-auth.ts` (routes)    | ~10        | Low    |

#### Task Details

**1.1 Fix TOCTOU in pollDeviceToken**

Current code (lines 112-132 in `device-auth-service.ts`):

```typescript
// CURRENT (vulnerable): find, then update separately
const request = await DeviceAuthRequest.findOne({ deviceCode: hashedDeviceCode }).lean();
// ... check states ...
await DeviceAuthRequest.updateOne({ _id: request._id }, { $set: { consumedAt: new Date() } });
```

Fix: Use `findOneAndUpdate` with `{ consumedAt: null }` filter to atomically consume:

```typescript
// FIXED: atomic find-and-consume
const request = await DeviceAuthRequest.findOneAndUpdate(
  {
    deviceCode: hashedDeviceCode,
    consumedAt: null,
    authorizedAt: { $ne: null },
    expiresAt: { $gt: new Date() },
  },
  { $set: { consumedAt: new Date() } },
  { new: false }, // return pre-update document for userId/scopes
).lean();
```

**1.2 Replace console.error with createLogger**

Add at top of routes file:

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('device-auth');
```

Replace all `console.error('[Device Auth]', ...)` with `log.error('message', { context })`.

**1.3 Add max-size and eviction to rate limiter Map**

```typescript
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function checkTokenRateLimit(ip: string): boolean {
  // Evict if at max size
  if (tokenPollLimiter.size >= MAX_RATE_LIMIT_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of tokenPollLimiter) {
      if (entry.resetAt < now) tokenPollLimiter.delete(key);
    }
    // If still at max after cleanup, reject (defensive)
    if (tokenPollLimiter.size >= MAX_RATE_LIMIT_ENTRIES) return false;
  }
  // ... existing logic
}
```

**1.4 Fix route test mock**

Change line 26 in `device-auth-routes.test.ts`:

```typescript
// BEFORE:
req.user = { sub: 'user-1', email: 'test@example.com' };
// AFTER:
req.user = { id: 'user-1', email: 'test@example.com' };
```

And update test assertions at line 218:

```typescript
// BEFORE:
user: { sub: 'user-1' },
// AFTER:
user: { id: 'user-1' },
```

#### Exit Criteria

- [ ] `pollDeviceToken` uses atomic `findOneAndUpdate` with `{ consumedAt: null }` filter
- [ ] All `console.error` replaced with `createLogger('device-auth')` calls
- [ ] Rate limiter Map has `MAX_RATE_LIMIT_ENTRIES` (10,000) cap with eviction
- [ ] Route test mock uses `{ id: 'user-1' }` not `{ sub: 'user-1' }`
- [ ] All existing unit tests still pass: `pnpm test --filter=runtime -- -t "device"`
- [ ] `pnpm build --filter=runtime` succeeds with no type errors

---

### Phase 2: Audit Logging Integration (GAP-009)

**Goal**: Emit audit events for all device auth operations.

#### Tasks

| #   | Task                                                       | File(s)                   | Est. Lines | Risk |
| --- | ---------------------------------------------------------- | ------------------------- | ---------- | ---- |
| 2.1 | Add device auth audit event types                          | `device-auth-service.ts`  | ~30        | Low  |
| 2.2 | Emit audit events from routes (initiate, authorize, token) | `device-auth.ts` (routes) | ~25        | Low  |

#### Task Details

**2.1 Add audit event helpers**

Read the existing audit helper pattern from `apps/runtime/src/services/audit-helpers.ts` and add:

```typescript
function emitDeviceAuthEvent(action: string, metadata: Record<string, unknown>) {
  // Use the singleton audit store pattern from audit-helpers.ts
}
```

Events to emit:

- `device_auth.initiated` -- when a new device code is created (scopes, user_code)
- `device_auth.authorized` -- when a user approves (user_code, userId)
- `device_auth.denied` -- when a user denies (user_code, userId)
- `device_auth.token_issued` -- when tokens are issued (userId, scopes)
- `device_auth.rate_limited` -- when a poll is rate-limited (IP)

#### Exit Criteria

- [ ] All 5 audit event types are emitted from the appropriate route/service functions
- [ ] Audit events include relevant metadata (user_code, userId, scopes, IP)
- [ ] Existing unit tests still pass
- [ ] Build succeeds

---

### Phase 3: Integration Tests

**Goal**: Implement the 3 highest-priority integration tests (I1, I3, I4).

#### Tasks

| #   | Task                                                         | File(s)                           | Est. Lines | Risk   |
| --- | ------------------------------------------------------------ | --------------------------------- | ---------- | ------ |
| 3.1 | I1: Real auth middleware + authorize endpoint                | `device-auth-integration.test.ts` | ~80        | Medium |
| 3.2 | I3: Concurrent poll race condition (TOCTOU safety)           | `device-auth-integration.test.ts` | ~60        | Medium |
| 3.3 | I4: Device code hash verification (create -> poll roundtrip) | `device-auth-integration.test.ts` | ~50        | Low    |

#### Task Details

**Test Infrastructure**: Use MongoMemoryServer for real MongoDB, start Express on random port, create real JWT for auth.

**3.1 I1: Real Auth Middleware Integration**

```
1. Start Express with real authMiddleware
2. Create a test user and sign a valid JWT
3. POST /api/auth/device (initiate)
4. POST /api/auth/device/authorize with valid JWT -> expect 200
5. POST /api/auth/device/authorize without JWT -> expect 401
```

**3.2 I3: Concurrent Poll Race**

```
1. Create and authorize a device code
2. Fire 5 concurrent POST /api/auth/device/token requests
3. Exactly 1 should get tokens (200), remaining should get 409 (consumed)
```

**3.3 I4: Hash Verification Roundtrip**

```
1. POST /api/auth/device -> get raw device_code
2. Query MongoDB directly to verify stored deviceCode is SHA-256(raw)
3. POST /api/auth/device/token with raw device_code -> verify it resolves
```

Note: I4 queries MongoDB directly for verification, which is acceptable in integration tests (not E2E).

#### Exit Criteria

- [ ] 3 integration tests passing with real MongoDB (MongoMemoryServer)
- [ ] Concurrent poll test verifies atomic consume (exactly 1 winner)
- [ ] Hash roundtrip test verifies SHA-256 storage
- [ ] No vi.mock of codebase components in integration tests
- [ ] Build and all existing tests pass

---

### Phase 4: E2E Tests

**Goal**: Implement the 5 highest-priority E2E tests (E1, E3, E4, E8, E9).

#### Tasks

| #   | Task                                              | File(s)                   | Est. Lines | Risk   |
| --- | ------------------------------------------------- | ------------------------- | ---------- | ------ |
| 4.1 | E1: Full happy path (CLI -> authorize -> token)   | `device-auth-e2e.test.ts` | ~70        | Medium |
| 4.2 | E3: Denied authorization flow                     | `device-auth-e2e.test.ts` | ~40        | Low    |
| 4.3 | E4: Already consumed code                         | `device-auth-e2e.test.ts` | ~40        | Low    |
| 4.4 | E8: Token validation (use JWT on protected route) | `device-auth-e2e.test.ts` | ~50        | Medium |
| 4.5 | E9: Unauthorized authorize attempt                | `device-auth-e2e.test.ts` | ~30        | Low    |

#### Task Details

**Test Infrastructure**: Real Express server on random port with full middleware chain. Real MongoDB (MongoMemoryServer). No mocks. API-only interaction.

**4.1 E1: Full Happy Path**

```
1. POST /api/auth/device { scopes: ['read_traces'] }
   -> 200, device_code, user_code, verification_uri, expires_in > 0, interval = 5
2. GET /api/auth/device/lookup?code={user_code}
   -> 200, userCode, scopes = ['read_traces'], expiresAt
3. POST /api/auth/device/authorize { user_code, allow: true } + JWT
   -> 200, { success: true }
4. POST /api/auth/device/token { device_code }
   -> 200, access_token, refresh_token, token_type = 'Bearer', expires_in = 86400
```

**4.4 E8: Token Validation**

```
1. Complete E1 happy path to get access_token
2. Use access_token to call a protected endpoint (e.g., GET /api/health or a project-scoped route)
3. Verify the token is accepted (200, not 401)
```

#### Exit Criteria

- [ ] 5 E2E tests passing with real Express server and real MongoDB
- [ ] No vi.mock or jest.mock in E2E test file
- [ ] All interaction via HTTP API only (no direct DB access in test assertions)
- [ ] Token from E1 is usable on a protected endpoint (E8)
- [ ] Unauthorized authorize returns 401 (E9)
- [ ] All existing tests still pass
- [ ] Build succeeds

---

## 4. Wiring Checklist

| Item                                                   | File(s)                                              | Status |
| ------------------------------------------------------ | ---------------------------------------------------- | ------ |
| DeviceAuthRequest model exported from database package | `packages/database/src/models/index.ts`              | DONE   |
| Device auth routes registered in runtime app           | `apps/runtime/src/app.ts` or route registration file | DONE   |
| DeviceAuth component routed in Studio                  | `apps/studio/src/app/auth/device/page.tsx`           | DONE   |
| i18n keys for device auth page                         | `apps/studio/public/locales/en/auth.json`            | DONE   |
| createLogger import available in device-auth routes    | `@abl/compiler/platform`                             | TODO   |
| Audit store singleton accessible from device-auth      | `apps/runtime/src/services/audit-store-singleton.ts` | TODO   |
| Integration test file registered in vitest config      | `apps/runtime/vitest.config.ts`                      | TODO   |
| E2E test file registered in vitest config              | `apps/runtime/vitest.config.ts`                      | TODO   |

---

## 5. Risk Register

| Risk                                               | Likelihood | Impact | Mitigation                                                             |
| -------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------- |
| TOCTOU fix changes poll behavior                   | Medium     | Medium | Phase 1 fix with comprehensive test coverage before and after          |
| Rate limiter max-size eviction drops valid entries | Low        | Low    | 10,000 cap is generous; cleanup runs before reject                     |
| Auth middleware integration test flaky             | Medium     | Low    | Use dedicated MongoMemoryServer per test suite, random ports           |
| Concurrent poll test timing-dependent              | Medium     | Medium | Use Promise.allSettled with explicit assertions on result distribution |
| E2E tests slow due to real server startup          | Medium     | Low    | Use beforeAll for server setup, share across tests in suite            |

---

## 6. Dependency Graph

```
Phase 1 (Hardening)
    |
    v
Phase 2 (Audit Logging) -- depends on Phase 1 (logger in place)
    |
    v
Phase 3 (Integration Tests) -- depends on Phase 1 (TOCTOU fix verified)
    |
    v
Phase 4 (E2E Tests) -- depends on Phase 1+2+3 (all fixes in place)
```

---

## 7. Success Criteria

| Metric                         | Current | Target | Notes                                      |
| ------------------------------ | ------- | ------ | ------------------------------------------ |
| Known gaps (GAP-xxx)           | 10      | 5      | Close GAP-003, 006, 007, 008, 009          |
| Unit test count                | ~32     | ~35    | Fix mock discrepancy, add edge case tests  |
| Integration test count         | 0       | 3      | I1, I3, I4                                 |
| E2E test count                 | 0       | 5      | E1, E3, E4, E8, E9                         |
| console.error in device auth   | 4       | 0      | All replaced with createLogger             |
| In-memory Map without max-size | 1       | 0      | Rate limiter capped at 10,000 entries      |
| TOCTOU races                   | 1       | 0      | Atomic findOneAndUpdate in pollDeviceToken |
