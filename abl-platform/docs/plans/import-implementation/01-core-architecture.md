# Section 1: Core Architecture & v2 Import Orchestrator

## Status: Design Complete | Depends On: Nothing | Blocks: Sections 2-5

---

## 1. Current State Analysis

### What exists

| Component                | File                                                      | Status                                                            |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `exportProjectV2`        | `packages/project-io/src/export/project-exporter.ts`      | Complete (8 layer assemblers)                                     |
| `importProject` (v1)     | `packages/project-io/src/import/project-importer.ts`      | Agents only -- tools, profiles, locales, configs silently dropped |
| `readFolderV2`           | `packages/project-io/src/import/folder-reader.ts`         | Complete -- parses all 8 layers into typed maps                   |
| `StagedImporter`         | `packages/project-io/src/import/staged-importer.ts`       | Complete -- 3-phase stage/activate/cleanup with rollback          |
| `migrateV1ToV2`          | `packages/project-io/src/import/v1-migration.ts`          | Complete -- upgrades v1 manifests to v2 structure                 |
| `validateCrossLayerDeps` | `packages/project-io/src/import/import-validator.ts`      | Complete -- checks agent-tool-connector references                |
| `validatePostImport`     | `packages/project-io/src/import/post-import-validator.ts` | Complete -- provisioning report                                   |
| v1 import routes         | `apps/runtime/src/routes/project-io.ts`                   | Complete but agents-only                                          |
| v2 export route (Studio) | `apps/studio/src/app/api/projects/[id]/export/route.ts`   | Complete                                                          |

### What is missing

1. **`importProjectV2` orchestrator** -- nothing ties `readFolderV2` output to `StagedImporter`
2. **Layer disassemblers** -- no reverse of `LayerAssembler` to convert file maps to `StagedRecord[]`
3. **`buildStagedRecordsFromFolder`** -- roundtrip test manually builds `StagedRecord[]` inline
4. **v2 import API routes** -- no Runtime or Studio endpoints for v2 import
5. **Async import flow** -- v1 import is synchronous; v2 needs job-based execution with progress

---

## 2. `importProjectV2` Orchestrator Function

### 2.1 Function Signature

```typescript
// packages/project-io/src/import/project-importer-v2.ts

export interface ImportOptionsV2 {
  projectId: string;
  tenantId: string;
  userId: string;
  /** Which layers to import. If omitted, auto-detected from folder contents. */
  layers?: LayerName[];
  /** Conflict strategy: 'replace' overwrites, 'skip' keeps existing, 'merge' (future) */
  conflictStrategy: 'replace' | 'skip';
  /** Whether to run validation only (dry-run preview) */
  dryRun: boolean;
  /** Auth profile ID mapping: exported profile name -> target profile ID */
  authProfileMapping?: Record<string, string>;
  /** Progress callback for async tracking */
  onProgress?: (event: ImportProgressEvent) => void;
}

export interface ImportProgressEvent {
  phase: ImportPhase;
  layer?: LayerName;
  layerStatus?: LayerImportStatus;
  message: string;
  /** 0.0 to 1.0 */
  progress: number;
  timestamp: number;
}

export interface ImportResultV2 {
  success: boolean;
  operationId: string;
  phase: ImportPhase;
  preview: ImportPreviewV2;
  postImportReport?: PostImportReport;
  warnings: string[];
  error?: { code: string; message: string };
}

export interface ImportPreviewV2 {
  valid: boolean;
  formatVersion: '1.0' | '2.0';
  layers: LayerName[];
  /** Per-layer change summary */
  layerChanges: Record<
    LayerName,
    {
      added: number;
      modified: number;
      removed: number;
      unchanged: number;
    }
  >;
  /** Detailed agent-level changes (same shape as v1 for backward compat) */
  agentChanges: ImportPreview['changes']['agents'];
  shaIntegrity: SHAVerificationResult;
  crossLayerDeps: CrossLayerValidationResult;
  syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }>;
  warnings: string[];
}

export async function importProjectV2(
  files: Map<string, string>,
  existingState: ExistingProjectStateV2,
  options: ImportOptionsV2,
  deps: ImportV2Deps,
): Promise<ImportResultV2>;
```

### 2.2 Dependency Injection

```typescript
export interface ImportV2Deps {
  /** Layer disassemblers -- convert file maps to StagedRecord[] */
  disassemblers: Map<LayerName, LayerDisassembler>;
  /** Database adapter for StagedImporter */
  dbAdapter: ImportDbAdapter;
  /** Adapter for post-import validation */
  postImportDb?: PostImportDbAdapter;
}

/** [R1 Fix: MAJ-4] Full type definition for v2 existing project state.
 * Covers all 8 layers (not just agents/tools from v1 ExistingProjectState).
 * The orchestrator populates this by querying each collection with
 * { projectId, tenantId, status: 'active' } and projecting only
 * { _id: 1, [matchField]: 1 } for efficiency.
 */
export interface ExistingProjectStateV2 extends ExistingProjectState {
  /** Existing active record IDs per collection, for superseding.
   * Key: MongoDB collection name (from COLLECTIONS constant).
   * Value: Array of { _id, ...matchFields } for each active record.
   * Example: Map {
   *   'project_agents' => [{ _id: '...', name: 'booking' }],
   *   'guardrail_policies' => [{ _id: '...', name: 'pii-filter' }],
   *   'workflows' => [{ _id: '...', name: 'approval-flow' }],
   *   ...
   * }
   */
  activeRecords: Map<string, Array<{ _id: string; [key: string]: unknown }>>;
}
```

### 2.3 Orchestration Flow

