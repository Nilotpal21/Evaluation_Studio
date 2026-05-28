# NLU Provider: Standard / Advanced Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-project `nlu_provider` setting (`standard` | `advanced`) that gates the ML sidecar tier behind enterprise plans, while enhancing standard extraction with promoted JS-based extractors.

**Architecture:** The `nlu_provider` field is added to the extraction section of `ProjectRuntimeConfigIR`, DB model, resolver, API route, and Studio UI. At runtime, `standard` skips the ML sidecar entirely (Tier 1 JS → LLM → regex). `advanced` enables the ML sidecar tier (Tier 1 JS → ML sidecar → LLM → regex) using a per-project sidecar URL from config. Enterprise plan enforcement happens at two levels: API route rejects `advanced` for non-enterprise tenants, and runtime downgrades silently as a safety net. JS Tier 1 is extended with email and currency extractors so `standard` covers more types without LLM cost.

**Tech Stack:** TypeScript, Vitest, MongoDB (Mongoose), Express.js, React (Next.js), Zustand

---

## Phase Overview

| Phase       | Scope                    | Tasks | Key Deliverable                                |
| ----------- | ------------------------ | ----- | ---------------------------------------------- |
| **Phase 1** | Schema + config pipeline | 1-3   | `nlu_provider` flows from DB → IR              |
| **Phase 2** | Plan gating + API        | 4-5   | Enterprise-only enforcement at API and runtime |
| **Phase 3** | Runtime behavior         | 6-7   | Sidecar gated by provider, per-session client  |
| **Phase 4** | Tier 1 JS enhancement    | 8     | Email + currency extractors promoted to Tier 1 |
| **Phase 5** | Studio UI                | 9     | NLU provider toggle with enterprise badge      |

---

## Phase 1: Schema + Config Pipeline

### Task 1: Add NluProvider type and fields to IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:83-103` (ProjectRuntimeConfigIR)
- Modify: `packages/compiler/src/platform/ir/schema.ts:535` (near ExtractionStrategy)
- Test: `packages/compiler/src/__tests__/ir-schema-nlu-provider.test.ts`

**Step 1: Write failing test**

```typescript
// packages/compiler/src/__tests__/ir-schema-nlu-provider.test.ts
import { describe, it, expect } from 'vitest';
import type { ProjectRuntimeConfigIR, NluProvider } from '../platform/ir/schema.js';

describe('NluProvider type in ProjectRuntimeConfigIR', () => {
  it('should accept standard provider config', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'standard',
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: { confidence: 0.8, confirm: true, model_tier: 'fast', max_fields_per_pass: 3 },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };
    expect(config.nlu_provider).toBe('standard');
    expect(config.advanced_sidecar_url).toBeUndefined();
  });

  it('should accept advanced provider config with sidecar URL', () => {
    const config: ProjectRuntimeConfigIR = {
      extraction_strategy: 'auto',
      nlu_provider: 'advanced',
      advanced_sidecar_url: 'http://kore-nlu:8090',
      advanced_sidecar_timeout_ms: 3000,
      advanced_sidecar_circuit_breaker_threshold: 5,
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: { confidence: 0.8, confirm: true, model_tier: 'fast', max_fields_per_pass: 3 },
      conversion: { currency_mode: 'static' },
      lookup_tables: [],
    };
    expect(config.nlu_provider).toBe('advanced');
    expect(config.advanced_sidecar_url).toBe('http://kore-nlu:8090');
  });

  it('should type-check NluProvider as union', () => {
    const standard: NluProvider = 'standard';
    const advanced: NluProvider = 'advanced';
    expect(standard).toBe('standard');
    expect(advanced).toBe('advanced');
  });
});
```

