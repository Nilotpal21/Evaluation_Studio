/**
 * Smart Use Case Defaults for LLM Configuration
 *
 * Auto-maps use cases to appropriate model tiers based on task complexity,
 * volume, and cost/quality tradeoff.
 *
 * Resolution hierarchy:
 * 1. SearchIndex.llmConfig.useCases.{useCase} (index-level override)
 * 2. USE_CASE_DEFAULTS[useCase] (smart auto-mapping - THIS FILE)
 * 3. TenantLLMPolicy + LLMCredential (tenant credentials)
 * 4. Global env vars (backward compatibility fallback)
 */

export interface UseCaseDefaults {
  /** Feature enabled by default */
  enabled: boolean;

  /** Auto-selected model tier */
  modelTier: 'fast' | 'balanced' | 'powerful';

  /** Short description of use case */
  description: string;

  /** Explanation of why this tier was chosen */
  rationale: string;

  /** Estimated relative cost (1 = cheapest, 10 = most expensive) */
  costRating: number;

  /** Estimated volume (how many times this runs per document) */
  volumeEstimate: 'low' | 'medium' | 'high';
}

/**
 * Smart defaults for each LLM use case
 *
 * Design principles:
 * - High-volume tasks → fast models (summarization, questions)
 * - Quality-critical tasks → balanced models (vision)
 * - Simple tasks → fast models (classification, extraction)
 * - Expensive features → disabled by default (opt-in)
 */
export const USE_CASE_DEFAULTS: Record<string, UseCaseDefaults> = {
  // ───────────────────────────────────────────────────────────────────────
  // FAST TIER: High-volume, simple tasks
  // ───────────────────────────────────────────────────────────────────────

  progressiveSummarization: {
    enabled: true,
    modelTier: 'fast',
    description: 'Generate concise summaries of document chunks with context',
    rationale:
      'Summarization is a straightforward task that works well with fast models. ' +
      'High volume (runs on every page) makes cost optimization critical. ' +
      'Fast models (Haiku, GPT-4o-mini, Gemini Flash) produce good 2-3 sentence summaries.',
    costRating: 2,
    volumeEstimate: 'high', // Every page
  },

  questionSynthesis: {
    enabled: true,
    modelTier: 'fast',
    description: 'Generate 3-5 answerable questions per chunk for retrieval',
    rationale:
      'Question generation is well-defined (generate questions from text). ' +
      'Fast models handle this reliably. High volume (every page) requires cost efficiency. ' +
      'Quality difference between fast and balanced models is minimal for this task.',
    costRating: 2,
    volumeEstimate: 'high', // Every page
  },

  knowledgeGraph: {
    enabled: true, // Enabled by default - shows as pending until model configured
    modelTier: 'fast',
    description: 'Extract entities and relationships for knowledge graph construction',
    rationale:
      'Entity extraction is well-structured (extract person/org/location names). ' +
      'Fast models perform well with clear prompts. ' +
      'Enabled by default with graceful degradation - shows pending state until model configured.',
    costRating: 4,
    volumeEstimate: 'medium', // Per chunk, but with deduplication
  },

  scopeClassification: {
    enabled: false, // Opt-in (specialized use case)
    modelTier: 'fast',
    description: 'Classify content scope (chunk-level, document-level, global)',
    rationale:
      'Classification task with predefined categories. Fast models sufficient. ' +
      'Disabled by default - specialized feature for multi-level retrieval.',
    costRating: 2,
    volumeEstimate: 'high', // Every chunk if enabled
  },

  mapping_suggestion: {
    enabled: true,
    modelTier: 'fast',
    description:
      'Suggest field mappings from connector schema to canonical schema with enum coercion',
    rationale:
      'Mapping suggestion runs once per connector discovery (low volume). ' +
      'Fast models handle structured mapping tasks well. ' +
      'Quality is acceptable since suggestions are human-reviewed before confirmation.',
    costRating: 3,
    volumeEstimate: 'low', // Once per connector schema discovery
  },

  vocabularyGeneration: {
    enabled: true,
    modelTier: 'fast',
    description: 'Enrich domain vocabulary with aliases, descriptions, and capabilities',
    rationale:
      'Vocabulary generation runs once after field mapping (low volume). ' +
      'Fast models handle term enrichment reliably. ' +
      'Steps 1-2 (query log + sampling) work without LLM; only step 3 needs it.',
    costRating: 3,
    volumeEstimate: 'low', // Once per connector after mapping
  },

  textToSql: {
    enabled: true,
    modelTier: 'balanced',
    description: 'Generate SQL queries from natural language for structured data exploration',
    rationale:
      'SQL generation is a quality-critical task requiring understanding of schema semantics. ' +
      'Balanced tier ensures correct SQL with proper JOINs and aggregations. ' +
      'Low volume (on-demand per user query) makes cost acceptable.',
    costRating: 4,
    volumeEstimate: 'low', // On-demand per user query
  },

  treeBuilder: {
    enabled: true,
    modelTier: 'fast',
    description: 'Builds hierarchical document tree structure for chunking',
    rationale:
      'Tree building is a structured task that works well with fast models. ' +
      'High volume (runs on every document) makes cost optimization critical. ' +
      'Fast models produce good hierarchical structures for chunking.',
    costRating: 3,
    volumeEstimate: 'high', // Every document
  },

  // ───────────────────────────────────────────────────────────────────────
  // BALANCED TIER: Quality-critical tasks
  // ───────────────────────────────────────────────────────────────────────

  vision: {
    enabled: true, // Enabled by default — essential for accurate document understanding
    modelTier: 'balanced',
    description: 'Analyze page screenshots and images for visual content understanding',
    rationale:
      'Visual understanding requires stronger models with vision capabilities. ' +
      'Charts, graphs, and diagrams need accurate interpretation. ' +
      'Enabled by default for enterprise-grade document processing.',
    costRating: 8,
    volumeEstimate: 'medium', // Pages with screenshots/images
  },

  multimodal: {
    enabled: true, // Enabled by default — essential for tables, charts, and image analysis
    modelTier: 'balanced',
    description: 'Deep analysis of images, tables, and charts with data extraction',
    rationale:
      'Complex visual tasks (chart data extraction, table understanding) need ' +
      'stronger models with vision capabilities. ' +
      'Enabled by default for enterprise-grade document processing.',
    costRating: 7,
    volumeEstimate: 'low', // Only images/tables/charts
  },

  // ───────────────────────────────────────────────────────────────────────
  // POWERFUL TIER: Highest quality (currently none - most tasks work with fast/balanced)
  // ───────────────────────────────────────────────────────────────────────

  // Note: Advanced users can upgrade any use case to 'powerful' tier via API
  // if they need maximum quality (e.g., legal document analysis, medical research)
};

