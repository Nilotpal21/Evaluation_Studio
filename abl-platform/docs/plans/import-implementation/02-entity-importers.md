# Section 2: Entity Import Apply Operations

> **Scope**: v1 fixes for tools, profiles, locales, configs + v2 core entity import alignment
> **Status**: Draft
> **Prerequisite**: Section 1 (gap analysis — confirms that `computeApplyOperations` only handles agents)

> **[R1 Fix: INC-4]** Relationship between Section 2 and Section 3:
>
> - **Section 2** covers the **v1 import path** (`importProject` + `computeApplyOperations`
>   \+ `import-applier`). It fixes the v1 bug where tools, profiles, locales, and configs
>   are silently dropped. This code runs when the v1 route is used directly.
> - **Section 3** covers the **v2 import path** (`importProjectV2` + `LayerDisassembler`
>   \+ `StagedImporter`). This is a completely separate code path using staged records
>   and atomic activation instead of direct DB writes.
> - The two paths **do not share apply logic**. They coexist: v1 for backward
>   compatibility, v2 for all new imports. Section 2's `ApplyOperation` discriminated union
>   is consumed only by the v1 route handler. Section 3's `StagedRecord` approach replaces
>   it entirely for v2.
> - Long-term, v1 import may delegate to v2 internally (via `migrateV1ToV2`), at which
>   point Section 2's apply logic becomes dead code. But for the initial release, both
>   paths are active.

---

## 1. Problem Summary

The v1 `importProject` function in `packages/project-io/src/import/project-importer.ts` does three things correctly:

1. Reads ALL file types via `readFolder()` (agents, tools, configs, deployments, locales, profiles)
2. Computes preview diffs for all entity types (tools, locales, profiles show added/modified/removed)
3. Computes apply operations for **agents only** via `computeApplyOperations()`

The Runtime route (`apps/runtime/src/routes/project-io.ts` POST `/import`) then:

- Loads only existing agents from the DB (`ProjectAgent.find`)
- Applies only agent operations (create/update/delete `ProjectAgent`)
- Passes an empty `toolFiles: new Map()` for existing state -- no tool diffing against DB

**Result**: Tools, profiles, locales, configs, and deployments from export are silently dropped during import. The preview UI shows they exist but the apply step ignores them entirely.

---

## 2. Expanded `ApplyOperation` Discriminated Union

### Current (agent-only)

```ts
// packages/project-io/src/import/import-applier.ts
interface ApplyOperation {
  type: 'create' | 'update' | 'delete';
  agentName: string;
  dslContent: string | null;
  description: string | null;
}
```

### Proposed: Discriminated Union

Replace the single `ApplyOperation` with a tagged union. The discriminant is `entityType`.

```ts
// packages/project-io/src/import/import-applier.ts

// ── Common base ─────────────────────────────────────────────────────
type ApplyOperationType = 'create' | 'update' | 'delete';
type ApplyEntityType = 'agent' | 'tool' | 'profile' | 'locale' | 'config' | 'deployment';

interface ApplyOperationBase {
  type: ApplyOperationType;
  entityType: ApplyEntityType;
}

// ── Per-entity operation types ─────────────────────────────────────

interface ApplyAgentOperation extends ApplyOperationBase {
  entityType: 'agent';
  agentName: string;
  dslContent: string | null;
  description: string | null;
}

interface ApplyToolOperation extends ApplyOperationBase {
  entityType: 'tool';
  toolName: string;
  toolSlug: string;
  dslContent: string | null;
  toolType: ProjectToolType | null; // extracted from DSL at operation-build time
  description: string | null;
}

interface ApplyProfileOperation extends ApplyOperationBase {
  entityType: 'profile';
  profileName: string;
  dslContent: string | null;
}

interface ApplyLocaleOperation extends ApplyOperationBase {
  entityType: 'locale';
  localePath: string; // e.g. "en/booking_agent.json"
  content: string | null;
}

interface ApplyConfigOperation extends ApplyOperationBase {
  entityType: 'config';
  configPath: string; // e.g. "models.json" or "environment.json"
  content: string | null;
}

interface ApplyDeploymentOperation extends ApplyOperationBase {
  entityType: 'deployment';
  type: 'create' | 'update'; // never "delete" -- deployments are append-only
  environment: string;
  content: string; // serialized deployment JSON
}

// ── Union ───────────────────────────────────────────────────────────

type ApplyOperation =
  | ApplyAgentOperation
  | ApplyToolOperation
  | ApplyProfileOperation
  | ApplyLocaleOperation
  | ApplyConfigOperation
  | ApplyDeploymentOperation;
```

### Backward Compatibility

The existing `ApplyOperation` is only consumed by:

1. `project-importer.ts` (returns `operations: ApplyOperation[]`)
2. `apps/runtime/src/routes/project-io.ts` POST `/import` (iterates operations)
3. Test files

The old shape is a strict subset of `ApplyAgentOperation`. Migration path:

- Add `entityType: 'agent'` to all existing agent operations in `computeApplyOperations`
- The runtime route already filters by `o.type === 'create'` etc. It will additionally filter by `o.entityType === 'agent'` for agent-specific handling

---

## 3. Expanded `ExistingProjectState`

### Current

```ts
// packages/project-io/src/import/project-importer.ts
interface ExistingProjectState {
  agents: Map<string, { name: string; dslContent: string | null }>;
  toolFiles: Map<string, string>; // always empty in runtime route
  localeFiles?: Map<string, string>; // optional, never populated by route
  profileFiles?: Map<string, string>; // optional, never populated by route
}
```

