# Round 3 Review: Architecture & Completeness

**Reviewer:** Auditor 1 (Architecture & Completeness)
**Date:** 2026-03-15
**Round:** 3 (verification of Round 2 must-fix items)
**Files Reviewed:** Sections 01, 03 (focused), 02/04/05 (skim), source code for `search-assembler.ts`, `channels-assembler.ts`, `assembler-utils.ts`

---

## Round 2 Must-Fix Verification

### [NEW-1] Cross-ref field name mismatch -- RESOLVED

The disassemblers now store the join key (the anchor's human-readable name), not the stale ObjectId.

**Full data flow trace:**

1. **SearchDisassembler** (Section 3.9, lines 742-825):
   - PHASE 1 builds `originalIdToSlug` map from `_exportedId` on index records.
   - PHASE 2 calls `findSlugByOriginalId()` to resolve stale `indexId` to a slug.
   - Sets `parsed._indexSlug = matchingSlug`, deletes `parsed.indexId`.
   - PHASE 3 does the same for knowledge bases: `parsed._indexSlug = matchingSlug`, deletes `parsed.searchIndexId`.

2. **ChannelsDisassembler** (Section 3.10, lines 854-912):
   - PHASE 1 builds `originalIdToDisplayName` map from `_exportedId` on channel records.
   - PHASE 2 calls `findDisplayNameByOriginalId()` to resolve stale `channelConnectionId`.
   - Sets `parsed._channelDisplayName = matchingDisplayName`, deletes `parsed.channelConnectionId`.

3. **CROSS_REF_RULES registry** (Section 3.12, lines 1257-1286):
   - `search_sources`: `tempJoinField: '_indexSlug'`, `anchorMatchField: 'slug'` -- matches disassembler.
   - `knowledge_bases`: `tempJoinField: '_indexSlug'`, `anchorMatchField: 'slug'` -- matches disassembler.
   - `webhook_subscriptions`: `tempJoinField: '_channelDisplayName'`, `anchorMatchField: 'displayName'` -- matches disassembler.

4. **Resolver STEP 2** (Section 3.12, lines 1112-1165):
   - Re-queries `search_sources` projecting `'data._indexSlug'`, reads `record.data._indexSlug` to look up `indexSlugMap[...]`. Sets `'data.indexId'`, unsets `'data._indexSlug'`.
   - Same pattern for `knowledge_bases` and `webhook_subscriptions` with their respective fields.

5. **PHASE 5 cross-reference notes** in both disassemblers reference the correct join fields (`_indexSlug`, `_channelDisplayName`).

**Verdict: Field names are now consistent end-to-end. The data flow is coherent from disassembler through CROSS_REF_RULES through resolver STEP 1/2 through $unset cleanup.**

---

### [NEW-3] Resolver data source ambiguity -- RESOLVED

The resolver algorithm in Section 3.12 now clearly states (lines 1090-1094):

> STEP 2 re-queries dependent collections from MongoDB. The in-memory `StagedRecord[]` array does not have new `_id` values (those are assigned during staging by `insertMany`). Re-querying is required to access both the new `_id` and the temp join fields.

The round-trip count is updated:

- STEP 1: 5 anchor queries
- STEP 2: 5 dependent re-queries + 7-8 bulkWrites
- **Total: ~18-20 round trips** (Section 3.12, line 1214)

Section 01 now matches at line 1303: `total: ~18-20 round trips`.

**Verdict: Data source is unambiguous. Round-trip count is accurate and consistent between Section 1 and Section 3.**

---

### [NEW-2] Profiles/locales Phase 2 scope limitation -- RESOLVED

Both the profiles block (Section 3.4, lines 350-357) and locales block (lines 367-372) now carry explicit `[R2 Fix: NEW-2]` comments stating:

- Profiles/locales stored as config variables are **import-for-preservation-only in Phase 1**.
- The runtime loads from in-memory file maps, NOT from `project_config_variables`.
- Phase 2 scope is documented: add a dedicated model with runtime reader, or update the runtime loader.
- The import summary **MUST warn the user** about this limitation.

**Verdict: Scope limitation is clearly documented. The user-facing warning requirement is explicit.**

---

## Cross-Section Consistency Check

### Items verified as consistent:

| Aspect                    | Section 1                               | Section 3                                   | Section 5 | Status     |
| ------------------------- | --------------------------------------- | ------------------------------------------- | --------- | ---------- |
| Cross-ref round trips     | ~18-20 (line 1303)                      | ~18-20 (line 1214)                          | N/A       | Consistent |
| `DisassembleContext` type | Defers to Sec 3                         | Canonical (line 16-36)                      | N/A       | Consistent |
| Phase 2.5 ordering        | After stage, before activate (line 173) | Algorithm defined (line 1041-1214)          | N/A       | Consistent |
| Safety net strip          | Referenced (line 1302)                  | Defined (lines 1216-1231)                   | N/A       | Consistent |
| `_indexSlug` naming       | Not mentioned                           | Set in disassembler, read/unset in resolver | N/A       | Consistent |
| `_channelDisplayName`     | Not mentioned                           | Set in disassembler, read/unset in resolver | N/A       | Consistent |

### Items still inconsistent (carried from Round 2, all minor):

1. **[MIN-4] Progress weights:** Section 1 uses 0-15/15-50/50-85/85-95/95-100. Section 5 uses 5/60/30/5. Still different. Still minor.
2. **[MIN-5] `ImportPhaseV2` vs `ImportPhase`:** Still no explicit note that `ImportPhaseV2` is a new type. Still minor.
3. **[INC-5] v1-migrated manifests and env var checks:** Still undocumented. Informational.

---

## New Issues Found in Round 3

### [R3-1] `_exportedId` field does not exist in the current export code -- MINOR (implementation note needed)

- **Section:** 03-layer-disassemblers.md, Section 3.9 (lines 757-759) and Section 3.10 (line 871)
- The SearchDisassembler's `findSlugByOriginalId` relies on `parsed._exportedId` being present on exported index records to build the `originalIdToSlug` reverse map. Similarly, the ChannelsDisassembler depends on `_exportedId` on channel connection records.
- **Source code check:** The `stripInternalFields()` function in `assembler-utils.ts` removes `_id` from all exported records. The search assembler (`search-assembler.ts`, line 55) calls `stripInternalFields(index)` and does NOT add any `_exportedId` field. The channels assembler follows the same pattern.
- **Impact:** The primary path of `findSlugByOriginalId` (`originalIdToSlug.has(staleId)`) will never match because `_exportedId` was never set in the exported JSON. The function falls through to fallback paths: (1) single-index assumption, (2) name-matching heuristic, (3) null with warning.
- **Assessment:** The fallbacks are reasonable for the common case (most projects have one or few indexes), but the plan should acknowledge that the primary lookup path requires an **export-side enhancement** (adding `_exportedId` to assembler output) or that the fallback-first behavior is intentional. Without this note, an implementer may assume `_exportedId` already exists and skip testing the fallback paths.
- **Severity: Minor.** The fallback heuristics cover the typical case. The plan already has a Future Enhancement note (Section 3.15, item 3) about nesting sources under index directories as an alternative. But the gap between the algorithm's stated primary path and reality should be documented.

### [R3-2] Round 2 Performance review cross-ref count is now stale -- INFORMATIONAL

- The Round 2 Performance review (`round-2-performance.md`, line 79) states "Total: 12 round trips" and its summary table (line 181) shows "5 anchor queries + 7 bulkWrite = 12 round trips."
- After the `[R2 Fix: NEW-3]` update, Section 3 now states 10 queries + 7-8 bulkWrites = ~18-20 round trips.
- The performance review was written against the pre-fix version. This is expected since reviews are point-in-time artifacts, but if someone reads both reviews alongside the updated plan, the numbers disagree.
- **Severity: Informational.** No action required unless the performance review is updated for Round 3.

---

## Sections 04 and 05 Skim

### Section 04 (Security & Validation)

- The `[R2 Fix]` at line 390 adds a `suggestedMatch` field for auth profile resolution with a 0.7 score threshold. The comment clarifies this is a suggestion shown in the UI, not auto-applied. This is a reasonable UX improvement.
- No new cross-cutting issues identified. The two-phase security pipeline remains well-structured.
- The prerequisite validator still iterates `manifest.metadata.required_env_vars` without noting the v1 migration edge case (INC-5 from Round 2). Remains informational.

### Section 05 (Performance & Queueing)

- `ImportOperationStateV2.expiresAt` TTL of 1 hour remains unchanged (NEW-5 from Round 2). Remains a recommended-but-not-blocking item.
- The `PHASE_WEIGHTS` code (lines 565-574) still uses the 5/60/30/5 distribution. MIN-4 persists.
- No new issues identified in the BullMQ job design, rate limiting, or observability sections.

---

## Verdict

**PASS**

All three Round 2 must-fix items are resolved:

1. **[NEW-1]** Cross-ref field names are now consistent end-to-end between disassemblers, CROSS_REF_RULES registry, and resolver pseudocode.
2. **[NEW-3]** The resolver data source (MongoDB re-query) is explicit, and the round-trip count (~18-20) is accurate and consistent between Section 1 and Section 3.
3. **[NEW-2]** The profiles/locales Phase 1 limitation is clearly documented with user-facing warning requirement.

**Remaining items (none blocking):**

| ID    | Summary                                           | Severity      | Action                           |
| ----- | ------------------------------------------------- | ------------- | -------------------------------- |
| R3-1  | `_exportedId` not in current export code          | Minor         | Document in implementation notes |
| MIN-4 | Progress weight distributions differ (Sec 1 vs 5) | Minor         | Pick one, update the other       |
| MIN-5 | `ImportPhaseV2` is new type, not noted            | Minor         | Add one-line note                |
| INC-5 | v1-migrated imports skip env var checks           | Informational | Optional documentation           |
| NEW-5 | 1-hour TTL vs 24-hour BullMQ retention mismatch   | Minor         | Align or document rationale      |
| R3-2  | Perf review cross-ref count stale after R2 fix    | Informational | No action needed                 |

The plan is ready for implementation.
