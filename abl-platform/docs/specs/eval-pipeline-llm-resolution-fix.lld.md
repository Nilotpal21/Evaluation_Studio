# Eval Pipeline LLM Resolution Fix — Low-Level Design

## Task T-1: Replace Hardcoded JUDGE_MODELS with Dynamic Model Picker

### Files to Modify

- `apps/studio/src/components/evals/dialogs/CreateEvaluatorDialog.tsx` — Remove hardcoded `JUDGE_MODELS`, use `useProjectModelOptions` hook, add fallback for current value not in list

### Function Signatures

No new functions. Changes to existing component:

```tsx
// BEFORE (lines 53-59):
const JUDGE_MODELS = [
  { value: 'claude-opus-4-7', label: '...' },
  { value: 'claude-sonnet-4-6', label: '...' },
  ...
];

// AFTER:
// Import useProjectModelOptions from '@/hooks/useProjectModelOptions'
// Destructure: const { options, unavailableOptions, isLoading } = useProjectModelOptions(currentProject?.id)
// Build judgeModelOptions from `options` (credential-ready only) + fallback for current value
// Fallback pattern matches ExecutionEditor lines 49-67:
//   - If current judgeModel is in unavailableOptions → show as "${name} (no credentials)"
//   - If current judgeModel is not in any options → show as "${judgeModel} (not in project models)"
//   - Both fallback labels use i18n keys, not hardcoded English
```

### Subtasks (execution order)

1. **ST-1.1**: Add `useProjectModelOptions` import and call: `const { options, unavailableOptions, isLoading, error } = useProjectModelOptions(currentProject?.id)`
2. **ST-1.2**: Remove the hardcoded `JUDGE_MODELS` constant
3. **ST-1.3**: Build `judgeModelOptions` memo using the ExecutionEditor pattern (lines 49-67):
   - Start with credential-ready `options`
   - Create `selectedUnavailableModel` memo from `unavailableOptions`
   - If current `judgeModel` is not in options, add fallback entry with enriched label:
     - Unavailable model: `t('evaluators.dialog.model_no_credentials', { name })`
     - Unknown model: `t('evaluators.dialog.model_not_in_project', { model: judgeModel })`
4. **ST-1.4**: Update the default `judgeModel` state from `'claude-sonnet-4-6'` to `''`
5. **ST-1.5**: Update `resetForm()` to use empty string as default; also fix `useEffect` line 80 fallback from `'claude-sonnet-4-6'` to `''`
6. **ST-1.6**: Update the `<Select>` to use `judgeModelOptions` with `disabled={isLoading}` for loading state. Show `error` from hook as Select error prop when present.
7. **ST-1.7**: Add form validation — disable submit when `type === 'llm_judge' && !judgeModel` (update the `disabled` prop on submit button)
8. **ST-1.8**: Add i18n keys to `packages/i18n/locales/en/studio.json` under `evals.evaluators.dialog`:
   - `"model_no_credentials": "{name} (no credentials)"`
   - `"model_not_in_project": "{model} (not in project models)"`
   - Also add `"cancel": "Cancel"`, `"create": "Create"`, `"update": "Update"` to replace hardcoded English button labels
9. **ST-1.9**: Replace hardcoded "Cancel"/"Create"/"Update" button text with i18n keys
10. **ST-1.10**: Run prettier on changed files

**Note:** Dead i18n keys `evaluators.judge_model.*` (claude_opus, claude_sonnet, etc.) become unused after this change. They can be removed in a separate cleanup commit.

**Dependency note:** T-2 (prefix-match) must land before or with T-1. Old evaluators with short-name `judgeModel` values rely on T-2's prefix-match to resolve at runtime. Without T-2, they'd fail to resolve entirely.

### Acceptance Criteria

- AC-1: Evaluator dialog model dropdown shows tenant's actual models (not hardcoded list)
  - Verify: Create new evaluator → model dropdown shows real TenantModel records with display names
- AC-2: Selected `judgeModel` value matches `TenantModel.modelId` exactly
  - Verify: Create evaluator → inspect MongoDB `eval_evaluators` → `judgeModel` field matches a `TenantModel.modelId`