```
importProjectV2(files, existingState, options, deps)
  |
  |-- Phase 0: Format Detection & Migration
  |     |-- migrateV1ToV2(files)
  |     |-- If v1: normalize to v2 manifest, set skipLockfileVerification
  |     |-- If unsupported version: return error
  |
  |-- Phase 1: Parse & Validate
  |     |-- stripCommonPrefix(files)
  |     |-- readFolderV2(normalizedFiles)
  |     |-- detectLayers(folderResult)
  |     |-- Intersect detected layers with options.layers (if specified)
  |     |-- verifySHAIntegrity(lockfileV2, files) -- warn on mismatch, don't block
  |     |-- validateImport(agentFiles, toolFiles, profileFiles) -- syntax check
  |     |-- validateCrossLayerDeps(folderResult) -- warn on missing deps
  |     |-- onProgress({ phase: 'validating', progress: 0.2 })
  |     |-- If dryRun: return preview without applying
  |
  |-- Phase 2: Disassemble (file maps -> StagedRecord[])
  |     |-- For each layer in IMPORT_ORDER:
  |     |     |-- disassembler = deps.disassemblers.get(layer)
  |     |     |-- { records, superseded, warnings } = disassembler.disassemble(ctx)
  |     |     |-- Accumulate into allRecords[], allSuperseded[]
  |     |     |-- onProgress({ phase: 'staging', layer, progress: ... })
  |     |-- Apply auth profile mapping to connection records
  |
  |-- Phase 3: Stage Records (delegate to StagedImporter.stage)
  |     |-- importer = new StagedImporter(deps.dbAdapter)
  |     |-- stagedResult = importer.stage(projectId, tenantId, allRecords)
  |     |-- onProgress updates forwarded from staging phase
  |
  |-- Phase 2.5: Cross-Reference Resolution (post-staging, pre-activation)
  |     |-- [R1 Fix: CRIT-2/3/4] New explicit phase for resolving inter-record refs
  |     |-- resolveCrossReferences(stagedResult.recordIdMap, allRecords, deps.dbAdapter)
  |     |-- Uses batched bulkWrite per collection (not individual updates)
  |     |-- See Section 3, Section 3.12 for full algorithm
  |     |-- onProgress({ phase: 'staging', message: 'Resolving cross-references' })
  |
  |-- Phase 3b: Activate Records (delegate to StagedImporter.activate)
  |     |-- importer.activate(projectId, tenantId, allRecords, allSuperseded, layers)
  |     |-- onProgress updates forwarded from activation phase
  |
  |-- Phase 4: Post-Import Validation
  |     |-- validatePostImport(input, deps.postImportDb)
  |     |-- Return provisioning report (missing env vars, creds, etc.)
  |
  |-- Return ImportResultV2
```

### 2.4 Import Layer Ordering

Import ordering is the reverse concern from export. Export assembles in parallel waves
because assemblers are independent. Import must respect dependencies: connections before
agents that reference them, agents before workflows that reference them.

The `ACTIVATION_ORDER` in `staged-importer.ts` already encodes this:

```
connections -> core -> search -> workflows -> guardrails -> evals -> channels -> vocabulary
```

