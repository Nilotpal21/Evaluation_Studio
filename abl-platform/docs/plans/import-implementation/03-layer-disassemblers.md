# Section 3: v2 Layer Disassemblers

> Reverse of the layer assemblers in `packages/project-io/src/export/layer-assemblers/`.
> Each disassembler converts files from `readFolderV2` output into `StagedRecord[]` suitable for `StagedImporter.execute()`.

---

## 3.1 LayerDisassembler Interface

> **[R1 Fix: CRIT-1]** This is the **canonical** definition of `DisassembleContext`. Section 1
> references this definition. The name is `DisassembleContext` (not `DisassemblyContext`).
> The orchestrator builds one `DisassembleContext` per layer, passing only that layer's files.

**File:** `packages/project-io/src/import/layer-disassemblers/types.ts`

```typescript
import type { LayerName } from '../../types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';

/** Context provided to every disassembler */
export interface DisassembleContext {
  /** Files belonging to this layer (from FolderReadResultV2.layerFiles[layer]) */
  files: Map<string, string>;
  projectId: string;
  tenantId: string;
  userId: string;
  /** Conflict strategy: 'replace' overwrites existing, 'skip' keeps existing */
  conflictStrategy: 'replace' | 'skip';
  /**
   * IDs of existing active records in the target project, keyed by collection name.
   * Used to build SupersededRecord entries for records that will be replaced.
   * Populated by the orchestrator via ImportDbAdapter.findActiveRecordIds().
   *
   * All queries MUST project only { _id: 1, [matchField]: 1 } for efficiency.
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

/** Contract for all layer disassemblers */
export interface LayerDisassembler {
  readonly layer: LayerName;
  disassemble(ctx: DisassembleContext): Promise<DisassembleResult>;
}
```

### Design Rationale

- **Mirror of `LayerAssembler`**: One disassembler per `LayerName`, same layer values, symmetric API.
- **Pure function model**: Disassemblers receive file contents and context, return records. No DB access inside disassemblers -- the orchestrator handles all DB queries and passes results via `DisassembleContext`.
- **Testability**: Since disassemblers are DB-free, they can be unit-tested with in-memory file maps (same pattern as `readFolderV2` tests).
- **Server-side ownership injection**: All disassemblers use `injectOwnership()` from `disassembler-utils.ts` to set `projectId`, `tenantId`, and `createdBy` from the server-side context. These fields are NEVER read from imported file content.

---

## 3.2 Collection Name Constants

**File:** `packages/project-io/src/import/layer-disassemblers/collection-names.ts`

A single source of truth mapping entity types to MongoDB collection names, derived from the `@agent-platform/database` model definitions.

```typescript
/** MongoDB collection names — must match the 'collection' option in each Mongoose schema */
export const COLLECTIONS = {
  // Core layer
  PROJECT_AGENTS: 'project_agents',
  PROJECT_TOOLS: 'project_tools',
  PROJECT_SETTINGS: 'project_settings',
  PROJECT_RUNTIME_CONFIGS: 'project_runtime_configs',
  PROJECT_LLM_CONFIGS: 'project_llm_configs',
  AGENT_MODEL_CONFIGS: 'agent_model_configs',
  ENVIRONMENT_VARIABLES: 'environment_variables',
  PROJECT_CONFIG_VARIABLES: 'project_config_variables',
  MCP_SERVER_CONFIGS: 'mcp_server_configs',

  // Connections layer
  CONNECTOR_CONNECTIONS: 'connector_connections',
  CONNECTOR_CONFIGS: 'connector_configs',

  // Guardrails layer
  GUARDRAIL_POLICIES: 'guardrail_policies',

  // Workflows layer
  WORKFLOWS: 'workflows',
  WORKFLOW_VERSIONS: 'workflow_versions',

  // Evals layer
  EVAL_SETS: 'eval_sets',
  EVAL_SCENARIOS: 'eval_scenarios',
  EVAL_PERSONAS: 'eval_personas',
  EVAL_EVALUATORS: 'eval_evaluators',

  // Search layer
  SEARCH_INDEXES: 'search_indexes',
  SEARCH_SOURCES: 'search_sources',
  KNOWLEDGE_BASES: 'knowledge_bases',
  CRAWL_PATTERNS: 'crawl_patterns',

  // Channels layer
  CHANNEL_CONNECTIONS: 'channel_connections',
  WEBHOOK_SUBSCRIPTIONS: 'webhook_subscriptions',
  WIDGET_CONFIGS: 'widget_configs',

  // Vocabulary layer
  DOMAIN_VOCABULARIES: 'domain_vocabularies',
  LOOKUP_ENTRIES: 'lookup_entries',
  CANONICAL_SCHEMAS: 'canonical_schemas',
  FACTS: 'facts',
} as const;
```

---

## 3.3 Shared Disassembler Utilities

**File:** `packages/project-io/src/import/layer-disassemblers/disassembler-utils.ts`

```typescript
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import type { LayerName } from '../../types.js';

/**
 * Parse a JSON file safely. Returns null and appends a warning on failure.
 */
export function safeParseJSON(
  filePath: string,
  content: string,
  warnings: string[],
): Record<string, unknown> | null {
  try {
    return JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to parse ${filePath}: ${msg}`);
    return null;
  }
}

/**
 * Parse a JSON file that contains an array. Returns empty array on failure.
 */
export function safeParseJSONArray(
  filePath: string,
  content: string,
  warnings: string[],
): Array<Record<string, unknown>> {
  const parsed = safeParseJSON(filePath, content, warnings);
  if (!parsed) return [];
  if (!Array.isArray(parsed)) {
    warnings.push(`${filePath}: expected array, got ${typeof parsed}`);
    return [];
  }
  return parsed as Array<Record<string, unknown>>;
}

/**
 * Inject standard ownership fields into a document before staging.
 *
 * [R1 Fix: VULN-4] This function ALWAYS overwrites projectId, tenantId, and createdBy
 * from the server-side context. It never trusts these fields from imported data.
 * Any pre-existing tenantId/projectId in the imported data is explicitly removed
 * first via the spread, then overwritten with the server-side values. This ensures
 * every record has a valid tenantId, preventing the conditional logic flaw where
 * records without tenantId could bypass tenant isolation checks.
 */
export function injectOwnership(
  data: Record<string, unknown>,
  ctx: { projectId: string; tenantId: string; userId: string },
): Record<string, unknown> {
  // Strip any client-supplied ownership fields before injecting server-side values
  const { tenantId: _t, projectId: _p, createdBy: _c, ...cleanData } = data;
  return {
    ...cleanData,
    projectId: ctx.projectId, // Always from server context
    tenantId: ctx.tenantId, // Always from server context — never omitted
    createdBy: ctx.userId, // Always from authenticated user
  };
}

/**
 * Build a StagedRecord from a parsed JSON document.
 */
export function buildRecord(
  layer: LayerName,
  collection: string,
  data: Record<string, unknown>,
): StagedRecord {
  return { layer, collection, data };
}

/**
 * Build SupersededRecord entries from existing active records for a collection.
 */
export function buildSuperseded(
  layer: LayerName,
  collection: string,
  existingRecords: Array<{ _id: string }> | undefined,
): SupersededRecord[] {
  if (!existingRecords) return [];
  return existingRecords.map((r) => ({
    layer,
    collection,
    recordId: r._id,
  }));
}

/**
 * Strip REDACTED placeholder values from config objects.
 * These are injected by the assembler's stripSecrets() and must not be imported.
 */
export function stripRedactedValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '***REDACTED***') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = stripRedactedValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract a name from a file path using a known suffix pattern.
 *
 * Example: extractNameFromPath('guardrails/pii-filter.guardrail.json', '.guardrail.json')
 *          -> 'pii-filter'
 */
export function extractNameFromPath(filePath: string, suffix: string): string | null {
  const fileName = filePath.split('/').pop();
  if (!fileName || !fileName.endsWith(suffix)) return null;
  return fileName.slice(0, -suffix.length);
}
```

---

## 3.4 CoreDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/core-disassembler.ts`

### Assembler Output (export writes)

> **[R1 Fix: MAJ-1]** Added behavior profiles and locale files to the core disassembler.
> These are present in `readFolderV2` output but were previously unhandled. Note:
> `localeFiles` must be added to `layerFiles.core` in `folder-reader.ts` (MAJ-2 source
> code fix required during implementation).

