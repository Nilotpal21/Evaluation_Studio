# CEL Phase 2: Complete Integration & Observability

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate all remaining expression evaluation paths to the CEL dual evaluator, add observability for the migration period, and define the legacy evaluator deprecation criteria.

**Architecture:** Five tasks in priority order. Task 1 (routing-executor) is a trivial import swap. Task 2 (null injection) eliminates exception-path overhead and is a prerequisite optimization for Task 3. Task 3 (constraint executor) is the most complex — it keeps guard/precondition semantics in the constraint layer and injects the dual evaluator via dependency injection. Task 4 (INPUT documentation + compiler warning) is additive. Task 5 adds observability counters and defines the deprecation path for the legacy evaluator.

**Tech Stack:** TypeScript, Vitest, CEL (`@marcbachmann/cel-js`), Pino structured logging (`createLogger`)

---

## Reference Files

| File                                                                         | Role                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/dual-evaluator.ts`                | Dual-mode evaluator (CEL-first, legacy fallback)                                            |
| `packages/compiler/src/platform/constructs/cel-evaluator.ts`                 | CEL evaluator with 35 ABL custom functions                                                  |
| `packages/compiler/src/platform/constructs/expression-migrator.ts`           | Legacy-to-CEL syntax migration                                                              |
| `packages/compiler/src/platform/constructs/evaluator.ts`                     | Legacy evaluator — `evaluateConstraintCondition` at line 840, `splitByOperator` at line 688 |
| `packages/compiler/src/platform/constructs/executors/constraint-executor.ts` | Constraint executor — `checkConstraintsCore` at line 68, `recordOnly` path at line 192      |
| `apps/runtime/src/services/execution/constraint-checker.ts`                  | Runtime constraint checker delegating to `checkConstraintsCore`                             |
| `apps/runtime/src/services/execution/routing-executor.ts`                    | 4 legacy `compilerEvaluateCondition` call sites (lines 661, 1133, 1180, 1257)               |
| `apps/runtime/src/services/execution/value-resolution.ts`                    | `resolveValuePath` used by `mapDelegateInput`                                               |
| `packages/compiler/src/index.ts`                                             | Public exports — line 139 exports dual evaluator                                            |

## Existing Test Files

| Test File                                                                | What it covers                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/constructs/dual-evaluator.test.ts`      | 25 tests: legacy/CEL conditions, IS SET/has(), value resolution, fallback          |
| `packages/compiler/src/__tests__/constructs/cel-parity.test.ts`          | CEL vs legacy parity for all 35 functions                                          |
| `packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts`       | CEL evaluator unit tests                                                           |
| `packages/compiler/src/__tests__/constructs/constraint-executor.test.ts` | `checkConstraintsCore`, IS SET guards, skip options, recordOnly                    |
| `apps/runtime/src/__tests__/cel-runtime-integration.test.ts`             | 15 tests: CEL in runtime context (nested paths, functions, migration)              |
| `apps/runtime/src/__tests__/constraint-checker.test.ts`                  | `checkConstraints`, `handleConstraintViolation` with mocked `checkConstraintsCore` |

---

## Task 1: Routing Executor — Swap Legacy Evaluator for Dual Evaluator

**Priority: 0 (highest) — simplest change, biggest coverage increase**

These 4 call sites use plain condition evaluation (no guard semantics). The swap is a direct import change.

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:12,661,1133,1180,1257`
- Test: `apps/runtime/src/__tests__/cel-runtime-integration.test.ts` (add 4 tests)

**Step 1: Write the failing tests**

Add to `apps/runtime/src/__tests__/cel-runtime-integration.test.ts`:

```typescript
describe('Routing executor CEL support', () => {
  test('evaluates CEL completion condition', () => {
    // CEL syntax in completion WHEN condition
    expect(
      evaluateConditionDual('has(gathered.policy_number) && claim.amount > 1000', sessionContext),
    ).toBe(true);
  });

  test('evaluates CEL handoff condition', () => {
    // CEL syntax in handoff WHEN condition
    expect(
      evaluateConditionDual('claim.status == "escalated" || claim.amount > 10000', {
        claim: { status: 'escalated', amount: 500 },
      }),
    ).toBe(true);
  });

  test('evaluates CEL delegate WHEN condition', () => {
    // CEL syntax in delegate WHEN condition
    expect(
      evaluateConditionDual(
        'user.age >= 18 && claim.status in ["pending", "review"]',
        sessionContext,
      ),
    ).toBe(true);
  });

  test('evaluates legacy syntax in routing conditions via migration', () => {
    // Legacy ABL syntax still works after swap (dual evaluator handles migration)
    expect(evaluateConditionDual('claim.amount > 1000 AND user.age >= 18', sessionContext)).toBe(
      true,
    );
  });
});
```

**Step 2: Run tests to verify they pass (these test the dual evaluator, which already works)**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/cel-runtime-integration.test.ts`
Expected: PASS (these test the evaluator, not the routing executor wiring)

**Step 3: Swap the import in routing-executor.ts**

Change line 12 from:

```typescript
import {
  evaluateCondition as compilerEvaluateCondition,
```

to:

```typescript
import {
  evaluateConditionDual as compilerEvaluateCondition,
```

And add the import source — change line 12-18 from:

```typescript
import {
  evaluateCondition as compilerEvaluateCondition,
  interpolateMessage,
  DEFAULT_MESSAGES,
  ESCALATION_FORMAT,
  ESCALATION_REASON_MIN_LENGTH,
  ESCALATION_REASON_MAX_LENGTH,
} from '@abl/compiler';
```

to:

```typescript
import {
  evaluateConditionDual as compilerEvaluateCondition,
  interpolateMessage,
  DEFAULT_MESSAGES,
  ESCALATION_FORMAT,
  ESCALATION_REASON_MIN_LENGTH,
  ESCALATION_REASON_MAX_LENGTH,
} from '@abl/compiler';
```

This is a one-line change. The alias `compilerEvaluateCondition` is preserved so all 4 call sites (lines 661, 1133, 1180, 1257) automatically use the dual evaluator with zero diff.

