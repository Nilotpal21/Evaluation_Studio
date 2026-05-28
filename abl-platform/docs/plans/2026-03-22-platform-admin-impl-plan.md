# LLD & Implementation Plan: Platform Admin

- **Feature ID:** F019-platform-admin (#41)
- **Feature Spec:** `docs/features/platform-admin.md`
- **Test Spec:** `docs/testing/platform-admin.md`
- **HLD:** `docs/specs/platform-admin.hld.md`
- **Status:** Draft
- **Created:** 2026-03-22
- **Last Updated:** 2026-03-22

---

## 1. Executive Summary

This implementation plan addresses the gaps identified in the feature spec, test spec, and HLD for the Platform Admin feature. The admin app already has substantial functionality (10+ pages, 30+ API routes, 2 test files). This plan focuses on:

1. **Security hardening** -- JWT verification, CSRF protection, rate limiting
2. **Code quality** -- Structured logging, unused import cleanup, error handling standardization
3. **Test coverage** -- Real HTTP E2E tests, integration tests, RBAC verification
4. **Missing pages** -- User management, enhanced audit filtering
5. **Observability** -- Migrate from console.log to createLogger

---

## 2. Implementation Phases

### Phase 1: Security Hardening (Priority: P0)

**Duration:** 2-3 days
**Risk:** HIGH -- current JWT decode-only auth could allow token forgery

#### 1.1 JWT Signature Verification

**Current:** `apps/admin/src/app/api/auth/dev-login/route.ts` uses `decodeJwt()` from `jose` which does NOT verify the signature.

**Target:** Use `jwtVerify()` with the shared `JWT_SECRET` to validate token integrity.

**Files to modify:**

- `apps/admin/src/.auth/middleware.ts` (or wherever the Next.js middleware validates tokens)
- `apps/admin/src/app/api/auth/dev-login/route.ts`

**Exit criteria:**

- [ ] `jwtVerify()` replaces `decodeJwt()` in all auth paths
- [ ] Invalid signature returns 401
- [ ] Expired token returns 401
- [ ] Valid token passes through with decoded claims
- [ ] Integration test covers all three cases

#### 1.2 Rate Limiting on Auth Endpoints

**Current:** No rate limiting on `/api/auth/dev-login` or any other endpoint.

**Target:** Add in-memory rate limiter (with Redis upgrade path) for auth endpoints.

**Implementation:**

- Create `apps/admin/src/lib/rate-limiter.ts` using sliding window algorithm
- Apply to `/api/auth/dev-login` (10 requests/minute per IP)
- Apply to mutation endpoints (30 requests/minute per user)
- Use `Map` with TTL + max size (platform standard: every Map needs max size, TTL, eviction)

**Exit criteria:**

- [ ] Rate limiter module created with configurable window and max requests
- [ ] Auth endpoint returns 429 when rate exceeded
- [ ] Map has max size (1000 entries) and TTL (1 minute) with eviction
- [ ] Unit test covers rate limit enforcement

#### 1.3 CSRF Protection

**Current:** Relies on `sameSite=strict` cookies only.

**Target:** Add CSRF token for all mutation endpoints (POST/PATCH/DELETE).

**Implementation:**

- Generate CSRF token on login, store in httpOnly cookie
- Require `x-csrf-token` header on mutation requests
- Validate token matches cookie value

**Exit criteria:**

- [ ] CSRF token generated on dev-login
- [ ] All mutation endpoints validate CSRF token
- [ ] Missing/invalid CSRF returns 403
- [ ] Integration test covers CSRF enforcement

#### 1.4 Path Traversal Hardening

**Current:** Resilience proxy has basic `..` and leading `/` checks.

**Target:** Strengthen validation with allowlist of valid path segments.

**Files to modify:**

- `apps/admin/src/app/api/resilience/[...path]/route.ts`

**Exit criteria:**

- [ ] Path segments validated against allowlist (circuit-breakers, tenants)
- [ ] Encoded path traversal (`%2e%2e`) blocked
- [ ] Integration test covers path traversal vectors

---

### Phase 2: Structured Logging Migration (Priority: P1)

**Duration:** 1-2 days
**Risk:** MEDIUM -- console.log makes debugging hard in production

#### 2.1 Create Admin Logger Module

**Files to create:**

- `apps/admin/src/lib/logger.ts`

**Implementation:**

```typescript
import { createLogger } from '@abl/compiler/platform';

export const authLogger = createLogger('admin-auth');
export const proxyLogger = createLogger('admin-proxy');
export const auditLogger = createLogger('admin-audit');
```

**Note:** Must READ the `createLogger` source to verify the actual signature before using.

#### 2.2 Replace console.log/error Throughout

**Files to modify:**

- `apps/admin/src/lib/audit-logger.ts` -- replace `console.log`, `console.error`, `console.warn`
- `apps/admin/src/app/api/auth/dev-login/route.ts` -- replace `console.error`
- All proxy routes -- add error logging on catch blocks

**Exit criteria:**

- [ ] Zero `console.log/error/warn` in server-side code
- [ ] All loggers use structured context: `log.error('message', { context })`
- [ ] Build passes with no regressions
- [ ] `grep -r "console\." apps/admin/src/ --include="*.ts"` returns 0 results (excluding client components)

---

### Phase 3: E2E Test Infrastructure (Priority: P0)

**Duration:** 3-4 days
**Risk:** HIGH -- existing tests mock fetch, violating SDLC standards

#### 3.1 Test Server Setup

**Files to create:**

- `apps/admin/src/__tests__/helpers/test-server.ts` -- starts admin on random port
- `apps/admin/src/__tests__/helpers/mock-runtime.ts` -- lightweight Express server mimicking Runtime API
- `apps/admin/src/__tests__/helpers/jwt-factory.ts` -- generates test JWTs with known secret

**Implementation:**

- Admin test server: Start Next.js on port 0 (or use `createServer` from `http`)
- Mock Runtime: Express server implementing `/api/platform/admin/*` routes with canned responses
- JWT factory: Sign tokens with test secret for each role tier

#### 3.2 RBAC E2E Tests

**Files to create:**

- `apps/admin/src/__tests__/rbac.e2e.test.ts`

**Test matrix:**

| Route                          | VIEWER | OPERATOR | ADMIN | OWNER | SUPER_ADMIN |
| ------------------------------ | ------ | -------- | ----- | ----- | ----------- |
| GET /api/tenants               | 200    | 200      | 200   | 200   | 200         |
| PATCH /api/tenants/:id         | 403    | 403      | 200   | 200   | 200         |
| POST /api/resilience/.../reset | 403    | 200      | 200   | 200   | 200         |
| POST /api/deals/:id/credits    | 403    | 403      | 200   | 200   | 200         |
| POST /api/config/validate      | 403    | 200      | 200   | 200   | 200         |

**Exit criteria:**

- [ ] 25+ test cases covering role x route combinations
- [ ] All tests use real HTTP requests (no fetch mocking)
- [ ] Tests start real admin server on random port

#### 3.3 Tenant Lifecycle E2E Tests

**Files to create:**

- `apps/admin/src/__tests__/tenant-lifecycle-real.e2e.test.ts`

**Scenarios:**

- Tenant list with pagination
- Tenant detail retrieval
- Status transitions (active -> suspended -> active -> archived)
- Config override set and clear
- Members and projects listing

**Exit criteria:**

- [ ] All scenarios use real HTTP requests
- [ ] Mock Runtime returns appropriate test data
- [ ] Error cases covered (404, 502, 403)

#### 3.4 Deal Lifecycle E2E Tests

**Files to create:**

- `apps/admin/src/__tests__/deal-lifecycle-real.e2e.test.ts`

**Scenarios:**

- Deal list with org filter
- Deal detail retrieval
- Deal settings update
- Credit ledger and top-up
- Line item creation

**Exit criteria:**

- [ ] All scenarios use real HTTP requests
- [ ] Credit calculations verified

#### 3.5 Proxy Integration Tests

**Files to create:**

- `apps/admin/src/__tests__/proxy-integration.test.ts`

**Scenarios:**

- Header forwarding verification
- Error propagation (404, 500, 502)
- Path traversal prevention
- Query parameter forwarding

**Exit criteria:**

- [ ] All 12 integration scenarios from test spec covered
- [ ] Header forwarding verified by mock Runtime echoing received headers

---

### Phase 4: Error Handling Standardization (Priority: P1)

**Duration:** 1-2 days
**Risk:** LOW -- improving existing patterns

#### 4.1 Standardize Error Envelope

**Current:** Some routes return `{ error: "..." }`, others return `{ success: false, error: "..." }`.

**Target:** All routes return:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

**Files to modify:**

- All API route files in `apps/admin/src/app/api/`
- `apps/admin/src/lib/role-guard.ts` -- update 403 response format

**Exit criteria:**

- [ ] All error responses follow standardized envelope
- [ ] Error codes defined as constants
- [ ] Client-side error handling updated to match

#### 4.2 Proxy Error Handling Helper

**Files to create:**

- `apps/admin/src/lib/proxy-helpers.ts`

**Implementation:**

```typescript
export async function proxyGet(
  path: string,
  auth: AdminAuthContext,
  minimumRole: string,
  queryString?: string,
): Promise<NextResponse> {
  const denied = requireRole(auth, minimumRole);
  if (denied) return denied;

  const url = `${getRuntimeBaseUrl()}${path}${queryString ? `?${queryString}` : ''}`;

  try {
    const res = await fetch(url, { headers: await getRuntimeHeaders() });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    proxyLogger.error('Runtime proxy failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Failed to connect to runtime' },
      },
      { status: 502 },
    );
  }
}
```

**Exit criteria:**

- [ ] All proxy routes use shared helper functions
- [ ] Duplicate proxy code eliminated
- [ ] Error logging added to proxy failures

---

### Phase 5: Audit Logging Enhancement (Priority: P1)

**Duration:** 1-2 days
**Risk:** LOW -- extending existing pattern

#### 5.1 Expand Audit Action Types

**Current:** Only `config_view` and `secret_list` are defined as `AdminAction`.

**Target:** Add all admin actions:

```typescript
export type AdminAction =
  | 'config_view'
  | 'config_diff'
  | 'config_validate'
  | 'secret_list'
  | 'secret_rotation_view'
  | 'tenant_list'
  | 'tenant_view'
  | 'tenant_status_change'
  | 'tenant_config_override'
  | 'deal_list'
  | 'deal_view'
  | 'deal_update'
  | 'credit_topup'
  | 'line_item_create'
  | 'health_view'
  | 'resilience_view'
  | 'breaker_reset'
  | 'breaker_force_reset'
  | 'usage_view'
  | 'audit_view'
  | 'model_view'
  | 'hubspot_sync';
```

**Files to modify:**

- `apps/admin/src/lib/audit-logger.ts` -- expand type, add helper for mutation logging
- All API routes -- add `logAdminAction()` calls where missing

#### 5.2 Add Audit Logging to All Routes

**Currently missing audit logging:**

- Tenant proxy routes (view, status change)
- Deal proxy routes (all operations)
- Resilience routes (breaker reset, force reset)
- Usage routes
- Model routes
- HubSpot routes

**Exit criteria:**

- [ ] Every API route calls `logAdminAction()` with appropriate action type
- [ ] Mutation routes log both the action and the target (e.g., tenant ID)
- [ ] Audit log page displays all new action types correctly

---

### Phase 6: User Management Page (Priority: P2)

**Duration:** 2-3 days
**Risk:** MEDIUM -- new page with CRUD operations

#### 6.1 API Routes

**Files to create:**

- `apps/admin/src/app/api/users/route.ts` -- GET (list users), POST (create user)
- `apps/admin/src/app/api/users/[userId]/route.ts` -- GET (detail), PATCH (update role), DELETE (deactivate)

**Proxy targets:**

- `GET /api/platform/admin/users`
- `GET /api/platform/admin/users/:userId`
- `PATCH /api/platform/admin/users/:userId`
- `DELETE /api/platform/admin/users/:userId`

**Role requirements:**

- GET operations: VIEWER
- PATCH/DELETE operations: ADMIN

#### 6.2 Dashboard Page

**Files to create:**

- `apps/admin/src/app/(dashboard)/users/page.tsx` -- User list with search, role filter
- `apps/admin/src/app/(dashboard)/users/[id]/page.tsx` -- User detail with role management

**Components used:**

- `PageHeader`, `FilterBar`, `DataTable`, `StatusBadge` from `@agent-platform/admin-ui`
- `ConfirmDialog` for role changes and deactivation

#### 6.3 Navigation Update

**Files to modify:**

- `apps/admin/src/app/(dashboard)/layout.tsx` -- Add "User Management" to TENANTS nav group

**Exit criteria:**

- [ ] User list page with search and role filter
- [ ] User detail page with role management
- [ ] Deactivation with confirmation dialog
- [ ] RBAC enforcement (ADMIN required for mutations)
- [ ] Navigation link added to sidebar
- [ ] Audit logging for all user management actions

---

### Phase 7: Documentation Sync (Priority: P2)

**Duration:** 0.5 day
**Risk:** LOW

#### 7.1 Update Feature Spec

- Add user management FRs and user stories
- Update API surface table with new routes
- Update status from ALPHA to BETA (if criteria met)

#### 7.2 Update Test Spec

- Add E2E scenarios for user management
- Add integration scenarios for new proxy routes

#### 7.3 Update README

- Document new pages and capabilities
- Update setup instructions if needed

**Exit criteria:**

- [ ] Feature spec reflects implemented reality
- [ ] Test spec covers all new functionality
- [ ] README updated with complete page inventory

---

## 3. Dependency Graph

```
Phase 1 (Security) ──┐
                      ├─→ Phase 3 (E2E Tests) ──→ Phase 7 (Docs)
Phase 2 (Logging) ───┘         │
                               │
Phase 4 (Error Handling) ──────┘
                               │
Phase 5 (Audit) ───────────────┘
                               │
Phase 6 (User Mgmt) ──────────┘
```

- Phases 1 and 2 can run in parallel
- Phase 3 depends on Phases 1 and 2 (tests should verify security fixes and logging)
- Phase 4 can run independently but should complete before Phase 3
- Phase 5 can run independently
- Phase 6 depends on all prior phases (new page should follow all established patterns)
- Phase 7 runs last to document final state

---

## 4. Wiring Checklist

Every new module or route must be wired into the application. This checklist prevents the common failure mode of writing code that isn't connected.

### For New API Routes

- [ ] Route file created in `apps/admin/src/app/api/<path>/route.ts`
- [ ] `getAuthContext()` called at handler start
- [ ] `requireRole()` called with appropriate minimum role
- [ ] `getRuntimeHeaders()` used for proxy requests
- [ ] Error handling returns standardized envelope
- [ ] `logAdminAction()` called for audit trail
- [ ] Response types added to `apps/admin/src/types/api.ts`

### For New Dashboard Pages

- [ ] Page file created in `apps/admin/src/app/(dashboard)/<path>/page.tsx`
- [ ] Navigation entry added to `apps/admin/src/app/(dashboard)/layout.tsx` NAV_GROUPS
- [ ] API hook configured with `useApi<ResponseType>('/api/<endpoint>')`
- [ ] Loading state handled with `SkeletonTable` or `SkeletonCard`
- [ ] Error state handled with `EmptyState` + retry button
- [ ] Empty state handled with `EmptyState`

### For New Shared Modules

- [ ] Module file created in `apps/admin/src/lib/<module>.ts`
- [ ] Exported from module (named export, not default)
- [ ] Imported by all routes/pages that need it
- [ ] Unit test created in `apps/admin/src/__tests__/<module>.test.ts`

---

## 5. Risk Mitigation

| Risk                                                                    | Mitigation                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| createLogger import fails (admin may not have @abl/compiler dependency) | Verify import path before Phase 2; create local wrapper if needed                      |
| Next.js middleware complexity for JWT verification                      | Use jose's jwtVerify in API routes, not middleware (simpler)                           |
| Rate limiter state lost on pod restart                                  | Acceptable for internal tool; document Redis upgrade path                              |
| User management Runtime API endpoints may not exist yet                 | Phase 6 can be deferred; create stub routes that return 501                            |
| E2E test infrastructure complex for Next.js                             | Use undici or node fetch against running dev server; consider playwright for API tests |

---

## 6. Estimated Timeline

| Phase                       | Duration       | Dependency | Priority |
| --------------------------- | -------------- | ---------- | -------- |
| Phase 1: Security Hardening | 2-3 days       | None       | P0       |
| Phase 2: Structured Logging | 1-2 days       | None       | P1       |
| Phase 3: E2E Tests          | 3-4 days       | Phase 1, 2 | P0       |
| Phase 4: Error Handling     | 1-2 days       | None       | P1       |
| Phase 5: Audit Enhancement  | 1-2 days       | Phase 2    | P1       |
| Phase 6: User Management    | 2-3 days       | Phase 1-5  | P2       |
| Phase 7: Documentation      | 0.5 day        | Phase 1-6  | P2       |
| **Total**                   | **11-17 days** |            |          |

---

## 7. Exit Criteria (Overall)

- [ ] JWT signature verification in place (not just decode)
- [ ] Rate limiting on auth endpoints
- [ ] CSRF protection on mutation endpoints
- [ ] Zero console.log/error in server-side code
- [ ] Standardized error envelope on all routes
- [ ] 25+ real HTTP E2E tests passing
- [ ] 12+ integration tests passing
- [ ] All admin actions audit-logged
- [ ] User management page functional
- [ ] Feature spec, test spec, HLD, and LLD up to date
- [ ] Build passes: `pnpm build --filter @agent-platform/admin`
- [ ] Tests pass: `pnpm test --filter @agent-platform/admin`