| Export Path Pattern                                                 | Collection                 | Match Field                |
| ------------------------------------------------------------------- | -------------------------- | -------------------------- |
| `agents/{name}.agent.abl`                                           | `project_agents`           | `name`                     |
| `tools/{name}.tools.abl`                                            | `project_tools`            | `name` (derived from slug) |
| `config/project-settings.json`                                      | `project_settings`         | singleton per project      |
| `config/runtime-config.json`                                        | `project_runtime_configs`  | singleton per project      |
| `config/llm-config.json`                                            | `project_llm_configs`      | singleton per project      |
| `config/agent-model-configs/{name}.model-config.json`               | `agent_model_configs`      | `agentName`                |
| `environment/env-vars.json`                                         | `environment_variables`    | `key`                      |
| `environment/config-vars.json`                                      | `project_config_variables` | `name`                     |
| `core/mcp-servers/{name}.mcp-config.json`                           | `mcp_server_configs`       | `serverName`               |
| `behavior_profiles/{name}.behavior_profile.abl` **[R1 Fix: MAJ-1]** | `project_config_variables` | `key` (prefix: `profile:`) |
| `locales/{locale}/{name}.json` **[R1 Fix: MAJ-1]**                  | `project_config_variables` | `key` (prefix: `locale:`)  |

### Disassembly Algorithm

```
for each file in ctx.files:
  match path pattern:
    agents/*.agent.abl:
      name = extractAgentName(content) ?? derive from filename
      if conflictStrategy === 'skip' and name exists in existingRecordIds: skip
      record = { name, dslContent: content, status: 'active', version: '0.0.0' }
      inject ownership → emit StagedRecord(core, project_agents, record)

    tools/*.tools.abl:
      slug = filename without .tools.abl suffix
      name = slug
      if conflictStrategy === 'skip' and slug exists in existingRecordIds: skip
      record = { name, slug, dslContent: content }
      inject ownership → emit StagedRecord(core, project_tools, record)

    config/project-settings.json:
      parsed = JSON.parse(content)
      inject ownership → emit StagedRecord(core, project_settings, parsed)

    config/runtime-config.json:
      parsed = JSON.parse(content)
      inject ownership → emit StagedRecord(core, project_runtime_configs, parsed)

    config/llm-config.json:
      parsed = JSON.parse(content)
      NOTE: apiKey/encryptedApiKey were stripped on export — import creates
            the config shell; user must re-provision keys post-import
      inject ownership → emit StagedRecord(core, project_llm_configs, parsed)

    config/agent-model-configs/*.model-config.json:
      parsed = JSON.parse(content)
      agentName = extract from filename or parsed.agentName
      inject ownership → emit StagedRecord(core, agent_model_configs, parsed)

    environment/env-vars.json:
      parsed = JSON.parse(content)  // array of { key, description, isSecret, environment }
      for each entry:
        record = { key, description, isSecret, environment }
        NOTE: values are NOT exported — env var records are reference-only
        inject ownership → emit StagedRecord(core, environment_variables, record)

    environment/config-vars.json:
      parsed = JSON.parse(content)  // array of { name, description }
      for each entry:
        inject ownership → emit StagedRecord(core, project_config_variables, entry)

    core/mcp-servers/*.mcp-config.json:
      parsed = JSON.parse(content)
      inject ownership → emit StagedRecord(core, mcp_server_configs, parsed)

    [R1 Fix: MAJ-1] behavior_profiles/*.behavior_profile.abl:
      profileName = extract from filename (strip .behavior_profile.abl)
      record = { key: 'profile:' + profileName, value: content,
                 description: 'Behavior profile: ' + profileName }
      inject ownership → emit StagedRecord(core, project_config_variables, record)
      NOTE: Phase 1 stores profiles as ProjectConfigVariable with 'profile:' prefix.
            Phase 2 migrates to a dedicated ProjectBehaviorProfile model if needed.

      // [R2 Fix: NEW-2] IMPORTANT LIMITATION — profiles stored as config variables
      // are import-for-preservation-only in Phase 1. The runtime loads behavior
      // profiles from in-memory file maps populated by readFolder(), NOT from
      // project_config_variables. Imported profiles will be stored in the database
      // but will have no runtime effect until Phase 2 adds a reader for
      // project_config_variables with 'profile:' prefix, or migrates to a
      // dedicated model. The import summary MUST warn the user about this limitation.

    [R1 Fix: MAJ-1] locales/**/*.json:
      localePath = path with 'locales/' prefix stripped
      record = { key: 'locale:' + localePath, value: content,
                 description: 'Locale file: ' + localePath }
      inject ownership → emit StagedRecord(core, project_config_variables, record)
      NOTE: Requires localeFiles to be included in layerFiles.core in folder-reader.ts.
            Phase 1 stores locales as ProjectConfigVariable with 'locale:' prefix.
            Phase 2 migrates to a dedicated ProjectLocale model if needed.

      // [R2 Fix: NEW-2] IMPORTANT LIMITATION — same as behavior profiles above.
      // Locales stored as config variables are import-for-preservation-only in Phase 1.
      // The runtime reads locales from in-memory file maps, not project_config_variables.
      // Phase 2 scope: add a dedicated ProjectLocale model with runtime reader,
      // or update the runtime's locale loader to also check project_config_variables.
      // The import summary MUST warn the user about this limitation.
```

### Superseded Record Resolution

For each collection, query existing active records using `ImportDbAdapter.findActiveRecordIds()`:

| Collection                 | Match Field  | Match Values                                                              |
| -------------------------- | ------------ | ------------------------------------------------------------------------- |
| `project_agents`           | `name`       | all agent names from import                                               |
| `project_tools`            | `slug`       | all tool slugs from import                                                |
| `project_settings`         | N/A          | singleton -- always supersede                                             |
| `project_runtime_configs`  | N/A          | singleton -- always supersede                                             |
| `project_llm_configs`      | N/A          | singleton -- always supersede                                             |
| `agent_model_configs`      | `agentName`  | all agent names with model configs                                        |
| `environment_variables`    | `key`        | all env var keys                                                          |
| `project_config_variables` | `key`        | all config var names + `profile:*` keys + `locale:*` keys **[R1: MAJ-1]** |
| `mcp_server_configs`       | `serverName` | all MCP server names                                                      |

---

## 3.5 ConnectionsDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/connections-disassembler.ts`

### Assembler Output (export writes)

| Export Path Pattern                                | Collection              | Match Field                      |
| -------------------------------------------------- | ----------------------- | -------------------------------- |
| `connections/connectors/{name}.connection.json`    | `connector_connections` | `displayName` or `connectorName` |
| `connections/configs/{name}.connector-config.json` | `connector_configs`     | `connectorType`                  |

### Key Complexity: Auth Profile Resolution

The assembler performs these transformations on export:

1. Strips `authProfileId` from every connection (raw Mongo ObjectId, tenant-scoped).
2. Preserves `authProfileName` as a portable reference.
3. Strips `encryptedCredentials`, `encryptionKeyVersion`, `oauth2RefreshToken`.
4. Collects `ExportedAuthProfileRef[]` into `manifest.metadata.required_auth_profiles`.

The disassembler must reverse this:

```
PHASE 1 — Parse connection files:
  for each connections/connectors/*.connection.json:
    parsed = JSON.parse(content)
    strip ***REDACTED*** placeholder values from config sub-objects
    strip runtime fields that should not be imported:
      - oauthTokenId, syncState, errorState (from connector configs)

PHASE 2 — Auth profile name → ID resolution:
  if ctx.authProfileMapping is provided:
    for each connection with authProfileName:
      mappedId = ctx.authProfileMapping[authProfileName]
      if mappedId:
        set connection.authProfileId = mappedId
        delete connection.authProfileName
      else:
        warning: "Connection '{name}' references auth profile '{authProfileName}'
                  which could not be resolved in the target tenant"
        NOTE: connection is still imported without authProfileId — user
              must manually link post-import
  else:
    warning: "No auth profile mapping provided — connections will be imported
              without auth profile references"

PHASE 3 — Build records:
  for each parsed connection:
    inject ownership → emit StagedRecord(connections, connector_connections, data)

  for each connections/configs/*.connector-config.json:
    parsed = JSON.parse(content)
    strip oauthTokenId, syncState, errorState
    inject ownership → emit StagedRecord(connections, connector_configs, data)
```

### Auth Profile Resolution Strategy (Orchestrator Level)

The orchestrator (not the disassembler) performs this before calling `disassemble()`:

1. Read `manifest.metadata.required_auth_profiles` array.
2. Call `matchAuthProfileCandidates(requirements, existingProfiles)` from `auth-mapping.ts`.
3. For auto-matched profiles (exactly 1 candidate by name + authType), build mapping.
4. For ambiguous/missing profiles, surface to user for manual resolution.
5. Pass final `Record<string, string>` mapping via `ctx.authProfileMapping`.

### Handling Missing Auth Profiles

- **Warning, not error.** A missing auth profile does not block import.
- The connection is imported without `authProfileId`.
- Post-import validator (`validatePostImport`) will flag it as `action_required`.

---

## 3.6 GuardrailsDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/guardrails-disassembler.ts`

### Assembler Output

| Export Path Pattern                | Collection           | Match Field |
| ---------------------------------- | -------------------- | ----------- |
| `guardrails/{name}.guardrail.json` | `guardrail_policies` | `name`      |

### Disassembly Algorithm

```
for each guardrails/*.guardrail.json:
  parsed = JSON.parse(content)
  name = parsed.name ?? extract from filename

  IMPORTANT: The assembler strips webhookSecret from settings. The imported
  guardrail will have settings without webhookSecret — user must re-provision
  if the policy uses webhook-based enforcement.

  Restore scope binding:
    if parsed.scope.type === 'project':
      parsed.scope.projectId = ctx.projectId
    if parsed.scope.type === 'agent':
      parsed.scope.projectId = ctx.projectId
      NOTE: scope.agentId references are name-based in the export;
            if the assembler stored agentId, it was stripped by stripInternalFields.
            Re-resolution happens in the cross-ref pass (Section 3.12).

  inject ownership → emit StagedRecord(guardrails, guardrail_policies, parsed)
```

### Superseded Resolution

| Collection           | Match Field | Strategy                                                                                  |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `guardrail_policies` | `name`      | Match by name within the project scope query `{ tenantId, 'scope.projectId': projectId }` |

---

## 3.7 WorkflowsDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/workflows-disassembler.ts`

### Assembler Output

| Export Path Pattern                                | Collection          | Match Field              |
| -------------------------------------------------- | ------------------- | ------------------------ |
| `workflows/{name}.workflow.json`                   | `workflows`         | `name`                   |
| `workflows/versions/{name}/{version}.version.json` | `workflow_versions` | `workflowId` + `version` |

### Disassembly Algorithm

```
PHASE 1 — Parse workflow definitions:
  workflowNameMap = Map<string, Record>()  // name → parsed data

  for each workflows/*.workflow.json (excluding workflows/versions/**):
    parsed = JSON.parse(content)
    name = parsed.name ?? extract from filename

    STATUS RESET: Always set status = 'draft' on import.
    Rationale: imported workflows should not be immediately active.
    The assembler exports the original status, but import resets it.

    record = { ...parsed, status: 'draft' }
    inject ownership → emit StagedRecord(workflows, workflows, record)
    workflowNameMap.set(name, record)

PHASE 2 — Parse workflow versions:
  Use existing StagedImporter.buildWorkflowVersionRecords() method.
  This method:
    - Extracts workflow name from path: workflows/versions/{name}/{version}.version.json
    - Validates required fields: version, definition
    - Resets status to 'draft'
    - Sets workflowName (not workflowId) — cross-ref resolution happens later

  versionFiles = filter ctx.files to paths matching workflows/versions/**/*.version.json
  { records: versionRecords, warnings: versionWarnings } =
    importer.buildWorkflowVersionRecords(versionFiles, ctx.projectId, ctx.tenantId, ctx.userId)

  Append versionRecords to output records.
  Append versionWarnings to output warnings.

PHASE 3 — Cross-reference note:
  Workflow version records contain workflowName but need workflowId.
  This is resolved in the two-pass cross-reference resolution (Section 3.12):
    1. After workflows are staged, query for staged workflow records by name.
    2. Update version records' workflowId field to the staged workflow's _id.
```

### Superseded Resolution

| Collection          | Match Field              | Strategy                                                                 |
| ------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `workflows`         | `name`                   | Match by `{ name, projectId, tenantId }`                                 |
| `workflow_versions` | `workflowId` + `version` | After resolving workflowId, find existing versions for the same workflow |

---

## 3.8 EvalsDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/evals-disassembler.ts`

### Assembler Output

The evals assembler produces a deeply nested directory structure:

| Export Path Pattern                              | Collection        | Match Field            |
| ------------------------------------------------ | ----------------- | ---------------------- |
| `evals/{setName}/eval-set.json`                  | `eval_sets`       | `name`                 |
| `evals/{setName}/scenarios/{name}.scenario.json` | `eval_scenarios`  | `name` (nested in set) |
| `evals/{setName}/personas/{name}.persona.json`   | `eval_personas`   | `name` (nested in set) |
| `evals/scenarios/{name}.scenario.json`           | `eval_scenarios`  | `name` (standalone)    |
| `evals/personas/{name}.persona.json`             | `eval_personas`   | `name` (standalone)    |
| `evals/evaluators/{name}.evaluator.json`         | `eval_evaluators` | `name`                 |

### Key Complexity: Nested vs Standalone Entities

The assembler exports:

- **Nested scenarios/personas**: Placed under `evals/{setName}/scenarios/` and `evals/{setName}/personas/` — these are referenced by the eval set's `scenarioIds` and `personaIds` arrays.
- **Standalone scenarios/personas**: Placed under `evals/scenarios/` and `evals/personas/` — these exist independently of any eval set.

On import, nested entities must be created first, then their new IDs must be wired back into the eval set's `scenarioIds` and `personaIds` arrays.

### Disassembly Algorithm

```
PHASE 1 — Discover eval sets and their nested entities:
  evalSetDirs = set of unique directory names at evals/{name}/eval-set.json level

  for each eval set directory:
    setPath = evals/{setName}/eval-set.json
    setData = JSON.parse(ctx.files.get(setPath))
    IMPORTANT: setData.scenarioIds and setData.personaIds contain OLD ObjectIds
               that no longer exist. These must be rebuilt from the nested files.

    setData.scenarioIds = []  // will be populated in cross-ref pass
    setData.personaIds = []   // will be populated in cross-ref pass
    setData._nestedScenarioNames = []  // temporary, for cross-ref resolution
    setData._nestedPersonaNames = []   // temporary, for cross-ref resolution

    inject ownership → emit StagedRecord(evals, eval_sets, setData)

    // Parse nested scenarios for this set
    for each evals/{setName}/scenarios/*.scenario.json:
      scenarioData = JSON.parse(content)
      scenarioData._parentSetName = setName  // temporary, for cross-ref
      inject ownership → emit StagedRecord(evals, eval_scenarios, scenarioData)
      setData._nestedScenarioNames.push(scenarioData.name)

    // Parse nested personas for this set
    for each evals/{setName}/personas/*.persona.json:
      personaData = JSON.parse(content)
      personaData._parentSetName = setName  // temporary, for cross-ref
      inject ownership → emit StagedRecord(evals, eval_personas, personaData)
      setData._nestedPersonaNames.push(personaData.name)

PHASE 2 — Standalone scenarios:
  for each evals/scenarios/*.scenario.json:
    scenarioData = JSON.parse(content)
    inject ownership → emit StagedRecord(evals, eval_scenarios, scenarioData)

PHASE 3 — Standalone personas:
  for each evals/personas/*.persona.json:
    personaData = JSON.parse(content)
    inject ownership → emit StagedRecord(evals, eval_personas, personaData)

PHASE 4 — Evaluators:
  for each evals/evaluators/*.evaluator.json:
    evaluatorData = JSON.parse(content)
    inject ownership → emit StagedRecord(evals, eval_evaluators, evaluatorData)

PHASE 5 — Cross-reference note (resolved in Section 3.12):
  After all evals records are staged:
    1. Query staged eval_scenarios by name + _parentSetName
    2. Query staged eval_personas by name + _parentSetName
    3. For each eval set, populate scenarioIds and personaIds with new ObjectIds
    4. Strip temporary _parentSetName, _nestedScenarioNames, _nestedPersonaNames
```

### File Path Classification Logic

