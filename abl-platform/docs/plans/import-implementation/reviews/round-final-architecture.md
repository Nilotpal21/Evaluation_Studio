# Final Review: Architecture & Completeness (Round 7 Sign-Off)

**Reviewer:** Auditor 1 (Architecture & Completeness)
**Date:** 2026-03-15
**Round:** Final (sign-off after 3 fix rounds)
**Files Reviewed:** Sections 01-05 (all current versions), Round 1/2/3 architecture reviews

---

## Complete Finding Tracker: R1 through R3

### Critical (R1)

| ID     | Finding                                              | Final Status |
| ------ | ---------------------------------------------------- | ------------ |
| CRIT-1 | DisassembleContext inconsistency (name + shape)      | RESOLVED     |
| CRIT-2 | Eval set cross-ref resolution has no execution point | RESOLVED     |
| CRIT-3 | Search/channel cross-refs have no execution point    | RESOLVED     |
| CRIT-4 | Workflow version cross-ref (workflowId) unresolved   | RESOLVED     |

All four were resolved in the R1 fix round. Phase 2.5 cross-reference resolution is now fully specified in Section 3.12 with concrete `ImportDbAdapter` extensions (`queryStagedRecords`, `batchUpdateStagedRecords`), batched `bulkWrite` calls, and the `CROSS_REF_RULES` / `ARRAY_CROSS_REF_RULES` registries.

### Major (R1)

| ID    | Finding                                                 | Final Status      |
| ----- | ------------------------------------------------------- | ----------------- |
| MAJ-1 | Locales and behavior profiles not covered               | RESOLVED          |
| MAJ-2 | `localeFiles` not in `layerFiles.core` in folder-reader | RESOLVED (caveat) |
| MAJ-3 | Zod schemas do not match actual export field structures | RESOLVED          |
| MAJ-4 | No v2 import route defined                              | RESOLVED          |
| MAJ-5 | `ExistingProjectStateV2` type never defined             | RESOLVED          |
| MAJ-6 | Security scan runs after staging (should run before)    | RESOLVED          |

MAJ-2 caveat: The plan documents the required source fix (add `localeFiles` to `layerFiles.core`) but the fix is not yet in code. This is acceptable for a plan artifact.

### Minor (R1)

| ID    | Finding                                              | Final Status |
| ----- | ---------------------------------------------------- | ------------ |
| MIN-1 | LAYER_FOLDERS missing `environment` and `locales`    | RESOLVED     |
| MIN-2 | ROOT_FILES has `lockfile.json` instead of `abl.lock` | RESOLVED     |
| MIN-3 | ConnectorConfig schema hardcodes connector types     | RESOLVED     |
| MIN-4 | Progress weight distributions differ (Sec 1 vs 5)    | ACCEPTED     |
| MIN-5 | `ImportPhaseV2` vs `ImportPhase` relation unclear    | ACCEPTED     |

MIN-4: Section 1 uses 0-15/15-50/50-85/85-95/95-100; Section 5 uses 5/60/30/5. These are different representations of the same concept (rough phase weighting). Section 5's `PHASE_WEIGHTS` code is the authoritative implementation; Section 1's comment is illustrative. The discrepancy will not cause implementation confusion since Section 5 is the code that runs.

MIN-5: `ImportPhaseV2` is a new type that coexists with `ImportPhase`. The `ImportOperationStateV2` interface in Section 5 uses `ImportPhaseV2`, making the relationship implicit but clear. Not worth a plan revision.

### Cross-Section Inconsistencies (R1)

| ID    | Finding                                           | Final Status |
| ----- | ------------------------------------------------- | ------------ |
| INC-1 | DisassemblyContext vs DisassembleContext          | RESOLVED     |
| INC-2 | Phase numbering overlap (Sec 1 vs StagedImporter) | RESOLVED     |
| INC-3 | DISASSEMBLY_WAVE concept missing from Section 3   | RESOLVED     |
| INC-4 | Section 2 vs Section 3 relationship unclear       | RESOLVED     |
| INC-5 | v1-migrated manifests always pass env var checks  | ACCEPTED     |

INC-5: v1 manifests migrated via `migrateV1ToV2()` set `required_env_vars: []`, so they pass all prerequisite checks. This is correct behavior (v1 manifests cannot declare env var requirements retroactively). Documenting this edge case is optional.

