# Feature: Integration Auth Profiles

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Auth Profiles](../auth-profiles.md)
**Status**: BETA
**Feature Area(s)**: `integrations`, `admin operations`, `governance`
**Package(s)**: `packages/shared`, `apps/studio`, `packages/connectors` (read-only), `packages/database` (read-only)
**Owner(s)**: `Platform team`
**Testing Guide**: [../../testing/sub-features/integration-auth-profiles.md](../../testing/sub-features/integration-auth-profiles.md)
**Last Updated**: 2026-05-03

---

## 1. Introduction / Overview

### Problem Statement

The platform now ships a generated connector catalog with 36 entries, including the original ActivePieces integrations plus Microsoft/Azure/AWS connectors that were previously only exposed through auth-only provider metadata. Studio still layers auth-aware overrides on top of that catalog, and generic utility connectors such as `http` and `postgres` are intentionally hidden from the visible integration grids. Today, two separate systems still manage these credentials:

- **Auth Profiles** (`auth_profiles` collection) — a rich, unified credential store with 17 auth types, encryption at rest, key rotation, JIT auth, and multi-scope support.
- **Connector Connections** (`connector_connections` collection) — a simpler, connector-specific credential store that can optionally delegate to auth profiles via `authProfileId`.

This dual system creates confusion about where credentials live, duplicates auth logic, and makes it hard for operators to manage integration credentials alongside custom API credentials in one place. When debugging "why isn't my Gmail connector working?", credentials could be in any of four locations: the connection's own `encryptedCredentials`, an auth profile, a connection→auth profile bridge, or an `EndUserOAuthToken`.

### Goal Statement

Extend the existing Auth Profiles system to natively support predefined integration auth — using Nango's 600+ provider configs for pre-filling OAuth metadata — so that operators can discover, create, and manage integration credentials through the same unified interface they use for custom credentials. No new backend systems, collections, or auth flows are introduced.

### Summary

Integration Auth Profiles adds a browsable "Integrations" tab to both project-level and workspace-level auth profile pages, and the broader Connections catalog now consumes the same auth-aware provider service. The shipped catalog currently exposes 36 generated connector entries. Clicking a connector expands it to show existing profiles and a "Create New Profile" button. Creation opens the existing `AuthProfileSlideOver` with provider-specific prefill. OAuth connectors still use Nango metadata; Microsoft/Azure connectors such as Teams, OneDrive, SharePoint, Outlook, Outlook Calendar, Power BI, and Azure Blob Storage use `azure_ad`; Business Central uses `oauth2_client_credentials`; Twilio uses `basic`; AWS service connectors use `aws_iam`; and Shopify exposes `oauth2`, `oauth2_client_credentials`, and `api_key`. A thin bridge `ConnectorConnection` is auto-created so the connector execution pipeline works without modification for runtime-backed connectors.

All integration auth profiles are regular `auth_profiles` documents with the `connector` field populated — they inherit encryption, scoping, visibility, token refresh, JIT auth, and all other parent feature capabilities.

---

## 2. Scope

### Goals

- Provide a browsable integration catalog within the Auth Profiles UI (both project and workspace levels)
- Pre-fill OAuth configuration from Nango's 600+ provider configs (authorization URLs, token URLs, default scopes, PKCE, authorization params)
- Support URL template resolution for connectors like Salesforce (`{instance}.salesforce.com`) and Shopify (`${connectionConfig.subdomain}.myshopify.com`)
- Auto-create bridge `ConnectorConnection` documents so integration profiles are immediately usable by the connector execution pipeline
- Extend `OAuth2AppConfigSchema` with `authorizationParams`, `tokenParams`, and `connectionConfig` fields for Nango provider metadata
- Show unified "All Profiles" list with connector badges and OAuth app/token aggregation
- Support all existing `usageMode` options (`preconfigured`, `jit`, `preflight`) for integration profiles, with `jit`/`preflight` disabled at workspace level per existing callback validation constraints

### Non-Goals (Out of Scope)

- No new MongoDB collections or backend auth flows
- No modifications to `connection-resolver.ts` (critical connector execution path with distributed OAuth refresh locking)
- No new model fields on `AuthProfile` — `usageMode`, `connector`, `category` already exist
- No runtime wiring changes — `usageMode` is already wired through `resolve-tool-auth.ts`, `auth-scope-policy.ts`, and JIT middleware
- Agent desktop providers (smartassist, genesys, five9, etc.) are managed through the Connections page, not this feature
- Generic utility connectors such as `http` and `postgres` remain excluded from the visible Integrations and Connections catalogs
- Migration of existing `ConnectorConnection` records to auth profiles (future Phase 2/3 per design doc §10)

---

## 3. User Stories