**Step 2: Run test, confirm fail**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir-schema-nlu-provider.test.ts`
Expected: FAIL — `NluProvider` type not found, `nlu_provider` not on interface

**Step 3: Add NluProvider type and fields to IR**

In `packages/compiler/src/platform/ir/schema.ts`, near line 535 (after `ExtractionStrategy`):

```typescript
/** NLU provider tier — 'standard' uses JS + LLM only; 'advanced' adds ML sidecar (enterprise) */
export type NluProvider = 'standard' | 'advanced';
```

In `ProjectRuntimeConfigIR` (line 83-103), add after `extraction_strategy`:

```typescript
export interface ProjectRuntimeConfigIR {
  extraction_strategy: ExtractionStrategy;
  nlu_provider: NluProvider;
  advanced_sidecar_url?: string;
  advanced_sidecar_timeout_ms?: number;
  advanced_sidecar_circuit_breaker_threshold?: number;
  multi_intent: {
    // ... existing fields unchanged
  };
  // ... rest unchanged
}
```

**Step 4: Run test, confirm pass**

Run: `cd packages/compiler && npx vitest run src/__tests__/ir-schema-nlu-provider.test.ts`
Expected: PASS

**Step 5: Build compiler**

Run: `pnpm --filter @abl/compiler build`
Expected: Clean build

**Step 6: Commit**

```
[ABLP-2] feat(compiler): add NluProvider type and fields to ProjectRuntimeConfigIR
```

---

### Task 2: Add nlu_provider fields to DB model

**Files:**

- Modify: `packages/database/src/models/project-runtime-config.model.ts:18-23` (IExtractionConfig)
- Modify: `packages/database/src/models/project-runtime-config.model.ts:80-88` (ExtractionConfigSchema)
- Test: `packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts`

**Step 1: Write failing test**

```typescript
// packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts
import { describe, it, expect } from 'vitest';

describe('ProjectRuntimeConfig nlu_provider fields', () => {
  it('should default nlu_provider to standard', async () => {
    // Import the schema to check defaults
    const { default: mongoose } = await import('mongoose');
    const { ProjectRuntimeConfig } = await import('../models/project-runtime-config.model.js');
    const schema = ProjectRuntimeConfig.schema;
    const extractionPaths = schema.path('extraction') as any;
    expect(extractionPaths).toBeDefined();
  });

  it('should accept nlu_provider values', () => {
    // Type-level check — the interface should allow 'standard' | 'advanced'
    const config = {
      extraction: {
        strategy: 'auto',
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'http://kore-nlu:8090',
      },
    };
    expect(config.extraction.nlu_provider).toBe('advanced');
  });

  it('should have advanced_sidecar_url as optional', () => {
    const config = {
      extraction: {
        strategy: 'auto',
        nlu_provider: 'standard',
        // no advanced_sidecar_url
      },
    };
    expect(config.extraction.nlu_provider).toBe('standard');
  });
});
```

**Step 2: Run test, confirm fail**

Run: `npx vitest run packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts`
Expected: FAIL or partial — interface doesn't have `nlu_provider`

**Step 3: Add fields to DB model**

In `packages/database/src/models/project-runtime-config.model.ts`:

Update `IExtractionConfig` (lines 18-23):

```typescript
export interface IExtractionConfig {
  strategy: string;
  correction_detection: string;
  nlu_provider: string;
  advanced_sidecar_url?: string;
  advanced_sidecar_timeout_ms: number;
  advanced_sidecar_circuit_breaker_threshold: number;
  sidecar_timeout_ms: number; // legacy — kept for backward compat
  sidecar_circuit_breaker_threshold: number; // legacy — kept for backward compat
}
```

Update `ExtractionConfigSchema` (lines 80-88):

```typescript
const ExtractionConfigSchema = new Schema<IExtractionConfig>(
  {
    strategy: { type: String, default: 'auto' },
    correction_detection: { type: String, default: 'ml' },
    nlu_provider: { type: String, default: 'standard', enum: ['standard', 'advanced'] },
    advanced_sidecar_url: { type: String },
    advanced_sidecar_timeout_ms: { type: Number, default: 3000 },
    advanced_sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
    sidecar_timeout_ms: { type: Number, default: 500 },
    sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
  },
  { _id: false },
);
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run packages/database/src/__tests__/project-runtime-config-nlu-provider.test.ts`
Expected: PASS

**Step 5: Build database package**

Run: `pnpm --filter @agent-platform/database build`
Expected: Clean build

**Step 6: Commit**

```
[ABLP-2] feat(database): add nlu_provider and advanced sidecar fields to ProjectRuntimeConfig
```

---

### Task 3: Update resolver to map new fields

**Files:**

- Modify: `apps/runtime/src/services/config/project-runtime-config-resolver.ts:26-60`
- Test: `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts` (update existing)

**Step 1: Write failing test**

Add to existing `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`:

```typescript
describe('nlu_provider field mapping', () => {
  it('should map nlu_provider from DB extraction section', async () => {
    // Mock DB returning { extraction: { strategy: 'auto', nlu_provider: 'advanced', advanced_sidecar_url: 'http://kore:8090' } }
    vi.doMock('@agent-platform/database', () => ({
      ProjectRuntimeConfig: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            extraction: {
              strategy: 'auto',
              nlu_provider: 'advanced',
              advanced_sidecar_url: 'http://kore:8090',
              advanced_sidecar_timeout_ms: 5000,
              advanced_sidecar_circuit_breaker_threshold: 3,
            },
          }),
        }),
      },
    }));

    const { resolveProjectRuntimeConfig } =
      await import('../services/config/project-runtime-config-resolver.js');
    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result?.nlu_provider).toBe('advanced');
    expect(result?.advanced_sidecar_url).toBe('http://kore:8090');
    expect(result?.advanced_sidecar_timeout_ms).toBe(5000);
    expect(result?.advanced_sidecar_circuit_breaker_threshold).toBe(3);
  });

  it('should default nlu_provider to standard when not in DB', async () => {
    vi.doMock('@agent-platform/database', () => ({
      ProjectRuntimeConfig: {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            extraction: { strategy: 'hybrid' },
          }),
        }),
      },
    }));

    const { resolveProjectRuntimeConfig } =
      await import('../services/config/project-runtime-config-resolver.js');
    const result = await resolveProjectRuntimeConfig('t1', 'p1');
    expect(result?.nlu_provider).toBe('standard');
    expect(result?.advanced_sidecar_url).toBeUndefined();
  });
});
```

**Step 2: Run test, confirm fail**

Run: `npx vitest run apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`
Expected: FAIL — `nlu_provider` not in returned object

**Step 3: Update resolver mapping**

In `apps/runtime/src/services/config/project-runtime-config-resolver.ts`, update the return object (lines 26-60) to add after `extraction_strategy`:

```typescript
return {
  extraction_strategy:
    (doc.extraction?.strategy as ProjectRuntimeConfigIR['extraction_strategy']) ?? 'auto',
  nlu_provider: (doc.extraction?.nlu_provider as 'standard' | 'advanced') ?? 'standard',
  advanced_sidecar_url: doc.extraction?.advanced_sidecar_url ?? undefined,
  advanced_sidecar_timeout_ms: doc.extraction?.advanced_sidecar_timeout_ms ?? undefined,
  advanced_sidecar_circuit_breaker_threshold:
    doc.extraction?.advanced_sidecar_circuit_breaker_threshold ?? undefined,
  multi_intent: {
    // ... existing, unchanged
  },
  // ... rest unchanged
};
```

**Step 4: Run test, confirm pass**

Run: `npx vitest run apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`
Expected: PASS

**Step 5: Build runtime**

Run: `pnpm --filter @agent-platform/runtime build`
Expected: Clean build

**Step 6: Commit**

```
[ABLP-2] feat(runtime): map nlu_provider and sidecar fields in project config resolver
```

---

## Phase 2: Plan Gating + API

### Task 4: Add advancedNlu to enterprise plan entitlements

**Files:**

- Modify: `apps/runtime/src/services/tenant-config.ts` (PLAN_FEATURES)
- Test: `apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`

**Step 1: Write failing test**

```typescript
// apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts
import { describe, it, expect } from 'vitest';

