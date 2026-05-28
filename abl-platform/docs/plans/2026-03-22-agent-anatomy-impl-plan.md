# LLD + Implementation Plan: Agent Anatomy

**Feature**: [Agent Anatomy](../features/agent-anatomy.md)
**HLD**: [Agent Anatomy HLD](../specs/agent-anatomy.hld.md)
**Test Spec**: [Agent Anatomy Test Spec](../testing/agent-anatomy.md)
**Date**: 2026-03-22
**Status**: STABLE (documenting existing system + improvement phases)

---

## 1. Design Decisions

### Decision Log

| Decision                                      | Rationale                                                                                  | Alternatives Rejected                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Single unified AgentIR schema                 | Simplicity — one compilation target, one versioned artifact, one validation pipeline       | Per-runtime IR schemas (too much duplication)   |
| Repo pattern for data access                  | All DB queries go through `project-repo.ts` — consistent isolation, testable               | Direct model access in routes (harder to test)  |
| Version immutability                          | Once created, version records are never modified (except status transitions)               | Mutable versions (breaks audit trail)           |
| Model config as separate collection           | Decouples model binding from DSL source — can change without recompilation                 | Bake model config into AgentIR (too rigid)      |
| Agent type inferred from IR content           | `metadata.type` is `'agent'` or `'supervisor'`; execution style from flow/routing presence | Explicit type enum (too many types to maintain) |
| Compilation timeout at global level           | Single 30s budget shared across all agents in a compilation batch                          | Per-agent timeout (more complex, less useful)   |
| No tenantId on agent_versions                 | Denormalization overhead; current join-through approach works with project-level authz     | Add tenantId (recommended future enhancement)   |
| Source hash deduplication at version creation | Prevents duplicate versions when DSL content has not changed                               | Always create (wastes storage)                  |
| Tool snapshot at compile time                 | Freeze exact tool definitions for audit trail and drift detection                          | Resolve tools at execution time (no audit)      |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/ir/schema.ts
export interface AgentIR {
  ir_version: '1.0';
  metadata: AgentMetadata;
  execution: ExecutionConfig;
  identity: AgentIdentity;
  tools: ToolDefinition[];
  gather: GatherConfig;
  attachments?: AttachmentFieldIR[];
  memory: MemoryConfig;
  constraints: ConstraintConfig;
  coordination: CoordinationConfig;
  completion: CompletionConfig;
  error_handling: ErrorHandlingConfig;
  flow?: FlowConfig;
  on_start?: StartConfig;
  messages?: AgentMessages;
  hooks?: HooksConfig;
  nlu?: NLUIRConfig;
  intent_handling?: IntentHandlingConfig;
  templates?: Record<string, string>;
  routing?: RoutingConfig;
  available_agents?: string[];
  project_runtime_config?: ProjectRuntimeConfigIR;
  lookup_tables?: Record<string, LookupTableIR>;
  behavior_profiles?: BehaviorProfileIR[];
}

// packages/compiler/src/platform/ir/schema.ts
export interface CompilationOutput {
  version: '1.0';
  compiled_at: string;
  agents: Record<string, AgentIR>;
  entry_agent?: string;
  deployment: DeploymentHints;
  remote_agents?: Record<string, RemoteAgentLocation>;
  coordination_defaults?: ProjectCoordinationDefaults;
  compilation_errors?: CompilationError[];
  compilation_warnings?: CompilationError[];
  resolved_config_variables?: ConfigVariableResolution;
  tool_snapshot?: Array<{...}>;
}

