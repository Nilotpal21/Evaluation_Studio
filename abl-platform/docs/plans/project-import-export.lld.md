# Project Import/Export -- Low-Level Design

## Implementation Structure

The feature is implemented across one primary package with route and client integrations:

```
@agent-platform/project-io (packages/project-io/)
    ├── src/types.ts                 -- All shared types (~572 LOC)
    ├── src/index.ts                 -- Barrel exports from all submodules
    ├── src/export/
    │   ├── project-exporter.ts      -- Export orchestrator (v1 and v2)
    │   ├── folder-builder.ts        -- Canonical folder path generation
    │   ├── manifest-generator.ts    -- Manifest v1 and v2 generation
    │   ├── lockfile-generator.ts    -- Lockfile with SHA-256 hashing
    │   ├── deployment-exporter.ts   -- Deployment manifest export
    │   ├── env-var-scanner.ts       -- Env var/secret reference scanning
    │   └── layer-assemblers/
    │       ├── types.ts             -- LayerAssembler, LayerQueryContext
    │       ├── index.ts             -- Exports all 8 assemblers
    │       ├── core-assembler.ts    -- Agents, tools, profiles
    │       ├── connections-assembler.ts
    │       ├── guardrails-assembler.ts
    │       ├── workflows-assembler.ts
    │       ├── evals-assembler.ts
    │       ├── search-assembler.ts
    │       ├── channels-assembler.ts
    │       └── vocabulary-assembler.ts
    ├── src/import/
    │   ├── project-importer.ts      -- v1 import orchestrator
    │   ├── project-importer-v2.ts   -- v2 import orchestrator
    │   ├── folder-reader.ts         -- Folder structure parser (v1 and v2)
    │   ├── manifest-validator.ts    -- Manifest schema + file ref validation
    │   ├── import-validator.ts      -- ABL syntax, SHA, cross-layer validation
    │   ├── import-applier.ts        -- Compute create/update/delete operations
    │   ├── tool-extractor.ts        -- Extract tools from imported files
    │   ├── path-normalizer.ts       -- Strip common prefix
    │   ├── v1-migration.ts          -- v1-to-v2 format migration
    │   ├── staged-importer.ts       -- 3-phase staged import with rollback
    │   └── post-import-validator.ts -- Post-import validation report
    ├── src/dependencies/
    │   ├── dependency-extractor.ts  -- Extract deps from DSL
    │   ├── dependency-graph.ts      -- Build and validate graph
    │   └── circular-detector.ts     -- Cycle detection
    ├── src/diff/
    │   ├── abl-differ.ts            -- Section-level ABL diff
    │   ├── section-splicer.ts       -- Section identification and splicing
    │   └── import-diff-calculator.ts -- Per-agent diff for import preview
    ├── src/ownership/
    │   ├── permission-checker.ts    -- RBAC permission resolution
    │   ├── ownership-service.ts     -- Agent ownership tracking
    │   └── lock-service.ts          -- Edit/deploy lock management
    ├── src/git/
    │   ├── git-provider.ts          -- Abstract provider interface
    │   ├── github-provider.ts       -- GitHub REST API implementation
    │   ├── gitlab-provider.ts       -- GitLab REST API implementation
    │   ├── bitbucket-provider.ts    -- Bitbucket REST API implementation
    │   ├── generic-git-provider.ts  -- Generic provider
    │   ├── git-sync-service.ts      -- Push/pull orchestrator
    │   ├── conflict-resolver.ts     -- Three-way conflict resolution
    │   ├── webhook-handler.ts       -- Webhook verification and parsing
    │   ├── branch-manager.ts        -- Branch operations
    │   ├── git-circuit-breaker.ts   -- Circuit breaker for API calls
    │   └── provider-factory.ts      -- Provider creation from config
    └── src/module-release/
        ├── build-module-release.ts  -- Module release builder
        ├── module-contract.ts       -- Contract extraction
        ├── module-selector.ts       -- Module selector resolution
        ├── module-publish-safety.ts -- Publish safety validation
        ├── source-hash.ts           -- Module source hash computation
        └── config-overrides-validator.ts -- Config override validation

apps/runtime/src/routes/project-io.ts -- REST API (4 endpoints)
apps/studio/src/api/project-io.ts     -- Studio API client
```

---

## Module Detail: types.ts

