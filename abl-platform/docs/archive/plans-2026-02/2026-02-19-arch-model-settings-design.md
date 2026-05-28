# Arch Model Settings Design

## Problem

Arch (the AI assistant in Studio) has no configurable model settings. It reads `ANTHROPIC_API_KEY` from `.env`, hardcodes `claude-sonnet-4-20250514`, and silently falls back to stub responses when the key is missing or LLM calls fail. Users see canned text with no indication that Arch is broken. Errors surface only on the 2nd or 3rd message, buried in generic fallback text.

The platform already has a rich model infrastructure (4 providers, encrypted credential storage, tenant model catalogs, multi-level resolution chains) but Arch bypasses all of it.

## Goals

1. Let workspace admins configure Arch's model and API key through the Admin UI
2. Surface model configuration errors immediately (banner on panel open + chat error on first message)
3. Support platform-shared credits (env-level keys shared across tenants) with tenant override
4. Curate reasoning-capable models as recommended, with escape hatch for custom models
5. Reuse existing model infrastructure (TenantModel, encrypted connections, ModelCatalogService)

## Non-Goals (this design)

- Per-project Arch model override (workspace-level only)
- Streaming responses for Arch
- Multi-model routing within a single Arch session

---

## Architecture

### Key Resolution Chain (3-tier)

```
1. Tenant's own key  →  Admin sets TenantModel + connection for Arch
2. Platform env key  →  ARCH_PLATFORM_CREDITS_ENABLED=true + env API keys
3. No key            →  Error banner + stub mode (no silent fallback)
```

When a tenant configures their own model via Admin UI, it takes priority. If no tenant key exists and platform credits are enabled, Arch uses the env-var keys. If neither is available, Arch shows a clear error instead of silently degrading.

### Data Model

**New MongoDB document: `ArchWorkspaceConfig`** (one per tenant)

```typescript
interface ArchWorkspaceConfig {
  tenantId: string; // Unique per tenant
  modelId: string; // e.g., "claude-sonnet-4-20250514"
  provider: string; // "anthropic" | "openai" | "gemini"
  tenantModelId?: string; // FK to TenantModel (tenant's own key)
  usePlatformCredits: boolean; // true = env key, false = tenant key required
  maxTokensChat: number; // default 2048
  maxTokensGenerate: number; // default 8192
  temperature: number; // default 0.7
  rateLimitRpm: number; // requests per minute, 0 = unlimited
  rateLimitRph: number; // requests per hour, 0 = unlimited
  systemPromptOverride?: string; // Prepended to Arch's system prompt
  isActive: boolean;
  updatedBy: string;
  updatedAt: Date;
}
```

### API Endpoints

| Method | Path               | Purpose                                        |
| ------ | ------------------ | ---------------------------------------------- |
| `GET`  | `/api/arch/config` | Get current Arch config for tenant             |
| `PUT`  | `/api/arch/config` | Update Arch config (admin only)                |
| `GET`  | `/api/arch/status` | Lightweight health check (is Arch configured?) |
| `GET`  | `/api/arch/models` | Curated model list with recommendations        |

**`GET /api/arch/status`** response:

```json
{
  "configured": true,
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "source": "tenant",
  "error": null
}
```

Source values: `"tenant"` (own key), `"platform"` (env key), `"none"` (not configured).

### Model Selection UI

**Curated reasoning models** (recommended, shown first):

| Provider  | Models                         | Tier               |
| --------- | ------------------------------ | ------------------ |
| Anthropic | claude-opus-4, claude-sonnet-4 | powerful, balanced |
| OpenAI    | gpt-4o, o1                     | balanced, powerful |
| Google    | gemini-2.5-pro                 | powerful           |

**Other models**: Full catalog from `ModelCatalogService` filtered to `supportsTools: true`. Shown in "Other Models" section with warning: "This model may not support Arch's tool-use workflow reliably."

**Custom model**: Text input escape hatch, shown after clicking "Use custom model". Same warning as non-recommended.

### Error Surfacing

**On Arch panel open** (immediate):

- Call `GET /api/arch/status`
- If `source === "none"`: Yellow banner at top of panel:
  > "Arch is not configured. Ask your workspace admin to set up an AI model in Admin > AI Assistant."
- If `configured === false` with error: Red banner with the specific error

**On first message failure** (in chat):

- Return structured error as an Arch message with `type: 'error'`
- Include actual reason: "API key is invalid", "Model not found", "Rate limit exceeded"
- No silent fallback to stub mode

**On rate limit hit**:

- Chat message: "You've reached the rate limit (X req/min). Wait or ask your admin for a dedicated API key."

### Admin UI: AI Assistant Settings

New page in Admin section (or tab in existing Models page):

**Model Section**:

- Provider radio buttons (Anthropic / OpenAI / Google)
- Model dropdown filtered by provider, grouped: Recommended / Other / Custom
- Warning badge for non-recommended models

**Credentials Section**:

- API key input (password field) with "Validate" button
- Status indicator: Configured / Not configured / Invalid / Using platform credits
- If `ARCH_PLATFORM_CREDITS_ENABLED=true` and no tenant key: "Using platform credits" badge

**Parameters Section** (Phase 1):

- Max tokens for chat (slider 512–8192, default 2048)
- Max tokens for generation (slider 512–16384, default 8192)
- Temperature (slider 0–1, default 0.7)

### LLM Client Changes

Replace `arch-llm.ts` singleton with a function that resolves config per-request:

```typescript
async function resolveArchLLMClient(tenantId: string): Promise<
  | {
      client: LLMClient;
      model: string;
      maxTokens: number;
      source: 'tenant' | 'platform';
    }
  | { client: null; error: string }
> {
  // 1. Load ArchWorkspaceConfig for tenant
  // 2. If tenant has own key → create client from TenantModel connection
  // 3. Else if platform credits enabled → create client from env key
  // 4. Else → return { client: null, error: 'Not configured' }
}
```

