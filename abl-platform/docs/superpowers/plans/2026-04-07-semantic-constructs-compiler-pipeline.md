# ABL Semantic Constructs — Compiler Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add top-level `ENTITIES` construct, `ENTITY_REF` on GATHER fields, and compiler lowering rules — so entities become first-class citizens in the IR, separate from NLU.

**Architecture:** New `ENTITIES` top-level AST/IR construct with unified entity type system. Parser gains `ENTITIES:` section and `ENTITY_REF` on GATHER fields. Compiler lowers explicit ENTITIES, NLU.entities (backward compat), and inline GATHER types into a single canonical `ir.entities` registry. GATHER fields with `ENTITY_REF` inherit entity semantics but cannot redefine them.

**Tech Stack:** TypeScript, vitest, @abl/core (parser + AST types), @abl/compiler (IR + compiler)

**Spec:** `docs/superpowers/specs/2026-04-07-abl-semantic-constructs-design.md`

**Scope:** This plan covers the Parser/Compiler pipeline only (spec sections 12.1–12.3). Runtime changes (slot assignment, LLM disambiguation, observation lifecycle) require a separate plan.

---

## File Structure

### New Files

| File                                                           | Responsibility                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core/src/__tests__/parser-entities-section.test.ts`  | Parser tests for ENTITIES section and entity_ref on GATHER                                |
| `packages/compiler/src/__tests__/entities-compilation.test.ts` | Compiler tests for entity lowering, entity_ref resolution, exclusivity, inline decoupling |

### Modified Files

| File                                             | Changes                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`         | Add `EntityDefinition` interface, `entities` on `AgentBasedDocument`, `entityRef` on `GatherField` and `FlowGatherField`        |
| `packages/core/src/parser/agent-based-parser.ts` | Parse `ENTITIES:` section, parse `entity_ref` on GATHER fields (top-level + flow)                                               |
| `packages/compiler/src/platform/ir/schema.ts`    | Add `EntityDefinitionIR` interface, `EntityType` union, `entities` on `AgentIR`, `entity_ref` on `GatherField`                  |
| `packages/compiler/src/platform/ir/compiler.ts`  | Entity lowering from all 3 sources, entity_ref resolution, exclusivity check, inline type decoupling, update mergeNLUIntoGather |

---

## Workstream 1: Types & Schema (Tasks 1–2)

### Task 1: IR Schema — EntityDefinitionIR and top-level entities on AgentIR

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (create)

- [ ] **Step 1: Write the failing test — EntityDefinitionIR type exists and ir.entities is populated**

Create `packages/compiler/src/__tests__/entities-compilation.test.ts`:

```typescript
/**
 * Entity compilation tests — semantic constructs redesign.
 *
 * Verifies:
 * - Top-level ENTITIES compile to ir.entities
 * - NLU.entities lower into ir.entities
 * - Conflict detection between ENTITIES and NLU.entities
 * - ENTITY_REF resolution on GATHER fields
 * - ENTITY_REF exclusivity (compile error if TYPE + entity_ref)
 * - Inline GATHER TYPE produces anonymous entity in ir.entities
 * - System entity types have built-in definitions
 */

import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';
import type { EntityDefinitionIR } from '../platform/ir/schema.js';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

function compileWithErrors(dsl: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  return compileABLtoIR([parseResult.document!]);
}

describe('Top-level ENTITIES compilation', () => {
  test('ENTITIES section compiles to ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeDefined();
    expect(agent.entities).toHaveLength(1);

    const entity = agent.entities![0];
    expect(entity.name).toBe('cabin_class');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['economy', 'business', 'first']);
    expect(entity.source).toBe('explicit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `EntityDefinitionIR` type does not exist, `ir.entities` is undefined

- [ ] **Step 3: Add EntityDefinitionIR and EntityType to IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add after the existing `NLUEmbeddingsConfig` interface (around line 1696):

```typescript
// =============================================================================
// CANONICAL ENTITY REGISTRY
// =============================================================================

/**
 * Unified entity type system — merges GATHER field types and NLU entity types.
 *
 * System types (email, phone, date, etc.) have built-in intrinsic validation.
 * Custom types (enum, pattern) are user-defined.
 */
export type EntityType =
  | 'string'
  | 'text'
  | 'free_text'
  | 'number'
  | 'integer'
  | 'float'
  | 'currency'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'email'
  | 'phone'
  | 'enum'
  | 'pattern'
  | 'location';

/**
 * Canonical entity definition in the IR entity registry.
 *
 * Every entity in the system (from ENTITIES, NLU.entities, or inline GATHER TYPE)
 * is lowered into this format. The `source` field tracks provenance.
 */
export interface EntityDefinitionIR {
  /** Entity name — unique within the agent */
  name: string;
  /** Unified entity type */
  type: EntityType;
  /** Allowed values for enum entities */
  values?: string[];
  /** Synonym map — canonical value → alternative forms */
  synonyms?: Record<string, string[]>;
  /** Regex pattern for pattern-type entities */
  pattern?: string;
  /** Intrinsic validation expression (entity-level, not business-level) */
  intrinsic_validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
  /** Where this entity was defined — for debugging and migration tooling */
  source: 'explicit' | 'nlu_lowered' | 'gather_inline';
}
```

Add `entities` to the `AgentIR` interface (around line 314, after `nlu?`):

```typescript
  /** Canonical entity registry — all entities from ENTITIES, NLU.entities, and inline GATHER */
  entities?: EntityDefinitionIR[];
