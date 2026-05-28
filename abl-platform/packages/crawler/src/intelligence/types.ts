/**
 * Crawl Intelligence POC Types
 *
 * Types for the 4-phase intelligence loop:
 * Phase 1 (MAP+INTENT) - Filter URLs by user intent
 * Phase 2 (UNDERSTAND) - Browse and analyze page structure
 * Phase 3 (BUILD HANDLER) - Generate extraction recipe
 * Phase 4 (REPLAY) - Mechanically execute handler
 */

/** User input to start the intelligence loop */
export interface CrawlIntent {
  /** What the user wants to extract */
  intent: string;
  /** Base site URL */
  siteUrl: string;
  /** A sample page with the content they want */
  sampleUrl: string;
}

/** A single Playwright step in a PageHandler */
export interface IPlaywrightStep {
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'extract' | 'execute_js';
  selector?: string;
  value?: string;
  description: string;
}

/** Executable recipe for extracting content from a page */
export interface IPageHandler {
  /** URL pattern this handler applies to (glob or regex) */
  urlPattern: string;
  /** Human-readable description */
  description: string;
  /** Ordered Playwright steps */
  steps: IPlaywrightStep[];
  /** CSS selectors for content extraction */
  extractionSelectors: {
    title?: string;
    content: string;
    metadata?: Record<string, string>;
  };
}

/** Result of Phase 1: MAP+INTENT */
export interface MapIntentResult {
  /** URLs matching the user's intent */
  filteredUrls: string[];
  /** LLM's understanding of the intent */
  intentSummary: string;
  /** URL pattern inferred */
  urlPattern: string;
}

/** Result of Phase 2: UNDERSTAND */
export interface UnderstandResult {
  /** What the LLM found on the page */
  pageStructure: string;
  /** Key content areas identified */
  contentAreas: Array<{
    selector: string;
    description: string;
    matchesIntent: boolean;
  }>;
  /** Interactive elements found (accordions, tabs, modals, etc.) */
  interactiveElements?: Array<{
    type: string;
    selector: string;
    description: string;
  }>;
  /** Keywords from the page content that relate to user intent */
  suggestedKeywords?: string[];
  /** Whether the page matches the user's intent */
  intentMatch: boolean;
}

/** Result of Phase 3: BUILD HANDLER */
export interface BuildHandlerResult {
  handler: IPageHandler;
  /** LLM's explanation of the handler */
  reasoning: string;
}

/** Result of Phase 4: REPLAY */
export interface ReplayResult {
  /** Extracted content */
  content: {
    title?: string;
    body: string;
    rawHtml?: string;
    metadata?: Record<string, string>;
  };
  /** Whether extraction succeeded */
  success: boolean;
  /** Steps executed and their results */
  stepResults: Array<{
    step: IPlaywrightStep;
    success: boolean;
    error?: string;
  }>;
}

/** Callback for progress reporting during intelligence execution */
export type OnProgressCallback = (
  phase: 'map' | 'understand' | 'build_handler' | 'replay' | 'reuse',
  detail?: string,
) => void | Promise<void>;

/**
 * UI-facing analysis result. Single definition, imported by search-ai + studio.
 * Serializable subset of IntelligenceLoopResult for API/WS transport.
 */
export interface IntelligenceAnalysisResult {
  title?: string;
  body: string;
  bodyLength: number;
  quality: 'rich' | 'standard' | 'thin';
  handler: { steps: number; urlPattern: string };
  llmCallCount: number;
  totalTokens: number;
  /** Whether a cached handler was reused (skipped Phase 2+3) */
  handlerReused: boolean;
}

/** Full POC result */
export interface IntelligenceLoopResult {
  intent: CrawlIntent;
  mapIntent: MapIntentResult;
  understand: UnderstandResult;
  buildHandler: BuildHandlerResult;
  replay: ReplayResult;
  /** Total LLM calls made across all phases */
  llmCallCount: number;
  /**
   * Total tokens used (Phase 2 only).
   * Phases 1 and 3 use chat() which returns text only, not usage data.
   * This will undercount total usage — use as a lower bound estimate.
   */
  totalTokens: number;
  /** Whether a stored handler was reused (skipping Phase 2+3) */
  handlerReused: boolean;
  /** Template ID of the reused handler, if any */
  handlerTemplateId?: string;
}
