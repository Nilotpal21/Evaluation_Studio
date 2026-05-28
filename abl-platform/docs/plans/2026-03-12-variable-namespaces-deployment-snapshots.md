# Variable Namespaces & Deployment Snapshots Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add namespace-based organization for project variables and immutable deployment snapshots that freeze variable values at deploy time.

**Architecture:** Three new MongoDB collections (variable_namespaces, variable_namespace_memberships, deployment_variable_snapshots) with many-to-many join between variables and namespaces. Deployment creation captures point-in-time snapshot. Runtime resolves env vars from snapshot when in deployment context. Namespaces are UI organization only -- ABL syntax (`{{env.KEY}}`, `{{config.KEY}}`) is unchanged.

**Tech Stack:** MongoDB/Mongoose, Express (Runtime), Next.js (Studio), React, TypeScript, Zod, AES-256-GCM encryption, SHA-256 hashing

**Spec:** `docs/superpowers/specs/2026-03-12-variable-namespaces-deployment-snapshots-design.md`

---

## Chunk 1: Database Models, Constants & Pre-existing Bug Fixes

### Task 1: Add Namespace Constants

**Files:**

- Modify: `packages/compiler/src/platform/constants.ts`

- [ ] **Step 1: Write failing test for new constants**

Create test file:

```typescript
// packages/compiler/src/platform/__tests__/namespace-constants.test.ts
import {
  MAX_NAMESPACES_PER_PROJECT,
  MAX_NAMESPACES_PER_VARIABLE,
  MAX_ENV_VARS_PER_PROJECT,
  MAX_NAMESPACE_NAME_LENGTH,
  MAX_NAMESPACE_DISPLAY_NAME_LENGTH,
  NAMESPACE_NAME_PATTERN,
  DEFAULT_NAMESPACE_NAME,
  DEFAULT_NAMESPACE_DISPLAY_NAME,
} from '../constants.js';

describe('Namespace constants', () => {
  it('exports namespace limits', () => {
    expect(MAX_NAMESPACES_PER_PROJECT).toBe(25);
    expect(MAX_NAMESPACES_PER_VARIABLE).toBe(10);
    expect(MAX_ENV_VARS_PER_PROJECT).toBe(500);
  });

  it('exports namespace name constraints', () => {
    expect(MAX_NAMESPACE_NAME_LENGTH).toBe(50);
    expect(MAX_NAMESPACE_DISPLAY_NAME_LENGTH).toBe(100);
    expect(NAMESPACE_NAME_PATTERN).toEqual(/^[a-z][a-z0-9-]*$/);
  });

  it('exports default namespace values', () => {
    expect(DEFAULT_NAMESPACE_NAME).toBe('default');
    expect(DEFAULT_NAMESPACE_DISPLAY_NAME).toBe('Default');
  });

  it('validates namespace name pattern correctly', () => {
    expect(NAMESPACE_NAME_PATTERN.test('stripe')).toBe(true);
    expect(NAMESPACE_NAME_PATTERN.test('my-namespace')).toBe(true);
    expect(NAMESPACE_NAME_PATTERN.test('a1')).toBe(true);
    expect(NAMESPACE_NAME_PATTERN.test('1invalid')).toBe(false);
    expect(NAMESPACE_NAME_PATTERN.test('UPPER')).toBe(false);
    expect(NAMESPACE_NAME_PATTERN.test('has space')).toBe(false);
    expect(NAMESPACE_NAME_PATTERN.test('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm test -- --testPathPattern="namespace-constants" --no-coverage`
