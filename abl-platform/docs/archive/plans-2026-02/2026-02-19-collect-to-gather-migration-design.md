# COLLECT → GATHER Migration Design

**Date:** 2026-02-19
**Status:** Approved
**Scope:** ABL DSL, Compiler, Runtime

## Problem

ABL has two constructs for collecting user input in scripted flow steps:

- **COLLECT** — Legacy. Simple field name list with a shared step-level `PROMPT`.
- **GATHER** — Modern. Structured field definitions with per-field type, prompt, validation, and extraction hints.

Both produce the same runtime action (`collectAction()`), but COLLECT lacks type info, per-field prompts, validation, and extraction hints. Having two constructs increases DSL surface area, parser complexity, and executor branching with no functional benefit.

## Decision

**Hard break: Remove COLLECT entirely. GATHER is the single collection construct.**

No shorthand syntax. GATHER always uses the structured field definition format. Per-field `prompt` is optional — the LLM generates contextual prompts from field name, type, and agent persona when prompt is omitted.

### Rationale for No Shorthand

- One parsing path, zero ambiguity
- Every GATHER block is self-documenting
- LLMs generate better prompts than boilerplate like "What is your destination?" — authors only override when they need specific phrasing
- Minimal verbosity: 1-2 lines per field without prompt

## Syntax

### Before (COLLECT)

```abl
get_dates:
  COLLECT: checkin_date, checkout_date
  PROMPT: "When do you want to check in and check out?"
  THEN: get_guests
```

### After (GATHER)

```abl
get_dates:
  GATHER:
    - checkin_date: required
      type: date
    - checkout_date: required
      type: date
  THEN: get_guests
```

### Minimal GATHER (no prompt, no type)

```abl
get_destination:
  GATHER:
    - destination: required
  THEN: search
```

Defaults: `type: string`, `required: true`, `prompt: undefined` (LLM-generated).

## Changes by Layer

### 1. Parser (`packages/core/src/parser/agent-based-parser.ts`)

- Remove the `COLLECT` case (lines 833-868)
- GATHER parsing unchanged

### 2. AST Types (`packages/core/src/types/agent-based.ts`)

