/**
 * Visual Enrichment Types (Phase 3)
 *
 * Type definitions for Phase 3 visual enrichment metadata.
 * These extend the base SearchChunk, ChunkQuestion, and Document models
 * with structured metadata for visual analysis.
 */

import type { ISearchChunk, IChunkQuestion } from './index.js';

// ─── Image Description ───────────────────────────────────────────────────────

export interface ImageDescription {
  s3Url: string;
  description: string;
  relevanceToContent: string;
  extractedData?: {
    type: 'bar' | 'line' | 'pie' | 'table' | 'diagram';
    data: any;
    insights: string[];
  };
  position?: {
    bbox?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    pageRelative?: 'top' | 'middle' | 'bottom';
  };
  model: string;
  tokensUsed: number;
  costUsd: number;
}

// ─── Screenshot Analysis ─────────────────────────────────────────────────────

export interface ScreenshotAnalysis {
  layoutStructure: string;
  keyVisualElements: string[];
  visualHierarchy: string;
  processed: boolean;
}

// ─── Visual Analysis Metadata ────────────────────────────────────────────────

export interface VisualAnalysisMetadata {
  processed: boolean;
  processedAt: Date;
  imageDescriptions: ImageDescription[];
  screenshotAnalysis?: ScreenshotAnalysis;
  visualContext: string; // Passed to next page
  enrichmentTokens: number;
  enrichmentCost: number;
  enrichmentModel: string;
  error?: string; // If processing failed
}

// ─── SearchChunk with Visual Enrichment ──────────────────────────────────────

export interface SearchChunkMetadata {
  // Page information
  pageNumber?: number;
  pageId?: string;
  chunkType?: 'page' | 'table';
  hasImages?: boolean;
  hasTables?: boolean;
  headings?: Array<{ level: number; text: string }>;

  // Phase 2: Progressive summarization
  progressiveSummary?: string;
  progressiveSummaryVersion?: 1 | 2; // 1=text-only, 2=visually-enriched

  // Phase 2: Document-level summary (on last chunk)
  documentSummary?: string;

  // Phase 3: Visual enrichment (NEW)
  visualAnalysis?: VisualAnalysisMetadata;

  // Deprecated (replaced by Phase 3)
  imageDescriptions?: any[]; // Old multimodal worker
  tableSummaries?: any[]; // Old multimodal worker
  multiModalProcessed?: boolean; // Old flag

  // Cost tracking
  totalCost?: number;
  totalTokens?: number;
}

export interface ISearchChunkWithVisual extends ISearchChunk {
  metadata: SearchChunkMetadata | null;
}

// ─── ChunkQuestion with Visual Enrichment ────────────────────────────────────

export interface ChunkQuestionMetadata extends Record<string, unknown> {
  jobId?: string;
  timestamp?: string;

  // Phase 3: Visual enrichment (NEW)
  questionVersion?: 1 | 2; // 1=text-only, 2=visually-enriched
  visuallyEnriched?: boolean; // Did Phase 3 modify this question?
  visualElements?: string[]; // Image URLs/refs that informed this question
  originalQuestion?: string; // If modified in Phase 3, store original
  addedInPhase3?: boolean; // True for new visual-specific questions
}

export interface IChunkQuestionWithVisual extends IChunkQuestion {
  metadata: ChunkQuestionMetadata | null;
}

// ─── Document with Visual Summary ────────────────────────────────────────────

export interface VisualDocumentSummary {
  keyVisualElements: string[]; // Important images/charts across document
  visualNarrative: string; // How visuals support the content narrative
  visualThemes: string[]; // Common visual themes/patterns
  chartInsights?: string[]; // Key insights from charts/data visualizations
  enrichedAt: Date;
  enrichmentTokens: number;
  enrichmentCost: number;
  enrichmentModel: string;
}

export interface DocumentMetadata {
  // Phase 2: Text-only document summary
  documentSummary?: string;
  documentSummaryVersion?: 1 | 2; // 1=text-only, 2=visually-enriched

  // Phase 3: Document-level visual summary (NEW)
  visualDocumentSummary?: VisualDocumentSummary;

  // Cost tracking
  totalProcessingCost?: number;
  totalProcessingTokens?: number;

  // Other metadata (existing)
  [key: string]: any;
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

/**
 * Check if chunk has visual enrichment
 */
export function hasVisualEnrichment(chunk: ISearchChunk): chunk is ISearchChunkWithVisual {
  return (
    chunk.metadata?.visualAnalysis?.processed === true &&
    Array.isArray(chunk.metadata?.visualAnalysis?.imageDescriptions)
  );
}

/**
 * Check if question is visually enriched
 */
export function isVisuallyEnrichedQuestion(
  question: IChunkQuestion,
): question is IChunkQuestionWithVisual {
  return question.metadata?.visuallyEnriched === true;
}

/**
 * Get image descriptions from chunk (backward compatible)
 */
export function getImageDescriptions(chunk: ISearchChunk): ImageDescription[] {
  // Prefer new location (Phase 3)
  if (chunk.metadata?.visualAnalysis?.imageDescriptions) {
    return chunk.metadata.visualAnalysis.imageDescriptions;
  }

  // Fallback to old location (multimodal worker)
  if (Array.isArray(chunk.metadata?.imageDescriptions)) {
    return chunk.metadata.imageDescriptions;
  }

  return [];
}

/**
 * Get progressive summary (with version check)
 */
export function getProgressiveSummary(chunk: ISearchChunk): {
  summary: string;
  version: 1 | 2;
  visuallyEnriched: boolean;
} | null {
  const summary = chunk.metadata?.progressiveSummary;
  if (!summary) {
    return null;
  }

  const version = chunk.metadata?.progressiveSummaryVersion || 1;
  return {
    summary,
    version,
    visuallyEnriched: version === 2,
  };
}

/**
 * Get document summary (with version check)
 */
export function getDocumentSummary(metadata: DocumentMetadata): {
  summary: string;
  version: 1 | 2;
  visuallyEnriched: boolean;
  visualNarrative?: string;
} | null {
  const summary = metadata?.documentSummary;
  if (!summary) {
    return null;
  }

  const version = metadata?.documentSummaryVersion || 1;
  return {
    summary,
    version,
    visuallyEnriched: version === 2,
    visualNarrative: metadata?.visualDocumentSummary?.visualNarrative,
  };
}
