# HLD: Agent Anatomy

**Feature**: [Agent Anatomy](../features/agent-anatomy.md)
**Status**: STABLE (documenting existing architecture)
**Date**: 2026-03-22
**Author**: Platform team

---

## 1. Problem Statement

The platform needs a stable, framework-agnostic runtime representation of an agent after authoring so that execution engines, version management, deployment promotion, model binding, and operator inspection do not depend on raw ABL source parsing at request time. Without this contract:

- Every runtime (voice, digital, workflow, orchestration) would need its own ABL parser
- Versioned execution would be impossible — there would be no immutable artifact to snapshot
- Model binding and configuration overlays would have no stable target to attach to
- Operator inspection and topology visualization would require live compilation on every view

The Agent Anatomy feature solves this by defining the `AgentIR` — a compiled JSON representation that all runtimes consume uniformly — plus the storage, versioning, and configuration layers around it.

---

## 2. Alternatives Considered

### Alternative A: Direct DSL Interpretation at Runtime

**Description**: Each runtime interprets raw ABL source directly, with no intermediate representation.

**Pros**:

- No compilation step; changes take effect immediately
- Simpler pipeline (no compiler maintenance)

**Cons**:

- Every runtime needs an ABL parser (voice, digital, workflow, SDK)
- No stable versioned artifact for promotion or rollback
- No compile-time validation — errors discovered at execution time
- Performance overhead of parsing on every request

**Effort**: L (would require parser in every runtime)

### Alternative B: Compiled IR with Separate Per-Runtime Schemas

**Description**: Compile ABL to IR but produce different schemas for voice, digital, and workflow runtimes.

**Pros**:

- Each runtime gets an optimized, minimal representation
- Could reduce per-runtime deserialization overhead

**Cons**:

- Multiple compilation targets to maintain and keep in sync
- Version snapshots would need multiple IR blobs per version
- Cross-runtime features (handoffs between voice and digital) become harder
- Tool definitions and constraints would be duplicated across schemas

**Effort**: L (significant compiler and storage complexity)

### Alternative C: Single Unified AgentIR (Current Design)

**Description**: Compile ABL to a single framework-agnostic `AgentIR` JSON structure consumed by all runtimes. Runtime-specific optimizations happen at execution time via hints and conditional sections.

**Pros**:

- One compilation target, one versioned artifact, one validation pipeline
- Cross-runtime features work naturally (same IR, same coordination model)
- Runtime hints (`voice_optimized`, `runtime_recommendations`) enable per-runtime optimization without schema duplication
- Simpler storage: one `irContent` field per version

**Cons**:

- IR includes sections irrelevant to some runtimes (e.g., voice config in digital-only agents)
- Single schema must accommodate all agent types, leading to many optional sections

**Effort**: M (current implementation — already built)

### Recommendation

**Alternative C (Single Unified AgentIR)** is the current and recommended design. The trade-off of optional sections is minor compared to the simplicity of a single compilation target, single versioned artifact, and unified cross-runtime execution model. Runtime hints and conditional sections provide sufficient per-runtime optimization.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        ABL Authoring                        │
│  (Studio Editor / CLI / Import)                             │
│                                                             │
│  Produces: AgentBasedDocument (AST) via @abl/core parser    │
└───────────────────────┬─────────────────────────────────────┘
                        │ ABL source text
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    ABL Compiler                              │
│  packages/compiler/src/platform/ir/compiler.ts              │
│                                                             │
│  Stages: parse → separate profiles → compile profiles →    │
│          compile agents → attach profiles → merge tools →   │
│          validate → extract graph → hash → package          │
│                                                             │
│  Produces: CompilationOutput { agents: Record<str, AgentIR>,│
│            entry_agent, deployment, errors, warnings,       │
│            tool_snapshot, config_variable_resolution }       │
└───────────────────────┬─────────────────────────────────────┘
                        │ AgentIR (JSON)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    Storage Layer                             │
