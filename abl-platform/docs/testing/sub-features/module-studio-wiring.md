# Test Specification: Module Studio Wiring

**Feature Spec**: [`docs/features/sub-features/module-studio-wiring.md`](../../features/sub-features/module-studio-wiring.md)
**Parent Test Spec**: [`docs/testing/reusable-agent-modules.md`](../reusable-agent-modules.md)
**HLD**: [`docs/specs/module-studio-wiring.hld.md`](../../specs/module-studio-wiring.hld.md)
**LLD**: [`docs/plans/2026-03-25-module-studio-wiring-impl-plan.md`](../../plans/2026-03-25-module-studio-wiring-impl-plan.md)
**Status**: PARTIAL (BETA)
**Last Updated**: 2026-04-15

---

## 1. Coverage Matrix

| FR   | Description                         | Unit    | Integration | E2E             | Manual | Status  |
| ---- | ----------------------------------- | ------- | ----------- | --------------- | ------ | ------- |
| FR-1 | ProjectPage variants + URL parsing  | PASS    | N/A         | PASS (indirect) | ❌     | PASS    |
| FR-2 | settings-modules renders panel      | PASS    | N/A         | PASS (indirect) | ❌     | PASS    |
| FR-3 | module-dependencies renders list    | PASS    | PASS        | PASS (indirect) | ❌     | PASS    |
| FR-4 | Settings group sidebar entry        | PASS    | N/A         | PASS (indirect) | ❌     | PASS    |
| FR-5 | Resources section sidebar entry     | PASS    | N/A         | PASS (indirect) | ❌     | PASS    |
| FR-6 | Project-level loadDependencies init | N/A     | PASS        | PARTIAL         | ❌     | PASS    |
| FR-7 | Publish trigger opens dialog        | PASS    | N/A         | PASS (indirect) | ❌     | PASS    |
| FR-8 | Releases list with archive buttons  | PASS    | N/A         | PARTIAL         | ❌     | PASS    |
| FR-9 | No conditional nav hiding           | PARTIAL | N/A         | PARTIAL         | ❌     | PARTIAL |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests use Playwright against a real Studio server at `localhost:5173` with full middleware chain. No mocks, no direct DB access. Auth via `devLogin()` + `getToken()` helpers. Chromium only.

### E2E-1: Navigate to Module Settings Page

- **Covers**: FR-1, FR-2, FR-4
- **Preconditions**: Studio running on port 5173. Authenticated via `devLogin(page)`. Project exists.
- **Steps**:
  1. Navigate to project dashboard
  2. Click the "Modules" item in the Settings sidebar group
  3. Verify URL matches `/projects/:id/settings/modules`
  4. Verify `ModuleSettingsPanel` renders with the module enable toggle
  5. Verify the visibility selector (`private` / `tenant`) is present
  6. Verify the `ReverseDepPanel` section exists (may be collapsed)
- **Expected Result**: Module settings page renders with full panel content. URL is correct.
- **Auth Context**: Authenticated user with project access (`dev@kore.ai`)
- **Isolation Check**: Navigation is project-scoped — URL contains the project ID

### E2E-2: Navigate to Module Dependencies Page

- **Covers**: FR-1, FR-3, FR-5
- **Preconditions**: Studio running. Authenticated. Project exists.
- **Steps**:
  1. Navigate to project dashboard
  2. Click the "Dependencies" item in the Resources sidebar section
  3. Verify URL matches `/projects/:id/module-dependencies`
  4. Verify `ModuleDependencyList` renders (may show empty state)
  5. Verify "Import Module" button is visible
- **Expected Result**: Dependencies page renders with the dependency list and import trigger.
- **Auth Context**: Authenticated user with project access
- **Isolation Check**: Dependencies API call scoped to the current project ID

### E2E-3: Imported Symbols Appear in Symbol Tree After Project Load

- **Covers**: FR-6
- **Preconditions**: Studio running. Authenticated. Two projects exist: a module project with a published release, and a consumer project that has imported that release.
- **Data Seeding** (API calls in `beforeAll`):
  1. `POST /api/projects/:moduleId/module` — enable module mode on provider project
  2. `POST /api/projects/:moduleId/module/releases` — publish release v1.0.0
  3. `POST /api/projects/:consumerId/module-dependencies` — import with alias `idv`
- **Steps**:
  1. Navigate to the consumer project
  2. Wait for the project to load (verify project name in header)
  3. Open the agent editor / ABL symbol tree
  4. Verify imported agents appear with `idv.` alias prefix (e.g., `idv.verify`) and provenance badges
