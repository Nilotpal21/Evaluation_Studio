# LLD: Experiments / A/B Testing — Implementation Plan

**Feature Spec**: `docs/features/experiments.md`
**HLD**: `docs/specs/experiments.hld.md`
**Test Spec**: `docs/testing/experiments.md`
**Status**: NEEDS_REVIEW
**Date**: 2026-03-23
**Last Updated**: 2026-04-28

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                        | Rationale                                                                                               | Alternatives Rejected                                                                                      |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-1  | Bottom-up implementation order                                  | Backend (model + assignment + routes) before frontend (Studio UI). Each phase is independently testable | Top-down (UI first) — blocked on missing backend                                                           |
| D-2  | Extend existing `ExperimentModel` in pipeline-engine            | Scaffolding exists with correct structure and tenant/project indexes                                    | New model in database package — would move ownership away from pipeline-engine where results service lives |
| D-3  | Extend existing `experiments.ts` routes in runtime              | Routes already exist with correct middleware chain (auth, project scope, rate limit)                    | New route file — duplicate, unnecessary                                                                    |
| D-4  | FNV-1a for group assignment hash                                | ~2ns, deterministic, excellent uniformity, zero dependencies                                            | SHA-256 (~50ns, overkill), Math.random (non-deterministic)                                                 |
| D-5  | Redis cache for active experiment per project                   | Avoids MongoDB query on every session creation; 5-minute TTL, invalidated on start/stop                 | No cache (MongoDB on every session), session-level cache (stale across sessions)                           |
| D-6  | Partial unique index for one-active-per-project                 | DB-level enforcement, atomic, no race conditions                                                        | Application-level check (race-prone)                                                                       |
| D-7  | Experiment fields on Session document (not separate collection) | Single document read for stickiness; no join needed                                                     | Separate `experiment_assignments` collection (extra lookup per request)                                    |
| D-8  | Cron-based results computation via Restate scheduled handler    | Pipeline-engine already uses Restate for workflow orchestration; cron utility exists                    | setInterval (not distributed), BullMQ (different queue system)                                             |
| D-9  | Sticky key = contactId ∥ sessionId                              | Public/channel sessions with contactId get cross-session consistency; fallback to sessionId             | sessionId-only (breaks stickiness when user starts a new session)                                          |
| D-10 | Studio debug sessions excluded from assignment                  | source.type='studio' sessions are project-owned test runs, not real user traffic                        | Inclusive (would pollute metrics with developer test sessions)                                             |
| D-11 | A2A child sessions inherit parent group                         | Preserves version consistency across agent handoffs; avoids split routing within one user journey       | Independent assignment (could route child to different version than parent, breaking context)              |
| D-12 | Channel scoping via `channels: string[]` on experiment          | Experiment owners may target specific channels (e.g., web only); empty = all channels                   | Separate per-channel experiments (over-complex for current use case)                                       |
| D-13 | Guardrail supports both absolute and relative-to-control modes  | Relative mode catches degradations regardless of baseline variance (e.g., traffic fluctuation)          | Absolute only (breaks for metrics with shifting baselines)                                                 |
| D-14 | Guardrail breach writes audit log entry                         | Guardrail-triggered auto-stops are significant operational events; must be auditable                    | No audit (silent stop is invisible to operators)                                                           |
| D-15 | Session erasure cascades to ClickHouse DELETE                   | Right-to-erasure requires purging session references from all stores                                    | Tombstone (complex in ClickHouse, inconsistent with platform erasure pattern)                              |

### Key Interfaces

```typescript
// === Assignment key selection ===
function getAssignmentKey(session: { contactId: string | null; _id: string }): string {
  return session.contactId ?? session._id;
}

// === Assignment function ===
function assignExperimentGroup(
  experimentId: string,
  assignmentKey: string, // contactId || sessionId
  trafficSplit: number,
): 'control' | 'experiment';

// === Session eligibility ===
interface SessionEligibilityResult {
  eligible: boolean;
  reason?: 'studio_session' | 'a2a_child' | 'channel_excluded';
  inheritedGroup?: 'control' | 'experiment'; // set for a2a_child
  inheritedExperimentId?: string;
}

// === Active experiment cache ===
interface CachedExperiment {
  experimentId: string;
  controlVersion: string;
  experimentVersion: string;
  trafficSplit: number;
  channels: string[]; // empty = all channels
}

// === Guardrail rule ===
interface ExperimentSafetyRule {
  metric: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  threshold: number;
  minSampleSize: number;
  comparison: 'absolute' | 'relative_to_control';
  // For relative_to_control: threshold is a ratio (0.2 = 20% worse).
  // Absolute check: evaluateOperator(experimentValue, operator, threshold)
  // Relative check: evaluateOperator((experimentValue - controlValue) / controlValue, operator, threshold)
}

// === Guardrail check result ===
interface ExperimentSafetyCheckResult {
  metric: string;
  value: number; // experiment group's raw metric value
  controlValue?: number; // populated for relative_to_control rules
  threshold: number;
  passing: boolean;
  skipped: boolean;
  sampleSize: number;
  comparison: 'absolute' | 'relative_to_control';
}
```

