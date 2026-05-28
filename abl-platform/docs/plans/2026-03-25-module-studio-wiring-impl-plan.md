# LLD: Module Studio Wiring

**Feature Spec**: `docs/features/sub-features/module-studio-wiring.md`
**HLD**: `docs/specs/module-studio-wiring.hld.md`
**Test Spec**: `docs/testing/sub-features/module-studio-wiring.md`
**Status**: DONE
**Date**: 2026-04-15

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                 | Rationale                                                                                                                                                     | Alternatives Rejected                                                    |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D-1 | Navigation-first implementation order                                    | `ProjectPage` union is the foundational type — all other changes depend on it compiling                                                                       | UI-first (would break type checking), lifecycle-first (no page to mount) |
| D-2 | Page wrappers in `components/modules/`                                   | Colocation pattern (AuthProfilesPage, GuardrailsConfigPage, DeploymentsPage all live with domain)                                                             | Separate `pages/` directory (no precedent in Studio)                     |
| D-3 | `Package` icon (lucide-react) for both sidebar entries                   | Already used in all 7 module components — visual consistency                                                                                                  | `Blocks`, `BoxIcon` (no existing precedent)                              |
| D-4 | Bundle i18n keys with sidebar phase                                      | Sidebar renders translation keys — missing keys show raw strings; attachments commit bundled same way                                                         | Separate i18n phase (unnecessary overhead for 2 keys)                    |
| D-5 | Single testing phase at the end                                          | S-sized feature ships atomically; E2E tests require all phases complete                                                                                       | Tests per phase (overhead without benefit for atomic delivery)           |
| D-6 | Do not fix pre-existing `config/navigation.ts` divergence                | Orthogonal scope; easy standalone PR; minimal scope principle                                                                                                 | Fix divergence in-band (risk creep, unrelated changes)                   |
| D-7 | No abort controller for `loadDependencies` effect                        | Zero precedent in AppShell effects; race condition risk is negligible (max 5 items, fast API)                                                                 | AbortController (would be the only effect using it)                      |
| D-8 | `settings-modules` placed after `settings-omnichannel` in settings items | Placed in the unlabeled zone between Security & Observability and Advanced sections in ProjectSidebar; appended as last settings item in config/navigation.ts | Before omnichannel, in Integrations section                              |

### Key Interfaces & Types

```typescript
// navigation-store.ts — ProjectPage union extension
export type ProjectPage =
  | /* ... existing 35 variants ... */
  | 'settings-modules' // NEW
  | 'module-dependencies'; // NEW

// ModuleSettingsPage.tsx — thin page wrapper (NEW FILE)
export function ModuleSettingsPage(): JSX.Element;

// ModuleDependenciesPage.tsx — thin page wrapper (NEW FILE)
export function ModuleDependenciesPage(): JSX.Element;
```

### Module Boundaries

| Module                   | Responsibility                                            | Depends On                                                   |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| `navigation-store.ts`    | ProjectPage union, URL parsing, path building             | —                                                            |
| `AppShell.tsx`           | Content rendering switch, loadDependencies lifecycle      | `navigation-store`, `module-store`, page wrappers            |
| `ProjectSidebar.tsx`     | Sidebar nav entries (local definitions)                   | `navigation-store` (ProjectPage type)                        |
| `config/navigation.ts`   | Exported nav definitions for UniversalSearch              | `navigation-store` (ProjectPage type)                        |
| `ModuleSettingsPage`     | Composes ModuleSettingsPanel + publish trigger + releases | `module-store`, `ModuleSettingsPanel`, `PublishModuleDialog` |
| `ModuleDependenciesPage` | Composes ModuleDependencyList + import trigger            | `module-store`, `ModuleDependencyList`, `ImportModuleDialog` |
| `i18n/studio.json`       | Translation keys for sidebar labels                       | —                                                            |

---

## 2. File-Level Change Map

### New Files

