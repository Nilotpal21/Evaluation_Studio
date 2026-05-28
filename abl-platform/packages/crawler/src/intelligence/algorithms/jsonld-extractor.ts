/**
 * JSON-LD Extractor — extracts structured data from <script type="application/ld+json">
 * blocks in HTML to enable zero-LLM extraction for well-annotated pages.
 *
 * Zero LLM calls — pure DOM parsing and field extraction.
 *
 * Supports target types: Product, Article, Recipe, Event, FAQPage, HowTo.
 * When enough fields are extracted from a target type, `canSkipLlm` is set
 * to true, allowing the crawler to skip expensive LLM handler generation.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';

const log = createLogger('jsonld-extractor');

/** A single parsed JSON-LD block */
export interface JsonLdData {
  '@type': string;
  '@context'?: string;
  [key: string]: unknown;
}

/** Extraction result */
export interface JsonLdExtractionResult {
  found: boolean;
  schemas: JsonLdData[]; // all JSON-LD blocks found
  primaryType?: string; // most specific @type (e.g., 'Product', 'Article')
  extractedFields: Record<string, unknown>; // flattened key fields
  canSkipLlm: boolean; // true if enough structured data to skip handler generation
  confidence: number; // 0.0–1.0
}

/** Configuration for the extractor */
export interface JsonLdExtractorConfig {
  minFieldsForSkip: number; // default 3 — minimum fields to consider canSkipLlm
  targetTypes: string[]; // default ['Product', 'Article', 'Recipe', 'Event', 'FAQPage', 'HowTo']
}

const DEFAULT_CONFIG: JsonLdExtractorConfig = {
  minFieldsForSkip: 3,
  targetTypes: ['Product', 'Article', 'Recipe', 'Event', 'FAQPage', 'HowTo'],
};

/**
 * Field extraction maps per target type.
 * Keys are the JSON-LD @type, values are the field names to extract.
 */
const TARGET_TYPE_FIELDS: Record<string, string[]> = {
  Product: ['name', 'price', 'description', 'image', 'sku', 'brand'],
  Article: ['headline', 'author', 'datePublished', 'description'],
  Recipe: ['name', 'ingredients', 'instructions'],
  Event: ['name', 'startDate', 'location', 'description'],
  FAQPage: ['mainEntity'],
  HowTo: ['name', 'step'],
};

// WHY specificity ordering: When multiple JSON-LD blocks exist, we prefer
// the most content-specific type. Product/Article/Recipe are more specific
// than generic Organization/WebSite/BreadcrumbList schemas.
const TYPE_SPECIFICITY: Record<string, number> = {
  Product: 10,
  Article: 10,
  Recipe: 10,
  Event: 9,
  FAQPage: 9,
  HowTo: 9,
  // Generic types get low specificity — they don't carry extractable content
  WebSite: 2,
  WebPage: 2,
  Organization: 1,
  BreadcrumbList: 1,
};

/**
 * Empty result for when no JSON-LD is found or all blocks are invalid.
 */
function emptyResult(): JsonLdExtractionResult {
  return {
    found: false,
    schemas: [],
    primaryType: undefined,
    extractedFields: {},
    canSkipLlm: false,
    confidence: 0,
  };
}

/**
 * Extracts structured data from JSON-LD script blocks in HTML.
 *
 * Finds all `<script type="application/ld+json">` blocks, parses them,
 * and extracts key fields from known schema.org types. When enough fields
 * are found from a target type, signals that LLM extraction can be skipped.
 */
export class JsonLdExtractor {
  private readonly config: JsonLdExtractorConfig;

