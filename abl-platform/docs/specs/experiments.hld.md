# HLD: Experiments / A/B Testing

**Feature Spec**: `docs/features/experiments.md`
**Test Spec**: `docs/testing/experiments.md`
**Status**: NEEDS_REVIEW
**Author**: Platform team
**Date**: 2026-03-23
**Last Updated**: 2026-04-28

---

## 1. Problem Statement

The ABL platform has agent versioning (`AgentVersion`), deployments (`Deployment`), and scaffolded experiment infrastructure (`ExperimentModel`, `ExperimentResultsService`) — but no end-to-end A/B testing capability. Teams cannot run two agent versions simultaneously on live traffic, measure performance differences with statistical rigor, or auto-stop experiments when quality degrades. This forces all-or-nothing deployments with no controlled comparison.

---

## 2. Alternatives Considered

### Option A: Runtime-Integrated Experiments (Recommended)

- **Description**: Extend the runtime to support experiment-aware session creation. When a running experiment exists for a project, new sessions are hash-assigned to control/experiment groups. The runtime resolves the correct agent version based on the group. Results are computed by the pipeline-engine from ClickHouse data. Studio proxies experiment APIs.
- **Pros**: Uses existing runtime session lifecycle (single place for traffic routing). Hash-based assignment is stateless (< 1ms overhead). Extends existing ExperimentModel scaffolding. Leverages existing ClickHouse analytics pipeline for metric collection.
- **Cons**: Runtime must be aware of experiments (new middleware). Session model needs new fields.
- **Effort**: L (Large) — touches runtime, pipeline-engine, database, Studio

### Option B: External Experiment Service

- **Description**: Deploy a separate microservice that handles experiment assignment and results. Runtime calls this service on session creation to get group assignment. Service manages its own database.
- **Pros**: Clean separation of concerns. Experiment logic isolated from runtime.
- **Cons**: New service to deploy, monitor, and scale. Additional network hop on every session creation (latency). New database to manage. Duplicates data already in ClickHouse. Over-engineered for the current scale.
- **Effort**: XL — new service, new infrastructure

### Option C: Client-Side Assignment (SDK-Based)

- **Description**: The web-sdk or channel integration assigns the experiment group before creating a session. The SDK calls the experiment API to get the active experiment and assignment, then passes the group as session metadata.
- **Pros**: Zero runtime modification. Assignment happens at the edge.
- **Cons**: Cannot enforce server-side assignment — clients can tamper. SDK changes required across all channel integrations (web, voice, API). No sticky assignment for channels without client state (e.g., voice). Assignment logic duplicated in every SDK.
- **Effort**: L — SDK changes across multiple platforms

### Recommendation: Option A (Runtime-Integrated)

**Rationale**: The runtime already owns session creation and agent version resolution — the two critical touch points for A/B testing. Adding experiment awareness to the runtime is a natural extension, not a foreign concern. The hash-based assignment adds negligible latency (< 1ms). The existing `ExperimentModel` and `ExperimentResultsService` scaffolding in pipeline-engine provides a head start. Option B is over-engineered for this stage, and Option C cannot guarantee assignment integrity.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        End User (Browser / SDK)                      │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ WebSocket / HTTP
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Runtime (Express, port 3112)                       │
│                                                                       │
│  ┌─────────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │ Session Creator  │→│ Experiment Assigner │→│ Version Resolver  │  │
│  │ (existing)       │  │ (new middleware)    │  │ (existing, ext.) │  │
│  └─────────────────┘  └────────────────────┘  └──────────────────┘  │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  Experiment Routes: /api/projects/:projectId/experiments        │  │
│  │  POST / GET / GET :id / PUT :id / POST :id/start|stop|results  │  │
│  └────────────────────────────────────────┬────────────────────────┘  │
└───────────────────────────────────────────┼──────────────────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
         ┌──────────────┐      ┌──────────────────┐    ┌──────────────┐
         │   MongoDB     │      │   ClickHouse      │    │   Redis      │
         │ experiments   │      │ experiment_       │    │ distributed  │
         │ sessions      │      │ assignments       │    │ locks        │
         │ agent_versions│      │ (+ analytics      │    │ experiment   │
         │               │      │  tables extended) │    │ cache        │
         └──────────────┘      └──────────────────┘    └──────────────┘
                                       ▲
                                       │
         ┌─────────────────────────────┘
         │
