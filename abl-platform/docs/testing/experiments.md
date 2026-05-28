# Test Specification: Experiments / A/B Testing

**Feature Spec**: `docs/features/experiments.md`
**HLD**: `docs/specs/experiments.hld.md`
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                                            | Unit   | Integration | E2E                 | Status  |
| ----- | ------------------------------------------------------ | ------ | ----------- | ------------------- | ------- |
| FR-1  | Create experiment in draft                             | -      | -           | E2E-1               | PLANNED |
| FR-2  | One active experiment per project                      | -      | INT-1       | E2E-3               | PLANNED |
| FR-3  | Status transitions (draft->running->stopped/completed) | UNIT-1 | -           | E2E-2, E2E-4        | PLANNED |
| FR-4  | Validate agent versions at start                       | -      | INT-2       | E2E-3               | PLANNED |
| FR-5  | Stop ceases traffic splitting                          | -      | INT-3       | E2E-4               | PLANNED |
| FR-6  | Assign session to group based on traffic split         | UNIT-2 | INT-4       | E2E-5               | PLANNED |
| FR-7  | Sticky session assignment                              | UNIT-3 | INT-5       | E2E-6               | PLANNED |
| FR-8  | Assignment stored on session document                  | -      | INT-5       | E2E-5               | PLANNED |
| FR-9  | Deterministic hash-based assignment                    | UNIT-2 | -           | -                   | PLANNED |
| FR-10 | Session events include experiment group in ClickHouse  | -      | INT-6       | E2E-7               | PLANNED |
| FR-11 | Eval scores include experiment group                   | -      | INT-6       | -                   | PLANNED |
| FR-12 | Assignment counts in ClickHouse                        | -      | INT-6       | E2E-7               | PLANNED |
| FR-13 | Statistical significance computation                   | UNIT-4 | -           | E2E-8               | PLANNED |
| FR-14 | Results include sample size, p-values, CIs, lift       | UNIT-4 | -           | E2E-8               | PLANNED |
| FR-15 | Periodic results recomputation                         | -      | INT-7       | -                   | PLANNED |
| FR-16 | Guardrail metric comparison                            | UNIT-5 | INT-8       | E2E-9               | PLANNED |
| FR-17 | Auto-stop on guardrail breach                          | UNIT-5 | INT-8       | E2E-9               | PLANNED |
| FR-18 | Guardrail checks on computation schedule               | -      | INT-7       | -                   | PLANNED |
| FR-19 | Studio experiments page                                | -      | -           | E2E-10 (API)        | PLANNED |
| FR-20 | Experiment list with status summary                    | -      | -           | E2E-10 (API)        | PLANNED |
| FR-21 | Experiment detail with results                         | -      | -           | E2E-8               | PLANNED |
| FR-22 | Experiment creation form                               | -      | -           | E2E-1               | PLANNED |
| FR-23 | APIs under /api/projects/:projectId/experiments        | -      | INT-9       | E2E-1               | PLANNED |
| FR-24 | Full CRUD + lifecycle API                              | -      | -           | E2E-1 through E2E-4 | PLANNED |

### Existing Coverage (Pre-Feature)

The `ExperimentResultsService` has 7 unit tests in `packages/pipeline-engine/src/__tests__/experiment-results.test.ts`:

- tTest: significant difference detection, not significant for close means, equal groups
- chiSquared: significant proportion difference, equal proportions
- minSampleSizeForEffect: reasonable value, zero variance fallback
- confidenceInterval: brackets true difference, symmetric around difference

These cover the statistical methods but NOT the experiment lifecycle, traffic routing, ClickHouse integration, or API layer.

---

## 2. Unit Test Scenarios

### UNIT-1: Experiment Status Transitions

**Location**: `packages/pipeline-engine/src/__tests__/experiment-status.test.ts`

| #    | Test Case                                       | Expected                                       |
| ---- | ----------------------------------------------- | ---------------------------------------------- |
| U1-1 | Draft experiment can transition to running      | Status updated to `running`, `startedAt` set   |
| U1-2 | Running experiment can transition to stopped    | Status updated to `stopped`, `stoppedAt` set   |
| U1-3 | Running experiment can transition to completed  | Status updated to `completed`, `stoppedAt` set |
| U1-4 | Draft cannot transition to stopped or completed | Error thrown                                   |
| U1-5 | Stopped/completed cannot transition to running  | Error thrown                                   |
| U1-6 | Draft can be deleted                            | Document removed                               |
| U1-7 | Running experiment cannot be deleted            | Error thrown                                   |

### UNIT-2: Hash-Based Group Assignment

**Location**: `packages/pipeline-engine/src/__tests__/experiment-assignment.test.ts`

