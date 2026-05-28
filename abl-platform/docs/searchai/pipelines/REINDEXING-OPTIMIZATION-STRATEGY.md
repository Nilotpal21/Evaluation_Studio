# Reindexing Strategy Design

**Date:** 2026-03-11
**Status:** DRAFT - v4 (pluggable 4-checkpoint model)
**Related Task:** #12

---

## 1. Problem Statement

When a user modifies their ingestion pipeline and publishes, existing chunks in the knowledge base may be stale. The system needs to determine:

1. **What changed** - classify the type of change
2. **What is affected** - which documents/chunks need reprocessing
3. **Where to restart** - which pipeline checkpoint to resume from
4. **What it will cost** - so the user can make an informed decision

Without reindexing, published pipeline changes only apply to NEW documents. Existing documents retain their old processing -- wrong embeddings, wrong enrichments, wrong extraction. Search quality degrades silently.

---

## 2. Four Checkpoints

A pipeline processes documents through ordered stages. We define 4 checkpoints that represent restart boundaries:

```
Document Source
      |
  [Checkpoint 1: ROUTING]     Which flow handles this document?
      |
  [Checkpoint 2: PRE-CHUNK]   extraction + chunking (creates/destroys chunks)
      |
  [Checkpoint 3: POST-CHUNK]  enrichment / LLM stages (operates on existing chunks)
      |
  [Checkpoint 4: EMBEDDING]   vector generation (operates on chunk.content)
      |
  Vector Store
```

| Checkpoint | Name       | Scope    | Destroys chunks? | Needs flowId?           | Cost   |
| ---------- | ---------- | -------- | ---------------- | ----------------------- | ------ |
| 1          | Routing    | document | potentially      | no (re-derives)         | varies |
| 2          | Pre-chunk  | document | yes              | yes (on SearchDocument) | high   |
| 3          | Post-chunk | chunk    | no               | yes (on SearchChunk)    | medium |
| 4          | Embedding  | chunk    | no               | no (all chunks)         | low    |

---

## 3. Architecture Overview

```
Pipeline Publish / Embedding Config Change
      |
  ChangeActionIdentifier         pure diff, no DB queries
      |
  ChangeSet
      |
  ChangeStore.save(changeSet)    pluggable: default MongoDB, future: custom store
      |
  Router                         reads ChangeSet, queries DB, builds plan
      |
  ReindexPlan { actions[] }
      |
  User Confirmation UI           shows impact summary, cost estimate
      |
  ReindexOrchestrator            dispatches to checkpoint handlers
      |
  CheckpointHandler[]            pluggable per-checkpoint execution
      |
  Existing Workers               embedding-worker, extraction-worker, etc.
```

### Pluggable Interfaces

Three extension points allow future changes without refactoring:

```typescript
// 1. Where change sets are stored (default: MongoDB, future: custom store)
interface ChangeStore {
  save(tenantId: string, changeSet: PersistedChangeSet): Promise<string>; // returns changeSetId
  get(tenantId: string, changeSetId: string): Promise<PersistedChangeSet | null>;
  listPending(tenantId: string, knowledgeBaseId: string): Promise<PersistedChangeSet[]>;
  markProcessed(tenantId: string, changeSetId: string): Promise<void>;
}

// 2. How each checkpoint processes its items (default: BullMQ queue dispatch)
interface CheckpointHandler {
  readonly checkpoint: 1 | 2 | 3 | 4;
  estimate(actions: ReindexAction[]): ReindexEstimate;
  execute(actions: ReindexAction[], params: ReindexParams): Promise<void>;
}

// 3. How the orchestrator is triggered (default: publish endpoint, future: conditional/scheduled)
interface ReindexTrigger {
  readonly name: string;
  shouldTrigger(context: TriggerContext): Promise<boolean>;
  buildChangeSet(context: TriggerContext): Promise<ChangeSet>;
}
```

Future examples:

- Custom `ChangeStore` that writes to S3/DynamoDB for audit trail
- Custom `CheckpointHandler` that sends to an external ML pipeline instead of BullMQ
- Custom `ReindexTrigger` that queries a store to decide whether to reindex on schedule

