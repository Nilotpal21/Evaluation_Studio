# Design: Enum & Lookup Table PR Review Refactor

**Date:** 2026-03-25
**Branch:** `KI0326/feature/enum`
**Trigger:** PR review feedback — architectural changes requested
**Approach:** Minimal diff — address review items only, no scope creep

---

## Problem

The PR introduces full lookup table configuration inline on each gather field in the GatherEditor (`LookupConfigPanel` — 530 lines). This duplicates the existing project-level lookup table management in RuntimeConfigTab. At runtime, the executor only reads `session.agentIR.lookup_tables` — project-level tables are never consulted for gather validation.

## Design Decisions

| Decision                   | Choice                                       | Rationale                                               |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| Enum vs lookup scope       | Enums = agent-local, lookups = project-level | No duplication, clear ownership                         |
| Name collision handling    | Throw `LookupTableConflictError`             | Strict — forces user to rename                          |
| Lookup dropdown visibility | String fields only                           | Enums have their own `options`, other types don't apply |
| Merge call frequency       | Once per gather step                         | Single error handling point, no redundant merges        |
| Execution approach         | Minimal diff (Approach A)                    | Smallest risk, easiest to review                        |

---

## Section 1: Studio — GatherFieldData & Store Simplification

**File:** `apps/studio/src/store/agent-detail-store.ts`

Replace 12 `lookup*` fields in `GatherFieldData` with one:

```typescript
export interface GatherFieldData {
  // ... existing fields unchanged ...
  options?: string[]; // enum inline values (kept)
  lookupTable?: string; // reference to project-level table name (new)
  // Remove: lookupSource, lookupValues, lookupEndpoint, lookupMethod,
  //         lookupBody, lookupField, lookupTimeoutMs, lookupHeaders,
  //         lookupTableName, lookupCaseSensitive, lookupFuzzyMatch,
  //         lookupFuzzyThreshold
}
```

In `parseGather()`, replace the 18-line hydration block with:

```typescript
if (f.semantics?.lookup) {
  base.lookupTable = f.semantics.lookup;
}
```

Remove the unused `lookupTables` variable.

---

## Section 2: Studio — Serializer Simplification

**File:** `apps/studio/src/lib/abl-serializers.ts`

1. **Delete** `serializeLookupTableEntry()` function (~38 lines).
2. **In `serializeGatherToABL()`:**
   - Remove `lookupFields` filter.
   - Remove `dslType` mapping (`type === 'lookup' ? 'string' : f.type`). Use `f.type` directly.
   - Remove `LOOKUP_TABLES` section emission at the end.
   - Replace lookup semantics emission with:
     ```typescript
     if (f.lookupTable) {
       lines.push('    semantics:');
       lines.push(`      lookup: ${f.lookupTable}`);
     }
     ```
3. Function returns a single `GATHER` section edit — never `LOOKUP_TABLES`.

---

## Section 3: Studio — GatherEditor UI

**File:** `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`

**Remove (~435 lines):**

- `LookupConfigPanel`, `ApiSourceConfig`, `HeaderKeyValueEditor` components
- `LOOKUP_SOURCE_OPTIONS`, `HTTP_METHOD_OPTIONS` constants
- `lookup` entry from `FIELD_TYPE_OPTIONS` and `TYPE_BADGE_COLORS`
- Unused imports: `Upload`, `Play`, `Loader2`, `SegmentedControl`

**Keep:** `EnumTagInput` for `type === 'enum'`.

**Add:** Lookup table dropdown on `string` type fields, shown only when project-level tables exist:

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

**Data flow:** `lookupTableNames: string[]` fetched once from `/api/projects/:pid/runtime-config` when AgentEditor opens, passed to GatherEditor via `SectionEditorProps`.

---

## Section 4: Runtime — Lookup Table Merger

**New file:** `apps/runtime/src/services/execution/lookup-table-merger.ts`

```typescript
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

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

  // Agent-level tables first
  if (agentTables) {
    for (const [name, table] of Object.entries(agentTables)) {
      merged[name] = table;
    }
  }

  // Project-level tables — conflict = throw
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

**Wiring in `flow-step-executor.ts`:**

Merge once at the top of the gather step processing path. The merged result is passed to:

- `buildExtractionTool()` (~line 1830)
- Prompt hint injection (~line 1758)
- `validateWithLookupTables()` (~line 3461)

`LookupTableConflictError` is caught at the gather step entry point, emits a `lookup_table_conflict` trace event, and returns a user-facing error.

---

## Section 5: Tests

**Update existing:**

- `serializer-roundtrip.test.ts` — Remove tests asserting `LOOKUP_TABLES` emission. Add test for `lookupTable` to `semantics.lookup` round-trip. Add test confirming serializer never emits `LOOKUP_TABLES`.

**Add new:**

- Unit tests for `mergeLookupTables()`:
  - Happy path: agent-only, project-only, both with no conflict
  - Conflict: same name in both throws `LookupTableConflictError`
  - Empty inputs: both undefined returns `{}`

**No changes to:**

- Parser/compiler tests (GAP-1, GAP-2 kept as-is)
- Runtime resolver tests (GAP-4, GAP-6, GAP-7 kept as-is)
- Extraction/lookup injection tests (GAP-3, GAP-8 logic unchanged, just uses merged source)

---

## Files Changed

| File                                                                 | Action                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/runtime/src/services/execution/lookup-table-merger.ts`         | **New** — merger + conflict error                    |
| `apps/runtime/src/services/execution/flow-step-executor.ts`          | **Modify** — use merged tables at 3 call sites       |
| `apps/studio/src/store/agent-detail-store.ts`                        | **Modify** — simplify GatherFieldData, parseGather() |
| `apps/studio/src/lib/abl-serializers.ts`                             | **Modify** — remove LOOKUP_TABLES emission           |
| `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`  | **Modify** — remove ~435 lines, add dropdown         |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`            | **Modify** — fetch lookupTableNames, pass as prop    |
| `apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts` | **Modify** — update for new behavior                 |
| `apps/runtime/src/__tests__/lookup-table-merger.test.ts`             | **New** — merger unit tests                          |

## GAP Disposition

| GAP   | Verdict | Notes                                                |
| ----- | ------- | ---------------------------------------------------- |
| GAP-1 | KEEP    | Parser `options:` support                            |
| GAP-2 | KEEP    | Compiler `type: 'enum'` fix                          |
| GAP-3 | MODIFY  | Use merged tables for LLM prompt injection           |
| GAP-4 | KEEP    | API header forwarding                                |
| GAP-5 | REWRITE | Remove LookupConfigPanel, add project table dropdown |
| GAP-6 | KEEP    | Collection fuzzy matching                            |
| GAP-7 | KEEP    | LRU eviction in TTLCache                             |
| GAP-8 | KEEP    | Token budget guard                                   |