```typescript
function classifyEvalFile(path: string): {
  type:
    | 'eval-set'
    | 'nested-scenario'
    | 'nested-persona'
    | 'standalone-scenario'
    | 'standalone-persona'
    | 'evaluator'
    | 'unknown';
  setName?: string;
  entityName?: string;
} {
  // evals/{setName}/eval-set.json
  const setMatch = path.match(/^evals\/([^/]+)\/eval-set\.json$/);
  if (setMatch) return { type: 'eval-set', setName: setMatch[1] };

  // evals/{setName}/scenarios/{name}.scenario.json
  const nestedScenario = path.match(/^evals\/([^/]+)\/scenarios\/([^/]+)\.scenario\.json$/);
  if (nestedScenario)
    return {
      type: 'nested-scenario',
      setName: nestedScenario[1],
      entityName: nestedScenario[2],
    };

  // evals/{setName}/personas/{name}.persona.json
  const nestedPersona = path.match(/^evals\/([^/]+)\/personas\/([^/]+)\.persona\.json$/);
  if (nestedPersona)
    return {
      type: 'nested-persona',
      setName: nestedPersona[1],
      entityName: nestedPersona[2],
    };

  // evals/scenarios/{name}.scenario.json
  const standaloneScenario = path.match(/^evals\/scenarios\/([^/]+)\.scenario\.json$/);
  if (standaloneScenario) return { type: 'standalone-scenario', entityName: standaloneScenario[1] };

  // evals/personas/{name}.persona.json
  const standalonePersona = path.match(/^evals\/personas\/([^/]+)\.persona\.json$/);
  if (standalonePersona) return { type: 'standalone-persona', entityName: standalonePersona[1] };

  // evals/evaluators/{name}.evaluator.json
  const evaluator = path.match(/^evals\/evaluators\/([^/]+)\.evaluator\.json$/);
  if (evaluator) return { type: 'evaluator', entityName: evaluator[1] };

  return { type: 'unknown' };
}
```

### Superseded Resolution

| Collection        | Match Field | Strategy                                 |
| ----------------- | ----------- | ---------------------------------------- |
| `eval_sets`       | `name`      | Match by `{ name, projectId, tenantId }` |
| `eval_scenarios`  | `name`      | Match by `{ name, projectId, tenantId }` |
| `eval_personas`   | `name`      | Match by `{ name, projectId, tenantId }` |
| `eval_evaluators` | `name`      | Match by `{ name, projectId, tenantId }` |

---

## 3.9 SearchDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/search-disassembler.ts`

### Assembler Output

| Export Path Pattern                     | Collection        | Match Field           |
| --------------------------------------- | ----------------- | --------------------- |
| `search/indexes/{slug}.index.json`      | `search_indexes`  | `slug` or `name`      |
| `search/sources/{name}.source.json`     | `search_sources`  | `name`                |
| `search/knowledge-bases/{name}.kb.json` | `knowledge_bases` | `name`                |
| `search/crawl-patterns.json`            | `crawl_patterns`  | `domain` (array file) |

### Key Complexity: indexId Resolution

Search sources reference `indexId` (a MongoDB ObjectId pointing to a `search_indexes` record). The assembler exports the raw `indexId` field, but it was stripped by `stripInternalFields` (which removes `_id`). However, the source record retains `indexId` as a regular field (not `_id`).

On import:

- The original `indexId` values are stale ObjectIds from the source environment.
- New search index records will get new `_id` values.
- Source records must have their `indexId` updated to point to the newly created index.

Similarly, `knowledge_bases` reference `searchIndexId`.

### Disassembly Algorithm

```
PHASE 1 — Parse search indexes:
  indexSlugMap = Map<string, Record>()  // slug → parsed data
  // [R2 Fix: NEW-1] Also build a reverse map: originalId → slug
  // so PHASE 2/3 can resolve stale indexId/searchIndexId to the join key.
  originalIdToSlug = Map<string, string>()  // original _id → slug

  for each search/indexes/*.index.json:
    parsed = JSON.parse(content)
    slug = parsed.slug ?? parsed.name ?? extract from filename

    Strip runtime stats (already stripped by assembler, but defensive):
      delete documentCount, chunkCount, sourceCount, lastIndexedAt, indexError

    indexSlugMap.set(slug, parsed)
    // If the exported index contained its original _id (before stripInternalFields),
    // record it. Also store any 'id' or '_exportedId' field the assembler may have kept.
    // Fallback: if no original ID is available, sources can match by filename convention.
    //
    // > **[R3 Fix]** R3-1: `_exportedId` does not exist in the current export code.
    // > `stripInternalFields()` in `assembler-utils.ts` removes `_id` and does NOT
    // > add an `_exportedId` field. In Phase 1, cross-ref resolution will rely on
    // > the name/slug-based fallback heuristics in `findSlugByOriginalId` (single-index
    // > assumption, name-matching convention) as the primary resolution path.
    // > Adding `_exportedId` to assembler output is tracked as a future export
    // > enhancement. The same applies to `ChannelsDisassembler` and its
    // > `originalIdToDisplayName` map. Implementers MUST test the fallback paths
    // > thoroughly since they will be the effective primary path in Phase 1.
    if parsed._exportedId: originalIdToSlug.set(parsed._exportedId, slug)
    inject ownership → emit StagedRecord(search, search_indexes, parsed)

  // Helper: resolve a stale indexId to the anchor slug
  function findSlugByOriginalId(originalIdToSlug, staleId, record):
    // 1. Direct lookup by original _id
    if originalIdToSlug.has(staleId): return originalIdToSlug.get(staleId)
    // 2. Fallback: if only one index exists, assume it's the target
    if indexSlugMap.size === 1: return indexSlugMap.keys().next().value
    // 3. Fallback: match by naming convention (source name contains index slug)
    for [slug, _] of indexSlugMap:
      if record.name?.includes(slug): return slug
    // 4. Last resort: emit warning, return null (cross-ref will skip this record)
    warnings.push(`Cannot resolve indexId ${staleId} to a slug for ${record.name}`)
    return null

PHASE 2 — Parse search sources:
  for each search/sources/*.source.json:
    parsed = JSON.parse(content)

    Strip runtime stats:
      delete documentCount, lastSyncAt, syncError

    // [R2 Fix: NEW-1] Store the anchor's join key (_indexSlug), not the stale ObjectId.
    // The cross-ref resolver (Section 3.12) joins on _indexSlug → search_indexes.slug.
    // Look up the original indexId in the co-parsed indexSlugMap from PHASE 1.
    originalIndexId = parsed.indexId
    matchingSlug = findSlugByOriginalId(indexSlugMap, originalIndexId, parsed)
    parsed._indexSlug = matchingSlug  // join key for cross-ref resolver
    delete parsed.indexId  // will be set in cross-ref pass

    inject ownership → emit StagedRecord(search, search_sources, parsed)

PHASE 3 — Parse knowledge bases:
  for each search/knowledge-bases/*.kb.json:
    parsed = JSON.parse(content)

    Strip runtime stats:
      delete documentCount, lastIndexedAt, indexError

    // [R2 Fix: NEW-1] Store the anchor's join key (_indexSlug), not the stale ObjectId.
    // The cross-ref resolver joins on _indexSlug → search_indexes.slug.
    originalSearchIndexId = parsed.searchIndexId
    matchingSlug = findSlugByOriginalId(indexSlugMap, originalSearchIndexId, parsed)
    parsed._indexSlug = matchingSlug  // join key for cross-ref resolver
    delete parsed.searchIndexId  // will be set in cross-ref pass

    inject ownership → emit StagedRecord(search, knowledge_bases, parsed)

PHASE 4 — Parse crawl patterns:
  crawlPatternsFile = ctx.files.get('search/crawl-patterns.json')
  if crawlPatternsFile:
    patterns = JSON.parse(crawlPatternsFile)  // array
    for each pattern:
      Strip runtime stats:
        delete lastCrawlAt, totalCrawlsCompleted, avgCrawlDurationMs,
               lastCrawlSuccess, lastCrawlError, profiledAt, lastAccessedAt
      inject ownership → emit StagedRecord(search, crawl_patterns, pattern)

PHASE 5 — Cross-reference note (resolved in Section 3.12):
  After search indexes are staged with new _ids:
    // [R2 Fix: NEW-1] Join key is _indexSlug (set in PHASE 2/3), not _originalIndexId.
    1. Build slug → new-indexId map from staged search_indexes records
    2. Update search_sources records: indexId = slugMap[record._indexSlug]
    3. Update knowledge_bases records: searchIndexId = slugMap[record._indexSlug]
    4. Strip temporary _indexSlug fields
```

### Superseded Resolution

