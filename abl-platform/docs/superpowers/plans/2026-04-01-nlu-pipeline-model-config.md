# NLU Pipeline Model Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unused free-text `model` field in the pipeline classifier config with a working model selector that supports "Default" (existing resolution) or a specific tenant model.

**Architecture:** Add a `modelSource` discriminator (`'default' | 'tenant'`) and optional `tenantModelId` to the pipeline config. A new `resolvePipelineModel()` function handles both paths — delegating to `resolveLanguageModel('tool_selection')` for default, or loading the TenantModel + credential directly for tenant. The Studio UI replaces the text input with a dropdown fetching from `GET /api/tenant-models`.

**Tech Stack:** TypeScript, Vitest, Zod, Mongoose, React, Vercel AI SDK, `@agent-platform/llm`

**Spec:** `docs/superpowers/specs/2026-04-01-nlu-pipeline-model-config-design.md`

---

## File Structure

| File                                                         | Action | Responsibility                                               |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------ |
| `apps/runtime/src/services/pipeline/types.ts`                | Modify | Replace `model: string` with `modelSource` + `tenantModelId` |
| `apps/runtime/src/services/pipeline/config.ts`               | Modify | Add `modelSource` + `tenantModelId` to resolution cascade    |
| `apps/runtime/src/services/pipeline/model-resolver.ts`       | Create | `resolvePipelineModel()` — two-path model resolution         |
| `apps/runtime/src/services/execution/reasoning-executor.ts`  | Modify | Use `resolvePipelineModel()` at line ~696                    |
| `apps/runtime/src/routes/project-runtime-config.ts`          | Modify | Update Zod schema                                            |
| `packages/compiler/src/platform/ir/schema.ts`                | Modify | Update IR pipeline config types                              |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`   | Modify | Replace text input with tenant model dropdown                |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`         | Modify | Update existing tests + add new ones                         |
| `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts` | Create | Tests for `resolvePipelineModel()`                           |

---

### Task 1: Update PipelineConfig type and defaults

**Files:**

- Modify: `apps/runtime/src/services/pipeline/types.ts:28-72`

- [ ] **Step 1: Replace `model` with `modelSource` + `tenantModelId` in PipelineConfig interface**

In `apps/runtime/src/services/pipeline/types.ts`, replace lines 29-32:

```typescript
/** Pipeline configuration — resolved from agent IR → project config → defaults */
export interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  model: string;
```

With:

```typescript
/** Pipeline configuration — resolved from agent IR → project config → defaults */
export interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  /** Model source: 'default' uses resolveLanguageModel('tool_selection'), 'tenant' uses a specific TenantModel */
  modelSource: 'default' | 'tenant';
  /** TenantModel ID — required when modelSource is 'tenant' */
  tenantModelId?: string;
```

- [ ] **Step 2: Update DEFAULT_PIPELINE_CONFIG**

Replace lines 49-52:

```typescript
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  model: 'qwen3-30b',
```

With:

```typescript
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  modelSource: 'default',
```

- [ ] **Step 3: Run typecheck to surface all downstream breakage**

Run: `pnpm build --filter=@agent-platform/runtime 2>&1 | head -40`

Expected: Type errors in `config.ts` (references `model`), `reasoning-executor.ts`, and test files. This is expected — we fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/types.ts
git add apps/runtime/src/services/pipeline/types.ts
git commit -m "[ABLP-XXX] refactor(pipeline): replace model string with modelSource discriminator in PipelineConfig"
```

Note: Replace `ABLP-XXX` with the actual Jira ticket key.

---

### Task 2: Update pipeline config resolution

**Files:**

- Modify: `apps/runtime/src/services/pipeline/config.ts:10-90`

- [ ] **Step 1: Update PipelineConfigOverride type**

Replace lines 10-18:

```typescript
type PipelineConfigOverride = {
  enabled?: boolean;
  mode?: PipelineConfig['mode'];
  model?: string;
  shortCircuit?: Partial<PipelineConfig['shortCircuit']>;
  toolFilter?: Partial<PipelineConfig['toolFilter']>;
  keywordVeto?: Partial<PipelineConfig['keywordVeto']>;
  intentBridge?: Partial<IntentBridgeConfig>;
};
```

With:

```typescript
type PipelineConfigOverride = {
  enabled?: boolean;
  mode?: PipelineConfig['mode'];
  modelSource?: PipelineConfig['modelSource'];
  tenantModelId?: string;
  /** @deprecated Ignored — use modelSource + tenantModelId instead */
  model?: string;
  shortCircuit?: Partial<PipelineConfig['shortCircuit']>;
  toolFilter?: Partial<PipelineConfig['toolFilter']>;
  keywordVeto?: Partial<PipelineConfig['keywordVeto']>;
  intentBridge?: Partial<IntentBridgeConfig>;
};
```

Keep `model` in the override type for backward compatibility (old saved configs may still have it), but it is not read.

- [ ] **Step 2: Update resolvePipelineConfig to resolve modelSource + tenantModelId**

Replace line 36:

```typescript
    model: agent?.model ?? project?.model ?? DEFAULT_PIPELINE_CONFIG.model,
