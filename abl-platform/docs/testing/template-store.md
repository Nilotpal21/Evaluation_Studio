# Testing Guide: Template Store

**Feature**: [Template Store](../features/template-store.md)
**Status**: BETA
**Last Updated**: 2026-05-14

---

## Feature Metadata

| Field          | Value                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Feature Status | BETA                                                                                                |
| Package(s)     | `apps/template-store`, `packages/database`, `apps/studio`, `packages/config`, `packages/i18n`       |
| Service(s)     | Template Store (port 3115), Studio (port 5173)                                                      |
| Dependencies   | MongoDB, static file system (media assets), `packages/project-io` (import pipeline)                 |
| Phase 1        | DONE — read-only catalog, browse, search, filter, detail, analytics                                 |
| Phase 2        | DONE — import-ready bundles, media gallery, prerequisites, bundle API, type filter, re-seed         |
| Phase 3        | DONE — install flow (project + agent install, preview, post-install report, admin template manager) |

---

## Current State

### Phase 1 (DONE)

**Integration**: 45 tests passing (MongoMemoryServer, real Express server on random ports).
**UI Unit**: 42 tests passing (8 test files covering 7 components + store).
**E2E**: 5 Playwright specs with 23 test cases — all 23 passing against real services.

### Phase 2 (DONE)

**Integration**: 131 backend tests passing (MongoMemoryServer, real Express server on random ports).
**UI Unit**: 72 frontend tests passing (component + store tests).
**E2E**: 13 Playwright E2E specs written — all 23+ test cases passing against real services.

### Phase 3 (DONE)

**Integration**: 131 backend tests total covering browse, bundle, install (project + agent), admin CRUD, auth enforcement, error cases, install count/analytics tracking.
**UI Unit**: 72 frontend tests total covering marketplace components, install dialogs, admin template manager.
**E2E**: 13 Playwright E2E specs covering install flows, auth gating, post-install checklist, admin template management.

### Phase 3 Template Manager Tests

**Admin CRUD**: Template upload, edit dialog, archive confirmation, table columns (Name, Type, Category, Status, Downloads, Created), error/success banners.
**Admin API**: Upload endpoint (zip extraction, validation), PATCH endpoint (metadata update), archive endpoint, list endpoint (tenant-scoped).

### Phase 3 Integration Regression Tests (Added 2026-05-13)

These scenarios were identified after 5 bugs were discovered during manual install flow testing that the existing test suite did NOT catch. They cover cross-service auth, seed content validation, and real import pipeline integration.

**Integration**: 6 test scenarios (INT-29 through INT-34) covering foreign JWT on public endpoints, seed content import compatibility, and install flow with real import pipeline.

---

## Coverage Matrix

### Phase 1 (FR-1 through FR-15)

| #     | Functional Requirement             | Unit | Integration | E2E  | Manual | Status  |
| ----- | ---------------------------------- | ---- | ----------- | ---- | ------ | ------- |
| FR-1  | Public browse API (paginated)      | -    | PASS        | PASS | -      | PASSING |
| FR-2  | Filter by type/category/complexity | PASS | PASS        | PASS | -      | PASSING |
| FR-3  | Template detail by slug            | PASS | PASS        | PASS | -      | PASSING |
| FR-4  | Categories endpoint                | PASS | PASS        | PASS | -      | PASSING |
| FR-5  | Featured endpoint                  | PASS | PASS        | PASS | -      | PASSING |
| FR-6  | View count increment               | PASS | PASS        | PASS | -      | PASSING |
| FR-7  | Analytics event tracking + TTL     | PASS | PASS        | -    | -      | PASSING |
| FR-8  | Rate limiting (429)                | -    | PASS        | -    | -      | PASSING |
| FR-9  | Request ID header                  | -    | PASS        | -    | -      | PASSING |
| FR-10 | Standard error format              | -    | PASS        | -    | -      | PASSING |
| FR-11 | Studio proxy to template store     | -    | -           | PASS | -      | PASSING |
| FR-12 | UserMenu navigation entry          | -    | -           | PASS | -      | PASSING |
| FR-13 | Landing page layout                | -    | -           | PASS | -      | PASSING |
| FR-14 | Template card with badges          | PASS | -           | PASS | -      | PASSING |
| FR-15 | Composable detail sections         | PASS | -           | PASS | -      | PASSING |

### Phase 2 (FR-16 through FR-27)

| #     | Functional Requirement                 | Unit    | Integration | E2E     | Manual | Status  |
| ----- | -------------------------------------- | ------- | ----------- | ------- | ------ | ------- |
| FR-16 | TemplateVersion.files bundle storage   | -       | PLANNED     | -       | -      | PLANNED |
| FR-17 | TemplateVersion.manifest as ManifestV2 | -       | PLANNED     | -       | -      | PLANNED |
| FR-18 | Browse excludes `files` (projection)   | -       | PLANNED     | -       | -      | PLANNED |
| FR-19 | Bundle endpoint (GET .../bundle)       | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-20 | Prerequisites field on Template        | PLANNED | PLANNED     | PLANNED | -      | PLANNED |
| FR-21 | `media[]` replaces `screenshots[]`     | PLANNED | PLANNED     | PLANNED | -      | PLANNED |
| FR-22 | `reviewStatus` field                   | -       | PLANNED     | -       | -      | PLANNED |
| FR-23 | Type filter tabs (All/Projects/Agents) | PLANNED | PLANNED     | PLANNED | -      | PLANNED |
| FR-24 | Prerequisites display on detail page   | PLANNED | -           | PLANNED | -      | PLANNED |
| FR-25 | Seed script with files + manifests     | -       | PLANNED     | -       | -      | PLANNED |
| FR-26 | Bundle size validation (4MB max)       | -       | PLANNED     | -       | -      | PLANNED |
| FR-27 | Static media serving (/assets/...)     | -       | PLANNED     | PLANNED | -      | PLANNED |