### Proposed

```ts
interface ExistingProjectState {
  // Agents: name -> { name, dslContent }
  agents: Map<string, { name: string; dslContent: string | null }>;

  // Tools: name -> { name, slug, dslContent, toolType, description }
  tools: Map<
    string,
    {
      name: string;
      slug: string;
      dslContent: string;
      toolType: ProjectToolType;
      description: string | null;
    }
  >;

  // Profiles: name -> dslContent  (behavior profile ABL files)
  // NOTE: Behavior profiles do NOT have a dedicated DB model today.
  // They are embedded in agent DSL (BEHAVIOR_PROFILE section) and compiled
  // into the agent IR. Standalone .behavior_profile.abl files exist in
  // the export format but have no 1:1 DB collection. Phase 1 will store
  // them as ProjectConfigVariable entries with a "profile:" key prefix.
  // Phase 2 introduces a dedicated ProjectBehaviorProfile model.
  profiles: Map<string, string>;

  // Locales: path -> content  (e.g. "en/booking_agent.json" -> JSON string)
  // NOTE: Locale files also lack a dedicated DB model. They are project-level
  // i18n JSON files. Phase 1 stores them as ProjectConfigVariable entries
  // with a "locale:" key prefix. Phase 2 introduces a ProjectLocale model.
  locales: Map<string, string>;

  // Configs: path -> content  (e.g. "models.json" -> JSON string)
  // Maps to ProjectConfigVariable (key = path, value = content)
  configs: Map<string, string>;
}
```

### Database Queries for Loading Existing State

The runtime route must load all entity types in a single parallel batch. All queries are scoped to `{ projectId, tenantId }` for resource isolation.

```ts
// apps/runtime/src/routes/project-io.ts — inside import handler

async function loadExistingProjectState(
  projectId: string,
  tenantId: string,
): Promise<ExistingProjectState> {
  const [agents, tools, configVars] = await Promise.all([
    // 1. Agents — existing query, unchanged
    ProjectAgent.find({ projectId }).select('name dslContent').lean() as Promise<
      Pick<IProjectAgent, 'name' | 'dslContent'>[]
    >,

    // 2. Tools — NEW query
    ProjectTool.find({ projectId, tenantId })
      .select('name slug dslContent toolType description')
      .lean() as Promise<
      Pick<IProjectTool, 'name' | 'slug' | 'dslContent' | 'toolType' | 'description'>[]
    >,

    // 3. Config variables — covers configs, locales, profiles (Phase 1)
    //    Key convention:
    //      "profile:<name>"  -> behavior profile DSL
    //      "locale:<path>"   -> locale JSON
    //      "<path>"          -> config JSON (no prefix)
    ProjectConfigVariable.find({ projectId, tenantId }).select('key value').lean() as Promise<
      Pick<IProjectConfigVariable, 'key' | 'value'>[]
    >,
  ]);

  // Build Maps
  const agentMap = new Map(agents.map((a) => [a.name, { name: a.name, dslContent: a.dslContent }]));

  const toolMap = new Map(
    tools.map((t) => [
      t.name,
      {
        name: t.name,
        slug: t.slug,
        dslContent: t.dslContent,
        toolType: t.toolType,
        description: t.description,
      },
    ]),
  );

  const profileMap = new Map<string, string>();
  const localeMap = new Map<string, string>();
  const configMap = new Map<string, string>();

  for (const cv of configVars) {
    if (cv.key.startsWith('profile:')) {
      profileMap.set(cv.key.slice('profile:'.length), cv.value);
    } else if (cv.key.startsWith('locale:')) {
      localeMap.set(cv.key.slice('locale:'.length), cv.value);
    } else {
      configMap.set(cv.key, cv.value);
    }
  }

  return {
    agents: agentMap,
    tools: toolMap,
    profiles: profileMap,
    locales: localeMap,
    configs: configMap,
  };
}
```

### Query Performance

- **Agents**: Uses compound index `{ tenantId: 1, projectId: 1 }` -- covered query with `.select()`
- **Tools**: Uses compound index `{ tenantId: 1, projectId: 1 }` -- covered query
- **ConfigVariables**: Uses compound index `{ tenantId: 1, projectId: 1 }` -- single scan, partition in JS

Total: 3 parallel queries. No N+1. Expected latency: < 50ms for typical projects (< 100 agents, < 50 tools).

---

## 4. `computeApplyOperations` Expansion

### Architecture Decision: Single Function vs. Per-Entity Functions

**Decision**: Keep a single `computeApplyOperations` entry point that delegates to per-entity helpers. The caller gets back a flat `ApplyOperation[]` sorted by dependency order (tools before agents, since agents reference tools).

### Function Signature

```ts
// packages/project-io/src/import/import-applier.ts

interface ApplyInput {
  // Existing state (loaded from DB)
  existing: ExistingProjectState;

  // Imported state (parsed from folder reader)
  imported: {
    agents: Map<
      string,
      {
        name: string;
        dslContent: string;
        description: string | null;
      }
    >;
    tools: Map<string, { name: string; dslContent: string }>;
    profiles: Map<string, string>; // name -> DSL content
    locales: Map<string, string>; // path -> JSON content
    configs: Map<string, string>; // path -> JSON content
    deployments: Map<string, string>; // path -> JSON content
  };
}

function computeApplyOperations(input: ApplyInput): ApplyOperation[];
```

