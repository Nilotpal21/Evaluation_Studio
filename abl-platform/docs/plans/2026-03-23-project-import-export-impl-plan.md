# LLD + Implementation Plan: Project Import/Export

> **Feature:** #47 Project Import/Export
> **Package:** `@agent-platform/project-io`
> **Date:** 2026-03-23
> **Status:** PLANNED
> **Depends On:** Feature Spec, Test Spec, HLD

---

## Executive Summary

The `@agent-platform/project-io` package is a mature implementation (~38K LOC, 60 unit test files, all passing). The core export/import/git/ownership logic is complete at the library level. This plan addresses the **gap closure** work needed to bring the feature from ALPHA to BETA:

1. **Route v2 upgrade**: Wire v2 layered export/import into the REST API
2. **E2E test suite**: 12 real HTTP tests (no mocks)
3. **Integration test suite**: 10 cross-module tests
4. **Observability**: TraceEvent emission for import/export
5. **Audit logging**: Integration with the audit-logging pipeline
6. **Studio UI hooks**: API client functions for future UI integration

---

## Phase 1: Route v2 Wiring + Import DB Adapter

**Goal:** Upgrade the REST API from v1-only orchestrators to v2 layered model with staged import.

**Duration:** 3-5 days
**Risk:** MEDIUM (requires careful backward compatibility)

### Tasks

#### 1.1 Create ImportDbAdapter Implementation

**File:** `apps/runtime/src/services/project-io/import-db-adapter.ts`

Implement the `ImportDbAdapter` interface from `@agent-platform/project-io/import` using real Mongoose models:

```typescript
import type {
  ImportDbAdapter,
  StagedRecord,
  SupersededRecord,
} from '@agent-platform/project-io/import';

export class MongoImportDbAdapter implements ImportDbAdapter {
  async createImportOperation(params) {
    /* MongoDB insert */
  }
  async updateImportPhase(operationId, phase) {
    /* MongoDB update */
  }
  async stageRecords(records: StagedRecord[]) {
    /* insertMany with status: 'staged' */
  }
  async activateLayer(operationId, layer) {
    /* atomic status swap */
  }
  async rollbackLayer(operationId, layer) {
    /* reverse status swap */
  }
  async cleanupSuperseded(records: SupersededRecord[]) {
    /* deleteMany */
  }
}
```

**Key design decisions:**

- Use `bulkWrite` for atomic status swaps (staged -> active, active -> superseded)
- Include `tenantId` and `projectId` in every query
- Log each phase transition with `createLogger('import-db-adapter')`

#### 1.2 Create PostImportDbAdapter Implementation

**File:** `apps/runtime/src/services/project-io/post-import-db-adapter.ts`

Implement the `PostImportDbAdapter` interface using real Mongoose models to query env vars, connectors, MCP servers, guardrail providers, and auth profiles.

#### 1.3 Add v2 Export Endpoint

**File:** `apps/runtime/src/routes/project-io.ts`

Add a new `GET /export/v2` route (or add `version=2` query parameter to existing export) that:

- Accepts `layers` query parameter (comma-separated LayerName values)
- Instantiates layer assemblers from a factory
- Calls `exportProjectV2()` with assemblers
- Returns v2 manifest and lockfile

**Backward compatibility:** The existing `GET /export` endpoint remains unchanged (v1). Consumers opt into v2 explicitly.

#### 1.4 Add v2 Import Endpoint

**File:** `apps/runtime/src/routes/project-io.ts`

Add a new `POST /import/v2` route (or add `version=2` query parameter) that:

- Accepts `layers`, `conflictStrategy`, `authProfileMapping` in request body
- Uses `StagedImporter` with `MongoImportDbAdapter`
- Returns v2 result with `postImportReport`

#### 1.5 Create Layer Assembler Factory

**File:** `apps/runtime/src/services/project-io/layer-assembler-factory.ts`

Factory function that creates `Map<LayerName, LayerAssembler>` from the 8 assembler implementations. Each assembler is injected with Mongoose models for querying.

### Exit Criteria

