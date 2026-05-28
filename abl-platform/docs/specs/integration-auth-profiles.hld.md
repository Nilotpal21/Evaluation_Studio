# HLD: Integration Auth Profiles

**Feature Spec**: `docs/features/sub-features/integration-auth-profiles.md`
**Test Spec**: `docs/testing/sub-features/integration-auth-profiles.md`
**Parent HLD**: `docs/specs/auth-profiles.hld.md`
**Design Doc**: `docs/plans/2026-04-01-integration-auth-profiles-design.md`
**Status**: APPROVED
**Author**: Pattabhi Dasari
**Date**: 2026-04-03

---

## 1. Problem Statement

The platform now ships a 36-entry generated connector catalog plus auth-aware overrides for connector-specific auth modes. Several Microsoft/Azure/AWS integrations that began as auth-only provider metadata are now real catalog connectors, while generic utility connectors such as `http` and `postgres` remain intentionally hidden from visible Studio integration grids. Two credential systems still coexist: **Auth Profiles** (rich, unified, encrypted, with JIT auth and token refresh) and **Connector Connections** (simpler, connector-specific, optionally delegating to auth profiles via `authProfileId`). This dual system confuses operators about where credentials live, duplicates auth logic, and complicates debugging ("why isn't my Gmail connector working?" — credentials could be in any of four locations).

**Goal**: Extend the existing Auth Profiles system with a browsable integration catalog and Nango-prefilled OAuth creation flow. Zero new backend systems — integration profiles are regular `auth_profiles` documents with `connector` set and a thin bridge `ConnectorConnection` for execution compatibility.

---

## 2. Alternatives Considered

### Option A: Unified List (No Tabs)

- **Description**: Single list showing all profiles (custom + integration) with a "Connector" filter. Integration creation happens through the same "Add Profile" button with a connector picker dropdown.
- **Pros**: Fastest to build (~3-5 days). No new components. Familiar list-based UX.
- **Cons**: Integration discovery is buried in the form flow. Operators can't browse available connectors or see which ones are configured. Mixes power-user auth concepts (MTLS, client credentials) with integration-focused UX.
- **Effort**: S

### Option B: Tabs with Inline Expand (Recommended)

