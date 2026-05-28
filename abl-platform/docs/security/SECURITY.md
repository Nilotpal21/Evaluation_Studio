# Security Architecture

## Overview

The platform implements defense-in-depth security with tenant isolation, data protection, and access control across all layers.

```
Request → Unified Auth → Rate Limiter → Permission/Scope Guards → Handler
             │                                                       │
             ├── JWT flow         ─┐                   ┌─────────────┤
             ├── SDK Session flow  ├→ TenantContextData ▼             ▼
             └── API Key flow     ─┘    (via ALS)  PII Detection  Encryption
                                                   (input/output) (at rest)
```

---

## Tenant Isolation

### Organization Model

Multi-tenancy is organization-based. Each organization has members with roles:

| Role       | Permissions                                               |
| ---------- | --------------------------------------------------------- |
| **OWNER**  | Full access including org management and deletion         |
| **ADMIN**  | All except org:manage and org:delete                      |
| **MEMBER** | Execute agents, read/write sessions, read projects/agents |
| **VIEWER** | Read-only access to sessions, projects, agents            |

### Unified Auth Middleware

`packages/shared/src/middleware/unified-auth.ts`

Three auth flows converge to a fully-populated `TenantContextData`:

| Flow                  | Detection                                   | Source                                                               |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| **User JWT**          | `Authorization: Bearer <jwt>` (not `abl_*`) | JWT verify → user lookup → tenant membership → permission resolution |
| **SDK Session Token** | `X-SDK-Token: <token>`                      | JWT verify with `aud: 'sdk-session'`, `iss: 'agent-platform'`        |
| **API Key**           | `Authorization: Bearer abl_*`               | SHA-256 hash lookup → scopes, project/environment restrictions       |

Attaches to `req.tenantContext` and wraps downstream handlers in AsyncLocalStorage:

```typescript
interface TenantContextData {
  tenantId: string;
  orgId?: string;
  userId: string;
  role: string; // OWNER | ADMIN | OPERATOR | MEMBER | VIEWER | sdk_session | api_key
  permissions: string[]; // Resolved via RoleDefinition + ResourcePermission
  authType: AuthType; // 'user' | 'sdk_session' | 'api_key'
  isSuperAdmin: boolean;
  // SDK-specific
  deploymentId?: string;
  channelId?: string;
  sessionId?: string;
  // API key-specific
  apiKeyId?: string;
  clientId?: string;
  projectScope?: string[];
  environmentScope?: string[];
}
```

Runtime wiring: `apps/runtime/src/middleware/auth.ts` — configures the middleware with Prisma queries, structured logging, audit callbacks, and super-admin detection.

### Permission Guards

`packages/shared/src/middleware/permission-guard.ts`

Enforces granular access control after auth middleware:

```typescript
router.post(
  '/agents/:agentName/versions',
  authMiddleware, // unifiedAuth + requireAuth
  requireProjectScope('projectId'), // API key project restriction
  requirePermission('agent:write'), // Permission check
  handler,
);
```

Available guards:

- `requirePermission(perm)` / `requireAllPermissions(perms)` / `requireAnyPermission(perms)` — permission checks
- `requireProjectScope(paramName)` — enforces API key project restrictions
- `requireEnvironmentScope(paramName)` — enforces API key environment restrictions
- `requireAuthType(...types)` — restricts to specific auth flows

### Resource Guard (Legacy)

`apps/platform/src/middleware/resource-guard.ts`

Prevents cross-tenant resource access via direct DB ownership checks. Supported resource types: `project`, `session`, `agent`, `credential`, `modelConfig`, `serviceNode`.

### Runtime-Level Isolation

`BaseRuntime` enforces tenant boundaries:

```typescript
// Throws TenantAccessError if mismatch
runtime.assertTenantAccess(session.organizationId);

// Adds tenantId to any query
const query = runtime.scopeToTenant({ status: 'active' });
// → { status: 'active', tenantId: 'org_abc123' }
```

---

## Rate Limiting

