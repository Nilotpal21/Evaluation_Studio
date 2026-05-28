# Round 2 Review: Architecture & Completeness

**Reviewer:** Auditor 1 (Architecture & Completeness)
**Date:** 2026-03-15
**Round:** 2 (post-fix verification)
**Files Reviewed:** Sections 1-5 (updated), Round 1 review, source code for staged-importer.ts, folder-reader.ts, types.ts

---

## Round 1 Finding Verification

### Critical Issues

- **[CRIT-1] DisassembleContext inconsistency** -- [RESOLVED]
  Section 1 now explicitly defers to Section 3 as the canonical definition (Section 1, line 393-399). The interface name is unified as `DisassembleContext` everywhere. The Section 1 orchestrator code (`buildLayerCtx` at line 245) uses the correct shape from Section 3. Both sections show identical type definitions for `DisassembleContext`, `DisassembleResult`, and `LayerDisassembler`. The old `DisassemblyContext` and `FolderReadResultV2`-based shape is gone.

- **[CRIT-2] Eval set cross-reference resolution has no defined execution point** -- [RESOLVED]
  Phase 2.5 is now explicitly defined in the Section 1 orchestration flow (line 173-178) and fully specified in Section 3, Section 3.12 (lines 917-1124). The algorithm queries staged records by name, builds name-to-newId maps, and issues batched `bulkWrite` updates. The `ImportDbAdapter` extension with `queryStagedRecords` and `batchUpdateStagedRecords` is defined. The `ARRAY_CROSS_REF_RULES` type handles the eval set array-of-IDs case separately from the single-foreign-key `CROSS_REF_RULES`.

- **[CRIT-3] Search indexId and channels channelConnectionId cross-references unresolved** -- [RESOLVED]
  Both are covered in the Section 3.12 cross-reference resolution. Search sources use `_indexSlug` to join to `search_indexes.slug`, and webhook subscriptions use `_channelDisplayName` to join to `channel_connections.displayName`. **However, see NEW-1 below for a field-naming inconsistency introduced by the fix.**

- **[CRIT-4] Workflow version workflowId cross-reference unresolved** -- [RESOLVED]
  Covered in Section 3.12. Workflow versions use `workflowName` as the temp join field to resolve `workflowId` via the `workflows` anchor collection.

### Major Issues

- **[MAJ-1] Locales and behavior profiles not covered by any v2 disassembler** -- [RESOLVED]
  Both are now handled by the CoreDisassembler (Section 3, Section 3.4). Behavior profiles are stored in `project_config_variables` with `key: 'profile:{name}'`. Locales are stored with `key: 'locale:{path}'`. The symmetry table (Section 3.2, line 478) and collection mapping table (Section 3.14, lines 1268-1269) both reflect this. **See NEW-2 below for concerns about the chosen storage approach.**

- **[MAJ-2] `localeFiles` not included in `layerFiles.core` in folder-reader.ts** -- [RESOLVED WITH CAVEAT]
  The plan now explicitly notes this as a required source code fix during implementation (Section 3, lines 272-273 and 355). The CoreDisassembler pseudocode (line 350-357) states "Requires localeFiles to be included in layerFiles.core in folder-reader.ts." This is acknowledged but NOT yet implemented in source code -- the source `folder-reader.ts` still excludes `localeFiles` from `coreFiles` (confirmed at line 247-252). Acceptable for a plan: the fix is documented and tracked.

- **[MAJ-3] Zod schemas do not match actual export field structures** -- [RESOLVED]
  Schemas have been rewritten with correct field names. `ImportedSearchIndexSchema` now uses `slug`, `embeddingModel`, `vectorStore`, `searchDefaults`, `llmConfig` (not `config`). `ImportedChannelSchema` now uses `channelType`, `displayName`, `externalIdentifier` (not `type`, `name`). `ImportedGuardrailSchema` now uses `scope`, `settings`, `priority` as top-level fields (not nested under `config`). All schemas use `.strip()` instead of `.passthrough()` (Section 4, line 482-488). Source comments document which assembler fields were referenced.

