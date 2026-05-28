# PR Review: KI0326/feature/enum — Enum Fields & Lookup Tables

**Reviewer:** Platform team
**Date:** 2026-03-25
**Branch:** `KI0326/feature/enum` (17 commits, 53 files, +5035/-598)
**Status:** Changes requested

---

## Summary

This PR closes 8 gaps (GAP-1 through GAP-8) to make enum fields and lookup tables functional across the full pipeline: DSL -> Parser -> Compiler -> IR -> Runtime -> Studio UI.

**What's good and should be kept:**

- GAP-1 (parser `options:` support) and GAP-2 (compiler `type: 'enum'` fix) are correct and important — these were genuinely broken.
- GAP-3 (LLM prompt injection of lookup values) and GAP-8 (token budget guard) are sound.
- GAP-4 (API header forwarding), GAP-6 (collection fuzzy matching), GAP-7 (LRU eviction) are clean fixes.
- The serializer format change from dash-list to block format is actually a **correctness fix** — the old format was never parseable by standalone `parseGather()`. Keep it.
- Test coverage is solid across unit, integration, E2E, and roundtrip tests.

**What needs to change:** The lookup table architecture in the GatherEditor and the runtime wiring. Details below.

---

## Issue 1: Two-Location Lookup Table Management (Architectural)

### Problem

The PR introduces full lookup table configuration inline on each gather field in the GatherEditor (`LookupConfigPanel` — 530 lines). This duplicates the existing project-level lookup table management in RuntimeConfigTab.

After this PR, there are two independent places to define a lookup table named "countries":

- **RuntimeConfigTab** (Project Settings) — saves to `project_runtime_configs` MongoDB collection
- **GatherEditor** (Agent Editor) — serializes into agent DSL `LOOKUP_TABLES:` section

These are completely separate storage locations. At runtime, the executor at `flow-step-executor.ts:3403` ONLY reads `session.agentIR.lookup_tables` — project-level tables are **never consulted** for validation. This means tables defined in RuntimeConfigTab have no effect on gather field validation.

### Decision

Product decision: **Simple enums are agent-local. Complex lookup tables are project-level. No duplication.**

| Mechanism                         | Scope   | Defined In               | Managed In                      |
| --------------------------------- | ------- | ------------------------ | ------------------------------- |
| `type: enum` + `options: [a,b,c]` | Agent   | Agent DSL GATHER section | GatherEditor (inline tag input) |
| `semantics.lookup: tableName`     | Project | Project runtime config   | RuntimeConfigTab                |

### Required Changes

#### 1. Remove `LookupConfigPanel` from GatherEditor

The full inline config (source selector, API endpoint, headers, collection name, fuzzy settings) does not belong in the agent editor. All lookup table configuration stays in RuntimeConfigTab.

**Remove from `GatherEditor.tsx`:**

- `LookupConfigPanel` component (~200 lines)
- `ApiSourceConfig` component (~150 lines)
- `HeaderKeyValueEditor` component (~100 lines)
- `LOOKUP_SOURCE_OPTIONS` constant
- `HTTP_METHOD_OPTIONS` constant
- The `lookup` entry from `FIELD_TYPE_OPTIONS` and `TYPE_BADGE_COLORS`

**Replace with:** A `<Select>` dropdown on any gather field that lets the user pick from existing project-level lookup tables. This sets `semantics.lookup: tableName` on the field.

```tsx
// Sketch — exact implementation up to you
{lookupTableNames.length > 0 && (
  <FieldGroup label="Lookup Table">
    <Select
      value={field.lookupTable ?? ''}
      onChange={(e) => onFieldChange({ lookupTable: e.target.value || undefined })}
      options={[
        { value: '', label: '(none)' },
        ...lookupTableNames.map(name => ({ value: name, label: name })),
      ]}
    />
    <span className="text-xs text-foreground-muted">
      Manage tables in Project Settings > Runtime Config
    </span>
  </FieldGroup>
)}
```

The `lookupTableNames: string[]` prop should come from the parent `AgentEditor`, which already has project context. Fetch once from `/api/projects/:pid/runtime-config` on editor open.

**Keep:** `EnumTagInput` for `type === 'enum'` inline options. This is correct.

#### 2. Simplify `GatherFieldData` in `agent-detail-store.ts`

Remove the 12 `lookup*` fields added by the PR:

```diff
  options?: string[];
- lookupSource?: 'inline' | 'api' | 'collection';
- lookupValues?: string[];
- lookupEndpoint?: string;
- lookupMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
- lookupBody?: string;
- lookupField?: string;
- lookupTimeoutMs?: number;
- lookupHeaders?: Record<string, string>;
- lookupTableName?: string;
- lookupCaseSensitive?: boolean;
- lookupFuzzyMatch?: boolean;
- lookupFuzzyThreshold?: number;
+ lookupTable?: string;  // References a project-level table by name
```

Update `parseGather()` accordingly — read `f.semantics?.lookup` into `base.lookupTable`, remove all the lookup table hydration logic.

#### 3. Simplify Serializer in `abl-serializers.ts`

**Remove:** `serializeLookupTableEntry()` function entirely. The serializer should NOT emit a `LOOKUP_TABLES:` section — those are managed in project runtime config, not agent DSL.

**Keep/Add in `serializeGatherToABL()`:**

