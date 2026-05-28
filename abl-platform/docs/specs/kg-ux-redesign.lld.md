# Knowledge Graph UX Redesign — Low-Level Design

## Task T-1: Backend — Extend KG Configuration Status & Auto-Configure

### Files to Modify

- `apps/search-ai/src/routes/kg-taxonomy.ts` — Add `environment` and `autoConfigureModelId` fields to GET `/:indexId/kg-configuration-status` handler; add auto-configure logic to POST `/:indexId/kg-taxonomy/setup` handler

### Function Signatures

- `GET /:indexId/kg-configuration-status` — Existing handler, extended response shape
- `POST /:indexId/kg-taxonomy/setup` — Existing handler, extended body + auto-configure side effect

### Response Shape Change (GET /kg-configuration-status)

```typescript
// NEW fields added to existing response (bare JSON, consistent with existing pattern)
{
  environment: {
    available: boolean; // from getConfig().knowledgeGraph.enabled
    reason: string | null; // 'neo4j_not_provisioned' when !available, null otherwise
  }
  autoConfigureModelId: string | null; // recommended model ID when configurationLevel === 'tenant'
  // ...all existing fields unchanged
}
```

Note: This endpoint uses bare JSON responses (no `{ success, data }` envelope) — matching the existing pattern. Not fixing the envelope here for backward compatibility.

### Setup Auto-Configure Logic (POST /kg-taxonomy/setup)

When the index does not yet have `llmConfig.useCases.knowledgeGraph.modelId` set, and the request body includes `autoConfigureModelId`, the setup handler will:

1. Validate `autoConfigureModelId` with Zod: `z.string().min(1).optional()`
2. Validate the model exists, belongs to the tenant, and is active
3. Initialize `llmConfig` to `{ useCases: {} }` if null (MongoDB cannot `$set` through null parent)
4. Set `llmConfig.useCases.knowledgeGraph.{enabled, modelId, configuredAt}` on the index
5. Then proceed with taxonomy setup as normal

Extract the model validation + config update logic into a helper function `autoConfigureKGModel(indexId, tenantId, modelId)` to avoid duplicating the `kg-configure-model` handler's code.

### Subtasks

1. **ST-1.1**: ADD `import { getConfig } from '../config/index.js';` at top of `kg-taxonomy.ts` — this import does NOT currently exist in the file
2. **ST-1.2**: In GET handler, read `const kgEnvironmentAvailable = getConfig().knowledgeGraph.enabled;` once at the top. Add `environment: { available: kgEnvironmentAvailable, reason: kgEnvironmentAvailable ? null : 'neo4j_not_provisioned' }` to all three response paths (workspace at `res.json(...)`, tenant at `res.json(...)`, none at `res.json(...)`). Add `autoConfigureModelId: recommendation?.modelId ?? null` to the tenant response, `null` to the others.
3. **ST-1.3**: In POST `/:indexId/kg-taxonomy/setup` handler, after index validation:
   - Parse `autoConfigureModelId` from body with Zod validation: `z.string().min(1).optional()`
   - Check if index already has `llmConfig.useCases.knowledgeGraph.modelId` — if not, and `autoConfigureModelId` is provided:
     - Validate model via `TenantModel.findOne({ _id: autoConfigureModelId, tenantId, isActive: true })`
     - Initialize llmConfig if null: `SearchIndex.updateOne({ _id: indexId, tenantId, llmConfig: null }, { $set: { llmConfig: { useCases: {} } } })`
     - Set KG config: `SearchIndex.findOneAndUpdate({ _id: indexId, tenantId }, { $set: { 'llmConfig.useCases.knowledgeGraph.enabled': true, '.modelId': modelId, '.configuredAt': new Date() } })`
   - Proceed with existing job creation logic
   - Use structured error responses for auto-configure failures: `{ success: false, error: { code: 'MODEL_NOT_FOUND', message: '...' } }`

### Acceptance Criteria

- AC-1: When `KNOWLEDGE_GRAPH_ENABLED=false` (or unset, default), response includes `environment: { available: false, reason: 'neo4j_not_provisioned' }`
- AC-2: When `KNOWLEDGE_GRAPH_ENABLED=true`, response includes `environment: { available: true, reason: null }`
- AC-3: When `configurationLevel === 'tenant'`, response includes `autoConfigureModelId` matching the recommended model ID
- AC-4: When `configurationLevel !== 'tenant'`, `autoConfigureModelId` is null
- AC-5: POST setup with `autoConfigureModelId` auto-configures the model AND creates the taxonomy job in one call
- AC-6: POST setup without `autoConfigureModelId` works exactly as before (backward compatible)
- AC-7: POST setup with invalid `autoConfigureModelId` returns 400/404 with structured error, does NOT create taxonomy job

