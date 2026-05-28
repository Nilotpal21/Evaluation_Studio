# HLD: Module Studio Wiring

**Feature Spec**: `docs/features/sub-features/module-studio-wiring.md`
**Test Spec**: `docs/testing/sub-features/module-studio-wiring.md`
**Parent HLD**: `docs/specs/reusable-agent-modules.hld.md`
**Status**: APPROVED — Implemented 2026-04-15
**Date**: 2026-04-15

---

## 1. Overview & Goal

Wire all 7 existing module UI components into the Studio app shell so that module authors and consumer developers can reach the full module lifecycle through standard navigation. Fix the dependency loading lifecycle so that `useImportedSymbols` populates correctly for all projects with module dependencies.

## 2. Problem Statement

Before the 2026-04-15 remediation, Reusable Agent Modules had 7 fully implemented UI components, a complete Zustand store, a type-safe API client (16 functions), and 11 backend API route files — but the Studio shell wiring was incomplete. The feature was not reliably reachable from normal navigation.

That missing shell wiring also broke `useImportedSymbols`, the hook that surfaces imported module agents and tools into `ABLSymbolTree`, `ToolPickerDialog`, and `CoordinationSection`, because `module-store.dependencies` was not being hydrated at the app-shell level. Imported symbols therefore failed to appear consistently in authoring.

This sub-feature wires the existing components into the Studio app shell by adding 2 new navigation pages, corresponding sidebar entries, a project-level dependency loading effect, and dialog trigger buttons. No backend changes, no new component logic.

---

## 3. Alternatives Considered

### Option A: Wire into Existing Settings Tabs

- **Description**: Add module settings as a new tab within the existing `settings` page rather than a separate `settings-modules` page. Mount dependency list as a section within the existing `tools` page.
- **Pros**: Zero new page variants. No navigation store changes.
- **Cons**: Conflates module author and consumer developer personas into unrelated pages. The settings page is already crowded (13 sub-pages). The tools page is resource-focused, not dependency-focused. Breaks the 1:1 mapping between sidebar item and page that all other features follow.
- **Effort**: S

### Option B: Two New Pages Following Standard Pattern (RECOMMENDED)

- **Description**: Add `settings-modules` as a settings sub-page and `module-dependencies` as a top-level resource page. Follow the established pattern: `ProjectPage` union variant → `parseUrl` / `buildPath` → `renderContent` switch case → sidebar entry. Create two thin page wrapper components that compose existing module components.
- **Pros**: Follows the exact pattern used by 20+ existing pages. Clean persona separation (module author → settings, consumer developer → resources). Consistent URL structure (`/projects/:id/settings/modules` and `/projects/:id/module-dependencies`).
- **Cons**: Adds 2 new entries to the `ProjectPage` union (trivial). Requires 2 new React components (thin wrappers only).
- **Effort**: S

### Option C: Next.js App Router Pages

- **Description**: Create actual Next.js file-system route pages in `apps/studio/src/app/projects/[id]/settings/modules/page.tsx` and `apps/studio/src/app/projects/[id]/module-dependencies/page.tsx`.
- **Pros**: Would follow standard Next.js conventions.
- **Cons**: **Incompatible with Studio's architecture.** Studio uses client-side routing via `navigation-store.ts` with `history.pushState`. All project pages render through `AppShell.tsx`'s `renderContent` switch. No existing project page uses the Next.js app router. This would be the only page using file-system routing, creating a jarring architectural inconsistency.
- **Effort**: M (plus ongoing maintenance burden of dual routing)

### Recommendation: Option B

**Rationale**: Option B follows the established 5-step wiring pattern used by every other page in Studio. It is the lowest-risk, lowest-effort approach that cleanly separates module author and consumer developer personas. Option A is too cramped and Option C is architecturally incompatible.

---