---

## 2. Implementation Phases

### Phase 1: Data Model Extensions

**Goal**: Extend ExperimentModel, Session model, and ClickHouse schema to support the full experiment lifecycle.

#### Files Modified

| File                                                                      | Change                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/schemas/experiment.schema.ts`               | Add `channels`, `safetyRules` (with `comparison` field), `stoppedReason`, `breachDetail`, `lastResultsAt`, `results`, `controlAssignments`, `experimentAssignments` fields. Add partial unique index on `(projectId, status)` where `status = 'running'` |
| `packages/database/src/models/session.model.ts`                           | Add `experimentId` (String, optional) and `experimentGroup` (String enum ['control','experiment'], optional) fields. Add sparse index on `experimentId`                                                                                                  |
| `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts` | New file: ClickHouse `experiment_assignments` table DDL (under `schemas/`, matching the `init-eval-tables.ts` pattern)                                                                                                                                   |
| `packages/pipeline-engine/src/pipeline/server.ts`                         | Import and call `initExperimentTables()` at startup alongside `initEvalTables()`                                                                                                                                                                         |
| `packages/pipeline-engine/src/index.ts`                                   | Export `ExperimentModel` (verify already exported) and new experiment types: `ExperimentSafetyRule`, `StoredExperimentResults`, `StoredSignificanceResult`                                                                                               |

Key new fields on `IExperiment`:

- `channels: string[]` — default `[]` (empty = all channels apply)
- `safetyRules: ExperimentSafetyRule[]` — replaces flat `safetyMetrics`; each rule has `comparison: 'absolute' | 'relative_to_control'`
- `stoppedReason: 'manual' | 'safety_breach' | 'completed' | null`
- `breachDetail: { metric, value, controlValue?, threshold, checkedAt } | null`
- `lastResultsAt: Date | null`
- `results: StoredExperimentResults | null`
- `controlAssignments: number` (default 0)
- `experimentAssignments: number` (default 0)

#### Exit Criteria

- [ ] ExperimentModel has all new fields with correct types and defaults
- [ ] `channels` field defaults to `[]` and is serialized correctly
- [ ] `ExperimentSafetyRule` includes `comparison` field with `'absolute' | 'relative_to_control'` enum
- [ ] Partial unique index enforced: only one `status: 'running'` per `projectId`
- [ ] Session model compiles with new optional experiment fields
- [ ] `experiment_assignments` ClickHouse table creation is idempotent
- [ ] `pnpm build --filter=@agent-platform/pipeline-engine --filter=@agent-platform/database` succeeds

---

### Phase 2: Assignment Algorithm & Experiment Service

**Goal**: Implement the hash-based group assignment function and an ExperimentService that encapsulates experiment lookup, caching, and assignment logic.

#### Files Created

| File                                                                   | Purpose                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/services/experiment-assignment.ts`       | `assignExperimentGroup()`, `getAssignmentKey()`, `checkSessionEligibility()` — pure functions, no side effects                                                                                             |
| `packages/pipeline-engine/src/services/experiment.service.ts`          | `ExperimentService` class: `getActiveExperiment(projectId)` with Redis cache, `assignSession(session, projectId)`, `invalidateCache(projectId)`, `getParentExperimentGroup(parentId, tenantId, projectId)` |
| `packages/pipeline-engine/src/__tests__/experiment-assignment.test.ts` | Unit tests for hash uniformity, determinism, boundary splits, eligibility checks, contactId stickiness                                                                                                     |

#### Implementation Details

**FNV-1a Hash + Assignment Key**:

```typescript
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function fnv1aHash(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function getAssignmentKey(session: { contactId: string | null; _id: string }): string {
  return session.contactId ?? session._id;
}

export function assignExperimentGroup(
  experimentId: string,
  assignmentKey: string, // contactId || sessionId
  trafficSplit: number,
): 'control' | 'experiment' {
  const hash = fnv1aHash(experimentId + ':' + assignmentKey);
  const bucket = hash % 10000;
  return bucket < trafficSplit * 10000 ? 'experiment' : 'control';
}
```

**Session Eligibility Check** (pure function — no DB calls):

