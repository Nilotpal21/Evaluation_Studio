# ABL Language Service Phase 2 — Smart Completions & Panel Enhancements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance the ABL language service with CEL function completions, value completions, gather field property completions, and improve the Studio editor with resizable panels, symbol tree search, and diagnostics source filtering.

**Architecture:** Pure-function additions to `@abl/language-service` (no new dependencies). Studio UI enhancements using `react-resizable-panels` (already installed). CEL function metadata extracted as a static registry for completions without importing the CEL runtime.

**Tech Stack:** TypeScript, Vitest, React, Monaco Editor, react-resizable-panels, lucide-react, next-intl

---

## Current State (Post Phase 1)

- `getCompletions()` handles: top-level keys (14), flow step keywords (10), tool names, handoff/delegate targets
- `availableAgents` is **hardcoded to `[]`** in ABLEditor.tsx (line 240)
- No trigger characters configured for Monaco completion provider
- Symbol tree sidebar is **fixed 250px** — not resizable
- Diagnostics panel has no source filter tabs
- 37 CEL functions exist in `packages/compiler/src/platform/constructs/cel-functions.ts` but are not available as completions
- No value completions (mode, type, strategy, priority, action values)
- `react-resizable-panels@^4.6.0` is installed but unused

---

## Task 1: CEL Function Completion Registry

Create a static registry of CEL function metadata for completions. This avoids importing the CEL runtime into the language service.

**Files:**

- Create: `packages/language-service/src/cel-functions.ts`
- Test: `packages/language-service/src/__tests__/cel-completions.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/cel-completions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CEL_FUNCTIONS } from '../cel-functions';

describe('CEL_FUNCTIONS registry', () => {
  it('exports a non-empty array of function definitions', () => {
    expect(Array.isArray(CEL_FUNCTIONS)).toBe(true);
    expect(CEL_FUNCTIONS.length).toBeGreaterThan(30);
  });

  it('each entry has required fields', () => {
    for (const fn of CEL_FUNCTIONS) {
      expect(fn).toHaveProperty('name');
      expect(fn).toHaveProperty('signature');
      expect(fn).toHaveProperty('description');
      expect(fn).toHaveProperty('category');
      expect(fn.name).toMatch(/^abl\./);
    }
  });

  it('includes known functions', () => {
    const names = CEL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain('abl.upper');
    expect(names).toContain('abl.round');
    expect(names).toContain('abl.now');
    expect(names).toContain('abl.coalesce');
    expect(names).toContain('abl.array_find');
    expect(names).toContain('abl.format_currency');
  });

  it('categories are valid', () => {
    const validCategories = [
      'string',
      'numeric',
      'formatting',
      'type',
      'array',
      'object',
      'utility',
    ];
    for (const fn of CEL_FUNCTIONS) {
      expect(validCategories).toContain(fn.category);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @abl/language-service test -- --run src/__tests__/cel-completions.test.ts`
Expected: FAIL — cannot resolve `../cel-functions`

**Step 3: Write the implementation**

Create `packages/language-service/src/cel-functions.ts`:

```typescript
/**
 * Static registry of ABL CEL function metadata for completions and hover docs.
 *
 * This is a mirror of the functions registered in
 * packages/compiler/src/platform/constructs/cel-functions.ts
 * kept as static data to avoid importing the CEL runtime.
 */

export interface CelFunctionMeta {
  name: string;
  signature: string;
  description: string;
  category: 'string' | 'numeric' | 'formatting' | 'type' | 'array' | 'object' | 'utility';
}

export const CEL_FUNCTIONS: ReadonlyArray<CelFunctionMeta> = [
  // --- String ---
  {
    name: 'abl.upper',
    signature: 'abl.upper(s: string): string',
    description: 'Convert string to uppercase',
    category: 'string',
  },
  {
    name: 'abl.lower',
    signature: 'abl.lower(s: string): string',
    description: 'Convert string to lowercase',
    category: 'string',
  },
  {
    name: 'abl.trim',
    signature: 'abl.trim(s: string): string',
    description: 'Trim leading and trailing whitespace',
    category: 'string',
  },
  {
    name: 'abl.substring',
    signature: 'abl.substring(s: string, start: int, end?: int): string',
    description: 'Extract substring from start to optional end index',
    category: 'string',
  },
  {
    name: 'abl.replace',
    signature: 'abl.replace(s: string, find: string, replacement: string): string',
    description: 'Replace all occurrences of find with replacement',
    category: 'string',
  },
  {
    name: 'abl.split',
    signature: 'abl.split(s: string, delimiter: string): list',
    description: 'Split string into array by delimiter',
    category: 'string',
  },
  {
    name: 'abl.join',
    signature: 'abl.join(arr: list, delimiter?: string): string',
    description: 'Join array elements with delimiter (default: ",")',
    category: 'string',
  },
  {
    name: 'abl.pad_start',
    signature: 'abl.pad_start(s: string, length: int, char?: string): string',
    description: 'Pad string from the left to target length',
    category: 'string',
  },
  {
    name: 'abl.pad_end',
    signature: 'abl.pad_end(s: string, length: int, char?: string): string',
    description: 'Pad string from the right to target length',
    category: 'string',
  },
  {
    name: 'abl.repeat',
    signature: 'abl.repeat(s: string, count: int): string',
    description: 'Repeat string count times (max 100,000 chars)',
    category: 'string',
  },

  // --- Numeric ---
  {
    name: 'abl.round',
    signature: 'abl.round(n: double, decimals?: int): double',
    description: 'Round number to integer or N decimal places',
    category: 'numeric',
  },
  {
    name: 'abl.abs',
    signature: 'abl.abs(n: double): double',
    description: 'Absolute value',
    category: 'numeric',
  },
  {
    name: 'abl.min',
    signature: 'abl.min(a: double, b: double): double',
    description: 'Return the smaller of two numbers',
    category: 'numeric',
  },
  {
    name: 'abl.max',
    signature: 'abl.max(a: double, b: double): double',
    description: 'Return the larger of two numbers',
    category: 'numeric',
  },

  // --- Formatting ---
  {
    name: 'abl.mask',
    signature: 'abl.mask(s: string, pattern: string, char?: string): string',
    description: 'Mask sensitive data (patterns: "last4", "first4", "n*m")',
    category: 'formatting',
  },
  {
    name: 'abl.format_currency',
    signature: 'abl.format_currency(n: double, currency: string, locale?: string): string',
    description: 'Format number as currency using Intl.NumberFormat',
    category: 'formatting',
  },
  {
    name: 'abl.format_date',
    signature: 'abl.format_date(d: string, fmt: string, tz?: string): string',
    description: 'Format date string (YYYY, MM, DD, HH, mm, ss placeholders)',
    category: 'formatting',
  },
  {
    name: 'abl.ordinal',
    signature: 'abl.ordinal(n: int): string',
    description: 'Convert number to ordinal string (1st, 2nd, 3rd, ...)',
    category: 'formatting',
  },

  // --- Type checking ---
  {
    name: 'abl.is_array',
    signature: 'abl.is_array(x: any): bool',
    description: 'Check if value is an array',
    category: 'type',
  },
  {
    name: 'abl.is_number',
    signature: 'abl.is_number(x: any): bool',
    description: 'Check if value is a number',
    category: 'type',
  },
  {
    name: 'abl.is_string',
    signature: 'abl.is_string(x: any): bool',
    description: 'Check if value is a string',
    category: 'type',
  },
  {
    name: 'abl.to_number',
    signature: 'abl.to_number(x: any): double | null',
    description: 'Convert value to number (null if NaN)',
    category: 'type',
  },
  {
    name: 'abl.to_string',
    signature: 'abl.to_string(x: any): string',
    description: 'Convert value to string representation',
    category: 'type',
  },

  // --- Array ---
  {
    name: 'abl.length',
    signature: 'abl.length(x: list | string): int',
    description: 'Get length of array or string',
    category: 'array',
  },
  {
    name: 'abl.array_find',
    signature: 'abl.array_find(arr: list, field: string, value: any): map | null',
    description: 'Find first object in array where field equals value',
    category: 'array',
  },
  {
    name: 'abl.array_find_index',
    signature: 'abl.array_find_index(arr: list, field: string, value: any): int',
    description: 'Find index of first object where field equals value (-1 if not found)',
    category: 'array',
  },

  // --- Object ---
  {
    name: 'abl.object_keys',
    signature: 'abl.object_keys(obj: map): list',
    description: 'Get array of object keys',
    category: 'object',
  },
  {
    name: 'abl.object_values',
    signature: 'abl.object_values(obj: map): list',
    description: 'Get array of object values',
    category: 'object',
  },
  {
    name: 'abl.object_merge',
    signature: 'abl.object_merge(a: map, b: map, c?: map): map',
    description: 'Shallow merge two or three objects',
    category: 'object',
  },

  // --- Utility ---
  {
    name: 'abl.coalesce',
    signature: 'abl.coalesce(a: any, b: any, c?: any, d?: any): any',
    description: 'Return first non-null value',
    category: 'utility',
  },
  {
    name: 'abl.now',
    signature: 'abl.now(): string',
    description: 'Current timestamp as ISO 8601 string',
    category: 'utility',
  },
  {
    name: 'abl.unique_id',
    signature: 'abl.unique_id(length?: int): string',
    description: 'Generate pseudorandom alphanumeric ID (default length: 6)',
    category: 'utility',
  },
];
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/cel-completions.test.ts`
Expected: PASS — all 4 tests pass

