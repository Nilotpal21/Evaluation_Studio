# configure_model Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `configure_model` tool to Arch AI's IN_PROJECT phase that can inspect, diff, and apply model configurations for individual agents or entire topologies.

**Architecture:** A new tool module `configure-model.ts` with pure helper functions (testable without mocks) and API-calling actions. Wired into the existing IN_PROJECT tool system via shared type contracts in `packages/arch-ai/`, guards in Studio, and the `buildInProjectTools()` function in the arch-ai message route. Runtime gets cache invalidation on the PUT route.

**Tech Stack:** TypeScript, Zod (input validation), Vercel AI SDK `tool()`, existing Studio proxy APIs, existing `getModelRecommendation` helper.

**Spec:** `docs/superpowers/specs/2026-04-13-configure-model-tool-design.md`
**Ticket:** ABLP-162
**Branch:** arch/knowledge

---

### Task 1: Add `configure_model` to shared tool contract

**Files:**

- Modify: `packages/arch-ai/src/types/tools.ts:10-90`
- Modify: `packages/arch-ai/src/tools/schemas/in-project-schemas.ts:55-164`

- [ ] **Step 1: Add `configure_model` to ToolName union**

In `packages/arch-ai/src/types/tools.ts`, add `'configure_model'` to the `ToolName` union (after `'dismiss_proposal'` at line 33):

```typescript
  | 'dismiss_proposal'
  | 'configure_model'
  | 'auth_ops'
```

- [ ] **Step 2: Add to IN_PROJECT_TOOLS array**

In the same file, add `'configure_model'` to the `IN_PROJECT_TOOLS` array (after `'explain_diagnostic'` at line 88):

```typescript
  'diagnose_project',
  'explain_diagnostic',
  'configure_model',
  'auth_ops',
```

- [ ] **Step 3: Add Zod schema to toolInputSchemas**

In `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`, add the `configure_model` schema entry after the `read_insights` entry (line 163):

```typescript
  read_insights: z.object({
    action: z
      .enum([
        'overview',
        'quality',
        'outcomes',
        'agent_performance',
        'sentiment',
        'tool_performance',
      ])
      .describe('Type of insight to read'),
    agentName: z.string().optional().describe('Filter results by agent name'),
    timeRange: z
      .enum(['1h', '24h', '7d', '30d'])
      .optional()
      .default('7d')
      .describe('Time range for the query'),
  }),

  configure_model: z.object({
    action: z.enum(['inspect', 'diff', 'apply']).describe('Action to perform'),
    agentName: z
      .string()
      .min(1)
      .describe('Agent name, or "all" for topology-wide'),
    source: z
      .enum(['recommendation', 'manual'])
      .optional()
      .describe('Required for apply: recommendation or manual'),
    modelId: z
      .string()
      .optional()
      .describe('LiteLLM model ID for manual source, e.g. "claude-sonnet-4-6"'),
    provider: z
      .string()
      .optional()
      .describe('Provider key for manual source, e.g. "anthropic"'),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).optional(),
    operationModels: z
      .record(z.string(), z.string())
      .optional()
      .describe('Per-operation model ID overrides'),
    confirmed: z.boolean().optional().describe('Dangerous-action confirmation flag'),
  }),
```

- [ ] **Step 4: Build the arch-ai package**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/arch-ai/src/types/tools.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts
git add packages/arch-ai/src/types/tools.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts
git commit -m "[ABLP-162] feat(compiler): add configure_model to shared tool contract"
```

---

### Task 2: Add guards and UI label

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/guards.ts:7-95`
- Modify: `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx:24-50`

- [ ] **Step 1: Add configure_model to ACTION_TO_PERMISSION**

In `apps/studio/src/lib/arch-ai/guards.ts`, add a new `configure_model` entry to `ACTION_TO_PERMISSION` after the `project_config` block (line 81):

```typescript
  project_config: {
    get_config: 'project:read',
    update_config: 'project:update',
    get_settings: 'model_config:read',
    update_settings: 'model_config:write',
  },
  configure_model: {
    inspect: 'agent:read',
    diff: 'agent:read',
    apply: 'agent:update',
  },
```

- [ ] **Step 2: Add configure_model to DANGEROUS_ACTIONS**

In the same file, add `configure_model` to `DANGEROUS_ACTIONS` after the `project_config` entry (line 94):

```typescript
  project_config: ['update_settings'],
  configure_model: ['apply'],
```

- [ ] **Step 3: Add to TOOL_LABELS**

In `apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx`, add `configure_model` to the `TOOL_LABELS` map (after `recommend_model` at line 33):

```typescript
  recommend_model: 'Analyzing model options',
  configure_model: 'Configuring model',
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/guards.ts apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx
git add apps/studio/src/lib/arch-ai/guards.ts apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx
git commit -m "[ABLP-162] feat(studio): add configure_model guards and UI label"
```

---

### Task 3: Write pure helper functions with tests

**Files:**

- Create: `apps/studio/src/lib/arch-ai/tools/configure-model.ts`
- Create: `apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`

- [ ] **Step 1: Write tests for hasActiveOverride and classifyAgentConfig**

