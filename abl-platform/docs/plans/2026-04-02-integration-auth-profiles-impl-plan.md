# Implementation Plan: Integration Auth Profiles

**Date**: 2026-04-02
**Author**: Pattabhi Dasari
**Design Doc**: [`docs/plans/2026-04-01-integration-auth-profiles-design.md`](./2026-04-01-integration-auth-profiles-design.md)
**Status**: Plan — Awaiting User Approval

---

## Overview

Incremental implementation of Integration Auth Profiles in 6 phases. Each phase is independently shippable, has measurable exit criteria, and requires all existing auth-related tests to pass before proceeding.

> **Note**: The `usageMode` field (`preconfigured`, `user_token`, `jit`, `preflight`) is **already implemented** in the model, Zod schemas, UI, and runtime. No new persistence or runtime wiring is needed. This plan focuses on the remaining work: schema extensions, provider endpoints, bridge logic, OAuth route updates, and UI.

**Test gate (applies to EVERY phase)**:

```bash
pnpm build
pnpm test:report
# Verify: all existing auth-profile tests pass (see §Test Baseline below)
```

---

## Test Baseline — Existing Auth Test Suites

These tests MUST pass after every phase. Run `pnpm test:report` and verify zero regressions in:

| Package             | Test Files                                                                                                                                                            | Count |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/database` | `auth-profile-model.test.ts`, `auth-profile-indexes.test.ts`, `auth-profile-integration.test.ts`, `auth-profile-factory.test.ts`, `auth-profile-audit-events.test.ts` | 5     |
| `packages/shared`   | `auth-profile-schema.test.ts`, `auth-profile-errors.test.ts`, `auth-profile-service.test.ts`, `client-credentials-service.test.ts`                                    | 4     |
| `packages/compiler` | `auth-dsl-to-runtime.test.ts`                                                                                                                                         | 1     |
| `apps/runtime`      | All `__tests__/auth/auth-profile-*.test.ts` + `__tests__/integration/auth-profile-*.test.ts`                                                                          | ~25   |
| `apps/studio`       | `auth-profile-api.test.ts`, `auth-profile-security.test.ts`, `auth-profile-oauth-*.test.ts`, `auth-pages.test.tsx`, `workspace-auth-profile-list-route.test.ts`       | ~12   |

**Total baseline: ~47 test files, must remain green throughout.**

---

## Phase Summary

| Phase     | Scope                                                                            | Packages Touched                                 | Effort        | New Tests |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------ | ------------- | --------- | -------------------------------------- |
| ~~1~~     | ~~Schema + model: `authorizationMode` field~~                                    | —                                                | ~~0~~         | —         | ✅ Already implemented as `usageMode`  |
| 1         | OAuth schema extension: `authorizationParams`, `tokenParams`, `connectionConfig` | `packages/shared`, `apps/studio` (metadata only) | 1 day         | 12        |
| 2         | Provider endpoints + visibility filtering                                        | `apps/studio` (API routes + client)              | 1.5 days      | 10        |
| 3         | ConnectorConnection bridge (auto-create/delete)                                  | `apps/studio` (API routes), `packages/database`  | 1 day         | 8         |
| 4         | OAuth route updates: consume `authorizationParams`, `connectionConfig`           | `apps/studio` (OAuth routes)                     | 0.5 day       | 6         |
| 5         | UI: Integrations tab + catalog grid + inline expand                              | `apps/studio` (components)                       | 2.5 days      | 6         |
| 6         | UI: Slide-over changes + All Profiles tab enhancements                           | `apps/studio` (components)                       | 1.5 days      | 4         |
| ~~8~~     | ~~Runtime wiring: `authorizationMode` in scope/JIT resolution~~                  | —                                                | ~~0~~         | —         | ✅ Already implemented via `usageMode` |
| **E2E**   | End-to-end test suite for integration auth profiles                              | `apps/studio`                                    | 1.5 days      | 12        |
| **Total** |                                                                                  |                                                  | **~9.5 days** | **~58**   |

---

## ~~Phase 1 (Original): Schema + Model — `authorizationMode` Field~~ — SKIPPED ✅

> **Already implemented.** The `usageMode` field exists in:
>
> - **Model**: `packages/database/src/models/auth-profile.model.ts` — `usageMode` with dynamic default per auth type
> - **Zod schemas**: `packages/shared/src/validation/auth-profile.schema.ts` — `usageMode` in Create/Update schemas with `AUTH_TYPE_USAGE_MODE_MAP` enforcing legal combinations
> - **UI**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — usage mode dropdown
> - **Runtime**: Wired through `resolve-tool-auth.ts`, `auth-scope-policy.ts`, JIT middleware
>
> No work needed. Integration profiles will use the same `usageMode` values as custom profiles.

---

## Phase 1: OAuth Schema Extension

**Goal**: Extend `OAuth2AppConfigSchema` with `authorizationParams`, `tokenParams`, `connectionConfig`.

### Files to Modify

| File                                                             | Change                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/shared/src/validation/auth-profile.schema.ts`          | Add 3 new optional fields to `OAuth2AppConfigSchema`                               |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` | Add `getIntegrationTypeMetadata()` helper (field key already uses `defaultScopes`) |

### Implementation Details

1. **Schema extension** (`auth-profile.schema.ts`):
   - Add to `OAuth2AppConfigSchema`:
     ```
     authorizationParams: z.record(z.string()).optional()
     tokenParams: z.record(z.string()).optional()
     connectionConfig: z.record(z.string()).optional()
     ```
   - Schema is currently `.strict()` — these additions make the new fields valid without affecting existing data

2. **UI metadata** (`auth-type-metadata.ts`):
   - Add `getIntegrationTypeMetadata()` helper for integration-specific form field derivation
   - Note: `oauth2_app` metadata already uses `defaultScopes` (line 198) — no rename needed

### New Tests (12)

| File                                                                     | Tests                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/__tests__/auth-profile/auth-profile-schema.test.ts` | 6 new: accepts authorizationParams, accepts tokenParams, accepts connectionConfig, rejects unknown fields (strict still works for non-listed), each field optional (null/undefined OK), roundtrip with all three fields         |
| `apps/studio/src/__tests__/components/auth-type-metadata.test.ts`        | 6 new: oauth2_app fields include `defaultScopes`, field type is `tags`, getIntegrationTypeMetadata returns correct shape, metadata for each Phase 1 auth type, field keys match Zod schema field names, no duplicate field keys |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/studio` passes
- [ ] 12 new tests passing
- [ ] All baseline tests pass — especially `auth-profile-schema.test.ts` (strict schema didn't break existing validation)
- [ ] Existing `oauth2_app` profiles without new fields still validate

---

## Phase 2: Provider Endpoints + Visibility Filtering

**Goal**: Two new GET endpoints that return the integration catalog enriched with profile counts and Nango OAuth metadata.

### Files to Create/Modify

| File                                                                     | Change                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts` | **New** — project-scoped provider listing                                    |
| `apps/studio/src/app/api/auth-profiles/providers/route.ts`               | **New** — workspace-scoped provider listing                                  |
| `apps/studio/src/api/auth-profiles.ts`                                   | Add `fetchIntegrationProviders()` and `fetchWorkspaceIntegrationProviders()` |