- **[MAJ-4] No v2 import route defined; `project-io-v2.ts` does not exist** -- [RESOLVED]
  Section 1 now defines `ExistingProjectStateV2` (lines 118-136) which extends `ExistingProjectState`. Section 4 shows the v2 route handler code (line 180-208) referencing `apps/runtime/src/routes/project-io-v2.ts`. Section 5 shows the async job flow with `POST /import/v2` and `GET /status/:operationId` endpoints. The route file is new code to be created during implementation.

- **[MAJ-5] `ExistingProjectStateV2` type never defined** -- [RESOLVED]
  Now defined in Section 1, lines 118-136. It extends `ExistingProjectState` with an `activeRecords: Map<string, Array<{_id, ...matchFields}>>` field covering all 8 layers. The comment explains the query pattern (project + tenant + active status, projecting only `_id` and match fields).

- **[MAJ-6] Security scan runs after staging but should run before** -- [RESOLVED]
  The security pipeline is now explicitly split into two phases (Section 4, Section 4.4.8, lines 1739-1887):
  - Phase 1 (`runFileSecurityScan`): Runs on raw files BEFORE disassembly. Covers SSRF, injection, secrets, and path traversal.
  - Phase 2 (`runRecordSecurityScan`): Runs AFTER disassembly but BEFORE staging. Covers tenant isolation verification.
    The execution order diagram at lines 1880-1887 is clear and correct.

### Minor Issues

- **[MIN-1] LAYER_FOLDERS missing `environment` and `locales`** -- [RESOLVED]
  Both added to the `LAYER_FOLDERS` set (Section 4, line 1610-1611). Also added `behavior_profiles` and `deployments`.

- **[MIN-2] ROOT_FILES references `lockfile.json` but actual filename is `abl.lock`** -- [RESOLVED]
  Changed to `abl.lock` (Section 4, line 1595). Also updated in `LAYER_FILE_SIZE_LIMITS` (line 1654).

- **[MIN-3] `ImportedConnectorConfigSchema` hardcodes connector types** -- [RESOLVED]
  Changed from `z.enum([...])` to `z.string().min(1).max(100)` (Section 4, line 553).

- **[MIN-4] Progress weights mismatch between Section 1 and Section 5** -- [NOT RESOLVED]
  Section 1 (line 346-351) still uses: 0-15% validating, 15-50% staging, 50-85% activating, 85-95% post-validation, 95-100% cleanup.
  Section 5 (lines 523-526) uses: 5% validating, 60% staging, 30% activating, 5% cleanup.
  These are still different distributions. The Section 5 code (`PHASE_WEIGHTS`) is the authoritative implementation; Section 1 is a comment. This remains a minor inconsistency that could confuse implementers. **Severity: minor. Not a blocker.**

- **[MIN-5] `ImportPhaseV2` relationship to `ImportPhase` unclear** -- [NOT RESOLVED]
  Section 5 (lines 459-467) defines `ImportPhaseV2` with `'queued'` and `'cancelled'` states not present in the existing `ImportPhase` type (source: `types.ts` line 445-451). The plan still does not explicitly state whether `ImportPhaseV2` replaces or extends `ImportPhase`. The `ImportOperationStateV2` (Section 5, line 411) uses `ImportPhaseV2` for its `status` field, while the existing `ImportOperationState` uses `ImportPhase`. Since v2 is a new type, this is workable -- they coexist. **Severity: minor. Not a blocker, but the plan should note this as a new type, not a modification.**

### Cross-Section Inconsistencies

- **[INC-1] DisassemblyContext vs DisassembleContext** -- [RESOLVED]. See CRIT-1.

- **[INC-2] Phase numbering overlap** -- [RESOLVED WITH CAVEAT]
  Section 1 now uses Phase 0/1/2/2.5/3/3b/4, which does not collide with the StagedImporter's Phase 2/3/4. The numbering is unconventional (Phase 2.5 comes after Phase 3a), but the orchestration flow diagram (lines 142-188) is clear enough. The naming could be cleaner (e.g., "Resolve" instead of "Phase 2.5"), but this is cosmetic.

- **[INC-3] DISASSEMBLY_WAVE_1/2/3 vs no wave concept in Section 3** -- [RESOLVED]
  Section 3 now references the wave ordering in its orchestration flow (Section 3.13, line 1238: "For each layer in DISASSEMBLY_WAVE_1/2/3"). Section 1 defines the waves (lines 212-226). Section 3 focuses on per-layer disassembly logic and defers orchestration ordering to Section 1. This is a reasonable separation.

