# Enum Fields & Lookup Tables — Feature Audit

> **Status:** Living document — updated 2026-03-25 (post PR review refactor)
> **Scope:** DSL parser, compiler, IR, runtime extraction, Studio UI, REST API, database

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Mechanism A: Enum Validation Rule](#mechanism-a-enum-validation-rule)
4. [Mechanism B: Lookup Tables](#mechanism-b-lookup-tables)
5. [Lookup Table Sources](#lookup-table-sources)
6. [Optimizations & Guards](#optimizations--guards)
7. [Studio UI](#studio-ui)
8. [Gaps](#gaps)
9. [Integration Checklist](#integration-checklist)
10. [E2E Test Case Checklist](#e2e-test-case-checklist)

---

## Overview

The platform has **two parallel mechanisms** for constraining gather field values to a known set:

| Mechanism               | Where Defined                                                   | Dynamic?                             | LLM-Aware?                                                 | Fuzzy Match?                                  |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| **Enum ValidationRule** | `ValidationRule.type = 'enum'`, pipe-delimited values in `rule` | No — static in IR                    | Yes — injected into JSON Schema `enum` + extraction prompt | No                                            |
| **Lookup Tables**       | `LOOKUP_TABLES:` DSL section, linked via `semantics.lookup`     | Yes — `collection` and `api` sources | **No** — only post-extraction validation                   | Yes — Levenshtein with configurable threshold |

Neither mechanism is fully wired end-to-end from DSL authoring to runtime extraction.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  DSL (ABL Text)                                              │
│                                                              │
│  GATHER:                          LOOKUP_TABLES:             │
│    cabin_class:                     cabin_classes:            │
│      type: enum                       source: inline         │
│      options: [economy,business]      values: economy,...    │
│      semantics:                       fuzzy_match: true      │
│        lookup: cabin_classes          fuzzy_threshold: 0.85  │
├──────────────────────────────────────────────────────────────┤
│  Parser (packages/core/src/parser/agent-based-parser.ts)     │
│  ┌─────────────┐  ┌──────────────────────┐                   │
│  │ GatherField  │  │ LookupTableDefinition│                   │
│  │ type: string │  │ source: inline|      │                   │
│  │ validate?    │  │   collection|api     │                   │
│  │ semantics?   │  │ values?: string[]    │                   │
│  └──────┬──────┘  └──────────┬───────────┘                   │
├─────────┼────────────────────┼───────────────────────────────┤
│  Compiler (packages/compiler/src/platform/ir/compiler.ts)    │
│         │                    │                               │
│  compileGather()      compile lookup_tables                  │
│  f.validate →         pre-compute normalized_values          │
│   {type:'custom'}     fuzzy_threshold default 0.85           │
│         │                    │                               │
│  ┌──────▼──────┐  ┌─────────▼────────────┐                   │
│  │ IR GatherField│ │ LookupTableIR        │                   │
│  │ validation:  │  │ values, normalized_  │                   │
│  │  ValidationRule│ │ values, endpoint,   │                   │
│  │ semantics:   │  │ case_sensitive,      │                   │
│  │  {lookup?}   │  │ fuzzy_match/threshold│                   │
│  └──────┬──────┘  └─────────┬────────────┘                   │
├─────────┼────────────────────┼───────────────────────────────┤
│  Runtime Extraction                                          │
│         │                    │                               │
│  Tier 1: JS (date,phone,    │                               │
│    email,currency,number)    │                               │
│  Tier 2: NLU sidecar        │                               │
│  Tier 3: LLM tool-call ◄────┼── enum ValidationRule:        │
│    buildExtractionTool()     │   injected as JSON Schema     │
│  Tier 4: Regex fallback      │   enum array + prompt hint    │
│         │                    │                               │
│         ▼                    ▼                               │
│  Post-Extraction Validation                                  │
│  ┌─────────────────┐  ┌──────────────────┐                   │
│  │ validateField()  │  │ validateWithLookup│                   │
│  │ pattern|range|   │  │ Tables()          │                   │
│  │ enum|custom      │  │ inline → Set O(1) │                   │
│  └─────────────────┘  │ collection → Mongo│                   │
│                        │ api → HTTP + SSRF │                   │
│                        │ fuzzy → Levenshtein│                  │
│                        └──────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

---

## Mechanism A: Enum Validation Rule

### IR Definition

```typescript
// packages/compiler/src/platform/ir/schema.ts (line 949)
interface ValidationRule {
  type: 'pattern' | 'range' | 'enum' | 'custom' | 'llm';
  rule: string; // For enum: pipe-delimited, e.g. "economy|business|first"
  error_message: string;
  retry_prompt?: string;
  max_retries?: number;
}
```

### Runtime Validation

```typescript
// packages/compiler/src/platform/constructs/utils.ts (line 395)
case 'enum': {
  const allowed = validation.rule.split('|');
  if (!allowed.includes(String(value))) {
    return validation.error_message;
  }
  break;
}
```

### LLM Prompt Injection

```typescript
// apps/runtime/src/services/execution/flow-step-executor.ts (line 1244)
case 'enum':
  schema.enum = field.validation.rule.split('|').map((v) => v.trim());
  break;
```

Also added to system prompt: `[allowed values: economy, business, first]`

### Current State: UNREACHABLE FROM DSL

The compiler **always** maps `validate:` → `{ type: 'custom' }`:

```typescript
// packages/compiler/src/platform/ir/compiler.ts (line 944)
validation: f.validate
  ? { type: 'custom', rule: f.validate, error_message: `Invalid ${f.name}` }
  : undefined;
```

The `type: 'enum'` ValidationRule path only works if an IR is constructed programmatically.

---

## Mechanism B: Lookup Tables

### DSL Syntax

```yaml
LOOKUP_TABLES:
  cabin_classes:
    source: inline
    values: economy, business, first
    case_sensitive: false
    fuzzy_match: true
    fuzzy_threshold: 0.85

  cities:
    source: collection
    table_name: cities
    field: name
    fuzzy_match: true

  products:
    source: api
    endpoint: https://api.example.com/products/lookup
    timeout_ms: 3000
```

### Linking to Gather Fields

```yaml
GATHER:
  cabin_class:
    type: string
    semantics:
      lookup: cabin_classes
```

### IR Representation

```typescript
// packages/compiler/src/platform/ir/schema.ts (line 862)
interface LookupTableIR {
  name: string;
  source: 'inline' | 'collection' | 'api';
  values?: string[];
  normalized_values?: string[]; // Pre-lowercased at compile time
  table_name?: string; // For collection source
  endpoint?: string; // For api source
  field?: string;
  timeout_ms?: number;
  case_sensitive: boolean;
  fuzzy_match: boolean;
  fuzzy_threshold: number; // Default 0.85
}
```

---

## Lookup Table Sources

### Inline (Static)

| Property     | Value                                                        |
| ------------ | ------------------------------------------------------------ |
| Storage      | Embedded in IR (compiled from DSL)                           |
| Lookup cost  | O(1) via `Set<string>` (WeakMap-cached)                      |
| Dynamic?     | No — values fixed at compile time                            |
| Fuzzy match? | Yes — Levenshtein with configurable threshold                |
| Max size     | No hard limit; parser warns at >1000 values with fuzzy match |

### Collection (MongoDB)

| Property         | Value                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Model            | `LookupEntry` — `packages/database/src/models/lookup-entry.model.ts`                         |
| Collection       | `lookup_entries`                                                                             |
| Schema           | `{ tenantId, projectId, tableName, value, field?, metadata? }`                               |
| Indexes          | Unique: `(tenantId, projectId, tableName, value)` — List: `(tenantId, projectId, tableName)` |
| Tenant isolation | Yes — `tenantIsolationPlugin` applied                                                        |
| Lookup cost      | Single `findOne` with regex for case-insensitive match                                       |
| Dynamic?         | Yes — CRUD via REST API                                                                      |
| Fuzzy match?     | **No** — exact/case-insensitive only                                                         |
| Cache            | TTL 5min, max 500 entries (FIFO eviction)                                                    |

**REST API** (`apps/runtime/src/routes/lookup-data.ts`):

| Route                 | Method | Permission          | Limits                            |
| --------------------- | ------ | ------------------- | --------------------------------- |
| `/:tableName/entries` | POST   | `lookup_data:write` | 1,000 entries/request             |
| `/:tableName/entries` | GET    | `lookup_data:read`  | Paginated, max 1,000/page         |
| `/:tableName/entries` | DELETE | `lookup_data:write` | Deletes all in table              |
| `/:tableName/upload`  | POST   | `lookup_data:write` | 10K values, 1MB body, CSV or JSON |

### API (Remote HTTP)

| Property          | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Protocol          | HTTP GET to configured endpoint                               |
| Query params      | `?value=X&field=Y`                                            |
| Expected response | `{ found: boolean, matched_value?: string }`                  |
| SSRF protection   | `validateUrlForSSRF()` blocks private/internal IPs            |
| Timeout           | Configurable `timeout_ms`, default 5,000ms                    |
| Circuit breaker   | 3 failures → 30s open, per-endpoint                           |
| Cache             | TTL 5min, max 200 entries (FIFO eviction)                     |
| Auth forwarding   | DONE — configured `headers` forwarded in fetch (GAP-4 closed) |
| Retry             | **Not supported** — single attempt, then circuit breaker      |
| Dynamic?          | Fully dynamic — external system controls values               |
| Fuzzy match?      | Delegated to remote API                                       |

---

## Optimizations & Guards

### Caching Layer

| Cache                 | Scope           | Max Size  | TTL                      | Eviction                  | Implementation                        |
| --------------------- | --------------- | --------- | ------------------------ | ------------------------- | ------------------------------------- |
| Inline Set            | Per IR instance | Unbounded | Lifetime of IR (WeakMap) | GC with IR                | `WeakMap<LookupTableIR, Set<string>>` |
| Inline Normalized Set | Per IR instance | Unbounded | Lifetime of IR           | GC with IR                | `WeakMap<LookupTableIR, Set<string>>` |
| Collection            | Global          | 500       | 5 min                    | LRU (least recently used) | `TTLCache<LookupResult>`              |
| API                   | Global          | 200       | 5 min                    | LRU (least recently used) | `TTLCache<LookupResult>`              |

### Circuit Breaker (API Source)

```
State: Map<endpoint, { failures: number, openUntil: number }>

Request → isCircuitOpen(endpoint)?
  ├─ Yes (failures >= 3 AND now < openUntil) → return { found: false, error: 'circuit open' }
  └─ No → attempt fetch
       ├─ Success → recordSuccess(endpoint) [deletes state]
       └─ Failure → recordFailure(endpoint) [increments, sets openUntil on threshold]
```

Constants: `CIRCUIT_BREAKER_THRESHOLD = 3`, `CIRCUIT_BREAKER_RESET_MS = 30_000`

### Size & Upload Limits

| Limit                          | Value                    | Enforced At           |
| ------------------------------ | ------------------------ | --------------------- |
| Inline values with fuzzy match | Warning at >1,000        | Parser (non-blocking) |
| Bulk upsert entries            | 1,000/request            | REST API (Zod schema) |
| File upload values             | 10,000 max               | REST API              |
| File upload body               | 1 MB                     | REST API              |
| Paginated list                 | 1,000/page (default 100) | REST API              |

### Security

| Guard             | Scope             | File                                              |
| ----------------- | ----------------- | ------------------------------------------------- |
| SSRF validation   | API source URLs   | `lookup-resolver.ts` line 326                     |
| Tenant isolation  | Collection source | `lookup-entry.model.ts` — plugin + compound index |
| Project scoping   | REST API routes   | `requireProjectScope` middleware                  |
| Auth middleware   | All lookup routes | `authMiddleware`                                  |
| Permission checks | Per-route         | `lookup_data:read`, `lookup_data:write`           |

---

## Studio UI

### Lookup Table Management (Project Settings)

**File:** `apps/studio/src/components/settings/RuntimeConfigTab.tsx`

Full CRUD interface for managing lookup tables at the project level:

- Add/remove lookup tables
- Source type selector: `inline`, `collection`, `api`
- **Inline:** comma-separated values text input
- **Collection:** table name, field name, CSV/JSON file upload (1MB limit)
- **API:** endpoint URL, timeout configuration (100–30,000ms)
- Case sensitivity toggle
- Fuzzy match toggle with threshold slider (0–1, step 0.05)
- Stored in `project_runtime_configs.lookup_tables[]`

### Gather Field Editor (Agent Editor)

**File:** `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`

Editable properties: name, type (including `enum`), required, prompt, sensitive, sensitiveDisplay, maskConfig, transient, extractionPattern.

- **Enum values:** Editable via `EnumTagInput` when `type === 'enum'`
- **Lookup table reference:** `string` type fields show a dropdown of project-level lookup tables (fetched from `/api/projects/:pid/runtime-config`). Sets `semantics.lookup: tableName` on the field.
- Lookup table configuration (source, endpoint, fuzzy settings) is NOT inline — managed in RuntimeConfigTab.

**Architecture decision (PR review 2026-03-25):** Simple enums = agent-local (`type: enum` + `options`). Complex lookups = project-level (`semantics.lookup: tableName`). No duplication.

### Runtime Lookup Table Merger

**File:** `apps/runtime/src/services/execution/lookup-table-merger.ts`

At runtime, agent-level lookup tables (from DSL `LOOKUP_TABLES:`) and project-level lookup tables (from `project_runtime_configs`) are merged into a single record. Name collision throws `LookupTableConflictError`. Merge happens once per gather step, result passed to `buildExtractionTool()`, prompt hints, and `validateWithLookupTables()`.

### Test Context (Preview)

**File:** `apps/studio/src/components/test-context/GatherFieldEditor.tsx`

When `field.enum_values` exists on the IR, renders a `<select>` dropdown. `enum_values` is now populated by the compiler (GAP-2 closed).

### Language Service (IDE Completions)

**File:** `packages/language-service/src/completions.ts`

- `gather_type` completions include `enum` with detail "One of a set of options"
- `GATHER_FIELD_PROPERTIES` includes `options` with detail "Valid options for enum type"
- But `options` is **not parsed** by the agent-based-parser

---

## Gaps

### GAP-1: No `values`/`options` property on GatherField (Parser + AST) — CLOSED

**Severity:** High — blocks enum authoring from DSL
**Resolution:** Added `options?: string[]` to GatherField/FlowGatherField. Parser recognizes OPTIONS: with bracket and comma-separated syntax. 7 unit tests.

The language service advertises `options` as a valid gather field property, but the parser does not recognize or parse it. The AST `GatherField` type has no `options`, `values`, or `enum_values` property.

**Impact:** Users see `options` in IDE autocomplete but it does nothing.

**Files to change:**

- `packages/core/src/types/agent-based.ts` — Add `options?: string[]` to `GatherField` and `FlowGatherField`
- `packages/core/src/parser/agent-based-parser.ts` — Parse `options:` property (comma-separated or bracket list)

### GAP-2: Compiler always emits `type: 'custom'` for validation — CLOSED

**Severity:** High — enum validation is unreachable from DSL
**Resolution:** Compiler now emits `{ type: 'enum', rule: options.join('|') }` when `field.type === 'enum'` and `options` exists. Also populates `enum_values`. 5 unit tests.

Even if a user writes `validate: "economy|business|first"`, the compiler wraps it as `{ type: 'custom', rule: ... }` which skips the enum validation path at runtime.

**Impact:** The enum validation path in `validateField()`, the JSON Schema `enum` injection in `buildExtractionTool()`, and the prompt hints — all dead code from the DSL perspective.

**Files to change:**

- `packages/compiler/src/platform/ir/compiler.ts` — When `field.type === 'enum'` and `field.options` exists, emit `{ type: 'enum', rule: field.options.join('|') }` instead of `type: 'custom'`
- Also populate `enum_values` on the IR gather field for Studio test context

### GAP-3: Lookup table values not injected into LLM extraction prompt — CLOSED

**Severity:** High — causes unnecessary re-prompts
**Resolution:** `buildExtractionTool()` now injects inline lookup values as JSON Schema enum (≤100 values) or description hint (>100 values). API/collection sources not injected (dynamic). 9 unit tests.

The LLM extraction tool schema (`buildExtractionTool`) injects `ValidationRule.enum` values but does NOT inject lookup table values. The LLM extracts blindly, then lookup validation rejects invalid values, wasting a conversational turn + LLM call.

**Impact:** For tables with known values (inline, cached collection), the LLM could be guided with an `enum` constraint or prompt hint. Instead, every lookup miss causes a re-prompt cycle.

**Files to change:**

- `apps/runtime/src/services/execution/flow-step-executor.ts` — In `buildExtractionTool()`, resolve inline lookup table values and inject as JSON Schema `enum` or description hint
- For dynamic sources (collection/api), inject cached values as prompt hints when available, with token budget guard

### GAP-4: No auth header forwarding for API lookup source — CLOSED

**Severity:** Medium — blocks authenticated remote LOVs
**Resolution:** Added `headers?: Record<string, string>` to LookupTableIR. Parser handles `headers:` sub-block. Resolver forwards headers in API fetch. 6 unit tests (2 header + 4 parser).

The API source sends only `Content-Type: application/json`. No mechanism to forward Bearer tokens, API keys, or custom headers.

**Files to change:**

- `packages/compiler/src/platform/ir/schema.ts` — Add `headers?: Record<string, string>` or `auth_profile?: string` to `LookupTableIR`
- `apps/runtime/src/services/execution/lookup-resolver.ts` — Forward configured headers on fetch

### GAP-5: GatherEditor UI missing enum values + lookup assignment — CLOSED

**Severity:** Medium — visual editing requires DSL for these features
**Resolution (updated 2026-03-25):** Added `EnumTagInput` for enum values. For lookups, replaced inline LookupConfigPanel with a project-level table dropdown on `string` fields. `GatherFieldData` simplified from 12 `lookup*` fields to single `lookupTable?: string`. Serializer emits `semantics.lookup: tableName` (no LOOKUP_TABLES section — managed in RuntimeConfigTab).

The GatherEditor shows `type: enum` as an option but provides no UI to enter allowed values. No UI to link a field to a lookup table via `semantics.lookup`.

**Files to change:**

- `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx` — Add values input when `type === 'enum'`, add lookup table dropdown populated from project runtime config

### GAP-6: Collection source has no fuzzy matching — CLOSED

**Severity:** Low — inconsistent with inline source capabilities
**Resolution:** Collection source now falls back to fuzzy matching via Levenshtein when exact match fails and `fuzzy_match: true`. 3 unit tests.

Inline source supports fuzzy matching via Levenshtein. Collection source only supports exact/case-insensitive matching. For large dynamic value sets (e.g., city names), fuzzy matching would improve UX.

### GAP-7: No LRU eviction in TTLCache — CLOSED

**Severity:** Low — FIFO eviction may evict hot entries
**Resolution:** TTLCache now uses LRU eviction. Accessed entries are moved to most-recent position. 1 unit test.

The `TTLCache` evicts the oldest-inserted entry when at capacity, not the least-recently-used. Under steady-state load, hot entries may be evicted while cold entries remain.

### GAP-8: Token budget guard for large value sets in LLM prompt — CLOSED

**Severity:** Medium — prerequisite for GAP-3
**Resolution:** Values ≤100 injected as JSON Schema enum. Values >100 get description-only hint with 5 samples + total count. 2 unit tests (boundary at 100, >100 hint).

When injecting lookup values into the LLM prompt (GAP-3 fix), large tables (1,000+ values) could blow the token budget. Need a cap on injected values with a fallback to description-only hint.

---

## Integration Checklist

### DSL → Parser

| #   | Item                                                         | Status | File                         | Notes                                         |
| --- | ------------------------------------------------------------ | ------ | ---------------------------- | --------------------------------------------- |
| 1   | `type: enum` recognized as gather field type                 | DONE   | `completions.ts:119`         | Language service lists it                     |
| 2   | `options:` parsed for gather fields                          | DONE   | `agent-based-parser.ts`      | GAP-1 closed — bracket list + comma-separated |
| 3   | `options` stored on AST `GatherField`                        | DONE   | `agent-based.ts`             | GAP-1 closed                                  |
| 4   | `options` stored on AST `FlowGatherField`                    | DONE   | `agent-based.ts`             | GAP-1 closed                                  |
| 5   | `LOOKUP_TABLES:` section parsed                              | DONE   | `agent-based-parser.ts:5538` | inline/collection/api                         |
| 6   | `semantics.lookup` parsed                                    | DONE   | `agent-based-parser.ts`      | Links field to table                          |
| 7   | Parser warns on >1000 inline values + fuzzy                  | DONE   | `agent-based-parser.ts:5446` | Non-blocking warning                          |
| 8   | Legacy source aliases (`mongodb`→`collection`, `http`→`api`) | DONE   | `agent-based-parser.ts`      |                                               |

### Parser → Compiler

| #   | Item                                                  | Status | File              | Notes                       |
| --- | ----------------------------------------------------- | ------ | ----------------- | --------------------------- | ------------ |
| 9   | `f.validate` compiles to `ValidationRule`             | DONE   | `compiler.ts:944` | **Always `type: 'custom'`** |
| 10  | `f.options` compiles to `{ type: 'enum', rule: join(' | ') }`  | DONE              | `compiler.ts`               | GAP-2 closed |
| 11  | `enum_values` populated on IR gather field            | DONE   | `compiler.ts`     | GAP-2 closed                |
| 12  | Lookup tables compiled with `normalized_values`       | DONE   | `compiler.ts:619` | Pre-lowercased              |
| 13  | `semantics.lookup` carried to IR                      | DONE   | `compiler.ts`     | camelCase → snake_case      |
| 14  | `fuzzy_threshold` defaults to 0.85                    | DONE   | `compiler.ts:630` |                             |

### IR → Runtime Extraction

| #   | Item                                                        | Status       | File                         | Notes                          |
| --- | ----------------------------------------------------------- | ------------ | ---------------------------- | ------------------------------ |
| 15  | `ValidationRule.enum` → JSON Schema `enum` array            | DONE         | `flow-step-executor.ts:1244` | In `buildExtractionTool()`     |
| 16  | `ValidationRule.enum` → prompt hint `[allowed values: ...]` | DONE         | `flow-step-executor.ts:1689` |                                |
| 17  | Lookup inline values → JSON Schema `enum` in tool           | DONE         | `flow-step-executor.ts`      | GAP-3 closed — ≤100 as enum    |
| 18  | Lookup cached collection values → prompt hint               | DONE         | `flow-step-executor.ts`      | GAP-3 closed — >100 as hint    |
| 19  | Token budget guard for injected values                      | DONE         | `flow-step-executor.ts`      | GAP-8 closed — 100 value limit |
| 20  | `type: enum` handled in JS extraction tier                  | **NOT DONE** | `js-extraction.ts`           | Falls through to LLM tier      |

### Runtime Post-Extraction Validation

| #   | Item                                            | Status | File                         | Notes                                        |
| --- | ----------------------------------------------- | ------ | ---------------------------- | -------------------------------------------- |
| 21  | `validateField()` handles `type: 'enum'`        | DONE   | `utils.ts:395`               | Pipe-delimited split                         |
| 22  | `validateField()` handles `type: 'pattern'`     | DONE   | `utils.ts:370`               | RegExp test                                  |
| 23  | `validateField()` handles `type: 'range'`       | DONE   | `utils.ts:380`               | Min-max numeric                              |
| 24  | `validateWithLookupTables()` inline exact match | DONE   | `flow-step-executor.ts:282`  | Via `resolveLookup`                          |
| 25  | `validateWithLookupTables()` inline fuzzy match | DONE   | `lookup-resolver.ts:212`     | Levenshtein                                  |
| 26  | `validateWithLookupTables()` collection match   | DONE   | `lookup-resolver.ts:270`     | MongoDB findOne                              |
| 27  | `validateWithLookupTables()` API match          | DONE   | `lookup-resolver.ts:310`     | HTTP GET + SSRF                              |
| 28  | Fuzzy match → user confirmation flow            | DONE   | `flow-step-executor.ts:2259` | Yes/no regex                                 |
| 29  | Invalid value → clear + re-prompt               | DONE   | `flow-step-executor.ts:3354` |                                              |
| 30  | Trace events for lookup validation              | DONE   | `flow-step-executor.ts`      | `lookup_validation_failed`, `lookup_fuzzy_*` |

### Caching & Resilience

| #   | Item                                  | Status | File                     | Notes              |
| --- | ------------------------------------- | ------ | ------------------------ | ------------------ |
| 31  | Inline O(1) Set cache (WeakMap)       | DONE   | `lookup-resolver.ts:120` | GC'd with IR       |
| 32  | Inline normalized Set cache           | DONE   | `lookup-resolver.ts:133` | Pre-lowercased     |
| 33  | Collection TTL cache (500, 5min)      | DONE   | `lookup-resolver.ts:77`  | FIFO eviction      |
| 34  | API TTL cache (200, 5min)             | DONE   | `lookup-resolver.ts:78`  | FIFO eviction      |
| 35  | API circuit breaker (3 failures, 30s) | DONE   | `lookup-resolver.ts:82`  | Per-endpoint       |
| 36  | API SSRF validation                   | DONE   | `lookup-resolver.ts:326` | Blocks private IPs |
| 37  | API configurable timeout              | DONE   | `lookup-resolver.ts:340` | Default 5s         |
| 38  | LRU eviction for caches               | DONE   | `lookup-resolver.ts`     | GAP-7 closed       |

### REST API (Collection CRUD)

| #   | Item                            | Status | File                    | Notes           |
| --- | ------------------------------- | ------ | ----------------------- | --------------- |
| 39  | Bulk upsert (POST entries)      | DONE   | `lookup-data.ts:141`    | 1K/request      |
| 40  | Paginated list (GET entries)    | DONE   | `lookup-data.ts:238`    | 1K/page max     |
| 41  | Delete all (DELETE entries)     | DONE   | `lookup-data.ts:315`    | Per table       |
| 42  | CSV/JSON upload                 | DONE   | `lookup-data.ts:377`    | 10K values, 1MB |
| 43  | Auth + project scope middleware | DONE   | `lookup-data.ts`        |                 |
| 44  | Tenant isolation on model       | DONE   | `lookup-entry.model.ts` | Plugin + index  |
| 45  | Zod validation on inputs        | DONE   | `lookup-data.ts:114`    |                 |

### Studio UI

| #   | Item                                  | Status | File                       | Notes                                                   |
| --- | ------------------------------------- | ------ | -------------------------- | ------------------------------------------------------- |
| 46  | Lookup table CRUD in Settings         | DONE   | `RuntimeConfigTab.tsx:729` |                                                         |
| 47  | Source type selector                  | DONE   | `RuntimeConfigTab.tsx`     | inline/collection/api                                   |
| 48  | Inline values editor                  | DONE   | `RuntimeConfigTab.tsx`     | Comma-separated input                                   |
| 49  | API endpoint + timeout config         | DONE   | `RuntimeConfigTab.tsx`     |                                                         |
| 50  | Collection file upload (CSV/JSON)     | DONE   | `RuntimeConfigTab.tsx`     | 1MB limit                                               |
| 51  | Case sensitivity toggle               | DONE   | `RuntimeConfigTab.tsx`     |                                                         |
| 52  | Fuzzy match toggle + threshold        | DONE   | `RuntimeConfigTab.tsx`     | Slider 0–1                                              |
| 53  | Enum dropdown in test context         | DONE   | `GatherFieldEditor.tsx:72` | Renders `<select>`                                      |
| 54  | Enum values editor in GatherEditor    | DONE   | `GatherEditor.tsx`         | GAP-5 closed — EnumTagInput                             |
| 55  | Lookup table dropdown in GatherEditor | DONE   | `GatherEditor.tsx`         | GAP-5 revised — project table dropdown on string fields |
| 56a | Lookup table merger (agent+project)   | DONE   | `lookup-table-merger.ts`   | Merges both sources, throws on name conflict            |

### Database

| #   | Item                        | Status | File                    | Notes                           |
| --- | --------------------------- | ------ | ----------------------- | ------------------------------- |
| 56  | `lookup_entries` collection | DONE   | `lookup-entry.model.ts` |                                 |
| 57  | Unique compound index       | DONE   | `lookup-entry.model.ts` | (tenant, project, table, value) |
| 58  | List index                  | DONE   | `lookup-entry.model.ts` | (tenant, project, table)        |
| 59  | Tenant isolation plugin     | DONE   | `lookup-entry.model.ts` |                                 |

---

## E2E Test Case Checklist

### DSL Parsing & Compilation

| #   | Test Case                                                         | Status                 | Notes                                |
| --- | ----------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| T1  | Parse `type: enum` gather field with `options: [a, b, c]`         | **NOT TESTED**         | Blocked by GAP-1 (not parseable)     |
| T2  | Parse `LOOKUP_TABLES:` with inline source                         | **NEEDS VERIFICATION** | Parser has code, need dedicated test |
| T3  | Parse `LOOKUP_TABLES:` with collection source                     | **NEEDS VERIFICATION** |                                      |
| T4  | Parse `LOOKUP_TABLES:` with api source                            | **NEEDS VERIFICATION** |                                      |
| T5  | Parse `semantics.lookup` linking field to table                   | **NEEDS VERIFICATION** |                                      |
| T6  | Parser warns on >1000 values with fuzzy match                     | **NOT TESTED**         |                                      |
| T7  | Compile enum field with options → IR `ValidationRule.type='enum'` | **NOT TESTED**         | Blocked by GAP-2                     |
| T8  | Compile lookup tables with pre-normalized values                  | **NEEDS VERIFICATION** |                                      |
| T9  | Compile `semantics.lookup` → IR `semantics.lookup`                | **NEEDS VERIFICATION** |                                      |

### Runtime Extraction — Enum Validation Path

| #   | Test Case                                                          | Status                 | Notes                                |
| --- | ------------------------------------------------------------------ | ---------------------- | ------------------------------------ |
| T10 | LLM extraction tool includes `enum` constraint from ValidationRule | **NOT TESTED**         | Path exists but unreachable from DSL |
| T11 | LLM extraction prompt includes `[allowed values: ...]` hint        | **NOT TESTED**         | Same                                 |
| T12 | `validateField()` accepts valid enum value                         | **NEEDS VERIFICATION** | Unit test exists?                    |
| T13 | `validateField()` rejects invalid enum value                       | **NEEDS VERIFICATION** |                                      |
| T14 | Invalid enum value triggers re-prompt with error message           | **NOT TESTED**         | E2E                                  |

### Runtime Extraction — Lookup Table Validation

| #   | Test Case                                                            | Status         | Notes |
| --- | -------------------------------------------------------------------- | -------------- | ----- |
| T15 | Inline lookup: exact match accepts and normalizes value              | **NOT TESTED** |       |
| T16 | Inline lookup: case-insensitive match (when `case_sensitive: false`) | **NOT TESTED** |       |
| T17 | Inline lookup: case-sensitive rejection                              | **NOT TESTED** |       |
| T18 | Inline lookup: fuzzy match triggers confirmation prompt              | **NOT TESTED** |       |
| T19 | Inline lookup: fuzzy match — user accepts suggestion                 | **NOT TESTED** |       |
| T20 | Inline lookup: fuzzy match — user rejects suggestion                 | **NOT TESTED** |       |
| T21 | Inline lookup: no match → clear value + re-prompt                    | **NOT TESTED** |       |
| T22 | Collection lookup: exact match from MongoDB                          | **NOT TESTED** |       |
| T23 | Collection lookup: cache hit within TTL                              | **NOT TESTED** |       |
| T24 | Collection lookup: cache miss after TTL expiry                       | **NOT TESTED** |       |
| T25 | Collection lookup: tenant isolation (cross-tenant returns not-found) | **NOT TESTED** |       |
| T26 | API lookup: successful remote validation                             | **NOT TESTED** |       |
| T27 | API lookup: timeout handling                                         | **NOT TESTED** |       |
| T28 | API lookup: circuit breaker opens after 3 failures                   | **NOT TESTED** |       |
| T29 | API lookup: circuit breaker resets after 30s                         | **NOT TESTED** |       |
| T30 | API lookup: SSRF blocks private IP endpoint                          | **NOT TESTED** |       |
| T31 | API lookup: cache hit within TTL                                     | **NOT TESTED** |       |
| T32 | Batch resolution: multiple fields validated concurrently             | **NOT TESTED** |       |

### LLM Prompt Injection of Lookup Values (Gap-3 — Future)

| #   | Test Case                                                            | Status              | Notes            |
| --- | -------------------------------------------------------------------- | ------------------- | ---------------- |
| T33 | Inline lookup values injected as JSON Schema enum in extraction tool | **NOT IMPLEMENTED** | Blocked by GAP-3 |
| T34 | Collection cached values injected as prompt hint                     | **NOT IMPLEMENTED** | Blocked by GAP-3 |
| T35 | Token budget guard truncates large value sets                        | **NOT IMPLEMENTED** | Blocked by GAP-8 |
| T36 | API source values NOT injected (too dynamic)                         | **NOT IMPLEMENTED** | Design decision  |

### REST API (Collection CRUD)

| #   | Test Case                                          | Status         | Notes |
| --- | -------------------------------------------------- | -------------- | ----- |
| T37 | Bulk upsert entries — happy path                   | **NOT TESTED** |       |
| T38 | Bulk upsert — exceeds 1,000 entries → 400          | **NOT TESTED** |       |
| T39 | Bulk upsert — duplicate values → upsert (no error) | **NOT TESTED** |       |
| T40 | Paginated list — default limit 100                 | **NOT TESTED** |       |
| T41 | Paginated list — custom offset/limit               | **NOT TESTED** |       |
| T42 | Delete all entries for table                       | **NOT TESTED** |       |
| T43 | CSV upload — one value per line                    | **NOT TESTED** |       |
| T44 | CSV upload — comments (#) skipped                  | **NOT TESTED** |       |
| T45 | CSV upload — quoted values with commas             | **NOT TESTED** |       |
| T46 | JSON upload — array of strings                     | **NOT TESTED** |       |
| T47 | JSON upload — array of objects `{value: "x"}`      | **NOT TESTED** |       |
| T48 | Upload exceeds 10K values → 400                    | **NOT TESTED** |       |
| T49 | Upload exceeds 1MB → 413                           | **NOT TESTED** |       |
| T50 | Auth required — unauthenticated → 401              | **NOT TESTED** |       |
| T51 | Project scope — wrong project → 404                | **NOT TESTED** |       |
| T52 | Tenant isolation — cross-tenant → empty/404        | **NOT TESTED** |       |

### Studio UI

| #   | Test Case                                                        | Status              | Notes                                  |
| --- | ---------------------------------------------------------------- | ------------------- | -------------------------------------- |
| T53 | Add lookup table in Settings UI                                  | **NOT TESTED**      | Manual/Playwright                      |
| T54 | Edit inline values                                               | **NOT TESTED**      |                                        |
| T55 | Switch source type                                               | **NOT TESTED**      |                                        |
| T56 | Upload CSV file for collection                                   | **NOT TESTED**      |                                        |
| T57 | Toggle fuzzy match + adjust threshold                            | **NOT TESTED**      |                                        |
| T58 | Enum dropdown renders in test context when `enum_values` present | **NOT TESTED**      | Blocked: `enum_values` never populated |
| T59 | Enum values editor in GatherEditor                               | **NOT IMPLEMENTED** | GAP-5                                  |
| T60 | Lookup table assignment in GatherEditor                          | **NOT IMPLEMENTED** | GAP-5                                  |

### End-to-End Conversation Flow

| #   | Test Case                                                                           | Status         | Notes                |
| --- | ----------------------------------------------------------------------------------- | -------------- | -------------------- |
| T61 | Full gather flow: enum field → user provides valid value → accepted                 | **NOT TESTED** | Requires GAP-1+2 fix |
| T62 | Full gather flow: enum field → user provides invalid value → re-prompt with options | **NOT TESTED** |                      |
| T63 | Full gather flow: lookup field → inline exact match → accepted                      | **NOT TESTED** |                      |
| T64 | Full gather flow: lookup field → fuzzy match → confirmation → accepted              | **NOT TESTED** |                      |
| T65 | Full gather flow: lookup field → fuzzy match → rejected → re-prompt                 | **NOT TESTED** |                      |
| T66 | Full gather flow: lookup field → collection source → value validated                | **NOT TESTED** |                      |
| T67 | Full gather flow: lookup field → API source → value validated                       | **NOT TESTED** |                      |
| T68 | Full gather flow: lookup field → API down → circuit breaker → graceful degradation  | **NOT TESTED** |                      |

---

## Key Files Reference

| File                                                                | Role                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                            | AST types: GatherField, LookupTableDefinition                     |
| `packages/core/src/parser/agent-based-parser.ts`                    | DSL parser: parseGather, parseLookupTables                        |
| `packages/compiler/src/platform/ir/schema.ts`                       | IR types: GatherField, ValidationRule, LookupTableIR              |
| `packages/compiler/src/platform/ir/compiler.ts`                     | Compiler: compileGather, lookup table compilation                 |
| `packages/compiler/src/platform/constructs/utils.ts`                | validateField: pattern/range/enum/custom                          |
| `apps/runtime/src/services/execution/flow-step-executor.ts`         | buildExtractionTool, validateWithLookupTables, fuzzy flow         |
| `apps/runtime/src/services/execution/lookup-resolver.ts`            | Lookup resolution: inline/collection/api, caches, circuit breaker |
| `apps/runtime/src/services/execution/prompt-builder.ts`             | ablTypeToJsonSchema                                               |
| `apps/runtime/src/services/execution/js-extraction.ts`              | Tier 1 JS extraction (no enum support)                            |
| `apps/runtime/src/routes/lookup-data.ts`                            | REST API: CRUD, upload, pagination                                |
| `packages/database/src/models/lookup-entry.model.ts`                | MongoDB model: lookup_entries                                     |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`          | Studio: lookup table management UI                                |
| `apps/runtime/src/services/execution/lookup-table-merger.ts`        | Runtime: merge agent + project lookup tables                      |
| `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx` | Studio: gather field editor (enum tag input + lookup dropdown)    |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`           | Studio: fetches lookupTableNames for GatherEditor                 |
| `apps/studio/src/components/test-context/GatherFieldEditor.tsx`     | Studio: test context enum dropdown                                |
| `packages/language-service/src/completions.ts`                      | IDE: gather_type + field property completions                     |
