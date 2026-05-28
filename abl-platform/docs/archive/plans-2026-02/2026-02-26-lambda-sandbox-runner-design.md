# Lambda Sandbox Runner — Design Document

**Date:** 2026-02-26
**Status:** Approved
**Branch:** tools-enhancements

## Problem

The platform needs code execution backends that can switch between gVisor (Kubernetes pods) and AWS Lambda. Lambda provides per-tenant isolation, AWS-native scaling, and an alternative when gVisor pods are unavailable. Each tenant gets its own runner Lambda, deployed on-demand when a sandbox tool is first saved in Studio.

## Decisions

| Decision           | Choice                                         | Rationale                                                                    |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Lambda model       | Runner Lambda (code as payload)                | No deploy step per tool invocation; symmetric with gVisor's inline execution |
| Runtimes           | JavaScript + Python                            | Match existing gVisor sandbox support                                        |
| Backend switch     | Platform-level env var (`SANDBOX_BACKEND`)     | Single config controls all sandbox tools globally                            |
| Infrastructure     | AWS SDK directly (follows AgenticAI pattern)   | Self-contained deployment, no external service dependency                    |
| State API          | Include MemoryManager                          | Parity with AgenticAI's memory API integration                               |
| Deploy trigger     | Studio at tool save (proactive)                | Lambda is ready before first execution                                       |
| Deployment state   | `LambdaDeploymentStore` interface, Redis first | Extensible to MongoDB later for admin dashboards                             |
| Execution contract | Strict read-only lookup                        | Runtime never deploys; fails fast with structured errors                     |

## Architecture

### Strategy Pattern on SandboxRunner

```
                    ToolBindingExecutor
                          │
                    SandboxToolExecutor
                          │
                   SandboxRunner (interface)
                   ┌──────┴──────┐
                   │             │
          GvisorSandboxRunner   LambdaSandboxRunner
          (existing)            (new)
                   │             │
          gVisor K8s pods       AWS Lambda (per-tenant)
          via HTTP POST         via InvokeCommand
```

**No changes to:** `SandboxRunner` interface, `SandboxToolExecutor`, `ToolBindingExecutor`, IR schema, DSL, compiler.

**Changes to:** `llm-wiring.ts` — replace direct `GvisorSandboxRunner` construction with factory call.

### Per-Tenant Lambda Deployment

```
Studio (write path)                  Runtime (read path)
─────────────────                    ───────────────────
Save sandbox tool                    LambdaSandboxRunner.run()
  → ensureRunnerDeployed()             → store.get(tenantId, runtime)
  → deploy if missing                  → MUST be status === 'active'
  → poll until active                  → health check if stale
  → update store                       → invoke Lambda
                                       → FAIL if not active (never deploy)
```

### Deployment State Machine

```
              Studio saves sandbox tool
                        │
                        ▼
            ┌─── Check Store ───┐
            │                   │
       exists + active     not found / failed
            │                   │
            ▼                   ▼
       (no action)      Trigger async deploy
                                │
                        ┌───────┴────────┐
                        ▼                ▼
                  ZIP handler        Create Lambda
                  template           via AWS SDK
                        │                │
                        └───────┬────────┘
                                ▼
                       Poll for Active state
                                │
                        ┌───────┴────────┐
                        ▼                ▼
                    Active            Failed
                        │                │
                  Update store      Update store
                  status=active     status=failed
```

## Extensible Deployment State Store

```
LambdaDeploymentService
        │
LambdaDeploymentStore (interface)
        │
  ┌─────┴──────┐
  │            │
RedisLambda   MongoLambda
DeployStore   DeployStore
(now)         (later)
```

### Interface

```typescript
interface LambdaDeploymentRecord {
  tenantId: string;
  runtime: 'javascript' | 'python';
  functionName: string;
  status: 'deploying' | 'active' | 'failed' | 'deleting';
  region: string;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

interface LambdaDeploymentStore {
  get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null>;
  upsert(record: LambdaDeploymentRecord): Promise<void>;
  updateStatus(
    tenantId: string,
    runtime: string,
    status: string,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void>;
  delete(tenantId: string, runtime: string): Promise<void>;
  listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]>;
}
```

### Redis Implementation (Now)

- Key: `lambda:runner:{tenantId}:{runtime}`
- Value: JSON-serialized `LambdaDeploymentRecord`
- No TTL (persistent until explicitly deleted)

### MongoDB Implementation (Later)

- Collection: `lambda_deployments`
- Unique compound index: `{ tenantId: 1, runtime: 1 }`
- Adds querying: list all deployments, filter by status, admin dashboards, bulk operations

## Lambda Runner Execution Flow

### Invocation Payload

```typescript
{
  runtime: 'javascript' | 'python',
  code: string,                       // user code from IR (code_content)
  params: Record<string, unknown>,    // tool input params
  functionName: string,               // tool name (for logging)
  context: {
    accessToken: string,              // JWT for memory API auth
    executionMode: 'execute' | 'simulate',
    mockMemoryData: object,
    blockDangerousModules: true,
    memoryApiBaseUrl: string,
  }
}
```

### Response Structure (matches gVisor)

```typescript
{
  statusCode: 200 | 500,
  body: {
    response: unknown,   // execution result
    logs: string[],      // captured console/print output
    error?: string       // error message if failed
  }
}
```

### Flow

```
LambdaSandboxRunner.run()
  ├─ Validate code_content (size, null bytes)
  ├─ Strict deployment lookup (see contract below)
  ├─ Preprocess params ($ prefix for JS, passthrough for Python)
  ├─ Generate JWT token (same signer as gVisor)
  ├─ Build InvokeCommand payload with code + params + context
  ├─ Invoke Lambda via AWS SDK (with timeout from limits)
  ├─ Parse response
  │   ├─ Check statusCode
  │   ├─ Extract body.response, body.logs, body.error
  │   └─ Handle [Error] prefix (same as gVisor)
  └─ Return result
```

## Strict Execution Contract

The runtime is a **read-only consumer** of deployment state. It never deploys, redeploys, or self-heals.