| Collection        | Match Field | Strategy                                                          |
| ----------------- | ----------- | ----------------------------------------------------------------- |
| `search_indexes`  | `slug`      | Match by `{ slug, projectId, tenantId }`                          |
| `search_sources`  | `name`      | Match by `{ name, tenantId, indexId: { $in: existingIndexIds } }` |
| `knowledge_bases` | `name`      | Match by `{ name, projectId, tenantId }`                          |
| `crawl_patterns`  | `domain`    | Match by `{ domain, projectId, tenantId }`                        |

---

## 3.10 ChannelsDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/channels-disassembler.ts`

### Assembler Output

| Export Path Pattern                     | Collection              | Match Field                           |
| --------------------------------------- | ----------------------- | ------------------------------------- |
| `channels/{name}.channel.json`          | `channel_connections`   | `displayName` or `externalIdentifier` |
| `channels/webhooks/{name}.webhook.json` | `webhook_subscriptions` | `description`                         |
| `channels/widgets/widget-config.json`   | `widget_configs`        | singleton per project                 |

### Key Complexity: channelConnectionId Resolution

Webhook subscriptions reference `channelConnectionId` (a MongoDB ObjectId pointing to a `channel_connections` record). The assembler exports this field, but the original IDs are from the source environment.

### Disassembly Algorithm

```
PHASE 1 — Parse channel connections:
  channelNameMap = Map<string, Record>()
  // [R2 Fix: NEW-1] Also build a reverse map: originalId → displayName
  // so PHASE 2 can resolve stale channelConnectionId to the join key.
  originalIdToDisplayName = Map<string, string>()

  for each channels/*.channel.json (not under channels/webhooks/ or channels/widgets/):
    parsed = JSON.parse(content)
    displayName = parsed.displayName ?? parsed.externalIdentifier ?? extract from filename

    Strip secrets:
      delete encryptedCredentials, verifyTokenHash

    channelNameMap.set(displayName, parsed)
    if parsed._exportedId: originalIdToDisplayName.set(parsed._exportedId, displayName)
    inject ownership → emit StagedRecord(channels, channel_connections, parsed)

  // Helper: resolve a stale channelConnectionId to the anchor displayName
  function findDisplayNameByOriginalId(channelNameMap, staleId, record):
    if originalIdToDisplayName.has(staleId): return originalIdToDisplayName.get(staleId)
    if channelNameMap.size === 1: return channelNameMap.keys().next().value
    warnings.push(`Cannot resolve channelConnectionId ${staleId} for ${record.description}`)
    return null

PHASE 2 — Parse webhook subscriptions:
  for each channels/webhooks/*.webhook.json:
    parsed = JSON.parse(content)

    Strip runtime/secret fields:
      delete encryptedSecret, lastDeliveryAt, failureCount

    // [R2 Fix: NEW-1] Store the anchor's join key (_channelDisplayName), not the
    // stale ObjectId. The cross-ref resolver (Section 3.12) joins on
    // _channelDisplayName → channel_connections.displayName.
    originalChannelConnectionId = parsed.channelConnectionId
    matchingDisplayName = findDisplayNameByOriginalId(
      channelNameMap, originalChannelConnectionId, parsed)
    parsed._channelDisplayName = matchingDisplayName  // join key for cross-ref resolver
    delete parsed.channelConnectionId  // will be set in cross-ref pass

    inject ownership → emit StagedRecord(channels, webhook_subscriptions, parsed)

PHASE 3 — Parse widget config:
  widgetFile = ctx.files.get('channels/widgets/widget-config.json')
  if widgetFile:
    parsed = JSON.parse(widgetFile)
    inject ownership → emit StagedRecord(channels, widget_configs, parsed)

PHASE 4 — Cross-reference note (resolved in Section 3.12):
  After channel_connections are staged with new _ids:
    // [R2 Fix: NEW-1] Join key is _channelDisplayName (set in PHASE 2),
    // not _originalChannelConnectionId.
    1. Build displayName → new-channelConnectionId map from staged records
    2. Update webhook_subscriptions: channelConnectionId = nameMap[record._channelDisplayName]
    3. Strip temporary _channelDisplayName
```

### Superseded Resolution

| Collection              | Match Field           | Strategy                                                                 |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| `channel_connections`   | `displayName`         | Match by `{ displayName, projectId, tenantId }`                          |
| `webhook_subscriptions` | `channelConnectionId` | After resolving channel IDs, find existing webhooks for matched channels |
| `widget_configs`        | N/A                   | Singleton — always supersede existing                                    |

---

## 3.11 VocabularyDisassembler

**File:** `packages/project-io/src/import/layer-disassemblers/vocabulary-disassembler.ts`

### Assembler Output

| Export Path Pattern                                | Collection            | Match Field                                   |
| -------------------------------------------------- | --------------------- | --------------------------------------------- |
| `vocabulary/domain-vocabulary.json`                | `domain_vocabularies` | array file; match by `projectKnowledgeBaseId` |
| `vocabulary/lookup-tables/{tableName}.lookup.json` | `lookup_entries`      | `tableName` + `value`                         |
| `vocabulary/schemas/{knowledgeBaseId}.schema.json` | `canonical_schemas`   | `knowledgeBaseId`                             |
| `vocabulary/facts.json`                            | `facts`               | `key`                                         |

### Disassembly Algorithm

```
PHASE 1 — Parse domain vocabularies:
  vocabFile = ctx.files.get('vocabulary/domain-vocabulary.json')
  if vocabFile:
    vocabs = JSON.parse(vocabFile)  // array of vocabulary objects
    for each vocab:
      inject ownership → emit StagedRecord(vocabulary, domain_vocabularies, vocab)

PHASE 2 — Parse lookup tables:
  for each vocabulary/lookup-tables/*.lookup.json:
    tableName = extract from filename (strip .lookup.json)
    entries = JSON.parse(content)  // array of lookup entry objects
    for each entry:
      record = { ...entry, tableName }
      inject ownership → emit StagedRecord(vocabulary, lookup_entries, record)

PHASE 3 — Parse canonical schemas:
  for each vocabulary/schemas/*.schema.json:
    parsed = JSON.parse(content)
    inject ownership → emit StagedRecord(vocabulary, canonical_schemas, parsed)

PHASE 4 — Parse facts:
  factsFile = ctx.files.get('vocabulary/facts.json')
  if factsFile:
    facts = JSON.parse(factsFile)  // array of fact objects
    for each fact:
      fact.scope = 'project'  // ensure project scope (assembler filters by scope: 'project')
      inject ownership → emit StagedRecord(vocabulary, facts, fact)
```

### Superseded Resolution

| Collection            | Match Field              | Strategy                                                                                      |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `domain_vocabularies` | `projectKnowledgeBaseId` | Match by `{ projectId, tenantId }` (project-scoped)                                           |
| `lookup_entries`      | `tableName` + `value`    | Match by `{ projectId, tenantId, tableName }` — supersede all entries for matched table names |
| `canonical_schemas`   | `knowledgeBaseId`        | Match by `{ tenantId, projectId }`                                                            |
| `facts`               | `key`                    | Match by `{ projectId, tenantId, scope: 'project', key }`                                     |

---

## 3.12 Two-Pass Cross-Reference Resolution

> **[R1 Fix: CRIT-2/3/4]** This section now defines the **exact execution point** for
> cross-reference resolution in the import pipeline. The resolver runs as Phase 2.5:
> **after staging (all records have new `_id` values) but before activation (records
> are still in `status: 'staged'`, invisible to runtime queries)**. This phase is
> called by the orchestrator in `importProjectV2`, not by the `StagedImporter` itself.

> **[R1 Fix: PERF-1]** All updates use **batched `bulkWrite`** calls with
> `{ ordered: false }`. Instead of ~850+ individual `updateOne` calls, the resolver
> issues 5-8 `bulkWrite` commands (one per affected collection). Each `bulkWrite`
> contains an array of `updateOne` operations for that collection.

**File:** `packages/project-io/src/import/layer-disassemblers/cross-ref-resolver.ts`

### The Problem

Export strips MongoDB `_id` values via `stripInternalFields`. Records that reference other records by `_id` (e.g., `EvalSet.scenarioIds`, `SearchSource.indexId`, `WebhookSubscription.channelConnectionId`, `WorkflowVersion.workflowId`) carry stale or missing IDs.

After staging, new `_id` values are assigned. Cross-references must be updated to point to the new IDs.

### Execution Point in the Pipeline

