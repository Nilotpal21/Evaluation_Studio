# Enum Fields & Lookup Tables — Implementation Plan (LLD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close GAP-1 through GAP-8 to make enum fields and lookup tables fully functional across DSL → Parser → Compiler → IR → Runtime → Studio UI.

**Architecture:** Extend existing pipeline — no new services. Add `options` to parser, wire `type: 'enum'` in compiler, inject lookup values into LLM prompts, add lookup field type to Studio GatherEditor.

**Tech Stack:** TypeScript, Vitest, Zustand, React, MongoDB

**Feature Spec**: `docs/features/enum-and-lookup-tables.md`
**HLD**: `docs/specs/enum-and-lookup-tables.hld.md`
**Test Spec**: `docs/testing/enum-and-lookup-tables.md`
**Status**: COMPLETED (post-implementation documentation)
**Last Updated**: 2026-03-24

---

## Phase 1: Parser & Core Types (GAP-1, GAP-4 partial)

**Files:**

- Modify: `packages/core/src/types/agent-based.ts`
- Modify: `packages/core/src/parser/agent-based-parser.ts`
- Create: `packages/core/src/__tests__/parser-enum-options.test.ts`
- Create: `packages/core/src/__tests__/parser-lookup-headers.test.ts`

**Exit Criteria:**

- [x] `GatherField` and `FlowGatherField` types have `options?: string[]`
- [x] `LookupTableDefinition` type has `headers?: Record<string, string>`
- [x] Parser recognizes `OPTIONS:` on gather fields (bracket list and comma-separated)
- [x] Parser recognizes `headers:` sub-block on lookup table definitions
- [x] `headers:` not mistaken for a new table name (LOOKUP_BLOCK_PROPERTIES guard)
- [x] 11 unit tests passing (7 parser-enum-options + 4 parser-lookup-headers)
- [x] Committed

---

## Phase 2: Compiler (GAP-2)

**Files:**

- Modify: `packages/compiler/src/platform/ir/compiler.ts`
- Modify: `packages/compiler/src/platform/ir/schema.ts`
- Create: `packages/compiler/src/__tests__/gather-enum-compilation.test.ts`

**Exit Criteria:**

- [x] IR `LookupTableIR` has `headers?: Record<string, string>`
- [x] IR `GatherField` has `enum_values?: string[]`
- [x] Compiler emits `ValidationRule { type: 'enum', rule: 'a|b|c' }` when `field.type === 'enum'` and `field.options` exists
- [x] Compiler populates `enum_values` from `options`
- [x] Compiler carries `headers` from parsed lookup table to IR
- [x] 5 unit tests passing
- [x] Committed

---

