# Arch AI Auth Ops Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable solution architects to create, manage, and validate auth profiles through Arch's in-project chat using a new `auth_ops` tool and a secure `collect_secret` widget for credential collection.

**Architecture:** New `auth_ops` server-side tool proxies to existing REST API endpoints via a translation layer. A new `collect_secret` client-side tool collects secrets via a password-masked widget, storing them in a flow-scoped Redis/in-memory hybrid store that never persists to MongoDB or LLM context. Both tools are registered in the message route's `buildInProjectTools()` and gated to the `integration-methodologist` specialist via `IN_PROJECT_SPECIALIST_TOOL_MAP`.

**Tech Stack:** TypeScript, Next.js route handlers, Vercel AI SDK `tool()`, Redis (ioredis) with in-memory fallback, Zod, React (arch-v3 widgets), Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-arch-auth-ops-tool-design.md`

---

## File Structure

### New Files

| File                                                         | Responsibility                                        |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/secret-store.ts`          | Flow-scoped secret store (Redis + in-memory fallback) |
| `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`              | auth_ops tool executor with translation layer         |
| `apps/studio/src/components/arch-v3/widgets/SecretInput.tsx` | Password-masked input widget for collect_secret       |
| `apps/studio/src/__tests__/arch-ai/secret-store.test.ts`     | Secret store unit tests                               |
| `apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`         | Auth ops translation + validation tests               |

### Modified Files

| File                                                                    | Change                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/arch-ai/src/types/tools.ts`                                   | Add `auth_ops` + `collect_secret` to ToolName, IN_PROJECT_TOOLS, CLIENT_SIDE_TOOLS |
| `packages/arch-ai/src/types/message-request.ts`                         | Add `secrets` field to tool_answer variant                                         |
| `packages/arch-ai/src/prompts/phases/in-project.ts`                     | Add tools to Available tools + Capabilities                                        |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | Add auth workflow guidance                                                         |
| `apps/studio/src/lib/arch-ai/guards.ts`                                 | Add auth_ops permission + dangerous action maps                                    |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                      | Register tools, tool map, secret store population                                  |
| `apps/studio/src/hooks/useArchChat.ts`                                  | Extend sendToolAnswer with secrets param                                           |
| `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx`         | Add collect_secret rendering branch                                                |
| `apps/studio/src/components/arch-v3/widgets/types.ts`                   | Add SecretInputInput type                                                          |

---

### Task 1: Shared Contracts — Tool Registry + Message Schema

**Files:**

- Modify: `packages/arch-ai/src/types/tools.ts`
- Modify: `packages/arch-ai/src/types/message-request.ts`
- Modify: `packages/arch-ai/src/types/constants.ts` (verify no changes needed)

- [ ] **Step 1: Add auth_ops and collect_secret to ToolName union**

In `packages/arch-ai/src/types/tools.ts`, add to the `ToolName` type union:

```typescript
export type ToolName =
  | 'ask_user'
  | 'collect_file'
  | 'update_specification'
  | 'generate_topology'
  | 'generate_agent'
  | 'compile_abl'
  | 'propose_modification'
  | 'create_project'
  | 'proceed_to_next_phase'
  | 'query_traces'
  | 'run_test'
  | 'health_check'
  | 'read_agent'
  | 'apply_modification'
  | 'read_journal'
  | 'read_topology'
  | 'recommend_model'
  | 'analyze_constraints'
  | 'read_insights'
  | 'validate_agent'
  | 'diagnose_project'
  | 'explain_diagnostic'
  | 'dismiss_proposal'
  | 'auth_ops'
  | 'collect_secret';
```

- [ ] **Step 2: Add to IN_PROJECT_TOOLS array**

In the same file, add both tools to `IN_PROJECT_TOOLS`:

```typescript
export const IN_PROJECT_TOOLS: readonly ToolName[] = [
  'ask_user',
  'collect_file',
  'propose_modification',
  'apply_modification',
  'query_traces',
  'run_test',
  'health_check',
  'compile_abl',
  'dismiss_proposal',
  'read_agent',
  'read_journal',
  'read_topology',
  'recommend_model',
  'analyze_constraints',
  'read_insights',
  'validate_agent',
  'diagnose_project',
  'explain_diagnostic',
  'auth_ops',
  'collect_secret',
] as const;
```

- [ ] **Step 3: Add collect_secret to CLIENT_SIDE_TOOLS**

```typescript
export const CLIENT_SIDE_TOOLS: readonly ToolName[] = [
  'ask_user',
  'collect_file',
  'collect_secret',
] as const;
```

- [ ] **Step 4: Add secrets field to MessageRequestSchema tool_answer variant**

In `packages/arch-ai/src/types/message-request.ts`, update the `tool_answer` variant:

```typescript
z.object({
  sessionId: z.string().min(1),
  type: z.literal('tool_answer'),
  toolCallId: z.string().min(1),
  answer: z.unknown(),
  secrets: z
    .object({
      flowId: z.string().min(1),
      values: z.record(z.string(), z.string()),
    })
    .optional(),
}),
```

- [ ] **Step 5: Build the arch-ai package to verify types compile**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Build succeeds with no type errors

- [ ] **Step 6: Run existing arch-ai tests**

Run: `pnpm test --filter=@agent-platform/arch-ai`
Expected: All existing tests pass (message-request.test.ts should still pass since the new field is optional)

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/arch-ai/src/types/tools.ts packages/arch-ai/src/types/message-request.ts
git add packages/arch-ai/src/types/tools.ts packages/arch-ai/src/types/message-request.ts
git commit -m "[ABLP-162] feat(arch-ai): add auth_ops and collect_secret to shared tool contracts"
```