The orchestrator uses a separate `IMPORT_ORDER` for the disassembly phase. This order
determines when file maps are converted to `StagedRecord[]`, not when they are activated
(that is the `StagedImporter`'s responsibility). Disassembly can be parallel for
independent layers, but connection ID resolution for the `core` layer needs `connections`
to complete first.

```typescript
// packages/project-io/src/import/project-importer-v2.ts

/** Wave 1: Infrastructure layers (no cross-layer refs in disassembly) */
const DISASSEMBLY_WAVE_1: LayerName[] = ['connections'];

/** Wave 2: Core layer (may need connection name->ID resolution) */
const DISASSEMBLY_WAVE_2: LayerName[] = ['core'];

/** Wave 3: All other layers (parallel, reference core entities by name) */
const DISASSEMBLY_WAVE_3: LayerName[] = [
  'search',
  'workflows',
  'guardrails',
  'evals',
  'channels',
  'vocabulary',
];
```

### 2.5 Building StagedRecord[] and SupersededRecord[]

The key gap is converting `FolderReadResultV2` layer file maps into the `StagedRecord[]`
and `SupersededRecord[]` arrays that `StagedImporter.execute()` expects.

Each layer disassembler handles its own conversion. The orchestrator coordinates:

```typescript
// Inside importProjectV2, Phase 2:

const allRecords: StagedRecord[] = [];
const allSuperseded: SupersededRecord[] = [];
const allWarnings: string[] = [];

// [R1 Fix: CRIT-1] Build per-layer DisassembleContext (not a single shared context).
// Each disassembler receives only its own layer's files via ctx.files.
function buildLayerCtx(layer: LayerName): DisassembleContext {
  return {
    files: folderResult.layerFiles[layer] ?? new Map(),
    projectId: options.projectId,
    tenantId: options.tenantId,
    userId: options.userId,
    conflictStrategy: options.conflictStrategy,
    existingRecordIds: existingState.activeRecords,
    authProfileMapping: options.authProfileMapping,
    manifestMetadata: folderResult.manifestV2?.metadata,
  };
}

// Wave 1
for (const layer of DISASSEMBLY_WAVE_1) {
  if (!importLayers.includes(layer)) continue;
  const disassembler = deps.disassemblers.get(layer);
  if (!disassembler) continue;
  const result = await disassembler.disassemble(buildLayerCtx(layer));
  allRecords.push(...result.records);
  allSuperseded.push(...result.superseded);
  allWarnings.push(...result.warnings);
}

// Wave 2
for (const layer of DISASSEMBLY_WAVE_2) {
  if (!importLayers.includes(layer)) continue;
  const disassembler = deps.disassemblers.get(layer);
  if (!disassembler) continue;
  const result = await disassembler.disassemble(buildLayerCtx(layer));
  allRecords.push(...result.records);
  allSuperseded.push(...result.superseded);
  allWarnings.push(...result.warnings);
}

// Wave 3 -- parallel
const wave3Promises = DISASSEMBLY_WAVE_3.filter((l) => importLayers.includes(l)).map(
  async (layer) => {
    const disassembler = deps.disassemblers.get(layer);
    if (!disassembler) return { records: [], superseded: [], warnings: [] };
    return disassembler.disassemble(buildLayerCtx(layer));
  },
);
const wave3Results = await Promise.all(wave3Promises);
for (const result of wave3Results) {
  allRecords.push(...result.records);
  allSuperseded.push(...result.superseded);
  allWarnings.push(...result.warnings);
}
```

### 2.6 Error Handling Strategy

The import uses a **partial-success-at-layer-boundaries** model:

1. **Validation failures** (Phase 1) -- return preview with `valid: false`. No data written.
2. **Disassembly failures** (Phase 2) -- if a disassembler throws, the layer is skipped with a warning. Other layers proceed. The import result `warnings` array lists skipped layers. This prevents one malformed guardrail JSON from blocking an agent import.
3. **Staging failures** (Phase 3) -- `StagedImporter.stage()` handles cleanup of partially staged records. The entire import fails and all staged records are deleted.
4. **Activation failures** (Phase 3) -- `StagedImporter.activate()` rolls back completed layers in reverse order. `staged -> deleted`, `superseded -> active`. The import state transitions to `rolling_back`, then `failed`.
5. **Post-import validation** (Phase 4) -- always succeeds (read-only scan). Reports provisioning gaps as `action_required`, not as errors.

State machine for the import operation:

```
                   +------------+
                   | validating |
                   +------+-----+
                          |
            validation OK |  validation fail
                  +-------+-------+
                  |               |
            +-----v----+   +-----v----+
            | staging   |   | failed   |
            +-----+----+   +----------+
                  |
         stage OK |  stage fail (cleanup staged)
            +-----+-------+
            |             |
      +-----v------+ +---v------+
      | activating | | failed   |
      +-----+------+ +----------+
            |
   activate OK |  activate fail (rollback)
         +-----+----------+
         |                |
   +-----v------+  +-----v--------+
   | completed  |  | rolling_back |
   +------------+  +------+-------+
                          |
                   +------v-----+
                   | failed     |
                   +------------+
```

### 2.7 Progress Callback Design

The `onProgress` callback fires at well-defined points, enabling both polling-based and
WebSocket-based progress tracking. The caller (API route) writes these events to Redis
for the status polling endpoint.

```typescript
// Approximate progress distribution:
// 0.00 - 0.15  validating (format detection, SHA, syntax, cross-layer deps)
// 0.15 - 0.50  staging (disassembly + StagedImporter.stage)
// 0.50 - 0.85  activating (StagedImporter.activate, per-layer updates)
// 0.85 - 0.95  post-import validation
// 0.95 - 1.00  cleanup

function emitProgress(
  onProgress: ImportOptionsV2['onProgress'],
  event: Partial<ImportProgressEvent> & { phase: ImportPhase },
): void {
  if (!onProgress) return;
  onProgress({
    progress: 0,
    message: '',
    timestamp: Date.now(),
    ...event,
  });
}

// Example call sites in importProjectV2:
emitProgress(options.onProgress, {
  phase: 'validating',
  message: 'Parsing folder structure',
  progress: 0.05,
});

emitProgress(options.onProgress, {
  phase: 'validating',
  message: 'Verifying SHA integrity',
  progress: 0.1,
});

emitProgress(options.onProgress, {
  phase: 'staging',
  layer: 'core',
  message: 'Disassembling core layer (12 agents, 8 tools)',
  progress: 0.25,
});
```

---

## 3. Layer Disassembler Interface

### 3.1 Interface Definition

> **[R1 Fix: CRIT-1]** The canonical `DisassembleContext` interface is defined in
> Section 3 (`03-layer-disassemblers.md`, Section 3.1). This section references it
> rather than redefining it, to avoid inconsistencies. The name is `DisassembleContext`
> (not `DisassemblyContext`), and the return type is `DisassembleResult` (not
> `DisassemblyResult`). The orchestrator builds a `DisassembleContext` per layer,
> passing each layer's file subset via the `files` field, along with ownership context
> and existing record IDs. See Section 3, Section 3.1 for the full type definition.

The disassembler is the exact reverse of `LayerAssembler`. Where an assembler queries the
database and produces a file map, a disassembler reads a file map and produces database
records.

```typescript
// packages/project-io/src/import/layer-disassemblers/types.ts
// CANONICAL DEFINITION — see Section 3, Section 3.1 for full docs

import type { LayerName } from '../../types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';

/** Context provided to every disassembler — one per layer invocation */
export interface DisassembleContext {
  /** Files belonging to this layer (from FolderReadResultV2.layerFiles[layer]) */
  files: Map<string, string>;
  projectId: string;
  tenantId: string;
  userId: string;
  conflictStrategy: 'replace' | 'skip';
  /**
   * IDs of existing active records in the target project, keyed by collection name.
   * Used to build SupersededRecord entries for records that will be replaced.
   * Populated by the orchestrator via ImportDbAdapter.findActiveRecordIds().
   */
  existingRecordIds?: Map<string, Array<{ _id: string; [key: string]: unknown }>>;
  /**
   * Auth profile name-to-ID mapping for the target tenant/project.
   * Populated by the orchestrator from AuthProfileCandidate lookups.
   * Used by ConnectionsDisassembler to resolve authProfileName -> authProfileId.
   */
  authProfileMapping?: Record<string, string>;
  /**
   * Manifest v2 metadata — some disassemblers need required_auth_profiles
   * or entity_counts for validation.
   */
  manifestMetadata?: {
    required_auth_profiles?: Array<{
      name: string;
      authType: string;
      scope: 'tenant' | 'project';
      referencedBy: string[];
    }>;
    entity_counts?: Record<string, number>;
  };
}

/** Result returned by every disassembler */
export interface DisassembleResult {
  records: StagedRecord[];
  superseded: SupersededRecord[];
  warnings: string[];
}

/**
 * Each layer disassembler converts file map entries back to StagedRecord[].
 * Disassemblers are the reverse of LayerAssemblers.
 *
 * Assembler:    DB -> file map (export)
 * Disassembler: file map -> StagedRecord[] (import)
 */
export interface LayerDisassembler {
  readonly layer: LayerName;

  /**
   * Convert file map entries for this layer into StagedRecord[] for the
   * StagedImporter, and identify existing records to supersede.
   */
  disassemble(ctx: DisassembleContext): Promise<DisassembleResult>;
}
```

### 3.2 Assembler-Disassembler Symmetry

Each assembler has a mirror disassembler. The table below maps the complete set:

| Layer         | Assembler              | Disassembler              | Collections                                                                                                                                                                                                                                                                   | File Patterns                                                                                                                                                                       |
| ------------- | ---------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`        | `CoreAssembler`        | `CoreDisassembler`        | `project_agents`, `project_tools`, `project_settings`, `project_runtime_configs`, `project_llm_configs`, `agent_model_configs`, `environment_variables`, `project_config_variables`, `mcp_server_configs` **[R1 Fix: MAJ-1]** + behavior profiles and locales via config vars | `agents/*.agent.{abl,yaml}`, `tools/*.tools.abl`, `config/*.json`, `environment/*.json`, `core/mcp-servers/*.json`, `behavior_profiles/*.behavior_profile.abl`, `locales/**/*.json` |
| `connections` | `ConnectionsAssembler` | `ConnectionsDisassembler` | `connector_connections`, `connector_configs`                                                                                                                                                                                                                                  | `connections/connectors/*.connection.json`, `connections/configs/*.connector-config.json`                                                                                           |
| `guardrails`  | `GuardrailsAssembler`  | `GuardrailsDisassembler`  | `guardrail_policies`                                                                                                                                                                                                                                                          | `guardrails/*.guardrail.json`                                                                                                                                                       |
| `workflows`   | `WorkflowsAssembler`   | `WorkflowsDisassembler`   | `workflows`, `workflow_versions`                                                                                                                                                                                                                                              | `workflows/*.workflow.json`, `workflows/versions/*/*.version.json`                                                                                                                  |
| `evals`       | `EvalsAssembler`       | `EvalsDisassembler`       | `eval_sets`, `eval_scenarios`, `eval_personas`, `eval_evaluators`                                                                                                                                                                                                             | `evals/*/eval-set.json`, `evals/*/scenarios/*.json`, `evals/*/personas/*.json`, `evals/evaluators/*.json`                                                                           |
| `search`      | `SearchAssembler`      | `SearchDisassembler`      | `search_indexes`, `search_sources`, `knowledge_bases`, `crawl_patterns`                                                                                                                                                                                                       | `search/indexes/*.index.json`, `search/sources/*.source.json`, `search/knowledge-bases/*.kb.json`, `search/crawl-patterns.json`                                                     |
| `channels`    | `ChannelsAssembler`    | `ChannelsDisassembler`    | `channel_connections`, `webhook_subscriptions`, `widget_configs`                                                                                                                                                                                                              | `channels/*.channel.json`, `channels/webhooks/*.webhook.json`, `channels/widgets/*.json`                                                                                            |
| `vocabulary`  | `VocabularyAssembler`  | `VocabularyDisassembler`  | `domain_vocabularies`, `lookup_entries`, `canonical_schemas`, `facts`                                                                                                                                                                                                         | `vocabulary/domain-vocabulary.json`, `vocabulary/lookup-tables/*.lookup.json`, `vocabulary/schemas/*.schema.json`, `vocabulary/facts.json`                                          |

### 3.3 Core Disassembler Example (Reference Implementation)

> **[R1 Fix: CRIT-1]** Updated to use the unified `DisassembleContext` from Section 3.
> The disassembler receives `ctx.files` (a per-layer file map), not the full
> `FolderReadResultV2`. File classification is done by path pattern matching on the
> files map, which contains paths like `agents/booking.agent.abl`, `tools/api.tools.abl`,
> etc. for the core layer.

> **[R1 Fix: MAJ-1]** Added behavior profile and locale file handling. Behavior profiles
> from `behavior_profiles/*.behavior_profile.abl` are stored in `project_config_variables`
> with a `profile:` key prefix. Locale files from `locales/*.json` are stored with a
> `locale:` key prefix. Note: `localeFiles` must be added to `layerFiles.core` in
> `folder-reader.ts` (see MAJ-2 in architecture review).

```typescript
// packages/project-io/src/import/layer-disassemblers/core-disassembler.ts

export class CoreDisassembler implements LayerDisassembler {
  readonly layer = 'core' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const { files, projectId, tenantId, userId, existingRecordIds, conflictStrategy } = ctx;
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    // --- Agents ---
    for (const [path, content] of files) {
      if (!path.match(/^agents\/[^/]+\.agent\.(abl|yaml)$/)) continue;

      const name =
        extractAgentName(content) ??
        path.replace('agents/', '').replace(/\.agent\.(abl|yaml)$/, '');

      if (
        conflictStrategy === 'skip' &&
        findExistingRecord(existingRecordIds, 'project_agents', 'name', name)
      ) {
        continue; // Keep existing
      }

      records.push(
        buildRecord(
          'core',
          COLLECTIONS.PROJECT_AGENTS,
          injectOwnership(
            {
              name,
              dslContent: content,
              description: ctx.manifestMetadata?.entity_counts ? null : null,
              lastEditedBy: userId,
              lastEditedAt: new Date(),
            },
            ctx,
          ),
        ),
      );

      const existing = findExistingRecord(existingRecordIds, 'project_agents', 'name', name);
      if (existing) {
        superseded.push({
          layer: 'core',
          collection: COLLECTIONS.PROJECT_AGENTS,
          recordId: existing._id,
        });
      }
    }

    // --- Tools ---
    for (const [path, content] of files) {
      if (!path.match(/^tools\/[^/]+\.tools\.abl$/)) continue;

      const name = path.replace('tools/', '').replace('.tools.abl', '');

      if (
        conflictStrategy === 'skip' &&
        findExistingRecord(existingRecordIds, 'project_tools', 'slug', name)
      ) {
        continue;
      }

      records.push(
        buildRecord(
          'core',
          COLLECTIONS.PROJECT_TOOLS,
          injectOwnership(
            {
              name,
              slug: name,
              dslContent: content,
            },
            ctx,
          ),
        ),
      );

      const existing = findExistingRecord(existingRecordIds, 'project_tools', 'slug', name);
      if (existing) {
        superseded.push({
          layer: 'core',
          collection: COLLECTIONS.PROJECT_TOOLS,
          recordId: existing._id,
        });
      }
    }

    // --- Config files (project-settings, runtime-config, llm-config, agent-model-configs) ---
    for (const [path, content] of files) {
      if (!path.startsWith('config/')) continue;

      const parsed = safeParseJSON(path, content, warnings);
      if (!parsed) continue;

      const { collection, matchField } = resolveConfigCollection(path);
      if (!collection) {
        warnings.push(`Unknown config path: ${path}`);
        continue;
      }

      records.push(buildRecord('core', collection, injectOwnership(parsed, ctx)));
    }

    // --- Environment variable refs ---
    for (const [path, content] of files) {
      if (!path.startsWith('environment/')) continue;

      const parsed = safeParseJSON(path, content, warnings);
      if (!parsed) continue;

      if (path === 'environment/env-vars.json' && Array.isArray(parsed)) {
        for (const ref of parsed) {
          records.push(
            buildRecord(
              'core',
              COLLECTIONS.ENVIRONMENT_VARIABLES,
              injectOwnership(
                {
                  key: ref.key,
                  description: ref.description ?? null,
                  isSecret: ref.isSecret ?? false,
                  environment: ref.environment ?? null,
                },
                ctx,
              ),
            ),
          );
        }
      }

      if (path === 'environment/config-vars.json' && Array.isArray(parsed)) {
        for (const entry of parsed) {
          records.push(
            buildRecord('core', COLLECTIONS.PROJECT_CONFIG_VARIABLES, injectOwnership(entry, ctx)),
          );
        }
      }
    }

    // --- MCP Server configs ---
    for (const [path, content] of files) {
      if (!path.match(/^core\/mcp-servers\/[^/]+\.mcp-config\.json$/)) continue;

      const parsed = safeParseJSON(path, content, warnings);
      if (!parsed) continue;

      records.push(
        buildRecord('core', COLLECTIONS.MCP_SERVER_CONFIGS, injectOwnership(parsed, ctx)),
      );
    }

    // --- [R1 Fix: MAJ-1] Behavior Profiles ---
    for (const [path, content] of files) {
      if (!path.match(/^behavior_profiles\/[^/]+\.behavior_profile\.abl$/)) continue;

      const profileName = path
        .replace('behavior_profiles/', '')
        .replace('.behavior_profile.abl', '');

      records.push(
        buildRecord(
          'core',
          COLLECTIONS.PROJECT_CONFIG_VARIABLES,
          injectOwnership(
            {
              key: `profile:${profileName}`,
              value: content,
              description: `Behavior profile: ${profileName}`,
            },
            ctx,
          ),
        ),
      );
    }

    // --- [R1 Fix: MAJ-1] Locale Files ---
    // NOTE: localeFiles must be added to layerFiles.core in folder-reader.ts (MAJ-2 fix)
    for (const [path, content] of files) {
      if (!path.match(/^locales\/.*\.json$/)) continue;

      const localePath = path.replace('locales/', '');

      records.push(
        buildRecord(
          'core',
          COLLECTIONS.PROJECT_CONFIG_VARIABLES,
          injectOwnership(
            {
              key: `locale:${localePath}`,
              value: content,
              description: `Locale file: ${localePath}`,
            },
            ctx,
          ),
        ),
      );
    }

    return {
      records,
      superseded,
      warnings,
    };
  }
}
```

### 3.4 Registration / Discovery Pattern

Disassemblers follow the same registry pattern as assemblers. The caller builds the map
and injects it, keeping the orchestrator testable without database dependencies.

```typescript
// packages/project-io/src/import/layer-disassemblers/index.ts

export { CoreDisassembler } from './core-disassembler.js';
export { ConnectionsDisassembler } from './connections-disassembler.js';
export { GuardrailsDisassembler } from './guardrails-disassembler.js';
export { WorkflowsDisassembler } from './workflows-disassembler.js';
export { EvalsDisassembler } from './evals-disassembler.js';
export { SearchDisassembler } from './search-disassembler.js';
export { ChannelsDisassembler } from './channels-disassembler.js';
export { VocabularyDisassembler } from './vocabulary-disassembler.js';
export type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
```

```typescript
// apps/runtime/src/lib/import-disassemblers.ts  (runtime-side factory)
// Mirrors apps/studio/src/lib/export-assemblers.ts

import {
  CoreDisassembler,
  ConnectionsDisassembler,
  GuardrailsDisassembler,
  WorkflowsDisassembler,
  EvalsDisassembler,
  SearchDisassembler,
  ChannelsDisassembler,
  VocabularyDisassembler,
  type LayerDisassembler,
} from '@agent-platform/project-io/import';
import type { LayerName } from '@agent-platform/project-io';

export function buildDisassemblerMap(layers: LayerName[]): Map<LayerName, LayerDisassembler> {
  const map = new Map<LayerName, LayerDisassembler>();
  const registry: Record<LayerName, () => LayerDisassembler> = {
    core: () => new CoreDisassembler(),
    connections: () => new ConnectionsDisassembler(),
    guardrails: () => new GuardrailsDisassembler(),
    workflows: () => new WorkflowsDisassembler(),
    evals: () => new EvalsDisassembler(),
    search: () => new SearchDisassembler(),
    channels: () => new ChannelsDisassembler(),
    vocabulary: () => new VocabularyDisassembler(),
  };

  for (const layer of layers) {
    const factory = registry[layer];
    if (factory) map.set(layer, factory());
  }

  return map;
}
```

---

## 4. API Route Design

### 4.1 Runtime Routes

> **[R1 Fix: MAJ-5]** The v2 import routes are added to the existing
> `apps/runtime/src/routes/project-io.ts` file, not a separate file. The v2 endpoints
> coexist with v1 endpoints under the same mount path. This avoids route file sprawl
> and keeps all project-io routes discoverable in one place.

All routes mounted at `/api/projects/:projectId/project-io`. Same middleware chain as v1:
`authMiddleware -> requireProjectScope -> tenantRateLimit`.

#### POST /import/v2/preview

Dry-run validation. Synchronous -- returns immediately with preview.

```
POST /api/projects/:projectId/project-io/import/v2/preview
Content-Type: application/json
Body: { files: Record<string, string>, options?: { layers?: string[] } }

Response 200:
{
  success: boolean,
  preview: ImportPreviewV2,
  error?: { code: string, message: string }
}
```

Implementation: calls `importProjectV2(files, existingState, { ...options, dryRun: true }, deps)`.

#### POST /import/v2

Starts an async import job. Returns immediately with `operationId`.

```
POST /api/projects/:projectId/project-io/import/v2
Content-Type: application/json
Body: {
  files: Record<string, string>,
  options?: {
    layers?: string[],
    conflictStrategy?: 'replace' | 'skip',
    authProfileMapping?: Record<string, string>
  }
}

Response 202:
{
  success: true,
  operationId: string,
  statusUrl: "/api/projects/:projectId/project-io/import/v2/status/:operationId"
}

Response 409: (concurrent import lock)
{
  success: false,
  error: "Another import is in progress for this project."
}
```

Implementation flow:

1. Validate payload (same guards as v1: file count, size, path traversal).
2. Acquire distributed import lock (Redis `SET NX PX`).
3. Store compressed import files in MongoDB (`ImportFileStore`).
4. Create import operation record in MongoDB (`status: 'validating'`).
5. Spawn background task (not a BullMQ job -- direct `setImmediate` with `try/finally` lock release).
6. Return `202 Accepted` with `operationId`.
7. Background task calls `importProjectV2(...)` with `onProgress` that writes to Redis hash.

> **[R1 Fix: PERF-4]** The `ImportFileStore` MUST use GridFS or chunked storage for
> compressed file data. MongoDB's maximum BSON document size is 16MB, but a 50MB import
> payload compresses to ~12-17MB at realistic 3-4x compression ratios on DSL/JSON content.
> This exceeds the BSON limit. Use GridFS (already supported by Mongoose) to store
> compressed files, or chunk into 8MB documents. The detailed design for this storage
> layer is in Section 5.

Why not BullMQ: Import is project-scoped, already serialized by the distributed lock,
and the operation lifetime is short (seconds to low minutes). BullMQ adds infrastructure
overhead without meaningful benefit here. If import durations grow, migrate to BullMQ later.

#### GET /import/v2/status/:operationId

Poll import progress. Returns current state from Redis + MongoDB.

> **[R1 Fix: VULN-5]** The status query MUST include `tenantId` and `projectId` in
> the filter to enforce tenant isolation. A user from tenant A must not be able to
> view import status for tenant B by guessing `operationId` values.

```
GET /api/projects/:projectId/project-io/import/v2/status/:operationId

Response 200:
{
  operationId: string,
  status: ImportPhase,
  progress: number,       // 0.0 - 1.0
  layers: Record<string, { status: LayerImportStatus }>,
  message: string,        // Human-readable current step
  result?: ImportResultV2, // Present when status is 'completed' or 'failed'
  startedAt: string,
  updatedAt: string
}

Response 404: (operation not found or expired)
```

Implementation: reads from Redis hash `import:progress:{operationId}` first (hot path),
falls back to MongoDB `ImportOperation` document. **All MongoDB queries must include
`tenantId` and `projectId`**:

```typescript
// Correct: tenant-scoped query
const operation = await ImportOperation.findOne({
  _id: operationId,
  projectId: req.params.projectId,
  tenantId: req.tenantId, // from auth middleware
});

// WRONG: never query by _id alone
// const operation = await ImportOperation.findById(operationId);
```

### 4.2 Studio Routes

#### POST /api/projects/[id]/import

Studio import route. Accepts both v1 and v2 with version detection.

```
POST /api/projects/:id/import?version=2
Content-Type: multipart/form-data | application/json

// multipart/form-data: for zip file upload (Studio UI sends zip)
// application/json: for file map (programmatic/CLI usage, same as runtime)

Query params:
  version=2              -- explicitly request v2 import
  conflict_strategy=replace|skip

Response 200 (v1, synchronous):
{ success, applied: { created, updated, deleted } }

Response 202 (v2, async):
{ success: true, operationId, statusUrl }
```

Auto-detection logic when `version` query param is absent:

```typescript
// If the files contain project.json with format_version: "2.0", use v2
// If the files have connections/, guardrails/, workflows/ directories, use v2
// Otherwise, use v1

function detectImportVersion(files: Map<string, string>): 1 | 2 {
  const manifest = files.get('project.json');
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest);
      if (parsed.format_version === '2.0') return 2;
    } catch {
      /* fall through */
    }
  }

  // Presence of v2-only directories
  const v2Dirs = ['connections/', 'guardrails/', 'workflows/', 'evals/', 'search/', 'channels/'];
  for (const [path] of files) {
    if (v2Dirs.some((d) => path.startsWith(d))) return 2;
  }

  return 1;
}
```

### 4.3 WebSocket Progress Updates

For real-time progress in Studio, the import status endpoint is supplemented by a
WebSocket channel. Studio already has a WebSocket infrastructure for live updates.

```
WS /api/projects/:projectId/import/progress

