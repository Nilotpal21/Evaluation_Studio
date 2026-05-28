# AFG E2E Platform Improvements Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix platform-level bugs and inefficiencies discovered by comparing AFG Blue Advisory E2E tests against the Kore.ai baseline — specifically: tautological constraint auto-guarding, wasteful entity extraction on trivial input, guard rail routing leak, and test output parity with baseline.

**Architecture:** Four independent fixes: (1) Fix `autoGuardConstraint` compiler logic to detect OR-based conditions and avoid creating tautologies, (2) Add trivial-input heuristic to skip GATHER entity extraction on greetings, (3) Fix supervisor DSL to explicitly exclude non-transactional domains, (4) Match ABL test output format to baseline visual style.

**Tech Stack:** TypeScript, Vitest, ABL DSL, ABL Compiler, ABL Runtime

---

## Context

### Comparison Summary: Kore.ai Baseline vs ABL Runtime

| Scenario       | Kore.ai | ABL   | Gap                                                           |
| -------------- | ------- | ----- | ------------------------------------------------------------- |
| Greeting       | ~1s     | ~4s   | GATHER extracts on "Hi" (+1s LLM call)                        |
| Product Search | ~3s     | ~11s  | Entity extraction + search (filter empty)                     |
| Guard Rail     | ~1s     | ~4s   | Flight booking routed to Advisor (not declined at supervisor) |
| Delegation     | ~3-5s   | ~5.6s | Acceptable                                                    |

### Root Causes Identified

1. **`autoGuardConstraint` creates tautologies** — When a constraint uses OR (e.g. `A != null OR B != null`), the compiler prepends `A IS NOT SET OR B IS NOT SET OR ...` making the entire expression always true. The auto-guard is designed for AND-based constraints like `A != null AND B != null` where the guard prevents null-reference errors.

2. **GATHER always calls LLM for extraction** — Even on single-word greetings like "Hi", the runtime calls `extractEntitiesWithLLM()` with all GATHER fields. This wastes ~1,500 tokens and ~1s latency per turn.

3. **Supervisor routes "Book a flight" to Advisor_Agent** — The supervisor's PERSONA lists "travel, hospitality" under Offers domain, and HANDOFF routes `intent.category == "offers"` to Advisor. The LLM interprets flight booking as an "offer" and routes it through.

4. **Test output lacks visual parity with baseline** — Baseline uses ━ borders, emoji timing breakdown, SSE event categorization. ABL test uses minimal single-line output.

---

### Task 1: Fix `autoGuardConstraint` for OR-based constraints

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:1178-1190`
- Test: `packages/compiler/src/__tests__/` (find existing autoGuardConstraint tests)

**The Bug:**

```
Input:  "product_category != null OR brand_preference != null OR budget_range != null"
Output: "product_category IS NOT SET OR brand_preference IS NOT SET OR budget_range IS NOT SET OR product_category != null OR brand_preference != null OR budget_range != null"
```

This is a tautology — always evaluates to true.

**The Fix:**
When the original condition is OR-based (contains `OR` at top level), auto-guard should apply per-clause, not globally. Each OR clause gets its own guard:

```
(product_category IS NOT SET OR product_category != null) OR (brand_preference IS NOT SET OR brand_preference != null) OR ...
```

Wait — that's still tautological per clause. The real fix: for OR conditions, each clause already handles "what if the variable isn't set" implicitly — if `product_category` is not set, `product_category != null` evaluates to false (not an error), because the dual-evaluator injects null for missing variables. So for OR conditions, **no auto-guard is needed**.

**Correct Fix:** Skip auto-guarding when the condition is purely OR-based (no AND clauses). The auto-guard exists to prevent null-reference errors in AND conditions like `A != null AND B < 10` — if A is not set, `A != null` would fail without the guard. But in OR conditions, a false clause just falls through to the next.

**Step 1: Write the failing test**

Find the existing `autoGuardConstraint` tests. Add:

```typescript
it('does not auto-guard purely OR-based conditions (prevents tautology)', () => {
  expect(
    autoGuardConstraint(
      'product_category != null OR brand_preference != null OR budget_range != null',
    ),
  ).toBe('product_category != null OR brand_preference != null OR budget_range != null');
});

