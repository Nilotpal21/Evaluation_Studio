# ABL Language Service — Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the shared ABL Language Service package and wire it into Studio's Monaco editor with YAML support, tiered diagnostics, document symbols, and smart completions.

**Architecture:** A new `@abl/language-service` package exports pure functions (getDiagnostics, getCompletions, getDocumentSymbols, getHoverInfo, detectFormat) that wrap `@abl/core` parser and optionally `@abl/compiler`. Studio calls these via an API route (Tier 2+) and directly in-browser (Tier 1). The Monaco editor gets a YAML-aware Monarch tokenizer and format auto-detection.

**Tech Stack:** TypeScript, Vitest, js-yaml (via @abl/core), Monaco Editor (@monaco-editor/react), Next.js API routes

**Design Doc:** `docs/plans/2026-03-01-abl-extensions-roadmap-design.md`

---

## Pre-requisite: Understand Key Files

Before starting, read these files to understand the codebase patterns:

| File                                             | Purpose                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `packages/core/src/parser/yaml-parser.ts`        | YAML ABL parser — you'll add `parseFlow()` here              |
| `packages/core/src/parser/agent-based-parser.ts` | Legacy parser — reference for flow parsing logic             |
| `packages/core/src/types/agent-based.ts`         | Type definitions for `FlowDefinition`, `FlowStep`, etc.      |
| `apps/studio/src/components/abl/ABLEditor.tsx`   | Monaco editor component — you'll modify tokenizer and wiring |
| `apps/studio/src/hooks/useABLParsing.ts`         | Parse/compile hooks — you'll add tiered diagnostics          |
| `apps/studio/src/store/editor-store.ts`          | Editor state store — you'll add new state fields             |
| `apps/studio/src/app/api/abl/parse/route.ts`     | Parse API route — reference pattern                          |

---

## Task 1: Implement `parseFlow()` in YAML Parser

The YAML parser does not parse the `flow:` section — it is silently dropped. This blocks document symbols, completions, and validation for scripted agents.

**Files:**

- Modify: `packages/core/src/parser/yaml-parser.ts`
- Test: `packages/core/src/__tests__/yaml-flow-parser.test.ts` (create)
- Reference: `packages/core/src/parser/agent-based-parser.ts` (read-only — legacy flow parser at lines 471+)
- Reference: `packages/core/src/types/agent-based.ts` (read-only — `FlowDefinition` at line 289, `FlowStep` at line 218)

**Step 1: Write the failing test**

Create `packages/core/src/__tests__/yaml-flow-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseYamlABL } from '../parser/yaml-parser';

describe('YAML flow parser', () => {
  it('parses a simple flow with steps and transitions', () => {
    const yaml = `
agent: booking_agent
mode: scripted
goal: Help users book hotels