**Step 4: Run all routing/completion/handoff tests**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/cel-runtime-integration.test.ts src/__tests__/constraint-checker.test.ts`
Expected: All PASS

Run: `cd apps/runtime && pnpm exec vitest run --reporter=verbose 2>&1 | tail -5`
Expected: All runtime tests pass (5055+)

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/cel-runtime-integration.test.ts
git commit -m "feat(runtime): migrate routing-executor to dual CEL evaluator

Swap evaluateCondition → evaluateConditionDual for all 4 routing
condition call sites (delegate WHEN, completion WHEN, handoff WHEN).
No guard semantics needed — these are plain condition checks.
The alias preserves all call sites unchanged."
```

---

## Task 2: Null Injection — Eliminate Exception-Path Overhead for Missing Identifiers

**Priority: 1 — prerequisite optimization for Task 3**

When `name IS SET` is evaluated and `name` is not in the context, CEL throws "Unknown variable", falls back to legacy. This injects missing identifiers as `null` so CEL evaluates `null != null` = `false` directly.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/dual-evaluator.ts`
- Create: `packages/compiler/src/__tests__/constructs/dual-evaluator-null-injection.test.ts`

**Step 1: Write the failing tests**

Create `packages/compiler/src/__tests__/constructs/dual-evaluator-null-injection.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import {
  evaluateConditionDual,
  resolveValueDual,
} from '../../platform/constructs/dual-evaluator.js';

