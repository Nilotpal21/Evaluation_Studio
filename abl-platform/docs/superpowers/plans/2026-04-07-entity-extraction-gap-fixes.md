# Entity Extraction Gap Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 16 entity extraction gaps across the runtime and compiler — bring all 8 extraction call sites to validation/normalization parity, wire missing ABL properties through parser→compiler→IR, and merge NLU entity definitions into GATHER fields at compile time.

**Architecture:** Two workstreams. WS2 (Compiler) runs first because it adds `synonyms` to the IR that WS1 (Runtime) consumes. Within WS2: schema types → parser → compiler → merge logic. Within WS1: shared validation utility → reasoning-executor call sites → flow-step-executor call sites → tier merge/fallback fixes.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (Turbo build), packages: `@abl/core` (parser/AST), `@abl/compiler` (IR/compiler), `apps/runtime` (execution)

**Design Spec:** `docs/superpowers/specs/2026-04-06-entity-extraction-gap-fixes-design.md`

---

## File Structure

### New Files

| File                                                                  | Responsibility                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/services/execution/extraction-validation.ts`        | Pure functions: `validateExtractedValue()`, `normalizeEnumValue()` |
| `apps/runtime/src/__tests__/extraction/extraction-validation.test.ts` | Unit tests for the shared validation utilities                     |

### Modified Files

| File                                                        | Changes                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`               | Add `synonyms` to `GatherField` + `FlowGatherField`, add `enum_values` to `FlowGatherField`, add `validation_process` to `ValidationRule` |
| `packages/core/src/types/agent-based.ts`                    | Add `sensitive` to `NLUEntityDefinition`                                                                                                  |
| `packages/core/src/parser/agent-based-parser.ts`            | Parse `MAX_RETRIES` in GATHER, parse `SENSITIVE` in NLU entities                                                                          |
| `packages/compiler/src/platform/ir/compiler.ts`             | Wire `retryPrompt`/`validationProcess`/`maxRetries`, NLU-GATHER merge, `sensitive` in `compileNLU`, `enum_values` in flow gather          |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Call sites #1, #2, #3, #4: add validation, lookupTables, complete_when, DELEGATE WHEN vars, filter uncollected                            |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Call sites #5-#8: add validation. Fix tier merge order. Pass fieldTypes to fallback                                                       |

---

## WS2: Compiler Pipeline

### Task 1: Add `synonyms` and `validation_process` to IR schema types

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:1133-1191` (GatherField, ValidationRule)
- Modify: `packages/compiler/src/platform/ir/schema.ts:1965-2006` (FlowGatherField)

- [ ] **Step 1: Add `synonyms` to `GatherField`**

In `packages/compiler/src/platform/ir/schema.ts`, add after `enum_values` (line 1173):

```typescript
  /** Allowed values for enum type fields (used by Studio test context and LLM extraction) */
  enum_values?: string[];
  /** Synonym map from NLU entity definitions (canonical value → synonym list) */
  synonyms?: Record<string, string[]>;
```

- [ ] **Step 2: Add `validation_process` to `ValidationRule`**

In `packages/compiler/src/platform/ir/schema.ts`, add after `max_retries` (line 1190):

```typescript
  /** Max validation retry attempts before escalation */
  max_retries?: number;
  /** Validation process type */
  validation_process?: 'REGEX' | 'CODE' | 'LLM';
}
```

- [ ] **Step 3: Add `enum_values` and `synonyms` to `FlowGatherField`**

In `packages/compiler/src/platform/ir/schema.ts`, add after `extraction_group` (line 2003):

```typescript
  /** Capture group index for extraction_pattern (default: 0 = full match) */
  extraction_group?: number;
  /** Allowed values for enum type fields */
  enum_values?: string[];
  /** Synonym map from NLU entity definitions (canonical value → synonym list) */
  synonyms?: Record<string, string[]>;
```

- [ ] **Step 4: Build the compiler package to verify types**

Run: `pnpm build --filter=@abl/compiler`
Expected: Success — these are additive type changes only.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "[ABLP-XXX] refactor(compiler): add synonyms, enum_values, validation_process to IR schema types

Gaps 9, 30: Add synonyms to GatherField and FlowGatherField for NLU entity
enrichment. Add enum_values to FlowGatherField for parity with GatherField.
Add validation_process to ValidationRule for LLM/CODE/REGEX routing."
```

---

### Task 2: Add `sensitive` to NLU AST type and parser

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:1357-1364` (NLUEntityDefinition)
- Modify: `packages/core/src/parser/agent-based-parser.ts:6928-6957` (NLU entity parsing)

- [ ] **Step 1: Add `sensitive` to AST `NLUEntityDefinition`**

In `packages/core/src/types/agent-based.ts`, add after `validation` (line 1363):

```typescript
  validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
}
```

- [ ] **Step 2: Add `SENSITIVE` parsing in NLU entity switch**

In `packages/core/src/parser/agent-based-parser.ts`, add a new case after the `VALIDATION` case (line 6943):

```typescript
          case 'VALIDATION':
            currentEntity.validation = value;
            break;
          case 'SENSITIVE':
            currentEntity.sensitive = value === 'true' || value === 'yes';
            break;
```

- [ ] **Step 3: Build core package**

Run: `pnpm build --filter=@abl/core`
Expected: Success

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/core/src/types/agent-based.ts packages/core/src/parser/agent-based-parser.ts
git add packages/core/src/types/agent-based.ts packages/core/src/parser/agent-based-parser.ts
git commit -m "[ABLP-XXX] feat(core): parse SENSITIVE flag on NLU entity definitions

Gap 31: NLU entity definitions can now declare sensitive: true for PII
awareness. Adds the field to the AST type and parser."
```

---

### Task 3: Parse `MAX_RETRIES` in top-level GATHER

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts:3080-3097` (GATHER field parsing)

- [ ] **Step 1: Add `MAX_RETRIES` case to GATHER field parser**

In `packages/core/src/parser/agent-based-parser.ts`, add a new case after `retry_prompt` (line 3097):

```typescript
          case 'retry_prompt':
            currentField.retryPrompt = value.replace(/^"|"$/g, '');
            break;
          case 'max_retries':
            currentField.maxRetries = parseInt(value, 10);
            break;