---

## Task T-4: i18n — Add New Translation Keys

### Files to Modify

- `packages/i18n/locales/en/studio.json` — Add keys under `search_ai.kg` and `search_ai.intelligence` namespaces

### New Keys

Under `search_ai.kg`:

```json
{
  "not_deployed_title": "Knowledge Graph",
  "not_deployed_banner_title": "Not Available in This Environment",
  "not_deployed_banner_description": "Knowledge Graph requires a Neo4j graph database, which is not provisioned in this deployment.",
  "not_deployed_contact_admin": "Contact your platform administrator to enable Knowledge Graph.",
  "not_deployed_benefit_classify": "Automatically classify documents by product and department",
  "not_deployed_benefit_extract": "Extract dates, amounts, identifiers, and custom attributes",
  "not_deployed_benefit_graph": "Explore relationships in an interactive knowledge graph",
  "not_deployed_benefit_search": "Filter and search by extracted entities",
  "onboarding_title": "Knowledge Graph",
  "onboarding_description": "Automatically classify documents, extract entities, and build a searchable knowledge graph from your content.",
  "onboarding_steps_title": "What happens when you set up KG:",
  "onboarding_step_1": "Pick your industry domain (or let AI generate one)",
  "onboarding_step_2": "We build a taxonomy of products and attributes",
  "onboarding_step_3": "Every document gets classified automatically",
  "onboarding_step_4": "Entities are extracted and linked into a graph",
  "onboarding_using_model": "Using: {model}",
  "onboarding_change_model": "change",
  "onboarding_select_domain": "Select your domain",
  "onboarding_no_models_title": "LLM Model Required",
  "onboarding_no_models_description": "Knowledge Graph needs an LLM model for classification and entity extraction. Set up a model in project settings, then come back here.",
  "onboarding_configure_models": "Configure Models",
  "onboarding_sibling_banner": "Use same setup as \"{name}\"",
  "onboarding_sibling_details": "Domain: {domain} · Model: {model}",
  "onboarding_sibling_setup": "Set Up",
  "onboarding_what_you_get": "What you'll get"
}
```

Under `search_ai.intelligence`:

```json
{
  "kg_stat_not_deployed": "Not Deployed",
  "kg_not_deployed_description": "Requires Neo4j. Contact your admin.",
  "kg_action_learn_more": "Learn More",
  "kg_stat_ready": "Ready to set up",
  "kg_action_setup_kg": "Set Up KG",
  "kg_attention_review": "{count, plural, one {# attribute needs review} other {# attributes need review}}"
}
```

**Important**: All new KG components must use `useTranslations('search_ai.kg')` — NOT the legacy `knowledgeGraph` namespace used by `KGConfigureModelsCard`. The `search_ai.kg` namespace is the standard used by all other KG components.

### Subtasks

1. **ST-4.1**: Add all keys to `packages/i18n/locales/en/studio.json` under `search_ai.kg` (inside the existing `search_ai.kg` block)
2. **ST-4.2**: Add intelligence hub keys to `packages/i18n/locales/en/studio.json` under `search_ai.intelligence` (inside existing block)

### Acceptance Criteria

- AC-1: All new keys present and valid JSON after edit
  - Verify: `node -e "require('./packages/i18n/locales/en/studio.json')"`
  - Expected: No parse errors
- AC-2: Keys are in correct namespace blocks (not at root level)

---

## Task T-2: Frontend — Redesign KG Tab State Machine

### Files to Modify

- `apps/studio/src/hooks/useKnowledgeGraph.ts` — Extend `KGConfigurationStatus` type with `environment` and `autoConfigureModelId` fields
- `apps/studio/src/api/search-ai.ts` — Extend `setupTaxonomy()` data parameter with optional `autoConfigureModelId`
- `apps/studio/src/components/search-ai/KnowledgeGraphTab.tsx` — Replace 3-state machine with 4-state machine, add `useKGConfigurationStatus` hook call

### Files to Create

- `apps/studio/src/components/search-ai/KGNotDeployedCard.tsx` — Informational card for when Neo4j not provisioned
- `apps/studio/src/components/search-ai/KGOnboardingCard.tsx` — Combined onboarding card replacing wizard + first-visit taxonomy setup