---

## 4. Existing Code: Reuse Map

### REUSE (do not recreate)

| What                           | Location                                                                    | How we use it                                     |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------- |
| Queue factory                  | `apps/search-ai/src/queues/index.ts`                                        | `createQueue('search-reindex')`                   |
| Worker registry                | `apps/search-ai/src/workers/index.ts`                                       | Add reindex worker to `startWorkers()` array      |
| FlowBuilder + safeAddFlow      | `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`        | Checkpoint 2 dispatches via existing flow builder |
| checkBackpressure              | `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts:122`    | All checkpoint dispatches check queue depth first |
| getRedisConnection             | `apps/search-ai/src/workers/shared.ts`                                      | All new queues/workers use this                   |
| publishProgressEvent           | `apps/search-ai/src/routes/progress.ts`                                     | Reindex progress events via existing WebSocket    |
| Embedding worker batch pattern | `apps/search-ai/src/workers/embedding-worker.ts:290`                        | Checkpoint 4 reuses existing embedding worker     |
| JobExecution model             | `packages/database/src/models/job-execution.model.ts`                       | Track reindex job executions (flat schema, TTL)   |
| FLOW_CHILD_DEFAULTS            | `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`        | All child jobs use same defaults                  |
| CrawlJobProgress UI pattern    | `apps/studio/src/components/search-ai/CrawlJobProgress.tsx`                 | Adapt for ReindexProgress component               |
| ChangeEmbeddingDialog          | `apps/studio/src/components/search-ai/pipelines/ChangeEmbeddingDialog.tsx`  | Extend with reindex confirmation                  |
| EmbeddingConfigSection         | `apps/studio/src/components/search-ai/pipelines/EmbeddingConfigSection.tsx` | Show reindex status badge                         |

### EXTEND (modify existing code)

| What                      | Location                                                    | Change                                                             |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Publish endpoint          | `apps/search-ai/src/routes/pipelines.ts:236-320`            | Add snapshot + change detection + confirmation flow                |
| Embedding-config endpoint | `apps/search-ai/src/routes/pipelines.ts:752`                | Replace TODO with ReembedCheckpointHandler dispatch                |
| Index rebuild endpoint    | `apps/search-ai/src/routes/indexes.ts:505`                  | Wire to ReindexOrchestrator (full rebuild = checkpoint 2 all docs) |
| Pipeline store (Zustand)  | `apps/studio/src/store/pipeline-store.ts`                   | Add reindex state + publish confirmation flow                      |
| Pipeline API client       | `apps/studio/src/api/pipelines.ts`                          | Add reindex endpoints, extend publish response type                |
| SearchChunk schema        | `packages/database/src/models/search-chunk.model.ts`        | Add `flowId` field + index                                         |
| SearchDocument schema     | `packages/database/src/models/search-document.model.ts`     | Add `flowId` field + index                                         |
| PipelineDefinition schema | `packages/database/src/models/pipeline-definition.model.ts` | Add `previousVersion` field                                        |
| Ingestion workers         | Various workers in `apps/search-ai/src/workers/`            | Set `flowId` when creating docs/chunks                             |

### DO NOT CREATE (already exists)

| Temptation                   | Why not                                                     | Use instead                                  |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| New ReindexJob MongoDB model | JobExecution already tracks job executions with flat schema | `JobExecution` with `workerStage: 'reindex'` |
| New Redis progress system    | Progress WebSocket infra already exists with pub/sub        | `publishProgressEvent()`                     |
| New queue/connection helpers | Shared infra exists                                         | `createQueue()`, `getRedisConnection()`      |
| New batch dispatch utility   | FlowBuilder handles this                                    | `safeAddFlow()`, `checkBackpressure()`       |

---

## 5. Change Action Identifier

Pure function comparing old pipeline vs new pipeline. No DB queries.