**Step 5: Commit**

```bash
git add packages/language-service/src/cel-functions.ts packages/language-service/src/__tests__/cel-completions.test.ts
git commit -m "feat(language-service): add CEL function metadata registry for completions"
```

---

## Task 2: Wire CEL Function Completions into getCompletions

Add CEL function suggestions when the cursor is inside a CEL expression context (e.g., after `when:`, `validate:`, `set:`, or inside `${}` template expressions).

**Files:**

- Modify: `packages/language-service/src/completions.ts`
- Test: `packages/language-service/src/__tests__/completions.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `packages/language-service/src/__tests__/completions.test.ts`:

```typescript
// Add these tests to the existing describe block

it('suggests CEL functions inside a when: line', () => {
  const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      when: `;
  const results = getCompletions(yaml, { line: 6, column: 13 });
  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.label === 'abl.upper')).toBe(true);
  expect(results.some((r) => r.label === 'abl.coalesce')).toBe(true);
  expect(results.every((r) => r.kind === 'function')).toBe(true);
});

it('suggests CEL functions inside a validate: line', () => {
  const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      validate: `;
  const results = getCompletions(yaml, { line: 6, column: 17 });
  expect(results.some((r) => r.label === 'abl.is_number')).toBe(true);
});

it('suggests CEL functions inside a set: value', () => {
  const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      set:\n        x: `;
  const results = getCompletions(yaml, { line: 7, column: 12 });
  expect(results.some((r) => r.label === 'abl.now')).toBe(true);
});

it('CEL function completions include documentation', () => {
  const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      when: `;
  const results = getCompletions(yaml, { line: 6, column: 13 });
  const upper = results.find((r) => r.label === 'abl.upper');
  expect(upper).toBeDefined();
  expect(upper!.documentation).toContain('uppercase');
  expect(upper!.detail).toContain('abl.upper');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: FAIL — CEL functions not returned in these contexts

**Step 3: Write the implementation**

Modify `packages/language-service/src/completions.ts`:

1. Add import at top:

```typescript
import { CEL_FUNCTIONS } from './cel-functions.js';
```

2. Add a helper function to detect CEL expression context:

```typescript
/**
 * Detect if cursor is in a CEL expression context.
 * CEL expressions appear after: when:, validate:, set: values,
 * success_when:, condition:, and inside ${} template expressions.
 */
function isCelExpressionContext(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();

  // Direct CEL keywords: `when: <expr>`, `validate: <expr>`, `success_when: <expr>`, `condition: <expr>`
  if (/^(when|validate|success_when|condition)\s*:\s*/.test(trimmed)) {
    return true;
  }

  // Inside a set: block — value positions (key: <expr>)
  // Detect by checking if we're inside a `set:` block and on a `key: ` line
  const indent = cursorLine.length - trimmed.length;
  if (indent >= 6 && /^[a-z_][a-z0-9_]*\s*:\s*/.test(trimmed)) {
    // Scan upward for `set:` at lower indent
    for (let i = cursorLineIdx - 1; i >= 0; i--) {
      const line = lines[i];
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent && /^\s*set\s*:/.test(line)) {
        return true;
      }
      if (lineIndent === 0) break;
    }
  }

  return false;
}
```

3. Add CEL function completion builder:

```typescript
/**
 * Build completion items for all CEL functions.
 */
function getCelFunctionCompletions(): CompletionItem[] {
  return CEL_FUNCTIONS.map((fn, idx) => ({
    label: fn.name,
    kind: 'function' as CompletionKind,
    detail: fn.signature,
    documentation: fn.description,
    insertText: fn.name + '(',
    sortOrder: idx,
  }));
}
```

4. Add CEL context check in `getCompletions()` — insert BEFORE the flow step keyword check (before line 215):

```typescript
// --- CEL expression context ---
if (isCelExpressionContext(lines, cursorLineIdx)) {
  return getCelFunctionCompletions();
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: PASS — all tests including new CEL ones

**Step 5: Commit**

```bash
git add packages/language-service/src/completions.ts packages/language-service/src/__tests__/completions.test.ts
git commit -m "feat(language-service): CEL function completions in expression contexts"
```

---

## Task 3: Value Completions for Enum-Like Fields

Add value suggestions for fields that have a known set of valid values (mode, type, action, strategy, priority).

**Files:**

- Modify: `packages/language-service/src/completions.ts`
- Test: `packages/language-service/src/__tests__/completions.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `packages/language-service/src/__tests__/completions.test.ts`:

```typescript
it('suggests mode values after mode:', () => {
  const yaml = `agent: test\nmode: `;
  const results = getCompletions(yaml, { line: 2, column: 7 });
  expect(results.some((r) => r.label === 'reasoning')).toBe(true);
  expect(results.some((r) => r.label === 'scripted')).toBe(true);
  expect(results.every((r) => r.kind === 'value')).toBe(true);
});

it('suggests tool type values after type: inside tools', () => {
  const yaml = `agent: test\ntools:\n  my_tool:\n    type: `;
  const results = getCompletions(yaml, { line: 4, column: 11 });
  expect(results.some((r) => r.label === 'api')).toBe(true);
  expect(results.some((r) => r.label === 'mcp')).toBe(true);
  expect(results.some((r) => r.label === 'function')).toBe(true);
});

it('suggests escalation priority values', () => {
  const yaml = `agent: test\nhandoff:\n  - to: support\n    priority: `;
  const results = getCompletions(yaml, { line: 4, column: 15 });
  expect(results.some((r) => r.label === 'high')).toBe(true);
  expect(results.some((r) => r.label === 'low')).toBe(true);
});

it('suggests action values after action: in flow steps', () => {
  const yaml = `agent: test\nflow:\n  steps:\n    start:\n      on_complete:\n        action: `;
  const results = getCompletions(yaml, { line: 6, column: 16 });
  expect(results.some((r) => r.label === 'handoff')).toBe(true);
  expect(results.some((r) => r.label === 'escalate')).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: FAIL — value completions not returned

**Step 3: Write the implementation**

Add to `packages/language-service/src/completions.ts`:

1. Add value registry constant:

```typescript
/** Known enum-like field values for ABL YAML. */
const VALUE_COMPLETIONS: Record<string, ReadonlyArray<{ value: string; detail: string }>> = {
  mode: [
    { value: 'reasoning', detail: 'LLM-driven autonomous agent' },
    { value: 'scripted', detail: 'Flow-based deterministic agent' },
  ],
  type: [
    { value: 'api', detail: 'HTTP API tool' },
    { value: 'function', detail: 'Inline function tool' },
    { value: 'mcp', detail: 'Model Context Protocol tool' },
    { value: 'lambda', detail: 'AWS Lambda tool' },
    { value: 'sandbox', detail: 'Sandboxed code execution' },
  ],
  action: [
    { value: 'handoff', detail: 'Hand off to another agent' },
    { value: 'delegate', detail: 'Delegate task to another agent' },
    { value: 'escalate', detail: 'Escalate to human agent' },
    { value: 'complete', detail: 'Complete the conversation' },
    { value: 'respond', detail: 'Send a response to user' },
  ],
  strategy: [
    { value: 'parallel', detail: 'Execute in parallel' },
    { value: 'sequential', detail: 'Execute sequentially' },
    { value: 'fallback', detail: 'Try alternatives on failure' },
  ],
  priority: [
    { value: 'high', detail: 'High priority' },
    { value: 'medium', detail: 'Medium priority' },
    { value: 'low', detail: 'Low priority' },
    { value: 'urgent', detail: 'Urgent priority' },
  ],
};
```

2. Add a helper to detect value context:

```typescript
/**
 * Detect if cursor is positioned after a known enum-like field key.
 * Returns the field key name if found, null otherwise.
 */
function getValueFieldKey(line: string): string | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(/^-?\s*([a-z_]+)\s*:\s*$/);
  if (!match) return null;
  const key = match[1];
  return VALUE_COMPLETIONS[key] ? key : null;
}
```

3. Add value completion check at the START of `getCompletions()`, after the lines/cursorLine setup (before handoff target check):

```typescript
// --- Value completions for enum-like fields ---
const valueKey = getValueFieldKey(cursorLine);
if (valueKey) {
  const values = VALUE_COMPLETIONS[valueKey]!;
  return values.map((v, idx) => makeCompletion(v.value, 'value', v.detail, v.value, idx));
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/language-service/src/completions.ts packages/language-service/src/__tests__/completions.test.ts
git commit -m "feat(language-service): value completions for mode, type, action, strategy, priority"
```

---

## Task 4: Gather Field Property Completions

Suggest properties when the cursor is inside a gather field definition (type, required, description, extraction_hints, validate, default).

**Files:**

- Modify: `packages/language-service/src/completions.ts`
- Test: `packages/language-service/src/__tests__/completions.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `packages/language-service/src/__tests__/completions.test.ts`:

```typescript
it('suggests gather field properties', () => {
  const yaml = `agent: test\ngather:\n  name:\n    `;
  const results = getCompletions(yaml, { line: 4, column: 5 });
  expect(results.some((r) => r.label === 'type')).toBe(true);
  expect(results.some((r) => r.label === 'required')).toBe(true);
  expect(results.some((r) => r.label === 'description')).toBe(true);
  expect(results.some((r) => r.label === 'validate')).toBe(true);
  expect(results.some((r) => r.label === 'default')).toBe(true);
  expect(results.every((r) => r.kind === 'field')).toBe(true);
});

it('suggests gather field type values', () => {
  const yaml = `agent: test\ngather:\n  name:\n    type: `;
  const results = getCompletions(yaml, { line: 4, column: 11 });
  expect(results.some((r) => r.label === 'string')).toBe(true);
  expect(results.some((r) => r.label === 'number')).toBe(true);
  expect(results.some((r) => r.label === 'boolean')).toBe(true);
  expect(results.some((r) => r.label === 'date')).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Add to `packages/language-service/src/completions.ts`:

1. Add gather field property constants:

```typescript
/** Properties valid inside a gather field definition. */
const GATHER_FIELD_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'type', detail: 'Field data type' },
  { key: 'required', detail: 'Whether field is required (true/false)' },
  { key: 'description', detail: 'Description shown to user' },
  { key: 'extraction_hints', detail: 'Hints for entity extraction' },
  { key: 'validate', detail: 'Validation expression (CEL)' },
  { key: 'default', detail: 'Default value' },
  { key: 'options', detail: 'Allowed values list' },
  { key: 'prompt', detail: 'Custom prompt for this field' },
];
```

2. Add gather field type values to VALUE_COMPLETIONS:

```typescript
// Add to VALUE_COMPLETIONS object:
  gather_type: [
    { value: 'string', detail: 'Text value' },
    { value: 'number', detail: 'Numeric value' },
    { value: 'boolean', detail: 'True/false value' },
    { value: 'date', detail: 'Date value' },
    { value: 'email', detail: 'Email address' },
    { value: 'phone', detail: 'Phone number' },
    { value: 'enum', detail: 'One of predefined options' },
    { value: 'array', detail: 'List of values' },
  ],