```typescript
async run(config: RunConfig): Promise<unknown> {
  // 1. tenantId is required
  const tenantId = this.sessionContext?.tenantId;
  if (!tenantId) {
    throw ToolExecutionError({ code: 'TOOL_SANDBOX_ERROR', retryable: false });
  }

  // 2. Strict lookup — deployment MUST exist and be active
  const deployment = await this.deploymentStore.get(tenantId, config.runtime);

  if (!deployment)
    throw ToolExecutionError({ code: 'TOOL_SANDBOX_NOT_DEPLOYED', retryable: false });

  if (deployment.status === 'deploying')
    throw ToolExecutionError({ code: 'TOOL_SANDBOX_DEPLOYING', retryable: true });

  if (deployment.status === 'failed')
    throw ToolExecutionError({ code: 'TOOL_SANDBOX_DEPLOY_FAILED', retryable: false });

  if (deployment.status !== 'active')
    throw ToolExecutionError({ code: 'TOOL_SANDBOX_ERROR', retryable: false });

  // 3. Health check if stale
  if (isHealthCheckStale(deployment)) {
    const healthy = await this.healthCheck(deployment);
    if (!healthy)
      throw ToolExecutionError({ code: 'TOOL_SANDBOX_UNHEALTHY', retryable: false });
  }

  // 4. Invoke (only reached if active + healthy)
  return this.invokeLambda(deployment, config);
}
```

### Error Codes

| Code                         | When                               | Retryable | User Action            |
| ---------------------------- | ---------------------------------- | --------- | ---------------------- |
| `TOOL_SANDBOX_NOT_DEPLOYED`  | No deployment record               | No        | Deploy via Studio      |
| `TOOL_SANDBOX_DEPLOYING`     | Deployment in progress             | Yes       | Retry in a few seconds |
| `TOOL_SANDBOX_DEPLOY_FAILED` | Deployment failed                  | No        | Check reason, redeploy |
| `TOOL_SANDBOX_UNHEALTHY`     | Health check failed                | No        | Redeploy via Studio    |
| `TOOL_SANDBOX_ERROR`         | Unexpected state, missing tenantId | No        | Check configuration    |
| `TOOL_TIMEOUT`               | Lambda invocation timed out        | Depends   | Check tool code/limits |

### What the Runtime NEVER Does

- Deploy a Lambda function
- Trigger redeployment
- Fall back to gVisor if Lambda is missing
- Return stub/mock responses on deployment failure
- Silently swallow deployment errors

## Handler Templates & Security

### JavaScript Runner Lambda

Handler receives payload → extracts code + params + context
→ creates MemoryManager(context.accessToken, context.memoryApiBaseUrl)
→ sets global.memory = memoryManager
→ blocks fs module via Proxy
→ overrides console.\* to capture logs
→ wraps user code in async execute function
→ returns { response, logs, error }

### Python Runner Lambda

Handler receives payload → extracts code + params + context
→ creates MemoryManager or MockMemoryManager based on executionMode
→ applies AST validation (blocked imports, calls, attributes)
→ applies import hooking (\_\_safe_import)
→ wraps user code in user_function()
→ executes with restricted builtins + memory + env globals
→ captures stdout
→ returns { response, logs, error }

Templates ported from AgenticAI `lambda.constants.ts`, adapted:

- Memory API URL is configurable (passed in context, not hardcoded)
- Handler reads code from invocation payload (not deployed files)
- Response shape uses `response` field (matches gVisor pod response)

## Wiring

### Factory

```typescript
function createSandboxRunner(
  backend: 'gvisor' | 'lambda',
  config: {
    gvisor: GvisorSandboxConfig;
    lambda: LambdaSandboxConfig;
    deploymentStore?: LambdaDeploymentStore;
  },
  sessionContext: GvisorSessionContext,
  jwtSigner?: JwtSigner,
): SandboxRunner {
  if (backend === 'gvisor')
    return new GvisorSandboxRunner(config.gvisor, sessionContext, jwtSigner);

  if (backend === 'lambda') {
    if (!config.deploymentStore)
      throw new Error('LambdaDeploymentStore required when SANDBOX_BACKEND=lambda');
    return new LambdaSandboxRunner(
      config.lambda,
      config.deploymentStore,
      sessionContext,
      jwtSigner,
    );
  }

  throw new Error(`Unknown SANDBOX_BACKEND: "${backend}"`);
}
```

### LambdaSandboxRunner Constructor (Strict)

```typescript
class LambdaSandboxRunner implements SandboxRunner {
  constructor(
    private config: LambdaSandboxConfig,
    private deploymentStore: LambdaDeploymentStore,  // required, not optional
    private sessionContext?: GvisorSessionContext,
    private jwtSigner?: JwtSigner,
  )
}
```

### llm-wiring.ts Changes

Replace direct `GvisorSandboxRunner` construction with:

```typescript
const sandboxBackend = process.env.SANDBOX_BACKEND || 'gvisor';
let deploymentStore: LambdaDeploymentStore | undefined;
if (sandboxBackend === 'lambda') {
  deploymentStore = new RedisLambdaDeploymentStore(getRedisClient());
}
sandboxRunner = createSandboxRunner(
  sandboxBackend,
  { gvisor: gvisorConfig, lambda: lambdaConfig, deploymentStore },
  sessionContext,
  sandboxJwtSigner,
);
```

## Function Naming & Isolation

**Naming:** `abl-runner-{sanitized_tenantId}-{runtime}`

- `abl-runner-tenant_abc123-js` — Node.js runner for tenant tenant_abc123
- `abl-runner-tenant_abc123-py` — Python runner for tenant tenant_abc123

**Why per-tenant:**

- Tenant isolation: one tenant's throttling/errors don't affect another
- AWS limits: per-function concurrency limits isolate blast radius
- Cost tracking: CloudWatch metrics per function → per-tenant cost attribution
- Matches platform architecture: `tenantId` is the universal isolation boundary

## Environment Variables

