# Auth Profile — Unified Authentication & Credential Management

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all scattered credential models (LLMCredential, EndUserOAuthToken, ToolSecret, inline encrypted fields) with a single, universal Auth Profile entity that supports 12 core auth types + 5 deferred, 3 core addon layers + 2 deferred, and two-layer OAuth across every platform consumer.

**Architecture:** Auth Profile is a tenant-scoped MongoDB document with discriminated-union typing, AES-256-GCM encrypted secrets, project-level override, optional environment scoping, and shared/personal visibility. Consumers store `authProfileId` instead of inline credentials. The compiler propagates `per_user` auth requirements up the agent→workflow→tool dependency tree for pre-flight consent.

**Tech Stack:** MongoDB/Prisma, AES-256-GCM (existing encryptionPlugin), simple-oauth2, @aws-sdk/signature-v4, @azure/identity, ssh2 (for ssh_key Git over SSH). Enterprise/deferred libraries (`@node-saml/node-saml`, `digest-fetch`, `@hapi/hawk`, `soap`, `kerberos`) are recommended for an optional `packages/auth-enterprise` package (see Deferred Auth Types section).

---

## 1. Core Model

The `AuthProfile` is a single, universal entity for all authentication in the platform.

### Identity

| Field         | Type    | Description                                                        |
| ------------- | ------- | ------------------------------------------------------------------ |
| `_id`         | UUID    | Primary key                                                        |
| `name`        | string  | Human-readable label ("Production OpenAI", "Team Gmail OAuth App") |
| `description` | string? | Optional notes                                                     |

### Scoping (tenant default, project override, environment-specific)

| Field         | Type                     | Description                                                                                                                            |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`    | string                   | Always present (tenant isolation)                                                                                                      |
| `projectId`   | string (default `null`)  | `null` = tenant-level, set = project-level override. Always stored as explicit `null`, never `undefined`. Schema uses `default: null`. |
| `scope`       | `'tenant' \| 'project'`  | Scope discriminator (derived from `projectId` presence)                                                                                |
| `environment` | string?                  | Optional: `'dev' \| 'staging' \| 'production'` or null = all envs. Replaces `ToolSecret.environment` scoping.                          |
| `visibility`  | `'shared' \| 'personal'` | shared = anyone in scope, personal = only creator                                                                                      |
| `createdBy`   | string                   | userId of the creator. **Immutable** — set from `ctx.user.id` on creation, never accepted from request body, never updatable.          |

### Auth Type (discriminated union)

| Field                  | Type                      | Description                                                                                                |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `authType`             | enum (17 values)          | Discriminator                                                                                              |
| `config`               | `Record<string, unknown>` | Type-specific non-sensitive config. Validated server-side via Zod discriminated union keyed on `authType`. |
| `encryptedSecrets`     | string                    | AES-256-GCM encrypted JSON blob of all sensitive values                                                    |
| `encryptionKeyVersion` | number                    | For key rotation                                                                                           |

### OAuth Linking

| Field                | Type    | Description                                                                                                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linkedAppProfileId` | string? | `oauth2_token` → `oauth2_app` link (for token refresh). **Must be validated**: same `tenantId` as this profile, `authType: 'oauth2_app'`. Validated on create, update, AND at refresh time. |

### Metadata

| Field       | Type      | Description                                                      |
| ----------- | --------- | ---------------------------------------------------------------- |
| `connector` | string?   | "gmail", "slack" — for connector-typed profiles                  |
| `category`  | string?   | "llm", "connector", "tool", "channel", "infrastructure", "voice" |
| `tags`      | string[]? | Free-form labels                                                 |

### Lifecycle

| Field             | Type                                              | Description                           |
| ----------------- | ------------------------------------------------- | ------------------------------------- |
| `status`          | `'active' \| 'expired' \| 'revoked' \| 'invalid'` | Current state                         |
| `expiresAt`       | Date?                                             | Optional hard expiration              |
| `lastValidatedAt` | Date?                                             | Last successful credential validation |
| `lastUsedAt`      | Date?                                             | Last time credentials were used       |

### Rotation

| Field                      | Type    | Description                                                                                         |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `rotationPolicy`           | object? | For api_key/bearer: rotation schedule, grace period                                                 |
| `previousEncryptedSecrets` | string? | Previous key during grace period. `rotationGracePeriodMs` is relative to `updatedAt`, not absolute. |
| `rotationGracePeriodMs`    | number? | How long previous key stays valid after rotation                                                    |

### Audit

| Field       | Type | Description           |
| ----------- | ---- | --------------------- |
| `createdAt` | Date | Creation timestamp    |
| `updatedAt` | Date | Last update timestamp |

### Schema Plugins (REQUIRED)

```typescript
AuthProfileSchema.plugin(tenantIsolationPlugin); // auto-injects tenantId into all queries
AuthProfileSchema.plugin(encryptionPlugin, {
  // auto-encrypts encryptedSecrets
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
});
AuthProfileSchema.plugin(auditTrailPlugin); // tracks all changes
```

---

## 2. Auth Types (12 core + 5 deferred) [Phase 1-2]

See the detailed auth type tables in the sections below. Enterprise types (`kerberos`, `saml`, `hawk`, `digest`, `ws_security`) are deferred to Phase 3+ (see Section 19).

### Basic Auth Types

| `authType` | `config` (non-sensitive)                                                      | `encryptedSecrets` (sensitive) | Library |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------ | ------- |
| `none`     | —                                                                             | —                              | —       |
| `api_key`  | `headerName`, `prefix`, `placement: 'header' \| 'query'` (default `'header'`) | `apiKey`                       | —       |
| `bearer`   | —                                                                             | `token`                        | —       |
| `basic`    | —                                                                             | `username`, `password`         | —       |

### OAuth Types

| `authType`                  | `config`                                                                                                                                                                                                                                                          | `encryptedSecrets`                                            | Library         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| `oauth2_app`                | `authorizationUrl`, `tokenUrl`, `refreshUrl?`, `revocationUrl?`, `deviceAuthorizationUrl?`, `tokenIntrospectionUrl?`, `defaultScopes[]`, `scopeSeparator`, `pkceRequired`, `pkceMethod: 'S256' \| 'plain'`, `supportedGrantTypes[]`, `setupGuideUrl?`, `docsUrl?` | `clientId`, `clientSecret`                                    | `simple-oauth2` |
| `oauth2_token`              | `provider`, `scopes[]`, `grantedScopes[]`, `tokenType: 'bearer' \| 'mac'`, `issuedAt?`, `expiresAt?`, `refreshTokenExpiresAt?`, `refreshTokenRotation: boolean`                                                                                                   | `accessToken`, `refreshToken?`, `idToken?`, `providerUserId?` | `simple-oauth2` |
| `oauth2_client_credentials` | `tokenUrl`, `scopes[]`                                                                                                                                                                                                                                            | `clientId`, `clientSecret`                                    | `simple-oauth2` |

> **`providerUserId` is PII** and is stored in `encryptedSecrets` (not `config`). It is only accessible via decryption, which requires `AUTH_PROFILE_DECRYPT` permission.

### Custom & Cloud Types

