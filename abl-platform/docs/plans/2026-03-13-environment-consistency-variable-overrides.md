# Environment Consistency & Variable Overrides Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize environment strings to `'dev' | 'staging' | 'production'`, add base+override variable resolution for env vars, and enforce one active deployment per environment.

**Architecture:** Three independent changes that share the canonical environment constant. Task 1 updates the config package (source of truth). Tasks 2-5 update Mongoose schemas. Task 6 updates route validators. Tasks 7-8 add base+override resolution. Task 9 adds one-active-deployment enforcement. Tasks 10-10b update Studio. Tasks 11-14 update tests. Task 15 is final verification.

**Tech Stack:** TypeScript, MongoDB/Mongoose, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-13-environment-consistency-variable-overrides-design.md`

---

## Chunk 1: Config Package & Database Schemas

### Task 1: Update Canonical Environment Type

**Files:**

- Modify: `packages/config/src/environment.ts` (full rewrite)
- Modify: `packages/config/src/index.ts:18-19` (add VALID_ENVIRONMENTS export)
- Test: `packages/config/src/__tests__/environment.test.ts` (full rewrite)

- [ ] **Step 1: Update environment.ts with new canonical type**

```typescript
// packages/config/src/environment.ts
/**
 * Unified Environment Type
 *
 * Canonical environment values used across the entire platform.
 */

/** Canonical environment type */
export type Environment = 'dev' | 'staging' | 'production';

/** Valid environment values for validation (Zod, Mongoose, route guards) */
export const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

/** Valid environment values including null (for base variable values) */
export const VALID_ENVIRONMENTS_NULLABLE = ['dev', 'staging', 'production', null] as const;

const ENV_ALIASES: Record<string, Environment> = {
  development: 'dev',
  dev: 'dev',
  staging: 'staging',
  stg: 'staging',
  production: 'production',
  prod: 'production',
};

/**
 * Normalize any environment string to the canonical form.
 *
 * Maps common aliases:
 * - 'development' -> 'dev'
 * - 'production' -> 'production' (identity)
 * - 'prod' -> 'production'
 * - 'stg' -> 'staging'
 *
 * Throws if the input doesn't match any known alias.
 */
export function normalizeEnvironment(raw: string | undefined): Environment {
  if (!raw) return 'dev';
  const normalized = ENV_ALIASES[raw.toLowerCase().trim()];
  if (!normalized) {
    throw new Error(
      `Unknown environment "${raw}". Valid values: ${Object.keys(ENV_ALIASES).join(', ')}`,
    );
  }
  return normalized;
}

/**
 * Check if the environment is production.
 */
export function isProduction(env: Environment): boolean {
  return env === 'production';
}

/**
 * Check if the environment is a development environment.
 */
export function isDevelopment(env: Environment): boolean {
  return env === 'dev';
}
```

- [ ] **Step 2: Update index.ts exports**

Add `VALID_ENVIRONMENTS` and `VALID_ENVIRONMENTS_NULLABLE` to the existing export line at `packages/config/src/index.ts:19`:

```typescript
// Line 18-19 becomes:
export type { Environment } from './environment.js';
export {
  VALID_ENVIRONMENTS,
  VALID_ENVIRONMENTS_NULLABLE,
  normalizeEnvironment,
  isProduction,
  isDevelopment,
} from './environment.js';
```

- [ ] **Step 3: Rewrite environment tests**

```typescript
// packages/config/src/__tests__/environment.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeEnvironment,
  isProduction,
  isDevelopment,
  VALID_ENVIRONMENTS,
} from '../environment.js';

describe('VALID_ENVIRONMENTS', () => {
  it('should contain exactly dev, staging, production', () => {
    expect(VALID_ENVIRONMENTS).toEqual(['dev', 'staging', 'production']);
  });
});

