# Environment Consistency & Variable Overrides Design Spec

**Date:** 2026-03-13
**Status:** Draft
**Scope:** Normalize environment strings, base+override variable resolution, one-active-deployment-per-environment

---

## 1. Problem Statement

The platform has inconsistent environment naming across models, routes, and validators:

| Location                                 | Current Values                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `deployment.model.ts`                    | `['dev', 'staging', 'production', 'prod', 'test']`                |
| `session.model.ts`                       | `['dev', 'development', 'staging', 'prod', 'production', 'test']` |
| `sdk-channel.model.ts`                   | `['dev', 'staging', 'production', null]`                          |
| Route validators (deployments, channels) | `['dev', 'staging', 'production']`                                |
| `packages/config/environment.ts`         | `'dev' \| 'staging' \| 'prod' \| 'test'`                          |
| `environment-variable.model.ts`          | No enum constraint at all                                         |

Additionally:

- Environment variables have no base/default value concept — users must duplicate values across every environment
- Multiple active deployments can exist for the same project+environment with no enforcement
- No backward compatibility concerns — clean cut to new canonical values

## 2. Design Decisions

| Decision               | Choice                                                   | Rationale                                                                                                             |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Canonical environments | `'dev' \| 'staging' \| 'production'`                     | Readable, matches industry convention (Vercel, AWS, etc.). Deliberate change from current `'prod'` to `'production'`. |
| Variable inheritance   | Base + override for env vars only (not config vars)      | Simple mental model, extensible to dynamic envs later. Config vars are project-global (no environment dimension).     |
| Deployment constraint  | One active per project+environment                       | Clean "what's deployed to staging?" answer, DB-enforced                                                               |
| Backward compatibility | None                                                     | Clean cut — update existing documents directly, no migration scripts                                                  |
| Concurrency safety     | `findOneAndUpdate` + partial unique index + E11000 retry | Atomic retire + DB constraint as safety net                                                                           |

## 3. Environment String Normalization

### 3.1 Canonical Type

`packages/config/src/environment.ts` becomes the single source of truth:

```typescript
export type Environment = 'dev' | 'staging' | 'production';

export const VALID_ENVIRONMENTS = ['dev', 'staging', 'production'] as const;

/** Environments that allow null (for variable base values) */
export const VALID_ENVIRONMENTS_NULLABLE = ['dev', 'staging', 'production', null] as const;

const ENV_ALIASES: Record<string, Environment> = {
  development: 'dev',
  dev: 'dev',
  staging: 'staging',
  stg: 'staging',
  production: 'production',
  prod: 'production',
};

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

export function isProduction(env: Environment): boolean {
  return env === 'production';
}

export function isDevelopment(env: Environment): boolean {
  return env === 'dev';
}
```

**Breaking changes from current code:**

- `'prod'` is no longer a canonical value — it aliases to `'production'`
- `'test'` is removed entirely (test environment is a runtime/CI concept, not a deployment target)
- `isDevelopment()` no longer returns `true` for `'test'`
- `isProduction()` checks `=== 'production'` instead of `=== 'prod'`

**Call sites to update for `isProduction` / `isDevelopment`:** Search all imports of these functions and verify behavior is preserved.

### 3.2 Mongoose Schema Updates

All models normalize to the same enum:

**`deployment.model.ts`:**

```typescript
environment: {
  type: String,
  required: true,
  enum: ['dev', 'staging', 'production'],
}
```

**`session.model.ts`:**

```typescript
environment: {
  type: String,
  enum: ['dev', 'staging', 'production'],
}
```

**`sdk-channel.model.ts`:** Already uses `['dev', 'staging', 'production', null]` — no change needed.

**`environment-variable.model.ts`** (new constraint + nullable):

```typescript
environment: {
  type: String,
  default: null,
  enum: ['dev', 'staging', 'production', null],  // null = base value
}
```

Note: `environment` changes from `required: true` to `default: null`. The existing unique index `(tenantId, projectId, environment, key)` is unchanged — MongoDB treats `null` as a distinct value in unique indexes.

