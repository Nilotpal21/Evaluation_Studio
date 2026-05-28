# Eval Pipeline LLM Resolution Fix — High-Level Design

## What

Eval runs always fail because every LLM call in the pipeline resolves to the tenant's default model (often an OpenAI model with a revoked key) instead of the evaluator's configured Claude Sonnet. Two bugs cause this:

1. **Model ID mismatch**: The evaluator dialog stores hardcoded short names (e.g., `"claude-sonnet-4-6"`) but `TenantModel.modelId` has the catalog form with date suffix (`"claude-sonnet-4-6-20260217"`). Exact-match query fails.
2. **Tier 2 dead path**: The pipeline resolver's project-level fallback queries `ModelConfig.findOne({projectId, isDefault: true})`, which is only populated if users explicitly add models via the Admin > Models flow — most projects have none.

Both failures cause silent fallthrough to Tier 3 (tenant default), which picks whatever model is marked default — typically one with a broken or wrong credential.

## Architecture Approach

### Packages Changed

| Package                    | Change                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio`              | Replace hardcoded `JUDGE_MODELS` in `CreateEvaluatorDialog` with dynamic model picker using existing `useProjectModelOptions` hook |
| `packages/pipeline-engine` | Add prefix-match fallback in `resolveByModelId` for Tier 1; enhance eval preflight to validate specific judge/persona models       |

### Data Flow

```
                    ┌─────────────────────────────────┐
                    │  CreateEvaluatorDialog (Studio)  │
                    │                                  │
                    │  BEFORE: hardcoded JUDGE_MODELS  │
                    │  AFTER:  useProjectModelOptions  │
                    │          ─► fetches TenantModel  │
                    │          ─► stores real modelId   │
                    └────────────┬────────────────────┘
                                 │
                    judgeModel = "claude-sonnet-4-6-20260217"
                                 │
                    ┌────────────▼────────────────────┐
                    │  EvalEvaluator (MongoDB)         │
                    │  judgeModel: string              │
                    └────────────┬────────────────────┘
                                 │
            ┌────────────────────▼─────────────────────────┐
            │  resolvePipelineLLM(tenantId, projectId,     │
            │                     "claude-sonnet-4-6-...")  │
            │                                              │
            │  Tier 1: TenantModel.findOne({modelId})      │
            │          ─► EXACT MATCH ✓                    │
            │          ─► if not: prefix match fallback    │
            │  Tier 2: ModelConfig.findOne({isDefault})    │
            │  Tier 3: TenantModel default (last resort)   │
            └──────────────────────────────────────────────┘
```

### Key Integration Points

- `useProjectModelOptions` hook already fetches tenant models with credential readiness — reuse directly
- `Select` component accepts `{value, label}[]` — compatible with hook output
- Eval preflight (`eval-preflight.ts`) already validates LLM availability — extend to check per-evaluator models
- No database schema changes needed — `judgeModel` and `personaModel` are free-text strings

## Decisions & Tradeoffs

**Decision 1: Dynamic model picker via `useProjectModelOptions` over fixing model registry aliases**

- Chose dynamic picker because it solves the root cause (UI stores wrong ID) and prevents future drift
- Alternative: add alias mapping in model-registry.ts — rejected because it adds complexity and doesn't help when new models are added to registry

**Decision 2: Add prefix-match fallback in Tier 1 over requiring exact match only**

- Chose prefix match as a safety net for existing evaluators that already have short names stored in DB
- The fallback queries only dated aliases such as `^prefix-(YYYYMMDD|YYYY-MM-DD)$` when exact match fails
- This intentionally does not treat sibling variants such as `gpt-4o-mini` as aliases for `gpt-4o`
- This handles both old data (short names) and new data (full names) without a migration
- Alternative: data migration to fix existing evaluator records — rejected as too risky for production data

**Decision 3: Enhance eval preflight over fixing Tier 2 ModelConfig gap**

- Chose to add model-specific validation in preflight so users get clear sanitized errors before the run starts
- Eval judge resolution disables the historic explicit-model fallback, so an unavailable judge model cannot silently run on the project or tenant default
- Fixing Tier 2 (making it also check AgentModelConfig) is a larger scope change that affects all pipeline services, not just evals
- Tier 2 fix deferred as separate work — this HLD focuses on making evals work end-to-end

**Decision 4: Keep `personaModel` as optional (no UI picker) for now**

- The eval set's `personaModel` defaults to null, meaning persona simulation uses project/tenant default
- This is acceptable behavior — the critical fix is the judge model mismatch
- Adding a persona model picker to CreateEvalSetDialog is out of scope for this fix

## Task Decomposition

| Task                                                       | Package(s)               | Independent?   | Est. Files |
| ---------------------------------------------------------- | ------------------------ | -------------- | ---------- |
| T-1: Replace hardcoded JUDGE_MODELS with dynamic picker    | apps/studio              | Yes            | 2-3        |
| T-2: Add prefix-match fallback in pipeline Tier 1 resolver | packages/pipeline-engine | Yes            | 1-2        |
| T-3: Enhance eval preflight to validate evaluator models   | packages/pipeline-engine | No (after T-2) | 1          |

## Out of Scope

- Fixing Tier 2 `ModelConfig` gap (separate, larger change affecting all pipelines)
- Adding `personaModel` picker to `CreateEvalSetDialog`
- Fixing the same hardcoded model pattern in `IdentitySection.tsx` (separate concern, not eval-related)
- Data migration for existing evaluator `judgeModel` values (T-2 prefix match handles old data)
- Fixing the revoked OpenAI API key on the tenant (infrastructure/admin task)