- **[INC-4] Section 2 vs Section 3 relationship unclear** -- [RESOLVED]
  Section 2 now includes an explicit callout (lines 7-21) explaining that Section 2 covers the v1 path and Section 3 covers the v2 path. The two paths do not share apply logic and coexist. The long-term migration path (v1 delegates to v2 internally) is noted.

- **[INC-5] v1-migrated manifests always pass env var checks** -- [NOT RESOLVED]
  Section 4 still iterates `manifest.metadata.required_env_vars` without noting that `migrateV1ToV2()` sets this to `[]`. This means v1 imports will always pass env var prerequisites. This is acceptable behavior but remains undocumented in the plan. **Severity: informational.**

### Missing Coverage

- **[MISS-1] Behavior profiles** -- [RESOLVED]. See MAJ-1.
- **[MISS-2] Locale files** -- [RESOLVED]. See MAJ-1.
- **[MISS-3] Deployment files** -- [NOT RESOLVED, ACCEPTABLE]
  Deployment files are still not imported by any disassembler. The plan does not address this. However, this is acceptable: deployments are environment-specific runtime state (which agents are deployed where) and should not be imported. Importing them would activate deployments in the target environment that may not have the required infrastructure. **Status: acceptable gap, but should be documented as intentional in Section 3.**

- **[MISS-4] `AgentModelConfig` import in CoreDisassembler** -- [RESOLVED]
  The CoreDisassembler table (Section 3, line 282) now explicitly maps `config/agent-model-configs/{name}.model-config.json` to `agent_model_configs` collection with `agentName` as the match field. The pseudocode (line 321-324) shows the parsing logic.

- **[MISS-5] `readFolderV2` agent files validation** -- [NOT RESOLVED, ACCEPTABLE]
  `readFolderV2()` still errors on `agentFiles.size === 0` (confirmed in source at line 242-243). The plan does not address partial-layer imports without core. This is acceptable for initial implementation: v2 imports always include the core layer. A partial-layer import (e.g., just vocabulary) would need a v2.1 enhancement. **Status: acceptable, not a blocker.**

- **[MISS-6] Missing Zod schemas for eval scenarios, personas, etc.** -- [RESOLVED]
  Added: `ImportedEvalScenarioSchema` (line 661-679), `ImportedEvalPersonaSchema` (line 681-698), `ImportedEvaluatorSchema` (line 704-723), `ImportedCrawlPatternSchema` (line 783-798), `ImportedWidgetConfigSchema` (line 835-844), `ImportedDomainVocabularySchema` (line 878-885), `ImportedFactSchema` (line 892-903). The `getSchemaForFile` router (lines 965-1001) maps all file patterns to their schemas.

- **[MISS-7] No widget config schema** -- [RESOLVED]. See MISS-6.
- **[MISS-8] No crawl pattern schema** -- [RESOLVED]. See MISS-6.

---

## New Issues Found in Round 2

### Major Issues (Should Fix)

- **[NEW-1] Cross-ref resolver uses `_indexSlug` but SearchDisassembler stores `_originalIndexId` -- field name mismatch**
  - Section: 03-layer-disassemblers.md, Section 3.9 vs Section 3.12
  - The SearchDisassembler (line 747) stores `parsed._originalIndexId = parsed.indexId` on search source records. It does NOT set `_indexSlug` anywhere. But the cross-ref resolver (line 1044) reads `record.data._indexSlug` to look up the new index ID. Similarly, the `CROSS_REF_RULES` registry (line 1153) declares `tempJoinField: '_indexSlug'` for search sources.
  - The same issue applies to knowledge bases: the disassembler stores `_originalSearchIndexId` (line 759) but the resolver reads `_indexSlug` (line 1057).
  - For webhooks: the disassembler stores `_originalChannelConnectionId` (line 832) but the resolver reads `_channelDisplayName` (line 1070). No code sets `_channelDisplayName` on the webhook record.
  - Root cause: The resolver was designed to join on the anchor's match field (slug/displayName), but the disassembler stores the stale ObjectId, not the anchor's match field value. To make the join work, the disassembler needs to also extract and store the join key. For example, the SearchDisassembler would need to determine which index slug the source originally referenced (from the stale `indexId` and the co-exported index files) and store it as `_indexSlug`. But the current algorithm preserves only the stale ObjectId.
  - Impact: The cross-ref resolution will fail at runtime. `indexSlugMap[record.data._indexSlug]` will be `undefined` for every search source because `_indexSlug` was never set.
  - Suggested fix: The disassemblers must store the join key, not the stale ObjectId. For search sources: look up the original `indexId` in the co-parsed `indexSlugMap` (from PHASE 1) and store `_indexSlug = matchingSlug`. For webhooks: look up `channelConnectionId` in the co-parsed `channelNameMap` and store `_channelDisplayName = matchingDisplayName`. This requires a within-disassembler pre-pass that maps old IDs to names before emitting records. Alternatively, the resolver could build the oldId-to-slug map itself during STEP 1, but this would require querying the import files again.