```

- [ ] **Step 2: Build core package**

Run: `pnpm build --filter=@abl/core`
Expected: Success — the AST `GatherField.maxRetries` field already exists (agent-based.ts:669).

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/core/src/parser/agent-based-parser.ts
git add packages/core/src/parser/agent-based-parser.ts
git commit -m "[ABLP-XXX] feat(core): parse max_retries in top-level GATHER blocks

Gap 5: The parser now populates GatherField.maxRetries from the ABL
max_retries property. Previously parsed for FLOW GATHER but missing
from top-level GATHER."
```

---

### Task 4: Wire `retryPrompt`, `validationProcess`, `maxRetries` in `compileGather()`

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:1013-1072` (compileGather function)

- [ ] **Step 1: Add validation property wiring in `compileGather()`**

In `packages/compiler/src/platform/ir/compiler.ts`, the current validation block (lines 1021-1034) builds the `validation` object but never includes `retry_prompt`, `max_retries`, or `validation_process`. Update the validation construction to include them.

Replace the validation block (lines 1021-1034):

```typescript
      validation:
        f.type === 'enum' && f.options?.length
          ? {
              type: 'enum' as const,
              rule: f.options.join('|'),
              error_message: `Invalid ${f.name}. Allowed values: ${f.options.join(', ')}`,
            }
          : f.validate
            ? {
                type: 'custom' as const,
                rule: f.validate,
                error_message: `Invalid ${f.name}`,
              }
            : undefined,
```

With:

```typescript
      validation:
        f.type === 'enum' && f.options?.length
          ? {
              type: 'enum' as const,
              rule: f.options.join('|'),
              error_message: `Invalid ${f.name}. Allowed values: ${f.options.join(', ')}`,
              retry_prompt: f.retryPrompt,
              max_retries: f.maxRetries,
              validation_process: f.validationProcess,
            }
          : f.validate
            ? {
                type: 'custom' as const,
                rule: f.validate,
                error_message: `Invalid ${f.name}`,
                retry_prompt: f.retryPrompt,
                max_retries: f.maxRetries,
                validation_process: f.validationProcess,
              }
            : f.retryPrompt || f.maxRetries || f.validationProcess
              ? {
                  type: 'custom' as const,
                  rule: '',
                  error_message: `Invalid ${f.name}`,
                  retry_prompt: f.retryPrompt,
                  max_retries: f.maxRetries,
                  validation_process: f.validationProcess,
                }
              : undefined,
```

- [ ] **Step 2: Build compiler package**

Run: `pnpm build --filter=@abl/compiler`
Expected: Success

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts
git add packages/compiler/src/platform/ir/compiler.ts
git commit -m "[ABLP-XXX] feat(compiler): wire retryPrompt, validationProcess, maxRetries through compileGather

Gaps 5, 6: The compiler now passes retry_prompt, max_retries, and
validation_process from AST GatherField to IR ValidationRule. Previously
these AST fields were parsed but dropped during compilation."
```

---

### Task 5: Wire `sensitive` in `compileNLU()` and `enum_values` in flow GATHER compilation

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:3073-3080` (compileNLU entities mapping)
- Modify: `packages/compiler/src/platform/ir/compiler.ts:2661-2695` (flow step GATHER compilation)

- [ ] **Step 1: Add `sensitive` to NLU entity mapping**

In `packages/compiler/src/platform/ir/compiler.ts`, in the `compileNLU` function's entities mapping (line 3073-3080), add `sensitive`:

```typescript
    entities: nluDef.entities.map((e) => ({
      name: e.name,
      type: e.type,
      values: e.values,
      synonyms: e.synonyms,
      pattern: e.pattern,
      validation: e.validation,
      sensitive: e.sensitive,
    })),
```

- [ ] **Step 2: Add `enum_values` and validation wiring to flow GATHER compilation**

In `packages/compiler/src/platform/ir/compiler.ts`, in the flow step gather field mapping (lines 2661-2695), add `enum_values` after `prompt_mode` (line 2694) and update the validation block:

Replace the current field mapping (lines 2661-2695):

```typescript
                fields: step.gather.fields.map((f) => ({
                  name: f.name,
                  type: f.type,
                  required: f.required,
                  default: f.default,
                  prompt: f.prompt,
                  validation: f.validation
                    ? {
                        type: 'custom' as const,
                        rule: f.validation,
                        error_message: `Invalid ${f.name}`,
                      }
                    : undefined,
                  extraction_hints: f.extractionHints,
                  infer: f.infer,
                  infer_confidence: f.inferConfidence,
                  infer_confirm: f.inferConfirm,
                  semantics: f.semantics
                    ? {
                        format: f.semantics.format,
                        components: f.semantics.components,
                        unit: f.semantics.unit,
                        lookup: f.semantics.lookup,
                        convert_to: f.semantics.convertTo,
                        locale: f.semantics.locale,
                        kore_entity_type: f.semantics.koreEntityType,
                      }
                    : undefined,
                  range: f.range,
                  list: f.list,
                  preferences: f.preferences,
                  activation: f.activation,
                  depends_on: f.dependsOn,
                  prompt_mode: f.promptMode,
                })),
```

With:

```typescript
                fields: step.gather.fields.map((f) => ({
                  name: f.name,
                  type: f.type,
                  required: f.required,
                  default: f.default,
                  prompt: f.prompt,
                  validation: f.validation
                    ? {
                        type: 'custom' as const,
                        rule: f.validation,
                        error_message: `Invalid ${f.name}`,
                        retry_prompt: f.retryPrompt,
                        max_retries: f.maxRetries,
                        validation_process: f.validationProcess,
                      }
                    : f.retryPrompt || f.maxRetries || f.validationProcess
                      ? {
                          type: 'custom' as const,
                          rule: '',
                          error_message: `Invalid ${f.name}`,
                          retry_prompt: f.retryPrompt,
                          max_retries: f.maxRetries,
                          validation_process: f.validationProcess,
                        }
                      : undefined,
                  extraction_hints: f.extractionHints,
                  infer: f.infer,
                  infer_confidence: f.inferConfidence,
                  infer_confirm: f.inferConfirm,
                  semantics: f.semantics
                    ? {
                        format: f.semantics.format,
                        components: f.semantics.components,
                        unit: f.semantics.unit,
                        lookup: f.semantics.lookup,
                        convert_to: f.semantics.convertTo,
                        locale: f.semantics.locale,
                        kore_entity_type: f.semantics.koreEntityType,
                      }
                    : undefined,
                  range: f.range,
                  list: f.list,
                  preferences: f.preferences,
                  activation: f.activation,
                  depends_on: f.dependsOn,
                  prompt_mode: f.promptMode,
                  enum_values: f.options?.length ? f.options : undefined,
                })),
