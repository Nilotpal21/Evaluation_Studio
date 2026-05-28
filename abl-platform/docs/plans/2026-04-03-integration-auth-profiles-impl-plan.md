# LLD: Integration Auth Profiles

**Feature Spec**: `docs/features/sub-features/integration-auth-profiles.md`
**HLD**: `docs/specs/integration-auth-profiles.hld.md`
**Test Spec**: `docs/testing/sub-features/integration-auth-profiles.md`
**Status**: DONE
**Date**: 2026-04-03

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                 | Rationale                                                                                        | Alternatives Rejected                                                         |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| D-1 | Provider endpoint calls `ProviderConfigRegistry.getProviderConfig()` directly            | Endpoint needs raw Nango data (template URLs, authorizationParams) + profile counts              | Reusing `enrichWithOAuth()` — has merge-priority semantics inappropriate here |
| D-2 | `connectionConfigFields` extraction as shared utility in `apps/studio/src/lib/`          | Regex used in endpoint + UI; prevents drift                                                      | Inline in route handler — duplicated logic risk                               |
| D-3 | Bridge `userId` = `createdBy` for scope `'user'`, `null` for `'tenant'`                  | Matches `ConnectorConnection` unique index `{tenantId, projectId, connectorName, scope, userId}` | Always `null` — blocks multiple personal profiles per connector               |
| D-4 | Use `withTransaction()` from `@agent-platform/shared/repos/mongo-tx`                     | Handles standalone MongoDB gracefully; established pattern in codebase                           | Manual `startSession` — no fallback for standalone                            |
| D-5 | `preselectedConnector` skips type selection step (like `preselectedAuthType`)            | Connector determines auth type; step is redundant                                                | Show filtered type selector — unnecessary UX friction                         |
| D-6 | `authorizationParams` are supplementary — skip keys already set by standard OAuth params | Standard OAuth params (client_id, redirect_uri, response_type) must never be overwritten         | Unconditional set — could break OAuth flow                                    |

### Key Interfaces & Types

```typescript
// NEW: Provider endpoint response (apps/studio/src/app/api/.../providers/route.ts)
interface IntegrationProvider {
  connectorName: string;
  displayName: string;
  description: string;
  category: string;
  availableAuthTypes: string[];
  oauth2?: {
    authorizationUrl: string; // raw from Nango, may contain ${connectionConfig.xxx}
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    pkce: boolean; // Nango field — UI maps to pkceRequired
    authorizationParams?: Record<string, string>;
    tokenParams?: Record<string, string>;
    connectionConfigFields?: string[]; // parsed from URL templates
  };
  profileCount: number;
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

// NEW: Utility for parsing Nango URL templates (apps/studio/src/lib/connection-config-utils.ts)
function extractConnectionConfigFields(urls: string[]): string[];
// Regex: /\$\{connectionConfig\.(\w+)\}/g
// Input: ['https://${connectionConfig.instance}.salesforce.com/...']
// Output: ['instance']

function resolveConnectionConfigTemplate(url: string, config: Record<string, string>): string;
// Input: ('https://${connectionConfig.instance}.salesforce.com/...', { instance: 'myco' })
// Output: 'https://myco.salesforce.com/...'
```

### Module Boundaries

| Module                       | Responsibility                                                              | Depends On                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/shared` (schema)   | Zod validation for `authorizationParams`, `tokenParams`, `connectionConfig` | Nothing new                                                                                              |
| `apps/studio` API routes     | Provider endpoints, bridge create/delete, OAuth param merging               | `packages/shared` (schema), `packages/connectors` (ProviderConfigRegistry), `packages/database` (models) |
| `apps/studio` UI components  | Integrations tab, catalog grid, slide-over pre-fill                         | `apps/studio` API (client functions)                                                                     |
| `packages/connectors` (read) | `ProviderConfigRegistry`, `connector-catalog.json`, alias resolution        | `providers.json` (static)                                                                                |

---

## 2. File-Level Change Map

### New Files

| File                                                                                        | Purpose                                                           | LOC Estimate |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts`                    | Project-scoped provider endpoint                                  | ~120         |
| `apps/studio/src/app/api/auth-profiles/providers/route.ts`                                  | Workspace-scoped provider endpoint                                | ~100         |
| `apps/studio/src/lib/connection-config-utils.ts`                                            | URL template parsing + resolution utilities                       | ~40          |
| `apps/studio/src/lib/integration-provider-service.ts`                                       | Shared logic: catalog merge, visibility filter, response assembly | ~150         |
| `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`                           | Catalog grid with search + category filter                        | ~200         |
| `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`                              | Expandable connector card with profile list                       | ~180         |
| `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts`                       | E2E tests (26 passing scenarios)                                  | ~600         |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`         | Targeted route tests for provider endpoints                       | ~350         |
| `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts`            | Unit tests for schema extension                                   | ~120         |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts` | Integration tests for OAuth authorizationParams merging           | ~150         |