The chat route calls this per-request instead of using a cached singleton. Client instances can still be cached by `{tenantId, provider}` key with TTL eviction.

---

## Phasing

| Phase       | Scope                                                              | Priority                                      |
| ----------- | ------------------------------------------------------------------ | --------------------------------------------- |
| **Phase 1** | Model selection, API key config, error surfacing, platform credits | Critical — solves all immediate problems      |
| **Phase 2** | Rate limits (RPM/RPH per tenant)                                   | High — needed for platform credits protection |
| **Phase 3** | Usage dashboard (token counts, cost, request volume)               | Medium — visibility into spend                |
| **Phase 4** | System prompt override                                             | Low — power-user feature                      |

---

## Behavioral Changes

| Scenario                     | Before                    | After                                       |
| ---------------------------- | ------------------------- | ------------------------------------------- |
| No API key configured        | Silent stub responses     | Yellow banner on panel open + error in chat |
| LLM call fails               | Silent fallback to stub   | Error message in chat with actual reason    |
| Model choice                 | Hardcoded claude-sonnet-4 | Admin-selectable from curated list          |
| API key management           | .env only                 | Admin UI + encrypted DB storage             |
| Multi-tenant                 | Single env key for all    | Tenant key > platform key > error           |
| Non-reasoning model selected | N/A                       | Warning badge, confirmation required        |

---

## Files Affected (Phase 1 estimate)

**New files:**

- `packages/database/src/models/arch-workspace-config.model.ts` — Mongoose model
- `apps/studio/src/app/api/arch/config/route.ts` — Config CRUD endpoint
- `apps/studio/src/app/api/arch/status/route.ts` — Health check endpoint
- `apps/studio/src/app/api/arch/models/route.ts` — Curated model list
- `apps/studio/src/components/admin/ArchSettingsPage.tsx` — Admin UI
- `apps/studio/src/store/arch-config-store.ts` — Client-side config state

**Modified files:**

- `apps/studio/src/lib/arch-llm.ts` — Replace singleton with per-tenant resolution
- `apps/studio/src/app/api/arch/chat/route.ts` — Use resolved client, return structured errors
- `apps/studio/src/app/api/arch/generate/route.ts` — Same
- `apps/studio/src/components/arch/ArchPanel.tsx` — Add config status banner
- `apps/studio/src/components/navigation/AppShell.tsx` — Add admin nav entry
- `apps/studio/src/components/admin/AdminSidebar.tsx` — Add "AI Assistant" link

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let workspace admins configure Arch's LLM model and API key through an Admin UI, with immediate error surfacing when misconfigured.

**Architecture:** Replace the hardcoded singleton LLM client with a per-tenant resolution chain (tenant key > platform env key > error). Add a Mongoose `ArchWorkspaceConfig` model, three new API routes (config, status, models), an Admin UI page, and a status banner in the Arch panel. All existing model infrastructure (LLMClient, providers, encrypted storage) is reused.

**Tech Stack:** Mongoose, Next.js API routes, Zustand, React, Zod, existing `@abl/compiler` LLMClient

---

### Task 1: ArchWorkspaceConfig Mongoose Model

**Files:**

- Create: `packages/database/src/models/arch-workspace-config.model.ts`
- Modify: `packages/database/src/models/index.ts` (add export)
- Test: `packages/database/src/__tests__/arch-workspace-config.test.ts`

**Context:** Follow the same pattern as `tenant-model.model.ts`. This stores one config document per tenant with model selection, encrypted API key reference, and parameters.

**Step 1: Write the failing test**

```typescript
// packages/database/src/__tests__/arch-workspace-config.test.ts
import { describe, test, expect, beforeEach } from 'vitest';

describe('ArchWorkspaceConfig Model', () => {
  test('schema has required fields', () => {
    const { ArchWorkspaceConfig } = require('../models/arch-workspace-config.model');
    const schema = ArchWorkspaceConfig.schema;
    expect(schema.path('tenantId')).toBeDefined();
    expect(schema.path('modelId')).toBeDefined();
    expect(schema.path('provider')).toBeDefined();
    expect(schema.path('usePlatformCredits')).toBeDefined();
    expect(schema.path('maxTokensChat')).toBeDefined();
    expect(schema.path('maxTokensGenerate')).toBeDefined();
    expect(schema.path('temperature')).toBeDefined();
    expect(schema.path('rateLimitRpm')).toBeDefined();
    expect(schema.path('isActive')).toBeDefined();
  });

  test('tenantId + isActive has unique index', () => {
    const { ArchWorkspaceConfig } = require('../models/arch-workspace-config.model');
    const indexes = ArchWorkspaceConfig.schema.indexes();
    const hasTenantIndex = indexes.some(
      ([fields]: [Record<string, number>]) => fields.tenantId === 1,
    );
    expect(hasTenantIndex).toBe(true);
  });

  test('defaults are set correctly', () => {
    const { ArchWorkspaceConfig } = require('../models/arch-workspace-config.model');
    const doc = new ArchWorkspaceConfig({ tenantId: 'test-tenant' });
    expect(doc.modelId).toBe('claude-sonnet-4-20250514');
    expect(doc.provider).toBe('anthropic');
    expect(doc.usePlatformCredits).toBe(true);
    expect(doc.maxTokensChat).toBe(2048);
    expect(doc.maxTokensGenerate).toBe(8192);
    expect(doc.temperature).toBe(0.7);
    expect(doc.rateLimitRpm).toBe(0);
    expect(doc.rateLimitRph).toBe(0);
    expect(doc.isActive).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm test -- --run src/__tests__/arch-workspace-config.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// packages/database/src/models/arch-workspace-config.model.ts
/**
 * ArchWorkspaceConfig
 *
 * Stores per-tenant configuration for the Arch AI assistant:
 * model selection, credential reference, and LLM parameters.
 * One document per tenant.
 */

import { Schema, model, type Document } from 'mongoose';
import { tenantIsolationPlugin } from '../plugins/tenant-isolation.plugin';

export interface IArchWorkspaceConfig extends Document {
  tenantId: string;
  modelId: string;
  provider: string;
  tenantModelId?: string;
  usePlatformCredits: boolean;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  rateLimitRpm: number;
  rateLimitRph: number;
  systemPromptOverride?: string;
  encryptedApiKey?: string;
  isActive: boolean;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ArchWorkspaceConfigSchema = new Schema<IArchWorkspaceConfig>(
  {
    tenantId: { type: String, required: true },
    modelId: { type: String, required: true, default: 'claude-sonnet-4-20250514' },
    provider: {
      type: String,
      required: true,
      default: 'anthropic',
      enum: ['anthropic', 'openai', 'gemini'],
    },
    tenantModelId: { type: String, default: null },
    usePlatformCredits: { type: Boolean, required: true, default: true },
    maxTokensChat: { type: Number, required: true, default: 2048 },
    maxTokensGenerate: { type: Number, required: true, default: 8192 },
    temperature: { type: Number, required: true, default: 0.7 },
    rateLimitRpm: { type: Number, required: true, default: 0 },
    rateLimitRph: { type: Number, required: true, default: 0 },
    systemPromptOverride: { type: String, default: null },
    encryptedApiKey: { type: String, default: null },
    isActive: { type: Boolean, required: true, default: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'arch_workspace_configs' },
);

ArchWorkspaceConfigSchema.plugin(tenantIsolationPlugin);

ArchWorkspaceConfigSchema.index({ tenantId: 1 }, { unique: true });

export const ArchWorkspaceConfig = model<IArchWorkspaceConfig>(
  'ArchWorkspaceConfig',
  ArchWorkspaceConfigSchema,
);
```