### Type Changes (useKnowledgeGraph.ts)

```typescript
export interface KGConfigurationStatus {
  // NEW
  environment: {
    available: boolean;
    reason: string | null;
  };
  autoConfigureModelId: string | null;
  // EXISTING (unchanged)
  configurationLevel: 'workspace' | 'tenant' | 'none';
  workspace: {
    hasKGConfigured: boolean;
    configuredIndexes: ConfiguredIndex[];
    recommendation?: {
      action: string;
      message: string;
    };
  };
  tenant: {
    models: AssessedModel[];
    recommendation: ModelRecommendation | null;
  } | null;
  requiresConfiguration: boolean;
}
```

### KGNotDeployedCard Component

```typescript
// No props — purely informational, uses i18n for all text
export function KGNotDeployedCard(): JSX.Element;
// Uses: useTranslations('search_ai.kg')
// Renders:
// - Info banner (neutral bg, not error): "Not Available in This Environment"
// - Explanation: Neo4j not provisioned
// - Contact admin text
// - Value proposition list (4 benefits with icons)
// Pattern: follows KGEnableCard layout (centered card with icon list)
```

### KGOnboardingCard Component

```typescript
interface KGOnboardingCardProps {
  indexId: string;
  mode: 'no-models' | 'ready';
  autoConfigureModelId: string | null;
  recommendedModelName: string | null;
  siblingConfig: {
    name: string;
    domain: string;
    model: string;
    modelId: string;
    inheritedFrom: string;
  } | null;
  onComplete: () => void;
}

export function KGOnboardingCard(props: KGOnboardingCardProps): JSX.Element;
// Uses: useTranslations('search_ai.kg')
```

When `mode === 'no-models'`:

- Shows value proposition + "LLM Model Required" info banner + "Configure Models" link
- "Configure Models" uses `useNavigationStore` to navigate (NOT next/router — learned from KGConfigureModelsCard bug fix)

When `mode === 'ready'`:

- Shows value proposition + "Using: {model} [change]" chip + domain picker grid
- If `siblingConfig` present, shows inheritance banner at top with one-click "Set Up" button
- Domain picker reuses `useKGDomains()` hook from `useKnowledgeGraph.ts`
- On domain select, transitions to configure/progress steps inline
- Passes `autoConfigureModelId` to `setupTaxonomy()` API call
- **Loading states**: Button disabled during POST, loading spinner, error toast on failure
- **SWR invalidation on success**: Call `onComplete()` which triggers parent's `refreshTaxonomy()`, `refreshIndex()`, and `mutate(kg-configuration-status key)`

### KnowledgeGraphTab State Machine (Revised)

```typescript
// NEW: Add config status hook
const { status: configStatus, isLoading: configLoading } = useKGConfigurationStatus(indexId);

// Integrate into loading check
const isInitialLoad =
  optimisticKGEnabled === null &&
  ((indexLoading && !indexData) ||
   (configLoading && !configStatus) ||  // NEW
   (taxonomyLoading && !taxonomy && !taxonomyNotFound));

// State 1: Environment check — KG infrastructure not available
if (configStatus && !configStatus.environment?.available) {
  return <KGNotDeployedCard />;
}

// State 2: No models / needs onboarding (replaces KGConfigurationWizard)
if (!kgEnabled && !hasModelConfigured) {
  const mode = configStatus?.configurationLevel === 'none' ? 'no-models' : 'ready';
  const recommendation = configStatus?.tenant?.recommendation;
  const recommendedModel = configStatus?.tenant?.models?.find(
    m => m.id === recommendation?.modelId
  );
  return (
    <KGOnboardingCard
      indexId={indexId}
      mode={mode}
      autoConfigureModelId={configStatus?.autoConfigureModelId ?? null}
      recommendedModelName={recommendedModel?.displayName ?? null}
      siblingConfig={/* derive from configStatus.workspace if hasKGConfigured */}
      onComplete={handleModelConfigured}
    />
  );
}

// State 3: KG enabled, no taxonomy → onboarding in 'ready' mode
if (taxonomyNotFound || !taxonomy) {
  return (
    <KGOnboardingCard
      indexId={indexId}
      mode="ready"
      autoConfigureModelId={configStatus?.autoConfigureModelId ?? null}
      recommendedModelName={/* derive */}
      siblingConfig={null}
      onComplete={handleTaxonomySetupComplete}
    />
  );
}

// State 4: Working experience (unchanged)
```