flow:
  entry_point: greeting
  steps:
    greeting:
      respond: "Welcome! How can I help?"
      then: search

    search:
      gather:
        fields:
          - name: destination
            type: string
            required: true
          - name: check_in
            type: string
      then: confirm

    confirm:
      respond: "Booking confirmed!"
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    expect(result.document).toBeDefined();
    expect(result.document!.flow).toBeDefined();
    expect(result.document!.flow!.entryPoint).toBe('greeting');
    expect(result.document!.flow!.steps).toEqual(['greeting', 'search', 'confirm']);
    expect(Object.keys(result.document!.flow!.definitions)).toHaveLength(3);

    const greeting = result.document!.flow!.definitions['greeting'];
    expect(greeting.respond).toBe('Welcome! How can I help?');
    expect(greeting.then).toBe('search');

    const search = result.document!.flow!.definitions['search'];
    expect(search.gather).toBeDefined();
    expect(search.gather!.fields).toHaveLength(2);
    expect(search.gather!.fields[0].name).toBe('destination');
    expect(search.gather!.fields[0].type).toBe('string');
    expect(search.gather!.fields[0].required).toBe(true);
    expect(search.then).toBe('confirm');
  });

  it('parses flow step with CALL and ON_SUCCESS/ON_FAILURE', () => {
    const yaml = `
agent: test_agent
mode: scripted
flow:
  steps:
    do_search:
      call: search_hotels
      on_success:
        respond: "Found results!"
        then: present
      on_failure:
        respond: "Search failed, please try again."
        then: do_search
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['do_search'];
    expect(step.call).toBe('search_hotels');
    expect(step.onSuccess).toBeDefined();
    expect(step.onSuccess!.respond).toBe('Found results!');
    expect(step.onSuccess!.then).toBe('present');
    expect(step.onFailure).toBeDefined();
    expect(step.onFailure!.respond).toBe('Search failed, please try again.');
    expect(step.onFailure!.then).toBe('do_search');
  });

  it('parses flow step with SET assignments', () => {
    const yaml = `
agent: test_agent
mode: scripted
flow:
  steps:
    init:
      set:
        - variable: greeting_count
          expression: "0"
        - variable: language
          expression: "'en'"
      then: greet
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['init'];
    expect(step.set).toHaveLength(2);
    expect(step.set![0].variable).toBe('greeting_count');
    expect(step.set![0].expression).toBe('0');
  });

  it('parses flow step with WHEN guard condition', () => {
    const yaml = `
agent: test_agent
mode: scripted
flow:
  steps:
    vip_greeting:
      when: "context.user.tier == 'vip'"
      respond: "Welcome back, VIP member!"
      then: search
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['vip_greeting'];
    expect(step.when).toBe("context.user.tier == 'vip'");
  });

  it('returns flow as undefined when no flow section exists', () => {
    const yaml = `
agent: reasoning_agent
mode: reasoning
goal: Help users
`;
    const result = parseYamlABL(yaml);
    expect(result.document!.flow).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @abl/core run test -- --run src/__tests__/yaml-flow-parser.test.ts`
Expected: FAIL — `result.document.flow` is `undefined` because `parseFlow()` doesn't exist yet.

**Step 3: Implement `parseFlow()` and `parseFlowStep()`**

In `packages/core/src/parser/yaml-parser.ts`, add after the existing helper functions (after `parseOnError()`):

```typescript
function parseFlowGatherField(raw: Record<string, unknown>): FlowGatherField {
  return {
    name: asString(raw['name']) ?? '',
    type: asString(raw['type']),
    required: raw['required'] === true,
    prompt: asString(raw['prompt']),
    validation: asString(raw['validation']),
    extractionHints: Array.isArray(raw['extraction_hints'])
      ? raw['extraction_hints'].map(String)
      : undefined,
    defaultValue: raw['default'] !== undefined ? String(raw['default']) : undefined,
    options: Array.isArray(raw['options']) ? raw['options'].map(String) : undefined,
  };
}

function parseFlowGatherConfig(raw: unknown): FlowGatherConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as Record<string, unknown>;
  const fields: FlowGatherField[] = [];
  if (Array.isArray(data['fields'])) {
    for (const f of data['fields']) {
      if (f && typeof f === 'object') {
        fields.push(parseFlowGatherField(f as Record<string, unknown>));
      }
    }
  }
  return {
    fields,
    strategy: asString(data['strategy']),
    prompt: asString(data['prompt']),
  };
}

function parseSetAssignments(raw: unknown): SetAssignment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
    .map((item) => ({
      variable: asString(item['variable']) ?? '',
      expression: asString(item['expression']) ?? '',
    }));
}

function parseCallResultBranch(
  raw: unknown,
): { respond?: string; then?: string; set?: SetAssignment[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as Record<string, unknown>;
  return {
    respond: asString(data['respond']),
    then: asString(data['then']),
    set: data['set'] ? parseSetAssignments(data['set']) : undefined,
  };
}

function parseFlowStep(name: string, raw: unknown): FlowStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;

  const step: FlowStep = { name };

  // Guard condition
  if (data['when'] !== undefined) step.when = asString(data['when']);

  // Basic actions
  if (data['respond'] !== undefined) step.respond = asString(data['respond']);
  if (data['call'] !== undefined) step.call = asString(data['call']);
  if (data['then'] !== undefined) step.then = asString(data['then']);

  // Max attempts
  if (data['max_attempts'] !== undefined) step.maxAttempts = Number(data['max_attempts']);

  // SET assignments
  if (data['set']) step.set = parseSetAssignments(data['set']);

  // GATHER config
  if (data['gather']) step.gather = parseFlowGatherConfig(data['gather']);

  // ON_SUCCESS / ON_FAILURE branches
  if (data['on_success']) step.onSuccess = parseCallResultBranch(data['on_success']);
  if (data['on_failure']) step.onFailure = parseCallResultBranch(data['on_failure']);

  // CALL WITH / CALL AS
  if (data['call_with'] && typeof data['call_with'] === 'object') {
    step.callWith = data['call_with'] as Record<string, string>;
  }
  if (data['call_as'] !== undefined) step.callAs = asString(data['call_as']);

  return step;
}

function parseFlow(raw: unknown): FlowDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as Record<string, unknown>;

  const steps: string[] = [];
  const definitions: Record<string, FlowStep> = {};

  // Parse steps
  const stepsData = data['steps'];
  if (stepsData && typeof stepsData === 'object' && !Array.isArray(stepsData)) {
    const stepsRecord = stepsData as Record<string, unknown>;
    for (const [stepName, stepDef] of Object.entries(stepsRecord)) {
      const step = parseFlowStep(stepName, stepDef);
      if (step) {
        steps.push(stepName);
        definitions[stepName] = step;
      }
    }
  }

  if (steps.length === 0) return undefined;

  return {
    steps,
    definitions,
    entryPoint: asString(data['entry_point']),
  };
}
```

Then in the `parseYamlABL()` function's document builder (around the line where `doc` object is constructed), add:

```typescript
// After existing fields in the doc object, add:
flow: parseFlow(data['flow']),
```

Import the types at the top of the file — add `FlowDefinition`, `FlowStep`, `FlowGatherConfig`, `FlowGatherField`, `SetAssignment` to the existing import from `../types/agent-based`.

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/core run test -- --run src/__tests__/yaml-flow-parser.test.ts`
Expected: All 5 tests PASS.

**Step 5: Run existing tests to verify no regressions**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/core run test -- --run`
Expected: All existing tests PASS (the new flow parser only activates when a `flow:` key exists in YAML).

**Step 6: Commit**

```bash
git add packages/core/src/parser/yaml-parser.ts packages/core/src/__tests__/yaml-flow-parser.test.ts
git commit -m "feat(core): implement parseFlow() in YAML parser for scripted agent flow sections"
```

---

## Task 2: Scaffold `@abl/language-service` Package

Create the package with proper monorepo wiring.

**Files:**

- Create: `packages/language-service/package.json`
- Create: `packages/language-service/tsconfig.json`
- Create: `packages/language-service/vitest.config.ts`
- Create: `packages/language-service/src/index.ts`
- Create: `packages/language-service/src/types.ts`

**Step 1: Check existing package structure for patterns**

Read any existing `packages/*/package.json` for monorepo naming conventions. The existing pattern uses `@abl/core`, `@abl/compiler`, `@abl/analyzer` for core packages.

**Step 2: Create package.json**

Create `packages/language-service/package.json`:

```json
{
  "name": "@abl/language-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:fast": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@abl/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^2.1.0"
  }
}
```

Note: `@abl/compiler` is NOT a dependency. Compile-level diagnostics use dependency injection (design review decision C1).

**Step 3: Create tsconfig.json**

Create `packages/language-service/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 4: Create vitest.config.ts**

Create `packages/language-service/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
  },
});
```

**Step 5: Create types**

Create `packages/language-service/src/types.ts`:

```typescript
/**
 * Position in a document (1-based line, 1-based column).
 */
export interface Position {
  line: number;
  column: number;
}

/**
 * Severity level for diagnostics.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * A diagnostic message with position information.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source?: string; // 'syntax' | 'structural' | 'compile'
}

/**
 * A symbol in the document outline (tree-view).
 */
export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine?: number;
  children: DocumentSymbol[];
}

export type SymbolKind =
  | 'agent'
  | 'section'
  | 'tool'
  | 'step'
  | 'field'
  | 'constraint'
  | 'handoff'
  | 'delegate'
  | 'handler';

/**
 * A completion suggestion.
 */
export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText: string;
  sortOrder?: number;
}

export type CompletionKind =
  | 'keyword'
  | 'section'
  | 'tool'
  | 'agent'
  | 'function'
  | 'field'
  | 'value';

/**
 * Context passed to getCompletions for project-aware suggestions.
 */
export interface CompletionContext {
  availableTools?: Array<{ name: string; type?: string; description?: string }>;
  availableAgents?: Array<{ name: string }>;
  format?: 'yaml' | 'legacy';
}

/**
 * Hover information for a position.
 */
export interface HoverInfo {
  contents: string; // Markdown
  line: number;
  column: number;
}

/**
 * Optional compile function injected for Tier 3 diagnostics.
 * This allows the language service to remain free of @abl/compiler dependencies.
 */
export type CompileFn = (source: string) => Diagnostic[];
```

**Step 6: Create index.ts barrel**

Create `packages/language-service/src/index.ts`:

```typescript
export type {
  Position,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  SymbolKind,
  CompletionItem,
  CompletionKind,
  CompletionContext,
  HoverInfo,
  CompileFn,
} from './types';

export { detectFormat } from './detect-format';
export { getDiagnostics } from './diagnostics';
export { getDocumentSymbols } from './symbols';
export { getCompletions } from './completions';
export { getHoverInfo } from './hover';
```

**Step 7: Install dependencies and verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install && pnpm --filter @abl/language-service build`
Expected: Build succeeds (will have import errors for missing modules — that's fine, we'll create them in subsequent tasks).

**Step 8: Commit**

