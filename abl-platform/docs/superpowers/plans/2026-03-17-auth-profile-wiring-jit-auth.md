# Auth Profile Wiring & JIT Auth Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire existing unwired auth profile infrastructure (rotation job, grace period, name resolution, DSL refs, mTLS, bulk actions) and implement JIT (just-in-time) mid-conversation user authentication.

**Architecture:** Two phases — Phase 1 wires existing code that was never connected to callers (rotation, grace period, name resolution, DSL, mTLS, bulk, config vars). Phase 2 builds JIT auth as a new runtime mechanism (WebSocket protocol, pause/resume, OAuth flow, Studio UI, SDK support).

**Tech Stack:** TypeScript, MongoDB/Mongoose, Redis, Express, WebSocket (ws), Next.js App Router, React, Zod

---

## Chunk 1: Auth Profile Wiring (Tasks 1-7)

### Task 1: Wire Rotation Job into Server Startup

**Files:**

- Modify: `apps/runtime/src/server.ts:1603-1619` (after KMS rotation job)
- Modify: `apps/runtime/src/server.ts:1857-1868` (shutdown handler)
- Modify: `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-rotation-scheduling.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/auth-profile-rotation-scheduling.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Auth Profile Rotation Scheduling', () => {
  it('startAuthProfileRotation returns a handle with stop()', async () => {
    const { startAuthProfileRotation } =
      await import('../services/auth-profile/auth-profile-rotation-scheduler.js');
    const mockJob = { run: vi.fn().mockResolvedValue({ processed: 0, skipped: 0, failed: 0 }) };
    const handle = startAuthProfileRotation(mockJob, { intervalMs: 100 });
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe('function');
    handle.stop();
  });

  it('runs the job on the configured interval', async () => {
    vi.useFakeTimers();
    const { startAuthProfileRotation } =
      await import('../services/auth-profile/auth-profile-rotation-scheduler.js');
    const mockJob = { run: vi.fn().mockResolvedValue({ processed: 0, skipped: 0, failed: 0 }) };
    const handle = startAuthProfileRotation(mockJob, { intervalMs: 5000 });

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockJob.run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockJob.run).toHaveBeenCalledTimes(2);

    handle.stop();
    vi.useRealTimers();
  });

  it('stop() prevents further runs', async () => {
    vi.useFakeTimers();
    const { startAuthProfileRotation } =
      await import('../services/auth-profile/auth-profile-rotation-scheduler.js');
    const mockJob = { run: vi.fn().mockResolvedValue({ processed: 0, skipped: 0, failed: 0 }) };
    const handle = startAuthProfileRotation(mockJob, { intervalMs: 5000 });

    handle.stop();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockJob.run).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-rotation-scheduling.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the scheduler module**

```typescript
// apps/runtime/src/services/auth-profile/auth-profile-rotation-scheduler.ts
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-rotation');

interface RotationJobLike {
  run(): Promise<{ processed: number; skipped: number; failed: number }>;
}

interface RotationSchedulerOptions {
  intervalMs: number;
}

interface RotationHandle {
  stop: () => void;
}

