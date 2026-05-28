# LLD: Experiments V2 — Deployment-Based Assignment + UX Gaps

**Feature Spec**: `docs/features/experiments.md`
**HLD**: `docs/specs/experiments.hld.md`
**Prior Implementation**: `docs/plans/2026-03-23-experiments-impl-plan.md`
**Status**: DRAFT
**Date**: 2026-04-29
**JIRA**: TBD — create new ABLP ticket before first commit

---

## Background

V1 implemented experiment assignment using bare agent version strings
(`controlVersion`/`experimentVersion`). Three gaps were identified in review:

1. **Architectural** — Version strings override only the _entry agent's_ IR
   (`overrideResolvedAgentWithExperimentVersion` mutates `resolved.agents[entryAgent]`).
   Non-entry agents, routing rules, tools, and module snapshots are unchanged.
   A/B testing a multi-agent stack or any agent other than the entry point is impossible.

2. **UX** — CreateExperimentDialog uses free-text version string inputs. Users have no
   way to discover valid versions without leaving the dialog. Success metrics and safety
   rule metrics are free-text with no validation or suggestions.

3. **Test coverage** — INT-6/7/8 (ClickHouse assignment write, results computation,
   guardrail auto-stop) were deferred during V1 review. TraceEvents on the assignment
   path are missing (D-19).

---

## Design Decisions

| #    | Decision                                                                           | Rationale                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-16 | Add `controlDeploymentId`/`experimentDeploymentId` as optional fields              | Backward-compat: V1 version-based experiments remain valid; new experiments default to deployment mode                                                      |
| D-17 | Add `assignmentMode: 'version' \| 'deployment'` discriminator                      | Clean branch in assignment logic; migration-free; default `'deployment'` for new experiments                                                                |
| D-18 | Deployment-mode override replaces full `ResolvedAgent` via re-resolve              | Reuses `DeploymentResolver.resolve()` — same path as channel-based resolution, no new code surface                                                          |
| D-19 | Version-mode override path unchanged                                               | V1 experiments in-flight must not be disrupted; additive change only                                                                                        |
| D-20 | TraceEvent `experiment_assigned` after group determination                         | Required for debuggability and audit; type sits alongside existing trace event types                                                                        |
| D-21 | Studio deployment picker via new proxy route                                       | Follows existing proxy pattern; no direct DB access from Studio                                                                                             |
| D-22 | Predefined success metrics list in Studio (with custom option)                     | Reduces free-text errors; list derived from ClickHouse analytics schema columns                                                                             |
| D-23 | One-active constraint shown in dialog via `?status=running` query                  | Proactive UX; same endpoint already exists — no new API needed                                                                                              |
| D-24 | INT-6/7/8 tests use real MongoDB + DI-injected ClickHouseClient stub               | External service mock (ClickHouse) is allowed; platform components (Mongo) must be real                                                                     |
| D-25 | Deployment-mode assignment skips (returns null) if deployment resolution fails     | Prevents poisoned group membership — session gets no assignment rather than wrong IR with wrong label (F-5)                                                 |
| D-26 | Delete `assign-experiment.ts:assignExperimentToSession()` — dead code              | Active path is `tryAssignExperimentPreSession` in session-factory.ts; dead parallel creates V2 confusion (F-3)                                              |
| D-27 | `agentVersionId` in deployment mode = entry agent version from resolved deployment | Maintains ClickHouse analytics continuity; extracted from `experimentResolved.versionInfo.rawVersions` (F-7)                                                |
| D-28 | `ExperimentAssignmentData` writer update in same commit as DDL addition            | Prevents analytics gap where new columns exist but are never populated (F-4)                                                                                |
| D-29 | Deployment-mode experiments require Tier 1 (deploymentId) sessions                 | Tier 2 (working-copy compile) sessions have no deployment context to resolve experiment deployments against; excluded from deployment-mode assignment (F-8) |

---

## Data-Flow Audit

**Audit log**: `docs/sdlc-logs/experiments-v2/data-flow-audit.md`
**Round 1 completed**: 2026-04-29
**Findings**: 5 HIGH, 3 MEDIUM — all incorporated as plan amendments below.

