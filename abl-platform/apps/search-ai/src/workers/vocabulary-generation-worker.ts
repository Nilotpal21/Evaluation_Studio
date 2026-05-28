/**
 * Vocabulary Generation Worker — Epic 4, Story 4.4
 *
 * BullMQ worker that generates domain vocabulary for a knowledge base.
 *
 * Two-step pipeline:
 *   Step 1: Document Content Sampling — discover enum values from OpenSearch (optional, may have 0 docs)
 *   Step 2: LLM Generation — generate natural-language vocabulary from schema fields + connector type
 *
 * The LLM always runs (when available) because vocabulary must capture how users
 * *naturally speak* about fields, not just echo field names. Schema fields + connector
 * type give the LLM enough context to generate useful terms even before any documents
 * are ingested.
 *
 * WORKFLOW POSITION: After Field Mapping Suggestion completes
 *   Schema Discovery → Field Mapping → **Vocabulary Generation**
 */

import { Job, Worker } from 'bullmq';
import { WorkerLLMClient } from '@agent-platform/llm';
import { withTenantContext } from '@agent-platform/database/mongo';
import { uuidv7 } from '@agent-platform/database/mongo';
import { createLogger } from '@abl/compiler/platform';
import {
  getDocumentContentSampler,
  VocabularyEnrichmentService,
  type EnumCandidate,
} from '../services/vocabulary/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { PromptLoaderService } from '../services/prompts/prompt-loader.service.js';
import { createWorkerOptions, workerLog, workerError } from './shared.js';
import { getLazyModel } from '../db/index.js';
import type {
  ITermCandidate,
  ICanonicalSchema,
  ICanonicalField,
  IDomainVocabulary,
  IVocabularyEntry,
} from '@agent-platform/database/models';

const logger = createLogger('vocabulary-generation-worker');
const promptLoader = new PromptLoaderService();

// ─── Queue Name ──────────────────────────────────────────────────────────

export const VOCABULARY_GENERATION_QUEUE_NAME = 'vocabulary-generation';

// ─── Job Data ────────────────────────────────────────────────────────────

export interface VocabularyGenerationJobData {
  connectorId: string;
  projectKbId: string; // SearchIndex._id (legacy name, same as knowledgeBaseId)
  knowledgeBaseId?: string; // Alias for projectKbId (preferred in new code)
  tenantId: string;
  connectorType: string; // 'jira', 'salesforce', etc.
  indexId: string; // For LLM credential resolution
  /** Optional: limit vocab generation to these canonical field storageNames only.
   *  When set (e.g., from JSON upload), only the listed fields get vocabulary entries.
   *  When absent (connectors), all schema fields are processed. */
  fieldStorageNames?: string[];
}

// ─── Lazy Models ─────────────────────────────────────────────────────────

const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const DomainVocabularyModel = getLazyModel<IDomainVocabulary>('DomainVocabulary');

// ─── LLM Constants ───────────────────────────────────────────────────────

const LLM_TIMEOUT_MS = 300_000; // 5 minutes - increased from 2min for large schemas (78+ fields)
const LLM_MAX_TOKENS = 16_000; // Increased from 8k - 78 fields need ~16k tokens for complete JSON

// ─── Job Processor ───────────────────────────────────────────────────────

