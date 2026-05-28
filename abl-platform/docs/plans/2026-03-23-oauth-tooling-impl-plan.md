# LLD + Implementation Plan: OAuth Tooling

**Date:** 2026-03-23
**Status:** PLANNED
**Feature Spec:** [oauth-tooling](../features/oauth-tooling.md)
**Test Spec:** [oauth-tooling](../testing/oauth-tooling.md)
**HLD:** [oauth-tooling.hld](../specs/oauth-tooling.hld.md)

---

## Phase 1: Auth Profile Integration for Tools (Non-Breaking)

**Goal:** Wire tool configuration to reference Auth Profiles, and wire runtime to resolve tool credentials from Auth Profiles.

**Duration:** 3 days

### 1.1 Extend ProjectTool Schema

**File:** `packages/shared/src/validation/project-tool-schemas.ts`

Add `authProfileId` and `oauthScopes` to the HTTP tool schema:

```typescript
// Add to CreateHttpToolSchema.extend({...})
authProfileId: z.string().min(1).optional(),  // Linked Auth Profile ID
oauthScopes: z.array(z.string().min(1)).max(20).optional(),  // OAuth scopes for this tool
```

**Notes:**

- Use `z.string().min(1)` for the `authProfileId` field (not `.cuid()` or `.uuid()`)
- Add cross-field validation: `authProfileId` required when `auth` is `oauth2_client` or `oauth2_user`
- Add to both `CreateHttpToolSchema` and `UpdateHttpToolSchema`

### 1.2 Extend ProjectTool Database Model

**File:** `packages/database/src/models/project-tool.model.ts`

Add fields to the Mongoose schema:

```typescript
authProfileId: { type: String, default: null, index: true },
oauthScopes: { type: [String], default: null },
```

**Index:** Compound index `{ projectId: 1, authProfileId: 1 }` for efficient lookup of tools using a specific auth profile.

### 1.3 Validate Auth Profile Link on Tool CRUD

**File:** `apps/studio/src/app/api/projects/[projectId]/tools/route.ts` (or equivalent)

On tool create/update, when `authProfileId` is provided:

1. Call `validateLinkedAppProfile({ linkedAppProfileId: authProfileId, tenantId })` from `packages/shared/src/services/auth-profile/linked-app-validator.ts`
2. Verify the Auth Profile belongs to the same project or is tenant-scoped
3. Return 404 if auth profile not found (cross-tenant isolation)
4. Return 400 if auth profile type is incompatible with tool auth type

### 1.4 Wire Runtime Auth Profile Resolution

**File:** `apps/runtime/src/services/secrets-provider.ts`

Extend `RuntimeSecretsProvider` to accept a tool-to-auth-profile mapping, loaded at session initialization from the ProjectTool documents:

```typescript
// New config field in RuntimeSecretsProviderConfig:
toolAuthProfileMap?: Map<string, string>;  // toolName -> authProfileId

// In RuntimeSecretsProvider, add method:
private async resolveToolAuthProfile(
  toolName: string,
): Promise<Record<string, string> | undefined> {
  if (!this.authProfileResolver || !this.tenantId || !this.projectId) {
    return undefined;
  }

  const authProfileId = this.toolAuthProfileMap?.get(toolName);
  if (!authProfileId) return undefined;

  const profile = await this.authProfileResolver.resolveBySecretKey({
    tenantId: this.tenantId,
    projectId: this.projectId,
    secretKey: authProfileId,
    environment: this.environment ?? 'default',
  });

  if (!profile) return undefined;
  return profile.secrets;
}
```

### 1.5 Load Tool Auth Profile Map at Session Init

**File:** `apps/runtime/src/services/execution/llm-wiring.ts`

At session initialization, when loading project tools for the agent, also load `authProfileId` from each `ProjectTool` document and build a `toolAuthProfileMap`:

```typescript
// In session init, after loading project tools:
const toolAuthProfileMap = new Map<string, string>();
for (const tool of projectTools) {
  if (tool.authProfileId) {
    toolAuthProfileMap.set(tool.name, tool.authProfileId);
  }
}
// Pass to RuntimeSecretsProvider constructor
```

**Note:** The compiler does NOT need changes. `authProfileId` is a runtime-only concern loaded from the ProjectTool database model, not from DSL or compiled IR.

### Exit Criteria Phase 1:

- [ ] `CreateHttpToolSchema` accepts `authProfileId` and `oauthScopes` when `auth` is `oauth2_client` or `oauth2_user`
- [ ] ProjectTool Mongoose model includes `authProfileId` field with index
- [ ] Tool CRUD validates auth profile link (same tenant, correct type)
- [ ] Runtime `RuntimeSecretsProvider` accepts `toolAuthProfileMap` and resolves OAuth credentials from Auth Profile
- [ ] `llm-wiring.ts` loads `authProfileId` from ProjectTool documents at session init and passes map to secrets provider
- [ ] All existing tests pass (no regressions)
- [ ] 5+ new unit tests for schema validation changes
- [ ] 2+ new integration tests for auth profile link validation

---

## Phase 2: Studio OAuth Config UI

**Goal:** Add OAuth-specific configuration UI to the Studio HTTP tool editor.

**Duration:** 2 days

### 2.1 Auth Profile Selector Component

**File:** `apps/studio/src/components/tools/AuthProfileSelector.tsx` (new)

Dropdown component that fetches and displays `oauth2_app` Auth Profiles:

```typescript
interface AuthProfileSelectorProps {
  projectId: string;
  selectedProfileId?: string;
  onSelect: (profileId: string | undefined) => void;
  filterAuthType?: string; // Default: 'oauth2_app'
}
```

- Fetches profiles via `GET /api/projects/:projectId/auth-profiles?authType=oauth2_app&status=active`
- Shows profile name, connector, and status
- Allows clearing selection
- Shows "Create Auth Profile" link if no profiles exist

### 2.2 OAuth Scope Editor Component

**File:** `apps/studio/src/components/tools/OAuthScopeEditor.tsx` (new)

Tag-input component for managing OAuth scopes:

```typescript
interface OAuthScopeEditorProps {
  scopes: string[];
  defaultScopes?: string[]; // From linked oauth2_app profile
  onChange: (scopes: string[]) => void;
}
```

- Pre-populates with `defaultScopes` from the linked `oauth2_app` when first linked
- Allows adding/removing individual scopes
- Shows validation error for empty scopes

### 2.3 OAuthConfigPanel Component

**File:** `apps/studio/src/components/tools/OAuthConfigPanel.tsx` (new)

Container component that orchestrates the OAuth config UI:

```typescript
interface OAuthConfigPanelProps {
  authType: 'oauth2_client' | 'oauth2_user';
  projectId: string;
  config: {
    authProfileId?: string;
    oauthScopes?: string[];
  };
  onChange: (config: { authProfileId?: string; oauthScopes?: string[] }) => void;
}
```

- Renders `AuthProfileSelector` for choosing the `oauth2_app`
- Renders `OAuthScopeEditor` for configuring scopes
- For `oauth2_user`: renders `ConnectAccountButton` (Phase 3)
- For `oauth2_client`: renders read-only display of `tokenUrl` from linked profile

### 2.4 Wire into HttpConfigForm

**File:** `apps/studio/src/components/tools/HttpConfigForm.tsx`

Add conditional rendering of `OAuthConfigPanel` when `auth` is `oauth2_client` or `oauth2_user`:

```typescript
// Inside HttpConfigForm, after the auth type selector:
{(config.auth === 'oauth2_client' || config.auth === 'oauth2_user') && (
  <OAuthConfigPanel
    authType={config.auth}
    projectId={projectId}
    config={{
      authProfileId: config.authProfileId,
      oauthScopes: config.oauthScopes,
    }}
    onChange={(oauthConfig) => onChange({
      ...config,
      authProfileId: oauthConfig.authProfileId,
      oauthScopes: oauthConfig.oauthScopes,
    })}
  />
)}
```

### Exit Criteria Phase 2:

- [ ] `AuthProfileSelector` fetches and displays `oauth2_app` profiles
- [ ] `OAuthScopeEditor` allows editing scopes with defaults from linked profile
- [ ] `OAuthConfigPanel` orchestrates selector + scope editor
- [ ] `HttpConfigForm` renders OAuth panel when auth type is `oauth2_client` or `oauth2_user`
- [ ] Saving tool with OAuth config persists `authProfileId` and `oauthScopes`
- [ ] 4+ unit tests for new UI components
- [ ] 2+ integration tests for tool save with OAuth config

---

## Phase 3: Studio OAuth Consent Flow

