# Feature: Module Studio Wiring

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Reusable Agent Modules](../reusable-agent-modules.md)
**Status**: BETA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `enterprise`
**Package(s)**: `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: [../../testing/sub-features/module-studio-wiring.md](../../testing/sub-features/module-studio-wiring.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Before the 2026-04-15 remediation, Reusable Agent Modules had 7 fully implemented UI components (`ModuleSettingsPanel`, `PublishModuleDialog`, `ImportModuleDialog`, `ModuleDependencyList`, `UpgradeModuleDialog`, `ReverseDepPanel`, `ArchiveReleaseButton`), a complete Zustand store (`module-store.ts`), a type-safe API client with 16 functions (`api/modules.ts`), and 11 backend API route files — but the shell wiring was incomplete. The components were not reachable through normal Studio navigation, and module dependency state was not being loaded at the project-shell level.

That missing shell wiring also broke `useImportedSymbols`, the hook that surfaces imported module agents and tools into the `ABLSymbolTree`, `ToolPickerDialog`, and `CoordinationSection` authoring surfaces. Because the app shell never loaded dependencies on project change, imported symbols failed to appear consistently in authoring even though the underlying plumbing existed.

### Goal Statement

Wire all 7 existing module UI components into the Studio app shell so that module authors and consumer developers can reach the full module lifecycle through standard navigation. Fix the dependency loading lifecycle so that `useImportedSymbols` populates correctly for all projects with module dependencies.

### Summary

This sub-feature adds 2 new navigation pages to the Studio client-side routing (`settings-modules` for module authors, `module-dependencies` for consumer developers), adds corresponding sidebar entries, adds a project-level `loadDependencies()` initialization effect, and wires trigger buttons for dialogs (Publish, Import). No new backend API or component logic is needed — the work is purely mounting existing components into the existing app shell patterns.

### Key Capabilities

- Module authors can access all module lifecycle actions (enable, publish, promote, view consumers, archive) from a "Modules" tab in Project Settings
- Consumer developers can manage module dependencies (import, view, upgrade, remove) from a "Dependencies" page in the Resources sidebar section
- Imported module agents and tools appear correctly in ABLSymbolTree, ToolPickerDialog, and CoordinationSection for all projects with module dependencies
- Feature gating is enforced at the component level — navigation items are always visible, components show "feature not available" when `reusable_modules` flag is disabled

---

## 2. Scope

### Goals

- Mount `ModuleSettingsPanel` as a settings sub-page (`settings-modules`) accessible from the Project Settings sidebar group
- Mount `ModuleDependencyList` + `ImportModuleDialog` trigger as a top-level page (`module-dependencies`) accessible from the Resources sidebar section
- Add project-level `loadDependencies()` initialization so `useImportedSymbols` works for all projects
- Wire `PublishModuleDialog` open trigger from the module settings page
- Add `ProjectPage` variants (`settings-modules`, `module-dependencies`) to the navigation store with URL parsing and path building
- Add sidebar entries to `ProjectSidebar.tsx` for both pages

### Non-Goals (Out of Scope)

- New backend API endpoints — all routes exist and are functional
- New UI component logic — all 7 components are fully implemented
- Standalone catalog browsing page — catalog remains embedded in `ImportModuleDialog`
- Standalone releases list page — releases are managed from the module settings context
- Standalone contract preview page — contract display is embedded in `PublishModuleDialog` and `UpgradeModuleDialog`
- Standalone promote dialog — promotion remains the optional field in `PublishModuleDialog` at publish time
- New module store actions or state — existing store is complete
- Feature flag changes — existing `reusable_modules` gate is sufficient

---

## 3. User Stories

| ID   | Persona            | Story                                                                                                                                                      | Acceptance Criteria                                                                                                                                      |
| ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US-1 | Module Author      | As a module author, I want to access module settings (enable, publish, promote, consumers, archive) from the project sidebar so that I can manage modules. | "Modules" appears in the Settings group of the sidebar; clicking it renders `ModuleSettingsPanel` with `PublishModuleDialog` and `ArchiveReleaseButton`. |
| US-2 | Consumer Developer | As a consumer developer, I want to see "Dependencies" in my project sidebar so that I can import, view, upgrade, and remove module dependencies.           | "Dependencies" appears in the Resources section; clicking it renders `ModuleDependencyList` with an "Import Module" button.                              |
| US-3 | Consumer Developer | As a consumer developer, I want imported module agents and tools to appear in the symbol tree, tool picker, and coordination section automatically.        | `loadDependencies()` runs on project load; `useImportedSymbols` returns non-empty arrays for projects with dependencies.                                 |
| US-4 | Any User           | As a user, I want module navigation items visible but gracefully disabled when the feature flag is off so that I know the capability exists.               | Sidebar items always render; `ModuleSettingsPanel` shows disabled state when `hasModules` is false.                                                      |

---

## 4. Functional Requirements

| ID   | Requirement                                                                                                                                                                | Testable Assertion                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1 | The system SHALL add `'settings-modules'` and `'module-dependencies'` to the `ProjectPage` union type in `navigation-store.ts` with correct URL parsing and path building. | Navigating to `/projects/:id/settings/modules` sets page to `settings-modules`; `buildPath` generates the correct URL.                                |
| FR-2 | The system SHALL render `ModuleSettingsPanel` when `page === 'settings-modules'` in `AppShell.tsx` `renderContent()`.                                                      | Navigating to settings-modules renders the module settings panel with enable toggle, release list, publish button, and consumer panel.                |
| FR-3 | The system SHALL render `ModuleDependencyList` with an "Import Module" button when `page === 'module-dependencies'` in `AppShell.tsx` `renderContent()`.                   | Navigating to module-dependencies renders the dependency list and an import trigger that opens `ImportModuleDialog`.                                  |
| FR-4 | The system SHALL add a "Modules" item to the Settings group in `ProjectSidebar.tsx` that navigates to `settings-modules`.                                                  | The sidebar Settings section shows a "Modules" entry; clicking it navigates to `settings-modules`.                                                    |
| FR-5 | The system SHALL add a "Dependencies" item to the Resources section in `ProjectSidebar.tsx` that navigates to `module-dependencies`.                                       | The sidebar Resources section shows a "Dependencies" entry; clicking it navigates to `module-dependencies`.                                           |
| FR-6 | The system SHALL eagerly load module dependencies when a project is navigated to, so that `useImportedSymbols` is populated before authoring surfaces render.              | After project load, `useModuleStore.getState().dependencies` is populated; `useImportedSymbols` returns non-empty arrays for projects with deps.      |
| FR-7 | The system SHALL render a "Publish Release" button within the `settings-modules` page that opens `PublishModuleDialog`.                                                    | Clicking "Publish Release" on the module settings page opens the publish dialog with version input, release notes, and environment promotion picker.  |
| FR-8 | The system SHALL render the releases list with `ArchiveReleaseButton` per release within the `settings-modules` page.                                                      | Module settings page shows a list of published releases; each release has an archive action button.                                                   |
| FR-9 | The system SHALL NOT conditionally hide module sidebar items based on `Project.kind` or feature flags; feature gating is enforced at the component level.                  | Both sidebar items appear for all projects regardless of kind or feature flag state; disabled state is shown inside the component when flag is false. |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Module settings and dependencies are project-scoped surfaces          |
| Agent lifecycle            | SECONDARY    | Imported agents appear in authoring surfaces via `useImportedSymbols` |
| Customer experience        | NONE         | No end-user-facing changes                                            |
| Integrations / channels    | NONE         | No channel changes                                                    |
| Observability / tracing    | NONE         | No tracing changes                                                    |
| Governance / controls      | SECONDARY    | Feature gating enforced at component level                            |
| Enterprise / compliance    | NONE         | No compliance changes                                                 |
| Admin / operator workflows | NONE         | No admin changes                                                      |

### Related Feature Integration Matrix

| Related Feature                                              | Relationship Type | Why It Matters                                                              | Key Touchpoints                                                    | Current State                                  |
| ------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| [Reusable Agent Modules](../reusable-agent-modules.md)       | extends           | This sub-feature wires the parent feature's UI components into the shell    | All 7 components, module-store, api/modules.ts, useImportedSymbols | Components built and reachable in production   |
| [Agent Development (Studio)](../agent-development-studio.md) | shares data with  | Imported symbols feed into ABLSymbolTree, ToolPickerDialog, CoordinationSec | `useImportedSymbols` hook                                          | Hook hydrated on project change via `AppShell` |
| [Deployments & Versioning](../deployments-versioning.md)     | depends on        | Consumer deployments resolve module dependencies at build time              | Deployment creation triggers module snapshot                       | Working — backend-only, no UI gap              |

---

## 6. Design Considerations

### Navigation Placement

- **"Modules"** in Settings group — alongside models, config-vars, git, advanced, etc.
- **"Dependencies"** in Resources section — alongside tools, search-ai, connections

### Component Composition

The `settings-modules` page composes existing components:

```
ModuleSettingsPage (new thin wrapper)
├── ModuleSettingsPanel (existing — enable/disable, visibility, consumers)
│   └── ReverseDepPanel (existing — embedded)
├── "Publish Release" button → opens PublishModuleDialog (existing)
└── Releases list with ArchiveReleaseButton per release (existing)
```

The `module-dependencies` page composes existing components:

```
ModuleDependenciesPage (new thin wrapper)
├── "Import Module" button → opens ImportModuleDialog (existing)
│   └── Embedded catalog browse + contract preview + import flow
└── ModuleDependencyList (existing — deps, update badges, remove)
    └── UpgradeModuleDialog (existing — triggered from update badge)