```typescript
interface ChangeSet {
  embeddingChanged: boolean;
  routingChanged: boolean;
  preChunkChanges: FlowStageChange[];
  postChunkChanges: FlowStageChange[];
}

interface FlowStageChange {
  flowId: string;
  flowName: string;
  stageType: PipelineStageType;
  changeType: 'added' | 'removed' | 'provider-changed' | 'config-changed';
}

interface PersistedChangeSet extends ChangeSet {
  changeSetId: string;
  tenantId: string;
  knowledgeBaseId: string;
  pipelineId: string;
  previousPipelineVersion: number;
  newPipelineVersion: number;
  status: 'pending' | 'confirmed' | 'executing' | 'completed' | 'cancelled';
  createdAt: Date;
  plan?: ReindexPlan; // populated after router runs
}
```

### Implementation

```typescript
function identifyChanges(
  oldPipeline: IPipelineDefinition,
  newPipeline: IPipelineDefinition,
): ChangeSet {
  return {
    embeddingChanged: !isDeepStrictEqual(
      oldPipeline.activeEmbeddingConfig,
      newPipeline.activeEmbeddingConfig,
    ),
    routingChanged: hasRoutingChanged(oldPipeline.flows, newPipeline.flows),
    preChunkChanges: findStageChanges(oldPipeline.flows, newPipeline.flows, [
      'extraction',
      'chunking',
    ]),
    postChunkChanges: findStageChanges(oldPipeline.flows, newPipeline.flows, ['enrichment']),
  };
}

function hasRoutingChanged(oldFlows: IPipelineFlow[], newFlows: IPipelineFlow[]): boolean {
  if (oldFlows.length !== newFlows.length) return true;

  for (const newFlow of newFlows) {
    const oldFlow = oldFlows.find((f) => f.id === newFlow.id);
    if (!oldFlow) return true;
    if (oldFlow.enabled !== newFlow.enabled) return true;
    if (oldFlow.priority !== newFlow.priority) return true;
    if (!isDeepStrictEqual(oldFlow.selectionRules, newFlow.selectionRules)) return true;
  }

  for (const oldFlow of oldFlows) {
    if (!newFlows.some((f) => f.id === oldFlow.id) && oldFlow.enabled) return true;
  }

  return false;
}

function findStageChanges(
  oldFlows: IPipelineFlow[],
  newFlows: IPipelineFlow[],
  stageTypes: PipelineStageType[],
): FlowStageChange[] {
  const changes: FlowStageChange[] = [];

  for (const newFlow of newFlows) {
    const oldFlow = oldFlows.find((f) => f.id === newFlow.id);
    if (!oldFlow) continue; // new flow, no existing docs

    for (const stageType of stageTypes) {
      const oldStage = oldFlow.stages.find((s) => s.type === stageType);
      const newStage = newFlow.stages.find((s) => s.type === stageType);

      if (!oldStage && !newStage) continue;
      if (!oldStage && newStage) {
        changes.push({
          flowId: newFlow.id,
          flowName: newFlow.name,
          stageType,
          changeType: 'added',
        });
      } else if (oldStage && !newStage) {
        changes.push({
          flowId: newFlow.id,
          flowName: newFlow.name,
          stageType,
          changeType: 'removed',
        });
      } else if (oldStage!.provider !== newStage!.provider) {
        changes.push({
          flowId: newFlow.id,
          flowName: newFlow.name,
          stageType,
          changeType: 'provider-changed',
        });
      } else if (!isDeepStrictEqual(oldStage!.providerConfig, newStage!.providerConfig)) {
        changes.push({
          flowId: newFlow.id,
          flowName: newFlow.name,
          stageType,
          changeType: 'config-changed',
        });
      }
    }
  }

  return changes;
}
```

Uses `isDeepStrictEqual` from `node:util` (zero dependencies).

---

## 6. Router

Takes a `ChangeSet` and builds a `ReindexPlan` with concrete per-document/per-chunk actions.

### Decision Logic

