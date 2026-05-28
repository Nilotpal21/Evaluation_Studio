# NLU Pipeline Intent Recognition Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the NLU pipeline so the LLM classifier returns intent categories (not targets), and the system evaluates WHEN conditions deterministically to resolve routing targets.

**Architecture:** The classifier prompt is restructured to send a flat category vocabulary and expect categories back. A new routing resolver evaluates WHEN conditions using the existing `evaluateConditionDual()` CEL evaluator. The compiler is fixed to extract all categories properly and supports a new optional `INTENTS:` ABL section for explicit category declarations with descriptions.

**Tech Stack:** TypeScript, Vitest, CEL (`@marcbachmann/cel-js` via `evaluateConditionDual`), ABL parser (hand-written line-oriented in `packages/core`), IR compiler (`packages/compiler`)

**Spec:** `docs/superpowers/specs/2026-04-02-nlu-pipeline-intent-recognition-redesign.md`

---

## File Structure

| File                                                        | Responsibility              | Action                                                                 |
| ----------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`               | IR type definitions         | Modify: `IntentConfig` schema change                                   |
| `packages/compiler/src/platform/constants.ts`               | Default constants           | Modify: `DEFAULT_INTENT_CATEGORIES` format                             |
| `packages/compiler/src/platform/ir/compiler.ts`             | ABL→IR compilation          | Modify: rewrite `extractIntentCategories()`                            |
| `packages/core/src/types/agent-based.ts`                    | AST types                   | Modify: add `intents?` field to `AgentBasedDocument`                   |
| `packages/core/src/parser/agent-based-parser.ts`            | ABL parser                  | Modify: implement `parseIntentsSection()` stub, add to `knownSections` |
| `apps/runtime/src/services/pipeline/types.ts`               | Pipeline types              | Modify: `ClassifiedIntent`, `ClassifierResult`, add `RoutingMatch`     |
| `apps/runtime/src/services/pipeline/classifier.ts`          | Classifier prompt & parsing | Modify: new prompt, new output schema                                  |
| `apps/runtime/src/services/pipeline/routing-resolver.ts`    | System-side WHEN evaluation | **Create**                                                             |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`       | Intent bridge               | Modify: delete dead code, simplify                                     |
| `apps/runtime/src/services/pipeline/index.ts`               | Pipeline orchestration      | Modify: remove `runPipeline()`, update re-exports                      |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`     | Tiered action resolution    | Modify: adapt to use routing matches                                   |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Pipeline wiring             | Modify: new orchestration flow                                         |
| Test files (see per-task)                                   | Tests                       | Modify + Create                                                        |

---

### Task 1: IR Schema — `IntentConfig` Type Change

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:2195-2204`
- Modify: `packages/compiler/src/platform/constants.ts:21`
- Test: `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`

- [ ] **Step 1: Add `IntentCategory` interface and update `IntentConfig` in schema.ts**

Open `packages/compiler/src/platform/ir/schema.ts`. Find the `IntentConfig` interface at line 2195. Replace it with:

```typescript
/** A single intent category, optionally with a description from the INTENTS: block */
export interface IntentCategory {
  /** Category name (e.g., "billing", "setup", "escalation") */
  name: string;
  /** Human-readable description from INTENTS: block. Undefined for inferred categories. */
  description?: string;
}

export interface IntentConfig {
  /** Intent categories — flat vocabulary for classification */
  categories: IntentCategory[];

  /** Confidence threshold */
  min_confidence: number;

  /** Whether categories came from explicit INTENTS: block or WHEN extraction */
  source: 'explicit' | 'inferred';
}
```

This removes the `use_llm` field (dead data) and changes `categories` from `string[]` to `IntentCategory[]`.

- [ ] **Step 2: Update `DEFAULT_INTENT_CATEGORIES` in constants.ts**

Open `packages/compiler/src/platform/constants.ts`. Find line 21:

```typescript
export const DEFAULT_INTENT_CATEGORIES = ['greeting', 'farewell', 'escalation'];
```

Replace with:

```typescript
import type { IntentCategory } from './ir/schema.js';

/** Default intent categories always included in supervisor classification (inferred mode) */
export const DEFAULT_INTENT_CATEGORIES: IntentCategory[] = [
  { name: 'greeting' },
  { name: 'farewell' },
  { name: 'escalation' },
];
```

- [ ] **Step 3: Build and fix any type errors**

Run: `pnpm build --filter=@abl/compiler`

There will be type errors in `compiler.ts` where `extractIntentCategories()` returns `string[]` — this is expected and will be fixed in Task 3. For now, verify the schema itself compiles.

If `extractIntentCategories()` fails to build because of the `string[]` vs `IntentCategory[]` mismatch, add a temporary cast in `compiler.ts` to unblock:

```typescript
categories: extractIntentCategories(doc) as unknown as IntentCategory[],
```

This will be removed in Task 3.

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/constants.ts
```

---

### Task 2: ABL Parser — Implement `INTENTS:` Section

**Files:**

- Modify: `packages/core/src/types/agent-based.ts:1311` (add `intents?` field)
- Modify: `packages/core/src/parser/agent-based-parser.ts:6283` (implement parser)
- Modify: `packages/core/src/parser/agent-based-parser.ts:505-542` (add to `knownSections`)
- Test: `packages/core/src/__tests__/parser/intents-section.test.ts` (create)

- [ ] **Step 1: Add `IntentDefinition` type and `intents` field to `AgentBasedDocument`**

Open `packages/core/src/types/agent-based.ts`. Before the closing `}` of `AgentBasedDocument` (after the `actionHandlers` field at line 1311), add:

```typescript
  // Intent category declarations (from INTENTS: block in supervisor files)
  intents?: IntentDefinition[];
```

Then add the `IntentDefinition` interface after the `AgentBasedDocument` interface (before the NLU section at line 1314):

```typescript
/**
 * An intent category declared in the INTENTS: section of a supervisor.
 * Format in ABL:
 *   INTENTS:
 *     category_name: "Optional description"
 *     category_name_2
 */
export interface IntentDefinition {
  /** Category name — must be a valid identifier (alphanumeric + underscore) */
  name: string;
  /** Optional human-readable description */
  description?: string;
}
```

- [ ] **Step 2: Add `INTENTS` to `knownSections` array**

Open `packages/core/src/parser/agent-based-parser.ts`. Find the `knownSections` array at line 505. Add `'INTENTS'` to it (alphabetical order, after `'IDENTITY'`):

```typescript
          'IDENTITY',
          'INTENTS',
          'LANGUAGE',
```

Also add `INTENTS:` to the error message string at line 554 (the "Valid sections:" message). Add it after `IDENTITY:`.

- [ ] **Step 3: Implement `parseIntentsSection()`**

Open `packages/core/src/parser/agent-based-parser.ts`. Find the stub `parseIntentsSection` at line 6283. Replace the entire function:

```typescript
function parseIntentsSection(state: ParserState): IntentDefinition[] {
  state.currentLine++;
  const intents: IntentDefinition[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // End of section: non-indented line that looks like a new section keyword
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z_]+:/)) {
        break;
      }
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Parse intent entry: "  category_name: "description"" or "  category_name"
    // Strip leading dash if present (- category_name)
    const entry = trimmed.startsWith('-') ? trimmed.substring(1).trim() : trimmed;

    // Match: name: "description" or name: 'description' or just name
    const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*["'](.+?)["'])?\s*$/);
    if (match) {
      const name = match[1];
      const description = match[2] || undefined;
      intents.push({ name, description });
    } else if (entry) {
      state.warnings.push({
        line: state.currentLine,
        message: `Invalid INTENTS entry: "${entry}". Expected: category_name or category_name: "description"`,
      });
    }

    state.currentLine++;
  }

  return intents;
}
```

- [ ] **Step 4: Update the dispatch to store parsed intents on the document**

Find the dispatch at line 486:

```typescript
    } else if (line === 'INTENTS:') {
      parseIntentsSection(state); // For supervisor files
```

Replace with:

```typescript
    } else if (line === 'INTENTS:') {
      doc.intents = parseIntentsSection(state);
```

- [ ] **Step 5: Add the `IntentDefinition` import at the top of agent-based-parser.ts**

At the imports section of `agent-based-parser.ts`, add `IntentDefinition` to the import from `../types/agent-based.js`:

```typescript
import type { ..., IntentDefinition } from '../types/agent-based.js';
```

(If `IntentDefinition` is not already imported — check the existing imports first.)

- [ ] **Step 6: Write tests for the parser**

Create `packages/core/src/__tests__/parser/intents-section.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseAgentBased } from '../../parser/agent-based-parser.js';

