# ABL Phase 1: YAML + CEL Standards Adoption — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ABL's custom expression engine with CEL (Common Expression Language) and add a YAML parsing path so ABL files become valid YAML with industry-standard expressions.

**Architecture:** The compiler gains a dual-parser front-end: the existing Chevrotain lexer/parser for legacy `.abl` files, and a new `yaml.parse()` path for YAML-format files. Both produce the same `AgentBasedDocument` AST. The custom expression evaluator (`evaluateCondition`, `resolveValue`, 35 built-in functions) is replaced by a CEL evaluator backed by `@marcbachmann/cel-js`, with ABL domain functions registered as CEL custom functions under the `abl.*` namespace. An expression migration utility converts ABL expression syntax (AND/OR/UPPER(x)) to CEL syntax (&&/||/abl.upper(x)). Both old and new expression syntax are supported during the transition period.

**Tech Stack:** `@marcbachmann/cel-js` (CEL evaluator), `js-yaml` (YAML parser), `ajv` (JSON Schema validation), Vitest (testing), TypeScript

**Design Doc:** `docs/plans/2026-02-26-abl-core-extensions-design.md` — Section 6 (Standards Adoption)

---

## Context for the Implementer

### Key Files You'll Work With

| File                                                        | Role                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/constructs/evaluator.ts`    | Current custom expression evaluator — 35 built-in functions, condition evaluation, value resolution, template interpolation (~1300 lines) |
| `packages/core/src/parser/expression-parser.ts`             | Current custom expression parser — recursive descent, produces Expression AST nodes                                                       |
| `packages/core/src/parser/lexer.ts`                         | Chevrotain lexer — 78 token types including expression operators                                                                          |
| `packages/core/src/parser/agent-based-parser.ts`            | Line-based recursive descent parser — produces `AgentBasedDocument`                                                                       |
| `packages/compiler/src/platform/ir/compiler.ts`             | `compileABLtoIR()` — entry point for compilation pipeline                                                                                 |
| `packages/compiler/src/platform/ir/schema.ts`               | IR schema — 97 interfaces, expressions stored as plain strings                                                                            |
| `apps/runtime/src/services/execution/value-resolution.ts`   | Runtime template interpolation and SET value resolution                                                                                   |
| `apps/runtime/src/services/execution/constraint-checker.ts` | Runtime constraint evaluation — delegates to compiler's evaluator                                                                         |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Imports `evaluateCondition`, `resolveValue` from compiler                                                                                 |

### How Expressions Flow Today

```
DSL Text → Lexer (tokenize) → Parser → AgentBasedDocument (AST)
                                              ↓
                                   Compiler (compileABLtoIR)
                                              ↓
                                   AgentIR (expressions stored as strings)
                                              ↓
                                   Runtime Executor
                                              ↓
                           evaluateCondition() / resolveValue() / interpolateTemplate()
```

Expressions are stored as **plain strings** in the IR (e.g., `constraint.condition: "age >= 18 AND name != \"\""`). They are evaluated at runtime by the compiler's `evaluateCondition()` and `resolveValue()` functions. The CEL migration changes the evaluator — not the storage format. IR strings will contain CEL syntax instead of ABL syntax.

### Current Expression Syntax (ABL Custom)

```
age >= 18 AND name != ""          # Logical: AND, OR, NOT
status IN ["active", "pending"]   # Membership
email CONTAINS "@"                # String check
phone MATCHES "^\d{10}$"         # Regex
policy_number IS SET              # Existence
UPPER(name)                       # Built-in function (35 total)
ADD(price, tax)                   # Arithmetic function
FORMAT_CURRENCY(amount, "USD")    # Formatting function
```

### Target Expression Syntax (CEL)

```
age >= 18 && name != ""           # Logical: &&, ||, !
status in ["active", "pending"]   # Membership (same)
email.contains("@")              # Method syntax
phone.matches("^\\d{10}$")      # Method syntax
has(policy_number)                # CEL built-in macro
abl.upper(name)                   # Registered custom function
price + tax                       # Native arithmetic
abl.format_currency(amount, "USD") # Registered custom function
```

### Running Tests

```bash
# Build first (required by Turbo)
pnpm build

# Run compiler tests
pnpm --filter @abl/compiler test

# Run core/parser tests
pnpm --filter @abl/core test

# Run runtime tests
pnpm --filter @agent-platform/runtime test

# Run a specific test file
cd packages/compiler && npx vitest run src/__tests__/constructs/cel-evaluator.test.ts
```

---

## Task 1: Install CEL Dependency and Create Evaluator Wrapper

**Files:**

- Modify: `packages/compiler/package.json`
- Create: `packages/compiler/src/platform/constructs/cel-evaluator.ts`
- Create: `packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts`

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { evaluateCel, evaluateCelCondition } from '../../platform/constructs/cel-evaluator.js';

describe('CEL Evaluator', () => {
  describe('evaluateCelCondition', () => {
    test('evaluates simple comparison', () => {
      expect(evaluateCelCondition('age >= 18', { age: 25 })).toBe(true);
      expect(evaluateCelCondition('age >= 18', { age: 10 })).toBe(false);
    });

    test('evaluates logical AND', () => {
      expect(evaluateCelCondition('age >= 18 && name != ""', { age: 25, name: 'John' })).toBe(true);
      expect(evaluateCelCondition('age >= 18 && name != ""', { age: 25, name: '' })).toBe(false);
    });

    test('evaluates logical OR', () => {
      expect(
        evaluateCelCondition('status == "active" || status == "pending"', { status: 'pending' }),
      ).toBe(true);
      expect(
        evaluateCelCondition('status == "active" || status == "pending"', { status: 'closed' }),
      ).toBe(false);
    });

    test('evaluates NOT', () => {
      expect(evaluateCelCondition('!(age < 18)', { age: 25 })).toBe(true);
    });

    test('evaluates in operator', () => {
      expect(evaluateCelCondition('status in ["active", "pending"]', { status: 'active' })).toBe(
        true,
      );
      expect(evaluateCelCondition('status in ["active", "pending"]', { status: 'closed' })).toBe(
        false,
      );
    });

    test('evaluates string methods', () => {
      expect(evaluateCelCondition('email.contains("@")', { email: 'user@example.com' })).toBe(true);
      expect(evaluateCelCondition('name.startsWith("Dr")', { name: 'Dr. Smith' })).toBe(true);
      expect(evaluateCelCondition('phone.matches("^\\\\d{10}$")', { phone: '1234567890' })).toBe(
        true,
      );
    });

    test('evaluates has() for existence checks', () => {
      expect(evaluateCelCondition('has(name)', { name: 'John' })).toBe(true);
      expect(evaluateCelCondition('has(name)', {})).toBe(false);
    });

    test('evaluates size()', () => {
      expect(evaluateCelCondition('size(items) > 0', { items: [1, 2, 3] })).toBe(true);
      expect(evaluateCelCondition('size(items) == 0', { items: [] })).toBe(true);
    });

    test('evaluates arithmetic', () => {
      expect(evaluateCelCondition('price + tax > 100', { price: 90, tax: 15 })).toBe(true);
    });

    test('evaluates ternary', () => {
      const result = evaluateCel('has(name) ? name : "Anonymous"', { name: 'John' });
      expect(result).toBe('John');
      const fallback = evaluateCel('has(name) ? name : "Anonymous"', {});
      expect(fallback).toBe('Anonymous');
    });
  });

  describe('evaluateCel (value resolution)', () => {
    test('resolves string literals', () => {
      expect(evaluateCel('"hello"', {})).toBe('hello');
    });

    test('resolves number literals', () => {
      expect(evaluateCel('42', {})).toBe(42);
    });

    test('resolves variable paths', () => {
      expect(evaluateCel('user.name', { user: { name: 'John' } })).toBe('John');
    });

    test('resolves arithmetic expressions', () => {
      expect(evaluateCel('price + tax', { price: 100, tax: 10 })).toBe(110);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/cel-evaluator.test.ts`
