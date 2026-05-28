# Architectural Review: Flat Schema Verification

# Pluggable Pipelines Design - Parent-Child Relationship Analysis

**Date:** 2026-03-05
**Reviewer:** Search-AI Architect
**Scope:** Verify flat schema design maintained across pluggable pipelines integration
**Documents Reviewed:**

- `docs/searchai/PLUGGABLE-PIPELINES-INTEGRATION-DESIGN.md`
- `docs/searchai/rfcs/RFC-005-Job-Tracking-Architecture.md`
- `docs/searchai/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md`

---

## Executive Summary

✅ **CONFIRMED: No Parent-Child Relationships in Data Model**

The pluggable pipelines design **strictly maintains the flat schema architecture** established in RFC-005 and RFC-006. There are **zero parent-child relationships** in the MongoDB data model.

### Key Finding: Clear Separation of Concerns

| Layer             | Type         | Storage              | Purpose                              |
| ----------------- | ------------ | -------------------- | ------------------------------------ |
| **Orchestration** | BullMQ Flows | Redis (ephemeral)    | Parent-child DAG for execution order |
| **Tracking**      | JobExecution | MongoDB (persistent) | Flat records with context fields     |

**Critical Distinction:**

- ✅ BullMQ Flows (Redis) manages parent-child **orchestration** (temporary)
- ✅ JobExecution (MongoDB) uses flat schema with **context fields** (permanent)
- ✅ **NO linkage updates** between JobExecution records

---

## Review Findings

### 1. JobExecution Schema - FLAT ✅

**RFC-006 Additions (3 optional fields):**

```typescript
interface JobExecution {
  // ... existing flat fields (documentId, sourceId, workerStage) ...

  // NEW: Simple scalar fields (NOT arrays, NOT parent refs)
  pipelineId?: string; // Which pipeline was used
  pipelineVersion?: number; // Version at execution time
  flowJobId?: string; // BullMQ Flow parent ID (grouping field)

  // ... rest of schema ...
}
```

**Analysis:**

- ✅ `flowJobId` is a **grouping field** (like `documentId`, `sourceId`)
- ✅ NOT a parent reference that triggers updates
- ✅ ALL jobs in a flow share the SAME `flowJobId` value
- ✅ Query pattern: `find({ flowJobId: 'X' })` → returns all stages (O(1) index scan)

**Comparison to REJECTED Hierarchical:**

```typescript
// ❌ REJECTED (RFC-005 Section 6.1)
JobExecution {
  _id: "parent-job-1",
  childJobIds: ["child-1", "child-2"],  // ← Array grows, hot document
  status: "waiting-children"             // ← Updated by every child
}

// ✅ APPROVED (RFC-006 Section 4.2)
JobExecution {
  _id: "job-1",
  flowJobId: "flow-parent-789",  // ← Static, no updates
  workerStage: "enrichment",
  // Each job is independent
}
```

---

### 2. SearchDocument Schema - FLAT ✅

**RFC-006 Additions (2 optional fields):**

```typescript
interface SearchDocument {
  // ... existing fields ...

  // NEW: Simple foreign keys (NOT arrays, NOT parent refs)
  syncJobExecutionId?: string; // Latest sync that touched this doc
  ingestionFlowJobId?: string; // Latest ingestion flow parent ID

  // ... rest of schema ...
}
```

**Analysis:**

- ✅ `syncJobExecutionId` stores **latest sync only** (not array of all syncs)
- ✅ `ingestionFlowJobId` stores **latest flow only** (not array of all flows)
- ✅ Updates are **self-contained** (update this document only)
- ✅ NO reverse updates (JobExecution does NOT update SearchDocument arrays)

**Update Pattern:**

```typescript
// ✅ CORRECT: Self-contained update (no parent traversal)
await SearchDocument.updateOne(
  { _id: documentId },
  {
    syncJobExecutionId: newSyncJobId, // Overwrites previous value
    ingestionFlowJobId: newFlowId, // Overwrites previous value
  },
);

// ❌ REJECTED (what we're NOT doing):
await SearchDocument.updateOne(
  { _id: documentId },
  {
    $push: { syncJobExecutionIds: newSyncJobId }, // ← Array bloat
    $push: { ingestionFlowJobIds: newFlowId }, // ← Hot document
  },
);
```

---

### 3. Instrumentation Layer - NO PARENT UPDATES ✅

**Worker Instrumentation Pattern (Section 3.4):**