```

Add `entity_ref` to the `GatherField` interface (around line 1133, after `name`):

```typescript
  /** Reference to a named entity in ir.entities — inherits type, values, synonyms, intrinsic validation */
  entity_ref?: string;
```

Add `entity_ref` to the `FlowGatherField` interface (around line 1971, after `name`):

```typescript
  /** Reference to a named entity in ir.entities */
  entity_ref?: string;
```

- [ ] **Step 4: Run test to verify it still fails (type exists but ir.entities not populated yet)**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `agent.entities` is undefined (compiler doesn't populate it yet)

- [ ] **Step 5: Run prettier and build to verify types compile**

Run: `npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/entities-compilation.test.ts && pnpm build --filter=@abl/compiler`

- [ ] **Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): add EntityDefinitionIR type and entities field on AgentIR"
```

---

### Task 2: AST Types — EntityDefinition, entities on document, entityRef on GatherField

**Files:**

- Modify: `packages/core/src/types/agent-based.ts`

- [ ] **Step 1: Add EntityDefinition interface to AST types**

In `packages/core/src/types/agent-based.ts`, add before the `NLUIntentDefinition` interface (around line 1331):

```typescript
// =============================================================================
// ENTITY DEFINITIONS (top-level ENTITIES: section)
// =============================================================================

/**
 * Entity definition from the top-level ENTITIES: section.
 *
 * Entities define reusable semantic types with extraction methods and
 * intrinsic validation. They are consumed by both NLU (for recognition)
 * and GATHER (for collection via entity_ref).
 */
export interface EntityDefinition {
  /** Entity name — must be unique within the agent */
  name: string;
  /** Entity type from the unified type system */
  type:
    | 'string'
    | 'text'
    | 'free_text'
    | 'number'
    | 'integer'
    | 'float'
    | 'currency'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'email'
    | 'phone'
    | 'enum'
    | 'pattern'
    | 'location';
  /** Allowed values for enum entities */
  values?: string[];
  /** Synonym map — canonical value → alternative forms */
  synonyms?: Record<string, string[]>;
  /** Regex pattern for pattern-type entities */
  pattern?: string;
  /** Intrinsic validation expression */
  validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
}
```

- [ ] **Step 2: Add entities to AgentBasedDocument**

In `AgentBasedDocument` interface (around line 1296, after `nlu?`):

```typescript
  /** Top-level entity definitions (from ENTITIES: section) */
  entities?: EntityDefinition[];
```

- [ ] **Step 3: Add entityRef to GatherField**

In `GatherField` interface (around line 657, after `name`):

```typescript
  /** Reference to a named entity — inherits type, values, synonyms, validation from the entity */
  entityRef?: string;
```

- [ ] **Step 4: Add entityRef to FlowGatherField**

In `FlowGatherField` interface (around line 193, after `name`):

```typescript
  /** Reference to a named entity */
  entityRef?: string;
```

- [ ] **Step 5: Run prettier and build**

Run: `npx prettier --write packages/core/src/types/agent-based.ts && pnpm build --filter=@abl/core`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/agent-based.ts
git commit -m "[ABLP-2] feat(core): add EntityDefinition type, entities on document, entityRef on gather fields"
```

---

## Workstream 2: Parser (Tasks 3–4)

### Task 3: Parser — Parse ENTITIES section

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts`
- Test: `packages/core/src/__tests__/parser-entities-section.test.ts` (create)

- [ ] **Step 1: Write the failing test — ENTITIES section parsing**

Create `packages/core/src/__tests__/parser-entities-section.test.ts`:

```typescript
/**
 * Parser tests for the top-level ENTITIES section and ENTITY_REF on GATHER.
 *
 * Verifies:
 * - ENTITIES section parses enum, pattern, location, date entities
 * - Entity synonyms parse correctly
 * - Entity sensitive flag parses
 * - ENTITY_REF parses on top-level GATHER fields
 * - ENTITY_REF parses on FLOW GATHER fields
 * - ENTITY_REF and TYPE cannot coexist (parser allows; compiler rejects)
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('ENTITIES section parsing', () => {
  test('parses enum entity with values', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toBeDefined();
    expect(result.document!.entities).toHaveLength(1);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('cabin_class');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['economy', 'business', 'first']);
  });

  test('parses pattern entity with regex', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  booking_ref:
    TYPE: pattern
    PATTERN: "[A-Z]{2}\\d{6}"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('booking_ref');
    expect(entity.type).toBe('pattern');
    expect(entity.pattern).toBe('[A-Z]{2}\\d{6}');
  });

  test('parses entity with synonyms', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR, GBP]
    SYNONYMS:
      USD: [usd, dollars, bucks]
      EUR: [eur, euros]
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('currency_code');
    expect(entity.synonyms).toEqual({
      USD: ['usd', 'dollars', 'bucks'],
      EUR: ['eur', 'euros'],
    });
  });

  test('parses entity with sensitive flag', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  ssn:
    TYPE: pattern
    PATTERN: "\\d{3}-\\d{2}-\\d{4}"
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('ssn');
    expect(entity.sensitive).toBe(true);
  });

  test('parses multiple entities', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR]
  travel_date:
    TYPE: date
  passenger_email:
    TYPE: email
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toHaveLength(3);

    expect(result.document!.entities![0].name).toBe('airport_code');
    expect(result.document!.entities![0].type).toBe('enum');
    expect(result.document!.entities![1].name).toBe('travel_date');
    expect(result.document!.entities![1].type).toBe('date');
    expect(result.document!.entities![2].name).toBe('passenger_email');
    expect(result.document!.entities![2].type).toBe('email');
    expect(result.document!.entities![2].sensitive).toBe(true);
  });

  test('parses entity with intrinsic validation', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  phone_number:
    TYPE: phone
    VALIDATION: "\\+?[0-9]{10,14}"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const entity = result.document!.entities![0];
    expect(entity.name).toBe('phone_number');
    expect(entity.type).toBe('phone');
    expect(entity.validation).toBe('\\+?[0-9]{10,14}');
  });

  test('ENTITIES section absent yields undefined', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.entities).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/parser-entities-section.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `document.entities` is undefined (parser doesn't handle ENTITIES: yet)

- [ ] **Step 3: Implement parseEntitiesSection in the parser**

In `packages/core/src/parser/agent-based-parser.ts`, add a `parseEntitiesSection` function. Follow the same pattern as `parseNLUSection` but simpler (no intents/categories/glossary sub-sections).

Add the function near the other section parsers (after `parseLookupTables` or similar):

```typescript
/**
 * Parse top-level ENTITIES: section.
 *
 * Syntax:
 *   ENTITIES:
 *     entity_name:
 *       TYPE: enum | pattern | date | ...
 *       VALUES: [a, b, c]
 *       SYNONYMS:
 *         a: [alias1, alias2]
 *       PATTERN: "regex"
 *       VALIDATION: "rule"
 *       SENSITIVE: true
 */