┌────────┴──────────────────────────────────────────────────────────┐
│                Pipeline Engine (Restate Workers)                    │
│                                                                     │
│  ┌───────────────────────────┐  ┌───────────────────────────────┐  │
│  │ ExperimentResultsService  │  │ Guardrail Evaluator           │  │
│  │ (existing, extended)      │  │ (new)                         │  │
│  │ - queryMetricsByGroup()   │  │ - checkGuardrails()           │  │
│  │ - computeSignificance()   │  │ - autoStop() if breached      │  │
│  └───────────────────────────┘  └───────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────┐                                     │
│  │ Cron: Experiment Results  │                                     │
│  │ (every 1 hour)            │                                     │
│  └───────────────────────────┘                                     │
└────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Proxy API
                                       ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Studio (Next.js, port 5173)                      │
│                                                                     │
│  ┌──────────────────────┐  ┌────────────────────────────────────┐  │
│  │ Experiments Page      │  │ Experiment Detail                  │  │
│  │ - List experiments    │  │ - Config view                     │  │
│  │ - Create new          │  │ - Results chart                   │  │
│  │ - Status filters      │  │ - Significance indicators         │  │
│  │                        │  │ - Guardrail status                │  │
│  │                        │  │ - Start/Stop/Conclude buttons     │  │
│  └──────────────────────┘  └────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ API Proxy: /api/projects/[id]/experiments → Runtime          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component                                                | Responsibility                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Experiment Assigner** (runtime, new)                   | On session creation: lookup active experiment for project (Redis-cached), compute hash assignment, set `experimentId`/`experimentGroup` on session         |
| **Version Resolver** (runtime, extended)                 | When session has `experimentGroup`, resolve the agent version from the experiment config (control or experiment version) instead of the default deployment |
| **Experiment Routes** (runtime, new)                     | CRUD + lifecycle API for experiments, project-scoped with tenant isolation                                                                                 |
| **ExperimentResultsService** (pipeline-engine, extended) | Query ClickHouse for per-group metrics, compute statistical significance, determine sample size adequacy                                                   |
| **Guardrail Evaluator** (pipeline-engine, new)           | Evaluate guardrail metrics against thresholds, trigger auto-stop via MongoDB update + Redis cache invalidation                                             |
| **Experiment Cron** (pipeline-engine, new)               | Periodic job that recomputes results and checks guardrails for all running experiments                                                                     |
| **Studio Proxy** (studio, new)                           | Thin API route that proxies experiment requests to runtime                                                                                                 |
| **Studio UI** (studio, new)                              | Experiments list page, detail page with results visualization, creation form                                                                               |

---

## 4. Data Model

### 4.1 MongoDB: Experiment (Extended)

Extends existing `packages/pipeline-engine/src/schemas/experiment.schema.ts`:

```typescript
interface IExperiment {
  // Existing fields
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  status: 'draft' | 'running' | 'stopped' | 'completed';
  controlVersion: string; // AgentVersion._id
  experimentVersion: string; // AgentVersion._id
  trafficSplit: number; // 0.0-1.0 (fraction going to experiment)
  successMetrics: string[]; // Metric names to compare
  safetyMetrics: string[]; // Deprecated — replaced by safetyRules
  startedAt?: Date;
  stoppedAt?: Date;
  createdBy: string;

  // New fields
  channels: string[]; // Optional channel filter (empty = all channels apply)
  safetyRules: ExperimentSafetyRule[]; // Structured guardrail definitions
  stoppedReason?: 'manual' | 'safety_breach' | 'completed';
  breachDetail?: {
    metric: string;
    value: number;
    threshold: number;
    checkedAt: Date;
  };
  lastResultsAt?: Date; // When results were last computed
  results?: ExperimentResults; // Cached latest results
  controlAssignments: number; // Running count (updated by cron)
  experimentAssignments: number; // Running count (updated by cron)
}

interface ExperimentSafetyRule {
  metric: string; // e.g., 'error_rate', 'avg_latency_ms'
  operator: 'lt' | 'gt' | 'lte' | 'gte'; // Comparison operator
  threshold: number; // Threshold value (absolute, or ratio for relative mode)
  minSampleSize: number; // Minimum samples before enforcement
  comparison: 'absolute' | 'relative_to_control'; // Comparison mode
  // For 'absolute': threshold is compared directly against the experiment group metric value
  // For 'relative_to_control': threshold is a ratio (e.g., 0.2 = 20% worse than control)
}
```