- **[NEW-2] Behavior profiles and locales stored as `project_config_variables` may not survive runtime queries**
  - Section: 03-layer-disassemblers.md, Section 3.4
  - The fix stores behavior profiles as `{ key: 'profile:booking', value: '<DSL content>' }` and locales as `{ key: 'locale:en/booking.json', value: '<JSON content>' }` in the `project_config_variables` collection. This is a pragmatic workaround, but the runtime code that reads behavior profiles and locales does not query `project_config_variables` -- it reads from the in-memory file maps populated by `readFolder()`.
  - The plan acknowledges this as "Phase 1" with a note about migrating to dedicated models in "Phase 2" (line 347-348 and 356-357). However, there is no indication of when Phase 2 happens or whether any runtime code will be updated to read profiles/locales from `project_config_variables`.
  - Impact: Imported behavior profiles and locales will be stored in the database but never loaded by the runtime. They are effectively inert after import. The data is preserved (not lost), but the user experience is that profiles/locales "imported successfully" but have no effect.
  - Suggested fix: Either (a) document explicitly that profiles/locales are import-for-preservation-only in Phase 1, with runtime integration deferred to Phase 2, or (b) add runtime reader code for `project_config_variables` with `profile:` and `locale:` prefixes. Option (a) is acceptable if the limitation is clearly communicated in the import summary/warnings.

- **[NEW-3] `resolveCrossReferences` receives `stagedRecordIds` but needs full staged records for temp field access**
  - Section: 01-core-architecture.md (line 175) and 03-layer-disassemblers.md (Section 3.12)
  - The orchestrator calls `resolveCrossReferences(stagedResult.recordIdMap, allRecords, deps.dbAdapter)` (Section 1, line 175). The `stagedResult.recordIdMap` is `Record<string, string[]>` (collection name to array of new `_id` strings).
  - However, the resolver algorithm in Section 3.12 (STEP 2, lines 1028-1111) needs to access temp fields on the staged records (e.g., `record.data.workflowName`, `record.data._indexSlug`, `record.data._nestedScenarioNames`). These fields are on the in-memory `allRecords` array, but the resolver queries them from the database via `queryStagedRecords()`.
  - This works because `queryStagedRecords` returns the full record data from MongoDB (where the temp fields were stored during staging). But the function signature and the STEP 2 pseudocode are confusing: STEP 2 says "for each staged workflow_version record" without specifying whether it iterates the in-memory `allRecords` or re-queries from the database. The STEP 1 queries only project `{ _id: 1, 'data.name': 1 }` for anchor collections, but STEP 2 needs `'data.workflowName'` from dependent records, which requires a separate query or iterating the in-memory array.
  - Impact: This is an ambiguity that could lead to incorrect implementation. If the implementer uses only the in-memory `allRecords` array, temp field access works but `_id` values are not yet populated (they are assigned during staging). If the implementer re-queries from MongoDB, temp fields are available but it adds 5-7 more queries.
  - Suggested fix: Clarify that STEP 2 re-queries dependent collections from the database (since the in-memory records do not have their new `_id` values), and add the required queries to the round-trip count. The summary (line 1113-1116) says "Total queries: 5" but STEP 2 needs additional queries for dependent collections (workflow_versions, search_sources, knowledge_bases, webhook_subscriptions, eval_sets, eval_scenarios, eval_personas) -- that is 7 more queries. Actual total would be ~12 queries + 7-8 bulkWrites = ~20 round trips.

