# Data-Flow & Dependency-Wiring Audit: Experiments V2 — Deployment-Based Assignment

**Date**: 2026-04-29
**Auditor**: Claude (automated)
**Round**: 1
**Plan**: `docs/plans/2026-04-29-experiments-v2-deployment-based-impl-plan.md`
**Prior implementation**: `docs/sdlc-logs/experiments/05-implementation.log.md`

---

## Sensitive Values Audited

- **Experiment assignment group** (`control | experiment`) — DATA CLASS: BUSINESS
- **contactId / assignmentKey** — DATA CLASS: PII (used as stickiness hash input)
- **CachedExperiment** (Redis-serialized experiment config) — DATA CLASS: INTERNAL
- **Deployment IR content** (AgentIR loaded via `controlDeploymentId`/`experimentDeploymentId`) — DATA CLASS: INTERNAL

---

## Round 1: Path Trace Findings

---

### VALUE: Experiment Assignment Group

```
VALUE: experiment group assignment ('control' | 'experiment')
  DATA CLASS: BUSINESS
  APPROVED CONSUMERS: DB session, ClickHouse experiment_assignments, runtime session (in-memory)

  1. Source:
     session-factory.ts:387 (tryAssignExperimentPreSession) — derived from FNV-1a hash
     Entry type: computed from contactId ∥ sessionId
     Validation: assignExperimentGroup() returns 'control'|'experiment' strictly

  2. Writes:
     - runtimeSession.experimentGroup (in-memory) — session-factory.ts:176, 292
     - DB session via updateDbSession() — session-factory.ts:521-528 (fire-and-forget)
     - DB session via updateDbSessionFields() — sdk-handler.ts:1021 (duplicate path)
     - DB session via DBSessionCreationContext — twilio-media-handler.ts:221
     - ClickHouse experiment_assignments.experiment_group — write-experiment-assignment.ts:53

  3. Serialization:
     - Redis: JSON.stringify(CachedExperiment) — experiment.service.ts:86 — experiment CONFIG only,
       not the session assignment
     - ClickHouse HTTP insert — write-experiment-assignment.ts:58 — fire-and-forget
     - Runtime→SDK WebSocket: runtimeSession.experimentGroup used in session state

  4. Read Paths:
     - DB session lookup: experiment-service-singleton.ts:48-58 — reads experimentId/experimentGroup
       for A2A parent inheritance — scoped to {_id, tenantId, projectId} ✓
     - experiments.ts results route: reads ClickHouse directly — scoped to {tenantId, projectId} ✓
     - sdk-handler.ts:1018 — reads from runtimeSession — correct scope (session-owned) ✓

  5. Policy Boundary:
     - DB session read is scoped to tenantId+projectId — correct ✓
     - ClickHouse query includes tenantId — correct ✓
     - No raw assignment group leaks to LLM context (group is not in prompt/history) ✓

  6. Consumers/Sinks:
     - Results dashboard (internal to tenant/project) — correctly scoped ✓
     - ClickHouse analytics — tenant-scoped writes ✓
     - No external API or LLM consumption of group label ✓

  7. Wiring (V2-specific):
     DEPENDENCY: CachedExperiment.assignmentMode
       Constructed at: experiment.service.ts:74-82 (getActiveExperiment projection)
       Consumer: session-factory.ts:tryAssignExperimentPreSession — WIRED ✗ (NOT in projection)
       See F-1.

     DEPENDENCY: resolveExperimentDeployment()
       Constructed at: DOES NOT EXIST YET (Phase 3 task)
       Consumer: session-factory.ts:tryAssignExperimentPreSession — NOT WIRED YET (by design, Phase 3)
       Null-handling: falls through to version-mode path — silently wrong behavior (see F-5)

  8. Parallel Paths:
     PATH A: Tier 1 (deploymentId/environment) — session-factory.ts:144
     PATH B: Tier 2 (multi-DSL compile) — session-factory.ts:261
     PATH C: Twilio voice — twilio-media-handler.ts:220
     All three call tryAssignExperimentPreSession ✓ (Tier 1 and Tier 2 via createRuntimeSession,
     Twilio via runtimeSession post-creation)
     PATH D: assign-experiment.ts:assignExperimentToSession — DEAD CODE (never called from
     production path, only in dist type exports) — see F-3

  9. Boundary Tests:
     - [ ] Test verifying Tier 1 and Tier 2 both fire deployment-mode override correctly
     - [ ] Test verifying Redis cache round-trip preserves assignmentMode field
     - [ ] Test verifying ClickHouse write includes assignment_mode column
```