## 4. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Studio Browser Client                                          │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  ProjectSidebar  │───►│  NavigationStore  │◄── URL bar       │
│  │  ├ Settings group │    │  (parseUrl /      │                   │
│  │  │ └ "Modules"    │    │   buildPath)       │                   │
│  │  └ Resources sect │    └────────┬─────────┘                   │
│  │    └ "Dependencies"│            │ page                        │
│  └──────────────────┘            ▼                              │
│                         ┌──────────────────┐                    │
│                         │    AppShell       │                    │
│                         │  renderContent()  │                    │
│                         │  ┌──────────────┐ │                    │
│                         │  │ settings-    │ │                    │
│                         │  │ modules →    │ │                    │
│                         │  │ ModuleSetPg  │ │                    │
│                         │  ├──────────────┤ │                    │
│                         │  │ module-      │ │                    │
│                         │  │ dependencies │ │                    │
│                         │  │ → ModuleDepPg│ │                    │
│                         │  └──────────────┘ │                    │
│                         │                    │                    │
│                         │  useEffect:        │                    │
│                         │  loadDependencies  │                    │
│                         │  (projectId)       │                    │
│                         └────────┬───────────┘                   │
│                                  │                               │
│  ┌──────────────────┐            │                               │
│  │   ModuleStore    │◄───────────┘                               │
│  │  .dependencies   │                                            │
│  │  .releases       │                                            │
│  │  .catalog        │                                            │
│  └────────┬─────────┘                                            │
│           │                                                      │
│  ┌────────▼─────────┐     ┌──────────────────────────────┐      │
│  │useImportedSymbols│────►│ ABLSymbolTree                │      │
│  │  .agents[]       │     │ ToolPickerDialog             │      │
│  │  .tools[]        │     │ CoordinationSection          │      │
│  └──────────────────┘     └──────────────────────────────┘      │
│                                                                  │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ HTTP API
                                       ▼
                              ┌──────────────────┐
                              │  Studio API      │
                              │  (Next.js routes)│
                              │  /api/projects/  │
                              │  :id/module-*    │
                              └──────────────────┘
```

### Component Diagram

```
ModuleSettingsPage (new)
├── ModuleSettingsPanel (existing)
│   └── ReverseDepPanel (existing, embedded)
├── "Publish Release" button
│   └── opens PublishModuleDialog (existing)
└── Releases list
    └── ArchiveReleaseButton per release (existing)

ModuleDependenciesPage (new)
├── "Import Module" button
│   └── opens ImportModuleDialog (existing)
│       └── Catalog browse + contract preview + import flow
└── ModuleDependencyList (existing)
    └── UpgradeModuleDialog (existing, triggered from update badge)
```

### Data Flow

**Project Load → Dependency Loading (critical path)**:

```
1. User navigates to project
2. URL → parseUrl() → { area: 'project', projectId: 'abc' }
3. AppShell renders, projectId changes
4. useEffect fires → loadDependencies('abc')
5. module-store calls GET /api/projects/abc/module-dependencies
6. Response populates module-store.dependencies[]
7. useImportedSymbols derives agents/tools with separate alias field (display composed by consuming components)
8. ABLSymbolTree, ToolPickerDialog, CoordinationSection render imported symbols
```

**Settings Page Navigation**:

```
1. User clicks "Modules" in Settings sidebar group
2. navigateTo({ page: 'settings-modules' })
3. buildPath → /projects/abc/settings/modules
4. history.pushState updates URL
5. renderContent('settings-modules') → <ModuleSettingsPage />
6. ModuleSettingsPage reads module-store.releases, renders composition
```

**Dependencies Page Navigation**:

```
1. User clicks "Dependencies" in Resources sidebar
2. navigateTo({ page: 'module-dependencies' })
3. buildPath → /projects/abc/module-dependencies
4. history.pushState updates URL
5. renderContent('module-dependencies') → <ModuleDependenciesPage />
6. ModuleDependenciesPage reads module-store.dependencies, renders list
```

---

## 5. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                              |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | No change. All module API endpoints already include `tenantId` in queries. `loadDependencies` calls the existing `GET /api/projects/:id/module-dependencies` route which enforces tenant isolation at the API layer. The client-side store is project-scoped (one dependency set at a time). |
| 2   | **Data Access**      | No new data access patterns. Client reads from Zustand store (`module-store.ts`) which fetches from existing API routes. No direct database access from the client. No caching changes — the store is the cache, repopulated on project navigation.                                          |
| 3   | **API Contract**     | No API changes. All 11 backend route files and 16 API client functions are pre-existing. The only new client-side "contract" is the two `ProjectPage` variants (`settings-modules`, `module-dependencies`) which are internal to the Studio routing system.                                  |
| 4   | **Security Surface** | No new attack surface. No new API endpoints. No new data flows. Feature gating enforced at component level via `useFeatures().hasModules`. Navigation items are unconditionally visible (no information leakage — sidebar labels "Modules" and "Dependencies" are generic).                  |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | `loadDependencies` failure: caught in module-store try/catch, logged to console, `dependencies` remains `[]`. `useImportedSymbols` returns empty arrays. Authoring surfaces degrade gracefully (no imported symbols shown). No user-facing error toast — silent degradation. |
| 6   | **Failure Modes** | Single failure mode: API GET for dependencies fails or times out. Recovery: user navigates to Dependencies page, triggering `ModuleDependencyList` which calls `loadDependencies` on mount (provides manual retry). No circuit breaker needed — single lightweight GET.      |
| 7   | **Idempotency**   | `loadDependencies` is idempotent — each call replaces `dependencies` state with the latest API response. Multiple concurrent calls have a last-write-wins behavior (known gap, documented as regression marker INT-4 in test spec). No deduplication needed.                 |
| 8   | **Observability** | No new trace events or metrics. Existing module audit events (triggered by API calls, not UI actions) continue to work. Console logging in module-store catch blocks provides debug visibility. No production logging changes.                                               |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | `loadDependencies` adds 1 lightweight HTTP GET per project navigation. Payload: max 5 dependency objects (per parent feature spec FR-8). Empty array for non-consumer projects. Target: < 500ms P95. No render cycle overhead — store update triggers minimal React re-renders.                                                                                    |
| 10  | **Migration Path**     | No migration. No new data models, collections, fields, or schema changes. Purely additive client-side changes. Rollback: `git revert` + redeploy Studio.                                                                                                                                                                                                           |
| 11  | **Rollback Plan**      | `git revert` the commit(s) + redeploy Studio. No database rollback needed. Alternatively, disable `reusable_modules` feature flag — sidebar items remain visible but module settings page shows disabled state (soft rollback without code change).                                                                                                                |
| 12  | **Test Strategy**      | Shipping verification uses 3 dedicated wiring unit tests, 2 settings-page unit tests, 2 dependencies-page unit tests, 3 dependency-hydration integration tests, the existing `navigation-store.test.ts` routing coverage, and indirect browser coverage from `apps/studio/e2e/reusable-agent-modules-smoke.spec.ts`. A dedicated Playwright spec remains deferred. |

---

## 6. Data Model

No data model changes. All collections are defined in the parent feature spec:

- `module_releases` — immutable release records
- `project_module_dependencies` — consumer project → release bindings
- `deployment_module_snapshots` — frozen module state at deploy time
- `module_environment_pointers` — dev/staging/production promotion targets

### Key Client-Side State Relationships

```
module-store.dependencies[]  ← loadDependencies(projectId)
       │
       ▼