### Missing Coverage (R1)

| ID     | Finding                                   | Final Status         |
| ------ | ----------------------------------------- | -------------------- |
| MISS-1 | Behavior profiles have no import path     | RESOLVED             |
| MISS-2 | Locale files have no import path          | RESOLVED             |
| MISS-3 | Deployment files have no import path      | ACCEPTED (by design) |
| MISS-4 | `AgentModelConfig` import not specified   | RESOLVED             |
| MISS-5 | `readFolderV2` requires agent files       | ACCEPTED             |
| MISS-6 | Missing Zod schemas (scenarios, personas) | RESOLVED             |
| MISS-7 | No widget config schema                   | RESOLVED             |
| MISS-8 | No crawl pattern schema                   | RESOLVED             |

MISS-3: Deployments are environment-specific runtime state and should not be imported. Intentional omission.

MISS-5: `readFolderV2()` errors on zero agent files. Partial-layer imports (e.g., vocabulary-only) are deferred to a future enhancement. Acceptable for initial scope.

### Major (R2 -- new findings)

| ID    | Finding                                                       | Final Status |
| ----- | ------------------------------------------------------------- | ------------ |
| NEW-1 | Cross-ref temp field name mismatch (disassembler vs resolver) | RESOLVED     |
| NEW-2 | Profiles/locales stored as config vars have no runtime effect | RESOLVED     |
| NEW-3 | Resolver data source ambiguity (in-memory vs DB re-query)     | RESOLVED     |

NEW-1: Disassemblers now store the join key (`_indexSlug`, `_channelDisplayName`), not the stale ObjectId. The `CROSS_REF_RULES` registry declares matching `tempJoinField` values. The resolver's STEP 2 re-queries use the correct field paths. End-to-end data flow is consistent.

NEW-2: Both profiles and locales carry explicit `[R2 Fix: NEW-2]` comments stating they are import-for-preservation-only in Phase 1, with runtime integration deferred. The import summary is required to warn the user.

NEW-3: STEP 2 explicitly states it re-queries from MongoDB. The round-trip count is updated to ~18-20 (10 queries + 7-8 bulkWrites), consistent between Section 1 (line 1303) and Section 3 (line 1224).

### Minor (R2 -- new findings)

| ID    | Finding                                                 | Final Status |
| ----- | ------------------------------------------------------- | ------------ |
| NEW-4 | `safeParseJSONArray` type safety for primitive returns  | ACCEPTED     |
| NEW-5 | 1-hour TTL vs 24-hour BullMQ retention mismatch         | ACCEPTED     |
| NEW-6 | `createdBy` allowed by schema but overwritten by inject | ACCEPTED     |

All three are implementation-quality items. NEW-4 is a latent type narrowing gap (low probability). NEW-5 is a TTL alignment question better decided during implementation. NEW-6 is cosmetic (schema allows a field that is always overwritten).

### Minor (R3 -- new findings)

| ID   | Finding                                              | Final Status |
| ---- | ---------------------------------------------------- | ------------ |
| R3-1 | `_exportedId` not in current export code             | RESOLVED     |
| R3-2 | Round 2 Performance review cross-ref count now stale | ACCEPTED     |

R3-1: The plan now contains an explicit `[R3 Fix]` annotation (Section 3.9, lines 760-768) acknowledging that `_exportedId` does not exist in the current assembler output, that the fallback heuristics in `findSlugByOriginalId` are the effective primary resolution path in Phase 1, and that adding `_exportedId` to assembler output is tracked as a future export enhancement. Implementers are instructed to test fallback paths thoroughly. The ChannelsDisassembler carries the same note. This is adequate documentation of a known gap with a viable workaround.

R3-2: Point-in-time review artifacts are expected to go stale after fixes. No action needed.

---

## Checklist Verification

### 1. R3-1 (`_exportedId`) resolved with fallback heuristics note?

**Yes.** The `[R3 Fix]` block at Section 3.9 lines 760-768 explicitly states: (a) `_exportedId` does not exist in the current export code, (b) `stripInternalFields()` removes `_id` and does not add `_exportedId`, (c) fallback heuristics (single-index assumption, name-matching convention) are the effective primary path, (d) adding `_exportedId` is a tracked future export enhancement, (e) implementers must test fallback paths. The same note applies to the ChannelsDisassembler's `originalIdToDisplayName` map.

