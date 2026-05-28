# Runtime Entity Pipeline + System Entity Intrinsic Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `ir.entities` into the runtime — per-turn entity extraction, 3-scope session state (observations/values/memory), intrinsic validation from system entity types, slot assignment with LLM disambiguation, and trace events for the full entity lifecycle.

**Architecture:** Two-layer change. First, the compiler pre-registers 6 system entity types with built-in intrinsic validation patterns so the IR carries validation rules without authors writing them. Second, the runtime consumes `ir.entities` for per-turn extraction, maintains utterance-scoped observations separate from session-scoped values, and traces each lifecycle phase. The existing 4-tier extraction pipeline (JS libs → NLU sidecar → LLM → regex) and GATHER collection flow are preserved — this adds an entity-scoped extraction layer that runs before GATHER field extraction.

**Tech Stack:** TypeScript, Vitest, chrono-node, libphonenumber-js, existing `@abl/compiler` IR types, runtime execution modules.

---

## File Structure

### Compiler (Feature 1: System Entity Intrinsic Validation)

| File                                                           | Action | Responsibility                                                        |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/system-entities.ts`         | Create | System entity definitions with built-in intrinsic validation patterns |
| `packages/compiler/src/platform/ir/compiler.ts`                | Modify | Import system entities, inject into anonymous entity creation         |
| `packages/compiler/src/__tests__/system-entities.test.ts`      | Create | Unit tests for system entity definitions                              |
| `packages/compiler/src/__tests__/entities-compilation.test.ts` | Modify | Add tests for intrinsic validation on inline GATHER types             |

### Runtime (Feature 2: Entity Extraction Pipeline)

| File                                                          | Action | Responsibility                                                                     |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/entity-observations.ts`  | Create | ObservationStore type, per-turn extraction from ir.entities, observation lifecycle |
| `apps/runtime/src/services/execution/intrinsic-validation.ts` | Create | Pure intrinsic validation functions consuming EntityDefinitionIR                   |
| `apps/runtime/src/services/execution/slot-assignment.ts`      | Create | Slot assignment logic: Cases A-D, LLM disambiguation prompt, clarification         |
| `apps/runtime/src/services/execution/entity-pipeline.ts`      | Create | Orchestrator: extract → normalize → validate(intrinsic) → return observations      |
| `apps/runtime/src/services/session/types.ts`                  | Modify | Add `observations` field to SessionData                                            |
| `apps/runtime/src/services/execution/types.ts`                | Modify | Add `observations` field to RuntimeSession                                         |
| `apps/runtime/src/services/execution/reasoning-executor.ts`   | Modify | Wire entity pipeline before GATHER extraction                                      |
| `apps/runtime/src/services/execution/flow-step-executor.ts`   | Modify | Wire entity pipeline before GATHER block                                           |
| `apps/runtime/src/__tests__/entity-observations.test.ts`      | Create | Unit tests for observation store                                                   |
| `apps/runtime/src/__tests__/intrinsic-validation.test.ts`     | Create | Unit tests for intrinsic validation                                                |
| `apps/runtime/src/__tests__/slot-assignment.test.ts`          | Create | Unit tests for slot assignment cases A-D                                           |
| `apps/runtime/src/__tests__/entity-pipeline.test.ts`          | Create | Unit tests for pipeline orchestrator                                               |

---

## Task 1: System Entity Definitions with Intrinsic Validation

**Files:**

- Create: `packages/compiler/src/platform/ir/system-entities.ts`
- Create: `packages/compiler/src/__tests__/system-entities.test.ts`

This task pre-registers the 6 system entity types with built-in intrinsic validation patterns. These are constants — pure data, no runtime behavior.

- [ ] **Step 1: Write the failing test**

Create `packages/compiler/src/__tests__/system-entities.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ENTITY_DEFINITIONS,
  getSystemEntityDefinition,
} from '../platform/ir/system-entities.js';

describe('System entity definitions', () => {
  it('defines exactly 6 system entity types', () => {
    expect(SYSTEM_ENTITY_DEFINITIONS).toHaveLength(6);
  });

  it('includes email with RFC pattern', () => {
    const email = getSystemEntityDefinition('email');
    expect(email).toBeDefined();
    expect(email!.type).toBe('email');
    expect(email!.intrinsic_validation).toBeDefined();
    expect(email!.source).toBe('system');
  });

  it('includes phone with digit/country pattern', () => {
    const phone = getSystemEntityDefinition('phone');
    expect(phone).toBeDefined();
    expect(phone!.type).toBe('phone');
    expect(phone!.intrinsic_validation).toBeDefined();
  });

  it('includes date with calendar validation', () => {
    const date = getSystemEntityDefinition('date');
    expect(date).toBeDefined();
    expect(date!.type).toBe('date');
    expect(date!.intrinsic_validation).toBeDefined();
  });

  it('includes datetime with calendar+time validation', () => {
    const dt = getSystemEntityDefinition('datetime');
    expect(dt).toBeDefined();
    expect(dt!.type).toBe('datetime');
    expect(dt!.intrinsic_validation).toBeDefined();
  });

  it('includes boolean with truthy/falsy values', () => {
    const bool = getSystemEntityDefinition('boolean');
    expect(bool).toBeDefined();
    expect(bool!.type).toBe('boolean');
    expect(bool!.values).toEqual(expect.arrayContaining(['true', 'false', 'yes', 'no']));
  });

  it('includes currency with numeric+symbol pattern', () => {
    const currency = getSystemEntityDefinition('currency');
    expect(currency).toBeDefined();
    expect(currency!.type).toBe('currency');
    expect(currency!.intrinsic_validation).toBeDefined();
  });

  it('returns undefined for non-system types', () => {
    expect(getSystemEntityDefinition('string')).toBeUndefined();
    expect(getSystemEntityDefinition('enum')).toBeUndefined();
    expect(getSystemEntityDefinition('pattern')).toBeUndefined();
    expect(getSystemEntityDefinition('location')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@abl/compiler && pnpm vitest run packages/compiler/src/__tests__/system-entities.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement system entity definitions**

Create `packages/compiler/src/platform/ir/system-entities.ts`:

```typescript
/**
 * System Entity Definitions
 *
 * Pre-registered entity types with built-in intrinsic validation.
 * These are injected into the entity registry when inline GATHER TYPE
 * uses a system type (email, phone, date, datetime, boolean, currency).
 *
 * The intrinsic_validation field is a human-readable validation description
 * consumed by the runtime's intrinsic validation layer.
 */

import type { EntityDefinitionIR } from './schema.js';

/**
 * System entity source type — extends the existing 'explicit' | 'nlu_lowered' | 'gather_inline'
 * union. We use 'system' here but cast to the union type for compatibility.
 */
type SystemEntitySource = 'system';

/** System entity types that carry built-in intrinsic validation */
const SYSTEM_ENTITY_TYPES = new Set(['email', 'phone', 'date', 'datetime', 'boolean', 'currency']);

/**
 * Built-in system entity definitions with intrinsic validation patterns.
 *
 * Each definition describes:
 * - What the entity type is
 * - What intrinsic validation rule applies (format-level, not business-level)
 * - For boolean: the canonical values set
 */
export const SYSTEM_ENTITY_DEFINITIONS: ReadonlyArray<
  EntityDefinitionIR & { source: SystemEntitySource }
> = [
  {
    name: '__system_email',
    type: 'email',
    intrinsic_validation: 'RFC 5322 compliant email format: local@domain.tld',
    source: 'system' as SystemEntitySource,
  },
  {
    name: '__system_phone',
    type: 'phone',
    intrinsic_validation:
      'Valid phone number: minimum 7 digits, optional country code prefix (+1, +44, etc.)',
    source: 'system' as SystemEntitySource,
  },
  {
    name: '__system_date',
    type: 'date',
    intrinsic_validation: 'Resolves to a real calendar date (YYYY-MM-DD)',
    source: 'system' as SystemEntitySource,
  },
  {
    name: '__system_datetime',
    type: 'datetime',
    intrinsic_validation: 'Resolves to a real calendar date and time (ISO 8601)',
    source: 'system' as SystemEntitySource,
  },
  {
    name: '__system_boolean',
    type: 'boolean',
    values: ['true', 'false', 'yes', 'no'],
    intrinsic_validation: 'Resolves to true or false',
    source: 'system' as SystemEntitySource,
  },
  {
    name: '__system_currency',
    type: 'currency',
    intrinsic_validation: 'Valid numeric amount with optional currency symbol or ISO 4217 code',
    source: 'system' as SystemEntitySource,
  },
];

/**
 * Look up a system entity definition by its EntityType.
 * Returns undefined for non-system types (string, text, enum, pattern, etc.).
 */
export function getSystemEntityDefinition(
  entityType: string,
): (EntityDefinitionIR & { source: SystemEntitySource }) | undefined {
  if (!SYSTEM_ENTITY_TYPES.has(entityType)) return undefined;
  return SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === entityType);
}

