# Test Specification: Localization Asset Management

**Feature Spec**: [docs/features/sub-features/localization-asset-management.md](../../features/sub-features/localization-asset-management.md)
**HLD**: [docs/specs/localization-asset-management.hld.md](../../specs/localization-asset-management.hld.md)
**LLD**: [docs/plans/localization-asset-management.lld.md](../../plans/localization-asset-management.lld.md)
**Status**: IMPLEMENTED
**Last Updated**: 2026-04-17

---

## 1. Coverage Matrix

| FR    | Description                                     | Unit    | Integration | E2E | Manual | Status      |
| ----- | ----------------------------------------------- | ------- | ----------- | --- | ------ | ----------- |
| FR-1  | Dedicated Studio localization page              | PARTIAL | NO          | YES | YES    | IMPLEMENTED |
| FR-2  | Full-width design-system editing experience     | PARTIAL | NO          | YES | YES    | IMPLEMENTED |
| FR-3  | Project-scoped CRUD routes                      | NO      | YES         | YES | YES    | IMPLEMENTED |
| FR-4  | Reserved config-variable storage model          | YES     | NO          | NO  | NO     | IMPLEMENTED |
| FR-5  | Canonical locale path validation/normalization  | YES     | NO          | NO  | NO     | IMPLEMENTED |
| FR-6  | Export/Git locale file materialization          | YES     | PARTIAL     | NO  | NO     | IMPLEMENTED |
| FR-7  | Git status/history/push surface locale assets   | PARTIAL | NO          | NO  | YES    | PARTIAL     |
| FR-8  | JSON upload/prettify/object enforcement         | NO      | YES         | YES | YES    | IMPLEMENTED |
| FR-9  | Tenant/project scoped route behavior            | NO      | YES         | NO  | YES    | IMPLEMENTED |
| FR-10 | Scope boundary documented for runtime follow-on | YES     | NO          | NO  | NO     | IMPLEMENTED |

`PARTIAL` in this matrix means automated coverage exists but does not yet cover the full scenario family. It does not mean the route or browser lock is missing.

### Current Automated Baseline

The implemented slice now has automated coverage across route behavior, import/apply wiring, and the authored browser flow:

- `packages/project-io/src/__tests__/core-assembler.test.ts`
- `packages/project-io/src/__tests__/project-exporter.test.ts`
- `packages/project-io/src/__tests__/git-sync-service.test.ts`
- `apps/studio/src/__tests__/stores/navigation-store.test.ts`
- `apps/studio/src/__tests__/module-studio-wiring.test.tsx`
- `apps/studio/src/__tests__/api-routes/localization-routes.test.ts`
- `apps/studio/src/__tests__/project-import-core-direct-apply-support.test.ts`
- `apps/studio/e2e/localization-assets.spec.ts`

These tests prove the canonical locale-file contract, export serialization, Git sync payload inclusion, Studio navigation wiring, dedicated localization CRUD route behavior, and import/apply locale persistence. The browser E2E spec covers create/edit/upload/delete through the real Studio UI, but it still depends on a local environment where `dev-login` is enabled and healthy. The remaining risk in this slice is environment readiness, not missing automated CRUD/browser coverage.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests should exercise the real Studio/browser flow or public Studio HTTP surface. No direct DB writes or mocks of codebase components.

### E2E-1: Create a localization asset from Studio UI

- **Preconditions**: Studio app running, authenticated project member, empty or existing project.
- **Steps**:
  1. Navigate to `Settings > Localization`.
  2. Click `New Asset`.
  3. Enter a canonical path such as `en/_shared.json`.
  4. Enter JSON object content and save.
  5. Refresh the page.
- **Expected Result**: The asset appears in the table after save and persists after refresh.

### E2E-2: Edit a locale asset in the full-width editor

- **Preconditions**: Existing locale asset in project storage.
- **Steps**:
  1. Open the asset from the localization table.
  2. Verify the editor opens in a full-width panel.
  3. Change JSON content and save.
  4. Reopen the same asset.
- **Expected Result**: The editor remains wide/full-screen and the saved JSON content is preserved.

### E2E-3: Upload JSON file into an existing asset draft

- **Preconditions**: Localization page open with editor active.
- **Steps**:
  1. Open create or edit mode.
  2. Upload a valid JSON file.
  3. Save the asset.
- **Expected Result**: Uploaded JSON replaces editor content, is validated as an object, and saves successfully.

### E2E-4: Git-connected project publishes locale assets

- **Preconditions**: Project has Git integration configured and at least one locale asset.
- **Steps**:
  1. Open `Settings > Localization`.
  2. Click `Push to Git`.
  3. Open `Settings > Git`.
- **Expected Result**: Push succeeds and Git history/local-state surfaces locale asset changes.

### E2E-5: Git-disconnected project routes builders to Git settings

- **Preconditions**: Project has no Git integration.
- **Steps**:
  1. Open `Settings > Localization`.
  2. Click `Open Git Settings`.
- **Expected Result**: Navigation moves to the Git settings page.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Localization API routes enforce project/tenant scoping

