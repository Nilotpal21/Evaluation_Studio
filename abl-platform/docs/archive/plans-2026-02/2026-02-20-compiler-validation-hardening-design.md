# Compiler Validation Hardening Design

## Problem

The ABL compiler currently validates almost nothing at compile time. Only constraint operators are checked (`validateConstraintOperators()`). Everything else — handoff targets, tool references, flow transitions, field types, memory paths — passes through silently. Broken references are only discovered at runtime when an agent crashes.

## Goals

- **Development-time safety**: Catch broken references and invalid configurations before deployment
- **Deployment gate**: Block deployments that contain errors; surface warnings for potential issues
- **Import validation**: Validate imported projects with the same rigor as compiled ones

## Severity System

- **Error**: Blocks deployment. Definitively broken (dangling step reference, undefined tool, nonexistent handoff target)
- **Warning**: Informational. Potentially broken but may resolve at runtime (condition variable not found in gather fields, unreachable steps)

## Architecture

### Post-IR Validation Pass

Validators run against the compiled IR inside `compileABLtoIR()`, after all agents have been compiled but before the output is assembled. Each validator is a pure function:

```typescript
(agent: AgentIR, allAgents: AgentIR[]) => ValidationDiagnostic[]
```

Integration point in `compiler.ts` (after the agent compilation loop, ~line 104):

```typescript
// After compiling all agents...
const allAgents = compiledAgents.map((a) => a.ir);
for (const agent of allAgents) {
  const diagnostics = validateIR(agent, allAgents);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  compilationErrors.push(
    ...errors.map((d) => ({
      agent: d.agent,
      message: d.message,
      type: 'validation' as const,
    })),
  );
  compilationWarnings.push(
    ...warnings.map((d) => ({
      agent: d.agent,
      message: d.message,
      type: 'validation' as const,
    })),
  );
}
```

### Diagnostic Type

```typescript
interface ValidationDiagnostic {
  agent: string; // Agent that owns the issue
  message: string; // Human-readable description
  type: 'validation';
  severity: 'error' | 'warning';
  code: string; // Machine-readable error code (e.g., 'DANGLING_STEP_REF')
  path?: string; // Location within the IR (e.g., 'flow.steps.greeting.then')
}
```

### Error Codes

| Code                      | Severity | Validator   | Description                                                   |
| ------------------------- | -------- | ----------- | ------------------------------------------------------------- |
| `MISSING_ENTRY_POINT`     | error    | flow-graph  | `entry_point` references nonexistent step                     |
| `DANGLING_STEP_REF`       | error    | flow-graph  | `then`, `on_fail`, or `goto` targets a nonexistent step       |
| `ORPHANED_STEP`           | warning  | flow-graph  | Step unreachable from `entry_point`                           |
| `UNDEFINED_TOOL_CALL`     | error    | tool-refs   | Step `call` references a tool not in `tools[]`                |
| `INVALID_HANDOFF_TARGET`  | error    | cross-agent | Handoff `to` references nonexistent agent                     |
| `INVALID_DELEGATE_TARGET` | error    | cross-agent | Delegate `agent` references nonexistent agent                 |
| `INVALID_ROUTING_TARGET`  | error    | cross-agent | Routing rule targets nonexistent agent                        |
| `UNDEFINED_CONDITION_VAR` | warning  | field-refs  | Condition references variable not in gather fields or session |
| `DUPLICATE_STEP_NAME`     | error    | flow-graph  | Two steps share the same key                                  |
| `EMPTY_FLOW`              | warning  | flow-graph  | Agent has scripted mode but no flow steps                     |

## Validators

### 1. validateFlowGraph

Checks flow step connectivity and reachability for scripted agents.

**Checks:**

- `entry_point` exists in `flow.steps`
- Every `then`, `on_fail`, `goto` target exists in `flow.steps`
- Transition targets in `on_input`, `on_success`, `on_failure`, `on_result`, `on_action` exist
- Digression and sub-intent `goto`/`then` targets exist
- No orphaned steps (unreachable from entry_point via BFS)
- No duplicate step names

**Scope:** Only runs when `execution.mode === 'scripted'` and `flow` is present.

### 2. validateToolReferences

Checks that every `call` field references a defined tool.

**Checks all locations where `call` appears:**

- `flow.steps[*].call`
- `flow.steps[*].on_input[*].call`
- `flow.steps[*].on_success.call` / `on_failure.call` / `on_result.call`
- `flow.steps[*].on_action[*].call`
- `flow.steps[*].digressions[*].call`
- `flow.steps[*].sub_intents[*].call`
- `hooks.on_start.call` / `hooks.on_end.call` / `hooks.on_error.call`

**Validates against:** `agent.tools[]` by name.

### 3. validateCrossAgentRefs

Checks that inter-agent references point to agents that exist in the compilation.

**Checks:**

- `coordination.handoffs[*].to` — target agent exists
- `coordination.delegates[*].agent` — target agent exists
- `routing.rules[*].target` — target agent exists
- `on_start.delegate` — target agent exists
- `error_handler.handoff_target` — target agent exists

**Validates against:** `allAgents` array by matching `domain/name` or just `name`.

### 4. validateFieldReferences

Checks that variables referenced in conditions can be resolved.

**Checks:**

- Condition strings in `flow.steps[*].condition`
- Constraint conditions in `constraints[*].condition`
- Scans for `{{variable}}` patterns and bare identifiers

**Known sources for variables:**

- `gather.fields[*].name`
- `memory.session_vars[*]`
- Built-in context variables (`channel`, `language`, etc.)

**Severity:** Warning only. Runtime context can inject dynamic values that aren't visible at compile time.

## File Structure

```
packages/compiler/src/platform/ir/
├── validation-types.ts          # ValidationDiagnostic, error code constants
├── validate-ir.ts               # Orchestrator + validateFlowGraph + validateToolReferences
├── validate-cross-agent.ts      # validateCrossAgentRefs
└── validate-field-refs.ts       # validateFieldReferences
```

## Import Pipeline Integration

Currently, `packages/project-io/src/import/import-validator.ts` uses regex-based `validateAgentSyntax()` which catches only syntax errors. It misses all semantic validation.

**Solution:** Export a standalone `validateABL()` function from the compiler:

```typescript
export function validateABL(documents: { filename: string; source: string }[]): {
  diagnostics: ValidationDiagnostic[];
  errors: CompilationError[];
};
```

This function parses, compiles, and validates — returning just the diagnostics. The import pipeline calls this instead of (or in addition to) the regex-based syntax check.

## Testing Strategy

- **Unit tests per validator**: Build minimal `AgentIR` fixtures that trigger each error code. One test per diagnostic code.
- **Integration test**: Full `compileABLtoIR()` with ABL source containing known issues. Verify diagnostics appear in `CompilationOutput`.
- **No-false-positive tests**: Valid agents produce zero diagnostics.
- **Warning vs error tests**: Verify severity classification is correct.

## Output Changes

`CompilationOutput` gains a `warnings` field:

```typescript
interface CompilationOutput {
  agents: CompiledAgent[];
  errors: CompilationError[];
  warnings: CompilationError[]; // NEW — validation warnings
  // ... existing fields
}
```

Errors continue to block deployment (existing behavior). Warnings are surfaced in Studio UI and logged but do not block.

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add post-IR validation to the ABL compiler that catches broken flow references, undefined tools, invalid cross-agent targets, and suspicious field references at compile time.

**Architecture:** Four independent validator functions run against compiled `AgentIR` inside `compileABLtoIR()`. Each returns `ValidationDiagnostic[]` with error/warning severity. Errors block deployment; warnings are informational. A standalone `validateABL()` export enables the import pipeline to use the same validation.

**Tech Stack:** TypeScript, Vitest, existing `@abl/compiler` package

---

### Task 1: ValidationDiagnostic Types and Error Codes

**Files:**