**Step 4: Add export to index**

Add `export { ArchWorkspaceConfig } from './arch-workspace-config.model';` to `packages/database/src/models/index.ts`.

**Step 5: Run test to verify it passes**

Run: `cd packages/database && pnpm build && pnpm test -- --run src/__tests__/arch-workspace-config.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/database/src/models/arch-workspace-config.model.ts packages/database/src/models/index.ts packages/database/src/__tests__/arch-workspace-config.test.ts
git commit -m "[ABLP-2] feat(database): add ArchWorkspaceConfig model"
```

---

### Task 2: Arch Config API Routes

**Files:**

- Create: `apps/studio/src/app/api/arch/config/route.ts`
- Create: `apps/studio/src/app/api/arch/status/route.ts`
- Create: `apps/studio/src/app/api/arch/models/route.ts`
- Test: `apps/studio/src/__tests__/arch-config-api.test.ts`

**Context:** Three new endpoints. Follow the pattern from `apps/studio/src/app/api/tenant-models/route.ts` — auth check first, Zod validation, structured error responses. The config and status routes read/write the `ArchWorkspaceConfig` model directly (no runtime proxy needed since this is Studio-only data).

**Step 1: Write the failing tests**

```typescript
// apps/studio/src/__tests__/arch-config-api.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockUser = { id: 'user-1', tenantId: 'tenant-1', role: 'admin' };
vi.mock('../lib/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue(mockUser),
  isAuthError: vi.fn().mockReturnValue(false),
}));

// Mock database
const mockConfig = {
  tenantId: 'tenant-1',
  modelId: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  usePlatformCredits: true,
  maxTokensChat: 2048,
  maxTokensGenerate: 8192,
  temperature: 0.7,
  rateLimitRpm: 0,
  rateLimitRph: 0,
  isActive: true,
  save: vi.fn(),
  toObject: vi.fn().mockReturnThis(),
};

vi.mock('@agent-platform/database', () => ({
  ArchWorkspaceConfig: {
    findOne: vi.fn().mockResolvedValue(mockConfig),
    findOneAndUpdate: vi.fn().mockResolvedValue(mockConfig),
    create: vi.fn().mockResolvedValue(mockConfig),
  },
}));

describe('GET /api/arch/status', () => {
  test('returns configured status when config exists', async () => {
    const { GET } = await import('../app/api/arch/status/route');
    const request = new Request('http://localhost/api/arch/status');
    const response = await GET(request as any);
    const data = await response.json();

    expect(data.configured).toBe(true);
    expect(data.model).toBe('claude-sonnet-4-20250514');
    expect(data.provider).toBe('anthropic');
  });
});

describe('GET /api/arch/config', () => {
  test('returns current config for tenant', async () => {
    const { GET } = await import('../app/api/arch/config/route');
    const request = new Request('http://localhost/api/arch/config');
    const response = await GET(request as any);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.data.modelId).toBe('claude-sonnet-4-20250514');
  });
});

describe('GET /api/arch/models', () => {
  test('returns curated model list with recommendations', async () => {
    const { GET } = await import('../app/api/arch/models/route');
    const request = new Request('http://localhost/api/arch/models');
    const response = await GET(request as any);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(Array.isArray(data.data.recommended)).toBe(true);
    expect(data.data.recommended.length).toBeGreaterThan(0);
    // Should include claude-sonnet-4
    const hasSonnet = data.data.recommended.some((m: any) => m.modelId.includes('claude-sonnet'));
    expect(hasSonnet).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-config-api.test.ts`
Expected: FAIL — modules not found

**Step 3: Implement `/api/arch/status/route.ts`**