---

### VALUE: contactId / assignmentKey (PII)

```
VALUE: contactId (used as assignment stickiness key)
  DATA CLASS: PII
  APPROVED CONSUMERS: hash input only — NEVER stored as assignment key

  1. Source:
     session-factory.ts:375 — ctx.callerContext?.contactId ?? null
     Also: assign-experiment.ts:51 — runtimeSession.callerContext?.contactId
     Entry type: session creation context (HTTP body / WebSocket frame)

  2. Writes:
     - contactId is NOT written to ClickHouse experiment_assignments — correct ✓
     - contactId is NOT written to Redis experiment cache — correct ✓
     - assignmentKey (contactId ∥ sessionId) is logged truncated:
       session-factory.ts (no explicit log of assignmentKey) — no log in tryAssignExperimentPreSession
       assign-experiment.ts:168 — assignmentKey.slice(0,8) + '...' — truncated ✓

  3. Serialization:
     - contactId is hashed via FNV-1a before any use — getAssignmentKey() returns raw string
       then assignExperimentGroup() applies the hash — raw key not serialized to any boundary ✓

  4. Read Paths:
     - Only used in-memory for hash computation
     - Not projected from DB or persisted in experiment context ✓

  5. Policy Boundary:
     - contactId never crosses PII boundary in experiment assignment path ✓

  6. Consumers/Sinks:
     - Hash computation only — FNV-1a (one-way, no extraction) ✓

  7. Wiring: N/A (no new V2 changes to this path)

  8. Parallel Paths:
     - Tier 1/Tier 2 both read contactId from ctx.callerContext — consistent ✓

  9. Boundary Tests:
     - [ ] Verify ClickHouse experiment_assignments row does not contain contactId column ✓ (already correct)
```

---

### VALUE: CachedExperiment (Redis-serialized experiment config)

```
VALUE: CachedExperiment (Redis JSON blob)
  DATA CLASS: INTERNAL
  KEY: experiment:active:{tenantId}:{projectId}
  TTL: 300 seconds

  1. Source:
     experiment.service.ts:64-82 — MongoDB ExperimentModel.findOne() with projection

  2. Writes:
     Redis SET with EX 300 — experiment.service.ts:84-89
     Value: JSON.stringify(CachedExperiment) or literal 'null'
     Key includes tenantId — correctly isolated ✓

  3. Serialization:
     JSON.stringify / JSON.parse — experiment.service.ts:60, 86

  4. Read Paths:
     - Redis GET on cache hit — experiment.service.ts:58-61
     - Returned to tryAssignExperimentPreSession in session-factory.ts
     - Type-asserted as CachedExperiment on cache hit (line 60)

  5. Policy Boundary:
     - Only consumed by session assignment (session-factory) — internal ✓
     - Not forwarded to LLM, Studio API, or external consumers ✓

  6. Dependency Wiring (V2):
     DEPENDENCY: assignmentMode, controlDeploymentId, experimentDeploymentId fields
       Constructed at: experiment.service.ts:74-82 (getActiveExperiment)
       Current projection: { _id:1, controlVersion:1, experimentVersion:1, trafficSplit:1, channels:1 }
       Missing: assignmentMode, controlDeploymentId, experimentDeploymentId
       Consumer: session-factory.ts:tryAssignExperimentPreSession — RECEIVES INCOMPLETE VALUE ✗
       See F-1.

  7. Parallel Paths:
     - Cache value JSON round-trip: JSON.stringify on write, JSON.parse on read
       New fields added to CachedExperiment interface MUST be present in the DB projection
       or they will be undefined after the first cache miss, then cached as undefined (persisted
       as JSON null), then read back as null — silently wrong for all 300s TTL window ✓ F-1

  8. Boundary Tests:
     - [ ] Cache round-trip test: write CachedExperiment with assignmentMode='deployment',
       controlDeploymentId, experimentDeploymentId → read back → verify all 3 fields preserved
```