### Implementation Details

1. **Project-scoped endpoint** (`providers/route.ts`):
   - Auth: `requireAuth` + `requireProjectPermission(AUTH_PROFILE_READ)`
   - Load `connector-catalog.json` (static import or read from `@agent-platform/connectors/catalog`)
   - For each connector with Nango match: merge OAuth metadata from `ProviderConfigRegistry`
   - Query `AuthProfile.find({ connector: { $in: connectorNames }, ...visibilityFilter })` with same filter as existing list route (§6.3 visibility rules)
   - Group profiles by connector, count per connector
   - Return response shape per design §6.3
   - Apply OAuth app/token aggregation: `usageMode: 'preconfigured'` → count logical pairs, not raw documents

2. **Workspace-scoped endpoint**: Same logic but `{ projectId: null, scope: 'tenant' }`

3. **Client functions** (`auth-profiles.ts`): Typed fetch wrappers matching existing patterns in the file

### New Tests (10)

| File                                                                                | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts` | **New file** — 10 tests: returns all 26 connectors, includes Nango OAuth metadata for gmail, excludes http (no Nango), profile count matches real DB, visibility filtering hides other users' personal profiles, admin sees all profiles, workspace endpoint returns tenant-only counts, jira-cloud resolves via alias map, shopify shows connectionConfig URL templates, unsupported connectors (amazon-s3) have empty profiles array |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] `GET /api/projects/:pid/auth-profiles/providers` returns 26 connectors with correct shape
- [ ] `GET /api/auth-profiles/providers` returns tenant-only counts
- [ ] Visibility: non-admin user does NOT see other users' personal profiles in counts
- [ ] 10 new tests passing
- [ ] All baseline tests pass

---

## Phase 3: ConnectorConnection Bridge (Auto-Create/Delete)

**Goal**: When an auth profile with `connector` is created, auto-create a thin `ConnectorConnection` bridge. On delete, cascade.

### Files to Modify

| File                                                                                | Change                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` (POST)               | After auth profile creation with `connector`, create bridge ConnectorConnection |
| `apps/studio/src/app/api/auth-profiles/route.ts` (POST)                             | Same for workspace-scoped                                                       |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` (DELETE) | On delete, cascade to bridge ConnectorConnection                                |
| `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts` (DELETE)               | Same for workspace-scoped                                                       |

### Implementation Details

1. **Bridge creation** (in POST handler, after `AuthProfile.create()`):
   - Check if `connector` field is set on the new profile
   - If yes, create `ConnectorConnection` per design §6.6:
     - `connectorName`, `tenantId`, `projectId`, `scope`, `authProfileId`, `status: 'active'`
     - `encryptedCredentials: ''` — credentials resolved via authProfileId
   - Map `authProfile.authType` → connection `authType` (e.g., `oauth2_app` → `oauth2`)

2. **Bridge deletion** (in DELETE handler, before/after `AuthProfile.deleteOne()`):
   - `ConnectorConnection.deleteMany({ authProfileId: profileId, tenantId })`

3. **No changes to `connection-resolver.ts`** — the bridge connection is found by existing query logic

### New Tests (8)

| File                                                                             | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-bridge.test.ts` | **New file** — 8 tests: creating profile with connector creates bridge ConnectorConnection, bridge has correct connectorName/tenantId/projectId/authProfileId, bridge encryptedCredentials is empty, deleting profile deletes bridge, creating profile without connector creates no bridge, workspace profile creates tenant-scoped bridge, authType mapping (oauth2_app → oauth2, api_key → api_key), updating profile scope updates bridge |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Creating Gmail auth profile → `ConnectorConnection` with `authProfileId` exists in DB
- [ ] Deleting that profile → bridge ConnectorConnection also deleted
- [ ] Creating a custom (non-connector) profile → no bridge created
- [ ] 8 new tests passing
- [ ] All baseline tests pass (especially existing connection tests)