**Goal:** Implement end-to-end OAuth authorization code flow with PKCE for end-user tool authentication.

**Duration:** 3 days

### 3.1 OAuth Initiate Route

**File:** `apps/studio/src/app/api/oauth/tool-auth/route.ts` (new)

```typescript
// POST /api/oauth/tool-auth/initiate
// Request: { authProfileId, scopes, redirectUri }
// Response: { success: true, data: { authUrl, state } }

import crypto from 'node:crypto';
import { httpsPost } from '@/lib/oauth-http';

// Generate PKCE code verifier (43-128 chars, RFC 7636)
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Generate code challenge (S256)
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
```

**State storage:** Redis with 10-minute TTL:

```
Key: oauth_tool_state:<state>
Value: JSON { authProfileId, userId, tenantId, projectId, codeVerifier, redirectUri }
TTL: 600 seconds
```

### 3.2 OAuth Callback Route

**File:** `apps/studio/src/app/api/oauth/tool-auth/callback/route.ts` (new)

```typescript
// GET /api/oauth/tool-auth/callback?code=<code>&state=<state>

// 1. Retrieve and delete state from Redis (atomic)
// 2. Load oauth2_app profile for app credentials
// 3. Exchange code + code_verifier for tokens at tokenUrl
// 4. Create oauth2_token Auth Profile:
//    - linkedAppProfileId: state.authProfileId
//    - tenantId: state.tenantId
//    - projectId: state.projectId
//    - scope: 'project'
//    - visibility: 'personal'
//    - createdBy: state.userId
//    - config: { provider, scopes, tokenType, issuedAt, expiresAt }
//    - secrets: { accessToken, refreshToken }
// 5. Redirect to /projects/:projectId/tools/:toolId?oauth=success
```

**Token exchange uses `httpsPost`** from `apps/studio/src/lib/oauth-http.ts` to avoid `fetch` dual-stack issues.

### 3.3 ConnectAccountButton Component

**File:** `apps/studio/src/components/tools/ConnectAccountButton.tsx` (new)

```typescript
interface ConnectAccountButtonProps {
  authProfileId: string;
  scopes: string[];
  projectId: string;
  toolId?: string; // For redirect after callback
  onConnected?: () => void;
}
```

- Calls `POST /api/oauth/tool-auth/initiate`
- Opens authorization URL in new window/popup
- Listens for callback redirect (via `postMessage` or polling)
- Shows "Connected" state when token profile exists

### 3.4 Redis State Store for Studio OAuth

**File:** `apps/studio/src/lib/oauth-state-store.ts` (new)

Reuse the `RedisOAuthStateStore` pattern from runtime:

```typescript
const REDIS_STATE_PREFIX = 'studio_oauth_state:';
const STATE_TTL_SECONDS = 600; // 10 minutes

interface StudioOAuthState {
  authProfileId: string;
  userId: string;
  tenantId: string;
  projectId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}
```

Use Studio's Redis client (or create one if not available).

### Exit Criteria Phase 3:

- [ ] `POST /api/oauth/tool-auth/initiate` returns authorization URL with PKCE parameters
- [ ] `GET /api/oauth/tool-auth/callback` exchanges code for tokens and creates `oauth2_token` Auth Profile
- [ ] PKCE `code_verifier` is 43+ characters, `code_challenge_method` is `S256`
- [ ] State stored in Redis with 10-minute TTL
- [ ] Expired/invalid state returns 400
- [ ] `ConnectAccountButton` initiates flow and shows connected state
- [ ] `clientSecret` never sent to browser
- [ ] Redirect URI validated against allowlist
- [ ] 3+ E2E tests covering initiate, callback, and error cases
- [ ] 2+ unit tests for PKCE generation
- [ ] Token exchange uses `httpsPost` (not `fetch`)

---

## Phase 4: Token Health & Tool Testing

**Goal:** Add token health visibility and tool connection testing to Studio.

**Duration:** 2 days

### 4.1 Token Health Service

**File:** `packages/shared/src/services/auth-profile/token-health.ts` (new)