1. As a **project admin**, I want to browse a catalog of available integrations and create OAuth profiles with pre-filled provider settings so that I don't need to manually look up authorization URLs, token URLs, and default scopes for each provider.
2. As a **workspace admin**, I want to create tenant-scoped integration profiles that are inherited by all projects so that I can set up company-wide integrations (e.g., shared Gmail automation account) once.
3. As a **project admin**, I want to see both my project's integration profiles and inherited workspace profiles in the same expanded connector card so that I understand what credentials are available without navigating between pages.
4. As an **operator**, I want the "All Profiles" tab to show integration and custom profiles together with connector badges so that I have a single view of all credentials managed through auth profiles.
5. As a **project admin**, I want to create integration profiles with `jit` usage mode so that end users provide their own OAuth consent at runtime (e.g., HR portal where each user sees their own Gmail data).
6. As an **operator**, I want connection config fields (subdomain, instance) to appear automatically when the provider's OAuth URLs contain template placeholders so that I can resolve provider-specific URLs without understanding the URL format.

---

## 4. Functional Requirements

1. **FR-1**: The system must extend `OAuth2AppConfigSchema` with three new optional fields: `authorizationParams` (record of strings), `tokenParams` (record of strings), and `connectionConfig` (record of strings), while preserving `.strict()` validation for all other fields. Verified: `packages/shared/src/validation/auth-profile.schema.ts` uses `.strict()` on `OAuth2AppConfigSchema`.
2. **FR-2**: The system must provide two new GET endpoints (`GET /api/projects/:pid/auth-profiles/providers` and `GET /api/auth-profiles/providers`) that return the connector catalog enriched with Nango OAuth metadata and per-connector profile counts. Each response entry includes `connectorName`, `displayName`, `category`, `availableAuthTypes`, OAuth metadata, and a visibility-filtered `profiles` array.
3. **FR-3**: The provider endpoints must apply the same visibility filtering as existing auth-profile list routes — non-admin users see only `shared` profiles and their own `personal` profiles. Personal profiles from other users must be excluded from both the `profiles` array and `profileCount` to prevent leaking profile existence.
4. **FR-4**: The system must auto-create a bridge `ConnectorConnection` document (with `authProfileId` reference, empty `encryptedCredentials`) when an auth profile with `connector` is created, and cascade-delete the bridge when the auth profile is deleted. If bridge creation fails, the auth profile creation must be rolled back (both operations succeed or neither does) to prevent orphaned profiles that cannot be used by the connector execution pipeline.
5. **FR-5**: The system must update the `initiate` and `user-consent` OAuth routes to consume `authorizationParams` (merged as query params into the authorization URL) and `connectionConfig` (used to resolve URL templates like `{instance}` before authorization). If a profile has `connectionConfig` templates in the URL but `connectionConfig` values are missing or incomplete, the route must return a `400` error with a descriptive message identifying the unresolved template variables.
6. **FR-6**: The system must provide an "Integrations" tab in both `AuthProfilesPage.tsx` (project-level) and `WorkspaceAuthProfilesPage.tsx` (workspace-level) showing a browsable catalog grid of connectors with search and category filtering.
7. **FR-7**: Each connector card in the Integrations tab must expand inline to show existing profiles with mode-based OAuth aggregation: `preconfigured` shows `oauth2_token` status (hides parent `oauth2_app`), `jit`/`preflight` shows `oauth2_app` only (hides per-user tokens), non-OAuth profiles shown as-is.
8. **FR-8**: The `AuthProfileSlideOver` must accept a `preselectedConnector` prop that pre-fills OAuth URLs, default scopes, PKCE, authorization params, and token params from `ProviderConfigRegistry`. Pre-filled fields must be overridable by the user.
9. **FR-9**: When creating workspace-level integration profiles, the usage mode dropdown must disable `jit` and `preflight` options with a tooltip explaining that end-user consent requires a project-scoped app (callback route validates `requiredScope: 'project'`).
10. **FR-10**: Generic utility connectors without a supported auth-profile flow (currently `http` and `postgres`) must be excluded from the visible Integrations and Connections catalogs. Provider responses may still contain unsupported entries for internal completeness, but Studio must not surface create affordances for them.
11. **FR-11**: The "All Profiles" tab must show a "Connector" badge column and a "Usage Mode" column, and apply the same OAuth app/token aggregation rules as the Integrations tab.
12. **FR-12**: The validate endpoints (`POST /api/projects/:pid/auth-profiles/:profileId/validate` and `POST /api/auth-profiles/:profileId/validate`) must return a `validationMethod` field (`'live' | 'structural' | 'optimistic'`) alongside `valid` and `latencyMs`. For integration connectors, the endpoint must attempt a real live HTTP check against the provider API using `BUILT_IN_LIVE_CHECKS` (28 connectors) or the ActivePieces piece `auth.validate` hook. `oauth2_app` profiles are validated structurally via DB grant existence. Auth types with no live-check path (`bearer`, `azure_ad`, `basic`, `aws_iam`, etc.) return `validationMethod: 'optimistic'` with `valid: true` to signal credential shape is plausible but not confirmed.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                      |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Integration profiles are project-scoped or workspace-inherited                                                                             |
| Agent lifecycle            | NONE         | No direct agent lifecycle changes; runtime credential resolution already works                                                             |
| Customer experience        | NONE         | Operator-facing feature; end users interact only via existing JIT auth flows                                                               |
| Integrations / channels    | PRIMARY      | Core purpose: simplify integration credential management for the 36 generated connector catalog entries plus auth-aware provider overrides |
| Observability / tracing    | NONE         | No new trace events; existing auth profile audit trail covers integration profiles                                                         |
| Governance / controls      | SECONDARY    | Visibility filtering on provider endpoints prevents personal profile count leakage                                                         |
| Enterprise / compliance    | SECONDARY    | Inherits encryption, rotation, and audit from parent Auth Profiles feature                                                                 |
| Admin / operator workflows | PRIMARY      | New Integrations tab, catalog grid, and pre-filled creation flow are the main surfaces                                                     |