`apps/platform/src/middleware/rate-limiter.ts`

Sliding window rate limiting scoped per tenant.

### Default Limits

| Operation           | Limit       | Window |
| ------------------- | ----------- | ------ |
| API requests        | 100/min     | 60s    |
| LLM tokens          | 100,000/min | 60s    |
| Concurrent sessions | 50          | —      |
| Tool calls          | 200/min     | 60s    |

### Usage

```typescript
// Middleware
router.post('/chat', tenantRateLimit('request'), handler);
router.post('/execute', tenantRateLimit('tool_call'), handler);

// Programmatic
recordTokenUsage(tenantId, 1500); // → { allowed, remaining }
canStartSession(tenantId); // → boolean
```

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 73
X-RateLimit-Reset: 42
```

Returns `429 Too Many Requests` when exceeded with `retryAfterMs`.

### Implementation

- **Dev**: In-memory sliding window counters with 5-minute cleanup
- **Production**: Designed for Redis backend (same interface)

---

## Data Encryption

### Architecture

MongoDB field encryption uses a **two-layer** architecture:

1. **Mongoose encryption plugin** (`packages/database/src/mongo/plugins/encryption.plugin.ts`) — transparent pre-save/post-find hooks on 14 models. Handles all encryption automatically via `fieldsToEncrypt` config.
2. **EncryptionService** (`packages/shared/src/encryption/`) — core AES-256-GCM crypto with tenant-scoped key derivation. Called by the plugin via dependency injection (DI), and directly by non-MongoDB stores (ClickHouse, Redis) and edge cases the plugin cannot reach (subdocument arrays, Mixed fields).

The plugin calls EncryptionService internally — routes pass **plaintext** values and the plugin encrypts/decrypts transparently.

### Key Hierarchy

```
Cloud KMS (AWS/Azure/GCP) or LocalKMS (dev)
  +-- Platform Root Key (PRK) — protects master key at rest
       +-- Master Key (ENCRYPTION_MASTER_KEY, 32-byte hex)
            +-- Tenant Key (PBKDF2-derived per tenantId, 100k iterations, SHA-256)
                 +-- Field encryption (AES-256-GCM per field)