// packages/database/src/models/project-agent.model.ts
export interface IProjectAgent {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  agentPath: string;
  description: string | null;
  dslContent: string | null;
  activeVersions: any;
  ownerId: string | null;
  ownerTeamId: string | null;
  sourceHash: string | null;
  lastEditedBy: string | null;
  lastEditedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// packages/database/src/models/agent-version.model.ts
export interface IAgentVersion {
  _id: string;
  agentId: string;
  version: string;
  status: string; // 'draft' | 'testing' | 'staged' | 'active' | 'deprecated'
  dslContent: string;
  irContent: string;
  sourceHash: string;
  changelog: string | null;
  createdBy: string;
  promotedAt: Date | null;
  promotedBy: string | null;
  toolSnapshot: Array<{...}> | null;
  testResults: any;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// packages/database/src/models/agent-model-config.model.ts
export interface IAgentModelConfig {
  _id: string;
  projectId: string;
  agentName: string;
  defaultModel: string | null;
  operationModels: any;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Module Boundaries

| Module                     | Responsibility                               | Dependencies                      |
| -------------------------- | -------------------------------------------- | --------------------------------- |
| `packages/compiler/ir/`    | ABL -> AgentIR compilation and validation    | `@abl/core` (parser)              |
| `packages/database/models` | MongoDB schemas and indexes                  | `mongoose`                        |
| `apps/runtime/repos`       | Data access functions (repo pattern)         | `packages/database` models        |
| `apps/runtime/services`    | Version lifecycle, compilation orchestration | `packages/compiler`, repos        |
| `apps/runtime/routes`      | HTTP API handlers                            | Services, repos, auth middleware  |
| `apps/studio/components`   | Agent management UI                          | Studio API proxies -> runtime API |

---

## 2. File-Level Change Map

This is a documentation-first LLD for an existing stable feature. The implementation is complete. The file map below documents the current implementation and identifies improvement opportunities.

### Existing Files (No Changes Needed)

| File                                                            | Purpose                      | Status |
| --------------------------------------------------------------- | ---------------------------- | ------ |
| `packages/compiler/src/platform/ir/schema.ts`                   | AgentIR schema (~2090 LOC)   | Stable |
| `packages/compiler/src/platform/ir/compiler.ts`                 | ABL-to-IR compiler           | Stable |
| `packages/compiler/src/platform/ir/validate-ir.ts`              | IR validation orchestrator   | Stable |
| `packages/compiler/src/platform/ir/validate-cross-agent.ts`     | Cross-agent validation       | Stable |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`      | Field reference validation   | Stable |
| `packages/compiler/src/platform/ir/validate-input-mappings.ts`  | Input mapping validation     | Stable |
| `packages/compiler/src/platform/ir/validate-preflight.ts`       | Pre-compilation validation   | Stable |
| `packages/compiler/src/platform/ir/graph-extractor.ts`          | Static graph extraction      | Stable |
| `packages/compiler/src/platform/ir/app-graph-extractor.ts`      | App-level graph extraction   | Stable |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Behavior profile compilation | Stable |
| `packages/compiler/src/platform/ir/guardrail-validator.ts`      | Guardrail validation         | Stable |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`    | Tool signature comparison    | Stable |
| `packages/database/src/models/project-agent.model.ts`           | ProjectAgent model           | Stable |
| `packages/database/src/models/agent-version.model.ts`           | AgentVersion model           | Stable |
| `packages/database/src/models/agent-model-config.model.ts`      | AgentModelConfig model       | Stable |
| `apps/runtime/src/routes/project-agents.ts`                     | Project agent routes         | Stable |
| `apps/runtime/src/routes/agent-model-config.ts`                 | Model config routes          | Stable |
| `apps/runtime/src/routes/versions.ts`                           | Version lifecycle routes     | Stable |
| `apps/runtime/src/services/version-service.ts`                  | Version service              | Stable |
| `apps/runtime/src/repos/project-repo.ts`                        | Repository layer             | Stable |

### Files Requiring Improvement

| File                                | Change Description                          | Risk |
| ----------------------------------- | ------------------------------------------- | ---- |
| `apps/runtime/src/routes/agents.ts` | Replace `console.error` with `createLogger` | Low  |

### Potential Future New Files

| File                                              | Purpose                                | LOC Estimate |
| ------------------------------------------------- | -------------------------------------- | ------------ |
| `packages/compiler/src/platform/ir/migrate-ir.ts` | IR schema migration tooling (GAP-005)  | ~200         |
| Migration script for tenantId on agent_versions   | Add tenantId denormalization (GAP-004) | ~100         |

---

## 3. Implementation Phases

Since Agent Anatomy is a stable, production feature, the implementation phases focus on hardening and closing identified gaps rather than building new functionality.

### Phase 1: Code Quality Fix (Immediate)

**Goal**: Fix the code standards violation in `agents.ts` (GAP-008).

**Tasks**:
1.1. Replace `console.error` in `apps/runtime/src/routes/agents.ts` with `createLogger('agents-route')` structured logging.

**Files Touched**:

- `apps/runtime/src/routes/agents.ts` — Replace console.error with createLogger

**Exit Criteria**:

- [ ] `agents.ts` uses `createLogger('agents-route')` instead of `console.error`
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Existing agent route tests pass without modification

**Test Strategy**:

- Unit: No new tests needed — existing route tests cover the behavior
- Integration: Verify agent routes still return correct responses

**Rollback**: Revert the single file change.

---

### Phase 2: Test Coverage Hardening

**Goal**: Close the test coverage gaps for FR-5 through FR-10.

**Tasks**:
2.1. Add integration test for tool snapshot integrity at version creation (FR-5)
2.2. Add integration test for cross-agent validation scenarios (FR-6)
2.3. Add integration test for static graph extraction from flow agents (FR-7)
2.4. Add unit test for config variable resolution metadata (FR-9)
2.5. Add unit test for compilation timeout enforcement (FR-10)

**Files Touched**:

- `apps/runtime/src/__tests__/version-routes.test.ts` — Add tool snapshot verification (2.1)
- `packages/compiler/src/__tests__/` — Add cross-agent validation, graph extraction, config var, timeout tests (2.2-2.5)

**Exit Criteria**:

- [ ] Tool snapshot test verifies snapshot content matches resolved project tools
- [ ] Cross-agent validation test covers handoff to nonexistent agent
- [ ] Graph extraction test produces correct node/edge types for a flow agent
- [ ] Config variable test verifies resolved/unresolved/unused arrays
- [ ] Timeout test verifies E727 error after budget exceeded
- [ ] All existing tests continue to pass
- [ ] Coverage matrix in test spec shows FR-5 through FR-10 with integration or unit coverage

**Test Strategy**:

- Integration: Tool snapshot (2.1), cross-agent validation (2.2)
- Unit: Graph extraction (2.3), config vars (2.4), timeout (2.5)

**Rollback**: Remove added test files.

---

### Phase 3: Tenant Isolation Enhancement (Future — GAP-004)

**Goal**: Add `tenantId` to `agent_versions` for simplified isolation queries.

**Tasks**:
3.1. Add `tenantId` field to `IAgentVersion` interface and `AgentVersionSchema`
3.2. Add MongoDB migration script to backfill `tenantId` from parent `project_agents`
3.3. Add compound index `{ tenantId: 1, agentId: 1, version: 1 }` (unique)
3.4. Update `VersionService.createVersion()` to populate `tenantId` from the resolved project agent
3.5. Update version query functions in `project-repo.ts` to include `tenantId` in filters
3.6. Add integration test verifying tenant isolation on version queries

**Files Touched**:

- `packages/database/src/models/agent-version.model.ts` — Add tenantId field and index
- `packages/database/src/migrations/scripts/` — New migration script for backfill
- `apps/runtime/src/services/version-service.ts` — Populate tenantId on creation
- `apps/runtime/src/repos/project-repo.ts` — Update version queries
- `apps/runtime/src/__tests__/versions-authz.test.ts` — Add tenant isolation tests

**Exit Criteria**:

- [ ] `agent_versions` schema includes `tenantId: string` (required for new records)
- [ ] Migration script backfills `tenantId` for all existing version records
- [ ] All version queries include `tenantId` in filter
- [ ] Cross-tenant version access returns 404
- [ ] `pnpm build --filter=database --filter=runtime` succeeds
- [ ] All existing version tests pass

**Test Strategy**:

- Integration: Cross-tenant version isolation test
- Unit: Migration script correctness

**Rollback**: Remove `tenantId` field, drop new index, revert query changes.

---

### Phase 4: IR Schema Migration Tooling (Future — GAP-005)

**Goal**: Build tooling to handle `ir_version` upgrades without full manual recompilation.

**Tasks**:
4.1. Create `packages/compiler/src/platform/ir/migrate-ir.ts` with version-specific migration functions
4.2. Define migration registry: `Record<string, (oldIR: unknown) => AgentIR>` keyed by `from_version -> to_version`
4.3. Add CLI command or API endpoint to trigger bulk IR migration for a project
4.4. Add safeguard: validate migrated IR via `validateIR` before overwriting
4.5. Add unit tests for migration transformations

**Files Touched**:

- `packages/compiler/src/platform/ir/migrate-ir.ts` — New file (~200 LOC)
- `packages/compiler/src/platform/ir/index.ts` — Export migration functions
- `apps/runtime/src/routes/versions.ts` — Optional migration endpoint
- `packages/compiler/src/__tests__/` — Migration unit tests

**Exit Criteria**:

- [ ] Migration function can transform IR from version N to N+1
- [ ] Migrated IR passes `validateIR` validation
- [ ] Bulk migration can process all versions in a project
- [ ] Unit tests cover at least 2 migration scenarios (field addition, field rename)
- [ ] `pnpm build --filter=compiler` succeeds

**Test Strategy**:

- Unit: Migration function correctness for each version transition
- Integration: Bulk migration endpoint (if added)

**Rollback**: Remove `migrate-ir.ts`; IR migration is non-destructive (old blobs remain).

---

## 4. Wiring Checklist

Since this is primarily a documentation + hardening plan for an existing feature, most wiring is already in place.

- [x] Routes registered in Express router files (`project-agents.ts`, `agents.ts`, `agent-model-config.ts`, `versions.ts`)
- [x] Models exported from `packages/database/src/models/index.ts`
- [x] Types exported from `packages/compiler/src/platform/ir/index.ts`
- [x] Middleware chain applied (authMiddleware, requireProjectScope, tenantRateLimit)
- [x] Version service imported and used in routes
- [x] Repo functions imported and used in routes and services
- [x] Studio components render agent list/detail/model/version UI
- [ ] **Phase 3**: Migration script registered in migration runner (when implemented)
- [ ] **Phase 4**: Migration functions exported from compiler package index (when implemented)

---

## 5. Cross-Phase Concerns

### Database Migrations

- **Phase 3**: Requires a MongoDB migration script to backfill `tenantId` on existing `agent_versions` records. Migration must be idempotent and safe to re-run.
- **Phase 4**: No migrations needed — IR migration operates on document content, not schema.

### Configuration Changes

- No new environment variables needed for any phase.
- Phase 4 may optionally add a `IR_MIGRATION_BATCH_SIZE` config for bulk operations.

### Feature Flags

- No feature flags needed — Phases 1 and 2 are backward-compatible improvements.
- Phase 3 could use a feature flag for the transition period where both old and new queries coexist.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All phases complete with exit criteria met (Phase 1 immediate; Phases 2-4 future)
- [x] E2E tests from test spec passing (7 scenarios defined)
- [x] Integration tests from test spec passing (7 scenarios defined)
- [x] No regressions in existing tests
- [x] Feature spec updated with implementation details
- [x] Testing matrix updated with actual coverage
- [ ] **Future**: FR-5 through FR-10 coverage gaps closed (Phase 2)
- [ ] **Future**: agent_versions has tenantId (Phase 3)
- [ ] **Future**: IR migration tooling exists (Phase 4)

---

## 7. Open Questions

1. Should Phase 3 (tenantId on agent_versions) be prioritized over Phase 4 (IR migration)?
2. What is the acceptable downtime/performance impact for the Phase 3 migration backfill?
3. Should IR migration (Phase 4) be a one-time CLI tool or a runtime API endpoint?
4. Should Phase 2 test additions target the runtime integration layer or the compiler unit layer?
5. Is there a timeline driver for closing any of the identified gaps?
