# Feature Spec: Proxy Configuration

**Status**: ALPHA
**Owner**: Platform team
**Created**: 2026-03-23
**Last updated**: 2026-03-23

---

## Problem Statement

Enterprise customers deploying the ABL platform in corporate environments require all outbound HTTP traffic (LLM API calls, tool invocations, webhook callbacks) to route through organization-managed proxy servers. Without proxy configuration support, the platform cannot operate in environments with restricted internet access, compliance-mandated traffic inspection, or network segmentation requirements.

## Scope

### In Scope

- **Org-level proxy CRUD API** -- tenant-scoped REST endpoints for creating, listing, updating, and deleting proxy configurations
- **Proxy resolution at runtime** -- URL pattern matching to determine which proxy to use for outbound HTTP requests from tool executors and LLM calls
- **Authentication support** -- none, basic, bearer, and custom auth types for proxy servers
- **Certificate management** -- custom CA certificates and mTLS client certificates (encrypted at rest)
- **Environment scoping** -- proxy configs scoped to dev/staging/prod environments
- **Priority ordering** -- multiple proxy configs with priority-based selection
- **Bypass patterns** -- URL patterns that should skip proxy routing
- **SSRF protection** -- validation that proxy URLs do not target private IPs or cloud metadata endpoints
- **RBAC enforcement** -- proxy:read, proxy:write, proxy:delete permissions mapped to system roles
- **Audit logging** -- all CRUD operations logged with action, tenant, user, and metadata
- **Cache layer** -- ProxyConfigService caches resolved ProxyResolver instances per tenant+environment with TTL
- **Auth profile integration** -- optional linkage to auth profiles for credential resolution

### Out of Scope

- Studio UI for proxy configuration management (separate feature)
- Proxy configuration for LLM provider base URLs (handled by LLM config)
- SOCKS proxy support
- Proxy auto-discovery (PAC files, WPAD)
- Per-project proxy overrides (current scope is org-level only)

## User Stories

### US-1: Admin creates a proxy config

**As** a tenant admin, **I want** to create a proxy configuration with URL patterns and authentication credentials, **so that** outbound HTTP traffic from my agents routes through our corporate proxy.

**Acceptance criteria:**

- POST /api/proxy-configs creates a new config with name, proxyUrl, auth type, and optional credentials
- Credentials (username, password, token, certificates) are encrypted at rest via tenant-scoped AES-256-GCM
- SSRF validation rejects proxy URLs targeting private IPs (127.0.0.0/8, 10.0.0.0/8, 169.254.169.254)
- Duplicate name+environment returns 409 Conflict
- Response includes metadata but never returns raw credentials

### US-2: Admin lists and manages proxy configs

**As** a tenant admin, **I want** to list, update, and delete proxy configurations, **so that** I can manage proxy routing as network requirements change.

**Acceptance criteria:**

- GET /api/proxy-configs returns paginated list with proxyUrl masked to origin-only
- PUT /api/proxy-configs/:id supports partial updates (any field optional)
- DELETE /api/proxy-configs/:id performs hard delete
- All operations scoped to tenant (cross-tenant returns 404, not 403)
- Audit logs emitted for create, update, and delete actions

### US-3: Runtime resolves proxy for outbound requests

**As** a platform operator, **I want** the runtime to automatically route outbound HTTP tool calls through the configured proxy, **so that** agents can access external APIs in restricted network environments.

**Acceptance criteria:**

- ProxyResolver matches target URLs against configured urlPatterns (glob-based hostname matching)
- Highest-priority matching config is selected
- Bypass patterns cause matching URLs to skip proxy
- ProxyConfig auth headers (Proxy-Authorization) are injected for basic/bearer/api_key types
- Custom CA certificates and mTLS client certs are passed to the HTTP executor
- Disabled configs are excluded from resolution

### US-4: Operator views proxy configs (read-only)

**As** an operator, **I want** to view proxy configurations without being able to modify them, **so that** I can troubleshoot connectivity issues.

**Acceptance criteria:**

- OPERATOR role has proxy:read permission
- OPERATOR cannot create, update, or delete (403 Forbidden)
- MEMBER and VIEWER roles have no proxy permissions (all 403)

### US-5: Cache prevents excessive DB queries

