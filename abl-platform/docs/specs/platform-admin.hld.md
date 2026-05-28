# High-Level Design: Platform Admin

- **Feature ID:** F019-platform-admin (#41)
- **Feature Spec:** `docs/features/platform-admin.md`
- **Test Spec:** `docs/testing/platform-admin.md`
- **Status:** Draft
- **Created:** 2026-03-22
- **Last Updated:** 2026-03-22

---

## 1. Architecture Overview

The Platform Admin is a **thin proxy application** built on Next.js 16, serving as the internal operations portal for the ABL platform. It follows a clear separation of concerns:

- **Presentation Layer:** Next.js App Router pages (`apps/admin/src/app/(dashboard)/`)
- **Proxy Layer:** Next.js API routes (`apps/admin/src/app/api/`) that forward to Runtime
- **Auth Layer:** JWT validation middleware + RBAC role guard
- **Direct Access Layer:** Config/secrets/audit that access Vault and MongoDB directly
- **Shared Components:** `@agent-platform/admin-ui` package

### System Context Diagram

```
                    ┌──────────────────────────┐
                    │     Platform Operator     │
                    │   (Browser, Port 3003)    │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │   Admin App (Next.js)     │
                    │   apps/admin/             │
                    │                           │
                    │ ┌───────────────────────┐ │
                    │ │  Auth Middleware       │ │
                    │ │  (JWT + Role Guard)    │ │
                    │ └───────────┬───────────┘ │
                    │             │              │
                    │ ┌───────────▼───────────┐ │
                    │ │  Proxy Routes         │ │
                    │ │  /api/* -> Runtime    │ │
                    │ └───────────┬───────────┘ │
                    └─────────────┼─────────────┘
                    ┌─────────────┼──────────────────┐
                    │             │                    │
           ┌────────▼──────┐ ┌───▼───────┐ ┌─────────▼─────────┐
           │  Runtime API   │ │  MongoDB   │ │  Vault/ConfigMap   │
           │  :3112         │ │ (AuditLog) │ │  (Secrets/Config)  │
           └───────┬────────┘ └────────────┘ └────────────────────┘
                   │
     ┌─────────────┼──────────────┐
     │             │              │
┌────▼───┐  ┌─────▼────┐  ┌─────▼──────┐
│MongoDB  │  │  Redis    │  │ ClickHouse │
│(data)   │  │  (cache)  │  │(analytics) │
└─────────┘  └──────────┘  └────────────┘
```

### Chosen Architecture: Proxy + BFF Pattern

The admin app implements a **Backend for Frontend (BFF)** pattern where:

1. The Next.js server acts as a security boundary (JWT validation, RBAC, IP filtering)
2. Data routes proxy to Runtime API which owns the business logic and data access
3. Only config, secrets, and audit have direct data access (for operational reasons)

**Rationale:** This pattern avoids duplicating business logic, keeps the admin app stateless (horizontally scalable), and centralizes data access in the Runtime which already enforces tenant isolation.

---

## 2. Alternative Architectures Considered

### Alternative A: Direct Database Access

**Description:** Admin app connects directly to MongoDB/Redis/ClickHouse for all data operations.

**Pros:**

- No dependency on Runtime API availability
- Lower latency (no proxy hop)
- Full control over queries and aggregations

**Cons:**

- Duplicates business logic (tenant isolation, data validation, access control)
- Creates a second attack surface for database access
- Requires admin app to maintain database connection pools
- Violates platform principle of centralized data access

**Verdict:** REJECTED -- duplicates isolation logic and creates maintenance burden.

### Alternative B: Standalone Admin Backend (Express)

**Description:** Separate Express backend for admin, independent of Next.js, with its own data layer.

**Pros:**

- Decoupled from Next.js lifecycle and deployment
- Can use platform-standard Express patterns (middleware, routes, services)
- Easier to test (no Next.js server component complexity)

**Cons:**

- Another service to deploy and maintain
- Duplicates auth middleware already in Runtime
- Needs its own health monitoring
- Splits the admin codebase across two packages

**Verdict:** REJECTED -- operational overhead of a separate service outweighs benefits for an internal tool.

### Alternative C: Embedded in Studio (Current Partial Implementation)

**Description:** Admin functionality embedded within the Studio app as additional pages.

**Pros:**

- Single deployment for all frontend
- Shared auth infrastructure
- No additional service to maintain

**Cons:**

- Studio is tenant-scoped; admin is platform-scoped (different security model)
- Increases Studio bundle size and complexity
- IP allowlisting on admin pages is harder when shared with Studio
- Risk of admin functionality leaking to non-admin users

**Verdict:** REJECTED -- security model mismatch makes embedding risky.

---

## 3. Architectural Concerns (12 Concerns)

### Concern 1: Authentication & Identity

**Approach:** JWT-based authentication with session cookies.

- JWT issued by Studio dev-login endpoint (shared auth infrastructure)
- Session stored in httpOnly cookie (`admin-session`) with 8-hour max age
- Idle timeout (30 minutes) tracked via `admin-last-activity` cookie
- JWT decoded to extract `userId`, `email`, `role`, `isSuperAdmin` claims
- Session validation in Next.js middleware on every request

**Future consideration:** Migrate to dedicated identity provider (Keycloak/Auth0) when SSO/SAML is needed.

### Concern 2: Authorization & Access Control

**Approach:** 5-tier RBAC hierarchy enforced at route level.

```
SUPER_ADMIN (4) > OWNER (3) > ADMIN (2) > OPERATOR (1) > VIEWER (0)
```

- `requireRole(auth, minimumRole)` called at the start of every API route handler
- Returns 403 with descriptive error if role insufficient
- SUPER_ADMIN (`isSuperAdmin: true` in JWT) bypasses all role checks
- No fine-grained resource-level permissions (admin is platform-wide)

**Implementation:** `apps/admin/src/lib/role-guard.ts` -- `ROLE_HIERARCHY` map, `hasMinimumRole()`, `requireRole()`

### Concern 3: Tenant Isolation

**Approach:** Admin routes are intentionally **not tenant-scoped** -- they provide cross-tenant visibility.

- Admin users see all tenants (filtered only by explicit query params)
- Tenant isolation is enforced at the **Runtime API level**, not in the admin proxy
- The proxy forwards the admin user's identity headers; Runtime applies its own authorization
- Admin actions on a specific tenant (e.g., suspend) target that tenant by ID

**Key difference from Studio:** Studio routes include `tenantId` in every query; admin routes do not.

### Concern 4: Data Consistency

**Approach:** Read-through proxy with no caching layer (except SWR client-side).

- All data reads proxy to Runtime which queries MongoDB directly
- Client-side SWR provides stale-while-revalidate for UX
- No server-side caching in admin (avoids stale data issues)
- Mutations are synchronous request-response through Runtime

**Trade-off:** Slightly higher latency vs always-fresh data. Acceptable for an internal operations tool.

### Concern 5: Error Handling

**Approach:** Layered error handling with consistent error envelope.

```
Layer 1: Admin route handler try/catch -> 502 on network failure
Layer 2: Runtime API response status pass-through (404, 400, 500)
Layer 3: Client-side SWR error state -> retry buttons
```

- All proxy routes return `{ success: false, error: "..." }` on failure
- Runtime errors pass through with original HTTP status code
- Network failures (Runtime unreachable) return 502
- Direct access routes (config, secrets, audit) have their own error handling

### Concern 6: Observability

**Approach:** Audit logging + console logging + structured error responses.

- **Audit log:** MongoDB `AuditLog` collection for all admin actions
  - Captures: userId, action, target, IP, timestamp, metadata
  - Console fallback when MongoDB unavailable
- **Error logging:** `console.error` for server-side failures (should migrate to `createLogger`)
- **Health endpoint:** `/api/health` for external monitoring
- **System health dashboard:** Aggregates health from all platform services

**Gap identified:** Admin app uses `console.log/error` instead of `createLogger`. Should migrate for structured logging.

### Concern 7: Performance

**Approach:** Server-side pagination + client-side caching.

- All list endpoints paginate (default 25 items/page)
- Client-side SWR with stale-while-revalidate
- Search inputs debounced (300ms)
- No server-side rendering of data (all pages are `'use client'`)
- Proxy adds ~5-10ms latency per request

**Bottleneck:** Large tenant lists (1000+) -- mitigated by server-side pagination and search.

### Concern 8: Security

**Approach:** Defense in depth.

| Layer          | Control                                       |
| -------------- | --------------------------------------------- |
| Network        | IP allowlisting at load balancer (production) |
| Transport      | HTTPS with TLS 1.3                            |
| Authentication | JWT validation with expiration + idle timeout |
| Authorization  | RBAC role guard on every route                |
| Session        | httpOnly, secure, sameSite=strict cookies     |
| Input          | Path traversal prevention on catch-all routes |
| Secrets        | Never returned in full to browser (masked)    |
| Audit          | All actions logged with actor identity        |

**Gap identified:** No CSRF token (relies on sameSite=strict). No rate limiting on admin API routes.

### Concern 9: Scalability

**Approach:** Stateless horizontal scaling.

- Admin is completely stateless (no pod-local state)
- All session state in cookies (JWT, last-activity)
- All data in MongoDB/Redis/ClickHouse (via Runtime)
- Can scale to N replicas behind load balancer
- No sticky sessions required

### Concern 10: Reliability

**Approach:** Graceful degradation.

| Failure           | Impact                                                   | Recovery                                                      |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Runtime down      | Proxy routes return 502; config/secrets/audit still work | Retry buttons in UI                                           |
| MongoDB down      | Audit logging falls back to console                      | Data available from Runtime (which may have its own fallback) |
| Vault down        | Config/secrets pages show error                          | Retry; cached values in SWR                                   |
| Admin pod restart | Session cookies survive (stored in browser)              | Transparent reconnection                                      |

### Concern 11: Deployment & Operations

**Approach:** Containerized deployment with GitOps.

- Docker image: `apps/admin/Dockerfile` (multi-stage build)
- Port: 3003 (configurable via `next start -p`)
- Environment config: `.env.local` (JWT_SECRET, STUDIO_API_URL, RUNTIME_API_URL)
- Deployment: ArgoCD via `abl-platform-deploy` repo
- Health check: `GET /api/health` (no auth required)

**Dependencies to configure:**

- `JWT_SECRET` must match Runtime and Studio
- `STUDIO_API_URL` for dev-login authentication
- `RUNTIME_API_URL` for data proxy (default: localhost:3112)

### Concern 12: Compliance & Data Privacy

**Approach:** Audit trail + minimal data exposure.

- All admin actions recorded in AuditLog with actor identity and IP
- Secrets displayed with masked values (never full cleartext in browser)
- Session cookies have strict security attributes
- No PII stored in admin app itself (all data lives in Runtime/MongoDB)
- Right to erasure: admin does not store user data; audit logs have configurable retention

---

## 4. Component Architecture

### Package Dependency Graph

```
apps/admin/
├── @agent-platform/admin-ui     (shared UI components)
├── @agent-platform/config       (port constants, env config)
├── @agent-platform/database     (AuditLog model for direct access)
├── @agent-platform/shared       (type definitions)
├── next                          (framework)
├── react + react-dom            (UI)
├── swr                           (client-side caching)
├── jose                          (JWT decoding)
├── recharts                      (charts)
├── lucide-react                  (icons)
└── zod                           (validation)
```

### Internal Module Structure

```
apps/admin/src/
├── app/
│   ├── (auth)/                    # Auth pages (login)
│   │   └── login/page.tsx
│   ├── (dashboard)/               # Main dashboard pages
│   │   ├── page.tsx               # Dashboard overview
│   │   ├── layout.tsx             # Sidebar + main layout
│   │   ├── tenants/               # Tenant management
│   │   ├── config-overrides/      # Per-tenant config
│   │   ├── models/                # Model provisioning
│   │   ├── deals/                 # Deal management
│   │   ├── resilience/            # Circuit breakers
│   │   ├── health/                # System health
│   │   ├── usage/                 # Usage analytics
│   │   ├── audit/                 # Audit log
│   │   ├── config/                # Configuration viewer
│   │   └── secrets/               # Secrets viewer
│   └── api/                       # API routes (proxy layer)
│       ├── auth/                  # Auth endpoints
│       ├── tenants/               # Tenant proxy
│       ├── tenant-config/         # Config override proxy
│       ├── tenant-models/         # Model proxy
│       ├── deals/                 # Deal proxy
│       ├── resilience/            # Resilience proxy (catch-all)
│       ├── system-health/         # Health proxy
│       ├── usage/                 # Usage proxy
│       ├── hubspot/               # HubSpot proxy
│       ├── audit/                 # Audit (direct DB)
│       ├── config/                # Config (direct Vault)
│       ├── secrets/               # Secrets (direct Vault)
│       └── health/                # Health check
├── lib/                           # Shared utilities
│   ├── auth-context.ts            # JWT claim extraction
│   ├── role-guard.ts              # RBAC enforcement
│   ├── runtime-proxy.ts           # Runtime URL + header builder
│   ├── vault-client.ts            # Config/secrets access
│   ├── audit-logger.ts            # Audit log write/query
│   └── swr-config.ts              # SWR configuration
├── hooks/                         # React hooks
│   ├── use-swr-fetch.ts           # SWR wrapper hook
│   └── use-fetch.ts               # Fetch utility hook
├── types/                         # TypeScript types
│   └── api.ts                     # API response types
├── components/                    # Admin-specific components
│   └── ui/                        # Local UI components
└── __tests__/                     # Test files
    ├── tenant-lifecycle.e2e.test.ts
    └── deal-lifecycle.e2e.test.ts
```

---

## 5. Data Flow Diagrams

### Tenant List Flow

```
Browser                    Admin Server              Runtime API            MongoDB
  │                            │                          │                    │
  │  GET /tenants?page=1       │                          │                    │
  │────────────────────────────>│                          │                    │
  │                            │  validateJWT()           │                    │
  │                            │  requireRole(VIEWER)     │                    │
  │                            │                          │                    │
  │                            │  GET /api/platform/      │                    │
  │                            │  admin/tenants?page=1    │                    │
  │                            │─────────────────────────>│                    │
  │                            │                          │  db.tenants.find() │
  │                            │                          │───────────────────>│
  │                            │                          │  [tenants, count]  │
  │                            │                          │<───────────────────│
  │                            │  { tenants, pagination } │                    │
  │                            │<─────────────────────────│                    │
  │  { tenants, pagination }   │                          │                    │
  │<────────────────────────────│                          │                    │
```

### Tenant Status Change Flow

```
Browser                    Admin Server              Runtime API            MongoDB
  │                            │                          │                    │
  │  PATCH /tenants/t-001      │                          │                    │
  │  { status: "suspended" }   │                          │                    │
  │────────────────────────────>│                          │                    │
  │                            │  validateJWT()           │                    │
  │                            │  requireRole(ADMIN)      │                    │
  │                            │                          │                    │
  │                            │  PATCH /api/platform/    │                    │
  │                            │  admin/tenants/t-001/    │                    │
  │                            │  status                  │                    │
  │                            │─────────────────────────>│                    │
  │                            │                          │  findOneAndUpdate  │
  │                            │                          │───────────────────>│
  │                            │                          │  updated tenant    │
  │                            │                          │<───────────────────│
  │                            │  { success, tenant }     │                    │
  │                            │<─────────────────────────│                    │
  │  { success, tenant }       │                          │                    │
  │<────────────────────────────│                          │                    │
```

---

## 6. API Contract Summary

### Proxy Route Pattern

Every proxy route follows the same pattern:

```typescript
export async function GET(request: NextRequest) {
  // 1. Extract auth context from JWT
  const auth = await getAuthContext();

  // 2. Enforce minimum role
  const denied = requireRole(auth, 'VIEWER');
  if (denied) return denied;

  // 3. Build Runtime URL with query params
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/...`;

  // 4. Proxy with identity headers
  try {
    const res = await fetch(url, { headers: await getRuntimeHeaders() });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
}
```

### Error Envelope

All error responses follow:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

Or for proxy pass-through, the Runtime's own error format is preserved.

---

## 7. Cross-Cutting Concerns

### Logging Strategy

| Context        | Current                 | Recommended                                         |
| -------------- | ----------------------- | --------------------------------------------------- |
| Auth errors    | `console.error`         | `createLogger('admin-auth')`                        |
| Proxy failures | No logging              | `createLogger('admin-proxy')` with request metadata |
| Audit actions  | `console.log` + MongoDB | Keep MongoDB + migrate to `createLogger`            |
| Health checks  | No logging              | Structured health check logging                     |

### Internationalization

- Currently English-only
- All user-facing strings are hardcoded in component files
- Should extract to i18n system when multi-language support needed (not in current scope)

### Error Recovery

- SWR provides automatic retry on focus/network reconnect
- Manual refresh buttons on all data pages
- Graceful degradation: pages that don't depend on Runtime (config, secrets, audit) continue working

---

## 8. Security Architecture

### Threat Model

| Threat              | Mitigation                              | Residual Risk                                       |
| ------------------- | --------------------------------------- | --------------------------------------------------- |
| JWT theft           | httpOnly cookies, secure flag, sameSite | Session replay within cookie lifetime               |
| Role escalation     | Server-side RBAC on every route         | JWT role claims are trusted (no server-side lookup) |
| CSRF                | sameSite=strict cookies                 | No CSRF token (medium risk for same-site attacks)   |
| Path traversal      | Input validation on catch-all routes    | Only resilience proxy has catch-all                 |
| Credential exposure | Secrets masked in API responses         | Admin operators can see masked values               |
| Audit tampering     | MongoDB write-only for admin app        | Database-level access control needed                |

### Recommended Improvements

1. Add CSRF token for mutation endpoints
2. Add rate limiting on auth endpoints (brute-force protection)
3. Migrate from `console.log` to structured logging
4. Add server-side JWT role verification (not just decode)
5. Add session revocation mechanism (currently relies on cookie expiry)

---

## 9. Technology Stack

| Layer      | Technology               | Version   | Purpose                               |
| ---------- | ------------------------ | --------- | ------------------------------------- |
| Framework  | Next.js                  | 16.x      | App Router, API Routes, Middleware    |
| Runtime    | React                    | 19.x      | UI rendering                          |
| State      | SWR                      | 2.x       | Client-side data fetching and caching |
| Charts     | Recharts                 | 2.x       | Usage analytics visualizations        |
| Icons      | Lucide React             | 0.400+    | Icon system                           |
| JWT        | jose                     | 5.x       | JWT decoding (no verification)        |
| Validation | Zod                      | 3.x       | Input validation schemas              |
| Styling    | Tailwind CSS             | 3.x       | Utility-first CSS                     |
| Testing    | Vitest + Playwright      | 4.x / 1.x | Unit/integration + E2E                |
| UI Library | @agent-platform/admin-ui | workspace | Shared admin components               |

---

## 10. Deployment Architecture

```
                    ┌──────────────────┐
                    │  Load Balancer    │
                    │  (IP Allowlist)   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Admin Pods       │
                    │  (N replicas)     │
                    │  Port 3003        │
                    │  Stateless        │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼──────┐ ┌────▼──────────┐
     │  Runtime API   │ │  MongoDB   │ │  Vault/ESO    │
     │  (internal)    │ │  (shared)  │ │  (secrets)    │
     └───────────────┘ └───────────┘ └───────────────┘
```

### Environment Variables

| Variable                         | Required | Default                  | Description                   |
| -------------------------------- | -------- | ------------------------ | ----------------------------- |
| `JWT_SECRET`                     | Yes      | `development-secret-...` | Must match Runtime and Studio |
| `STUDIO_API_URL`                 | Yes      | `http://localhost:5173`  | Studio API for dev-login      |
| `RUNTIME_API_URL`                | No       | `http://localhost:3112`  | Runtime API base URL          |
| `NEXT_PUBLIC_BASE_URL`           | No       | `http://localhost:3003`  | Admin base URL for redirects  |
| `NEXT_PUBLIC_BITBUCKET_REPO_URL` | No       | --                       | Bitbucket link in sidebar     |
| `NEXT_PUBLIC_ARGOCD_URL`         | No       | --                       | ArgoCD link in sidebar        |
| `NODE_ENV`                       | No       | `development`            | Environment mode              |

---

## 11. Decision Log

| ID   | Decision                                            | Rationale                                                                    | Date       |
| ---- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| D-01 | Proxy pattern (BFF) instead of direct DB access     | Avoids business logic duplication; centralized data access in Runtime        | 2026-03-22 |
| D-02 | JWT from Studio dev-login, not dedicated admin auth | Reuses existing auth infrastructure; reduces maintenance                     | 2026-03-22 |
| D-03 | 5-tier RBAC hierarchy                               | Covers all admin use cases from read-only to super-admin                     | 2026-03-22 |
| D-04 | Client-side data fetching (not SSR)                 | Admin is internal tool; SEO not needed; simplifies data flow                 | 2026-03-22 |
| D-05 | Shared UI in `@agent-platform/admin-ui`             | Consistent look between admin and studio workspace admin                     | 2026-03-22 |
| D-06 | MongoDB for audit logging (not ClickHouse)          | Write-heavy, low-volume; MongoDB is already connected                        | 2026-03-22 |
| D-07 | No server-side caching                              | Ensures data freshness for operational tool; latency acceptable              | 2026-03-22 |
| D-08 | Catch-all route for resilience proxy                | Avoids maintaining individual route files for every circuit breaker endpoint | 2026-03-22 |