| `authType`      | `config`                                                                          | `encryptedSecrets`                                | Library                 |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| `custom_header` | `headers: Record<string, string>` (header names)                                  | `headerValues: Record<string, string>`            | —                       |
| `aws_iam`       | `region`, `service`, `roleArn?`, `externalId?`                                    | `accessKeyId`, `secretAccessKey`, `sessionToken?` | `@aws-sdk/signature-v4` |
| `azure_ad`      | `tenantId`, `resource`, `endpoint?` (default `https://login.microsoftonline.com`) | `clientId`, `clientSecret`                        | `@azure/identity`       |

### Infrastructure Types

| `authType` | `config`                                         | `encryptedSecrets`                   | Library |
| ---------- | ------------------------------------------------ | ------------------------------------ | ------- |
| `ssh_key`  | `keyType?: 'ed25519' \| 'rsa'` (default `'rsa'`) | `privateKey`, `passphrase?`          | —       |
| `mtls`     | —                                                | `clientCert`, `clientKey`, `caCert?` | —       |

> **Enterprise types** (`kerberos`, `saml`, `hawk`, `digest`, `ws_security`) are deferred to Phase 3+. See Section 19.

### `searchai` Migration Note

The compiler's `ToolAuthTypeIR` includes a `'searchai'` auth type. This type is NOT added to the Auth Profile enum. Instead:

- **Migration mapping:** `searchai` DSL auth is migrated to `oauth2_client_credentials`.
- **Field mapping:** `searchai.tokenUrl` → `config.tokenUrl`, `searchai.clientId`/`clientSecret` → `encryptedSecrets.clientId`/`clientSecret`. The `botId` and `headerName` fields are stored as `config.botId` and `config.customHeaderName` extension fields (see Section 14 for the concrete mapping table).
- The compiler must emit `authType: 'oauth2_client_credentials'` for `searchai` tools during the migration period.

---

## 3. Addon Mechanisms (3 core + 2 deferred) [Phase 1-2]

Optional addon blocks on any Auth Profile. Composable with any auth type (subject to the invalid-combination matrix below). Two additional addons (`certificatePinning` and `jwtWrapping`) are deferred to Phase 3+ (see Section 19).

### 3.1 Request Signing (HMAC)

```typescript
signing?: {
  algorithm: 'hmac-sha256' | 'hmac-sha512' | 'aws-sig-v4' | 'rsa-sha256';
  signedComponents: ('body' | 'timestamp' | 'url' | 'headers')[];
  timestampHeader?: string;          // e.g. "X-Timestamp"
  signatureHeader?: string;          // e.g. "X-Signature"
  // signingSecret in encryptedSecrets
};
```

**Addon evaluation order:** Signing MUST be applied BEFORE the proxy addon rewrites the request target.

### 3.2 Webhook Verification (inbound only)

```typescript
webhookVerification?: {
  method: 'hmac-sha256' | 'hmac-sha1' | 'svix' | 'rsa-sha256';
  signatureHeader: string;           // "X-Hub-Signature-256"
  timestampHeader?: string;
  toleranceSeconds?: number;         // replay protection window
  // webhookSecret in encryptedSecrets
};
```

### 3.3 Proxy

```typescript
proxy?: {
  url: string;                       // SSRF-validated (see Section 11)
  proxyAuthProfileId?: string;       // auth for the proxy itself
};
```

**Proxy validation rules:**

- `proxyAuthProfileId` MUST NOT equal `this._id` (self-reference).
- Max proxy chain depth = 1 (no nested proxies).
- Valid proxy auth types: `basic`, `bearer`, `api_key`, `mtls` only.
- Same `tenantId` validation.
- **Visibility check:** A shared profile MUST NOT reference a personal profile as its proxy.

### 3.4 Addon Encrypted Secrets

Addon secrets are stored alongside base-type secrets in the single `encryptedSecrets` blob:

```typescript
{
  // Base-type secrets (varies by authType)
  apiKey?: string;
  token?: string;
  // ... other base-type secrets

  // Addon secrets (present only when addon is configured)
  signingSecret?: string;           // for signing addon (HMAC key or RSA PEM)
  webhookSecret?: string;           // for webhookVerification addon
}
```

The Zod validation schema MUST validate addon secrets alongside base-type secrets: if `signing` addon is present, `signingSecret` is required in secrets. Same for `webhookSecret`.

### 3.5 Invalid Combination Matrix

These combinations MUST be rejected at profile creation/update time:

| Combination                       | Reason                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `aws_iam` + `signing`             | AWS SigV4 is itself a signing mechanism; double-signing corrupts the request  |
| `ssh_key` + `signing` / `proxy`   | SSH key is not used in HTTP requests                                          |
| `webhookVerification` + `signing` | Opposite directions (inbound verify vs outbound sign) — use separate profiles |
| `mtls` + `proxy`                  | mTLS is typically terminated at the proxy, not forwarded through              |

### Composable Examples (valid)

- `api_key` + `signing` → HMAC-signed API calls
- `oauth2_token` + `webhookVerification` → receive webhooks from connected service
- Any auth type + `proxy` → route through corporate proxy

---

## 4. Consumer Reference Model

Every entity that needs auth stores a single `authProfileId` instead of inline credentials.

### Consumer Mapping

| Consumer                                    | Auth Profile Types Expected                                                    | Reference Field                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| LLM Provider Connection                     | `api_key`, `azure_ad`, `aws_iam`, `oauth2_client_credentials`, `custom_header` | `TenantModel.connections[].authProfileId`                 |
| Connector (Layer 1 — app config)            | `oauth2_app`                                                                   | `ConnectorConfig.authProfileId`                           |
| Connector Connection (Layer 2 — user token) | `oauth2_token`, `api_key`, `bearer`, `basic`                                   | `ConnectorConnection.authProfileId`                       |
| MCP Server                                  | `api_key`, `bearer`, `custom_header`, `oauth2_client_credentials`, `none`      | `MCPServerConfig.authProfileId`                           |
| HTTP Tool (DSL-defined)                     | `api_key`, `bearer`, `basic`, `oauth2_client_credentials`, `custom_header`     | Resolved via `auth: "profile-name"` in DSL                |
| Channel Connection                          | `oauth2_token`, `api_key`, `custom_header`                                     | `ChannelConnection.authProfileId`                         |
| Git Integration                             | `oauth2_token`, `bearer`, `ssh_key`                                            | `GitIntegration.authProfileId`                            |
| Service Node                                | `api_key`, `bearer`, `basic`, `oauth2_client_credentials`, `custom_header`     | `ServiceNode.authProfileId`                               |
| Guardrail Provider                          | `api_key`, `bearer`                                                            | `TenantGuardrailProviderConfig.authProfileId`             |
| Org Proxy                                   | `basic`, `bearer`, `mtls`                                                      | `OrgProxyConfig.authProfileId`                            |
| Voice Service Instance                      | `api_key`                                                                      | `TenantServiceInstance.authProfileId`                     |
| Arch Workspace Config (Arch AI assistant)   | `api_key`, `azure_ad`, `aws_iam`                                               | `ArchWorkspaceConfig.authProfileId`                       |
| Connector Config (SearchAI)                 | `oauth2_token`                                                                 | `ConnectorConfig.authProfileId` (replaces `oauthTokenId`) |
| Webhook Subscription                        | — (uses `webhookVerification` addon)                                           | `WebhookSubscription.authProfileId`                       |
| Webhook Subscription Connector (MS Graph)   | — (uses `webhookVerification` addon)                                           | `WebhookSubscriptionConnector.authProfileId`              |
| SDK Channel (HMAC identity verification)    | — (uses `webhookVerification` addon)                                           | `SDKChannel.authProfileId`                                |

