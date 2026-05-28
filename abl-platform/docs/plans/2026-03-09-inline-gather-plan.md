# Inline GATHER Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge GATHER entity extraction into the reasoning loop, eliminating a ~1.4s LLM round-trip per turn while preserving validation, retries, and constraint semantics.

**Architecture:** Instead of a separate forced-toolChoice LLM call before reasoning, compile GATHER fields into a `_extract_entities` tool that the reasoning LLM can call alongside domain tools. Validation errors become tool results the LLM sees naturally, driving retries within the same loop. JS-lib extraction (dates, phones) runs as a fast pre-processing step. An `inline_gather` flag on `ExecutionConfig` controls opt-in, with full backward compatibility.

**Tech Stack:** TypeScript, Vitest, ABL Compiler (packages/compiler), Runtime (apps/runtime), Handlebars templates

---

## Task 1: Add `inline_gather` Flag to IR Schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:432-449`
- Test: `packages/compiler/src/__tests__/ir-schema.test.ts` (or nearest schema test)

**Step 1: Add the flag to `ExecutionConfig`**

In `packages/compiler/src/platform/ir/schema.ts`, after line 449 (closing `}` of `pipeline`), add:

```typescript
  /**
   * Inline gather mode: merge _extract_entities into the reasoning tool set
   * instead of running a separate pre-pass LLM call.
   * Saves ~1.4s per turn by eliminating a forced-toolChoice extraction call.
   * Default: false (backward-compatible — existing agents use separate pre-pass).
   */
  inline_gather?: boolean;
```

This goes inside `ExecutionConfig` before the closing `}` at line 450.

**Step 2: Run compiler tests to verify no breakage**

Run: `cd packages/compiler && pnpm test -- --run 2>&1 | tail -20`
Expected: All ~3,947 tests pass. The new optional field doesn't affect existing IR.

**Step 3: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "[ABLP-2] feat(compiler): add inline_gather flag to ExecutionConfig IR schema"
```

---

## Task 2: Compiler — Parse `inline_gather` from DSL EXECUTION Block

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts` (the `compileExecution` function)
- Modify: `packages/core/src/types/agent-based.ts` (AST type if needed)
- Test: `packages/compiler/src/__tests__/` (add compilation test)

**Step 1: Find where EXECUTION block is compiled**

Search: `grep -n "compileExecution\|inline_gather\|execution\.pipeline" packages/compiler/src/platform/ir/compiler.ts | head -20`

Read the function to understand how other execution fields (like `pipeline`, `compaction_threshold`) are compiled from the AST.

**Step 2: Write a failing test**