### 2. All 5 sections form a coherent, consistent, implementable plan?

**Yes.** The orchestration flow is:

- Section 1 defines the pipeline phases (0 through 4), dependency injection, `ExistingProjectStateV2`, wave-based disassembly ordering, and the progress/result types.
- Section 2 defines the v1 fix (separate code path, clearly scoped via the `[R1 Fix: INC-4]` callout).
- Section 3 defines per-layer disassemblers, cross-ref resolution, the complete collection mapping, and implementation/testing order.
- Section 4 defines two-phase security (file-level before disassembly, record-level before staging), Zod schemas matched to actual assembler output, auth profile resolution, and prerequisite validation.
- Section 5 defines BullMQ async job design, progress tracking, rate limiting, and observability.

Handoff points between sections are explicit and consistent.

### 3. Every exported entity type has a documented import path?

**Yes.** The complete collection mapping in Section 3.14 (lines 1406-1440) covers all 28 entity types across 8 layers. Every entry specifies the MongoDB collection, export file pattern, and match field for superseded resolution. Profiles and locales are covered via `project_config_variables` with documented Phase 1 limitations.

The only intentional omissions are: (a) deployment files (environment-specific runtime state), (b) partial-layer imports without agents (deferred to future).

### 4. No contradictions remain between sections?

**No blocking contradictions.** Two minor cosmetic differences persist (MIN-4 progress weights, MIN-5 type naming) that will not cause implementation problems. All data flow paths, field names, round-trip counts, and phase orderings are consistent across sections.

### 5. Cross-ref resolution flow fully specified end-to-end?

**Yes.** The flow is traceable from disassembler through resolver through activation:

1. Disassemblers set temp join fields (`_indexSlug`, `_channelDisplayName`, `workflowName`, `_parentSetName`, `_nestedScenarioNames`, `_nestedPersonaNames`) and delete stale ObjectIds.
2. `StagedImporter.stage()` inserts records with temp fields into MongoDB.
3. Phase 2.5 resolver STEP 1 builds 5 anchor name-to-newId maps.
4. Phase 2.5 resolver STEP 2 re-queries 5 dependent collections, builds batched updates, issues 7-8 `bulkWrite` calls to set foreign keys and `$unset` temp fields.
5. Safety net strips any residual `data._` prefixed fields before activation (with the R3 optimization of `countDocuments` checks first).
6. `StagedImporter.activate()` transitions records from `staged` to `active`.

The `CROSS_REF_RULES` and `ARRAY_CROSS_REF_RULES` registries make this extensible.

---

## Final Verdict

**APPROVED**

**Confidence: HIGH**

The plan is architecturally sound, internally consistent, and implementable. All 4 critical findings from Round 1, all 6 major findings from Round 1, and all 3 major findings from Round 2 are resolved. The remaining open items (5 ACCEPTED minor/informational items) are implementation-quality decisions that do not affect the plan's correctness or completeness.

---

## Implementation-Time Watch Items

These are not blocking and do not affect the verdict, but are worth tracking during implementation:

1. **Fallback heuristic coverage for multi-index projects.** The `findSlugByOriginalId` fallback works well for the common case (1 index), but projects with many indexes and ambiguous source names may hit the null/warning path. Consider adding `_exportedId` to assembler output early in the implementation cycle rather than deferring.

2. **`localeFiles` in `folder-reader.ts`.** The plan documents that `localeFiles` must be added to `layerFiles.core`, but this is a source code change that must not be forgotten. Add it to the implementation checklist.

3. **Profiles/locales runtime integration (Phase 2).** The import-for-preservation-only limitation is clearly documented, but there is no timeline for Phase 2. If users import projects with profiles/locales and expect them to work, the warning message must be prominent. Track Phase 2 as a follow-up ticket.

4. **TTL alignment.** `ImportOperationStateV2.expiresAt` (1 hour) vs BullMQ `removeOnComplete.age` (24 hours) creates a window where the BullMQ job exists but the operation state document has expired. Consider aligning during implementation.

5. **Safety net performance.** The `countDocuments` optimization for residual `_` field stripping (R3 addition) is good, but the `$or` query with 5 `$exists` clauses may not use indexes efficiently. If import volumes are high, monitor query times and consider adding a sparse index on one of the temp fields as a canary.