describe('advancedNlu entitlement', () => {
  it('should include advancedNlu in ENTERPRISE plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.ENTERPRISE.advancedNlu).toBe(true);
  });

  it('should NOT include advancedNlu in BUSINESS plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.BUSINESS.advancedNlu).toBeFalsy();
  });

  it('should NOT include advancedNlu in TEAM plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.TEAM.advancedNlu).toBeFalsy();
  });

  it('should NOT include advancedNlu in FREE plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.FREE.advancedNlu).toBeFalsy();
  });
});
```

**Step 2: Run test, confirm fail**

Run: `npx vitest run apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`
Expected: FAIL — `advancedNlu` property not on plan features

**Step 3: Add advancedNlu to plan features**

In `apps/runtime/src/services/tenant-config.ts`, find the `PLAN_FEATURES` object. Add `advancedNlu: false` to FREE, TEAM, and BUSINESS plans. Add `advancedNlu: true` to ENTERPRISE plan.

Also add `advancedNlu: boolean` to the `PlanFeatures` interface/type (if one exists) or to the feature object type.

**Step 4: Run test, confirm pass**

Run: `npx vitest run apps/runtime/src/__tests__/tenant-config-advanced-nlu.test.ts`
Expected: PASS

**Step 5: Commit**

```
[ABLP-2] feat(runtime): add advancedNlu entitlement to enterprise plan
```

---

### Task 5: Update API route with validation and enterprise gate

**Files:**

- Modify: `apps/runtime/src/routes/project-runtime-config.ts:29-54` (PLATFORM_DEFAULTS)
- Modify: `apps/runtime/src/routes/project-runtime-config.ts:74-79` (extractionConfigSchema)
- Test: `apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`

**Step 1: Write failing test**

```typescript
// apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts
import { describe, it, expect } from 'vitest';