```
ChangeSet
    |
    +-- routingChanged?
    |     YES: per-document flow re-derivation (FlowSelectionService)
    |       same flow -> skip
    |       different flow -> findEarliestDifferingStage -> checkpoint 2, 3, or 4
    |       identical stages across flows -> skip
    |
    +-- preChunkChanges? (routing NOT changed)
    |     docs WHERE flowId IN affectedFlowIds -> checkpoint 2
    |
    +-- postChunkChanges? (routing NOT changed, no pre-chunk overlap)
    |     chunks WHERE flowId IN enrichmentOnlyFlowIds -> checkpoint 3
    |
    +-- embeddingChanged?
          remaining chunks not covered above -> checkpoint 4
```

Earlier checkpoints subsume later ones:

- Checkpoint 2 (re-extract) automatically runs enrichment + embedding downstream
- Checkpoint 3 (re-enrich) automatically runs embedding downstream
- Only checkpoint 4 actions go to chunks NOT already covered

### Helpers

```typescript
const STAGE_ORDER: PipelineStageType[] = ['extraction', 'chunking', 'enrichment', 'embedding'];

function getDownstreamStages(startStage: PipelineStageType): PipelineStageType[] {
  const idx = STAGE_ORDER.indexOf(startStage);
  return idx === -1 ? [startStage, 'embedding'] : STAGE_ORDER.slice(idx);
}

function stageToCheckpoint(stageType: PipelineStageType): 1 | 2 | 3 | 4 {
  if (stageType === 'extraction' || stageType === 'chunking') return 2;
  if (stageType === 'enrichment') return 3;
  return 4;
}

function findEarliestDifferingStage(
  oldStages: IPipelineStage[],
  newStages: IPipelineStage[],
): PipelineStageType | null {
  for (const stageType of STAGE_ORDER) {
    const oldStage = oldStages.find((s) => s.type === stageType);
    const newStage = newStages.find((s) => s.type === stageType);
    if (!oldStage !== !newStage) return stageType;
    if (oldStage && newStage) {
      if (oldStage.provider !== newStage.provider) return stageType;
      if (!isDeepStrictEqual(oldStage.providerConfig, newStage.providerConfig)) return stageType;
    }
  }
  return null;
}

function buildFlowContext(doc: ISearchDocument): FlowContext {
  const ref = doc.originalReference || '';
  const ext = ref.includes('.') ? ref.split('.').pop()!.toLowerCase() : '';
  return {
    document: {
      extension: ext,
      mimeType: doc.contentType || '',
      size: doc.contentSizeBytes || 0,
      name: ref,
    },
    source: { connector: doc.connectorId || 'unknown' },
  };
}
```

---

## 7. Checkpoint Handlers

Each checkpoint implements the `CheckpointHandler` interface. Default implementations dispatch to existing BullMQ queues.

### Checkpoint 4: Re-embed

Reuses existing `embeddingQueue` and `embedding-worker`. No new worker needed.

```typescript
class EmbeddingCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 4 as const;

  constructor(private readonly embeddingQueue: Queue) {}

  estimate(actions: ReindexAction[]): ReindexEstimate {
    return {
      totalItems: actions.length,
      estimatedDurationMin: Math.ceil((actions.length * 2) / 60),
      estimatedCostUsd: parseFloat((actions.length * 0.00005).toFixed(2)),
    };
  }

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    // Batch into existing embedding queue -- reuses embedding-worker.ts
    for (let i = 0; i < actions.length; i += 100) {
      const batch = actions.slice(i, i + 100);
      await checkBackpressure(this.embeddingQueue, 'search-embedding');
      await this.embeddingQueue.addBulk(
        batch.map((action) => ({
          name: `reembed-${action.chunkId}`,
          data: {
            indexId: params.indexId,
            documentId: action.documentId || '',
            chunkIds: [action.chunkId!],
            tenantId: params.tenantId,
            pipelineId: params.pipelineId,
            knowledgeBaseId: params.knowledgeBaseId,
            mode: 'reindex',
            batchId: params.batchId,
          } satisfies EmbeddingJobData & { mode: string; batchId: string },
          opts: { ...FLOW_CHILD_DEFAULTS },
        })),
      );
    }
  }
}
```

### Checkpoint 2: Re-extract

Dispatches to existing pipeline flow builder (full document reprocessing).