**`deployment-variable-snapshot.model.ts`** (new constraint):

```typescript
environment: {
  type: String,
  required: true,
  enum: ['dev', 'staging', 'production'],
}
```

**`project-config-variable.model.ts`:** No changes — config vars have no `environment` field and remain project-global.

### 3.3 Route Validator Updates

Replace all local `VALID_ENVIRONMENTS` arrays with the shared import:

```typescript
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
```

**Files to update:**

- `apps/runtime/src/routes/deployments.ts` — Remove local `VALID_ENVIRONMENTS` and `Environment` type, import from config. Update Zod schemas to `z.enum(VALID_ENVIRONMENTS)`.
- `apps/runtime/src/routes/channel-connections.ts` — Same pattern.
- `apps/runtime/src/routes/sdk-channels.ts` — Same pattern.
- `apps/runtime/src/routes/environment-variables.ts` — **Add** `z.enum(VALID_ENVIRONMENTS).nullable().default(null)` validation (currently has no validation at all on the environment field).

### 3.4 Runtime Service Updates

**`secrets-provider.ts`:**

- Default environment stays `'dev'` (line 134) — no change needed
- `environment` field type remains `string` internally (accepts canonical values)

**`packages/compiler/src/platform/constants.ts`:**

- Update any environment references to use canonical values

### 3.5 Config Package Export

**`packages/config/src/index.ts`** must re-export:

```typescript
export {
  VALID_ENVIRONMENTS,
  VALID_ENVIRONMENTS_NULLABLE,
  normalizeEnvironment,
  isProduction,
  isDevelopment,
} from './environment.js';
export type { Environment } from './environment.js';
```

## 4. Base + Override Variable Resolution

### 4.1 Concept

**Applies to environment variables only.** Config variables (`ProjectConfigVariable`) are project-global with no environment dimension — they remain unchanged.

Environment variables can exist at two levels:

- **Base** (`environment: null`): Default value used when no environment-specific override exists
- **Override** (`environment: 'dev' | 'staging' | 'production'`): Environment-specific value that takes precedence

### 4.2 Resolution Order

When resolving an environment variable for environment `E`:

1. **Exact match:** Find record with `key=K, environment=E`
2. **Base fallback:** Find record with `key=K, environment=null`
3. **Not found:** Continue to next resolution layer (config vars, IR credentials, process.env)

Config variable resolution is unchanged — single lookup by `(tenantId, projectId, key)` with namespace scoping.

### 4.3 Schema Changes

**`EnvironmentVariable` model only:**

- `environment` field changes from `required: true` to `default: null`
- Enum: `['dev', 'staging', 'production', null]`
- Unique index: `(tenantId, projectId, environment, key)` — unchanged, `null` is a distinct value in MongoDB

**`ProjectConfigVariable` model:** No changes. Config vars have no `environment` field.

### 4.4 RuntimeSecretsProvider Changes

**`getEnvVar(key)` updated resolution:**

```typescript
async getEnvVar(key: string): Promise<string | undefined> {
  // ... existing cache check ...

  // ... existing snapshot check (snapshots are pre-resolved, no base fallback needed) ...

  if (!this.envVarStore || !this.decryptor || !this.tenantId || !this.projectId) {
    return undefined;
  }

  // 1. Exact environment match
  const exactRecord = await this.envVarStore.findEnvVar({
    tenantId: this.tenantId,
    projectId: this.projectId,
    environment: this.environment,
    key,
    variableNamespaceIds: this.variableNamespaceIds,
  });

  if (exactRecord) {
    const value = this.decryptor.decryptForTenant(exactRecord.encryptedValue, this.tenantId);
    this.envVarCache.set(key, value);
    return value;
  }

  // 2. Base fallback (environment: null)
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
    return value;
  }

  // ... existing namespace-scoped warning logic ...

  return undefined;
}
```

**`resolveFromConfigVarStore(key)` — unchanged.** Config vars have no environment dimension. The existing single-query lookup remains as-is.

### 4.5 EnvVarStore Interface Update