### 4.2 MongoDB: Session (Extended)

Add fields to existing `packages/database/src/models/session.model.ts`:

```typescript
interface ISession {
  // ... existing fields ...

  // New experiment fields
  experimentId?: string; // References Experiment._id
  experimentGroup?: 'control' | 'experiment'; // Assigned group
}
```

**A2A child session inheritance**: When a session has `parentId` set (A2A child session), the `experimentId` and `experimentGroup` are copied from the parent session. No new hash assignment is performed — the child inherits the parent's experiment context to ensure consistent behavior within a single conversation flow.

### 4.3 ClickHouse: Experiment Assignments Table (New)

```sql
CREATE TABLE abl_platform.experiment_assignments (
    tenant_id        String              CODEC(ZSTD(1)),
    project_id       String              CODEC(ZSTD(1)),
    experiment_id    String              CODEC(ZSTD(1)),
    session_id       String              CODEC(ZSTD(1)),
    experiment_group LowCardinality(String) CODEC(ZSTD(1)),
    agent_version_id String              CODEC(ZSTD(1)),
    created_at       DateTime64(3)       CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_experiment experiment_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_group      experiment_group TYPE set(2) GRANULARITY 4
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, experiment_id, experiment_group, session_id)
TTL toDateTime(created_at) + INTERVAL 365 DAY DELETE
```

### 4.4 ClickHouse: Extended Analytics Tables

Add `experiment_id` and `experiment_group` columns to existing tables:

- `conversation_sentiment` — for sentiment comparison
- `conversation_intent` — for intent distribution comparison
- `conversation_quality` — for quality metric comparison
- `eval_production_scores` — for eval score comparison
- `session_summary` (if exists) — for session outcome comparison

These are `DEFAULT ''` columns — empty for non-experiment sessions, populated when session has experiment metadata.

### 4.5 Redis: Experiment Cache

```
Key:    experiment:active:{projectId}
Value:  JSON { experimentId, controlVersion, experimentVersion, trafficSplit }
TTL:    300s (5 minutes)
Evict:  On experiment start/stop
```

This avoids a MongoDB query on every session creation. Cache miss falls back to MongoDB `findOne({ projectId, status: 'running' })`.

### 4.6 Session Eligibility Rules

Before experiment assignment, a session must pass three eligibility checks. If any check fails, the session proceeds without experiment assignment.

1. **Skip studio/debug sessions**: If `source.type === 'studio'`, the session is excluded. Debug sessions are project-owned (not end-user-owned) and would skew experiment results with internal testing traffic.

2. **Skip A2A child sessions (inherit from parent)**: If `session.parentId` is set, the session is an A2A child. Instead of performing a new hash assignment, look up the parent session's `experimentId` and `experimentGroup` and copy them to the child. This ensures the entire A2A conversation tree receives a consistent agent version.

3. **Channel filter**: If the active experiment has a non-empty `channels` array, check whether the session's channel is in the list. If the session's channel is NOT in the experiment's `channels` list, skip assignment. An empty `channels` array (the default) means the experiment applies to all channels.

These checks are evaluated in order. Studio sessions are rejected outright (step 1). A2A children inherit rather than hash-assign (step 2). Channel filtering narrows the eligible traffic further (step 3). Only sessions that pass all three checks proceed to the hash-based group assignment.

---

## 5. API Design

### 5.1 Runtime Experiment APIs

All under `/api/projects/:projectId/experiments`. Auth: `requireAuth` + `requireProjectPermission`.