```
importProjectV2 orchestration:
  Phase 1:   Validate (parse, SHA, syntax, cross-layer deps)
  Phase 2:   Disassemble (file maps → StagedRecord[]) — temp fields added here
  Phase 3a:  Stage (StagedImporter.stage — inserts with status='staged', assigns new _ids)
  ──────────────────────────────────────────────────────────────────────────────────
  Phase 2.5: Cross-Reference Resolution ← THIS SECTION
             Input:  stagedRecordIds (collection → new _id[])
             Action: query staged records, batch-update foreign keys
             Output: all temp fields stripped, all foreign keys resolved
  ──────────────────────────────────────────────────────────────────────────────────
  Phase 3b:  Activate (StagedImporter.activate — staged→active, old→superseded)
  Phase 4:   Post-import validation
```

### Required ImportDbAdapter Extension

```typescript
// New methods required on ImportDbAdapter for cross-ref resolution

interface ImportDbAdapter {
  // ... existing methods ...

  /**
   * Query staged records for a specific import operation and collection.
   * Used to build name→newId maps for anchor collections.
   * Returns only projected fields for efficiency.
   */
  queryStagedRecords(
    collection: string,
    filter: Record<string, unknown>,
    projection: Record<string, 1>,
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Batch-update staged records. Uses bulkWrite with { ordered: false }.
   * Each update targets a specific staged record by _id.
   */
  batchUpdateStagedRecords(
    collection: string,
    updates: Array<{
      filter: { _id: string };
      update: { $set?: Record<string, unknown>; $unset?: Record<string, 1> };
    }>,
  ): Promise<{ modifiedCount: number }>;
}
```

### Resolution Algorithm

```
Input:
  stagedRecordIds: Record<string, string[]>  // collection → array of new _ids
  operationId: string                         // for scoping queries to this import
  db: ImportDbAdapter                         // for querying + batch-updating staged records

STEP 1 — Build name→newId maps for anchor collections (5 queries):
  [R1 Fix: PERF-1] All queries use projection to return only needed fields.

  workflowNameMap = db.queryStagedRecords('workflows',
    { _id: { $in: stagedRecordIds.workflows }, status: 'staged' },
    { _id: 1, 'data.name': 1 })
    → Map<name, newId>

  indexSlugMap = db.queryStagedRecords('search_indexes',
    { _id: { $in: stagedRecordIds.search_indexes }, status: 'staged' },
    { _id: 1, 'data.slug': 1 })
    → Map<slug, newId>

  channelNameMap = db.queryStagedRecords('channel_connections',
    { _id: { $in: stagedRecordIds.channel_connections }, status: 'staged' },
    { _id: 1, 'data.displayName': 1 })
    → Map<displayName, newId>

  scenarioNameMap = db.queryStagedRecords('eval_scenarios',
    { _id: { $in: stagedRecordIds.eval_scenarios }, status: 'staged' },
    { _id: 1, 'data.name': 1, 'data._parentSetName': 1 })
    → Map<setName/name, newId>

  personaNameMap = db.queryStagedRecords('eval_personas',
    { _id: { $in: stagedRecordIds.eval_personas }, status: 'staged' },
    { _id: 1, 'data.name': 1, 'data._parentSetName': 1 })
    → Map<setName/name, newId>

STEP 2 — Re-query dependent collections and build batched updates (NO individual updates):
  [R1 Fix: PERF-1] Collect all updates per collection, then issue one bulkWrite each.

  // [R2 Fix: NEW-3] STEP 2 re-queries dependent collections from MongoDB.
  // The in-memory StagedRecord[] array does not have new _id values (those are
  // assigned during staging by insertMany). Re-querying is required to access
  // both the new _id and the temp join fields (e.g., workflowName, _indexSlug).
  // Each dependent collection requires one additional query (7 total).

  // --- workflow_versions (one query + one bulkWrite) ---
  workflowVersionRecords = db.queryStagedRecords('workflow_versions',
    { _id: { $in: stagedRecordIds.workflow_versions }, status: 'staged' },
    { _id: 1, 'data.workflowName': 1 })
  versionUpdates = []
  for each record in workflowVersionRecords:
    workflowId = workflowNameMap[record.data.workflowName]
    versionUpdates.push({
      filter: { _id: record._id },
      update: {
        $set: { 'data.workflowId': workflowId },
        $unset: { 'data.workflowName': 1 }
      }
    })
  db.batchUpdateStagedRecords('workflow_versions', versionUpdates)

  // --- search_sources (one query + one bulkWrite) ---
  // [R2 Fix: NEW-1] Disassemblers now store _indexSlug (the join key), not _originalIndexId.
  // [R2 Fix: NEW-3] Re-query from DB to access new _id and temp fields.
  searchSourceRecords = db.queryStagedRecords('search_sources',
    { _id: { $in: stagedRecordIds.search_sources }, status: 'staged' },
    { _id: 1, 'data._indexSlug': 1 })
  sourceUpdates = []
  for each record in searchSourceRecords:
    indexId = indexSlugMap[record.data._indexSlug]
    sourceUpdates.push({
      filter: { _id: record._id },
      update: {
        $set: { 'data.indexId': indexId },
        $unset: { 'data._indexSlug': 1 }
      }
    })
  db.batchUpdateStagedRecords('search_sources', sourceUpdates)

  // --- knowledge_bases (one query + one bulkWrite) ---
  // [R2 Fix: NEW-1] Same pattern — _indexSlug is the only temp field to strip.
  // [R2 Fix: NEW-3] Re-query from DB.
  knowledgeBaseRecords = db.queryStagedRecords('knowledge_bases',
    { _id: { $in: stagedRecordIds.knowledge_bases }, status: 'staged' },
    { _id: 1, 'data._indexSlug': 1 })
  kbUpdates = []
  for each record in knowledgeBaseRecords:
    searchIndexId = indexSlugMap[record.data._indexSlug]
    kbUpdates.push({
      filter: { _id: record._id },
      update: {
        $set: { 'data.searchIndexId': searchIndexId },
        $unset: { 'data._indexSlug': 1 }
      }
    })
  db.batchUpdateStagedRecords('knowledge_bases', kbUpdates)

  // --- webhook_subscriptions (one query + one bulkWrite) ---
  // [R2 Fix: NEW-1] Disassemblers now store _channelDisplayName (the join key),
  // not _originalChannelConnectionId. The $unset only needs to strip _channelDisplayName.
  // [R2 Fix: NEW-3] Re-query from DB.
  webhookRecords = db.queryStagedRecords('webhook_subscriptions',
    { _id: { $in: stagedRecordIds.webhook_subscriptions }, status: 'staged' },
    { _id: 1, 'data._channelDisplayName': 1 })
  webhookUpdates = []
  for each record in webhookRecords:
    channelConnectionId = channelNameMap[record.data._channelDisplayName]
    webhookUpdates.push({
      filter: { _id: record._id },
      update: {
        $set: { 'data.channelConnectionId': channelConnectionId },
        $unset: { 'data._channelDisplayName': 1 }
      }
    })
  db.batchUpdateStagedRecords('webhook_subscriptions', webhookUpdates)

  // --- eval_sets (one query + one bulkWrite for scenarioIds + personaIds) ---
  // [R2 Fix: NEW-3] Re-query from DB.
  evalSetRecords = db.queryStagedRecords('eval_sets',
    { _id: { $in: stagedRecordIds.eval_sets }, status: 'staged' },
    { _id: 1, 'data.name': 1, 'data._nestedScenarioNames': 1, 'data._nestedPersonaNames': 1 })
  evalSetUpdates = []
  for each record in evalSetRecords:
    scenarioIds = record.data._nestedScenarioNames?.map(name =>
      scenarioNameMap[`${record.data.name}/${name}`]) ?? []
    personaIds = record.data._nestedPersonaNames?.map(name =>
      personaNameMap[`${record.data.name}/${name}`]) ?? []
    evalSetUpdates.push({
      filter: { _id: record._id },
      update: {
        $set: { 'data.scenarioIds': scenarioIds, 'data.personaIds': personaIds },
        $unset: {
          'data._nestedScenarioNames': 1,
          'data._nestedPersonaNames': 1,
        }
      }
    })
  db.batchUpdateStagedRecords('eval_sets', evalSetUpdates)

  // --- eval_scenarios: strip _parentSetName (one bulkWrite) ---
  scenarioCleanup = stagedRecordIds.eval_scenarios.map(id => ({
    filter: { _id: id },
    update: { $unset: { 'data._parentSetName': 1 } }
  }))
  db.batchUpdateStagedRecords('eval_scenarios', scenarioCleanup)

  // --- eval_personas: strip _parentSetName (one bulkWrite) ---
  personaCleanup = stagedRecordIds.eval_personas.map(id => ({
    filter: { _id: id },
    update: { $unset: { 'data._parentSetName': 1 } }
  }))
  db.batchUpdateStagedRecords('eval_personas', personaCleanup)

SUMMARY:
  // [R2 Fix: NEW-3] Updated round-trip count to include STEP 2 re-queries.
  // STEP 1: 5 anchor queries (workflows, search_indexes, channel_connections,
  //         eval_scenarios, eval_personas)
  // STEP 2: 5 dependent collection re-queries (workflow_versions, search_sources,
  //         knowledge_bases, webhook_subscriptions, eval_sets)
  //       + 7 bulkWrites (workflow_versions, search_sources, knowledge_bases,
  //         webhook_subscriptions, eval_sets, eval_scenarios cleanup, eval_personas cleanup)
  Total queries:    10 (5 anchor + 5 dependent re-queries)
  Total bulkWrites: 7-8 (one per dependent collection + cleanup)
  Total round trips: ~18-20 (vs ~850+ without batching)

  // [R2 Fix: R2-CROSSREF-2] SAFETY NET — Strip all data._ prefixed fields
  // before activation. If the cross-ref resolution phase throws an error that
  // is caught but does not prevent activation, or if a new disassembler adds
  // temp fields not covered by the resolver, the _ prefixed fields would leak
  // into activated records. As a safety net, the activation phase MUST strip
  // all data._ fields from staged records before changing status to 'active'.
  //
  // Implementation: Add a pre-activation pass that scans all staged records
  // and issues a bulkWrite to $unset any data._ fields found:
  //
  // > **[R3 Fix]** NEW-PERF-5: Optimization — before doing the full-document scan,
  // > run a `countDocuments` check per collection to avoid reading ~12-60MB of
  // > document bodies in the normal case (where no residual `_` fields exist):
  // >
  // >   for each collection in stagedRecordIds:
  // >     count = db.collection(coll).countDocuments({
  // >       _id: { $in: ids }, status: 'staged',
  // >       $or: [
  // >         { 'data._indexSlug': { $exists: true } },
  // >         { 'data._channelDisplayName': { $exists: true } },
  // >         { 'data._parentSetName': { $exists: true } },
  // >         { 'data._nestedScenarioNames': { $exists: true } },
  // >         { 'data._nestedPersonaNames': { $exists: true } },
  // >       ]
  // >     })
  // >     if count === 0: skip this collection (normal case — ~2ms per query)
  // >     else: proceed with full scan below
  // >
  // > This replaces ~20 full-projection queries (~100ms, ~12-60MB) with ~20
  // > count queries (~40ms total, negligible memory) in the common case.
  //
  //   for each collection in stagedRecordIds:
  //     records = db.queryStagedRecords(collection, { status: 'staged' }, { 'data': 1 })
  //     for each record where Object.keys(record.data).some(k => k.startsWith('_')):
  //       unsetFields = Object.keys(record.data).filter(k => k.startsWith('_'))
  //       issue $unset for all unsetFields
  // This is O(N) over staged records but only fires if _ fields remain, which
  // should not happen in the normal case (the resolver strips them).

  eval_sets.evaluatorIds:
    The assembler exports evaluatorIds in the eval set JSON.
    These are stale ObjectIds. Resolution:
      - PRAGMATIC SOLUTION: Clear evaluatorIds on import with a warning.
        Evaluators are shared resources — the user re-links them post-import.
      - Track as a future enhancement to include evaluator names in eval set JSON.
```