```typescript
class PreChunkCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 2 as const;

  constructor(
    private readonly flowBuilder: PipelineFlowBuilder,
    private readonly flowProducer: FlowProducer,
  ) {}

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    const pipeline = await PipelineDefinition.findOne({
      _id: params.pipelineId,
      tenantId: params.tenantId,
    }).lean();
    if (!pipeline) throw new Error('Pipeline not found');

    for (const action of actions) {
      const doc = await SearchDocument.findOne({
        _id: action.documentId,
        tenantId: params.tenantId,
      }).lean();
      if (!doc) continue;

      const context = buildFlowContext(doc);

      // Reuse existing flow builder -- creates full BullMQ Flow
      const result = await this.flowBuilder.buildFlow(pipeline, {
        documentId: action.documentId!,
        tenantId: params.tenantId,
        sourceId: doc.sourceId,
        indexId: params.indexId,
        document: context.document,
        source: context.source,
      });

      if (result.success) {
        const parentQueue = new Queue(result.flow!.queueName, { connection: getRedisConnection() });
        await checkBackpressure(parentQueue, result.flow!.queueName);
        await safeAddFlow(this.flowProducer, result.flow!, parentQueue);
      }
    }
  }
}
```

### Checkpoint 3: Re-enrich

Dispatches to enrichment queue. Chunks already exist, just re-run enrichment + embedding.

```typescript
class PostChunkCheckpointHandler implements CheckpointHandler {
  readonly checkpoint = 3 as const;

  constructor(private readonly enrichmentQueue: Queue) {}

  async execute(actions: ReindexAction[], params: ReindexParams): Promise<void> {
    for (let i = 0; i < actions.length; i += 100) {
      const batch = actions.slice(i, i + 100);
      await checkBackpressure(this.enrichmentQueue, 'search-enrichment');
      await this.enrichmentQueue.addBulk(
        batch.map((action) => ({
          name: `reenrich-${action.chunkId}`,
          data: {
            chunkId: action.chunkId!,
            flowId: action.flowId,
            tenantId: params.tenantId,
            pipelineId: params.pipelineId,
            knowledgeBaseId: params.knowledgeBaseId,
            stages: action.stages,
            mode: 'reindex',
            batchId: params.batchId,
          },
          opts: { ...FLOW_CHILD_DEFAULTS },
        })),
      );
    }
  }
}
```

### Checkpoint 1: Routing

Not a separate handler -- routing evaluation happens in the Router (section 6). The Router produces checkpoint 2/3/4 actions based on stage diffs. Routing itself is analysis, not execution.

---

## 8. Orchestrator

Wires everything together. Single entry point for all reindex operations.

```typescript
class ReindexOrchestrator {
  constructor(
    private readonly changeStore: ChangeStore,
    private readonly handlers: Map<number, CheckpointHandler>,
  ) {}

  /**
   * Analyze pipeline changes and return impact summary.
   * Called by publish endpoint for confirmation dialog.
   */
  async analyze(
    tenantId: string,
    knowledgeBaseId: string,
    oldPipeline: IPipelineDefinition,
    newPipeline: IPipelineDefinition,
  ): Promise<{ changeSet: ChangeSet; plan: ReindexPlan }> {
    const changeSet = identifyChanges(oldPipeline, newPipeline);
    const plan = await buildReindexPlan(
      tenantId,
      knowledgeBaseId,
      oldPipeline,
      newPipeline,
      changeSet,
    );
    return { changeSet, plan };
  }

  /**
   * Persist change set and execute reindex plan.
   * Called after user confirms.
   */
  async execute(
    tenantId: string,
    knowledgeBaseId: string,
    changeSet: ChangeSet,
    plan: ReindexPlan,
    pipelineId: string,
  ): Promise<ReindexResult> {
    const batchId = `reindex-${knowledgeBaseId}-${Date.now()}`;
    const indexId = await resolveIndexId(knowledgeBaseId, tenantId);

    // Persist to change store (pluggable)
    const changeSetId = await this.changeStore.save(tenantId, {
      ...changeSet,
      changeSetId: batchId,
      tenantId,
      knowledgeBaseId,
      pipelineId,
      status: 'executing',
      plan,
      createdAt: new Date(),
    });

    const params: ReindexParams = { tenantId, knowledgeBaseId, pipelineId, indexId, batchId };

    // Group actions by checkpoint, dispatch to handlers
    const byCheckpoint = groupBy(plan.actions, (a) => a.checkpoint);

    for (const [checkpoint, actions] of Object.entries(byCheckpoint)) {
      const handler = this.handlers.get(Number(checkpoint));
      if (!handler) {
        logger.warn('No handler for checkpoint', { checkpoint });
        continue;
      }
      await handler.execute(actions, params);
    }

    // Publish start event via existing WebSocket infra
    await publishProgressEvent({
      type: 'job_started',
      jobId: batchId,
      timestamp: new Date().toISOString(),
      data: {
        progress: {
          total: plan.actions.length,
          completed: 0,
          failed: 0,
          percentage: 0,
        },
      },
    });

    return { batchId, totalItems: plan.actions.length, summary: plan.summary };
  }
}
```