### Backward Compatibility Bridge

To avoid a breaking change in a single PR, introduce the new signature alongside the old one:

```ts
// Keep old signature working (deprecated)
function computeApplyOperations(input: LegacyApplyInput): ApplyAgentOperation[];
// New overload
function computeApplyOperations(input: ApplyInput): ApplyOperation[];
// Implementation uses runtime check: if input has 'existing' key, use new path
```

This is a transitional measure. The old overload is removed once the runtime route is updated.

### Per-Entity Diff Logic

#### 4a. Tool Operations

```ts
function computeToolOperations(
  existingTools: ExistingProjectState['tools'],
  importedTools: Map<string, { name: string; dslContent: string }>,
): ApplyToolOperation[] {
  const ops: ApplyToolOperation[] = [];

  // Created tools (in import, not in existing)
  for (const [name, imported] of importedTools) {
    if (!existingTools.has(name)) {
      ops.push({
        type: 'create',
        entityType: 'tool',
        toolName: name,
        toolSlug: slugify(name),
        dslContent: imported.dslContent,
        toolType: extractToolTypeFromDSL(imported.dslContent),
        description: extractToolDescriptionFromDSL(imported.dslContent),
      });
    }
  }

  // Updated tools (in both, content differs)
  for (const [name, imported] of importedTools) {
    const existing = existingTools.get(name);
    if (existing && existing.dslContent !== imported.dslContent) {
      ops.push({
        type: 'update',
        entityType: 'tool',
        toolName: name,
        toolSlug: existing.slug, // preserve existing slug -- slugs are immutable
        dslContent: imported.dslContent,
        toolType: extractToolTypeFromDSL(imported.dslContent),
        description: extractToolDescriptionFromDSL(imported.dslContent),
      });
    }
  }

  // Deleted tools (in existing, not in import)
  for (const [name] of existingTools) {
    if (!importedTools.has(name)) {
      ops.push({
        type: 'delete',
        entityType: 'tool',
        toolName: name,
        toolSlug: existingTools.get(name)!.slug,
        dslContent: null,
        toolType: null,
        description: null,
      });
    }
  }

  return ops;
}
```

**Tool type extraction**: Parse the DSL for `TYPE:` header. Falls back to `'http'` if not found.

```ts
function extractToolTypeFromDSL(dsl: string): ProjectToolType {
  const match = dsl.match(/^TYPE:\s*(http|mcp|sandbox|searchai)/im);
  return match ? (match[1].toLowerCase() as ProjectToolType) : 'http';
}

function extractToolDescriptionFromDSL(dsl: string): string | null {
  const match = dsl.match(/^DESCRIPTION:\s*(.+)/im);
  return match ? match[1].trim() : null;
}
```

**Slug generation**: Tool slugs are immutable after creation (enforced by the `ProjectTool` pre-save hook). For new tools, generate from name. For updates, preserve existing slug.

```ts
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}
```

#### 4b. Profile Operations

```ts
function computeProfileOperations(
  existingProfiles: Map<string, string>,
  importedProfiles: Map<string, string>,
): ApplyProfileOperation[] {
  const ops: ApplyProfileOperation[] = [];

  for (const [name, content] of importedProfiles) {
    if (!existingProfiles.has(name)) {
      ops.push({
        type: 'create',
        entityType: 'profile',
        profileName: name,
        dslContent: content,
      });
    } else if (existingProfiles.get(name) !== content) {
      ops.push({
        type: 'update',
        entityType: 'profile',
        profileName: name,
        dslContent: content,
      });
    }
  }

  for (const [name] of existingProfiles) {
    if (!importedProfiles.has(name)) {
      ops.push({
        type: 'delete',
        entityType: 'profile',
        profileName: name,
        dslContent: null,
      });
    }
  }

  return ops;
}
```

**Profile name extraction from folder-reader output**: The folder reader returns paths like `behavior_profiles/formal_tone.behavior_profile.abl`. Extract the name:

```ts
function extractProfileName(path: string): string {
  return path.replace(/^behavior_profiles\//, '').replace(/\.behavior_profile\.abl$/, '');
}
```

#### 4c. Locale Operations

```ts
function computeLocaleOperations(
  existingLocales: Map<string, string>,
  importedLocales: Map<string, string>,
): ApplyLocaleOperation[] {
  const ops: ApplyLocaleOperation[] = [];

  // Normalize paths: folder reader returns "locales/en/agent.json"
  // but ExistingProjectState stores "en/agent.json" (no "locales/" prefix)
  for (const [path, content] of importedLocales) {
    const normalizedPath = path.replace(/^locales\//, '');
    if (!existingLocales.has(normalizedPath)) {
      ops.push({
        type: 'create',
        entityType: 'locale',
        localePath: normalizedPath,
        content,
      });
    } else if (existingLocales.get(normalizedPath) !== content) {
      ops.push({
        type: 'update',
        entityType: 'locale',
        localePath: normalizedPath,
        content,
      });
    }
  }

  const importedNormalized = new Set(
    [...importedLocales.keys()].map((p) => p.replace(/^locales\//, '')),
  );
  for (const [path] of existingLocales) {
    if (!importedNormalized.has(path)) {
      ops.push({
        type: 'delete',
        entityType: 'locale',
        localePath: path,
        content: null,
      });
    }
  }

  return ops;
}
```

