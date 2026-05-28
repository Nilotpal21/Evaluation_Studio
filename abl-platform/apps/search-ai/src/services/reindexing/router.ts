/**
 * Reindex Router
 *
 * Takes a ChangeSet and builds a ReindexPlan with concrete per-document/per-chunk actions.
 *
 * Decision logic:
 * 1. routingChanged -> per-document flow re-derivation (FlowSelectionService)
 * 2. preChunkChanges (no routing change) -> docs by flowId -> checkpoint 2
 * 3. postChunkChanges (no routing change, no pre-chunk overlap) -> chunks by flowId -> checkpoint 3
 * 4. embeddingChanged -> remaining chunks -> checkpoint 4
 *
 * Earlier checkpoints subsume later ones for the same document/chunk.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 6
 */

import { createLogger } from '@abl/compiler/platform';
import type {
  ISearchPipelineDefinition,
  ISearchDocument,
  ISearchChunk,
} from '@agent-platform/database';
import { getLazyModel } from '../../db/index.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
import { FlowSelectionService } from '../flow-selection/flow-selection.service.js';
import {
  buildFlowContext,
  findEarliestDifferingStage,
  getDownstreamStages,
  stageToCheckpoint,
  buildSummary,
} from './helpers.js';
import type { ChangeSet, ReindexAction, ReindexPlan } from './types.js';

const logger = createLogger('reindex-router');

/**
 * Build a ReindexPlan from a ChangeSet.
 *
 * Queries the database to determine which documents/chunks are affected
 * and maps each to the appropriate checkpoint.
 */
export async function buildReindexPlan(
  tenantId: string,
  indexId: string,
  oldPipeline: ISearchPipelineDefinition,
  newPipeline: ISearchPipelineDefinition,
  changeSet: ChangeSet,
): Promise<ReindexPlan> {
  const actions: ReindexAction[] = [];
  const coveredDocuments = new Set<string>();
  const coveredChunks = new Set<string>();

  // --- Checkpoint 1: Routing changes ---
  if (changeSet.routingChanged) {
    const routingActions = await resolveRoutingChanges(tenantId, indexId, oldPipeline, newPipeline);
    for (const action of routingActions) {
      actions.push(action);
      if (action.documentId) coveredDocuments.add(action.documentId);
    }
  }

  // --- Checkpoint 2: Pre-chunk changes ---
  // coveredDocuments set deduplicates against routing-resolved documents
  if (changeSet.preChunkChanges.length > 0) {
    const affectedFlowIds = [...new Set(changeSet.preChunkChanges.map((c) => c.flowId))];
    const preChunkActions = await resolvePreChunkChanges(
      tenantId,
      indexId,
      affectedFlowIds,
      coveredDocuments,
    );
    for (const action of preChunkActions) {
      actions.push(action);
      if (action.documentId) coveredDocuments.add(action.documentId);
    }
  }

  // --- Checkpoint 3: Post-chunk changes (skip flows already covered by pre-chunk) ---
  if (changeSet.postChunkChanges.length > 0) {
    const preChunkFlowIds = new Set(changeSet.preChunkChanges.map((c) => c.flowId));
    const enrichmentOnlyFlowIds = [
      ...new Set(changeSet.postChunkChanges.map((c) => c.flowId)),
    ].filter((id) => !preChunkFlowIds.has(id));

    if (enrichmentOnlyFlowIds.length > 0) {
      const postChunkActions = await resolvePostChunkChanges(
        tenantId,
        indexId,
        enrichmentOnlyFlowIds,
        coveredChunks,
      );
      for (const action of postChunkActions) {
        actions.push(action);
        if (action.chunkId) coveredChunks.add(action.chunkId);
      }
    }
  }

  // --- Checkpoint 4: Embedding changes ---
  if (changeSet.embeddingChanged) {
    const embeddingActions = await resolveEmbeddingChanges(
      tenantId,
      indexId,
      coveredDocuments,
      coveredChunks,
    );
    for (const action of embeddingActions) {
      actions.push(action);
    }
  }

  const plan: ReindexPlan = {
    actions,
    summary: buildSummary(actions),
  };

  logger.info('Reindex plan built', {
    tenantId,
    totalActions: actions.length,
    summary: plan.summary,
  });

  return plan;
}