### Minor Issues (Nice to Fix)

- **[NEW-4] `safeParseJSONArray` returns `Array<Record<string, unknown>>` but passes a non-array through the type assertion**
  - Section: 03-layer-disassemblers.md, Section 3.3 (line 172-179)
  - The function calls `safeParseJSON` which returns `Record<string, unknown> | null`. If the result is a non-null object, it checks `Array.isArray(parsed)`. If false, it warns and returns `[]`. But the happy path casts with `return parsed as Array<Record<string, unknown>>`. The intermediate `parsed` variable is typed as `Record<string, unknown> | null`, and the `Array.isArray` check narrows it. However, `safeParseJSON` could return a string, number, or boolean from `JSON.parse` (since `JSON.parse('"hello"')` returns a string), and the return type `Record<string, unknown> | null` would be wrong.
  - Impact: Unlikely to cause issues in practice (import files are either JSON objects or arrays), but the type safety is imprecise. A `JSON.parse` that returns a primitive would not be caught by `!Array.isArray` check since `typeof "hello"` is not `"object"`.
  - Severity: Minor. The outer `safeParseJSON` already returns `null` for non-object results via the `JSON.parse` try/catch -- actually no, `JSON.parse` succeeds for primitives. This is a latent bug path but low-probability.

- **[NEW-5] `ImportOperationStateV2.expiresAt` TTL of 1 hour may be too short for large imports**
  - Section: 05-performance-queueing.md, line 456
  - The `expiresAt` field is set to 1 hour. The job timeout is 10 minutes. But the `expiresAt` is on the MongoDB document, not the job. If a user wants to inspect a completed import's operation state, it expires after 1 hour. The GridFS import files expire after 2 hours. The BullMQ job metadata is retained for 24 hours (completed) or 7 days (failed). This creates an inconsistency: the BullMQ job record outlives the `ImportOperationState` MongoDB document by 23 hours. A status poll after 1 hour returns 404 even though the BullMQ job metadata still exists.
  - Suggested fix: Align `ImportOperationStateV2.expiresAt` with the BullMQ `removeOnComplete.age` (24 hours) to maintain parity. Or add a note explaining the short TTL rationale.

- **[NEW-6] `ImportedEvalSetSchema` allows `createdBy` through -- should be stripped by `injectOwnership`**
  - Section: 04-security-validation.md, line 654
  - The `ImportedEvalSetSchema` includes `createdBy: z.string().max(255).optional()`. But `injectOwnership()` (Section 3, line 196) destructures `createdBy` from imported data and replaces it with `ctx.userId`. The Zod schema allows `createdBy` through validation (it is not stripped by `.strip()` since it IS declared in the schema), and then `injectOwnership` overwrites it. This double-handling is harmless but the schema could omit `createdBy` since it is always overwritten. Same applies to several other schemas that declare `createdBy`.
  - Severity: Informational. No functional impact, but the Zod schemas should not declare fields that are always overwritten by server-side injection. Either remove `createdBy` from schemas (it gets stripped) or document that it is included for round-trip fidelity but always overwritten.

---

## Cross-Cutting Coherence Check

### Do the 5 sections form a coherent whole?

**Largely yes, with one significant gap (NEW-1).**

The flow across sections is:

1. Section 1 defines the orchestrator, phase ordering, `ExistingProjectStateV2`, and dependency injection.
2. Section 2 defines the v1 fix (clearly scoped as a separate code path).
3. Section 3 defines per-layer disassemblers, cross-ref resolution, and the `DisassembleContext` contract.
4. Section 4 defines security (two-phase scan), schema validation, auth profile resolution, and prerequisite checks.
5. Section 5 defines async BullMQ job flow, progress tracking, rate limiting, and observability.

The handoff points between sections are now clear:

- Section 1's orchestrator calls Section 3's disassemblers via `deps.disassemblers.get(layer)`.
- Section 1's Phase 2.5 calls Section 3's `resolveCrossReferences()`.
- Section 4's `runFileSecurityScan()` runs during Section 1's Phase 1.
- Section 4's `runRecordSecurityScan()` runs between Section 1's Phase 2 and Phase 3.
- Section 5's BullMQ worker calls Section 1's `importProjectV2()`.