---

## Phase 4: OAuth Route Updates

**Goal**: Update `initiate` and `user-consent` routes to consume `authorizationParams` and `connectionConfig` from the extended schema.

### Files to Modify

| File                                                                              | Change                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`     | Read `authorizationParams` and `connectionConfig` from profile config, merge into OAuth URL |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` | Same: merge `authorizationParams` into authorization URL                                    |

### Implementation Details

1. **Initiate route** (`initiate/route.ts`):
   - After building the authorization URL from `authorizationUrl`, `defaultScopes`, `scopeSeparator`:
   - If `config.authorizationParams` exists, append each key/value as query params (e.g., `access_type=offline`, `prompt=consent`)
   - If `config.connectionConfig` exists, resolve URL templates: replace `${connectionConfig.subdomain}` with stored values

2. **User-consent route** (`user-consent/route.ts`):
   - Same `authorizationParams` merging logic
   - Same `connectionConfig` URL template resolution

### New Tests (6)

| File                                                                      | Tests                                                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/auth-profile-oauth-initiate-route.test.ts`     | 3 new: authorizationParams merged into auth URL, connectionConfig resolves URL templates (Salesforce instance), both combined (Jira: audience + prompt params) |
| `apps/studio/src/__tests__/auth-profile-oauth-user-consent-route.test.ts` | 3 new: same three scenarios for user-consent path                                                                                                              |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Gmail initiate URL includes `prompt=consent` when authorizationParams set
- [ ] Salesforce initiate URL resolves `{instance}` from connectionConfig
- [ ] 6 new tests passing
- [ ] All baseline OAuth tests still pass

---

## Phase 5: UI — Integrations Tab + Catalog Grid

**Goal**: Add the Integrations tab to both project and workspace auth profile pages with a connector catalog grid and inline expand.

### Files to Create/Modify

| File                                                                     | Change                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`        | **New** — catalog grid with search, category filter            |
| `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`           | **New** — expandable card with profile list, aggregation rules |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Add tab bar ("All Profiles" / "Integrations")                  |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` | Add same tab bar                                               |

### Implementation Details

1. **IntegrationAuthTab** (`IntegrationAuthTab.tsx`):
   - Props: `scope: 'project' | 'tenant'`, `projectId?: string`
   - Fetches providers from new endpoint (Phase 2)
   - Renders grid of `IntegrationCard` components
   - Search filters by connector name/description
   - Category dropdown filters by category
   - Unsupported connectors (amazon-s3, postgres): show "Unsupported — use Connector Connections" badge, no create button

2. **IntegrationCard** (`IntegrationCard.tsx`):
   - Collapsed: connector icon, name, auth type badge, profile count
   - Expanded: profile list with aggregation rules (design §4.2):
     - Preconfigured OAuth (`usageMode: 'preconfigured'`) → show `oauth2_token` status (hide app)
     - JIT/Preflight OAuth (`usageMode: 'jit'/'preflight'`) → show `oauth2_app` only (hide tokens)
     - Non-OAuth → show as-is
   - "Create New Profile" button → opens slide-over (Phase 6)
   - At project level: tenant profiles shown read-only with "Manage in Workspace" indicator

3. **Tab bar** on both pages: simple tab component switching between existing list and new IntegrationAuthTab

### New Tests (6)

| File                                                                 | Tests                                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/components/integration-auth-tab.test.tsx` | **New** — 3 tests: renders all connectors from provider endpoint, search filters by name, unsupported connectors show badge |
| `apps/studio/src/__tests__/components/integration-card.test.tsx`     | **New** — 3 tests: collapsed shows profile count, expanded shows profile list, preconfigured OAuth shows token status only  |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Both pages render tab bar
- [ ] Integrations tab shows 26 connectors in grid
- [ ] Gmail card expands to show profiles with correct aggregation
- [ ] Amazon S3 card shows "Unsupported" badge
- [ ] 6 new tests passing
- [ ] All baseline tests pass