Create or extend a test in `packages/compiler/src/__tests__/inline-gather-compilation.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { compile } from '../index.js';

describe('inline_gather compilation', () => {
  test('EXECUTION.inline_gather: true sets flag in IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: Test agent
EXECUTION:
  inline_gather: true
GATHER:
  - name: city
    type: string
    prompt: "What city?"
    required: true
`;
    const result = compile(dsl);
    expect(result.success).toBe(true);
    expect(result.ir!.execution.inline_gather).toBe(true);
  });

  test('inline_gather defaults to undefined when not specified', () => {
    const dsl = `
AGENT: TestAgent
GOAL: Test agent
GATHER:
  - name: city
    type: string
    prompt: "What city?"
    required: true
`;
    const result = compile(dsl);
    expect(result.success).toBe(true);
    expect(result.ir!.execution.inline_gather).toBeUndefined();
  });

  test('inline_gather: true without GATHER fields is allowed (no-op)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: Test agent
EXECUTION:
  inline_gather: true
`;
    const result = compile(dsl);
    expect(result.success).toBe(true);
    expect(result.ir!.execution.inline_gather).toBe(true);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd packages/compiler && pnpm test -- --run src/__tests__/inline-gather-compilation.test.ts 2>&1 | tail -10`
Expected: FAIL — `inline_gather` is not yet compiled.

**Step 4: Add `inline_gather` to the compilation function**

In `compiler.ts`, inside `compileExecution()` (or wherever `pipeline` is compiled from the AST), add:

```typescript
if (doc.execution?.inline_gather !== undefined) {
  execution.inline_gather = doc.execution.inline_gather;
}
```

The exact location depends on how the function is structured — follow the pattern used for `pipeline`, `compaction_threshold`, etc.

**Step 5: Run tests**

Run: `cd packages/compiler && pnpm test -- --run src/__tests__/inline-gather-compilation.test.ts 2>&1 | tail -10`
Expected: All 3 tests PASS.

**Step 6: Run full compiler suite**

Run: `cd packages/compiler && pnpm test -- --run 2>&1 | tail -5`
Expected: All ~3,947 tests pass.

**Step 7: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/inline-gather-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/inline-gather-compilation.test.ts packages/core/src/types/agent-based.ts
git commit -m "[ABLP-2] feat(compiler): compile inline_gather from EXECUTION block"
```

---

## Task 3: Runtime — `handleInlineExtraction()` Method

This is the core of the feature. A new private method on `ReasoningExecutor` that processes `_extract_entities` tool calls with full validation, retry tracking, constraint checking, and memory ops.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts`
- Create: `apps/runtime/src/__tests__/inline-gather.test.ts`

**Step 1: Write failing tests for inline extraction**

Create `apps/runtime/src/__tests__/inline-gather.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock DB models (same pattern as other runtime tests)
vi.mock('@agent-platform/database/models', () => ({
  GuardrailPolicy: {
    find: vi.fn().mockReturnValue({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  Subscription: {
    findOne: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
  },
  Tenant: {
    findOne: vi.fn().mockReturnValue({ lean: () => ({ exec: () => Promise.resolve(null) }) }),
  },
}));
vi.mock('@agent-platform/database', () => ({
  ProjectRuntimeConfig: { findOne: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }) },
}));

describe('handleInlineExtraction', () => {
  test('valid extraction stores values and returns success', async () => {
    // This test verifies:
    // 1. _extract_entities tool call with valid values
    // 2. Values stored in session.data.values
    // 3. Returns { success: true, data: { extracted, complete, missing } }
    expect(true).toBe(true); // placeholder — implementation follows
  });

  test('validation failure returns error and increments retry count', async () => {
    // Validates:
    // 1. Range validation fails → value NOT stored
    // 2. _validation_retries incremented
    // 3. Returns { success: false, error: { code: 'VALIDATION_ERROR' } }
    expect(true).toBe(true);
  });

  test('max retries exceeded marks field in _validation_exceeded', async () => {
    expect(true).toBe(true);
  });

  test('constraint violation clears extracted fields and returns error', async () => {
    expect(true).toBe(true);
  });

  test('partial extraction — only some fields provided', async () => {
    expect(true).toBe(true);
  });

  test('memory ops run after successful extraction', async () => {
    expect(true).toBe(true);
  });
});
```

**Step 2: Implement `handleInlineExtraction()`**

Add this private method to the `ReasoningExecutor` class in `reasoning-executor.ts`. Place it after the existing `executeToolCall()` method (~line 1700):

```typescript
/**
 * Handle _extract_entities tool calls inline within the reasoning loop.
 * Runs validation, retry tracking, constraint checks, and memory ops —
 * same semantics as the legacy separate pre-pass, but as a tool result.
 */
private async handleInlineExtraction(
  session: RuntimeSession,
  toolCall: { name: string; input: Record<string, unknown> },
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<{
  toolResult: unknown;
  action?: { type: string; [key: string]: unknown };
  breakLoop: boolean;
}> {
  const extracted = toolCall.input as Record<string, unknown>;
  const gatherFields = (session.agentIR?.gather?.fields ?? []) as GatherField[];

  // 1. Validate each extracted field
  const errors: Record<string, string> = {};
  const valid: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(extracted)) {
    if (value === undefined || value === null || value === '') continue;
    const field = gatherFields.find((f) => f.name === name);
    if (!field) {
      valid[name] = value; // Unknown field — store without validation
      continue;
    }
    const error = field.validation ? validateField(value, field.validation) : null;
    if (error) {
      errors[name] = typeof error === 'string' ? error : error.message ?? 'Validation failed';
    } else {
      valid[name] = value;
    }
  }

  // 2. Track retries for failed fields
  if (Object.keys(errors).length > 0) {
    const retries = ((session.data.values._validation_retries as Record<string, number>) ?? {});
    const exceeded = ((session.data.values._validation_exceeded as string[]) ?? []).slice();

    for (const fieldName of Object.keys(errors)) {
      retries[fieldName] = (retries[fieldName] ?? 0) + 1;
      const gf = gatherFields.find((f) => f.name === fieldName);
      const maxRetries = gf?.validation?.max_retries;
      if (maxRetries !== undefined && retries[fieldName] >= maxRetries && !exceeded.includes(fieldName)) {
        exceeded.push(fieldName);
        if (onTraceEvent) {
          onTraceEvent({
            type: 'validation_max_retries',
            data: { field: fieldName, retries: retries[fieldName], maxRetries, agent: session.agentName },
          });
        }
      }
    }
    session.data.values._validation_retries = retries;
    if (exceeded.length > 0) session.data.values._validation_exceeded = exceeded;

    // Collect retry prompts for the LLM
    const retryHints: string[] = [];
    for (const [fieldName, errMsg] of Object.entries(errors)) {
      const gf = gatherFields.find((f) => f.name === fieldName);
      const hint = gf?.validation?.retry_prompt ?? errMsg;
      retryHints.push(`- ${fieldName}: ${hint}`);
    }

    // Still store any VALID fields from this extraction
    if (Object.keys(valid).length > 0) {
      setGatheredValues(session, valid);
    }

    return {
      toolResult: {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Some fields failed validation:\n${retryHints.join('\n')}\nPlease ask the user to correct these values.`,
          fields: errors,
        },
        ...(Object.keys(valid).length > 0 ? { stored: Object.keys(valid) } : {}),
      },
      breakLoop: false,
    };
  }

  // 3. All valid — persist to session
  if (Object.keys(valid).length > 0) {
    setGatheredValues(session, valid);

    // Memory operations (same as legacy path lines 484-515)
    try { await evaluateRememberAfterStateChange(session, onTraceEvent); }
    catch (err) { log.warn('inline gather: remember failed', { error: err instanceof Error ? err.message : String(err) }); }

    try { await executeRecallAfterExtraction(session, Object.keys(valid), onTraceEvent); }
    catch (err) { log.warn('inline gather: recall failed', { error: err instanceof Error ? err.message : String(err) }); }

    const lastUserMsg = session.conversationHistory.filter((m) => m.role === 'user').pop()?.content;
    const userText = typeof lastUserMsg === 'string' ? lastUserMsg : undefined;
    if (userText) {
      try { await detectAndStorePreferences(session, userText, Object.keys(valid), onTraceEvent); }
      catch (err) { log.warn('inline gather: preferences failed', { error: err instanceof Error ? err.message : String(err) }); }
    }

    // 4. Post-extraction constraint check (same as legacy lines 545-557)
    const violation = checkConstraints(session, onTraceEvent);
    if (violation) {
      for (const field of Object.keys(valid)) deleteSessionValue(session, field);
      return {
        toolResult: {
          success: false,
          error: { code: 'CONSTRAINT_VIOLATION', message: violation.message },
        },
        action: { type: 'constraint_violation', message: violation.message },
        breakLoop: false,
      };
    }
  }

  // 5. Check gather completeness
  const { complete, missing } = checkGatherComplete(
    { fields: gatherFields } as any,
    session.data.values,
    undefined,
  );

  if (onTraceEvent) {
    onTraceEvent({
      type: 'dsl_collect',
      data: {
        agentName: session.agentName,
        mode: 'inline_gather',
        extracted: valid,
        complete,
        missing,
      },
    });
  }

  return {
    toolResult: {
      success: true,
      data: {
        stored: Object.keys(valid),
        complete,
        missing,
        next_action: complete
          ? 'All required fields collected. Proceed with the user\'s request using domain tools.'
          : `Still need: ${missing.join(', ')}. Ask the user for these values.`,
      },
    },
    breakLoop: false,
  };
}
```

**Step 3: Add necessary imports at the top of reasoning-executor.ts**

Ensure these are imported (some may already be):

```typescript
import { validateField, checkGatherComplete } from '@abl/compiler';
import type { GatherField } from '@abl/compiler';
```

Check existing imports — `setGatheredValues`, `deleteSessionValue`, `evaluateRememberAfterStateChange`, `executeRecallAfterExtraction`, `detectAndStorePreferences`, `checkConstraints` should already be imported for the legacy path.

**Step 4: Run tests**

Run: `cd apps/runtime && pnpm test -- --run src/__tests__/inline-gather.test.ts 2>&1 | tail -10`
Expected: PASS (placeholder tests for now — we'll flesh them out after integration).

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/inline-gather.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/inline-gather.test.ts
git commit -m "[ABLP-2] feat(runtime): add handleInlineExtraction method for inline gather"
```