/**
 * Get default configuration for a use case
 *
 * @param useCase - Use case name (must exist in USE_CASE_DEFAULTS)
 * @returns Default configuration or throws error if invalid use case
 */
export function getUseCaseDefaults(useCase: string): UseCaseDefaults {
  const defaults = USE_CASE_DEFAULTS[useCase];

  if (!defaults) {
    throw new Error(
      `Invalid use case: "${useCase}". ` +
        `Valid use cases: ${Object.keys(USE_CASE_DEFAULTS).join(', ')}`,
    );
  }

  return defaults;
}

/**
 * Get list of all available use cases
 *
 * @returns Array of use case names
 */
export function getAvailableUseCases(): string[] {
  return Object.keys(USE_CASE_DEFAULTS);
}

/**
 * Check if a use case is valid
 *
 * @param useCase - Use case name to validate
 * @returns true if valid, false otherwise
 */
export function isValidUseCase(useCase: string): boolean {
  return useCase in USE_CASE_DEFAULTS;
}

/**
 * Get default parameters for a specific use case
 *
 * Returns full configuration with all fields filled in with defaults.
 * Used by resolver when no index override exists.
 */
export function getUseCaseDefaultParams(useCase: string): Record<string, any> {
  const defaults = getUseCaseDefaults(useCase);

  // Base fields common to all use cases
  const baseParams = {
    enabled: defaults.enabled,
    modelTier: defaults.modelTier,
  };

  // Use case-specific default parameters
  const specificParams: Record<string, Record<string, any>> = {
    progressiveSummarization: {
      maxTokens: 300,
      enableDocumentSummary: true,
      documentSummaryMaxTokens: 500,
    },

    questionSynthesis: {
      questionsPerChunk: 3,
      maxTokens: 150,
      enableEmbedding: true,
      enableDocumentQuestions: true,
      documentQuestionsCount: 5,
    },

    vision: {
      maxTokens: 500,
      analyzeScreenshots: true,
      analyzeImages: true,
      enhanceTableContinuations: true,
    },

    multimodal: {
      enableImageDescription: true,
      enableTableSummarization: true,
      enableChartAnalysis: true,
    },

    knowledgeGraph: {
      enableCoOccurrence: true,
      maxTokens: 1024,
    },

    treeBuilder: {
      maxTokens: 512,
      targetChunkSize: 512,
      chunkOverlap: 50,
    },

    scopeClassification: {
      maxTokens: 150,
    },

    mapping_suggestion: {
      maxTokens: 4096,
    },

    vocabularyGeneration: {
      maxTokens: 4096,
    },

    textToSql: {
      maxTokens: 1000,
    },
  };

  return {
    ...baseParams,
    ...(specificParams[useCase] || {}),
  };
}

/**
 * Get cost estimate for a use case based on defaults
 *
 * @param useCase - Use case name
 * @param documentPages - Number of pages in document
 * @returns Estimated relative cost (not actual dollars, just for comparison)
 */
export function estimateUseCaseCost(useCase: string, documentPages: number): number {
  const defaults = getUseCaseDefaults(useCase);

  if (!defaults.enabled) {
    return 0; // Disabled features have no cost
  }

  // Volume multiplier
  const volumeMultiplier = {
    low: 0.1, // 10% of pages
    medium: 0.5, // 50% of pages
    high: 1.0, // 100% of pages
  };

  const volume = volumeMultiplier[defaults.volumeEstimate];
  const baseCost = defaults.costRating;

  return baseCost * volume * documentPages;
}
