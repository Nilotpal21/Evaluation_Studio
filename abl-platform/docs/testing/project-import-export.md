# Test Spec: Project Import/Export

> **Feature:** #47 Project Import/Export
> **Package:** `@agent-platform/project-io`
> **Route:** `apps/runtime/src/routes/project-io.ts`
> **Last Updated:** 2026-03-23
> **Status:** SPEC

---

## 1. Test Strategy Overview

The project-import-export feature has three test layers:

1. **Unit tests** (60 existing files in `packages/project-io/src/__tests__/`): Pure function tests for each sub-module (assemblers, disassemblers, validators, diff engine, git providers, ownership, etc.). These are ALREADY comprehensive.
2. **Integration tests**: Test cross-module interactions within the package (e.g., export -> import roundtrip, staged import with DB adapter, git sync end-to-end).
3. **E2E tests**: Test the full HTTP API through the Runtime server, exercising auth, RBAC, rate limiting, tenant isolation, distributed locking, and DB operations.

This spec focuses on the **E2E and integration tests** that are currently missing or incomplete.

---

## 2. Existing Test Coverage

| Test Area                    | Files                                                  | Status                 |
| ---------------------------- | ------------------------------------------------------ | ---------------------- |
| ABL differ                   | `abl-differ.test.ts`                                   | PASSING                |
| Assembler utils              | `assembler-utils.test.ts`                              | PASSING                |
| Auth profile mapping         | `auth-profile-mapping.test.ts`                         | PASSING                |
| Bitbucket provider           | `bitbucket-provider.test.ts`                           | PASSING                |
| Branch manager               | `branch-manager.test.ts`                               | PASSING                |
| Channels assembler           | `channels-assembler.test.ts`                           | PASSING                |
| Circular detector            | `circular-detector.test.ts`                            | PASSING                |
| Conflict resolver            | `conflict-resolver.test.ts`                            | PASSING                |
| Connections assembler        | `connections-assembler.test.ts`                        | PASSING                |
| Core assembler               | `core-assembler.test.ts`                               | PASSING                |
| Cross-ref resolver           | `cross-ref-resolver.test.ts`                           | PASSING                |
| Dependency extractor         | `dependency-extractor.test.ts`                         | PASSING                |
| Dependency graph             | `dependency-graph.test.ts`                             | PASSING                |
| Entity schemas               | `entity-schemas.test.ts`                               | PASSING                |
| Env var scanner              | `env-var-scanner.test.ts`                              | PASSING                |
| Evals assembler              | `evals-assembler.test.ts`                              | PASSING                |
| Export-import roundtrip      | `export-import-roundtrip.test.ts`                      | PASSING                |
| Export orchestrator v2       | `export-orchestrator-v2.test.ts`                       | PASSING                |
| Export performance           | `export-performance.test.ts`                           | PASSING                |
| Export profiles              | `export-profiles.test.ts`                              | PASSING                |
| Export utils                 | `export-utils.test.ts`                                 | PASSING                |
| Export YAML                  | `export-yaml.test.ts`                                  | PASSING                |
| Folder builder collision     | `folder-builder-collision.test.ts`                     | PASSING                |
| Folder reader diagnostics    | `folder-reader-diagnostics.test.ts`                    | PASSING                |
| Folder reader v2             | `folder-reader-v2.test.ts`                             | PASSING                |
| Git circuit breaker          | `git-circuit-breaker.test.ts`                          | PASSING                |
| Git providers                | `git-providers.test.ts`                                | PASSING                |
| Git sync service             | `git-sync-service.test.ts`                             | PASSING                |
| GitHub provider              | `github-provider.test.ts`                              | PASSING                |
| GitLab provider              | `gitlab-provider.test.ts`                              | PASSING                |
| Guardrails assembler         | `guardrails-assembler.test.ts`                         | PASSING                |
| Import crash recovery        | `import-crash-recovery.test.ts`                        | PASSING                |
| Import profiles              | `import-profiles.test.ts`                              | PASSING                |
| Import validator v2          | `import-validator-v2.test.ts`                          | PASSING                |
| Import validators            | `import-validators.test.ts`                            | PASSING                |
| Import workflow versions     | `import-workflow-versions.test.ts`                     | PASSING                |
| Layer disassemblers          | `layer-disassemblers.test.ts`                          | PASSING                |
| Lock service                 | `lock-service.test.ts`                                 | PASSING                |
| Lockfile v2                  | `lockfile-v2.test.ts`                                  | PASSING                |
| Manifest generator dedup     | `manifest-generator-dedup.test.ts`                     | PASSING                |
| Manifest v2                  | `manifest-v2.test.ts`                                  | PASSING                |
| Ownership service            | `ownership-service.test.ts`                            | PASSING                |
| Permission checker           | `permission-checker.test.ts`                           | PASSING                |
| Post-import validator        | `post-import-validator.test.ts`                        | PASSING                |
| Profile roundtrip            | `profile-roundtrip.test.ts`                            | PASSING                |
| Project exporter             | `project-exporter.test.ts`                             | PASSING                |
| Project importer v2          | `project-importer-v2.test.ts`                          | PASSING                |
| Project importer             | `project-importer.test.ts`                             | PASSING                |
| Provider factory             | `provider-factory.test.ts`                             | PASSING                |
| Search assembler             | `search-assembler.test.ts`                             | PASSING                |
| Section splicer              | `section-splicer.test.ts`                              | PASSING                |
| Staged importer              | `staged-importer.test.ts`                              | PASSING                |
| v1 migration                 | `v1-migration.test.ts`                                 | PASSING                |
| Validate connection          | `validate-connection.test.ts`                          | PASSING                |
| Vocabulary assembler         | `vocabulary-assembler.test.ts`                         | PASSING                |
| Webhook handler              | `webhook-handler.test.ts`                              | PASSING                |
| Workflows assembler          | `workflows-assembler.test.ts`                          | PASSING                |
| Workflows assembler versions | `workflows-assembler-versions.test.ts`                 | PASSING                |
| Export v2 integration        | `integration/export-v2-integration.test.ts`            | PASSING                |
| Route tests (mocked)         | `apps/runtime/src/__tests__/project-io-routes.test.ts` | PASSING (uses vi.mock) |