Expected: FAIL with import errors (constants don't exist yet)

- [ ] **Step 3: Add constants to constants.ts**

Add to `packages/compiler/src/platform/constants.ts` after the existing config variable constants section (~line 186):

```typescript
// =============================================================================
// VARIABLE NAMESPACES
// =============================================================================

/** Maximum number of namespaces per project */
export const MAX_NAMESPACES_PER_PROJECT = 25;

/** Maximum number of namespaces a single variable can belong to */
export const MAX_NAMESPACES_PER_VARIABLE = 10;

/** Maximum number of environment variables per project */
export const MAX_ENV_VARS_PER_PROJECT = 500;

/** Maximum length of a namespace slug name */
export const MAX_NAMESPACE_NAME_LENGTH = 50;

/** Maximum length of a namespace display name */
export const MAX_NAMESPACE_DISPLAY_NAME_LENGTH = 100;

/** Pattern for valid namespace slug names (lowercase, alphanumeric, hyphens) */
export const NAMESPACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Reserved name for the auto-created default namespace */
export const DEFAULT_NAMESPACE_NAME = 'default';

/** Display name for the default namespace */
export const DEFAULT_NAMESPACE_DISPLAY_NAME = 'Default';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm build && pnpm test -- --testPathPattern="namespace-constants" --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/compiler/src/platform/constants.ts packages/compiler/src/platform/__tests__/namespace-constants.test.ts
git add packages/compiler/src/platform/constants.ts packages/compiler/src/platform/__tests__/namespace-constants.test.ts
git commit -m "feat(compiler): add namespace and env var limit constants"
```

---

### Task 2: Create VariableNamespace Model

**Files:**

- Create: `packages/database/src/models/variable-namespace.model.ts`
- Modify: `packages/database/src/models/index.ts`

- [ ] **Step 1: Create the model file**

```typescript
// packages/database/src/models/variable-namespace.model.ts
/**
 * Variable Namespace Model
 *
 * Organizational grouping for environment variables and config variables.
 * Many-to-many relationship with variables via VariableNamespaceMembership.
 * Each project has an auto-created "default" namespace that cannot be deleted.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IVariableNamespace {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  isDefault: boolean;
  createdBy: string;
  updatedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const VariableNamespaceSchema = new Schema<IVariableNamespace>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    icon: { type: String, default: null },
    color: {
      type: String,
      default: null,
      validate: {
        validator: (v: string | null) => v === null || /^#[0-9a-fA-F]{6}$/.test(v),
        message: 'Color must be a valid hex color (e.g., #6366f1)',
      },
    },
    order: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'variable_namespaces' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

VariableNamespaceSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

VariableNamespaceSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
VariableNamespaceSchema.index({ tenantId: 1, projectId: 1, order: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const VariableNamespace =
  (mongoose.models.VariableNamespace as any) ||
  model<IVariableNamespace>('VariableNamespace', VariableNamespaceSchema);
```

- [ ] **Step 2: Add export to index.ts**

Add to `packages/database/src/models/index.ts` after the ProjectConfigVariable export (~line 293):

```typescript
export { VariableNamespace, type IVariableNamespace } from './variable-namespace.model.js';
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/database/src/models/variable-namespace.model.ts packages/database/src/models/index.ts
git add packages/database/src/models/variable-namespace.model.ts packages/database/src/models/index.ts
git commit -m "feat(database): add VariableNamespace model"
```

---

### Task 3: Create VariableNamespaceMembership Model

**Files:**

- Create: `packages/database/src/models/variable-namespace-membership.model.ts`
- Modify: `packages/database/src/models/index.ts`

- [ ] **Step 1: Create the model file**

```typescript
// packages/database/src/models/variable-namespace-membership.model.ts
/**
 * Variable Namespace Membership Model
 *
 * Many-to-many join between variables and namespaces.
 * A variable (env or config) can belong to multiple namespaces.
 * Every variable must belong to at least one namespace (enforced at app layer).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IVariableNamespaceMembership {
  _id: string;
  tenantId: string;
  projectId: string;
  namespaceId: string;
  variableId: string;
  variableType: 'env' | 'config';
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const VariableNamespaceMembershipSchema = new Schema<IVariableNamespaceMembership>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    namespaceId: { type: String, required: true },
    variableId: { type: String, required: true },
    variableType: {
      type: String,
      required: true,
      enum: ['env', 'config'],
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'variable_namespace_memberships',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

VariableNamespaceMembershipSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

VariableNamespaceMembershipSchema.index(
  { namespaceId: 1, variableId: 1, variableType: 1 },
  { unique: true },
);
VariableNamespaceMembershipSchema.index({ variableId: 1, variableType: 1 });
VariableNamespaceMembershipSchema.index({ tenantId: 1, projectId: 1, namespaceId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const VariableNamespaceMembership =
  (mongoose.models.VariableNamespaceMembership as any) ||
  model<IVariableNamespaceMembership>(
    'VariableNamespaceMembership',
    VariableNamespaceMembershipSchema,
  );
```

- [ ] **Step 2: Add export to index.ts**

Add to `packages/database/src/models/index.ts` after the VariableNamespace export:

```typescript
export {
  VariableNamespaceMembership,
  type IVariableNamespaceMembership,
} from './variable-namespace-membership.model.js';
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/database/src/models/variable-namespace-membership.model.ts packages/database/src/models/index.ts
git add packages/database/src/models/variable-namespace-membership.model.ts packages/database/src/models/index.ts
git commit -m "feat(database): add VariableNamespaceMembership join model"
```

---

### Task 4: Create DeploymentVariableSnapshot Model

**Files:**

- Create: `packages/database/src/models/deployment-variable-snapshot.model.ts`
- Modify: `packages/database/src/models/index.ts`

- [ ] **Step 1: Create the model file**

```typescript
// packages/database/src/models/deployment-variable-snapshot.model.ts
/**
 * Deployment Variable Snapshot Model
 *
 * Immutable point-in-time capture of all variable values at deployment creation.
 * One snapshot per deployment. Runtime reads frozen values from here.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Sub-document Interfaces ─────────────────────────────────────────────

export interface ISnapshotEnvVar {
  key: string;
  encryptedValue: string;
  isSecret: boolean;
  description: string | null;
  sourceId: string;
  namespaces: string[];
}

export interface ISnapshotConfigVar {
  key: string;
  value: string;
  description: string | null;
  sourceId: string;
  namespaces: string[];
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeploymentVariableSnapshot {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  snapshotVersion: number;
  snapshotHash: string;
  envVars: ISnapshotEnvVar[];
  configVars: ISnapshotConfigVar[];
  createdBy: string;
  createdAt: Date;
}

// ─── Sub-document Schemas ────────────────────────────────────────────────

const SnapshotEnvVarSchema = new Schema<ISnapshotEnvVar>(
  {
    key: { type: String, required: true },
    encryptedValue: { type: String, required: true },
    isSecret: { type: Boolean, required: true },
    description: { type: String, default: null },
    sourceId: { type: String, required: true },
    namespaces: { type: [String], default: [] },
  },
  { _id: false },
);

const SnapshotConfigVarSchema = new Schema<ISnapshotConfigVar>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, default: null },
    sourceId: { type: String, required: true },
    namespaces: { type: [String], default: [] },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const DeploymentVariableSnapshotSchema = new Schema<IDeploymentVariableSnapshot>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    deploymentId: { type: String, required: true },
    environment: { type: String, required: true },
    snapshotVersion: { type: Number, default: 1 },
    snapshotHash: { type: String, required: true },
    envVars: { type: [SnapshotEnvVarSchema], default: [] },
    configVars: { type: [SnapshotConfigVarSchema], default: [] },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'deployment_variable_snapshots',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

DeploymentVariableSnapshotSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

DeploymentVariableSnapshotSchema.index({ deploymentId: 1 }, { unique: true });
DeploymentVariableSnapshotSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DeploymentVariableSnapshot =
  (mongoose.models.DeploymentVariableSnapshot as any) ||
  model<IDeploymentVariableSnapshot>(
    'DeploymentVariableSnapshot',
    DeploymentVariableSnapshotSchema,
  );
```

- [ ] **Step 2: Add export to index.ts**

Add to `packages/database/src/models/index.ts` after the VariableNamespaceMembership export:

```typescript
export {
  DeploymentVariableSnapshot,
  type IDeploymentVariableSnapshot,
  type ISnapshotEnvVar,
  type ISnapshotConfigVar,
} from './deployment-variable-snapshot.model.js';
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/database/src/models/deployment-variable-snapshot.model.ts packages/database/src/models/index.ts
git add packages/database/src/models/deployment-variable-snapshot.model.ts packages/database/src/models/index.ts
git commit -m "feat(database): add DeploymentVariableSnapshot model"
```

---

### Task 5: Add variableSnapshotId to Deployment Model

**Files:**

- Modify: `packages/database/src/models/deployment.model.ts`

- [ ] **Step 1: Add field to IDeployment interface**

In `packages/database/src/models/deployment.model.ts`, add after `settingsVersionId` (line 34):

```typescript
variableSnapshotId: string | null;
```

- [ ] **Step 2: Add field to DeploymentSchema**

After the `settingsVersionId` schema field (line 72):

```typescript
    variableSnapshotId: { type: String, default: null },
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/database/src/models/deployment.model.ts
git add packages/database/src/models/deployment.model.ts
git commit -m "feat(database): add variableSnapshotId to Deployment model"
```

---

### Task 6: Fix Cascade Deletes (Pre-existing Gap)

**Files:**

- Modify: `packages/database/src/cascade/cascade-delete.ts`

- [ ] **Step 1: Read the current cascade-delete.ts file**

Read `packages/database/src/cascade/cascade-delete.ts` to find exact insertion point in the `deleteProject` function. The new deletes go inside the existing `deleteProject` cascade, before the final project deletion.

- [ ] **Step 2: Add imports for new models**

Add imports at the top of `cascade-delete.ts` for:

- `VariableNamespaceMembership`
- `VariableNamespace`
- `DeploymentVariableSnapshot`
- `EnvironmentVariable`
- `ProjectConfigVariable`

(Check which are already imported -- `EnvironmentVariable` and `ProjectConfigVariable` may not be.)

- [ ] **Step 3: Add cascade deletes to deleteProject function**

Add these deleteMany calls inside the `deleteProject` function, before the final `Project.deleteOne`. Order matters -- delete deepest first:

```typescript
// Variable namespace system (memberships before parents)
await VariableNamespaceMembership.deleteMany({ projectId });
await EnvironmentVariable.deleteMany({ projectId });
await ProjectConfigVariable.deleteMany({ projectId });
await VariableNamespace.deleteMany({ projectId });
// Snapshots BEFORE deployments (snapshots reference deploymentId as FK)
await DeploymentVariableSnapshot.deleteMany({ projectId });
```

Note: Place the `DeploymentVariableSnapshot.deleteMany` call BEFORE the existing `Deployment.deleteMany` line in the function.

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/database/src/cascade/cascade-delete.ts
git add packages/database/src/cascade/cascade-delete.ts
git commit -m "fix(database): add env var, config var, and namespace cascade deletes to deleteProject"
```

---

### Task 7: Fix Tenant Isolation in Config Variable Repo (Pre-existing Gap)

**Files:**

- Modify: `apps/studio/src/repos/config-variable-repo.ts`

- [ ] **Step 1: Read the file**

Read `apps/studio/src/repos/config-variable-repo.ts` to see all functions and their current signatures.

- [ ] **Step 2: Add tenantId parameter to all functions missing it**

Update these four functions to require `tenantId` as a parameter and include it in the query filter:

1. `findConfigVariablesByProject(projectId, tenantId)` -- add `tenantId` to `.find()` filter
2. `findConfigVariableByKey(projectId, key, tenantId)` -- add `tenantId` to `.findOne()` filter
3. `deleteConfigVariablesByProject(projectId, tenantId)` -- add `tenantId` to `.deleteMany()` filter
4. `countConfigVariables(projectId, tenantId)` -- add `tenantId` to `.countDocuments()` filter

- [ ] **Step 3: Fix all callers**

Search for all callers of these functions in `apps/studio/src/app/api/` and update them to pass `user.tenantId` from the session context. Key callers:

- `apps/studio/src/app/api/projects/[id]/config-variables/route.ts` (GET and POST)
- `apps/studio/src/app/api/projects/[id]/config-variables/[varId]/route.ts`
- `apps/studio/src/app/api/abl/compile/route.ts` (the `findConfigVariablesByProject` call)

- [ ] **Step 4: Build to catch broken callers**

Run: `pnpm build --filter=@abl/studio`
Expected: BUILD SUCCESS (all callers updated). If any fail, fix the remaining callers.

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/repos/config-variable-repo.ts
# Also format any caller files that were modified
git add apps/studio/src/repos/config-variable-repo.ts apps/studio/src/app/api/
git commit -m "fix(studio): add tenantId filter to all config variable repo queries"
```

---

### Task 8: Fix Config Variable Route Access Check (Pre-existing Gap)

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/config-variables/route.ts`

- [ ] **Step 1: Read the route file and its sibling [varId]/route.ts**

Read both files to understand the current auth pattern. The `[varId]/route.ts` uses `requireProjectAccess` -- the collection route must match.

- [ ] **Step 2: Replace requireTenantAuth with requireProjectAccess**

In the GET and POST handlers, replace `requireTenantAuth` with the same `requireProjectAccess` pattern used in `[varId]/route.ts`. Ensure both handlers verify the project belongs to the user's tenant.

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/studio`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/config-variables/route.ts
git add apps/studio/src/app/api/projects/[id]/config-variables/route.ts
git commit -m "fix(studio): use requireProjectAccess on config variable collection routes"
```

---

### Task 9: Fix Runtime loadConfigVariablesMap tenantId (Pre-existing Gap)

**Files:**

- Modify: `apps/runtime/src/repos/project-repo.ts`

- [ ] **Step 1: Read the file and find loadConfigVariablesMap**

Read `apps/runtime/src/repos/project-repo.ts` to find the `loadConfigVariablesMap` function and its callers.

- [ ] **Step 2: Add tenantId parameter and filter**

Add `tenantId` as a required parameter and include it in the MongoDB query filter.

- [ ] **Step 3: Update all callers**

Search for all callers of `loadConfigVariablesMap` and update them to pass `tenantId`.

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/repos/project-repo.ts
# Format any modified callers too
git add apps/runtime/src/repos/project-repo.ts
git commit -m "fix(runtime): add tenantId filter to loadConfigVariablesMap"
```

---

### Task 10: Add Max Env Var Count Check (Pre-existing Gap)

**Files:**

- Modify: `apps/runtime/src/routes/environment-variables.ts`

- [ ] **Step 1: Read the POST handler in environment-variables.ts**

Find the POST route handler to identify where to add the count check.

- [ ] **Step 2: Add count check before creating new env var**

Import `MAX_ENV_VARS_PER_PROJECT` from `@abl/compiler/platform` and add a count check:

```typescript
import { MAX_ENV_VARS_PER_PROJECT } from '@abl/compiler/platform';

// Inside POST handler, before creating:
const count = await countEnvironmentVariables({
  tenantId: req.tenantContext.tenantId,
  projectId: req.params.projectId,
  environment: req.body.environment,
});
if (count >= MAX_ENV_VARS_PER_PROJECT) {
  return res.status(400).json({
    success: false,
    error: `Maximum of ${MAX_ENV_VARS_PER_PROJECT} environment variables per project reached`,
  });
}
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/environment-variables.ts
git add apps/runtime/src/routes/environment-variables.ts
git commit -m "fix(runtime): enforce MAX_ENV_VARS_PER_PROJECT limit on env var creation"
```

---

## Chunk 2: Namespace CRUD Routes (Runtime)

### Task 11: Create Namespace Repo Functions

**Files:**

- Create: `apps/runtime/src/repos/namespace-repo.ts`

- [ ] **Step 1: Write tests for namespace repo**

Create test file:

```typescript
// apps/runtime/src/__tests__/repos/namespace-repo.test.ts
```

Test the following functions (mock Mongoose models):

- `createNamespace(data)` -- creates with uuidv7, returns doc
- `findNamespaces(tenantId, projectId)` -- sorted by order
- `findNamespaceById(id, tenantId)` -- tenant-scoped lookup
- `findDefaultNamespace(tenantId, projectId)` -- finds isDefault: true
- `updateNamespace(id, tenantId, data)` -- partial update
- `deleteNamespace(id, tenantId)` -- deletes one
- `countNamespaces(tenantId, projectId)` -- count for limit check
- `reorderNamespaces(tenantId, projectId, order[])` -- bulkWrite

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm test -- --testPathPattern="namespace-repo" --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement namespace-repo.ts**

```typescript
// apps/runtime/src/repos/namespace-repo.ts
import { VariableNamespace, VariableNamespaceMembership } from '@abl/database';

export async function createNamespace(data: {
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  order?: number;
  isDefault?: boolean;
  createdBy: string;
}) {
  return VariableNamespace.create(data);
}

export async function findNamespaces(tenantId: string, projectId: string) {
  return VariableNamespace.find({ tenantId, projectId }).sort({ order: 1 }).lean();
}

export async function findNamespaceById(id: string, tenantId: string) {
  return VariableNamespace.findOne({ _id: id, tenantId }).lean();
}

export async function findDefaultNamespace(tenantId: string, projectId: string) {
  return VariableNamespace.findOne({ tenantId, projectId, isDefault: true }).lean();
}

export async function updateNamespace(
  id: string,
  tenantId: string,
  data: Partial<{
    displayName: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    updatedBy: string;
  }>,
) {
  return VariableNamespace.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true },
  ).lean();
}

export async function deleteNamespace(id: string, tenantId: string) {
  return VariableNamespace.deleteOne({ _id: id, tenantId });
}

export async function countNamespaces(tenantId: string, projectId: string) {
  return VariableNamespace.countDocuments({ tenantId, projectId });
}

export async function reorderNamespaces(
  tenantId: string,
  projectId: string,
  order: Array<{ namespaceId: string; order: number }>,
) {
  const ops = order.map(({ namespaceId, order: newOrder }) => ({
    updateOne: {
      filter: { _id: namespaceId, tenantId, projectId },
      update: { $set: { order: newOrder } },
    },
  }));
  return VariableNamespace.bulkWrite(ops);
}

export async function getNamespaceMemberCounts(
  tenantId: string,
  projectId: string,
  namespaceIds: string[],
) {
  const counts = await VariableNamespaceMembership.aggregate([
    { $match: { tenantId, projectId, namespaceId: { $in: namespaceIds } } },
    {
      $group: {
        _id: { namespaceId: '$namespaceId', variableType: '$variableType' },
        count: { $sum: 1 },
      },
    },
  ]);

  const result: Record<string, { env: number; config: number }> = {};
  for (const nsId of namespaceIds) {
    result[nsId] = { env: 0, config: 0 };
  }
  for (const item of counts) {
    const nsId = item._id.namespaceId;
    const type = item._id.variableType as 'env' | 'config';
    if (result[nsId]) {
      result[nsId][type] = item.count;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm build && pnpm test -- --testPathPattern="namespace-repo" --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/repos/namespace-repo.ts apps/runtime/src/__tests__/repos/namespace-repo.test.ts
git add apps/runtime/src/repos/namespace-repo.ts apps/runtime/src/__tests__/repos/namespace-repo.test.ts
git commit -m "feat(runtime): add namespace repo functions"
```

---

### Task 12: Create Membership Repo Functions

**Files:**

- Create: `apps/runtime/src/repos/membership-repo.ts`

- [ ] **Step 1: Write tests for membership repo**

Create test file `apps/runtime/src/__tests__/repos/membership-repo.test.ts`.

Test the following functions:

- `addMemberships(tenantId, projectId, namespaceId, variables[])` -- bulk insert
- `removeMembership(tenantId, namespaceId, variableId, variableType)` -- delete one
- `findMembershipsByNamespace(tenantId, projectId, namespaceId)` -- list members
- `findMembershipsByVariable(tenantId, variableId, variableType)` -- all namespaces for a var
- `countMembershipsForVariable(tenantId, variableId, variableType)` -- count
- `deleteAllMembershipsForVariable(variableId, variableType)` -- cascade on var delete
- `deleteAllMembershipsForNamespace(namespaceId)` -- cascade on namespace delete
- `moveMemberships(tenantId, sourceNsId, targetNsId, variables[])` -- atomic move

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm test -- --testPathPattern="membership-repo" --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement membership-repo.ts**

```typescript
// apps/runtime/src/repos/membership-repo.ts
import { VariableNamespaceMembership } from '@abl/database';
import type { ClientSession } from 'mongoose';

export async function addMemberships(
  tenantId: string,
  projectId: string,
  namespaceId: string,
  variables: Array<{ variableId: string; variableType: 'env' | 'config' }>,
  session?: ClientSession,
) {
  const docs = variables.map((v) => ({
    tenantId,
    projectId,
    namespaceId,
    variableId: v.variableId,
    variableType: v.variableType,
  }));
  // ordered: false to skip duplicates (unique index will reject)
  try {
    return await VariableNamespaceMembership.insertMany(docs, { ordered: false, session });
  } catch (err: unknown) {
    // Bulk write errors with duplicate key are expected (idempotent)
    if (err instanceof Error && 'code' in err && (err as any).code === 11000) {
      return (err as any).insertedDocs ?? [];
    }
    throw err;
  }
}

export async function removeMembership(
  tenantId: string,
  namespaceId: string,
  variableId: string,
  variableType: 'env' | 'config',
  session?: ClientSession,
) {
  return VariableNamespaceMembership.deleteOne(
    { tenantId, namespaceId, variableId, variableType },
    { session },
  );
}

export async function findMembershipsByNamespace(
  tenantId: string,
  projectId: string,
  namespaceId: string,
) {
  return VariableNamespaceMembership.find({ tenantId, projectId, namespaceId }).lean();
}

export async function findMembershipsByVariable(
  tenantId: string,
  variableId: string,
  variableType: 'env' | 'config',
) {
  return VariableNamespaceMembership.find({ tenantId, variableId, variableType }).lean();
}

export async function countMembershipsForVariable(
  tenantId: string,
  variableId: string,
  variableType: 'env' | 'config',
) {
  return VariableNamespaceMembership.countDocuments({ tenantId, variableId, variableType });
}

export async function deleteAllMembershipsForVariable(
  variableId: string,
  variableType: 'env' | 'config',
  session?: ClientSession,
) {
  return VariableNamespaceMembership.deleteMany({ variableId, variableType }, { session });
}

export async function deleteAllMembershipsForNamespace(
  namespaceId: string,
  session?: ClientSession,
) {
  return VariableNamespaceMembership.deleteMany({ namespaceId }, { session });
}

export async function moveMemberships(
  tenantId: string,
  projectId: string,
  sourceNamespaceId: string,
  targetNamespaceId: string,
  variables: Array<{ variableId: string; variableType: 'env' | 'config' }>,
  session?: ClientSession,
) {
  const ops = variables.flatMap((v) => [
    {
      deleteOne: {
        filter: {
          tenantId,
          namespaceId: sourceNamespaceId,
          variableId: v.variableId,
          variableType: v.variableType,
        },
      },
    },
    {
      insertOne: {
        document: {
          tenantId,
          projectId,
          namespaceId: targetNamespaceId,
          variableId: v.variableId,
          variableType: v.variableType,
        },
      },
    },
  ]);
  return VariableNamespaceMembership.bulkWrite(ops, { session });
}

export async function findMembershipsByVariableIds(tenantId: string, variableIds: string[]) {
  return VariableNamespaceMembership.find({
    tenantId,
    variableId: { $in: variableIds },
  }).lean();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm build && pnpm test -- --testPathPattern="membership-repo" --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/repos/membership-repo.ts apps/runtime/src/__tests__/repos/membership-repo.test.ts
git add apps/runtime/src/repos/membership-repo.ts apps/runtime/src/__tests__/repos/membership-repo.test.ts
git commit -m "feat(runtime): add membership repo functions"
```

---

### Task 13: Create Namespace Routes

**Files:**

- Create: `apps/runtime/src/routes/namespaces.ts`
- Modify: `apps/runtime/src/server.ts`

- [ ] **Step 1: Read environment-variables.ts to understand the router pattern**

Read `apps/runtime/src/routes/environment-variables.ts` lines 1-50 to understand the import pattern, middleware setup, and router creation.

- [ ] **Step 2: Create namespace routes file**

Create `apps/runtime/src/routes/namespaces.ts` with the following handlers. Follow the exact same pattern as `environment-variables.ts`:

- `router.use(authMiddleware)` + `router.use(requireProjectScope('projectId'))` + `router.use(tenantRateLimit('request'))`
- Each handler starts with inline `requireProjectPermission` check

Handlers:

1. **GET `/`** -- List namespaces (permission: `namespace:read`)
   - Query: `findNamespaces(tenantId, projectId)`
   - Enrich with member counts via `getNamespaceMemberCounts`
   - Return sorted by order

2. **POST `/`** -- Create namespace (permission: `namespace:create`)
   - Validate: name pattern, not "default", unique in project, count < 25
   - Auto-assign next order value
   - Return 201 with created namespace

3. **PUT `/:namespaceId`** -- Update namespace (permission: `namespace:update`)
   - Validate: namespace exists, belongs to tenant
   - If isDefault: cannot update displayName or name
   - If color provided: must match `/^#[0-9a-fA-F]{6}$/`
   - Return updated namespace

4. **DELETE `/:namespaceId`** -- Delete namespace (permission: `namespace:delete`)
   - Cannot delete default namespace (400)
   - Transactional: move orphans to default, delete memberships, delete namespace
   - Use `withTransaction` from `@agent-platform/shared`
   - Return `{ success: true, movedToDefault: N }`

5. **PUT `/reorder`** -- Reorder namespaces (permission: `namespace:update`)
   - Validate: all namespaceIds exist in project
   - bulkWrite order updates
   - Return updated list

- [ ] **Step 3: Mount namespace routes in server.ts**

In `apps/runtime/src/server.ts`, add import and mount:

```typescript
import namespacesRouter from './routes/namespaces.js';
// ... near line 398 where env-vars is mounted:
app.use('/api/projects/:projectId/namespaces', namespacesRouter);
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/namespaces.ts apps/runtime/src/server.ts
git add apps/runtime/src/routes/namespaces.ts apps/runtime/src/server.ts
git commit -m "feat(runtime): add namespace CRUD routes"
```

---

### Task 14: Create Membership Routes

**Files:**

- Create: `apps/runtime/src/routes/namespace-members.ts`
- Modify: `apps/runtime/src/server.ts`

- [ ] **Step 1: Create membership routes file**

Create `apps/runtime/src/routes/namespace-members.ts` with the following handlers.

Same middleware pattern as namespaces router.

Handlers:

1. **GET `/`** -- List members of a namespace (permission: `namespace:read`)
   - Validate namespace exists and belongs to tenant + project
   - Use the 3-query pattern from spec section 3.3:
     1. Find memberships for namespaceId
     2. Batch-fetch env vars by IDs
     3. Batch-fetch config vars by IDs
   - Enrich each variable with its full namespace list (2 additional queries)
   - Paginate (default 50, max 100)
   - Support `type` filter (`env` | `config`) and `environment` filter

2. **POST `/`** -- Add variables to namespace (permission: `namespace:update`)
   - Accept `variables: [{ variableId, variableType }]`, max 100
   - Validate each variable exists in same tenant+project
   - Check MAX_NAMESPACES_PER_VARIABLE (10) per variable
   - Use `addMemberships` (idempotent -- skips duplicates)
   - Return `{ success, added, skipped, errors }`

3. **DELETE `/:variableId`** -- Remove variable from namespace (permission: `namespace:update`)
   - Query param: `?type=env|config`
   - If last namespace -> auto-add to default
   - Cannot remove from default if it's the only namespace
   - Return `{ success, movedToDefault }`

4. **POST `/move`** -- Move variables between namespaces (permission: `namespace:update`)
   - Accept `{ targetNamespaceId, variables: [{ variableId, variableType }] }`
   - Max 100 variables
   - Source != target validation
   - Atomic via MongoDB session
   - Return `{ success, moved }`

- [ ] **Step 2: Mount membership routes in server.ts**

```typescript
import namespaceMembersRouter from './routes/namespace-members.js';
app.use('/api/projects/:projectId/namespaces/:namespaceId/members', namespaceMembersRouter);
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/namespace-members.ts apps/runtime/src/server.ts
git add apps/runtime/src/routes/namespace-members.ts apps/runtime/src/server.ts
git commit -m "feat(runtime): add namespace membership routes"
```

---

## Chunk 3: Update Existing Variable Routes & Deployment Snapshots

### Task 15: Update Environment Variable Routes for Namespace Support

**Files:**

- Modify: `apps/runtime/src/routes/environment-variables.ts`

- [ ] **Step 1: Read the full environment-variables.ts**

Read the entire file to understand all route handlers.

- [ ] **Step 2: Update POST handler (create env var)**

After creating the env var, create namespace memberships:

- If `namespaceIds` provided in body: validate all exist in project, create memberships
- If `namespaceIds` omitted or empty: create membership to default namespace
- Validate max 10 namespaces per variable

- [ ] **Step 3: Update GET handler (list env vars)**

- Accept optional `namespaceId` query param
- If provided: join with memberships to filter
- Enrich each variable with its namespace list (2 additional queries, see spec section 3.3)

- [ ] **Step 4: Update PUT handler (update env var)**

- If `namespaceIds` provided in body: replace all memberships (set semantics)
  - Delete old memberships, create new ones
  - If empty array: move to default only
  - Validate at least one, max 10
- If `namespaceIds` omitted: no membership changes

- [ ] **Step 5: Update DELETE handler (delete env var)**

- After deleting env var, cascade delete memberships:

```typescript
await deleteAllMembershipsForVariable(id, 'env');
```

- [ ] **Step 6: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/routes/environment-variables.ts
git add apps/runtime/src/routes/environment-variables.ts
git commit -m "feat(runtime): add namespace support to env var routes"
```

---

### Task 16: Update Config Variable Routes for Namespace Support

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/config-variables/route.ts` (GET, POST handlers)
- Modify: `apps/studio/src/app/api/projects/[id]/config-variables/[varId]/route.ts` (GET, PATCH, DELETE handlers)

- [ ] **Step 1: Read both route files**

Read the GET/POST handlers in the collection route and the GET/PATCH/DELETE handlers in the [varId] route.

- [ ] **Step 2: Update POST handler (create)**

After creating the config var, create namespace memberships. Same pattern as env vars but with `variableType: 'config'`.

Note: Studio writes memberships directly to the shared MongoDB (same DB as Runtime). Import `VariableNamespaceMembership` from `@abl/database`.

- [ ] **Step 3: Update GET handler (list)**

Accept optional `namespaceId` query param. Join with memberships to filter and enrich.

- [ ] **Step 4: Update PATCH handler (update)**

If `namespaceIds` provided: replace memberships (set semantics).

- [ ] **Step 5: Update DELETE handler**

Cascade delete memberships with `variableType: 'config'`.

- [ ] **Step 6: Build and verify**

Run: `pnpm build --filter=@abl/studio`
Expected: BUILD SUCCESS

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/config-variables/route.ts apps/studio/src/app/api/projects/[id]/config-variables/[varId]/route.ts
git add apps/studio/src/app/api/projects/[id]/config-variables/
git commit -m "feat(studio): add namespace support to config variable routes"
```

---

### Task 17: Create Snapshot Creation Service

**Files:**

- Create: `apps/runtime/src/services/snapshot-service.ts`

- [ ] **Step 1: Write tests for snapshot service**

Create `apps/runtime/src/__tests__/services/snapshot-service.test.ts`.

Test:

- `createDeploymentSnapshot(params)` -- creates snapshot with correct hash
- Snapshot hash is SHA-256 of sorted key:value pairs
- Empty variables produce valid snapshot with empty arrays
- Namespace names are denormalized correctly
- Returns snapshot document

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm test -- --testPathPattern="snapshot-service" --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement snapshot-service.ts**

```typescript
// apps/runtime/src/services/snapshot-service.ts
import { createHash } from 'crypto';
import {
  DeploymentVariableSnapshot,
  EnvironmentVariable,
  ProjectConfigVariable,
  VariableNamespaceMembership,
  VariableNamespace,
} from '@abl/database';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('snapshot-service');

export async function createDeploymentSnapshot(params: {
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  createdBy: string;
}) {
  const { tenantId, projectId, deploymentId, environment, createdBy } = params;

  // 1. Load all env vars for this project + environment
  // CRITICAL: Use .select() WITHOUT encryption metadata (ire, iv, cek, fieldsToEncrypt, tenantId).
  // This causes the Mongoose encryption plugin's post-find hook to SKIP decryption,
  // returning raw AES-256-GCM ciphertext. We store this ciphertext as-is in the snapshot.
  // If you select ire/tenantId, the plugin decrypts and you store PLAINTEXT — security bug.
  const envVars = await EnvironmentVariable.find({
    tenantId,
    projectId,
    environment,
  })
    .select('_id key encryptedValue isSecret description')
    .lean();

  // 2. Load all config vars for this project (plaintext, no encryption plugin)
  const configVars = await ProjectConfigVariable.find({
    tenantId,
    projectId,
  }).lean();

  // 3. Load all memberships for these variables
  const allVarIds = [...envVars.map((v) => v._id), ...configVars.map((v) => v._id)];

  const memberships = await VariableNamespaceMembership.find({
    tenantId,
    variableId: { $in: allVarIds },
  }).lean();

  // 4. Load namespace names for denormalization
  const nsIds = [...new Set(memberships.map((m) => m.namespaceId))];
  const namespaces = await VariableNamespace.find({
    _id: { $in: nsIds },
    tenantId,
  }).lean();
  const nsNameMap = new Map(namespaces.map((ns) => [ns._id, ns.name]));

  // 5. Build variable-to-namespace-names map
  const varNsMap = new Map<string, string[]>();
  for (const m of memberships) {
    const names = varNsMap.get(m.variableId) ?? [];
    const nsName = nsNameMap.get(m.namespaceId);
    if (nsName) names.push(nsName);
    varNsMap.set(m.variableId, names);
  }

  // 6. Build snapshot arrays
  const snapshotEnvVars = envVars
    .map((v) => ({
      key: v.key,
      encryptedValue: v.encryptedValue,
      isSecret: v.isSecret ?? false,
      description: v.description ?? null,
      sourceId: v._id,
      namespaces: (varNsMap.get(v._id) ?? []).sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const snapshotConfigVars = configVars
    .map((v) => ({
      key: v.key,
      value: v.value,
      description: v.description ?? null,
      sourceId: v._id,
      namespaces: (varNsMap.get(v._id) ?? []).sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // 7. Compute snapshot hash
  const hashInput = [
    ...snapshotEnvVars.map((v) => `env:${v.key}=${v.encryptedValue}`),
    ...snapshotConfigVars.map((v) => `config:${v.key}=${v.value}`),
  ].join('\n');
  const snapshotHash = createHash('sha256').update(hashInput).digest('hex');

  // 8. Create snapshot document
  const snapshot = await DeploymentVariableSnapshot.create({
    tenantId,
    projectId,
    deploymentId,
    environment,
    snapshotVersion: 1,
    snapshotHash,
    envVars: snapshotEnvVars,
    configVars: snapshotConfigVars,
    createdBy,
  });

  log.debug('Deployment snapshot created', {
    deploymentId,
    snapshotHash,
    envVarCount: snapshotEnvVars.length,
    configVarCount: snapshotConfigVars.length,
  });

  return snapshot;
}

export function computeSnapshotDiff(
  source: {
    envVars: Array<{ key: string; encryptedValue: string }>;
    configVars: Array<{ key: string; value: string }>;
  },
  target: {
    envVars: Array<{ key: string; encryptedValue: string }>;
    configVars: Array<{ key: string; value: string }>;
  },
) {
  const added: Array<{ key: string; type: 'env' | 'config'; namespaces: string[] }> = [];
  const removed: Array<{ key: string; type: 'env' | 'config'; namespaces: string[] }> = [];
  const changed: Array<{
    key: string;
    type: 'env' | 'config';
    valueChanged: boolean;
    namespaces: string[];
  }> = [];

  // Build maps from source
  const sourceEnvMap = new Map(source.envVars.map((v) => [v.key, v]));
  const sourceConfigMap = new Map(source.configVars.map((v) => [v.key, v]));
  const targetEnvMap = new Map(target.envVars.map((v) => [v.key, v]));
  const targetConfigMap = new Map(target.configVars.map((v) => [v.key, v]));

  // Check env vars
  for (const [key, tv] of targetEnvMap) {
    const sv = sourceEnvMap.get(key);
    if (!sv) {
      added.push({ key, type: 'env', namespaces: (tv as any).namespaces ?? [] });
    } else if (sv.encryptedValue !== tv.encryptedValue) {
      changed.push({
        key,
        type: 'env',
        valueChanged: true,
        namespaces: (tv as any).namespaces ?? [],
      });
    }
  }
  for (const [key, sv] of sourceEnvMap) {
    if (!targetEnvMap.has(key)) {
      removed.push({ key, type: 'env', namespaces: (sv as any).namespaces ?? [] });
    }
  }

  // Check config vars
  for (const [key, tv] of targetConfigMap) {
    const sv = sourceConfigMap.get(key);
    if (!sv) {
      added.push({ key, type: 'config', namespaces: (tv as any).namespaces ?? [] });
    } else if (sv.value !== tv.value) {
      changed.push({
        key,
        type: 'config',
        valueChanged: true,
        namespaces: (tv as any).namespaces ?? [],
      });
    }
  }
  for (const [key, sv] of sourceConfigMap) {
    if (!targetConfigMap.has(key)) {
      removed.push({ key, type: 'config', namespaces: (sv as any).namespaces ?? [] });
    }
  }

  return { added, removed, changed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm build && pnpm test -- --testPathPattern="snapshot-service" --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/snapshot-service.ts apps/runtime/src/__tests__/services/snapshot-service.test.ts
git add apps/runtime/src/services/snapshot-service.ts apps/runtime/src/__tests__/services/snapshot-service.test.ts
git commit -m "feat(runtime): add deployment variable snapshot creation service"
```

---

### Task 18: Update Deployment Routes for Snapshot Creation

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts`
- Create: `apps/runtime/src/__tests__/routes/deployment-snapshot.test.ts`

- [ ] **Step 1: Write tests for snapshot routes**

Create `apps/runtime/src/__tests__/routes/deployment-snapshot.test.ts`:

```typescript
// Test cases:
// - GET /:deploymentId/snapshot returns metadata, masks env var values, shows config var values
// - GET /:deploymentId/snapshot requires both deployment:read AND env_var:read permissions
// - GET /:deploymentId/snapshot/value/:key decrypts and returns the value
// - GET /:deploymentId/snapshot/value/:key returns 404 for unknown key
// - GET /:deploymentId/snapshot/diff returns diff when hashes differ
// - GET /:deploymentId/snapshot/diff returns empty arrays when hashes match (fast path)
// - All routes return 404 when deployment belongs to different tenant
// - Pre-migration deployment (no snapshot) returns 404 with message
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm test -- --testPathPattern="deployment-snapshot" --no-coverage`
Expected: FAIL

- [ ] **Step 3: Read the deployment creation handler**

Read `apps/runtime/src/routes/deployments.ts` lines 178-575 to understand the deployment creation flow.

- [ ] **Step 4: Add snapshot creation after deployment record creation**

After the deployment record is created (and before the success response), add:

```typescript
import { createDeploymentSnapshot } from '../services/snapshot-service.js';
import { Deployment } from '@abl/database';

// After deployment creation:
try {
  const snapshot = await createDeploymentSnapshot({
    tenantId,
    projectId,
    deploymentId: deployment._id,
    environment: deployment.environment,
    createdBy: req.userId,
  });

  await Deployment.updateOne(
    { _id: deployment._id, tenantId },
    { $set: { variableSnapshotId: snapshot._id } },
  );
} catch (snapshotErr) {
  log.error('Failed to create deployment variable snapshot', {
    deploymentId: deployment._id,
    error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
  });
  // Snapshot failure should NOT block deployment creation
  // Log the error and continue
}
```

- [ ] **Step 5: Add snapshot read route**

Add new route: **GET `/:deploymentId/snapshot`**

```typescript
// Permission: deployment:read AND env_var:read (sequential)
// Load DeploymentVariableSnapshot by deploymentId
// Return metadata + env var keys (no values) + config var keys+values
// Return 404 with "No snapshot available" for pre-migration deployments
```

- [ ] **Step 6: Add snapshot value route**

Add new route: **GET `/:deploymentId/snapshot/value/:key`**

```typescript
// Permission: deployment:read AND env_var:read
// Find key in snapshot.envVars, decrypt encryptedValue
// Return { success: true, key, value }
// Return 404 if key not found in snapshot
```

- [ ] **Step 7: Add snapshot diff route**

Add new route: **GET `/:deploymentId/snapshot/diff`**

```typescript
// Permission: deployment:read
// Query param: compareWith=<deploymentId>
// Load both snapshots, compare hashes first (fast path)
// If different, compute per-variable diff via computeSnapshotDiff
// Return diff response
```

- [ ] **Step 8: Add deployment -> snapshot cascade delete**

Find the deployment DELETE handler (or retirement logic) in deployments.ts. After deleting/retiring a deployment, cascade delete its snapshot:

```typescript
import { DeploymentVariableSnapshot } from '@abl/database';

// After deployment deletion:
await DeploymentVariableSnapshot.deleteOne({ deploymentId: deployment._id });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm test -- --testPathPattern="deployment-snapshot" --no-coverage`
Expected: PASS

- [ ] **Step 10: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 11: Commit**

```bash
npx prettier --write apps/runtime/src/routes/deployments.ts apps/runtime/src/__tests__/routes/deployment-snapshot.test.ts
git add apps/runtime/src/routes/deployments.ts apps/runtime/src/__tests__/routes/deployment-snapshot.test.ts
git commit -m "feat(runtime): add deployment snapshot creation, routes, and cascade delete"
```

---

### Task 19: Update RuntimeSecretsProvider for Snapshot Resolution

**Files:**

- Modify: `apps/runtime/src/services/secrets-provider.ts`

- [ ] **Step 1: Read secrets-provider.ts**

Read `apps/runtime/src/services/secrets-provider.ts` to understand the current `getEnvVar` method.

- [ ] **Step 2: Add snapshot store interface and fields**

Add to the file:

```typescript
export interface DeploymentSnapshotStore {
  findSnapshot(deploymentId: string): Promise<{
    envVars: Array<{ key: string; encryptedValue: string }>;
    configVars: Array<{ key: string; value: string }>;
  } | null>;
}
```

Add to `RuntimeSecretsProviderConfig`:

```typescript
  snapshotStore?: DeploymentSnapshotStore;
  deploymentId?: string;
```

Add private fields:

```typescript
  private snapshotStore?: DeploymentSnapshotStore;
  private deploymentId?: string;
  private snapshotEnvMap?: Map<string, string>;
  private snapshotLoaded = false;
```

- [ ] **Step 3: Update getEnvVar to check snapshot first**

Modify `getEnvVar`:

```typescript
async getEnvVar(key: string): Promise<string | undefined> {
  // Check snapshot first (deployment context)
  if (this.deploymentId && this.snapshotStore) {
    const fromSnapshot = await this.resolveEnvVarFromSnapshot(key);
    if (fromSnapshot !== undefined) return fromSnapshot;
  }

  // Fall through to live DB lookup (existing behavior)
  // ... existing code ...
}

private async resolveEnvVarFromSnapshot(key: string): Promise<string | undefined> {
  if (!this.snapshotLoaded) {
    await this.loadSnapshot();
  }
  const encrypted = this.snapshotEnvMap?.get(key);
  if (!encrypted || !this.decryptor || !this.tenantId) return undefined;
  try {
    return this.decryptor.decryptForTenant(encrypted, this.tenantId);
  } catch (err) {
    log.error('Failed to decrypt snapshot variable', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined; // Fall back to live DB
  }
}

private async loadSnapshot(): Promise<void> {
  this.snapshotLoaded = true;
  if (!this.snapshotStore || !this.deploymentId) return;

  const snapshot = await this.snapshotStore.findSnapshot(this.deploymentId);
  if (!snapshot) {
    log.warn('No snapshot found for deployment', { deploymentId: this.deploymentId });
    return;
  }

  this.snapshotEnvMap = new Map(snapshot.envVars.map((v) => [v.key, v.encryptedValue]));
  log.debug('Loaded deployment snapshot', {
    deploymentId: this.deploymentId,
    envVarCount: snapshot.envVars.length,
  });
}
```

- [ ] **Step 4: Update constructor to accept new config fields**

In the config-based constructor branch, add:

```typescript
this.snapshotStore = config.snapshotStore;
this.deploymentId = config.deploymentId;
```

- [ ] **Step 5: Build and verify**

Run: `pnpm build --filter=@abl/runtime`
Expected: BUILD SUCCESS

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/secrets-provider.ts
git add apps/runtime/src/services/secrets-provider.ts
git commit -m "feat(runtime): add snapshot-based env var resolution to RuntimeSecretsProvider"
```

---

## Chunk 4: Migration Script & Default Namespace Auto-Creation

### Task 20: Create Migration Script

**Files:**

- Create: `packages/database/src/migrations/add-default-namespaces.ts`

- [ ] **Step 1: Write the migration script**

```typescript
// packages/database/src/migrations/add-default-namespaces.ts
/**
 * Migration: Create default namespace and memberships for all existing projects.
 *
 * Idempotent: skips projects that already have a default namespace.
 * Batched: processes 100 projects at a time.
 * Reversible: drop variable_namespaces and variable_namespace_memberships collections.
 */

import {
  Project,
  VariableNamespace,
  VariableNamespaceMembership,
  EnvironmentVariable,
  ProjectConfigVariable,
} from '../models/index.js';
import { DEFAULT_NAMESPACE_NAME, DEFAULT_NAMESPACE_DISPLAY_NAME } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('migration:default-namespaces');
const BATCH_SIZE = 100;

export async function migrateDefaultNamespaces() {
  let processed = 0;
  let skip = 0;

  while (true) {
    const projects = await Project.find({}).skip(skip).limit(BATCH_SIZE).lean();
    if (projects.length === 0) break;

    for (const project of projects) {
      const tenantId = project.tenantId;
      const projectId = project._id;

      // Check if default namespace already exists
      let defaultNs = await VariableNamespace.findOne({
        tenantId,
        projectId,
        isDefault: true,
      }).lean();

      if (!defaultNs) {
        defaultNs = await VariableNamespace.create({
          tenantId,
          projectId,
          name: DEFAULT_NAMESPACE_NAME,
          displayName: DEFAULT_NAMESPACE_DISPLAY_NAME,
          isDefault: true,
          order: 0,
          createdBy: 'system:migration',
        });
        log.info('Created default namespace', { projectId, namespaceId: defaultNs._id });
      }

      // Find all env vars without any membership
      const envVars = await EnvironmentVariable.find({ projectId }).lean();
      const configVars = await ProjectConfigVariable.find({ projectId }).lean();
      const allVarIds = [...envVars.map((v) => v._id), ...configVars.map((v) => v._id)];

      const existingMemberships = await VariableNamespaceMembership.find({
        variableId: { $in: allVarIds },
      }).lean();
      const varsWithMembership = new Set(existingMemberships.map((m) => m.variableId));

      // Create memberships for orphaned variables
      const newMemberships: Array<{
        tenantId: string;
        projectId: string;
        namespaceId: string;
        variableId: string;
        variableType: 'env' | 'config';
      }> = [];

      for (const ev of envVars) {
        if (!varsWithMembership.has(ev._id)) {
          newMemberships.push({
            tenantId,
            projectId,
            namespaceId: defaultNs._id,
            variableId: ev._id,
            variableType: 'env',
          });
        }
      }

      for (const cv of configVars) {
        if (!varsWithMembership.has(cv._id)) {
          newMemberships.push({
            tenantId,
            projectId,
            namespaceId: defaultNs._id,
            variableId: cv._id,
            variableType: 'config',
          });
        }
      }

      if (newMemberships.length > 0) {
        await VariableNamespaceMembership.insertMany(newMemberships, { ordered: false });
        log.info('Created memberships', {
          projectId,
          count: newMemberships.length,
        });
      }

      processed++;
    }

    skip += BATCH_SIZE;
    log.info('Migration progress', { processed, batch: skip / BATCH_SIZE });
  }

  log.info('Migration complete', { totalProjects: processed });
}
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter=@abl/database`
Expected: BUILD SUCCESS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/database/src/migrations/add-default-namespaces.ts
git add packages/database/src/migrations/add-default-namespaces.ts
git commit -m "feat(database): add migration script for default namespaces"
```

---

### Task 21: Auto-Create Default Namespace on Project Creation

**Files:**

- Identify and modify the project creation handler

- [ ] **Step 1: Find where projects are created**

Search for where `Project.create` or `new Project` is called. This is likely in:

- `apps/runtime/src/routes/projects.ts` or similar
- Or `apps/studio/` API routes

- [ ] **Step 2: Add default namespace creation after project creation**

After the project is created, create the default namespace:

```typescript
import { VariableNamespace } from '@abl/database';
import { DEFAULT_NAMESPACE_NAME, DEFAULT_NAMESPACE_DISPLAY_NAME } from '@abl/compiler/platform';

// After project creation:
await VariableNamespace.create({
  tenantId,
  projectId: project._id,
  name: DEFAULT_NAMESPACE_NAME,
  displayName: DEFAULT_NAMESPACE_DISPLAY_NAME,
  isDefault: true,
  order: 0,
  createdBy: userId,
});
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=<affected-package>`
Expected: BUILD SUCCESS

- [ ] **Step 4: Commit**

```bash
npx prettier --write <modified-file>
git add <modified-file>
git commit -m "feat: auto-create default namespace on project creation"
```

---

## Chunk 5: Studio UI Components

### Task 22: Create Namespace API Client

**Files:**

- Create: `apps/studio/src/api/namespaces.ts`

- [ ] **Step 1: Read the existing env vars API client**

Read `apps/studio/src/api/environment-variables.ts` to understand the API client pattern.

- [ ] **Step 2: Create namespace API client**

```typescript
// apps/studio/src/api/namespaces.ts
// Follow the same fetch pattern as environment-variables.ts

export interface Namespace {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  isDefault: boolean;
  counts: { env: number; config: number };
  createdAt: string;
}

export async function listNamespaces(projectId: string): Promise<Namespace[]> {
  /* GET /api/projects/:projectId/namespaces */
}

export async function createNamespace(
  projectId: string,
  data: {
    name: string;
    displayName: string;
    description?: string;
    icon?: string;
    color?: string;
  },
): Promise<Namespace> {
  /* POST /api/projects/:projectId/namespaces */
}

export async function updateNamespace(
  projectId: string,
  namespaceId: string,
  data: {
    displayName?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
  },
): Promise<Namespace> {
  /* PUT /api/projects/:projectId/namespaces/:namespaceId */
}

export async function deleteNamespace(
  projectId: string,
  namespaceId: string,
): Promise<{ movedToDefault: number }> {
  /* DELETE */
}

export async function reorderNamespaces(
  projectId: string,
  order: Array<{ namespaceId: string; order: number }>,
): Promise<void> {
  /* PUT /reorder */
}

// Membership endpoints
export async function addMembersToNamespace(
  projectId: string,
  namespaceId: string,
  variables: Array<{ variableId: string; variableType: 'env' | 'config' }>,
): Promise<{ added: number; skipped: number }> {
  /* POST /members */
}

export async function removeMemberFromNamespace(
  projectId: string,
  namespaceId: string,
  variableId: string,
  type: 'env' | 'config',
): Promise<{ movedToDefault: boolean }> {
  /* DELETE /members/:variableId */
}
```

- [ ] **Step 3: Update environment-variables.ts API client**

Add `namespaceIds` to create/update payloads. Add `namespaceId` to list query params. Add `namespaces` to response types.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/api/namespaces.ts apps/studio/src/api/environment-variables.ts
git add apps/studio/src/api/namespaces.ts apps/studio/src/api/environment-variables.ts
git commit -m "feat(studio): add namespace and updated env var API clients"
```

---

### Task 23: Create Namespace Dropdown Component

**Files:**

- Create: `apps/studio/src/components/variables/NamespaceDropdown.tsx`

- [ ] **Step 1: Read the studio design system skill**

Invoke the `studio-design-system` skill to understand color tokens, component patterns, and animation standards.

- [ ] **Step 2: Create NamespaceDropdown component**

A dropdown (using shadcn/ui Popover + Command pattern) that:

- Shows "All Variables" at top with total count
- Lists namespaces sorted by order with counts
- Each item shows: color dot + icon + displayName + count
- Search filter within dropdown
- "Create new namespace..." at bottom
- Fires `onSelect(namespaceId | null)` callback (null = all variables)
- Selected namespace shown in trigger button

Props:

```typescript
interface NamespaceDropdownProps {
  projectId: string;
  namespaces: Namespace[];
  selectedNamespaceId: string | null;
  onSelect: (namespaceId: string | null) => void;
  totalVariableCount: number;
  onCreateNew?: () => void;
}
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/variables/NamespaceDropdown.tsx
git add apps/studio/src/components/variables/NamespaceDropdown.tsx
git commit -m "feat(studio): add NamespaceDropdown component"
```

---

### Task 24: Create Namespace Tag Popover Component

**Files:**

- Create: `apps/studio/src/components/variables/NamespaceTagPopover.tsx`

- [ ] **Step 1: Create the component**

A popover (triggered by "Tag" action button on variable rows) with:

- Checkbox list of all namespaces
- Current assignments pre-checked
- At least one must remain checked (client-side validation)
- "Create new namespace..." link at bottom
- Save button calls PUT /env-vars/:id or PATCH /config-variables/:varId with `namespaceIds`

Props:

```typescript
interface NamespaceTagPopoverProps {
  variableId: string;
  variableType: 'env' | 'config';
  projectId: string;
  namespaces: Namespace[];
  currentNamespaceIds: string[];
  onSave: (namespaceIds: string[]) => Promise<void>;
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/variables/NamespaceTagPopover.tsx
git add apps/studio/src/components/variables/NamespaceTagPopover.tsx
git commit -m "feat(studio): add NamespaceTagPopover component"
```

---

### Task 25: Create Manage Namespaces Panel

**Files:**

- Create: `apps/studio/src/components/variables/ManageNamespacesPanel.tsx`

- [ ] **Step 1: Create the component**

A slide-over panel (Sheet from shadcn/ui) with:

- Drag-to-reorder list of namespaces (use @dnd-kit or similar if available in the project)
- Each item: drag handle + name + var count + Edit/Delete buttons
- Default namespace: no edit/delete, shows "(system)" badge
- Edit inline: displayName, description, icon picker, color picker
- Delete: confirmation dialog mentioning orphan count
- "Add Namespace" button at bottom with inline form

Props:

```typescript
interface ManageNamespacesPanelProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void; // refresh parent after changes
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/variables/ManageNamespacesPanel.tsx
git add apps/studio/src/components/variables/ManageNamespacesPanel.tsx
git commit -m "feat(studio): add ManageNamespacesPanel component"
```

---

### Task 26: Integrate Namespace UI into Environment Variables Section

**Files:**

- Modify: `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx`

- [ ] **Step 1: Read EnvironmentVariablesSection.tsx**

Read `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` to understand the current structure.

- [ ] **Step 2: Add namespace dropdown to toolbar**

- Fetch namespaces on mount via `listNamespaces(projectId)`
- Add `<NamespaceDropdown>` to the toolbar area
- When a namespace is selected, pass `namespaceId` to the list API call
- Add "Manage Namespaces" button that opens `<ManageNamespacesPanel>`

- [ ] **Step 3: Add namespace tags to variable rows**

- Each variable row shows its namespace tags as small badges
- Add "Tag" action button that opens `<NamespaceTagPopover>`
- Multi-membership indicator (\*) with tooltip

- [ ] **Step 4: Update Add Variable dialog**

- Add namespace multi-select to the create variable dialog
- Pre-fill with currently selected namespace
- If "All Variables" selected, default to "Default"

- [ ] **Step 5: Build and verify**

Run: `pnpm build --filter=@abl/studio`
Expected: BUILD SUCCESS

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx
git add apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx
git commit -m "feat(studio): integrate namespace dropdown and tags into env vars section"
```

---

### Task 27: Create Deployment Snapshot View Component

**Files:**

- Create: `apps/studio/src/components/deployments/DeploymentSnapshotView.tsx`

- [ ] **Step 1: Create the component**

An expandable section in the deployment detail page showing:

- Snapshot hash and creation time
- "Compare with" dropdown (lists other deployments)
- Namespace dropdown for filtering
- Table: KEY | TYPE (env/config) | VALUE (masked/plaintext) | Reveal button
- Read-only, no edit actions
- Config var values shown directly; env var values masked with "Reveal" button

Props:

```typescript
interface DeploymentSnapshotViewProps {
  projectId: string;
  deploymentId: string;
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/deployments/DeploymentSnapshotView.tsx
git add apps/studio/src/components/deployments/DeploymentSnapshotView.tsx
git commit -m "feat(studio): add DeploymentSnapshotView component"
```

---

### Task 28: Create Deployment Diff View Component

**Files:**

- Create: `apps/studio/src/components/deployments/DeploymentDiffView.tsx`

- [ ] **Step 1: Create the component**

Triggered by "Compare with" dropdown in the snapshot view:

- Color-coded table: green (added), yellow (changed), red (removed)
- Namespace dropdown to filter the diff
- Secrets show "(secret)" -- never actual values
- Non-secret values show old -> new
- Summary line: "1 added, 2 changed, 1 removed"

Props:

```typescript
interface DeploymentDiffViewProps {
  projectId: string;
  sourceDeploymentId: string;
  targetDeploymentId: string;
}
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write apps/studio/src/components/deployments/DeploymentDiffView.tsx
git add apps/studio/src/components/deployments/DeploymentDiffView.tsx
git commit -m "feat(studio): add DeploymentDiffView component"
```

---

## Chunk 6: Project Import, Integration & Final Verification

### Task 29: Update Project Import for Namespace Support (Pre-existing Gap 12.6)

**Files:**

- Modify: `packages/project-io/src/import/` (find the import applier that handles env/config vars)

- [ ] **Step 1: Read the project import logic**

Search for where environment variables and config variables are imported/restored during project import. Look in `packages/project-io/src/import/` for files that handle `env-vars.json` and `config-vars.json`.

- [ ] **Step 2: After importing variables, create default namespace memberships**

When variables are imported:

1. Ensure the target project has a "default" namespace (create if missing)
2. For each imported env var and config var, create a `VariableNamespaceMembership` linking it to the default namespace

```typescript
import { VariableNamespace, VariableNamespaceMembership } from '@abl/database';
import { DEFAULT_NAMESPACE_NAME, DEFAULT_NAMESPACE_DISPLAY_NAME } from '@abl/compiler/platform';

// After importing variables:
let defaultNs = await VariableNamespace.findOne({
  tenantId,
  projectId,
  isDefault: true,
});
if (!defaultNs) {
  defaultNs = await VariableNamespace.create({
    tenantId,
    projectId,
    name: DEFAULT_NAMESPACE_NAME,
    displayName: DEFAULT_NAMESPACE_DISPLAY_NAME,
    isDefault: true,
    order: 0,
    createdBy: userId,
  });
}

// Create memberships for all imported variables
const memberships = [
  ...importedEnvVarIds.map((id) => ({
    tenantId,
    projectId,
    namespaceId: defaultNs._id,
    variableId: id,
    variableType: 'env' as const,
  })),
  ...importedConfigVarIds.map((id) => ({
    tenantId,
    projectId,
    namespaceId: defaultNs._id,
    variableId: id,
    variableType: 'config' as const,
  })),
];
if (memberships.length > 0) {
  await VariableNamespaceMembership.insertMany(memberships, { ordered: false });
}
```

- [ ] **Step 3: Log warning that values must be manually configured**

Add a log warning after import:

```typescript
log.warn('Imported variables with empty values -- manual configuration required', {
  projectId,
  envVarCount: importedEnvVarIds.length,
  configVarCount: importedConfigVarIds.length,
});
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter=@abl/project-io`
Expected: BUILD SUCCESS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/project-io/src/import/
git add packages/project-io/src/import/
git commit -m "feat(project-io): create default namespace memberships on project import"
```

---

### Task 30: Update Dockerfiles for New Packages (if needed)

**Files:**

- Check and potentially modify: `apps/runtime/Dockerfile`, `apps/studio/Dockerfile`

- [ ] **Step 1: Verify Dockerfiles include all referenced packages**

Check that any new packages referenced from `@abl/database` are properly included. Since we're adding models to the existing `@abl/database` package (not creating a new package), Dockerfiles should not need changes. Verify by reading the Dockerfiles.

- [ ] **Step 2: Commit if changes needed**

Only if Dockerfile changes are required:

```bash
git add apps/runtime/Dockerfile apps/studio/Dockerfile
git commit -m "chore: update Dockerfiles for new model dependencies"
```

---

### Task 31: Run Full Build and Tests

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run affected tests**

Run: `pnpm test --filter=@abl/database --filter=@abl/runtime --filter=@abl/studio --filter=@abl/compiler`
Expected: All tests pass

- [ ] **Step 3: Type check**

Run: `pnpm exec tsc --noEmit -p packages/database/tsconfig.json && pnpm exec tsc --noEmit -p apps/runtime/tsconfig.json`
Expected: No type errors

- [ ] **Step 4: Format all changed files**

```bash
npx prettier --write "packages/database/src/**/*.ts" "apps/runtime/src/**/*.ts" "apps/studio/src/**/*.{ts,tsx}"
```

- [ ] **Step 5: Final commit if needed**

```bash
git add -A
git commit -m "chore: fix any remaining type or formatting issues"
```

---

## Summary: Task Dependency Graph

```
Task 1 (Constants) ──────────────┐
Task 2 (Namespace Model) ────────┤
Task 3 (Membership Model) ───────┤──> Task 6 (Cascade Deletes)
Task 4 (Snapshot Model) ─────────┤
Task 5 (Deployment field) ───────┘

Tasks 7-10 (Bug Fixes) ──────────── Independent, can run parallel

Task 11 (Namespace Repo) ────────┐
Task 12 (Membership Repo) ───────┤──> Task 13 (Namespace Routes)
                                  ├──> Task 14 (Membership Routes)
                                  ├──> Task 15 (Update Env Var Routes)
                                  └──> Task 16 (Update Config Var Routes)

Task 4 (Snapshot Model) ─────────┐
Task 17 (Snapshot Service) ──────┤──> Task 18 (Deployment Routes + Snapshot Cascade)
                                  └──> Task 19 (Update SecretsProvider)

Task 20 (Migration Script) ──────── Depends on Tasks 2-3
Task 21 (Auto-create Default) ───── Depends on Task 2

Tasks 22-28 (UI) ────────────────── Depend on backend routes being done
Task 29 (Project Import) ───────── Depends on Tasks 2-3
Task 30-31 (Dockerfiles + Final) ── Last
```

## Key References

| File                                                                                   | Purpose                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------- |
| `docs/superpowers/specs/2026-03-12-variable-namespaces-deployment-snapshots-design.md` | Full design spec                        |
| `packages/database/src/models/environment-variable.model.ts`                           | Existing env var model pattern          |
| `packages/database/src/models/deployment.model.ts`                                     | Existing deployment model               |
| `apps/runtime/src/routes/environment-variables.ts`                                     | Router pattern to follow                |
| `apps/runtime/src/services/secrets-provider.ts`                                        | RuntimeSecretsProvider to modify        |
| `packages/database/src/cascade/cascade-delete.ts`                                      | Cascade delete registration             |
| `apps/studio/src/repos/config-variable-repo.ts`                                        | Config var repo (bug fixes)             |
| `packages/shared/src/repos/mongo-tx.ts`                                                | `withTransaction<T>(fn)` for atomic ops |