- [ ] `GET /export?version=2&layers=core,connections,guardrails` returns v2 manifest with `format_version: '2.0'`
- [ ] `POST /import?version=2` with staged import applies changes with rollback on failure
- [ ] Existing v1 endpoints remain unchanged (backward compatible)
- [ ] `pnpm build --filter=runtime` passes with no type errors
- [ ] `pnpm test --filter=runtime` passes (all existing tests)

---

## Phase 2: E2E Test Suite

**Goal:** Implement the 12 E2E scenarios from the test spec, exercising real HTTP API with real MongoDB and Redis.

**Duration:** 3-5 days
**Risk:** MEDIUM (test infrastructure setup)

### Tasks

#### 2.1 Test Infrastructure Setup

**File:** `apps/runtime/src/__tests__/e2e/project-io-e2e.test.ts`

Create test harness:

- Start Runtime Express server on random port (`{ port: 0 }`)
- Start MongoMemoryServer (shared across suite)
- Start Redis (real or ioredis-mock with SET NX PX support)
- Generate test JWT tokens with configurable tenantId, userId, and project roles
- Create helper functions: `createTestProject()`, `createTestAgent()`, `createTestTool()`

#### 2.2 Implement E2E Scenarios 1-4 (Happy Paths)

- E2E-1: Export preview with 3 agents + 2 tools
- E2E-2: Full export with manifest + lockfile verification
- E2E-3: Import preview with diff calculation
- E2E-4: Import apply with create/update/delete verification

#### 2.3 Implement E2E Scenarios 5-8 (Security + Guards)

- E2E-5: Concurrent import protection (two simultaneous imports)
- E2E-6: Tenant isolation (cross-tenant access returns 404)
- E2E-7: RBAC enforcement (viewer cannot import)
- E2E-8: Size guard enforcement (1001 agents rejected)

#### 2.4 Implement E2E Scenarios 9-12 (Edge Cases)

- E2E-9: Path traversal rejection
- E2E-10: Malformed JSON rejection
- E2E-11: Export-import roundtrip
- E2E-12: Empty files rejection

### Exit Criteria

- [ ] All 12 E2E tests pass
- [ ] No `vi.mock()` or `jest.mock()` in any E2E test file
- [ ] No direct DB model access (only HTTP API)
- [ ] Tests use real Express server with full middleware chain
- [ ] Concurrent import test is deterministic (not flaky)
- [ ] Test suite completes in < 60 seconds

---

## Phase 3: Integration Test Suite

**Goal:** Implement the 10 integration scenarios from the test spec, testing cross-module interactions within the package.

**Duration:** 2-3 days
**Risk:** LOW (pure library tests, no infrastructure)

### Tasks

#### 3.1 Multi-Layer Roundtrip Tests

**File:** `packages/project-io/src/__tests__/integration/import-export-integration.test.ts`

- INT-1: Export v2 multi-layer roundtrip
- INT-5: v1-to-v2 migration through full pipeline
- INT-6: Lockfile integrity verification (tamper detection)

#### 3.2 Import Safety Tests

- INT-2: Staged import with rollback (in-memory adapter, simulated failure)
- INT-3: Cross-layer dependency detection (missing tool reference)
- INT-4: Auth profile mapping resolution

#### 3.3 Cross-Module Tests

- INT-7: Git sync export-push-pull-import roundtrip (in-memory provider)
- INT-8: Circular dependency detection with handoffs
- INT-9: Post-import validation report
- INT-10: Export performance benchmark (100 agents)

### Exit Criteria

- [ ] All 10 integration tests pass
- [ ] No mocking of codebase components (only in-memory adapters for DB)
- [ ] INT-10 benchmark completes in < 5 seconds
- [ ] `pnpm test --filter=@agent-platform/project-io` passes (all 60+ unit tests + new integration tests)

---

## Phase 4: Observability + Audit Integration

**Goal:** Emit TraceEvents and audit log entries for import/export operations.

**Duration:** 2-3 days
**Risk:** LOW (additive, no breaking changes)

### Tasks

#### 4.1 TraceEvent Emission for Export

**File:** `apps/runtime/src/routes/project-io.ts`

