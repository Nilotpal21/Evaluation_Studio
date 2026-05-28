# Enum & Lookup Table PR Review Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address PR review feedback by removing inline lookup config from GatherEditor, simplifying to project-level references, and wiring a merger into the runtime.

**Architecture:** Studio UI simplifies from full inline lookup config to a project-table dropdown. Runtime merges agent-level + project-level lookup tables at gather step execution, throwing on name conflict. ~450 lines removed, ~80 added.

**Tech Stack:** TypeScript, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-25-enum-lookup-pr-review-refactor-design.md`

---

### Task 1: Create lookup-table-merger.ts with tests (TDD)

**Files:**

- Create: `apps/runtime/src/services/execution/lookup-table-merger.ts`
- Create: `apps/runtime/src/__tests__/lookup-table-merger.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/runtime/src/__tests__/lookup-table-merger.test.ts
import { describe, test, expect } from 'vitest';
import {
  mergeLookupTables,
  LookupTableConflictError,
} from '../services/execution/lookup-table-merger.js';
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

function makeTable(
  name: string,
  source: 'inline' | 'collection' | 'api' = 'inline',
): LookupTableIR {
  return { name, source, case_sensitive: false, fuzzy_match: false, fuzzy_threshold: 0.85 };
}

function makeProjectConfig(tables: LookupTableIR[]): ProjectRuntimeConfigIR {
  return {
    extraction_strategy: 'auto',
    nlu_provider: 'built_in',
    multi_intent: {
      enabled: false,
      strategy: 'primary_queue',
      max_intents: 3,
      confidence_threshold: 0.6,
      queue_max_age_ms: 600_000,
    },
    inference: { confidence: 0.8, confirm: true, model_tier: 'fast', max_fields_per_pass: 3 },
    conversion: { currency_mode: 'static' },
    lookup_tables: tables,
  } as ProjectRuntimeConfigIR;
}