| Variable                          | Default     | Description                           |
| --------------------------------- | ----------- | ------------------------------------- |
| `SANDBOX_BACKEND`                 | `gvisor`    | `gvisor` or `lambda`                  |
| `LAMBDA_RUNNER_REGION`            | `us-east-1` | AWS region                            |
| `LAMBDA_RUNNER_ROLE_ARN`          | —           | IAM execution role ARN                |
| `LAMBDA_RUNNER_MEMORY_MB`         | `256`       | Lambda memory allocation              |
| `LAMBDA_RUNNER_TIMEOUT_SEC`       | `120`       | Lambda max execution time             |
| `LAMBDA_RUNNER_NODE_LAYER_ARN`    | —           | Lambda layer ARN for Node.js deps     |
| `LAMBDA_RUNNER_PYTHON_LAYER_ARN`  | —           | Lambda layer ARN for Python deps      |
| `LAMBDA_RUNNER_MEMORY_API_URL`    | —           | Memory API base URL for MemoryManager |
| `LAMBDA_RUNNER_HEALTH_TTL_MS`     | `300000`    | Health check cache TTL (5 min)        |
| `LAMBDA_RUNNER_DEPLOY_TIMEOUT_MS` | `60000`     | Max wait for deployment               |

## File Summary

| File                                                                              | Action     | Description                                                      |
| --------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/executors/lambda-sandbox-runner.ts`    | **New**    | `LambdaSandboxRunner` — invokes per-tenant runner Lambda         |
| `packages/compiler/src/platform/constructs/executors/lambda-handler-templates.ts` | **New**    | JS/Python handler templates + MemoryManager                      |
| `packages/compiler/src/platform/constructs/executors/sandbox-runner-factory.ts`   | **New**    | Factory: `createSandboxRunner(backend, ...)`                     |
| `apps/runtime/src/services/lambda/lambda-deployment-store.ts`                     | **New**    | `LambdaDeploymentStore` interface + `RedisLambdaDeploymentStore` |
| `apps/runtime/src/services/lambda/lambda-deployment-service.ts`                   | **New**    | Deploy/check/delete per-tenant runners via AWS SDK               |
| `apps/runtime/src/services/lambda/lambda-code-packager.ts`                        | **New**    | ZIP packaging for runner Lambda (JSZip)                          |
| `apps/studio/src/app/api/.../tools/route.ts`                                      | **Edit**   | Fire async `ensureRunnerDeployed` on sandbox tool save           |
| `apps/runtime/src/services/execution/llm-wiring.ts`                               | **Edit**   | Replace direct `GvisorSandboxRunner` with factory                |
| `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts`     | **Delete** | Remove deprecated stub                                           |
| Test files                                                                        | **New**    | Unit tests for all new modules                                   |

## Testing Strategy

1. **`LambdaSandboxRunner` unit tests** — mock AWS SDK + deployment store:
   - Strict lookup: not found → error, deploying → retryable error, failed → error, active → invoke
   - Correct payload construction (code, params, context)
   - JS params get $ prefix, Python passthrough
   - Response parsing (success, error, timeout)
   - Code size validation, JWT inclusion

2. **`LambdaDeploymentStore` unit tests** — mock Redis:
   - get/upsert/updateStatus/delete/listByTenant
   - Missing keys return null

3. **`LambdaDeploymentService` unit tests** — mock AWS SDK + store:
   - Deploy flow: set deploying → create function → poll active → set active
   - Already active → no-op
   - Failure → set failed with reason

4. **`sandbox-runner-factory` unit tests**:
   - Returns correct runner per backend
   - Throws on missing deploymentStore for lambda backend
   - Throws on unknown backend

5. **Integration test** — `SandboxToolExecutor` works identically with either runner

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `LambdaSandboxRunner` that invokes per-tenant AWS Lambda functions, switchable with gVisor via `SANDBOX_BACKEND` env var, with per-tenant deployment lifecycle managed through an extensible `LambdaDeploymentStore`.

**Architecture:** Strategy pattern on `SandboxRunner` interface — `LambdaSandboxRunner` sits alongside `GvisorSandboxRunner`. A factory reads `SANDBOX_BACKEND` config to select the runner. Deployment state stored via `LambdaDeploymentStore` interface (Redis now, MongoDB later). Studio triggers deployment on tool save; runtime does strict read-only lookup.

**Tech Stack:** TypeScript, AWS SDK v3 (`@aws-sdk/client-lambda`), JSZip, ioredis, vitest

**Design doc:** `docs/plans/2026-02-26-lambda-sandbox-runner-design.md`

---

### Task 1: Add new ToolErrorCode variants to shared package

**Files:**

- Modify: `packages/shared/src/utils/errors.ts:22-34`

**Step 1: Add new error codes to ToolErrorCode union**

At `packages/shared/src/utils/errors.ts:22-34`, add four new codes after `TOOL_SANDBOX_ERROR`:

```typescript
export type ToolErrorCode =
  | 'TOOL_TIMEOUT'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_AUTH_FAILED'
  | 'TOOL_NETWORK_ERROR'
  | 'TOOL_HTTP_ERROR'
  | 'TOOL_RATE_LIMITED'
  | 'TOOL_CIRCUIT_OPEN'
  | 'TOOL_EXECUTION_ERROR'
  | 'TOOL_INVALID_RESPONSE'
  | 'TOOL_SSRF_BLOCKED'
  | 'TOOL_SANDBOX_ERROR'
  | 'TOOL_SANDBOX_NOT_DEPLOYED'
  | 'TOOL_SANDBOX_DEPLOYING'
  | 'TOOL_SANDBOX_DEPLOY_FAILED'
  | 'TOOL_SANDBOX_UNHEALTHY'
  | 'TOOL_MCP_SERVER_UNAVAILABLE';
```

**Step 2: Commit**

```bash
git add packages/shared/src/utils/errors.ts
git commit -m "[ABLP-2] feat(shared): add Lambda sandbox deployment error codes"
```

---

### Task 2: Create LambdaDeploymentStore interface and Redis implementation

**Files:**

- Create: `apps/runtime/src/services/lambda/lambda-deployment-store.ts`
- Test: `apps/runtime/src/__tests__/lambda-deployment-store.test.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/lambda-deployment-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RedisLambdaDeploymentStore,
  type LambdaDeploymentRecord,
} from '../services/lambda/lambda-deployment-store.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
};

