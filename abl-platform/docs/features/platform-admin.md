# Feature Spec: Platform Admin

- **Feature ID:** F019-platform-admin (#41)
- **Status:** BETA
- **Owner:** Platform Engineering
- **Created:** 2026-03-22
- **Last Updated:** 2026-03-22

---

## 1. Problem Statement

The ABL platform serves enterprise customers requiring granular tenant management, user governance, system configuration, billing controls, and operational visibility. Today, the Platform Admin app (`apps/admin/`) provides 10+ dashboard pages covering tenant management, config/secrets, deals, resilience, usage analytics, audit logging, and system health -- but lacks a comprehensive feature specification that documents requirements, acceptance criteria, and integration boundaries. Without this, new development risks inconsistency and gaps in isolation, authorization, and observability.

## 2. Background & Context

### Current State

The admin app is a Next.js 16 application on port 3003 that acts as a **proxy layer** between the browser and the Runtime API (`localhost:3112`). It implements:

- **Authentication:** JWT-based via Studio dev-login, session cookie (`admin-session`), idle timeout tracking (`admin-last-activity`)
- **Authorization:** 5-tier RBAC hierarchy: VIEWER < OPERATOR < ADMIN < OWNER < SUPER_ADMIN (via `role-guard.ts`)
- **Proxy Pattern:** All data routes proxy to `GET/POST/PATCH /api/platform/admin/*` on Runtime
- **UI Components:** Shared `@agent-platform/admin-ui` package (DataTable, MetricCard, StatusBadge, FilterBar, PageHeader, ConfirmDialog, ChartCard, EmptyState, Tabs, Skeleton, DateRangePicker)
- **Audit Logging:** MongoDB-backed via `@agent-platform/database` AuditLog model

### Existing Pages

| Page                | Route               | API Proxy Target                                                             | Min Role                       |
| ------------------- | ------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Dashboard Overview  | `/`                 | `/api/config`, `/api/secrets`, `/api/audit`                                  | VIEWER                         |
| Tenant Management   | `/tenants`          | `/api/platform/admin/tenants`                                                | VIEWER                         |
| Tenant Detail       | `/tenants/[id]`     | `/api/platform/admin/tenants/:id` (+ members, projects, subscription, usage) | VIEWER                         |
| Config Overrides    | `/config-overrides` | `/api/platform/admin/tenant-config`                                          | VIEWER                         |
| Model Provisioning  | `/models`           | `/api/platform/admin/tenant-models`                                          | VIEWER                         |
| Deal Management     | `/deals`            | `/api/platform/admin/deals`                                                  | VIEWER                         |
| Resilience Controls | `/resilience`       | `/api/platform/admin/resilience/*`                                           | VIEWER (GET) / OPERATOR (POST) |
| System Health       | `/health`           | `/api/platform/admin/system-health`                                          | VIEWER                         |
| Usage & Analytics   | `/usage`            | `/api/platform/admin/usage-summary`                                          | VIEWER                         |
| Audit Log           | `/audit`            | MongoDB AuditLog direct query                                                | VIEWER                         |
| Configuration       | `/config`           | Vault/ConfigMap via `vault-client.ts`                                        | VIEWER                         |
| Secrets             | `/secrets`          | Vault/ESO via `vault-client.ts`                                              | VIEWER                         |

### RFC Reference

- **RFC-019:** Admin and Governance Surfaces -- 216 files across apps/admin (92), apps/studio (45), apps/telco-noc (44), packages/admin-ui (16), packages/database (10), apps/runtime (9)
- **Enterprise Spec:** `docs/enterprise/BILLING_HUBSPOT_ADMIN_SPEC.md` -- deal-based billing, HubSpot sync, workspace admin

## 3. Goals

1. **G1 -- Tenant Lifecycle Management:** Provide complete CRUD for tenants including status transitions (active/suspended/archived), plan tier changes, config overrides, and member management
2. **G2 -- Operational Visibility:** Centralized system health monitoring, circuit breaker management, service dependency graphs, and real-time usage analytics
3. **G3 -- Billing & Deal Governance:** Deal lifecycle management with phased limits, credit allocation/top-up, line item tracking, and HubSpot CRM integration
4. **G4 -- Security & Compliance:** RBAC enforcement on every route, audit logging for all admin actions, JWT session management with idle timeout, secrets rotation tracking
5. **G5 -- Configuration Management:** Environment-aware config viewing, cross-environment diff, validation, and per-tenant config overrides with plan-based defaults

## 4. Non-Goals

- **NG1:** Self-service tenant registration (tenants are provisioned by platform ops)
- **NG2:** Real-time alerting / PagerDuty integration (out of scope for v1; observability is read-only)
- **NG3:** Multi-region admin federation (single-region deployment assumed)
- **NG4:** Custom branding per tenant on the admin portal
- **NG5:** Direct database write operations from admin UI (all writes proxy through Runtime)

## 5. User Stories

### Tenant Management

- **US-01:** As a platform operator, I can list all tenants with search, status filter, and plan tier filter, so I can find a specific tenant quickly
- **US-02:** As a platform operator, I can view a tenant's detail page showing subscription, members, projects, usage, and config overrides
- **US-03:** As a platform admin, I can change a tenant's status (suspend/activate/archive) with confirmation dialog
- **US-04:** As a platform admin, I can set per-tenant config overrides that exceed plan defaults

### Billing & Deals

- **US-05:** As a platform operator, I can list all deals with filtering by organization and status
- **US-06:** As a platform operator, I can view deal details including phases, credit allocation, and line items
- **US-07:** As a platform admin, I can update deal settings (name, status, overage policy)
- **US-08:** As a platform admin, I can perform credit top-ups and create billing line items
- **US-09:** As a platform admin, I can link/unlink HubSpot deals and trigger sync

### Operations

- **US-10:** As a platform operator, I can view system health across all services (core-data, agent-execution, search-knowledge, frontend groups)
- **US-11:** As a platform operator, I can view circuit breaker states and reset individual breakers
- **US-12:** As a platform operator, I can check tenant-specific circuit breaker health (tenant, app, LLM provider, tool service levels)
- **US-13:** As a platform admin, I can force-reset all circuit breakers for a specific tenant

### Configuration & Secrets

- **US-14:** As a platform operator, I can view configuration by environment (dev/staging/production)
- **US-15:** As a platform operator, I can diff configuration between environments
- **US-16:** As a platform operator, I can view secrets loaded via External Secrets Operator
- **US-17:** As a platform operator, I can view secret rotation history

### Observability

- **US-18:** As a platform operator, I can view usage analytics with time series, top tenants, and provider breakdown
- **US-19:** As a platform operator, I can view per-tenant usage when drilling into a tenant detail page
- **US-20:** As a platform operator, I can view audit log with filtering by actor, action, and time range
- **US-21:** As a platform operator, I can view model provisioning status and connections per model

## 6. Functional Requirements

### FR-01: Authentication & Session Management

- JWT token obtained from Studio dev-login endpoint and stored as httpOnly cookie (`admin-session`)
- Session max age: 8 hours; idle timeout: 30 minutes (tracked via `admin-last-activity` cookie)
- Middleware validates JWT on every request, extracts role claim
- SUPER_ADMIN bypass for users with `isSuperAdmin: true` in JWT claims
- Logout clears both cookies and redirects to login page

### FR-02: Role-Based Access Control

- 5-tier hierarchy: VIEWER(0) < OPERATOR(1) < ADMIN(2) < OWNER(3) < SUPER_ADMIN(4)
- `requireRole(auth, minimumRole)` guard on every API route
- Read-only operations (GET) require VIEWER minimum
- Mutation operations (POST/PATCH/DELETE) require OPERATOR or ADMIN minimum
- Destructive operations (force-reset, tenant archive) require ADMIN minimum
- Cross-tenant queries allowed for platform admins (no tenant scoping on admin routes)
- Returns 403 with descriptive error when role insufficient

### FR-03: Tenant CRUD

- List tenants with server-side pagination (page, limit), search, status filter, planTier filter
- Tenant detail: aggregate tenant record, subscription, member count, projects, usage
- Status transitions: active <-> suspended, active/suspended -> archived (one-way)
- Config overrides: per-tenant limits that override plan defaults (maxConcurrentSessions, requestsPerMinute, tokensPerMinute, etc.)
- Plan defaults: FREE, TEAM, BUSINESS, ENTERPRISE tiers with predefined limits and features

### FR-04: Deal & Billing Management

- Deal CRUD: create, list (with org/status filter), detail, update settings
- Deal phases: time-bounded phases with per-environment (dev/staging/production) limit sets
- Credit system: total allocation, per-feature usage, shared pool, rollover policies (none/partial/full)
- Line items: base, overage, addon, credit_topup categories; invoiced tracking
- HubSpot integration: link deal to HubSpot deal ID, trigger one-way sync

### FR-05: System Health Monitoring

- Aggregate health check across all platform services
- Service grouping: core-data, agent-execution, search-knowledge, frontend
- Per-service metrics: status (healthy/degraded/down/unknown), latency, last check time, dependencies
- Summary counts: healthy, degraded, down, total

### FR-06: Resilience Controls

- Circuit breaker overview: list all breakers with state (closed/open/half-open), failure count
- Backend indicator: Redis or memory-backed breakers
- Individual breaker reset (OPERATOR role)
- Per-tenant health: tenant-level, app-level, LLM provider, tool service breakers
- Force-reset all breakers for a tenant (ADMIN role, with confirmation dialog)

### FR-07: Configuration Management

- Environment-aware config retrieval (dev, staging, production)
- Config diff between any two environments
- Config validation before deployment
- Vault provider integration for secrets (ESO pattern)
- Secret rotation history tracking

### FR-08: Usage Analytics

- Summary metrics: total tokens, total cost, session count, active tenants
- Time series: token/cost/session trends by period
- Top tenants by cost and token consumption
- Provider breakdown with percentage allocation
- Per-tenant usage drill-down from tenant detail page

### FR-09: Audit Logging

- Log all admin actions: config_view, secret_list, and extensible action types
- Capture: actor (userId), actorRole, action, target, environment, IP address, metadata
- MongoDB persistence with console fallback
- Query with filters: actor, action, time range, limit
- Display in audit log page with pagination

### FR-10: Model Provisioning

- List tenant models with status, provider, and connection details
- Model detail with associated connections
- Connection management: list, create, validate connections per model

### FR-11: Runtime Proxy Layer

- All data routes proxy through Next.js API routes to Runtime API (`/api/platform/admin/*`)
- Standardized header forwarding: Authorization (Bearer JWT), x-admin-user-id, x-admin-user-email, x-admin-user-role, x-forwarded-for
- Error envelope: `{ success: boolean, data?, error?: { code, message } }`
- 502 fallback on network failure to runtime

### FR-12: Shared UI Component Library

- `@agent-platform/admin-ui` package shared between admin and studio
- Components: DataTable (sortable, paginated), MetricCard, StatusBadge, FilterBar, PageHeader, ConfirmDialog, EmptyState, Skeleton, Tabs, ChartCard, DateRangePicker
- HSL-based design tokens, Tailwind CSS, Radix UI primitives

## 7. Non-Functional Requirements

- **NFR-01 Performance:** Dashboard page load < 2s; tenant list with 1000+ tenants paginates server-side with < 500ms response
- **NFR-02 Security:** All cookies httpOnly + secure + sameSite=strict in production; no secrets exposed in client bundles; path traversal rejected on resilience proxy
- **NFR-03 Reliability:** 502 graceful degradation when Runtime unreachable; SWR stale-while-revalidate for cached data
- **NFR-04 Accessibility:** WCAG 2.1 AA compliance for admin UI; keyboard navigation on DataTable; ARIA labels on status badges
- **NFR-05 Observability:** Audit log for all admin actions; console logging as fallback; structured error responses
- **NFR-06 Scalability:** Stateless proxy layer allows horizontal scaling; no pod-local state

## 8. API Surface

### Admin Proxy Routes (Next.js -> Runtime)

| Method   | Admin Route                               | Runtime Target                                      | Min Role        |
| -------- | ----------------------------------------- | --------------------------------------------------- | --------------- |
| GET      | `/api/tenants`                            | `/api/platform/admin/tenants`                       | VIEWER          |
| GET      | `/api/tenants/[tenantId]`                 | `/api/platform/admin/tenants/:id`                   | VIEWER          |
| PATCH    | `/api/tenants/[tenantId]`                 | `/api/platform/admin/tenants/:id/status`            | ADMIN           |
| GET      | `/api/tenants/[tenantId]/members`         | `/api/platform/admin/tenants/:id/members`           | VIEWER          |
| GET      | `/api/tenants/[tenantId]/projects`        | `/api/platform/admin/tenants/:id/projects`          | VIEWER          |
| GET      | `/api/tenants/[tenantId]/subscription`    | `/api/platform/admin/tenants/:id/subscription`      | VIEWER          |
| GET      | `/api/tenants/[tenantId]/usage`           | `/api/platform/admin/tenants/:id/usage`             | VIEWER          |
| GET      | `/api/tenant-config`                      | `/api/platform/admin/tenant-config`                 | VIEWER          |
| GET      | `/api/tenant-config/plans`                | `/api/platform/admin/tenant-config/plans`           | VIEWER          |
| GET      | `/api/tenant-config/[tenantId]`           | `/api/platform/admin/tenant-config/:id`             | VIEWER          |
| PUT      | `/api/tenant-config/[tenantId]/overrides` | `/api/platform/admin/tenant-config/:id/overrides`   | ADMIN           |
| DELETE   | `/api/tenant-config/[tenantId]/overrides` | `/api/platform/admin/tenant-config/:id/overrides`   | ADMIN           |
| GET      | `/api/tenant-models`                      | `/api/platform/admin/tenant-models`                 | VIEWER          |
| GET      | `/api/tenant-models/[id]`                 | `/api/platform/admin/tenant-models/:id`             | VIEWER          |
| GET      | `/api/tenant-models/[id]/connections`     | `/api/platform/admin/tenant-models/:id/connections` | VIEWER          |
| GET      | `/api/deals`                              | `/api/platform/admin/deals`                         | VIEWER          |
| GET      | `/api/deals/[id]`                         | `/api/platform/admin/deals/:id`                     | VIEWER          |
| PATCH    | `/api/deals/[id]`                         | `/api/platform/admin/deals/:id`                     | ADMIN           |
| GET      | `/api/deals/[id]/credits`                 | `/api/platform/admin/deals/:id/credits`             | VIEWER          |
| POST     | `/api/deals/[id]/credits`                 | `/api/platform/admin/deals/:id/credits`             | ADMIN           |
| GET      | `/api/deals/[id]/line-items`              | `/api/platform/admin/deals/:id/line-items`          | VIEWER          |
| POST     | `/api/deals/[id]/line-items`              | `/api/platform/admin/deals/:id/line-items`          | ADMIN           |
| GET      | `/api/system-health`                      | `/api/platform/admin/system-health`                 | VIEWER          |
| GET      | `/api/usage`                              | `/api/platform/admin/usage-summary`                 | VIEWER          |
| GET/POST | `/api/resilience/[...path]`               | `/api/platform/admin/resilience/*`                  | VIEWER/OPERATOR |
| POST     | `/api/hubspot`                            | `/api/platform/admin/hubspot`                       | ADMIN           |
| GET      | `/api/audit`                              | MongoDB direct (AuditLog)                           | VIEWER          |
| GET      | `/api/config`                             | Vault/ConfigMap direct                              | VIEWER          |
| GET      | `/api/config/diff`                        | Vault/ConfigMap direct                              | VIEWER          |
| POST     | `/api/config/validate`                    | Vault/ConfigMap direct                              | OPERATOR        |
| GET      | `/api/secrets`                            | Vault/ESO direct                                    | VIEWER          |
| GET      | `/api/secrets/rotation`                   | Vault/ESO direct                                    | VIEWER          |
| GET      | `/api/health`                             | Local health check                                  | None            |

## 9. Data Model

### Key Entities (referenced via Runtime proxy)

| Entity                | Collection               | Owner Package              |
| --------------------- | ------------------------ | -------------------------- |
| Tenant                | tenants                  | `@agent-platform/database` |
| TenantMember          | tenant_members           | `@agent-platform/database` |
| Project               | projects                 | `@agent-platform/database` |
| Organization          | organizations            | `@agent-platform/database` |
| Deal                  | deals                    | `@agent-platform/database` |
| CreditLedger          | credit_ledgers           | `@agent-platform/database` |
| BillingLineItem       | billing_line_items       | `@agent-platform/database` |
| ModelConfig           | model_configs            | `@agent-platform/database` |
| LLMCredential         | llm_credentials          | `@agent-platform/database` |
| AuditLog              | audit_logs               | `@agent-platform/database` |
| RoleDefinition        | role_definitions         | `@agent-platform/database` |
| MaterializedKMSConfig | materialized_kms_configs | `@agent-platform/database` |

### Admin-Local Types (`apps/admin/src/types/api.ts`)

- `TenantSummary`, `TenantDetailResponse`, `TenantMember`, `TenantProject`
- `TenantLimits` (16 numeric fields), `TenantFeatures` (9 boolean fields)
- `PlanTier` (FREE/TEAM/BUSINESS/ENTERPRISE), `PlanDefaults`
- `Deal`, `CreditLedger`, `CreditEntry`, `BillingLineItem`
- `ServiceHealth`, `SystemHealthResponse`, `ServiceGroup`
- `UsageSummary`, `UsageTimeSeries`, `UsageTopTenant`, `UsageProviderBreakdown`
- `AuditEntry`, `AuditResponse`, `ConfigResponse`, `ConfigDiff`, `SecretEntry`

## 10. Architecture & Integration Points

### Service Dependencies

```
Browser -> Admin (Next.js :3003) -> Runtime API (:3112) -> MongoDB/Redis/ClickHouse
                                 -> Vault/ConfigMap (config/secrets direct)
                                 -> MongoDB AuditLog (audit direct)
Admin -> Studio (:5173) (authentication only -- dev-login JWT issuance)
```

### Package Dependencies

- `@agent-platform/admin-ui`: Shared UI components
- `@agent-platform/config`: Port constants, environment config
- `@agent-platform/database`: Mongoose models (AuditLog for direct access)
- `@agent-platform/shared`: Auth middleware types (not directly used; Runtime handles auth)

## 11. Security Considerations

- **SC-01:** JWT tokens never exposed to client-side JavaScript (httpOnly cookies)
- **SC-02:** CSRF protection via sameSite=strict cookie policy
- **SC-03:** Path traversal prevention on catch-all resilience proxy route (`..` and leading `/` rejected)
- **SC-04:** Secrets never returned in full to the browser (masked display)
- **SC-05:** IP allowlisting recommended for production deployment (load balancer config)
- **SC-06:** All mutative actions require ADMIN+ role; read operations require VIEWER+
- **SC-07:** Audit logging captures actor identity and IP for all sensitive operations
- **SC-08:** Session idle timeout (30 min) prevents unattended access

## 12. Observability & Monitoring

- **Audit trail:** Every admin action logged to MongoDB AuditLog with actor, action, target, IP, timestamp
- **Console logging:** Fallback for when MongoDB is unavailable
- **Error responses:** Structured `{ success, error: { code, message } }` envelope
- **Health endpoint:** `/api/health` returns service status without auth
- **System health dashboard:** Aggregates health from all platform services

## 13. Performance Considerations

- **Server-side pagination:** All list endpoints paginate (default 25 items/page) to avoid large payloads
- **SWR caching:** Client-side stale-while-revalidate via `use-swr-fetch` hook
- **Debounced search:** 300ms debounce on search input to reduce API calls
- **Proxy overhead:** Admin is a thin proxy; latency is dominated by Runtime API response time
- **No server-side rendering data:** Dashboard pages are `'use client'` with client-side data fetching

## 14. Migration & Rollout Plan

- **Phase 1 (Current):** All existing pages operational -- tenant management, deals, config, secrets, audit, health, resilience, usage, models
- **Phase 2:** Add user management page (direct user CRUD, role assignment)
- **Phase 3:** Add real-time notifications and webhook management
- **Phase 4:** Add advanced analytics with custom date ranges and export

## 15. Feature Flags & Rollout Strategy

- No feature flags currently implemented in admin app
- Recommended: Add `ADMIN_FEATURES` config for enabling/disabling pages per deployment
- Production deployment gated by IP allowlist at load balancer level

## 16. Dependencies & Risks

| Risk                | Impact                                                    | Mitigation                                                        |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Runtime unavailable | Admin becomes read-only (config/secrets/audit still work) | 502 graceful degradation with retry buttons                       |
| JWT secret mismatch | Auth fails for all users                                  | `.env.example` documents JWT_SECRET must match across services    |
| MongoDB unavailable | Audit logging fails silently                              | Console fallback + monitoring                                     |
| Stale SWR cache     | Users see outdated data                                   | Manual refresh buttons on all data pages                          |
| Role escalation     | Unauthorized mutations                                    | Server-side role check on every route; no client-side only checks |

## 17. Success Metrics

- **SM-01:** 100% of admin API routes have role-guard enforcement
- **SM-02:** Audit log captures 100% of admin mutative actions
- **SM-03:** Page load time < 2s for all dashboard pages (P95)
- **SM-04:** Zero cross-tenant data leakage in admin queries
- **SM-05:** E2E test coverage for all tenant lifecycle operations

## 18. Open Questions & Decisions

| ID    | Question                                                                 | Decision                                                                         | Status  |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------- |
| OQ-01 | Should admin support SSO/SAML in addition to JWT dev-login?              | Deferred to Phase 3; dev-login sufficient for internal tool                      | DECIDED |
| OQ-02 | Should config mutations be allowed directly from admin, or only via Git? | Config is read-only in admin; mutations via GitOps pipeline                      | DECIDED |
| OQ-03 | Should admin have its own database or continue proxying through Runtime? | Continue proxy pattern; admin is a thin presentation layer                       | DECIDED |
| OQ-04 | Need for real-time WebSocket updates on health/resilience pages?         | Polling via SWR with manual refresh; WebSocket deferred                          | DECIDED |
| OQ-05 | Should existing E2E tests mock fetch or use real server?                 | Existing tests mock fetch; new tests should use real HTTP API per SDLC standards | DECIDED |