### Related Feature Integration Matrix

| Related Feature                      | Relationship Type | Why It Matters                                                                                                        | Key Touchpoints                                                            | Current State      |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------ |
| [Auth Profiles](../auth-profiles.md) | extends           | Parent feature — integration profiles are regular `auth_profiles` documents with `connector` field set                | Model, encryption, scoping, visibility, token refresh, JIT, OAuth flows    | Active (STABLE)    |
| [Connectors](../connectors.md)       | configured by     | Integration profiles provide credentials for the generated connector catalog through the bridge `ConnectorConnection` | `connector-catalog.json`, `connection-resolver.ts`, `authProfileId` bridge | Active integration |
| [OAuth Tooling](../oauth-tooling.md) | shares data with  | Extends existing OAuth routes (`initiate`, `user-consent`) to consume `authorizationParams`, `connectionConfig`       | Studio OAuth API routes, `AuthProfileOAuthDialog`                          | Active integration |
| Nango Provider Registry              | depends on        | Provides OAuth metadata (URLs, scopes, PKCE) for 600+ providers, consumed at build time                               | `ProviderConfigRegistry.getProviderConfig(name)`, `providers.json`         | Static data source |

---

## 6. Design Considerations

- **Tabs approach**: Two tabs ("All Profiles" / "Integrations") chosen over unified list (cluttered UX, no integration discovery) and separate pages (overlapping data, source-of-truth confusion). See design doc §9 for alternatives considered.
- **Nango pre-fill fields are overridable**: Users may customize OAuth URLs for non-standard endpoints or custom OAuth app configurations.
- **Alias resolution**: Connector names are matched to Nango providers via exact name, hyphen→underscore, and a manual `NANGO_ALIAS_MAP` (currently including `jira-cloud -> jira` and `microsoft-teams -> microsoft`). Alias providers are preferred when the exact-match Nango entry exists but does not expose usable OAuth URLs.
- **Connector-specific auth extensions**: `twilio` is exposed through `basic`; `amazon-s3`, `amazon-ses`, `amazon-sqs`, and `amazon-sns` are exposed through `aws_iam`; Microsoft/Azure providers such as Teams, OneDrive, Outlook, SharePoint, Power BI, and Azure Blob Storage are exposed through `azure_ad`; Business Central is exposed through `oauth2_client_credentials`; and Shopify merges `oauth2`, `oauth2_client_credentials`, and `api_key` from the Nango-backed provider set.
- **Shared auth-aware catalog source**: The same provider assembly logic now feeds both the Auth Profiles integrations tab and the project Connections catalog so auth labels, auth availability, and connector filtering stay aligned across both Studio surfaces.
- **OAuth app/token aggregation in UI**: Preconfigured profiles show the `oauth2_token` with status badge (hides the parent `oauth2_app`). JIT/preflight profiles show the `oauth2_app` only (per-user tokens are runtime artifacts). Same rules apply in both Integrations tab and All Profiles tab.
- **JIT and preflight token storage are identical**: Both always store tokens under the real end user's ID in `EndUserOAuthToken`. The `connection_mode: 'shared'` option (storing as `__tenant__`) is exclusively for `preconfigured` mode where an admin provides credentials once for everyone. The only difference between JIT and preflight is timing — preflight obtains consent upfront before the session starts; JIT obtains consent mid-execution when a tool actually needs credentials.
- **URL template resolution**: When Nango provider URLs contain `{placeholders}` (e.g., `https://{instance}.salesforce.com/...`), the UI renders connection config input fields, resolves URLs in real-time, and stores both template variables (`config.connectionConfig`) and resolved URLs (`config.authorizationUrl`).

---

## 7. Technical Considerations

- **Bridge `ConnectorConnection` pattern**: Rather than modifying `connection-resolver.ts` (critical path with distributed OAuth refresh locking), a thin bridge `ConnectorConnection` with `authProfileId` is auto-created. This reuses the existing `authProfileId` resolution path in `connection-resolver.ts:138`.
- **`.strict()` schema extension**: `OAuth2AppConfigSchema` uses `.strict()` — the three new fields (`authorizationParams`, `tokenParams`, `connectionConfig`) must be explicitly added to pass validation. Existing profiles without these fields continue to validate.
- **`usageMode` already implemented**: The `usageMode` field, Zod validation with `AUTH_TYPE_USAGE_MODE_MAP`, and runtime wiring are all already in place. No new persistence or runtime changes needed — integration profiles use the same `usageMode` values as custom profiles.
- **Prerequisite**: `pnpm connectors:import-providers` must be run to populate `packages/connectors/src/adapters/nango/generated/providers.json` (currently empty array).

---

## 8. How to Consume

### Studio UI

Two entry points, mirroring existing auth profile page structure:

