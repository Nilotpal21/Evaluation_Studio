# High-Level Design: Proxy Configuration

**Status**: ALPHA
**Feature spec**: [docs/features/proxy-config.md](../features/proxy-config.md)
**Test spec**: [docs/testing/proxy-config.md](../testing/proxy-config.md)
**Created**: 2026-03-23
**Last updated**: 2026-03-23

---

## 1. Overview

The Proxy Configuration feature enables enterprise tenants to route all outbound HTTP traffic (tool invocations, webhook callbacks) through organization-managed proxy servers. It provides a CRUD API for proxy config management, a runtime resolution engine for URL-to-proxy matching, encrypted credential storage, and RBAC-controlled access.

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Studio / API Client                                                │
│  (Admin creates/manages proxy configs)                              │
└──────────────┬──────────────────────────────────────────────────────┘
               │ REST API
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Runtime (apps/runtime)                                              │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐    │
│  │  proxy-config route  │    │  LLMWiringService               │    │
│  │  (CRUD + OpenAPI)    │    │  ┌─────────────────────────┐    │    │
│  │  - authMiddleware    │    │  │  ProxyConfigService      │    │    │
│  │  - requirePermission │    │  │  (cache + TTL)           │    │    │
│  │  - tenantRateLimit   │    │  │  ┌───────────────────┐   │    │    │
│  │  - SSRF validation   │    │  │  │  ProxyResolver     │   │    │    │
│  └──────────┬───────────┘    │  │  │  (pattern match)   │   │    │    │
│             │                │  │  └───────────────────┘   │    │    │
│             │                │  └────────────┬──────────────┘    │    │
│             │                │               │                   │    │
│             │                │  ┌────────────▼──────────────┐    │    │
│             │                │  │  HttpToolExecutor          │    │    │
│             │                │  │  (proxy headers + certs)   │    │    │
│             │                │  └───────────────────────────┘    │    │
│             │                └─────────────────────────────────┘    │
└─────────────┼──────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Shared Layer                                                        │
│  ┌─────────────────────┐  ┌──────────────────────┐                  │
│  │  security-repo.ts   │  │  proxy-config-schemas │                  │
│  │  (CRUD functions)   │  │  (Zod validation)     │                  │
│  └─────────┬───────────┘  └──────────────────────┘                  │
│            │                                                         │
│  ┌─────────▼───────────┐  ┌──────────────────────┐                  │
│  │  OrgProxyConfig     │  │  NormalizedOrgProxy   │                  │
│  │  (Mongoose model)   │  │  Config (shared type) │                  │
│  │  + encryptionPlugin │  └──────────────────────┘                  │
│  │  + tenantIsolation  │                                            │
│  └─────────┬───────────┘                                            │
└────────────┼────────────────────────────────────────────────────────┘
             │
             ▼
         MongoDB (org_proxy_configs collection)
