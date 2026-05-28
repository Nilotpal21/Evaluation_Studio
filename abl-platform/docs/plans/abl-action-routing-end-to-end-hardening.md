# LLD: ABL Action Routing End-to-End Hardening

**Ticket**: ABLP-612
**Status**: DONE
**Date**: 2026-05-03

## 1. Design Decisions

| #   | Decision                                                                                                                     | Rationale                                                                                                             | Alternatives Rejected                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D-1 | Treat `{ tenantId, projectId, agentName }` as the agent identity contract.                                                   | Studio, DB, import, runtime registry, and SDK sessions must fail closed across tenants.                               | Using `agentPath` as identity; it has historical shape drift and migration conflicts. |
| D-2 | Keep `agentPath` only as a canonical derived locator: `projectId/agentName`.                                                 | This matches the latest tenant/domain migration target and avoids reintroducing the removed `default` domain segment. | `projectId/default/agentName`; `tenantId/projectId/agentName`.                        |
| D-3 | Tenant-scope runtime registry keys while preserving explicit legacy overloads for tests/dev sessions without tenant context. | Production sessions have tenant context; old test harnesses can remain isolated through the no-project fallback path. | Breaking all legacy string callers in one slice.                                      |
| D-4 | Make Studio preview action rendering SDK-equivalent for `renderId` and `formData`.                                           | The preview must catch the same form/action envelope bugs that the Web SDK would surface.                             | Rendering buttons only and relying on runtime E2E to catch form submits.              |
| D-5 | Lock every changed boundary with a narrow regression before or with the slice.                                               | The hidden bugs are propagation bugs; broad happy-path tests miss them.                                               | One large E2E-only test that proves the route once but not the field contracts.       |

## 2. Slice Plan

### Slice 1: Canonical Agent Path

**Goal**: All agent writers derive the same path, and the DB index is tenant scoped.

**Tasks**:

1. Add a shared `buildProjectAgentPath(projectId, agentName)` helper.
2. Use it in Studio create/import, Runtime project import, and Mongo agent registry creation.
3. Change the ProjectAgent path unique index to `{ tenantId, projectId, agentPath }`.
4. Add a forward migration that normalizes legacy `projectId/default/name` and `tenantId/projectId/name` paths to `projectId/name`.

**Tests**:

- Shared helper unit test for trimming and canonical output.
- Database model test for tenant-scoped `agentPath` index.
- Existing Studio/import/runtime route tests continue to lock call paths.

### Slice 2: Tenant-Aware Runtime Registry

**Goal**: Compiled IR lookup cannot collide across tenants when project/name/version match.

**Tasks**:

1. Add scoped registry key support with `tenantId`.
2. Pass tenantId from `RuntimeExecutor.registerAgent`, `createSessionFromResolved`, and `SessionFactory.registerAgent`.
3. Make `lookupAgentForSession` prefer `{ tenantId, projectId, version }`, with legacy fallback only when the session has no project scope.

**Tests**:

- Registry isolation test for same project/name/version in two tenants.
- Runtime session materialization test asserts store lookup requires tenant scope.

### Slice 3: Active Version Sync Isolation

**Goal**: Version promotion updates the parent ProjectAgent only within the verified tenant/project boundary.

**Tasks**:

1. Require tenantId/projectId in `updateProjectAgentActiveVersions`.
2. Update promotion to pass tenant/project from `PromoteVersionParams`.
3. Keep non-leaky null behavior when ownership validation fails.

**Tests**:

- Repo-level filter regression or service-level mock assertion that promotion passes tenant/project.

### Slice 4: Studio Preview SDK Parity

**Goal**: Studio preview action submits preserve the same envelope shape as Web SDK action submits.

**Tasks**:

1. Track action set input/select values in `PreviewMessageList`.
2. Include `formData` with `renderId` for action set submits.
3. Keep simple button submits backward compatible.

**Tests**:

- Component regression for a mixed action set proving `formData` and `renderId` are passed to `onAction`.

## 3. Wiring Checklist

- [x] Shared helper exported from `@agent-platform/shared`.
- [x] Studio and Runtime writers import the helper instead of building path strings inline.
- [x] ProjectAgent schema index and migration agree on tenant-scoped path uniqueness.
- [x] Runtime registry registration and lookup pass tenant scope.
- [x] Studio preview transport receives `ActionSubmitOptions.formData` from rendered controls.

## 4. Acceptance Criteria

- [x] No new tenant-blind agent identity path remains on the Studio/import/runtime execution route.
- [x] Same project/name/version can be registered in two tenants without lookup collision.
- [x] Working-copy or version promotion cannot update active versions outside tenant/project scope.
- [x] Studio preview and Web SDK preserve action `renderId` and `formData`.
- [x] Focused tests for all slices pass after package-scoped builds.
