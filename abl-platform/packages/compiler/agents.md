# agents.md — packages / compiler

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-24 — Auth profile compilation fix

**Category**: gotcha
**Learning**: When adding new DSL tool properties, three places must be updated in lockstep: (1) `agent-based-parser.ts` must assign parsed properties to the tool object (the tool-file-parser's `parseToolProperties` handles the parsing, but the agent-based parser selectively assigns), (2) `compiler.ts` `compileTools()` must map AST field names to IR field names, and (3) the tool merge block in `compiler.ts` (~line 251) must include the new IR fields so they survive when resolved project tools override DSL tools. Missing any one of these causes the field to be silently dropped.
**Files**: `packages/core/src/parser/agent-based-parser.ts`, `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Any future DSL tool property additions must update all three locations or values will be silently lost.

## 2026-03-24 — Auto-guard constraint keyword/method handling

**Category**: gotcha
**Learning**: `extractVariableReferences` in `compiler.ts` uses a `CONSTRAINT_KEYWORDS` set and `CONSTRAINT_METHODS` set to filter tokens. When adding new constraint operators or functions to the DSL, they must be added to one or both sets. The keyword set is case-sensitive, so both `now` and `NOW` forms are listed. The regex uses `exec()` with trailing `(` capture to detect function calls (skipped entirely) vs dot-path method calls (extract only the receiver). `autoGuardConstraint` regexes for IS SET / IS NOT SET use the `i` flag for case-insensitive matching.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Future constraint operators/functions must be added to `CONSTRAINT_KEYWORDS` and/or `CONSTRAINT_METHODS` to avoid them being treated as variable references.

## 2026-03-24 — Destinations feature implementation

**Category**: pattern
**Learning**: When adding a new DSL section (like DESTINATIONS), four files must be updated: (1) AST types in `@abl/core` agent-based.ts, (2) parser in agent-based-parser.ts (section case + parse function + valid sections error message), (3) IR types in schema.ts, (4) compilation in compiler.ts. The YAML-style parser for nested properties must track the indent level of top-level entries (e.g., destination names at indent=2) to avoid confusing sub-properties like `headers:` (at indent=4) with new entries.
**Files**: `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/agent-based-parser.ts`, `packages/compiler/src/platform/ir/schema.ts`, `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Future section parsers with nested YAML-like structures should use indent-level tracking, not just "indent >= N".

## 2026-03-24 — Template resolution completeness

**Category**: gotcha
**Learning**: `resolveAllTemplateRefs` must walk ALL locations where TEMPLATE(name) can appear. When adding new IR fields that contain respond/prompt strings (like on_action, gather field prompts), add corresponding resolution logic. Templates found in gather fields must also be added to the `used` set to prevent false W602 (unused template) warnings.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Any new IR location with respond/prompt strings needs to be added to `resolveAllTemplateRefs`.

## 2026-03-24 — Config variable auth_profile_ref preservation

**Category**: gotcha
**Learning**: `resolveConfigVariables` uses `walkAndReplace` which recursively resolves ALL strings. Some fields like `auth_profile_ref` on tools must be preserved as `{{config.X}}` templates for runtime resolution. The fix walks tool properties individually, skipping keys in `TOOL_RUNTIME_KEYS`. This requires `as unknown as Record<string, unknown>` cast since `ToolDefinition` has no index signature.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: If other fields need runtime-deferred resolution, add them to the `TOOL_RUNTIME_KEYS` set.

## 2026-03-24 — Constraint ON_FAIL, kind/when/before compilation

**Category**: gotcha
**Learning**: `compileConstraints` now returns `{ config, warnings }` instead of bare `ConstraintConfig`. `compileAgentToIR` returns `{ ir, warnings }`. The ABL parser strips trailing `"` from ON_FAIL values independently via `/^"|"$/g`, so `parseOnFail` receives strings like `RESPOND "message` (leading quote without trailing). The `stripQuotes` helper handles this asymmetry. Checkpoint-gated constraints (with `before` clause) must NOT be auto-guarded because they use synthetic variable names (`_abl_constraint_checkpoint_kind`, `_abl_constraint_checkpoint_target`) that would produce nonsensical IS NOT SET guards.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`, `packages/compiler/src/platform/ir/schema.ts`
**Impact**: Future callers of `compileConstraints` or `compileAgentToIR` must destructure the new return shape. New constraint features (kinds, clauses) should follow the pattern of mapping AST fields to IR fields in the flatMap inside `compileConstraints`.

## 2026-03-24 — Identity Verification BETA Phase 4 (Identity Tier Gate)

**Category**: pattern
**Learning**: Middleware files in `packages/compiler/src/platform/constructs/executors/` must use `import { createLogger } from '../../logger.js'` — NOT `@abl/compiler/platform` which would create a circular import. Verified by reading `audit-middleware.ts` pattern.
**Files**: `src/platform/constructs/executors/identity-tier-gate-middleware.ts`, `src/platform/constructs/executors/audit-middleware.ts`
**Impact**: Any new middleware in this directory must follow the same relative import pattern.

**Category**: gotcha
**Learning**: `compileToolDefinitionAST()` in `compile-behavior-profile.ts` maps a subset of AST→IR tool fields compared to `compileTools()` in `compiler.ts`. It is missing `confirmation`, `pii_access`, `auth_profile_ref`, `jit_auth`, `consent_mode`, `connection_mode`, `store_result`, `on_result`, `on_error`. New tool fields must be added to BOTH functions.
**Files**: `src/platform/ir/compiler.ts`, `src/platform/ir/compile-behavior-profile.ts`
**Impact**: Any new field on `AgentTool`/`ToolDefinition` must be mapped in both compilation paths.

**Category**: testing
**Learning**: The DSL parser does not handle `identityTierRequired` yet. To test compiler mapping for fields not yet parsed from DSL, parse a minimal DSL then mutate the AST tool object before calling `compileABLtoIR()`. This avoids needing to construct a complete `AgentBasedDocument` manually (which requires complex `DocumentMeta` with dates, IDs, etc.).
**Files**: `src/__tests__/compiler-identity-tier.test.ts`
**Impact**: Future compiler tests for unparsed fields should use this parse-then-mutate pattern.

## 2026-03-25 — Identity Tier Gate E2E Test (E2E-8)

**Category**: testing
**Learning**: To E2E-test middleware through ToolBindingExecutor without external infrastructure (HTTP/MCP/sandbox), use contract-only tools (no `tool_type`, no binding) with a `fallbackExecutor`. The executor routes these to the fallback after middleware runs. This lets you verify middleware behavior end-to-end while keeping the test self-contained.
**Files**: `src/__tests__/identity-tier-gate-e2e.test.ts`
**Impact**: Future E2E middleware tests should follow this contract-tool + fallback pattern.

**Category**: gotcha
**Learning**: `ToolBindingExecutor` propagates `sessionContext.callerContext` into `ctx.metadata.callerContext` when middleware is present (see lines 346-356 of tool-binding-executor.ts). The identity tier gate middleware reads from `ctx.metadata?.callerContext?.identityTier`. If `sessionContext` is not provided, the middleware defaults the caller to tier 0 (anonymous).
**Files**: `src/platform/constructs/executors/tool-binding-executor.ts`, `src/platform/constructs/executors/identity-tier-gate-middleware.ts`
**Impact**: Any middleware that reads caller context must understand this propagation path. Tests must provide `sessionContext` with `callerContext` to exercise caller-aware middleware.

## 2026-03-25 — AWAIT_ATTACHMENT Compilation (attachments-gap-closure)

**Category**: pattern | gotcha
**Learning**:

1. New flow step keywords (like `AWAIT_ATTACHMENT`) must be added to `stepPropertyKeywords` array in `agent-based-parser.ts` (~line 665) AND handled in the step property switch (~line 1298). Missing from stepPropertyKeywords causes the parser to misinterpret the keyword as a step name.
2. AST uses camelCase (`awaitAttachment`, `onTimeout`, `timeout`) while IR uses snake_case (`await_attachment`, `on_timeout`, `timeout_seconds`). The `compileFlow()` function in `compiler.ts` handles the mapping. When adding new flow step IR types, always use snake_case field names.
3. Step target references (like `on_timeout`) must be added to `collectStepTargets()` in `validate-ir.ts` to ensure dangling references are caught during IR validation.
4. Category validation uses a closed enum `['image', 'document', 'audio', 'video']` in IR validation — adding new categories requires updating both the IR validation and the `deriveCategoryFromMimeType` helper in the runtime.

**Files**: `src/platform/ir/compiler.ts`, `src/platform/ir/validate-ir.ts`, `src/platform/ir/schema.ts`, `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/types/agent-based.ts`
**Impact**: Follow this pattern for any future flow step keywords (e.g., AWAIT_INPUT, AWAIT_PAYMENT). The parser → AST → IR → validation pipeline has 4 touch points that all need updating.

## 2026-04-05 — HTTP Body Template JSON Escaping Regression

**Category**: testing
**Learning**: `HttpToolExecutor` currently resolves `{{input.X}}` in `body_template` with raw `String(val)` for primitive strings. When the placeholder is inside quoted JSON and the value contains quotes or newlines, the emitted request body becomes invalid JSON. Regression coverage should assert `JSON.parse(fetchBody)` succeeds for quoted placeholders carrying `"`, `\n`, or similar JSON-special characters.
**Files**: `src/platform/constructs/executors/http-tool-executor.ts`, `src/__tests__/constructs/http-tool-executor.test.ts`
**Impact**: Any future fix in request templating must preserve valid JSON semantics for string placeholders, not just successful placeholder substitution for simple alphanumeric values.

## 2026-04-05 — Shared JSON Template Escaping Path

**Category**: pattern
**Learning**: JSON body-template interpolation should use a single escape utility based on `JSON.stringify(value).slice(1, -1)` for string values and keep non-body contexts on their original `String`/`JSON.stringify` rules. `HttpToolExecutor` and the custom HTTP guardrail provider should share that helper so body-template escaping behavior stays identical across tool and guardrail HTTP paths.
**Files**: `src/platform/constructs/executors/json-template-utils.ts`, `src/platform/constructs/executors/http-tool-executor.ts`, `src/platform/guardrails/providers/custom-http.ts`, `src/__tests__/constructs/http-tool-executor.test.ts`
**Impact**: Any new placeholder source that can flow into `body_template` must thread the JSON-body escape flag through the shared resolver instead of adding a new replacement path. Auto-body context injection is a separate contract and should only happen when the tool explicitly declares a `context` parameter.

## 2026-04-06 — NLU Pipeline Entity Extraction Gap Fixes (compiler wiring)

**Category**: gotcha
**Learning**: The `compileFlow` function uses an inline type definition for step gather fields (around line 2519) that must be manually kept in sync with the `FlowGatherField` AST type from `@abl/core`. When adding new fields to `FlowGatherField` in the AST, they must ALSO be added to this inline type in `compileFlow` — otherwise TypeScript will reject access to the new properties.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`, `packages/core/src/types/agent-based.ts`
**Impact**: Any future field additions to `FlowGatherField` require updating the compileFlow inline type.

**Category**: pattern
**Learning**: The `mergeNLUIntoGather()` function runs as post-processing after IR construction, mutating gather fields in place. It operates on IR types (not AST). For flow step gather fields, the `FlowGatherField` IR type is cast to `GatherField[]` since both share `enum_values` and `synonyms`. The merge runs after template resolution and routing compilation.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Future NLU-to-gather enrichment logic should be added to `mergeNLUIntoGather`. Flow step iteration must use `ir.flow.definitions` (Record values), not `ir.flow.steps` (string[]).

## 2026-04-07 — Inline GATHER TYPE to anonymous entity

**Category**: pattern
**Learning**: `compileGather` now creates anonymous `EntityDefinitionIR` entries (with `source: 'gather_inline'`) for every GATHER field that has a `fieldType` but no `entityRef`. The entity registry (`ir.entities`) must be initialized as `[]` before calling `compileGather` — anonymous entities are pushed by reference into this array. After `compileGather` returns, if the array is empty it is set back to `undefined` to keep the IR clean. This means the existing test "agent with no ENTITIES has undefined ir.entities" still passes for agents with no GATHER fields. Duplicate prevention: if an entity with the same name already exists in the registry (from ENTITIES or NLU), the anonymous entity is skipped.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: After this change, every GATHER field with a TYPE gets a corresponding entity in `ir.entities` — either explicit, nlu_lowered, or gather_inline. Runtime code can now treat `ir.entities` as the single source of truth for all entity definitions.

## 2026-04-07 — Entity compilation integration: full pipeline ordering

**Category**: pattern | gotcha
**Learning**: The entity compilation pipeline has a strict ordering that must be maintained: (1) compile ENTITIES → `ir.entities`, (2) lower NLU.entities → append to `ir.entities`, (3) initialize `ir.entities = []` if not yet set, (4) `compileGather(doc, ir.entities)` — resolves entity_ref and creates anonymous entities, (5) clean up `ir.entities = undefined` if empty, (6) `mergeNLUIntoGather` — enriches GATHER fields by name-matching with NLU entities. Steps 4 and 6 interact without conflict because: anonymous entity creation (step 4) skips fields whose name already exists in the registry, and mergeNLUIntoGather (step 6) enriches by name. The legacy backward-compat path (NLU entities + GATHER name-matching) works because the NLU-lowered entity prevents an anonymous duplicate, then mergeNLUIntoGather merges synonyms.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Any future modification to the entity pipeline must preserve this ordering. Moving mergeNLUIntoGather before compileGather, or compileGather before NLU lowering, would break entity resolution.

**Category**: gotcha
**Learning**: When multiple tasks add imports from the same module across different commits, duplicate imports can be introduced. Tasks 5 and 9 both added `EntityType` from `./schema.js` — one as a type import in the main import block (line 60), the other in a second `import type` statement (line 101). TypeScript catches this as `TS2300: Duplicate identifier`. Always check if a type is already imported before adding it in a new task.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: When working on multi-task features, check the full import block for existing imports before adding new ones.

## 2026-04-07 — Entity_ref resolution in compileGather

**Category**: pattern | gotcha
**Learning**: `compileGather` now runs AFTER entity compilation in `compileAgentToIR`, not inside the IR literal. The IR literal uses a placeholder `{ fields: [], strategy: 'hybrid' }` which is overwritten by `ir.gather = compileGather(doc, ir.entities)`. This ordering is critical because entity_ref resolution needs the full entity registry (both explicit ENTITIES and NLU-lowered entities). For flow step GATHER fields, entity_ref resolution uses a separate post-processing pass (mutating IR in place) rather than threading the registry through `compileFlow`. The auto-enum validation logic now uses resolved `fieldType`/`enumValues` variables instead of raw `f.type`/`f.options`.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Any future code that depends on `ir.gather` being populated inside the IR literal must be aware that gather is now a placeholder until after entity compilation. Flow step entity_ref resolution follows the same post-processing pattern as `mergeNLUIntoGather`.

## 2026-04-18 — Workflow Webhook Versioning Phase 3 (DSL lockstep)

**Category**: pattern | gotcha
**Learning**: The DSL lockstep for `WorkflowBindingIR` now spans 4 sites (not 3): (1) `packages/compiler/src/platform/ir/schema.ts` — `WorkflowBindingIR` interface, (2) `packages/shared/src/tools/dsl-property-parser.ts` — `WorkflowBindingLocal` interface + `buildWorkflowBindingFromProps()` parser, (3) `packages/shared/src/tools/resolve-tool-implementations.ts:571` — passthrough (verify-only, no code change needed since it passes the whole binding object), (4) `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — forwards binding fields to engine POST body. Missing any site silently drops the new DSL property.
**Files**: `packages/compiler/src/platform/ir/schema.ts`, `packages/shared/src/tools/dsl-property-parser.ts`, `packages/shared/src/tools/resolve-tool-implementations.ts`, `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
**Impact**: Future DSL binding fields must update all 4 sites atomically. The resolve-tool-implementations passthrough only works because it passes the whole `workflowBinding` object — if it ever destructures, new fields will need explicit mapping there too.

**Category**: gotcha
**Learning**: The commit-scope-guard hook (`.claude/hooks/commit-scope-guard.sh`) hard-blocks commits touching more than 3 packages. There is no documented bypass (no environment variable, no marker in commit message). When a DSL lockstep requires 4 packages, split into two sequential commits and document the split. Never use `--no-verify`.
**Files**: `.claude/hooks/commit-scope-guard.sh`
**Impact**: Future 4-package lockstep commits must plan for a 2-commit split.

## 2026-04-18 — NLU Pipeline Enhancements (FLOW gather parity)

**Category**: gotcha
**Learning**: The `compileFlow` function has an inline type definition for step gather fields (~line 2931) and a field mapping (~line 3094) that must BOTH be updated when adding fields to `FlowGatherField`. Missing a field in either location silently drops it. The inline type is NOT shared with `FlowGatherField` from `@abl/core` — it's duplicated. Additionally, the FLOW entity_ref resolution pass (~line 851) needs its own exclusivity check (entity_ref vs TYPE/OPTIONS), separate from the top-level `compileGather` exclusivity check. After entity_ref resolution, a FLOW-to-entity lowering pass creates anonymous entities for typed FLOW gather fields, mirroring what `compileGather` does for top-level fields.
**Files**: `packages/compiler/src/platform/ir/compiler.ts`
**Impact**: Three locations must stay in sync for FLOW gather fields: (1) inline type in `compileFlow`, (2) field mapping in `compileFlow`, (3) post-processing passes in `compileAgentToIR` (entity_ref resolution, entity lowering). The ENTITIES DSL format uses `entity_name:\n  TYPE: enum` (indented key), NOT `- NAME: entity_name` (YAML list) — the latter is only for NLU entities.

## 2026-04-18 — ABL Contract Hardening Phase 1

**Category**: architecture
**Learning**: Build-time contract registries and doc generators should depend only on lightweight source-data modules, not executor or validator implementations. Pulling runtime-heavy modules into `tsx`-driven generation broke `abl:docs:generate` through unrelated package-export resolution. The fix was to move contract facts like handoff action values, field-reference built-ins, and tool-context param names into `platform/contracts/contract-source-data.ts`, then import that shared source from validators, executors, tests, and the registry.
**Files**: `packages/compiler/src/platform/contracts/contract-source-data.ts`, `packages/compiler/src/platform/contracts/abl-contract-registry.ts`, `packages/compiler/src/platform/ir/validate-coordination-config.ts`, `packages/compiler/src/platform/ir/validate-field-refs.ts`, `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
**Impact**: Any future schema-backed docs, support matrices, or build-time validators should source facts from dependency-light contract modules first, then let runtime code consume those modules instead of re-declaring constants.

**Category**: process
**Learning**: Generated markdown/MDX/JSON artifacts must be Prettier-stable at generation time. If `abl:docs:generate` writes raw content and developers later run `prettier --write`, `abl:docs:check` will fail even though the files are semantically current. The generator must resolve the repo’s Prettier config (`prettier.resolveConfig`) and merge it into `prettier.format({ filepath, ...config })`; `filepath` alone only infers the parser and can drift from hook/CLI formatting.
**Files**: `tools/abl-docs/shared.ts`, `docs/reference/generated/abl-contract.json`, `docs/reference/generated/abl-contract-facts.md`, `apps/docs-internal/content/abl-reference/*.mdx`, `apps/studio/content/abl-reference/*.mdx`
**Impact**: Any future generated repo artifacts should either be emitted in final formatted form or have their freshness check normalize formatting before comparison.

## 2026-04-18 — ABL Contract Hardening Phase 2 (coordination semantics)

**Category**: architecture
**Learning**: Coordination defaults and legality checks should share compiler-owned constants instead of duplicating runtime assumptions. Exporting `DEFAULT_HANDOFF_HISTORY_STRATEGY` alongside the handoff action enums lets registry docs, runtime fallback behavior, and validation/tests point at the same contract source, and adding a dedicated `HANDOFF_ON_RETURN_WITHOUT_RETURN` diagnostic catches `ON_RETURN` configurations the runtime can never execute.
**Files**: `src/platform/contracts/contract-source-data.ts`, `src/platform/contracts/abl-contract-registry.ts`, `src/platform/contracts/index.ts`, `src/platform/ir/validate-coordination-config.ts`, `src/platform/ir/validation-types.ts`
**Impact**: Future coordination-surface work should add new defaults, legal-value lists, and unreachable-config diagnostics in the compiler contract layer first, then have runtime and generated docs consume that contract rather than re-declaring semantics ad hoc.

## 2026-04-18 — ABL Contract Hardening Phase 2 (named return handlers)

**Category**: architecture
**Learning**: Named `RETURN_HANDLERS` belong in compiler-owned coordination IR, not as ad hoc runtime string conventions. The compiler now normalizes `ON_RETURN` into one of three shapes: built-in action string, structured `{ action, map }`, or canonical `{ handler, map }`. Validation must treat plain string `ON_RETURN` values as ambiguous compatibility syntax: first check built-ins, then declared `coordination.return_handlers`, and only then warn about unknown handlers or unsupported actions.
**Files**: `packages/compiler/src/platform/ir/schema.ts`, `packages/compiler/src/platform/ir/compiler.ts`, `packages/compiler/src/platform/ir/validate-coordination-config.ts`, `packages/compiler/src/platform/ir/validation-types.ts`
**Impact**: Future post-return features should extend the handler registry and its validator first, instead of adding more free-form `ON_RETURN` strings that the runtime would need to guess at.

**Category**: process
**Learning**: Generated contract docs are now the fastest way to prove a coordination-contract change actually reached user-facing reference surfaces. After adjusting registry constructs/compatibility notes, `pnpm abl:docs:generate` should be treated as part of the implementation loop, not a post-hoc cleanup step, because it immediately exposes stale phrasing between canonical registry facts and mirrored MDX pages.
**Files**: `packages/compiler/src/platform/contracts/abl-contract-registry.ts`, `docs/reference/generated/abl-contract.json`, `docs/reference/generated/abl-contract-facts.md`
**Impact**: Any future contract-surface change in compiler should update registry facts and regenerate docs in the same slice, otherwise the spec mirrors will silently lag the executable contract.

## 2026-04-19 — ABL Contract Hardening Phase 3 (FLOW runtime semantics)

**Category**: architecture
**Learning**: FLOW execution-order warnings belong in IR validation, not parser validation. `COMPLETE_WHEN`, mixed `GATHER + ON_INPUT`, and reasoning-step post-mutation timing are runtime-semantic risks that are valid syntax, so they should surface as warning diagnostics from `validateIR()` with stable codes rather than parser errors or compile failures.
**Files**: `src/platform/ir/validate-ir.ts`, `src/platform/ir/validation-types.ts`
**Impact**: Future “dangerous but legal” FLOW constructs should add warning diagnostics in IR validation, with explicit codes and message text that docs and Studio can consume.

**Category**: testing
**Learning**: Compiler tests for runtime-semantic warnings are more stable when they validate minimal IR fixtures directly instead of going through the full DSL parser. Parser-shape requirements (`REASONING: true/false`, exact FLOW syntax) can obscure whether the validator itself is working. The warning tests now create minimal `AgentIR` objects with just the fields `validateIR()` needs.
**Files**: `src/__tests__/validate-flow-runtime-semantics.test.ts`
**Impact**: Future validation tests that target IR-only behavior should prefer minimal typed IR fixtures unless the parser/compiler path is itself part of the contract under test.

**Category**: gotcha
**Learning**: `compileFlow()` still uses a local inline gather-field type that must stay in sync with `@abl/core` AST fields. The new `piiType` work broke the compiler build until that inline type was updated. This drift can still happen even when the top-level `GatherField` types are correct.
**Files**: `src/platform/ir/compiler.ts`, `packages/core/src/types/agent-based.ts`
**Impact**: Any new flow-step gather-field property added in `@abl/core` must be reflected in the `compileFlow()` inline type immediately or compiler builds will fail on the first property access.

## 2026-04-19 — ABL Contract Hardening Phase 4 (memory grants + stability lanes)

**Category**: architecture
**Learning**: `grant_memory` should never stay as parsed-only metadata once the contract is public. The compiler now lowers both `grant_memory` and explicit `memory_grants` into one normalized IR lane, and coordination validation owns the legality checks for undeclared grants, `readwrite` requests, immutable system identifiers, and experimental agent-local lookup tables.
**Files**: `src/platform/ir/compiler.ts`, `src/platform/ir/schema.ts`, `src/platform/ir/validate-coordination-config.ts`, `src/platform/ir/validate-ir.ts`, `src/platform/contracts/abl-contract-registry.ts`
**Impact**: Future compatibility shorthands should be normalized in the compiler immediately and validated from the canonical IR shape; runtime code should not need to understand multiple authoring-era variants when the compiler can collapse them first.

## 2026-04-19 — Slice 6 [ABLP-415] enum_set semantics alias

**Category**: architecture
**Learning**: GATHER field metadata lives on two parallel surfaces — top-level properties on `GatherField` (e.g. `options`, `enum_values`) and the `SEMANTICS:` sub-block (`format`, `components`, `unit`, `locale`, ...). When we add a new alias inside `SEMANTICS:` that maps to an existing top-level property, it must be handled in BOTH compile paths (top-level GATHER at `compiler.ts:~1267` and FLOW-step GATHER at `compiler.ts:~3180`). Forgetting the FLOW-step path is an easy silent bug (Slice 5 left `sensitive/sensitive_display/mask_config` dropped in FLOW-step).
**Files**: `src/platform/ir/compiler.ts`, `src/platform/ir/schema.ts`, `packages/core/src/parser/agent-based-parser.ts`
**Impact**: Any future SEMANTICS additions should include both a top-level and a FLOW-step lock test. The parser's `SEMANTIC_KEY_MAP` (snake_case → camelCase) and `SEMANTIC_LIST_KEYS` (keys that accept array values) must be extended together when a new array-valued semantic key is introduced.

**Category**: gotcha
**Learning**: The public JSON schema at `packages/core/src/schema/abl-schema.json` uses `additionalProperties: false` on the `semantics` object, so adding a new SEMANTICS key to TypeScript/IR/parser without also adding it to the JSON schema silently breaks external YAML validators (IDE plugins, CI linters) that treat the schema as the contract. Every new SEMANTICS key needs a paired schema entry plus an Ajv test that locks the accept/reject shape.
**Files**: `packages/core/src/schema/abl-schema.json`, `packages/core/src/__tests__/abl-schema.test.ts`
**Impact**: Code/IR/schema drift is the most common way a SEMANTICS feature ships "working" in compile paths but broken for external tooling. Treat the JSON schema as part of the public contract and fail the feature if it's not updated.

## 2026-04-19 — ABL Contract Hardening Phase 6 (reference bundle integrity)

**Category**: testing
**Learning**: Public reference bundles need integrity tests above plain parse/compile. BankNexus drifted in ways the compiler still allowed — a missing flow-step declaration, a README structure entry for a nonexistent folder, and authored docs that stayed syntactically parseable but semantically incomplete. The durable fix is to keep repo-level smoke tests that read the reference bundle and authored docs from disk and assert their cross-file invariants explicitly.
**Files**: `src/__tests__/examples/banknexus-smoke.test.ts`, `src/__tests__/docs/phase6-doc-alignment.test.ts`
**Impact**: When a docs/example bundle is part of the public ABL contract, add dedicated integrity assertions for it instead of assuming parser/compiler success is enough to prove the bundle is trustworthy.

## 2026-04-19 — ABL Contract Hardening follow-up (history default contract)

**Category**: architecture
**Learning**: A platform default like handoff history must stay expressed as a compiler-owned contract value, but the contract needs one extra level of meaning when the safe behavior depends on runtime context. The durable model is `history: auto` in public ABL, a shared compiler constant for the default, compiler warnings for unsafe explicit `summary_only`, and runtime resolution that chooses between strict summary-only and bounded raw history based on the receiving agent’s actual execution surface.
**Files**: `packages/compiler/src/platform/contracts/contract-source-data.ts`, `packages/compiler/src/platform/contracts/abl-contract-registry.ts`, `packages/compiler/src/platform/ir/schema.ts`, `packages/compiler/src/platform/ir/validate-coordination-config.ts`
**Impact**: Future “safe default” coordination features should split authored contract (`auto`) from resolved runtime behavior instead of overloading a strict strategy name with conditional semantics.

## 2026-04-19 — ABL Contract Hardening Phase 8 (long-form contract governance)

**Category**: testing
**Learning**: Long-form contract governance tests need to understand both inline and structured coordination syntax. A validator that only regexes `ON_RETURN: handler_name` misses the now-canonical multi-line `ON_RETURN:\n  handler: ...\n  map: ...` form, which means authored docs can drift even while parseability still passes.
**Files**: `src/__tests__/docs/phase8-long-form-contract-governance.test.ts`
**Impact**: Future docs/examples governance checks should validate canonical nested forms directly instead of assuming all coordination references are single-line shorthand.

**Category**: process
**Learning**: When the compiler contract distinguishes DSL authoring syntax from normalized IR shape, long-form docs must be gated on the authored syntax, not the lowered representation. `history: last_<n>` is the current DSL contract even though runtime normalization uses `{ last_n: n }`, so CI should catch `last_n: 10` in authored surfaces before that ambiguity spreads.
**Files**: `src/platform/contracts/abl-contract-registry.ts`, `src/__tests__/docs/phase8-long-form-contract-governance.test.ts`
**Impact**: Any future contract split between DSL and normalized IR should add explicit authored-surface assertions so docs, Studio mockups, and knowledge cards do not start teaching IR internals as user-facing syntax.

## 2026-04-19 — ABL Contract Hardening Phase 10C (raw-doc assertions vs rendered text)

**Category**: testing
**Learning**: Doc-governance tests read checked-in markdown/MDX source, not rendered HTML. Expectations therefore need to match escaped source text such as `summary\\*only`, not the visually rendered `summary_only` cell a human sees in the docs UI.
**Files**: `src/__tests__/docs/phase6-doc-alignment.test.ts`
**Impact**: Future compiler-owned docs assertions should prefer stable source-level substrings or regexes over fragile rendered-text expectations, especially for markdown tables where escaping can differ from the final UI.

## 2026-04-22 — Legacy HANDOFF.ON_RETURN shorthand validation lane

**Category**: architecture
**Learning**: Compiler coordination validation must treat plain-string `on_return` values as a backward-compatibility lane: accept built-in actions immediately, accept declared `return_handlers` by name, and downgrade unknown shorthand to a targeted warning instead of a hard failure so older authored bundles keep compiling.
**Files**: `packages/compiler/src/platform/ir/schema.ts`, `packages/compiler/src/platform/ir/compiler.ts`, `packages/compiler/src/platform/ir/validate-coordination-config.ts`, `packages/compiler/src/__tests__/validate-coordination-config.test.ts`, `packages/compiler/src/__tests__/handoff-return-handlers-compilation.test.ts`
**Impact**: Future compatibility shorthands in compiler-owned coordination surfaces should be normalized into canonical IR where possible and otherwise preserved behind explicit warning diagnostics rather than breaking older DSL syntax at compile time.

## 2026-04-22 — Voice Runtime Semantics Unification Phase 1

**Category**: architecture
**Learning**: Shared realtime capability vocabulary belongs in the lightweight `platform/llm/realtime/types.ts` module, not in provider adapters or runtime-only helpers. The runtime parity registry and future provider normalization work both need the same capability shape without importing provider implementations.
**Files**: `src/platform/llm/realtime/types.ts`
**Impact**: Future realtime voice slices should extend the capability/event contracts in `types.ts` first, then let provider adapters and runtime services consume those types instead of defining parallel runtime-only capability enums.

## 2026-04-22 — Voice Runtime Semantics Unification Phase 2

**Category**: architecture
**Learning**: Normalized realtime voice events should be introduced as an additive session hook instead of replacing the existing transcript/tool/interruption callbacks in one step. That lets provider adapters publish a canonical event stream immediately while the runtime migrates incrementally and keeps today’s executor behavior stable.
**Files**: `src/platform/llm/realtime/types.ts`, `src/platform/llm/realtime/openai-realtime.ts`, `src/platform/llm/realtime/gemini-live.ts`, `src/platform/llm/realtime/ultravox-realtime.ts`
**Impact**: Future realtime runtime slices should subscribe to `onNormalizedEvent` for canonical semantics, but only remove legacy callbacks after every downstream caller has been migrated and covered by regression tests.

## 2026-04-24 — Auth Profile Phase 2 Core Auth Types (Post-Impl Sync)

**Category**: architecture
**Learning**: Request-signing auth must be applied in the executor after the final method, URL, headers, query string, and body are materialized. Runtime should pass transient context such as `sigv4_auth`, but `http-tool-executor.ts` is the correct seam for canonical SigV4 signing and plain-HTTP mTLS rejection.
**Files**: `src/platform/constructs/executors/http-tool-executor.ts`, `src/platform/constructs/executors/http-tool-sigv4.ts`, `src/platform/ir/schema.ts`
**Impact**: Future transport- or request-shape-dependent auth work in compiler/runtime should preserve the pattern of carrying transient binding metadata into the executor instead of trying to precompute auth too early.

## 2026-04-23 — Conversation Behavior deferred-field tests should lock only explicit phase gates

**Category**: testing
**Learning**: When the product docs carry both a broad field catalog and a narrower phase subset, compiler tests should only hard-code the fields that the current phase docs/LLD explicitly call deferred. For `Conversation Behavior`, that stable deferred set is `speaking.variety`, `listening.backchannels`, `listening.use_audio_cues`, `interaction.adaptation`, and `interaction.flow_mode`; broader field-catalog ambiguity belongs in docs alignment work, not in a regression test.
**Files**: `src/platform/ir/validate-conversation-behavior.ts`, `src/__tests__/ir/conversation-behavior-ir.test.ts`
**Impact**: Future phase-gating tests should lock the narrowest explicit contract from the active design docs so compiler coverage does not accidentally freeze an unresolved product decision.

## 2026-04-26 — Guardrail Pipeline Side Effects Must Log Best-Effort Failures (ABLP-578)

**Category**: pattern
**Learning**: `GuardrailPipelineImpl` should not attach empty `.catch(() => {})` handlers to `recordCost()` or warning webhook delivery. The stable compiler-side contract is a small best-effort wrapper that logs `warn` with the side-effect name and sanitized error message while preserving the main guardrail decision path.
**Files**: `src/platform/guardrails/pipeline.ts`, `src/__tests__/guardrails/pipeline-side-effects.test.ts`
**Impact**: Future fire-and-forget guardrail telemetry, billing, or webhook paths should go through the same logged best-effort wrapper so secondary failures stay observable without breaking the primary evaluation result.

## 2026-04-26 — Form Body Templates Need Per-Placeholder Encoding (ABLP-265)

**Category**: gotcha
**Learning**: `body_type: form` has two serialization paths: auto-body payloads and explicit `body_template` strings. Auto-body can safely serialize the whole payload with `URLSearchParams`, but templates must encode each placeholder value independently so delimiters such as `&` and `=` in static template text stay intact. JSON templates still need JSON escaping; form templates need x-www-form-urlencoded encoding; text/XML templates should keep raw placeholder string semantics.
**Files**: `src/platform/constructs/executors/http-tool-executor.ts`, `src/__tests__/constructs/http-tool-executor.test.ts`
**Impact**: Any future template placeholder source (`input`, `secrets`, `env`, context, session) must thread the body-type formatting mode through the shared resolver rather than adding a one-off replacement path.

## 2026-04-27 — SOAP Tool Support Phase 4 (E2E + INT-7 Round-Trip)

**Category**: testing
**Learning**: The INT-7 lockstep test group for SOAP was extended with a DSL serialize→parse→build round-trip test. The key function imports (`serializeToolFormToDsl`, `parseDslProperties`, `buildHttpBindingFromProps`) are all re-exported from the barrel `@agent-platform/shared/tools` — do not try sub-path imports like `@agent-platform/shared/tools/serialize-tool-form-to-dsl` because the package.json exports map does not expose them. Use a single dynamic `await import('@agent-platform/shared/tools')` and destructure from the result. `serializeToolFormToDsl` only emits `on_soap_fault` when the value is not `'error'` (the default), so round-trip tests that need to verify the field must use `'data'`.
**Files**: `src/__tests__/constructs/tool-lifecycle-e2e.test.ts`
**Impact**: Future DSL round-trip tests should use the barrel import and choose non-default enum values for fields that are only serialized when non-default.

## 2026-04-27 — SOAP Tool Support Phase 1b (IR Schema Extension)

**Category**: pattern | gotcha
**Learning**: SOAP fields (`protocol`, `soap_version`, `soap_action`, `on_soap_fault`) were added to `HttpBindingIR` as optional fields. The AST uses camelCase (`soapVersion`) while IR uses snake_case (`soap_version`). The `compileHttpBinding` function maps between the two. SOAP tools dispatch through the same `HttpToolExecutor` as REST tools — there is no protocol-aware dispatch in `ToolBindingExecutor` (Alternative A from HLD). Validation in `tool-schema-validator.ts` enforces: (1) `soap_version` required when `protocol === 'soap'`, (2) `soap_action` forbidden when `protocol !== 'soap'`.
**Files**: `src/platform/ir/schema.ts`, `src/platform/ir/compiler.ts`, `src/platform/ir/tool-schema-validator.ts`
**Impact**: Future SOAP runtime behavior (envelope wrapping, SOAPAction header injection, fault handling) should be implemented in `HttpToolExecutor` by checking `binding.protocol === 'soap'`, not by adding a new executor or dispatch branch. The `@agent-platform/shared/tools` `HttpBindingIRLocal` type already has these same 4 fields from Phase 1a — the compiler IR and shared local IR are now in sync.

## 2026-04-27 — SOAP Tool Support Phase 2b (Core SOAP Executor)

**Category**: pattern | gotcha
**Learning**: SOAP envelope construction, WS-Security injection, XML parsing, and fault detection live in `soap-envelope.ts` as a sibling module to `http-tool-executor.ts`. The executor branches on `binding.protocol === 'soap'` in two places: (1) `buildRequest()` for request envelope wrapping and Content-Type/SOAPAction headers, (2) `executeWithRetry()` after `readBoundedResponse()` for SOAP response parsing and fault detection. The `escapeForXmlBodyTemplate` flag is threaded through all 7 placeholder resolver methods (`formatPlaceholderValue`, `resolveInputPlaceholders`, `resolveContextPlaceholders`, `resolveSessionPlaceholders`, `resolveSecrets`, `resolveEnvVars`, `resolvePlaceholders`). When SOAP escaping is active, JSON/form escaping is explicitly disabled to prevent double-escaping (the default `body_type` is 'json', which would otherwise enable JSON escaping on SOAP tools). SOAP response parsing only triggers when the response Content-Type is XML-like — JSON responses from SOAP endpoints pass through as-is to handle cases like the `tool-binding-executor.test.ts` SOAP dispatch test.
**Files**: `src/platform/constructs/executors/soap-envelope.ts`, `src/platform/constructs/executors/http-tool-executor.ts`, `src/__tests__/constructs/http-tool-executor-soap.test.ts`
**Impact**: Any future placeholder source or body-type mode added to the executor must also be threaded through with the XML escaping flag, or SOAP templates will have an injection vector. The `ToolErrorCode` union in `shared-kernel` does not include SOAP-specific codes (TOOL_SOAP_FAULT, TOOL_RESPONSE_PARSE_FAILED) — TOOL_EXECUTION_ERROR and TOOL_INVALID_RESPONSE are used as the closest existing codes. If SOAP-specific codes are added later, update the executor's SOAP fault and parse-failure error construction.

## 2026-04-28 — SOAP Tool Support Post-ALPHA Bug Fixes

**Category**: gotcha
**Learning**: Three interrelated bugs were found post-ALPHA: (1) SOAPAction header must be RFC-compliant quoted-string (e.g., `"http://tempuri.org/Add"` with surrounding double quotes). Bare URIs cause 400 errors on .NET WCF and Apache Axis servers. The fix is in `soap-envelope.ts:renderSoapRequest()`. (2) Pre-wrapped envelope detection must strip leading `<?xml ...?>` declarations before checking for `<soap:Envelope>` prefix. Users who copy XML from tools like SoapUI include the XML declaration; without stripping, the body is detected as non-envelope and double-wrapped. (3) `soap_action` placeholder resolution was incomplete — only `resolvePlaceholders` was called (covers `{{input.X}}`, `{{secrets.X}}`, `{{env.X}}`), but `resolveContextPlaceholders` and `resolveSessionPlaceholders` were missing. All 5 namespaces must be resolved for `soap_action` just as they are for regular headers.
**Files**: `src/platform/constructs/executors/soap-envelope.ts`, `src/platform/constructs/executors/http-tool-executor.ts`
**Impact**: When adding new placeholder namespaces or header-like fields to the executor, ensure all resolver functions are called consistently. The SOAPAction quoting pattern (`"${value}"`) should be reused if any future SOAP headers require RFC-quoted values. The XML declaration strip pattern (`/^<\?xml[^?]*\?>\s*/i`) should be reused if any future XML pre-wrap detection is added.

## 2026-04-28 — Prompt Library: Dynamic Field Injection for Compiler Hook

**Category**: pattern
**Learning**: `AgentBasedDocument.systemPromptLibraryRef` cannot be added to the `@abl/core` package's `AgentBasedDocument` type without a larger cross-package change. The compile-orchestration hook injects the field dynamically via `as unknown as` cast before calling `compileABLtoIR()`. A post-process step after `compileABLtoIR()` copies the resolved `libraryRef` metadata into `ir.identity.system_prompt.libraryRef`. The compiler itself stays pure.
**Files**: `src/__tests__/system-prompt-config-types.test.ts` (type extension test)
**Impact**: When adding compiler hooks that need to pass transient data through the compilation context, prefer a two-step pattern: (1) dynamic injection pre-compile, (2) post-process IR to extract and persist results. Do not add ephemeral compile-context fields to the @abl/core type surface.

## 2026-05-09 — PII Detection Tiered Recognizers (LLD discoveries)

**Category**: gotcha + pattern
**Learning**: While planning the PII tiered-recognizers sub-feature (ABLP-921), the LLD audit surfaced multiple latent facts about `packages/compiler/src/platform/security/`:

1. `PIIDetection` (line 21 of `pii-detector.ts`) has **no `confidence` field** today; adding it requires extending the central `createSafePIIDetection` factory at `pii-detector.ts:115` (which is called from `pii-recognizer-registry.ts:68` plus 5 other sites). Modify the factory once and every recognizer's detections gain `confidence`/`recognizer` for free.
2. `detectWithLocalPatterns` (`pii-detector.ts:250-268`) and `PII_PATTERNS` (lines 53-97) are **module-private** — no external caller imports them. Removing them is safe once `detectPII`/`redactPII`/`containsPII`/`detectPIISelective` default to `getDefaultPIIRecognizerRegistry()`.
3. `removeOverlaps` (`pii-detector.ts:273`) and `luhnCheck` (`pii-recognizer-registry.ts:170`) are both **private**; promoting to named exports is the right move when async detection (`detectAllAsync`) needs to merge sync+async results, and when pack validators (`_validators.ts`) need Luhn.
4. Two existing in-repo `withTimeout` implementations (`packages/agent-transfer/src/session/transfer-session-store.ts:45` and `packages/arch-ai/src/session/file-store-service.ts:241`) **leak timers** — neither calls `clearTimeout` on success. New high-throughput consumers (PII detection async path) must add the cleanup; consolidating these into `packages/shared` is logged as a tech-debt follow-up.
5. `MAX_RECOGNIZERS = 50` (`pii-recognizer-registry.ts:13`) is too tight for the 8-pack expansion (~45 permanent + ~50 custom per project). Raising to 100 + registering pack recognizers with `permanent: true` is the dual safeguard.
6. `registerBuiltInRecognizers` (`pii-recognizer-registry.ts:196-253`) silently overwrites on name collision — converting it to a thin shim that delegates to `core.register(registry)` is the cleanest "single source of truth" path; existing exporters of the function name remain functional.
   **Files**: `pii-detector.ts`, `pii-recognizer-registry.ts`, `pii-vault.ts`, `pii-audit.ts`, `streaming-pii-buffer.ts`
   **Impact**: Future sub-features extending PII detection (e.g., the sibling cloud-tier sub-feature) MUST treat the Foundation Stability Contract documented in the LLD as additive-only. Any non-additive change to `PIIDetection`, `detectAllAsync`, or `RegexPIIRecognizerConfig` requires a Foundation refactor with parity tests, not a sibling-spec edit.

## 2026-05-09 — PII tiered recognizers Foundation + 8-pack family landed (ABLP-921)

**Implementation outcomes from the SDLC plan above** (Phases 1a → 4 of `docs/plans/2026-05-09-pii-detection-tiered-recognizers-impl-plan.md`):

1. **`registerBuiltInRecognizers` shim works**. Delegating to `core.register(registry)` via top-level import does not produce a circular import error in ESM at module load time (registry.ts → core.ts → registry.ts) because `core.ts` only consumes `RegexPIIRecognizer` + `luhnCheck` inside its function body — by the time `register()` is called, both modules have finished initialization. No lazy `require()` needed.
2. **`createSafePIIDetection` extended additively**. Adding the optional `options` arg with `confidence` / `recognizer` keeps every existing call site (6 today) working unchanged; the central factory threads both fields down to every recognizer. Stride-of-trickle propagation pattern: extend the factory once, and the field flows through `PIIToken`, `PIIAuditEntry`, `StreamingPIIChunkResult.detections` automatically because each consumer keeps `: PIIDetection` typing.
3. **Recognizer-pack dispatcher**. `Record<PackName, PackRegister | null>` with `null` for "valid name, not yet shipped" cleanly distinguishes from "unknown name". `onDegraded` callback reserved for genuinely-unknown names.
4. **MAX_RECOGNIZERS=100 + `permanent: true`**: belt-and-suspenders for pack eviction. Capacity tests bumped to match.
5. **ReDoS bound is 25 ms per pattern across 15 adversarial inputs × 8 packs** = hard CI gate via `recognizer-packs.redos.test.ts` using `expect.soft`. All current pack regexes pass with headroom; the 25ms threshold is the documented ceiling per Round 7 industry-research finding.
6. **Pre-existing branch breakage**: `@agent-platform/shared` build is broken at `mcp-auth-resolver.ts` (5 type errors), `@agent-platform/database` build is broken at `dek-facade-factory.ts`/`encryption.plugin.ts`/`tenant-plaintext-value.ts` (8 type errors). None caused by this work — verified by running `tsc --noEmit` on the subset of files touched. Full `pnpm build` doesn't pass on this branch; per-package typecheck on touched files does. Folded into `docs/sdlc-logs/pii-detection-tiered-recognizers/implementation.log.md`.
7. **`isIbanMod97` consolidation timing**: shipped inline in `eu.ts` for Phase 2 with `// TODO(ABLP-921 P3)` marker, replaced with `_validators.ts` import in Phase 3. Both shipped on the same branch — no transient breakage in production. Safe because the inline copy was algorithm-identical.
8. **Test-first for `_validators.test.ts`**: per LLD D-4, write the test file before the implementation. With Vitest's `test.each` for table-driven fixtures, the iteration loop is mechanical; the algorithm-correctness questions surface in the test cases (we caught two test-expectation bugs — `"236"` IS Verhoeff-valid; `"900-99-1234"` IS in the ITIN range — that would have been silent acceptance had we written tests after).

**Files**: `packages/compiler/src/platform/security/{pii-detector,pii-recognizer-registry,pii-vault,pii-audit,_with-timeout,context-enhancer,_pii-bypass-fix}.ts`, `packages/compiler/src/platform/security/recognizer-packs/{core,us,eu,apac,financial,medical,network,international-phone,_validators,index}.ts`, `packages/compiler/src/platform/constructs/{cel-functions,executors/trace-scrubber}.ts`, `packages/compiler/src/platform/guardrails/action-executors.ts`, `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`.

## 2026-05-11 — Workflow HTTP Tool Async Completion (ABLP-155)

**Category**: pattern | gotcha
**Learning**: The `http-tool-executor.ts` async path is per-call, not per-binding. Async execution options (`executionMode`, `callback`, `callbackConfig`, `asyncHttpSuccess`) are threaded via `executionOptions` at call time from `tool-binding-executor.ts` — the tool DSL is never mutated. The callback injection guard must check `executionMode === "async_wait"` (not `!== "sync"`) to avoid accidentally injecting callback metadata for `async_continue` nodes. `classifyAsyncExecutionResult()` is the discriminator: it returns `AsyncHttpExecutionResult` with `__toolExecutionStatus: "accepted" | "completed"` based on status code + optional body JSONPath match. Default acceptance is narrow — status 202 only (no blanket 2xx). The `__toolExecutionStatus` field propagates through `tool-middleware.ts` to the runtime route and onward to step-dispatcher.
**Files**: `src/platform/constructs/executors/http-tool-executor.ts`, `src/platform/constructs/executors/tool-binding-executor.ts`, `src/platform/constructs/executors/tool-middleware.ts`
**Impact**: When adding new async execution logic to any executor, add the discriminated result wrapper (`__toolExecutionStatus`) rather than overloading the output shape. This lets the runtime route and workflow-engine reliably distinguish "done now" from "job accepted". The `executionOptions` threading pattern in tool-binding-executor is the canonical extension point — do not add per-tool DSL fields for orchestration-layer concerns.

## 2026-05-16 — Tool confirmation field propagation

**Category**: pattern
**Learning**: Tool confirmation fields pass through two shapes: core AST camelCase (`immutableParams`, `consentRequiredIn`, `consentScope`, `consentAction`, `consentFallback`) and IR snake_case (`immutable_params`, `consent_required_in`, `consent_scope`, `consent_action`, `consent_fallback`). `compileTools()` is the conversion point for authored ABL; resolved project tools then merge the compiled DSL behavior over the implementation.
**Files**: `src/platform/ir/compiler.ts`, `src/__tests__/ir/compiler-auth-profile.test.ts`
**Impact**: Any new confirmation subfield must be added to the core AST, `compileTools()`, and resolved-tool merge expectations together, with a regression that compiles ABL and asserts the final `ToolDefinition.confirmation` object.

## 2026-05-17 — Topology experience mode must survive IR and graph extraction

**Category**: data propagation
**Learning**: `experienceMode` is authored on coordination edges and consumed by topology/runtime/Studio layers. If it is only present in Arch blueprint state, it disappears for imported/edited ABL. Preserve it on `DelegateConfig`, `HandoffConfig`, and `AgentConnection`, and verify it through `parseAgentBasedABL()` -> `compileABLtoIR()` -> `extractAppStaticGraph()`.
**Files**: `src/platform/ir/schema.ts`, `src/platform/ir/compiler.ts`, `src/platform/ir/app-graph-extractor.ts`, `src/__tests__/topology-experience-mode.test.ts`
**Impact**: Future topology fields should be tested at the app graph boundary, not only in Arch generation tests. Otherwise Studio and runtime graph consumers will silently flatten the authored topology intent.

---

## ABLP-932 — HTTP Tool Non-2xx Response Body (2026-05-19)

**Category**: http-tool executor behaviour
**Learning**: `http-tool-executor.ts` uses `MAX_ERROR_BODY_LENGTH=256` to truncate error bodies in the throw path. The non-2xx handling block sits inside `executeWithRetry` after SOAP fault detection (`on_soap_fault`). New opt-out fields (`on_http_error`) should follow the same pattern as `on_soap_fault` — check `binding?.on_http_error` before the existing throw. The default must be the permissive direction (`data`) to avoid breaking changes.
**Files**: `src/platform/constructs/executors/http-tool-executor.ts`, `src/platform/ir/schema.ts`
**Impact**: `studio-exports.js` is what Studio loads at runtime (via `serverExternalPackages`). Changes to executor behaviour require rebuilding `@abl/compiler` dist AND restarting Studio — a Studio-only restart will NOT pick up executor changes.

---

## 2026-05-19 — PII Vault: resolveRenderMode + renderToken extraction (ABLP-535)

**Category**: pattern
**Learning**: `resolveRenderMode(consumer, patternName, patternConfigs)` at `pii-vault.ts:500+` is the single source of truth for PII consumer access control. The resolution order is: (1) pattern-level `consumerAccess` override, (2) pattern-level `defaultRenderMode`, (3) builtin switch on consumer name. Adding a new consumer requires only adding a case to the builtin switch — the pattern-level overrides and `renderToken()` helper work generically.

The `renderToken()` private method (`pii-vault.ts:212-243`) is shared by both the regex pass (wrapped `{{PII:type:id}}` tokens) and the bare-UUID restoration pass. When modifying render modes, only `renderToken()` needs updating — both passes call it.

`BARE_UUID_REGEX` (`pii-vault.ts:32`) is a module-level `/g` regex used only with `String.prototype.replace()`, which is safe (replace always resets lastIndex). Do NOT use it with `.test()` or `.exec()` — those would cause lastIndex stale-state bugs.

**Files**: `src/platform/security/pii-vault.ts`, `src/platform/ir/schema.ts` (ToolDefinition.pii_access enum)
**Impact**: When adding PII consumers or render modes, add the consumer case in `resolveRenderMode` and (if needed) a render case in `renderToken`. The vault's two-pass architecture (regex + bare-UUID) is transparent to new consumers.

## 2026-05-20 — PII Vault: renderForConsumerWithTrace + maskConfig preset wiring (ABLP-535 meta-review)

**Category**: pattern
**Learning**: `renderForConsumerWithTrace(text, consumer, patternConfigs)` at `pii-vault.ts` returns `{ rendered, renderedTokens }` where `renderedTokens` is the array of `PIIToken` objects that were actually substituted in the rendered text. This enables audit precision: the runtime can emit `pii_plaintext_dispensed` events only for tokens that appear in the tool's args, not all vault tokens. The method delegates to `renderToken()` for each match (same as `renderForConsumer`) and collects successful substitutions.

`applyMask(original, maskConfig, entityType)` at `pii-vault.ts` supports `showFirst`, `showLast`, `maskChar` configuration. When `showFirst + showLast >= original.length`, the original passes through unchanged (no masking). The mask is entity-type-aware only for formatting (e.g., phone dashes) — the `maskConfig` controls the opaque character replacement. Studio wires mask presets (full / last-4 / custom) via `maskStyleToConfig()` in the PIIPatternFormDialog, persisted as `maskConfig` on the MongoDB pattern document.

**Files**: `src/platform/security/pii-vault.ts`
**Impact**: Consumers of `renderForConsumer` that need to know WHICH tokens were substituted (for audit, telemetry, or selective processing) should use `renderForConsumerWithTrace` instead. The `renderedTokens` array is safe to iterate for hashing — it contains the full `PIIToken` including `original`, but the runtime choke-point hashes before emitting.