export async function processVocabularyGenerationJob(
  job: Job<VocabularyGenerationJobData>,
): Promise<void> {
  const { connectorId, projectKbId, tenantId, connectorType, indexId } = job.data;
  const knowledgeBaseId = job.data.knowledgeBaseId || projectKbId;

  workerLog('vocabulary-generation', 'Starting vocabulary generation', {
    jobId: job.id,
    connectorId,
    knowledgeBaseId,
    tenantId,
    connectorType,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      await job.updateProgress(10);

      // ── Step 1: Load CanonicalSchema fields (required) ──────────────
      const schema = await CanonicalSchemaModel.findOne({
        knowledgeBaseId,
        tenantId,
        status: 'active',
      })
        .sort({ version: -1 })
        .lean();

      if (!schema || !schema.fields?.length) {
        workerLog('vocabulary-generation', 'No schema fields found, cannot generate vocabulary', {
          knowledgeBaseId,
          hasSchema: !!schema,
        });
        await job.updateProgress(100);
        return;
      }

      // If fieldStorageNames is provided (e.g., from JSON upload), only process those fields
      const targetFields = job.data.fieldStorageNames
        ? schema.fields.filter(
            (f) =>
              job.data.fieldStorageNames!.includes(f.storageField) ||
              job.data.fieldStorageNames!.includes(f.name),
          )
        : schema.fields;

      workerLog('vocabulary-generation', 'Schema loaded', {
        totalFields: schema.fields.length,
        targetFields: targetFields.length,
        fields: targetFields.map((f) => f.storageField),
        filtered: !!job.data.fieldStorageNames,
      });

      if (targetFields.length === 0) {
        workerLog('vocabulary-generation', 'No target fields to process after filtering', {
          knowledgeBaseId,
          requestedFields: job.data.fieldStorageNames,
        });
        await job.updateProgress(100);
        return;
      }

      await job.updateProgress(20);

      // ── Step 2: Document Content Sampling (optional enrichment) ─────
      let enumCandidates: EnumCandidate[] = [];
      try {
        const sampler = getDocumentContentSampler();
        const samplingResult = await sampler.sampleEnumValues(knowledgeBaseId, tenantId);
        enumCandidates = samplingResult.candidates;
        workerLog('vocabulary-generation', 'Document sampling completed', {
          enumCandidateCount: enumCandidates.length,
          sampledDocCount: samplingResult.sampledDocCount,
          indexName: samplingResult.indexName,
        });
      } catch (error) {
        logger.warn('Document content sampling failed, continuing without enum context', {
          error: error instanceof Error ? error.message : String(error),
          knowledgeBaseId,
        });
      }

      await job.updateProgress(40);

      // ── Step 3: LLM Vocabulary Generation ──────────────────────────
      const llmClient = await createLLMClientForJob(tenantId, indexId);
      if (!llmClient) {
        workerLog(
          'vocabulary-generation',
          'No LLM available — cannot generate vocabulary. Configure LLM credentials for this index.',
          { knowledgeBaseId, tenantId, indexId },
        );
        await job.updateProgress(100);
        return;
      }

      const entries = await generateVocabularyFromSchema(
        targetFields,
        connectorType,
        enumCandidates,
        llmClient,
      );

      await job.updateProgress(80);

      if (entries.length === 0) {
        workerLog('vocabulary-generation', 'LLM returned no vocabulary entries', {
          knowledgeBaseId,
        });
        await job.updateProgress(100);
        return;
      }

      // ── Step 4: Persist to DomainVocabulary ────────────────────────
      await upsertVocabulary(tenantId, knowledgeBaseId, entries);

      await job.updateProgress(100);

      workerLog('vocabulary-generation', 'Vocabulary generation completed', {
        jobId: job.id,
        knowledgeBaseId,
        connectorType,
        entryCount: entries.length,
        enumCandidateCount: enumCandidates.length,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      workerError('vocabulary-generation', `Vocabulary generation failed: ${errMsg}`, error);
      throw error; // BullMQ retries based on job options
    }
  });
}

// ─── LLM Vocabulary Generation ──────────────────────────────────────────

/**
 * Generate vocabulary entries by sending schema fields to the LLM.
 * The LLM generates natural-language terms that map how users actually speak
 * about these fields in the context of the connector type.
 */
async function generateVocabularyFromSchema(
  fields: ICanonicalField[],
  connectorType: string,
  enumCandidates: EnumCandidate[],
  llmClient: WorkerLLMClient,
): Promise<IVocabularyEntry[]> {
  // Build enum lookup for additional context
  const enumLookup = new Map<string, EnumCandidate>();
  for (const ec of enumCandidates) {
    enumLookup.set(ec.storageField, ec);
  }

  // Build field descriptions for the prompt
  const fieldDescriptions = fields
    .map((field) => {
      const parts: string[] = [
        `Field: "${field.name || field.storageField}"`,
        `  Storage: ${field.storageField}`,
        `  Type: ${field.type}`,
        `  Label: ${field.label || '(none)'}`,
      ];

      // Include enum values if discovered from documents
      const enumCandidate = enumLookup.get(field.storageField);
      if (enumCandidate) {
        const topValues = enumCandidate.values
          .slice(0, 10)
          .map((v) => v.value)
          .join(', ');
        parts.push(`  Known Values: [${topValues}]`);
        parts.push(`  Cardinality: ${enumCandidate.cardinality}`);
      }

      if (field.enumValues && Object.keys(field.enumValues).length > 0) {
        const enumKeys = Object.keys(field.enumValues).slice(0, 10).join(', ');
        parts.push(`  Configured Enums: [${enumKeys}]`);
      }

      return parts.join('\n');
    })
    .join('\n\n');

  // Load and render prompt
  const promptDef = promptLoader.loadPrompt('vocabulary-generation', 1);
  const systemPrompt = promptLoader.renderPrompt(promptDef.system_prompt, { connectorType }).trim();
  const userMessage = promptLoader.renderPrompt(promptDef.user_prompt_template!, {
    fieldCount: String(fields.length),
    connectorType,
    fieldDescriptions,
  });

  workerLog('vocabulary-generation', 'Calling LLM for vocabulary generation', {
    fieldCount: fields.length,
    connectorType,
    enumContextCount: enumCandidates.length,
  });

  try {
    const response = await llmClient.chat(systemPrompt, [{ role: 'user', content: userMessage }], {
      maxTokens: LLM_MAX_TOKENS,
      timeoutMs: LLM_TIMEOUT_MS,
    });

    const rawEntries = parseVocabularyResponse(response);
    const validEntries = validateAndConvertEntries(rawEntries, fields);

    workerLog('vocabulary-generation', 'LLM vocabulary generation succeeded', {
      rawCount: rawEntries.length,
      validCount: validEntries.length,
    });

    return validEntries;
  } catch (error) {
    logger.error('LLM vocabulary generation failed', {
      error: error instanceof Error ? error.message : String(error),
      connectorType,
      fieldCount: fields.length,
    });
    return [];
  }
}

/**
 * Parse the LLM response into raw vocabulary entries.
 * Handles plain JSON arrays and markdown code fences.
 */
function parseVocabularyResponse(response: string): Array<{
  term: string;
  aliases: string[];
  fieldRef: string;
  description?: string;
  confidence?: number;
  priority?: number;
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
}> {
  try {
    const fencedMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    const jsonText = fencedMatch ? fencedMatch[1] : response;

    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger.warn('No JSON array found in LLM response', {
        responseLength: response.length,
        responsePreview: response.slice(0, 200),
      });
      return [];
    }

    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) {
      logger.warn('LLM response is not an array', { type: typeof parsed });
      return [];
    }

    return parsed;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Check if this looks like a truncation error (JSON error near end of response)
    if (errorMsg.includes('position') && response.length > 10000) {
      logger.error('LLM vocabulary response appears truncated (likely hit token limit)', {
        error: errorMsg,
        responseLength: response.length,
        suggestion: 'Increase LLM_MAX_TOKENS or batch fields into smaller groups',
      });
    } else {
      logger.error('Failed to parse LLM vocabulary response', {
        error: errorMsg,
        responseLength: response.length,
        responsePreview: response.slice(0, 200),
      });
    }
    return [];
  }
}

