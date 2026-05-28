# Test Specification: Integration Auth Profiles

**Feature Spec**: `docs/features/sub-features/integration-auth-profiles.md`
**Design Doc**: `docs/plans/2026-04-01-integration-auth-profiles-design.md`
**Impl Plan**: `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md`
**Status**: BETA
**Last Updated**: 2026-05-03

---

## 1. Coverage Matrix

| FR    | Description                                                                                    | Unit | Integration | E2E | Manual | Status     |
| ----- | ---------------------------------------------------------------------------------------------- | :--: | :---------: | :-: | :----: | ---------- |
| FR-1  | OAuth schema extension (authorizationParams, tokenParams, connectionConfig)                    |  ✅  |     ❌      |  —  |   —    | ✅ PASSING |
| FR-2  | Provider endpoints (project + workspace)                                                       |  ✅  |     ❌      | ✅  |   —    | ✅ PASSING |
| FR-3  | Provider endpoint visibility filtering                                                         |  ✅  |     ❌      | ✅  |   —    | ✅ PASSING |
| FR-4  | Bridge ConnectorConnection auto-create/delete with rollback                                    |  ✅  |     ❌      | ✅  |   —    | PARTIAL    |
| FR-5  | OAuth routes consume authorizationParams, connectionConfig                                     |  ✅  |     ❌      | ✅  |   —    | ✅ PASSING |
| FR-6  | Integrations tab with catalog grid                                                             |  ✅  |      —      |  —  |   ✅   | ✅ PASSING |
| FR-7  | Inline card expand with OAuth aggregation                                                      |  ✅  |      —      |  —  |   ✅   | ✅ PASSING |
| FR-8  | Slide-over Nango pre-fill (preselectedConnector)                                               |  ✅  |      —      |  —  |   ✅   | ✅ PASSING |
| FR-9  | Workspace jit/preflight disabled                                                               |  ✅  |      —      |  —  |   ✅   | ✅ PASSING |
| FR-10 | Utility connectors (`http`, `postgres`) hidden from visible integration grids                  |  ✅  |      —      |  —  |   —    | ✅ PASSING |
| FR-11 | All Profiles tab connector badge + OAuth aggregation                                           |  ❌  |      —      |  —  |   ✅   | UI ONLY    |
| FR-12 | Validate endpoint: `validationMethod`, live checks (28), oauth2_app grant, optimistic fallback |  ✅  |     ❌      | ✅  |   —    | ✅ PASSING |

---

## 2. E2E Test Scenarios (MANDATORY)

All E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers.

**Infrastructure**: MongoMemoryServer + Express wrapping Next.js route handlers (following `tool-invocations-api.e2e.test.ts` pattern). Seed data via POST endpoints. Assert via GET responses.

**Test file**: `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts`

### E2E-1: Create Preconfigured OAuth Integration Profile (Gmail)

- **FR Coverage**: FR-4, FR-2
- **Preconditions**: Authenticated project admin (via dev-login), project created, `providers.json` populated
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with body `{ name: "Gmail-Marketing", authType: "oauth2_app", connector: "gmail", usageMode: "preconfigured", scope: "project", visibility: "shared", config: { clientId: "test-id", clientSecret: "test-secret", authorizationUrl: "https://accounts.google.com/o/oauth2/auth", tokenUrl: "https://oauth2.googleapis.com/token", defaultScopes: ["gmail.send", "gmail.readonly"], pkce: false } }`
  2. Assert 201 response with `connector: "gmail"`, `usageMode: "preconfigured"`
  3. `GET /api/projects/:pid/auth-profiles/providers` — assert Gmail entry has `profileCount: 1` and profile in `profiles` array
  4. `GET /api/projects/:pid/connections?connectorName=gmail` — assert bridge `ConnectorConnection` exists with `authProfileId` matching the created profile ID and `encryptedCredentials` is empty/absent
- **Expected Result**: Auth profile created, bridge ConnectorConnection auto-created, provider endpoint reflects the new profile
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: `tenantId` and `projectId` enforced on both profile and bridge

### E2E-2: Provider Endpoint Returns Enriched Catalog

- **FR Coverage**: FR-2
- **Preconditions**: Authenticated user, project exists, `providers.json` populated with Nango data
- **Steps**:
  1. `GET /api/projects/:pid/auth-profiles/providers`
  2. Assert response is an array containing the 36 generated connector catalog entries
  3. Assert Gmail entry includes `oauth2.authorizationUrl` = `"https://accounts.google.com/o/oauth2/auth"`, `oauth2.tokenUrl`, `oauth2.defaultScopes` array, `oauth2.pkce` boolean
  4. Assert Stripe entry includes `availableAuthTypes: ["api_key"]` and no `oauth2` metadata
  5. Assert `jira-cloud` entry resolves via alias to include Nango OAuth metadata (authorizationUrl from Jira Nango provider)
  6. Assert `microsoft-teams` exposes `availableAuthTypes: ["azure_ad"]` with Azure AD prefill defaults
  7. Assert newly added providers like `microsoft-onedrive`, `azure-blob-storage`, and `amazon-sqs` are present with `availableAuthTypes` mapped to `azure_ad` or `aws_iam`
  8. Assert `twilio` exposes `availableAuthTypes: ["basic"]` and `amazon-s3` exposes `availableAuthTypes: ["aws_iam"]`