Add TraceEvent emission at export start and completion:

```typescript
traceStore.emit({
  type: 'project.export',
  projectId,
  tenantId,
  userId,
  metadata: { agentCount, toolCount, fileCount, format, responseSizeBytes },
  timestamp: Date.now(),
});
```

#### 4.2 TraceEvent Emission for Import

Add TraceEvent emission at import preview, import start, import completion, and import failure:

```typescript
traceStore.emit({
  type: 'project.import',
  projectId,
  tenantId,
  userId,
  metadata: { fileCount, created, updated, deleted, phase },
  timestamp: Date.now(),
});
```

#### 4.3 Audit Log Integration

Emit audit log entries for successful import operations (create/update/delete counts) using the platform audit logging pipeline.

#### 4.4 Export Size Monitoring

Add a warning-level log when export response size exceeds 50MB (50% of the 100MB limit) to enable proactive monitoring.

### Exit Criteria

- [ ] Export emits `project.export` TraceEvent with metadata
- [ ] Import emits `project.import` TraceEvent with metadata
- [ ] Failed imports emit error TraceEvent with failure context
- [ ] Audit log entries created for successful imports
- [ ] No new dependencies added
- [ ] Existing tests still pass

---

## Phase 5: Studio API Client + Documentation

**Goal:** Create API client functions for Studio to use when building the import/export UI, and update all documentation.

**Duration:** 2-3 days
**Risk:** LOW (new code, no modifications to existing)

### Tasks

#### 5.1 Studio API Client Functions

**File:** `apps/studio/src/lib/api/project-io.ts`

Create typed API client functions:

```typescript
export async function exportPreview(projectId: string): Promise<ExportPreviewResponse> { ... }
export async function exportProject(projectId: string, options?: ExportOptions): Promise<ExportResponse> { ... }
export async function importPreview(projectId: string, files: Record<string, string>): Promise<ImportPreviewResponse> { ... }
export async function importProject(projectId: string, files: Record<string, string>): Promise<ImportResponse> { ... }
```

#### 5.2 SWR Hooks for Studio

**File:** `apps/studio/src/hooks/use-project-io.ts`

Create SWR-based React hooks:

```typescript
export function useExportPreview(projectId: string) { ... }
export function useImportMutation(projectId: string) { ... }
```

#### 5.3 Documentation Updates

- Update feature spec status from ALPHA to BETA
- Update test spec with actual test results
- Update HLD with v2 route implementation details
- Run `/post-impl-sync project-import-export`

### Exit Criteria

- [ ] Studio API client functions are typed and tested
- [ ] SWR hooks provide loading/error/data states
- [ ] All SDLC artifacts updated to reflect implemented state
- [ ] Feature status promoted to BETA

---

## Dependency Graph

```
Phase 1 (Route v2 Wiring)
    |
    +---> Phase 2 (E2E Tests) -- depends on v2 routes for full coverage
    |         |
    |         +---> Phase 4 (Observability) -- E2E tests verify trace events
    |
    +---> Phase 3 (Integration Tests) -- can run in parallel with Phase 2
              |
              +---> Phase 5 (Studio Client + Docs) -- final phase
```

**Critical path:** Phase 1 -> Phase 2 -> Phase 4 -> Phase 5
**Parallel path:** Phase 3 can start after Phase 1 completes

---

## Risk Mitigation

| Risk                                     | Mitigation                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| v2 route breaks existing v1 consumers    | Version parameter (`?version=2`) preserves v1 as default; v2 is opt-in          |
| E2E test infrastructure complex          | Reuse existing test patterns from `runtime/__tests__/`; share MongoMemoryServer |
| Staged import adapter complexity         | Follow existing adapter patterns in `staged-importer.test.ts`; in-memory first  |
| Observability changes introduce overhead | TraceEvent emission is async and non-blocking; benchmarked in Phase 2 tests     |
| Studio hooks break existing Studio build | New files only; no modifications to existing components                         |

---

## Phased Rollout Plan