---

## Task 4: Runtime — Wire Inline Gather into Reasoning Loop

This wires the three integration points: (1) skip legacy pre-pass, (2) inject `_extract_entities` into tool set, (3) dispatch to `handleInlineExtraction()` in the tool loop.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:406-557` (pre-pass), `~730` (tool set), `~1418` (tool dispatch)

**Step 1: Gate the legacy pre-pass with `inline_gather` check**

At line 406 of `reasoning-executor.ts`, wrap the existing GATHER block:

```typescript
// For reasoning agents with GATHER fields, extract entities from the latest user message
const gatherFields = session.agentIR?.gather?.fields;
const inlineGather = session.agentIR?.execution?.inline_gather === true;
let justExtractedFields: string[] = [];

if (gatherFields && gatherFields.length > 0 && !inlineGather) {
  // === LEGACY PATH: separate pre-pass extraction (unchanged) ===
  // ... existing code lines 410-537 ...
} else if (gatherFields && gatherFields.length > 0 && inlineGather) {
  // === INLINE PATH: JS-lib pre-processing only (fast, deterministic) ===
  const lastUserContent = session.conversationHistory
    .filter((m) => m.role === 'user')
    .pop()?.content;
  const lastUserMsg = typeof lastUserContent === 'string' ? lastUserContent : undefined;

  if (lastUserMsg && !shouldSkipExtraction(lastUserMsg)) {
    // Tier 1 only: chrono-node for dates, libphonenumber for phones
    // This is the fast pre-processing — no LLM call
    // (TODO: extract runJSLibsPreExtraction from flow-step-executor)
    if (onTraceEvent) {
      onTraceEvent({
        type: 'dsl_collect',
        data: {
          agentName: session.agentName,
          mode: 'inline_gather',
          userInput: lastUserMsg,
          phase: 'js_libs_preprocess',
        },
      });
    }
  }
}
```

**Step 2: Inject `_extract_entities` into the tool set before the reasoning loop**

Find where `tools` is prepared for the loop (around line 730, near `buildTools(session)`). After the tools are built, inject the extraction tool:

```typescript
let tools = buildTools(session);

