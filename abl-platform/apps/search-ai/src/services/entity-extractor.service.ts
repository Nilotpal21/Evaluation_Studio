/**
 * Entity Extractor Service
 *
 * Extracts entities from chunks, scoped by document's product classification.
 * Uses hybrid approach: regex for simple patterns, LLM for complex extraction.
 *
 * Key Design:
 * - Scoped extraction: Only extract attributes applicable to document's product type
 * - Hybrid method: Regex primary (fast, free), LLM fallback (accurate, costly)
 * - Attribute validation: Check applicableTo/notApplicableTo from taxonomy
 * - Context tracking: inScopeMatch, attributeApplicable flags
 *
 * Cost: ~$0.00001/chunk (regex), ~$0.0002/chunk (LLM fallback)
 */

import type { ChatLLMClient } from '@agent-platform/llm';
import type {
  IKnowledgeGraphTaxonomy,
  IEntityExtraction,
  IKGAttribute,
} from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('entity-extractor');

// =============================================================================
// TYPES
// =============================================================================

export interface EntityExtractionConfig {
  enableRegex: boolean;
  enableLLM: boolean;
  llmModel: string;
  maxTokens: number;
  confidenceThreshold: number;
  /**
   * Fraction of chunks (0-1) to sample for novel discovery when regex
   * already found known entities. 0 = never discover novel when regex hits,
   * 1 = always call LLM for novel discovery. Default 0.3.
   */
  novelDiscoverySampleRate: number;
}

/** Max time (ms) for a single regex pattern execution per chunk */
const REGEX_TIMEOUT_MS = 100;
/** Max matches from a single regex pattern per chunk */
const MAX_MATCHES_PER_PATTERN = 50;

/** Novel attribute discovered by LLM that is NOT in the taxonomy */
export interface NovelCandidate {
  name: string; // snake_case canonical name e.g. "contactless_payment"
  definition: string; // one-sentence explanation
  rawValue: string; // as extracted from text
  normalizedValue: string | number | boolean;
  dataType: string; // string|number|boolean|date|currency|percentage
  confidence: number; // 0-1
  productType: string; // inherited from document classification
}

/** Extended extraction result with known + novel */
export interface ExtractionResult {
  known: IEntityExtraction[];
  novel: NovelCandidate[];
}

// =============================================================================
// STRUCTURED JSON FIELD BLOCKLIST
// =============================================================================

/**
 * Fields to skip during structured JSON extraction.
 * These are system/noise fields that should not become entity instances.
 */
const STRUCTURED_FIELD_BLOCKLIST = new Set([
  'complementaryanalogous',
  'complementarycomplementary',
  'complementarymono',
  'complementarytonal',
  'similar',
  'keyFeatures',
  'updatedAt',
  'createdAt',
  'product_image',
  'storeId',
  '__v',
  '_id',
  '_v',
]);

/** Maximum items from an array field to emit as entity instances */
const MAX_ARRAY_ENTITY_VALUES = 10;

// =============================================================================
// ENTITY EXTRACTOR SERVICE
// =============================================================================

export class EntityExtractorService {
  private llmClient: ChatLLMClient;
  private config: EntityExtractionConfig;

  constructor(llmClient: ChatLLMClient, config?: Partial<EntityExtractionConfig>) {
    this.llmClient = llmClient;
    this.config = {
      enableRegex: config?.enableRegex ?? true,
      enableLLM: config?.enableLLM ?? true,
      llmModel: config?.llmModel ?? 'claude-3-5-haiku-20241022',
      maxTokens: config?.maxTokens ?? 1024,
      confidenceThreshold: config?.confidenceThreshold ?? 0.7,
      novelDiscoverySampleRate: config?.novelDiscoverySampleRate ?? 0.3,
    };
  }