- Create: `packages/compiler/src/platform/ir/validation-types.ts`
- Modify: `packages/compiler/src/platform/ir/index.ts`
- Test: `packages/compiler/src/__tests__/validation-types.test.ts`

**Context:** This task defines the shared types and error code constants used by all four validators and the compiler integration. The `CompilationOutput` interface in `schema.ts` (line 1141) will later gain a `warnings` field, but that happens in the integration task (Task 6). For now, just define the diagnostic type.

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validation-types.test.ts`:

```typescript
/**
 * Validation Types Tests
 *
 * Verifies the ValidationDiagnostic type and error code constants
 * are correctly defined and exported.
 */

import { describe, test, expect } from 'vitest';
import { VALIDATION_CODES, type ValidationDiagnostic } from '../platform/ir/validation-types.js';

describe('validation-types', () => {
  test('VALIDATION_CODES contains all expected error codes', () => {
    const expectedCodes = [
      'MISSING_ENTRY_POINT',
      'DANGLING_STEP_REF',
      'ORPHANED_STEP',
      'UNDEFINED_TOOL_CALL',
      'INVALID_HANDOFF_TARGET',
      'INVALID_DELEGATE_TARGET',
      'INVALID_ROUTING_TARGET',
      'UNDEFINED_CONDITION_VAR',
      'DUPLICATE_STEP_NAME',
      'EMPTY_FLOW',
    ];
    for (const code of expectedCodes) {
      expect(VALIDATION_CODES).toHaveProperty(code);
      expect(VALIDATION_CODES[code as keyof typeof VALIDATION_CODES]).toBe(code);
    }
  });

  test('ValidationDiagnostic type is structurally correct', () => {
    const diagnostic: ValidationDiagnostic = {
      agent: 'test_agent',
      message: 'Step "foo" references nonexistent step "bar"',
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.DANGLING_STEP_REF,
      path: 'flow.steps.foo.then',
    };
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.code).toBe('DANGLING_STEP_REF');
    expect(diagnostic.path).toBe('flow.steps.foo.then');
  });

  test('ValidationDiagnostic path is optional', () => {
    const diagnostic: ValidationDiagnostic = {
      agent: 'test_agent',
      message: 'Missing entry point',
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.MISSING_ENTRY_POINT,
    };
    expect(diagnostic.path).toBeUndefined();
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validation-types.test.ts`

Expected: FAIL — module `../platform/ir/validation-types.js` does not exist.

**Step 3: Implement validation-types.ts**

Create `packages/compiler/src/platform/ir/validation-types.ts`:

```typescript
/**
 * Validation Types
 *
 * Shared types and error codes for post-IR validation.
 * Each validator function returns ValidationDiagnostic[].
 */

import type { CompilationError } from './schema.js';

/**
 * Extended diagnostic with severity and machine-readable code.
 * Extends CompilationError so it's compatible with the existing error pipeline.
 */
export interface ValidationDiagnostic extends CompilationError {
  type: 'validation';
  severity: 'error' | 'warning';
  /** Machine-readable error code (e.g., 'DANGLING_STEP_REF') */
  code: string;
  /** Location within the IR (e.g., 'flow.steps.greeting.then') */
  path?: string;
}

/**
 * All validation error/warning codes.
 * Used as `code` field in ValidationDiagnostic.
 */
export const VALIDATION_CODES = {
  // Flow graph
  MISSING_ENTRY_POINT: 'MISSING_ENTRY_POINT',
  DANGLING_STEP_REF: 'DANGLING_STEP_REF',
  ORPHANED_STEP: 'ORPHANED_STEP',
  DUPLICATE_STEP_NAME: 'DUPLICATE_STEP_NAME',
  EMPTY_FLOW: 'EMPTY_FLOW',

  // Tool references
  UNDEFINED_TOOL_CALL: 'UNDEFINED_TOOL_CALL',

  // Cross-agent references
  INVALID_HANDOFF_TARGET: 'INVALID_HANDOFF_TARGET',
  INVALID_DELEGATE_TARGET: 'INVALID_DELEGATE_TARGET',
  INVALID_ROUTING_TARGET: 'INVALID_ROUTING_TARGET',

  // Field references
  UNDEFINED_CONDITION_VAR: 'UNDEFINED_CONDITION_VAR',
} as const;

export type ValidationCode = (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];
```

**Step 4: Export from IR barrel**

Add to `packages/compiler/src/platform/ir/index.ts` (line 9):

```typescript
export * from './validation-types.js';
```

**Step 5: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validation-types.test.ts`

Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/validation-types.ts packages/compiler/src/platform/ir/index.ts packages/compiler/src/__tests__/validation-types.test.ts
git commit -m "[ABLP-2] feat(compiler): add ValidationDiagnostic types and error codes"
```

---

### Task 2: validateFlowGraph Validator

**Files:**

- Create: `packages/compiler/src/platform/ir/validate-ir.ts`
- Test: `packages/compiler/src/__tests__/validate-flow-graph.test.ts`

**Context:** This is the main orchestrator file and the first validator. `validateFlowGraph` checks flow step connectivity for scripted agents. It verifies `entry_point` exists, all `then`/`on_fail`/`goto` targets exist, and detects orphaned steps.

Key IR types to reference:

- `AgentIR` — root type with `execution.mode`, `flow`, `tools`, `coordination`, `routing`, `on_start`, `error_handling`, `gather`, `memory`, `constraints`
- `FlowConfig` — has `entry_point`, `steps` (string[]), `definitions` (Record<string, FlowStep>), `global_digressions`
- `FlowStep` — has `then`, `on_fail`, `call`, `on_input[].then`, `on_success.then`, `on_failure.then`, `on_result[].then`, `digressions[].goto`, `on_success.branches[].then`, `on_failure.branches[].then`

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validate-flow-graph.test.ts`:

```typescript
/**
 * Flow Graph Validator Tests
 *
 * Tests validateFlowGraph for step connectivity, entry point validation,
 * orphan detection, and duplicate step names.
 */

import { describe, test, expect } from 'vitest';
import { validateFlowGraph } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';

/** Helper to create a minimal scripted AgentIR with flow */
function makeAgent(overrides: {
  steps?: string[];
  entryPoint?: string;
  definitions?: Record<string, Partial<FlowStep>>;
  mode?: string;
}): AgentIR {
  const steps = overrides.steps ?? ['step_a', 'step_b'];
  const definitions: Record<string, FlowStep> = {};
  if (overrides.definitions) {
    for (const [name, partial] of Object.entries(overrides.definitions)) {
      definitions[name] = { name, ...partial } as FlowStep;
    }
  } else {
    definitions.step_a = { name: 'step_a', then: 'step_b' } as FlowStep;
    definitions.step_b = { name: 'step_b' } as FlowStep;
  }

  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: (overrides.mode ?? 'scripted') as 'scripted' | 'interactive',
      hints: {} as any,
      timeouts: {} as any,
    },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: {
      steps,
      entry_point: overrides.entryPoint ?? steps[0],
      definitions,
    },
  } as AgentIR;
}

describe('validateFlowGraph', () => {
  test('valid flow produces no diagnostics', () => {
    const agent = makeAgent({
      steps: ['greet', 'collect', 'confirm'],
      entryPoint: 'greet',
      definitions: {
        greet: { then: 'collect' },
        collect: { then: 'confirm' },
        confirm: {},
      },
    });
    expect(validateFlowGraph(agent)).toEqual([]);
  });

  test('MISSING_ENTRY_POINT when entry_point references nonexistent step', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'nonexistent',
      definitions: { step_a: {} },
    });
    const diags = validateFlowGraph(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.MISSING_ENTRY_POINT);
    expect(diags[0].severity).toBe('error');
  });

  test('DANGLING_STEP_REF for then target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'nonexistent' },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling[0].severity).toBe('error');
    expect(dangling[0].path).toContain('step_a');
  });

  test('DANGLING_STEP_REF for on_fail target', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { on_fail: 'missing_step' },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
    expect(dangling[0].message).toContain('missing_step');
  });

  test('DANGLING_STEP_REF for on_input branch then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_input: [{ then: 'ghost_step' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBeGreaterThanOrEqual(1);
  });

  test('DANGLING_STEP_REF for on_success.then and on_failure.then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_success: { then: 'missing_a' },
          on_failure: { then: 'missing_b' },
        },
      },
    });
    const diags = validateFlowGraph(agent);
    const dangling = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(dangling.length).toBe(2);
  });

  test('DANGLING_STEP_REF for on_result branch then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_result: [{ then: 'nowhere', condition: 'result.ok' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('DANGLING_STEP_REF for on_success.branches[].then', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          on_success: {
            branches: [{ then: 'missing_branch_target', condition: 'x > 1' }],
          },
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('DANGLING_STEP_REF for digression goto', () => {
    const agent = makeAgent({
      steps: ['step_a'],
      entryPoint: 'step_a',
      definitions: {
        step_a: {
          digressions: [{ intent: 'cancel', goto: 'no_such_step' }],
        },
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF)).toBe(true);
  });

  test('ORPHANED_STEP for unreachable step (warning)', () => {
    const agent = makeAgent({
      steps: ['step_a', 'step_b', 'orphan'],
      entryPoint: 'step_a',
      definitions: {
        step_a: { then: 'step_b' },
        step_b: {},
        orphan: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const orphans = diags.filter((d) => d.code === VALIDATION_CODES.ORPHANED_STEP);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].severity).toBe('warning');
    expect(orphans[0].message).toContain('orphan');
  });

  test('EMPTY_FLOW when scripted agent has no flow steps (warning)', () => {
    const agent = makeAgent({
      steps: [],
      entryPoint: undefined as any,
      definitions: {},
    });
    // Remove flow entry_point since there are no steps
    agent.flow!.entry_point = undefined;
    const diags = validateFlowGraph(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.EMPTY_FLOW)).toBe(true);
    expect(diags.find((d) => d.code === VALIDATION_CODES.EMPTY_FLOW)?.severity).toBe('warning');
  });

  test('skips validation for interactive mode agents', () => {
    const agent = makeAgent({ mode: 'interactive' });
    const diags = validateFlowGraph(agent);
    expect(diags).toEqual([]);
  });

  test('skips validation when flow is undefined', () => {
    const agent = makeAgent({});
    agent.flow = undefined;
    const diags = validateFlowGraph(agent);
    expect(diags).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-flow-graph.test.ts`

Expected: FAIL — `validateFlowGraph` export does not exist.

**Step 3: Implement validate-ir.ts**

Create `packages/compiler/src/platform/ir/validate-ir.ts`:

```typescript
/**
 * IR Validation Orchestrator
 *
 * Runs all validators against a compiled AgentIR and returns diagnostics.
 * Each validator is a pure function: (agent, allAgents) => ValidationDiagnostic[]
 */

import type { AgentIR, FlowStep } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

// =============================================================================
// ORCHESTRATOR
// =============================================================================

/**
 * Run all validators against a single agent IR.
 * Returns combined diagnostics from all validators.
 */
export function validateIR(agent: AgentIR, allAgents: AgentIR[]): ValidationDiagnostic[] {
  return [...validateFlowGraph(agent), ...validateToolReferences(agent)];
}

// =============================================================================
// FLOW GRAPH VALIDATOR
// =============================================================================

/**
 * Validate flow step connectivity and reachability.
 * Only runs for scripted agents with a flow config.
 */
export function validateFlowGraph(agent: AgentIR): ValidationDiagnostic[] {
  // Skip non-scripted agents or agents without flow
  if (agent.execution.mode !== 'scripted' || !agent.flow) {
    return [];
  }

  const agentName = agent.metadata.name;
  const flow = agent.flow;
  const definitions = flow.definitions;
  const stepNames = new Set(Object.keys(definitions));
  const diagnostics: ValidationDiagnostic[] = [];

  // Check for empty flow
  if (stepNames.size === 0) {
    diagnostics.push({
      agent: agentName,
      message: 'Scripted agent has no flow steps defined',
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.EMPTY_FLOW,
      path: 'flow',
    });
    return diagnostics;
  }

  // Check entry_point
  if (!flow.entry_point || !stepNames.has(flow.entry_point)) {
    diagnostics.push({
      agent: agentName,
      message: `Entry point "${flow.entry_point ?? '(undefined)'}" does not match any defined step. Available steps: ${[...stepNames].join(', ')}`,
      type: 'validation',
      severity: 'error',
      code: VALIDATION_CODES.MISSING_ENTRY_POINT,
      path: 'flow.entry_point',
    });
  }

  // Check all step transitions
  for (const [stepName, step] of Object.entries(definitions)) {
    const checkRef = (target: string | undefined, location: string) => {
      if (target && !stepNames.has(target)) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" references nonexistent step "${target}" in ${location}`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.DANGLING_STEP_REF,
          path: `flow.steps.${stepName}.${location}`,
        });
      }
    };

    // Direct transitions
    checkRef(step.then, 'then');
    checkRef(step.on_fail, 'on_fail');

    // on_input branches
    if (step.on_input) {
      for (let i = 0; i < step.on_input.length; i++) {
        checkRef(step.on_input[i].then, `on_input[${i}].then`);
      }
    }

    // on_result branches
    if (step.on_result) {
      for (let i = 0; i < step.on_result.length; i++) {
        checkRef(step.on_result[i].then, `on_result[${i}].then`);
      }
    }

    // on_success
    if (step.on_success) {
      checkRef(step.on_success.then, 'on_success.then');
      if (step.on_success.branches) {
        for (let i = 0; i < step.on_success.branches.length; i++) {
          checkRef(step.on_success.branches[i].then, `on_success.branches[${i}].then`);
        }
      }
    }

    // on_failure
    if (step.on_failure) {
      checkRef(step.on_failure.then, 'on_failure.then');
      if (step.on_failure.branches) {
        for (let i = 0; i < step.on_failure.branches.length; i++) {
          checkRef(step.on_failure.branches[i].then, `on_failure.branches[${i}].then`);
        }
      }
    }

    // digressions
    if (step.digressions) {
      for (let i = 0; i < step.digressions.length; i++) {
        checkRef(step.digressions[i].goto, `digressions[${i}].goto`);
      }
    }
  }

  // Check global digressions
  if (flow.global_digressions) {
    for (let i = 0; i < flow.global_digressions.length; i++) {
      const d = flow.global_digressions[i];
      if (d.goto && !stepNames.has(d.goto)) {
        diagnostics.push({
          agent: agentName,
          message: `Global digression "${d.intent}" references nonexistent step "${d.goto}"`,
          type: 'validation',
          severity: 'error',
          code: VALIDATION_CODES.DANGLING_STEP_REF,
          path: `flow.global_digressions[${i}].goto`,
        });
      }
    }
  }

  // Orphan detection via BFS from entry_point
  if (flow.entry_point && stepNames.has(flow.entry_point)) {
    const reachable = new Set<string>();
    const queue: string[] = [flow.entry_point];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      const step = definitions[current];
      if (!step) continue;

      // Collect all transition targets from this step
      const targets = collectStepTargets(step);

      // Add global digression targets
      if (flow.global_digressions) {
        for (const d of flow.global_digressions) {
          if (d.goto) targets.add(d.goto);
        }
      }

      for (const target of targets) {
        if (stepNames.has(target) && !reachable.has(target)) {
          queue.push(target);
        }
      }
    }

    for (const stepName of stepNames) {
      if (!reachable.has(stepName)) {
        diagnostics.push({
          agent: agentName,
          message: `Step "${stepName}" is unreachable from entry point "${flow.entry_point}"`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.ORPHANED_STEP,
          path: `flow.steps.${stepName}`,
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Collect all step name targets reachable from a single FlowStep.
 */
function collectStepTargets(step: FlowStep): Set<string> {
  const targets = new Set<string>();

  if (step.then) targets.add(step.then);
  if (step.on_fail) targets.add(step.on_fail);

  if (step.on_input) {
    for (const b of step.on_input) {
      if (b.then) targets.add(b.then);
    }
  }
  if (step.on_result) {
    for (const b of step.on_result) {
      if (b.then) targets.add(b.then);
    }
  }
  if (step.on_success) {
    if (step.on_success.then) targets.add(step.on_success.then);
    if (step.on_success.branches) {
      for (const b of step.on_success.branches) {
        if (b.then) targets.add(b.then);
      }
    }
  }
  if (step.on_failure) {
    if (step.on_failure.then) targets.add(step.on_failure.then);
    if (step.on_failure.branches) {
      for (const b of step.on_failure.branches) {
        if (b.then) targets.add(b.then);
      }
    }
  }
  if (step.digressions) {
    for (const d of step.digressions) {
      if (d.goto) targets.add(d.goto);
    }
  }

  return targets;
}

// =============================================================================
// TOOL REFERENCE VALIDATOR (placeholder — implemented in Task 3)
// =============================================================================

/**
 * Validate that all tool references (call fields) point to defined tools.
 */
export function validateToolReferences(agent: AgentIR): ValidationDiagnostic[] {
  // Placeholder — implemented in Task 3
  return [];
}
```

**Step 4: Export from IR barrel**

Add to `packages/compiler/src/platform/ir/index.ts`:

```typescript
export * from './validate-ir.js';
```

**Step 5: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-flow-graph.test.ts`

Expected: PASS (all tests)

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-ir.ts packages/compiler/src/platform/ir/index.ts packages/compiler/src/__tests__/validate-flow-graph.test.ts
git commit -m "[ABLP-2] feat(compiler): add validateFlowGraph for flow step connectivity validation"
```

---

### Task 3: validateToolReferences Validator

**Files:**

- Modify: `packages/compiler/src/platform/ir/validate-ir.ts`
- Test: `packages/compiler/src/__tests__/validate-tool-refs.test.ts`

**Context:** This validator checks that every `call` field across the entire IR references a tool that exists in `agent.tools[]`. Tool calls appear in many places: `flow.steps[*].call`, `on_input[*].call`, `on_success.call`, `on_failure.call`, `on_result[*].call`, `on_action[*]` (if it has call), `digressions[*].call`, `sub_intents[*].call`, `hooks.*.call`, `on_start.call`, and `global_digressions[*].call`.

System tools (names starting with `__`) are auto-injected by the compiler and should be excluded from this check.

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validate-tool-refs.test.ts`:

```typescript
/**
 * Tool Reference Validator Tests
 *
 * Tests validateToolReferences catches undefined tool calls
 * across all IR locations.
 */

import { describe, test, expect } from 'vitest';
import { validateToolReferences } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep, ToolDefinition } from '../platform/ir/schema.js';

/** Helper: create a minimal AgentIR with specified tools and flow */
function makeAgent(opts: {
  tools?: string[];
  mode?: string;
  steps?: Record<string, Partial<FlowStep>>;
  hooks?: Record<string, { call?: string }>;
  onStart?: { call?: string };
  globalDigressions?: Array<{ intent: string; call?: string }>;
}): AgentIR {
  const tools: ToolDefinition[] = (opts.tools ?? []).map((name) => ({
    name,
    description: `Tool ${name}`,
    parameters: [],
    returns: { type: 'object' },
    hints: {} as any,
  }));

  const definitions: Record<string, FlowStep> = {};
  if (opts.steps) {
    for (const [name, partial] of Object.entries(opts.steps)) {
      definitions[name] = { name, ...partial } as FlowStep;
    }
  }

  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { mode: (opts.mode ?? 'scripted') as any, hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools,
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow:
      Object.keys(definitions).length > 0
        ? {
            steps: Object.keys(definitions),
            entry_point: Object.keys(definitions)[0],
            definitions,
            global_digressions: opts.globalDigressions as any,
          }
        : undefined,
    on_start: opts.onStart as any,
    hooks: opts.hooks as any,
  } as AgentIR;
}

describe('validateToolReferences', () => {
  test('valid tool references produce no diagnostics', () => {
    const agent = makeAgent({
      tools: ['lookup_order', 'send_email'],
      steps: {
        step_a: { call: 'lookup_order', then: 'step_b' },
        step_b: { call: 'send_email' },
      },
    });
    expect(validateToolReferences(agent)).toEqual([]);
  });

  test('UNDEFINED_TOOL_CALL for step.call', () => {
    const agent = makeAgent({
      tools: ['lookup_order'],
      steps: {
        step_a: { call: 'nonexistent_tool' },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.UNDEFINED_TOOL_CALL);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('nonexistent_tool');
  });

  test('UNDEFINED_TOOL_CALL for on_input[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: { on_input: [{ then: 'step_a', call: 'bad_tool' }] },
      },
    });
    const diags = validateToolReferences(agent);
    expect(
      diags.some(
        (d) => d.code === VALIDATION_CODES.UNDEFINED_TOOL_CALL && d.message.includes('bad_tool'),
      ),
    ).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for on_success.branches[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          on_success: {
            branches: [{ call: 'missing_tool', then: 'step_a', condition: 'x' }],
          },
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.UNDEFINED_TOOL_CALL)).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for digressions[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          digressions: [{ intent: 'cancel', call: 'cancel_tool' }],
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('cancel_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for sub_intents[].call', () => {
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: {
          sub_intents: [{ intent: 'help', call: 'help_tool' }],
        },
      },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('help_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for hooks.*.call', () => {
    const agent = makeAgent({
      tools: [],
      hooks: { before_turn: { call: 'hook_tool' } },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('hook_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for on_start.call', () => {
    const agent = makeAgent({
      tools: [],
      onStart: { call: 'start_tool' },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('start_tool'))).toBe(true);
  });

  test('UNDEFINED_TOOL_CALL for global_digressions[].call', () => {
    const agent = makeAgent({
      tools: [],
      globalDigressions: [{ intent: 'faq', call: 'faq_tool' }],
      steps: { step_a: {} },
    });
    const diags = validateToolReferences(agent);
    expect(diags.some((d) => d.message.includes('faq_tool'))).toBe(true);
  });

  test('system tools (starting with __) are not flagged', () => {
    // System tools like __handoff__, __delegate__ are auto-injected
    // and should not trigger UNDEFINED_TOOL_CALL
    const agent = makeAgent({
      tools: [],
      steps: {
        step_a: { call: '__handoff__' },
      },
    });
    // System tools are in agent.tools anyway (compiler adds them),
    // but even if they weren't, calls starting with __ should be skipped
    expect(validateToolReferences(agent)).toEqual([]);
  });

  test('no diagnostics when agent has no flow, hooks, or on_start', () => {
    const agent = makeAgent({ tools: [] });
    expect(validateToolReferences(agent)).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-tool-refs.test.ts`

Expected: FAIL — `validateToolReferences` returns empty array (placeholder).

**Step 3: Implement validateToolReferences in validate-ir.ts**

Replace the placeholder `validateToolReferences` function in `packages/compiler/src/platform/ir/validate-ir.ts`:

```typescript
/**
 * Validate that all tool references (call fields) point to defined tools.
 * System tools (names starting with __) are skipped.
 */
export function validateToolReferences(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const toolNames = new Set(agent.tools.map((t) => t.name));
  const diagnostics: ValidationDiagnostic[] = [];

  const checkCall = (call: string | undefined, path: string) => {
    if (!call) return;
    // Skip system tools (auto-injected by compiler)
    if (call.startsWith('__')) return;
    if (!toolNames.has(call)) {
      diagnostics.push({
        agent: agentName,
        message: `Tool "${call}" is not defined in this agent's tools. Available tools: ${[...toolNames].filter((n) => !n.startsWith('__')).join(', ') || '(none)'}`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.UNDEFINED_TOOL_CALL,
        path,
      });
    }
  };

  // Flow steps
  if (agent.flow) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      checkCall(step.call, `flow.steps.${stepName}.call`);

      if (step.on_input) {
        for (let i = 0; i < step.on_input.length; i++) {
          checkCall(step.on_input[i].call, `flow.steps.${stepName}.on_input[${i}].call`);
        }
      }
      if (step.on_result) {
        for (let i = 0; i < step.on_result.length; i++) {
          checkCall(step.on_result[i].call, `flow.steps.${stepName}.on_result[${i}].call`);
        }
      }
      if (step.on_success) {
        if (step.on_success.branches) {
          for (let i = 0; i < step.on_success.branches.length; i++) {
            checkCall(
              step.on_success.branches[i].call,
              `flow.steps.${stepName}.on_success.branches[${i}].call`,
            );
          }
        }
      }
      if (step.on_failure) {
        if (step.on_failure.branches) {
          for (let i = 0; i < step.on_failure.branches.length; i++) {
            checkCall(
              step.on_failure.branches[i].call,
              `flow.steps.${stepName}.on_failure.branches[${i}].call`,
            );
          }
        }
      }
      if (step.digressions) {
        for (let i = 0; i < step.digressions.length; i++) {
          checkCall(step.digressions[i].call, `flow.steps.${stepName}.digressions[${i}].call`);
        }
      }
      if (step.sub_intents) {
        for (let i = 0; i < step.sub_intents.length; i++) {
          checkCall(step.sub_intents[i].call, `flow.steps.${stepName}.sub_intents[${i}].call`);
        }
      }
    }

    // Global digressions
    if (agent.flow.global_digressions) {
      for (let i = 0; i < agent.flow.global_digressions.length; i++) {
        checkCall(agent.flow.global_digressions[i].call, `flow.global_digressions[${i}].call`);
      }
    }
  }

  // Hooks
  if (agent.hooks) {
    for (const hookKey of ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as const) {
      const hook = agent.hooks[hookKey];
      if (hook?.call) {
        checkCall(hook.call, `hooks.${hookKey}.call`);
      }
    }
  }

  // on_start
  if (agent.on_start?.call) {
    checkCall(agent.on_start.call, 'on_start.call');
  }

  return diagnostics;
}
```

**Step 4: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-tool-refs.test.ts`

Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-ir.ts packages/compiler/src/__tests__/validate-tool-refs.test.ts
git commit -m "[ABLP-2] feat(compiler): add validateToolReferences for tool call validation"
```

---

### Task 4: validateCrossAgentRefs Validator

**Files:**

- Create: `packages/compiler/src/platform/ir/validate-cross-agent.ts`
- Modify: `packages/compiler/src/platform/ir/validate-ir.ts` (wire into orchestrator)
- Modify: `packages/compiler/src/platform/ir/index.ts` (export)
- Test: `packages/compiler/src/__tests__/validate-cross-agent.test.ts`

**Context:** This validator checks that handoff `to`, delegate `agent`, routing rule `target`, `on_start.delegate`, and `error_handler.handoff_target` all reference agents that exist in the compilation. Remote agents (with `remote` field) are excluded since they're external.

Agent name matching: The `allAgents` array contains `AgentIR` objects where `metadata.name` is the agent name. Cross-agent references may use just the name (e.g., `booking_agent`) or `domain/name` format. Match against both.

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validate-cross-agent.test.ts`:

```typescript
/**
 * Cross-Agent Reference Validator Tests
 */

import { describe, test, expect } from 'vitest';
import { validateCrossAgentRefs } from '../platform/ir/validate-cross-agent.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR } from '../platform/ir/schema.js';

function makeAgent(name: string, overrides?: Partial<AgentIR>): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'interactive', hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], ...overrides?.coordination },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any, ...overrides?.error_handling },
    messages: {} as any,
    routing: overrides?.routing,
    on_start: overrides?.on_start,
    ...overrides,
  } as AgentIR;
}

describe('validateCrossAgentRefs', () => {
  const booking = makeAgent('booking_agent');
  const support = makeAgent('support_agent');
  const allAgents = [booking, support];

  test('valid handoff targets produce no diagnostics', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'booking_agent', when: 'intent.booking', context: { pass: [] } }],
      },
    });
    expect(validateCrossAgentRefs(supervisor, [...allAgents, supervisor])).toEqual([]);
  });

  test('INVALID_HANDOFF_TARGET for nonexistent handoff target', () => {
    const supervisor = makeAgent('supervisor', {
      coordination: {
        delegates: [],
        handoffs: [{ to: 'ghost_agent', when: 'always', context: { pass: [] } }],
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_HANDOFF_TARGET);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain('ghost_agent');
  });

  test('INVALID_DELEGATE_TARGET for nonexistent delegate agent', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        handoffs: [],
        delegates: [{ agent: 'missing_agent', when: 'need_help', purpose: 'help' }],
      },
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.INVALID_DELEGATE_TARGET);
  });

  test('INVALID_ROUTING_TARGET for nonexistent routing rule target', () => {
    const supervisor = makeAgent('supervisor', {
      routing: {
        rules: [{ to: 'nowhere_agent', when: 'always', description: 'test', priority: 1 }],
        default_agent: 'fallback',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const diags = validateCrossAgentRefs(supervisor, [...allAgents, supervisor]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_ROUTING_TARGET)).toBe(true);
  });

  test('INVALID_DELEGATE_TARGET for on_start.delegate', () => {
    const agent = makeAgent('main_agent', {
      on_start: { delegate: 'phantom_agent' } as any,
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_DELEGATE_TARGET)).toBe(true);
  });

  test('INVALID_HANDOFF_TARGET for error_handling.handoff_target', () => {
    const agent = makeAgent('main_agent', {
      error_handling: {
        handlers: [{ type: 'tool_error', then: 'handoff', handoff_target: 'missing_agent' }],
        default_handler: {} as any,
      },
    });
    const diags = validateCrossAgentRefs(agent, [...allAgents, agent]);
    expect(diags.some((d) => d.code === VALIDATION_CODES.INVALID_HANDOFF_TARGET)).toBe(true);
  });

  test('remote handoffs are excluded (not flagged)', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'external_agent',
            when: 'always',
            context: { pass: [] },
            remote: { location: 'remote', url: 'https://example.com' },
          },
        ],
      },
    });
    // external_agent doesn't exist in allAgents, but it's remote so should be skipped
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });

  test('remote delegates are excluded (not flagged)', () => {
    const agent = makeAgent('main_agent', {
      coordination: {
        handoffs: [],
        delegates: [
          {
            agent: 'external_delegate',
            when: 'always',
            purpose: 'help',
            remote: { location: 'remote', url: 'https://example.com' },
          },
        ],
      },
    });
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });

  test('no diagnostics when no cross-agent references exist', () => {
    const agent = makeAgent('standalone');
    expect(validateCrossAgentRefs(agent, [agent])).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-cross-agent.test.ts`