| Method   | Path                      | Permission         | Description                                            |
| -------- | ------------------------- | ------------------ | ------------------------------------------------------ |
| `POST`   | `/`                       | `experiment:write` | Create experiment (draft)                              |
| `GET`    | `/`                       | `experiment:read`  | List experiments (with optional `?status=` filter)     |
| `GET`    | `/:experimentId`          | `experiment:read`  | Get experiment detail with cached results              |
| `PUT`    | `/:experimentId`          | `experiment:write` | Update draft experiment (400 if not draft)             |
| `DELETE` | `/:experimentId`          | `experiment:write` | Delete draft experiment (400 if not draft)             |
| `POST`   | `/:experimentId/start`    | `experiment:write` | Start experiment (transitions draft -> running)        |
| `POST`   | `/:experimentId/stop`     | `experiment:write` | Stop experiment (transitions running -> stopped)       |
| `POST`   | `/:experimentId/complete` | `experiment:write` | Complete experiment (transitions running -> completed) |
| `POST`   | `/:experimentId/results`  | `experiment:read`  | Trigger on-demand results recomputation                |

### 5.2 Request/Response Schemas

**Create Experiment (POST /)**:

```json
{
  "name": "Test v1.2 vs v1.3",
  "description": "Testing new prompt structure",
  "controlVersion": "agent-version-uuid-1",
  "experimentVersion": "agent-version-uuid-2",
  "trafficSplit": 0.2,
  "channels": ["web", "voice"],
  "successMetrics": ["containment_rate", "avg_quality_score"],
  "safetyRules": [
    {
      "metric": "error_rate",
      "operator": "lt",
      "threshold": 0.05,
      "minSampleSize": 100,
      "comparison": "absolute"
    }
  ]
}
```

**Experiment Detail (GET /:experimentId)**:

```json
{
  "success": true,
  "data": {
    "_id": "experiment-uuid",
    "name": "Test v1.2 vs v1.3",
    "status": "running",
    "trafficSplit": 0.2,
    "controlVersion": "agent-version-uuid-1",
    "experimentVersion": "agent-version-uuid-2",
    "controlAssignments": 812,
    "experimentAssignments": 188,
    "startedAt": "2026-03-23T10:00:00Z",
    "results": {
      "controlGroup": {
        "group": "control",
        "sampleSize": 812,
        "metrics": { "containment_rate": 0.73 }
      },
      "experimentGroup": {
        "group": "experiment",
        "sampleSize": 188,
        "metrics": { "containment_rate": 0.81 }
      },
      "significance": [
        {
          "metric": "containment_rate",
          "controlMean": 0.73,
          "experimentMean": 0.81,
          "pValue": 0.012,
          "significant": true,
          "confidenceInterval": [0.02, 0.14],
          "lift": 10.96
        }
      ],
      "sampleSizeAdequate": true,
      "minSampleSize": 150,
      "computedAt": "2026-03-23T14:00:00Z"
    },
    "guardrailStatus": {
      "allPassing": true,
      "checks": [{ "metric": "error_rate", "value": 0.02, "threshold": 0.05, "passing": true }]
    }
  }
}
```

### 5.3 Zod Validation Schemas

```typescript
const createExperimentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  controlVersion: z.string().min(1), // Agent version ID
  experimentVersion: z.string().min(1), // Agent version ID
  trafficSplit: z.number().min(0.01).max(0.99),
  channels: z.array(z.string().min(1)).default([]), // Empty = all channels
  successMetrics: z.array(z.string().min(1)).min(1).max(10),
  safetyRules: z
    .array(
      z.object({
        metric: z.string().min(1),
        operator: z.enum(['lt', 'gt', 'lte', 'gte']),
        threshold: z.number(),
        minSampleSize: z.number().int().min(10).default(100),
        comparison: z.enum(['absolute', 'relative_to_control']).default('absolute'),
      }),
    )
    .max(10)
    .default([]),
});

const updateExperimentSchema = createExperimentSchema.partial();
```

---

## 6. Traffic Routing Design

### 6.1 Assignment Algorithm

```typescript
function getAssignmentKey(session: ISession): string {
  // Use contactId for sticky cross-session assignment when available
  // (public/channel sessions). Fall back to sessionId for anonymous sessions.
  return session.contactId || session.sessionId;
}

function assignExperimentGroup(
  experimentId: string,
  assignmentKey: string,
  trafficSplit: number,
): 'control' | 'experiment' {
  // FNV-1a hash of concatenated IDs for speed and uniformity
  const hash = fnv1aHash(experimentId + ':' + assignmentKey);
  const bucket = hash % 10000; // 0-9999 for 0.01% granularity
  return bucket < trafficSplit * 10000 ? 'experiment' : 'control';
}
```