| Entry Point                 | Route                                      | What's New                                                                      |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| **Project Auth Profiles**   | `/projects/:id/settings/auth-profiles`     | New "Integrations" tab alongside "All Profiles"                                 |
| **Workspace Auth Profiles** | `/workspace/auth-profiles` (Admin sidebar) | Same tab bar; `jit`/`preflight` disabled for workspace scope                    |
| **Project Connections**     | `/projects/:id/connections`                | Connector catalog now shows auth types from the same auth-aware provider source |

Key new UI components:

| Component                | Purpose                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `IntegrationAuthTab.tsx` | Catalog grid with search, category filter; props: `scope`, `projectId`          |
| `IntegrationCard.tsx`    | Expandable connector card with profile list, OAuth aggregation, "Create" button |

Enhanced existing components:

| Component                       | Enhancement                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `AuthProfileSlideOver.tsx`      | New `preselectedConnector` prop for Nango pre-fill + connection config fields   |
| `AuthProfilesPage.tsx`          | Tab bar, connector badge column, OAuth aggregation in All Profiles              |
| `WorkspaceAuthProfilesPage.tsx` | Tab bar, `jit`/`preflight` disabled                                             |
| `auth-type-metadata.ts`         | `getIntegrationTypeMetadata()` helper for integration-specific field resolution |

### API (Studio)

New endpoints:

| Method | Path                                         | Purpose                                                                                       |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:pid/auth-profiles/providers` | Project-scoped integration provider catalog with profile counts                               |
| GET    | `/api/auth-profiles/providers`               | Workspace-scoped integration provider catalog (tenant profiles only)                          |
| GET    | `/api/projects/:pid/connectors`              | Project Connections catalog enriched with `availableAuthTypes` from the same provider service |

Updated endpoints:

| Method | Path                                                  | Change                                                                  |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| POST   | `/api/projects/:pid/auth-profiles`                    | After create with `connector`, auto-create bridge `ConnectorConnection` |
| DELETE | `/api/projects/:pid/auth-profiles/:profileId`         | On delete with `connector`, cascade-delete bridge `ConnectorConnection` |
| POST   | `/api/projects/:pid/auth-profiles/oauth/initiate`     | Consume `authorizationParams`, `connectionConfig` from profile config   |
| POST   | `/api/projects/:pid/auth-profiles/oauth/user-consent` | Same: merge `authorizationParams`, resolve `connectionConfig` templates |

(Workspace-scoped POST/DELETE routes receive the same bridge logic.)

### API (Runtime)

No new runtime endpoints or changes. Runtime credential resolution, token refresh, JIT auth, and client credentials caching continue to work identically for integration profiles via the existing `usageMode` wiring.

### Admin Portal

No dedicated admin portal routes. Workspace-level management is handled through Studio's existing workspace auth profile pages.

### Channel / SDK / Voice / A2A / MCP Integration

Integration auth profiles are consumed identically to custom auth profiles — through the `authProfileId` field on connector connections, model configs, MCP server definitions, and channel connections. No channel-specific changes.

---

## 9. Data Model

### Collections / Tables

No new collections. Integration profiles use the existing `auth_profiles` collection. The bridge uses the existing `connector_connections` collection.

**Extended fields in `OAuth2AppConfigSchema` (Zod validation, stored in `config: Mixed`)**:

```text
config.authorizationParams: Record<string, string> (optional)
  - e.g., { access_type: 'offline', prompt: 'consent' }
  - Merged as query params into the OAuth authorization URL

config.tokenParams: Record<string, string> (optional)
  - e.g., { audience: 'https://api.example.com' }
  - Included in token exchange requests

config.connectionConfig: Record<string, string> (optional)
  - e.g., { instance: 'mycompany', subdomain: 'my-store' }
  - Used to resolve URL templates: https://{instance}.salesforce.com/...
```

**Bridge `ConnectorConnection` (auto-created)**:

```text
{
  connectorName: authProfile.connector,       // e.g., 'gmail'
  tenantId: authProfile.tenantId,
  projectId: authProfile.projectId,
  scope: authProfile.scope === 'tenant' ? 'tenant' : 'user',
  authType: mapAuthTypeForConnection(authProfile.authType),  // e.g., 'oauth2'
  authProfileId: authProfile._id,             // bridge to auth profile
  status: 'active',
  encryptedCredentials: '',                   // empty — resolved via authProfileId
}
```

### Key Relationships

- **Integration AuthProfile → ConnectorConnection (bridge)**: One-to-one via `authProfileId`. Auto-created on profile creation, cascade-deleted on profile deletion.
- **ConnectorConnection (bridge) → AuthProfile**: `connection-resolver.ts:138` resolves credentials through `authProfileId` when `encryptedCredentials` is empty.
- **Integration AuthProfile → Nango Provider**: Linked by `connector` field name → `ProviderConfigRegistry.getProviderConfig(name)`. Static lookup, not a database relationship.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                       | Purpose                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/shared/src/validation/auth-profile.schema.ts`    | Extend `OAuth2AppConfigSchema` with `authorizationParams`, `tokenParams`, `connectionConfig` |
| `packages/connectors/src/auth/provider-config-registry.ts` | Nango provider lookup: `getProviderConfig(name)`, `listProviders()`                          |
| `packages/connectors/src/generated/connector-catalog.json` | Static generated catalog of 36 connectors with actions, triggers, and base auth metadata     |
| `packages/connectors/src/loader.ts`                        | Registers the installed ActivePieces pieces that back the generated connector catalog        |
| `scripts/generate-connector-catalog.ts`                    | Rebuilds the generated connector catalog from the installed connector packages               |
| `apps/studio/src/lib/integration-provider-service.ts`      | Builds the auth-aware provider catalog, auth overrides, and auth-prefill metadata for Studio |
| `packages/connectors/src/catalog/extract-entry.ts`         | `enrichWithOAuth()` — alias resolution for Nango provider matching                           |

