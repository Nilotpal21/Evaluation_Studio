# HLD: Workflow YAML Authoring, Synchronization, and Versioning

**Feature Spec**: `docs/features/workflows.md`
**Related HLD**: `docs/specs/workflows.hld.md`
**Status**: DRAFT
**Author**: Codex
**Date**: 2026-04-02

---

## 1. Problem Statement

The current workflow system supports durable execution, triggers, human tasks, and 12 workflow step types, but authoring remains API and UI-shape driven. The platform does not yet provide:

- a complete hand-authorable YAML format for workflows
- a single canonical workflow definition shared by Studio and Runtime
- fast bidirectional synchronization between a visual Steps editor and YAML
- workflow import/export as YAML
- immutable workflow versions with explicit publish semantics
- deterministic invocation when multiple workflow versions are published

This feature introduces dual-mode workflow authoring:

`YAML <-> canonical JSON model <-> visual editor -> validated executable model -> Restate`

The design keeps Workflow Engine focused on execution and moves authoring, validation, versioning, and compilation concerns into Studio and Runtime.

## 2. Alternatives Considered

### Option A: Visual Editor Only

- **Description**: Keep workflows editable only through Studio UI and backend CRUD payloads.
- **Pros**: Lowest implementation cost. No YAML parser/serializer. No dual-mode synchronization complexity.
- **Cons**: Poor hand-authoring and Git portability. No import/export story. Harder to templatize or review changes outside UI.
- **Effort**: M

### Option B: YAML As Canonical Runtime Format

- **Description**: Store YAML as the primary source of truth and let Runtime or Workflow Engine interpret YAML directly.
- **Pros**: Strong human readability. Text-first workflow definition. One authoring format.
- **Cons**: Bad fit for rich visual editing. YAML parsing and validation complexity leaks into runtime paths. Harder to support fast UI synchronization safely.
- **Effort**: L

### Option C: Canonical JSON Model With YAML Projection (recommended)

- **Description**: Use a canonical JSON object model as the single system source of truth. Visual editor and YAML editor both project onto it. Runtime compiles canonical JSON into an executable plan for Workflow Engine.
- **Pros**: Clean separation of authoring, validation, and execution. Fast UI synchronization. YAML remains first-class for hand-authoring/import/export. Runtime executes a deterministic normalized plan.
- **Cons**: Requires schema unification and new compilation/versioning work in Runtime. YAML round-trip will be normalized rather than formatting-preserving.
- **Effort**: L

### Recommendation: Option C

**Rationale**: The existing codebase already models workflows as structured objects and executes them by `type`-dispatched step definitions. A canonical JSON model fits Studio state, API validation, persistence, and runtime compilation better than YAML as an execution source. YAML remains a first-class authoring and interchange format without contaminating Workflow Engine execution paths.

## 3. Architecture

### System Context Diagram

```text
                       Studio UI (Visual + YAML modes)
                                  |
                                  v
                     +----------------------------+
                     | Workflow Authoring Surface |
                     | - Steps tab visual editor  |
                     | - YAML editor              |
                     | - Import/export actions    |
                     +-------------+--------------+
                                   |
                        Canonical workflow definition
                                   |
                                   v
                        Runtime workflow definition API
                     +-------------------------------+
                     | Validation + Canonicalization |
                     | Versioning                    |
                     | YAML import/export            |
                     | Compile executable plan       |
                     +---------------+---------------+
                                     |
                                     v
                           Workflow Engine (Restate)
                     +-------------------------------+
                     | Execute immutable plan        |
                     | Persist execution snapshots   |
                     | Resume callbacks/approvals    |
                     +-------------------------------+
```

### Component Diagram

```text
apps/studio/
  workflow editor shell
    - visual steps tab
    - YAML mode
    - sync controller
    - version switcher / publish UI

packages/shared or new workflow-definition package/
  - canonical workflow schema
  - YAML parse/serialize helpers
  - semantic validators
  - canonical -> executable compiler types

apps/runtime/
  - workflow definition CRUD
  - workflow import/export endpoints
  - workflow version endpoints
  - publish/default-version resolution
  - executable plan compilation

apps/workflow-engine/
  - execution endpoints
  - explicit version execution
  - Restate-backed workflow handling
  - execution persistence with version pinning
```

### Data Flow

#### Authoring Flow

1. User edits workflow in Visual mode or YAML mode.
2. Studio updates or derives `CanonicalWorkflowDefinition`.
3. Studio validates locally for immediate feedback.
4. Runtime validates again on save/import/publish.
5. Runtime persists the workflow version and compiled executable plan.