Expected: FAIL — module does not exist.

**Step 3: Implement validate-cross-agent.ts**

Create `packages/compiler/src/platform/ir/validate-cross-agent.ts`:

```typescript
/**
 * Cross-Agent Reference Validator
 *
 * Checks that handoff, delegate, routing, on_start.delegate, and
 * error_handling.handoff_target references point to agents that
 * exist in the compilation. Remote agents are excluded.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

/**
 * Validate cross-agent references against the set of all compiled agents.
 */
export function validateCrossAgentRefs(
  agent: AgentIR,
  allAgents: AgentIR[],
): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  // Build set of known agent names
  const knownAgents = new Set(allAgents.map((a) => a.metadata.name));

  const checkAgent = (target: string, code: string, path: string, label: string) => {
    if (!knownAgents.has(target)) {
      diagnostics.push({
        agent: agentName,
        message: `${label} "${target}" does not exist in this compilation. Known agents: ${[...knownAgents].join(', ')}`,
        type: 'validation',
        severity: 'error',
        code,
        path,
      });
    }
  };

  // Handoffs
  if (agent.coordination?.handoffs) {
    for (let i = 0; i < agent.coordination.handoffs.length; i++) {
      const h = agent.coordination.handoffs[i];
      // Skip remote handoffs — they reference external agents
      if ((h as any).remote?.location === 'remote') continue;
      checkAgent(
        h.to,
        VALIDATION_CODES.INVALID_HANDOFF_TARGET,
        `coordination.handoffs[${i}].to`,
        'Handoff target',
      );
    }
  }

  // Delegates
  if (agent.coordination?.delegates) {
    for (let i = 0; i < agent.coordination.delegates.length; i++) {
      const d = agent.coordination.delegates[i];
      // Skip remote delegates
      if ((d as any).remote?.location === 'remote') continue;
      checkAgent(
        d.agent,
        VALIDATION_CODES.INVALID_DELEGATE_TARGET,
        `coordination.delegates[${i}].agent`,
        'Delegate target',
      );
    }
  }

  // Routing rules
  if (agent.routing?.rules) {
    for (let i = 0; i < agent.routing.rules.length; i++) {
      const rule = agent.routing.rules[i];
      checkAgent(
        rule.to,
        VALIDATION_CODES.INVALID_ROUTING_TARGET,
        `routing.rules[${i}].to`,
        'Routing target',
      );
    }
  }

  // on_start.delegate
  if (agent.on_start?.delegate) {
    checkAgent(
      agent.on_start.delegate,
      VALIDATION_CODES.INVALID_DELEGATE_TARGET,
      'on_start.delegate',
      'on_start delegate target',
    );
  }

  // error_handling.handlers[].handoff_target
  if (agent.error_handling?.handlers) {
    for (let i = 0; i < agent.error_handling.handlers.length; i++) {
      const handler = agent.error_handling.handlers[i];
      if (handler.handoff_target) {
        checkAgent(
          handler.handoff_target,
          VALIDATION_CODES.INVALID_HANDOFF_TARGET,
          `error_handling.handlers[${i}].handoff_target`,
          'Error handler handoff target',
        );
      }
    }
  }

  return diagnostics;
}
```