Create `apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  hasActiveOverride,
  classifyAgentConfig,
  mergeConfigPayload,
  buildInspectResult,
} from '@/lib/arch-ai/tools/configure-model';

describe('hasActiveOverride', () => {
  it('returns false for all-null config (empty defaults)', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(false);
  });

  it('returns false for null operationModels', () => {
    const config = {
      defaultModel: null,
      operationModels: null,
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(false);
  });

  it('returns true when defaultModel is set', () => {
    const config = {
      defaultModel: 'claude-sonnet-4-6',
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(true);
  });

  it('returns true when only useStreaming is set', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: true,
    };
    expect(hasActiveOverride(config)).toBe(true);
  });

  it('returns true when operationModels has keys', () => {
    const config = {
      defaultModel: null,
      operationModels: { extraction: 'claude-haiku-4-5' },
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(true);
  });

  it('returns true when hyperParameters has keys', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: { enableThinking: true },
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(true);
  });

  it('returns false for empty hyperParameters object', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: {},
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(hasActiveOverride(config)).toBe(false);
  });
});

describe('classifyAgentConfig', () => {
  it('returns inherited for all-null config', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(classifyAgentConfig(config)).toBe('inherited');
  });

  it('returns configured when any field is active', () => {
    const config = {
      defaultModel: 'gpt-4o',
      operationModels: {},
      temperature: 0.5,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    expect(classifyAgentConfig(config)).toBe('configured');
  });
});

describe('mergeConfigPayload', () => {
  it('overlays new fields while preserving unmanaged fields', () => {
    const current = {
      defaultModel: 'gpt-4o-mini',
      operationModels: {},
      temperature: 0.7,
      maxTokens: 2048,
      hyperParameters: { enableThinking: true },
      useResponsesApi: false,
      useStreaming: true,
    };
    const overlay = {
      defaultModel: 'claude-sonnet-4-6',
      temperature: 0.3,
      maxTokens: 4096,
      operationModels: { extraction: 'claude-haiku-4-5' },
    };
    const result = mergeConfigPayload(current, overlay);

    expect(result.defaultModel).toBe('claude-sonnet-4-6');
    expect(result.temperature).toBe(0.3);
    expect(result.maxTokens).toBe(4096);
    expect(result.operationModels).toEqual({ extraction: 'claude-haiku-4-5' });
    // Preserved unmanaged fields:
    expect(result.hyperParameters).toEqual({ enableThinking: true });
    expect(result.useResponsesApi).toBe(false);
    expect(result.useStreaming).toBe(true);
  });

  it('preserves current values when overlay fields are undefined', () => {
    const current = {
      defaultModel: 'gpt-4o',
      operationModels: { summarization: 'gpt-4o-mini' },
      temperature: 0.5,
      maxTokens: 1024,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    const overlay = {
      defaultModel: 'claude-sonnet-4-6',
    };
    const result = mergeConfigPayload(current, overlay);

    expect(result.defaultModel).toBe('claude-sonnet-4-6');
    expect(result.operationModels).toEqual({ summarization: 'gpt-4o-mini' });
    expect(result.temperature).toBe(0.5);
    expect(result.maxTokens).toBe(1024);
  });
});

describe('buildInspectResult', () => {
  it('formats configured agent with LLM and execution fields', () => {
    const config = {
      defaultModel: 'claude-sonnet-4-6',
      operationModels: { extraction: 'claude-haiku-4-5' },
      temperature: 0.3,
      maxTokens: 4096,
      hyperParameters: { enableThinking: true },
      useResponsesApi: null,
      useStreaming: true,
    };
    const result = buildInspectResult('BillingAgent', config);

    expect(result.agentName).toBe('BillingAgent');
    expect(result.status).toBe('configured');
    expect(result.llmSelection.defaultModel).toBe('claude-sonnet-4-6');
    expect(result.llmSelection.temperature).toBe(0.3);
    expect(result.llmSelection.maxTokens).toBe(4096);
    expect(result.llmSelection.operationModels).toEqual({ extraction: 'claude-haiku-4-5' });
    expect(result.execution.useStreaming).toBe(true);
    expect(result.execution.hyperParameters).toEqual({ enableThinking: true });
  });

  it('formats inherited agent', () => {
    const config = {
      defaultModel: null,
      operationModels: {},
      temperature: null,
      maxTokens: null,
      hyperParameters: null,
      useResponsesApi: null,
      useStreaming: null,
    };
    const result = buildInspectResult('SupportAgent', config);

    expect(result.agentName).toBe('SupportAgent');
    expect(result.status).toBe('inherited');
    expect(result.message).toContain('No agent-level override');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`
Expected: FAIL — module `@/lib/arch-ai/tools/configure-model` does not exist.

- [ ] **Step 3: Implement the pure helper functions**

Create `apps/studio/src/lib/arch-ai/tools/configure-model.ts`:

```typescript
/**
 * configure_model tool — inspect, diff, apply model configurations.
 *
 * Spec: docs/superpowers/specs/2026-04-13-configure-model-tool-design.md
 * Ticket: ABLP-162
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('arch-ai:configure-model');

// ─── Types ──────────────────────────────────────────────────────────────

/** Raw config shape from GET /api/projects/:id/agents/:name/model-config */
export interface AgentModelConfigResponse {
  defaultModel: string | null;
  operationModels: Record<string, string> | null;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
}

export interface InspectResult {
  agentName: string;
  status: 'configured' | 'inherited';
  llmSelection?: {
    defaultModel: string | null;
    temperature: number | null;
    maxTokens: number | null;
    operationModels: Record<string, string> | null;
  };
  execution?: {
    hyperParameters: Record<string, unknown> | null;
    useResponsesApi: boolean | null;
    useStreaming: boolean | null;
  };
  message?: string;
}

export interface ConfigOverlay {
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  operationModels?: Record<string, string>;
}

export interface MergedConfigPayload {
  defaultModel: string | null;
  operationModels: Record<string, string> | null;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
}

// ─── Pure Helpers ───────────────────────────────────────────────────────

/**
 * Check if an AgentModelConfig has any active override.
 * Scalars: non-null counts. Objects: non-null AND has at least one key.
 * Returns false for the empty-defaults shape the GET endpoint returns.
 */
export function hasActiveOverride(config: AgentModelConfigResponse): boolean {
  // Scalar fields
  if (config.defaultModel != null) return true;
  if (config.temperature != null) return true;
  if (config.maxTokens != null) return true;
  if (config.useResponsesApi != null) return true;
  if (config.useStreaming != null) return true;

  // Object fields — non-null AND non-empty
  if (config.operationModels != null && Object.keys(config.operationModels).length > 0) {
    return true;
  }
  if (config.hyperParameters != null && Object.keys(config.hyperParameters).length > 0) {
    return true;
  }

  return false;
}

/**
 * Classify an agent's model config status.
 */
export function classifyAgentConfig(config: AgentModelConfigResponse): 'configured' | 'inherited' {
  return hasActiveOverride(config) ? 'configured' : 'inherited';
}

/**
 * Build a structured inspect result for a single agent.
 */
export function buildInspectResult(
  agentName: string,
  config: AgentModelConfigResponse,
): InspectResult {
  const status = classifyAgentConfig(config);

  if (status === 'inherited') {
    return {
      agentName,
      status,
      message:
        'No agent-level override — model resolved at runtime from project or tenant defaults',
    };
  }

  return {
    agentName,
    status,
    llmSelection: {
      defaultModel: config.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      operationModels:
        config.operationModels && Object.keys(config.operationModels).length > 0
          ? config.operationModels
          : null,
    },
    execution: {
      hyperParameters:
        config.hyperParameters && Object.keys(config.hyperParameters).length > 0
          ? config.hyperParameters
          : null,
      useResponsesApi: config.useResponsesApi,
      useStreaming: config.useStreaming,
    },
  };
}

/**
 * Merge an overlay of LLM-selection fields onto the current config,
 * preserving unmanaged fields (hyperParameters, useResponsesApi, useStreaming).
 */
export function mergeConfigPayload(
  current: AgentModelConfigResponse,
  overlay: ConfigOverlay,
): MergedConfigPayload {
  return {
    defaultModel: overlay.defaultModel ?? current.defaultModel,
    temperature: overlay.temperature ?? current.temperature,
    maxTokens: overlay.maxTokens ?? current.maxTokens,
    operationModels: overlay.operationModels ?? current.operationModels,
    // Unmanaged fields — always preserve from current
    hyperParameters: current.hyperParameters,
    useResponsesApi: current.useResponsesApi,
    useStreaming: current.useStreaming,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/configure-model.ts apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts
git add apps/studio/src/lib/arch-ai/tools/configure-model.ts apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts
git commit -m "[ABLP-162] feat(studio): add configure_model pure helpers with tests"
```

---

### Task 4: Implement API-calling functions

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/configure-model.ts`

- [ ] **Step 1: Add fetchAgentConfig function**

Append to `apps/studio/src/lib/arch-ai/tools/configure-model.ts`:

```typescript
// ─── API Callers ────────────────────────────────────────────────────────

interface FetchContext {
  projectId: string;
  tenantId: string;
  authToken: string;
}

function studioHeaders(ctx: FetchContext): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.authToken}`,
    'X-Tenant-Id': ctx.tenantId,
  };
}

/**
 * GET the agent model config from the Studio proxy API.
 * Returns the config fields or the empty-defaults shape.
 */
export async function fetchAgentConfig(
  ctx: FetchContext,
  agentName: string,
): Promise<
  { success: true; config: AgentModelConfigResponse } | { success: false; error: string }
> {
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/agents/${agentName}/model-config`;

  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 404) return { success: false, error: `Agent '${agentName}' not found` };
      return { success: false, error: `Failed to fetch config: ${res.status}` };
    }
    const body = await res.json();
    return { success: true, config: body.config };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch tenant models with a live call (bypasses list_models cache).
 * Used by the ensure-project-ModelConfig flow.
 */
export async function fetchTenantModelsLive(
  ctx: FetchContext,
): Promise<
  { success: true; models: any[] } | { success: false; error: { code: string; message: string } }
> {
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const url = `${getStudioBaseUrl()}/api/tenant-models`;

  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message:
            'Model configuration requires credential:read permission to enumerate available models.',
        },
      };
    }
    if (!res.ok) {
      return {
        success: false,
        error: { code: 'FETCH_ERROR', message: `Failed to fetch tenant models: ${res.status}` },
      };
    }
    const body = await res.json();
    return { success: true, models: body.data ?? body };
  } catch (err) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Fetch project ModelConfig entries for this project.
 */