### Consumer Reference Validation

All consumers MUST validate `authProfileId` at link time:

```typescript
async function validateAuthProfileAccess(
  authProfileId: string,
  tenantId: string,
  projectId: string,
): Promise<AuthProfile> {
  const profile = await AuthProfile.findOne({
    _id: authProfileId,
    tenantId, // CRITICAL: same tenant
    $or: [
      { projectId: null }, // tenant-level: accessible by all projects
      { projectId }, // project-level: must match
    ],
  });
  if (!profile) throw new NotFoundError('Auth profile not found');
  return profile;
}
```

### Resolution Priority (runtime)

1. Personal `oauth2_token` for this user + connector + environment (if `per_user`)
2. Shared `oauth2_token` for this connector + environment (if `shared`)
3. Project-level Auth Profile with matching `authProfileId` + environment
4. Project-level Auth Profile with `environment: null` (any-environment fallback)
5. Tenant-level Auth Profile fallback

---

## 5. Two-Layer OAuth Model

### Layer 1: `oauth2_app` (App Credentials)

Created by project admins or workspace admins. Stores `clientId`/`clientSecret` for an OAuth app.

### Layer 2: `oauth2_token` (User Tokens)

Created when a user authorizes. Links back to Layer 1 via `linkedAppProfileId`.

```
oauth2_app (Layer 1)                    oauth2_token (Layer 2)
+---------------------+                +---------------------------+
| id: "ap-google-1"   |<---linked------| id: "up-abc123"           |
| authType: oauth2_app|                | authType: oauth2_token    |
| config:             |                | visibility: personal      |
|   authorizationUrl  |                | createdBy: user-prasanna  |
|   tokenUrl          |                | linkedAppProfileId:       |
|   defaultScopes     |                |   "ap-google-1"           |
| secrets:            |                | secrets:                  |
|   clientId          |                |   accessToken             |
|   clientSecret      |                |   refreshToken            |
+---------------------+                +---------------------------+
       ^                                        ^
       |                                        |
  Project admin                          End user (or workflow
  configures once                        developer for "shared")
```

### Cross-Reference Validation

When creating or updating an `oauth2_token`, the `linkedAppProfileId` MUST be validated:

1. Must resolve to a profile in the **same tenant** (prevents cross-tenant credential theft)
2. Must have `authType: 'oauth2_app'`
3. Must be re-validated at token refresh time (link could be tampered with)

### DSL Connection Modes

```yaml
TOOLS:
  - gmail.send_email:
      connection: shared # uses workflow developer's oauth2_token
  - gmail.send_email:
      connection: per_user # runtime prompts end user for their own oauth2_token
```

### Token Refresh (unified)

1. Check `config.expiresAt` (configurable buffer via `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS`, default 60s). **If `config.expiresAt` is null, proactive refresh is skipped; the 401 retry-with-refresh path handles expired tokens reactively.**
2. If expired, load `linkedAppProfileId` → validate same tenant → get `clientId`, `clientSecret`, `tokenUrl`
3. Acquire tenant-scoped distributed lock (Redis `SET NX PX`, TTL 30s) to prevent concurrent refresh
4. Exchange `refreshToken` for new tokens
5. If `refreshTokenRotation: true`, store new refresh token atomically
6. Update `encryptedSecrets` and `config.expiresAt`
7. Release lock

**Lock contention strategy:** Callers that fail to acquire the lock wait with 100ms exponential backoff (max 2s), re-read from DB, and use the refreshed token if available. If still expired after max wait, fail with `AUTH_PROFILE_TOKEN_REFRESH_FAILED`.

> **Redis unavailability policy:** If Redis is unavailable (connection refused), proceed without the lock (risking a duplicate refresh) rather than failing the session. Log `auth_profile_lock_unavailable` trace event. This matches the existing behavior where `ToolOAuthService` refreshes without any lock.

> **Correctness note:** The existing `ToolOAuthService.refreshToken()` has NO distributed lock — this is a known race condition being fixed, not just a refactoring exercise.

Replaces three separate refresh implementations in `connection-resolver.ts`, `tool-oauth-service.ts`, and `channel-oauth-service.ts`.

---

## 6. Pre-flight Auth Propagation

### DSL Declaration

```yaml
AGENT: email-assistant
TOOLS:
  - gmail.send_email:
      connection: per_user
      consent: preflight # must authorize before session starts
  - google-calendar.list_events:
      connection: per_user
      consent: inline # prompt mid-conversation when tool is invoked
  - slack.post_message:
      connection: shared # no pre-flight, uses developer's token
```

### Compiled IR Auth Requirements

The IR stores `authProfileId` (resolved at compile/deploy time). Actual credential decryption happens live at runtime — the IR MUST NOT contain decrypted secrets.

```typescript
authRequirements: [
  {
    connector: 'gmail',
    authType: 'oauth2_token',
    connectionMode: 'per_user',
    consent: 'preflight',
    scopes: ['gmail.send', 'gmail.compose'],
    authProfileId: 'ap-google-1', // resolved at compile time
    authProfileName: 'gmail-app', // for audit trail
  },
];
```

### Propagation Rules

| Rule                              | Behavior                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `per_user` + `consent: preflight` | Bubbles up to entry point, blocks session start                                                 |
| `per_user` + `consent: inline`    | Bubbles up as optional, inline consent at runtime (JIT)                                         |
| `shared`                          | No pre-flight, developer's token used, does not bubble                                          |
| Nested calls                      | Compiler walks full dependency tree, deduplicates by connector+scopes                           |
| Duplicate connectors              | Union of scopes (gmail in agent needs `send`, workflow needs `read` → pre-flight asks for both) |

### Token Storage by Consent Mode

**Key principle:** Preflight and JIT (inline) are identical in token storage — both always store under the real end user's ID. The only difference is timing.

| Consent Mode   | When                     | Token Storage                                    |
| -------------- | ------------------------ | ------------------------------------------------ |
| `preflight`    | Before session starts    | `EndUserOAuthToken` with `userId = real user ID` |
| `inline` (JIT) | Mid-execution, on demand | `EndUserOAuthToken` with `userId = real user ID` |
| N/A (`shared`) | Admin setup time         | `EndUserOAuthToken` with `userId = '__tenant__'` |

The auth profile's `connectionMode: 'shared'` (storing tokens as `__tenant__`) is exclusively for `preconfigured` mode (admin-managed credentials). When an end user provides consent — whether preflight or JIT — the token is always stored under their real user ID.

Note: `visibility` (who can see the profile) and `connectionMode` (how credentials are stored) are independent fields on the auth profile schema.

### Cascading Scenarios

- **Agent calls Workflow with per_user tools:** Compiler bubbles up all `per_user` requirements from child workflows into the agent's `authRequirements` manifest. Pre-flight happens at the agent level (entry point).
- **Workflow uses Agent with per_user tools:** Same principle — requirements bubble up. Pre-flight happens at the session entry point.
- **Agent → Workflow → Agent (nested):** Compiler recursively collects all `per_user` requirements up to the root. Deduplicates by connector+scopes.

### Runtime Pre-flight Response

```typescript
{
  type: "auth_required",
  pending: [
    {
      connector: "gmail",
      displayName: "Gmail",
      scopes: ["gmail.send", "gmail.compose"],
      authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
    }
  ],
  satisfied: [
    { connector: "google-calendar", displayName: "Google Calendar" }
  ]
}
```

