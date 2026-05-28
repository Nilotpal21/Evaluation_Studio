# LLD: Model Selection Intelligence

**Feature Spec**: `docs/features/model-selection-intelligence.md`
**HLD**: `docs/specs/model-selection-intelligence.hld.md`
**Test Spec**: `docs/testing/model-selection-intelligence.md`
**Status**: IN PROGRESS
**Date**: 2026-04-05

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                          | Rationale                                                                         | Alternatives Rejected                             |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| D-1 | Enhance `getModelRecommendation()` in-place, keep same function signature         | Existing callers (`generateSingleAgent`) unaffected. Internal logic changes only. | New service endpoint (over-engineering)           |
| D-2 | Import `MODEL_REGISTRY` directly from compiler package                            | Static data, no API call needed. Sub-ms access. Already used in the codebase.     | Runtime API call (adds latency)                   |
| D-3 | Tenant model list passed as parameter, not fetched inside helper                  | Keeps helper pure/testable. Caller provides tenant context.                       | Internal fetch (hard to test, couples to session) |
| D-4 | `recommend_model` tool registered in `tools/` alongside existing IN_PROJECT tools | Follows existing tool registration pattern.                                       | Separate tool module (inconsistent)               |

### Key Interfaces & Types

```typescript
// apps/studio/src/lib/arch-ai/types.ts (ENHANCED)

export interface ModelRecommendation {
  primary: ScoredModel;
  fallback?: ScoredModel;
  alternatives: ScoredModel[];
  perOperation?: Record<string, ScoredModel>;
  executionConfig: { temperature: number; maxTokens: number; compactionPolicy?: string };
  costComparison: { relativeSavings: string; absoluteEstimate?: string };
}

export interface ScoredModel {
  provider: string;
  model: string;
  score: number;
  reasoning: string;
  costTier: 'low' | 'medium' | 'high';
  latencyTier: 'fast' | 'moderate' | 'slow';
  capabilities: { supportsTools: boolean; supportsVision: boolean; supportsStreaming: boolean };
}

export interface ModelRecommendationInput {
  agentRole: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  requiresToolCalling: boolean;
  requiresVision: boolean;
  requiresStructuredOutput: boolean;
  complexityTier: 'simple' | 'moderate' | 'complex';
  operations?: string[];
  constraints?: string[]; // NEW — PCI-DSS, HIPAA, etc.
  channels?: string[]; // NEW — voice, web, etc.
  tenantModels?: string[]; // NEW — provisioned model IDs
  tenantPolicy?: { allowedProviders?: string[] }; // NEW
}
```

### Module Boundaries

| Module                        | Responsibility                                      | Depends On                                    |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `get-model-recommendation.ts` | Scoring, filtering, fallback chain, cost comparison | MODEL_REGISTRY (compiler), types              |
| `recommend-model-tool.ts`     | Specialist-visible tool wrapping the helper         | get-model-recommendation, project agent store |
| `ModelComparisonWidget.tsx`   | Comparison card UI                                  | design tokens, types                          |

---

## 2. File-Level Change Map

### New Files

| File                                                                         | Purpose                                   | LOC Estimate |
| ---------------------------------------------------------------------------- | ----------------------------------------- | ------------ |
| `apps/studio/src/lib/arch-ai/tools/recommend-model.ts`                       | `recommend_model` specialist-visible tool | ~80          |
| `apps/studio/src/components/arch-v3/widgets/ModelComparisonWidget.tsx`       | Comparison card widget                    | ~120         |
| `apps/studio/src/__tests__/arch-ai/model-recommendation.test.ts`             | Unit tests for scoring/filtering          | ~250         |
| `apps/studio/src/__tests__/arch-ai/model-recommendation-integration.test.ts` | Integration tests with real registry      | ~200         |

### Modified Files

