# Guardrail i18n Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all hardcoded English strings in the guardrail pipeline with i18n error codes using the existing `@agent-platform/i18n` infrastructure.

**Architecture:** Add guardrail error codes to `ErrorCatalog` + `platform.json`, then replace each hardcoded string with `formatErrorSync(code, params).message`. Compiler package gets a thin `guardrail-messages.ts` helper to avoid repeating `formatErrorSync` imports in every evaluator.

**Tech Stack:** `@agent-platform/i18n` (ErrorCatalog, formatErrorSync, ICU MessageFormat), TypeScript

---

### Task 1: Add guardrail error codes to ErrorCatalog and platform.json

**Files:**

- Modify: `packages/i18n/src/errors.ts` (add 10 new error codes after line 66)
- Modify: `packages/i18n/locales/en/platform.json` (add `guardrails` section)

**Step 1: Add error codes to ErrorCatalog**

Add these codes to `packages/i18n/src/errors.ts` before the closing `} as const`:

```typescript
  // Guardrails
  GUARDRAIL_INPUT_BLOCKED: 'Input blocked by guardrail policy.',
  GUARDRAIL_POLICY_BLOCKED: 'Blocked by policy guardrail.',
  GUARDRAIL_TOOL_INPUT_BLOCKED: 'Tool input blocked by guardrail',
  GUARDRAIL_TOOL_OUTPUT_BLOCKED: 'Tool output blocked by guardrail',
  GUARDRAIL_HANDOFF_BLOCKED: 'Handoff blocked by guardrail',
  GUARDRAIL_STREAM_TERMINATED: 'Streaming guardrail terminated output',
  GUARDRAIL_MESSAGE_UNPROCESSABLE: 'Your message could not be processed. Please try again.',
  GUARDRAIL_EVALUATOR_UNAVAILABLE: 'Guardrail evaluator unavailable',
  GUARDRAIL_EVAL_FAILED: 'Guardrail evaluation failed',
  GUARDRAIL_PROVIDER_NOT_REGISTERED: 'Guardrail provider "{provider}" not registered',
  GUARDRAIL_FILTER_ESCALATED: 'Filter removed too much content from "{guardrailName}" — blocked',
```

**Step 2: Add translations to platform.json**

Add a `"guardrails"` section to `packages/i18n/locales/en/platform.json` (after the `"execution"` section):

```json
  "guardrails": {
    "GUARDRAIL_INPUT_BLOCKED": "Input blocked by guardrail policy.",
    "GUARDRAIL_POLICY_BLOCKED": "Blocked by policy guardrail.",
    "GUARDRAIL_TOOL_INPUT_BLOCKED": "Tool input blocked by guardrail",
    "GUARDRAIL_TOOL_OUTPUT_BLOCKED": "Tool output blocked by guardrail",
    "GUARDRAIL_HANDOFF_BLOCKED": "Handoff blocked by guardrail",
    "GUARDRAIL_STREAM_TERMINATED": "Streaming guardrail terminated output",
    "GUARDRAIL_MESSAGE_UNPROCESSABLE": "Your message could not be processed. Please try again.",
    "GUARDRAIL_EVALUATOR_UNAVAILABLE": "Guardrail evaluator unavailable",
    "GUARDRAIL_EVAL_FAILED": "Guardrail evaluation failed",
    "GUARDRAIL_PROVIDER_NOT_REGISTERED": "Guardrail provider \"{provider}\" not registered",
    "GUARDRAIL_FILTER_ESCALATED": "Filter removed too much content from \"{guardrailName}\" — blocked"
  },
```

**Step 3: Build i18n package**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/i18n build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add packages/i18n/src/errors.ts packages/i18n/locales/en/platform.json
git commit -m "feat(i18n): add guardrail error codes to ErrorCatalog and platform.json"
```

---

### Task 2: Create guardrail-messages helper in compiler package

**Files:**

- Create: `packages/compiler/src/platform/guardrails/messages.ts`
- Modify: `packages/compiler/package.json` (verify `@agent-platform/i18n` dependency exists)

**Step 1: Check if `@agent-platform/i18n` is already a dependency of `packages/compiler`**

Run: `grep -q '@agent-platform/i18n' packages/compiler/package.json && echo "exists" || echo "missing"`

If missing, add it:

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/compiler add @agent-platform/i18n@workspace:*
```