// ─── Resolvers ───────────────────────────────────────────────────────────

async function resolveRoutingChanges(
  tenantId: string,
  indexId: string,
  oldPipeline: ISearchPipelineDefinition,
  newPipeline: ISearchPipelineDefinition,
): Promise<ReindexAction[]> {
  const flowSelection = new FlowSelectionService();
  const actions: ReindexAction[] = [];
  let totalDocuments = 0;

  const cursor = SearchDocument.find({ tenantId, indexId })
    .select('_id originalReference contentType contentSizeBytes connectorId')
    .lean()
    .cursor();

  for await (const doc of cursor) {
    totalDocuments++;
    const context = buildFlowContext(doc);

    const oldResult = await flowSelection.selectFlow(oldPipeline.flows, context);
    const newResult = await flowSelection.selectFlow(newPipeline.flows, context);

    if (!oldResult.flow || !newResult.flow) continue;

    // Same flow -> routing didn't affect this document
    if (oldResult.flow.id === newResult.flow.id) continue;

    // Different flow -> find earliest differing stage
    const startStage = findEarliestDifferingStage(oldResult.flow.stages, newResult.flow.stages);

    // Identical stages across flows -> no impact
    if (!startStage) continue;

    const checkpoint = stageToCheckpoint(startStage);
    const stages = getDownstreamStages(startStage);

    actions.push({
      documentId: doc._id,
      flowId: newResult.flow.id,
      checkpoint,
      stages,
    });
  }

  logger.info('Routing changes resolved', {
    totalDocuments,
    affectedDocuments: actions.length,
  });

  return actions;
}

async function resolvePreChunkChanges(
  tenantId: string,
  indexId: string,
  affectedFlowIds: string[],
  coveredDocuments: Set<string>,
): Promise<ReindexAction[]> {
  const actions: ReindexAction[] = [];

  for (const flowId of affectedFlowIds) {
    const cursor = SearchDocument.find({ tenantId, indexId, flowId }).select('_id').lean().cursor();

    for await (const doc of cursor) {
      if (coveredDocuments.has(doc._id)) continue;

      actions.push({
        documentId: doc._id,
        flowId,
        checkpoint: 2,
        stages: getDownstreamStages('extraction'),
      });
    }
  }

  logger.info('Pre-chunk changes resolved', {
    affectedFlowIds,
    affectedDocuments: actions.length,
  });

  return actions;
}

async function resolvePostChunkChanges(
  tenantId: string,
  indexId: string,
  affectedFlowIds: string[],
  coveredChunks: Set<string>,
): Promise<ReindexAction[]> {
  const actions: ReindexAction[] = [];

  for (const flowId of affectedFlowIds) {
    const cursor = SearchChunk.find({ tenantId, indexId, flowId }).select('_id').lean().cursor();

    for await (const chunk of cursor) {
      if (coveredChunks.has(chunk._id)) continue;

      actions.push({
        chunkId: chunk._id,
        flowId,
        checkpoint: 3,
        stages: getDownstreamStages('enrichment'),
      });
    }
  }

  logger.info('Post-chunk changes resolved', {
    affectedFlowIds,
    affectedChunks: actions.length,
  });

  return actions;
}

async function resolveEmbeddingChanges(
  tenantId: string,
  indexId: string,
  coveredDocuments: Set<string>,
  coveredChunks: Set<string>,
): Promise<ReindexAction[]> {
  const actions: ReindexAction[] = [];
  let totalChunks = 0;

  const cursor = SearchChunk.find({ tenantId, indexId }).select('_id documentId').lean().cursor();

  for await (const chunk of cursor) {
    totalChunks++;
    // Skip chunks already covered by earlier checkpoints
    if (coveredChunks.has(chunk._id)) continue;
    if (coveredDocuments.has(chunk.documentId)) continue;

    actions.push({
      chunkId: chunk._id,
      documentId: chunk.documentId,
      flowId: '',
      checkpoint: 4,
      stages: ['embedding'],
    });
  }

  logger.info('Embedding changes resolved', {
    totalChunks,
    affectedChunks: actions.length,
    skippedByCoverage: totalChunks - actions.length,
  });

  return actions;
}