```

With:

```typescript
    modelSource:
      agent?.modelSource ?? project?.modelSource ?? DEFAULT_PIPELINE_CONFIG.modelSource,
    tenantModelId: agent?.tenantModelId ?? project?.tenantModelId ?? undefined,
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime 2>&1 | head -40`

Expected: Fewer errors — `config.ts` should be clean now. Test files and `reasoning-executor.ts` may still error.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/config.ts
git add apps/runtime/src/services/pipeline/config.ts
git commit -m "[ABLP-XXX] refactor(pipeline): resolve modelSource and tenantModelId in config cascade"
```

---

### Task 3: Update existing pipeline-config tests

**Files:**

- Modify: `apps/runtime/src/__tests__/pipeline-config.test.ts`

- [ ] **Step 1: Update tests that reference `config.model`**

In `pipeline-config.test.ts`, find and update all assertions that use `.model`:

Line 28 — change:

```typescript
expect(config.model).toBe('qwen3-30b'); // default
```

To:

```typescript
expect(config.modelSource).toBe('default');
```

Lines 31-39 — replace:

```typescript
it('project-level overrides defaults', () => {
  const config = resolvePipelineConfig(undefined, {
    enabled: true,
    mode: 'sequential',
    model: 'gpt-4o-mini',
  });
  expect(config.enabled).toBe(true);
  expect(config.mode).toBe('sequential');
  expect(config.model).toBe('gpt-4o-mini');
});
```

With:

```typescript
it('project-level overrides defaults', () => {
  const config = resolvePipelineConfig(undefined, {
    enabled: true,
    mode: 'sequential',
    modelSource: 'tenant',
    tenantModelId: 'tm-123',
  });
  expect(config.enabled).toBe(true);
  expect(config.mode).toBe('sequential');
  expect(config.modelSource).toBe('tenant');
  expect(config.tenantModelId).toBe('tm-123');
});
```

Lines 42-58 — replace:

```typescript
it('agent-level overrides project-level', () => {
  const config = resolvePipelineConfig(
    {
      hints: {} as any,
      timeouts: {} as any,
      pipeline: { enabled: true, model: 'claude-haiku' },
    },
    {
      enabled: false,
      model: 'gpt-4o-mini',
      mode: 'sequential',
    },
  );
  expect(config.enabled).toBe(true); // agent wins
  expect(config.model).toBe('claude-haiku'); // agent wins
  expect(config.mode).toBe('sequential'); // project fills in
});
```

With:

```typescript
it('agent-level overrides project-level', () => {
  const config = resolvePipelineConfig(
    {
      hints: {} as any,
      timeouts: {} as any,
      pipeline: { enabled: true, modelSource: 'tenant', tenantModelId: 'tm-agent' },
    },
    {
      enabled: false,
      modelSource: 'tenant',
      tenantModelId: 'tm-project',
      mode: 'sequential',
    },
  );
  expect(config.enabled).toBe(true); // agent wins
  expect(config.modelSource).toBe('tenant'); // agent wins
  expect(config.tenantModelId).toBe('tm-agent'); // agent wins
  expect(config.mode).toBe('sequential'); // project fills in
});
```

- [ ] **Step 2: Add new tests for modelSource resolution**

Add to the same describe block:

```typescript
it('modelSource defaults to default when not set', () => {
  const config = resolvePipelineConfig(undefined, { enabled: true });
  expect(config.modelSource).toBe('default');
  expect(config.tenantModelId).toBeUndefined();
});

it('tenantModelId from project fills in when agent does not set it', () => {
  const config = resolvePipelineConfig(
    {
      hints: {} as any,
      timeouts: {} as any,
      pipeline: { modelSource: 'tenant' },
    },
    { tenantModelId: 'tm-project-fallback' },
  );
  expect(config.modelSource).toBe('tenant');
  expect(config.tenantModelId).toBe('tm-project-fallback');
});

it('backward compat: old config with model string is ignored', () => {
  const config = resolvePipelineConfig(undefined, {
    model: 'qwen3-30b',
  } as any);
  expect(config.modelSource).toBe('default');
  expect(config.tenantModelId).toBeUndefined();
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/pipeline-config.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/pipeline-config.test.ts
git add apps/runtime/src/__tests__/pipeline-config.test.ts
git commit -m "[ABLP-XXX] test(pipeline): update config tests for modelSource discriminator"
```

---

### Task 4: Create the pipeline model resolver

**Files:**

- Create: `apps/runtime/src/services/pipeline/model-resolver.ts`
- Test: `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`:

```typescript
/**
 * Tests for pipeline model resolver.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { resolvePipelineModel } from '../services/pipeline/model-resolver.js';
import { DEFAULT_PIPELINE_CONFIG } from '../services/pipeline/types.js';

// Minimal mock LanguageModel
const mockLanguageModel = { modelId: 'mock-model' } as unknown as LanguageModel;

// Mock SessionLLMClient
function createMockSession(overrides?: {
  resolveResult?: LanguageModel | null;
  tenantId?: string;
}) {
  return {
    llmClient: {
      resolveLanguageModel: vi
        .fn()
        .mockResolvedValue(overrides?.resolveResult ?? mockLanguageModel),
    },
    tenantId: overrides?.tenantId ?? 'tenant-1',
  };
}

describe('resolvePipelineModel', () => {
  it('delegates to resolveLanguageModel for modelSource=default', async () => {
    const session = createMockSession();
    const config = { ...DEFAULT_PIPELINE_CONFIG, modelSource: 'default' as const };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('delegates to resolveLanguageModel when modelSource is missing', async () => {
    const session = createMockSession();
    const config = { ...DEFAULT_PIPELINE_CONFIG };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });

  it('returns null when default resolution returns null', async () => {
    const session = createMockSession({ resolveResult: null });
    const config = { ...DEFAULT_PIPELINE_CONFIG, modelSource: 'default' as const };

    const result = await resolvePipelineModel(config, session as any);

    expect(result).toBeNull();
  });

  it('falls back to default when modelSource=tenant but tenantModelId is missing', async () => {
    const session = createMockSession();
    const config = {
      ...DEFAULT_PIPELINE_CONFIG,
      modelSource: 'tenant' as const,
      tenantModelId: undefined,
    };

    const result = await resolvePipelineModel(config, session as any);

    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
    expect(result).toBe(mockLanguageModel);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`

Expected: FAIL — `Cannot find module '../services/pipeline/model-resolver.js'`

- [ ] **Step 3: Write the model resolver**

Create `apps/runtime/src/services/pipeline/model-resolver.ts`:

```typescript
/**
 * Pipeline Model Resolver
 *
 * Resolves the LanguageModel for the pipeline classifier based on config.
 *
 * Resolution paths:
 *   'default' (or missing) — delegates to session.llmClient.resolveLanguageModel('tool_selection')
 *   'tenant'               — loads TenantModel by tenantModelId, resolves credential, creates provider
 */

import type { LanguageModel } from 'ai';
import { createVercelProvider } from '@agent-platform/llm';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineConfig } from './types.js';

const log = createLogger('pipeline-model-resolver');

/**
 * Minimal session interface — avoids importing the full SessionState type.
 * The pipeline resolver only needs the LLM client and tenant ID.
 */
interface PipelineSession {
  llmClient: {
    resolveLanguageModel(operationType: string): Promise<LanguageModel | null>;
  };
  tenantId?: string;
}

/**
 * Resolve the LanguageModel for the pipeline classifier.
 */
export async function resolvePipelineModel(
  config: PipelineConfig,
  session: PipelineSession,
): Promise<LanguageModel | null> {
  if (config.modelSource === 'tenant' && config.tenantModelId) {
    try {
      return await resolveTenantModel(config.tenantModelId, session.tenantId ?? '');
    } catch (err) {
      log.warn('tenant model resolution failed for pipeline, falling back to default', {
        tenantModelId: config.tenantModelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return session.llmClient.resolveLanguageModel('tool_selection');
    }
  }

  // Default path: delegate to existing resolution
  return session.llmClient.resolveLanguageModel('tool_selection');
}

/**
 * Load a TenantModel by ID, resolve its primary credential, and create a LanguageModel.
 * Follows the Arch Tier 1a pattern (apps/studio/src/lib/arch-llm.ts:297-342).
 */
async function resolveTenantModel(tenantModelId: string, tenantId: string): Promise<LanguageModel> {
  const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

  const tenantModel = await TenantModel.findOne({
    _id: tenantModelId,
    tenantId,
    isActive: true,
  }).lean();

  if (!tenantModel) {
    throw new Error(`TenantModel ${tenantModelId} not found or inactive`);
  }

  const connections = (tenantModel as any).connections ?? [];
  const connection =
    connections.find((c: any) => c.isPrimary && c.isActive) ??
    connections.find((c: any) => c.isActive) ??
    connections[0];

  if (!connection?.credentialId) {
    throw new Error(`TenantModel ${tenantModelId} has no active connection with a credential`);
  }

  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
    isActive: true,
  }).lean();

  if (!credential || !(credential as any).encryptedApiKey) {
    throw new Error(`Credential for TenantModel ${tenantModelId} not found or has no API key`);
  }

  const provider = (tenantModel as any).provider ?? 'openai';
  const modelId = (tenantModel as any).modelId;
  const apiKey = (credential as any).encryptedApiKey;
  const baseUrl = (credential as any).encryptedEndpoint || undefined;

  return createVercelProvider(provider, apiKey, baseUrl, modelId);
}
```

- [ ] **Step 4: Add to barrel export**

Read `apps/runtime/src/services/pipeline/index.ts` and add:

```typescript
export { resolvePipelineModel } from './model-resolver.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`