function makeRecord(overrides: Partial<LambdaDeploymentRecord> = {}): LambdaDeploymentRecord {
  return {
    tenantId: 'tenant-1',
    runtime: 'javascript',
    functionName: 'abl-runner-tenant-1-js',
    status: 'active',
    region: 'us-east-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('RedisLambdaDeploymentStore', () => {
  let store: RedisLambdaDeploymentStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RedisLambdaDeploymentStore(mockRedis as any);
  });

  it('get returns null when key does not exist', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await store.get('tenant-1', 'javascript');
    expect(result).toBeNull();
    expect(mockRedis.get).toHaveBeenCalledWith('lambda:runner:tenant-1:javascript');
  });

  it('get returns parsed record when key exists', async () => {
    const record = makeRecord();
    mockRedis.get.mockResolvedValue(JSON.stringify(record));
    const result = await store.get('tenant-1', 'javascript');
    expect(result).toEqual(record);
  });

  it('upsert serializes record to Redis', async () => {
    const record = makeRecord();
    mockRedis.set.mockResolvedValue('OK');
    await store.upsert(record);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'lambda:runner:tenant-1:javascript',
      JSON.stringify(record),
    );
  });

  it('updateStatus merges status and extra fields', async () => {
    const record = makeRecord({ status: 'deploying' });
    mockRedis.get.mockResolvedValue(JSON.stringify(record));
    mockRedis.set.mockResolvedValue('OK');
    await store.updateStatus('tenant-1', 'javascript', 'active', {
      lastHealthCheck: '2026-01-02T00:00:00Z',
    });
    const saved = JSON.parse(mockRedis.set.mock.calls[0][1]);
    expect(saved.status).toBe('active');
    expect(saved.lastHealthCheck).toBe('2026-01-02T00:00:00Z');
  });

  it('updateStatus throws when record not found', async () => {
    mockRedis.get.mockResolvedValue(null);
    await expect(store.updateStatus('tenant-1', 'javascript', 'active')).rejects.toThrow(
      'not found',
    );
  });

  it('delete removes the key', async () => {
    mockRedis.del.mockResolvedValue(1);
    await store.delete('tenant-1', 'javascript');
    expect(mockRedis.del).toHaveBeenCalledWith('lambda:runner:tenant-1:javascript');
  });

  it('listByTenant returns all records for a tenant', async () => {
    const jsRecord = makeRecord({ runtime: 'javascript' });
    const pyRecord = makeRecord({ runtime: 'python', functionName: 'abl-runner-tenant-1-py' });
    mockRedis.keys.mockResolvedValue([
      'lambda:runner:tenant-1:javascript',
      'lambda:runner:tenant-1:python',
    ]);
    mockRedis.get
      .mockResolvedValueOnce(JSON.stringify(jsRecord))
      .mockResolvedValueOnce(JSON.stringify(pyRecord));
    const results = await store.listByTenant('tenant-1');
    expect(results).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-deployment-store.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `apps/runtime/src/services/lambda/lambda-deployment-store.ts`:

```typescript
/**
 * Lambda Deployment Store
 *
 * Extensible interface for tracking per-tenant Lambda runner deployments.
 * Redis implementation now; MongoDB can be swapped in later without
 * touching the deployment service or runner.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('lambda-deployment-store');

// ─── Types ─────────────────────────────────────────────────────────────────

export type LambdaDeploymentStatus = 'deploying' | 'active' | 'failed' | 'deleting';

export interface LambdaDeploymentRecord {
  tenantId: string;
  runtime: 'javascript' | 'python';
  functionName: string;
  status: LambdaDeploymentStatus;
  region: string;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

// ─── Interface ─────────────────────────────────────────────────────────────

export interface LambdaDeploymentStore {
  get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null>;
  upsert(record: LambdaDeploymentRecord): Promise<void>;
  updateStatus(
    tenantId: string,
    runtime: string,
    status: LambdaDeploymentStatus,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void>;
  delete(tenantId: string, runtime: string): Promise<void>;
  listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]>;
}

// ─── Redis Implementation ──────────────────────────────────────────────────

const KEY_PREFIX = 'lambda:runner';

function buildKey(tenantId: string, runtime: string): string {
  return `${KEY_PREFIX}:${tenantId}:${runtime}`;
}

export class RedisLambdaDeploymentStore implements LambdaDeploymentStore {
  constructor(private redis: { get: Function; set: Function; del: Function; keys: Function }) {}

  async get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null> {
    const raw = await this.redis.get(buildKey(tenantId, runtime));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LambdaDeploymentRecord;
    } catch (err) {
      log.warn('Failed to parse deployment record', { tenantId, runtime, error: String(err) });
      return null;
    }
  }

  async upsert(record: LambdaDeploymentRecord): Promise<void> {
    const key = buildKey(record.tenantId, record.runtime);
    await this.redis.set(key, JSON.stringify(record));
  }

  async updateStatus(
    tenantId: string,
    runtime: string,
    status: LambdaDeploymentStatus,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void> {
    const existing = await this.get(tenantId, runtime);
    if (!existing) {
      throw new Error(`Deployment record not found for tenant "${tenantId}" runtime "${runtime}"`);
    }
    const updated: LambdaDeploymentRecord = {
      ...existing,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.upsert(updated);
  }

  async delete(tenantId: string, runtime: string): Promise<void> {
    await this.redis.del(buildKey(tenantId, runtime));
  }

  async listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]> {
    const pattern = `${KEY_PREFIX}:${tenantId}:*`;
    const keys: string[] = await this.redis.keys(pattern);
    const records: LambdaDeploymentRecord[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          records.push(JSON.parse(raw));
        } catch {
          // skip malformed entries
        }
      }
    }
    return records;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-deployment-store.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Commit**

```bash
git add apps/runtime/src/services/lambda/lambda-deployment-store.ts apps/runtime/src/__tests__/lambda-deployment-store.test.ts
git commit -m "[ABLP-2] feat(runtime): add LambdaDeploymentStore interface and Redis implementation"
```

---

### Task 3: Create handler templates (ported from AgenticAI)

**Files:**

- Create: `packages/compiler/src/platform/constructs/executors/lambda-handler-templates.ts`

**Step 1: Create the templates file**

Port the handler templates from AgenticAI `backend/apps/async/src/modules/lambda-deployment/constants/lambda.constants.ts`, adapting:

- Memory API URL comes from `context.memoryApiBaseUrl` (not hardcoded `publicUrl`)
- Handler reads `code` from invocation payload (not from deployed files)
- Response shape uses `response` field (matches gVisor)
- Add `ping` support for health checks

The file contains:

- `NODEJS_MEMORY_MANAGER_TEMPLATE` — MemoryManager class (axios-based HTTP client)
- `NODEJS_RUNNER_HANDLER_TEMPLATE` — Lambda handler that receives code as payload, wraps in execution template
- `PYTHON_RUNNER_HANDLER_TEMPLATE` — Python handler with AST validation, security sandbox
- `NODEJS_EXECUTION_TEMPLATE` — Code wrapper (blocks fs, captures logs)
- `PYTHON_EXECUTION_TEMPLATE` — Code wrapper (blocked imports, restricted builtins)

This file has no tests (it's string constants). Correctness is validated through `LambdaSandboxRunner` integration tests.

**Step 2: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/lambda-handler-templates.ts
git commit -m "[ABLP-2] feat(compiler): add Lambda handler templates ported from AgenticAI"
```

---

### Task 4: Create LambdaCodePackager (ZIP builder)

**Files:**

- Create: `apps/runtime/src/services/lambda/lambda-code-packager.ts`
- Test: `apps/runtime/src/__tests__/lambda-code-packager.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { LambdaCodePackager } from '../services/lambda/lambda-code-packager.js';
import JSZip from 'jszip';

describe('LambdaCodePackager', () => {
  const packager = new LambdaCodePackager();

  it('creates a valid ZIP for javascript runtime', async () => {
    const buffer = await packager.createRunnerPackage('javascript');
    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toContain('index.js');
    expect(Object.keys(zip.files)).toContain('memory_manager.js');
  });

  it('creates a valid ZIP for python runtime', async () => {
    const buffer = await packager.createRunnerPackage('python');
    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toContain('index.py');
  });

  it('javascript handler contains MemoryManager setup', async () => {
    const buffer = await packager.createRunnerPackage('javascript');
    const zip = await JSZip.loadAsync(buffer);
    const handler = await zip.file('index.js')!.async('string');
    expect(handler).toContain('MemoryManager');
    expect(handler).toContain('exports.handler');
  });

  it('python handler contains security sandbox', async () => {
    const buffer = await packager.createRunnerPackage('python');
    const zip = await JSZip.loadAsync(buffer);
    const handler = await zip.file('index.py')!.async('string');
    expect(handler).toContain('__blocked_import_roots');
    expect(handler).toContain('lambda_handler');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-code-packager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `apps/runtime/src/services/lambda/lambda-code-packager.ts`:

```typescript
/**
 * Lambda Code Packager
 *
 * Builds ZIP archives for runner Lambda functions.
 * JavaScript: index.js (handler) + memory_manager.js (MemoryManager class)
 * Python: index.py (handler with embedded security sandbox + MockMemoryManager)
 */

import JSZip from 'jszip';
import {
  NODEJS_RUNNER_HANDLER_TEMPLATE,
  NODEJS_MEMORY_MANAGER_TEMPLATE,
  PYTHON_RUNNER_HANDLER_TEMPLATE,
} from '@abl/compiler';

export class LambdaCodePackager {
  async createRunnerPackage(runtime: 'javascript' | 'python'): Promise<Buffer> {
    const zip = new JSZip();

    if (runtime === 'javascript') {
      zip.file('index.js', NODEJS_RUNNER_HANDLER_TEMPLATE);
      zip.file('memory_manager.js', NODEJS_MEMORY_MANAGER_TEMPLATE);
    } else {
      zip.file('index.py', PYTHON_RUNNER_HANDLER_TEMPLATE);
    }

    return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-code-packager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/lambda/lambda-code-packager.ts apps/runtime/src/__tests__/lambda-code-packager.test.ts
git commit -m "[ABLP-2] feat(runtime): add LambdaCodePackager for runner ZIP creation"
```

---

### Task 5: Create LambdaDeploymentService

**Files:**

- Create: `apps/runtime/src/services/lambda/lambda-deployment-service.ts`
- Test: `apps/runtime/src/__tests__/lambda-deployment-service.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LambdaDeploymentService } from '../services/lambda/lambda-deployment-service.js';
import type {
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
} from '../services/lambda/lambda-deployment-store.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  CreateFunctionCommand: vi.fn(),
  DeleteFunctionCommand: vi.fn(),
  GetFunctionCommand: vi.fn(),
  InvokeCommand: vi.fn(),
}));