**Step 4: Wire into orchestrator and export**

In `packages/compiler/src/platform/ir/validate-ir.ts`, add the import and call:

```typescript
import { validateCrossAgentRefs } from './validate-cross-agent.js';
```

Update `validateIR`:

```typescript
export function validateIR(agent: AgentIR, allAgents: AgentIR[]): ValidationDiagnostic[] {
  return [
    ...validateFlowGraph(agent),
    ...validateToolReferences(agent),
    ...validateCrossAgentRefs(agent, allAgents),
  ];
}
```

Add to `packages/compiler/src/platform/ir/index.ts`:

```typescript
export * from './validate-cross-agent.js';
```

**Step 5: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-cross-agent.test.ts`

Expected: PASS (all tests)

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-cross-agent.ts packages/compiler/src/platform/ir/validate-ir.ts packages/compiler/src/platform/ir/index.ts packages/compiler/src/__tests__/validate-cross-agent.test.ts
git commit -m "[ABLP-2] feat(compiler): add validateCrossAgentRefs for inter-agent reference validation"
```

---

### Task 5: validateFieldReferences Validator

**Files:**

- Create: `packages/compiler/src/platform/ir/validate-field-refs.ts`
- Modify: `packages/compiler/src/platform/ir/validate-ir.ts` (wire into orchestrator)
- Modify: `packages/compiler/src/platform/ir/index.ts` (export)
- Test: `packages/compiler/src/__tests__/validate-field-refs.test.ts`