---

### Task 2: Flow-Scoped Secret Store

**Files:**

- Create: `apps/studio/src/lib/arch-ai/tools/secret-store.ts`
- Create: `apps/studio/src/__tests__/arch-ai/secret-store.test.ts`

- [ ] **Step 1: Write failing tests for secret store**

Create `apps/studio/src/__tests__/arch-ai/secret-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock redis-client before importing secret-store
vi.mock('@/lib/redis-client', () => ({
  isRedisAvailable: vi.fn(() => false),
  getRedisClient: vi.fn(() => null),
}));

import {
  setFlowSecrets,
  consumeFlowSecrets,
  _getMemSecretsForTest,
} from '@/lib/arch-ai/tools/secret-store';

describe('secret-store (in-memory fallback)', () => {
  beforeEach(() => {
    // Clear in-memory store between tests
    const mem = _getMemSecretsForTest();
    mem.clear();
  });

  it('stores and consumes secrets by flowId', async () => {
    await setFlowSecrets('flow-1', { clientId: 'id-123' });
    await setFlowSecrets('flow-1', { clientSecret: 'secret-456' });

    const secrets = await consumeFlowSecrets('flow-1');
    expect(secrets).toEqual({ clientId: 'id-123', clientSecret: 'secret-456' });
  });

  it('returns null after secrets are consumed (atomic delete)', async () => {
    await setFlowSecrets('flow-1', { apiKey: 'key-abc' });
    await consumeFlowSecrets('flow-1');

    const second = await consumeFlowSecrets('flow-1');
    expect(second).toBeNull();
  });

  it('consumes and deletes even when caller does not use the result', async () => {
    await setFlowSecrets('flow-fail', { clientId: 'id' });
    // Simulate: auth_ops consumes secrets, then the API call fails
    const secrets = await consumeFlowSecrets('flow-fail');
    expect(secrets).toEqual({ clientId: 'id' });
    // Next attempt with same flowId gets null — must start new flow
    expect(await consumeFlowSecrets('flow-fail')).toBeNull();
  });

  it('isolates concurrent flows in the same session', async () => {
    await setFlowSecrets('flow-a', { clientId: 'a-id' });
    await setFlowSecrets('flow-b', { clientId: 'b-id' });

    const a = await consumeFlowSecrets('flow-a');
    expect(a).toEqual({ clientId: 'a-id' });

    // flow-b is untouched
    const b = await consumeFlowSecrets('flow-b');
    expect(b).toEqual({ clientId: 'b-id' });
  });

  it('expires secrets after TTL', async () => {
    vi.useFakeTimers();
    await setFlowSecrets('flow-ttl', { token: 'tok' });

    // Advance past 15 min TTL
    vi.advanceTimersByTime(16 * 60 * 1000);

    const secrets = await consumeFlowSecrets('flow-ttl');
    expect(secrets).toBeNull();
    vi.useRealTimers();
  });

  it('returns null for non-existent flowId', async () => {
    const secrets = await consumeFlowSecrets('does-not-exist');
    expect(secrets).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/secret-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the secret store**

Create `apps/studio/src/lib/arch-ai/tools/secret-store.ts`:

```typescript
/**
 * Flow-Scoped Secret Store
 *
 * Hybrid Redis/in-memory store for transient auth credentials collected
 * via the collect_secret tool. Follows the pattern from sso-state-store.ts.
 *
 * Key properties:
 * - Flow-scoped: keyed by flowId (UUIDv4), not sessionId
 * - Atomic consume: GETDEL on Redis prevents concurrent read races
 * - Never persisted to MongoDB or LLM context
 * - TTL-evicted after 15 minutes
 */

import { isRedisAvailable, getRedisClient } from '@/lib/redis-client';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('arch-ai:secret-store');

const REDIS_PREFIX = 'arch:secret:';
const SECRET_TTL_SECONDS = 900; // 15 minutes
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds

// In-memory fallback (single-process only)
const memSecrets = new Map<string, { data: Record<string, string>; expiresAt: number }>();

// Periodic cleanup of expired in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memSecrets) {
    if (v.expiresAt < now) memSecrets.delete(k);
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Store or merge secrets for a flow. Accumulates across multiple
 * collect_secret calls with the same flowId.
 */