**Sticky key selection**: The assignment key is `contactId` when available (public/channel sessions where the end-user is identified), falling back to `sessionId`. This ensures the same end-user always gets the same experiment group across multiple sessions, preventing inconsistent experiences. The hash is deterministic: `fnv1aHash(experimentId + ':' + contactId)` always produces the same bucket for the same user+experiment combination.

FNV-1a chosen for:

- Speed: ~2ns per hash (vs ~50ns for SHA-256)
- Uniformity: Excellent distribution for string inputs
- Determinism: Same input always produces same output
- No crypto dependency: No need for `crypto` module

### 6.2 Session Creation Flow

```
1. Client creates session → POST /api/sessions or WebSocket connect
2. Runtime session creator runs
3. NEW: Eligibility check — skip studio sessions
   a. If source.type === 'studio' → proceed without experiment (debug traffic excluded)
4. NEW: Eligibility check — A2A child sessions inherit from parent
   a. If session.parentId is set → look up parent session
   b. Copy parent's experimentId and experimentGroup to child session
   c. Skip to step 8 (no new hash assignment)
5. NEW: Check Redis cache for active experiment: experiment:active:{projectId}
6. If cache miss: Query MongoDB for findOne({ projectId, status: 'running', tenantId })
7. If no experiment → proceed normally (no assignment)
8. NEW: Eligibility check — channel filter
   a. If experiment.channels is non-empty AND session channel NOT in experiment.channels
      → proceed without experiment (channel not targeted)
9. If experiment found and eligible:
   a. Compute assignmentKey = session.contactId || session.sessionId
   b. assignExperimentGroup(experimentId, assignmentKey, trafficSplit)
   c. Set session.experimentId = experimentId
   d. Set session.experimentGroup = group
   e. Write ClickHouse assignment record (async, non-blocking)
10. Version Resolver uses session.experimentGroup to select:
    - 'control' → experiment.controlVersion
    - 'experiment' → experiment.experimentVersion
11. Agent loaded with the resolved version's IR
```

### 6.3 Sticky Assignment

Once `session.experimentGroup` is set on the session document:

- All subsequent requests for that session read the group from the session, NOT from the experiment config
- If the experiment is stopped mid-session, the session continues with its assigned version (graceful degradation)
- The experiment config can change (e.g., traffic split updated) without affecting existing sessions
- Cross-session stickiness: when `contactId` is used as the assignment key, the same end-user deterministically hashes to the same group across all their sessions for a given experiment. This prevents the same user from experiencing different agent versions on different visits.

---

## 7. Twelve Architectural Concerns

### 7.1 Tenant Isolation

- All experiment queries include `tenantId` in the filter
- `findOne({ _id: experimentId, tenantId, projectId })` — never `findById`
- Cross-tenant experiment access returns 404
- ClickHouse queries include `tenant_id` filter
- Redis cache key includes `projectId` (which is tenant-scoped)

### 7.2 Authentication & Authorization

- Experiment routes use `requireAuth` + `requireProjectPermission`
- New permissions: `experiment:read`, `experiment:write`
- Session assignment is server-side (no client-side permission needed for assignment)
- Studio proxy verifies tenant auth + project access before forwarding

### 7.3 Performance

- **Session creation**: Redis cache lookup (< 1ms) + FNV-1a hash (< 1ms) = < 2ms overhead
- **Cache miss**: MongoDB query adds ~5ms (once per 5 minutes per project)
- **ClickHouse assignment write**: Async fire-and-forget (non-blocking)
- **Results computation**: ClickHouse aggregation, batch per cron interval (not per-request)
- No performance impact on sessions not in an experiment (cache returns null)

### 7.4 Scalability

- Hash-based assignment is stateless — scales linearly with runtime replicas
- Redis cache ensures MongoDB is not hammered on session creation
- ClickHouse handles large experiment datasets via partitioning and MVs
- One-experiment-per-project limit prevents combinatorial explosion
- Results cron is distributed-lock protected (only one worker computes per experiment)