**Context:** This validator checks that variables referenced in conditions can be resolved from known sources: `gather.fields[*].name`, per-step `gather.fields[*].name`, `memory.session_vars[*].name`, and built-in variables. All diagnostics from this validator are **warnings** (severity: 'warning') because runtime context can inject dynamic values.

The compiler already has `extractVariableReferences()` in `compiler.ts` (line 595-613) which extracts variable names from constraint conditions. Reuse that function.

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validate-field-refs.test.ts`:

```typescript
/**
 * Field Reference Validator Tests
 */

import { describe, test, expect } from 'vitest';
import { validateFieldReferences } from '../platform/ir/validate-field-refs.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep } from '../platform/ir/schema.js';

function makeAgent(overrides?: {
  gatherFields?: string[];
  sessionVars?: string[];
  steps?: Record<string, Partial<FlowStep>>;
  constraints?: Array<{ condition: string; on_fail: any }>;
}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'scripted' as any, hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: {
      fields: (overrides?.gatherFields ?? []).map((name) => ({
        name,
        prompt: '',
        type: 'string',
        required: true,
        extraction_hints: [],
      })),
      strategy: 'pattern',
    },
    memory: {
      session: (overrides?.sessionVars ?? []).map((name) => ({ name, description: '' })),
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: {
      constraints: overrides?.constraints ?? [],
      guardrails: [],
    },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: overrides?.steps
      ? {
          steps: Object.keys(overrides.steps),
          entry_point: Object.keys(overrides.steps)[0],
          definitions: Object.fromEntries(
            Object.entries(overrides.steps).map(([name, s]) => [name, { name, ...s } as FlowStep]),
          ),
        }
      : undefined,
  } as AgentIR;
}