  /**
   * Extract entities from a structured JSON record (e.g. JSON upload chunks).
   *
   * Instead of running regex/LLM on serialized JSON text, this reads field
   * values directly — achieving near-100% extraction coverage for structured data.
   *
   * For each field:
   * 1. Match against known taxonomy attributes (by id, name, or keywords)
   * 2. If no match → create a novel candidate for admin review
   */
  extractFromStructuredRecord(
    record: Record<string, unknown>,
    taxonomy: IKnowledgeGraphTaxonomy,
    documentProductType: string,
  ): ExtractionResult {
    const applicableAttributes = this.getApplicableAttributes(taxonomy, documentProductType);
    // Also build a lookup across ALL attributes (not just applicable) for broader matching
    const allAttributes = taxonomy.taxonomy.attributes;

    const knownEntities: IEntityExtraction[] = [];
    const novelCandidates: NovelCandidate[] = [];
    const seen = new Set<string>();

    for (const [fieldName, rawFieldValue] of Object.entries(record)) {
      // Skip blocklisted system/noise fields
      if (STRUCTURED_FIELD_BLOCKLIST.has(fieldName)) continue;

      // Skip null/undefined/empty
      if (rawFieldValue === null || rawFieldValue === undefined || rawFieldValue === '') continue;

      // Normalize field name for matching: camelCase/kebab → snake_case
      const normalizedFieldName = fieldName
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/-/g, '_')
        .toLowerCase();

      // Try to match against known taxonomy attributes
      const matchedAttr = this.matchFieldToAttribute(
        normalizedFieldName,
        fieldName,
        applicableAttributes,
        allAttributes,
      );

      // Flatten values: arrays → multiple entity instances, scalars → single
      const values = this.flattenFieldValue(rawFieldValue);

      if (matchedAttr) {
        // Known attribute — create entity instances
        for (const val of values) {
          const normalizedValue = this.normalizeValue(String(val), matchedAttr.dataType);
          const dedupKey = `${matchedAttr.id}:${String(normalizedValue)}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          knownEntities.push({
            type: matchedAttr.id,
            name: matchedAttr.name,
            dataType: matchedAttr.dataType,
            rawValue: String(val),
            normalizedValue,
            productType: documentProductType,
            context: {
              chunkScope: documentProductType,
              inScopeMatch: applicableAttributes.includes(matchedAttr),
              attributeApplicable: true,
            },
          });
        }
      } else {
        // Novel candidate — field not in taxonomy
        const dataType = this.inferDataType(rawFieldValue);
        for (const val of values) {
          const dedupKey = `novel:${normalizedFieldName}:${String(val)}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          novelCandidates.push({
            name: normalizedFieldName,
            definition: `Product attribute "${fieldName}" extracted from structured JSON record`,
            rawValue: String(val),
            normalizedValue: typeof val === 'number' ? val : String(val),
            dataType,
            confidence: 0.95, // High confidence — direct field read, not LLM inference
            productType: documentProductType,
          });
        }
      }
    }

    log.info('Structured JSON extraction complete', {
      knownEntities: knownEntities.length,
      novelCandidates: novelCandidates.length,
      totalFields: Object.keys(record).length,
      skippedFields: Object.keys(record).filter((k) => STRUCTURED_FIELD_BLOCKLIST.has(k)).length,
    });