---

## Phase 6: UI — Slide-Over + All Profiles Tab Enhancements

**Goal**: Enhance the auth profile create/edit slide-over for integration profiles (Nango pre-fill, connection config). Add connector badge and aggregation to All Profiles tab. The usage mode dropdown already exists — only need to disable `jit`/`preflight` at workspace level.

### Files to Modify

| File                                                                     | Change                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`      | Add `preselectedConnector` prop, Nango pre-fill, connection config fields (usage mode dropdown already exists) |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`         | Add `getIntegrationTypeMetadata()` helper                                                                      |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Add connector badge column, OAuth aggregation in All Profiles list                                             |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` | Disable `jit`/`preflight` usage modes for workspace scope (§3.2 constraint)                                    |

### Implementation Details

1. **Slide-over** (`AuthProfileSlideOver.tsx`):
   - New prop: `preselectedConnector?: { name: string; providerConfig: ProviderConfig }`
   - When set: pre-fill OAuth URLs, defaultScopes, PKCE from provider config
   - Usage mode dropdown already exists — filter options using `AUTH_TYPE_USAGE_MODE_MAP` (already done)
   - At workspace level: disable `jit`/`preflight` options with tooltip (§3.2 constraint)
   - If provider URL has `${connectionConfig.*}` templates: render connection config input fields
   - Fields are pre-filled but overridable (design decision #1)

2. **All Profiles tab enhancements** (`AuthProfilesPage.tsx`):
   - Add "Connector" badge column (shows connector name or "—" for custom)
   - Apply same OAuth aggregation: `preconfigured` → show token row with status, `jit`/`preflight` → show app row only

3. **Workspace constraint** (`WorkspaceAuthProfilesPage.tsx`):
   - Pass `disableJitModes={true}` to slide-over when at workspace level — disables `jit` and `preflight` in the existing usage mode dropdown

### New Tests (4)

| File                                                                               | Tests                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/components/auth-profile-slideover-integration.test.tsx` | **New** — 4 tests: preselectedConnector pre-fills OAuth URLs, connection config fields shown for Shopify, usage mode dropdown shows correct options per auth type, workspace disables jit/preflight modes |

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Creating Gmail profile from Integrations tab → slide-over pre-fills Google OAuth URLs
- [ ] Shopify → shows subdomain input in connection config section
- [ ] Workspace → `jit`/`preflight` usage modes disabled in dropdown
- [ ] All Profiles tab shows connector badge column
- [ ] 4 new tests passing
- [ ] All baseline tests pass

---

## ~~Phase 8 (Original): Runtime Wiring — `authorizationMode` in Scope/JIT Resolution~~ — SKIPPED ✅

> **Already implemented.** The `usageMode` field is already wired through:
>
> - `resolve-tool-auth.ts` — reads `usageMode` from the resolved profile
> - `auth-scope-policy.ts` — uses `usageMode` alongside `connection_mode` for scope decisions
> - `auth-profile-tool-middleware.ts` — uses `usageMode` for JIT auth eligibility
>
> The existing `AUTH_TYPE_USAGE_MODE_MAP` enforces legal combinations. No runtime changes needed.

---

## E2E Test Suite: Integration Auth Profiles

**Goal**: True end-to-end tests exercising the real system through HTTP API. No mocks, no direct DB access.

### File

`apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` — **New**

### Infrastructure