### Phase 3 (FR-28 through FR-34)

| #     | Functional Requirement                   | Unit    | Integration | E2E     | Manual | Status  |
| ----- | ---------------------------------------- | ------- | ----------- | ------- | ------ | ------- |
| FR-28 | Project template install (create+import) | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-29 | Agent template install (merge into proj) | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-30 | Dry-run preview for agent install        | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-31 | Post-install provisioning report         | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-32 | Install endpoints require authentication | -       | PLANNED     | PLANNED | -      | PLANNED |
| FR-33 | Install count + analytics event tracking | -       | PLANNED     | -       | -      | PLANNED |
| FR-34 | Type-adaptive install CTA on detail page | PLANNED | -           | -       | -      | PLANNED |

### Phase 3 Integration Regression (FR-35 through FR-38)

These functional requirements were extracted from the 5 bugs found during manual testing of the install flow (2026-05-13).

| #     | Functional Requirement                              | Unit | Integration | E2E | Manual | Status  |
| ----- | --------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-35 | Public endpoints tolerate foreign/invalid JWTs      | -    | PLANNED     | -   | -      | PLANNED |
| FR-36 | Seed template ABL content passes import validation  | -    | PLANNED     | -   | -      | PLANNED |
| FR-37 | Install routes auto-acknowledge non-blocking issues | -    | PLANNED     | -   | -      | PLANNED |
| FR-38 | Seed bundles pass full dry-run import pipeline      | -    | PLANNED     | -   | -      | PLANNED |

Legend: PASS = Passing, PLANNED = Not yet implemented, - = N/A

---

## E2E Test Scenarios (Minimum 5)

All E2E tests use Playwright, exercise real HTTP APIs, and require both the template store service and Studio running.

### E2E-1: Marketplace landing page (Phase 1 — PASSING)

**File**: `apps/studio/e2e/marketplace-landing.spec.ts`

1. Navigate to Studio, click "Template Store" in sidebar
2. Verify landing page renders: hero section, featured templates grid, category grid with counts
3. Verify featured templates show type badges (Agent/Project)
4. Click "View All" on a category — verify navigation to category page
5. Verify page loads within performance budget

### E2E-2: Template detail page (Phase 1 — PASSING)

**File**: `apps/studio/e2e/marketplace-detail.spec.ts`

1. From landing page, click a template card
2. Verify detail page renders: hero (name, publisher, stats), type badge
3. Switch between tabs (Overview, Screenshots, Config Preview)
4. Verify demo conversation renders with alternating user/agent messages
5. Verify "Coming soon" install state shown (no install button)
6. Verify back navigation returns to previous page

### E2E-3: Search and filtering (Phase 1 — PASSING)

**File**: `apps/studio/e2e/marketplace-search.spec.ts`

1. Enter text in search bar — verify matching results returned
2. Apply category filter — verify results narrowed
3. Apply type filter (agent only) — verify only agent templates shown
4. Apply complexity filter — verify results filtered
5. Change sort order — verify order changes
6. Combine multiple filters — verify intersection
7. Clear all filters — verify full catalog shown
8. Search for nonexistent term — verify empty state

### E2E-4: Category browse (Phase 1 — PASSING)

**File**: `apps/studio/e2e/marketplace-category.spec.ts`

1. Click a category card on landing page
2. Verify category page renders with filtered templates
3. Verify pagination works (if >20 templates in category)
4. Verify breadcrumb navigation shows category name
5. Apply additional filter within category — verify further narrowing

### E2E-5: Responsive layout (Phase 1 — PASSING)

**File**: `apps/studio/e2e/marketplace-responsive.spec.ts`

1. Set viewport to mobile (375px) — verify landing page renders, grid adjusts to single column
2. Set viewport to tablet (768px) — verify 2-column grid
3. Set viewport to desktop (1280px) — verify 3+ column grid
4. On mobile: verify search bar collapses appropriately
5. On mobile: verify detail page tabs stack vertically

### E2E-6: Type filter tabs (Phase 2 — PLANNED)

**File**: `apps/studio/e2e/marketplace-search.spec.ts` (extend existing)

1. Navigate to marketplace landing or search page
2. Verify type filter tabs visible: "All", "Projects", "Agents"
3. Click "Projects" tab — verify only project-type templates shown, URL updated with `?type=project`
4. Click "Agents" tab — verify only agent-type templates shown, URL updated with `?type=agent`
5. Click "All" tab — verify all templates shown, type parameter cleared from URL
6. Combine type tab with category filter — verify intersection
7. Combine type tab with text search — verify intersection

### E2E-7: Template detail with media gallery and prerequisites (Phase 2 — PLANNED)

**File**: `apps/studio/e2e/marketplace-detail.spec.ts` (extend existing)

1. Navigate to a template with `media[]` containing both images and videos
2. Verify media section displays image thumbnails
3. Verify video entries show poster frame / thumbnail
4. Click a video — verify inline or lightbox playback starts
5. Verify prerequisites section visible on the detail page
6. Verify prerequisites section shows categorized lists: env vars, connectors, models, MCP servers, auth profiles
7. For a template with empty prerequisites, verify "No prerequisites — ready to install" message

### E2E-8: Bundle endpoint retrieval (Phase 2 — PLANNED)

**File**: `apps/studio/e2e/marketplace-detail.spec.ts` (extend existing) or separate API test

1. Identify a template slug and version from the detail page
2. Call `GET /api/v1/marketplace/templates/:slug/versions/:version/bundle` via fetch
3. Verify response includes `files` field as `Record<string, string>`
4. Verify `files` contains `project.json` key
5. Verify the `project.json` content parses as valid `ProjectManifestV2` (has `format_version: "2.0"`)
6. Call bundle endpoint with invalid slug — verify 404