```

3. Add a helper to detect gather field context:

```typescript
/**
 * Detect if cursor is inside a gather field definition body.
 * Returns true when: gather: > fieldName: > <cursor at property level>
 */
function isInsideGatherField(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 4) return false;

  // Scan upward for the field name, then gather:
  let foundFieldName = false;
  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent === 0 && /^[a-z][a-z_]*\s*:/.test(trimmed)) {
      return trimmed.startsWith('gather') && foundFieldName;
    }

    if (
      !foundFieldName &&
      indent < cursorIndent &&
      indent >= 2 &&
      /^[a-z_][a-z0-9_]*\s*:/.test(trimmed)
    ) {
      foundFieldName = true;
    }
  }
  return false;
}

/**
 * Detect if cursor is on a `type:` line inside a gather field.
 */
function isGatherFieldTypeValue(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();
  if (!/^type\s*:\s*$/.test(trimmed)) return false;
  return isInsideGatherField(lines, cursorLineIdx);
}
```

4. Add gather context checks in `getCompletions()` — after value completions check, before handoff check:

```typescript
// --- Gather field type values ---
if (isGatherFieldTypeValue(lines, cursorLineIdx)) {
  const values = VALUE_COMPLETIONS['gather_type']!;
  return values.map((v, idx) => makeCompletion(v.value, 'value', v.detail, v.value, idx));
}