The naming is now consistent (`DisassembleContext` everywhere, `abl.lock` everywhere, `.strip()` everywhere).

### Remaining contradictions

1. Progress distributions differ between Section 1 and Section 5 (MIN-4, still unresolved).
2. `ImportPhaseV2` vs `ImportPhase` coexistence is implicit (MIN-5, still unresolved).
3. Cross-ref temp field names mismatch between disassemblers and resolver (NEW-1, must fix).

---

## Dependency Order Analysis (Updated)

The `ACTIVATION_ORDER` remains correct:

```
connections -> core -> search -> workflows -> guardrails -> evals -> channels -> vocabulary
```

The `DISASSEMBLY_WAVE` ordering is:

```
Wave 1: connections (alone, because core may need connection IDs)
Wave 2: core (alone, because other layers reference core entities by name)
Wave 3: search, workflows, guardrails, evals, channels, vocabulary (parallel)
```

The Phase 2.5 cross-ref resolution now properly bridges the gap between staging and activation. The resolution depends on:

- Workflows staged before workflow_versions are resolved (same layer, implicit).
- Search indexes staged before search_sources/knowledge_bases are resolved (same layer, implicit).
- Channel connections staged before webhooks are resolved (same layer, implicit).
- Eval scenarios/personas staged before eval sets are resolved (same layer, implicit).

All cross-ref dependencies are intra-layer, which means the per-layer disassembly ordering does not affect cross-ref resolution. This is a good design property.

---

## Verdict

**PASS WITH CONDITIONS (improved from Round 1)**

Round 1 had 4 critical issues. All 4 are now resolved. The cross-reference resolution phase is fully specified with concrete algorithms, `ImportDbAdapter` extensions, and batched `bulkWrite` designs.

**Remaining conditions for passing to implementation:**

1. **[NEW-1] Fix the cross-ref temp field name mismatch** -- The SearchDisassembler, ChannelsDisassembler, and their corresponding resolver code use different field names. The disassemblers store stale ObjectIds (`_originalIndexId`, `_originalChannelConnectionId`) but the resolver expects join keys (`_indexSlug`, `_channelDisplayName`). The disassemblers must be updated to also store the join key, which requires a within-disassembler pass that maps old IDs to the co-exported anchor entity names. This is a data flow bug that will cause null foreign keys for all cross-referenced entities.

2. **[NEW-3] Clarify the cross-ref resolver's data source for dependent record iteration** -- The algorithm in Section 3.12 STEP 2 iterates "each staged record" without specifying whether this is an in-memory iteration or a database re-query. Given that new `_id` values are needed and the in-memory `StagedRecord[]` array does not have them, the resolver must re-query dependent collections from MongoDB. This adds ~7 queries to the round-trip count. Update the algorithm pseudocode and summary to reflect the actual query count.

**Recommended but not blocking:**

- [NEW-2] Document the behavior profile/locale runtime limitation clearly.
- [MIN-4] Align progress distributions between Section 1 and Section 5.
- [MIN-5] Add a note clarifying `ImportPhaseV2` is a new type, not a modification of `ImportPhase`.
- [NEW-5] Consider extending `ImportOperationStateV2.expiresAt` to match BullMQ job retention.

**Positive notes (new in Round 2):**

- The two-phase security pipeline (file-level before disassembly, record-level before staging) is well-structured and eliminates the Round 1 concern about malicious data reaching the database.
- The `injectOwnership` function's explicit destructure-then-overwrite pattern (stripping `tenantId`, `projectId`, `createdBy` before injecting server-side values) is robust against the conditional-logic bypass found in Round 1.
- The `CROSS_REF_RULES` and `ARRAY_CROSS_REF_RULES` registry pattern makes cross-ref resolution extensible without modifying the core resolver algorithm.
- The GridFS-based file storage (replacing the single BSON document approach) correctly addresses the 16MB BSON limit with realistic compression ratios.
- The resume-aware worker design (checking `ImportOperationState.status` at startup) is the correct approach for a non-idempotent activation phase.
