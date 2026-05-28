# Experiments / A/B Testing -- Low-Level Design

## Task T-1: Experiment Model

### Files

- `packages/pipeline-engine/src/schemas/experiment.schema.ts`

### Key Types

- `IExperiment`: `{ tenantId, projectId, name, description?, status, controlVersion, experimentVersion, trafficSplit, successMetrics, guardrailMetrics, startedAt?, stoppedAt?, createdBy }`
- Status: `'draft' | 'running' | 'stopped' | 'completed'`
- `trafficSplit`: 0-1 (fraction of traffic to experiment variant)

### Design Notes

- Index: `{ tenantId: 1, projectId: 1, status: 1 }`
- Timestamps enabled (`createdAt`, `updatedAt` automatic)
- Collection name: `experiments`

---

## Task T-2: Experiment CRUD + Lifecycle Routes

### Files

- `apps/runtime/src/routes/experiments.ts` -- All endpoints at `/api/projects/:projectId/experiments`

### Key Endpoints

- `GET /` -- List experiments with optional status filter. Uses `findOne({tenantId, projectId})`
- `POST /` -- Create experiment. Validates name, controlVersion, experimentVersion, trafficSplit, successMetrics. Sets `status: 'draft'`.
- `GET /:id` -- Get by ID with `findOne({_id, tenantId, projectId})`
- `PUT /:id` -- Update. **WARNING**: passes `req.body` directly to `$set` without field picking (mass assignment risk).
- `DELETE /:id` -- Delete. Only draft/stopped (running returns 409).
- `POST /:id/start` -- Sets `status: 'running'`, `startedAt: now`
- `POST /:id/stop` -- Sets `status: 'stopped'`, `stoppedAt: now`
- `GET /:id/results` -- Queries ClickHouse for per-group session counts
- `GET /:id/timeseries` -- Queries ClickHouse for daily counts by group

### Design Notes

- Auth: `authMiddleware` + `requireProjectScope` + `tenantRateLimit`
- Permissions: `session:read` for reads, `project:write` for mutations
- Lazy import of `ExperimentModel` and ClickHouse client
- ClickHouse queries: parameterized, `max_execution_time = 15`

---

## Task T-3: Experiment Results Service

### Files

- `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts`

### Key Types

- `GroupMetrics`: `{ group: 'control' | 'experiment', sampleSize, metrics }`
- `SignificanceResult`: `{ metric, controlMean, experimentMean, pValue, significant, confidenceInterval, lift }`
- `ExperimentResults`: `{ experimentId, controlGroup, experimentGroup, significance[], sampleSizeAdequate, minSampleSize }`

### Key Signatures

- `computeResults(experimentId, tenantId, projectId) -> Promise<ExperimentResults>`

### Design Notes

- Queries ClickHouse for per-group assignment and metric data
- Performs t-test for continuous metrics, chi-squared for categorical
- Power analysis to determine minimum sample size for significance
- Confidence interval computation included in results

---

## Known Gaps

- PUT endpoint mass assignment risk (no field picking)
- No variant assignment logic in runtime (traffic split stored but not enforced)
- No experiment route tests
- ExperimentModel inconsistently located in pipeline-engine instead of database package
