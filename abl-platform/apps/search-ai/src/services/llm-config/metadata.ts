/**
 * Use Case Metadata
 *
 * Display metadata for each LLM use case (names, descriptions, icons, categories).
 * Used by UI components to render feature cards and explanations.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseCaseMetadata {
  /** Use case identifier (matches key in resolvedConfig.useCases) */
  useCase: string;

  /** Display name for UI */
  displayName: string;

  /** Short description (1-2 sentences) */
  description: string;

  /** Lucide React icon name (without 'Icon' suffix) */
  icon: string;

  /** Feature category for grouping in UI */
  category: 'core' | 'enrichment' | 'advanced' | 'experimental';

  /** Enabled by default? */
  defaultEnabled: boolean;

  /** Smart default tier */
  defaultTier: 'fast' | 'balanced' | 'powerful';

  /** Expected volume (how often this runs per document) */
  volumeEstimate: 'low' | 'medium' | 'high';

  /** Relative cost rating (1 = cheapest, 10 = most expensive) */
  costRating: number;

  /** Detailed explanation for help tooltips */
  longDescription?: string;

  /** Link to documentation */
  docsUrl?: string;
}

// ─── Metadata Constants ──────────────────────────────────────────────────────

export const USE_CASE_METADATA: Record<string, UseCaseMetadata> = {
  // ───────────────────────────────────────────────────────────────────────────
  // CORE FEATURES (Enabled by default, high-value)
  // ───────────────────────────────────────────────────────────────────────────

  progressiveSummarization: {
    useCase: 'progressiveSummarization',
    displayName: 'Progressive Summarization',
    description:
      'Generate concise 2-3 sentence summaries per chunk with context from previous chunks',
    icon: 'FileText',
    category: 'core',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'high',
    costRating: 2,
    longDescription:
      'Generates progressive summaries that carry context between chunks. ' +
      'Each summary builds on the previous one, maintaining document coherence. ' +
      'Also creates document-level summaries from all chunk summaries.',
  },

  questionSynthesis: {
    useCase: 'questionSynthesis',
    displayName: 'Question Synthesis',
    description: 'Generate 3-5 answerable questions per chunk for improved retrieval',
    icon: 'HelpCircle',
    category: 'core',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'high',
    costRating: 2,
    longDescription:
      'Generates questions that the chunk can answer. Improves retrieval by ' +
      'matching user queries against both content and synthesized questions. ' +
      'Questions are embedded separately for query-question matching.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // ENRICHMENT FEATURES (Enabled by default, adds metadata)
  // ───────────────────────────────────────────────────────────────────────────

  knowledgeGraph: {
    useCase: 'knowledgeGraph',
    displayName: 'Knowledge Graph Extraction',
    description: 'Extract entities and relationships to build knowledge graph',
    icon: 'Network',
    category: 'enrichment',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'medium',
    costRating: 4,
    longDescription:
      'Extracts entities (people, organizations, locations, products) and their ' +
      'relationships from content. Builds a knowledge graph for entity-based ' +
      'navigation and discovery. Useful for understanding document connections.',
  },

  scopeClassification: {
    useCase: 'scopeClassification',
    displayName: 'Scope Classification',
    description: 'Classify content scope (chunk-level, document-level, global)',
    icon: 'Layers',
    category: 'enrichment',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'high',
    costRating: 2,
    longDescription:
      'Classifies each chunk by scope: chunk-specific facts, document-level ' +
      'themes, or global domain knowledge. Enables scope-aware retrieval where ' +
      'queries can be routed to appropriate scopes.',
  },

  mapping_suggestion: {
    useCase: 'mapping_suggestion',
    displayName: 'Field Mapping Suggestions',
    description: 'Suggest field mappings from connector schema to canonical schema',
    icon: 'ArrowRightLeft',
    category: 'enrichment',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'low',
    costRating: 3,
    longDescription:
      'Analyzes discovered source fields and suggests mappings to canonical schema fields. ' +
      'Includes enum coercion suggestions. Runs once per connector schema discovery. ' +
      'Suggestions are human-reviewed before confirmation.',
  },

  vocabularyGeneration: {
    useCase: 'vocabularyGeneration',
    displayName: 'Domain Vocabulary Generation',
    description: 'Enrich domain vocabulary with aliases, descriptions, and capabilities',
    icon: 'BookOpen',
    category: 'enrichment',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'low',
    costRating: 3,
    longDescription:
      'Three-step pipeline: (1) query log analysis for term candidates, ' +
      '(2) document content sampling for enum values, (3) LLM enrichment for ' +
      'aliases and descriptions. Steps 1-2 work without LLM; only step 3 needs credentials.',
  },

  treeBuilder: {
    useCase: 'treeBuilder',
    displayName: 'Tree Builder',
    description: 'Hierarchical document tree structure for intelligent chunking',
    icon: 'GitBranch',
    category: 'core',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'high',
    costRating: 3,
    longDescription:
      'Builds a hierarchical tree structure from document content for intelligent ' +
      'chunking. Analyzes document structure to create semantically coherent chunks ' +
      'with configurable size and overlap parameters.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // ADVANCED FEATURES (Enabled by default, higher cost, quality-critical)
  // ───────────────────────────────────────────────────────────────────────────

  vision: {
    useCase: 'vision',
    displayName: 'Vision Analysis',
    description: 'Analyze page screenshots and images for visual content understanding',
    icon: 'Eye',
    category: 'advanced',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'medium',
    costRating: 8,
    longDescription:
      'Analyzes screenshots and images to extract visual information. Describes ' +
      'charts, diagrams, and visual layouts. Useful for PDFs with important visual ' +
      'content that text extraction misses. Requires balanced/powerful models.',
  },

  multimodal: {
    useCase: 'multimodal',
    displayName: 'Multimodal Deep Analysis',
    description: 'Deep analysis of images, tables, and charts with data extraction',
    icon: 'Scan',
    category: 'advanced',
    defaultEnabled: true,
    defaultTier: 'balanced',
    volumeEstimate: 'low',
    costRating: 7,
    longDescription:
      'Performs deep analysis of complex visuals: extracts data from charts, ' +
      'understands table structure, and generates detailed image descriptions. ' +
      'More thorough than basic vision but higher cost. Use for critical visuals.',
  },
};

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Get metadata for a specific use case
 */
export function getUseCaseMetadata(useCase: string): UseCaseMetadata {
  const metadata = USE_CASE_METADATA[useCase];

  if (!metadata) {
    // Return fallback metadata for unknown use cases
    return {
      useCase,
      displayName: useCase,
      description: `LLM feature: ${useCase}`,
      icon: 'Sparkles',
      category: 'experimental',
      defaultEnabled: false,
      defaultTier: 'balanced',
      volumeEstimate: 'medium',
      costRating: 5,
    };
  }

  return metadata;
}

/**
 * Get all use cases by category
 */
export function getUseCasesByCategory(category: UseCaseMetadata['category']): UseCaseMetadata[] {
  return Object.values(USE_CASE_METADATA).filter((meta) => meta.category === category);
}

/**
 * Get all enabled-by-default use cases
 */
export function getDefaultEnabledUseCases(): UseCaseMetadata[] {
  return Object.values(USE_CASE_METADATA).filter((meta) => meta.defaultEnabled);
}

/**
 * Estimate cost per document for a use case
 * Based on cost rating and typical document size
 */
export function estimateCostPerDocument(
  useCase: string,
  typicalDocumentPages: number = 10,
): number {
  const metadata = getUseCaseMetadata(useCase);

  // Base cost per page per cost rating point
  const baseCostPerPage = 0.0001; // $0.0001 per page per rating point

  // Volume multipliers
  const volumeMultipliers = {
    low: 0.5, // Runs on few chunks
    medium: 1.0, // Runs on most chunks
    high: 2.0, // Runs on every chunk/page
  };

  const volumeMultiplier = volumeMultipliers[metadata.volumeEstimate];
  const estimatedCost =
    baseCostPerPage * metadata.costRating * typicalDocumentPages * volumeMultiplier;

  // Round to 4 decimal places
  return Math.round(estimatedCost * 10000) / 10000;
}