export async function setFlowSecrets(
  flowId: string,
  secrets: Record<string, string>,
): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    try {
      const existing = await redis.get(`${REDIS_PREFIX}${flowId}`);
      const merged = { ...(existing ? JSON.parse(existing) : {}), ...secrets };
      await redis.set(`${REDIS_PREFIX}${flowId}`, JSON.stringify(merged), 'EX', SECRET_TTL_SECONDS);
      return;
    } catch (err) {
      log.error('Redis setFlowSecrets failed, falling through to in-memory', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const entry = memSecrets.get(flowId);
  const merged = { ...(entry?.data ?? {}), ...secrets };
  memSecrets.set(flowId, {
    data: merged,
    expiresAt: Date.now() + SECRET_TTL_SECONDS * 1000,
  });
}

/**
 * Atomically consume (read + delete) all secrets for a flow.
 * Returns null if flowId doesn't exist or is expired.
 * Uses Redis GETDEL for atomicity.
 */
export async function consumeFlowSecrets(flowId: string): Promise<Record<string, string> | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    try {
      const raw = await redis.getdel(`${REDIS_PREFIX}${flowId}`);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      log.error('Redis consumeFlowSecrets failed, falling through to in-memory', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const entry = memSecrets.get(flowId);
  memSecrets.delete(flowId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}

/** Exposed for testing only — do not use in production code */
export function _getMemSecretsForTest(): Map<
  string,
  { data: Record<string, string>; expiresAt: number }
> {
  return memSecrets;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/secret-store.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/secret-store.ts apps/studio/src/__tests__/arch-ai/secret-store.test.ts
git add apps/studio/src/lib/arch-ai/tools/secret-store.ts apps/studio/src/__tests__/arch-ai/secret-store.test.ts
git commit -m "[ABLP-162] feat(studio): add flow-scoped secret store for auth credential collection"
```

---

### Task 3: Permission Guards

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/guards.ts`

- [ ] **Step 1: Add auth_ops to ACTION_TO_PERMISSION**

In `guards.ts`, add the `auth_ops` entry after `platform_context` in the `ACTION_TO_PERMISSION` map:

```typescript
auth_ops: {
  read: 'auth_profile:read',
  list: 'auth_profile:read',
  create: 'auth_profile:write',
  update: 'auth_profile:write',
  delete: 'auth_profile:delete',
  validate: 'auth_profile:write',
},
```

- [ ] **Step 2: Add auth_ops to DANGEROUS_ACTIONS**

```typescript
auth_ops: ['delete'],
```

- [ ] **Step 3: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/guards.ts
git add apps/studio/src/lib/arch-ai/guards.ts
git commit -m "[ABLP-162] feat(studio): add auth_ops permission mapping and dangerous action gate"
```

---

### Task 4: Auth Ops Tool Executor

**Files:**

- Create: `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`
- Create: `apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`

- [ ] **Step 1: Write failing tests for the translation layer and validation**

Create `apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock secret-store
vi.mock('@/lib/arch-ai/tools/secret-store', () => ({
  consumeFlowSecrets: vi.fn(),
}));

// Mock cache-invalidation
vi.mock('@/lib/arch-ai/tools/cache-invalidation', () => ({
  invalidateProjectCaches: vi.fn(),
}));

// Mock guards
vi.mock('@/lib/arch-ai/guards', () => ({
  checkToolPermission: vi.fn(() => ({ allowed: true })),
  isDangerousAction: vi.fn(() => false),
}));

import { consumeFlowSecrets } from '@/lib/arch-ai/tools/secret-store';
import { invalidateProjectCaches } from '@/lib/arch-ai/tools/cache-invalidation';
import { executeAuthOps } from '@/lib/arch-ai/tools/auth-ops';

const mockCtx = {
  projectId: 'proj-1',
  user: {
    permissions: ['auth_profile:read', 'auth_profile:write', 'auth_profile:delete'],
    tenantId: 'tenant-1',
    userId: 'user-1',
  },
  authToken: 'test-token',
};

describe('executeAuthOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe('create — needsSecrets response', () => {
    it('returns needsSecrets with flowId when no flowId provided for api_key', async () => {
      const result = await executeAuthOps(
        {
          action: 'create',
          profileName: 'My API Key',
          authType: 'api_key',
          config: { headerName: 'X-API-Key' },
        },
        mockCtx,
      );
      expect(result).toMatchObject({
        success: false,
        needsSecrets: true,
        requiredSecrets: ['apiKey'],
      });
      expect(result.flowId).toBeDefined();
      expect(typeof result.flowId).toBe('string');
    });

    it('returns needsSecrets with clientId+clientSecret for oauth2_app', async () => {
      const result = await executeAuthOps(
        {
          action: 'create',
          profileName: 'SF OAuth',
          authType: 'oauth2_app',
          config: { authorizationUrl: 'https://x', tokenUrl: 'https://y', scopes: ['api'] },
        },
        mockCtx,
      );
      expect(result).toMatchObject({
        needsSecrets: true,
        requiredSecrets: ['clientId', 'clientSecret'],
      });
    });
  });

  describe('create — translation layer', () => {
    it('translates oauth2_app scopes to defaultScopes', async () => {
      vi.mocked(consumeFlowSecrets).mockResolvedValue({ clientId: 'cid', clientSecret: 'csec' });
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { _id: 'p1', name: 'Test', authType: 'oauth2_app', status: 'active' },
          }),
          { status: 201 },
        ),
      );

      await executeAuthOps(
        {
          action: 'create',
          profileName: 'Test',
          authType: 'oauth2_app',
          config: { authorizationUrl: 'https://a', tokenUrl: 'https://t', scopes: ['api'] },
          flowId: 'f1',
        },
        mockCtx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.config.defaultScopes).toEqual(['api']);
      expect(body.config.scopes).toBeUndefined();
      expect(body.secrets.clientId).toBe('cid');
      expect(body.secrets.clientSecret).toBe('csec');
    });

    it('auto-injects projectId, scope, visibility for api_key', async () => {
      vi.mocked(consumeFlowSecrets).mockResolvedValue({ apiKey: 'k' });
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { _id: 'p2', name: 'K', authType: 'api_key', status: 'active' },
          }),
          { status: 201 },
        ),
      );

      await executeAuthOps(
        {
          action: 'create',
          profileName: 'K',
          authType: 'api_key',
          config: { headerName: 'X-Key' },
          flowId: 'f2',
        },
        mockCtx,
      );

      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]?.body as string);
      expect(body.scope).toBe('project');
      expect(body.projectId).toBe('proj-1');
      expect(body.visibility).toBe('shared');
    });
  });

  describe('create — error handling', () => {
    it('rejects unsupported auth types', async () => {
      const result = await executeAuthOps(
        { action: 'create', profileName: 'X', authType: 'saml', config: {} },
        mockCtx,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'UNSUPPORTED_TYPE' },
      });
    });

    it('returns MISSING_PARAM when profileName is missing', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'api_key', config: {} },
        mockCtx,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'MISSING_PARAM' },
      });
    });
  });

  describe('cache invalidation', () => {
    it('calls invalidateProjectCaches after successful create', async () => {
      vi.mocked(consumeFlowSecrets).mockResolvedValue({ apiKey: 'k' });
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { _id: 'p3', name: 'T', authType: 'api_key', status: 'active' },
          }),
          { status: 201 },
        ),
      );

      await executeAuthOps(
        {
          action: 'create',
          profileName: 'T',
          authType: 'api_key',
          config: { headerName: 'H' },
          flowId: 'f3',
        },
        mockCtx,
      );

      expect(invalidateProjectCaches).toHaveBeenCalledWith('tenant-1', 'proj-1');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the auth-ops executor**