---

## Findings Summary

| ID  | Severity | Dimension        | Finding                                                                                                                                                                                             |
| --- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | HIGH     | Wiring + Writes  | `getActiveExperiment()` projection omits `assignmentMode`, `controlDeploymentId`, `experimentDeploymentId` — deployment-mode branch in `tryAssignExperimentPreSession` can never fire               |
| F-2 | HIGH     | Parallel Paths   | `tryAssignExperimentPreSession` (line 394) reads `experiment.controlVersion`/`experimentVersion` which are `undefined` in deployment mode — `agentVersionId` silently `undefined`                   |
| F-3 | HIGH     | Wiring           | `assign-experiment.ts:assignExperimentToSession()` is exported but never called — dead parallel implementation with A2A inheritance logic absent from the active path                               |
| F-4 | HIGH     | Writes           | `writeExperimentAssignment` / `ExperimentAssignmentData` missing `assignment_mode` + `deployment_id` — DDL adds columns in Phase 1 but writer never populates them                                  |
| F-5 | HIGH     | Policy Boundary  | Plan Phase 3.2 silently falls back to control IR when `resolveExperimentDeployment()` returns null — session gets control IR while `experimentGroup='experiment'` is persisted to DB and ClickHouse |
| F-6 | MEDIUM   | Parallel Paths   | Two separate ClickHouse write paths: `fireExperimentClickHouseWrite` (session-factory) and inline write (assign-experiment.ts) — if one is updated for V2 fields and the other isn't, divergence    |
| F-7 | MEDIUM   | Writes           | `agentVersionId` in `ExperimentAssignmentResult` undefined in deployment mode — plan acknowledges the field but specifies no strategy to populate it from resolved deployment's entry agent         |
| F-8 | MEDIUM   | Regression Tests | Plan Phase 5 tests don't cover Tier 1 (deploymentId) vs Tier 2 (multi-DSL compile) separately — both call `tryAssignExperimentPreSession` but with different `resolved` objects                     |

---

## Detailed Findings

---

### FINDING: F-1

```
FINDING: F-1
  SEVERITY: HIGH
  DIMENSION: 7 — Dependency Wiring
  PATH: ExperimentModel (DB) → getActiveExperiment() → CachedExperiment → Redis →
        tryAssignExperimentPreSession → assignmentMode check → resolveExperimentDeployment()
  EVIDENCE:
    experiment.service.ts:64-82 — projection is:
      { _id:1, controlVersion:1, experimentVersion:1, trafficSplit:1, channels:1 }
    CachedExperiment construction at line 74-82 maps only these 5 fields.
    Plan Phase 3.2 adds: if (experiment.assignmentMode === 'deployment') { ... }
    If assignmentMode is undefined (missing from projection), this branch NEVER fires.
    All deployment-mode experiments silently execute as version-mode with undefined version strings.
  IMPACT:
    Phase 2 (create deployment-mode experiment) completes correctly.
    Phase 3 (assignment) silently uses version-mode path with undefined controlVersion/experimentVersion.
    overrideResolvedAgentWithExperimentVersion() is called with undefined version string → returns false.
    Session gets the deployment's default IR, no override. Assignment is recorded but has no effect.
    No error is raised — the bug is completely silent.
  FIX:
    experiment.service.ts:66 — extend projection:
      { _id:1, assignmentMode:1, controlVersion:1, experimentVersion:1,
        controlDeploymentId:1, experimentDeploymentId:1, trafficSplit:1, channels:1 }
    experiment.service.ts:74-82 — extend CachedExperiment construction:
      assignmentMode: doc.assignmentMode ?? 'version',
      controlDeploymentId: doc.controlDeploymentId ? String(doc.controlDeploymentId) : undefined,
      experimentDeploymentId: doc.experimentDeploymentId ? String(doc.experimentDeploymentId) : undefined,
  TEST:
    Integration test: create deployment-mode experiment via API → start → call getActiveExperiment()
    directly → assert returned CachedExperiment has assignmentMode='deployment' and
    controlDeploymentId/experimentDeploymentId populated (not undefined).
```