```typescript
async function createInstrumentedProcessor(workerStage, queueName, handler) {
  return async (job) => {
    // 1. Create NEW JobExecution record (independent)
    const jobExecution = await JobExecution.create({
      bullJobId: job.id,
      workerStage,
      tenantId, documentId, sourceId, indexId,
      pipelineId, pipelineVersion, flowJobId,  // ← Extracted from job.data
      status: 'running'
    });

    // 2. Execute handler
    await handler(job, ctx);

    // 3. Update ONLY this JobExecution (self-update)
    await JobExecution.updateOne(
      { _id: jobExecution._id },  // ← Update self only
      { status: 'completed', metrics: {...} }
    );

    // ✅ NO updates to:
    // - Parent JobExecution
    // - Sibling JobExecutions
    // - SearchDocument arrays
    // - ConnectorConfig arrays
  };
}
```

**Analysis:**

- ✅ Each worker creates ONE new JobExecution
- ✅ Each worker updates ONLY its own JobExecution
- ✅ ZERO updates to other documents
- ✅ Pure flat schema with no cascading updates

---

### 4. Query Patterns - FLAT FILTERING ✅

**Document History Query:**

```typescript
// ✅ CORRECT: Flat filter (O(1) index scan)
const executions = await JobExecution.find({
  tenantId,
  documentId: 'doc-A',
}).sort({ createdAt: 1 });

// Returns: All stages for doc-A (direct index lookup)
// NO parent-child traversal
// NO recursive queries
```

**Flow Instance Query:**

```typescript
// ✅ CORRECT: Flat filter (O(1) index scan)
const executions = await JobExecution.find({
  tenantId,
  flowJobId: 'flow-parent-789',
}).sort({ createdAt: 1 });

// Returns: All stages in this flow (direct index lookup)
// NO traversal from parent → children
// flowJobId is a GROUPING field, not a parent reference
```

**Source Summary Query:**

```typescript
// ✅ CORRECT: Flat aggregation (O(1) index scan)
const summary = await JobExecution.aggregate([
  { $match: { tenantId, sourceId: 'src-123' } },
  { $group: { _id: '$workerStage', count: { $sum: 1 } } },
]);

// Returns: Count by stage for entire source
// NO parent-child joins
// NO recursive aggregation
```

---

## Architectural Validation

### ✅ Principle 1: No Hot Documents

**Definition:** Multiple workers concurrently updating the SAME parent document

**Validation:**

- ✅ Each JobExecution is created ONCE and updated ONCE (by same worker)
- ✅ NO shared parent document that all children update
- ✅ `flowJobId` is **read-only** after creation (static grouping field)
- ✅ MongoDB write contention: **ZERO** (each worker updates different document)

**Comparison:**

| Pattern         | Writes per Flow                           | Contention Risk           |
| --------------- | ----------------------------------------- | ------------------------- |
| ❌ Parent-Child | N writes to parent + N writes to children | HIGH (hot parent)         |
| ✅ Flat Schema  | N writes to N documents                   | NONE (independent writes) |

---

### ✅ Principle 2: No Array Bloat

**Definition:** Arrays that grow unbounded over time

**Validation:**

- ✅ NO `childJobIds[]` arrays in JobExecution
- ✅ NO `jobExecutionIds[]` arrays in SearchDocument
- ✅ ALL new fields are **scalar** (string, number)
- ✅ Document size remains **constant** regardless of pipeline depth

**Example:**

```typescript
// ❌ REJECTED: Array grows with every flow
SearchDocument {
  ingestionFlowJobIds: [
    "flow-1", "flow-2", "flow-3", ..., "flow-N"  // ← Unbounded growth
  ]
}

// ✅ APPROVED: Single value, always overwrites
SearchDocument {
  ingestionFlowJobId: "flow-N"  // ← Latest only, constant size
}
```

---

### ✅ Principle 3: No Recursive Queries

**Definition:** Queries that traverse parent → child → grandchild chains

**Validation:**

- ✅ ALL queries use **direct index lookups** on `flowJobId`, `documentId`, `sourceId`
- ✅ NO `$graphLookup` for parent-child traversal
- ✅ NO recursive aggregation pipelines
- ✅ Query complexity: **O(1)** index scan (not O(depth) traversal)

**Query Performance:**

```typescript
// ❌ REJECTED: Recursive traversal (slow)
// 1. Find parent: JobExecution.findById(parentId)
// 2. For each childId in parent.childJobIds:
//    3. Find child: JobExecution.findById(childId)
//    4. For each grandchildId in child.childJobIds:
//       5. Find grandchild: JobExecution.findById(grandchildId)
// Complexity: O(depth * width) = O(N) for N jobs

// ✅ APPROVED: Direct filter (fast)
JobExecution.find({ flowJobId: 'flow-parent-789' });
// Complexity: O(1) index scan
```

---

### ✅ Principle 4: No Race Conditions

**Definition:** Concurrent updates to same field causing lost writes

**Validation:**