// --- Gather field properties ---
if (isInsideGatherField(lines, cursorLineIdx)) {
  return GATHER_FIELD_PROPERTIES.map((p, idx) =>
    makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run src/__tests__/completions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/language-service/src/completions.ts packages/language-service/src/__tests__/completions.test.ts
git commit -m "feat(language-service): gather field property and type value completions"
```

---

## Task 5: Export CEL Functions from Package Index

Export the CEL function registry from the package so Studio and other consumers can access it.

**Files:**

- Modify: `packages/language-service/src/index.ts`

**Step 1: Add the export**

Add to `packages/language-service/src/index.ts`:

```typescript
export type { CelFunctionMeta } from './cel-functions.js';
export { CEL_FUNCTIONS } from './cel-functions.js';
```

**Step 2: Run build to verify it compiles**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/language-service/src/index.ts
git commit -m "feat(language-service): export CEL_FUNCTIONS and CelFunctionMeta from package"
```

---

## Task 6: Trigger Characters and Available Agents in ABLEditor

Configure Monaco completion trigger characters and fetch available agents from the project API.

**Files:**

- Modify: `apps/studio/src/components/abl/ABLEditor.tsx`

**Step 1: Add trigger characters to completion provider**

Find the completion provider registration (around line 232):

```typescript
monaco.languages.registerCompletionItemProvider('abl', {
  provideCompletionItems,
});
```

Add `triggerCharacters`:

```typescript
monaco.languages.registerCompletionItemProvider('abl', {
  triggerCharacters: [':', '.', ' ', '\n'],
  provideCompletionItems,
});
```

**Step 2: Fetch available agents from project API**

Find the hardcoded `availableAgents` (around line 240):

```typescript
availableAgents: [] as Array<{ name: string }>,
```

Replace with a fetch from the agents API. Add agent fetching alongside the existing tool fetching logic:

1. Add an `agentCacheRef` similar to `toolCacheRef`:

```typescript
const agentCacheRef = useRef<{
  agents: Array<{ name: string }>;
  timestamp: number;
} | null>(null);
```

2. In the `provideCompletionItems` function, add agent fetching with the same cache pattern as tools:

```typescript
// Fetch agents with cache (same pattern as tools)
let agents: Array<{ name: string }> = [];
if (projectId) {
  const now = Date.now();
  const agentCache = agentCacheRef.current;
  if (agentCache && now - agentCache.timestamp < 30_000) {
    agents = agentCache.agents;
  } else {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/agents?limit=200`);
      if (res.ok) {
        const json = await res.json();
        agents = (json.data ?? []).map((a: { name: string }) => ({ name: a.name }));
        agentCacheRef.current = { agents, timestamp: now };
      }
    } catch {
      // Silently fall back to empty
    }
  }
}
```

3. Update the context passed to `getCompletions()`:

```typescript
availableAgents: agents,
```

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "feat(studio): add trigger characters and fetch available agents for ABL completions"
```

