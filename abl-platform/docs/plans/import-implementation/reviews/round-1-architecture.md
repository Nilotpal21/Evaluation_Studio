# Round 1 Review: Architecture & Completeness

**Reviewer:** Auditor 1 (Architecture & Completeness)
**Date:** 2026-03-15
**Files Reviewed:** Sections 1-5, all source assemblers, staged-importer, folder-reader, import-applier, project-importer, import-validator, v1-migration, project-io route, Studio export route, types.ts

---

## Critical Issues (Must Fix)

- [CRIT-1] **DisassembleContext interface defined inconsistently across Section 1 and Section 3**
  - Section: 01-core-architecture.md (Section 3.1) vs 03-layer-disassemblers.md (Section 3.1)
  - Section 1 defines `DisassemblyContext` with fields `{ projectId, tenantId, userId, folderResult, existingState, conflictStrategy, authProfileMapping }`.
  - Section 3 defines `DisassembleContext` (note the different name: "Disassemble" vs "Disassembly") with fields `{ files, projectId, tenantId, userId, existingRecordIds?, authProfileMapping?, manifestMetadata? }`.
  - These are incompatible: Section 1's context passes the entire `FolderReadResultV2` and an `ExistingProjectStateV2`, while Section 3's context passes only a `Map<string, string>` for files and an `existingRecordIds` map. The disassembler implementations in Section 1 (e.g., the CoreDisassembler example at Section 3.3 of that file) use `ctx.folderResult.agentFiles`, which would not exist on Section 3's type.
  - Impact: Implementing either interface will break the other section's code examples. This must be reconciled before implementation begins.
  - Suggested fix: Consolidate to a single interface definition in Section 3 (since it owns the types file). Recommend the Section 1 shape (with full `FolderReadResultV2`) since disassemblers need access to the manifest and multiple file maps, not just one layer's files.

- [CRIT-2] **Eval set cross-reference resolution has no defined execution point**
  - Section: 03-layer-disassemblers.md (Section 3.8 and 3.12)
  - The EvalsDisassembler stores temporary fields (`_parentSetName`, `_nestedScenarioNames`, `_nestedPersonaNames`) on staged records and defers ID wiring to a "cross-ref pass" (Section 3.12). However, the StagedImporter's `stage()` method (source: `staged-importer.ts` lines 258-327) calls `db.insertStagedRecords()` which inserts the raw data including these temporary fields. There is no hook between staging and activation where the cross-ref resolution can run.
  - Impact: Temporary fields like `_parentSetName` will be persisted to MongoDB. The `scenarioIds` and `personaIds` arrays on eval sets will be empty after import. Eval sets will be non-functional.
  - Suggested fix: Either (a) perform cross-ref resolution as a post-staging/pre-activation step that queries staged records and updates them via `updateMany`, or (b) restructure the disassembler to do two internal passes: first create scenarios/personas, query their staged IDs, then construct the eval set record with the correct IDs. Option (b) requires the `ImportDbAdapter` to support querying staged records, which it currently does not.

- [CRIT-3] **Search indexId and channels channelConnectionId cross-references have the same unresolved execution problem**
  - Section: 03-layer-disassemblers.md (Sections 3.9, 3.10, 3.12)
  - Same issue as CRIT-2. Search sources store `_originalIndexId` and knowledge bases store `_originalSearchIndexId`, but neither the StagedImporter nor the orchestrator has a defined step to resolve these after staging. The current `StagedImporter.execute()` flow is: stage all records -> activate all records. There is no "update staged records" phase.
  - Impact: Search sources will have null `indexId` after import, breaking index-source relationships. Webhook subscriptions will have null `channelConnectionId`.
  - Suggested fix: Add an explicit "cross-reference resolution" phase between staging and activation in the StagedImporter, or extend `ImportDbAdapter` with a `updateStagedRecords()` method. This needs to be designed in Section 1, not left implicit.