- **Boundary**: `/api/projects/:id/localization` and `/api/projects/:id/localization/:assetId`
- **Setup**: Two projects or tenants with different locale assets.
- **Steps**: Attempt cross-project and cross-tenant reads/updates/deletes.
- **Expected Result**: Cross-scope access returns 404 and never leaks the asset.

### INT-2: Duplicate locale path creation/update returns conflict

- **Boundary**: Localization API create/update routes
- **Setup**: Existing locale asset with the same canonical path.
- **Steps**: Create or rename another asset to the same path.
- **Expected Result**: API returns 409 conflict with no duplicate record written.

### INT-3: Git push route includes locale assets in exported project data

- **Boundary**: Studio Git push route -> project-io Git sync
- **Setup**: Project with agents plus locale assets.
- **Steps**: Invoke `/git/push` and inspect the pushed file map through the sync service test harness.
- **Expected Result**: `locales/<locale>/<asset>.json` files are included in the push payload.

### INT-4: Git status route exposes locale asset local state

- **Boundary**: Studio Git status route
- **Setup**: Project with multiple locale assets.
- **Steps**: Call `/git/status`.
- **Expected Result**: `localLocaleFiles` includes `relativePath`, `filePath`, `localeCode`, `scope`, and `updatedAt`.

### INT-5: Pull diff computation receives locale file state

- **Boundary**: Studio Git pull route -> project-io import preview
- **Setup**: Existing locale assets locally and locale files remotely.
- **Steps**: Call `/git/pull` or dry-run path with locale differences present.
- **Expected Result**: import preview computes locale add/modify/remove diffs using existing locale state.

---

## 4. Unit Test Scenarios

### UT-1: Locale asset key/path conversion

- **Module**: `packages/project-io/src/locale-files.ts`
- **Input**: valid and invalid relative paths, file paths, and reserved keys
- **Expected Output**: canonical conversion helpers normalize valid paths and reject invalid ones

### UT-2: Core assembler exports locale assets as files

- **Module**: `core-assembler.ts`
- **Input**: standard config variables plus reserved locale keys
- **Expected Output**: locale entries become `locales/...json` files and are omitted from `environment/config-vars.json`

### UT-3: Legacy exporter includes locale files in build file map

- **Module**: `project-exporter.ts`
- **Input**: `ProjectData.locales`
- **Expected Output**: build file map includes locale files at canonical paths

### UT-4: Git sync push serializes locale files

- **Module**: `git-sync-service.ts`
- **Input**: project data containing locale assets
- **Expected Output**: pushed file set contains locale files and change summaries reflect them

### UT-5: Navigation wiring exposes localization settings route

- **Module**: `navigation-store.ts`, `ProjectSidebar`, navigation config
- **Input**: `settings-localization` route and sidebar selection
- **Expected Output**: route parsing, breadcrumb generation, and sidebar navigation all resolve correctly

---

## 5. Security & Isolation Tests

- Cross-tenant locale asset access returns 404, not 403.
- Cross-project locale asset access returns 404.
- Invalid paths such as `../foo.json`, leading slashes, null bytes, or malformed shapes are rejected.
- Invalid JSON that is not an object is rejected at the boundary or in the editor workflow.
- Git status/push routes continue to use existing project-scoped permissions.

---

## 6. Performance & Load Tests (if applicable)

- Validate that listing locale assets remains lightweight for normal project sizes.
- Validate that full-width editor load stays responsive for moderately sized locale JSON files.
- Validate that Git push remains bounded when locale assets are added alongside normal project content.

---

## 7. Test Infrastructure

- **Required services**: Studio app, MongoDB, optional Git provider test harness for sync tests
- **Data seeding**: project, authenticated user, optional Git integration, locale assets in reserved config-variable storage
- **Environment variables**: standard Studio test environment; Git tests require existing provider test configuration where applicable

---

## 8. Test File Mapping

| Test File                                                                    | Type        | Covers                 |
| ---------------------------------------------------------------------------- | ----------- | ---------------------- |
| `packages/project-io/src/__tests__/core-assembler.test.ts`                   | unit        | FR-4, FR-5, FR-6       |
| `packages/project-io/src/__tests__/project-exporter.test.ts`                 | unit        | FR-6                   |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`                 | unit        | FR-6, FR-7             |
| `apps/studio/src/__tests__/stores/navigation-store.test.ts`                  | unit        | FR-1, FR-2             |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`                    | component   | FR-1, FR-2             |
| `apps/studio/src/__tests__/api-routes/localization-routes.test.ts`           | integration | FR-3, FR-8, FR-9       |
| `apps/studio/src/__tests__/project-import-core-direct-apply-support.test.ts` | integration | FR-3, FR-9             |
| `apps/studio/e2e/localization-assets.spec.ts`                                | e2e         | FR-1, FR-2, FR-3, FR-8 |

---

## 9. Open Testing Questions

1. Should Git pull locale coverage expand from project-io/import-state assertions into a full Studio route-level regression?
2. Do we want placeholder/token validation in this slice, and if so, should it be tested at the editor layer or API layer?
3. Should the browser lane bootstrap or health-check `dev-login` prerequisites up front so local environment drift fails fast instead of surfacing as a late E2E error?