Expected: All 4 tests pass (the default-path and fallback tests don't require DB mocking).

- [ ] **Step 6: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime 2>&1 | head -20`

Expected: Clean or only errors from `reasoning-executor.ts` (fixed in Task 5).

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/model-resolver.ts apps/runtime/src/__tests__/pipeline-model-resolver.test.ts apps/runtime/src/services/pipeline/index.ts
git add apps/runtime/src/services/pipeline/model-resolver.ts apps/runtime/src/__tests__/pipeline-model-resolver.test.ts apps/runtime/src/services/pipeline/index.ts
git commit -m "[ABLP-XXX] feat(pipeline): add resolvePipelineModel with default and tenant model paths"
```

---

### Task 5: Wire resolver into reasoning-executor

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:694-698`

- [ ] **Step 1: Add import**

At the top of `reasoning-executor.ts`, add alongside existing pipeline imports:

```typescript
import { resolvePipelineModel } from '../pipeline/model-resolver.js';
```

- [ ] **Step 2: Replace direct resolveLanguageModel call**

Replace line 696:

```typescript
const pipelineModel = await session.llmClient.resolveLanguageModel('tool_selection');
```

With:

```typescript
const pipelineModel = await resolvePipelineModel(pipelineConfig, session);
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime 2>&1 | head -20`

Expected: Clean build (or only unrelated warnings).

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] feat(pipeline): wire resolvePipelineModel into reasoning executor"
```

---

### Task 6: Update Zod schema in project-runtime-config route

**Files:**

- Modify: `apps/runtime/src/routes/project-runtime-config.ts:119-157`

- [ ] **Step 1: Update pipelineConfigSchema**

Replace lines 119-157:

```typescript
const pipelineConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['parallel', 'sequential']).optional(),
  model: z
    .string()
    .max(100)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
      'alphanumeric model name with dots, hyphens, underscores',
    )
    .optional(),
  shortCircuit: z
    .object({
      enabled: z.boolean().optional(),
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  toolFilter: z
    .object({
      enabled: z.boolean().optional(),
      maxTools: z.number().min(1).max(100).optional(),
    })
    .optional(),
  keywordVeto: z
    .object({
      enabled: z.boolean().optional(),
      keywords: z.array(z.string().max(200)).max(500).optional(),
    })
    .optional(),
  intentBridge: z
    .object({
      enabled: z.boolean().optional(),
      programmaticThreshold: z.number().min(0).max(1).optional(),
      guidedThreshold: z.number().min(0).max(1).optional(),
      outOfScopeDecline: z.boolean().optional(),
      multiIntentSignal: z.boolean().optional(),
    })
    .optional(),
});
```

With:

```typescript
const pipelineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['parallel', 'sequential']).optional(),
    modelSource: z.enum(['default', 'tenant']).optional(),
    tenantModelId: z.string().min(1).optional(),
    shortCircuit: z
      .object({
        enabled: z.boolean().optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
      })
      .optional(),
    toolFilter: z
      .object({
        enabled: z.boolean().optional(),
        maxTools: z.number().min(1).max(100).optional(),
      })
      .optional(),
    keywordVeto: z
      .object({
        enabled: z.boolean().optional(),
        keywords: z.array(z.string().max(200)).max(500).optional(),
      })
      .optional(),
    intentBridge: z
      .object({
        enabled: z.boolean().optional(),
        programmaticThreshold: z.number().min(0).max(1).optional(),
        guidedThreshold: z.number().min(0).max(1).optional(),
        outOfScopeDecline: z.boolean().optional(),
        multiIntentSignal: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((d) => !(d.modelSource === 'tenant' && !d.tenantModelId), {
    message: 'tenantModelId is required when modelSource is tenant',
  });
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime 2>&1 | head -20`

Expected: Clean.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/routes/project-runtime-config.ts
git add apps/runtime/src/routes/project-runtime-config.ts
git commit -m "[ABLP-XXX] refactor(pipeline): update Zod schema for modelSource + tenantModelId"
```

---

### Task 7: Update IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:232-235,630-633`

- [ ] **Step 1: Update project-level pipeline config (line ~232)**

Replace:

```typescript
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    model?: string;
```

With:

```typescript
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    /** @deprecated Use modelSource + tenantModelId */
    model?: string;
    modelSource?: 'default' | 'tenant';
    tenantModelId?: string;
```

Keep `model` in the IR type — it's a compiled output format that may have existing serialized data.

- [ ] **Step 2: Update agent-level pipeline config (line ~630)**

Same change — replace:

```typescript
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    model?: string;
```

With:

```typescript
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    /** @deprecated Use modelSource + tenantModelId */
    model?: string;
    modelSource?: 'default' | 'tenant';
    tenantModelId?: string;
```

- [ ] **Step 3: Run typecheck on compiler package**

Run: `pnpm build --filter=@abl/compiler 2>&1 | head -20`

Expected: Clean.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "[ABLP-XXX] refactor(compiler): add modelSource + tenantModelId to IR pipeline config"
```

---

### Task 8: Update Studio RuntimeConfigTab UI

**Files:**

- Modify: `apps/studio/src/components/settings/RuntimeConfigTab.tsx`

- [ ] **Step 1: Update PipelineConfig interface (line ~92)**

Replace:

```typescript
interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  model: string;
  shortCircuit: { enabled: boolean; confidenceThreshold: number };
  toolFilter: { enabled: boolean; maxTools: number };
  keywordVeto: { enabled: boolean; keywords: string[] };
  intentBridge: PipelineIntentBridgeConfig;
}
```

With:

```typescript
interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  modelSource: 'default' | 'tenant';
  tenantModelId?: string;
  shortCircuit: { enabled: boolean; confidenceThreshold: number };
  toolFilter: { enabled: boolean; maxTools: number };
  keywordVeto: { enabled: boolean; keywords: string[] };
  intentBridge: PipelineIntentBridgeConfig;
}
```

- [ ] **Step 2: Add TenantModelOption interface and state**

After the existing interface definitions (~line 116), add:

```typescript
interface TenantModelOption {
  id: string;
  displayName: string;
  modelId: string;
  provider: string;
}
```

- [ ] **Step 3: Update defaultPipeline constant (line ~370)**

Replace:

```typescript
const defaultPipeline: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  model: 'qwen3-30b',
  shortCircuit: { enabled: true, confidenceThreshold: 0.85 },
  toolFilter: { enabled: true, maxTools: 6 },
  keywordVeto: { enabled: true, keywords: [] },
  intentBridge: {
    enabled: true,
    programmaticThreshold: 0.85,
    guidedThreshold: 0.5,
    outOfScopeDecline: true,
    multiIntentSignal: true,
  },
};
```

With:

```typescript
const defaultPipeline: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  modelSource: 'default',
  shortCircuit: { enabled: true, confidenceThreshold: 0.85 },
  toolFilter: { enabled: true, maxTools: 6 },
  keywordVeto: { enabled: true, keywords: [] },
  intentBridge: {
    enabled: true,
    programmaticThreshold: 0.85,
    guidedThreshold: 0.5,
    outOfScopeDecline: true,
    multiIntentSignal: true,
  },
};
```

- [ ] **Step 4: Add tenant models fetch**

Inside the component function, near the existing `useEffect` hooks, add state and fetch logic:

```typescript
const [tenantModels, setTenantModels] = useState<TenantModelOption[]>([]);