### Section Splicer Types

- `SectionBoundary`: name, startLine, endLine, headerLine
- `SectionEdit`: section name and replacement content

### ABL Diff Types

- `SectionStatus`: 'added' | 'removed' | 'modified' | 'unchanged'
- `ABLDiffResult`: hasChanges flag, section diffs array, summary counts

### Dependency Types

- `DependencyType`: 'handoff' | 'delegate' | 'tool_import' | 'inline_handoff' | 'profile_use'
- `DependencyGraph`: agents, toolFiles, edges, adjacency map, reverse adjacency map
- `DependencyValidation`: valid flag, missing edges, circular paths

### Project Manifest Types (v1 and v2)

v1 `ProjectManifest`:

- `abl_version: '1.0'`, `dsl_format: 'yaml'`
- `agents: Record<string, ManifestAgent>`, `tools: Record<string, ManifestTool>`
- `dependencies: { agent_references, tool_imports }`

v2 `ProjectManifestV2`:

- `format_version: '2.0'`
- `layers_included: LayerName[]`
- `metadata: { entity_counts, required_env_vars, required_connectors, required_mcp_servers, required_auth_profiles }`

### Lockfile Types (v1 and v2)

v1 `LockFile`:

- `lockfile_version: '1.0'`
- `agents: Record<string, { version, source_hash, status }>`
- `tools: Record<string, { source_hash }>`
- `integrity: string` (overall hash)

v2 `LockFileV2`:

- `lockfile_version: '2.0'`
- Per-layer hash records: `connections`, `guardrails`, `workflows`, `evals`, `search`, `channels`, `vocabulary`
- `layer_hashes: Partial<Record<LayerName, string>>`
- `integrity: string`

### Layer Types

8 layers: `'core' | 'connections' | 'guardrails' | 'workflows' | 'evals' | 'search' | 'channels' | 'vocabulary'`

Layer defaults:

- `core` and `connections`: `'always'` (cannot be deselected)
- `guardrails` and `workflows`: `'on'` (included by default, can be deselected)
- `evals`, `search`, `channels`, `vocabulary`: `'off'` (excluded by default, can be selected)

Layer size limits:

- core: 1000 agents, connections: 200, guardrails: 100, workflows: 200
- evals: 500, search: 100, channels: 50, vocabulary: 10000

### Import v2 Types

- `ImportPhaseV2`: 'queued' | 'validating' | 'staging' | 'resolving_refs' | 'activating' | 'completed' | 'failed' | 'rolling_back' | 'cancelled'
- `ImportOptionsV2`: projectId, tenantId, userId, layers (optional), conflictStrategy ('replace' | 'skip'), dryRun, authProfileMapping, onProgress callback
- `ImportResultV2`: operationId, phase, preview, postImportReport (status, provisioning_required, warnings, layer_summary)
- `ImportPreviewV2`: per-layer changes, SHA integrity results, cross-layer dependency validation

### Git Types

- `GitProviderType`: 'github' | 'gitlab' | 'bitbucket' | 'generic'
- `ConflictStrategy`: 'manual' | 'local_wins' | 'remote_wins'
- `ConflictDetail`: agentName, file, baseContent, localContent, remoteContent
- `GitSyncConfig`: autoSync, autoDeploy, conflictStrategy

---

## Module Detail: Export Pipeline

### exportProject (v1)

```typescript
function exportProject(data: ProjectData, options: ExportOptions): ExportResult;
```

1. Validate: at least one agent exists
2. `buildFileMap(data.agents, data.toolFiles)` -> canonical `agents/{name}.agent.yaml` and `tools/{slug}.tools.abl` paths
3. `buildDependencyGraph(agentEntries, toolEntries)` -> dependency edges
4. `generateManifest(manifestInput)` -> `project.manifest.json`
5. `generateLockfile(lockfileInput)` -> `project.lock.json` with SHA-256 hashes
6. If `includeDeployments`: `exportDeployments(data.deployments)` -> `deployments/` files
7. Return `{ success, manifest, files, lockfile, warnings }`

### exportProjectV2

```typescript
function exportProjectV2(
  data: ProjectData,
  deps: ExportV2Deps,
  options: ExportOptionsV2,
): Promise<ExportResultV2>;
```