| File                                                              | Change Description                                                                       | Risk                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` | Replace hardcoded logic with registry-based scoring + tenant filtering + fallback + cost | Med — core logic rewrite, same signature |
| `apps/studio/src/lib/arch-ai/types.ts`                            | Extend `ModelRecommendation`, add `ScoredModel`                                          | Low — additive types                     |
| `apps/studio/src/lib/arch-ai/tools/generate-agents.ts`            | Pass tenant context to `getModelRecommendation()`                                        | Low — add params to existing call        |

---

## 3. Implementation Phases

### Phase 1: Enhance Recommendation Engine

**Goal**: Replace static model selection with registry-based scoring, capability matching, and cost comparison.

**Tasks**:
1.1. Read `packages/compiler/src/platform/llm/model-registry.ts` to understand `ModelRegistryEntry` structure and pricing data
1.2. Read `packages/compiler/src/platform/llm/model-capabilities.ts` to understand `ModelCapabilities` interface
1.3. Refactor `getModelRecommendation()` internals:

- Replace `selectPrimaryModel()` switch-case with registry scoring: iterate `MODEL_REGISTRY`, score each model by capability match + complexity fit
- Add `filterByTenantModels()`: if `tenantModels` provided, restrict candidates
- Add `filterByCompliance()`: if `constraints` includes PCI-DSS/HIPAA, exclude non-compliant
- Add `buildFallbackChain()`: pick fallback from different provider with similar capabilities
- Add `computeCostComparison()`: relative cost ratios from registry pricing data
  1.4. Update `ModelRecommendationInput` type to accept new optional fields
  1.5. Ensure backward compat: existing callers that pass the old input shape still work

**Files Touched**:

- `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` — refactor internals
- `apps/studio/src/lib/arch-ai/types.ts` — extend types

**Exit Criteria**:

- [ ] `getModelRecommendation({ complexityTier: 'complex', requiresToolCalling: true })` returns a model from `MODEL_REGISTRY` with `supportsTools: true`
- [ ] `getModelRecommendation({ complexityTier: 'simple', executionMode: 'scripted' })` returns a cheap/fast model
- [ ] Result includes `fallback` from a different provider than `primary`
- [ ] Result includes `costComparison.relativeSavings` string
- [ ] Calling without new optional fields works identically to before
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: scoring logic, capability matching, fallback selection, cost ratios

**Rollback**: Revert `get-model-recommendation.ts` to previous version. Function signature unchanged.

---

### Phase 2: Tenant Policy Filtering + Compliance

**Goal**: Add tenant model list and LLM policy filtering so recommendations respect what the tenant has provisioned.

**Tasks**:
2.1. Add `tenantModels` and `tenantPolicy` handling in `getModelRecommendation()`
2.2. When `tenantModels` provided: restrict candidates to only those models
2.3. When `tenantPolicy.allowedProviders` provided: exclude other providers
2.4. When no tenant data: use full registry with `tenantFilterUnavailable: true` flag
2.5. Modify `generateSingleAgent()` in `tools/generate-agents.ts` to pass tenant context from session

**Files Touched**:

- `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` — tenant filtering
- `apps/studio/src/lib/arch-ai/tools/generate-agents.ts` — pass tenant context

**Exit Criteria**:

- [ ] With `tenantModels: ['claude-haiku-4-5', 'claude-sonnet-4']`: only those 2 models in candidates
- [ ] With `tenantPolicy: { allowedProviders: ['anthropic'] }`: no OpenAI/Google in results
- [ ] With empty tenant models: full registry used, result includes `tenantFilterUnavailable: true`
- [ ] Integration test: `getModelRecommendation()` with real `MODEL_REGISTRY` + tenant filter produces valid output

**Test Strategy**:

- Unit: filtering logic with various tenant configs
- Integration: real registry + filtering

**Rollback**: Revert tenant filtering code. Callers that don't pass tenant data get full registry (existing behavior).

---

### Phase 3: Specialist Tool + Widget

**Goal**: Expose `recommend_model` as a specialist-visible tool for IN_PROJECT mode and create the comparison widget.

**Tasks**:
3.1. Create `apps/studio/src/lib/arch-ai/tools/recommend-model.ts`:

- Tool definition with Zod schema: `{ agentName: z.string().min(1) }`
- Execute function: read agent profile from project, call `getModelRecommendation()`, return structured result
- Handle `agentName: "all"` for topology-wide recommendation
  3.2. Register tool in the IN_PROJECT tool set (wherever existing tools are registered)
  3.3. Create `ModelComparisonWidget.tsx` using semantic design tokens:
- Render 2-4 model cards with primary recommendation highlighted
- Each card: model name, provider, strengths, cost tier, latency tier
- "Apply" button triggers agent modification (wired to IP-F01 when available)
  3.4. Register widget in the chat message renderer (alongside existing widgets)

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/recommend-model.ts` — NEW
- `apps/studio/src/components/arch-v3/widgets/ModelComparisonWidget.tsx` — NEW
- Tool registration file (wherever IN_PROJECT tools are listed)
- Widget renderer in chat panel