#### 4d. Config Operations

```ts
function computeConfigOperations(
  existingConfigs: Map<string, string>,
  importedConfigs: Map<string, string>,
): ApplyConfigOperation[] {
  const ops: ApplyConfigOperation[] = [];

  for (const [path, content] of importedConfigs) {
    const normalizedPath = path.replace(/^config\//, '');
    if (!existingConfigs.has(normalizedPath)) {
      ops.push({
        type: 'create',
        entityType: 'config',
        configPath: normalizedPath,
        content,
      });
    } else if (existingConfigs.get(normalizedPath) !== content) {
      ops.push({
        type: 'update',
        entityType: 'config',
        configPath: normalizedPath,
        content,
      });
    }
  }

  const importedNormalized = new Set(
    [...importedConfigs.keys()].map((p) => p.replace(/^config\//, '')),
  );
  for (const [path] of existingConfigs) {
    if (!importedNormalized.has(path)) {
      ops.push({
        type: 'delete',
        entityType: 'config',
        configPath: path,
        content: null,
      });
    }
  }

  return ops;
}
```

#### 4e. Deployment Operations

Deployments have special semantics:

- Active deployments have a unique constraint: `{ projectId, environment, status: 'active' }` (partial unique index)
- Importing a deployment for an environment that already has an active deployment should NOT delete the old one -- it should warn
- Deployments are never deleted via import (they are append-only audit records)

```ts
function computeDeploymentOperations(
  importedDeployments: Map<string, string>,
): ApplyDeploymentOperation[] {
  // Deployments from import are informational snapshots.
  // They are NOT applied automatically -- only surfaced in preview.
  // Rationale: deployments pin specific agent versions and require
  // explicit user action (deploy flow) to activate.
  return []; // Phase 1: no-op. Phase 2: optional "restore deployment" flow.
}
```

### Operation Ordering

The combined `computeApplyOperations` returns operations in dependency order:

1. **Tool creates** (tools must exist before agents can reference them)
2. **Profile creates**
3. **Config creates**
4. **Locale creates**
5. **Agent creates**
6. **Tool updates** / **Profile updates** / **Config updates** / **Locale updates** / **Agent updates**
7. **Agent deletes**
8. **Tool deletes** (delete agents first so no dangling references)
9. **Profile deletes** / **Config deletes** / **Locale deletes**

```ts
function computeApplyOperations(input: ApplyInput): ApplyOperation[] {
  const toolOps = computeToolOperations(input.existing.tools, input.imported.tools);
  const profileOps = computeProfileOperations(input.existing.profiles, input.imported.profiles);
  const localeOps = computeLocaleOperations(input.existing.locales, input.imported.locales);
  const configOps = computeConfigOperations(input.existing.configs, input.imported.configs);
  const agentOps = computeAgentOperations(input.existing.agents, input.imported.agents);
  const deploymentOps = computeDeploymentOperations(input.imported.deployments);

  // Order: creates (tools first) -> updates -> deletes (agents first)
  const creates = [
    ...toolOps.filter((o) => o.type === 'create'),
    ...profileOps.filter((o) => o.type === 'create'),
    ...configOps.filter((o) => o.type === 'create'),
    ...localeOps.filter((o) => o.type === 'create'),
    ...agentOps.filter((o) => o.type === 'create'),
  ];

  const updates = [
    ...toolOps.filter((o) => o.type === 'update'),
    ...profileOps.filter((o) => o.type === 'update'),
    ...configOps.filter((o) => o.type === 'update'),
    ...localeOps.filter((o) => o.type === 'update'),
    ...agentOps.filter((o) => o.type === 'update'),
  ];

  const deletes = [
    ...agentOps.filter((o) => o.type === 'delete'),
    ...toolOps.filter((o) => o.type === 'delete'),
    ...profileOps.filter((o) => o.type === 'delete'),
    ...configOps.filter((o) => o.type === 'delete'),
    ...localeOps.filter((o) => o.type === 'delete'),
  ];

  return [...creates, ...updates, ...deletes, ...deploymentOps];
}
```

---

## 5. Runtime Route Fixes

### 5a. POST `/import/preview` Changes

The preview route must load full existing state so that diffs are accurate for ALL entity types.

```ts
// BEFORE (current — loads agents only, empty toolFiles)
const existingState: ExistingProjectState = {
  agents: new Map(existingAgents.map((a) => [a.name, ...])),
  toolFiles: new Map(), // <-- BUG: always empty
};

// AFTER
const existingState = await loadExistingProjectState(projectId, tenantId);
```

The `importProject` function already computes preview diffs for tools/locales/profiles. With correct existing state flowing in, the preview response will be accurate.

### 5b. POST `/import` — Multi-Entity Apply

The import route needs to apply ALL operation types, not just agents. The apply happens in a specific order with rollback support.

#### Apply Flow

