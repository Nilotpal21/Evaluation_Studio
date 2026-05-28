/**
 * Pipeline Validation Module
 *
 * Validates PipelineDefinition against 18 validation rules.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { PipelineValidationService } from './pipeline-validation';
 *
 * const service = new PipelineValidationService();
 * const result = await service.validate(pipeline);
 *
 * if (!result.valid) {
 *   const errors = result.errors.filter(e => e.severity === 'error');
 *   console.error('Validation failed:', errors);
 * }
 * ```
 *
 * ## Validation Rules
 *
 * **Structure (5 rules):**
 * - At least 1 flow, max 50 flows
 * - At least 1 stage per flow
 * - At least 1 enabled flow
 * - Exactly 1 default flow recommended
 *
 * **Uniqueness (3 rules):**
 * - Flow IDs unique within pipeline
 * - Stage IDs unique within flow
 * - Priority uniqueness (warning)
 *
 * **Stages (4 rules):**
 * - Stage type valid enum value
 * - Extraction before chunking
 * - Chunking before embedding
 * - Warn on duplicate stage types
 *
 * **Providers (3 rules):**
 * - Provider exists in registry
 * - Fallback provider different from primary
 * - Provider config matches schema
 *
 * **Rules (3 rules):**
 * - CEL expression syntax valid
 * - Rule field paths valid
 * - Rule operators valid
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

export { PipelineValidationService } from './validation.service.js';
export {
  type ValidationResult,
  type ValidationError,
  type ValidationOptions,
  type ValidationSeverity,
  type ValidationErrorCode,
  VALID_STAGE_TYPES,
  VALID_RULE_OPERATORS,
  VALID_RULE_FIELD_PREFIXES,
  MAX_FLOWS_PER_PIPELINE,
  MIN_FLOWS_PER_PIPELINE,
  MIN_STAGES_PER_FLOW,
} from './types.js';