export async function fetchProjectModelConfigs(
  ctx: FetchContext,
): Promise<{ success: true; models: any[] } | { success: false; error: string }> {
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const url = `${getStudioBaseUrl()}/api/models?projectId=${ctx.projectId}`;

  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `Failed to fetch project models: ${res.status}` };
    const body = await res.json();
    return { success: true, models: body.models ?? [] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create a project ModelConfig entry linking a model to a TenantModel.
 */
export async function createProjectModelConfig(
  ctx: FetchContext,
  params: {
    modelId: string;
    provider: string;
    tenantModelId: string;
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    contextWindow: number;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const url = `${getStudioBaseUrl()}/api/models`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: studioHeaders(ctx),
      body: JSON.stringify({
        projectId: ctx.projectId,
        name: params.modelId,
        modelId: params.modelId,
        provider: params.provider,
        tenantModelId: params.tenantModelId,
        supportsTools: params.supportsTools,
        supportsVision: params.supportsVision,
        supportsStreaming: params.supportsStreaming,
        contextWindow: params.contextWindow,
        tier: 'balanced',
        isDefault: false,
        priority: 0,
        temperature: 0.7,
        maxTokens: 4096,
        topP: 1.0,
        frequencyPenalty: 0,
        presencePenalty: 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body.error ?? `Failed to create project model: ${res.status}`,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * PUT the merged config to the agent model config endpoint.
 */
export async function writeAgentModelConfig(
  ctx: FetchContext,
  agentName: string,
  payload: MergedConfigPayload,
): Promise<{ success: true } | { success: false; error: string }> {
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/agents/${agentName}/model-config`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: studioHeaders(ctx),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body.error ?? `Failed to write config: ${res.status}`,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 2: Add ensureProjectModelConfig function**

Continue appending to the same file:

```typescript
/**
 * Ensure a project ModelConfig exists for the given modelId + provider.
 * If missing, creates one from the matching TenantModel.
 * Returns error codes: MODEL_NOT_AVAILABLE, MODEL_PROVIDER_CONFLICT,
 * AMBIGUOUS_TENANT_MODEL, INSUFFICIENT_PERMISSIONS.
 */
export async function ensureProjectModelConfig(
  ctx: FetchContext,
  modelId: string,
  provider: string,
): Promise<{ success: true } | { success: false; error: { code: string; message: string } }> {
  // Step 1: Check existing project ModelConfigs
  const projectResult = await fetchProjectModelConfigs(ctx);
  if (!projectResult.success) {
    return { success: false, error: { code: 'FETCH_ERROR', message: projectResult.error } };
  }

  const existingByModelId = projectResult.models.filter((m: any) => m.modelId === modelId);

  if (existingByModelId.length > 0) {
    const sameProvider = existingByModelId.find((m: any) => m.provider === provider);
    if (sameProvider) return { success: true }; // Already exists with correct provider

    // Different provider conflict
    const existingProvider = existingByModelId[0].provider;
    return {
      success: false,
      error: {
        code: 'MODEL_PROVIDER_CONFLICT',
        message: `This project already has ${modelId} configured via ${existingProvider}. Runtime resolves by modelId only, so adding the same modelId from ${provider} would be non-deterministic. Remove the existing config first, or choose a different model.`,
      },
    };
  }

  // Step 2: Live tenant model lookup
  const tenantResult = await fetchTenantModelsLive(ctx);
  if (!tenantResult.success) return tenantResult;

  // Filter by modelId + provider, then to usable entries
  const matches = tenantResult.models.filter(
    (m: any) =>
      m.modelId === modelId &&
      m.provider === provider &&
      m.isActive === true &&
      m.inferenceEnabled !== false &&
      (m._count?.connections > 0 || (m.connections && m.connections.length > 0)),
  );

  if (matches.length === 0) {
    return {
      success: false,
      error: {
        code: 'MODEL_NOT_AVAILABLE',
        message: `No usable tenant model found for ${modelId} (${provider}). Ensure it is active, inference-enabled, and has at least one connection.`,
      },
    };
  }

  if (matches.length > 1) {
    return {
      success: false,
      error: {
        code: 'AMBIGUOUS_TENANT_MODEL',
        message: `Multiple tenant model entries match ${modelId} (${provider}). Select a specific one in Tenant Models settings.`,
      },
    };
  }

  // Step 3: Create project ModelConfig from the single match
  const tenantModel = matches[0];
  const createResult = await createProjectModelConfig(ctx, {
    modelId,
    provider,
    tenantModelId: tenantModel._id ?? tenantModel.id,
    supportsTools: tenantModel.capabilities?.includes('tool_calling') ?? true,
    supportsVision: tenantModel.capabilities?.includes('vision') ?? false,
    supportsStreaming: tenantModel.capabilities?.includes('streaming') ?? true,
    contextWindow: tenantModel.contextWindow ?? 128000,
  });

  if (!createResult.success) {
    return {
      success: false,
      error: { code: 'CONFIG_WRITE_FAILED', message: createResult.error },
    };
  }

  log.info('Created project ModelConfig for agent override', {
    projectId: ctx.projectId,
    modelId,
    provider,
  });
  return { success: true };
}
```

- [ ] **Step 3: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/configure-model.ts
git add apps/studio/src/lib/arch-ai/tools/configure-model.ts
git commit -m "[ABLP-162] feat(studio): add configure_model API callers and ensureProjectModelConfig"
```

---

### Task 5: Implement the tool execute function

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/configure-model.ts`

- [ ] **Step 1: Add the main executeConfigureModel function**

Append to `apps/studio/src/lib/arch-ai/tools/configure-model.ts`:

```typescript
// ─── Tool Actions ───────────────────────────────────────────────────────

import type { ToolPermissionContext } from '../guards';
import { checkToolPermission, isDangerousAction } from '../guards';

export interface ConfigureModelInput {
  action: 'inspect' | 'diff' | 'apply';
  agentName: string;
  source?: 'recommendation' | 'manual';
  modelId?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  operationModels?: Record<string, string>;
  confirmed?: boolean;
}

export interface ConfigureModelResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string; availableModels?: string[] };
  needsConfirmation?: boolean;
  warning?: string;
  cancelled?: boolean;
}

export async function executeConfigureModel(
  input: ConfigureModelInput,
  ctx: ToolPermissionContext & { authToken: string },
  projectId: string,
): Promise<ConfigureModelResult> {
  const { action, agentName } = input;

  // Permission check
  const permCheck = await checkToolPermission('configure_model', action, ctx);
  if (!permCheck.allowed) {
    return {
      success: false,
      error: { code: 'PERMISSION_DENIED', message: permCheck.error ?? 'Permission denied' },
    };
  }

  const fetchCtx: FetchContext = {
    projectId,
    tenantId: ctx.user.tenantId,
    authToken: ctx.authToken,
  };

  switch (action) {
    case 'inspect':
      return executeInspect(fetchCtx, agentName);
    case 'diff':
      return executeDiff(fetchCtx, agentName);
    case 'apply':
      return executeApply(fetchCtx, input);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
      };
  }
}

// ─── inspect ────────────────────────────────────────────────────────────

async function executeInspect(ctx: FetchContext, agentName: string): Promise<ConfigureModelResult> {
  if (agentName === 'all') {
    return executeInspectAll(ctx);
  }

  const result = await fetchAgentConfig(ctx, agentName);
  if (!result.success) {
    return { success: false, error: { code: 'AGENT_NOT_FOUND', message: result.error } };
  }

  return { success: true, data: buildInspectResult(agentName, result.config) };
}

async function executeInspectAll(ctx: FetchContext): Promise<ConfigureModelResult> {
  // Fetch agent list via platform_context.list_agents pattern
  const { getStudioBaseUrl } = await import('@/lib/arch-ai/tools/platform-context');
  const { listAgents } = await import('@/lib/arch-ai/tools/platform-context');
  const agentsResult = await listAgents(ctx.tenantId, ctx.authToken);

  if (!agentsResult.success) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: 'Failed to fetch project agents' },
    };
  }

  const agents: Array<{ name: string }> = (agentsResult.data as any)?.agents ?? [];
  const results: InspectResult[] = [];

  for (const agent of agents) {
    const configResult = await fetchAgentConfig(ctx, agent.name);
    if (configResult.success) {
      results.push(buildInspectResult(agent.name, configResult.config));
    } else {
      results.push({ agentName: agent.name, status: 'inherited', message: configResult.error });
    }
  }

  return { success: true, data: { agents: results } };
}

