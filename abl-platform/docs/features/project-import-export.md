# Feature Spec: Project Import/Export

> **Feature ID:** #47
> **Status:** BETA
> **Package:** `@agent-platform/project-io`
> **Route:** `apps/runtime/src/routes/project-io.ts`
> **Mounted at:** `/api/projects/:projectId/project-io`
> **Last Updated:** 2026-03-23

---

## 1. Problem Statement

ABL projects contain agents, tools, behavior profiles, connections, guardrails, workflows, evals, search indexes, channels, and vocabulary -- all expressed in DSL and stored in MongoDB. Teams need to:

1. **Move projects between environments** (dev to staging to production) without manual recreation.
2. **Share project templates** across tenants or organizations.
3. **Back up and restore** projects for disaster recovery and audit compliance.
4. **Version control projects** via Git integration (GitHub, GitLab, Bitbucket).
5. **Enable CLI/AI-agent workflows** where projects are created, modified, and deployed programmatically.

Without a portable archive format and reliable import/export pipeline, teams resort to manual DSL copy-paste, which is error-prone, loses dependency metadata, and provides no integrity verification.

---

## 2. Scope

### 2.1 In Scope

| Area                         | Description                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Export v1**                | Agent DSL files + tool files + manifest + lockfile as a flat file map                                                 |
| **Export v2**                | Layered export with 8 layers (core, connections, guardrails, workflows, evals, search, channels, vocabulary)          |
| **Import v1**                | Agent-only import with diff preview, syntax validation, dependency check                                              |
| **Import v2**                | Multi-layer staged import with phase-based rollback (validate -> stage -> activate -> cleanup)                        |
| **Manifest**                 | `project.json` with project metadata, agent registry, tool registry, dependency graph, env var requirements           |
| **Lockfile**                 | `abl.lock` with content hashes for integrity verification                                                             |
| **Dependency Graph**         | Directed graph of agent-to-agent (handoff, delegate) and agent-to-tool (import) references                            |
| **Diff Engine**              | Section-level ABL diff for import preview (added/modified/removed/unchanged per DSL section)                          |
| **Ownership**                | Per-agent edit locks (distributed via MongoDB), permission checks (view/edit/deploy/delete/transfer)                  |
| **Git Integration**          | Push/pull to GitHub/GitLab/Bitbucket/generic Git, webhook-driven sync, branch management, conflict resolution         |
| **REST API**                 | 4 endpoints on Runtime: export preview, export, import preview, import                                                |
| **MCP Tool**                 | `platform_import_export` tool for AI agent programmatic access                                                        |
| **Auth Profile Mapping**     | Map exported auth profile references to target environment profiles during import                                     |
| **Post-Import Validation**   | Report missing env vars, connectors needing credentials, MCP servers needing auth                                     |
| **Entity Schema Validation** | Zod schemas for all importable entity types (connections, guardrails, workflows, evals, search, channels, vocabulary) |

### 2.2 Out of Scope