describe('mergeLookupTables', () => {
  test('returns empty record when both inputs are undefined', () => {
    expect(mergeLookupTables(undefined, undefined)).toEqual({});
  });

  test('returns agent tables when project config is undefined', () => {
    const agent = { cities: makeTable('cities') };
    const result = mergeLookupTables(agent, undefined);
    expect(Object.keys(result)).toEqual(['cities']);
    expect(result.cities.name).toBe('cities');
  });

  test('returns project tables when agent tables are undefined', () => {
    const project = makeProjectConfig([makeTable('countries')]);
    const result = mergeLookupTables(undefined, project);
    expect(Object.keys(result)).toEqual(['countries']);
  });

  test('merges agent and project tables with no conflict', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([makeTable('countries')]);
    const result = mergeLookupTables(agent, project);
    expect(Object.keys(result).sort()).toEqual(['cities', 'countries']);
  });

  test('throws LookupTableConflictError on name collision', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([makeTable('cities', 'collection')]);
    expect(() => mergeLookupTables(agent, project)).toThrow(LookupTableConflictError);
    expect(() => mergeLookupTables(agent, project)).toThrow(/cities/);
  });

  test('handles empty project lookup_tables array', () => {
    const agent = { cities: makeTable('cities') };
    const project = makeProjectConfig([]);
    const result = mergeLookupTables(agent, project);
    expect(Object.keys(result)).toEqual(['cities']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/runtime/src/__tests__/lookup-table-merger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/runtime/src/services/execution/lookup-table-merger.ts
import { createLogger } from '@abl/compiler/platform';
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

const log = createLogger('lookup-table-merger');

export class LookupTableConflictError extends Error {
  constructor(public tableName: string) {
    super(
      `Lookup table name conflict: "${tableName}" is defined in both ` +
        `agent DSL and project runtime config. Rename one to resolve.`,
    );
    this.name = 'LookupTableConflictError';
  }
}

export function mergeLookupTables(
  agentTables: Record<string, LookupTableIR> | undefined,
  projectConfig: ProjectRuntimeConfigIR | undefined,
): Record<string, LookupTableIR> {
  const merged: Record<string, LookupTableIR> = {};

  if (agentTables) {
    for (const [name, table] of Object.entries(agentTables)) {
      merged[name] = table;
    }
  }

  if (projectConfig?.lookup_tables) {
    for (const table of projectConfig.lookup_tables) {
      if (merged[table.name]) {
        throw new LookupTableConflictError(table.name);
      }
      merged[table.name] = table;
    }
  }

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/runtime/src/__tests__/lookup-table-merger.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/lookup-table-merger.ts apps/runtime/src/__tests__/lookup-table-merger.test.ts
git add apps/runtime/src/services/execution/lookup-table-merger.ts apps/runtime/src/__tests__/lookup-table-merger.test.ts
git commit -m "[ABLP-2] feat(runtime): add lookup table merger for agent + project sources"
```

---

### Task 2: Wire merged tables into flow-step-executor.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Context:** There are 3 call sites that read `session.agentIR?.lookup_tables`. All 3 must use the merged result. The merge happens once; the result is threaded to all 3 consumers. The project config is available at `session._projectRuntimeConfig`.

- [ ] **Step 1: Add import**

At `flow-step-executor.ts:99` (after the existing `lookup-resolver` import), add:

```typescript
import { mergeLookupTables, LookupTableConflictError } from './lookup-table-merger.js';
```

- [ ] **Step 2: Update call site 1 — prompt hint injection (line ~1758)**

Replace:

```typescript
if (gatherField?.semantics?.lookup && session.agentIR?.lookup_tables) {
  const table = session.agentIR.lookup_tables[gatherField.semantics.lookup];
```

With (using a `mergedLookup` variable computed earlier in the function — see step 4):

```typescript
if (gatherField?.semantics?.lookup && Object.keys(mergedLookup).length > 0) {
  const table = mergedLookup[gatherField.semantics.lookup];
```

- [ ] **Step 3: Update call site 2 — buildExtractionTool call (line ~1830)**

Replace:

```typescript
const extractionTool = FlowStepExecutor.buildExtractionTool(
  (gatherFields || []).filter((gf) => !patternOnlyFields.includes(gf.name)),
  session.agentIR?.lookup_tables,
);
```

With:

```typescript
const extractionTool = FlowStepExecutor.buildExtractionTool(
  (gatherFields || []).filter((gf) => !patternOnlyFields.includes(gf.name)),
  mergedLookup,
);
```

- [ ] **Step 4: Compute `mergedLookup` once at the top of the extraction method**

Near the top of the method that contains call sites 1 and 2 (the entity extraction method, before the field descriptions loop), add:

```typescript
let mergedLookup: Record<string, import('@abl/compiler/platform/ir/schema.js').LookupTableIR> = {};
try {
  mergedLookup = mergeLookupTables(session.agentIR?.lookup_tables, session._projectRuntimeConfig);
} catch (err) {
  if (err instanceof LookupTableConflictError) {
    if (onTraceEvent) {
      onTraceEvent({
        type: 'lookup_table_conflict',
        data: { agentName: session.agentName, tableName: err.tableName },
      });
    }
    const errorMsg = err.message;
    if (onChunk) onChunk(errorMsg);
    session.conversationHistory.push({ role: 'assistant', content: errorMsg });
    return {
      response: errorMsg,
      stateUpdates: buildStateUpdates(session),
    };
  }
  throw err;
}
```

- [ ] **Step 5: Update call site 3 — post-extraction validation (line ~3461)**

Replace:

```typescript
if (session.agentIR?.lookup_tables && step.gather?.fields) {
  // ...
  session.agentIR.lookup_tables,
```

With:

```typescript
const mergedLookupForValidation = mergeLookupTables(
  session.agentIR?.lookup_tables,
  session._projectRuntimeConfig,
);
if (Object.keys(mergedLookupForValidation).length > 0 && step.gather?.fields) {
  // ...
  mergedLookupForValidation,
```

Wrap in try/catch for `LookupTableConflictError` with same trace event pattern as step 4.

- [ ] **Step 6: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: Build succeeds

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write apps/runtime/src/services/execution/flow-step-executor.ts
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire merged lookup tables into gather step execution"
```

---

### Task 3: Simplify GatherFieldData and parseGather()

**Files:**

- Modify: `apps/studio/src/store/agent-detail-store.ts:93-129` (GatherFieldData interface)
- Modify: `apps/studio/src/store/agent-detail-store.ts:428-484` (parseGather function)

- [ ] **Step 1: Replace 12 lookup fields with single `lookupTable`**

In `GatherFieldData` (line 93-129), replace:

```typescript
  // --- Lookup-specific fields (only used when type === 'lookup') ---
  lookupSource?: 'inline' | 'api' | 'collection';
  lookupValues?: string[];
  lookupEndpoint?: string;
  lookupMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  lookupBody?: string;
  lookupField?: string;
  lookupTimeoutMs?: number;
  lookupHeaders?: Record<string, string>;
  lookupTableName?: string;
  lookupCaseSensitive?: boolean;
  lookupFuzzyMatch?: boolean;
  lookupFuzzyThreshold?: number;
```

With:

```typescript
  /** Reference to a project-level lookup table name (semantics.lookup in DSL) */
  lookupTable?: string;
```

- [ ] **Step 2: Simplify parseGather()**

Remove the `lookupTables` variable (line 430):

```typescript
// DELETE: const lookupTables: Record<string, any> = ir.lookup_tables ?? {};
```

Replace the hydration block (lines 463-480):

```typescript
// DELETE the entire block:
//   const lookupName = f.semantics?.lookup;
//   if (lookupName && lookupTables[lookupName]) { ... }
```

With:

```typescript
if (f.semantics?.lookup) {
  base.lookupTable = f.semantics.lookup;
}
```

- [ ] **Step 3: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/store/agent-detail-store.ts
git add apps/studio/src/store/agent-detail-store.ts
git commit -m "[ABLP-2] refactor(studio): simplify GatherFieldData — 12 lookup fields to 1"
```

---

### Task 4: Simplify serializer

**Files:**

- Modify: `apps/studio/src/lib/abl-serializers.ts:144-280`

- [ ] **Step 1: Delete `serializeLookupTableEntry()` function**

Remove the entire function at lines 148-185.

- [ ] **Step 2: Simplify `serializeGatherToABL()`**

Remove `lookupFields` filter (line 192):

```typescript
// DELETE: const lookupFields = data.filter((f) => f.type === 'lookup');
```

Replace `dslType` mapping (lines 196-197):

```typescript
// BEFORE:
const dslType = f.type === 'lookup' ? 'string' : f.type;
// AFTER — use f.type directly:
```

Update type emission (lines 203-206) to use `f.type` instead of `dslType`:

```typescript
if (f.type && f.type !== 'string') {
  lines.push(`    type: ${f.type}`);
}
```

Replace lookup semantics emission (lines 217-223):

```typescript
// BEFORE:
if (f.type === 'lookup') {
  const tableName =
    f.lookupSource === 'collection' && f.lookupTableName ? f.lookupTableName : f.name;
  lines.push('    semantics:');
  lines.push(`      lookup: ${tableName}`);
}

// AFTER:
if (f.lookupTable) {
  lines.push('    semantics:');
  lines.push(`      lookup: ${f.lookupTable}`);
}
```

- [ ] **Step 3: Remove LOOKUP_TABLES section emission**

Replace lines 271-279:

```typescript
// BEFORE:
const edits: SectionEdit[] = [{ section: 'GATHER', content: `GATHER:\n${fields}` }];
if (lookupFields.length > 0) {
  const tables = lookupFields.map((f) => serializeLookupTableEntry(f.name, f)).join('\n');
  edits.push({ section: 'LOOKUP_TABLES', content: `LOOKUP_TABLES:\n${tables}` });
}
return edits;

// AFTER:
return [{ section: 'GATHER', content: `GATHER:\n${fields}` }];
```

- [ ] **Step 4: Update section comment**

Change line 145 from `// GATHER → GATHER + LOOKUP_TABLES` to `// GATHER → GATHER`.

- [ ] **Step 5: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/abl-serializers.ts
git add apps/studio/src/lib/abl-serializers.ts
git commit -m "[ABLP-2] refactor(studio): remove LOOKUP_TABLES emission from serializer"
```

---

### Task 5: Simplify GatherEditor UI

**Files:**

- Modify: `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`
- Modify: `apps/studio/src/components/agent-editor/types.ts` (add `lookupTableNames` to SectionEditorProps)
- Modify: `apps/studio/src/components/agent-editor/AgentEditor.tsx` (fetch + pass prop)

- [ ] **Step 1: Remove lookup components from GatherEditor.tsx**

Delete these components entirely:

- `HeaderKeyValueEditor` (lines 148-267)
- `ApiSourceConfig` (lines 273-443)
- `LookupConfigPanel` (lines 449-582)

Remove these constants:

- `LOOKUP_SOURCE_OPTIONS` (lines 41-45)
- `lookup` entry from `TYPE_BADGE_COLORS` (line 29)
- `lookup` entry from `FIELD_TYPE_OPTIONS` (line 38)

Remove `HTTP_METHOD_OPTIONS` (lines 273-279 — inside the deleted `ApiSourceConfig` block).

- [ ] **Step 2: Clean up unused imports**

Replace:

```typescript
import { List, Plus, X, ChevronDown, ChevronRight, Upload, Play, Loader2 } from 'lucide-react';
import { Toggle } from '../../ui/Toggle';
import { Select } from '../../ui/Select';
import { SegmentedControl } from '../../ui/SegmentedControl';
```

With:

```typescript
import { List, Plus, X, ChevronDown, ChevronRight } from 'lucide-react';
import { Toggle } from '../../ui/Toggle';
import { Select } from '../../ui/Select';
```

- [ ] **Step 3: Replace LookupConfigPanel rendering with dropdown**

In the `FieldCard` expanded details section, replace:

```tsx
{
  field.type === 'lookup' && (
    <LookupConfigPanel field={field} index={index} onChange={onChange} readOnly={readOnly} />
  );
}
```

With:

```tsx
{
  field.type === 'string' && lookupTableNames.length > 0 && (
    <FieldGroup label="Lookup Table">
      <Select
        options={[
          { value: '', label: '(none)' },
          ...lookupTableNames.map((name) => ({ value: name, label: name })),
        ]}
        value={field.lookupTable ?? ''}
        onChange={(v) => onChange(index, { ...field, lookupTable: v || undefined })}
        disabled={readOnly}
      />
      <span className="text-xs text-foreground-muted">
        Manage tables in Project Settings &gt; Runtime Config
      </span>
    </FieldGroup>
  );
}
```

The `lookupTableNames` prop needs to be threaded through `FieldCard` props from `GatherEditor`.

- [ ] **Step 4: Add `lookupTableNames` to GatherEditor props**

In `GatherEditor.tsx`, update the component signature to accept `lookupTableNames`:

```tsx
export function GatherEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
  lookupTableNames = [],
}: SectionEditorProps<'gather'> & { lookupTableNames?: string[] }) {
```

Pass `lookupTableNames` through to each `FieldCard`.

- [ ] **Step 5: Update AgentEditor.tsx to fetch and pass lookup table names**

In `AgentEditor.tsx`, add state and fetch:

```typescript
const [lookupTableNames, setLookupTableNames] = useState<string[]>([]);

useEffect(() => {
  if (!projectId) return;
  apiFetch(`/api/projects/${projectId}/runtime-config`)
    .then((res) => res.json())
    .then((body) => {
      const tables = body?.data?.lookup_tables ?? [];
      setLookupTableNames(tables.map((t: { name: string }) => t.name));
    })
    .catch(() => {
      /* best-effort — dropdown just won't show */
    });
}, [projectId]);
```

Update `renderActiveSection` to pass `lookupTableNames` when section is `gather`:

```typescript
if (section === 'gather') {
  return <GatherEditor data={data as GatherFieldData[]} onChange={handleChange as any} onArchClick={onArchClick} lookupTableNames={lookupTableNames} />;
}
```

- [ ] **Step 6: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write apps/studio/src/components/agent-editor/sections/GatherEditor.tsx apps/studio/src/components/agent-editor/AgentEditor.tsx
git add apps/studio/src/components/agent-editor/sections/GatherEditor.tsx apps/studio/src/components/agent-editor/AgentEditor.tsx
git commit -m "[ABLP-2] refactor(studio): replace LookupConfigPanel with project table dropdown"
```

---

### Task 6: Update serializer roundtrip tests

**Files:**

- Modify: `apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts`

- [ ] **Step 1: Rewrite the test file**

Replace the entire file. Key changes:

- Remove `lookupEdit` references from `buildDsl()` — no more LOOKUP_TABLES section
- Remove `inline source round-trips` test (used `type: 'lookup'`, `lookupSource`, etc.)
- Remove `collection source round-trips` test (same)
- Remove `multiple fields — only lookup fields generate LOOKUP_TABLES` test
- Keep `basic string and enum fields survive round-trip` test (unchanged)
- Keep `all field types and properties survive round-trip` test (unchanged)
- Keep `non-lookup field does not emit LOOKUP_TABLES section` test (still valid)
- Add: `lookupTable reference emits semantics.lookup in DSL` test
- Add: `serializer never emits LOOKUP_TABLES section` test

```typescript
// New test for lookupTable reference
test('lookupTable reference emits semantics.lookup in DSL', () => {
  const fields = [
    {
      name: 'city',
      prompt: 'Which city?',
      type: 'string' as const,
      required: true,
      lookupTable: 'cities',
    },
  ];

  const edits = serializeGatherToABL(fields as any);
  expect(edits).toHaveLength(1);
  expect(edits[0].section).toBe('GATHER');
  expect(edits[0].content).toContain('lookup: cities');

  // No LOOKUP_TABLES section
  const lookupEdit = edits.find((e: any) => e.section === 'LOOKUP_TABLES');
  expect(lookupEdit).toBeUndefined();

  // Round-trip: parse + compile → field has semantics.lookup
  const dsl = buildDsl(edits);
  const parseResult = parseAgentBasedABL(dsl);
  const hardErrors = parseResult.errors.filter((e: any) => e.severity === 'error');
  expect(hardErrors).toHaveLength(0);

  const output = compileABLtoIR([parseResult.document!]);
  const gatherField = output.agents['RoundTripTest'].gather?.fields?.find(
    (f: any) => f.name === 'city',
  );
  expect(gatherField).toBeDefined();
  expect(gatherField!.semantics?.lookup).toBe('cities');
});

// New test confirming no LOOKUP_TABLES emission
test('serializer never emits LOOKUP_TABLES section', () => {
  const fields = [
    { name: 'name', prompt: 'Name?', type: 'string' as const, required: true },
    {
      name: 'city',
      prompt: 'City?',
      type: 'string' as const,
      required: false,
      lookupTable: 'cities',
    },
  ];

  const edits = serializeGatherToABL(fields as any);
  expect(edits).toHaveLength(1);
  expect(edits[0].section).toBe('GATHER');
  const lookupEdit = edits.find((e: any) => e.section === 'LOOKUP_TABLES');
  expect(lookupEdit).toBeUndefined();
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts
git add apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts
git commit -m "[ABLP-2] test(studio): update serializer roundtrip tests for simplified lookup model"
```

---

### Task 7: Final build verification

**Files:** None — verification only

- [ ] **Step 1: Build all affected packages**

Run: `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio`
Expected: Build succeeds with 0 errors

- [ ] **Step 2: Run all affected tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/lookup-table-merger.test.ts apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Verify no stale references to removed fields**

Search for any remaining references to the removed `lookup*` fields:

```bash
grep -r "lookupSource\|lookupValues\|lookupEndpoint\|lookupMethod\|lookupBody\|lookupField\|lookupTimeoutMs\|lookupHeaders\|lookupTableName\|lookupCaseSensitive\|lookupFuzzyMatch\|lookupFuzzyThreshold" apps/studio/src/ --include="*.ts" --include="*.tsx" -l
```

Expected: No matches in source files (docs may still reference them — that's fine).