- Remove `FlowStep.collect?: string[]`
- Remove `FlowStep.prompt?: string` (only existed for COLLECT's shared prompt)
- Keep `FlowStep.gather?: FlowGatherConfig`
- Keep `FlowStep.present?: string` (different purpose: displays collected data before prompting)

### 3. IR Schema (`packages/compiler/src/platform/ir/schema.ts`)

- Remove `FlowStep.collect?: string[]`
- Remove `FlowStep.prompt?: string`
- `FlowGatherConfig` and `GatherField` unchanged

### 4. Compiler (`packages/compiler/src/platform/ir/compiler.ts`)

- Remove `collect: step.collect` and `prompt: step.prompt` from FlowStep emission
- GATHER compilation path unchanged

### 5. Runtime Executor (`packages/compiler/src/platform/constructs/executors/flow-executor.ts`)

- Remove the COLLECT code path (lines 681-713)
- GATHER code path (lines 618-678) unchanged
- Existing fallback prompt (`Please provide: ${fieldName}`) remains for fields without explicit prompt

### 6. Example Files (4-5 files, ~17 usages)

| File                                                    | Usages |
| ------------------------------------------------------- | ------ |
| `examples/flow-test/hotel_booking_flow.agent.abl`       | 6      |
| `examples/flow-test/simple_booking.agent.abl`           | 3      |
| `examples/flow-test/booking_with_constraints.agent.abl` | 2      |
| `examples/travel/agents/authentication.agent.abl`       | 3      |
| `examples/travel/agents/payment_agent.agent.abl`        | 3      |

### 7. Tests

- Delete COLLECT-specific parser tests (`packages/core/src/__tests__/agent-based-parser.test.ts`, lines 618-677)
- Add test verifying parser rejects `COLLECT` keyword
- Delete or convert any COLLECT executor tests to GATHER equivalents

## What This Does NOT Change

- Top-level GATHER for reasoning agents — untouched
- GATHER field schema (`GatherField`) — untouched
- GATHER execution in flow steps — untouched
- `FlowStep.present` — kept (shows collected data before prompting)
- `FlowStep.corrections` — kept (natural language corrections)
- `FlowStep.complete_when` — kept (custom completion conditions)

## Risk

Low. COLLECT is used in 4-5 example files only. No customer-facing .abl files use it (all customer agents use GATHER or reasoning mode). The runtime GATHER path is unchanged — this is pure deletion.

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the legacy COLLECT construct from ABL, making GATHER the single collection mechanism.

**Architecture:** Hard break — remove COLLECT from parser, AST, IR, compiler, and executor. Migrate all 13 example .abl files (48 usages) to use GATHER with optional prompt (LLM-generated when omitted).

**Tech Stack:** TypeScript, Vitest, ABL DSL

**Design doc:** `docs/plans/2026-02-19-collect-to-gather-migration-design.md`

---

### Task 1: Remove COLLECT from AST Types

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:209-210`

**Step 1: Remove the fields**

Delete these two lines from the `FlowStep` interface:

```typescript
// DELETE:
collect?: string[];
prompt?: string;
```

Keep `gather?: FlowGatherConfig`, `present?: string`, `corrections?: boolean`, `completeWhen?: string`.

**Step 2: Verify no type errors in core package**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Type errors in the parser (references `currentStep.collect` and `currentStep.prompt`) — this is expected, we fix it in Task 2.

**Step 3: Commit**

```bash
git add packages/core/src/types/agent-based.ts
git commit -m "refactor(abl): remove COLLECT fields from FlowStep AST type"
```

---

### Task 2: Remove COLLECT from Parser

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts:833-868`

**Step 1: Delete the COLLECT case block**

Remove the entire `case 'COLLECT': { ... }` block (lines 833-868). This block handles three syntax variants (inline, comma-separated, YAML list) — all deleted.

Also search the same file for any references to `currentStep.collect` or `currentStep.prompt` that may exist outside the COLLECT case (e.g., in PROMPT handling). Remove those too.

**Step 2: Remove the PROMPT case if it only serves COLLECT**

The `case 'PROMPT':` block sets `currentStep.prompt`. Since `prompt` is removed from FlowStep, this case should be removed IF it only applies to COLLECT. Check whether PROMPT is used for anything else in flow steps (it shouldn't be — `present` is the GATHER equivalent). If PROMPT is only for COLLECT, delete its case block too.

**Step 3: Verify core package compiles**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Clean (no errors). If there are remaining references to `collect` or `prompt` on FlowStep, fix them.

**Step 4: Commit**

```bash
git add packages/core/src/parser/agent-based-parser.ts
git commit -m "refactor(abl): remove COLLECT and PROMPT parsing from ABL parser"
```

---

### Task 3: Remove COLLECT from IR Schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:829-831,902-903`

**Step 1: Remove from StaticGraphNode.step**

Delete from the `StaticGraphNode` interface (around lines 829-831):

```typescript
// DELETE:
collect?: string[];
prompt?: string;
```

**Step 2: Remove from FlowStep**

Delete from the IR `FlowStep` interface (around lines 902-903):

```typescript
// DELETE:
collect?: string[];
prompt?: string; // Prompt shown when collecting (before user input)
```

Keep `gather?: FlowGatherConfig`, `present?: string`, `corrections?: boolean`, `complete_when?: string`.

**Step 3: Verify compiler package compiles**

Run: `cd packages/compiler && npx tsc --noEmit`
Expected: Type errors in compiler.ts (emits `collect` and `prompt`) — fixed in Task 4.

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "refactor(abl): remove COLLECT fields from IR FlowStep schema"
```

---

### Task 4: Remove COLLECT from Compiler Emission

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:1043-1044`

**Step 1: Remove the emission lines**

In the FlowStep compilation block (around lines 1043-1044), delete:

```typescript
// DELETE:
collect: step.collect,
prompt: step.prompt,
```

**Step 2: Also remove from StaticGraph emission**

Search the same file for any `collect:` or `prompt:` references in the static graph node emission and remove them.

**Step 3: Verify compiler package compiles**

Run: `cd packages/compiler && npx tsc --noEmit`
Expected: Clean (no errors). If there are remaining references, fix them.

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/ir/compiler.ts
git commit -m "refactor(abl): remove COLLECT emission from IR compiler"
```

---

### Task 5: Remove COLLECT Executor Code Path

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/flow-executor.ts:680-713`

**Step 1: Delete the COLLECT block**

Remove the entire block (lines 680-713):

```typescript
// DELETE this entire block:
// ==========================================================================
// COLLECT - Legacy single-field collection
// ==========================================================================
if (stepDef.collect && stepDef.collect.length > 0 && !justCollectedInput && !stepDef.gather) {
  // ... all COLLECT handling logic
}
```

**Step 2: Search for any other `stepDef.collect` references in flow-executor.ts**

There may be references to `stepDef.collect` in other parts of the executor (e.g., entity extraction, step completion checks). Remove or replace them. If any logic uses `stepDef.collect` to determine field names for extraction, it should use `stepDef.gather?.fields.map(f => f.name)` instead.

**Step 3: Verify compiler package compiles**

Run: `cd packages/compiler && npx tsc --noEmit`
Expected: Clean.

**Step 4: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/flow-executor.ts
git commit -m "refactor(abl): remove COLLECT executor code path from FlowExecutor"
```

---

### Task 6: Update Parser Tests

**Files:**

- Modify: `packages/core/src/__tests__/agent-based-parser.test.ts`

**Step 1: Delete COLLECT-specific tests**

Remove the following test blocks:

- Lines ~298-326: Basic COLLECT parsing test (references `step.collect`)
- Lines ~623-660: "COLLECT with YAML multi-line list format"
- Lines ~662-685: "COLLECT with inline array format"

Also search for any other assertions referencing `.collect` on parsed steps and remove them.

**Step 2: Add a test verifying COLLECT is no longer parsed**

```typescript
test('COLLECT keyword is not recognized in flow steps', () => {
  const input = `
AGENT: Test_Agent
VERSION: "1.0"
GOAL: Test
MODE: scripted

FLOW:
  entry_point: start

  start:
    COLLECT: name
    THEN: done

  done:
    RESPOND: "Done"
`;
  const result = parse(input);
  const startStep = result.document?.flow?.definitions['start'];
  // COLLECT is ignored — no collect field on the step
  expect((startStep as any)?.collect).toBeUndefined();
});
```

**Step 3: Run parser tests**

Run: `cd packages/core && npx vitest run --reporter=verbose`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add packages/core/src/__tests__/agent-based-parser.test.ts
git commit -m "test(abl): remove COLLECT parser tests, add rejection test"
```

---

### Task 7: Migrate Example Files — flow-test

**Files to modify (each COLLECT becomes GATHER):**

1. `examples/flow-test/simple_booking.agent.abl` (lines 38, 45, 66)
2. `examples/flow-test/simple_constraint_test.agent.abl` (line 23)
3. `examples/flow-test/on_input_test.agent.abl` (lines 29, 48)
4. `examples/flow-test/hotel_booking_flow.agent.abl` (lines 37, 42, 47, 52, 72, 77)
5. `examples/flow-test/hotel_booking_advanced.agent.abl` (lines 53, 65, 83, 119, 135, 178, 197, 211, 252)
6. `examples/flow-test/booking_with_constraints.agent.abl` (lines 110, 143)

**Conversion pattern:**

Before:

```abl
step_name:
  COLLECT: field1, field2
  PROMPT: "Please provide field1 and field2"
  THEN: next_step
```

After:

```abl
step_name:
  GATHER:
    - field1: required
    - field2: required
  THEN: next_step
```

Rules:

- Drop the `PROMPT:` line (LLM generates prompts from field names)
- Add `type: date` for date fields, `type: number` for numeric fields, `type: email` for email fields
- Default type is `string` — omit for string fields
- Keep `required` on all fields unless the original had a default value
- If a field had a default in the top-level GATHER definition, add `default: value`
- Keep all other step properties (THEN, ON_SUCCESS, ON_FAIL, ON_INPUT, CHECK, etc.) unchanged

**Step 1: Migrate all 6 flow-test files**

Read each file, convert every COLLECT to GATHER, remove associated PROMPT lines.

**Step 2: Verify examples compile**

Run: `cd packages/compiler && npx vitest run --reporter=verbose`
Expected: Compiler tests that reference these examples should still pass (the compiler processes example files in tests).

**Step 3: Commit**

```bash
git add examples/flow-test/
git commit -m "refactor(examples): migrate flow-test COLLECT to GATHER"
```

---

### Task 8: Migrate Example Files — banknexus

**Files:**

1. `examples/banknexus/agents/get_balance.agent.abl` (lines 84, 121)
2. `examples/banknexus/agents/transaction_history.agent.abl` (lines 63, 88, 123, 136, 174)
3. `examples/banknexus/agents/fund_transfer.agent.abl` (lines 75, 105, 170, 226)

**Step 1: Migrate all 3 banknexus files**

Same conversion pattern as Task 7.

**Step 2: Verify examples compile**

Run: `cd packages/compiler && npx vitest run --reporter=verbose`

**Step 3: Commit**

```bash
git add examples/banknexus/
git commit -m "refactor(examples): migrate banknexus COLLECT to GATHER"
```

---

### Task 9: Migrate Example Files — traveldesk

**Files:**

1. `examples/travel/agents/payment_agent.agent.abl` (lines 116, 160, 172)
2. `examples/travel/agents/authentication.agent.abl` (lines 107, 127, 146)
3. `examples/travel/agents/live_agent_transfer.agent.abl` (lines 67, 127)
4. `examples/travel/agents/farewell_agent.agent.abl` (lines 82, 98, 109)

**Step 1: Migrate all 4 traveldesk files**

Same conversion pattern as Task 7.

**Step 2: Verify examples compile**

Run: `cd packages/compiler && npx vitest run --reporter=verbose`

**Step 3: Commit**

```bash
git add examples/travel/
git commit -m "refactor(examples): migrate traveldesk COLLECT to GATHER"
```

---

### Task 10: Full Build and Test Verification

**Step 1: Build the entire monorepo**

Run: `pnpm build`
Expected: Clean build, no errors.

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass. Pay attention to:

- `packages/core` parser tests
- `packages/compiler` compiler and executor tests
- `apps/runtime` tests (they use compiled agents from examples)

**Step 3: Search for any remaining COLLECT references**

Run grep across the entire codebase for:

- `collect?:` in TypeScript files (should only appear in unrelated contexts like array.collect)
- `COLLECT:` in .abl files (should be zero)
- `stepDef.collect` in executor code (should be zero)
- `step.collect` in compiler code (should be zero)

Fix any stragglers found.

**Step 4: Final commit if any stragglers were fixed**

```bash
git commit -m "refactor(abl): clean up remaining COLLECT references"
```

---

## Task Order and Dependencies

```
Task 1 (AST types)
  → Task 2 (Parser)
    → Task 6 (Parser tests)
  → Task 3 (IR schema)
    → Task 4 (Compiler)
    → Task 5 (Executor)
      → Task 7 (flow-test examples)
      → Task 8 (banknexus examples)
      → Task 9 (traveldesk examples)
        → Task 10 (Full verification)
```

Tasks 7, 8, 9 can run in parallel after Task 5.
Task 6 can run in parallel with Tasks 3-5.
Task 10 must run last.