Create `apps/studio/src/lib/arch-ai/tools/auth-ops.ts`:

```typescript
/**
 * auth_ops — Arch AI tool for auth profile CRUD + validation.
 *
 * Proxies to the Studio REST API with a translation layer that maps
 * LLM-friendly input to the strict Zod-validated REST payloads.
 * Secrets come from the flow-scoped secret store, never from LLM context.
 */

import { createLogger } from '@abl/compiler/platform';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { consumeFlowSecrets } from './secret-store';
import { invalidateProjectCaches } from './cache-invalidation';
import { randomUUID } from 'crypto';

const log = createLogger('arch-ai:auth-ops');

const SUPPORTED_AUTH_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
] as const;
type SupportedAuthType = (typeof SUPPORTED_AUTH_TYPES)[number];

const REQUIRED_SECRETS: Record<SupportedAuthType, string[]> = {
  api_key: ['apiKey'],
  bearer: ['token'],
  oauth2_app: ['clientId', 'clientSecret'],
  oauth2_client_credentials: ['clientId', 'clientSecret'],
};

interface AuthOpsInput {
  action: string;
  profileId?: string;
  profileName?: string;
  authType?: string;
  config?: Record<string, unknown>;
  flowId?: string;
  confirmed?: boolean;
}

interface AuthOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsSecrets?: boolean;
  flowId?: string;
  requiredSecrets?: string[];
  message?: string;
  needsConfirmation?: boolean;
  warning?: string;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function isSupportedAuthType(t: string): t is SupportedAuthType {
  return (SUPPORTED_AUTH_TYPES as readonly string[]).includes(t);
}

function missing(param: string, action: string): AuthOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

/**
 * Translate LLM-facing config to REST API config shape.
 */
function translateConfig(
  authType: SupportedAuthType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (authType === 'oauth2_app') {
    const { scopes, ...rest } = config;
    return scopes ? { ...rest, defaultScopes: scopes } : rest;
  }
  return { ...config };
}

/**
 * Build the full REST API create payload from LLM input + secrets.
 */
function buildCreatePayload(
  input: AuthOpsInput,
  secrets: Record<string, string>,
  ctx: ToolPermissionContext,
): Record<string, unknown> {
  const authType = input.authType as SupportedAuthType;
  const config = translateConfig(authType, input.config ?? {});
  const connectionMode = authType === 'oauth2_app' ? 'per_user' : 'shared';

  return {
    name: input.profileName,
    authType,
    config,
    secrets,
    scope: 'project',
    projectId: ctx.projectId,
    visibility: 'shared',
    connectionMode,
  };
}

export async function executeAuthOps(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const { action } = input;

  const perm = await checkToolPermission('auth_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (!ctx.authToken) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for auth profile operations' },
    };
  }

  try {
    switch (action) {
      case 'list':
        return listProfiles(ctx);
      case 'read':
        if (!input.profileId) return missing('profileId', action);
        return readProfile(input.profileId, ctx);
      case 'create':
        return createProfile(input, ctx);
      case 'update':
        if (!input.profileId) return missing('profileId', action);
        return updateProfile(input, ctx);
      case 'delete': {
        if (!input.profileId) return missing('profileId', action);
        if (isDangerousAction('auth_ops', action) && !input.confirmed) {
          return {
            needsConfirmation: true,
            warning: `Delete auth profile "${input.profileId}"? Tools using it will break.`,
          };
        }
        return deleteProfile(input.profileId, ctx);
      }
      case 'validate':
        if (!input.profileId) return missing('profileId', action);
        return validateProfile(input.profileId, ctx);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('auth_ops action failed', { action, projectId: ctx.projectId, error: message });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function apiFetch(
  path: string,
  ctx: ToolPermissionContext,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.authToken}`,
      ...(options?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function listProfiles(ctx: ToolPermissionContext): Promise<AuthOpsResult> {
  const res = await apiFetch('/auth-profiles?limit=50', ctx);
  if (!res.ok) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: `Failed to list auth profiles: ${res.status}` },
    };
  }
  const body = await res.json();
  return { success: true, data: body.data ?? [] };
}