// ─── diff ───────────────────────────────────────────────────────────────

async function executeDiff(ctx: FetchContext, agentName: string): Promise<ConfigureModelResult> {
  const { getModelRecommendation } = await import('@/lib/arch-ai/helpers/get-model-recommendation');
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const agentNames =
    agentName === 'all'
      ? await ProjectAgent.find({ projectId: ctx.projectId, tenantId: ctx.tenantId })
          .select('name tools')
          .lean()
      : [
          await ProjectAgent.findOne({
            projectId: ctx.projectId,
            tenantId: ctx.tenantId,
            name: agentName,
          })
            .select('name tools')
            .lean(),
        ];

  const diffs: Array<{
    agentName: string;
    current: string;
    recommended: string;
    reason: string;
    changed: boolean;
  }> = [];

  for (const agent of agentNames) {
    if (!agent) continue;

    const configResult = await fetchAgentConfig(ctx, agent.name);
    const currentModel = configResult.success ? configResult.config.defaultModel : null;

    const toolCount = Array.isArray((agent as any).tools) ? (agent as any).tools.length : 0;
    const recommendation = getModelRecommendation({
      agentRole: 'specialist',
      executionMode: toolCount > 3 ? 'reasoning' : 'scripted',
      requiresToolCalling: toolCount > 0,
      requiresVision: false,
      requiresStructuredOutput: false,
      complexityTier: toolCount <= 2 ? 'simple' : toolCount <= 5 ? 'moderate' : 'complex',
    });

    const recModel = recommendation.primary.model;
    const changed = currentModel !== recModel;

    diffs.push({
      agentName: agent.name,
      current: currentModel ?? 'inherited',
      recommended: recModel,
      reason: recommendation.primary.reason,
      changed,
    });
  }

  return { success: true, data: { diffs } };
}

// ─── apply ──────────────────────────────────────────────────────────────

async function executeApply(
  ctx: FetchContext,
  input: ConfigureModelInput,
): Promise<ConfigureModelResult> {
  const { source, agentName } = input;

  if (!source) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'apply action requires source (recommendation | manual)',
      },
    };
  }

  // Dangerous-action confirmation round-trip
  if (isDangerousAction('configure_model', 'apply') && !input.confirmed) {
    // Build the diff data for the LLM to present before asking for confirmation
    const diffResult =
      source === 'recommendation'
        ? await buildRecommendationDiff(ctx, input)
        : buildManualDiff(input);

    if (!diffResult.success) return diffResult;

    const agentCount = agentName === 'all' ? ((diffResult.data as any)?.changes?.length ?? 0) : 1;
    const summary =
      agentName === 'all'
        ? `Apply model config changes to ${agentCount} agent(s)?`
        : `Apply model config changes to ${agentName}?`;

    return {
      needsConfirmation: true,
      warning: summary,
      data: diffResult.data,
    };
  }

  // Confirmed — execute the write
  if (source === 'recommendation') {
    return executeApplyRecommendation(ctx, input);
  }
  return executeApplyManual(ctx, input);
}