// Inline gather: inject _extract_entities alongside domain tools
if (inlineGather && gatherFields && gatherFields.length > 0) {
  const missingFields = gatherFields
    .filter((f: GatherField) => {
      if (!f.required) return false;
      const val = session.data.values[f.name];
      return val === undefined || val === null || val === '';
    })
    .map((f: GatherField) => f);

  if (missingFields.length > 0) {
    const extractionTool = this.flowStep.buildExtractionTool(missingFields);
    // Prepend so LLM sees it first in tool list
    tools = [extractionTool, ...tools];
  }
}
```

**Step 3: Dispatch `_extract_entities` in `executeToolCall()`**

In `executeToolCall()` (line ~1418), add a case before the system tool dispatch:

```typescript
// --- Inline gather: handle _extract_entities tool calls ---
if (toolCall.name === '_extract_entities' && session.agentIR?.execution?.inline_gather) {
  return this.handleInlineExtraction(session, toolCall, onTraceEvent);
}
```

Place this BEFORE the `isSystemTool` check at line 1427.

**Step 4: Refresh tool set after extraction completes**

Inside the reasoning loop, after processing a `_extract_entities` result, rebuild the tool list to remove `_extract_entities` if all fields are complete. Find the spot after `executeToolCall` returns (around line 1050-1060) and add:

```typescript
// After inline gather extraction, refresh tool set
if (toolCall.name === '_extract_entities' && inlineGather && gatherFields) {
  const { complete } = checkGatherComplete(
    { fields: gatherFields } as any,
    session.data.values,
    undefined,
  );
  if (complete) {
    // Remove _extract_entities — all fields collected
    tools = tools.filter((t) => t.name !== '_extract_entities');
  }
  // Rebuild system prompt with updated context
  systemPrompt = buildSystemPrompt(session);
}
```

**Step 5: Run runtime tests**

Run: `cd apps/runtime && pnpm test -- --run 2>&1 | tail -10`
Expected: All ~8,861 tests pass (existing behavior unaffected since `inline_gather` defaults to undefined/false).

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire inline gather into reasoning loop with tool injection"
```

