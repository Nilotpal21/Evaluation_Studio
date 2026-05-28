# Platform Admin — Low-Level Design

## Implementation Structure

Platform Admin is organized into two deployable units: 10 Express route modules in the Runtime service and a Next.js admin dashboard app. All route modules follow the same pattern: shared middleware stack (auth, rate limit, platform admin, IP allowlist), Zod validation, Mongoose/ClickHouse data access, audit logging, structured error responses.

## Key Files

### Runtime Route Modules

| File                                                   | Mount Path                          | Purpose                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/platform-admin-tenants.ts`    | `/api/platform/admin/tenants`       | Tenant CRUD, member management (add/remove/role), project management, subscription plan changes. Enriches list with subscription planTier and member count.                                                                                 |
| `apps/runtime/src/routes/platform-admin-health.ts`     | `/api/platform/admin/system-health` | Native health checks (MongoDB ping, Redis PING, ClickHouse SELECT 1) and HTTP probes for registered services. Uses `SERVICE_REGISTRY` static map with `getServiceUrl()` + `isServiceConfigured()`. Returns per-service status with latency. |
| `apps/runtime/src/routes/platform-admin-usage.ts`      | `/api/platform/admin/usage`         | Cross-tenant LLM usage analytics via MongoDB aggregation pipeline. Supports date range filtering, time-series grouping (hour/day), top-tenants-by-cost, provider breakdown.                                                                 |
| `apps/runtime/src/routes/platform-admin-deals.ts`      | `/api/platform/admin/deals`         | Deal lifecycle CRUD, assignment to organizations, credit ledger management (get/create/top-up), billing line items (list/create). Cascading delete for deals.                                                                               |
| `apps/runtime/src/routes/platform-admin-features.ts`   | `/api/platform/admin/features`      | Static `FEATURE_CATALOG` (8 features with plan-tier defaults). Feature resolution per tenant (plan defaults + deal features + entitlement overrides). Entitlement toggle (grant/deny).                                                      |
| `apps/runtime/src/routes/platform-admin-models.ts`     | `/api/platform/admin/models`        | LLM credential provisioning per tenant. CRUD + connection test (Vercel AI SDK) + key rotation via `findOne` + `save` (triggers Mongoose encrypt middleware).                                                                                |
| `apps/runtime/src/routes/platform-admin-resilience.ts` | `/api/platform/admin/resilience`    | Circuit breaker inspection (in-process `CircuitBreakerRegistry` + Redis `HybridCBRegistry`). Tenant-level health aggregation. Force reset with configurable target state.                                                                   |
| `apps/runtime/src/routes/platform-admin-traces.ts`     | `/api/platform/admin/traces`        | Cross-tenant trace search via ClickHouse parameterized queries. PII-safe column selection (BLOCKED: data, error_message, metadata, actor_id). Trace detail timeline, STI performance, LLM cost breakdown.                                   |
| `apps/runtime/src/routes/platform-admin-config.ts`     | `/api/platform/admin/tenant-config` | Plan defaults from `PLAN_LIMITS` constant. Tenant/project config overrides stored in Subscription model's `tenantQuotas`/`projectQuotas`. Redis cache invalidation on mutations.                                                            |
| `apps/runtime/src/routes/platform-admin-hubspot.ts`    | `/api/platform/admin/hubspot`       | HubSpot CRM integration for deal linking and organization sync.                                                                                                                                                                             |

### Shared Middleware Stack (per route module)

Each route module applies this middleware stack in order:

1. `platformAdminAuthMiddleware` — JWT verification, tenant context injection
2. `tenantRateLimit('request')` — rate limiting
3. `requirePlatformAdmin()` — asserts `isSuperAdmin: true` on request context
4. `requirePlatformAdminIp()` — IP allowlist check against `getConfig().security.platformAdminAllowedIps`

### Admin Dashboard App

| File                                             | Purpose                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/lib/with-admin-route.ts`         | Route handler wrapper: JWT verification (jose), session age (8h), idle timeout (30min), role hierarchy check, anti-spoofing header stripping, idle cookie management |
| `apps/admin/src/lib/runtime-proxy.ts`            | `getRuntimeBaseUrl()` and `buildRuntimeHeaders(ctx)` for constructing authenticated proxy requests to Runtime API                                                    |
| `apps/admin/src/lib/role-guard.ts`               | `ROLE_HIERARCHY` map (SUPER_ADMIN > OWNER > ADMIN > OPERATOR > VIEWER)                                                                                               |
| `apps/admin/src/lib/audit-logger.ts`             | Client-side audit logging utilities                                                                                                                                  |
| `apps/admin/src/lib/auth-context.ts`             | Auth context extraction from headers/cookies (deprecated in favor of `withAdminRoute`)                                                                               |
| `apps/admin/src/app/(dashboard)/layout.tsx`      | Dashboard layout with 5 nav groups: OVERVIEW, TENANTS, OPERATIONS, OBSERVABILITY, INFRASTRUCTURE                                                                     |
| `apps/admin/src/app/(auth)/login/page.tsx`       | Login page with JWT-based authentication                                                                                                                             |
| `apps/admin/src/app/api/auth/dev-login/route.ts` | Development login endpoint                                                                                                                                           |
| `apps/admin/src/app/api/auth/logout/route.ts`    | Logout endpoint (cookie clearing)                                                                                                                                    |