Client sends:
{ type: "subscribe", operationId: "..." }

Server sends:
{ type: "progress", data: ImportProgressEvent }
{ type: "completed", data: ImportResultV2 }
{ type: "failed", data: { error: ... } }
```

Implementation: the `onProgress` callback in `importProjectV2` publishes to a Redis
pub/sub channel `import:progress:{operationId}`. The WebSocket handler subscribes to
that channel and forwards events to connected clients.

```typescript
// Redis pub/sub channel pattern
const IMPORT_PROGRESS_CHANNEL = 'import:progress';

// Publisher (in importProjectV2 onProgress callback):
redis.publish(`${IMPORT_PROGRESS_CHANNEL}:${operationId}`, JSON.stringify(progressEvent));

// Subscriber (in WebSocket handler):
redis.subscribe(`${IMPORT_PROGRESS_CHANNEL}:${operationId}`);
redis.on('message', (channel, message) => {
  ws.send(message);
});
```

---

## 5. Transaction & Rollback Model

### 5.1 StagedImporter 3-Phase Model for v2

The existing `StagedImporter` already implements the correct 3-phase model. The v2
orchestrator uses it unchanged -- the orchestrator's role is to produce the correct
`StagedRecord[]` and `SupersededRecord[]` inputs.

```
Phase 2 (Stage):
  For each record in StagedRecord[]:
    Insert into MongoDB with { status: 'staged' }
    Records are invisible to runtime queries (which filter status: 'active')

  On failure:
    Delete all staged records created so far
    Mark operation as 'failed'