/**
 * Validate LLM-generated entries and convert to IVocabularyEntry format.
 * Rejects entries with missing required fields or invalid fieldRefs.
 */
function validateAndConvertEntries(
  rawEntries: Array<{
    term: string;
    aliases: string[];
    fieldRef: string;
    description?: string;
    confidence?: number;
    priority?: number;
    capabilities: {
      canFilter: boolean;
      canDisplay: boolean;
      canAggregate: boolean;
      canSort: boolean;
    };
    relatedFields: {
      displayWith: string[];
      aggregateWith: string[];
    };
  }>,
  schemaFields: ICanonicalField[],
): IVocabularyEntry[] {
  // Build valid fieldRef set from schema
  const validFieldRefs = new Set(
    schemaFields.flatMap((f) => [f.name, f.storageField].filter(Boolean)),
  );

  const validEntries: IVocabularyEntry[] = [];

  for (const raw of rawEntries) {
    if (!raw.term || typeof raw.term !== 'string') {
      logger.warn('Rejecting vocabulary entry: missing term', { raw });
      continue;
    }

    if (!raw.fieldRef || !validFieldRefs.has(raw.fieldRef)) {
      logger.warn('Rejecting vocabulary entry: invalid fieldRef', {
        term: raw.term,
        fieldRef: raw.fieldRef,
      });
      continue;
    }

    const cleanAliases = (raw.aliases || []).filter(
      (a): a is string => typeof a === 'string' && a.trim().length > 0,
    );

    if (cleanAliases.length === 0) {
      logger.warn('Rejecting vocabulary entry: no valid aliases', { term: raw.term });
      continue;
    }

    validEntries.push({
      id: uuidv7(),
      term: raw.term.toLowerCase().trim(),
      aliases: cleanAliases,
      description: raw.description,
      fieldRef: raw.fieldRef,
      capabilities: {
        canFilter: raw.capabilities?.canFilter ?? false,
        canDisplay: raw.capabilities?.canDisplay ?? true,
        canAggregate: raw.capabilities?.canAggregate ?? false,
        canSort: raw.capabilities?.canSort ?? false,
      },
      relatedFields: {
        displayWith: raw.relatedFields?.displayWith ?? [],
        aggregateWith: raw.relatedFields?.aggregateWith ?? [],
      },
      enabled: true,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.7,
      generatedBy: 'auto',
    });
  }

  return validEntries;
}