```

### Feature Gating Pattern

All module sidebar items are statically rendered (consistent with every other sidebar item in the codebase). Feature gating is enforced inside the component — `ModuleSettingsPanel` already checks `useFeatures().hasModules` and disables interactions when the flag is off.

---

## 7. Technical Considerations

### Client-Side Routing (Not Next.js App Router)

The Studio uses client-side routing via `navigation-store.ts`. All project pages render through `AppShell.tsx`'s `renderContent()` switch. New pages are added as:

1. `ProjectPage` union variant in `navigation-store.ts`
2. URL parsing in `parseUrl()` and path building in `buildPath()`
3. `case` branch in `AppShell.tsx` `renderContent()`
4. Sidebar item in `ProjectSidebar.tsx`

No Next.js file-system route pages are created.

### Dependency Loading Lifecycle

The critical fix is adding a `useEffect` in `AppShell.tsx` that calls `loadDependencies(projectId)` when `projectId` changes. This must run eagerly (not lazily) because:

- `useImportedSymbols` is consumed by `ABLSymbolTree`, `ToolPickerDialog`, and `CoordinationSection` which render immediately when editing agents
- Lazy loading would cause a visible flash of missing symbols
- The API call is lightweight — max 5 dependencies per FR-8 of the parent spec, empty array for non-consumer projects

Only `loadDependencies` needs eager loading. `loadReleases` and `loadCatalog` are triggered by their respective components when they mount.

---

## 8. How to Consume

### Studio UI

**Module Author Journey:**

1. Open project → sidebar Settings → "Modules"
2. Toggle module mode on, set visibility
3. Click "Publish Release" → `PublishModuleDialog` opens with version, notes, optional promotion
4. View consumer projects in the embedded `ReverseDepPanel`
5. Archive old releases via per-release `ArchiveReleaseButton`

**Consumer Developer Journey:**

1. Open project → sidebar Resources → "Dependencies"
2. Click "Import Module" → `ImportModuleDialog` opens with catalog browse, contract preview, alias input, config overrides
3. View imported dependencies with update-available badges
4. Click update badge → `UpgradeModuleDialog` with contract diff
5. Remove dependencies via inline remove action

**Automatic Symbol Loading:**

- On project load, `loadDependencies(projectId)` runs automatically
- `ABLSymbolTree` shows imported agents/tools with provenance badges
- `ToolPickerDialog` includes imported tools
- `CoordinationSection` includes imported agents for handoff/delegation

### API (Runtime)

N/A — no runtime changes.

### API (Studio)

N/A — all API routes already exist. This sub-feature only wires UI to existing endpoints.

### Admin Portal

N/A — no admin changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — no channel integration changes.

---

## 9. Data Model

No data model changes. All collections (`module_releases`, `project_module_dependencies`, `deployment_module_snapshots`, `module_environment_pointers`) are defined in the parent feature spec.

### Key Relationships

The only new relationship is the dependency loading lifecycle:

- `AppShell.tsx` (project-level init) → `module-store.loadDependencies()` → `GET /api/projects/:id/module-dependencies` → store `dependencies` array → `useImportedSymbols` hook → authoring surfaces

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                          | Purpose                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/studio/src/store/module-store.ts`       | Zustand store managing catalog, dependencies, releases, dialog state (existing) |
| `apps/studio/src/hooks/useImportedSymbols.ts` | Derives imported agent/tool symbols from dependencies (existing)                |
| `apps/studio/src/hooks/use-features.ts`       | Feature flag resolution hook returning `{ hasModules }` (existing)              |
| `apps/studio/src/api/modules.ts`              | Type-safe API client with 16 functions (existing)                               |