- **Expected Result**: `ABLSymbolTree` displays imported module agents with correct alias-dot-name format and provenance labels. The hook returns separate `{ name, alias }` fields; the UI composes `alias.name` for display.
- **Auth Context**: Authenticated user with project access to both projects
- **Isolation Check**: Imported symbols are scoped to the consumer project — switching to the module project shows its own agents without the `idv.` prefix
- **Cleanup**: Remove the dependency in `afterAll`

### E2E-4: Import Module Flow Opens from Dependencies Page

- **Covers**: FR-3, FR-7 (analogous for import)
- **Preconditions**: Studio running. Authenticated. A module project exists with a published release visible to the consumer's tenant.
- **Steps**:
  1. Navigate to the consumer project
  2. Click "Dependencies" in the Resources sidebar
  3. Click the "Import Module" button
  4. Verify `ImportModuleDialog` opens with catalog browse step (step 1)
  5. Verify at least one module appears in the catalog list
  6. Select a module and verify contract preview loads
  7. Close the dialog without importing
- **Expected Result**: Import dialog opens with real catalog data and contract preview.
- **Auth Context**: Authenticated user (`dev@kore.ai`) with project access to the consumer project (tenant: default tenant, project: consumer project ID, user: dev user). The `MODULE_IMPORT` permission is checked by the backend API; the E2E test verifies the UI flow with a user who has this permission.
- **Isolation Check**: Catalog shows only tenant-visible modules

### E2E-5: Publish Release Flow and Releases List from Module Settings

- **Covers**: FR-2, FR-7, FR-8
- **Preconditions**: Studio running. Authenticated. A module project exists (kind=module) with at least one previously published release (seeded in `beforeAll` via `POST /api/projects/:id/module/releases`).
- **Steps**:
  1. Navigate to the module project
  2. Click "Modules" in the Settings sidebar group
  3. Verify the module settings panel shows module mode is enabled
  4. Verify the releases list section is visible below the settings panel
  5. Verify the previously published release appears in the list with its version number
  6. Verify each release row has an "Archive" action button (`ArchiveReleaseButton`)
  7. Click the "Publish Release" button
  8. Verify `PublishModuleDialog` opens with:
     - Version input field
     - Release notes field
     - Environment promotion picker (dev/staging/production/none)
  9. Close the dialog without publishing
- **Expected Result**: Module settings page shows settings panel, releases list with archive actions, and publish dialog with all required fields.
- **Auth Context**: Authenticated user (`dev@kore.ai`) with project access to the module project (tenant: default tenant, project: module project ID, user: dev user). The `MODULE_PUBLISH` permission is checked by the backend API; the E2E test verifies the UI flow with a user who has this permission.
- **Isolation Check**: Release publish is scoped to the current module project

### E2E-6: Imported Tools in ToolPickerDialog

- **Covers**: FR-6
- **Preconditions**: Studio running. Authenticated. Consumer project has imported a module with tools.
- **Data Seeding**: Same as E2E-3 (module with tools published, imported by consumer)
- **Steps**:
  1. Navigate to the consumer project
  2. Open an agent editor
  3. Open the tool picker dialog
  4. Verify imported tools appear with `idv.` alias prefix (e.g., `idv.check-id`)
  5. Verify imported tools have "Imported" badge and module provenance label
  6. Verify imported tools are not editable (read-only)
- **Expected Result**: `ToolPickerDialog` includes imported tools with correct provenance display.
- **Auth Context**: Authenticated user with project access
- **Isolation Check**: Imported tools are only visible in the consumer project context

### E2E-7: Feature Flag Disabled State

- **Covers**: FR-9
- **Preconditions**: Studio running. Authenticated.
- **Convention Note**: This scenario uses `page.route()` to override the `/api/features` response. This is an **established project convention** for feature flag testing in Playwright E2E tests — the existing `reusable-agent-modules-smoke.spec.ts` (MOD-4) uses the identical pattern. There is no admin API to toggle feature flags on a running server, so `page.route()` is the sole mechanism. This is the only acceptable use of `page.route()` in E2E tests — it is NOT used to mock business logic or data APIs.
- **Steps**:
  1. Intercept the `/api/features` endpoint via `page.route()` to return `{ reusable_modules: false }`
  2. Navigate to a project
  3. Verify "Modules" sidebar item is still visible in the Settings group
  4. Verify "Dependencies" sidebar item is still visible in the Resources section
  5. Click "Modules" to navigate to settings-modules
  6. Verify the module enable toggle is disabled with a "feature not available" message
  7. Unroute the `/api/features` intercept to restore normal behavior