```

- [ ] **Step 3: Build compiler package**

Run: `pnpm build --filter=@abl/compiler`
Expected: Success

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts
git add packages/compiler/src/platform/ir/compiler.ts
git commit -m "[ABLP-XXX] feat(compiler): wire sensitive in compileNLU, enum_values in flow GATHER

Gap 31: compileNLU now passes sensitive flag through to IR EntityDefinition.
Gap 9: Flow step GATHER compilation now maps options to enum_values and
wires retryPrompt/maxRetries/validationProcess to ValidationRule."
```

---

### Task 6: NLU-to-GATHER merge logic in compiler

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts` (add `mergeNLUIntoGather` function, call it from `compileToAgentIR`)

- [ ] **Step 1: Add the `mergeNLUIntoGather` function**

In `packages/compiler/src/platform/ir/compiler.ts`, add this function after `compileGather()` (after line 1072):

```typescript
/**
 * Merge NLU entity definitions into GATHER fields at compile time.
 *
 * Rules:
 * - If GATHER field name matches an NLU entity name:
 *   - Types must match (if both specified) — compile error otherwise
 *   - If GATHER has enum_values: keep as canonical, bring NLU synonyms only for matching values
 *   - If GATHER has no enum_values: bring all NLU values + synonyms
 * - If no matching NLU entity: GATHER field unchanged
 */
function mergeNLUIntoGather(
  gatherFields: GatherField[],
  nluEntities: Array<{
    name: string;
    type: string;
    values?: string[];
    synonyms?: Record<string, string[]>;
  }>,
  agentName: string,
): void {
  for (const field of gatherFields) {
    const entity = nluEntities.find((e) => e.name === field.name);
    if (!entity) continue;

    // Type check: both must agree if both specified
    if (field.type && entity.type && field.type !== entity.type) {
      // Map NLU entity types to GATHER field types for comparison
      const nluType = entity.type === 'free_text' ? 'string' : entity.type;
      if (field.type !== nluType) {
        throw new Error(
          `[${agentName}] GATHER field "${field.name}" has type "${field.type}" but NLU entity has type "${entity.type}". Types must match.`,
        );
      }
    }

    if (field.enum_values && field.enum_values.length > 0) {
      // GATHER has options — filter NLU synonyms to only matching values
      const synonyms: Record<string, string[]> = {};
      for (const value of field.enum_values) {
        if (entity.synonyms?.[value]) {
          synonyms[value] = entity.synonyms[value];
        }
      }
      if (Object.keys(synonyms).length > 0) {
        field.synonyms = synonyms;
      }
    } else if (entity.values && entity.values.length > 0) {
      // GATHER has no options — bring everything from NLU
      field.enum_values = entity.values;
      if (entity.synonyms) {
        field.synonyms = entity.synonyms;
      }
    }
  }
}
```

- [ ] **Step 2: Call `mergeNLUIntoGather` from the main `compileToAgentIR` function**

In `packages/compiler/src/platform/ir/compiler.ts`, after the IR object is built (around line 650, after the `ir` const), add the merge call:

Find the line after `nlu: doc.nlu ? compileNLU(doc.nlu) : undefined,` (line 648) and the closing of the `ir` object. After `ir` is fully constructed (around line 650), add:

```typescript
// Merge NLU entity definitions (synonyms, values) into GATHER fields
if (ir.nlu?.entities && ir.nlu.entities.length > 0 && ir.gather?.fields) {
  mergeNLUIntoGather(ir.gather.fields, ir.nlu.entities, ir.metadata.name);
}
```

This must go after the IR is built but before it's returned, so the merge can access both `ir.gather` and `ir.nlu`.

- [ ] **Step 3: Add merge for flow step GATHER fields too**

Search for the flow compilation section. After each flow step's gather is compiled (around line 2699), the same merge should apply. However, flow steps access the top-level NLU config, so add after the flow step gather mapping:

Find in the flow compilation where `step.gather` is mapped (around line 2660-2699). After the gather object is built, we need to merge NLU into its fields. The simplest approach: do the merge in a second pass after the IR is fully built.

Add after the existing `mergeNLUIntoGather` call (the one added in Step 2):

```typescript
// Also merge NLU into flow step GATHER fields
if (ir.nlu?.entities && ir.nlu.entities.length > 0 && ir.flow?.steps) {
  for (const step of ir.flow.steps) {
    if (step.gather?.fields && step.gather.fields.length > 0) {
      mergeNLUIntoGather(
        step.gather.fields as unknown as GatherField[],
        ir.nlu.entities,
        ir.metadata.name,
      );
    }
  }
}
```

- [ ] **Step 4: Build compiler package**

Run: `pnpm build --filter=@abl/compiler`
Expected: Success

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts
git add packages/compiler/src/platform/ir/compiler.ts
git commit -m "[ABLP-XXX] feat(compiler): merge NLU entity definitions into GATHER fields at compile time

Gap 30: When a GATHER field name matches an NLU entity name, the compiler
now merges NLU synonyms and values into the GATHER field IR. Types must
match (compile error otherwise). GATHER options filter NLU synonyms; if
no options, all NLU values/synonyms are inherited."
```

---

## WS1: Runtime Parity

### Task 7: Create shared validation utilities

**Files:**