Expected: FAIL — module `cel-evaluator.js` not found

**Step 3: Install CEL dependency**

Run: `cd packages/compiler && pnpm add @marcbachmann/cel-js`

**Step 4: Write minimal implementation**

Create `packages/compiler/src/platform/constructs/cel-evaluator.ts`:

```typescript
/**
 * CEL (Common Expression Language) Evaluator
 *
 * Wraps @marcbachmann/cel-js to provide the same evaluation interface
 * as the legacy ABL expression evaluator. CEL is an industry standard
 * used in Kubernetes, Firebase, and Envoy.
 *
 * All ABL domain functions are registered under the `abl.*` namespace.
 */

import { evaluate as celEvaluate } from '@marcbachmann/cel-js';

/**
 * Evaluate a CEL expression and return the result.
 * Used for value resolution (SET assignments, computed values).
 */
export function evaluateCel(expression: string, context: Record<string, unknown>): unknown {
  try {
    return celEvaluate(expression, context);
  } catch (err) {
    throw new Error(
      `CEL evaluation failed for "${expression}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Evaluate a CEL expression as a boolean condition.
 * Used for constraint conditions, flow branching, completion checks.
 */
export function evaluateCelCondition(
  expression: string,
  context: Record<string, unknown>,
): boolean {
  const result = evaluateCel(expression, context);
  return Boolean(result);
}
```

**Step 5: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/cel-evaluator.test.ts`
Expected: PASS (or partial pass — adjust wrapper based on `@marcbachmann/cel-js` API)

**Step 6: Adjust wrapper for library API**

The `@marcbachmann/cel-js` API may differ from the simple `evaluate(expr, ctx)` signature. Read the library's README and adjust the wrapper. Key things to check:

- How to pass context/variables
- How `has()` macro works (may need special handling)
- How string methods (`.contains()`, `.matches()`, `.startsWith()`) are supported
- Whether `in` operator works on arrays

Update the wrapper and tests as needed based on actual library API.

**Step 7: Commit**

```bash
git add packages/compiler/package.json packages/compiler/src/platform/constructs/cel-evaluator.ts packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts pnpm-lock.yaml
git commit -m "[ABLP-2] feat(compiler): add CEL evaluator wrapper with @marcbachmann/cel-js"
```

---

## Task 2: Register ABL Custom Functions in CEL

**Files:**

- Create: `packages/compiler/src/platform/constructs/cel-functions.ts`
- Create: `packages/compiler/src/__tests__/constructs/cel-functions.test.ts`
- Modify: `packages/compiler/src/platform/constructs/cel-evaluator.ts`

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/constructs/cel-functions.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { evaluateCel } from '../../platform/constructs/cel-evaluator.js';