Phase 3 (Activate):
  For each layer in ACTIVATION_ORDER:
    Atomic bulkWrite per collection:
      - Mark staged records -> status: 'active'
      - Mark superseded records -> status: 'superseded'

  On failure at any layer:
    Rollback completed layers in reverse:
      - Mark staged -> status: 'deleted'
      - Mark superseded -> status: 'active'
    Mark operation as 'rolling_back' then 'failed'

Phase 4 (Cleanup):
  Fire-and-forget: delete superseded records
  Safe to retry via TTL expiry
```

### 5.2 Layer-Level Rollback on Partial Failure

The key property of layer-level activation is that each layer's `activateLayer()` call is
an atomic bulkWrite within a single collection. If activation of the `guardrails` layer
fails after `connections` and `core` have been activated:

1. `guardrails` layer was never activated -- no records changed.
2. `core` layer gets rolled back: staged agents -> deleted, superseded agents -> active.
3. `connections` layer gets rolled back: staged connections -> deleted, superseded connections -> active.

The `StagedImporter.rollback()` method already implements this correctly with
`rolledBackCollections` deduplication.

### 5.3 Import Operation State Machine

The full state machine with transitions:

```typescript
export type ImportPhase =
  | 'validating' // Phase 1: parsing, SHA check, syntax, deps
  | 'staging' // Phase 2: writing staged records
  | 'activating' // Phase 3: atomic swap per layer
  | 'completed' // Success -- cleanup runs async
  | 'failed' // Terminal failure
  | 'rolling_back'; // Activation failed, undoing completed layers
