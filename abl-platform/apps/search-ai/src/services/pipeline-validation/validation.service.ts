/**
 * Pipeline Validation Service
 *
 * Validates PipelineDefinition against 18 validation rules.
 *
 * ## Validation Rules (from 01-DATA-MODELS.md):
 *
 * **Structure Validation:**
 * 1. At least 1 flow required
 * 2. Flow count: 1-50 (performance limit)
 * 3. At least 1 stage per flow
 * 4. At least 1 enabled flow
 * 5. Exactly 1 default flow (no selection rules)
 *
 * **Uniqueness Validation:**
 * 6. Flow IDs unique within pipeline
 * 7. Stage IDs unique within flow
 * 8. Priority uniqueness (warning if duplicates)
 *
 * **Stage Validation:**
 * 9. Stage type must be valid enum value
 * 10. Extraction before chunking (if both present)
 * 11. Chunking before embedding (if both present)
 * 12. Warn on duplicate stage types in same flow
 *
 * **Provider Validation:**
 * 13. Provider ID must be registered
 * 14. Fallback provider different from primary
 * 15. Provider config matches provider's schema
 *
 * **Rule Validation:**
 * 16. CEL expression syntax validation
 * 17. Rule field paths are valid (document.*, source.*, metadata.*)
 * 18. Rule operators match field types
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

import type {
  ISearchPipelineDefinition,
  ISearchPipelineFlow,
  ISearchPipelineStage,
  ISearchRuleCondition,
} from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import { ProviderRegistry } from '../provider-registry/provider-registry.js';
import type { ValidationResult, ValidationError, ValidationOptions } from './types.js';
import {
  VALID_STAGE_TYPES,
  UTILITY_STAGE_TYPES,
  VALID_RULE_OPERATORS,
  VALID_RULE_FIELD_PREFIXES,
  MAX_FLOWS_PER_PIPELINE,
  MIN_FLOWS_PER_PIPELINE,
  MIN_STAGES_PER_FLOW,
} from './types.js';

const logger = createLogger('pipeline-validation');

// ─── Pipeline Validation Service ─────────────────────────────────────────

/**
 * Pipeline Validation Service
 *
 * Validates pipeline definitions against all validation rules.
 */
export class PipelineValidationService {
  private readonly providerRegistry: ProviderRegistry;

  constructor() {
    this.providerRegistry = ProviderRegistry.getInstance();
  }

  /**
   * Validate a pipeline definition.
   *
   * @param pipeline - Pipeline definition to validate
   * @param options - Validation options (for testing)
   * @returns Validation result with errors/warnings
   *
   * @example
   * ```typescript
   * const service = new PipelineValidationService();
   * const result = await service.validate(pipeline);
   *
   * if (!result.valid) {
   *   const errors = result.errors.filter(e => e.severity === 'error');
   *   console.error('Validation failed:', errors);
   * }
   * ```
   */
  async validate(
    pipeline: ISearchPipelineDefinition,
    options: ValidationOptions = {},
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const errors: ValidationError[] = [];

    logger.info('Starting pipeline validation', {
      pipelineId: pipeline._id,
      flowCount: pipeline.flows.length,
    });

    // Structure validation
    errors.push(...this.validateStructure(pipeline));

    // Embedding consistency validation
    errors.push(...this.validateEmbeddingConsistency(pipeline));

    // Uniqueness validation
    errors.push(...this.validateUniqueness(pipeline));

    // Stage validation
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      errors.push(...this.validateStages(flow, i));
    }

    // Provider validation
    if (!options.skipProviderValidation) {
      for (let i = 0; i < pipeline.flows.length; i++) {
        const flow = pipeline.flows[i];
        errors.push(...(await this.validateProviders(flow, i)));
      }
    }