function makeStore(): LambdaDeploymentStore & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTenant: vi.fn().mockResolvedValue([]),
  };
}

describe('LambdaDeploymentService', () => {
  let store: ReturnType<typeof makeStore>;
  let service: LambdaDeploymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    service = new LambdaDeploymentService({
      store,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123:role/test',
      memoryMb: 256,
      timeoutSec: 120,
    });
  });

  it('ensureRunnerDeployed skips if already active', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'active',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } satisfies LambdaDeploymentRecord);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('ensureRunnerDeployed triggers deploy when not found', async () => {
    store.get.mockResolvedValue(null);
    // Mock the internal deploy to not actually call AWS
    const deploySpy = vi.spyOn(service as any, '_deployRunner').mockResolvedValue(undefined);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(deploySpy).toHaveBeenCalledWith('tenant-1', 'javascript');
  });

  it('ensureRunnerDeployed re-deploys on failed status', async () => {
    store.get.mockResolvedValue({
      tenantId: 'tenant-1',
      runtime: 'javascript',
      functionName: 'abl-runner-tenant-1-js',
      status: 'failed',
      region: 'us-east-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      failureReason: 'previous failure',
    } satisfies LambdaDeploymentRecord);
    const deploySpy = vi.spyOn(service as any, '_deployRunner').mockResolvedValue(undefined);
    await service.ensureRunnerDeployed('tenant-1', 'javascript');
    expect(deploySpy).toHaveBeenCalled();
  });

  it('buildFunctionName sanitizes tenantId', () => {
    const name = (service as any)._buildFunctionName('tenant/special chars!', 'javascript');
    expect(name).toMatch(/^abl-runner-/);
    expect(name).not.toContain('/');
    expect(name).not.toContain('!');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-deployment-service.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `apps/runtime/src/services/lambda/lambda-deployment-service.ts`. Key methods:

- `ensureRunnerDeployed(tenantId, runtime)` — check store, deploy if needed
- `_deployRunner(tenantId, runtime)` — ZIP package → CreateFunctionCommand → poll active → update store
- `_pollFunctionActive(functionName)` — poll GetFunctionCommand until State=Active
- `checkHealth(tenantId, runtime)` — invoke with `{ ping: true }` payload
- `deleteRunner(tenantId, runtime)` — DeleteFunctionCommand → remove from store
- `_buildFunctionName(tenantId, runtime)` — sanitize to `abl-runner-{id}-{js|py}`

Uses `@aws-sdk/client-lambda` (LambdaClient, CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand, InvokeCommand).

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/lambda-deployment-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/lambda/lambda-deployment-service.ts apps/runtime/src/__tests__/lambda-deployment-service.test.ts
git commit -m "[ABLP-2] feat(runtime): add LambdaDeploymentService for per-tenant runner lifecycle"
```

---

### Task 6: Create LambdaSandboxRunner

**Files:**

- Create: `packages/compiler/src/platform/constructs/executors/lambda-sandbox-runner.ts`
- Test: `packages/compiler/src/__tests__/constructs/lambda-sandbox-runner.test.ts`

**Step 1: Write the failing test**

Model after `packages/compiler/src/__tests__/constructs/gvisor-sandbox-runner.test.ts`. Test the strict execution contract:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LambdaSandboxRunner } from '../../platform/constructs/executors/lambda-sandbox-runner.js';
import type {
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
} from '../../platform/constructs/executors/lambda-sandbox-runner.js';
import { ToolExecutionError } from '@agent-platform/shared';

// Mock AWS SDK
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  InvokeCommand: vi.fn(),
}));

function makeStore(record: LambdaDeploymentRecord | null = null): LambdaDeploymentStore {
  return {
    get: vi.fn().mockResolvedValue(record),
    upsert: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    listByTenant: vi.fn().mockResolvedValue([]),
  };
}

function activeRecord(): LambdaDeploymentRecord {
  return {
    tenantId: 'tenant-1',
    runtime: 'javascript',
    functionName: 'abl-runner-tenant-1-js',
    status: 'active',
    region: 'us-east-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastHealthCheck: new Date().toISOString(),
  };
}

const DEFAULT_CONFIG = {
  region: 'us-east-1',
  memoryApiBaseUrl: 'https://api.example.com',
  healthTtlMs: 300000,
};
const DEFAULT_SESSION = { tenantId: 'tenant-1', sessionId: 'session-1', userId: 'user-1' };

describe('LambdaSandboxRunner — strict execution contract', () => {
  it('throws TOOL_SANDBOX_ERROR when tenantId is missing', async () => {
    const store = makeStore(activeRecord());
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, {});
    await expect(
      runner.run({
        functionName: 'test-tool',
        runtime: 'javascript',
        codeContent: 'return 1;',
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      }),
    ).rejects.toThrow(ToolExecutionError);
  });

  it('throws TOOL_SANDBOX_NOT_DEPLOYED when no deployment exists', async () => {
    const store = makeStore(null);
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);
    await expect(
      runner.run({
        functionName: 'test-tool',
        runtime: 'javascript',
        codeContent: 'return 1;',
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      }),
    ).rejects.toThrow('not deployed');
  });

  it('throws TOOL_SANDBOX_DEPLOYING (retryable) when status is deploying', async () => {
    const store = makeStore({ ...activeRecord(), status: 'deploying' });
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);
    try {
      await runner.run({
        functionName: 'test-tool',
        runtime: 'javascript',
        codeContent: 'return 1;',
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
      expect((err as ToolExecutionError).retryable).toBe(true);
    }
  });

  it('throws TOOL_SANDBOX_DEPLOY_FAILED when status is failed', async () => {
    const store = makeStore({ ...activeRecord(), status: 'failed', failureReason: 'IAM error' });
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);
    await expect(
      runner.run({
        functionName: 'test-tool',
        runtime: 'javascript',
        codeContent: 'return 1;',
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      }),
    ).rejects.toThrow('failed');
  });

  it('invokes Lambda when deployment is active', async () => {
    const store = makeStore(activeRecord());
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);

    // Mock the Lambda client send to return a successful response
    const mockSend = vi.fn().mockResolvedValue({
      StatusCode: 200,
      Payload: new TextEncoder().encode(
        JSON.stringify({
          statusCode: 200,
          body: JSON.stringify({ response: { result: 42 }, logs: [], error: '' }),
        }),
      ),
    });
    (runner as any).lambdaClient = { send: mockSend };

    const result = await runner.run({
      functionName: 'test-tool',
      runtime: 'javascript',
      codeContent: 'return { result: 42 };',
      params: { x: 1 },
      limits: { timeoutMs: 5000, memoryMb: 128 },
    });
    expect(result).toEqual({ result: 42 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('preprocesses JS params with $ prefix', async () => {
    const store = makeStore(activeRecord());
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);
    const mockSend = vi.fn().mockResolvedValue({
      StatusCode: 200,
      Payload: new TextEncoder().encode(
        JSON.stringify({
          statusCode: 200,
          body: JSON.stringify({ response: 'ok', logs: [], error: '' }),
        }),
      ),
    });
    (runner as any).lambdaClient = { send: mockSend };

    await runner.run({
      functionName: 'test-tool',
      runtime: 'javascript',
      codeContent: 'return "ok";',
      params: { income: 50000, region: 'US' },
      limits: { timeoutMs: 5000, memoryMb: 128 },
    });

    // Verify the InvokeCommand payload has $-prefixed params
    const payload = JSON.parse(new TextDecoder().decode(mockSend.mock.calls[0][0].input.Payload));
    expect(payload.params).toHaveProperty('$income');
    expect(payload.params).toHaveProperty('$region');
  });

  it('rejects code exceeding 1MB', async () => {
    const store = makeStore(activeRecord());
    const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, DEFAULT_SESSION);
    const bigCode = 'x'.repeat(1024 * 1024 + 1);
    await expect(
      runner.run({
        functionName: 'test-tool',
        runtime: 'javascript',
        codeContent: bigCode,
        params: {},
        limits: { timeoutMs: 5000, memoryMb: 128 },
      }),
    ).rejects.toThrow('size limit');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/lambda-sandbox-runner.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `packages/compiler/src/platform/constructs/executors/lambda-sandbox-runner.ts`. Key elements:

- Implements `SandboxRunner` interface
- Constructor takes `LambdaSandboxConfig`, `LambdaDeploymentStore` (required), `GvisorSessionContext`, `JwtSigner`
- `run()` implements strict contract: validate tenantId → lookup store → validate status → health check → invoke
- `preprocessParams()` reuses same `$` prefix logic as `GvisorSandboxRunner`
- `invokeLambda()` builds `InvokeCommand` payload, sends via AWS SDK, parses response
- Response parsing normalizes to match gVisor format
- Re-exports `LambdaDeploymentStore` and `LambdaDeploymentRecord` types for consumer convenience

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/lambda-sandbox-runner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/lambda-sandbox-runner.ts packages/compiler/src/__tests__/constructs/lambda-sandbox-runner.test.ts
git commit -m "[ABLP-2] feat(compiler): add LambdaSandboxRunner with strict execution contract"
```

---

### Task 7: Create sandbox-runner-factory

**Files:**

- Create: `packages/compiler/src/platform/constructs/executors/sandbox-runner-factory.ts`
- Test: `packages/compiler/src/__tests__/constructs/sandbox-runner-factory.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createSandboxRunner } from '../../platform/constructs/executors/sandbox-runner-factory.js';
import { GvisorSandboxRunner } from '../../platform/constructs/executors/gvisor-sandbox-runner.js';
import { LambdaSandboxRunner } from '../../platform/constructs/executors/lambda-sandbox-runner.js';

vi.mock('fs/promises', () => ({ readFile: vi.fn(), realpath: vi.fn().mockResolvedValue('/app') }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  InvokeCommand: vi.fn(),
}));

const gvisorConfig = {
  pythonPodUrl: 'http://python-svc',
  javascriptPodUrl: 'http://js-svc',
  podPath: '/execute-script',
  codeBasePath: '/app/sandbox',
};
const lambdaConfig = {
  region: 'us-east-1',
  memoryApiBaseUrl: 'https://api.test.com',
  healthTtlMs: 300000,
};
const session = { tenantId: 'tenant-1' };
const mockStore = {
  get: vi.fn(),
  upsert: vi.fn(),
  updateStatus: vi.fn(),
  delete: vi.fn(),
  listByTenant: vi.fn(),
};

describe('createSandboxRunner', () => {
  it('returns GvisorSandboxRunner for gvisor backend', () => {
    const runner = createSandboxRunner(
      'gvisor',
      { gvisor: gvisorConfig, lambda: lambdaConfig },
      session,
    );
    expect(runner).toBeInstanceOf(GvisorSandboxRunner);
  });

  it('returns LambdaSandboxRunner for lambda backend', () => {
    const runner = createSandboxRunner(
      'lambda',
      { gvisor: gvisorConfig, lambda: lambdaConfig, deploymentStore: mockStore },
      session,
    );
    expect(runner).toBeInstanceOf(LambdaSandboxRunner);
  });

  it('throws when lambda backend has no deploymentStore', () => {
    expect(() =>
      createSandboxRunner('lambda', { gvisor: gvisorConfig, lambda: lambdaConfig }, session),
    ).toThrow('LambdaDeploymentStore');
  });

  it('throws for unknown backend', () => {
    expect(() =>
      createSandboxRunner('docker' as any, { gvisor: gvisorConfig, lambda: lambdaConfig }, session),
    ).toThrow('Unknown SANDBOX_BACKEND');
  });
});
```

**Step 2: Run test, verify fails, implement, verify passes**

**Step 3: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/sandbox-runner-factory.ts packages/compiler/src/__tests__/constructs/sandbox-runner-factory.test.ts
git commit -m "[ABLP-2] feat(compiler): add sandbox runner factory for gVisor/Lambda switching"
```

---

### Task 8: Update compiler barrel exports

**Files:**

- Modify: `packages/compiler/src/index.ts:328-335`

**Step 1: Add exports for new modules**

After the existing `GvisorSandboxRunner` exports (line 335), add:

```typescript
export { LambdaSandboxRunner } from './platform/constructs/executors/lambda-sandbox-runner.js';
export type {
  LambdaSandboxConfig,
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
  LambdaDeploymentStatus,
} from './platform/constructs/executors/lambda-sandbox-runner.js';
export { createSandboxRunner } from './platform/constructs/executors/sandbox-runner-factory.js';
export {
  NODEJS_RUNNER_HANDLER_TEMPLATE,
  NODEJS_MEMORY_MANAGER_TEMPLATE,
  PYTHON_RUNNER_HANDLER_TEMPLATE,
} from './platform/constructs/executors/lambda-handler-templates.js';
```

**Step 2: Delete deprecated lambda-tool-executor.ts**

Remove `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts` and any imports referencing it.

**Step 3: Verify build**

Run: `cd packages/compiler && pnpm build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add packages/compiler/src/index.ts
git rm packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts
git commit -m "[ABLP-2] feat(compiler): export Lambda runner modules, remove deprecated lambda-tool-executor"
```

---

### Task 9: Wire factory into llm-wiring.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/llm-wiring.ts:16-17,394-449`

**Step 1: Update imports**

Replace direct `GvisorSandboxRunner` import with factory + types:

```typescript
// Remove:
import { GvisorSandboxRunner } from '@abl/compiler';

// Add:
import { createSandboxRunner } from '@abl/compiler';
import type { LambdaDeploymentStore } from '@abl/compiler';
```

Keep `GvisorSandboxRunner` in the type imports if needed for config types.

**Step 2: Replace sandbox wiring (lines ~394-449)**

Replace the direct `GvisorSandboxRunner` construction block with:

```typescript
// Wire Sandbox (code from IR — no DB lookups)
let sandboxRunner: SandboxRunner | undefined;
const sandboxTools = allTools.filter((t) => t.tool_type === 'sandbox');
if (sandboxTools.length > 0) {
  const sandboxBackend = (process.env.SANDBOX_BACKEND || 'gvisor') as 'gvisor' | 'lambda';
  const pythonPodUrl = process.env.SANDBOX_PYTHON_POD_URL;
  const javascriptPodUrl = process.env.SANDBOX_JAVASCRIPT_POD_URL;

  // Build gvisor config (used when backend=gvisor or as fallback)
  const gvisorConfig = {
    /* existing config construction */
  };

  // Build lambda config
  const lambdaConfig = {
    region: process.env.LAMBDA_RUNNER_REGION || 'us-east-1',
    memoryApiBaseUrl: process.env.LAMBDA_RUNNER_MEMORY_API_URL || '',
    healthTtlMs: parseInt(process.env.LAMBDA_RUNNER_HEALTH_TTL_MS || '300000', 10),
  };

  // Build deployment store (only needed for lambda backend)
  let deploymentStore: LambdaDeploymentStore | undefined;
  if (sandboxBackend === 'lambda') {
    const { RedisLambdaDeploymentStore } = await import('../lambda/lambda-deployment-store.js');
    const redis = getRedisClient();
    if (redis) {
      deploymentStore = new RedisLambdaDeploymentStore(redis);
    } else {
      session.toolWarnings = [
        ...(session.toolWarnings || []),
        'Redis unavailable — Lambda sandbox backend requires Redis for deployment state',
      ];
    }
  }

  const sessionCtx = { tenantId, sessionId: session.id, userId: session.userId, projectId };

  try {
    sandboxRunner = createSandboxRunner(
      sandboxBackend,
      { gvisor: gvisorConfig, lambda: lambdaConfig, deploymentStore },
      sessionCtx,
      sandboxJwtSigner,
    );
  } catch (err) {
    session.toolWarnings = [
      ...(session.toolWarnings || []),
      `Failed to create sandbox runner: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }
}
```

**Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/llm-wiring.ts
git commit -m "[ABLP-2] feat(runtime): wire sandbox runner factory into llm-wiring"
```