### Factory (wiring)

```typescript
// apps/search-ai/src/services/reindexing/index.ts

export function createReindexOrchestrator(): ReindexOrchestrator {
  const changeStore = new MongoChangeStore(); // default implementation
  const handlers = new Map<number, CheckpointHandler>([
    [
      2,
      new PreChunkCheckpointHandler(
        new PipelineFlowBuilder(),
        new FlowProducer({ connection: getRedisConnection() }),
      ),
    ],
    [3, new PostChunkCheckpointHandler(enrichmentQueue)],
    [4, new EmbeddingCheckpointHandler(embeddingQueue)],
  ]);
  return new ReindexOrchestrator(changeStore, handlers);
}
```

---

## 9. All Touchpoints

### Backend: Schema Changes

| File                                                        | Change                                          | Why                       |
| ----------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `packages/database/src/models/pipeline-definition.model.ts` | Add `previousVersion?: Record<string, unknown>` | Snapshot for diffing      |
| `packages/database/src/models/search-chunk.model.ts`        | Add `flowId: string \| null` + sparse index     | Checkpoint 3 direct query |
| `packages/database/src/models/search-document.model.ts`     | Add `flowId: string \| null` + sparse index     | Checkpoint 2 direct query |
| `packages/database/src/interfaces/` (if separate)           | Export new field types                          | Type safety               |

### Backend: Routes (modify existing)

| File                                             | Change                                              | Why                      |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------ |
| `apps/search-ai/src/routes/pipelines.ts:236-320` | Publish endpoint: snapshot + analyze + confirm flow | Checkpoint 1/2/3 trigger |
| `apps/search-ai/src/routes/pipelines.ts:752`     | Embedding endpoint: replace TODO with execute       | Checkpoint 4 trigger     |
| `apps/search-ai/src/routes/indexes.ts:505`       | Rebuild endpoint: wire to orchestrator              | Full rebuild trigger     |

### Backend: Routes (new)

| File                                      | Endpoint                              | Why                          |
| ----------------------------------------- | ------------------------------------- | ---------------------------- |
| `apps/search-ai/src/routes/reindexing.ts` | `GET .../reindexing/:batchId`         | Progress polling             |
| `apps/search-ai/src/routes/reindexing.ts` | `GET .../reindexing/history`          | List past reindex operations |
| `apps/search-ai/src/routes/reindexing.ts` | `POST .../reindexing/:batchId/cancel` | Cancel in-progress reindex   |

### Backend: Services (new)

| File                                                            | What                                          |
| --------------------------------------------------------------- | --------------------------------------------- |
| `apps/search-ai/src/services/reindexing/types.ts`               | All interfaces (ChangeSet, ReindexPlan, etc.) |
| `apps/search-ai/src/services/reindexing/change-identifier.ts`   | `identifyChanges()` pure diff                 |
| `apps/search-ai/src/services/reindexing/router.ts`              | `buildReindexPlan()`                          |
| `apps/search-ai/src/services/reindexing/helpers.ts`             | Stage ordering, buildFlowContext              |
| `apps/search-ai/src/services/reindexing/orchestrator.ts`        | `ReindexOrchestrator`                         |
| `apps/search-ai/src/services/reindexing/handlers/embedding.ts`  | Checkpoint 4 handler                          |
| `apps/search-ai/src/services/reindexing/handlers/pre-chunk.ts`  | Checkpoint 2 handler                          |
| `apps/search-ai/src/services/reindexing/handlers/post-chunk.ts` | Checkpoint 3 handler                          |
| `apps/search-ai/src/services/reindexing/stores/mongo.ts`        | Default MongoDB ChangeStore                   |
| `apps/search-ai/src/services/reindexing/index.ts`               | Factory + re-exports                          |

