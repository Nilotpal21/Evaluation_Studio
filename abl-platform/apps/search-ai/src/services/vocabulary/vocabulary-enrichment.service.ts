/**
 * Vocabulary Enrichment Service — Story 4.3
 *
 * Takes term candidates (Story 4.1) and enum candidates (Story 4.2),
 * sends them to an LLM in batches for enrichment, and stores the
 * resulting IVocabularyEntry[] in the DomainVocabulary collection.
 *
 * KEY FEATURES:
 * - Batch size: 50 terms per LLM call (cost-efficient)
 * - In-process circuit breaker: opens after 3 consecutive failures
 * - Exponential backoff retry: 3 attempts, 1s base, 10s max
 * - Token usage tracking for cost monitoring
 * - Graceful degradation: returns partial results on LLM failure
 * - Tenant-isolated: every DB query scoped to tenantId
 */

import type { WorkerLLMClient } from '@agent-platform/llm';
import type { IDomainVocabulary, IVocabularyEntry } from '@agent-platform/database';
import type { ITermCandidate } from '@agent-platform/database/models';
import { uuidv7 } from '@agent-platform/database/mongo';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../../db/index.js';
import type { EnumCandidate } from './types.js';
import { PromptLoaderService } from '../prompts/prompt-loader.service.js';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');

const logger = createLogger('vocabulary-enrichment');

const promptLoader = new PromptLoaderService();

// ─── Constants ────────────────────────────────────────────────────────────

/** Maximum terms sent in a single LLM call */
const BATCH_SIZE = 50;

/** Circuit breaker: consecutive failures before opening */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

/** Circuit breaker: time (ms) before transitioning OPEN -> HALF_OPEN */
const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 60_000;

/** Retry: maximum attempts per LLM call */
const MAX_RETRY_ATTEMPTS = 3;

/** Retry: base delay in ms (doubled each attempt) */
const RETRY_BASE_DELAY_MS = 1_000;

/** Retry: maximum delay cap in ms */
const RETRY_MAX_DELAY_MS = 10_000;

/** LLM call timeout */
const LLM_TIMEOUT_MS = 120_000;

/** Max tokens per LLM response */
const LLM_MAX_TOKENS = 4_000;

// ─── Types ────────────────────────────────────────────────────────────────

export interface EnrichmentOptions {
  tenantId: string;
  knowledgeBaseId: string; // SearchIndex._id / projectKnowledgeBaseId
  connectorType: string; // e.g., 'jira', 'salesforce'
  termCandidates: ITermCandidate[];
  enumCandidates: EnumCandidate[];
  llmClient: WorkerLLMClient;
}

export interface EnrichmentResult {
  entries: IVocabularyEntry[];
  totalTerms: number;
  enrichedCount: number;
  failedCount: number;
  skippedCount: number;
  tokenUsage: {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
  };
  circuitBreakerTripped: boolean;
}

interface LLMEnrichedEntry {
  term: string;
  aliases: string[];
  fieldRef: string;
  description?: string;
  confidence?: number;
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
}