---

## 7. UI Touchpoints

### 7.1 Auth Profiles Management Page (Settings > Auth Profiles)

Dedicated page listing all Auth Profiles for the current scope (tenant or project).

- Table/grid: name, authType icon, status badge, scope, environment, visibility, last used, linked consumers count
- "New Auth Profile" → type selector → type-specific form
- Status: active (green), expired (amber), revoked (red), invalid (gray)
- Filter by: authType, status, scope, environment
- Bulk actions: revoke, delete

### 7.2 Connector Setup Flow (Connections Page)

When a user clicks "Connect" on a connector:

- **Step 1: App Credentials** — "Does this project have OAuth app credentials?"
  - If yes → show linked `oauth2_app`, option to change
  - If no → inline form with Nango's `setup_guide_url` as help. Creates `oauth2_app` Auth Profile
  - If tenant-level exists → "Using workspace default" with override option
- **Step 2: Authorization** — "Who authorizes?"
  - "I'll authorize now (shared)" → OAuth flow → `oauth2_token` with `visibility: shared`
  - "End users will authorize themselves" → `connection: per_user` in DSL
- **Step 3: Confirmation** — summary of created profiles

For non-OAuth connectors: single credential form, creates Auth Profile directly.

### 7.3 Workflow Editor (Tool/Trigger Configuration Panel)

- Dropdown: "Select connection" → lists shared `oauth2_token` profiles for this connector
- "Create new connection" → opens connector setup flow
- Toggle: "Shared" vs "Per-user" → sets `connection` in DSL
- Per-user info: "End users will be prompted to authorize when they use this workflow"

### 7.4 Runtime Consent (End-User OAuth)

- **Pre-flight:** Before agent starts: "This agent needs access to: Gmail, Calendar. [Authorize Gmail] [Authorize Calendar]"
- **Inline:** Mid-conversation: "I need access to your Gmail to send that email. [Authorize]" → OAuth popup → creates personal `oauth2_token`

### 7.5 Inline Setup Help (Nango-Powered)

For every `oauth2_app` creation form:

- "How to get these credentials?" → expandable panel
- Content from Nango's `setup_guide_url` and `docs_connect`
- Shows: required redirect URI (auto-generated, copy-able), common scopes, gotchas
- Provider-specific guidance (Google consent screen, Slack bot scopes, etc.)

---

## 8. API Design

### Permissions (RBAC)

New permissions in `StudioPermission`:

```typescript
AUTH_PROFILE_READ: 'auth-profile:read',     // view profile metadata, redacted secrets
AUTH_PROFILE_WRITE: 'auth-profile:write',    // create/update profiles
AUTH_PROFILE_DELETE: 'auth-profile:delete',  // delete profiles (with consumer impact check)
AUTH_PROFILE_DECRYPT: 'auth-profile:decrypt', // view decrypted secrets (admin only)
```

### Auth Profile CRUD

```
# Tenant-level (workspace admin — requires admin role + AUTH_PROFILE_* permissions)
# All routes use withRouteHandler for auth enforcement
GET    /api/auth-profiles                              # list tenant-level profiles
POST   /api/auth-profiles                              # create tenant-level profile
GET    /api/auth-profiles/:id                          # get (redacted secrets)
PUT    /api/auth-profiles/:id                          # update
DELETE /api/auth-profiles/:id                          # delete
POST   /api/auth-profiles/:id/validate                 # test credentials

# Project-level (project member — requires AUTH_PROFILE_* permissions)
GET    /api/projects/:pid/auth-profiles                # list (project + inherited tenant)
POST   /api/projects/:pid/auth-profiles                # create project-level
GET    /api/projects/:pid/auth-profiles/:id
PUT    /api/projects/:pid/auth-profiles/:id
DELETE /api/projects/:pid/auth-profiles/:id
POST   /api/projects/:pid/auth-profiles/:id/validate
```

**All project-level ID-based queries MUST include `projectId` in the filter**, not just `tenantId`:

```typescript
const profile = await AuthProfile.findOne({ _id: id, tenantId, projectId: params.id });
```

### OAuth Flows

```
# Initiate OAuth (resolve authorization URL from oauth2_app profile)
POST   /api/projects/:pid/auth-profiles/oauth/initiate
       Body: { connectorName, authProfileId }
       Returns: { authUrl, state }
       Rate limit: { limit: 20, windowMs: 60_000, scope: 'user' }

# OAuth callback (exchange code → create oauth2_token profile)
POST   /api/projects/:pid/auth-profiles/oauth/callback
       Body: { code, state, displayName? }
       Returns: { authProfile }
       Rate limit: { limit: 10, windowMs: 60_000, scope: 'user' }

# End-user OAuth (runtime consent flow)
POST   /api/projects/:pid/auth-profiles/oauth/user-consent
       Body: { connectorName, sessionId }
       Returns: { authUrl, state }
```

### Resolution (runtime internal)

```typescript
authProfileService.resolve({
  tenantId,
  projectId,
  connector: "gmail",
  connectionMode: "per_user" | "shared",
  environment?: "production",
  userId?,
}): Promise<DecryptedCredentials>
```

### List Endpoint Enrichment

Project-level `GET /api/projects/:pid/auth-profiles` returns merged results:

- Project-level profiles first
- Tenant-level profiles not overridden, marked `inherited: true`
- Override defined as: same `connector` + `authType` match (not name). Overridden tenant profiles appear as `{ inherited: true, overridden: true }`
- Filtering: `?authType=oauth2_app&connector=gmail&environment=production`

### Personal Profile Visibility

List queries MUST enforce visibility at the DB level, not as post-query filter:

```typescript
if (!isAdmin) {
  filter.$or = [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }];
}
```

Tenant admins can see all personal profiles (for audit/troubleshooting), with audit logging when viewing another user's personal profile. Secrets remain redacted unless `AUTH_PROFILE_DECRYPT` permission is held.

---

## 9. Database Schema

### MongoDB Document

```typescript
{
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;         // explicit null for tenant-level, NEVER undefined
  scope: 'tenant' | 'project';
  environment: string | null;       // null = all environments
  visibility: 'shared' | 'personal';
  createdBy: string;                // immutable
  authType: 'none' | 'api_key' | 'bearer' | 'basic'
    | 'oauth2_app' | 'oauth2_token' | 'oauth2_client_credentials'
    | 'custom_header' | 'aws_iam' | 'azure_ad'
    | 'ssh_key' | 'mtls';
    // Phase 3+ deferred: 'digest' | 'kerberos' | 'saml' | 'hawk' | 'ws_security'
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  rotationPolicy?: object;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  // Addon mechanisms (3 core)
  signing?: object;
  webhookVerification?: object;
  proxy?: object;
  // Phase 3+ deferred: jwtWrapping?: object; certificatePinning?: object;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}
```

### Plugins

```typescript
AuthProfileSchema.plugin(tenantIsolationPlugin);
AuthProfileSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
});
AuthProfileSchema.plugin(auditTrailPlugin);
```

### Indexes

```
{ tenantId, scope }                                          // list tenant-level
{ tenantId, projectId, scope }                               // list project-level
{ tenantId, projectId, connector, authType }                 // find connector auth
{ tenantId, projectId, visibility, createdBy }               // find personal profiles
{ tenantId, projectId, connector, visibility, createdBy }    // personal profile resolution
{ tenantId, projectId, category }                            // filter by category
{ linkedAppProfileId }                                       // find all tokens for an app
{ status, expiresAt, authType }                              // cleanup expired + batch refresh
```