### Routes / Handlers

| File                                                                                | Purpose                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts`            | **New** — project-scoped provider endpoint                                                           |
| `apps/studio/src/app/api/auth-profiles/providers/route.ts`                          | **New** — workspace-scoped provider endpoint                                                         |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` (POST)               | Enhanced — auto-create bridge `ConnectorConnection` via upsert                                       |
| `apps/studio/src/app/api/auth-profiles/route.ts` (POST)                             | Enhanced — auto-create bridge for workspace profiles (projectId: '\_workspace')                      |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` (DELETE) | Enhanced — cascade-delete bridge via `cascadeDeleteBridge`, exclude bridge from delete blocker check |
| `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts` (DELETE)               | Enhanced — cascade-delete bridge via `cascadeDeleteBridge` for workspace profiles                    |
| `apps/studio/src/app/api/auth-profiles/_bridge-cascade.ts`                          | **New** — `cascadeDeleteBridge` pure function with injectable deps (deleteOne + log)                 |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`       | Enhanced — consume `authorizationParams`, `connectionConfig`                                         |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts`   | Enhanced — same                                                                                      |
| `apps/studio/src/app/api/projects/[id]/connectors/route.ts`                         | Enhanced — project Connections catalog now uses the same auth-aware provider source                  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts` | Enhanced — returns `validationMethod`, routes to live/structural/optimistic                          |
| `apps/studio/src/app/api/auth-profiles/[profileId]/validate/route.ts`               | Enhanced — workspace variant, same routing logic                                                     |
| `apps/studio/src/app/api/auth-profiles/_piece-auth-validator.ts`                    | **New** — `BUILT_IN_LIVE_CHECKS` (28 connectors), `runPieceAuthValidate`, `validateOAuth2AppProfile` |

### Shared Libraries

| File                                                                  | Purpose                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/lib/integration-provider-service.ts`                 | **New** — builds enriched provider catalog from connector catalog + Nango + DB profiles                                              |
| `apps/studio/src/lib/connection-config-utils.ts`                      | **New** — URL template placeholder extraction and resolution                                                                         |
| `apps/studio/src/api/auth-profiles.ts`                                | Enhanced — `fetchIntegrationProviders()` client API functions                                                                        |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` | Enhanced — `normalizeAuthForPieceValidate()` maps stored auth shape → AP `validate` hook shape (SECRET_TEXT, CUSTOM_AUTH divergence) |

### UI Components

| File                                                                     | Purpose                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`        | **New** — catalog grid with search, category filter                                                       |
| `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`           | **New** — expandable connector card with profile list                                                     |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`      | Enhanced — `preselectedConnector`, Nango pre-fill, connection config; Test Credentials button (edit mode) |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Enhanced — tab bar, connector badge column, OAuth aggregation                                             |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` | Enhanced — tab bar, `jit`/`preflight` disabled                                                            |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`         | Enhanced — `getIntegrationTypeMetadata()`, `scopes`→`defaultScopes` fix                                   |
| `apps/studio/src/components/connections/CatalogCard.tsx`                 | Enhanced — shows auth types directly on the Connections catalog cards                                     |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx`       | Enhanced — supports multi-auth connectors via selected auth profile type                                  |
| `apps/studio/src/hooks/useAvailableConnectors.ts`                        | Enhanced — hides utility connectors and consumes auth-aware connector data                                |

### Jobs / Workers / Background Processes

| File | Purpose                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| N/A  | No new background processes — token refresh and client credentials caching already handle integration profiles |

### Tests

| File                                                                                        | Type     | Coverage Focus                                                                              | Status     |
| ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- | ---------- |
| `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts`                       | e2e      | Full lifecycle: create, bridge, delete, providers, visibility, validate (E2E-1 to E2E-26)   | 26 passing |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`         | targeted | Provider-service auth enrichment, alias handling, visibility logic                          | 23 passing |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts` | targeted | OAuth route handler param merge and unresolved template logic                               | 5 passing  |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-piece-validate.test.ts`    | targeted | `BUILT_IN_LIVE_CHECKS` — 28 connectors, SSRF, reject surfaces, AP hook routing              | 35 passing |
| `apps/studio/src/__tests__/auth-profile-bridge-cascade.test.ts`                             | unit     | Pure-function: `cascadeDeleteBridge` — success, Error thrown, non-Error, filter shape       | 4 passing  |
| `apps/studio/src/__tests__/auth-profile-validate-route.test.ts`                             | unit     | Pure-function: `getMaterializedAuthProfileValidationErrors`, `getAuthProfileMigrationState` | 8 passing  |
| `packages/connectors/src/__tests__/normalize-auth-for-piece-validate.test.ts`               | unit     | `normalizeAuthForPieceValidate` shape mapping for SECRET_TEXT / CUSTOM_AUTH connectors      | 16 passing |
| `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts`            | unit     | New schema fields validation (strict mode preserved)                                        | 8 passing  |
| `apps/studio/src/__tests__/components/integration-auth-tab.test.tsx`                        | unit     | Catalog grid rendering, search, category filtering                                          | 6 passing  |
| `apps/studio/src/__tests__/components/integration-card.test.tsx`                            | unit     | Expand/collapse, OAuth aggregation, auth label rendering                                    | 7 passing  |
| `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`                     | unit     | Connector prefill; Test Credentials button (edit mode, disabled for legacy read-only)       | 20 passing |
| `apps/studio/src/__tests__/connection-cards.test.tsx`                                       | unit     | Connections catalog card auth summaries                                                     | 20 passing |
| `apps/studio/src/__tests__/create-connection-modal.test.tsx`                                | unit     | Multi-auth connection creation flow and profile filtering                                   | 18 passing |
| `packages/connectors/src/__tests__/generate-catalog.test.ts`                                | unit     | Generated catalog alias resolution and connector enrichment                                 | 10 passing |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                                              |
| -------- | ------- | ---------------------------------------------------------------------------------------- |
| N/A      | —       | No new environment variables. Existing `AUTH_PROFILE_ENABLED` and encryption keys apply. |