---

### FINDING: F-2

```
FINDING: F-2
  SEVERITY: HIGH
  DIMENSION: 8 — Parallel Paths (version-mode path reused in deployment mode)
  PATH: tryAssignExperimentPreSession → agentVersionId assignment (line 393-394) →
        ClickHouse write (agentVersionId field) + ExperimentAssignmentResult.agentVersionId
  EVIDENCE:
    session-factory.ts:393-394:
      const agentVersionId =
        group === 'experiment' ? experiment.experimentVersion : experiment.controlVersion;
    In deployment mode, experiment.experimentVersion and experiment.controlVersion are both undefined
    (only controlDeploymentId/experimentDeploymentId are set).
    agentVersionId = undefined.
    This undefined flows into:
      1. ExperimentAssignmentResult.agentVersionId = undefined
      2. fireExperimentClickHouseWrite({ ..., agentVersionId }) → agent_version_id column = ''
    Additionally, line 405-411 only applies version override for group='experiment':
      if (group === 'experiment') await overrideResolvedAgentWithExperimentVersion(resolved, undefined, ...)
    overrideResolvedAgentWithExperimentVersion() with undefined version string:
      resolve-experiment-version.ts:28 signature is overrideResolvedAgentWithExperimentVersion(
        resolved, experimentVersionString: string, ...)
      TypeScript would catch this — but only if strict null checks catch the undefined→string gap.
  IMPACT:
    Control-group sessions in deployment mode: no override applied → correct (control IR unchanged) ✓
    Experiment-group sessions: overrideResolvedAgentWithExperimentVersion called with undefined →
      AgentVersion.findOne({ agentId, version: undefined }) → no document found → override returns false →
      session gets control IR while labeled 'experiment' group → silent incorrect behavior.
    ClickHouse agent_version_id = '' for all deployment-mode assignments.
  FIX:
    Replace the agentVersionId block with deployment-mode awareness:
      const agentVersionId = experiment.assignmentMode === 'deployment'
        ? ''   // populated later with entry agent version after deployment resolution
        : (group === 'experiment' ? experiment.experimentVersion! : experiment.controlVersion!);
    Then after resolveExperimentDeployment() completes:
      resolved.versionInfo.rawVersions?.[resolved.entryAgent] ?? ''
    Populate agentVersionId from the resolved deployment's entry agent version.
    The version-mode override block (lines 405-411) must be guarded:
      if (experiment.assignmentMode !== 'deployment' && group === 'experiment') { ... }
  TEST:
    Integration test: start deployment-mode experiment → create session for 'experiment' group →
    assert resolved agent has experiment deployment's IR (not control's) → assert agentVersionId
    in ClickHouse write is not 'undefined'.
```

---

### FINDING: F-3

```
FINDING: F-3
  SEVERITY: HIGH
  DIMENSION: 7 — Dependency Wiring
  PATH: assign-experiment.ts:assignExperimentToSession() — never called in production path
  EVIDENCE:
    grep results show assignExperimentToSession has exactly two references outside tests:
      1. assign-experiment.ts:72 — definition
      2. apps/runtime/dist/... — compiled output
    session-factory.ts imports only: import type { ExperimentAssignmentResult } from '...assign-experiment.js'
    (import type — type-only, not the function)
    The active assignment path is tryAssignExperimentPreSession() in session-factory.ts:335.
    assign-experiment.ts:assignExperimentToSession() is dead code that includes:
      - A2A child inheritance via getParentExperimentGroup() (lines 104-136)
      - parentSessionId parameter
      - ClickHouse write with chClient injection
    None of this A2A inheritance logic exists in tryAssignExperimentPreSession.
  IMPACT:
    Short-term: no functional impact (function is not called).
    V2 impact: plan Phase 3 adds deployment-mode logic ONLY to session-factory.ts. Dead code in
    assign-experiment.ts diverges further. If any future change wires assign-experiment.ts, it would
    run stale version-mode logic against deployment-mode experiments.
    Additionally, the A2A inheritance handling in the dead code path is ABSENT from the active path
    (tryAssignExperimentPreSession always passes parentId: null). D-11 states "A2A child sessions
    inherit parent group via createBaseChildSession spread" — this is correct, but it means
    experiment group is inherited at the runtime session layer (in-memory spread), NOT via DB lookup.
    The DB-level inheritance in assign-experiment.ts is unreachable and misleading.
  FIX:
    Either:
    A. Delete assign-experiment.ts (preferred) — it is entirely superseded by session-factory.ts logic.
       Remove the export and update any type imports to use session-factory.ts types directly.
    B. Wire it: if assign-experiment.ts is intended as the future path, wire it into session-factory.ts
       and delete tryAssignExperimentPreSession.
    V2 plan must explicitly choose A or B and update accordingly.
  TEST:
    grep -r "assignExperimentToSession" --include="*.ts" after deletion should return 0 results.
```

