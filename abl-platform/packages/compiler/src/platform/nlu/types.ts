/**
 * NLU Engine Types
 *
 * All interfaces for the modular, contextual, multi-lingual NLU engine.
 */

import type { LLMClient } from '../constructs/types.js';
import type { TraceContextManager } from '../stores/trace-store.js';

// =============================================================================
// CONVERSATION CONTEXT
// =============================================================================

/**
 * Dialog act — what kind of utterance the user is producing
 */
export type DialogAct =
  | 'question'
  | 'answer'
  | 'command'
  | 'confirmation'
  | 'denial'
  | 'correction'
  | 'greeting'
  | 'farewell'
  | 'complaint'
  | 'information'
  | 'unknown';

/**
 * Conversation phase — where in the conversation lifecycle we are
 */
export type ConversationPhase =
  | 'greeting'
  | 'collecting'
  | 'confirming'
  | 'processing'
  | 'complete'
  | 'digressing';

/**
 * A single turn in the conversation with cached NLU results
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  nluResult?: {
    intent?: string;
    entities?: Record<string, unknown>;
    category?: string;
    language?: string;
  };
}

/**
 * Enriched NLU context — passed to every NLU method
 */
export interface NLUContext {
  // --- Message ---
  userMessage: string;
  detectedLanguage?: string;

  // --- Conversation History ---
  conversationHistory: ConversationTurn[];
  turnNumber: number;

  // --- Dialog State ---
  dialogAct?: DialogAct;
  conversationPhase: ConversationPhase;
  pendingQuestion?: string;

  // --- Domain Context ---
  agentGoal: string;
  agentDomain?: string;
  currentStep?: string;
  collectedData: Record<string, unknown>;
  missingFields?: string[];

  // --- NLU Spec (from ABL) ---
  declaredIntents?: IntentDefinition[];
  declaredCategories?: CategoryDefinition[];
  declaredEntities?: EntityDefinition[];
  glossary?: string[];
  fewShotExamples?: FewShotExample[];

  // --- Language ---
  sessionLanguage?: string;
  supportedLanguages?: string[];
}

// =============================================================================
// NLU DEFINITIONS (from ABL NLU: section)
// =============================================================================

/**
 * Intent definition — declared in ABL NLU: intents section
 */
export interface IntentDefinition {
  name: string;
  patterns: string[];
  examples?: string[];
  examplesFile?: string;
  entities?: string[];
}

/**
 * Category definition — quick classification labels
 */
export interface CategoryDefinition {
  name: string;
  patterns: string[];
}

/**
 * Custom entity type definition
 */
export interface EntityDefinition {
  name: string;
  type: 'enum' | 'pattern' | 'location' | 'date' | 'number' | 'free_text';
  values?: string[];
  synonyms?: Record<string, string[]>;
  pattern?: string;
  validation?: string;
  /** Whether this entity carries PII — mirrors GatherField.sensitive for NLU awareness */
  sensitive?: boolean;
}

/**
 * Few-shot example for NLU prompts
 */
export interface FewShotExample {
  input: string;
  output: string;
  intent?: string;
  entities?: Record<string, unknown>;
  language?: string;
}

/**
 * NLU model configuration for ABL NLU: models section
 */
export interface NLUModelConfig {
  fast?: string;
  balanced?: string;
}

/**
 * NLU evaluation configuration
 */
export interface NLUEvalConfig {
  logPredictions?: boolean;
  abTest?: boolean;
  confidenceThreshold?: number;
}

/**
 * Embeddings configuration from ABL
 */
export interface NLUEmbeddingsConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  threshold?: number;
  cacheTtl?: number;
}

/**
 * Complete NLU definition from ABL NLU: section
 */
