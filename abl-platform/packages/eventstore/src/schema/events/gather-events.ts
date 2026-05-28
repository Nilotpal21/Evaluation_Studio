/**
 * Gather/Extraction event schemas.
 *
 * Events related to data collection and entity extraction in scripted flows.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── gather.field.extracted ────────────────────────────────────────────────

export const GatherFieldExtractedDataSchema = z
  .object({
    step_name: z.string().optional(),
    stepName: z.string().optional(),
    field_name: z.string().optional(),
    fieldName: z.string().optional(),
    extraction_method: z.enum(['llm', 'pattern']).optional(),
    extractionMethod: z.enum(['llm', 'pattern']).optional(),
    latency_ms: z.number().optional(),
    latencyMs: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('gather.field.extracted', GatherFieldExtractedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.GATHER,
  containsPII: true, // Field values may contain PII
  description: 'Field extracted from user message',
});

// ─── gather.field.validated ────────────────────────────────────────────────

export const GatherFieldValidatedDataSchema = z
  .object({
    field_name: z.string().optional(),
    fieldName: z.string().optional(),
    passed: z.boolean().optional(),
    validation_rule: z.string().optional(),
    validationRule: z.string().optional(),
    error_message: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('gather.field.validated', GatherFieldValidatedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.GATHER,
  containsPII: true,
  description: 'Field validation result',
});

// ─── gather.completed ──────────────────────────────────────────────────────

export const GatherCompletedDataSchema = z
  .object({
    step_name: z.string().optional(),
    stepName: z.string().optional(),
    fields_collected: z.number().optional(),
    fieldsCollected: z.number().optional(),
    duration_ms: z.number().optional(),
    durationMs: z.number().optional(),
    clarification_count: z.number().optional(),
    clarificationCount: z.number().optional(),
    extraction_attempts: z.number().optional(),
    extractionAttempts: z.number().optional(),
  })
  .passthrough();

eventRegistry.register('gather.completed', GatherCompletedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.GATHER,
  containsPII: false,
  description: 'Gather step completed',
});

// ─── gather.correction.detected ────────────────────────────────────────────

export const GatherCorrectionDetectedDataSchema = z
  .object({
    field_name: z.string().optional(),
    fieldName: z.string().optional(),
    original_value: z.string().optional(),
    originalValue: z.string().optional(),
    corrected_value: z.string().optional(),
    correctedValue: z.string().optional(),
  })
  .passthrough();

eventRegistry.register('gather.correction.detected', GatherCorrectionDetectedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.GATHER,
  containsPII: true, // Values may contain PII
  description: 'User corrected a previously extracted value',
});
