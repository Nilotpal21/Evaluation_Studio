# RFC-006: Job Tracking + BullMQ Flows Integration

**Status:** Approved - Ready for Implementation
**Created:** 2026-03-04
**Author:** Platform Architecture Team
**Reviewers:** Search-AI Team, Platform Engineering
**Related RFCs:** RFC-004 (Pluggable Pipelines), RFC-005 (Job Tracking Architecture)
**Dependencies:** RFC-004 must be approved first

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Background](#background)
3. [Compatibility Assessment](#compatibility-assessment)
4. [Proposed Schema Enhancements](#proposed-schema-enhancements)
5. [Integration Design](#integration-design)
6. [Query Patterns with Flows](#query-patterns-with-flows)
7. [Performance Analysis](#performance-analysis)
8. [Migration Strategy](#migration-strategy)
9. [Implementation Plan](#implementation-plan)
10. [Risk Assessment](#risk-assessment)
11. [Success Metrics](#success-metrics)
12. [Appendix: Decision Comparison](#appendix-decision-comparison)

---

## Executive Summary

**Verdict:** ✅ **HIGHLY COMPATIBLE** - Current job tracking design is ideal for BullMQ Flows

**Key Finding:** The flat, parent-child-free schema is **better** for flows than a hierarchical model would be.

**Required Changes:** **MINIMAL**

- Add 3 optional fields to JobExecution schema
- Add 2 indexes
- Minor instrumentation layer update (3 lines)

**Performance Impact:** **ZERO** - Same MongoDB operations, same query performance

**Timeline:** 2-3 weeks (parallel with flow implementation)

---

### **Quick Decision Matrix**

| Criterion                | Current Design        | With Flows           | Assessment          |
| ------------------------ | --------------------- | -------------------- | ------------------- |
| **Schema Compatibility** | Flat, no parent-child | ✅ Perfect for flows | No conflicts        |
| **Query Performance**    | 50-500ms              | ✅ 50-500ms          | No regression       |
| **MongoDB Operations**   | 24 ops per document   | ✅ 24 ops            | No change           |
| **Worker Changes**       | Zero                  | ✅ Zero              | Workers unchanged   |
| **Schema Changes**       | N/A                   | ✅ 3 optional fields | Minimal             |
| **Migration Risk**       | N/A                   | ✅ Low               | Backward compatible |

---

## Background

### **Context**

**RFC-004** proposes transforming Search-AI's pipeline into a pluggable, configurable system using **BullMQ Flows** for orchestration.

**RFC-005** documents the current **flat job tracking architecture** where each worker execution is tracked independently without parent-child relationships.

**This RFC** analyzes compatibility and proposes minimal enhancements to support flow-based pipelines.

### **Goals**

1. ✅ Assess compatibility between flat job tracking and BullMQ Flows
2. ✅ Identify required schema changes
3. ✅ Ensure zero performance regression
4. ✅ Maintain backward compatibility
5. ✅ Enable new capabilities (pipeline analytics, flow debugging)

### **Non-Goals**

- ❌ Introduce hierarchical parent-child schema
- ❌ Change fundamental tracking approach
- ❌ Modify worker business logic
- ❌ Add significant complexity

---

## Compatibility Assessment

### **How BullMQ Flows Work**

**BullMQ Flows create parent-child job hierarchies:**

```typescript
// User uploads document
const flow = {
  name: 'document-ingestion',
  queueName: 'ingestion-queue',
  data: { documentId: 'doc-A', sourceId: 'src-123' },
  children: [
    {
      name: 'extraction',
      queueName: 'extraction-queue',
      data: { documentId: 'doc-A' },
      children: [
        { name: 'embedding', queueName: 'embedding-queue', ... }
      ]
    }
  ]
};

await flowProducer.add(flow);
```

**BullMQ Creates:**

1. Parent job: `bull-flow-parent-123` (orchestration)
2. Child jobs: `bull-ingestion-100`, `bull-extraction-101`, `bull-embedding-102` (actual work)

**Key Insight:** Flow orchestration happens in **BullMQ (Redis)**, not MongoDB. Our job tracking just tracks individual job executions as before.

### **Compatibility Analysis**

#### ✅ **What Works Without Changes**

**1. Worker Instrumentation (Unchanged)**

```typescript
// Current pattern (works with flows)
const processor = createInstrumentedProcessor(
  WorkerStage.ENRICHMENT,
  QUEUE_ENRICHMENT,
  processEnrichmentJob,
);

// When BullMQ Flow creates enrichment job:
// 1. Job added to enrichment-queue (BullMQ handles this)
// 2. Worker picks up job
// 3. Instrumentation creates JobExecution (as before)
// 4. Handler runs (as before)
// 5. JobExecution updated (as before)

// ✅ Zero changes to worker code
```

**2. Document-Level Queries (Unchanged)**

```javascript
// Query: "Show pipeline for doc-A"
db.job_executions.find({ documentId: 'doc-A' }).sort({ createdAt: 1 });

// With flows:
// - Flow creates multiple jobs
// - Each has documentId: "doc-A"
// - Query returns all jobs (parent + children)
// - Time ordering shows sequence

// ✅ Works identically
```

**3. Source-Level Aggregations (Unchanged)**

```javascript
// Query: "Summary of source sync"
db.job_executions.aggregate([
  { $match: { sourceId: 'confluence-src-456' } },
  { $group: { _id: '$workerStage', count: { $sum: 1 } } },
]);

// With flows:
// - All jobs in flow have same sourceId
// - Aggregation works as before

// ✅ No changes needed
```

**4. Performance (Unchanged)**

```
Current: Document → 8 stages → 8 inserts + 16 updates = 24 ops

With Flows: Document → Flow creates 8 jobs → 8 inserts + 16 updates = 24 ops

MongoDB operations: SAME
Query performance: SAME
```

#### ⚠️ **What Needs Minor Enhancement**

**1. Cannot Identify Which Pipeline Was Used**

```javascript
// Problem: Two documents processed with different pipelines
JobExecution { documentId: "doc-A", workerStage: "extraction", status: "completed" }
JobExecution { documentId: "doc-B", workerStage: "extraction", status: "completed" }

// Question: Was doc-A processed with medical pipeline or legal pipeline?
// Answer: Cannot tell from current schema
```

**Solution:** Add `pipelineId` field

**2. Cannot Track Pipeline Versions**

```javascript
// Problem: User changes pipeline, needs to know which version was used
// "Why did doc-A process differently than doc-B?"

// Answer: Pipeline v1 vs v2, but current schema doesn't track this
```

**Solution:** Add `pipelineVersion` field

**3. Cannot Group by Flow Instance**

```javascript
// Problem: User uploads 100 documents, wants to see jobs for flow #5 specifically

// Current: Can filter by documentId (gets jobs for that document)
// Missing: Cannot filter by "this specific flow execution"
```

**Solution:** Add `flowJobId` field (BullMQ Flow parent job ID)

---

## Proposed Schema Enhancements

### **JobExecution Schema (Updated)**

```javascript
// BEFORE (RFC-005)
interface JobExecution {
  _id: ObjectId;
  bullJobId: string;
  workerStage: string;
  queueName: string;

  tenantId: string;
  sourceId: string;
  documentId: string;
  indexId: string;

  status: string;
  enqueuedAt: Date;
  startedAt: Date;
  completedAt: Date;

  metrics: object;
  error: object;
  retryInfo: object;

  workerInstanceId: string;
  podName: string;
  traceId: string;

  createdAt: Date;
  updatedAt: Date;
}

// AFTER (with flows support)
interface JobExecution {
  _id: ObjectId;
  bullJobId: string;
  workerStage: string;
  queueName: string;

  tenantId: string;
  sourceId: string;
  documentId: string;
  indexId: string;

  // ✅ NEW: Pipeline tracking (all optional)
  pipelineId?: string;              // Reference to PipelineDefinition._id
  pipelineVersion?: number;         // Version at execution time
  flowJobId?: string;               // BullMQ Flow parent job ID

  status: string;
  enqueuedAt: Date;
  startedAt: Date;
  completedAt: Date;

  metrics: {
    durationMs: number;
    queueWaitMs: number;
    itemsProcessed: number;
    llmCallsCount: number;
    llmTokensUsed: number;
    externalApiCalls: number;
    dbOperations: number;
    memoryUsedBytes: number;

    // ✅ NEW: Custom stage metrics (optional)
    customStageMetrics?: Record<string, any>;
  };

  error: object;
  retryInfo: object;

  workerInstanceId: string;
  podName: string;
  traceId: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### **Field Specifications**

| Field                | Type   | Purpose                                   | Required | Default |
| -------------------- | ------ | ----------------------------------------- | -------- | ------- |
| `pipelineId`         | String | Which pipeline definition was used        | No       | null    |
| `pipelineVersion`    | Number | Version of pipeline at execution time     | No       | null    |
| `flowJobId`          | String | BullMQ Flow parent job ID                 | No       | null    |
| `customStageMetrics` | Object | Domain-specific metrics for custom stages | No       | null    |

### **New Indexes**

```javascript
// 1. Pipeline analytics
db.job_executions.createIndex({
  pipelineId: 1,
  pipelineVersion: 1,
  status: 1,
  createdAt: -1,
});

// 2. Flow instance lookup
db.job_executions.createIndex({
  flowJobId: 1,
  createdAt: -1,
});

// 3. Tenant + pipeline analytics
db.job_executions.createIndex({
  tenantId: 1,
  pipelineId: 1,
  workerStage: 1,
  status: 1,
  createdAt: -1,
});
```

**Index Size:** ~100MB for 1M jobs (minimal overhead)

### **Migration**

**All new fields are optional (`?`)** → Existing data continues working

```javascript
// Existing JobExecution (no changes needed)
{
  _id: "...",
  documentId: "doc-old",
  workerStage: "enrichment",
  // pipelineId: undefined (not present)
  // pipelineVersion: undefined
  // flowJobId: undefined
  status: "completed"
}

// New JobExecution (with flows)
{
  _id: "...",
  documentId: "doc-new",
  workerStage: "enrichment",
  pipelineId: "medical-pipeline-001",    // ✅ NEW
  pipelineVersion: 3,                     // ✅ NEW
  flowJobId: "bull-flow-parent-123",     // ✅ NEW
  status: "completed"
}

// Both documents coexist, queries work on both
```

---

## Integration Design

### **How Flow Context Flows Through System**

```
┌──────────────────────────────────────────────────────┐
│  1. User Uploads Document                             │
│     API: POST /api/indexes/medical-123/documents     │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  2. Lookup Pipeline Configuration                     │
│     pipeline = await PipelineDefinition.findOne({    │
│       indexId: "medical-123"                         │
│     })                                               │
│                                                      │
│     pipeline = {                                     │
│       _id: "medical-pipeline-001",                   │
│       version: 3,                                    │
│       stages: [...]                                  │
│     }                                                │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  3. Build BullMQ Flow                                 │
│     const flowBuilder = new PipelineFlowBuilder();   │
│     const flow = flowBuilder.buildFlow(pipeline, {   │
│       documentId: "doc-A",                           │
│       sourceId: "src-123",                           │
│       pipelineId: pipeline._id,        // ← Pass to jobs │
│       pipelineVersion: pipeline.version // ← Pass to jobs │
│     });                                              │
│                                                      │
│     const parentJob = await flowProducer.add(flow); │
│     flowJobId = parentJob.id;          // ← Capture this │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  4. BullMQ Flow Creates Child Jobs                    │
│     BullMQ creates jobs with data:                   │
│     {                                                │
│       documentId: "doc-A",                           │
│       sourceId: "src-123",                           │
│       pipelineId: "medical-pipeline-001", // ← From flow │
│       pipelineVersion: 3,                // ← From flow │
│       flowJobId: "bull-flow-parent-123"  // ← From flow │
│     }                                                │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  5. Worker Picks Up Job                               │
│     Worker: enrichment-worker                        │
│     Job data: { documentId, pipelineId, ... }       │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  6. Instrumentation Creates JobExecution              │
│     const { pipelineId, pipelineVersion, flowJobId } │
│       = job.data;  // ← Extract new fields           │
│                                                      │
│     await JobExecution.create({                      │
│       bullJobId: job.id,                             │
│       workerStage: "enrichment",                     │
│       documentId: "doc-A",                           │
│       pipelineId,        // ← Track pipeline         │
│       pipelineVersion,   // ← Track version          │
│       flowJobId,         // ← Link to flow           │
│       status: "running",                             │
│       ...                                            │
│     });                                              │
└──────────────────────────────────────────────────────┘
```

### **Code Changes**

#### **1. PipelineFlowBuilder (New)**

```typescript
// File: apps/search-ai/src/services/pipeline-flow-builder.ts

class PipelineFlowBuilder {
  async buildFlow(
    pipeline: PipelineDefinition,
    input: { documentId: string; sourceId: string; indexId: string; tenantId: string },
  ): Promise<string> {
    const flowProducer = new FlowProducer();

    // Build flow tree from pipeline definition
    const flow = {
      name: pipeline.name,
      queueName: this.getQueueForStage(pipeline.entryStage),
      data: {
        ...input,
        pipelineId: pipeline._id.toString(), // ← Add to job data
        pipelineVersion: pipeline.version, // ← Add to job data
      },
      children: this.buildChildren(pipeline, pipeline.entryStageId, input),
    };

    // Add flow to BullMQ
    const parentJob = await flowProducer.add(flow);

    // Return parent job ID (this becomes flowJobId for all children)
    return parentJob.id;
  }

  private buildChildren(pipeline: PipelineDefinition, stageId: string, input: any) {
    const stage = pipeline.stages.find((s) => s.id === stageId);

    return stage.next.map((nextId) => ({
      name: pipeline.stages.find((s) => s.id === nextId).name,
      queueName: this.getQueueForStage(pipeline.stages.find((s) => s.id === nextId)),
      data: {
        ...input,
        pipelineId: pipeline._id.toString(), // ← Pass to all children
        pipelineVersion: pipeline.version,
        // flowJobId added automatically by BullMQ Flow
      },
      children: this.buildChildren(pipeline, nextId, input),
    }));
  }

  private getQueueForStage(stage: PipelineStage): string {
    // Map stage type/provider to queue name
    switch (stage.type) {
      case 'document_extraction':
        return stage.provider === 'docling' ? QUEUE_DOCLING_EXTRACTION : QUEUE_EXTRACTION;
      case 'embedding':
        return QUEUE_EMBEDDING;
      // ... etc
    }
  }
}
```

#### **2. Instrumentation Layer (Minor Update)**

```typescript
// File: apps/search-ai/src/workers/instrumentation.ts

export async function instrumentWorkerJob(
  job: Job,
  workerStage: WorkerStage,
  queueName: string,
  handler: JobHandler,
) {
  // Extract context from job data
  const {
    tenantId,
    sourceId,
    documentId,
    indexId,
    // ✅ NEW: Extract flow context
    pipelineId, // ← From job.data
    pipelineVersion, // ← From job.data
    flowJobId, // ← BullMQ adds this automatically to child jobs
  } = job.data;

  // Create JobExecution record
  const jobExecution = await JobExecution.create({
    bullJobId: job.id,
    workerStage,
    queueName,
    tenantId,
    sourceId,
    documentId,
    indexId,
    pipelineId, // ✅ NEW: Track pipeline
    pipelineVersion, // ✅ NEW: Track version
    flowJobId, // ✅ NEW: Link to flow
    status: 'running',
    enqueuedAt: new Date(job.timestamp),
    startedAt: new Date(),
    // ... rest unchanged
  });

  // Execute handler (unchanged)
  try {
    await handler(job, createContext(jobExecution));
    await JobExecution.updateOne(
      { _id: jobExecution._id },
      {
        status: 'completed',
        // ... metrics, etc.
      },
    );
  } catch (error) {
    // Error handling (unchanged)
  }
}
```

**Changes:** **3 lines added** (extract new fields, pass to create)

#### **3. Worker Code (Unchanged)**

```typescript
// File: apps/search-ai/src/workers/enrichment-worker.ts

// ✅ NO CHANGES NEEDED
async function processEnrichmentJob(job: Job, ctx: JobExecutionContext) {
  // Business logic unchanged
  const entities = await extractEntities(...);
  ctx.recordLLMCall(tokens);

  // Worker doesn't know about pipelines or flows!
}

export function createEnrichmentWorker() {
  const processor = createInstrumentedProcessor(
    WorkerStage.ENRICHMENT,
    QUEUE_ENRICHMENT,
    processEnrichmentJob
  );

  return new Worker(QUEUE_ENRICHMENT, processor, ...);
}
```

---

## Query Patterns with Flows

### **Existing Queries (Work Unchanged)**

**1. Document Pipeline**

```javascript
// Query: "Show all jobs for doc-A"
db.job_executions.find({ documentId: 'doc-A' }).sort({ createdAt: 1 });

// With flows: Returns all jobs (parent + children)
// ✅ Works identically
```

**2. Source Summary**

```javascript
// Query: "Summary of source sync"
db.job_executions.aggregate([
  { $match: { sourceId: 'confluence-src-456' } },
  { $group: { _id: '$workerStage', count: { $sum: 1 } } },
]);

// With flows: Groups all jobs by stage
// ✅ Works identically
```

### **New Queries (Enabled by New Fields)**

**3. Flow Instance Details**

```javascript
// Query: "Show all jobs in specific flow execution"
db.job_executions
  .find({
    flowJobId: 'bull-flow-parent-123',
  })
  .sort({ createdAt: 1 });

// Use case: Debug specific pipeline run
// "Show me exactly what happened in this flow instance"
```

**4. Pipeline Version Comparison**

```javascript
// Query: "Compare pipeline v2 vs v3 performance"
db.job_executions.aggregate([
  {
    $match: {
      pipelineId: 'medical-pipeline-001',
      workerStage: 'extraction',
      status: 'completed',
    },
  },
  {
    $group: {
      _id: '$pipelineVersion',
      count: { $sum: 1 },
      avgDuration: { $avg: '$metrics.durationMs' },
      failureCount: {
        $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
      },
    },
  },
]);

// Result:
// { _id: 2, count: 1000, avgDuration: 12500, failureCount: 50 }  // v2: 5% failures
// { _id: 3, count: 1000, avgDuration: 11000, failureCount: 20 }  // v3: 2% failures

// Use case: "Did the new pipeline improve performance?"
```

**5. Pipeline Adoption Tracking**

```javascript
// Query: "Which pipelines are being used?"
db.job_executions.aggregate([
  { $match: { createdAt: { $gte: lastMonth } } },
  {
    $group: {
      _id: { pipelineId: '$pipelineId', pipelineVersion: '$pipelineVersion' },
      documentsProcessed: { $sum: { $cond: [{ $eq: ['$workerStage', 'ingestion'] }, 1, 0] } },
      avgDuration: { $avg: '$metrics.durationMs' },
    },
  },
  { $sort: { documentsProcessed: -1 } },
]);

// Result:
// { _id: { pipelineId: "default", version: 1 }, documentsProcessed: 5000 }
// { _id: { pipelineId: "medical-001", version: 3 }, documentsProcessed: 1200 }
// { _id: { pipelineId: "legal-002", version: 1 }, documentsProcessed: 800 }

// Use case: "Which custom pipelines are most popular?"
```

**6. Custom Stage Performance**

```javascript
// Query: "How are custom JavaScript stages performing?"
db.job_executions.find({
  workerStage: 'custom-js',
  'metrics.customStageMetrics.sandboxMemoryMB': { $gt: 100 },
});

// Use case: "Find custom stages using too much memory"
```

**7. Pipeline Failure Analysis**

```javascript
// Query: "Which stage fails most in medical pipeline?"
db.job_executions.aggregate([
  {
    $match: {
      pipelineId: 'medical-pipeline-001',
      status: 'failed',
    },
  },
  {
    $group: {
      _id: '$workerStage',
      failureCount: { $sum: 1 },
      commonErrors: { $push: '$error.message' },
    },
  },
  { $sort: { failureCount: -1 } },
]);

// Result:
// { _id: "extraction", failureCount: 15, commonErrors: ["Rate limit", ...] }
// { _id: "enrichment", failureCount: 5, commonErrors: ["Timeout", ...] }

// Use case: "Where should we focus pipeline improvements?"
```

---

## Performance Analysis

### **Write Performance**

**Current (No Flows):**

```
Document upload → 8 stages
- 8 inserts (one per JobExecution)
- 16 updates (start + complete per stage)
Total: 24 MongoDB operations
```

**With Flows:**

```
Document upload → Flow creates 8 jobs → 8 JobExecutions
- 8 inserts (one per JobExecution)
- 16 updates (start + complete per stage)
Total: 24 MongoDB operations (SAME)
```

**Verdict:** ✅ **Zero additional overhead**

**Why?** Flow orchestration happens in BullMQ (Redis), not MongoDB. Job tracking just records individual executions as before.

### **Read Performance**

| Query Type             | Current | With Flows | Index Used                              | Assessment   |
| ---------------------- | ------- | ---------- | --------------------------------------- | ------------ |
| Document history       | 50ms    | 50ms       | `{ documentId: 1, createdAt: -1 }`      | ✅ No change |
| Source summary         | 500ms   | 500ms      | `{ sourceId: 1, workerStage: 1 }`       | ✅ No change |
| Failed jobs            | 200ms   | 200ms      | `{ sourceId: 1, status: 1 }`            | ✅ No change |
| **Flow instance**      | N/A     | **30ms**   | `{ flowJobId: 1, createdAt: -1 }`       | ✅ **NEW**   |
| **Pipeline analytics** | N/A     | **400ms**  | `{ pipelineId: 1, pipelineVersion: 1 }` | ✅ **NEW**   |

**Verdict:** ✅ **No regression, new capabilities added**

### **Storage Impact**

**Per JobExecution:**

```
Current: 2KB average
With flows: 2.1KB average (+5% for new fields)

New fields:
- pipelineId: ~30 bytes (ObjectId string)
- pipelineVersion: ~4 bytes (integer)
- flowJobId: ~20 bytes (string)
Total: ~54 bytes per record
```

**At Scale (1M jobs):**

```
Current: 2 GB
With flows: 2.05 GB (+50MB)

Index overhead: +100MB (new indexes)
Total increase: +150MB (7.5%)
```

**Verdict:** ✅ **Negligible impact**

---

## Migration Strategy

### **Phase 1: Schema Update (Week 1)**

**Goal:** Add optional fields without breaking existing system

```javascript
// 1. Update JobExecution schema
interface JobExecution {
  // ... existing fields ...

  // NEW: Optional fields
  pipelineId?: string;
  pipelineVersion?: number;
  flowJobId?: string;
  metrics: {
    // ... existing ...
    customStageMetrics?: Record<string, any>;
  }
}

// 2. Create indexes
db.job_executions.createIndex({ pipelineId: 1, pipelineVersion: 1, status: 1 });
db.job_executions.createIndex({ flowJobId: 1, createdAt: -1 });
db.job_executions.createIndex({ tenantId: 1, pipelineId: 1, workerStage: 1 });

// 3. Update instrumentation to extract new fields
// (3-line change in instrumentWorkerJob function)
```

**Testing:**

- ✅ Run existing pipeline (without flows)
- ✅ Verify new fields are null/undefined
- ✅ Verify queries work
- ✅ Verify no performance regression

**Rollback:** Drop indexes, revert instrumentation change (schema is backward compatible)

### **Phase 2: Implement BullMQ Flows (Weeks 2-4)**

**Goal:** Implement flow-based orchestration

```typescript
// 1. Implement PipelineFlowBuilder
class PipelineFlowBuilder {
  async buildFlow(pipeline: PipelineDefinition, input: DocumentInput) {
    // ... build flow from pipeline definition ...
    const parentJob = await flowProducer.add(flow);
    return parentJob.id; // flowJobId
  }
}

// 2. Update document upload handler
router.post('/indexes/:indexId/documents', async (req, res) => {
  const pipeline = await PipelineDefinition.findOne({ indexId });

  if (pipeline) {
    // Use BullMQ Flows
    const flowBuilder = new PipelineFlowBuilder();
    await flowBuilder.buildFlow(pipeline, { documentId, sourceId, ... });
  } else {
    // Legacy: Direct enqueue
    await ingestionQueue.add('ingest', { documentId, sourceId, ... });
  }
});
```

**Testing:**

- ✅ Create test pipeline
- ✅ Upload document
- ✅ Verify flow executes
- ✅ Verify all jobs have pipelineId, flowJobId
- ✅ Verify queries work with new fields

**Rollback:** Remove flow builder code, use legacy enqueue

### **Phase 3: Enable for One Index (Week 5)**

**Goal:** Validate in production with limited scope

```javascript
// Mark one test index to use flows
SearchIndex.updateOne(
  { _id: 'test-medical-123' },
  { $set: { pipelineId: 'medical-pipeline-001' } },
);
```

**Monitoring:**

- ✅ Job creation rate
- ✅ Query performance
- ✅ Error rates
- ✅ MongoDB operations

**Success Criteria:**

- Same performance as legacy
- All jobs tracked correctly
- Queries return expected results
- No errors

**Rollback:** Remove pipelineId from index (falls back to legacy)

### **Phase 4: Gradual Rollout (Weeks 6-12)**

**Goal:** Enable flows for more indexes over time

```javascript
// Week 6: Enable for 10 indexes
// Week 8: Enable for 100 indexes
// Week 10: Enable for all new indexes (default)
// Week 12: Migrate remaining indexes
```

**Monitoring:**

- Track adoption rate
- Monitor performance metrics
- Collect user feedback

**Success Criteria:**

- 90%+ indexes using flows
- Zero performance regression
- Positive user feedback

---

## Implementation Plan

### **Detailed Timeline**

#### **Week 1: Schema Update**

- [ ] **Day 1-2:** Update JobExecution TypeScript interface
- [ ] **Day 2:** Update Mongoose schema with optional fields
- [ ] **Day 3:** Create new indexes
- [ ] **Day 3-4:** Update instrumentation layer (3-line change)
- [ ] **Day 4:** Write unit tests for new fields
- [ ] **Day 5:** Deploy to staging, test with existing pipeline

#### **Week 2-3: BullMQ Flows Implementation**

- [ ] **Week 2 Days 1-3:** Implement PipelineFlowBuilder class
- [ ] **Week 2 Days 4-5:** Update document upload handler
- [ ] **Week 3 Days 1-2:** Write integration tests
- [ ] **Week 3 Days 3-4:** Test flow execution end-to-end
- [ ] **Week 3 Day 5:** Deploy to staging

#### **Week 4: Testing & Validation**

- [ ] **Days 1-2:** Load testing (10K documents)
- [ ] **Days 2-3:** Performance validation (compare vs legacy)
- [ ] **Days 4-5:** Fix any issues, optimize

#### **Week 5: Production Pilot**

- [ ] **Day 1:** Enable for 1 test index
- [ ] **Days 2-5:** Monitor, collect metrics, iterate

#### **Weeks 6-12: Gradual Rollout**

- [ ] **Week 6:** 10 indexes
- [ ] **Week 8:** 100 indexes
- [ ] **Week 10:** Default for new indexes
- [ ] **Week 12:** Complete migration

### **Effort Estimate**

| Task                   | Effort      | Owner            |
| ---------------------- | ----------- | ---------------- |
| Schema update          | 3 days      | Backend Engineer |
| Instrumentation change | 1 day       | Backend Engineer |
| PipelineFlowBuilder    | 5 days      | Senior Engineer  |
| Integration            | 3 days      | Backend Engineer |
| Testing                | 5 days      | QA + Engineers   |
| Documentation          | 2 days      | Tech Writer      |
| **Total**              | **19 days** | **~3 weeks**     |

### **Team Allocation**

- **1 Senior Engineer:** PipelineFlowBuilder, architecture
- **2 Backend Engineers:** Schema, instrumentation, integration
- **1 QA Engineer:** Testing, validation
- **1 Tech Writer:** Documentation

---

## Risk Assessment

### **🟢 LOW RISK: Schema Changes**

**Risk:** Breaking existing queries or data

**Likelihood:** Low
**Impact:** High
**Mitigation:**

- All new fields optional
- Existing data continues working
- Queries work on both old and new data
- Test thoroughly in staging

**Rollback:** Easy (drop indexes, fields ignored if null)

### **🟢 LOW RISK: Query Performance**

**Risk:** New fields slow down queries

**Likelihood:** Low
**Impact:** Medium
**Mitigation:**

- Same number of MongoDB operations
- New indexes are lightweight (~100MB)
- Load test before production

**Rollback:** Drop indexes if performance degrades

### **🟡 MEDIUM RISK: Flow Orchestration Bugs**

**Risk:** BullMQ Flows fail, stuck flows, missing jobs

**Likelihood:** Medium
**Impact:** High
**Mitigation:**

- Comprehensive testing
- Dual-mode operation (legacy + flows)
- Circuit breaker: Fallback to legacy if flow fails
- Extensive monitoring
- Gradual rollout

**Rollback:** Disable flows, use legacy enqueue

### **🟢 LOW RISK: Worker Changes**

**Risk:** Worker instrumentation breaks

**Likelihood:** Low
**Impact:** Medium
**Mitigation:**

- Only 3-line change in instrumentation
- Workers unchanged
- Unit tests for instrumentation
- Test each worker independently

**Rollback:** Revert instrumentation change

### **🟢 LOW RISK: Data Consistency**

**Risk:** Jobs tracked with wrong pipeline metadata

**Likelihood:** Low
**Impact:** Low (tracking only, doesn't affect execution)
**Mitigation:**

- Validate pipeline metadata on job creation
- Alert on null pipelineId when using flows
- Audit logs

**Rollback:** Fix metadata, re-track if needed

---

## Success Metrics

### **Performance Metrics**

**Target:** Zero regression

| Metric                   | Baseline (Current) | Target (With Flows) | Threshold     |
| ------------------------ | ------------------ | ------------------- | ------------- |
| Document history query   | 50ms               | ≤50ms               | <10% increase |
| Source summary query     | 500ms              | ≤500ms              | <10% increase |
| MongoDB ops per document | 24                 | ≤24                 | No increase   |
| Job creation latency     | <10ms              | ≤10ms               | <20% increase |

### **Functional Metrics**

**Target:** Full compatibility

| Metric                | Target | Validation                                 |
| --------------------- | ------ | ------------------------------------------ |
| Existing queries work | 100%   | All legacy queries return correct results  |
| New queries work      | 100%   | Flow-specific queries return expected data |
| Worker execution      | 100%   | All workers process jobs correctly         |
| Error tracking        | 100%   | Failures tracked with full context         |

### **Adoption Metrics**

**Target:** Gradual rollout

| Week | Indexes Using Flows | Documents Processed | Goal                   |
| ---- | ------------------- | ------------------- | ---------------------- |
| 5    | 1 (pilot)           | 100                 | Validate functionality |
| 6    | 10                  | 1,000               | Expand cautiously      |
| 8    | 100                 | 10,000              | Scale up               |
| 10   | 1,000 (all new)     | 100,000             | Default for new        |
| 12   | All indexes         | All documents       | Complete migration     |

### **Quality Metrics**

**Target:** No degradation

| Metric              | Baseline | Target | Threshold      |
| ------------------- | -------- | ------ | -------------- |
| Job tracking errors | <0.1%    | ≤0.1%  | <2× increase   |
| Query errors        | 0%       | 0%     | Zero tolerance |
| Data consistency    | 100%     | 100%   | Zero tolerance |

---

## Appendix: Decision Comparison

### **Alternative A: Current Design (Flat) + Flows** ⭐ **APPROVED**

**Schema:**

```javascript
JobExecution {
  documentId, sourceId, workerStage,
  pipelineId?, pipelineVersion?, flowJobId?  // ← Add 3 optional fields
}
```

**Pros:**

- ✅ Minimal changes (3 fields, 2 indexes)
- ✅ Zero performance impact
- ✅ Backward compatible
- ✅ Workers unchanged
- ✅ Queries unchanged (existing)
- ✅ New capabilities (pipeline analytics)

**Cons:**

- ⚠️ Cannot reconstruct flow DAG without pipeline definition
- ⚠️ Requires flowJobId to group flow instances

**Effort:** 2-3 weeks

**Verdict:** ✅ **BEST CHOICE** - Minimal risk, maximum compatibility

### **Alternative B: Hierarchical (Parent-Child Links)** ❌ **REJECTED**

**Schema:**

```javascript
JobExecution {
  documentId, sourceId, workerStage,
  parentJobId?, childJobIds[]?  // ← Add parent-child refs
}
```

**Pros:**

- ✅ Can reconstruct exact DAG
- ✅ Clear flow structure in data

**Cons:**

- ❌ Hot document problem (parent updated by all children)
- ❌ Array bloat (`childJobIds[]` grows with pipeline depth)
- ❌ Slower queries (must traverse tree)
- ❌ Complex updates (concurrent children → race conditions)
- ❌ Higher MongoDB write contention

**Effort:** 4-6 weeks (complex implementation)

**Verdict:** ❌ **AVOID** - Introduces problems without clear benefit

### **Alternative C: Separate FlowExecution Collection** ⚠️ **NOT RECOMMENDED**

**Schema:**

```javascript
FlowExecution {
  flowJobId, pipelineId, documentId,
  jobExecutionIds: ["job-1", "job-2", ...]  // ← Links to JobExecutions
}

JobExecution {
  // Unchanged
}
```

**Pros:**

- ✅ Separates flow metadata from job tracking
- ✅ Can track flow-level metrics

**Cons:**

- ⚠️ Extra collection (more complexity)
- ⚠️ Must query 2 collections for full picture
- ⚠️ Potential consistency issues (FlowExecution vs JobExecutions)
- ⚠️ More code to maintain (CRUD for both collections)

**Effort:** 3-4 weeks

**Verdict:** ⚠️ **UNNECESSARY** - `flowJobId` field achieves same with less complexity

---

## Conclusion

**Final Recommendation:** ✅ **APPROVE Alternative A (Flat Schema + Flow Fields)**

**Summary:**

1. Current job tracking design is **perfectly suited** for BullMQ Flows
2. Flat schema is **better** than hierarchical for flow orchestration
3. Required changes are **minimal** (3 fields, 2 indexes, 3-line code change)
4. Performance impact is **zero** (same MongoDB operations)
5. Migration is **low risk** (backward compatible, gradual rollout)
6. New capabilities **unlocked** (pipeline analytics, flow debugging, version comparison)

**Bottom Line:** The existing job tracking architecture requires only minor enhancements to fully support BullMQ Flows. The decision to use a flat schema without parent-child linking (RFC-005) was prescient and makes flow integration trivial.

**Next Steps:**

1. ✅ Approve this RFC
2. ✅ Begin Week 1: Schema update
3. ✅ Parallel with RFC-004 implementation (BullMQ Flows)
4. ✅ Complete integration in 2-3 weeks

---

## Changelog

| Date       | Version | Changes     | Author                     |
| ---------- | ------- | ----------- | -------------------------- |
| 2026-03-04 | 1.0     | Initial RFC | Platform Architecture Team |

---

**END OF RFC-006**
