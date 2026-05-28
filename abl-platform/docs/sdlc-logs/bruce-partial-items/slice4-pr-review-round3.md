# Slice 4 PR Review — Round 3: Integration, Observability, Backward Compat

**Commit:** `fc4374f84` on `develop`
**Reviewer:** PR Reviewer Agent (Round 3 of 5)
**Focus:** Integration contracts, observability gaps, backward compatibility
**Date:** 2026-04-18

---

## VERDICT: REQUEST CHANGES

**1 CRITICAL, 2 HIGH, 2 MEDIUM findings. 2 countered.**

---

## Analyze-Counter-Fix Audit Trail

| #   | Finding                                                                                | Severity | Action    | Evidence     |
| --- | -------------------------------------------------------------------------------------- | -------- | --------- | ------------ |
| 1   | Version snapshot drops `memory` field — settings silently reset on promote             | CRITICAL | CONFIRMED | See F1 below |
| 2   | `memory_dedup_skipped` event not in trace registry, EVENT_VERBOSITY, or Studio mapping | HIGH     | CONFIRMED | See F2 below |
| 3   | `memory_remember` aggregate not emitted when all ops deduped                           | HIGH     | CONFIRMED | See F3 below |
| 4   | Studio AdvancedSettingsTab does not round-trip `memory` field on save                  | MEDIUM   | CONFIRMED | See F4 below |
| 5   | GET/PUT round-trip lossy for `memory` via Studio save                                  | MEDIUM   | COUNTERED | See F5 below |
| 6   | Preference detection bypass of dedup                                                   | N/A      | COUNTERED | See F6 below |
| 7   | Existing REMEMBER regression tests still pass                                          | N/A      | COUNTERED | See F7 below |

---

## F1 — CRITICAL: Version snapshot drops `memory` field

**Step 1: ANALYZE**

`settings-version-service.ts` lines 107-125 build the snapshot `settings` object from the working copy. The constructed object contains only:

- `enableThinking`
- `thinkingBudget`
- `thoughtDescription`
- `promptOverrides` (conditional)

The `memory` field from the working copy is NOT read, NOT included in the snapshot.

`project-settings-version.model.ts` lines 14-20 — `IProjectSettingsVersionSettings` interface does NOT include `memory`. The Mongoose schema (lines 52-60) also lacks a `memory` sub-field.

`project-settings-repo.ts` lines 90-100 — `createSettingsVersion` typed `settings` parameter also omits `memory`.

**Step 2: CONFIRM**

This is a confirmed data loss bug. The chain:

1. Admin sets `memory.dedupMaxDepth = 4` on working copy via PUT
2. Admin creates version via POST /versions
3. `settings-version-service.createVersion()` reads working copy but does NOT capture `memory`
4. Version record has `settings: { enableThinking, thinkingBudget, ... }` — no `memory`
5. The `sourceHash` is computed WITHOUT `memory`, so two working copies with different `dedupMaxDepth` but same thinking config produce identical hashes — version dedup would incorrectly skip
6. If any future "restore from version" or "promote applies settings" feature is built, the memory config is permanently lost

