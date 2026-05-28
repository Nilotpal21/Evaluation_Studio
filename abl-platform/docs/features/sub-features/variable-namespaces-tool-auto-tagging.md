# Feature: Variable Namespaces + Tool Auto-Tagging

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Environment Variables & Namespaces](../environment-variables.md)
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `governance`, `integrations`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/shared`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md](../../testing/sub-features/variable-namespaces-tool-auto-tagging.md)
**Last Updated**: 2026-03-18

---

## 1. Introduction / Overview

### Problem Statement

Variable Namespaces + Tool Auto-Tagging is the focused sub-feature that turns environment/config variables into scoped resources instead of a flat project-wide bag. Each project gets a default namespace, variables can belong to one or more namespaces through a membership join table, and tools carry their own `variableNamespaceIds` so Runtime can resolve only the variables that tool is allowed to see.

### Goal Statement

This complements the broader Environment Variables & Namespaces feature by documenting the scoping behavior that matters most for tool execution and E2E coverage. The design goal is least-privilege resolution: a tool that only needs one subset of variables should not automatically see every secret in the project.

### Summary

The "auto-tagging" part reduces setup friction. New projects auto-create a default namespace, environment variables and config variables fall into that default namespace when the caller does not specify memberships, and Studio tool creation auto-links new tools to the default namespace unless the caller explicitly provides `variableNamespaceIds`.

### Key Capabilities

- Default namespace auto-provisioning for every new project
- Many-to-many membership model for env/config variables
- Default-namespace auto-assignment for env vars, config vars, and tools
- Explicit namespace override on tool create/update through `variableNamespaceIds`
- Tool-update warnings when referenced variables are missing from linked namespaces
- Namespace CRUD, member CRUD, and orphan migration to default namespace
- Runtime namespace scoping via `variableNamespaceIds` on tool definitions
- Cross-tenant and cross-project isolation on namespace-bound resources

---

## 2. Scope

### Goals

- Provide namespace-based least-privilege scoping for environment and config variables inside a project.
- Reduce setup friction by auto-provisioning a default namespace and auto-tagging new variables and tools when callers omit explicit namespace IDs.
- Surface namespace mismatches in Studio before runtime execution so tool authors get early feedback.

### Non-Goals (Out of Scope)

- A tenant-global namespace control plane shared across unrelated projects.
- A separate admin-only namespace UI outside project-scoped Studio and Runtime surfaces.
- Replacing the broader environment-variable feature; this doc focuses on namespace scoping and tool-linkage behavior.

---

## 3. User Stories

1. As a project admin, I want variables grouped into namespaces so I can keep secret access bounded inside one project.
2. As a tool author, I want new tools to auto-link to a safe default namespace so I can start testing without extra manual setup.
3. As a developer, I want Studio warnings when a tool references variables outside its linked namespaces so I can fix scope problems before runtime.

---

## 4. Functional Requirements

1. **FR-1**: The system must auto-provision a default namespace for each project that uses this capability.
2. **FR-2**: The system must allow environment variables and config variables to belong to one or more namespaces through membership records.
3. **FR-3**: The system must auto-assign env vars, config vars, and tools to the default namespace when no explicit namespace IDs are supplied.
4. **FR-4**: The system must allow tool create/update flows to accept explicit `variableNamespaceIds` overrides.
5. **FR-5**: The system must scope runtime variable resolution to the tool's linked namespaces and warn when references fall outside that scope.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Namespace records are project-scoped setup and maintenance resources. |
| Agent lifecycle            | PRIMARY      | Tool IR carries namespace scope into runtime execution.               |
| Customer experience        | SECONDARY    | End users are affected indirectly through safer tool behavior.        |
| Integrations / channels    | SECONDARY    | Any channel that triggers tool execution inherits namespace scoping.  |
| Observability / tracing    | SECONDARY    | Warnings and audit logs make mis-scoped tools visible early.          |
| Governance / controls      | PRIMARY      | Least-privilege secret access is the core control outcome here.       |
| Enterprise / compliance    | SECONDARY    | Namespace scoping reduces accidental secret overexposure.             |
| Admin / operator workflows | SECONDARY    | Managed in project-scoped Studio flows rather than a global admin UI. |

### Related Feature Integration Matrix

| Related Feature                                                   | Relationship Type | Why It Matters                                                                        | Key Touchpoints                                              | Current State |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| [Environment Variables & Namespaces](../environment-variables.md) | extends           | This is the focused execution-scoping slice of the parent feature.                    | namespace CRUD, memberships, env/config CRUD                 | Active        |
| [Tool Invocations](../tool-invocations.md)                        | depends on        | Namespace IDs affect which variables a tool can resolve when invoked.                 | `variableNamespaceIds`, tool DSL, executor lookups           | Active        |
| [Variable Resolution Across Tool Types](./variable-resolution.md) | pairs with        | That sub-feature documents execution-time interpolation after namespace scope is set. | HTTP/MCP interpolation, secrets provider, runtime resolution | Active        |

---

## 6. Design Considerations (Optional)

Studio keeps namespace management close to variable editing and tool authoring instead of moving it into a disconnected admin flow. That keeps least-privilege decisions in the same workflow where variables and tools are created.

---

## 7. Technical Considerations (Optional)

This sub-feature depends on a many-to-many membership join model, direct storage of `variableNamespaceIds` on tools, and warning logic in Studio update flows. It also inherits the parent feature's project/tenant isolation guarantees and runtime/provider resolution chain.

---

## 8. How to Consume

### Studio UI

The main Studio surfaces are:

- **EnvironmentVariablesSection** for per-environment variable creation and editing
- **ManageVariableNamespacesPanel** for namespace CRUD and ordering
- **VariableNamespaceTagPopover** for membership editing on individual variables
- **ConfigVariablesTab** for project config variables that share the same namespace model
- **Tools pages** where newly created tools are auto-linked to the default namespace unless the caller supplies explicit namespace IDs

### API (Runtime)

| Method | Path                                                                                    | Purpose                                             |
| ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GET    | `/api/projects/:projectId/variable-namespaces`                                          | List namespaces for a project                       |
| POST   | `/api/projects/:projectId/variable-namespaces`                                          | Create a namespace                                  |
| PUT    | `/api/projects/:projectId/variable-namespaces/reorder`                                  | Reorder namespaces                                  |
| PUT    | `/api/projects/:projectId/variable-namespaces/:variableNamespaceId`                     | Update a namespace                                  |
| DELETE | `/api/projects/:projectId/variable-namespaces/:variableNamespaceId`                     | Delete a namespace and migrate orphans              |
| GET    | `/api/projects/:projectId/variable-namespaces/:variableNamespaceId/members`             | List namespace members                              |
| POST   | `/api/projects/:projectId/variable-namespaces/:variableNamespaceId/members`             | Add env/config vars to a namespace                  |
| DELETE | `/api/projects/:projectId/variable-namespaces/:variableNamespaceId/members/:variableId` | Remove member                                       |
| POST   | `/api/projects/:projectId/env-vars`                                                     | Create env var with optional `variableNamespaceIds` |

### API (Studio)

| Method | Path                                                                 | Purpose                                             |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------- |
| GET    | `/api/projects/:id/variable-namespaces`                              | Studio proxy to namespace list/create               |
| POST   | `/api/projects/:id/variable-namespaces`                              | Create namespace                                    |
| GET    | `/api/projects/:id/variable-namespaces/:variableNamespaceId`         | Namespace detail                                    |
| PUT    | `/api/projects/:id/variable-namespaces/:variableNamespaceId`         | Update namespace                                    |
| GET    | `/api/projects/:id/variable-namespaces/:variableNamespaceId/members` | List namespace members                              |
| POST   | `/api/projects/:id/config-variables`                                 | Create config variable with optional namespace IDs  |
| PUT    | `/api/projects/:id/config-variables/:varId`                          | Replace config-variable memberships                 |
| POST   | `/api/projects/:id/tools`                                            | Create tool with optional `variableNamespaceIds`    |
| PUT    | `/api/projects/:id/tools/:toolId`                                    | Update tool namespaces and emit validation warnings |

### Admin Portal

There is no separate admin-specific namespace UI. Namespace management is project-scoped in Studio.

### Channel Integration

Namespace scoping is channel-agnostic. Any channel that triggers tool execution inherits the same namespace-bound resolution behavior once the tool is compiled with `variable_namespace_ids`.

---

## 9. Data Model

### Collections / Tables

```text
Collection: variable_namespaces
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - name: string
  - displayName: string
  - description: string | null
  - color: string | null
  - order: number
  - isDefault: boolean
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } unique
  - { tenantId: 1, projectId: 1, order: 1 }