// ─── Circuit Breaker (in-process) ─────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class InProcessCircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(failureThreshold: number, resetTimeoutMs: number) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  canExecute(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow one request through
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  isOpen(): boolean {
    return this.state === 'OPEN';
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ─── Service ──────────────────────────────────────────────────────────────

export class VocabularyEnrichmentService {
  /**
   * Enrich term candidates using an LLM and store results in DomainVocabulary.
   *
   * Steps:
   * 1. Build enum lookup map for field context
   * 2. Split terms into batches of BATCH_SIZE
   * 3. Send each batch to LLM with structured prompt
   * 4. Parse and validate LLM responses
   * 5. Upsert enriched entries into DomainVocabulary
   */
  async enrichTerms(options: EnrichmentOptions): Promise<EnrichmentResult> {
    const { tenantId, knowledgeBaseId, connectorType, termCandidates, enumCandidates, llmClient } =
      options;

    logger.info('Starting vocabulary enrichment', {
      tenantId,
      knowledgeBaseId,
      connectorType,
      termCount: termCandidates.length,
      enumCandidateCount: enumCandidates.length,
    });

    // Build enum lookup: storageField -> EnumCandidate
    const enumLookup = new Map<string, EnumCandidate>();
    for (const ec of enumCandidates) {
      enumLookup.set(ec.storageField, ec);
      if (ec.alias) {
        enumLookup.set(ec.alias, ec);
      }
    }

    // Split into batches
    const batches = this.createBatches(termCandidates, BATCH_SIZE);

    const circuitBreaker = new InProcessCircuitBreaker(
      CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    );

    const allEntries: IVocabularyEntry[] = [];
    let failedCount = 0;
    let skippedCount = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      if (!circuitBreaker.canExecute()) {
        logger.warn('Circuit breaker open, skipping remaining batches', {
          batchIdx,
          totalBatches: batches.length,
          skippedTerms: batch.length,
        });
        skippedCount += batch.length;
        continue;
      }

      try {
        const { entries, inputTokens, outputTokens } = await this.enrichBatchWithRetry(
          batch,
          enumLookup,
          connectorType,
          llmClient,
          circuitBreaker,
        );

        estimatedInputTokens += inputTokens;
        estimatedOutputTokens += outputTokens;

        allEntries.push(...entries);

        logger.info('Batch enrichment completed', {
          batchIdx,
          batchSize: batch.length,
          enrichedCount: entries.length,
        });
      } catch (error) {
        logger.error('Batch enrichment failed after retries', {
          batchIdx,
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
        failedCount += batch.length;
      }
    }

    // Store enriched entries in DomainVocabulary
    if (allEntries.length > 0) {
      await this.upsertVocabulary(tenantId, knowledgeBaseId, allEntries);
    }

    const result: EnrichmentResult = {
      entries: allEntries,
      totalTerms: termCandidates.length,
      enrichedCount: allEntries.length,
      failedCount,
      skippedCount,
      tokenUsage: {
        estimatedInputTokens,
        estimatedOutputTokens,
      },
      circuitBreakerTripped: circuitBreaker.isOpen(),
    };

    logger.info('Vocabulary enrichment completed', {
      tenantId,
      knowledgeBaseId,
      enrichedCount: result.enrichedCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      circuitBreakerTripped: result.circuitBreakerTripped,
      estimatedInputTokens,
      estimatedOutputTokens,
    });

    return result;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /** Split an array into fixed-size batches. */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Enrich a single batch with retry + exponential backoff.
   * Records success/failure on the circuit breaker.
   */
  private async enrichBatchWithRetry(
    batch: ITermCandidate[],
    enumLookup: Map<string, EnumCandidate>,
    connectorType: string,
    llmClient: WorkerLLMClient,
    circuitBreaker: InProcessCircuitBreaker,
  ): Promise<{ entries: IVocabularyEntry[]; inputTokens: number; outputTokens: number }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        logger.info('Retrying batch after delay', {
          attempt,
          delayMs: delay,
        });
        await this.sleep(delay);
      }

      if (!circuitBreaker.canExecute()) {
        throw new Error('Circuit breaker is open');
      }

      try {
        const result = await this.enrichBatch(batch, enumLookup, connectorType, llmClient);
        circuitBreaker.recordSuccess();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        circuitBreaker.recordFailure();

        logger.warn('LLM call failed', {
          attempt: attempt + 1,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          error: lastError.message,
          circuitState: circuitBreaker.getState(),
        });

        if (circuitBreaker.isOpen()) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error('Batch enrichment failed after all retries');
  }

  /** Send a single batch of terms to the LLM and parse the response. */
  private async enrichBatch(
    batch: ITermCandidate[],
    enumLookup: Map<string, EnumCandidate>,
    connectorType: string,
    llmClient: WorkerLLMClient,
  ): Promise<{ entries: IVocabularyEntry[]; inputTokens: number; outputTokens: number }> {
    const systemPrompt = this.buildSystemPrompt(connectorType);
    const userMessage = this.buildUserMessage(batch, enumLookup);

    // Estimate input tokens (~4 chars per token)
    const inputTokens = Math.ceil((systemPrompt.length + userMessage.length) / 4);

    const response = await llmClient.chat(systemPrompt, [{ role: 'user', content: userMessage }], {
      maxTokens: LLM_MAX_TOKENS,
      timeoutMs: LLM_TIMEOUT_MS,
    });

    // Estimate output tokens
    const outputTokens = Math.ceil(response.length / 4);

    // Parse and validate
    const rawEntries = this.parseResponse(response);
    const validEntries = this.validateAndConvert(rawEntries, batch);

    return { entries: validEntries, inputTokens, outputTokens };
  }

  /** Build the system prompt for vocabulary enrichment. */
  private buildSystemPrompt(connectorType: string): string {
    const promptDef = promptLoader.loadPrompt('vocabulary-enrichment', 1);
    return promptLoader.renderPrompt(promptDef.system_prompt, { connectorType }).trim();
  }

  /** Build the user message containing the batch of terms to enrich. */
  private buildUserMessage(
    batch: ITermCandidate[],
    enumLookup: Map<string, EnumCandidate>,
  ): string {
    const termDescriptions = batch
      .map((candidate) => {
        const parts: string[] = [
          `Term: "${candidate.term}"`,
          `Frequency: ${candidate.frequency} occurrences in ${candidate.queryCount} queries`,
        ];

        if (candidate.fieldAffinity) {
          parts.push(`Field Affinity: ${candidate.fieldAffinity}`);

          // Include enum values if this field has them
          const enumCandidate =
            enumLookup.get(candidate.fieldAffinity) || enumLookup.get(candidate.term);
          if (enumCandidate) {
            const topValues = enumCandidate.values
              .slice(0, 10)
              .map((v) => v.value)
              .join(', ');
            parts.push(`Known Values: [${topValues}]`);
            parts.push(`Cardinality: ${enumCandidate.cardinality}`);
          }
        }

        if (candidate.coOccurrences.length > 0) {
          const topCoOccurrences = candidate.coOccurrences
            .slice(0, 5)
            .map((c) => c.term)
            .join(', ');
          parts.push(`Co-occurs with: ${topCoOccurrences}`);
        }

        if (candidate.sampleQueries.length > 0) {
          const samples = candidate.sampleQueries.slice(0, 3).join('" | "');
          parts.push(`Sample Queries: "${samples}"`);
        }

        return parts.join('\n  ');
      })
      .join('\n\n');

    const promptDef = promptLoader.loadPrompt('vocabulary-enrichment', 1);
    return promptLoader.renderPrompt(promptDef.user_prompt_template!, {
      termCount: String(batch.length),
      termDescriptions,
    });
  }

  /**
   * Parse the LLM response into raw enriched entries.
   * Handles plain JSON arrays and markdown code fences.
   */
  private parseResponse(response: string): LLMEnrichedEntry[] {
    try {
      // Try extracting from markdown code fence first
      const fencedMatch = response.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
      const jsonText = fencedMatch ? fencedMatch[1] : response;

      // Find the JSON array in the text
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

      return parsed as LLMEnrichedEntry[];
    } catch (error) {
      logger.error('Failed to parse LLM response', {
        error: error instanceof Error ? error.message : String(error),
        responseLength: response.length,
        responsePreview: response.slice(0, 200),
      });
      return [];
    }
  }

  /**
   * Validate parsed entries and convert to IVocabularyEntry format.
   * Rejects entries with missing term or empty aliases.
   */
  private validateAndConvert(
    rawEntries: LLMEnrichedEntry[],
    originalBatch: ITermCandidate[],
  ): IVocabularyEntry[] {
    const validEntries: IVocabularyEntry[] = [];

    // Build a set of original terms for cross-referencing
    const originalTerms = new Set(originalBatch.map((t) => t.term.toLowerCase()));

    for (const raw of rawEntries) {
      // Validate required fields
      if (!raw.term || typeof raw.term !== 'string') {
        logger.warn('Rejecting entry: missing or invalid term', { raw });
        continue;
      }

      if (!Array.isArray(raw.aliases) || raw.aliases.length === 0) {
        logger.warn('Rejecting entry: empty or missing aliases', { term: raw.term });
        continue;
      }

      // Filter out non-string aliases
      const cleanAliases = raw.aliases.filter(
        (a): a is string => typeof a === 'string' && a.trim().length > 0,
      );
      if (cleanAliases.length === 0) {
        logger.warn('Rejecting entry: all aliases are empty after cleaning', { term: raw.term });
        continue;
      }

      // Verify the term relates to our input (fuzzy match — allow LLM reformulation)
      const termLower = raw.term.toLowerCase();
      const isRelated =
        originalTerms.has(termLower) ||
        [...originalTerms].some((ot) => termLower.includes(ot) || ot.includes(termLower));

      if (!isRelated) {
        logger.warn('Rejecting entry: term does not match any input candidate', {
          term: raw.term,
        });
        continue;
      }

      validEntries.push({
        id: uuidv7(),
        term: raw.term,
        aliases: cleanAliases,
        description: raw.description,
        fieldRef: raw.fieldRef || raw.term,
        capabilities: {
          canFilter: raw.capabilities?.canFilter ?? true,
          canDisplay: raw.capabilities?.canDisplay ?? true,
          canAggregate: raw.capabilities?.canAggregate ?? false,
          canSort: raw.capabilities?.canSort ?? false,
        },
        relatedFields: {
          displayWith: raw.relatedFields?.displayWith ?? [],
          aggregateWith: raw.relatedFields?.aggregateWith ?? [],
        },
        enabled: true,
        confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
        generatedBy: 'auto',
      });
    }

    return validEntries;
  }

  /**
   * Upsert enriched entries into the DomainVocabulary collection.
   * Merges with existing entries (does not overwrite manual entries).
   */
  private async upsertVocabulary(
    tenantId: string,
    knowledgeBaseId: string,
    entries: IVocabularyEntry[],
  ): Promise<void> {
    const existing = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: knowledgeBaseId,
      tenantId,
      status: 'active',
    });

    if (existing) {
      // Merge: keep manual entries, replace/add auto entries
      const manualEntries = existing.entries.filter(
        (e: IVocabularyEntry) => e.generatedBy === 'manual',
      );

      // New auto entries replace old auto entries with the same term
      const newAutoByTerm = new Map<string, IVocabularyEntry>();
      for (const entry of entries) {
        newAutoByTerm.set(entry.term.toLowerCase(), entry);
      }

      // Keep old auto entries that aren't being replaced
      const keptAutoEntries = existing.entries.filter(
        (e: IVocabularyEntry) =>
          e.generatedBy === 'auto' && !newAutoByTerm.has(e.term.toLowerCase()),
      );

      const mergedEntries = [...manualEntries, ...keptAutoEntries, ...entries];

      existing.entries = mergedEntries;
      existing.version += 1;
      existing.updatedAt = new Date();
      await existing.save();

      logger.info('Updated existing vocabulary with enriched entries', {
        tenantId,
        knowledgeBaseId,
        vocabularyId: existing._id,
        version: existing.version,
        totalEntries: mergedEntries.length,
        newAutoEntries: entries.length,
      });
    } else {
      const newVocab = await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: knowledgeBaseId,
        version: 1,
        status: 'active',
        entries,
      });

      logger.info('Created new vocabulary with enriched entries', {
        tenantId,
        knowledgeBaseId,
        vocabularyId: newVocab._id,
        entryCount: entries.length,
      });
    }
  }

  /** Promise-based sleep for retry delays. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