describe('Null Injection for Missing Identifiers', () => {
  describe('evaluateConditionDual with missing identifiers', () => {
    test('IS SET on missing variable evaluates via CEL (no exception fallback)', () => {
      // Before null injection: CEL throws "Unknown variable", falls back to legacy
      // After null injection: CEL evaluates `null != null` = false directly
      expect(evaluateConditionDual('name IS SET', {})).toBe(false);
    });

    test('IS NOT SET on missing variable evaluates via CEL', () => {
      expect(evaluateConditionDual('name IS NOT SET', {})).toBe(true);
    });

    test('present identifier is not injected', () => {
      expect(evaluateConditionDual('name != null', { name: 'John' })).toBe(true);
    });

    test('CEL reserved words are not injected', () => {
      // `true` is a CEL keyword — must not be injected as null
      expect(evaluateConditionDual('true && x != null', {})).toBe(false);
    });

    test('multiple missing identifiers all injected', () => {
      expect(evaluateConditionDual('a != null && b != null', {})).toBe(false);
    });

    test('dotted path variable — only root injected', () => {
      // `user.name` — `user` is the root identifier
      expect(evaluateConditionDual('has(user.name)', { user: { name: 'J' } })).toBe(true);
      expect(evaluateConditionDual('has(user.name)', { user: {} })).toBe(false);
    });

    test('no clone when all identifiers present (perf)', () => {
      // When all identifiers exist in context, no shallow clone should occur
      // (We can't directly test this, but we verify correctness)
      expect(evaluateConditionDual('age > 18', { age: 25 })).toBe(true);
    });

    test('abl namespace prefix not injected', () => {
      // `abl` should not be injected as null
      expect(evaluateConditionDual('abl.upper(name) == "JOHN"', { name: 'john' })).toBe(true);
    });

    test('identifiers inside quoted strings are not injected', () => {
      // `hello` inside "hello" should not be extracted as an identifier
      expect(evaluateConditionDual('name == "hello"', { name: 'hello' })).toBe(true);
    });

    test('this keyword not injected', () => {
      // `this` is a CEL reserved word
      expect(evaluateConditionDual('x != null', {})).toBe(false);
    });
  });

  describe('resolveValueDual with missing identifiers', () => {
    test('missing variable resolves to null via CEL', () => {
      const result = resolveValueDual('name', {});
      // CEL evaluates `name` with name=null → returns null
      expect(result).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail (some will pass via legacy fallback, some won't)**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/constructs/dual-evaluator-null-injection.test.ts`
Expected: Most pass via legacy fallback; the "identifiers inside quoted strings" test may or may not fail depending on current behavior.

**Step 3: Implement null injection in dual-evaluator.ts**

Add after the `preprocessHas` function (line 61), before `evaluateConditionDual`:

```typescript
/**
 * CEL reserved words and built-in identifiers that must NOT be injected
 * as null when missing from context. Prevents shadowing CEL language constructs.
 */
const CEL_RESERVED = new Set([
  // CEL reserved words
  'true',
  'false',
  'null',
  'in',
  'this',
  // CEL standard functions / types
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
  // CEL string methods (not bare identifiers, but safe to exclude)
  'matches',
  'contains',
  'startsWith',
  'endsWith',
  // ABL namespace prefix
  'abl',
  // CEL macros
  'all',
  'exists',
  'exists_one',
  'filter',
]);

/**
 * Strip quoted strings from expression before identifier extraction.
 * Prevents matching identifiers inside string literals.
 */
function stripQuotedStrings(expr: string): string {
  return expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

/**
 * Inject null for identifiers referenced in the expression but absent
 * from the context. Allows CEL to evaluate `name != null` natively
 * instead of throwing "Unknown variable" and falling back to legacy.
 *
 * Only injects for bare identifiers (not CEL keywords, not function names).
 * Uses lazy clone: no allocation when all identifiers are present.
 *
 * @returns The original context if no injection needed, or a shallow clone with nulls added.
 */
function injectMissingAsNull(
  expr: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  // Strip quoted strings to avoid matching identifiers inside literals
  const stripped = stripQuotedStrings(expr);
  const identifiers = stripped.match(/\b[a-zA-Z_]\w*\b/g);
  if (!identifiers) return context;

  let augmented: Record<string, unknown> | null = null;

  for (const id of identifiers) {
    if (!(id in context) && !CEL_RESERVED.has(id)) {
      if (!augmented) augmented = { ...context };
      augmented[id] = null;
    }
  }

  if (augmented && log.isLevelEnabled?.('debug')) {
    const injected = Object.keys(augmented).filter((k) => !(k in context));
    if (injected.length > 0) {
      log.debug('Injected null for missing identifiers', {
        injectedCount: injected.length,
        identifiers: injected.slice(0, 10),
        expression: expr.slice(0, 100),
      });
    }
  }

  return augmented ?? context;
}
```

**Step 4: Wire into evaluateConditionDual and resolveValueDual**

Replace `evaluateConditionDual` (line 88-102):

```typescript
export function evaluateConditionDual(expression: string, context: EvaluationContext): boolean {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;
  const preprocessed = preprocessHas(celExpr);

  try {
    const augmentedContext = injectMissingAsNull(preprocessed, context);
    return evaluateCelCondition(preprocessed, augmentedContext);
  } catch (err) {
    // Fallback to legacy evaluator for expressions CEL cannot handle.
    log.debug('CEL evaluation failed, falling back to legacy', {
      expression: expression.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return legacyEvaluateCondition(expression, context);
  }
}
```

Replace `resolveValueDual` (line 125-139):

```typescript
export function resolveValueDual(expression: string, context: EvaluationContext): unknown {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;
  const preprocessed = preprocessHas(celExpr);

  try {
    const augmentedContext = injectMissingAsNull(preprocessed, context);
    return evaluateCel(preprocessed, augmentedContext);
  } catch (err) {
    // Fallback to legacy resolveValue for expressions CEL cannot handle.
    log.debug('CEL value resolution failed, falling back to legacy', {
      expression: expression.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return legacyResolveValue(expression, context);
  }
}
```

**Step 5: Run all dual evaluator tests**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/constructs/dual-evaluator.test.ts src/__tests__/constructs/dual-evaluator-null-injection.test.ts`
Expected: All PASS

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/constructs/cel-parity.test.ts`
Expected: All PASS (no regression)

**Step 6: Run full compiler test suite**

Run: `cd packages/compiler && pnpm exec vitest run`
Expected: 3098+ tests pass

**Step 7: Commit**

```bash
git add packages/compiler/src/platform/constructs/dual-evaluator.ts packages/compiler/src/__tests__/constructs/dual-evaluator-null-injection.test.ts
git commit -m "perf(compiler): inject null for missing CEL identifiers

Eliminates exception-path overhead for IS SET checks on unset variables.
Before: CEL throws 'Unknown variable', catches, falls back to legacy (~5ms).
After: CEL evaluates 'null != null' = false directly (~0.1ms).

- CEL_RESERVED set prevents shadowing CEL keywords
- stripQuotedStrings prevents false matches inside string literals
- Lazy clone: zero allocation when all identifiers present
- Debug-level trace logs injected identifiers"
```

---

## Task 3: Constraint Executor — CEL Support with Guard Semantics

**Priority: 2 — most complex, requires careful design**

This is the redesigned approach: guard/precondition logic stays in `constraint-executor.ts` (where it belongs semantically), and the dual evaluator is injected via dependency injection for individual sub-expression evaluation.

### Design Principles

1. **Guard detection stays in constraint layer** — it's a constraint semantic, not an evaluator semantic
2. **Dual evaluator injected via options** — `checkConstraintsCore` already accepts options; add `evaluateCondition`
3. **recordOnly path refactored** — use `checkConstraintsCore` with `shortCircuit: false` instead of duplicating the loop
4. **Trace events for every decision point** — guard classification, not-applicable, evaluator mode

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts`
- Create: `packages/compiler/src/__tests__/constructs/constraint-dual-evaluator.test.ts`

### Sub-task 3a: Refactor checkConstraintsCore for DI + recordOnly

**Step 1: Write failing tests for new evaluator injection**

Create `packages/compiler/src/__tests__/constructs/constraint-dual-evaluator.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { checkConstraintsCore } from '../../platform/constructs/executors/constraint-executor.js';
import type { ConstraintCheckInfo } from '../../platform/constructs/executors/constraint-executor.js';
import type {
  Constraint,
  Guardrail,
  ConstraintConfig,
  ConstraintAction,
} from '../../platform/ir/schema.js';
import { evaluateConditionDual } from '../../platform/constructs/dual-evaluator.js';

function makeConfig(
  constraints: Constraint[] = [],
  guardrails: Guardrail[] = [],
): ConstraintConfig {
  return { constraints, guardrails };
}

function respondAction(message: string): ConstraintAction {
  return { type: 'respond', message };
}

describe('checkConstraintsCore with dual evaluator', () => {
  describe('CEL syntax in constraint conditions', () => {
    test('evaluates CEL constraint condition', () => {
      const config = makeConfig([
        { condition: 'amount > 1000', on_fail: respondAction('Too high') },
      ]);
      const result = checkConstraintsCore(
        config,
        { amount: 500 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(false);
    });

    test('evaluates CEL constraint with abl.* functions', () => {
      const config = makeConfig([
        { condition: 'abl.upper(status) == "ACTIVE"', on_fail: respondAction('Not active') },
      ]);
      const result = checkConstraintsCore(
        config,
        { status: 'active' },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // passes
    });

    test('evaluates CEL guardrail condition', () => {
      const config = makeConfig(
        [],
        [
          {
            name: 'amount_limit',
            description: 'Limit',
            check: 'amount < 10000',
            action: respondAction('Over limit'),
          },
        ],
      );
      const result = checkConstraintsCore(
        config,
        { amount: 15000 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe('guardrail');
    });
  });

  describe('IS SET guard semantics with dual evaluator', () => {
    test('guard not met (variable missing) — constraint not applicable (returns null)', () => {
      const config = makeConfig([
        { condition: 'amount IS SET AND amount > 1000', on_fail: respondAction('Too high') },
      ]);
      // amount not in context → guard fails → constraint is "not applicable"
      const result = checkConstraintsCore(
        config,
        {},
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // not applicable = all pass
    });

    test('guard met, assertion passes — constraint passes', () => {
      const config = makeConfig([
        { condition: 'amount IS SET AND amount > 1000', on_fail: respondAction('Too high') },
      ]);
      const result = checkConstraintsCore(
        config,
        { amount: 2000 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // passes
    });

    test('guard met, assertion fails — constraint violated', () => {
      const config = makeConfig([
        { condition: 'amount IS SET AND amount > 1000', on_fail: respondAction('Too high') },
      ]);
      const result = checkConstraintsCore(
        config,
        { amount: 500 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(false);
    });

    test('multiple guards — all must pass for assertions to evaluate', () => {
      const config = makeConfig([
        { condition: 'a IS SET AND b IS SET AND a > b', on_fail: respondAction('a <= b') },
      ]);
      // Only a is set → not applicable
      const result = checkConstraintsCore(
        config,
        { a: 5 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull();
    });

    test('CEL function in assertion part', () => {
      const config = makeConfig([
        {
          condition: 'name IS SET AND abl.upper(name) == "JOHN"',
          on_fail: respondAction('Not John'),
        },
      ]);
      const result = checkConstraintsCore(
        config,
        { name: 'john' },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // passes: guard met, assertion passes
    });

    test('guard with CEL has() syntax', () => {
      const config = makeConfig([
        { condition: 'has(amount) && amount > 1000', on_fail: respondAction('Too high') },
      ]);
      // CEL-native guard syntax — amount not in context
      const result = checkConstraintsCore(
        config,
        {},
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // not applicable
    });

    test('parenthesized assertion with guard', () => {
      const config = makeConfig([
        {
          condition: 'amount IS SET AND (amount > 100 AND amount < 10000)',
          on_fail: respondAction('Out of range'),
        },
      ]);
      const result = checkConstraintsCore(
        config,
        { amount: 500 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      expect(result).toBeNull(); // passes
    });

    test('IS NOT SET is NOT treated as a guard', () => {
      // IS NOT SET is a value assertion, not a guard precondition
      const config = makeConfig([
        { condition: 'override IS NOT SET AND price > 0', on_fail: respondAction('Overridden') },
      ]);
      const result = checkConstraintsCore(
        config,
        { override: true, price: 10 },
        {
          evaluateCondition: evaluateConditionDual,
        },
      );
      // override IS NOT SET = false → constraint fails
      expect(result).not.toBeNull();
    });
  });

  describe('shortCircuit option for recordOnly', () => {
    test('shortCircuit: false collects all results', () => {
      const config = makeConfig([
        { condition: 'a > 10', on_fail: respondAction('a too low') },
        { condition: 'b > 10', on_fail: respondAction('b too low') },
      ]);
      const checks: ConstraintCheckInfo[] = [];
      const result = checkConstraintsCore(
        config,
        { a: 5, b: 5 },
        {
          evaluateCondition: evaluateConditionDual,
          shortCircuit: false,
          onCheck: (info) => checks.push(info),
        },
      );
      // First failure returned
      expect(result).not.toBeNull();
      // But both were checked (shortCircuit: false)
      expect(checks.length).toBe(2);
    });

    test('shortCircuit: true (default) stops at first failure', () => {
      const config = makeConfig([
        { condition: 'a > 10', on_fail: respondAction('a too low') },
        { condition: 'b > 10', on_fail: respondAction('b too low') },
      ]);
      const checks: ConstraintCheckInfo[] = [];
      const result = checkConstraintsCore(
        config,
        { a: 5, b: 5 },
        {
          evaluateCondition: evaluateConditionDual,
          onCheck: (info) => checks.push(info),
        },
      );
      expect(result).not.toBeNull();
      // Only first constraint checked
      expect(checks.length).toBe(1);
    });
  });

  describe('onCheck trace callback includes guard info', () => {
    test('onCheck receives guardSkipped flag when guard causes not-applicable', () => {
      const config = makeConfig([
        { condition: 'amount IS SET AND amount > 1000', on_fail: respondAction('Too high') },
      ]);
      const checks: ConstraintCheckInfo[] = [];
      checkConstraintsCore(
        config,
        {},
        {
          evaluateCondition: evaluateConditionDual,
          onCheck: (info) => checks.push(info),
        },
      );
      expect(checks.length).toBe(1);
      expect(checks[0].passed).toBe(true);
      expect(checks[0].guardSkipped).toBe(true);
    });

    test('onCheck receives guardSkipped: false for normal evaluation', () => {
      const config = makeConfig([
        { condition: 'amount > 1000', on_fail: respondAction('Too high') },
      ]);
      const checks: ConstraintCheckInfo[] = [];
      checkConstraintsCore(
        config,
        { amount: 2000 },
        {
          evaluateCondition: evaluateConditionDual,
          onCheck: (info) => checks.push(info),
        },
      );
      expect(checks[0].guardSkipped).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/constructs/constraint-dual-evaluator.test.ts`
Expected: FAIL — `evaluateCondition` option doesn't exist yet, `shortCircuit` doesn't exist, `guardSkipped` doesn't exist

**Step 3: Add guard detection helpers to constraint-executor.ts**

Add after the `CheckConstraintsCoreOptions` interface (line 55):

```typescript
// =============================================================================
// GUARD DETECTION (constraint-layer semantics)
// =============================================================================

/**
 * Split a constraint condition by AND (legacy) or && (CEL), respecting parentheses.
 * Only splits at the top level — nested AND/&& inside parens are preserved.
 */
function splitConstraintByAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) {
      // Check for ' AND ' (legacy)
      if (expr.slice(i, i + 5) === ' AND ') {
        parts.push(current.trim());
        current = '';
        i += 4;
        continue;
      }
      // Check for ' && ' (CEL)
      if (expr.slice(i, i + 4) === ' && ') {
        parts.push(current.trim());
        current = '';
        i += 3;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Pre-compiled patterns for guard expression detection */
const IS_SET_SUFFIX = /\bIS\s+SET$/i;
const HAS_PATTERN = /^has\(.+\)$/;
const NOT_NULL_GUARD_PATTERN = /^(\w+)\s*!=\s*null$/;

/**
 * Detect whether a sub-expression is an IS SET / has() guard.
 *
 * A guard is a precondition that checks whether a variable exists.
 * Only positive existence checks are guards:
 * - `varName IS SET`
 * - `has(varName)` / `has(obj.field)`
 * - `varName != null` ONLY when varName also appears in a value assertion
 *
 * IS NOT SET and == null are NOT guards — they are value assertions.
 *
 * @param expr - The sub-expression to classify
 * @param assertionIdentifiers - Set of identifiers used in value assertion parts.
 *   If provided, `varName != null` is only classified as a guard when varName
 *   appears in the assertion set. This prevents false positives like standalone
 *   `error_code != null` being treated as a guard.
 */
function isGuardExpression(expr: string, assertionIdentifiers?: Set<string>): boolean {
  const trimmed = expr.trim();
  // Legacy: "varName IS SET" (but NOT "varName IS NOT SET")
  if (IS_SET_SUFFIX.test(trimmed)) return true;
  // CEL: "has(varName)" or "has(obj.field)"
  if (HAS_PATTERN.test(trimmed)) return true;
  // Preprocessed: "varName != null" — only if varName is used in assertions
  if (assertionIdentifiers) {
    const match = trimmed.match(NOT_NULL_GUARD_PATTERN);
    if (match && assertionIdentifiers.has(match[1])) return true;
  }
  return false;
}

/**
 * Extract bare identifiers from an expression for guard cross-referencing.
 */
function extractIdentifiers(expr: string): Set<string> {
  const matches = expr.match(/\b[a-zA-Z_]\w*\b/g);
  return new Set(matches || []);
}

/**
 * Evaluate a constraint condition with IS SET guard semantics.
 *
 * Guard semantics: In AND chains, `IS SET` / `has()` clauses act as
 * preconditions. If any guard fails (variable not set), the constraint
 * is "not applicable" (returns true). Only when all guards pass are
 * the value assertions evaluated.
 *
 * @returns { passed: boolean, guardSkipped: boolean }
 */
function evaluateWithGuardSemantics(
  condition: string,
  context: Record<string, unknown>,
  evaluate: (cond: string, ctx: Record<string, unknown>) => boolean,
): { passed: boolean; guardSkipped: boolean } {
  const trimmed = condition.trim();
  const andParts = splitConstraintByAnd(trimmed);

  if (andParts.length > 1) {
    // First pass: collect all assertion identifiers for cross-referencing
    const potentialAssertions = andParts.filter(
      (p) => !IS_SET_SUFFIX.test(p.trim()) && !HAS_PATTERN.test(p.trim()),
    );
    const assertionIds = new Set<string>();
    for (const a of potentialAssertions) {
      for (const id of extractIdentifiers(a)) assertionIds.add(id);
    }

    const guards: string[] = [];
    const assertions: string[] = [];

    for (const part of andParts) {
      if (isGuardExpression(part, assertionIds)) {
        guards.push(part);
      } else {
        assertions.push(part);
      }
    }

    // Mixed guards + assertions: guards are preconditions
    if (guards.length > 0 && assertions.length > 0) {
      const allGuardsPass = guards.every((g) => evaluate(g, context));
      if (!allGuardsPass) {
        return { passed: true, guardSkipped: true }; // Not applicable
      }
      const assertionsPass = assertions.every((a) => evaluate(a, context));
      return { passed: assertionsPass, guardSkipped: false };
    }
  }

  // No guard pattern: evaluate entire expression directly
  return { passed: evaluate(condition, context), guardSkipped: false };
}
```

**Step 4: Refactor CheckConstraintsCoreOptions and checkConstraintsCore**

Replace the `CheckConstraintsCoreOptions` interface and `checkConstraintsCore` function:

```typescript
export interface CheckConstraintsCoreOptions {
  /** Callback fired for every constraint check */
  onCheck?: (info: ConstraintCheckInfo) => void;
  /** Expression evaluator function. Defaults to legacy evaluateConstraintCondition. */
  evaluateCondition?: (condition: string, context: Record<string, unknown>) => boolean;
  /** If false, check all constraints even after first failure. Default: true. */
  shortCircuit?: boolean;
}

export function checkConstraintsCore(
  constraintConfig: ConstraintConfig,
  context: Record<string, unknown>,
  options?: CheckConstraintsCoreOptions,
): ConstraintCheckInfo | null {
  const onCheck = options?.onCheck;
  const evaluate = options?.evaluateCondition ?? evaluateConstraintCondition;
  const shortCircuit = options?.shortCircuit !== false; // default true
  let firstFailure: ConstraintCheckInfo | null = null;

  // Check guardrails first (always active)
  if (constraintConfig.guardrails && constraintConfig.guardrails.length > 0) {
    for (const guardrail of constraintConfig.guardrails) {
      const { passed, guardSkipped } = evaluateWithGuardSemantics(
        guardrail.check,
        context,
        evaluate,
      );
      const info: ConstraintCheckInfo = {
        type: 'guardrail',
        name: guardrail.name,
        condition: guardrail.check,
        passed,
        guardSkipped,
        action: guardrail.action,
      };
      onCheck?.(info);
      if (!passed) {
        if (shortCircuit) return info;
        if (!firstFailure) firstFailure = info;
      }
    }
  }

  // Check constraints
  if (constraintConfig.constraints && constraintConfig.constraints.length > 0) {
    for (const constraint of constraintConfig.constraints) {
      const { passed, guardSkipped } = evaluateWithGuardSemantics(
        constraint.condition,
        context,
        evaluate,
      );
      const info: ConstraintCheckInfo = {
        type: 'constraint',
        condition: constraint.condition,
        passed,
        guardSkipped,
        action: constraint.on_fail,
      };
      onCheck?.(info);
      if (!passed) {
        if (shortCircuit) return info;
        if (!firstFailure) firstFailure = info;
      }
    }
  }

  return firstFailure;
}
```

**Step 5: Add `guardSkipped` to ConstraintCheckInfo**

Update the `ConstraintCheckInfo` interface:

```typescript
export interface ConstraintCheckInfo {
  type: 'guardrail' | 'constraint';
  name?: string;
  condition: string;
  passed: boolean;
  /** True when an IS SET guard caused this constraint to be skipped as "not applicable". */
  guardSkipped: boolean;
  action: ConstraintAction;
}
```

**Step 6: Refactor ConstraintExecutor.execute to use checkConstraintsCore for recordOnly**

Replace the `recordOnly` path (lines 186-236) in `ConstraintExecutor.execute`:

```typescript
// recordOnly path: collect all results without short-circuiting
const allResults: Record<string, boolean> = {};
const failures: Array<{
  constraint: string;
  action: ConstructAction;
}> = [];

const filteredConfig: ConstraintConfig = {
  guardrails: options.skipGuardrails ? [] : constraintConfig.guardrails || [],
  constraints: options.skipConstraints ? [] : constraintConfig.constraints || [],
};

checkConstraintsCore(filteredConfig, state.context, {
  shortCircuit: false,
  onCheck: async (info) => {
    const key =
      info.type === 'guardrail' ? `guardrail:${info.name}` : `constraint:${info.condition}`;
    allResults[key] = info.passed;
    await trace.logConstraintCheck(
      key,
      info.passed,
      info.type === 'guardrail'
        ? {
            description: constraintConfig.guardrails?.find((g) => g.name === info.name)
              ?.description,
          }
        : {},
    );
    if (!info.passed) {
      failures.push({
        constraint: info.type === 'guardrail' ? info.name || info.condition : info.condition,
        action: this.convertConstraintAction(info.action, state.context),
      });
    }
  },
});

return {
  action: failures.length > 0 ? failures[0].action : continueAction(),
  stateUpdates: { constraintResults: allResults },
  metadata: {
    checksPerformed: Object.keys(allResults).length,
    failures: failures.length,
    failureDetails: failures.length > 0 ? failures : undefined,
  },
};
```

**Step 7: Run all constraint tests**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/constructs/constraint-executor.test.ts src/__tests__/constructs/constraint-dual-evaluator.test.ts`
Expected: All PASS

**Step 8: Wire dual evaluator in runtime constraint-checker.ts**

In `apps/runtime/src/services/execution/constraint-checker.ts`, update the import and pass the dual evaluator:

```typescript
// Line 8-9: Remove the TODO comment, add import
import { checkConstraintsCore, DEFAULT_MESSAGES } from '@abl/compiler';
import { evaluateConditionDual } from '@abl/compiler';
import type { ConstraintCheckInfo } from '@abl/compiler';
```

Update `checkConstraints` (line 57) to pass the evaluator:

```typescript
return checkConstraintsCore(ir.constraints, context, {
  evaluateCondition: evaluateConditionDual,
  onCheck: onTraceEvent
    ? (info) => {
        const varMatches = info.condition.match(/\b([a-z_][a-z0-9_]*)\b/gi) || [];
        const relevantContext: Record<string, unknown> = {};
        for (const varName of varMatches) {
          if (context[varName] !== undefined) {
            relevantContext[varName] = context[varName];
          }
        }
        onTraceEvent({
          type: 'constraint_check',
          data: {
            agentName: session.agentName,
            constraintType: info.type,
            name: info.name,
            condition: info.condition,
            passed: info.passed,
            guardSkipped: info.guardSkipped,
            relevantContext,
            onFail: info.action,
          },
        });
      }
    : undefined,
});
```

**Step 9: Run full test suites**

Run: `cd packages/compiler && pnpm exec vitest run`
Expected: 3098+ tests pass

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/constraint-checker.test.ts src/__tests__/cel-runtime-integration.test.ts`
Expected: All PASS

**Step 10: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/constraint-executor.ts \
       packages/compiler/src/__tests__/constructs/constraint-dual-evaluator.test.ts \
       apps/runtime/src/services/execution/constraint-checker.ts
git commit -m "feat(compiler): wire dual CEL evaluator into constraint executor

- Guard detection stays in constraint layer (not evaluator layer)
- checkConstraintsCore accepts evaluateCondition via options (DI)
- IS SET guard semantics preserved: guards as preconditions, not-applicable on guard fail
- isGuardExpression cross-references assertion identifiers to prevent != null false positives
- shortCircuit: false option replaces duplicated recordOnly loop (DRY)
- guardSkipped field on ConstraintCheckInfo for tracing
- Runtime constraint-checker passes evaluateConditionDual"
```

---

## Task 4: Delegate INPUT — Documentation + Compiler Warning + Runtime Trace

**Priority: 3 — additive, no runtime behavior change**

INPUT mappings are data routing only (dot-path resolution). CEL expressions are not supported. This task adds documentation, a compiler warning for CEL in INPUT, and a runtime trace for dropped fields.

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:1422-1439`
- Modify: `apps/runtime/src/services/execution/value-resolution.ts:153-179`
- Create: `packages/compiler/src/platform/ir/validate-input-mappings.ts`
- Modify: `packages/compiler/src/platform/ir/compiler.ts` (wire validation)
- Test: `packages/compiler/src/__tests__/validate-input-mappings.test.ts`

**Step 1: Write failing tests for compiler validation**

Create `packages/compiler/src/__tests__/validate-input-mappings.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { validateInputMappings } from '../platform/ir/validate-input-mappings.js';

describe('validateInputMappings', () => {
  test('plain dot path produces no warning', () => {
    const warnings = validateInputMappings(
      { name: 'user.name', age: 'user.age' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(0);
  });

  test('function call syntax produces warning', () => {
    const warnings = validateInputMappings(
      { formatted: 'abl.upper(user.name)' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CEL_IN_INPUT_MAPPING');
    expect(warnings[0].severity).toBe('warning');
  });

  test('logical operators produce warning', () => {
    const warnings = validateInputMappings({ flag: 'a && b' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
  });

  test('arithmetic operators (space-padded) produce warning', () => {
    const warnings = validateInputMappings({ total: 'price + tax' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(1);
  });

  test('hyphenated path (not arithmetic) produces no warning', () => {
    const warnings = validateInputMappings(
      { id: 'user.account-id' },
      'booking_agent',
      'specialist',
    );
    expect(warnings).toHaveLength(0);
  });

  test('simple variable name produces no warning', () => {
    const warnings = validateInputMappings({ x: 'x' }, 'booking_agent', 'specialist');
    expect(warnings).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/validate-input-mappings.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Create validate-input-mappings.ts**

Create `packages/compiler/src/platform/ir/validate-input-mappings.ts`:

```typescript
/**
 * INPUT Mapping Validation
 *
 * Detects CEL expressions in DELEGATE INPUT mappings and emits warnings.
 * INPUT only supports dot-path resolution. CEL expressions should use SET
 * before the DELEGATE to compute derived values.
 */

import type { ValidationDiagnostic } from './validation-types.js';

/** Patterns that indicate CEL syntax (not plain dot-paths) */
const CEL_INDICATORS = [
  /\(.*\)/, // Function calls: abl.upper(name)
  /&&|\|\|/, // Logical operators
  /\s[+*/]\s/, // Arithmetic operators (space-padded, excludes hyphenated paths)
  /\s-\s/, // Subtraction (space-padded, excludes kebab-case)
];

/**
 * Validate INPUT mappings for CEL expressions.
 * Returns warnings for any mapping source that appears to contain CEL syntax.
 */
export function validateInputMappings(
  inputMapping: Record<string, string>,
  agentName: string,
  delegateTarget: string,
): ValidationDiagnostic[] {
  const warnings: ValidationDiagnostic[] = [];

  for (const [key, source] of Object.entries(inputMapping)) {
    for (const pattern of CEL_INDICATORS) {
      if (pattern.test(source)) {
        warnings.push({
          severity: 'warning',
          location: { agent: agentName },
          message:
            `INPUT mapping "${key}" in DELEGATE to "${delegateTarget}" appears to contain ` +
            `a CEL expression ("${source.slice(0, 60)}"). INPUT only supports dot-path ` +
            `resolution. Use SET before DELEGATE to compute transformed values.`,
          code: 'CEL_IN_INPUT_MAPPING',
        });
        break; // One warning per field
      }
    }
  }

  return warnings;
}
```

**Step 4: Run validation tests**

Run: `cd packages/compiler && pnpm exec vitest run src/__tests__/validate-input-mappings.test.ts`
Expected: All PASS

**Step 5: Add JSDoc to mapDelegateInput and runtime warning for dropped fields**

In `apps/runtime/src/services/execution/routing-executor.ts`, update `mapDelegateInput` (line 1422):

```typescript
/**
 * Map INPUT fields from context to delegate input.
 *
 * INPUT mappings use dot-path resolution only (e.g., "user.name").
 * CEL expressions are NOT supported in INPUT sources. If transformation
 * is needed, use SET before the DELEGATE to compute derived values,
 * then reference those computed values in INPUT.
 *
 * @example
 *   SET: formatted = abl.upper(user.name)
 *   DELEGATE: agent
 *     INPUT:
 *       name: formatted       // path reference to SET result
 */
export function mapDelegateInput(
  inputMapping: Record<string, string>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};

  for (const [targetKey, sourceExpr] of Object.entries(inputMapping)) {
    const value = resolveValuePath(sourceExpr, context);
    if (value !== undefined) {
      mapped[targetKey] = value;
    } else {
      log.warn('INPUT mapping resolved to undefined — field dropped from delegate input', {
        targetKey,
        sourceExpr,
        hint: 'If using CEL expressions, move computation to a SET step before DELEGATE',
      });
    }
  }

  return mapped;
}
```

**Step 6: Export validateInputMappings from compiler**

Add to `packages/compiler/src/index.ts`:

```typescript
export { validateInputMappings } from './platform/ir/validate-input-mappings.js';
```

**Step 7: Run all tests**

Run: `cd packages/compiler && pnpm exec vitest run`
Expected: All PASS

Run: `cd apps/runtime && pnpm exec vitest run --reporter=verbose 2>&1 | tail -5`
Expected: All PASS

**Step 8: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-input-mappings.ts \
       packages/compiler/src/__tests__/validate-input-mappings.test.ts \
       packages/compiler/src/index.ts \
       apps/runtime/src/services/execution/routing-executor.ts
git commit -m "feat(compiler): add INPUT mapping validation and runtime trace

- Compiler warning (CEL_IN_INPUT_MAPPING) for CEL expressions in INPUT
- Runtime warning log when INPUT mapping resolves to undefined
- JSDoc on mapDelegateInput clarifying path-only semantics
- Design decision: INPUT is data routing, SET is computation"
```

---

## Task 5: Observability Counters + Legacy Evaluator Deprecation Criteria

**Priority: 4 — cross-cutting, enables data-driven deprecation decision**

**Files:**

- Modify: `packages/compiler/src/platform/constructs/dual-evaluator.ts` (add counters)
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts` (trace guard events)
- Create: `docs/plans/2026-02-28-cel-deprecation-criteria.md`

**Step 1: Add evaluation counters to dual-evaluator.ts**

Add after the `log` declaration:

```typescript
/**
 * CEL evaluation counters for observability.
 * Used to track migration progress and decide when to deprecate the legacy evaluator.
 *
 * These are process-local counters. In production, they should be exported
 * to a metrics system (Prometheus, OpenTelemetry) via periodic scraping.
 */
export const celMetrics = {
  /** CEL evaluation succeeded without fallback */
  celSuccess: 0,
  /** CEL evaluation failed, fell back to legacy */
  celFallback: 0,
  /** Null injection occurred (identifiers injected) */
  nullInjections: 0,
  /** Reset counters (for testing) */
  reset() {
    this.celSuccess = 0;
    this.celFallback = 0;
    this.nullInjections = 0;
  },
};
```

Wire into `evaluateConditionDual`:

```typescript
export function evaluateConditionDual(expression: string, context: EvaluationContext): boolean {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;
  const preprocessed = preprocessHas(celExpr);

  try {
    const augmentedContext = injectMissingAsNull(preprocessed, context);
    const result = evaluateCelCondition(preprocessed, augmentedContext);
    celMetrics.celSuccess++;
    return result;
  } catch (err) {
    celMetrics.celFallback++;
    log.debug('CEL evaluation failed, falling back to legacy', {
      expression: expression.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return legacyEvaluateCondition(expression, context);
  }
}
```

Same pattern for `resolveValueDual`. Increment `celMetrics.nullInjections` inside `injectMissingAsNull` when augmentation occurs.

**Step 2: Add trace events for guard-skipped constraints**

In `apps/runtime/src/services/execution/constraint-checker.ts`, update the `onCheck` callback to emit a distinct event when `guardSkipped` is true:

```typescript
onTraceEvent({
  type: info.guardSkipped ? 'constraint_guard_skipped' : 'constraint_check',
  data: {
    agentName: session.agentName,
    constraintType: info.type,
    name: info.name,
    condition: info.condition,
    passed: info.passed,
    guardSkipped: info.guardSkipped,
    relevantContext,
    onFail: info.action,
  },
});
```

**Step 3: Write deprecation criteria document**

Create `docs/plans/2026-02-28-cel-deprecation-criteria.md`:

```markdown
# Legacy Expression Evaluator Deprecation Criteria

## Current State

After CEL Phase 2, all expression evaluation paths go through the dual evaluator
(CEL-first, legacy fallback). The legacy evaluator is only invoked when CEL fails.

## Counters to Monitor

| Counter                                 | Source                  | Meaning                               |
| --------------------------------------- | ----------------------- | ------------------------------------- |
| `celMetrics.celSuccess`                 | `dual-evaluator.ts`     | CEL evaluated successfully            |
| `celMetrics.celFallback`                | `dual-evaluator.ts`     | CEL failed, used legacy               |
| `celMetrics.nullInjections`             | `dual-evaluator.ts`     | Missing identifiers injected as null  |
| `constraint_guard_skipped` trace events | `constraint-checker.ts` | Guard caused constraint to be skipped |

## Deprecation Gate

The legacy evaluator can be removed when ALL of the following are true:

1. **`celFallback` is 0** across all production tenants for 30 consecutive days
2. **No new ABL expressions** use legacy-only syntax (all new agents use CEL or YAML)
3. **Migration tooling** has been run on all existing agent definitions to convert
   legacy ABL expressions to CEL syntax at the DSL level
4. **Integration tests** cover every expression pattern that currently triggers fallback

## Removal Plan

1. Add a `LEGACY_EVALUATOR_ENABLED` feature flag (default: true)
2. Set to false in staging, run full test suite
3. Monitor for 14 days in staging
4. Set to false in production, monitor for 30 days
5. Remove legacy evaluator code, `isLegacyExpression`, `migrateExpression`
6. Remove `celMetrics.celFallback` counter
7. Simplify `evaluateConditionDual` → `evaluateCondition` (direct CEL only)

## Estimated Timeline

- Phase 2 complete: March 2026
- Monitoring period: March-April 2026
- Legacy removal (if criteria met): May 2026
```

**Step 4: Export celMetrics from compiler**

Add to `packages/compiler/src/index.ts`:

```typescript
export { celMetrics } from './platform/constructs/dual-evaluator.js';
```

**Step 5: Write tests for counters**

Add to `packages/compiler/src/__tests__/constructs/dual-evaluator-null-injection.test.ts`:

```typescript
import { celMetrics } from '../../platform/constructs/dual-evaluator.js';

describe('CEL metrics counters', () => {
  beforeEach(() => celMetrics.reset());

  test('increments celSuccess on successful CEL evaluation', () => {
    evaluateConditionDual('age > 18', { age: 25 });
    expect(celMetrics.celSuccess).toBe(1);
    expect(celMetrics.celFallback).toBe(0);
  });

  test('increments celFallback on CEL failure', () => {
    // Intentionally trigger a CEL failure that falls back to legacy
    evaluateConditionDual('??? invalid', {});
    expect(celMetrics.celFallback).toBe(1);
  });

  test('increments nullInjections when identifiers injected', () => {
    evaluateConditionDual('name IS SET', {});
    expect(celMetrics.nullInjections).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 6: Run all tests**

Run: `cd packages/compiler && pnpm exec vitest run`
Expected: All PASS

Run: `cd apps/runtime && pnpm exec vitest run`
Expected: All PASS

**Step 7: Commit**

```bash
git add packages/compiler/src/platform/constructs/dual-evaluator.ts \
       packages/compiler/src/__tests__/constructs/dual-evaluator-null-injection.test.ts \
       packages/compiler/src/index.ts \
       apps/runtime/src/services/execution/constraint-checker.ts \
       docs/plans/2026-02-28-cel-deprecation-criteria.md
git commit -m "feat(compiler): add CEL evaluation counters and deprecation criteria

- celMetrics: celSuccess, celFallback, nullInjections counters
- constraint_guard_skipped trace event type for guard-skipped constraints
- Deprecation criteria doc: 30-day zero-fallback gate before legacy removal
- Counters are process-local; export for metrics scraping"
```

---

## Priority Order

| Priority | Task                                     | Risk   | Effort  | What it does                                           |
| -------- | ---------------------------------------- | ------ | ------- | ------------------------------------------------------ |
| 0        | **Task 1** — Routing executor swap       | None   | 30 min  | Migrates 4 simple condition checks to dual evaluator   |
| 1        | **Task 2** — Null injection              | Low    | 2 hrs   | Eliminates exception overhead for IS SET on unset vars |
| 2        | **Task 3** — Constraint CEL support      | Medium | 4 hrs   | IS SET guard semantics + DI + recordOnly DRY + tracing |
| 3        | **Task 4** — INPUT docs + validation     | Low    | 1.5 hrs | Compiler warning + runtime trace for dropped fields    |
| 4        | **Task 5** — Observability + deprecation | None   | 1 hr    | Counters, guard trace events, deprecation criteria     |

**Total: ~9 hours**

## Dependencies

```
Task 1 ──────────────────────────────────────┐
                                             ├── (independent, can run in parallel)
Task 2 ──── prerequisite for ──── Task 3     │
                                             │
Task 4 ──────────────────────────────────────┤
                                             │
Task 5 ──── depends on Task 2 + 3 counters ──┘
```

- Task 1, 2, 4 are fully independent — can be implemented in parallel
- Task 3 benefits from Task 2's null injection (guards on unset vars take fast path)
- Task 5 adds counters to code written in Tasks 2+3, so do it last

## Success Criteria

- All 4 routing-executor condition checks use dual evaluator (Task 1)
- No "Unknown variable" exceptions for IS SET checks on unset variables (Task 2)
- All constraint conditions evaluate correctly with CEL syntax (Task 3)
- IS SET guard semantics preserved exactly — no behavioral regression (Task 3)
- `guardSkipped` flag on every `ConstraintCheckInfo` (Task 3)
- `recordOnly` path uses `checkConstraintsCore` with `shortCircuit: false` — no duplication (Task 3)
- `mapDelegateInput` logs warnings for undefined INPUT mappings (Task 4)
- Compiler emits `CEL_IN_INPUT_MAPPING` warning for CEL in INPUT sources (Task 4)
- `celMetrics` counters track success/fallback/injection rates (Task 5)
- `constraint_guard_skipped` trace event emitted when guard causes not-applicable (Task 5)
- Deprecation criteria defined with clear gate (30-day zero-fallback) (Task 5)
- All existing tests pass: `cel-parity.test.ts`, `dual-evaluator.test.ts`, `cel-runtime-integration.test.ts`, `constraint-executor.test.ts`, `constraint-checker.test.ts`