---

### Task 10: Studio integration — trigger deployment on tool save

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/tools/route.ts:101-128`

**Step 1: Add async deployment trigger after tool creation**

After the `createProjectTool` call and before the audit log (around line 113), add:

```typescript
// Trigger Lambda runner deployment for sandbox tools (async, fire-and-forget)
if (formData.toolType === 'sandbox' && process.env.SANDBOX_BACKEND === 'lambda') {
  import('../../../../../../services/lambda-deploy-trigger.js')
    .then(({ triggerLambdaDeployment }) =>
      triggerLambdaDeployment(tenantId, formData.runtime || 'javascript'),
    )
    .catch((err: unknown) => {
      console.error('[lambda-deploy] trigger failed:', err instanceof Error ? err.message : err);
    });
}
```

**Step 2: Create the trigger service**

Create `apps/studio/src/services/lambda-deploy-trigger.ts`:

```typescript
/**
 * Lambda Deployment Trigger
 *
 * Fire-and-forget trigger for per-tenant Lambda runner deployment.
 * Called from Studio API routes when sandbox tools are created/updated.
 * Communicates with runtime's LambdaDeploymentService via internal API.
 */

export async function triggerLambdaDeployment(
  tenantId: string,
  runtime: 'javascript' | 'python',
): Promise<void> {
  const runtimeUrl = process.env.RUNTIME_INTERNAL_URL;
  if (!runtimeUrl) {
    console.warn('[lambda-deploy] RUNTIME_INTERNAL_URL not set — skipping deployment trigger');
    return;
  }

  const response = await fetch(`${runtimeUrl}/api/internal/lambda/ensure-deployed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, runtime }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[lambda-deploy] trigger failed: ${response.status} ${text.substring(0, 200)}`);
  }
}
```

**Step 3: Add internal runtime endpoint**

Create `apps/runtime/src/routes/internal/lambda-deploy.ts` — an internal-only POST endpoint that calls `LambdaDeploymentService.ensureRunnerDeployed()`. Guard with internal-only auth (e.g., shared secret or network-level restriction).

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/projects/[id]/tools/route.ts apps/studio/src/services/lambda-deploy-trigger.ts apps/runtime/src/routes/internal/lambda-deploy.ts
git commit -m "[ABLP-2] feat(studio): trigger Lambda runner deployment on sandbox tool save"
```