| Area                                | Rationale                                                               |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Binary asset export (images, PDFs)  | Projects are DSL-based; binary assets are managed by SearchAI ingestion |
| Cross-tenant import without re-auth | Security: tenant isolation requires re-provisioning credentials         |
| Real-time collaborative editing     | Handled by the ownership lock system, not import/export                 |
| Studio UI for import/export         | Separate feature (#TBD); this spec covers the API and library layer     |

---

## 3. User Stories

### 3.1 Export

| ID    | Story                                                                                                                    | Acceptance Criteria                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| US-E1 | As a developer, I want to preview what will be exported so I can verify completeness before downloading                  | Export preview returns agent count, tool count, dependency graph, and validation status             |
| US-E2 | As a developer, I want to export my project as a portable file map so I can import it elsewhere                          | Export returns `project.json`, `abl.lock`, agent files, tool files, and optional deployment configs |
| US-E3 | As an admin, I want to export specific layers (e.g., only guardrails + workflows) so I can share partial configurations  | v2 export accepts a `layers` parameter; core is always included                                     |
| US-E4 | As a CI pipeline, I want to export with deployment manifests so I can track what was deployed where                      | `include_deployments=true` query parameter includes deployment environment configs                  |
| US-E5 | As a developer, I want the export to detect environment variable references so the import target knows what to provision | Manifest `metadata.required_env_vars` lists all `{{env.KEY}}` and `{{secrets.KEY}}` references      |
| US-E6 | As a developer, I want DSL format conversion (legacy to YAML) during export                                              | `dslFormat=yaml` parameter with `compileFn` triggers IR compilation and YAML serialization          |

### 3.2 Import

| ID    | Story                                                                                                                | Acceptance Criteria                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| US-I1 | As a developer, I want to preview import changes before applying so I can review what will be added/modified/removed | Import preview returns per-entity diffs without mutating the database                          |
| US-I2 | As a developer, I want to import a project file map and have agents created/updated/deleted accordingly              | Import applies operations in bulk (insertMany, bulkWrite, deleteMany) with rollback on failure |
| US-I3 | As a developer, I want syntax errors reported before import applies so I can fix DSL issues first                    | Validation phase catches syntax errors per file with line numbers                              |
| US-I4 | As an admin, I want concurrent import protection so two team members cannot import simultaneously                    | Distributed Redis lock (`SET NX PX`) with 2-minute TTL per project                             |
| US-I5 | As a developer, I want the import to handle v1-to-v2 format migration transparently                                  | `migrateV1ToV2` detects v1 manifests and upgrades folder structure                             |
| US-I6 | As a developer, I want post-import reporting that tells me what I need to provision                                  | Post-import validator reports missing env vars, unlinked connectors, MCP servers needing auth  |
| US-I7 | As a developer, I want to map auth profiles from the source to target environment during import                      | `authProfileMapping` option maps exported profile names to target profile IDs                  |

### 3.3 Git Integration

| ID    | Story                                                                                | Acceptance Criteria                                                                 |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| US-G1 | As a developer, I want to push my project to a Git repository for version control    | GitSyncService.push serializes project to file map and commits to configured branch |
| US-G2 | As a developer, I want to pull changes from Git and have them applied to my project  | GitSyncService.pull reads remote files and runs through the import pipeline         |
| US-G3 | As a developer, I want webhook-driven auto-sync when my Git repo changes             | Webhook handler validates signatures, filters relevant file changes, triggers pull  |
| US-G4 | As an admin, I want conflict resolution strategies (local wins, remote wins, manual) | ConflictResolver implements 3-way merge with configurable strategy                  |
| US-G5 | As a developer, I want branch management (create, list, switch) for feature branches | BranchManager provides branch CRUD via provider-specific APIs                       |
| US-G6 | As an admin, I want circuit breaker protection for Git provider outages              | GitCircuitBreaker tracks failures and opens circuit after threshold                 |

### 3.4 Ownership and Locking

| ID    | Story                                                                            | Acceptance Criteria                                                                              |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| US-O1 | As a developer, I want to acquire an edit lock on an agent before making changes | LockService.acquireLock returns lock record or conflict error with current holder info           |
| US-O2 | As an admin, I want to transfer agent ownership between users/teams              | OwnershipService.transferOwnership validates permission and updates owner                        |
| US-O3 | As a developer, I want permission-based access control (view/edit/deploy/delete) | PermissionChecker resolves effective permissions from project role + team role + explicit grants |

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                   | Priority | Status      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| FR-01 | Export preview returns project metadata, agent list, tool list, and dependency validation                                                                     | P0       | IMPLEMENTED |
| FR-02 | Export generates file map with `project.json` manifest, `abl.lock` lockfile, agent files at `agents/<name>.agent.abl`, tool files at `tools/<name>.tools.abl` | P0       | IMPLEMENTED |
| FR-03 | Export v2 supports 8 layers with two-wave assembly (core+connections first, then optional layers in parallel)                                                 | P0       | IMPLEMENTED |
| FR-04 | Export detects entry agent from SUPERVISOR DSL keyword                                                                                                        | P1       | IMPLEMENTED |
| FR-05 | Export scans for `{{env.KEY}}` and `{{secrets.KEY}}` references and includes them in manifest metadata                                                        | P0       | IMPLEMENTED |
| FR-06 | Export enforces size guards: max 1000 agents, 500 tools, 100MB response                                                                                       | P0       | IMPLEMENTED |
| FR-07 | Import validates folder structure, manifest schema, DSL syntax, and dependencies before apply                                                                 | P0       | IMPLEMENTED |
| FR-08 | Import computes section-level ABL diffs for preview (added/modified/removed/unchanged per section)                                                            | P0       | IMPLEMENTED |
| FR-09 | Import applies operations in bulk with rollback of created agents on failure                                                                                  | P0       | IMPLEMENTED |
| FR-10 | Import acquires distributed Redis lock to prevent concurrent imports per project                                                                              | P0       | IMPLEMENTED |
| FR-11 | Import v2 uses staged approach: validate -> stage (status='staged') -> activate (staged->active, old->superseded) -> cleanup                                  | P0       | IMPLEMENTED |
| FR-12 | Import v2 supports per-layer rollback on activation failure                                                                                                   | P0       | IMPLEMENTED |
| FR-13 | Import strips common path prefix for robustness with nested folders                                                                                           | P1       | IMPLEMENTED |
| FR-14 | Import validates path traversal (rejects `..`, leading `/`, null bytes, backslashes)                                                                          | P0       | IMPLEMENTED |
| FR-15 | Import rejects oversized payloads (1MB per file, 50MB total, 500 file count, 60MB body)                                                                       | P0       | IMPLEMENTED |
| FR-16 | Lockfile v1 generates per-agent and per-tool SHA-256 content hashes with HMAC integrity                                                                       | P0       | IMPLEMENTED |
| FR-17 | Lockfile v2 generates per-layer hashes and per-entity hashes with combined integrity                                                                          | P0       | IMPLEMENTED |
| FR-18 | Dependency graph detects handoff, delegate, tool_import, inline_handoff, and profile_use edges                                                                | P0       | IMPLEMENTED |
| FR-19 | Circular dependency detection reports all cycles in the dependency graph                                                                                      | P1       | IMPLEMENTED |
| FR-20 | Git providers (GitHub, GitLab, Bitbucket, generic) implement push, pull, list branches, create PR                                                             | P1       | IMPLEMENTED |
| FR-21 | Git sync service coordinates export->push and pull->import flows                                                                                              | P1       | IMPLEMENTED |
| FR-22 | Webhook handler validates provider-specific signatures (GitHub HMAC-SHA256, GitLab token, Bitbucket)                                                          | P1       | IMPLEMENTED |
| FR-23 | Conflict resolver implements 3-way merge with local_wins, remote_wins, and manual strategies                                                                  | P1       | IMPLEMENTED |
| FR-24 | Branch manager tracks ahead/behind counts using commit diff ranges                                                                                            | P2       | IMPLEMENTED |
| FR-25 | Git circuit breaker opens after configurable failure threshold and auto-resets after timeout                                                                  | P2       | IMPLEMENTED |
| FR-26 | Ownership service tracks agent owner (user or team) with transfer history                                                                                     | P1       | IMPLEMENTED |
| FR-27 | Lock service provides distributed edit/deploy locks with TTL and automatic expiry                                                                             | P1       | IMPLEMENTED |
| FR-28 | Permission checker resolves effective permissions from project role, team role, and explicit grants                                                           | P1       | IMPLEMENTED |
| FR-29 | v1-to-v2 manifest migration detects format version and upgrades folder structure                                                                              | P1       | IMPLEMENTED |
| FR-30 | Auth profile mapping resolves exported profile references to target environment profiles                                                                      | P1       | IMPLEMENTED |
| FR-31 | Post-import validator reports provisioning requirements (env vars, connectors, MCP servers, auth profiles)                                                    | P1       | IMPLEMENTED |
| FR-32 | Entity schema validation (Zod) for all importable types: connections, guardrails, workflows, evals, search, channels, vocabulary                              | P0       | IMPLEMENTED |
| FR-33 | Import prerequisite validator checks target environment readiness before import                                                                               | P1       | IMPLEMENTED |
| FR-34 | Cross-reference resolver rewrites internal IDs (projectId, tenantId) during import to target values                                                           | P0       | IMPLEMENTED |
| FR-35 | Layer assemblers serialize domain entities to canonical file paths during export                                                                              | P0       | IMPLEMENTED |
| FR-36 | Layer disassemblers parse files back to domain entities during import                                                                                         | P0       | IMPLEMENTED |
| FR-37 | REST API enforces RBAC: export requires `project:export`, import requires `project:import`                                                                    | P0       | IMPLEMENTED |
| FR-38 | REST API returns standard error envelope: `{ success: false, error: { code, message } }`                                                                      | P0       | IMPLEMENTED |

---

## 5. Non-Functional Requirements

| ID     | Requirement                                                         | Target                                                  |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------- |
| NFR-01 | Export of 100-agent project completes in < 5 seconds                | Benchmarked in export-performance tests                 |
| NFR-02 | Import preview of 100-agent project completes in < 3 seconds        | No DB writes during preview                             |
| NFR-03 | Maximum export response size capped at 100MB                        | Prevents OOM in runtime pods                            |
| NFR-04 | Maximum import body size capped at 60MB                             | Express body parser limit                               |
| NFR-05 | Concurrent import protection via distributed lock (Redis SET NX PX) | 2-minute TTL, Lua-based atomic release                  |
| NFR-06 | All file paths validated against traversal attacks                  | Rejects `..`, `/`, `\0`, `\\`                           |
| NFR-07 | Lockfile integrity verified via HMAC-SHA256                         | Detects tampering or corruption                         |
| NFR-08 | Git circuit breaker prevents cascading failures                     | Configurable threshold and reset timeout                |
| NFR-09 | Edit locks expire automatically (TTL-based)                         | Prevents orphaned locks from blocking work              |
| NFR-10 | Tenant isolation enforced at route level                            | Every query includes tenantId; cross-tenant returns 404 |

---

## 6. Architecture Overview

```
+------------------+     +------------------+     +------------------+
|   REST API       |     |   MCP Tool       |     |   Git Webhooks   |
|   (Runtime)      |     |   (platform_     |     |   (GitHub/       |
|                  |     |    import_export) |     |    GitLab/BB)    |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         v                        v                        v
+--------+---------+     +--------+---------+     +--------+---------+
|   Export          |     |   Import          |     |   Git Sync       |
|   Orchestrator    |     |   Orchestrator    |     |   Service        |
|   (v1 + v2)      |     |   (v1 + v2)       |     |                  |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         v                        v                        v
+--------+--------+---------+--------+---------+--------+---------+
|                    @agent-platform/project-io                    |
|                                                                  |
|  export/           import/           dependencies/               |
|    project-exporter  project-importer  dependency-graph          |
|    folder-builder    folder-reader     circular-detector         |
|    manifest-gen      import-validator  dependency-extractor      |
|    lockfile-gen      import-applier                              |
|    env-var-scanner   staged-importer   diff/                     |
|    deployment-exp    post-import-val     abl-differ              |
|    layer-assemblers  layer-disassemblers section-splicer         |
|                      entity-schemas    import-diff-calculator    |
|                      cross-ref-resolver                          |
|  ownership/          auth-profile-resolver                       |
|    lock-service      v1-migration      git/                      |
|    ownership-svc     prerequisite-val    github-provider         |
|    permission-chk                        gitlab-provider         |
|                                          bitbucket-provider      |
|                                          git-sync-service        |
|                                          conflict-resolver       |
|                                          branch-manager          |
|                                          webhook-handler         |
|                                          git-circuit-breaker     |
+------------------------------------------------------------------+
```

### Package Metrics

| Metric              | Value                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| Source files        | ~100 `.ts` files                                                                  |
| Total LOC           | ~38,000 lines                                                                     |
| Test files          | 60 unit test files + 1 integration test                                           |
| Sub-modules         | 7 (export, import, dependencies, diff, ownership, git, types)                     |
| Layer assemblers    | 8 (core, connections, guardrails, workflows, evals, search, channels, vocabulary) |
| Layer disassemblers | 8 (matching assemblers)                                                           |
| Entity schemas      | 18 Zod schemas                                                                    |
| Git providers       | 4 (GitHub, GitLab, Bitbucket, generic)                                            |

---

## 7. Data Model

### 7.1 Export Artifacts

| File                          | Format  | Description                                                                     |
| ----------------------------- | ------- | ------------------------------------------------------------------------------- |
| `project.json`                | JSON    | Project manifest with metadata, agent registry, tool registry, dependency graph |
| `abl.lock`                    | JSON    | Content hashes for integrity verification                                       |
| `agents/<name>.agent.abl`     | ABL DSL | Agent definition files                                                          |
| `tools/<name>.tools.abl`      | ABL DSL | Tool definition files                                                           |
| `profiles/<name>.profile.abl` | ABL DSL | Behavior profile files                                                          |
| `configs/<name>.yaml`         | YAML    | Configuration overrides                                                         |
| `locales/<lang>.yaml`         | YAML    | Localization strings                                                            |
| `deployments/<env>.json`      | JSON    | Deployment environment configs                                                  |
| `connections/<name>.json`     | JSON    | Connection definitions (v2)                                                     |
| `guardrails/<name>.json`      | JSON    | Guardrail policy definitions (v2)                                               |
| `workflows/<name>.json`       | JSON    | Workflow definitions (v2)                                                       |
| `evals/<name>.json`           | JSON    | Evaluation scenario definitions (v2)                                            |
| `search/<name>.json`          | JSON    | Search index definitions (v2)                                                   |
| `channels/<name>.json`        | JSON    | Channel configurations (v2)                                                     |
| `vocabulary/<name>.json`      | JSON    | Vocabulary/lookup entries (v2)                                                  |

### 7.2 Manifest Schema (v2)

```typescript
interface ProjectManifestV2 {
  format_version: '2.0';
  name: string;
  slug: string;
  description: string | null;
  abl_version: string;
  exported_at: string; // ISO 8601
  exported_by: string; // userId
  entry_agent: string | null;
  dsl_format: 'yaml' | 'legacy';
  layers_included: LayerName[];
  agents: Record<string, ManifestAgent>;
  tools: Record<string, ManifestTool>;
  behavior_profiles?: Record<string, ManifestBehaviorProfile>;
  metadata: {
    entity_counts: Record<string, number>;
    required_env_vars: string[];
    required_connectors: string[];
    required_mcp_servers: string[];
    required_auth_profiles?: AuthProfileRef[];
  };
}
```

---

## 8. Security Considerations

| Concern                       | Mitigation                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Path traversal in import      | Validates no `..`, `/`, `\0`, `\\` in file paths                                                                   |
| Oversized payloads            | Content-Length pre-check + Express body parser limit + per-file and total size limits                              |
| Concurrent import race        | Distributed Redis lock with atomic Lua release                                                                     |
| Cross-tenant access           | Route enforces `tenantId` in every DB query; cross-tenant returns 404                                              |
| Credential exposure in export | Auth profiles export references (names), not secrets; connections strip credential fields                          |
| Git webhook forgery           | Provider-specific signature verification (HMAC-SHA256 for GitHub, token for GitLab)                                |
| Lockfile tampering            | HMAC-SHA256 integrity hash covers all content hashes                                                               |
| Bulk import abuse             | File count limit (500), total size limit (50MB), rate limiting via tenant rate limiter                             |
| Rollback safety               | Import creates new records with status='staged', only activates atomically; failed activation rolls back per-layer |

---

## 9. Known Gaps and Future Work

| Gap                       | Description                                                                            | Priority |
| ------------------------- | -------------------------------------------------------------------------------------- | -------- |
| Studio UI                 | No UI for import/export in Studio; API-only                                            | P1       |
| Streaming export          | Large projects may exceed memory; streaming ZIP/tar.gz would reduce peak memory        | P2       |
| Selective agent export    | Cannot export a subset of agents (all-or-nothing per layer)                            | P2       |
| Import conflict merge     | Only 'replace' and 'skip' strategies; no 3-way merge for import (Git has it)           | P2       |
| Export encryption         | No at-rest encryption of export archives; relies on transport encryption               | P3       |
| Audit logging             | Import/export operations are logged but not integrated with the audit-logging pipeline | P1       |
| Import progress streaming | v2 has `onProgress` callback but no WebSocket/SSE endpoint for real-time UI updates    | P2       |
| Cross-project import      | Cannot import from one project into another (same project only)                        | P3       |

---

## 10. Decision Log

| Decision                                       | Classification | Rationale                                                                     |
| ---------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| File map (not ZIP) as primary format           | DECIDED        | JSON-serializable for REST API; ZIP is an optional conversion layer           |
| Two-wave export assembly                       | DECIDED        | Core+connections must complete before optional layers reference their IDs     |
| Staged import with per-layer rollback          | DECIDED        | Safer than all-or-nothing; partial import is recoverable                      |
| Redis distributed lock for concurrent import   | DECIDED        | Consistent with platform pattern (session-lock.ts uses same approach)         |
| Manifest + lockfile separation                 | DECIDED        | Manifest is human-readable metadata; lockfile is machine-verifiable integrity |
| v1/v2 coexistence                              | DECIDED        | v1 backward compatibility required for existing consumers; v2 adds layers     |
| Auth profile references (not values) in export | DECIDED        | Security: credentials must never leave the tenant boundary in plain text      |