- [CRIT-4] **Workflow version cross-reference (workflowName to workflowId) also unresolved**
  - Section: 03-layer-disassemblers.md (Section 3.7)
  - The `buildWorkflowVersionRecords()` method in `staged-importer.ts` (lines 474-526) sets `workflowName` on version records, with the comment "Caller must resolve to workflowId before inserting." The disassembler plan defers this to the cross-ref pass, but as noted in CRIT-2/CRIT-3, no such pass exists in the current staged importer flow.
  - Impact: Workflow versions will have `workflowName` but no `workflowId`, making them orphaned records not queryable by the workflow system.
  - Suggested fix: Same as CRIT-2 -- define the cross-ref resolution phase explicitly in the architecture.

## Major Issues (Should Fix)

- [MAJ-1] **Locales and behavior profiles not covered by any v2 disassembler**
  - Section: All sections
  - The `CoreAssembler` (source code) does NOT export locales or behavior profiles. However, the `readFolderV2()` function (source: `folder-reader.ts` lines 219-220) categorizes `behavior_profiles/*.behavior_profile.abl` into `profileFiles` and `locales/*.json` into `localeFiles`. These are included in the `coreFiles` layer aggregate (lines 248-252 only include agentFiles, toolFiles, configFiles, profileFiles, environmentFiles -- localeFiles are NOT included).
  - The v1 `importProject()` function reads profiles and locales but drops them silently at apply time (the known bug). The v2 plan's CoreDisassembler in Section 1/3 handles agents, tools, configs, environment, and MCP servers, but makes no mention of behavior profiles or locale files.
  - Impact: Behavior profiles from v1 exports will be silently dropped by v2 import, perpetuating the existing v1 bug. Locale files are also dropped.
  - Suggested fix: Add behavior profile and locale handling to the CoreDisassembler. For profiles, this means parsing `.behavior_profile.abl` files and storing them. For locales, determine whether they should be a new collection or handled differently.

- [MAJ-2] **`localeFiles` not included in `layerFiles.core` aggregate in folder-reader.ts**
  - Section: All sections (source code issue that the plan should address)
  - In `folder-reader.ts` line 248-252, the core layer files aggregate includes `agentFiles`, `toolFiles`, `configFiles`, `profileFiles`, and `environmentFiles` but NOT `localeFiles`. This means `readFolderV2().layerFiles.core` will not contain locale files even if they are present.
  - Impact: If a disassembler reads from `layerFiles.core`, it will miss locale files entirely. The plan does not flag or address this existing code bug.
  - Suggested fix: The plan should explicitly note that `localeFiles` must be added to the `layerFiles.core` map in `folder-reader.ts`, or handle locales through a separate mechanism.

- [MAJ-3] **Section 4 Zod schemas do not match actual export field structures**
  - Section: 04-security-validation.md (Section 4.3)
  - The `ImportedSearchIndexSchema` validates `{ name, description, config }` but the actual `SearchAssembler` exports fields like `{ slug, name, description, embeddingModel, embeddingDimensions, tokenChunkStrategy, vectorStore, searchDefaults, llmConfig, status }`. The Zod schema uses `.passthrough()` which allows these through, but the required field `config` does not exist in the export output -- the assembler exports `vectorStore`, `searchDefaults`, etc. as separate top-level fields, not nested under `config`.
  - Similarly, `ImportedChannelSchema` validates `{ name, type, enabled, config }` but the assembler exports `{ channelType, externalIdentifier, displayName, agentId, deploymentId, environment, config, status }` -- the channel has `channelType` not `type`, and `displayName` not `name`.
  - `ImportedGuardrailSchema` validates `{ name, description, type, enabled, config, priority }` but the assembler exports the full `GuardrailPolicy` record which has `scope`, `settings`, etc. as top-level fields, not under `config`.
  - Impact: These schemas will either (a) reject valid export data if required fields like `name` don't exist under that key, or (b) provide false confidence since `.passthrough()` lets everything through. The schemas need to match the actual exported shapes.
  - Suggested fix: Derive Zod schemas from the actual assembler output structures. Read each assembler's `stripInternalFields()` output and map the real field names.