---

### FINDING: F-4

```
FINDING: F-4
  SEVERITY: HIGH
  DIMENSION: 2 — Writes
  PATH: Phase 1 DDL adds columns → Phase 3 writer update → ClickHouse insert
  EVIDENCE:
    init-experiment-tables.ts:28-46 — current DDL does NOT have assignment_mode or deployment_id.
    Plan Phase 1.5 adds these columns.
    write-experiment-assignment.ts:22-30 — ExperimentAssignmentData interface does NOT have these fields.
    write-experiment-assignment.ts:48-56 — row object does NOT include these columns.
    Plan Phase 3.5 says "Extend payload to include new columns".
    Gap: between Phase 1 (DDL updated) and Phase 3 (writer updated), ClickHouse has new columns
    but inserts never populate them — they silently use DDL DEFAULT values.
    This is safe during the gap (defaults cover the missing values) but creates misleading analytics:
    all pre-Phase-3 deployment-mode assignments show assignment_mode='version' in ClickHouse.
    More critically: ExperimentAssignmentData interface must be updated in SAME commit as writer
    or TypeScript will not type-check the new fields.
  IMPACT:
    Analytics gap: assignment_mode column shows 'version' for all deployment-mode assignments
    written before Phase 3.5 commit.
    Deployment ID is not recorded — makes it impossible to audit which deployment sessions used.
  FIX:
    Update ExperimentAssignmentData interface and writeExperimentAssignment row construction in
    the SAME commit as the DDL addition (Phase 1 commit), not deferred to Phase 3:
      ExperimentAssignmentData:
        + assignmentMode: 'version' | 'deployment';
        + assignmentDeploymentId?: string;
      row:
        + assignment_mode: data.assignmentMode,
        + deployment_id: data.assignmentDeploymentId ?? '',
    This way, the ClickHouse write is correct from the first deployment.
  TEST:
    Unit test of writeExperimentAssignment: pass assignmentMode='deployment' + assignmentDeploymentId →
    assert chClient.insert was called with row containing assignment_mode='deployment'
    and deployment_id matching the passed value.
```

---

### FINDING: F-5

```
FINDING: F-5
  SEVERITY: HIGH
  DIMENSION: 5 — Policy Boundary
  PATH: resolveExperimentDeployment() returns null (error) →
        Object.assign(resolved, null-result) not called →
        session gets control IR while experimentGroup='experiment' persisted to DB + ClickHouse
  EVIDENCE:
    Plan Phase 3.1: resolveExperimentDeployment() returns null on failure.
    Plan Phase 3.2:
      if (experimentResolved) {
        Object.assign(resolved, experimentResolved);
      }
    When experimentResolved is null: resolved stays unchanged (control deployment IR).
    Assignment result is still returned from tryAssignExperimentPreSession:
      return { experimentId, experimentGroup: 'experiment', agentVersionId: ... }
    Caller (session-factory.ts:175-181) then:
      runtimeSession.experimentId = result.experimentId;
      runtimeSession.experimentGroup = 'experiment';  ← experiment group recorded
      fireExperimentClickHouseWrite(result, ...)      ← experiment group written to CH
    createAndLinkDBSession (via sdk-handler.ts:1021) persists experimentGroup='experiment'
    Session executes with CONTROL IR but is recorded as EXPERIMENT group in:
      - DB session document
      - ClickHouse experiment_assignments
      - Runtime session state
    This poisons the experiment results: session counted as experiment but used control behavior.
  IMPACT:
    Experiment results are incorrect for any session where resolveExperimentDeployment() fails.
    The failure mode is completely silent — no error surfaced, no fallback indicator.
    Guardrail analysis and statistical tests run on corrupted group memberships.
  FIX:
    When resolveExperimentDeployment() returns null in the experiment group case:
    EITHER return null from tryAssignExperimentPreSession (session gets no assignment):
      if (group === 'experiment' && experimentResolved === null) {
        log.warn('Deployment resolution failed for experiment group — skipping assignment', ...);
        return null;
      }
    OR record the fallback explicitly with a reason field so it can be filtered from results.
    The first option (skip assignment) is cleanest — consistent with the "non-blocking" design principle
    already in tryAssignExperimentPreSession (line 429-434: errors return null).
  TEST:
    Integration test: create deployment-mode experiment with a deployment that is deleted after
    experiment start → create session → assert session has NO experimentId/experimentGroup set
    (assignment skipped, not poisoned).
```