### Coverage Gaps

| Gap                               | Severity | Description                                                                                                                                                                          |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No real HTTP E2E tests            | CRITICAL | `project-io-routes.test.ts` mocks ALL dependencies (DB, project-io package, Redis). It does NOT exercise the real middleware chain, real DB operations, or real import/export logic. |
| No cross-tenant isolation E2E     | CRITICAL | No test verifies that tenant A cannot export/import tenant B's project                                                                                                               |
| No concurrent import E2E          | HIGH     | Distributed lock tested only in mocked route tests, not with real Redis                                                                                                              |
| No large payload E2E              | HIGH     | Size limits tested in mocked tests only                                                                                                                                              |
| No import rollback E2E            | HIGH     | Rollback on failure tested only at unit level                                                                                                                                        |
| No v1-to-v2 migration integration | MEDIUM   | Migration tested at unit level but not through full import pipeline                                                                                                                  |
| No git sync integration           | MEDIUM   | Git sync tested with mocked providers only                                                                                                                                           |

---

## 3. E2E Test Scenarios

All E2E tests interact ONLY via the HTTP API. No mocks of codebase components. Real Express server, real MongoDB, real Redis.

**File:** `apps/runtime/src/__tests__/e2e/project-io-e2e.test.ts`

### E2E-1: Export Preview — Happy Path

**Preconditions:** Project exists with 3 agents (1 supervisor + 2 workers) and 2 tools, owned by tenant-A.

**Steps:**

1. `POST /api/projects` to create project
2. `POST /api/projects/:projectId/agents` to create 3 agents with DSL content containing handoff references
3. `POST /api/projects/:projectId/tools` to create 2 tools
4. `GET /api/projects/:projectId/project-io/export/preview` with valid auth token

**Expected:**

- Response 200 with `project.name`, `agents` array (3 entries), `tools` array (2 entries)
- `dependencies.edges` contains handoff edges between supervisor and workers
- `dependencies.validation.valid` is true
- Each agent entry has `name` and `hasDslContent: true`

### E2E-2: Export Full — Happy Path with Manifest and Lockfile

**Preconditions:** Same project as E2E-1.

**Steps:**

1. `GET /api/projects/:projectId/project-io/export` with valid auth token

**Expected:**

- Response 200 with `success: true`
- `manifest` contains `name`, `slug`, `agents` record, `tools` record, `dependencies`
- `lockfile` contains `lockfile_version: '1.0'`, `agents` with `source_hash` for each agent
- `files` contains keys: `project.json`, `abl.lock`, `agents/supervisor.agent.abl`, `agents/worker-a.agent.abl`, `agents/worker-b.agent.abl`, `tools/search.tools.abl`, `tools/crm.tools.abl`
- `warnings` is empty array (valid project)