```
┌─────────────┐
│  Validate    │  computeApplyOperations()
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 1:   │  Tool creates/updates (bulkWrite)
│  Tools      │  → Track created tool IDs for rollback
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 2:   │  Profile creates/updates (bulkWrite ProjectConfigVariable)
│  Profiles   │  → Track created profile IDs for rollback
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 3:   │  Config creates/updates (bulkWrite ProjectConfigVariable)
│  Configs    │  → Track created config IDs for rollback
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 4:   │  Locale creates/updates (bulkWrite ProjectConfigVariable)
│  Locales    │  → Track created locale IDs for rollback
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 5:   │  Agent creates/updates/deletes (existing logic)
│  Agents     │  → Track created agent IDs for rollback
└──────┬──────┘
       ▼
┌─────────────┐
│  Phase 6:   │  Tool deletes, Profile/Config/Locale deletes
│  Cleanup    │  (after agents, so no dangling refs)
└──────┬──────┘
       ▼
┌─────────────┐
│  Complete   │  Return applied counts per entity type
└─────────────┘
```

#### Batch Operations

Each entity type uses MongoDB `bulkWrite` for performance. The pattern is identical to the current agent pattern, extended per entity.

**Tool Apply**:

```ts
async function applyToolOperations(
  ops: ApplyToolOperation[],
  ctx: { projectId: string; tenantId: string; userId: string },
): Promise<{ createdIds: string[]; error?: Error }> {
  const createdIds: string[] = [];
  const now = new Date();

  const createOps = ops.filter((o) => o.type === 'create');
  const updateOps = ops.filter((o) => o.type === 'update');
  const deleteOps = ops.filter((o) => o.type === 'delete');

  // Creates: insertMany
  if (createOps.length > 0) {
    const docs = createOps.map((op) => ({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      name: op.toolName,
      slug: op.toolSlug,
      toolType: op.toolType ?? 'http',
      description: op.description,
      dslContent: op.dslContent!,
      sourceHash: computeSourceHash(op.dslContent!),
      createdBy: ctx.userId,
      lastEditedBy: ctx.userId,
    }));
    const created = await ProjectTool.insertMany(docs);
    for (const doc of created) {
      createdIds.push(String(doc._id));
    }
  }

  // Updates: bulkWrite updateOne
  if (updateOps.length > 0) {
    const bulkOps = updateOps.map((op) => ({
      updateOne: {
        filter: {
          projectId: ctx.projectId,
          tenantId: ctx.tenantId,
          name: op.toolName,
        },
        update: {
          $set: {
            dslContent: op.dslContent,
            toolType: op.toolType,
            description: op.description,
            sourceHash: op.dslContent ? computeSourceHash(op.dslContent) : undefined,
            lastEditedBy: ctx.userId,
          },
          $inc: { _v: 1 },
        },
      },
    }));
    await ProjectTool.bulkWrite(bulkOps);
  }

  // Deletes: deleteMany
  if (deleteOps.length > 0) {
    const deleteNames = deleteOps.map((op) => op.toolName);
    await ProjectTool.deleteMany({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      name: { $in: deleteNames },
    });
  }

  return { createdIds };
}
```

**Profile/Locale/Config Apply** (all use `ProjectConfigVariable`):

```ts
async function applyConfigVariableOperations(
  ops: (ApplyProfileOperation | ApplyLocaleOperation | ApplyConfigOperation)[],
  keyPrefix: string, // "profile:", "locale:", or ""
  ctx: { projectId: string; tenantId: string; userId: string },
): Promise<{ createdIds: string[]; error?: Error }> {
  const createdIds: string[] = [];

  const createOps = ops.filter((o) => o.type === 'create');
  const updateOps = ops.filter((o) => o.type === 'update');
  const deleteOps = ops.filter((o) => o.type === 'delete');

  // Extract the entity-specific key from the operation
  function getKey(op: ApplyProfileOperation | ApplyLocaleOperation | ApplyConfigOperation): string {
    if (op.entityType === 'profile') return op.profileName;
    if (op.entityType === 'locale') return op.localePath;
    return op.configPath;
  }

  function getContent(
    op: ApplyProfileOperation | ApplyLocaleOperation | ApplyConfigOperation,
  ): string | null {
    if (op.entityType === 'profile') return op.dslContent;
    return op.content;
  }

  // Creates: insertMany
  if (createOps.length > 0) {
    const docs = createOps.map((op) => ({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      key: `${keyPrefix}${getKey(op)}`,
      value: getContent(op)!,
      description: null,
      createdBy: ctx.userId,
    }));
    const created = await ProjectConfigVariable.insertMany(docs);
    for (const doc of created) {
      createdIds.push(String(doc._id));
    }
  }

  // Updates: bulkWrite
  if (updateOps.length > 0) {
    const bulkOps = updateOps.map((op) => ({
      updateOne: {
        filter: {
          projectId: ctx.projectId,
          tenantId: ctx.tenantId,
          key: `${keyPrefix}${getKey(op)}`,
        },
        update: {
          $set: {
            value: getContent(op),
            updatedBy: ctx.userId,
          },
          $inc: { _v: 1 },
        },
      },
    }));
    await ProjectConfigVariable.bulkWrite(bulkOps);
  }

  // Deletes: deleteMany
  if (deleteOps.length > 0) {
    const deleteKeys = deleteOps.map((op) => `${keyPrefix}${getKey(op)}`);
    await ProjectConfigVariable.deleteMany({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      key: { $in: deleteKeys },
    });
  }

  return { createdIds };
}
```

### 5c. Rollback Strategy

The current agent-only rollback deletes created agents on failure. The multi-entity rollback must undo ALL phases completed before the failure.