- AC-3: Editing an evaluator with an old short-name `judgeModel` shows fallback label
  - Verify: Edit evaluator that has `judgeModel: "claude-sonnet-4-6"` → dropdown shows it with "(not in project models)" suffix
- AC-4: Loading state shown while models are fetching
  - Verify: Open dialog → Select is disabled briefly while hook loads
- AC-5: Submit disabled when type is llm_judge but no model selected
  - Verify: Select "LLM Judge" type, leave model empty → Create button disabled

---

## Task T-2: Add Prefix-Match Fallback in Pipeline Tier 1 Resolver

### Files to Modify

- `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts` — Modify `resolveByModelId` function to try prefix match when exact match fails

### Function Signatures

Modified function (lines 109-124):

```ts
async function resolveByModelId(
  tenantId: string,
  modelId: string,
): Promise<Omit<ResolvedPipelineLLM, 'source'> | null> {
  const { TenantModel } = await import('@agent-platform/database/models');

  // 1. Exact match (current behavior)
  let tm = await TenantModel.findOne({
    tenantId,
    modelId,
    isActive: true,
    inferenceEnabled: true,
  });

  // 2. Dated suffix fallback — handles short names like "claude-sonnet-4-6"
  //    matching "claude-sonnet-4-6-20260217" without treating distinct
  //    variants like "gpt-4o-mini" as aliases for "gpt-4o".
  if (!tm) {
    // Escape regex special characters to prevent injection
    const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const datedSuffixPattern = `^${escaped}-(?:\\d{8}|\\d{4}-\\d{2}-\\d{2})$`;
    tm = await TenantModel.findOne({
      tenantId,
      modelId: { $regex: datedSuffixPattern },
      isActive: true,
      inferenceEnabled: true,
    })
      .sort({ modelId: -1 }) // Prefer latest dated version if multiple match
      .exec();

    if (tm) {
      log.info('Pipeline LLM resolved via prefix match', {
        tenantId,
        requestedModelId: modelId,
        resolvedModelId: tm.modelId,
      });
    }
  }

  if (!tm) return null;
  return resolveCredential(tm, tenantId);
}
```

**Design notes:**

- Regex requires an 8-digit or ISO date suffix so `claude-sonnet-4-6` matches `claude-sonnet-4-6-20260217` and `gpt-4o` matches `gpt-4o-2024-08-06`, but not `gpt-4o-mini`
- `.sort({ modelId: -1 })` ensures deterministic result when multiple dated versions exist (picks latest alphabetically = newest date suffix)
- `tm.modelId` accessed directly (no `as any` — Mongoose document is typed)
- This is a novel pattern not used elsewhere in the codebase. It serves as a bridge for legacy short-name values. Once all evaluators are re-saved via the dynamic picker (T-1), prefix-match traffic should go to zero.
- Pre-existing note: `resolveByProject` at line 136 queries `ModelConfig` without `tenantId` — known gap, out of scope for this fix.

### Subtasks (execution order)

1. **ST-2.1**: Add prefix-match fallback block after the existing exact-match query, with dated suffix constraint and `.sort({ modelId: -1 })`
2. **ST-2.2**: Ensure regex special characters in `modelId` are escaped to prevent ReDoS/injection
3. **ST-2.3**: Add info log when prefix match succeeds (track usage of legacy short names)
4. **ST-2.4**: Run prettier on changed file

### Acceptance Criteria

- AC-1: Exact match still works when modelId matches perfectly
  - Verify: `resolvePipelineLLM(tenant, project, "claude-sonnet-4-6-20260217")` returns the correct model
- AC-2: Prefix match resolves short names to dated versions
  - Verify: `resolvePipelineLLM(tenant, project, "claude-sonnet-4-6")` resolves to TenantModel with `modelId: "claude-sonnet-4-6-20260217"`
- AC-3: Dated suffix constraint prevents false matches
  - Verify: `resolvePipelineLLM(tenant, project, "claude-sonnet-4-6")` does NOT match `claude-sonnet-4-60-20261001`
