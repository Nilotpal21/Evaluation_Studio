/**
 * Reindexing Helpers
 *
 * Stage ordering, context mapping, and comparison utilities.
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  ISearchPipelineStage,
  SearchPipelineStageType,
  ISearchDocument,
} from '@agent-platform/database';
import type { FlowContext } from '../flow-selection/types.js';
import type { ReindexAction, ReindexSummary } from './types.js';

// ─── Stage Ordering ──────────────────────────────────────────────────────

export const STAGE_ORDER: SearchPipelineStageType[] = [
  'extraction',
  'chunking',
  'enrichment',
  'multimodal',
  'embedding',
];

/**
 * Get all stages that must run starting from a given stage (inclusive).
 * Extraction -> extraction, chunking, enrichment, embedding
 * Enrichment -> enrichment, embedding
 */
export function getDownstreamStages(
  startStage: SearchPipelineStageType,
): SearchPipelineStageType[] {
  const idx = STAGE_ORDER.indexOf(startStage);
  if (idx === -1) return [startStage, 'embedding'];
  return STAGE_ORDER.slice(idx);
}

/**
 * Map a stage type to its checkpoint number.
 * extraction/chunking -> 2 (pre-chunk), enrichment/multimodal -> 3 (post-chunk), embedding -> 4
 */
export function stageToCheckpoint(stageType: SearchPipelineStageType): 1 | 2 | 3 | 4 {
  if (stageType === 'extraction' || stageType === 'chunking') return 2;
  if (stageType === 'enrichment' || stageType === 'multimodal') return 3;
  return 4;
}

/**
 * Find the earliest stage that differs between two flows' stage arrays.
 * Returns null if all stages are identical (no reprocessing needed).
 */
export function findEarliestDifferingStage(
  oldStages: ISearchPipelineStage[],
  newStages: ISearchPipelineStage[],
): SearchPipelineStageType | null {
  for (const stageType of STAGE_ORDER) {
    const oldStage = oldStages.find((s) => s.type === stageType);
    const newStage = newStages.find((s) => s.type === stageType);

    // Stage exists in one but not other
    if (!oldStage !== !newStage) return stageType;

    // Both exist: compare provider and config
    if (oldStage && newStage) {
      if (oldStage.provider !== newStage.provider) return stageType;
      if (!deepEqual(oldStage.providerConfig, newStage.providerConfig)) return stageType;
    }
  }

  return null;
}

// ─── Context Mapping ─────────────────────────────────────────────────────

/**
 * Build a FlowContext from a SearchDocument.
 * Maps SearchDocument field names to FlowContext field names.
 */
export function buildFlowContext(doc: ISearchDocument): FlowContext {
  const ref = doc.originalReference || '';
  const ext = ref.includes('.') ? ref.split('.').pop()!.toLowerCase() : '';

  return {
    document: {
      extension: ext,
      mimeType: doc.contentType || '',
      size: doc.contentSizeBytes || 0,
      name: ref,
    },
    source: {
      connector: doc.connectorId || 'unknown',
    },
  };
}

// ─── Comparison ──────────────────────────────────────────────────────────

/**
 * Deep equality comparison for objects.
 * Uses Node.js built-in isDeepStrictEqual (zero dependencies).
 */
export const deepEqual: (a: unknown, b: unknown) => boolean = isDeepStrictEqual;

// ─── Summary ─────────────────────────────────────────────────────────────

/** Cost estimates per checkpoint (rough defaults, tunable) */
const COST_PER_ITEM: Record<number, number> = {
  2: 0.005, // extraction: document processing
  3: 0.002, // enrichment: LLM call
  4: 0.00005, // embedding: vector generation
};

/** Duration estimates per item in seconds */
const DURATION_PER_ITEM_S: Record<number, number> = {
  2: 30, // extraction
  3: 10, // enrichment
  4: 2, // embedding
};

export function buildSummary(actions: ReindexAction[]): ReindexSummary {
  const checkpoint1Count = actions.filter((a) => a.checkpoint === 1).length;
  const checkpoint2Count = actions.filter((a) => a.checkpoint === 2).length;
  const checkpoint3Count = actions.filter((a) => a.checkpoint === 3).length;
  const checkpoint4Count = actions.filter((a) => a.checkpoint === 4).length;

  let estimatedCostUsd = 0;
  let estimatedDurationS = 0;

  for (const action of actions) {
    estimatedCostUsd += COST_PER_ITEM[action.checkpoint] ?? 0;
    estimatedDurationS += DURATION_PER_ITEM_S[action.checkpoint] ?? 0;
  }

  return {
    checkpoint1Count,
    checkpoint2Count,
    checkpoint3Count,
    checkpoint4Count,
    totalDocuments: checkpoint1Count + checkpoint2Count,
    totalChunks: checkpoint3Count + checkpoint4Count,
    estimatedCostUsd: parseFloat(estimatedCostUsd.toFixed(2)),
    estimatedDurationMin: Math.ceil(estimatedDurationS / 60),
  };
}