```

- **Dev/local:** Master key from `ENCRYPTION_MASTER_KEY` env var, used directly
- **Production:** KMS unwraps master key at startup (envelope encryption). No per-document KMS calls.

### Wire Format (v3)

- **Cipher**: AES-256-GCM (authenticated encryption)
- **Key derivation**: PBKDF2 with 100,000 iterations, SHA-256, salt = `tenant:{tenantId}`
- **Format**: hex `iv:authTag:ciphertext`
- **Marker**: `doc.ire = 'v3'` on the Mongoose document

### Format Detection (backward compatibility)

| Version    | Detection                      | Decryption Path                                        |
| ---------- | ------------------------------ | ------------------------------------------------------ |
| v3         | `doc.ire === 'v3'`             | EncryptionService.decryptForTenant                     |
| v1         | `doc.ire === 'v1'`             | Legacy CEK + master key                                |
| v2         | `doc.ire === 'v2'`             | Legacy CEK + KMS unwrap                                |
| route-only | `!doc.ire` + hex 3-part field  | EncryptionService.decryptForTenant                     |
| double     | v1/v2 outer + hex 3-part inner | Legacy unwrap, then EncryptionService.decryptForTenant |

All formats auto-upgrade to v3 on next save.

### DI Wiring (startup)

The plugin uses dependency injection to avoid circular imports. Each app calls `setTenantEncryption()` at startup after MongoDB connects:

```typescript
const { setTenantEncryption } = await import('@agent-platform/database/mongo');
setTenantEncryption({
  encryptForTenant: (plaintext, tenantId) => enc.encryptForTenant(plaintext, tenantId),
  decryptForTenant: (encrypted, tenantId) => enc.decryptForTenant(encrypted, tenantId),
});
```

**Apps with wiring:** Runtime, Search-AI, Search-AI-Runtime, Workflow Engine, Studio (`ensure-db.ts`).

### Models with Plugin Encryption (14 models)

| Model                 | Encrypted Fields                                | Notes                     |
| --------------------- | ----------------------------------------------- | ------------------------- |
| LLMCredential         | `encryptedApiKey`, `encryptedEndpoint`          |                           |
| EndUserOAuthToken     | `encryptedAccessToken`, `encryptedRefreshToken` |                           |
| OrgProxyConfig        | 6 proxy credential fields                       |                           |
| ToolSecret            | `encryptedValue`                                |                           |
| User                  | `passwordHash`                                  | `skipTenantScoping: true` |
| Organization          | `billingConfig`                                 | `tenantIdField: '_id'`    |
| ServiceNode           | `encryptedSecrets`                              | `skipTenantScoping: true` |
| SessionState          | `stateData`, `irData`, `compilationData`        |                           |
| EnvironmentVariable   | `encryptedValue`                                |                           |
| ChannelConnection     | `encryptedCredentials`                          |                           |
| MCPServerConfig       | `encryptedEnv`, `encryptedAuthConfig`           |                           |
| WebhookSubscription   | `encryptedSecret`                               |                           |
| TenantServiceInstance | `encryptedApiKey`                               |                           |
| ArchWorkspaceConfig   | `encryptedApiKey`, `encryptedEndpoint`          |                           |

### Exceptions (manual encryption retained)

| Component                                  | Reason                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| SSO config routes                          | Subdocument array (`ssoConfigs.$.encryptedConfig`)     |
| Platform admin models                      | Embedded TenantModelConnection subdocuments            |
| Channel `config.encryptedInboundAuthToken` | Lives inside `Schema.Types.Mixed`, not top-level       |
| ConnectorConnection                        | OAuth refresh uses `findOneAndUpdate` (bypasses hooks) |
| Contact PII                                | Per-contact salt + searchable blind index pattern      |
| ClickHouse / Redis stores                  | Not MongoDB — use EncryptionService directly           |

### EncryptionService API

```typescript
const svc = getEncryptionService();

// User-scoped
const encrypted = svc.encrypt(apiKey, userId);
const decrypted = svc.decrypt(encrypted, userId);
svc.verify(encrypted, userId); // → boolean

// Tenant-scoped
const enc = svc.encryptForTenant(sessionData, tenantId);
const dec = svc.decryptForTenant(enc, tenantId);

// JSON convenience
svc.encryptJsonForTenant({ phone: '+1-555-0123' }, tenantId);
svc.decryptJsonForTenant<UserData>(encrypted, tenantId);
```

---

## PII Detection and Redaction

`packages/compiler/src/platform/security/pii-detector.ts`

Regex-based PII detection for speed. Runs as a guardrail in `BaseRuntime` on user input and agent output when enabled.

### Detected Patterns

| Type        | Pattern                    | Redaction Label    |
| ----------- | -------------------------- | ------------------ |
| Email       | `user@domain.com`          | `[REDACTED_EMAIL]` |
| SSN         | `123-45-6789`              | `[REDACTED_SSN]`   |
| Credit Card | 16 digits (Luhn validated) | `[REDACTED_CARD]`  |
| Phone       | US/intl 10-15 digits       | `[REDACTED_PHONE]` |
| IP Address  | IPv4 (octet validated)     | `[REDACTED_IP]`    |

### API

```typescript
import { detectPII, redactPII, containsPII } from '@abl/compiler';

// Full detection with positions
const result = detectPII('Email me at john@example.com');
// → { hasPII: true, detections: [{ type: 'email', start: 12, end: 28, value: 'john@example.com' }],
//     redacted: 'Email me at [REDACTED_EMAIL]' }

// Quick redaction
redactPII('Call 555-123-4567'); // → 'Call [REDACTED_PHONE]'