│  packages/database/src/models/                              │
│                                                             │
│  project_agents    → working copy (ABL source + metadata)   │
│  agent_versions    → immutable snapshots (DSL + IR + tools) │
│  agent_model_configs → per-agent model overrides            │
└───────────────────────┬─────────────────────────────────────┘
                        │ resolved artifact + config overlays
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    Runtime Execution                         │
│  apps/runtime/src/services/                                 │
│                                                             │
│  Resolves: agent artifact → applies model layering →        │
│            constructs execution context → dispatches to     │
│            reasoning/flow/supervisor/workflow executor       │
│                                                             │
│  Consumers: Digital, Voice, Workflow, SDK, A2A runtimes     │
└─────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                 packages/compiler                        │
│                                                         │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │  compiler.ts  │  │ validate-ir.ts│  │graph-extractor│ │
│  │ compileABLtoIR│  │ validateIR()  │  │extractStatic │ │
│  │ compileAgent  │  │  orchestrator │  │  Graph()     │ │
│  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘ │
│         │                  │                  │         │
│  ┌──────┴───────┐  ┌──────┴────────┐  ┌─────┴───────┐ │
│  │schema.ts     │  │validate-cross-│  │app-graph-   │ │
│  │AgentIR types │  │agent.ts       │  │extractor.ts │ │
│  │~2090 lines   │  │validate-field-│  │AppStaticGraph│ │
│  └──────────────┘  │refs.ts        │  └─────────────┘ │
│                    │validate-input-│                   │
│  ┌──────────────┐  │mappings.ts    │  ┌─────────────┐ │
│  │compile-      │  │validate-      │  │guardrail-   │ │
│  │behavior-     │  │preflight.ts   │  │validator.ts │ │
│  │profile.ts    │  └───────────────┘  │tool-schema- │ │
│  └──────────────┘                     │validator.ts │ │
│                                       └─────────────┘ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 packages/database                        │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │project-agent     │  │agent-version     │            │
│  │.model.ts         │  │.model.ts         │            │
│  │IProjectAgent     │  │IAgentVersion     │            │
│  │tenantId+projectId│  │agentId (FK)      │            │
│  └──────────────────┘  └──────────────────┘            │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │agent-model-config│  │agent-lock        │            │
│  │.model.ts         │  │.model.ts         │            │
│  │projectId+agentNm │  │(compilation lock)│            │
│  └──────────────────┘  └──────────────────┘            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 apps/runtime                             │
│                                                         │
│  Routes:                    Services:                   │
│  ┌──────────────────┐      ┌──────────────────┐        │
│  │project-agents.ts │      │version-service.ts│        │
│  │agents.ts         │      │workflow-version- │        │
│  │agent-model-      │      │service.ts        │        │
│  │config.ts         │      │settings-version- │        │
│  │versions.ts       │      │service.ts        │        │
│  │workflow-          │      │audit-helpers.ts  │        │
│  │versions.ts       │      └──────────────────┘        │
│  └──────────────────┘                                   │
│                                                         │
│  Repos:                                                 │
│  ┌──────────────────┐                                   │
│  │project-repo.ts   │                                   │
│  │(findProjectAgent,│                                   │
│  │ findAgentVersion,│                                   │
│  │ upsertModelConfig│                                   │
│  │ etc.)            │                                   │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

**Version Creation Flow**:

1. Studio user saves ABL source -> `PUT /api/projects/:projectId/agents/:agentName/dsl` -> updates `project_agents.dslContent` and `sourceHash`
2. User requests version creation -> `POST /api/projects/:projectId/agents/:agentName/versions`
3. `VersionService.createVersion()` is called:
   a. Reads `project_agents.dslContent`
   b. Parses ABL via `@abl/core` -> `AgentBasedDocument[]`
   c. Compiles via `compileABLtoIR()` -> `CompilationOutput`
   d. Extracts tool snapshot from resolved project tools
   e. Computes source hash for deduplication
   f. Creates `agent_versions` record with frozen `dslContent`, `irContent`, `sourceHash`, `toolSnapshot`