- [MAJ-4] **No v2 import route defined in source code; plan references `project-io-v2.ts` but it does not exist**
  - Section: 04-security-validation.md (Section 4.1 Route Integration), 05-performance-queueing.md
  - The plan references `apps/runtime/src/routes/project-io-v2.ts` for the v2 import route handlers, but this file does not exist. The existing `project-io.ts` route only handles v1 import (agents-only). Section 5 describes the async BullMQ-based flow with a `POST /import/v2` endpoint but does not specify where this route is defined or how it coexists with the v1 route.
  - Impact: Without a clear route design, the v2 import entry point is undefined. Questions like "does the existing v1 route remain?" and "how does the client choose v1 vs v2?" are unanswered.
  - Suggested fix: Add a subsection in Section 1 or Section 5 that explicitly defines the v2 route file, its mount path, and its relationship to the existing v1 route. Recommend extending `project-io.ts` with versioned endpoints rather than a separate file.

- [MAJ-5] **`ExistingProjectStateV2` type referenced but never defined**
  - Section: 01-core-architecture.md (Section 3.1), 03-layer-disassemblers.md
  - The `DisassemblyContext` in Section 1 references `existingState: ExistingProjectStateV2`, but this type is never defined in any plan section. The existing source code defines `ExistingProjectState` (in `project-importer.ts`) which has `{ agents, toolFiles, localeFiles?, profileFiles? }` -- a v1-only shape.
  - Impact: Without this type definition, implementers don't know what existing state needs to be queried from the database for the v2 import. The v2 importer needs existing records across all 8 layers, not just agents/tools.
  - Suggested fix: Define `ExistingProjectStateV2` in Section 1 with a field for each layer's existing records (or define it as a generic `Record<collection, Array<{ _id, ...matchFields }>>` map).

- [MAJ-6] **Security scan runs after staging (per Section 4.4.8) but should run before**
  - Section: 04-security-validation.md (Section 4.4.8)
  - The `runSecurityScan()` function signature accepts `stagedRecords: StagedRecord[]` as a parameter, meaning it runs after records have been constructed. However, its description says "Called after file parsing, before prerequisite checks." This is contradictory -- staged records don't exist before prerequisite checks.
  - For tenant isolation verification (`verifyTenantIsolation`), records must already exist. But SSRF/injection/secret scanning should run on raw files BEFORE any database writes.
  - Impact: If the security scan runs after staging, malicious data has already been written to the database (with status: 'staged'). The scan results would require a cleanup pass.
  - Suggested fix: Split the security pipeline into two phases: (1) file-level scans (SSRF, injection, secrets, path traversal) run before disassembly, and (2) record-level checks (tenant isolation) run after disassembly but before staging.

## Minor Issues (Nice to Fix)

- [MIN-1] **Section 4 LAYER_FOLDERS set missing `environment` and `locales` folders**
  - Section: 04-security-validation.md (Section 4.4.5)
  - The `LAYER_FOLDERS` set in `validateV2FilePath` includes `agents`, `tools`, `config`, `core`, etc. but does not include `environment` or `locales`. The `readFolderV2()` function categorizes files under `environment/` and `locales/` directories. Files in these directories would be rejected by the path validator.
  - Suggested fix: Add `'environment'` and `'locales'` to the `LAYER_FOLDERS` set.

- [MIN-2] **Section 4 ROOT_FILES set references `lockfile.json` but the actual filename is `abl.lock`**
  - Section: 04-security-validation.md (Section 4.4.5)
  - The `ROOT_FILES` set includes `'lockfile.json'` but the actual lockfile is named `'abl.lock'` (confirmed in `folder-reader.ts` line 75). This would cause the path validator to reject legitimate lockfiles.
  - Suggested fix: Change `'lockfile.json'` to `'abl.lock'` in the ROOT_FILES set.