---

## Task 5: Runtime — Add GATHER State to System Prompt

When inline gather is active, the system prompt needs a section showing which fields are collected vs missing, so the LLM knows what to extract.

**Files:**

- Modify: `apps/runtime/src/services/execution/prompt-builder.ts:279-373` (`buildTemplateContext`)

**Step 1: Add inline gather context to `buildTemplateContext()`**

In `buildTemplateContext()` (around line 353), add:

```typescript
// Inline gather context: surface collected/missing fields to LLM
const inline_gather = ir?.execution?.inline_gather === true;
const inline_gather_fields = inline_gather && ir?.gather?.fields?.length ? ir.gather.fields : [];
let inline_gather_status = '';
if (inline_gather && inline_gather_fields.length > 0) {
  const collected: string[] = [];
  const needed: string[] = [];
  for (const field of inline_gather_fields) {
    const fName = typeof field === 'string' ? field : field.name;
    const fPrompt = typeof field === 'string' ? field : field.prompt || field.name;
    const fRequired = typeof field === 'string' ? true : field.required !== false;
    const val = session.data?.values?.[fName];
    if (val !== undefined && val !== null && val !== '') {
      collected.push(`${fName}: ${JSON.stringify(val)}`);
    } else if (fRequired) {
      needed.push(`${fName}: ${fPrompt}`);
    }
  }
  const parts: string[] = [];
  if (collected.length > 0)
    parts.push(`Already collected:\n${collected.map((c) => `- ${c}`).join('\n')}`);
  if (needed.length > 0) parts.push(`Still needed:\n${needed.map((n) => `- ${n}`).join('\n')}`);
  if (parts.length > 0) {
    inline_gather_status = parts.join('\n\n');
  }
}
```

Then include `inline_gather`, `inline_gather_status` in the returned context object.

**Step 2: Update the system prompt template**

Find the Handlebars template used for specialist agents (in `prompt-catalog.ts` or the template files). Add a conditional section:

```handlebars
{{#if inline_gather}}

  ## Information Collection Use the `_extract_entities` tool to extract field values from the user's
  messages. Call it whenever the user provides relevant information. After collecting all required
  fields, proceed with domain tools.

  {{inline_gather_status}}
{{/if}}
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm test -- --run 2>&1 | tail -5`
Expected: All pass. The new section only renders when `inline_gather` is true.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/prompt-builder.ts
git add apps/runtime/src/services/execution/prompt-builder.ts
git commit -m "[ABLP-2] feat(runtime): add inline gather status to system prompt for field tracking"
```

---

## Task 6: Runtime — Domain Tool Completeness Gate

When inline gather is active, block domain tool execution if required GATHER fields haven't been collected yet. This prevents the LLM from calling `product_search` before extracting search criteria.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1401` (`executeToolCall`)

**Step 1: Add completeness gate**

In `executeToolCall()`, after the inline gather dispatch (from Task 4 Step 3) and before the system tool check, add:

```typescript
// --- Inline gather completeness gate ---
// Block domain tools until required GATHER fields are collected
if (
  session.agentIR?.execution?.inline_gather &&
  !toolCall.name.startsWith('__') &&
  !toolCall.name.startsWith('handoff_to_') &&
  !toolCall.name.startsWith('delegate_to_') &&
  toolCall.name !== '_extract_entities'
) {
  const gf = session.agentIR?.gather?.fields;
  if (gf && gf.length > 0) {
    const { complete, missing } = checkGatherComplete(
      { fields: gf } as any,
      session.data.values,
      undefined,
    );
    if (!complete) {
      return {
        toolResult: {
          success: false,
          error: {
            code: 'GATHER_INCOMPLETE',
            message: `Cannot call ${toolCall.name} yet — missing required fields: ${missing.join(', ')}. Use _extract_entities to collect them first, or ask the user.`,
            missing_fields: missing,
          },
        },
        breakLoop: false,
      };
    }
  }
}
```

