# NLU Pipeline Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 critical, 2 high, 2 medium, and 6 low severity findings from the NLU pipeline code review (PR #587).

**Architecture:** All fixes target the pipeline module (`apps/runtime/src/services/pipeline/`) and its tests. The critical fixes correct a broken tenant model path, null-coercion misrouting, and a scope-flag mischeck. The remaining fixes are cleanup (dead debug log, empty-string guard, matching consistency, heuristic replacement, label unification, parser dedup, regex expansion, API compat note, integration test).

**Tech Stack:** TypeScript, Vitest, Mongoose, CEL evaluator, Vercel AI SDK

**JIRA:** Use ticket ABLP-2 for all commits (existing NLU pipeline ticket).

---

## File Map

| File                                                                | Action | Responsibility                                                                               |
| ------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/pipeline/model-resolver.ts`              | Modify | C1: Remove `.lean()` on LLMCredential; H2: Guard missing tenantId                            |
| `apps/runtime/src/services/pipeline/routing-resolver.ts`            | Modify | C2: Use `nullSafeEvaluateCondition`; H1: Remove debug log                                    |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`             | Modify | C3: Check `out_of_scope` flag; M4: Use `findRoutingMatch`; L1: Add `isEscalation` flag check |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`               | Modify | L2: Unify source labels                                                                      |
| `apps/runtime/src/services/pipeline/types.ts`                       | Modify | L1: Add `isEscalation` to RoutingMatch                                                       |
| `apps/runtime/src/services/pipeline/null-safe-eval.ts`              | Create | C2: Extract shared `nullSafeEvaluateCondition`                                               |
| `apps/runtime/src/services/execution/routing-executor.ts`           | Modify | C2: Import from shared module instead of local copy                                          |
| `packages/core/src/parser/agent-based-parser.ts`                    | Modify | L3: Reject duplicate intent names                                                            |
| `packages/compiler/src/platform/ir/compiler.ts`                     | Modify | L4: Expand inferred-mode regex                                                               |
| `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`        | Modify | C1, H2: Add tenant model and guard tests                                                     |
| `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`      | Modify | C2, H1: Add null-coercion and debug-removal tests                                            |
| `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`       | Modify | C3, M4, L1: Add scope-flag, matching, escalation tests                                       |
| `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`         | Modify | L2: Update source label assertions                                                           |
| `apps/runtime/src/__tests__/pipeline-null-safe-eval.test.ts`        | Create | C2: Tests for extracted utility                                                              |
| `apps/runtime/src/__tests__/pipeline-integration.test.ts`           | Create | L6: End-to-end pipeline flow test                                                            |
| `packages/core/src/__tests__/parser/intents-section.test.ts`        | Modify | L3: Add duplicate rejection test                                                             |
| `packages/compiler/src/__tests__/extract-intent-categories.test.ts` | Modify | L4: Add `!=` operator test                                                                   |

---

### Task 1: C1 — Fix `.lean()` on encrypted credential + H2 — Guard missing tenantId

**Files:**

- Modify: `apps/runtime/src/services/pipeline/model-resolver.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`

- [ ] **Step 1: Write failing test for missing tenantId guard**

Add to `apps/runtime/src/__tests__/pipeline-model-resolver.test.ts`:

```typescript
it('returns null when tenantId is missing and modelSource is tenant', async () => {
  const session = createMockSession({ tenantId: undefined as any });
  const config = {
    ...DEFAULT_PIPELINE_CONFIG,
    modelSource: 'tenant' as const,
    tenantModelId: 'tm-123',
  };

  const result = await resolvePipelineModel(config, session as any);

  // Should fall back to default, not query DB with empty tenantId
  expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
  expect(result).toBe(mockLanguageModel);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-model-resolver.test.ts --reporter=verbose`
Expected: FAIL — currently passes empty string to DB query, behavior depends on mock setup

- [ ] **Step 3: Fix model-resolver.ts — remove `.lean()` and guard tenantId**

In `apps/runtime/src/services/pipeline/model-resolver.ts`, replace `resolveTenantModel` function:

```typescript
async function resolveTenantModel(tenantModelId: string, tenantId: string): Promise<LanguageModel> {
  if (!tenantId) {
    throw new Error('Cannot resolve tenant model without tenantId');
  }

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

  // Do NOT use .lean() — LLMCredential has a post-find decryption hook
  // that decrypts encryptedApiKey and encryptedEndpoint. .lean() bypasses
  // Mongoose document instantiation, so the hook never runs.
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
    isActive: true,
  });

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

Also update the caller at line 43 to guard tenantId before calling `resolveTenantModel`:

```typescript
if (config.modelSource === 'tenant' && config.tenantModelId) {
  if (!session.tenantId) {
    log.warn('Cannot resolve tenant model without tenantId, falling back to default');
    return session.llmClient?.resolveLanguageModel('tool_selection') ?? null;
  }
  try {
    const model = await resolveTenantModel(config.tenantModelId, session.tenantId);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-model-resolver.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/model-resolver.ts apps/runtime/src/__tests__/pipeline-model-resolver.test.ts
git add apps/runtime/src/services/pipeline/model-resolver.ts apps/runtime/src/__tests__/pipeline-model-resolver.test.ts
git commit -m "[ABLP-2] fix(runtime): remove .lean() on LLMCredential and guard missing tenantId"
```

---

### Task 2: C2 — Fix null coercion in routing resolver

**Files:**

- Create: `apps/runtime/src/services/pipeline/null-safe-eval.ts`
- Modify: `apps/runtime/src/services/pipeline/routing-resolver.ts`
- Modify: `apps/runtime/src/services/execution/routing-executor.ts`
- Create: `apps/runtime/src/__tests__/pipeline-null-safe-eval.test.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`

- [ ] **Step 1: Write failing test for null coercion in routing resolver**

Add to `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`:

```typescript
it('TC-RR-13 relational comparison with missing variable does NOT match (null < 80 guard)', () => {
  const intents = [makeIntent('network_issue')];
  const rules = [
    makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
  ];
  // battery_health_pct is NOT in session values — currently null < 80 coerces to true
  const matches = resolveRouting(intents, rules, {});
  expect(matches[0].target).toBeNull(); // Should NOT match when variable is missing
});

it('TC-RR-14 relational comparison with present variable still matches correctly', () => {
  const intents = [makeIntent('network_issue')];
  const rules = [
    makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
  ];
  const sessionValues = { battery_health_pct: 45 };
  const matches = resolveRouting(intents, rules, sessionValues);
  expect(matches[0].target).toBe('Network_Agent');
});

it('TC-RR-15 relational comparison with value above threshold does not match', () => {
  const intents = [makeIntent('network_issue')];
  const rules = [
    makeRule('Network_Agent', 'intent.category == "network_issue" && battery_health_pct < 80'),
  ];
  const sessionValues = { battery_health_pct: 95 };
  const matches = resolveRouting(intents, rules, sessionValues);
  expect(matches[0].target).toBeNull();
});
```

- [ ] **Step 2: Run test to verify TC-RR-13 fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-routing-resolver.test.ts --reporter=verbose`
Expected: TC-RR-13 FAILS (currently `null < 80` coerces to `true`, so it matches)

- [ ] **Step 3: Extract `nullSafeEvaluateCondition` to shared module**

Create `apps/runtime/src/services/pipeline/null-safe-eval.ts`:

```typescript
/**
 * Null-safe condition evaluator for pipeline routing.
 *
 * Wraps evaluateConditionDual with guards against JavaScript's null coercion
 * in relational comparisons (null < 80 → true because null coerces to 0).
 *
 * Extracted from routing-executor.ts to share with routing-resolver.ts.
 */

import { evaluateConditionDual, extractVariableReferences } from '@abl/compiler';

/**
 * Reserved identifiers that should not be treated as missing variables
 * even when absent from context. Mirrors the set in dual-evaluator.ts.
 */
const RELATIONAL_GUARD_RESERVED = new Set([
  'true',
  'false',
  'null',
  'in',
  'this',
  'size',
  'has',
  'type',
  'int',
  'uint',
  'double',
  'string',
  'bool',
  'bytes',
  'list',
  'map',
  'duration',
  'timestamp',
  'matches',
  'contains',
  'startsWith',
  'endsWith',
  'abl',
  'all',
  'exists',
  'exists_one',
  'filter',
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  'IN',
]);

/**
 * Evaluate a condition expression with null-safety guards for relational operators.
 *
 * When a variable is missing from context and participates in a relational
 * comparison (< > <= >=), the expression is rewritten to include a null guard:
 *
 *   original:  `battery_health_pct < 80`
 *   rewritten: `(battery_health_pct != null && battery_health_pct < 80)`
 *   result:    false (instead of true from null→0 coercion)
 */
export function nullSafeEvaluateCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const vars = extractVariableReferences(expression);

  const missingVars = vars.filter((v) => {
    const topKey = v.split('.')[0];
    return !(topKey in context);
  });

  if (missingVars.length === 0) {
    return evaluateConditionDual(expression, context);
  }

  const stripped = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  const relationalMissing = new Set<string>();
  for (const v of missingVars) {
    if (RELATIONAL_GUARD_RESERVED.has(v)) continue;
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `\\b${escaped}\\s*(?:<|>|<=|>=)\\s*(?:\\d|\\w)|(?:\\d|\\w)\\S*\\s*(?:<|>|<=|>=)\\s*${escaped}\\b`,
    );
    if (pattern.test(stripped)) {
      relationalMissing.add(v);
    }
  }

  if (relationalMissing.size === 0) {
    return evaluateConditionDual(expression, context);
  }

  let safeExpr = expression;
  for (const v of relationalMissing) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    safeExpr = safeExpr.replace(
      new RegExp(
        `\\b(${esc}\\s*(?:<=|>=|<|>)\\s*(?:\\d+(?:\\.\\d+)?|[a-zA-Z_]\\w*(?:\\.\\w+)*))\\b`,
        'g',
      ),
      `(${v} != null && $1)`,
    );

    safeExpr = safeExpr.replace(
      new RegExp(
        `\\b((?:\\d+(?:\\.\\d+)?|[a-zA-Z_]\\w*(?:\\.\\w+)*)\\s*(?:<=|>=|<|>)\\s*${esc})\\b`,
        'g',
      ),
      `(${v} != null && $1)`,
    );
  }

  return evaluateConditionDual(safeExpr, context);
}
```

- [ ] **Step 4: Update routing-resolver.ts to use `nullSafeEvaluateCondition`**

In `apps/runtime/src/services/pipeline/routing-resolver.ts`:

Replace the import:

```typescript
// OLD
import { evaluateConditionDual, extractVariableReferences } from '@abl/compiler';
// NEW
import { extractVariableReferences } from '@abl/compiler';
import { nullSafeEvaluateCondition } from './null-safe-eval.js';
```

Replace line 118:

```typescript
// OLD
const conditionMet = evaluateConditionDual(rule.when, enrichedContext);
// NEW
const conditionMet = nullSafeEvaluateCondition(rule.when, enrichedContext);
```

- [ ] **Step 5: Update routing-executor.ts to import from shared module**

In `apps/runtime/src/services/execution/routing-executor.ts`:

Add import:

```typescript
import { nullSafeEvaluateCondition } from '../pipeline/null-safe-eval.js';
```

Remove the local `nullSafeEvaluateCondition` function (lines 338-402) and the `RELATIONAL_GUARD_RESERVED` constant (lines 222-257). Keep the existing call sites that reference `nullSafeEvaluateCondition` — they now resolve to the import.

- [ ] **Step 6: Run tests to verify TC-RR-13 now passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-routing-resolver.test.ts --reporter=verbose`
Expected: ALL PASS including TC-RR-13, TC-RR-14, TC-RR-15