describe('normalizeEnvironment', () => {
  it('should map "development" to "dev"', () => {
    expect(normalizeEnvironment('development')).toBe('dev');
  });

  it('should map "prod" to "production"', () => {
    expect(normalizeEnvironment('prod')).toBe('production');
  });

  it('should map "production" to "production"', () => {
    expect(normalizeEnvironment('production')).toBe('production');
  });

  it('should pass through canonical values', () => {
    expect(normalizeEnvironment('dev')).toBe('dev');
    expect(normalizeEnvironment('staging')).toBe('staging');
    expect(normalizeEnvironment('production')).toBe('production');
  });

  it('should handle aliases', () => {
    expect(normalizeEnvironment('stg')).toBe('staging');
  });

  it('should be case-insensitive', () => {
    expect(normalizeEnvironment('PRODUCTION')).toBe('production');
    expect(normalizeEnvironment('Development')).toBe('dev');
  });

  it('should default to "dev" for undefined', () => {
    expect(normalizeEnvironment(undefined)).toBe('dev');
  });

  it('should throw for unknown values', () => {
    expect(() => normalizeEnvironment('invalid')).toThrow('Unknown environment');
    expect(() => normalizeEnvironment('test')).toThrow('Unknown environment');
  });
});

describe('isProduction', () => {
  it('should return true for production', () => {
    expect(isProduction('production')).toBe(true);
  });

  it('should return false for other envs', () => {
    expect(isProduction('dev')).toBe(false);
    expect(isProduction('staging')).toBe(false);
  });
});