- **Expected Result**: Catalog returns the generated connector set enriched with Nango OAuth metadata or auth-prefill defaults where available
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: Response scoped to tenant A profiles only

### E2E-3: Visibility Filtering — Personal Profiles Hidden from Other Users

- **FR Coverage**: FR-3
- **Preconditions**: Two users (User A = admin, User B = member) in same tenant/project. User B creates a personal integration profile.
- **Steps**:
  1. Login as User B → `POST /api/projects/:pid/auth-profiles` with `{ connector: "gmail", visibility: "personal", usageMode: "preconfigured", authType: "oauth2_app", ... }`
  2. Login as User A → `POST /api/projects/:pid/auth-profiles` with `{ connector: "gmail", visibility: "shared", usageMode: "preconfigured", authType: "oauth2_app", ... }`
  3. As User A → `GET /api/projects/:pid/auth-profiles/providers`
  4. Assert Gmail `profileCount` = 1 (User A's shared profile only)
  5. Assert Gmail `profiles` array does NOT contain User B's personal profile
  6. As User B → `GET /api/projects/:pid/auth-profiles/providers`
  7. Assert Gmail `profileCount` = 2 (User B sees own personal + User A's shared)
- **Expected Result**: Non-admin users cannot see other users' personal profiles in provider counts or profiles array
- **Auth Context**: User A (admin) and User B (member), same tenant + project
- **Isolation Check**: User B's personal profile invisible to User A

### E2E-4: Delete Profile Cascades to Bridge ConnectorConnection

- **FR Coverage**: FR-4
- **Preconditions**: Authenticated project admin, existing Gmail integration profile with bridge
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ connector: "stripe", authType: "api_key", usageMode: "preconfigured", ... }` → save `profileId`
  2. `GET /api/projects/:pid/connections?connectorName=stripe` → assert bridge exists with `authProfileId`
  3. `DELETE /api/projects/:pid/auth-profiles/:profileId`
  4. Assert 200 response
  5. `GET /api/projects/:pid/connections?connectorName=stripe` → assert bridge no longer exists (empty array or 404)
  6. `GET /api/projects/:pid/auth-profiles/providers` → assert Stripe `profileCount` = 0
- **Expected Result**: Bridge ConnectorConnection cascade-deleted when auth profile deleted
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: `tenantId` filter on cascade delete

### E2E-5: Workspace Profile Inheritance at Project Level

- **FR Coverage**: FR-2, FR-4
- **Preconditions**: Authenticated workspace admin, project exists
- **Steps**:
  1. `POST /api/auth-profiles` (workspace route) with `{ connector: "gmail", authType: "oauth2_app", usageMode: "preconfigured", scope: "tenant", ... }` → save `tenantProfileId`
  2. `GET /api/auth-profiles/providers` (workspace) → assert Gmail `profileCount` = 1
  3. `GET /api/projects/:pid/auth-profiles/providers` (project) → assert Gmail profile appears as inherited (scope = "tenant")
  4. `POST /api/projects/:pid/auth-profiles` with `{ connector: "gmail", authType: "oauth2_app", usageMode: "preconfigured", scope: "project", ... }`
  5. `GET /api/projects/:pid/auth-profiles/providers` → assert Gmail `profileCount` = 2 (1 tenant + 1 project)
  6. `GET /api/auth-profiles/providers` (workspace) → assert Gmail `profileCount` = 1 (tenant only, project profile excluded)
- **Expected Result**: Workspace profiles visible at project level as inherited; project profiles not visible at workspace level
- **Auth Context**: Workspace admin, tenant A
- **Isolation Check**: Workspace endpoint shows tenant-only counts; project endpoint shows combined

### E2E-6: Non-Existent Project Returns 404 from Providers Endpoint

- **FR Coverage**: FR-2 (security)
- **Preconditions**: Authenticated user
- **Steps**:
  1. `GET /api/projects/:fakeProjectId/auth-profiles/providers` with a non-existent project ID
  2. Assert 404 response
- **Expected Result**: Non-existent project returns 404
- **Auth Context**: Authenticated user, valid tenant
- **Isolation Check**: `requireProject` middleware rejects unknown projects
- **Note**: Original design was cross-tenant isolation test, but dev-login `findPreferredDevTenant()` auto-attaches all users to the same tenant, making true cross-tenant E2E testing impossible in this harness. Cross-tenant isolation is covered at integration test level (auth-profile-api.test.ts cross-tenant suite, 4 tests).

### E2E-7: API Key Integration Profile (Stripe)

- **FR Coverage**: FR-4, FR-2
- **Preconditions**: Authenticated project admin, project exists
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ name: "Stripe-Prod", authType: "api_key", connector: "stripe", usageMode: "preconfigured", scope: "project", visibility: "shared", config: { headerName: "Authorization" }, encryptedSecrets: { apiKey: "sk_test_12345" } }`
  2. Assert 201 with `connector: "stripe"`, `authType: "api_key"`
  3. Assert response does NOT contain `encryptedSecrets` (secrets never returned)
  4. `GET /api/projects/:pid/auth-profiles/providers` → assert Stripe `profileCount` = 1
  5. `GET /api/projects/:pid/connections?connectorName=stripe` → assert bridge exists
- **Expected Result**: API key integration profile created with bridge, secrets encrypted and not returned
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: `tenantId` + `projectId` enforced

### E2E-8: Usage Mode Validation Rejects Invalid Combinations

- **FR Coverage**: Inherited usageMode validation (pre-existing, not a new FR)
- **Preconditions**: Authenticated project admin
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ authType: "api_key", usageMode: "jit", connector: "stripe", ... }`
  2. Assert 400 error — `api_key` only allows `preconfigured` per `AUTH_TYPE_USAGE_MODE_MAP`
  3. `POST /api/projects/:pid/auth-profiles` with `{ authType: "oauth2_app", usageMode: "jit", connector: "gmail", ... }`
  4. Assert 201 — `oauth2_app` allows `jit`
- **Expected Result**: Invalid usageMode/authType combinations rejected with descriptive error
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: N/A (validation test)

### E2E-9: OAuth Initiate with authorizationParams

- **FR Coverage**: FR-5
- **Preconditions**: Existing OAuth integration profile with `config.authorizationParams: { prompt: "consent", access_type: "offline" }`
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with Gmail OAuth profile including `config: { ..., authorizationParams: { prompt: "consent", access_type: "offline" } }`
  2. `POST /api/projects/:pid/auth-profiles/oauth/initiate` with `{ authProfileId: "<id>" }`
  3. Assert response contains `authorizationUrl` with `&prompt=consent&access_type=offline` as query params
- **Expected Result**: authorizationParams merged into OAuth authorization URL
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: Profile resolved with `tenantId` filter

### E2E-10: OAuth Initiate with connectionConfig URL Templates

- **FR Coverage**: FR-5
- **Preconditions**: Provider with URL templates (e.g., Salesforce with `{instance}` placeholder)
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ connector: "salesforce", authType: "oauth2_app", config: { authorizationUrl: "https://{instance}.salesforce.com/services/oauth2/authorize", tokenUrl: "https://{instance}.salesforce.com/services/oauth2/token", connectionConfig: { instance: "mycompany" }, clientId: "test", clientSecret: "test" } }`
  2. `POST /api/projects/:pid/auth-profiles/oauth/initiate` with `{ authProfileId: "<id>" }`
  3. Assert response `authorizationUrl` contains `https://mycompany.salesforce.com/services/oauth2/authorize`