describe('INTENTS: section parser', () => {
  it('TC-INT-01 parses categories with descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "Customer asking about charges"
  setup: "Customer needs help setting up"

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "billing"
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([
      { name: 'billing', description: 'Customer asking about charges' },
      { name: 'setup', description: 'Customer needs help setting up' },
    ]);
  });

  it('TC-INT-02 parses categories without descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing
  setup
  escalation
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([
      { name: 'billing', description: undefined },
      { name: 'setup', description: undefined },
      { name: 'escalation', description: undefined },
    ]);
  });

  it('TC-INT-03 parses mixed — some with descriptions, some without', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: "Charges and payments"
  setup
  escalation: "Wants human agent"
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([
      { name: 'billing', description: 'Charges and payments' },
      { name: 'setup', description: undefined },
      { name: 'escalation', description: 'Wants human agent' },
    ]);
  });

  it('TC-INT-04 handles single-quoted descriptions', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  billing: 'Charges and payments'
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([{ name: 'billing', description: 'Charges and payments' }]);
  });

  it('TC-INT-05 handles dash-prefixed entries', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  - billing: "Charges"
  - setup
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([
      { name: 'billing', description: 'Charges' },
      { name: 'setup', description: undefined },
    ]);
  });

  it('TC-INT-06 skips comments and blank lines', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  # This is a comment
  billing: "Charges"

  // Another comment
  setup
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([
      { name: 'billing', description: 'Charges' },
      { name: 'setup', description: undefined },
    ]);
  });

  it('TC-INT-07 returns undefined when INTENTS block is absent', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

HANDOFF:
  - TO: Agent_A
    WHEN: intent.category == "billing"
`;
    const result = parseAgentBased(input);
    expect(result.intents).toBeUndefined();
  });

  it('TC-INT-08 warns on invalid entries', () => {
    const input = `SUPERVISOR: Test_Supervisor
GOAL: Test
PERSONA: Test

INTENTS:
  123invalid
  billing: "Valid one"
`;
    const result = parseAgentBased(input);
    expect(result.intents).toEqual([{ name: 'billing', description: 'Valid one' }]);
    // The parser should have produced a warning for "123invalid"
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm build --filter=@agent-platform/core && pnpm test --filter=@agent-platform/core -- --reporter=verbose intents-section`

Expected: All 8 tests pass.

- [ ] **Step 8: Run prettier and commit**

```bash
npx prettier --write packages/core/src/types/agent-based.ts packages/core/src/parser/agent-based-parser.ts packages/core/src/__tests__/parser/intents-section.test.ts
```

---

### Task 3: Compiler — Rewrite `extractIntentCategories()`

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts:700-720, 2870-2890`
- Test: `packages/compiler/src/__tests__/extract-intent-categories.test.ts` (create)

- [ ] **Step 1: Write the tests first**

Create `packages/compiler/src/__tests__/extract-intent-categories.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { compileAgentIR } from '../platform/ir/compiler.js';
import type { AgentBasedDocument } from '@agent-platform/core';
import type { IntentCategory } from '../platform/ir/schema.js';

// Helper: minimal AgentBasedDocument
function makeDoc(overrides: Partial<AgentBasedDocument> = {}): AgentBasedDocument {
  return {
    meta: { type: 'agent', line: 0 } as any,
    name: 'Test_Supervisor',
    goal: { description: 'Test' } as any,
    persona: { description: 'Test' } as any,
    limitations: [],
    tools: [],
    gather: [],
    memory: {} as any,
    constraints: [],
    delegate: [],
    handoff: [],
    complete: [],
    onError: [],
    ...overrides,
  };
}

function getCategories(doc: AgentBasedDocument): IntentCategory[] {
  const result = compileAgentIR(doc);
  return result.ir.routing?.intent_classification?.categories ?? [];
}

function getSource(doc: AgentBasedDocument): string | undefined {
  const result = compileAgentIR(doc);
  return result.ir.routing?.intent_classification?.source;
}

describe('extractIntentCategories', () => {
  // ─── Inferred mode (no INTENTS: block) ────────────────────────────────

  it('TC-EIC-01 extracts single category from handoff WHEN', () => {
    const doc = makeDoc({
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('billing');
    expect(getSource(doc)).toBe('inferred');
  });

  it('TC-EIC-02 extracts ALL categories from OR conditions (matchAll fix)', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Agent_A',
          when: 'intent.category == "device_issue" OR intent.category == "troubleshooting" OR intent.category == "setup"',
          context: {},
        } as any,
      ],
    });
    const names = getCategories(doc).map((c) => c.name);
    expect(names).toContain('device_issue');
    expect(names).toContain('troubleshooting');
    expect(names).toContain('setup');
  });

  it('TC-EIC-03 extracts from routing rules (not just handoffs)', () => {
    const doc = makeDoc({
      handoff: [
        { to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any,
        { to: 'Agent_B', when: 'intent.category == "setup"', context: {} } as any,
      ],
    });
    const names = getCategories(doc).map((c) => c.name);
    expect(names).toContain('billing');
    expect(names).toContain('setup');
  });

  it('TC-EIC-04 deduplicates categories across multiple rules', () => {
    const doc = makeDoc({
      handoff: [
        { to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any,
        {
          to: 'Agent_B',
          when: 'intent.category == "billing" AND user.tier == "premium"',
          context: {},
        } as any,
      ],
    });
    const names = getCategories(doc).map((c) => c.name);
    const billingCount = names.filter((n) => n === 'billing').length;
    expect(billingCount).toBe(1);
  });

  it('TC-EIC-05 includes DEFAULT_INTENT_CATEGORIES in inferred mode', () => {
    const doc = makeDoc({
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const names = getCategories(doc).map((c) => c.name);
    expect(names).toContain('greeting');
    expect(names).toContain('farewell');
    expect(names).toContain('escalation');
  });

  it('TC-EIC-06 inferred categories have no descriptions', () => {
    const doc = makeDoc({
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const categories = getCategories(doc);
    const billing = categories.find((c) => c.name === 'billing');
    expect(billing?.description).toBeUndefined();
  });

  it('TC-EIC-07 handles handoff with no WHEN condition', () => {
    const doc = makeDoc({
      handoff: [{ to: 'Agent_A', when: '', context: {} } as any],
    });
    // Should still have defaults, no crash
    const names = getCategories(doc).map((c) => c.name);
    expect(names).toContain('greeting');
  });

  // ─── Explicit mode (INTENTS: block) ───────────────────────────────────

  it('TC-EIC-10 uses explicit intents when INTENTS: block is present', () => {
    const doc = makeDoc({
      intents: [
        { name: 'billing', description: 'Customer asking about charges' },
        { name: 'setup', description: 'Customer needs setup help' },
      ],
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const categories = getCategories(doc);
    expect(categories).toEqual([
      { name: 'billing', description: 'Customer asking about charges' },
      { name: 'setup', description: 'Customer needs setup help' },
    ]);
    expect(getSource(doc)).toBe('explicit');
  });

  it('TC-EIC-11 explicit intents do NOT include defaults', () => {
    const doc = makeDoc({
      intents: [{ name: 'billing' }],
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const names = getCategories(doc).map((c) => c.name);
    expect(names).not.toContain('greeting');
    expect(names).not.toContain('farewell');
  });

  it('TC-EIC-12 explicit intents without descriptions have undefined description', () => {
    const doc = makeDoc({
      intents: [{ name: 'billing' }],
      handoff: [{ to: 'Agent_A', when: 'intent.category == "billing"', context: {} } as any],
    });
    const categories = getCategories(doc);
    expect(categories[0].description).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build --filter=@abl/compiler && pnpm test --filter=@abl/compiler -- --reporter=verbose extract-intent-categories`

Expected: Most tests fail because `extractIntentCategories()` still returns `string[]` and uses `.match()`.

- [ ] **Step 3: Rewrite `extractIntentCategories()` in compiler.ts**

Open `packages/compiler/src/platform/ir/compiler.ts`. Find `extractIntentCategories` at line 2870. Replace the entire function:

```typescript
function extractIntentCategories(doc: AgentBasedDocument): {
  categories: IntentCategory[];
  source: 'explicit' | 'inferred';
} {
  // Explicit mode: INTENTS: block is declared
  if (doc.intents && doc.intents.length > 0) {
    return {
      categories: doc.intents.map((intent) => ({
        name: intent.name,
        description: intent.description,
      })),
      source: 'explicit',
    };
  }

  // Inferred mode: extract from WHEN conditions across all handoffs
  const seen = new Set<string>();
  const categories: IntentCategory[] = [];

  for (const handoff of doc.handoff) {
    if (!handoff.when) continue;

    const regex = /intent\.category\s*==\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(handoff.when)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        categories.push({ name });
      }
    }
  }

  // Add defaults (deduped)
  for (const defaultCat of DEFAULT_INTENT_CATEGORIES) {
    if (!seen.has(defaultCat.name)) {
      seen.add(defaultCat.name);
      categories.push({ name: defaultCat.name });
    }
  }

  return { categories, source: 'inferred' };
}
```

Add the `IntentCategory` import at the top of `compiler.ts` if not already imported:

```typescript
import type { IntentCategory } from './schema.js';
```

- [ ] **Step 4: Update the call site at line ~713**

Find the `intent_classification` construction around line 713:

```typescript
      intent_classification: {
        use_llm: true,
        categories: extractIntentCategories(doc),
        min_confidence: DEFAULT_MIN_CONFIDENCE,
      },
```

Replace with:

```typescript
      intent_classification: (() => {
        const { categories, source } = extractIntentCategories(doc);
        return { categories, min_confidence: DEFAULT_MIN_CONFIDENCE, source };
      })(),
```

Remove the temporary cast from Task 1 Step 3 if you added one.

- [ ] **Step 5: Build and verify**

Run: `pnpm build --filter=@abl/compiler`

Expected: Clean build, no type errors.

- [ ] **Step 6: Run tests**

Run: `pnpm test --filter=@abl/compiler -- --reporter=verbose extract-intent-categories`

Expected: All tests pass.

- [ ] **Step 7: Run existing compiler tests to check for regressions**

Run: `pnpm test --filter=@abl/compiler -- --reporter=verbose`

Expected: All existing tests pass. The `supervisor-composition.test.ts` test at line 253 that checks `use_llm: true` will now fail because `use_llm` was removed. Update it:

```typescript
test('2.5 Supervisor has intent_classification config', () => {
  const output = compileAll(SUPERVISOR_A_DSL);
  const ir = output.agents['Travel_Supervisor'];
  expect(ir.routing!.intent_classification).toBeDefined();
  expect(ir.routing!.intent_classification.source).toBe('inferred');
  expect(ir.routing!.intent_classification.categories.length).toBeGreaterThan(0);
});
```

- [ ] **Step 8: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/extract-intent-categories.test.ts packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts
```

---

### Task 4: Pipeline Types — Update `ClassifiedIntent` and `ClassifierResult`

**Files:**

- Modify: `apps/runtime/src/services/pipeline/types.ts:82-137`

- [ ] **Step 1: Update `ClassifiedIntent` — replace `target` with `category`**

Open `apps/runtime/src/services/pipeline/types.ts`. Find `ClassifiedIntent` at line 123:

```typescript
export interface ClassifiedIntent {
  /** Target agent name, or null for in-agent handling */
  target: string | null;
  /** Confidence score 0.0-1.0 */
  confidence: number;
  /** Brief description of the intent */
  summary: string;
}
```

Replace with:

```typescript
export interface ClassifiedIntent {
  /** Intent category name, or null for out-of-scope */
  category: string | null;
  /** Confidence score 0.0-1.0 */
  confidence: number;
  /** Brief description of the intent */
  summary: string;
}
```

- [ ] **Step 2: Simplify `ClassifierResult`**

Find `ClassifierResult` at line 133:

```typescript
export interface ClassifierResult {
  intents: ClassifiedIntent[];
  shouldExecuteInAgent: boolean;
  matchedTools: string[];
}
```

Replace with:

```typescript
export interface ClassifierResult {
  intents: ClassifiedIntent[];
}
```

- [ ] **Step 3: Add `RoutingMatch` type**

After `ClassifierResult`, add:

```typescript
/** Result of system-side WHEN evaluation for a classified intent */
export interface RoutingMatch {
  /** The classified intent that was evaluated */
  intent: ClassifiedIntent;
  /** The matched routing target (agent name), or null if no rule matched */
  target: string | null;
  /** The routing rule that matched, if any */
  matchedRule?: {
    to: string;
    when: string;
    priority: number;
  };
}
```

- [ ] **Step 4: Update `TieredAction` and related types that reference `target`**

Find `TieredAction` (line 111). The short_circuit variant references `target`. This will now come from `RoutingMatch` instead of `ClassifiedIntent`. No type change needed — `target` is still a string. But check `GuidedHints.multiIntentSignal` (line 98):

```typescript
export interface GuidedHints {
  hiddenTools: string[];
  routingHint?: string;
  multiIntentSignal?: {
    intents: Array<{
      target: string | null;
      summary: string;
      confidence: number;
    }>;
    suggestedAction: 'sequential_handoff' | 'address_primary';
  };
}
```

Update the `intents` array inside `multiIntentSignal` to use `category` instead of `target`:

```typescript
  multiIntentSignal?: {
    intents: Array<{
      category: string | null;
      target: string | null;
      summary: string;
      confidence: number;
    }>;
    suggestedAction: 'sequential_handoff' | 'address_primary';
  };
```

- [ ] **Step 5: Build to identify all downstream type errors**

Run: `pnpm build --filter=@agent-platform/runtime`

This will produce type errors everywhere `ClassifiedIntent.target` or `ClassifierResult.shouldExecuteInAgent` / `.matchedTools` are used. **Do not fix them yet** — these are the files we'll update in subsequent tasks. Note the error locations for reference.

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/types.ts
```

---

### Task 5: Classifier — New Prompt and Output Schema

**Files:**

- Modify: `apps/runtime/src/services/pipeline/classifier.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-classifier.test.ts`

- [ ] **Step 1: Update tests first**

Open `apps/runtime/src/__tests__/pipeline-classifier.test.ts`. The existing tests for `checkKeywordVeto` and `shouldShortCircuit` need updates because `ClassifierResult` shape changed.

Replace every `ClassifierResult` construction that has `target:` with `category:`. Remove `shouldExecuteInAgent` and `matchedTools` fields. For example, change:

```typescript
{ intents: [{ target: 'Agent_A', confidence: 0.9, summary: 'test' }], shouldExecuteInAgent: false, matchedTools: [] }
```

to:

```typescript
{
  intents: [{ category: 'billing', confidence: 0.9, summary: 'test' }];
}
```

For `shouldShortCircuit` tests: the function currently checks `primary.target !== null`. It should now check `primary.category !== null` (since short-circuit will be based on whether the routing resolver found a match, but `shouldShortCircuit` in the classifier only checks if the classifier returned a non-null result). Update the function and tests together in step 3.

- [ ] **Step 2: Rewrite `buildClassifierPrompt()`**

Open `apps/runtime/src/services/pipeline/classifier.ts`. Replace `buildClassifierPrompt` (lines 21-49) with:

```typescript
import type { IntentCategory } from '@abl/compiler/platform/ir/schema.js';

function buildClassifierPrompt(userMessage: string, categories: IntentCategory[]): string {
  let categorySection: string;

  // Check if any categories have descriptions (explicit mode)
  const hasDescriptions = categories.some((c) => c.description);

  if (hasDescriptions) {
    categorySection = categories
      .map((c) => (c.description ? `  ${c.name} — "${c.description}"` : `  ${c.name}`))
      .join('\n');
  } else {
    categorySection = categories.map((c) => c.name).join(', ');
  }

  return `You are an intent classifier. Identify the user's intent from the categories below.

${hasDescriptions ? `Categories:\n${categorySection}` : `Categories: ${categorySection}`}

Rules:
- Return the category that best matches the user message
- If NONE match, set category to null
- If MULTIPLE distinct intents are detected, return one entry per intent
- Confidence 0.0-1.0

User message: "${userMessage}"

Respond with ONLY valid JSON (no markdown):
{"intents":[{"category":"<category or null>","confidence":<0.0-1.0>,"summary":"<the specific sub-request>"}]}`;
}
```

- [ ] **Step 3: Rewrite `parseClassifierResponse()`**

Replace `parseClassifierResponse` (lines 54-81) with:

````typescript
function parseClassifierResponse(text: string, knownCategories: Set<string>): ClassifierResult {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
  try {
    const parsed = JSON.parse(cleaned);
    const intents: ClassifiedIntent[] = (parsed.intents ?? []).map((i: Record<string, unknown>) => {
      const rawCategory =
        typeof i.category === 'string' && i.category !== 'null' ? i.category : null;
      // Validate category exists in known set — reject hallucinated categories
      const category = rawCategory && knownCategories.has(rawCategory) ? rawCategory : null;
      return {
        category,
        confidence: typeof i.confidence === 'number' ? Math.max(0, Math.min(1, i.confidence)) : 0,
        summary: typeof i.summary === 'string' ? i.summary : '',
      };
    });
    return {
      intents:
        intents.length > 0 ? intents : [{ category: null, confidence: 0, summary: 'unknown' }],
    };
  } catch {
    log.warn('classifier response parse failed, falling through', { text: text.slice(0, 200) });
    return {
      intents: [{ category: null, confidence: 0, summary: 'parse_failure' }],
    };
  }
}
````

- [ ] **Step 4: Rewrite `classify()` function signature and body**

Replace `classify` (lines 119-165) with:

```typescript
export async function classify(
  model: LanguageModel,
  userMessage: string,
  categories: IntentCategory[],
  config: PipelineConfig,
  onTraceEvent?: OnTraceEvent,
): Promise<ClassifierResult> {
  const start = Date.now();
  const knownCategories = new Set(categories.map((c) => c.name));

  try {
    const prompt = buildClassifierPrompt(userMessage, categories);
    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 300,
      temperature: 0,
      abortSignal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
    });
    const classifierResult = parseClassifierResponse(result.text, knownCategories);
    const latencyMs = Date.now() - start;
    if (onTraceEvent) {
      onTraceEvent({
        type: 'pipeline_classify',
        data: {
          intents: classifierResult.intents,
          model: typeof model === 'string' ? model : model.modelId,
          latencyMs,
        },
      });
    }
    return classifierResult;
  } catch (err) {
    log.warn('classifier LLM call failed, falling through', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      intents: [{ category: null, confidence: 0, summary: 'llm_error' }],
    };
  }
}
```

- [ ] **Step 5: Update `shouldShortCircuit()` to use `category` instead of `target`**

Replace `shouldShortCircuit` (lines 171-196). The function checks if a single high-confidence intent was classified. Change `primary.target` to `primary.category`:

```typescript
export function shouldShortCircuit(
  result: ClassifierResult,
  userMessage: string,
  toolNames: string[],
  config: PipelineConfig,
): { shortCircuit: boolean; vetoKeywords?: string[] } {
  if (!config.shortCircuit.enabled) return { shortCircuit: false };

  const intents = result.intents;
  if (intents.length !== 1) return { shortCircuit: false };

  const primary = intents[0];
  if (!primary.category) return { shortCircuit: false };
  if (primary.confidence < config.shortCircuit.confidenceThreshold) return { shortCircuit: false };

  // Check keyword veto
  if (config.keywordVeto.enabled) {
    const vetoResult = checkKeywordVeto(userMessage, toolNames, config);
    if (vetoResult.vetoed) {
      return { shortCircuit: false, vetoKeywords: vetoResult.matchedKeywords };
    }
  }

  return { shortCircuit: true };
}
```

- [ ] **Step 6: Remove unused imports**

Remove `targets`, `toolNames`, `routingDescriptions` parameters. Remove any unused type imports. Clean up the import section.

- [ ] **Step 7: Build and fix type errors**

Run: `pnpm build --filter=@agent-platform/runtime`

Fix any remaining type errors in this file only. Other files will have errors from the type changes — those are addressed in subsequent tasks.

- [ ] **Step 8: Update classifier tests**

Update `apps/runtime/src/__tests__/pipeline-classifier.test.ts` to use `category` instead of `target` in all `ClassifierResult` constructions and assertions. Remove `shouldExecuteInAgent` and `matchedTools` from all test fixtures.

- [ ] **Step 9: Run tests**

Run: `pnpm test --filter=@agent-platform/runtime -- --reporter=verbose pipeline-classifier`

Expected: All tests pass.

- [ ] **Step 10: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/classifier.ts apps/runtime/src/__tests__/pipeline-classifier.test.ts
```

---

### Task 6: Routing Resolver — New File

**Files:**

- Create: `apps/runtime/src/services/pipeline/routing-resolver.ts`
- Create: `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`

- [ ] **Step 1: Write the tests first**

Create `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveRouting } from '../services/pipeline/routing-resolver.js';
import type { ClassifiedIntent, RoutingMatch } from '../services/pipeline/types.js';
import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';

// ─── HELPERS ────────────────────────────────────────────────────────────

function makeIntent(category: string | null, confidence = 0.9, summary = 'test'): ClassifiedIntent {
  return { category, confidence, summary };
}

function makeRule(to: string, when: string, priority = 1): RoutingRule {
  return { to, when, description: `Route to ${to}`, priority };
}

// ═════════════════════════════════════════════════════════════════════════

describe('resolveRouting', () => {
  it('TC-RR-01 single intent matches single rule', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Billing_Agent', 'intent.category == "billing"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBe('Billing_Agent');
    expect(matches[0].intent.category).toBe('billing');
  });

  it('TC-RR-02 no matching rule returns null target', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Setup_Agent', 'intent.category == "setup"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-03 multiple rules — first match by priority wins', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('General_Agent', 'intent.category == "billing"', 2),
      makeRule('Priority_Agent', 'intent.category == "billing"', 1),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Priority_Agent');
  });

  it('TC-RR-04 OR condition in WHEN matches', () => {
    const intents = [makeIntent('setup')];
    const rules = [
      makeRule('Device_Agent', 'intent.category == "device_issue" || intent.category == "setup"'),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Device_Agent');
  });

  it('TC-RR-05 AND condition with missing non-intent var — null injection, condition fails', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"'),
    ];
    // user.tier not in session values — null injection by evaluateConditionDual
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-06 AND condition with non-intent var present — evaluates fully', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"'),
    ];
    const sessionValues = { user: { tier: 'premium' } };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBe('Premium_Agent');
  });

  it('TC-RR-07 same category routes to different targets based on session state', () => {
    const intents = [makeIntent('billing')];
    const rules = [
      makeRule('Premium_Agent', 'intent.category == "billing" && user.tier == "premium"', 1),
      makeRule('Standard_Agent', 'intent.category == "billing" && user.tier == "standard"', 2),
    ];
    const sessionValues = { user: { tier: 'standard' } };
    const matches = resolveRouting(intents, rules, sessionValues);
    expect(matches[0].target).toBe('Standard_Agent');
  });

  it('TC-RR-08 multi-intent — each intent evaluated independently', () => {
    const intents = [makeIntent('billing', 0.9), makeIntent('setup', 0.85)];
    const rules = [
      makeRule('Billing_Agent', 'intent.category == "billing"'),
      makeRule('Setup_Agent', 'intent.category == "setup"'),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches).toHaveLength(2);
    expect(matches[0].target).toBe('Billing_Agent');
    expect(matches[1].target).toBe('Setup_Agent');
  });

  it('TC-RR-09 null category intent — no routing match', () => {
    const intents = [makeIntent(null)];
    const rules = [makeRule('Agent_A', 'intent.category == "billing"')];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-10 fallback rule with when: "true" matches when nothing else does', () => {
    const intents = [makeIntent('unknown_category')];
    const rules = [
      makeRule('Specific_Agent', 'intent.category == "billing"', 1),
      makeRule('Fallback_Agent', 'true', 99),
    ];
    const matches = resolveRouting(intents, rules, {});
    expect(matches[0].target).toBe('Fallback_Agent');
  });

  it('TC-RR-11 empty rules array — all intents get null target', () => {
    const intents = [makeIntent('billing')];
    const matches = resolveRouting(intents, [], {});
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBeNull();
  });

  it('TC-RR-12 trace events emitted', () => {
    const intents = [makeIntent('billing')];
    const rules = [makeRule('Billing_Agent', 'intent.category == "billing"')];
    const traceEvents: any[] = [];
    resolveRouting(intents, rules, {}, (e) => traceEvents.push(e));
    expect(traceEvents.length).toBeGreaterThan(0);
    expect(traceEvents.some((e) => e.type === 'pipeline_routing_resolve')).toBe(true);
  });
});
```

- [ ] **Step 2: Create the routing resolver**

Create `apps/runtime/src/services/pipeline/routing-resolver.ts`:

```typescript
/**
 * Routing Resolver — System-side WHEN evaluation for pipeline-classified intents.
 *
 * Takes classifier output (categories) and evaluates routing rules using the
 * existing CEL evaluator. This replaces the LLM's interpretation of WHEN conditions
 * with deterministic system-side evaluation.
 *
 * Pure function except for optional trace event emission.
 */

import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';
import { evaluateConditionDual } from '@abl/compiler/platform';
import { createLogger } from '@abl/compiler/platform';
import type { ClassifiedIntent, RoutingMatch, OnTraceEvent } from './types.js';

const log = createLogger('pipeline:routing-resolver');

/**
 * Evaluate routing rules against classified intents using the CEL evaluator.
 *
 * For each classified intent:
 *   1. Sets intent.category in a temporary evaluation context
 *   2. Iterates rules sorted by priority
 *   3. Evaluates each rule's WHEN via evaluateConditionDual()
 *   4. First matching rule determines the target
 *
 * @param intents - Classified intents from the classifier (sorted by confidence desc)
 * @param rules - Routing rules from agentIR.routing.rules
 * @param sessionValues - Current session.data.values (non-intent vars like user.tier)
 * @param onTraceEvent - Optional trace event callback
 * @returns One RoutingMatch per intent
 */
export function resolveRouting(
  intents: ClassifiedIntent[],
  rules: RoutingRule[],
  sessionValues: Record<string, unknown>,
  onTraceEvent?: OnTraceEvent,
): RoutingMatch[] {
  const sortedRules = [...rules].sort(
    (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity),
  );
  const results: RoutingMatch[] = [];

  for (const intent of intents) {
    // Build evaluation context: merge session values with classified intent
    const evalContext: Record<string, unknown> = {
      ...sessionValues,
      intent: {
        category: intent.category,
        confidence: intent.confidence,
      },
    };

    let matched = false;

    for (const rule of sortedRules) {
      if (!rule.when) continue;

      try {
        const conditionMet = evaluateConditionDual(rule.when, evalContext);

        if (conditionMet) {
          results.push({
            intent,
            target: rule.to,
            matchedRule: { to: rule.to, when: rule.when, priority: rule.priority },
          });
          matched = true;

          log.debug('Routing match found', {
            category: intent.category,
            target: rule.to,
            rule: rule.when,
            priority: rule.priority,
          });
          break;
        }
      } catch (err) {
        log.warn('Rule evaluation failed, skipping', {
          rule: rule.when,
          target: rule.to,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!matched) {
      results.push({ intent, target: null });
    }
  }

  if (onTraceEvent) {
    onTraceEvent({
      type: 'pipeline_routing_resolve',
      data: {
        intentCount: intents.length,
        matches: results.map((m) => ({
          category: m.intent.category,
          target: m.target,
          matchedRule: m.matchedRule?.when ?? null,
          priority: m.matchedRule?.priority ?? null,
        })),
      },
    });
  }

  return results;
}
```

- [ ] **Step 3: Verify the `evaluateConditionDual` import path**

Run: `grep -r "evaluateConditionDual" apps/runtime/src/services/ --include="*.ts" -l` to check how existing files import it. Use the same import path.

The import should be one of:

- `import { evaluateConditionDual } from '@abl/compiler/platform';`
- `import { evaluateConditionDual } from '@abl/compiler/platform/constructs/dual-evaluator.js';`

Match the existing pattern used in `routing-executor.ts`.

- [ ] **Step 4: Build**

Run: `pnpm build --filter=@agent-platform/runtime`

Expected: The new file builds. Other files may still have errors from Task 4 type changes.

- [ ] **Step 5: Run tests**

Run: `pnpm test --filter=@agent-platform/runtime -- --reporter=verbose pipeline-routing-resolver`

Expected: All 12 tests pass.

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/routing-resolver.ts apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts
```

---

### Task 7: Intent Bridge — Delete Dead Code, Simplify

**Files:**

- Modify: `apps/runtime/src/services/pipeline/intent-bridge.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`

- [ ] **Step 1: Rewrite intent-bridge.ts**

Replace the entire contents of `apps/runtime/src/services/pipeline/intent-bridge.ts`:

```typescript
/**
 * Intent Bridge — Maps classifier output + routing matches to session state.
 *
 * Simplified from the original which reverse-engineered categories from targets
 * via regex parsing. Now the classifier returns categories directly and the
 * routing resolver provides targets from WHEN evaluation.
 */

import type { AgentIR } from '@abl/compiler';
import type {
  ClassifiedIntent,
  ClassifierResult,
  RoutingMatch,
  PipelineIntentState,
} from './types.js';

// Re-export types used by multi-intent infrastructure
import type {
  DetectedMultiIntentResult,
  DetectedIntent,
  IntentRelationship,
  MultiIntentResult,
} from '../execution/multi-intent-router.js';

// =============================================================================
// PRIMARY BRIDGE — Session State
// =============================================================================

/**
 * Build the PipelineIntentState to write to session.data.values.intent.
 *
 * Takes classifier result and routing matches (from resolveRouting).
 * No reverse-engineering — category from classifier, target from routing resolver.
 */
export function bridgeIntentsToSessionState(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
): PipelineIntentState {
  const intents = classifierResult.intents;

  if (intents.length === 0) {
    return {
      category: null,
      confidence: 0,
      out_of_scope: false,
      target: null,
      summary: '',
      intent_count: 0,
    };
  }

  // Pick primary intent (highest confidence)
  const primary = intents.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );

  // Find routing match for the primary intent
  const primaryMatch = routingMatches.find(
    (m) => m.intent.category === primary.category && m.intent.confidence === primary.confidence,
  );

  return {
    category: primary.category,
    confidence: primary.confidence,
    out_of_scope: primary.category === null,
    target: primaryMatch?.target ?? null,
    summary: primary.summary,
    intent_count: intents.length,
  };
}

// =============================================================================
// MULTI-INTENT BRIDGES
// =============================================================================

/**
 * Bridge classifier + routing results to DetectedMultiIntentResult.
 * Used by the multi-intent router for fan-out and disambiguation.
 */
export function bridgeToDetectedMultiIntent(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
): DetectedMultiIntentResult | null {
  const intents = classifierResult.intents;
  if (intents.length < 2) return null;

  const sorted = [...intents].sort((a, b) => b.confidence - a.confidence);

  return {
    primary: toDetectedIntent(sorted[0], routingMatches),
    alternatives: sorted.slice(1).map((intent) => toDetectedIntent(intent, routingMatches)),
    relationships: inferRelationship(sorted, routingMatches),
  };
}

/**
 * Bridge classifier + routing results to MultiIntentResult.
 * Used by the handleMultiIntent() infrastructure.
 */
export function bridgeToMultiIntentResult(
  classifierResult: ClassifierResult,
  routingMatches: RoutingMatch[],
): MultiIntentResult | null {
  const intents = classifierResult.intents;
  if (intents.length < 2) return null;

  const sorted = [...intents].sort((a, b) => b.confidence - a.confidence);

  return {
    primary: {
      intent: resolveIntentName(sorted[0], routingMatches),
      confidence: sorted[0].confidence,
      source: 'fast' as const,
    },
    alternatives: sorted.slice(1).map((alt) => ({
      intent: resolveIntentName(alt, routingMatches),
      confidence: alt.confidence,
      source: 'fast' as const,
    })),
    relationships: inferRelationship(sorted, routingMatches),
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function toDetectedIntent(
  intent: ClassifiedIntent,
  routingMatches: RoutingMatch[],
): DetectedIntent {
  const match = routingMatches.find(
    (m) => m.intent.category === intent.category && m.intent.confidence === intent.confidence,
  );
  return {
    intent: intent.category ?? intent.summary ?? 'unknown',
    confidence: intent.confidence,
    source: 'pipeline' as const,
    target: match?.target ? { kind: 'agent' as const, name: match.target } : undefined,
  };
}

function resolveIntentName(intent: ClassifiedIntent, routingMatches: RoutingMatch[]): string {
  if (intent.category) return intent.category;
  const match = routingMatches.find((m) => m.intent.confidence === intent.confidence);
  if (match?.target) return match.target;
  return intent.summary || 'unknown';
}

function inferRelationship(
  intents: ClassifiedIntent[],
  routingMatches: RoutingMatch[],
): IntentRelationship {
  const targets = intents.map((intent) => {
    const match = routingMatches.find(
      (m) => m.intent.category === intent.category && m.intent.confidence === intent.confidence,
    );
    return match?.target ?? null;
  });

  if (targets.some((t) => t === null)) return 'ambiguous';
  const uniqueTargets = new Set(targets);
  return uniqueTargets.size > 1 ? 'independent' : 'dependent';
}
```

- [ ] **Step 2: Update intent-bridge tests**

Open `apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts`. The tests need to be rewritten to match the new function signatures. The key change: `bridgeIntentsToSessionState` now takes `(classifierResult, routingMatches)` instead of `(classifierResult, agentIR)`.

Replace the helpers:

```typescript
import { describe, it, expect } from 'vitest';
import {
  bridgeIntentsToSessionState,
  bridgeToMultiIntentResult,
  bridgeToDetectedMultiIntent,
} from '../services/pipeline/intent-bridge.js';
import type {
  ClassifierResult,
  ClassifiedIntent,
  RoutingMatch,
} from '../services/pipeline/types.js';

// ─── HELPERS ────────────────────────────────────────────────────────────

function makeClassifierResult(intents: ClassifiedIntent[]): ClassifierResult {
  return { intents };
}

function makeRoutingMatch(intent: ClassifiedIntent, target: string | null): RoutingMatch {
  return {
    intent,
    target,
    ...(target
      ? {
          matchedRule: { to: target, when: `intent.category == "${intent.category}"`, priority: 1 },
        }
      : {}),
  };
}
```

Then rewrite the tests. For example, `bridgeIntentsToSessionState`:

```typescript
describe('bridgeIntentsToSessionState', () => {
  it('TC-IB-10 known category with routing match', () => {
    const intent: ClassifiedIntent = {
      category: 'billing',
      confidence: 0.92,
      summary: 'check bill',
    };
    const result = bridgeIntentsToSessionState(makeClassifierResult([intent]), [
      makeRoutingMatch(intent, 'Billing_Agent'),
    ]);
    expect(result.category).toBe('billing');
    expect(result.target).toBe('Billing_Agent');
    expect(result.confidence).toBe(0.92);
    expect(result.out_of_scope).toBe(false);
  });

  it('TC-IB-11 null category — out of scope', () => {
    const intent: ClassifiedIntent = { category: null, confidence: 0.88, summary: 'weather' };
    const result = bridgeIntentsToSessionState(makeClassifierResult([intent]), [
      makeRoutingMatch(intent, null),
    ]);
    expect(result.category).toBeNull();
    expect(result.target).toBeNull();
    expect(result.out_of_scope).toBe(true);
  });

  it('TC-IB-12 multi-intent picks highest confidence as primary', () => {
    const low: ClassifiedIntent = { category: 'billing', confidence: 0.7, summary: 'bill' };
    const high: ClassifiedIntent = { category: 'setup', confidence: 0.9, summary: 'setup' };
    const result = bridgeIntentsToSessionState(makeClassifierResult([low, high]), [
      makeRoutingMatch(low, 'Billing_Agent'),
      makeRoutingMatch(high, 'Setup_Agent'),
    ]);
    expect(result.category).toBe('setup');
    expect(result.target).toBe('Setup_Agent');
    expect(result.intent_count).toBe(2);
  });

  it('TC-IB-13 valid category but no routing match', () => {
    const intent: ClassifiedIntent = {
      category: 'billing',
      confidence: 0.8,
      summary: 'check bill',
    };
    const result = bridgeIntentsToSessionState(makeClassifierResult([intent]), [
      makeRoutingMatch(intent, null),
    ]);
    expect(result.category).toBe('billing');
    expect(result.target).toBeNull();
    expect(result.out_of_scope).toBe(false);
  });

  it('TC-IB-14 empty intents — zero state', () => {
    const result = bridgeIntentsToSessionState(makeClassifierResult([]), []);
    expect(result.category).toBeNull();
    expect(result.target).toBeNull();
    expect(result.intent_count).toBe(0);
  });
});
```

Similarly update the `bridgeToDetectedMultiIntent` and `bridgeToMultiIntentResult` tests with the new signatures.

- [ ] **Step 3: Build**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 4: Run tests**

Run: `pnpm test --filter=@agent-platform/runtime -- --reporter=verbose pipeline-intent-bridge`

Expected: All tests pass.

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/intent-bridge.ts apps/runtime/src/__tests__/pipeline-intent-bridge.test.ts
```

---

### Task 8: Tiered Resolver — Adapt to Routing Matches

**Files:**

- Modify: `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`

- [ ] **Step 1: Update `resolveTieredAction()` signature**

The function currently takes `pipelineResult` which includes `classifierResult.intents` with `.target`. Now intents have `.category` and targets come from routing matches.

Change the signature to accept routing matches:

```typescript
export function resolveTieredAction(
  classifierResult: ClassifierResult | undefined,
  routingMatches: RoutingMatch[],
  config: IntentBridgeConfig,
  agentIR: AgentIR,
): TieredAction {
```

- [ ] **Step 2: Update Tier 1 out-of-scope check**

Change `primary.target === null` to `primary.category === null`:

```typescript
const intents = classifierResult.intents;
const primary = intents.reduce((best, current) =>
  current.confidence > best.confidence ? current : best,
);

// Tier 1: Out-of-scope decline — category is null, high confidence
if (
  config.outOfScopeDecline &&
  primary.category === null &&
  primary.confidence >= config.programmaticThreshold &&
  hasLimitations(agentIR)
) {
  const message = resolveOutOfScopeMessage(agentIR);
  return { tier: 1, action: 'decline_out_of_scope', message };
}
```

- [ ] **Step 3: Update `resolveHiddenTools()` to use routing matches**

Replace the function:

```typescript
function resolveHiddenTools(routingMatches: RoutingMatch[], agentIR: AgentIR): string[] {
  const matchedTargets = new Set(routingMatches.map((m) => m.target).filter(Boolean) as string[]);

  // If no concrete targets identified, don't hide anything
  if (matchedTargets.size === 0) return [];

  const hidden: string[] = [];

  // Check routing rules (supervisor handoffs)
  if (agentIR.routing?.rules) {
    for (const rule of agentIR.routing.rules) {
      if (!matchedTargets.has(rule.to)) {
        const isEscalation = rule.to.toLowerCase().includes('escalat');
        if (!isEscalation) {
          hidden.push(`handoff_to_${rule.to}`);
        }
      }
    }
  }

  // Check coordination handoffs
  if (agentIR.coordination?.handoffs) {
    for (const handoff of agentIR.coordination.handoffs) {
      if (!matchedTargets.has(handoff.to)) {
        const isEscalation = handoff.to.toLowerCase().includes('escalat');
        if (!isEscalation) {
          hidden.push(`handoff_to_${handoff.to}`);
        }
      }
    }
  }

  return hidden;
}
```

- [ ] **Step 4: Update Tier 2 guided section**

Change the call to `resolveHiddenTools` and the `routingHint` / `multiIntentSignal`:

```typescript
if (primary.confidence >= config.guidedThreshold) {
  const hints: GuidedHints = {
    hiddenTools: resolveHiddenTools(routingMatches, agentIR),
  };

  // Add routing hint for single-intent guided mode
  const primaryMatch = routingMatches.find(
    (m) => m.intent.category === primary.category && m.intent.confidence === primary.confidence,
  );
  if (intents.length === 1 && primaryMatch?.target) {
    hints.routingHint = `Pipeline classifier suggests routing to ${primaryMatch.target} (confidence: ${primary.confidence.toFixed(2)})`;
  }

  // Multi-intent signal
  if (
    config.multiIntentSignal &&
    intents.length >= 2 &&
    intents.every((i) => i.confidence >= config.guidedThreshold)
  ) {
    const matchedTargets = routingMatches.map((m) => m.target).filter(Boolean);
    const allDifferentTargets = new Set(matchedTargets).size > 1;

    hints.multiIntentSignal = {
      intents: intents.map((i) => {
        const match = routingMatches.find(
          (m) => m.intent.category === i.category && m.intent.confidence === i.confidence,
        );
        return {
          category: i.category,
          target: match?.target ?? null,
          summary: i.summary,
          confidence: i.confidence,
        };
      }),
      suggestedAction: allDifferentTargets ? 'sequential_handoff' : 'address_primary',
    };
  }

  return { tier: 2, action: 'guided', hints };
}
```

- [ ] **Step 5: Update tiered resolver tests**

Update `apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts`. Change:

- `makePipelineResult` helper to produce `ClassifierResult` with `category` instead of `target`
- Add `RoutingMatch[]` construction for each test
- Update function call: `resolveTieredAction(classifierResult, routingMatches, config, agentIR)`

- [ ] **Step 6: Build and run tests**

Run: `pnpm build --filter=@agent-platform/runtime && pnpm test --filter=@agent-platform/runtime -- --reporter=verbose pipeline-tiered-resolver`

Expected: All tests pass.

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/tiered-resolver.ts apps/runtime/src/__tests__/pipeline-tiered-resolver.test.ts
```

---

### Task 9: Pipeline Index — Remove `runPipeline()`, Update Re-exports

**Files:**

- Modify: `apps/runtime/src/services/pipeline/index.ts`
- Modify: `apps/runtime/src/__tests__/pipeline-executor.test.ts`

- [ ] **Step 1: Remove `runPipeline()` and internal helpers**

Open `apps/runtime/src/services/pipeline/index.ts`. Delete the following functions:

- `extractTargets()` (lines 29-49)
- `extractRoutingDescriptions()` (lines 54-66)
- `extractToolNames()` (lines 71-80) — **keep this one**, it's still used by tool filter
- `buildResult()` (lines 85-195) — short-circuit logic moves to reasoning executor
- `runPipeline()` (lines 200-259)

Keep `extractToolNames()` as it's used by the tool filter path.

- [ ] **Step 2: Update re-exports**

Update the re-exports section (lines 262-273). Remove `runPipeline` export. Add new exports:

```typescript
// Pipeline components
export { classify, shouldShortCircuit, checkKeywordVeto } from './classifier.js';
export { filterTools } from './tool-filter.js';
export { resolveRouting } from './routing-resolver.js';
export {
  bridgeIntentsToSessionState,
  bridgeToMultiIntentResult,
  bridgeToDetectedMultiIntent,
} from './intent-bridge.js';
export { resolveTieredAction } from './tiered-resolver.js';
export { resolvePipelineConfig } from './config.js';
export { mergeResponses } from './merge.js';
export { resolvePipelineModel } from './model-resolver.js';
export { extractToolNames } from './tool-names.js'; // if extracted, or keep inline

// Types
export type {
  PipelineConfig,
  PipelineIntentState,
  ClassifiedIntent,
  ClassifierResult,
  RoutingMatch,
  OnTraceEvent,
  TieredAction,
  IntentBridgeConfig,
} from './types.js';
export { DEFAULT_PIPELINE_CONFIG } from './types.js';
```

If `extractToolNames` was inside `index.ts`, either keep it there or move it to its own small file.

- [ ] **Step 3: Update or delete pipeline-executor tests**

The `pipeline-executor.test.ts` tests `runPipeline()` which no longer exists. The orchestration logic moves to the reasoning executor. Delete this test file or rewrite it to test the individual components.

Since we already have tests for `classify`, `resolveRouting`, and `shouldShortCircuit` individually, the executor test can be deleted. The integration of these components is tested in Task 10.

- [ ] **Step 4: Build**

Run: `pnpm build --filter=@agent-platform/runtime`

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/pipeline/index.ts
```

---

### Task 10: Reasoning Executor — New Pipeline Wiring

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` (lines 747-982)

This is the highest-complexity task. It rewires the pipeline block in the reasoning executor.

- [ ] **Step 1: Read the current pipeline block**

Read lines 747-982 of `reasoning-executor.ts` to get the exact current code. Note all imports used.

- [ ] **Step 2: Update imports**

At the top of the file, update pipeline imports:

```typescript
import {
  classify,
  shouldShortCircuit,
  filterTools,
  resolveRouting,
  bridgeIntentsToSessionState,
  bridgeToDetectedMultiIntent,
  resolveTieredAction,
  resolvePipelineConfig,
  resolvePipelineModel,
} from '../pipeline/index.js';
import type { IntentCategory } from '@abl/compiler/platform/ir/schema.js';
```

Remove imports of `runPipeline`, `buildTargetCategoryMap`, and any other deleted functions.

- [ ] **Step 3: Rewrite the pipeline block**

Replace the pipeline section (from `const pipelineConfig = resolvePipelineConfig(...)` through the end of the pipeline `catch` block) with:

```typescript
// Run opt-in pipeline (classifier + tool filter) before the reasoning loop
const pipelineConfig = resolvePipelineConfig(
  session.agentIR?.execution,
  session.agentIR?.project_runtime_config?.pipeline,
);
if (pipelineConfig.enabled) {
  const lastUserContent = session.conversationHistory
    .filter((m) => m.role === 'user')
    .pop()?.content;
  const lastUserMsg =
    typeof lastUserContent === 'string'
      ? lastUserContent
      : Array.isArray(lastUserContent)
        ? ((lastUserContent as Array<{ type: string; text?: string }>).find(
            (b) => b.type === 'text',
          )?.text ?? '')
        : '';

  const tenantId = session.tenantId ?? '';
  if (lastUserMsg && session.llmClient && !isPipelineCircuitOpen(tenantId)) {
    try {
      const pipelineModel = await resolvePipelineModel(pipelineConfig, session);
      if (pipelineModel) {
        // ─── Extract categories from IR (with backward-compat shim) ───
        const rawCategories = session.agentIR?.routing?.intent_classification?.categories ?? [];
        const categories: IntentCategory[] = rawCategories.map((c: string | IntentCategory) =>
          typeof c === 'string' ? { name: c } : c,
        );

        // ─── Run classifier + tool filter (parallel or sequential) ───
        let classifierResult;
        let toolFilterResult;

        if (pipelineConfig.mode === 'parallel') {
          const [cResult, fResult] = await Promise.all([
            classify(
              pipelineModel,
              lastUserMsg,
              categories,
              pipelineConfig,
              onTraceEvent as OnTraceEvent,
            ),
            pipelineConfig.toolFilter.enabled
              ? filterTools(
                  pipelineModel,
                  lastUserMsg,
                  tools,
                  pipelineConfig,
                  onTraceEvent as OnTraceEvent,
                )
              : Promise.resolve(undefined),
          ]);
          classifierResult = cResult;
          toolFilterResult = fResult;
        } else {
          classifierResult = await classify(
            pipelineModel,
            lastUserMsg,
            categories,
            pipelineConfig,
            onTraceEvent as OnTraceEvent,
          );
          // In sequential mode, check short-circuit before running tool filter
          const scCheck = shouldShortCircuit(classifierResult, lastUserMsg, [], pipelineConfig);
          if (!scCheck.shortCircuit && pipelineConfig.toolFilter.enabled) {
            toolFilterResult = await filterTools(
              pipelineModel,
              lastUserMsg,
              tools,
              pipelineConfig,
              onTraceEvent as OnTraceEvent,
            );
          }
        }

        recordPipelineSuccess(tenantId);

        // ─── Routing Resolver: evaluate WHEN conditions ───
        const routingRules = session.agentIR?.routing?.rules ?? [];
        const routingMatches = resolveRouting(
          classifierResult.intents,
          routingRules,
          session.data.values,
          onTraceEvent as OnTraceEvent,
        );

        // ─── Intent Bridge: populate session state ───
        if (pipelineConfig.intentBridge?.enabled && session.agentIR) {
          const intentState = bridgeIntentsToSessionState(classifierResult, routingMatches);
          session.data.values.intent = intentState;

          if (onTraceEvent) {
            onTraceEvent({
              type: 'pipeline_intent_bridge',
              data: { intentState, tier: 0 },
            });
          }
        }

        // ─── ALWAYS rebuild tools + prompt after intent bridge ───
        tools = buildTools(session);
        systemPrompt = buildSystemPrompt(session);

        // ─── Apply filtered tools (keep system tools) ───
        if (toolFilterResult?.selectedTools) {
          const systemTools = tools.filter((t) => t.name.startsWith('__'));
          const filtered = toolFilterResult.selectedTools;
          tools = [
            ...filtered,
            ...systemTools.filter((st) => !filtered.some((f) => f.name === st.name)),
          ];
        }

        // ─── Short-circuit: single high-confidence routing match ───
        const scCheck = shouldShortCircuit(classifierResult, lastUserMsg, [], pipelineConfig);
        if (scCheck.shortCircuit && routingMatches.length === 1 && routingMatches[0].target) {
          const target = routingMatches[0].target;
          const handoffResult = await this.routing.handleHandoff(
            session,
            {
              target,
              message: classifierResult.intents[0].summary,
              context: {},
            },
            onChunk,
            onTraceEvent,
          );
          return {
            response: handoffResult.response || '',
            action: { type: 'handoff', target },
            stateUpdates: buildStateUpdates(session),
          };
        }

        // ─── Multi-intent short-circuit: all intents matched, fan-out ───
        if (
          routingMatches.length >= 2 &&
          routingMatches.every((m) => m.target !== null) &&
          classifierResult.intents.every(
            (i) => i.confidence >= pipelineConfig.shortCircuit.confidenceThreshold,
          )
        ) {
          return executeParallelMultiIntentPlan(
            this.routing,
            session,
            pipelineModel,
            lastUserMsg,
            routingMatches
              .filter((m) => m.target !== null)
              .map((m) => ({
                target: m.target!,
                intent: m.intent.summary,
              })),
            'pipeline',
            onChunk,
            onTraceEvent,
          );
        }

        // ─── Tiered Action Resolution ───
        if (pipelineConfig.intentBridge?.enabled && session.agentIR) {
          const tieredAction = resolveTieredAction(
            classifierResult,
            routingMatches,
            pipelineConfig.intentBridge,
            session.agentIR,
          );

          if (onTraceEvent) {
            onTraceEvent({
              type: 'pipeline_tiered_action',
              data: {
                tier: tieredAction.tier,
                action: tieredAction.action,
                details:
                  tieredAction.action === 'decline_out_of_scope'
                    ? { message: tieredAction.message }
                    : tieredAction.action === 'guided'
                      ? {
                          hiddenTools: tieredAction.hints.hiddenTools,
                          hasMultiIntent: !!tieredAction.hints.multiIntentSignal,
                        }
                      : tieredAction.action === 'autonomous'
                        ? { reason: tieredAction.reason }
                        : {},
              },
            });
          }

          // Tier 1: Out-of-scope decline
          if (tieredAction.tier === 1 && tieredAction.action === 'decline_out_of_scope') {
            const message = tieredAction.message;
            if (onChunk) onChunk(message);
            session.conversationHistory.push({ role: 'assistant', content: message });
            return {
              response: message,
              action: { type: 'decline' },
              stateUpdates: buildStateUpdates(session),
            };
          }

          // Tier 2: Guided — hide irrelevant tools
          if (tieredAction.tier === 2 && tieredAction.action === 'guided') {
            if (tieredAction.hints.hiddenTools.length > 0) {
              const hidden = new Set(tieredAction.hints.hiddenTools);
              tools = tools.filter((t) => !hidden.has(t.name));
            }

            // Multi-intent dispatch
            if (tieredAction.hints.multiIntentSignal && classifierResult) {
              const detectedMultiIntent = bridgeToDetectedMultiIntent(
                classifierResult,
                routingMatches,
              );
              if (detectedMultiIntent) {
                const multiConfig = resolveMultiIntentConfig(session.agentIR);
                if (multiConfig.enabled) {
                  const filteredResult = filterDetectedMultiIntentAlternatives(
                    detectedMultiIntent,
                    multiConfig.confidence_threshold,
                  );
                  if (filteredResult) {
                    const plan = resolveDetectedMultiIntentPlan({
                      sessionId: session.id,
                      agentName: session.agentName,
                      agentIR: session.agentIR,
                      detected: filteredResult,
                      userMessage: lastUserMsg,
                      onTraceEvent,
                    });

                    if (plan.strategy === 'parallel' && plan.fanOutTasks?.length) {
                      return executeParallelMultiIntentPlan(
                        this.routing,
                        session,
                        pipelineModel,
                        lastUserMsg,
                        plan.fanOutTasks,
                        'guided',
                        onChunk,
                        onTraceEvent,
                      );
                    }

                    const dispatch = applyResolvedMultiIntentPlan({
                      session,
                      plan,
                      onTraceEvent,
                    });
                    if (dispatch.disambiguationMessage) {
                      if (onChunk) onChunk(dispatch.disambiguationMessage);
                      session.conversationHistory.push({
                        role: 'assistant',
                        content: dispatch.disambiguationMessage,
                      });
                      return {
                        response: dispatch.disambiguationMessage,
                        action: { type: 'multi_intent' },
                        stateUpdates: buildStateUpdates(session),
                      };
                    }
                  }
                }
              }
            }
          }

          // Tier 3: Autonomous — falls through to existing LLM loop
        }
      }
    } catch (err) {
      recordPipelineFailure(tenantId);
      log.warn('pipeline execution failed, continuing with full tool set', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 4: Build and fix type errors**

Run: `pnpm build --filter=@agent-platform/runtime`

Fix any remaining type errors. Common issues:

- Import paths for deleted functions
- `OnTraceEvent` type compatibility
- `executeParallelMultiIntentPlan` argument changes

- [ ] **Step 5: Run all runtime tests**

Run: `pnpm test --filter=@agent-platform/runtime -- --reporter=verbose`

Fix any failing tests. The pipeline-executor test was deleted in Task 9, so those won't run.

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
```

---

### Task 11: Compiler Validation — WHEN Category Warnings

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`

- [ ] **Step 1: Add validation for undeclared categories**

In `compiler.ts`, after `extractIntentCategories()` is called (around line 713), add validation when `source === 'explicit'`:

```typescript
      intent_classification: (() => {
        const { categories, source } = extractIntentCategories(doc);

        // Validate: if explicit, warn on undeclared categories in WHEN conditions
        if (source === 'explicit') {
          const declaredNames = new Set(categories.map((c) => c.name));
          const whenCategories = extractAllWhenCategories(doc);
          for (const cat of whenCategories) {
            if (!declaredNames.has(cat)) {
              constraintWarnings.push(
                `Intent category "${cat}" used in WHEN condition but not declared in INTENTS: block`,
              );
            }
          }
        }

        return { categories, min_confidence: DEFAULT_MIN_CONFIDENCE, source };
      })(),
```

Add the helper function:

```typescript
/** Extract all intent.category values from all WHEN conditions (for validation only) */
function extractAllWhenCategories(doc: AgentBasedDocument): string[] {
  const categories: string[] = [];
  const regex = /intent\.category\s*==\s*["']([^"']+)["']/g;

  for (const handoff of doc.handoff) {
    if (!handoff.when) continue;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(handoff.when)) !== null) {
      categories.push(match[1]);
    }
  }

  return categories;
}
```

- [ ] **Step 2: Build and run compiler tests**

Run: `pnpm build --filter=@abl/compiler && pnpm test --filter=@abl/compiler -- --reporter=verbose`

Expected: All tests pass. No regressions.

- [ ] **Step 3: Run prettier and commit**

```bash
npx prettier --write packages/compiler/src/platform/ir/compiler.ts
```

---

### Task 12: Full Build + Test Sweep

- [ ] **Step 1: Full build**

Run: `pnpm build`

Fix any type errors across the monorepo. Common issues:

- Other packages that import `ClassifiedIntent` or `ClassifierResult` and reference `.target` or `.shouldExecuteInAgent`
- Trace event type changes

- [ ] **Step 2: Run all tests**

Run: `pnpm test:report` to get structured output.

Review `test-reports/SUMMARY.md` for failures. Fix each one.

- [ ] **Step 3: Run prettier on all changed files**

```bash
git diff --name-only | grep '\.ts$' | xargs npx prettier --write
```

- [ ] **Step 4: Final commit**

Commit any remaining fixes.
