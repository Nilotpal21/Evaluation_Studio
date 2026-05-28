/**
 * Change Action Identifier
 *
 * Pure function that compares old pipeline vs new pipeline and produces a ChangeSet.
 * No database queries -- just two JavaScript objects compared.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md section 5
 */

import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
  SearchPipelineStageType,
} from '@agent-platform/database';
import { deepEqual } from './helpers.js';
import type { ChangeSet, FlowStageChange } from './types.js';

/**
 * Compare old pipeline vs new pipeline and classify what changed.
 *
 * Returns a ChangeSet describing:
 * - embeddingChanged: activeEmbeddingConfig differs
 * - routingChanged: any flow's selectionRules/priority/enabled changed
 * - preChunkChanges: extraction/chunking stage changes per flow
 * - postChunkChanges: enrichment stage changes per flow
 */
export function identifyChanges(
  oldPipeline: ISearchPipelineDefinition,
  newPipeline: ISearchPipelineDefinition,
): ChangeSet {
  return {
    embeddingChanged: !deepEqual(
      oldPipeline.activeEmbeddingConfig,
      newPipeline.activeEmbeddingConfig,
    ),
    routingChanged: hasRoutingChanged(oldPipeline.flows, newPipeline.flows),
    preChunkChanges: findStageChanges(oldPipeline.flows, newPipeline.flows, [
      'extraction',
      'chunking',
    ]),
    postChunkChanges: findStageChanges(oldPipeline.flows, newPipeline.flows, [
      'enrichment',
      'multimodal',
    ]),
  };
}

/**
 * Check if routing has changed between old and new flows.
 *
 * Routing = selectionRules + priority + enabled + flow existence.
 * Changes to name/description are NOT routing changes.
 */
export function hasRoutingChanged(
  oldFlows: ISearchPipelineFlow[],
  newFlows: ISearchPipelineFlow[],
): boolean {
  if (oldFlows.length !== newFlows.length) return true;

  for (const newFlow of newFlows) {
    const oldFlow = oldFlows.find((f) => f.id === newFlow.id);
    if (!oldFlow) return true;
    if (oldFlow.enabled !== newFlow.enabled) return true;
    if (oldFlow.priority !== newFlow.priority) return true;
    if (!deepEqual(oldFlow.selectionRules ?? [], newFlow.selectionRules ?? [])) return true;
  }

  // Check for removed flows
  for (const oldFlow of oldFlows) {
    if (!newFlows.some((f) => f.id === oldFlow.id) && oldFlow.enabled) return true;
  }

  return false;
}

/**
 * Find stage changes across flows for the given stage types.
 *
 * Only compares flows that exist in BOTH old and new pipeline.
 * New flows have no existing documents, so no reindexing needed.
 */
export function findStageChanges(
  oldFlows: ISearchPipelineFlow[],
  newFlows: ISearchPipelineFlow[],
  stageTypes: SearchPipelineStageType[],
): FlowStageChange[] {
  const changes: FlowStageChange[] = [];

  for (const newFlow of newFlows) {
    const oldFlow = oldFlows.find((f) => f.id === newFlow.id);
    if (!oldFlow) continue;

    for (const stageType of stageTypes) {
      const change = compareStage(newFlow, stageType, oldFlow.stages, newFlow.stages);
      if (change) changes.push(change);
    }
  }

  return changes;
}

/**
 * Compare a single stage type between old and new stage arrays.
 */
function compareStage(
  flow: ISearchPipelineFlow,
  stageType: SearchPipelineStageType,
  oldStages: ISearchPipelineStage[],
  newStages: ISearchPipelineStage[],
): FlowStageChange | null {
  const oldStage = oldStages.find((s) => s.type === stageType);
  const newStage = newStages.find((s) => s.type === stageType);

  if (!oldStage && !newStage) return null;

  if (!oldStage && newStage) {
    return { flowId: flow.id, flowName: flow.name, stageType, changeType: 'added' };
  }

  if (oldStage && !newStage) {
    return { flowId: flow.id, flowName: flow.name, stageType, changeType: 'removed' };
  }

  if (oldStage!.provider !== newStage!.provider) {
    return { flowId: flow.id, flowName: flow.name, stageType, changeType: 'provider-changed' };
  }

  if (!deepEqual(oldStage!.providerConfig, newStage!.providerConfig)) {
    return { flowId: flow.id, flowName: flow.name, stageType, changeType: 'config-changed' };
  }

  return null;
}
