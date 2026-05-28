/**
 * Domain Vocabulary Types (Layer 3)
 *
 * Business-level terms that map to canonical fields via fieldRef + capabilities.
 * Resolution happens dynamically at query time based on query context.
 * Example: "priority" → fieldRef: "issue_priority", canFilter: true
 */

import type { VocabularyStatus } from '../constants.js';
import type { MetadataFilter, AggregationSpec } from './search-query.js';

// ─── Vocabulary Entry ────────────────────────────────────────────────────────

export interface VocabularyEntry {
  /** Primary term (e.g., "priority") */
  term: string;
  /** Alternative names for the same concept */
  aliases: string[];
  /** Description for documentation */
  description?: string;
  /** Canonical field reference (e.g., "issue_priority") */
  fieldRef: string;
  /** What this term can resolve to at query time */
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  /** Related fields for context-aware resolution */
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
  /** Whether this entry is active */
  enabled: boolean;
}

// ─── Vocabulary Resolution Result ────────────────────────────────────────────

export interface VocabularyResolutionResult {
  /** Original query (always preserved for semantic search) */
  originalQuery: string;
  /** Terms that were successfully resolved */
  resolvedTerms: ResolvedVocabularyTerm[];
  /** Segments of the query that were not resolved (for debugging) */
  unresolvedSegments: string[];
  /** Structured filters derived from resolved terms */
  structuredFilters: MetadataFilter[];
  /** Aggregation spec derived from resolved terms (if any) */
  aggregationSpec?: Partial<AggregationSpec>;
}

export interface ResolvedVocabularyTerm {
  /** Original term from the query */
  inputTerm: string;
  /** Matched vocabulary entry term */
  matchedTerm: string;
  /** How it was matched */
  matchType: 'exact' | 'alias' | 'fuzzy';
  /** Match confidence (0-1) */
  confidence: number;
  /** Canonical field this term maps to */
  fieldRef: string;
  /** What capabilities this term has */
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
}

// ─── Vocabulary Summary ──────────────────────────────────────────────────────

export interface VocabularySummary {
  id: string;
  projectKnowledgeBaseId: string;
  version: number;
  entryCount: number;
  status: VocabularyStatus;
  createdAt: string;
  updatedAt: string;
}