- Create: `apps/runtime/src/services/execution/extraction-validation.ts`
- Create: `apps/runtime/src/__tests__/extraction/extraction-validation.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/runtime/src/__tests__/extraction/extraction-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  normalizeEnumValue,
  validateExtractedValue,
} from '../../services/execution/extraction-validation.js';

describe('normalizeEnumValue', () => {
  const options = ['iPhone', 'iPad', 'Mac', 'Apple Watch', 'AirPods'];

  it('returns exact match unchanged', () => {
    expect(normalizeEnumValue('iPhone', options)).toBe('iPhone');
  });

  it('returns case-insensitive match', () => {
    expect(normalizeEnumValue('iphone', options)).toBe('iPhone');
    expect(normalizeEnumValue('IPAD', options)).toBe('iPad');
  });

  it('returns synonym match when synonyms provided', () => {
    const synonyms = {
      iPhone: ['apple phone', 'mobile'],
      Mac: ['macbook', 'macbook pro', 'laptop'],
    };
    expect(normalizeEnumValue('apple phone', options, synonyms)).toBe('iPhone');
    expect(normalizeEnumValue('macbook pro', options, synonyms)).toBe('Mac');
    expect(normalizeEnumValue('LAPTOP', options, synonyms)).toBe('Mac');
  });

  it('returns substring match (shortest option wins)', () => {
    expect(normalizeEnumValue('MacBook Pro', options)).toBe('Mac');
    expect(normalizeEnumValue('my airpods', options)).toBe('AirPods');
  });

  it('prefers shorter option on substring ambiguity', () => {
    const opts = ['MacBook Pro', 'Mac'];
    // "Mac" is shorter and is contained in input
    expect(normalizeEnumValue('I have a Mac mini', opts)).toBe('Mac');
  });

  it('returns null when no match', () => {
    expect(normalizeEnumValue('Android', options)).toBeNull();
  });

  it('handles empty enum values', () => {
    expect(normalizeEnumValue('anything', [])).toBeNull();
  });
});

describe('validateExtractedValue', () => {
  it('accepts valid string value', () => {
    const field = { name: 'name', type: 'string', prompt: '', required: true };
    const result = validateExtractedValue(field, 'Alice');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('Alice');
  });

  it('accepts valid number value', () => {
    const field = { name: 'age', type: 'number', prompt: '', required: true };
    expect(validateExtractedValue(field, 25).valid).toBe(true);
    expect(validateExtractedValue(field, '25').valid).toBe(true);
    expect(validateExtractedValue(field, '25').normalized).toBe(25);
  });

  it('rejects non-numeric for number field', () => {
    const field = { name: 'age', type: 'number', prompt: '', required: true };
    const result = validateExtractedValue(field, 'banana');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('accepts valid boolean value', () => {
    const field = { name: 'agree', type: 'boolean', prompt: '', required: true };
    expect(validateExtractedValue(field, true).valid).toBe(true);
    expect(validateExtractedValue(field, 'yes').normalized).toBe(true);
    expect(validateExtractedValue(field, 'no').normalized).toBe(false);
  });

  it('normalizes enum value via normalizeEnumValue', () => {
    const field = {
      name: 'device',
      type: 'enum',
      prompt: '',
      required: true,
      enum_values: ['iPhone', 'iPad', 'Mac'],
      synonyms: { Mac: ['macbook'] },
    };
    const result = validateExtractedValue(field, 'macbook');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('Mac');
  });

  it('rejects invalid enum value', () => {
    const field = {
      name: 'device',
      type: 'enum',
      prompt: '',
      required: true,
      enum_values: ['iPhone', 'iPad'],
    };
    const result = validateExtractedValue(field, 'Android');
    expect(result.valid).toBe(false);
  });

  it('passes through unknown types without validation', () => {
    const field = { name: 'data', type: 'custom_thing', prompt: '', required: true };
    const result = validateExtractedValue(field, 'anything');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('anything');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/runtime/src/__tests__/extraction/extraction-validation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `apps/runtime/src/services/execution/extraction-validation.ts`:

```typescript
/**
 * Shared validation and normalization utilities for entity extraction.
 *
 * Pure functions — no session state, no side effects.
 * Used by all 8 extraction call sites to ensure parity.
 */

export interface ExtractionField {
  name: string;
  type?: string;
  prompt?: string;
  required?: boolean;
  enum_values?: string[];
  synonyms?: Record<string, string[]>;
}

export interface ValidationResult {
  valid: boolean;
  normalized?: unknown;
  error?: string;
}

const TRUTHY_VALUES = new Set(['true', 'yes', '1', 'y', 'si', 'sí']);
const FALSY_VALUES = new Set(['false', 'no', '0', 'n']);

/**
 * Normalize a raw extracted value to a canonical enum value.
 *
 * 4-step matching:
 * 1. Exact match
 * 2. Case-insensitive match
 * 3. Synonym lookup (case-insensitive against synonym lists)
 * 4. Substring match (prefer shortest matching option)
 *
 * Returns the canonical value or null if no match.
 */
export function normalizeEnumValue(
  value: string,
  enumValues: string[],
  synonyms?: Record<string, string[]>,
): string | null {
  if (enumValues.length === 0) return null;

  // 1. Exact match
  if (enumValues.includes(value)) return value;

  // 2. Case-insensitive match
  const lower = value.toLowerCase();
  const ciMatch = enumValues.find((o) => o.toLowerCase() === lower);
  if (ciMatch) return ciMatch;

  // 3. Synonym lookup
  if (synonyms) {
    for (const [canonical, syns] of Object.entries(synonyms)) {
      if (!enumValues.includes(canonical)) continue;
      for (const syn of syns) {
        if (syn.toLowerCase() === lower) return canonical;
      }
    }
  }

  // 4. Substring match — prefer shortest matching option
  const substringMatches: string[] = [];
  for (const option of enumValues) {
    const optLower = option.toLowerCase();
    if (lower.includes(optLower) || optLower.includes(lower)) {
      substringMatches.push(option);
    }
  }
  if (substringMatches.length > 0) {
    // Sort by length ascending — shortest match is most specific
    substringMatches.sort((a, b) => a.length - b.length);
    return substringMatches[0];
  }

  return null;
}