### Runtime Configuration

No new feature flags. Integration auth profiles are available as soon as the code is deployed and `providers.json` is populated.

### DSL / Agent IR / Schema

No DSL or IR changes. Integration profiles are consumed by connectors through the existing `authProfileId` bridge pattern on `ConnectorConnection`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Provider endpoints filter profiles by `projectId`. Project-scoped profiles are not visible in other projects or the workspace page.                                                  |
| Tenant isolation  | All queries include `tenantId` via `tenantIsolationPlugin`. Cross-tenant access returns 404.                                                                                         |
| User isolation    | Provider endpoints apply visibility filtering: non-admins see only `shared` + own `personal` profiles. Personal profile counts from other users are excluded from provider response. |

### Security & Compliance

- Bridge `ConnectorConnection` uses empty `encryptedCredentials` — actual secrets resolved via `authProfileId`, avoiding credential duplication.
- Provider endpoints use `requireAuth` + `requireProjectPermission(AUTH_PROFILE_READ)`.
- OAuth URL construction continues to use `OAuthEndpointUrlSchema` with `assertUrlSafeForSSRF` validation (existing, no changes).
- Encrypted secrets inherit `encryptionPlugin` from parent feature (AES-256-GCM, tenant-scoped key derivation).
- Audit trail plugin captures create/update/delete events for integration profiles identically to custom profiles.

### Performance & Scalability

- Provider endpoints aggregate over the 36 generated connector catalog entries plus a DB query for profiles per connector. Dataset is still small (profiles per tenant/project) — no pagination needed.
- Nango provider lookup is an in-memory `Map` — O(1) case-insensitive lookup per connector.
- Existing `CredentialCache` (LRU, max 200 entries, 5-minute TTL) handles runtime credential resolution for integration profiles.

### Reliability & Failure Modes

- Bridge `ConnectorConnection` creation is atomic with auth profile creation in the same request handler. If bridge creation fails, the auth profile creation is rolled back (FR-4). This prevents orphaned profiles that exist in auth profiles but are invisible to the connector execution pipeline.
- Nango `providers.json` is checked into the repo — no runtime network dependency. If the file is empty, provider endpoints return connectors without OAuth metadata (degraded but functional).
- Token refresh for integration profiles uses the same distributed Redis lock mechanism as custom profiles (`shared-auth-profile/token-refresh-service.ts`).

### Observability

- No new trace events — existing auth profile audit trail (`auditTrailPlugin`) covers integration profile create/update/delete.
- Provider endpoint responses include `profileCount` for operator visibility into credential coverage per connector.
- Existing `AuthProfileAlertEvaluator` (4 alert dimensions) monitors integration profiles identically to custom profiles.

### Data Lifecycle

- Bridge `ConnectorConnection` documents are cascade-deleted when the parent auth profile is deleted.
- No new TTLs or retention policies — integration profiles follow the same lifecycle as custom auth profiles.
- No migration needed for existing data — `usageMode`, `connector`, and `config: Mixed` fields already exist on the model.

---

## 13. Delivery Plan / Work Breakdown

1. **OAuth Schema Extension**
   1.1 Add `authorizationParams`, `tokenParams`, `connectionConfig` to `OAuth2AppConfigSchema`
   1.2 Write schema validation tests (12 tests)

2. **Provider Endpoints**
   2.1 Create project-scoped provider route (`GET /api/projects/:pid/auth-profiles/providers`)
   2.2 Create workspace-scoped provider route (`GET /api/auth-profiles/providers`)
   2.3 Add client API functions (`fetchIntegrationProviders()` + workspace variant)
   2.4 Write provider endpoint tests (10 tests)