useEffect(() => {
  let cancelled = false;
  async function loadTenantModels() {
    try {
      const res = await apiFetch('/api/tenant-models');
      const data = await res.json();
      if (!cancelled) {
        setTenantModels(
          (data.models || [])
            .filter((m: any) => m.isActive !== false)
            .map((m: any) => ({
              id: m.id,
              displayName: m.displayName,
              modelId: m.modelId,
              provider: m.provider,
            })),
        );
      }
    } catch {
      // Silent — dropdown will just show "Default"
    }
  }
  loadTenantModels();
  return () => {
    cancelled = true;
  };
}, []);
```

- [ ] **Step 5: Add model selection handler**

After the existing `updatePipeline` function:

```typescript
const handlePipelineModelChange = (value: string) => {
  if (!config) return;
  const current = config.pipeline ?? defaultPipeline;
  if (value === 'default') {
    setConfig({
      ...config,
      pipeline: { ...current, modelSource: 'default', tenantModelId: undefined },
    });
  } else {
    setConfig({
      ...config,
      pipeline: { ...current, modelSource: 'tenant', tenantModelId: value },
    });
  }
  setIsDirty(true);
};
```

- [ ] **Step 6: Replace the free-text model input with a dropdown**

Replace the Pipeline Model field (lines ~740-750):

```tsx
<Field
  label="Pipeline Model"
  description="Classifier model used for intent routing (e.g., qwen35-a3b-35b)"
>
  <input
    type="text"
    value={config.pipeline?.model ?? 'qwen3-30b'}
    onChange={(e) => updatePipeline('model', e.target.value)}
    placeholder="qwen3-30b"
    className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
  />
</Field>
```

With:

```tsx
<Field
  label="Pipeline Model"
  description="Model used for intent classification. Default uses the project's tool_selection model."
>
  <select
    value={
      config.pipeline?.modelSource === 'tenant' && config.pipeline?.tenantModelId
        ? config.pipeline.tenantModelId
        : 'default'
    }
    onChange={(e) => handlePipelineModelChange(e.target.value)}
    className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
  >
    <option value="default">Default</option>
    {tenantModels.map((tm) => (
      <option key={tm.id} value={tm.id}>
        {tm.displayName} ({tm.modelId})
      </option>
    ))}
  </select>
</Field>
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm build --filter=@agent-platform/studio 2>&1 | head -30`

Expected: Clean.

- [ ] **Step 8: Commit**

```bash
npx prettier --write apps/studio/src/components/settings/RuntimeConfigTab.tsx
git add apps/studio/src/components/settings/RuntimeConfigTab.tsx
git commit -m "[ABLP-XXX] feat(studio): replace pipeline model text input with tenant model dropdown"
```

---

### Task 9: Full build and test sweep

**Files:** None (verification only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`

Expected: Clean build across all packages.

- [ ] **Step 2: Run pipeline-related tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/pipeline-config.test.ts apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Run broader runtime tests to check for regressions**

Run: `pnpm vitest run apps/runtime/src/__tests__/pipeline-classifier.test.ts apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts apps/runtime/src/__tests__/pipeline-circuit-breaker.test.ts`

Expected: All pass. If any reference `config.model`, update them to use `config.modelSource`.

- [ ] **Step 4: Check for any remaining references to the old `model` field in pipeline code**

Run: `grep -rn '\.model\b' apps/runtime/src/services/pipeline/ --include='*.ts' | grep -v 'modelSource\|tenantModel\|LanguageModel\|modelId\|node_modules'`

Expected: No hits referencing the old `PipelineConfig.model` field. Trace event types may still reference `model` for the LLM model name in traces — that's fine (different field).