// Fast boolean check
containsPII('Hello world'); // → false
```

### Design Decisions

- **Regex over ML**: Sub-millisecond detection. ML-based detectors can be added as a second pass.
- **Luhn validation**: Reduces false positives for credit card numbers.
- **Overlap removal**: When patterns overlap, the earlier/longer match is kept.

---

## API Key Authentication

### Key Format

Keys use the format `abl_prod_<random>` with a prefix for identification.

### Storage

- Raw key is **never stored**. Only the SHA-256 hash is persisted.
- The first 8 characters (prefix) are stored for lookup.
- Scopes limit what operations a key can perform.

### Prisma Schema

```prisma
model ApiKey {
  id             String    @id @default(cuid())
  organizationId String
  name           String
  keyHash        String    @unique    // SHA-256 hash
  prefix         String               // First 8 chars for lookup
  scopes         String   @default("[]")  // JSON array
  expiresAt      DateTime?
  revokedAt      DateTime?
  lastUsedAt     DateTime?
  createdBy      String
}
```

### Resolution Flow

Handled by the unified auth middleware's `resolveApiKey()` callback:

1. Extract `abl_*` prefix from `Authorization: Bearer abl_prod_xxx...`
2. SHA-256 hash the full key, look up by `keyHash`
3. Verify prefix match, check `expiresAt` and `revokedAt`
4. Build `TenantContextData` with `authType: 'api_key'`, scopes as permissions, project/environment restrictions as `projectScope`/`environmentScope`

---

---

## Version Service Security

`apps/runtime/src/services/version-service.ts`

The VersionService implements defense-in-depth for agent version lifecycle management.

### Tenant Isolation

`ProjectAgent` and `AgentVersion` are in `NON_TENANT_MODELS` (no automatic RLS), so tenant isolation is enforced manually:

```typescript
// Every method uses findAgentWithTenantGuard()
// Joins ProjectAgent → Project.tenantId and rejects mismatches
private async findAgentWithTenantGuard(projectId, agentName, tenantId) {
  const agent = await prisma.projectAgent.findFirst({
    where: { projectId, name: agentName },
    include: { project: { select: { tenantId: true } } },
  });
  if (!agent || agent.project.tenantId !== tenantId) return null;
  return agent;
}
```

### RBAC on Mutations

Write operations (create version, promote, save ABL source) require `OWNER`, `ADMIN`, or `OPERATOR` role, checked via `requireWriteAccess()` in route handlers.

### Input Validation

| Input              | Limit                                                           |
| ------------------ | --------------------------------------------------------------- |
| ABL source content | Max 512 KB                                                      |
| Changelog          | Max 10 KB                                                       |
| Version status     | Enum: draft, testing, staged, active, deprecated                |
| Status transitions | State machine enforced (e.g., `active` can only → `deprecated`) |

### Audit Trail

All mutations fire audit events: `version.created`, `version.promoted`, `agent.dsl_updated`.

### Error Sanitization

500 responses return generic messages. Prisma table/column names are never exposed to clients.

---

## Tool Calling Security

The tool execution layer implements defense-in-depth for all outbound HTTP calls, secrets management, OAuth flows, and proxy routing.

### SSRF Protection

`packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`

All outbound tool URLs are validated before execution:

| Protection         | Implementation                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| Private IP ranges  | Blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`  |
| Cloud metadata     | Blocks `169.254.169.254`, `metadata.google.internal`                   |
| IPv6 loopback      | Blocks `::1`, `fc00::`, `fe80::`, `::ffff:127.0.0.1`                   |
| IP encoding bypass | Blocks decimal (`2130706433`), octal (`0177.0.0.01`)                   |
| URL schemes        | Only `http://` and `https://` allowed                                  |
| Userinfo bypass    | Blocks `http://evil@169.254.169.254/`                                  |
| Redirect following | Manual redirect with SSRF re-validation per hop (max 5)                |
| Response size      | Configurable `maxResponseBytes` (default 10MB), streaming body counter |

### Secrets Provider (Multi-Layer Resolution)

`apps/runtime/src/services/secrets-provider.ts`

Resolves tool credentials through a layered chain:

1. **Special keys** (`auth_token`, `bearer_token`) → session's JWT authToken
2. **DB store** — encrypted `ToolSecret` model (org + project + tool + env scoped), decrypted with `EncryptionService.decryptForTenant()`
3. **Agent IR config** — credentials map from tool auth config
4. **Environment variables** — `process.env[key]` and `process.env[KEY.toUpperCase()]`
5. **`undefined`** with warning log

Secrets are cached per-session to avoid repeated DB + decryption overhead. Expired secrets (past `expiresAt`) are rejected.

### Tool Secrets Management

`apps/runtime/src/routes/tool-secrets.ts`

RBAC-protected CRUD for per-tool, per-environment secrets:

| Endpoint                   | Permission          | Description                       |
| -------------------------- | ------------------- | --------------------------------- |
| `POST /tool-secrets`       | `credential:write`  | Create encrypted secret           |
| `GET /tool-secrets`        | `credential:read`   | List (paginated, values masked)   |
| `PUT /tool-secrets/:id`    | `credential:write`  | Rotate (re-encrypt, bump version) |
| `DELETE /tool-secrets/:id` | `credential:delete` | Soft-delete                       |

Secrets are encrypted with `EncryptionService.encryptForTenant()` before storage. Expiry warnings are returned for secrets expiring within 30 days.

### Channel Credential Guarding

Credential-management channel routes are now explicitly permission-guarded with `requirePermission(...)`:

| Endpoint                                                       | Permission          | Description                          |
| -------------------------------------------------------------- | ------------------- | ------------------------------------ |
| `POST /api/v1/channel-connections`                             | `credential:write`  | Create channel connection            |
| `GET /api/v1/channel-connections`                              | `credential:read`   | List channel connections             |
| `GET /api/v1/channel-connections/:id`                          | `credential:read`   | Read channel connection              |
| `PATCH /api/v1/channel-connections/:id`                        | `credential:write`  | Update channel connection            |
| `DELETE /api/v1/channel-connections/:id`                       | `credential:delete` | Deactivate channel connection        |
| `POST /api/v1/channels/http-async/subscribe`                   | `credential:write`  | Create HTTP async subscription       |
| `GET /api/v1/channels/http-async/subscriptions`                | `credential:read`   | List HTTP async subscriptions        |
| `GET /api/v1/channels/http-async/subscriptions/:id`            | `credential:read`   | Read HTTP async subscription         |
| `PATCH /api/v1/channels/http-async/subscriptions/:id`          | `credential:write`  | Update or rotate subscription secret |
| `DELETE /api/v1/channels/http-async/subscriptions/:id`         | `credential:delete` | Deactivate HTTP async subscription   |
| `GET /api/v1/channels/http-async/subscriptions/:id/deliveries` | `credential:read`   | List deliveries for subscription     |
| `GET /api/v1/channels/http-async/deliveries/:id`               | `credential:read`   | Inspect delivery status              |

`POST /api/v1/channels/http-async/message` remains tenant-authenticated message ingestion; authorization is enforced by tenant context plus strict ownership checks on `subscription_id`.

HTTP async inbound retries are idempotent: on retry, if a delivery already exists for `delivery:{tenantId}:{idempotencyKey}`, the worker re-enqueues that delivery instead of re-executing the agent turn. Duplicate-key races are handled by read-after-duplicate recovery.

### End-User OAuth

`apps/runtime/src/routes/oauth.ts` + `apps/runtime/src/services/tool-oauth-service.ts`

OAuth 2.0 authorization code flow for end-user tool access (Google Calendar, Slack, etc.):

| Security Control         | Implementation                                         |
| ------------------------ | ------------------------------------------------------ |
| State parameter          | 64-byte cryptographic random hex                       |
| Redirect URI allowlist   | Origin-based matching against configured origins       |
| Provider name validation | `^[a-zA-Z0-9_-]+$`, max 64 chars                       |
| Token encryption         | AES-256-GCM via `EncryptionService.encryptForTenant()` |
| Pending state capacity   | Max 10,000 entries with 10-minute TTL                  |
| CSRF protection          | State verified on callback                             |
| Token revocation         | Calls provider revocation endpoint + marks `revokedAt` |

