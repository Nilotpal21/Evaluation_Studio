# HLD: Enum Fields & Lookup Tables

**Feature Spec**: `docs/features/enum-and-lookup-tables.md`
**Test Spec**: `docs/testing/enum-and-lookup-tables.md`
**Status**: APPROVED (post-implementation)
**Author**: System
**Date**: 2026-03-24

---

## 1. Problem Statement

The platform has two mechanisms for constraining gather field values — enum ValidationRule and lookup tables — but neither was fully wired end-to-end from DSL authoring to runtime extraction. Enum fields (`type: enum`) had no way to define allowed values in DSL. Lookup tables existed in the IR and runtime but were invisible to the LLM during extraction, causing unnecessary re-prompt cycles. The Studio agent editor had no UI for creating lookup-backed fields.

This feature closes 8 gaps (GAP-1 through GAP-8) to make enum fields and lookup tables fully functional across the entire pipeline: DSL → Parser → Compiler → IR → Runtime → Studio UI.

---

## 2. Alternatives Considered

### Option A: Extend Existing Pipeline (Chosen)

- **Description**: Add `options` to the parser, wire `type: 'enum'` in the compiler, inject lookup values into LLM prompts, add lookup field type to Studio GatherEditor.
- **Pros**: Minimal new code, follows existing validation/extraction patterns, backward compatible, no new services.
- **Cons**: Enum and lookup remain separate mechanisms (not unified).
- **Effort**: M

### Option B: Unified Constraint System

- **Description**: Replace both enum ValidationRule and lookup tables with a single "constraint" abstraction that handles static values, dynamic lookups, and remote APIs uniformly.
- **Pros**: Cleaner long-term architecture, single code path for all value constraints.
- **Cons**: Large refactor of existing validation pipeline, breaks IR backward compatibility, higher risk.
- **Effort**: L

### Option C: Studio-Only Lookup UI (No Pipeline Changes)

- **Description**: Only add Studio UI for lookup tables, reference existing project-level lookup tables, no parser/compiler changes.
- **Pros**: Smallest change, no DSL changes needed.
- **Cons**: Doesn't fix enum authoring gap, doesn't fix LLM prompt injection gap, lookup still causes re-prompts.
- **Effort**: S

### Recommendation: Option A

**Rationale**: Option A delivers the most value with moderate effort. It closes all 8 gaps, follows existing patterns, and is backward compatible. Option B is better architecturally but the refactor risk is too high for the incremental benefit. Option C only addresses the UI gap, leaving the core pipeline issues unresolved.

---

## 3. Architecture

### System Context Diagram

```
                    Studio Agent Editor
                          │
                    ┌─────▼──────┐
                    │  Serializer │ (GatherEditor → DSL)
                    │  + Hydrator │ (IR → GatherEditor)
                    └─────┬──────┘
                          │ DSL Text
                    ┌─────▼──────┐
                    │   Parser   │ @abl/core
                    │ (options,  │
                    │  headers)  │
                    └─────┬──────┘
                          │ AST
                    ┌─────▼──────┐
                    │  Compiler  │ @abl/compiler
                    │ (enum →    │
                    │  enum_val) │
                    └─────┬──────┘
                          │ IR
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼────┐ ┌───▼────┐ ┌───▼──────────┐
        │Extraction│ │Validate│ │Lookup Resolver│
        │Tool(enum)│ │Field() │ │(inline/coll/  │
        │          │ │        │ │ api + cache)  │
        └──────────┘ └────────┘ └──────────────┘
```

### Component Diagram

```
packages/core/
  ├── types/agent-based.ts      ← GatherField.options, LookupTableDef.headers
  └── parser/agent-based-parser ← parseOptions(), parseHeaders()

packages/compiler/
  └── platform/ir/
      ├── schema.ts             ← LookupTableIR.headers, GatherField.enum_values
      └── compiler.ts           ← compileEnumValidation(), compileHeaders()

apps/runtime/
  └── services/execution/
      ├── flow-step-executor.ts ← buildExtractionTool() enum+lookup injection
      └── lookup-resolver.ts    ← resolveLookup() with headers, fuzzy, LRU

apps/studio/
  ├── components/agent-editor/
  │   └── sections/GatherEditor ← LookupConfigPanel, ApiSourceConfig
  ├── store/agent-detail-store  ← parseGather() hydration with lookup fields
  └── lib/abl-serializers.ts    ← serializeLookupTableEntry()
```

### Data Flow

**Authoring (Studio → DSL):**

1. User sets field type to `lookup` in GatherEditor
2. Configures source (inline/API/collection) via LookupConfigPanel
3. On save, `serializeGatherToABL()` emits GATHER section + LOOKUP_TABLES section
4. DSL text saved to agent definition

**Compilation (DSL → IR):**