### Dashboard Pages

| Page                | Path                                       | Runtime Routes Used                                           |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Dashboard Home      | `/`                                        | Usage summary                                                 |
| Tenant Management   | `/tenants`                                 | tenants list, detail, status, subscription, members, projects |
| Config Overrides    | `/config-overrides`                        | tenant-config CRUD                                            |
| Model Provisioning  | `/models`, `/models/[id]`                  | models CRUD, test, rotate                                     |
| Deal Management     | `/deals`, `/deals/[id]`                    | deals CRUD, credits, line items                               |
| Feature Catalog     | `/features`                                | features catalog, resolution, toggle                          |
| Resilience Controls | `/resilience`                              | resilience CB states, tenant health, force reset              |
| System Health       | `/health`                                  | system-health native checks + HTTP probes                     |
| Trace Inspector     | `/traces`, `/traces/[traceId]`             | traces search, detail, performance, cost                      |
| Usage & Analytics   | `/usage`                                   | usage summary, time-series, top-tenants                       |
| Audit Log           | `/audit`                                   | audit log listing                                             |
| Configuration       | `/config`, `/config/[env]`, `/config/diff` | config viewing and diff                                       |
| Secrets             | `/secrets`, `/secrets/rotation`            | secrets management, rotation                                  |

### Test Files

| File                                                             | Type        | Scenarios                                                                                               |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/platform-admin-tenants.test.ts`      | unit        | 7 scenarios: list with enrichment, filters, detail, 404, status change, validation, auth                |
| `apps/runtime/src/__tests__/platform-admin-deals.test.ts`        | unit        | 11 scenarios: list, create, detail, update, assign, credits, top-up, line items, validation             |
| `apps/runtime/src/__tests__/platform-admin-config.test.ts`       | unit        | 9 scenarios: plan defaults, resolved config, overrides CRUD, validation, project overrides, auth, audit |
| `apps/runtime/src/__tests__/platform-admin-traces.test.ts`       | unit        | 7 scenarios: search, detail, performance, cost, session summary, PII boundary, audit                    |
| `apps/runtime/src/__tests__/platform-admin-resilience.test.ts`   | unit        | 7 scenarios: CB states, tenant health, force reset, validation, single reset, 404, audit                |
| `apps/runtime/src/__tests__/platform-admin-models-authz.test.ts` | unit        | 3 scenarios: super-admin allowed, non-super-admin 403, unauthenticated 401                              |
| `apps/admin/src/__tests__/tenant-lifecycle.e2e.test.ts`          | integration | 5 scenarios: proxy request construction for tenant CRUD                                                 |
| `apps/admin/src/__tests__/deal-lifecycle.e2e.test.ts`            | integration | 5 scenarios: proxy request construction for deal CRUD                                                   |

## Known Gaps

| ID      | Gap                                                         | Severity | Notes                                                                              |
| ------- | ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| GAP-001 | No E2E tests with real middleware chain                     | High     | All runtime unit tests mock auth middleware                                        |
| GAP-002 | No tests for health, usage, features, hubspot routes        | Medium   | 4 of 10 route modules have zero test coverage                                      |
| GAP-003 | `console.error` used in `with-admin-route.ts` error handler | Low      | Should use `createLogger` per CLAUDE.md rules                                      |
| GAP-004 | `getRuntimeHeaders()` deprecated but still present          | Low      | Legacy function reads from headers/cookies; replaced by `buildRuntimeHeaders(ctx)` |
| GAP-005 | No rate limiting differentiation for admin routes           | Low      | Uses same `tenantRateLimit` as regular routes                                      |
| GAP-006 | Health HTTP probes have hardcoded 4000ms timeout            | Low      | Should be configurable                                                             |
| GAP-007 | Admin dashboard page wiring may be incomplete               | Medium   | Not all pages verified to be fully connected to backend routes                     |