### Unique Constraints

Two partial unique indexes to handle `projectId: null` correctly:

```
// Tenant-level: unique name per tenant + environment
{ tenantId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: null }

// Project-level: unique name per tenant + project + environment
{ tenantId, projectId, name, environment }
  UNIQUE, partialFilterExpression: { projectId: { $ne: null } }
```

### Validation Rules

| authType                    | Required config                                                                            | Required secrets                                             |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `none`                      | —                                                                                          | —                                                            |
| `api_key`                   | `headerName`. `placement` defaults to `'header'` if omitted.                               | `apiKey`                                                     |
| `bearer`                    | —                                                                                          | `token`                                                      |
| `basic`                     | —                                                                                          | `username`, `password`                                       |
| `oauth2_app`                | `authorizationUrl`, `tokenUrl`                                                             | `clientId`, `clientSecret`                                   |
| `oauth2_token`              | `provider`                                                                                 | `accessToken`                                                |
| `oauth2_client_credentials` | `tokenUrl`                                                                                 | `clientId`, `clientSecret`                                   |
| `custom_header`             | at least one header name                                                                   | matching header values (keys must match config.headers keys) |
| `aws_iam`                   | `region`                                                                                   | `accessKeyId`, `secretAccessKey`                             |
| `azure_ad`                  | `tenantId`, `resource`. `endpoint` optional (default `https://login.microsoftonline.com`). | `clientId`, `clientSecret`                                   |
| `ssh_key`                   | `keyType` optional (default `'rsa'`)                                                       | `privateKey`                                                 |
| `mtls`                      | —                                                                                          | `clientCert`, `clientKey`                                    |

> The Zod schema for `none` MUST still use `.strict()` to prevent unknown fields.

**Addon secrets validation:** If `signing` addon present → `signingSecret` required. If `webhookVerification` present → `webhookSecret` required.

---

## 10. Error Handling

| Scenario                                                | Behavior                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Auth Profile deleted while referenced                   | Consumers with dangling `authProfileId` get: "Auth profile 'X' not found. Reconfigure authentication." Consumer status → `invalid`. |
| Token expired, refresh fails                            | `oauth2_token` status → `expired`. Runtime returns: "Gmail authorization expired. [Re-authorize]"                                   |
| `oauth2_app` deleted while tokens exist                 | Block deletion: "Cannot delete — N active connections use this OAuth app. Revoke them first."                                       |
| Auth Profile deleted while deployed agents reference it | Block deletion: "Cannot delete — N active deployments reference this profile."                                                      |
| Pre-flight: user denies consent                         | Session does not start. Client shows which connectors were denied.                                                                  |
| Inline consent: user denies mid-conversation            | Agent receives tool error: "User declined Gmail authorization." Agent continues without that tool.                                  |
| Duplicate profile name in same scope                    | 409 Conflict: "An auth profile named 'X' already exists in this project."                                                           |
| Incompatible authType for consumer                      | Validation at link time: "MCP Server requires api_key, bearer, or oauth2_client_credentials. Got ssh_key."                          |
| Tenant profile overridden at project level              | Project-level with same connector+authType takes precedence. Tenant profile visible as `inherited: true, overridden: true`.         |
| Cross-tenant `linkedAppProfileId`                       | Reject on create/update: "Linked OAuth app must belong to the same tenant."                                                         |
| Cross-project `authProfileId` reference                 | Reject: "Auth profile not accessible from this project." (unless tenant-scoped)                                                     |
| Visibility change (shared→personal)                     | Only creator or admin can change. Must verify no other consumers depend on it.                                                      |

---

## 11. Security & Compliance

### Audit Logging

All credential-touching operations MUST emit audit events:

| Operation                    | Audit Action                    | Metadata                                     |
| ---------------------------- | ------------------------------- | -------------------------------------------- |
| Create profile               | `AUTH_PROFILE_CREATED`          | `{ profileId, authType, scope, visibility }` |
| Update profile               | `AUTH_PROFILE_UPDATED`          | `{ profileId, changedFields[] }`             |
| Delete profile               | `AUTH_PROFILE_DELETED`          | `{ profileId, authType, consumerCount }`     |
| Decrypt secrets              | `AUTH_PROFILE_SECRETS_ACCESSED` | `{ profileId, accessedBy, purpose }`         |
| Token refresh                | `AUTH_PROFILE_TOKEN_REFRESHED`  | `{ profileId, connector, success }`          |
| Validate/test                | `AUTH_PROFILE_VALIDATED`        | `{ profileId, result }`                      |
| Status change                | `AUTH_PROFILE_STATUS_CHANGED`   | `{ profileId, from, to }`                    |
| Link consumer                | `AUTH_PROFILE_LINKED`           | `{ profileId, consumerType, consumerId }`    |
| Admin views personal profile | `AUTH_PROFILE_ADMIN_VIEWED`     | `{ profileId, adminUserId, ownerUserId }`    |

### GDPR Cascade (Right to Erasure)

Auth Profile MUST be included in `MongoGDPRStore` from day one:

1. **User deletion:** Delete all personal Auth Profiles where `createdBy === subjectId`
2. **Shared profiles:** Do NOT delete. Reassign `createdBy` to a system account or anonymize
3. **Token revocation:** When deleting personal `oauth2_token` profiles, call provider's revocation endpoint (if `revocationUrl` is configured in linked `oauth2_app`)
4. **User removed from project:** Revoke (not delete) their personal profiles in that project: `status: 'revoked'`
5. **Audit trail:** Log the erasure with anonymized subject ID (SHA-256 hash, matching existing `anonymizeAuditEntries` pattern)

### Cross-Reference Security

All foreign-key references to other Auth Profiles require same-tenant validation:

| Reference                | Validation                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `linkedAppProfileId`     | Same tenantId, authType must be `oauth2_app`. Validated on create, update, AND at refresh time. |
| `proxyAuthProfileId`     | Same tenantId. Validated on create and update.                                                  |
| Consumer `authProfileId` | Same tenantId, and either tenant-scoped OR same projectId.                                      |

---

## 12. Versioning & Deployment

### Credentials Are Live-Referenced

The existing architecture already treats credentials as live-referenced, not snapshotted. Auth Profile fits this pattern: the IR stores `authProfileId` (resolved at compile time), actual credentials are decrypted live at runtime.

- Rotating an API key in an Auth Profile immediately affects all deployed agents without redeployment
- Deleting a referenced Auth Profile causes runtime error (not silent fallback)

### Tool Snapshot Enrichment

`AgentVersion.toolSnapshot` should include `authProfileId` and `authProfileName` for audit trail. Never include decrypted secrets.

### Deploy-Time Validation

When creating a deployment, validate:

- All Auth Profiles referenced by agent versions exist and are `active`
- Runtime supports all `authType` values referenced
- All `per_user` requirements have corresponding `oauth2_app` profiles

### Environment Promotion

The promote endpoint should verify that all Auth Profiles referenced by agent versions exist and are active in the target environment. If environment-specific Auth Profiles exist, resolution picks the right one automatically.

### Rolling Deployment Safety