```typescript
export type TokenHealthStatus = 'active' | 'expiring' | 'expired' | 'revoked' | 'unknown';

export interface TokenHealth {
  status: TokenHealthStatus;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  profileId: string;
}

const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function computeTokenHealth(profile: {
  _id: string;
  status: string;
  config: Record<string, unknown>;
}): TokenHealth {
  const expiresAt = (profile.config?.expiresAt as string) ?? null;
  const issuedAt = (profile.config?.issuedAt as string) ?? null;

  let status: TokenHealthStatus;
  if (profile.status === 'revoked') status = 'revoked';
  else if (profile.status === 'expired') status = 'expired';
  else if (profile.status !== 'active') status = 'unknown';
  else if (!expiresAt) status = 'active';
  else if (new Date(expiresAt).getTime() < Date.now()) status = 'expired';
  else if (new Date(expiresAt).getTime() < Date.now() + EXPIRING_THRESHOLD_MS) status = 'expiring';
  else status = 'active';

  return {
    status,
    expiresAt,
    lastRefreshedAt: issuedAt,
    profileId: profile._id as string,
  };
}
```

### 4.2 Token Health in Tool List API

**File:** Tool list API route (Studio)

When `?includeTokenHealth=true` query param is set:

1. Collect `authProfileId` values from tool list results
2. Batch-fetch Auth Profiles by IDs (single query: `AuthProfile.find({ _id: { $in: ids }, tenantId })`)
3. Compute `TokenHealth` for each
4. Attach to tool response objects

### 4.3 TokenStatusBadge Component

**File:** `apps/studio/src/components/tools/TokenStatusBadge.tsx` (new)

```typescript
interface TokenStatusBadgeProps {
  status: TokenHealthStatus;
  expiresAt?: string | null;
}
```

- `active` -> green badge
- `expiring` -> yellow badge with "Expires in X hours"
- `expired` -> red badge with "Expired"
- `revoked` -> red badge with "Revoked"
- `unknown` -> gray badge

### 4.4 Tool Test Connection Enhancement

**File:** `apps/studio/src/services/tool-test-service.ts`

Extend test execution to resolve OAuth credentials:

```typescript
async function testToolConnection(params: {
  toolId: string;
  projectId: string;
  tenantId: string;
  userId: string;
}): Promise<{
  success: boolean;
  status?: number;
  latencyMs?: number;
  error?: { code: string; message: string };
}> {
  // 1. Load tool definition
  // 2. If tool has authProfileId, resolve credentials:
  //    - For oauth2_client: resolveClientCredentialsToken
  //    - For oauth2_user: load user's oauth2_token profile
  // 3. Apply auth via applyAuth()
  // 4. Execute HEAD request to tool endpoint with 5s timeout
  // 5. Return result
}
```

### Exit Criteria Phase 4:

- [ ] `computeTokenHealth` returns correct status for all token states
- [ ] Tool list API includes `tokenHealth` when `includeTokenHealth=true`
- [ ] `TokenStatusBadge` renders correct colors and text
- [ ] Tool test connection resolves OAuth credentials and executes health check
- [ ] Test connection fails gracefully with clear error codes on timeout/auth failure
- [ ] 3+ unit tests for `computeTokenHealth`
- [ ] 2+ E2E tests for tool list with token health
- [ ] 2+ E2E tests for tool test connection

---

## Phase 5: Connector OAuth Migration

**Goal:** Migrate SearchAI connector OAuth from in-memory state to Redis-backed Auth Profile flow.

**Duration:** 2 days

### 5.1 Add authProfileId to ConnectorConnection

**File:** `packages/database/src/models/connector-connection.model.ts`

```typescript
authProfileId: { type: String, default: null, index: true },
```

### 5.2 Refactor Connector OAuth Initiate

**File:** `apps/studio/src/lib/connector-oauth.ts`

Replace `initiateConnectorOAuth` to:

1. Look up or create `oauth2_app` Auth Profile from connector catalog entry
2. Use the same `POST /api/oauth/tool-auth/initiate` route (unified flow)
3. Store state in Redis (reuse `StudioOAuthStateStore`)

### 5.3 Refactor Connector OAuth Callback

Handle callback by:

1. Creating `oauth2_token` Auth Profile (same as tool OAuth callback)
2. Updating `ConnectorConnection.authProfileId` to reference the new token profile
3. Preserving backward compatibility: if `authProfileId` is set, use Auth Profile; otherwise, use inline tokens

### 5.4 Background Migration Job

**File:** `apps/studio/src/services/migration/connector-oauth-migration.ts` (new)

One-time migration job:

1. Find all `ConnectorConnection` documents with inline OAuth tokens (`encryptedTokens` set, `authProfileId` null)
2. For each, create an `oauth2_token` Auth Profile from the inline token data
3. Set `authProfileId` on the connection document
4. Log migration progress

**Safety:** Run as idempotent BullMQ job; skip connections where `authProfileId` is already set.

### Exit Criteria Phase 5:

- [ ] `ConnectorConnection` model includes `authProfileId` field
- [ ] Connector OAuth initiate uses Auth Profile flow
- [ ] Connector OAuth callback creates Auth Profile instead of inline tokens
- [ ] Background migration converts existing inline tokens to Auth Profiles
- [ ] Legacy flow continues working when `authProfileId` is null (backward compat)
- [ ] In-memory `pendingStates` in `connector-oauth.ts` no longer used for new flows
- [ ] 2+ E2E tests for connector OAuth with Auth Profile flow
- [ ] 2+ integration tests for migration job idempotency

---

## Wiring Checklist

| #    | Wiring Point                           | Source                          | Target                          | Verified |
| ---- | -------------------------------------- | ------------------------------- | ------------------------------- | -------- |
| W-1  | `authProfileId` in ProjectTool schema  | `project-tool-schemas.ts`       | `project-tool.model.ts`         | [ ]      |
| W-2  | Auth profile link validation           | Tool CRUD routes                | `linked-app-validator.ts`       | [ ]      |
| W-3  | Tool auth profile map at session init  | `llm-wiring.ts`                 | `RuntimeSecretsProvider` config | [ ]      |
| W-4  | Runtime auth resolution                | `secrets-provider.ts`           | Auth Profile resolver chain     | [ ]      |
| W-5  | `OAuthConfigPanel` in `HttpConfigForm` | `HttpConfigForm.tsx`            | `OAuthConfigPanel.tsx`          | [ ]      |
| W-6  | OAuth initiate route                   | `ConnectAccountButton.tsx`      | `/api/oauth/tool-auth/initiate` | [ ]      |
| W-7  | OAuth callback route                   | IdP redirect                    | `/api/oauth/tool-auth/callback` | [ ]      |
| W-8  | Token health in tool list              | Tool list API                   | `computeTokenHealth()`          | [ ]      |
| W-9  | `TokenStatusBadge` in tool list        | Tool list UI component          | `TokenStatusBadge.tsx`          | [ ]      |
| W-10 | Tool test connection                   | Test button in UI               | `tool-test-service.ts`          | [ ]      |
| W-11 | Connector OAuth migration              | `connector-oauth.ts`            | Auth Profile flow               | [ ]      |
| W-12 | `authProfileId` in ConnectorConnection | `connector-connection.model.ts` | Auth Profile reference          | [ ]      |

---

## Risk Assessment

| Risk                                                     | Severity | Mitigation                                                                                        |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| Breaking existing tool configs during schema migration   | High     | New fields are optional with defaults; no required field changes                                  |
| OAuth callback race condition (duplicate token profiles) | Medium   | Unique compound index on `(tenantId, projectId, createdBy, connector, authType)` for oauth2_token |
| PKCE code verifier leakage via logs                      | High     | Never log `codeVerifier`; log only state ID                                                       |
| Redis unavailability during OAuth flow                   | Medium   | Fail-fast with clear error; no fallback to in-memory for production                               |
| Connector OAuth migration data loss                      | Medium   | Migration is additive (creates Auth Profile, sets reference); original inline tokens preserved    |
| Studio Redis client not available                        | Medium   | Phase 3 prerequisite: verify Studio has Redis access; add if missing                              |

---

## Dependency Graph

```
Phase 1 (Schema + Runtime Resolution)
  |
  +--> Phase 2 (Studio OAuth Config UI)
  |      |
  |      +--> Phase 3 (Studio OAuth Consent Flow)
  |             |
  |             +--> Phase 4 (Token Health + Testing)
  |
  +--> Phase 5 (Connector OAuth Migration)
       (can run in parallel with Phases 3-4)
```

**Phases 1-2** are strictly sequential (UI needs schema support).
**Phase 3** depends on Phase 2 (ConnectAccountButton lives in OAuthConfigPanel).
**Phase 4** depends on Phase 1 (token health needs authProfileId on tools).
**Phase 5** can proceed in parallel after Phase 1.