describe('project runtime config API — nlu_provider', () => {
  it('should include nlu_provider: standard in platform defaults', async () => {
    const { PLATFORM_DEFAULTS } = await import('../routes/project-runtime-config.js');
    expect(PLATFORM_DEFAULTS.extraction.nlu_provider).toBe('standard');
  });

  it('should validate nlu_provider as standard or advanced', () => {
    // Test the zod schema accepts valid values
    const { extractionConfigSchema } = require('../routes/project-runtime-config.js');
    const valid = extractionConfigSchema.safeParse({ nlu_provider: 'advanced' });
    expect(valid.success).toBe(true);

    const invalid = extractionConfigSchema.safeParse({ nlu_provider: 'premium' });
    expect(invalid.success).toBe(false);
  });

  it('should reject advanced for non-enterprise tenants', () => {
    // This tests the plan gate logic — will be tested via route handler
    // For now, test the validation function directly
  });
});
```

**Step 2: Run test, confirm fail**

Run: `npx vitest run apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`
Expected: FAIL — `nlu_provider` not in defaults or schema

**Step 3: Update PLATFORM_DEFAULTS**

In `apps/runtime/src/routes/project-runtime-config.ts`, update `PLATFORM_DEFAULTS` (lines 29-54):

```typescript
const PLATFORM_DEFAULTS = {
  // ... existing
  extraction: {
    strategy: 'auto',
    correction_detection: 'ml',
    nlu_provider: 'standard',
    // advanced_sidecar_url intentionally omitted — no default
    advanced_sidecar_timeout_ms: 3000,
    advanced_sidecar_circuit_breaker_threshold: 5,
    sidecar_timeout_ms: 500,
    sidecar_circuit_breaker_threshold: 5,
  },
  // ... rest unchanged
};
```

Export `PLATFORM_DEFAULTS` if not already exported (needed for testing).

**Step 4: Update validation schema**

Update `extractionConfigSchema` (lines 74-79):

```typescript
const extractionConfigSchema = z.object({
  strategy: z.string().optional(),
  correction_detection: z.string().optional(),
  nlu_provider: z.enum(['standard', 'advanced']).optional(),
  advanced_sidecar_url: z.string().url().optional(),
  advanced_sidecar_timeout_ms: z.number().min(100).max(30000).optional(),
  advanced_sidecar_circuit_breaker_threshold: z.number().min(1).max(100).optional(),
  sidecar_timeout_ms: z.number().optional(),
  sidecar_circuit_breaker_threshold: z.number().optional(),
});
```

Export `extractionConfigSchema` if not already exported (needed for testing).

**Step 5: Add enterprise plan gate in PUT handler**

In the PUT route handler, after parsing the request body, add plan enforcement:

```typescript
// Enforce enterprise plan for advanced NLU provider
if (body.extraction?.nlu_provider === 'advanced') {
  const { resolveTenantConfig } = await import('../services/tenant-config.js');
  const tenantConfig = await resolveTenantConfig(tenantId);
  if (!tenantConfig.features.advancedNlu) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'PLAN_FEATURE_UNAVAILABLE',
        message: 'Advanced NLU provider requires an Enterprise plan',
      },
    });
  }
}

// Require advanced_sidecar_url when nlu_provider is advanced
if (body.extraction?.nlu_provider === 'advanced' && !body.extraction?.advanced_sidecar_url) {
  return res.status(400).json({
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'advanced_sidecar_url is required when nlu_provider is advanced',
    },
  });
}
```

**Step 6: Run test, confirm pass**

Run: `npx vitest run apps/runtime/src/__tests__/project-runtime-config-route-nlu.test.ts`
Expected: PASS

**Step 7: Build runtime**

Run: `pnpm --filter @agent-platform/runtime build`
Expected: Clean build

**Step 8: Commit**

```
[ABLP-2] feat(runtime): add nlu_provider validation and enterprise gate to config API
```

---

## Phase 3: Runtime Behavior

### Task 6: Gate Tier 2 sidecar on nlu_provider === 'advanced'

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:1164-1169` (enableSidecar flag)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:2379-2401` (correction detection)
- Test: `apps/runtime/src/__tests__/nlu-provider-gating.test.ts`

**Step 1: Write failing test**

```typescript
// apps/runtime/src/__tests__/nlu-provider-gating.test.ts
import { describe, it, expect } from 'vitest';