- `options: [a, b, c]` emission for enum fields (already in PR — keep)
- `semantics.lookup: tableName` emission for fields with a lookup reference:

```typescript
if (f.lookupTable) {
  lines.push('    semantics:');
  lines.push(`      lookup: ${f.lookupTable}`);
}
```

**Remove:** The `lookupFields` filter and `LOOKUP_TABLES` section edit at the end of `serializeGatherToABL()`.

---

## Issue 2: Runtime Must Merge Agent + Project Lookup Tables

### Problem

`flow-step-executor.ts:3403` only reads `session.agentIR.lookup_tables`. Project-level tables in `session.agentIR.project_runtime_config.lookup_tables` are ignored. A `semantics.lookup` reference to a project-level table silently fails.

### Required Changes

#### 1. New file: `apps/runtime/src/services/execution/lookup-table-merger.ts`

```typescript
import type { LookupTableIR, ProjectRuntimeConfigIR } from '@abl/compiler/platform/ir/schema.js';

export class LookupTableConflictError extends Error {
  constructor(public tableName: string) {
    super(
      `Lookup table name conflict: "${tableName}" is defined in both ` +
        `agent DSL and project runtime config. Rename one to resolve.`,
    );
  }
}

/**
 * Merge agent-level and project-level lookup tables.
 * Throws LookupTableConflictError on name collision.
 */
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

Note: `ProjectRuntimeConfigIR.lookup_tables` is `LookupTableIR[]` (array) while `AgentIR.lookup_tables` is `Record<string, LookupTableIR>`. The merger normalizes both to record form.

#### 2. Update `flow-step-executor.ts`

At the call site (~line 3403):

```typescript
// Before:
if (session.agentIR?.lookup_tables && step.gather?.fields) {

// After:
import { mergeLookupTables, LookupTableConflictError } from './lookup-table-merger.js';

const mergedLookupTables = mergeLookupTables(
  session.agentIR?.lookup_tables,
  session.agentIR?.project_runtime_config,
);

if (Object.keys(mergedLookupTables).length > 0 && step.gather?.fields) {
```

Also update `buildExtractionTool()` to use merged tables when injecting values into LLM prompt.

Catch `LookupTableConflictError` and emit a `lookup_table_conflict` trace event + return an error response to the user.

#### 3. Why runtime-only conflict detection

The compiler (`compiler.ts`) is a pure function on DSL text — it has no access to project runtime config (that's in MongoDB). The earliest point where both agent and project tables are available is `runtime-executor.ts:1022`, which loads project config into `session.agentIR.project_runtime_config`. Conflict detection must happen at runtime.

---

## GAP Disposition Summary

| GAP   | Description                           | Verdict     | Notes                                                  |
| ----- | ------------------------------------- | ----------- | ------------------------------------------------------ |
| GAP-1 | Parser `options:` support             | **KEEP**    | Correct implementation                                 |
| GAP-2 | Compiler `type: 'enum'` fix           | **KEEP**    | Critical fix — unlocks the entire enum path            |
| GAP-3 | LLM prompt injection of lookup values | **MODIFY**  | Use `mergeLookupTables()` to resolve from both sources |
| GAP-4 | API header forwarding                 | **KEEP**    | Orthogonal, clean fix                                  |
| GAP-5 | GatherEditor UI                       | **REWRITE** | Remove `LookupConfigPanel`, add project table dropdown |
| GAP-6 | Collection fuzzy matching             | **KEEP**    | Orthogonal, clean fix                                  |
| GAP-7 | LRU eviction in TTLCache              | **KEEP**    | Orthogonal, clean fix                                  |
| GAP-8 | Token budget guard                    | **KEEP**    | Prerequisite for GAP-3                                 |

---

## Checklist for Author

- [ ] Add `mergeLookupTables()` in new file `lookup-table-merger.ts`
- [ ] Wire merged tables into `flow-step-executor.ts` (validation + extraction tool)
- [ ] Handle `LookupTableConflictError` with trace event and user-facing error
- [ ] Remove `LookupConfigPanel`, `ApiSourceConfig`, `HeaderKeyValueEditor` from GatherEditor
- [ ] Remove `lookup` from `FIELD_TYPE_OPTIONS` (it's not a DSL type)
- [ ] Add project table reference dropdown to GatherEditor
- [ ] Replace 12 `lookup*` fields in `GatherFieldData` with single `lookupTable?: string`
- [ ] Simplify `parseGather()` in store — just read `f.semantics?.lookup` into `lookupTable`
- [ ] Remove `serializeLookupTableEntry()` from serializer
- [ ] Remove `LOOKUP_TABLES` section emission from `serializeGatherToABL()`
- [ ] Add `semantics.lookup:` emission in serializer for fields with `lookupTable`
- [ ] Update tests to reflect merged lookup resolution
- [ ] Add unit tests for `mergeLookupTables()` (happy path, conflict error, empty inputs)
- [ ] Update HLD/LLD docs to reflect the unified architecture

---

## What's NOT Changing (Confirm These Are Fine)

- Serializer block format change (correctness fix — old format was broken)
- Default omission (`type: string`, `required: true`) in serializer (matches parser defaults)
- `EnumTagInput` component for inline enum options (correct UX for simple enums)
- All runtime resolver fixes (headers, fuzzy, LRU)
- Parser and compiler changes for enum options
