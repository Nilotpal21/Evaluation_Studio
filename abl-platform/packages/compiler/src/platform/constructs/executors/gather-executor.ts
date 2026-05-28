/**
 * Gather Executor
 *
 * Encapsulates gather field collection, completeness checking, validation,
 * and prompt building. Pure functions of (gather config, context, user input)
 * with no runtime dependencies.
 *
 * This is the strangler-pattern replacement for the inline gather logic in
 * FlowStepExecutor. During shadow mode the runtime calls both this executor
 * and the old inline path, compares results, and logs mismatches.
 *
 * Responsibilities:
 * - Check gather completeness (which fields are collected vs missing)
 * - Validate extracted values against field-level validation rules
 * - Build prompts for missing fields
 * - Determine next action (collect more, continue, complete)
 */

import type { ValidationRule } from '../../ir/schema.js';
import {
  MAX_PATTERN_INPUT_LENGTH,
  MAX_USER_REGEX_PATTERN_LENGTH,
  validateRegexSafety,
} from '../../ir/regex-safety.js';
import { checkGatherComplete, buildGatherPrompt, validateField } from '../utils.js';
import { createLogger } from '../../logger.js';

const gatherLog = createLogger('gather-executor');

// =============================================================================
// TYPES
// =============================================================================

/** Gather configuration from the IR step */
export interface GatherExecutorConfig {
  fields: GatherExecutorField[];
  prompt?: string;
  strategy?: 'pattern' | 'llm' | 'hybrid';
}

/** Single gather field definition */
export interface GatherExecutorField {
  name: string;
  type?: string;
  prompt?: string;
  required?: boolean;
  default?: unknown;
  activation?: unknown;
  depends_on?: string[];
  validation?: ValidationRule;
}

/** Result of a gather completeness check */
export interface GatherCompletenessResult {
  complete: boolean;
  missing: string[];
  collected: string[];
}

/** Result of validating extracted values */
export interface GatherValidationResult {
  valid: Record<string, unknown>;
  errors: Record<string, string>;
}

/** Overall result of a gather step evaluation */
export interface GatherStepResult {
  /** Whether all required fields are collected */
  complete: boolean;
  /** Fields still missing */
  missing: string[];
  /** Fields successfully collected */
  collected: string[];
  /** Values that passed validation */
  validValues: Record<string, unknown>;
  /** Validation errors for extracted values */
  validationErrors: Record<string, string>;
  /** Prompt to show user for missing fields (empty if complete) */
  prompt: string;
}

// =============================================================================
// PATTERN EXTRACTION (XO migration: custom regex extractors)
// =============================================================================

const MAX_PATTERN_LENGTH = MAX_USER_REGEX_PATTERN_LENGTH;

/**
 * Extract a value from text using a custom regex pattern.
 *
 * @param text - User message to extract from
 * @param pattern - Regex pattern string
 * @param group - Capture group index (default: 0 = full match)
 * @returns Extracted value or null if no match
 */
export function extractByPattern(text: string, pattern: string, group: number = 0): string | null {
  const safety = validateRegexSafety(pattern, 'GATHER extraction_pattern');
  if (!safety.safe) {
    gatherLog.warn('Unsafe extraction pattern rejected at runtime', {
      pattern,
      error: safety.error,
    });
    return null;
  }

  if (text.length > MAX_PATTERN_INPUT_LENGTH) {
    gatherLog.warn('Skipping extraction pattern for oversized input', {
      pattern,
      inputLength: text.length,
      maxInputLength: MAX_PATTERN_INPUT_LENGTH,
    });
    return null;
  }

  try {
    const regex = new RegExp(pattern);
    const match = regex.exec(text);

    if (!match) return null;

    if (group >= match.length) {
      gatherLog.warn('Extraction pattern group index out of range', {
        pattern,
        group,
        availableGroups: match.length - 1,
      });
      return null;
    }

    return match[group] ?? null;
  } catch {
    gatherLog.warn('Invalid extraction pattern', { pattern });
    return null;
  }
}