| #    | Test Case                                                       | Expected                               |
| ---- | --------------------------------------------------------------- | -------------------------------------- |
| U2-1 | Same (experimentId, sessionId) always returns same group        | Deterministic output                   |
| U2-2 | Different sessionIds produce mixed groups                       | Both 'control' and 'experiment' appear |
| U2-3 | Traffic split 0.5 produces ~50/50 distribution over 10K samples | Within +/- 2%                          |
| U2-4 | Traffic split 0.1 produces ~10% experiment over 10K samples     | Within +/- 2%                          |
| U2-5 | Traffic split 0.0 assigns all to control                        | 100% control                           |
| U2-6 | Traffic split 1.0 assigns all to experiment                     | 100% experiment                        |
| U2-7 | Assignment is purely based on hash, not timestamp or random     | Repeatable across calls                |

### UNIT-3: Session Stickiness Logic

**Location**: `packages/pipeline-engine/src/__tests__/experiment-stickiness.test.ts`

| #    | Test Case                                                                   | Expected                     |
| ---- | --------------------------------------------------------------------------- | ---------------------------- |
| U3-1 | Session with existing experimentGroup returns stored value                  | No re-assignment             |
| U3-2 | Session without experimentGroup but with active experiment gets assigned    | New assignment stored        |
| U3-3 | Session without experimentGroup and no active experiment gets no assignment | experimentGroup remains null |

### UNIT-4: Results Computation (extends existing tests)

**Location**: `packages/pipeline-engine/src/__tests__/experiment-results.test.ts`

| #    | Test Case                                                | Expected                                             |
| ---- | -------------------------------------------------------- | ---------------------------------------------------- |
| U4-1 | computeResults returns correct structure with all fields | groupMetrics, significance, sampleSizeAdequate       |
| U4-2 | Significance correctly computed for known data           | Matches manual calculation                           |
| U4-3 | sampleSizeAdequate is false when below minSampleSize     | Returns false with computed minimum                  |
| U4-4 | Lift percentage correctly computed                       | `(experimentMean - controlMean) / controlMean * 100` |
| U4-5 | Empty data returns zeroed results                        | No errors, all fields present                        |

### UNIT-5: Guardrail Evaluation

**Location**: `packages/pipeline-engine/src/__tests__/experiment-guardrails.test.ts`

| #    | Test Case                                                       | Expected                                       |
| ---- | --------------------------------------------------------------- | ---------------------------------------------- |
| U5-1 | Guardrail passes when experiment metric within threshold        | `{ breached: false }`                          |
| U5-2 | Guardrail breaches when experiment error rate exceeds threshold | `{ breached: true, metric, value, threshold }` |
| U5-3 | Multiple guardrails — first breach triggers                     | Returns first breached guardrail               |
| U5-4 | Guardrail with relative threshold (vs control)                  | Compares experiment vs control + margin        |
| U5-5 | Guardrail evaluation with insufficient data skips check         | `{ breached: false, skipped: true }`           |

---

## 3. Integration Test Scenarios (MANDATORY)

CRITICAL: Integration tests exercise real service boundaries with MongoMemoryServer and real ClickHouse test instance. No mocking of codebase components.

### INT-1: One Active Experiment Per Project

**Location**: `apps/runtime/src/__tests__/integration/experiment-uniqueness.test.ts`

- **Setup**: Start runtime on random port with MongoMemoryServer, create project and two experiments in draft
- **Steps**:
  1. Start experiment A via `POST /api/projects/:projectId/experiments/:idA/start`
  2. Attempt to start experiment B via `POST /api/projects/:projectId/experiments/:idB/start`
- **Expected**: Experiment B start returns 409 Conflict with `{ success: false, error: { code: 'EXPERIMENT_ALREADY_ACTIVE' } }`
- **Isolation**: Different project can start its own experiment concurrently

### INT-2: Version Validation at Start

**Location**: `apps/runtime/src/__tests__/integration/experiment-version-validation.test.ts`

- **Setup**: Create experiment referencing non-existent agent version IDs
- **Steps**: `POST /api/projects/:projectId/experiments/:id/start`
- **Expected**: 400 Bad Request with `{ success: false, error: { code: 'INVALID_AGENT_VERSION' } }`

### INT-3: Stop Ceases Traffic Splitting

**Location**: `apps/runtime/src/__tests__/integration/experiment-stop.test.ts`

- **Setup**: Running experiment with 50/50 split, create sessions to verify splitting works
- **Steps**:
  1. Stop experiment via `POST /api/projects/:projectId/experiments/:id/stop`
  2. Create new sessions
- **Expected**: All new sessions after stop have no `experimentId`/`experimentGroup`

### INT-4: Session Assignment Distribution

**Location**: `apps/runtime/src/__tests__/integration/experiment-assignment.test.ts`