#### Execution Flow

1. Client invokes workflow by `workflowId` and optionally `versionId`.
2. Runtime resolves a single executable workflow version.
3. Runtime loads or compiles `ExecutableWorkflowPlan`.
4. Workflow Engine receives exact version identity and plan.
5. Restate executes the plan and persists execution state pinned to that version.

### Sequence Diagram

```text
User -> Studio Visual Editor: edit steps
Studio Visual Editor -> Canonical Model: mutate
Canonical Model -> YAML Renderer: regenerate YAML

User -> Studio YAML Editor: edit YAML
Studio YAML Editor -> YAML Parser: parse
YAML Parser -> Canonical Model: replace last-known-good state
Canonical Model -> Visual Editor: rerender

Studio -> Runtime: save draft / publish / import
Runtime -> Validator: schema + semantic validation
Runtime -> Compiler: canonical -> executable plan
Runtime -> MongoDB: persist WorkflowVersion

Client -> Runtime: execute workflow
Runtime -> Version Resolver: resolve exact published version
Runtime -> Workflow Engine: start execution with workflowVersionId + executable plan
Workflow Engine -> Restate: durable workflow execution
Workflow Engine -> MongoDB: persist execution snapshots
```

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                          |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Workflow, WorkflowVersion, and WorkflowExecution records remain tenant + project scoped. All import/export/version/execution endpoints require tenant and project context and must query by `tenantId` and `projectId`. Cross-tenant access returns 404. |
| 2   | **Data Access Pattern** | Runtime owns workflow definition persistence and compilation. Workflow Engine only reads executable plans or receives them at execution start. Studio never writes DB models directly; it uses Runtime APIs.                                             |
| 3   | **API Contract**        | Introduce versioned workflow endpoints, YAML import/export endpoints, and explicit execution endpoints. Use path/body for version identity and optional headers for content negotiation and optimistic concurrency.                                      |
| 4   | **Security Surface**    | YAML parsing must use safe settings with no custom tags or executable constructs. Only validated canonical definitions are publishable. Published versions are immutable. Execution of ambiguous published sets is rejected.                             |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                              |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Invalid YAML returns syntax errors with line/column. Invalid canonical definitions return structured validation errors by path. Ambiguous invocation returns a conflict-style error. Invalid drafts are allowed only as unsaved client state, never as executable versions.                  |
| 6   | **Failure Modes** | Parse failure, schema drift, compilation failure, and publish conflicts are handled in Runtime. Workflow Engine continues to handle execution-time failures, retries, callbacks, and timeout behavior. Studio keeps last-known-good canonical state when YAML is temporarily invalid.        |
| 7   | **Idempotency**   | Import and publish endpoints should support idempotent behavior by hash/revision checks where practical. Execution remains pinned to immutable versions, so retries of the same version execution are deterministic at the version level even if business steps are not globally idempotent. |
| 8   | **Observability** | Add audit and structured logs for import, export, publish, set-default, and version execution resolution. Existing Workflow Engine observability remains in place, but execution records must include `workflowVersionId` and `workflowVersionNumber`.                                       |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                          |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Visual/YAML sync should feel near-instant. Target local synchronization under 250 ms for typical workflows. Runtime compile/validate on save/publish should remain within interactive design-time latency budgets and not affect execution latency because executable plans are persisted ahead of time. |
| 10  | **Migration Path**     | Existing workflow definitions migrate into versioned storage by creating a baseline version per workflow. Existing execution APIs continue to work, resolving to the default published version after migration.                                                                                          |
| 11  | **Rollback Plan**      | Rollback consists of disabling YAML mode and version-only execution resolution while retaining stored workflow versions. Existing workflow-engine step execution remains largely unchanged, so rollback can stop at the Runtime authoring layer if needed.                                               |
| 12  | **Test Strategy**      | Add unit tests for YAML parse/serialize, canonical schema validation, semantic validation, and compiler logic. Add integration tests for version resolution, import/export, and publish flows. Add E2E tests for Visual <-> YAML synchronization and execution against explicit published versions.      |

## 5. Data Model

### New Collections/Tables

#### `workflow_versions`

Stores immutable workflow versions.

Suggested fields:

- `_id`
- `tenantId`
- `projectId`
- `workflowId`
- `versionNumber`
- `status` (`draft`, `published`, `deprecated`, `archived`)
- `isDefault`
- `sourceFormat`
- `sourceYaml`
- `canonicalDefinition`
- `executablePlan`
- `definitionHash`
- `publishedAt`
- `createdBy`
- `createdAt`
- `updatedAt`

Suggested indexes:

- `{ tenantId: 1, workflowId: 1, versionNumber: -1 }`
- `{ tenantId: 1, workflowId: 1, status: 1 }`
- `{ tenantId: 1, workflowId: 1, isDefault: 1 }`

### Modified Collections/Tables

#### `workflows`

Add stable identity and version pointers:

- `defaultPublishedVersionId`
- `latestDraftVersionId`
- optional high-level metadata duplicated for listing/search

#### `workflow_executions`

Ensure every execution is pinned to a version:

- `workflowVersionId`
- `workflowVersionNumber`

### Key Relationships

```text
Workflow 1:N WorkflowVersion
WorkflowVersion 1:N WorkflowExecution
WorkflowExecution references exactly one immutable version
```

## 6. API Design

### New Endpoints

| Method | Path                                                                             | Purpose                                           | Auth            |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| POST   | `/api/projects/:projectId/workflows/import`                                      | Import YAML as a new workflow draft               | Project write   |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions`                        | List versions for a workflow                      | Project read    |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId`             | Get version detail                                | Project read    |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions`                        | Create new draft version                          | Project write   |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId/publish`     | Publish a version                                 | Project write   |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId/set-default` | Set default published version                     | Project write   |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId/clone`       | Clone version into new draft                      | Project write   |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/import`                 | Import YAML into existing workflow as new version | Project write   |
| GET    | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId/export`      | Export YAML                                       | Project read    |
| POST   | `/api/projects/:projectId/workflows/:workflowId/versions/:versionId/executions`  | Execute explicit version                          | Project execute |

### Modified Endpoints

| Method | Path                                                        | Change                                              |
| ------ | ----------------------------------------------------------- | --------------------------------------------------- |
| POST   | `/api/projects/:projectId/workflows`                        | Create workflow identity plus initial draft version |
| GET    | `/api/projects/:projectId/workflows/:workflowId`            | Return workflow summary plus version pointers       |
| POST   | `/api/projects/:projectId/workflows/:workflowId/executions` | Resolve exact published version before execution    |

### Error Responses

- `WORKFLOW_YAML_PARSE_ERROR`
- `WORKFLOW_SCHEMA_VALIDATION_ERROR`
- `WORKFLOW_SEMANTIC_VALIDATION_ERROR`
- `WORKFLOW_VERSION_NOT_EXECUTABLE`
- `WORKFLOW_VERSION_AMBIGUOUS`
- `WORKFLOW_PUBLISH_CONFLICT`
- `WORKFLOW_IMMUTABLE_VERSION_EDIT`

## 7. Cross-Cutting Concerns

- **Audit Logging**: record import, export, version creation, publish, set-default, execution resolution, and version execution start.
- **Rate Limiting**: apply existing project-level protections to import, publish, and execute endpoints.
- **Caching**: cache compiled executable plans by `workflowVersionId` where helpful, but treat persisted version records as the source of truth.
- **Encryption**: YAML source and canonical definitions follow current workflow data protection rules. Secrets remain external and referenced, not embedded in YAML.

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                   | Type                    | Risk   |
| -------------------------------------------- | ----------------------- | ------ |
| Studio workflow pages and steps UI           | Internal                | Medium |
| Runtime workflow CRUD APIs                   | Internal                | High   |
| Existing workflow-engine step executor model | Internal                | Medium |
| MongoDB workflow/execution persistence       | Internal                | Medium |
| Safe YAML parser library                     | Internal or third-party | Medium |

### Downstream (depends on this feature)

| Consumer           | Impact                                               |
| ------------------ | ---------------------------------------------------- |
| Workflow authors   | Gains visual + YAML authoring and import/export      |
| Workflow operators | Gains version visibility and deterministic execution |
| Workflow Engine    | Executes explicit immutable versions                 |

## 9. Decisions

### 9.1 Draft Execution Policy

Normal execution is limited to published versions only.

Draft versions may be executed only through an explicit preview/test path. This preserves safe and deterministic production behavior while still allowing fast author iteration.

### 9.2 YAML Round-Trip Policy

Phase 1 uses normalized YAML export.

The system will not preserve comments, whitespace, or hand-crafted key ordering during initial round-trip synchronization. YAML remains first-class for hand authoring and import/export, but canonical JSON remains the source of truth.