### Organization Proxy / Gateway

`packages/compiler/src/platform/constructs/executors/proxy-resolver.ts` + `apps/runtime/src/routes/proxy-config.ts`

Organizations can route outbound tool traffic through proxies with:

| Feature                | Implementation                                                    |
| ---------------------- | ----------------------------------------------------------------- |
| URL pattern matching   | Glob patterns (`*.internal.com`, exact hostnames, wildcard `*`)   |
| Bypass patterns        | Skip proxy for matching URLs                                      |
| Priority ordering      | Higher priority configs checked first                             |
| Proxy auth             | Basic, Bearer, API key — injected as `Proxy-Authorization` header |
| Custom CA certificates | PEM-encoded, decrypted at init, applied per-request               |
| mTLS                   | Client cert + key for mutual TLS with partner APIs                |
| SSRF on proxy URL      | Same validation applied to proxy URL itself                       |
| Credential encryption  | All proxy credentials encrypted at rest with tenant key           |

Admin CRUD routes (`proxy:write`, `proxy:read`, `proxy:delete` permissions) with proxy URL masking in list responses.

### Trace PII Scrubbing

`packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`

All tool call trace data is scrubbed before logging:

- `Authorization`, `X-API-Key`, `Bearer *` headers → `[REDACTED]`
- `{{secrets.*}}` placeholder values → `[REDACTED]`
- PII detected via `detectPII()` → redaction labels
- Endpoint URLs have query parameters stripped (may contain API keys)

### Tool Middleware Chain

`packages/compiler/src/platform/constructs/executors/tool-middleware.ts`

Composable middleware for cross-cutting concerns:

```
Request → [Audit MW] → [Logging MW] → [Timing MW] → [PII Scrub MW] → Tool Dispatch
                                                                              │
Result  ← [Audit MW] ← [Logging MW] ← [Timing MW] ← [PII Scrub MW] ←──────┘
```

Built-in middleware:

- `loggingMiddleware(trace)` — trace logging with dedup (skips inline logging when middleware present)
- `timingMiddleware()` — adds `latencyMs` to result metadata
- `createAuditMiddleware(logger)` — SOC2/HIPAA audit trail with SHA-256 input hash

### Tool Audit Logging

`packages/compiler/src/platform/constructs/executors/audit-middleware.ts`

Every tool invocation creates an audit entry:

| Field          | Content                                              |
| -------------- | ---------------------------------------------------- |
| `toolName`     | Tool identifier                                      |
| `toolType`     | `http`, `mcp`, `lambda`, `sandbox`                   |
| `inputHash`    | SHA-256 of scrubbed params (raw params never stored) |
| `success`      | Boolean                                              |
| `latencyMs`    | Execution time                                       |
| `authType`     | Auth method used                                     |
| `errorMessage` | Error details on failure                             |

Audit logging never blocks tool execution — failures are caught and logged.

---

## Key Files

