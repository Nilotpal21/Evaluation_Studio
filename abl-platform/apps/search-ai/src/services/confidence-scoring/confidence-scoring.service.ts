/**
 * Confidence Scoring and Auto-Apply Service
 *
 * Takes merged MappingSuggestion arrays (from rule-based + LLM engines)
 * and applies threshold logic:
 *   - >= 0.8 confidence -> status 'active' (auto-confirmed by system)
 *   - 0.5 to 0.79      -> status 'suggested' (needs admin review)
 *   - < 0.5            -> filtered out (not stored)
 *
 * Creates FieldMapping documents in MongoDB via getLazyModel pattern.
 */

import { getLazyModel } from '../../db/index.js';
import type {
  IFieldMapping,
  IFieldTransform,
  ICanonicalSchema,
} from '@agent-platform/database/models';
import type { MappingSuggestion } from '../mapping-suggestion/mapping-suggestion.service.js';
import { getAvailableField, toCanonicalField } from '@agent-platform/search-ai-internal/canonical';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('confidence-scoring');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Suggestions at or above this threshold are auto-applied (status='active') */
export const AUTO_APPLY_THRESHOLD = 0.8;

/** Suggestions below this threshold are filtered out entirely */
export const MINIMUM_THRESHOLD = 0.5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProcessSuggestionsInput {
  suggestions: MappingSuggestion[];
  tenantId: string;
  canonicalSchemaId: string;
  connectorId: string;
  suggestedBy: 'rules' | 'llm';
}

export interface ProcessSuggestionsResult {
  autoApplied: IFieldMapping[];
  pending: IFieldMapping[];
  filteredCount: number;
}

interface ClassifiedSuggestions {
  autoApply: MappingSuggestion[];
  pendingReview: MappingSuggestion[];
  filtered: MappingSuggestion[];
}

// ─── Lazy Model ───────────────────────────────────────────────────────────────

const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');

// ─── Service ──────────────────────────────────────────────────────────────────