4. Response includes `versionId`, `version`, `sourceHash`, any compilation warnings

**Agent Resolution Flow**:

1. Execution request arrives (chat, voice, SDK)
2. Runtime resolves agent by project/name, loads `project_agents` or `agent_versions` artifact
3. Applies model layering: tenant defaults -> project LLM config -> `agent_model_configs`
4. Constructs execution context from resolved IR + effective model config
5. Dispatches to appropriate executor (reasoning, flow, supervisor, workflow)

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

- `project_agents` has compound unique index `{ tenantId, projectId, name }` — every query includes `tenantId`
- `agent_versions` has NO `tenantId` — isolation depends on joining through `agentId` -> `project_agents._id` -> `project_agents.tenantId`. This is a known gap (GAP-004).
- `agent_model_configs` has NO `tenantId` — project-scoped only (`{ projectId, agentName }` unique index), relying on project-level authz for tenant isolation (GAP-007, by design).
- Route-level enforcement: `authMiddleware` + `requireProjectScope('projectId')` on all project-scoped routes.
- Cross-tenant access returns 404 (not 403) to avoid leaking resource existence.

#### 2. Data Access Pattern

- **Repository layer**: `apps/runtime/src/repos/project-repo.ts` provides all data access functions (`findProjectAgentsForProject`, `findProjectAgentForProject`, `findAgentVersion`, `findAgentModelConfig`, `upsertAgentModelConfig`, etc.).
- **No direct model access** in route handlers — all queries go through the repo layer.
- **No caching layer** for agent metadata (read-heavy, index-backed, relatively small dataset).
- **Optimistic concurrency** via `_v` field on all models (not currently enforced at application level).

#### 3. API Contract

- **Request/response shapes**: All routes use Zod schemas for validation and OpenAPI generation via `createOpenAPIRouter`.
- **Error envelope**: `{ success: false, error: string }` for errors; `{ success: true, data... }` for success.
- **Versioning**: No API versioning — routes are path-versioned implicitly (e.g., `/api/projects/:projectId/agents`).
- **Content types**: JSON for all API responses; `irContent` is a JSON string within the version record.

#### 4. Security Surface

- **Auth**: `authMiddleware` (via `createUnifiedAuthMiddleware`) on all routes.
- **Project scope**: `requireProjectScope('projectId')` validates the JWT project claim matches the URL param.
- **Permission checks**: `requireProjectPermission(req, res, 'obj:op')` on write operations (version creation, model config update).
- **Input validation**: Zod schemas validate all request params and bodies; `validateAgentName()` validates agent name format.
- **Encrypted credentials**: Tool bindings may contain `encrypted_env`, `encrypted_auth_config` — decrypted only at execution time, never exposed in API responses.
- **SSRF prevention**: Not directly applicable (no user-provided URLs in agent anatomy routes).

### Behavioral Concerns

#### 5. Error Model

- **Compilation errors**: Structured `CompilationError[]` with agent name, message, type (parse/compilation/validation), severity.
- **Version creation failure**: Returns error response with compilation diagnostics; no version record created.
- **Route errors**: Consistent error envelope `{ success: false, error: string }` with appropriate HTTP status codes.
- **Validation warnings**: Captured in `compilation_warnings` but do not block version creation.
- **User experience**: Studio surfaces compilation errors in the editor; version creation failure shows structured diagnostics.

#### 6. Failure Modes

- **Database unavailable**: Routes check `isDatabaseAvailable()` and return 503.
- **Compilation timeout**: 30s default; E727 error emitted, compilation halted for remaining agents.
- **Invalid ABL**: Parse errors produce `CompilationError` with type='parse'; agents that fail are omitted from output.
- **Missing project tools**: Compilation proceeds with DSL-only tool definitions; no tool snapshot captured.
- **Partial compilation**: If one agent in a multi-agent project fails, others still compile successfully.

#### 7. Idempotency