describe('isDevelopment', () => {
  it('should return true for dev only', () => {
    expect(isDevelopment('dev')).toBe(true);
  });

  it('should return false for staging and production', () => {
    expect(isDevelopment('staging')).toBe(false);
    expect(isDevelopment('production')).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/config && pnpm test -- --run`
Expected: All tests pass

- [ ] **Step 5: Build config package**

Run: `pnpm build --filter=@agent-platform/config`
Expected: Build succeeds

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write packages/config/src/environment.ts packages/config/src/index.ts packages/config/src/__tests__/environment.test.ts
git add packages/config/src/environment.ts packages/config/src/index.ts packages/config/src/__tests__/environment.test.ts
git commit -m "$(cat <<'EOF'
feat(config): normalize canonical environments to dev|staging|production

Update Environment type from 'dev'|'staging'|'prod'|'test' to
'dev'|'staging'|'production'. Export VALID_ENVIRONMENTS constant
for shared validation across routes and models.
EOF
)"
```

---

### Task 2: Update Deployment Model Schema

**Files:**

- Modify: `packages/database/src/models/deployment.model.ts:49-53` (enum), `:87-92` (add partial unique index)

- [ ] **Step 1: Update environment enum**

At line 52, change:

```typescript
// OLD
enum: ['dev', 'staging', 'production', 'prod', 'test'],
// NEW
enum: ['dev', 'staging', 'production'],
```

- [ ] **Step 2: Add partial unique index for one-active-per-environment**

After the existing indexes (line 92), add:

```typescript
DeploymentSchema.index(
  { projectId: 1, environment: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
```

- [ ] **Step 3: Build database package**

Run: `pnpm build --filter=@agent-platform/database`
Expected: Build succeeds

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write packages/database/src/models/deployment.model.ts
git add packages/database/src/models/deployment.model.ts
git commit -m "feat(database): normalize deployment environment enum and add active-per-env unique index"
```

---

### Task 3: Update Session Model Schema

**Files:**

- Modify: `packages/database/src/models/session.model.ts:98-102` (enum)

- [ ] **Step 1: Update environment enum**

At line 101, change:

```typescript
// OLD
enum: ['dev', 'development', 'staging', 'prod', 'production', 'test'],
// NEW
enum: ['dev', 'staging', 'production'],
```

- [ ] **Step 2: Build and commit**

```bash
pnpm build --filter=@agent-platform/database
npx prettier --write packages/database/src/models/session.model.ts
git add packages/database/src/models/session.model.ts
git commit -m "feat(database): normalize session environment enum to dev|staging|production"
```

---

### Task 4: Update Environment Variable Model (Base Value Support)

**Files:**

- Modify: `packages/database/src/models/environment-variable.model.ts:23` (interface), `:42` (schema field)

- [ ] **Step 1: Update interface to allow null environment**

At line 23, change:

```typescript
// OLD
environment: string;
// NEW
environment: string | null;
```

- [ ] **Step 2: Update schema field — make nullable with enum**

At line 42, change:

```typescript
// OLD
environment: { type: String, required: true },
// NEW
environment: { type: String, default: null, enum: ['dev', 'staging', 'production', null] },
```

- [ ] **Step 3: Build and commit**

```bash
pnpm build --filter=@agent-platform/database
npx prettier --write packages/database/src/models/environment-variable.model.ts
git add packages/database/src/models/environment-variable.model.ts
git commit -m "feat(database): make environment nullable on env vars for base value support"
```

---

### Task 5: Update Deployment Variable Snapshot Model

**Files:**

- Modify: `packages/database/src/models/deployment-variable-snapshot.model.ts:83` (add enum)

- [ ] **Step 1: Add enum constraint**

At line 83, change:

```typescript
// OLD
environment: { type: String, required: true },
// NEW
environment: { type: String, required: true, enum: ['dev', 'staging', 'production'] },
```

- [ ] **Step 2: Build and commit**

```bash
pnpm build --filter=@agent-platform/database
npx prettier --write packages/database/src/models/deployment-variable-snapshot.model.ts
git add packages/database/src/models/deployment-variable-snapshot.model.ts
git commit -m "feat(database): add environment enum to deployment variable snapshot model"
```

---

## Chunk 2: Route Validators & Secrets Provider

### Task 6: Update Route Validators to Use Shared VALID_ENVIRONMENTS

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts:38-39` (remove local const), `:67` (already correct z.enum)
- Modify: `apps/runtime/src/routes/channel-connections.ts:52` (remove local const)
- Modify: `apps/runtime/src/routes/sdk-channels.ts:47` (remove local const)
- Modify: `apps/runtime/src/routes/environment-variables.ts:81` (add enum validation)

- [ ] **Step 1: Update deployments.ts**

At line 38-39, replace:

```typescript
// OLD
const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;
type Environment = (typeof VALID_ENVIRONMENTS)[number];
// NEW
import { VALID_ENVIRONMENTS, type Environment } from '@agent-platform/config';
```

Also add the import at the top of the file (near other imports). Then update all `z.enum(['dev', 'staging', 'production'])` usages to `z.enum(VALID_ENVIRONMENTS)` at lines 67 and 832.

Update any `VALID_ENVIRONMENTS.includes(environment)` checks (line 198) — these should work as-is since the type is the same.

- [ ] **Step 2: Update channel-connections.ts**

At line 52, replace:

```typescript
// OLD
const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;
// NEW (add import at top)
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
```

- [ ] **Step 3: Update sdk-channels.ts**

At line 47, replace:

```typescript
// OLD
const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;
// NEW (add import at top)
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
```

- [ ] **Step 4: Add environment validation to environment-variables.ts**

At line 81, change:

```typescript
// OLD
environment: z.string().describe('Target environment (dev, staging, production)'),
// NEW
environment: z
  .enum(['dev', 'staging', 'production'])
  .nullable()
  .default(null)
  .describe('Target environment (dev, staging, production) or null for base value'),
```

Add the import at top:

```typescript
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
```

Then use `z.enum(VALID_ENVIRONMENTS)` instead of the inline array. Also update any other environment fields in update/list schemas in the same file to use `z.enum(VALID_ENVIRONMENTS).nullable()`.

- [ ] **Step 5: Make environment optional on list route**

In the same file (`environment-variables.ts`), find the list handler (GET `/`, ~line 252). The `environment` query parameter is currently required. Make it optional so the UI can fetch all variables (base + all environments):

```typescript
// OLD
environment: z.string().describe('...'),
// NEW
environment: z.enum(VALID_ENVIRONMENTS).optional().describe('Filter by environment. Omit to list all including base.'),
```

Update the query logic to handle the optional parameter: when `environment` is omitted, query without an environment filter to return all records.

- [ ] **Step 6: Add validation to copy route**

Find the copy/bulk-upsert handler in the same file. Add validation to `sourceEnvironment` and `targetEnvironment`:

```typescript
sourceEnvironment: z.enum(VALID_ENVIRONMENTS),
targetEnvironment: z.enum(VALID_ENVIRONMENTS),
```

The copy operation should only copy environment-specific overrides (not base values with `environment: null`), since base values are already shared across all environments.

- [ ] **Step 7: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds (may need to fix type errors from the import changes)

- [ ] **Step 8: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/routes/deployments.ts apps/runtime/src/routes/channel-connections.ts apps/runtime/src/routes/sdk-channels.ts apps/runtime/src/routes/environment-variables.ts
git add apps/runtime/src/routes/deployments.ts apps/runtime/src/routes/channel-connections.ts apps/runtime/src/routes/sdk-channels.ts apps/runtime/src/routes/environment-variables.ts
git commit -m "feat(runtime): use shared VALID_ENVIRONMENTS from config, add env validation to env-vars route"
```

---

### Task 7: Add Base Fallback to RuntimeSecretsProvider

**Files:**

- Modify: `apps/runtime/src/services/secrets-provider.ts:42` (EnvVarStore interface), `:212-279` (getEnvVar)
- Modify: `apps/runtime/src/services/execution/llm-wiring.ts:219-248` (EnvVarStore implementation)

- [ ] **Step 1: Update EnvVarStore interface**

At `secrets-provider.ts` line 42, change `environment: string` to accept null:

```typescript
// OLD (line 42)
environment: string;
// NEW
environment: string | null;
```

- [ ] **Step 2: Restructure getEnvVar to add base fallback**

The current code structure at lines 233-265 is:

```typescript
try {
  const record = await this.envVarStore.findEnvVar({ ...environment: this.environment... });
  if (!record) {
    // namespace warning logic (lines 244-261)
    // return undefined (line 264)
  }
  // decrypt and return (lines 267-270)
}
```

The base fallback must go INSIDE the `if (!record)` block (line 242), BEFORE the namespace warning at line 244. The existing `return undefined` at lines 260 and 264 would otherwise prevent the base fallback from executing.

Replace lines 242-265 with:

```typescript
if (!record) {
  // Base fallback: look up record with environment: null
  const baseRecord = await this.envVarStore.findEnvVar({
    tenantId: this.tenantId,
    projectId: this.projectId,
    environment: null,
    key,
    variableNamespaceIds: this.variableNamespaceIds,
  });

  if (baseRecord) {
    const value = this.decryptor.decryptForTenant(baseRecord.encryptedValue, this.tenantId);
    this.envVarCache.set(key, value);
    log.debug('Environment variable resolved from base', { key, layer: 'envVarStore-base' });
    return value;
  }

  // Validation: if namespace filtering is active, check if the variable exists unscoped
  if (this.variableNamespaceIds && this.variableNamespaceIds.length > 0) {
    const unscopedRecord = await this.envVarStore.findEnvVar({
      tenantId: this.tenantId,
      projectId: this.projectId,
      environment: this.environment,
      key,
    });
    if (unscopedRecord) {
      log.warn("Environment variable exists but is not in any of the tool's linked namespaces", {
        key,
        tenantId: this.tenantId,
        variableNamespaceIds: this.variableNamespaceIds,
      });
      return undefined;
    }
  }
  log.warn('Environment variable not found', { key, tenantId: this.tenantId });
  return undefined;
}
```

- [ ] **Step 3: Update EnvVarStore implementation in llm-wiring.ts**

At `apps/runtime/src/services/execution/llm-wiring.ts:227-231`, the `findEnvVar` implementation queries MongoDB with `environment: params.environment`. When `params.environment` is `null`, MongoDB query `{ environment: null }` correctly matches documents where environment is null. No logic change needed — just verify the query handles null correctly.

Read the file to confirm no explicit `if (params.environment)` guard would skip the query when environment is null. If such a guard exists, remove it.

- [ ] **Step 4: Build and verify types**

Run: `npx tsc --noEmit -p apps/runtime/tsconfig.json`
Expected: No type errors

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/secrets-provider.ts apps/runtime/src/services/execution/llm-wiring.ts
git add apps/runtime/src/services/secrets-provider.ts apps/runtime/src/services/execution/llm-wiring.ts
git commit -m "feat(runtime): add base fallback (environment: null) to env var resolution"
```

---

### Task 8: Update Snapshot Service for Base+Override Resolution

**Files:**

- Modify: `apps/runtime/src/services/snapshot-service.ts:37-43` (env var query)

- [ ] **Step 1: Update env var query to include base values**

At lines 37-43, replace:

```typescript
// OLD
const envVars = await EnvironmentVariable.find({
  tenantId,
  projectId,
  environment,
})
  .select('_id key encryptedValue isSecret description')
  .lean();
```

With:

```typescript
// NEW — fetch env-specific AND base (null) variables, then deduplicate
const rawEnvVars = await EnvironmentVariable.find({
  tenantId,
  projectId,
  environment: { $in: [environment, null] },
})
  .select('_id key encryptedValue isSecret description environment')
  .lean();

// Deduplicate: environment-specific override wins over base (null)
// Note: uses `any` to match existing snapshot-service patterns (Mongoose lean() returns)
const envVarMap = new Map<string, any>();
for (const v of rawEnvVars as any[]) {
  const existing = envVarMap.get(v.key);
  if (!existing || (v.environment !== null && existing.environment === null)) {
    envVarMap.set(v.key, v);
  }
}
const envVars = [...envVarMap.values()];
```

Note: Add `environment` to the `.select()` projection so we can compare override vs base during deduplication.

- [ ] **Step 2: Build and verify types**

Run: `npx tsc --noEmit -p apps/runtime/tsconfig.json`
Expected: No type errors

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/snapshot-service.ts
git add apps/runtime/src/services/snapshot-service.ts
git commit -m "feat(runtime): snapshot service resolves base+override env vars with deduplication"
```

---

## Chunk 3: Deployment Enforcement & Studio

### Task 9: Add Retire-Previous Logic to Deployment Route

**Files:**

- Modify: `apps/runtime/src/routes/deployments.ts` (create handler, ~line 518-569)
- Modify: `apps/runtime/src/repos/deployment-repo.ts` (add retirePreviousActiveDeployment)

- [ ] **Step 1: Add retirePreviousActiveDeployment to deployment-repo.ts**

Add after `updateDeploymentStatus` (after line 106):

```typescript
/**
 * Atomically retire the current active deployment for a project+environment.
 * Returns the retired deployment (pre-update) or null if none was active.
 */
export async function retirePreviousActiveDeployment(
  projectId: string,
  tenantId: string,
  environment: string,
): Promise<Record<string, unknown> | null> {
  const { Deployment } = await import('@agent-platform/database/models');
  const doc = await Deployment.findOneAndUpdate(
    { projectId, tenantId, environment, status: 'active' },
    { $set: { status: 'retired', retiredAt: new Date() } },
    { new: false },
  ).lean();
  return doc ? parseDeploymentJson(doc) : null;
}
```

- [ ] **Step 2: Wire retire-previous into deployment creation route**

In `apps/runtime/src/routes/deployments.ts`, find the create handler (POST `/`). Before calling `createDeployment(...)`, add:

```typescript
import { retirePreviousActiveDeployment } from '../repos/deployment-repo.js';

// Inside the create handler, before createDeployment():
const previousDeployment = await retirePreviousActiveDeployment(projectId, tenantId, environment);

// Then pass previousDeploymentId to createDeployment:
// previousDeploymentId: previousDeployment?.id ?? null,
```

Also wrap the `createDeployment` call in a try/catch for E11000:

```typescript
try {
  const deployment = await createDeployment({ ... });
  // ... existing snapshot + response logic
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes('E11000')) {
    return res.status(409).json({
      success: false,
      error: 'Another deployment to this environment is already in progress. Please retry.',
    });
  }
  throw err;
}
```

- [ ] **Step 3: Add snapshot call to promote handler**

In the promote handler (~line 930-976), after the new deployment is created, add:

```typescript
import { createDeploymentSnapshot } from '../services/snapshot-service.js';

// After createDeployment in promote handler:
await createDeploymentSnapshot({
  tenantId,
  projectId,
  deploymentId: newDeployment.id,
  environment: targetEnvironment,
  createdBy: req.user.userId,
});
```

- [ ] **Step 4: Build and verify**

Run: `npx tsc --noEmit -p apps/runtime/tsconfig.json`
Expected: No type errors

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/routes/deployments.ts apps/runtime/src/repos/deployment-repo.ts
git add apps/runtime/src/routes/deployments.ts apps/runtime/src/repos/deployment-repo.ts
git commit -m "feat(runtime): enforce one active deployment per environment with retire-previous logic"
```

---

### Task 10: Update Studio Tool Test Service

**Files:**

- Modify: `apps/studio/src/services/tool-test-service.ts:205-232` (env var resolution in createSecretsProvider)

- [ ] **Step 1: Add base fallback to createSecretsProvider**

In `createSecretsProvider`, find the `EnvironmentVariable.findOne(...)` query (around line 205-232). After the exact environment query returns null, add a base fallback:

```typescript
// Inside getSecret, after the existing EnvironmentVariable.findOne({ environment }) returns null:
// Add base fallback query
if (!envVar) {
  envVar = await EnvironmentVariable.findOne({
    tenantId,
    projectId,
    environment: null,
    key,
    // ... same namespace filtering logic as above
  }).lean();
}
```

Read the file first to find the exact code structure, then apply the same two-query pattern as secrets-provider.ts.

- [ ] **Step 2: Build and verify**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`
Expected: No type errors

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/services/tool-test-service.ts
git add apps/studio/src/services/tool-test-service.ts
git commit -m "feat(studio): add base fallback to tool test service env var resolution"
```

---

### Task 10b: Update Studio Environment Variables API

**Files:**

- Modify: `apps/studio/src/api/environment-variables.ts` (interface + API calls)

- [ ] **Step 1: Update the EnvironmentVariable interface**

Find the `EnvironmentVariable` interface/type. Update the `environment` field from `string` to `string | null`:

```typescript
environment: string | null;
```

- [ ] **Step 2: Update API functions to support nullable environment**

In `fetchEnvironmentVariables`, make the `environment` parameter optional so the UI can fetch all variables:

```typescript
// Allow fetching without environment filter (returns all including base)
export async function fetchEnvironmentVariables(
  projectId: string,
  environment?: string | null,
): Promise<EnvironmentVariable[]> {
```

Update `createEnvironmentVariable` to accept `environment: string | null`.

- [ ] **Step 3: Build and commit**

```bash
npx tsc --noEmit -p apps/studio/tsconfig.json
npx prettier --write apps/studio/src/api/environment-variables.ts
git add apps/studio/src/api/environment-variables.ts
git commit -m "feat(studio): support nullable environment in env vars API client"
```

---

## Chunk 4: Tests

### Task 11: Update Existing Tests for New Environment Values

**Files:**

- Modify: `packages/database/src/__tests__/model-session.test.ts` (environment enum tests)
- Modify: `packages/database/src/__tests__/model-project.test.ts` (environment enum tests)
- Modify: `packages/database/src/__tests__/model-security.test.ts` (env var tests)
- Modify: `apps/runtime/src/__tests__/services/secrets-provider.test.ts` (environment values)
- Modify: `apps/runtime/src/__tests__/repos-data.test.ts` (environment values)
- Modify: `apps/runtime/src/__tests__/services/snapshot-service.test.ts` (environment values)

- [ ] **Step 1: Find all test files using old environment values**

Run: `grep -rn "'prod'\|'development'\|'test'" --include='*.test.ts' packages/ apps/ | grep -i environment | head -40`

This finds all test assertions referencing the old canonical values in environment context.

- [ ] **Step 2: Update each test file**

For each file found:

- Replace `'prod'` with `'production'` where it refers to an environment value
- Replace `'development'` with `'dev'` where it refers to an environment value
- Remove test cases for `'test'` environment
- Update `isProduction('prod')` assertions to `isProduction('production')`
- Update `isDevelopment('test')` assertions (remove — 'test' is no longer valid)

Be careful NOT to change `'prod'` or `'test'` when used in non-environment contexts (e.g., product names, test descriptions).

- [ ] **Step 3: Run all tests**

Run: `pnpm test --filter=@agent-platform/database -- --run && pnpm test --filter=@agent-platform/config -- --run`
Expected: All tests pass

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write <all changed test files>
git add <all changed test files>
git commit -m "test: update test files for canonical environment values dev|staging|production"
```

---

### Task 12: Add Tests for Base+Override Resolution

**Files:**

- Modify: `apps/runtime/src/__tests__/services/secrets-provider.test.ts` (add base fallback tests)

- [ ] **Step 1: Add base fallback test cases**

Add a new describe block for base+override behavior:

```typescript
describe('base + override variable resolution', () => {
  it('returns exact environment match over base', async () => {
    const envVarStore: EnvVarStore = {
      findEnvVar: async (params) => {
        if (params.environment === 'staging') {
          return { encryptedValue: 'encrypted-staging-value' };
        }
        if (params.environment === null) {
          return { encryptedValue: 'encrypted-base-value' };
        }
        return null;
      },
    };
    // ... create provider with staging environment and envVarStore
    // Assert: getEnvVar returns decrypted staging value, not base
  });

  it('falls back to base when no environment-specific override exists', async () => {
    const envVarStore: EnvVarStore = {
      findEnvVar: async (params) => {
        if (params.environment === null) {
          return { encryptedValue: 'encrypted-base-value' };
        }
        return null;
      },
    };
    // ... create provider with staging environment and envVarStore
    // Assert: getEnvVar returns decrypted base value
  });

  it('returns undefined when neither override nor base exists', async () => {
    const envVarStore: EnvVarStore = {
      findEnvVar: async () => null,
    };
    // ... create provider with staging environment and envVarStore
    // Assert: getEnvVar returns undefined
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/runtime && pnpm test -- --run -t "base + override"`
Expected: All 3 tests pass

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/__tests__/services/secrets-provider.test.ts
git add apps/runtime/src/__tests__/services/secrets-provider.test.ts
git commit -m "test(runtime): add base+override env var resolution tests"
```

---

### Task 13: Add Tests for One-Active-Deployment Constraint

**Files:**

- Modify or create test in: `apps/runtime/src/__tests__/repos-data.test.ts` or new file

- [ ] **Step 1: Add deployment retire-previous tests**

```typescript
describe('retirePreviousActiveDeployment', () => {
  it('retires existing active deployment and returns it', async () => {
    // Create an active deployment
    // Call retirePreviousActiveDeployment
    // Assert: returned deployment has original data
    // Assert: deployment in DB now has status: 'retired' and retiredAt set
  });

  it('returns null when no active deployment exists', async () => {
    // Call retirePreviousActiveDeployment for empty project
    // Assert: returns null
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/runtime && pnpm test -- --run -t "retirePrevious"`
Expected: Tests pass

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write <test file>
git add <test file>
git commit -m "test(runtime): add one-active-deployment constraint tests"
```

---

### Task 14: Add Tests for Snapshot Base+Override Merging

**Files:**

- Modify: `apps/runtime/src/__tests__/services/snapshot-service.test.ts`

- [ ] **Step 1: Add base+override snapshot tests**

```typescript
describe('createDeploymentSnapshot with base+override', () => {
  it('includes base variables when no environment override exists', async () => {
    // Create base env var (environment: null) with key API_KEY
    // Create snapshot for 'staging'
    // Assert: snapshot.envVars includes API_KEY
  });

  it('environment override wins over base for same key', async () => {
    // Create base env var (environment: null) with key API_URL, value 'base-url'
    // Create env var (environment: 'staging') with key API_URL, value 'staging-url'
    // Create snapshot for 'staging'
    // Assert: snapshot.envVars has API_URL with staging encrypted value (not base)
    // Assert: only one entry for API_URL (no duplicates)
  });

  it('merges base and override variables correctly', async () => {
    // Create base env var API_KEY (only base)
    // Create staging env var API_URL (only staging)
    // Create base env var DB_HOST + staging override DB_HOST
    // Create snapshot for 'staging'
    // Assert: snapshot has API_KEY (from base), API_URL (from staging), DB_HOST (from staging override)
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/runtime && pnpm test -- --run -t "base+override"`
Expected: Tests pass

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/__tests__/services/snapshot-service.test.ts
git add apps/runtime/src/__tests__/services/snapshot-service.test.ts
git commit -m "test(runtime): add snapshot base+override merging tests"
```

---

### Task 15: Final Verification

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Full test suite**

Run: `pnpm test -- --run`
Expected: All tests pass

- [ ] **Step 3: Grep for orphaned old values**

Run: `grep -rn "'prod'" --include='*.ts' packages/database/src/models/ apps/runtime/src/routes/ | grep -i 'enum\|environment\|VALID' | grep -v node_modules | grep -v '.test.'`
Expected: No results (all model enums and route validators updated)

- [ ] **Step 4: Run prettier on all changed files and commit if needed**

```bash
npx prettier --write $(git diff --name-only HEAD~15 -- '*.ts')
```