**SWR invalidation after setup completes**: Update `handleModelConfigured` and `handleTaxonomySetupComplete` to also invalidate `kg-configuration-status` cache. Use the hook's own `refresh()` function (not global `mutate`) to avoid SWR key string drift:

```typescript
const {
  status: configStatus,
  isLoading: configLoading,
  refresh: refreshConfigStatus,
} = useKGConfigurationStatus(indexId);
// In both handlers:
refreshConfigStatus();
refreshIndex();
```

**Remove**: Import and usage of `KGConfigurationWizard` — no longer used. Remove the import line but do NOT delete the file (separate cleanup commit per HLD).

### Subtasks

1. **ST-2.0**: Extend `setupTaxonomy()` in `apps/studio/src/api/search-ai.ts` — add `autoConfigureModelId?: string` to the `data` parameter type. Current signature: `setupTaxonomy(indexId: string, data: { domain: string; organizationProfile?: {...}; priority?: 'low'|'normal'|'high' })`. Add `autoConfigureModelId?: string` to the data object. The field passes through to `JSON.stringify(data)` → backend `req.body`.
2. **ST-2.1**: Extend `KGConfigurationStatus` type in `useKnowledgeGraph.ts` with `environment` and `autoConfigureModelId` fields (additive, backward-compatible)
3. **ST-2.2**: Create `KGNotDeployedCard.tsx` — info banner + value proposition + contact admin. Use `useTranslations('search_ai.kg')`. Follow `KGEnableCard` layout pattern.
4. **ST-2.3**: Create `KGOnboardingCard.tsx` — two modes, model chip, domain picker (reuse `useKGDomains()` hook), sibling inheritance banner. On domain select, call `setupTaxonomy()` with `autoConfigureModelId`. Handle loading/error/success states with toast + `onComplete()`.
5. **ST-2.4**: Update `KnowledgeGraphTab.tsx`:
   - Add `useKGConfigurationStatus(indexId)` hook call
   - Integrate `configLoading` into `isInitialLoad`
   - Replace 3-state machine with 4-state logic
   - Add SWR invalidation for `kg-configuration-status` in completion handlers
   - Remove unused imports: `KGConfigurationWizard` (line 45), `KGTaxonomySetupCard` (line 44), `KGEnableCard` (line 43 — pre-existing dead code)

### Acceptance Criteria

- AC-1: When Neo4j not provisioned, KG tab shows `KGNotDeployedCard` with value proposition — no action buttons that lead to dead ends
- AC-2: When models exist but no taxonomy, KG tab shows `KGOnboardingCard` with domain picker and auto-assigned model chip
- AC-3: When `configurationLevel === 'none'`, shows "LLM Model Required" banner with link to settings
- AC-4: Domain selection triggers taxonomy setup with `autoConfigureModelId` — no separate model selection step
- AC-5: When sibling KB has KG, inheritance banner appears at top of onboarding card
- AC-6: Working experience (graph/stats/attributes) unchanged
- AC-7: SWR caches invalidated after successful setup (index data, config status, taxonomy)

---

## Task T-3: Frontend — Hub Card & IntelligenceCard Extension

### Files to Modify

- `apps/studio/src/components/search-ai/intelligence/IntelligenceCard.tsx` — Add `not-deployed` to `IntelligenceCardState` union and `STATE_STYLES`
- `apps/studio/src/components/search-ai/intelligence/cards/KnowledgeGraphCard.tsx` — Rewrite state logic to 5 states; replace inline `KGConfigResponse` type and raw `useSWR` with `useKGConfigurationStatus` hook from `useKnowledgeGraph.ts`

### IntelligenceCard Changes

```typescript
// Extend type
export type IntelligenceCardState = 'not-configured' | 'not-deployed' | 'healthy' | 'needs-attention' | 'error';

// Add to STATE_STYLES
'not-deployed': {
  border: 'border-default',
  dot: 'bg-muted opacity-50',
  messageBg: '',
  messageText: '',
},

// Update button variant logic
// not-deployed and not-configured both get 'primary' variant
state === 'not-configured' || state === 'not-deployed' ? 'primary' : 'secondary'

// Update stats visibility
// not-deployed also hides stats (same as not-configured)
state !== 'not-configured' && state !== 'not-deployed'
```

### KnowledgeGraphCard Changes

