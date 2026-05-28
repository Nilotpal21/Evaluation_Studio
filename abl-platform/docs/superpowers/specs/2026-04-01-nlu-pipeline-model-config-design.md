# NLU Pipeline LLM Model Config Design

**Date:** 2026-04-01
**Status:** Approved
**Branch:** `feature/nlu-pipeline-enhancements`

## Problem

The pipeline classifier's model selection is broken:

1. The `PipelineConfig.model` field is a free-text string (default `'qwen3-30b'`) that is **never used** by the runtime. The classifier resolves its model via `session.llmClient.resolveLanguageModel('tool_selection')`, which walks the 6-level DB-backed resolution chain and ignores the config value entirely.
2. The Studio UI (`RuntimeConfigTab.tsx`) shows a free-text input for the model name, giving the impression that users control the classifier model — but they don't.
3. There is no way to pin the pipeline classifier to a specific tenant-configured model independent of the `tool_selection` operation tier.

## Solution

Replace the free-text `model` field with a discriminated model source that supports two options:

- **Default** — uses the existing `resolveLanguageModel('tool_selection')` path. Zero behavior change.
- **Tenant Model** — resolves a specific `TenantModel` by ID, loads its credential, and creates a `LanguageModel` directly. Gives users explicit control.

## Design

### 1. Config Schema Changes

#### PipelineConfig type (`apps/runtime/src/services/pipeline/types.ts`)

Remove `model: string`. Add:

```typescript
interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  modelSource: 'default' | 'tenant';
  tenantModelId?: string; // required when modelSource is 'tenant'
  shortCircuit: {
    enabled: boolean;
    confidenceThreshold: number;
  };
  toolFilter: {
    enabled: boolean;
    maxTools: number;
  };
  keywordVeto: {
    enabled: boolean;
    keywords: string[];
  };
  intentBridge: IntentBridgeConfig;
}
```

Default values:

```typescript
const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  enabled: false,
  mode: 'parallel',
  modelSource: 'default',
  tenantModelId: undefined,
  // ... rest unchanged
};
```

#### Zod schema (`apps/runtime/src/routes/project-runtime-config.ts`)

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

Remove the old `model` field from the Zod schema. Keep `model` as an ignored field in the DB for backward compatibility (no migration needed).

#### IR schema (`packages/compiler/src/platform/ir/schema.ts`)

Update the pipeline config type at both locations (line ~232 project-level, line ~630 agent-level) to match: replace `model?: string` with `modelSource?: 'default' | 'tenant'` and `tenantModelId?: string`.

### 2. New Resolver Function

**New file:** `apps/runtime/src/services/pipeline/model-resolver.ts`

```typescript
import type { LanguageModel } from 'ai';
import type { PipelineConfig } from './types.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('pipeline-model-resolver');

/**
 * Resolve the LanguageModel for the pipeline classifier.
 *
 * Resolution paths:
 *   'default'  — delegates to session.llmClient.resolveLanguageModel('tool_selection')
 *   'tenant'   — loads TenantModel by tenantModelId, resolves credential, creates provider
 */
export async function resolvePipelineModel(
  config: PipelineConfig,
  session: { llmClient: SessionLLMClient; tenantId?: string },
): Promise<LanguageModel | null>;
```

#### Default path

```typescript
if (config.modelSource === 'default' || !config.modelSource) {
  return session.llmClient.resolveLanguageModel('tool_selection');
}
```

#### Tenant model path

Follows the Arch Tier 1a pattern (`apps/studio/src/lib/arch-llm.ts:297-342`):

1. Load `TenantModel` by `config.tenantModelId` + `session.tenantId` (tenant-scoped query)
2. Find primary active connection (`isPrimary && isActive`, fallback to any active, fallback to first)
3. Load `LLMCredential` by `connection.credentialId` + `tenantId`
4. Use auto-decrypted `credential.encryptedApiKey` and optional `credential.encryptedEndpoint`
5. Call `createVercelProvider(provider, apiKey, baseUrl, modelId)` from `@agent-platform/llm`
6. Return the `LanguageModel`

#### Error handling

If tenant model resolution fails at any step (model not found, no active connection, credential missing), log a warning and **fall back to the default path**. Fail-open, consistent with the pipeline's overall error handling in `reasoning-executor.ts:903-908`.