```typescript
// apps/studio/src/app/api/arch/status/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { ArchWorkspaceConfig } from '@agent-platform/database';

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const config = await ArchWorkspaceConfig.findOne({
      tenantId: user.tenantId,
      isActive: true,
    }).lean();

    if (!config) {
      // Check if platform credits are available
      const hasPlatformKey = Boolean(process.env.ANTHROPIC_API_KEY);
      if (hasPlatformKey) {
        return NextResponse.json({
          configured: true,
          model: process.env.ARCH_CHAT_MODEL ?? 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          source: 'platform',
          error: null,
        });
      }

      return NextResponse.json({
        configured: false,
        model: null,
        provider: null,
        source: 'none',
        error: 'No Arch configuration found. Ask your workspace admin to set up an AI model.',
      });
    }

    // Determine source: tenant key vs platform credits
    const source = config.usePlatformCredits ? 'platform' : 'tenant';

    // If tenant key, verify it exists
    if (!config.usePlatformCredits && !config.encryptedApiKey && !config.tenantModelId) {
      return NextResponse.json({
        configured: false,
        model: config.modelId,
        provider: config.provider,
        source: 'none',
        error: 'API key not configured for the selected model.',
      });
    }

    return NextResponse.json({
      configured: true,
      model: config.modelId,
      provider: config.provider,
      source,
      error: null,
    });
  } catch (error) {
    console.error('[Arch Status] Error:', error);
    return NextResponse.json({
      configured: false,
      model: null,
      provider: null,
      source: 'none',
      error: 'Failed to check Arch configuration.',
    });
  }
}
```

**Step 4: Implement `/api/arch/config/route.ts`**

```typescript
// apps/studio/src/app/api/arch/config/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { ArchWorkspaceConfig } from '@agent-platform/database';

const updateConfigSchema = z.object({
  modelId: z.string().max(200).optional(),
  provider: z.enum(['anthropic', 'openai', 'gemini']).optional(),
  usePlatformCredits: z.boolean().optional(),
  maxTokensChat: z.number().min(512).max(8192).optional(),
  maxTokensGenerate: z.number().min(512).max(16384).optional(),
  temperature: z.number().min(0).max(1).optional(),
  rateLimitRpm: z.number().min(0).optional(),
  rateLimitRph: z.number().min(0).optional(),
  apiKey: z.string().max(500).optional(),
});

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const config = await ArchWorkspaceConfig.findOne({
      tenantId: user.tenantId,
      isActive: true,
    }).lean();

    return NextResponse.json({
      success: true,
      data: config ?? null,
    });
  } catch (error) {
    console.error('[Arch Config] GET error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch config' } },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const body = await request.json();
    const parsed = updateConfigSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
        { status: 400 },
      );
    }

    const { apiKey, ...configFields } = parsed.data;

    // Build update object
    const update: Record<string, unknown> = {
      ...configFields,
      updatedBy: user.id,
    };

    // If apiKey provided, encrypt and store it
    // TODO: Use EncryptionService for proper tenant-scoped DEK encryption
    if (apiKey !== undefined) {
      update.encryptedApiKey = apiKey; // Placeholder — encrypt in Phase 2
    }

    const config = await ArchWorkspaceConfig.findOneAndUpdate(
      { tenantId: user.tenantId },
      { $set: update, $setOnInsert: { tenantId: user.tenantId } },
      { upsert: true, new: true, lean: true },
    );

    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    console.error('[Arch Config] PUT error:', error);
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update config' } },
      { status: 500 },
    );
  }
}
```

**Step 5: Implement `/api/arch/models/route.ts`**

```typescript
// apps/studio/src/app/api/arch/models/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';

interface ModelOption {
  modelId: string;
  displayName: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  tier: 'fast' | 'balanced' | 'powerful';
  supportsTools: boolean;
  recommended: boolean;
  contextWindow: number;
}

const RECOMMENDED_MODELS: ModelOption[] = [
  {
    modelId: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    provider: 'anthropic',
    tier: 'balanced',
    supportsTools: true,
    recommended: true,
    contextWindow: 200000,
  },
  {
    modelId: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    provider: 'anthropic',
    tier: 'powerful',
    supportsTools: true,
    recommended: true,
    contextWindow: 200000,
  },
  {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    tier: 'balanced',
    supportsTools: true,
    recommended: true,
    contextWindow: 128000,
  },
  {
    modelId: 'o1',
    displayName: 'OpenAI o1',
    provider: 'openai',
    tier: 'powerful',
    supportsTools: true,
    recommended: true,
    contextWindow: 200000,
  },
  {
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'gemini',
    tier: 'powerful',
    supportsTools: true,
    recommended: true,
    contextWindow: 1000000,
  },
];

const OTHER_MODELS: ModelOption[] = [
  {
    modelId: 'claude-haiku-4-5-20251022',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'fast',
    supportsTools: true,
    recommended: false,
    contextWindow: 200000,
  },
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    tier: 'fast',
    supportsTools: true,
    recommended: false,
    contextWindow: 128000,
  },
  {
    modelId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'gemini',
    tier: 'fast',
    supportsTools: true,
    recommended: false,
    contextWindow: 1000000,
  },
];

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  return NextResponse.json({
    success: true,
    data: {
      recommended: RECOMMENDED_MODELS,
      other: OTHER_MODELS,
    },
  });
}
```

**Step 6: Run tests to verify they pass**

Run: `cd apps/studio && pnpm build && pnpm test -- --run src/__tests__/arch-config-api.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add apps/studio/src/app/api/arch/config/route.ts apps/studio/src/app/api/arch/status/route.ts apps/studio/src/app/api/arch/models/route.ts apps/studio/src/__tests__/arch-config-api.test.ts
git commit -m "[ABLP-2] feat(studio): add Arch config, status, and models API routes"
```

---

### Task 3: Replace Arch LLM Singleton with Per-Tenant Resolution