### Cross-Reference Resolution Registry

```typescript
interface CrossRefRule {
  /** Collection containing the dependent record */
  collection: string;
  /** Field on the dependent record that holds the stale reference */
  foreignKeyField: string;
  /** Temporary field holding metadata for resolution */
  tempJoinField: string;
  /** Collection containing the anchor record (the one being referenced) */
  anchorCollection: string;
  /** Field on the anchor record used as the join key */
  anchorMatchField: string;
}

const CROSS_REF_RULES: CrossRefRule[] = [
  {
    collection: 'workflow_versions',
    foreignKeyField: 'workflowId',
    tempJoinField: 'workflowName',
    anchorCollection: 'workflows',
    anchorMatchField: 'name',
  },
  {
    collection: 'search_sources',
    foreignKeyField: 'indexId',
    tempJoinField: '_indexSlug',
    anchorCollection: 'search_indexes',
    anchorMatchField: 'slug',
  },
  {
    collection: 'knowledge_bases',
    foreignKeyField: 'searchIndexId',
    tempJoinField: '_indexSlug',
    anchorCollection: 'search_indexes',
    anchorMatchField: 'slug',
  },
  {
    collection: 'webhook_subscriptions',
    foreignKeyField: 'channelConnectionId',
    tempJoinField: '_channelDisplayName',
    anchorCollection: 'channel_connections',
    anchorMatchField: 'displayName',
  },
];
```

### Eval Set Array References (Special Case)

Eval set `scenarioIds` and `personaIds` are arrays of ObjectIds, not single foreign keys. These require a separate resolution path:

```typescript
interface ArrayCrossRefRule {
  collection: string;
  arrayField: string;
  tempNamesField: string;
  anchorCollection: string;
  anchorMatchField: string;
  /** For nested entities, compose key from parentSet + name */
  compositeKey?: boolean;
}

const ARRAY_CROSS_REF_RULES: ArrayCrossRefRule[] = [
  {
    collection: 'eval_sets',
    arrayField: 'scenarioIds',
    tempNamesField: '_nestedScenarioNames',
    anchorCollection: 'eval_scenarios',
    anchorMatchField: 'name',
    compositeKey: true,
  },
  {
    collection: 'eval_sets',
    arrayField: 'personaIds',
    tempNamesField: '_nestedPersonaNames',
    anchorCollection: 'eval_personas',
    anchorMatchField: 'name',
    compositeKey: true,
  },
];
```

---

## 3.13 Disassembler Registry and Orchestration

**File:** `packages/project-io/src/import/layer-disassemblers/index.ts`

```typescript
export { CoreDisassembler } from './core-disassembler.js';
export { ConnectionsDisassembler } from './connections-disassembler.js';
export { GuardrailsDisassembler } from './guardrails-disassembler.js';
export { WorkflowsDisassembler } from './workflows-disassembler.js';
export { EvalsDisassembler } from './evals-disassembler.js';
export { SearchDisassembler } from './search-disassembler.js';
export { ChannelsDisassembler } from './channels-disassembler.js';
export { VocabularyDisassembler } from './vocabulary-disassembler.js';
export type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
export { COLLECTIONS } from './collection-names.js';
export { resolveCrossReferences } from './cross-ref-resolver.js';
```

### Orchestration Flow (in the import pipeline)

> **[R1 Fix: CRIT-2/3/4]** Updated to show the explicit cross-reference resolution
> phase between staging and activation.

```
1. readFolderV2(files) → FolderReadResultV2
2. Validate: verifySHAIntegrity, validateCrossLayerDeps
3. Auth profile resolution (for connections layer)
4. For each layer in DISASSEMBLY_WAVE_1/2/3 where layer has files:
   a. disassembler = registry.get(layer)
   b. ctx = { files: layerFiles[layer], projectId, tenantId, userId,
              conflictStrategy, existingRecordIds, authProfileMapping, ... }
   c. result = await disassembler.disassemble(ctx)
   d. Accumulate records, superseded, warnings
5. Stage: StagedImporter.stage(projectId, tenantId, allRecords) → stagedRecordIds
6. Cross-Reference Resolution: resolveCrossReferences(stagedRecordIds, db)
   - STEP 1: Builds name→newId maps via 5 anchor queries
   - STEP 2: Re-queries 5 dependent collections from DB (new _ids needed)
   - Issues 7-8 batched bulkWrite calls to update foreign keys
   - Strips all temporary _ fields from staged records
   - Total: ~18-20 round trips (10 queries + 7-8 bulkWrites)
7. Activate: StagedImporter.activate(projectId, tenantId, allRecords, allSuperseded, layers)
8. validatePostImport(...)
```

---

## 3.14 Complete Collection Mapping Reference