---

## Key Interfaces After This Change

```typescript
// pipeline-engine: CachedExperiment
interface CachedExperiment {
  experimentId: string;
  assignmentMode: 'version' | 'deployment';
  // version mode (legacy)
  controlVersion?: string;
  experimentVersion?: string;
  // deployment mode (new)
  controlDeploymentId?: string;
  experimentDeploymentId?: string;
  trafficSplit: number;
  channels: string[];
}

// runtime: ExperimentAssignmentResult
interface ExperimentAssignmentResult {
  experimentId: string;
  experimentGroup: 'control' | 'experiment';
  agentVersionId: string; // kept for ClickHouse write (entry agent version)
  assignmentDeploymentId?: string; // set when assignmentMode === 'deployment'
}
```

---

## File Change Map

| File                                                                      | Change                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/schemas/experiment.schema.ts`               | Add `controlDeploymentId`, `experimentDeploymentId`, `assignmentMode` fields |
| `packages/pipeline-engine/src/services/experiment-assignment.ts`          | Extend `CachedExperiment` interface                                          |
| `packages/pipeline-engine/src/services/experiment.service.ts`             | Update DB projection + cache serialization                                   |
| `packages/database/src/models/session.model.ts`                           | Add `experimentDeploymentId?: string`                                        |
| `apps/runtime/src/routes/experiments.ts`                                  | Zod schema extensions, start validation, response fields                     |
| `apps/runtime/src/services/experiments/resolve-experiment-version.ts`     | Add `resolveExperimentDeployment()`                                          |
| `apps/runtime/src/services/experiments/assign-experiment.ts`              | Update `ExperimentAssignmentResult`, branch on `assignmentMode`              |
| `apps/runtime/src/channels/pipeline/session-factory.ts`                   | TraceEvent emit, deployment-mode assignment path                             |
| `apps/runtime/src/services/experiments/write-experiment-assignment.ts`    | Add `assignment_mode`, `deployment_id` fields                                |
| `packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts` | Add `assignment_mode`, `deployment_id` columns                               |
| `apps/studio/src/app/api/projects/[id]/deployments/route.ts`              | New — proxy to runtime deployments list                                      |
| `apps/studio/src/components/experiments/CreateExperimentDialog.tsx`       | Deployment picker, predefined metrics, UX improvements                       |
| `apps/studio/src/components/experiments/ExperimentDetail.tsx`             | Show deployment name/environment instead of raw version string               |
| `apps/runtime/src/__tests__/integration/experiment-lifecycle.test.ts`     | Add deployment-mode test cases                                               |
| `apps/runtime/src/__tests__/integration/experiment-assignment.test.ts`    | Add deployment-mode test cases                                               |
| `apps/runtime/src/__tests__/integration/experiment-clickhouse.test.ts`    | New — INT-6                                                                  |
| `apps/runtime/src/__tests__/integration/experiment-results.test.ts`       | New — INT-7 (runtime package)                                                |
| `apps/runtime/src/__tests__/integration/experiment-guardrail.test.ts`     | New — INT-8                                                                  |

---

## Phase 1: Schema Extensions

**Goal**: Add deployment fields to Experiment model and CachedExperiment type. Zero behavior change — existing experiments continue to work via `assignmentMode: 'version'` default.

### Tasks

**1.1 ExperimentModel** (`packages/pipeline-engine/src/schemas/experiment.schema.ts`)

Add to `IExperiment` interface:

```typescript
assignmentMode: 'version' | 'deployment';
controlDeploymentId?: Types.ObjectId;
experimentDeploymentId?: Types.ObjectId;
```

Add to Mongoose schema:

```typescript
assignmentMode: { type: String, enum: ['version', 'deployment'], default: 'version' },
controlDeploymentId: { type: Schema.Types.ObjectId, required: false },
experimentDeploymentId: { type: Schema.Types.ObjectId, required: false },
```

Keep `controlVersion`/`experimentVersion` as-is. Add index:

```typescript
schema.index({ controlDeploymentId: 1 }, { sparse: true });
schema.index({ experimentDeploymentId: 1 }, { sparse: true });
```

**1.2 CachedExperiment** (`packages/pipeline-engine/src/services/experiment-assignment.ts`)

Extend interface per the Key Interfaces section above.

**1.3 ExperimentService** (`packages/pipeline-engine/src/services/experiment.service.ts`)

**[Audit F-1 fix]** Update DB projection in `getActiveExperiment()` — the current projection omits the new fields, causing the deployment-mode branch in `tryAssignExperimentPreSession` to never fire:

```typescript
{
  _id: 1, assignmentMode: 1,
  controlVersion: 1, experimentVersion: 1,
  controlDeploymentId: 1, experimentDeploymentId: 1,
  trafficSplit: 1, channels: 1
}
```

Update `CachedExperiment` construction:

```typescript
const value: CachedExperiment | null = doc
  ? {
      experimentId: String(doc._id),
      assignmentMode: doc.assignmentMode ?? 'version',
      controlVersion: doc.controlVersion,
      experimentVersion: doc.experimentVersion,
      controlDeploymentId: doc.controlDeploymentId ? String(doc.controlDeploymentId) : undefined,
      experimentDeploymentId: doc.experimentDeploymentId
        ? String(doc.experimentDeploymentId)
        : undefined,
      trafficSplit: doc.trafficSplit,
      channels: doc.channels ?? [],
    }
  : null;