---

### FINDING: F-6

```
FINDING: F-6
  SEVERITY: MEDIUM
  DIMENSION: 8 — Parallel Paths (ClickHouse write implementations)
  PATH: session-factory.ts:fireExperimentClickHouseWrite() ← Tier1/Tier2 paths
        assign-experiment.ts:writeExperimentAssignment() inline ← dead code path
  EVIDENCE:
    session-factory.ts:442-480 — fireExperimentClickHouseWrite() dynamic-imports write-experiment-assignment.ts
    assign-experiment.ts:172-191 — calls writeExperimentAssignment() directly with chClient injection
    Both call the same underlying writeExperimentAssignment() function, so they're consistent today.
    BUT: session-factory.ts wraps in dynamic import chain with two .then() layers — if either
    resolves but then the write fails, only the inner .catch logs it. The outer dynamic import
    failure is also caught. This is OK but complex.
    assign-experiment.ts has cleaner DI (chClient passed as parameter) but is dead code.
  IMPACT:
    V2 Plan Phase 3.5 updates writeExperimentAssignment() — both call sites pick up the change ✓
    But if session-factory.ts ever inline-duplicates the write logic (rather than calling the
    shared function), the two paths diverge.
  FIX:
    After resolving F-3 (decide dead/live status of assign-experiment.ts):
    If deleting assign-experiment.ts: simplify fireExperimentClickHouseWrite to a direct
    import rather than double dynamic-import chain.
    If keeping: ensure both paths call writeExperimentAssignment() — no inline duplication.
```

---

### FINDING: F-7

```
FINDING: F-7
  SEVERITY: MEDIUM
  DIMENSION: 2 — Writes
  PATH: ExperimentAssignmentResult.agentVersionId → ClickHouse agent_version_id column
  EVIDENCE:
    Plan Key Interfaces section shows:
      agentVersionId: string;   // kept for ClickHouse write (entry agent version)
    In deployment mode, after resolveExperimentDeployment() replaces resolved:
      resolved.versionInfo.rawVersions[resolved.entryAgent] would contain the entry agent version.
    But plan Phase 3.2 doesn't specify how to populate agentVersionId from the resolved deployment.
    Current code: agentVersionId comes from experiment.controlVersion/experimentVersion (undefined in dep mode).
    Without an explicit extraction step, agentVersionId = undefined → '' in ClickHouse.
  IMPACT:
    ClickHouse agent_version_id column empty for all deployment-mode assignments.
    Cannot retrospectively trace which agent version was used for each session in analytics.
    This degrades experiment audit trail quality.
  FIX:
    After resolveExperimentDeployment() succeeds:
      const entryAgentVersion = experimentResolved.versionInfo.rawVersions?.[experimentResolved.entryAgent] ?? '';
      agentVersionId = entryAgentVersion;
    Add this extraction to Phase 3.2 implementation task.
```

---

### FINDING: F-8

