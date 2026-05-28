# BullMQ Flows Integration Patterns for Pluggable Pipelines

**Task:** Research #37 - BullMQ Flows production patterns and best practices
**Status:** Complete
**Date:** 2026-03-07

---

## Executive Summary

This research document explores how to integrate BullMQ Flows into SearchAI's pluggable pipeline architecture. It builds on the comprehensive production knowledge in `BULLMQ-FLOWS-PRODUCTION-GUIDE.md` and focuses specifically on implementation patterns for the pipeline system.

**Key Findings:**

1. **PipelineFlowBuilder Pattern:** Automated flow structure generation from pipeline definitions (no manual flow construction)
2. **Worker Flow-Agnosticism:** Workers remain unchanged, BullMQ handles orchestration via Redis
3. **Shared Queue Architecture:** All flows share queues (not per-flow queues), BullMQ tracks parent-child via metadata
4. **Per-Stage Lock Duration:** Different stage types need different lock durations (10min for extraction, 2min for enrichment)
5. **Mandatory Child Failure Options:** Must set `failParentOnFailure: true` on critical stages, `ignoreDependencyOnFailure: true` on non-critical
6. **Flow Validation Wrapper:** Wrap `FlowProducer.add()` to detect silent failures (Issue #3851)
7. **Backpressure Required:** Application-level queue depth checks (BullMQ has no built-in limit)

**Related Documents:**

- `docs/searchai/BULLMQ-FLOWS-PRODUCTION-GUIDE.md` - Comprehensive production guide (issues, scaling, monitoring)
- `docs/searchai/rfcs/RFC-004-FLOW-BASED-ARCHITECTURE.md` - Pipeline architecture design
- `docs/searchai/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md` - Job tracking integration

---

## Table of Contents

1. [BullMQ Flows Fundamentals](#bullmq-flows-fundamentals)
2. [PipelineFlowBuilder Pattern](#pipelineflowbuilder-pattern)
3. [Queue Architecture](#queue-architecture)
4. [Job Data Structure](#job-data-structure)
5. [Worker Integration](#worker-integration)
6. [Lock Duration Strategy](#lock-duration-strategy)
7. [Child Failure Options](#child-failure-options)
8. [Flow Validation Wrapper](#flow-validation-wrapper)
9. [Backpressure Control](#backpressure-control)
10. [Retry Strategy](#retry-strategy)
11. [Graceful Shutdown](#graceful-shutdown)
12. [Testing Patterns](#testing-patterns)
13. [Implementation Checklist](#implementation-checklist)

---

## BullMQ Flows Fundamentals

### How Flows Work (From Production Guide)

**Key Insight:** BullMQ Flows use **existing shared queues** for all flow instances. Workers process jobs without flow awareness.

```
FlowProducer.add(flow)
       ↓
Creates parent job in Redis (status: waiting-children)
       ↓
Creates child jobs in respective shared queues
       ↓
Workers pick up child jobs (no knowledge of flows)
       ↓
On child completion, BullMQ Lua script notifies parent
       ↓
Parent checks: all children done?
  YES → Creates next stage jobs OR marks parent complete
  NO  → Continues waiting
```

### Critical Production Issues (Must Address)

From `BULLMQ-FLOWS-PRODUCTION-GUIDE.md`:

1. **Parent stuck waiting-children forever** (Issue #3362) → Must set `failParentOnFailure: true`
2. **FlowProducer.add() silent failure** (Issue #3851) → Must validate flow creation
3. **Stalled jobs don't fail parents** (Issue #2464) → Must set per-stage `lockDuration`
4. **No built-in backpressure** → Must implement application-level checks
5. **Flow cleanup keys accumulate** (Issue #1572) → Must set `removeOnComplete`/`removeOnFail` on children

---

## PipelineFlowBuilder Pattern

### Problem Statement

Manual flow construction is error-prone and violates DRY principle:

```typescript
// ❌ WRONG: Manual flow construction (error-prone, repetitive)
const flow = {
  name: 'doc-123-pipeline',
  queueName: 'search-extraction',
  data: { documentId: 'doc-123' },
  children: [
    {
      name: 'chunking',
      queueName: 'search-chunking',
      children: [
        { name: 'embedding', queueName: 'search-embedding', children: [] },
        { name: 'enrichment', queueName: 'search-enrichment', children: [] },
      ],
    },
  ],
};
```

**Issues:**

- Queue names hardcoded
- No validation of stage sequence
- Missing `failParentOnFailure` options
- No lock duration configuration
- Caller must know BullMQ flow structure

### Solution: PipelineFlowBuilder

**Pattern:** Builder reads pipeline definition from database and generates BullMQ flow structure automatically.

```typescript
import { FlowJob, FlowChildJob } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';

export class PipelineFlowBuilder {
  private logger = createLogger('pipeline-flow-builder');

  constructor(
    private pipelineDefinitionRepo: IPipelineDefinitionRepository,
    private queueRegistry: QueueRegistry,
  ) {}

  /**
   * Build BullMQ flow structure from pipeline definition
   *
   * @param pipelineId - Pipeline definition ID
   * @param document - Document to process
   * @returns BullMQ FlowJob structure
   */
  async buildFlow(pipelineId: string, document: ISearchDocument): Promise<FlowJob> {
    // Load pipeline definition
    const pipeline = await this.pipelineDefinitionRepo.findById(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline definition not found: ${pipelineId}`);
    }

    // Select flow based on document metadata
    const selectedFlow = this.selectFlow(pipeline, document);

    // Resolve stages (flow-specific + shared)
    const stages = this.resolveStages(selectedFlow, pipeline);

    // Validate stage sequence
    this.validateStageSequence(stages);

    // Build flow structure
    const flowJob: FlowJob = {
      name: `${document._id}-${selectedFlow.id}`,
      queueName: this.getQueueForStage(stages[0]),
      data: {
        // Flow context (used by job tracking, not workers)
        documentId: document._id.toString(),
        tenantId: document.tenantId,
        knowledgeBaseId: document.knowledgeBaseId,
        flowId: selectedFlow.id,
        pipelineId: pipeline._id.toString(),
        pipelineVersion: pipeline.version,
      },
      opts: {
        // CRITICAL: Fail parent if any child fails (see Issue #3362)
        failParentOnFailure: true,

        // Clean up completed/failed flows
        removeOnComplete: { age: 3600, count: 200 }, // 1 hour or 200 jobs
        removeOnFail: { age: 86400, count: 1000 }, // 24 hours or 1000 jobs
      },
      children: this.buildStageChildren(stages, document, selectedFlow),
    };

    return flowJob;
  }

  /**
   * Select flow based on document metadata using CEL rules
   */
  private selectFlow(pipeline: PipelineDefinition, document: ISearchDocument): PipelineFlow {
    const enabledFlows = pipeline.flows
      .filter((f) => f.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const flow of enabledFlows) {
      if (this.evaluateSelectionRules(flow.selectionRules, document)) {
        return flow;
      }
    }

    throw new NoMatchingFlowError(`No matching flow found for document ${document._id}`, {
      documentId: document._id,
      pipelineId: pipeline._id,
    });
  }

  /**
   * Resolve stages: flow-specific + shared (with overrides)
   */
  private resolveStages(flow: PipelineFlow, pipeline: PipelineDefinition): PipelineStage[] {
    const stages: PipelineStage[] = [];

    // 1. Flow-specific stages (extraction, chunking)
    stages.push(...flow.stages);

    // 2. Shared enrichment (if not overridden by flow)
    if (flow.customEnrichment) {
      stages.push(...flow.customEnrichment);
    } else if (pipeline.sharedEnrichment) {
      stages.push(...pipeline.sharedEnrichment);
    }

    // 3. Shared indexing (if not overridden by flow)
    if (flow.customIndexing) {
      stages.push(...flow.customIndexing);
    } else if (pipeline.sharedIndexing) {
      stages.push(...pipeline.sharedIndexing);
    }

    return stages;
  }

  /**
   * Build child jobs for each stage
   */
  private buildStageChildren(
    stages: PipelineStage[],
    document: ISearchDocument,
    flow: PipelineFlow,
  ): FlowChildJob[] {
    return stages.map((stage, index) => {
      const queueName = this.getQueueForStage(stage);
      const lockDuration = this.getLockDuration(stage.type);

      return {
        name: `${stage.id}-${document._id}`,
        queueName,
        data: {
          // Stage execution context
          documentId: document._id.toString(),
          tenantId: document.tenantId,
          knowledgeBaseId: document.knowledgeBaseId,
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          stageIndex: index,
          provider: stage.provider,
          providerConfig: stage.providerConfig,
          onError: stage.onError,
          fallbackProvider: stage.fallbackProvider,
          fallbackConfig: stage.fallbackConfig,

          // Flow context (for job tracking)
          flowId: flow.id,
        },
        opts: {
          // CRITICAL: Fail parent if critical stage fails
          failParentOnFailure: stage.onError === 'fail',

          // CRITICAL: Continue parent if non-critical stage fails
          ignoreDependencyOnFailure: stage.onError === 'continue',

          // Per-stage lock duration (prevent stalls)
          lockDuration,
          stalledInterval: lockDuration / 2,

          // Retry with exponential backoff
          attempts: this.getRetryAttempts(stage.type),
          backoff: {
            type: 'exponential',
            delay: this.getRetryDelay(stage.type),
          },

          // Clean up (MUST set on children, not just parent)
          removeOnComplete: { age: 3600, count: 200 },
          removeOnFail: { age: 86400, count: 1000 },
        },
      };
    });
  }

  /**
   * Get queue name for stage type
   */
  private getQueueForStage(stage: PipelineStage): string {
    const QUEUE_MAP: Record<PipelineStageType, string> = {
      extraction: 'search-extraction',
      chunking: 'search-chunking',
      enrichment: 'search-enrichment',
      embedding: 'search-embedding',
      'knowledge-graph': 'search-knowledge-graph',
      multimodal: 'search-multimodal',
    };

    const queueName = QUEUE_MAP[stage.type];
    if (!queueName) {
      throw new Error(`Unknown stage type: ${stage.type}`);
    }

    return queueName;
  }

  /**
   * Get lock duration for stage type (prevent stalled jobs)
   */
  private getLockDuration(stageType: PipelineStageType): number {
    const LOCK_DURATIONS: Record<PipelineStageType, number> = {
      extraction: 600_000, // 10 min (large PDFs via Docling)
      chunking: 120_000, // 2 min
      enrichment: 120_000, // 2 min (LLM calls)
      embedding: 180_000, // 3 min (batch embedding)
      'knowledge-graph': 300_000, // 5 min (Neo4j writes)
      multimodal: 180_000, // 3 min (vision API)
    };

    return LOCK_DURATIONS[stageType] || 60_000; // Default 1 min
  }

  /**
   * Get retry attempts for stage type
   */
  private getRetryAttempts(stageType: PipelineStageType): number {
    const RETRY_ATTEMPTS: Record<PipelineStageType, number> = {
      extraction: 3, // External service, may have transient failures
      chunking: 2, // Internal, less likely to fail
      enrichment: 3, // LLM API, may have rate limits
      embedding: 3, // Embedding API, may have rate limits
      'knowledge-graph': 2, // Neo4j, less likely to fail
      multimodal: 3, // Vision API, may have rate limits
    };

    return RETRY_ATTEMPTS[stageType] || 2;
  }

  /**
   * Get retry delay for stage type (exponential backoff base)
   */
  private getRetryDelay(stageType: PipelineStageType): number {
    const RETRY_DELAYS: Record<PipelineStageType, number> = {
      extraction: 5000, // 5s base (5s, 10s, 20s)
      chunking: 2000, // 2s base
      enrichment: 10000, // 10s base (10s, 20s, 40s) - LLM rate limits
      embedding: 10000, // 10s base
      'knowledge-graph': 3000, // 3s base
      multimodal: 10000, // 10s base
    };

    return RETRY_DELAYS[stageType] || 5000; // Default 5s
  }

  /**
   * Validate stage sequence (e.g., extraction before chunking)
   */
  private validateStageSequence(stages: PipelineStage[]): void {
    const stageTypes = stages.map((s) => s.type);

    // Extraction must come before chunking
    const extractionIndex = stageTypes.indexOf('extraction');
    const chunkingIndex = stageTypes.indexOf('chunking');
    if (extractionIndex !== -1 && chunkingIndex !== -1 && extractionIndex > chunkingIndex) {
      throw new InvalidStageSequenceError('Extraction must come before chunking');
    }

    // Chunking must come before embedding
    const embeddingIndex = stageTypes.indexOf('embedding');
    if (chunkingIndex !== -1 && embeddingIndex !== -1 && chunkingIndex > embeddingIndex) {
      throw new InvalidStageSequenceError('Chunking must come before embedding');
    }

    // No duplicate stage IDs
    const stageIds = stages.map((s) => s.id);
    const duplicates = stageIds.filter((id, index) => stageIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
      throw new InvalidStageSequenceError(`Duplicate stage IDs: ${duplicates.join(', ')}`);
    }
  }

  /**
   * Evaluate flow selection rules using CEL
   */
  private evaluateSelectionRules(
    rules: RuleCondition[] | undefined,
    document: ISearchDocument,
  ): boolean {
    if (!rules || rules.length === 0) {
      return false; // No rules = no match
    }

    // Build document context for CEL evaluation
    const context = {
      contentType: document.contentType,
      contentSizeBytes: document.contentSizeBytes,
      originalReference: document.originalReference,
      sourceType: document.sourceType,
      language: document.language,
      hasExtractedText: !!document.extractedText,
      pageCount: document.pageCount || 0,
      metadata: document.sourceMetadata || {},
      classification: document.classification || {},
    };

    // Evaluate all rules (AND logic)
    for (const rule of rules) {
      if (!this.evaluateRule(rule, context)) {
        return false;
      }
    }

    return true;
  }

  private evaluateRule(rule: RuleCondition, context: Record<string, unknown>): boolean {
    // Simple rule evaluation (field operator value)
    if (rule.type === 'simple') {
      return this.evaluateSimpleRule(rule, context);
    }

    // Compound rule (AND/OR logic)
    if (rule.type === 'compound') {
      return this.evaluateCompoundRule(rule, context);
    }

    // CEL expression
    if (rule.type === 'cel') {
      return this.evaluateCelExpression(rule.celExpression, context);
    }

    return false;
  }
}
```

### Usage Example

```typescript
// Caller code (simple, no BullMQ knowledge required)
const flowBuilder = new PipelineFlowBuilder(pipelineRepo, queueRegistry);

// Build flow from pipeline definition
const flowJob = await flowBuilder.buildFlow(pipelineId, document);

// Add flow to BullMQ (wrapped with validation)
const safeFlowProducer = new SafeFlowProducer(flowProducer, redis);
await safeFlowProducer.addFlow(flowJob, flowJob.queueName);
```

---

## Queue Architecture

### Shared Queues (Correct Pattern)

**All flows share the same queues.** BullMQ tracks parent-child relationships via Redis metadata.

```
Queue: "search-extraction" (shared)
├── Job 1: doc-A, parent: flow-001, tenantId: tenant-123
├── Job 2: doc-B, parent: flow-002, tenantId: tenant-456
└── Job 3: doc-C, parent: flow-003, tenantId: tenant-123

Queue: "search-enrichment" (shared)
├── Job 4: doc-A, parent: flow-001, tenantId: tenant-123
├── Job 5: doc-B, parent: flow-002, tenantId: tenant-456
└── Job 6: doc-C, parent: flow-003, tenantId: tenant-123
```

**Why Shared Queues?**

- **Worker efficiency:** Workers process jobs from shared queue (no idle workers)
- **BullMQ design:** Flows use existing queues, not per-flow queues
- **Horizontal scaling:** Add more workers to existing queues
- **Redis memory:** Fewer queues = less Redis memory overhead

### Queue Naming Convention

```typescript
// Queue name format: search-{stage-type}
const QUEUE_NAMES = {
  extraction: 'search-extraction',
  chunking: 'search-chunking',
  enrichment: 'search-enrichment',
  embedding: 'search-embedding',
  'knowledge-graph': 'search-knowledge-graph',
  multimodal: 'search-multimodal',
};
```

### Queue Configuration

```typescript
import { Queue, QueueOptions } from 'bullmq';
import { getRedisConnection } from '@abl/config';

export function createPipelineQueue(queueName: string): Queue {
  const connection = getRedisConnection();

  const options: QueueOptions = {
    connection,

    // CRITICAL: Limit event stream memory growth (Issue #1572)
    streams: {
      events: {
        maxLen: 10_000, // Keep last 10K events per queue
      },
    },

    // Default job options (can be overridden per job)
    defaultJobOptions: {
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 86400, count: 1000 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    },
  };

  return new Queue(queueName, options);
}
```

---

## Job Data Structure

### Flow Parent Job Data

```typescript
interface FlowJobData {
  // Document context
  documentId: string;
  tenantId: string;
  knowledgeBaseId: string;

  // Flow context (for job tracking)
  flowId: string;
  pipelineId: string;
  pipelineVersion: number;
}
```

**Why this structure?**

- **Minimal:** Only essential context (workers don't need flow details)
- **Immutable:** Document/tenant IDs never change
- **Traceable:** `flowId` links to job tracking system

### Stage Child Job Data

```typescript
interface StageJobData {
  // Document context
  documentId: string;
  tenantId: string;
  knowledgeBaseId: string;

  // Stage execution context
  stageId: string;
  stageName: string;
  stageType: PipelineStageType;
  stageIndex: number;
  provider: string;
  providerConfig: Record<string, unknown>;
  onError: 'fail' | 'continue';

  // Optional fallback
  fallbackProvider?: string;
  fallbackConfig?: Record<string, unknown>;

  // Flow context (for job tracking)
  flowId: string;
}
```

**Why this structure?**

- **Self-contained:** Worker has all context needed to execute stage
- **No database lookups:** Worker doesn't need to load pipeline definition
- **Provider-agnostic:** `providerConfig` is generic (supports any provider)

### Data Size Considerations

**Problem:** Large `providerConfig` objects increase Redis memory usage.

**Solution:** Reference config by ID instead of inlining:

```typescript
// ❌ BAD: Inline large config (increases Redis memory)
data: {
  providerConfig: {
    model: 'gpt-4',
    temperature: 0,
    systemPrompt: '... 5000 characters ...',
    fewShotExamples: [/* 50 examples */],
  },
}

// ✅ GOOD: Reference config by ID (smaller payload)
data: {
  providerConfigId: 'config-123', // Worker loads from MongoDB
}
```

---

## Worker Integration

### Worker Flow-Agnosticism

**Key Principle:** Workers process jobs without any knowledge of flows. BullMQ orchestration happens in Redis.

```typescript
import { Worker, Job } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';

export class PipelineWorker {
  private logger = createLogger('pipeline-worker');

  constructor(
    private queueName: string,
    private stageExecutor: StageExecutor,
    private jobTracker: JobExecutionTracker,
  ) {}

  start(): Worker {
    const worker = new Worker(
      this.queueName,
      async (job: Job<StageJobData>) => {
        return await this.processJob(job);
      },
      {
        connection: getRedisConnection(),

        // Worker options (NO flow-specific config)
        concurrency: this.getConcurrency(this.queueName),
        limiter: this.getRateLimiter(this.queueName),
      },
    );

    // Worker event handlers
    worker.on('completed', (job) => {
      this.logger.info('Job completed', {
        jobId: job.id,
        queueName: this.queueName,
        documentId: job.data.documentId,
      });
    });

    worker.on('failed', (job, error) => {
      this.logger.error('Job failed', {
        jobId: job?.id,
        queueName: this.queueName,
        documentId: job?.data.documentId,
        error: error.message,
      });
    });

    return worker;
  }

  /**
   * Process stage job (flow-agnostic)
   */
  private async processJob(job: Job<StageJobData>): Promise<StageOutput> {
    const {
      documentId,
      tenantId,
      stageId,
      stageName,
      stageType,
      provider,
      providerConfig,
      onError,
    } = job.data;

    // Start job tracking
    await this.jobTracker.recordStart({
      bullJobId: job.id!,
      documentId,
      tenantId,
      workerStage: stageType,
      flowId: job.data.flowId, // Optional flow context
    });

    try {
      // Execute stage (no flow awareness)
      const result = await this.stageExecutor.executeStage(
        {
          id: stageId,
          name: stageName,
          type: stageType,
          provider,
          providerConfig,
          onError,
        },
        { documentId },
        { tenantId, documentId },
      );

      // Record success
      await this.jobTracker.recordSuccess(job.id!, result);

      return result;
    } catch (error) {
      // Record failure
      await this.jobTracker.recordFailure(job.id!, error);

      // Handle circuit breaker errors (don't retry)
      if (error instanceof CircuitOpenError) {
        throw new UnrecoverableError(`Circuit breaker open for ${provider}: ${error.message}`);
      }

      // Re-throw to trigger BullMQ retry
      throw error;
    }
  }

  /**
   * Get concurrency per queue
   */
  private getConcurrency(queueName: string): number {
    const CONCURRENCY_MAP: Record<string, number> = {
      'search-extraction': 5, // Docling service has limited capacity
      'search-chunking': 10, // CPU-bound, higher concurrency
      'search-enrichment': 8, // LLM rate limits
      'search-embedding': 8, // Embedding API rate limits
      'search-knowledge-graph': 5, // Neo4j write limits
      'search-multimodal': 5, // Vision API rate limits
    };

    return CONCURRENCY_MAP[queueName] || 5;
  }

  /**
   * Get rate limiter per queue (per-tenant limits handled at application level)
   */
  private getRateLimiter(queueName: string): { max: number; duration: number } | undefined {
    // BullMQ rate limiter is global (not per-tenant)
    // Use application-level rate limiting for per-tenant control
    return undefined;
  }
}
```

### Worker Startup

```typescript
// apps/search-ai/src/workers/index.ts
import { getRedisConnection } from '@abl/config';

async function startWorkers() {
  const redis = getRedisConnection();
  const stageExecutor = new StageExecutor(breakerManager, providerRegistry);
  const jobTracker = new JobExecutionTracker(redis);

  // Start workers for each queue
  const workers = [
    new PipelineWorker('search-extraction', stageExecutor, jobTracker).start(),
    new PipelineWorker('search-chunking', stageExecutor, jobTracker).start(),
    new PipelineWorker('search-enrichment', stageExecutor, jobTracker).start(),
    new PipelineWorker('search-embedding', stageExecutor, jobTracker).start(),
    new PipelineWorker('search-knowledge-graph', stageExecutor, jobTracker).start(),
    new PipelineWorker('search-multimodal', stageExecutor, jobTracker).start(),
  ];

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  });
}

startWorkers().catch((error) => {
  console.error('Failed to start workers', error);
  process.exit(1);
});
```

---

## Lock Duration Strategy

### Problem: Stalled Jobs

**Scenario:** Worker's event loop blocked (CPU-intensive work), job lock expires, BullMQ marks job as stalled and re-queues.

**Impact:**

- Job runs on two workers simultaneously (duplicate processing)
- Double LLM charges
- Inconsistent state (two workers writing to same document)

### Solution: Per-Stage Lock Duration

Set `lockDuration` longer than expected job duration for each stage type.

**Lock Duration Formula:**

```
lockDuration = P95_job_duration * 2 + safety_margin
stalledInterval = lockDuration / 2
```

**Example:**

- Docling extraction P95: 4 minutes
- Lock duration: 4 \* 2 + 2 = 10 minutes
- Stalled interval: 5 minutes (check for stalls every 5 min)

### Lock Duration Configuration

```typescript
const LOCK_DURATIONS: Record<PipelineStageType, number> = {
  // Extraction: Large PDFs can take 5+ minutes
  extraction: 600_000, // 10 min

  // Chunking: Hierarchical tree building can take 1+ minutes
  chunking: 120_000, // 2 min

  // Enrichment: LLM calls (P95: 30s, but may retry 3x)
  enrichment: 120_000, // 2 min

  // Embedding: Batch embedding (100 chunks * 500ms = 50s)
  embedding: 180_000, // 3 min

  // Knowledge Graph: Neo4j writes (thousands of entities)
  'knowledge-graph': 300_000, // 5 min

  // Multimodal: Vision API calls (may be slow)
  multimodal: 180_000, // 3 min
};
```

### Monitoring Stalled Jobs

```typescript
// Monitor stalled job count
const queue = new Queue('search-extraction', { connection });
const stalledCount = await queue.getStalledCount();

if (stalledCount > 10) {
  alerting.send({
    severity: 'high',
    title: 'High stalled job count in search-extraction queue',
    message: `${stalledCount} jobs stalled, may indicate event loop blocking`,
  });
}
```

---

## Child Failure Options

### Critical Decision: What Happens When Child Fails?

**Default BullMQ Behavior (NO OPTION SET):** Parent waits FOREVER for failed child.

**This is the #1 most reported issue with BullMQ Flows.**

### Three Options

```typescript
// Option 1: Fail entire flow if child fails (RECOMMENDED for critical stages)
childOpts: {
  failParentOnFailure: true,
}

// Option 2: Continue flow even if child fails (for non-critical stages)
childOpts: {
  ignoreDependencyOnFailure: true,
}

// Option 3: Remove dependency (parent stops waiting for this child)
childOpts: {
  removeDependencyOnFailure: true,
}

// ❌ Option 4: Do nothing (DEFAULT) → Parent waits FOREVER
// NEVER use default behavior!
```

### Decision Matrix

| Stage Type      | Criticality  | Child Failure Option        | Rationale                                           |
| --------------- | ------------ | --------------------------- | --------------------------------------------------- |
| Extraction      | CRITICAL     | `failParentOnFailure`       | Cannot proceed without extracted text               |
| Chunking        | CRITICAL     | `failParentOnFailure`       | Cannot proceed without chunks                       |
| Embedding       | CRITICAL     | `failParentOnFailure`       | Document unsearchable without embeddings            |
| Enrichment      | NON-CRITICAL | `ignoreDependencyOnFailure` | Document still searchable without entity extraction |
| Knowledge Graph | NON-CRITICAL | `ignoreDependencyOnFailure` | Document still searchable without knowledge graph   |
| Multimodal      | NON-CRITICAL | `ignoreDependencyOnFailure` | Document still searchable without image analysis    |

### Implementation in PipelineFlowBuilder

```typescript
private buildStageChildren(stages: PipelineStage[], document: ISearchDocument): FlowChildJob[] {
  return stages.map((stage) => ({
    name: `${stage.id}-${document._id}`,
    queueName: this.getQueueForStage(stage),
    data: { /* ... */ },
    opts: {
      // CRITICAL: Set child failure option based on stage onError policy
      failParentOnFailure: stage.onError === 'fail',
      ignoreDependencyOnFailure: stage.onError === 'continue',

      // Other options...
    },
  }));
}
```

### Testing Child Failure Behavior

```typescript
describe('PipelineFlowBuilder - child failure options', () => {
  it('should fail parent when critical stage fails', async () => {
    const flow = await flowBuilder.buildFlow(pipelineId, document);

    // Find extraction stage child
    const extractionChild = flow.children.find((c) => c.name.includes('extract'));

    // Assert failParentOnFailure is set
    expect(extractionChild.opts.failParentOnFailure).toBe(true);
    expect(extractionChild.opts.ignoreDependencyOnFailure).toBeFalsy();
  });

  it('should continue parent when non-critical stage fails', async () => {
    const flow = await flowBuilder.buildFlow(pipelineId, document);

    // Find enrichment stage child
    const enrichmentChild = flow.children.find((c) => c.name.includes('enrich'));

    // Assert ignoreDependencyOnFailure is set
    expect(enrichmentChild.opts.ignoreDependencyOnFailure).toBe(true);
    expect(enrichmentChild.opts.failParentOnFailure).toBeFalsy();
  });
});
```

---

## Flow Validation Wrapper

### Problem: Silent Flow Creation Failure

**Issue #3851 (OPEN, March 2026):** `FlowProducer.add()` does not throw when Redis operations fail (e.g., during managed Redis READONLY maintenance windows).

**Impact:** Zombie flows — system believes pipeline started, but no jobs exist in Redis.

### Solution: Validation Wrapper

```typescript
import { FlowProducer, FlowJob, JobNode, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createLogger } from '@abl/compiler/platform';

export class SafeFlowProducer {
  private logger = createLogger('safe-flow-producer');

  constructor(
    private flowProducer: FlowProducer,
    private redis: Redis,
  ) {}

  /**
   * Add flow with validation (detect silent failures)
   *
   * @param flow - BullMQ flow structure
   * @param parentQueueName - Queue name for parent job
   * @returns JobNode with validated parent job
   * @throws FlowCreationError if flow creation fails silently
   */
  async addFlow(flow: FlowJob, parentQueueName: string): Promise<JobNode> {
    // 1. Create flow
    const result = await this.flowProducer.add(flow);

    // 2. CRITICAL: Verify parent job actually exists in Redis
    const parentQueue = new Queue(parentQueueName, { connection: this.redis });
    const parentJob = await parentQueue.getJob(result.job.id);

    if (!parentJob) {
      this.logger.error('Flow creation failed silently', {
        flowName: flow.name,
        parentJobId: result.job.id,
        parentQueueName,
      });

      throw new FlowCreationError(
        `Flow creation failed silently for ${flow.name}. ` +
          'Redis may be in READONLY mode or experiencing issues. ' +
          'Parent job does not exist in Redis.',
        { flowName: flow.name, parentJobId: result.job.id },
      );
    }

    // 3. Verify at least one child was created
    const children = await parentJob.getChildrenValues();
    if (Object.keys(children).length === 0) {
      this.logger.error('Flow created parent but no children', {
        flowName: flow.name,
        parentJobId: result.job.id,
        expectedChildren: flow.children?.length || 0,
      });

      throw new FlowCreationError(
        `Flow ${flow.name} created parent but no children. ` +
          'Flow definition may be invalid or Redis is experiencing issues.',
        { flowName: flow.name, parentJobId: result.job.id },
      );
    }

    // 4. Verify child count matches
    const expectedChildCount = flow.children?.length || 0;
    const actualChildCount = Object.keys(children).length;

    if (actualChildCount !== expectedChildCount) {
      this.logger.warn('Flow child count mismatch', {
        flowName: flow.name,
        parentJobId: result.job.id,
        expectedChildCount,
        actualChildCount,
      });

      // Don't throw, but log warning (children may be created async)
    }

    this.logger.info('Flow created successfully', {
      flowName: flow.name,
      parentJobId: result.job.id,
      childCount: actualChildCount,
    });

    return result;
  }
}
```

### Usage

```typescript
// Create flow
const flowJob = await flowBuilder.buildFlow(pipelineId, document);

// Add flow with validation (ALWAYS use SafeFlowProducer, not FlowProducer directly)
const safeFlowProducer = new SafeFlowProducer(flowProducer, redis);
try {
  await safeFlowProducer.addFlow(flowJob, flowJob.queueName);
} catch (error) {
  if (error instanceof FlowCreationError) {
    // Flow creation failed, mark document as error
    await SearchDocument.updateOne({ _id: documentId }, { status: 'error', error: error.message });

    // Alert (may indicate Redis READONLY mode)
    alerting.send({
      severity: 'critical',
      title: 'Flow creation failed silently',
      message: error.message,
    });
  }
  throw error;
}
```

---

## Backpressure Control

### Problem: No Built-in Queue Depth Limit

BullMQ has **no mechanism to limit queue depth**. Jobs accumulate without bound when downstream services are slow.

**Scenario:**

```
User uploads 10,000 documents
→ FlowProducer creates 10,000 flows
→ 10,000 extraction jobs in queue
→ Docling service handles 5 concurrent
→ 9,995 jobs waiting in Redis
→ Redis memory grows linearly with queue depth (5GB+ for 10K jobs)
```

### Solution: Application-Level Backpressure

```typescript
export class BackpressureController {
  private logger = createLogger('backpressure');

  constructor(private redis: Redis) {}

  /**
   * Check queue depth and throw if exceeds limit
   *
   * @param queueName - Queue to check
   * @throws BackpressureError if queue depth exceeds limit
   */
  async checkBackpressure(queueName: string): Promise<void> {
    const MAX_QUEUE_DEPTH: Record<string, number> = {
      'search-extraction': 500, // Docling service limited capacity
      'search-enrichment': 1000, // LLM calls, higher throughput
      'search-embedding': 500, // Embedding API limited capacity
      'search-knowledge-graph': 200, // Neo4j write limits
      'search-chunking': 2000, // Internal, higher capacity
      'search-multimodal': 200, // Vision API limited capacity
    };

    const maxDepth = MAX_QUEUE_DEPTH[queueName] || 500;

    // Get current queue depth
    const queue = new Queue(queueName, { connection: this.redis });
    const waitingCount = await queue.getWaitingCount();

    if (waitingCount > maxDepth) {
      this.logger.warn('Queue depth exceeds limit, rejecting new jobs', {
        queueName,
        waitingCount,
        maxDepth,
      });

      throw new BackpressureError(
        `Queue ${queueName} depth ${waitingCount} exceeds limit ${maxDepth}. ` +
          'Please wait for existing jobs to complete before adding new documents.',
        {
          queueName,
          waitingCount,
          maxDepth,
          retryAfterMs: this.estimateRetryDelay(queueName, waitingCount, maxDepth),
        },
      );
    }
  }

  /**
   * Estimate delay before queue depth drops below limit
   */
  private estimateRetryDelay(queueName: string, currentDepth: number, maxDepth: number): number {
    // Estimate processing rate (jobs per second)
    const PROCESSING_RATES: Record<string, number> = {
      'search-extraction': 0.1, // 1 job per 10s (Docling slow)
      'search-enrichment': 0.5, // 1 job per 2s (LLM calls)
      'search-embedding': 0.3, // 1 job per 3s (embedding API)
      'search-knowledge-graph': 0.2, // 1 job per 5s (Neo4j writes)
      'search-chunking': 1.0, // 1 job per 1s (internal, fast)
      'search-multimodal': 0.2, // 1 job per 5s (vision API)
    };

    const rate = PROCESSING_RATES[queueName] || 0.3;
    const excessJobs = currentDepth - maxDepth;
    const estimatedSeconds = excessJobs / rate;

    // Add 20% buffer
    return Math.ceil(estimatedSeconds * 1.2 * 1000);
  }
}
```

### Usage in Document Upload

```typescript
export class DocumentIngestionService {
  constructor(
    private flowBuilder: PipelineFlowBuilder,
    private flowProducer: SafeFlowProducer,
    private backpressure: BackpressureController,
  ) {}

  async ingestDocument(documentId: string, pipelineId: string): Promise<void> {
    const document = await SearchDocument.findById(documentId);

    // Build flow
    const flowJob = await this.flowBuilder.buildFlow(pipelineId, document);

    // Check backpressure for first queue in flow
    try {
      await this.backpressure.checkBackpressure(flowJob.queueName);
    } catch (error) {
      if (error instanceof BackpressureError) {
        // Mark document as pending, retry later
        await SearchDocument.updateOne(
          { _id: documentId },
          {
            status: 'pending',
            retryAfter: new Date(Date.now() + error.retryAfterMs),
          },
        );

        // Return error to user
        throw new ServiceUnavailableError(
          `Pipeline queue is full, document will be processed after ${error.retryAfterMs}ms`,
          { retryAfterMs: error.retryAfterMs },
        );
      }
      throw error;
    }

    // Add flow (backpressure check passed)
    await this.flowProducer.addFlow(flowJob, flowJob.queueName);
  }
}
```

---

## Retry Strategy

### Per-Stage Retry Configuration

Different stage types have different retry characteristics:

```typescript
const RETRY_CONFIG: Record<
  PipelineStageType,
  { attempts: number; baseDelay: number; maxDelay: number }
> = {
  // Extraction: External service, may have transient failures
  extraction: {
    attempts: 3,
    baseDelay: 5000, // 5s, 10s, 20s
    maxDelay: 60_000,
  },

  // Chunking: Internal, less likely to fail
  chunking: {
    attempts: 2,
    baseDelay: 2000, // 2s, 4s
    maxDelay: 10_000,
  },

  // Enrichment: LLM API, may have rate limits (429)
  enrichment: {
    attempts: 3,
    baseDelay: 10_000, // 10s, 20s, 40s (longer delays for rate limits)
    maxDelay: 120_000,
  },

  // Embedding: Embedding API, may have rate limits
  embedding: {
    attempts: 3,
    baseDelay: 10_000, // 10s, 20s, 40s
    maxDelay: 120_000,
  },

  // Knowledge Graph: Neo4j, less likely to fail
  'knowledge-graph': {
    attempts: 2,
    baseDelay: 3000, // 3s, 6s
    maxDelay: 15_000,
  },

  // Multimodal: Vision API, may have rate limits
  multimodal: {
    attempts: 3,
    baseDelay: 10_000, // 10s, 20s, 40s
    maxDelay: 120_000,
  },
};
```

### Exponential Backoff Implementation

```typescript
opts: {
  attempts: RETRY_CONFIG[stageType].attempts,
  backoff: {
    type: 'exponential',
    delay: RETRY_CONFIG[stageType].baseDelay,
  },
}
```

### Retry vs Circuit Breaker

**When to Retry:**

- Transient failures (network timeout, temporary service unavailable)
- Rate limits (429 with Retry-After header)
- Individual job failures (not systemic)

**When NOT to Retry (Circuit Breaker):**

- Circuit breaker open (provider failing systemically)
- Configuration errors (invalid API key, wrong provider)
- Document-specific errors (unsupported format, corrupted file)

```typescript
// Worker handles both retry and circuit breaker
try {
  const result = await stageExecutor.executeStage(stage, input, context);
  return result;
} catch (error) {
  // Circuit breaker open → don't retry (will fail immediately)
  if (error instanceof CircuitOpenError) {
    throw new UnrecoverableError(`Circuit breaker open: ${error.message}`);
  }

  // Document-specific error → don't retry
  if (error instanceof DocumentValidationError) {
    throw new UnrecoverableError(`Invalid document: ${error.message}`);
  }

  // Transient error → retry (BullMQ will handle)
  throw error;
}
```

---

## Graceful Shutdown

### Problem: Pod Termination During Flow Execution

**Scenario:**

```
1. Pod receives SIGTERM (Kubernetes rolling update)
2. Workers have 30s to finish current jobs (default terminationGracePeriodSeconds)
3. Worker processing extraction job (5 minutes remaining)
4. Pod forcefully killed after 30s
5. Job marked as stalled, re-queued to another worker
6. Parent flow waits indefinitely (Issue #3362)
```

### Solution: Longer Termination Grace Period

```yaml
# Kubernetes deployment
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 180 # 3 minutes (allow long jobs to finish)
      containers:
        - name: search-ai-worker
          image: search-ai:latest
```

### Worker Graceful Shutdown

```typescript
export class WorkerManager {
  private workers: Worker[] = [];

  async startWorkers(): Promise<void> {
    // Start workers for each queue
    this.workers = [
      new PipelineWorker('search-extraction', stageExecutor, jobTracker).start(),
      new PipelineWorker('search-chunking', stageExecutor, jobTracker).start(),
      // ... other workers
    ];

    // Register shutdown handlers
    this.registerShutdownHandlers();
  }

  private registerShutdownHandlers(): void {
    // SIGTERM: Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, starting graceful shutdown');
      await this.shutdown();
      process.exit(0);
    });

    // SIGINT: Graceful shutdown (Ctrl+C)
    process.on('SIGINT', async () => {
      console.log('SIGINT received, starting graceful shutdown');
      await this.shutdown();
      process.exit(0);
    });

    // Uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception', error);
      await this.shutdown();
      process.exit(1);
    });
  }

  private async shutdown(): Promise<void> {
    console.log('Closing workers...');

    // Close all workers (waits for current jobs to finish)
    await Promise.all(
      this.workers.map(async (worker) => {
        await worker.close(); // Waits for active jobs up to terminationGracePeriodSeconds
      }),
    );

    console.log('All workers closed');
  }
}
```

### Parent Job Handling on Shutdown

**Issue:** If worker pod is killed while processing a child job, parent may wait indefinitely.

**Mitigation:**

1. Set `failParentOnFailure: true` on all critical children
2. Set `maxStalledCount: 2` (mark job failed after 2 stalls, not infinite retries)
3. Monitor stalled job count and alert

```typescript
opts: {
  failParentOnFailure: true,
  maxStalledCount: 2, // Fail after 2 stalls (prevent infinite parent waiting)
  lockDuration: 600_000, // 10 min (longer than grace period)
}
```

---

## Testing Patterns

### Unit Test: Flow Builder

```typescript
describe('PipelineFlowBuilder', () => {
  let flowBuilder: PipelineFlowBuilder;
  let pipelineRepo: jest.Mocked<IPipelineDefinitionRepository>;

  beforeEach(() => {
    pipelineRepo = createMockPipelineRepo();
    flowBuilder = new PipelineFlowBuilder(pipelineRepo, queueRegistry);
  });

  describe('buildFlow', () => {
    it('should build flow structure from pipeline definition', async () => {
      const pipeline = createTestPipeline();
      const document = createTestDocument({ contentType: 'application/pdf' });

      const flowJob = await flowBuilder.buildFlow(pipeline._id, document);

      // Assert flow structure
      expect(flowJob.name).toContain(document._id);
      expect(flowJob.queueName).toBe('search-extraction');
      expect(flowJob.data.documentId).toBe(document._id.toString());
      expect(flowJob.data.tenantId).toBe(document.tenantId);
      expect(flowJob.opts.failParentOnFailure).toBe(true);
      expect(flowJob.children).toHaveLength(pipeline.flows[0].stages.length);
    });

    it('should select correct flow based on document metadata', async () => {
      const pipeline = createTestPipelineWithMultipleFlows();
      const document = createTestDocument({ contentType: 'application/pdf' });

      const flowJob = await flowBuilder.buildFlow(pipeline._id, document);

      // Should select PDF flow (priority 40)
      expect(flowJob.data.flowId).toBe('flow-pdf-docling');
    });

    it('should throw if no matching flow found', async () => {
      const pipeline = createTestPipelineWithSpecificFlows();
      const document = createTestDocument({ contentType: 'video/mp4' }); // Unsupported

      await expect(flowBuilder.buildFlow(pipeline._id, document)).rejects.toThrow(
        NoMatchingFlowError,
      );
    });

    it('should set failParentOnFailure for critical stages', async () => {
      const pipeline = createTestPipeline();
      const document = createTestDocument();

      const flowJob = await flowBuilder.buildFlow(pipeline._id, document);

      // Extraction stage (critical)
      const extractionChild = flowJob.children.find((c) => c.name.includes('extract'));
      expect(extractionChild.opts.failParentOnFailure).toBe(true);
      expect(extractionChild.opts.ignoreDependencyOnFailure).toBeFalsy();
    });

    it('should set ignoreDependencyOnFailure for non-critical stages', async () => {
      const pipeline = createTestPipeline();
      const document = createTestDocument();

      const flowJob = await flowBuilder.buildFlow(pipeline._id, document);

      // Enrichment stage (non-critical)
      const enrichmentChild = flowJob.children.find((c) => c.name.includes('enrich'));
      expect(enrichmentChild.opts.ignoreDependencyOnFailure).toBe(true);
      expect(enrichmentChild.opts.failParentOnFailure).toBeFalsy();
    });
  });
});
```

### Integration Test: Full Flow Execution

```typescript
describe('Pipeline Flow Integration', () => {
  let redis: Redis;
  let flowProducer: FlowProducer;
  let workers: Worker[];

  beforeAll(async () => {
    redis = getRedisConnection();
    flowProducer = new FlowProducer({ connection: redis });

    // Start workers
    workers = [
      new PipelineWorker('search-extraction', stageExecutor, jobTracker).start(),
      new PipelineWorker('search-chunking', stageExecutor, jobTracker).start(),
      new PipelineWorker('search-embedding', stageExecutor, jobTracker).start(),
    ];
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await flowProducer.close();
    await redis.quit();
  });

  it('should execute full pipeline flow end-to-end', async () => {
    // Create test document
    const document = await SearchDocument.create({
      tenantId: 'test-tenant',
      knowledgeBaseId: 'test-kb',
      contentType: 'application/pdf',
      originalReference: 's3://test.pdf',
    });

    // Build flow
    const flowBuilder = new PipelineFlowBuilder(pipelineRepo, queueRegistry);
    const flowJob = await flowBuilder.buildFlow(pipelineId, document);

    // Add flow
    const safeFlowProducer = new SafeFlowProducer(flowProducer, redis);
    const result = await safeFlowProducer.addFlow(flowJob, flowJob.queueName);

    // Wait for flow to complete
    await waitForFlowCompletion(result.job.id, 60_000); // 1 minute timeout

    // Assert document processed
    const updatedDoc = await SearchDocument.findById(document._id);
    expect(updatedDoc.status).toBe('indexed');
    expect(updatedDoc.extractedText).toBeDefined();

    // Assert chunks created
    const chunks = await SearchChunk.find({ documentId: document._id });
    expect(chunks.length).toBeGreaterThan(0);

    // Assert embeddings generated
    const vectorIds = chunks.map((c) => c.vectorId).filter(Boolean);
    expect(vectorIds.length).toBe(chunks.length);
  });

  it('should handle stage failure with onError: fail', async () => {
    // Mock extraction failure
    jest
      .spyOn(stageExecutor, 'executeStage')
      .mockRejectedValueOnce(new Error('Docling service unavailable'));

    const document = await SearchDocument.create({
      tenantId: 'test-tenant',
      knowledgeBaseId: 'test-kb',
      contentType: 'application/pdf',
      originalReference: 's3://test.pdf',
    });

    const flowJob = await flowBuilder.buildFlow(pipelineId, document);
    const result = await safeFlowProducer.addFlow(flowJob, flowJob.queueName);

    // Wait for flow to fail
    await waitForFlowCompletion(result.job.id, 60_000);

    // Assert flow failed
    const parentJob = await result.job.getState();
    expect(parentJob).toBe('failed');

    // Assert document marked as error
    const updatedDoc = await SearchDocument.findById(document._id);
    expect(updatedDoc.status).toBe('error');
  });

  it('should continue flow when non-critical stage fails', async () => {
    // Mock enrichment failure (non-critical)
    jest.spyOn(stageExecutor, 'executeStage').mockImplementation(async (stage) => {
      if (stage.type === 'enrichment') {
        throw new Error('LLM service unavailable');
      }
      return { success: true };
    });

    const document = await SearchDocument.create({
      tenantId: 'test-tenant',
      knowledgeBaseId: 'test-kb',
      contentType: 'application/pdf',
      originalReference: 's3://test.pdf',
    });

    const flowJob = await flowBuilder.buildFlow(pipelineId, document);
    const result = await safeFlowProducer.addFlow(flowJob, flowJob.queueName);

    // Wait for flow to complete
    await waitForFlowCompletion(result.job.id, 60_000);

    // Assert flow completed (enrichment skipped)
    const parentJob = await result.job.getState();
    expect(parentJob).toBe('completed');

    // Assert document indexed (without enrichment)
    const updatedDoc = await SearchDocument.findById(document._id);
    expect(updatedDoc.status).toBe('indexed');

    // Assert no enrichment metadata
    const chunks = await SearchChunk.find({ documentId: document._id });
    expect(chunks[0].classification).toBeUndefined();
  });
});
```

---

## Implementation Checklist

### Phase 1: Flow Builder (Week 1)

- [ ] Create `PipelineFlowBuilder` class
  - [ ] `buildFlow()` method (builds BullMQ flow structure)
  - [ ] `selectFlow()` method (CEL-based flow selection)
  - [ ] `resolveStages()` method (flow-specific + shared stages)
  - [ ] `buildStageChildren()` method (generates child jobs)
  - [ ] `validateStageSequence()` method (stage order validation)
  - [ ] `getQueueForStage()` method (queue name mapping)
  - [ ] `getLockDuration()` method (per-stage lock duration)
  - [ ] `getRetryAttempts()` method (per-stage retry attempts)
  - [ ] `getRetryDelay()` method (per-stage retry delay)

- [ ] Create `SafeFlowProducer` wrapper
  - [ ] `addFlow()` method (wraps FlowProducer.add with validation)
  - [ ] Verify parent job exists in Redis
  - [ ] Verify children created
  - [ ] Verify child count matches

- [ ] Unit tests
  - [ ] Flow structure generation
  - [ ] Flow selection (multiple flows)
  - [ ] Stage resolution (flow + shared)
  - [ ] Child failure options (failParentOnFailure, ignoreDependencyOnFailure)
  - [ ] Lock duration configuration
  - [ ] Retry configuration
  - [ ] Validation checks (stage sequence, no matching flow)

### Phase 2: Worker Integration (Week 2)

- [ ] Create `PipelineWorker` class
  - [ ] `processJob()` method (executes stage, flow-agnostic)
  - [ ] Job tracking integration (record start/success/failure)
  - [ ] Circuit breaker integration (handle CircuitOpenError)
  - [ ] Error handling (onError: fail vs continue)
  - [ ] Worker event handlers (completed, failed)

- [ ] Worker startup script
  - [ ] Start workers for all queues
  - [ ] Graceful shutdown handlers (SIGTERM, SIGINT)
  - [ ] Per-queue concurrency configuration
  - [ ] Per-queue rate limiter configuration (if needed)

- [ ] Update `StageExecutor` to handle flows
  - [ ] No changes required (already flow-agnostic)

- [ ] Integration tests
  - [ ] Full flow execution end-to-end
  - [ ] Stage failure with onError: fail
  - [ ] Stage failure with onError: continue
  - [ ] Circuit breaker integration

### Phase 3: Backpressure & Validation (Week 3)

- [ ] Create `BackpressureController` class
  - [ ] `checkBackpressure()` method (checks queue depth)
  - [ ] Per-queue depth limits
  - [ ] `estimateRetryDelay()` method (estimates wait time)

- [ ] Update document ingestion service
  - [ ] Check backpressure before creating flow
  - [ ] Return ServiceUnavailableError if queue full
  - [ ] Mark document as pending with retryAfter

- [ ] Update `SafeFlowProducer`
  - [ ] Add retry logic for transient Redis failures
  - [ ] Add monitoring/alerting for silent failures

- [ ] Integration tests
  - [ ] Backpressure rejection
  - [ ] Backpressure retry delay estimation
  - [ ] Flow validation (silent failure detection)

### Phase 4: Configuration & Monitoring (Week 4)

- [ ] Queue configuration
  - [ ] Create pipeline queues with `streams.events.maxLen`
  - [ ] Set default job options (removeOnComplete, removeOnFail)
  - [ ] Per-queue concurrency
  - [ ] Per-queue rate limiter (if needed)

- [ ] Lock duration configuration
  - [ ] Per-stage lock duration constants
  - [ ] Per-stage stalled interval

- [ ] Retry configuration
  - [ ] Per-stage retry attempts
  - [ ] Per-stage retry delay (exponential backoff)
  - [ ] Per-stage max delay

- [ ] Monitoring metrics
  - [ ] Flow creation success/failure
  - [ ] Flow completion time histogram
  - [ ] Stage execution time histogram
  - [ ] Stalled job count per queue
  - [ ] Queue depth per queue
  - [ ] Backpressure rejection count

- [ ] Dashboards (Grafana/Datadog)
  - [ ] Flow execution dashboard
  - [ ] Queue health dashboard
  - [ ] Stage performance dashboard

- [ ] Alerts
  - [ ] Flow creation silent failure
  - [ ] High stalled job count
  - [ ] Queue depth exceeds threshold
  - [ ] High backpressure rejection rate

### Phase 5: Documentation & Training (Week 5)

- [ ] Developer documentation
  - [ ] PipelineFlowBuilder usage guide
  - [ ] Worker deployment guide
  - [ ] Troubleshooting runbook
  - [ ] Configuration reference

- [ ] Operational runbooks
  - [ ] How to investigate stuck flows
  - [ ] How to manually retry failed flows
  - [ ] How to adjust backpressure limits
  - [ ] How to tune lock durations

- [ ] Training materials
  - [ ] BullMQ Flows architecture overview
  - [ ] Pipeline flow lifecycle diagram
  - [ ] Common failure scenarios and resolutions

---

## Summary

This research establishes comprehensive patterns for integrating BullMQ Flows into SearchAI's pluggable pipeline architecture:

1. **PipelineFlowBuilder:** Automated flow generation from pipeline definitions (no manual construction)
2. **Worker Flow-Agnosticism:** Workers unchanged, orchestration handled by BullMQ in Redis
3. **Shared Queue Architecture:** All flows use shared queues (not per-flow queues)
4. **Per-Stage Configuration:** Lock duration, retry attempts, and backoff delays tailored to each stage type
5. **Mandatory Child Failure Options:** Always set `failParentOnFailure` or `ignoreDependencyOnFailure` (never use default)
6. **Flow Validation Wrapper:** Detect silent failures (Issue #3851) with SafeFlowProducer
7. **Backpressure Control:** Application-level queue depth limits (BullMQ has no built-in limit)
8. **Graceful Shutdown:** Longer termination grace period (180s) to allow long jobs to finish

**Critical Production Issues Addressed:**

- ✅ Parent stuck waiting-children forever (Issue #3362) → `failParentOnFailure: true`
- ✅ FlowProducer.add() silent failure (Issue #3851) → SafeFlowProducer validation
- ✅ Stalled jobs don't fail parents (Issue #2464) → Per-stage lock duration
- ✅ No built-in backpressure → BackpressureController
- ✅ Flow cleanup keys accumulate (Issue #1572) → `removeOnComplete`/`removeOnFail` on children

**Next Steps:** Proceed to design phase (Tasks #39-46) to design the actual implementation.