```

**1.4 Session model** (`packages/database/src/models/session.model.ts`)

Add optional field `experimentDeploymentId?: string` alongside existing `experimentId`/`experimentGroup`.

**1.5 ClickHouse DDL + writer** (`packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts` + `apps/runtime/src/services/experiments/write-experiment-assignment.ts`)

**[Audit F-4 fix]** DDL and writer must be updated in the SAME commit to prevent a window where columns exist but are never populated (they'd show `assignment_mode='version'` for all deployment-mode records):

DDL — add two columns:

```sql
assignment_mode LowCardinality(String) DEFAULT 'version',
deployment_id   String DEFAULT ''
```

`ExperimentAssignmentData` interface — add fields:

```typescript
assignmentMode: 'version' | 'deployment';
assignmentDeploymentId?: string;
```

`writeExperimentAssignment` row construction — add fields:

```typescript
assignment_mode: data.assignmentMode,
deployment_id:   data.assignmentDeploymentId ?? '',
```

### Exit Criteria

- `pnpm build --filter=@agent-platform/pipeline-engine` — clean
- `pnpm build --filter=@agent-platform/database` — clean
- ExperimentModel round-trips both modes via `createExperiment` test helper
- Existing integration tests still pass (no behavior change)

---

## Phase 2: Route + Validation Updates

**Goal**: Accept deployment-based experiment creation and validate deployment existence on start.

### Tasks

**2.1 Zod schema** (`apps/runtime/src/routes/experiments.ts`)

Extend `createExperimentSchema`:

```typescript
assignmentMode: z.enum(['version', 'deployment']).optional(),
controlDeploymentId: z.string().min(1).optional(),
experimentDeploymentId: z.string().min(1).optional(),
```

Add refinement:

```typescript
.refine(
  (data) => {
    if (data.assignmentMode === 'deployment') {
      return !!data.controlDeploymentId && !!data.experimentDeploymentId;
    }
    return !!data.controlVersion && !!data.experimentVersion;
  },
  { message: 'Deployment-mode experiments require controlDeploymentId and experimentDeploymentId' },
)
```

**2.2 POST `/` handler**

Infer `assignmentMode` when not explicit:

```typescript
const assignmentMode = body.assignmentMode ?? (body.controlDeploymentId ? 'deployment' : 'version');
```

Persist to DB. Return `201` with new fields in response body.

**2.3 POST `/:id/start` validation**

For `assignmentMode === 'deployment'`:

- `Deployment.findOne({ _id: controlDeploymentId, projectId, tenantId })`
- `Deployment.findOne({ _id: experimentDeploymentId, projectId, tenantId })`
- Either missing → `400` with code `DEPLOYMENT_NOT_FOUND` and message including the missing ID

For `assignmentMode === 'version'`: existing `VERSION_NOT_FOUND` check unchanged.

**2.4 GET `/:id` + GET `/` responses**

Include `assignmentMode`, `controlDeploymentId`, `experimentDeploymentId` in response fields (alongside existing `controlVersion`/`experimentVersion`).

**2.5 Route param validation** (previously deferred)

Add `.refine(mongoose.isValidObjectId, { message: 'Invalid experiment ID' })` to `:id` params that touch MongoDB.

### Exit Criteria

- `POST /experiments` with deployment fields → `201`, `assignmentMode: 'deployment'` in response
- `POST /experiments/:id/start` with missing deployment → `400 DEPLOYMENT_NOT_FOUND`
- `POST /experiments/:id/start` with valid deployments → `200`
- `pnpm build --filter=apps/runtime` — clean

---

## Phase 3: Runtime Assignment — Deployment Path

**Goal**: When `assignmentMode === 'deployment'`, re-resolve the entire agent stack via `DeploymentResolver` rather than patching one agent's IR.

### Tasks

**3.1 `resolveExperimentDeployment()`** (`apps/runtime/src/services/experiments/resolve-experiment-version.ts`)

New export alongside the existing `overrideResolvedAgentWithExperimentVersion`:

```typescript
export async function resolveExperimentDeployment(
  group: 'control' | 'experiment',
  experiment: CachedExperiment,
  ctx: { tenantId: string; projectId: string; agentName?: string },
): Promise<ResolvedAgent | null>;
```

Implementation:

1. Pick `deploymentId = group === 'control' ? experiment.controlDeploymentId : experiment.experimentDeploymentId`
2. Call `new DeploymentResolver(getSessionService()).resolve({ deploymentId, tenantId, projectId, agentName: ctx.agentName })`
3. Return `ResolvedAgent` on success, `null` (logged) on failure
4. Caller falls through to non-experiment path on `null` (safe degradation)

**3.2 `tryAssignExperimentPreSession()`** (`apps/runtime/src/channels/pipeline/session-factory.ts`)

**[Audit F-2, F-5 fixes]** Branch after group assignment — includes guards for deployment context (D-29) and null-safe deployment resolution (D-25):

```typescript
// D-29: deployment-mode requires a deploymentId or environment in session context
if (experiment.assignmentMode === 'deployment' && !ctx.deploymentId && !ctx.environment) {
  log.debug('Deployment-mode experiment skipped — no deployment context', {
    experimentId: experiment.experimentId,
    projectId: ctx.projectId,
  });
  return null;
}