function parseEntitiesSection(state: ParserState): EntityDefinition[] {
  const entities: EntityDefinition[] = [];
  let currentEntity: Partial<EntityDefinition> | null = null;
  let currentSynonyms: Record<string, string[]> | null = null;
  const baseIndent = state.currentIndent;

  function flushEntity() {
    if (currentEntity && currentEntity.name) {
      if (currentSynonyms && Object.keys(currentSynonyms).length > 0) {
        currentEntity.synonyms = currentSynonyms;
      }
      entities.push({
        name: currentEntity.name,
        type: (currentEntity.type as EntityDefinition['type']) || 'string',
        values: currentEntity.values,
        synonyms: currentEntity.synonyms,
        pattern: currentEntity.pattern,
        validation: currentEntity.validation,
        sensitive: currentEntity.sensitive,
      });
    }
    currentEntity = null;
    currentSynonyms = null;
  }

  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // End of section: unindented line or new top-level section
    if (trimmed && indent <= baseIndent && state.pos > 0) {
      break;
    }

    if (!trimmed) {
      state.pos++;
      continue;
    }

    // Entity name line: "  entity_name:" at first indent level
    const entityNameMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (entityNameMatch && indent === baseIndent + 2) {
      flushEntity();
      currentEntity = { name: entityNameMatch[1] };
      currentSynonyms = null;
      state.pos++;
      continue;
    }

    // Property lines inside an entity
    if (currentEntity) {
      const kvMatch = trimmed.match(/^([A-Z_]+):\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();

        switch (key) {
          case 'TYPE':
            currentEntity.type = value as EntityDefinition['type'];
            break;
          case 'VALUES':
            currentEntity.values = value
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);
            break;
          case 'PATTERN':
            currentEntity.pattern = value.replace(/^["']|["']$/g, '');
            break;
          case 'VALIDATION':
            currentEntity.validation = value.replace(/^["']|["']$/g, '');
            break;
          case 'SENSITIVE':
            currentEntity.sensitive = value === 'true' || value === 'yes';
            break;
          case 'SYNONYMS':
            currentSynonyms = {};
            break;
          default:
            // If inside SYNONYMS block, treat as synonym entry
            if (currentSynonyms !== null) {
              const synKey = key;
              currentSynonyms[synKey] = value
                .replace(/^\[|\]$/g, '')
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean);
            }
            break;
        }
        state.pos++;
        continue;
      }

      // Lowercase synonym entries (within SYNONYMS block)
      if (currentSynonyms !== null) {
        const synMatch = trimmed.match(/^([a-zA-Z0-9_]+):\s*\[(.*)\]/);
        if (synMatch) {
          currentSynonyms[synMatch[1]] = synMatch[2]
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
          state.pos++;
          continue;
        }
      }
    }

    state.pos++;
  }

  flushEntity();
  return entities;
}
```

Then add the `ENTITIES:` handler in `parseDocument()` — in the top-level section switch (around the NLU handler area):

```typescript
} else if (line === 'ENTITIES:') {
  doc.entities = parseEntitiesSection(state);
```

Import the `EntityDefinition` type at the top of the file if not already available (it's in the same package so it should be accessible).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/parser-entities-section.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS — all 7 tests

- [ ] **Step 5: Run the full core test suite to check for regressions**

Run: `cd packages/core && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser-entities-section.test.ts
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser-entities-section.test.ts
git commit -m "[ABLP-2] feat(core): parse top-level ENTITIES section"
```

---

### Task 4: Parser — Parse entity_ref on GATHER fields

**Files:**

- Modify: `packages/core/src/parser/agent-based-parser.ts`
- Test: `packages/core/src/__tests__/parser-entities-section.test.ts` (append)

- [ ] **Step 1: Write the failing test — entity_ref on GATHER**

Append to `packages/core/src/__tests__/parser-entities-section.test.ts`:

```typescript
describe('ENTITY_REF parsing on GATHER fields', () => {
  test('parses entity_ref on top-level GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
    REQUIRED: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.name).toBe('cabin');
    expect(field.entityRef).toBe('cabin_class');
    expect(field.prompt).toBe('What cabin class?');
    expect(field.required).toBe(true);
  });

  test('entity_ref field with no TYPE still gets default type', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.entityRef).toBe('cabin_class');
    // Parser still sets default type 'string' — compiler will override from entity
    expect(field.type).toBe('string');
  });

  test('entity_ref coexists with collection policy properties', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
GATHER:
  work_email:
    ENTITY_REF: email
    PROMPT: "Your work email?"
    REQUIRED: true
    VALIDATE: "must end with @company.com"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 3
    RETRY_PROMPT: "Please enter your work email."
    SENSITIVE: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.gather[0];
    expect(field.entityRef).toBe('email');
    expect(field.validate).toBe('must end with @company.com');
    expect(field.validationProcess).toBe('LLM');
    expect(field.maxRetries).toBe(3);
    expect(field.retryPrompt).toBe('Please enter your work email.');
    expect(field.sensitive).toBe(true);
  });

  test('entity_ref on FLOW GATHER field', () => {
    const dsl = `AGENT: Test
GOAL: "Test agent"
FLOW:
  collect:
    REASONING: false
    PROMPT: "Collecting info"
    GATHER:
      - cabin:
          ENTITY_REF: cabin_class
          PROMPT: "Cabin?"
    NEXT: done
  done:
    REASONING: false
    RESPOND: "Done"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['collect'];
    const field = step.gather!.fields[0];
    expect(field.name).toBe('cabin');
    expect(field.entityRef).toBe('cabin_class');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/parser-entities-section.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `field.entityRef` is undefined

- [ ] **Step 3: Add entity_ref parsing to GATHER parser**

In `packages/core/src/parser/agent-based-parser.ts`, in the `parseGather()` function's switch statement (the `key.toLowerCase()` switch around line 2964), add a new case:

```typescript
case 'entity_ref':
  currentField.entityRef = value;
  break;
```

Then in the FLOW GATHER parser (around line 978 in the `gatherProps` array), add `'ENTITY_REF'` to the array. In the corresponding switch statement, add:

```typescript
case 'ENTITY_REF':
  currentGatherField.entityRef = value;
  break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/parser-entities-section.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS — all tests including entity_ref

- [ ] **Step 5: Run full core test suite**

Run: `cd packages/core && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser-entities-section.test.ts
git add packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser-entities-section.test.ts
git commit -m "[ABLP-2] feat(core): parse ENTITY_REF on GATHER fields (top-level and flow)"
```

---

## Workstream 3: Compiler Lowering (Tasks 5–9)

### Task 5: Compiler — Compile ENTITIES to ir.entities

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write the failing test — ENTITIES compile to ir.entities**

The test from Task 1 Step 1 already covers the basic case. Now add more specific tests to `entities-compilation.test.ts`:

```typescript
describe('ENTITIES compilation to ir.entities', () => {
  test('enum entity with synonyms compiles correctly', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR, GBP]
    SYNONYMS:
      USD: [usd, dollars, bucks]
      EUR: [eur, euros]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(1);

    const entity = agent.entities![0];
    expect(entity.name).toBe('currency_code');
    expect(entity.type).toBe('enum');
    expect(entity.values).toEqual(['USD', 'EUR', 'GBP']);
    expect(entity.synonyms).toEqual({
      USD: ['usd', 'dollars', 'bucks'],
      EUR: ['eur', 'euros'],
    });
    expect(entity.source).toBe('explicit');
  });

  test('pattern entity with sensitive flag compiles correctly', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  ssn:
    TYPE: pattern
    PATTERN: "\\d{3}-\\d{2}-\\d{4}"
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const entity = agent.entities![0];

    expect(entity.name).toBe('ssn');
    expect(entity.type).toBe('pattern');
    expect(entity.pattern).toBe('\\d{3}-\\d{2}-\\d{4}');
    expect(entity.sensitive).toBe(true);
    expect(entity.source).toBe('explicit');
  });

  test('multiple entities compile in order', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR]
  travel_date:
    TYPE: date
  email_address:
    TYPE: email
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(3);
    expect(agent.entities![0].name).toBe('airport_code');
    expect(agent.entities![1].name).toBe('travel_date');
    expect(agent.entities![2].name).toBe('email_address');
  });

  test('agent with no ENTITIES has undefined ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `agent.entities` is undefined

- [ ] **Step 3: Implement compileEntities and wire it into compileAgentToIR**

In `packages/compiler/src/platform/ir/compiler.ts`, add a `compileEntities` function (near the other component compilers, after `compileGather`):

```typescript
/**
 * Compile top-level ENTITIES section into canonical EntityDefinitionIR[].
 */
function compileEntities(
  entities: NonNullable<AgentBasedDocument['entities']>,
): EntityDefinitionIR[] {
  return entities.map((e) => ({
    name: e.name,
    type: e.type as EntityType,
    values: e.values,
    synonyms: e.synonyms,
    pattern: e.pattern,
    intrinsic_validation: e.validation,
    sensitive: e.sensitive,
    source: 'explicit' as const,
  }));
}
```

In `compileAgentToIR`, after the IR object is built (around line 649), add:

```typescript
// Compile top-level ENTITIES into canonical entity registry
if (doc.entities && doc.entities.length > 0) {
  ir.entities = compileEntities(doc.entities);
}
```

Import the `EntityDefinitionIR` and `EntityType` types at the top of compiler.ts:

```typescript
import type { EntityDefinitionIR, EntityType } from './schema.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Build and format**

Run: `npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts && pnpm build --filter=@abl/compiler`

- [ ] **Step 6: Commit**

```bash
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): compile top-level ENTITIES to ir.entities"
```

---

### Task 6: Compiler — Lower NLU.entities into ir.entities with conflict detection

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `entities-compilation.test.ts`:

```typescript
describe('NLU.entities lowering to ir.entities', () => {
  test('NLU entities lower into ir.entities with source nlu_lowered', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book", "fly"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.length).toBeGreaterThanOrEqual(1);

    const entity = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('enum');
    expect(entity!.values).toEqual(['economy', 'business', 'first']);
    expect(entity!.source).toBe('nlu_lowered');
  });

  test('NLU entities still appear in ir.nlu.entities for backward compat', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    // Still in nlu.entities for backward compat
    expect(agent.nlu!.entities).toHaveLength(1);
    expect(agent.nlu!.entities[0].name).toBe('cabin_class');
    // Also in top-level entities
    expect(agent.entities!.find((e) => e.name === 'cabin_class')).toBeDefined();
  });

  test('ENTITIES and NLU.entities merge into one registry', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business]
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.entities).toHaveLength(2);

    const airport = agent.entities!.find((e) => e.name === 'airport_code');
    expect(airport!.source).toBe('explicit');
    const cabin = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(cabin!.source).toBe('nlu_lowered');
  });

  test('conflict: same entity name in ENTITIES and NLU.entities emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, premium]
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find((e) => e.message.includes('cabin_class'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('defined in both ENTITIES and NLU');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — NLU entities not in ir.entities

- [ ] **Step 3: Implement NLU entity lowering and conflict detection**

In `packages/compiler/src/platform/ir/compiler.ts`, add a function to lower NLU entities:

```typescript
/**
 * Lower NLU.entities into the canonical entity registry.
 * Detects conflicts with explicitly defined ENTITIES.
 */
function lowerNLUEntitiesToRegistry(
  registry: EntityDefinitionIR[],
  nluEntities: NLUIRConfig['entities'],
  agentName: string,
): CompilationError[] {
  const errors: CompilationError[] = [];

  for (const nluEntity of nluEntities) {
    const existing = registry.find((e) => e.name === nluEntity.name);
    if (existing && existing.source === 'explicit') {
      errors.push({
        agent: agentName,
        message:
          `Entity "${nluEntity.name}" is defined in both ENTITIES and NLU.entities. ` +
          `Remove the duplicate from NLU.entities or use the same definition in ENTITIES only.`,
        type: 'compilation',
      });
      continue;
    }
    if (!existing) {
      registry.push({
        name: nluEntity.name,
        type: nluEntity.type as EntityType,
        values: nluEntity.values,
        synonyms: nluEntity.synonyms,
        pattern: nluEntity.pattern,
        intrinsic_validation: nluEntity.validation,
        sensitive: nluEntity.sensitive,
        source: 'nlu_lowered',
      });
    }
  }

  return errors;
}
```

In `compileAgentToIR`, after entity compilation and NLU compilation, add the lowering step:

```typescript
// Lower NLU.entities into canonical entity registry
if (ir.nlu?.entities && ir.nlu.entities.length > 0) {
  if (!ir.entities) ir.entities = [];
  const loweringErrors = lowerNLUEntitiesToRegistry(ir.entities, ir.nlu.entities, doc.name);
  for (const err of loweringErrors) {
    compilationErrors.push(err);
  }
}
```

Note: `compilationErrors` must be captured from the try-catch in `compileABLtoIR` — check where errors are accumulated. If `compileAgentToIR` doesn't have a local errors array, the conflict detection errors need to be surfaced via the existing error mechanism. Read the existing error handling pattern to determine the right approach.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run full compiler test suite to check for regressions**

Run: `cd packages/compiler && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): lower NLU.entities into ir.entities with conflict detection"
```

---

### Task 7: Compiler — entity_ref resolution in compileGather

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `entities-compilation.test.ts`:

```typescript
describe('ENTITY_REF resolution in GATHER', () => {
  test('entity_ref inherits type and values from entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.name).toBe('cabin');
    expect(field.entity_ref).toBe('cabin_class');
    expect(field.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });

  test('entity_ref inherits synonyms from entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  currency_code:
    TYPE: enum
    VALUES: [USD, EUR]
    SYNONYMS:
      USD: [dollars, bucks]
      EUR: [euros]
GATHER:
  payout_currency:
    ENTITY_REF: currency_code
    PROMPT: "Which currency?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('currency_code');
    expect(field.synonyms).toEqual({ USD: ['dollars', 'bucks'], EUR: ['euros'] });
  });

  test('entity_ref preserves collection policy on GATHER field', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  email_address:
    TYPE: email
GATHER:
  work_email:
    ENTITY_REF: email_address
    PROMPT: "Your work email?"
    VALIDATE: "must end with @company.com"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 3
    SENSITIVE: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('email_address');
    expect(field.type).toBe('email');
    expect(field.validation).toBeDefined();
    expect(field.validation!.rule).toBe('must end with @company.com');
    expect(field.validation!.type).toBe('llm');
    expect(field.validation!.max_retries).toBe(3);
    expect(field.sensitive).toBe(true);
  });

  test('entity_ref to nonexistent entity emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin:
    ENTITY_REF: nonexistent_entity
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find((e) => e.message.includes('nonexistent_entity'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('not found in entity registry');
  });

  test('entity_ref works with NLU-lowered entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');
    const field = agent.gather.fields[0];

    expect(field.entity_ref).toBe('cabin_class');
    expect(field.type).toBe('enum');
    expect(field.enum_values).toEqual(['economy', 'business', 'first']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — entity_ref not resolved

- [ ] **Step 3: Implement entity_ref resolution in compileGather**

In `packages/compiler/src/platform/ir/compiler.ts`, modify `compileGather` (and the flow step gather compilation) to resolve entity_ref.

The entity registry must be passed to `compileGather`. Modify the function signature:

```typescript
function compileGather(
  doc: AgentBasedDocument,
  entityRegistry?: EntityDefinitionIR[],
): GatherConfig;
```

Inside `compileGather`, at the start of the field mapping loop, add entity_ref resolution:

```typescript
// Resolve entity_ref — inherit type, values, synonyms from entity
if (f.entityRef) {
  const entity = entityRegistry?.find((e) => e.name === f.entityRef);
  if (!entity) {
    throw new Error(
      `[${doc.name}] GATHER field "${f.name}" references entity "${f.entityRef}" ` +
        `which was not found in the entity registry. Define it in ENTITIES or NLU.entities.`,
    );
  }
  // Override the field type with entity type
  fieldType = entity.type;
  // Inherit enum values and synonyms
  if (entity.values) {
    enumValues = entity.values;
  }
  if (entity.synonyms) {
    fieldSynonyms = entity.synonyms;
  }
  // Inherit sensitive flag if not overridden on GATHER
  if (entity.sensitive && f.sensitive === undefined) {
    fieldSensitive = entity.sensitive;
  }
}
```

Set `entity_ref` on the compiled `GatherField`:

```typescript
entity_ref: f.entityRef,
```

Pass the entity registry from `compileAgentToIR` to `compileGather`:

```typescript
gather: compileGather(doc, ir.entities),
```

**Important:** The entity registry must be built BEFORE compileGather runs. Ensure the ordering in `compileAgentToIR` is:

1. Compile ENTITIES → ir.entities
2. Compile NLU → ir.nlu (including lowering NLU.entities to ir.entities)
3. Compile GATHER (with ir.entities passed in)

Apply the same pattern to flow step GATHER compilation in `compileFlow`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run full compiler test suite**

Run: `cd packages/compiler && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): resolve ENTITY_REF on GATHER fields from entity registry"
```

---

### Task 8: Compiler — entity_ref exclusivity check

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `entities-compilation.test.ts`:

```typescript
describe('ENTITY_REF exclusivity', () => {
  test('entity_ref with TYPE emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    TYPE: string
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('TYPE'),
    );
    expect(err).toBeDefined();
  });

  test('entity_ref with OPTIONS emits compile error', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    OPTIONS: [economy, first]
    PROMPT: "Cabin?"
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors.length).toBeGreaterThan(0);
    const err = output.compilation_errors.find(
      (e) => e.message.includes('ENTITY_REF') && e.message.includes('redefine'),
    );
    expect(err).toBeDefined();
  });

  test('entity_ref WITHOUT entity-level props is valid', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
    REQUIRED: true
    VALIDATE: "must not be empty"
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 2
`;
    const output = compileWithErrors(dsl);
    expect(output.compilation_errors).toHaveLength(0);
    const agent = output.agents['TestAgent'];
    expect(agent.gather.fields[0].entity_ref).toBe('cabin_class');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — no compile error emitted for entity_ref + TYPE

- [ ] **Step 3: Implement exclusivity check**

In the entity_ref resolution code added in Task 7, before resolving the entity, add the exclusivity check:

```typescript
if (f.entityRef) {
  // Exclusivity: entity_ref cannot coexist with entity-level properties
  const entityProps: string[] = [];
  if (f.type && f.type !== 'string') entityProps.push('TYPE');
  if (f.options && f.options.length > 0) entityProps.push('OPTIONS');
  // Note: The parser defaults type to 'string', so we only flag if explicitly set to something else

  if (entityProps.length > 0) {
    throw new Error(
      `[${doc.name}] GATHER field "${f.name}" uses ENTITY_REF but also defines entity-level ` +
        `properties (${entityProps.join(', ')}). Remove ${entityProps.join('/')} or remove ENTITY_REF. ` +
        `When using ENTITY_REF, the entity definition provides type, values, and synonyms.`,
    );
  }
  // ... rest of entity_ref resolution
}
```

**Note:** The parser defaults `GatherField.type` to `'string'`. We need to distinguish "user explicitly wrote TYPE: string" from "parser default." Two approaches:

1. Check if type is the default 'string' and allow it (simpler, current approach above)
2. Add a flag in the parser to track explicit vs default type (more correct but more invasive)

Go with approach 1 for now — only flag non-default types. If the user writes `TYPE: string` with entity_ref, it won't error (acceptable edge case; the entity type will override anyway).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): enforce ENTITY_REF exclusivity — compile error if TYPE/OPTIONS redefined"
```

---

### Task 9: Compiler — Inline GATHER TYPE to anonymous entity

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `entities-compilation.test.ts`:

```typescript
describe('Inline GATHER TYPE to anonymous entity', () => {
  test('inline TYPE: enum produces anonymous entity in ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  cabin_class:
    TYPE: enum
    OPTIONS: [economy, business, first]
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Anonymous entity should be created
    expect(agent.entities).toBeDefined();
    const entity = agent.entities!.find((e) => e.name === 'cabin_class');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('enum');
    expect(entity!.values).toEqual(['economy', 'business', 'first']);
    expect(entity!.source).toBe('gather_inline');
  });

  test('inline TYPE: email produces anonymous entity with system type', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  user_email:
    TYPE: email
    PROMPT: "Your email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    const entity = agent.entities!.find((e) => e.name === 'user_email');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('email');
    expect(entity!.source).toBe('gather_inline');
  });

  test('inline TYPE: date produces anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  departure_date:
    TYPE: date
    PROMPT: "When?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    const entity = agent.entities!.find((e) => e.name === 'departure_date');
    expect(entity).toBeDefined();
    expect(entity!.type).toBe('date');
    expect(entity!.source).toBe('gather_inline');
  });

  test('GATHER field with entity_ref does NOT create anonymous entity', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
GATHER:
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "Cabin?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Only the explicit entity, no anonymous entity for 'cabin'
    expect(agent.entities!.filter((e) => e.source === 'gather_inline')).toHaveLength(0);
    expect(agent.entities!.filter((e) => e.source === 'explicit')).toHaveLength(1);
  });

  test('mixed: explicit ENTITIES + inline GATHER types all in ir.entities', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX]
GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: "From?"
  departure_date:
    TYPE: date
    PROMPT: "When?"
  passenger_email:
    TYPE: email
    PROMPT: "Email?"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    expect(agent.entities).toHaveLength(3);
    expect(agent.entities!.find((e) => e.name === 'airport_code')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'departure_date')!.source).toBe('gather_inline');
    expect(agent.entities!.find((e) => e.name === 'passenger_email')!.source).toBe('gather_inline');
  });

  test('existing ABL with no ENTITIES still works (backward compat)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  name:
    PROMPT: "Your name?"
    TYPE: string
  email:
    PROMPT: "Email?"
    TYPE: email
    VALIDATE: "^[^\\\\s@]+@[^\\\\s@]+\\\\.[^\\\\s@]+$"
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // Should compile without errors — anonymous entities created
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'name')).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'email')).toBeDefined();

    // GATHER fields still work as before
    expect(agent.gather.fields[0].name).toBe('name');
    expect(agent.gather.fields[0].type).toBe('string');
    expect(agent.gather.fields[1].name).toBe('email');
    expect(agent.gather.fields[1].validation).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — no anonymous entities created

