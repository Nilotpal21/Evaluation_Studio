# Query Pipeline LLM Configuration — Design Document

**Status:** Final Design — Ready for Implementation
**Date:** March 9, 2026

---

## Problem

The query pipeline uses LLM for vocabulary resolution and query classification, but today it is hardcoded to a single env var (`ANTHROPIC_API_KEY`). Tenants cannot use their own models. There is no UI to see or change which model powers the query pipeline.

**Goal:** Let users configure which LLM model powers vocabulary resolution and query classification in the retrieval pipeline, using models they have already set up at the workspace level.

---

## Decisions

| Question             | Decision                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                | **Per-KB.** Each KB can pin a different model.                                                                                                      |
| Default for new KBs  | **Auto-select if models exist.** `{ autoSelect: true, preferredTier: 'fast' }` — works immediately.                                                 |
| Auto-select criteria | Consider **use case fit** (`supportsTools` for structured output) and **daily token budget** remaining.                                             |
| Cache invalidation   | **5-min TTL for Phase 1.** Redis pub/sub can come later if needed.                                                                                  |
| Hardcoded env var    | **Keep in bootstrap** for existing functionality. New per-tenant feature does not use it.                                                           |
| Resolver caching     | **Cache the full resolver stack** (client + DynamicVocabularyResolver + HybridSearchBuilder) per `tenantId:indexId`. Preserves internal LRU caches. |

---

## Current State

### What exists

| Layer     | Model                 | Purpose                                                                                             |
| --------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| Workspace | TenantModel           | Model instances with tier (fast/balanced/powerful), linked to credentials                           |
| Workspace | LLMCredential         | Encrypted API keys per provider                                                                     |
| Workspace | TenantLLMPolicy       | Budgets, rate limits, allowed providers                                                             |
| Project   | ProjectLLMConfig      | Operation → tier overrides                                                                          |
| Per-KB    | SearchIndex.llmConfig | Ingestion feature toggles (10 use cases, including `mapping_suggestion` and `vocabularyGeneration`) |

**Recent addition:** `vocabularyGeneration` was added to `USE_CASE_DEFAULTS` in `defaults.ts` as an enabled-by-default use case (`modelTier: 'fast'`, `costRating: 3`). The `mapping_suggestion` use case was also added. Both are now configurable per-index in the SettingsTab UI under the enrichment category.

### The gap

The ingestion pipeline has proper LLM resolution (`resolveIndexLLMConfig()` → TenantModel → LLMCredential → WorkerLLMClient). The query pipeline is disconnected — a single hardcoded client in `server.ts:224` serves all tenants through `ServiceContainer` → `DynamicVocabularyResolver`.

### Where LLM is used in the query pipeline

| Component                 | Stage   | What it does                                                    |
| ------------------------- | ------- | --------------------------------------------------------------- |
| DynamicVocabularyResolver | Stage 2 | One LLM call: resolves vocabulary terms + classifies query type |
| QueryTypeClassifier       | Stage 2 | Classifies query as structured/semantic/hybrid/aggregation      |

Both are fast-tier tasks — high volume, low complexity, latency-sensitive (<500ms).

---

## User Journeys

### Journey 1: No model configured at workspace level

Tenant has no TenantModels at all.

```
┌──────────────────────────────────────────────────────────────┐
│  Retrieval Settings                                           │
│                                                               │
│  Query Pipeline LLM                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ⚠  No LLM model configured                           │  │
│  │                                                        │  │
│  │  Vocabulary resolution and query classification need   │  │
│  │  an LLM model. Without one, search uses static         │  │
│  │  matching only (lower accuracy).                       │  │
│  │                                                        │  │
│  │  [ Add Model in Workspace Settings → ]                 │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Search Defaults                                              │
│  Top K         [ 10    ]                                      │
│  Similarity    [ 0.7   ]                                      │
│  Hybrid Alpha  [ 0.7   ]                                      │
└──────────────────────────────────────────────────────────────┘
```

CTA opens workspace model settings. When user returns and refreshes, section updates.

### Journey 2: New KB — auto-selects immediately

Tenant has workspace models. KB is created with default `{ autoSelect: true, preferredTier: 'fast' }`. User opens Settings tab and sees it already working.