describe('ABL Custom Functions in CEL', () => {
  describe('String functions', () => {
    test('abl.upper()', () => {
      expect(evaluateCel('abl.upper(name)', { name: 'john' })).toBe('JOHN');
    });

    test('abl.lower()', () => {
      expect(evaluateCel('abl.lower(name)', { name: 'JOHN' })).toBe('john');
    });

    test('abl.trim()', () => {
      expect(evaluateCel('abl.trim(name)', { name: '  hello  ' })).toBe('hello');
    });

    test('abl.mask() with last4', () => {
      expect(evaluateCel('abl.mask(ssn, "last4")', { ssn: '123-45-6789' })).toBe('*******6789');
    });
  });

  describe('Numeric functions', () => {
    test('abl.round()', () => {
      expect(evaluateCel('abl.round(3.14159, 2)', {})).toBe(3.14);
    });

    test('abl.abs()', () => {
      expect(evaluateCel('abl.abs(-5)', {})).toBe(5);
    });

    test('abl.format_currency()', () => {
      const result = evaluateCel('abl.format_currency(1234.5, "USD")', {});
      expect(result).toContain('1,234.50');
    });
  });

  describe('Date functions', () => {
    test('abl.now() returns ISO string', () => {
      const result = evaluateCel('abl.now()', {});
      expect(typeof result).toBe('string');
      expect(() => new Date(result as string)).not.toThrow();
    });
  });

  describe('Utility functions', () => {
    test('abl.coalesce() returns first non-null', () => {
      expect(evaluateCel('abl.coalesce(a, b, "default")', { a: null, b: 'hello' })).toBe('hello');
    });

    test('abl.length()', () => {
      expect(evaluateCel('abl.length(items)', { items: [1, 2, 3] })).toBe(3);
      expect(evaluateCel('abl.length(name)', { name: 'hello' })).toBe(5);
    });
  });

  describe('Type checking functions', () => {
    test('abl.is_array()', () => {
      expect(evaluateCel('abl.is_array(items)', { items: [1, 2] })).toBe(true);
      expect(evaluateCel('abl.is_array(name)', { name: 'hello' })).toBe(false);
    });

    test('abl.is_number()', () => {
      expect(evaluateCel('abl.is_number(age)', { age: 25 })).toBe(true);
      expect(evaluateCel('abl.is_number(name)', { name: 'hello' })).toBe(false);
    });

    test('abl.to_number()', () => {
      expect(evaluateCel('abl.to_number("42")', {})).toBe(42);
    });
  });

  describe('Array functions', () => {
    test('abl.array_find()', () => {
      const ctx = {
        items: [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
      };
      expect(evaluateCel('abl.array_find(items, "id", 2)', ctx)).toEqual({ id: 2, name: 'b' });
    });
  });

  describe('Object functions', () => {
    test('abl.object_keys()', () => {
      expect(evaluateCel('abl.object_keys(user)', { user: { name: 'John', age: 30 } })).toEqual([
        'name',
        'age',
      ]);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/cel-functions.test.ts`
Expected: FAIL — `abl.upper` etc. not recognized by CEL evaluator

**Step 3: Implement custom function registry**

Create `packages/compiler/src/platform/constructs/cel-functions.ts`:

```typescript
/**
 * ABL Custom Function Library for CEL
 *
 * Registers domain-specific functions under the `abl.*` namespace.
 * These extend CEL's built-in functions with ABL-specific operations.
 *
 * All functions are pure (no side effects, no I/O) except:
 * - abl.now() — returns current timestamp
 * - abl.unique_id() — generates random ID
 */

const MAX_STRING_LENGTH = 100_000;

// Intl.NumberFormat cache (same as legacy evaluator)
const currencyFormatters = new Map<string, Intl.NumberFormat>();
const MAX_FORMATTER_CACHE = 64;

function getCurrencyFormatter(currency: string, locale?: string): Intl.NumberFormat {
  const key = `${currency}:${locale ?? 'default'}`;
  let fmt = currencyFormatters.get(key);
  if (!fmt) {
    if (currencyFormatters.size >= MAX_FORMATTER_CACHE) {
      const firstKey = currencyFormatters.keys().next().value;
      if (firstKey) currencyFormatters.delete(firstKey);
    }
    fmt = new Intl.NumberFormat(locale ?? 'en-US', { style: 'currency', currency });
    currencyFormatters.set(key, fmt);
  }
  return fmt;
}

/**
 * All ABL custom functions organized by category.
 * Each function takes its arguments as positional parameters.
 */
export const ablFunctions: Record<string, (...args: unknown[]) => unknown> = {
  // --- String ---
  'abl.upper': (s: unknown) =>
    typeof s === 'string' ? s.toUpperCase() : String(s ?? '').toUpperCase(),
  'abl.lower': (s: unknown) =>
    typeof s === 'string' ? s.toLowerCase() : String(s ?? '').toLowerCase(),
  'abl.trim': (s: unknown) => String(s ?? '').trim(),
  'abl.substring': (s: unknown, start: unknown, end?: unknown) => {
    const str = String(s ?? '');
    return end !== undefined
      ? str.substring(Number(start), Number(end))
      : str.substring(Number(start));
  },
  'abl.replace': (s: unknown, find: unknown, repl: unknown) =>
    String(s ?? '')
      .split(String(find))
      .join(String(repl)),
  'abl.split': (s: unknown, delim: unknown) => String(s ?? '').split(String(delim)),
  'abl.join': (arr: unknown, delim: unknown) =>
    Array.isArray(arr) ? arr.join(String(delim ?? ',')) : String(arr ?? ''),
  'abl.pad_start': (s: unknown, len: unknown, ch?: unknown) =>
    String(s ?? '').padStart(Number(len), String(ch ?? ' ')),
  'abl.pad_end': (s: unknown, len: unknown, ch?: unknown) =>
    String(s ?? '').padEnd(Number(len), String(ch ?? ' ')),
  'abl.repeat': (s: unknown, count: unknown) => {
    const str = String(s ?? '');
    const n = Math.min(
      Math.max(0, Math.floor(Number(count))),
      Math.floor(MAX_STRING_LENGTH / (str.length || 1)),
    );
    return str.repeat(n);
  },

  // --- Numeric ---
  'abl.round': (n: unknown, decimals?: unknown) => {
    const num = Number(n);
    const d = Number(decimals ?? 0);
    const factor = Math.pow(10, d);
    return Math.round(num * factor) / factor;
  },
  'abl.abs': (n: unknown) => Math.abs(Number(n)),
  'abl.min': (a: unknown, b: unknown) => Math.min(Number(a), Number(b)),
  'abl.max': (a: unknown, b: unknown) => Math.max(Number(a), Number(b)),

  // --- Formatting ---
  'abl.mask': (s: unknown, pattern: unknown, ch?: unknown) => {
    const str = String(s ?? '');
    const maskChar = String(ch ?? '*');
    const pat = String(pattern);
    if (pat === 'last4') return maskChar.repeat(Math.max(0, str.length - 4)) + str.slice(-4);
    if (pat === 'first4') return str.slice(0, 4) + maskChar.repeat(Math.max(0, str.length - 4));
    // N*N pattern: show first N and last N chars
    const match = pat.match(/^(\d+)\*(\d+)$/);
    if (match) {
      const [, left, right] = match;
      const l = Number(left);
      const r = Number(right);
      return str.slice(0, l) + maskChar.repeat(Math.max(0, str.length - l - r)) + str.slice(-r);
    }
    return maskChar.repeat(str.length);
  },
  'abl.format_currency': (n: unknown, currency: unknown, locale?: unknown) => {
    return getCurrencyFormatter(String(currency), locale ? String(locale) : undefined).format(
      Number(n),
    );
  },
  'abl.format_date': (d: unknown, fmt: unknown, _tz?: unknown) => {
    const date = new Date(String(d));
    if (isNaN(date.getTime())) return String(d);
    const format = String(fmt);
    return format
      .replace('YYYY', String(date.getFullYear()))
      .replace('MM', String(date.getMonth() + 1).padStart(2, '0'))
      .replace('DD', String(date.getDate()).padStart(2, '0'))
      .replace('HH', String(date.getHours()).padStart(2, '0'))
      .replace('mm', String(date.getMinutes()).padStart(2, '0'))
      .replace('ss', String(date.getSeconds()).padStart(2, '0'));
  },
  'abl.ordinal': (n: unknown) => {
    const num = Number(n);
    const s = ['th', 'st', 'nd', 'rd'];
    const v = num % 100;
    return num + (s[(v - 20) % 10] || s[v] || s[0]);
  },

  // --- Type Checking ---
  'abl.is_array': (x: unknown) => Array.isArray(x),
  'abl.is_number': (x: unknown) => typeof x === 'number' && !isNaN(x),
  'abl.is_string': (x: unknown) => typeof x === 'string',
  'abl.to_number': (x: unknown) => {
    const n = Number(x);
    return isNaN(n) ? null : n;
  },
  'abl.to_string': (x: unknown) => String(x ?? ''),

  // --- Array ---
  'abl.length': (x: unknown) => {
    if (Array.isArray(x)) return x.length;
    if (typeof x === 'string') return x.length;
    return 0;
  },
  'abl.array_find': (arr: unknown, field: unknown, value: unknown) => {
    if (!Array.isArray(arr)) return null;
    return (
      arr.find(
        (item: Record<string, unknown>) =>
          item && typeof item === 'object' && item[String(field)] === value,
      ) ?? null
    );
  },
  'abl.array_find_index': (arr: unknown, field: unknown, value: unknown) => {
    if (!Array.isArray(arr)) return -1;
    return arr.findIndex(
      (item: Record<string, unknown>) =>
        item && typeof item === 'object' && item[String(field)] === value,
    );
  },

  // --- Object ---
  'abl.object_keys': (obj: unknown) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [],
  'abl.object_values': (obj: unknown) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj) : [],
  'abl.object_merge': (...objs: unknown[]) =>
    Object.assign({}, ...objs.filter((o) => o && typeof o === 'object')),

  // --- Utility ---
  'abl.coalesce': (...args: unknown[]) => args.find((a) => a !== null && a !== undefined) ?? null,
  'abl.now': () => new Date().toISOString(),
  'abl.unique_id': (len?: unknown) => {
    const length = Number(len ?? 6);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },
};
```

**Step 4: Update CEL evaluator to register custom functions**

Modify `packages/compiler/src/platform/constructs/cel-evaluator.ts` to pass `ablFunctions` to the CEL evaluator. The exact integration depends on `@marcbachmann/cel-js` API for custom function registration. Check the library docs for how to register functions.

**Step 5: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/cel-functions.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/constructs/cel-functions.ts packages/compiler/src/__tests__/constructs/cel-functions.test.ts packages/compiler/src/platform/constructs/cel-evaluator.ts
git commit -m "[ABLP-2] feat(compiler): register 35 ABL custom functions in CEL evaluator"
```

---

## Task 3: Expression Syntax Migration Utility

**Files:**

- Create: `packages/compiler/src/platform/constructs/expression-migrator.ts`
- Create: `packages/compiler/src/__tests__/constructs/expression-migrator.test.ts`

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/constructs/expression-migrator.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import {
  migrateExpression,
  isLegacyExpression,
} from '../../platform/constructs/expression-migrator.js';

describe('Expression Migrator', () => {
  describe('isLegacyExpression', () => {
    test('detects ABL-style logical operators', () => {
      expect(isLegacyExpression('age >= 18 AND name != ""')).toBe(true);
      expect(isLegacyExpression('a OR b')).toBe(true);
      expect(isLegacyExpression('NOT active')).toBe(true);
    });

    test('detects ABL-style functions', () => {
      expect(isLegacyExpression('UPPER(name)')).toBe(true);
      expect(isLegacyExpression('FORMAT_CURRENCY(amount, "USD")')).toBe(true);
    });

    test('does not flag CEL expressions', () => {
      expect(isLegacyExpression('age >= 18 && name != ""')).toBe(false);
      expect(isLegacyExpression('abl.upper(name)')).toBe(false);
      expect(isLegacyExpression('has(name)')).toBe(false);
    });

    test('does not flag AND/OR inside quoted strings', () => {
      expect(isLegacyExpression('"value AND other"')).toBe(false);
    });
  });

  describe('migrateExpression', () => {
    test('converts logical operators', () => {
      expect(migrateExpression('age >= 18 AND name != ""')).toBe('age >= 18 && name != ""');
      expect(migrateExpression('a OR b')).toBe('a || b');
      expect(migrateExpression('NOT active')).toBe('!active');
    });

    test('converts CONTAINS to method syntax', () => {
      expect(migrateExpression('email CONTAINS "@"')).toBe('email.contains("@")');
    });

    test('converts MATCHES to method syntax', () => {
      expect(migrateExpression('phone MATCHES "^\\d{10}$"')).toBe('phone.matches("^\\\\d{10}$")');
    });

    test('converts IS SET to has()', () => {
      expect(migrateExpression('policy_number IS SET')).toBe('has(policy_number)');
    });

    test('converts IS NOT SET to !has()', () => {
      expect(migrateExpression('policy_number IS NOT SET')).toBe('!has(policy_number)');
    });

    test('converts built-in functions to abl.* namespace', () => {
      expect(migrateExpression('UPPER(name)')).toBe('abl.upper(name)');
      expect(migrateExpression('ADD(price, tax)')).toBe('price + tax');
      expect(migrateExpression('SUB(a, b)')).toBe('a - b');
      expect(migrateExpression('MUL(a, b)')).toBe('a * b');
      expect(migrateExpression('DIV(a, b)')).toBe('a / b');
      expect(migrateExpression('LENGTH(items)')).toBe('size(items)');
      expect(migrateExpression('FORMAT_CURRENCY(amount, "USD")')).toBe(
        'abl.format_currency(amount, "USD")',
      );
      expect(migrateExpression('MASK(ssn, "last4")')).toBe('abl.mask(ssn, "last4")');
      expect(migrateExpression('COALESCE(a, b)')).toBe('abl.coalesce(a, b)');
    });

    test('handles compound expressions', () => {
      expect(
        migrateExpression('age >= 18 AND UPPER(status) == "ACTIVE" AND email CONTAINS "@"'),
      ).toBe('age >= 18 && abl.upper(status) == "ACTIVE" && email.contains("@")');
    });

    test('preserves already-valid CEL', () => {
      expect(migrateExpression('age >= 18 && name != ""')).toBe('age >= 18 && name != ""');
      expect(migrateExpression('has(name)')).toBe('has(name)');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/expression-migrator.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the migrator**

Create `packages/compiler/src/platform/constructs/expression-migrator.ts`:

```typescript
/**
 * Expression Syntax Migrator: ABL Custom → CEL
 *
 * Converts legacy ABL expression syntax to CEL syntax.
 * Used during the transition period to support both old and new formats.
 * Also used by the migration CLI tool to rewrite .abl files.
 */

/** ABL built-in functions that map directly to arithmetic operators in CEL */
const ARITHMETIC_MAP: Record<string, string> = {
  ADD: '+',
  SUB: '-',
  MUL: '*',
  DIV: '/',
};

/** ABL functions that map to CEL built-ins */
const CEL_BUILTIN_MAP: Record<string, string> = {
  LENGTH: 'size',
};

/** ABL functions that map to abl.* namespace */
const ABL_NAMESPACE_FUNCTIONS = new Set([
  'UPPER',
  'LOWER',
  'TRIM',
  'SUBSTRING',
  'REPLACE',
  'SPLIT',
  'JOIN',
  'PAD_START',
  'PAD_END',
  'REPEAT',
  'ROUND',
  'ABS',
  'MIN',
  'MAX',
  'MASK',
  'FORMAT_CURRENCY',
  'FORMAT_DATE',
  'ORDINAL',
  'IS_ARRAY',
  'IS_NUMBER',
  'IS_STRING',
  'TO_NUMBER',
  'TO_STRING',
  'ARRAY_FIND',
  'ARRAY_FIND_INDEX',
  'OBJECT_KEYS',
  'OBJECT_VALUES',
  'OBJECT_MERGE',
  'COALESCE',
  'NOW',
  'UNIQUE_ID',
]);

/** All known ABL function names */
const ALL_ABL_FUNCTIONS = new Set([
  ...Object.keys(ARITHMETIC_MAP),
  ...Object.keys(CEL_BUILTIN_MAP),
  ...ABL_NAMESPACE_FUNCTIONS,
]);

/**
 * Check whether an expression uses legacy ABL syntax.
 * Returns false for already-valid CEL expressions.
 */
export function isLegacyExpression(expr: string): boolean {
  // Strip quoted strings to avoid false positives
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  // Check for ABL logical operators (word-boundary match)
  if (/\bAND\b/.test(stripped) || /\bOR\b/.test(stripped) || /\bNOT\b/.test(stripped)) {
    return true;
  }

  // Check for ABL-style CONTAINS/MATCHES (not method syntax)
  if (/\bCONTAINS\b/.test(stripped) || /\bMATCHES\b/.test(stripped)) {
    return true;
  }

  // Check for IS SET / IS NOT SET
  if (/\bIS\s+(NOT\s+)?SET\b/.test(stripped)) {
    return true;
  }

  // Check for ABL function calls (UPPERCASE function names)
  for (const fn of ALL_ABL_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(stripped)) {
      return true;
    }
  }

  return false;
}

/**
 * Migrate an ABL expression to CEL syntax.
 * If the expression is already valid CEL, returns it unchanged.
 */
export function migrateExpression(expr: string): string {
  let result = expr;

  // 1. Convert IS SET / IS NOT SET → has() / !has()
  result = result.replace(/(\w+(?:\.\w+)*)\s+IS\s+NOT\s+SET\b/g, '!has($1)');
  result = result.replace(/(\w+(?:\.\w+)*)\s+IS\s+SET\b/g, 'has($1)');

  // 2. Convert CONTAINS → .contains() (before logical operators to avoid conflicts)
  result = result.replace(
    /(\w+(?:\.\w+)*)\s+CONTAINS\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    '$1.contains($2)',
  );

  // 3. Convert MATCHES → .matches()
  result = result.replace(
    /(\w+(?:\.\w+)*)\s+MATCHES\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    '$1.matches($2)',
  );

  // 4. Convert arithmetic functions: ADD(a, b) → a + b
  for (const [fn, op] of Object.entries(ARITHMETIC_MAP)) {
    const regex = new RegExp(`\\b${fn}\\s*\\(\\s*([^,]+?)\\s*,\\s*([^)]+?)\\s*\\)`, 'g');
    result = result.replace(regex, `$1 ${op} $2`);
  }

  // 5. Convert CEL-builtin mapped functions: LENGTH(x) → size(x)
  for (const [fn, celFn] of Object.entries(CEL_BUILTIN_MAP)) {
    const regex = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    result = result.replace(regex, `${celFn}(`);
  }

  // 6. Convert abl.* namespace functions: UPPER(x) → abl.upper(x)
  for (const fn of ABL_NAMESPACE_FUNCTIONS) {
    const regex = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    result = result.replace(regex, `abl.${fn.toLowerCase()}(`);
  }

  // 7. Convert logical operators (word-boundary, outside quotes)
  // Process from inside out to handle nested expressions
  result = result.replace(/\bNOT\s+/g, '!');
  result = result.replace(/\s+AND\s+/g, ' && ');
  result = result.replace(/\s+OR\s+/g, ' || ');

  return result;
}

/**
 * Auto-detect expression format and evaluate.
 * If legacy ABL syntax, migrate to CEL first.
 */
export function normalizeExpression(expr: string): string {
  if (isLegacyExpression(expr)) {
    return migrateExpression(expr);
  }
  return expr;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/expression-migrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/expression-migrator.ts packages/compiler/src/__tests__/constructs/expression-migrator.test.ts
git commit -m "[ABLP-2] feat(compiler): add ABL-to-CEL expression syntax migrator"
```

---

## Task 4: Dual-Mode Evaluator (Legacy ABL + CEL)

**Files:**

- Create: `packages/compiler/src/platform/constructs/dual-evaluator.ts`
- Create: `packages/compiler/src/__tests__/constructs/dual-evaluator.test.ts`
- Modify: `packages/compiler/src/platform/constructs/evaluator.ts` (add re-export)

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/constructs/dual-evaluator.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import {
  evaluateConditionDual,
  resolveValueDual,
} from '../../platform/constructs/dual-evaluator.js';

describe('Dual-Mode Evaluator', () => {
  const context = { age: 25, name: 'John', status: 'active', email: 'john@example.com' };

  describe('evaluateConditionDual', () => {
    test('evaluates legacy ABL expressions', () => {
      expect(evaluateConditionDual('age >= 18 AND name != ""', context)).toBe(true);
      expect(evaluateConditionDual('status IN ["active", "pending"]', context)).toBe(true);
      expect(evaluateConditionDual('email CONTAINS "@"', context)).toBe(true);
    });

    test('evaluates CEL expressions', () => {
      expect(evaluateConditionDual('age >= 18 && name != ""', context)).toBe(true);
      expect(evaluateConditionDual('email.contains("@")', context)).toBe(true);
      expect(evaluateConditionDual('has(name)', context)).toBe(true);
    });

    test('evaluates CEL with abl.* functions', () => {
      expect(evaluateConditionDual('abl.upper(name) == "JOHN"', context)).toBe(true);
    });

    test('auto-detects and migrates legacy expressions', () => {
      // This should work even though it's ABL syntax — migrated to CEL internally
      expect(evaluateConditionDual('UPPER(name) == "JOHN"', context)).toBe(true);
    });
  });

  describe('resolveValueDual', () => {
    test('resolves legacy ABL expressions', () => {
      expect(resolveValueDual('UPPER(name)', context)).toBe('JOHN');
      expect(resolveValueDual('ADD(age, 5)', context)).toBe(30);
    });

    test('resolves CEL expressions', () => {
      expect(resolveValueDual('abl.upper(name)', context)).toBe('JOHN');
      expect(resolveValueDual('age + 5', context)).toBe(30);
    });

    test('resolves simple variable paths', () => {
      expect(resolveValueDual('name', context)).toBe('John');
    });

    test('resolves string literals', () => {
      expect(resolveValueDual('"hello"', context)).toBe('hello');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/dual-evaluator.test.ts`
Expected: FAIL

**Step 3: Implement dual evaluator**

Create `packages/compiler/src/platform/constructs/dual-evaluator.ts`:

```typescript
/**
 * Dual-Mode Expression Evaluator
 *
 * Supports both legacy ABL expression syntax and new CEL syntax.
 * Auto-detects expression format and routes to the appropriate evaluator.
 *
 * During the transition period, both formats are accepted:
 * - Legacy: `age >= 18 AND UPPER(name) == "JOHN"`
 * - CEL:    `age >= 18 && abl.upper(name) == "JOHN"`
 *
 * Legacy expressions are automatically migrated to CEL before evaluation.
 */

import { isLegacyExpression, migrateExpression } from './expression-migrator.js';
import { evaluateCel, evaluateCelCondition } from './cel-evaluator.js';
import {
  evaluateCondition as legacyEvaluateCondition,
  resolveValue as legacyResolveValue,
} from './evaluator.js';

type EvaluationContext = Record<string, unknown>;

/**
 * Evaluate a condition expression supporting both ABL and CEL syntax.
 *
 * Strategy:
 * 1. If expression uses legacy ABL syntax → migrate to CEL, evaluate with CEL
 * 2. If expression uses CEL syntax → evaluate directly with CEL
 * 3. If CEL evaluation fails → fall back to legacy evaluator
 */
export function evaluateConditionDual(expression: string, context: EvaluationContext): boolean {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;

  try {
    return evaluateCelCondition(celExpr, context);
  } catch {
    // Fallback to legacy evaluator for edge cases during transition
    return legacyEvaluateCondition(expression, context);
  }
}

/**
 * Resolve a value expression supporting both ABL and CEL syntax.
 *
 * Handles: variable paths, literals, function calls, arithmetic.
 */
export function resolveValueDual(expression: string, context: EvaluationContext): unknown {
  const celExpr = isLegacyExpression(expression) ? migrateExpression(expression) : expression;

  try {
    return evaluateCel(celExpr, context);
  } catch {
    // Fallback to legacy resolver
    return legacyResolveValue(expression, context);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/dual-evaluator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/dual-evaluator.ts packages/compiler/src/__tests__/constructs/dual-evaluator.test.ts
git commit -m "[ABLP-2] feat(compiler): add dual-mode evaluator for ABL/CEL transition"
```

---

## Task 5: Wire Dual Evaluator into Compiler Exports

**Files:**

- Modify: `packages/compiler/src/index.ts` (add new exports)
- Modify: `packages/compiler/src/platform/constructs/evaluator.ts` (re-export dual functions)

**Step 1: Read current exports**

Read `packages/compiler/src/index.ts` to find where `evaluateCondition` and `resolveValue` are exported. Also check all imports of these functions in the runtime:

- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/constraint-checker.ts`
- `apps/runtime/src/services/execution/value-resolution.ts`

**Step 2: Add new exports to compiler index**

Add to `packages/compiler/src/index.ts`:

```typescript
// CEL evaluator (new)
export { evaluateCel, evaluateCelCondition } from './platform/constructs/cel-evaluator.js';
export { evaluateConditionDual, resolveValueDual } from './platform/constructs/dual-evaluator.js';
export {
  isLegacyExpression,
  migrateExpression,
  normalizeExpression,
} from './platform/constructs/expression-migrator.js';
export { ablFunctions } from './platform/constructs/cel-functions.js';
```

**Step 3: Run full compiler test suite**

Run: `cd packages/compiler && npx vitest run`
Expected: All existing tests PASS (no regressions)

**Step 4: Commit**

```bash
git add packages/compiler/src/index.ts
git commit -m "[ABLP-2] feat(compiler): export CEL evaluator and migration utilities"
```

---

## Task 6: Wire Dual Evaluator into Runtime

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts`
- Create: `apps/runtime/src/__tests__/cel-runtime-integration.test.ts`

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/cel-runtime-integration.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { evaluateConditionDual, resolveValueDual } from '@abl/compiler';

describe('CEL Runtime Integration', () => {
  const sessionContext = {
    user: { name: 'John', age: 25, email: 'john@example.com' },
    claim: { status: 'pending', amount: 1500 },
    gathered: { policy_number: 'POL-123' },
  };

  test('evaluates CEL constraint conditions with nested paths', () => {
    expect(
      evaluateConditionDual('user.age >= 18 && has(gathered.policy_number)', sessionContext),
    ).toBe(true);
  });

  test('evaluates CEL with abl.* functions in runtime context', () => {
    expect(evaluateConditionDual('abl.upper(claim.status) == "PENDING"', sessionContext)).toBe(
      true,
    );
  });

  test('resolves CEL value expressions for SET assignments', () => {
    expect(resolveValueDual('abl.format_currency(claim.amount, "USD")', sessionContext)).toContain(
      '1,500',
    );
  });

  test('legacy ABL expressions still work via migration', () => {
    expect(
      evaluateConditionDual('user.age >= 18 AND gathered.policy_number IS SET', sessionContext),
    ).toBe(true);
    expect(resolveValueDual('UPPER(user.name)', sessionContext)).toBe('JOHN');
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/cel-runtime-integration.test.ts`
Expected: PASS (uses already-exported dual evaluator)

**Step 3: Update runtime imports to use dual evaluator**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, find all imports of `evaluateCondition` and `resolveValue` from `@abl/compiler`. Add parallel imports of the dual versions. Initially keep both — the runtime can switch to dual versions behind a feature flag or gradually.

**Key principle:** Don't break existing runtime behavior. The dual evaluator falls back to legacy on failure. Replace imports incrementally.

**Step 4: Run full runtime test suite**

Run: `pnpm --filter @agent-platform/runtime test`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/__tests__/cel-runtime-integration.test.ts apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/services/execution/constraint-checker.ts
git commit -m "[ABLP-2] feat(runtime): wire dual CEL/ABL evaluator into runtime execution"
```

---

## Task 7: YAML Parser Path

**Files:**

- Create: `packages/core/src/parser/yaml-parser.ts`
- Create: `packages/core/src/__tests__/yaml-parser.test.ts`
- Modify: `packages/core/package.json` (add `js-yaml` dependency)

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/yaml-parser.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { parseYamlABL, isYamlFormat } from '../parser/yaml-parser.js';

const SIMPLE_AGENT_YAML = `
agent: TestAgent
mode: reasoning
goal: "Help users with testing"
persona: |
  A helpful test assistant.
tools:
  - name: search
    description: "Search for information"
    type: http
    parameters:
      - name: query
        type: string
        required: true
    returns:
      type: object
complete:
  - when: "task_done == true"
    respond: "Task completed successfully."
`;

describe('YAML Parser', () => {
  describe('isYamlFormat', () => {
    test('detects YAML format (lowercase keys)', () => {
      expect(isYamlFormat(SIMPLE_AGENT_YAML)).toBe(true);
    });

    test('detects legacy ABL format (uppercase keys)', () => {
      expect(isYamlFormat('AGENT: TestAgent\nMODE: reasoning')).toBe(false);
    });
  });

  describe('parseYamlABL', () => {
    test('parses a simple reasoning agent', () => {
      const result = parseYamlABL(SIMPLE_AGENT_YAML);
      expect(result.errors).toHaveLength(0);

      const doc = result.document;
      expect(doc.meta.name).toBe('TestAgent');
      expect(doc.mode).toBe('reasoning');
      expect(doc.goal).toBe('Help users with testing');
      expect(doc.tools).toHaveLength(1);
      expect(doc.tools[0].name).toBe('search');
      expect(doc.complete).toHaveLength(1);
    });

    test('parses tools with parameters', () => {
      const result = parseYamlABL(SIMPLE_AGENT_YAML);
      const tool = result.document.tools[0];
      expect(tool.parameters).toHaveLength(1);
      expect(tool.parameters[0].name).toBe('query');
      expect(tool.parameters[0].type).toBe('string');
      expect(tool.parameters[0].required).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/yaml-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Install js-yaml**

Run: `cd packages/core && pnpm add js-yaml && pnpm add -D @types/js-yaml`

**Step 4: Implement YAML parser**

Create `packages/core/src/parser/yaml-parser.ts`. This parser uses `js-yaml` to parse valid YAML, then maps the resulting object structure to the same `AgentBasedDocument` type that the legacy parser produces.

The implementation should:

1. Parse YAML with `yaml.load(content)`
2. Map lowercase keys to the expected `AgentBasedDocument` structure
3. Handle all sections: agent, mode, goal, persona, tools, gather, constraints, flow, handoff, delegate, escalate, complete, memory, on_start, on_error, guardrails, execution, messages, hooks, nlu
4. Return `{ document, errors, warnings }` matching the legacy parser's return type

**Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/yaml-parser.test.ts`
Expected: PASS

**Step 6: Add more comprehensive test cases**

Add tests for:

- Agent with gather fields (typed, validation rules)
- Agent with constraints (CEL conditions, on_fail actions)
- Agent with flow steps (transitions, branching)
- Agent with coordination (handoff, delegate, escalate)
- Agent with memory section
- Supervisor agent
- Error cases (invalid YAML, missing required fields)

**Step 7: Commit**

```bash
git add packages/core/package.json packages/core/src/parser/yaml-parser.ts packages/core/src/__tests__/yaml-parser.test.ts pnpm-lock.yaml
git commit -m "[ABLP-2] feat(core): add YAML parser path for ABL files"
```

---

## Task 8: Dual-Format Compilation Entry Point

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Create: `packages/compiler/src/__tests__/dual-format-compilation.test.ts`

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/dual-format-compilation.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

const YAML_AGENT = `
agent: TestAgent
mode: reasoning
goal: "Help users"
persona: "A helpful assistant."
tools:
  - name: search
    description: "Search for information"
    type: http
    parameters:
      - name: query
        type: string
        required: true
    returns:
      type: object
complete:
  - when: "task_done == true"
    respond: "Done."
`;

const LEGACY_AGENT = `
AGENT: TestAgent
MODE: reasoning
GOAL: "Help users"
PERSONA: "A helpful assistant."
TOOLS:
  - name: search
    description: "Search for information"
    type: http
    parameters:
      - name: query
        type: string
        required: true
    returns:
      type: object
COMPLETE:
  - WHEN: task_done
    RESPOND: "Done."
`;

describe('Dual-Format Compilation', () => {
  test('compiles YAML-format agent to IR', () => {
    // This test requires the compiler to accept YAML-parsed documents
    const parsed = parseAgentBasedABL(YAML_AGENT);
    const result = compileABLtoIR([parsed]);
    expect(result.agents).toBeDefined();
    const agentNames = Object.keys(result.agents);
    expect(agentNames).toContain('TestAgent');
  });

  test('compiles legacy ABL-format agent to IR', () => {
    const parsed = parseAgentBasedABL(LEGACY_AGENT);
    const result = compileABLtoIR([parsed]);
    expect(result.agents).toBeDefined();
    const agentNames = Object.keys(result.agents);
    expect(agentNames).toContain('TestAgent');
  });

  test('both formats produce equivalent IR', () => {
    const yamlParsed = parseAgentBasedABL(YAML_AGENT);
    const legacyParsed = parseAgentBasedABL(LEGACY_AGENT);

    const yamlIR = compileABLtoIR([yamlParsed]);
    const legacyIR = compileABLtoIR([legacyParsed]);

    const yamlAgent = Object.values(yamlIR.agents)[0];
    const legacyAgent = Object.values(legacyIR.agents)[0];

    // Core properties should match
    expect(yamlAgent.metadata.name).toBe(legacyAgent.metadata.name);
    expect(yamlAgent.execution.mode).toBe(legacyAgent.execution.mode);
    expect(yamlAgent.identity.goal).toBe(legacyAgent.identity.goal);
    expect(yamlAgent.tools.filter((t) => !t.system).length).toBe(
      legacyAgent.tools.filter((t) => !t.system).length,
    );
  });
});
```

**Step 2: Run test to verify current behavior**

Run: `cd packages/compiler && npx vitest run src/__tests__/dual-format-compilation.test.ts`
Expected: The YAML format test may fail if `parseAgentBasedABL` doesn't handle lowercase keys yet.

**Step 3: Update parseAgentBasedABL to auto-detect format**

Modify `packages/core/src/parser/agent-based-parser.ts` to add format detection at the top of `parseAgentBasedABL()`:

```typescript
import { isYamlFormat, parseYamlABL } from './yaml-parser.js';

export function parseAgentBasedABL(content: string): ParseResult {
  // Auto-detect YAML format (lowercase keys) vs legacy ABL (uppercase keys)
  if (isYamlFormat(content)) {
    return parseYamlABL(content);
  }

  // Existing legacy parser logic...
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/dual-format-compilation.test.ts`
Expected: PASS

**Step 5: Run full test suite to verify no regressions**

Run: `pnpm build && pnpm --filter @abl/core test && pnpm --filter @abl/compiler test`
Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/parser/agent-based-parser.ts packages/compiler/src/__tests__/dual-format-compilation.test.ts
git commit -m "[ABLP-2] feat(core): auto-detect YAML vs legacy ABL format in parser"
```

---

## Task 9: ABL YAML JSON Schema

**Files:**

- Create: `packages/core/src/schema/abl-schema.json`
- Create: `packages/core/src/__tests__/abl-schema.test.ts`
- Modify: `packages/core/package.json` (add `ajv` for tests)

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/abl-schema.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import Ajv from 'ajv';
import ablSchema from '../schema/abl-schema.json';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(ablSchema);

describe('ABL YAML JSON Schema', () => {
  test('validates a minimal reasoning agent', () => {
    const doc = {
      agent: 'TestAgent',
      mode: 'reasoning',
      goal: 'Help users',
    };
    expect(validate(doc)).toBe(true);
  });

  test('validates an agent with tools', () => {
    const doc = {
      agent: 'TestAgent',
      mode: 'reasoning',
      goal: 'Help users',
      tools: [
        {
          name: 'search',
          description: 'Search for info',
          type: 'http',
          parameters: [{ name: 'query', type: 'string', required: true }],
          returns: { type: 'object' },
        },
      ],
    };
    expect(validate(doc)).toBe(true);
  });

  test('rejects missing agent name', () => {
    const doc = { mode: 'reasoning', goal: 'Help users' };
    expect(validate(doc)).toBe(false);
  });

  test('rejects invalid mode', () => {
    const doc = { agent: 'Test', mode: 'invalid', goal: 'Help' };
    expect(validate(doc)).toBe(false);
  });

  test('validates gather fields', () => {
    const doc = {
      agent: 'TestAgent',
      mode: 'reasoning',
      goal: 'Collect info',
      gather: {
        fields: [
          {
            name: 'email',
            type: 'string',
            prompt: 'What is your email?',
            required: true,
          },
        ],
      },
    };
    expect(validate(doc)).toBe(true);
  });

  test('validates constraints with CEL conditions', () => {
    const doc = {
      agent: 'TestAgent',
      mode: 'reasoning',
      goal: 'Secure agent',
      constraints: [
        {
          condition: 'has(user_id) && user.verified == true',
          on_fail: { action: 'respond', message: 'Please verify your identity.' },
        },
      ],
    };
    expect(validate(doc)).toBe(true);
  });
});
```

**Step 2: Install ajv for tests**

Run: `cd packages/core && pnpm add -D ajv`

**Step 3: Create the JSON Schema**

Create `packages/core/src/schema/abl-schema.json` covering:

- `agent` (required string)
- `mode` (enum: reasoning, scripted)
- `goal` (string)
- `persona` (string)
- `tools` (array of tool objects)
- `gather` (object with fields array)
- `constraints` (array of constraint objects)
- `complete` (array of completion conditions)
- `flow` (object for scripted mode)
- `memory` (object)
- `handoff`, `delegate`, `escalate` (coordination)
- `set`, `clear` (state management)
- `extensions` (array of extension names)

Start with the most common sections. Add more as needed.

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/abl-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/schema/abl-schema.json packages/core/src/__tests__/abl-schema.test.ts packages/core/package.json pnpm-lock.yaml
git commit -m "[ABLP-2] feat(core): add JSON Schema for ABL YAML format"
```

---

## Task 10: Expression Migration CLI Tool

**Files:**

- Create: `packages/compiler/src/tools/migrate-expressions.ts`
- Create: `packages/compiler/src/__tests__/tools/migrate-expressions.test.ts`

**Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/tools/migrate-expressions.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { migrateAgentExpressions } from '../../tools/migrate-expressions.js';

describe('Agent Expression Migration', () => {
  test('migrates constraint conditions', () => {
    const dsl = `
AGENT: TestAgent
MODE: reasoning
GOAL: "Help users"
CONSTRAINTS:
  - REQUIRE: "age >= 18 AND verified IS SET"
    ON_FAIL: RESPOND "Must be 18+ and verified"
`;
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('age >= 18 && has(verified)');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      original: 'age >= 18 AND verified IS SET',
      migrated: 'age >= 18 && has(verified)',
    });
  });

  test('migrates completion conditions', () => {
    const dsl = `
AGENT: TestAgent
MODE: reasoning
GOAL: "Help users"
COMPLETE:
  - WHEN: task_done AND UPPER(status) == "COMPLETE"
    RESPOND: "Done"
`;
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('task_done && abl.upper(status) == "COMPLETE"');
  });

  test('migrates SET expressions', () => {
    const dsl = `
AGENT: TestAgent
MODE: reasoning
GOAL: "Help users"
FLOW:
  1. welcome
    SET: total = ADD(price, tax)
    THEN: next
`;
    const result = migrateAgentExpressions(dsl);
    expect(result.migratedContent).toContain('total = price + tax');
  });

  test('reports migration summary', () => {
    const dsl = `
AGENT: TestAgent
MODE: reasoning
GOAL: "Help users"
CONSTRAINTS:
  - REQUIRE: "name IS SET"
COMPLETE:
  - WHEN: done AND LENGTH(items) > 0
`;
    const result = migrateAgentExpressions(dsl);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/tools/migrate-expressions.test.ts`
Expected: FAIL

**Step 3: Implement the migration tool**

Create `packages/compiler/src/tools/migrate-expressions.ts`:

This tool:

1. Parses the ABL file to find all expression contexts (REQUIRE conditions, WHEN conditions, SET expressions, CHECK expressions, IF conditions)
2. Applies `migrateExpression()` from the expression migrator to each
3. Produces a modified file with migrated expressions
4. Returns a change report (original → migrated for each expression)

**Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/tools/migrate-expressions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/tools/migrate-expressions.ts packages/compiler/src/__tests__/tools/migrate-expressions.test.ts
git commit -m "[ABLP-2] feat(compiler): add CLI tool for migrating ABL expressions to CEL"
```

---

## Task 11: Comprehensive CEL Parity Tests

**Files:**

- Create: `packages/compiler/src/__tests__/constructs/cel-parity.test.ts`

**Step 1: Write parity tests**

Create `packages/compiler/src/__tests__/constructs/cel-parity.test.ts` that runs every test case from the existing `evaluator.test.ts` through both the legacy evaluator AND the dual evaluator, verifying identical results. This is the critical correctness test.

```typescript
import { describe, test, expect } from 'vitest';
import { evaluateCondition } from '../../platform/constructs/evaluator.js';
import { evaluateConditionDual } from '../../platform/constructs/dual-evaluator.js';

/**
 * Parity tests: every expression that works with the legacy evaluator
 * must produce the same result with the dual (CEL) evaluator.
 */
describe('CEL Parity Tests', () => {
  const testCases: Array<{ expr: string; context: Record<string, unknown>; expected: boolean }> = [
    // Comparisons
    { expr: 'age >= 18', context: { age: 25 }, expected: true },
    { expr: 'age >= 18', context: { age: 10 }, expected: false },
    { expr: 'name == "John"', context: { name: 'John' }, expected: true },
    { expr: 'name != "John"', context: { name: 'Jane' }, expected: true },
    { expr: 'count > 5', context: { count: 10 }, expected: true },
    { expr: 'count < 5', context: { count: 3 }, expected: true },
    { expr: 'count <= 5', context: { count: 5 }, expected: true },

    // Logical operators
    { expr: 'age >= 18 AND active', context: { age: 25, active: true }, expected: true },
    { expr: 'age >= 18 AND active', context: { age: 25, active: false }, expected: false },
    { expr: 'a OR b', context: { a: false, b: true }, expected: true },
    { expr: 'NOT active', context: { active: false }, expected: true },

    // Nested paths
    { expr: 'user.age >= 18', context: { user: { age: 25 } }, expected: true },
    {
      expr: 'user.profile.tier == "premium"',
      context: { user: { profile: { tier: 'premium' } } },
      expected: true,
    },

    // Contains
    { expr: 'email CONTAINS "@"', context: { email: 'user@example.com' }, expected: true },
    { expr: 'email CONTAINS "@"', context: { email: 'invalid' }, expected: false },

    // IS SET / IS NOT SET
    { expr: 'name IS SET', context: { name: 'John' }, expected: true },
    { expr: 'name IS SET', context: {}, expected: false },
    { expr: 'name IS NOT SET', context: {}, expected: true },

    // IN operator
    { expr: 'status IN ["active", "pending"]', context: { status: 'active' }, expected: true },
    { expr: 'status IN ["active", "pending"]', context: { status: 'closed' }, expected: false },
  ];

  for (const { expr, context, expected } of testCases) {
    test(`"${expr}" with ${JSON.stringify(context)} → ${expected}`, () => {
      const legacyResult = evaluateCondition(expr, context);
      const dualResult = evaluateConditionDual(expr, context);

      expect(legacyResult).toBe(expected);
      expect(dualResult).toBe(expected);
      expect(dualResult).toBe(legacyResult);
    });
  }
});
```

**Step 2: Run parity tests**

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/cel-parity.test.ts`
Expected: ALL PASS — legacy and dual evaluators produce identical results

**Step 3: Fix any parity failures**

If any test fails, the dual evaluator or expression migrator has a bug. Fix it. Common issues:

- Type coercion differences (CEL is stricter about types)
- Truthiness semantics (CEL vs JavaScript truthiness)
- Nested path resolution (CEL may handle undefined differently)
- IN operator semantics

**Step 4: Commit**

```bash
git add packages/compiler/src/__tests__/constructs/cel-parity.test.ts
git commit -m "[ABLP-2] test(compiler): add CEL parity tests verifying ABL/CEL behavioral equivalence"
```

---

## Task 12: Update Documentation

**Files:**

- Modify: `docs/plans/2026-02-26-abl-core-extensions-design.md` (mark Phase 1 as in-progress)
- Create: `docs/abl/CEL_MIGRATION_GUIDE.md`

**Step 1: Write the CEL migration guide**

Create `docs/abl/CEL_MIGRATION_GUIDE.md` covering:

- What changed and why
- Expression syntax comparison table (ABL → CEL)
- ABL custom function reference (`abl.*` namespace)
- Migration tool usage
- Backward compatibility guarantees
- Timeline for legacy syntax deprecation

**Step 2: Commit**

```bash
git add docs/abl/CEL_MIGRATION_GUIDE.md docs/plans/2026-02-26-abl-core-extensions-design.md
git commit -m "[ABLP-2] docs(compiler): add CEL migration guide and update design doc status"
```

---

## Dependency Order

```
Task 1 (CEL wrapper)
  ↓
Task 2 (Custom functions)  →  Task 3 (Expression migrator)
  ↓                                    ↓
Task 4 (Dual evaluator)  ←────────────┘
  ↓
Task 5 (Compiler exports)
  ↓
Task 6 (Runtime wiring)     Task 7 (YAML parser) → Task 8 (Dual-format compilation)
  ↓                                                          ↓
Task 11 (Parity tests)                            Task 9 (JSON Schema)
  ↓                                                          ↓
Task 10 (Migration CLI)                           Task 12 (Documentation)
```

Tasks 2 and 3 can run in parallel after Task 1. Tasks 7-9 can run in parallel with Tasks 4-6. Task 11 depends on Tasks 4-6. Task 12 is last.
