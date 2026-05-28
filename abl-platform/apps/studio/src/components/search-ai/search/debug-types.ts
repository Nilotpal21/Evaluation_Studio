/**
 * Debug trace types for pipeline resolution chain visualization.
 *
 * Matches the PipelineDebugTrace shape returned by search-ai-runtime
 * when `debug=true` is passed to executeQuery.
 */

export interface PipelineStageTrace {
  applied: boolean;
  durationMs: number;
  input?: unknown;
  output?: unknown;
}

export interface PipelineDebugTrace {
  stages: {
    permissionFilter?: PipelineStageTrace & { filterCount?: number };
    preprocessing?: PipelineStageTrace & {
      corrections?: string[];
      entities?: unknown[];
    };
    vocabularyResolution?: PipelineStageTrace & {
      resolvedTerms?: Array<{
        original: string;
        resolved: string;
        type: string;
      }>;
      unresolvedSegments?: string[];
      classifiedQueryType?: string;
      classificationConfidence?: number;
    };
    aliasResolution?: PipelineStageTrace & {
      mappings?: Record<string, string>;
    };
    searchExecution?: PipelineStageTrace & {
      queryType: string;
      rawResultCount?: number;
    };
    rerank?: PipelineStageTrace & {
      modelUsed?: string;
      resultCountBefore?: number;
      resultCountAfter?: number;
    };
    metrics?: PipelineStageTrace & {
      durationMs: number;
      costEstimate?: number;
    };
  };
  totalDurationMs: number;
}

export const STAGE_KEYS = [
  'permissionFilter',
  'preprocessing',
  'vocabularyResolution',
  'aliasResolution',
  'searchExecution',
  'rerank',
  'metrics',
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_I18N_MAP: Record<StageKey, string> = {
  permissionFilter: 'stage_permission',
  preprocessing: 'stage_preprocessing',
  vocabularyResolution: 'stage_vocabulary',
  aliasResolution: 'stage_alias',
  searchExecution: 'stage_search',
  rerank: 'stage_rerank',
  metrics: 'stage_metrics',
};