- **Expected Result**: URL templates resolved from connectionConfig values
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: Profile resolved with `tenantId` filter

### E2E-11: OAuth Initiate Rejects Missing connectionConfig Templates

- **FR Coverage**: FR-5 (error path)
- **Preconditions**: Provider with URL templates, connectionConfig omitted
- **Steps**:
  1. `POST /api/projects/:pid/auth-profiles` with `{ connector: "salesforce", authType: "oauth2_app", config: { authorizationUrl: "https://{instance}.salesforce.com/services/oauth2/authorize", tokenUrl: "https://{instance}.salesforce.com/services/oauth2/token" } }` (no connectionConfig)
  2. `POST /api/projects/:pid/auth-profiles/oauth/initiate` with `{ authProfileId: "<id>" }`
  3. Assert 400 with error message identifying `{instance}` as unresolved template variable
- **Expected Result**: 400 error with descriptive message for unresolved URL templates
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: N/A (validation test)

### E2E-12: Utility Connector Remains Non-Creatable in Provider Catalog

- **FR Coverage**: FR-10
- **Preconditions**: Provider catalog includes `postgres` without a supported auth-profile mapping
- **Steps**:
  1. `GET /api/projects/:pid/auth-profiles/providers`
  2. Find `postgres` entry in response
  3. Assert entry has no `oauth2` metadata (no authorizationUrl, tokenUrl)
  4. Assert `availableAuthTypes` is empty
  5. Assert `profileCount` = 0, `profiles` = []