| File                                                            | Purpose                                                            | LOC Estimate |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ |
| `apps/studio/src/components/modules/ModuleSettingsPage.tsx`     | Page wrapper: ModuleSettingsPanel + publish button + releases list | ~45          |
| `apps/studio/src/components/modules/ModuleDependenciesPage.tsx` | Page wrapper: ModuleDependencyList + import button                 | ~35          |

### Modified Files

| File                                                       | Change Description                                                                                           | Risk |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| `apps/studio/src/store/navigation-store.ts`                | Add `'settings-modules'` and `'module-dependencies'` to ProjectPage union, settingsSubPages, settingsPageMap | Low  |
| `apps/studio/src/components/navigation/AppShell.tsx`       | Add 2 imports, 2 switch cases in renderContent, 1 useEffect for loadDependencies                             | Low  |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx` | Add `Package` import, 1 entry to resourceNavDefs, 1 entry to settings pages/items arrays                     | Low  |
| `apps/studio/src/config/navigation.ts`                     | Add `Package` import, 1 entry to resourceNavDefs, 1 entry to settings pages/items arrays                     | Low  |
| `packages/i18n/locales/en/studio.json`                     | Add 2 keys to `nav` namespace: `"modules"`, `"dependencies"`                                                 | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Navigation Store Extension

**Goal**: Make `settings-modules` and `module-dependencies` valid navigation targets with correct URL parsing and path building.

**Tasks**:

1.1. Add `'settings-modules'` and `'module-dependencies'` to the `ProjectPage` union type in `navigation-store.ts` (after `'settings-omnichannel'`, before `'transfer-sessions'`)

1.2. Add `modules: 'settings-modules'` entry to the `settingsSubPages` map in `parseUrl()` (after `omnichannel: 'settings-omnichannel'` at L188)

1.3. Add `'settings-modules': 'modules'` entry to the `settingsPageMap` in `buildPath()` (after `'settings-omnichannel': 'omnichannel'` at L350)

1.4. Verify `module-dependencies` requires NO entries in `settingsSubPages`/`settingsPageMap` — it's a top-level page parsed by the generic handler at L230-237 (`page = parts[2]`)

**Files Touched**:

- `apps/studio/src/store/navigation-store.ts` — 3 additions (union variant, parseUrl map entry, buildPath map entry)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] `parseUrl('/projects/abc/settings/modules')` returns `{ page: 'settings-modules' }`
- [ ] `parseUrl('/projects/abc/module-dependencies')` returns `{ page: 'module-dependencies' }`
- [ ] `buildPath({ area: 'project', projectId: 'abc', page: 'settings-modules' })` returns `/projects/abc/settings/modules`
- [ ] `buildPath({ area: 'project', projectId: 'abc', page: 'module-dependencies' })` returns `/projects/abc/module-dependencies`

**Test Strategy**:

- Unit: URL parsing and path building verified by test scenarios UT-1 through UT-4 in test spec
- Integration: N/A for this phase

**Rollback**: `git revert` the commit — removes 2 union variants and 2 map entries. No data changes.

---

### Phase 2: Page Wrapper Components

**Goal**: Create the two thin page-level components that compose existing module components into page layouts.

**Tasks**:

2.1. Create `apps/studio/src/components/modules/ModuleSettingsPage.tsx`:

- Import `ModuleSettingsPanel` from `./ModuleSettingsPanel` (takes no props)
- Import `PublishModuleDialog` from `./PublishModuleDialog` (takes `{ projectId: string }`)
- Import `useModuleStore` from `../../store/module-store`
- Import `useNavigationStore` from `../../store/navigation-store`
- Import `ArchiveReleaseButton` from `./ArchiveReleaseButton` (takes `{ projectId, releaseId, version, disabled?, onArchived? }`)
- Destructure `projectId` from `useNavigationStore()` (same pattern as ModuleSettingsPanel.tsx L39)
- Render `<ModuleSettingsPanel />` as main content
- Add a "Publish Release" button that calls `setPublishDialogOpen(true)` on module store
- Render `<PublishModuleDialog projectId={projectId!} />` — NOTE: PublishModuleDialog reads `publishDialogOpen` from the store internally (self-managing open/close)
- Read `releases` from `useModuleStore`. Map over releases rendering `<ArchiveReleaseButton projectId={projectId!} releaseId={release._id} version={release.version} onArchived={() => loadReleases(projectId!)} />` for each
- **BEFORE implementing**: Read `ModuleSettingsPanel.tsx`, `PublishModuleDialog.tsx`, `ArchiveReleaseButton.tsx`, and `module-store.ts` to verify exact prop signatures and store shape

  2.2. Create `apps/studio/src/components/modules/ModuleDependenciesPage.tsx`:

- Import `ModuleDependencyList` from `./ModuleDependencyList` (takes `{ projectId: string, className?: string }`)
- Import `ImportModuleDialog` from `./ImportModuleDialog` (takes `{ open: boolean, onClose: () => void, projectId: string, onImported?: () => void }`)
- Import `useModuleStore` from `../../store/module-store`
- Import `useNavigationStore` from `../../store/navigation-store`
- Destructure `projectId` from `useNavigationStore()`
- Render `<ModuleDependencyList projectId={projectId!} />` as main content
- Add an "Import Module" button that calls `setImportDialogOpen(true)` on module store
- Render `<ImportModuleDialog open={importDialogOpen} onClose={() => setImportDialogOpen(false)} projectId={projectId!} onImported={() => loadDependencies(projectId!)} />` — NOTE: Unlike PublishModuleDialog (which reads open state from the store internally), ImportModuleDialog takes explicit `open`/`onClose` props
- **BEFORE implementing**: Read `ModuleDependencyList.tsx`, `ImportModuleDialog.tsx`, and `module-store.ts` to verify exact prop signatures and store shape

  2.3. Verify both components compile: `pnpm build --filter=studio`

**Files Touched**:

- `apps/studio/src/components/modules/ModuleSettingsPage.tsx` — NEW (~45 LOC)
- `apps/studio/src/components/modules/ModuleDependenciesPage.tsx` — NEW (~35 LOC)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] `ModuleSettingsPage` renders `ModuleSettingsPanel` and a publish trigger button
- [ ] `ModuleDependenciesPage` renders `ModuleDependencyList` and an import trigger button
- [ ] Clicking publish button calls `setPublishDialogOpen(true)` — store's `publishDialogOpen` becomes `true`
- [ ] Clicking import button calls `setImportDialogOpen(true)` — store's `importDialogOpen` becomes `true`
- [ ] Both page wrappers use only verified prop signatures (no guessed props)

**Test Strategy**:

- Unit: Composition and button-click behavior verified by test scenarios UT-11, UT-12 in test spec
- Integration: Page composition with real store verified by INT-5, INT-6

**Rollback**: Delete the 2 new files. No other files modified.

---

### Phase 3: App Shell Wiring (Rendering + Lifecycle)

**Goal**: Mount page wrappers in the AppShell content switch and add the project-level `loadDependencies` effect.

**Tasks**:

3.1. Add imports to `AppShell.tsx` (after the guardrails import block, ~L133):

```typescript
// Module pages
import { ModuleSettingsPage } from '../modules/ModuleSettingsPage';
import { ModuleDependenciesPage } from '../modules/ModuleDependenciesPage';
```

3.2. Add `useModuleStore` import to `AppShell.tsx`:

```typescript
import { useModuleStore } from '../../store/module-store';
```

Then destructure `loadDependencies` at the component level (following the established selector pattern used by all other AppShell effects):

```typescript
const loadDependencies = useModuleStore((s) => s.loadDependencies);
```

3.3. Add `loadDependencies` effect after the existing `loadFromServer` effect (~L224):

```typescript
// Load module dependencies so useImportedSymbols works across authoring surfaces
useEffect(() => {
  if (projectId) {
    loadDependencies(projectId);
  }
}, [projectId, loadDependencies]);
```

3.4. Add `case 'module-dependencies':` to `renderContent()` switch — in the resource pages section (after `case 'connections':` at L485):

```typescript
case 'module-dependencies':
  return <ModuleDependenciesPage />;
