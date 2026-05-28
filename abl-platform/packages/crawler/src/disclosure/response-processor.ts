/**
 * Response Processor - Apply user responses to decisions
 *
 * Responsibilities:
 * 1. Parse user responses to PromptQuestions
 * 2. Apply responses to CrawlDecision
 * 3. Optionally save preferences for future use
 * 4. Update decision confidence to 100% (user-confirmed)
 *
 * Design:
 * - Type-safe response validation
 * - Atomic updates (all or nothing)
 * - Preference persistence optional
 * - Clear error messages
 */

import { createLogger } from '../logger.js';

import type { CrawlDecision, DecisionContext, CrawlStrategy } from '../decision/interfaces.js';
import type { PromptQuestion, QuestionType } from './question-generator.js';
import type { IUserPreferenceStore } from '../decision/interfaces.js';
import { DisclosureError } from './interfaces.js';

/**
 * User response to a single question
 */
export interface QuestionResponse {
  /** Question ID this response is for */
  questionId: string;

  /** The answer value */
  value: string | number | boolean;

  /** Whether to save this as a preference */
  saveAsPreference?: boolean;
}

/**
 * Response application result
 */
export interface ResponseApplicationResult {
  /** Whether the application succeeded */
  success: boolean;

  /** Updated decision (if successful) */
  updatedDecision?: CrawlDecision;

  /** Preferences saved (question IDs) */
  preferencesSaved?: string[];

  /** Error details (if failed) */
  error?: {
    code: string;
    message: string;
    questionId?: string;
  };
}

/**
 * Response Processor Options
 */
export interface ResponseProcessorOptions {
  /** User preference store (optional - if not provided, preferences won't be saved) */
  userPreferenceStore?: IUserPreferenceStore;

  /** Whether to validate response values against question constraints (default: true) */
  validateResponses?: boolean;

  /** Whether to allow partial updates if some responses fail (default: false) */
  allowPartialUpdates?: boolean;
}

/**
 * Response Processor
 *
 * Applies user responses to crawl decisions and optionally saves preferences
 */
const log = createLogger('response-processor');

export class ResponseProcessor {
  private readonly userPreferenceStore?: IUserPreferenceStore;
  private readonly validateResponses: boolean;
  private readonly allowPartialUpdates: boolean;

  constructor(options: ResponseProcessorOptions = {}) {
    this.userPreferenceStore = options.userPreferenceStore;
    this.validateResponses = options.validateResponses ?? true;
    this.allowPartialUpdates = options.allowPartialUpdates ?? false;
  }