```typescript
export function checkSessionEligibility(
  session: { source: SessionSource | null; parentId: string | null; channel: string },
  experiment: CachedExperiment,
): SessionEligibilityResult {
  // Rule 1: Exclude studio debug sessions
  if (session.source?.type === 'studio') {
    return { eligible: false, reason: 'studio_session' };
  }

  // Rule 2: A2A child sessions inherit from parent (resolved separately by ExperimentService)
  if (session.parentId) {
    return { eligible: false, reason: 'a2a_child' };
  }

  // Rule 3: Channel filter (empty channels = all channels pass)
  if (experiment.channels.length > 0 && !experiment.channels.includes(session.channel)) {
    return { eligible: false, reason: 'channel_excluded' };
  }

  return { eligible: true };
}
```

**ExperimentService.getParentExperimentGroup** (for A2A inheritance):

```typescript
async getParentExperimentGroup(
  parentId: string,
  tenantId: string,
  projectId: string,
): Promise<{ experimentId: string; experimentGroup: 'control' | 'experiment' } | null> {
  const Session = await getSessionModel();
  const parent = await Session.findOne(
    { _id: parentId, tenantId, projectId },
    { experimentId: 1, experimentGroup: 1 },
  ).lean();
  if (!parent?.experimentId || !parent?.experimentGroup) return null;
  return { experimentId: parent.experimentId, experimentGroup: parent.experimentGroup };
}
```

**Redis Cache** (updated to include `channels`):

```typescript
// Key: experiment:active:{projectId}
// Value: JSON CachedExperiment | 'null' (explicit null to cache absence)
// TTL: 300 seconds
// CachedExperiment now includes: channels: string[]
```

#### Exit Criteria

- [ ] `assignExperimentGroup` is deterministic (same inputs → same output)
- [ ] `getAssignmentKey` returns contactId when set, sessionId otherwise
- [ ] Same contactId across two different sessionIds → same group assignment
- [ ] Distribution test: 10K samples at 50/50 split within +/- 2%
- [ ] Distribution test: 10K samples at 10/90 split within +/- 2%
- [ ] `checkSessionEligibility` rejects studio sessions, A2A children, out-of-channel sessions
- [ ] Redis cache hit returns experiment (including `channels`) without MongoDB query
- [ ] Cache miss queries MongoDB and populates cache
- [ ] `pnpm build --filter=@agent-platform/pipeline-engine` succeeds
- [ ] Unit tests pass: `pnpm test --filter=@agent-platform/pipeline-engine -- experiment-assignment`

---

### Phase 3: Runtime Integration — Session Assignment

**Goal**: Wire the experiment assignment into the runtime's session creation flow so that new sessions are automatically assigned to experiment groups.

#### Files Modified

| File                                                                                   | Change                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/runtime-executor.ts` (or equivalent session creation point) | After session document is created, call `ExperimentService.assignSession()`. Set `experimentId` and `experimentGroup` on session. Fire-and-forget ClickHouse assignment write |
| `apps/runtime/src/services/execution/routing-executor.ts`                              | When resolving agent version, check `session.experimentGroup`: if set, use the experiment version for the corresponding group instead of the default deployment version       |

#### Implementation Details

**Session Creation Hook** (updated with eligibility + A2A inheritance):

```typescript
// In session creation flow (after session._id is generated):
const experiment = await experimentService.getActiveExperiment(projectId);
if (experiment) {
  // Step 1: Check eligibility (pure function — no DB calls for most cases)
  const eligibility = checkSessionEligibility(session, experiment);

  if (!eligibility.eligible && eligibility.reason === 'a2a_child' && session.parentId) {
    // Step 2a: A2A child — inherit from parent session
    const parentGroup = await experimentService.getParentExperimentGroup(
      session.parentId,
      tenantId,
      projectId,
    );
    if (parentGroup) {
      session.experimentId = parentGroup.experimentId;
      session.experimentGroup = parentGroup.experimentGroup;
      // No ClickHouse write for inherited assignments (counted under parent)
    }
  } else if (eligibility.eligible) {
    // Step 2b: Eligible new session — assign group
    const assignmentKey = getAssignmentKey(session); // contactId || _id
    const group = assignExperimentGroup(
      experiment.experimentId,
      assignmentKey,
      experiment.trafficSplit,
    );
    session.experimentId = experiment.experimentId;
    session.experimentGroup = group;

    // Async ClickHouse write (non-blocking)
    writeExperimentAssignment({
      tenant_id: tenantId,
      project_id: projectId,
      experiment_id: experiment.experimentId,
      session_id: session._id,
      experiment_group: group,
      agent_version_id:
        group === 'control' ? experiment.controlVersion : experiment.experimentVersion,
      assigned_at: new Date().toISOString(),
    }).catch((err) =>
      log.error('Failed to write experiment assignment', {
        error: err instanceof Error ? err.message : String(err),
        experimentId: experiment.experimentId,
        sessionId: session._id,
      }),
    );
  }
  // else: studio_session or channel_excluded — no assignment, no log (expected)
}
```

**Version Resolution Override**:

```typescript
// In version resolution:
if (session.experimentGroup && session.experimentId) {
  const experiment = await ExperimentModel.findOne({
    _id: session.experimentId,
    tenantId,
    projectId,
  }).lean();
  if (experiment) {
    const versionId =
      session.experimentGroup === 'control'
        ? experiment.controlVersion
        : experiment.experimentVersion;
    // Resolve AgentVersion by versionId instead of default deployment
  }
}
```

#### Exit Criteria

- [ ] Session created while experiment is running has `experimentId` and `experimentGroup` set
- [ ] Session created with no experiment has null experiment fields (no regression)
- [ ] Assignment latency < 5ms (Redis cache hit path)
- [ ] ClickHouse assignment record written asynchronously
- [ ] Agent version resolved correctly based on group
- [ ] `pnpm build --filter=runtime` succeeds

---

### Phase 4: Route Enhancements — Validation, Lifecycle, Results

**Goal**: Harden the existing experiments.ts routes with proper validation, lifecycle enforcement, version validation, one-active enforcement, and results computation.

#### Files Modified

| File                                     | Change                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/experiments.ts` | Replace manual validation with Zod schemas. Add status guards (only draft can be updated, only draft can start, only running can stop/complete). Add one-active-per-project check. Add version existence validation on start. Add DELETE endpoint. Add POST /:id/complete. Replace GET /:id/results with full significance computation |