```

MongoDB schema for the import operation document:

```typescript
// Extends the existing ImportOperationState in types.ts

interface ImportOperationDocument {
  _id: ObjectId;
  projectId: string;
  tenantId: string;
  userId: string;
  status: ImportPhase;
  formatVersion: '1.0' | '2.0';
  layers: Record<string, { status: LayerImportStatus }>;
  stagedRecordIds: Record<string, string[]>; // collection -> IDs
  supersededRecordIds: Record<string, string[]>; // collection -> IDs
  preview?: ImportPreviewV2; // Cached preview for status endpoint
  error?: { phase: string; layer: string; message: string };
  progress: number; // 0.0 - 1.0
  message: string; // Last progress message
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date; // TTL index for abandoned cleanup
}
```

### 5.4 TTL-Based Cleanup for Abandoned Imports

Import operations have a 1-hour TTL (`IMPORT_OPERATION_TTL_MS = 60 * 60 * 1000`). This
handles three abandonment scenarios:

1. **Server crash during staging**: staged records exist with `status: 'staged'` but no
   operation will ever activate them. A periodic cleanup job (or MongoDB TTL index on
   `expiresAt`) removes the operation. A separate background sweeper deletes orphaned
   staged records -- those with `status: 'staged'` and no matching active import operation.

2. **Server crash during activation**: some layers activated, others did not. The operation
   is in `activating` state. On restart, a recovery process checks for operations in
   `activating` or `rolling_back` states and completes the rollback.

3. **Client disconnects after starting import**: the import continues to completion in the
   background (it runs server-side, not client-driven). The operation and its results
   remain queryable until TTL expiry.

```typescript
// Cleanup sweep (runs on a cron, e.g., every 15 minutes)