---

## Task 7: Resizable Symbol Tree Panel

Replace the fixed-width symbol tree sidebar with a resizable panel using `react-resizable-panels`.

**Files:**

- Modify: `apps/studio/src/components/abl/ABLEditor.tsx`

**Step 1: Add imports**

Add to ABLEditor.tsx imports:

```typescript
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
```

**Step 2: Replace the layout structure**

Find the current layout with fixed sidebar (the flex row containing the symbol tree and editor):

```tsx
{
  /* Current: fixed width sidebar + editor */
}
<div className="flex-1 flex min-h-0">
  {showSymbolTree && <div className="w-[250px] border-r border-default ...">...</div>}
  <div className="flex-1 flex flex-col min-h-0">{/* Monaco editor */}</div>
</div>;
```

Replace with `PanelGroup`:

```tsx
<div className="flex-1 flex flex-col min-h-0">
  <PanelGroup direction="horizontal" autoSaveId="abl-editor-layout">
    {showSymbolTree && (
      <>
        <Panel
          defaultSize={20}
          minSize={15}
          maxSize={35}
          className="border-r border-default bg-background-subtle overflow-y-auto"
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted border-b border-default sticky top-0 bg-background-subtle">
            {t('outline')}
          </div>
          <ABLSymbolTree symbols={symbols} onNavigate={navigateToLine} cursorLine={cursorLine} />
        </Panel>
        <PanelResizeHandle className="w-1 hover:bg-accent/30 active:bg-accent/50 transition-default" />
      </>
    )}
    <Panel minSize={50}>
      <div className="flex-1 flex flex-col min-h-0 h-full">
        {/* Monaco editor */}
        {/* Error details */}
        {/* Diagnostics panel */}
      </div>
    </Panel>
  </PanelGroup>
</div>
```