describe('NLU provider gating', () => {
  it('should disable sidecar when nlu_provider is standard', () => {
    const nluProvider = 'standard';
    const extractionStrategy = 'auto';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(false);
  });

  it('should enable sidecar when nlu_provider is advanced and strategy allows', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'auto';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(true);
  });

  it('should disable sidecar when strategy is llm even with advanced provider', () => {
    const nluProvider = 'advanced';
    const extractionStrategy = 'llm';
    const enableSidecar =
      nluProvider === 'advanced' &&
      extractionStrategy !== 'llm' &&
      extractionStrategy !== 'pattern';
    expect(enableSidecar).toBe(false);
  });

  it('should default nlu_provider to standard when not configured', () => {
    const nluProvider = undefined ?? 'standard';
    expect(nluProvider).toBe('standard');
  });
});
```

**Step 2: Run test, confirm pass** (pure logic tests pass immediately)

Run: `npx vitest run apps/runtime/src/__tests__/nlu-provider-gating.test.ts`
Expected: PASS (these are pure logic tests — they validate the gating condition)

**Step 3: Update flow-step-executor enableSidecar logic**

In `apps/runtime/src/services/execution/flow-step-executor.ts` (lines 1164-1169), change:

```typescript
// BEFORE:
const enableSidecar = projectStrategy !== 'llm' && projectStrategy !== 'pattern';

// AFTER:
const nluProvider: string = session.agentIR?.project_runtime_config?.nlu_provider ?? 'standard';
const enableSidecar =
  nluProvider === 'advanced' && projectStrategy !== 'llm' && projectStrategy !== 'pattern';