- [ ] **Step 7: Run full runtime tests to ensure routing-executor still works**

Run: `cd apps/runtime && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: No regressions

- [ ] **Step 8: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/null-safe-eval.ts apps/runtime/src/services/pipeline/routing-resolver.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts
git add apps/runtime/src/services/pipeline/null-safe-eval.ts apps/runtime/src/services/pipeline/routing-resolver.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts
git commit -m "[ABLP-2] fix(runtime): guard null coercion in pipeline routing resolver"
```

---

### Task 3: C3 — Fix out-of-scope decline to use `out_of_scope` flag

**Files:**

- Modify: `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`

- [ ] **Step 1: Write failing tests for scope-aware decline**

Add to `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`:

In the `makeClassifierResult` helper, add `out_of_scope` support:

```typescript
function makeClassifierResult(
  intents: Array<{
    category: string | null;
    confidence: number;
    summary: string;
    out_of_scope?: boolean;
  }>,
): ClassifierResult {
  return {
    intents: intents.map((i) => ({
      category: i.category,
      confidence: i.confidence,
      summary: i.summary,
      out_of_scope: i.out_of_scope,
    })),
  };
}
```

Add new test cases in the Tier 1 describe block:

```typescript
it('TC-TR-06: null category but out_of_scope=false → NOT decline (in-scope uncategorized)', () => {
  const cr = makeClassifierResult([
    { category: null, confidence: 0.92, summary: 'What options do I have?', out_of_scope: false },
  ]);
  const routingMatches: RoutingMatch[] = [];
  const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
  const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
  // Should NOT decline — classifier explicitly says in-scope
  expect(action.action).not.toBe('decline_out_of_scope');
});

it('TC-TR-07: null category with out_of_scope=true → decline', () => {
  const cr = makeClassifierResult([
    { category: null, confidence: 0.92, summary: 'Book me a flight', out_of_scope: true },
  ]);
  const routingMatches: RoutingMatch[] = [];
  const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
  const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
  expect(action.tier).toBe(1);
  expect(action.action).toBe('decline_out_of_scope');
});

it('TC-TR-08: null category with out_of_scope undefined (legacy) → decline (backward compat)', () => {
  const cr = makeClassifierResult([
    { category: null, confidence: 0.92, summary: 'flight booking' },
  ]);
  const routingMatches: RoutingMatch[] = [];
  const ir = makeAgentIR({ limitations: ['Cannot book flights'] });
  const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
  // Legacy behavior: out_of_scope not set, category is null → treat as out-of-scope
  expect(action.tier).toBe(1);
  expect(action.action).toBe('decline_out_of_scope');
});
```