export function startAuthProfileRotation(
  job: RotationJobLike,
  options: RotationSchedulerOptions,
): RotationHandle {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const result = await job.run();
      if (result.processed > 0 || result.failed > 0) {
        log.info('Auth profile rotation completed', result);
      }
    } catch (err) {
      log.error('Auth profile rotation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, options.intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      log.info('Auth profile rotation scheduler stopped');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-rotation-scheduling.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into server.ts startup**

In `apps/runtime/src/server.ts`, after the KMS rotation job block (after line ~1619), add:

```typescript
// Start auth profile rotation job (re-encrypts profiles on key version changes)
try {
  const { AuthProfileRotationJob } =
    await import('./services/auth-profile/auth-profile-rotation-job.js');
  const { startAuthProfileRotation } =
    await import('./services/auth-profile/auth-profile-rotation-scheduler.js');
  const { AuthProfile } = await import('@abl/database');
  const { getEncryptionService } = await import('./services/kms/encryption-service.js');
  const { getRedisClient } = await import('./redis.js');

  const rotationJob = new AuthProfileRotationJob({
    authProfileModel: AuthProfile,
    encryptionService: getEncryptionService(),
    redis: getRedisClient(),
  });
  const rotationHandle = startAuthProfileRotation(rotationJob, {
    intervalMs: parseInt(process.env.AUTH_ROTATION_INTERVAL_MS || '300000', 10),
  });
  // Store handle for shutdown
  (globalThis as any).__authProfileRotationHandle = rotationHandle;
  serverLog.info('Auth profile rotation job started');
} catch (err) {
  serverLog.warn('Auth profile rotation job failed to start (non-fatal)', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

In the shutdown handler (after `stopKMSRotationJob` around line ~1862), add:

```typescript
// Stop auth profile rotation
try {
  const handle = (globalThis as any).__authProfileRotationHandle;
  if (handle) {
    handle.stop();
    shutdownLog.info('Auth profile rotation stopped');
  }
} catch (err) {
  shutdownLog.warn('Auth profile rotation stop failed', {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/auth-profile/auth-profile-rotation-scheduler.ts apps/runtime/src/__tests__/auth-profile-rotation-scheduling.test.ts apps/runtime/src/server.ts
git add apps/runtime/src/services/auth-profile/auth-profile-rotation-scheduler.ts apps/runtime/src/__tests__/auth-profile-rotation-scheduling.test.ts apps/runtime/src/server.ts
git commit -m "feat(runtime): wire auth profile rotation job into server startup/shutdown"
```

---

### Task 2: Wire Grace Period into Auth Profile Resolver

**Files:**

- Modify: `apps/runtime/src/services/auth-profile-resolver.ts:61-71`
- Read: `packages/shared-auth-profile/src/grace-period.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-resolver-grace-period.test.ts`

- [ ] **Step 1: Read the grace period module to understand the decrypt function contract**

Read: `packages/shared-auth-profile/src/grace-period.ts` — `resolveWithGracePeriod(profile, decrypt)` expects a `decrypt: (cipher: string) => Promise<string>` function. The Mongoose encryption plugin handles transparent decrypt on read, so `profile.encryptedSecrets` is already plaintext JSON by the time it reaches the resolver. The grace period matters during key rotation when the plugin can't decrypt with the new key.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/runtime/src/__tests__/auth-profile-resolver-grace-period.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database model
vi.mock('@abl/database', () => ({
  AuthProfile: {
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({}),
  },
}));

// Mock grace period module
vi.mock('@abl/shared-auth-profile/grace-period', () => ({
  resolveWithGracePeriod: vi.fn(),
}));

describe('auth-profile-resolver grace period', () => {
  it('calls resolveWithGracePeriod instead of raw JSON.parse', async () => {
    const { AuthProfile } = await import('@abl/database');
    const { resolveWithGracePeriod } = await import('@abl/shared-auth-profile/grace-period');
    const { resolveAuthProfileCredentials } = await import('../services/auth-profile-resolver.js');

    const mockProfile = {
      _id: 'profile-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
      status: 'active',
      encryptedSecrets: '{"apiKey":"secret-123"}',
      previousEncryptedSecrets: '{"apiKey":"old-secret"}',
      rotationGracePeriodMs: 600000,
      updatedAt: new Date(),
      config: { headerName: 'X-API-Key' },
    };

    (AuthProfile.findOne as any).mockReturnValue({
      lean: () => Promise.resolve(mockProfile),
    });
    (resolveWithGracePeriod as any).mockResolvedValue({ apiKey: 'secret-123' });

    const result = await resolveAuthProfileCredentials('profile-1', 'tenant-1');

    expect(resolveWithGracePeriod).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedSecrets: mockProfile.encryptedSecrets,
        previousEncryptedSecrets: mockProfile.previousEncryptedSecrets,
        rotationGracePeriodMs: mockProfile.rotationGracePeriodMs,
      }),
      expect.any(Function),
    );
    expect(result).toBeDefined();
    expect(result!.secrets).toEqual({ apiKey: 'secret-123' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-resolver-grace-period.test.ts`
Expected: FAIL — `resolveWithGracePeriod` not called

- [ ] **Step 4: Wire grace period into the resolver**

In `apps/runtime/src/services/auth-profile-resolver.ts`, replace lines 61-71:

Old code:

```typescript
if (typeof profile.encryptedSecrets === 'string') {
  try {
    secrets = JSON.parse(profile.encryptedSecrets);
  } catch {
    secrets = { _raw: profile.encryptedSecrets };
  }
} else if (typeof profile.encryptedSecrets === 'object' && profile.encryptedSecrets !== null) {
  secrets = profile.encryptedSecrets;
} else {
  secrets = {};
}
```

New code:

```typescript
try {
  const { resolveWithGracePeriod } = await import('@abl/shared-auth-profile/grace-period');
  secrets = await resolveWithGracePeriod(
    {
      encryptedSecrets: profile.encryptedSecrets,
      previousEncryptedSecrets: profile.previousEncryptedSecrets,
      rotationGracePeriodMs: profile.rotationGracePeriodMs,
      updatedAt: profile.updatedAt,
    },
    async (cipher: string) => cipher, // Mongoose plugin already decrypted
  );
} catch (err) {
  log.warn('Grace period resolution failed, falling back to direct parse', {
    profileId: authProfileId,
    error: err instanceof Error ? err.message : String(err),
  });
  // Fallback to previous behavior
  if (typeof profile.encryptedSecrets === 'string') {
    try {
      secrets = JSON.parse(profile.encryptedSecrets);
    } catch {
      secrets = { _raw: profile.encryptedSecrets };
    }
  } else if (typeof profile.encryptedSecrets === 'object' && profile.encryptedSecrets !== null) {
    secrets = profile.encryptedSecrets as Record<string, unknown>;
  } else {
    secrets = {};
  }
}
```

Also add the import for the logger at the top if not present.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-resolver-grace-period.test.ts`
Expected: PASS

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/auth-profile-resolver.ts apps/runtime/src/__tests__/auth-profile-resolver-grace-period.test.ts
git add apps/runtime/src/services/auth-profile-resolver.ts apps/runtime/src/__tests__/auth-profile-resolver-grace-period.test.ts
git commit -m "feat(runtime): wire resolveWithGracePeriod into auth profile resolver"
```

---

### Task 3: Add Name-Based Auth Profile Resolution

**Files:**

- Modify: `apps/runtime/src/services/auth-profile-resolver.ts`
- Test: `apps/runtime/src/__tests__/auth-profile-resolver-by-name.test.ts`

Note: `name` has a unique compound index on `(tenantId, projectId, environment)` — see `packages/database/src/models/auth-profile.model.ts:192-199`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/auth-profile-resolver-by-name.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/database', () => ({
  AuthProfile: {
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@abl/shared-auth-profile/grace-period', () => ({
  resolveWithGracePeriod: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
}));

describe('resolveAuthProfileByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a profile by name + tenantId', async () => {
    const { AuthProfile } = await import('@abl/database');
    const { resolveAuthProfileByName } = await import('../services/auth-profile-resolver.js');

    const mockProfile = {
      _id: 'profile-1',
      name: 'staging-api-key',
      tenantId: 'tenant-1',
      authType: 'api_key',
      status: 'active',
      encryptedSecrets: '{"apiKey":"secret"}',
      config: { headerName: 'Authorization' },
      updatedAt: new Date(),
    };

    (AuthProfile.findOne as any).mockReturnValue({
      lean: () => Promise.resolve(mockProfile),
    });

    const result = await resolveAuthProfileByName('staging-api-key', 'tenant-1');
    expect(result).toBeDefined();
    expect(result!.authType).toBe('api_key');

    expect(AuthProfile.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'staging-api-key',
        tenantId: 'tenant-1',
        status: 'active',
      }),
    );
  });

  it('resolves with environment filter', async () => {
    const { AuthProfile } = await import('@abl/database');
    const { resolveAuthProfileByName } = await import('../services/auth-profile-resolver.js');

    (AuthProfile.findOne as any).mockReturnValue({
      lean: () =>
        Promise.resolve({
          _id: 'p2',
          name: 'creds',
          tenantId: 't1',
          authType: 'bearer',
          status: 'active',
          encryptedSecrets: '{"token":"x"}',
          config: {},
          environment: 'staging',
          updatedAt: new Date(),
        }),
    });

    await resolveAuthProfileByName('creds', 't1', { environment: 'staging' });

    expect(AuthProfile.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'staging' }),
    );
  });

  it('returns null for non-existent profile', async () => {
    const { AuthProfile } = await import('@abl/database');
    const { resolveAuthProfileByName } = await import('../services/auth-profile-resolver.js');

    (AuthProfile.findOne as any).mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    const result = await resolveAuthProfileByName('nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-resolver-by-name.test.ts`
Expected: FAIL — `resolveAuthProfileByName` not exported

- [ ] **Step 3: Add resolveAuthProfileByName to the resolver**

Add to `apps/runtime/src/services/auth-profile-resolver.ts`:

```typescript
export async function resolveAuthProfileByName(
  name: string,
  tenantId: string,
  options?: { environment?: string; projectId?: string },
): Promise<AuthProfileCredentials | null> {
  const query: Record<string, unknown> = {
    name,
    tenantId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  };

  if (options?.environment) {
    query.environment = options.environment;
  }

  if (options?.projectId) {
    // Look in project scope first, then tenant scope
    query.$or = [
      { projectId: options.projectId, expiresAt: { $in: [null, undefined] } },
      { projectId: options.projectId, expiresAt: { $gt: new Date() } },
      { projectId: null, expiresAt: { $in: [null, undefined] } },
      { projectId: null, expiresAt: { $gt: new Date() } },
    ];
  } else {
    query.$or = [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }];
  }

  const profile = await (AuthProfile as any).findOne(query).lean();

  if (!profile) return null;

  // Reuse the same secrets resolution logic as resolveAuthProfileCredentials
  return buildCredentials(profile);
}
```

Extract the secrets resolution into a shared `buildCredentials(profile)` helper to avoid duplication with `resolveAuthProfileCredentials`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-resolver-by-name.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing resolver tests to verify no regression**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/auth-profile-resolver`
Expected: All PASS

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/auth-profile-resolver.ts apps/runtime/src/__tests__/auth-profile-resolver-by-name.test.ts
git add apps/runtime/src/services/auth-profile-resolver.ts apps/runtime/src/__tests__/auth-profile-resolver-by-name.test.ts
git commit -m "feat(runtime): add name-based auth profile resolution with environment support"
```

---

### Task 4: DSL `auth_profile:` Parsing in Tool File Parser

**Files:**

- Modify: `packages/core/src/parser/tool-file-parser.ts:223-244` (variable declarations), `:343-344` (after `auth:` case), `:488-502` (httpBinding assembly)
- Test: `packages/core/src/__tests__/parser/tool-file-auth-profile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/parser/tool-file-auth-profile.test.ts
import { describe, it, expect } from 'vitest';
import { parseToolFile } from '../../parser/tool-file-parser.js';

describe('tool-file-parser auth_profile', () => {
  it('parses auth_profile property on HTTP tools', () => {
    const input = `
TOOL: check-weather
  type: http
  description: Check weather for a city
  endpoint: https://api.weather.com/v1/current
  method: GET
  auth_profile: staging-weather-creds
`;
    const result = parseToolFile(input, 'test.tool');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].httpBinding?.authProfileRef).toBe('staging-weather-creds');
  });

  it('auth_profile takes precedence over inline auth', () => {
    const input = `
TOOL: my-api
  type: http
  description: Call API
  endpoint: https://api.example.com
  method: POST
  auth: bearer
  auth_profile: prod-bearer-creds
`;
    const result = parseToolFile(input, 'test.tool');
    expect(result.tools[0].httpBinding?.authProfileRef).toBe('prod-bearer-creds');
  });

  it('supports config variable syntax in auth_profile', () => {
    const input = `
TOOL: my-api
  type: http
  description: Call API
  endpoint: https://api.example.com
  method: GET
  auth_profile: "{{config.API_CREDS}}"
`;
    const result = parseToolFile(input, 'test.tool');
    expect(result.tools[0].httpBinding?.authProfileRef).toBe('{{config.API_CREDS}}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/parser/tool-file-auth-profile.test.ts`
Expected: FAIL — `authProfileRef` undefined

- [ ] **Step 3: Add auth_profile parsing**

In `packages/core/src/parser/tool-file-parser.ts`:

1. Add variable declaration (around line 244): `let authProfileRef: string | undefined;`
2. Add case in switch (after `auth:` case at line 344):

```typescript
case 'auth_profile':
  authProfileRef = value.replace(/^["']|["']$/g, ''); // strip quotes
  break;
```

3. Add to httpBinding object (line 488-502):

```typescript
result.httpBinding = {
  endpoint,
  method: (method || 'GET') as HttpBindingAST['method'],
  auth,
  authConfig,
  authProfileRef,
  timeout,
  // ... rest unchanged
};
```

4. Add `authProfileRef?: string` to the `HttpBindingAST` type if it exists in the AST types.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/parser/tool-file-auth-profile.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tool file parser tests**

Run: `cd packages/core && pnpm vitest run src/__tests__/parser/tool-file`
Expected: All PASS

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write packages/core/src/parser/tool-file-parser.ts packages/core/src/__tests__/parser/tool-file-auth-profile.test.ts
git add packages/core/src/parser/tool-file-parser.ts packages/core/src/__tests__/parser/tool-file-auth-profile.test.ts
git commit -m "feat(core): parse auth_profile property in tool DSL"
```

---

### Task 5: Add `authProfileRef` to IR Schema and Compiler

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:730-767` (HttpBindingIR)
- Modify: `packages/compiler/src/platform/ir/auth-config-builder.ts`
- Modify: `packages/compiler/src/platform/ir/compiler.ts` (compileHttpBinding ~line 724-746)
- Test: `packages/compiler/src/__tests__/ir/auth-profile-ref-compilation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/compiler/src/__tests__/ir/auth-profile-ref-compilation.test.ts
import { describe, it, expect } from 'vitest';
import { compile } from '../../index.js';

describe('auth_profile IR compilation', () => {
  it('emits authProfileRef on HttpBindingIR', () => {
    const dsl = `
AGENT: weather-bot
  IDENTITY:
    role: weather assistant
  TOOLS:
    - check-weather
`;
    const toolFile = `
TOOL: check-weather
  type: http
  description: Check weather
  endpoint: https://api.weather.com/v1/current
  method: GET
  auth_profile: prod-weather-key
`;
    const result = compile(dsl, { toolFiles: [{ name: 'tools.tool', content: toolFile }] });
    expect(result.errors).toHaveLength(0);

    const tool = result.ir?.agents[0]?.tools?.find((t: any) => t.name === 'check-weather');
    expect(tool?.http_binding?.authProfileRef).toBe('prod-weather-key');
  });

  it('preserves config variable template in authProfileRef', () => {
    const dsl = `
AGENT: api-bot
  IDENTITY:
    role: api caller
  TOOLS:
    - call-api
`;
    const toolFile = `
TOOL: call-api
  type: http
  description: Call API
  endpoint: https://api.example.com
  method: GET
  auth_profile: "{{config.API_PROFILE}}"
`;
    const result = compile(dsl, { toolFiles: [{ name: 'tools.tool', content: toolFile }] });
    expect(result.errors).toHaveLength(0);

    const tool = result.ir?.agents[0]?.tools?.find((t: any) => t.name === 'call-api');
    expect(tool?.http_binding?.authProfileRef).toBe('{{config.API_PROFILE}}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/ir/auth-profile-ref-compilation.test.ts`
Expected: FAIL — `authProfileRef` undefined on IR

- [ ] **Step 3: Add authProfileRef to IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add to `HttpBindingIR` interface (after line ~767):

```typescript
authProfileRef?: string;
```

- [ ] **Step 4: Thread authProfileRef through the compiler**

In `packages/compiler/src/platform/ir/compiler.ts`, in the `compileHttpBinding` function (~line 724-746), read `authProfileRef` from the AST's httpBinding and pass it through to the IR output:

```typescript
authProfileRef: httpBindingAST.authProfileRef,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/ir/auth-profile-ref-compilation.test.ts`
Expected: PASS

- [ ] **Step 6: Run full compiler tests**

Run: `cd packages/compiler && pnpm vitest run`
Expected: All 3,947+ tests PASS

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/ir/auth-profile-ref-compilation.test.ts
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/ir/auth-profile-ref-compilation.test.ts
git commit -m "feat(compiler): add authProfileRef to HttpBindingIR for DSL auth profile references"
```

---

### Task 6: Wire authProfileRef in Runtime HTTP Tool Executor

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts:245` (auth application), `:331-436` (applyAuth)
- Test: `packages/compiler/src/__tests__/constructs/http-tool-auth-profile.test.ts`

- [ ] **Step 1: Read the http-tool-executor to understand the auth injection point**

Read `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` — understand how `SecretsProvider` and `applyAuth` work. The runtime context provides a `secretsProvider` that resolves secrets. We need to add an `authProfileResolver` to the context that the executor can call.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/compiler/src/__tests__/constructs/http-tool-auth-profile.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('HTTP tool executor authProfileRef', () => {
  it('resolves auth profile credentials when authProfileRef is set', async () => {
    // Test that when a tool binding has authProfileRef, the executor
    // calls the auth profile resolver and applies the returned credentials
    // Exact test structure depends on how the executor is instantiated —
    // read the file first in Step 1 to determine the correct test pattern
  });
});
```

Note: The exact test and implementation depend on how the executor receives its dependencies. Read the executor in Step 1, then write the specific test targeting the `authProfileRef` path through `applyAuth`.

The key wiring: when `binding.authProfileRef` is set, call `context.authProfileResolver.resolveByName(binding.authProfileRef, tenantId)` and use the returned credentials to set headers instead of using inline `SecretsProvider`.

- [ ] **Step 3: Implement authProfileRef handling in applyAuth**

Add an early check in `applyAuth` (around line 331):

```typescript
if (binding.authProfileRef) {
  const resolver = this.context?.authProfileResolver;
  if (resolver) {
    const creds = await resolver.resolveByName(binding.authProfileRef, this.tenantId);
    if (creds) {
      // Apply credentials from auth profile using shared-auth-profile/apply-auth
      const { applyAuth: applyAuthProfile } = await import('@abl/shared-auth-profile/apply-auth');
      const result = applyAuthProfile({
        authType: creds.authType,
        config: creds.config,
        secrets: creds.secrets,
        headers,
      });
      Object.assign(headers, result.headers);
      return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/constructs/http-tool-auth-profile.test.ts`
Expected: PASS

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/constructs/executors/http-tool-executor.ts packages/compiler/src/__tests__/constructs/http-tool-auth-profile.test.ts
git add packages/compiler/src/platform/constructs/executors/http-tool-executor.ts packages/compiler/src/__tests__/constructs/http-tool-auth-profile.test.ts
git commit -m "feat(runtime): resolve authProfileRef credentials in HTTP tool executor"
```

---

### Task 7: mTLS TLS Agent Wiring

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` (where HTTP request is made)
- Test: `packages/compiler/src/__tests__/constructs/http-tool-mtls.test.ts`

- [ ] **Step 1: Read the HTTP request execution point**

Read `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` — find where the actual HTTP request is made (axios/fetch/node:http). Determine how to inject `https.Agent` with client cert.

- [ ] **Step 2: Write the failing test**

```typescript
// packages/compiler/src/__tests__/constructs/http-tool-mtls.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('HTTP tool executor mTLS', () => {
  it('passes tlsOptions as https.Agent when auth profile returns mTLS creds', async () => {
    // Test that when applyAuth returns tlsOptions, the HTTP client
    // receives an https.Agent configured with cert, key, ca
    // Exact test depends on the HTTP client used — read first
  });
});
```

- [ ] **Step 3: Implement TLS agent injection**

When `applyAuth` (from `shared-auth-profile`) returns `tlsOptions`, create an `https.Agent`:

```typescript
import https from 'node:https';

// After applyAuth returns:
if (authResult.tlsOptions) {
  const agent = new https.Agent({
    cert: authResult.tlsOptions.cert,
    key: authResult.tlsOptions.key,
    ca: authResult.tlsOptions.ca,
    rejectUnauthorized: true,
  });
  requestConfig.httpsAgent = agent; // for axios
  // or: requestConfig.agent = agent; // for node:http
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && pnpm vitest run src/__tests__/constructs/http-tool-mtls.test.ts`
Expected: PASS

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/constructs/executors/http-tool-executor.ts packages/compiler/src/__tests__/constructs/http-tool-mtls.test.ts
git add packages/compiler/src/platform/constructs/executors/http-tool-executor.ts packages/compiler/src/__tests__/constructs/http-tool-mtls.test.ts
git commit -m "feat(runtime): wire mTLS tlsOptions into HTTPS agent for tool calls"
```

---

### Task 8: Bulk Actions API

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts`
- Create: `apps/studio/src/app/api/auth-profiles/bulk/route.ts`
- Test: `apps/studio/src/__tests__/api/auth-profiles-bulk.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/studio/src/__tests__/api/auth-profiles-bulk.test.ts
import { describe, it, expect } from 'vitest';

describe('POST /api/projects/:id/auth-profiles/bulk', () => {
  it('validates action is one of delete, revoke, activate', () => {
    // Schema validation test
  });

  it('limits to 50 profiles per request', () => {
    // Max length validation test
  });

  it('verifies tenant isolation on each profile', () => {
    // Each profile must belong to the requesting tenant
  });

  it('returns per-profile results', () => {
    // Returns { success: true, results: [{ id, status }] }
  });
});
```

- [ ] **Step 2: Create project-scoped bulk endpoint**

```typescript
// apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { AuthProfile } from '@abl/database';

const BulkActionSchema = z.object({
  action: z.enum(['delete', 'revoke', 'activate']),
  profileIds: z.array(z.string().min(1)).min(1).max(50),
});

export const POST = withRouteHandler(
  async (req: NextRequest, { params, user, tenantId }) => {
    const body = await req.json();
    const { action, profileIds } = BulkActionSchema.parse(body);
    const projectId = params.id;

    const results = await Promise.all(
      profileIds.map(async (id) => {
        try {
          const profile = await AuthProfile.findOne({ _id: id, tenantId, projectId });
          if (!profile) {
            return { id, status: 'error' as const, error: 'Not found' };
          }

          switch (action) {
            case 'delete':
              await AuthProfile.deleteOne({ _id: id, tenantId, projectId });
              break;
            case 'revoke':
              await AuthProfile.updateOne({ _id: id, tenantId, projectId }, { status: 'revoked' });
              break;
            case 'activate':
              await AuthProfile.updateOne({ _id: id, tenantId, projectId }, { status: 'active' });
              break;
          }
          return { id, status: 'ok' as const };
        } catch (err) {
          return {
            id,
            status: 'error' as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return NextResponse.json({ success: true, data: { results } });
  },
  { requireProject: true, permission: 'AUTH_PROFILE_WRITE' },
);
```

- [ ] **Step 3: Create workspace-scoped bulk endpoint**

Same pattern but with `projectId: null` scope check.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/api/auth-profiles-bulk.test.ts`
Expected: PASS

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts apps/studio/src/app/api/auth-profiles/bulk/route.ts
git add apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts apps/studio/src/app/api/auth-profiles/bulk/route.ts apps/studio/src/__tests__/api/auth-profiles-bulk.test.ts
git commit -m "feat(studio): add bulk action endpoints for auth profiles (delete/revoke/activate)"
```

---

### Task 9: Config Variable Resolution for authProfileRef

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:2657-2710` (resolveConfigVariables)
- Test: `packages/compiler/src/__tests__/ir/config-variable-auth-profile.test.ts`

- [ ] **Step 1: Verify config variable resolution already covers tool http_binding fields**

Read `packages/compiler/src/platform/ir/compiler.ts` lines 2657-2710 — check if the recursive walk covers `tools[].http_binding` fields. If it does, `{{config.X}}` in `authProfileRef` will be resolved automatically. If not, add the path.

- [ ] **Step 2: Write the test**

```typescript
// packages/compiler/src/__tests__/ir/config-variable-auth-profile.test.ts
import { describe, it, expect } from 'vitest';
import { compile } from '../../index.js';

describe('config variable resolution for authProfileRef', () => {
  it('resolves {{config.X}} in authProfileRef', () => {
    const dsl = `
AGENT: bot
  IDENTITY:
    role: helper
  TOOLS:
    - my-tool
`;
    const toolFile = `
TOOL: my-tool
  type: http
  description: API call
  endpoint: https://api.example.com
  method: GET
  auth_profile: "{{config.API_PROFILE}}"
`;
    const result = compile(dsl, {
      toolFiles: [{ name: 'tools.tool', content: toolFile }],
      configVariables: { API_PROFILE: 'production-creds' },
    });

    const tool = result.ir?.agents[0]?.tools?.find((t: any) => t.name === 'my-tool');
    expect(tool?.http_binding?.authProfileRef).toBe('production-creds');
  });
});
```

- [ ] **Step 3: If needed, add http_binding.authProfileRef to the config var resolution walk**

- [ ] **Step 4: Run test and commit**

```bash
npx prettier --write packages/compiler/src/__tests__/ir/config-variable-auth-profile.test.ts
git add packages/compiler/src/__tests__/ir/config-variable-auth-profile.test.ts
git commit -m "test(compiler): verify config variable resolution covers authProfileRef"
```

---

## Chunk 2: JIT Auth (Tasks 10-16)

### Task 10: Add `jitAuth` to DSL and IR

**Files:**

- Modify: `packages/core/src/parser/tool-file-parser.ts`
- Modify: `packages/compiler/src/platform/ir/schema.ts:552-632` (ToolDefinition)
- Modify: `packages/compiler/src/platform/ir/compiler.ts` (tool compilation)
- Test: `packages/core/src/__tests__/parser/tool-file-jit-auth.test.ts`
- Test: `packages/compiler/src/__tests__/ir/jit-auth-compilation.test.ts`

- [ ] **Step 1: Write parser test**

```typescript
// packages/core/src/__tests__/parser/tool-file-jit-auth.test.ts
import { describe, it, expect } from 'vitest';
import { parseToolFile } from '../../parser/tool-file-parser.js';

describe('tool-file-parser auth_jit', () => {
  it('parses auth_jit: true on HTTP tools', () => {
    const input = `
TOOL: google-drive
  type: http
  description: List Google Drive files
  endpoint: https://www.googleapis.com/drive/v3/files
  method: GET
  auth: oauth2_user
  auth_jit: true
`;
    const result = parseToolFile(input, 'test.tool');
    expect(result.tools[0].jitAuth).toBe(true);
  });

  it('defaults jitAuth to false when not specified', () => {
    const input = `
TOOL: simple-api
  type: http
  description: Simple call
  endpoint: https://api.example.com
  method: GET
`;
    const result = parseToolFile(input, 'test.tool');
    expect(result.tools[0].jitAuth).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/parser/tool-file-jit-auth.test.ts`

- [ ] **Step 3: Add auth_jit parsing in tool-file-parser.ts**

Add variable: `let jitAuth: boolean | undefined;`
Add case:

```typescript
case 'auth_jit':
  jitAuth = value === 'true';
  break;
```

Add to result: `result.tools[0].jitAuth = jitAuth;` (or wherever tool properties are set)

- [ ] **Step 4: Add `jitAuth?: boolean` to ToolDefinition in IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add to `ToolDefinition` (line ~632):

```typescript
jitAuth?: boolean;
```

- [ ] **Step 5: Thread jitAuth through compiler**

In the tool compilation function, pass `jitAuth` from AST to IR.

- [ ] **Step 6: Write and run compiler test**

```typescript
// packages/compiler/src/__tests__/ir/jit-auth-compilation.test.ts
import { describe, it, expect } from 'vitest';
import { compile } from '../../index.js';

describe('jitAuth IR compilation', () => {
  it('emits jitAuth: true on ToolDefinition IR', () => {
    const dsl = `AGENT: bot\n  IDENTITY:\n    role: helper\n  TOOLS:\n    - gdrive`;
    const toolFile = `TOOL: gdrive\n  type: http\n  description: Drive\n  endpoint: https://googleapis.com/drive\n  method: GET\n  auth_jit: true`;
    const result = compile(dsl, { toolFiles: [{ name: 't.tool', content: toolFile }] });
    const tool = result.ir?.agents[0]?.tools?.find((t: any) => t.name === 'gdrive');
    expect(tool?.jitAuth).toBe(true);
  });
});
```

- [ ] **Step 7: Run all tests, prettier, commit**

```bash
npx prettier --write packages/core/src/parser/tool-file-parser.ts packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/ir/compiler.ts
git commit -m "feat(dsl): add auth_jit property to tool definitions"
```

---

### Task 11: WebSocket Auth Challenge Protocol

**Files:**

- Modify: `apps/runtime/src/types/index.ts:278-421` (ClientMessage + ServerMessage unions)
- Modify: `apps/runtime/src/websocket/events.ts:22-315` (parseClientMessage + ServerMessages factory)
- Test: `apps/runtime/src/__tests__/websocket/auth-challenge-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/websocket/auth-challenge-protocol.test.ts
import { describe, it, expect } from 'vitest';

describe('Auth challenge WebSocket protocol', () => {
  it('ServerMessages.authChallenge creates correct message shape', async () => {
    const { ServerMessages } = await import('../../websocket/events.js');
    const msg = ServerMessages.authChallenge({
      toolCallId: 'tc-1',
      authType: 'oauth2_user',
      authUrl: 'https://accounts.google.com/o/oauth2/auth?...',
      profileId: 'prof-1',
      profileName: 'google-drive-creds',
      prompt: 'This tool requires Google authorization',
      timeoutMs: 600000,
    });
    expect(msg.type).toBe('auth_challenge');
    expect(msg.toolCallId).toBe('tc-1');
  });

  it('parseClientMessage handles auth_response', async () => {
    const { parseClientMessage } = await import('../../websocket/events.js');
    const raw = JSON.stringify({
      type: 'auth_response',
      toolCallId: 'tc-1',
      status: 'completed',
    });
    const msg = parseClientMessage(raw);
    expect(msg.type).toBe('auth_response');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add types to ClientMessage and ServerMessage unions**

In `apps/runtime/src/types/index.ts`:

Add to `ServerMessage` union:

```typescript
| {
    type: 'auth_challenge';
    toolCallId: string;
    authType: string;
    authUrl?: string;
    profileId: string;
    profileName: string;
    prompt: string;
    timeoutMs: number;
  }
```

Add to `ClientMessage` union:

```typescript
| {
    type: 'auth_response';
    toolCallId: string;
    status: 'completed' | 'cancelled';
  }
```

- [ ] **Step 4: Add to events.ts**

In `ServerMessages` factory, add:

```typescript
authChallenge: (params: { toolCallId: string; authType: string; authUrl?: string; profileId: string; profileName: string; prompt: string; timeoutMs: number; }): ServerMessage => ({
  type: 'auth_challenge' as const,
  ...params,
}),
```

In `parseClientMessage`, add case:

```typescript
case 'auth_response':
  return { type: 'auth_response', toolCallId: parsed.toolCallId, status: parsed.status };
```

- [ ] **Step 5: Run test, prettier, commit**

```bash
git commit -m "feat(runtime): add auth_challenge/auth_response WebSocket message types"
```

---

### Task 12: Paused Execution Store

**Files:**

- Create: `apps/runtime/src/services/jit-auth/paused-execution-store.ts`
- Test: `apps/runtime/src/__tests__/jit-auth/paused-execution-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/jit-auth/paused-execution-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('PausedExecutionStore', () => {
  it('pause() stores state and returns a promise', async () => {
    // Create store with mock Redis
    // Call pause(sessionId, toolCallId, params)
    // Verify Redis SET was called with correct key and TTL
    // Promise should be pending
  });

  it('resume() resolves the waiting promise', async () => {
    // pause() then resume()
    // Promise should resolve
  });

  it('cancel() rejects the waiting promise with AuthCancelledError', async () => {
    // pause() then cancel()
    // Promise should reject
  });

  it('cleanupSession() removes all paused executions for a session', async () => {
    // pause() two tool calls
    // cleanupSession()
    // Both promises should reject
  });

  it('TTL expiry rejects with AuthTimeoutError', async () => {
    vi.useFakeTimers();
    // pause() with short timeout
    // Advance time past timeout
    // Promise should reject with AuthTimeoutError
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Implement the store**

```typescript
// apps/runtime/src/services/jit-auth/paused-execution-store.ts
import { createLogger } from '@abl/compiler/platform';
import type { Redis } from 'ioredis';

const log = createLogger('jit-auth');

export class AuthTimeoutError extends Error {
  constructor(toolCallId: string) {
    super(`JIT auth timed out for tool call ${toolCallId}`);
    this.name = 'AuthTimeoutError';
  }
}

export class AuthCancelledError extends Error {
  constructor(toolCallId: string) {
    super(`JIT auth cancelled for tool call ${toolCallId}`);
    this.name = 'AuthCancelledError';
  }
}

interface PausedExecution {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PausedExecutionStore {
  private readonly pending = new Map<string, PausedExecution>();

  constructor(
    private readonly redis: Redis,
    private readonly defaultTimeoutMs: number = 600000, // 10 min
  ) {}

  private key(sessionId: string, toolCallId: string): string {
    return `paused-exec:${sessionId}:${toolCallId}`;
  }

  async pause(
    sessionId: string,
    toolCallId: string,
    params: { authProfileRef: string; authType: string },
    timeoutMs?: number,
  ): Promise<void> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const redisKey = this.key(sessionId, toolCallId);

    await this.redis.set(redisKey, JSON.stringify(params), 'PX', timeout);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(redisKey);
        this.redis.del(redisKey).catch(() => {});
        reject(new AuthTimeoutError(toolCallId));
      }, timeout);

      this.pending.set(redisKey, { resolve, reject, timer });
    });
  }

  resume(sessionId: string, toolCallId: string): void {
    const redisKey = this.key(sessionId, toolCallId);
    const entry = this.pending.get(redisKey);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(redisKey);
      this.redis.del(redisKey).catch(() => {});
      entry.resolve();
    }
  }

  cancel(sessionId: string, toolCallId: string): void {
    const redisKey = this.key(sessionId, toolCallId);
    const entry = this.pending.get(redisKey);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(redisKey);
      this.redis.del(redisKey).catch(() => {});
      entry.reject(new AuthCancelledError(toolCallId));
    }
  }

  cleanupSession(sessionId: string): void {
    const prefix = `paused-exec:${sessionId}:`;
    for (const [key, entry] of this.pending) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        entry.reject(new AuthCancelledError(key));
        this.pending.delete(key);
        this.redis.del(key).catch(() => {});
      }
    }
  }
}
```

- [ ] **Step 3: Run tests, prettier, commit**

```bash
git commit -m "feat(runtime): add PausedExecutionStore for JIT auth pause/resume"
```

---

### Task 13: Wire JIT Auth into Tool Executor

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Modify: `apps/runtime/src/websocket/handler.ts:696-780` (add auth_response handling)
- Test: `apps/runtime/src/__tests__/jit-auth/tool-executor-jit.test.ts`

- [ ] **Step 1: Write the test**

Test that when a tool has `jitAuth: true` and the auth profile has no token, the executor:

1. Sends `auth_challenge` via WebSocket
2. Awaits the `PausedExecutionStore.pause()` promise
3. On resume, retries the tool call with fresh credentials

- [ ] **Step 2: Add JIT auth check in tool executor**

In the `applyAuth` method of `http-tool-executor.ts`, after auth profile resolution fails to find credentials:

```typescript
if (binding.jitAuth && !credentials) {
  // Emit auth_challenge to the client
  const challenge = ServerMessages.authChallenge({
    toolCallId: this.currentToolCallId,
    authType: binding.auth.type,
    authUrl: await this.toolOAuthService?.initiateJitOAuth(binding.authProfileRef, sessionId),
    profileId: binding.authProfileRef,
    profileName: binding.authProfileRef,
    prompt: `This tool requires ${binding.auth.type} authorization`,
    timeoutMs: this.jitTimeoutMs,
  });
  this.ws.send(serializeServerMessage(challenge));

  // Wait for user to complete auth
  await this.pausedExecutionStore.pause(sessionId, toolCallId, {
    authProfileRef: binding.authProfileRef,
    authType: binding.auth.type,
  });

  // Retry credential resolution after auth completes
  credentials = await resolver.resolveByName(binding.authProfileRef, tenantId);
}
```

- [ ] **Step 3: Add auth_response handler in WebSocket handler**

In `apps/runtime/src/websocket/handler.ts`, add to the message type switch (~line 696):

```typescript
case 'auth_response': {
  const { toolCallId, status } = message;
  const store = getPausedExecutionStore();
  if (status === 'completed') {
    store.resume(sessionId, toolCallId);
  } else {
    store.cancel(sessionId, toolCallId);
  }
  break;
}
```

- [ ] **Step 4: Add session cleanup on disconnect**

In the `ws.on('close')` handler (~line 571), add:

```typescript
// Clean up any paused JIT auth executions
try {
  const store = getPausedExecutionStore();
  store.cleanupSession(sessionId);
} catch {
  /* non-fatal */
}
```

- [ ] **Step 5: Run tests, prettier, commit**

```bash
git commit -m "feat(runtime): wire JIT auth into tool executor with pause/resume"
```

---

### Task 14: JIT OAuth Flow

**Files:**

- Modify: `apps/runtime/src/services/tool-oauth-service.ts`
- Test: `apps/runtime/src/__tests__/jit-auth/jit-oauth-flow.test.ts`

- [ ] **Step 1: Write the test**

```typescript
describe('ToolOAuthService.initiateJitOAuth', () => {
  it('generates OAuth URL for the auth profile provider', async () => {
    // Mock auth profile lookup to get provider config
    // Call initiateJitOAuth(profileId, sessionId, toolCallId)
    // Verify it returns an authUrl with correct client_id, redirect_uri, state
  });

  it('stores JIT-specific state for callback correlation', async () => {
    // State should include sessionId and toolCallId for resumption
  });
});
```

- [ ] **Step 2: Add initiateJitOAuth to ToolOAuthService**

```typescript
async initiateJitOAuth(
  authProfileRef: string,
  sessionId: string,
  toolCallId: string,
): Promise<string | undefined> {
  // Look up the auth profile to get OAuth provider config
  const profile = await this.authProfileResolver?.resolveProfileConfig(authProfileRef);
  if (!profile || !profile.config?.oauth) return undefined;

  const state = crypto.randomBytes(32).toString('hex');
  await this.stateStore.set(state, {
    type: 'jit',
    sessionId,
    toolCallId,
    profileId: profile.id,
    expiresAt: Date.now() + 600000,
  });

  const params = new URLSearchParams({
    client_id: profile.config.oauth.clientId,
    redirect_uri: this.redirectUri,
    response_type: 'code',
    scope: profile.config.oauth.scopes?.join(' ') || '',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `${profile.config.oauth.authUrl}?${params}`;
}
```

- [ ] **Step 3: Modify OAuth callback to detect JIT state and resume execution**

In the callback handler, after exchanging code for token:

```typescript
if (pendingState.type === 'jit') {
  // Notify the paused execution to resume
  const store = getPausedExecutionStore();
  store.resume(pendingState.sessionId, pendingState.toolCallId);
}
```

- [ ] **Step 4: Run tests, prettier, commit**

```bash
git commit -m "feat(runtime): add initiateJitOAuth for mid-conversation OAuth flows"
```

---

### Task 15: Studio AuthChallengeMessage Component

**Files:**

- Create: `apps/studio/src/components/chat/AuthChallengeMessage.tsx`
- Modify: `apps/studio/src/components/chat/MessageList.tsx` (render auth challenges)
- Test: Manual — verify in Studio chat UI

- [ ] **Step 1: Create the component**

```tsx
// apps/studio/src/components/chat/AuthChallengeMessage.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Shield, ExternalLink, X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AuthChallengeMessageProps {
  toolCallId: string;
  authType: string;
  authUrl?: string;
  profileName: string;
  prompt: string;
  timeoutMs: number;
  onResponse: (toolCallId: string, status: 'completed' | 'cancelled') => void;
}

export function AuthChallengeMessage({
  toolCallId,
  authType,
  authUrl,
  profileName,
  prompt,
  timeoutMs,
  onResponse,
}: AuthChallengeMessageProps) {
  const [status, setStatus] = useState<'pending' | 'waiting' | 'completed' | 'cancelled'>(
    'pending',
  );
  const [remainingMs, setRemainingMs] = useState(timeoutMs);

  useEffect(() => {
    if (status !== 'pending' && status !== 'waiting') return;
    const interval = setInterval(() => {
      setRemainingMs((prev) => {
        if (prev <= 1000) {
          setStatus('cancelled');
          onResponse(toolCallId, 'cancelled');
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [status, toolCallId, onResponse]);

  const handleAuthorize = useCallback(() => {
    if (!authUrl) return;
    setStatus('waiting');

    const popup = window.open(authUrl, 'jit-auth-popup', 'width=600,height=700');

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'auth-profile-oauth-callback') {
        setStatus('completed');
        onResponse(toolCallId, 'completed');
        window.removeEventListener('message', handleMessage);
      }
    };
    window.addEventListener('message', handleMessage);

    // Poll for popup close
    const pollTimer = setInterval(() => {
      if (popup?.closed) {
        clearInterval(pollTimer);
        if (status === 'waiting') {
          setStatus('cancelled');
          onResponse(toolCallId, 'cancelled');
        }
        window.removeEventListener('message', handleMessage);
      }
    }, 500);
  }, [authUrl, toolCallId, onResponse, status]);

  const remainingSec = Math.ceil(remainingMs / 1000);

  return (
    <div className="flex gap-3 items-start px-4 py-3">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-warning-subtle flex items-center justify-center">
        <Shield className="w-4 h-4 text-warning" />
      </div>
      <div className="flex-1 space-y-2">
        <p className="text-sm text-foreground">{prompt}</p>
        <div className="flex items-center gap-2">
          {status === 'pending' && authUrl && (
            <Button size="sm" variant="outline" onClick={handleAuthorize}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              Authorize {profileName}
            </Button>
          )}
          {status === 'waiting' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Waiting for authorization...
            </div>
          )}
          {status === 'completed' && (
            <div className="flex items-center gap-2 text-sm text-success">
              <Check className="w-3.5 h-3.5" />
              Authorized
            </div>
          )}
          {status === 'cancelled' && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <X className="w-3.5 h-3.5" />
              Authorization cancelled
            </div>
          )}
          {(status === 'pending' || status === 'waiting') && (
            <span className="text-xs text-muted-foreground">{remainingSec}s remaining</span>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into MessageList**

In `apps/studio/src/components/chat/MessageList.tsx`, add handling for `auth_challenge` messages in the message rendering loop. The exact integration depends on how the WebSocket messages are mapped to `SessionMessage` — may need a new `role` or `metadata.type` value.

- [ ] **Step 3: Run prettier and commit**

```bash
git commit -m "feat(studio): add AuthChallengeMessage component for JIT auth in chat"
```

---

### Task 16: SDK Auth Challenge Support

**Files:**

- Modify: SDK WebSocket client (find the SDK package)
- Test: SDK test file

- [ ] **Step 1: Find the SDK package**

Search for the SDK WebSocket client in the codebase.

- [ ] **Step 2: Add onAuthChallenge callback**

```typescript
interface SDKClientOptions {
  // ... existing options
  onAuthChallenge?: (challenge: AuthChallengeMessage) => Promise<'completed' | 'cancelled'>;
}
```

In the message handler, add:

```typescript
case 'auth_challenge': {
  const status = this.options.onAuthChallenge
    ? await this.options.onAuthChallenge(message)
    : 'cancelled';
  this.send({ type: 'auth_response', toolCallId: message.toolCallId, status });
  break;
}
```

Default behavior when no callback: log the auth URL and cancel.

- [ ] **Step 3: Run tests, prettier, commit**

```bash
git commit -m "feat(sdk): add onAuthChallenge callback for JIT auth support"
```

---

## Implementation Order Summary

| Task | Component                             | Depends On      | Est. Complexity |
| ---- | ------------------------------------- | --------------- | --------------- |
| 1    | Rotation job scheduling               | None            | Low             |
| 2    | Grace period wiring                   | None            | Low             |
| 3    | Name-based resolution                 | None            | Medium          |
| 4    | DSL auth_profile parsing              | None            | Low             |
| 5    | IR authProfileRef + compiler          | Task 4          | Medium          |
| 6    | Runtime auth profile in tool executor | Tasks 3, 5      | Medium          |
| 7    | mTLS TLS agent wiring                 | Task 6          | Low             |
| 8    | Bulk actions API                      | None            | Medium          |
| 9    | Config variable resolution            | Task 5          | Low             |
| 10   | JIT auth DSL + IR                     | Task 4 pattern  | Low             |
| 11   | WebSocket auth challenge protocol     | None            | Medium          |
| 12   | Paused execution store                | None            | Medium          |
| 13   | Wire JIT into tool executor           | Tasks 6, 11, 12 | High            |
| 14   | JIT OAuth flow                        | Tasks 12, 13    | High            |
| 15   | Studio AuthChallengeMessage           | Task 11         | Medium          |
| 16   | SDK auth challenge support            | Task 11         | Low             |

### Parallelization Groups

**Group A (independent, can run in parallel):** Tasks 1, 2, 3, 4, 8
**Group B (depends on Group A):** Tasks 5, 9 (depend on 4), Task 6 (depends on 3, 5)
**Group C (depends on Group B):** Task 7 (depends on 6)
**Group D (JIT, mostly independent):** Tasks 10, 11, 12 (can run in parallel)
**Group E (JIT wiring):** Task 13 (depends on 6, 11, 12), Task 14 (depends on 12, 13)
**Group F (JIT UI):** Tasks 15, 16 (depend on 11)