### Backend: Workers (modify existing)

| File                                             | Change                                 | Why                       |
| ------------------------------------------------ | -------------------------------------- | ------------------------- |
| `apps/search-ai/src/workers/embedding-worker.ts` | Handle `mode: 'reindex'` in job data   | Checkpoint 4 execution    |
| `apps/search-ai/src/workers/index.ts`            | No new worker needed                   | Reuses existing workers   |
| Various ingestion workers                        | Set `flowId` when creating docs/chunks | Populate provenance field |

### Frontend: Components (modify existing)

| File                                                                       | Change                                         | Why                       |
| -------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------- |
| `apps/studio/src/components/search-ai/pipelines/ChangeEmbeddingDialog.tsx` | Show reindex cost estimate, add progress state | Checkpoint 4 confirmation |

### Frontend: Components (new)

| File                                                                      | What                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/studio/src/components/search-ai/pipelines/PublishConfirmDialog.tsx` | Shows pipeline diff + reindex impact + confirm/skip   |
| `apps/studio/src/components/search-ai/pipelines/ReindexProgress.tsx`      | Progress card (adapted from CrawlJobProgress pattern) |

### Frontend: Store + API (modify existing)

| File                                      | Change                                                                      | Why              |
| ----------------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| `apps/studio/src/store/pipeline-store.ts` | Add `reindexBatchId`, `reindexProgress`, publish confirmation flow          | State management |
| `apps/studio/src/api/pipelines.ts`        | Extend publish response type, add `getReindexProgress()`, `cancelReindex()` | API layer        |

### Tests

| File                                                                                     | What                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------- |
| `apps/search-ai/src/services/reindexing/__tests__/change-identifier.test.ts`             | Pure function tests (no mocks needed) |
| `apps/search-ai/src/services/reindexing/__tests__/router.test.ts`                        | Mocked DB queries, plan building      |
| `apps/search-ai/src/services/reindexing/__tests__/orchestrator.test.ts`                  | Mocked handlers, end-to-end flow      |
| `apps/search-ai/src/services/reindexing/__tests__/handlers.test.ts`                      | Each checkpoint handler               |
| `apps/search-ai/src/routes/__tests__/pipelines-publish-reindex.test.ts`                  | Integration: publish with reindex     |
| `apps/studio/src/components/search-ai/pipelines/__tests__/PublishConfirmDialog.test.tsx` | UI component test                     |

---

## 10. What Does NOT Trigger Reindexing

| Change                                              | Reason                               |
| --------------------------------------------------- | ------------------------------------ |
| Flow name/description changed                       | Metadata only                        |
| Stage description/onError changed                   | Metadata/policy, not data processing |
| Routing changed but all flows have identical stages | Processing identical                 |
| First publish (no previous version)                 | No existing chunks                   |
| New flow added                                      | No existing documents assigned       |

---

## 11. File Structure

```
apps/search-ai/src/services/reindexing/
  types.ts                           # All interfaces
  change-identifier.ts               # identifyChanges() -- pure diff
  router.ts                          # buildReindexPlan() -- DB queries
  helpers.ts                         # Stage ordering, buildFlowContext
  orchestrator.ts                    # ReindexOrchestrator -- wires everything
  handlers/
    embedding.ts                     # Checkpoint 4: reuse embeddingQueue
    pre-chunk.ts                     # Checkpoint 2: reuse FlowBuilder
    post-chunk.ts                    # Checkpoint 3: enrichmentQueue dispatch
  stores/
    types.ts                         # ChangeStore interface
    mongo.ts                         # Default: MongoDB-backed store
  index.ts                           # createReindexOrchestrator() factory
  __tests__/
    change-identifier.test.ts
    router.test.ts
    orchestrator.test.ts
    handlers.test.ts