export class ConfidenceScoringService {
  /**
   * Process an array of mapping suggestions, applying confidence-based
   * auto-apply logic. High-confidence suggestions become active mappings;
   * medium-confidence ones are stored for admin review; low-confidence
   * ones are discarded.
   */
  async processSuggestions(input: ProcessSuggestionsInput): Promise<ProcessSuggestionsResult> {
    const { suggestions, tenantId, canonicalSchemaId, connectorId, suggestedBy } = input;

    // Handle empty input
    if (suggestions.length === 0) {
      logger.info('No suggestions to process', { tenantId, connectorId });
      return { autoApplied: [], pending: [], filteredCount: 0 };
    }

    // Step 1: Classify by confidence
    const classified = this.classifySuggestions(suggestions);

    logger.info('Suggestions classified by confidence', {
      tenantId,
      connectorId,
      autoApplyCount: classified.autoApply.length,
      pendingCount: classified.pendingReview.length,
      filteredCount: classified.filtered.length,
      totalCount: suggestions.length,
    });

    // Step 2: Create FieldMapping documents
    let autoApplied: IFieldMapping[] = [];
    let pending: IFieldMapping[] = [];

    try {
      if (classified.autoApply.length > 0) {
        autoApplied = await this.createMappingDocuments(classified.autoApply, {
          tenantId,
          canonicalSchemaId,
          connectorId,
          suggestedBy,
          status: 'active',
          reviewedBy: 'system',
          reviewedAt: new Date(),
        });
      }

      if (classified.pendingReview.length > 0) {
        pending = await this.createMappingDocuments(classified.pendingReview, {
          tenantId,
          canonicalSchemaId,
          connectorId,
          suggestedBy,
          status: 'suggested',
          reviewedBy: null,
          reviewedAt: null,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create field mapping documents', {
        tenantId,
        connectorId,
        canonicalSchemaId,
        error: errorMessage,
      });
      throw error;
    }

    // Step 3: Auto-grow CanonicalSchema with fields from created mappings
    const allSuggestions = [...classified.autoApply, ...classified.pendingReview];
    if (allSuggestions.length > 0) {
      await this.ensureCanonicalFields(canonicalSchemaId, tenantId, allSuggestions);
    }

    // Step 4: Emit trace event (log-based until TraceStore pattern established)
    this.emitTraceEvent({
      tenantId,
      connectorId,
      canonicalSchemaId,
      autoAppliedCount: autoApplied.length,
      pendingCount: pending.length,
      filteredCount: classified.filtered.length,
      suggestedBy,
    });

    logger.info('Confidence scoring complete', {
      tenantId,
      connectorId,
      autoAppliedCount: autoApplied.length,
      pendingCount: pending.length,
      filteredCount: classified.filtered.length,
    });

    return {
      autoApplied,
      pending,
      filteredCount: classified.filtered.length,
    };
  }

  /**
   * Classify suggestions into three buckets based on confidence score.
   */
  classifySuggestions(suggestions: MappingSuggestion[]): ClassifiedSuggestions {
    const autoApply: MappingSuggestion[] = [];
    const pendingReview: MappingSuggestion[] = [];
    const filtered: MappingSuggestion[] = [];

    for (const suggestion of suggestions) {
      if (suggestion.confidence >= AUTO_APPLY_THRESHOLD) {
        autoApply.push(suggestion);
      } else if (suggestion.confidence >= MINIMUM_THRESHOLD) {
        pendingReview.push(suggestion);
      } else {
        filtered.push(suggestion);
      }
    }

    return { autoApply, pendingReview, filtered };
  }

  /**
   * Create FieldMapping documents in MongoDB for a bucket of suggestions.
   */
  private async createMappingDocuments(
    suggestions: MappingSuggestion[],
    params: {
      tenantId: string;
      canonicalSchemaId: string;
      connectorId: string;
      suggestedBy: 'rules' | 'llm';
      status: 'active' | 'suggested';
      reviewedBy: string | null;
      reviewedAt: Date | null;
    },
  ): Promise<IFieldMapping[]> {
    const documents = suggestions.map((suggestion) => ({
      tenantId: params.tenantId,
      canonicalSchemaId: params.canonicalSchemaId,
      canonicalField: suggestion.canonicalField,
      connectorId: params.connectorId,
      sourcePath: suggestion.sourcePath,
      transform: suggestion.transform as IFieldTransform,
      confidence: suggestion.confidence,
      status: params.status,
      suggestedBy: params.suggestedBy,
      reviewedBy: params.reviewedBy,
      reviewedAt: params.reviewedAt,
    }));

    const created = await FieldMapping.insertMany(documents);
    return created as unknown as IFieldMapping[];
  }

  /**
   * Ensure that CanonicalSchema.fields contains entries for all mapped canonical fields.
   * This is the "auto-grow" pattern: the schema starts empty and grows as mappings are created.
   */
  private async ensureCanonicalFields(
    canonicalSchemaId: string,
    tenantId: string,
    suggestions: MappingSuggestion[],
  ): Promise<void> {
    // Collect unique canonical field names from suggestions
    const uniqueStorageFields = [...new Set(suggestions.map((s) => s.canonicalField))];

    // Look up each from the available fields constant and convert to ICanonicalField
    const fieldsToAdd = uniqueStorageFields
      .map((sf) => {
        const available = getAvailableField(sf);
        if (!available) {
          logger.warn('Unknown canonical field in mapping, skipping schema auto-grow', {
            storageField: sf,
            canonicalSchemaId,
          });
          return null;
        }
        const field = toCanonicalField(available);
        // Include alias info from suggestion if present
        const suggestion = suggestions.find((s) => s.canonicalField === sf);
        if (suggestion?.suggestedAlias) {
          field.name = suggestion.suggestedAlias;
        }
        if (suggestion?.suggestedLabel) {
          field.label = suggestion.suggestedLabel;
        }
        return field;
      })
      .filter((f) => f !== null);

    if (fieldsToAdd.length === 0) return;

    try {
      // Fetch current schema to check which fields already exist
      const schema = await CanonicalSchema.findOne({ _id: canonicalSchemaId, tenantId });
      if (!schema) {
        logger.warn('CanonicalSchema not found for auto-grow', { canonicalSchemaId, tenantId });
        return;
      }

      const existingStorageFields = new Set(schema.fields.map((f) => f.storageField));
      const newFields = fieldsToAdd.filter((f) => !existingStorageFields.has(f.storageField));

      if (newFields.length === 0) {
        logger.info('All canonical fields already exist in schema', {
          canonicalSchemaId,
          fieldCount: uniqueStorageFields.length,
        });
        return;
      }

      await CanonicalSchema.updateOne(
        { _id: canonicalSchemaId, tenantId },
        { $push: { fields: { $each: newFields } } },
      );

      logger.info('Auto-grew CanonicalSchema with new fields', {
        canonicalSchemaId,
        tenantId,
        addedFields: newFields.map((f) => f.storageField),
        addedCount: newFields.length,
      });
    } catch (error) {
      // Non-fatal: mappings are already created, schema will be eventually consistent
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to auto-grow CanonicalSchema', {
        canonicalSchemaId,
        tenantId,
        error: errorMessage,
      });
    }
  }

  /**
   * Emit a trace event for field mapping auto-apply.
   * Currently log-based; will be migrated to TraceStore when pattern is established.
   */
  private emitTraceEvent(data: {
    tenantId: string;
    connectorId: string;
    canonicalSchemaId: string;
    autoAppliedCount: number;
    pendingCount: number;
    filteredCount: number;
    suggestedBy: string;
  }): void {
    logger.info('TraceEvent: field_mapping_auto_applied', {
      event: 'field_mapping_auto_applied',
      tenantId: data.tenantId,
      connectorId: data.connectorId,
      canonicalSchemaId: data.canonicalSchemaId,
      autoAppliedCount: data.autoAppliedCount,
      pendingCount: data.pendingCount,
      filteredCount: data.filteredCount,
      suggestedBy: data.suggestedBy,
    });
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

export const confidenceScoringService = new ConfidenceScoringService();