- Real Express server on random port (`{ port: 0 }`)
- MongoMemoryServer for DB
- Full middleware chain (auth, rate limiting, tenant isolation, validation)
- Seed data via POST endpoints, assert via GET responses
- Pre-populate `providers.json` for Nango data

### E2E Test Cases (12)

| #   | Test Case                                              | Verifies                                                                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | Create preconfigured OAuth integration profile (Gmail) | Profile created with `connector: 'gmail'`, `usageMode: 'preconfigured'`                                       |
| 2   | Bridge ConnectorConnection auto-created                | After creating Gmail profile, `GET /connections` finds bridge with `authProfileId`                            |
| 3   | Create API key integration profile (Stripe)            | Profile created with `connector: 'stripe'`, `usageMode: 'preconfigured'`                                      |
| 4   | Provider endpoint returns enriched catalog             | `GET /providers` returns Gmail with OAuth metadata from Nango                                                 |
| 5   | Provider endpoint visibility filtering                 | Personal profile excluded from non-admin's provider counts                                                    |
| 6   | Nango pre-fill in provider response                    | Google Calendar provider has `authorizationUrl`, `tokenUrl`, `defaultScopes`                                  |
| 7   | Jira alias resolution                                  | `jira-cloud` connector resolves to `jira` Nango provider with OAuth2                                          |
| 8   | Shopify connectionConfig URL templates                 | Shopify provider includes template URLs with `${connectionConfig.subdomain}`                                  |
| 9   | Unsupported connector (Amazon S3)                      | Provider response includes amazon-s3 with no OAuth metadata, empty profiles                                   |
| 10  | Delete profile cascades to bridge                      | Delete Gmail profile → `GET /connections` no longer finds bridge                                              |
| 11  | Workspace profile inheritance                          | Create tenant Gmail profile → project provider endpoint shows it as inherited                                 |
| 12  | usageMode validation rules                             | Reject `jit` with `api_key` (per AUTH_TYPE_USAGE_MODE_MAP), workspace profile rejects `jit`/`preflight` modes |

### Exit Criteria

- [ ] All 12 E2E tests pass against real server
- [ ] No `vi.mock()` or `jest.mock()` in the test file
- [ ] No direct Mongoose model imports (API-only interaction)
- [ ] All baseline tests still pass

---

## Dependency Graph

```
Phase 1 (OAuth schema extension)
    ↓
Phase 2 (provider endpoints) ──→ Phase 5 (UI: Integrations tab)
    ↓                                    ↓
Phase 3 (bridge) ─────────────→ Phase 6 (UI: slide-over + All Profiles)
    ↓
Phase 4 (OAuth routes)
                                    E2E Test Suite (after all phases)
```

**Parallelization**: Phases 5-6 (UI) can proceed in parallel with Phase 4 (OAuth routes) after Phase 3 completes.

> **Phases removed**: Original Phase 1 (`authorizationMode` field) and Phase 8 (runtime wiring) — both already implemented via `usageMode`.

---

## Risk Mitigations

| Risk                                          | Mitigation                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.strict()` schema breaks existing profiles   | Phase 1 only adds optional fields — strict mode allows them when listed. Test with existing profile fixtures.                  |
| Bridge creation fails silently                | Phase 3 tests verify bridge exists after create, and is deleted after profile delete. E2E test #2 and #10 cover end-to-end.    |
| Visibility filtering leaks personal profiles  | Phase 2 tests specifically verify non-admin cannot see other users' personal profiles in counts or arrays. E2E test #5 covers. |
| Runtime behavior change for existing profiles | `usageMode` is already implemented and tested with ~25 baseline runtime tests. No new runtime changes introduced.              |
| UI regression in auth profile pages           | Phases 5-6 add tabs without modifying existing list rendering. Baseline `auth-pages.test.tsx` must pass.                       |

---

## Commit Convention

Each phase = one commit (max 2 if test file is large):

```
[ABLP-<ticket>] feat(shared): extend OAuth2AppConfigSchema with provider metadata fields
[ABLP-<ticket>] feat(studio): add integration provider endpoints with visibility filtering
[ABLP-<ticket>] feat(studio): auto-create ConnectorConnection bridge for integration profiles
[ABLP-<ticket>] feat(studio): consume authorizationParams and connectionConfig in OAuth routes
[ABLP-<ticket>] feat(studio): add Integrations tab with catalog grid and inline expand
[ABLP-<ticket>] feat(studio): enhance slide-over with Nango pre-fill and connection config
[ABLP-<ticket>] test(studio): add E2E test suite for integration auth profiles
```

Pre-commit: `npx prettier --write <files>` + `pnpm build --filter=<package>` + verify tests pass.