### Modified Files

| File                                                                              | Change Description                                                         | Risk |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---- |
| `packages/shared/src/validation/auth-profile.schema.ts`                           | Add 3 optional fields to `OAuth2AppConfigSchema` before `.strict()` (L183) | Med  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                    | POST: add bridge creation after `AuthProfile.create()` (L258-277)          | Med  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`        | DELETE: add bridge cascade-delete before/after profile delete (L341-428)   | Med  |
| `apps/studio/src/app/api/auth-profiles/route.ts`                                  | POST: same bridge creation for workspace scope                             | Med  |
| `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts`                      | DELETE: same bridge cascade-delete for workspace scope                     | Med  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`     | Merge `authorizationParams` into auth URL (after L174)                     | Low  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` | Same `authorizationParams` handling                                        | Low  |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`                   | Add tab bar, connector badge column, OAuth aggregation                     | Low  |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx`          | Add tab bar, jit/preflight disabled                                        | Low  |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`               | Add `preselectedConnector` prop, Nango pre-fill, connection config fields  | Med  |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`                  | Add `getIntegrationTypeMetadata()` helper                                  | Low  |
| `apps/studio/src/api/auth-profiles.ts`                                            | Add `fetchIntegrationProviders()` + workspace variant                      | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: OAuth Schema Extension

**Goal**: Extend `OAuth2AppConfigSchema` with three new optional fields while preserving `.strict()` backward compatibility.

**Tasks**:

1.1. Read `packages/shared/src/validation/auth-profile.schema.ts` and add the following fields to `OAuth2AppConfigSchema` before the `.strict()` call at line 183:

```typescript
authorizationParams: z.record(z.string(), z.string()).optional(),
tokenParams: z.record(z.string(), z.string()).optional(),
connectionConfig: z.record(z.string(), z.string()).optional(),
```

1.2. Write unit tests in `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts`:

- Test 1: Schema accepts `authorizationParams: { access_type: 'offline', prompt: 'consent' }`
- Test 2: Schema accepts `tokenParams: { audience: 'https://api.example.com' }`
- Test 3: Schema accepts `connectionConfig: { instance: 'mycompany' }`
- Test 4: Schema rejects `authorizationParams: "string"` (wrong type)
- Test 5: Schema rejects `connectionConfig: { key: 123 }` (non-string values)
- Test 6: Schema still rejects unknown fields (`.strict()` preserved)
- Test 7: Existing `oauth2_app` profiles without new fields still validate
- Test 8: All three fields can be present simultaneously

  1.3. Run `pnpm build --filter=@agent-platform/shared` to verify compilation.

**Files Touched**:

- `packages/shared/src/validation/auth-profile.schema.ts` — add 3 fields before `.strict()` at line 183
- `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts` — new test file

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/shared` succeeds with 0 errors
- [ ] All 8 unit tests pass
- [ ] Existing auth-profile schema tests remain green (`pnpm test --filter=@agent-platform/shared`)
- [ ] `.strict()` mode confirmed: unknown fields still rejected

**Test Strategy**:

- Unit: Zod schema validation with valid/invalid inputs
- No integration or E2E tests needed for this phase

**Rollback**: Remove the 3 lines from `OAuth2AppConfigSchema`. Optional fields — removal has no effect on existing data.

---

### Phase 2: Provider Endpoints + Visibility Filtering

**Goal**: Create two GET endpoints that return the connector catalog enriched with Nango OAuth metadata and per-connector profile counts, with visibility filtering.

**Prerequisite**: Run `pnpm connectors:import-providers` to populate `packages/connectors/src/adapters/nango/generated/providers.json`.

**Tasks**:

2.1. Create `apps/studio/src/lib/connection-config-utils.ts` with:

```typescript
const TEMPLATE_REGEX = /\$\{connectionConfig\.(\w+)\}/g;

export function extractConnectionConfigFields(urls: string[]): string[] {
  const fields = new Set<string>();
  for (const url of urls) {
    for (const match of url.matchAll(TEMPLATE_REGEX)) {
      fields.add(match[1]);
    }
  }
  return [...fields];
}

export function resolveConnectionConfigTemplate(
  url: string,
  config: Record<string, string>,
): string {
  return url.replace(TEMPLATE_REGEX, (_, key) => {
    const value = config[key];
    if (!value) throw new Error(`Missing connectionConfig value: ${key}`);
    return value;
  });
}
```

2.2. Create `apps/studio/src/lib/integration-provider-service.ts` — shared logic used by both project and workspace provider endpoints:

- Import `getProviderConfig`, `listProviders` from `@agent-platform/connectors/auth` (standalone functions, not class methods)
- Import `connector-catalog.json` via relative path (matching existing pattern in `apps/studio/src/app/api/projects/[id]/connectors/route.ts:11`)
- Include `const log = createLogger('integration-provider-service')` at module level
- Reuse the shared alias resolution exported from `packages/connectors/src/catalog/extract-entry.ts`, including the fallback that prefers an alias provider when the exact-match Nango entry does not expose OAuth URLs (for example `microsoft-teams -> microsoft`)
- `buildIntegrationProviders(options)`: merges connector catalog + Nango data + auth profile counts
- Input: `{ tenantId, projectId?, userId, isAdmin }`
- Loads `connector-catalog.json` entries
- For each connector, calls `getProviderConfig(name)` (with alias resolution)
- Queries `AuthProfile.find({ tenantId, connector: { $in: names }, ...visibilityFilter })` — single query
- **Important**: Provider counts are aggregated from `AuthProfile.find()`, NOT `ConnectorConnection`. Workspace AuthProfiles have `projectId: null`. Bridge ConnectorConnections use `projectId: '_workspace'` (required field sentinel) but are not queried by the provider endpoint. This prevents a projectId mismatch.
- Groups profiles by connector, applies OAuth aggregation (preconfigured shows token, jit shows app)
- Returns `IntegrationProvider[]`

  2.3. Create project-scoped endpoint `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts` (include `const log = createLogger('integration-providers-route')` at module level):

```typescript
export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ request, user, params, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const projectId = params.id;
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT);

    const providers = await buildIntegrationProviders({
      tenantId,
      projectId,
      userId: user.id,
      isAdmin,
    });
    return NextResponse.json({ success: true, data: providers });
  },
);
```

2.4. Create workspace-scoped endpoint `apps/studio/src/app/api/auth-profiles/providers/route.ts`:

```typescript
export const GET = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ request, user, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT);

    const providers = await buildIntegrationProviders({
      tenantId,
      projectId: null, // tenant-only profiles
      userId: user.id,
      isAdmin,
    });
    return NextResponse.json({ success: true, data: providers });
  },
);
```

2.5. Add client API functions in `apps/studio/src/api/auth-profiles.ts`:

```typescript
export async function fetchIntegrationProviders(
  projectId: string,
): Promise<{ success: boolean; data: IntegrationProvider[] }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/providers`,
  );
  return handleResponse<{ success: boolean; data: IntegrationProvider[] }>(res);
}

export async function fetchWorkspaceIntegrationProviders(): Promise<{
  success: boolean;
  data: IntegrationProvider[];
}> {
  const res = await apiFetch('/api/auth-profiles/providers');
  return handleResponse<{ success: boolean; data: IntegrationProvider[] }>(res);
}
```

2.6. Write integration tests in `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`:

- INT-1: Provider endpoint returns runtime-backed connectors plus the auth-only virtual provider entries
- INT-2: Gmail entry includes Nango OAuth metadata (authorizationUrl, tokenUrl, defaultScopes, pkce)
- INT-3: Stripe entry has `availableAuthTypes: ['api_key']`, no oauth2 metadata
- INT-4: `jira-cloud` resolves via alias to Nango `jira` provider
- INT-5: `microsoft-teams` resolves via alias to Nango `microsoft` provider when the direct provider is `authMode: 'none'`
- INT-6: Visibility filtering — admin sees all profiles, member sees shared + own personal
- INT-7: Unsupported connectors (no auth-profile mapping) return without OAuth metadata
- INT-8: Profile counts are visibility-filtered (personal profiles excluded from other users' counts)
- INT-9: `connectionConfigFields` extracted from Salesforce URL templates
- INT-10: Empty `providers.json` returns connectors without OAuth metadata (degraded mode)
- INT-11: Alias resolution: `jira-cloud` and `microsoft-teams` follow the shared `NANGO_ALIAS_MAP` pattern

**Files Touched**:

- `apps/studio/src/lib/connection-config-utils.ts` — new
- `apps/studio/src/lib/integration-provider-service.ts` — new
- `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts` — new
- `apps/studio/src/app/api/auth-profiles/providers/route.ts` — new
- `apps/studio/src/api/auth-profiles.ts` — add 2 functions
- `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts` — new

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds
- [ ] All 10 integration tests pass
- [ ] `GET /api/projects/:pid/auth-profiles/providers` returns the current 36-entry visible catalog with Nango enrichment
- [ ] Visibility filtering confirmed: personal profiles hidden from other users
- [ ] `connectionConfigFields` correctly extracted from template URLs
- [ ] Existing auth-profile tests remain green

**Test Strategy**:

- Integration: Mock auth middleware, use real Mongoose models with MongoMemoryServer, real ProviderConfigRegistry
- No mocking of ProviderConfigRegistry or connector catalog — use actual data

**Rollback**: Delete the 2 new route files and the service file. Remove 2 functions from `auth-profiles.ts` client API.

---

### Phase 3: ConnectorConnection Bridge Auto-Create/Delete

**Goal**: Auto-create a bridge `ConnectorConnection` when an auth profile with `connector` is created, and cascade-delete when deleted. Use MongoDB transactions for atomicity.

**Tasks**:

3.1. Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` POST handler (after line 277):