**Step 3: Verify build and visual**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds. The symbol tree sidebar can be resized by dragging the divider.

**Step 4: Commit**

```bash
git add apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "feat(studio): resizable symbol tree panel with react-resizable-panels"
```

---

## Task 8: Symbol Tree Search Filter

Add a search/filter input at the top of the symbol tree to filter symbols by name.

**Files:**

- Modify: `apps/studio/src/components/abl/ABLSymbolTree.tsx`

**Step 1: Add search input and filter logic**

1. Add `Search` icon import:

```typescript
import { ..., Search } from 'lucide-react';
```

2. Add search state in `ABLSymbolTree`:

```typescript
const [searchQuery, setSearchQuery] = useState('');
```

3. Add a recursive filter function:

```typescript
function filterSymbols(symbols: DocumentSymbol[], query: string): DocumentSymbol[] {
  if (!query) return symbols;
  const lower = query.toLowerCase();
  return symbols.reduce<DocumentSymbol[]>((acc, symbol) => {
    const filteredChildren = filterSymbols(symbol.children, query);
    if (symbol.name.toLowerCase().includes(lower) || filteredChildren.length > 0) {
      acc.push({
        ...symbol,
        children:
          filteredChildren.length > 0
            ? filteredChildren
            : symbol.children.filter((c) => c.name.toLowerCase().includes(lower)),
      });
    }
    return acc;
  }, []);
}
```

4. Add a search input above the tree:

```tsx
{
  /* Search input */
}
<div className="px-2 py-1.5 border-b border-default">
  <div className="relative">
    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-subtle" />
    <input
      type="text"
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      placeholder="Filter symbols..."
      className="w-full pl-7 pr-2 py-1 text-xs bg-background-muted border border-default rounded-md text-foreground placeholder:text-subtle focus:outline-none focus:border-accent transition-default"
    />
  </div>
</div>;
```

5. Filter symbols before rendering:

```typescript
const filteredSymbols = filterSymbols(symbols, searchQuery);
```

