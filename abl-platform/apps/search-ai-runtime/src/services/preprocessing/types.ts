/**
 * Types for Preprocessing Service
 *
 * Multilingual query preprocessing supporting 20+ languages for spell correction
 * and 30+ languages for synonym expansion.
 */

// ─── Request Types ──────────────────────────────────────────────────────────

export interface PreprocessingConfig {
  /** Enable spell correction (default: true) */
  enableSpellCorrection?: boolean;
  /** Enable synonym expansion (default: true) */
  enableSynonymExpansion?: boolean;
  /** Enable entity extraction (default: true) */
  enableEntityExtraction?: boolean;
  /** Maximum synonyms per term (default: 3) */
  maxSynonyms?: number;
}

export interface PreprocessingRequest {
  /** Query text to preprocess */
  query: string;
  /** Tenant ID for tenant-specific dictionaries */
  tenantId: string;
  /** Optional preprocessing configuration */
  config?: PreprocessingConfig;
}

// ─── Response Types ─────────────────────────────────────────────────────────

export interface SpellCorrection {
  /** Original word */
  original: string;
  /** Corrected word */
  corrected: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Source of correction: 'tenant_dict' | 'spellchecker' */
  source: string;
}

export interface SynonymExpansion {
  /** Original term */
  term: string;
  /** List of synonyms */
  synonyms: string[];
  /** Source: 'tenant_dict' | 'abbreviation' | 'wordnet' */
  source: string;
}

export interface Entity {
  /** Entity text */
  text: string;
  /** Entity type: 'date' | 'number' | 'email' | 'url' | 'phone' | 'currency' | 'custom' */
  type: string;
  /** Parsed entity value */
  value: any;
  /** Start position in query */
  start: number;
  /** End position in query */
  end: number;
}

export interface PreprocessingMetadata {
  /** Original query before preprocessing */
  originalQuery: string;
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Stages executed */
  stagesExecuted: string[];
  /** Error message if processing failed */
  error?: string;
}

export interface PreprocessingResponse {
  /** Preprocessed query text */
  processedQuery: string;
  /** Detected language (ISO 639-1 code) */
  language: string;
  /** Language detection confidence (0-1) */
  confidence: number;
  /** Results from each preprocessing stage */
  stages: {
    spellCorrection: SpellCorrection[];
    synonymExpansion: SynonymExpansion[];
    entities: Entity[];
  };
  /** Processing metadata */
  metadata: PreprocessingMetadata;
}

// ─── Health Check ───────────────────────────────────────────────────────────

export interface PreprocessingHealthResponse {
  status: 'healthy' | 'unhealthy';
  service: string;
  version: string;
}

// ─── Supported Languages ────────────────────────────────────────────────────

export interface LanguagesResponse {
  languages: {
    spellCorrection: string[];
    synonymExpansion: string[];
    detection: string[];
  };
  total: {
    spellCorrection: number;
    synonymExpansion: number;
    detection: number;
  };
}