### E2E-9: Static media asset serving (Phase 2 — PLANNED)

**File**: `apps/studio/e2e/marketplace-detail.spec.ts` (extend existing) or separate API test

1. Call `GET /assets/templates/<slug>/hero.png` — verify image returned with correct content type
2. Call `GET /assets/templates/<slug>/nonexistent.png` — verify 404
3. Verify media URLs in template detail response resolve to actual static files

### E2E-10: Project template install flow (Phase 3 — PLANNED)

**File**: `apps/studio/e2e/marketplace-install.spec.ts` (new)

1. Log in as an authenticated user with `project:create` permission
2. Navigate to a project-type template detail page
3. Verify "Create Project from Template" button is visible and enabled
4. Click "Create Project from Template" — verify project name/slug dialog appears
5. Enter a project name, optionally customize slug
6. Submit the form — verify loading state shown during install
7. Verify post-install report appears: project name, agents/tools created counts
8. Verify provisioning checklist shows required env vars, connectors, auth profiles
9. Verify navigation link to the new project is present
10. Navigate to the new project — verify agents and tools from the template exist

### E2E-11: Agent template install flow (Phase 3 — PLANNED)

**File**: `apps/studio/e2e/marketplace-install.spec.ts` (extend)

1. Log in as an authenticated user with project access
2. Navigate to an agent-type template detail page
3. Verify "Add to Project" button is visible and enabled
4. Click "Add to Project" — verify project selector dropdown appears
5. Select a target project from the dropdown
6. Verify dry-run preview displays: agents to be added, tools to be added, modifications (if any)
7. Review the preview counts — verify add/modify breakdown matches expected template content
8. Click "Confirm" to apply — verify loading state
9. Verify success message with applied counts (agents created, tools created)
10. Verify provisioning checklist for any required env vars or connectors
11. Navigate to the target project — verify the agent from the template exists

### E2E-12: Install requires authentication (Phase 3 — PLANNED)

**File**: `apps/studio/e2e/marketplace-install.spec.ts` (extend)

1. Navigate to a template detail page without being logged in (or log out first)
2. Verify the install button shows a login prompt or disabled state
3. Click the install button — verify redirect to login or authentication prompt
4. Verify no install API call is made without valid auth token

### E2E-13: Post-install checklist display (Phase 3 — PLANNED)

**File**: `apps/studio/e2e/marketplace-install.spec.ts` (extend)

1. Complete a project template install (per E2E-10 flow)
2. On the post-install report, verify required environment variables are listed (e.g., `OPENAI_API_KEY`)
3. Verify required connectors are listed (e.g., "Salesforce CRM")
4. Verify required MCP servers are listed if any
5. Verify required auth profiles are listed if any
6. For a template with empty prerequisites, verify "No additional configuration needed" message

---

## Integration Test Scenarios (Minimum 5)

All integration tests start a real Express server on a random port, seed test data in MongoDB, and interact only via HTTP.

### INT-1: Browse templates with pagination (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed 25 published templates in MongoDB
2. `GET /api/v1/marketplace/templates?page=1&limit=10` — verify 10 items, `total: 25`, `hasMore: true`
3. `GET /api/v1/marketplace/templates?page=3&limit=10` — verify 5 items, `hasMore: false`
4. Verify response includes all expected fields (slug, name, type, typeMetadata, category, etc.)

### INT-2: Filter by type, category, and complexity (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed templates: 5 agent/customer-service/starter, 3 project/sales/standard, 2 agent/hr/advanced
2. `GET ...?type=agent` — verify 7 results
3. `GET ...?category=customer-service` — verify 5 results
4. `GET ...?complexity=starter` — verify 5 results
5. `GET ...?type=agent&category=hr` — verify 2 results (intersection)

### INT-3: Full-text search (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed templates with varied names and tags
2. `GET ...?q=customer` — verify templates with "customer" in name/description/tags ranked first
3. `GET ...?q=nonexistent` — verify empty results with `total: 0`

### INT-4: Template detail + view count (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed a template with slug `test-template`, viewCount 0
2. `GET /api/v1/marketplace/templates/test-template` — verify full detail response
3. Verify `viewCount` incremented to 1 in the database
4. Verify analytics event `detail_view` created
5. `GET .../:nonexistent-slug` — verify 404 with standard error format

### INT-5: Categories and featured endpoints (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed templates across 4 categories
2. `GET /api/v1/marketplace/categories` — verify category names with correct counts
3. Seed 3 featured templates with `featuredOrder` values
4. `GET /api/v1/marketplace/featured` — verify ordered by `featuredOrder`

### INT-6: Rate limiting (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Configure rate limit: 5 requests per 1-second window (test-only config)
2. Send 5 requests — all return 200
3. Send 6th request — returns 429 with standard error format
4. Wait for window to expire — next request returns 200

### INT-7: Request ID and error format (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Send any request — verify `x-request-id` header present in response
2. `GET /api/v1/marketplace/templates?page=-1` — verify 400 with `{ success: false, error: { code, message } }`
3. `GET /nonexistent-path` — verify 404

### INT-8: Browse excludes `files` from responses (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed a template + version with a `files` bundle (populated `Record<string, string>`)
2. `GET /api/v1/marketplace/templates` — verify NO `files` field in any item in the response
3. `GET /api/v1/marketplace/templates/:slug` — verify detail response does NOT contain `files`
4. `GET /api/v1/marketplace/featured` — verify NO `files` field in any item
5. Verify response still includes all other expected Phase 2 fields (`media`, `prerequisites`, `reviewStatus`)

