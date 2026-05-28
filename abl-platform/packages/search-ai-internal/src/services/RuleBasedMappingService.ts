/**
 * Rule-Based Field Mapping Service
 *
 * Provides deterministic field mapping from discovered schema fields to canonical
 * schema fields using pattern matching, name normalization, and type checking.
 * Handles ~70% of common field patterns without LLM calls.
 *
 * This is a pure function service — no DB access, no BullMQ, no Express.
 * Story 2.9's worker calls this first, then passes unmapped fields to LLM (Story 2.2).
 *
 * Output format is compatible with MappingSuggestion from the LLM-based service
 * so both result sets can be merged by the worker.
 */

import type { Logger } from '@agent-platform/shared-observability';
import {
  getTemplateForConnector,
  getFixedMappings,
  matchFieldByPattern,
  type ConnectorTypeTemplate,
} from '../canonical/index.js';
import type { IDiscoveredSchemaField } from '@agent-platform/database/models';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Transform to apply during ingestion */
export interface RuleBasedTransform {
  type: 'direct' | 'value_map' | 'parse_date' | 'lowercase' | 'uppercase' | 'split' | 'join';
  valueMap?: Record<string, string>;
  delimiter?: string;
  sourceFormat?: string;
}

/** Result of rule-based field mapping — compatible with MappingSuggestion */
export interface RuleBasedMappingResult {
  /** Target canonical storage field name (e.g., "priority", "custom_string_1") */
  canonicalField: string;
  /** Source field path from discovered schema */
  sourcePath: string;
  /** Transform to apply during ingestion */
  transform: RuleBasedTransform;
  /** Confidence score: 1.0 exact, 0.9 normalized, 0.8 partial */
  confidence: number;
  /** Why this mapping was suggested */
  reasoning: string;
  /** Business-friendly alias name (e.g., "Created At") */
  suggestedAlias?: string;
  /** Display label (same as alias for now) */
  suggestedLabel?: string;
  /** Distinguishes from LLM results — maps to suggestedBy: 'rules' in FieldMapping model */
  mappingSource: 'rule-based';
}

/** Options for the generateMappings function */
export interface RuleBasedMappingOptions {
  fields: IDiscoveredSchemaField[];
  connectorType: string;
  logger?: Logger;
}

/** Statistics about the mapping run */
export interface RuleBasedMappingStats {
  totalFields: number;
  matchedCount: number;
  coveragePercent: number;
}

/** Match type from field matching */
type MatchType = 'exact' | 'normalized' | 'partial';

/** Internal match result before scoring */
interface FieldMatchResult {
  canonicalField: string;
  matchType: MatchType;
  confidence: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Confidence scores by match type */
const CONFIDENCE_EXACT = 1.0;
const CONFIDENCE_NORMALIZED = 0.9;
const CONFIDENCE_PARTIAL = 0.8;

/** Confidence reduction for compatible but non-exact type matches */
const TYPE_PENALTY = 0.1;

/** Common canonical fields prioritized over custom fields */
const COMMON_CANONICAL_FIELDS = [
  'title',
  'author',
  'content_summary',
  'status',
  'priority',
  'assignee',
  'description',
  'tags',
  'category',
  'source_url',
  'created_date',
  'modified_date',
  'mime_type',
];

/**
 * Fallback patterns for common fields not covered by connector-specific templates.
 * Canonical field name → source field name patterns.
 */
const COMMON_FIELD_PATTERNS: Record<string, string[]> = {
  title: ['title', 'name', 'subject', 'summary', 'headline'],
  created_date: [
    'created_at',
    'createdAt',
    'created',
    'createdDate',
    'dateCreated',
    'created_date',
    'createdDateTime',
  ],
  modified_date: [
    'updated_at',
    'updatedAt',
    'updated',
    'modifiedDate',
    'lastModified',
    'modified_date',
    'lastModifiedDateTime',
    'modifiedTime',
  ],
  author: ['author', 'creator', 'created_by', 'createdBy', 'owner'],
  content_summary: ['content', 'body', 'text', 'content_body', 'html_body'],
  status: ['status', 'state', 'stage'],
  priority: ['priority', 'urgency', 'importance'],
  assignee: ['assignee', 'assigned_to', 'assignedTo'],
  description: ['description', 'desc', 'details'],
  tags: ['tags', 'labels', 'keywords'],
  category: ['category', 'kind', 'class'],
  source_url: ['url', 'link', 'href', 'web_url', 'webUrl', 'source_url'],
  mime_type: ['mimeType', 'contentType', 'file_type', 'mime_type'],
};

/**
 * Type compatibility map: source type → compatible canonical types.
 * If a source type maps to the canonical type, the mapping is allowed.
 */
const TYPE_COMPATIBILITY: Record<string, string[]> = {
  string: ['string', 'text', 'date'],
  text: ['string', 'text'],
  number: ['number', 'float'],
  float: ['number', 'float'],
  integer: ['number', 'float'],
  date: ['date', 'string'],
  boolean: ['boolean'],
  array: ['array'],
  object: ['string'],
};

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a field name for comparison.
 * Lowercases, strips underscores/hyphens/dots, collapses whitespace.
 */
export function normalizeFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\-.\s]+/g, '')
    .trim();
}

