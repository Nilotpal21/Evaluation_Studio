/**
 * Vision Service Types
 *
 * Shared types for Phase 3 visual enrichment
 */

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
    bbox?: any;
    pageRelative?: 'top' | 'middle' | 'bottom';
  };
  model: string;
  tokensUsed: number;
  costUsd: number;
}

export interface ScreenshotAnalysis {
  layoutStructure: string;
  keyVisualElements: string[];
  visualHierarchy: string;
  processed: boolean;
}

export interface VisualAnalysisResult {
  imageDescriptions: ImageDescription[];
  visualContext: string;
  keyVisualElements: string[];
  screenshotAnalysis?: ScreenshotAnalysis;
  tokensUsed: number;
  costUsd: number;
  latencyMs: number;
}

export interface EnhancedQuestion {
  question: string;
  modified: boolean;
  visualElements?: string[];
  isNew?: boolean;
}

export interface DocumentSummaryResult {
  summary: string;
  keyVisualElements: string[];
  visualNarrative: string;
  visualThemes: string[];
  chartInsights?: string[];
  tokensUsed: number;
  costUsd: number;
}