- **Description**: Two tabs ("All Profiles" / "Integrations") on both project and workspace auth profile pages. Integrations tab shows a catalog grid backed by the generated connector catalog plus auth-aware provider overrides. Clicking expands inline to show existing profiles and a "Create" button. Creation opens the existing slide-over with Nango, Azure AD, AWS IAM, Basic Auth, or client-credentials pre-fill depending on the provider.
- **Pros**: Integration discovery is first-class. Catalog grid shows coverage at a glance (which connectors have profiles, which don't). Reuses existing slide-over and OAuth flow. Clean separation between integration management and custom credential management.
- **Cons**: Medium effort (~7 days). Two new components (`IntegrationAuthTab`, `IntegrationCard`). Tab state management.
- **Effort**: M

### Option C: Separate Pages, Shared Backend

- **Description**: Keep `ConnectionsPage` for integration management, `AuthProfilesPage` for custom credentials. `ConnectionsPage` creates auth profiles under the hood but presents a connector-centric UX.
- **Pros**: No changes to existing auth profile pages. Connector-centric UX for integration management.
- **Cons**: Two pages showing overlapping data creates source-of-truth confusion. Significant refactoring of `CreateConnectionModal`. Risk of inconsistency between pages (e.g., deleting a profile on one page doesn't update the other).
- **Effort**: L

### Recommendation: Option B — Tabs with Inline Expand

**Rationale**: Option B provides first-class integration discovery without disrupting the existing auth profile UX. Option A hides integration browsing behind forms. Option C creates a second source of truth. Option B's medium effort is justified by the UX improvement and alignment with the long-term goal of consolidating credential management in auth profiles (design doc §10 migration path).

---

## 3. Architecture

### System Context Diagram

```
                          ┌─────────────────────────┐
                          │   Studio (Next.js)       │
                          │   Port 5173              │
                          │                          │
                          │  ┌─────────────────────┐ │
                          │  │ Auth Profiles Pages  │ │
                          │  │                      │ │
                          │  │ [All Profiles]       │ │
                          │  │ [Integrations] ←NEW  │ │
                          │  └──────────┬───────────┘ │
                          │             │              │
                          │  ┌──────────▼───────────┐ │
                          │  │ Studio API Routes     │ │
                          │  │                       │ │
                          │  │ GET /providers  ←NEW  │ │
                          │  │ POST /auth-profiles   │ │
                          │  │  + bridge create ←NEW │ │
                          │  │ DELETE /auth-profiles  │ │
                          │  │  + bridge delete ←NEW │ │
                          │  │ POST /oauth/initiate  │ │
                          │  │  + authParams   ←NEW  │ │
                          │  └──┬──────────┬────────┘ │
                          └─────┼──────────┼──────────┘
                                │          │
                   ┌────────────┘          └────────────┐
                   ▼                                    ▼
          ┌────────────────┐                   ┌────────────────┐
          │   MongoDB       │                   │ Nango Provider │
          │                 │                   │ Registry       │
          │ auth_profiles   │                   │ (in-memory Map)│
          │ connector_      │                   │ providers.json │
          │   connections   │                   │ (static file)  │
          └────────────────┘                   └────────────────┘
                   │
                   │ (unchanged at runtime)
                   ▼
          ┌────────────────┐
          │   Runtime       │
          │   Port 3112     │
          │                 │
          │ connection-     │
          │   resolver.ts   │
          │ (reads bridge   │
          │  via authProfId)│
          └────────────────┘
```

### Component Diagram

```
apps/studio/
  src/
    components/auth-profiles/
    ┌─────────────────────────────────────────────────┐
    │ AuthProfilesPage.tsx / WorkspaceAuthProfilesPage│
    │  ┌──────────┐  ┌─────────────────────────┐      │
    │  │All       │  │ IntegrationAuthTab  NEW │      │
    │  │Profiles  │  │  ┌─────────────────────┐│      │
    │  │ +badge   │  │  │IntegrationCard  NEW ││      │
    │  │ +usageCol│  │  │ (expand/collapse)   ││      │
    │  │          │  │  │ +profile list       ││      │
    │  │          │  │  │ +OAuth aggregation  ││      │
    │  │          │  │  │ +[Create] button    ││      │
    │  │          │  │  └─────────────────────┘│      │
    │  └──────────┘  └────────────┬────────────┘      │
    └──────────────────────────────┼───────────────────┘
                                   │ preselectedConnector
                      ┌────────────▼──────────────┐
                      │ AuthProfileSlideOver      │
                      │  + Nango pre-fill (URLs,  │
                      │    scopes, PKCE, params)  │
                      │  + connectionConfig fields│
                      │  + usageMode (jit disabled│
                      │    at workspace level)    │
                      └───────────────────────────┘

    api/
    ┌───────────────────────────────────────────────────┐
    │ GET  /providers          NEW  → catalog + profiles│
    │ POST /auth-profiles      MOD  → + bridge create   │
    │ DEL  /auth-profiles/:id  MOD  → + bridge delete   │
    │ POST /oauth/initiate     MOD  → + authParams      │
    │ POST /oauth/user-consent MOD  → + connConfig      │
    └───────────────────────────────────────────────────┘
```

### Data Flow: Create Integration Auth Profile

```
Operator clicks [Create] on Gmail card in Integrations tab
  │
  ▼
AuthProfileSlideOver opens with preselectedConnector='gmail'
  │
  ├── ProviderConfigRegistry.getProviderConfig('gmail')
  │   → Returns authorizationUrl, tokenUrl, defaultScopes, pkce (Nango field)
  │   → Pre-fills form fields (overridable)
  │   → Field mapping: Nango `pkce` → Schema `pkceRequired`
  │
  ▼
Operator fills clientId, clientSecret, selects usageMode='preconfigured'
  │
  ├── For template connectors (Salesforce, Shopify):
  │   UI shows connectionConfig fields extracted from Nango URL templates
  │   e.g., ${connectionConfig.instance} → "Instance" input field
  │   UI resolves templates in real-time: https://{resolved}.salesforce.com/...
  │   RESOLVED URLs are sent to the API (not templates)
  │
  ▼
POST /api/projects/:pid/auth-profiles
  │
  ├── 1. Validate via CreateAuthProfileSchema (Zod)
  │      - authorizationUrl, tokenUrl pass OAuthEndpointUrlSchema (z.string().url())
  │        (templates already resolved by UI — API only sees valid URLs)
  │      - connectionConfig stores the template variable values for re-editing
  │      - authorizationParams, tokenParams validated as Record<string, string>
  │      - usageMode validated against AUTH_TYPE_USAGE_MODE_MAP
  │
  ├── 2. Create AuthProfile document (MongoDB)
  │      - connector: 'gmail'
  │      - usageMode: 'preconfigured'
  │      - encryptedSecrets: { clientId, clientSecret } (AES-256-GCM)
  │      - config: { authorizationUrl (RESOLVED), tokenUrl (RESOLVED),
  │                  defaultScopes, pkceRequired, connectionConfig: { instance: 'myco' } }
  │
  ├── 3. Create bridge ConnectorConnection (MongoDB, same session)
  │      - connectorName: 'gmail'
  │      - authProfileId: <newly created profile ID>
  │      - encryptedCredentials: '' (empty — resolved via authProfileId)
  │      - scope: 'user' (mapped from profile scope)
  │
  │   [If step 3 fails → rollback step 2 via MongoDB transaction]
  │
  ├── 4. Return 201 with profile data (secrets excluded)
  │
  ▼
If usageMode='preconfigured' and authType='oauth2_app':
  AuthProfileOAuthDialog opens → OAuth consent flow
  → Creates oauth2_token profile linked via linkedAppProfileId
```

### Data Flow: Provider Endpoint

```
GET /api/projects/:pid/auth-profiles/providers
  │
  ├── 1. requireAuth + requireProjectPermission(AUTH_PROFILE_READ)
  │
  ├── 2. Load connector catalog (static JSON, 36 current entries)
  │
  ├── 3. For each connector:
  │      ├── ProviderConfigRegistry.getProviderConfig(name)
  │      │   (alias resolution: jira-cloud → jira, microsoft-teams → microsoft when the exact Nango entry is non-oauth)
  │      └── → oauth2 metadata or null
  │
  ├── 4. AuthProfile.find({
  │        tenantId,
  │        $or: [
  │          { projectId: pid },        // project-scoped
  │          { projectId: null }         // tenant-scoped (inherited)
  │        ],
  │        connector: { $in: connectorNames },
  │        ...visibilityFilter(user, isAdmin)
  │      })
  │      → Group by connector, count, apply OAuth aggregation
  │
  └── 5. Merge catalog + Nango data + profile counts → response
```

### Design Decision: URL Template Resolution Strategy

**Problem**: Nango provider URLs use `${connectionConfig.xxx}` templates (e.g., `https://${connectionConfig.instance}.salesforce.com/services/oauth2/authorize`). The existing `OAuthEndpointUrlSchema` uses `z.string().url()` which calls `new URL()` — template URLs with `$`, `{`, `}` in the hostname fail this validation.

**Decision**: **Option D — UI-side resolution before API submission**

1. Provider endpoint returns raw Nango URLs (with templates) in `oauth2.authorizationUrl` field + extracted `connectionConfigFields` list
2. UI renders input fields for each `connectionConfigFields` entry
3. UI resolves templates in real-time as user types (preview shown)
4. **API receives resolved URLs only** — `config.authorizationUrl` stores `https://mycompany.salesforce.com/...` (valid URL, passes `z.string().url()`)
5. `config.connectionConfig` stores the template variable values (`{ instance: 'mycompany' }`) for re-editing and token refresh URL reconstruction

**Why not other options**:

- **Option A** (store resolved only): Loses template for re-editing. Rejected.
- **Option B** (separate template field): Adds schema complexity for a case affecting ~5 connectors. Rejected.
- **Option C** (relax URL validation): Weakens SSRF protection. Rejected.

**Token refresh implication**: The `initiate` and `user-consent` routes already store resolved URLs in `config`. Token refresh uses the stored `config.tokenUrl` (already resolved). No template resolution needed at runtime.

**Nango template format**: All Nango templates use `${connectionConfig.xxx}` syntax (211 occurrences in `providers.json`). Parser regex: `/\$\{connectionConfig\.(\w+)\}/g`. There are no plain `{placeholder}` templates in Nango data.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All queries include `tenantId` via `tenantIsolationPlugin` (inherited from parent Auth Profiles). Provider endpoints filter by `tenantId` + `projectId`. Cross-tenant access returns 404 (not 403). Bridge `ConnectorConnection` documents inherit the same `tenantId` as the parent auth profile.                                                                                                                                                                                                                                                            |
| 2   | **Data Access Pattern** | Direct model access for both `AuthProfile` and `ConnectorConnection` within Studio route handlers (matching existing CRUD pattern). No new repository layer — the data model is simple (profile + bridge, one-to-one). Nango data is an in-memory `Map` from static JSON — no DB access needed. Provider endpoint aggregation uses a single `find()` query with `$in` filter, not N+1 queries.                                                                                                                                                                |
| 3   | **API Contract**        | Two new GET endpoints return `{ connectorName, displayName, category, availableAuthTypes, oauth2?, profileCount, profiles[] }`. Modified POST/DELETE endpoints add bridge side-effects but the request/response shape is unchanged. Modified OAuth routes consume new optional `config` fields (`authorizationParams`, `connectionConfig`) that were added to the schema. Error responses follow the existing `{ success: false, error: { code, message } }` envelope. No API versioning needed — all changes are additive (new endpoints + optional fields). |
| 4   | **Security Surface**    | Provider endpoints gated by `requireAuth` + `requireProjectPermission(AUTH_PROFILE_READ)`. Visibility filtering prevents personal profile leakage cross-user. OAuth URL construction continues to use `assertUrlSafeForSSRF` validation. `connectionConfig` template values are string-only (no code injection via URL templates). Encrypted secrets are never returned in API responses — provider endpoint returns only profile metadata (id, name, scope, usageMode).                                                                                      |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Schema validation errors** (invalid `authorizationParams` format, unknown strict fields) → 400 with field-level messages. **Bridge creation failure** → rolled back via MongoDB transaction, 500 with error code `BRIDGE_CREATION_FAILED`. **Missing connectionConfig templates** → 400 with descriptive message listing unresolved `{placeholder}` variables (FR-5). **Cross-tenant/project access** → 404. **Unauthenticated** → 401. Provider endpoint errors are isolated — they do not affect auth profile CRUD routes.                                                                                                                                              |
| 6   | **Failure Modes** | **MongoDB down during bridge creation**: Transaction ensures atomicity — profile and bridge either both persist or neither does. **Nango `providers.json` empty**: Provider endpoints return connectors without OAuth metadata (degraded but functional). Operators can still create custom profiles via the All Profiles tab. **Bridge deletion fails during cascade**: Log error, return success for the profile deletion (bridge without a parent profile is harmless — no credentials stored). **Provider endpoint timeout**: Read-only aggregation over the 36-entry catalog + small profile set — sub-200ms target. No circuit breaker needed for this low-risk path. |
| 7   | **Idempotency**   | **Bridge creation**: The POST handler checks for existing bridge before creating. If a bridge already exists for the same `connectorName + tenantId + projectId + authProfileId`, the create is idempotent (returns existing bridge). **Bridge deletion**: `deleteOne` with specific `authProfileId` filter — idempotent by nature. **Provider endpoint**: GET (read-only) — inherently idempotent.                                                                                                                                                                                                                                                                         |
| 8   | **Observability** | No new trace events — existing `auditTrailPlugin` on `auth_profiles` model captures create/update/delete for integration profiles identically to custom profiles. Provider endpoint responses include `profileCount` per connector for operator visibility. Existing `AuthProfileAlertEvaluator` (4 alert dimensions) monitors integration profiles. Note: `ConnectorConnection` model does NOT have `auditTrailPlugin` — bridge create/delete is indirectly audited through the parent auth profile's audit trail (bridge is a derivative artifact with empty credentials).                                                                                                |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Provider endpoint target: < 200ms (feature spec §14). Dataset: 36 static catalog entries + in-memory Nango Map + small DB query (profiles per tenant). No pagination needed. No caching layer needed — if scale increases, add response-level cache with 60s TTL. Bridge creation adds ~1 DB write to the profile create path — negligible overhead.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | **Migration Path**     | **Current → Target**: No data migration. All existing auth profiles and connector connections are untouched. New integration profiles are additive documents. **Future migration** (design doc §10): Phase 2 — migration script creates auth profiles for existing ConnectorConnection records. Phase 3 — ConnectionsPage reads from auth profiles. This is explicitly out of scope for the current work.                                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | **Rollback Plan**      | **Safe rollback**: Remove the two new route files (provider endpoints) and revert the 4 modified route files. Bridge documents can be cleaned via `ConnectorConnection.deleteMany({ authProfileId: { $exists: true, $ne: null }, encryptedCredentials: '' })` to target only auto-created bridges (they have empty credentials). Auth profiles with `connector` set remain valid — they just lose the Integrations tab UX (still visible in All Profiles). No schema migration to revert — the 3 new `OAuth2AppConfigSchema` fields are optional and ignored by existing code.                                                                                                                                                                                                                         |
| 12  | **Test Strategy**      | **26 E2E tests** (real Express server, MongoMemoryServer, API-only interaction, no mocks): profile lifecycle, visibility filtering, cross-project isolation, OAuth param merging, connectionConfig template resolution, utility connector suppression, 401 unauthenticated coverage, validate endpoint (validationMethod, lastValidatedAt persistence, personal-profile 404 isolation). **Targeted route/service suites** cover provider enrichment (23 tests), OAuth-initiate logic (5 tests), and BUILT_IN_LIVE_CHECKS for 28 connectors (35 tests). **Unit/component suites** cover the integrations tab, auth cards, slide-over prefill (20 tests), Connections catalog cards, and multi-auth create flow. Full matrix in test spec. Existing auth-profile and connector suites must remain green. |

---

## 4b. Post-Implementation Notes

- The auth-aware provider assembly now feeds both the Auth Profiles integrations tab and `GET /api/projects/:id/connectors`, so the Connections catalog and Auth Profiles surfaces share the same auth source of truth.
- Several entries originally modeled as auth-only virtual providers are now real generated catalog connectors because corresponding ActivePieces pieces were added and wired into `packages/connectors`.
- `microsoft-power-bi` now resolves to `azure_ad` with the Power BI resource (`https://analysis.windows.net/powerbi/api`) rather than `oauth2_client_credentials`. `microsoft-dynamics-365-business-central` remains the client-credentials Microsoft exception.
- `http` and `postgres` still exist in the raw generated catalog, but Studio intentionally filters them out of the visible Integrations and Connections catalogs.
- **ABLP-619 (validate endpoint)**: A `POST /api/[projects/:id/]auth-profiles/:profileId/validate` endpoint was added after the initial implementation. It delegates to `_piece-auth-validator.ts` which holds `BUILT_IN_LIVE_CHECKS` — a 28-entry registry of AP piece `auth.validate()` hooks. The endpoint returns `{ valid, validationMethod, message }` where `validationMethod` is one of `live | structural | optimistic`. On success, `lastValidatedAt` is written to the profile document. The bridge between stored auth shapes and AP hook expectations is handled by `normalizeAuthForPieceValidate` in `packages/connectors/src/adapters/activepieces/context-translator.ts`. E2E suite was extended from 18 to 26 tests (E2E-19 through E2E-26) to cover the validate scenarios.

## 5. Data Model

### New Collections/Tables

None. Integration profiles use the existing `auth_profiles` collection. Bridges use the existing `connector_connections` collection.

### Modified Schemas

**`OAuth2AppConfigSchema` (Zod, `packages/shared/src/validation/auth-profile.schema.ts`)**

Three new optional fields added to the existing `.strict()` schema:

```typescript
// Existing fields unchanged: clientId, clientSecret, authorizationUrl, tokenUrl,
// refreshUrl, defaultScopes, pkce, scopeSeparator, ...

// NEW optional fields:
authorizationParams: z.record(z.string()).optional(),
  // e.g., { access_type: 'offline', prompt: 'consent' }
  // Merged as query params into OAuth authorization URL

tokenParams: z.record(z.string()).optional(),
  // e.g., { audience: 'https://api.example.com' }
  // Included in token exchange requests

connectionConfig: z.record(z.string()).optional(),
  // e.g., { instance: 'mycompany', subdomain: 'my-store' }
  // Resolves URL templates: https://{instance}.salesforce.com/...
```

**Backward compatibility**: Existing profiles without these fields continue to validate (fields are optional). The `.strict()` mode is preserved — unknown fields are still rejected.

### Bridge ConnectorConnection Shape

Auto-created when an auth profile with `connector` is created:

```typescript
{
  connectorName: string,           // from authProfile.connector
  tenantId: string,                // from authProfile.tenantId
  projectId: string | null,        // from authProfile.projectId
  scope: 'tenant' | 'user',       // mapped: tenant→tenant, project→user, personal→user
  authType: string,                // mapped from authProfile.authType
  authProfileId: ObjectId,         // reference to the parent auth profile
  status: 'active',
  encryptedCredentials: '',        // empty — resolved via authProfileId at runtime
  createdBy: string,               // from request user
}
```

### Key Relationships

```
┌──────────────────┐     authProfileId     ┌────────────────────┐
│   AuthProfile    │◄─────────────────────│  ConnectorConnection │
│                  │     (bridge, 1:1)     │  (bridge)            │
│ connector: 'gmail│                       │ connectorName: 'gmail│
│ usageMode: 'pre' │                       │ encryptedCreds: ''   │
│ encryptedSecrets │                       └──────────┬───────────┘
│  {clientId,      │                                  │
│   clientSecret}  │                                  │
└──────────────────┘                                  │
                                                      │ runtime query
                                          ┌───────────▼──────────┐
                                          │ connection-resolver.ts│
                                          │ line 138:             │
                                          │ if (authProfileId)    │
                                          │   → resolve via AP    │
                                          └───────────────────────┘
```

---

## 6. API Design

### New Endpoints

| Method | Path                                         | Purpose                                                                                              | Auth                                                          | Response                |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| GET    | `/api/projects/:pid/auth-profiles/providers` | Project-scoped integration provider catalog with profile counts (includes inherited tenant profiles) | `requireAuth` + `requireProjectPermission(AUTH_PROFILE_READ)` | `IntegrationProvider[]` |
| GET    | `/api/auth-profiles/providers`               | Workspace-scoped integration provider catalog (tenant profiles only)                                 | `requireAuth` + workspace admin                               | `IntegrationProvider[]` |

**Response shape (`IntegrationProvider`)**:

```typescript
interface IntegrationProvider {
  connectorName: string; // 'gmail'
  displayName: string; // 'Gmail'
  description: string; // 'Email service by Google'
  category: string; // 'communication'
  availableAuthTypes: string[]; // ['oauth2']
  oauth2?: {
    // present when Nango match exists
    authorizationUrl: string; // may contain ${connectionConfig.xxx} templates
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    pkce: boolean; // Nango provider field (maps to pkceRequired in schema)
    authorizationParams?: Record<string, string>;
    tokenParams?: Record<string, string>;
    connectionConfigFields?: string[]; // extracted from ${connectionConfig.xxx} patterns in URLs
  };
  profileCount: number; // visibility-filtered
  profiles: IntegrationProviderProfile[];
}

interface IntegrationProviderProfile {
  id: string;
  name: string;
  scope: 'tenant' | 'project';
  usageMode: string;
  authType: string;
  status: string;
}
```

**Nango → Schema Field Mapping** (applied during Nango pre-fill in slide-over):

| Nango `ProviderConfig` field | `OAuth2AppConfigSchema` field | Notes                                                                   |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `pkce: boolean`              | `pkceRequired: boolean`       | Nango uses `pkce`, schema uses `pkceRequired`. UI maps during pre-fill. |
| `defaultScopes: string[]`    | `defaultScopes: string[]`     | Same name, no mapping needed                                            |
| `authorizationUrl`           | `authorizationUrl`            | Same name. May contain `${connectionConfig.xxx}` templates.             |
| `tokenUrl`                   | `tokenUrl`                    | Same name                                                               |

**`connectionConfigFields` data source**: Extracted by parsing `${connectionConfig.xxx}` patterns from `authorizationUrl` and `tokenUrl` at the provider endpoint level using regex `/\$\{connectionConfig\.(\w+)\}/g`. For example, `https://${connectionConfig.instance}.salesforce.com/...` yields `connectionConfigFields: ['instance']`. This is the standard Nango template format (211 occurrences in `providers.json`). The URL-parsing approach is self-contained and avoids depending on Nango's raw `connection_config` field (not mapped to `ProviderConfig`).

### Modified Endpoints

| Method | Path                                                  | Change                                                                                                                                                                | Breaking?                              |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| POST   | `/api/projects/:pid/auth-profiles`                    | After successful create with `connector` field, auto-create bridge `ConnectorConnection` within same MongoDB transaction                                              | No — request/response shape unchanged  |
| DELETE | `/api/projects/:pid/auth-profiles/:profileId`         | After delete, if profile had `connector`, cascade-delete bridge `ConnectorConnection`                                                                                 | No — response shape unchanged          |
| POST   | `/api/projects/:pid/auth-profiles/oauth/initiate`     | Read `config.authorizationParams` from profile, merge as query params into authorization URL. URLs already resolved by UI (Option D) — no template resolution needed. | No — consumes existing optional fields |
| POST   | `/api/projects/:pid/auth-profiles/oauth/user-consent` | Same `authorizationParams` and `connectionConfig` handling as initiate                                                                                                | No — same pattern                      |

(Workspace-scoped POST/DELETE routes at `/api/auth-profiles` receive the same bridge logic.)

### Error Responses

| Scenario                                    | Status | Error Code                 | Message                                                                                      |
| ------------------------------------------- | ------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| Missing connectionConfig template variables | 400    | `UNRESOLVED_TEMPLATE_VARS` | `"Unresolved template variables in OAuth URL: {instance}. Provide connectionConfig values."` |
| Bridge creation failure (after rollback)    | 500    | `BRIDGE_CREATION_FAILED`   | `"Failed to create connector connection bridge. Auth profile creation rolled back."`         |
| Invalid usageMode for auth type             | 400    | `INVALID_USAGE_MODE`       | `"Usage mode 'jit' is not allowed for auth type 'api_key'."` (existing validation)           |
| Cross-tenant/project access                 | 404    | N/A                        | Standard 404 (no existence leakage)                                                          |
| Unauthenticated                             | 401    | `UNAUTHORIZED`             | Standard auth error                                                                          |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Existing `auditTrailPlugin` on `auth_profiles` model captures all CRUD events for integration profiles. Bridge `ConnectorConnection` model does not have `auditTrailPlugin` — bridge lifecycle is indirectly audited via the parent auth profile (bridge is a derivative artifact with empty credentials, created/deleted in the same request as the profile). No new audit events needed.
- **Rate Limiting**: Provider endpoints inherit the existing per-route rate limiting from Studio's Express middleware (`apps/studio/src/lib/rate-limit.ts`). The standard per-tenant limit applies. No special rate limit configuration needed — these are admin-facing endpoints with single-digit RPS.
- **Caching**: No new caching. Nango provider data is an in-memory `Map` (loaded once from static JSON). Runtime credential resolution uses the existing `CredentialCache` (LRU, 200 entries, 5-min TTL). Provider endpoint does not cache responses — dataset is small enough for real-time aggregation.
- **Encryption**: Integration profiles inherit the parent feature's encryption infrastructure: `encryptionPlugin` on `encryptedSecrets` (AES-256-GCM, tenant-scoped key derivation). Bridge `ConnectorConnection` has empty `encryptedCredentials` — no credential duplication.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                 | Type            | Risk                                                                            |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------- |
| `auth_profiles` collection + model         | Data store      | None — existing, stable, STABLE feature status                                  |
| `connector_connections` collection + model | Data store      | Low — existing, `authProfileId` field already in interface                      |
| `ProviderConfigRegistry`                   | Static data     | Low — in-memory Map from checked-in `providers.json`                            |
| `connector-catalog.json`                   | Static data     | None — generated, checked in                                                    |
| `enrichWithOAuth()` + `NANGO_ALIAS_MAP`    | Logic           | Low — already exists, only consumed read-only                                   |
| `OAuth2AppConfigSchema` (.strict())        | Validation      | Medium — must extend correctly to avoid breaking existing profiles              |
| `requireAuth` + `requireProjectPermission` | Auth middleware | None — existing, well-tested                                                    |
| `AuthProfileSlideOver` component           | UI              | Low — adding props, not modifying existing behavior                             |
| `connection-resolver.ts` (runtime)         | Execution       | None — **NOT modified**. Bridge reuses existing `authProfileId` resolution path |

### Downstream (depends on this feature)

| Consumer                                          | Impact                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Connector execution pipeline (via bridge)         | Gains ability to resolve integration credentials via auth profiles. Existing manual connections are unaffected.  |
| Future ConnectionsPage migration (design doc §10) | This feature enables the migration path by establishing integration profiles as the canonical credential source. |

---

## 9. Open Questions & Decisions Needed

1. ~~**Bridge uniqueness**: Should the bridge `ConnectorConnection` have a unique compound index on `{tenantId, projectId, connectorName, authProfileId}` to prevent duplicates? Or should multiple bridges per connector be allowed?~~ **Resolved**: Bridge uses `findOneAndUpdate` with upsert — multiple profiles per connector share one bridge (last-write wins for `authProfileId`). Acceptable because bridge only needs to point to one profile for execution pipeline compatibility. See GAP-007 in feature spec.
2. ~~**Existing connection conflicts**: If a `ConnectorConnection` already exists for the same connector, should the bridge creation skip, overwrite, or create alongside?~~ **Resolved**: Bridge upsert overwrites the `authProfileId` on any existing bridge for the same connector. Manually-created connections (without `authProfileId`) remain untouched — bridge is keyed by `{tenantId, connectorName, authProfileId}` not by connector alone.
3. **`providers.json` CI integration**: Should `pnpm connectors:import-providers` run in CI as a build step, or stay manual with the generated file checked in? (Feature spec Open Question #1) — Remains manual; file is checked in.
4. **`connectionConfigFields` extraction — resolved**: All 211 Nango URL templates use `${connectionConfig.xxx}` format exclusively (verified by auditor grep of `providers.json`). Zero occurrences of plain `{placeholder}` format. The parser uses regex `/\$\{connectionConfig\.(\w+)\}/g` — no multi-format handling needed. This is a **design decision**, not an open question.

---

## 10. Post-Implementation Notes

_Added 2026-05-03 after ABLP-619 implementation complete._

- **FR-4 cascade-delete refactored**: `cascadeDeleteBridge` extracted as a pure function with injectable deps (`deleteOne` + `log`). Both the project-scoped and workspace DELETE routes call it uniformly. 4 unit tests cover success, Error, non-Error stringification, and filter shape.
- **GAP-008 mitigated**: The `oauth2_client_credentials` validate route now returns a soft structural failure when SSRF blocks the tokenUrl, rather than a hard 400. This prevents surfacing a network security constraint as an unrelated credential error.
- **GAP-009 mitigated**: Optimistic validate responses now include a `warning` field (`"Credential shape looks valid, but no live check was performed — outcome is not confirmed"`), allowing callers to distinguish assumed-valid from confirmed-valid.
- **Test Credentials button**: `AuthProfileSlideOver` now shows a "Test Credentials" button in edit mode. It routes to `validateAuthProfile` (project scope) or `validateWorkspaceAuthProfile` (workspace scope), and is disabled for legacy read-only migration profiles.
- **Implementation status**: BETA as of 2026-05-03. All 26 E2E tests pass. Bridge creation rollback (FR-4 failure path) still has no dedicated non-mocked regression test — documented as PARTIAL in the coverage matrix.

---

## 11. References

- Feature spec: `docs/features/sub-features/integration-auth-profiles.md`
- Test spec: `docs/testing/sub-features/integration-auth-profiles.md`
- Design doc: `docs/plans/2026-04-01-integration-auth-profiles-design.md`
- Impl plan: `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md`
- Parent HLD: `docs/specs/auth-profiles.hld.md`
- Parent feature spec: `docs/features/auth-profiles.md`
- Nango providers: `packages/connectors/src/adapters/nango/generated/providers.json`
- Connection resolver: `packages/connectors/src/auth/connection-resolver.ts`