    return { known: knownEntities, novel: novelCandidates };
  }

  /**
   * Match a JSON field name against taxonomy attributes.
   * Tries: exact id match → name match → keyword match.
   * Returns the matched attribute or null.
   */
  private matchFieldToAttribute(
    normalizedName: string,
    originalName: string,
    applicableAttributes: IKGAttribute[],
    allAttributes: IKGAttribute[],
  ): IKGAttribute | null {
    // Priority 1: Exact ID match against applicable attributes
    for (const attr of applicableAttributes) {
      if (attr.id === normalizedName) return attr;
    }

    // Priority 2: Name match (case-insensitive) against applicable
    const lowerName = normalizedName.replace(/_/g, ' ');
    const lowerOriginal = originalName.toLowerCase();
    for (const attr of applicableAttributes) {
      const attrNameLower = attr.name.toLowerCase();
      if (attrNameLower === lowerName || attrNameLower === lowerOriginal) return attr;
    }

    // Priority 3: Keyword match against applicable
    for (const attr of applicableAttributes) {
      const keywords = attr.extraction.keywords || [];
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase().replace(/\s+/g, '_');
        if (kwLower === normalizedName || kwLower === lowerOriginal) return attr;
      }
    }

    // Priority 4: Same checks against ALL attributes (cross-product matching)
    for (const attr of allAttributes) {
      if (attr.id === normalizedName) return attr;
    }
    for (const attr of allAttributes) {
      const attrNameLower = attr.name.toLowerCase();
      if (attrNameLower === lowerName || attrNameLower === lowerOriginal) return attr;
    }

    return null;
  }

  /**
   * Flatten a field value into an array of primitive values for entity creation.
   * Arrays → individual items (capped), scalars → single-element array.
   */
  private flattenFieldValue(value: unknown): (string | number | boolean)[] {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_ENTITY_VALUES)
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => (typeof v === 'object' ? JSON.stringify(v) : v));
    }
    if (typeof value === 'object' && value !== null) {
      return []; // Skip complex nested objects
    }
    return [value as string | number | boolean];
  }

  /**
   * Infer dataType from a JavaScript value for novel candidates.
   */
  private inferDataType(value: unknown): string {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') {
      if (/^\d+(\.\d+)?%$/.test(value)) return 'percentage';
      if (/^\$[\d,.]+$/.test(value)) return 'currency';
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
      const num = Number(value);
      if (!isNaN(num) && value.trim().length > 0) return 'number';
    }
    return 'string';
  }

  /**
   * Extract entities from chunk content, scoped by document's product type
   */
  async extractEntities(
    chunkContent: string,
    taxonomy: IKnowledgeGraphTaxonomy,
    documentProductType: string,
  ): Promise<ExtractionResult> {
    // Get applicable attributes for this product type
    const applicableAttributes = this.getApplicableAttributes(taxonomy, documentProductType);

    if (applicableAttributes.length === 0) {
      return { known: [], novel: [] }; // No attributes applicable to this product
    }

    const knownEntities: IEntityExtraction[] = [];
    const novelCandidates: NovelCandidate[] = [];

    // Try regex extraction first (fast, free)
    if (this.config.enableRegex) {
      const regexEntities = this.extractWithRegex(
        chunkContent,
        applicableAttributes,
        documentProductType,
      );
      knownEntities.push(...regexEntities);
    }

    // LLM serves two purposes:
    // 1. Known entity extraction when regex found nothing (fallback)
    // 2. Novel attribute discovery (sampled to control cost)
    //
    // When regex found known entities: sample chunks for novel-only LLM call
    // When regex found nothing: always call LLM for both known + novel
    if (this.config.enableLLM) {
      const regexFoundKnown = knownEntities.length > 0;
      const shouldCallLLM = regexFoundKnown
        ? Math.random() < this.config.novelDiscoverySampleRate
        : true; // Always LLM when regex found nothing

      if (shouldCallLLM) {
        // Resolve domain name from taxonomy for accurate LLM prompt
        const domainName = taxonomy.taxonomy.domain?.name || 'general';
        const llmResult = await this.extractWithLLM(
          chunkContent,
          applicableAttributes,
          documentProductType,
          domainName,
        );
        // Only add LLM-extracted known entities if regex found nothing (avoid duplicates)
        if (!regexFoundKnown) {
          knownEntities.push(...llmResult.known);
        }
        // Always collect novel candidates from LLM
        novelCandidates.push(...llmResult.novel);
      }
    }

    return { known: knownEntities, novel: novelCandidates };
  }

  /**
   * Get attributes applicable to a product type
   * H13 fix: Return typed IKGAttribute[] instead of any[]
   */
  private getApplicableAttributes(
    taxonomy: IKnowledgeGraphTaxonomy,
    productType: string,
  ): IKGAttribute[] {
    return taxonomy.taxonomy.attributes.filter((attr) => {
      // Check if product is in applicableTo list
      // Empty applicableTo means "all products" per domain-definition.schema.ts
      const isApplicable =
        attr.applicableTo.length === 0 || attr.applicableTo.includes(productType);

      // Check if product is NOT in notApplicableTo list
      const isNotExcluded = !attr.notApplicableTo.includes(productType);

      return isApplicable && isNotExcluded;
    });
  }

  /**
   * Extract entities using regex patterns
   */
  private extractWithRegex(
    content: string,
    applicableAttributes: IKGAttribute[],
    documentProductType: string,
  ): IEntityExtraction[] {
    const entities: IEntityExtraction[] = [];
    // Dedup: (attributeId:normalizedValue) → prevent same value matched by multiple patterns
    const seen = new Set<string>();

    for (const attr of applicableAttributes) {
      // Only use regex if method is 'regex' or 'hybrid'
      if (attr.extraction.method === 'llm') {
        continue;
      }

      const patterns = attr.extraction.patterns || [];

      for (const pattern of patterns) {
        try {
          const regex = new RegExp(pattern, 'gi');
          let match;
          let matchCount = 0;
          const startTime = Date.now();

          while ((match = regex.exec(content)) !== null) {
            // Safety: cap matches per pattern to prevent runaway extraction
            matchCount++;
            if (matchCount > MAX_MATCHES_PER_PATTERN) {
              log.warn('Regex match limit reached', {
                attribute: attr.name,
                pattern,
                limit: MAX_MATCHES_PER_PATTERN,
              });
              break;
            }

            // Safety: time-bound regex execution
            if (Date.now() - startTime > REGEX_TIMEOUT_MS) {
              log.warn('Regex timeout reached', {
                attribute: attr.name,
                pattern,
                timeoutMs: REGEX_TIMEOUT_MS,
              });
              break;
            }

            const rawValue = match[0];
            const normalizedValue = this.normalizeValue(rawValue, attr.dataType);

            // Dedup: skip if same (attribute, normalizedValue) already seen
            const dedupKey = `${attr.id}:${String(normalizedValue)}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            entities.push({
              type: attr.id,
              name: attr.name,
              dataType: attr.dataType,
              rawValue,
              normalizedValue,
              productType: documentProductType,
              context: {
                chunkScope: documentProductType,
                inScopeMatch: true, // Within document's product scope
                attributeApplicable: true, // Attribute is applicable to product
              },
            });
          }
        } catch (error) {
          log.error(`Invalid regex pattern for ${attr.name}`, {
            pattern,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return entities;
  }

  /**
   * Extract entities using LLM
   */
  private async extractWithLLM(
    content: string,
    applicableAttributes: IKGAttribute[],
    documentProductType: string,
    domainName = 'general',
  ): Promise<ExtractionResult> {
    const systemPrompt = this.buildLLMSystemPrompt(
      applicableAttributes,
      documentProductType,
      domainName,
    );
    const userPrompt = this.buildLLMUserPrompt(content);

    try {
      const response = await this.llmClient.chat(
        systemPrompt,
        [{ role: 'user', content: userPrompt }],
        {
          model: this.config.llmModel,
          maxTokens: this.config.maxTokens,
        },
      );

      // Parse JSON response
      const parsed = this.parseLLMResponse(response);

      // Convert known entities to IEntityExtraction format
      const known: IEntityExtraction[] = (parsed.entities || []).map((e: any) => ({
        type: e.attributeId,
        name: e.attributeName,
        dataType: e.dataType,
        rawValue: e.rawValue,
        normalizedValue: e.normalizedValue,
        productType: documentProductType,
        context: {
          chunkScope: documentProductType,
          inScopeMatch: true,
          attributeApplicable: true,
        },
      }));

      // Convert novel candidates
      const novel: NovelCandidate[] = (parsed.novel || []).map((n: any) => ({
        name: n.name,
        definition: n.definition || '',
        rawValue: n.rawValue,
        normalizedValue: n.normalizedValue,
        dataType: n.dataType,
        confidence: n.confidence ?? 0,
        productType: documentProductType,
      }));

      return { known, novel };
    } catch (error) {
      log.error('Failed to extract entities with LLM', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { known: [], novel: [] };
    }
  }

  /**
   * Build LLM system prompt for entity extraction
   */
  private buildLLMSystemPrompt(
    applicableAttributes: IKGAttribute[],
    productType: string,
    domainName = 'general',
  ): string {
    const attributeList = applicableAttributes
      .map((attr) => {
        const hints = attr.extraction.keywords || [];
        const orgContext = attr.organizationContext
          ? `\n  Organization Context: ${attr.organizationContext.typicalRange || 'N/A'}, Aliases: ${attr.organizationContext.aliases?.join(', ') || 'N/A'}`
          : '';

        return `- ${attr.name} (${attr.id}): Type=${attr.dataType}, Hints=[${hints.join(', ')}]${orgContext}`;
      })
      .join('\n');

    return `You are an entity extractor for ${domainName} documents.

**Document Product Scope:** ${productType}

**PART A — KNOWN ATTRIBUTES:**

**Applicable Attributes to Extract:**
${attributeList}

**Extraction Rules:**
1. Only extract attributes listed above (scoped to this product type)
2. Extract the EXACT text as it appears in the document
3. Normalize values according to dataType (currency → number, date → ISO format, etc.)
4. Return confidence score (0.0-1.0) for each extraction
5. If no entities found, return empty array

**PART B — NOVEL DISCOVERY:**
If you find product attributes NOT listed above, report them as novel.
For each novel attribute, provide:
- name: snake_case canonical name
- definition: one sentence explaining what this attribute means
- value: the extracted value
- dataType: string|number|boolean|date|currency|percentage

**OUTPUT FORMAT (JSON):**
{
  "entities": [
    { "attributeId": "...", "attributeName": "...", "dataType": "...",
      "rawValue": "...", "normalizedValue": ..., "confidence": ... }
  ],
  "novel": [
    { "name": "...", "definition": "...", "rawValue": "...",
      "normalizedValue": ..., "dataType": "...", "confidence": ... }
  ]
}

**RULES:**
1. For known attributes: use the EXACT attributeId provided
2. For novel attributes: use consistent snake_case naming
3. Include a 1-sentence definition for EVERY novel attribute
4. Confidence 0.0-1.0 for each extraction
5. If same concept in known list, use known ID (don't re-report as novel)`;
  }

  /**
   * Build LLM user prompt with chunk content
   */
  private buildLLMUserPrompt(content: string): string {
    return `**Chunk Content:**
${content}

Extract applicable entities. Return JSON only.`;
  }

  /**
   * Parse LLM response
   * H14 fix: Use non-greedy regex to avoid matching across multiple JSON objects
   * H15 fix: Validate required fields on each parsed entity/novel object
   */
  private parseLLMResponse(response: string): {
    entities: Array<{
      attributeId: string;
      attributeName: string;
      dataType: string;
      rawValue: string;
      normalizedValue: string | number | boolean;
      confidence: number;
    }>;
    novel: Array<{
      name: string;
      definition: string;
      rawValue: string;
      normalizedValue: string | number | boolean;
      dataType: string;
      confidence: number;
    }>;
  } {
    // H14 fix: Extract the outermost balanced JSON object using brace counting.
    // The greedy /\{[\s\S]*\}/ would span across multiple JSON objects if
    // the LLM returned extra text after the closing brace (e.g., markdown fences).
    const jsonMatch = this.extractBalancedJson(response);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate response format
    if (!parsed.entities || !Array.isArray(parsed.entities)) {
      throw new Error('Invalid LLM response format: missing entities array');
    }

    // H15 fix: Filter out entities with missing required fields
    const entities = parsed.entities.filter(
      (e: Record<string, unknown>) =>
        typeof e.attributeId === 'string' &&
        e.attributeId.length > 0 &&
        typeof e.attributeName === 'string' &&
        typeof e.dataType === 'string' &&
        e.rawValue !== undefined &&
        e.normalizedValue !== undefined,
    );

    // Novel array is optional — older models may not return it
    const rawNovel = Array.isArray(parsed.novel) ? parsed.novel : [];

    // H15 fix: Filter out novel candidates with missing required fields
    const novel = rawNovel.filter(
      (n: Record<string, unknown>) =>
        typeof n.name === 'string' &&
        n.name.length > 0 &&
        typeof n.dataType === 'string' &&
        n.rawValue !== undefined &&
        n.normalizedValue !== undefined,
    );

    return { entities, novel };
  }

  /**
   * Extract the first balanced JSON object from a string.
   * Uses brace counting to handle nested objects correctly, unlike regex
   * which either matches too little (non-greedy) or too much (greedy).
   */
  private extractBalancedJson(text: string): RegExpMatchArray | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const match = text.slice(start, i + 1);
          // Return in RegExpMatchArray-like format for compatibility
          const result = [match] as unknown as RegExpMatchArray;
          result.index = start;
          result.input = text;
          return result;
        }
      }
    }

    return null; // Unbalanced braces
  }

  /**
   * Normalize value based on dataType
   */
  private normalizeValue(rawValue: string, dataType: string): string | number | boolean {
    switch (dataType) {
      case 'percentage': {
        // "2.5%" -> 0.025
        const pct = parseFloat(rawValue.replace('%', '')) / 100;
        return isNaN(pct) ? rawValue : pct;
      }

      case 'currency': {
        // "$1,234.56" -> 1234.56
        const cur = parseFloat(rawValue.replace(/[$,]/g, ''));
        return isNaN(cur) ? rawValue : cur;
      }

      case 'date': {
        // Parse as ISO date — explicit NaN check instead of exception control flow
        const d = new Date(rawValue);
        return isNaN(d.getTime()) ? rawValue : d.toISOString();
      }

      case 'duration':
        // "30 days" -> could normalize to days/months
        return rawValue;

      case 'number':
        // "1,234" -> 1234
        const num = parseFloat(rawValue.replace(/,/g, ''));
        return isNaN(num) ? rawValue : num;

      case 'identifier':
      case 'string':
      default:
        return rawValue.trim();
    }
  }
}