```

```text
Collection: variable_namespace_memberships
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - namespaceId: string
  - variableId: string
  - variableType: 'env' | 'config'
Indexes:
  - { namespaceId: 1, variableId: 1, variableType: 1 } unique
  - { variableId: 1, variableType: 1 }
  - { tenantId: 1, projectId: 1, namespaceId: 1 }
```

```text
Collection: project_tools
Relevant fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - name: string
  - toolType: string
  - variableNamespaceIds: string[]
Purpose:
  - carries namespace scope from Studio into Runtime tool IR
```

### Key Relationships

- `variable_namespace_memberships.namespaceId` -> `variable_namespaces._id`
- `variable_namespace_memberships.variableId` -> either `environment_variables._id` or `project_config_variables._id`
- `project_tools.variableNamespaceIds` references `variable_namespaces._id` values directly
- Runtime converts `variableNamespaceIds` into `variable_namespace_ids` in tool IR for execution-time scoping

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/services/project-service.ts`                         | Auto-creates default namespace for new projects   |
| `packages/database/src/models/variable-namespace.model.ts`            | Namespace schema and indexes                      |
| `packages/database/src/models/variable-namespace-membership.model.ts` | Membership join schema                            |
| `packages/database/src/models/project-tool.model.ts`                  | Stores `variableNamespaceIds` on tools            |
| `packages/shared/src/validation/project-tool-schemas.ts`              | Validates `variableNamespaceIds` on create/update |
| `packages/shared/src/repos/project-tool-repo.ts`                      | Persists tool namespace assignments               |