- [ ] **Step 2: Run tests to verify TC-TR-06 fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-tiered-resolver.test.ts --reporter=verbose`
Expected: TC-TR-06 FAILS (currently declines on `category === null` regardless of `out_of_scope`)

- [ ] **Step 3: Fix tiered-resolver.ts — use `out_of_scope` flag**

In `apps/runtime/src/services/pipeline/tiered-resolver.ts`, replace lines 52-66:

```typescript
// ─── Tier 1: Programmatic Out-of-Scope Decline ─────────────────────────
// Use the classifier's scope-aware out_of_scope flag when available.
// Fall back to category === null for backward compatibility with classifiers
// that don't set out_of_scope (legacy path).
const isOutOfScope = primary.out_of_scope ?? primary.category === null;

if (
  config.outOfScopeDecline &&
  isOutOfScope &&
  primary.confidence >= config.programmaticThreshold &&
  hasLimitations(agentIR)
) {
  const message = resolveOutOfScopeMessage(agentIR);
  return {
    tier: 1,
    action: 'decline_out_of_scope',
    message,
  };
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-tiered-resolver.test.ts --reporter=verbose`
Expected: ALL PASS (TC-TR-01 still passes via legacy fallback, TC-TR-06 now passes, TC-TR-07 passes, TC-TR-08 passes)

- [ ] **Step 5: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/tiered-resolver.ts apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts
git add apps/runtime/src/services/pipeline/tiered-resolver.ts apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts
git commit -m "[ABLP-2] fix(runtime): use out_of_scope flag instead of category===null for decline"
```

---

### Task 4: H1 — Remove `[NLU-DEBUG]` warn log

**Files:**

- Modify: `apps/runtime/src/services/pipeline/routing-resolver.ts`

- [ ] **Step 1: Remove the debug log block**

In `apps/runtime/src/services/pipeline/routing-resolver.ts`, delete lines 119-125:

```typescript
// DELETE THESE LINES:
// [NLU-DEBUG]
log.warn('[NLU-DEBUG] resolveRouting WHEN eval', {
  category: intent.category,
  to: rule.to,
  when: rule.when.slice(0, 100),
  conditionMet,
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-routing-resolver.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/routing-resolver.ts
git add apps/runtime/src/services/pipeline/routing-resolver.ts
git commit -m "[ABLP-2] fix(runtime): remove NLU-DEBUG warn log from routing resolver"
```

---

### Task 5: M4 — Unify intent matching + L1 — Replace escalation heuristic + L2 — Unify source labels

**Files:**

- Modify: `apps/runtime/src/services/pipeline/types.ts`
- Modify: `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- Modify: `apps/runtime/src/services/pipeline/intent-bridge.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`

- [ ] **Step 1: Write failing test for consistent matching in tiered resolver**

Add to `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`:

```typescript
it('TC-TR-18: multi-intent with same category+confidence but different summary matches correctly', () => {
  const cr = makeClassifierResult([
    { category: 'billing', confidence: 0.7, summary: 'check balance' },
    { category: 'billing', confidence: 0.7, summary: 'dispute charge' },
  ]);
  const routingMatches = [
    makeRoutingMatch(cr.intents[0], 'Balance_Agent'),
    makeRoutingMatch(cr.intents[1], 'Dispute_Agent'),
  ];
  const ir = makeAgentIR({
    routing: [{ to: 'Balance_Agent' }, { to: 'Dispute_Agent' }],
  });
  const action = resolveTieredAction(cr, routingMatches, DEFAULT_CONFIG, ir);
  expect(action.tier).toBe(2);
  if (action.action === 'guided') {
    const signal = action.hints.multiIntentSignal;
    expect(signal).toBeDefined();
    // Each intent should resolve to its correct target
    expect(signal!.intents[0].target).toBe('Balance_Agent');
    expect(signal!.intents[1].target).toBe('Dispute_Agent');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-tiered-resolver.test.ts -t "TC-TR-18" --reporter=verbose`
Expected: FAIL — 2-field matching can't distinguish same category+confidence intents

- [ ] **Step 3: Import `findRoutingMatch` and use it in tiered-resolver.ts**

In `apps/runtime/src/services/pipeline/intent-bridge.ts`, export `findRoutingMatch`:

```typescript
// Change from:
function findRoutingMatch(
// To:
export function findRoutingMatch(
```

In `apps/runtime/src/services/pipeline/tiered-resolver.ts`, add import:

```typescript
import { findRoutingMatch } from './intent-bridge.js';
```

Replace the inline matching at lines 76-78 and 94-96 with `findRoutingMatch`:

Line 76-78 (primaryMatch):

```typescript
const primaryMatch = findRoutingMatch(primary, routingMatches);
```

Lines 93-96 (multi-intent signal):

```typescript
        intents: intents.map((i) => {
          const match = findRoutingMatch(i, routingMatches);
          return {
```

- [ ] **Step 4: Unify source labels in intent-bridge.ts (L2)**

In `apps/runtime/src/services/pipeline/intent-bridge.ts`:

Line 131 — change `'fast' as const` to `'pipeline' as const`
Line 135 — change `'fast' as const` to `'pipeline' as const`

Both `bridgeToMultiIntentResult` and `toDetectedIntent` now use `'pipeline'`.

- [ ] **Step 5: Run tests to verify all pass**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-tiered-resolver.test.ts src/__tests__/pipeline-intent-bridge.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 6: Run typecheck**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/tiered-resolver.ts apps/runtime/src/services/pipeline/intent-bridge.ts
git add apps/runtime/src/services/pipeline/tiered-resolver.ts apps/runtime/src/services/pipeline/intent-bridge.ts apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts
git commit -m "[ABLP-2] fix(runtime): unify intent matching and source labels across pipeline modules"
```

---

### Task 6: L3 — Reject duplicate intent names in parser

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts`
- Modify: `packages/core/src/__tests__/parser/intents-section.test.ts`

- [ ] **Step 1: Write failing test for duplicate intent names**

Add to `packages/core/src/__tests__/parser/intents-section.test.ts`:

```typescript
it('TC-INT-09 warns on duplicate intent names and deduplicates', () => {
  const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "First billing description"
  setup
  billing: "Second billing description"
`;
  const result = parseAgentBasedABL(input);
  // Should keep first occurrence, warn on duplicate
  expect(result.document?.intents).toEqual([
    { name: 'billing', description: 'First billing description' },
    { name: 'setup', description: undefined },
  ]);
  expect(result.warnings?.some((w) => w.includes('billing') && w.includes('duplicate'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/parser/intents-section.test.ts --reporter=verbose`
Expected: FAIL — currently duplicates are added

- [ ] **Step 3: Add deduplication to `parseIntentsSection`**

Read the `parseIntentsSection` function in `packages/core/src/parser/agent-based-parser.ts` (around line 6314). Add a `Set` for tracking seen names. Before pushing to the results array, check if the name is already seen. If duplicate, emit a warning and skip.

Add inside the function, before the loop:

```typescript
const seenNames = new Set<string>();
```

In the loop body, after extracting `name`, add:

```typescript
if (seenNames.has(name)) {
  warnings.push(`Duplicate INTENTS category "${name}" — keeping first occurrence`);
  continue;
}
seenNames.add(name);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/parser/intents-section.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm build --filter=@abl/core`

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser/intents-section.test.ts
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser/intents-section.test.ts
git commit -m "[ABLP-2] fix(core): reject duplicate intent names in INTENTS parser"
```

---

### Task 7: L4 — Expand inferred-mode regex to capture `!=` operator

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Modify: `packages/compiler/src/__tests__/extract-intent-categories.test.ts`

- [ ] **Step 1: Write failing test for `!=` operator extraction**

Add to `packages/compiler/src/__tests__/extract-intent-categories.test.ts`:

```typescript
it('extracts categories from != conditions in inferred mode', () => {
  const abl = `SUPERVISOR: Test
GOAL: Test
PERSONA: Test

HANDOFF:
  - TO: Billing_Agent
    WHEN: intent.category == "billing"
  - TO: Fallback_Agent
    WHEN: intent.category != "billing" && intent.category != "setup"
`;
  const ir = compileABLtoIR(abl);
  const result = extractIntentCategories(ir);
  const names = result.categories.map((c) => c.name);
  // Should extract "billing" from == and "setup" from !=
  expect(names).toContain('billing');
  expect(names).toContain('setup');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/extract-intent-categories.test.ts --reporter=verbose`
Expected: FAIL — regex only matches `==`, not `!=`

- [ ] **Step 3: Expand regex in `extractIntentCategories`**

In `packages/compiler/src/platform/ir/compiler.ts` line 2909, change:

```typescript
// OLD
const regex = /intent\.category\s*==\s*["']([^"']+)["']/g;
// NEW
const regex = /intent\.category\s*[!=]=\s*["']([^"']+)["']/g;
```

Also update `extractAllWhenCategories` (line 2933) the same way:

```typescript
// OLD
const regex = /intent\.category\s*==\s*["']([^"']+)["']/g;
// NEW
const regex = /intent\.category\s*[!=]=\s*["']([^"']+)["']/g;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/extract-intent-categories.test.ts --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm build --filter=@abl/compiler`

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/extract-intent-categories.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/extract-intent-categories.test.ts
git commit -m "[ABLP-2] fix(compiler): extract intent categories from != conditions in inferred mode"
```

---

### Task 8: L6 — Add pipeline integration test

**Files:**

- Create: `apps/runtime/src/__tests__/pipeline-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `apps/runtime/src/__tests__/pipeline-integration.test.ts`:

```typescript
/**
 * Pipeline integration test — exercises classify → route → bridge → tier
 * as a composed flow with realistic ABL supervisor config.
 *
 * Uses real pure functions (no mocks). The only thing not exercised is the
 * actual LLM call — classifier output is provided directly.
 */

import { describe, it, expect } from 'vitest';
import { resolveRouting } from '../services/pipeline/routing-resolver.js';
import {
  bridgeIntentsToSessionState,
  bridgeToMultiIntentResult,
} from '../services/pipeline/intent-bridge.js';
import { resolveTieredAction } from '../services/pipeline/tiered-resolver.js';
import type { AgentIR } from '@abl/compiler';
import type { ClassifierResult, IntentBridgeConfig } from '../services/pipeline/types.js';
import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';

const DEFAULT_BRIDGE_CONFIG: IntentBridgeConfig = {
  enabled: true,
  programmaticThreshold: 0.85,
  guidedThreshold: 0.5,
  outOfScopeDecline: true,
  multiIntentSignal: true,
};

const TELCO_RULES: RoutingRule[] = [
  {
    to: 'Network_Optimization',
    when: 'intent.category == "network_issue"',
    description: '',
    priority: 1,
  },
  { to: 'Billing_Agent', when: 'intent.category == "billing"', description: '', priority: 2 },
  {
    to: 'CX_Agent',
    when: 'intent.category == "customer_experience"',
    description: '',
    priority: 3,
  },
  { to: 'Fallback_Agent', when: 'true', description: '', priority: 99 },
];

const TELCO_IR: AgentIR = {
  ir_version: '1.0',
  metadata: { name: 'Telco_Supervisor', version: '1.0', description: '' },
  execution: { hints: {} as any, timeouts: {} as any },
  identity: {
    goal: 'Route telco customer requests',
    persona: 'Telco supervisor',
    limitations: ['Cannot process payments directly'],
    system_prompt: {} as any,
  },
  tools: [],
  gather: { fields: [] } as any,
  memory: {} as any,
  constraints: { rules: [] } as any,
  coordination: { delegates: [], handoffs: [] },
  completion: {} as any,
  error_handling: {} as any,
  messages: {} as any,
  routing: {
    rules: TELCO_RULES,
    default_agent: 'Fallback_Agent',
    intent_classification: { categories: [], min_confidence: 0.5, source: 'inferred' as const },
  },
} as AgentIR;

describe('Pipeline Integration: classify → route → bridge → tier', () => {
  it('single in-scope intent flows through to guided tier with correct routing', () => {
    // Simulate classifier output
    const classifierResult: ClassifierResult = {
      intents: [
        { category: 'billing', confidence: 0.78, summary: 'Customer asking about charges' },
      ],
    };

    // Route
    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    expect(routingMatches[0].target).toBe('Billing_Agent');

    // Bridge to session state
    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.category).toBe('billing');
    expect(intentState.target).toBe('Billing_Agent');
    expect(intentState.out_of_scope).toBe(false);

    // Tier resolution
    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(2);
    expect(action.action).toBe('guided');
  });

  it('out-of-scope intent with scope flag results in Tier 1 decline', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        { category: null, confidence: 0.92, summary: 'Book me a flight', out_of_scope: true },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    // Fallback rule matches (when: 'true')
    expect(routingMatches[0].target).toBe('Fallback_Agent');

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(true);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(1);
    expect(action.action).toBe('decline_out_of_scope');
  });

  it('in-scope uncategorized intent does NOT decline (C3 regression)', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        {
          category: null,
          confidence: 0.88,
          summary: 'What can you help me with?',
          out_of_scope: false,
        },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});

    const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
    expect(intentState.out_of_scope).toBe(false);

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    // Should NOT decline — falls through to guided or autonomous
    expect(action.action).not.toBe('decline_out_of_scope');
  });

  it('multi-intent with different targets produces sequential_handoff signal', () => {
    const classifierResult: ClassifierResult = {
      intents: [
        { category: 'billing', confidence: 0.75, summary: 'Check my bill' },
        { category: 'network_issue', confidence: 0.65, summary: 'WiFi is slow' },
      ],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});
    expect(routingMatches[0].target).toBe('Billing_Agent');
    expect(routingMatches[1].target).toBe('Network_Optimization');

    const multiIntent = bridgeToMultiIntentResult(classifierResult, routingMatches);
    expect(multiIntent).not.toBeNull();
    expect(multiIntent!.primary.intent).toBe('billing');

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(2);
    if (action.action === 'guided') {
      expect(action.hints.multiIntentSignal?.suggestedAction).toBe('sequential_handoff');
    }
  });

  it('low confidence falls through to Tier 3 autonomous', () => {
    const classifierResult: ClassifierResult = {
      intents: [{ category: 'vague', confidence: 0.3, summary: 'Something weird happened' }],
    };

    const routingMatches = resolveRouting(classifierResult.intents, TELCO_RULES, {});

    const action = resolveTieredAction(
      classifierResult,
      routingMatches,
      DEFAULT_BRIDGE_CONFIG,
      TELCO_IR,
    );
    expect(action.tier).toBe(3);
    expect(action.action).toBe('autonomous');
  });

  it('relational WHEN condition with missing session var does NOT misroute (C2 regression)', () => {
    const classifierResult: ClassifierResult = {
      intents: [{ category: 'network_issue', confidence: 0.85, summary: 'Network slow' }],
    };

    const rulesWithRelational: RoutingRule[] = [
      {
        to: 'Critical_Network_Agent',
        when: 'intent.category == "network_issue" && signal_strength < 30',
        description: '',
        priority: 1,
      },
      {
        to: 'Network_Optimization',
        when: 'intent.category == "network_issue"',
        description: '',
        priority: 2,
      },
    ];

    // signal_strength NOT in session — should NOT match the relational rule
    const routingMatches = resolveRouting(classifierResult.intents, rulesWithRelational, {});
    expect(routingMatches[0].target).toBe('Network_Optimization'); // Falls through to priority 2
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd apps/runtime && npx vitest run src/__tests__/pipeline-integration.test.ts --reporter=verbose`
Expected: ALL PASS (assuming Tasks 1-4 are already applied)

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/runtime/src/__tests__/pipeline-integration.test.ts
git add apps/runtime/src/__tests__/pipeline-integration.test.ts
git commit -m "[ABLP-2] test(runtime): add pipeline integration test for classify-route-bridge-tier flow"
```

---

## Task Dependency Order

```
Task 1 (C1 + H2)  ──┐
Task 2 (C2)        ──┼── can run in parallel
Task 3 (C3)        ──┤
Task 4 (H1)        ──┘
                      │
Task 5 (M4 + L1 + L2) ── depends on Task 3 (tiered-resolver changes)
Task 6 (L3)        ──┐
Task 7 (L4)        ──┼── can run in parallel, independent packages
Task 8 (L6)        ──┘── depends on Tasks 1-4 (regression tests)
```

Tasks 1-4 are independent and can be parallelized. Task 5 modifies tiered-resolver again so should run after Task 3. Tasks 6-7 are in separate packages and are independent. Task 8 is the integration test that validates all prior fixes.