3. **ConnectorConnection Bridge**
   3.1 Add bridge creation logic in POST handlers (project + workspace)
   3.2 Add cascade deletion in DELETE handlers (project + workspace)
   3.3 Write bridge lifecycle tests (8 tests)

4. **OAuth Route Updates**
   4.1 Update `initiate` route to consume `authorizationParams` and `connectionConfig`
   4.2 Update `user-consent` route with same logic
   4.3 Write OAuth route tests (6 tests)

5. **UI: Integrations Tab + Catalog Grid**
   5.1 Create `IntegrationAuthTab.tsx` with search and category filter
   5.2 Create `IntegrationCard.tsx` with expand/collapse and OAuth aggregation
   5.3 Add tab bar to `AuthProfilesPage.tsx` and `WorkspaceAuthProfilesPage.tsx`
   5.4 Write component tests (6 tests)

6. **UI: Slide-Over + All Profiles Enhancements**
   6.1 Add `preselectedConnector` prop to `AuthProfileSlideOver.tsx` with Nango pre-fill
   6.2 Add connection config fields for URL templates
   6.3 Disable `jit`/`preflight` at workspace level
   6.4 Add connector badge column and OAuth aggregation to All Profiles tab
   6.5 Write component tests (4 tests)

7. **E2E Test Suite**
   7.1 Write 12 E2E tests covering full lifecycle through HTTP API
   7.2 No mocks, no direct DB access, real Express server

---

## 14. Success Metrics

| Metric                           | Baseline                            | Target                                       | How Measured                                                                 |
| -------------------------------- | ----------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Integration credential sources   | 2 (auth profiles + connections)     | 1 (auth profiles only, for new integrations) | New integration credentials created via Integrations tab vs Connections page |
| Time to set up OAuth integration | Manual URL/scope lookup (~5-10 min) | Pre-filled from Nango (~1-2 min)             | Operator feedback / task completion time                                     |
| Provider endpoint response time  | N/A (new)                           | < 200ms                                      | Server metrics on provider GET endpoints                                     |
| Test coverage                    | 0 integration-specific tests        | 58+ tests (per impl plan)                    | `pnpm test:report` pass count                                                |

---

## 15. Open Questions

