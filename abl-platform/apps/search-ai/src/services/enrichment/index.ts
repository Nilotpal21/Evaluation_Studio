/**
 * Enrichment Service
 *
 * Enriches document chunks with additional metadata using simple
 * heuristic approaches:
 *
 * - Named Entity Recognition (NER): Regex-based detection of emails,
 *   URLs, dates, and monetary values.
 * - Summary generation: Extracts the first ~200 characters, trimmed
 *   to the last sentence boundary.
 * - Language detection: Simple word-frequency heuristic for English,
 *   Spanish, French, and German (defaults to 'en').
 *
 * LLM-based enrichment (improved NER, abstractive summaries, etc.)
 * can be layered on top later.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface EnrichmentResult {
  /** Detected entities */
  entities: Entity[];
  /** Generated summary (first ~200 chars trimmed to sentence boundary) */
  summary: string;
  /** Detected language (ISO 639-1) */
  language: string;
  /** Additional metadata from enrichment */
  metadata?: Record<string, unknown>;
}

export interface Entity {
  /** The matched text */
  text: string;
  /** Entity type category */
  type: 'person' | 'organization' | 'location' | 'date' | 'money' | 'email' | 'url' | 'other';
  /** Character offset start in the input text */
  start: number;
  /** Character offset end in the input text */
  end: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum summary length in characters before trimming to sentence boundary */
const SUMMARY_MAX_LENGTH = 200;

/**
 * Regex patterns for entity detection.
 * Each entry maps a pattern to an entity type.
 */
const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: Entity['type'] }> = [
  // Email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    type: 'email',
  },
  // URLs (http/https)
  {
    pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g,
    type: 'url',
  },
  // Dates: YYYY-MM-DD
  {
    pattern: /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
    type: 'date',
  },
  // Dates: MM/DD/YYYY
  {
    pattern: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/\d{4}\b/g,
    type: 'date',
  },
  // Money: $X,XXX.XX (USD style)
  {
    pattern: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/g,
    type: 'money',
  },
];

/**
 * Common words used for language detection.
 * Each language has a set of high-frequency function words.
 */
const LANGUAGE_MARKERS: Record<string, string[]> = {
  en: [
    'the',
    'is',
    'and',
    'of',
    'to',
    'in',
    'that',
    'it',
    'was',
    'for',
    'with',
    'this',
    'are',
    'have',
    'not',
  ],
  es: [
    'el',
    'la',
    'de',
    'en',
    'y',
    'que',
    'los',
    'del',
    'las',
    'un',
    'por',
    'con',
    'una',
    'su',
    'para',
  ],
  fr: [
    'le',
    'la',
    'de',
    'et',
    'les',
    'des',
    'en',
    'un',
    'une',
    'est',
    'que',
    'dans',
    'qui',
    'du',
    'pour',
  ],
  de: [
    'der',
    'die',
    'und',
    'den',
    'das',
    'von',
    'ist',
    'ein',
    'mit',
    'dem',
    'nicht',
    'eine',
    'auf',
    'sich',
    'des',
  ],
};

// =============================================================================
// SERVICE
// =============================================================================

export class EnrichmentService {
  /**
   * Enrich a text chunk with detected entities, a summary, and language info.
   *
   * @param text - The text content to enrich
   * @returns Enrichment result with entities, summary, and language
   */
  async enrich(text: string): Promise<EnrichmentResult> {
    const entities = this.detectEntities(text);
    const summary = this.generateSummary(text);
    const language = this.detectLanguage(text);

    return {
      entities,
      summary,
      language,
      metadata: {
        entityCount: entities.length,
        entityTypes: [...new Set(entities.map((e) => e.type))],
        charCount: text.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Entity detection
  // ---------------------------------------------------------------------------

  /**
   * Detect entities in text using regex patterns.
   * Returns deduplicated entities sorted by their position in the text.
   */
  private detectEntities(text: string): Entity[] {
    const entities: Entity[] = [];
    const seen = new Set<string>();

    for (const { pattern, type } of ENTITY_PATTERNS) {
      // Reset the regex state for each invocation
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const key = `${type}:${match.index}:${match[0]}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({
            text: match[0],
            type,
            start: match.index,
            end: match.index + match[0].length,
          });
        }
      }
    }

    // Sort by position in text
    entities.sort((a, b) => a.start - b.start);

    return entities;
  }

  // ---------------------------------------------------------------------------
  // Summary generation
  // ---------------------------------------------------------------------------

  /**
   * Generate a summary by extracting the first ~200 characters of text,
   * trimmed to the last complete sentence boundary.
   *
   * If no sentence boundary is found within the limit, the text is
   * truncated at the last word boundary with an ellipsis.
   */
  private generateSummary(text: string): string {
    const trimmed = text.trim();

    if (trimmed.length <= SUMMARY_MAX_LENGTH) {
      return trimmed;
    }

    // Take the first SUMMARY_MAX_LENGTH characters
    const slice = trimmed.slice(0, SUMMARY_MAX_LENGTH);

    // Try to find the last sentence boundary (.!?)
    const sentenceEnd = Math.max(
      slice.lastIndexOf('.'),
      slice.lastIndexOf('!'),
      slice.lastIndexOf('?'),
    );

    if (sentenceEnd > SUMMARY_MAX_LENGTH * 0.3) {
      // Found a reasonable sentence boundary (at least 30% into the text)
      return slice.slice(0, sentenceEnd + 1).trim();
    }

    // No good sentence boundary — truncate at last word boundary
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > 0) {
      return slice.slice(0, lastSpace).trim() + '...';
    }

    // No spaces at all — hard truncate
    return slice + '...';
  }

  // ---------------------------------------------------------------------------
  // Language detection
  // ---------------------------------------------------------------------------

  /**
   * Detect the language of the text using word-frequency heuristics.
   *
   * Tokenizes the text, counts how many tokens match each language's
   * common word list, and returns the language with the highest score.
   * Defaults to 'en' if no clear signal is found.
   *
   * @returns ISO 639-1 language code ('en', 'es', 'fr', 'de')
   */
  private detectLanguage(text: string): string {
    // Tokenize: split on non-word characters, lowercase, filter short tokens
    const words = text
      .toLowerCase()
      .split(/[^a-zA-Z\u00C0-\u024F]+/)
      .filter((w) => w.length >= 2);

    if (words.length === 0) {
      return 'en';
    }

    // Build a frequency set from the first 500 words (for performance)
    const sample = words.slice(0, 500);
    const wordSet = new Set(sample);

    const scores: Record<string, number> = {};

    for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
      let score = 0;
      for (const marker of markers) {
        if (wordSet.has(marker)) {
          // Weight by frequency in sample
          score += sample.filter((w) => w === marker).length;
        }
      }
      scores[lang] = score;
    }

    // Find language with highest score
    let bestLang = 'en';
    let bestScore = 0;

    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestLang = lang;
      }
    }

    return bestLang;
  }
}