export interface NLUDefinition {
  models?: NLUModelConfig;
  languages?: string[];
  defaultLanguage?: string;
  allowCodeSwitching?: boolean;
  languageModels?: Record<string, string>;
  intents: IntentDefinition[];
  categories: CategoryDefinition[];
  entities: EntityDefinition[];
  glossary: string[];
  evaluation?: NLUEvalConfig;
  embeddings?: NLUEmbeddingsConfig;
  configFile?: string;
}

// =============================================================================
// MODEL LAYER CONFIGURATION
// =============================================================================

/**
 * LLM provider interface for NLU — wraps the existing LLMClient
 */
export type LLMProvider = LLMClient;

/**
 * Configuration for a single model layer
 */
export interface NLUModelLayerConfig {
  provider: LLMProvider;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

/**
 * NLU task types
 */
export type NLUTask =
  | 'intent_detection'
  | 'sub_intent_detection'
  | 'category_classification'
  | 'entity_extraction'
  | 'correction_detection'
  | 'digression_detection'
  | 'language_detection'
  | 'combined_analysis';

/**
 * Which model layer was used
 */
export type NLULayer = 'fast' | 'balanced' | 'embedding' | 'fallback' | 'plugin';

// =============================================================================
// ENGINE CONFIGURATION
// =============================================================================

/**
 * Full NLU engine configuration
 */
export interface NLUEngineConfig {
  layers: {
    fast: NLUModelLayerConfig;
    balanced?: NLUModelLayerConfig;
  };
  enableFallbacks?: boolean;
  confidenceThreshold?: number;
  trace?: TraceContextManager;
  metrics?: NLUMetricsCollector;
  plugins?: NLUPlugin[];
  embeddings?: {
    provider: EmbeddingProvider;
    threshold?: number;
    useForIntents?: boolean;
    useForEntities?: boolean;
  };
  multiIntent?: {
    enabled: boolean;
    maxIntents: number;
    confidenceThreshold: number;
  };
}

// =============================================================================
// NLU RESULTS
// =============================================================================

/**
 * Intent detection result
 */
export interface IntentResult {
  intent: string | null;
  confidence: number;
  source: NLULayer;
  alternatives?: Array<{ intent: string; confidence: number }>;
}

/**
 * Relationship between detected intents
 */
export interface IntentRelationship {
  type: 'independent' | 'dependent' | 'ambiguous';
  reasoning: string;
}

/**
 * Full multi-intent detection result
 */
export interface MultiIntentResult {
  primary: IntentResult;
  alternatives: IntentResult[];
  relationships: IntentRelationship;
}

/**
 * Sub-intent detection result
 */
export interface SubIntentResult {
  subIntent: string | null;
  confidence: number;
  source: NLULayer;
}

/**
 * Category classification result
 */
export interface CategoryResult {
  category: string | null;
  confidence: number;
  source: NLULayer;
}

/**
 * Entity extraction result
 */
export interface EntityResult {
  values: Record<string, unknown>;
  missing: string[];
  confidence: Record<string, number>;
  source: NLULayer;
}

/**
 * Correction detection result
 */
export interface CorrectionResult {
  detected: boolean;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  confidence: number;
  source: NLULayer;
}

/**
 * Digression detection result
 */
export interface DigressionResult {
  detected: boolean;
  intent?: string;
  confidence: number;
  source: NLULayer;
}

/**
 * Language detection result
 */
export interface LanguageResult {
  primary: string;
  secondary?: string;
  isCodeSwitched: boolean;
  confidence: number;
  source?: string;
  segments?: Array<{
    text: string;
    language: string;
    startIndex: number;
  }>;
}

/**
 * Combined NLU analysis result
 */
export interface AnalysisResult {
  intent?: IntentResult;
  category?: CategoryResult;
  entities?: EntityResult;
  correction?: CorrectionResult;
  language?: LanguageResult;
  digression?: DigressionResult;
}

// =============================================================================
// ANALYSIS OPTIONS
// =============================================================================

/**
 * Intent candidate for detection
 */
export interface IntentCandidate {
  name: string;
  patterns: string[];
  examples?: string[];
  entities?: string[];
}

/**
 * Sub-intent candidate
 */
export interface SubIntentCandidate {
  name: string;
  patterns?: string[];
}

/**
 * Digression candidate
 */
export interface DigressionCandidate {
  intent: string;
  keywords?: string[];
}

/**
 * Entity field for extraction
 */
export interface EntityField {
  name: string;
  type?: string;
  prompt?: string;
  extractionHints?: string[];
  values?: string[];
  synonyms?: Record<string, string[]>;
}

/**
 * Options for combined analysis
 */
export interface AnalyzeOptions {
  detectIntent?: boolean;
  intents?: IntentCandidate[];
  classifyCategory?: boolean;
  categories?: CategoryDefinition[];
  extractEntities?: boolean;
  entityFields?: EntityField[];
  detectCorrection?: boolean;
  collectedData?: Record<string, unknown>;
  detectDigression?: boolean;
  digressions?: DigressionCandidate[];
  detectLanguage?: boolean;
}

// =============================================================================
// PLUGIN SYSTEM
// =============================================================================

/**
 * NLU plugin result — returned from pre-process to short-circuit
 */
export interface NLUPluginResult {
  values?: Record<string, unknown>;
  intent?: string;
  category?: string;
  confidence: number;
  source: 'plugin';
}

/**
 * NLU plugin interface
 */
export interface NLUPlugin {
  name: string;
  preProcess?(ctx: NLUContext, task: NLUTask): Promise<NLUPluginResult | null>;
  postProcess?(ctx: NLUContext, task: NLUTask, result: unknown): Promise<unknown>;
}

// =============================================================================
// METRICS
// =============================================================================

/**
 * NLU prediction event for metrics tracking
 */
export interface NLUPredictionEvent {
  sessionId: string;
  timestamp: Date;
  task: NLUTask;
  input: string;
  language: string;
  modelUsed: string;
  layerUsed: NLULayer;
  prediction: unknown;
  confidence: number;
  latencyMs: number;
  abVariant?: string;
  wasCorrect?: boolean;
  correctedValue?: unknown;
}

/**
 * Aggregated NLU metrics
 */
export interface NLUMetrics {
  totalPredictions: number;
  byTask: Record<
    string,
    {
      count: number;
      avgConfidence: number;
      avgLatencyMs: number;
      fallbackRate: number;
      correctionRate: number;
    }
  >;
  byModel: Record<
    string,
    {
      count: number;
      avgLatencyMs: number;
      errorRate: number;
    }
  >;
  byLanguage: Record<
    string,
    {
      count: number;
      avgConfidence: number;
    }
  >;
}

/**
 * NLU metrics collector interface
 */
export interface NLUMetricsCollector {
  recordPrediction(event: NLUPredictionEvent): void;
  getMetrics(timeRange?: { from: Date; to: Date }): NLUMetrics;
}

// =============================================================================
// EMBEDDINGS
// =============================================================================

/**
 * Embedding provider interface
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly model: string;
}

// =============================================================================
// PROMPT TEMPLATES
// =============================================================================

/**
 * Parsed prompt template from YAML
 */
export interface PromptTemplate {
  system: string;
  schema?: Record<string, unknown>;
  user?: string;
}

// =============================================================================
// IR CONFIG (for compiled NLU section)
// =============================================================================

/**
 * NLU IR configuration — compiled from ABL NLU: section
 */
export interface NLUIRConfig {
  models?: NLUModelConfig;
  languages?: string[];
  defaultLanguage?: string;
  allowCodeSwitching?: boolean;
  languageModels?: Record<string, string>;
  intents: IntentDefinition[];
  categories: CategoryDefinition[];
  entities: EntityDefinition[];
  glossary: string[];
  evaluation?: NLUEvalConfig;
  embeddings?: NLUEmbeddingsConfig;
}
