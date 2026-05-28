# Entity Extraction Gap Fixes — Design Spec

**Date:** 2026-04-06
**Status:** Approved
**Branch:** `feature/nlu-pipeline-enhancements`
**Source:** `/Users/Thiru/researchWS/abl-review/NLU/entity-extraction-gaps.md` (31-gap analysis)

---

## 1. Problem

Entity extraction has 31 identified gaps across the runtime and compiler. The most impactful:

- **No validation or enum normalization** in 7 of 8 extraction call sites. Only the inline `handleInlineExtraction()` handler (Call Site #3) validates types, normalizes enums, and tracks retries. All other paths write raw LLM output directly to session state.
- **Missing ABL properties** never wired through parser/compiler/IR: `max_retries`, `retryPrompt`, `validationProcess`, `sensitive` on NLU entities.
- **NLU entity definitions invisible to runtime** — synonyms, patterns, and values defined in the NLU section are compiled to IR but never read by the runtime extraction pipeline.
- **Dual-definition problem** — entity values can be defined in both GATHER `options` and NLU `entities` with no merge or conflict detection.

## 2. Scope

### In Scope (Gaps Addressed)

| Gap | Summary                                                    | Workstream                                                               |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | No validation in non-inline pre-pass                       | WS1                                                                      |
| 2   | No enum normalization in non-inline pre-pass               | WS1                                                                      |
| 3   | Fallback extraction has no validation/normalization        | WS1                                                                      |
| 4   | Fallback passes ALL fields, not just uncollected           | WS1                                                                      |
| 5   | `maxRetries` never parsed from ABL                         | WS2                                                                      |
| 6   | `retryPrompt` and `validationProcess` never compiled to IR | WS2                                                                      |
| 7   | Inline path missing `lookupTables` argument                | WS1                                                                      |
| 8   | `complete_when` never passed in inline path                | Deferred — `complete_when` not on `GatherConfig` IR for reasoning agents |
| 9   | FlowGatherField missing `enum_values`                      | WS2                                                                      |
| 12  | DELEGATE WHEN variables not extracted in inline path       | WS1                                                                      |
| 13  | Substring matching ambiguity (improved in normalizer)      | WS1                                                                      |
| 24  | Fallback ignores GATHER field options/synonyms             | WS1                                                                      |
| 26  | Tier 4 regex fallback passes no field types                | WS1                                                                      |
| 28  | Tier merge overwrites higher-quality Tier 1 results        | WS1                                                                      |
| 30  | No deduplication between NLU entities and GATHER options   | WS2                                                                      |
| 31  | `compileNLU` drops `sensitive` flag                        | WS2                                                                      |

### Out of Scope

| Gap                                                     | Reason                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| 25 — PII guard integration                              | Deferred — no consumer in runtime extraction path yet            |
| 20 — NLU engine unification                             | Compile-time merge reduces urgency; future architecture decision |
| 11 — infer/infer_confidence/infer_confirm               | Large standalone feature                                         |
| 15, 16, 17 — extraction_pattern, JS extractors, caching | Quality phase                                                    |
| 18, 19 — confidence scores, partial merging             | Embedding integration phase                                      |
| 22 — Entity embedding index                             | Embedding integration phase                                      |
| 23 — Combined analyzer metadata                         | Quality phase                                                    |
| 27 — Hardcoded 0.8 confidence                           | Quality phase                                                    |
| 29 — Raw message fallback                               | Quality phase                                                    |
| 32 — Synonyms not sent to LLM extraction prompt         | Identified during entity pipeline implementation (2026-04-08)    |

## 3. Design

### 3.1 Workstream 1 — Runtime Parity

#### 3.1.1 Shared Validation Utilities

**New file:** `apps/runtime/src/services/execution/extraction-validation.ts`

Two pure functions extracted from `handleInlineExtraction()` logic in `reasoning-executor.ts`:

**`validateExtractedValue(field, value)`**

- Input: IR `GatherField` (or `FlowGatherField`) + extracted value
- Type checking: string, number, boolean, date, enum
- For enum fields, delegates to `normalizeEnumValue()`
- Returns `{ valid: boolean; normalized?: unknown; error?: string }`
- Pure function — no session state, no side effects

**`normalizeEnumValue(value, enumValues, synonyms?)`**

- Input: raw extracted string, canonical enum values, optional synonym map
- 4-step matching (improved from current 3-step):
  1. Exact match
  2. Case-insensitive match
  3. Synonym lookup — iterate synonym map, case-insensitive match against synonym lists, return the canonical value
  4. Substring match — prefer shortest matching option (fixes Gap 13 ambiguity)
- Returns canonical value string or `null` if no match
- The synonym lookup step is new — uses synonyms now available on GATHER fields from the compiler merge (Workstream 2)

#### 3.1.2 Call Site Changes — reasoning-executor.ts

**Call Site #1 — Non-inline pre-pass (~line 629):**
After `setGatheredValues()`, iterate extracted values and apply `validateExtractedValue()` for each field. Reject invalid values (remove from gathered values). Apply `normalizeEnumValue()` for enum fields.

**Call Site #2 — Inline tool injection (~line 1346):**
Pass `session.agentIR?.gather?.lookupTables` as the second argument to `buildExtractionTool()` (Gap 7).

**Call Site #3 — Inline handler (`handleInlineExtraction()`):**

- Refactor to call shared `validateExtractedValue()` and `normalizeEnumValue()` instead of inline logic
- Pass `session.agentIR?.gather?.complete_when` to `checkGatherComplete()` (Gap 8)
- Include DELEGATE WHEN variables via `getDelegateWhenVariables()` in the inline extraction scope (Gap 12)

**Call Site #4 — Inline fallback (~line 2088):**

- Filter to uncollected fields only: replace `allFieldNames = gatherFields.map(f => f.name)` with filtering against `session.data.gatheredKeys` (Gap 4)
- Apply `validateExtractedValue()` + `normalizeEnumValue()` after extraction (Gap 3)

#### 3.1.3 Call Site Changes — flow-step-executor.ts

**Call Sites #5-8 (mini-collect, correction, waitingForInput, scripted gather):**
After each `extractEntitiesWithLLM()` call and before `setGatheredValues()`, apply `validateExtractedValue()` for each extracted field. This ensures scripted/flow agent paths get the same validation as reasoning agents.

**Tier merge order (~line 2138):**
Change `{ ...tier1Results, ...tier2Results }` to `{ ...tier2Results, ...tier1Results }` so Tier 1 JS library results (deterministic, normalized) take priority over Tier 2 sidecar results (Gap 28).

**Fallback `extractEntitiesForFields()` calls:**
Build and pass the `fieldTypes` map from `gatherFields` metadata to all `extractEntitiesForFields()` call sites (Gap 26):

```typescript
const fieldTypes = gatherFields.reduce(
  (acc, f) => {
    acc[f.name] = f.type ?? '';
    return acc;
  },
  {} as Record<string, string>,
);
```

### 3.2 Workstream 2 — Compiler Pipeline

#### 3.2.1 Schema Changes

**`packages/compiler/src/platform/ir/schema.ts`:**

| Type              | Change                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `GatherField`     | Add `synonyms?: Record<string, string[]>`                                                      |
| `FlowGatherField` | Add `synonyms?: Record<string, string[]>`                                                      |
| `FlowGatherField` | Add `enum_values?: string[]` (Gap 9)                                                           |
| `ValidationRule`  | Add `validation_process?: 'REGEX' \| 'CODE' \| 'LLM'` (Gap 6 — field exists in AST but not IR) |

#### 3.2.2 AST Type Changes

**`packages/core/src/types/agent-based.ts`:**

| Type                  | Change                             |
| --------------------- | ---------------------------------- |
| `NLUEntityDefinition` | Add `sensitive?: boolean` (Gap 31) |

#### 3.2.3 Parser Changes

**`packages/core/src/parser/agent-based-parser.ts`:**

| Section                               | Change                               |
| ------------------------------------- | ------------------------------------ |
| Top-level GATHER parsing (~line 2872) | Parse `max_retries` property (Gap 5) |
| NLU entity parsing (~line 6928)       | Parse `sensitive` property (Gap 31)  |

#### 3.2.4 Compiler Changes

**`compileGather()` in `compiler.ts` (~line 1013):**

Wire missing validation properties:

- `retryPrompt` from AST → `validation.retry_prompt` in IR (Gap 6)
- `validationProcess` from AST → `validation.validation_process` in IR (Gap 6)
- `maxRetries` from AST → `validation.max_retries` in IR (Gap 5)

**NLU-to-GATHER merge logic** — new function in `compiler.ts`, called after `compileGather()` and `compileNLU()`:

```
mergeNLUIntoGather(gatherFields, nluEntities):
  for each gatherField:
    nluEntity = nluEntities.find(e => e.name === gatherField.name)
    if not found → skip (no enrichment)

    // Type check
    if both have type and types differ → COMPILE ERROR

    if gatherField has enum_values (options):
      // GATHER filters NLU
      gatherField.synonyms = {}
      for each value in gatherField.enum_values:
        if value exists in nluEntity.values:
          gatherField.synonyms[value] = nluEntity.synonyms?.[value] ?? []
        // else: extra GATHER option, no synonyms — keep as-is
    else:
      // No GATHER options — bring everything from NLU
      gatherField.enum_values = nluEntity.values
      gatherField.synonyms = nluEntity.synonyms
```

**`compileNLU()` in `compiler.ts` (~line 3055):**

- Add `sensitive: e.sensitive` to entity mapping (Gap 31)

**Flow step GATHER compilation (~line 2661):**

- Compile `enum_values` for `FlowGatherField` (Gap 9)
- Apply same NLU merge logic
- Wire `retryPrompt`, `validationProcess` if present

## 4. Data Flow

```
ABL Source
    |
    +-- GATHER section --> Parser --> AST GatherField (with maxRetries)
    |                                      |
    +-- NLU section ----> Parser --> AST NLUEntityDefinition (with sensitive)
    |                                      |
    +--------------------------------------+--> Compiler
                                             |
                                    +--------+--------+
                                    |  NLU-GATHER     |
                                    |  MERGE          |
                                    |  - type check   |
                                    |  - filter/bring |
                                    |  - synonyms     |
                                    +---------+-------+
                                              |
                                              v
                                     IR GatherField
                                     +-- enum_values (canonical)
                                     +-- synonyms (from NLU, filtered)
                                     +-- validation.retry_prompt
                                     +-- validation.max_retries
                                     +-- ...
                                              |
                                              v
                                     Runtime Extraction
                                              |
                                     +--------+--------+
                                     | extractEntities  |
                                     | WithLLM()        |
                                     +---------+--------+
                                               |
                                               v
                                     +-------------------+
                                     | validateExtracted  |
                                     | Value()            |
                                     | + normalizeEnum    |
                                     |   Value()          |
                                     | (uses enum_values  |
                                     |  + synonyms)       |
                                     +---------+---------+
                                               |
                                               v
                                     setGatheredValues()
```

## 5. Files Touched

### New

| File                                                           | Purpose                                                |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `apps/runtime/src/services/execution/extraction-validation.ts` | Shared validateExtractedValue() + normalizeEnumValue() |

### Modified (Runtime — Workstream 1)

| File                                                        | Changes                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | 4 call sites: add validation/normalization, pass lookupTables, complete_when, DELEGATE WHEN vars, filter uncollected |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | 4 call sites: add validation/normalization. Fix tier merge order. Pass fieldTypes to fallback calls                  |

### Modified (Compiler — Workstream 2)

| File                                             | Changes                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`    | Add synonyms to GatherField + FlowGatherField, add enum_values to FlowGatherField                          |
| `packages/compiler/src/platform/ir/compiler.ts`  | Wire retryPrompt/validationProcess/maxRetries, NLU merge logic, sensitive mapping, flow gather enum_values |
| `packages/core/src/parser/agent-based-parser.ts` | Parse max_retries in GATHER, parse sensitive in NLU entities                                               |
| `packages/core/src/types/agent-based.ts`         | Add sensitive to NLUEntityDefinition                                                                       |

## 6. NLU-GATHER Merge Rules

| GATHER has options? | NLU entity exists? | Result                                                                                                                     |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Yes                 | Yes, types match   | GATHER options = enum_values. Bring NLU synonyms only for values in GATHER options. Extra GATHER options have no synonyms. |
| Yes                 | Yes, types differ  | **COMPILE ERROR**                                                                                                          |
| Yes                 | No                 | GATHER options as enum_values, no synonyms                                                                                 |
| No                  | Yes                | Bring all NLU values as enum_values + all synonyms                                                                         |
| No                  | No                 | Untyped field, no enum behavior                                                                                            |

## 7. Risks

| Risk                                                                  | Mitigation                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Validation rejects values that previously passed through silently     | Validation returns structured results; call sites can log warnings without blocking initially                       |
| Compiler merge changes IR shape — existing compiled agents may differ | Merge is additive (new fields: synonyms). Existing fields unchanged.                                                |
| Large file edits to reasoning-executor.ts and flow-step-executor.ts   | One call site per commit. Incremental typecheck after each edit.                                                    |
| Enum normalization behavior change (4-step vs 3-step)                 | Synonym step is additive (only fires if synonyms exist). Substring improvement (shortest match) is strictly better. |

## 8. Open Gaps

### Gap 32: Synonyms not sent to LLM extraction prompt

**Identified:** 2026-04-08 during entity pipeline implementation.

**Problem:** Entity/GATHER synonyms are never included in the LLM extraction prompt or tool schema. The LLM only sees canonical values via `[allowed values: ...]` in `fieldDescriptions` and `enum` in the tool schema. Synonyms are only used post-LLM in `normalizeEnumValue()` as a programmatic fallback.

This breaks when canonical values are technical identifiers that don't resemble user language:

```
VALUES: [CLS_ECO, CLS_BIZ, CLS_FIRST]
SYNONYMS:
  CLS_ECO: [economy, coach, regular]
  CLS_BIZ: [business, biz class, premium]
  CLS_FIRST: [first class, first, luxury]
```

User says "I want business class." LLM sees `enum: ["CLS_ECO", "CLS_BIZ", "CLS_FIRST"]` — has no way to know "business" maps to `CLS_BIZ`. Returns nothing or hallucinates.

**Fix locations:**

1. `flow-step-executor.ts` `fieldDescriptions` (~line 2302-2311): append synonym context to `[allowed values: ...]` so it reads `[allowed values: CLS_ECO (economy, coach), CLS_BIZ (business, biz class), ...]`
2. `flow-step-executor.ts` `buildExtractionTool` (~line 1814-1819): add synonym context to the tool property `description` so the LLM's structured output path also sees the mapping

**Data flow:** `GatherFieldIR.synonyms` is already populated from both explicit ENTITIES synonyms and NLU.entities synonyms (via compiler lowering). The field is available at the call sites — it just isn't used for prompt construction.