async function cleanupAbandonedImports(db: ImportDbAdapter): Promise<void> {
  // 1. Find expired operations still in non-terminal state
  const stale = await db.findStaleOperations({
    status: { $in: ['validating', 'staging', 'activating', 'rolling_back'] },
    expiresAt: { $lt: new Date() },
  });

  for (const op of stale) {
    // Delete any staged records
    for (const [collection, ids] of Object.entries(op.stagedRecordIds)) {
      await db.deleteRecordsByIds(collection, ids);
    }

    // Restore any superseded records
    for (const [collection, ids] of Object.entries(op.supersededRecordIds)) {
      await db.rollbackLayer(collection, [], ids);
    }

    await db.updateImportOperation(op._id, op.projectId, op.tenantId, {
      status: 'failed',
      error: { phase: op.status, layer: 'cleanup', message: 'Operation expired' },
    });
  }
}
```

---

## 6. Integration with Existing v1

### 6.1 Backward Compatibility

The v1 `importProject()` function and its routes remain completely unchanged. The v2
system is additive -- new files, new routes, new orchestrator.

| Component        | v1 (unchanged)                              | v2 (new)                                                                     |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Orchestrator     | `importProject()`                           | `importProjectV2()`                                                          |
| Folder reader    | `readFolder()`                              | `readFolderV2()`                                                             |
| Routes (Runtime) | `POST /import/preview`, `POST /import`      | `POST /import/v2/preview`, `POST /import/v2`, `GET /import/v2/status/:id`    |
| Routes (Studio)  | `POST /api/projects/[id]/import` (existing) | `POST /api/projects/[id]/import?version=2` (same endpoint, version-switched) |
| Execution model  | Synchronous                                 | Async with progress                                                          |
| Scope            | Agents only                                 | All 8 layers                                                                 |

### 6.2 Auto-Detection

When the caller does not specify a version, the system auto-detects based on the import
payload. This applies to both Runtime and Studio routes.

```
Decision tree:

1. Explicit ?version=2 query param -> use v2
2. Explicit ?version=1 query param -> use v1
3. project.json contains format_version: "2.0" -> use v2
4. Files contain v2-only directories (connections/, guardrails/, etc.) -> use v2
5. Default -> use v1
```

The Studio route handler:

```typescript
// apps/studio/src/app/api/projects/[id]/import/route.ts

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROJECT_IMPORT },
  async (ctx) => {
    const version = ctx.request.nextUrl.searchParams.get('version');
    const files = await extractFilesFromRequest(ctx.request);

    const detectedVersion = version ? parseInt(version, 10) : detectImportVersion(files);

    if (detectedVersion === 2) {
      return handleV2Import(ctx, files);
    } else {
      return handleV1Import(ctx, files);
    }
  },
);
```

### 6.3 v1-to-v2 Migration Path

When a v1 export is imported through the v2 path (either auto-detected or explicit), the
`migrateV1ToV2()` function handles normalization:

1. Creates a synthetic v2 manifest with `layers_included: ['core']`.
2. Sets `skipLockfileVerification: true` (v1 lockfiles have a different shape).
3. Only the `CoreDisassembler` runs -- other layers have no files.
4. Returns warnings: `'v1 format -- configs, connections, workflows not included'`.

This means the v2 import path is the only path going forward. v1 exports flow through
the v2 pipeline with automatic migration. The v1 import route remains for API backward
compatibility but internally can delegate to v2 in a future cleanup pass.

---

## 7. File Layout (New Files to Create)

```
packages/project-io/src/
  import/
    project-importer-v2.ts              # importProjectV2 orchestrator
    layer-disassemblers/
      types.ts                          # LayerDisassembler, DisassembleContext, DisassembleResult
      collection-names.ts               # COLLECTIONS constant (shared collection name strings)
      disassembler-utils.ts             # safeParseJSON, injectOwnership, buildRecord, etc.
      core-disassembler.ts              # agents, tools, configs, env vars, MCP, profiles, locales
      connections-disassembler.ts        # connectors, connector configs
      guardrails-disassembler.ts         # guardrail policies
      workflows-disassembler.ts          # workflows, workflow versions
      evals-disassembler.ts             # eval sets, scenarios, personas, evaluators
      search-disassembler.ts            # indexes, sources, knowledge bases, crawl patterns
      channels-disassembler.ts          # channel connections, webhooks, widgets
      vocabulary-disassembler.ts         # domain vocab, lookups, schemas, facts
      cross-ref-resolver.ts             # two-pass cross-reference resolution engine
      index.ts                          # barrel export
    index.ts                            # updated: export new v2 types and functions
  types.ts                              # updated: add ImportOptionsV2, ImportResultV2, etc.

apps/runtime/src/
  routes/project-io.ts                  # [R1 Fix: MAJ-5] updated: add v2 import routes inline
  lib/import-disassemblers.ts           # factory for building disassembler map

apps/studio/src/
  app/api/projects/[id]/import/
    route.ts                            # new: Studio v2 import route
  lib/import-disassemblers.ts           # factory (same pattern as export-assemblers.ts)