```

### 2.2 Existing Implementation Layers

| Layer              | Package                  | Key Files                                      | Status |
| ------------------ | ------------------------ | ---------------------------------------------- | ------ |
| Database model     | `packages/database`      | `models/org-proxy-config.model.ts`             | DONE   |
| Shared types       | `packages/shared-kernel` | `types/security.ts` (NormalizedOrgProxyConfig) | DONE   |
| Repository         | `packages/shared`        | `repos/security-repo.ts` (CRUD functions)      | DONE   |
| Validation schemas | `packages/shared`        | `validation/proxy-config-schemas.ts`           | DONE   |
| REST routes        | `apps/runtime`           | `routes/proxy-config.ts`                       | DONE   |
| Proxy resolver     | `packages/compiler`      | `constructs/executors/proxy-resolver.ts`       | DONE   |
| Config service     | `apps/runtime`           | `services/proxy-config-service.ts`             | DONE   |
| Apply proxy addon  | `packages/shared`        | `services/auth-profile/apply-proxy.ts`         | DONE   |
| LLM wiring         | `apps/runtime`           | `services/execution/llm-wiring.ts`             | DONE   |
| RBAC roles         | `packages/database`      | `constants/system-roles.ts` (proxy:\*)         | DONE   |

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

- **Model**: `tenantIsolationPlugin` applied to OrgProxyConfig schema -- injects `tenantId` into all queries
- **Repository**: All CRUD functions require `tenantId` parameter; `findOrgProxyConfigById(id, tenantId)` uses `findOne({ _id: id, tenantId })`, never `findById`
- **Routes**: `req.tenantContext.tenantId` extracted from auth middleware; cross-tenant access returns 404
- **Index**: `{ tenantId: 1, name: 1, environment: 1 }` unique index ensures isolation

### 3.2 Authentication and Authorization

- **Auth**: `authMiddleware` (centralized, from `createUnifiedAuthMiddleware`) applied to all routes
- **RBAC**: `requirePermission('proxy:read|write|delete')` middleware on each endpoint
- **Role mapping**:
  - OWNER: `*:*` -- full access
  - ADMIN: `proxy:*` -- full access
  - OPERATOR: `proxy:read` -- read only
  - MEMBER/VIEWER: no proxy permissions -- all 403
- **Rate limiting**: `tenantRateLimit('request')` applied to all proxy config routes

### 3.3 Data Model

```
org_proxy_configs {
  _id: String (UUIDv7)
  tenantId: String (required)
  name: String (required)
  proxyUrl: String (required)
  proxyAuthType: String (required: none|basic|bearer|custom)
  encryptedProxyUsername: String | null
  encryptedProxyPassword: String | null
  encryptedProxyToken: String | null
  encryptedCaCertificate: String | null
  encryptedClientCert: String | null
  encryptedClientKey: String | null
  authProfileId: String | null
  urlPatterns: String (required, comma-separated globs)
  bypassPatterns: String | null
  environment: String (required: dev|staging|prod)
  priority: Number (required)
  enabled: Boolean (default: true)
  createdBy: String (required)
  _v: Number (default: 1)
  createdAt: Date (auto)
  updatedAt: Date (auto)
}

Indexes:
  - { tenantId: 1, name: 1, environment: 1 } UNIQUE
  - { tenantId: 1, environment: 1 }