**As** a platform engineer, **I want** proxy configs to be cached per tenant+environment with a TTL, **so that** every tool execution does not trigger a database round-trip.

**Acceptance criteria:**

- ProxyConfigService caches ProxyResolver instances with 5-minute TTL
- Cache invalidation available per tenant or per tenant+environment
- Empty results are cached to prevent repeated queries for unconfigured tenants

## Requirements

### Functional Requirements

| ID    | Requirement                                                     | Priority |
| ----- | --------------------------------------------------------------- | -------- |
| FR-1  | CRUD API for proxy configs at /api/proxy-configs                | P0       |
| FR-2  | Tenant-scoped data isolation (every query includes tenantId)    | P0       |
| FR-3  | RBAC with proxy:read, proxy:write, proxy:delete permissions     | P0       |
| FR-4  | Credential encryption at rest (AES-256-GCM, tenant-scoped keys) | P0       |
| FR-5  | SSRF validation on proxy URLs                                   | P0       |
| FR-6  | URL pattern matching (glob-based) for proxy resolution          | P0       |
| FR-7  | Priority-based config selection                                 | P0       |
| FR-8  | Bypass pattern support                                          | P1       |
| FR-9  | Custom CA certificate support                                   | P1       |
| FR-10 | mTLS client certificate support                                 | P1       |
| FR-11 | Environment scoping (dev/staging/prod)                          | P1       |
| FR-12 | Audit logging for all CRUD operations                           | P1       |
| FR-13 | Cache with TTL for ProxyResolver instances                      | P1       |
| FR-14 | Auth profile integration for credential resolution              | P2       |

### Non-Functional Requirements

| ID    | Requirement                                     | Target          |
| ----- | ----------------------------------------------- | --------------- |
| NFR-1 | Proxy resolution latency (cache hit)            | < 1ms           |
| NFR-2 | Proxy resolution latency (cache miss, DB query) | < 50ms          |
| NFR-3 | Certificate fields max size                     | 64KB per field  |
| NFR-4 | Name/pattern fields max size                    | 1024 characters |
| NFR-5 | Pagination default/max page size                | 25/100          |
| NFR-6 | Cache TTL                                       | 5 minutes       |

## Architecture Overview

The feature spans three layers:

1. **Database layer** (`packages/database`) -- `OrgProxyConfig` Mongoose model with tenant isolation plugin, encryption plugin, and composite unique index on (tenantId, name, environment)
2. **Shared layer** (`packages/shared`) -- Repository functions (CRUD), Zod validation schemas, and normalized types; `packages/shared-kernel` for NormalizedOrgProxyConfig type
3. **Runtime layer** (`apps/runtime`) -- REST routes with OpenAPI registration, ProxyConfigService (caching), ProxyResolver (pattern matching + auth injection), integration with HttpToolExecutor

### Data Flow

```
Admin (Studio/API) --> POST /api/proxy-configs --> proxy-config route
  --> Zod validation --> SSRF check --> encryption plugin --> MongoDB

Runtime tool execution --> LLMWiringService --> ProxyConfigService
  --> getResolver(tenantId, env) --> cache hit? return : DB query
  --> ProxyResolver(records, decryptFn, tenantId)
  --> HttpToolExecutor.execute(targetUrl) --> resolver.resolve(targetUrl)
  --> match urlPatterns, skip bypass --> apply proxy auth headers
```

## Decision Log

| ID  | Decision                                          | Classification | Rationale                                                           |
| --- | ------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| D1  | Org-level only (no project-level proxy configs)   | DECIDED        | Enterprise proxies are org-wide; per-project adds complexity        |
| D2  | Hard delete (not soft delete)                     | DECIDED        | Proxy configs are infrastructure, not user data; simplifies queries |
| D3  | proxyUrl masked to origin in list responses       | DECIDED        | Defense in depth; path/query params in proxy URLs are sensitive     |
| D4  | 5-minute cache TTL                                | DECIDED        | Balances freshness vs. DB load; invalidation available for changes  |
| D5  | Glob-based hostname matching (not full URL regex) | DECIDED        | Simpler, safer than arbitrary regex; matches enterprise use cases   |
| D6  | Cross-tenant returns 404 (not 403)                | ANSWERED       | Platform invariant -- prevents resource existence leakage           |