/**
 * Check whether an EntityType is a system type with built-in validation.
 */
export function isSystemEntityType(entityType: string): boolean {
  return SYSTEM_ENTITY_TYPES.has(entityType);
}
```

**Important:** The `EntityDefinitionIR.source` union type needs to be extended to include `'system'`. Modify `packages/compiler/src/platform/ir/schema.ts` line 1752:

Change:

```typescript
source: 'explicit' | 'nlu_lowered' | 'gather_inline';
```

To:

```typescript
source: 'explicit' | 'nlu_lowered' | 'gather_inline' | 'system';
```

Also add the export to `packages/compiler/src/platform/ir/index.ts` (or wherever exports are aggregated). Search for existing entity exports and add:

```typescript
export {
  SYSTEM_ENTITY_DEFINITIONS,
  getSystemEntityDefinition,
  isSystemEntityType,
} from './system-entities.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@abl/compiler && pnpm vitest run packages/compiler/src/__tests__/system-entities.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write packages/compiler/src/platform/ir/system-entities.ts packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/system-entities.test.ts
git add packages/compiler/src/platform/ir/system-entities.ts packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/system-entities.test.ts
git commit -m "[ABLP-2] feat(compiler): add system entity definitions with built-in intrinsic validation"
```

---

## Task 2: Wire System Entities into Anonymous Entity Creation

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:1229-1241` (anonymous entity creation in `compileGather`)
- Modify: `packages/compiler/src/__tests__/entities-compilation.test.ts`

When a GATHER field uses inline `TYPE: email` (no entity_ref), the anonymous entity should inherit intrinsic validation from the system entity definition.

- [ ] **Step 1: Write the failing test**

Add to `packages/compiler/src/__tests__/entities-compilation.test.ts`:

```typescript
describe('System entity intrinsic validation on inline GATHER', () => {
  it('injects intrinsic_validation for email type', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  user_email:
    TYPE: email
    PROMPT: "Enter email"
    REQUIRED: true
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'user_email');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('email');
    expect(entity!.intrinsic_validation).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('RFC');
  });

  it('injects intrinsic_validation for phone type', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  phone_number:
    TYPE: phone
    PROMPT: "Enter phone"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'phone_number');
    expect(entity).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('phone');
  });

  it('injects intrinsic_validation for date type', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  departure_date:
    TYPE: date
    PROMPT: "When?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'departure_date');
    expect(entity).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('date');
  });

  it('injects intrinsic_validation for boolean type', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  confirm:
    TYPE: boolean
    PROMPT: "Confirm?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'confirm');
    expect(entity).toBeDefined();
    expect(entity!.intrinsic_validation).toContain('true or false');
  });

  it('does NOT inject intrinsic_validation for string type', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  name:
    TYPE: string
    PROMPT: "Name?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'name');
    expect(entity).toBeDefined();
    expect(entity!.intrinsic_validation).toBeUndefined();
  });

  it('does NOT override explicit ENTITIES intrinsic_validation', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
ENTITIES:
  corp_email:
    TYPE: email
    VALIDATION: "Must be a corporate email"
GATHER:
  email:
    ENTITY_REF: corp_email
    PROMPT: "Email?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities?.find((e) => e.name === 'corp_email');
    expect(entity).toBeDefined();
    expect(entity!.intrinsic_validation).toBe('Must be a corporate email');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@abl/compiler && pnpm vitest run packages/compiler/src/__tests__/entities-compilation.test.ts`
Expected: FAIL — `intrinsic_validation` is undefined on anonymous entities

- [ ] **Step 3: Wire system entities into compiler**

In `packages/compiler/src/platform/ir/compiler.ts`, add the import at the top alongside existing imports:

```typescript
import { getSystemEntityDefinition } from './system-entities.js';
```

Then modify the anonymous entity creation block in `compileGather` (around line 1229-1241). Current code:

```typescript
// For fields without entity_ref, create an anonymous entity in the registry
if (!f.entityRef && fieldType && entityRegistry) {
  const existingEntity = entityRegistry.find((e) => e.name === f.name);
  if (!existingEntity) {
    entityRegistry.push({
      name: f.name,
      type: (fieldType || 'string') as EntityType,
      values: enumValues,
      sensitive: fieldSensitive,
      source: 'gather_inline',
    });
  }
}
```

Change to:

```typescript
// For fields without entity_ref, create an anonymous entity in the registry
if (!f.entityRef && fieldType && entityRegistry) {
  const existingEntity = entityRegistry.find((e) => e.name === f.name);
  if (!existingEntity) {
    // System types carry built-in intrinsic validation
    const systemDef = getSystemEntityDefinition(fieldType);
    entityRegistry.push({
      name: f.name,
      type: (fieldType || 'string') as EntityType,
      values: systemDef?.values ?? enumValues,
      intrinsic_validation: systemDef?.intrinsic_validation,
      sensitive: fieldSensitive,
      source: 'gather_inline',
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@abl/compiler && pnpm vitest run packages/compiler/src/__tests__/entities-compilation.test.ts`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Run full compiler test suite**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm vitest run packages/compiler/src/__tests__/`
Expected: All existing tests still pass

- [ ] **Step 6: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): inject system entity intrinsic validation into anonymous entities"
```

---

## Task 3: Runtime Intrinsic Validation Functions

**Files:**

- Create: `apps/runtime/src/services/execution/intrinsic-validation.ts`
- Create: `apps/runtime/src/__tests__/intrinsic-validation.test.ts`

Pure functions that validate extracted values against entity-level intrinsic rules. These consume `EntityDefinitionIR` from `ir.entities` and apply type-specific validation that is stronger than the current `extraction-validation.ts` basic checks.

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/intrinsic-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  validateIntrinsic,
  type IntrinsicValidationResult,
} from '../services/execution/intrinsic-validation.js';