### E2E-3: Import Preview — Diff Calculation

**Preconditions:** Project with 2 existing agents (agent-A, agent-B).

**Steps:**

1. Create project with agent-A and agent-B
2. `POST /api/projects/:projectId/project-io/import/preview` with files containing:
   - Modified agent-A (changed GOAL section)
   - New agent-C
   - agent-B omitted (will show as removed in preview but not deleted by v1 import)

**Expected:**

- Response 200 with `success: true`
- `preview.changes.agents.added` contains `['agent-C']`
- `preview.changes.agents.modified` has entry for `agent-A` with diff showing GOAL section change
- `preview.changes.agents.removed` contains `['agent-B']`

### E2E-4: Import Apply — Create, Update, Delete Agents

**Preconditions:** Project with 1 existing agent (agent-A, content v1).

**Steps:**

1. Create project with agent-A (v1 content)
2. `POST /api/projects/:projectId/project-io/import` with files containing:
   - agent-A with updated DSL content (v2)
   - agent-B (new)

**Expected:**

- Response 200 with `success: true`
- `applied.created` is 1 (agent-B)
- `applied.updated` is 1 (agent-A)
- `applied.deleted` is 0
- Subsequent `GET /api/projects/:projectId/agents` returns both agents
- agent-A's `dslContent` matches the imported v2 content
- agent-B exists with the imported content

### E2E-5: Import — Concurrent Import Protection

**Preconditions:** Project exists with 1 agent.

**Steps:**

1. Fire two simultaneous `POST /api/projects/:projectId/project-io/import` requests with valid different file content
2. Both requests use the same auth token

**Expected:**