it('still auto-guards AND-based conditions', () => {
  expect(autoGuardConstraint('product_category != null AND budget_range > 0')).toBe(
    'product_category IS NOT SET OR budget_range IS NOT SET OR product_category != null AND budget_range > 0',
  );
});

it('still auto-guards mixed AND/OR conditions', () => {
  // Mixed: has at least one AND — needs guards
  const result = autoGuardConstraint('A != null AND B != null OR C != null');
  expect(result).toContain('IS NOT SET');
});

it('still auto-guards single-variable conditions', () => {
  expect(autoGuardConstraint('num_guests <= 10')).toBe('num_guests IS NOT SET OR num_guests <= 10');
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @abl/compiler test -- --run -t "auto-guard"`
Expected: FAIL — OR-based condition still gets guarded

**Step 3: Implement the fix**

In `packages/compiler/src/platform/ir/compiler.ts`, update `autoGuardConstraint`:

```typescript
export function autoGuardConstraint(condition: string): string {
  // If the author already wrote IS NOT SET / IS SET guards, respect their intent.
  if (/\bIS\s+NOT\s+SET\b/.test(condition) || /\bIS\s+SET\b/.test(condition)) {
    return condition;
  }

  const vars = extractVariableReferences(condition);
  if (vars.length === 0) return condition;

  // Check if condition is purely OR-based (no AND at top level).
  // For OR conditions, auto-guarding creates tautologies:
  //   "A IS NOT SET OR A != null" is always true
  // The dual-evaluator already injects null for missing vars,
  // so OR clauses safely evaluate to false (no error).
  const hasAnd = /\bAND\b/i.test(condition);
  if (!hasAnd) {
    // Purely OR-based or single clause — no auto-guard needed
    return condition;
  }

  const guards = vars.map((v) => `${v} IS NOT SET`);
  return [...guards, condition].join(' OR ');
}
```

**Step 4: Run tests**

Run: `pnpm --filter @abl/compiler test -- --run -t "auto-guard"`
Expected: All PASS

**Step 5: Run full compiler tests for regressions**

Run: `pnpm --filter @abl/compiler test -- --run`
Expected: All ~4,027 PASS

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/...
git commit -m "fix(compiler): skip auto-guard for OR-based constraints to prevent tautologies"
```

---

### Task 2: Add trivial-input heuristic to skip GATHER entity extraction

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:329`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:3437`
- Create: `apps/runtime/src/services/execution/gather-utils.ts`
- Test: `apps/runtime/src/__tests__/gather-utils.test.ts`

**The Bug:**
When user says "Hi", the runtime calls `extractEntitiesWithLLM()` with all 4 GATHER fields, wasting ~1,500 tokens and ~1s. The LLM extracts "Hi" as the value for product_category (garbage).

**Step 1: Write the failing test for the heuristic**

Create `apps/runtime/src/__tests__/gather-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldSkipExtraction } from '../services/execution/gather-utils';

describe('shouldSkipExtraction', () => {
  it('skips single-word greetings', () => {
    expect(shouldSkipExtraction('Hi')).toBe(true);
    expect(shouldSkipExtraction('Hello')).toBe(true);
    expect(shouldSkipExtraction('Hey')).toBe(true);
    expect(shouldSkipExtraction('hey')).toBe(true);
  });

  it('skips short acknowledgments', () => {
    expect(shouldSkipExtraction('ok')).toBe(true);
    expect(shouldSkipExtraction('okay')).toBe(true);
    expect(shouldSkipExtraction('yes')).toBe(true);
    expect(shouldSkipExtraction('no')).toBe(true);
    expect(shouldSkipExtraction('sure')).toBe(true);
    expect(shouldSkipExtraction('thanks')).toBe(true);
    expect(shouldSkipExtraction('thank you')).toBe(true);
  });

  it('skips empty or whitespace-only input', () => {
    expect(shouldSkipExtraction('')).toBe(true);
    expect(shouldSkipExtraction('   ')).toBe(true);
  });

  it('does NOT skip substantive queries', () => {
    expect(shouldSkipExtraction('Show me red sneakers')).toBe(false);
    expect(shouldSkipExtraction('I want Nike shoes under 500')).toBe(false);
    expect(shouldSkipExtraction('What is the return policy?')).toBe(false);
    expect(shouldSkipExtraction('red sneakers for men under 500 AED')).toBe(false);
  });

  it('does NOT skip short but substantive input', () => {
    expect(shouldSkipExtraction('red shoes')).toBe(false);
    expect(shouldSkipExtraction('Nike sneakers')).toBe(false);
    expect(shouldSkipExtraction('return policy')).toBe(false);
  });

  it('does NOT skip greeting + substance', () => {
    expect(shouldSkipExtraction('Hi, show me red sneakers')).toBe(false);
    expect(shouldSkipExtraction('Hello, I want shoes')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/gather-utils.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `shouldSkipExtraction`**

Create `apps/runtime/src/services/execution/gather-utils.ts`:

```typescript
/**
 * Trivial-input heuristic for GATHER entity extraction.
 *
 * Returns true if the user message is too short or trivial to warrant
 * an LLM call for entity extraction. This prevents wasting ~1,500 tokens
 * and ~1s latency on greetings like "Hi" or acknowledgments like "ok".
 *
 * The heuristic is intentionally conservative — it only skips clearly
 * non-substantive input. When in doubt, it returns false (extract).
 */
const TRIVIAL_PHRASES = new Set([
  'hi',
  'hello',
  'hey',
  'hola',
  'howdy',
  'ok',
  'okay',
  'k',
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'no',
  'nah',
  'nope',
  'sure',
  'fine',
  'alright',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'bye',
  'goodbye',
  'see you',
  'good morning',
  'good afternoon',
  'good evening',
  'hey there',
  'hi there',
  'hello there',
]);

export function shouldSkipExtraction(message: string): boolean {
  const trimmed = message.trim();

  // Empty or whitespace
  if (!trimmed) return true;

  // Exact match against known trivial phrases (case-insensitive)
  if (TRIVIAL_PHRASES.has(trimmed.toLowerCase())) return true;

  // Single character or just punctuation/emoji
  if (trimmed.length <= 2) return true;

  return false;
}
```

**Step 4: Run tests**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/gather-utils.test.ts`
Expected: All PASS

**Step 5: Wire into reasoning-executor**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, around line 329:

```typescript
import { shouldSkipExtraction } from './gather-utils';

// ... inside the GATHER extraction block:
if (lastUserMsg) {
  // Skip extraction for trivial input (greetings, acknowledgments)
  // to avoid wasting LLM tokens on non-substantive messages
  if (shouldSkipExtraction(lastUserMsg)) {
    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_collect',
        data: {
          agentName: session.agentName,
          mode: 'reasoning_gather',
          fields: fieldNames,
          userInput: lastUserMsg,
          skipped: true,
          reason: 'trivial_input',
        },
      });
    }
  } else {
    // existing extraction code...
    const fieldNames = gatherFields.map(...)
    // ...
  }
}
```

Note: The `fieldNames` variable is already computed before the `if (lastUserMsg)` check at line 330. Only wrap the `try { ... extracted ... }` block (lines 353-427) in the else branch.

**Step 6: Wire into flow-step-executor**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, around line 3437:

```typescript
import { shouldSkipExtraction } from './gather-utils';

// ... inside the GATHER extraction block:
if (justCollectedInput && currentMessage) {
  if (shouldSkipExtraction(currentMessage)) {
    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_collect',
        data: {
          agentName: session.agentName,
          mode: 'scripted_gather',
          userInput: currentMessage,
          skipped: true,
          reason: 'trivial_input',
        },
      });
    }
  } else {
    // existing extraction code (lines 3440-3453)
    const fieldsToExtract = session.llmClient
      ? step.gather.fields.map((f) => f.name)
      : missing;
    const extractedData = await this.extractEntitiesWithLLM(...);
    // ... rest of existing code
  }
}
```

**Step 7: Run runtime tests**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/prompt-builder.test.ts apps/runtime/src/__tests__/gather-utils.test.ts`
Expected: All PASS

**Step 8: Commit**

```bash
git add apps/runtime/src/services/execution/gather-utils.ts apps/runtime/src/__tests__/gather-utils.test.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "perf(runtime): skip GATHER entity extraction on trivial input (greetings, acks)"
```

---

### Task 3: Fix supervisor guard rail routing for out-of-scope requests

**Files:**

- Modify: `examples/afg-blue-advisory/supervisor.agent.abl`

**The Bug:**
"Book me a flight from Dubai to London" gets routed to Advisor_Agent because:

1. PERSONA says Offers domain includes "travel, hospitality"
2. HANDOFF routes `intent.category == "offers"` to Advisor_Agent
3. LLM classifies flight booking as a travel offer

**Step 1: Update supervisor PERSONA to distinguish browsing vs. booking**

In `examples/afg-blue-advisory/supervisor.agent.abl`, update the PERSONA to clarify that travel/hospitality means viewing offers, not booking services:

```yaml
PERSONA: |
  You are Blue AI Advisor, an input validation and routing agent for a multi-brand retail & offers platform.
  Your job is to determine if user queries fall within supported domains and route them appropriately or decline politely.

  Supported Domains:
  - Retail: Accessories, Bags, Bath & Body, Clothing, Watches, Footwear, Fragrance, Haircare, Jewellery, Makeup, Personal Care, Skincare
  - Automotive: Lexus, Toyota, Jeep, Volvo, Honda, BYD, Polestar, RAM
  - Offers: All retail categories above plus dining, restaurants/cafes, health & wellness, entertainment, leisure, home services, travel deals, hospitality deals, spa, grooming, pet grooming, e-commerce, insurance, telecom, automotive

  Out-of-Scope (always decline):
  - Flight bookings, hotel reservations, ticket purchases, or any transactional service requests
  - Weather, news, cooking recipes, general knowledge, or technical support
  - Any request that requires completing a transaction outside the platform
```

**Step 2: Update LIMITATIONS to reinforce**

```yaml
LIMITATIONS:
  - 'Never answer out-of-scope questions even if you know the answer'
  - 'Cannot provide general knowledge, advice, or information unrelated to shopping'
  - 'Cannot process flight bookings, hotel reservations, ticket purchases, weather, news, cooking recipes, or technical support'
  - 'Travel and hospitality in the Offers domain means browsing deals and offers, NOT booking flights or hotels'
```

**Step 3: Verify by rebuilding and running the Guard Rail E2E test**

Run: `pnpm --filter @abl/core build && pnpm --filter @abl/compiler build && npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts -t "Guard rail"`
Expected: PASS — flight booking is declined

**Step 4: Run all AFG E2E tests**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`
Expected: All 7 PASS

**Step 5: Commit**

```bash
git add examples/afg-blue-advisory/supervisor.agent.abl
git commit -m "fix(afg): clarify supervisor guard rail to reject flight/hotel bookings"
```

---

### Task 4: Fix advisor constraint to properly gate product search

**Files:**

- Modify: `examples/afg-blue-advisory/agents/advisor_agent.agent.abl:84-87`

**The Bug:**
The constraint `REQUIRE product_category != null OR brand_preference != null OR budget_range != null` becomes tautological after auto-guarding (Task 1 fixes the compiler, but the DSL should also express the correct intent).

The intent is: "Require at least one of product_category, brand_preference, or budget_range to be set before searching." With the Task 1 fix, this OR-based condition won't be auto-guarded, so it will correctly evaluate to false when none are set.

But we should also verify the constraint actually works now.

**Step 1: Verify constraint evaluates correctly after Task 1 fix**

After Task 1 is implemented, the constraint will be:

```
product_category != null OR brand_preference != null OR budget_range != null
```

When none are set, the dual-evaluator injects null → `null != null` is false for all → entire OR is false → constraint fails → ON_FAIL message shown. This is correct!

**Step 2: No DSL change needed (Task 1 compiler fix is sufficient)**

The DSL is actually correct as-is. The bug was entirely in the compiler's `autoGuardConstraint`. Verify by checking the constraint passes with values and fails without.

**Step 3: Run E2E to confirm constraint behavior**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts -t "Greeting"`
Expected: PASS — constraint should now properly gate (though greeting test may need adjustment since the flow changes)

**Step 4: Commit (if any DSL changes needed)**

```bash
git commit -m "fix(afg): verify constraint evaluation after autoGuardConstraint fix"
```

---

### Task 5: Match ABL test output format to baseline visual style

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

**Step 1: Read the baseline formatting functions**

Read `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-conversational.e2e.test.ts` lines 229-280 for:

- `logTurnHeader()` — ━ border formatting
- `logTiming()` — structured timing breakdown
- `logFullResponse()` — response with ─ borders

**Step 2: Add visual formatting helpers to ABL test**

Add formatting helpers matching the baseline:

```typescript
function logTurnHeader(scenario: string, turn: string) {
  const label = `  ${scenario} — ${turn}  `;
  const width = 80;
  const pad = Math.max(0, Math.floor((width - label.length) / 2));
  console.log('\n' + '━'.repeat(width));
  console.log(' '.repeat(pad) + label);
  console.log('━'.repeat(width));
}

function logTimingBreakdown(metrics: {
  ttfb: number;
  total: number;
  chunkCount: number;
  responseLength: number;
}) {
  const fmt = (ms: number) => (ms / 1000).toFixed(2) + 's';
  console.log(`  ⏱  Timing:`);
  console.log(`     First chunk    → T+${fmt(metrics.ttfb)}  (TTFB)`);
  console.log(`     Stream complete → T+${fmt(metrics.total)}`);
  console.log(`     Chunks: ${metrics.chunkCount}  Characters: ${metrics.responseLength}`);
}

function logResponse(text: string) {
  const maxLen = 300;
  const display = text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  console.log(`  ─ Response ${'─'.repeat(65)}`);
  console.log(`  ${display}`);
  console.log(`  ${'─'.repeat(76)}`);
}
```

**Step 3: Replace inline logging in each scenario**

Replace the current single-line logging:

```typescript
console.log(`  [${label}] Timing: TTFB=${fmt(metrics.ttfb)} Total=...`);
```

With:

```typescript
logTurnHeader('AFG Blue Advisory', label);
logResponse(response);
logTimingBreakdown(metrics);
```

**Step 4: Run tests to verify output looks good**

Run: `npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts -t "Greeting"`
Expected: PASS with improved visual output

**Step 5: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git commit -m "style(test): match AFG ABL test output format to baseline visual style"
```

---

### Task 6: Run full E2E suite and compare timing improvements

**Step 1: Rebuild all packages**

```bash
pnpm --filter @abl/core build && pnpm --filter @abl/compiler build
```

**Step 2: Run full E2E suite**

```bash
npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
```

**Step 3: Compare timing against pre-fix baseline**

| Scenario       | Pre-fix | Post-fix           | Target |
| -------------- | ------- | ------------------ | ------ |
| Greeting       | ~4s     | TBD (expect ~2.5s) | < 3s   |
| Product Search | ~11.6s  | TBD (expect ~8s)   | < 10s  |
| Guard Rail     | ~4.2s   | TBD (expect ~2s)   | < 3s   |
| Delegation     | ~5.6s   | TBD (expect ~5s)   | < 6s   |
| Automobile     | ~3.4s   | TBD (expect ~3s)   | < 4s   |

**Step 4: Verify run report shows improvements**

Check `afg-run-report.json`:

- Greeting: No `entity_extraction` trace (should show `skipped: true, reason: "trivial_input"`)
- Guard Rail: Supervisor declines directly (no handoff to Advisor_Agent)
- Product Search: Constraint properly gates (fails when no entities collected)

---

### Task 7: Run regression tests

**Step 1: Core tests**

```bash
pnpm --filter @abl/core test -- --run
```

Expected: All ~573 PASS

**Step 2: Compiler tests**

```bash
pnpm --filter @abl/compiler test -- --run
```

Expected: All ~4,027 PASS

**Step 3: Runtime tests**

```bash
npx vitest run --config apps/runtime/vitest.config.ts apps/runtime/src/__tests__/prompt-builder.test.ts apps/runtime/src/__tests__/gather-utils.test.ts
```

Expected: All PASS