### INT-9: Bundle endpoint returns files for valid slug/version (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed a template with slug `bundle-test`, version `1.0.0`, with `files: { "project.json": "...", "agents/test.agent.abl": "..." }`
2. `GET /api/v1/marketplace/templates/bundle-test/versions/1.0.0/bundle` — verify HTTP 200
3. Verify response body contains `files` field with all seeded keys and values
4. Verify `files["project.json"]` is present and parseable as JSON
5. Verify no other template fields are returned (no `name`, `slug`, `media`, etc. — just `files`)

### INT-10: Bundle endpoint returns 404 for invalid slug or version (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. `GET /api/v1/marketplace/templates/nonexistent-slug/versions/1.0.0/bundle` — verify HTTP 404 with standard error format
2. `GET /api/v1/marketplace/templates/bundle-test/versions/99.0.0/bundle` — verify HTTP 404 (valid slug, nonexistent version)
3. `GET /api/v1/marketplace/templates/bundle-test/versions/not-semver/bundle` — verify HTTP 400 (invalid version format)

### INT-11: Template detail returns `media` and `prerequisites` (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed a template with `media: [{ type: 'image', url: '/assets/...', caption: 'Hero', order: 1 }, { type: 'video', url: '/assets/...', thumbnailUrl: '/assets/.../thumb.jpg', caption: 'Demo', order: 2 }]`
2. Seed the template with `prerequisites: { envVars: ['OPENAI_API_KEY'], connectors: ['Salesforce CRM'], mcpServers: [], authProfiles: ['oauth-salesforce'], models: ['gpt-4o'] }`
3. `GET /api/v1/marketplace/templates/:slug` — verify response includes `media` array with both entries, correct types, and order
4. Verify response includes `prerequisites` object with all five fields populated
5. Verify response does NOT include a `screenshots` field (deprecated)

### INT-12: Type filter on browse endpoints (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed 4 project templates and 6 agent templates, all published and public
2. `GET /api/v1/marketplace/templates?type=project` — verify 4 results, all with `type: "project"`
3. `GET /api/v1/marketplace/templates?type=agent` — verify 6 results, all with `type: "agent"`
4. `GET /api/v1/marketplace/templates` (no type param) — verify 10 results (all)
5. `GET /api/v1/marketplace/categories?type=agent` — verify category counts reflect only agent templates
6. Combine type filter with search: `GET ...?type=project&q=customer` — verify intersection

### INT-13: reviewStatus filtering (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Seed 3 templates: 2 with `reviewStatus: 'approved'`, 1 with `reviewStatus: 'pending'`
2. `GET /api/v1/marketplace/templates` — verify only the 2 approved templates appear
3. Verify pending templates are excluded from browse, search, featured, and categories
4. Template detail by slug for a pending template — verify 404 (or filtered out of public results)

### INT-14: Bundle size validation (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/repos/template-repo.test.ts` or seed validation test

1. Create a TemplateVersion with `files` bundle just under 4MB — verify it saves successfully
2. Create a TemplateVersion with `files` bundle exceeding 4MB — verify validation error is thrown
3. Verify the error message indicates the 4MB limit was exceeded

### INT-15: Static media asset serving (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`

1. Place a test image file at the expected static assets path
2. `GET /assets/templates/test-slug/hero.png` — verify HTTP 200, correct content type (`image/png`)
3. `GET /assets/templates/test-slug/nonexistent.png` — verify HTTP 404
4. `GET /assets/templates/nonexistent-slug/hero.png` — verify HTTP 404
5. Verify no directory listing is served (requesting `/assets/templates/` returns 404 or forbidden)

### INT-16: Seed script produces valid manifests and bundles (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/scripts/seed-templates.test.ts` (new)

1. Run the seed script against a test MongoDB instance
2. Query all template versions — verify each has a non-empty `files` field
3. Verify each `files["project.json"]` parses as valid JSON with `format_version: "2.0"`
4. Verify each template has `media` array (not `screenshots`)
5. Verify each template has `prerequisites` object with all five fields (may be empty arrays)
6. Verify each template has `reviewStatus: 'approved'`
7. Verify all `files` bundles are under 4MB

### INT-17: TemplateVersion manifest typed as ProjectManifestV2 (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/repos/template-repo.test.ts`

1. Seed a TemplateVersion with `manifest` containing valid `ProjectManifestV2` fields (`format_version`, `name`, `slug`, `entry_agent`, `agents`, `tools`, `metadata`)
2. Query the version — verify `manifest.format_version` is `"2.0"`
3. Verify `manifest.agents` is a populated object
4. Verify `manifest.metadata.required_env_vars` is an array
5. Verify `manifest.metadata.entity_counts` contains agent/tool counts

### INT-18: Project template install — creates project and imports bundle (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (new)

1. Seed a published template with slug `install-test`, version `1.0.0`, with a valid `files` bundle
2. `POST /api/template-install/project` with `{ templateSlug: "install-test", version: "1.0.0", projectName: "My Test Project" }` and valid JWT auth
3. Verify HTTP 200 with `{ success: true, project: { id, name, slug }, applied: { created, toolsCreated, ... }, entryAgentName, provisioningRequired: { envVars, connectors, mcpServers, authProfiles } }`
4. Verify a new project exists in the database with the provided name and the authenticated user's `tenantId`
5. Verify agents and tools from the template bundle are imported into the new project

### INT-19: Project template install — 401 without auth token (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)

1. `POST /api/template-install/project` with `{ templateSlug: "install-test", version: "1.0.0", projectName: "Test" }` and NO auth header
2. Verify HTTP 401 with standard error format `{ success: false, error: { code, message } }`
3. Verify no project was created in the database

### INT-20: Project template install — 404 for nonexistent template slug (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)

1. `POST /api/template-install/project` with `{ templateSlug: "nonexistent-template", version: "1.0.0", projectName: "Test" }` and valid JWT auth
2. Verify HTTP 404 with `{ success: false, error: { code: "NOT_FOUND", message: "..." } }`
3. Verify no project was created in the database

### INT-21: Project template install — 409 for duplicate project slug (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)