---

### Task 11: Run full test suite and fix issues

**Step 1: Build all packages**

Run: `pnpm build`

**Step 2: Run compiler tests**

Run: `cd packages/compiler && npx vitest run`

**Step 3: Run runtime tests**

Run: `cd apps/runtime && npx vitest run`

**Step 4: Fix any failures and commit**

```bash
git add -A
git commit -m "[ABLP-2] fix(compiler): resolve test and build issues from Lambda runner integration"
```

---

### Task 12: Final review and cleanup

**Step 1: Verify no unused imports or dead code**

Check that:

- `lambda-tool-executor.ts` is deleted
- No other files import from the deleted file
- All new exports are accessible from `@abl/compiler`

**Step 2: Verify strict contract is enforced**

Review `lambda-sandbox-runner.ts` against the design doc checklist:

- [ ] tenantId required → fails with `TOOL_SANDBOX_ERROR`
- [ ] No deployment → fails with `TOOL_SANDBOX_NOT_DEPLOYED`
- [ ] Deploying → fails with `TOOL_SANDBOX_DEPLOYING` (retryable)
- [ ] Failed → fails with `TOOL_SANDBOX_DEPLOY_FAILED`
- [ ] Active → proceeds to invoke
- [ ] Stale health check → ping before invoke
- [ ] Runtime NEVER calls deployment service

**Step 3: Final commit**

```bash
git add -A
git commit -m "[ABLP-2] chore(compiler): cleanup and final review for Lambda sandbox runner"
```
