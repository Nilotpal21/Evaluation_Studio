# Test Spec: Platform Admin

- **Feature ID:** F019-platform-admin (#41)
- **Feature Spec:** `docs/features/platform-admin.md`
- **Status:** Draft
- **Created:** 2026-03-22
- **Last Updated:** 2026-03-22

---

## 1. Test Strategy Overview

The Platform Admin feature is a **Next.js proxy application** that sits between the browser and the Runtime API. Testing must cover:

1. **E2E tests** -- Real HTTP requests against a running admin server with real middleware chain (auth, role-guard, proxy)
2. **Integration tests** -- Admin API routes exercised against a mock or real Runtime API backend, verifying proxy behavior, header forwarding, and error handling
3. **Unit tests** -- Pure logic functions (role-guard hierarchy, audit log formatting, SWR hooks)

### Test Architecture

```
E2E Tests (Playwright / HTTP)
    |
    v
Admin App (Next.js :3003)
    |-- Auth Middleware (JWT validation)
    |-- Role Guard (RBAC check)
    |-- Proxy Routes (-> Runtime API)
    |
    v
Runtime API (:3112) -- real or test double
    |
    v
MongoDB / Redis / ClickHouse
```

### Key Constraints

- E2E tests MUST NOT mock existing codebase components (`vi.mock()` / `jest.mock()` forbidden)
- E2E tests MUST interact only via HTTP API
- E2E tests MUST exercise the real middleware chain (auth, role-guard, proxy)
- Integration tests MUST test real service boundaries
- Only external third-party services (HubSpot API) may be mocked via dependency injection

---

## 2. Coverage Matrix

### FR-to-Test Mapping

| FR    | Description                         | E2E            | Integration    | Unit         |
| ----- | ----------------------------------- | -------------- | -------------- | ------------ |
| FR-01 | Authentication & Session Management | E2E-01, E2E-02 | INT-01         | UT-01        |
| FR-02 | Role-Based Access Control           | E2E-03, E2E-04 | INT-02         | UT-02, UT-03 |
| FR-03 | Tenant CRUD                         | E2E-05, E2E-06 | INT-03, INT-04 | --           |
| FR-04 | Deal & Billing Management           | E2E-07         | INT-05         | --           |
| FR-05 | System Health Monitoring            | E2E-08         | INT-06         | --           |
| FR-06 | Resilience Controls                 | E2E-09         | INT-07         | --           |
| FR-07 | Configuration Management            | E2E-10         | INT-08         | --           |
| FR-08 | Usage Analytics                     | E2E-11         | INT-09         | --           |
| FR-09 | Audit Logging                       | E2E-12         | INT-10         | UT-04        |
| FR-10 | Model Provisioning                  | --             | INT-11         | --           |
| FR-11 | Runtime Proxy Layer                 | E2E-03         | INT-12         | UT-05        |
| FR-12 | Shared UI Component Library         | --             | --             | UT-06        |

---

## 3. E2E Test Scenarios

All E2E tests start a real admin server on a random port, obtain a real JWT token, and interact exclusively via HTTP.

### E2E-01: Authentication Flow -- Login and Session Cookie

**Objective:** Verify the complete authentication flow from dev-login to session cookie issuance.

**Preconditions:** Studio API running (or test double issuing JWTs).

**Steps:**

1. POST `/api/auth/dev-login` with `{ email: "admin@test.com", name: "Admin" }`
2. Assert response status 200
3. Assert response body contains `{ user, role }` where role is a valid admin role
4. Assert response sets `admin-session` cookie (httpOnly, secure in prod, sameSite=strict)
5. Assert response sets `admin-last-activity` cookie
6. Use session cookie to GET `/api/health`
7. Assert 200 response

**Expected:** Session cookie is issued and subsequent requests succeed.

### E2E-02: Authentication Flow -- Unauthorized Access

**Objective:** Verify unauthenticated requests are rejected.

**Steps:**

1. GET `/api/tenants` without any cookies or Authorization header
2. Assert response status 401 or 403
3. GET `/api/tenants` with an expired/invalid JWT
4. Assert response status 401 or 403

**Expected:** All protected routes reject unauthenticated requests.

### E2E-03: RBAC Enforcement -- Role Hierarchy

**Objective:** Verify that routes enforce minimum role requirements.

**Preconditions:** JWT tokens for VIEWER, OPERATOR, ADMIN, and OWNER roles available.

**Steps:**

1. As VIEWER: GET `/api/tenants` -- expect 200
2. As VIEWER: PATCH `/api/tenants/tenant-001` with `{ status: "suspended" }` -- expect 403
3. As OPERATOR: POST `/api/resilience/circuit-breakers/test/reset` -- expect 200 (or proxy error if no runtime)
4. As ADMIN: PATCH `/api/tenants/tenant-001` with `{ status: "suspended" }` -- expect 200 (or proxy pass-through)
5. As VIEWER: POST `/api/config/validate` -- expect 403

**Expected:** Each role can access only routes at or below its permission level.

### E2E-04: RBAC Enforcement -- SUPER_ADMIN Bypass

**Objective:** Verify SUPER_ADMIN can access all routes.

**Steps:**

1. Obtain JWT with `isSuperAdmin: true`
2. GET `/api/tenants` -- expect 200
3. PATCH `/api/tenants/tenant-001` -- expect 200 (proxy pass-through)
4. POST `/api/resilience/circuit-breakers/test/reset` -- expect 200 (proxy pass-through)

**Expected:** SUPER_ADMIN bypasses all role checks.

### E2E-05: Tenant Lifecycle -- List, Detail, Status Change

**Objective:** Verify the full tenant management lifecycle through the proxy.

**Steps:**

1. GET `/api/tenants?page=1&limit=25` -- assert paginated response with `tenants[]` and `pagination`
2. GET `/api/tenants?status=active&search=acme` -- assert filtered results
3. GET `/api/tenants/{tenantId}` -- assert detail response with tenant, subscription, memberCount
4. GET `/api/tenants/{tenantId}/members` -- assert members list
5. GET `/api/tenants/{tenantId}/projects` -- assert projects list
6. PATCH `/api/tenants/{tenantId}` with `{ status: "suspended" }` (as ADMIN) -- assert success
7. PATCH `/api/tenants/{tenantId}` with `{ status: "active" }` (as ADMIN) -- assert re-activation

**Expected:** Full tenant lifecycle operations work through the proxy.

### E2E-06: Tenant Config Overrides

**Objective:** Verify per-tenant config override management.

**Steps:**

1. GET `/api/tenant-config/plans` -- assert plan defaults for all 4 tiers
2. GET `/api/tenant-config/{tenantId}` -- assert resolved config with plan defaults
3. PUT `/api/tenant-config/{tenantId}/overrides` with `{ maxConcurrentSessions: 200 }` (as ADMIN)
4. GET `/api/tenant-config/{tenantId}` -- assert override applied
5. DELETE `/api/tenant-config/{tenantId}/overrides` (as ADMIN) -- assert cleared

**Expected:** Config overrides are applied and cleared correctly.

### E2E-07: Deal Management Lifecycle

**Objective:** Verify deal CRUD, credit operations, and line items.

**Steps:**

1. GET `/api/deals?organizationId=org-001` -- assert deals list
2. GET `/api/deals/{dealId}` -- assert deal detail with phases, credits, features
3. PATCH `/api/deals/{dealId}` with `{ status: "paused" }` (as ADMIN) -- assert update
4. GET `/api/deals/{dealId}/credits` -- assert credit ledger
5. POST `/api/deals/{dealId}/credits` with `{ credits: 5000 }` (as ADMIN) -- assert top-up
6. GET `/api/deals/{dealId}/line-items` -- assert line items list
7. POST `/api/deals/{dealId}/line-items` with new line item (as ADMIN) -- assert creation

**Expected:** Complete deal lifecycle including credits and billing.

### E2E-08: System Health Dashboard

**Objective:** Verify system health aggregation.

**Steps:**

1. GET `/api/system-health` -- assert response with `services[]` and `summary`
2. Assert each service has: name, status, latencyMs, lastCheck
3. Assert summary has: healthy, degraded, down counts

**Expected:** Health data returned with correct structure.

### E2E-09: Resilience Controls -- Circuit Breakers

**Objective:** Verify circuit breaker management through the proxy.

**Steps:**

1. GET `/api/resilience/circuit-breakers` -- assert `{ success, data: { backend, breakers[] } }`
2. Assert each breaker has: name, state (closed/open/half-open), failures
3. POST `/api/resilience/circuit-breakers/{name}/reset` (as OPERATOR) -- assert success
4. GET `/api/resilience/tenants/{tenantId}/health` -- assert tenant health structure
5. POST `/api/resilience/tenants/{tenantId}/force-reset` (as ADMIN) -- assert success

**Expected:** Circuit breaker operations work correctly.

### E2E-10: Configuration & Secrets

**Objective:** Verify config viewing and diff operations.

**Steps:**

1. GET `/api/config?env=dev` -- assert config response with environment and nested config object
2. GET `/api/config?env=staging` -- assert different environment
3. GET `/api/config/diff?left=dev&right=staging` -- assert diff entries with status (added/removed/changed/same)
4. GET `/api/secrets?scope=shared&env=dev` -- assert secrets list (values masked)
5. GET `/api/secrets/rotation` -- assert rotation history

**Expected:** Config and secret data accessible per environment.

### E2E-11: Usage Analytics

**Objective:** Verify usage data aggregation.

**Steps:**

1. GET `/api/usage` -- assert response with summary, timeSeries, topTenants, providerBreakdown
2. Assert summary has: totalTokens, totalCost, sessionCount, activeTenants
3. GET `/api/tenants/{tenantId}/usage` -- assert per-tenant usage data

**Expected:** Analytics data returned with correct structure.

### E2E-12: Audit Logging

**Objective:** Verify audit log recording and querying.

**Steps:**

1. Perform an admin action (e.g., GET `/api/config?env=dev`)
2. GET `/api/audit?limit=10` -- assert recent audit entries
3. Assert entry has: timestamp, actor, actorRole, action, target
4. GET `/api/audit?actor=admin@test.com` -- assert filtered results
5. GET `/api/audit?action=config_view` -- assert action filter works

**Expected:** Audit log captures and returns admin actions correctly.

---

## 4. Integration Test Scenarios

Integration tests verify the proxy layer behavior, header forwarding, error handling, and role enforcement at the route level.

### INT-01: Auth Middleware -- JWT Validation

**Objective:** Verify JWT validation in the auth middleware.

**Setup:** Start admin server, use known JWT secret.

**Steps:**

1. Request with valid JWT in `admin-session` cookie -- assert request passes through
2. Request with malformed JWT -- assert 401
3. Request with expired JWT -- assert 401
4. Request with JWT missing role claim -- assert 403

**Expected:** Middleware correctly validates JWTs.

### INT-02: Role Guard -- Permission Enforcement

**Objective:** Verify `requireRole()` enforces hierarchy correctly.

**Steps:**

1. VIEWER accessing VIEWER-min route -- assert pass
2. VIEWER accessing ADMIN-min route -- assert 403 with descriptive error
3. OPERATOR accessing OPERATOR-min route -- assert pass
4. Unknown role accessing any route -- assert 403

**Expected:** Role hierarchy is enforced correctly.

### INT-03: Tenant Proxy -- Header Forwarding

**Objective:** Verify admin proxy forwards correct headers to Runtime.

**Setup:** Mock Runtime API that echoes received headers.

**Steps:**

1. GET `/api/tenants` with valid session
2. Assert Runtime receives: Authorization (Bearer), x-admin-user-id, x-admin-user-email, x-admin-user-role, x-forwarded-for, Content-Type

**Expected:** All identity headers forwarded to Runtime.

### INT-04: Tenant Proxy -- Error Propagation

**Objective:** Verify admin proxy correctly propagates Runtime errors.

**Setup:** Mock Runtime API returning various error codes.

**Steps:**

1. Runtime returns 404 -- assert admin returns 404
2. Runtime returns 500 -- assert admin returns 500
3. Runtime unreachable -- assert admin returns 502 with `{ success: false, error: "Failed to connect to runtime" }`

**Expected:** Error codes pass through; network failures return 502.

### INT-05: Deal Proxy -- Mutation Role Check

**Objective:** Verify deal mutation endpoints enforce ADMIN role.

**Steps:**

1. VIEWER PATCH `/api/deals/{id}` -- assert 403
2. ADMIN PATCH `/api/deals/{id}` -- assert proxied to Runtime
3. VIEWER POST `/api/deals/{id}/credits` -- assert 403
4. ADMIN POST `/api/deals/{id}/credits` -- assert proxied

**Expected:** Mutations require ADMIN role.

### INT-06: Health Proxy -- Response Structure

**Objective:** Verify system health proxy returns correct structure.

**Steps:**

1. GET `/api/system-health` -- assert response matches `SystemHealthResponse` type
2. Assert service groups are correctly categorized
3. Assert summary counts match service list

**Expected:** Health response structure is valid.

### INT-07: Resilience Proxy -- Path Traversal Prevention

**Objective:** Verify catch-all resilience route rejects path traversal.

**Steps:**

1. GET `/api/resilience/circuit-breakers` -- assert success
2. GET `/api/resilience/../../../etc/passwd` -- assert 400 "Invalid path"
3. GET `/api/resilience//absolute/path` -- assert 400 "Invalid path" (leading /)

**Expected:** Path traversal blocked; valid paths pass through.

### INT-08: Config Direct Access -- Environment Routing

**Objective:** Verify config routes read from correct environment configs.

**Steps:**

1. GET `/api/config?env=dev` -- assert dev config
2. GET `/api/config?env=staging` -- assert staging config
3. GET `/api/config?env=production` -- assert production config
4. GET `/api/config/diff?left=dev&right=staging` -- assert diff computed correctly

**Expected:** Environment routing works correctly.

### INT-09: Usage Proxy -- Query Parameter Forwarding

**Objective:** Verify usage route forwards query parameters to Runtime.

**Steps:**

1. GET `/api/usage?period=7d` -- assert params forwarded
2. GET `/api/usage?period=30d&tenantId=t-001` -- assert both params forwarded

**Expected:** Query parameters pass through to Runtime.

### INT-10: Audit Log -- Direct DB Write and Query

**Objective:** Verify audit log writes to MongoDB and queries correctly.

**Setup:** Connect to test MongoDB instance.

**Steps:**

1. Call `logAdminAction({ actor, action, target })` -- assert document created in AuditLog collection
2. Call `queryAuditLog({ actor })` -- assert filtered results returned
3. Call `queryAuditLog({ from, to })` -- assert time range filter works
4. Verify console fallback when DB unavailable

**Expected:** Audit entries persisted and queryable.

### INT-11: Model Provisioning -- Connection Management

**Objective:** Verify model proxy routes handle connection sub-resources.

**Steps:**

1. GET `/api/tenant-models` -- assert models list
2. GET `/api/tenant-models/{id}` -- assert model detail
3. GET `/api/tenant-models/{id}/connections` -- assert connections list

**Expected:** Nested resource routes work correctly.

### INT-12: Proxy Layer -- Generic Error Handling

**Objective:** Verify all proxy routes handle errors uniformly.

**Steps:**

1. Disconnect Runtime -- assert all proxy routes return 502
2. Send malformed JSON body -- assert 400 error
3. Send request to non-existent Runtime endpoint -- assert appropriate error propagation

**Expected:** Consistent error handling across all proxy routes.

---

## 5. Unit Test Scenarios

### UT-01: Auth Context Extraction

**Objective:** Verify `getAuthContext()` extracts correct values from headers.

**Tests:**

- Extract userId from `x-admin-user-id` header
- Extract email from `x-admin-user-email` header
- Extract role from `x-admin-user-role` header
- Extract IP from `x-forwarded-for` or `x-real-ip` fallback
- Return empty strings for missing headers

### UT-02: Role Hierarchy -- hasMinimumRole

**Objective:** Verify role hierarchy comparison logic.

**Tests:**

- `hasMinimumRole('ADMIN', 'VIEWER')` returns true
- `hasMinimumRole('VIEWER', 'ADMIN')` returns false
- `hasMinimumRole('ADMIN', 'ADMIN')` returns true (equal)
- `hasMinimumRole('SUPER_ADMIN', 'OWNER')` returns true
- `hasMinimumRole('UNKNOWN', 'VIEWER')` returns false (unknown role)
- `hasMinimumRole('VIEWER', 'UNKNOWN')` returns false (unknown minimum)

### UT-03: Role Guard -- requireRole

**Objective:** Verify `requireRole()` returns correct responses.

**Tests:**

- Returns null (pass) when role sufficient
- Returns 403 NextResponse when role insufficient
- Error message includes required role name

### UT-04: Audit Logger -- Entry Formatting

**Objective:** Verify audit log entry construction.

**Tests:**

- `logAdminAction()` adds timestamp automatically
- `queryAuditLog()` parses metadata JSON correctly
- Handles missing metadata gracefully
- Console fallback works when DB unavailable

### UT-05: Runtime Proxy -- URL Construction

**Objective:** Verify `getRuntimeBaseUrl()` and `getRuntimeHeaders()`.

**Tests:**

- Default base URL is `http://localhost:3112`
- Custom RUNTIME_API_URL environment variable is respected
- Headers include Authorization bearer from cookie
- Headers include all x-admin-user-\* fields

### UT-06: Admin UI Components -- Rendering

**Objective:** Verify shared admin-ui components render correctly.

**Tests:**

- `StatusBadge` renders correct variant colors
- `DataTable` sorts columns correctly
- `FilterBar` calls onChange handlers
- `EmptyState` renders title and description
- `ConfirmDialog` shows/hides based on open prop

---

## 6. Test Infrastructure Requirements

### For E2E Tests

- **Admin server:** Start on random port with `{ port: 0 }`
- **JWT issuance:** Either real Studio dev-login or a test JWT generator using the same secret
- **Runtime API:** Either real Runtime or a lightweight Express test double that implements the admin API surface
- **MongoDB:** Real MongoMemoryServer for audit log tests
- **Test data seeding:** Create tenants, deals, and users via Runtime API before tests

### For Integration Tests

- **Admin API routes:** Import and call route handlers directly or start server on random port
- **Mock Runtime:** Express server on random port that echoes headers and returns canned responses
- **JWT tokens:** Generated with known secret for each role tier

### For Unit Tests

- **No mocking of codebase components** -- test pure functions directly
- **Next.js headers mock:** Use `vi.mock('next/headers')` only for the `headers()` and `cookies()` Next.js built-in functions (this is a framework mock, not a codebase mock)

---

## 7. Test Data Requirements

### Test Tenants

| ID             | Name          | Status    | Plan     | Members |
| -------------- | ------------- | --------- | -------- | ------- |
| tenant-e2e-001 | E2E Corp      | active    | BUSINESS | 5       |
| tenant-e2e-002 | Suspended Inc | suspended | TEAM     | 2       |
| tenant-e2e-003 | Archived LLC  | archived  | FREE     | 0       |

### Test Users / JWT Tokens

| Email               | Role                             | Purpose                  |
| ------------------- | -------------------------------- | ------------------------ |
| viewer@test.com     | VIEWER                           | Read-only access tests   |
| operator@test.com   | OPERATOR                         | Operational action tests |
| admin@test.com      | ADMIN                            | Full mutation tests      |
| owner@test.com      | OWNER                            | Owner-level tests        |
| superadmin@test.com | SUPER_ADMIN (isSuperAdmin: true) | Bypass tests             |

### Test Deals

| ID           | Name                | Status  | Org         |
| ------------ | ------------------- | ------- | ----------- |
| deal-e2e-001 | E2E Enterprise Deal | active  | org-e2e-001 |
| deal-e2e-002 | Expired Deal        | expired | org-e2e-001 |

---

## 8. Risk Areas & Priority

| Priority | Area                    | Risk                                         | Test Focus             |
| -------- | ----------------------- | -------------------------------------------- | ---------------------- |
| P0       | RBAC enforcement        | Role bypass could expose admin operations    | E2E-03, E2E-04, INT-02 |
| P0       | Auth middleware         | Missing auth allows unauthenticated access   | E2E-01, E2E-02, INT-01 |
| P0       | Path traversal          | Resilience proxy could expose internal paths | INT-07                 |
| P1       | Proxy header forwarding | Missing headers cause Runtime auth failures  | INT-03                 |
| P1       | Error propagation       | Incorrect status codes confuse UI            | INT-04, INT-12         |
| P1       | Tenant lifecycle        | Status transitions must be consistent        | E2E-05                 |
| P2       | Audit completeness      | Missing audit entries for compliance         | E2E-12, INT-10         |
| P2       | Config diff accuracy    | Incorrect diff misleads operators            | E2E-10, INT-08         |
| P3       | UI component rendering  | Visual regressions                           | UT-06                  |

---

## 9. Acceptance Criteria

- All 12 E2E scenarios pass against a running admin + Runtime stack
- All 12 integration scenarios pass with test doubles
- All 6 unit test groups pass
- Zero RBAC bypass paths (every mutation route rejects insufficient roles)
- Zero unauthenticated access paths (every protected route rejects missing JWT)
- Path traversal fully blocked on resilience proxy
- Audit log records all admin actions with correct actor identity
- Error responses follow `{ success, error }` envelope on all proxy routes