```
┌──────────────────────────────────────────────────────────────┐
│  Query Pipeline LLM                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Claude 3.5 Haiku (auto-selected)         [ Change ▾ ]│  │
│  │  Tier: Fast  •  Provider: Anthropic  •  ● Active      │  │
│  │                                                        │  │
│  │  Auto-select: [ ON  ]                                  │  │
│  │  System picks the best available fast-tier model.      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

No user action needed. Query pipeline has LLM from the start.

### Journey 3: Manual model selection

User clicks [Change] to pick a specific model.

```
┌────────────────────────────────────────────┐
│  Select Query Pipeline Model               │
│                                            │
│  Recommended: Fast tier (runs on every     │
│  query, needs low latency)                 │
│                                            │
│  ● Claude 3.5 Haiku          Fast tier     │
│    Anthropic                               │
│                                            │
│  ○ GPT-4o Mini                Fast tier    │
│    OpenAI                                  │
│                                            │
│  ○ Claude 3.5 Sonnet       Balanced tier   │
│    Anthropic                               │
│    ⚠ Higher latency and cost per query     │
│                                            │
│  Don't see your model?                     │
│  [ Add in Workspace Settings → ]           │
│                                            │
│  [ Cancel ]                  [ Select ]    │
└────────────────────────────────────────────┘
```

After selection the model is **pinned**. Auto-select turns OFF. Adding new models to workspace does NOT change it.

### Journey 4: Pinned model — steady state

```
┌──────────────────────────────────────────────────────────────┐
│  Query Pipeline LLM                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Claude 3.5 Haiku                        [ Change ▾ ] │  │
│  │  Tier: Fast  •  Provider: Anthropic  •  ● Active      │  │
│  │                                                        │  │
│  │  Auto-select: [ OFF ]                                  │  │
│  │  Model stays fixed. Turn on to let the system pick.    │  │
│  │                                                        │  │
│  │  Used for:                                             │  │
│  │  • Vocabulary resolution                               │  │
│  │  • Query type classification                           │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Pinned means pinned.** Nothing changes this selection unless the user explicitly acts.

**If the pinned model is deactivated or deleted at workspace level:**

```
  ┌────────────────────────────────────────────────────────┐
  │  ⚠  Claude 3.5 Haiku is no longer active       [Fix] │
  │                                                        │
  │  This model was deactivated in workspace settings.     │
  │  Select a different model or enable auto-select.       │
  │                                                        │
  │  Currently falling back to: static matching            │
  └────────────────────────────────────────────────────────┘
```

### Journey 5: Auto-select with budget awareness

When auto-select is ON, the system considers:

1. **Tier match:** Prefer models matching `preferredTier` (default: fast).
2. **Capability fit:** Prefer `supportsTools: true` for structured output parsing.
3. **Budget check:** If `TenantLLMPolicy.dailyTokenBudget` remaining is low, pick cheapest model or skip LLM entirely and use static fallback.

If daily budget is exhausted:

```
  ┌────────────────────────────────────────────────────────┐
  │  ℹ  Daily token budget exhausted                       │
  │                                                        │
  │  Search is using static matching until budget resets.  │
  │  Query quality may be reduced.                         │
  └────────────────────────────────────────────────────────┘
```

---

## Navigation Map

```
Studio
├── /workspace/settings/models              ← Existing: manage TenantModels
│   ├── [+ Add Model]
│   └── [Model Card] → Edit/Delete
│
├── /projects/:projectId/kb/:kbId/settings
│   └── Settings Tab
│       ├── Query Pipeline LLM section      ← NEW (top of page)
│       │   ├── Auto-selected / pinned / warning states
│       │   ├── Auto-select toggle
│       │   ├── [Change] → ModelSelectorDialog
│       │   └── Budget warning
│       └── LLM Features section            ← Existing (ingestion use cases)
│
└── /workspace/settings/llm-policy          ← Existing: governance
```

---

## Technical Design

### Data Model

Add `queryLLMConfig` field to SearchIndex (per-KB):

```typescript
// packages/database/src/models/search-index.model.ts

// Interface addition (after llmConfig, ~line 157)
queryLLMConfig?: {
  modelId: string | null;    // TenantModel._id — null when auto-select
  autoSelect: boolean;       // true = system picks best model at query time
  preferredTier: string;     // 'fast' | 'balanced' | 'powerful'
} | null;
```

**Default for new KBs:** `{ modelId: null, autoSelect: true, preferredTier: 'fast' }`