```typescript
export interface EnvVarStore {
  findEnvVar(params: {
    tenantId: string;
    projectId: string;
    environment: string | null; // null = base lookup
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ encryptedValue: string } | null>;
}
```

**Implementation file:** The `EnvVarStore` is implemented in the repo layer (likely `security-repo.ts` or inline in the route/service that constructs the provider). The implementation must handle `environment: null` in the MongoDB query — `{ environment: null }` matches documents where the field is `null`.

### 4.6 Snapshot Behavior

When creating a deployment snapshot for environment `E`, the snapshot service must resolve base+override:

```typescript
// 1. Fetch all env vars for this project in environment E or base (null)
const envVars = await EnvironmentVariable.find({
  tenantId,
  projectId,
  environment: { $in: [environment, null] },
})
  .select('key encryptedValue environment isSecret description')
  .lean();

// 2. Deduplicate: environment-specific override wins over base
const envVarMap = new Map<string, (typeof envVars)[0]>();
for (const v of envVars) {
  const existing = envVarMap.get(v.key);
  if (!existing || (v.environment !== null && existing.environment === null)) {
    envVarMap.set(v.key, v);
  }
}

// 3. Store resolved set in snapshot
const resolvedEnvVars = [...envVarMap.values()];
```

This ensures snapshots are self-contained — no base fallback needed at runtime for deployed agents. The snapshot stores the final resolved values.

**Namespace scoping in snapshots:** Snapshots intentionally capture ALL variables for the project+environment regardless of namespace. Namespace filtering happens at runtime resolution time (via `variableNamespaceIds` on the per-tool scoped provider), not at snapshot creation time. This ensures the snapshot is complete and namespace assignment changes after deployment don't break running agents.

**Config vars in snapshots:** Config vars have no environment dimension. The snapshot captures all config vars for the project (unchanged from current behavior).

### 4.7 Route Changes

**Environment variables CRUD** (`environment-variables.ts`):

```typescript
// Create — environment is now nullable
const createSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  environment: z.enum(['dev', 'staging', 'production']).nullable().default(null),
  // ... other fields
});

// List — support fetching by key across environments
// GET /api/projects/:projectId/env-vars?environment=dev       (existing: list for env)
// GET /api/projects/:projectId/env-vars?key=API_URL           (new: all values for a key)
// GET /api/projects/:projectId/env-vars                       (new: all vars including base)
```

The existing `environment` query parameter on the list route currently requires a value. It should become optional — when omitted, return all variables (base + all environments).

**Copy environment variables** — adds validation and clarified semantics:

```typescript
sourceEnvironment: z.enum(['dev', 'staging', 'production']),
targetEnvironment: z.enum(['dev', 'staging', 'production']),
```

Copy only copies environment-specific overrides (not base values, since base is already shared).

## 5. One Active Deployment Per Environment

### 5.1 Constraint

At most one deployment with `status: 'active'` can exist per `(projectId, environment)`.

### 5.2 Partial Unique Index

```typescript
DeploymentSchema.index(
  { projectId: 1, environment: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
```

This is a MongoDB partial unique index — it only enforces uniqueness for documents where `status = 'active'`. Retired/draining deployments are not constrained.

### 5.3 Deployment Creation Flow — Concurrency Safe

The retire-previous + create-new flow must handle concurrent deploy requests. Strategy: **atomic `findOneAndUpdate` + partial unique index + E11000 retry**.

```typescript
async function createDeployment(params: CreateDeploymentParams) {
  // 1. Atomically find and retire existing active deployment
  const previous = await Deployment.findOneAndUpdate(
    { projectId: params.projectId, environment: params.environment, status: 'active' },
    { $set: { status: 'retired', retiredAt: new Date() } },
    { new: false }, // return the pre-update document
  );

  // 2. Create new deployment — partial unique index prevents duplicates
  try {
    const deployment = await Deployment.create({
      ...params,
      status: 'active',
      previousDeploymentId: previous?._id ?? null,
    });

    // 3. Capture variable snapshot (base+override resolved)
    await createDeploymentSnapshot(deployment);

    return deployment;
  } catch (err: unknown) {
    // E11000 = another concurrent deploy won the race
    if (err instanceof Error && err.message.includes('E11000')) {
      throw new ConflictError(
        `Another deployment to ${params.environment} is already in progress. Please retry.`,
      );
    }
    throw err;
  }
}
```