1. `resolveLayers(options.layers)` -> resolve 'always' layers + selected layers
2. For each layer: call `assembler.assemble(queryContext)` -> `LayerAssemblyResult { files, entityCount, warnings }`
3. Check `LAYER_SIZE_LIMITS` for each layer
4. `generateManifestV2()` with metadata (entity counts, env vars, connectors, MCP servers, auth profiles)
5. `generateLockfileV2()` with per-layer hashes and overall integrity
6. Merge all layer files + manifest + lockfile
7. Return `ExportResultV2`

### Layer Assembler Interface

```typescript
interface LayerAssembler {
  readonly layer: LayerName;
  assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult>;
  countEntities(ctx: LayerQueryContext): Promise<number>;
}
```

Each assembler is independent: queries its own database models, serializes entities to files, returns file map and counts. `LayerQueryContext` provides `projectId`, `tenantId`, `includeDeployments`, and `dslFormat`.

### Lockfile Integrity

SHA-256 hashing:

- `computeSourceHash(content)` -> SHA-256 hex digest of file content
- `computeLayerHash(files)` -> SHA-256 of sorted file paths + content hashes
- Lockfile `integrity` field -> SHA-256 of all layer hashes concatenated

---

## Module Detail: Import Pipeline

### importProject (v1)

```typescript
function importProject(
  files: Map<string, string>,
  existingState: ExistingProjectState,
  options: ImportOptions,
): ImportResult;
```

1. `stripCommonPrefix(files)` -> remove shared directory prefix
2. `readFolder(normalizedFiles)` -> parse agents, tools, manifest, locale files
3. `validateManifest()` -> schema and file reference validation
4. `validateImport()` -> ABL syntax (AGENT/SUPERVISOR header check) + dependency graph
5. `extractToolsFromFiles()` -> extract tool definitions
6. `calculateImportDiffs()` -> per-agent section-level diffs against existing state
7. `computeApplyOperations()` -> create/update/delete agent operations
8. `computeToolApplyOperations()` -> create/update/delete tool operations
9. Return `ImportResult { success, preview, operations, toolOperations }`

### importProjectV2

```typescript
function importProjectV2(
  files: Map<string, string>,
  deps: ImportV2Deps,
  options: ImportOptionsV2,
): Promise<ImportResultV2>;
```

Additional v2 steps:

1. `detectLayers(files)` -> auto-detect which layers are present
2. `verifySHAIntegrity(folderResult, lockfile)` -> verify all file hashes match lockfile
3. `validateCrossLayerDeps()` -> ensure cross-layer references resolve
4. If `dryRun`: return preview without applying
5. `StagedImporter.execute()` -> 3-phase staged import
6. `validatePostImport()` -> generate provisioning report

### StagedImporter

3-phase import with per-layer activation:

```
Phase 1: STAGE
  For each layer in activation order:
    Insert records with status: 'staged'
    Track stagedRecordIds per collection

Phase 2: ACTIVATE
  For each layer in ACTIVATION_ORDER:
    Set staged records -> status: 'active'
    Set existing records -> status: 'superseded'
    Track supersededRecordIds per collection
  On failure:
    Rollback completed layers:
      Set staged -> 'deleted'
      Set superseded -> 'active'

Phase 3: CLEANUP (async)
  Delete all records with status: 'superseded'
  Delete all records with status: 'deleted'
```

Activation order (dependencies before dependents):
`connections -> core -> search -> workflows -> guardrails -> evals -> channels -> vocabulary`

### Import Validation

Three levels of validation:

1. **ABL Syntax**: Check that agent files have valid `AGENT:` or `SUPERVISOR:` headers
2. **Dependency Integrity**: Build dependency graph, detect missing references, detect circular dependencies
3. **v2 SHA Integrity**: Verify each file's SHA-256 matches the lockfile entry
4. **v2 Cross-Layer**: Verify that cross-layer references (e.g., agent references tool from connections layer) resolve

---

## Module Detail: Dependency Analysis

### extractDependencies

```typescript
function extractDependencies(agentName: string, dslContent: string): AgentDependency[];
```

Parses DSL to extract:

- `handoff` / `delegate` references to other agents
- `tool_import` references to tool files
- `inline_handoff` for inline handoff definitions
- `profile_use` for behavior profile references

### buildDependencyGraph

```typescript
function buildDependencyGraph(agents: AgentEntry[], toolFiles: ToolFileEntry[]): DependencyGraph;
```

