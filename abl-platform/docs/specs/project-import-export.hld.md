# High-Level Design: Project Import/Export

> **Feature:** #47 Project Import/Export
> **Package:** `@agent-platform/project-io`
> **Status:** ALPHA
> **Last Updated:** 2026-03-23

---

## 1. Overview

The Project Import/Export system enables ABL projects to be serialized into a portable, human-readable archive format and reconstituted in a different environment (tenant, cluster, or Git repository). It is the backbone for environment promotion (dev -> staging -> production), project templating, disaster recovery, Git-based version control, and programmatic project management via CLI/MCP tools.

The system is implemented as a pure TypeScript library (`@agent-platform/project-io`) consumed by the Runtime REST API, Studio API routes, MCP tools, and Git sync workers.

---

## 2. Architecture

### 2.1 System Context Diagram

```
                                +-----------------+
                                |   External Git   |
                                |   (GitHub/       |
                                |    GitLab/BB)    |
                                +--------+--------+
                                         |
                                         | webhooks / API
                                         v
+----------+    +----------+    +--------+--------+    +----------+
|  Studio  |    |  CLI /   |    |    Runtime      |    |  Admin   |
|  (UI)    |    |  MCP     |    |    Server       |    |  Server  |
+----+-----+    +----+-----+    +----+---+--------+    +----+-----+
     |               |               |   |                   |
     +-------+-------+-------+-------+   |                   |
             |               |           |                   |
             v               v           v                   |
     +-------+---------------+-----------+---+               |
     |         project-io REST API           |               |
     |    /api/projects/:projectId/          |               |
     |         project-io/*                  |               |
     +-------+---------------+-----+---------+               |
             |               |     |                         |
             v               v     v                         |
     +-------+---+   +------+--+  +--------+                |
     |  Export    |   | Import  |  | Git    |                |
     |  Pipeline  |   | Pipeline|  | Sync   |                |
     +-------+---+   +------+--+  +---+----+                |
             |               |         |                     |
             v               v         v                     |
     +-------+---------------+---------+---------------------+--+
     |                   @agent-platform/project-io              |
     |                                                           |
     |  export/   import/   dependencies/  diff/  ownership/ git/|
     +---------------------------+-------------------------------+
                                 |
                                 v
                    +------------+------------+
                    |     MongoDB             |
                    | (ProjectAgent, Project, |
                    |  ProjectTool, etc.)     |
                    +------------+------------+
                                 |
                    +------------+------------+
                    |     Redis               |
                    | (distributed locks,     |
                    |  circuit breaker state) |
                    +-------------------------+
```

### 2.2 Component Architecture

The package is organized into 7 sub-modules:

| Module            | Responsibility                                                            | Key Files                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **export/**       | Serialize project entities to canonical file structure                    | `project-exporter.ts`, `folder-builder.ts`, `manifest-generator.ts`, `lockfile-generator.ts`, `env-var-scanner.ts`, `deployment-exporter.ts`, `layer-assemblers/*`                                                 |
| **import/**       | Parse file structure back into domain entities with validation            | `project-importer.ts`, `folder-reader.ts`, `import-validator.ts`, `import-applier.ts`, `staged-importer.ts`, `post-import-validator.ts`, `entity-schemas.ts`, `cross-ref-resolver.ts`, `layer-disassemblers/*`     |
| **dependencies/** | Build and validate the inter-agent/tool dependency graph                  | `dependency-graph.ts`, `dependency-extractor.ts`, `circular-detector.ts`                                                                                                                                           |
| **diff/**         | Section-level ABL diff engine for import preview                          | `abl-differ.ts`, `section-splicer.ts`, `import-diff-calculator.ts`                                                                                                                                                 |
| **ownership/**    | Agent ownership tracking, edit/deploy locking, permission resolution      | `ownership-service.ts`, `lock-service.ts`, `permission-checker.ts`                                                                                                                                                 |
| **git/**          | Multi-provider Git integration with sync, conflict resolution, branching  | `github-provider.ts`, `gitlab-provider.ts`, `bitbucket-provider.ts`, `generic-git-provider.ts`, `git-sync-service.ts`, `conflict-resolver.ts`, `branch-manager.ts`, `webhook-handler.ts`, `git-circuit-breaker.ts` |
| **types.ts**      | Shared type definitions (manifests, lockfiles, layers, dependencies, git) | Single file, ~570 lines                                                                                                                                                                                            |

### 2.3 Export Pipeline Flow

```
ProjectData (agents, tools, profiles, connections, ...)
    |
    v
[1] Dependency Graph Construction
    - Extract handoff, delegate, tool_import, profile_use edges
    - Detect circular dependencies
    |
    v
[2] Entry Agent Detection
    - Look for SUPERVISOR keyword in DSL
    - Fall back to entryAgentName from project metadata
    |
    v
[3] Layer Assembly (v2 only)
    - Wave 1: core + connections (sequential dependency)
    - Wave 2: guardrails, workflows, evals, search, channels, vocabulary (parallel)
    - Each assembler queries DB and serializes to file paths
    |
    v
[4] File Map Construction
    - agents/<name>.agent.abl
    - tools/<name>.tools.abl
    - profiles/<name>.profile.abl
    - connections/<name>.json, guardrails/<name>.json, etc. (v2)
    |
    v
[5] Env Var Scanning
    - Extract {{env.KEY}} and {{secrets.KEY}} references
    - Extract AUTH: profile references
    |
    v
[6] Manifest Generation
    - Project metadata, agent registry, tool registry
    - Dependency edges, env var requirements
    - v2: layer inclusion list, entity counts, connector/MCP requirements
    |
    v
[7] Lockfile Generation
    - Per-entity SHA-256 content hashes
    - Per-layer hashes (v2)
    - HMAC integrity hash
    |
    v
ExportResult { files: Map<string, string>, manifest, lockfile, warnings }
```

### 2.4 Import Pipeline Flow

```
files: Map<string, string>
    |
    v
[1] Path Normalization
    - Strip common prefix (handles nested folders)
    - Validate: no .., /, \0, \\ (path traversal prevention)
    |
    v
[2] Folder Reading
    - Classify files: agents, tools, profiles, configs, locales, connections, etc.
    - Parse project.json manifest
    - v2: detect included layers from directory structure
    |
    v
[3] Manifest Validation (if present)
    - Schema validation
    - Cross-reference: manifest agents match actual files
    |
    v
[4] Content Validation
    - DSL syntax validation per file (with line-level error reporting)
    - Entity schema validation (Zod) for JSON entities
    - Dependency validation (missing references, circular deps)
    - v2: SHA integrity verification against lockfile
    - v2: Cross-layer dependency validation
    |
    v
[5] Diff Computation
    - Section-level ABL diff for agents (GOAL, TOOLS, HANDOFF_TARGETS, etc.)
    - File-level diff for tools, profiles, configs
    - Classify: added, modified, removed, unchanged
    |
    v
[6] Apply Operations Computation
    - v1: agent-only create/update/delete operations
    - v2: all entity types (agents, tools, profiles, locales, configs)
    |
    v
[7a] Preview Mode (dry-run)
    - Return preview with diffs, validation results, warnings
    - No database mutations
    |
    v
[7b] Apply Mode
    - v1: Bulk insertMany + bulkWrite + deleteMany with rollback
    - v2: Staged import (stage -> activate -> cleanup) with per-layer rollback
    - Distributed lock prevents concurrent imports
    |
    v
[8] Post-Import Validation
    - Report missing env vars, unlinked connectors, MCP auth needs
    - Classify: ready | imported_with_warnings | action_required
    |
    v
ImportResult { success, preview, operations, warnings }
```

---

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

**Approach:** Every database query in the route layer includes `tenantId` from `req.tenantContext`. Cross-tenant access returns 404, not 403.

**Implementation:**

- Route: `Project.findOne({ _id: projectId, tenantId })` -- never `findById`
- ProjectAgent queries filter by `projectId` (tenant-scoped via Project)
- ProjectTool queries include both `projectId` and `tenantId`
- Import lock key includes `projectId` (inherently tenant-scoped)

**Gap:** ProjectAgent has no direct `tenantId` field; isolation is via `projectId -> Project.tenantId` join. If a race condition allows an agent to be created with a projectId from another tenant, isolation is breached. Mitigation: the `requireProjectScope` middleware validates project ownership before any handler runs.

### 3.2 Authentication and Authorization

**Approach:** Centralized auth via `authMiddleware` + `requireProjectScope` + `requireProjectPermission`.

**Permissions:**

- Export (preview + full): requires `project:export` (admin, developer, viewer)
- Import (preview + apply): requires `project:import` (admin, developer -- not viewer)

**Implementation:** Permission check is the first operation in each route handler, before any DB queries.

### 3.3 Data Integrity

**Approach:** Multi-layer integrity verification.

1. **Lockfile hashes:** Every exported entity gets a SHA-256 content hash. The lockfile includes an HMAC integrity hash over all individual hashes.
2. **Import validation:** DSL syntax checked per file; Zod schemas validate JSON entities; dependency graph validated for missing/circular references.
3. **Staged import:** v2 import uses a 3-phase approach (stage -> activate -> cleanup) where new records are created with `status: 'staged'` before being atomically swapped to `active`.
4. **Rollback:** On activation failure, completed layers are rolled back (staged -> deleted, superseded -> restored).

### 3.4 Performance and Scalability

**Approach:** Bounded operations with size guards.

| Guard                    | Limit                                          | Purpose                                  |
| ------------------------ | ---------------------------------------------- | ---------------------------------------- |
| MAX_EXPORT_AGENTS        | 1,000                                          | Prevent OOM during file map construction |
| MAX_EXPORT_TOOLS         | 500                                            | Same                                     |
| MAX_EXPORT_RESPONSE_SIZE | 100MB                                          | Prevent response buffer overflow         |
| MAX_IMPORT_FILE_SIZE     | 1MB per file                                   | Prevent individual file abuse            |
| MAX_IMPORT_TOTAL_SIZE    | 50MB total                                     | Prevent memory exhaustion                |
| MAX_IMPORT_FILE_COUNT    | 500 files                                      | Prevent directory traversal cost         |
| MAX_IMPORT_BODY_SIZE     | 60MB                                           | Express body parser limit                |
| LAYER_SIZE_LIMITS        | Per-layer (e.g., 1000 agents, 200 connections) | v2 per-layer caps                        |

**Benchmarks:** Export of 100 agents completes in < 5 seconds (tested in `export-performance.test.ts`).

**Scalability path:** For projects exceeding limits, streaming export (ZIP/tar.gz with chunked response) is a planned P2 enhancement.

### 3.5 Concurrency Control

**Approach:** Distributed Redis lock for import operations.

- Lock key: `import:lock:<projectId>`
- Lock owner: unique token (`import-<timestamp>-<random>`)
- TTL: 120 seconds (2 minutes max)
- Acquisition: `SET NX PX` (atomic)
- Release: Lua script (atomic compare-and-delete to prevent releasing expired/reacquired locks)
- Fallback: In dev without Redis, lock is skipped (`'no-redis'` token)

**Concurrent export** is safe (read-only, no lock needed).

### 3.6 Error Handling

**Approach:** Standard error envelope with structured error codes.

```typescript
// Success
{ success: true, data: ... }

// Failure
{ success: false, error: { code: 'IMPORT_APPLY_FAILED', message: '...' } }
```

**Error categories:**

- Validation errors (400): invalid folder, invalid manifest, syntax errors, path traversal
- Auth errors (403): insufficient permissions
- Not found (404): project not found (or cross-tenant)
- Conflict (409): concurrent import in progress
- Payload too large (413): body exceeds limit
- Internal (500): unexpected failures, logged with context

**Rollback errors** are logged separately and do not mask the original error.

### 3.7 Observability

**Approach:** Structured logging via `createLogger('project-io-route')`.

Every operation logs:

- `projectId`, `tenantId` (always)
- `agentCount`, `toolCount`, `fileCount` (export)
- `created`, `updated`, `deleted` (import apply)
- `responseSizeBytes` (export response size monitoring)
- Errors include full context with safe error extraction

**Gap:** No integration with the platform trace/audit pipeline. Import/export operations are logged but not emitted as `TraceEvent`s. This is a known gap (P1).

### 3.8 Backward Compatibility

**Approach:** v1/v2 coexistence with migration support.

- **v1 export** (agent-only file map) remains the default REST API behavior
- **v2 export** (layered) is available via the library API for programmatic consumers
- **v1 import** (agent-only operations) is the default REST API behavior
- **v2 import** (multi-layer staged) is available via the library API
- **v1-to-v2 migration**: `migrateV1ToV2()` auto-detects v1 manifests and upgrades
- **Manifest versioning**: `format_version: '1.0'` vs `format_version: '2.0'`

The REST API currently uses v1 orchestrators. Upgrading to v2 at the route level is a P1 gap.

### 3.9 Security

**Path traversal prevention:** Import validates every file path rejects `..`, leading `/`, null bytes (`\0`), and backslashes (`\\`).

**Credential protection:** Auth profiles export only names/references, never secrets or tokens. Connections strip credential fields during export.

**Input validation:** All payloads validated with Content-Length pre-check, Express body parser limits, per-file size limits, total size limits, and file count limits.

**Webhook security:** Provider-specific signature verification (GitHub HMAC-SHA256, GitLab token header, Bitbucket IP allowlist).

**Rate limiting:** Tenant-scoped rate limiter (`tenantRateLimit('request')`) applies to all endpoints.

### 3.10 Deployment and Operations

**Deployment model:** The `@agent-platform/project-io` package is a build-time dependency of `apps/runtime`. No separate service deployment.

**Configuration:** All limits are compile-time constants in the route file. No runtime configuration needed.

**Health monitoring:** Export response size is logged; operators can alert on large responses approaching the 100MB limit.

**Disaster recovery:** Export provides the backup mechanism itself. Regular automated exports (via CI/CLI/MCP) can serve as backup strategy.

### 3.11 Extensibility

**Layer system:** New entity types are added by:

1. Creating a new `LayerAssembler` implementation in `export/layer-assemblers/`
2. Creating a matching `LayerDisassembler` in `import/layer-disassemblers/`
3. Adding a Zod entity schema in `import/entity-schemas.ts`
4. Adding the layer name to the `LayerName` union type
5. Updating `LAYER_DEFAULTS` and `LAYER_SIZE_LIMITS`

**Git providers:** New providers implement the `GitProvider` interface and are registered in `provider-factory.ts`.

**Import strategies:** The `conflictStrategy` option currently supports `'replace'` and `'skip'`; new strategies (e.g., `'merge'`) can be added without changing the import orchestrator.

### 3.12 Testing Strategy

**Three-layer testing:**

1. **Unit tests** (60 files): Pure function tests for every sub-module. ~85% coverage.
2. **Integration tests** (1 file + 10 planned): Cross-module tests with in-memory adapters.
3. **E2E tests** (0 real + 12 planned): Full HTTP API tests with real servers.

**Critical gap:** The existing route test file (`project-io-routes.test.ts`) mocks ALL dependencies. It tests the Express routing/middleware wiring but NOT the actual import/export logic, DB operations, or distributed locking. See test spec for the 12 planned E2E scenarios.

---

## 4. Data Model

### 4.1 Archive Format (v2)

```
project-root/
  project.json          # Manifest (metadata, registries, deps, env vars)
  abl.lock              # Lockfile (content hashes, integrity)
  agents/
    supervisor.agent.abl
    worker-a.agent.abl
  tools/
    search.tools.abl
    crm.tools.abl
  profiles/
    high-security.profile.abl
  configs/
    model-overrides.yaml
  locales/
    en.yaml
    es.yaml
  deployments/
    production.json
    staging.json
  connections/
    github-api.json
    database.json
  guardrails/
    pii-filter.json
    content-safety.json
  workflows/
    approval.json
    escalation.json
  evals/
    accuracy-test.json
  search/
    knowledge-base.json
  channels/
    web-widget.json
    slack.json
  vocabulary/
    domain-terms.json
```

### 4.2 Database Models (consumed by route layer)

| Model          | Collection      | Key Fields                                              | Isolation                          |
| -------------- | --------------- | ------------------------------------------------------- | ---------------------------------- |
| `Project`      | `projects`      | `_id`, `tenantId`, `name`, `slug`, `entryAgentName`     | `tenantId`                         |
| `ProjectAgent` | `projectagents` | `_id`, `projectId`, `name`, `dslContent`, `sourceHash`  | `projectId` (via Project.tenantId) |
| `ProjectTool`  | `projecttools`  | `_id`, `projectId`, `tenantId`, `name`, `dslContent`    | `tenantId` + `projectId`           |
| `Deployment`   | `deployments`   | `_id`, `projectId`, `tenantId`, `environment`, `status` | `tenantId` + `projectId`           |

### 4.3 Redis Keys

| Key Pattern               | Purpose                      | TTL  |
| ------------------------- | ---------------------------- | ---- |
| `import:lock:<projectId>` | Concurrent import protection | 120s |

---

## 5. API Design

### 5.1 REST Endpoints

| Method | Path                                                 | Permission       | Description      |
| ------ | ---------------------------------------------------- | ---------------- | ---------------- |
| `GET`  | `/api/projects/:projectId/project-io/export/preview` | `project:export` | Metadata preview |
| `GET`  | `/api/projects/:projectId/project-io/export`         | `project:export` | Full export      |
| `POST` | `/api/projects/:projectId/project-io/import/preview` | `project:import` | Dry-run import   |
| `POST` | `/api/projects/:projectId/project-io/import`         | `project:import` | Apply import     |

### 5.2 Export Response Shape

```json
{
  "success": true,
  "manifest": { "name": "...", "slug": "...", "agents": {}, "tools": {}, ... },
  "lockfile": { "lockfile_version": "1.0", "agents": {}, "tools": {}, "integrity": "..." },
  "files": {
    "project.json": "...",
    "abl.lock": "...",
    "agents/supervisor.agent.abl": "SUPERVISOR: ...",
    "tools/search.tools.abl": "..."
  },
  "warnings": []
}
```

### 5.3 Import Request Shape

```json
{
  "files": {
    "agents/supervisor.agent.abl": "SUPERVISOR: ...",
    "agents/worker.agent.abl": "AGENT: ...",
    "tools/search.tools.abl": "..."
  }
}
```

### 5.4 Import Response Shape

```json
{
  "success": true,
  "applied": {
    "created": 1,
    "updated": 1,
    "deleted": 0
  }
}
```

---

## 6. Alternatives Considered

### Alternative 1: ZIP/tar.gz as Primary Format

**Approach:** Export as a binary archive file instead of a JSON file map.

**Pros:**

- Smaller response size (compressed)
- Standard format understood by all tools
- Can include binary assets natively

**Cons:**

- Not JSON-serializable (requires multipart/form-data or base64 encoding)
- Harder to inspect/modify individual files
- Requires decompression before validation
- MCP tools work better with JSON

**Decision:** REJECTED as primary format. JSON file map is the primary format for API ergonomics. ZIP/tar.gz is a planned P2 conversion layer for CLI/download use cases.

### Alternative 2: Database Dump Instead of DSL-Based Export

**Approach:** Export raw MongoDB documents (BSON/JSON) instead of DSL files.

**Pros:**

- Perfect fidelity -- every field preserved
- No serialization/deserialization logic needed
- Simpler implementation

**Cons:**

- Not human-readable
- Tightly coupled to MongoDB schema (schema changes break imports)
- Includes internal fields (\_id, timestamps, version counters)
- Cannot be version-controlled in Git
- Cannot be edited by hand or by AI tools
- Violates the ABL philosophy of DSL as source of truth

**Decision:** REJECTED. The ABL DSL is the canonical representation. Export/import preserves the DSL as the source of truth, with the manifest providing metadata.

### Alternative 3: Event Sourcing for Import

**Approach:** Instead of bulk write operations, emit import events that are processed by a queue.

**Pros:**

- Naturally async and scalable
- Built-in audit trail
- Can replay/undo imports

**Cons:**

- Significantly more complex
- Eventually consistent (user cannot immediately see results)
- Requires event store infrastructure
- Overkill for current project sizes (< 1000 agents)

**Decision:** REJECTED for current scope. The staged import (v2) provides sufficient safety with per-layer rollback. Event sourcing may be reconsidered if projects exceed 10,000 entities.

---

## 7. Migration Strategy

### v1 to v2 Transition

The v2 layered format is backward-compatible with v1:

1. **Detection:** `format_version` field in `project.json` (absent = v1, `'1.0'` = v1, `'2.0'` = v2)
2. **Migration:** `migrateV1ToV2()` function auto-detects v1 format and:
   - Wraps flat agent files into `agents/` directory
   - Generates a v2 manifest from v1 manifest fields
   - Adds empty layer sections for non-core layers
3. **Route upgrade:** The REST API currently uses v1 orchestrators. Upgrading to v2 requires:
   - Adding layer parameters to export query
   - Wiring v2 import orchestrator with staged import
   - Adding DB adapter implementations for the `StagedImporter`

---

## 8. Risk Assessment

| Risk                                | Likelihood | Impact   | Mitigation                                                                             |
| ----------------------------------- | ---------- | -------- | -------------------------------------------------------------------------------------- |
| Export OOM on very large projects   | LOW        | HIGH     | Size guards at 1000 agents, 500 tools, 100MB response                                  |
| Import corrupts project state       | LOW        | CRITICAL | Staged import with per-layer rollback; distributed lock prevents concurrent corruption |
| Git provider API changes break sync | MEDIUM     | MEDIUM   | Provider interface abstraction; circuit breaker prevents cascading failures            |
| Lockfile integrity bypass           | LOW        | HIGH     | HMAC-SHA256 prevents tampering; server-side validation before apply                    |
| Path traversal exploitation         | LOW        | CRITICAL | Multi-layer validation (route-level + import validator); rejects `..`, `/`, `\0`, `\\` |
| v1/v2 format confusion              | MEDIUM     | LOW      | Auto-detection + migration; clear error messages for format mismatches                 |