### Routes / Handlers

| File                                                              | Purpose                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `apps/runtime/src/routes/variable-namespaces.ts`                  | Namespace CRUD, ordering, and default protection       |
| `apps/runtime/src/routes/variable-namespace-members.ts`           | Membership list/add/remove/move                        |
| `apps/runtime/src/routes/environment-variables.ts`                | Env var create/update with namespace assignment        |
| `apps/studio/src/app/api/projects/[id]/config-variables/route.ts` | Config variable create with default-namespace fallback |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts`            | Tool create with auto-tagging or explicit override     |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`   | Tool update warnings and namespace replacement         |

### UI Components (Studio)

| File                                                                     | Purpose                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` | Env-var CRUD and namespace-aware editing             |
| `apps/studio/src/components/variables/ManageVariableNamespacesPanel.tsx` | Namespace CRUD UI                                    |
| `apps/studio/src/components/variables/VariableNamespaceTagPopover.tsx`   | Membership editing per variable                      |
| `apps/studio/src/components/settings/ConfigVariablesTab.tsx`             | Config-variable CRUD with namespace support          |
| `apps/studio/src/components/tools/ToolCreatePage.tsx`                    | Tool creation surface that uses namespace-aware APIs |

### Tests

| File                                                                         | Type        | Count                                                      |
| ---------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `apps/runtime/src/__tests__/environment-variables-authz.test.ts`             | integration | live authz coverage for env-var namespace paths            |
| `apps/runtime/src/__tests__/routes/variable-namespaces-route.test.ts`        | unit        | namespace CRUD coverage                                    |
| `apps/runtime/src/__tests__/routes/variable-namespace-members-route.test.ts` | unit        | membership CRUD coverage                                   |
| `apps/runtime/src/__tests__/variable-namespace-repos.test.ts`                | unit        | repository and member-count behavior                       |
| `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md`         | e2e guide   | 7 live iterations across CRUD, auto-tagging, and isolation |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                                                             |
| -------- | ------- | ------------------------------------------------------------------------------------------------------- |
| —        | —       | This feature is controlled primarily by DB records and shared constants, not dedicated process env vars |

### Runtime Configuration

- `MAX_VARIABLE_NAMESPACES_PER_PROJECT = 25`
- `MAX_VARIABLE_NAMESPACES_PER_VARIABLE = 10`
- Default namespace constants come from `@abl/compiler/platform`
- Tool create/update schemas allow up to 20 `variableNamespaceIds` on the Studio API surface

### DSL / Agent IR

This feature is not authored directly in ABL, but it affects IR output:

```text
ToolDefinition.variable_namespace_ids: string[]
```

Those IDs are carried from `project_tools.variableNamespaceIds` and later used by Runtime secrets/config resolution.

---

## 12. Runtime Integration

### Lifecycle

1. Project creation auto-creates the default variable namespace.
2. Env vars and config vars attach to explicit namespaces when provided; otherwise they are inserted into the default namespace.
3. Studio tool creation uses caller-supplied `variableNamespaceIds` when present; otherwise it auto-links the tool to the default namespace.
4. Tool updates can emit warnings if `{{env.KEY}}` or `{{secrets.KEY}}` placeholders reference variables outside the tool's linked namespaces.
5. Runtime receives those namespace IDs in tool IR and uses them to scope secret/config lookups.

### Dependencies

- Namespace and membership Mongo collections
- Env-var and config-var CRUD routes
- Tool create/update routes in Studio
- `RuntimeSecretsProvider` and Studio tool-test service for execution-time enforcement

### Event Flow

- Env-var CRUD writes audit events such as `env-variable:create`, `env-variable:update`, and `env-variable:delete`
- Tool updates can return warnings instead of hard failures when namespace references are unresolved
- Default-namespace provisioning is intentionally non-blocking for project creation

---

## 13. Admin Integration

Namespace management is project-scoped only. There is no tenant-wide namespace control plane.

---

## 18. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                       | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Tool warning validation scans `dslContent` only; header-array edits are not represented in the update schema      | Low      | Open   |
| GAP-002 | Browser automation for namespace-heavy UI flows is still missing                                                  | Medium   | Open   |
| GAP-003 | Tools with zero linked namespaces intentionally resolve nothing, which can surprise callers during manual testing | Low      | Open   |

---

## 14. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Namespace CRUD, membership CRUD, and tool linkage must stay project-scoped and include `projectId` in reads/writes. |
| Tenant isolation  | Namespace-bound resources must include `tenantId`, and cross-tenant access must return 404 or empty scoped results. |
| User isolation    | Mutations are project-owned but still flow through authenticated user identity for RBAC and audit purposes.         |

### Performance

Namespace CRUD is lightweight metadata management. The main runtime overhead is a scoped membership lookup before env/config resolution, which is cached by higher-level secret providers during session execution.

### Security & Compliance

Namespace scoping reduces accidental secret overexposure. Cross-tenant and cross-project access checks are enforced throughout the CRUD path, and Studio now returns 404 for cross-tenant project access in the surrounding route-handler stack.

### Scalability

The membership join table supports many-to-many relationships without duplicating variable values. The limits on namespaces-per-project and namespaces-per-variable keep the resolution surface bounded.

### Observability

CRUD operations use audit logging, and tool-update warnings surface namespace-resolution issues early in Studio before the user reaches Runtime execution.

---

## 15. Delivery Plan / Work Breakdown

1. Tighten namespace create/update correctness.
   1.1 Keep create and update flows aligned so explicit `variableNamespaceIds` behave consistently.
   1.2 Expand warning validation when new persisted tool shapes are added beyond `dslContent`.
2. Improve confidence in user-facing flows.
   2.1 Add browser-driven coverage for namespace-management and env-var admin surfaces.
   2.2 Add explicit deployment and import/export verification for namespace assignments.

---

## 16. Success Metrics

| Metric                                                        | Baseline               | Target   | How Measured                           |
| ------------------------------------------------------------- | ---------------------- | -------- | -------------------------------------- |
| Default namespace fallback keeps project setup working        | Current implementation | Maintain | Route tests plus live CRUD coverage    |
| Tools resolve only linked namespace variables                 | Current implementation | Maintain | Live namespace-scoped execution tests  |
| Studio warns on mis-scoped variable references before runtime | Current implementation | Maintain | Tool create/update validation behavior |

---

## 17. Open Questions

1. Should tools with empty namespace arrays continue to mean "unrestricted DB access" or move to a stricter explicit-opt-in model?
2. Should warning validation expand beyond `dslContent` if headers or other tool fragments become independently editable?
3. Do namespace CRUD events need dedicated webhook/event emission beyond audit logging?

---

## 19. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] Environment-variable routes plus namespace/member routes are covered.
- [x] Tool create/update flows cover default namespace tagging and explicit overrides.
- [x] Runtime resolution covers namespace-scoped tool execution.

#### E2E

- [x] Env/config variable CRUD with default namespace fallback is live-verified.
- [x] Tool auto-tagging and explicit namespace overrides are live-verified.
- [x] Namespace link/unlink effects on runtime resolution are live-verified.

### E2E Test Scenarios

| #   | Scenario                                                 | Status     | Test File                                                            |
| --- | -------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| 1   | Env/config variable CRUD with default namespace fallback | PASS       | `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` |
| 2   | Tool auto-tagging to default namespace on create         | PASS       | `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` |
| 3   | Explicit namespace override on tool create/update        | PASS       | `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` |
| 4   | Cross-tenant and cross-project isolation                 | PASS       | `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` |
| 5   | Browser-driven namespace-management UI                   | NOT TESTED | `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` |

### Integration Test Scenarios

| #   | Scenario                                   | Status | Test File                                                                    |
| --- | ------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| 1   | Namespace CRUD route behavior              | PASS   | `apps/runtime/src/__tests__/routes/variable-namespaces-route.test.ts`        |
| 2   | Namespace member list/add/remove/move      | PASS   | `apps/runtime/src/__tests__/routes/variable-namespace-members-route.test.ts` |
| 3   | Repository counts, ordering, and isolation | PASS   | `apps/runtime/src/__tests__/variable-namespace-repos.test.ts`                |

### Unit Test Coverage

| Package             | Tests                                                                                  | Passing            |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------ |
| `apps/runtime`      | `environment-variables-authz.test.ts`, `variable-namespace-repos.test.ts`, route tests | Core flows passing |
| `packages/database` | namespace and membership models through model-security coverage                        | Core flows passing |

> Full testing details: [docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md](../../testing/sub-features/variable-namespaces-tool-auto-tagging.md)

---

## 20. References

- Testing docs: [docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md](../../testing/sub-features/variable-namespaces-tool-auto-tagging.md)
- Related features: [Environment Variables & Namespaces](../environment-variables.md), [Tool Invocations](../tool-invocations.md), [Variable Resolution Across Tool Types](./variable-resolution.md)
- Studio project service: `apps/studio/src/services/project-service.ts`
- Runtime namespace route: `apps/runtime/src/routes/variable-namespaces.ts`