```
FINDING: F-8
  SEVERITY: MEDIUM
  DIMENSION: 9 — Regression Tests
  PATH: Tier 1 (deploymentId path) vs Tier 2 (multi-DSL compile path) — deployment-mode override
  EVIDENCE:
    session-factory.ts:144 — Tier 1 calls tryAssignExperimentPreSession(ctx, resolved)
      where resolved comes from DeploymentResolver.resolve()
    session-factory.ts:261 — Tier 2 calls tryAssignExperimentPreSession(ctx, resolvedAgent)
      where resolvedAgent comes from compileToResolvedAgent()
    Plan Phase 5 test INT-11 tests lifecycle but doesn't specify which tier is exercised.
    Plan Phase 5 test INT-12 tests CachedExperiment shape but not the actual IR override.
    The two tiers produce different ResolvedAgent shapes:
      Tier 1: has compilationHash, moduleSnapshot, versionInfo.rawVersions
      Tier 2: compiled fresh, different hash, no moduleSnapshot
    resolveExperimentDeployment() in Tier 2 context would create a fresh resolve —
    the resulting Object.assign target is a compiled agent, not a deployment-resolved agent.
    Their schemas must be compatible for Object.assign to work correctly in both contexts.
  IMPACT:
    A test covering Tier 1 but not Tier 2 (or vice versa) would miss shape incompatibilities.
    In practice, Tier 2 (working-copy compilation) is used in Studio debug sessions, which are
    excluded from experiment assignment — so this may be a non-issue in practice.
    But channel sessions without a deploymentId that have an environment set go through Tier 2.
  FIX:
    Add explicit test: create session WITHOUT deploymentId but WITH environment →
    verify deployment-mode experiment override is applied correctly (or correctly skipped
    if Tier 2 sessions should be excluded from deployment-mode experiments).
    Document this explicitly in the plan — add a design decision:
      "D-25: Deployment-mode experiments require sessions to have a deploymentId.
       Tier 2 (compile path) sessions without a deploymentId cannot resolve experiment deployments
       and are excluded from deployment-mode assignment."
```

---

## Propagation Matrix

| Field                    | ExperimentModel (schema) | CachedExperiment (service) | Redis cache | tryAssignExperiment | ClickHouse write | DB session |
| ------------------------ | ------------------------ | -------------------------- | ----------- | ------------------- | ---------------- | ---------- |
| `assignmentMode`         | GAP (Phase 1 adds)       | GAP (F-1)                  | GAP (F-1)   | GAP (F-1, F-2)      | GAP (F-4)        | -          |
| `controlDeploymentId`    | GAP (Phase 1 adds)       | GAP (F-1)                  | GAP (F-1)   | GAP (F-1)           | GAP (F-4)        | -          |
| `experimentDeploymentId` | GAP (Phase 1 adds)       | GAP (F-1)                  | GAP (F-1)   | GAP (F-1)           | GAP (F-4)        | -          |
| `agentVersionId`         | -                        | -                          | -           | GAP (F-2, F-7)      | GAP (F-7)        | -          |
| `experimentGroup`        | Y                        | Y                          | Y           | Y                   | Y                | Y          |
| `experimentId`           | Y                        | Y                          | Y           | Y                   | Y                | Y          |
| `trafficSplit`           | Y                        | Y                          | Y           | Y                   | -                | -          |

---

## Round 2 Prerequisites

All HIGH findings (F-1 through F-5) must be fixed in the implementation plan before Phase 1 commit.

| Finding | Required Fix                                                                                              | Plan Phase to Update |
| ------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| F-1     | Update `getActiveExperiment` projection + construction                                                    | Phase 1.3            |
| F-2     | Guard version-mode override with `assignmentMode` check; populate agentVersionId from resolved deployment | Phase 3.2            |
| F-3     | Decide dead/live status of `assign-experiment.ts`; delete if dead                                         | New phase or Phase 3 |
| F-4     | Move ExperimentAssignmentData/writer update to Phase 1 (same commit as DDL)                               | Phase 1.5            |
| F-5     | Return null from tryAssignExperimentPreSession when experiment-group deployment resolution fails          | Phase 3.2            |

---

## Final Verdict (Round 1)

- [x] No CRITICAL findings
- [ ] HIGH findings remain open (F-1 through F-5) — plan must be updated before implementation
- [ ] Boundary tests not yet written
- [ ] Parallel path F-3 (dead code) not yet resolved
- [ ] Audit log Round 2 pending