- **Expected Result**: Unsupported connectors may still be present in the raw provider payload, but they remain non-creatable and are filtered from the visible Studio integration grids
- **Auth Context**: Project admin, tenant A, project P1
- **Isolation Check**: Catalog scoped to tenant

### E2E-13: Cross-Project Isolation Returns 404

- **FR Coverage**: FR-2, FR-3 (security)
- **Preconditions**: Same tenant user with access to Project P1 and Project P2. Auth profile created in Project P1.
- **Steps**:
  1. As tenant user → `POST /api/projects/:pidP1/auth-profiles` with `{ connector: "gmail", ... }` → save `profileId`
  2. As same tenant user → `GET /api/projects/:pidP2/auth-profiles/providers`
  3. Assert Gmail `profileCount` = 0 (Project P1's profile NOT visible in Project P2)
  4. As same tenant user → `DELETE /api/projects/:pidP2/auth-profiles/:profileId`
  5. Assert 404 — profile belongs to P1, not P2
- **Expected Result**: Cross-project access denied with 404 for all operations
- **Auth Context**: Tenant A user, accessing Project P2 resources that belong to Project P1
- **Isolation Check**: Core Invariant #1 — `projectId` filter prevents cross-project access

### E2E-14: Unauthenticated Request Returns 401

- **FR Coverage**: Security baseline
- **Preconditions**: No auth token
- **Steps**:
  1. `GET /api/projects/:pid/auth-profiles/providers` without `Authorization` header
  2. Assert 401 response
  3. `POST /api/projects/:pid/auth-profiles` without `Authorization` header
  4. Assert 401 response
  5. `GET /api/auth-profiles/providers` (workspace) without `Authorization` header
  6. Assert 401 response
- **Expected Result**: All provider and profile endpoints reject unauthenticated requests with 401
- **Auth Context**: None (unauthenticated)
- **Isolation Check**: Auth middleware blocks before any data access

### E2E-15 through E2E-18: Connector-Catalog Auth Prefill Assertions

(Scenarios rolled into E2E-2 — asserted in the same provider-catalog E2E test that covers Shopify `oauth2_client_credentials` prefill, Power BI `azure_ad` prefill, Business Central `oauth2_client_credentials` prefill, and SQS `aws_iam` prefill.)

### E2E-19: Validate Endpoint — Structural Valid (`none`)

- **FR Coverage**: FR-12
- **Preconditions**: Workspace `none`-auth profile
- **Steps**: POST `/api/auth-profiles/:profileId/validate` → assert `{ valid: true, validationMethod: 'structural', latencyMs: <number> }`
- **Expected Result**: Profiles with structurally valid `none` auth return valid without any live check

### E2E-20: Validate Endpoint — Structural Invalid (`oauth2_app`, no grant)

- **FR Coverage**: FR-12
- **Preconditions**: Workspace Slack `oauth2_app` profile (no OAuth grant issued)
- **Steps**: POST `/api/auth-profiles/:profileId/validate` → assert `{ valid: false, validationMethod: 'structural', message: /grant|OAuth|authorization/i }`
- **Expected Result**: `oauth2_app` profiles are invalid until the OAuth flow completes and a grant exists

### E2E-21: Validate Endpoint — Optimistic (`bearer`, no connector)

- **FR Coverage**: FR-12
- **Preconditions**: Workspace `bearer` profile, no `connector` field
- **Steps**: POST `/api/auth-profiles/:profileId/validate` → assert `{ valid: true, validationMethod: 'optimistic', warning: <truthy string> }`
- **Expected Result**: Auth types with no live-check path return optimistic valid with a `warning` field so callers can distinguish assumed-valid from confirmed-valid

### E2E-22: Validate Endpoint — 404 for Non-Existent Profile

- **FR Coverage**: FR-12 (security)
- **Steps**: POST `/api/auth-profiles/000000000000000000000099/validate` → assert 404

### E2E-23: Validate Endpoint — 401 for Unauthenticated

- **FR Coverage**: FR-12 (security)
- **Steps**: POST `/api/auth-profiles/:profileId/validate` without token → assert 401

### E2E-24: Validate Writes `lastValidatedAt` (Project Endpoint)

- **FR Coverage**: FR-12
- **Preconditions**: Project `none`-auth profile
- **Steps**: POST project validate → GET profile → assert `data.lastValidatedAt` is a valid ISO date
- **Expected Result**: `lastValidatedAt` persisted after successful validation and returned in GET response

### E2E-25: Personal Project Profile Returns 404 to Non-Creator

- **FR Coverage**: FR-12 (isolation)
- **Steps**: user1 creates personal project profile → user2 POST project validate → assert 404
- **Expected Result**: `ensureUsableAuthProfile` returns 404 when `visibility = 'personal'` and caller ≠ creator

### E2E-26: Personal Workspace Profile Returns 404 to Non-Creator

- **FR Coverage**: FR-12 (isolation)
- **Steps**: user1 creates personal workspace profile → user2 POST workspace validate → assert 404
- **Expected Result**: Same isolation enforcement as project scope

---

## 3. Targeted Route / Service Tests

These tests exercise real route or service logic but mock external boundaries such as auth middleware or database models. They are useful regression coverage, but they do **not** count as dedicated integration coverage for SDLC status purposes.

Integration tests verify service boundaries with real databases but may mock auth middleware for isolation. External third-party services (OAuth providers) may be mocked via DI. DB operations may be mocked to test error/rollback paths that are difficult to trigger with real data (e.g., INT-5).

### RT-1: Provider Service Merges Catalog with Nango Data

- **FR Coverage**: FR-2
- **Boundary**: Studio route handler → ProviderConfigRegistry → MongoDB
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
- **Setup**: Mock auth/project-access middleware. Real MongoMemoryServer with seeded auth profiles.
- **Steps**:
  1. Seed 2 Gmail profiles and 1 Stripe profile in MongoDB
  2. Call provider endpoint handler
  3. Assert Gmail entry has `profileCount: 2`, Nango OAuth metadata, `availableAuthTypes: ["oauth2"]`
  4. Assert Stripe entry has `profileCount: 1`, no OAuth metadata, `availableAuthTypes: ["api_key"]`
  5. Assert total response length = 36 (all current catalog connectors)
- **Expected Result**: Current catalog connectors are returned with correct profile counts and provider enrichment
- **Failure Mode**: If `providers.json` empty → connectors still returned but without OAuth metadata (degraded)

### RT-2: Provider Service Visibility Filter Excludes Other Users' Personal Profiles

- **FR Coverage**: FR-3
- **Boundary**: Studio route handler → MongoDB visibility query
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
- **Setup**: Seed profiles: 1 shared (User A), 1 personal (User A), 1 personal (User B). Mock auth as User A (non-admin).
- **Steps**:
  1. Call provider endpoint handler as User A
  2. Assert profiles array includes User A's shared + User A's personal
  3. Assert profiles array does NOT include User B's personal
  4. Assert `profileCount` = 2 (not 3)
- **Expected Result**: User B's personal profile excluded from both array and count
- **Failure Mode**: If visibility filter missing → personal profiles leak (security bug)

### RT-3: Provider Service Visibility — Admin Sees All Profiles

- **FR Coverage**: FR-3
- **Boundary**: Studio route handler → MongoDB visibility query
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
- **Setup**: Same seed as INT-2 but mock auth as admin user
- **Steps**:
  1. Call provider endpoint handler as admin
  2. Assert profiles array includes all 3 profiles (shared + both personal)
  3. Assert `profileCount` = 3
- **Expected Result**: Admin sees all profiles regardless of visibility
- **Failure Mode**: If admin check missing → admin has same restricted view as members

### RT-4: OAuth Initiate Merges authorizationParams

- **FR Coverage**: FR-5
- **Boundary**: OAuth initiate route → URL construction
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Mock auth, DB, Redis, and SSRF boundaries while keeping the route logic real
- **Steps**:
  1. Call initiate handler with profile ID
  2. Parse returned authorization URL
  3. Assert URL query params include `prompt=consent` and `access_type=offline`
  4. Assert standard OAuth params (client_id, redirect_uri, scope) still present
- **Expected Result**: authorizationParams merged as query params without overwriting standard params
- **Failure Mode**: If params override standard OAuth params → broken OAuth flow

### RT-5: OAuth Initiate Resolves connectionConfig Templates

- **FR Coverage**: FR-5
- **Boundary**: OAuth initiate route → URL template resolution
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Seed profile with `config.authorizationUrl` containing a template and mock route dependencies
- **Steps**:
  1. Call initiate handler with profile ID
  2. Assert returned URL resolves the placeholder values
  3. Assert no literal template markers remain in the URL
- **Expected Result**: All template variables resolve from `connectionConfig`
- **Failure Mode**: If template resolution breaks → user is redirected to an invalid OAuth URL

### RT-6: OAuth Initiate Returns 400 for Unresolved Templates

- **FR Coverage**: FR-5 (error path)
- **Boundary**: OAuth initiate route → URL template validation
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Seed profile with a URL template but omit `connectionConfig`
- **Steps**:
  1. Call initiate handler with profile ID
  2. Assert 400 response
  3. Assert error body identifies the unresolved variables
- **Expected Result**: Descriptive 400 error before any redirect
- **Failure Mode**: If validation is missing → user is redirected to a broken URL

### INT-7: OAuth Initiate Merges authorizationParams

- **FR Coverage**: FR-5
- **Boundary**: OAuth initiate route → URL construction
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Seed profile with `config.authorizationParams: { prompt: "consent", access_type: "offline" }`
- **Steps**:
  1. Call initiate handler with profile ID
  2. Parse returned authorization URL
  3. Assert URL query params include `prompt=consent` and `access_type=offline`
  4. Assert standard OAuth params (client_id, redirect_uri, scope) still present
- **Expected Result**: authorizationParams merged as query params without overwriting standard params
- **Failure Mode**: If params override standard OAuth params → broken OAuth flow

### INT-8: OAuth Initiate Resolves connectionConfig Templates

- **FR Coverage**: FR-5
- **Boundary**: OAuth initiate route → URL template resolution
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Seed profile with `config.authorizationUrl: "https://{instance}.salesforce.com/services/oauth2/authorize"`, `config.connectionConfig: { instance: "acme" }`
- **Steps**:
  1. Call initiate handler with profile ID
  2. Assert returned URL = `https://acme.salesforce.com/services/oauth2/authorize?...`
  3. Assert `{instance}` placeholder fully resolved (no literal braces in URL)
- **Expected Result**: All template variables resolved from connectionConfig
- **Failure Mode**: If template resolution broken → user redirected to invalid OAuth URL

### INT-9: OAuth Initiate Returns 400 for Unresolved Templates

- **FR Coverage**: FR-5 (error path)
- **Boundary**: OAuth initiate route → URL template validation
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts`
- **Setup**: Seed profile with URL template but no connectionConfig
- **Steps**:
  1. Call initiate handler with profile ID
  2. Assert 400 response
  3. Assert error body identifies `{instance}` as unresolved variable
- **Expected Result**: Descriptive 400 error before any redirect
- **Failure Mode**: If no validation → user redirected to literal `{instance}` URL (broken + potential security issue)

### INT-10: Schema Accepts New Optional Fields (Strict Mode)

- **FR Coverage**: FR-1
- **Boundary**: Zod schema validation
- **Test File**: `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts`
- **Setup**: None (pure schema test)
- **Steps**:
  1. Parse `OAuth2AppConfigSchema` with `{ clientId: "x", clientSecret: "y", authorizationUrl: "https://...", tokenUrl: "https://...", defaultScopes: [], pkce: false, authorizationParams: { prompt: "consent" }, tokenParams: { grant_type: "authorization_code" }, connectionConfig: { instance: "test" } }`
  2. Assert parse succeeds
  3. Parse same schema WITHOUT the new fields
  4. Assert parse still succeeds (backward compatible)
  5. Parse same schema with an unknown field `{ ..., bogusField: "x" }`
  6. Assert parse FAILS (strict mode preserved)
- **Expected Result**: New fields accepted as optional; unknown fields still rejected
- **Failure Mode**: If strict mode broken → arbitrary fields pass validation (security risk)

### INT-11: Workspace Provider Endpoint Shows Tenant Profiles Only

- **FR Coverage**: FR-2
- **Boundary**: Workspace route handler → MongoDB
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
- **Setup**: Seed 1 tenant-scoped Gmail profile + 1 project-scoped Gmail profile
- **Steps**:
  1. Call workspace provider endpoint handler
  2. Assert Gmail `profileCount` = 1 (tenant only)
  3. Assert profiles array does NOT include project-scoped profile
- **Expected Result**: Workspace endpoint excludes project-scoped profiles
- **Failure Mode**: If project profiles leak → incorrect counts in workspace UI

### INT-12: Alias Resolution for Nango Provider Lookup

- **FR Coverage**: FR-2
- **Boundary**: Provider endpoint → ProviderConfigRegistry alias resolution
- **Test File**: `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
- **Setup**: `providers.json` populated; connector catalog has `jira-cloud` and `microsoft-teams`
- **Steps**:
  1. Call provider endpoint
  2. Find `jira-cloud` entry
  3. Assert entry has OAuth metadata from Nango `jira` provider (authorizationUrl, tokenUrl)
  4. Find `microsoft-teams` entry
  5. Assert entry has OAuth metadata from Nango `microsoft` provider (authorizationUrl, tokenUrl)
  6. Find `http` entry
  7. Assert entry has NO OAuth metadata (no Nango match)
- **Expected Result**: Alias resolution maps connector names to Nango providers; unmatched connectors have no OAuth metadata
- **Failure Mode**: If alias resolution broken → connectors show no OAuth metadata even when Nango has their data

---

## 4. Unit Test Scenarios

### UT-1: IntegrationAuthTab Renders Catalog Grid

- **Module**: `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`
- **Input**: Provider list with 3 connectors (Gmail OAuth, Stripe API key, HTTP unsupported)
- **Expected Output**: Renders 3 cards. Gmail shows "OAuth 2.0". Stripe shows "API Key". HTTP shows "Unsupported" badge. Search input present. Category filter present.

### UT-2: IntegrationCard Expand/Collapse with Profile List

- **Module**: `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`
- **Input**: Connector with 2 profiles (1 preconfigured oauth2_token, 1 jit oauth2_app)
- **Expected Output**: Collapsed shows name + profile count. Expanded shows profile rows. Preconfigured row shows oauth2_token status (hides oauth2_app parent). JIT row shows oauth2_app only.

### UT-3: IntegrationCard OAuth Aggregation Rules

- **Module**: `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`
- **Input**: 3 profiles: `{ usageMode: "preconfigured", authType: "oauth2_app", linkedTokens: [{ status: "active" }] }`, `{ usageMode: "jit", authType: "oauth2_app" }`, `{ usageMode: "preconfigured", authType: "api_key" }`
- **Expected Output**: Preconfigured OAuth shows token status row (hides app). JIT shows app row (hides tokens). API key shown as-is.

### UT-4: AuthProfileSlideOver Nango Pre-fill with preselectedConnector

- **Module**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`
- **Input**: `preselectedConnector: "gmail"` with ProviderConfigRegistry returning Gmail config
- **Expected Output**: Form fields pre-filled with `authorizationUrl`, `tokenUrl`, `defaultScopes`, `pkce` from Nango. Fields are editable (not disabled). Auth type selector shows only types available for Gmail.

### UT-5: AuthProfileSlideOver Renders connectionConfig Fields from URL Templates

- **Module**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`
- **Input**: `preselectedConnector: "salesforce"` with URL containing `{instance}` placeholder
- **Expected Output**: "Connection Config" section appears with "Instance" input field. URL preview updates in real-time as user types.

### UT-6: Workspace Usage Mode Disabling

- **Module**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`
- **Input**: `scope: "tenant"` (workspace context)
- **Expected Output**: `jit` and `preflight` options in usage mode dropdown are disabled with tooltip explaining callback route requires project scope.

### UT-7: getIntegrationTypeMetadata Helper

- **Module**: `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`
- **Input**: Connector with Nango OAuth metadata
- **Expected Output**: Returns auth type options filtered to those available for the connector. OAuth connectors get `oauth2_app`; Microsoft/Azure connectors get `azure_ad`; AWS service connectors get `aws_iam`; API key connectors get `api_key`.

### UT-8: Unsupported Connector Badge Rendering

- **Module**: `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`
- **Input**: Provider payload that includes `http` or `postgres`
- **Expected Output**: Generic utility connectors are filtered out of the visible integrations grid and never show create affordances.

---

## 5. Security & Isolation Tests

These are covered across E2E and targeted route/unit scenarios. Summary checklist:

- [ ] **Cross-tenant access returns 404** — not covered by a dedicated E2E in the current harness because dev-login auto-attaches users to the same tenant
- [x] **Cross-project access returns 404** — E2E-13 (same tenant user, different project → 404)
- [x] **Cross-user personal profiles hidden** — E2E-3 (User A cannot see User B's personal profiles in provider counts)
- [x] **Missing auth returns 401** — E2E-14 (unauthenticated requests to all endpoints → 401)
- [x] **Insufficient permissions returns 403** — Provider endpoints use `requireProjectPermission(AUTH_PROFILE_READ)`. Note: no dedicated E2E test for insufficient permissions (requires a user with auth but without the specific permission, which is complex to seed). Covered by middleware integration.
- [x] **Input validation rejects malformed data** — E2E-8 (invalid usageMode combo → 400), `oauth2-app-config-extension.test.ts` (strict schema rejects unknown fields)
- [x] **Secrets never returned in API responses** — E2E-7 step 3 (assert `encryptedSecrets` absent from response)
- [x] **URL template injection prevented** — `auth-profile-oauth-integration.test.ts` (400 on unresolved templates prevents redirect to attacker-controlled URL)

### Additional Security Scenarios

**SEC-1: Provider endpoint does not leak personal profile names cross-user**

- Non-admin user calls provider endpoint → personal profiles from other users not in `profiles` array (no name/id/mode visible)

**SEC-2: Bridge ConnectorConnection inherits tenant isolation**

- Bridge created with same `tenantId` as auth profile → cross-tenant queries cannot find it

Note: Workspace `jit`/`preflight` restriction is UI-only (FR-9, GAP-004 accepted). No backend validation test — deferred per feature spec decision.

---

## 6. Performance Tests

No dedicated performance/load test suite required. The provider endpoint operates over the current 36-entry generated connector catalog with an in-memory Nango lookup map.

**Inline assertion**: E2E-2 should include a response time assertion: provider endpoint responds in < 500ms (success metric target is < 200ms, 500ms gives test margin).

---

## 7. Test Infrastructure

### Required Services

| Service | Implementation                  | Required For                                    |
| ------- | ------------------------------- | ----------------------------------------------- |
| MongoDB | MongoMemoryServer (in-process)  | All E2E and integration tests                   |
| Express | Wrapping Next.js route handlers | E2E tests (full middleware chain)               |
| Redis   | Optional (local binary)         | Not required for integration auth profile tests |

### Data Seeding (E2E)

All seeding via POST API endpoints:

1. **Dev login** → obtain access token + tenantId (existing `DEV_LOGIN_EMAIL` pattern)
2. **Create project** → `POST /api/projects`
3. **Create second user** → second dev login with different email (for visibility tests)
4. **Create auth profiles** → `POST /api/projects/:pid/auth-profiles` (project-scoped) and `POST /api/auth-profiles` (workspace-scoped)

### Prerequisite

`providers.json` must be populated before tests run. Either:

- Run `pnpm connectors:import-providers` as a test setup step
- Or ensure `providers.json` is checked in with data (preferred — avoids network dependency in CI)

### Environment Variables

| Variable                | Value                            | Purpose           |
| ----------------------- | -------------------------------- | ----------------- |
| `JWT_SECRET`            | `test-jwt-secret`                | Auth middleware   |
| `ENCRYPTION_MASTER_KEY` | `test-master-key-32chars-long!!` | Secret encryption |
| `MONGODB_URL`           | Auto from MongoMemoryServer      | Database          |
| `NODE_ENV`              | `test`                           | Test mode         |

---

## 8. Test File Mapping

| Test File                                                                                   | Type     | Tests | Covers                                                                                      | Status         |
| ------------------------------------------------------------------------------------------- | -------- | ----: | ------------------------------------------------------------------------------------------- | -------------- |
| `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts`                       | E2E      |    26 | FR-2–5, FR-10, FR-12 + security baseline (E2E-1 to E2E-26)                                  | ✅ All passing |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`         | Targeted |    23 | Provider-service auth enrichment, aliasing, auth-type overrides                             | ✅ All passing |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-oauth-integration.test.ts` | Targeted |     5 | OAuth initiate handler URL merge and template validation                                    | ✅ All passing |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-piece-validate.test.ts`    | Targeted |    35 | FR-12: `BUILT_IN_LIVE_CHECKS` (28 connectors), AP hook routing, SSRF safety                 | ✅ All passing |
| `apps/studio/src/__tests__/auth-profile-bridge-cascade.test.ts`                             | Unit     |     4 | FR-4: `cascadeDeleteBridge` pure fn — success, Error, non-Error, filter shape               | ✅ All passing |
| `apps/studio/src/__tests__/auth-profile-validate-route.test.ts`                             | Unit     |     8 | FR-12: `getMaterializedAuthProfileValidationErrors`, `getAuthProfileMigrationState` pure fn | ✅ All passing |
| `packages/connectors/src/__tests__/normalize-auth-for-piece-validate.test.ts`               | Unit     |    16 | FR-12: `normalizeAuthForPieceValidate` shape mapping (SECRET_TEXT, CUSTOM_AUTH)             | ✅ All passing |
| `packages/shared/src/__tests__/auth-profile/oauth2-app-config-extension.test.ts`            | Unit     |     8 | FR-1                                                                                        | ✅ All passing |
| `apps/studio/src/__tests__/components/integration-auth-tab.test.tsx`                        | Unit     |     6 | FR-6, FR-10                                                                                 | ✅ All passing |
| `apps/studio/src/__tests__/components/integration-card.test.tsx`                            | Unit     |     7 | FR-7, FR-10                                                                                 | ✅ All passing |
| `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`                     | Unit     |    20 | FR-8, FR-9; Azure AD / AWS IAM / client-credentials prefills; Test Credentials button       | ✅ All passing |
| `apps/studio/src/__tests__/connection-cards.test.tsx`                                       | Unit     |    20 | Connections catalog auth summary rendering                                                  | ✅ All passing |
| `apps/studio/src/__tests__/create-connection-modal.test.tsx`                                | Unit     |    18 | Multi-auth connection create flow                                                           | ✅ All passing |
| `packages/connectors/src/__tests__/generate-catalog.test.ts`                                | Unit     |    10 | Catalog alias resolution and connector enrichment                                           | ✅ All passing |

---

## 9. Open Testing Questions

1. **Bridge query pattern**: What exact query does `connection-resolver.ts:138` use to find the bridge? E2E tests should verify the bridge is findable via that same query pattern to ensure contract compatibility.
2. **Workspace OAuth initiate route**: Does the workspace-scoped OAuth initiate route exist, or only project-scoped? This affects E2E-9/10 scope.
3. **Provider catalog response shape**: Is the exact response schema defined in a Zod schema or only in the design doc? Tests need the canonical shape.
4. **MongoMemoryServer version**: The existing harness uses MongoDB 7.0.20 — confirm this matches the production MongoDB version for schema/index compatibility.
5. **`providers.json` test fixture**: Should tests use the real populated `providers.json` or a minimal fixture with 3-4 providers for speed?