1. Should the `providers.json` population (`pnpm connectors:import-providers`) be added to CI, or remain a manual step? (Currently decided: manual, but may revisit as connector count grows.)
2. Should connectors with `authType: 'custom'` and Nango match (Shopify, Jira) show both the Nango-resolved auth type and the ActivePieces custom auth fields, or only the Nango-resolved type?
3. ~~Should the bridge `ConnectorConnection` unique index allow multiple integration auth profiles per connector?~~ **Resolved**: Yes — bridge uses `findOneAndUpdate` with `upsert: true`. Multiple profiles per connector are allowed; the bridge points to the most recently created profile. This is acceptable because bridge is only needed for execution pipeline compatibility.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                 | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | `providers.json` must remain populated from `pnpm connectors:import-providers` so the Nango-backed auth metadata stays current (771 providers in this snapshot)                                                                                             | High     | Mitigated |
| GAP-002 | Generic utility connectors (`http`, `postgres`) remain intentionally hidden from the visible integration catalogs instead of receiving auth-profile flows                                                                                                   | Medium   | Accepted  |
| GAP-003 | Bridge `ConnectorConnection` creation must be atomic with auth profile creation — FR-4 mandates rollback on failure                                                                                                                                         | Medium   | Mitigated |
| GAP-004 | Workspace OAuth apps cannot use `jit`/`preflight` modes due to callback validation constraints — UI disabled, not backend validated                                                                                                                         | Low      | Accepted  |
| GAP-005 | UI and catalog-focused unit coverage is in place across IntegrationAuthTab, IntegrationCard, AuthProfileSlideOver, CatalogCard, and CreateConnectionModal                                                                                                   | Medium   | Mitigated |
| GAP-006 | E2E-6 tests non-existent project instead of cross-tenant isolation — dev-login auto-attaches all users to same tenant                                                                                                                                       | Low      | Accepted  |
| GAP-007 | Bridge uses `findOneAndUpdate` upsert — multiple profiles per connector share one bridge, last-write wins for `authProfileId`                                                                                                                               | Low      | Accepted  |
| GAP-008 | `oauth2_client_credentials` validate route now returns soft structural failure when SSRF blocks tokenUrl instead of hard 400; test coverage uses SSRF-blocked URL pattern instead of a mock server                                                          | Low      | Mitigated |
| GAP-009 | Auth types without a live-check path (`bearer`, `azure_ad`, `basic`, `aws_iam`, `oauth2_client_credentials` with no endpoint) return `optimistic/valid:true` — callers distinguish from confirmed-valid via the `warning` field now emitted in the response | Medium   | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                 | Coverage Type | Status    | Test File / Note                                                |
| --- | ---------------------------------------------------------------------------------------- | ------------- | --------- | --------------------------------------------------------------- |
| 1   | OAuth schema accepts `authorizationParams`, `tokenParams`, `connectionConfig`            | unit          | ✅ PASS   | `oauth2-app-config-extension.test.ts`                           |
| 2   | Strict schema rejects unknown fields (existing behavior preserved)                       | unit          | ✅ PASS   | `oauth2-app-config-extension.test.ts`                           |
| 3   | Provider endpoint returns connectors with Nango OAuth metadata                           | targeted unit | ✅ PASS   | `auth-profile-providers.test.ts`                                |
| 4   | Provider endpoint visibility filtering hides other users' personal profiles              | targeted unit | ✅ PASS   | `auth-profile-providers.test.ts`                                |
| 5   | Creating profile with `connector` auto-creates bridge `ConnectorConnection`              | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts`                         |
| 6   | Deleting profile with `connector` cascade-deletes bridge                                 | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts`                         |
| 7   | Bridge creation failure rolls back auth profile creation                                 | ❌            | ⚠ Partial | No dedicated non-mocked regression on disk                      |
| 8   | OAuth `initiate` route merges `authorizationParams` into auth URL                        | targeted unit | ✅ PASS   | `auth-profile-oauth-integration.test.ts`                        |
| 9   | OAuth `initiate` route resolves `connectionConfig` URL templates                         | targeted unit | ✅ PASS   | `auth-profile-oauth-integration.test.ts`                        |
| 10  | OAuth `initiate` returns 400 for missing `connectionConfig` template vars                | targeted unit | ✅ PASS   | `auth-profile-oauth-integration.test.ts`                        |
| 11  | Integrations tab renders connector catalog grid                                          | unit          | ✅ PASS   | `integration-auth-tab.test.tsx` (6 tests)                       |
| 12  | Connector card expands to show profiles with OAuth aggregation                           | unit          | ✅ PASS   | `integration-card.test.tsx` (7 tests)                           |
| 13  | Slide-over pre-fills connector-specific auth defaults when `preselectedConnector` is set | unit          | ✅ PASS   | `auth-profile-slide-over.test.tsx`                              |
| 14  | Connections catalog shows auth-aware labels and filters utility connectors               | unit          | ✅ PASS   | `connection-cards.test.tsx`, `create-connection-modal.test.tsx` |
| 15  | E2E: create preconfigured OAuth profile + bridge auto-created                            | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-1)                 |
| 16  | E2E: provider endpoint returns enriched catalog                                          | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-2)                 |
| 17  | E2E: visibility filtering on provider endpoint                                           | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-3)                 |
| 18  | E2E: delete profile cascades to bridge                                                   | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-4)                 |
| 19  | E2E: workspace profile inheritance in project provider endpoint                          | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-5)                 |
| 20  | validate endpoint returns `validationMethod: 'structural'` for `none` profile            | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-19)                |
| 21  | validate endpoint returns `structural/invalid` when oauth2_app has no grant              | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-20)                |
| 22  | validate endpoint returns `optimistic/valid:true` for bearer with no connector           | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-21)                |
| 23  | validate returns 404 for non-existent profile                                            | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-22)                |
| 24  | validate returns 401 for unauthenticated request                                         | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-23)                |
| 25  | validate writes `lastValidatedAt` on project profile success, visible via GET            | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-24)                |
| 26  | personal project profile returns 404 to non-creator on validate                          | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-25)                |
| 27  | personal workspace profile returns 404 to non-creator on validate                        | e2e           | ✅ PASS   | `integration-auth-profiles.e2e.test.ts` (E2E-26)                |
| 28  | `BUILT_IN_LIVE_CHECKS` covers all 28 named connectors (SSRF-safe, no real network)       | targeted unit | ✅ PASS   | `auth-profile-piece-validate.test.ts` (35 tests)                |
| 29  | `normalizeAuthForPieceValidate` correctly remaps SECRET_TEXT / CUSTOM_AUTH auth shapes   | unit          | ✅ PASS   | `normalize-auth-for-piece-validate.test.ts`                     |

### Testing Notes

The E2E suite in `integration-auth-profiles.e2e.test.ts` has grown to 26 tests (E2E-1 through E2E-26) and exercises the real Studio routes through HTTP-like route calls with MongoMemoryServer and real middleware. E2E-19 through E2E-26 cover the validate endpoint, including `validationMethod` responses, `lastValidatedAt` persistence, and personal-profile 404 isolation. The targeted unit suite `auth-profile-piece-validate.test.ts` (35 tests) covers all 28 `BUILT_IN_LIVE_CHECKS` entries with SSRF-guarded fake tokens so no real provider network calls are made in CI. E2E-6 still tests non-existent project isolation instead of true cross-tenant isolation due to the dev-login tenant auto-attach limitation.

> Full testing details: [../../testing/sub-features/integration-auth-profiles.md](../../testing/sub-features/integration-auth-profiles.md)

---

## 18. References

- Design doc: [`docs/plans/2026-04-01-integration-auth-profiles-design.md`](../../plans/2026-04-01-integration-auth-profiles-design.md)
- Implementation plan (LLD): [`docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md`](../../plans/2026-04-03-integration-auth-profiles-impl-plan.md)
- Parent feature: [`docs/features/auth-profiles.md`](../auth-profiles.md)
- Related: [`docs/features/connectors.md`](../connectors.md), [`docs/features/oauth-tooling.md`](../oauth-tooling.md)