// ─── Vocabulary Persistence ──────────────────────────────────────────────

/**
 * Upsert vocabulary entries into DomainVocabulary.
 * Keeps manual entries, replaces auto-generated ones.
 */
async function upsertVocabulary(
  tenantId: string,
  knowledgeBaseId: string,
  entries: IVocabularyEntry[],
): Promise<void> {
  const existing = await DomainVocabularyModel.findOne({
    projectKnowledgeBaseId: knowledgeBaseId,
    tenantId,
    status: 'active',
  });

  if (existing) {
    const manualEntries = existing.entries.filter(
      (e: IVocabularyEntry) => e.generatedBy === 'manual',
    );
    const merged = [...manualEntries, ...entries];
    existing.entries = merged;
    existing.version += 1;
    existing.updatedAt = new Date();
    await existing.save();

    workerLog('vocabulary-generation', 'Updated vocabulary with LLM-generated entries', {
      knowledgeBaseId,
      vocabularyId: existing._id,
      generatedCount: entries.length,
      manualKept: manualEntries.length,
    });
  } else {
    await DomainVocabularyModel.create({
      tenantId,
      projectKnowledgeBaseId: knowledgeBaseId,
      version: 1,
      status: 'active',
      entries,
    });

    workerLog('vocabulary-generation', 'Created vocabulary with LLM-generated entries', {
      knowledgeBaseId,
      entryCount: entries.length,
    });
  }
}

// ─── LLM Client ─────────────────────────────────────────────────────────

/**
 * Create LLM client for this job using tenant-specific credentials.
 * Returns null if no credentials are available.
 */
async function createLLMClientForJob(
  tenantId: string,
  indexId: string,
): Promise<WorkerLLMClient | null> {
  const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
  const vocabConfig = llmConfig.useCases.vocabularyGeneration;

  if (!vocabConfig?.enabled) {
    logger.info('Vocabulary generation disabled for index', { tenantId, indexId });
    return null;
  }

  if (!vocabConfig.apiKey) {
    logger.warn('No LLM credentials available for vocabulary generation', {
      tenantId,
      indexId,
    });
    return null;
  }

  return new WorkerLLMClient(vocabConfig.provider, vocabConfig.apiKey, vocabConfig.model);
}

// ─── Worker Factory ──────────────────────────────────────────────────────

export function createVocabularyGenerationWorker(): Worker<VocabularyGenerationJobData> {
  const worker = new Worker<VocabularyGenerationJobData>(
    VOCABULARY_GENERATION_QUEUE_NAME,
    processVocabularyGenerationJob,
    createWorkerOptions(2), // Low concurrency: LLM-intensive
  );

  worker.on('completed', (job) => {
    workerLog('vocabulary-generation', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('vocabulary-generation', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('vocabulary-generation', 'Worker error', err);
  });

  workerLog('vocabulary-generation', `Started with concurrency=2`);
  return worker;
}
