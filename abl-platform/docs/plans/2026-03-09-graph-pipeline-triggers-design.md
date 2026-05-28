# Graph Pipeline Triggers — Design

**Goal:** Enable custom graph-based pipelines to be triggered by platform Kafka events (scoped by project) and manual execution, reusing the existing `trigger` field on `PipelineDefinition`.

**Constraints:**

- One trigger per pipeline (no multi-trigger/strategy indirection)
- Kafka + Manual only (schedule is future work)
- Platform events only (no custom Kafka topics)
- Full event payload passed as `pipelineInput` (no input mapping)
- Pipeline `status` controls activation (no separate `enabled` flag)

---

## Data Model

No new fields. Reuses the existing `trigger` field already on `PipelineDefinition` and `PipelineDefinitionSchema`:

```typescript
{
  name: "Apple Customer Care Analytics",
  projectId: "proj-apple-care",
  status: "active",

  // Graph definition
  nodes: [...],
  entryNodeId: "read-conv",
  onNodeFailure: "continue",

  // Trigger — existing field, reused as-is
  trigger: {
    type: "kafka",
    kafkaTopic: "abl.session.ended",
    eventFilter: { field: "projectId", equals: "proj-apple-care" }
  }
}
```

The `trigger` type already supports:

```typescript
trigger?: {
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  eventFilter?: { field: string; equals: string };
  schedule?: string;
}
```

---

## Execution Flow

```
Event emitted (session.ended, projectId=proj-apple-care)
  |
  +- Event bus checks subscription registry -> subscribed
  |
  +- Kafka -> PipelineTrigger.handleEvent()
  |     |
  |     +- Query: { status:'active', trigger.kafkaTopic:'abl.session.ended' }
  |     +- Filter: eventFilter.field='projectId', equals='proj-apple-care'
  |     +- Build pipelineInput: { tenantId, sessionId, ...event }
  |     +- Fire PipelineRun workflow
  |
  +- PipelineRun detects nodes[] + entryNodeId
        +- runGraphMode() walks the graph
```

### Manual Execution

Already works. `triggerManual` loads pipeline by ID, builds `pipelineInput`, invokes `PipelineRun`. Graph mode is detected automatically when `nodes[]` + `entryNodeId` are present.

---

## Changes Required

### 1. PipelineTrigger.handleEvent

**File:** `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`

Extend the DB query to match graph pipelines via `trigger.kafkaTopic`. The query currently checks `supportedTriggers[].kafkaTopic` for multi-trigger pipelines — add an `$or` clause for the legacy/graph `trigger.kafkaTopic` field:

```typescript
const pipelines = await PipelineDefinitionModel.find({
  status: 'active',
  $or: [{ 'supportedTriggers.kafkaTopic': topic }, { 'trigger.kafkaTopic': topic }],
});
```

For graph pipelines matched via `trigger.kafkaTopic`:

- Apply `trigger.eventFilter` (same logic as today)
- Skip strategy resolution (no strategies on graph pipelines)
- Pass full event as `pipelineInput`
- Fire PipelineRun — `runGraphMode` is selected automatically

### 2. Subscription Registry Sync

**File:** `apps/runtime/src/repos/pipeline-repo.ts`

Ensure the periodic sync that builds `tenantId -> Set<eventType>` also picks up graph pipelines with `trigger.kafkaTopic`. The sync already handles the legacy `trigger` field — verify it works for graph pipelines (which also use `trigger` but have `nodes[]` instead of `steps[]`).

### 3. Validation

**File:** `packages/pipeline-engine/src/pipeline/validation.ts`

In `validateGraphPipeline`, add trigger validation when `trigger` is present:

- `type` must be `'kafka'` or `'manual'`
- If `type === 'kafka'`, `kafkaTopic` is required and must start with `abl.`
- If `eventFilter` is present, both `field` and `equals` must be non-empty strings
- `schedule` type is rejected for now (future work)

### 4. Studio API

**File:** `apps/studio/src/app/api/pipelines/route.ts`

No route changes needed — the POST route already accepts `trigger` in the request body and stores it on the pipeline document.

---

## Pipeline Lifecycle

```
Create (POST /api/pipelines)
  -> status: 'draft', trigger defined but not active

Activate (PATCH /api/pipelines/:id { status: 'active' })
  -> subscription registry picks up on next sync
  -> events start flowing

Deactivate (PATCH /api/pipelines/:id { status: 'draft' })
  -> subscription registry drops on next sync
  -> events stop

Archive (PATCH /api/pipelines/:id { status: 'archived' })
  -> soft delete, no longer queryable by default
```

---

## Example: Apple Customer Care Pipeline

```json
{
  "name": "Apple Customer Care Analytics",
  "description": "Analyzes Apple customer care conversations",
  "projectId": "proj-apple-care",
  "tags": ["apple", "customer-care"],
  "maxConcurrency": 5,
  "onNodeFailure": "continue",
  "trigger": {
    "type": "kafka",
    "kafkaTopic": "abl.session.ended",
    "eventFilter": {
      "field": "projectId",
      "equals": "proj-apple-care"
    }
  },
  "entryNodeId": "read-conv",
  "nodes": [
    {
      "id": "read-conv",
      "type": "read-conversation",
      "config": { "enrichWithTraces": true, "roles": ["user", "assistant"] },
      "transitions": [
        { "target": "sentiment", "order": 1 },
        { "target": "intent", "order": 2 }
      ]
    },
    {
      "id": "sentiment",
      "type": "compute-sentiment",
      "config": { "model": "gpt-4o-mini", "sourceStep": "read-conv" },
      "transitions": [{ "target": "store" }]
    },
    {
      "id": "intent",
      "type": "compute-intent",
      "config": {
        "model": "gpt-4o-mini",
        "sourceStep": "read-conv",
        "taxonomy": [
          { "category": "Device Support", "intents": ["battery-issue", "screen-repair"] },
          { "category": "Account & Billing", "intents": ["billing-inquiry", "refund-request"] }
        ]
      },
      "transitions": [{ "target": "store" }]
    },
    {
      "id": "store",
      "type": "store-results",
      "config": { "destination": "clickhouse", "source": "batch" },
      "transitions": []
    }
  ]
}
```

---

## Out of Scope

- Schedule triggers (future — add `type: 'schedule'` + `schedule` cron to `trigger`)
- Multiple triggers per graph pipeline
- Custom Kafka topics (non-`abl.*`)
- Input mapping (nodes read directly from `pipelineInput`)
- Separate `enabled` flag (pipeline `status` is sufficient)