  constructor(config?: Partial<JsonLdExtractorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Extract using raw HTML string (parses cheerio internally).
   */
  extract(html: string): JsonLdExtractionResult {
    const $ = cheerio.load(html);
    return this.extractWithDom($);
  }

  /**
   * Extract using pre-parsed cheerio instance (V7 optimization).
   */
  extractWithDom($: cheerio.CheerioAPI): JsonLdExtractionResult {
    const schemas = this.parseJsonLdBlocks($);

    if (schemas.length === 0) {
      return emptyResult();
    }

    const primaryType = this.selectPrimaryType(schemas);
    const extractedFields = this.extractFields(schemas, primaryType);
    const fieldCount = Object.keys(extractedFields).length;

    const isTargetType = primaryType ? this.config.targetTypes.includes(primaryType) : false;
    const canSkipLlm = isTargetType && fieldCount >= this.config.minFieldsForSkip;

    // Confidence: based on field coverage relative to what we could extract
    const maxFields = primaryType ? (TARGET_TYPE_FIELDS[primaryType]?.length ?? 0) : 0;
    const confidence = maxFields > 0 ? Math.min(1, fieldCount / maxFields) : 0.5;

    log.debug('JSON-LD extraction complete', {
      schemasFound: schemas.length,
      primaryType,
      fieldCount,
      canSkipLlm,
      confidence,
    });

    return {
      found: true,
      schemas,
      primaryType,
      extractedFields,
      canSkipLlm,
      confidence,
    };
  }

  /**
   * Parse all <script type="application/ld+json"> blocks from the DOM.
   * Malformed JSON is gracefully skipped.
   */
  private parseJsonLdBlocks($: cheerio.CheerioAPI): JsonLdData[] {
    const schemas: JsonLdData[] = [];

    $('script[type="application/ld+json"]').each((_i, el) => {
      const raw = $(el).html();
      if (!raw || raw.trim().length === 0) {
        return; // skip empty script tags
      }

      try {
        const parsed: unknown = JSON.parse(raw);
        this.collectSchemas(parsed, schemas);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug('Skipping malformed JSON-LD block', { error: msg });
      }
    });

    return schemas;
  }

  /**
   * Recursively collect schemas from parsed JSON-LD.
   * Handles both single objects and @graph arrays.
   */
  private collectSchemas(parsed: unknown, schemas: JsonLdData[]): void {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.collectSchemas(item, schemas);
      }
      return;
    }

    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;

      // Handle @graph structure — an array of entities within a single JSON-LD block
      if (Array.isArray(obj['@graph'])) {
        for (const item of obj['@graph']) {
          this.collectSchemas(item, schemas);
        }
        return;
      }

      // Only collect objects with @type
      if (typeof obj['@type'] === 'string' && obj['@type'].length > 0) {
        schemas.push(obj as JsonLdData);
      }
    }
  }

  /**
   * Select the most specific @type from all collected schemas.
   * Uses TYPE_SPECIFICITY ordering; falls back to first schema's type.
   */
  private selectPrimaryType(schemas: JsonLdData[]): string | undefined {
    if (schemas.length === 0) return undefined;

    let bestType = schemas[0]['@type'];
    let bestScore = TYPE_SPECIFICITY[bestType] ?? 0;

    for (const schema of schemas) {
      const typeScore = TYPE_SPECIFICITY[schema['@type']] ?? 0;
      if (typeScore > bestScore) {
        bestType = schema['@type'];
        bestScore = typeScore;
      }
    }

    return bestType;
  }

  /**
   * Extract key fields from schemas matching the primary type.
   * Also extracts from all target-type schemas if multiple are present.
   */
  private extractFields(schemas: JsonLdData[], primaryType?: string): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    for (const schema of schemas) {
      const type = schema['@type'];
      const fieldNames = TARGET_TYPE_FIELDS[type];

      if (!fieldNames) continue;

      for (const fieldName of fieldNames) {
        if (schema[fieldName] !== undefined && schema[fieldName] !== null) {
          // For the primary type, use field name directly.
          // For secondary types, prefix with type to avoid collisions.
          const key = type === primaryType ? fieldName : `${type.toLowerCase()}_${fieldName}`;
          fields[key] = schema[fieldName];
        }
      }
    }

    return fields;
  }
}