**State machine:**

| State                | `queryLLMConfig` value                                          | UI                                   |
| -------------------- | --------------------------------------------------------------- | ------------------------------------ |
| No workspace models  | `{ autoSelect: true }` but no models found                      | Journey 1: "No LLM model configured" |
| Auto-selected        | `{ modelId: null, autoSelect: true, preferredTier: 'fast' }`    | Journey 2: "(auto-selected)"         |
| Pinned               | `{ modelId: 'tm_x', autoSelect: false, preferredTier: 'fast' }` | Journey 4: model card                |
| Pinned + deactivated | `{ modelId: 'tm_x', autoSelect: false }` but model inactive     | Journey 4: warning banner            |

**Mongoose schema** (after llmConfig schema, ~line 350):

```typescript
queryLLMConfig: {
  type: new Schema(
    {
      modelId: { type: String, default: null },
      autoSelect: { type: Boolean, default: true },
      preferredTier: {
        type: String,
        enum: ['fast', 'balanced', 'powerful'],
        default: 'fast',
      },
    },
    { _id: false },
  ),
  default: () => ({ modelId: null, autoSelect: true, preferredTier: 'fast' }),
},
```

### Validation

```typescript
// apps/search-ai/src/validation/index-schemas.ts

export const QueryLLMConfigSchema = z.object({
  modelId: z.string().nullable().optional(),
  autoSelect: z.boolean().optional(),
  preferredTier: z.enum(['fast', 'balanced', 'powerful']).optional(),
});
```

### API Endpoints

On `apps/search-ai/src/routes/indexes.ts`, following the `/:indexId/llm-config` pattern.

#### GET /:indexId/query-llm-status

```typescript
// Response
{
  configured: true,           // has a resolved model (pinned or auto-selected)
  autoSelect: true,
  preferredTier: 'fast',
  model: {                    // resolved model (or null)
    id: 'tm_abc123',
    displayName: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    modelId: 'claude-3-5-haiku-20241022',
    tier: 'fast',
    isActive: true,
    supportsTools: true
  },
  resolution: 'auto-selected',  // 'auto-selected' | 'pinned' | 'none'
  availableModels: [             // all active tenant models for the picker
    { id: 'tm_abc123', displayName: 'Claude 3.5 Haiku', tier: 'fast', provider: 'anthropic' },
    { id: 'tm_def456', displayName: 'GPT-4o Mini', tier: 'fast', provider: 'openai' }
  ],
  budget: {                      // from TenantLLMPolicy
    dailyRemaining: 450000,      // tokens remaining today
    dailyLimit: 500000,
    exhausted: false
  },
  fallback: null,                // null = no fallback needed, 'static' = using static
  warning: null                  // null | 'model_deactivated' | 'budget_exhausted'
}
```

**Implementation:**

1. Load `SearchIndex` by `{ _id: indexId, tenantId }`.
2. Load `TenantModel.find({ tenantId, isActive: true, inferenceEnabled: true })` for available models.
3. If `autoSelect: true`, resolve via `resolveTenantModelWithFallback()` considering budget.
4. If `modelId` set, load that TenantModel and check `isActive`.
5. Load `TenantLLMPolicy` for budget info.
6. Return merged response.

#### PUT /:indexId/query-llm-config

```typescript
// Pin a specific model (turns off auto-select)
{ "modelId": "tm_abc123", "autoSelect": false }

// Enable auto-select
{ "modelId": null, "autoSelect": true }

// Change preferred tier
{ "autoSelect": true, "preferredTier": "balanced" }
```

**Validation:** If `modelId` is provided, verify TenantModel exists and is active for this tenant. Return 400 if not.

### Runtime Resolution

#### Existing bootstrap (unchanged)

The current `server.ts` startup code stays as-is. The hardcoded `WorkerLLMClient` continues to power the `ServiceContainer` for any non-per-tenant functionality.

```typescript
// server.ts line 224 — KEEP THIS, don't use it for per-tenant queries
const llmClient = new WorkerLLMClient('anthropic', process.env.ANTHROPIC_API_KEY || '', ...);
serviceContainer.initialize({ llmClient, embeddingProvider });
```

#### New per-tenant resolution

New file: `apps/search-ai-runtime/src/services/query-llm-resolver.ts`