- **Expected Result**: Sidebar items remain visible. Module settings shows disabled state.
- **Auth Context**: Authenticated user (`dev@kore.ai`) with project access (tenant: default tenant, project: test project ID, user: dev user)
- **Isolation Check**: Feature flag interception is page-scoped (restored after test)

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests use the **real Zustand store** (`module-store.ts`) and **real `useImportedSymbols` hook** but **mock the HTTP API layer** (`api/modules.ts`). Rendered in happy-dom via `vitest.unit.config.ts`.

### INT-1: loadDependencies Populates Store and useImportedSymbols

- **Covers**: FR-6
- **Boundary**: `module-store.loadDependencies()` → Zustand store → `useImportedSymbols` hook
- **Setup**: Mock `listDependencies` to return `{ data: [{ alias: 'idv', contractSnapshot: { providedAgents: [{ name: 'verify' }], providedTools: [{ name: 'check-id' }], ... } }] }`
- **Steps**:
  1. Call `useModuleStore.getState().loadDependencies('proj-1')`
  2. Wait for the promise to resolve
  3. Read `useModuleStore.getState().dependencies`
  4. Render a component that calls `useImportedSymbols()`
  5. Assert the hook returns `{ agents: [{ name: 'verify', alias: 'idv', moduleProjectName: '...', dependencyId: '...' }], tools: [{ name: 'check-id', alias: 'idv', moduleProjectName: '...', dependencyId: '...' }], hasDependencies: true }`
- **Expected Result**: Store is populated. `useImportedSymbols` returns separate `name` and `alias` fields (consuming components compose display as `alias.name`).
- **Failure Mode**: If `listDependencies` mock returns empty, `useImportedSymbols` returns empty arrays — verified as no-crash behavior.

### INT-2: loadDependencies API Failure Degrades Gracefully

- **Covers**: FR-6
- **Boundary**: `module-store.loadDependencies()` → error handling → `useImportedSymbols`
- **Setup**: Mock `listDependencies` to reject with `new Error('Network error')`
- **Steps**:
  1. Call `useModuleStore.getState().loadDependencies('proj-1')`
  2. Wait for the promise to resolve (catch)
  3. Verify `useModuleStore.getState().dependencies` is `[]`
  4. Verify `useModuleStore.getState().dependenciesLoading` is `false`
  5. Render a component that calls `useImportedSymbols()`
  6. Assert the hook returns `{ agents: [], tools: [], hasDependencies: false }`
  7. Verify no unhandled error is thrown
- **Expected Result**: Store remains empty. No crash. Authoring surfaces degrade to empty.
- **Failure Mode**: The error is caught in the store's try/catch and logged to console.

### INT-3: Project Switch Triggers New loadDependencies Call

- **Covers**: FR-6
- **Boundary**: `AppShell` project-level `useEffect` → `module-store.loadDependencies()`
- **Setup**: Mock `listDependencies` with different return values per projectId:
  - `'proj-A'` returns `[{ alias: 'alpha', ... }]`
  - `'proj-B'` returns `[{ alias: 'beta', ... }]`
- **Steps**:
  1. Render a test component with the project-level init effect, projectId = `'proj-A'`
  2. Wait for `loadDependencies('proj-A')` to complete
  3. Verify `dependencies` contains `alpha` alias
  4. Re-render with projectId = `'proj-B'`
  5. Wait for `loadDependencies('proj-B')` to complete
  6. Verify `dependencies` now contains `beta` alias (not `alpha`)
- **Expected Result**: Store contains the latest project's dependencies after each switch.
- **Failure Mode**: If stale response from `proj-A` overwrites `proj-B` data, the test documents this race condition as a known gap.

### INT-4: loadDependencies Race Condition on Rapid Project Switch

- **Covers**: FR-6
- **Boundary**: `module-store.loadDependencies()` concurrent calls
- **Setup**: Mock `listDependencies` with delayed responses:
  - `'proj-A'` resolves after 200ms with `[{ alias: 'alpha' }]`
  - `'proj-B'` resolves after 50ms with `[{ alias: 'beta' }]`
