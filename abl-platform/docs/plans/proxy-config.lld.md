# Proxy Configuration — Low-Level Design

## Implementation Structure

### Core Files

| File                                                                    | Purpose                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/proxy-config.ts`                               | REST CRUD API: POST, GET, PUT, DELETE with Zod validation, RBAC, SSRF checks, audit logging                      |
| `apps/runtime/src/services/proxy-config-service.ts`                     | ProxyConfigService: DB loading, ProxyResolver creation, caching (5min TTL), invalidation, auth profile dual-read |
| `packages/compiler/src/platform/constructs/executors/proxy-resolver.ts` | ProxyResolver: URL pattern matching, priority ordering, auth injection, mTLS, SSRF validation                    |

### Test Files

| File                                                      | Type | Focus                                                 |
| --------------------------------------------------------- | ---- | ----------------------------------------------------- |
| `apps/runtime/src/__tests__/proxy-config-authz.test.ts`   | unit | RBAC enforcement: 6 roles x 4 operations              |
| `apps/runtime/src/__tests__/proxy-config-service.test.ts` | unit | Config loading, caching, invalidation, error handling |

## Module T-1: REST CRUD API

### Route Registration

```typescript
// Base path: /api/proxy-configs
// Tags: ['Proxy Configs']
// Global middleware: authMiddleware, tenantRateLimit('request')
// Uses createOpenAPIRouter for OpenAPI spec generation
```

### Endpoints

| Method | Path   | Permission     | Schema                  | Notes                                            |
| ------ | ------ | -------------- | ----------------------- | ------------------------------------------------ |
| POST   | `/`    | `proxy:write`  | CreateProxyConfigSchema | SSRF check, audit log, 201 response              |
| GET    | `/`    | `proxy:read`   | -                       | Pagination, environment filter, proxyUrl masked  |
| PUT    | `/:id` | `proxy:write`  | UpdateProxyConfigSchema | Partial update, SSRF check on new URL, audit log |
| DELETE | `/:id` | `proxy:delete` | -                       | Hard delete, audit log                           |

### Zod Schemas

**CreateProxyConfigSchema** fields:

- `name`: string, max 1024 chars (required)
- `proxyUrl`: string, URL format (required)
- `proxyAuthType`: enum ['none', 'basic', 'bearer', 'custom'] (default 'none')
- `username`, `password`: string (optional, for basic auth)
- `token`: string (optional, for bearer/custom auth)
- `caCertificate`, `clientCert`, `clientKey`: string, max 64KB (optional, PEM format)
- `urlPatterns`: string (default '\*')
- `bypassPatterns`: string (optional)
- `environment`: string (default 'dev')
- `priority`: integer (default 0)
- `enabled`: boolean (default true)

**UpdateProxyConfigSchema**: All fields optional for partial updates.

### Security Checks

1. `req.tenantContext` required (401 if missing)
2. `requirePermission('proxy:read|write|delete')` via RBAC middleware
3. `assertUrlSafeForSSRF(proxyUrl, getDevSSRFOptions())` on create/update
4. Input length validation (name, certificates)
5. Duplicate detection via unique index (409 on conflict)

### Response Redaction

- List endpoint: `proxyUrl` masked to `new URL(url).origin`
- Credentials: only boolean indicators (`hasCaCertificate`, `hasClientCert`)
- Never return: username, password, token, certificate content

## Module T-2: ProxyConfigService

### Key Functions

```typescript
class ProxyConfigService {
  constructor(store: ProxyConfigStore, decryptFn: DecryptFn);

  // Get or create cached ProxyResolver for org+environment
  // Returns null if no configs exist
  async getResolver(tenantId: string, environment?: string): Promise<ProxyResolver | null>;

  // Invalidate cache for org+environment (or all environments)
  invalidate(tenantId: string, environment?: string): void;
}