useImportedSymbols()
       │
       ├── agents[]: { name: 'verify', alias: 'idv', moduleProjectName: '...', dependencyId: '...' }
       ├── tools[]:  { name: 'check-id', alias: 'idv', moduleProjectName: '...', dependencyId: '...' }
       └── hasDependencies: boolean
       (consuming components compose display as "alias.name", e.g., "idv.verify")
              │
              ▼
       ABLSymbolTree / ToolPickerDialog / CoordinationSection
```

---

## 7. API Design

No API changes. All endpoints are pre-existing:

| Method | Path                                                   | Purpose                                        | Status   |
| ------ | ------------------------------------------------------ | ---------------------------------------------- | -------- |
| GET    | `/api/projects/:id/module`                             | Get module settings (enable state, visibility) | Existing |
| POST   | `/api/projects/:id/module`                             | Enable module mode                             | Existing |
| GET    | `/api/projects/:id/module/releases`                    | List releases                                  | Existing |
| POST   | `/api/projects/:id/module/releases`                    | Publish release                                | Existing |
| POST   | `/api/projects/:id/module/releases/:releaseId`         | Archive release (`action: 'archive'` body)     | Existing |
| POST   | `/api/projects/:id/module/releases/:releaseId/promote` | Promote release to environment                 | Existing |
| GET    | `/api/projects/:id/module/consumers`                   | Consumer project list                          | Existing |
| GET    | `/api/projects/:id/module-catalog`                     | Browse tenant catalog                          | Existing |
| GET    | `/api/projects/:id/module-catalog/:moduleProjectId`    | Module detail                                  | Existing |
| GET    | `/api/projects/:id/module-dependencies`                | List dependencies                              | Existing |
| POST   | `/api/projects/:id/module-dependencies`                | Import module                                  | Existing |
| POST   | `/api/projects/:id/module-dependencies/preview`        | Import preview                                 | Existing |
| PATCH  | `/api/projects/:id/module-dependencies/:depId`         | Upgrade dependency to newer release            | Existing |
| DELETE | `/api/projects/:id/module-dependencies/:depId`         | Remove dependency                              | Existing |
| GET    | `/api/projects/:id/module-dependencies/:depId/diff`    | Release diff                                   | Existing |

---

## 8. Cross-Cutting Concerns

- **Audit Logging**: No new audit events. Existing module API audit events fire on actual data mutations (publish, import, archive, upgrade), which are triggered by existing components already wired to these API calls.
- **Rate Limiting**: No changes. Module API routes use the standard rate limiting middleware already applied to all Studio API routes.
- **Caching**: No server-side caching changes. Client-side: `module-store` acts as the cache; repopulated via `loadDependencies` on every project navigation (ensures fresh data).
- **Encryption**: No changes. All data in transit uses HTTPS. Data at rest encryption handled by MongoDB at rest encryption (existing).
- **i18n**: Two new translation keys needed in `packages/i18n/locales/en/studio.json` (nav namespace): `"modules": "Modules"` and `"dependencies": "Dependencies"`.

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                                 | Type           | Risk                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `module-store.ts` (Zustand store)          | Client state   | None — existing, stable, fully tested                                                                                                                                                                                                                                                                                                                  |
| `useImportedSymbols` hook                  | Derived state  | None — pure derivation, no side effects                                                                                                                                                                                                                                                                                                                |
| `api/modules.ts` (16 API client functions) | HTTP client    | None — existing, no changes                                                                                                                                                                                                                                                                                                                            |
| 11 backend API route files                 | API endpoints  | None — existing, functional                                                                                                                                                                                                                                                                                                                            |
| `navigation-store.ts` (routing)            | Client routing | Low — additive union variant                                                                                                                                                                                                                                                                                                                           |
| `AppShell.tsx` (render shell)              | UI shell       | Low — additive switch case + useEffect                                                                                                                                                                                                                                                                                                                 |
| `ProjectSidebar.tsx` (navigation)          | UI navigation  | Low — additive array entries                                                                                                                                                                                                                                                                                                                           |
| `config/navigation.ts` (universal search)  | Search config  | Low — additive array entries. **CAUTION**: `ProjectSidebar.tsx` has its own independent copies of all nav definitions — it does NOT import from `config/navigation.ts`. Both files must be updated. Pre-existing divergence: `config/navigation.ts` is missing `settings-auth-profiles` and `settings-attachments` that `ProjectSidebar.tsx` includes. |
| `packages/i18n` (translation keys)         | i18n           | None — additive keys only                                                                                                                                                                                                                                                                                                                              |

### Downstream (depends on this feature)

| Consumer                                                     | Impact                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `ABLSymbolTree` / `ToolPickerDialog` / `CoordinationSection` | Will show imported symbols once `loadDependencies` populates the store |
| `UniversalSearch`                                            | Will find "Modules" and "Dependencies" pages in search results         |

---

## 10. Open Questions & Decisions Needed

| #   | Question                                                                                                                                                                                                                     | Status  | Decision                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should `loadDependencies` use an abort controller for stale-request protection?                                                                                                                                              | DECIDED | No — zero precedent in AppShell, negligible risk (max 5 items), INT-4 regression marker covers it. Defer to future sprint if needed.                              |
| 2   | Should `loadDependencies` be in a separate `useEffect` or merged with the `setCurrentProjectId` effect?                                                                                                                      | DECIDED | Separate `useEffect` — consistent with AppShell's single-responsibility effect pattern.                                                                           |
| 3   | Should the new nav items also be added to `config/navigation.ts` (for UniversalSearch)?                                                                                                                                      | DECIDED | Yes — both `config/navigation.ts` and `ProjectSidebar.tsx` local arrays must be updated.                                                                          |
| 4   | Should this feature reconcile the pre-existing divergence between `config/navigation.ts` and `ProjectSidebar.tsx` (missing `settings-auth-profiles` and `settings-attachments` in config), or defer that to a separate task? | DECIDED | Defer. The module-wiring remediation updated both files only for the new module entries and intentionally did not expand scope into unrelated navigation cleanup. |

---

## 11. Post-Implementation Notes

- Implemented on 2026-04-15 with two new page wrappers (`ModuleSettingsPage`, `ModuleDependenciesPage`), new sidebar entries, navigation-store support, and project-level dependency hydration in `AppShell.tsx`.
- The parent browser smoke spec now provides indirect UI reachability coverage for publish/import flows. A dedicated `module-studio-wiring.spec.ts` Playwright suite is still optional follow-on work rather than a blocker for BETA.
- The remediation intentionally preserved the pre-existing navigation-config divergence outside the new module entries; that cleanup should land separately if UniversalSearch consistency becomes a broader focus.

---

## 12. References

- Feature spec: `docs/features/sub-features/module-studio-wiring.md`
- Test spec: `docs/testing/sub-features/module-studio-wiring.md`
- Parent HLD: `docs/specs/reusable-agent-modules.hld.md`
- Parent feature spec: `docs/features/reusable-agent-modules.md`
- Parent LLD: `docs/plans/2026-03-22-reusable-agent-modules-phase2-impl-plan.md`