**Race condition analysis:**

- Two concurrent deploys to `staging`: both call `findOneAndUpdate` — only one finds the active deployment, the other gets `null` (already retired). Both try to create — the partial unique index ensures only one succeeds. The loser gets `E11000` and returns a conflict error.
- The retired deployment is never "orphaned" — it was legitimately retired by the winner.

### 5.4 Promotion Flow

Promoting from environment A to environment B:

1. Validate source deployment exists and is active
2. Validate `targetEnvironment !== sourceDeployment.environment`
3. Set previous active deployment in target environment to `'draining'` status (same atomic `findOneAndUpdate` pattern as 5.3, but using `status: 'draining'` to allow graceful traffic drain before full retirement)
4. Create new deployment in target environment with `promotedFromDeploymentId` linking to source
5. **Capture fresh variable snapshot for target environment** (uses target env's base+override variables, not source's)

**Note on status semantics:** Direct deploys use `status: 'retired'` (immediate cutover). Promotions use `status: 'draining'` (graceful drain period before retirement). The current promote handler already uses `'draining'` — preserve this distinction.

**Note:** The current promote handler (`deployments.ts` ~line 930) does not call `createDeploymentSnapshot`. This is a pre-existing bug that should be fixed as part of this work.

### 5.5 Endpoint Slug Uniqueness

The deployment model has a unique index on `endpointSlug`. When redeploying to the same environment, the new deployment needs a unique slug. The existing `generateEndpointSlug()` function should include a timestamp or random suffix to avoid collisions with the retired deployment's slug.

### 5.6 SDK Channel Resolution

`sdk-init.ts` queries `findActiveDeployment(projectId, tenantId, environment)` — with the partial unique constraint, this always returns 0 or 1 result. No ambiguity.

## 6. Practical Usage Flows

### Flow 1: Setting Up Variables

1. User creates base variable: `API_KEY` with `environment: null` — shared across all environments
2. User creates dev override: `API_URL=https://sandbox.api.com` with `environment: 'dev'`
3. User creates production override: `API_URL=https://api.com` with `environment: 'production'`
4. Staging has no `API_URL` override — falls back to base. If no base exists, undefined.

### Flow 2: Deploying to Staging

1. User clicks "Deploy to staging"
2. System atomically retires any existing active staging deployment
3. New deployment created with `environment: 'staging'`, `status: 'active'`
4. Snapshot captures: staging-specific vars + base fallbacks (resolved, flattened into snapshot)
5. SDK channels with `environment: 'staging'` automatically route to this deployment

### Flow 3: Agent Execution

1. SDK init resolves channel -> finds the single active staging deployment
2. Session created with `environment: 'staging'`
3. `RuntimeSecretsProvider` built with `environment: 'staging'`
4. Tool requests `API_URL`:
   - Check staging override -> not found
   - Check base -> found `https://default.api.com` -> return
5. Tool requests `API_KEY`:
   - Check staging override -> not found
   - Check base -> found -> return

### Flow 4: Promoting Staging to Production