### 7.5 Reliability

- Session assignment failure (Redis down, MongoDB down) falls through to no experiment — graceful degradation
- ClickHouse assignment write failure is logged but does not block session creation
- Results computation failure is logged; stale results shown with `computedAt` timestamp
- Guardrail auto-stop uses Redis distributed lock to prevent double-stop
- Experiment start validates version existence to prevent assignment to deleted versions

### 7.6 Observability

- TraceEvents emitted for: experiment assignment, version resolution, results computation, guardrail check, auto-stop
- Logger contexts: `experiment-assigner`, `experiment-routes`, `experiment-results-cron`, `experiment-safety`
- Metrics (for future Prometheus integration): experiment_assignments_total, experiment_results_computation_duration_ms, experiment_safety_breaches_total

### 7.7 Security

- Experiment APIs require RBAC permissions (`experiment:read`, `experiment:write`)
- Agent version IDs validated against existing versions (no arbitrary version injection)
- Traffic split bounded to 0.01-0.99 (cannot route 0% or 100% via experiment — use deployment for that)
- Guardrail thresholds validated as positive numbers
- No user PII in experiment data — only session IDs and aggregate metrics
- Channel scoping provides an additional isolation mechanism: experiments can be restricted to specific channels via the `channels` field, preventing unintended exposure of experimental versions to channels that are not ready (e.g., limiting an experiment to `web` while excluding `voice`)

### 7.8 Data Consistency

- Experiment status transitions are atomic MongoDB operations with optimistic locking (`_v` field)
- One-active-per-project enforced via MongoDB partial unique index on `(projectId, status)` where `status = 'running'`
- Session assignment is set once at creation, never modified (immutable after set)
- Results are eventually consistent (cron interval) — acceptable for analytics

### 7.9 Compliance

- Experiment data includes no PII — `session_id` is NOT considered PII, no pseudonymization needed in ClickHouse
- Session assignment is metadata (which group), not content
- ClickHouse TTL (365 days) on experiment_assignments table
- No DEK envelope encryption needed — project-scoped RBAC access control is sufficient for experiment data
- **Right-to-erasure**: When a session is erased (right-to-erasure pipeline), the corresponding ClickHouse assignment row is deleted via `ALTER TABLE abl_platform.experiment_assignments DELETE WHERE session_id = {sessionId} AND tenant_id = {tenantId}`. This wires into the existing session erasure pipeline — the experiment assignment deletion is added as a step alongside existing session data cleanup. Note: ClickHouse `ALTER TABLE DELETE` is asynchronous (mutation-based), which is acceptable for compliance — the deletion is enqueued immediately and executes within the ClickHouse mutation queue.
- **Guardrail breach audit log**: When a guardrail auto-stop fires, an audit log entry is written via the platform's audit logging system, recording the experiment ID, breached metric, threshold, observed value, and timestamp. No notifications are sent for now — the audit log serves as the compliance trail for automated experiment termination.

### 7.10 Error Handling

- Version not found at start → 400 with `INVALID_AGENT_VERSION`
- Active experiment already exists → 409 with `EXPERIMENT_ALREADY_ACTIVE`
- Modify non-draft experiment → 400 with `EXPERIMENT_NOT_DRAFT`
- Delete running experiment → 400 with `EXPERIMENT_RUNNING`
- ClickHouse query failure → log error, return stale results with `staleAt`
- All errors return `{ success: false, error: { code, message } }` envelope

### 7.11 Migration Strategy

- New Session fields (`experimentId`, `experimentGroup`) are optional — no migration needed
- ExperimentModel extension adds new fields with defaults — backward compatible
- ClickHouse new table (`experiment_assignments`) is additive
- ClickHouse column additions (`experiment_id`, `experiment_group`) are `DEFAULT ''` — no data migration
- Feature is opt-in: no experiment → no behavior change

### 7.12 Testing Strategy

- See `docs/testing/experiments.md` for complete test specification
- Unit tests for hash assignment, status transitions, guardrail evaluation
- Integration tests for session assignment, ClickHouse integration, tenant isolation
- E2E tests for full API lifecycle
- Performance tests for assignment latency and results computation