Additionally, the model schema `IProjectSettingsVersionSettings` at line 14 lacks both `memory` and `compactionThreshold` (which IS in the schema at line 18 but is NOT captured by the service at lines 113-125 — a pre-existing bug for `compactionThreshold` too, but that's out of scope for this review).

**Impact:** Silent data loss. A project that configures `dedupMaxDepth`, snapshots, and later tries to restore from that snapshot will lose the memory configuration. The sourceHash also doesn't incorporate memory settings, meaning hash-based dedup across versions is incorrect.

**Files:**

- `apps/runtime/src/services/settings-version-service.ts:107-125` — snapshot builder omits `memory`
- `packages/database/src/models/project-settings-version.model.ts:14-20` — interface omits `memory`
- `apps/runtime/src/repos/project-settings-repo.ts:90-100` — repo function type omits `memory`

**Fix required (3 locations):**

1. Add `memory?: IProjectMemorySettings | null` to `IProjectSettingsVersionSettings`
2. Add `memory` field to the version schema subdocument
3. In `createVersion()`, read `workingCopy?.memory` and include it in the `settings` object and hash computation
4. Add `memory` to the `createSettingsVersion` repo function's `settings` type

---

## F2 — HIGH: `memory_dedup_skipped` not registered in trace infrastructure

**Step 1: ANALYZE**

`memory-integration.ts:328` emits `type: 'memory_dedup_skipped'` via `onTraceEvent`.

Checked all three registration points:

- `packages/shared-kernel/src/constants/trace-event-registry.ts` — `RUNTIME_EVENT_TYPES` array: NO entry for `memory_dedup_skipped`
- `apps/runtime/src/services/execution/trace-helpers.ts` — `EVENT_VERBOSITY` map: NO entry for `memory_dedup_skipped`
- `apps/studio/src/components/observatory/interactions/constants.ts` — `EVENT_TO_STEP`, `EVENT_LABELS`: NO entries

**Step 2: CONFIRM**

This is a real gap. The event IS emitted at runtime but:

1. Without `EVENT_VERBOSITY` entry, the event's verbosity level is undefined — it will be emitted at all trace levels (no filtering). This is actually OK because the code emits it directly via `onTraceEvent` (not through `emitDecisionTrace`), but it's inconsistent with the platform's tracing contract.
2. Without `RUNTIME_EVENT_TYPES` registration, the contract test doesn't catch the gap. The test only validates registered events have Studio coverage — it doesn't scan runtime code for un-registered emissions.
3. Studio observatory will display the raw event type string instead of a human-readable label, and it won't map to a step type, so it may be rendered as "unknown" or silently dropped from the interactions timeline.

**Impact:** Operators using the observatory to debug REMEMBER behavior will not see dedup skip events rendered correctly in the Studio interactions panel. They may appear as unlabeled raw events or be invisible entirely.

**Fix required (3 locations):**

1. Add `'memory_dedup_skipped'` to `RUNTIME_EVENT_TYPES` in trace-event-registry.ts
2. Add `memory_dedup_skipped: 1` to `EVENT_VERBOSITY` in trace-helpers.ts (same level as `memory_remember`)
3. Add `memory_dedup_skipped: 'memory_diff'` to `EVENT_TO_STEP` and `memory_dedup_skipped: 'Memory Write Skipped (Dedup)'` to `EVENT_LABELS` in Studio constants
4. Update the contract test's `MAPPED_EVENTS` and `EVENT_VERBOSITY_KEYS` sets

---

## F3 — HIGH: `memory_remember` aggregate not emitted when all ops deduped

**Step 1: ANALYZE**

`memory-integration.ts:358-374`:

```typescript
if (toWrite.length > 0) {
  for (const entry of toWrite) {
    emitDecisionTrace(session, onTraceEvent, {
      type: 'memory_trigger_evaluated',
      ...
    });
  }
  onTraceEvent?.({
    type: 'memory_remember',
    data: { stored: toWrite.map((e) => e.op.key) },
  });
}
```

When ALL operations are deduped (`toWrite.length === 0`), neither `memory_trigger_evaluated` NOR `memory_remember` is emitted. Only `memory_dedup_skipped` events fire (one per skipped op).

**Step 2: CONFIRM**

Before this change, if triggers matched, `memory_remember` was always emitted with the stored keys. Consumers (dashboards, analytics, alerting rules) that count `memory_remember` events per session will see a DROP in count when dedup kicks in — this looks identical to "REMEMBER triggers stopped firing" from a monitoring perspective.

There is no aggregate "evaluation complete" event that signals "N triggers matched, M written, K skipped." Consumers must now aggregate `memory_dedup_skipped` + `memory_remember` to reconstruct the pre-change count.

**Impact:** Monitoring regression. If an operator has a dashboard counting `memory_remember` events per session, the rate will drop (potentially to zero for steady-state sessions) after this change deploys. This could trigger false alerts.

**Fix options (pick one):**

- **Option A (preferred):** Always emit `memory_remember` when triggers match (even if all skipped), with `data: { stored: [...], skipped: [...] }` so consumers can see the full picture
- **Option B:** Add an explicit `memory_dedup_summary` aggregate event: `{ matched: N, written: M, skipped: K }`
- **Option C:** Document the semantic change and update any known dashboards

---

## F4 — MEDIUM: Studio AdvancedSettingsTab does not surface `memory` field

**Step 1: ANALYZE**

`apps/studio/src/components/settings/AdvancedSettingsTab.tsx:199-243` — the `handleSave` function constructs the PUT body with `enableThinking`, `thinkingBudget`, `thoughtDescription`, and `promptOverrides`. It does NOT include `memory`.

The GET response includes `memory: doc?.memory ?? null` (route line 124), but the AdvancedSettingsTab does not read or display this field.

**Step 2: CONFIRM**

The `memory` field is not surfaced in any Studio settings tab (confirmed via grep — zero hits for "memory", "dedup", "MemorySettings" in `apps/studio/src/components/settings/`).

**Impact:** Operators cannot configure `dedupMaxDepth` through the Studio UI. The only way to set it is via direct API call to the runtime PUT endpoint. This is acceptable for an initial rollout (API-first), but should be documented. The bigger concern is that the AdvancedSettingsTab save does NOT pass `memory` through, but since it also doesn't pass `traceDimensions`, `agentTransfer`, or `sessionLifecycle`, and the PUT uses partial update semantics (`$set` only for defined keys), omitting `memory` from the body means it won't be overwritten. The working copy's `memory` field is preserved.

Downgrading this from HIGH to MEDIUM because the partial update semantics prevent data loss.

---

## F5 — COUNTERED: GET/PUT round-trip lossy for `memory` via Studio

**Step 1: ANALYZE**

Studio route at `apps/studio/src/app/api/projects/[id]/settings/route.ts` is a transparent proxy — passes the full request body to runtime. The runtime PUT handler uses partial `$set` semantics in the repo (`upsertProjectSettings` at lines 37-49).

**Step 2: COUNTER**

The `upsertProjectSettings` repo function only `$set`s fields that are explicitly `!== undefined` in the input. If Studio's PUT body omits `memory`, the repo won't touch `memory` in the database — it's preserved. This is safe. If a future Studio UI sends `memory`, it will be properly saved. The GET endpoint correctly returns `memory: doc?.memory ?? null`.

No data loss on round-trip.

---

## F6 — COUNTERED: Preference detection bypass of dedup

**Step 1: ANALYZE**

`memory-integration.ts:570` — `detectAndStorePreferences` calls `factStore.set` directly without using the dedup `filterUnchangedOperations`.

**Step 2: COUNTER**

Lines 614-615: `if (!existingValues.includes(pref.value))` — preferences have their OWN dedup logic: they check if the preference value is already in the existing array before appending. This is semantically correct for array-append operations (preferences accumulate, they don't overwrite). The REMEMBER dedup is for key-value overwrites. These are different operations with different dedup semantics. No issue.

---

## F7 — COUNTERED: Existing REMEMBER regression tests

**Step 1: ANALYZE**

Ran `flow-set-remember-regressions.test.ts` and `flow-intents-digressions.test.ts` — 19 tests, all pass (74.42s duration).

**Step 2: COUNTER**

These tests exercise the REMEMBER execution path including FactStore writes. They pass because:

- Cold-start (first turn): all values go to `toWrite` (no current values in FactStore)
- The tests don't test second-turn dedup (they test single-turn REMEMBER semantics)
- The dedup logic is additive (new code path, doesn't change first-turn behavior)

The tests validate that existing REMEMBER behavior is not regressed by the dedup introduction. The dedup-specific behavior is covered by `remember-dedup-trace-emission.test.ts` (2 tests, passing).

---

## Additional Observations

### Item 8: Cold start / first turn behavior

Verified in `memory-dedup.ts:116` — `if (!currentValues.has(op.key))` pushes to `toWrite`. First turn with empty FactStore means all ops write. Second turn with same values means all ops skip. This is the correct "cold start then steady state" pattern.

### Item 9: Preference detection interaction

Countered above (F6). No regression.

### Item 10: Trace emission semantic change

The `memory_trigger_evaluated` event was previously emitted for every REMEMBER trigger that matched a condition. Now it's only emitted for writes (line 360-369). Skipped ops get `memory_dedup_skipped` instead. Consumers counting "triggers evaluated" now need to count both event types. This is covered by F2 and F3 above.

### Item 12: Release readiness / rollback

This ships without a feature flag. Rollback plan: revert the commit. The dedup is pure application logic with no schema migration or persistent state change (no new DB fields on the fact store, just fewer writes). Reverting restores pre-change write behavior. The `ProjectSettings.memory.dedupMaxDepth` field in MongoDB is harmless if the reading code is reverted (it's just ignored — the resolver falls back to default).

### Pre-existing: `compactionThreshold` also missing from version snapshots

While investigating F1, I noted that `compactionThreshold` is defined in `IProjectSettingsVersionSettings` (line 18) and the schema (line 58), but `settings-version-service.ts:createVersion()` does NOT read it from the working copy or include it in the snapshot. This is a pre-existing bug from before this commit — not caused by slice 4 — but worth noting.

### Pre-existing: `traceDimensions`, `sessionLifecycle`, `agentTransfer` also missing from versions

The version model only stores thinking config + promptOverrides. None of the other working-copy fields (`traceDimensions`, `sessionLifecycle`, `agentTransfer`, `memory`) are captured. This is a systematic gap in the version snapshot feature. The `memory` omission is NEW with this commit and must be fixed; the others are pre-existing.

---

## Summary of Required Fixes

### CRITICAL (commit blocker)

1. **F1 — Version snapshot must include `memory` field.** Three files need updates:
   - `packages/database/src/models/project-settings-version.model.ts` — add `memory` to interface + schema
   - `apps/runtime/src/services/settings-version-service.ts:107-125` — read `workingCopy?.memory`, include in `settings` object and hash
   - `apps/runtime/src/repos/project-settings-repo.ts:90-100` — add `memory` to `createSettingsVersion` settings type

### HIGH (should fix before merge)

2. **F2 — Register `memory_dedup_skipped` in trace infrastructure.** Four files:
   - `packages/shared-kernel/src/constants/trace-event-registry.ts` — add to `RUNTIME_EVENT_TYPES`
   - `apps/runtime/src/services/execution/trace-helpers.ts` — add to `EVENT_VERBOSITY`
   - `apps/studio/src/components/observatory/interactions/constants.ts` — add to `EVENT_TO_STEP` + `EVENT_LABELS`
   - `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` — update `MAPPED_EVENTS` + `EVENT_VERBOSITY_KEYS`

3. **F3 — Emit aggregate event when all ops deduped.** One file:
   - `apps/runtime/src/services/execution/memory-integration.ts:358-374` — emit `memory_remember` (or a summary event) even when `toWrite.length === 0` but triggers matched

### MEDIUM (fix or document)

4. **F4 — Document that `memory.dedupMaxDepth` is API-only.** No Studio UI exists. Either add a UI field in a follow-up or document in release notes that configuration requires direct API call.