Replace inline `KGConfigResponse` type and raw `useSWR` with shared hook:

```typescript
// REMOVE: local KGConfigResponse interface and raw useSWR call
// ADD:
import { useKGConfigurationStatus } from '../../../../hooks/useKnowledgeGraph';
import { useKGTaxonomy } from '../../../../hooks/useKnowledgeGraph';

// In component:
const { status: configStatus, isLoading, error } = useKGConfigurationStatus(indexId);
// Conditional taxonomy check — only fetch when KG infra is available
const { isNotFound: taxonomyNotFound, taxonomy } = useKGTaxonomy(
  configStatus?.environment?.available ? indexId : null,
);
const hasTaxonomy = !!taxonomy && !taxonomyNotFound;
```

New 5-state logic:

```typescript
const configLevel = configStatus?.configurationLevel;

if (!configStatus?.environment?.available) {
  state = 'not-deployed';
  actionLabel = t('kg_action_learn_more');
  description = t('kg_not_deployed_description');
} else if (configLevel === 'none') {
  state = 'not-configured';
  actionLabel = t('kg_action_setup');
} else if (!hasTaxonomy) {
  state = 'not-configured';
  actionLabel = t('kg_action_setup_kg');
  stats.push({ label: t('kg_stat_ready'), value: '✓' });
} else if (reviewQueueTotal > 0) {
  state = 'needs-attention';
  actionLabel = t('kg_action_manage');
  stats.push({ label: t('kg_stat_review_queue') ?? 'Review Queue', value: reviewQueueTotal });
} else {
  state = 'healthy';
  actionLabel = t('kg_action_manage');
}
```

Fix pre-existing hardcoded attention message — replace with i18n key:

```typescript
// BEFORE (hardcoded English):
attentionMessage={`${reviewQueueTotal} attribute${reviewQueueTotal === 1 ? '' : 's'} need review`}
// AFTER (i18n):
attentionMessage={reviewQueueTotal > 0 ? t('kg_attention_review', { count: reviewQueueTotal }) : undefined}
```

Note: The `kg_attention_review` key uses ICU MessageFormat for pluralization, defined in `search_ai.intelligence` namespace (added in T-4) since `KnowledgeGraphCard` uses `useTranslations('search_ai.intelligence')`.

### Subtasks

1. **ST-3.1**: Extend `IntelligenceCardState` type and `STATE_STYLES` in `IntelligenceCard.tsx` with `not-deployed` state
2. **ST-3.2**: Update button variant and stats visibility logic in `IntelligenceCard.tsx` to handle `not-deployed`
3. **ST-3.3**: Rewrite `KnowledgeGraphCard.tsx`:
   - Remove inline `KGConfigResponse` interface
   - Replace raw `useSWR` with `useKGConfigurationStatus` hook
   - Add conditional `useKGTaxonomy` call: `useKGTaxonomy(configStatus?.environment?.available ? indexId : null)`
   - Implement 5-state logic
   - Fix hardcoded attention message with i18n key

### Acceptance Criteria

- AC-1: Hub card shows "Not Deployed" state with dimmed dot when Neo4j absent
- AC-2: Hub card shows "Ready to set up" when models exist but no taxonomy
- AC-3: Hub card shows correct state for all 5 scenarios
- AC-4: Clicking hub card in any state navigates to KG tab (no dead-end actions)
- AC-5: `IntelligenceCard` backward compatible — existing consumers (PipelineCard, FieldsCard, VocabularyCard, LLMModelsCard) unaffected
- AC-6: Attention message uses i18n (no hardcoded English strings)

---

## Execution Order

```
T-1 (backend) ─────┐
                    ├──► T-2 (tab state machine) ──► T-3 (hub card + IntelligenceCard)
T-4 (i18n)  ───────┘
```

T-1 and T-4 are independent → run in parallel.
T-2 depends on T-1 (response shape) and T-4 (i18n keys).
T-3 depends on T-2 (types from useKnowledgeGraph.ts).

## Tech Debt Notes (not fixing, documenting)

- `kg-taxonomy.ts` uses bare JSON responses instead of `{ success, data }` envelope — all paths
- `kg-taxonomy.ts` has `(idx.llmConfig as any)` casts — use typed access in new code
- `KGConfigureModelsCard` uses wrong i18n namespace (`knowledgeGraph` vs `search_ai.kg`) — do not replicate
- `KnowledgeBase.findOne` at line ~107 missing explicit `tenantId` — relies on plugin injection