    // Rule validation
    if (!options.skipCELValidation) {
      for (let i = 0; i < pipeline.flows.length; i++) {
        const flow = pipeline.flows[i];
        if (flow.selectionRules && flow.selectionRules.length > 0) {
          errors.push(
            ...(await this.validateRules(flow.selectionRules, `flows[${i}].selectionRules`)),
          );
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Calculate summary
    const errorCount = errors.filter((e) => e.severity === 'error').length;
    const warningCount = errors.filter((e) => e.severity === 'warning').length;
    const infoCount = errors.filter((e) => e.severity === 'info').length;

    const valid = errorCount === 0;

    logger.info('Pipeline validation completed', {
      pipelineId: pipeline._id,
      valid,
      errorCount,
      warningCount,
      infoCount,
      durationMs,
    });

    return {
      valid,
      errors,
      summary: {
        errorCount,
        warningCount,
        infoCount,
        durationMs,
      },
    };
  }

  // ─── Embedding Consistency Validation ─────────────────────────────────────

  /**
   * Validate embedding consistency across all flows.
   *
   * All enabled flows with embedding stages must use the same provider/model/dimensions
   * as the pipeline's activeEmbeddingConfig. Embedding is per-pipeline, not per-flow.
   */
  private validateEmbeddingConsistency(pipeline: ISearchPipelineDefinition): ValidationError[] {
    const errors: ValidationError[] = [];

    const activeConfig = pipeline.activeEmbeddingConfig;
    if (!activeConfig) {
      errors.push({
        code: 'MISSING_EMBEDDING_CONFIG',
        message: 'Pipeline must have an activeEmbeddingConfig',
        severity: 'error',
        path: 'activeEmbeddingConfig',
      });
      return errors;
    }

    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (!flow.enabled) continue;

      for (let j = 0; j < flow.stages.length; j++) {
        const stage = flow.stages[j];
        if (stage.type !== 'embedding') continue;

        const mismatches: string[] = [];

        if (stage.provider !== activeConfig.provider) {
          mismatches.push(`provider '${stage.provider}' != '${activeConfig.provider}'`);
        }

        const stageModel = (stage.providerConfig as any)?.model;
        if (stageModel && stageModel !== activeConfig.model) {
          mismatches.push(`model '${stageModel}' != '${activeConfig.model}'`);
        }

        const stageDimensions = (stage.providerConfig as any)?.dimensions;
        if (stageDimensions && stageDimensions !== activeConfig.dimensions) {
          mismatches.push(`dimensions ${stageDimensions} != ${activeConfig.dimensions}`);
        }

        if (mismatches.length > 0) {
          errors.push({
            code: 'EMBEDDING_CONFIG_MISMATCH',
            message:
              `Flow '${flow.name}' embedding stage '${stage.name}' does not match ` +
              `pipeline activeEmbeddingConfig: ${mismatches.join(', ')}. ` +
              `All flows must use the same embedding configuration.`,
            severity: 'error',
            path: `flows[${i}].stages[${j}]`,
            context: {
              flowId: flow.id,
              stageId: stage.id,
              stageProvider: stage.provider,
              activeProvider: activeConfig.provider,
            },
          });
        }
      }
    }

    return errors;
  }

  // ─── Structure Validation ────────────────────────────────────────────────

  /**
   * Validate pipeline structure.
   *
   * Rules 1-5:
   * - At least 1 flow
   * - Flow count 1-50
   * - At least 1 stage per flow
   * - At least 1 enabled flow
   * - Exactly 1 default flow
   */
  private validateStructure(pipeline: ISearchPipelineDefinition): ValidationError[] {
    const errors: ValidationError[] = [];

    // Rule 1: At least 1 flow
    if (!pipeline.flows || pipeline.flows.length < MIN_FLOWS_PER_PIPELINE) {
      errors.push({
        code: 'NO_FLOWS',
        message: `Pipeline must have at least ${MIN_FLOWS_PER_PIPELINE} flow`,
        severity: 'error',
        path: 'flows',
      });
      return errors; // Early return - other checks will fail
    }

    // Rule 2: Max 50 flows
    if (pipeline.flows.length > MAX_FLOWS_PER_PIPELINE) {
      errors.push({
        code: 'TOO_MANY_FLOWS',
        message: `Pipeline has ${pipeline.flows.length} flows, maximum is ${MAX_FLOWS_PER_PIPELINE}`,
        severity: 'error',
        path: 'flows',
        context: { count: pipeline.flows.length, max: MAX_FLOWS_PER_PIPELINE },
      });
    }

    // Rule 3: At least 1 stage per flow
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (!flow.stages || flow.stages.length < MIN_STAGES_PER_FLOW) {
        errors.push({
          code: 'NO_STAGES',
          message: `Flow '${flow.name}' must have at least ${MIN_STAGES_PER_FLOW} stage`,
          severity: 'error',
          path: `flows[${i}].stages`,
        });
      }
    }

    // Rule 4: At least 1 enabled flow
    const enabledFlows = pipeline.flows.filter((f) => f.enabled);
    if (enabledFlows.length === 0) {
      errors.push({
        code: 'NO_ENABLED_FLOWS',
        message: 'Pipeline must have at least one enabled flow',
        severity: 'error',
        path: 'flows',
      });
    }

    // Rule 5: Exactly 1 default flow with isDefault: true
    const defaultFlows = pipeline.flows.filter((f) => f.isDefault);

    if (defaultFlows.length === 0) {
      errors.push({
        code: 'PIPELINE_NO_DEFAULT_FLOW',
        message: 'Pipeline must have a default flow. The default flow cannot be deleted.',
        severity: 'error',
        path: 'flows',
      });
    } else if (defaultFlows.length > 1) {
      errors.push({
        code: 'PIPELINE_MULTIPLE_DEFAULT_FLOWS',
        message: 'Pipeline can only have one default flow.',
        severity: 'error',
        path: 'flows',
        context: { defaultFlowIds: defaultFlows.map((f) => f.id) },
      });
    } else {
      const df = defaultFlows[0];
      const dfIndex = pipeline.flows.indexOf(df);

      // Default flow must have no selection rules
      if (df.selectionRules && df.selectionRules.length > 0) {
        errors.push({
          code: 'DEFAULT_FLOW_HAS_RULES',
          message: 'Default flow cannot have selection rules. It catches all unmatched documents.',
          severity: 'error',
          path: `flows[${dfIndex}].selectionRules`,
        });
      }

      // Default flow must be enabled
      if (!df.enabled) {
        errors.push({
          code: 'DEFAULT_FLOW_DISABLED',
          message: 'Default flow cannot be disabled. Disabling it would drop unmatched documents.',
          severity: 'error',
          path: `flows[${dfIndex}].enabled`,
        });
      }

      // Default flow priority must be 0
      if (df.priority !== 0) {
        errors.push({
          code: 'DEFAULT_FLOW_PRIORITY',
          message:
            'Default flow priority must be 0. User flows with higher priority are evaluated first.',
          severity: 'error',
          path: `flows[${dfIndex}].priority`,
        });
      }
    }

    return errors;
  }

