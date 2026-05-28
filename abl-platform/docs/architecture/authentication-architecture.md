# Authentication Architecture — ABL Platform

> Comprehensive reference for all authentication and authorization features across the platform.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Platform Authentication (User Identity)](#2-platform-authentication-user-identity)
3. [RBAC & Permissions](#3-rbac--permissions)
4. [Auth Profiles — Unified Credential Store](#4-auth-profiles--unified-credential-store)
5. [Connector Connections — Activepieces Workflow Auth](#5-connector-connections--activepieces-workflow-auth)
6. [Tool OAuth — Runtime Agent Tool Auth](#6-tool-oauth--runtime-agent-tool-auth)
7. [Channel Connections — Messaging Channel Auth](#7-channel-connections--messaging-channel-auth)
8. [MCP Server Auth](#8-mcp-server-auth)
9. [Search-AI Connector Auth — Enterprise Data Connectors](#9-search-ai-connector-auth--enterprise-data-connectors)
10. [API Keys](#10-api-keys)
11. [Device Auth — OAuth 2.0 Device Flow](#11-device-auth--oauth-20-device-flow)
12. [Encryption & Key Management](#12-encryption--key-management)
13. [Database Collections Reference](#13-database-collections-reference)
14. [Feature Interconnection Map](#14-feature-interconnection-map)

---

## 1. Architecture Overview

The platform has **four layers** of authentication, each serving a different purpose:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Layer 1: Platform Auth — WHO is the caller?                             │
│  ─────────────────────────────────────────────                           │
│  JWT (user login) │ SDK Session (channel user) │ API Key (programmatic)  │
│  SSO (OIDC/SAML)  │ Social Login (Google/MS)   │ MFA (TOTP)             │
│  Device Auth (CLI) │                                                     │
│                    ↓ produces TenantContextData                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Layer 2: RBAC — WHAT can the caller do?                                 │
│  ────────────────────────────────────────                                │
│  RoleDefinition (inheritance chain) + ResourcePermission (time-scoped)   │
│  requirePermission() │ requireProjectScope() │ requirePlatformAdmin()    │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Layer 3: Auth Profiles — Centralized Credential Store                   │
│  ─────────────────────────────────────────────────────                   │
│  17 auth types │ oauth2_app ←→ oauth2_token parent-child                 │
│  Consumed by: Tools, Channels, MCP Servers, Search-AI Connectors         │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  Layer 4: Integration Auth — Credentials for third-party services        │
│  ────────────────────────────────────────────────────────────            │
│  Connector Connections (Activepieces) │ Channel Connections               │
│  MCP Server Auth │ Search-AI Connector Configs                           │
│  Tool OAuth (end-user + session tokens)                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Platform Authentication (User Identity)

### Unified Auth Middleware

The central entry point is `createUnifiedAuthMiddleware()` in `packages/shared-auth/src/middleware/unified-auth.ts`. It dispatches incoming requests to one of three authentication flows:

| Auth Flow       | Header                        | Model/Collection           | Token Type                                      |
| --------------- | ----------------------------- | -------------------------- | ----------------------------------------------- |
| **User JWT**    | `Authorization: Bearer <jwt>` | `users` + `refresh_tokens` | Access JWT (`sub`, `email`, `tenantId`, `role`) |
| **SDK Session** | `X-SDK-Token: <token>`        | Session store              | Session token (identity tiers 0/1/2)            |
| **API Key**     | `Authorization: Bearer abl_*` | `api_keys`                 | Hash-verified key with scopes                   |

All three flows converge into `TenantContextData` stored in `AsyncLocalStorage`, which is propagated through the request lifecycle and consumed by MongoDB tenant-isolation plugins and audit services.

### Auth Context (Discriminated Union)

```
packages/shared-auth/src/types/auth-context.ts
```

| Context Type            | `authType`    | Key Fields                                         |
| ----------------------- | ------------- | -------------------------------------------------- |
| `PlatformMemberContext` | `user`        | userId, role, isSuperAdmin                         |
| `ChannelUserContext`    | `sdk_session` | projectId, channelId, callerIdentity               |
| `ApiKeyContext`         | `api_key`     | apiKeyId, clientId, projectScope, environmentScope |

### Login & Identity Providers

| Provider            | Routes                                                              | Model Fields                                   |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| **Email/Password**  | `/api/auth/login`, `/signup`, `/forgot-password`, `/reset-password` | `user.password` (bcrypt), `user.emailVerified` |
| **Google OAuth**    | `/api/auth/google`, `/api/auth/callback`                            | `user.googleId`, `user.authProvider='google'`  |
| **Microsoft OAuth** | `/api/auth/microsoft`, `/api/auth/microsoft/callback`               | `user.authProvider`                            |
| **LinkedIn OAuth**  | `/api/auth/linkedin`, `/api/auth/linkedin/callback`                 | `user.authProvider`                            |
| **SSO (OIDC)**      | `/api/sso/init`, `/api/sso/oidc/callback`, `/api/sso/exchange`      | Organization SSO domain config                 |
| **SSO (SAML)**      | `/api/sso/init`, `/api/sso/saml/callback`, `/api/sso/exchange`      | Organization SSO domain config                 |

### MFA (Multi-Factor Authentication)

- **Type:** TOTP (Time-based One-Time Password)
- **Flow:** Setup → Confirm enrollment → Login produces `mfa_pending` JWT → Verify TOTP → Upgrade to `access` JWT
- **Storage:** `user.mfa.encryptedSecret`, `user.mfa.recoveryCodes[]`
- **Protection:** Failed attempt tracking, auto-lockout (`mfa.lockThreshold`, `mfa.lockDurationMs`)
- **Routes:** `/api/mfa/setup`, `/api/mfa/confirm`, `/api/mfa/verify`, `/api/mfa/disable`, `/api/mfa/recovery`

### Token Lifecycle

```
Login/SSO/Social → access JWT (short-lived) + refresh token (httpOnly cookie)
                                                        │
                                        refresh_tokens collection
                                        (family rotation detection)
                                                        │
                                        POST /api/auth/refresh → new access JWT
```

- **Refresh tokens** use family-based rotation: each family has a `generation` counter. Reuse of an older generation triggers revocation of the entire family (compromise detection).
- **Configuration:** `packages/config/src/schemas/auth.schema.ts` — bcrypt cost, password history, lockout policy, token TTLs, rate limits per endpoint.

---

## 3. RBAC & Permissions

### Models

| Collection             | Purpose                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `role_definitions`     | Named roles with `permissions[]` string array and `parentRoleId` inheritance chain                  |
| `resource_permissions` | Per-user grants on specific resources with expiry (`tenantId + userId + resourceType + resourceId`) |
| `project_members`      | Project-level membership and role assignment                                                        |

### Permission Format

Permissions are strings in the format `resource:operation` with wildcard support:

- `projects:read` — read access to projects
- `agents:*` — all operations on agents
- `*:*` — superadmin (all permissions)

### Resolution Flow

```
Request arrives
    │
    ▼
Unified Auth Middleware → resolves identity
    │
    ▼
resolveRolePermissions(roleId)
    → walks parentRoleId inheritance chain
    → merges all permissions[]
    │
    ▼
mergeResourcePermissions(userId, tenantId)
    → adds time-scoped grants from resource_permissions
    │
    ▼
Permission Guards (middleware):
    requirePermission('agents:create')
    requireAllPermissions(['projects:read', 'agents:read'])
    requireAnyPermission(['agents:create', 'agents:update'])
    requireProjectScope('projectId')        ← API key project restriction
    requireEnvironmentScope('environment')  ← API key env restriction
    requirePlatformAdmin()                  ← super-admin only
    requirePlatformAdminIp(getAllowedIps)   ← IP allowlist
```

### Session Ownership

For SDK/channel users, session ownership is enforced via identity tiers:

- **Tier 2:** `customerId` (strongest — authenticated end user)
- **Tier 1:** `channelArtifact` (channel-specific identifier)
- **Tier 0:** session principal (weakest — anonymous)

SDK users only see their own sessions; platform admins see all.

---

## 4. Auth Profiles — Unified Credential Store

### Overview

Auth Profiles are the **centralized credential store** used across the platform. They live in the `auth_profiles` collection and support 17 authentication types across 3 phases.

```
packages/shared-auth-profile/    — Core logic (apply-auth, token refresh, validation)
packages/database/src/models/auth-profile.model.ts  — MongoDB model
```

### Auth Types

| Phase | Auth Type                   | What It Stores                      | Applied As                              |
| ----- | --------------------------- | ----------------------------------- | --------------------------------------- |
| 1     | `none`                      | Nothing                             | No-op                                   |
| 1     | `api_key`                   | API key                             | `Authorization` header or query param   |
| 1     | `bearer`                    | Bearer token                        | `Authorization: Bearer <token>`         |
| 1     | `oauth2_app`                | **Client ID + Secret** (parent)     | Not applied directly — Layer 1 only     |
| 1     | `oauth2_token`              | **Access + Refresh tokens** (child) | `Authorization: Bearer <accessToken>`   |
| 1     | `oauth2_client_credentials` | Machine-to-machine token            | `Authorization: Bearer <accessToken>`   |
| 2     | `basic`                     | Username + password                 | `Authorization: Basic <base64>`         |
| 2     | `custom_header`             | Custom header key-value pairs       | Multiple custom headers                 |
| 2     | `aws_iam`                   | AWS access key + secret             | SigV4 signing (downstream)              |
| 2     | `azure_ad`                  | Azure client ID + secret            | Azure AD token acquisition (downstream) |
| 2     | `mtls`                      | Client cert + key + CA              | TLS options (downstream)                |
| 2     | `ssh_key`                   | Private key + passphrase            | SSH connection (downstream)             |
| 3     | `digest`                    | Username + password + realm         | HTTP Digest auth (downstream)           |
| 3     | `kerberos`                  | Principal + KDC config              | SPNEGO ticket (downstream)              |
| 3     | `saml`                      | IDP metadata + signing cert         | SAML assertion (downstream)             |
| 3     | `hawk`                      | ID + key + algorithm                | Hawk MAC signing (downstream)           |
| 3     | `ws_security`               | Username + password + cert          | SOAP WS-Security header (downstream)    |

### The oauth2_app ↔ oauth2_token Parent-Child Pattern

This is the most important pattern in the credential store. Both live in `auth_profiles` but serve different roles:

```
auth_profiles collection
┌─────────────────────────────────────────────────────────────────┐
│  authType: "oauth2_app"           (PARENT — app registration)   │
│  ───────────────────────                                        │
│  _id: "ap-google-app-001"                                       │
│  config: {                                                      │
│    authorizationUrl: "https://accounts.google.com/o/oauth2/..." │
│    tokenUrl: "https://oauth2.googleapis.com/token"              │
│    defaultScopes: ["calendar.readonly"]                         │
│  }                                                              │
│  encryptedSecrets → { clientId, clientSecret }                  │
│                                                                 │
│         ▲ linkedAppProfileId                                    │
│         │                                                       │
│  authType: "oauth2_token"         (CHILD — user's tokens)       │
│  ────────────────────────                                       │
│  _id: "ap-google-token-john"                                    │
│  linkedAppProfileId: "ap-google-app-001"                        │
│  config: {                                                      │
│    issuedAt: "2026-04-01T12:00:00Z"                             │
│    expiresAt: "2026-04-01T13:00:00Z"                            │
│  }                                                              │
│  encryptedSecrets → { accessToken, refreshToken }               │
└─────────────────────────────────────────────────────────────────┘
```

**Token Refresh Flow** (`packages/shared-auth-profile/src/token-refresh-service.ts`):

1. Load `oauth2_token` profile → parse `encryptedSecrets` → get `refreshToken`
2. Follow `linkedAppProfileId` → load `oauth2_app` parent → decrypt → get `clientId`, `clientSecret`, `tokenUrl`
3. Acquire distributed Redis lock (prevent concurrent refresh across pods)
4. POST `grant_type=refresh_token` using parent's client credentials
5. Update `oauth2_token` profile in-place with new tokens + expiry
6. Release lock

### Scoping & Visibility

| Field         | Values               | Purpose                            |
| ------------- | -------------------- | ---------------------------------- |
| `scope`       | `tenant`, `project`  | Where the credential is accessible |
| `visibility`  | `shared`, `personal` | Who can use it                     |
| `projectId`   | string or null       | null = tenant-scoped               |
| `createdBy`   | userId (immutable)   | Owner for personal visibility      |
| `environment` | string or null       | Environment-specific credentials   |

### Addon Mechanisms (Phase 2/3)

| Addon                 | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `signing`             | Request signing for outgoing calls                |
| `webhookVerification` | Verify inbound webhook signatures                 |
| `proxy`               | Route through proxy with credentials              |
| `certificatePinning`  | Pin TLS certificates for downstream calls         |
| `jwtWrapping`         | Wrap credentials in a JWT for downstream services |

### Consumers

Auth Profiles are consumed by **four downstream systems** via `authProfileId`:

| Consumer                 | How It References Auth Profiles                                 |
| ------------------------ | --------------------------------------------------------------- |
| **Runtime Tools**        | `auth_profile_ref` in compiled IR → resolved by name at runtime |
| **Channel Connections**  | `channel_connections.authProfileId` field                       |
| **MCP Servers**          | `mcp_server_configs.authProfileId` field                        |
| **Search-AI Connectors** | `connector_configs.authProfileId` field                         |

---

## 5. Connector Connections — Activepieces Workflow Auth

### Overview

Connector Connections store credentials for **Activepieces-based workflow connectors** (Slack, GitHub, Salesforce, etc. — 25 connectors). They live in the `connector_connections` collection.

### How Activepieces Interfaces with the Connector System

AP pieces are wrapped into the platform's `Connector` interface at boot time:

```
@activepieces/piece-slack (npm package)
    │ require() at boot
    ▼
extractPieceFromExport()           ← runtime-adapter.ts
    │
    ▼
wrapActivepiecesPiece("slack", module)
    │
    ├── mapAuth(piece.auth)        ← type-mapper.ts
    │   AP OAUTH2      → ConnectorAuth { type: 'oauth2', oauth2: {...} }
    │   AP SECRET_TEXT  → ConnectorAuth { type: 'api_key' }
    │   AP BASIC        → ConnectorAuth { type: 'basic' }
    │   AP CUSTOM_AUTH  → ConnectorAuth { type: 'custom' }
    │
    ├── createRuntimeAction(apAction)  ← runtime-adapter.ts
    │   Maps AP properties → ConnectorProperty[]
    │   Wraps run() with translateActionContext()
    │
    └── mapTrigger(apTrigger)      ← type-mapper.ts
        AP WEBHOOK → strategy: 'webhook'
        AP POLLING → strategy: 'polling'
    │
    ▼
Connector { name, displayName, auth, actions[], triggers[] }
    │
    ▼
ConnectorRegistry (in-memory Map, max 500)
    │
    ▼
Consumed by: Runtime (agent tools) / Workflow Engine / Studio UI
```

### Credential Storage

`connector_connections` can store credentials in **two ways**:

**Option A — Self-contained credentials:**

```json
{
  "_id": "conn-slack-001",
  "connectorName": "slack",
  "authType": "oauth2",
  "encryptedCredentials": "...",
  "oauth2RefreshToken": "...",
  "oauth2Provider": "slack",
  "oauth2TokenExpiresAt": "2026-04-01T14:30:00Z",
  "authProfileId": null
}
```

**Option B — Delegated to Auth Profile:**

```json
{
  "_id": "conn-slack-002",
  "connectorName": "slack",
  "authType": "oauth2",
  "encryptedCredentials": "",
  "authProfileId": "ap-slack-app-001"
}
```

### OAuth2 Flow for Connector Connections

```
Studio UI: CreateConnectionModal → OAuthFlowDialog
    │
    ▼
POST /api/projects/:id/connections/oauth/initiate
    → Map connector → provider (e.g., gmail → google)
    → Load OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID/_SECRET from env
    → Generate 32-byte random state (CSRF)
    → Store pending state in memory (10-min TTL)
    → Return authUrl
    │
    ▼
Popup window → provider consent screen → user authorizes
    │
    ▼
Redirect to /oauth/connection-callback
    → Extract code + state
    → postMessage to parent window → popup closes
    │
    ▼
POST /api/projects/:id/connections/oauth/callback
    → Consume pending state (atomic get-and-delete for CSRF)
    → Exchange code for tokens at provider's tokenUrl
    → ConnectionService.create() → empty credentials
    → ConnectionService.completeOAuthSetup()
      → Encrypt accessToken (AES-256-GCM, tenant-derived key)
      → Encrypt refreshToken separately
      → Store oauth2Provider, oauth2TokenExpiresAt, scopes
```

### Runtime Credential Resolution

```
Agent calls tool "slack.send_message"
    │
    ▼
ConnectorToolExecutor.execute()
    │
    ▼
ConnectionResolver.resolve(connectorName, tenantId, projectId, userId)
    Priority: 1. Specific connectionId
              2. User-scoped connection (scope='user', userId match)
              3. Tenant-scoped connection (scope='tenant')
    │
    ▼
ConnectionResolver.resolveAuth(connection)
    │
    ├── connection.authProfileId is set?
    │   YES → AuthProfileResolver.resolve()
    │         → returns decrypted credentials from auth_profiles
    │
    ├── connection.authType === 'oauth2' && token expiring (within 60s)?
    │   YES → refreshOAuth2(connection)
    │         → Distributed lock (Redis SET NX PX, 30s TTL)
    │         → Decrypt oauth2RefreshToken
    │         → Load client creds from env vars
    │         → Lookup provider config from ProviderConfigRegistry (600+ providers via Nango)
    │         → POST grant_type=refresh_token
    │         → On failure: mark connection 'expired'
    │         → On success: encrypt new tokens, persist, release lock
    │
    └── otherwise
        → Decrypt encryptedCredentials directly
    │
    ▼
translateActionContext(platformCtx → APActionContext)
    auth: { accessToken: "xoxb-..." }  →  APActionContext.auth
    params: { channel, text }          →  APActionContext.propsValue
    store: KeyValueStore               →  APActionContext.store (get/put/delete)
    │
    ▼
AP piece action's run() executes with real credentials
```

---

## 6. Tool OAuth — Runtime Agent Tool Auth

### Overview

`ToolOAuthService` (`apps/runtime/src/services/tool-oauth-service.ts`) manages OAuth 2.0 flows for **agent tools** — when an AI agent needs to access a third-party service on behalf of a user during a conversation.

This is **separate from Connector Connections**. Tool OAuth handles per-user/per-session consent flows during runtime, while Connector Connections are pre-configured admin-level credentials.

### Two Token Storage Collections

| Collection                | Scope                                                              | Lifetime                                 | Use Case                                         |
| ------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------ |
| `end_user_oauth_tokens`   | Per durable user (`tenantId + userId + provider`)                  | Persistent, cross-session                | Logged-in user authorizes Google Calendar        |
| `session_oauth_artifacts` | Per session (`tenantId + projectId + sessionPrincipal + provider`) | Ephemeral, TTL auto-deletes with session | Anonymous web visitor authorizes Microsoft Graph |

### JIT (Just-In-Time) Auth Flow

When an agent needs tool access that requires user consent:

```
1. Agent calls tool with auth_profile_ref (e.g., "Google Calendar OAuth App")
    │
    ▼
2. resolve-tool-auth.ts: resolveToolAuth()
   → resolveByName(authProfileRef) → finds auth_profiles with authType='oauth2_app'
   → resolveOAuth2AppCredentials() → decrypts { clientId, clientSecret }
    │
    ▼
3. Check: Does user already have a valid token?
   → ToolOAuthService.getAccessToken() looks in:
     a. end_user_oauth_tokens (for logged-in users)
     b. session_oauth_artifacts (for session users)
   → If found and not expired → return token → tool executes
    │
    ▼
4. No valid token → JIT auth kicks in
   → auth-profile-tool-middleware.ts detects jit_auth: true
   → Sends auth_challenge to client with authUrl
   → Pauses tool execution
    │
    ▼
5. Client opens consent popup → user authorizes at provider
    │
    ▼
6. ToolOAuthService.handleOAuthCallback()
   → Exchange code for tokens using clientId/secret from auth_profiles
   → Determine principal scope:
     ├── 'user' → store in end_user_oauth_tokens
     └── 'session' → store in session_oauth_artifacts
    │
    ▼
7. Tool execution resumes with decrypted accessToken
```

### Auth Preflight

At **session start**, before any tool calls, the runtime performs auth preflight (`auth-preflight.ts`):

1. Extract auth requirements from compiled agent IR
2. Check existing tokens via `ConsentStateResolver`
3. If tokens are missing and `jit_auth` is not enabled → block session with `auth_gate: pending`
4. If `jit_auth` is enabled → allow session to proceed, consent will be requested on first tool call

### Provider Key Strategy

Token provider keys in `end_user_oauth_tokens` and `session_oauth_artifacts` use the format `auth-profile:<authProfileId>` (e.g., `auth-profile:ap-google-cal-001`). This ensures tokens are stable even if the auth profile is renamed.

---

## 7. Channel Connections — Messaging Channel Auth

### Overview

Channel Connections store credentials for **messaging channels** — how the platform connects to Slack, Teams, WhatsApp, etc. to send/receive messages.

**Collection:** `channel_connections`

### Supported Channel Types

`http_async`, `slack`, `line`, `email`, `msteams`, `vxml`, `voice_vxml`, `korevg`, `audiocodes`, `whatsapp`, `messenger`, `instagram`, `twilio_sms`, `voice_realtime`, `voice_pipeline`, `voice_twilio`, `ag_ui`, `a2a`, `zendesk`, `telegram`, `genesys`

### Auth Fields

| Field                  | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `encryptedCredentials` | Inline encrypted credentials (encryption plugin)               |
| `authProfileId`        | Optional — delegates credentials to an Auth Profile            |
| `verifyTokenHash`      | Webhook verification token hash (for inbound webhook dispatch) |

### Two Auth Strategies

**Strategy A — Inline credentials:**

```json
{
  "channelType": "slack",
  "encryptedCredentials": "...",
  "authProfileId": null
}
```

**Strategy B — Auth Profile delegation:**

```json
{
  "channelType": "msteams",
  "encryptedCredentials": null,
  "authProfileId": "ap-teams-bot-001"
}
```

---

## 8. MCP Server Auth

### Overview

MCP (Model Context Protocol) servers can authenticate to external services. Auth configuration is stored on the `mcp_server_configs` collection.

### Auth Fields

| Field                 | Type                                                                       | Purpose                              |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `authType`            | `none`, `bearer`, `api_key`, `custom_headers`, `oauth2_client_credentials` | Auth strategy                        |
| `encryptedAuthConfig` | String (encrypted)                                                         | Inline encrypted credentials         |
| `authProfileId`       | String                                                                     | Optional — delegates to Auth Profile |

### Auth Resolution (Three Strategies)

| Strategy         | How                                                       |
| ---------------- | --------------------------------------------------------- |
| **No auth**      | `authType: 'none'`                                        |
| **Inline**       | Decrypt `encryptedAuthConfig` → apply based on `authType` |
| **Auth Profile** | Resolve `authProfileId` from `auth_profiles` collection   |

---

## 9. Search-AI Connector Auth — Enterprise Data Connectors

### Overview

Enterprise data connectors (SharePoint, Jira, Confluence, HubSpot, ServiceNow, Salesforce) use a **dual auth strategy** representing a migration from direct OAuth to the unified Auth Profile system.

**Collection:** `connector_configs`

### Auth Fields

| Field                       | Purpose                                | Status           |
| --------------------------- | -------------------------------------- | ---------------- |
| `oauthTokenId`              | References `end_user_oauth_tokens._id` | Legacy path      |
| `authProfileId`             | References `auth_profiles._id`         | New unified path |
| `connectionConfig.clientId` | OAuth client ID (inline)               | Legacy config    |
| `connectionConfig.scopes[]` | OAuth scopes                           | Legacy config    |

### Resolution Priority

```
connector_configs document
    │
    ├── authProfileId is set?
    │   YES → resolve from auth_profiles (unified path)
    │
    └── oauthTokenId is set?
        YES → resolve from end_user_oauth_tokens (legacy path)
              → decrypt encryptedAccessToken / encryptedRefreshToken
```

### Security Features

- **Security overview:** Blast radius analysis per connector
- **Emergency revoke:** Revoke all tokens for a connector immediately
- **Security export:** Export connector security posture (JSON/YAML/Markdown)
- Routes: `/api/search-ai/connectors/:id/security/*`

---

## 10. API Keys

### Two Flavors

| Collection        | Prefix  | Purpose                           | Resolved In             |
| ----------------- | ------- | --------------------------------- | ----------------------- |
| `api_keys`        | `abl_*` | Server-side programmatic access   | Unified auth middleware |
| `public_api_keys` | varies  | Client-side SDK channel bootstrap | Origin allowlisting     |

### Server-Side API Keys (`api_keys`)

```json
{
  "_id": "key-001",
  "tenantId": "tenant-acme",
  "name": "Production API Key",
  "clientId": "client-prod-001",
  "keyHash": "sha256:...",
  "prefix": "abl_pk_",
  "scopes": ["agents:read", "agents:execute"],
  "projectIds": ["proj-support"],
  "environments": ["production"],
  "expiresAt": "2027-01-01T00:00:00Z",
  "createdBy": "user-admin",
  "revokedAt": null
}
```

- **Scoping:** `scopes[]` restrict what operations the key can perform; `projectIds[]` and `environments[]` restrict where
- **Resolution:** Hash-based lookup in unified auth middleware → produces `ApiKeyContext`

### Public API Keys (`public_api_keys`)

```json
{
  "_id": "pubkey-001",
  "projectId": "proj-support",
  "keyPrefix": "pk_live_",
  "keyHash": "sha256:...",
  "allowedOrigins": ["https://acme.com", "https://app.acme.com"],
  "permissions": { "channels": ["http_async", "ag_ui"] },
  "expiresAt": "2027-01-01T00:00:00Z",
  "isActive": true
}
```

- **Origin allowlisting:** Restricts which browser origins can use the key
- **Purpose:** Client-side SDK initialization for channel bootstrapping

---

## 11. Device Auth — OAuth 2.0 Device Flow

### Overview

Implements RFC 8628 (OAuth 2.0 Device Authorization Grant) for headless/CLI clients that cannot open a browser directly.

**Collection:** `device_auth_requests`

### Flow

```
1. CLI client → POST /api/auth/device/authorize
   → Returns { deviceCode, userCode, verificationUri, expiresIn }

2. CLI displays: "Go to https://app.acme.com/device and enter code: ABCD-1234"

3. CLI polls → POST /api/auth/device/token { deviceCode }
   → Returns "authorization_pending" until user completes step 4

4. User opens browser → enters userCode → logs in → authorizes
   → device_auth_requests.userId is set, authorizedAt is populated

5. CLI poll succeeds → returns JWT tokens → CLI is authenticated

6. device_auth_requests entry auto-expires (TTL index on expiresAt)
```

### Document Example

```json
{
  "_id": "dar-001",
  "deviceCode": "a1b2c3d4...",
  "userCode": "ABCD-1234",
  "scopes": ["agents:read", "agents:execute"],
  "expiresAt": "2026-04-01T12:15:00Z",
  "userId": null,
  "authorizedAt": null,
  "consumedAt": null
}
```

---

## 12. Encryption & Key Management

### Encryption Engine

**Package:** `packages/shared-encryption/`

| Property           | Value                                     |
| ------------------ | ----------------------------------------- |
| **Algorithm**      | AES-256-GCM                               |
| **IV**             | 12 bytes (96-bit, NIST SP 800-38D)        |
| **Auth Tag**       | 16 bytes                                  |
| **Key Length**     | 32 bytes (256-bit)                        |
| **Master Key**     | 64 hex chars                              |
| **Storage Format** | `<iv_hex>:<authTag_hex>:<ciphertext_hex>` |

### Tenant-Scoped Key Derivation

Each tenant gets a unique encryption key derived via:

```
PBKDF2(masterKey + "tenant:<tenantId>", 100,000 iterations, SHA-256) → 256-bit key
```

Derived keys are cached (max 1000 entries, 30-min TTL).

### Envelope Encryption (DEK/KEK)

For higher security requirements, the platform supports envelope encryption:

| Collection           | Purpose                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `dek_registry`       | Per-tenant/project/environment Data Encryption Keys (DEKs) wrapped by KEKs      |
| `key_versions`       | Encryption key version tracking (active, decrypt_only, destroyed)               |
| `tenant_kms_configs` | Per-tenant KMS provider config (local, AWS KMS, Azure Key Vault, GCP Cloud KMS) |

### What Uses Encryption

| Feature                                        | Encryption Method                                 |
| ---------------------------------------------- | ------------------------------------------------- |
| `auth_profiles.encryptedSecrets`               | Mongoose encryption plugin (auto-encrypt/decrypt) |
| `connector_connections.encryptedCredentials`   | Manual via ConnectionService (not plugin)         |
| `connector_connections.oauth2RefreshToken`     | Manual via ConnectionService                      |
| `end_user_oauth_tokens.encryptedAccessToken`   | Mongoose encryption plugin                        |
| `end_user_oauth_tokens.encryptedRefreshToken`  | Mongoose encryption plugin                        |
| `session_oauth_artifacts.encryptedAccessToken` | Mongoose encryption plugin                        |
| `channel_connections.encryptedCredentials`     | Mongoose encryption plugin                        |
| `mcp_server_configs.encryptedAuthConfig`       | Mongoose encryption plugin                        |
| `user.mfa.encryptedSecret`                     | Mongoose encryption plugin                        |

---

## 13. Database Collections Reference

### Auth & Identity Collections

| #   | Collection             | Purpose                    | Encryption          | TTL                  |
| --- | ---------------------- | -------------------------- | ------------------- | -------------------- |
| 1   | `users`                | Platform user accounts     | Plugin (MFA secret) | No                   |
| 2   | `refresh_tokens`       | JWT refresh token families | No                  | Yes                  |
| 3   | `api_keys`             | Server-side API keys       | No                  | Optional (expiresAt) |
| 4   | `public_api_keys`      | Client-side SDK keys       | No                  | Optional (expiresAt) |
| 5   | `role_definitions`     | RBAC role definitions      | No                  | No                   |
| 6   | `resource_permissions` | Per-user resource grants   | No                  | Optional (expiresAt) |
| 7   | `project_members`      | Project membership         | No                  | No                   |
| 8   | `device_auth_requests` | Device auth flow state     | No                  | Yes (expiresAt)      |

### Credential Storage Collections

| #   | Collection                | Purpose                               | Encryption                                    | TTL                    |
| --- | ------------------------- | ------------------------------------- | --------------------------------------------- | ---------------------- |
| 9   | `auth_profiles`           | Unified credential store (17 types)   | Plugin (2 fields)                             | No                     |
| 10  | `end_user_oauth_tokens`   | Durable user-level OAuth tokens       | Plugin (2 fields)                             | No                     |
| 11  | `session_oauth_artifacts` | Ephemeral session OAuth tokens        | Plugin (2 fields)                             | Yes (sessionExpiresAt) |
| 12  | `connector_connections`   | Activepieces connector credentials    | Manual                                        | No                     |
| 13  | `channel_connections`     | Messaging channel credentials         | Plugin (1 field)                              | No                     |
| 14  | `mcp_server_configs`      | MCP server auth config                | Plugin (1 field)                              | No                     |
| 15  | `connector_configs`       | Search-AI enterprise connector config | No (auth via oauthTokenId/authProfileId refs) | No                     |

### Key Management Collections

| #   | Collection           | Purpose                                    |
| --- | -------------------- | ------------------------------------------ |
| 16  | `dek_registry`       | Data Encryption Keys (envelope encryption) |
| 17  | `key_versions`       | Encryption key lifecycle tracking          |
| 18  | `tenant_kms_configs` | Per-tenant KMS provider configuration      |

### Connector Support Collections

| #   | Collection                | Purpose                                            |
| --- | ------------------------- | -------------------------------------------------- |
| 19  | `connector_kv_store`      | AP piece state (cursors, dedup). TTL-indexed       |
| 20  | `trigger_registrations`   | Workflow trigger bindings (polling, webhook, cron) |
| 21  | `connector_audit_entries` | Immutable connector audit trail                    |

---

## 14. Feature Interconnection Map

```
                        ┌─────────────────┐
                        │  Platform Auth   │
                        │  (JWT/SSO/MFA)   │
                        └────────┬─────────┘
                                 │ produces TenantContextData
                                 ▼
                        ┌─────────────────┐
                        │  RBAC Engine     │
                        │  (Roles + Perms) │
                        └────────┬─────────┘
                                 │ gates all API access
                                 ▼
              ┌──────────────────────────────────────┐
              │         Auth Profiles                 │
              │    (Unified Credential Store)         │
              │                                       │
              │  oauth2_app ←── linkedAppProfileId    │
              │       │                               │
              │  oauth2_token (user's tokens)         │
              │  oauth2_client_credentials            │
              │  api_key / bearer / basic / ...       │
              └──┬──────┬──────┬──────┬──────────────┘
                 │      │      │      │
    ┌────────────┘      │      │      └──────────────┐
    ▼                   ▼      ▼                     ▼
┌──────────┐  ┌──────────┐ ┌──────────┐    ┌──────────────┐
│ Runtime  │  │ Channel  │ │ MCP      │    │ Search-AI    │
│ Tools    │  │ Conns    │ │ Servers  │    │ Connectors   │
│          │  │          │ │          │    │              │
│ resolve  │  │ authPro- │ │ authPro- │    │ authPro-     │
│ ToolAuth │  │ fileId   │ │ fileId   │    │ fileId (new) │
│          │  │          │ │          │    │ oauthToken-  │
│ ToolOAuth│  │ inline   │ │ inline   │    │ Id (legacy)  │
│ Service  │  │ creds    │ │ creds    │    │              │
└────┬─────┘  └──────────┘ └──────────┘    └──────────────┘
     │
     │ stores tokens in:
     ▼
┌─────────────────────────────────────────────┐
│  end_user_oauth_tokens (durable)            │
│  session_oauth_artifacts (ephemeral, TTL)   │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Connector Connections (Activepieces)        │
│  ─────────────────────────────────           │
│  Self-contained credentials OR               │
│  authProfileId delegation                    │
│                                              │
│  ConnectionResolver → resolveAuth()          │
│    → decrypt or delegate to AuthProfile      │
│    → OAuth2 token refresh with dist. lock    │
│    → translateActionContext() → AP piece run  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Encryption Layer                            │
│  ────────────────                            │
│  AES-256-GCM, tenant-scoped key derivation   │
│  DEK/KEK envelope encryption (optional)      │
│  Key rotation with fallback decryption       │
│  Per-tenant KMS provider support             │
└─────────────────────────────────────────────┘
```

### Key Relationships

| From                           | To                           | Via                                | Purpose                                        |
| ------------------------------ | ---------------------------- | ---------------------------------- | ---------------------------------------------- |
| `auth_profiles` (oauth2_token) | `auth_profiles` (oauth2_app) | `linkedAppProfileId`               | Child tokens reference parent app registration |
| `connector_connections`        | `auth_profiles`              | `authProfileId`                    | Delegate credential resolution                 |
| `channel_connections`          | `auth_profiles`              | `authProfileId`                    | Delegate credential resolution                 |
| `mcp_server_configs`           | `auth_profiles`              | `authProfileId`                    | Delegate credential resolution                 |
| `connector_configs`            | `auth_profiles`              | `authProfileId`                    | Delegate credential resolution (new path)      |
| `connector_configs`            | `end_user_oauth_tokens`      | `oauthTokenId`                     | Direct token reference (legacy path)           |
| `end_user_oauth_tokens`        | `auth_profiles` (oauth2_app) | provider key `auth-profile:<id>`   | Tokens keyed by parent app profile             |
| `session_oauth_artifacts`      | `auth_profiles` (oauth2_app) | `authProfileId` + `authProfileRef` | Session tokens linked to app profile           |
| `trigger_registrations`        | `connector_connections`      | `connectionId`                     | Trigger uses connection credentials            |
| `trigger_registrations`        | `auth_profiles`              | `authProfileId`                    | Trigger uses auth profile credentials          |

---

> **Document generated:** 2026-04-01
> **Source:** Architecture analysis of `abl-platform` codebase