async function buildRecommendationDiff(
  ctx: FetchContext,
  input: ConfigureModelInput,
): Promise<ConfigureModelResult> {
  const diffResult = await executeDiff(ctx, input.agentName);
  if (!diffResult.success) return diffResult;

  const diffs = (diffResult.data as any)?.diffs ?? [];
  const changes = diffs.filter((d: any) => d.changed);

  return {
    success: true,
    data: {
      changes,
      unchanged: diffs.filter((d: any) => !d.changed).map((d: any) => d.agentName),
    },
  };
}

function buildManualDiff(input: ConfigureModelInput): ConfigureModelResult {
  if (!input.modelId || !input.provider) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Manual apply requires modelId and provider' },
    };
  }

  return {
    success: true,
    data: {
      changes: [
        {
          agentName: input.agentName,
          recommended: input.modelId,
          provider: input.provider,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          operationModels: input.operationModels,
        },
      ],
    },
  };
}

async function executeApplyRecommendation(
  ctx: FetchContext,
  input: ConfigureModelInput,
): Promise<ConfigureModelResult> {
  const { getModelRecommendation } = await import('@/lib/arch-ai/helpers/get-model-recommendation');
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const agents =
    input.agentName === 'all'
      ? await ProjectAgent.find({ projectId: ctx.projectId, tenantId: ctx.tenantId })
          .select('name tools')
          .lean()
      : [
          await ProjectAgent.findOne({
            projectId: ctx.projectId,
            tenantId: ctx.tenantId,
            name: input.agentName,
          })
            .select('name tools')
            .lean(),
        ];

  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ agentName: string; error: string }> = [];

  for (const agent of agents) {
    if (!agent) continue;

    const toolCount = Array.isArray((agent as any).tools) ? (agent as any).tools.length : 0;
    const recommendation = getModelRecommendation({
      agentRole: 'specialist',
      executionMode: toolCount > 3 ? 'reasoning' : 'scripted',
      requiresToolCalling: toolCount > 0,
      requiresVision: false,
      requiresStructuredOutput: false,
      complexityTier: toolCount <= 2 ? 'simple' : toolCount <= 5 ? 'moderate' : 'complex',
    });

    if (recommendation.tenantFilterUnavailable) {
      errors.push({
        agentName: agent.name,
        error: `No tenant-available models match requirements. Recommendation (${recommendation.primary.model}) is from general catalog.`,
      });
      continue;
    }

    // Check if already configured with recommended model
    const configResult = await fetchAgentConfig(ctx, agent.name);
    if (configResult.success && configResult.config.defaultModel === recommendation.primary.model) {
      skipped.push(agent.name);
      continue;
    }

    // Ensure project ModelConfig exists
    const ensureResult = await ensureProjectModelConfig(
      ctx,
      recommendation.primary.model,
      recommendation.primary.provider,
    );
    if (!ensureResult.success) {
      errors.push({ agentName: agent.name, error: ensureResult.error.message });
      continue;
    }

    // Ensure for per-operation models
    if (recommendation.perOperation) {
      for (const [op, scored] of Object.entries(recommendation.perOperation)) {
        const opEnsure = await ensureProjectModelConfig(ctx, scored.model, scored.provider);
        if (!opEnsure.success) {
          errors.push({
            agentName: agent.name,
            error: `Operation ${op}: ${opEnsure.error.message}`,
          });
          continue;
        }
      }
    }

    // Read-merge-write
    const currentConfig = configResult.success
      ? configResult.config
      : {
          defaultModel: null,
          operationModels: {},
          temperature: null,
          maxTokens: null,
          hyperParameters: null,
          useResponsesApi: null,
          useStreaming: null,
        };

    const overlay: ConfigOverlay = {
      defaultModel: recommendation.primary.model,
      temperature: recommendation.executionConfig.temperature,
      maxTokens: recommendation.executionConfig.maxTokens,
    };
    if (recommendation.perOperation) {
      overlay.operationModels = Object.fromEntries(
        Object.entries(recommendation.perOperation).map(([op, scored]) => [op, scored.model]),
      );
    }

    const merged = mergeConfigPayload(currentConfig, overlay);
    const writeResult = await writeAgentModelConfig(ctx, agent.name, merged);
    if (!writeResult.success) {
      errors.push({ agentName: agent.name, error: writeResult.error });
      continue;
    }

    applied.push(agent.name);
  }

  return {
    success: true,
    data: { applied, skipped, errors },
  };
}

async function executeApplyManual(
  ctx: FetchContext,
  input: ConfigureModelInput,
): Promise<ConfigureModelResult> {
  if (!input.modelId || !input.provider) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Manual apply requires modelId and provider' },
    };
  }

  // Ensure project ModelConfig
  const ensureResult = await ensureProjectModelConfig(ctx, input.modelId, input.provider);
  if (!ensureResult.success) return ensureResult;

  // Read current config
  const configResult = await fetchAgentConfig(ctx, input.agentName);
  const currentConfig = configResult.success
    ? configResult.config
    : {
        defaultModel: null,
        operationModels: {},
        temperature: null,
        maxTokens: null,
        hyperParameters: null,
        useResponsesApi: null,
        useStreaming: null,
      };

  // Merge and write
  const overlay: ConfigOverlay = {
    defaultModel: input.modelId,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.operationModels ? { operationModels: input.operationModels } : {}),
  };

  const merged = mergeConfigPayload(currentConfig, overlay);
  const writeResult = await writeAgentModelConfig(ctx, input.agentName, merged);
  if (!writeResult.success) {
    return { success: false, error: { code: 'CONFIG_WRITE_FAILED', message: writeResult.error } };
  }

  return {
    success: true,
    data: {
      applied: [input.agentName],
      model: input.modelId,
      provider: input.provider,
    },
  };
}
```

- [ ] **Step 2: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/tools/configure-model.ts
git add apps/studio/src/lib/arch-ai/tools/configure-model.ts
git commit -m "[ABLP-162] feat(studio): implement configure_model execute actions"
```