```ts
interface RollbackTracker {
  createdToolIds: string[];
  createdConfigVarIds: string[]; // profiles + locales + configs
  createdAgentIds: string[];
}

async function rollbackImport(
  tracker: RollbackTracker,
  ctx: { projectId: string; tenantId: string },
): Promise<void> {
  const rollbackPromises: Promise<void>[] = [];

  if (tracker.createdToolIds.length > 0) {
    rollbackPromises.push(
      ProjectTool.deleteMany({ _id: { $in: tracker.createdToolIds } })
        .then(() => undefined)
        .catch((err: unknown) => {
          log.error('Rollback failed: tools', {
            projectId: ctx.projectId,
            ids: tracker.createdToolIds,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  if (tracker.createdConfigVarIds.length > 0) {
    rollbackPromises.push(
      ProjectConfigVariable.deleteMany({
        _id: { $in: tracker.createdConfigVarIds },
      })
        .then(() => undefined)
        .catch((err: unknown) => {
          log.error('Rollback failed: config variables', {
            projectId: ctx.projectId,
            ids: tracker.createdConfigVarIds,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  if (tracker.createdAgentIds.length > 0) {
    rollbackPromises.push(
      ProjectAgent.deleteMany({ _id: { $in: tracker.createdAgentIds } })
        .then(() => undefined)
        .catch((err: unknown) => {
          log.error('Rollback failed: agents', {
            projectId: ctx.projectId,
            ids: tracker.createdAgentIds,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  await Promise.allSettled(rollbackPromises);
}
```

**Rollback limitations** (documented, not solved in v1):

- **Updates are not rolled back.** If tool creates succeed but agent creates fail, tool updates that already ran cannot be reversed without storing the previous content. This is acceptable for v1 because updates are idempotent -- a re-import will re-apply them.
- **Deletes are not rolled back.** Deleted entities are gone. The apply order puts deletes LAST specifically to minimize this risk: if any create/update fails, deletes have not yet run.

### 5d. Response Shape Enhancement

```ts
// BEFORE
{
  success: true,
  applied: { created: 3, updated: 1, deleted: 0 }
}

// AFTER
{
  success: true,
  applied: {
    agents:   { created: 2, updated: 1, deleted: 0 },
    tools:    { created: 1, updated: 0, deleted: 0 },
    profiles: { created: 1, updated: 0, deleted: 0 },
    locales:  { created: 3, updated: 1, deleted: 0 },
    configs:  { created: 0, updated: 1, deleted: 0 },
  },
  totals: { created: 7, updated: 3, deleted: 0 },
}
```

The Zod schema for the response:

```ts
const entityApplyCountSchema = z.object({
  created: z.number(),
  updated: z.number(),
  deleted: z.number(),
});

const importApplyResponseSchema = z.object({
  success: z.boolean(),
  applied: z.object({
    agents: entityApplyCountSchema,
    tools: entityApplyCountSchema,
    profiles: entityApplyCountSchema,
    locales: entityApplyCountSchema,
    configs: entityApplyCountSchema,
  }),
  totals: entityApplyCountSchema,
});
```

---

## 6. Preview Response Enhancement

### 6a. Operation Counts per Entity Type

Add `operationCounts` to the preview response so the UI can show "This import will create 5 tools, update 2 agents, and add 3 locale files" before the user confirms.

```ts
interface ImportPreviewEnhanced extends ImportPreview {
  operationCounts: {
    agents: { create: number; update: number; delete: number };
    tools: { create: number; update: number; delete: number };
    profiles: { create: number; update: number; delete: number };
    locales: { create: number; update: number; delete: number };
    configs: { create: number; update: number; delete: number };
    deployments: { info: number }; // informational only
  };
  sizeEstimate: {
    totalContentBytes: number;
    entityCount: number;
  };
  requiredPermissions: string[];
}
```

### 6b. Size Estimates

Computed from the operations' content sizes:

```ts
function computeSizeEstimate(operations: ApplyOperation[]): {
  totalContentBytes: number;
  entityCount: number;
} {
  let totalContentBytes = 0;
  let entityCount = 0;

  for (const op of operations) {
    if (op.type === 'delete') continue;
    entityCount++;

    switch (op.entityType) {
      case 'agent':
        totalContentBytes += op.dslContent?.length ?? 0;
        break;
      case 'tool':
        totalContentBytes += op.dslContent?.length ?? 0;
        break;
      case 'profile':
        totalContentBytes += op.dslContent?.length ?? 0;
        break;
      case 'locale':
        totalContentBytes += op.content?.length ?? 0;
        break;
      case 'config':
        totalContentBytes += op.content?.length ?? 0;
        break;
    }
  }

  return { totalContentBytes, entityCount };
}
```

### 6c. Required Permissions

Import needs `project:import` (already checked). The preview can enumerate what sub-permissions the import will exercise:

```ts
function computeRequiredPermissions(operations: ApplyOperation[]): string[] {
  const perms = new Set<string>();
  perms.add('project:import'); // always required

  const entityTypes = new Set(operations.map((o) => o.entityType));
  if (entityTypes.has('agent')) perms.add('agent:edit');
  if (entityTypes.has('tool')) perms.add('tool:edit');
  if (operations.some((o) => o.type === 'delete' && o.entityType === 'agent'))
    perms.add('agent:delete');
  if (operations.some((o) => o.type === 'delete' && o.entityType === 'tool'))
    perms.add('tool:delete');

  return [...perms];
}
```

---

## 7. `project-importer.ts` Changes

The main `importProject` function needs to:

1. Pass full imported state (tools, profiles, locales, configs) to `computeApplyOperations`
2. Build the imported maps from folder reader output

### Key Changes

```ts
// packages/project-io/src/import/project-importer.ts

export function importProject(
  files: Map<string, string>,
  existingState: ExistingProjectState,
  _options: ImportOptions,
): ImportResult {
  // ... (Steps 1-5 unchanged: readFolder, validateManifest, validateImport, build importedAgents, compute diffs)

  // Step 6: Build imported tool map (name -> content)
  const importedTools = new Map<string, { name: string; dslContent: string }>();
  for (const [path, content] of folderResult.toolFiles) {
    const name = path.replace(/^tools\//, '').replace(/\.tools\.abl$/, '');
    importedTools.set(name, { name, dslContent: content });
  }

  // Step 7: Build imported profile map (name -> content)
  const importedProfiles = new Map<string, string>();
  for (const [path, content] of folderResult.profileFiles) {
    const name = path.replace(/^behavior_profiles\//, '').replace(/\.behavior_profile\.abl$/, '');
    importedProfiles.set(name, content);
  }

  // Step 8: Build imported locale map (normalized path -> content)
  const importedLocales = new Map<string, string>();
  for (const [path, content] of folderResult.localeFiles) {
    importedLocales.set(path, content); // path already starts with "locales/"
  }

  // Step 9: Build imported config map (normalized path -> content)
  const importedConfigs = new Map<string, string>();
  for (const [path, content] of folderResult.configFiles) {
    importedConfigs.set(path, content); // path starts with "config/"
  }

  // Step 10: Build imported deployment map
  const importedDeployments = new Map<string, string>();
  for (const [path, content] of folderResult.deploymentFiles) {
    importedDeployments.set(path, content);
  }

  // Step 11: Compute ALL apply operations
  const operations = computeApplyOperations({
    existing: existingState,
    imported: {
      agents: importedAgents,
      tools: importedTools,
      profiles: importedProfiles,
      locales: importedLocales,
      configs: importedConfigs,
      deployments: importedDeployments,
    },
  });

  // ... (Step 12: Build preview -- existing code already computes tool/locale/profile diffs)

  return { success: validationResult.valid, preview, operations };
}
```

---

## 8. Storage Strategy: Profiles, Locales, Configs (Phase 1 vs Phase 2)

### Phase 1: Reuse ProjectConfigVariable (v1 fix)

No new DB models. Store profiles, locales, and configs in `ProjectConfigVariable` with key prefixes:

| Entity  | Key Format           | Example Key                    | Value       |
| ------- | -------------------- | ------------------------------ | ----------- |
| Profile | `profile:<name>`     | `profile:formal_tone`          | DSL content |
| Locale  | `locale:<path>`      | `locale:en/booking_agent.json` | JSON string |
| Config  | `<path>` (no prefix) | `models.json`                  | JSON string |

**Pros**: Zero schema migration. Immediate fix. Uses existing compound index.
**Cons**: Key prefix convention is fragile. No separate indexes for type-specific queries.

### Phase 2: Dedicated Models (future)

Create `ProjectBehaviorProfile` and `ProjectLocale` models with proper schemas:

```ts
// Future: packages/database/src/models/project-behavior-profile.model.ts
interface IProjectBehaviorProfile {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  dslContent: string;
  priority: number;
  whenExpression: string | null;
  sourceHash: string;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Future: packages/database/src/models/project-locale.model.ts
interface IProjectLocale {
  _id: string;
  tenantId: string;
  projectId: string;
  localePath: string; // "en/booking_agent.json"
  localeCode: string; // "en"
  content: string; // JSON string
  sourceHash: string;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

The Phase 1 `applyConfigVariableOperations` function is designed to be swappable: when Phase 2 models exist, replace the apply function without changing `computeApplyOperations` or the operation types.

---

## 9. Test Plan

### 9a. Unit Tests: `computeApplyOperations`

File: `packages/project-io/src/__tests__/import-applier-expanded.test.ts`

| Test Case                                 | Asserts                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Empty import, empty existing              | Returns `[]`                                                                                          |
| New tools only                            | Returns `ApplyToolOperation[]` with `type: 'create'`                                                  |
| Updated tool (content changed)            | Returns `type: 'update'`, preserves existing slug                                                     |
| Deleted tool (in existing, not in import) | Returns `type: 'delete'`                                                                              |
| Tool unchanged (same content)             | Not in output                                                                                         |
| New profile                               | Returns `ApplyProfileOperation` with `type: 'create'`                                                 |
| Updated profile                           | Returns `type: 'update'`                                                                              |
| Deleted profile                           | Returns `type: 'delete'`                                                                              |
| New locale                                | Returns `ApplyLocaleOperation` with correct normalized path                                           |
| Updated locale                            | Content diff triggers `type: 'update'`                                                                |
| Deleted locale                            | Returns `type: 'delete'`                                                                              |
| New config                                | Returns `ApplyConfigOperation`                                                                        |
| Mixed: agents + tools + profiles          | All entity types present in output, ordered correctly                                                 |
| Operation ordering                        | Creates before updates before deletes; tools before agents in creates; agents before tools in deletes |
| Tool type extraction from DSL             | `extractToolTypeFromDSL` returns correct type for http/mcp/sandbox/searchai                           |
| Tool description extraction from DSL      | `extractToolDescriptionFromDSL` returns description or null                                           |
| Slug generation                           | `slugify` handles special chars, uppercase, underscores                                               |
| Backward compat: old ApplyInput shape     | Old agent-only input still works (produces `ApplyAgentOperation[]`)                                   |

### 9b. Roundtrip Tests

File: `packages/project-io/src/__tests__/import-roundtrip-expanded.test.ts`

| Test Case                         | Flow                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Export then import (tools)        | Export project with tools -> import -> verify tool operations match                   |
| Export then import (profiles)     | Export with profiles -> import -> verify profile operations                           |
| Export then import (locales)      | Export with locales -> import -> verify locale operations                             |
| Export then import (all entities) | Full roundtrip with agents + tools + profiles + locales + configs                     |
| Incremental import                | Import with some entities changed, verify only changed entities produce operations    |
| Delete detection                  | Import with fewer entities than existing -> verify delete operations for removed ones |

### 9c. Runtime Route Integration Tests

File: `apps/runtime/src/__tests__/project-io-import-expanded.test.ts`

| Test Case                                  | Asserts                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Preview shows tool operations              | `POST /import/preview` returns tool diffs with accurate existing state    |
| Preview shows profile operations           | `POST /import/preview` returns profile diffs                              |
| Preview shows locale operations            | `POST /import/preview` returns locale diffs                               |
| Import creates tools                       | `POST /import` creates `ProjectTool` documents                            |
| Import updates tools                       | `POST /import` updates existing tools, preserves slug                     |
| Import creates profiles via ConfigVariable | `POST /import` creates `ProjectConfigVariable` with `profile:` prefix     |
| Import creates locales via ConfigVariable  | `POST /import` creates `ProjectConfigVariable` with `locale:` prefix      |
| Rollback on agent failure                  | If agent create fails, tools created in same import are rolled back       |
| Rollback on tool failure                   | If tool create fails, no agents are created (tools come first)            |
| Response shape                             | Response includes per-entity `applied` counts                             |
| Concurrent import lock                     | Second concurrent import returns 409                                      |
| Existing state loaded correctly            | Tools, profiles, locales from DB flow into `importProject` existing state |

### 9d. Rollback Tests

File: `apps/runtime/src/__tests__/project-io-rollback.test.ts`

| Test Case                                   | Setup                                                       | Asserts                                              |
| ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Rollback after tool create fails            | Mock `ProjectTool.insertMany` to throw                      | No agents created, error response returned           |
| Rollback after agent create fails           | Mock `ProjectAgent.insertMany` to throw after tools succeed | Created tools are deleted                            |
| Rollback after config variable create fails | Mock `ProjectConfigVariable.insertMany` to throw            | Previously created tools rolled back                 |
| Rollback failure logged but not re-thrown   | Mock rollback `deleteMany` to also fail                     | Error logged, original error returned to client      |
| Partial update + rollback                   | Tools update succeeds, agent create fails                   | Tool updates NOT rolled back (documented limitation) |

---

## 10. Implementation Order

### PR 1: Expanded Types + Agent Backward Compat (non-breaking)

1. Add discriminated union types to `import-applier.ts`
2. Add `entityType: 'agent'` to existing agent operations
3. Update `ExistingProjectState` with optional new fields (backward compat)
4. Unit tests for new types
5. No runtime route changes yet

### PR 2: Tool Import Operations

1. `computeToolOperations` + helpers (`extractToolTypeFromDSL`, `slugify`)
2. `applyToolOperations` in runtime route
3. Load existing tools in `loadExistingProjectState`
4. Rollback tracker for tools
5. Unit + integration tests

### PR 3: Profile + Locale + Config Import Operations

1. `computeProfileOperations`, `computeLocaleOperations`, `computeConfigOperations`
2. `applyConfigVariableOperations` (shared for all three via key prefix)
3. Load existing profiles/locales/configs from `ProjectConfigVariable`
4. Rollback tracker for config variables
5. Unit + integration tests

### PR 4: Preview Enhancement + Response Shape

1. `operationCounts`, `sizeEstimate`, `requiredPermissions` in preview
2. Updated response Zod schemas
3. Per-entity counts in import response
4. Roundtrip tests

### PR 5: Operation Ordering + Full Integration

1. Dependency-ordered operation execution
2. Full multi-entity rollback
3. Roundtrip tests (export -> import -> verify all entities)
4. Performance benchmarks (100 agents, 50 tools, 20 profiles, 10 locales)

---

## 11. Open Questions

1. **Profile storage model**: Phase 1 uses `ProjectConfigVariable` with key prefixes. Should we skip straight to dedicated models? Risk: DB migration required before any fix ships.

2. **Delete semantics**: Should import delete entities that exist in the project but are not in the import bundle? Current behavior for agents: yes (delete if not in import). This is destructive. Alternative: only delete if the manifest explicitly lists the entity. Needs product decision.

3. **Config variable key collisions**: If a project already has a `ProjectConfigVariable` with key `models.json` that was NOT created by import, importing a `config/models.json` would overwrite it. Should we namespace import-managed config vars (e.g., `import:config:models.json`)?

4. **Deployment handling**: Deployments are currently informational in the export. Should import be able to create deployments, or should they always require the deploy flow?

5. **v2 alignment**: The `StagedImporter` in `staged-importer.ts` already has a layered phase model. Should the v1 fix use `StagedImporter` directly, or should we keep the simpler sequential approach for v1 and migrate to staged import in v2?
