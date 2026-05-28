/**
 * Pipeline Stage Mapping
 *
 * Maps backend document statuses to simplified user-facing pipeline stages.
 * Used by PipelineProgressTracker, MiniPipelineIndicator, and PipelineStatusTooltip.
 */

export type PipelineStage = 'uploaded' | 'extracting' | 'enriching' | 'embedding' | 'searchable';

export type PipelineStageOrFailed = PipelineStage | 'failed';

export const STATUS_TO_STAGE: Record<string, PipelineStageOrFailed> = {
  pending: 'uploaded',
  extracting: 'extracting',
  extracted: 'extracting',
  enriching: 'enriching',
  enriched: 'enriching',
  embedding: 'embedding',
  indexed: 'searchable',
  error: 'failed',
  failed: 'failed',
  processing: 'extracting',
  pending_field_selection: 'extracting',
};

export const STAGE_ORDER: readonly PipelineStage[] = [
  'uploaded',
  'extracting',
  'enriching',
  'embedding',
  'searchable',
];

export const STAGE_META: Record<
  PipelineStageOrFailed,
  { labelKey: string; descriptionKey: string; stepNumber: number }
> = {
  uploaded: { labelKey: 'stage_uploaded', descriptionKey: 'stage_uploaded_desc', stepNumber: 1 },
  extracting: {
    labelKey: 'stage_extracting',
    descriptionKey: 'stage_extracting_desc',
    stepNumber: 2,
  },
  enriching: { labelKey: 'stage_enriching', descriptionKey: 'stage_enriching_desc', stepNumber: 3 },
  embedding: { labelKey: 'stage_embedding', descriptionKey: 'stage_embedding_desc', stepNumber: 4 },
  searchable: {
    labelKey: 'stage_searchable',
    descriptionKey: 'stage_searchable_desc',
    stepNumber: 5,
  },
  failed: { labelKey: 'stage_failed', descriptionKey: 'stage_failed_desc', stepNumber: -1 },
};

export function getStageFromStatus(status: string): PipelineStageOrFailed {
  return STATUS_TO_STAGE[status] ?? 'uploaded';
}

export function getStageIndex(stage: PipelineStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export interface StageCounts {
  uploaded: number;
  extracting: number;
  enriching: number;
  embedding: number;
  searchable: number;
  failed: number;
}

export function aggregateToStages(statuses: Array<{ _id: string; count: number }>): StageCounts {
  const stages: StageCounts = {
    uploaded: 0,
    extracting: 0,
    enriching: 0,
    embedding: 0,
    searchable: 0,
    failed: 0,
  };

  for (const { _id, count } of statuses) {
    const stage = STATUS_TO_STAGE[_id] ?? 'uploaded';
    stages[stage] += count;
  }

  return stages;
}

export function getCurrentStage(stages: StageCounts): PipelineStageOrFailed {
  if (stages.uploaded > 0) return 'uploaded';
  if (stages.extracting > 0) return 'extracting';
  if (stages.enriching > 0) return 'enriching';
  if (stages.embedding > 0) return 'embedding';
  if (stages.searchable > 0) return 'searchable';
  return 'uploaded';
}

export function getTotalDocuments(stages: StageCounts): number {
  return (
    stages.uploaded +
    stages.extracting +
    stages.enriching +
    stages.embedding +
    stages.searchable +
    stages.failed
  );
}

export type ErrorAction = 'retry' | 'reupload';

export interface ErrorSuggestion {
  action: ErrorAction;
  hint: string;
}

const REUPLOAD_PATTERNS = [
  'no extractable content',
  'no chunks found',
  'unsupported file',
  'unsupported content',
  'unsupported format',
  'invalid file',
  'corrupt',
  'empty file',
  'password protected',
  'encrypted',
  'could not parse',
  'could not read',
  'not a valid',
  'file is too large',
  'zero bytes',
  'unable to extract',
  'docling extraction failed',
];

export function classifyError(processingError: string | null | undefined): ErrorSuggestion {
  if (!processingError) {
    return { action: 'retry', hint: 'Something went wrong. Try reprocessing the document.' };
  }

  const lower = processingError.toLowerCase();

  if (REUPLOAD_PATTERNS.some((p) => lower.includes(p))) {
    return {
      action: 'reupload',
      hint: 'This file could not be read. Try uploading a different format (e.g. PDF, DOCX).',
    };
  }

  if (lower.includes('extraction failed')) {
    return {
      action: 'reupload',
      hint: 'Text extraction failed. The file may be damaged or in an unsupported format.',
    };
  }

  return {
    action: 'retry',
    hint: 'A temporary error occurred during processing. Retrying usually resolves this.',
  };
}
