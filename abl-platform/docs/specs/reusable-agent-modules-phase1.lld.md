# Reusable Agent Modules — Phase 1 Low-Level Design

**Status:** IMPLEMENTED (Sprints 1-5 complete)
**Date:** 2026-03-21 (approved) / 2026-03-22 (implementation complete)
**Feeds from:** HLD (`reusable-agent-modules-phase-plan.hld.md`), LLD Decision Register (`reusable-agent-modules-phase1-lld-decisions.md`)
**Review status:** See `docs/reviews/reusable-agent-modules-unified-review.md`

This document is the implementable specification for Phase 1 of Reusable Agent Modules. Every section maps to an approved decision from the LLD Decision Register and resolves all findings from the architecture review.

---

## Table of Contents

1. [Data Model](#1-data-model)
2. [Cascade Delete](#2-cascade-delete)
3. [Module Release Builder](#3-module-release-builder)
4. [Alias Rewriter](#4-alias-rewriter)
5. [Deployment Build Service](#5-deployment-build-service)
6. [Runtime Merge and Provenance](#6-runtime-merge-and-provenance)
7. [Studio API Routes](#7-studio-api-routes)
8. [Studio UX and State Management](#8-studio-ux-and-state-management)
9. [Rollout and Feature Gating](#9-rollout-and-feature-gating)
10. [Concurrency Control](#10-concurrency-control)
11. [Security](#11-security)
12. [E2E Test Bootstrap Architecture](#12-e2e-test-bootstrap-architecture)
13. [Implementation Order](#13-implementation-order)
14. [Cross-Reference: Review Finding Resolution](#14-cross-reference-review-finding-resolution)

---

## 1. Data Model

**Decisions:** 1a (separate collection), 1b (archived badge + filter), 1c (denormalized contractSnapshot), 1d (eager cascade)

### 1.1 Project Model Extension

**File:** `packages/database/src/models/project.model.ts`

Add to `IProject` interface:

```ts
kind: 'application' | 'module';
moduleVisibility?: 'private' | 'tenant';
moduleDependencyVersion?: number;
archivedAt?: Date | null;
archivedBy?: string | null;
```

Schema changes:

```ts
kind: {
  type: String,
  enum: ['application', 'module'],
  default: 'application',
  required: true,
},
moduleVisibility: {
  type: String,
  enum: ['private', 'tenant'],
  default: 'private',
},
moduleDependencyVersion: {
  type: Number,
  default: 0,
},
archivedAt: {
  type: Date,
  default: null,
},
archivedBy: {
  type: String,
  default: null,
},
```

**Note:** `archivedAt` and `archivedBy` must be added to the Mongoose schema so that soft-delete updates via `findOneAndUpdate` are not silently dropped by Mongoose `strict: true` mode.

**Migration strategy (resolves HIGH-1, LOW-1):**

- Schema-level `default: 'application'`. No backfill migration script.
- All queries that filter by `kind` must handle null/undefined as `'application'`:
  ```ts
  // For listing application projects:
  {
    $or: [{ kind: 'application' }, { kind: { $exists: false } }];
  }
  // Or equivalently:
  {
    kind: {
      $in: ['application', null, undefined];
    }
  }
  ```
- Use Mongoose `enum` validation to prevent arbitrary values.
- A project with `tenantId: null` cannot be converted to `kind: 'module'` (resolves MEDIUM-1 from arch review).

### 1.2 ModuleRelease Model

**File:** `packages/database/src/models/module-release.model.ts` (new)

```ts
interface IModuleRelease {
  _id: string;
  tenantId: string; // required, non-nullable
  moduleProjectId: string;
  version: string;
  releaseNotes: string | null;
  artifact: ModuleReleaseArtifact;
  compiledIR: Record<string, AgentIR>; // pre-compiled IR, keyed by agent name
  contract: ModuleReleaseContract;
  sourceHash: string;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
}
```

Indexes:

```ts
{ tenantId: 1, moduleProjectId: 1, version: 1 } // unique
{ tenantId: 1, moduleProjectId: 1, createdAt: -1 } // listing
```

**Artifact shape:**

```ts
type ModuleReleaseArtifact = {
  dslFormat: 'legacy' | 'yaml';
  entryAgentName: string;
  agents: Record<string, { dslContent: string; sourceHash: string }>;
  tools: Record<
    string,
    {
      dslContent: string;
      toolType: 'http' | 'mcp' | 'sandbox' | 'searchai';
      sourceHash: string;
    }
  >;
};
```

**Contract shape (reuses ProjectManifestV2 prerequisite shapes — resolves MEDIUM-6 from arch review):**

```ts
type ModuleReleaseContract = {
  providedAgents: Array<{ name: string; description?: string }>;
  providedTools: Array<{ name: string; toolType: string }>;
  requiredConfigKeys: Array<{ key: string; description?: string; isSecret: boolean }>;
  requiredEnvVars: Array<{ name: string; description?: string }>;
  requiredAuthProfiles: Array<{
    name: string;
    authType?: string;
    scope?: string;
    referencedBy: string[];
  }>; // reuses ProjectManifestV2.required_auth_profiles shape
  requiredConnectors: Array<{ name: string; connectorType?: string }>;
  requiredMcpServers: Array<{ name: string }>;
  warnings: Array<{ code: string; message: string }>;
};
```

**sourceHash computation (Decision 2c):**

```ts
import { createHash } from 'crypto';

function computeSourceHash(
  entryAgentName: string,
  agents: Record<string, string>, // name → dslContent
  tools: Record<string, string>, // name → dslContent
): string {
  // Deep-sort all object keys for deterministic serialization
  const canonical = JSON.stringify({ entryAgentName, agents, tools }, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort())
      : v,
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
```

Includes `entryAgentName` because it affects runtime behavior (user decision override on 2c).

### 1.3 ModuleEnvironmentPointer Model

**File:** `packages/database/src/models/module-environment-pointer.model.ts` (new)

```ts
interface IModuleEnvironmentPointer {
  _id: string;
  tenantId: string;
  moduleProjectId: string;
  environment: 'dev' | 'staging' | 'production';
  moduleReleaseId: string;
  revision: number; // optimistic concurrency — Decision 9c
  updatedBy: string;
  updatedAt: Date;
}
```

Indexes:

```ts
{ tenantId: 1, moduleProjectId: 1, environment: 1 } // unique
```

### 1.4 ProjectModuleDependency Model

**File:** `packages/database/src/models/project-module-dependency.model.ts` (new)

```ts
interface IProjectModuleDependency {
  _id: string;
  tenantId: string;
  projectId: string;
  moduleProjectId: string;
  alias: string;
  selector: { type: 'version' | 'environment'; value: string };
  resolvedReleaseId: string;
  configOverrides: Record<string, string>;
  contractSnapshot: ModuleReleaseContract; // denormalized — Decision 1c
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes:

```ts
{ tenantId: 1, projectId: 1, alias: 1 } // unique
{ tenantId: 1, moduleProjectId: 1 }      // reverse dependency lookup
```

**configOverrides constraints (Decision HIGH-10):**

- Shape: `Record<string, string>`
- Maximum 50 keys
- Maximum 1 KB per value (1024 bytes UTF-8)
- Keys must be validated against the module contract's declared non-secret config slots
- Values matching declared secret prerequisites (where `isSecret: true`) must be rejected
- Validation happens at import save time and deployment build time

### 1.5 DeploymentModuleSnapshot Model

**File:** `packages/database/src/models/deployment-module-snapshot.model.ts` (new)

```ts
interface IDeploymentModuleSnapshot {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string;
  snapshotHash: string;
  compressedPayload: Buffer; // gzip-compressed JSON
  createdBy: string;
  createdAt: Date;
}
```

The `compressedPayload` stores gzip-compressed JSON of the `DeploymentModuleSnapshotPayload` type defined in the HLD. This avoids embedding large `AgentIR` objects as raw BSON fields.

Indexes:

```ts
{ tenantId: 1, deploymentId: 1 }  // unique — resolves HIGH-2
{ tenantId: 1, projectId: 1 }     // consumer project listing
```

**Size enforcement:**

- Before compression: validate `JSON.stringify(payload).length <= 8_388_608` (8 MB)
- If exceeded: reject with 422 and message indicating which modules contribute the most bytes
- After validation: `zlib.gzip(jsonPayload)` before persistence
- On read: `zlib.gunzip(compressedPayload)` then `JSON.parse`

### 1.6 Model Registration

**File:** `packages/database/src/models/index.ts`

Add exports for all four new models.

---

## 2. Cascade Delete

**Decision:** 1d (eager cascade), resolves CRIT-1

**File:** `packages/database/src/cascade/cascade-delete.ts`

**Signature change:** The existing `deleteProject(projectId: string)` must be extended to `deleteProject(projectId: string, tenantId?: string)`. When `tenantId` is not provided, resolve it from the Project document. The 4 new model imports (`ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, `DeploymentModuleSnapshot`) must be added to the file. Similarly, `deleteTenant(tenantId: string)` must add the 4 new model cascade steps.

### 2.1 Two-Path Cascade Logic

The cascade must handle two distinct project types differently:

#### Path A: Deleting a Module Project

Order matters — delete dependents before the entity they depend on.

**Important:** `DeploymentModuleSnapshot` has no `moduleProjectId` field (it stores module references inside `compressedPayload`). Module project deletion must NOT delete consumer deployment snapshots — those snapshots serve the consumer project and may contain mounts from multiple modules.

```
1. Block if active consumer dependencies exist:
   ProjectModuleDependency.countDocuments({ tenantId, moduleProjectId }) > 0
   → return 409 with list of consumer project IDs

2. If zero consumer deps (safe to delete):
   a. ModuleEnvironmentPointer.deleteMany({ tenantId, moduleProjectId })
   b. ModuleRelease.deleteMany({ tenantId, moduleProjectId })
   c. Continue with existing Project deletion cascade
   Note: Consumer DeploymentModuleSnapshots are NOT deleted here.
   They belong to consumer projects and are cleaned up via Path B
   when the consumer project is deleted.

3. If force-archive (soft-delete when consumers exist):
   → Use the soft-delete path in Section 2.2 instead.
   Consumer snapshots remain valid and resolvable.
```

#### Path B: Deleting a Consumer Project

```
1. ProjectModuleDependency.deleteMany({ tenantId, projectId })
2. DeploymentModuleSnapshot.deleteMany({ tenantId, projectId })
3. Continue with existing Deployment deletion cascade
   (existing: DeploymentVariableSnapshot → Deployment → ...)
```

#### Tenant Deletion

`deleteTenant()` must cascade through module entities in order:

```
1. DeploymentModuleSnapshot.deleteMany({ tenantId })
2. ProjectModuleDependency.deleteMany({ tenantId })
3. ModuleEnvironmentPointer.deleteMany({ tenantId })
4. ModuleRelease.deleteMany({ tenantId })
5. Continue with existing tenant cascade
```

### 2.2 Soft-Delete / Archive Path

When a module project is being deleted but has active consumers:

```ts
// Instead of hard delete:
await Project.findOneAndUpdate(
  { _id: moduleProjectId, tenantId },
  { $set: { archivedAt: new Date(), archivedBy: userId } },
);
await ModuleRelease.updateMany(
  { tenantId, moduleProjectId },
  { $set: { archivedAt: new Date(), archivedBy: userId } },
);
```

Archived releases remain resolvable for existing deployment snapshots (P1-R27) but cannot be used for new imports. The catalog query filters out archived module projects unless `includeArchived: true` is passed.

---

## 3. Module Release Builder

**Decisions:** 2a (compile at publish), 2b (two-tier errors/warnings), 2c (sourceHash with entryAgentName)

### 3.1 Build Pipeline

**File:** `packages/project-io/src/module-release/build-module-release.ts` (new)

```
Input: moduleProject, agents[], tools[], compiler
Output: { artifact, compiledIR, contract, sourceHash } | { errors, warnings }

Steps:
1. Validate at least one agent exists → blocking error if zero
2. Validate entryAgentName is set and non-null → blocking error if null (resolves LOW-2)
3. For each agent:
   a. Compile DSL → IR using existing compiler pipeline
   b. If compilation fails → blocking error with agent name and diagnostics
   c. Strip variableNamespaceIds from tool references in compiled IR
   d. Store dslContent and per-agent sourceHash in artifact
4. For each tool:
   a. Store dslContent, toolType, and per-tool sourceHash in artifact
   b. Strip variableNamespaceIds from tool metadata
5. Run publish safety validation (Section 11.1)
6. Extract contract using module-contract.ts
7. Compute sourceHash (Section 1.2)
8. If AgentModelConfig records exist for the module project → emit warning:
   "Model configuration is not included in the release artifact.
    Consumers must configure models independently."
   (resolves LOW-3 from arch review)
9. Return { artifact, compiledIR, contract, sourceHash, warnings }
```

### 3.2 Contract Extraction

**File:** `packages/project-io/src/module-release/module-contract.ts` (new)

Reuses existing `auth-requirement-collector.ts` for auth profile extraction and `manifest-generator.ts` patterns for prerequisite scanning. The contract reuses `ProjectManifestV2.required_auth_profiles` shape (resolves MEDIUM-6 from arch review).

### 3.3 Module Selector

**File:** `packages/project-io/src/module-release/module-selector.ts` (new)

```ts
async function resolveSelector(
  tenantId: string,
  moduleProjectId: string,
  selector: { type: 'version' | 'environment'; value: string },
): Promise<{ releaseId: string; version: string } | { error: string }> {
  if (selector.type === 'version') {
    const release = await ModuleRelease.findOne({
      tenantId,
      moduleProjectId,
      version: selector.value,
      archivedAt: null,
    });
    if (!release) return { error: `Version ${selector.value} not found or archived` };
    return { releaseId: release._id, version: release.version };
  }

  if (selector.type === 'environment') {
    const pointer = await ModuleEnvironmentPointer.findOne({
      tenantId,
      moduleProjectId,
      environment: selector.value,
    });
    if (!pointer) {
      return {
        error: `No release promoted to '${selector.value}' environment. Promote a release first.`,
      };
      // resolves P1-U21
    }
    const release = await ModuleRelease.findOne({
      _id: pointer.moduleReleaseId,
      tenantId,
      archivedAt: null,
    });
    if (!release) return { error: `Promoted release has been archived` };
    return { releaseId: release._id, version: release.version };
  }

  return { error: `Unknown selector type: ${selector.type}` };
}
```

---

## 4. Alias Rewriter

**Decisions:** 3a (validation pattern), 3b (rewrite ALL references), 3c (operate on IR)

### 4.1 Alias Validation

**Pattern:** `^[a-z][a-z0-9_]{1,24}$`

Rules:

- Lowercase alphanumeric + underscore only
- 2-25 characters total
- Must start with a letter
- Must not contain `__` (double underscore — reserved as separator)
- Must not start with `_`
- Must not collide with any existing local agent or tool name in the consumer project

Reject with 422 and actionable message on validation failure. Specifically reject these reserved prefixes: `system_`, `internal_`, `test_` (reserved for platform use).

### 4.2 IR Tree Walk

**File:** `apps/runtime/src/services/modules/module-alias-rewriter.ts` (new)

The rewriter takes a set of module agents/tools and an alias, and rewrites all symbol references to use the `<alias>__<symbol>` pattern.

**Exhaustive IR fields to rewrite (resolves HIGH-4):**

Derived from the actual IR schema at `packages/compiler/src/platform/ir/schema.ts`:

```ts
// Agent name references (string fields that contain agent names)
const AGENT_NAME_FIELDS = [
  // Agent metadata (must be rewritten FIRST so self-reported name matches key)
  'metadata.name', // AgentMetadata.name — agent's own identity

  // Coordination (CoordinationConfig)
  'coordination.handoffs[].to', // HandoffConfig.to — handoff target agent
  'coordination.delegates[].agent', // DelegateConfig.agent — delegate target agent

  // Routing (RoutingConfig — supervisor agents)
  'routing.rules[].to', // RoutingRule.to — routing target agent
  'routing.default_agent', // RoutingConfig.default_agent — fallback agent

  // Top-level available agents list
  'available_agents[]', // AgentIR.available_agents — populated from handoff targets

  // Lifecycle
  'on_start.delegate', // StartConfig.delegate — agent to delegate to on start

  // Flow (FlowStep fields — `then`/`on_fail` can reference step names OR agent names;
  // step names won't be in renameMap and are safely skipped by the rewriter)
  'flow.definitions[*].then', // FlowStep.then — next step/agent transition
  'flow.definitions[*].on_fail', // FlowStep.on_fail — failure step reference
  'flow.definitions[*].on_success.then', // CallResultBlock.then — success transition
  'flow.definitions[*].on_failure.then', // CallResultBlock.then — failure transition
  'flow.definitions[*].on_success.branches[].then', // CallResultBranch.then
  'flow.definitions[*].on_failure.branches[].then', // CallResultBranch.then
  'flow.definitions[*].on_input[].then', // InputBranch.then — branch transitions
  'flow.definitions[*].on_result[].then', // InputBranch.then — result branch transitions
  'flow.definitions[*].digressions[].delegate', // Digression.delegate — digress to agent
  'flow.global_digressions[].delegate', // Global Digression.delegate

  // Constraints (top-level and behavior-profile-nested)
  'constraints.constraints[].on_fail.target', // ConstraintAction.target (when type='handoff')
  'behavior_profiles[].constraints[].on_fail.target', // BehaviorProfile nested constraints

  // Error handling (agent-level)
  'error_handling.handlers[].handoff_target', // ErrorHandler.handoff_target
  'error_handling.default_handler.handoff_target',

  // Error handling (step-level)
  'flow.definitions[*].on_error[].handoff_target', // Step ErrorHandler.handoff_target

  // Human approval (these are step transition targets — typically step names,
  // but included here because the rewriter safely skips non-module names via renameMap lookup)
  'flow.definitions[*].human_approval.onApprove', // Step transitions
  'flow.definitions[*].human_approval.onReject',
  'flow.definitions[*].human_approval.onTimeout',
];

// Tool name references (string fields that contain tool names)
const TOOL_NAME_FIELDS = [
  // Agent tools list
  'tools[].name', // ToolDefinition.name — tool definitions on agent

  // Lifecycle
  'on_start.call', // StartConfig.call — tool to call on start

  // Flow
  'flow.definitions[*].call', // FlowStep.call — tool call in step
  'flow.definitions[*].digressions[].call', // Digression.call — tool call in digression
  'flow.definitions[*].on_input[].call', // InputBranch.call — tool call in branch
  'flow.definitions[*].on_result[].call', // InputBranch.call — result branch tool call
  'flow.definitions[*].on_success.branches[].call', // CallResultBranch.call
  'flow.definitions[*].on_failure.branches[].call', // CallResultBranch.call
  'flow.definitions[*].sub_intents[].call', // SubIntent.call — sub-intent tool call
  'flow.global_digressions[].call', // Global Digression.call

  // Hooks
  'hooks.before_agent.call', // HookAction.call
  'hooks.after_agent.call',
  'hooks.before_turn.call',
  'hooks.after_turn.call',

  // Behavior profiles
  'behavior_profiles[].tools_hide[]', // Tool names to remove from base set
  'behavior_profiles[].tools_add[].name', // Tool names to add to base set

  // Reasoning zone
  'flow.definitions[*].reasoning_zone.available_tools[]', // ReasoningZoneIR.available_tools

  // Constraints (checkpoint target is a tool name for BEFORE-lowered constraints)
  'constraints.constraints[].checkpoint.target', // ConstraintCheckpoint.target — tool call gate
  'behavior_profiles[].constraints[].checkpoint.target', // BehaviorProfile nested constraints

  // Static graph (visualization — not executed, but keeps Studio graph rendering correct)
  'flow.staticGraph.nodes[].step.call', // StaticGraphNode tool reference

  // Tool definitions (standalone)
  'ToolDefinition.name', // Mounted tool name rewriting
];
```

**Note:** The `when` condition strings in `HandoffConfig`, `DelegateConfig`, `RoutingRule`, `Digression`, and `Constraint` are CEL expressions evaluated against session values — they do NOT contain agent/tool name references that need rewriting. The rewriter only rewrites fields that contain literal agent or tool name identifiers.

**Implementation guidance:** Rather than enumerating every path as flat strings, implement `deepRewriteIR` as a recursive walker with shared helpers like `rewriteFlowStep(step, renameMap)` and `rewriteConstraint(constraint, renameMap)`. These helpers are called from both top-level fields and nested contexts (e.g., `behavior_profiles[].flow_modifications.insertions[].step`). This naturally covers any future schema additions without requiring explicit path enumeration updates.

````

**Algorithm:**

```ts
function rewriteModuleIR(
  agents: Record<string, AgentIR>,
  tools: Record<string, ToolDefinitionLocal>,
  alias: string,
  moduleSymbolNames: Set<string>, // all agent + tool names in this module
): { mountedAgents: Record<string, AgentIR>; mountedTools: Record<string, ToolDefinitionLocal> } {
  const prefix = `${alias}__`;
  const mountedAgents: Record<string, AgentIR> = {};
  const mountedTools: Record<string, ToolDefinitionLocal> = {};

  // Build rename map: oldName → newName for all symbols in this module
  const renameMap = new Map<string, string>();
  for (const name of moduleSymbolNames) {
    renameMap.set(name, `${prefix}${name}`);
  }

  // Rewrite each agent's IR
  for (const [agentName, ir] of Object.entries(agents)) {
    const mountedName = renameMap.get(agentName) ?? `${prefix}${agentName}`;
    mountedAgents[mountedName] = deepRewriteIR(structuredClone(ir), renameMap);
  }

  // Rewrite each tool
  for (const [toolName, def] of Object.entries(tools)) {
    const mountedName = renameMap.get(toolName) ?? `${prefix}${toolName}`;
    mountedTools[mountedName] = { ...def, name: mountedName };
  }

  return { mountedAgents, mountedTools };
}

function deepRewriteIR(ir: AgentIR, renameMap: Map<string, string>): AgentIR {
  // First: rewrite metadata.name so the agent's self-reported identity matches its mounted key
  if (ir.metadata?.name && renameMap.has(ir.metadata.name)) {
    ir.metadata.name = renameMap.get(ir.metadata.name)!;
  }

  // Then: walk every field listed in AGENT_NAME_FIELDS and TOOL_NAME_FIELDS
  // For each string value, check if renameMap.has(value) and replace
  // This is a uniform rewrite — both internal and cross-boundary references
  // are rewritten (Decision 3b)
  // Step names (used in then/on_fail/onApprove/onReject/onTimeout) are safely
  // skipped because they won't exist in the module's renameMap
  // ...
}
````

Internal module references (agent→tool within the same module) are rewritten uniformly. This prevents accidental binding to the consumer's local namespace (Decision 3b).

### 4.3 Collision Detection

At import time, after alias rewriting produces mounted names, validate:

```ts
for (const mountedName of allMountedNames) {
  if (localAgentNames.has(mountedName) || localToolNames.has(mountedName)) {
    errors.push(`Mounted name '${mountedName}' collides with local ${type} '${mountedName}'`);
  }
  if (existingMountedNames.has(mountedName)) {
    errors.push(
      `Mounted name '${mountedName}' collides with already-imported symbol from alias '${existingAlias}'`,
    );
  }
}
```

---

## 5. Deployment Build Service

**Decisions:** 4a (no caching Phase 1), 4b (structured diagnostics), 4c (standalone service)

### 5.1 Service Architecture

**File:** `apps/runtime/src/services/deployments/deployment-build-service.ts` (new)

This service orchestrates the combined build flow when a consumer project has module dependencies. It delegates to `version-service.ts` for individual agent compilation.

```
Input: projectId, tenantId, environment, userId
Output: { deployment, moduleSnapshot? } | { errors }

Flow:
1. Load consumer project with dependencyVersion
2. Check project has module dependencies
   → If no dependencies: delegate entirely to existing deployment flow (zero overhead)
3. Acquire Redis lock: module:deploy:{tenantId}:{projectId} (Section 10)
4. Load all ProjectModuleDependency records for the project
5. Validate dependency count ≤ 5
6. For each dependency:
   a. Load ModuleRelease by resolvedReleaseId
   b. Validate release exists and is not archived for new deployments
   c. Load artifact and compiledIR from release
7. For each module:
   a. Apply configOverrides to module config slots
   b. Run alias rewriter on compiled IR (Section 4)
   c. If configOverrides change IR-affecting values, re-compile from DSL
8. Merge local agents + all mounted agents
9. Validate total mounted symbol count ≤ 250
10. Build DeploymentModuleSnapshotPayload
11. Validate payload size < 8 MB uncompressed
12. Compress payload with gzip
13. Verify dependencyVersion has not changed since step 1
    → If changed: release lock, return 409 "Dependencies changed during build"
14. Persist DeploymentModuleSnapshot
15. Persist Deployment record (with module-aware hash)
16. Release Redis lock
17. Return { deployment, moduleSnapshot }
```

**Error handling (Decision 4b):**

```ts
type ModuleBuildDiagnostic = {
  alias: string;
  moduleProjectId: string;
  agentName?: string; // mounted name with alias prefix
  severity: 'error' | 'warning';
  code: string;
  message: string;
};

// Truncate to first 10 errors to prevent response bloat
const diagnostics = allDiagnostics.slice(0, 10);
```

### 5.2 Non-Module Fast Path

When `ProjectModuleDependency.countDocuments({ tenantId, projectId }) === 0`, the deployment build service immediately delegates to the existing flow. No Redis lock is acquired. No module-related queries are executed. This ensures zero performance impact for the vast majority of projects (resolves arch review watch item 7).

### 5.3 Module-Aware Deployment Hash

The existing deployment hash must change when module releases or consumer config bindings change:

```ts
// Sort dependencies by alias for deterministic ordering
const sortedDeps = [...dependencies].sort((a, b) => a.alias.localeCompare(b.alias));
const deploymentHash = createHash('sha256')
  .update(localAgentVersionHash) // existing
  .update(
    JSON.stringify(
      sortedDeps.map((d) => ({
        alias: d.alias,
        releaseId: d.resolvedReleaseId,
        // Sort config keys for deterministic hashing
        configHash: createHash('sha256')
          .update(JSON.stringify(Object.fromEntries(Object.entries(d.configOverrides).sort())))
          .digest('hex'),
      })),
    ),
  )
  .digest('hex')
  .slice(0, 16);
```

---

## 6. Runtime Merge and Provenance

**Decisions:** 5a (top-level moduleProvenance), 5b (trace auth scope), 5c (eager load)

### 6.1 Deployment Resolver Extension

**File:** `apps/runtime/src/services/deployment-resolver.ts`

At session bootstrap, after resolving the deployment record:

```ts
// After existing agent resolution (lines 147-215):
const moduleSnapshot = await DeploymentModuleSnapshot.findOne({
  tenantId,
  deploymentId: deployment._id,
});

if (moduleSnapshot) {
  const payload = JSON.parse(
    zlib.gunzipSync(moduleSnapshot.compressedPayload).toString(),
  ) as DeploymentModuleSnapshotPayload;

  // Merge mounted agents into resolved agent set
  for (const [mountedName, agent] of Object.entries(payload.mountedAgents)) {
    resolvedAgents[mountedName] = {
      ...agent.ir,
      _moduleProvenance: {
        alias: agent.alias,
        moduleProjectId: agent.moduleProjectId,
        moduleReleaseId: agent.moduleReleaseId,
        sourceAgentName: agent.sourceAgentName,
      },
    };
  }

  // Merge mounted tools into resolved tool set
  for (const [mountedName, tool] of Object.entries(payload.mountedTools)) {
    resolvedTools[mountedName] = {
      ...tool.definition,
      _moduleProvenance: {
        alias: tool.alias,
        moduleProjectId: tool.moduleProjectId,
        moduleReleaseId: tool.moduleReleaseId,
        sourceToolName: tool.sourceToolName,
      },
    };
  }
}
```

Loading is eager at session bootstrap (Decision 5c), consistent with how `agentVersionManifest` is resolved.

**Type declaration for provenance-extended IR:**

**File:** `apps/runtime/src/services/modules/types.ts` (new)

```ts
interface ModuleProvenance {
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  sourceAgentName: string;
}

/** AgentIR extended with optional module provenance metadata */
type ResolvedAgentIR = AgentIR & { _moduleProvenance?: ModuleProvenance };

/** ToolDefinition extended with optional module provenance metadata */
type ResolvedToolDefinition = ToolDefinitionLocal & {
  _moduleProvenance?: Omit<ModuleProvenance, 'sourceAgentName'> & { sourceToolName: string };
};
```

All runtime code that accesses `_moduleProvenance` should use `ResolvedAgentIR` / `ResolvedToolDefinition` instead of raw `AgentIR` with type assertions.

### 6.2 Session State Provenance

**File:** `apps/runtime/src/services/session/types.ts`

Add to `SessionData`:

```ts
moduleProvenance?: Record<string, {
  alias: string;
  moduleProjectId: string;
  moduleReleaseId: string;
  sourceAgentName: string;
}>;
```

This top-level map is keyed by mounted agent name (Decision 5a). It is set once at session bootstrap and persisted to Redis. Rehydrated sessions on other pods restore the full provenance from the serialized session state (P1-R21).

### 6.3 Trace Event Enrichment

**File:** `apps/runtime/src/services/trace-store.ts`

When emitting trace events for an agent that has `_moduleProvenance`:

```ts
if (agent._moduleProvenance) {
  traceEvent.moduleAlias = agent._moduleProvenance.alias;
  traceEvent.moduleProjectId = agent._moduleProvenance.moduleProjectId;
  traceEvent.moduleReleaseId = agent._moduleProvenance.moduleReleaseId;
  traceEvent.sourceAgentName = agent._moduleProvenance.sourceAgentName;
}
```

Local agents produce traces with no module fields — backward compatible (P1-R10).

### 6.4 Auth Profile Resolution for Imported Tools

**File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`

**Critical rule:** When resolving auth profiles for imported module tools, the **consumer project's `projectId`** must be used as the resolution scope — NOT the module's source `moduleProjectId`. The module provenance is informational only; auth resolution always happens in the consumer's project context.

```ts
// Correct: use consumer projectId for auth resolution
const profile = await resolveAuthProfile(
  consumerProjectId, // consumer project — NOT module source project
  tenantId,
  tool.authProfileRef,
);
```

**Scope tracing (Decision 5b):**

When resolving auth for an imported tool, emit a trace event with the resolution scope:

```ts
traceStore.emit({
  type: 'tool_auth_resolved', // use existing TraceEventType or add to the enum
  agentName: currentAgent,
  toolName: tool.name,
  profileName: resolvedProfile.name,
  scope: resolvedProfile.projectId ? 'project' : 'tenant',
  moduleAlias: tool._moduleProvenance?.alias,
});
```

**Note:** The trace event type must be added to the `TraceEventType` enum in `packages/shared-kernel/src/types/trace-event.ts` before use. Using an unregistered type would cause downstream trace consumers to silently drop the event.

This provides observability for HIGH-6 (silent tenant-scoped profile binding) without changing resolution behavior.

---

## 7. Studio API Routes

**Decisions:** 6a (summary + detail), 6b (two-step preview/confirm), 6c (under /api/projects/[id]/)

### 7.1 Route Registration

All module routes are project-scoped and use `withRouteHandler({ requireProject: true })`:

| Method | Path                                                     | Permission       | Handler                                      |
| ------ | -------------------------------------------------------- | ---------------- | -------------------------------------------- |
| POST   | `/api/projects/[id]/module`                              | `module:manage`  | Enable/disable module, set visibility        |
| GET    | `/api/projects/[id]/module/releases`                     | `module:read`    | List releases for module project             |
| POST   | `/api/projects/[id]/module/releases`                     | `module:publish` | Publish new release                          |
| POST   | `/api/projects/[id]/module/releases/[releaseId]/promote` | `module:publish` | Move environment pointer                     |
| GET    | `/api/projects/[id]/module-catalog`                      | `module:read`    | Browse visible modules from consumer context |
| GET    | `/api/projects/[id]/module-catalog/[moduleProjectId]`    | `module:read`    | Module detail with full contract             |
| POST   | `/api/projects/[id]/module-dependencies/preview`         | `module:import`  | Dry-run import validation                    |
| GET    | `/api/projects/[id]/module-dependencies`                 | `module:read`    | List current dependencies                    |
| POST   | `/api/projects/[id]/module-dependencies`                 | `module:import`  | Confirm import (persist dependency)          |
| DELETE | `/api/projects/[id]/module-dependencies/[dependencyId]`  | `module:import`  | Remove dependency (with reference check)     |

### 7.2 Permissions

**File:** `apps/studio/src/lib/permissions.ts`

```ts
// Add to StudioPermission:
MODULE_READ: 'module:read',
MODULE_MANAGE: 'module:manage',
MODULE_PUBLISH: 'module:publish',
MODULE_IMPORT: 'module:import',
```

**Role mappings (resolves CRIT-2):**

| Role   | module:read | module:manage | module:publish | module:import |
| ------ | ----------- | ------------- | -------------- | ------------- |
| OWNER  | yes         | yes           | yes            | yes           |
| EDITOR | yes         | no            | no             | yes           |
| VIEWER | yes         | no            | no             | no            |

`module:import` is distinct from `project:import`. `project:import` covers project-io file imports. `module:import` covers module dependency imports.

### 7.3 Catalog Route

**GET `/api/projects/[id]/module-catalog`**

Returns summary-only listings (Decision 6a):

```ts
// Query: modules visible from this consumer project's tenant
const modules = await Project.find({
  tenantId: consumerProject.tenantId,
  kind: 'module',
  archivedAt: null,
  $or: [
    { moduleVisibility: 'tenant' },
    // Private: visible to module project members
    { _id: { $in: memberProjectIds } },
  ],
}).select('_id name slug description entryAgentName moduleVisibility');

// Enrich with release metadata
const result = modules.map(async (mod) => {
  const latestRelease = await ModuleRelease.findOne(
    { tenantId, moduleProjectId: mod._id, archivedAt: null },
    { version: 1, createdAt: 1 },
    { sort: { createdAt: -1 } },
  );
  const pointers = await ModuleEnvironmentPointer.find({
    tenantId,
    moduleProjectId: mod._id,
  });
  return {
    moduleProjectId: mod._id,
    name: mod.name,
    slug: mod.slug,
    description: mod.description,
    latestVersion: latestRelease?.version,
    pointers: pointers.map((p) => ({
      environment: p.environment,
      version: /* resolve from release */,
    })),
    providedAgentCount: /* from latest release contract */,
    providedToolCount: /* from latest release contract */,
  };
});
```

**GET `/api/projects/[id]/module-catalog/[moduleProjectId]`**

Returns full contract for the selected module (used when user clicks to import).

### 7.4 Two-Step Import Flow

**POST `/api/projects/[id]/module-dependencies/preview`**

```ts
// Request body:
{ moduleProjectId, selector, alias, configOverrides? }

// Response:
{
  success: true,
  data: {
    resolvedReleaseId: string,
    resolvedVersion: string,
    mountedSymbols: { agents: string[], tools: string[] },
    prerequisites: {
      blocking: Array<{ type, name, message }>,
      warnings: Array<{ type, name, message }>,
    },
    collisions: Array<{ mountedName, conflictsWith }>,
  }
}
```

The preview captures `resolvedReleaseId` at this point (resolves MED-9 — pointer drift).

**POST `/api/projects/[id]/module-dependencies`**

```ts
// Request body:
{ moduleProjectId, alias, selector, resolvedReleaseId, configOverrides? }

// The resolvedReleaseId from preview is pinned here
// If resolvedReleaseId no longer matches current pointer, warn but proceed
// (the user explicitly chose this version in the preview step)
```

### 7.5 Publish Route

**POST `/api/projects/[id]/module/releases`**

```ts
// Request body:
{ version: string, releaseNotes?: string, promoteToEnvironment?: string }

// Flow:
1. Validate project.kind === 'module'
2. Validate version follows semver pattern
3. Call build-module-release.ts (Section 3.1)
4. If blocking errors → return 422 with errors and warnings
5. Attempt Model.create (not check-then-write — resolves HIGH-8)
6. Catch MongoServerError code 11000 → return 409 "Version already exists"
7. If promoteToEnvironment specified → update pointer
8. Emit audit event: module_published
9. Return { success: true, data: { releaseId, version, contract, warnings } }
```

### 7.6 Audit Events

**File:** `apps/studio/src/services/audit-service.ts`

Add to `AuditActions` (resolves MEDIUM-4 from arch review):

```ts
MODULE_ENABLED: 'module_enabled',
MODULE_DISABLED: 'module_disabled',
MODULE_PUBLISHED: 'module_published',
MODULE_PROMOTED: 'module_promoted',
MODULE_IMPORTED: 'module_imported',
MODULE_REMOVED: 'module_removed',
MODULE_RELEASE_ARCHIVED: 'module_release_archived',
MODULE_DELETE_BLOCKED: 'module_delete_blocked',
```

All audit events must be sanitized — no secret values, no full artifact content.

---

## 8. Studio UX and State Management

**Decisions:** 7a (extend project-store + dedicated module-store), 7b (decorations + completions), 7c (single-page form), 7d (modules key in studio.json)

### 8.1 Project Store Extension

**File:** `apps/studio/src/store/project-store.ts`

Add ~15 lines:

```ts
interface Project {
  // ... existing fields
  kind: 'application' | 'module';
  moduleVisibility?: 'private' | 'tenant';
}

interface ProjectState {
  // ... existing state
  moduleFilter: 'all' | 'application' | 'module';
  setModuleFilter: (filter: 'all' | 'application' | 'module') => void;
  selectModuleProjects: () => Project[];
  selectApplicationProjects: () => Project[];
}
```

### 8.2 Module Store

**File:** `apps/studio/src/store/module-store.ts` (new)

Non-persisted store following `tool-store.ts` pattern:

```ts
interface ModuleState {
  // Catalog
  catalogModules: ModuleCatalogEntry[];
  catalogLoading: boolean;

  // Dependencies (for current consumer project)
  dependencies: ProjectModuleDependency[];
  dependenciesLoading: boolean;

  // Releases (for current module project)
  releases: ModuleRelease[];
  releasesLoading: boolean;
  pointers: ModuleEnvironmentPointer[];

  // Publish state
  publishDialogOpen: boolean;
  publishInProgress: boolean;

  // Import state
  importDialogOpen: boolean;
  importPreview: ImportPreviewResult | null;

  // Actions
  loadCatalog: (projectId: string) => Promise<void>;
  loadDependencies: (projectId: string) => Promise<void>;
  loadReleases: (moduleProjectId: string) => Promise<void>;
  publishRelease: (params: PublishParams) => Promise<void>;
  importModule: (params: ImportParams) => Promise<void>;
  removeDependency: (dependencyId: string) => Promise<void>;
}
```

### 8.3 API Client

**File:** `apps/studio/src/api/modules.ts` (new)

Centralizes all module API calls following the existing `api/projects.ts` pattern.

### 8.4 SWR Cache Invalidation

**Resolves MEDIUM-8 from arch review.**

| Mutation              | SWR keys to invalidate                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| Publish release       | `/api/projects/${moduleProjectId}/module/releases`, `/api/projects/*/module-catalog`    |
| Promote pointer       | `/api/projects/${moduleProjectId}/module/releases`, `/api/projects/*/module-catalog`    |
| Import dependency     | `/api/projects/${projectId}/module-dependencies`, `/api/projects/${projectId}/topology` |
| Remove dependency     | `/api/projects/${projectId}/module-dependencies`, `/api/projects/${projectId}/topology` |
| Enable/disable module | `/api/projects`, `/api/projects/*/module-catalog`                                       |

Pattern: After each mutation's `fetch()` succeeds, call `mutate(key)` for each affected SWR key. Use `useSWRConfig().mutate` for cross-component invalidation.

### 8.5 i18n

**File:** `packages/i18n/locales/en/studio.json`

Add `modules` key (Decision 7d):

```json
{
  "modules": {
    "settings": {
      "title": "Module Settings",
      "enableModule": "Enable as Reusable Module",
      "disableModule": "Convert Back to Application",
      "visibility": "Module Visibility",
      "visibilityPrivate": "Private — visible to project members only",
      "visibilityTenant": "Tenant — visible to all projects in tenant"
    },
    "publish": {
      "title": "Publish Module Release",
      "version": "Version",
      "releaseNotes": "Release Notes",
      "promoteTo": "Promote to Environment",
      "preview": "Release Preview",
      "exportedAgents": "Exported Agents",
      "exportedTools": "Exported Tools",
      "prerequisites": "Prerequisites",
      "warnings": "Warnings"
    },
    "import": {
      "title": "Import Module",
      "selectModule": "Select Module",
      "selectVersion": "Version or Environment",
      "alias": "Import Alias",
      "aliasHelp": "Lowercase letters, numbers, underscores. 2-25 characters.",
      "prerequisites": "Prerequisites",
      "configOverrides": "Configuration Overrides",
      "missingPrerequisites": "Missing Prerequisites",
      "preview": "Preview Import"
    },
    "catalog": {
      "title": "Module Catalog",
      "empty": "No modules available in this tenant",
      "search": "Search modules..."
    },
    "dependencies": {
      "title": "Module Dependencies",
      "empty": "No modules imported",
      "remove": "Remove Dependency",
      "removeWarning": "This will remove the imported agents and tools from this project."
    },
    "badges": {
      "module": "Module",
      "archived": "Archived",
      "imported": "Imported",
      "readOnly": "Read-only"
    },
    "errors": {
      "aliasConflict": "Alias '{{alias}}' is already in use in this project",
      "missingPrerequisite": "Missing {{type}}: {{name}}",
      "deleteBlocked": "Cannot delete — {{count}} consumer projects depend on this module",
      "kindDowngradeBlocked": "Cannot convert to application while consumer dependencies exist"
    }
  }
}
```

### 8.6 UI Components

#### ModuleSettingsPanel (Decision 7c note: settings, not publish)

**File:** `apps/studio/src/components/modules/ModuleSettingsPanel.tsx`

- Toggle: Application ↔ Module
- Visibility: Private / Tenant
- Disabled when feature flag is off
- Kind downgrade blocked when consumer deps exist (P1-R28)

#### PublishModuleDialog (Decision 7c: single-page form)

**File:** `apps/studio/src/components/modules/PublishModuleDialog.tsx`

Single-page dialog with:

- Version input (semver)
- Release notes textarea
- Target pointer dropdown (none / dev / staging / production)
- Collapsible "Release Preview" section: exported agents, tools, prerequisites, warnings
- Submit triggers publish + optional pointer promotion

#### ImportModuleDialog

**File:** `apps/studio/src/components/modules/ImportModuleDialog.tsx`

Two-step UI (mirrors two-step API):

- Step 1: Select module from catalog → select version/environment → enter alias → click "Preview"
- Step 2: Review mounted symbols, prerequisites, collisions → satisfy missing config → click "Import"

#### ModuleDependencyList

**File:** `apps/studio/src/components/modules/ModuleDependencyList.tsx`

List of imported dependencies with: alias, module name, pinned version, config overrides, remove button.

#### Imported Symbols in Authoring (Decision 7b)

- **ABLSymbolTree.tsx**: Add "Imported Modules" collapsible group with provenance badges and lock icon
- **ToolPickerDialog.tsx**: Include imported tools with `[imported]` badge and module alias prefix
- **CoordinationSection.tsx**: Include imported agents as handoff/delegate targets with provenance labels
- **ABLEditor.tsx**: Monaco completions for `<alias>__<symbol>` names

All imported symbols are marked read-only — clicking opens an info panel, not an editor.

---

## 9. Rollout and Feature Gating

**Decisions:** 8a (`reusable_modules`), 8b (fail closed), 8c (single flag, Studio reads via runtime)

### 9.1 Feature Flag

**Name:** `reusable_modules`

**File:** `apps/runtime/src/middleware/feature-gate.ts`

Add to `PLAN_FEATURES`:

```ts
PLAN_FEATURES: {
  // ... existing
  enterprise: [...existing, 'reusable_modules'],
  business: [...existing, 'reusable_modules'],
}
```

### 9.2 Fail-Closed Gate for Module Routes

**File:** `apps/runtime/src/middleware/feature-gate.ts`

The default feature gate fails open (`next()` on error). Module operations must fail closed:

```ts
function createModuleFeatureGate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hasFeature = await resolveFeature(req.tenantId, 'reusable_modules');
      if (!hasFeature) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FEATURE_DISABLED',
            message: 'Reusable modules is not enabled for this tenant',
          },
        });
      }
      next();
    } catch (err) {
      // Fail CLOSED for module operations (unlike default fail-open)
      log.error('Module feature gate check failed', {
        tenantId: req.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(503).json({
        success: false,
        error: { code: 'FEATURE_GATE_ERROR', message: 'Module feature availability check failed' },
      });
    }
  };
}
```

Apply this middleware to all module-related routes in both Studio and Runtime.

### 9.3 Studio Feature Resolution

Studio is a Next.js app and cannot use Express middleware directly. Resolution path:

```
Studio → GET /api/features → calls Runtime feature endpoint → caches per tenant for 60s → returns to component
```

**File:** `apps/studio/src/app/api/features/route.ts` (new)

```ts
export async function GET(req: NextRequest) {
  const tenantId = /* extract from session */;
  const features = await fetch(`${RUNTIME_URL}/api/tenants/${tenantId}/features`);
  // Cache for 60 seconds per tenant
  return NextResponse.json(features, {
    headers: { 'Cache-Control': 'private, max-age=60' },
  });
}
```

**File:** `apps/studio/src/hooks/use-features.ts` (new)

```ts
export function useFeatures() {
  const { data } = useSWR('/api/features', fetcher, {
    refreshInterval: 60_000,
    dedupingInterval: 30_000,
  });
  return {
    hasModules: data?.reusable_modules ?? false,
    // ... other features
  };
}
```

If Runtime is unreachable, Studio fails closed (hides module UI) — consistent with Decision 8b.

---

## 10. Concurrency Control

**Decisions:** 9a (counter on Project), 9b (60s TTL, 30s renewal), 9c (revision counter)

### 10.1 Dependency Version Counter

**File:** `packages/database/src/models/project.model.ts`

```ts
moduleDependencyVersion: { type: Number, default: 0 }
```

Incremented on every dependency mutation:

```ts
// On create, delete, or replace dependency:
await Project.findOneAndUpdate(
  { _id: projectId, tenantId },
  { $inc: { moduleDependencyVersion: 1 } },
);
```

Deployment build reads version before snapshot creation and uses atomic verify-and-persist:

```ts
// Before build:
const preVersion = project.moduleDependencyVersion;

// ... build snapshot ...

// Atomic verify-and-update: use findOneAndUpdate with version condition
// This prevents TOCTOU race between read and persist
const result = await Deployment.findOneAndUpdate(
  {
    _id: deploymentId,
    tenantId,
    // Verify dependency version hasn't changed via a join-free check
  },
  { $set: { status: 'active', moduleSnapshotId: snapshot._id } },
  { returnDocument: 'after' },
);

// Also verify version atomically when persisting the snapshot:
const versionCheck = await Project.findOneAndUpdate(
  {
    _id: projectId,
    tenantId,
    moduleDependencyVersion: preVersion, // atomic condition
  },
  { $set: { lastDeployedAt: new Date() } }, // lightweight touch
  { returnDocument: 'after' },
);
if (!versionCheck) {
  // Version changed during build — abort and clean up
  await DeploymentModuleSnapshot.deleteOne({ _id: snapshot._id });
  throw new ConflictError('Dependencies changed during deployment build. Please retry.');
}
```

### 10.2 Redis Distributed Lock for Deployment Build

**Lock key:** `module:deploy:{tenantId}:{projectId}`

```ts
const LOCK_TTL_MS = 60_000; // 60 seconds
const RENEWAL_INTERVAL_MS = 30_000; // 30 seconds

// Lua script for atomic compare-and-delete (prevents TOCTOU race on release)
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// Lua script for atomic compare-and-renew (prevents TOCTOU race on renewal)
const RENEW_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

async function acquireDeployLock(
  redis: RedisClient,
  tenantId: string,
  projectId: string,
): Promise<{ lockId: string; release: () => Promise<void> } | null> {
  const lockKey = `module:deploy:${tenantId}:${projectId}`;
  const lockId = crypto.randomUUID();

  const acquired = await redis.set(lockKey, lockId, { NX: true, PX: LOCK_TTL_MS });
  if (!acquired) return null; // 409: "A deployment build is already in progress"

  // Auto-renewal using atomic Lua script
  const renewalTimer = setInterval(async () => {
    const renewed = await redis.eval(RENEW_LOCK_SCRIPT, 1, lockKey, lockId, String(LOCK_TTL_MS));
    if (!renewed) clearInterval(renewalTimer);
  }, RENEWAL_INTERVAL_MS);

  return {
    lockId,
    release: async () => {
      clearInterval(renewalTimer);
      // Atomic compare-and-delete via Lua script
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockId);
    },
  };
}
```

Lock acquisition failure returns 409: `"A deployment build is already in progress for this project. Please wait and retry."`

### 10.3 Pointer Promotion Concurrency

**Mechanism:** Optimistic concurrency via `revision` counter (Decision 9c).

```ts
const result = await ModuleEnvironmentPointer.findOneAndUpdate(
  {
    tenantId,
    moduleProjectId,
    environment,
    revision: expectedRevision,
  },
  {
    $set: { moduleReleaseId: targetReleaseId, updatedBy: userId, updatedAt: new Date() },
    $inc: { revision: 1 },
  },
  { returnDocument: 'after' },
);

if (!result) {
  // Another promotion raced — return 409
  return res.status(409).json({
    success: false,
    error: {
      code: 'POINTER_CONFLICT',
      message: `The ${environment} pointer was updated by another user. Please refresh and retry.`,
    },
  });
}
```

---

## 11. Security

### 11.1 Publish Safety Validation

**File:** `packages/project-io/src/module-release/module-publish-safety.ts` (new)

Two-tier validation (resolves HIGH-5):

#### Structural validation (primary)

For every HTTP tool in the module:

- `auth_config` must use `auth_profile_ref` or `{{env.*}}`/`{{config.*}}` templating
- Reject any tool where `auth_config` contains non-templated literal values
- Check `custom_headers`, `query_params`, `body_template` for non-templated literals in auth-sensitive positions

#### Pattern-based validation (supplementary)

Scan all string values in tool DSL and agent DSL for:

- Base64-encoded strings > 20 chars that decode to ASCII (`/^[A-Za-z0-9+/=]{20,}$/`)
- URL-embedded API keys (`[?&](api_key|apikey|key|token|secret)=[^&]+`)
- PEM-encoded private keys (`-----BEGIN.*PRIVATE KEY-----`)
- Common secret patterns (`Bearer `, `Basic `, `sk-`, `pk_`)

#### Non-portable tool binding warnings

Some tool bindings reference project-scoped resources that may not exist in the consumer:

- **SearchAI tools** (`SearchAIBindingIR.indexId`): The knowledge base ID is project-scoped. Emit a publish-time **warning** (not blocking error) and include the `indexId` in the contract's `warnings` array so consumers know they need a matching knowledge base.
- **Workflow tools** (`WorkflowBindingIR.workflowId`): The workflow ID is project-scoped. Emit a publish-time **warning** and include in `warnings`.

At runtime, if a consumer deployment references a SearchAI or Workflow tool whose backing resource doesn't exist, the tool call will fail with a standard tool error — not a silent misconfiguration.

#### Source-project-only identifiers

Strip or reject:

- `variableNamespaceIds` (confirmed present in `resolve-tool-implementations.ts` at lines 70, 116, 464, 477, 564)
- Raw MongoDB `_id` references that are source-project-specific
- Any `projectId` fields pointing to the source project

### 11.2 configOverrides Secret Prevention

At dependency save time:

```ts
function validateConfigOverrides(
  overrides: Record<string, string>,
  contract: ModuleReleaseContract,
): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];

  // Size limits
  if (Object.keys(overrides).length > 50) {
    blocking.push('Config overrides exceed maximum of 50 keys');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (Buffer.byteLength(value, 'utf8') > 1024) {
      blocking.push(`Config override '${key}' exceeds maximum value size of 1 KB`);
    }
  }

  // Validate against contract
  const declaredKeys = new Set(contract.requiredConfigKeys.map((k) => k.key));
  const secretKeys = new Set(
    contract.requiredConfigKeys.filter((k) => k.isSecret).map((k) => k.key),
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (!declaredKeys.has(key)) {
      warnings.push(`Config key '${key}' is not declared in the module contract`);
    }
    if (secretKeys.has(key)) {
      blocking.push(
        `Config key '${key}' is declared as a secret. Use environment variables or auth profiles instead.`,
      );
    }
    // Reject template injection: values must not contain {{ syntax
    // Config overrides are literal string values, not template expressions
    // Use /\{\{/ (not /\{\{.*?\}\}/) to avoid newline bypass ({{\nfoo}})
    if (/\{\{/.test(value)) {
      blocking.push(
        `Config override '${key}' contains template syntax ({{...}}). Config overrides must be literal values.`,
      );
    }
    // Reject control characters that could corrupt BSON or downstream parsing
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) {
      blocking.push(`Config override '${key}' contains invalid control characters`);
    }
  }

  return { blocking, warnings };
}
```

### 11.3 Cross-Tenant Isolation

All module queries include `tenantId`. Cross-tenant access returns 404 (not 403):

```ts
// Catalog: only shows modules in consumer's tenant
// Import: validates moduleProject.tenantId === consumerProject.tenantId
// Resolve: findOne({ _id, tenantId }) — returns null (→ 404) if wrong tenant
```

### 11.4 Express Route Ordering

**Resolves MEDIUM-5 from arch review.**

Any new runtime routes under `/deployments/` must be registered BEFORE the `/:id` parameterized route:

```ts
// In deployment route registration:
router.get('/deployments/:id/module-snapshot', moduleSnapshotHandler); // static segment
router.get('/deployments/:id', getDeploymentHandler); // parameterized — must be AFTER
```

---

## 12. E2E Test Bootstrap Architecture

**Resolves MEDIUM-15 from arch review.**

### 12.1 Module E2E Bootstrap Helper

**File:** `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts` (new)

Runtime E2E tests need to exercise the full module lifecycle (publish, import, deploy, execute) but publish/import are Studio-owned routes. The bootstrap helper provides API-only test utilities:

```ts
export class ModuleE2EBootstrap {
  private studioServer: Express;
  private runtimeServer: Express;

  constructor(private config: { studioPort: number; runtimePort: number }) {}

  async setup(): Promise<void> {
    // Start real Studio API server on random port
    // Start real Runtime server on random port
    // Full middleware chain: auth, rate limiting, tenant isolation, validation
  }

  async createModuleProject(tenantId: string, agents: AgentDSL[]): Promise<string> {
    // POST /api/projects → POST /api/projects/:id/module (enable)
  }

  async publishRelease(moduleProjectId: string, version: string): Promise<string> {
    // POST /api/projects/:id/module/releases
  }

  async importModule(
    consumerProjectId: string,
    moduleProjectId: string,
    alias: string,
    version: string,
  ): Promise<string> {
    // POST /api/projects/:id/module-dependencies/preview
    // POST /api/projects/:id/module-dependencies
  }

  async deployConsumer(projectId: string): Promise<string> {
    // POST /api/projects/:id/deployments (runtime)
  }

  async startSession(projectId: string, deploymentId: string): Promise<string> {
    // POST /api/projects/:id/sessions (runtime)
  }

  async teardown(): Promise<void> {
    // Shutdown both servers, clean up DB
  }
}
```

This helper starts **real servers** on random ports with the **full middleware chain**. No mocking, no direct DB access, no stubbed infrastructure (per E2E test standards).

### 12.2 Test Data Patterns

E2E tests seed data exclusively through HTTP endpoints. Module DSL fixtures:

```ts
const SIMPLE_MODULE_AGENT_DSL = `
AGENT: lookup_agent
GOAL: Look up information
TOOLS:
  - lookup_tool
`;

const SIMPLE_MODULE_TOOL_DSL = `
TOOL: lookup_tool
TYPE: http
ENDPOINT: "{{config.API_BASE_URL}}/lookup"
AUTH: auth_profile_ref("lookup_api")
`;
```

---

## 13. Implementation Order

### Sprint 1: Foundation (Workstreams A + B)

1. **Data models** — 4 new Mongoose models + Project extension + indexes
2. **Cascade delete** — both paths + tenant deletion (requires `deleteProject` signature extension)
3. **Shared types** — `ResolvedAgentIR`/`ResolvedToolDefinition` in `apps/runtime/src/services/modules/types.ts`, extend `TraceEventType` union in `packages/shared-kernel/src/types/trace-event.ts` with `tool_auth_resolved`
4. **Module release builder** — artifact assembly, contract extraction, sourceHash
5. **Publish safety** — structural + pattern validation + SearchAI/Workflow binding warnings
6. **Module selector** — version/environment resolution
7. **Unit tests:** P1-U01, P1-U02, P1-U03, P1-U04, P1-U05, P1-U06, P1-U11

### Sprint 2: Build Pipeline (Workstreams C partial + D)

8. **Permissions** — 4 new permissions + role mappings
9. **Studio module routes** — publish, promote, catalog, import (preview + confirm) with Zod request validation
10. **Alias rewriter** — IR tree walk (including `metadata.name` + `checkpoint.target`) + collision detection
11. **Deployment build service** — combined compile + snapshot creation + compression
12. **Feature gate** — fail-closed module gate + Studio feature resolution
13. **Unit/integration tests:** P1-U07, P1-U08, P1-U09, P1-U10, P1-U12, P1-U17-U21, P1-I01-I05

### Sprint 3: Runtime + UX (Workstreams C remaining + E + F)

14. **Deployment resolver** — merge mounted agents/tools from snapshot (use `ResolvedAgentIR` types)
15. **Session provenance** — persist and rehydrate moduleProvenance
16. **Trace enrichment** — module fields in trace events + `tool_auth_resolved` scope tracing
17. **Studio stores** — project-store extension + module-store
18. **Studio components** — ModuleSettingsPanel, PublishModuleDialog, ImportModuleDialog, ModuleDependencyList
19. **ABL authoring** — symbol tree, tool picker, coordination section, Monaco completions
20. **i18n** — `modules` key in studio.json
21. **Integration tests:** P1-I06-I15

### Sprint 4: E2E + Polish (Workstreams F + G)

22. **E2E test bootstrap** — module-e2e-bootstrap.ts
23. **E2E tests:** P1-E01 through P1-E15
24. **Browser smoke:** P1-B01, P1-B02, P1-B03
25. **Audit events** — all 8 module audit actions
26. **Concurrency tests:** P1-R16-R18
27. **Regression tests:** all P1-R01 through P1-R28

### Sprint 5: Rollout Safety (Workstream G)

28. **Feature flag wiring** — PLAN_FEATURES + Studio SWR hook
29. **Kill switch verification** — flag-off path regression testing
30. **Operational metrics** — publish/import error rates, snapshot sizes, compile latency
31. **Internal dogfood** — single tenant with module + 2 consumers

---

## 14. Cross-Reference: Review Finding Resolution

Every finding from the unified review and architecture review is addressed in this LLD:

| Finding                                     | Section  | Resolution                                                                       |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| CRIT-1: Cascade delete                      | §2       | Two-path cascade with explicit ordering                                          |
| CRIT-2: Permission role mapping             | §7.2     | OWNER: all 4, EDITOR: read+import, VIEWER: read                                  |
| CRIT-3: Test guide coverage                 | §12, §13 | Full test plan aligned; bootstrap architecture specified                         |
| HIGH-1: Project.kind migration              | §1.1     | Schema default + null handling                                                   |
| HIGH-2: deployment_module_snapshots index   | §1.5     | `{ tenantId: 1, deploymentId: 1 }` unique                                        |
| HIGH-3: Snapshot size risk                  | §1.5     | 8 MB limit + gzip compression                                                    |
| HIGH-4: Alias rewriting scope               | §4.2     | Exhaustive IR field list                                                         |
| HIGH-5: Secret scanning gaps                | §11.1    | Structural + pattern-based                                                       |
| HIGH-6: Auth profile silent bind            | §6.4     | Trace auth resolution scope                                                      |
| HIGH-7: No optimistic concurrency           | §10.1    | dependencyVersion counter                                                        |
| HIGH-8: Publish deduplication               | §7.5     | insertOne + catch E11000                                                         |
| HIGH-9: Feature flag unspecified            | §9       | `reusable_modules`, BUSINESS+ENTERPRISE, Studio via runtime API                  |
| HIGH-10: configOverrides unspecified        | §11.2    | 50 keys, 1KB/value, contract validation                                          |
| MED-1: moduleVisibility scope               | §1.1     | All module project members                                                       |
| MED-2: sourceHash computation               | §1.2     | SHA-256 canonical JSON, includes entryAgentName                                  |
| MED-3: Audit actions                        | §7.6     | 8 actions including MODULE_ENABLED/DISABLED                                      |
| MED-4: Express route ordering               | §11.4    | Static before parameterized                                                      |
| MED-5: Contract reuses manifest shape       | §1.2     | requiredAuthProfiles reuses ProjectManifestV2 shape                              |
| MED-6: i18n strategy                        | §8.5     | `modules` key in studio.json                                                     |
| MED-7: SWR invalidation                     | §8.4     | Mutation-to-key mapping table                                                    |
| MED-8: snapshot-service naming              | n/a      | New service named `module-snapshot-service.ts` (distinct from variable snapshot) |
| MED-9: Pointer drift                        | §7.4     | resolvedReleaseId captured at preview time                                       |
| MED-10: Orphaned snapshots                  | §5.1     | Snapshot created atomically with deployment; lock prevents partial writes        |
| MED-11: module:promote separate             | n/a      | Kept combined under module:publish for Phase 1 (approved decision)               |
| MED-12: Privilege escalation                | §7.2     | module:publish required for both publish and promote                             |
| MED-13: Feature gate fails open             | §9.2     | Module gate fails closed                                                         |
| MED-14: Missing E2E for session rehydration | §12      | P1-E06 covers rehydration provenance                                             |
| MED-15: E2E bootstrap undocumented          | §12.1    | Full bootstrap architecture specified                                            |
| LOW-1: kind enum validation                 | §1.1     | Mongoose enum specified                                                          |
| LOW-2: entryAgentName nullable              | §3.1     | Validate non-null at publish time                                                |
| LOW-3: releaseNotes field                   | §1.2     | Included in ModuleRelease                                                        |
| LOW-4: Feature doc gaps                     | n/a      | Feature doc was updated in prior review cycle                                    |

---

## References

- HLD: [`docs/specs/reusable-agent-modules-phase-plan.hld.md`](./reusable-agent-modules-phase-plan.hld.md)
- LLD Decision Register: [`docs/specs/reusable-agent-modules-phase1-lld-decisions.md`](./reusable-agent-modules-phase1-lld-decisions.md)
- Feature Doc: [`docs/features/reusable-agent-modules.md`](../features/reusable-agent-modules.md)
- Test Guide: [`docs/testing/reusable-agent-modules.md`](../testing/reusable-agent-modules.md)
- Unified Review: [`docs/reviews/reusable-agent-modules-unified-review.md`](../reviews/reusable-agent-modules-unified-review.md)
- Architecture Review: [`docs/reviews/reusable-agent-modules-arch-review.md`](../reviews/reusable-agent-modules-arch-review.md)