1. Create an existing project with slug `existing-project`
2. `POST /api/template-install/project` with `{ templateSlug: "install-test", version: "1.0.0", projectName: "Existing Project", projectSlug: "existing-project" }` and valid JWT auth
3. Verify HTTP 409 with `{ success: false, error: { code: "DUPLICATE_SLUG", message: "..." } }`
4. Verify no new project was created (the existing one is unchanged)

### INT-22: Agent template install preview — dry-run with add/modify counts (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (new)

1. Seed a published agent-type template with slug `agent-install-test`, containing one agent and two tools
2. Create a target project with `projectId` — initially empty
3. `POST /api/template-install/agent/[id]/preview` with `{ templateSlug: "agent-install-test", version: "1.0.0", projectId }` and valid JWT auth
4. Verify HTTP 200 with `{ success: true, preview: { agentChanges: { added: [...], modified: [], removed: [] }, toolChanges: { added: [...], modified: [], removed: [] } }, previewDigest: "..." }`
5. Verify the preview shows 1 agent added and 2 tools added (matching the template content)
6. Verify NO changes were actually applied to the target project (dry-run only)

### INT-23: Agent template install preview — 401 without auth token (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (extend)

1. `POST /api/template-install/agent/[id]/preview` with `{ templateSlug: "agent-install-test", version: "1.0.0", projectId: "..." }` and NO auth header
2. Verify HTTP 401 with standard error format

### INT-24: Agent template install apply — merges agent into existing project (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (extend)

1. Seed a published agent-type template with slug `agent-install-test`, containing one agent and two tools
2. Create a target project with `projectId` — may already have existing agents
3. First, get a preview digest: `POST /api/template-install/agent/[id]/preview` — extract `previewDigest` from response
4. `POST /api/template-install/agent/[id]/apply` with `{ templateSlug: "agent-install-test", version: "1.0.0", projectId, previewDigest }` and valid JWT auth
5. Verify HTTP 200 with `{ success: true, applied: { created, toolsCreated, ... }, provisioningRequired: { envVars, connectors, mcpServers, authProfiles } }`
6. Query the target project — verify the agent from the template now exists in the project
7. Verify existing agents in the project are unchanged (merge strategy, not replace)

### INT-25: Agent template install apply — 401 without auth token (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (extend)

1. `POST /api/template-install/agent/[id]/apply` with `{ templateSlug: "agent-install-test", version: "1.0.0", projectId: "...", previewDigest: "..." }` and NO auth header
2. Verify HTTP 401 with standard error format
3. Verify no changes were applied to the target project

### INT-26: Install count increments after successful project install (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)

1. Seed a template with slug `counter-install-test`, initial `installCount: 0`
2. Complete a successful project install via `POST /api/template-install/project`
3. Query the template document — verify `installCount` is now 1
4. Complete a second successful project install (different project name)
5. Query the template document — verify `installCount` is now 2

### INT-27: Install count increments after successful agent install (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (extend)

1. Seed an agent template with slug `agent-counter-test`, initial `installCount: 0`
2. Complete a successful agent install (preview + apply)
3. Query the template document — verify `installCount` is now 1

### INT-28: Install analytics event recorded on successful install (Phase 3 — PLANNED)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)

1. Complete a successful project install for template slug `analytics-install-test`
2. Query `template_analytics_events` for events with `eventType: "install"` and `templateSlug: "analytics-install-test"`
3. Verify one `install` event exists with `userId` (from JWT), `tenantId` (from JWT), `templateSlug`, and `metadata.projectId` matching the created project
4. Verify `createdAt` is within the last few seconds

### INT-29: Public endpoints return 200 (not 401) when a foreign JWT is present (Phase 3 — REGRESSION)

**File**: `apps/template-store/src/__tests__/routes/marketplace.test.ts`
**Bug Reference**: Bug 1 — Foreign JWT causes 401 on public endpoints

Tests MUST use a real Express server WITH `optionalAuth` middleware (not the main test server which skips it).