---

## 8. Sequence Diagrams

### 8.1 Session Creation with Experiment

```
Client              Runtime                 Redis               MongoDB         ClickHouse
  │                    │                      │                    │                │
  │─── Create Session ─▶                      │                    │                │
  │                    │── GET active exp ────▶│                    │                │
  │                    │◀── cache hit ────────│                    │                │
  │                    │                      │                    │                │
  │                    │── hash(expId, sessId) │                    │                │
  │                    │   → 'experiment'      │                    │                │
  │                    │                      │                    │                │
  │                    │── Save session ──────────────────────────▶│                │
  │                    │   (experimentId,      │                    │                │
  │                    │    experimentGroup)    │                    │                │
  │                    │                      │                    │                │
  │                    │── Write assignment ──────────────────────────────────────▶│
  │                    │   (async, non-block)  │                    │                │
  │                    │                      │                    │                │
  │                    │── Resolve version     │                    │                │
  │                    │   (experiment version) │                    │                │
  │                    │                      │                    │                │
  │◀── Session OK ────│                      │                    │                │
```

### 8.2 Guardrail Check (Cron)

```
Cron Worker         Redis               MongoDB            ClickHouse
  │                   │                    │                    │
  │── Acquire lock ──▶│                    │                    │
  │◀── OK ───────────│                    │                    │
  │                   │                    │                    │
  │── Find running ──────────────────────▶│                    │
  │   experiments      │                    │                    │
  │◀── [exp1, exp2] ─────────────────────│                    │
  │                   │                    │                    │
  │── Query metrics ───────────────────────────────────────────▶│
  │   by group         │                    │                    │
  │◀── group metrics ──────────────────────────────────────────│
  │                   │                    │                    │
  │── Evaluate         │                    │                    │
  │   guardrails       │                    │                    │
  │                   │                    │                    │
  │── [if breach]:     │                    │                    │
  │   Update exp ─────────────────────────▶│                    │
  │   status=stopped   │                    │                    │
  │                   │                    │                    │
  │── Write audit log ────────────────────▶│                    │
  │   (guardrail      │                    │                    │
  │    breach record)  │                    │                    │
  │                   │                    │                    │
  │── Invalidate ────▶│                    │                    │
  │   cache            │                    │                    │
  │                   │                    │                    │
  │── Release lock ──▶│                    │                    │
```

---

## 9. Deployment & Rollout

### Phase 1: Backend Only (Feature Flag: None — API-only, no traffic impact)

1. Extend ExperimentModel schema
2. Add experiment routes to runtime
3. Add session experiment fields
4. Add ClickHouse tables and columns
5. Implement assignment algorithm
6. Implement results computation

### Phase 2: Studio UI

7. Add Studio proxy routes
8. Build experiments list page
9. Build experiment detail page with results
10. Build experiment creation form

**Studio navigation**: Experiments appears under the **EVALUATE** section in the Studio sidebar (alongside existing evaluation tools), not under Analytics. This groups experiment management with other quality assessment workflows.

### Rollback Plan

- Experiment feature is opt-in — no experiment means no behavior change
- If issues found: stop all running experiments (all traffic goes to control/default)
- Session experiment fields are optional — removing experiment logic leaves no side effects
- ClickHouse columns are `DEFAULT ''` — no impact on existing queries

---

## 10. Dependencies

| Dependency                  | Type           | Status     | Notes                                              |
| --------------------------- | -------------- | ---------- | -------------------------------------------------- |
| `ExperimentModel`           | Internal       | Scaffolded | Needs extension for safetyRules, results caching   |
| `ExperimentResultsService`  | Internal       | Scaffolded | Needs ClickHouse query integration                 |
| `Session` model             | Internal       | Production | Needs `experimentId`, `experimentGroup` fields     |
| ClickHouse analytics tables | Internal       | Production | Need `experiment_id`, `experiment_group` columns   |
| Redis                       | Infrastructure | Production | Used for experiment cache and distributed locks    |
| Pipeline-engine cron        | Internal       | Production | Needs new experiment results cron job              |
| RBAC permissions            | Internal       | Production | Need `experiment:read`, `experiment:write` entries |