- [ ] **Step 3: Implement anonymous entity creation for inline GATHER types**

In `compileGather`, after processing each field (and after entity_ref resolution), add logic to create anonymous entities for fields without entity_ref:

```typescript
// For fields without entity_ref, create a synthetic anonymous entity
if (!f.entityRef && f.type) {
  if (!entityRegistry) entityRegistry = [];
  const existingAnon = entityRegistry.find(
    (e) => e.name === f.name && e.source === 'gather_inline',
  );
  if (!existingAnon) {
    entityRegistry.push({
      name: f.name,
      type: (f.type || 'string') as EntityType,
      values: f.options,
      sensitive: f.sensitive,
      source: 'gather_inline',
    });
  }
}
```

**Important:** The `entityRegistry` array is passed by reference from `compileAgentToIR`. The anonymous entities added in `compileGather` will be visible in the parent scope's `ir.entities`. Make sure `ir.entities` is initialized as an empty array before passing to `compileGather` if it doesn't exist yet:

```typescript
// In compileAgentToIR, before calling compileGather:
if (!ir.entities) ir.entities = [];
```

After `compileGather` returns, if `ir.entities` is still empty (no entities from any source), set it to `undefined` to keep the IR clean for agents with no entities at all:

```typescript
if (ir.entities && ir.entities.length === 0) {
  ir.entities = undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run FULL compiler test suite — this is the most critical backward compat check**

Run: `cd packages/compiler && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All existing tests pass. The anonymous entity creation must not break any existing test.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): decouple inline GATHER TYPE into anonymous entity in ir.entities"
```

---

## Workstream 4: Integration & Backward Compatibility (Task 10)

### Task 10: Update mergeNLUIntoGather and full backward compatibility

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Test: `packages/compiler/src/__tests__/entities-compilation.test.ts` (append)

- [ ] **Step 1: Write integration tests**

Append to `entities-compilation.test.ts`:

```typescript
describe('Integration: NLU + ENTITIES + GATHER + entity_ref', () => {
  test('full canonical model: ENTITIES + NLU intents + GATHER entity_ref', () => {
    const dsl = `
AGENT: FlightAgent
GOAL: "Help book flights"
ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR, SFO]
    SYNONYMS:
      JFK: [kennedy, new york]
      LAX: [los angeles]
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book", "fly", "flight"]
GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying from?"
    REQUIRED: true
  destination:
    ENTITY_REF: airport_code
    PROMPT: "Where are you flying to?"
    REQUIRED: true
  cabin:
    ENTITY_REF: cabin_class
    PROMPT: "What cabin class?"
    ACTIVATION: optional
  departure_date:
    TYPE: date
    PROMPT: "When do you want to fly?"
    REQUIRED: true
`;
    const agent = compileAgent(dsl, 'FlightAgent');

    // Entity registry has all entities
    expect(agent.entities).toBeDefined();
    expect(agent.entities!.find((e) => e.name === 'airport_code')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'cabin_class')!.source).toBe('explicit');
    expect(agent.entities!.find((e) => e.name === 'departure_date')!.source).toBe('gather_inline');

    // GATHER fields resolve entity_ref correctly
    const origin = agent.gather.fields.find((f) => f.name === 'origin')!;
    expect(origin.entity_ref).toBe('airport_code');
    expect(origin.type).toBe('enum');
    expect(origin.enum_values).toEqual(['JFK', 'LAX', 'LHR', 'SFO']);
    expect(origin.synonyms).toEqual({ JFK: ['kennedy', 'new york'], LAX: ['los angeles'] });

    const destination = agent.gather.fields.find((f) => f.name === 'destination')!;
    expect(destination.entity_ref).toBe('airport_code');
    expect(destination.type).toBe('enum');

    const cabin = agent.gather.fields.find((f) => f.name === 'cabin')!;
    expect(cabin.entity_ref).toBe('cabin_class');
    expect(cabin.type).toBe('enum');
    expect(cabin.enum_values).toEqual(['economy', 'business', 'first']);

    // Inline type still works
    const date = agent.gather.fields.find((f) => f.name === 'departure_date')!;
    expect(date.entity_ref).toBeUndefined();
    expect(date.type).toBe('date');

    // NLU intents still compiled
    expect(agent.nlu!.intents).toHaveLength(1);
  });

  test('legacy ABL: NLU entities + GATHER name matching still works', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book"]
  entities:
    - NAME: cabin_class
      TYPE: enum
      VALUES: [economy, business, first]
      SYNONYMS:
        economy: [coach, standard]
GATHER:
  cabin_class:
    PROMPT: "Cabin?"
    TYPE: enum
    OPTIONS: [economy, business, first]
`;
    const agent = compileAgent(dsl, 'TestAgent');

    // mergeNLUIntoGather should still work
    const field = agent.gather.fields[0];
    expect(field.name).toBe('cabin_class');
    expect(field.synonyms).toEqual({ economy: ['coach', 'standard'] });

    // Entity also in registry
    expect(agent.entities!.find((e) => e.name === 'cabin_class')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (or identify issues)**

Run: `cd packages/compiler && npx vitest run src/__tests__/entities-compilation.test.ts --reporter=verbose 2>&1 | tail -30`

If there are failures, they indicate ordering or interaction issues between the new entity registry and the existing `mergeNLUIntoGather`. Fix as needed.

- [ ] **Step 3: Ensure mergeNLUIntoGather works with the new entity registry**

The existing `mergeNLUIntoGather` function matches GATHER fields to NLU entities by name and merges synonyms/values. This should still work because:

- NLU entities are still compiled into `ir.nlu.entities` (unchanged)
- `mergeNLUIntoGather` is called after NLU compilation (unchanged)
- The new entity registry is a separate data structure

If there are conflicts (e.g., an inline anonymous entity has the same name as an NLU entity being merged), the anonymous entity should NOT be created for fields that get merged via `mergeNLUIntoGather`. Check the ordering:

1. Compile ENTITIES → ir.entities
2. Compile NLU → ir.nlu, lower NLU.entities → ir.entities
3. Compile GATHER (creates anonymous entities for inline types)
4. mergeNLUIntoGather (enriches GATHER fields from ir.nlu.entities)

For step 3, skip anonymous entity creation if the field name already exists in the entity registry (from explicit ENTITIES or NLU lowering).

- [ ] **Step 4: Run FULL test suite (build first)**

Run: `pnpm build && pnpm test 2>&1 | tail -40`
Expected: All tests pass across all packages

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git add packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/__tests__/entities-compilation.test.ts
git commit -m "[ABLP-2] feat(compiler): integration — entity registry, entity_ref, NLU merge, backward compat"
```

---

## Post-Implementation Notes

### What this plan covers (spec sections 12.1–12.3)

- Top-level `ENTITIES` construct in AST, parser, and IR
- `ENTITY_REF` on GATHER fields with exclusivity rules
- Compiler lowering rules 1–3, 6, 7: explicit ENTITIES, NLU.entities, inline GATHER types → `ir.entities`
- Conflict detection between ENTITIES and NLU.entities
- Full backward compatibility — existing ABL files compile unchanged

### Deferred from this plan (lowering rule 8)

**System entity types with built-in intrinsic validation** (spec rule 8): The spec says system types like `email`, `phone`, `date`, `datetime`, `boolean`, `currency` should have pre-registered entity definitions with built-in validation. This plan creates anonymous entities for these when used inline in GATHER (via `source: 'gather_inline'`), but does NOT pre-register a canonical library of system entity definitions with intrinsic validation rules. That can be added as a follow-up task — it requires defining the validation rules for each system type (email regex, phone regex, date parsing, etc.) and making them available before GATHER compilation.

### What requires a separate plan

**Runtime pipeline (spec sections 12.4–12.6):**

- Slot assignment phase with LLM disambiguation (Case A)
- Multi-value clarification (Case B)
- Observation → commitment lifecycle in session state
- Trace events for each lifecycle phase
- Runtime consumption of `ir.entities` for per-turn extraction

**VOCABULARY construct (spec sections 6.2, 12.1):**

- Top-level `VOCABULARY` in AST, parser, IR
- `NLU.glossary` lowering into canonical vocabulary registry
- Simpler than entities — no entity_ref, no validation, no type system

**Studio UI (spec section 12.7):**

- Entity library editor
- entity_ref picker on GATHER fields
- Migration suggestions