apps/search-ai/src/routes/
  reindexing.ts                      # GET progress, GET history, POST cancel

apps/studio/src/components/search-ai/pipelines/
  PublishConfirmDialog.tsx            # Pipeline diff + impact + confirm
  ReindexProgress.tsx                # Progress card (CrawlJobProgress pattern)
```

---

## 12. Prerequisites Summary

| #   | What                                    | File                                                        | Why                        | Effort |
| --- | --------------------------------------- | ----------------------------------------------------------- | -------------------------- | ------ |
| P1  | `previousVersion` on PipelineDefinition | `packages/database/src/models/pipeline-definition.model.ts` | Diff needs old pipeline    | 30 min |
| P2  | `flowId` on SearchChunk + index         | `packages/database/src/models/search-chunk.model.ts`        | Checkpoint 3 direct query  | 30 min |
| P3  | `flowId` on SearchDocument + index      | `packages/database/src/models/search-document.model.ts`     | Checkpoint 2 direct query  | 30 min |
| P4  | Set flowId during ingestion             | Various workers                                             | Populate provenance fields | 1 hr   |

---

## 13. Implementation Order

| Phase                 | Tasks                                               | Effort | Parallel?                         |
| --------------------- | --------------------------------------------------- | ------ | --------------------------------- |
| 1. Prerequisites      | P1 + P2 + P3 schema changes                         | 1.5 hr | yes (all 3)                       |
| 2. Core types         | types.ts + helpers.ts                               | 1 hr   | after phase 1                     |
| 3. Pure logic         | change-identifier.ts + tests                        | 2 hr   | after phase 2                     |
| 4. Router             | router.ts + tests                                   | 3 hr   | after phase 3                     |
| 5. Handlers           | embedding + pre-chunk + post-chunk handlers + tests | 3 hr   | after phase 2 (parallel with 3/4) |
| 6. Store              | stores/mongo.ts                                     | 1 hr   | after phase 2                     |
| 7. Orchestrator       | orchestrator.ts + tests                             | 2 hr   | after phase 4 + 5 + 6             |
| 8. Backend wiring     | Publish endpoint + embedding endpoint + routes      | 2 hr   | after phase 7                     |
| 9. Ingestion wiring   | P4: flowId in workers                               | 1 hr   | after phase 1 (parallel with 2-7) |
| 10. Frontend          | PublishConfirmDialog + ReindexProgress + store/API  | 3 hr   | after phase 8                     |
| 11. Integration tests | End-to-end publish + reindex                        | 2 hr   | after phase 10                    |

**Total: ~21.5 hours**

---

## 14. Approval Checklist

- [ ] 4 checkpoints cover all pipeline change types
- [ ] ChangeActionIdentifier is a pure function (no DB queries)
- [ ] Router resolves overlapping changes to earliest checkpoint per item
- [ ] Pluggable: ChangeStore interface for custom storage
- [ ] Pluggable: CheckpointHandler interface for custom execution
- [ ] Pluggable: ReindexTrigger interface for custom triggers
- [ ] Reuses existing queue factory, worker registry, FlowBuilder, safeAddFlow
- [ ] Reuses existing progress WebSocket (publishProgressEvent)
- [ ] Reuses existing embedding worker for checkpoint 4
- [ ] No duplicate JobExecution model -- uses existing with mode field
- [ ] flowId on SearchChunk enables direct chunk queries (checkpoint 3)
- [ ] flowId on SearchDocument enables direct doc queries (checkpoint 2)
- [ ] Pipeline snapshot (previousVersion) enables accurate diffing
- [ ] All queries scoped to tenantId
- [ ] backpressure checks before all queue dispatches
- [ ] User confirmation before reprocessing (no silent cost)
- [ ] All touchpoints documented (schema, routes, workers, UI, tests)
- [ ] Each component independently testable