- **Version creation**: Source hash deduplication — if DSL content has not changed, a duplicate version is flagged.
- **Model config upsert**: MongoDB `findOneAndUpdate` with `upsert: true` — safe to retry.
- **DSL save**: `PUT` is idempotent — saving the same content produces the same state.
- **Version promotion**: Status transitions are validated — promoting to the same status is a no-op or error depending on implementation.

#### 8. Observability

- **Structured logging**: `createLogger('module-name')` used in routes and services (except GAP-008 in `agents.ts`).
- **Compilation diagnostics**: `CompilationError[]` and `CompilationWarning[]` arrays in output.
- **Config variable metadata**: `resolved`, `unresolved`, `unused` arrays in compilation output.
- **Audit events**: `auditDslUpdated`, `auditVersionCreated`, `auditVersionPromoted`, `auditVersionDeprecated` emit structured audit events.
- **Tool staleness warnings**: W721 warnings when DSL tool signatures drift from project tool definitions.

### Operational Concerns

#### 9. Performance Budget

- **Agent listing**: < 100ms (index-backed query on `{ tenantId, projectId }`).
- **Agent detail**: < 150ms (single document lookup by compound key).
- **Version creation**: < 35s (bounded by compilation timeout of 30s + overhead).
- **Model config GET/PUT**: < 50ms (single document upsert on unique index).
- **IR payload size**: Typically 10-100KB per agent; stored as JSON string, no secondary indexes on content.
- **Compilation**: O(n) in number of agents; timeout prevents runaway compilation.

#### 10. Migration Path

- **Current state**: All three collections (`project_agents`, `agent_versions`, `agent_model_configs`) are in production with stable schemas.
- **IR version**: Fixed at `'1.0'` — no migration tooling exists for IR schema changes (GAP-005).
- **Forward compatibility**: New optional sections can be added to `AgentIR` without breaking existing consumers (they ignore unknown fields).
- **Breaking changes**: Would require a new `ir_version` value and recompilation of all stored versions.

#### 11. Rollback Plan

- **Version rollback**: Promote a previous version back to `active` status; working copy is unaffected.
- **DSL rollback**: Version records preserve frozen `dslContent`; restore by writing the old DSL back.
- **Model config rollback**: No history — upsert overwrites. Consider adding versioning to model configs.
- **Schema rollback**: MongoDB collections have no enforced schema validation — additive changes are safe.

#### 12. Test Strategy

- **Unit tests**: Compiler IR schema, validation, graph extraction — run via `pnpm --filter compiler test`.
- **Integration tests**: Route-level authz, version lifecycle, model config layering — run via `pnpm --filter runtime test`.
- **E2E tests**: Full HTTP API flows with real auth middleware — 7 scenarios defined in test spec.
- **Coverage target**: All 10 FRs have at least unit coverage; 4 FRs (FR-1 through FR-4) have full E2E coverage.
- **Split**: ~60% unit (compiler), ~30% integration (runtime routes), ~10% E2E (full HTTP flows).

---

## 5. Data Model

No new collections are needed — the existing schema is stable and well-indexed.

### Existing Collections

- **`project_agents`**: Working copy storage with `{ tenantId, projectId, name }` unique compound index. See feature spec section 9 for full schema.
- **`agent_versions`**: Immutable version snapshots with `{ agentId, version }` unique compound index. Lacks `tenantId` (GAP-004).
- **`agent_model_configs`**: Per-agent model overrides with `{ projectId, agentName }` unique compound index. Lacks `tenantId` (GAP-007).

### Potential Schema Enhancement

Adding `tenantId` to `agent_versions` would:

- Simplify tenant-scoped queries (no join through `project_agents`)
- Enable direct tenant-level version auditing
- Add a denormalized field that must be kept in sync with `project_agents.tenantId`

This is a future consideration (GAP-004), not a current requirement.

---

## 6. API Design

All existing endpoints are stable and documented in the feature spec section 8.

### Key Design Patterns