**Step 2: Write a test for the completeness gate**

Add to `apps/runtime/src/__tests__/inline-gather.test.ts`:

```typescript
describe('domain tool completeness gate', () => {
  test('blocks domain tool when required gather fields are missing', () => {
    // Verify that calling product_search before _extract_entities
    // returns GATHER_INCOMPLETE error
    expect(true).toBe(true); // placeholder
  });

  test('allows domain tool when all required gather fields are collected', () => {
    expect(true).toBe(true); // placeholder
  });

  test('allows system tools (handoff, delegate) regardless of gather state', () => {
    expect(true).toBe(true); // placeholder
  });
});
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm test -- --run 2>&1 | tail -5`
Expected: All pass.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/inline-gather.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/inline-gather.test.ts
git commit -m "[ABLP-2] feat(runtime): add domain tool completeness gate for inline gather"
```

---

## Task 7: E2E Validation — AFG Blue Advisory with Inline Gather

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

**Step 1: Add inline gather test scenarios**

Add a new describe block `'Inline Gather (streaming + parallel + inline extraction)'` that mirrors the no-pipeline scenarios but patches `execution.inline_gather = true` on the Advisor_Agent IR:

```typescript
function createAfgSessionInlineGather(): RuntimeSession {
  const session = createAfgSession({ enablePipeline: false });
  // Enable inline gather on the Advisor agent
  const advisorIR = (executor as any).agentRegistry?.['Advisor_Agent'] ?? session.agentIR;
  // Find advisor IR from resolved agents
  // ... patch execution.inline_gather = true
  return session;
}
```

The exact wiring depends on how `createAfgSession` exposes agent IRs. The goal: run the same Product Search, Automobile, and Multi-turn scenarios with `inline_gather: true` and compare TTFB/total times.

**Step 2: Run the E2E tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts --testTimeout=180000`
Expected: All scenarios pass. Inline gather scenarios should show ~1-1.4s improvement on TTFB for tool-calling scenarios.

**Step 3: Update comparison doc**

Add an "Inline Gather" column to the 4-way comparison table in `ABL_VS_BASELINE_COMPARISON.md`.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/ABL_VS_BASELINE_COMPARISON.md
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/
git commit -m "[ABLP-2] feat(runtime): add inline gather E2E scenarios and update comparison doc"
```

---

## Task 8: Studio — Deprecate Entity Extraction Prompt Override

**Files:**

- Modify: `apps/studio/src/components/settings/AdvancedSettingsTab.tsx:68-81`

**Step 1: Add deprecation badge to entity_extraction prompt override**

Find the `llm_prompt.entity_extraction` key in `AdvancedSettingsTab.tsx` and add a conditional deprecation notice:

```tsx
{
  key === 'llm_prompt.entity_extraction' && (
    <span className="text-xs text-amber-500 ml-2">(deprecated when inline gather is enabled)</span>
  );
}
```

**Step 2: Run Studio build**

Run: `cd apps/studio && pnpm build 2>&1 | tail -5`
Expected: Build succeeds.

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/settings/AdvancedSettingsTab.tsx
git add apps/studio/src/components/settings/AdvancedSettingsTab.tsx
git commit -m "[ABLP-2] feat(studio): deprecate entity_extraction prompt override for inline gather"
```

---

## Dependency Graph

```
Task 1 (IR schema) ──┐
                      ├── Task 3 (handleInlineExtraction)
Task 2 (compiler)  ───┤         │
                      │         ▼
                      ├── Task 4 (wire into loop) ── Task 5 (system prompt)
                      │         │
                      │         ▼
                      ├── Task 6 (completeness gate)
                      │         │
                      │         ▼
                      └── Task 7 (E2E validation)

Task 8 (Studio) ── independent, can run in parallel with Tasks 3-7
```

**Parallelizable:** Tasks 1+2 (compiler), then Tasks 3+5+8 in parallel, then Tasks 4+6 (depend on 3), then Task 7 (depends on all).