async function readProfile(profileId: string, ctx: ToolPermissionContext): Promise<AuthOpsResult> {
  const res = await apiFetch(`/auth-profiles/${profileId}`, ctx);
  if (!res.ok) {
    return {
      success: false,
      error: {
        code: res.status === 404 ? 'NOT_FOUND' : 'FETCH_ERROR',
        message: `Failed to read auth profile: ${res.status}`,
      },
    };
  }
  const body = await res.json();
  return { success: true, data: body.data };
}

async function createProfile(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  if (!input.profileName) return missing('profileName', 'create');
  if (!input.authType) return missing('authType', 'create');

  if (!isSupportedAuthType(input.authType)) {
    return {
      success: false,
      error: {
        code: 'UNSUPPORTED_TYPE',
        message: `Auth type "${input.authType}" is not supported. Use: ${SUPPORTED_AUTH_TYPES.join(', ')}`,
      },
    };
  }

  // If no flowId, the LLM hasn't collected secrets yet
  if (!input.flowId) {
    const flowId = randomUUID();
    return {
      success: false,
      needsSecrets: true,
      flowId,
      requiredSecrets: REQUIRED_SECRETS[input.authType],
      message: `Use collect_secret with flowId "${flowId}" for each required secret, then call create again with the flowId`,
    };
  }

  // Consume secrets from the flow store (atomic read+delete)
  const secrets = await consumeFlowSecrets(input.flowId);
  if (!secrets) {
    return {
      success: false,
      error: {
        code: 'SECRETS_EXPIRED',
        message:
          'Secrets for this flow have expired or were already consumed. Start a new flow by calling create without flowId.',
      },
    };
  }

  const payload = buildCreatePayload(input, secrets, ctx);
  const res = await apiFetch('/auth-profiles', ctx, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    return {
      success: false,
      error: {
        code: res.status === 409 ? 'DUPLICATE_NAME' : (apiError?.code ?? 'CREATE_FAILED'),
        message: apiError?.message ?? `Create failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);

  const body = await res.json();
  const data = body.data ?? {};
  log.info('Auth profile created', {
    projectId: ctx.projectId,
    profileId: data.id,
    authType: input.authType,
  });
  return {
    success: true,
    data: { id: data.id, name: data.name, authType: data.authType, status: data.status },
  };
}

async function updateProfile(
  input: AuthOpsInput,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  // Check if inherited before calling API
  const readRes = await readProfile(input.profileId!, ctx);
  if (!readRes.success) return readRes;
  if ((readRes.data as Record<string, unknown>)?.inherited) {
    return {
      success: false,
      error: {
        code: 'INHERITED_PROFILE',
        message:
          'This is a workspace-level auth profile. It can only be modified in Settings > Auth Profiles.',
      },
    };
  }

  const updatePayload: Record<string, unknown> = {};
  if (input.config) {
    // Determine authType from the existing profile for translation
    const existingAuthType = (readRes.data as Record<string, unknown>)?.authType as string;
    if (existingAuthType && isSupportedAuthType(existingAuthType)) {
      updatePayload.config = translateConfig(existingAuthType, input.config);
    } else {
      updatePayload.config = input.config;
    }
  }
  if (input.profileName) updatePayload.name = input.profileName;

  // If flowId provided, consume secrets for the update
  if (input.flowId) {
    const secrets = await consumeFlowSecrets(input.flowId);
    if (secrets) {
      updatePayload.secrets = secrets;
    }
  }

  const res = await apiFetch(`/auth-profiles/${input.profileId}`, ctx, {
    method: 'PUT',
    body: JSON.stringify(updatePayload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    return {
      success: false,
      error: {
        code: apiError?.code ?? 'UPDATE_FAILED',
        message: apiError?.message ?? `Update failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  const body = await res.json();
  return { success: true, data: body.data };
}

async function deleteProfile(
  profileId: string,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  // Check if inherited before calling API
  const readRes = await readProfile(profileId, ctx);
  if (!readRes.success) return readRes;
  if ((readRes.data as Record<string, unknown>)?.inherited) {
    return {
      success: false,
      error: {
        code: 'INHERITED_PROFILE',
        message:
          'This is a workspace-level auth profile. It can only be modified in Settings > Auth Profiles.',
      },
    };
  }

  const res = await apiFetch(`/auth-profiles/${profileId}`, ctx, { method: 'DELETE' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string; consumers?: unknown } })
      .error;
    return {
      success: false,
      error: {
        code: res.status === 409 ? 'PROFILE_IN_USE' : (apiError?.code ?? 'DELETE_FAILED'),
        message: apiError?.message ?? `Delete failed: ${res.status}`,
      },
    };
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  log.info('Auth profile deleted', { projectId: ctx.projectId, profileId });
  return { success: true, data: { deleted: profileId } };
}

async function validateProfile(
  profileId: string,
  ctx: ToolPermissionContext,
): Promise<AuthOpsResult> {
  const res = await apiFetch(`/auth-profiles/${profileId}/validate`, ctx, { method: 'POST' });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const apiError = (body as { error?: { message?: string; code?: string } }).error;
    return {
      success: false,
      error: {
        code: apiError?.code ?? 'VALIDATE_FAILED',
        message: apiError?.message ?? `Validate failed: ${res.status}`,
      },
    };
  }

  const body = await res.json();
  return { success: true, data: body.data };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/__tests__/arch-ai/auth-ops.test.ts
git add apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/__tests__/arch-ai/auth-ops.test.ts
git commit -m "[ABLP-162] feat(studio): add auth_ops tool executor with translation layer"
```

---

### Task 5: Message Route Wiring — Tool Registration + Tool Map + Secret Population

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

- [ ] **Step 1: Add auth_ops and collect_secret to IN_PROJECT_SPECIALIST_TOOL_MAP**

At line ~781, update the `integration-methodologist` entry:

```typescript
'integration-methodologist': [
  'read_agent',
  'propose_modification',
  'apply_modification',
  'dismiss_proposal',
  'compile_abl',
  'ask_user',
  'project_config',
  'auth_ops',
  'collect_secret',
],
```

- [ ] **Step 2: Register auth_ops and collect_secret in buildInProjectTools()**

At the end of the return block in `buildInProjectTools()` (after `project_config`), add:

```typescript
auth_ops: tool({
  description:
    'Create, read, update, delete, list, or validate auth profiles for tool integrations. ' +
    'Supports api_key, bearer, oauth2_app, and oauth2_client_credentials. ' +
    'Secrets are collected via collect_secret — never pass secrets directly.',
  inputSchema: z.object({
    action: z.enum(['create', 'read', 'update', 'delete', 'list', 'validate']),
    profileId: z.string().optional().describe('Profile ID for read/update/delete/validate'),
    profileName: z.string().optional().describe('Profile name for create'),
    authType: z.string().optional().describe('Auth type: api_key, bearer, oauth2_app, oauth2_client_credentials'),
    config: z.record(z.unknown()).optional().describe('Non-secret config (URLs, scopes, header names)'),
    flowId: z.string().optional().describe('Flow ID from needsSecrets response — references collected secrets'),
    confirmed: z.boolean().default(false).describe('Required true for delete'),
  }),
  execute: async (input) => {
    const { executeAuthOps } = await import('@/lib/arch-ai/tools/auth-ops');
    return executeAuthOps(input, {
      projectId,
      user: { permissions: ctx.permissions ?? [], tenantId: ctx.tenantId, userId: ctx.userId },
      authToken,
    });
  },
}),

collect_secret: tool({
  description:
    'Collect a sensitive credential from the user via a secure masked input. ' +
    'The value is NEVER sent to the model or stored in chat history. ' +
    'Use the flowId from auth_ops needsSecrets response.',
  inputSchema: z.object({
    flowId: z.string().describe('Flow ID from the auth_ops needsSecrets response'),
    field: z.string().describe('Secret field name (e.g., clientSecret, apiKey, token)'),
    label: z.string().describe('Human-readable label shown to the user (e.g., "Salesforce Client Secret")'),
  }),
  // NO execute — client-side tool, handled by WidgetRenderer
}),
```

- [ ] **Step 3: Add secret store population in processInProjectMessage()**

In `processInProjectMessage()`, find the section that handles `tool_answer` (around line 3185). BEFORE the existing `setToolResult` call, add:

```typescript
// Populate flow-scoped secret store from tool_answer.secrets (if present)
if (msg.type === 'tool_answer' && msg.secrets) {
  const { setFlowSecrets } = await import('@/lib/arch-ai/tools/secret-store');
  await setFlowSecrets(msg.secrets.flowId, msg.secrets.values);
}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): wire auth_ops and collect_secret into message route"
```

---

### Task 6: Prompts — IN_PROJECT Phase + Integration Methodologist

**Files:**

- Modify: `packages/arch-ai/src/prompts/phases/in-project.ts`
- Modify: `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`

- [ ] **Step 1: Add tools to IN_PROJECT_PHASE_PROMPT available tools list**

In `packages/arch-ai/src/prompts/phases/in-project.ts`, update the **Available tools** line (line 10):

```typescript
**Available tools:** read_agent, propose_modification, apply_modification, dismiss_proposal, compile_abl, read_topology, health_check, validate_agent, diagnose_project, explain_diagnostic, query_traces, run_test, recommend_model, analyze_constraints, read_journal, read_insights, project_config, auth_ops, collect_secret, ask_user
```

- [ ] **Step 2: Add capabilities entries**

After the `project_config` capabilities line (line 32), add:

```
- Create and manage auth profiles for tool integrations (auth_ops)
- Collect sensitive credentials securely without exposing to model (collect_secret)
```

- [ ] **Step 3: Update integration-methodologist prompt**

In `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`, add to the "Your Tools" section:

```
7. **auth_ops** — Create, read, update, delete, list, or validate auth profiles.
8. **collect_secret** — Collect sensitive credentials (passwords, tokens, client secrets) from the user via a secure masked input.
```

Then add the full "Auth Profile Management Workflow" section after "How to Behave":

```
## Auth Profile Management Workflow

When a user needs authentication for a tool integration:

1. CHECK EXISTING: Call auth_ops action:"list" first.
   If a suitable profile exists, suggest reusing it.
   Inherited (workspace-level) profiles are marked inherited:true — these
   are read-only from the project context.

2. RECOMMEND AUTH TYPE:
   - REST API with static key -> api_key
   - REST API with bearer token -> bearer
   - User-scoped OAuth (Salesforce, Google, etc.) -> oauth2_app
   - Machine-to-machine OAuth (server credentials) -> oauth2_client_credentials

3. COLLECT CONFIG conversationally:
   - For api_key: ask which header name (default X-API-Key)
   - For oauth2_app: ask for authorization URL, token URL, scopes
   - For oauth2_client_credentials: ask for token URL, scopes
   - Use ask_user with SingleSelect for common providers with allowCustom:true

4. COLLECT SECRETS via collect_secret (one call per secret):
   - For api_key: collect_secret(field:"apiKey", label:"API Key")
   - For bearer: collect_secret(field:"token", label:"Bearer Token")
   - For oauth2_app: collect_secret(field:"clientId", ...) then collect_secret(field:"clientSecret", ...)
   - For oauth2_client_credentials: same as oauth2_app
   - NEVER ask for secrets via ask_user or plain text
   - NEVER reference secret values in your responses

5. CREATE: Call auth_ops action:"create" with config and flowId (secrets auto-injected from secure store)

6. VALIDATE: Call auth_ops action:"validate" to test the profile works

7. BIND: Help the user reference the new auth profile in their tool's AUTH section via propose_modification

SECURITY RULES:
- ONLY use collect_secret for credentials — never ask_user or plain text
- Never log, display, or reference secret values in responses
- Never suggest hardcoding secrets in ABL code — always use auth_profile_ref
- If a user pastes a secret in plain chat, warn them and suggest rotating it
- Inherited workspace profiles are read-only — suggest creating a project copy if edits needed
```

- [ ] **Step 4: Build arch-ai package**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Build succeeds

- [ ] **Step 5: Run prompt tests**

Run: `pnpm test --filter=@agent-platform/arch-ai`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/phases/in-project.ts packages/arch-ai/src/prompts/specialists/integration-methodologist.ts
git add packages/arch-ai/src/prompts/phases/in-project.ts packages/arch-ai/src/prompts/specialists/integration-methodologist.ts
git commit -m "[ABLP-162] feat(arch-ai): add auth_ops and collect_secret to prompts and capabilities"
```

---

### Task 7: Frontend — SecretInput Widget + WidgetRenderer + useArchChat

**Files:**

- Create: `apps/studio/src/components/arch-v3/widgets/SecretInput.tsx`
- Modify: `apps/studio/src/components/arch-v3/widgets/types.ts`
- Modify: `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx`
- Modify: `apps/studio/src/hooks/useArchChat.ts`

- [ ] **Step 1: Add SecretInputInput type**

In `apps/studio/src/components/arch-v3/widgets/types.ts`, add:

```typescript
export interface SecretInputInput {
  flowId: string;
  field: string;
  label: string;
}
```

Update the `WidgetInput` union to include it:

```typescript
export type WidgetInput = AskUserInput | FileUploadInput | SecretInputInput;
```

- [ ] **Step 2: Create SecretInput component**

Create `apps/studio/src/components/arch-v3/widgets/SecretInput.tsx`:

```typescript
'use client';

import { motion } from 'framer-motion';
import { useState, useCallback, useEffect, useRef } from 'react';
import { Lock } from 'lucide-react';

interface SecretInputProps {
  input: { flowId: string; field: string; label: string };
  onSubmit: (answer: string, secrets: { flowId: string; values: Record<string, string> }) => void;
}

/**
 * SecretInput — password-masked input for collect_secret tool.
 * The actual secret value is passed via onSubmit's secrets parameter,
 * NOT through the answer string (which is always '(secret collected)').
 */
export function SecretInput({ input, onSubmit }: SecretInputProps) {
  const { flowId, field, label } = input;
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || submitted) return;
    setSubmitted(true);
    onSubmit('(secret collected)', { flowId, values: { [field]: trimmed } });
  }, [value, submitted, onSubmit, flowId, field]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  if (submitted) {
    return (
      <div className="my-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        <Lock className="h-3.5 w-3.5 flex-shrink-0" />
        <span>Secret collected</span>
      </div>
    );
  }

  const canSubmit = !!value.trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3"
    >
      <div className="mb-2 flex items-center gap-2 text-sm text-foreground-muted">
        <Lock className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter secret value..."
          autoComplete="off"
          className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/40 transition-colors focus:border-accent dark:bg-white/[0.06]"
        />
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`btn-press self-end rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
            canSubmit
              ? 'bg-accent text-white hover:bg-accent-muted'
              : 'cursor-not-allowed border border-border bg-background-subtle text-foreground/30'
          }`}
        >
          Submit
        </button>
      </div>
    </motion.div>
  );
}
```