## Phase 3: Runtime — LLM Prompt Injection (GAP-3, GAP-8)

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`
- Create: `apps/runtime/src/__tests__/extraction-lookup-injection.test.ts`

**Exit Criteria:**

- [x] `buildExtractionTool()` accepts optional `lookupTables` parameter
- [x] Inline lookup values (≤100) injected as JSON Schema `enum` on extraction tool
- [x] Large inline tables (>100) use description hint with sample values + total count
- [x] API/collection sources NOT injected (too dynamic)
- [x] Existing enum validation takes precedence over lookup injection
- [x] Missing/undefined lookup table handled gracefully
- [x] 9 unit tests passing
- [x] Committed

---

## Phase 4: Runtime — Lookup Resolver Improvements (GAP-4, GAP-6, GAP-7)

**Files:**

- Modify: `apps/runtime/src/services/execution/lookup-resolver.ts`
- Create: `apps/runtime/src/__tests__/lookup-resolver-gaps.test.ts`

**Exit Criteria:**

- [x] API source forwards configured `headers` in fetch requests (merged with Content-Type)
- [x] Collection source falls back to fuzzy matching when exact match fails
- [x] Fuzzy threshold respected (below threshold → not found)
- [x] `fuzzy_match: false` prevents fuzzy attempt
- [x] TTLCache uses LRU eviction (not FIFO)
- [x] 6 unit tests passing
- [x] Committed

---

## Phase 5: Studio — GatherEditor Lookup Field Type (GAP-5)

**Files:**

- Modify: `apps/studio/src/store/agent-detail-store.ts`
- Modify: `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`
- Modify: `apps/studio/src/lib/abl-serializers.ts`

### 5a: Data Model

**Exit Criteria:**

- [x] `GatherFieldData` extended with 12 lookup fields (lookupSource, lookupValues, lookupEndpoint, lookupMethod, lookupBody, lookupField, lookupTimeoutMs, lookupHeaders, lookupTableName, lookupCaseSensitive, lookupFuzzyMatch, lookupFuzzyThreshold)
- [x] `lookupMethod` supports GET, POST, PUT, PATCH, DELETE

### 5b: GatherEditor UI

**Exit Criteria:**

- [x] `lookup` added to `FIELD_TYPE_OPTIONS` and `TYPE_BADGE_COLORS`
- [x] `LookupConfigPanel` renders with SegmentedControl (Inline/API/Collection)
- [x] Inline source: tag input for values (reuses EnumTagInput pattern)
- [x] API source: endpoint URL, method selector, response field, timeout, headers key-value editor, request body (for non-GET), test endpoint button
- [x] Collection source: table name, match field, file upload zone
- [x] Shared controls: case sensitive toggle, fuzzy match toggle, fuzzy threshold
- [x] `HeaderKeyValueEditor` component for HTTP headers

### 5c: Hydration (IR → Editor)

**Exit Criteria:**

- [x] `parseGather()` reads `ir.lookup_tables` and maps to `GatherFieldData.lookup*` fields
- [x] Fields with `semantics.lookup` reference get `type = 'lookup'`

### 5d: Serialization (Editor → DSL)

**Exit Criteria:**

- [x] `serializeLookupTableEntry()` emits correct DSL for each source type
- [x] `serializeGatherToABL()` returns both GATHER and LOOKUP_TABLES section edits
- [x] Lookup fields emit `semantics:\n  lookup: <tableName>` in GATHER section
- [x] Field type emitted as `string` in DSL (lookup is a Studio concept)
- [x] Method serialized only when not GET
- [x] Body serialized for non-GET methods

### 5e: Smoke Test

**Exit Criteria:**

- [x] All 3 source types render correctly
- [x] Method selector shows 5 options (GET/POST/PUT/PATCH/DELETE)
- [x] Request body appears for non-GET methods
- [x] Test endpoint button sends real request and shows response
- [x] Manual round-trip: create lookup field → save → reload → all fields preserved

---

## Phase 6: Documentation (Post-Implementation)

**Files:**

- Create: `docs/testing/enum-and-lookup-tables.md`
- Create: `docs/specs/enum-and-lookup-tables.hld.md`
- Create: `docs/plans/2026-03-24-enum-and-lookup-tables-impl-plan.md`
- Create: `docs/sdlc-logs/enum-and-lookup-tables/`

**Exit Criteria:**

- [x] Test spec with coverage matrix, 7 E2E scenarios, 7 integration scenarios
- [x] HLD with 12 architectural concerns, alternatives, data model
- [x] Implementation plan (this document)
- [x] SDLC logs for oracle decisions

---

## Commit History

| Commit      | Phase | Description                                                     |
| ----------- | ----- | --------------------------------------------------------------- |
| `3b2a63ce6` | 5b    | Add lookup to field type options and badge colors               |
| `2b93b9588` | 5b    | Add LookupConfigPanel with inline/api/collection sources        |
| `bd3e56290` | 5c    | Hydrate lookup fields from IR lookup_tables in parseGather      |
| `12f10d804` | 5d    | Serialize lookup gather fields to LOOKUP_TABLES DSL section     |
| `abadf578a` | 5b    | Add HTTP method selector and test endpoint button to API source |
| `6d1f45e0b` | 5b    | Add all HTTP methods and request body field to API source       |
| `a9323f5bf` | 6     | Add test spec                                                   |
| `67976ef89` | 6     | Add HLD                                                         |

Note: Phases 1-4 (parser, compiler, runtime) were implemented earlier on this branch before the Studio work began.