```bash
git add packages/language-service/
git commit -m "feat(language-service): scaffold @abl/language-service package with types"
```

---

## Task 3: Implement `detectFormat()`

Detect whether ABL source is YAML or legacy format.

**Files:**

- Create: `packages/language-service/src/detect-format.ts`
- Test: `packages/language-service/src/__tests__/detect-format.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/detect-format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectFormat } from '../detect-format';

describe('detectFormat', () => {
  it('detects YAML format from colon-separated keys', () => {
    const yaml = `agent: booking\nmode: scripted\ngoal: Help users`;
    expect(detectFormat(yaml)).toBe('yaml');
  });

  it('detects legacy format from uppercase section headers', () => {
    const legacy = `AGENT: booking\nMODE: scripted\nGOAL:\n  Help users book hotels`;
    expect(detectFormat(legacy)).toBe('legacy');
  });

  it('detects YAML from indented mapping style', () => {
    const yaml = `agent: test\ntools:\n  - search_hotels\n  - book_room`;
    expect(detectFormat(yaml)).toBe('yaml');
  });

  it('returns legacy for empty input', () => {
    expect(detectFormat('')).toBe('legacy');
  });

  it('detects YAML from lowercase keys', () => {
    const yaml = `agent: test\nconstraints:\n  - rule: "no profanity"`;
    expect(detectFormat(yaml)).toBe('yaml');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/detect-format.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement detectFormat**

Create `packages/language-service/src/detect-format.ts`:

```typescript
/**
 * Detect whether ABL source is YAML or legacy format.
 *
 * YAML format uses lowercase keys: `agent:`, `mode:`, `tools:`
 * Legacy format uses uppercase section headers: `AGENT:`, `MODE:`, `TOOLS:`
 *
 * Heuristic: check if the first non-empty, non-comment line starts with
 * a lowercase key followed by a colon (YAML) or an uppercase key (legacy).
 */
export function detectFormat(source: string): 'yaml' | 'legacy' {
  const lines = source.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // YAML format: lowercase key followed by colon
    // e.g., "agent: booking" or "tools:"
    if (/^[a-z][a-z_]*\s*:/.test(trimmed)) {
      return 'yaml';
    }

    // Legacy format: uppercase key followed by colon or space
    // e.g., "AGENT: booking" or "AGENT booking"
    if (/^[A-Z][A-Z_]*[\s:]/.test(trimmed)) {
      return 'legacy';
    }

    // If the first meaningful line doesn't match either pattern, default to legacy
    return 'legacy';
  }

  return 'legacy';
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/detect-format.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/language-service/src/detect-format.ts packages/language-service/src/__tests__/detect-format.test.ts
git commit -m "feat(language-service): implement detectFormat() for YAML vs legacy detection"
```

---

## Task 4: Implement `getDiagnostics()`

Return parse errors and warnings with line/column positions.

**Files:**

- Create: `packages/language-service/src/diagnostics.ts`
- Test: `packages/language-service/src/__tests__/diagnostics.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/diagnostics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDiagnostics } from '../diagnostics';

