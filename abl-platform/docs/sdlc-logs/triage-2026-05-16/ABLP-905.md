# ABLP-905 — Eval Artifact Import Schema Mismatch

> **Review update — 2026-05-17 (GPT-5.5 high review)** · Verdict: **CONCERN**
>
> - Root cause confirmed at `packages/project-io/src/import/entity-schemas.ts:392,411,413,426,724` and the Mongoose model side (`eval-set.model.ts:83`, `eval-scenario.model.ts:74`, `eval-persona.model.ts:71`).
> - **TypeScript model type drift**: `packages/database/src/models/eval-set.model.ts:41` declares `personaModel?: string` but the Mongoose default at `:83` is `null`. Update the TS type to `string | null` (or align the default) — otherwise the drift remains at compile-time boundaries and a future change will re-introduce the schema mismatch.
> - **Apply schema alignment to BOTH file-level and staged-record schemas** (`entity-schemas.ts:381` and `:713`). The repro currently covers the staged-record path; add the file-level path to prevent partial fixes.
>
> Full review: [`codex-review.md`](codex-review.md)

## Symptom

Project export > import round-trip fails at the preview stage when eval artifacts (eval_sets, eval_scenarios, eval_personas) are included. The import succeeds when evals are deselected.

Validation errors:

- `eval_sets.personaModel`: expected string, received null
- `eval_scenarios.expectedMilestones[i]`: expected object, received string
- `eval_scenarios.version`: expected string, received number
- `eval_personas.goals`: expected array, received string
- `eval_personas.constraints`: expected array, received string

## Root Cause

**File:** `packages/project-io/src/import/entity-schemas.ts`

The Zod import validation schemas drifted from the Mongoose model definitions. The exporter (`evals-assembler.ts`) faithfully serializes the Mongoose document shape, but the importer's Zod schemas expect a different type.

### Per-Field Table

| Collection     | Field                   | Archive Value (from Mongoose model)                    | Import Schema Type (BUG)                                 | Schema Location (entity-schemas.ts) |
| -------------- | ----------------------- | ------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------- |
| eval_sets      | `personaModel`          | `null` (Mongoose: `{ type: String, default: null }`)   | `z.string().max(255).optional()` — rejects null          | Lines 392 (Imported), 724 (Record)  |
| eval_scenarios | `expectedMilestones[i]` | `"string"` (Mongoose: `{ type: [String] }`)            | `z.array(z.record(z.unknown()))` — expects objects       | Lines 411 (Imported), 863 (Record)  |
| eval_scenarios | `version`               | `1` (Number) (Mongoose: `{ type: Number }`)            | `z.string().max(50).optional()` — expects string         | Lines 413 (Imported), 865 (Record)  |
| eval_personas  | `goals`                 | `"string"` (Mongoose: `{ type: String, default: '' }`) | `z.array(z.string()).max(50).optional()` — expects array | Lines 426 (Imported), 877 (Record)  |
| eval_personas  | `constraints`           | `"string"` (Mongoose: `{ type: String, default: '' }`) | `z.array(z.string()).max(50).optional()` — expects array | Lines 427 (Imported), 878 (Record)  |

Both the `Imported*Schema` (file-level validation during disassembly) and the `*RecordSchema` (post-`injectOwnership` batch validation) have the same type mismatches.

### Why the Exporter Is Correct

The assembler (`evals-assembler.ts:47-52`) uses `.select()` to pick specific fields and `stripInternalFields()` to remove ownership. It faithfully serializes what Mongoose stores. The mismatch is entirely on the import schema side.

### Additional Concern

The Mongoose `personaModel` field uses `default: null` which means exports always contain `"personaModel": null` in the JSON. The schema should accept `.nullable()`. Ideally the model would use `default: undefined` (omit from exports), but the minimum fix is making the Zod schema match reality.

## Reproduction Test

See `packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts`.

Constructs realistic fixture JSON matching what the exporter produces (with `personaModel: null`, `expectedMilestones: ["string"]`, `version: 1`, `goals: "string"`, `constraints: "string"`), runs the `EvalsDisassembler.disassemble()` to produce `StagedRecord[]`, then calls `validateStagedRecordBatch()`. Asserts zero validation errors. Today produces the 5 specific errors above.

## Future-Ready Solution

### 1. Round-Trip Property Test

Add a test in `packages/project-io/src/__tests__/export-import-roundtrip.test.ts` (already exists, extend for evals) that:

1. Seeds eval artifacts via Mongoose model factories
2. Runs `EvalsAssembler.assemble()` to produce the archive files
3. Feeds the files into `EvalsDisassembler.disassemble()`
4. Calls `validateStagedRecordBatch()` on the result
5. Asserts zero validation errors

This catches any future schema-model drift automatically.

### 2. Centralized Model-to-Schema Sync

Create a single registry (`packages/project-io/src/import/model-schema-registry.ts`) that maps each Mongoose model to its corresponding import Zod schema. A CI-time test iterates the registry and verifies each Zod field type aligns with the Mongoose schema type definition (String->z.string, Number->z.number, [String]->z.array(z.string()), nullable default->`.nullable()`).

### 3. Minimum Code Fix

In `entity-schemas.ts`:

- `personaModel`: change to `z.string().max(255).nullable().optional()`
- `expectedMilestones`: change to `z.array(z.string().max(1000)).max(100).optional()`
- `version` (eval_scenarios): change to `z.number().int().optional()`
- `goals`: change to `z.string().max(5000).optional()`
- `constraints`: change to `z.string().max(5000).optional()`

Apply to both `Imported*Schema` and `*RecordSchema` variants.