Migration uses dual-read: new code reads `authProfileId` first, falls back to `credentialId` when absent. This enables zero-downtime rolling deployments.

| Phase            | Old Pods            | New Pods                                         | Database State        |
| ---------------- | ------------------- | ------------------------------------------------ | --------------------- |
| Pre-migration    | Read `credentialId` | N/A                                              | Only old fields       |
| Phase 1: Both    | Read `credentialId` | Read `authProfileId`, fallback to `credentialId` | Both fields populated |
| Phase 2: All new | N/A                 | Read `authProfileId`, fallback to `credentialId` | Both fields populated |
| Phase 3: Cleanup | N/A                 | Read `authProfileId` only                        | Remove old fields     |

---

## 13. Import/Export & Portability

### Export

Auth Profile metadata (never secrets) is included in the v2 export manifest:

```typescript
// Added to ProjectManifestV2.metadata
required_auth_profiles: Array<{
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>; // non-secret config only
  referencedBy: string[]; // agent/tool names
}>;
```

- `ConnectionsAssembler` exports `authProfileName` (resolved from ID). Strips `authProfileId`.
- `env-var-scanner.ts` extended to also scan for `auth:` references in DSL.
- Encrypted secrets are NEVER exported.

### Import

Import flow gains an **auth mapping step**:

1. Preview extracts auth profile requirements from DSL `auth:` references and connection `authProfileId` fields
2. Preview response includes `auth_mapping` with candidates from existing Auth Profiles
3. UI presents a mapping table: "Required: production-openai (api_key) → [Select Existing v] / [Create New]"
4. Apply endpoint accepts `authProfileMapping` to remap references

### Post-Import Doctor

Extended to check Auth Profiles:

- `provisioning_required.auth_profiles` — auth profiles referenced but not found
- Distinguishes `shared` (needs pre-existing token) from `per_user` (needs only app credentials)

### Cross-Tenant Import

All `authProfileId` references are stripped. Auth mapping wizard presents requirements for user to create/link in the target tenant. Encrypted secrets cannot be decrypted cross-tenant (tenant-scoped key derivation).

### DSL Portability

DSL uses name-based references (`auth: my-profile-name`) which are inherently portable. Names resolve against the target project's Auth Profiles after import. The unique constraint ensures unambiguous resolution within a scope.

---

## 14. Migration Strategy (Replace All)

This is new product. Auth Profile replaces all existing credential models.

### Feature Flag

```typescript
const AUTH_PROFILE_ENABLED = process.env.AUTH_PROFILE_ENABLED === 'true'; // default: false
```

All credential resolution paths use dual-read during migration:

```typescript
const credential = entity.authProfileId
  ? await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId })
  : await legacyCredentialService.resolve({ credentialId: entity.credentialId, tenantId });
```

### Models Deleted (3)

| Model               | Replaced By                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `LLMCredential`     | `AuthProfile` with `authType: api_key \| azure_ad \| aws_iam`                 |
| `EndUserOAuthToken` | `AuthProfile` with `visibility: personal`, `authType: oauth2_token`           |
| `ToolSecret`        | `AuthProfile` (DSL changes from `{{secrets.KEY}}` to `auth: my-profile-name`) |

### Models Simplified (14, drop inline auth fields)

| Model                           | Fields Dropped                                                 | Keeps                                            |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `ConnectorConnection`           | `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider` | `authProfileId`                                  |
| `MCPServerConfig`               | `encryptedAuthConfig`, `encryptedEnv`                          | `authProfileId`                                  |
| `ChannelConnection`             | `encryptedCredentials`, `config.encryptedInboundAuthToken`     | `authProfileId`                                  |
| `ServiceNode`                   | `encryptedSecrets`, `authConfig`                               | `authProfileId`                                  |
| `OrgProxyConfig`                | 6 encrypted fields                                             | `authProfileId`                                  |
| `TenantModel.connections[]`     | `credentialId`                                                 | `authProfileId`                                  |
| `TenantGuardrailProviderConfig` | `apiKeyCredentialId`                                           | `authProfileId`                                  |
| `GitIntegration`                | `credentials.secretId`, `webhookSecret`                        | `authProfileId`                                  |
| `TenantServiceInstance` (voice) | `encryptedApiKey`, `encryptedConfig`                           | `authProfileId`                                  |
| `ArchWorkspaceConfig` (Arch AI) | `encryptedApiKey`, `encryptedEndpoint`                         | `authProfileId`                                  |
| `ConnectorConfig` (SearchAI)    | `oauthTokenId`                                                 | `authProfileId`                                  |
| `WebhookSubscription`           | `encryptedSecret`                                              | `authProfileId` with `webhookVerification` addon |
| `WebhookSubscriptionConnector`  | `encryptedClientState`                                         | `authProfileId`                                  |
| `SDKChannel`                    | `secretKey`                                                    | `authProfileId` with `webhookVerification` addon |

### Explicitly Out of Scope

- `EnvironmentVariable` — deployment config, not auth (secret env vars storing credentials should migrate)
- `ApiKey` / `PublicApiKey` — platform access keys (JWT alternative)
- `TenantKMSConfig` — encryption infrastructure
- `Organization.ssoConfigs` — platform SSO (SAML/OIDC for user login), not service auth. May be considered in a future phase.
- Voice service env vars (Twilio, Deepgram, ElevenLabs, LiveKit — 16 vars) — out of scope for this phase, but `TenantServiceInstance` IS in scope since it already stores encrypted credentials in DB
- `Contact.identities[].encryptedValue` — PII encryption, not service auth

### BullMQ Worker Migration Strategy

22+ BullMQ workers resolve credentials at job execution time. Strategy:

1. Workers import both `AuthProfileService` and legacy credential models
2. Each worker uses dual-read pattern (prefer `authProfileId`, fallback to `credentialId`)
3. Workers are updated in the same deployment as the migration script
4. Specific workers to update: connector-sync-worker, connector-discovery-worker, connector-permission-crawl-worker, webhook-renewal scheduler, embedding-worker, kg-enrichment-worker, enrichment-worker, vocabulary-generation-worker, 6× IDP sync workers, delivery-worker, inbound-worker

### WebSocket Session Continuity

Long-lived WebSocket sessions resolve credentials via `model-resolution.ts`. During migration:

- In-flight sessions continue using `credentialId` (old path works)
- New sessions use dual-read
- No active sessions are disrupted

### Env-to-DB Seed Migration

A migration script reads existing `OAUTH_PROVIDER_*` and `CHANNEL_OAUTH_*` env vars and creates corresponding `oauth2_app` Auth Profiles in MongoDB. This bridges env-var-based configuration to database-backed Auth Profile.

### Migration Name Collision Prevention

When migrating credentials to Auth Profiles, auto-generated names must be unique. Strategy:

- Generate name from credential type + provider: "OpenAI API Key", "Google OAuth App"
- If collision, append suffix: "OpenAI API Key (2)"
- Create unique indexes AFTER data migration with `{ background: true }`

### DSL Integration

```yaml
AGENT: support-bot
AUTH:
  gmail-app: oauth2_app
TOOLS:
  - gmail.send_email:
      auth: gmail-app
      connection: per_user
      consent: preflight
  - openai.chat:
      auth: production-openai
```

Compiler resolves `auth: "name"` to `authProfileId` at compilation/deployment. Runtime uses `authProfileService.resolve()` for decrypted credentials. Old agents using `{{secrets.X}}` continue to work (ToolSecret still queried during dual-read); new agents use `auth:` syntax.