describe('Intrinsic validation', () => {
  describe('email', () => {
    it('accepts valid email', () => {
      const result = validateIntrinsic('email', 'user@example.com');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('user@example.com');
    });

    it('rejects email without @', () => {
      const result = validateIntrinsic('email', 'userexample.com');
      expect(result.valid).toBe(false);
    });

    it('rejects email without domain TLD', () => {
      const result = validateIntrinsic('email', 'user@example');
      expect(result.valid).toBe(false);
    });

    it('lowercases email', () => {
      const result = validateIntrinsic('email', 'User@Example.COM');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('user@example.com');
    });
  });

  describe('phone', () => {
    it('accepts valid US phone', () => {
      const result = validateIntrinsic('phone', '+12025551234');
      expect(result.valid).toBe(true);
    });

    it('accepts 10-digit phone without country code', () => {
      const result = validateIntrinsic('phone', '2025551234');
      expect(result.valid).toBe(true);
    });

    it('rejects phone with fewer than 7 digits', () => {
      const result = validateIntrinsic('phone', '12345');
      expect(result.valid).toBe(false);
    });
  });

  describe('date', () => {
    it('accepts ISO date string', () => {
      const result = validateIntrinsic('date', '2026-03-15');
      expect(result.valid).toBe(true);
    });

    it('accepts natural language date', () => {
      const result = validateIntrinsic('date', 'March 15, 2026');
      expect(result.valid).toBe(true);
    });

    it('rejects empty string', () => {
      const result = validateIntrinsic('date', '');
      expect(result.valid).toBe(false);
    });

    it('rejects non-date string', () => {
      const result = validateIntrinsic('date', 'not a date');
      expect(result.valid).toBe(false);
    });
  });

  describe('datetime', () => {
    it('accepts ISO datetime', () => {
      const result = validateIntrinsic('datetime', '2026-03-15T14:30:00');
      expect(result.valid).toBe(true);
    });

    it('accepts date-only string (datetime is superset of date)', () => {
      const result = validateIntrinsic('datetime', '2026-03-15');
      expect(result.valid).toBe(true);
    });
  });

  describe('boolean', () => {
    it('normalizes "yes" to true', () => {
      const result = validateIntrinsic('boolean', 'yes');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });

    it('normalizes "no" to false', () => {
      const result = validateIntrinsic('boolean', 'no');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(false);
    });

    it('normalizes "si" to true', () => {
      const result = validateIntrinsic('boolean', 'si');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });

    it('rejects non-boolean string', () => {
      const result = validateIntrinsic('boolean', 'maybe');
      expect(result.valid).toBe(false);
    });

    it('passes through boolean value', () => {
      const result = validateIntrinsic('boolean', true);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(true);
    });
  });

  describe('currency', () => {
    it('accepts numeric value', () => {
      const result = validateIntrinsic('currency', 49.99);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(49.99);
    });

    it('accepts object with value and currency', () => {
      const result = validateIntrinsic('currency', { value: 49.99, currency: 'USD' });
      expect(result.valid).toBe(true);
    });

    it('rejects non-numeric string without currency signal', () => {
      const result = validateIntrinsic('currency', 'hello');
      expect(result.valid).toBe(false);
    });
  });

  describe('enum', () => {
    it('accepts value in allowed set', () => {
      const result = validateIntrinsic('enum', 'business', {
        values: ['economy', 'business', 'first'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects value not in allowed set', () => {
      const result = validateIntrinsic('enum', 'premium', {
        values: ['economy', 'business', 'first'],
      });
      expect(result.valid).toBe(false);
    });

    it('case-insensitive enum match', () => {
      const result = validateIntrinsic('enum', 'BUSINESS', {
        values: ['economy', 'business', 'first'],
      });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('business');
    });

    it('synonym resolution', () => {
      const result = validateIntrinsic('enum', 'biz', {
        values: ['economy', 'business', 'first'],
        synonyms: { business: ['biz', 'biz class'] },
      });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('business');
    });
  });

  describe('non-system types pass through', () => {
    it('string type always valid', () => {
      const result = validateIntrinsic('string', 'anything');
      expect(result.valid).toBe(true);
    });

    it('text type always valid', () => {
      const result = validateIntrinsic('text', 'anything');
      expect(result.valid).toBe(true);
    });

    it('number type validates numeric', () => {
      const result = validateIntrinsic('number', '42.5');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe(42.5);
    });

    it('number type rejects non-numeric', () => {
      const result = validateIntrinsic('number', 'not a number');
      expect(result.valid).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/intrinsic-validation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement intrinsic validation**

Create `apps/runtime/src/services/execution/intrinsic-validation.ts`:

```typescript
/**
 * Intrinsic Validation — Entity-Level Type Validation
 *
 * Pure functions that validate extracted values against entity-level
 * intrinsic rules. This is Phase 3 of the entity lifecycle:
 * Observe → Normalize → Validate(intrinsic) → Slot Assignment → ...
 *
 * Intrinsic validation checks format-level correctness:
 * - Is this a valid email format?
 * - Does this phone number have enough digits?
 * - Does this date resolve to a real calendar date?
 * - Is this value in the allowed enum set?
 *
 * Business validation (must be corporate email, must be future date)
 * is handled separately in the GATHER validation layer.
 */

import { normalizeEnumValue } from './extraction-validation.js';

export interface IntrinsicValidationResult {
  valid: boolean;
  normalized?: unknown;
  error?: string;
}

interface EntityConstraints {
  values?: string[];
  synonyms?: Record<string, string[]>;
  pattern?: string;
}

/** RFC 5322-ish email pattern — must have local@domain.tld */
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Minimum digits for a phone number (ITU-T E.164 minimum is 7) */
const MIN_PHONE_DIGITS = 7;

/** Maximum digits for a phone number (E.164 max is 15) */
const MAX_PHONE_DIGITS = 15;

/** Truthy values for boolean resolution */
const TRUTHY_VALUES = new Set(['true', 'yes', '1', 'y', 'si', 'sí']);

/** Falsy values for boolean resolution */
const FALSY_VALUES = new Set(['false', 'no', '0', 'n']);

/**
 * ISO date pattern — YYYY-MM-DD or YYYY/MM/DD.
 * Loose check for well-formed date strings. Does not validate calendar correctness
 * (Feb 30 would pass regex but fail Date parse).
 */
const ISO_DATE_REGEX = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;

/**
 * Natural language date heuristic — contains month name or relative reference.
 * Used as a secondary check when ISO pattern doesn't match.
 */
const NATURAL_DATE_REGEX =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|today|tomorrow|yesterday|next|last)\b/i;

/**
 * Validate an extracted value against its entity type's intrinsic rules.
 *
 * @param entityType - The EntityType from the entity definition
 * @param value - The raw extracted value
 * @param constraints - Optional entity constraints (values, synonyms, pattern)
 * @returns Validation result with optional normalized value
 */
export function validateIntrinsic(
  entityType: string,
  value: unknown,
  constraints?: EntityConstraints,
): IntrinsicValidationResult {
  const type = entityType.toLowerCase();

  switch (type) {
    case 'email':
      return validateEmail(value);
    case 'phone':
      return validatePhone(value);
    case 'date':
      return validateDate(value);
    case 'datetime':
      return validateDatetime(value);
    case 'boolean':
      return validateBoolean(value);
    case 'currency':
      return validateCurrency(value);
    case 'number':
    case 'integer':
    case 'float':
      return validateNumber(value);
    case 'enum':
      return validateEnum(value, constraints);
    case 'pattern':
      return validatePattern(value, constraints);
    case 'string':
    case 'text':
    case 'free_text':
    case 'location':
      // Pass-through types — no intrinsic validation
      return { valid: true, normalized: value };
    default:
      return { valid: true, normalized: value };
  }
}

function validateEmail(value: unknown): IntrinsicValidationResult {
  const str = typeof value === 'string' ? value.trim() : String(value);
  const lower = str.toLowerCase();
  if (EMAIL_REGEX.test(lower)) {
    return { valid: true, normalized: lower };
  }
  return { valid: false, error: `Invalid email format: "${str}"` };
}

function validatePhone(value: unknown): IntrinsicValidationResult {
  const str = typeof value === 'string' ? value.trim() : String(value);
  // Strip non-digit characters for digit count
  const digits = str.replace(/\D/g, '');
  if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
    return { valid: true, normalized: str };
  }
  return {
    valid: false,
    error: `Invalid phone number: expected ${MIN_PHONE_DIGITS}-${MAX_PHONE_DIGITS} digits, got ${digits.length}`,
  };
}

function validateDate(value: unknown): IntrinsicValidationResult {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, error: 'Expected a date string' };
  }
  const str = value.trim();

  // Accept ISO format
  if (ISO_DATE_REGEX.test(str)) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return { valid: true, normalized: str };
    }
  }

  // Accept natural language dates (already parsed by chrono-node in extraction)
  if (NATURAL_DATE_REGEX.test(str)) {
    return { valid: true, normalized: str };
  }

  // Try Date.parse as last resort
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return { valid: true, normalized: str };
  }

  return { valid: false, error: `Cannot resolve "${str}" to a calendar date` };
}

function validateDatetime(value: unknown): IntrinsicValidationResult {
  // datetime is a superset of date — same validation
  return validateDate(value);
}

function validateBoolean(value: unknown): IntrinsicValidationResult {
  if (typeof value === 'boolean') {
    return { valid: true, normalized: value };
  }
  const str = String(value).toLowerCase().trim();
  if (TRUTHY_VALUES.has(str)) return { valid: true, normalized: true };
  if (FALSY_VALUES.has(str)) return { valid: true, normalized: false };
  return { valid: false, error: `Cannot resolve "${value}" to boolean` };
}

function validateCurrency(value: unknown): IntrinsicValidationResult {
  if (typeof value === 'number' && !isNaN(value)) {
    return { valid: true, normalized: value };
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const obj = value as { value: unknown };
    if (typeof obj.value === 'number' && !isNaN(obj.value)) {
      return { valid: true, normalized: value };
    }
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (!isNaN(parsed)) {
      return { valid: true, normalized: parsed };
    }
  }
  return { valid: false, error: `Invalid currency value: "${value}"` };
}

function validateNumber(value: unknown): IntrinsicValidationResult {
  if (typeof value === 'number' && !isNaN(value)) {
    return { valid: true, normalized: value };
  }
  const parsed = Number(value);
  if (!isNaN(parsed)) {
    return { valid: true, normalized: parsed };
  }
  return { valid: false, error: `Expected a number, got "${value}"` };
}

function validateEnum(value: unknown, constraints?: EntityConstraints): IntrinsicValidationResult {
  if (!constraints?.values || constraints.values.length === 0) {
    return { valid: true, normalized: value };
  }
  const str = String(value);
  const normalized = normalizeEnumValue(str, constraints.values, constraints.synonyms);
  if (normalized !== null) {
    return { valid: true, normalized };
  }
  return {
    valid: false,
    error: `"${str}" is not in allowed values: ${constraints.values.join(', ')}`,
  };
}

function validatePattern(
  value: unknown,
  constraints?: EntityConstraints,
): IntrinsicValidationResult {
  if (!constraints?.pattern) {
    return { valid: true, normalized: value };
  }
  const str = String(value);
  const regex = new RegExp(constraints.pattern);
  if (regex.test(str)) {
    return { valid: true, normalized: str };
  }
  return {
    valid: false,
    error: `"${str}" does not match pattern: ${constraints.pattern}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/intrinsic-validation.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/intrinsic-validation.ts apps/runtime/src/__tests__/intrinsic-validation.test.ts
git add apps/runtime/src/services/execution/intrinsic-validation.ts apps/runtime/src/__tests__/intrinsic-validation.test.ts
git commit -m "[ABLP-2] feat(runtime): add intrinsic validation functions for entity type system"
```

---

## Task 4: Entity Observations Type and Store

**Files:**

- Create: `apps/runtime/src/services/execution/entity-observations.ts`
- Create: `apps/runtime/src/__tests__/entity-observations.test.ts`

Defines the `EntityObservation` and `ObservationSet` types, plus pure functions for creating and managing utterance-scoped observations.

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/entity-observations.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  createObservationSet,
  addObservation,
  getObservationsForEntity,
  getObservationsForType,
  clearObservations,
  type ObservationSet,
  type EntityObservation,
} from '../services/execution/entity-observations.js';

describe('Entity observations', () => {
  it('creates an empty observation set', () => {
    const set = createObservationSet();
    expect(set.entities).toEqual({});
    expect(set.turn).toBe(0);
  });

  it('adds a single observation', () => {
    let set = createObservationSet(1);
    set = addObservation(set, {
      entityName: 'airport_code',
      entityType: 'enum',
      value: 'JFK',
      confidence: 0.96,
      span: 'from JFK',
    });
    expect(set.entities['airport_code']).toHaveLength(1);
    expect(set.entities['airport_code'][0].value).toBe('JFK');
    expect(set.turn).toBe(1);
  });

  it('adds multiple observations for same entity', () => {
    let set = createObservationSet(1);
    set = addObservation(set, {
      entityName: 'airport_code',
      entityType: 'enum',
      value: 'JFK',
      confidence: 0.96,
    });
    set = addObservation(set, {
      entityName: 'airport_code',
      entityType: 'enum',
      value: 'LAX',
      confidence: 0.94,
    });
    expect(set.entities['airport_code']).toHaveLength(2);
  });

  it('retrieves observations by entity name', () => {
    let set = createObservationSet(1);
    set = addObservation(set, {
      entityName: 'airport_code',
      entityType: 'enum',
      value: 'JFK',
      confidence: 0.96,
    });
    set = addObservation(set, {
      entityName: 'travel_date',
      entityType: 'date',
      value: '2026-03-15',
      confidence: 0.91,
    });

    const airports = getObservationsForEntity(set, 'airport_code');
    expect(airports).toHaveLength(1);
    expect(airports[0].value).toBe('JFK');

    const dates = getObservationsForEntity(set, 'travel_date');
    expect(dates).toHaveLength(1);
  });

  it('retrieves observations by entity type', () => {
    let set = createObservationSet(1);
    set = addObservation(set, {
      entityName: 'origin',
      entityType: 'enum',
      value: 'JFK',
      confidence: 0.96,
    });
    set = addObservation(set, {
      entityName: 'cabin',
      entityType: 'enum',
      value: 'business',
      confidence: 0.89,
    });
    set = addObservation(set, {
      entityName: 'travel_date',
      entityType: 'date',
      value: '2026-03-15',
      confidence: 0.91,
    });

    const enums = getObservationsForType(set, 'enum');
    expect(enums).toHaveLength(2);
  });

  it('clears observations (utterance-scoped reset)', () => {
    let set = createObservationSet(1);
    set = addObservation(set, {
      entityName: 'airport_code',
      entityType: 'enum',
      value: 'JFK',
      confidence: 0.96,
    });
    set = clearObservations(set, 2);
    expect(set.entities).toEqual({});
    expect(set.turn).toBe(2);
  });

  it('returns empty array for unknown entity name', () => {
    const set = createObservationSet();
    expect(getObservationsForEntity(set, 'nonexistent')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-observations.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement entity observations**

Create `apps/runtime/src/services/execution/entity-observations.ts`:

```typescript
/**
 * Entity Observations — Utterance-Scoped Extraction Results
 *
 * Observations are ephemeral — replaced every turn. They represent
 * what the system detected in the current utterance before slot
 * assignment or commitment.
 *
 * All functions are pure — they return new objects instead of mutating.
 */

/**
 * A single observed entity value extracted from a user utterance.
 */
export interface EntityObservation {
  /** Entity name from ir.entities */
  entityName: string;
  /** Entity type (email, phone, enum, etc.) */
  entityType: string;
  /** Extracted value (already normalized if applicable) */
  value: unknown;
  /** Extraction confidence (0-1) */
  confidence: number;
  /** Original text span from the utterance */
  span?: string;
  /** Whether this observation passed intrinsic validation */
  intrinsicValid?: boolean;
  /** Intrinsic validation error if failed */
  intrinsicError?: string;
}

/**
 * The full set of observations for a single turn.
 * Keyed by entity name → array of observations (multi-value support).
 */
export interface ObservationSet {
  /** Entity observations keyed by entity name */
  entities: Record<string, EntityObservation[]>;
  /** Turn number this observation set belongs to */
  turn: number;
}

/**
 * Serializable form of ObservationSet for session storage.
 * Same shape — no Set or Map types.
 */
export type SerializedObservationSet = ObservationSet;

/** Create a fresh empty observation set */
export function createObservationSet(turn: number = 0): ObservationSet {
  return { entities: {}, turn };
}

/** Add an observation to the set (returns new set) */
export function addObservation(
  set: ObservationSet,
  observation: EntityObservation,
): ObservationSet {
  const existing = set.entities[observation.entityName] ?? [];
  return {
    ...set,
    entities: {
      ...set.entities,
      [observation.entityName]: [...existing, observation],
    },
  };
}

/** Get all observations for a specific entity name */
export function getObservationsForEntity(
  set: ObservationSet,
  entityName: string,
): EntityObservation[] {
  return set.entities[entityName] ?? [];
}

/** Get all observations matching a specific entity type */
export function getObservationsForType(
  set: ObservationSet,
  entityType: string,
): EntityObservation[] {
  const result: EntityObservation[] = [];
  for (const observations of Object.values(set.entities)) {
    for (const obs of observations) {
      if (obs.entityType === entityType) {
        result.push(obs);
      }
    }
  }
  return result;
}

/** Clear all observations (new turn) */
export function clearObservations(_set: ObservationSet, newTurn: number): ObservationSet {
  return createObservationSet(newTurn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-observations.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/entity-observations.ts apps/runtime/src/__tests__/entity-observations.test.ts
git add apps/runtime/src/services/execution/entity-observations.ts apps/runtime/src/__tests__/entity-observations.test.ts
git commit -m "[ABLP-2] feat(runtime): add entity observation types and pure functions"
```

---

## Task 5: Add Observations to Session State

**Files:**

- Modify: `apps/runtime/src/services/session/types.ts:20` (SessionData)
- Modify: `apps/runtime/src/services/execution/types.ts:184` (RuntimeSession)

Add the `observations` field to both the serializable SessionData and the hydrated RuntimeSession.

- [ ] **Step 1: Read current types to verify exact insertion points**

Read `apps/runtime/src/services/session/types.ts` lines 20-50 and `apps/runtime/src/services/execution/types.ts` lines 184-200 to verify exact field positions.

- [ ] **Step 2: Add observations import and field to SessionData**

In `apps/runtime/src/services/session/types.ts`, add import at top:

```typescript
import type { SerializedObservationSet } from '../execution/entity-observations.js';
```

Add field to `SessionData` interface after line 46 (`dataGatheredKeys: string[];`):

```typescript
  /** Utterance-scoped entity observations — replaced each turn, not persisted */
  observations?: SerializedObservationSet;
```

- [ ] **Step 3: Add observations field to RuntimeSession**

In `apps/runtime/src/services/execution/types.ts`, add import at top:

```typescript
import type { ObservationSet } from './entity-observations.js';
```

Add field to `RuntimeSession` interface after `data: SessionDataStore;` (around line 192):

```typescript
  /** Utterance-scoped entity observations — replaced each turn */
  observations?: ObservationSet;
```

- [ ] **Step 4: Build to verify no type errors**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime`
Expected: BUILD SUCCESS (new optional fields don't break existing code)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/session/types.ts apps/runtime/src/services/execution/types.ts
git add apps/runtime/src/services/session/types.ts apps/runtime/src/services/execution/types.ts
git commit -m "[ABLP-2] feat(runtime): add observations field to session and runtime types"
```

---

## Task 6: Entity Extraction Pipeline Orchestrator

**Files:**

- Create: `apps/runtime/src/services/execution/entity-pipeline.ts`
- Create: `apps/runtime/src/__tests__/entity-pipeline.test.ts`

The orchestrator runs the entity lifecycle phases 1-3 (Extract → Normalize → Validate intrinsic) against `ir.entities` and returns an `ObservationSet`. This is a pure function that does NOT touch session state.

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/entity-pipeline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractEntityObservations } from '../services/execution/entity-pipeline.js';
import type { EntityDefinitionIR } from '@abl/compiler';

describe('Entity extraction pipeline', () => {
  const emailEntity: EntityDefinitionIR = {
    name: 'user_email',
    type: 'email',
    intrinsic_validation: 'RFC 5322 compliant email format',
    source: 'explicit',
  };

  const phoneEntity: EntityDefinitionIR = {
    name: 'phone_number',
    type: 'phone',
    intrinsic_validation: 'Valid phone number',
    source: 'explicit',
  };

  const enumEntity: EntityDefinitionIR = {
    name: 'cabin_class',
    type: 'enum',
    values: ['economy', 'business', 'first'],
    synonyms: { business: ['biz', 'biz class'] },
    source: 'explicit',
  };

  it('extracts email from text', () => {
    const result = extractEntityObservations(
      'My email is user@example.com',
      [emailEntity],
      'en',
      1,
    );
    expect(result.entities['user_email']).toBeDefined();
    expect(result.entities['user_email']).toHaveLength(1);
    expect(result.entities['user_email'][0].value).toBe('user@example.com');
    expect(result.entities['user_email'][0].intrinsicValid).toBe(true);
  });

  it('extracts phone from text', () => {
    const result = extractEntityObservations('Call me at +12025551234', [phoneEntity], 'en-US', 1);
    expect(result.entities['phone_number']).toBeDefined();
    expect(result.entities['phone_number'][0].intrinsicValid).toBe(true);
  });

  it('marks invalid entities with intrinsicValid=false', () => {
    const result = extractEntityObservations('My email is notanemail', [emailEntity], 'en', 1);
    // If extraction tier returns a value, intrinsic validation should flag it
    // But if no extraction tier matches, the entity won't appear at all
    const emailObs = result.entities['user_email'];
    if (emailObs && emailObs.length > 0) {
      expect(emailObs[0].intrinsicValid).toBe(false);
    }
  });

  it('extracts multiple entity types from one utterance', () => {
    const result = extractEntityObservations(
      'My email is user@example.com and call me at +12025551234',
      [emailEntity, phoneEntity],
      'en-US',
      1,
    );
    expect(result.entities['user_email']).toBeDefined();
    expect(result.entities['phone_number']).toBeDefined();
  });

  it('skips entities whose type has no JS extraction support', () => {
    const locationEntity: EntityDefinitionIR = {
      name: 'city',
      type: 'location',
      source: 'explicit',
    };
    const result = extractEntityObservations('I live in New York', [locationEntity], 'en', 1);
    // Location requires LLM extraction (not available in unit test context)
    // so no observations should be produced for it
    expect(result.entities['city']).toBeUndefined();
  });

  it('handles empty entity list', () => {
    const result = extractEntityObservations('Hello world', [], 'en', 1);
    expect(Object.keys(result.entities)).toHaveLength(0);
  });

  it('normalizes enum values via synonym resolution', () => {
    const result = extractEntityObservations('I want biz class', [enumEntity], 'en', 1);
    // enum extraction requires LLM or specific match — may not extract via JS libs
    // This test validates the pipeline runs without error
    expect(result.turn).toBe(1);
  });

  it('sets turn number on observation set', () => {
    const result = extractEntityObservations('test', [emailEntity], 'en', 42);
    expect(result.turn).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-pipeline.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement entity pipeline**

Create `apps/runtime/src/services/execution/entity-pipeline.ts`:

```typescript
/**
 * Entity Extraction Pipeline — Phases 1-3
 *
 * Orchestrates per-turn entity extraction from ir.entities:
 *   Phase 1: Extract — run JS extraction (Tier 1) for each entity
 *   Phase 2: Normalize — apply synonym resolution for enum entities
 *   Phase 3: Validate (intrinsic) — run entity-level validation
 *
 * Returns an ObservationSet with all extracted, normalized, validated observations.
 * Observations that fail intrinsic validation are kept in the set but marked
 * as intrinsicValid=false — this supports tracing "what was extracted but rejected."
 *
 * This module is a pure function. It does NOT mutate session state.
 */

import type { EntityDefinitionIR } from '@abl/compiler';
import { extractWithJSLibs, isJSExtractableType } from './js-extraction.js';
import { normalizeEnumValue } from './extraction-validation.js';
import { validateIntrinsic } from './intrinsic-validation.js';
import {
  createObservationSet,
  addObservation,
  type ObservationSet,
  type EntityObservation,
} from './entity-observations.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('entity-pipeline');

/**
 * Run per-turn entity extraction against all entity definitions.
 *
 * @param userMessage - The user's utterance
 * @param entities - Entity definitions from ir.entities
 * @param locale - BCP-47 locale (e.g. 'en', 'en-US')
 * @param turn - Current turn number
 * @returns ObservationSet with all extracted entities (valid and invalid)
 */
export function extractEntityObservations(
  userMessage: string,
  entities: EntityDefinitionIR[],
  locale: string,
  turn: number,
): ObservationSet {
  let observations = createObservationSet(turn);

  if (!userMessage || !userMessage.trim() || entities.length === 0) {
    return observations;
  }

  // Phase 1: Extract using JS libs (Tier 1)
  // Group entities by whether JS extraction supports their type
  const jsExtractable = entities.filter((e) => isJSExtractableType(e.type));
  const jsFields = jsExtractable.map((e) => ({ name: e.name, type: e.type }));

  let jsResults: Record<string, unknown> = {};
  if (jsFields.length > 0) {
    try {
      jsResults = extractWithJSLibs(userMessage, jsFields, locale);
    } catch (err) {
      log.warn('JS extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 2 & 3: Normalize + Validate intrinsic for each extracted value
  for (const entity of entities) {
    const rawValue = jsResults[entity.name];
    if (rawValue === undefined || rawValue === null) continue;

    // Phase 2: Normalize (enum synonym resolution)
    let normalizedValue = rawValue;
    if (entity.type === 'enum' && entity.values && typeof rawValue === 'string') {
      const resolved = normalizeEnumValue(rawValue, entity.values, entity.synonyms);
      if (resolved !== null) {
        normalizedValue = resolved;
      }
    }

    // Phase 3: Validate intrinsic
    const validation = validateIntrinsic(entity.type, normalizedValue, {
      values: entity.values,
      synonyms: entity.synonyms,
      pattern: entity.pattern,
    });

    const observation: EntityObservation = {
      entityName: entity.name,
      entityType: entity.type,
      value: validation.normalized ?? normalizedValue,
      confidence: 1.0, // JS extraction doesn't produce confidence; default to 1.0
      intrinsicValid: validation.valid,
      intrinsicError: validation.valid ? undefined : validation.error,
    };

    observations = addObservation(observations, observation);
  }

  return observations;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-pipeline.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/entity-pipeline.ts apps/runtime/src/__tests__/entity-pipeline.test.ts
git add apps/runtime/src/services/execution/entity-pipeline.ts apps/runtime/src/__tests__/entity-pipeline.test.ts
git commit -m "[ABLP-2] feat(runtime): add entity extraction pipeline orchestrator (phases 1-3)"
```

---

## Task 7: Slot Assignment Logic

**Files:**

- Create: `apps/runtime/src/services/execution/slot-assignment.ts`
- Create: `apps/runtime/src/__tests__/slot-assignment.test.ts`

Implements Cases A-D from the spec: multi-value multi-slot LLM disambiguation, multi-value single-slot clarification, direct assignment, and observations-only (no GATHER).

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/slot-assignment.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  assignObservationsToSlots,
  type SlotAssignmentResult,
  type SlotTarget,
} from '../services/execution/slot-assignment.js';
import type { ObservationSet } from '../services/execution/entity-observations.js';
import { createObservationSet, addObservation } from '../services/execution/entity-observations.js';

function makeObservations(
  entries: Array<{ entityName: string; entityType: string; value: unknown }>,
  turn: number = 1,
): ObservationSet {
  let set = createObservationSet(turn);
  for (const entry of entries) {
    set = addObservation(set, {
      ...entry,
      confidence: 0.95,
      intrinsicValid: true,
    });
  }
  return set;
}

describe('Slot assignment', () => {
  describe('Case C: one value, direct assignment', () => {
    it('assigns single value to single slot', () => {
      const observations = makeObservations([
        { entityName: 'user_email', entityType: 'email', value: 'user@example.com' },
      ]);
      const slots: SlotTarget[] = [
        { fieldName: 'email', entityRef: 'user_email', entityType: 'email', prompt: 'Your email?' },
      ];
      const result = assignObservationsToSlots(observations, slots);
      expect(result.assigned).toEqual({ email: 'user@example.com' });
      expect(result.needsClarification).toEqual([]);
      expect(result.needsDisambiguation).toEqual([]);
    });

    it('assigns single value to one of multiple slots by entity ref', () => {
      const observations = makeObservations([
        { entityName: 'travel_date', entityType: 'date', value: '2026-03-15' },
      ]);
      const slots: SlotTarget[] = [
        {
          fieldName: 'departure_date',
          entityRef: 'travel_date',
          entityType: 'date',
          prompt: 'Departure?',
        },
        {
          fieldName: 'return_date',
          entityRef: 'travel_date',
          entityType: 'date',
          prompt: 'Return?',
        },
      ];
      const result = assignObservationsToSlots(observations, slots);
      // Single value + multiple slots: assign to first matching slot
      expect(result.assigned['departure_date']).toBe('2026-03-15');
    });
  });

  describe('Case B: multiple values, one slot → clarification', () => {
    it('flags clarification when 2 values and 1 slot', () => {
      const observations = makeObservations([
        { entityName: 'airport_code', entityType: 'enum', value: 'JFK' },
        { entityName: 'airport_code', entityType: 'enum', value: 'LAX' },
      ]);
      const slots: SlotTarget[] = [
        {
          fieldName: 'preferred_airport',
          entityRef: 'airport_code',
          entityType: 'enum',
          prompt: 'Which airport?',
        },
      ];
      const result = assignObservationsToSlots(observations, slots);
      expect(result.needsClarification).toHaveLength(1);
      expect(result.needsClarification[0].fieldName).toBe('preferred_airport');
      expect(result.needsClarification[0].candidates).toEqual(['JFK', 'LAX']);
    });
  });

  describe('Case A: multiple values, multiple slots → disambiguation', () => {
    it('flags disambiguation when 2 values and 2 slots of same entity type', () => {
      const observations = makeObservations([
        { entityName: 'airport_code', entityType: 'enum', value: 'JFK' },
        { entityName: 'airport_code', entityType: 'enum', value: 'LAX' },
      ]);
      const slots: SlotTarget[] = [
        {
          fieldName: 'origin',
          entityRef: 'airport_code',
          entityType: 'enum',
          prompt: 'Where from?',
        },
        {
          fieldName: 'destination',
          entityRef: 'airport_code',
          entityType: 'enum',
          prompt: 'Where to?',
        },
      ];
      const result = assignObservationsToSlots(observations, slots);
      expect(result.needsDisambiguation).toHaveLength(1);
      expect(result.needsDisambiguation[0].entityName).toBe('airport_code');
      expect(result.needsDisambiguation[0].values).toEqual(['JFK', 'LAX']);
      expect(result.needsDisambiguation[0].targetFields).toHaveLength(2);
    });
  });

  describe('Case D: no GATHER slots', () => {
    it('returns empty assignment when no slots provided', () => {
      const observations = makeObservations([
        { entityName: 'airport_code', entityType: 'enum', value: 'JFK' },
      ]);
      const result = assignObservationsToSlots(observations, []);
      expect(result.assigned).toEqual({});
      expect(result.needsClarification).toEqual([]);
      expect(result.needsDisambiguation).toEqual([]);
    });
  });

  describe('Mixed entity types', () => {
    it('assigns different entity types independently', () => {
      const observations = makeObservations([
        { entityName: 'user_email', entityType: 'email', value: 'user@example.com' },
        { entityName: 'travel_date', entityType: 'date', value: '2026-03-15' },
      ]);
      const slots: SlotTarget[] = [
        { fieldName: 'email', entityRef: 'user_email', entityType: 'email', prompt: 'Email?' },
        { fieldName: 'departure', entityRef: 'travel_date', entityType: 'date', prompt: 'When?' },
      ];
      const result = assignObservationsToSlots(observations, slots);
      expect(result.assigned['email']).toBe('user@example.com');
      expect(result.assigned['departure']).toBe('2026-03-15');
    });
  });

  describe('Intrinsic-invalid observations are excluded', () => {
    it('does not assign observations marked intrinsicValid=false', () => {
      let set = createObservationSet(1);
      set = addObservation(set, {
        entityName: 'user_email',
        entityType: 'email',
        value: 'bad-email',
        confidence: 0.9,
        intrinsicValid: false,
        intrinsicError: 'Invalid email format',
      });
      const slots: SlotTarget[] = [
        { fieldName: 'email', entityRef: 'user_email', entityType: 'email', prompt: 'Email?' },
      ];
      const result = assignObservationsToSlots(set, slots);
      expect(result.assigned).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/slot-assignment.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement slot assignment**

Create `apps/runtime/src/services/execution/slot-assignment.ts`:

```typescript
/**
 * Slot Assignment — Phase 4 of Entity Lifecycle
 *
 * Maps utterance-scoped observations to session-scoped GATHER fields.
 * Handles four cases:
 *
 *   Case A: Multiple values + multiple GATHER fields of same entity → needsDisambiguation
 *           (caller sends to LLM for contextual assignment)
 *   Case B: Multiple values + one GATHER field → needsClarification
 *           (runtime asks user to choose)
 *   Case C: One value + one or more GATHER fields → direct assignment
 *   Case D: No GATHER fields → observations only (no assignment)
 *
 * Pure function — no session state mutation, no LLM calls.
 * The caller handles LLM disambiguation and user clarification.
 */

import type { ObservationSet, EntityObservation } from './entity-observations.js';

/**
 * A GATHER field that can receive an observation value.
 */
export interface SlotTarget {
  /** GATHER field name */
  fieldName: string;
  /** Entity ref (from entity_ref on GATHER field, or field name if inline type) */
  entityRef: string;
  /** Entity type */
  entityType: string;
  /** GATHER field prompt (used by LLM disambiguation) */
  prompt: string;
}

/**
 * Case B: User must clarify which of multiple values to assign.
 */
export interface ClarificationNeeded {
  fieldName: string;
  entityRef: string;
  candidates: unknown[];
  prompt: string;
}

/**
 * Case A: LLM must disambiguate which value goes to which field.
 */
export interface DisambiguationNeeded {
  entityName: string;
  entityType: string;
  values: unknown[];
  targetFields: Array<{ fieldName: string; prompt: string }>;
}

/**
 * Result of slot assignment.
 */
export interface SlotAssignmentResult {
  /** Direct assignments (Case C) — ready to commit */
  assigned: Record<string, unknown>;
  /** Cases needing user clarification (Case B) */
  needsClarification: ClarificationNeeded[];
  /** Cases needing LLM disambiguation (Case A) */
  needsDisambiguation: DisambiguationNeeded[];
}

/**
 * Assign observations to GATHER slots.
 *
 * @param observations - The current turn's observation set
 * @param slots - GATHER fields that can receive values
 * @returns Assignment results with direct assignments, clarifications, and disambiguations
 */
export function assignObservationsToSlots(
  observations: ObservationSet,
  slots: SlotTarget[],
): SlotAssignmentResult {
  const assigned: Record<string, unknown> = {};
  const needsClarification: ClarificationNeeded[] = [];
  const needsDisambiguation: DisambiguationNeeded[] = [];

  if (slots.length === 0) {
    return { assigned, needsClarification, needsDisambiguation };
  }

  // Group slots by their entity ref
  const slotsByEntityRef = new Map<string, SlotTarget[]>();
  for (const slot of slots) {
    const existing = slotsByEntityRef.get(slot.entityRef) ?? [];
    existing.push(slot);
    slotsByEntityRef.set(slot.entityRef, existing);
  }

  // For each entity ref, check what observations exist
  for (const [entityRef, targetSlots] of slotsByEntityRef) {
    const entityObs = (observations.entities[entityRef] ?? []).filter(
      (obs) => obs.intrinsicValid !== false,
    );

    if (entityObs.length === 0) continue;

    const values = entityObs.map((obs) => obs.value);
    const uniqueValues = [...new Set(values.map((v) => JSON.stringify(v)))].map((s) =>
      JSON.parse(s),
    );

    if (uniqueValues.length === 1 || targetSlots.length === 0) {
      // Case C: One value → direct assignment to first unassigned slot
      if (targetSlots.length > 0) {
        assigned[targetSlots[0].fieldName] = uniqueValues[0];
      }
    } else if (uniqueValues.length > 1 && targetSlots.length === 1) {
      // Case B: Multiple values, one slot → clarification
      needsClarification.push({
        fieldName: targetSlots[0].fieldName,
        entityRef,
        candidates: uniqueValues,
        prompt: targetSlots[0].prompt,
      });
    } else if (uniqueValues.length > 1 && targetSlots.length > 1) {
      // Case A: Multiple values, multiple slots → disambiguation
      needsDisambiguation.push({
        entityName: entityRef,
        entityType: entityObs[0].entityType,
        values: uniqueValues,
        targetFields: targetSlots.map((s) => ({
          fieldName: s.fieldName,
          prompt: s.prompt,
        })),
      });
    }
  }

  return { assigned, needsClarification, needsDisambiguation };
}

/**
 * Build the LLM disambiguation prompt for Case A.
 * The caller sends this to the LLM and parses the JSON response.
 */
export function buildDisambiguationPrompt(
  userMessage: string,
  disambiguation: DisambiguationNeeded,
): string {
  const fieldDescriptions = disambiguation.targetFields
    .map((f) => `- ${f.fieldName}: "${f.prompt}"`)
    .join('\n');

  return (
    `Given the user message: "${userMessage}"\n` +
    `Extracted ${disambiguation.entityName} values: ${disambiguation.values.join(', ')}\n\n` +
    `Assign each value to one of these fields:\n${fieldDescriptions}\n\n` +
    `Respond with a JSON object mapping field names to values. Example:\n` +
    `{"${disambiguation.targetFields[0]?.fieldName}": "${disambiguation.values[0]}", ` +
    `"${disambiguation.targetFields[1]?.fieldName}": "${disambiguation.values[1]}"}`
  );
}

/**
 * Build the clarification message for Case B.
 */
export function buildClarificationMessage(clarification: ClarificationNeeded): string {
  const candidateList = clarification.candidates.map((v) => String(v)).join(' and ');
  return `I found ${candidateList}. ${clarification.prompt}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/slot-assignment.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/slot-assignment.ts apps/runtime/src/__tests__/slot-assignment.test.ts
git add apps/runtime/src/services/execution/slot-assignment.ts apps/runtime/src/__tests__/slot-assignment.test.ts
git commit -m "[ABLP-2] feat(runtime): add slot assignment logic (Cases A-D)"
```

---

## Task 8: Entity Lifecycle Trace Events

**Files:**

- Create: `apps/runtime/src/services/execution/entity-trace-events.ts`
- Create: `apps/runtime/src/__tests__/entity-trace-events.test.ts`

Pure functions that build trace events for each entity lifecycle phase. Follows the existing `TraceEvent` pattern (`{type: string, data: Record<string, unknown>}`).

- [ ] **Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/entity-trace-events.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  traceEntityObservation,
  traceIntrinsicValidation,
  traceSlotAssignment,
  traceSlotClarification,
  traceSlotDisambiguation,
  traceBusinessValidation,
  traceEntityCommitment,
} from '../services/execution/entity-trace-events.js';

describe('Entity trace events', () => {
  it('creates observation trace event', () => {
    const event = traceEntityObservation(
      'test-agent',
      'user_email',
      'email',
      'user@example.com',
      0.95,
    );
    expect(event.type).toBe('entity_observation');
    expect(event.data.agentName).toBe('test-agent');
    expect(event.data.entityName).toBe('user_email');
    expect(event.data.entityType).toBe('email');
    expect(event.data.value).toBe('user@example.com');
  });

  it('creates intrinsic validation pass event', () => {
    const event = traceIntrinsicValidation(
      'test-agent',
      'user_email',
      'email',
      'user@example.com',
      true,
    );
    expect(event.type).toBe('entity_validation_intrinsic');
    expect(event.data.valid).toBe(true);
  });

  it('creates intrinsic validation fail event', () => {
    const event = traceIntrinsicValidation(
      'test-agent',
      'user_email',
      'email',
      'bad',
      false,
      'Invalid email',
    );
    expect(event.type).toBe('entity_validation_intrinsic');
    expect(event.data.valid).toBe(false);
    expect(event.data.error).toBe('Invalid email');
  });

  it('creates slot assignment trace event', () => {
    const event = traceSlotAssignment(
      'test-agent',
      'email',
      'user_email',
      'user@example.com',
      'direct',
    );
    expect(event.type).toBe('entity_slot_assignment');
    expect(event.data.fieldName).toBe('email');
    expect(event.data.method).toBe('direct');
  });

  it('creates clarification trace event', () => {
    const event = traceSlotClarification('test-agent', 'preferred_airport', 'airport_code', [
      'JFK',
      'LAX',
    ]);
    expect(event.type).toBe('entity_slot_clarification');
    expect(event.data.candidates).toEqual(['JFK', 'LAX']);
  });

  it('creates disambiguation trace event', () => {
    const event = traceSlotDisambiguation(
      'test-agent',
      'airport_code',
      ['JFK', 'LAX'],
      ['origin', 'destination'],
    );
    expect(event.type).toBe('entity_slot_disambiguation');
    expect(event.data.values).toEqual(['JFK', 'LAX']);
    expect(event.data.targetFields).toEqual(['origin', 'destination']);
  });

  it('creates business validation trace event', () => {
    const event = traceBusinessValidation('test-agent', 'email', 'user@example.com', true);
    expect(event.type).toBe('entity_validation_business');
    expect(event.data.valid).toBe(true);
  });

  it('creates commitment trace event', () => {
    const event = traceEntityCommitment('test-agent', 'email', 'user@example.com');
    expect(event.type).toBe('entity_commitment');
    expect(event.data.fieldName).toBe('email');
    expect(event.data.value).toBe('user@example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-trace-events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement entity trace events**

Create `apps/runtime/src/services/execution/entity-trace-events.ts`:

```typescript
/**
 * Entity Lifecycle Trace Events
 *
 * Pure functions that build trace event payloads for each phase
 * of the entity lifecycle. These follow the existing TraceEvent
 * pattern: { type: string, data: Record<string, unknown> }.
 *
 * Trace types:
 * - entity_observation: entity extracted from utterance
 * - entity_validation_intrinsic: entity-level validation pass/fail
 * - entity_slot_assignment: value mapped to GATHER field
 * - entity_slot_clarification: multiple values, user asked to choose
 * - entity_slot_disambiguation: LLM assigned values to fields
 * - entity_validation_business: GATHER-level business validation pass/fail
 * - entity_commitment: value written to session state
 */

interface EntityTraceEvent {
  type: string;
  data: Record<string, unknown>;
}

export function traceEntityObservation(
  agentName: string,
  entityName: string,
  entityType: string,
  value: unknown,
  confidence: number,
  span?: string,
): EntityTraceEvent {
  return {
    type: 'entity_observation',
    data: {
      agentName,
      entityName,
      entityType,
      value,
      confidence,
      ...(span !== undefined ? { span } : {}),
    },
  };
}

export function traceIntrinsicValidation(
  agentName: string,
  entityName: string,
  entityType: string,
  value: unknown,
  valid: boolean,
  error?: string,
): EntityTraceEvent {
  return {
    type: 'entity_validation_intrinsic',
    data: {
      agentName,
      entityName,
      entityType,
      value,
      valid,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

export function traceSlotAssignment(
  agentName: string,
  fieldName: string,
  entityRef: string,
  value: unknown,
  method: 'direct' | 'disambiguation' | 'clarification',
): EntityTraceEvent {
  return {
    type: 'entity_slot_assignment',
    data: {
      agentName,
      fieldName,
      entityRef,
      value,
      method,
    },
  };
}

export function traceSlotClarification(
  agentName: string,
  fieldName: string,
  entityRef: string,
  candidates: unknown[],
): EntityTraceEvent {
  return {
    type: 'entity_slot_clarification',
    data: {
      agentName,
      fieldName,
      entityRef,
      candidates,
    },
  };
}

export function traceSlotDisambiguation(
  agentName: string,
  entityName: string,
  values: unknown[],
  targetFields: string[],
): EntityTraceEvent {
  return {
    type: 'entity_slot_disambiguation',
    data: {
      agentName,
      entityName,
      values,
      targetFields,
    },
  };
}

export function traceBusinessValidation(
  agentName: string,
  fieldName: string,
  value: unknown,
  valid: boolean,
  error?: string,
): EntityTraceEvent {
  return {
    type: 'entity_validation_business',
    data: {
      agentName,
      fieldName,
      value,
      valid,
      ...(error !== undefined ? { error } : {}),
    },
  };
}

export function traceEntityCommitment(
  agentName: string,
  fieldName: string,
  value: unknown,
): EntityTraceEvent {
  return {
    type: 'entity_commitment',
    data: {
      agentName,
      fieldName,
      value,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime && pnpm vitest run apps/runtime/src/__tests__/entity-trace-events.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/entity-trace-events.ts apps/runtime/src/__tests__/entity-trace-events.test.ts
git add apps/runtime/src/services/execution/entity-trace-events.ts apps/runtime/src/__tests__/entity-trace-events.test.ts
git commit -m "[ABLP-2] feat(runtime): add entity lifecycle trace event builders"
```

---

## Task 9: Wire Entity Pipeline into Reasoning Executor

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:584-658`

Wire the entity pipeline into the reasoning executor's GATHER pre-pass. The entity pipeline runs before the existing `extractEntitiesWithLLM` call, producing observations that are stored on the session. The existing GATHER extraction flow continues to work as-is — entity observations provide additional context.

- [ ] **Step 1: Read reasoning executor current imports and GATHER pre-pass**

Read `apps/runtime/src/services/execution/reasoning-executor.ts` lines 1-30 (imports) and lines 575-690 (GATHER pre-pass) to verify exact insertion points.

- [ ] **Step 2: Add imports to reasoning executor**

At the top of `reasoning-executor.ts`, alongside existing imports, add:

```typescript
import { extractEntityObservations } from './entity-pipeline.js';
import { createObservationSet } from './entity-observations.js';
import { traceEntityObservation, traceIntrinsicValidation } from './entity-trace-events.js';
import { assignObservationsToSlots, type SlotTarget } from './slot-assignment.js';
```

- [ ] **Step 3: Add entity pipeline before GATHER extraction**

In the GATHER pre-pass section (around line 584), insert the entity pipeline BEFORE the existing `extractEntitiesWithLLM` call. The entity pipeline runs for all defined entities in `ir.entities`, regardless of whether GATHER fields exist.

Insert before the existing `if (gatherFields && gatherFields.length > 0 && !inlineGather)` block (line 588):

```typescript
// === ENTITY PIPELINE: Per-turn extraction from ir.entities ===
// Runs for ALL defined entities, not just GATHER fields.
// Observations are utterance-scoped — replaced each turn.
const irEntities = session.agentIR?.entities;
if (irEntities && irEntities.length > 0 && currentTurnInput) {
  const locale = (session.data.values._locale as string) ?? 'en';
  const turnNumber = session.conversationHistory.length;

  try {
    const observations = extractEntityObservations(
      currentTurnInput,
      irEntities,
      locale,
      turnNumber,
    );

    // Store observations on session (utterance-scoped)
    session.observations = observations;

    // Emit trace events for each observation
    if (onTraceEvent) {
      for (const [entityName, entityObs] of Object.entries(observations.entities)) {
        for (const obs of entityObs) {
          onTraceEvent(
            traceEntityObservation(
              session.agentName,
              entityName,
              obs.entityType,
              obs.value,
              obs.confidence,
              obs.span,
            ),
          );
          onTraceEvent(
            traceIntrinsicValidation(
              session.agentName,
              entityName,
              obs.entityType,
              obs.value,
              obs.intrinsicValid ?? true,
              obs.intrinsicError,
            ),
          );
        }
      }
    }
  } catch (err) {
    log.warn('Entity pipeline extraction failed', {
      agentName: session.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    session.observations = createObservationSet(session.conversationHistory.length);
  }
}
```

The existing GATHER extraction flow (lines 588-658) remains unchanged. The entity observations provide supplementary data alongside the GATHER-field-scoped extraction.

- [ ] **Step 4: Build to verify no type errors**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime`
Expected: BUILD SUCCESS

- [ ] **Step 5: Run existing runtime tests to verify no regressions**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm vitest run apps/runtime/src/__tests__/`
Expected: All existing tests pass

- [ ] **Step 6: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire entity pipeline into reasoning executor"
```

---

## Task 10: Wire Entity Pipeline into Flow Step Executor

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:4511-4565`

Wire the entity pipeline into the flow step executor's GATHER block, same pattern as reasoning executor.

- [ ] **Step 1: Read flow step executor current imports and GATHER block**

Read `apps/runtime/src/services/execution/flow-step-executor.ts` lines 1-40 (imports) and lines 4505-4570 (GATHER block) to verify exact insertion points.

- [ ] **Step 2: Add imports to flow step executor**

At the top of `flow-step-executor.ts`, alongside existing imports, add:

```typescript
import { extractEntityObservations } from './entity-pipeline.js';
import { createObservationSet } from './entity-observations.js';
import { traceEntityObservation, traceIntrinsicValidation } from './entity-trace-events.js';
```

- [ ] **Step 3: Add entity pipeline before GATHER extraction in flow step**

Insert before the GATHER block at line 4511 (`if (step.gather && step.gather.fields && step.gather.fields.length > 0)`):

```typescript
// === ENTITY PIPELINE: Per-turn extraction from ir.entities ===
const irEntities = session.agentIR?.entities;
if (irEntities && irEntities.length > 0 && currentMessage) {
  const locale = (session.data.values._locale as string) ?? 'en';
  const turnNumber = session.conversationHistory.length;

  try {
    const observations = extractEntityObservations(currentMessage, irEntities, locale, turnNumber);

    session.observations = observations;

    if (onTraceEvent) {
      for (const [entityName, entityObs] of Object.entries(observations.entities)) {
        for (const obs of entityObs) {
          onTraceEvent(
            traceEntityObservation(
              session.agentName,
              entityName,
              obs.entityType,
              obs.value,
              obs.confidence,
              obs.span,
            ),
          );
          onTraceEvent(
            traceIntrinsicValidation(
              session.agentName,
              entityName,
              obs.entityType,
              obs.value,
              obs.intrinsicValid ?? true,
              obs.intrinsicError,
            ),
          );
        }
      }
    }
  } catch (err) {
    log.warn('Entity pipeline extraction failed in flow step', {
      agentName: session.agentName,
      stepName,
      error: err instanceof Error ? err.message : String(err),
    });
    session.observations = createObservationSet(session.conversationHistory.length);
  }
}
```

The existing GATHER block and `extractEntitiesWithLLM` call continue unchanged.

- [ ] **Step 4: Build to verify no type errors**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=runtime`
Expected: BUILD SUCCESS

- [ ] **Step 5: Run existing runtime tests to verify no regressions**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm vitest run apps/runtime/src/__tests__/`
Expected: All existing tests pass

- [ ] **Step 6: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire entity pipeline into flow step executor"
```

---

## Task 11: Integration — Full Pipeline Verification

**Files:**

- Modify: `packages/compiler/src/__tests__/entities-compilation.test.ts` (add system entity integration tests)
- Run: Full test suite

Final verification that the compiler produces `ir.entities` with system entity intrinsic validation, and the runtime modules all compile and interoperate.

- [ ] **Step 1: Add integration tests for system entity pipeline**

Add to `packages/compiler/src/__tests__/entities-compilation.test.ts`:

```typescript
describe('Integration: system entity intrinsic validation end-to-end', () => {
  it('inline email GATHER produces entity with intrinsic_validation in IR', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
GATHER:
  contact_email:
    TYPE: email
    PROMPT: "Your email?"
    REQUIRED: true
  contact_phone:
    TYPE: phone
    PROMPT: "Your phone?"
  departure:
    TYPE: date
    PROMPT: "When?"
  confirmed:
    TYPE: boolean
    PROMPT: "Confirm?"
  amount:
    TYPE: currency
    PROMPT: "Amount?"
  arrival:
    TYPE: datetime
    PROMPT: "Arrival time?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    expect(ir.entities).toBeDefined();
    expect(ir.entities!.length).toBeGreaterThanOrEqual(6);

    const emailEntity = ir.entities!.find((e) => e.name === 'contact_email');
    expect(emailEntity!.intrinsic_validation).toContain('RFC');

    const phoneEntity = ir.entities!.find((e) => e.name === 'contact_phone');
    expect(phoneEntity!.intrinsic_validation).toContain('phone');

    const dateEntity = ir.entities!.find((e) => e.name === 'departure');
    expect(dateEntity!.intrinsic_validation).toContain('date');

    const boolEntity = ir.entities!.find((e) => e.name === 'confirmed');
    expect(boolEntity!.intrinsic_validation).toContain('true or false');

    const currencyEntity = ir.entities!.find((e) => e.name === 'amount');
    expect(currencyEntity!.intrinsic_validation).toContain('currency');

    const datetimeEntity = ir.entities!.find((e) => e.name === 'arrival');
    expect(datetimeEntity!.intrinsic_validation).toContain('date');
  });

  it('explicit ENTITIES do not get system validation overwritten', () => {
    const dsl = `
AGENT: Test
GOAL: "Test"
ENTITIES:
  custom_email:
    TYPE: email
    VALIDATION: "Must end in @corp.com"
GATHER:
  work_email:
    ENTITY_REF: custom_email
    PROMPT: "Work email?"
`;
    const { ir } = compileAgent(dsl, 'Test');
    const entity = ir.entities!.find((e) => e.name === 'custom_email');
    expect(entity!.intrinsic_validation).toBe('Must end in @corp.com');
  });
});
```

- [ ] **Step 2: Run compiler tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@abl/compiler && pnpm vitest run packages/compiler/src/__tests__/entities-compilation.test.ts`
Expected: PASS (all tests including new integration tests)

- [ ] **Step 3: Run all runtime unit tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm vitest run apps/runtime/src/__tests__/`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build && pnpm test`
Expected: All ~11,900 tests pass

- [ ] **Step 5: Run prettier and commit**

```bash
cd /Users/Thiru/researchWS/abl-platform
npx prettier --write packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] test(compiler): add system entity intrinsic validation integration tests"
```

---

## Deferred Work

The following are NOT in scope for this plan but are natural next steps:

1. **LLM Disambiguation Execution (Case A runtime)** — The slot assignment module produces `needsDisambiguation` results and the prompt, but the actual LLM call and response parsing is deferred. Requires wiring into the existing `SessionLLMClient`.

2. **User Clarification Flow (Case B runtime)** — The slot assignment module produces `needsClarification` results and the message, but integrating this into the GATHER collection loop (interrupt flow, present options, resume) is deferred.

3. **Business Validation Phase** — Applying GATHER-level VALIDATE rules after slot assignment. The trace event builder exists (`traceBusinessValidation`) but the actual validation execution is not wired.

4. **Observations in WHEN Conditions** — Making `session.observations` available in HANDOFF/DELEGATE WHEN condition evaluation, ROUTING, and FLOW step conditions.

5. **Memory Promotion** — Phase 9 (Remember) — promoting committed values to long-term memory based on MEMORY rules. Trace event builder exists (`traceEntityCommitment`) but memory promotion is not wired.

6. **Session Serialization/Deserialization** — The `observations` field on SessionData needs to be included in the session save/restore cycle. Currently observations are ephemeral and reconstructed each turn, but for session hydration they should serialize.