1. Parser extracts `options` on enum fields, `headers` on lookup tables
2. Compiler maps `type: enum` + `options` → `ValidationRule { type: 'enum', rule: 'a|b|c' }`
3. Compiler populates `enum_values` on IR gather field
4. Compiler carries `headers` to `LookupTableIR`

**Execution (IR → Runtime):**

1. `buildExtractionTool()` checks for inline lookup values (≤100) → injects as JSON Schema `enum`
2. For >100 values → injects description hint with sample values
3. LLM extracts value guided by enum constraint
4. Post-extraction: `validateWithLookupTables()` calls `resolveLookup()`
5. Lookup resolver checks cache → resolves via source (Set/MongoDB/HTTP)
6. Fuzzy match triggers confirmation flow if enabled

**Hydration (IR → Studio):**

1. `parseGather()` reads `ir.lookup_tables` keyed by `semantics.lookup` reference
2. Maps IR fields to `GatherFieldData.lookup*` properties
3. Sets `field.type = 'lookup'` for UI rendering

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Collection source queries always include `tenantId` + `projectId` in filter. `LookupEntry` model uses `tenantIsolationPlugin` + compound index `(tenantId, projectId, tableName, value)`. REST API routes under `/api/projects/:projectId/` with `requireProjectScope`. Cross-tenant returns not-found (404). |
| 2   | **Data Access Pattern** | Inline: O(1) `Set<string>` lookup cached via `WeakMap` (GC'd with IR). Collection: MongoDB `findOne` with TTL cache (500 entries, 5min). API: HTTP fetch with TTL cache (200 entries, 5min) + circuit breaker. LRU eviction on all TTL caches.                                                                |
| 3   | **API Contract**        | No new endpoints. Existing REST API for lookup CRUD unchanged. IR schema extended with optional fields (`headers`, `enum_values`, `method`, `body`) — backward compatible. Studio serializer emits both GATHER and LOOKUP_TABLES DSL sections.                                                                |
| 4   | **Security Surface**    | SSRF validation on API source endpoints (blocks private/internal IPs). Auth middleware on all REST routes. Permission checks (`lookup_data:read`, `lookup_data:write`). API headers forwarded from IR config (no runtime user input in headers). Input validation via Zod on all REST inputs.                 |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                  |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Invalid enum value → re-prompt with allowed values list. Lookup miss → clear field + re-prompt. Fuzzy match → confirmation prompt ("Did you mean X?"). API failure → circuit breaker opens → graceful degradation (skip validation).                                             |
| 6   | **Failure Modes** | API timeout: configurable `timeout_ms` (default 5s). API down: circuit breaker (3 failures → 30s open → half-open retry). MongoDB down: query fails → validation skipped with warning trace. Cache corruption: TTL expiry self-heals within 5min.                                |
| 7   | **Idempotency**   | Lookup resolution is read-only and naturally idempotent. REST API bulk upsert uses MongoDB `updateOne` with `upsert: true` — safe to retry. File upload replaces all entries for a table (idempotent).                                                                           |
| 8   | **Observability** | Trace events: `lookup_validation_failed`, `lookup_fuzzy_match`, `lookup_fuzzy_confirmed`, `lookup_fuzzy_rejected`. Circuit breaker state changes logged. Cache hit/miss ratios available via `clearCaches()` diagnostic. All lookup resolutions include timing in trace context. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                             |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Inline lookup: <1ms (Set). Collection lookup: <50ms (MongoDB indexed query + cache). API lookup: <5s (configurable timeout). LLM prompt injection: ≤100 values as enum (token-safe), >100 as description hint (5 sample values). Parser warns at >1000 inline values with fuzzy.            |
| 10  | **Migration Path**     | No migration needed. All new fields are optional additions to existing IR schema. Existing agents without enum/lookup fields are completely unaffected. Studio UI shows lookup panel only when `type === 'lookup'`.                                                                         |
| 11  | **Rollback Plan**      | Revert the branch. No database migrations to undo. No schema changes to the MongoDB `lookup_entries` collection (model already existed). IR schema additions are optional fields — old IR documents still valid.                                                                            |
| 12  | **Test Strategy**      | 31 unit tests covering parser, compiler, runtime injection, resolver. 7 E2E scenarios planned (full pipeline, tenant isolation, circuit breaker). 7 integration scenarios planned (parser→compiler, resolver→MongoDB, serializer round-trip). See `docs/testing/enum-and-lookup-tables.md`. |

---

## 5. Data Model

### No New Collections

The `lookup_entries` collection already existed before this feature. No schema changes to it.

### Modified IR Schema (In-Memory Only)

**`LookupTableIR`** — added:

- `headers?: Record<string, string>` — custom HTTP headers for API source auth
- `method?: string` — HTTP method for API source (default: GET)
- `body?: string` — request body for non-GET API requests

**`GatherField` (IR)** — added:

- `enum_values?: string[]` — populated by compiler when `type: enum` + `options` present

### Key Relationships

```
GatherField.semantics.lookup ──references──> LookupTableIR.name
GatherField.enum_values ──derived-from──> GatherField.options (at compile time)
GatherField.validation.rule ──derived-from──> GatherField.options (pipe-delimited)
```

---

## 6. API Design

### No New Endpoints

All REST API endpoints for lookup data CRUD existed prior to this feature:

| Method | Path                                              | Purpose                  | Auth                |
| ------ | ------------------------------------------------- | ------------------------ | ------------------- |
| POST   | `/api/projects/:pid/lookup-tables/:table/entries` | Bulk upsert entries      | `lookup_data:write` |
| GET    | `/api/projects/:pid/lookup-tables/:table/entries` | List entries (paginated) | `lookup_data:read`  |
| DELETE | `/api/projects/:pid/lookup-tables/:table/entries` | Delete all entries       | `lookup_data:write` |
| POST   | `/api/projects/:pid/lookup-tables/:table/upload`  | CSV/JSON upload          | `lookup_data:write` |

### Modified Internal APIs

**`FlowStepExecutor.buildExtractionTool()`** — now accepts optional `lookupTables` parameter, injects inline values as JSON Schema enum or description hint.

**`resolveLookup()`** — now forwards `table.headers` in API fetch requests.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Lookup validation results emitted as `TraceEvent`s (success, failure, fuzzy match, circuit breaker state).
- **Rate Limiting**: REST API routes inherit existing rate limiting. No lookup-specific rate limits (cache mitigates load).
- **Caching**: Three-tier: inline WeakMap (unbounded, GC'd), collection TTL (500, 5min, LRU), API TTL (200, 5min, LRU).
- **Encryption**: Lookup values stored unencrypted in `lookup_entries` (same as other project data). API headers may contain secrets (Bearer tokens) — stored in IR config, not in database. Transit encryption via HTTPS for API source.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                             | Type           | Risk                                                      |
| -------------------------------------- | -------------- | --------------------------------------------------------- |
| `@abl/core` parser                     | Package        | LOW — extending existing parser                           |
| `@abl/compiler` IR compiler            | Package        | LOW — adding optional fields                              |
| `@agent-platform/database` LookupEntry | Package        | LOW — model unchanged                                     |
| MongoDB                                | Infrastructure | LOW — already required                                    |
| External APIs (API source)             | External       | MEDIUM — network dependency, mitigated by circuit breaker |

### Downstream (depends on this feature)

| Consumer            | Impact                                                |
| ------------------- | ----------------------------------------------------- |
| Studio GatherEditor | Renders lookup config panel for `type: lookup` fields |
| Studio Serializer   | Emits LOOKUP_TABLES DSL section for lookup fields     |
| Runtime Extraction  | Uses enum_values for LLM constraint                   |
| Language Service    | Already advertises `options` — now actually parsed    |

---

## 9. Open Questions & Decisions Needed

1. **Unified constraint system**: Should enum and lookup be unified into a single "constraint" abstraction in a future iteration? Current design keeps them separate (enum = static compile-time, lookup = dynamic runtime).
2. **Lookup value encryption**: Should lookup table values support encryption at rest for sensitive value sets (e.g., medical codes)?
3. **API source retry**: Currently no retry on API source failure (single attempt → circuit breaker). Should retry with backoff be added?
4. **Studio: lookup table reference mode**: Current design uses inline definition. Should a future iteration support referencing project-level lookup tables from the gather field?

---

## 10. Post-Implementation Notes (2026-03-25)

**PR review refactor:** The original HLD had lookup table configuration inline on each gather field in GatherEditor. PR review identified this as duplication with the existing RuntimeConfigTab. Architecture was revised:

- **Removed:** Inline `LookupConfigPanel` (~435 lines), 12 `lookup*` fields on `GatherFieldData`, `LOOKUP_TABLES` section emission from serializer
- **Added:** Project-level lookup table dropdown on `string` fields, `lookup-table-merger.ts` that merges agent + project tables at runtime
- **Decision:** Simple enums = agent-local (`type: enum` + `options`). Complex lookups = project-level (`semantics.lookup: tableName`). Name collision throws `LookupTableConflictError`.
- **Spec:** `docs/superpowers/specs/2026-03-25-enum-lookup-pr-review-refactor-design.md`

## 11. References

- Feature spec: `docs/features/enum-and-lookup-tables.md`
- Test spec: `docs/testing/enum-and-lookup-tables.md`
- Design spec (original): `docs/superpowers/specs/2026-03-24-lookup-field-type-gather-editor-design.md`
- Design spec (PR review refactor): `docs/superpowers/specs/2026-03-25-enum-lookup-pr-review-refactor-design.md`
- Implementation plan (original): `docs/superpowers/plans/2026-03-24-lookup-field-type-gather-editor.md`
- Implementation plan (PR review refactor): `docs/superpowers/plans/2026-03-25-enum-lookup-pr-review-refactor.md`