| Phase            | Status Gate                                       | Rollout                |
| ---------------- | ------------------------------------------------- | ---------------------- |
| Phase 1 complete | All existing tests pass + v2 endpoints functional | Internal dev testing   |
| Phase 2 complete | 12 E2E tests pass                                 | QA environment         |
| Phase 3 complete | 10 integration tests pass                         | CI pipeline            |
| Phase 4 complete | Observability verified in dev                     | Staging environment    |
| Phase 5 complete | Studio client ready + docs updated                | Production (BETA flag) |

---

## Effort Estimation

| Phase                      | Duration       | Complexity | Dependencies                    |
| -------------------------- | -------------- | ---------- | ------------------------------- |
| Phase 1: Route v2 Wiring   | 3-5 days       | HIGH       | Database models, StagedImporter |
| Phase 2: E2E Test Suite    | 3-5 days       | HIGH       | Phase 1, test infrastructure    |
| Phase 3: Integration Tests | 2-3 days       | MEDIUM     | Phase 1                         |
| Phase 4: Observability     | 2-3 days       | LOW        | Phase 2 (for verification)      |
| Phase 5: Studio Client     | 2-3 days       | LOW        | Phase 4                         |
| **Total**                  | **12-19 days** |            |                                 |

---

## Appendix A: File Manifest

### New Files

| File                                                                              | Phase | Purpose                                 |
| --------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| `apps/runtime/src/services/project-io/import-db-adapter.ts`                       | 1     | MongoImportDbAdapter implementation     |
| `apps/runtime/src/services/project-io/post-import-db-adapter.ts`                  | 1     | MongoPostImportDbAdapter implementation |
| `apps/runtime/src/services/project-io/layer-assembler-factory.ts`                 | 1     | Factory for v2 layer assemblers         |
| `apps/runtime/src/__tests__/e2e/project-io-e2e.test.ts`                           | 2     | 12 E2E test scenarios                   |
| `packages/project-io/src/__tests__/integration/import-export-integration.test.ts` | 3     | 10 integration test scenarios           |
| `apps/studio/src/lib/api/project-io.ts`                                           | 5     | Studio API client                       |
| `apps/studio/src/hooks/use-project-io.ts`                                         | 5     | SWR hooks                               |

### Modified Files

| File                                      | Phase | Change                                 |
| ----------------------------------------- | ----- | -------------------------------------- |
| `apps/runtime/src/routes/project-io.ts`   | 1, 4  | Add v2 endpoints + TraceEvent emission |
| `docs/features/project-import-export.md`  | 5     | Status ALPHA -> BETA                   |
| `docs/testing/project-import-export.md`   | 5     | Add actual test results                |
| `docs/specs/project-import-export.hld.md` | 5     | Add v2 route details                   |

---

## Appendix B: Wiring Checklist

Every new module must be verified to be wired into its caller:

- [ ] `MongoImportDbAdapter` is instantiated in the v2 import route handler
- [ ] `MongoPostImportDbAdapter` is instantiated and passed to `validatePostImport()`
- [ ] `LayerAssemblerFactory` creates assemblers for all 8 layers
- [ ] v2 export route registers BEFORE parameterized routes (Express route ordering)
- [ ] v2 import route uses same middleware chain (auth + projectScope + rateLimit)
- [ ] Studio API client uses the correct base URL from config
- [ ] SWR hooks use the correct cache keys
- [ ] TraceEvent types are registered in the trace event schema

---

## Appendix C: Decision Log

| Decision                                      | Classification | Rationale                                                                          |
| --------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| Version parameter (not separate paths) for v2 | DECIDED        | Avoids route proliferation; single OpenAPI spec; gradual migration                 |
| MongoMemoryServer for E2E tests               | DECIDED        | Consistent with other Runtime E2E patterns; no external dependency                 |
| In-memory git provider for INT-7              | DECIDED        | Real git provider tests are unit-level; integration tests verify the orchestration |
| SWR (not React Query) for Studio              | DECIDED        | Studio already uses SWR everywhere; consistency                                    |
| Phase 1 before Phase 2                        | DECIDED        | E2E tests need v2 routes to test; can't test what doesn't exist                    |