```typescript
log.warn('tenant model resolution failed for pipeline, falling back to default', {
  tenantModelId: config.tenantModelId,
  reason,
});
return session.llmClient.resolveLanguageModel('tool_selection');
```

### 3. Runtime Wiring

**`apps/runtime/src/services/execution/reasoning-executor.ts`** — Single change at line ~696:

Before:

```typescript
const pipelineModel = await session.llmClient.resolveLanguageModel('tool_selection');
```

After:

```typescript
const pipelineModel = await resolvePipelineModel(pipelineConfig, session);
```

No changes needed downstream. `runPipeline()`, `classify()`, `filterTools()` all receive a `LanguageModel` already.

### 4. Config Resolution

**`apps/runtime/src/services/pipeline/config.ts`** — Add to the `resolvePipelineConfig` function:

```typescript
return {
  enabled: agent?.enabled ?? project?.enabled ?? DEFAULT_PIPELINE_CONFIG.enabled,
  mode: agent?.mode ?? project?.mode ?? DEFAULT_PIPELINE_CONFIG.mode,
  modelSource: agent?.modelSource ?? project?.modelSource ?? DEFAULT_PIPELINE_CONFIG.modelSource,
  tenantModelId: agent?.tenantModelId ?? project?.tenantModelId ?? undefined,
  // ... rest unchanged
};
```

Remove the `model` resolution line.

### 5. Studio UI Changes

**`apps/studio/src/components/settings/RuntimeConfigTab.tsx`**

Replace the free-text model input (lines ~740-750) with a `<Select>` dropdown.

#### Data fetching

Reuse the existing `GET /api/tenant-models` call (same as `ModelConfigTab.tsx`). Fetch active tenant models for the current tenant. No new API endpoint needed.

#### Dropdown options

```
Default
────────────────
{displayName} ({modelId})    ← for each active tenant model
{displayName} ({modelId})
...
```

"Default" is pre-selected when `modelSource` is `'default'` or absent.

#### On selection

- User picks "Default" → `updatePipeline('modelSource', 'default')` + clear `tenantModelId`
- User picks a tenant model → `updatePipeline('modelSource', 'tenant')` + `updatePipeline('tenantModelId', selectedId)`

#### Display when pipeline is disabled

The model dropdown is only visible when `pipeline.enabled` is `true` (same gating as the current text input).

### 6. Backward Compatibility

| Scenario                                                                             | Behavior                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Existing config has `model: 'qwen3-30b'`, no `modelSource`                           | Treated as `modelSource: 'default'` — existing behavior preserved |
| Existing config has `modelSource: 'tenant'`, `tenantModelId` points to deleted model | Resolver logs warning, falls back to default path                 |
| Agent IR has `pipeline.model` (old field)                                            | Ignored — `modelSource` takes precedence, absence means default   |

No DB migration required. The `model` field becomes dead data in existing configs.

## Files Changed

| File                                                        | Change                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/pipeline/types.ts`               | Replace `model: string` with `modelSource` + `tenantModelId`                           |
| `apps/runtime/src/services/pipeline/config.ts`              | Add `modelSource`, `tenantModelId` to resolution cascade                               |
| `apps/runtime/src/services/pipeline/model-resolver.ts`      | **New file** — `resolvePipelineModel()` function                                       |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Use `resolvePipelineModel()` at line ~696                                              |
| `apps/runtime/src/routes/project-runtime-config.ts`         | Update Zod schema: remove `model`, add `modelSource` + `tenantModelId` with refinement |
| `packages/compiler/src/platform/ir/schema.ts`               | Update IR pipeline config types at ~line 232 and ~line 630                             |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`  | Replace text input with tenant model dropdown                                          |

## Testing

- **Unit:** `resolvePipelineModel` with `modelSource: 'default'` delegates to `resolveLanguageModel`
- **Unit:** `resolvePipelineModel` with `modelSource: 'tenant'` loads TenantModel and creates provider
- **Unit:** `resolvePipelineModel` with invalid `tenantModelId` falls back to default
- **Unit:** `resolvePipelineConfig` correctly cascades `modelSource` and `tenantModelId`
- **Unit:** Zod schema rejects `modelSource: 'tenant'` without `tenantModelId`
- **Unit:** Zod schema accepts `modelSource: 'default'` without `tenantModelId`
- **Integration:** Pipeline classifier uses the correct model when `modelSource: 'tenant'` is set
- **Backward compat:** Existing configs without `modelSource` resolve as default
