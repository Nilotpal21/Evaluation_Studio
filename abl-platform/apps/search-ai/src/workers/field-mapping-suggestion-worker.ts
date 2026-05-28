/**
 * Field Mapping Suggestion Worker
 *
 * BullMQ worker that orchestrates field mapping suggestions after schema discovery.
 * Runs: RuleBasedMappingService -> MappingSuggestionService (LLM) -> ConfidenceScoringService.
 *
 * WORKFLOW POSITION: Step 3 of Connector Configuration
 *   Schema Sync -> Schema Discovery -> **Field Mapping Suggestion** -> Vocabulary Generation (Epic 4)
 *
 * DESIGN TIME: This worker runs ONCE per connector activation (not per document/query).
 */

import { Worker, type Job } from 'bullmq';
import { QUEUE_FIELD_MAPPING_SUGGESTION } from '@agent-platform/search-ai-sdk';
import { withTenantContext } from '@agent-platform/database/mongo';
import type {
  IDiscoveredSchema,
  IDiscoveredSchemaField,
  ICanonicalSchema,
  ICanonicalField,
  IFieldMapping,
  IConnectorSchemaField,
} from '@agent-platform/database/models';
import {
  generateMappings,
  type RuleBasedMappingResult,
} from '@agent-platform/search-ai-internal/services';
import {
  getAvailableFieldsForLLM,
  getAvailableField,
  toCanonicalField,
} from '@agent-platform/search-ai-internal/canonical';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';
import { createWorkerOptions, createQueue, workerLog, workerError } from './shared.js';
import { VOCABULARY_GENERATION_QUEUE_NAME } from './vocabulary-generation-worker.js';
import type { VocabularyGenerationJobData } from './vocabulary-generation-worker.js';
import {
  mappingSuggestionService,
  type MappingSuggestion,
} from '../services/mapping-suggestion/index.js';
import { confidenceScoringService } from '../services/confidence-scoring/index.js';

const logger = createLogger('field-mapping-suggestion-worker');

const DiscoveredSchemaModel = getLazyModel<IDiscoveredSchema>('DiscoveredSchema');
const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const FieldMappingModel = getLazyModel<IFieldMapping>('FieldMapping');

// ─── Job Data ────────────────────────────────────────────────────────────────