- AC-3b: Sibling model variants are not treated as aliases
  - Verify: `resolvePipelineLLM(tenant, project, "gpt-4o")` does NOT match `gpt-4o-mini`
- AC-4: Regex injection is prevented
  - Verify: `resolvePipelineLLM(tenant, project, "claude.*")` does NOT match arbitrary models (special chars are escaped)
- AC-5: Multiple dated versions resolve deterministically to the latest
  - Verify: If tenant has both `claude-sonnet-4-6-20260217` and `claude-sonnet-4-6-20260401`, resolves to the latter
- AC-6: When no match at all, returns null (falls through to Tier 2/3 as before)

---

## Task T-3: Enhance Eval Preflight to Validate Evaluator Models

### Files to Modify

- `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts` — Add new check function, modify `runEvalPreflight` signature to accept evaluator model IDs
- `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts` — Pass evaluator judgeModels to preflight call

### Function Signatures

New check function in `eval-preflight.ts`:

```ts
/**
 * Validate that each evaluator's judgeModel resolves to a real LLM.
 * Returns one check per unique model — allows structured per-model failure reporting.
 */
async function checkEvaluatorModels(
  tenantId: string,
  projectId: string | undefined,
  evaluatorModels: string[],
): Promise<PreflightCheck[]>;
```

Modified `runEvalPreflight` signature:

```ts
export async function runEvalPreflight(
  tenantId: string,
  projectId?: string,
  options?: { evaluatorModels?: string[] },
): Promise<PreflightResult>;
```

Modified workflow call in `eval-run.workflow.ts` (line 221-223):

```ts
// BEFORE:
const preflightResult = await ctx.run('preflight', () => runEvalPreflight(tenantId, projectId));

// AFTER:
const judgeModels = evaluators.flatMap((e) =>
  e.type === 'llm_judge' && e.judgeModel ? [e.judgeModel] : [],
);
const preflightResult = await ctx.run('preflight', () =>
  runEvalPreflight(tenantId, projectId, { evaluatorModels: judgeModels }),
);
```

**Design notes:**

- `checkEvaluatorModels` returns `PreflightCheck[]` (one per unique model) rather than a single check, so the preflight result clearly shows which specific models failed
- Uses `.flatMap()` instead of `.filter().map()` with non-null assertion to avoid TypeScript `!` operator
- Backward compatible: `options` parameter is optional, existing callers unaffected
- When `evaluatorModels` is empty array or undefined, `checkEvaluatorModels` returns `[]` — no checks added
- Additional callers (`eval-preflight.service.ts:18` Restate wrapper, `server.ts:389` startup check) use the 2-arg form — backward compatible, no changes needed

### Subtasks (execution order)

1. **ST-3.1**: Add `checkEvaluatorModels` function — deduplicate model IDs, call `resolvePipelineLLM(tenantId, projectId, model, { allowFallbackOnExplicitModel: false })` for each unique model, return pass/fail check per model
2. **ST-3.2**: Modify `runEvalPreflight` to accept `options?: { evaluatorModels?: string[] }` and call `checkEvaluatorModels` when provided, spreading results into the checks array
3. **ST-3.3**: Modify the workflow to extract `judgeModel` values using `.flatMap()` and pass to preflight
4. **ST-3.4**: Run prettier on changed files

### Acceptance Criteria

- AC-1: Preflight catches unresolvable judge models before the run starts
  - Verify: Create evaluator with an unavailable `judgeModel` → run eval set → preflight fails with a clear sanitized model-configuration message
- AC-2: Preflight passes when all judge models resolve
  - Verify: Create evaluator with a valid `judgeModel` → run eval set → preflight passes
- AC-3: Backward compatible — `runEvalPreflight(tenantId, projectId)` still works without options
  - Verify: Existing callers without the third argument continue to work
- AC-4: Non-LLM evaluators (code_scorer, trajectory) are skipped in model validation
  - Verify: Eval set with only code_scorer evaluators → no model validation check runs
- AC-5: Multiple failing models are individually reported
  - Verify: Eval set with 2 evaluators using different invalid models → preflight shows 2 separate failing checks