### Routes / Handlers

N/A — all 7 backend route files exist.

### UI Components

| File                                                            | Purpose                                                            | Status      |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| `apps/studio/src/components/modules/ModuleSettingsPanel.tsx`    | Module enable/disable, visibility, embedded consumers (existing)   | Wired       |
| `apps/studio/src/components/modules/PublishModuleDialog.tsx`    | Publish release dialog with contract preview (existing)            | Wired       |
| `apps/studio/src/components/modules/ImportModuleDialog.tsx`     | Catalog browse + import flow dialog (existing)                     | Wired       |
| `apps/studio/src/components/modules/ModuleDependencyList.tsx`   | Dependency list with update badges and remove (existing)           | Wired       |
| `apps/studio/src/components/modules/UpgradeModuleDialog.tsx`    | Contract diff preview for upgrades (existing)                      | Wired       |
| `apps/studio/src/components/modules/ReverseDepPanel.tsx`        | Consumer project list (existing, embedded in ModuleSettingsPanel)  | Wired       |
| `apps/studio/src/components/modules/ArchiveReleaseButton.tsx`   | Archive release with in-use guard (existing)                       | Wired       |
| `apps/studio/src/components/modules/ModuleSettingsPage.tsx`     | Thin wrapper composing settings panel + publish + releases         | Implemented |
| `apps/studio/src/components/modules/ModuleDependenciesPage.tsx` | Thin wrapper composing dependency list + import trigger            | Implemented |
| `apps/studio/src/store/navigation-store.ts`                     | `settings-modules` and `module-dependencies` page variants         | Implemented |
| `apps/studio/src/components/navigation/AppShell.tsx`            | RenderContent cases + project-level `loadDependencies()` hydration | Implemented |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`      | Sidebar entries for both pages                                     | Implemented |

### Tests

| File                                                           | Type        | Coverage Focus                                                |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `apps/studio/src/__tests__/module-studio-wiring.test.tsx`      | unit        | Navigation routing, renderContent cases, sidebar entries      |
| `apps/studio/src/__tests__/module-dependency-loading.test.tsx` | integration | Project-level init → store population → useImportedSymbols    |
| `apps/studio/src/__tests__/module-settings-page.test.tsx`      | unit        | ModuleSettingsPage composition, publish trigger, release list |
| `apps/studio/src/__tests__/module-dependencies-page.test.tsx`  | unit        | ModuleDependenciesPage composition, import trigger            |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

No new runtime configuration. The existing `reusable_modules` feature flag controls module UI behavior.

### DSL / Agent IR / Schema

N/A — no DSL or schema changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `loadDependencies(projectId)` scopes the API call to the current project. Each project gets its own dependency set in the store.                                                                                              |
| Tenant isolation  | Enforced by existing API routes — all module endpoints include `tenantId` in queries. No change needed.                                                                                                                       |
| User isolation    | N/A — this sub-feature creates no user-owned resources. All module data (releases, dependencies) is project-scoped, not user-scoped. User-level authorization is enforced by existing RBAC permissions on the backend routes. |

### Security & Compliance

- No new API surface — all security properties inherited from existing module routes
- Feature gating enforced at component level via `useFeatures().hasModules`
- No new data flows — wiring only

### Performance & Scalability

- `loadDependencies` on project load adds 1 lightweight HTTP GET (max 5 items) per project navigation
- For projects with no dependencies, the API returns an empty array quickly
- No additional API calls at init — `loadReleases` and `loadCatalog` are triggered only when their pages mount

### Reliability & Failure Modes

- If `loadDependencies` fails, `useImportedSymbols` returns empty arrays (current behavior) — authoring surfaces degrade gracefully
- Module store already has error handling for API failures
- No new failure modes introduced

### Observability

- No new trace events or metrics
- Existing module audit events continue to work (they're triggered by API calls, not UI actions)

### Data Lifecycle

N/A — no new data stored.

---

## 13. Delivery Plan / Work Breakdown

1. **Navigation Store Extension**
   1.1. Add `'settings-modules'` and `'module-dependencies'` to `ProjectPage` union type
   1.2. Add URL parsing in `parseUrl()` for both page variants
   1.3. Add path building in `buildPath()` for both page variants
   1.4. Add settings page map entry for `settings-modules`

2. **Page Wrapper Components**
   2.1. Create `ModuleSettingsPage.tsx` — thin wrapper composing `ModuleSettingsPanel` + "Publish Release" button + releases list with `ArchiveReleaseButton`
   2.2. Create `ModuleDependenciesPage.tsx` — thin wrapper composing `ModuleDependencyList` + "Import Module" button opening `ImportModuleDialog`

3. **App Shell Wiring**
   3.1. Add `case 'settings-modules'` to `renderContent()` → `<ModuleSettingsPage />`
   3.2. Add `case 'module-dependencies'` to `renderContent()` → `<ModuleDependenciesPage />`
   3.3. Add project-level `useEffect` calling `loadDependencies(projectId)` on project change

4. **Sidebar Navigation**
   4.1. Add "Dependencies" item to `resourceNavDefs` array (Resources section) → page `'module-dependencies'`
   4.2. Add "Modules" item to Settings group items array → page `'settings-modules'`

5. **Testing**
   5.1. Navigation routing unit tests: URL parse/build for `settings-modules` and `module-dependencies`, renderContent cases, sidebar entries (scenarios I3-I6, U1-U4 from test spec; file: `module-studio-wiring.test.tsx`)
   5.2. Dependency loading lifecycle integration tests: project load → store population → useImportedSymbols, failure degradation, project switch (scenarios I1, I2, I7; file: `module-dependency-loading.test.tsx`)
   5.3. Page wrapper unit tests: ModuleSettingsPage composition + publish trigger, ModuleDependenciesPage composition + import trigger (scenarios U5-U8; files: `module-settings-page.test.tsx`, `module-dependencies-page.test.tsx`)
   5.4. E2E Playwright tests: navigate to both pages via URL, verify renders, dependency loading end-to-end, feature flag disabled state (scenarios E1-E7; file: `apps/studio/e2e/module-studio-wiring.spec.ts`)

---

## 14. Success Metrics

| Metric                                | Baseline | Target                   | How Measured                                                        |
| ------------------------------------- | -------- | ------------------------ | ------------------------------------------------------------------- |
| Module components reachable from UI   | 0/7      | 7/7                      | Manual verification — every component reachable via sidebar nav     |
| `useImportedSymbols` returns data     | Never    | Always (when deps exist) | Integration test — load project with deps, verify non-empty symbols |
| Navigation routing coverage           | 0/2      | 2/2 new pages            | Unit test — URL parsing and path building for both page variants    |
| Time from project load to deps loaded | N/A      | < 500ms (P95)            | Performance test — measure loadDependencies latency                 |

---

## 15. Open Questions

| #   | Question                                                                                                                       | Status                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Should the releases list in ModuleSettingsPage include a standalone "Promote" action per release (for post-publish promotion)? | DECIDED: No for this sub-feature. Promotion at publish time (via PublishModuleDialog) is sufficient. A per-release promote button can be added as a follow-up if users request it. The API endpoint exists and is ready. |
| 2   | Should `loadDependencies` error state surface a toast or banner in the UI?                                                     | DECIDED: No — degrade silently (empty imported symbols). The existing error handling in module-store is sufficient. If the API fails, the user can still navigate and trigger a reload from the dependencies page.       |
| 3   | Should the dependencies page show a prompt to enable module mode if the current project is not a module?                       | DECIDED: No — dependencies are a consumer-side concern, not author-side. A non-module project can still import modules. The settings-modules page handles the author journey.                                            |

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                     | Severity | Status  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| GAP-001 | No standalone promote UI for promoting an already-published release to a different environment — promotion only at publish time | Low      | Planned |
| GAP-002 | No standalone catalog browsing page — catalog only accessible through ImportModuleDialog                                        | Low      | Planned |
| GAP-003 | No standalone releases page — releases managed from within module settings                                                      | Low      | Planned |
| GAP-004 | `loadDependencies` failure is silent — imported symbols degrade to empty without user notification                              | Low      | Planned |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                               | Coverage Type | Status          | Test File / Note                                                   |
| --- | -------------------------------------------------------------------------------------- | ------------- | --------------- | ------------------------------------------------------------------ |
| 1   | Navigate to `/projects/:id/settings/modules` → renders ModuleSettingsPanel             | unit          | PASS            | `module-studio-wiring.test.tsx`                                    |
| 2   | Navigate to `/projects/:id/module-dependencies` → renders ModuleDependencyList         | unit          | PASS            | `module-studio-wiring.test.tsx`                                    |
| 3   | Project load triggers `loadDependencies()` → `useImportedSymbols` returns non-empty    | integration   | PASS            | `module-dependency-loading.test.tsx`                               |
| 4   | Sidebar shows "Modules" in Settings group and "Dependencies" in Resources              | unit          | PASS            | `module-studio-wiring.test.tsx`                                    |
| 5   | "Publish Release" button on settings-modules opens PublishModuleDialog                 | unit          | PASS            | `module-settings-page.test.tsx`                                    |
| 6   | "Import Module" button on module-dependencies opens ImportModuleDialog                 | unit          | PASS            | `module-dependencies-page.test.tsx`                                |
| 7   | Feature flag off → module settings shows disabled state                                | unit          | PASS            | `module-settings-page.test.tsx`                                    |
| 8   | `buildPath` generates correct URLs for both page variants                              | unit          | PASS            | `module-studio-wiring.test.tsx`                                    |
| 9   | `parseUrl` correctly identifies both page variants from URL                            | unit          | PASS            | `module-studio-wiring.test.tsx`, `stores/navigation-store.test.ts` |
| 10  | Dependency loading failure degrades gracefully (empty symbols, no crash)               | integration   | PASS            | `module-dependency-loading.test.tsx`                               |
| 11  | Navigate to module project and open the publish flow from the wired shell              | e2e           | PASS (indirect) | `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`             |
| 12  | Navigate to consumer project and open the import flow from the wired shell             | e2e           | PASS (indirect) | `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`             |
| 13  | Load project with dependencies → authoring surfaces expose imported module affordances | e2e           | PARTIAL         | Unit/integration covered; dedicated Playwright spec still deferred |

### Testing Notes

This sub-feature is primarily UI wiring — tests focus on navigation routing, component mounting, and the dependency loading lifecycle. Existing component-level tests (12 project-dashboard-modules, 5 tool-picker-imported-tools, 6 coordination-section-imported-agents) remain valid and are not duplicated.

> Full testing details: [../../testing/sub-features/module-studio-wiring.md](../../testing/sub-features/module-studio-wiring.md)

---

## 18. References

- Parent feature spec: [../reusable-agent-modules.md](../reusable-agent-modules.md)
- Design doc: [../../specs/reusable-agent-modules.hld.md](../../specs/reusable-agent-modules.hld.md)
- LLD: [../../plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md](../../plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md)