- **OpenAPI generation**: All routes use `createOpenAPIRouter` with Zod schemas, generating machine-readable API specs.
- **Middleware chain**: `authMiddleware` -> `requireProjectScope` -> `tenantRateLimit` on all routes.
- **Agent name validation**: `validateAgentName()` from `@agent-platform/shared-kernel` validates format before route handler execution.
- **Error responses**: `{ success: false, error: string }` with HTTP 400/401/403/404/500 as appropriate.

### No New Endpoints Required

The current API surface covers all functional requirements. Future enhancements (IR migration, compilation timeout configuration) would add optional parameters to existing endpoints rather than new routes.

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Version creation, promotion, deprecation, and DSL updates are audited via `auditDslUpdated`, `auditVersionCreated`, `auditVersionPromoted`, `auditVersionDeprecated` in `apps/runtime/src/services/audit-helpers.ts`.
- Audit events include user ID, timestamp, project context, and action details.

### Rate Limiting

- All routes use `tenantRateLimit('request')` — standard tenant-scoped rate limiting.
- No agent-anatomy-specific rate limit configuration.

### Caching

- No explicit caching layer for agent metadata or version records.
- `Cache-Control: private, max-age=300` set on agent detail responses in `agents.ts`.
- Source hash comparison enables skip-compilation when DSL content has not changed.

### Encryption

- Tool bindings may contain encrypted credentials (`encrypted_env`, `encrypted_auth_config`) stored in IR.
- Encryption/decryption happens at execution time, not at storage time.
- IR content is stored as plain JSON string — no at-rest encryption beyond MongoDB's disk-level encryption.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency         | Risk   | Notes                                                         |
| ------------------ | ------ | ------------------------------------------------------------- |
| `@abl/core` parser | Low    | Stable parser; changes are additive (new AST node types)      |
| MongoDB            | Low    | Standard infrastructure; no exotic features used              |
| Auth middleware    | Low    | Shared infrastructure; well-tested                            |
| Project tools      | Medium | Tool resolution at compile time can fail if tools are deleted |
| Encryption service | Low    | Only needed at execution time, not at storage time            |

### Downstream (depends on this feature)

| Consumer                    | Impact | Notes                                                            |
| --------------------------- | ------ | ---------------------------------------------------------------- |
| Runtime execution engines   | High   | All executors consume AgentIR as their primary input             |
| Deployment/promotion system | High   | Version records are the unit of deployment                       |
| Studio agent management UI  | Medium | Agent list, detail, version, model tab all consume API responses |
| Topology visualization      | Medium | Static graph extraction feeds the topology/mini-map views        |
| A2A/SDK runtimes            | Medium | Consume the same AgentIR artifact as digital runtime             |

---

## 9. Open Questions & Decisions Needed

1. **tenantId on agent_versions**: Should we denormalize `tenantId` onto `agent_versions` for query simplicity, accepting the sync overhead?
2. **IR schema migration**: When `ir_version` needs to change, should we build migration tooling or require full recompilation?
3. **Model config versioning**: Should `agent_model_configs` have a history/audit trail, or is the current upsert-overwrites behavior sufficient?
4. **Compilation timeout granularity**: Should per-agent timeout configuration be supported, or is the global 30s budget sufficient?
5. **Optimistic concurrency enforcement**: The `_v` field exists on all models but is not enforced at the application level — should it be?

---

## 10. References

- Feature spec: [docs/features/agent-anatomy.md](../features/agent-anatomy.md)
- Test spec: [docs/testing/agent-anatomy.md](../testing/agent-anatomy.md)
- IR schema: `packages/compiler/src/platform/ir/schema.ts`
- Compiler: `packages/compiler/src/platform/ir/compiler.ts`
- Version service: `apps/runtime/src/services/version-service.ts`
- Project agent model: `packages/database/src/models/project-agent.model.ts`
- Agent version model: `packages/database/src/models/agent-version.model.ts`
- Agent model config model: `packages/database/src/models/agent-model-config.model.ts`