- ✅ Each worker updates ONLY its own JobExecution document
- ✅ NO concurrent updates to shared parent's `childJobIds[]`
- ✅ NO atomic array operations (`$addToSet`, `$push`) needed
- ✅ NO transactions required for job tracking

**Concurrency Safety:**

```typescript
// ❌ REJECTED: Race condition on parent update
// Worker 1: parent.childJobIds.push("child-1")  ← Lost write risk
// Worker 2: parent.childJobIds.push("child-2")  ← Lost write risk
// Result: One child may be missing from array

// ✅ APPROVED: Independent writes
// Worker 1: JobExecution.updateOne({ _id: "child-1" }, { status: "completed" })
// Worker 2: JobExecution.updateOne({ _id: "child-2" }, { status: "completed" })
// Result: Both updates succeed independently
```

---

## BullMQ Flows vs MongoDB Schema

### Critical Distinction

**BullMQ Flows (Orchestration Layer):**

```
┌─────────────────────────────────────────────┐
│  Redis (Ephemeral State)                    │
│                                              │
│  Flow Parent: "flow-parent-789"             │
│    ├─ child: "docling-extraction"           │
│    ├─ child: "knowledge-graph"              │
│    └─ child: "embedding"                    │
│                                              │
│  Purpose: Execute in correct ORDER          │
│  Storage: Redis (temporary)                 │
│  Cleanup: removeOnComplete (1 hour)         │
└─────────────────────────────────────────────┘
```

**MongoDB JobExecution (Tracking Layer):**

```
┌─────────────────────────────────────────────┐
│  MongoDB (Persistent State)                 │
│                                              │
│  JobExecution { flowJobId: "flow-parent-789", workerStage: "docling" }
│  JobExecution { flowJobId: "flow-parent-789", workerStage: "knowledge-graph" }
│  JobExecution { flowJobId: "flow-parent-789", workerStage: "embedding" }
│                                              │
│  Purpose: Track WHAT happened (audit log)   │
│  Storage: MongoDB (permanent)               │
│  Cleanup: TTL index (90 days)               │
└─────────────────────────────────────────────┘
```

**Key Insight:**

- ✅ BullMQ manages **execution dependencies** (parent waits for children)
- ✅ MongoDB tracks **execution history** (flat records for querying)
- ✅ **NO coupling** between BullMQ's parent-child and MongoDB's flat schema
- ✅ `flowJobId` is a **passive reference** (read-only grouping key)

---

## Code Review: Update Patterns

### ✅ Connector Sync Worker

**Pattern:** Self-contained updates only

```typescript
// CREATE sync JobExecution
const syncJobExec = await JobExecution.create({
  bullJobId: job.id,
  workerStage: 'connector-sync',
  tenantId,
  sourceId,
  status: 'running',
});

// For each document: UPDATE SearchDocument (self-update)
await SearchDocument.updateOne(
  { _id: documentId },
  { syncJobExecutionId: syncJobExec._id }, // ← Sets foreign key only
);

// UPDATE sync JobExecution (self-update)
await JobExecution.updateOne(
  { _id: syncJobExec._id },
  { status: 'completed', 'metrics.itemsProcessed': count },
);

// ✅ NO updates to:
// - Child JobExecutions (don't exist yet)
// - Parent documents
// - Arrays in other collections
```

---

### ✅ Ingestion Worker

**Pattern:** Create new, update self, no parent updates

```typescript
// CREATE ingestion JobExecution
const jobExec = await JobExecution.create({
  bullJobId: job.id,
  workerStage: 'docling-extraction',
  tenantId, documentId, sourceId, indexId,
  flowJobId: job.data.flowJobId,  // ← Extracted from job data (passive)
  pipelineId: job.data.pipelineId,
  pipelineVersion: job.data.pipelineVersion,
  status: 'running'
});

// Do work...

// UPDATE this JobExecution only (self-update)
await JobExecution.updateOne(
  { _id: jobExec._id },
  { status: 'completed', metrics: {...} }
);

// ✅ NO updates to:
// - Flow parent JobExecution
// - Sibling JobExecutions
// - SearchDocument.syncJobExecutionId (stays unchanged)
```

---

### ✅ Flow Creation

**Pattern:** Store reference in SearchDocument, no reverse updates

```typescript
// CREATE BullMQ Flow (Redis)
const flowParent = await flowProducer.add({
  name: 'ingestion-flow',
  queueName: 'docling-extraction',
  data: { documentId, pipelineId, pipelineVersion },
  children: [...]
});

// UPDATE SearchDocument with flow reference (self-update)
await SearchDocument.updateOne(
  { _id: documentId },
  { ingestionFlowJobId: flowParent.job.id }  // ← Foreign key only
);

// ✅ NO updates to:
// - JobExecution records (don't exist yet)
// - Parent SearchDocument arrays
// - ConnectorConfig
```