/**
 * Validate and normalize an extracted value against a field definition.
 *
 * Type-checks the value and normalizes enums. Does NOT run ValidationRule
 * checks (pattern, range, custom) — those are handled by the existing
 * `validateField()` from `@abl/compiler/platform/constructs/utils.js`.
 *
 * This function handles type coercion and enum normalization that
 * `validateField()` does not cover.
 */
export function validateExtractedValue(field: ExtractionField, value: unknown): ValidationResult {
  const fieldType = (field.type ?? 'string').toLowerCase();

  switch (fieldType) {
    case 'string':
    case 'text':
    case 'free_text':
      return { valid: true, normalized: typeof value === 'string' ? value : String(value) };

    case 'number':
    case 'integer':
    case 'float':
    case 'currency': {
      if (typeof value === 'number' && !isNaN(value)) {
        return { valid: true, normalized: value };
      }
      const parsed = Number(value);
      if (!isNaN(parsed)) {
        return { valid: true, normalized: parsed };
      }
      return { valid: false, error: `Expected a number for "${field.name}", got "${value}"` };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { valid: true, normalized: value };
      const str = String(value).toLowerCase().trim();
      if (TRUTHY_VALUES.has(str)) return { valid: true, normalized: true };
      if (FALSY_VALUES.has(str)) return { valid: true, normalized: false };
      return { valid: false, error: `Expected a boolean for "${field.name}", got "${value}"` };
    }

    case 'date':
    case 'datetime': {
      if (typeof value === 'string' && value.length > 0) {
        return { valid: true, normalized: value };
      }
      return { valid: false, error: `Expected a date for "${field.name}", got "${value}"` };
    }

    case 'email': {
      if (typeof value === 'string' && value.includes('@')) {
        return { valid: true, normalized: value };
      }
      return { valid: false, error: `Expected an email for "${field.name}", got "${value}"` };
    }

    case 'phone': {
      if (typeof value === 'string' && value.length >= 7) {
        return { valid: true, normalized: value };
      }
      return { valid: false, error: `Expected a phone number for "${field.name}", got "${value}"` };
    }

    case 'enum': {
      const enumValues = field.enum_values ?? [];
      if (enumValues.length === 0) {
        // No enum values defined — pass through
        return { valid: true, normalized: value };
      }
      const normalized = normalizeEnumValue(String(value), enumValues, field.synonyms);
      if (normalized !== null) {
        return { valid: true, normalized };
      }
      return {
        valid: false,
        error: `Invalid value "${value}" for "${field.name}". Allowed: ${enumValues.join(', ')}`,
      };
    }

    default:
      // Unknown type — pass through without validation
      return { valid: true, normalized: value };
  }
}

/**
 * Apply validation and normalization to a batch of extracted values.
 *
 * Returns { valid, invalid } where valid contains normalized values
 * and invalid contains field names → error messages.
 */
export function validateExtractedBatch(
  fields: ExtractionField[],
  extracted: Record<string, unknown>,
): { valid: Record<string, unknown>; invalid: Record<string, string> } {
  const valid: Record<string, unknown> = {};
  const invalid: Record<string, string> = {};

  for (const [name, value] of Object.entries(extracted)) {
    if (value === undefined || value === null || value === '') continue;

    const field = fields.find((f) => f.name === name);
    if (!field) {
      // Unknown field — store without validation
      valid[name] = value;
      continue;
    }

    // For fields with enum_values but type !== 'enum', still try normalization
    if (field.enum_values && field.enum_values.length > 0 && typeof value === 'string') {
      const normalized = normalizeEnumValue(value, field.enum_values, field.synonyms);
      if (normalized !== null) {
        valid[name] = normalized;
        continue;
      }
    }

    const result = validateExtractedValue(field, value);
    if (result.valid) {
      valid[name] = result.normalized;
    } else {
      invalid[name] = result.error ?? `Invalid value for ${name}`;
    }
  }

  return { valid, invalid };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/runtime/src/__tests__/extraction/extraction-validation.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Build runtime package**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/extraction-validation.ts apps/runtime/src/__tests__/extraction/extraction-validation.test.ts
git add apps/runtime/src/services/execution/extraction-validation.ts apps/runtime/src/__tests__/extraction/extraction-validation.test.ts
git commit -m "[ABLP-XXX] feat(runtime): add shared extraction validation and normalization utilities

Gaps 1, 2, 13, 24: New pure functions validateExtractedValue(),
normalizeEnumValue(), and validateExtractedBatch() extracted from
handleInlineExtraction logic. 4-step enum matching: exact, case-insensitive,
synonym lookup (new), substring (shortest match wins). Used by all
extraction call sites for parity."
```

---

### Task 8: Apply validation to reasoning-executor Call Site #1 (pre-pass)

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:628-660` (pre-pass extraction)

- [ ] **Step 1: Add import for `validateExtractedBatch`**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add to the imports at the top of the file:

```typescript
import { validateExtractedBatch } from './extraction-validation.js';
```

- [ ] **Step 2: Apply validation after pre-pass extraction**

In `reasoning-executor.ts`, the pre-pass extraction (lines 637-647) currently filters only empty values. Replace that block:

```typescript
// Filter out empty/undefined values
const validExtracted: Record<string, unknown> = {};
for (const [key, value] of Object.entries(extracted)) {
  if (value !== undefined && value !== null && value !== '') {
    validExtracted[key] = value;
  }
}
```

With:

```typescript
// Filter out empty/undefined values, then validate and normalize
const nonEmpty: Record<string, unknown> = {};
for (const [key, value] of Object.entries(extracted)) {
  if (value !== undefined && value !== null && value !== '') {
    nonEmpty[key] = value;
  }
}
const { valid: validExtracted, invalid: invalidFields } = validateExtractedBatch(
  allGatherFields,
  nonEmpty,
);
if (Object.keys(invalidFields).length > 0) {
  log.debug('Pre-pass extraction validation rejected fields', {
    agent: session.agentName,
    invalid: invalidFields,
  });
}
```

- [ ] **Step 3: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): add validation and normalization to pre-pass extraction