- Exactly one request returns 200 with `success: true`
- The other returns 409 with error message containing "Another import is in progress"
- After both complete, the project state is consistent (only one import's changes applied)

### E2E-6: Export — Tenant Isolation

**Preconditions:** Two tenants (tenant-A, tenant-B), each with their own project.

**Steps:**

1. Create project-A under tenant-A with 2 agents
2. Create project-B under tenant-B with 1 agent
3. `GET /api/projects/:projectAId/project-io/export` with tenant-B's auth token

**Expected:**

- Response 404 (not 403) — project not found for tenant-B
- tenant-B's token cannot access tenant-A's project

### E2E-7: Import — RBAC Enforcement (Viewer Cannot Import)

**Preconditions:** Project with viewer role user.

**Steps:**

1. Create project
2. `POST /api/projects/:projectId/project-io/import` with viewer-role auth token and valid file payload

**Expected:**

- Response 403 (viewer lacks `project:import` permission)
- No changes to project state

### E2E-8: Export — Size Guard Enforcement

**Preconditions:** Project with agents exceeding the MAX_EXPORT_AGENTS limit.

**Steps:**

1. Create project
2. Create 1001 agents via batch API (or mock at DB level if batch creation is impractical)
3. `GET /api/projects/:projectId/project-io/export`

**Expected:**

- Response 400 with error message mentioning "too many agents to export" and the limit
- No partial export data returned

### E2E-9: Import — Path Traversal Rejection

**Preconditions:** Project exists.

**Steps:**

1. `POST /api/projects/:projectId/project-io/import` with files containing a path traversal attempt: `{ "files": { "../../../etc/passwd": "malicious content" } }`

**Expected:**

- Response 400 with error mentioning "path traversal detected"
- No files written to the filesystem

### E2E-10: Import — Malformed JSON Rejection

**Preconditions:** Project exists.

**Steps:**

1. `POST /api/projects/:projectId/project-io/import` with raw body `{not valid json`

**Expected:**

- Response 400 with error mentioning "Invalid JSON"

### E2E-11: Export-Import Roundtrip

**Preconditions:** Project with 3 agents, 2 tools, handoff dependencies.

**Steps:**

1. Create a fully populated project
2. `GET /api/projects/:projectId/project-io/export` to get the full export
3. Create a new empty project
4. `POST /api/projects/:newProjectId/project-io/import` with the exported `files` object

**Expected:**

- Import returns `success: true`
- New project has same agents and tools as original
- Agent DSL content matches exactly
- Dependency graph (via export preview on new project) matches original

### E2E-12: Import — Empty Files Rejection

**Preconditions:** Project exists.

**Steps:**

1. `POST /api/projects/:projectId/project-io/import` with `{ "files": {} }`

**Expected:**

- Response 400 with error "No files provided"

---

## 4. Integration Test Scenarios

Integration tests exercise cross-module interactions within the `@agent-platform/project-io` package. They use real implementations (no vi.mock) but may use in-memory adapters for DB operations.

**File:** `packages/project-io/src/__tests__/integration/import-export-integration.test.ts`

### INT-1: Export v2 Multi-Layer Roundtrip

**Setup:** Create ProjectData with agents, tools, connections, guardrails, and workflows.

**Steps:**

1. Call `exportProjectV2()` with layers `['core', 'connections', 'guardrails', 'workflows']`
2. Parse the resulting `project.json` manifest
3. Parse the `abl.lock` lockfile
4. Verify layer-specific files exist in the file map
5. Feed the file map into `readFolderV2()` and verify detected layers match

**Expected:**

- Manifest `layers_included` matches requested layers
- Lockfile has layer hashes for each included layer
- File paths match canonical structure (`agents/*.agent.abl`, `connections/*.json`, etc.)
- Folder reader detects all included layers from directory structure

### INT-2: Staged Import with Rollback

**Setup:** In-memory `ImportDbAdapter` that simulates activation failure on a specific layer.

**Steps:**

1. Create a `StagedImporter` with the in-memory adapter
2. Stage records for core, connections, and guardrails layers
3. Configure adapter to fail activation for guardrails layer
4. Call `activate()` and observe rollback

**Expected:**

- Core and connections layers activate successfully
- Guardrails activation fails
- Rollback reverses core and connections (staged records deleted, superseded records restored)
- Final state has no orphaned staged records

### INT-3: Import Validator — Cross-Layer Dependency Detection

**Setup:** File map with agents referencing tools and connections that are not included.

**Steps:**

1. Create file map with `agents/greeter.agent.abl` that references `TOOLS: crm-search FROM tools/crm.tools.abl`
2. Omit the `tools/crm.tools.abl` file from the map
3. Run `validateImport()` on the file map

**Expected:**

- `dependencyValidation.valid` is false
- `dependencyValidation.missing` contains an edge from "greeter" to "crm" with type "tool_import"

### INT-4: Auth Profile Mapping Resolution

**Setup:** Export manifest with auth profile references, target environment with different profile IDs.

**Steps:**

1. Create connections JSON files referencing auth profile "oauth-github"
2. Provide mapping `{ "oauth-github": "target-profile-id-123" }`
3. Run `resolveAuthProfiles()` with the mapping
4. Run `rewriteConnectionAuthProfiles()` on connection files

**Expected:**

- All references to "oauth-github" are rewritten to "target-profile-id-123"
- Resolution result shows all profiles as resolved (no unresolved entries)

### INT-5: v1-to-v2 Migration Through Full Pipeline

**Setup:** v1 export (manifest with `version: '1.0'`, no layer structure).

**Steps:**

1. Create v1-format file map: flat agent files, v1 manifest, v1 lockfile
2. Run `migrateV1ToV2()` on the file map
3. Run `importProjectV2()` on the migrated result

**Expected:**

- Migration detects v1 format and produces v2 structure
- v2 import succeeds with agents correctly placed under `agents/` directory
- Manifest upgraded to `format_version: '2.0'`

### INT-6: Lockfile Integrity Verification

**Setup:** Export a project, tamper with one file, verify lockfile detects it.

**Steps:**

1. Export project to get files + lockfile
2. Modify content of one agent file in the map (simulating corruption)
3. Run `verifyLockfileIntegrity()` against modified file map

**Expected:**

- Integrity check fails
- Reports the specific file whose hash does not match

### INT-7: Git Sync — Export-Push-Pull-Import Roundtrip

**Setup:** In-memory git provider implementation.

**Steps:**

1. Create project with 2 agents
2. Export project to file map
3. Push file map to in-memory git provider
4. Pull from git provider (returns same file map)
5. Feed pulled files into import pipeline

**Expected:**

- Push succeeds with commit SHA
- Pull returns same files as pushed
- Import detects 0 changes (all unchanged)

### INT-8: Dependency Graph — Circular Detection with Handoffs

**Setup:** Three agents forming a cycle: A handoffs to B, B handoffs to C, C handoffs to A.

**Steps:**

1. Create DSL for agents A, B, C with mutual handoff references
2. Build dependency graph
3. Run circular detection

**Expected:**

- `detectCircularDependencies()` returns one cycle: `[A, B, C, A]`
- `validateDependencies()` reports `circular` array with the cycle

### INT-9: Post-Import Validation Report

**Setup:** Import project with agents referencing env vars and connectors that do not exist in target.

**Steps:**

1. Import agents with `{{env.API_KEY}}` and `{{secrets.DB_PASSWORD}}` references
2. Configure PostImportDbAdapter to return empty env vars and no connectors
3. Run `validatePostImport()`

**Expected:**

- Report status is `action_required`
- `provisioning_required.env_vars` contains `['API_KEY', 'DB_PASSWORD']`
- Report is actionable (tells user what to provision)

### INT-10: Export Performance — 100 Agent Benchmark

**Setup:** ProjectData with 100 agents, each with 50-line DSL content.

**Steps:**

1. Generate 100 agents with realistic DSL content
2. Call `exportProject()` and measure execution time
3. Verify result completeness

**Expected:**

- Export completes in < 5 seconds (NFR-01)
- File map contains 100 agent files + manifest + lockfile
- No warnings about missing dependencies (self-contained agents)

---

## 5. Test Data Requirements

### Seed Data Templates

| Template               | Description                            | Used By              |
| ---------------------- | -------------------------------------- | -------------------- |
| `supervisor-agent.abl` | SUPERVISOR agent with handoff targets  | E2E-1, E2E-2, E2E-11 |
| `worker-agent.abl`     | Worker agent with tool imports         | E2E-1, E2E-2, E2E-11 |
| `simple-agent.abl`     | Minimal agent with GOAL section only   | E2E-3, E2E-4, E2E-5  |
| `tool-definition.abl`  | Tool file with API endpoint            | E2E-1, E2E-2, E2E-11 |
| `connection.json`      | Connection with auth profile reference | INT-4                |
| `guardrail.json`       | Guardrail policy definition            | INT-1, INT-2         |
| `workflow.json`        | Workflow with version metadata         | INT-1                |

### DSL Content Examples

```abl
# supervisor-agent.abl
SUPERVISOR: ProjectManager
GOAL: Coordinate between search and CRM agents
HANDOFF_TARGETS:
  - SearchAgent
  - CRMAgent
TOOLS:
  - orchestration-utils FROM tools/utils.tools.abl
```

```abl
# worker-agent.abl
AGENT: SearchAgent
GOAL: Search knowledge base for relevant information
MODEL: gpt-4
TOOLS:
  - search-api FROM tools/search.tools.abl
```

---

## 6. Environment Requirements

| Requirement                         | E2E                                   | Integration                   |
| ----------------------------------- | ------------------------------------- | ----------------------------- |
| MongoDB (real or MongoMemoryServer) | Required                              | Optional (in-memory adapters) |
| Redis (real or ioredis-mock)        | Required (for distributed lock tests) | Not required                  |
| Runtime Express server              | Required (started on random port)     | Not required                  |
| Auth middleware (real)              | Required                              | Not required                  |
| Network access                      | None (all local)                      | None                          |

---

## 7. Test Execution

```bash
# Unit tests (existing, fast)
pnpm test --filter=@agent-platform/project-io

# Integration tests
pnpm test --filter=@agent-platform/project-io -- integration

# E2E tests (requires MongoDB + Redis)
pnpm test --filter=runtime -- project-io-e2e
```

---

## 8. Coverage Targets

| Layer                      | Current     | Target | Gap                                       |
| -------------------------- | ----------- | ------ | ----------------------------------------- |
| Unit (project-io package)  | ~85%        | 90%    | Fill entity schema edge cases             |
| Integration (cross-module) | ~15%        | 50%    | Add INT-1 through INT-10                  |
| E2E (HTTP API)             | 0% (mocked) | 70%    | Add E2E-1 through E2E-12                  |
| Route RBAC                 | Mocked      | Real   | Replace mocked route tests with real auth |
| Tenant isolation           | 0%          | 100%   | E2E-6                                     |
| Concurrent import          | Mocked      | Real   | E2E-5                                     |

---

## 9. Risk Matrix

| Risk                                          | Likelihood | Impact | Mitigation                                                              |
| --------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------- |
| E2E tests slow due to MongoDB + Redis startup | HIGH       | MEDIUM | Use MongoMemoryServer with shared instance across test suite            |
| Concurrent import test flaky                  | MEDIUM     | HIGH   | Use deterministic timing (delay one request) rather than race condition |
| Auth token generation for E2E                 | LOW        | HIGH   | Use test utility to generate valid JWT tokens with configurable roles   |
| Large export tests consume memory             | LOW        | MEDIUM | Clean up file maps after each test with explicit garbage collection     |