interface ProxyConfigStore {
  findConfigs(params: { tenantId: string; environment: string }): Promise<OrgProxyConfigRecord[]>;
}
```

### Caching Strategy

- Cache key: `${tenantId}:${environment}`
- TTL: 5 minutes (CACHE_TTL_MS = 300,000ms)
- Empty results cached to avoid repeated DB queries
- Explicit invalidation via `invalidate(tenantId, environment?)`
- No automatic invalidation on DB change (requires explicit call after CRUD)

### Auth Profile Dual-Read

When `isAuthProfileEnabled()` is true and a record has `authProfileId`:

1. Resolve credentials from auth profile via `resolveAuthProfileCredentials()`
2. Inject pre-resolved credentials (`_resolvedCaCert`, `_resolvedClientCert`, `_resolvedClientKey`)
3. Fall back to encrypted fields if auth profile resolution fails

## Module T-3: ProxyResolver

### Key Functions

```typescript
class ProxyResolver {
  constructor(records: OrgProxyConfigRecord[], decryptFn: DecryptFn, tenantId: string);

  // Resolve proxy for target URL — returns highest-priority match or null
  resolve(targetUrl: string): ProxyConfig | null;

  // Apply proxy auth headers to request
  static applyProxyAuth(proxyConfig: ProxyConfig, headers: Record<string, string>): void;

  // Validate proxy URL at write time
  static validateProxyUrl(proxyUrl: string): void;

  // Check if any configs loaded
  get hasConfigs(): boolean;
}
```

### URL Pattern Matching Algorithm

1. Filter enabled configs, sort by priority descending (highest first)
2. For each config:
   a. Parse `bypassPatterns` (comma-separated globs) — if target URL hostname matches any, skip config
   b. Parse `urlPatterns` (comma-separated globs) — if target URL hostname matches any, return this config's ProxyConfig
3. If no match, return null (direct connection)

### Glob-to-Regex Conversion

- `*` -> `.*` (match any chars)
- `?` -> `.` (match single char)
- All other regex special chars escaped
- Anchored match: `^pattern$`
- Case-insensitive matching

### Auth Type Resolution

| Auth Type | Header                | Value                             |
| --------- | --------------------- | --------------------------------- |
| basic     | `Proxy-Authorization` | `Basic base64(username:password)` |
| bearer    | `Proxy-Authorization` | `Bearer token`                    |
| api_key   | `Proxy-Authorization` | `token` (raw)                     |
| none      | -                     | No header                         |

### SSRF Protection

- `assertUrlSafeForSSRF()` called at:
  1. Admin API write time (create/update routes)
  2. Resolver construction (skips invalid configs with error log)
- Rejects: private IPs (10.x, 172.16-31.x, 192.168.x), localhost, link-local

## Known Gaps

| ID      | Description                                                | Severity |
| ------- | ---------------------------------------------------------- | -------- |
| GAP-001 | No Studio UI for proxy management                          | Medium   |
| GAP-002 | No integration test for full CRUD with real Express server | High     |
| GAP-003 | No E2E test for proxy applied to outbound tool calls       | High     |
| GAP-004 | Auth profile dual-read path not tested                     | Medium   |
| GAP-005 | No proxy health checking endpoint                          | Medium   |
| GAP-006 | Cache not automatically invalidated on DB changes          | Low      |

## Dependencies

- `@agent-platform/shared/repos` — DB access functions (createOrgProxyConfig, findOrgProxyConfigs, etc.)
- `@agent-platform/shared-auth` — requirePermission RBAC middleware
- `@agent-platform/shared-kernel/security` — assertUrlSafeForSSRF
- `@agent-platform/shared-observability` — getCurrentRequestId
- `@agent-platform/openapi/express` — OpenAPI router for spec generation
- DB encryption plugin — transparent field encryption on pre-save hooks

## Exit Criteria

- RBAC tests pass for all 6 roles across 4 operations
- Config service tests pass for loading, caching, invalidation, and error paths
- ProxyResolver correctly matches URL patterns with priority ordering
- SSRF protection rejects private IPs at both write and load time
- Audit logs emitted for all mutations
