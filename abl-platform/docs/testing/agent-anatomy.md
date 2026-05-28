# Feature Test Guide: Agent Anatomy

**Feature**: Agent types, AgentIR shape, project agent records, versions, and agent model overrides
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/agent-anatomy.md](../features/agent-anatomy.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-22
**Overall status**: STABLE

---

## Current State (as of 2026-03-22)

Agent anatomy is well covered through project agent route tests, execution-model integration tests, versioning/authz coverage, and Studio list/detail/model-tab tests. The main remaining gaps are around deeper browser coverage for version/topology-heavy interactions and workflow-agent-specific paths.

### Quick Health Dashboard

| Area                        | Status  | Last Verified | Notes                                      |
| --------------------------- | ------- | ------------- | ------------------------------------------ |
| Project agent CRUD/authz    | PASS    | 2026-03-22    | Route coverage exists                      |
| Agent model override        | PASS    | 2026-03-22    | GET/PUT authz and runtime layering covered |
| Execution model integration | PASS    | 2026-03-22    | Runtime execution-model tests present      |
| Version routes              | PASS    | 2026-03-22    | Version authz, promotion, and CRUD covered |
| Studio detail/list pages    | PASS    | 2026-03-22    | UI tests exist                             |
| Browser topology/version UX | PARTIAL | 2026-03-22    | Limited browser-level coverage             |
| IR compilation pipeline     | PASS    | 2026-03-22    | Compiler tests in packages/compiler        |
| Cross-agent validation      | PASS    | 2026-03-22    | Validation tests in packages/compiler      |

---

## Audit Scope

This guide covers project-agent records, versioning, model overrides, runtime execution-model compatibility, IR compilation pipeline, cross-agent validation, behavior profile compilation, and Studio list/detail/model-tab behavior. The main remaining weaknesses are deeper browser-level proof for version-heavy and topology-heavy workflows, and workflow-agent-specific paths.

---

## Coverage Matrix

| FR    | Description                                      | Unit | Integration | E2E | Manual | Status  |
| ----- | ------------------------------------------------ | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Compile ABL to AgentIR stored in versions        | Yes  | Yes         | Yes | N/A    | PASS    |
| FR-2  | Multiple agent types via same IR schema          | Yes  | Yes         | Yes | N/A    | PASS    |
| FR-3  | Persist project_agents, agent_versions, configs  | Yes  | Yes         | Yes | N/A    | PASS    |
| FR-4  | Project-scoped list/detail/model-config/versions | No   | Yes         | Yes | N/A    | PASS    |
| FR-5  | Source hashes and frozen tool snapshots          | Yes  | Yes         | No  | N/A    | PARTIAL |
| FR-6  | Cross-agent validation (refs, fields, mappings)  | Yes  | No          | No  | N/A    | PARTIAL |
| FR-7  | Static graph extraction for visualization        | Yes  | No          | No  | N/A    | PARTIAL |
| FR-8  | Behavior profile compilation and attachment      | Yes  | Yes         | No  | N/A    | PARTIAL |
| FR-9  | Config variable resolution during compilation    | Yes  | No          | No  | N/A    | PARTIAL |
| FR-10 | Compilation timeout enforcement                  | Yes  | No          | No  | N/A    | PARTIAL |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Project Agent CRUD with Tenant Isolation

**Preconditions**: Two tenants (A, B) each with a project containing at least one agent seeded via POST.

**Steps**:

1. `GET /api/projects/:projectIdA/agents` with tenant A auth — expect 200 with agent list
2. `GET /api/projects/:projectIdA/agents/:agentName` with tenant A auth — expect 200 with agent detail including versionCount
3. `GET /api/projects/:projectIdA/agents/:agentName` with tenant B auth — expect 404 (cross-tenant returns 404, not 403)
4. `GET /api/projects/:projectIdA/agents` with no auth — expect 401
5. `PUT /api/projects/:projectIdA/agents/:agentName/dsl` with tenant A auth and valid DSL body — expect 200 with updatedAt

**Expected Result**: Tenant A sees their agents; tenant B gets 404; unauthenticated gets 401; DSL update succeeds with proper authz.

**Auth Context**: tenantId=A, projectId=projectA, userId=userA
**Isolation Check**: Cross-tenant (B accessing A's project) returns 404.

**Test File**: `apps/runtime/src/__tests__/project-agents-authz.test.ts`

---

### E2E-2: Agent Model Config Override Lifecycle

**Preconditions**: Project with an agent and no existing model config.

**Steps**:

1. `GET /api/projects/:projectId/agents/:agentName/model-config` — expect 200 with null/default values
2. `PUT /api/projects/:projectId/agents/:agentName/model-config` with body `{ "defaultModel": "gpt-4o", "temperature": 0.7, "operationModels": { "extraction": "gpt-4o-mini" }, "useStreaming": true }` — expect 200 with updated config
3. `GET /api/projects/:projectId/agents/:agentName/model-config` — expect 200 with the values from step 2
4. `PUT /api/projects/:projectId/agents/:agentName/model-config` with body `{ "defaultModel": null }` — expect 200 (reset to inherit)
5. `GET /api/projects/:projectId/agents/:agentName/model-config` from a different project — expect 404

**Expected Result**: Model config is created on first PUT, readable immediately, updateable idempotently, and isolated by project.

**Auth Context**: tenantId=T, projectId=P, userId=U with project-level permission
**Isolation Check**: Cross-project access returns 404.

**Test File**: `apps/runtime/src/__tests__/agent-model-config-authz.test.ts`

---

### E2E-3: Version Creation and Promotion Flow

**Preconditions**: Project with an agent that has valid ABL DSL content.

**Steps**:

1. `POST /api/projects/:projectId/agents/:agentName/versions` with body `{ "changelog": "Initial version" }` — expect 201 with versionId, version, sourceHash
2. `GET /api/projects/:projectId/agents/:agentName/versions` — expect 200 with array including the created version with status=draft
3. `GET /api/projects/:projectId/agents/:agentName/versions/:version` — expect 200 with full version detail including irContent, dslContent, sourceHash
4. `POST /api/projects/:projectId/agents/:agentName/versions/:version/promote` with body `{ "targetStatus": "testing" }` — expect 200
5. `GET /api/projects/:projectId/agents/:agentName/versions/:version` — expect status=testing with promotedAt and promotedBy set
6. `POST /api/projects/:projectId/agents/:agentName/versions/:version/promote` with body `{ "targetStatus": "active" }` — expect 200

**Expected Result**: Version is created from working copy with compiled IR, status transitions work through the lifecycle, and audit fields are populated.

**Auth Context**: tenantId=T, projectId=P, userId=U with version management permission
**Isolation Check**: Version creation requires project-scoped auth; cross-project version access returns 404.

**Test File**: `apps/runtime/src/__tests__/versions-authz.test.ts`, `apps/runtime/src/__tests__/version-routes.test.ts`

---

### E2E-4: Execution Model Resolution with Agent Override

**Preconditions**: Tenant with default model config, project with LLM config, agent with model override.

**Steps**:

1. Seed tenant default model: `gpt-4o`
2. Seed project LLM config: `gpt-4o-mini`
3. `PUT /api/projects/:projectId/agents/:agentName/model-config` with `{ "defaultModel": "claude-3-opus" }`
4. Trigger agent execution (via chat route or execution-model integration) — verify the effective model is `claude-3-opus` (agent override wins)
5. `PUT /api/projects/:projectId/agents/:agentName/model-config` with `{ "defaultModel": null }` — verify fallback to project `gpt-4o-mini`
6. Verify per-operation overrides: set `operationModels.extraction: "gpt-4o-mini"` and verify extraction uses that model while other operations use default

**Expected Result**: Model layering works as tenant < project < agent, with per-operation granularity.

**Auth Context**: tenantId=T, projectId=P, userId=U
**Isolation Check**: Model config from project B does not affect project A's agents.

**Test File**: `apps/runtime/src/__tests__/execution-model-integration.test.ts`

---

### E2E-5: Version Diff Between Two Versions

**Preconditions**: Agent with at least two versions (different DSL content).

**Steps**:

1. Create version v1 from initial DSL content
2. Update agent DSL content via `PUT /api/projects/:projectId/agents/:agentName/dsl`
3. Create version v2 from updated DSL content
4. `GET /api/projects/:projectId/agents/:agentName/versions/v1/diff/v2` — expect 200 with diff output showing DSL changes
5. `GET /api/projects/:projectId/agents/:agentName/versions/v2/diff/v1` — expect 200 with reverse diff
6. `GET /api/projects/:projectId/agents/:agentName/versions/v1/diff/nonexistent` — expect 404

**Expected Result**: Diff correctly shows DSL content differences between versions; nonexistent version returns 404.

**Auth Context**: tenantId=T, projectId=P, userId=U
**Isolation Check**: Cross-project version diff returns 404.

**Test File**: `apps/runtime/src/__tests__/version-routes.test.ts`

---

### E2E-6: Compilation Error Handling on Version Creation

**Preconditions**: Agent with invalid or malformed ABL DSL content.

**Steps**:

1. `PUT /api/projects/:projectId/agents/:agentName/dsl` with invalid ABL content (syntax error)
2. `POST /api/projects/:projectId/agents/:agentName/versions` — expect error response with structured `CompilationError` diagnostics (agent name, message, type)
3. `PUT /api/projects/:projectId/agents/:agentName/dsl` with valid ABL that has cross-agent reference to nonexistent agent
4. `POST /api/projects/:projectId/agents/:agentName/versions` — expect version created but with compilation warnings about unresolvable references
5. Verify the version's irContent is still valid JSON (compilation succeeded despite warnings)

**Expected Result**: Parse errors prevent version creation with structured error output; validation warnings are captured but do not block version creation.

**Auth Context**: tenantId=T, projectId=P, userId=U
**Isolation Check**: Compilation errors do not leak cross-tenant agent names.

**Test File**: `apps/runtime/src/__tests__/version-routes.test.ts`

---

### E2E-7: Tenant-Scoped Agent Discovery

**Preconditions**: Two tenants with projects and agents.

**Steps**:

1. `GET /api/agents` with tenant A auth — expect 200 with only tenant A's agents
2. `GET /api/agents` with tenant B auth — expect 200 with only tenant B's agents
3. `GET /api/agents/:name` with tenant A auth for a tenant A agent — expect 200
4. `GET /api/agents/:name` with tenant B auth for a tenant A agent — expect 404
5. `GET /api/agents` with no auth — expect 401

**Expected Result**: Agent discovery is strictly tenant-scoped; cross-tenant discovery returns 404.

**Auth Context**: tenantId=A or B
**Isolation Check**: Cross-tenant agent discovery returns 404.

**Test File**: `apps/runtime/src/__tests__/project-agents-authz.test.ts`

---

## Integration Test Scenarios (Minimum 5)

### INT-1: Version Service — Compile and Persist

**Boundary**: VersionService -> Compiler -> MongoDB (agent_versions)

**Setup**: MongoDB instance, valid ABL DSL content, project agent record.

**Steps**:

1. Call `VersionService.createVersion()` with valid DSL content
2. Verify the returned result contains `versionId`, `version`, `sourceHash`
3. Verify `agent_versions` record exists with `irContent` that is valid JSON
4. Parse `irContent` and verify `ir_version: '1.0'` and `metadata.source_hash` matches
5. Verify `toolSnapshot` is populated if project tools exist

**Expected Result**: Version creation compiles ABL to IR, persists immutable record with all required fields.

**Failure Mode**: If compilation fails, no version record is created; structured errors are returned.

**Test File**: `apps/runtime/src/__tests__/version-routes.test.ts`

---

### INT-2: Model Config Layering — Tenant < Project < Agent

**Boundary**: Agent model config route -> project LLM config -> tenant model defaults

**Setup**: Tenant with default model, project with LLM config, agent with model override.

**Steps**:

1. Create tenant model default (e.g., `gpt-4o`)
2. Create project LLM config override (e.g., `gpt-4o-mini`)
3. Create agent model config override (e.g., `claude-3-opus`)
4. Resolve effective model for the agent — should be `claude-3-opus`
5. Delete agent model config — effective model should fall back to `gpt-4o-mini`
6. Delete project LLM config — effective model should fall back to `gpt-4o`

**Expected Result**: Model layering follows most-specific-wins: agent > project > tenant.

**Failure Mode**: If any layer is missing, gracefully falls back to next level.

**Test File**: `apps/runtime/src/__tests__/execution-model-integration.test.ts`

---

### INT-3: IR Validation Orchestrator

**Boundary**: validateIR -> individual validators (flow graph, tool refs, field refs, cross-agent, guardrails, preflight)

**Setup**: Compiled AgentIR instances with various validation scenarios.

**Steps**:

1. Compile a valid flow agent — expect 0 diagnostics
2. Compile a flow agent with unreachable steps — expect flow graph validator to emit diagnostics
3. Compile an agent with tool references to nonexistent tools — expect tool reference diagnostics
4. Compile two agents where agent A hands off to nonexistent agent C — expect cross-agent validation diagnostics
5. Compile an agent with invalid field references in expressions — expect field reference diagnostics

**Expected Result**: Each validator independently catches its class of issues; orchestrator aggregates all diagnostics.

**Failure Mode**: Validators are pure functions; they cannot crash the orchestrator.

**Test File**: Compiler unit tests in `packages/compiler/src/__tests__/`

---

### INT-4: Behavior Profile Compilation and Attachment

**Boundary**: compileBehaviorProfile -> attachProfilesToAgent -> AgentIR

**Setup**: ABL documents containing behavior profiles and agents that reference them.

**Steps**:

1. Compile a behavior profile with instructions, constraints, tools_hide, and gather overrides
2. Compile an agent that references the profile via `USE_PROFILES`
3. Verify the compiled AgentIR has `behavior_profiles` array with the profile attached
4. Verify profile `priority`, `when` (CEL condition), and override sections are preserved
5. Compile an agent referencing a nonexistent profile — expect compilation error

**Expected Result**: Profiles are compiled independently, then attached to referencing agents with all override sections preserved.

**Failure Mode**: Missing profile reference emits a compilation error; agent is still compiled without the profile.

**Test File**: `apps/runtime/src/__tests__/behavior-profile.e2e.test.ts`

---

### INT-5: Version Promotion Lifecycle

**Boundary**: VersionService -> agent_versions status transitions -> project_agents.activeVersions

**Setup**: Agent with a draft version.

**Steps**:

1. Create version (status: draft)
2. Promote to `testing` — verify status updated, `promotedAt` set
3. Promote to `staged` — verify status updated
4. Promote to `active` — verify `project_agents.activeVersions` updated
5. Attempt invalid transition (e.g., `active` -> `draft`) — expect error
6. Deprecate the version — verify status `deprecated`

**Expected Result**: Status transitions follow the valid lifecycle path; invalid transitions are rejected; active promotion updates the parent agent record.

**Failure Mode**: Invalid transitions return error without mutating the record.

**Test File**: `apps/runtime/src/__tests__/versions-authz.test.ts`

---

### INT-6: Static Graph Extraction from Flow Agent

**Boundary**: extractStaticGraph -> FlowConfig -> StaticGraph

**Setup**: Compiled AgentIR for a flow agent with multiple steps, conditional branching, and digressions.

**Steps**:

1. Compile a flow agent with entry step, branching on ON_INPUT, and exit
2. Extract static graph via `extractStaticGraph`
3. Verify node types: `entry`, `step`, `decision`, `exit`
4. Verify edge types: `sequential`, `conditional`, `success`, `failure`
5. Verify unreachable steps are flagged by the graph validator

**Expected Result**: Static graph accurately represents the flow structure for visualization.

**Failure Mode**: Missing entry point or empty flow produces appropriate diagnostics.

**Test File**: Compiler tests in `packages/compiler/src/__tests__/`

---

### INT-7: Tool Snapshot Capture at Version Creation

**Boundary**: VersionService -> project tool resolution -> agent_versions.toolSnapshot

**Setup**: Project with registered tools, agent DSL referencing those tools.

**Steps**:

1. Create project tools (HTTP, MCP types)
2. Create agent DSL that references the project tools
3. Create a version — verify `toolSnapshot` in the version record
4. Verify each snapshot entry has `name`, `projectToolId`, `sourceHash`, `toolType`, `description`, `dslContent`
5. Modify a project tool definition, create a new version — verify snapshot reflects the updated tool

**Expected Result**: Tool snapshots freeze the exact tool definitions at compile time for audit trail.

**Failure Mode**: If project tools are unavailable, compilation proceeds with DSL-only tool definitions (no snapshot).

**Test File**: `apps/runtime/src/__tests__/version-routes.test.ts`

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 404 (project-agents-authz.test.ts)
- [x] Cross-project access returns 404 (agent-model-config-authz.test.ts)
- [ ] Cross-user access returns 404 (for user-owned resources — N/A, agents are project-owned)
- [x] Missing auth returns 401 (project-agents-authz.test.ts)
- [x] Insufficient permissions returns 403 (versions-authz.test.ts)
- [x] Input validation rejects malformed data (agentName validation in routes)

---

## Test Infrastructure

- **Required services**: MongoDB (via MongoMemoryServer for unit/integration, real MongoDB for E2E)
- **Data seeding**: Create tenant, project, agent records via API or direct DB seeding in test setup
- **Environment variables**: Standard runtime env (`MONGODB_URI`, auth config); no agent-anatomy-specific env vars
- **CI configuration**: Tests run via `pnpm --filter runtime test` and `pnpm --filter compiler test`

---

## Test File Mapping

| Test File                                                        | Type        | Covers                          |
| ---------------------------------------------------------------- | ----------- | ------------------------------- |
| `apps/runtime/src/__tests__/project-agents-authz.test.ts`        | integration | FR-3, FR-4 (CRUD, authz)        |
| `apps/runtime/src/__tests__/agent-model-config-authz.test.ts`    | integration | FR-4 (model config)             |
| `apps/runtime/src/__tests__/execution-model-integration.test.ts` | integration | FR-2 (execution model layering) |
| `apps/runtime/src/__tests__/versions-authz.test.ts`              | integration | FR-3, FR-5 (version promotion)  |
| `apps/runtime/src/__tests__/version-routes.test.ts`              | integration | FR-1, FR-5 (version CRUD)       |
| `apps/runtime/src/__tests__/behavior-profile.e2e.test.ts`        | e2e         | FR-8 (behavior profiles)        |
| `apps/studio/src/__tests__/agent-detail-page.test.tsx`           | unit/UI     | FR-4 (Studio detail rendering)  |

---

## Open Testing Questions

1. Should compilation timeout (FR-10) be tested via a dedicated slow-compilation fixture, or is unit-level timeout mock sufficient?
2. Are workflow-agent-specific version routes adequately covered, or do they need dedicated E2E scenarios?
3. Should static graph extraction (FR-7) be covered at the E2E level (via a compile-and-extract API endpoint), or is compiler-level unit coverage sufficient?

---

## Known Gaps

- Version/topology UI is not covered by the same depth of browser automation as the route layer.
- Workflow-agent-specific testing is thinner than the common reasoning/flow paths.
- FR-5 (tool snapshot audit trail) lacks dedicated E2E verification of snapshot content integrity.
- FR-6 (cross-agent validation) and FR-7 (static graph extraction) have unit coverage but no integration/E2E coverage.
- FR-9 (config variable resolution) and FR-10 (compilation timeout) are unit-tested only.

---

## Suggested Commands

```bash
pnpm --filter runtime test -- project-agents
pnpm --filter runtime test -- agent-model-config
pnpm --filter runtime test -- version
pnpm --filter runtime test -- execution-model
pnpm --filter compiler test -- ir
pnpm --filter studio test -- agent-detail
```

---

## References

- Related feature doc: [docs/features/agent-anatomy.md](../features/agent-anatomy.md)
- Compiler IR schema: `packages/compiler/src/platform/ir/schema.ts`
- Version service: `apps/runtime/src/services/version-service.ts`