```

3.5. Add `case 'settings-modules':` to `renderContent()` switch — in the settings pages section (after `case 'settings-omnichannel':` at L564):

```typescript
case 'settings-modules':
  return <ModuleSettingsPage />;
```

**Files Touched**:

- `apps/studio/src/components/navigation/AppShell.tsx` — 3 imports, 1 useEffect, 2 switch cases

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] Navigating to `settings-modules` page renders `ModuleSettingsPage`
- [ ] Navigating to `module-dependencies` page renders `ModuleDependenciesPage`
- [ ] On project load, `loadDependencies(projectId)` is called
- [ ] `useModuleStore.getState().dependencies` is populated after project load (for projects with dependencies)
- [ ] `useImportedSymbols` returns non-empty arrays after project load (for projects with dependencies)

**Test Strategy**:

- Integration: loadDependencies lifecycle verified by test scenarios INT-1, INT-2, INT-3 in test spec
- Unit: renderContent routing verified by test scenarios UT-5, UT-6

**Rollback**: Remove the 3 imports, 1 useEffect, and 2 switch cases from AppShell.tsx. The page wrappers remain but are unreachable.

---

### Phase 4: Sidebar Navigation + i18n

**Goal**: Make both pages discoverable through sidebar navigation and universal search.

**Tasks**:

4.1. Add `Package` to the lucide-react import in `ProjectSidebar.tsx` (L9-51):

```typescript
Package,
```

4.2. Add `module-dependencies` to `resourceNavDefs` array in `ProjectSidebar.tsx` (after `connections` at L98):

```typescript
{ id: 'module-dependencies', Icon: Package, key: 'dependencies' },
```

4.3. Add `settings-modules` to the settings group `pages` array in `ProjectSidebar.tsx` (after `'settings-omnichannel'` at L176):

```typescript
'settings-modules',
```

4.4. Add `settings-modules` item to the settings group `items` array in `ProjectSidebar.tsx` (after `omnichannel` entry at L201):

```typescript
{ id: 'settings-modules', Icon: Package, key: 'modules' },
```

4.5. Add `Package` to the lucide-react import in `config/navigation.ts` (L8-37):

```typescript
Package,
```

4.6. Add `module-dependencies` to `resourceNavDefs` in `config/navigation.ts` (after `connections` at L74):

```typescript
{ id: 'module-dependencies', Icon: Package, key: 'dependencies' },
```

4.7. Add `settings-modules` to the settings group `pages` array in `config/navigation.ts` (after `'settings-omnichannel'` at L154):

```typescript
'settings-modules',
```

4.8. Add `settings-modules` item to the settings group `items` array in `config/navigation.ts` (after `omnichannel` entry at L177 — this is the last item in the config/navigation.ts settings items array; `settings-attachments` and `settings-auth-profiles` are absent due to pre-existing divergence documented in Open Question #2):

```typescript
{ id: 'settings-modules', Icon: Package, key: 'modules', group: 'settings' },
```

4.9. Add 2 i18n keys to `packages/i18n/locales/en/studio.json` nav namespace (after `"omnichannel": "Omnichannel"` at L139):

```json
"modules": "Modules",
"dependencies": "Dependencies",
```

**Files Touched**:

- `apps/studio/src/components/navigation/ProjectSidebar.tsx` — `Package` import + 3 array entries
- `apps/studio/src/config/navigation.ts` — `Package` import + 3 array entries
- `packages/i18n/locales/en/studio.json` — 2 new keys in nav namespace

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] "Dependencies" appears in Resources sidebar section (below Connections)
- [ ] "Modules" appears in Settings sidebar group (after Omnichannel)
- [ ] Clicking "Dependencies" navigates to `/projects/:id/module-dependencies`
- [ ] Clicking "Modules" navigates to `/projects/:id/settings/modules`
- [ ] Both entries use the `Package` icon
- [ ] UniversalSearch finds "Modules" and "Dependencies" (via `getAllNavItems()`)
- [ ] Sidebar items are unconditionally visible (no feature flag gating at nav level)

**Test Strategy**:

- Unit: Sidebar entries verified by test scenarios UT-7, UT-8, UT-9, UT-10 in test spec
- Integration: UniversalSearch discovery via `getAllNavItems()` includes both entries

**Rollback**: Remove the icon imports, array entries, and i18n keys. Pages remain mountable via URL but are not discoverable in sidebar.

---

### Phase 5: Testing

**Goal**: Write unit, integration, and E2E tests covering all wiring scenarios from the test spec.

**Tasks**:

5.1. Create `apps/studio/src/__tests__/module-studio-wiring.test.tsx` (unit):

- Test scenarios UT-1 to UT-4 (parseUrl, buildPath), UT-7 to UT-10 (sidebar entries, project kind, feature flag), S3 (nav items contain only icon + key, no module data), S4 (unknown page fallthrough)
- Total: 10 scenarios per test spec Section 8 + S3
- Mock boundary: stores, API functions, hooks, sub-components (unit-level mocks)
- **BEFORE writing**: Read the test spec at `docs/testing/sub-features/module-studio-wiring.md` for exact scenario definitions

  5.2. Create `apps/studio/src/__tests__/module-dependency-loading.test.tsx` (integration):

- Test scenarios INT-1 (loadDependencies → store → useImportedSymbols), INT-2 (API failure → graceful degradation), INT-3 (project switch triggers new load), INT-4 (race condition regression marker), S1 (projectId in API URL)
- Total: 5 scenarios per test spec Section 8
- Mock boundary: only HTTP API layer (`api/modules.ts`). Real Zustand store and real `useImportedSymbols` hook.
- **BEFORE writing**: Read `module-store.ts` and `useImportedSymbols.ts` for exact store shape and hook return type

  5.3. Create `apps/studio/src/__tests__/module-settings-page.test.tsx` (unit + integration):

- Test scenarios UT-5 (renderContent → ModuleSettingsPage), UT-11 (publish button click), INT-5 (page composition with real store), INT-7 (feature flag disabled state), S2 (feature flag → disabled toggle)
- Total: 5 scenarios per test spec Section 8
- Split into `describe('Unit')` (mocks store + sub-components) and `describe('Integration')` (real store, mocked HTTP API only)
- **BEFORE writing**: Read `ModuleSettingsPage.tsx` (created in Phase 2) for exact component structure

  5.4. Create `apps/studio/src/__tests__/module-dependencies-page.test.tsx` (unit + integration):

- Test scenarios UT-6 (renderContent → ModuleDependenciesPage), UT-12 (import button click), INT-6 (page composition with real store)
- Total: 3 scenarios per test spec Section 8
- Split into `describe('Unit')` and `describe('Integration')` per same pattern as 5.3
- **BEFORE writing**: Read `ModuleDependenciesPage.tsx` (created in Phase 2) for exact component structure

  5.5. Run all tests: `pnpm test --filter=studio`

**Files Touched**:

- `apps/studio/src/__tests__/module-studio-wiring.test.tsx` — NEW (~120 LOC)
- `apps/studio/src/__tests__/module-dependency-loading.test.tsx` — NEW (~100 LOC)
- `apps/studio/src/__tests__/module-settings-page.test.tsx` — NEW (~60 LOC)
- `apps/studio/src/__tests__/module-dependencies-page.test.tsx` — NEW (~60 LOC)

**Exit Criteria**:

- [ ] All 4 test files compile with 0 type errors
- [ ] All unit tests pass: UT-1 to UT-12, S3, S4 (14 scenarios across 3 files: 10 in wiring, 2 in settings-page, 2 in dependencies-page)
- [ ] All integration tests pass: INT-1 to INT-7, S1, S2 (9 scenarios across 3 files)
- [ ] `pnpm test --filter=studio` passes with 0 failures (no regressions)
- [ ] `pnpm build --filter=studio` still succeeds

**Test Strategy**:

- Unit: UT-1 to UT-12, S3, S4 from test spec
- Integration: INT-1 to INT-7, S1, S2 from test spec
- Security: S1 (projectId scoping), S2 (feature flag disabled), S3 (no data in nav), S4 (unknown page fallthrough) — distributed across test files per Section 8 mapping
- E2E: E1-E7 and S5 are planned for `apps/studio/e2e/module-studio-wiring.spec.ts` but deferred to Playwright infrastructure availability

**Rollback**: Delete the 4 test files. No source changes affected.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] `settings-modules` added to `ProjectPage` union type (Phase 1)
- [x] `module-dependencies` added to `ProjectPage` union type (Phase 1)
- [x] `settings-modules` added to `settingsSubPages` map in `parseUrl()` (Phase 1)
- [x] `settings-modules` added to `settingsPageMap` in `buildPath()` (Phase 1)
- [x] `ModuleSettingsPage` imported and rendered in `AppShell.tsx` `renderContent()` (Phase 3)
- [x] `ModuleDependenciesPage` imported and rendered in `AppShell.tsx` `renderContent()` (Phase 3)
- [x] `loadDependencies` useEffect added to `AppShell.tsx` (Phase 3)
- [x] `settings-modules` added to `ProjectSidebar.tsx` settings pages + items (Phase 4)
- [x] `module-dependencies` added to `ProjectSidebar.tsx` resourceNavDefs (Phase 4)
- [x] `settings-modules` added to `config/navigation.ts` settings pages + items (Phase 4)
- [x] `module-dependencies` added to `config/navigation.ts` resourceNavDefs (Phase 4)
- [x] i18n keys `"modules"` and `"dependencies"` added to `nav` namespace (Phase 4)
- [x] **DUAL-SOURCE CAUTION**: Both `ProjectSidebar.tsx` (local definitions) AND `config/navigation.ts` (exported definitions for UniversalSearch) were updated for the new module entries. The broader divergence in `config/navigation.ts` remains pre-existing tech debt (see Open Question #2).

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This is a purely client-side feature with no data model changes.

### Feature Flags

No new feature flags. The existing `reusable_modules` flag is checked inside `ModuleSettingsPanel` at the component level. Navigation items are unconditionally visible per FR-9.

### Configuration Changes

No new environment variables or runtime configuration.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All implementation phases complete
- [x] `pnpm --filter @agent-platform/studio build` succeeds with 0 type errors
- [x] Targeted Studio verification passes: `navigation-store`, `module-studio-wiring`, `module-settings-page`, `module-dependencies-page`, `module-dependency-loading`, and `api-module-dependencies`
- [x] Navigating to `/projects/:id/settings/modules` renders `ModuleSettingsPage`
- [x] Navigating to `/projects/:id/module-dependencies` renders `ModuleDependenciesPage`
- [x] "Modules" appears in Settings sidebar group with `Package` icon
- [x] "Dependencies" appears in Resources sidebar section with `Package` icon
- [x] UniversalSearch finds both pages
- [x] `loadDependencies` fires on project load — `useImportedSymbols` returns populated data for projects with module dependencies
- [x] Feature-disabled behavior is covered indirectly by `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`
- [x] Sidebar entries visible regardless of `Project.kind` or feature flags (FR-9)
- [x] No regressions found in the targeted Studio/module verification suites

---

## 7. Open Questions

1. **Dedicated Playwright coverage**: A standalone `module-studio-wiring.spec.ts` suite is still deferred. The parent `reusable-agent-modules-smoke.spec.ts` now provides indirect browser coverage for publish/import reachability and feature-disabled behavior.
2. **Pre-existing `config/navigation.ts` divergence**: `settings-auth-profiles`, `settings-attachments` (settings group), and `pipelines` (insights group) are missing from `config/navigation.ts` but present in `ProjectSidebar.tsx`. This means UniversalSearch cannot find these 3 pages. This should be fixed in a separate PR (tracked as tech debt, not in scope for this feature).
3. **`loadDependencies` race condition on rapid project switch**: No abort controller (zero precedent in AppShell). INT-4 test serves as regression marker. If this becomes a real issue, add `AbortController` in a follow-up.