  /**
   * Apply user responses to a decision
   */
  async applyResponses(
    decision: CrawlDecision,
    questions: PromptQuestion[],
    responses: QuestionResponse[],
    context: DecisionContext,
  ): Promise<ResponseApplicationResult> {
    try {
      // Validate inputs
      this.validateInputs(questions, responses);

      // Validate each response if enabled (and not allowing partial updates)
      // If allowing partial updates, we skip upfront validation and let individual applies fail
      if (this.validateResponses && !this.allowPartialUpdates) {
        const validationError = this.validateAllResponses(questions, responses);
        if (validationError) {
          return {
            success: false,
            error: validationError,
          };
        }
      }

      // Create a copy of the decision to modify
      const updatedDecision: CrawlDecision = { ...decision };

      // Apply each response
      const errors: { questionId: string; error: string }[] = [];
      for (const response of responses) {
        const question = questions.find((q) => q.id === response.questionId);
        if (!question) {
          errors.push({
            questionId: response.questionId,
            error: `Question with ID '${response.questionId}' not found`,
          });
          continue;
        }

        // If validating and allowing partial updates, validate this response individually
        if (this.validateResponses && this.allowPartialUpdates) {
          const validationError = this.validateResponse(question, response.value);
          if (validationError) {
            errors.push({ questionId: response.questionId, error: validationError });
            continue; // Skip applying this response, move to next
          }
        }

        const applyError = this.applyResponse(updatedDecision, question, response);
        if (applyError) {
          errors.push({ questionId: response.questionId, error: applyError });
        }
      }

      // Check for errors
      if (errors.length > 0 && !this.allowPartialUpdates) {
        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Failed to apply ${errors.length} response(s): ${errors.map((e) => e.error).join('; ')}`,
            questionId: errors[0].questionId,
          },
        };
      }

      // Update decision metadata
      updatedDecision.source = 'user-override';
      updatedDecision.confidence = 100; // User-confirmed = 100% confidence
      updatedDecision.reasoning = this.buildReasoningText(decision, responses);

      // Save preferences (if requested)
      const preferencesSaved: string[] = [];
      if (this.userPreferenceStore && context.userId) {
        const responsesToSave = responses.filter((r) => r.saveAsPreference);
        if (responsesToSave.length > 0) {
          const saved = await this.savePreferences(
            context,
            updatedDecision,
            questions,
            responsesToSave,
          );
          if (saved) {
            preferencesSaved.push(...responsesToSave.map((r) => r.questionId));
          }
        }
      }

      return {
        success: true,
        updatedDecision,
        preferencesSaved: preferencesSaved.length > 0 ? preferencesSaved : undefined,
      };
    } catch (error) {
      if (error instanceof DisclosureError) {
        throw error;
      }

      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      };
    }
  }

  // ========================================
  // Private: Validation
  // ========================================

  /**
   * Validate inputs
   */
  private validateInputs(questions: PromptQuestion[], responses: QuestionResponse[]): void {
    if (!questions || questions.length === 0) {
      throw new DisclosureError('Questions array cannot be empty', 'INVALID_INPUT');
    }

    if (!responses || responses.length === 0) {
      throw new DisclosureError('Responses array cannot be empty', 'INVALID_INPUT');
    }
  }

  /**
   * Validate all responses
   */
  private validateAllResponses(
    questions: PromptQuestion[],
    responses: QuestionResponse[],
  ): { code: string; message: string; questionId: string } | null {
    for (const response of responses) {
      const question = questions.find((q) => q.id === response.questionId);
      if (!question) {
        return {
          code: 'QUESTION_NOT_FOUND',
          message: `Question with ID '${response.questionId}' not found`,
          questionId: response.questionId,
        };
      }

      const error = this.validateResponse(question, response.value);
      if (error) {
        return {
          code: 'INVALID_RESPONSE',
          message: error,
          questionId: response.questionId,
        };
      }
    }

    return null;
  }

  /**
   * Validate a single response value
   */
  private validateResponse(
    question: PromptQuestion,
    value: string | number | boolean,
  ): string | null {
    switch (question.type) {
      case 'choice':
        if (typeof value !== 'string') {
          return `Expected string value for choice question '${question.id}', got ${typeof value}`;
        }
        if (!question.options?.some((opt) => opt.value === value)) {
          return `Invalid choice '${value}' for question '${question.id}'. Valid options: ${question.options?.map((o) => o.value).join(', ')}`;
        }
        return null;

      case 'confirm':
        if (typeof value !== 'boolean') {
          return `Expected boolean value for confirm question '${question.id}', got ${typeof value}`;
        }
        return null;

      case 'range':
        if (typeof value !== 'number') {
          return `Expected number value for range question '${question.id}', got ${typeof value}`;
        }
        if (!question.range) {
          return `Question '${question.id}' is missing range definition`;
        }
        if (value < question.range.min || value > question.range.max) {
          return `Value ${value} is out of range [${question.range.min}, ${question.range.max}] for question '${question.id}'`;
        }
        // Check step alignment
        const offset = value - question.range.min;
        if (offset % question.range.step !== 0) {
          return `Value ${value} does not align with step ${question.range.step} for question '${question.id}'`;
        }
        return null;

      default:
        return `Unknown question type for question '${question.id}'`;
    }
  }

  // ========================================
  // Private: Response Application
  // ========================================

  /**
   * Apply a single response to the decision
   */
  private applyResponse(
    decision: CrawlDecision,
    question: PromptQuestion,
    response: QuestionResponse,
  ): string | null {
    try {
      switch (question.id) {
        case 'strategy':
          if (typeof response.value === 'string') {
            if (response.value !== 'auto') {
              // Validate it's a valid CrawlStrategy
              const validStrategies: string[] = ['browser', 'bulk', 'hybrid'];
              if (validStrategies.includes(response.value)) {
                decision.strategy = response.value as CrawlStrategy;
              } else {
                return `Invalid strategy value: ${response.value}`;
              }
            }
            // 'auto' means keep the current recommendation
          }
          break;

        case 'batchSize':
          if (typeof response.value === 'number') {
            decision.batchSize = response.value;
          }
          break;

        case 'jsHandling':
          if (typeof response.value === 'string') {
            if (response.value !== 'auto') {
              decision.jsHandling = response.value as 'none' | 'static' | 'dynamic';
            }
          }
          break;

        case 'concurrency':
          if (typeof response.value === 'number') {
            decision.concurrency = response.value;
          }
          break;

        default:
          return `Unknown question ID '${question.id}'`;
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Failed to apply response';
    }
  }

  /**
   * Build reasoning text explaining user choices
   */
  private buildReasoningText(
    originalDecision: CrawlDecision,
    responses: QuestionResponse[],
  ): string {
    const parts: string[] = ['User-confirmed configuration:'];

    for (const response of responses) {
      switch (response.questionId) {
        case 'strategy':
          parts.push(`- Strategy: ${response.value}`);
          break;
        case 'batchSize':
          parts.push(`- Batch size: ${response.value} pages`);
          break;
        case 'jsHandling':
          parts.push(`- JavaScript handling: ${response.value}`);
          break;
        case 'concurrency':
          parts.push(`- Concurrency: ${response.value} requests`);
          break;
      }
    }

    return parts.join('\n');
  }

  // ========================================
  // Private: Preference Persistence
  // ========================================

  /**
   * Save preferences from multiple responses
   */
  private async savePreferences(
    context: DecisionContext,
    updatedDecision: CrawlDecision,
    questions: PromptQuestion[],
    responses: QuestionResponse[],
  ): Promise<boolean> {
    if (!this.userPreferenceStore || !context.userId) {
      return false;
    }

    const domain = this.extractDomain(context.url);
    if (!domain) {
      return false;
    }

    try {
      // Build preference object from all responses
      // Start with the updated decision's strategy as the base
      const preference: any = {
        userId: context.userId,
        tenantId: context.tenantId,
        domainPattern: domain,
        strategy: updatedDecision.strategy,
        autoDecide: false,
        useCount: 0,
        lastUsed: new Date(),
      };

      // Add specific preferences from responses
      for (const response of responses) {
        switch (response.questionId) {
          case 'strategy':
            // Already handled from updatedDecision
            break;

          case 'batchSize':
            if (typeof response.value === 'number') {
              preference.batchSize = response.value;
            }
            break;

          case 'concurrency':
            if (typeof response.value === 'number') {
              preference.concurrency = response.value;
            }
            break;

          // jsHandling is not stored in UserPreference
        }
      }

      await this.userPreferenceStore.savePreference(preference);
      return true;
    } catch (error) {
      // Log but don't fail the entire operation
      log.warn('Failed to save preferences', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  }
}