Gaps 1, 2: Call Site #1 (non-inline pre-pass) now validates extracted
values and normalizes enums via shared validateExtractedBatch(). Invalid
values are rejected instead of being stored in session state."
```

---

### Task 9: Fix Call Site #2 — pass `lookupTables` to `buildExtractionTool`

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1296-1305` (inline tool injection)

- [ ] **Step 1: Pass `lookupTables` to `buildExtractionTool`**

In `reasoning-executor.ts`, at line 1302, replace:

```typescript
const extractionTool = FlowStepExecutor.buildExtractionTool(uncollectedFields);
```

With:

```typescript
const extractionTool = FlowStepExecutor.buildExtractionTool(
  uncollectedFields,
  session.agentIR?.gather?.lookupTables,
);
```

- [ ] **Step 2: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): pass lookupTables to inline buildExtractionTool

Gap 7: The inline gather tool injection now passes session lookup tables
to buildExtractionTool so Tier 1.5 lookup-based extraction works in
inline mode."
```

---

### Task 10: Fix Call Site #3 — refactor `handleInlineExtraction`, add `complete_when` and DELEGATE WHEN vars

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:2337-2547` (handleInlineExtraction)

- [ ] **Step 1: Import `normalizeEnumValue` in reasoning-executor**

The import for `validateExtractedBatch` was already added in Task 8. Add `normalizeEnumValue` too:

```typescript
import { validateExtractedBatch, normalizeEnumValue } from './extraction-validation.js';
```

- [ ] **Step 2: Replace the inline enum normalization with `normalizeEnumValue`**

In `reasoning-executor.ts`, replace the inline enum normalization block (lines 2378-2402):

```typescript
// Normalise to declared GATHER enum_values when present.
// The LLM may extract "MacBook Pro" when the options are
// ["iPhone","iPad","Mac","Apple Watch","AirPods"]. Try exact,
// case-insensitive, then substring matching to resolve.
let finalValue = value;
const enumVals = field.enum_values;
if (enumVals && enumVals.length > 0 && typeof value === 'string') {
  const exact = enumVals.find((o: string) => o === value);
  if (!exact) {
    const lower = value.toLowerCase();
    const ciMatch = enumVals.find((o: string) => o.toLowerCase() === lower);
    if (ciMatch) {
      finalValue = ciMatch;
    } else {
      // Substring: "MacBook Pro" contains "Mac", "AirPods Pro" contains "AirPods"
      const contained = enumVals.find(
        (o: string) => lower.includes(o.toLowerCase()) || o.toLowerCase().includes(lower),
      );
      if (contained) {
        finalValue = contained;
      }
      // No match — store as-is; the constraint will catch it if needed
    }
  }
}

valid[name] = finalValue;
```

With:

```typescript
// Normalise to declared GATHER enum_values when present.
let finalValue = value;
const enumVals = field.enum_values;
if (enumVals && enumVals.length > 0 && typeof value === 'string') {
  const normalized = normalizeEnumValue(value, enumVals, field.synonyms);
  if (normalized !== null) {
    finalValue = normalized;
  }
  // No match — store as-is; the constraint will catch it if needed
}

valid[name] = finalValue;
```

- [ ] **Step 3: Note on `complete_when` (Gap 8)**

Gap 8 (`complete_when` never passed in inline path) applies to reasoning agents, but `complete_when` only exists on `FlowStep` in the IR, not on `GatherConfig`. Adding it to `GatherConfig` requires parser + compiler changes for top-level GATHER blocks, which is out of scope for this task. The `undefined` third arg to `checkGatherComplete` is correct for reasoning agents that don't define `complete_when`. This gap is deferred until `complete_when` is supported on top-level GATHER.

- [ ] **Step 4: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): refactor handleInlineExtraction to use shared normalizer

Gap 13: Enum normalization uses shared normalizeEnumValue with 4-step
matching including synonym lookup and shortest-substring preference.
Gap 8 deferred: complete_when not yet on GatherConfig IR for reasoning agents."
```

---

### Task 11: Fix Call Site #4 — filter uncollected fields, add validation

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:2040-2080` (inline fallback)

- [ ] **Step 1: Filter to uncollected fields and add validation**

In `reasoning-executor.ts`, replace the fallback extraction block (lines 2040-2073):

```typescript
        const lastUserMsg = getLatestUserText(session);
        if (lastUserMsg && !shouldSkipExtraction(lastUserMsg)) {
          try {
            const allFieldNames = (gatherFields as GatherField[]).map((f) => f.name);
            const extracted = await this.flowStep.extractEntitiesWithLLM(
              lastUserMsg,
              allFieldNames,
              session,
              onTraceEvent,
              gatherFields as GatherField[],
            );

            const validExtracted: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(extracted)) {
              if (value !== undefined && value !== null && value !== '') {
                validExtracted[key] = value;
              }
            }

            if (Object.keys(validExtracted).length > 0) {
              setGatheredValues(session, validExtracted);
              if (onTraceEvent) {
                onTraceEvent({
                  type: 'dsl_collect',
                  data: {
                    agentName: session.agentName,
                    mode: 'inline_gather_fallback',
                    fields: allFieldNames,
                    userInput: lastUserMsg,
                    extracted: validExtracted,
                  },
                });
              }
            }
```

With:

```typescript
        const lastUserMsg = getLatestUserText(session);
        if (lastUserMsg && !shouldSkipExtraction(lastUserMsg)) {
          try {
            // Only extract uncollected fields — avoid overwriting already-gathered values
            const uncollectedFields = (gatherFields as GatherField[]).filter((f) => {
              const val = session.data.values[f.name];
              return val === undefined || val === null || val === '';
            });
            const uncollectedNames = uncollectedFields.map((f) => f.name);
            if (uncollectedNames.length === 0) {
              // All fields already collected — skip fallback
            } else {
              const extracted = await this.flowStep.extractEntitiesWithLLM(
                lastUserMsg,
                uncollectedNames,
                session,
                onTraceEvent,
                uncollectedFields,
              );

              // Filter empty values, then validate and normalize
              const nonEmpty: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(extracted)) {
                if (value !== undefined && value !== null && value !== '') {
                  nonEmpty[key] = value;
                }
              }
              const { valid: validExtracted, invalid: invalidFields } =
                validateExtractedBatch(uncollectedFields, nonEmpty);
              if (Object.keys(invalidFields).length > 0) {
                log.debug('Inline fallback validation rejected fields', {
                  agent: session.agentName,
                  invalid: invalidFields,
                });
              }

              if (Object.keys(validExtracted).length > 0) {
                setGatheredValues(session, validExtracted);
                if (onTraceEvent) {
                  onTraceEvent({
                    type: 'dsl_collect',
                    data: {
                      agentName: session.agentName,
                      mode: 'inline_gather_fallback',
                      fields: uncollectedNames,
                      userInput: lastUserMsg,
                      extracted: validExtracted,
                    },
                  });
                }
              }
            }
```