**Important**: `ConnectorConnection.projectId` is `required: true` in the Mongoose schema. For project-scoped routes, use `params.id`. For workspace routes, use a sentinel value (see task 3.4).

```typescript
import { withTransaction } from '@agent-platform/shared/repos';

// Wrap the AuthProfile.create + bridge create in a transaction
const result = await withTransaction(async (session) => {
  const profile = await AuthProfile.create([{ ...profileData }], session ? { session } : {});

  if (profile[0].connector) {
    const { ConnectorConnection } = await import('@agent-platform/database/models');
    // Auth profile scope 'project' maps to bridge scope 'user' because
    // ConnectorConnection uses 'user' for non-tenant-scoped credentials.
    const isUserScope = profile[0].scope !== 'tenant';

    // Pre-check: skip bridge creation if one already exists (idempotency, HLD concern #7)
    const existingBridge = await ConnectorConnection.findOne(
      {
        authProfileId: profile[0]._id,
        tenantId: profile[0].tenantId,
      },
      null,
      session ? { session } : {},
    );

    if (!existingBridge) {
      await ConnectorConnection.create(
        [
          {
            connectorName: profile[0].connector,
            tenantId: profile[0].tenantId,
            projectId, // from route params.id — always present on project routes
            scope: isUserScope ? 'user' : 'tenant',
            userId: isUserScope ? user.id : null,
            authType: mapAuthTypeForBridge(profile[0].authType),
            authProfileId: profile[0]._id,
            status: 'active',
            encryptedCredentials: '',
            encryptionKeyVersion: 1,
            displayName: profile[0].name,
          },
        ],
        session ? { session } : {},
      );
    }
  }

  return profile[0];
});
```

3.2. Add `mapAuthTypeForBridge()` helper (in the same file or a shared utility):

```typescript
function mapAuthTypeForBridge(
  authType: string,
): 'oauth2' | 'api_key' | 'bearer' | 'custom' | 'none' {
  if (authType.startsWith('oauth2')) return 'oauth2';
  if (authType === 'api_key') return 'api_key';
  if (authType === 'bearer') return 'bearer';
  return 'custom';
}
```

3.3. Modify DELETE handler in `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` (after profile delete at line 420):

```typescript
// After AuthProfile.findOneAndDelete succeeds:
// NOTE: Intentionally NOT wrapped in a transaction. A bridge without a parent profile
// is harmless (empty encryptedCredentials, orphaned pointer). The profile deletion
// is the primary operation; bridge cleanup is best-effort. See HLD concern #6.
if (deletedProfile?.connector) {
  const { ConnectorConnection } = await import('@agent-platform/database/models');
  await ConnectorConnection.deleteOne({
    authProfileId: deletedProfile._id,
    tenantId,
  });
}
```

3.4. Apply bridge creation logic to workspace POST in `apps/studio/src/app/api/auth-profiles/route.ts`.

**Workspace projectId handling**: `ConnectorConnection.projectId` is `required: true`. Workspace (tenant-scoped) auth profiles have `projectId: null`. For bridge creation on workspace routes, use `projectId: '_workspace'` as a sentinel value. This is consistent with the existing pattern in `AuthProfileSlideOver.tsx` where `projectId === '_workspace'` is used for workspace scope detection (line 191). The bridge's `scope: 'tenant'` + `projectId: '_workspace'` combination is unique and will not conflict with project-level bridges.

3.5. Apply the same bridge cascade-delete to workspace DELETE in `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts`.

3.6. Cover bridge lifecycle via the landed regression mix instead of a dedicated `auth-profile-bridge.test.ts` file:

- E2E: `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` verifies bridge create/delete and inheritance paths through the real HTTP surface
- Targeted route coverage: broader auth-profile route suites such as `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts` continue to cover adjacent CRUD and consumer behavior
- Post-implementation note: no dedicated `auth-profile-bridge.test.ts` landed, so bridge rollback/cascade remains an area where stronger non-mocked regression coverage would still be valuable

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` — wrap POST in transaction, add bridge
- `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` — add cascade delete
- `apps/studio/src/app/api/auth-profiles/route.ts` — same bridge creation
- `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts` — same cascade delete
- `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` — bridge lifecycle coverage lands here

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds
- [ ] Relevant E2E and targeted route tests pass
- [ ] Bridge creation path verified through the real HTTP surface
- [ ] Bridge cascade-delete verified on profile delete
- [ ] POST without `connector` unchanged (no regression)
- [ ] Existing auth-profile tests remain green

**Test Strategy**:

- E2E: Real Express + MongoMemoryServer coverage for bridge create/delete flows in the public API
- Targeted route tests: mocked-boundary regression coverage around adjacent auth-profile CRUD behavior

**Rollback**: Revert the 4 route files. Bridge documents can be cleaned via `ConnectorConnection.deleteMany({ authProfileId: { $exists: true, $ne: null }, encryptedCredentials: '' })`.

---

### Phase 4: OAuth Route Updates

**Goal**: Update OAuth `initiate` and `user-consent` routes to consume `authorizationParams` from profile config.

**Tasks**:

4.1. Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`:

After the standard OAuth params are set (after line 174), add:

```typescript
// Merge authorizationParams from profile config (e.g., access_type=offline, prompt=consent)
if (profile.config?.authorizationParams) {
  for (const [key, value] of Object.entries(profile.config.authorizationParams)) {
    // Only set if not already present (standard OAuth params take precedence)
    if (!authUrl.searchParams.has(key)) {
      authUrl.searchParams.set(key, value);
    }
  }
}
```

4.2. Apply the same logic to `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` if it constructs an authorization URL.

4.3. Add unresolved template validation to the `initiate` route (FR-5 error path):

After loading the profile and before building the authorization URL, check if the stored `config.authorizationUrl` or `config.tokenUrl` still contains `${connectionConfig.xxx}` patterns (this would mean the UI did not resolve them properly, or the profile was created via API without resolution):

```typescript
import { extractConnectionConfigFields } from '@/lib/connection-config-utils';

const unresolvedFields = extractConnectionConfigFields([
  profile.config?.authorizationUrl ?? '',
  profile.config?.tokenUrl ?? '',
]);
if (unresolvedFields.length > 0) {
  return errorJson(
    `Unresolved template variables in OAuth URL: ${unresolvedFields.join(', ')}. Provide connectionConfig values.`,
    400,
    'UNRESOLVED_TEMPLATE_VARS' as ErrorCode,
  );
}
```

Apply the same check to `user-consent/route.ts`.

4.4. Write integration tests in `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`:

- INT-1: `authorizationParams` merged as query params in authorization URL
- INT-2: Standard OAuth params (client_id, redirect_uri, response_type) are NOT overwritten by authorizationParams
- INT-3: Empty `authorizationParams` has no effect on URL (backward compatible)
- INT-4: `connectionConfig` values stored in profile config are accessible at initiate time (no resolution needed — URLs already resolved by UI per Option D)
- INT-5: Initiate returns 400 with `UNRESOLVED_TEMPLATE_VARS` when URL contains `${connectionConfig.xxx}` patterns

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts` — add param merging
- `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` — same
- Integration tests (extend existing or new file)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds
- [ ] All 5 integration tests pass
- [ ] `authorizationParams` appear in generated authorization URL
- [ ] Standard OAuth params not overwritten
- [ ] Existing OAuth tests remain green

**Test Strategy**:

- Integration: Test URL construction with mock profile containing `authorizationParams`

**Rollback**: Remove the param-merging block from both route files. No data changes.

---

### Phase 5: UI — Integrations Tab + Catalog Grid

**Goal**: Add "Integrations" tab to both auth profile pages with a browsable catalog grid of connectors.

**Tasks**:

5.1. Create `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`:

- Props: `{ scope: 'project' | 'workspace', projectId: string, onCreateProfile: (connector: string) => void }`
- Uses `useSWR` with stable key (e.g., `/api/projects/${projectId}/auth-profiles/providers`) wrapping `fetchIntegrationProviders(projectId)` or `fetchWorkspaceIntegrationProviders()` based on scope. SWR key must be stable for `mutate()` invalidation in Phase 6.
- Renders a grid of `IntegrationCard` components
- Search input filters by `displayName` and `connectorName`
- Category dropdown filters by `category`
- Loading state, empty state, error state

  5.2. Create `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`:

- Props: `{ provider: IntegrationProvider, scope: 'project' | 'workspace', onCreateProfile: () => void }`
- Collapsed: connector name, auth type badge, profile count
- Expanded: profile list with OAuth aggregation (preconfigured shows token status, jit shows app only)
- Workspace-scoped profiles at project level shown as read-only with "Workspace" badge
- "Create New Profile" button at bottom of expanded section
- Unsupported connectors (no `oauth2` and `availableAuthTypes` empty): show "Unsupported" badge, no create button

  5.3. Add tab bar to `AuthProfilesPage.tsx`:

- State: `activeTab: 'all' | 'integrations'`
- Tab bar between header and filter section
- When `activeTab === 'integrations'`, render `IntegrationAuthTab` instead of profile list
- Add connector badge column to the "All Profiles" table

  5.4. Add same tab bar to `WorkspaceAuthProfilesPage.tsx` with `scope='workspace'`.

  5.5. Add `getIntegrationTypeMetadata()` to `auth-type-metadata.ts`:

- Maps connector name → available auth types from provider data
- Used by `IntegrationCard` for type display

  5.6. **i18n**: Add translation keys to `packages/i18n/locales/en/studio.json` under `auth_profiles.integrations`:

- Tab labels: `tab_all_profiles`, `tab_integrations`
- Grid: `search_placeholder`, `category_filter_label`, `empty_state_title`, `empty_state_description`
- Card: `profiles_count`, `create_new_profile`, `unsupported_badge`, `workspace_badge`, `custom_badge`
- Slide-over: `connection_config_section_label`, `url_preview_label`, `jit_disabled_tooltip`
- Use `useTranslations('auth_profiles')` namespace matching existing auth-profile components.

  5.7. Write unit tests:

- `apps/studio/src/__tests__/components/integration-auth-tab.test.tsx`:
  - Test 1: Renders catalog grid with connector cards
  - Test 2: Search filters by connector name
  - Test 3: Category filter works
  - Test 4: Unsupported connectors show badge
- `apps/studio/src/__tests__/components/integration-card.test.tsx`:
  - Test 1: Card expands/collapses on click
  - Test 2: OAuth aggregation — preconfigured shows token, jit shows app
  - Test 3: Workspace profiles shown as read-only at project level

**Files Touched**:

- `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx` — new
- `apps/studio/src/components/auth-profiles/IntegrationCard.tsx` — new
- `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx` — add tab bar
- `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` — add tab bar
- `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` — add helper
- `apps/studio/src/__tests__/components/integration-auth-tab.test.tsx` — new
- `apps/studio/src/__tests__/components/integration-card.test.tsx` — new

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds
- [ ] All 7 unit tests pass
- [ ] Tab switching works between "All Profiles" and "Integrations"
- [ ] Catalog grid renders with search and category filtering
- [ ] Cards expand inline to show profiles
- [ ] Unsupported connectors have badge, no create button

**Test Strategy**:

- Unit: React Testing Library with mocked API responses (component-level tests)
- Manual: Visual verification of tab bar, grid layout, expand/collapse

**Rollback**: Remove new components, revert tab additions to page components.

---

### Phase 6: UI — Slide-Over Pre-Fill + All Profiles Enhancements

**Goal**: Extend `AuthProfileSlideOver` with `preselectedConnector` for Nango pre-fill and connection config fields. Enhance All Profiles tab with connector badge and OAuth aggregation.

**Tasks**:

6.1. Add `preselectedConnector` prop to `AuthProfileSlideOver.tsx`:

```typescript
interface AuthProfileSlideOverProps {
  // ... existing props
  preselectedConnector?: {
    connectorName: string;
    availableAuthTypes: string[];
    oauth2?: IntegrationProvider['oauth2'];
  };
}
```

When `preselectedConnector` is provided:

- Skip `'select-type'` step, go directly to `'form'`
- Pre-set `connector` field to `connectorName`
- Pre-set `authType` from `availableAuthTypes[0]`
- Pre-fill OAuth config fields from `oauth2` metadata:
  - `authorizationUrl` ← `oauth2.authorizationUrl` (after template resolution)
  - `tokenUrl` ← `oauth2.tokenUrl` (after template resolution)
  - `defaultScopes` ← `oauth2.defaultScopes`
  - `pkceRequired` ← `oauth2.pkce` (field name mapping!)
  - `authorizationParams` ← `oauth2.authorizationParams`
  - `tokenParams` ← `oauth2.tokenParams`
- Pre-filled fields are shown but overridable by the user

  6.2. Add connection config fields section to slide-over:

- If `oauth2.connectionConfigFields` is non-empty, render input fields for each
- As user types, resolve URL templates in real-time using `resolveConnectionConfigTemplate()`
- Show resolved URL preview below the OAuth URL fields
- On save, `config.connectionConfig` stores the variable values, `config.authorizationUrl`/`tokenUrl` store the resolved URLs

  6.3. Disable `jit`/`preflight` usage modes at workspace level:

- In the usage mode dropdown, when `projectId === '_workspace'`:
  - Disable `jit` and `preflight` options
  - Add tooltip: "End-user consent requires a project-scoped app (callback route validates requiredScope: 'project')"

    6.4. Add connector badge column and OAuth aggregation to All Profiles tab in `AuthProfilesPage.tsx`:

- Add "Connector" column showing connector name badge (or "Custom" for profiles without connector)
- Apply OAuth app/token aggregation: preconfigured hides parent app, jit hides per-user tokens

  6.5. Wire `IntegrationCard`'s "Create" button to open slide-over with `preselectedConnector`:

- `IntegrationAuthTab` passes `onCreateProfile` callback to `IntegrationCard`
- Callback sets `preselectedConnector` state and opens slide-over
- After save, invalidate SWR cache: call `mutate()` for the provider endpoint SWR key (`/api/projects/${projectId}/auth-profiles/providers` or `/api/auth-profiles/providers`). Also invalidate the "All Profiles" list SWR key to refresh connector badge column. Both `IntegrationAuthTab` and the profile list should use `useSWR` with stable keys for targeted invalidation.

  6.6. Write unit tests:

- `apps/studio/src/__tests__/components/auth-profile-slideover-integration.test.tsx`:
  - Test 1: `preselectedConnector` pre-fills OAuth URLs from provider data
  - Test 2: Connection config fields render when `connectionConfigFields` is non-empty
  - Test 3: URL template resolves in real-time as user types connection config
  - Test 4: `jit`/`preflight` disabled at workspace level with tooltip
  - Test 5: Nango `pkce` mapped to `pkceRequired` in form state

**Files Touched**:

- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — add `preselectedConnector`, connection config, usage mode disable
- `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx` — connector badge column, OAuth aggregation, wire create callback
- `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` — wire create callback
- `apps/studio/src/__tests__/components/auth-profile-slideover-integration.test.tsx` — new

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds
- [ ] All 5 unit tests pass
- [ ] Slide-over pre-fills OAuth fields from Nango data
- [ ] Connection config fields render and resolve templates in real-time
- [ ] `jit`/`preflight` disabled at workspace level
- [ ] Connector badge column visible in All Profiles tab
- [ ] End-to-end flow: Integrations tab → expand Gmail → Create → slide-over with pre-filled fields

**Test Strategy**:

- Unit: React Testing Library for form pre-fill, connection config, usage mode disable
- Manual: Full create flow through the UI

**Rollback**: Revert `AuthProfileSlideOver` changes. Remove connector badge column additions.

---

### Phase 7: E2E Test Suite

**Goal**: Maintain the E2E suite covering the full integration auth profile lifecycle through the HTTP API. The implemented suite currently has 26 passing E2E tests on disk (extended to 26 by ABLP-619).

**Tasks**:

7.1. Create `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` following the `tool-invocations-api.e2e.test.ts` pattern:

- MongoMemoryServer setup
- Express wrapping Next.js route modules
- Real middleware chain (auth, rate limiting, tenant isolation)
- Seed data via POST, assert via GET

  7.2. Implement the planned core E2E scenarios from the test spec and keep the landed suite aligned with the shipped behavior. The current implementation expanded the suite to 26 passing tests (18 original + 8 added by ABLP-619):

Aligned 1:1 with test spec scenario numbers:

- E2E-1: Create Preconfigured OAuth Integration Profile (Gmail) — FR-4, FR-2
- E2E-2: Provider Endpoint Returns Enriched Catalog — FR-2
- E2E-3: Visibility Filtering — Personal Profiles Hidden from Other Users — FR-3
- E2E-4: Delete Profile Cascades to Bridge ConnectorConnection — FR-4
- E2E-5: Workspace Profile Inheritance at Project Level — FR-2, FR-4
- E2E-6: Cross-Tenant Isolation Returns 404 — isolation
- E2E-7: API Key Integration Profile (Stripe) — FR-4
- E2E-8: Usage Mode Validation Rejects Invalid Combinations — FR-9
- E2E-9: OAuth Initiate with authorizationParams — FR-5
- E2E-10: OAuth Initiate with connectionConfig URL Templates (success path) — FR-5
- E2E-11: OAuth Initiate Rejects Missing connectionConfig Templates (400 error) — FR-5
- E2E-12: Unsupported Connector in Provider Catalog — FR-10
- E2E-13: Cross-Project Isolation Returns 404 — isolation
- E2E-14: Unauthenticated Request Returns 401 — security

Additional landed scenarios extend the suite beyond the original 14-scenario target, bringing the on-disk total to 26 passing E2E tests (18 original + E2E-19 through E2E-26 added by ABLP-619 for the validate endpoint).

**Files Touched**:

- `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` — new

**Exit Criteria**:

- [ ] All 26 E2E tests pass
- [ ] No `vi.mock()` or direct DB access in E2E file
- [ ] Tests run against real Express server with full middleware chain
- [ ] Cross-tenant/project isolation verified via 404 responses
- [ ] Response time < 200ms for provider endpoint (inline assertion)

**Test Strategy**:

- E2E: Real Express, MongoMemoryServer, API-only interaction
- No mocks — only external services may be stubbed (none needed here)

**Rollback**: Delete the test file. No production code changes.

---

## 4. Wiring Checklist

- [ ] New provider route files registered: Next.js App Router auto-discovers `route.ts` files — no manual registration needed
- [ ] `ConnectorConnection` model import added to route files that create/delete bridges
- [ ] `withTransaction` import added to POST route files
- [ ] `connection-config-utils.ts` imported by provider service and UI components
- [ ] `integration-provider-service.ts` imported by both provider route files
- [ ] `IntegrationAuthTab` rendered by `AuthProfilesPage` when `activeTab === 'integrations'`
- [ ] `IntegrationCard` rendered by `IntegrationAuthTab` for each provider
- [ ] `AuthProfileSlideOver` receives `preselectedConnector` from page components
- [ ] `fetchIntegrationProviders()` and `fetchWorkspaceIntegrationProviders()` exported from `apps/studio/src/api/auth-profiles.ts`
- [ ] `getIntegrationTypeMetadata()` exported from `auth-type-metadata.ts`
- [ ] No new model files — reusing existing `AuthProfile` and `ConnectorConnection` models
- [ ] No new middleware — using existing `requireAuth`, `requireProjectPermission`
- [ ] No new workers or background processes

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes to MongoDB collections — the three new Zod schema fields (`authorizationParams`, `tokenParams`, `connectionConfig`) are optional and stored in the existing `config: Mixed` field on `auth_profiles`. Bridge `ConnectorConnection` documents use the existing collection and schema.

### Feature Flags

None. Integration auth profiles are available as soon as the code is deployed and `providers.json` is populated. The existing `AUTH_PROFILE_ENABLED` gate covers the feature.

### Configuration Changes

No new environment variables. `pnpm connectors:import-providers` must be run once to populate `providers.json` before Phase 2.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 7 phases complete with exit criteria met
- [x] 26 E2E tests are on disk and passing in `integration-auth-profiles.e2e.test.ts`
- [x] Targeted route/service suites for provider enrichment and OAuth-initiate logic are on disk and passing
- [x] Component/unit suites for the integrations tab, cards, slide-over, Connections catalog, and connector catalog are on disk and passing
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Provider endpoint response time < 200ms
- [ ] Integrations tab visible on both project and workspace auth profile pages
- [ ] Connector cards expand inline with OAuth aggregation
- [ ] Slide-over pre-fills OAuth URLs, scopes, PKCE from Nango
- [ ] Connection config fields render for template connectors (Salesforce, Shopify)
- [ ] Bridge `ConnectorConnection` auto-created/deleted atomically with profile
- [ ] Workspace `jit`/`preflight` disabled with tooltip
- [ ] Cross-tenant access returns 404 (not 403)
- [ ] Personal profiles hidden from other users in provider endpoint

## 6b. Post-Implementation Notes

- The auth-aware provider service now also backs `GET /api/projects/:id/connectors`, so the Connections catalog reuses the same auth-type decisions as the Auth Profiles integrations tab.
- Several Microsoft/Azure/AWS entries originally planned as auth-only virtual providers are now real generated connector catalog entries because corresponding ActivePieces pieces were added and loaded through `packages/connectors/src/loader.ts`.
- `microsoft-power-bi` shipped as `azure_ad`, not `oauth2_client_credentials`. `microsoft-dynamics-365-business-central` remains the client-credentials exception.
- The implementation did not land a dedicated `auth-profile-bridge.test.ts` file. Bridge lifecycle coverage currently comes from the E2E suite plus broader auth-profile route coverage, so rollback/cascade behavior should still be treated as an area for stronger non-mocked regression coverage.

**ABLP-619 (auth-feedback) additions — May 2026:**

- FR-12 added: validate endpoints now return `validationMethod: 'live' | 'structural' | 'optimistic'`. `_piece-auth-validator.ts` introduced with `BUILT_IN_LIVE_CHECKS` covering 28 connectors and `validateOAuth2AppProfile` for OAuth grant checks.
- `normalizeAuthForPieceValidate` added to `packages/connectors/src/adapters/activepieces/context-translator.ts` to bridge the stored auth shape vs the AP piece `validate` hook shape (SECRET_TEXT and CUSTOM_AUTH divergence fixed).
- E2E suite extended from 18 to 26 tests (E2E-19 through E2E-26) covering validate endpoint paths, `lastValidatedAt` persistence, and personal-profile 404 isolation.
- 61-test targeted suite for `BUILT_IN_LIVE_CHECKS` added; old platform-mock unit test replaced with 8 pure-function tests (no `vi.mock` of platform components).

---

## 7. Open Questions

1. **Bridge uniqueness constraint**: The `ConnectorConnection` unique index on `{tenantId, projectId, connectorName, scope, userId}` means that two personal (`scope: 'user'`) profiles for the same connector by different users create separate bridges (different `userId`). But two shared (`scope: 'tenant'`) profiles for the same connector would conflict (both have `userId: null`). Should we handle this with a pre-check and allow multiple tenant bridges, or enforce one tenant bridge per connector? Current approach: pre-check for existing bridge, skip creation if one exists.