/**
 * Validate an extraction pattern at compile time.
 */
export function validateExtractionPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}` };
  }

  const safety = validateRegexSafety(pattern, 'GATHER extraction_pattern');
  if (!safety.safe) {
    return { valid: false, error: safety.error };
  }

  return { valid: true };
}

// =============================================================================
// GATHER EXECUTOR
// =============================================================================

export class GatherExecutor {
  /**
   * Check completeness of a gather step.
   * Delegates to the compiler's checkGatherComplete utility.
   */
  checkCompleteness(
    gather: GatherExecutorConfig,
    collectedData: Record<string, unknown>,
    completeWhen?: string,
  ): GatherCompletenessResult {
    const { complete, missing } = checkGatherComplete(gather, collectedData, completeWhen);
    const collected = gather.fields
      .map((f) => f.name)
      .filter((name) => collectedData[name] !== undefined);
    return { complete, missing, collected };
  }

  /**
   * Validate extracted values against their field-level validation rules.
   * Returns valid values (those that pass) and error messages for those that don't.
   */
  validateExtracted(
    extracted: Record<string, unknown>,
    fields: GatherExecutorField[],
  ): GatherValidationResult {
    const valid: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    for (const [name, value] of Object.entries(extracted)) {
      if (value === undefined || value === null) continue;

      const field = fields.find((f) => f.name === name);
      if (!field?.validation) {
        valid[name] = value;
        continue;
      }

      const error = validateField(value, field.validation);
      if (error) {
        errors[name] = error;
      } else {
        valid[name] = value;
      }
    }

    return { valid, errors };
  }

  /**
   * Build a prompt for missing fields.
   * Delegates to the compiler's buildGatherPrompt utility.
   */
  buildPrompt(
    gather: GatherExecutorConfig,
    missing: string[],
    collectedData: Record<string, unknown>,
  ): string {
    return buildGatherPrompt(gather, missing, collectedData);
  }

  /**
   * Evaluate a complete gather step: check completeness, validate any new
   * extracted values, and build a prompt if needed.
   *
   * This is the main entry point for shadow-mode comparison.
   */
  evaluate(
    gather: GatherExecutorConfig,
    collectedData: Record<string, unknown>,
    extracted: Record<string, unknown>,
    completeWhen?: string,
    userMessage?: string,
  ): GatherStepResult {
    // Pattern extraction: try extraction_pattern before LLM/ML extraction
    if (userMessage) {
      for (const field of gather.fields) {
        if (extracted[field.name] !== undefined) continue;
        if (collectedData[field.name] !== undefined) continue;

        const gatherField = field as GatherExecutorField & {
          extraction_pattern?: string;
          extraction_group?: number;
        };

        if (gatherField.extraction_pattern) {
          const value = extractByPattern(
            userMessage,
            gatherField.extraction_pattern,
            gatherField.extraction_group,
          );
          if (value !== null) {
            extracted[field.name] = value;
            gatherLog.debug('Extracted via pattern', {
              field: field.name,
              pattern: gatherField.extraction_pattern,
            });
          }
        }
      }
    }

    // Validate extracted values
    const validation = this.validateExtracted(extracted, gather.fields);

    // Merge valid extracted values into collected data for completeness check
    const mergedData = { ...collectedData, ...validation.valid };

    // Check completeness with merged data
    const completeness = this.checkCompleteness(gather, mergedData, completeWhen);

    // Build prompt for missing fields
    const prompt = completeness.complete
      ? ''
      : this.buildPrompt(gather, completeness.missing, mergedData);

    return {
      complete: completeness.complete,
      missing: completeness.missing,
      collected: completeness.collected,
      validValues: validation.valid,
      validationErrors: validation.errors,
      prompt,
    };
  }
}