Builds adjacency and reverse adjacency maps. Returns graph with edges, agent names, and tool file names.

### detectCircularDependencies

Uses DFS with color marking (white/gray/black) to find back edges. Returns arrays of cycle paths.

### validateDependencies

Checks that all dependency targets exist in the graph. Returns missing edges and circular dependency paths.

---

## Module Detail: Diff Engine

### identifySections

```typescript
function identifySections(content: string): SectionBoundary[];
```

Scans DSL content line-by-line to identify section headers (e.g., `AGENT:`, `TOOLS:`, `HANDOFF:`) with start/end line numbers.

### diffABL

```typescript
function diffABL(before: string, after: string): ABLDiffResult;
```

Compares two ABL DSL strings section-by-section. Identifies added, removed, modified, and unchanged sections.

### calculateImportDiffs

Computes per-agent diffs for import preview by comparing imported agent DSL against existing agent DSL in the project.

---

## Module Detail: Git Integration

### GitProvider Interface

```typescript
interface GitProvider {
  readonly providerName: string;
  validateConnection(): Promise<ConnectionValidationResult>;
  listFiles(branch: string, path?: string): Promise<GitFile[]>;
  getFile(branch: string, path: string): Promise<GitFile | null>;
  pullProject(branch: string, syncPath: string): Promise<PullResult>;
  pushFiles(branch, files, commitMessage, committer): Promise<PushResult>;
  createBranch(name: string, fromBranch: string): Promise<GitBranch>;
  createPullRequest(params: PRParams): Promise<CreatePRResult>;
  listCommits(branch: string, limit?: number): Promise<GitCommit[]>;
  registerWebhook(callbackUrl, secret): Promise<string>;
  removeWebhook(webhookId: string): Promise<void>;
  getDiff(baseCommit, headCommit): Promise<PullResult>;
}
```

Implementations: `GitHubProvider`, `GitLabProvider`, `BitbucketProvider`, `GenericGitProvider`

### GitSyncService

```typescript
class GitSyncService {
  constructor(provider: GitProvider, circuitBreakerConfig?: Partial<GitCircuitBreakerConfig>);
  async push(options: PushOptions): Promise<SyncResult>;
  async pull(options: PullOptions): Promise<SyncResult>;
}
```

**Push flow**:

1. Export project via `exportProject()`
2. Pull current remote state
3. If `lastSyncCommit` is set: `checkConflicts()` with three-way comparison
4. If conflicts and `conflictStrategy === 'manual'`: return conflicts to caller
5. If conflicts and auto-resolve: `autoResolveConflicts()` with chosen strategy
6. `provider.pushFiles()` with commit message and committer
7. Optionally `provider.createPullRequest()` if `createPR` option set
8. Return `SyncResult` with commit SHA and changes summary

**Pull flow**:

1. `provider.pullProject()` from specified branch
2. Convert git files to import file map
3. `importProject()` against existing state
4. Return `SyncResult` with changes summary

### Conflict Resolver

```typescript
function checkConflicts(inputs: ThreeWayInput[]): ConflictCheckResult[];
function autoResolveConflicts(
  conflicts: ConflictDetail[],
  strategy: ConflictStrategy,
): ConflictResolution[];
```

Three-way comparison: base (last sync commit), local (current project state), remote (git HEAD).

- If local === base: accept remote (no local changes)
- If remote === base: keep local (no remote changes)
- If local === remote: no conflict (same changes)
- Otherwise: conflict detected

### GitCircuitBreaker

Wraps all git provider API calls. States: closed (normal), open (failing, reject immediately), half-open (testing recovery).

- Configurable failure threshold, reset timeout
- Prevents cascading failures when git providers are down
- Throws `GitCircuitBreakerError` when circuit is open

### Webhook Handler

```typescript
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean;
function parseWebhookPayload(body: unknown): WebhookPayload;
function hasRelevantChanges(payload: WebhookPayload): boolean;
```

- HMAC-SHA256 signature verification
- Extracts push details (branch, commits, changed files)
- Filters to changes affecting agent files (`.agent.yaml`, `.agent.abl`, `.tools.abl`)

---

## Module Detail: Ownership

### PermissionChecker

```typescript
function canPerform(context: PermissionContext, operation: AgentOperation): boolean;
function resolvePermissions(context: PermissionContext): AgentOperation[];
```