- [MIN-3] **`ImportedConnectorConfigSchema` hardcodes connector types**
  - Section: 04-security-validation.md (Section 4.3)
  - The schema has `connectorType: z.enum(['sharepoint', 'jira', 'confluence', 'hubspot', 'servicenow', 'salesforce'])`. This will reject any new connector types added in the future without updating the import schema.
  - Suggested fix: Use `z.string().min(1).max(100)` instead of an enum, or maintain a shared constant list.

- [MIN-4] **Section 5 progress weights don't match Section 1 progress distribution**
  - Section: 05-performance-queueing.md (Section 2.3) vs 01-core-architecture.md (Section 2.7)
  - Section 1 allocates: 0-15% validating, 15-50% staging, 50-85% activating, 85-100% cleanup.
  - Section 5 allocates: 0-5% validating, 5-65% staging, 65-95% activating, 95-100% cleanup.
  - These are different distributions. While minor, it could cause confusion during implementation.
  - Suggested fix: Pick one and update the other.

- [MIN-5] **`ImportPhaseV2` adds 'queued' and 'cancelled' states not present in `ImportPhase`**
  - Section: 05-performance-queueing.md (Section 2.1)
  - The existing `ImportPhase` type (source: `types.ts` line 445) has `'validating' | 'staging' | 'activating' | 'completed' | 'failed' | 'rolling_back'`. Section 5 extends this to `ImportPhaseV2` with added `'queued'` and `'cancelled'` states but does not define how `ImportPhaseV2` relates to the existing type (union? replacement?).
  - Suggested fix: Clarify whether `ImportPhaseV2` replaces or extends `ImportPhase`, and update the `ImportOperationState` type accordingly.

## Cross-Section Inconsistencies

- [INC-1] **Section 1 DisassemblyContext vs Section 3 DisassembleContext** -- described in CRIT-1 above. Different names, different shapes, incompatible usage.

- [INC-2] **Section 1 references "Phase 1-4" numbering while StagedImporter uses "Phase 2-4"**
  - Section 1 describes: Phase 1 (Validate), Phase 2 (Disassemble+Stage), Phase 3 (Activate), Phase 4 (Post-validate).
  - The existing `StagedImporter` source code (lines 1-9) describes: Phase 2 (Stage), Phase 3 (Activate), Phase 4 (Cleanup).
  - These numbering schemes overlap but mean different things. Section 1's "Phase 2" (Disassemble+Stage) maps to the StagedImporter's "Phase 2" (Stage), but validation and disassembly are separate concepts.

- [INC-3] **Section 1 "DISASSEMBLY_WAVE_1/2/3" vs Section 3 has no wave concept**
  - Section 1 defines three disassembly waves (Wave 1: connections; Wave 2: core; Wave 3: parallel for the rest). Section 3 defines the layer ordering via `ACTIVATION_ORDER` in the staged importer but does not discuss wave-based disassembly ordering at all.
  - These need to be aligned. The wave concept is important for dependency resolution (connections before tools that reference connectors) but is only in Section 1.

- [INC-4] **Section 2 entity types vs Section 3 collection names**
  - Section 2 proposes expanding `ApplyOperation` with a discriminated union including `entityType: 'agent' | 'tool' | 'profile' | 'locale' | 'config'`. This is a v1 fix for the existing import-applier.
  - Section 3 introduces the completely different `StagedRecord`/`SupersededRecord`-based approach via the `StagedImporter`.
  - The plan does not clearly state whether Section 2's approach is for v1 only and Section 3 replaces it for v2, or whether they coexist. The relationship between these two import paths needs explicit documentation.

- [INC-5] **Section 4 prerequisite check expects `manifest.metadata.required_env_vars` as a flat array, but actual type has no default values**
  - Section 4 iterates `manifest.metadata.required_env_vars` directly. The `ProjectManifestV2` type (source: `types.ts` line 397) defines `required_env_vars: string[]` as required, but the `migrateV1ToV2()` function (source: `v1-migration.ts` line 118) sets it to `[]`. This works, but the plan should note that v1-migrated manifests will always pass env var checks since the array is empty.