- **Setup**: Running experiment with 70/30 split
- **Steps**: Create 100 sessions via API
- **Expected**: Approximately 70 control / 30 experiment (+/- 10% for small sample)

### INT-5: Session Stickiness Across Requests

**Location**: `apps/runtime/src/__tests__/integration/experiment-stickiness.test.ts`

- **Setup**: Running experiment, create session
- **Steps**:
  1. Create session (gets assigned to group)
  2. Send multiple messages to same session
  3. Retrieve session via API
- **Expected**: `experimentGroup` remains the same across all interactions; session uses the correct agent version for its group

### INT-6: ClickHouse Event Tagging

**Location**: `packages/pipeline-engine/src/__tests__/integration/experiment-clickhouse.test.ts`

- **Setup**: Running experiment, sessions with assignments
- **Steps**: Insert session events with experiment metadata into ClickHouse test instance
- **Expected**: Query by `experiment_id` and `experiment_group` returns correct partitioned data

### INT-7: Periodic Results Computation

**Location**: `packages/pipeline-engine/src/__tests__/integration/experiment-results-cron.test.ts`

- **Setup**: Running experiment with seeded ClickHouse data
- **Steps**: Trigger results computation
- **Expected**: Experiment document updated with computed results including significance, sample sizes, guardrail status

### INT-8: Guardrail Auto-Stop

**Location**: `apps/runtime/src/__tests__/integration/experiment-guardrail-stop.test.ts`

- **Setup**: Running experiment with guardrail `errorRate < 0.05`, seeded ClickHouse data showing experiment error rate of 0.10
- **Steps**: Trigger guardrail check
- **Expected**: Experiment status transitions to `stopped`, `stoppedReason: 'guardrail_breach'`, `guardrailBreachDetail` populated

### INT-9: Tenant/Project Isolation

**Location**: `apps/runtime/src/__tests__/integration/experiment-isolation.test.ts`

- **Setup**: Two tenants (A, B) each with a project
- **Steps**:
  1. Tenant A creates experiment in Project P1
  2. Tenant B attempts to read/modify experiment in P1
- **Expected**: 404 for all cross-tenant operations (not 403)

---

## 4. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers.

### E2E-1: Create Experiment via API

- **Preconditions**: Project exists with two agent versions (v1 and v2)
- **Steps**:
  1. `POST /api/projects/:projectId/experiments` with `{ name: 'Test v1 vs v2', controlVersion: v1._id, experimentVersion: v2._id, trafficSplit: 0.8, successMetrics: ['containment_rate'], guardrailMetrics: [{ name: 'error_rate', threshold: 0.05 }] }`
  2. Assert 201 response with experiment in `draft` status
  3. `GET /api/projects/:projectId/experiments` — assert experiment appears in list
  4. `GET /api/projects/:projectId/experiments/:id` — assert all fields match creation payload
- **Auth**: Requires `experiment:write` permission in project
- **FR Coverage**: FR-1, FR-23, FR-24

### E2E-2: Start Experiment

- **Preconditions**: Experiment in `draft` status, both agent versions exist
- **Steps**:
  1. `POST /api/projects/:projectId/experiments/:id/start`
  2. Assert 200 response with status `running`, `startedAt` populated
  3. `GET /api/projects/:projectId/experiments/:id` — confirm status persisted
- **FR Coverage**: FR-3, FR-4

### E2E-3: Enforce Single Active Experiment

- **Preconditions**: One experiment already `running`
- **Steps**:
  1. Create second experiment in `draft`
  2. `POST /api/projects/:projectId/experiments/:id2/start`
  3. Assert 409 response with error code `EXPERIMENT_ALREADY_ACTIVE`
- **FR Coverage**: FR-2, FR-4

### E2E-4: Stop Running Experiment

- **Preconditions**: Experiment in `running` status
- **Steps**:
  1. `POST /api/projects/:projectId/experiments/:id/stop`
  2. Assert 200 response with status `stopped`, `stoppedAt` populated
  3. Create new session — assert no `experimentId` on session
- **FR Coverage**: FR-3, FR-5

### E2E-5: Session Assignment on Running Experiment

- **Preconditions**: Experiment `running` with `trafficSplit: 0.5`
- **Steps**:
  1. Create 20 sessions via the session creation API
  2. For each session, `GET /api/projects/:projectId/sessions/:id`
  3. Assert each session has `experimentId` and `experimentGroup` fields
  4. Assert distribution is approximately 50/50 (between 6 and 14 in each group for n=20)
- **FR Coverage**: FR-6, FR-8, FR-9

### E2E-6: Session Stickiness Verification