**Files:**

- Modify: `apps/studio/src/lib/arch-llm.ts`
- Test: `apps/studio/src/__tests__/arch-llm.test.ts`

**Context:** Replace the singleton `getArchLLMClient()` with `resolveArchLLMClient(tenantId)` that checks tenant config first, falls back to platform env key, and returns structured errors instead of null.

**Step 1: Write the failing test**

```typescript
// apps/studio/src/__tests__/arch-llm.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfig = {
  modelId: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  usePlatformCredits: false,
  encryptedApiKey: 'sk-ant-test-key',
  maxTokensChat: 2048,
  maxTokensGenerate: 8192,
  temperature: 0.7,
};

vi.mock('@agent-platform/database', () => ({
  ArchWorkspaceConfig: {
    findOne: vi.fn(),
  },
}));

// Mock LLMClient
vi.mock('@abl/compiler/platform/llm/provider.js', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    chat: vi.fn().mockResolvedValue('response'),
    chatWithTools: vi
      .fn()
      .mockResolvedValue({ text: 'response', toolCalls: [], stopReason: 'end_turn' }),
  })),
}));

describe('resolveArchLLMClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns tenant client when config has own key', async () => {
    const { ArchWorkspaceConfig } = await import('@agent-platform/database');
    (ArchWorkspaceConfig.findOne as any).mockReturnValue({
      lean: () => Promise.resolve(mockConfig),
    });

    const { resolveArchLLMClient } = await import('../lib/arch-llm');
    const result = await resolveArchLLMClient('tenant-1');

    expect(result.client).not.toBeNull();
    expect(result.source).toBe('tenant');
  });

  test('returns platform client when usePlatformCredits is true', async () => {
    const { ArchWorkspaceConfig } = await import('@agent-platform/database');
    (ArchWorkspaceConfig.findOne as any).mockReturnValue({
      lean: () =>
        Promise.resolve({ ...mockConfig, usePlatformCredits: true, encryptedApiKey: null }),
    });
    process.env.ANTHROPIC_API_KEY = 'sk-platform-key';

    const { resolveArchLLMClient } = await import('../lib/arch-llm');
    const result = await resolveArchLLMClient('tenant-1');

    expect(result.client).not.toBeNull();
    expect(result.source).toBe('platform');
  });

  test('returns error when no config and no platform key', async () => {
    const { ArchWorkspaceConfig } = await import('@agent-platform/database');
    (ArchWorkspaceConfig.findOne as any).mockReturnValue({ lean: () => Promise.resolve(null) });
    delete process.env.ANTHROPIC_API_KEY;

    const { resolveArchLLMClient } = await import('../lib/arch-llm');
    const result = await resolveArchLLMClient('tenant-1');

    expect(result.client).toBeNull();
    expect(result.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-llm.test.ts`
Expected: FAIL — `resolveArchLLMClient` not exported

**Step 3: Rewrite `arch-llm.ts`**

Replace the entire file. Keep old exports for backward compat during migration, but add the new resolver:

```typescript
// apps/studio/src/lib/arch-llm.ts
/**
 * Arch LLM Client Resolution
 *
 * Resolves the LLM client for Arch per-tenant with a 3-tier chain:
 * 1. Tenant's own API key (from ArchWorkspaceConfig)
 * 2. Platform env key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 * 3. Error (no silent fallback)
 */

import { LLMClient } from '@abl/compiler/platform/llm/provider.js';
import { ArchWorkspaceConfig } from '@agent-platform/database';

// Default constants (used when no config exists)
export const ARCH_CHAT_MODEL = process.env.ARCH_CHAT_MODEL ?? 'claude-sonnet-4-20250514';
export const ARCH_GENERATE_MODEL = process.env.ARCH_GENERATE_MODEL ?? 'claude-sonnet-4-20250514';
export const ARCH_CHAT_MAX_TOKENS = 2048;
export const ARCH_GENERATE_MAX_TOKENS = 8192;
export const ARCH_TIMEOUT_MS = 60_000;

/** Provider → env var mapping */
const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export interface ArchLLMResolution {
  client: LLMClient | null;
  model: string;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  source: 'tenant' | 'platform' | 'none';
  error?: string;
}

/**
 * Resolve the LLM client for Arch based on tenant configuration.
 *
 * Resolution order:
 * 1. Tenant's own key from ArchWorkspaceConfig.encryptedApiKey
 * 2. Platform env key for the configured provider
 * 3. Return { client: null } with error message
 */
export async function resolveArchLLMClient(tenantId: string): Promise<ArchLLMResolution> {
  try {
    const config = await ArchWorkspaceConfig.findOne({
      tenantId,
      isActive: true,
    }).lean();

    const model = config?.modelId ?? ARCH_CHAT_MODEL;
    const provider = config?.provider ?? 'anthropic';
    const maxTokensChat = config?.maxTokensChat ?? ARCH_CHAT_MAX_TOKENS;
    const maxTokensGenerate = config?.maxTokensGenerate ?? ARCH_GENERATE_MAX_TOKENS;
    const temperature = config?.temperature ?? 0.7;

    // Tier 1: Tenant's own key
    if (config && !config.usePlatformCredits && config.encryptedApiKey) {
      try {
        const client = new LLMClient({
          provider: provider as 'anthropic' | 'openai' | 'gemini',
          apiKey: config.encryptedApiKey, // TODO: decrypt with EncryptionService
          defaultMaxTokens: maxTokensChat,
          defaultTimeoutMs: ARCH_TIMEOUT_MS,
        });
        return { client, model, maxTokensChat, maxTokensGenerate, temperature, source: 'tenant' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to create LLM client';
        console.error('[Arch LLM] Tenant client creation failed:', msg);
        return {
          client: null,
          model,
          maxTokensChat,
          maxTokensGenerate,
          temperature,
          source: 'none',
          error: msg,
        };
      }
    }

    // Tier 2: Platform env key
    const envVar = PROVIDER_KEY_MAP[provider] ?? 'ANTHROPIC_API_KEY';
    const platformKey = process.env[envVar];
    if (platformKey) {
      try {
        const client = new LLMClient({
          provider: provider as 'anthropic' | 'openai' | 'gemini',
          apiKey: platformKey,
          defaultMaxTokens: maxTokensChat,
          defaultTimeoutMs: ARCH_TIMEOUT_MS,
        });
        return { client, model, maxTokensChat, maxTokensGenerate, temperature, source: 'platform' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to create LLM client';
        console.error('[Arch LLM] Platform client creation failed:', msg);
        return {
          client: null,
          model,
          maxTokensChat,
          maxTokensGenerate,
          temperature,
          source: 'none',
          error: msg,
        };
      }
    }

    // Tier 3: No key available
    return {
      client: null,
      model,
      maxTokensChat,
      maxTokensGenerate,
      temperature,
      source: 'none',
      error: `No API key configured. Set ${envVar} or configure a key in Admin > AI Assistant.`,
    };
  } catch (err) {
    console.error('[Arch LLM] Resolution failed:', err);
    return {
      client: null,
      model: ARCH_CHAT_MODEL,
      maxTokensChat: ARCH_CHAT_MAX_TOKENS,
      maxTokensGenerate: ARCH_GENERATE_MAX_TOKENS,
      temperature: 0.7,
      source: 'none',
      error: 'Failed to load Arch configuration.',
    };
  }
}

// Legacy exports for backward compat during migration
let _cachedClient: LLMClient | null = null;
let _clientChecked = false;

/** @deprecated Use resolveArchLLMClient() instead */
export function getArchLLMClient(): LLMClient | null {
  if (_clientChecked) return _cachedClient;
  _clientChecked = true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Arch LLM] ANTHROPIC_API_KEY not set — Arch will use stub responses');
    return null;
  }
  try {
    _cachedClient = new LLMClient({
      provider: 'anthropic',
      apiKey,
      defaultMaxTokens: ARCH_CHAT_MAX_TOKENS,
      defaultTimeoutMs: ARCH_TIMEOUT_MS,
    });
    return _cachedClient;
  } catch (err) {
    console.error('[Arch LLM] Failed to create LLM client:', err);
    return null;
  }
}

/** @deprecated Use resolveArchLLMClient() instead */
export function isArchLLMConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-llm.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/lib/arch-llm.ts apps/studio/src/__tests__/arch-llm.test.ts
git commit -m "[ABLP-2] feat(studio): add per-tenant Arch LLM resolution"
```