#### Specific Route Changes

1. **POST /** (Create):
   - Replace manual field validation with Zod `createExperimentSchema`
   - Add `safetyRules` to creation payload
   - Change permission from `project:write` to `experiment:write`

2. **PUT /:id** (Update):
   - Add status guard: only `draft` experiments can be updated (400 if not draft)
   - Use Zod `updateExperimentSchema` for partial validation
   - Prevent `$set` of status field via update (use lifecycle endpoints instead)

3. **POST /:id/start**:
   - Validate experiment is in `draft` status (400 if not)
   - Validate no other experiment is `running` for this project (409 if exists)
   - Validate both `controlVersion` and `experimentVersion` exist in `AgentVersion` collection (400 if not)
   - On success: set `status: 'running'`, `startedAt: new Date()`, invalidate Redis cache
   - Use `findOneAndUpdate` with `{ status: 'draft' }` filter for atomic transition

4. **POST /:id/stop**:
   - Validate experiment is in `running` status (400 if not)
   - Set `status: 'stopped'`, `stoppedAt: new Date()`, `stoppedReason: 'manual'`
   - Invalidate Redis cache

5. **POST /:id/complete** (New):
   - Same as stop but `status: 'completed'`, `stoppedReason: 'completed'`

6. **DELETE /:id** (New):
   - Only draft experiments can be deleted (400 if not draft)
   - `deleteOne({ _id, tenantId, projectId, status: 'draft' })`

7. **GET /:id** (Detail):
   - Return full experiment document including `results` (cached) and `guardrailStatus`

8. **POST /:id/results** (On-demand recompute):
   - Trigger results computation via `ExperimentResultsService`
   - Update experiment document with results and `lastResultsAt`
   - Return updated results

#### Exit Criteria

- [ ] Zod validation rejects invalid payloads with specific error messages
- [ ] Start validates version existence (400 on invalid version)
- [ ] Start enforces one-active-per-project (409 on conflict)
- [ ] Draft-only guard prevents update/delete of non-draft experiments
- [ ] Running-only guard prevents stop/complete of non-running experiments
- [ ] Redis cache invalidated on start/stop/complete
- [ ] Results endpoint returns significance data
- [ ] All endpoints return `{ success, data/error }` envelope
- [ ] `pnpm build --filter=runtime` succeeds

---

### Phase 5: Results Computation & Guardrails

**Goal**: Extend ExperimentResultsService with ClickHouse query integration, implement guardrail evaluation, and add a periodic cron for automatic results computation.

#### Files Modified/Created

| File                                                                           | Change                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` | Add `computeExperimentResults(experimentId)` method that queries ClickHouse for per-group metrics and calls existing tTest/chiSquared methods. Add `queryGroupMetrics(experimentId, metricNames)` |
| `packages/pipeline-engine/src/services/experiment-safety.ts`                   | New file: `evaluateSafetyRules(experiment, groupMetrics)` function. Returns array of `ExperimentSafetyCheckResult`. Triggers auto-stop if any breach                                              |
| `packages/pipeline-engine/src/pipeline/handlers/experiment-results-cron.ts`    | New file: Restate scheduled handler or simple cron job. Finds all `running` experiments, computes results, evaluates guardrails, auto-stops if needed                                             |
| `packages/pipeline-engine/src/__tests__/experiment-safety.test.ts`             | Unit tests for guardrail evaluation logic                                                                                                                                                         |

#### ClickHouse Queries

**Per-group session metrics**:

```sql
SELECT
  experiment_group,
  count() AS sample_size,
  avg(duration_ms) AS avg_duration,
  avg(has_error) AS error_rate,
  avg(turn_count) AS avg_turns
FROM abl_platform.experiment_assignments AS ea
LEFT JOIN abl_platform.conversation_quality AS cq
  ON ea.session_id = cq.session_id AND ea.tenant_id = cq.tenant_id
WHERE ea.experiment_id = {experimentId:String}
  AND ea.tenant_id = {tenantId:String}
GROUP BY experiment_group
```

**Per-group eval scores**:

```sql
SELECT
  experiment_group,
  avg(score) AS avg_score,
  stddevPop(score) AS std_score,
  count() AS score_count
FROM abl_platform.experiment_assignments AS ea
LEFT JOIN abl_platform.eval_production_scores AS eps
  ON ea.session_id = eps.session_id AND ea.tenant_id = eps.tenant_id
WHERE ea.experiment_id = {experimentId:String}
  AND ea.tenant_id = {tenantId:String}
GROUP BY experiment_group
```

#### Auto-Stop Logic (updated for relative thresholds + audit log)

```typescript
export function evaluateSafetyRules(
  safetyRules: ExperimentSafetyRule[],
  controlMetrics: Record<string, number>,
  experimentMetrics: Record<string, number>,
  sampleSizes: { control: number; experiment: number },
): ExperimentSafetyCheckResult[] {
  return safetyRules.map((rule) => {
    const experimentValue = experimentMetrics[rule.metric] ?? 0;
    const controlValue = controlMetrics[rule.metric] ?? 0;
    const sampleSize = sampleSizes.experiment;

    if (sampleSize < rule.minSampleSize) {
      return {
        metric: rule.metric,
        value: experimentValue,
        controlValue,
        threshold: rule.threshold,
        passing: true,
        skipped: true,
        sampleSize,
        comparison: rule.comparison,
      };
    }

    let testValue: number;
    if (rule.comparison === 'relative_to_control') {
      // Relative degradation: (experiment - control) / control
      // A positive result means experiment is worse on error_rate, latency, etc.
      testValue = controlValue !== 0 ? (experimentValue - controlValue) / controlValue : 0;
    } else {
      testValue = experimentValue;
    }

    const passing = evaluateOperator(testValue, rule.operator, rule.threshold);
    return {
      metric: rule.metric,
      value: experimentValue,
      controlValue,
      threshold: rule.threshold,
      passing,
      skipped: false,
      sampleSize,
      comparison: rule.comparison,
    };
  });
}
```

**Audit log on breach** (in the cron auto-stop path):

```typescript
// After updating experiment status to 'stopped' with stoppedReason: 'safety_breach':
await auditLogger.log({
  tenantId: experiment.tenantId,
  projectId: experiment.projectId,
  action: 'experiment.safety_breach',
  resourceType: 'experiment',
  resourceId: String(experiment._id),
  actor: 'system',
  metadata: {
    metric: breachedRule.metric,
    value: breachResult.value,
    controlValue: breachResult.controlValue,
    threshold: breachedRule.threshold,
    comparison: breachedRule.comparison,
    sampleSize: breachResult.sampleSize,
  },
});
```

The `auditLogger` is the platform's existing audit logging service. Import from `@agent-platform/shared-audit` or equivalent — read the source before importing.

#### Exit Criteria

- [ ] `computeExperimentResults()` returns correct `ExperimentResults` structure
- [ ] Significance computed for each success metric
- [ ] Guardrail evaluation correctly detects breaches
- [ ] Auto-stop updates experiment status and invalidates cache
- [ ] Cron job runs on configured interval for all running experiments
- [ ] Distributed lock prevents concurrent cron execution
- [ ] Unit tests pass for guardrail evaluation
- [ ] `pnpm build --filter=@agent-platform/pipeline-engine` succeeds

---

### Phase 6: Studio Proxy & UI

**Goal**: Add Studio API proxy routes and build the experiments management UI pages.

#### Files Created

| File                                                                                        | Purpose                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[projectId]/experiments/route.ts`                         | Proxy GET (list) and POST (create) to runtime                                |
| `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/route.ts`          | Proxy GET (detail), PUT (update), DELETE                                     |
| `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/start/route.ts`    | Proxy POST start                                                             |
| `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/stop/route.ts`     | Proxy POST stop                                                              |
| `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/complete/route.ts` | Proxy POST complete                                                          |
| `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/results/route.ts`  | Proxy POST on-demand results                                                 |
| `apps/studio/src/components/experiments/ExperimentsPage.tsx`                                | Main experiments list page                                                   |
| `apps/studio/src/components/experiments/ExperimentDetail.tsx`                               | Experiment detail with results visualization                                 |
| `apps/studio/src/components/experiments/CreateExperimentDialog.tsx`                         | Creation dialog with version selection, traffic split slider, metrics config |
| `apps/studio/src/components/experiments/ExperimentResultsChart.tsx`                         | Group comparison chart (bar chart for metrics, significance indicators)      |

#### UI Components

**ExperimentsPage**:

- Table listing experiments: name, status (badge), date range, control/experiment assignments, quick significance summary
- "New Experiment" button opens `CreateExperimentDialog`
- Status filter tabs: All, Draft, Running, Stopped, Completed
- Empty state for no experiments

**ExperimentDetail**:

- Header: name, status badge, start/stop/complete action buttons
- Config section: versions, traffic split, metrics
- Results section: `ExperimentResultsChart` showing per-metric comparison
- Guardrail status: green/red indicators per guardrail rule
- Assignment distribution: simple count display (control: N, experiment: M)
- Sample size indicator: green if adequate, yellow with warning if below minimum

**CreateExperimentDialog**:

- Name and description inputs
- Control version dropdown (from `AgentVersion` API)
- Experiment version dropdown
- Traffic split slider (1%-99%) with numeric display
- Success metrics: multi-select from available metric names
- Guardrail rules: add rows with metric, operator, threshold, min sample size

#### Sidebar Navigation

Add "Experiments" entry to project sidebar navigation under the **"EVALUATE"** section (not Analytics), using the `FlaskConical` lucide icon. Read the existing sidebar nav config file before adding — verify the EVALUATE group key/label used by other items in that section (e.g., evals, testing).

#### Exit Criteria

- [ ] Studio proxy routes forward requests to runtime with correct auth headers
- [ ] ExperimentsPage lists experiments with status filters
- [ ] CreateExperimentDialog creates experiment via API
- [ ] ExperimentDetail shows results with significance indicators
- [ ] Start/Stop/Complete actions work from detail page
- [ ] Sidebar navigation includes Experiments link
- [ ] `pnpm build --filter=studio` succeeds

---

### Phase 7: Integration & E2E Tests

**Goal**: Implement the integration and E2E test scenarios from the test spec.

#### Files Created

| File                                                                    | Test Scenarios                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/integration/experiment-lifecycle.test.ts`   | INT-1 (one-active), INT-2 (version validation), INT-3 (stop ceases routing)                                   |
| `apps/runtime/src/__tests__/integration/experiment-assignment.test.ts`  | INT-4 (distribution), INT-5 (contactId stickiness), INT-6 (studio excluded), INT-7 (channel scoped)           |
| `apps/runtime/src/__tests__/integration/experiment-a2a.test.ts`         | INT-8 (A2A child inherits parent group), INT-9 (A2A child inherits when parent has no experiment → no assign) |
| `apps/runtime/src/__tests__/integration/experiment-isolation.test.ts`   | INT-10 (tenant/project isolation)                                                                             |
| `packages/pipeline-engine/src/__tests__/experiment-status.test.ts`      | UNIT-1 (status transitions)                                                                                   |
| `packages/pipeline-engine/src/__tests__/experiment-eligibility.test.ts` | UNIT-2 (studio exclusion), UNIT-3 (channel filter), UNIT-4 (A2A exclusion)                                    |
| `packages/pipeline-engine/src/__tests__/experiment-stickiness.test.ts`  | UNIT-5 (contactId stickiness — same contactId → same group across sessions)                                   |
| `packages/pipeline-engine/src/__tests__/experiment-safety.test.ts`      | UNIT-6 (absolute guardrail), UNIT-7 (relative-to-control guardrail), UNIT-8 (skipped below minSampleSize)     |

#### Key New Test Scenarios

**INT-5 — contactId stickiness across sessions**:
Create two sessions with the same `contactId` but different `_id`. Both must get the same `experimentGroup`.

**INT-6 — Studio session excluded**:
Create session with `source.type = 'studio'` while experiment is running. Session must have null `experimentId`.

**INT-7 — Channel scoping**:
Create experiment with `channels: ['web']`. Create a `voice` channel session. Session must have null `experimentId`.

**INT-8 — A2A inheritance**:
Create parent session (gets assigned to 'control'). Create child session with `parentId = parent._id`. Child must have same `experimentId` and `experimentGroup` as parent. No new ClickHouse assignment row for child.

**UNIT-7 — Relative guardrail**:
Control error_rate = 0.05, experiment error_rate = 0.07. Rule: `{ comparison: 'relative_to_control', operator: 'gt', threshold: 0.3 }` (>30% worse). Test = (0.07 - 0.05) / 0.05 = 0.4 → should breach. Then test with 0.06 → (0.06-0.05)/0.05 = 0.2 → should pass.

#### Test Infrastructure

- Runtime integration tests use `RuntimeApiHarness` pattern (real Express, MongoMemoryServer)
- ClickHouse integration tests use ClickHouse test instance (if available) or skip with `describe.skipIf`
- All E2E tests interact via HTTP API only — no `vi.mock()`, no direct Mongoose model access
- `checkSessionEligibility` and `evaluateSafetyRules` are pure functions — test directly without any setup

#### Exit Criteria

- [ ] All unit tests pass: `pnpm test --filter=@agent-platform/pipeline-engine -- experiment`
- [ ] Integration tests pass against real runtime
- [ ] Studio session exclusion confirmed (INT-6)
- [ ] Channel scoping confirmed (INT-7)
- [ ] A2A inheritance confirmed (INT-8)
- [ ] contactId stickiness confirmed (INT-5)
- [ ] Relative guardrail evaluation confirmed (UNIT-7)
- [ ] Tenant isolation test confirms 404 for cross-tenant access
- [ ] No `vi.mock()` of codebase components in E2E tests
- [ ] `pnpm test --filter=runtime -- experiment` passes

---

## 3. Wiring Checklist

Every new component must be wired into its caller. Verify each item post-implementation:

| #    | Component                           | Wired Into                                 | Verification                                                                               |
| ---- | ----------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| W-1  | ExperimentModel new fields          | Route handlers access new fields           | Routes read/write `safetyRules`, `channels`, `results`, `stoppedReason`                    |
| W-2  | Session experiment fields           | Session creation flow                      | `session.experimentId` and `experimentGroup` set on creation                               |
| W-3  | `assignExperimentGroup()`           | Session creation in runtime-executor       | Called for eligible sessions when experiment is active                                     |
| W-4  | `checkSessionEligibility()`         | Session creation in runtime-executor       | Called before assignment; studio/A2A/channel-excluded sessions skip assignment             |
| W-5  | `getParentExperimentGroup()`        | Session creation in runtime-executor       | Called for A2A child sessions (parentId set); copies parent's group                        |
| W-6  | Redis cache (active experiment)     | ExperimentService.getActiveExperiment()    | Cache includes `channels` field; invalidated on start/stop                                 |
| W-7  | ClickHouse assignment write         | Session creation flow                      | Async write fires only for directly-assigned sessions (not inherited A2A)                  |
| W-8  | `initExperimentTables()`            | Pipeline-engine server startup             | Called in `server.ts` alongside `initEvalTables()`                                         |
| W-9  | Experiment routes                   | Runtime Express app                        | Router mounted at `/api/projects/:projectId/experiments`                                   |
| W-10 | Results cron                        | Pipeline-engine scheduler                  | Registered in server.ts or scheduler                                                       |
| W-11 | Guardrail auto-stop                 | Results cron flow                          | Called after results computation; evaluates `comparison` field                             |
| W-12 | Audit log on guardrail breach       | Auto-stop path in results cron             | `auditLogger.log(experiment.safety_breach)` fires before cache invalidation                |
| W-13 | Studio proxy routes                 | Studio Next.js app router                  | `/api/projects/[projectId]/experiments/` routes exist                                      |
| W-14 | Studio sidebar entry                | Project navigation config (EVALUATE group) | "Experiments" appears under EVALUATE section, not Analytics                                |
| W-15 | ExperimentService                   | Runtime startup                            | Instantiated with Redis client and MongoDB                                                 |
| W-16 | Session erasure → ClickHouse DELETE | Session erasure pipeline                   | When session is erased, `ALTER TABLE experiment_assignments DELETE WHERE session_id` fires |

---

## 4. Risk Mitigation

| Risk                                                        | Mitigation                                                                                 | Phase      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| Partial unique index not supported on all MongoDB versions  | Fallback: application-level check with optimistic locking                                  | Phase 1    |
| Runtime-executor is large and complex to modify             | Isolate experiment logic in ExperimentService; runtime-executor calls service methods only | Phase 3    |
| ClickHouse not available in all test environments           | Use `describe.skipIf(!clickhouseAvailable)` pattern                                        | Phase 7    |
| Studio proxy auth mismatch with runtime                     | Mirror existing proxy patterns (e.g., attachment-config proxy)                             | Phase 6    |
| Experiment version cached in Redis but deleted from MongoDB | Validate version existence at experiment start; cache TTL ensures stale cache expires      | Phase 2, 4 |

---

## 5. File-Level Change Summary

### New Files (15)

| #   | File                                                                                        | Phase |
| --- | ------------------------------------------------------------------------------------------- | ----- |
| 1   | `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts`                   | 1     |
| 2   | `packages/pipeline-engine/src/services/experiment-assignment.ts`                            | 2     |
| 3   | `packages/pipeline-engine/src/services/experiment.service.ts`                               | 2     |
| 4   | `packages/pipeline-engine/src/services/experiment-safety.ts`                                | 5     |
| 5   | `packages/pipeline-engine/src/pipeline/handlers/experiment-results-cron.ts`                 | 5     |
| 6   | `apps/studio/src/app/api/projects/[projectId]/experiments/route.ts`                         | 6     |
| 7   | `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/route.ts`          | 6     |
| 8   | `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/start/route.ts`    | 6     |
| 9   | `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/stop/route.ts`     | 6     |
| 10  | `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/complete/route.ts` | 6     |
| 11  | `apps/studio/src/app/api/projects/[projectId]/experiments/[experimentId]/results/route.ts`  | 6     |
| 12  | `apps/studio/src/components/experiments/ExperimentsPage.tsx`                                | 6     |
| 13  | `apps/studio/src/components/experiments/ExperimentDetail.tsx`                               | 6     |
| 14  | `apps/runtime/src/__tests__/integration/experiment-a2a.test.ts`                             | 7     |
| 15  | `packages/pipeline-engine/src/__tests__/experiment-eligibility.test.ts`                     | 7     |

### Modified Files (7)

| #   | File                                                                           | Phase | Change                                                |
| --- | ------------------------------------------------------------------------------ | ----- | ----------------------------------------------------- |
| 1   | `packages/pipeline-engine/src/schemas/experiment.schema.ts`                    | 1     | Add new fields and partial unique index               |
| 2   | `packages/database/src/models/session.model.ts`                                | 1     | Add `experimentId`, `experimentGroup` fields          |
| 3   | `packages/pipeline-engine/src/pipeline/server.ts`                              | 1     | Import and call `initExperimentTables()`              |
| 4   | `packages/pipeline-engine/src/index.ts`                                        | 1     | Export new experiment types                           |
| 5   | `apps/runtime/src/services/runtime-executor.ts`                                | 3     | Add experiment assignment call in session creation    |
| 6   | `apps/runtime/src/routes/experiments.ts`                                       | 4     | Harden with Zod, lifecycle guards, version validation |
| 7   | `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` | 5     | Add ClickHouse query integration                      |

### Test Files (8)

| #   | File                                                                    | Phase |
| --- | ----------------------------------------------------------------------- | ----- |
| 1   | `packages/pipeline-engine/src/__tests__/experiment-assignment.test.ts`  | 2     |
| 2   | `packages/pipeline-engine/src/__tests__/experiment-eligibility.test.ts` | 7     |
| 3   | `packages/pipeline-engine/src/__tests__/experiment-status.test.ts`      | 7     |
| 4   | `packages/pipeline-engine/src/__tests__/experiment-stickiness.test.ts`  | 7     |
| 5   | `packages/pipeline-engine/src/__tests__/experiment-safety.test.ts`      | 5     |
| 6   | `apps/runtime/src/__tests__/integration/experiment-lifecycle.test.ts`   | 7     |
| 7   | `apps/runtime/src/__tests__/integration/experiment-assignment.test.ts`  | 7     |
| 8   | `apps/runtime/src/__tests__/integration/experiment-a2a.test.ts`         | 7     |

---

## 6. Estimated Effort

| Phase     | Description                              | Effort | Dependencies |
| --------- | ---------------------------------------- | ------ | ------------ |
| 1         | Data Model Extensions                    | S      | None         |
| 2         | Assignment Algorithm & Service           | S      | Phase 1      |
| 3         | Runtime Integration — Session Assignment | M      | Phase 1, 2   |
| 4         | Route Enhancements                       | M      | Phase 1      |
| 5         | Results Computation & Guardrails         | L      | Phase 1, 2   |
| 6         | Studio Proxy & UI                        | L      | Phase 4      |
| 7         | Integration & E2E Tests                  | L      | Phase 1-5    |
| **Total** |                                          | **XL** |              |

Phase 3 and Phase 4 can be developed in parallel. Phase 6 depends on Phase 4 (routes must be stable before building proxy). Phase 7 spans all previous phases.

---

## 7. Audit Trail

### Review Rounds

| Round | Focus                                    | Status                                                             |
| ----- | ---------------------------------------- | ------------------------------------------------------------------ |
| 1     | Schema design and index strategy         | Complete — partial unique index validated                          |
| 2     | Assignment algorithm uniformity          | Complete — FNV-1a distribution verified analytically               |
| 3     | Runtime integration point identification | Complete — session creation flow traced through runtime-executor   |
| 4     | Route security review                    | Complete — all routes use requireProjectPermission, Zod validation |
| 5     | Wiring checklist completeness            | Complete — 12 wiring points identified and tracked                 |