  // ─── Uniqueness Validation ───────────────────────────────────────────────

  /**
   * Validate ID and priority uniqueness.
   *
   * Rules 6-8:
   * - Flow IDs unique
   * - Stage IDs unique within flow
   * - Priority uniqueness (warning)
   */
  private validateUniqueness(pipeline: ISearchPipelineDefinition): ValidationError[] {
    const errors: ValidationError[] = [];

    // Rule 6: Flow IDs unique
    const flowIds = new Map<string, number>();
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (flowIds.has(flow.id)) {
        errors.push({
          code: 'DUPLICATE_FLOW_ID',
          message: `Duplicate flow ID '${flow.id}' found at flows[${i}] and flows[${flowIds.get(flow.id)}]`,
          severity: 'error',
          path: `flows[${i}].id`,
        });
      } else {
        flowIds.set(flow.id, i);
      }
    }

    // Rule 7: Stage IDs unique within flow
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      const stageIds = new Map<string, number>();

      for (let j = 0; j < flow.stages.length; j++) {
        const stage = flow.stages[j];
        if (stageIds.has(stage.id)) {
          errors.push({
            code: 'DUPLICATE_STAGE_ID',
            message: `Duplicate stage ID '${stage.id}' in flow '${flow.name}' at stages[${j}] and stages[${stageIds.get(stage.id)}]`,
            severity: 'error',
            path: `flows[${i}].stages[${j}].id`,
          });
        } else {
          stageIds.set(stage.id, j);
        }
      }
    }

    // Rule 8: Priority uniqueness (warning)
    const priorities = new Map<number, number>();
    for (let i = 0; i < pipeline.flows.length; i++) {
      const flow = pipeline.flows[i];
      if (priorities.has(flow.priority)) {
        errors.push({
          code: 'DUPLICATE_PRIORITY',
          message: `Duplicate priority ${flow.priority} in flow '${flow.name}' and flows[${priorities.get(flow.priority)}]`,
          severity: 'warning',
          path: `flows[${i}].priority`,
        });
      } else {
        priorities.set(flow.priority, i);
      }
    }

    return errors;
  }

  // ─── Stage Validation ────────────────────────────────────────────────────

  /**
   * Validate stage types and sequence.
   *
   * Rules 9-12:
   * - Stage type valid
   * - Extraction before chunking
   * - Chunking before embedding
   * - Warn on duplicate stage types
   */
  private validateStages(flow: ISearchPipelineFlow, flowIndex: number): ValidationError[] {
    const errors: ValidationError[] = [];

    // Rule 9: Stage type must be valid
    for (let i = 0; i < flow.stages.length; i++) {
      const stage = flow.stages[i];
      if (!VALID_STAGE_TYPES.includes(stage.type as any)) {
        errors.push({
          code: 'INVALID_STAGE_TYPE',
          message: `Invalid stage type '${stage.type}'. Valid types: ${VALID_STAGE_TYPES.join(', ')}`,
          severity: 'error',
          path: `flows[${flowIndex}].stages[${i}].type`,
        });
      }
    }

    // Rules 10-12: Stage sequence validation
    errors.push(...this.validateStageSequence(flow.stages, flowIndex));

    return errors;
  }

  /**
   * Validate stage sequence order.
   *
   * Canonical order: extraction → chunking → content-intelligence → visual-analysis → enrichment → embedding
   * Utility stages (field-mapping, api-webhook, llm-stage) are order-free.
   *
   * From docs/searchai/pipelines/design/backend/01-DATA-MODELS.md (lines 778-835)
   */
  private validateStageSequence(
    stages: ISearchPipelineStage[],
    flowIndex: number,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    // Build first-occurrence index for sequence validation.
    // Skip utility stages — they are order-free.
    const firstIndexMap = new Map<string, number>();
    stages.forEach((stage, index) => {
      if (
        !firstIndexMap.has(stage.type) &&
        !(UTILITY_STAGE_TYPES as readonly string[]).includes(stage.type)
      ) {
        firstIndexMap.set(stage.type, index);
      }
    });

    // Ordered stage types — each must come before the next
    const orderedTypes = [
      'extraction',
      'chunking',
      'content-intelligence',
      'visual-analysis',
      'enrichment',
      'embedding',
    ];

    // Validate canonical ordering across all later stage types, not just adjacent pairs.
    // This catches gaps like embedding before chunking when intermediate stage types are absent.
    for (let i = 0; i < orderedTypes.length - 1; i++) {
      const earlier = orderedTypes[i];
      const earlierIdx = firstIndexMap.get(earlier);
      if (earlierIdx === undefined) continue;

      for (let j = i + 1; j < orderedTypes.length; j++) {
        const later = orderedTypes[j];
        const laterIdx = firstIndexMap.get(later);

        if (laterIdx !== undefined && earlierIdx > laterIdx) {
          errors.push({
            code: 'INVALID_STAGE_SEQUENCE',
            message: `${earlier} stage must come before ${later} stage`,
            severity: 'error',
            path: `flows[${flowIndex}].stages[${laterIdx}]`,
          });
        }
      }
    }

    // Rule 12: Warn on duplicate ordered stage types (utility stages allow duplicates)
    const typeCounts = new Map<string, number>();
    stages.forEach((stage) => {
      typeCounts.set(stage.type, (typeCounts.get(stage.type) || 0) + 1);
    });

    typeCounts.forEach((count, type) => {
      // Utility stages allow duplicates without warning
      if ((UTILITY_STAGE_TYPES as readonly string[]).includes(type)) return;

      if (count > 1) {
        errors.push({
          code: 'DUPLICATE_STAGE_TYPE',
          message: `Multiple stages of type '${type}' found (${count}). This may be intentional but should be reviewed.`,
          severity: 'warning',
          path: `flows[${flowIndex}].stages`,
          context: { type, count },
        });
      }
    });

    return errors;
  }

  // ─── Provider Validation ─────────────────────────────────────────────────

  /**
   * Validate provider existence and configuration.
   *
   * Rules 13-15:
   * - Provider exists in registry
   * - Fallback provider different from primary
   * - Provider config matches schema
   */
  private async validateProviders(
    flow: ISearchPipelineFlow,
    flowIndex: number,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    for (let i = 0; i < flow.stages.length; i++) {
      const stage = flow.stages[i];

      // Rule 13: Provider must exist in registry
      let provider;
      try {
        provider = this.providerRegistry.get(stage.type, stage.provider);
      } catch (error) {
        // Provider not found (registry throws error)
        errors.push({
          code: 'PROVIDER_NOT_FOUND',
          message: `Provider '${stage.provider}' not found for stage type '${stage.type}'`,
          severity: 'error',
          path: `flows[${flowIndex}].stages[${i}].provider`,
        });
        continue; // Skip config validation if provider doesn't exist
      }

      if (!provider) {
        errors.push({
          code: 'PROVIDER_NOT_FOUND',
          message: `Provider '${stage.provider}' not found for stage type '${stage.type}'`,
          severity: 'error',
          path: `flows[${flowIndex}].stages[${i}].provider`,
        });
        continue; // Skip config validation if provider doesn't exist
      }

      // Rule 14: Fallback provider different from primary
      if (stage.fallbackProvider && stage.fallbackProvider === stage.provider) {
        errors.push({
          code: 'FALLBACK_PROVIDER_SAME_AS_PRIMARY',
          message: `Fallback provider '${stage.fallbackProvider}' is the same as primary provider`,
          severity: 'error',
          path: `flows[${flowIndex}].stages[${i}].fallbackProvider`,
        });
      }

      // Rule 15: Provider config matches schema
      // Treat undefined/null providerConfig as empty object — stages created
      // via the UI may not have providerConfig set yet.
      if (!provider.validateConfig(stage.providerConfig ?? {})) {
        errors.push({
          code: 'INVALID_PROVIDER_CONFIG',
          message: `Invalid configuration for provider '${stage.provider}'. Config does not match provider schema.`,
          severity: 'error',
          path: `flows[${flowIndex}].stages[${i}].providerConfig`,
        });
      }
    }

    return errors;
  }

  // ─── Rule Validation ─────────────────────────────────────────────────────

  /**
   * Validate selection rules.
   *
   * Rules 16-18:
   * - CEL expression syntax valid
   * - Rule field paths valid
   * - Rule operators match field types
   */
  private async validateRules(
    rules: ISearchRuleCondition[],
    basePath: string,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const rulePath = `${basePath}[${i}]`;

      if (rule.type === 'simple') {
        errors.push(...this.validateSimpleRule(rule, rulePath));
      } else if (rule.type === 'compound') {
        errors.push(...(await this.validateCompoundRule(rule, rulePath)));
      } else if (rule.type === 'cel') {
        errors.push(...(await this.validateCELRule(rule, rulePath)));
      }
    }

    return errors;
  }

  /**
   * Validate simple rule.
   *
   * Rules 17-18: Field path and operator validation
   */
  private validateSimpleRule(rule: ISearchRuleCondition, path: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Rule 17: Field path must be valid
    if (rule.field) {
      const fieldPrefix = rule.field.split('.')[0];
      if (!VALID_RULE_FIELD_PREFIXES.includes(fieldPrefix as any)) {
        errors.push({
          code: 'INVALID_RULE_FIELD_PATH',
          message: `Invalid field path '${rule.field}'. Must start with: ${VALID_RULE_FIELD_PREFIXES.join(', ')}`,
          severity: 'error',
          path: `${path}.field`,
        });
      }
    }

    // Rule 18: Operator must be valid
    if (rule.operator && !VALID_RULE_OPERATORS.includes(rule.operator as any)) {
      errors.push({
        code: 'INVALID_RULE_OPERATOR',
        message: `Invalid operator '${rule.operator}'. Valid operators: ${VALID_RULE_OPERATORS.join(', ')}`,
        severity: 'error',
        path: `${path}.operator`,
      });
    }

    return errors;
  }

  /**
   * Validate compound rule (recursive).
   */
  private async validateCompoundRule(
    rule: ISearchRuleCondition,
    path: string,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    if (rule.conditions && rule.conditions.length > 0) {
      errors.push(...(await this.validateRules(rule.conditions, `${path}.conditions`)));
    }

    return errors;
  }

  /**
   * Validate CEL expression.
   *
   * Rule 16: CEL expression syntax validation
   */
  private async validateCELRule(
    rule: ISearchRuleCondition,
    path: string,
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    if (!rule.celExpression || rule.celExpression.trim().length === 0) {
      errors.push({
        code: 'INVALID_CEL_EXPRESSION',
        message: 'CEL expression is empty',
        severity: 'error',
        path: `${path}.celExpression`,
      });
      return errors;
    }

    try {
      // Validate CEL expression syntax using @marcbachmann/cel-js
      // Use a dry-run evaluation with sample context to catch syntax errors
      const { Environment } = await import('@marcbachmann/cel-js');
      const env = new Environment({ unlistedVariablesAreDyn: true });
      const sampleContext = {
        document: { name: '', mimeType: '', extension: '', size: 0 },
        source: { connector: '' },
        metadata: {},
      };
      env.evaluate(rule.celExpression, sampleContext as unknown as Record<string, unknown>);
    } catch (error) {
      errors.push({
        code: 'INVALID_CEL_EXPRESSION',
        message: `Invalid CEL expression: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        path: `${path}.celExpression`,
      });
    }

    return errors;
  }
}