- [ ] **Step 3: Add collect_secret branch to WidgetRenderer**

In `apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx`:

Add import at top:

```typescript
import { SecretInput } from './SecretInput';
import { Lock } from 'lucide-react';
```

In the `WidgetRenderer` function body, add a `collect_secret` branch in the answered summary section (inside the `if (answeredResult !== undefined && answeredResult !== null)` block), BEFORE the generic display:

```typescript
// collect_secret answered summary — show lock icon, never the secret value
if (toolName === 'collect_secret') {
  const label = isObject(safeInput) && typeof safeInput.label === 'string' ? safeInput.label : 'Secret';
  return (
    <div className="mt-1">
      <p className="mb-2 text-[15px] leading-relaxed text-foreground/80">{label}</p>
      <div className="flex items-center gap-2 rounded-xl border border-border/20 bg-background-subtle px-4 py-3 text-sm text-foreground-muted">
        <Lock className="h-3.5 w-3.5 flex-shrink-0" />
        <span>Secret collected</span>
      </div>
    </div>
  );
}
```

Then add the interactive `collect_secret` branch AFTER the `collect_file` handling and BEFORE the `ask_user` handling:

```typescript
// collect_secret tool — render password input
if (toolName === 'collect_secret' && isObject(safeInput)) {
  const secretInput = safeInput as { flowId: string; field: string; label: string };
  return (
    <div className="mt-1">
      <SecretInput
        input={secretInput}
        onSubmit={(answer, secrets) => {
          // onSubmit signature needs to be extended — see useArchChat changes
          (handleSubmit as (answer: unknown, secrets?: { flowId: string; values: Record<string, string> }) => void)(answer, secrets);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Extend WidgetRenderer onSubmit prop to support secrets**

Update the `WidgetRendererProps` interface:

```typescript
interface WidgetRendererProps {
  toolCallId: string;
  toolName: string;
  input: WidgetInput | Record<string, unknown> | undefined;
  onSubmit: (
    toolCallId: string,
    answer: unknown,
    secrets?: { flowId: string; values: Record<string, string> },
  ) => void;
  answeredResult?: unknown;
}
```

Update the `handleSubmit` wrapper:

```typescript
const handleSubmit = (
  answer: unknown,
  secrets?: { flowId: string; values: Record<string, string> },
) => {
  onSubmit(toolCallId, answer, secrets);
};
```

Update all existing widget `onSubmit` calls — they pass only `answer`, which is fine since `secrets` is optional.

- [ ] **Step 5: Extend useArchChat sendToolAnswer to support secrets**

In `apps/studio/src/hooks/useArchChat.ts`, update the `sendToolAnswer` callback (line ~1600):

```typescript
const sendToolAnswer = useCallback(
  async (
    toolCallId: string,
    answer: unknown,
    secrets?: { flowId: string; values: Record<string, string> },
  ) => {
    if (state !== 'widget_pending') return;
    setState('streaming');
    const body: Record<string, unknown> = { type: 'tool_answer', toolCallId, answer };
    if (secrets) {
      body.secrets = secrets;
    }
    await postMessage(body);
  },
  [state, postMessage],
);
```

Update the `UseArchChatReturn` interface:

```typescript
sendToolAnswer: (
  toolCallId: string,
  answer: unknown,
  secrets?: { flowId: string; values: Record<string, string> },
) => Promise<void>;
```

- [ ] **Step 6: Update ArchOverlay to pass secrets through**

In `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`, update the `onSubmit` callback for `WidgetRenderer` (line ~280):

```typescript
onSubmit={async (toolCallId, answer, secrets) => {
  await sendToolAnswer(toolCallId, answer, secrets);
  await refreshSession('IN_PROJECT', projectId);
}}
```

- [ ] **Step 7: Build to verify**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
npx prettier --write apps/studio/src/components/arch-v3/widgets/SecretInput.tsx apps/studio/src/components/arch-v3/widgets/types.ts apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx apps/studio/src/hooks/useArchChat.ts apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx
git add apps/studio/src/components/arch-v3/widgets/SecretInput.tsx apps/studio/src/components/arch-v3/widgets/types.ts apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx apps/studio/src/hooks/useArchChat.ts apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx
git commit -m "[ABLP-162] feat(studio): add SecretInput widget and collect_secret rendering in v3 overlay"
```