- **Steps**:
  1. Call `loadDependencies('proj-A')` (starts but doesn't await)
  2. Immediately call `loadDependencies('proj-B')` (starts but doesn't await)
  3. Wait for both to resolve (B resolves first at 50ms, A at 200ms)
  4. Read `useModuleStore.getState().dependencies`
- **Expected Result**: Document the current behavior (last-write-wins: if no guard exists, store ends up with `proj-A` data which is stale). This test serves as a regression marker — if the implementation adds a stale-request guard, the expected result should change to `proj-B` data.
- **Failure Mode**: Known race condition — regression marker for future fix. No dedicated GAP in the feature spec; the `loadDependencies` store action lacks a stale-request guard.

### INT-5: ModuleSettingsPage Composes Settings Panel with Publish Trigger

- **Covers**: FR-2, FR-7, FR-8
- **Boundary**: `ModuleSettingsPage` → `ModuleSettingsPanel` + `PublishModuleDialog` + releases list
- **Setup**: Mock `module-store` with `releases: [{ _id: 'r1', version: '1.0.0', createdAt: '...' }]`. Mock `navigation-store` with `page: 'settings-modules'`, `projectId: 'proj-1'`. Mock `use-features` returning `{ hasModules: true }`.
- **Steps**:
  1. Render `<ModuleSettingsPage />`
  2. Verify `ModuleSettingsPanel` renders (check for module toggle element)
  3. Verify a "Publish Release" button is present
  4. Click the "Publish Release" button
  5. Verify `PublishModuleDialog` opens (check for version input)
  6. Verify the releases list shows "1.0.0"
  7. Verify each release row has an archive action button
- **Expected Result**: All three sub-components render correctly in the page wrapper.

### INT-6: ModuleDependenciesPage Composes Dependency List with Import Trigger

- **Covers**: FR-3
- **Boundary**: `ModuleDependenciesPage` → `ModuleDependencyList` + `ImportModuleDialog`
- **Setup**: Mock `module-store` with `dependencies: [{ alias: 'idv', resolvedVersion: '1.0.0', moduleProjectName: 'IDV Module' }]`. Mock `navigation-store` with `page: 'module-dependencies'`, `projectId: 'proj-1'`.
- **Steps**:
  1. Render `<ModuleDependenciesPage />`
  2. Verify `ModuleDependencyList` renders with the `idv` dependency
  3. Verify "Import Module" button is present
  4. Click "Import Module"
  5. Verify `ImportModuleDialog` opens (check for catalog browse step)
- **Expected Result**: Dependency list and import trigger render and interact correctly.

### INT-7: Feature Flag Off Disables Module Settings

- **Covers**: FR-9
- **Boundary**: `ModuleSettingsPage` → `useFeatures()` → disabled state
- **Setup**: Mock `use-features` returning `{ hasModules: false }`. Mock `navigation-store` with `page: 'settings-modules'`.
- **Steps**:
  1. Render `<ModuleSettingsPage />`
  2. Verify the module enable toggle is disabled
  3. Verify a message indicates the feature is not available
  4. Verify the "Publish Release" button is disabled or hidden
- **Expected Result**: Page renders but all module actions are disabled.

---

## 4. Unit Test Scenarios

### UT-1: parseUrl Maps settings-modules URL

- **Module**: `navigation-store.ts` → `parseUrl()`
- **Input**: `/projects/proj-123/settings/modules`
- **Expected Output**: `{ page: 'settings-modules', projectId: 'proj-123' }`

### UT-2: parseUrl Maps module-dependencies URL

- **Module**: `navigation-store.ts` → `parseUrl()`
- **Input**: `/projects/proj-123/module-dependencies`
- **Expected Output**: `{ page: 'module-dependencies', projectId: 'proj-123' }`

### UT-3: buildPath Generates settings-modules URL

- **Module**: `navigation-store.ts` → `buildPath()`
- **Input**: `{ page: 'settings-modules', projectId: 'proj-123' }`
- **Expected Output**: `/projects/proj-123/settings/modules`

### UT-4: buildPath Generates module-dependencies URL

- **Module**: `navigation-store.ts` → `buildPath()`
- **Input**: `{ page: 'module-dependencies', projectId: 'proj-123' }`
- **Expected Output**: `/projects/proj-123/module-dependencies`

### UT-5: renderContent Returns ModuleSettingsPage for settings-modules

- **Module**: `AppShell.tsx` → `renderContent()`
- **Input**: `page = 'settings-modules'`
- **Expected Output**: Rendered `<ModuleSettingsPage />` (verify by test-id or component presence)

### UT-6: renderContent Returns ModuleDependenciesPage for module-dependencies

- **Module**: `AppShell.tsx` → `renderContent()`
- **Input**: `page = 'module-dependencies'`
- **Expected Output**: Rendered `<ModuleDependenciesPage />` (verify by test-id or component presence)

### UT-7: ProjectSidebar Includes Modules in Settings Group

- **Module**: `ProjectSidebar.tsx`
- **Input**: Render sidebar with a project loaded
- **Expected Output**: Settings group contains an item with label "Modules" targeting `'settings-modules'`

### UT-8: ProjectSidebar Includes Dependencies in Resources Section

- **Module**: `ProjectSidebar.tsx`
- **Input**: Render sidebar with a project loaded
- **Expected Output**: Resources section contains an item with label "Dependencies" targeting `'module-dependencies'`

### UT-9: Sidebar Items Visible Regardless of Project Kind

- **Module**: `ProjectSidebar.tsx`
- **Input**: Render sidebar with `Project.kind = 'application'` (not a module)
- **Expected Output**: Both "Modules" and "Dependencies" items still appear

### UT-10: Sidebar Items Visible Regardless of Feature Flag

- **Module**: `ProjectSidebar.tsx`
- **Input**: Render sidebar with `hasModules = false` feature flag
- **Expected Output**: Both "Modules" and "Dependencies" items still appear (no conditional hiding)

### UT-11: Publish Button Click Opens PublishModuleDialog

- **Module**: `ModuleSettingsPage.tsx`
- **Input**: Render page, click "Publish Release" button
- **Expected Output**: `PublishModuleDialog` becomes visible (store `publishDialogOpen` is set to `true` via `setPublishDialogOpen(true)`)

### UT-12: Import Button Click Opens ImportModuleDialog

- **Module**: `ModuleDependenciesPage.tsx`
- **Input**: Render page, click "Import Module" button
- **Expected Output**: `ImportModuleDialog` becomes visible (store `importDialogOpen` is set to `true` via `setImportDialogOpen(true)`)

---

## 5. Security & Isolation Tests

| #   | Scenario                                                                                                    | Type        | Status                     |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------- | -------------------------- |
| S1  | `loadDependencies` uses the active `projectId` and refreshes state on project change                        | integration | PASS                       |
| S2  | Feature flag disabled → module settings page shows disabled toggle, no action buttons enabled               | integration | PARTIAL (indirect smoke)   |
| S3  | Sidebar items do not expose module-specific data (names, counts) to the navigation UI itself                | unit        | PARTIAL                    |
| S4  | `parseUrl` with unknown page values falls through to default (no crash, no arbitrary code exec)             | unit        | PASS                       |
| S5  | Cross-project isolation: switching projects replaces dependencies — project A data not visible in project B | e2e         | PARTIAL (integration only) |

### S5 (E2E): Cross-Project Dependency Isolation on Project Switch

- **Covers**: FR-6 (isolation aspect)
- **Preconditions**: Studio running. Authenticated. Two projects: Project A has imported module dependency `alpha`, Project B has no dependencies.
- **Steps**:
  1. Navigate to Project A
  2. Click "Dependencies" in the Resources sidebar
  3. Verify the `alpha` dependency appears in the list
  4. Navigate to Project B (via project switcher or direct URL)
  5. Click "Dependencies" in the Resources sidebar
  6. Verify the dependency list is empty — `alpha` does NOT appear
  7. Navigate back to Project A
  8. Verify `alpha` reappears in the dependency list
- **Expected Result**: `loadDependencies(projectId)` in the project-level `useEffect` correctly scopes store data to the active project. No stale data leaks across project boundaries.
- **Auth Context**: Authenticated user (`dev@kore.ai`) with project access to both projects (tenant: default tenant, user: dev user)
- **Isolation Check**: This IS the isolation test — verifies client-side store isolation on project switch

---

## 6. Performance & Load Tests

| Scenario                                                  | Target         | How Measured                   |
| --------------------------------------------------------- | -------------- | ------------------------------ |
| `loadDependencies` latency on project load (max 5 deps)   | < 500ms (P95)  | Playwright `performance.now()` |
| No additional render cycles from eager dependency loading | +0 unnecessary | React DevTools profiler        |

Performance tests are deferred to manual validation in ALPHA stage. The API call is lightweight (max 5 items) and should not introduce perceptible latency.

---

## 7. Test Infrastructure

### Required Services (E2E)

- **Studio**: Running on `localhost:5173` via PM2 or `pnpm dev`
- **Runtime**: Running on `localhost:3112` (needed for module API routes that proxy to runtime)
- **MongoDB**: Running (Studio API routes hit the database)

### Data Seeding (E2E)

E2E tests seed data via API calls in `beforeAll`:

1. `devLogin(page)` — authenticate and get Bearer token
2. `POST /api/projects/:id/module` — enable module mode on provider project
3. `POST /api/projects/:id/module/releases` — publish release
4. `POST /api/projects/:id/module-dependencies` — import into consumer project

Cleanup in `afterAll`:

1. `DELETE /api/projects/:id/module-dependencies/:depId` — remove dependency

### Test Runner Configuration

| File Pattern    | Config                   | Environment | Runner     |
| --------------- | ------------------------ | ----------- | ---------- |
| `*.test.tsx`    | `vitest.unit.config.ts`  | happy-dom   | Vitest     |
| `*.test.ts`     | `vitest.light.config.ts` | node        | Vitest     |
| `e2e/*.spec.ts` | `playwright.config.ts`   | Chromium    | Playwright |

### Global Test Setup

`apps/studio/src/__tests__/setup.tsx` provides automatic mocks for:

- `framer-motion` → plain `<div>` elements
- `next-intl` → real English translations loaded
- `lucide-react` → icons with `data-testid` attributes
- `localStorage` / `fetch` → basic mocks

### Mock Boundaries

| Test Type   | What's Real                                  | What's Mocked                                                                                                                                                                                                     |
| ----------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Component render output                      | Stores, API functions, hooks, sub-components                                                                                                                                                                      |
| Integration | Zustand store, `useImportedSymbols` hook     | HTTP API layer (`api/modules.ts`)                                                                                                                                                                                 |
| E2E         | Everything — full Studio + Runtime + MongoDB | Only `page.route()` for feature flag override in E2E-7 (established project convention — no admin API exists to toggle flags on a running server; see `reusable-agent-modules-smoke.spec.ts` MOD-4 for precedent) |

---

## 8. Test File Mapping

| Test File                                                      | Type        | Covers                 | Scenarios                                                                                     |
| -------------------------------------------------------------- | ----------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/stores/navigation-store.test.ts`    | unit        | FR-1, S4               | URL parsing/building for `settings-modules` and `module-dependencies`, unknown-route fallback |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`      | unit        | FR-4, FR-5             | Sidebar entries and navigation-config reachability                                            |
| `apps/studio/src/__tests__/module-dependency-loading.test.tsx` | integration | FR-3, FR-6, S1, S5     | Dependency hydration, graceful load failure, project-switch refresh                           |
| `apps/studio/src/__tests__/module-settings-page.test.tsx`      | unit        | FR-2, FR-7, FR-8       | Settings page composition, publish trigger, release/archive affordances                       |
| `apps/studio/src/__tests__/module-dependencies-page.test.tsx`  | unit        | FR-3                   | Dependencies page composition and import trigger                                              |
| `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`         | e2e         | FR-2, FR-3, FR-7, FR-9 | Indirect browser coverage for publish/import shell reachability and feature-disabled behavior |

---

## 9. Open Testing Questions

| #   | Question                                                                                             | Status                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should INT-4 (race condition) block implementation or serve as a regression marker for a future fix? | DECIDED: Regression marker. Document current behavior (last-write-wins). If implementation adds abort controller, update the expected result. |
| 2   | Should UT-1 to UT-4 go in the existing `navigation-store.test.ts` or the new wiring test file?       | DECIDED: New wiring test file for cohesion. The existing file can be updated separately.                                                      |
| 3   | Should E2E tests share helpers with `reusable-agent-modules-smoke.spec.ts` or duplicate them?        | DECIDED: Extract shared helpers to a utility file (`e2e/helpers/module-helpers.ts`). Both specs import from there.                            |

---

## 10. Existing Coverage (Do Not Duplicate)

These tests already cover individual component behavior and should NOT be duplicated:

| File                                                                      | Tests | What It Covers                                                    |
| ------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| `apps/studio/src/__tests__/project-dashboard-modules.test.tsx`            | 12    | ModuleSettingsPanel internal behavior, store selectors            |
| `apps/studio/src/__tests__/tool-picker-imported-tools.test.tsx`           | 5     | Imported tool badges, search, insert (mocks useImportedSymbols)   |
| `apps/studio/src/__tests__/coordination-section-imported-agents.test.tsx` | 6     | Imported agent provenance, lock, count (mocks useImportedSymbols) |
| `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`                    | 4     | Publish, import, update badge, feature gate (Playwright)          |

The new tests focus on the **wiring layer**: navigation routing, page composition, dependency loading lifecycle, and end-to-end navigation flows.