export interface FieldMappingSuggestionJobData {
  tenantId: string;
  connectorId: string;
  knowledgeBaseId: string;
  discoveredSchemaId: string;
  indexId: string;
  connectorType: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert RuleBasedMappingResult to MappingSuggestion format
 * so it can be passed to ConfidenceScoringService.
 */
function toMappingSuggestion(result: RuleBasedMappingResult): MappingSuggestion {
  return {
    canonicalField: result.canonicalField,
    sourcePath: result.sourcePath,
    transform: result.transform,
    confidence: result.confidence,
    reasoning: result.reasoning,
    suggestedAlias: result.suggestedAlias,
    suggestedLabel: result.suggestedLabel,
  };
}

/**
 * Adapt IDiscoveredSchemaField to IConnectorSchemaField for MappingSuggestionService.
 */
function toConnectorSchemaField(field: IDiscoveredSchemaField): IConnectorSchemaField {
  return {
    path: field.path,
    label: field.name,
    type: field.type,
    isCustom: false,
    isRequired: field.required ?? false,
    enumValues: field.enumValues,
  };
}

// ─── Job Processor ───────────────────────────────────────────────────────────

export async function processFieldMappingSuggestionJob(
  job: Job<FieldMappingSuggestionJobData>,
): Promise<void> {
  const { tenantId, connectorId, knowledgeBaseId, discoveredSchemaId, indexId, connectorType } =
    job.data;

  workerLog('field-mapping-suggestion', 'Starting field mapping suggestion', {
    connectorId,
    tenantId,
    knowledgeBaseId,
    discoveredSchemaId,
    connectorType,
    jobId: job.id,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      // ── Step 1: Fetch DiscoveredSchema ──────────────────────────────────
      const discoveredSchema = await DiscoveredSchemaModel.findOne({
        _id: discoveredSchemaId,
        tenantId,
      });

      if (!discoveredSchema) {
        throw new Error(`DiscoveredSchema not found: ${discoveredSchemaId} for tenant ${tenantId}`);
      }

      await job.updateProgress(10);

      // ── Step 2: Fetch or auto-create CanonicalSchema ──────────────────
      let canonicalSchema = await CanonicalSchemaModel.findOne({
        knowledgeBaseId,
        tenantId,
        status: 'active',
      });

      if (!canonicalSchema) {
        // Auto-create empty schema — fields are added when mappings are confirmed
        canonicalSchema = await CanonicalSchemaModel.create({
          tenantId,
          knowledgeBaseId,
          version: 1,
          fields: [],
          status: 'active',
        });
        workerLog('field-mapping-suggestion', 'Auto-created empty CanonicalSchema', {
          canonicalSchemaId: canonicalSchema._id,
          knowledgeBaseId,
          tenantId,
        });
      }

      await job.updateProgress(20);

      // ── Step 3: Fetch existing FieldMappings ────────────────────────────
      const existingMappings = await FieldMappingModel.find({
        canonicalSchemaId: canonicalSchema._id,
        connectorId,
        tenantId,
      }).lean();

      const existingSourcePaths = new Set(existingMappings.map((m) => m.sourcePath));

      // Filter out fields that already have mappings
      const unmappedDiscoveredFields = discoveredSchema.fields.filter(
        (f) => !existingSourcePaths.has(f.path),
      );

      if (unmappedDiscoveredFields.length === 0) {
        workerLog('field-mapping-suggestion', 'All fields already mapped, skipping', {
          connectorId,
          tenantId,
          existingMappingCount: existingMappings.length,
        });
        await job.updateProgress(100);
        return;
      }

      workerLog('field-mapping-suggestion', 'Fields to process', {
        totalDiscovered: discoveredSchema.fields.length,
        alreadyMapped: existingMappings.length,
        unmapped: unmappedDiscoveredFields.length,
      });

      await job.updateProgress(25);

      // ── Step 4: Rule-Based Mapping ──────────────────────────────────────
      const ruleResults = generateMappings({
        fields: unmappedDiscoveredFields,
        connectorType,
        logger,
      });

      workerLog('field-mapping-suggestion', 'Rule-based mapping completed', {
        ruleMatchCount: ruleResults.length,
        unmappedFieldCount: unmappedDiscoveredFields.length,
      });

      await job.updateProgress(50);

      // ── Step 5: Determine fields still unmapped after rules ─────────────
      const ruleSourcePaths = new Set(ruleResults.map((r) => r.sourcePath));
      const fieldsForLLM = unmappedDiscoveredFields.filter((f) => !ruleSourcePaths.has(f.path));

      // ── Step 6: LLM Mapping (only for fields not covered by rules) ─────
      let llmSuggestions: MappingSuggestion[] = [];

      if (fieldsForLLM.length > 0) {
        workerLog('field-mapping-suggestion', 'Calling LLM for remaining unmapped fields', {
          llmFieldCount: fieldsForLLM.length,
        });

        try {
          // Use the full available field list so LLM can map to any canonical slot,
          // not just fields already configured in this KB's schema.
          const availableFields = getAvailableFieldsForLLM();
          const llmResponse = await mappingSuggestionService.suggestMappings(tenantId, indexId, {
            sourceFields: fieldsForLLM.map(toConnectorSchemaField),
            canonicalFields: availableFields,
            connectorType,
            existingMappings,
          });

          llmSuggestions = llmResponse.suggestions;

          workerLog('field-mapping-suggestion', 'LLM mapping completed', {
            llmSuggestionCount: llmSuggestions.length,
            averageConfidence: llmResponse.averageConfidence,
            processingTimeMs: llmResponse.processingTimeMs,
          });
        } catch (error: unknown) {
          // Graceful degradation: LLM failure is not fatal, continue with rule-based only
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn('LLM mapping failed, continuing with rule-based results only', {
            error: errMsg,
            tenantId,
            connectorId,
          });
        }
      } else {
        workerLog('field-mapping-suggestion', 'Rules covered all fields, skipping LLM', {
          ruleMatchCount: ruleResults.length,
        });
      }

      await job.updateProgress(75);

      // ── Step 7: De-duplicate (rule-based wins on conflict) ──────────────
      const uniqueLLMSuggestions = llmSuggestions.filter((s) => !ruleSourcePaths.has(s.sourcePath));

      // ── Step 8: Confidence Scoring + Persist ────────────────────────────
      const ruleSuggestions = ruleResults.map(toMappingSuggestion);

      const ruleResult = await confidenceScoringService.processSuggestions({
        suggestions: ruleSuggestions,
        tenantId,
        canonicalSchemaId: canonicalSchema._id,
        connectorId,
        suggestedBy: 'rules',
      });

      const llmResult = await confidenceScoringService.processSuggestions({
        suggestions: uniqueLLMSuggestions,
        tenantId,
        canonicalSchemaId: canonicalSchema._id,
        connectorId,
        suggestedBy: 'llm',
      });

      await job.updateProgress(95);

      // ── Step 9: Log completion summary ──────────────────────────────────
      const totalAutoApplied = ruleResult.autoApplied.length + llmResult.autoApplied.length;
      const totalPending = ruleResult.pending.length + llmResult.pending.length;
      const totalFiltered = ruleResult.filteredCount + llmResult.filteredCount;

      // Enqueue VocabularyGenerationWorker for auto-applied mappings
      if (totalAutoApplied > 0) {
        const vocabQueue = createQueue(VOCABULARY_GENERATION_QUEUE_NAME);
        try {
          await vocabQueue.add(`vocab-gen:${connectorId}`, {
            connectorId,
            projectKbId: knowledgeBaseId,
            knowledgeBaseId,
            tenantId,
            connectorType,
            indexId,
          } satisfies VocabularyGenerationJobData);
          workerLog('field-mapping-suggestion', 'Enqueued vocabulary generation', {
            autoAppliedCount: totalAutoApplied,
            knowledgeBaseId,
            connectorId,
          });
        } finally {
          await vocabQueue.close();
        }
      }

      await job.updateProgress(100);

      workerLog('field-mapping-suggestion', 'Field mapping suggestion completed', {
        connectorId,
        tenantId,
        knowledgeBaseId,
        jobId: job.id,
        ruleBasedMappings: ruleResults.length,
        llmMappings: uniqueLLMSuggestions.length,
        autoApplied: totalAutoApplied,
        pendingReview: totalPending,
        filtered: totalFiltered,
        ruleAutoApplied: ruleResult.autoApplied.length,
        rulePending: ruleResult.pending.length,
        llmAutoApplied: llmResult.autoApplied.length,
        llmPending: llmResult.pending.length,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      workerError('field-mapping-suggestion', `Field mapping suggestion failed: ${errMsg}`, error);
      throw error; // BullMQ retries based on job options
    }
  });
}

// ─── Worker Factory ──────────────────────────────────────────────────────────

export default function createFieldMappingSuggestionWorker(
  concurrency = 2,
): Worker<FieldMappingSuggestionJobData> {
  const worker = new Worker<FieldMappingSuggestionJobData>(
    QUEUE_FIELD_MAPPING_SUGGESTION,
    processFieldMappingSuggestionJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('field-mapping-suggestion', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('field-mapping-suggestion', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('field-mapping-suggestion', 'Worker error', err);
  });

  workerLog('field-mapping-suggestion', `Started with concurrency=${concurrency}`);
  return worker;
}