```typescript
interface CachedQueryLLMStack {
  client: WorkerLLMClient;
  resolver: DynamicVocabularyResolver; // cached WITH its internal LRU caches
  builder: HybridSearchBuilder;
  modelDisplayName: string;
  resolution: 'pinned' | 'auto-selected';
}

// Cache the full stack per tenant+index. DynamicVocabularyResolver's internal
// vocabulary (5min TTL) and schema (10min TTL) caches stay warm across requests.
const resolverCache = new LRUCache<string, CachedQueryLLMStack | null>({
  max: 500, // up to 500 tenant+index combinations
  ttl: 5 * 60 * 1000, // 5 min — then re-resolve from DB
});

export async function resolveQueryLLMStack(
  tenantId: string,
  indexId: string,
  embeddingProvider: EmbeddingProvider,
): Promise<CachedQueryLLMStack | null> {
  const cacheKey = `${tenantId}:${indexId}`;
  if (resolverCache.has(cacheKey)) return resolverCache.get(cacheKey)!;

  // 1. Load SearchIndex.queryLLMConfig
  const index = await SearchIndex.findOne({ _id: indexId, tenantId })
    .select('queryLLMConfig')
    .lean();

  if (!index?.queryLLMConfig) {
    resolverCache.set(cacheKey, null);
    return null;
  }

  const { modelId, autoSelect, preferredTier } = index.queryLLMConfig;

  // 2. Resolve the tenant model
  let resolved: ResolvedTenantModel | null = null;
  let resolution: 'pinned' | 'auto-selected' = 'auto-selected';

  if (modelId && !autoSelect) {
    resolved = await resolveTenantModelById(tenantId, modelId);
    resolution = 'pinned';
  } else if (autoSelect) {
    // Budget-aware auto-select
    const policy = await TenantLLMPolicy.findOne({ tenantId });
    if (policy?.dailyTokenBudget) {
      // TODO: check today's usage against budget, skip LLM if exhausted
    }
    const result = await resolveTenantModelWithFallback(tenantId, preferredTier);
    resolved = result.model;
    resolution = 'auto-selected';
  }

  if (!resolved) {
    resolverCache.set(cacheKey, null);
    return null;
  }

  // 3. Build the full stack
  const client = new WorkerLLMClient(resolved.provider, resolved.apiKey, resolved.modelId);
  const resolver = new DynamicVocabularyResolver(client);
  const builder = new HybridSearchBuilder(resolver, embeddingProvider);

  const stack: CachedQueryLLMStack = {
    client,
    resolver,
    builder,
    modelDisplayName: resolved.displayName,
    resolution,
  };

  resolverCache.set(cacheKey, stack);
  return stack;
}
```

#### Query route changes

Location: `apps/search-ai-runtime/src/routes/query.ts`

```typescript
router.post('/:indexId/query', async (req, res) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  // Get shared options (embedding, vectorStore, etc.)
  const baseOptions = serviceContainer.getPipelineOptions();

  // Resolve per-tenant LLM stack for this KB
  const llmStack = await resolveQueryLLMStack(
    tenantId,
    indexId,
    serviceContainer.getEmbeddingProvider(),
  );

  // Build pipeline options — merge shared + per-tenant
  const pipelineOptions: QueryPipelineOptions = {
    embeddingProvider: baseOptions.embeddingProvider,
    vectorStore: baseOptions.vectorStore,
    // Per-tenant LLM components (or undefined → static fallback)
    dynamicVocabularyResolver: llmStack?.resolver,
    hybridSearchBuilder: llmStack?.builder,
  };

  const queryPipeline = new QueryPipeline(pipelineOptions);
  const response = await queryPipeline.executeUnified(
    unifiedQuery,
    tenantId,
    callerContext,
    authMode,
    userIdentity,
  );
  res.json(response);
});
```

**Performance:** `QueryPipeline` is a lightweight object (stores references). The expensive parts are shared via ServiceContainer or cached in `resolverCache`. The `DynamicVocabularyResolver`'s internal LRU caches (vocabulary 5min, schema 10min) stay warm because we cache the resolver instance itself.

#### New function: resolveTenantModelById

Add to `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts`:

```typescript
export async function resolveTenantModelById(
  tenantId: string,
  tenantModelId: string,
): Promise<ResolvedTenantModel | null> {
  const TenantModel = getModel('TenantModel');
  const LLMCredential = getModel('LLMCredential');

  const model = await TenantModel.findOne({
    _id: tenantModelId,
    tenantId,
    isActive: true,
    inferenceEnabled: true,
  });
  if (!model) return null;

  // Same connection + credential resolution as resolveTenantModelForTier
  const connection = model.connections?.find((c: any) => c.isPrimary && c.isActive);
  if (!connection?.credentialId) return null;

  // No .lean() — encryption plugin decrypts in post-find hook
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
  });
  if (!credential?.encryptedApiKey) return null;

  return {
    modelId: model.modelId,
    provider: model.provider,
    displayName: model.displayName,
    tier: model.tier,
    apiKey: credential.encryptedApiKey,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsStreaming: model.supportsStreaming,
  };
}
```

### Graceful Degradation

| Scenario                      | Pipeline behavior                | UI                       |
| ----------------------------- | -------------------------------- | ------------------------ |
| Auto-select, models available | Full dynamic resolution          | "(auto-selected)" label  |
| Pinned model active           | Full dynamic resolution          | Model card               |
| Pinned model deactivated      | Static fallback                  | Warning banner           |
| Auto-select, no active models | Static fallback                  | Journey 1 banner         |
| Auto-select, budget exhausted | Static fallback                  | Budget warning           |
| LLM call timeout/error        | Static fallback for this request | No UI change (transient) |

**Search always works.** LLM makes it better, but is never required.

### UI Components

Add to existing `SettingsTab.tsx` as a new section at the top, before "LLM Features" (ingestion).

```
SettingsTab.tsx (modify)
├── QueryPipelineLLMSection         ← NEW component (top of page)
│   ├── States: loading / no-workspace-models / auto-selected / pinned / warning / budget
│   ├── Auto-select toggle
│   ├── Model card (display name, tier, provider, active status)
│   ├── [Change] button → opens ModelSelectorDialog
│   ├── Warning banner (model deactivated)
│   └── Budget warning banner
│
├── ModelSelectorDialog             ← NEW component
│   ├── List of available TenantModels (grouped by tier, fast first)
│   ├── "Recommended" badge on fast-tier models
│   ├── Warning on balanced/powerful tier (higher cost)
│   ├── Radio selection
│   ├── "Add in Workspace Settings" link
│   └── Cancel / Select buttons
│
└── Existing LLM Features section (ingestion use cases, unchanged)
```

**Data flow:**

```
Mount → GET /api/search-ai/indexes/{indexId}/query-llm-status
     → Render based on response (configured / resolution / warning / budget)

[Change] → open ModelSelectorDialog with availableModels from status response
        → on select: PUT /api/search-ai/indexes/{indexId}/query-llm-config
        → refetch status

Auto-select toggle → PUT { autoSelect: true/false, modelId: null }
                   → refetch status
```

---

## Files Changed

### Phase 1: Backend

| File                                                             | Change                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/search-index.model.ts`             | Add `queryLLMConfig` to ISearchIndex + Mongoose schema. Default: `{ autoSelect: true, preferredTier: 'fast' }` |
| `apps/search-ai/src/validation/index-schemas.ts`                 | Add `QueryLLMConfigSchema`                                                                                     |
| `apps/search-ai/src/routes/indexes.ts`                           | Add `GET /:indexId/query-llm-status` and `PUT /:indexId/query-llm-config`                                      |
| `apps/search-ai/src/services/llm-config/tenant-model-adapter.ts` | Add `resolveTenantModelById()`                                                                                 |
| `apps/search-ai-runtime/src/services/query-llm-resolver.ts`      | **NEW:** `resolveQueryLLMStack()` with LRU cache for full resolver stack                                       |
| `apps/search-ai-runtime/src/routes/query.ts`                     | Per-request pipeline options with resolved per-tenant LLM stack                                                |

### Phase 2: UI

| File                                                               | Change                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `apps/studio/src/components/search-ai/SettingsTab.tsx`             | Import and render `QueryPipelineLLMSection` at top                       |
| `apps/studio/src/components/search-ai/QueryPipelineLLMSection.tsx` | **NEW:** Status display, auto-select toggle, model card, warning banners |
| `apps/studio/src/components/search-ai/ModelSelectorDialog.tsx`     | **NEW:** Model picker dialog with tier grouping                          |

### Phase 3: Observability

| File                                                          | Change                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts` | Emit trace event with resolved model info (name, tier, resolution method) |