| Layer       | Entity Type                      | MongoDB Collection         | Export File Pattern                                    | Match Field for Supersede        |
| ----------- | -------------------------------- | -------------------------- | ------------------------------------------------------ | -------------------------------- |
| core        | Agent                            | `project_agents`           | `agents/{name}.agent.abl`                              | `name`                           |
| core        | Tool                             | `project_tools`            | `tools/{name}.tools.abl`                               | `slug`                           |
| core        | Project Settings                 | `project_settings`         | `config/project-settings.json`                         | singleton                        |
| core        | Runtime Config                   | `project_runtime_configs`  | `config/runtime-config.json`                           | singleton                        |
| core        | LLM Config                       | `project_llm_configs`      | `config/llm-config.json`                               | singleton                        |
| core        | Agent Model Config               | `agent_model_configs`      | `config/agent-model-configs/{name}.model-config.json`  | `agentName`                      |
| core        | Env Variable                     | `environment_variables`    | `environment/env-vars.json` (array)                    | `key`                            |
| core        | Config Variable                  | `project_config_variables` | `environment/config-vars.json` (array)                 | `name`                           |
| core        | MCP Server                       | `mcp_server_configs`       | `core/mcp-servers/{name}.mcp-config.json`              | `serverName`                     |
| core        | Behavior Profile **[R1: MAJ-1]** | `project_config_variables` | `behavior_profiles/{name}.behavior_profile.abl`        | `key` (prefix: `profile:`)       |
| core        | Locale **[R1: MAJ-1]**           | `project_config_variables` | `locales/{locale}/{name}.json`                         | `key` (prefix: `locale:`)        |
| connections | Connection                       | `connector_connections`    | `connections/connectors/{name}.connection.json`        | `displayName` or `connectorName` |
| connections | Connector Config                 | `connector_configs`        | `connections/configs/{name}.connector-config.json`     | `connectorType`                  |
| guardrails  | Policy                           | `guardrail_policies`       | `guardrails/{name}.guardrail.json`                     | `name`                           |
| workflows   | Workflow                         | `workflows`                | `workflows/{name}.workflow.json`                       | `name`                           |
| workflows   | Workflow Version                 | `workflow_versions`        | `workflows/versions/{name}/{ver}.version.json`         | `workflowId` + `version`         |
| evals       | Eval Set                         | `eval_sets`                | `evals/{setName}/eval-set.json`                        | `name`                           |
| evals       | Scenario (nested)                | `eval_scenarios`           | `evals/{setName}/scenarios/{name}.scenario.json`       | `name`                           |
| evals       | Persona (nested)                 | `eval_personas`            | `evals/{setName}/personas/{name}.persona.json`         | `name`                           |
| evals       | Scenario (standalone)            | `eval_scenarios`           | `evals/scenarios/{name}.scenario.json`                 | `name`                           |
| evals       | Persona (standalone)             | `eval_personas`            | `evals/personas/{name}.persona.json`                   | `name`                           |
| evals       | Evaluator                        | `eval_evaluators`          | `evals/evaluators/{name}.evaluator.json`               | `name`                           |
| search      | Index                            | `search_indexes`           | `search/indexes/{slug}.index.json`                     | `slug`                           |
| search      | Source                           | `search_sources`           | `search/sources/{name}.source.json`                    | `name`                           |
| search      | Knowledge Base                   | `knowledge_bases`          | `search/knowledge-bases/{name}.kb.json`                | `name`                           |
| search      | Crawl Pattern                    | `crawl_patterns`           | `search/crawl-patterns.json` (array)                   | `domain`                         |
| channels    | Channel                          | `channel_connections`      | `channels/{name}.channel.json`                         | `displayName`                    |
| channels    | Webhook                          | `webhook_subscriptions`    | `channels/webhooks/{name}.webhook.json`                | `description`                    |
| channels    | Widget Config                    | `widget_configs`           | `channels/widgets/widget-config.json`                  | singleton                        |
| vocabulary  | Domain Vocab                     | `domain_vocabularies`      | `vocabulary/domain-vocabulary.json` (array)            | project-scoped                   |
| vocabulary  | Lookup Entry                     | `lookup_entries`           | `vocabulary/lookup-tables/{table}.lookup.json` (array) | `tableName`                      |
| vocabulary  | Schema                           | `canonical_schemas`        | `vocabulary/schemas/{id}.schema.json`                  | `knowledgeBaseId`                |
| vocabulary  | Fact                             | `facts`                    | `vocabulary/facts.json` (array)                        | `key`                            |

---

## 3.15 Implementation Order

Implementation should follow this order, based on dependency relationships and complexity:

### Phase A: Foundation (no cross-references)

1. **`disassembler-utils.ts`** — Shared parse/inject/build utilities
2. **`collection-names.ts`** — Collection name constants
3. **`types.ts`** — Interface definitions
4. **`GuardrailsDisassembler`** — Simplest: single collection, flat JSON, no cross-refs
5. **`VocabularyDisassembler`** — Multiple collections but no cross-refs, array files

### Phase B: Single-collection layers

6. **`CoreDisassembler`** — Many entity types but no inter-record cross-refs; DSL files (not JSON) for agents/tools
7. **`ConnectionsDisassembler`** — Auth profile mapping integration; depends on auth-mapping.ts

### Phase C: Cross-referencing layers

8. **`cross-ref-resolver.ts`** — Generic two-pass resolution engine
9. **`WorkflowsDisassembler`** — Workflow + version cross-ref; reuses `buildWorkflowVersionRecords`
10. **`SearchDisassembler`** — indexId cross-ref for sources and KBs
11. **`ChannelsDisassembler`** — channelConnectionId cross-ref for webhooks

### Phase D: Complex nesting

12. **`EvalsDisassembler`** — Deepest nesting: sets with nested + standalone scenarios/personas, array-based cross-refs

### Phase E: Integration

13. **`index.ts`** — Registry and exports
14. **Orchestrator integration** — Wire disassemblers into the import pipeline
15. **Roundtrip test updates** — Replace manual StagedRecord construction in `export-import-roundtrip.test.ts` with disassembler calls

---

## 3.16 Testing Strategy

### Unit Tests (per disassembler)

Each disassembler gets a test file: `packages/project-io/src/__tests__/{layer}-disassembler.test.ts`

**Test pattern:**

1. Build a `Map<string, string>` mimicking the assembler output for that layer.
2. Call `disassembler.disassemble(ctx)`.
3. Assert:
   - Correct number of `StagedRecord` entries.
   - Each record has the correct `layer`, `collection`, and `data` shape.
   - Ownership fields (`projectId`, `tenantId`, `createdBy`) are injected.
   - Warnings are generated for malformed files.
   - Temporary cross-ref fields (prefixed with `_`) are present where expected.

**Edge cases to cover:**

- Empty file map (no files for this layer) returns empty records with no errors.
- Malformed JSON produces a warning and skips the file.
- Duplicate entity names (two files with the same derived name) produce a warning.
- Array files (`env-vars.json`, `crawl-patterns.json`, `facts.json`) with non-array content.

### Cross-Reference Resolver Tests

- Mock staged record IDs to verify foreign key updates.
- Verify that missing anchors produce warnings (not errors).
- Verify that temporary `_` fields are stripped after resolution.

### Roundtrip Integration Test

Update `export-import-roundtrip.test.ts`:

```
Export (mock assemblers) → readFolderV2 → disassemble all layers → StagedImporter.execute
```

Assert that every entity exported by the assemblers is recovered as a `StagedRecord` with the correct collection and data shape.

---

## 3.17 Open Questions and Future Work

1. **Eval set `evaluatorIds` resolution**: The export format stores evaluator references as ObjectIds in the eval set. Since evaluator names are not embedded in the set JSON, there is no portable join key. Options:
   - (A) Enhance the assembler to include evaluator names in eval-set.json.
   - (B) Clear `evaluatorIds` on import and require manual re-linking.
   - **Recommendation**: Option A as a future enhancement; Option B for initial implementation.

2. **Guardrail `scope.agentId` resolution**: Agent-scoped guardrails export `scope.agentId` which is a stale ObjectId. The disassembler should resolve this via agent name, but the assembler does not currently export the agent name alongside `scope.agentId`. Same solution pattern as evaluatorIds — enhance export format or clear and warn.

3. **Search source `indexId` join strategy**: The current approach stores `_indexSlug` as a temporary field. An alternative is to have the assembler nest sources under their index directory (`search/indexes/{slug}/sources/{name}.source.json`), which would make the relationship explicit in the file structure. This is a potential export format v2.1 enhancement.

4. **Idempotent re-import**: The supersede logic uses name-based matching. If an entity is renamed between exports, the old-named entity is not superseded (it remains active) and the new-named entity is added. This is by design — rename detection would require content hashing or explicit rename tracking in the manifest.