- **Preconditions**: Running experiment, session created with group assignment
- **Steps**:
  1. Create session (assigned to, e.g., `experiment` group)
  2. Send 5 messages to the session
  3. `GET /api/projects/:projectId/sessions/:id` — assert `experimentGroup` unchanged
  4. Verify response came from the experiment agent version (via trace events or response metadata)
- **FR Coverage**: FR-7

### E2E-7: Metrics Collection with Experiment Group

- **Preconditions**: Running experiment, sessions created and completed in both groups
- **Steps**:
  1. Create and complete sessions in both groups
  2. `POST /api/projects/:projectId/experiments/:id/results` — trigger results computation
  3. Assert results contain per-group sample sizes matching created session counts
- **FR Coverage**: FR-10, FR-12

### E2E-8: Results with Statistical Significance

- **Preconditions**: Running experiment with sufficient session data in both groups
- **Steps**:
  1. `GET /api/projects/:projectId/experiments/:id` — include results
  2. Assert response contains `results.controlGroup`, `results.experimentGroup`, `results.significance[]`
  3. Assert each significance entry has: `metric`, `controlMean`, `experimentMean`, `pValue`, `significant`, `confidenceInterval`, `lift`
  4. Assert `sampleSizeAdequate` field present
- **FR Coverage**: FR-13, FR-14, FR-21

### E2E-9: Guardrail Auto-Stop

- **Preconditions**: Running experiment with guardrail `error_rate < 0.05`
- **Steps**:
  1. Create sessions in experiment group that result in errors (e.g., invoke with bad input to trigger agent errors)
  2. Trigger results/guardrail computation via `POST /api/projects/:projectId/experiments/:id/results`
  3. If experiment error rate > threshold, assert experiment status is now `stopped`
  4. Assert `stoppedReason` is `guardrail_breach`
- **FR Coverage**: FR-16, FR-17

### E2E-10: Experiment List and Filter

- **Preconditions**: Multiple experiments in different statuses (draft, stopped, completed)
- **Steps**:
  1. `GET /api/projects/:projectId/experiments` — assert all appear
  2. `GET /api/projects/:projectId/experiments?status=draft` — assert only draft experiments returned
  3. Assert list includes: name, status, date range, sample sizes summary
- **FR Coverage**: FR-19, FR-20

### E2E-11: Tenant Isolation

- **Preconditions**: Tenant A has an experiment in Project P1
- **Steps**:
  1. Authenticate as Tenant B
  2. `GET /api/projects/:projectId/experiments/:id` (using Tenant A's experiment ID and project ID)
  3. Assert 404 (not 403)
- **FR Coverage**: FR-23, NFR-3

### E2E-12: Update Draft Experiment

- **Preconditions**: Experiment in `draft` status
- **Steps**:
  1. `PUT /api/projects/:projectId/experiments/:id` with updated `trafficSplit: 0.3`
  2. Assert 200 response with updated traffic split
  3. Attempt `PUT` on a `running` experiment — assert 400 (cannot modify running experiment)
- **FR Coverage**: FR-24

---

## 5. Performance Test Scenarios

### PERF-1: Session Assignment Latency

- **Goal**: Verify FR-6 traffic routing adds < 5ms to session creation
- **Method**: Create 1000 sessions with and without active experiment; compare P99 latency
- **Pass Criteria**: Delta < 5ms at P99

### PERF-2: Results Computation at Scale

- **Goal**: Verify NFR-2 results computation for 10K sessions within 30 seconds
- **Method**: Seed ClickHouse with 10K session records; trigger computation
- **Pass Criteria**: Completion < 30 seconds

### PERF-3: Traffic Distribution Accuracy

- **Goal**: Verify NFR-5 uniform distribution within +/- 2%
- **Method**: Create 10K sessions with 50/50 split; count distribution
- **Pass Criteria**: Each group has 4800-5200 sessions

---

## 6. Edge Cases

| #      | Scenario                                                   | Expected Behavior                                                                                            |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| EDGE-1 | Experiment started with traffic split 0.01 (1% experiment) | Valid; most sessions go to control                                                                           |
| EDGE-2 | Experiment agent version deleted after experiment started  | Existing sessions continue with cached IR; new sessions to deleted version fail gracefully with error logged |
| EDGE-3 | Multiple rapid start/stop transitions                      | Each transition atomic; no intermediate states                                                               |
| EDGE-4 | Session created exactly at experiment stop moment          | Race condition handled — session either gets assignment or doesn't; no crash                                 |
| EDGE-5 | Experiment with 0 sessions when results requested          | Returns empty results with `sampleSizeAdequate: false`                                                       |
| EDGE-6 | ClickHouse unavailable during results computation          | Error logged, experiment continues; results endpoint returns stale data with `staleAt` timestamp             |
| EDGE-7 | Two concurrent requests to start the same experiment       | Idempotent — first succeeds, second returns current state or conflict                                        |