describe('validateFieldReferences', () => {
  test('known gather field in condition produces no diagnostics', () => {
    const agent = makeAgent({
      gatherFields: ['destination'],
      constraints: [
        { condition: 'destination IS NOT SET OR destination != "NYC"', on_fail: 'respond' },
      ],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('known session var in condition produces no diagnostics', () => {
    const agent = makeAgent({
      sessionVars: ['user_tier'],
      constraints: [{ condition: 'user_tier == "premium"', on_fail: 'respond' }],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('UNDEFINED_CONDITION_VAR for unknown variable in constraint (warning)', () => {
    const agent = makeAgent({
      gatherFields: ['destination'],
      constraints: [{ condition: 'unknown_field == "test"', on_fail: 'respond' }],
    });
    const diags = validateFieldReferences(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe(VALIDATION_CODES.UNDEFINED_CONDITION_VAR);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toContain('unknown_field');
  });

  test('UNDEFINED_CONDITION_VAR for unknown variable in step condition (warning)', () => {
    const agent = makeAgent({
      gatherFields: [],
      steps: {
        check_step: { check: 'mystery_var > 10', then: 'check_step' },
      },
    });
    const diags = validateFieldReferences(agent);
    expect(diags.some((d) => d.code === VALIDATION_CODES.UNDEFINED_CONDITION_VAR)).toBe(true);
  });

  test('step-level gather fields are recognized', () => {
    const agent = makeAgent({
      steps: {
        collect_info: {
          gather: {
            fields: [{ name: 'email', type: 'email', required: true }],
          } as any,
          check: 'email != ""',
          then: 'collect_info',
        },
      },
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('built-in variables (channel, language) are not flagged', () => {
    const agent = makeAgent({
      constraints: [{ condition: 'channel == "voice"', on_fail: 'respond' }],
    });
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('dot-path variables (tool_result.field) are not flagged', () => {
    const agent = makeAgent({
      steps: {
        step_a: { check: 'lookup_result.status == "found"', then: 'step_a' },
      },
    });
    // Variables with dots are tool results or nested fields — too dynamic to validate
    expect(validateFieldReferences(agent)).toEqual([]);
  });

  test('no diagnostics when agent has no conditions', () => {
    const agent = makeAgent({});
    expect(validateFieldReferences(agent)).toEqual([]);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-field-refs.test.ts`

Expected: FAIL — module does not exist.

**Step 3: Implement validate-field-refs.ts**

Create `packages/compiler/src/platform/ir/validate-field-refs.ts`:

```typescript
/**
 * Field Reference Validator
 *
 * Checks that variables referenced in conditions can be resolved
 * from known sources. All diagnostics are warnings.
 */

import type { AgentIR } from './schema.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';
import { extractVariableReferences } from './compiler.js';

/** Built-in context variables available at runtime */
const BUILTIN_VARS = new Set([
  'channel',
  'language',
  'locale',
  'turn_count',
  'session_id',
  'tenant_id',
  'customer_id',
  'input',
  'last_input',
  'intent',
  'result',
]);

/**
 * Validate that condition variables can be resolved from known sources.
 * Returns warnings only — runtime context can inject dynamic values.
 */
export function validateFieldReferences(agent: AgentIR): ValidationDiagnostic[] {
  const agentName = agent.metadata.name;
  const diagnostics: ValidationDiagnostic[] = [];

  // Build the set of known variable names
  const knownVars = new Set<string>(BUILTIN_VARS);

  // Top-level gather fields
  if (agent.gather?.fields) {
    for (const field of agent.gather.fields) {
      knownVars.add(field.name);
    }
  }

  // Session variables
  if (agent.memory?.session) {
    for (const sv of agent.memory.session) {
      knownVars.add(sv.name);
    }
  }

  // Per-step gather fields
  if (agent.flow?.definitions) {
    for (const step of Object.values(agent.flow.definitions)) {
      if (step.gather?.fields) {
        for (const field of step.gather.fields) {
          knownVars.add(field.name);
        }
      }
      // call_as bindings are also known variables
      if (step.call_as) {
        knownVars.add(step.call_as);
      }
    }
  }

  // Collect all conditions to check
  const conditions: Array<{ condition: string; path: string }> = [];

  // Constraint conditions
  if (agent.constraints?.constraints) {
    for (let i = 0; i < agent.constraints.constraints.length; i++) {
      const c = agent.constraints.constraints[i];
      if (c.condition) {
        conditions.push({ condition: c.condition, path: `constraints[${i}].condition` });
      }
    }
  }

  // Flow step conditions and checks
  if (agent.flow?.definitions) {
    for (const [stepName, step] of Object.entries(agent.flow.definitions)) {
      if (step.check) {
        conditions.push({ condition: step.check, path: `flow.steps.${stepName}.check` });
      }
      if (step.complete_when) {
        conditions.push({
          condition: step.complete_when,
          path: `flow.steps.${stepName}.complete_when`,
        });
      }
    }
  }

  // Check each condition
  for (const { condition, path } of conditions) {
    const vars = extractVariableReferences(condition);
    for (const v of vars) {
      // Skip dot-path variables (e.g., tool_result.status) — too dynamic
      if (v.includes('.')) continue;

      if (!knownVars.has(v)) {
        diagnostics.push({
          agent: agentName,
          message: `Variable "${v}" in condition is not found in gather fields, session variables, or built-ins. It may resolve at runtime from tool results or context.`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.UNDEFINED_CONDITION_VAR,
          path,
        });
      }
    }
  }

  return diagnostics;
}
```

**Step 4: Wire into orchestrator and export**

In `packages/compiler/src/platform/ir/validate-ir.ts`, add:

```typescript
import { validateFieldReferences } from './validate-field-refs.js';
```

Update `validateIR`:

```typescript
export function validateIR(agent: AgentIR, allAgents: AgentIR[]): ValidationDiagnostic[] {
  return [
    ...validateFlowGraph(agent),
    ...validateToolReferences(agent),
    ...validateCrossAgentRefs(agent, allAgents),
    ...validateFieldReferences(agent),
  ];
}
```

Add to `packages/compiler/src/platform/ir/index.ts`:

```typescript
export * from './validate-field-refs.js';
```

**Step 5: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-field-refs.test.ts`

Expected: PASS (all tests)

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-field-refs.ts packages/compiler/src/platform/ir/validate-ir.ts packages/compiler/src/platform/ir/index.ts packages/compiler/src/__tests__/validate-field-refs.test.ts
git commit -m "[ABLP-2] feat(compiler): add validateFieldReferences for condition variable validation"
```

---

### Task 6: Compiler Integration — Wire Validators into compileABLtoIR()

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts` (add `warnings` to `CompilationOutput`)
- Modify: `packages/compiler/src/platform/ir/compiler.ts` (call `validateIR` after compilation loop)
- Test: `packages/compiler/src/__tests__/validate-integration.test.ts`

**Context:** This task hooks the validators into the main compilation pipeline. After the `for (const doc of documents)` loop in `compileABLtoIR()` (line 78-104), call `validateIR()` for each compiled agent. Errors go into `compilation_errors`, warnings go into a new `compilation_warnings` field on `CompilationOutput`.

Key integration point in `compiler.ts`:

- Line 74: `const agents: Record<string, AgentIR> = {};`
- Line 75: `const compilationErrors: CompilationError[] = [];`
- Line 78-104: Agent compilation loop
- Line 112: `const output: CompilationOutput = { ... }`

**Step 1: Write the integration test**

Create `packages/compiler/src/__tests__/validate-integration.test.ts`:

```typescript
/**
 * Validation Integration Tests
 *
 * Tests that validation runs as part of compileABLtoIR()
 * and that diagnostics appear in CompilationOutput.
 */

import { describe, test, expect } from 'vitest';
import { validateIR } from '../platform/ir/validate-ir.js';
import type { AgentIR } from '../platform/ir/schema.js';

/**
 * Build a minimal agent IR to test the full validateIR orchestrator.
 */
function makeAgent(name: string): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: { mode: 'scripted' as any, hints: {} as any, timeouts: {} as any },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [
      {
        name: 'my_tool',
        description: '',
        parameters: [],
        returns: { type: 'object' },
        hints: {} as any,
      },
    ],
    gather: {
      fields: [
        { name: 'destination', prompt: '', type: 'string', required: true, extraction_hints: [] },
      ],
      strategy: 'pattern',
    },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: {
      delegates: [],
      handoffs: [{ to: 'support_agent', when: 'need_help', context: { pass: [] } }],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: {
      steps: ['greet', 'collect', 'confirm'],
      entry_point: 'greet',
      definitions: {
        greet: { name: 'greet', call: 'my_tool', then: 'collect' } as any,
        collect: { name: 'collect', then: 'confirm' } as any,
        confirm: { name: 'confirm' } as any,
      },
    },
  } as AgentIR;
}

describe('validateIR integration', () => {
  test('valid agent with all references produces no diagnostics', () => {
    const agent = makeAgent('booking_agent');
    const support = makeAgent('support_agent');
    const diags = validateIR(agent, [agent, support]);
    expect(diags).toEqual([]);
  });

  test('agent with multiple issues returns combined diagnostics', () => {
    const agent = makeAgent('booking_agent');
    // Break: flow reference
    (agent.flow!.definitions.greet as any).then = 'nonexistent_step';
    // Break: tool reference
    (agent.flow!.definitions.collect as any).call = 'nonexistent_tool';
    // Break: handoff target (support_agent won't be in allAgents)
    const diags = validateIR(agent, [agent]);
    // Should have at least: DANGLING_STEP_REF + UNDEFINED_TOOL_CALL + INVALID_HANDOFF_TARGET
    expect(diags.length).toBeGreaterThanOrEqual(3);
    const codes = diags.map((d) => d.code);
    expect(codes).toContain('DANGLING_STEP_REF');
    expect(codes).toContain('UNDEFINED_TOOL_CALL');
    expect(codes).toContain('INVALID_HANDOFF_TARGET');
  });

  test('warnings and errors are correctly classified', () => {
    const agent = makeAgent('booking_agent');
    // Add constraint with unknown variable (warning)
    agent.constraints = {
      constraints: [
        { condition: 'unknown_var == "test"', on_fail: { type: 'respond', message: 'fail' } },
      ],
      guardrails: [],
    };
    // Break: missing step (error)
    (agent.flow!.definitions.greet as any).then = 'missing';

    const support = makeAgent('support_agent');
    const diags = validateIR(agent, [agent, support]);
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run the test to verify it fails (or passes if validators are already wired)**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-integration.test.ts`

Expected: PASS (these tests call `validateIR` directly, not through `compileABLtoIR`).

**Step 3: Add `compilation_warnings` to CompilationOutput schema**

In `packages/compiler/src/platform/ir/schema.ts`, add after line 1167 (`compilation_errors`):

```typescript
  /** Per-agent validation warnings (non-blocking) */
  compilation_warnings?: CompilationError[];
```

**Step 4: Wire validation into compileABLtoIR()**

In `packages/compiler/src/platform/ir/compiler.ts`:

Add import at the top (after line 46):

```typescript
import { validateIR } from './validate-ir.js';
```

After the compilation loop (after line 104, before line 106 `// Analyze for deployment hints`), add:

```typescript
// Post-IR validation pass
const compilationWarnings: import('./schema.js').CompilationError[] = [];
const allAgentIRs = Object.values(agents);
for (const agentIR of allAgentIRs) {
  const diagnostics = validateIR(agentIR, allAgentIRs);
  for (const d of diagnostics) {
    const entry = { agent: d.agent, message: d.message, type: 'validation' as const };
    if (d.severity === 'error') {
      compilationErrors.push(entry);
    } else {
      compilationWarnings.push(entry);
    }
  }
}
```

In the output construction (after line 128, before `return output;`), add:

```typescript
if (compilationWarnings.length > 0) {
  output.compilation_warnings = compilationWarnings;
}
```

**Step 5: Run all compiler tests to ensure no regressions**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run`

Expected: All existing tests pass. The validation should not break any existing tests because valid agents produce zero diagnostics.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/validate-integration.test.ts
git commit -m "[ABLP-2] feat(compiler): wire validation into compileABLtoIR with warnings support"
```

---

### Task 7: Export validateABL() for Import Pipeline

**Files:**

- Modify: `packages/compiler/src/platform/ir/validate-ir.ts` (add `validateABL` function)
- Modify: `packages/compiler/src/index.ts` (export `validateABL`)
- Test: `packages/compiler/src/__tests__/validate-abl-export.test.ts`

**Context:** The import pipeline at `packages/project-io/src/import/import-validator.ts` currently uses regex-based `validateAgentSyntax()`. We need a standalone function that parses, compiles, and validates ABL source, returning just the diagnostics. This function is a thin wrapper around `compileABLtoIR()` that captures its output.

The ABL parser is at `@abl/core` and its `parseABL` function takes a string and returns an `AgentBasedDocument`. The compiler's `compileABLtoIR()` takes `AgentBasedDocument[]`. So `validateABL` needs to:

1. Parse each source string into an `AgentBasedDocument`
2. Call `compileABLtoIR()` with all documents
3. Return `compilation_errors` and `compilation_warnings` from the output

**Step 1: Write the test**

Create `packages/compiler/src/__tests__/validate-abl-export.test.ts`:

```typescript
/**
 * validateABL Export Tests
 *
 * Tests the standalone validateABL function that parses + compiles + validates.
 */

import { describe, test, expect } from 'vitest';
import { validateABL } from '../platform/ir/validate-ir.js';

describe('validateABL', () => {
  test('returns empty diagnostics for valid ABL source', () => {
    const result = validateABL([
      {
        filename: 'greeting.abl',
        source: `AGENT: greeting_agent
GOAL: Greet users
PERSONA: Friendly assistant

FLOW:
  greet:
    RESPOND: Hello!
`,
      },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('returns parse errors for invalid ABL syntax', () => {
    const result = validateABL([
      {
        filename: 'broken.abl',
        source: 'this is not valid ABL at all',
      },
    ]);
    // Should have at least one parse/compilation error
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns validation errors for broken references', () => {
    // This test creates a valid parseable agent that has a bad flow reference
    // The exact ABL syntax may need adjustment based on the parser
    const result = validateABL([
      {
        filename: 'bad_refs.abl',
        source: `AGENT: bad_agent
GOAL: Test bad refs

FLOW:
  step_a:
    RESPOND: Hello
    THEN: nonexistent_step
`,
      },
    ]);
    // Should produce DANGLING_STEP_REF error
    const allDiags = [...result.errors, ...result.warnings];
    expect(
      allDiags.some((d) => d.message.includes('nonexistent_step') || d.type === 'validation'),
    ).toBe(true);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-abl-export.test.ts`

Expected: FAIL — `validateABL` export does not exist.

**Step 3: Implement validateABL in validate-ir.ts**

Add to `packages/compiler/src/platform/ir/validate-ir.ts`:

```typescript
import type { CompilationError } from './schema.js';
import { compileABLtoIR } from './compiler.js';

/**
 * Standalone validation function for the import pipeline.
 * Parses, compiles, and validates ABL source files.
 * Returns errors and warnings without requiring the caller to
 * understand the compilation pipeline.
 */
export function validateABL(documents: Array<{ filename: string; source: string }>): {
  errors: CompilationError[];
  warnings: CompilationError[];
} {
  try {
    // Dynamic import to avoid circular dependency at module load time
    // The parser is in @abl/core
    const { parseABL } = require('@abl/core');

    const parsed = [];
    const parseErrors: CompilationError[] = [];

    for (const doc of documents) {
      try {
        const ast = parseABL(doc.source);
        parsed.push(ast);
      } catch (err: any) {
        parseErrors.push({
          agent: doc.filename,
          message: err.message || String(err),
          type: 'parse',
        });
      }
    }

    if (parsed.length === 0) {
      return { errors: parseErrors, warnings: [] };
    }

    const output = compileABLtoIR(parsed);
    const errors = [...parseErrors, ...(output.compilation_errors ?? [])];
    const warnings = output.compilation_warnings ?? [];

    return { errors, warnings };
  } catch (err: any) {
    return {
      errors: [{ agent: '(global)', message: err.message || String(err), type: 'compilation' }],
      warnings: [],
    };
  }
}
```

**Note:** The exact parser import may need adjustment. Check how `@abl/core` exports its parser. If `parseABL` is not the correct export name, look at the `@abl/core` package to find the right function. Common alternatives: `parse`, `parseDocument`, `parseAgent`.

**Step 4: Export from main barrel**

In `packages/compiler/src/index.ts`, add the export alongside other IR exports:

```typescript
export { validateABL } from './platform/ir/validate-ir.js';
```

Also export the `ValidationDiagnostic` type:

```typescript
export type { ValidationDiagnostic, ValidationCode } from './platform/ir/validation-types.js';
```

**Step 5: Run the test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-abl-export.test.ts`

Expected: PASS (or adjust based on actual parser API).

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/validate-ir.ts packages/compiler/src/index.ts packages/compiler/src/__tests__/validate-abl-export.test.ts
git commit -m "[ABLP-2] feat(compiler): export validateABL for import pipeline integration"
```

---

### Task 8: Run Full Test Suite and Fix Regressions

**Files:**

- Possibly modify: any files touched in Tasks 1-7 if tests fail

**Context:** The validation pass may cause existing tests that compile agents with intentional issues to now produce errors/warnings. We need to verify the full compiler test suite still passes and fix any regressions.

**Step 1: Build everything**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`

Expected: Build succeeds.

**Step 2: Run full compiler test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/compiler test -- --run`

Expected: All tests pass. If any fail, they're likely tests that compile agents with intentionally broken references that now produce validation errors/warnings in the output. Fix by:

- If the test is checking `CompilationOutput`, update it to expect the new `compilation_warnings` field
- If a fixture agent has a broken reference that's intentional for the test, that's fine — the test should still pass because validation errors are additive (they don't block compilation)

**Step 3: Run the full validation test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/compiler test -- --run src/__tests__/validate-*.test.ts src/__tests__/validation-types.test.ts`

Expected: All validation tests pass.

**Step 4: Commit if any fixes were needed**

```bash
git add -u
git commit -m "[ABLP-2] fix(compiler): fix test regressions from validation integration"
```

(Skip if no fixes needed.)