**Step 2: Create messages.ts helper**

Create `packages/compiler/src/platform/guardrails/messages.ts`:

```typescript
/**
 * Guardrail i18n message helper.
 *
 * Centralizes guardrail message resolution via ErrorCatalog codes.
 * All user-facing guardrail messages should go through this module.
 */

import { formatErrorSync } from '@agent-platform/i18n';
import type { MessageParams } from '@agent-platform/i18n';

/** Guardrail error code constants for type safety */
export const GuardrailErrorCode = {
  INPUT_BLOCKED: 'GUARDRAIL_INPUT_BLOCKED',
  POLICY_BLOCKED: 'GUARDRAIL_POLICY_BLOCKED',
  TOOL_INPUT_BLOCKED: 'GUARDRAIL_TOOL_INPUT_BLOCKED',
  TOOL_OUTPUT_BLOCKED: 'GUARDRAIL_TOOL_OUTPUT_BLOCKED',
  HANDOFF_BLOCKED: 'GUARDRAIL_HANDOFF_BLOCKED',
  STREAM_TERMINATED: 'GUARDRAIL_STREAM_TERMINATED',
  MESSAGE_UNPROCESSABLE: 'GUARDRAIL_MESSAGE_UNPROCESSABLE',
  EVALUATOR_UNAVAILABLE: 'GUARDRAIL_EVALUATOR_UNAVAILABLE',
  EVAL_FAILED: 'GUARDRAIL_EVAL_FAILED',
  PROVIDER_NOT_REGISTERED: 'GUARDRAIL_PROVIDER_NOT_REGISTERED',
  FILTER_ESCALATED: 'GUARDRAIL_FILTER_ESCALATED',
} as const;

/**
 * Resolve a guardrail message from the i18n ErrorCatalog.
 * Returns the formatted English message string.
 */
export function guardrailMessage(code: string, params?: MessageParams): string {
  return formatErrorSync(code, params).message;
}
```

**Step 3: Build compiler package**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter @agent-platform/compiler`
Expected: Clean build.

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/guardrails/messages.ts packages/compiler/package.json
git commit -m "feat(compiler): add guardrail-messages i18n helper"
```

---

### Task 3: Wire i18n into Tier 1, Tier 2, and Tier 3 evaluators

**Files:**

- Modify: `packages/compiler/src/platform/guardrails/tier1-evaluator.ts:80`
- Modify: `packages/compiler/src/platform/guardrails/tier2-evaluator.ts:119,185`
- Modify: `packages/compiler/src/platform/guardrails/tier3-evaluator.ts:76,139`
- Modify: `packages/compiler/src/platform/guardrails/action-applier.ts:81`

**Step 1: Update tier1-evaluator.ts**

Add import at top:

```typescript
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
```

Replace line 80:

```typescript
// Before:
message: `Guardrail evaluation failed (failMode=closed): ${err instanceof Error ? err.message : String(err)}`,
// After:
message: guardrailMessage(GuardrailErrorCode.EVAL_FAILED),
```

**Step 2: Update tier2-evaluator.ts**

Add import at top:

```typescript
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
```

Replace line 119:

```typescript
// Before:
`Provider "${guardrail.provider}" not registered (failMode=closed)`,
// After:
guardrailMessage(GuardrailErrorCode.PROVIDER_NOT_REGISTERED, { provider: guardrail.provider ?? 'unknown' }),
```

Replace line 185:

```typescript
// Before:
message: `Guardrail provider evaluation failed (failMode=closed): ${err instanceof Error ? err.message : String(err)}`,
// After:
message: guardrailMessage(GuardrailErrorCode.EVAL_FAILED),
```

**Step 3: Update tier3-evaluator.ts**

Add import at top:

```typescript
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
```

Replace line 76:

```typescript
// Before:
message: 'Tier 3 LLM evaluator unavailable (failMode=closed)',
// After:
message: guardrailMessage(GuardrailErrorCode.EVALUATOR_UNAVAILABLE),
```

Replace line 139:

```typescript
// Before:
guardrail.action?.message || 'Your message could not be processed. Please try again.',
// After:
guardrail.action?.message || guardrailMessage(GuardrailErrorCode.MESSAGE_UNPROCESSABLE),
```

**Step 4: Update action-applier.ts**

Add import at top:

```typescript
import { guardrailMessage, GuardrailErrorCode } from './messages.js';
```

Replace line 81:

```typescript
// Before:
message: `Filter removed too much content from "${violation.name}" — blocked`,
// After:
message: guardrailMessage(GuardrailErrorCode.FILTER_ESCALATED, { guardrailName: violation.name }),
```

**Step 5: Build and test compiler**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter @agent-platform/compiler && pnpm --filter @agent-platform/compiler test`
Expected: All 3,947+ tests pass.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/guardrails/tier1-evaluator.ts packages/compiler/src/platform/guardrails/tier2-evaluator.ts packages/compiler/src/platform/guardrails/tier3-evaluator.ts packages/compiler/src/platform/guardrails/action-applier.ts
git commit -m "feat(compiler): wire i18n into tier 1/2/3 evaluators and action-applier"
```

---

### Task 4: Wire i18n into runtime guardrail call sites

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:961,1706,2019`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:2228`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1606,1913`
- Modify: `apps/runtime/src/services/execution/routing-executor.ts:452`
- Modify: `apps/runtime/src/services/guardrails/policy-resolver.ts:88`

**Step 1: Check that runtime already depends on `@agent-platform/i18n`**

Run: `grep '@agent-platform/i18n' apps/runtime/package.json`

If missing, add it:

```bash
pnpm --filter @agent-platform/runtime add @agent-platform/i18n@workspace:*
```

**Step 2: Update runtime-executor.ts**

Add import at top:

```typescript
import { formatErrorSync } from '@agent-platform/i18n';
```

Replace line 961 and 1706 (both identical):

```typescript
// Before:
message: event.violation?.message ?? 'Streaming guardrail terminated output',
// After:
message: event.violation?.message ?? formatErrorSync('GUARDRAIL_STREAM_TERMINATED').message,
```

Replace line 2019:

```typescript
// Before:
const blockMessage = v.message || 'Input blocked by guardrail policy.';
// After:
const blockMessage = v.message || formatErrorSync('GUARDRAIL_INPUT_BLOCKED').message;
```

**Step 3: Update flow-step-executor.ts**

Add import at top:

```typescript
import { formatErrorSync } from '@agent-platform/i18n';
```

Replace line 2228:

```typescript
// Before:
const blockMessage = v.message || 'Input blocked by guardrail policy.';
// After:
const blockMessage = v.message || formatErrorSync('GUARDRAIL_INPUT_BLOCKED').message;
```

**Step 4: Update reasoning-executor.ts**

Add import at top:

```typescript
import { formatErrorSync } from '@agent-platform/i18n';
```

Replace line 1606:

```typescript
// Before:
guardrailResult.primaryViolation?.message ?? 'Tool input blocked by guardrail';
// After:
guardrailResult.primaryViolation?.message ??
  formatErrorSync('GUARDRAIL_TOOL_INPUT_BLOCKED').message;
```

Replace line 1913:

```typescript
// Before:
'Tool output blocked by guardrail';
// After:
formatErrorSync('GUARDRAIL_TOOL_OUTPUT_BLOCKED').message;
```

**Step 5: Update routing-executor.ts**

Add import at top:

```typescript
import { formatErrorSync } from '@agent-platform/i18n';
```

Replace line 452:

```typescript
// Before:
guardrailResult.primaryViolation?.message ?? 'Handoff blocked by guardrail';
// After:
guardrailResult.primaryViolation?.message ?? formatErrorSync('GUARDRAIL_HANDOFF_BLOCKED').message;
```

**Step 6: Update policy-resolver.ts**

Add import at top:

```typescript
import { formatErrorSync } from '@agent-platform/i18n';
```

Replace line 88:

```typescript
// Before:
: { type: 'block', message: rule.message ?? 'Blocked by policy guardrail.' };
// After:
: { type: 'block', message: rule.message ?? formatErrorSync('GUARDRAIL_POLICY_BLOCKED').message };
```

**Step 7: Build and test runtime**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter @agent-platform/runtime && pnpm --filter @agent-platform/runtime test`
Expected: All 8,861+ tests pass.