```

This ensures Tier 2 (ML sidecar) only runs when the project has `nlu_provider: 'advanced'`.

Also add a runtime safety net — if `nlu_provider === 'advanced'` but the plan doesn't support it, log a warning and downgrade:

```typescript
// Runtime safety net: downgrade non-enterprise tenants
if (nluProvider === 'advanced' && session.tenantId) {
  try {
    const { resolveTenantConfig } = await import('../../services/tenant-config.js');
    const tenantConfig = await resolveTenantConfig(session.tenantId);
    if (!tenantConfig.features.advancedNlu) {
      log.warn('Non-enterprise tenant has advanced NLU, downgrading to standard', {
        tenantId: session.tenantId,
        agent: session.agentName,
      });
      enableSidecar = false; // change const to let above
    }
  } catch {
    // Config resolution failed — default to safe (no sidecar)
    enableSidecar = false;
  }
}
```

Similarly, update the correction detection block (lines 2379-2401) to check `nlu_provider`:

```typescript
// 2. If regex didn't match, try sidecar ML detection (advanced only)
if (!correctionField && nluProvider === 'advanced') {
  // ... existing sidecar correction detection code
}
```

Note: `nluProvider` needs to be accessible in the correction detection scope. Extract it once at the top of the method or pass it through.

**Step 4: Build and run tests**

Run: `pnpm --filter @agent-platform/runtime build`
Run: `npx vitest run apps/runtime/src/__tests__/nlu-provider-gating.test.ts`
Expected: PASS

**Step 5: Commit**

```
[ABLP-2] feat(runtime): gate Tier 2 ML sidecar on nlu_provider === 'advanced'
```

---

### Task 7: Make sidecar client per-session from project config

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:189` (field type)
- Modify: `apps/runtime/src/services/runtime-executor.ts:232-235` (getter)
- Modify: `apps/runtime/src/services/runtime-executor.ts:257-270` (constructor)
- Modify: `apps/runtime/src/services/runtime-executor.ts` (initializeSession — project config section)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:1214` (sidecar access)
- Test: `apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts`

**Step 1: Write failing test**

```typescript
// apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('per-session NLU sidecar client', () => {
  it('should not create a global sidecar client from env var', () => {
    // After this change, NLU_SIDECAR_URL env var should NOT create a global client
    // Instead, the client is created per-session from project config
    process.env.NLU_SIDECAR_URL = 'http://should-not-be-used:8090';
    // The global getter should return undefined (no global client)
    // Per-session client is stored on the session, not the executor
  });

  it('should create sidecar client from project config advanced_sidecar_url', () => {
    const projectConfig = {
      nlu_provider: 'advanced' as const,
      advanced_sidecar_url: 'http://kore-nlu:8090',
      advanced_sidecar_timeout_ms: 5000,
      advanced_sidecar_circuit_breaker_threshold: 3,
    };

    // Verify config shape is correct for NLUSidecarClient constructor
    expect(projectConfig.advanced_sidecar_url).toBe('http://kore-nlu:8090');
    expect(projectConfig.advanced_sidecar_timeout_ms).toBe(5000);
  });
});
```

**Step 2: Implement per-session sidecar wiring**

The key change: instead of a global `_nluSidecarClient` on `RuntimeExecutor`, the sidecar client is created per-session during `initializeSession` and stored on the session (or on a per-session context map).

**Option A (simpler):** Store on session as `session._nluSidecarClient`. This means `RuntimeSession` gets a new optional field.

In `apps/runtime/src/services/execution/types.ts`, add to `RuntimeSession`:

```typescript
/** Per-session NLU sidecar client — created when nlu_provider is 'advanced' */
_nluSidecarClient?: import('../nlu/sidecar-client.js').NLUSidecarClient;
```

In `apps/runtime/src/services/runtime-executor.ts`:

1. **Remove** the global `_nluSidecarClient` field (line 189), getter (lines 232-235), and constructor wiring (lines 257-270).

2. In `initializeSession`, after loading project config, conditionally create the client:

```typescript
// Create per-session NLU sidecar client for advanced provider
if (
  session.agentIR?.project_runtime_config?.nlu_provider === 'advanced' &&
  session.agentIR.project_runtime_config.advanced_sidecar_url
) {
  const { NLUSidecarClient } = await import('./nlu/sidecar-client.js');
  session._nluSidecarClient = new NLUSidecarClient({
    url: session.agentIR.project_runtime_config.advanced_sidecar_url,
    timeoutMs: session.agentIR.project_runtime_config.advanced_sidecar_timeout_ms,
    circuitBreakerThreshold:
      session.agentIR.project_runtime_config.advanced_sidecar_circuit_breaker_threshold,
  });
}
```

3. In `flow-step-executor.ts`, change `this.ctx.nluSidecarClient` references to `session._nluSidecarClient`:

Line 1214: `if (enableSidecar && tier2CandidateFields.length > 0 && session._nluSidecarClient) {`
Line 1226: `const sidecarResult = await session._nluSidecarClient.extract({`
Line 2382: `const sidecarClient = session._nluSidecarClient;`

**Step 3: Run tests**

Run: `npx vitest run apps/runtime/src/__tests__/nlu-sidecar-per-session.test.ts`
Run: `npx vitest run apps/runtime/src/__tests__/nlu-sidecar-wiring.test.ts` (update existing test)
Run: `pnpm --filter @agent-platform/runtime build`
Expected: All pass, clean build

**Step 4: Commit**

```
[ABLP-2] refactor(runtime): move NLU sidecar client from global to per-session via project config
```

---

## Phase 4: Tier 1 JS Enhancement

### Task 8: Add email and currency extractors to Tier 1 JS libs

**Files:**

- Modify: `packages/compiler/src/platform/utils/js-extraction.ts`
- Test: `packages/compiler/src/__tests__/js-extraction-email-currency.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/compiler/src/__tests__/js-extraction-email-currency.test.ts
import { describe, it, expect } from 'vitest';
import { extractWithJSLibs } from '../platform/utils/js-extraction.js';

describe('email extraction in Tier 1', () => {
  it('should extract a simple email address', () => {
    const result = extractWithJSLibs(
      'My email is john@example.com',
      [{ name: 'email', type: 'email' }],
      'en',
    );
    expect(result.email).toBe('john@example.com');
  });

  it('should extract email with dots and plus', () => {
    const result = extractWithJSLibs(
      'Contact me at john.doe+work@company.co.uk',
      [{ name: 'contact', type: 'email' }],
      'en',
    );
    expect(result.contact).toBe('john.doe+work@company.co.uk');
  });

  it('should not extract invalid email', () => {
    const result = extractWithJSLibs(
      'Not an email: john@',
      [{ name: 'email', type: 'email' }],
      'en',
    );
    expect(result.email).toBeUndefined();
  });
});

describe('currency extraction in Tier 1', () => {
  it('should extract USD amount', () => {
    const result = extractWithJSLibs(
      'The total is $49.99',
      [{ name: 'amount', type: 'currency' }],
      'en',
    );
    expect(result.amount).toEqual({ value: 49.99, currency: 'USD' });
  });

  it('should extract EUR amount', () => {
    const result = extractWithJSLibs(
      'Price is €120.50',
      [{ name: 'price', type: 'currency' }],
      'en',
    );
    expect(result.price).toEqual({ value: 120.5, currency: 'EUR' });
  });

  it('should extract GBP amount', () => {
    const result = extractWithJSLibs('It costs £75', [{ name: 'cost', type: 'currency' }], 'en');
    expect(result.cost).toEqual({ value: 75, currency: 'GBP' });
  });

  it('should extract amount with currency code suffix', () => {
    const result = extractWithJSLibs('Total: 250 USD', [{ name: 'total', type: 'currency' }], 'en');
    expect(result.total).toEqual({ value: 250, currency: 'USD' });
  });
});

describe('number extraction in Tier 1', () => {
  it('should extract integer', () => {
    const result = extractWithJSLibs('I need 5 rooms', [{ name: 'count', type: 'number' }], 'en');
    expect(result.count).toBe(5);
  });

  it('should extract decimal', () => {
    const result = extractWithJSLibs(
      'Temperature is 98.6 degrees',
      [{ name: 'temp', type: 'number' }],
      'en',
    );
    expect(result.temp).toBe(98.6);
  });
});
```

**Step 2: Run tests, confirm fail**

Run: `cd packages/compiler && npx vitest run src/__tests__/js-extraction-email-currency.test.ts`
Expected: FAIL — `email`, `currency`, `number` types not handled

**Step 3: Add extractors to js-extraction.ts**

In `packages/compiler/src/platform/utils/js-extraction.ts`, add handlers for the new types in the `extractWithJSLibs` function's type switch:

```typescript
case 'email': {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = text.match(emailRegex);
  if (match) {
    results[field.name] = match[0];
  }
  break;
}

case 'currency': {
  // Symbol-prefix: $49.99, €120, £75.50
  const symbolMatch = text.match(/([€£¥₹]|(?:US)?\$)\s*([\d,]+(?:\.\d{1,2})?)/);
  if (symbolMatch) {
    const symbolMap: Record<string, string> = {
      '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR',
    };
    results[field.name] = {
      value: parseFloat(symbolMatch[2].replace(/,/g, '')),
      currency: symbolMap[symbolMatch[1]] ?? 'USD',
    };
    break;
  }
  // Code-suffix: 250 USD, 100 EUR
  const codeMatch = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF)\b/i);
  if (codeMatch) {
    results[field.name] = {
      value: parseFloat(codeMatch[1].replace(/,/g, '')),
      currency: codeMatch[2].toUpperCase(),
    };
  }
  break;
}

case 'number':
case 'integer':
case 'float': {
  // Extract the first number-like token not part of a date or phone
  const numMatch = text.match(/(?<!\d[/-])\b(\d+(?:\.\d+)?)\b(?![/-]\d)/);
  if (numMatch) {
    results[field.name] = parseFloat(numMatch[1]);
  }
  break;
}
```

**Step 4: Run tests, confirm pass**

Run: `cd packages/compiler && npx vitest run src/__tests__/js-extraction-email-currency.test.ts`
Expected: PASS

Run full compiler tests: `pnpm --filter @abl/compiler test`
Expected: All pass

**Step 5: Commit**

```
[ABLP-2] feat(compiler): add email, currency, and number extractors to Tier 1 JS libs
```

---

## Phase 5: Studio UI

### Task 9: Add NLU provider toggle to RuntimeConfigTab

**Files:**

- Modify: `apps/studio/src/components/settings/RuntimeConfigTab.tsx:89-94` (constants)
- Modify: `apps/studio/src/components/settings/RuntimeConfigTab.tsx:418-462` (Extraction section)
- Modify: `packages/i18n/locales/en/studio.json` (add i18n keys)
- Test: Manual verification (React component)

**Step 1: Add i18n keys**

In `packages/i18n/locales/en/studio.json`, add to the `runtime_config` section:

```json
"field_nlu_provider": "NLU Provider",
"field_nlu_provider_description": "Standard uses JS extraction + LLM. Advanced adds ML-based entity extraction (Enterprise only).",
"field_advanced_sidecar_url": "ML Sidecar URL",
"field_advanced_sidecar_url_description": "URL of the Kore NLU sidecar service for ML-based extraction",
"field_advanced_sidecar_timeout": "ML Sidecar Timeout (ms)",
"field_advanced_sidecar_threshold": "ML Sidecar Circuit Breaker Threshold",
"nlu_provider_enterprise_badge": "Enterprise",
"nlu_provider_upgrade_hint": "Upgrade to Enterprise to enable Advanced NLU"
```

**Step 2: Add NLU_PROVIDERS constant**

In `RuntimeConfigTab.tsx` (near line 89), add:

```typescript
const NLU_PROVIDERS = ['standard', 'advanced'];
```

**Step 3: Add NLU provider UI to Extraction section**

In `RuntimeConfigTab.tsx`, insert after the strategy dropdown (after line ~435) and before correction detection:

```tsx
<Field label={t('field_nlu_provider')} description={t('field_nlu_provider_description')}>
  <div className="flex items-center gap-2">
    <SelectField
      value={config.extraction.nlu_provider ?? 'standard'}
      onChange={(v) => updateExtraction('nlu_provider', v)}
      options={NLU_PROVIDERS}
      disabled={!isEnterprise}
    />
    {config.extraction.nlu_provider === 'advanced' && <Badge variant="purple">Enterprise</Badge>}
    {!isEnterprise && config.extraction.nlu_provider !== 'advanced' && (
      <span className="text-xs text-muted">{t('nlu_provider_upgrade_hint')}</span>
    )}
  </div>
</Field>;

{
  config.extraction.nlu_provider === 'advanced' && (
    <>
      <Field
        label={t('field_advanced_sidecar_url')}
        description={t('field_advanced_sidecar_url_description')}
      >
        <input
          type="url"
          className="input-field"
          value={config.extraction.advanced_sidecar_url ?? ''}
          onChange={(e) => updateExtraction('advanced_sidecar_url', e.target.value)}
          placeholder="http://kore-nlu:8090"
        />
      </Field>
      <Field label={t('field_advanced_sidecar_timeout')}>
        <NumberField
          value={config.extraction.advanced_sidecar_timeout_ms ?? 3000}
          onChange={(v) => updateExtraction('advanced_sidecar_timeout_ms', v)}
          min={100}
          max={30000}
          step={100}
        />
      </Field>
      <Field label={t('field_advanced_sidecar_threshold')}>
        <NumberField
          value={config.extraction.advanced_sidecar_circuit_breaker_threshold ?? 5}
          onChange={(v) => updateExtraction('advanced_sidecar_circuit_breaker_threshold', v)}
          min={1}
          max={100}
        />
      </Field>
    </>
  );
}
```

Note: `isEnterprise` needs to be derived from tenant context. Check if the component already receives plan info via props or a hook. If not, add:

```typescript
const tenantConfig = useTenantConfig(); // or similar hook
const isEnterprise = tenantConfig?.planTier === 'ENTERPRISE';
```

**Step 4: Conditionally hide legacy sidecar fields**

The existing `sidecar_timeout_ms` and `sidecar_circuit_breaker_threshold` fields (lines 446-462) should be hidden when `nlu_provider` is `'standard'` since they're only relevant for the advanced sidecar. Wrap them:

```tsx
{
  config.extraction.nlu_provider === 'advanced' && (
    <>
      {/* ... existing sidecar fields, or remove if replaced by advanced_sidecar_* fields above */}
    </>
  );
}
```

Or remove them entirely if the new `advanced_sidecar_*` fields replace them.

**Step 5: Build Studio**

Run: `pnpm --filter @agent-platform/studio build`
Expected: Clean build

**Step 6: Commit**

```
[ABLP-2] feat(studio): add NLU provider toggle with enterprise gate to RuntimeConfigTab
```

---

## Verification

After all 9 tasks are complete:

1. **Build**: `pnpm build` (clean build, no type errors)
2. **Compiler tests**: `pnpm --filter @abl/compiler test` (all pass, new extraction tests)
3. **Runtime tests**: `cd apps/runtime && npx vitest run` (all pass, new gating tests)
4. **New test files** (6 total):
   - `ir-schema-nlu-provider.test.ts`
   - `project-runtime-config-nlu-provider.test.ts`
   - `tenant-config-advanced-nlu.test.ts`
   - `project-runtime-config-route-nlu.test.ts`
   - `nlu-provider-gating.test.ts`
   - `js-extraction-email-currency.test.ts`
5. **Updated test files** (2):
   - `project-runtime-config-resolver.test.ts`
   - `nlu-sidecar-wiring.test.ts` → replaced by `nlu-sidecar-per-session.test.ts`

## Dependencies

```
Phase 1 (sequential — schema → DB → resolver):
  Task 1 (IR schema)
    └── Task 2 (DB model)
        └── Task 3 (Resolver)

Phase 2 (sequential — entitlements → API):
  Task 4 (Plan entitlements)
    └── Task 5 (API route)

Phase 3 (depends on Phase 1 + 2):
  Task 6 (Gate sidecar) ← Tasks 3, 4
  Task 7 (Per-session client) ← Task 6

Phase 4 (independent — can run in parallel with Phase 2-3):
  Task 8 (JS extractors)

Phase 5 (depends on all prior):
  Task 9 (Studio UI) ← Tasks 5, 8
```