---

### Task 4: Wire Chat & Generate Routes to Per-Tenant Resolution

**Files:**

- Modify: `apps/studio/src/app/api/arch/chat/route.ts`
- Modify: `apps/studio/src/app/api/arch/generate/route.ts`
- Modify: `apps/studio/src/lib/auth.ts` (may need to read tenantId from auth)

**Context:** Replace `getArchLLMClient()` calls with `resolveArchLLMClient(tenantId)`. Extract tenantId from the authenticated user. Return structured error responses instead of silent stub fallback.

**Step 1: Update `chat/route.ts`**

In `apps/studio/src/app/api/arch/chat/route.ts`, find the `POST` function (line 234). Make these changes:

1. Add auth import: `import { requireAuth, isAuthError } from '@/lib/auth';`
2. Replace `import { getArchLLMClient, ... }` with `import { resolveArchLLMClient, ... }`
3. At the top of the POST handler, after validation:

```typescript
const user = await requireAuth(request);
if (isAuthError(user)) return user;
const tenantId = user.tenantId;
```

4. Replace `const llm = getArchLLMClient();` with:

```typescript
const resolution = await resolveArchLLMClient(tenantId);
const llm = resolution.client;
```

5. Replace `if (llm)` block's model references: use `resolution.model` instead of `ARCH_CHAT_MODEL`
6. After the `if (llm)` block, replace the stub fallback with an error response when `resolution.source === 'none'`:

```typescript
if (resolution.source === 'none') {
  return NextResponse.json({
    success: true,
    data: {
      message:
        resolution.error ??
        'Arch is not configured. Ask your workspace admin to set up an AI model in Admin > AI Assistant.',
      type: 'error',
      suggestions: [],
    },
  });
}
```

**Step 2: Update `generate/route.ts`**

Same pattern — add auth, replace singleton with resolver, return structured errors.

**Step 3: Run existing tests to verify nothing broke**

Run: `cd apps/studio && pnpm build && pnpm test -- --run`
Expected: All 1900+ tests PASS (existing tests use mocked arch API, so no breakage)

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/arch/chat/route.ts apps/studio/src/app/api/arch/generate/route.ts
git commit -m "[ABLP-2] feat(studio): wire chat and generate routes to per-tenant LLM resolution"
```

---

### Task 5: Arch Config Zustand Store

**Files:**

- Create: `apps/studio/src/store/arch-config-store.ts`
- Test: `apps/studio/src/__tests__/arch-config-store.test.ts`

**Context:** Client-side store for Arch configuration status. Fetches from `/api/arch/status` on mount and `/api/arch/config` when admin opens settings. No persist middleware (always fetch fresh from server).

**Step 1: Write the failing test**

```typescript
// apps/studio/src/__tests__/arch-config-store.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fetch
global.fetch = vi.fn();