let agentVersionId: string;

if (experiment.assignmentMode === 'deployment') {
  const experimentResolved = await resolveExperimentDeployment(group, experiment, {
    tenantId,
    projectId,
    agentName: ctx.agentName,
  });

  // D-25: return null rather than poison group membership with wrong IR
  if (!experimentResolved) {
    log.warn('Deployment resolution failed for experiment group — skipping assignment', {
      experimentId: experiment.experimentId,
      group,
      projectId: ctx.projectId,
    });
    return null;
  }

  // Replace the entire resolved agent (not just the entry IR)
  Object.assign(resolved, experimentResolved);

  // D-27: populate agentVersionId from the resolved entry agent version
  agentVersionId =
    experimentResolved.versionInfo.rawVersions?.[experimentResolved.entryAgent] ?? '';
} else {
  // V1 version-mode path — unchanged
  agentVersionId =
    group === 'experiment' ? experiment.experimentVersion! : experiment.controlVersion!;
  if (group === 'experiment') {
    await overrideResolvedAgentWithExperimentVersion(
      resolved,
      experiment.experimentVersion!,
      tenantId,
      projectId,
    );
  }
}
```

**3.3 Delete `assign-experiment.ts:assignExperimentToSession()`** (D-26)

**[Audit F-3 fix]** `assignExperimentToSession` in `apps/runtime/src/services/experiments/assign-experiment.ts` is dead code — it is never called in the production path (only `import type { ExperimentAssignmentResult }` is imported). Delete the function. Move `ExperimentAssignmentResult` type definition to `session-factory.ts` or a shared types file. Confirm no other callers exist: `grep -r "assignExperimentToSession" --include="*.ts"` must return 0 non-test results.

The file can be retained as a home for `writeExperimentAssignment` imports if needed, but the `assignExperimentToSession` function export must be removed.

**3.4 TraceEvent emission** (D-20)

After group assignment (before return):

```typescript
traceStore.add(runtimeSession.id, {
  type: 'experiment_assigned',
  data: {
    experimentId: experiment.experimentId,
    group,
    assignmentMode: experiment.assignmentMode,
    deploymentId: result.assignmentDeploymentId,
    assignmentKey: assignmentKey.slice(0, 8) + '…',
  },
  timestamp: Date.now(),
});
```

**3.5 `ExperimentAssignmentResult`** (move to session-factory types or shared types file)

Add optional field: `assignmentDeploymentId?: string`

`write-experiment-assignment.ts` call site — extend payload (already handled by F-4 fix in Phase 1.5):

```typescript
assignment_mode: result.assignmentMode ?? 'version',
deployment_id: result.assignmentDeploymentId ?? '',
```

### Exit Criteria

- Deployment-mode experiment: session resolves with full agent stack from selected deployment
- Version-mode experiment: behavior identical to V1 (no regression)
- TraceEvent visible in debug trace for assigned sessions
- `pnpm build --filter=apps/runtime` — clean

---

## Phase 4: Studio UI Updates

**Goal**: Replace version-string inputs with deployment pickers; improve success metrics and safety rules inputs; surface the one-active constraint proactively.

### Tasks

**4.1 Deployments proxy route** (new file: `apps/studio/src/app/api/projects/[id]/deployments/route.ts`)

Follow the exact pattern in `apps/studio/src/app/api/projects/[id]/experiments/route.ts`:

- `GET` — proxy `GET /api/projects/:projectId/deployments` to runtime
- No POST needed for this feature

**4.2 CreateExperimentDialog — deployment picker**

Read `apps/studio/src/components/experiments/CreateExperimentDialog.tsx` before editing (459 lines). The version selects are around lines 200–250.

Replace the two `controlVersion`/`experimentVersion` `<Select>` components with deployment selects:

```tsx
// Fetch on dialog open
const { data: deploymentsData } = useSWR(
  open ? `/api/projects/${projectId}/deployments?status=active` : null,
  fetcher,
);
const deploymentOptions =
  deploymentsData?.deployments?.map((d) => ({
    value: d._id,
    label: `${d.name} (${d.environment})`,
  })) ?? [];