---

## Severity Assessment

### CRITICAL: ✅ PASS - No Hot Documents

**Finding:** Zero hot document patterns detected

**Evidence:**

- ✅ Each JobExecution updated once by creator
- ✅ No shared parent document with concurrent writes
- ✅ MongoDB write contention: NONE

**Impact:** Scalability preserved, no performance degradation at scale

---

### CRITICAL: ✅ PASS - No Array Bloat

**Finding:** Zero unbounded array growth detected

**Evidence:**

- ✅ All new fields are scalar (string, number)
- ✅ `syncJobExecutionId` stores latest only (overwrites)
- ✅ `ingestionFlowJobId` stores latest only (overwrites)
- ✅ Document size constant regardless of usage

**Impact:** Index performance preserved, no document size limits hit

---

### CRITICAL: ✅ PASS - No Recursive Queries

**Finding:** All queries use O(1) index scans

**Evidence:**

- ✅ `find({ flowJobId })` → direct index lookup
- ✅ `find({ documentId })` → direct index lookup
- ✅ `find({ sourceId })` → direct index lookup
- ✅ NO `$graphLookup` or parent-child traversal

**Impact:** Query performance < 500ms maintained (RFC-005 requirement)

---

### HIGH: ✅ PASS - No Race Conditions

**Finding:** Zero concurrent update conflicts detected

**Evidence:**

- ✅ Each worker updates own document only
- ✅ No atomic array operations needed
- ✅ No transactions required for consistency

**Impact:** System reliability preserved, no lost updates

---

## Comparison to Industry Patterns

### ✅ Alignment with RFC-005 Analysis

**RFC-005 Industry Survey:**

| System           | Scale             | Pattern     | Reason                 |
| ---------------- | ----------------- | ----------- | ---------------------- |
| Airflow          | <1M tasks/day     | Flat schema | Performance            |
| Dagster          | <500K runs/day    | Flat schema | Simplicity             |
| **ABL Platform** | <1M jobs/day      | Flat schema | ✅ CORRECT CHOICE      |
| Temporal         | >1M workflows/day | Dual-system | Separation of concerns |

**Validation:**

- ✅ ABL Platform scale: <1M jobs/day → Flat schema is **optimal**
- ✅ Design matches **Airflow/Dagster** pattern (proven at scale)
- ✅ NO need for dual-system complexity (Temporal pattern)

---

## Final Verdict

### ✅ APPROVED - Flat Schema Design Maintained

**Summary:**

1. ✅ **ZERO parent-child relationships** in MongoDB data model
2. ✅ **ZERO hot document patterns** (no concurrent parent updates)
3. ✅ **ZERO array bloat** (all fields scalar)
4. ✅ **ZERO recursive queries** (O(1) index scans only)
5. ✅ **ZERO race conditions** (independent writes)
6. ✅ **Clear separation** between BullMQ orchestration and MongoDB tracking

**Architectural Principles:**

- ✅ RFC-005 flat schema design: **PRESERVED**
- ✅ RFC-006 minimal enhancements: **ADHERED TO**
- ✅ Industry best practices: **FOLLOWED**

**Confidence Level:** 🟢 **HIGH**

The pluggable pipelines design **strictly maintains** the flat schema architecture. The addition of `flowJobId`, `pipelineId`, and `pipelineVersion` fields are **passive grouping keys** that enable filtering and analytics without introducing any parent-child update patterns.

---

## Recommendation

✅ **APPROVE FOR IMPLEMENTATION**

**Rationale:**

1. Design is **architecturally sound** (flat schema preserved)
2. Performance characteristics **maintained** (no hot documents)
3. Scalability **preserved** (no array bloat or recursive queries)
4. Implementation risk **LOW** (follows existing patterns)
5. Backward compatibility **maintained** (optional fields)

**Next Steps:**

1. Implement RFC-006 schema changes (3 fields, 2 indexes)
2. Add instrumentation wrapper to workers
3. Add PipelineFlowBuilder for flow creation
4. Update SearchDocument model with sync/flow references
5. Follow implementation plan in design document (Section 5)

---

## Appendix: Glossary

**Flat Schema:** Database design where records have context fields for grouping instead of parent-child links

**Hot Document:** Document updated concurrently by multiple workers causing write contention

**Array Bloat:** Unbounded array growth in documents causing performance degradation

**Context Field:** Field used for filtering/grouping without creating relationships (e.g., `flowJobId`)

**Parent-Child Relationship:** Document references requiring cascading updates (AVOIDED)

**Grouping Field:** Static reference for querying related records (USED)

---

**Review Complete** ✅