---

### Task 6: Wire into buildInProjectTools and specialist map

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

- [ ] **Step 1: Add configure_model to IN_PROJECT_SPECIALIST_TOOL_MAP**

In `apps/studio/src/app/api/arch-ai/message/route.ts`, find the `IN_PROJECT_SPECIALIST_TOOL_MAP` (~line 713). Add `'configure_model'` and `'recommend_model'` to the `abl-construct-expert` and `diagnostician` arrays:

For `'abl-construct-expert'` (after `'tools_ops'`):

```typescript
  'abl-construct-expert': [
    'read_agent', 'propose_modification', 'apply_modification', 'dismiss_proposal',
    'compile_abl', 'read_topology', 'health_check', 'ask_user', 'project_config',
    'tools_ops', 'configure_model', 'recommend_model',
  ],
```

For `'diagnostician'` (after `'project_config'`):

```typescript
  diagnostician: [
    'validate_agent', 'diagnose_project', 'explain_diagnostic', 'read_agent',
    'query_traces', 'propose_modification', 'dismiss_proposal', 'health_check',
    'ask_user', 'project_config', 'configure_model', 'recommend_model',
  ],
```

- [ ] **Step 2: Register configure_model tool in buildInProjectTools**

In the `buildInProjectTools` function (~line 2181), add the `configure_model` tool definition after the `recommend_model` tool (~line 2540). Use the same `tool()` pattern:

```typescript
    configure_model: tool({
      description:
        'Inspect, compare, or apply LLM model configurations for agents. ' +
        'Actions: inspect (show current config), diff (current vs recommended), ' +
        'apply (write config from recommendation or manual input). ' +
        'Supports single agent or "all" for topology-wide.',
      inputSchema: z.object({
        action: z.enum(['inspect', 'diff', 'apply']).describe('Action to perform'),
        agentName: z.string().min(1).describe('Agent name, or "all" for topology-wide'),
        source: z.enum(['recommendation', 'manual']).optional().describe('Required for apply'),
        modelId: z.string().optional().describe('Model ID for manual source'),
        provider: z.string().optional().describe('Provider for manual source'),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(1).optional(),
        operationModels: z.record(z.string(), z.string()).optional(),
        confirmed: z.boolean().optional(),
      }),
      execute: async (input) => {
        const { executeConfigureModel } = await import(
          '@/lib/arch-ai/tools/configure-model'
        );
        return executeConfigureModel(
          input,
          { ...ctx, authToken: authToken ?? '', user: { ...ctx, permissions: ctx.permissions ?? [] } },
          projectId,
        );
      },
    }),
```

- [ ] **Step 3: Build to verify types**

Run: `pnpm build --filter=abl-studio`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): wire configure_model into buildInProjectTools and specialist map"
```

---

### Task 7: Add runtime cache invalidation

**Files:**

- Modify: `apps/runtime/src/routes/agent-model-config.ts:169-267`

- [ ] **Step 1: Add cache invalidation import**

At the top of `apps/runtime/src/routes/agent-model-config.ts`, add the import (after existing imports ~line 24):

```typescript
import { invalidateModelResolutionCaches } from '../services/llm/model-cache-invalidation.js';
```

- [ ] **Step 2: Add cache invalidation after upsert**

In the PUT handler, after the successful `upsertAgentModelConfig` call and before the response (~line 242), add:

```typescript
log.info('Agent model config saved', {
  projectId,
  agentName,
  defaultModel: config.defaultModel,
});

// Invalidate model resolution caches so the new config takes effect immediately
const tenantId = req.tenantContext!.tenantId;
invalidateModelResolutionCaches(tenantId).catch((err: unknown) => {
  log.warn('Failed to invalidate model resolution caches', {
    error: err instanceof Error ? err.message : String(err),
    tenantId,
  });
});

// Defense-in-depth: warn if defaultModel has no project ModelConfig
if (config.defaultModel) {
  const { ModelConfig } = await import('@agent-platform/database/models');
  const projectModelConfig = await ModelConfig.findOne({
    projectId,
    modelId: config.defaultModel,
  }).lean();
  if (!projectModelConfig) {
    log.warn('Agent model config references model with no project ModelConfig entry', {
      projectId,
      agentName,
      defaultModel: config.defaultModel,
    });
  }
}
```

- [ ] **Step 3: Build to verify types**

Run: `pnpm build --filter=@abl/runtime`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/agent-model-config.ts
git add apps/runtime/src/routes/agent-model-config.ts
git commit -m "[ABLP-162] feat(runtime): add cache invalidation to agent model config PUT"
```

---

### Task 8: Update specialist prompts

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
- Modify: `packages/arch-ai/src/prompts/specialists/diagnostician.ts`

- [ ] **Step 1: Add Model Configuration section to ABL construct expert prompt**

In `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`, add the following section to `ABL_CONSTRUCT_EXPERT_PROMPT` after the Tool Management section (~line 190, before the closing backtick):