1. Build a separate Express app instance that includes `optionalAuth` middleware in the chain
2. Create a JWT signed with a different secret (simulating Studio's JWT)
3. `GET /api/v1/marketplace/templates` with `Authorization: Bearer <foreign-jwt>` — verify HTTP 200 (not 401)
4. `GET /api/v1/marketplace/templates/:slug/versions/:version/bundle` with foreign JWT — verify HTTP 200
5. `GET /api/v1/marketplace/templates/:slug` with foreign JWT — verify HTTP 200
6. Verify response bodies contain valid data (not empty or error objects)

### INT-30: Seed template ABL content passes import-validator syntax validation (Phase 3 — REGRESSION)

**File**: `apps/template-store/src/__tests__/scripts/seed-templates.test.ts` (extend)
**Bug Reference**: Bug 2 — ABL DSL syntax (missing colon in AGENT header)

1. Run the seed script against a test MongoDB instance
2. Query all template versions with `files` bundles
3. For each version, extract all agent ABL files (keys matching `agents/*.agent.abl`)
4. Feed each ABL file through `validateAgentSyntax(path, content)` from `@agent-platform/project-io/import`
5. Assert zero validation errors for every agent file across every seed template

### INT-31: Seed template bundles pass full dry-run import (Phase 3 — REGRESSION)

**File**: `apps/template-store/src/__tests__/scripts/seed-templates.test.ts` (extend)
**Bug Reference**: Bug 2 — Validates that seed content survives the full import pipeline, not just syntax

1. Run the seed script against a test MongoMemoryServer
2. For each seed template version, extract the `files` bundle as `Map<string, string>`
3. Create a test project in the same MongoMemoryServer
4. Call `importProjectV2({ files, projectId, tenantId, dryRun: true })` (or `previewStudioLayeredImportV2`)
5. Assert `hasBlockingIssues === false` on the preview result
6. Assert zero syntax errors in the preview

### INT-32: Project template install with real import pipeline (Phase 3 — REGRESSION)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)
**Bug Reference**: Bug 3 — Import preview acknowledgement required

1. Seed a published template with a valid `files` bundle containing real ABL DSL
2. `POST /api/template-install/project` with valid auth — this exercises the real `previewStudioLayeredImportV2` + `applyStudioLayeredImportV2` pipeline (NOT mocked)
3. Verify HTTP 201 (project created and import succeeded)
4. Query project agents — verify agents from the template bundle exist
5. Verify the route handled auto-acknowledgement of non-blocking import warnings internally

### INT-33: Agent template install with real import pipeline (Phase 3 — REGRESSION)

**File**: `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts` (extend)
**Bug Reference**: Bug 4 — Same acknowledgement issue on agent apply route

1. Seed a published agent-type template with valid `files` bundle
2. Create a target project with at least one existing agent
3. `POST /api/template-install/agent/[id]/preview` with valid auth — exercises real `previewStudioLayeredImportV2`
4. `POST /api/template-install/agent/[id]/apply` with previewDigest from step 3 — exercises real `applyStudioLayeredImportV2`
5. Verify HTTP 200 (import succeeded)
6. Query project agents — verify the template's agent was merged in alongside the existing agent

### INT-34: Install auto-acknowledges non-blocking issues (Phase 3 — REGRESSION)

**File**: `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` (extend)
**Bug Reference**: Bugs 3 & 4 — Verifies the auto-acknowledgement mechanism explicitly

1. Seed a template whose bundle produces non-blocking import warnings (e.g., missing optional fields, deprecation warnings)
2. `POST /api/template-install/project` with valid auth
3. Verify HTTP 201 (install succeeded despite non-blocking warnings)
4. Verify project was created with imported agents/tools
5. If possible, capture logs or response metadata confirming auto-acknowledgement occurred (e.g., log message "Auto-acknowledging non-blocking issues for template install")

---

## Unit Test Scenarios

### Unit: template-repo browse queries (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/repos/template-repo.test.ts`

- Filter construction for type, category, complexity, text search
- Pagination offset/limit calculation
- Sort order mapping (popular — installCount desc, newest — createdAt desc, etc.)
- Category aggregation pipeline
- Featured query with featuredOrder sort

### Unit: template-repo Phase 2 queries (Phase 2 — PLANNED)

**File**: `apps/template-store/src/__tests__/repos/template-repo.test.ts`

- Browse projection excludes `files` from template version joins
- Type filter parameter constructs correct MongoDB query
- reviewStatus filter defaults to `'approved'` for public browse queries
- Bundle retrieval query returns only `files` field for matching slug+version
- Bundle retrieval returns null for non-matching slug or version
- Prerequisites query returns all five sub-fields (envVars, connectors, mcpServers, authProfiles, models)

### Unit: analytics-repo (Phase 1 — PASSING)

**File**: `apps/template-store/src/__tests__/repos/analytics-repo.test.ts`

- `trackEvent()` creates document with correct fields
- Nullable fields (userId, tenantId) handled correctly for unauthenticated requests
- Event type validation

### Unit: UI components (Phase 1 — PASSING)

**File**: `apps/studio/src/__tests__/components/marketplace/*.test.tsx`

- `TemplateTypeBadge`: renders correct label/color for agent, project, and unknown types
- `TemplateCard`: renders name, description, type badge, category, stats; click fires navigation
- `CategoryGrid`: renders cards with icons and counts; click navigates to category page
- `TemplateSearchBar`: search input fires debounced query, filter dropdowns update store, reset clears
- `TemplateScreenshotGallery`: renders thumbnails, lightbox opens on click, navigation arrows work
- `DemoConversation`: renders message bubbles with alternating user/agent styles
- `TemplateConfigPreview`: renders config schema fields in read-only mode

### Unit: Media gallery component (Phase 2 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/TemplateScreenshotGallery.test.tsx` (extend) or `MediaGallery.test.tsx` (new)

- Renders image items with `<img>` tags, correct `src` and `alt` from `media[].url` and `media[].caption`
- Renders video items with `<video>` tag or video player component
- Video items display poster frame from `media[].thumbnailUrl`
- Handles mixed image + video `media[]` array, respects `order` field for display sequence
- Handles empty `media[]` array — shows empty state (no crash)
- Lightbox works for both images and videos
- Navigation arrows cycle through all media items regardless of type

### Unit: Prerequisites display component (Phase 2 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/PrerequisitesDisplay.test.tsx` (new)

- Renders categorized sections: "Required Environment Variables", "Required Connectors", "Required Models", "Required MCP Servers", "Required Auth Profiles"
- Each section renders items as chips/badges from the corresponding prerequisites array
- Sections with empty arrays are hidden (not rendered with "none" label)
- When ALL prerequisite arrays are empty, displays "No prerequisites — ready to install" message
- Renders partial prerequisites (e.g., only `envVars` populated, rest empty) — shows only populated sections

### Unit: Type filter tabs (Phase 2 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/TypeFilterTabs.test.tsx` (new) or extend `TemplateSearchBar.test.tsx`

- Renders three tabs: "All", "Projects", "Agents"
- Clicking a tab calls the store's `setTemplateType` action with the correct value
- Active tab has visual active state (different background/underline)
- "All" tab passes `undefined` or empty string as type filter
- "Projects" tab passes `type=project`
- "Agents" tab passes `type=agent`

### Unit: Template card with type badge (Phase 2 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/TemplateCard.test.tsx` (extend)

- Card renders type badge that distinguishes "Agent" (cyan) from "Project" (purple)
- Badge is visible and correctly styled for both types

### Unit: marketplace-store (Phase 1 — PASSING)

**File**: `apps/studio/src/__tests__/store/marketplace-store.test.ts`

- `fetchTemplates`: loading — success — data populated; loading — error — error message set
- `fetchTemplateDetail`: loads full detail into selectedTemplate
- Filter actions: setQuery, setCategory, setTemplateType, setSort, setPage update state correctly
- `resetFilters`: clears all filters to defaults
- Pagination: page change triggers refetch

### Unit: marketplace-store Phase 2 updates (Phase 2 — PLANNED)

**File**: `apps/studio/src/__tests__/store/marketplace-store.test.ts` (extend)

- `setTemplateType` action updates `templateType` filter in state
- `fetchTemplateDetail` populates `media` and `prerequisites` on `selectedTemplate`
- Store types include `media[]`, `prerequisites`, `reviewStatus` fields
- `fetchBundle` action (if added) retrieves `files` from bundle endpoint

### Unit: InstallButton component (Phase 3 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/InstallButton.test.tsx` (new)

- Renders "Create Project from Template" label for templates with `type: 'project'`
- Renders "Add to Project" label for templates with `type: 'agent'`
- When user is not authenticated: button shows login prompt or disabled state
- When user is authenticated: button is enabled and clickable
- Click fires the appropriate install action (project creation dialog vs agent project selector)
- Button uses correct i18n keys from the marketplace namespace

### Unit: ProjectInstallDialog component (Phase 3 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/ProjectInstallDialog.test.tsx` (new)

- Renders project name input field with label
- Renders auto-generated slug from name (slugified, lowercase, hyphens)
- Renders optional description textarea
- Validates project name: required, max 100 chars, pattern enforcement
- Validates slug: lowercase alphanumeric + hyphens, max 50 chars
- Submit button disabled when name is empty or invalid
- Submit calls install API with correct payload (`templateSlug`, `version`, `projectName`, `projectSlug`)
- Cancel button closes the dialog without API call
- Loading state shown during API call, inputs disabled
- Error state shown when API returns error (duplicate slug, template not found)

### Unit: AgentInstallDialog component (Phase 3 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/AgentInstallDialog.test.tsx` (new)

- Renders project selector dropdown populated with user's projects
- Selecting a project triggers preview API call
- Preview results displayed: agents to be added, tools to be added, modification counts
- Confirm button enabled after preview loads successfully
- Confirm calls apply API with `projectId`, `templateSlug`, `version`, `previewDigest`
- Cancel button closes dialog without applying
- Loading state shown during preview fetch and during apply
- Error state shown when preview fails (project not found, auth error)

### Unit: PostInstallReport component (Phase 3 — PLANNED)

**File**: `apps/studio/src/__tests__/components/marketplace/PostInstallReport.test.tsx` (new)

- Renders applied counts: agents created, agents updated, tools created
- Renders provisioning checklist section when `provisioningRequired` has items
- Renders env var names as chips/badges under "Required Environment Variables"
- Renders connector names under "Required Connectors"
- Renders MCP server names under "Required MCP Servers"
- Renders auth profile names under "Required Auth Profiles"
- When all provisioning arrays are empty, shows "No additional configuration needed"
- Renders "Go to Project" link with correct project ID
- Renders entry agent name if available

---

## Security & Isolation Tests

| #   | Scenario                                                         | Type        | Phase | Status  |
| --- | ---------------------------------------------------------------- | ----------- | ----- | ------- |
| 1   | Browse API serves only published+public templates                | integration | 1     | PASS    |
| 2   | Draft/archived templates not visible in browse results           | integration | 1     | PASS    |
| 3   | Rate limiting enforced per IP                                    | integration | 1     | PASS    |
| 4   | CORS headers present in production mode                          | integration | 1     | PLANNED |
| 5   | Invalid query params return 400, not 500                         | integration | 1     | PASS    |
| 6   | Browse API serves only `reviewStatus: 'approved'` templates      | integration | 2     | PLANNED |
| 7   | Pending/rejected reviewStatus templates excluded from all browse | integration | 2     | PLANNED |
| 8   | Bundle endpoint does not expose non-published template files     | integration | 2     | PLANNED |
| 9   | Static asset serving does not allow directory traversal          | integration | 2     | PLANNED |
| 10  | Bundle size limit enforced (reject > 4MB)                        | integration | 2     | PLANNED |
| 11  | Project install requires `project:create` permission             | integration | 3     | PLANNED |
| 12  | Agent install preview requires `PROJECT_READ` permission         | integration | 3     | PLANNED |
| 13  | Agent install apply requires `PROJECT_IMPORT` permission         | integration | 3     | PLANNED |
| 14  | Install does not expose bundle content to client                 | integration | 3     | PLANNED |
| 15  | Installed project is scoped to authenticated user's tenant       | integration | 3     | PLANNED |
| 16  | Agent install into project scoped to user's tenant only          | integration | 3     | PLANNED |
| 17  | Install analytics events include userId and tenantId from JWT    | integration | 3     | PLANNED |
| 18  | optionalAuth tolerates foreign/invalid JWTs on public endpoints  | integration | 3-reg | PLANNED |
| 19  | Seed template ABL content passes import-validator syntax check   | integration | 3-reg | PLANNED |
| 20  | Seed template bundles pass full dry-run import pipeline          | integration | 3-reg | PLANNED |
| 21  | Install auto-acknowledges non-blocking import warnings           | integration | 3-reg | PLANNED |

---

## Testing Lessons Learned (Phase 3 Install Flow — 2026-05-13)

Five bugs were discovered during manual testing of the install flow that the existing test suite did NOT catch. This section documents WHY they were missed and the rules established to prevent recurrence.

### Why These Bugs Were Missed

1. **Integration tests skipped middleware** (Bug 1): The main test server in `marketplace.test.ts` was built without `optionalAuth` middleware, so auth middleware behavior was never tested. The foreign JWT bug only manifests when `optionalAuth` is in the middleware chain — a server without it cannot reproduce the issue.

2. **Seed content was treated as data, not as import input** (Bug 2): Tests validated seed template structure in MongoDB (correct fields, correct types) but never validated that the stored ABL content would survive the import pipeline's syntax validation. The seed script used `AGENT supervisor` (no colon) but the import validator requires `AGENT: supervisor` (with colon). Since no test fed seed content through `validateAgentSyntax()`, the mismatch went undetected.

3. **Import pipeline was mocked in install route tests** (Bugs 3 & 4): Tests verified "did the route call the right function with the right args" instead of "does the actual import succeed." The import pipeline's `applyStudioLayeredImportV2` requires `previewDigest` + `acknowledgedIssueIds` when the preview contains non-blocking issues. Since the function was mocked, the acknowledgement requirement was invisible to tests.

4. **No cross-service integration test** (Bug 1): No test exercised the Studio -> template-store -> import pipeline flow end-to-end. Studio forwarding its JWT to template-store's public endpoints was never tested because the two services were tested in isolation.

5. **Monorepo build hygiene** (Bug 5): Stale `dist/` directories in 29 packages caused webpack resolution failures. This is not a template-store test gap per se, but a "Studio dev server starts successfully" smoke test would have caught it.

### Rules for Future Template Store Work

1. **Every seed template's `files` bundle MUST pass a round-trip test**: seed -> extract bundle -> feed through `validateAgentSyntax()` for each agent file -> feed through `importProjectV2(dryRun: true)` -> assert zero blocking issues. This is the minimum bar for seed content quality.

2. **Integration tests that involve middleware MUST include that middleware**: If the production code path includes `optionalAuth`, `rateLimiter`, or any other middleware, the test server must include it too. A test without middleware tests a different code path than production.

3. **Install route tests MUST use real import pipeline**: Do not mock `applyStudioLayeredImportV2` or `previewStudioLayeredImportV2`. The acknowledgement mechanism, preview digest validation, and conflict strategy logic are all inside these functions — mocking them hides the bugs they contain.

4. **Cross-service calls need their own test category**: When Service A calls Service B, test the call with Service B's actual middleware stack, including what happens when Service A sends unexpected headers.

---

## Phase 2 Test Plan Summary

### New Test Files (Phase 2)

| File                                                                             | Type        | Scenarios |
| -------------------------------------------------------------------------------- | ----------- | --------- |
| `apps/template-store/src/__tests__/scripts/seed-templates.test.ts`               | integration | 7         |
| `apps/studio/src/__tests__/components/marketplace/PrerequisitesDisplay.test.tsx` | unit        | 5         |
| `apps/studio/src/__tests__/components/marketplace/TypeFilterTabs.test.tsx`       | unit        | 6         |

### Existing Files to Extend (Phase 2)

| File                                                                                  | Type        | New Scenarios |
| ------------------------------------------------------------------------------------- | ----------- | ------------- |
| `apps/template-store/src/__tests__/routes/marketplace.test.ts`                        | integration | ~30           |
| `apps/template-store/src/__tests__/repos/template-repo.test.ts`                       | unit        | ~6            |
| `apps/studio/src/__tests__/components/marketplace/TemplateScreenshotGallery.test.tsx` | unit        | ~7            |
| `apps/studio/src/__tests__/components/marketplace/TemplateCard.test.tsx`              | unit        | ~2            |
| `apps/studio/src/__tests__/store/marketplace-store.test.ts`                           | unit        | ~4            |
| `apps/studio/e2e/marketplace-search.spec.ts`                                          | e2e         | ~7            |
| `apps/studio/e2e/marketplace-detail.spec.ts`                                          | e2e         | ~10           |

---

## Phase 3 Test Plan Summary

### New Test Files (Phase 3)

| File                                                                             | Type        | Scenarios |
| -------------------------------------------------------------------------------- | ----------- | --------- |
| `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts`     | integration | 6         |
| `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts`       | integration | 5         |
| `apps/studio/src/__tests__/components/marketplace/InstallButton.test.tsx`        | unit        | 6         |
| `apps/studio/src/__tests__/components/marketplace/ProjectInstallDialog.test.tsx` | unit        | 10        |
| `apps/studio/src/__tests__/components/marketplace/AgentInstallDialog.test.tsx`   | unit        | 8         |
| `apps/studio/src/__tests__/components/marketplace/PostInstallReport.test.tsx`    | unit        | 9         |
| `apps/studio/e2e/marketplace-install.spec.ts`                                    | e2e         | 4         |

### Existing Files to Extend (Phase 3)

| File                                                        | Type | New Scenarios |
| ----------------------------------------------------------- | ---- | ------------- |
| `apps/studio/src/__tests__/store/marketplace-store.test.ts` | unit | ~3            |

### Phase 3 Integration Regression Files (added 2026-05-13)

| File                                                                         | Type        | New Scenarios |
| ---------------------------------------------------------------------------- | ----------- | ------------- |
| `apps/template-store/src/__tests__/routes/marketplace.test.ts`               | integration | 3 (INT-29)    |
| `apps/template-store/src/__tests__/scripts/seed-templates.test.ts`           | integration | 2 (INT-30,31) |
| `apps/studio/src/app/api/template-install/__tests__/project-install.test.ts` | integration | 2 (INT-32,34) |
| `apps/studio/src/app/api/template-install/__tests__/agent-install.test.ts`   | integration | 1 (INT-33)    |

### Detailed Test Cases

See [template-store-test-cases.md](./template-store-test-cases.md) for the full test case catalog with TC-IDs, covering Phase 1 (TC-TS-001 through TC-TS-058), Phase 2 (TC-TS-059 through TC-TS-095), Phase 3 (TC-TS-096 through TC-TS-130), and Phase 3 Regression (TC-TS-131 through TC-TS-139).