```

---

## 8. Data Flow Diagram

### Export v2 (existing, for reference)

```
  DB Collections
       |
       v
  LayerAssembler.assemble(ctx)     x8 assemblers
       |
       v
  LayerAssemblyResult { layer, files: Map<path, content>, entityCount }
       |
       v
  exportProjectV2()
    - wave 1: core, connections (parallel)
    - wave 2: optional layers (parallel)
    - merge file maps
    - generate manifest v2
    - generate lockfile v2
       |
       v
  ExportResultV2 { files: Map<path, content>, manifest, lockfile }
       |
       v
  API Route -> JSON response / zip download
```

### Import v2 (new)

```
  Uploaded files (Map<path, content>) or zip
       |
       v
  migrateV1ToV2(files)  -- normalize v1 to v2 if needed
       |
       v
  stripCommonPrefix(files)  -- remove nested directory prefix
       |
       v
  readFolderV2(normalizedFiles)
       |
       v
  FolderReadResultV2 {
    agentFiles, toolFiles, configFiles, connectionFiles,
    guardrailFiles, workflowFiles, evalFiles, searchFiles,
    channelFiles, vocabularyFiles, layerFiles, manifestV2, lockfileV2
  }
       |
       v
  importProjectV2(files, existingState, options, deps)
    |
    |-- Phase 1: Validate
    |     verifySHAIntegrity(), validateImport(), validateCrossLayerDeps()
    |     If dryRun: return ImportPreviewV2
    |
    |-- Phase 2: Disassemble
    |     LayerDisassembler.disassemble(ctx)     x8 disassemblers
    |       |
    |       v
    |     DisassembleResult { records: StagedRecord[], superseded, warnings }
    |       |
    |       v
    |     Accumulated: allRecords[], allSuperseded[]
    |
    |-- Phase 3: Stage
    |     StagedImporter.stage(projectId, tenantId, allRecords)
    |       |
    |       +-- insert with status='staged', get new _ids
    |
    |-- Phase 2.5: Cross-Reference Resolution [R1 Fix: CRIT-2/3/4]
    |     resolveCrossReferences(recordIdMap, allRecords, dbAdapter)
    |       |
    |       +-- STEP 1: build anchor name->newId maps (5 queries)
    |       +-- STEP 2: re-query dependent collections (5 queries) [R2 Fix: NEW-3]
    |       +-- batched bulkWrite per collection (7-8 calls)
    |       +-- safety net: strip residual data._ fields [R2 Fix: R2-CROSSREF-2]
    |       +-- total: ~18-20 round trips
    |
    |-- Phase 3b: Activate
    |     StagedImporter.activate(projectId, tenantId, allRecords, allSuperseded, layers)
    |       |
    |       +-- bulkWrite staged->active, old->superseded
    |       +-- cleanup: delete superseded (fire-and-forget)
    |
    |-- Phase 4: Post-import
    |     validatePostImport() -> PostImportReport
    |
    v
  ImportResultV2 { operationId, phase, preview, postImportReport, warnings }
       |
       v
  API Route -> 202 Accepted + operationId
  Status endpoint -> poll progress -> 200 with result when completed
```

---

## 9. Key Design Decisions

| Decision                                                                | Rationale                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disassemblers are pure functions (no DB queries)                        | Keeps package DB-agnostic for testing. Superseded record lookup is injected via `existingRecordIds` in `DisassembleContext`.                                                                          |
| Async import with polling (not streaming)                               | Simpler client implementation. WebSocket is opt-in enhancement.                                                                                                                                       |
| `setImmediate` background task, not BullMQ                              | Import is serialized by Redis lock already. BullMQ adds infra overhead for a short-lived operation. Revisit if imports exceed 5 minutes.                                                              |
| Partial success at disassembly level, all-or-nothing at staging level   | A malformed guardrail JSON should not block agent import (skip with warning). But once staging begins, consistency requires all-or-nothing.                                                           |
| v1 routes remain unchanged                                              | API backward compatibility. v1 callers see no behavior change.                                                                                                                                        |
| Auto-detection defaults to v1                                           | Conservative: unknown formats get the well-tested v1 path. v2 requires either explicit version param or v2 manifest markers.                                                                          |
| SHA integrity is warn-only, not blocking                                | Users may legitimately edit exported files before importing. SHA mismatches inform but do not prevent import.                                                                                         |
| Auth profile mapping is explicit, not auto-resolved                     | Cross-tenant imports have different auth profile IDs. The caller (Studio UI) presents a mapping dialog. The API accepts the resolved mapping.                                                         |
| Cross-ref resolution is a distinct phase between staging and activation | [R1 Fix: CRIT-2/3/4] Staged records get new `_id` values during staging. Cross-references (workflowId, indexId, channelConnectionId, scenarioIds) must be resolved before activation makes them live. |
| v2 routes added to existing `project-io.ts`, not a separate file        | [R1 Fix: MAJ-5] Keeps all project-io routes discoverable in one file. v2 endpoints use `/import/v2/` path prefix to coexist with v1.                                                                  |

> **[R1 Fix: INC-2]** Phase numbering alignment: This section uses Phase 0-4 numbering
> for the orchestrator flow (Phase 0: format detection, Phase 1: validate, Phase 2:
> disassemble, Phase 2.5: cross-ref resolution, Phase 3: stage+activate, Phase 4:
> post-validate). The existing `StagedImporter` uses its own internal Phase 2-4
> numbering (Phase 2: stage, Phase 3: activate, Phase 4: cleanup). These are
> orthogonal: the orchestrator's phases are higher-level concepts that wrap the
> StagedImporter's internal phases.

> **[R1 Fix: INC-3]** Disassembly wave ordering (DISASSEMBLY_WAVE_1/2/3 above) and
> activation ordering (ACTIVATION_ORDER in `staged-importer.ts`) serve different
> purposes. The waves control the order in which file maps are converted to
> `StagedRecord[]` — connections first because core may need connection IDs. The
> ACTIVATION_ORDER controls the order in which staged records become active.
> Both orderings are: connections -> core -> everything else. They are aligned.

---

## 10. Implementation Order

The implementation within this section should proceed in this order:

1. **`LayerDisassembler` interface + `CoreDisassembler`** -- proves the pattern with the most complex layer.
2. **`importProjectV2` orchestrator** -- wires disassembler to `StagedImporter`.
3. **Remaining 7 disassemblers** -- parallel work, each follows the core pattern.
4. **Runtime v2 import routes** -- `preview`, `import`, `status`.
5. **Studio v2 import route** -- mirrors runtime with auto-detection.
6. **WebSocket progress** -- enhancement after core flow works.
7. **Update roundtrip test** -- replace manual `StagedRecord[]` construction with `CoreDisassembler`.