- [ ] **Step 2: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): filter uncollected fields and validate in inline fallback

Gaps 3, 4: Call Site #4 (inline fallback) now filters to uncollected
fields only (preventing overwrites of already-gathered values) and
validates/normalizes extracted values via validateExtractedBatch."
```

---

### Task 12: Apply validation to flow-step-executor Call Sites #5-8

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:1146-1156` (mini-collect)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:3828-3838` (correction)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:3895-3910` (waitingForInput)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:4518-4528` (scripted gather)

- [ ] **Step 1: Add import for `validateExtractedBatch`**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, add to the imports:

```typescript
import { validateExtractedBatch } from './extraction-validation.js';
```

- [ ] **Step 2: Add validation to Call Site #5 (mini-collect)**

In `flow-step-executor.ts`, after the extraction at line 1146-1151, replace:

```typescript
// Merge extracted values into session
if (Object.keys(extracted).length > 0) {
  setGatheredValues(session, extracted);
}
```

With:

```typescript
// Validate, normalize, and merge extracted values into session
if (Object.keys(extracted).length > 0) {
  const gatherFields = session.agentIR?.gather?.fields ?? [];
  const { valid: validated } = validateExtractedBatch(gatherFields, extracted);
  if (Object.keys(validated).length > 0) {
    setGatheredValues(session, validated);
  }
}
```

- [ ] **Step 3: Add validation to Call Site #6 (correction)**

In `flow-step-executor.ts`, after the extraction at line 3830-3838, replace:

```typescript
const extracted = await this.extractEntitiesWithLLM(
  correctionNewValue,
  [correctionField],
  session,
  onTraceEvent,
  step.gather?.fields,
  step.gather?.strategy,
);
setGatheredValues(session, extracted);
```

With:

```typescript
const extracted = await this.extractEntitiesWithLLM(
  correctionNewValue,
  [correctionField],
  session,
  onTraceEvent,
  step.gather?.fields,
  step.gather?.strategy,
);
const correctionFields = step.gather?.fields ?? [];
const { valid: validatedCorrection } = validateExtractedBatch(correctionFields, extracted);
setGatheredValues(session, validatedCorrection);
```

- [ ] **Step 4: Add validation to Call Site #7 (waitingForInput)**

In `flow-step-executor.ts`, after the extraction at line 3897-3904, find where `extractedData` is used. The existing code already filters empty values (lines 3907-3910). After the filter, add validation. Find:

```typescript
        const collectedFields = Object.keys(extractedData).filter(
          (k) =>
            extractedData[k] !== undefined && extractedData[k] !== null && extractedData[k] !== '',
```

Before that filter, add validation:

```typescript
// Validate and normalize extracted values
const waitingFields = step.gather?.fields ?? [];
const { valid: validatedWaiting, invalid: invalidWaiting } = validateExtractedBatch(
  waitingFields,
  extractedData,
);
if (Object.keys(invalidWaiting).length > 0) {
  log.debug('WaitingForInput validation rejected fields', {
    agent: session.agentName,
    invalid: invalidWaiting,
  });
}
// Use validated values for the rest of the flow
const extractedValidated = validatedWaiting;
```

Then update the subsequent code to use `extractedValidated` instead of `extractedData` for the field filtering and `setGatheredValues` calls.

- [ ] **Step 5: Add validation to Call Site #8 (scripted gather)**

In `flow-step-executor.ts`, after the extraction at line 4518-4525, replace:

```typescript
const extractedData = await this.extractEntitiesWithLLM(
  currentMessage,
  fieldsToExtract,
  session,
  onTraceEvent,
  step.gather.fields,
  step.gather.strategy,
);

// Merge extracted data
setGatheredValues(session, extractedData);
```

With:

```typescript
const rawExtracted = await this.extractEntitiesWithLLM(
  currentMessage,
  fieldsToExtract,
  session,
  onTraceEvent,
  step.gather.fields,
  step.gather.strategy,
);

// Validate and normalize, then merge
const { valid: extractedData } = validateExtractedBatch(step.gather.fields, rawExtracted);
setGatheredValues(session, extractedData);
```

- [ ] **Step 6: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): add validation to flow-step-executor call sites 5-8

Gaps 1, 2: All 4 scripted/flow extraction paths (mini-collect, correction,
waitingForInput, scripted gather) now validate and normalize extracted
values via shared validateExtractedBatch before writing to session state."
```

---

### Task 13: Fix tier merge order and pass `fieldTypes` to fallback

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:2138` (tier merge)
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (fallback extractEntitiesForFields calls)

- [ ] **Step 1: Fix tier merge order**

In `flow-step-executor.ts` at line 2138, replace:

```typescript
const preLLMResults: Record<string, unknown> = { ...tier1Results, ...tier2Results };
```

With:

```typescript
// Tier 1 (JS libs) produces higher-quality results for supported types
// (E.164 phone numbers, ISO dates). Tier 1 takes priority over Tier 2.
const preLLMResults: Record<string, unknown> = { ...tier2Results, ...tier1Results };
```

- [ ] **Step 2: Build `fieldTypes` map and pass to `extractEntitiesForFields` calls**

Search for all `extractEntitiesForFields` calls in `flow-step-executor.ts`. There are calls in the fallback paths. For each one, ensure the `fieldTypes` map is passed.

Find all calls to `extractEntitiesForFields` in the file:

```bash
grep -n 'extractEntitiesForFields' apps/runtime/src/services/execution/flow-step-executor.ts
```

For each call that doesn't pass `fieldTypes`, build and pass the map. The pattern:

```typescript
const fieldTypes = (gatherFields ?? []).reduce(
  (acc: Record<string, string>, f: { name: string; type?: string }) => {
    acc[f.name] = f.type ?? '';
    return acc;
  },
  {} as Record<string, string>,
);
```

Then pass it as the third argument to `extractEntitiesForFields(message, fields, fieldTypes)`.

- [ ] **Step 3: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): fix tier merge order and pass fieldTypes to fallback extraction

Gap 28: Tier 1 JS lib results now take priority over Tier 2 sidecar results
in the pre-LLM merge, preventing lower-quality sidecar output from
overwriting deterministic E.164/ISO extractions.
Gap 26: All extractEntitiesForFields fallback calls now receive the
fieldTypes map so regex extraction can use type-aware strategies."
```

---

### Task 14: Add DELEGATE WHEN variables to inline path

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1295-1305` (inline tool injection)

- [ ] **Step 1: Include DELEGATE WHEN variables in inline extraction scope**

In `reasoning-executor.ts`, expand the inline tool injection block (lines 1295-1305) to include DELEGATE WHEN variables alongside GATHER fields:

Replace:

```typescript
if (inlineGather && gatherFields && gatherFields.length > 0) {
  const uncollectedFields = (gatherFields as GatherField[]).filter((f) => {
    const val = session.data.values[f.name];
    return val === undefined || val === null || val === '';
  });

  if (uncollectedFields.length > 0) {
    const extractionTool = FlowStepExecutor.buildExtractionTool(
      uncollectedFields,
      session.agentIR?.gather?.lookupTables,
    );
    // Prepend so LLM sees it first in tool list
    tools = [extractionTool, ...tools];
  }
}
```

With:

```typescript
if (inlineGather && gatherFields && gatherFields.length > 0) {
  const uncollectedFields = (gatherFields as GatherField[]).filter((f) => {
    const val = session.data.values[f.name];
    return val === undefined || val === null || val === '';
  });

  // Include DELEGATE WHEN variables in inline extraction scope (Gap 12)
  const delegateWhenVars = getDelegateWhenVariables(session.agentIR);
  const supplementaryFields = delegateWhenVars.filter(
    (v) => !uncollectedFields.some((f) => f.name === v) && !(v in (session.data.values ?? {})),
  );
  const allInlineFields = [
    ...uncollectedFields,
    ...supplementaryFields.map((name) => {
      const hints = getDelegateFieldHints(session.agentIR, name);
      return {
        name,
        type: 'string',
        extraction_hints: hints.length > 0 ? hints : undefined,
      } as GatherField;
    }),
  ];

  if (allInlineFields.length > 0) {
    const extractionTool = FlowStepExecutor.buildExtractionTool(
      allInlineFields,
      session.agentIR?.gather?.lookupTables,
    );
    // Prepend so LLM sees it first in tool list
    tools = [extractionTool, ...tools];
  }
}
```

- [ ] **Step 2: Verify `getDelegateWhenVariables` and `getDelegateFieldHints` are already imported**

Check that the imports exist at the top of `reasoning-executor.ts`. They should already be imported since Call Site #1 uses them (lines 611, 619).

- [ ] **Step 3: Build runtime**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Success

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-XXX] fix(runtime): include DELEGATE WHEN variables in inline extraction scope

Gap 12: The inline gather path now includes DELEGATE WHEN variable
references in the extraction tool, matching the non-inline pre-pass
behavior. Delegation guards that reference non-GATHER variables will
now evaluate correctly in inline mode."
```

---

### Task 15: Run full build and test suite

**Files:** None (verification only)

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: Success across all packages

- [ ] **Step 2: Run test report**

Run: `pnpm test:report`
Expected: Review `test-reports/SUMMARY.md` for any failures related to the changes.

- [ ] **Step 3: Run prettier on all changed files**

```bash
npx prettier --write \
  packages/compiler/src/platform/ir/schema.ts \
  packages/compiler/src/platform/ir/compiler.ts \
  packages/core/src/types/agent-based.ts \
  packages/core/src/parser/agent-based-parser.ts \
  apps/runtime/src/services/execution/extraction-validation.ts \
  apps/runtime/src/services/execution/reasoning-executor.ts \
  apps/runtime/src/services/execution/flow-step-executor.ts \
  apps/runtime/src/__tests__/extraction/extraction-validation.test.ts
```

- [ ] **Step 4: Fix any test failures**

If tests fail, check `test-reports/SUMMARY.md` and fix. The most likely failures:

- Existing tests that depend on unvalidated extraction behavior (values that would now be rejected)
- Type errors from the new `synonyms` field on GatherField if existing test fixtures don't include it
- Import resolution for the new `extraction-validation.ts` module

---

## Summary

| Task | Workstream | Gaps Fixed          | Package                      |
| ---- | ---------- | ------------------- | ---------------------------- |
| 1    | WS2        | 9, 30               | compiler (schema)            |
| 2    | WS2        | 31                  | core (AST + parser)          |
| 3    | WS2        | 5                   | core (parser)                |
| 4    | WS2        | 5, 6                | compiler                     |
| 5    | WS2        | 9, 31               | compiler                     |
| 6    | WS2        | 30                  | compiler (merge logic)       |
| 7    | WS1        | 1, 2, 13, 24        | runtime (new utility)        |
| 8    | WS1        | 1, 2                | runtime (reasoning-executor) |
| 9    | WS1        | 7                   | runtime (reasoning-executor) |
| 10   | WS1        | 13 (Gap 8 deferred) | runtime (reasoning-executor) |
| 11   | WS1        | 3, 4                | runtime (reasoning-executor) |
| 12   | WS1        | 1, 2                | runtime (flow-step-executor) |
| 13   | WS1        | 26, 28              | runtime (flow-step-executor) |
| 14   | WS1        | 12                  | runtime (reasoning-executor) |
| 15   | —          | all                 | verification                 |