## Missing Coverage

- [MISS-1] **Behavior profiles are not imported by any disassembler**
  - The `readFolderV2()` function categorizes `behavior_profiles/*.behavior_profile.abl` files into `profileFiles` and includes them in `layerFiles.core`. No disassembler in the plan handles these files. The `CoreAssembler` does not export them either (they are not queried from any database model). If behavior profiles exist in a v1 export, they will be silently dropped.
  - Need: Determine if behavior profiles are still a feature. If yes, add to CoreDisassembler. If deprecated, document that they are intentionally dropped.

- [MISS-2] **Locale files have no import path**
  - The `readFolderV2()` function parses `localeFiles` but they are not included in `layerFiles.core`. No disassembler handles them. No database model for locales is referenced anywhere in the assemblers.
  - Need: Same determination as MISS-1.

- [MISS-3] **Deployment files are parsed by readFolderV2() but have no import disassembler**
  - `readFolderV2()` categorizes `deployments/*.deployment.json` into `deploymentFiles`, but these are not included in any layer's file map. The `WorkflowsAssembler` reads deployment data (for pinned workflow versions), and the `WorkflowsDisassembler` re-imports version files. But deployment records themselves are never imported. The plan does not mention whether this is intentional.
  - Need: Clarify whether deployments are export-only or should be import-capable.

- [MISS-4] **No plan for `AgentModelConfig` import in the CoreDisassembler**
  - The `CoreAssembler` exports `config/agent-model-configs/{name}.model-config.json` files. The Section 3 CoreDisassembler pseudocode handles generic "config files" but the table in Section 3.4 lists `agent_model_configs` as a covered collection. However, the Section 1 CoreDisassembler example code (lines 506-522) only handles generic config files with `resolveConfigCollection(path)`, without explicitly showing how `agent-model-configs/*.model-config.json` maps to the `agent_model_configs` collection.
  - Need: Ensure `resolveConfigCollection()` is defined and maps `config/agent-model-configs/*.model-config.json` to the `agent_model_configs` collection.

- [MISS-5] **No plan for how the v2 import handles the "no agent files" validation error**
  - The `readFolderV2()` function (source: line 242) returns an error if `agentFiles.size === 0`: "No agent files found in agents/ directory". This means a v2 import that contains only non-core layers (e.g., just vocabulary or guardrails) will fail validation. The plan does not address whether agent files should be optional for partial-layer imports.
  - Need: Either remove the agent file requirement for v2 imports, or document that core layer (with at least one agent) is always required.

- [MISS-6] **No Zod schema for eval scenarios, eval personas, or facts in Section 4**
  - Section 4 defines schemas for eval sets and evaluators, but not for scenarios, personas, domain vocabularies, or facts. These entity types can contain arbitrary nested data and are equally vulnerable to injection.
  - Need: Add Zod schemas for `ImportedScenarioSchema`, `ImportedPersonaSchema`, `ImportedDomainVocabularySchema`, and `ImportedFactSchema`.

- [MISS-7] **No plan for widget config import validation**
  - Section 4 has no Zod schema for widget configs. The `ChannelsAssembler` exports `channels/widgets/widget-config.json` and the disassembler plan handles it, but there is no schema validation for this entity type.

- [MISS-8] **No plan for crawl pattern import validation**
  - Crawl patterns are exported as an array in `search/crawl-patterns.json`. Section 4 has no schema and `getSchemaForFile()` will return null for this file since it does not end with a recognized suffix like `.index.json`.

## Dependency Order Analysis

The `ACTIVATION_ORDER` in `staged-importer.ts` is:

```
connections -> core -> search -> workflows -> guardrails -> evals -> channels -> vocabulary
```

Issues found:

- [DEP-1] **Guardrails after workflows is correct (guardrails can reference agent names, not workflows).**
- [DEP-2] **Evals after core is correct (evals reference agents by `entryAgent` field).**
- [DEP-3] **Channels after core is correct (channels reference `agentId` and `deploymentId`).**
- [DEP-4] **Search after core is acceptable (search indexes are independent, but sources may reference connector configs which are in the connections layer, already processed).**
- [DEP-5] **The disassembly wave order in Section 1 (Wave 1: connections, Wave 2: core, Wave 3: rest in parallel) is correct for dependency ordering but mismatches the activation order where search comes before workflows. If cross-ref resolution depends on staged record IDs being available, the wave ordering needs to align with the cross-ref resolution order, not just the activation order.**

## v1/v2 Compatibility Analysis

- v1 imports continue working: The existing `importProject()` function and `project-io.ts` route are untouched by the plan. PASS.
- v2 exports imported by v2 importer: Covered by Sections 1-3. PASS (assuming cross-ref issues are resolved).
- v1 exports imported by v2 importer: Covered by `migrateV1ToV2()` which converts v1 manifests to v2 structure with `layers_included: ['core']`. PASS.
- Mixed versions (v1 manifest + v2 layer files): The plan does not address this scenario. If someone manually adds v2 layer files to a v1 export without updating the manifest, `migrateV1ToV2()` will set `layers_included: ['core']` and non-core layers will be ignored. This is acceptable behavior but should be documented.

## Open Questions Review

From Section 1:

- "Should the v2 import be a separate endpoint or versioned parameter on the existing endpoint?" -- This IS a blocker. Must decide before implementation to avoid route conflicts.

From Section 3:

- No explicit open questions section, but the cross-reference resolution mechanism (Section 3.12 is referenced multiple times but the content is not fully defined in the provided text) is a blocker.

From Section 5:

- "Should failed import files be retained for debugging?" -- Not a blocker, default to yes with TTL.
- "Should the worker run in the Runtime app or a dedicated import service?" -- Not a blocker for initial implementation.

**Blocker open questions:** Route design (Section 1), cross-reference resolution mechanism (Section 3).

## Positive Notes

- The 3-phase staged import model (stage/activate/cleanup) with rollback support in `StagedImporter` is well-designed and already implemented. Building on this foundation is sound.
- The auth profile resolution cascade (exact name -> fuzzy match -> user mapping) in Section 4 is thorough and handles the common cross-environment scenarios well.
- The security hardening in Section 4 is comprehensive: SSRF, NoSQL injection, prototype pollution, secret leakage detection, path traversal, tenant isolation verification. This is well beyond what most import systems implement.
- The assembler-disassembler symmetry table in Section 3 is excellent documentation -- it maps every export file pattern to its import counterpart with collection names and match fields.
- The BullMQ async job design in Section 5 correctly leverages existing platform infrastructure (distributed locks, circuit breakers, Redis pub/sub progress).
- The SHA-based integrity verification (3-tier: root -> layer -> file) provides strong tamper detection without requiring signatures.

## Verdict

**PASS WITH CONDITIONS**

The plan is architecturally sound in its overall design (layered disassembly, staged import, auth profile resolution, security hardening, async queueing). However, four critical issues must be resolved before implementation:

1. **Reconcile the DisassembleContext interface** (CRIT-1) -- single source of truth for the disassembler contract.
2. **Define the cross-reference resolution phase** (CRIT-2, CRIT-3, CRIT-4) -- the plan repeatedly defers to "Section 3.12" but the mechanism for resolving inter-record references (eval set -> scenario IDs, search source -> index IDs, workflow version -> workflow IDs, webhook -> channel IDs) after staging is not architecturally defined. This is the plan's biggest gap.
3. **Address behavior profiles and locales** (MAJ-1, MISS-1, MISS-2) -- determine their import status.
4. **Align Zod schemas with actual export shapes** (MAJ-3) -- the current schemas will either reject valid data or provide false validation confidence.

Conditions for passing to implementation:

- All CRIT issues resolved in plan updates.
- MAJ-1, MAJ-3, MAJ-4, MAJ-5, MAJ-6 addressed.
- Cross-reference resolution phase fully designed with concrete `ImportDbAdapter` extensions.