Use `filteredSymbols` instead of `symbols` in the tree rendering.

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/studio/src/components/abl/ABLSymbolTree.tsx
git commit -m "feat(studio): add search filter to ABL symbol tree"
```

---

## Task 9: Diagnostics Source Filter Tabs

Add filter tabs (All / Syntax / Structural / Compile) to the diagnostics panel status bar.

**Files:**

- Modify: `apps/studio/src/components/abl/ABLDiagnosticsPanel.tsx`

**Step 1: Add filter state and tab rendering**

1. Add `useState` import (already imported via `useMemo`, add `useState`):

```typescript
import { useMemo, useState } from 'react';
```

2. Add source filter type and state:

```typescript
type SourceFilter = 'all' | 'syntax' | 'structural' | 'compile';
const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
```

3. Add filtered diagnostics:

```typescript
const filteredDiagnostics = useMemo(() => {
  if (sourceFilter === 'all') return diagnostics;
  return diagnostics.filter((d) => d.source === sourceFilter);
}, [diagnostics, sourceFilter]);
```

4. Add filter tabs in the status bar (after the severity counts, before the close button):

```tsx
<div className="flex items-center gap-1 ml-4 border-l border-default pl-4">
  {(['all', 'syntax', 'structural', 'compile'] as const).map((filter) => (
    <button
      key={filter}
      onClick={() => setSourceFilter(filter)}
      className={clsx(
        'px-2 py-0.5 text-xs rounded transition-default',
        sourceFilter === filter
          ? 'bg-accent-subtle text-accent font-medium'
          : 'text-subtle hover:text-muted hover:bg-background-muted',
      )}
    >
      {filter === 'all' ? 'All' : filter.charAt(0).toUpperCase() + filter.slice(1)}
    </button>
  ))}
</div>
```

5. Use `filteredDiagnostics` instead of `diagnostics` in the row rendering section. Keep `diagnostics` for the severity counts (those should always show totals).

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/studio/src/components/abl/ABLDiagnosticsPanel.tsx
git commit -m "feat(studio): add source filter tabs to diagnostics panel"
```

---

## Task 10: i18n Keys for Phase 2 Features

Add translation keys for the new UI elements.

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add new keys**

Add under `agents.abl_editor` namespace:

```json
"filter_symbols": "Filter symbols...",
"no_symbols": "No symbols found",
"problems": "Problems",
"no_problems": "No problems",
"no_diagnostics": "No diagnostics to display",
"close_diagnostics": "Close diagnostics panel",
"filter_all": "All",
"filter_syntax": "Syntax",
"filter_structural": "Structural",
"filter_compile": "Compile"
```

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/i18n build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add Phase 2 translation keys for ABL editor enhancements"
```

---

## Task 11: Full Verification

Run all tests and verify builds.

**Step 1: Run language-service tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service test -- --run`
Expected: All tests pass (28 existing + new tests)

**Step 2: Run Studio build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds

**Step 3: Run core tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/compiler test -- --run`
Expected: All compiler tests pass

---

## Files Modified (Summary)

| File                                                              | Changes                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/language-service/src/cel-functions.ts`                  | NEW — CEL function metadata registry (37 functions)                   |
| `packages/language-service/src/completions.ts`                    | CEL function completions, value completions, gather field completions |
| `packages/language-service/src/index.ts`                          | Export CEL_FUNCTIONS and CelFunctionMeta                              |
| `packages/language-service/src/__tests__/cel-completions.test.ts` | NEW — CEL registry tests                                              |
| `packages/language-service/src/__tests__/completions.test.ts`     | New tests for CEL, values, gather field completions                   |
| `apps/studio/src/components/abl/ABLEditor.tsx`                    | Trigger characters, agent fetch, resizable panels                     |
| `apps/studio/src/components/abl/ABLSymbolTree.tsx`                | Search filter input                                                   |
| `apps/studio/src/components/abl/ABLDiagnosticsPanel.tsx`          | Source filter tabs                                                    |
| `packages/i18n/locales/en/studio.json`                            | New translation keys                                                  |

**New files: 2 | Modified: 7 | Total: 9**

---

## Implementation Order

1. Tasks 1-4 (language-service): CEL registry → CEL completions → value completions → gather field completions
2. Task 5 (export): Add exports to package index
3. Tasks 6-7 (Studio editor): Trigger characters + agents → resizable panels
4. Tasks 8-9 (Studio panels): Symbol tree search → diagnostics filter
5. Task 10 (i18n): Translation keys
6. Task 11 (verification): Full test + build suite