### 9.3 Import Behavior

Import behavior is:

- if workflow identity is provided, import creates a new version for that workflow
- if workflow identity is absent, import creates a new workflow

This aligns import semantics with immutable versioning and avoids unnecessary workflow duplication.

### 9.4 Published Version Resolution

Phase 1 supports one global default published version per workflow.

Multiple versions may be published simultaneously, but execution by `workflowId` resolves only through:

1. explicit `versionId`
2. default published version
3. rejection if the request is otherwise ambiguous

Channel-scoped or environment-scoped default resolution is deferred to a later phase.

### 9.5 Schema And Compiler Ownership

Canonical workflow schema and canonical-to-executable compilation logic live in a shared package consumed by Studio and Runtime.

Runtime remains responsible for:

- persistence
- import/export endpoints
- publish and default-version resolution
- execution initiation

Workflow Engine remains responsible only for executing explicit executable plans.

### 9.6 Remaining Open Questions

- Draft preview execution should use separate preview endpoints rather than a preview flag on the main execution APIs. This keeps production execution semantics and authorization boundaries clean.
- Normalized YAML export should guarantee stable key ordering to improve Git diffs, review quality, and user trust in round-trip authoring.
- Future default-version resolution should support environment/channel scoping before traffic-based routing. Scoped routing is operationally simpler and better aligned with enterprise rollout patterns.
- What is the migration strategy for existing workflows that already have trigger/deployment relationships?

## 10. References

- Feature spec: `docs/features/workflows.md`
- Existing HLD: `docs/specs/workflows.hld.md`
- Runtime workflow APIs: `apps/runtime/src/routes/workflows.ts`
- Workflow Engine entry: `apps/workflow-engine/src/index.ts`
- Workflow handler: `apps/workflow-engine/src/handlers/workflow-handler.ts`
- Step dispatcher: `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- Workflow model: `packages/database/src/models/workflow.model.ts`
- Workflow execution model: `packages/database/src/models/workflow-execution.model.ts`

---

## Implementation Phases

### Phase 1: Canonical Schema And Version Foundations

**Scope**

- Define unified canonical workflow schema covering all current step types
- Add `workflow_versions` persistence model
- Add workflow/version pointers on workflow identity
- Update execution records to pin version identifiers

**Exit Criteria**

- Canonical schema is the single definition used by Studio, Runtime, and Workflow Engine contracts
- All 12 step types are represented in schema and validation
- Baseline version model exists and can be read/written
- Existing workflow definitions can be migrated into initial versions

### Phase 2: YAML Import/Export And Validation

**Scope**

- Add safe YAML parser/serializer
- Add import/export endpoints
- Add syntax, schema, and semantic validation pipeline
- Support full-fidelity YAML for all workflow fields and step types

**Exit Criteria**

- Workflow YAML imports into canonical definition successfully
- Exported YAML reconstructs the same canonical definition
- Validation errors are returned with actionable path information
- Invalid YAML never becomes executable

### Phase 3: Studio Dual-Mode Authoring And Fast Synchronization

**Scope**

- Add YAML authoring mode to workflow detail experience
- Refactor Steps tab to render canonical model
- Implement fast bidirectional sync between Visual and YAML modes
- Add inline validation feedback

**Exit Criteria**

- Visual edits update YAML within interactive latency targets
- Valid YAML edits update visual editor within interactive latency targets
- Invalid YAML preserves last-known-good canonical model
- All current step types can be authored in either mode

### Phase 4: Publish Semantics, Version Resolution, And Execution

**Scope**

- Add publish, clone, set-default, and version execution endpoints
- Implement deterministic version resolution for `workflowId`-based execution
- Compile canonical definitions into executable plans
- Pass exact version identity into Workflow Engine

**Exit Criteria**

- Multiple published versions can coexist
- Runtime always resolves exactly one executable version or rejects as ambiguous
- Workflow executions are pinned to immutable versions
- Workflow Engine executes explicit executable plans without YAML parsing

### Phase 5: Migration, Testing, And Hardening

**Scope**

- Migrate existing workflows into versioned storage
- Add integration and E2E coverage
- Add audit logging and observability enhancements
- Document operational rollback and migration procedures

**Exit Criteria**

- Existing workflows continue to execute through version resolution
- Import/export, publish/default, and dual-mode sync are covered by automated tests
- Operational playbook exists for rollback and migration
- Remaining open questions are resolved or explicitly deferred