```

### 3.4 Encryption and Credential Security

- **At rest**: `encryptionPlugin` applied to 6 fields: encryptedProxyUsername, encryptedProxyPassword, encryptedProxyToken, encryptedCaCertificate, encryptedClientCert, encryptedClientKey
- **Algorithm**: AES-256-GCM with tenant-scoped keys
- **API surface**: Raw credentials accepted in POST/PUT body (username, password, token, etc.) -- mapped to `encrypted*` fields before save; plugin encrypts transparently in pre-save hook
- **Response surface**: List responses mask proxyUrl to origin-only; no encrypted field values returned; boolean indicators (hasCaCertificate, hasClientCert) used instead

### 3.5 SSRF Protection

- **Write time**: `assertUrlSafeForSSRF(proxyUrl, getDevSSRFOptions())` called in POST and PUT routes before persisting
- **Read time**: `assertUrlSafeForSSRF(record.proxyUrl)` called in ProxyResolver constructor -- invalid configs are skipped with error log
- **Coverage**: Blocks 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254, fd00::/8
- **Dev mode**: `getDevSSRFOptions()` allows localhost in development

### 3.6 Caching

- **Layer**: ProxyConfigService in `apps/runtime`
- **Strategy**: In-memory Map keyed by `${tenantId}:${environment}`
- **TTL**: 5 minutes (CACHE_TTL_MS = 300000)
- **Empty caching**: Empty results cached to avoid repeated DB queries for unconfigured tenants
- **Invalidation**: `invalidate(tenantId, environment?)` -- per-tenant or per-tenant+environment
- **Gap**: No max size or eviction policy on the cache Map (see Section 10)

### 3.7 Observability

- **Logging**: `createLogger('proxy-config-route')` and `createLogger('proxy-config-service')` for structured logs
- **Audit**: `writeAuditLog({ action, tenantId, userId, metadata })` called on create, update, delete
- **Request ID**: `getCurrentRequestId()` included in all log entries and audit metadata
- **Error logging**: All catch blocks log with error message and requestId

### 3.8 Error Handling

| Scenario                 | HTTP Status | Response                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------- |
| Missing auth             | 401         | `{ success: false, error: "Authentication required" }`        |
| Insufficient permissions | 403         | `{ error: "Forbidden", required: "proxy:write" }`             |
| Config not found         | 404         | `{ success: false, error: "Proxy config not found" }`         |
| Duplicate name+env       | 409         | `{ success: false, error: "Proxy config already exists..." }` |
| SSRF violation           | 400         | `{ success: false, error: "Invalid proxy URL" }`              |
| Input too long           | 400         | `{ success: false, error: "...exceeds maximum length..." }`   |
| Internal error           | 500         | `{ success: false, error: "Failed to..." }`                   |

### 3.9 Performance

- **Cache hit resolution**: < 1ms (in-memory Map lookup + glob matching)
- **Cache miss resolution**: 1 DB query + ProxyResolver construction (~50ms)
- **Pattern matching**: Linear scan through configs by priority; each config tests hostname against glob patterns
- **Pagination**: Default 25, max 100 per page for list endpoint
- **DB queries**: Projection-limited (`select` parameter) -- only metadata fields fetched for list

### 3.10 API Design

All endpoints under `/api/proxy-configs`:

| Method | Path | Permission   | Description              |
| ------ | ---- | ------------ | ------------------------ |
| POST   | /    | proxy:write  | Create proxy config      |
| GET    | /    | proxy:read   | List configs (paginated) |
| PUT    | /:id | proxy:write  | Update config (partial)  |
| DELETE | /:id | proxy:delete | Delete config (hard)     |

Request/response schemas defined with Zod and registered with OpenAPI via `createOpenAPIRouter`.

### 3.11 Scalability

- **Stateless**: Proxy configs loaded from MongoDB; cache is per-pod but TTL-bounded
- **Multi-pod**: Each pod has independent cache; invalidation is local-only (acceptable given 5-min TTL)
- **Config volume**: Expected < 10 configs per tenant; no concern about query scale
- **Pattern matching**: O(N) where N = number of configs per tenant+env (expected small)

### 3.12 Migration and Compatibility

- **Schema**: No migration needed -- model and collection exist; new tenants get empty config
- **Backward compatibility**: Feature is additive -- agents without proxy configs work unchanged
- **Auth profile integration**: Optional `authProfileId` field; if auth profiles are disabled, field is ignored

## 4. Alternatives Considered

| Alternative                                   | Rejected Because                                                     |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Per-project proxy configs                     | Enterprise proxies are org-wide; adds unnecessary complexity         |
| Environment variable-based proxy (HTTP_PROXY) | Not tenant-scoped; cannot support per-URL routing                    |
| Full URL regex matching                       | Security risk (ReDoS); glob patterns sufficient for enterprise use   |
| Redis cache instead of in-memory              | Overkill for < 10 configs per tenant; adds dependency                |
| Soft delete                                   | Proxy configs are infrastructure, not user data; hard delete simpler |

## 5. Risks and Mitigations

| Risk                          | Impact                                      | Likelihood | Mitigation                                                                         |
| ----------------------------- | ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| Cache Map grows unbounded     | Memory leak in long-running pods            | LOW        | Add max size + LRU eviction (enhancement)                                          |
| Multi-pod cache inconsistency | Config change not reflected for up to 5 min | LOW        | Acceptable for proxy config changes; add Redis pub/sub if needed                   |
| Decryption failure at runtime | Tool calls fail                             | MEDIUM     | ProxyResolver skips invalid configs with warning log; tools fall through to direct |
| Glob pattern too broad (`*`)  | All traffic proxied unintentionally         | LOW        | Admin responsibility; UI could add confirmation for wildcard patterns              |

## 6. Open Issues

| ID  | Issue                                                                                           | Priority | Status |
| --- | ----------------------------------------------------------------------------------------------- | -------- | ------ |
| O-1 | ProxyConfigService cache has no max size or eviction policy                                     | P2       | OPEN   |
| O-2 | LLM provider API calls (OpenAI, Anthropic) do not route through org proxy                       | P1       | OPEN   |
| O-3 | No Studio UI for proxy config management                                                        | P1       | OPEN   |
| O-4 | Cache invalidation is pod-local only; no cross-pod notification                                 | P2       | OPEN   |
| O-5 | No GET /:id endpoint for single config retrieval                                                | P2       | OPEN   |
| O-6 | Error response envelope inconsistency (403 uses `{ error, required }` not `{ success, error }`) | P3       | OPEN   |