describe('Arch Config Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const { useArchConfigStore } = require('../store/arch-config-store');
    useArchConfigStore.setState({
      status: null,
      config: null,
      models: null,
      isLoading: false,
      error: null,
    });
  });

  test('fetchStatus updates store with server response', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          configured: true,
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
          source: 'platform',
          error: null,
        }),
    });

    const { useArchConfigStore } = require('../store/arch-config-store');
    await useArchConfigStore.getState().fetchStatus();

    const state = useArchConfigStore.getState();
    expect(state.status?.configured).toBe(true);
    expect(state.status?.source).toBe('platform');
  });

  test('fetchStatus sets error when fetch fails', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const { useArchConfigStore } = require('../store/arch-config-store');
    await useArchConfigStore.getState().fetchStatus();

    const state = useArchConfigStore.getState();
    expect(state.error).toBe('Network error');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-config-store.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the store**

```typescript
// apps/studio/src/store/arch-config-store.ts
import { create } from 'zustand';

export interface ArchStatus {
  configured: boolean;
  model: string | null;
  provider: string | null;
  source: 'tenant' | 'platform' | 'none';
  error: string | null;
}

export interface ArchConfigData {
  modelId: string;
  provider: string;
  usePlatformCredits: boolean;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  rateLimitRpm: number;
  rateLimitRph: number;
  hasApiKey: boolean;
}

export interface ModelOption {
  modelId: string;
  displayName: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  tier: 'fast' | 'balanced' | 'powerful';
  supportsTools: boolean;
  recommended: boolean;
  contextWindow: number;
}

interface ArchConfigState {
  status: ArchStatus | null;
  config: ArchConfigData | null;
  models: { recommended: ModelOption[]; other: ModelOption[] } | null;
  isLoading: boolean;
  error: string | null;

  fetchStatus: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  fetchModels: () => Promise<void>;
  updateConfig: (updates: Partial<ArchConfigData> & { apiKey?: string }) => Promise<boolean>;
}

export const useArchConfigStore = create<ArchConfigState>((set) => ({
  status: null,
  config: null,
  models: null,
  isLoading: false,
  error: null,

  fetchStatus: async () => {
    try {
      const res = await fetch('/api/arch/status');
      if (!res.ok) throw new Error('Failed to fetch Arch status');
      const data = await res.json();
      set({ status: data, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch status';
      set({ error: message });
    }
  },

  fetchConfig: async () => {
    set({ isLoading: true });
    try {
      const res = await fetch('/api/arch/config');
      if (!res.ok) throw new Error('Failed to fetch Arch config');
      const { data } = await res.json();
      set({
        config: data
          ? {
              modelId: data.modelId,
              provider: data.provider,
              usePlatformCredits: data.usePlatformCredits,
              maxTokensChat: data.maxTokensChat,
              maxTokensGenerate: data.maxTokensGenerate,
              temperature: data.temperature,
              rateLimitRpm: data.rateLimitRpm,
              rateLimitRph: data.rateLimitRph,
              hasApiKey: Boolean(data.encryptedApiKey),
            }
          : null,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch config';
      set({ isLoading: false, error: message });
    }
  },

  fetchModels: async () => {
    try {
      const res = await fetch('/api/arch/models');
      if (!res.ok) throw new Error('Failed to fetch models');
      const { data } = await res.json();
      set({ models: data, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch models';
      set({ error: message });
    }
  },

  updateConfig: async (updates) => {
    set({ isLoading: true });
    try {
      const res = await fetch('/api/arch/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Failed to update config');
      set({ isLoading: false, error: null });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update config';
      set({ isLoading: false, error: message });
      return false;
    }
  },
}));
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-config-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/store/arch-config-store.ts apps/studio/src/__tests__/arch-config-store.test.ts
git commit -m "[ABLP-2] feat(studio): add Arch config Zustand store"
```

---

### Task 6: Arch Status Banner in ArchPanel

**Files:**

- Modify: `apps/studio/src/components/arch/ArchPanel.tsx` (lines 208-241, insert banner after header)
- Test: Update `apps/studio/src/__tests__/arch-components.test.tsx` (add banner tests)

**Context:** When the Arch panel opens, fetch status from the store. If not configured, show a yellow/red banner between the header and the chat area.

**Step 1: Add banner tests to arch-components.test.tsx**

Add a new describe block after the existing ArchPanel tests:

```typescript
describe('ArchPanel Status Banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArchStore.isOpen = true;
    mockArchStore.isMinimized = false;
  });

  test('shows warning banner when Arch is not configured', () => {
    // Mock the arch-config-store to return unconfigured status
    mockArchConfigStore.status = {
      configured: false,
      model: null,
      provider: null,
      source: 'none',
      error: 'No API key configured.',
    };

    render(<ArchPanel />);
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  });

  test('does not show banner when Arch is configured', () => {
    mockArchConfigStore.status = {
      configured: true,
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      source: 'platform',
      error: null,
    };

    render(<ArchPanel />);
    expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument();
  });
});
```

You'll also need to add a mock for `arch-config-store` alongside the existing `arch-store` mock.

**Step 2: Implement the banner in ArchPanel.tsx**

After the header `</div>` (around line 232), before the context indicator, insert:

```tsx
{
  /* Configuration status banner */
}
{
  status && !status.configured && (
    <div
      className={clsx(
        'px-4 py-2 border-b text-xs flex items-center gap-2',
        status.source === 'none'
          ? 'bg-warning/10 border-warning/20 text-warning'
          : 'bg-error/10 border-error/20 text-error',
      )}
    >
      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
      <span>{status.error ?? 'Arch is not configured. Ask your admin to set up an AI model.'}</span>
    </div>
  );
}
```

Also add `useEffect` to fetch status on panel open:

```tsx
const { status, fetchStatus } = useArchConfigStore();

useEffect(() => {
  if (isOpen && !isMinimized) {
    fetchStatus();
  }
}, [isOpen, isMinimized, fetchStatus]);
```

**Step 3: Run tests**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-components.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/studio/src/components/arch/ArchPanel.tsx apps/studio/src/__tests__/arch-components.test.tsx
git commit -m "[ABLP-2] feat(studio): add config status banner to ArchPanel"
```

---

### Task 7: Admin AI Assistant Settings Page

**Files:**

- Create: `apps/studio/src/components/admin/ArchSettingsPage.tsx`
- Modify: `apps/studio/src/components/admin/AdminSidebar.tsx` (add nav item)
- Modify: `apps/studio/src/components/navigation/AppShell.tsx` (add route)
- Test: `apps/studio/src/__tests__/arch-settings-page.test.tsx`

**Context:** Admin page at `/admin/arch` with model selection, API key configuration, and parameter sliders. Follows the same pattern as `ModelsPage.tsx` — `PageHeader` + form sections. Uses `useArchConfigStore` for data.

**Step 1: Write the test**

```typescript
// apps/studio/src/__tests__/arch-settings-page.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ... mock stores and icons (follow ModelsPage test patterns) ...

describe('ArchSettingsPage', () => {
  test('renders model selection dropdown', () => {
    render(<ArchSettingsPage />);
    expect(screen.getByText(/Model/i)).toBeInTheDocument();
  });

  test('renders API key section', () => {
    render(<ArchSettingsPage />);
    expect(screen.getByText(/API Key/i)).toBeInTheDocument();
  });

  test('shows platform credits badge when enabled', () => {
    // Mock config with usePlatformCredits: true
    render(<ArchSettingsPage />);
    expect(screen.getByText(/platform credits/i)).toBeInTheDocument();
  });

  test('shows warning for non-recommended models', async () => {
    render(<ArchSettingsPage />);
    // Select a non-recommended model and verify warning appears
  });
});
```

**Step 2: Implement `ArchSettingsPage.tsx`**

Build the admin page with:

- Provider radio group (Anthropic / OpenAI / Google)
- Model dropdown grouped by Recommended / Other, with search
- API key password input + Validate button + status badge
- Platform credits toggle (shown when `ARCH_PLATFORM_CREDITS_ENABLED` is set)
- Max tokens sliders (chat + generate)
- Temperature slider
- Save button

Follow the existing `ModelsPage.tsx` pattern for layout, state management, and API calls.

**Step 3: Add nav entry in AdminSidebar.tsx**

Add below the existing "Models" entry:

```tsx
{ label: 'AI Assistant', icon: Sparkles, page: 'arch' }
```

**Step 4: Add route in AppShell.tsx**

In the `renderContent()` function's admin switch block, add:

```tsx
case 'arch':
  return <ArchSettingsPage />;
```

**Step 5: Run tests**

Run: `cd apps/studio && pnpm build && pnpm test -- --run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add apps/studio/src/components/admin/ArchSettingsPage.tsx apps/studio/src/components/admin/AdminSidebar.tsx apps/studio/src/components/navigation/AppShell.tsx apps/studio/src/__tests__/arch-settings-page.test.tsx
git commit -m "[ABLP-2] feat(studio): add Admin AI Assistant settings page"
```

---

### Task 8: Structured Error Messages in Chat

**Files:**

- Modify: `apps/studio/src/components/arch/ArchChat.tsx` (render error-type messages differently)
- Modify: `apps/studio/src/types/arch.ts` (add `type` field to ArchMessage)
- Test: Update `apps/studio/src/__tests__/arch-components.test.tsx`

**Context:** When the chat API returns `type: 'error'`, render the message with error styling (red border, alert icon) instead of the normal Arch message bubble. This ensures LLM failures are visually distinct.

**Step 1: Add `type` field to ArchMessage**

In `apps/studio/src/types/arch.ts`, find the `ArchMessage` interface and add:

```typescript
type?: 'message' | 'error';
```

**Step 2: Update ArchChat to handle error messages**

In the message rendering loop, check `message.type === 'error'` and render with error styling:

```tsx
{
  message.type === 'error' ? (
    <div className="mx-4 my-2 px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-sm text-error flex items-start gap-2">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{message.content}</span>
    </div>
  ) : (
    <ArchMessage message={message} />
  );
}
```

**Step 3: Update the chat API handler** (in `SpecGenerationView.tsx` and `ArchPanel.tsx`)

When the API response includes `type: 'error'`, set it on the message:

```typescript
const archMsg: ArchMessage = {
  id: `arch-${Date.now()}`,
  role: 'arch',
  content: response.message,
  type: response.type,
  timestamp: new Date().toISOString(),
  agentName: 'Arch',
};
```

**Step 4: Add tests**

```typescript
test('renders error messages with error styling', () => {
  const messages = [
    makeArchMessage({ id: 'err-1', role: 'arch', content: 'API key invalid', type: 'error' }),
  ];
  render(<ArchChat messages={messages} onSendMessage={mockOnSend} />);
  expect(screen.getByText('API key invalid')).toBeInTheDocument();
});
```

**Step 5: Run tests**

Run: `cd apps/studio && pnpm test -- --run src/__tests__/arch-components.test.tsx`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/studio/src/types/arch.ts apps/studio/src/components/arch/ArchChat.tsx apps/studio/src/__tests__/arch-components.test.tsx
git commit -m "[ABLP-2] feat(studio): render structured error messages in Arch chat"
```

---

## Verification

After all tasks:

1. `cd packages/database && pnpm build && pnpm test` — all pass
2. `cd apps/studio && pnpm build && pnpm test` — all 1900+ tests pass
3. Manual test: Open Arch panel with no API key → yellow banner visible immediately
4. Manual test: Send message with no API key → error message in chat (not stub text)
5. Manual test: Go to Admin > AI Assistant → model selector, key input, params visible
6. Manual test: Configure a model + key → Arch panel banner disappears, chat works
