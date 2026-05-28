/**
 * Reindex Orchestrator
 *
 * Coordinates the full reindex lifecycle:
 *   1. analyze()  — identify changes + build reindex plan
 *   2. execute()  — persist change set + dispatch to checkpoint handlers
 *
 * Pluggable via ChangeStore and CheckpointHandler interfaces.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 8
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ISearchPipelineDefinition } from '@agent-platform/database';
import { identifyChanges } from './change-identifier.js';
import { buildReindexPlan } from './router.js';
import { BackpressureError } from '../pipeline-orchestration/types.js';
import type {
  ChangeSet,
  ChangeStore,
  CheckpointHandler,
  PersistedChangeSet,
  ReindexAction,
  ReindexParams,
  ReindexPlan,
  ReindexResult,
} from './types.js';

const logger = createLogger('reindex-orchestrator');

export interface AnalyzeResult {
  changeSet: ChangeSet;
  plan: ReindexPlan;
  hasChanges: boolean;
}

export class ReindexOrchestrator {
  private readonly handlers: Map<number, CheckpointHandler>;

  constructor(
    private readonly store: ChangeStore,
    handlers: CheckpointHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.checkpoint, h]));
  }

  /**
   * Analyze pipeline changes and build a reindex plan.
   * Pure analysis — no side effects, no persistence.
   */
  async analyze(
    tenantId: string,
    indexId: string,
    oldPipeline: ISearchPipelineDefinition,
    newPipeline: ISearchPipelineDefinition,
  ): Promise<AnalyzeResult> {
    const changeSet = identifyChanges(oldPipeline, newPipeline);

    const hasChanges =
      changeSet.embeddingChanged ||
      changeSet.routingChanged ||
      changeSet.preChunkChanges.length > 0 ||
      changeSet.postChunkChanges.length > 0;

    if (!hasChanges) {
      return {
        changeSet,
        plan: { actions: [], summary: buildEmptySummary() },
        hasChanges: false,
      };
    }

    const plan = await buildReindexPlan(tenantId, indexId, oldPipeline, newPipeline, changeSet);

    logger.info('Reindex analysis complete', {
      tenantId,
      indexId,
      hasChanges,
      totalActions: plan.actions.length,
      summary: plan.summary,
    });

    return { changeSet, plan, hasChanges };
  }

  /**
   * Execute a reindex plan: persist the change set, then dispatch actions
   * to the appropriate checkpoint handlers.
   */
  async execute(
    tenantId: string,
    knowledgeBaseId: string,
    pipelineId: string,
    indexId: string,
    analyzeResult: AnalyzeResult,
    pipelineVersion: number,
    previousPipelineVersion: number,
  ): Promise<ReindexResult> {
    const batchId = randomUUID();
    const { changeSet, plan } = analyzeResult;

    // Persist change set
    const persisted: PersistedChangeSet = {
      changeSetId: batchId,
      tenantId,
      knowledgeBaseId,
      pipelineId,
      previousPipelineVersion,
      newPipelineVersion: pipelineVersion,
      status: 'executing',
      embeddingChanged: changeSet.embeddingChanged,
      routingChanged: changeSet.routingChanged,
      preChunkChanges: changeSet.preChunkChanges,
      postChunkChanges: changeSet.postChunkChanges,
      plan,
      createdAt: new Date(),
    };

    await this.store.save(tenantId, persisted);

    logger.info('Reindex execution started', {
      batchId,
      tenantId,
      pipelineId,
      totalActions: plan.actions.length,
    });

    const params: ReindexParams = {
      tenantId,
      knowledgeBaseId,
      pipelineId,
      indexId,
      batchId,
    };

    // Group actions by checkpoint and dispatch
    const actionsByCheckpoint = groupByCheckpoint(plan.actions);
    let hasFailures = false;

    for (const [checkpoint, actions] of actionsByCheckpoint) {
      const handler = this.handlers.get(checkpoint);
      if (!handler) {
        logger.warn('No handler for checkpoint, skipping', {
          checkpoint,
          actionCount: actions.length,
          batchId,
        });
        continue;
      }

      try {
        await this.executeWithBackpressureRetry(handler, actions, params, batchId);
        logger.info('Checkpoint dispatched', {
          checkpoint,
          actionCount: actions.length,
          batchId,
        });
      } catch (error) {
        hasFailures = true;
        logger.error('Checkpoint execution failed, aborting remaining checkpoints', {
          checkpoint,
          batchId,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    if (!hasFailures) {
      await this.store.markProcessed(tenantId, batchId);
    } else {
      logger.warn('Reindex completed with failures, not marking as processed', { batchId });
    }

    logger.info('Reindex execution completed', {
      batchId,
      tenantId,
      totalActions: plan.actions.length,
    });

    return {
      batchId,
      totalItems: plan.actions.length,
      summary: plan.summary,
    };
  }
  private async executeWithBackpressureRetry(
    handler: CheckpointHandler,
    actions: ReindexAction[],
    params: ReindexParams,
    batchId: string,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await handler.execute(actions, params);
        return;
      } catch (error) {
        if (error instanceof BackpressureError && attempt < maxRetries) {
          const delay = error.retryAfterMs * Math.pow(2, attempt);
          logger.warn('Backpressure detected, retrying', {
            checkpoint: handler.checkpoint,
            attempt: attempt + 1,
            maxRetries,
            retryAfterMs: delay,
            queueName: error.queueName,
            batchId,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────

export { createReindexOrchestrator } from './factory.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function groupByCheckpoint(actions: ReindexAction[]): Map<number, ReindexAction[]> {
  const map = new Map<number, ReindexAction[]>();
  for (const action of actions) {
    const existing = map.get(action.checkpoint);
    if (existing) {
      existing.push(action);
    } else {
      map.set(action.checkpoint, [action]);
    }
  }
  return map;
}

function buildEmptySummary() {
  return {
    checkpoint1Count: 0,
    checkpoint2Count: 0,
    checkpoint3Count: 0,
    checkpoint4Count: 0,
    totalDocuments: 0,
    totalChunks: 0,
    estimatedCostUsd: 0,
    estimatedDurationMin: 0,
  };
}