describe('getDiagnostics', () => {
  it('returns no diagnostics for valid YAML ABL', () => {
    const yaml = `agent: booking\nmode: reasoning\ngoal: Help users`;
    const diags = getDiagnostics(yaml);
    expect(diags).toHaveLength(0);
  });

  it('returns error diagnostics for invalid YAML syntax', () => {
    const yaml = `agent: booking\nmode: [invalid yaml`;
    const diags = getDiagnostics(yaml);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].source).toBe('syntax');
  });

  it('returns warning diagnostics from parser warnings', () => {
    // Valid YAML but with parser-level warnings (if any)
    const yaml = `agent: test\nmode: reasoning\ngoal: Help`;
    const diags = getDiagnostics(yaml);
    // Should not crash — may return 0 or more warnings
    expect(Array.isArray(diags)).toBe(true);
  });

  it('includes compile diagnostics when compileFn is provided', () => {
    const yaml = `agent: test\nmode: reasoning`;
    const mockCompileFn = () => [
      {
        severity: 'error' as const,
        message: 'Missing goal',
        line: 1,
        column: 1,
        source: 'compile',
      },
    ];
    const diags = getDiagnostics(yaml, { compileFn: mockCompileFn });
    expect(diags.some((d) => d.source === 'compile')).toBe(true);
  });

  it('handles legacy format', () => {
    const legacy = `AGENT: booking\nMODE: reasoning\nGOAL:\n  Help users`;
    const diags = getDiagnostics(legacy);
    expect(Array.isArray(diags)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/diagnostics.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement getDiagnostics**

Create `packages/language-service/src/diagnostics.ts`:

```typescript
import { parseYamlABL, isYamlFormat } from '@abl/core/parser/yaml-parser';
import { parseAgentBasedABL } from '@abl/core';
import { detectFormat } from './detect-format';
import type { Diagnostic, CompileFn } from './types';

interface DiagnosticsOptions {
  compileFn?: CompileFn;
}

/**
 * Get diagnostics (errors + warnings) for ABL source.
 *
 * Runs parse-level validation. If compileFn is provided, also runs
 * compile-level validation (Tier 3 — injected to avoid @abl/compiler dependency).
 */
export function getDiagnostics(source: string, options?: DiagnosticsOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const format = detectFormat(source);

  try {
    if (format === 'yaml') {
      const result = parseYamlABL(source);

      for (const err of result.errors) {
        diagnostics.push({
          severity: 'error',
          message: err.message,
          line: err.line ?? 1,
          column: err.column ?? 1,
          source: 'syntax',
        });
      }

      for (const warn of result.warnings) {
        diagnostics.push({
          severity: 'warning',
          message: warn.message,
          line: warn.line ?? 1,
          column: 1,
          source: 'syntax',
        });
      }
    } else {
      const result = parseAgentBasedABL(source);

      for (const err of result.errors) {
        diagnostics.push({
          severity: 'error',
          message: err.message,
          line: err.line ?? 1,
          column: err.column ?? 1,
          source: 'syntax',
        });
      }

      for (const warn of result.warnings) {
        diagnostics.push({
          severity: 'warning',
          message: warn.message,
          line: warn.line ?? 1,
          column: 1,
          source: 'syntax',
        });
      }
    }
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
      line: 1,
      column: 1,
      source: 'syntax',
    });
  }

  // Tier 3: compile-level diagnostics (optional)
  if (options?.compileFn) {
    try {
      const compileDiags = options.compileFn(source);
      diagnostics.push(...compileDiags);
    } catch {
      // Compile errors should not crash diagnostics
    }
  }

  return diagnostics;
}
```

Note: The imports from `@abl/core` may need adjustment based on the actual export paths. Check `packages/core/src/index.ts` for the exact exports. If `parseYamlABL` is not directly exported, import from the file path or add it to the core package exports.

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/diagnostics.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/language-service/src/diagnostics.ts packages/language-service/src/__tests__/diagnostics.test.ts
git commit -m "feat(language-service): implement getDiagnostics() with parse + optional compile tiers"
```

---

## Task 5: Implement `getDocumentSymbols()`

Extract document outline for the tree-view navigator.

**Files:**

- Create: `packages/language-service/src/symbols.ts`
- Test: `packages/language-service/src/__tests__/symbols.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/symbols.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDocumentSymbols } from '../symbols';

describe('getDocumentSymbols', () => {
  it('returns agent symbol with sections for YAML', () => {
    const yaml = `agent: booking_agent\nmode: reasoning\ngoal: Help users\ntools:\n  - search_hotels\n  - book_room`;
    const symbols = getDocumentSymbols(yaml);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('booking_agent');
    expect(symbols[0].kind).toBe('agent');

    const toolsSection = symbols[0].children.find((c) => c.name === 'Tools');
    expect(toolsSection).toBeDefined();
    expect(toolsSection!.children).toHaveLength(2);
    expect(toolsSection!.children[0].name).toBe('search_hotels');
    expect(toolsSection!.children[0].kind).toBe('tool');
  });

  it('returns flow steps as children of Flow section', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      respond: Hello\n    search:\n      call: search_hotels\n    confirm:\n      respond: Done`;
    const symbols = getDocumentSymbols(yaml);
    const flowSection = symbols[0].children.find((c) => c.name === 'Flow');
    expect(flowSection).toBeDefined();
    expect(flowSection!.children).toHaveLength(3);
    expect(flowSection!.children[0].name).toBe('greeting');
    expect(flowSection!.children[0].kind).toBe('step');
  });

  it('returns constraints as children', () => {
    const yaml = `agent: test\nmode: reasoning\nconstraints:\n  - rule: "Be polite"\n    action: warn`;
    const symbols = getDocumentSymbols(yaml);
    const constraintsSection = symbols[0].children.find((c) => c.name === 'Constraints');
    expect(constraintsSection).toBeDefined();
    expect(constraintsSection!.children.length).toBeGreaterThan(0);
  });

  it('returns handoffs as children', () => {
    const yaml = `agent: test\nmode: reasoning\nhandoff:\n  - to: support_agent\n    condition: "needs_support"`;
    const symbols = getDocumentSymbols(yaml);
    const handoffSection = symbols[0].children.find((c) => c.name === 'Handoffs');
    expect(handoffSection).toBeDefined();
    expect(handoffSection!.children[0].name).toContain('support_agent');
  });

  it('returns empty array for unparseable input', () => {
    const symbols = getDocumentSymbols('');
    expect(symbols).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/symbols.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement getDocumentSymbols**

Create `packages/language-service/src/symbols.ts`:

```typescript
import { parseYamlABL } from '@abl/core/parser/yaml-parser';
import { parseAgentBasedABL } from '@abl/core';
import { detectFormat } from './detect-format';
import type { DocumentSymbol, SymbolKind } from './types';

function findLineForKey(source: string, key: string): number {
  const lines = source.split('\n');
  const pattern = new RegExp(`^\\s*${key}\\s*:`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return 1;
}

function findLineForValue(source: string, sectionKey: string, value: string): number {
  const lines = source.split('\n');
  let inSection = false;
  const sectionPattern = new RegExp(`^\\s*${sectionKey}\\s*:`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (sectionPattern.test(lines[i])) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // Check if we left the section (new top-level key)
      if (
        /^\S/.test(lines[i]) &&
        !lines[i].trim().startsWith('-') &&
        !lines[i].trim().startsWith('#')
      ) {
        inSection = false;
        continue;
      }
      if (lines[i].includes(value)) return i + 1;
    }
  }
  return 1;
}

function makeSymbol(
  name: string,
  kind: SymbolKind,
  line: number,
  children: DocumentSymbol[] = [],
): DocumentSymbol {
  return { name, kind, line, children };
}

/**
 * Extract document symbols (outline) from ABL source.
 * Returns a hierarchical tree: Agent -> Sections -> Items.
 */
export function getDocumentSymbols(source: string): DocumentSymbol[] {
  if (!source.trim()) return [];

  const format = detectFormat(source);

  try {
    const result = format === 'yaml' ? parseYamlABL(source) : parseAgentBasedABL(source);
    const doc = result.document;
    if (!doc) return [];

    const agentName = doc.name || 'unnamed';
    const agentLine = findLineForKey(source, format === 'yaml' ? 'agent' : 'AGENT');
    const agentSymbol = makeSymbol(agentName, 'agent', agentLine);

    // Goal
    if (doc.goal) {
      agentSymbol.children.push(
        makeSymbol('Goal', 'section', findLineForKey(source, format === 'yaml' ? 'goal' : 'GOAL')),
      );
    }

    // Tools
    if (doc.tools && doc.tools.length > 0) {
      const toolsLine = findLineForKey(source, format === 'yaml' ? 'tools' : 'TOOLS');
      const toolChildren = doc.tools.map((t) => {
        const toolName = typeof t === 'string' ? t : t.name || 'unnamed';
        return makeSymbol(
          toolName,
          'tool',
          findLineForValue(source, format === 'yaml' ? 'tools' : 'TOOLS', toolName),
        );
      });
      agentSymbol.children.push(makeSymbol('Tools', 'section', toolsLine, toolChildren));
    }

    // Flow
    if (doc.flow && doc.flow.definitions) {
      const flowLine = findLineForKey(source, format === 'yaml' ? 'flow' : 'FLOW');
      const stepChildren = doc.flow.steps.map((stepName) =>
        makeSymbol(stepName, 'step', findLineForValue(source, 'steps', stepName)),
      );
      agentSymbol.children.push(makeSymbol('Flow', 'section', flowLine, stepChildren));
    }

    // Constraints
    if (doc.constraints && doc.constraints.length > 0) {
      const constraintsLine = findLineForKey(
        source,
        format === 'yaml' ? 'constraints' : 'CONSTRAINTS',
      );
      const constraintChildren = doc.constraints.map((c, i) => {
        const label = c.rule ? c.rule.substring(0, 40) : `Constraint ${i + 1}`;
        return makeSymbol(label, 'constraint', constraintsLine + i + 1);
      });
      agentSymbol.children.push(
        makeSymbol('Constraints', 'section', constraintsLine, constraintChildren),
      );
    }

    // Gather
    if (doc.gather && doc.gather.fields && doc.gather.fields.length > 0) {
      const gatherLine = findLineForKey(source, format === 'yaml' ? 'gather' : 'GATHER');
      const fieldChildren = doc.gather.fields.map((f) =>
        makeSymbol(
          f.name || 'unnamed',
          'field',
          findLineForValue(source, format === 'yaml' ? 'gather' : 'GATHER', f.name || ''),
        ),
      );
      agentSymbol.children.push(makeSymbol('Gather', 'section', gatherLine, fieldChildren));
    }

    // Handoffs
    if (doc.handoff && doc.handoff.length > 0) {
      const handoffLine = findLineForKey(source, format === 'yaml' ? 'handoff' : 'HANDOFF');
      const handoffChildren = doc.handoff.map((h) => {
        const target = h.to || 'unknown';
        return makeSymbol(
          `-> ${target}`,
          'handoff',
          findLineForValue(source, format === 'yaml' ? 'handoff' : 'HANDOFF', target),
        );
      });
      agentSymbol.children.push(makeSymbol('Handoffs', 'section', handoffLine, handoffChildren));
    }

    // Delegates
    if (doc.delegate && doc.delegate.length > 0) {
      const delegateLine = findLineForKey(source, format === 'yaml' ? 'delegate' : 'DELEGATE');
      const delegateChildren = doc.delegate.map((d) =>
        makeSymbol(`-> ${d.to || 'unknown'}`, 'delegate', delegateLine),
      );
      agentSymbol.children.push(makeSymbol('Delegates', 'section', delegateLine, delegateChildren));
    }

    return [agentSymbol];
  } catch {
    return [];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/symbols.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/language-service/src/symbols.ts packages/language-service/src/__tests__/symbols.test.ts
git commit -m "feat(language-service): implement getDocumentSymbols() for ABL outline tree"
```

---

## Task 6: Implement `getCompletions()`

Context-aware completion suggestions.

**Files:**

- Create: `packages/language-service/src/completions.ts`
- Test: `packages/language-service/src/__tests__/completions.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/completions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getCompletions } from '../completions';
import type { CompletionContext } from '../types';

describe('getCompletions', () => {
  it('suggests top-level YAML keys at start of empty line', () => {
    const yaml = `agent: test\n`;
    const completions = getCompletions(yaml, { line: 2, column: 1 });
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('mode');
    expect(labels).toContain('goal');
    expect(labels).toContain('tools');
    expect(labels).toContain('flow');
    expect(labels).toContain('constraints');
  });

  it('suggests tool names inside tools section', () => {
    const yaml = `agent: test\ntools:\n  - `;
    const ctx: CompletionContext = {
      availableTools: [
        { name: 'search_hotels', type: 'HTTP', description: 'Search for hotels' },
        { name: 'book_room', type: 'MCP', description: 'Book a room' },
      ],
    };
    const completions = getCompletions(yaml, { line: 3, column: 5 }, ctx);
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('search_hotels');
    expect(labels).toContain('book_room');
  });

  it('suggests flow step keywords inside a flow step', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      `;
    const completions = getCompletions(yaml, { line: 6, column: 7 });
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('respond');
    expect(labels).toContain('call');
    expect(labels).toContain('then');
    expect(labels).toContain('gather');
    expect(labels).toContain('set');
    expect(labels).toContain('when');
  });

  it('suggests agent names for handoff targets', () => {
    const yaml = `agent: test\nhandoff:\n  - to: `;
    const ctx: CompletionContext = {
      availableAgents: [{ name: 'support_agent' }, { name: 'billing_agent' }],
    };
    const completions = getCompletions(yaml, { line: 3, column: 9 }, ctx);
    const labels = completions.map((c) => c.label);
    expect(labels).toContain('support_agent');
    expect(labels).toContain('billing_agent');
  });

  it('returns empty for unrecognized context', () => {
    const yaml = `some random text`;
    const completions = getCompletions(yaml, { line: 1, column: 17 });
    // May return top-level suggestions or empty — should not crash
    expect(Array.isArray(completions)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/completions.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement getCompletions**

Create `packages/language-service/src/completions.ts`:

```typescript
import type { Position, CompletionItem, CompletionContext, CompletionKind } from './types';

const TOP_LEVEL_YAML_KEYS = [
  { label: 'agent', detail: 'Agent name', doc: 'The name identifier for this agent' },
  { label: 'mode', detail: 'Execution mode', doc: 'reasoning | scripted' },
  { label: 'goal', detail: 'Agent goal', doc: 'What this agent aims to accomplish' },
  { label: 'persona', detail: 'Agent persona', doc: 'Personality and communication style' },
  { label: 'tools', detail: 'Available tools', doc: 'List of tools the agent can use' },
  { label: 'flow', detail: 'Flow definition', doc: 'Scripted conversation flow with steps' },
  { label: 'gather', detail: 'Data gathering', doc: 'Fields to collect from the user' },
  { label: 'constraints', detail: 'Behavior constraints', doc: 'Rules the agent must follow' },
  { label: 'handoff', detail: 'Handoff targets', doc: 'Agents to hand off to' },
  { label: 'delegate', detail: 'Delegate targets', doc: 'Agents to delegate tasks to' },
  { label: 'escalate', detail: 'Escalation config', doc: 'When and how to escalate' },
  { label: 'memory', detail: 'Memory config', doc: 'Session and persistent memory settings' },
  { label: 'guardrails', detail: 'Guardrails', doc: 'Safety guardrails for agent behavior' },
  { label: 'on_error', detail: 'Error handlers', doc: 'How to handle errors' },
  { label: 'complete', detail: 'Completion config', doc: 'How the agent completes conversations' },
];

const FLOW_STEP_KEYS = [
  { label: 'respond', detail: 'Send message', doc: 'Message to send to the user' },
  { label: 'call', detail: 'Call tool', doc: 'Tool to invoke' },
  { label: 'then', detail: 'Next step', doc: 'Step to transition to' },
  { label: 'gather', detail: 'Collect data', doc: 'Fields to gather in this step' },
  { label: 'set', detail: 'Set variables', doc: 'Variable assignments' },
  { label: 'when', detail: 'Guard condition', doc: 'CEL condition to enter this step' },
  { label: 'on_success', detail: 'Success handler', doc: 'Actions on successful tool call' },
  { label: 'on_failure', detail: 'Failure handler', doc: 'Actions on failed tool call' },
  { label: 'call_with', detail: 'Tool parameters', doc: 'Parameters to pass to the tool' },
  { label: 'max_attempts', detail: 'Max retries', doc: 'Maximum number of attempts for this step' },
];

function makeCompletion(
  label: string,
  kind: CompletionKind,
  detail?: string,
  doc?: string,
  sortOrder?: number,
): CompletionItem {
  return {
    label,
    kind,
    detail,
    documentation: doc,
    insertText: kind === 'section' || kind === 'keyword' ? `${label}: ` : label,
    sortOrder,
  };
}

/**
 * Determine the completion context from cursor position and surrounding lines.
 */
function getContext(
  source: string,
  position: Position,
): 'top-level' | 'tools' | 'flow-step' | 'handoff-to' | 'delegate-to' | 'unknown' {
  const lines = source.split('\n');
  const currentLine = lines[position.line - 1] ?? '';
  const trimmedCurrent = currentLine.trim();

  // Check if current line has "to:" pattern (handoff/delegate target)
  if (/^\s*-?\s*to:\s*$/.test(currentLine) || trimmedCurrent.startsWith('to: ')) {
    // Scan upward to see if we're in handoff or delegate section
    for (let i = position.line - 2; i >= 0; i--) {
      const line = lines[i].trim();
      if (/^handoff\s*:/i.test(line)) return 'handoff-to';
      if (/^delegate\s*:/i.test(line)) return 'delegate-to';
      if (/^[a-z][a-z_]*\s*:/i.test(line) && !/^\s/.test(lines[i])) break;
    }
  }

  // Scan upward to find enclosing section
  for (let i = position.line - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();

    // Top-level key at column 0 — we're in that section
    if (/^[a-z][a-z_]*\s*:/i.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (/^tools\s*:/i.test(trimmed)) return 'tools';
      if (/^flow\s*:/i.test(trimmed)) {
        // Check if we're inside a step definition (indented deeper than 'steps:')
        const currentIndent = currentLine.search(/\S/);
        if (currentIndent >= 6) return 'flow-step';
        return 'unknown';
      }
      if (/^handoff\s*:/i.test(trimmed)) return 'handoff-to';
      if (/^delegate\s*:/i.test(trimmed)) return 'delegate-to';
      // Any other top-level section — don't suggest top-level keys
      return 'unknown';
    }

    // Check for steps: section inside flow
    if (/^\s+steps\s*:/i.test(line)) {
      const currentIndent = currentLine.search(/\S/);
      if (currentIndent >= 6) return 'flow-step';
    }
  }

  // If we didn't find any enclosing section, we're at top level
  return 'top-level';
}

/**
 * Get context-aware completion suggestions at a cursor position.
 */
export function getCompletions(
  source: string,
  position: Position,
  context?: CompletionContext,
): CompletionItem[] {
  const ctx = getContext(source, position);

  switch (ctx) {
    case 'top-level':
      return TOP_LEVEL_YAML_KEYS.map((k, i) =>
        makeCompletion(k.label, 'section', k.detail, k.doc, i),
      );

    case 'tools':
      if (context?.availableTools) {
        return context.availableTools.map((t, i) =>
          makeCompletion(t.name, 'tool', t.type ? `[${t.type}]` : undefined, t.description, i),
        );
      }
      return [];

    case 'flow-step':
      return FLOW_STEP_KEYS.map((k, i) => makeCompletion(k.label, 'keyword', k.detail, k.doc, i));

    case 'handoff-to':
    case 'delegate-to':
      if (context?.availableAgents) {
        return context.availableAgents.map((a, i) =>
          makeCompletion(a.name, 'agent', 'Agent', undefined, i),
        );
      }
      return [];

    default:
      return [];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/completions.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add packages/language-service/src/completions.ts packages/language-service/src/__tests__/completions.test.ts
git commit -m "feat(language-service): implement getCompletions() with context-aware suggestions"
```

---

## Task 7: Implement `getHoverInfo()`

Provide documentation on hover for ABL keywords and CEL functions.

**Files:**

- Create: `packages/language-service/src/hover.ts`
- Create: `packages/language-service/src/docs.ts`
- Test: `packages/language-service/src/__tests__/hover.test.ts`

**Step 1: Write the failing test**

Create `packages/language-service/src/__tests__/hover.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getHoverInfo } from '../hover';

describe('getHoverInfo', () => {
  it('returns hover info for mode keyword', () => {
    const yaml = `agent: test\nmode: reasoning`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('mode');
  });

  it('returns hover info for tools keyword', () => {
    const yaml = `agent: test\ntools:\n  - search`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('tools');
  });

  it('returns null for non-keyword positions', () => {
    const yaml = `agent: test\nmode: reasoning`;
    // Column well past any keyword
    const hover = getHoverInfo(yaml, { line: 2, column: 20 });
    // May or may not return info for "reasoning" value
    // Should not crash
    expect(hover === null || hover !== null).toBe(true);
  });

  it('returns hover info for gather keyword', () => {
    const yaml = `agent: test\ngather:\n  fields:\n    - name: email`;
    const hover = getHoverInfo(yaml, { line: 2, column: 1 });
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('gather');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/hover.test.ts`
Expected: FAIL — module not found.

**Step 3: Create docs.ts with keyword documentation**

Create `packages/language-service/src/docs.ts`:

```typescript
/**
 * Keyword documentation for hover info.
 * Each entry maps a keyword to its markdown documentation.
 */
export const KEYWORD_DOCS: Record<string, string> = {
  agent:
    '**agent** — The name identifier for this agent.\n\nUsed as a reference in handoffs, delegates, and supervisor routing.',
  mode: '**mode** — The execution mode.\n\n- `reasoning`: LLM-driven, uses tools and constraints to achieve the goal\n- `scripted`: Flow-based, follows a defined step sequence',
  goal: '**goal** — What this agent aims to accomplish.\n\nProvided to the LLM as the primary objective. Should be clear and specific.',
  persona:
    "**persona** — The agent's personality and communication style.\n\nDefines tone, formality, and behavioral characteristics.",
  tools:
    "**tools** — List of tools the agent can use.\n\nEach tool is referenced by name and must be defined in the project's tool registry.",
  flow: '**flow** — Scripted conversation flow.\n\nDefines a sequence of steps with transitions, gather fields, tool calls, and branching logic.\n\nOnly used in `mode: scripted` agents.',
  gather:
    '**gather** — Data gathering configuration.\n\nDefines fields to collect from the user, with types, validation, and extraction hints.',
  constraints:
    '**constraints** — Behavior constraints.\n\nRules the agent must follow. Each constraint has a `rule` (CEL expression) and an `action` (warn, block, escalate).',
  handoff:
    '**handoff** — Handoff targets.\n\nOther agents this agent can transfer the conversation to, with optional conditions.',
  delegate:
    '**delegate** — Delegate targets.\n\nOther agents this agent can delegate subtasks to, receiving results back.',
  escalate:
    '**escalate** — Escalation configuration.\n\nWhen and how to escalate to a human agent or supervisor.',
  memory:
    '**memory** — Memory configuration.\n\n- `session`: Per-conversation memory (cleared on session end)\n- `persistent`: Cross-session memory (retained across conversations)',
  guardrails:
    '**guardrails** — Safety guardrails.\n\nInput/output filters and safety checks applied to all agent interactions.',
  on_error:
    '**on_error** — Error handlers.\n\nDefines recovery behavior when tools fail, LLM errors occur, or constraints are violated.',
  complete:
    '**complete** — Completion configuration.\n\nHow the agent signals conversation completion and what message to send.',
  respond:
    '**respond** — Send a message to the user.\n\nThe message text to display. Supports template variables: `{{variable_name}}`.',
  call: '**call** — Invoke a tool.\n\nThe tool name to call. Use `call_with` to pass parameters.',
  then: '**then** — Transition to next step.\n\nThe name of the flow step to transition to after this step completes.',
  when: '**when** — Guard condition (CEL expression).\n\nThis step is only entered if the condition evaluates to true.',
  set: '**set** — Variable assignments.\n\nSet context variables. Each entry has `variable` (name) and `expression` (CEL or literal value).',
  on_success:
    '**on_success** — Success handler for tool calls.\n\nActions to take when the tool call succeeds.',
  on_failure:
    '**on_failure** — Failure handler for tool calls.\n\nActions to take when the tool call fails.',
};
```

**Step 4: Implement getHoverInfo**

Create `packages/language-service/src/hover.ts`:

```typescript
import type { Position, HoverInfo } from './types';
import { KEYWORD_DOCS } from './docs';

/**
 * Get hover information for a position in ABL source.
 * Returns keyword documentation when hovering over ABL keywords.
 */
export function getHoverInfo(source: string, position: Position): HoverInfo | null {
  const lines = source.split('\n');
  const line = lines[position.line - 1];
  if (!line) return null;

  // Extract the word at the cursor position
  const word = getWordAtPosition(line, position.column - 1);
  if (!word) return null;

  // Look up keyword documentation
  const normalizedWord = word.toLowerCase().replace(/\s*:$/, '');
  const doc = KEYWORD_DOCS[normalizedWord];
  if (!doc) return null;

  return {
    contents: doc,
    line: position.line,
    column: position.column,
  };
}

function getWordAtPosition(line: string, column: number): string | null {
  // Find the word boundaries around the cursor
  let start = column;
  let end = column;

  while (start > 0 && /[a-zA-Z_]/.test(line[start - 1])) start--;
  while (end < line.length && /[a-zA-Z_:]/.test(line[end])) end++;

  const word = line.substring(start, end).trim();
  return word || null;
}
```

**Step 5: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run src/__tests__/hover.test.ts`
Expected: All 4 tests PASS.

**Step 6: Commit**

```bash
git add packages/language-service/src/hover.ts packages/language-service/src/docs.ts packages/language-service/src/__tests__/hover.test.ts
git commit -m "feat(language-service): implement getHoverInfo() with keyword documentation"
```

---

## Task 8: YAML Monarch Tokenizer for Monaco

Extract and enhance the Monarch tokenizer to support both YAML and legacy formats.

**Files:**

- Create: `apps/studio/src/lib/abl-monarch.ts`
- Modify: `apps/studio/src/components/abl/ABLEditor.tsx` (replace inline tokenizer with import, fix language ID)

**Step 1: Create the extracted tokenizer module**

Create `apps/studio/src/lib/abl-monarch.ts`:

```typescript
import type { languages } from 'monaco-editor';

/**
 * Monarch tokenizer for legacy ABL format (uppercase keywords).
 */
export const ablLegacyTokenizer: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      // Comments
      [/#.*$/, 'comment'],
      [/\/\/.*$/, 'comment'],

      // Section keywords (purple/bold)
      [
        /\b(AGENT|SUPERVISOR|MODE|GOAL|PERSONA|IDENTITY|LIMITATIONS|TOOLS|GATHER|MEMORY|CONSTRAINTS|FLOW|STEPS|DELEGATE|HANDOFF|ESCALATE|COMPLETE|ON_ERROR|ON_START|GUARDRAILS|TESTS)\b/,
        'keyword',
      ],

      // Sub-keywords (green)
      [
        /\b(WHEN|TO|RESPOND|STORE|RETURN|REQUIRE|ON_FAIL|ON_SUCCESS|THEN|CALL|CHECK|COLLECT|INPUT|RETURNS|PURPOSE|REASON|PRIORITY|TIMEOUT|TTL|CONTEXT|ON_INPUT|PROMPT|PRESENT|SET|IF|ELSE|FIELDS|STRATEGY|AS)\b/,
        'type.identifier',
      ],

      // Booleans
      [/\b(true|false)\b/, 'constant'],

      // Numbers
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Strings
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // Arrows
      [/->|=>|→/, 'operator'],

      // Template variables
      [/\{\{[^}]+\}\}/, 'variable'],
      [/\$\{[^}]+\}/, 'variable'],

      // Identifiers
      [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier'],
    ],
  },
};

/**
 * Monarch tokenizer for YAML ABL format (lowercase keys, YAML syntax).
 */
export const ablYamlTokenizer: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      // Comments
      [/#.*$/, 'comment'],

      // ABL section keys at start of line (keyword color)
      [
        /^(agent|supervisor|mode|goal|persona|identity|limitations|tools|gather|memory|constraints|flow|steps|delegate|handoff|escalate|complete|on_error|on_start|guardrails|execution|language|messages|templates)\s*:/,
        'keyword',
      ],

      // ABL sub-keys (indented, keyword color - lighter)
      [
        /^\s+(entry_point|fields|strategy|rule|action|to|condition|reason|priority|respond|call|call_with|call_as|then|when|set|clear|on_success|on_failure|on_input|on_result|max_attempts|name|type|required|validation|extraction_hints|prompt|default|options|session|persistent|check|purpose)\s*:/,
        'type.identifier',
      ],

      // YAML boolean values
      [/\b(true|false|yes|no|on|off)\b/, 'constant'],

      // YAML null
      [/\b(null|~)\b/, 'constant'],

      // Numbers
      [/\b\d+(\.\d+)?\b/, 'number'],

      // Strings (double and single quoted)
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],

      // YAML block scalar indicators
      [/[|>][+-]?\s*$/, 'operator'],

      // YAML list item dash
      [/^\s*-\s/, 'operator'],

      // Template variables
      [/\{\{[^}]+\}\}/, 'variable'],
      [/\$\{[^}]+\}/, 'variable'],

      // YAML anchors and aliases
      [/&\w+/, 'tag'],
      [/\*\w+/, 'tag'],

      // CEL-like expressions (inside quotes or after condition:)
      [/abl\.\w+/, 'variable'],
      [/context\.\w+(\.\w+)*/, 'variable'],

      // Generic identifiers
      [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier'],
    ],
  },
};
```

**Step 2: Update ABLEditor.tsx to use extracted tokenizer**

In `apps/studio/src/components/abl/ABLEditor.tsx`:

1. Add import at the top:

```typescript
import { ablLegacyTokenizer, ablYamlTokenizer } from '@/lib/abl-monarch';
```

2. In the `handleEditorMount` callback, replace the inline Monarch tokenizer (lines 83-123) with:

```typescript
// Register ABL language
monaco.languages.register({ id: 'abl' });

// Detect format and set appropriate tokenizer
const isYaml = dslContent.trim().match(/^[a-z][a-z_]*\s*:/m);
monaco.languages.setMonarchTokensProvider('abl', isYaml ? ablYamlTokenizer : ablLegacyTokenizer);
```

3. Fix the `defaultLanguage` prop (line ~381):
   Change `defaultLanguage="agent-dsl"` to `defaultLanguage="abl"`.

**Step 3: Verify the editor still works**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add apps/studio/src/lib/abl-monarch.ts apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "feat(studio): extract Monarch tokenizer, add YAML ABL syntax highlighting, fix language ID"
```

---

## Task 9: Add Diagnostics API Route in Studio

Create a Studio API route that calls the language service for Tier 2+ diagnostics.

**Files:**

- Create: `apps/studio/src/app/api/abl/diagnostics/route.ts`
- Reference: `apps/studio/src/app/api/abl/parse/route.ts` (pattern)

**Step 1: Create the diagnostics route**

Create `apps/studio/src/app/api/abl/diagnostics/route.ts`:

```typescript
/**
 * POST /api/abl/diagnostics
 * Get diagnostics (errors + warnings) for ABL source using the language service.
 * Tier 2: structural validation (tool refs, step refs, required fields).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDiagnostics } from '@abl/language-service';
import { requireAuth, isAuthError } from '@agent-platform/shared/middleware';

export async function POST(request: NextRequest) {
  const authResult = requireAuth(request);
  if (isAuthError(authResult)) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  try {
    const body = await request.json();
    const { dsl } = body;

    if (!dsl || typeof dsl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid dsl field' },
        { status: 400 },
      );
    }

    const diagnostics = getDiagnostics(dsl);

    return NextResponse.json({
      success: true,
      diagnostics,
    });
  } catch (err) {
    console.error('[API/abl/diagnostics] Error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
```

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/abl/diagnostics/route.ts
git commit -m "feat(studio): add POST /api/abl/diagnostics route for language service"
```

---

## Task 10: Wire Language Service Diagnostics to Monaco

Update `useABLParsing` hook and editor store to support tiered diagnostics with the language service.

**Files:**

- Modify: `apps/studio/src/store/editor-store.ts`
- Modify: `apps/studio/src/hooks/useABLParsing.ts`
- Modify: `apps/studio/src/components/abl/ABLEditor.tsx`

**Step 1: Add diagnostic types to editor store**

In `apps/studio/src/store/editor-store.ts`, add to the `EditorState` interface (alongside existing `parseErrors`):

```typescript
// Add after parseWarnings field:
diagnostics: Array<{ severity: string; message: string; line: number; column: number; source?: string }>;
setDiagnostics: (diags: Array<{ severity: string; message: string; line: number; column: number; source?: string }>) => void;
```

And in the store implementation, add:

```typescript
diagnostics: [],
setDiagnostics: (diags) => set({ diagnostics: diags }),
```

**Step 2: Add Tier 2 diagnostics call to useABLParsing**

In `apps/studio/src/hooks/useABLParsing.ts`, add a `fetchDiagnostics` function that calls the new `/api/abl/diagnostics` endpoint with a 1-second debounce (separate from the 500ms parse debounce):

```typescript
const DIAGNOSTICS_DEBOUNCE_MS = 1000;
const diagnosticsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

const fetchDiagnosticsLive = useCallback(
  (content: string) => {
    if (diagnosticsTimeoutRef.current) {
      clearTimeout(diagnosticsTimeoutRef.current);
    }
    diagnosticsTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await apiFetch('/api/abl/diagnostics', {
          method: 'POST',
          body: JSON.stringify({ dsl: content }),
        });
        const result = await response.json();
        if (result.success && result.diagnostics) {
          setDiagnostics(result.diagnostics);
        }
      } catch {
        // Non-fatal — diagnostics are advisory
      }
    }, DIAGNOSTICS_DEBOUNCE_MS);
  },
  [setDiagnostics],
);
```

Export `fetchDiagnosticsLive` alongside existing exports. Call it from `parseLive` after the parse succeeds (so Tier 2 runs after Tier 1 parse completes).

**Step 3: Update Monaco markers in ABLEditor to use diagnostics**

In `apps/studio/src/components/abl/ABLEditor.tsx`, in the `useEffect` that sets Monaco markers (search for `setModelMarkers`), merge the new `diagnostics` array alongside `parseErrors`:

```typescript
const { diagnostics } = useEditorStore();

useEffect(() => {
  if (!monacoRef.current || !editorRef.current) return;
  const model = editorRef.current.getModel();
  if (!model) return;

  const markers = [
    // Existing parse errors
    ...parseErrors.map((e) => ({
      severity: monacoRef.current!.MarkerSeverity.Error,
      message: e.message,
      startLineNumber: e.line,
      startColumn: e.column || 1,
      endLineNumber: e.line,
      endColumn: e.column ? e.column + 1 : model.getLineMaxColumn(e.line),
    })),
    // Language service diagnostics
    ...diagnostics.map((d) => ({
      severity:
        d.severity === 'error'
          ? monacoRef.current!.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monacoRef.current!.MarkerSeverity.Warning
            : monacoRef.current!.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column || 1,
      endLineNumber: d.line,
      endColumn: d.column ? d.column + 1 : model.getLineMaxColumn(d.line),
    })),
  ];

  monacoRef.current.editor.setModelMarkers(model, 'abl', markers);
}, [parseErrors, diagnostics]);
```

**Step 4: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add apps/studio/src/store/editor-store.ts apps/studio/src/hooks/useABLParsing.ts apps/studio/src/components/abl/ABLEditor.tsx
git commit -m "feat(studio): wire language service diagnostics to Monaco markers with tiered validation"
```

---

## Task 11: Run Full Test Suite and Verify

**Step 1: Build the language service**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install && pnpm build --filter @abl/language-service`
Expected: Clean build.

**Step 2: Run language service tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/language-service run test -- --run`
Expected: All tests pass (detect-format, diagnostics, symbols, completions, hover).

**Step 3: Run core package tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @abl/core run test -- --run`
Expected: All tests pass including new yaml-flow-parser tests.

**Step 4: Build Studio**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio build`
Expected: Clean build.

**Step 5: Run fast tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm turbo test:fast`
Expected: All fast tests pass across the monorepo.

---

## Summary

| Task | Component              | Files                                                  | Tests      |
| ---- | ---------------------- | ------------------------------------------------------ | ---------- |
| 1    | YAML flow parser       | `packages/core/src/parser/yaml-parser.ts`              | 5 tests    |
| 2    | Package scaffold       | `packages/language-service/` (6 files)                 | —          |
| 3    | Format detection       | `detect-format.ts`                                     | 5 tests    |
| 4    | Diagnostics            | `diagnostics.ts`                                       | 5 tests    |
| 5    | Document symbols       | `symbols.ts`                                           | 5 tests    |
| 6    | Completions            | `completions.ts`                                       | 5 tests    |
| 7    | Hover info             | `hover.ts`, `docs.ts`                                  | 4 tests    |
| 8    | YAML Monarch tokenizer | `abl-monarch.ts`, `ABLEditor.tsx`                      | visual     |
| 9    | Diagnostics API route  | `diagnostics/route.ts`                                 | build      |
| 10   | Wire to Monaco         | `editor-store.ts`, `useABLParsing.ts`, `ABLEditor.tsx` | build      |
| 11   | Full verification      | —                                                      | full suite |

**Total: 11 tasks, ~29 unit tests, 7 commits**