**Exit Criteria**:

- [ ] `recommend_model` tool callable by the specialist LLM in IN_PROJECT mode
- [ ] Tool returns structured `ModelRecommendation` with 2-4 candidates
- [ ] `ModelComparisonWidget` renders correctly with mock data
- [ ] Widget shows primary recommendation with visual distinction
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: tool execute function, widget rendering
- Integration: tool invocation within a real Arch message flow

**Rollback**: Delete new tool and widget files. Unregister from tool set. No data impact.

---

### Phase 4: Journal Integration + Activity Feed

**Goal**: Persist model recommendations in the session journal and show progress in the BUILD activity feed.

**Tasks**:
4.1. After `getModelRecommendation()` returns in `generateSingleAgent()`, emit a `model_recommendation` journal event via the existing journal service
4.2. In the activity feed (B05 integration), emit SSE events showing model selection: `"🧠 Model: claude-sonnet-4 (complex agent, 4 tools)"`
4.3. Render `model_recommendation` events in the JournalPanel

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/generate-agents.ts` — add journal event after recommendation
- `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx` — render new event type

**Exit Criteria**:

- [ ] `GET /api/arch-ai/sessions/:id/journal` returns `model_recommendation` events after BUILD
- [ ] JournalPanel renders model recommendation entries with agent name, model, reasoning
- [ ] Activity feed shows model selection per agent during BUILD
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Integration: verify journal event persisted via real session/journal services

**Rollback**: Remove journal event emission. Journal entries are additive — no cleanup needed.

---

## 4. Wiring Checklist

- [ ] `ScoredModel` and updated `ModelRecommendation` types exported from `types.ts`
- [ ] `recommend_model` tool registered in IN_PROJECT tool set
- [ ] `ModelComparisonWidget` imported in chat message widget renderer
- [ ] `getModelRecommendation()` receives tenant context from `generateSingleAgent()`
- [ ] Journal event emission wired after recommendation in `generate-agents.ts`
- [ ] `model_recommendation` event type handled in JournalPanel

---

## 5. Cross-Phase Concerns

### Database Migrations

None.

### Feature Flags

| Flag                               | Default | Description                             |
| ---------------------------------- | ------- | --------------------------------------- |
| `arch.modelRecommendation.enabled` | `true`  | Bypass to static fallback when disabled |

### Configuration Changes

No new env vars.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] Simple agent in BUILD → cheap model assigned automatically
- [ ] Complex agent in BUILD → powerful model with fallback chain
- [ ] IN_PROJECT "what model for X?" → comparison widget with 2-4 options
- [ ] Tenant policy filtering works (Anthropic-only tenant gets no OpenAI)
- [ ] Journal contains `model_recommendation` events
- [ ] Existing Arch AI tests pass (no regression)
- [ ] `pnpm build` succeeds for all affected packages

---

## 7. Open Questions

1. Where exactly are IN_PROJECT tools registered? Need to find the tool registration file before Phase 3 implementation.
2. Should the `apply` action on the comparison widget call IP-F01 directly, or just update session metadata for the next BUILD?