| File                                                                        | Purpose                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/shared/src/middleware/unified-auth.ts`                            | Central 3-path auth dispatcher (JWT, SDK, API key)                      |
| `packages/shared/src/middleware/permission-guard.ts`                        | Permission + scope enforcement guards                                   |
| `packages/shared/src/rbac/permission-resolver.ts`                           | Role hierarchy + resource permission merging                            |
| `apps/runtime/src/middleware/auth.ts`                                       | Runtime auth config wiring (`unifiedAuth` + `authMiddleware`)           |
| `apps/runtime/src/middleware/sdk-auth.ts`                                   | SDK `pk_*` public key validation                                        |
| `apps/runtime/src/routes/sdk-init.ts`                                       | SDK token exchange + refresh endpoints                                  |
| `apps/runtime/src/services/permission-resolution.ts`                        | Prisma-backed permission resolution + 60s cache                         |
| `apps/platform/src/middleware/resource-guard.ts`                            | Cross-tenant access prevention (legacy)                                 |
| `apps/platform/src/middleware/rate-limiter.ts`                              | Per-tenant rate limiting                                                |
| `packages/shared/src/encryption/`                                           | EncryptionService (AES-256-GCM, tenant-scoped key derivation)           |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`                  | Mongoose encryption plugin (pre-save/post-find hooks, v3 format)        |
| `packages/database/src/mongo/plugins/encryption.plugin.setters.ts`          | DI setter for tenant encryption (`setTenantEncryption`)                 |
| `packages/compiler/src/platform/security/pii-detector.ts`                   | PII detection/redaction                                                 |
| `packages/database/prisma/schema.prisma`                                    | Tenant, TenantMember, ApiKey, RoleDefinition, ResourcePermission models |
| `apps/runtime/src/services/version-service.ts`                              | Version lifecycle with tenant guard                                     |
| `apps/runtime/src/routes/versions.ts`                                       | Version API with RBAC + audit                                           |
| `apps/runtime/src/routes/project-agents.ts`                                 | Agent CRUD with tenant isolation                                        |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | SSRF protection, redirect validation, response limits                   |
| `packages/compiler/src/platform/constructs/executors/proxy-resolver.ts`     | Org proxy routing with mTLS/CA cert support                             |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`     | PII/secret scrubbing for trace events                                   |
| `packages/compiler/src/platform/constructs/executors/audit-middleware.ts`   | SOC2/HIPAA audit trail for tool calls                                   |
| `apps/runtime/src/services/secrets-provider.ts`                             | Multi-layer secret resolution                                           |
| `apps/runtime/src/routes/tool-secrets.ts`                                   | Tool secret CRUD with RBAC                                              |
| `apps/runtime/src/routes/oauth.ts`                                          | End-user OAuth flow with CSRF protection                                |
| `apps/runtime/src/routes/proxy-config.ts`                                   | Org proxy config CRUD with RBAC                                         |

## Test Coverage

| Test File                                                               | Tests | Scope                                                             |
| ----------------------------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| `packages/compiler/src/__tests__/runtimes/base-runtime.test.ts`         | 47    | BaseRuntime, tenant isolation, context building                   |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`         | 36    | PII detection, redaction, all pattern types                       |
| `apps/platform/src/__tests__/middleware.test.ts`                        | 15    | Rate limiting, token tracking, session limits                     |
| `apps/runtime/src/__tests__/version-service.test.ts`                    | 56    | Tenant isolation, RBAC, transitions, race conditions, validation  |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` | 80+   | SSRF, redirect, auth, response limits, header injection           |
| `packages/compiler/src/__tests__/constructs/proxy-resolver.test.ts`     | 22    | URL matching, priority, auth, mTLS, CA certs, SSRF on proxy       |
| `packages/compiler/src/__tests__/constructs/middleware-chain.test.ts`   | 17    | Middleware wiring, trace dedup, composition, logging/timing       |
| `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`     | 7     | Header redaction, PII, endpoint scrubbing                         |
| `packages/compiler/src/__tests__/constructs/audit-middleware.test.ts`   | 6     | Audit logging, hash, context, failure handling                    |
| `apps/runtime/src/__tests__/route-validation.test.ts`                   | 21    | OAuth env config, provider validation, redirect URI, input limits |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`                   | 18    | Multi-layer resolution, caching, expiry, OAuth tokens             |
| `apps/runtime/src/__tests__/tool-oauth-service.test.ts`                 | 13    | OAuth flow, token exchange, state management, revocation          |
| `apps/runtime/src/__tests__/proxy-config-service.test.ts`               | 8     | Config loading, decryption, caching, test connectivity            |
| `packages/shared/src/__tests__/unified-auth.test.ts`                    | 14    | Three auth flows, events, isSuperAdmin, requireAuth               |
| `packages/shared/src/__tests__/permission-guard.test.ts`                | 16    | Scope enforcement, permissions, auth types                        |