```

Use `<Select>` from `components/ui/Select.tsx` (Radix-based — never native `<select>`).

Empty state message when no deployments: _"No active deployments. Deploy your agent first."_

Update `canSubmit`: require `controlDeploymentId` + `experimentDeploymentId` instead of version strings.

Update submit handler: send `{ assignmentMode: 'deployment', controlDeploymentId, experimentDeploymentId }`.

**4.3 Predefined success metrics**

Canonical list from ClickHouse `messages`/analytics schema:

```typescript
const PREDEFINED_METRICS = [
  'satisfaction_score',
  'goal_completion_rate',
  'resolution_rate',
  'handoff_rate',
  'avg_turns_to_resolution',
  'session_duration_seconds',
];
```

Replace free-text tag input with a multi-select combobox (Radix `<Command>` pattern already used elsewhere in Studio). Allow adding custom values not in the list.

**4.4 Safety rules metric input**

Replace raw `<input type="text">` for the metric column with a combobox using `PREDEFINED_METRICS` as suggestions. Custom input still allowed. Add tooltip: _"Analytics metric to monitor — experiment stops automatically if threshold is breached."_

**4.5 One-active constraint indicator**

On dialog open, fetch `GET /api/projects/:projectId/experiments?status=running`. If result array is non-empty, show an info banner above the form:

```
ℹ  A/B test "{name}" is currently running. Stop it before starting a new one.
```

Use `bg-muted text-muted-foreground` banner (not a destructive alert — just informational).

**4.6 ExperimentDetail.tsx — show deployment info**

Read `apps/studio/src/components/experiments/ExperimentDetail.tsx` before editing. Find where `controlVersion`/`experimentVersion` are rendered. Replace with deployment name + environment when `assignmentMode === 'deployment'`. Fall back to version string for legacy experiments.

### Exit Criteria

- Deployment picker loads active deployments from the proxy route
- Creating experiment via deployment picker sends `assignmentMode: 'deployment'` + deployment IDs
- Success metrics shows predefined list with custom input option
- Active experiment warning shown when project has a running experiment
- `pnpm build --filter=apps/studio` — clean (TypeScript + Next.js build)

---

## Phase 5: Deferred Test Coverage

**Goal**: Cover INT-6/7/8 without mocking platform components. All three use real MongoDB via MongoMemoryServer and inject only ClickHouseClient (external service).

### Tasks

**5.1 INT-6 — ClickHouse assignment write** (new: `apps/runtime/src/__tests__/integration/experiment-clickhouse.test.ts`)

- Start `RuntimeApiHarness` with full middleware chain
- Bootstrap project + agent + version + deployment (using existing helpers)
- Create and start experiment in `deployment` mode
- For assignment write: import `writeExperimentAssignment` directly (it is a pure function with DI-injected ClickHouseClient)
- Inject a mock `ClickHouseClient` (external third-party — allowed): `{ insert: vi.fn().mockResolvedValue(undefined) }`
- Call `writeExperimentAssignment({ ... }, mockClient)`
- Assert `mockClient.insert` was called with correct table name and payload shape:
  - `experiment_id`, `session_id`, `tenant_id`, `project_id`, `experiment_group`
  - `assignment_mode: 'deployment'`
  - `deployment_id` matches the assigned deployment

**5.2 INT-7 — Results computation** (new: `apps/runtime/src/__tests__/integration/experiment-results.test.ts`)

- Bootstrap project + agent + version + deployment + experiment via API
- Seed 20 sessions via `Session.create(...)` using MongoMemoryServer (direct — allowed for seeding)
  - 10 with `experimentGroup: 'control'`, 10 with `experimentGroup: 'experiment'`
  - Include realistic `experimentId` matching the created experiment
- Import `ExperimentResultsService` and call `computeResults(experimentId, tenantId, projectId)` directly
  - Inject a stub ClickHouseClient that returns prebuilt metric rows (avoids real ClickHouse)
- Assert results shape: `{ control: { n, metrics }, experiment: { n, metrics }, statistics: { tTest, chiSquared } }`
- Assert no errors thrown

**5.3 INT-8 — Guardrail auto-stop** (new: `apps/runtime/src/__tests__/integration/experiment-guardrail.test.ts`)

- Bootstrap project + experiment with one safety rule: `{ metric: 'satisfaction_score', operator: 'lt', threshold: 0.5, minSampleSize: 5, comparison: 'absolute' }`
- Start experiment via API
- Call `ExperimentResultsService.checkGuardrails()` with stubbed metrics that breach the rule (e.g., satisfaction_score = 0.2 with n=10)
- Assert:
  - Experiment document updated to `status: 'stopped'`, `stoppedReason: 'guardrail_breach'`
  - Audit log entry written (check `AuditLog.findOne({ action: 'experiment.guardrail_breach' })`)
  - Redis cache invalidated (re-fetch active experiment returns `null`)

**5.4 Add deployment-mode test to experiment-lifecycle.test.ts**

Add a describe block `INT-11: Deployment-based lifecycle`:

- Create + start experiment with `assignmentMode: 'deployment'`, `controlDeploymentId`, `experimentDeploymentId`
- Assert `201` create, `200` start, response includes `assignmentMode: 'deployment'`
- Stop → `status: 'stopped'`

**5.5 Add deployment-mode test to experiment-assignment.test.ts**

Add `INT-12: Deployment-mode assignment cache round-trip` **[Audit F-1 boundary test]**:

- Create deployment-mode experiment via API
- Start it via API
- Call `experimentService.getActiveExperiment(tenantId, projectId)` directly
- Assert returned `CachedExperiment` has `assignmentMode: 'deployment'`, `controlDeploymentId` populated, `experimentDeploymentId` populated — NOT undefined
- Kill Redis cache (`redis.del(key)`) and call again — verify DB re-read produces same result
- Confirm JSON serialize/deserialize round-trip preserves all three new fields

**5.6 Tier 1 vs Tier 2 deployment-mode test** **[Audit F-8 boundary test]**:

- Create deployment-mode experiment
- Create a session WITH `deploymentId` (Tier 1) → assert experiment assignment fires and `experimentGroup` is set
- Create a session WITHOUT `deploymentId` and WITHOUT `environment` (Tier 2 / working-copy path) → assert experiment assignment is SKIPPED (D-29 guard) and `experimentGroup` is NOT set
- Verify no poison: Tier 2 session has no `experimentId` in DB record

**5.7 Null-resolution degradation test** **[Audit F-5 boundary test]**:

- Create deployment-mode experiment with valid deployments
- Start experiment via API
- Delete the `experimentDeploymentId` deployment directly from DB (simulates stale reference)
- Create session with `deploymentId` of control deployment
- Assert: session creates successfully (non-blocking) AND has NO `experimentGroup`/`experimentId` set
- Assert: ClickHouse write was NOT called for this session

### Exit Criteria

- 5 new test files / describe blocks, all passing
- `pnpm test --filter=apps/runtime` integration tier — no regressions
- `pnpm test --filter=@agent-platform/pipeline-engine` — no regressions

---

## Wiring Checklist

- [ ] `controlDeploymentId`/`experimentDeploymentId` exported from `pipeline-engine/src/index.ts` (if types are exported)
- [ ] `resolveExperimentDeployment()` imported in `session-factory.ts`
- [ ] Studio proxy route registered at correct path (`/api/projects/[id]/deployments/route.ts`)
- [ ] **[F-1]** `assignmentMode`, `controlDeploymentId`, `experimentDeploymentId` in `getActiveExperiment()` DB projection AND `CachedExperiment` construction
- [ ] **[F-1]** All three new fields survive JSON stringify/parse Redis round-trip (verify with unit test)
- [ ] **[F-4]** ClickHouse DDL addition and writer update in the SAME Phase 1 commit
- [ ] **[F-3]** `assignExperimentToSession` deleted from `assign-experiment.ts`; `ExperimentAssignmentResult` type moved
- [ ] **[F-2]** `experimentVersion`/`controlVersion` access guarded behind `assignmentMode !== 'deployment'` check
- [ ] ClickHouse DDL migration idempotent (re-run on existing DB leaves schema intact)
- [ ] `experimentDeploymentId` persisted to DB session via `sdk-handler.ts` (check alongside existing `experimentId`/`experimentGroup`)

---

## Acceptance Criteria

- [ ] All 5 phases complete with exit criteria met
- [ ] Deployment-mode experiment routes session through the full deployment's multi-agent stack
- [ ] Version-mode experiments (V1) continue to work without regression
- [ ] Studio Create Experiment dialog uses deployment picker, predefined metrics
- [ ] INT-6/7/8 passing (ClickHouse write, results, guardrail)
- [ ] `pnpm build && pnpm test` (scoped to affected packages) — clean
- [ ] TraceEvent `experiment_assigned` visible in debug session trace
- [ ] `pnpm semgrep` — no new security findings

---

## Commit Plan

| Phase | Commit type | Scope               | Packages touched          |
| ----- | ----------- | ------------------- | ------------------------- |
| 1     | feat        | pipeline-engine, db | pipeline-engine, database |
| 2     | feat        | runtime/experiments | runtime                   |
| 3     | feat        | runtime/assignment  | runtime                   |
| 4     | feat        | studio/experiments  | studio                    |
| 5     | test        | runtime/integration | runtime                   |

Max 2 packages per commit. Phase 1 touches 2 (pipeline-engine + database) — acceptable.

---

## Out of Scope

- Migrating existing V1 experiments to deployment mode (V1 experiments remain valid)
- Deployment comparison UI (showing agent diff between control/experiment deployments)
- Experiment cloning/duplication
- Multi-variate (>2 group) experiments