1. User clicks "Promote to production"
2. System atomically retires current active production deployment
3. New production deployment created with `promotedFromDeploymentId` = staging deployment ID
4. Fresh snapshot captured with production-specific + base variables (not staging's snapshot)
5. Production SDK channels route to new deployment

### Flow 5: Studio Tool Testing

1. User selects environment from dropdown: dev / staging / production
2. `tool-test-service.ts` creates secrets provider with selected environment
3. Resolution: env-specific override -> base fallback -> process.env

### Flow 6: Copying Variables Between Environments

1. User has dev overrides for 10 variables, wants same values in staging
2. Clicks "Copy dev -> staging"
3. System copies only the `environment: 'dev'` records as `environment: 'staging'` records
4. Base values are NOT copied (they're already shared)
5. If staging already has overrides for some keys, user is prompted to overwrite or skip

## 7. Files to Modify

### Config Package

- `packages/config/src/environment.ts` — New canonical type, VALID_ENVIRONMENTS export, updated aliases
- `packages/config/src/index.ts` — Re-export VALID_ENVIRONMENTS, Environment type, and utility functions

### Database Models

- `packages/database/src/models/deployment.model.ts` — Enum update to `['dev', 'staging', 'production']`, add partial unique index on `(projectId, environment)` where `status: 'active'`
- `packages/database/src/models/session.model.ts` — Enum update to `['dev', 'staging', 'production']`
- `packages/database/src/models/sdk-channel.model.ts` — Already correct, no change
- `packages/database/src/models/environment-variable.model.ts` — Add enum `['dev', 'staging', 'production', null]`, change `required: true` to `default: null`
- `packages/database/src/models/deployment-variable-snapshot.model.ts` — Add enum `['dev', 'staging', 'production']`

### Runtime Routes

- `apps/runtime/src/routes/deployments.ts` — Import shared VALID_ENVIRONMENTS, add retire-previous logic with E11000 handling, add snapshot call to promote handler
- `apps/runtime/src/routes/channel-connections.ts` — Import shared VALID_ENVIRONMENTS
- `apps/runtime/src/routes/sdk-channels.ts` — Import shared VALID_ENVIRONMENTS
- `apps/runtime/src/routes/environment-variables.ts` — Add `z.enum(VALID_ENVIRONMENTS).nullable()` validation, make list route environment-optional

### Runtime Services

- `apps/runtime/src/services/secrets-provider.ts` — Add base fallback (`environment: null`) in `getEnvVar()`. Update `EnvVarStore` interface to accept `environment: string | null`. `resolveFromConfigVarStore()` unchanged.
- `apps/runtime/src/services/snapshot-service.ts` — Query `environment: { $in: [env, null] }`, deduplicate with override-wins-over-base logic
- `apps/runtime/src/repos/deployment-repo.ts` — Add retirePreviousDeployment() helper or inline in route

### Runtime Repos (EnvVarStore Implementation)

- `apps/runtime/src/repos/security-repo.ts` (or wherever `EnvVarStore` is implemented) — Handle `environment: null` in MongoDB query

### Studio

- `apps/studio/src/services/tool-test-service.ts` — Add base fallback in `createSecretsProvider()` (two-query pattern: exact env then null)
- `apps/studio/src/api/environment-variables.ts` — Add environment validation, support nullable
- `apps/studio/src/components/deployments/EnvironmentVariablesSection.tsx` — UI for base + override display

### Tests

- Update test files referencing old environment values (`'prod'`, `'development'`, `'test'`):
  - `packages/config/src/__tests__/environment.test.ts` — All assertions for `normalizeEnvironment`, `isProduction`, `isDevelopment` will break
  - `packages/database/src/__tests__/model-session.test.ts`
  - `packages/database/src/__tests__/model-project.test.ts`
  - `apps/runtime/src/__tests__/services/secrets-provider.test.ts`
  - `apps/runtime/src/__tests__/repos-data.test.ts`
  - `apps/runtime/src/__tests__/services/snapshot-service.test.ts`
  - Any other test files found via grep for `'prod'`, `'development'`, `'test'` in enum/environment context
- Add tests for base fallback resolution (exact match wins, base used when no override, undefined when neither)
- Add tests for one-active-deployment constraint (retire previous, E11000 on race)
- Add tests for snapshot base+override merging (override wins, base fills gaps)

## 8. Future Extensibility

This design extends naturally to dynamic environments:

- `environment` field is stored as `String` — enum validation can be relaxed
- `VALID_ENVIRONMENTS` array can become DB-backed (per-project environments collection)
- Base + override pattern works for any environment name — add `'qa'` and it inherits base values automatically
- Partial unique index works for any environment string
- No structural changes needed — just remove the enum restriction and add a project-level environments collection