```typescript
## Model Configuration
- Use configure_model to inspect, compare, or apply LLM model configurations
- **Inspect**: configure_model(action: 'inspect', agentName) — shows current config vs inherited defaults
- **Diff**: configure_model(action: 'diff', agentName) — compares current config to recommendations
- **Apply recommendation**: configure_model(action: 'apply', agentName, source: 'recommendation') — applies optimal model based on agent complexity
- **Apply manual**: configure_model(action: 'apply', agentName, source: 'manual', modelId, provider) — sets a specific model
- Use recommend_model first to analyze what model fits, then configure_model to apply it
- apply requires user confirmation — the tool handles this via the confirmation round-trip
- When modifying an agent's tools or complexity, suggest re-running recommend_model to check if the model still fits
```

- [ ] **Step 2: Add model mismatch guidance to diagnostician prompt**

In `packages/arch-ai/src/prompts/specialists/diagnostician.ts`, add the following to the `DIAGNOSTICIAN_PROMPT` (after the diagnostic codes reference, before the closing backtick):

```typescript
## Model Configuration Diagnostics
- When validate_agent or diagnose_project reveals capability mismatches (e.g., complex agent with many tools using a low-tier model), suggest using configure_model to fix it
- Use recommend_model to get the optimal model for the agent, then offer configure_model(action: 'apply', source: 'recommendation') to apply it
- Common signals: agent with 5+ tools using GPT-4o-mini (weak tool calling), simple 1-tool agent using Claude Sonnet (overprovisioned and expensive)
- Use configure_model(action: 'inspect', agentName: 'all') to get a topology-wide view of model assignments
```

- [ ] **Step 3: Build the arch-ai package**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts packages/arch-ai/src/prompts/specialists/diagnostician.ts
git add packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts packages/arch-ai/src/prompts/specialists/diagnostician.ts
git commit -m "[ABLP-162] feat(compiler): add model config guidance to specialist prompts"
```

---

### Task 9: Update IN_PROJECT phase prompt

**Files:**

- Modify: `packages/arch-ai/src/prompts/phases/in-project.ts`

- [ ] **Step 1: Add configure_model to available tools list**

In `packages/arch-ai/src/prompts/phases/in-project.ts`, update the `IN_PROJECT_PHASE_PROMPT`. Add `configure_model` to the "Available tools" line (~line 10):

```typescript
**Available tools:** read_agent, propose_modification, apply_modification, dismiss_proposal, compile_abl, read_topology, health_check, validate_agent, diagnose_project, explain_diagnostic, query_traces, run_test, recommend_model, configure_model, analyze_constraints, read_journal, read_insights, project_config, tools_ops, auth_ops, collect_secret, ask_user
```

- [ ] **Step 2: Add Model Configuration capabilities section**

Add after the "Recommend optimal LLM models" line (~line 28) and before the Agent Modification Workflow section:

```typescript
- Configure LLM models for agents (configure_model) — inspect current config, diff against recommendations, apply changes
```

- [ ] **Step 3: Add Model Configuration workflow section**

Add after the Project Configuration section (~line 65), before the closing "No phase transitions" line:

```typescript
## Model Configuration
- Use configure_model(action: 'inspect') to show what models are configured for agents
- Use configure_model(action: 'diff') to compare current configs against recommendations
- Use configure_model(action: 'apply', source: 'recommendation') to apply recommended models
- Use configure_model(action: 'apply', source: 'manual', modelId, provider) to set a specific model
- The apply action requires user confirmation — follows the same dangerous-action pattern as project_config
- For topology-wide operations, use agentName: 'all'
```

- [ ] **Step 4: Build the arch-ai package**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/phases/in-project.ts
git add packages/arch-ai/src/prompts/phases/in-project.ts
git commit -m "[ABLP-162] feat(compiler): add configure_model to IN_PROJECT phase prompt"
```

---

### Task 10: Full build and test verification

**Files:**

- All previously modified files

- [ ] **Step 1: Build all affected packages**

Run: `pnpm build --filter=@agent-platform/arch-ai --filter=abl-studio --filter=@abl/runtime`
Expected: All three packages build successfully.

- [ ] **Step 2: Run existing arch-ai tests**

Run: `pnpm vitest run apps/studio/src/__tests__/arch-ai/`
Expected: All existing tests still pass. The new `configure-model-helpers.test.ts` passes.

- [ ] **Step 3: Run the in-project types test**

Run: `pnpm vitest run packages/arch-ai/src/__tests__/in-project-types.test.ts`
Expected: PASS — verifies `configure_model` is in ToolName and IN_PROJECT_TOOLS.

- [ ] **Step 4: Run prettier on all changed files**

```bash
npx prettier --write \
  packages/arch-ai/src/types/tools.ts \
  packages/arch-ai/src/tools/schemas/in-project-schemas.ts \
  packages/arch-ai/src/prompts/phases/in-project.ts \
  packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts \
  packages/arch-ai/src/prompts/specialists/diagnostician.ts \
  apps/studio/src/lib/arch-ai/guards.ts \
  apps/studio/src/lib/arch-ai/tools/configure-model.ts \
  apps/studio/src/components/arch-v3/chat/ActivitySteps.tsx \
  apps/studio/src/app/api/arch-ai/message/route.ts \
  apps/runtime/src/routes/agent-model-config.ts
```

- [ ] **Step 5: Verify no type errors across the workspace**

Run: `pnpm build`
Expected: Full workspace build succeeds.