Resolves permissions based on project role and team role. Operations: `view`, `edit`, `deploy`, `delete`, `transfer_ownership`.

### OwnershipService

Tracks agent ownership (user or team). Supports ownership transfer and ownership queries.

### LockService

Manages edit/deploy locks per agent. Supports lock acquisition, release, and conflict detection. Locks have TTL to prevent indefinite locking.

---

## Module Detail: Module Release

### buildModuleRelease

```typescript
function buildModuleRelease(input: ModuleReleaseInput): ModuleReleaseBuildResult;
```

Builds a publishable module from a subset of project agents and tools. Includes:

1. `extractModuleContract()` -> defines the public interface (inputs, outputs, config)
2. `validatePublishSafety()` -> checks for unsafe patterns (hardcoded credentials, PII)
3. `computeModuleSourceHash()` -> deterministic hash for content-addressed versioning

### resolveSelector

```typescript
function resolveSelector(selector: ModuleSelector): ModuleSelectorResult;
```

Resolves a module selector (name@version, name@latest, name@sha) to a specific module release.

### validateConfigOverrides

```typescript
function validateConfigOverrides(
  overrides: Record<string, unknown>,
  contract: ContractConfigKey[],
): ConfigOverrideValidationResult;
```

Validates that config overrides provided at module installation time conform to the module's contract.

---

## Module Detail: Runtime REST API

### Route: GET /export/preview

1. `requireProjectPermission(req, res, 'project:export')`
2. `Project.findOne({ _id: projectId, tenantId })` -- tenant isolation
3. Query `ProjectAgent.find({ projectId })` and `ProjectTool.find({ projectId, tenantId })`
4. `buildDependencyGraph()` + `validateDependencies()`
5. Return: `{ project, agents, tools, dependencies }`

### Route: GET /export

1. `requireProjectPermission(req, res, 'project:export')`
2. Query project, agents, tools, deployments (if `include_deployments=true`)
3. Size guard: `MAX_EXPORT_AGENTS` (1000), `MAX_EXPORT_TOOLS` (500)
4. `exportProject(projectData, options)` -> files, manifest, lockfile
5. Response size guard: `MAX_EXPORT_RESPONSE_SIZE` (100MB)
6. Return: `{ success, manifest, lockfile, files, warnings }`

### Route: POST /import/preview

1. `requireProjectPermission(req, res, 'project:import')`
2. `rejectOversizedContentLength` middleware
3. `importBodyParser` (60MB limit) + `importBodyErrorHandler`
4. `validateImportPayload()` -- path traversal, size per file, total size, file count
5. Query existing agents and tools for diffing
6. `importProject(files, existingState, options)` in preview mode
7. Return: `{ success, preview, error }`

### Route: POST /import

1. Same validation as preview
2. `acquireImportLock(projectId)` -- Redis `SET NX PX 120`
3. If lock not acquired: 409 Conflict
4. `importProject()` -> operations
5. Apply operations in batches:
   - `ProjectAgent.insertMany()` for creates
   - `ProjectAgent.bulkWrite()` for updates (with `$inc: { _v: 1 }`)
   - `ProjectAgent.deleteMany()` for deletes
   - Same for ProjectTool
6. On failure: rollback (`deleteMany` created records)
7. `releaseImportLock()` -- Lua atomic release
8. Return: `{ success, applied: { created, updated, deleted } }`

---

## Known Gaps

| Gap   | Description                                  | Recommendation                                               |
| ----- | -------------------------------------------- | ------------------------------------------------------------ |
| GAP-1 | No E2E tests for REST API routes             | Start real Express server, test full middleware chain        |
| GAP-2 | Git providers not tested against real APIs   | Use recorded HTTP responses (nock/msw) for integration tests |
| GAP-3 | v2 staged import not exposed via REST API    | Add v2 import route when staged import is production-ready   |
| GAP-4 | No streaming export for very large projects  | Implement chunked response for projects > 50MB               |
| GAP-5 | Module release has limited test coverage     | Add tests for edge cases in contract extraction and safety   |
| GAP-6 | No trace events emitted for observability    | Add TraceEvents for export/import operations                 |
| GAP-7 | Import rollback does not cover all v2 layers | Extend StagedImporter E2E tests against real MongoDB         |