/**
 * Convert a canonical field name to a human-readable alias.
 * E.g., "created_at" → "Created At", "content_body" → "Content Body"
 */
function humanizeFieldName(fieldName: string): string {
  return fieldName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ─── Type Checking ───────────────────────────────────────────────────────────

/**
 * Check if a source field type is compatible with a canonical field type.
 *
 * @returns true if types are compatible, false if incompatible
 */
export function isTypeCompatible(sourceType: string, canonicalFieldType: string): boolean {
  const srcLower = sourceType.toLowerCase();
  const canonLower = canonicalFieldType.toLowerCase();

  // Exact match is always compatible
  if (srcLower === canonLower) return true;

  const compatible = TYPE_COMPATIBILITY[srcLower];
  if (!compatible) {
    // Unknown source type — allow string-like mappings
    return canonLower === 'string' || canonLower === 'text';
  }

  return compatible.includes(canonLower);
}

/**
 * Check if the type match is exact (no penalty needed).
 */
function isExactTypeMatch(sourceType: string, canonicalFieldType: string): boolean {
  return sourceType.toLowerCase() === canonicalFieldType.toLowerCase();
}

/**
 * Return the confidence score for a match type.
 */
function confidenceForMatchType(matchType: MatchType): number {
  switch (matchType) {
    case 'exact':
      return CONFIDENCE_EXACT;
    case 'normalized':
      return CONFIDENCE_NORMALIZED;
    case 'partial':
      return CONFIDENCE_PARTIAL;
  }
}

/**
 * Classify whether a matchFieldByPattern hit was a truly case-exact match
 * or just a case-insensitive one (which we call "normalized").
 *
 * matchFieldByPattern does case-insensitive comparison. We check if any pattern
 * for the matched canonical field has an exact case-sensitive match with the source.
 */
function classifyTemplateMatch(
  sourceName: string,
  canonicalField: string,
  template: ConnectorTypeTemplate,
): MatchType {
  const patterns = template.fieldPatterns[canonicalField];
  if (!patterns) return 'normalized';

  for (const pattern of patterns) {
    // Check exact case-sensitive match
    if (sourceName === pattern) return 'exact';
    // Check dot-path suffix match (e.g., "assignee.displayName" ends with ".displayName")
    if (sourceName.endsWith(`.${pattern}`)) return 'exact';
  }

  // matchFieldByPattern matched case-insensitively but not case-exactly
  return 'normalized';
}

// ─── Field Matching ──────────────────────────────────────────────────────────

/**
 * Try to match a source field against a connector-type template and common patterns.
 *
 * Strategy:
 * 1. Use matchFieldByPattern() for template-based matching (handles exact + dot-path)
 * 2. Try normalized matching against template patterns
 * 3. Try partial matching against template patterns
 * 4. Fall back to common field patterns
 *
 * @returns Match result with canonical field and confidence, or null if no match
 */
export function matchField(
  sourceField: IDiscoveredSchemaField,
  template: ConnectorTypeTemplate,
): FieldMatchResult | null {
  const sourceName = sourceField.name;
  const sourcePath = sourceField.path;

  // 1. Template-based matching via matchFieldByPattern (case-insensitive).
  //    Determine match precision: truly case-exact or just case-insensitive.
  const templateMatch = matchFieldByPattern(sourceName, template);
  if (templateMatch) {
    const matchType = classifyTemplateMatch(sourceName, templateMatch, template);
    return {
      canonicalField: templateMatch,
      matchType,
      confidence: confidenceForMatchType(matchType),
    };
  }

  // Also try with source path (e.g., "fields.priority.name")
  if (sourcePath !== sourceName) {
    const pathMatch = matchFieldByPattern(sourcePath, template);
    if (pathMatch) {
      const matchType = classifyTemplateMatch(sourcePath, pathMatch, template);
      return {
        canonicalField: pathMatch,
        matchType,
        confidence: confidenceForMatchType(matchType),
      };
    }
  }

  // 2. Normalized matching against template patterns (catches separator differences)
  const normalizedSource = normalizeFieldName(sourceName);
  for (const [canonicalField, patterns] of Object.entries(template.fieldPatterns)) {
    for (const pattern of patterns) {
      if (normalizedSource === normalizeFieldName(pattern)) {
        // Already handled by matchFieldByPattern for case-insensitive —
        // this catches separator normalization (e.g., storyPoints vs story_points)
        return {
          canonicalField,
          matchType: 'normalized',
          confidence: CONFIDENCE_NORMALIZED,
        };
      }
    }
  }

  // 3. Partial matching against template patterns.
  //    Only match if the source field name ends with or equals the pattern
  //    (e.g., "lastModifiedDateTime" matches "modifiedTime" suffix).
  //    Substring containment is too aggressive (e.g., "mimeType" contains "type").
  for (const [canonicalField, patterns] of Object.entries(template.fieldPatterns)) {
    for (const pattern of patterns) {
      const normalizedPattern = normalizeFieldName(pattern);
      if (normalizedSource.length < 3 || normalizedPattern.length < 3) continue;
      // Only match if source ends with the pattern (suffix match)
      // or pattern ends with the source (reverse suffix match for short canonical names)
      if (
        normalizedSource.endsWith(normalizedPattern) ||
        (normalizedPattern.length > normalizedSource.length &&
          normalizedPattern.endsWith(normalizedSource))
      ) {
        return {
          canonicalField,
          matchType: 'partial',
          confidence: CONFIDENCE_PARTIAL,
        };
      }
    }
  }

  // 4. Fallback: common field patterns
  for (const [canonicalField, patterns] of Object.entries(COMMON_FIELD_PATTERNS)) {
    // Skip if template already has this canonical field (already tried above)
    if (template.fieldPatterns[canonicalField]) continue;

    for (const pattern of patterns) {
      const sourceLower = sourceName.toLowerCase();
      const patternLower = pattern.toLowerCase();

      if (sourceLower === patternLower) {
        const isCaseExact = sourceName === pattern;
        return {
          canonicalField,
          matchType: isCaseExact ? 'exact' : 'normalized',
          confidence: isCaseExact ? CONFIDENCE_EXACT : CONFIDENCE_NORMALIZED,
        };
      }
      if (normalizeFieldName(sourceName) === normalizeFieldName(pattern)) {
        return { canonicalField, matchType: 'normalized', confidence: CONFIDENCE_NORMALIZED };
      }
    }
  }

  return null;
}

// ─── Transform Generation ────────────────────────────────────────────────────

/**
 * Generate a transform object for a field mapping.
 *
 * - direct: exact type match, no transformation needed
 * - value_map: source has enumValues and template has enumPatterns for the canonical field
 * - parse_date: source is string but canonical field is date type
 */
function generateTransform(
  sourceField: IDiscoveredSchemaField,
  canonicalField: string,
  template: ConnectorTypeTemplate,
): RuleBasedTransform {
  // Check for enum value_map transform
  if (
    sourceField.enumValues &&
    sourceField.enumValues.length > 0 &&
    template.enumPatterns &&
    template.enumPatterns[canonicalField]
  ) {
    const enumPattern = template.enumPatterns[canonicalField];
    const valueMap: Record<string, string> = {};

    // Map source enum values to template canonical values
    for (const sourceValue of sourceField.enumValues) {
      const sourceLower = sourceValue.toLowerCase().replace(/[\s_-]+/g, '_');
      // Try exact match first
      const exactMatch = enumPattern.values.find((v) => v.toLowerCase() === sourceLower);
      if (exactMatch) {
        valueMap[sourceValue] = exactMatch;
        continue;
      }
      // Try normalized match
      const normalizedMatch = enumPattern.values.find(
        (v) => v.toLowerCase().replace(/[\s_-]+/g, '_') === sourceLower,
      );
      if (normalizedMatch) {
        valueMap[sourceValue] = normalizedMatch;
      }
    }

    if (Object.keys(valueMap).length > 0) {
      return { type: 'value_map', valueMap };
    }
  }

  // Check for date parsing transform
  const sourceTypeLower = sourceField.type.toLowerCase();
  if (
    (sourceTypeLower === 'string' || sourceTypeLower === 'text') &&
    isDateCanonicalField(canonicalField)
  ) {
    const transform: RuleBasedTransform = { type: 'parse_date' };
    if (sourceField.format) {
      transform.sourceFormat = sourceField.format;
    }
    return transform;
  }

  return { type: 'direct' };
}

/**
 * Check if a canonical field name is a date-type field.
 */
function isDateCanonicalField(canonicalField: string): boolean {
  const dateFields = [
    'created_at',
    'updated_at',
    'created_date',
    'modified_date',
    'due_date',
    'resolved_date',
    'reviewedAt',
  ];
  return dateFields.includes(canonicalField) || canonicalField.endsWith('_date');
}

// ─── Main Service ────────────────────────────────────────────────────────────

/**
 * Generate rule-based field mappings from discovered schema fields.
 *
 * For each discovered field, tries to match it against the connector-type template
 * and common canonical patterns. Assigns confidence scores, generates transforms,
 * de-duplicates (highest confidence wins), and prioritizes common fields.
 *
 * @param options - Fields, connector type, and optional logger
 * @returns Array of mapping results sorted by confidence (highest first)
 */
export function generateMappings(options: RuleBasedMappingOptions): RuleBasedMappingResult[] {
  const { fields, connectorType, logger } = options;
  const template = getTemplateForConnector(connectorType);

  logger?.info('Rule-based mapping started', {
    connectorType,
    templateCategory: template.category,
    fieldCount: fields.length,
  });

  if (fields.length === 0) {
    logger?.info('No fields to map', { connectorType });
    return [];
  }

  // ── Step 1: Apply fixed (deterministic) mappings ──────────────────────
  const fixedMappings = getFixedMappings(connectorType);
  const fixedByPath = new Map(fixedMappings.map((fm) => [fm.sourcePath, fm]));
  const candidates: RuleBasedMappingResult[] = [];
  const fixedPaths = new Set<string>();

  for (const field of fields) {
    const fixed = fixedByPath.get(field.path);
    if (fixed) {
      fixedPaths.add(field.path);
      const alias = humanizeFieldName(fixed.canonicalField);
      candidates.push({
        canonicalField: fixed.canonicalField,
        sourcePath: field.path,
        transform: { type: fixed.transform ?? 'direct' },
        confidence: 1.0,
        reasoning: `Fixed mapping for ${template.label}: "${field.path}" → "${fixed.canonicalField}"`,
        suggestedAlias: alias,
        suggestedLabel: alias,
        mappingSource: 'rule-based',
      });
    }
  }

  if (fixedPaths.size > 0) {
    logger?.info('Fixed mappings applied', {
      connectorType,
      fixedCount: fixedPaths.size,
      totalFields: fields.length,
    });
  }

  // ── Step 2: Rule-based matching for remaining fields ──────────────────
  const remainingFields = fields.filter((f) => !fixedPaths.has(f.path));

  for (const field of remainingFields) {
    try {
      const match = matchField(field, template);
      if (!match) continue;

      // Determine canonical field type for type checking
      // Use a sensible default — canonical fields are typically string/date/number
      const canonicalFieldType = inferCanonicalFieldType(match.canonicalField);
      const sourceType = field.type || 'string';

      // Skip if types are incompatible
      if (!isTypeCompatible(sourceType, canonicalFieldType)) {
        logger?.debug?.('Skipping incompatible type mapping', {
          sourcePath: field.path,
          sourceType,
          canonicalField: match.canonicalField,
          canonicalFieldType,
        });
        continue;
      }

      // Apply type penalty if not exact type match
      let confidence = match.confidence;
      if (!isExactTypeMatch(sourceType, canonicalFieldType)) {
        confidence = Math.max(0.1, confidence - TYPE_PENALTY);
      }

      // Generate transform
      const transform = generateTransform(field, match.canonicalField, template);

      // Generate alias and label
      const alias = humanizeFieldName(match.canonicalField);

      candidates.push({
        canonicalField: match.canonicalField,
        sourcePath: field.path,
        transform,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: buildReasoning(field, match.canonicalField, match.matchType, template),
        suggestedAlias: alias,
        suggestedLabel: alias,
        mappingSource: 'rule-based',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.warn('Failed to match field', {
        fieldName: field.name,
        fieldPath: field.path,
        error: errorMessage,
      });
    }
  }

  // De-duplicate: if multiple source fields match same canonical field, keep highest confidence
  const deduped = deduplicateMappings(candidates);

  // Sort by confidence descending, prioritizing common fields at equal confidence
  deduped.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const aCommon = COMMON_CANONICAL_FIELDS.includes(a.canonicalField) ? 1 : 0;
    const bCommon = COMMON_CANONICAL_FIELDS.includes(b.canonicalField) ? 1 : 0;
    return bCommon - aCommon;
  });

  // Log statistics
  const stats: RuleBasedMappingStats = {
    totalFields: fields.length,
    matchedCount: deduped.length,
    coveragePercent: fields.length > 0 ? Math.round((deduped.length / fields.length) * 100) : 0,
  };

  logger?.info('Rule-based mapping complete', {
    connectorType,
    templateCategory: template.category,
    ...stats,
  });

  return deduped;
}

/**
 * De-duplicate mappings: when multiple source fields match the same canonical field,
 * keep only the highest-confidence match.
 */
function deduplicateMappings(candidates: RuleBasedMappingResult[]): RuleBasedMappingResult[] {
  const bestByCanonical = new Map<string, RuleBasedMappingResult>();

  for (const candidate of candidates) {
    const existing = bestByCanonical.get(candidate.canonicalField);
    if (!existing || candidate.confidence > existing.confidence) {
      bestByCanonical.set(candidate.canonicalField, candidate);
    }
  }

  return Array.from(bestByCanonical.values());
}

/**
 * Infer the expected type for a canonical field based on its name.
 * This is a heuristic since we don't have the full canonical schema here.
 */
function inferCanonicalFieldType(canonicalField: string): string {
  if (isDateCanonicalField(canonicalField)) return 'date';
  if (canonicalField === 'comment_count' || canonicalField === 'attachment_count') return 'number';
  if (canonicalField === 'story_points' || canonicalField === 'deal_amount') return 'number';
  if (canonicalField === 'is_archived') return 'boolean';
  if (canonicalField === 'tags') return 'array';
  if (canonicalField === 'version') return 'number';
  return 'string';
}

/**
 * Build a human-readable reasoning string for why this mapping was suggested.
 */
function buildReasoning(
  field: IDiscoveredSchemaField,
  canonicalField: string,
  matchType: MatchType,
  template: ConnectorTypeTemplate,
): string {
  const matchDesc =
    matchType === 'exact'
      ? 'exact name match'
      : matchType === 'normalized'
        ? 'normalized name match (case/separator insensitive)'
        : 'partial name match';

  const templateInfo =
    template.category !== 'generic'
      ? ` using ${template.label} template`
      : ' using generic patterns';

  return `Rule-based ${matchDesc}${templateInfo}: "${field.name}" → "${canonicalField}"`;
}