---

### Task 8: Full Build + Test Verification

**Files:** (none — verification only)

- [ ] **Step 1: Build all affected packages**

Run: `pnpm build --filter=@agent-platform/arch-ai --filter=abl-studio`
Expected: Both packages build successfully

- [ ] **Step 2: Run all arch-ai package tests**

Run: `pnpm test --filter=@agent-platform/arch-ai`
Expected: All tests pass

- [ ] **Step 3: Run studio tests for auth-ops and secret-store**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/secret-store.test.ts apps/studio/src/__tests__/arch-ai/auth-ops.test.ts`
Expected: All tests pass

- [ ] **Step 4: Run typecheck on both packages**

Run: `pnpm build --filter=@agent-platform/arch-ai && cd apps/studio && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Format all changed files**

Run: `npx prettier --write apps/studio/src/lib/arch-ai/tools/auth-ops.ts apps/studio/src/lib/arch-ai/tools/secret-store.ts apps/studio/src/lib/arch-ai/guards.ts apps/studio/src/app/api/arch-ai/message/route.ts apps/studio/src/hooks/useArchChat.ts apps/studio/src/components/arch-v3/widgets/SecretInput.tsx apps/studio/src/components/arch-v3/widgets/WidgetRenderer.tsx apps/studio/src/components/arch-v3/widgets/types.ts apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx packages/arch-ai/src/types/tools.ts packages/arch-ai/src/types/message-request.ts packages/arch-ai/src/prompts/phases/in-project.ts packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`
Expected: All files formatted