---

## 15. Libraries [Phase 1-2]

| Library                 | Version | Purpose                                   | Loading Strategy                                                                                                                                  |
| ----------------------- | ------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simple-oauth2`         | latest  | OAuth 2.0 protocol mechanics              | Direct import                                                                                                                                     |
| `@aws-sdk/signature-v4` | latest  | AWS SigV4 request signing                 | Direct import. **Must be explicitly added** — not currently in the monorepo (only `@aws-sdk/client-lambda` and `@aws-sdk/client-s3` are present). |
| `@azure/identity`       | latest  | Azure AD authentication                   | Lazy `import()`                                                                                                                                   |
| `ssh2`                  | latest  | SSH key authentication for Git operations | Lazy `import()` — only loaded when `ssh_key` auth type is used. Alternative: system `git` + `GIT_SSH_COMMAND` env var.                            |

**Deferred libraries (Phase 3+):** `soap`, `kerberos`, `@node-saml/node-saml`, `@hapi/hawk`, `digest-fetch`. Recommend an optional `packages/auth-enterprise` workspace package to avoid bundling ~8MB+ of unused dependencies and Docker build changes (native C++ bindings for `kerberos`) into the core platform.

### Package Placement

- Core Auth Profile (model, service, repo, types, validation): `packages/database` + `packages/shared`
- No new workspace packages needed for Phase 1-2. Phase 3+ enterprise libraries go in optional `packages/auth-enterprise`.

Build our own `AuthProfileService` for scoping, encryption, consumer linking, and DSL integration. Use these libraries for protocol-specific mechanics.

---

## 16. Recommended Phasing

### Phase 1 — Connector OAuth (3-4 sprints) [Phase 1]

**Scope:** Minimum to enable the connector OAuth flow end-to-end.

**Auth types implemented:** `oauth2_app`, `oauth2_token`, `oauth2_client_credentials`, `api_key`, `bearer`, `none`.

Items included:

1. `AuthProfile` Mongoose model (full schema from Section 9, all fields, correct plugins)
2. `AuthProfileService` with methods: `create`, `update`, `delete`, `resolve` (5-level `$or` query), `validateAccess`
3. Project-scoped CRUD API (`/api/projects/:pid/auth-profiles/*`) for the 6 auth types above
4. OAuth initiate, callback, and user-consent endpoints (Section 8)
5. `ConnectorAppConfig.appAuthProfileId` and `ConnectorConnection.authProfileId` with dual-read (fallback to existing fields)
6. GDPR cascade: add `AuthProfile` to `cascade-delete.ts` AND `MongoGDPRStore` from day one. Fix pre-existing `EndUserOAuthToken` GDPR gap.
7. Audit trail ciphertext masking fix (Section 11)
8. Studio connector setup flow (Section 7.12) and `AuthProfilePicker` component (Section 7.7)
9. Auth Profiles management page (Section 7.11) limited to Phase 1 auth types
10. SSRF validation on all URL fields (Section 11)
11. Zod `.strict()` on all config schemas
12. Structured `AuthProfileError` with `retryable` discriminator (Section 10)
13. Four trace events via `TraceStore` (Section 10)
14. Rate limits on OAuth endpoints

### Phase 2 — Credential Consolidation (4-6 sprints) [Phase 2]

**Prerequisite:** Phase 1 stable in production with canary tenant validation.

Items:

1. Remaining 6 core auth types: `basic`, `aws_iam`, `azure_ad`, `custom_header`, `ssh_key`, `mtls`
2. `LLMCredential` migration: create Auth Profiles, populate `authProfileId` on consumers, dual-read in `llm-config/resolver.ts`, `model-resolution.ts`
3. `ToolSecret` migration: dual-read in `RuntimeSecretsProvider.getSecret()`
4. `EndUserOAuthToken` migration: replace `tool-oauth-service.ts` with `AuthProfileService` token refresh (with distributed lock)
5. Worker dual-read (~10-12 direct changes + shared resolver updates)
6. `idp-sync-scheduler.ts` fix: migrate LLMCredential IdP records to Auth Profile
7. `embedding-worker.ts` singleton: add Auth Profile resolution path
8. `connection-resolver.ts`, `service-node-executor.ts`, `connectors/base` `TokenManager` dual-read
9. `EncryptionService` multi-key prerequisite
10. Pre-flight auth propagation in compiler and runtime
11. Tenant-scoped Auth Profile CRUD API (`/api/auth-profiles/*`)
12. `CredentialAgeMonitor` updated to query `AuthProfile`
13. `VoiceServiceFactory` cache wired to Auth Profile rotation invalidation via Redis pub/sub
14. `ModelConfig.credentialId` → `authProfileId` migration with dual-read in `model-resolution.ts`
15. `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` → `authProfileId` migration

### Phase 3 — Enterprise + Cleanup (2-3 sprints) [Phase 3]

**Prerequisite:** Phase 2 stable with all workers migrated. Full MongoDB snapshot taken before cleanup.

Items:

1. 5 deferred auth types: `kerberos` (with Docker build changes), `saml`, `hawk`, `digest`, `ws_security`
2. 2 deferred addons: `jwtWrapping`, `certificatePinning`
3. Multi-agent credential propagation (handoff, delegate, fan-out)
4. Import/export auth mapping step
5. Rotation batch job (re-encrypt all `encryptedSecrets` with new master key version)
6. Phase 3 cleanup: drop `credentialId` from consumer models, delete `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections
7. Env var obsolescence: remove `CHANNEL_OAUTH_*`, `OAUTH_PROVIDER_*`, LLM API key env vars

**Go/no-go gate for cleanup:** All workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days. Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors in the preceding 14 days. Full MongoDB snapshot confirmed with retention policy documented.

---

## 17. Operational Monitoring [Phase 1]

### Health Check

Add `AuthProfile` to the existing `service-registry.ts` health registry. The health check verifies:

- MongoDB connection can query `AuthProfile`
- A known test profile can be decrypted
- Redis lock mechanism is reachable

### Alerting Thresholds

| Failure Mode                                   | Alert Threshold                         | Action                         |
| ---------------------------------------------- | --------------------------------------- | ------------------------------ |
| `AUTH_PROFILE_TOKEN_REFRESH_FAILED` at scale   | > 5 failures/minute sustained for 5 min | PagerDuty                      |
| `AUTH_PROFILE_DECRYPTION_FAILED`               | > 0 in production                       | PagerDuty (key rotation issue) |
| Redis lock contention timeout on token refresh | > 10% of refresh attempts over 5 min    | Warning — investigate          |
| Proxy chain resolution failures                | > 0 in production                       | Warning                        |
| `CredentialAgeMonitor` reports zero aged creds | Post-migration: if zero for > 24h       | Warning (monitor may be dead)  |

### `CredentialAgeMonitor` Migration [Phase 2]

`CredentialAgeMonitor.checkAll()` currently hardcodes queries against `ToolSecret`, `LLMCredential`, and `ApiKey`. After migration, these collections will be empty and the monitor silently stops producing age alerts.

**Migration action:** Update `CredentialAgeMonitor` to query `AuthProfile` instead, using `rotationStartedAt` / `lastValidatedAt` / `createdAt` fields. Update corresponding tests.

### VoiceServiceFactory Cache Invalidation [Phase 2]

`VoiceServiceFactory` caches decrypted Deepgram/ElevenLabs/Twilio service instances per-tenant with a fixed 10-minute TTL. The existing `invalidate(tenantId)` method is only called from test code.

**Migration action:** Wire Auth Profile rotation events (via the same Redis pub/sub channel used for `RuntimeSecretsProvider` cache invalidation) to also call `VoiceServiceFactory.invalidate(tenantId)`.

### OrgProxyConfig Multi-Credential Strategy [Phase 2]

One `OrgProxyConfig` with fields for multiple auth types (e.g., bearer token + mTLS certs populated simultaneously) creates multiple Auth Profiles (one per auth type), linked via a `groupId` field on the Auth Profiles. The `OrgProxyConfig.authProfileId` references the primary auth profile; additional profiles in the group are resolved via `groupId` at runtime.

---

## 18. Test Infrastructure [Phase 1]

### Shared `AuthProfile` Mock Factory

Add a shared mock factory to avoid duplicating `AuthProfile` mock construction across 400+ runtime test files:

```typescript
// packages/test-helpers/src/auth-profile-factory.ts
export function makeAuthProfile(overrides?: Partial<IAuthProfile>): IAuthProfile;
export function makeDecryptedCredentials(authType: string): DecryptedCredentials;
```

This follows the existing `makeToolSecret()` / `makeLLMCredential()` patterns.

---

## 19. Deferred Auth Types (Phase 3+)

The following 5 auth types and 2 addon layers are deferred to Phase 3+ based on zero codebase usage and no current customer requirements. They are documented here for completeness and to ensure the core schema accommodates future extension.

**Rationale for deferral:** None of these auth types are referenced by any existing connector, tool, worker, or integration in the codebase. Adding them prematurely introduces unused dependencies (some with native C++ bindings), increases the security audit surface, and delays delivery of the core connector OAuth flow.

### Deferred Auth Types

| `authType`    | `config` (summary)                                                    | `encryptedSecrets`                                     | Library                | Deferral Reason                                              |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------ |
| `digest`      | `algorithm`, `qop?`, `realm?`, `opaque?`                              | `username`, `password`                                 | `digest-fetch` (lazy)  | Zero codebase usage                                          |
| `kerberos`    | `realm`, `kdcHost`, `kdcPort`, `servicePrincipal`, `spnegoEnabled`    | `keytab` (base64), `principal?`, `password?`           | `kerberos` (npm)       | Zero usage, native C++ bindings, Docker build changes needed |
| `saml`        | `entityId`, `idpEntityId`, `idpSsoUrl`, `assertionConsumerServiceUrl` | `idpCertificate`, `spPrivateKey?`, `spCertificate?`    | `@node-saml/node-saml` | Only inbound SSO exists; no outbound SAML evidence           |
| `hawk`        | `algorithm`, `ext?`, `dlg?`, `timestampSkewSec?`                      | `id`, `key`                                            | `@hapi/hawk`           | Zero codebase usage                                          |
| `ws_security` | `mode`, `passwordType?`, `addTimestamp?`, `signatureAlgorithm?`       | `username?`, `password?`, `privateKey?`, `publicCert?` | `soap`                 | Zero usage, ~8MB dependency                                  |

### Deferred Addons

| Addon                | Description                                              | Deferral Reason                                                      |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `certificatePinning` | SPKI SHA-256 fingerprint pinning with strict/report-only | Zero codebase usage, breaks standard TLS cert rotation operationally |
| `jwtWrapping`        | Client-signed JWT generation from private key            | Zero current usage, real pattern but no customer requirement         |

### Deferred Request Application (for reference)

| `authType`    | Request Mutation                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `digest`      | Uses `digest-fetch` as HTTP client wrapper. Initial unauthenticated request then 401 then resubmit. |
| `kerberos`    | Obtain service ticket, base64-encode GSSAPI/SPNEGO token, set `Authorization: Negotiate`.           |
| `saml`        | Obtain SAML assertion from IdP, set `Authorization: SAML` + base64(assertion).                      |
| `hawk`        | Compute MAC via `@hapi/hawk`. Set `Authorization: Hawk id="...", ts="...", nonce="...", mac="..."`. |
| `ws_security` | Modifies SOAP envelope XML via `soap` library `setSecurity()`. Not applicable to REST HTTP calls.   |

### Deferred Token Refresh Strategies

| Auth Type  | Refresh Strategy                                                                            |
| ---------- | ------------------------------------------------------------------------------------------- |
| `kerberos` | Service tickets (8-10h TTL, renewable to 7d). Cache in Redis. Re-obtain from KDC on expiry. |
| `saml`     | SAML assertions have `NotOnOrAfter` TTL. Obtain fresh assertion from IdP. Cache in Redis.   |

### Deferred Invalid Combinations

| Combination                    | Reason                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `ws_security` + any HTTP addon | `ws_security` operates on SOAP XML, not HTTP; HTTP-layer addons are irrelevant |
| `ssh_key` + `jwtWrapping`      | SSH key is not used in HTTP requests                                           |

### Library Packaging Recommendation

Deferred libraries (`soap`, `kerberos`, `@node-saml/node-saml`, `@hapi/hawk`, `digest-fetch`) should be packaged in an optional `packages/auth-enterprise` workspace package. This avoids:

- Security audit surface for 5 additional libraries in the core platform
- Docker build changes for native bindings (`kerberos` requires `libkrb5-dev`)
- ~8MB+ dependency weight from `soap` in builds that do not use SOAP

---

## 20. Environment Variables

### New Variables

| Variable                                    | Required By                      | Default | Purpose                                 |
| ------------------------------------------- | -------------------------------- | ------- | --------------------------------------- |
| `AUTH_PROFILE_ENABLED`                      | Studio, Runtime, Search-AI, etc. | `false` | Feature flag for migration rollout      |
| `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS` | Runtime                          | `60`    | Configurable buffer before token expiry |

### Obsolete After Migration (Phase 4)

- `OAUTH_PROVIDER_<NAME>_CLIENT_ID/SECRET` (Studio) → replaced by `oauth2_app` Auth Profile
- `CHANNEL_OAUTH_SLACK_*`, `CHANNEL_OAUTH_MSTEAMS_*`, `CHANNEL_OAUTH_META_*` (Runtime, 11 vars) → replaced by `oauth2_app` Auth Profile
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `AZURE_OPENAI_*` (Runtime) → replaced by Auth Profile

### Stays Unchanged

- `ENCRYPTION_MASTER_KEY` — Auth Profile depends on this
- `JWT_SECRET`, `INTERNAL_API_KEY`, `SANDBOX_JWT_SECRET` — inter-service auth
- `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `NEXTAUTH_*` — platform login
- Voice service vars (Twilio, Deepgram, ElevenLabs, LiveKit — 16 vars)
- Vault config (`VAULT_ADDR`, `VAULT_TOKEN`, etc.)

### Encryption Key Rotation Prerequisite

The `EncryptionService` in `packages/shared/src/encryption/index.ts` currently supports only a single master key. Before Auth Profile rotation features (`previousEncryptedSecrets`, `rotationGracePeriodMs`) can work, `EncryptionService` must be extended to support multiple key versions:

```typescript
interface EncryptionServiceConfig {
  current: { version: number; key: string };
  previous?: { version: number; key: string }[];
}
```

This is a prerequisite for Phase 2 of the migration.