**Step 8: Commit**

```bash
git add apps/runtime/src/services/runtime-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/services/guardrails/policy-resolver.ts
git commit -m "feat(runtime): wire i18n into all guardrail call sites"
```

---

### Task 5: Update existing tests that assert on hardcoded strings

**Files:**

- Modify: `apps/runtime/src/services/execution/__tests__/reasoning-guardrail-ordering.test.ts`
- Modify: Any other test files that assert exact guardrail message strings

**Step 1: Find all tests asserting on old hardcoded strings**

Run:

```bash
cd /Users/prasannaarikala/projects/agent-platform
grep -rn "Input blocked by guardrail\|Blocked by policy\|Tool input blocked\|Tool output blocked\|Handoff blocked\|Streaming guardrail terminated\|could not be processed\|Filter removed too much" --include="*.test.ts" --include="*.spec.ts"
```

**Step 2: Update test assertions**

For each found test, update the expected string to match the new i18n-resolved value. Since the English text is identical (we kept the same wording), most tests should still pass without changes. Only tests that matched the old internal-error-leaking messages need updating:

- `reasoning-guardrail-ordering.test.ts:24` — uses `'Response blocked by guardrail.'` which is a custom message from the mock, NOT a hardcoded default. **No change needed.**
- Any test asserting `'Guardrail evaluation failed (failMode=closed): ...'` needs updating to `'Guardrail evaluation failed'`
- Any test asserting `'Provider "X" not registered (failMode=closed)'` needs updating to `'Guardrail provider "X" not registered'`

**Step 3: Run full test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm test`
Expected: All tests pass (compiler 3,947+, runtime 8,861+).

**Step 4: Commit**

```bash
git add -u
git commit -m "test: update guardrail test assertions for i18n message changes"
```

---

### Task 6: Add unit tests for guardrail-messages helper

**Files:**

- Create: `packages/compiler/src/__tests__/guardrails/guardrail-messages.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { guardrailMessage, GuardrailErrorCode } from '../../platform/guardrails/messages.js';

describe('guardrailMessage', () => {
  it('resolves INPUT_BLOCKED without params', () => {
    const msg = guardrailMessage(GuardrailErrorCode.INPUT_BLOCKED);
    expect(msg).toBe('Input blocked by guardrail policy.');
  });

  it('resolves PROVIDER_NOT_REGISTERED with params', () => {
    const msg = guardrailMessage(GuardrailErrorCode.PROVIDER_NOT_REGISTERED, {
      provider: 'openai',
    });
    expect(msg).toBe('Guardrail provider "openai" not registered');
  });

  it('resolves FILTER_ESCALATED with guardrailName param', () => {
    const msg = guardrailMessage(GuardrailErrorCode.FILTER_ESCALATED, {
      guardrailName: 'pii-filter',
    });
    expect(msg).toBe('Filter removed too much content from "pii-filter" — blocked');
  });

  it('falls back to code string for unknown codes', () => {
    const msg = guardrailMessage('UNKNOWN_CODE_XYZ');
    expect(msg).toBe('UNKNOWN_CODE_XYZ');
  });

  it('resolves all defined guardrail codes', () => {
    for (const [key, code] of Object.entries(GuardrailErrorCode)) {
      const msg = guardrailMessage(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toBe(code); // Should resolve to a human-readable message, not the code itself
    }
  });
});
```

**Step 2: Run test**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/compiler test -- --testPathPattern guardrail-messages`
Expected: All 5 tests pass.

**Step 3: Commit**

```bash
git add packages/compiler/src/__tests__/guardrails/guardrail-messages.test.ts
git commit -m "test(compiler): add unit tests for guardrail-messages i18n helper"
```
