/**
 * Flow Selection Service
 *
 * Selects the appropriate pipeline flow based on document properties and selection rules.
 *
 * ## Selection Algorithm
 *
 * 1. Filter enabled flows
 * 2. Sort by priority (highest first)
 * 3. Evaluate selection rules for each flow:
 *    - Simple conditions (field operator value)
 *    - Compound conditions (AND/OR logic)
 *    - CEL expressions (most flexible)
 * 4. Return first matching flow
 * 5. Fall back to default flow if no rules match
 *
 * ## Error Handling
 *
 * - Fail-safe: If rule evaluation errors, skip to next flow
 * - Timeout: CEL evaluation has 5s timeout to prevent hanging
 * - Logging: All evaluation errors are logged for debugging
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

import type { ISearchPipelineFlow, ISearchRuleCondition } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import {
  type FlowContext,
  type FlowSelectionResult,
  type RuleEvaluationResult,
  CELEvaluationError,
  NoFlowMatchedError,
  FlowSelectionTimeoutError,
} from './types.js';

const logger = createLogger('flow-selection');

/**
 * Flow Selection Service
 *
 * Evaluates pipeline flows against document context to select the best match.
 */
export class FlowSelectionService {
  /**
   * Default timeout for CEL expression evaluation (5 seconds)
   */
  private readonly celTimeoutMs: number;

  constructor(options?: { celTimeoutMs?: number }) {
    this.celTimeoutMs = options?.celTimeoutMs ?? 5000;
  }

  /**
   * Select the best matching flow for the given context.
   *
   * Algorithm:
   * 1. Filter enabled flows
   * 2. Sort by priority (descending)
   * 3. Evaluate each flow's selection rules
   * 4. Return first matching flow
   * 5. If no flow matches and default exists, return default
   *
   * @param flows - All flows from pipeline definition
   * @param context - Document and source context
   * @returns Selection result with flow or error
   *
   * @example
   * ```typescript
   * const service = new FlowSelectionService();
   * const result = await service.selectFlow(pipeline.flows, {
   *   document: { extension: 'pdf', mimeType: 'application/pdf', size: 1048576, name: 'doc.pdf' },
   *   source: { connector: 'google-drive' },
   * });
   *
   * if (result.success) {
   *   console.log('Selected flow:', result.flow.name);
   * }
   * ```
   */
  async selectFlow(
    flows: ISearchPipelineFlow[],
    context: FlowContext,
  ): Promise<FlowSelectionResult> {
    const startTime = Date.now();

    logger.info('Starting flow selection', {
      totalFlows: flows.length,
      document: context.document,
      source: context.source,
    });

    // Step 1: Filter enabled flows
    const enabledFlows = flows.filter((flow) => flow.enabled);

    if (enabledFlows.length === 0) {
      return {
        success: false,
        error: 'No enabled flows found',
        details: {
          flowsEvaluated: 0,
          skippedFlows: [],
        },
      };
    }

    // Step 2: Sort by priority (highest first)
    const sortedFlows = [...enabledFlows].sort((a, b) => b.priority - a.priority);

    // Step 3: Evaluate each flow
    const skippedFlows: Array<{ flowId: string; reason: string }> = [];

    for (const flow of sortedFlows) {
      // If no selection rules, flow matches by default
      if (!flow.selectionRules || flow.selectionRules.length === 0) {
        const duration = Date.now() - startTime;

        logger.info('Flow selected (no rules)', {
          flowId: flow.id,
          flowName: flow.name,
          priority: flow.priority,
          duration,
        });

        return {
          success: true,
          flow,
          details: {
            flowsEvaluated: skippedFlows.length + 1,
            selectedFlowId: flow.id,
            skippedFlows,
          },
        };
      }

      // Evaluate selection rules
      try {
        const rulesMatch = await this.evaluateRules(flow.selectionRules, context);

        if (rulesMatch.matched) {
          const duration = Date.now() - startTime;

          logger.info('Flow selected (rules matched)', {
            flowId: flow.id,
            flowName: flow.name,
            priority: flow.priority,
            ruleCount: flow.selectionRules.length,
            duration,
          });

          return {
            success: true,
            flow,
            details: {
              flowsEvaluated: skippedFlows.length + 1,
              selectedFlowId: flow.id,
              skippedFlows,
            },
          };
        }

        // Rules didn't match
        skippedFlows.push({
          flowId: flow.id,
          reason: 'Rules did not match',
        });
      } catch (error) {
        // Fail-safe: Log error and continue to next flow
        logger.warn('Flow rule evaluation failed, skipping flow', {
          flowId: flow.id,
          flowName: flow.name,
          error: error instanceof Error ? error.message : String(error),
        });

        skippedFlows.push({
          flowId: flow.id,
          reason: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Step 4: No flow matched
    const duration = Date.now() - startTime;

    logger.warn('No flow matched selection criteria', {
      totalFlows: flows.length,
      enabledFlows: enabledFlows.length,
      flowsEvaluated: skippedFlows.length,
      duration,
    });

    return {
      success: false,
      error: 'No flow matched the selection criteria',
      details: {
        flowsEvaluated: skippedFlows.length,
        skippedFlows,
      },
    };
  }

  /**
   * Evaluate an array of selection rules.
   *
   * Rules are evaluated with AND logic (all must match).
   * Individual rules can be simple, compound, or CEL expressions.
   *
   * @param rules - Selection rules to evaluate
   * @param context - Document and source context
   * @returns Evaluation result
   */
  private async evaluateRules(
    rules: ISearchRuleCondition[],
    context: FlowContext,
  ): Promise<RuleEvaluationResult> {
    // All rules must match (AND logic)
    for (const rule of rules) {
      const result = await this.evaluateRule(rule, context);

      if (!result.matched) {
        return result;
      }
    }

    return { matched: true };
  }

  /**
   * Evaluate a single rule condition.
   *
   * Supports:
   * - Simple: field operator value (e.g., document.extension == 'pdf')
   * - Compound: AND/OR logic with nested conditions
   * - CEL: Full CEL expression evaluation
   *
   * @param rule - Rule condition to evaluate
   * @param context - Document and source context
   * @returns Evaluation result
   */
  private async evaluateRule(
    rule: ISearchRuleCondition,
    context: FlowContext,
  ): Promise<RuleEvaluationResult> {
    const startTime = Date.now();

    try {
      switch (rule.type) {
        case 'simple':
          return this.evaluateSimpleRule(rule, context);

        case 'compound':
          return await this.evaluateCompoundRule(rule, context);

        case 'cel':
          return await this.evaluateCELRule(rule, context);

        default:
          return {
            matched: false,
            error: `Unknown rule type: ${(rule as any).type}`,
          };
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('Rule evaluation failed', {
        ruleType: rule.type,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      return {
        matched: false,
        error: error instanceof Error ? error.message : String(error),
        details: {
          ruleType: rule.type,
          evaluationTime: duration,
        },
      };
    }
  }

  /**
   * Evaluate a simple rule condition.
   *
   * Simple rules: field operator value
   * Examples:
   * - document.extension == 'pdf'
   * - document.size > 1000000
   * - source.connector in ['google-drive', 's3']
   *
   * @param rule - Simple rule condition
   * @param context - Document and source context
   * @returns Evaluation result
   */
  private evaluateSimpleRule(
    rule: ISearchRuleCondition,
    context: FlowContext,
  ): RuleEvaluationResult {
    if (!rule.field || !rule.operator || rule.value === undefined) {
      return {
        matched: false,
        error: 'Simple rule missing required fields (field, operator, value)',
      };
    }

    // Get field value from context
    const fieldValue = this.getFieldValue(rule.field, context);

    // Evaluate operator
    const matched = this.evaluateOperator(rule.operator, fieldValue, rule.value);

    return {
      matched,
      details: {
        ruleType: 'simple',
        expression: `${rule.field} ${rule.operator} ${JSON.stringify(rule.value)}`,
      },
    };
  }

  /**
   * Evaluate a compound rule condition.
   *
   * Compound rules: AND/OR logic with nested conditions
   * Examples:
   * - (document.extension == 'pdf') AND (document.size < 10000000)
   * - (source.connector == 'google-drive') OR (source.connector == 's3')
   *
   * @param rule - Compound rule condition
   * @param context - Document and source context
   * @returns Evaluation result
   */
  private async evaluateCompoundRule(
    rule: ISearchRuleCondition,
    context: FlowContext,
  ): Promise<RuleEvaluationResult> {
    if (!rule.logic || !rule.conditions || rule.conditions.length === 0) {
      return {
        matched: false,
        error: 'Compound rule missing required fields (logic, conditions)',
      };
    }

    if (rule.logic === 'AND') {
      // All conditions must match
      for (const condition of rule.conditions) {
        const result = await this.evaluateRule(condition, context);
        if (!result.matched) {
          return {
            matched: false,
            details: {
              ruleType: 'compound',
              expression: `AND logic failed on condition`,
            },
          };
        }
      }
      return { matched: true };
    } else if (rule.logic === 'OR') {
      // At least one condition must match
      for (const condition of rule.conditions) {
        const result = await this.evaluateRule(condition, context);
        if (result.matched) {
          return { matched: true };
        }
      }
      return {
        matched: false,
        details: {
          ruleType: 'compound',
          expression: `OR logic - no conditions matched`,
        },
      };
    } else {
      return {
        matched: false,
        error: `Unknown logic operator: ${rule.logic}`,
      };
    }
  }

  /**
   * Evaluate a CEL expression rule.
   *
   * CEL (Common Expression Language) provides maximum flexibility.
   * Examples:
   * - document.extension == "pdf" && document.size < 10000000
   * - source.connector in ["google-drive", "s3"] && document.mimeType.startsWith("application/")
   *
   * @param rule - CEL rule condition
   * @param context - Document and source context
   * @returns Evaluation result
   */
  private async evaluateCELRule(
    rule: ISearchRuleCondition,
    context: FlowContext,
  ): Promise<RuleEvaluationResult> {
    if (!rule.celExpression) {
      return {
        matched: false,
        error: 'CEL rule missing celExpression field',
      };
    }

    const startTime = Date.now();

    try {
      // Dynamic import to avoid loading CEL unless needed
      const { Environment } = await import('@marcbachmann/cel-js');

      // Create CEL environment with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new FlowSelectionTimeoutError('CEL evaluation timeout', this.celTimeoutMs));
        }, this.celTimeoutMs);
      });

      const evaluationPromise = (async () => {
        const env = new Environment({ unlistedVariablesAreDyn: true });
        const result = env.evaluate(
          rule.celExpression!,
          context as unknown as Record<string, unknown>,
        );
        return result;
      })();

      const result = await Promise.race([evaluationPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      // CEL should return boolean
      if (typeof result !== 'boolean') {
        return {
          matched: false,
          error: `CEL expression must return boolean, got ${typeof result}`,
          details: {
            ruleType: 'cel',
            expression: rule.celExpression,
            evaluationTime: duration,
          },
        };
      }

      return {
        matched: result,
        details: {
          ruleType: 'cel',
          expression: rule.celExpression,
          evaluationTime: duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof FlowSelectionTimeoutError) {
        logger.error('CEL evaluation timeout', {
          expression: rule.celExpression,
          timeoutMs: this.celTimeoutMs,
        });

        throw error;
      }

      logger.error('CEL evaluation error', {
        expression: rule.celExpression,
        error: error instanceof Error ? error.message : String(error),
        duration,
      });

      throw new CELEvaluationError(
        `CEL evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        rule.celExpression,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get field value from context using dot notation.
   *
   * Examples:
   * - 'document.extension' -> context.document.extension
   * - 'source.connector' -> context.source.connector
   * - 'metadata.author' -> context.metadata.author
   *
   * @param field - Field path in dot notation
   * @param context - Document and source context
   * @returns Field value or undefined
   */
  private getFieldValue(field: string, context: FlowContext): unknown {
    const parts = field.split('.');
    let value: any = context;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Evaluate simple operator.
   *
   * Supported operators:
   * - eq: equals
   * - ne: not equals
   * - gt: greater than
   * - lt: less than
   * - gte: greater than or equal
   * - lte: less than or equal
   * - contains: string/array contains
   * - matches: regex match
   * - in: value in array
   *
   * @param operator - Operator type
   * @param left - Left operand (field value)
   * @param right - Right operand (comparison value)
   * @returns Whether operator condition is true
   */
  private evaluateOperator(operator: string, left: unknown, right: unknown): boolean {
    switch (operator) {
      case 'eq':
        return left === right;

      case 'ne':
        return left !== right;

      case 'gt':
        return typeof left === 'number' && typeof right === 'number' && left > right;

      case 'lt':
        return typeof left === 'number' && typeof right === 'number' && left < right;

      case 'gte':
        return typeof left === 'number' && typeof right === 'number' && left >= right;

      case 'lte':
        return typeof left === 'number' && typeof right === 'number' && left <= right;

      case 'contains':
        if (typeof left === 'string' && typeof right === 'string') {
          return left.includes(right);
        }
        if (Array.isArray(left)) {
          return left.includes(right);
        }
        return false;

      case 'matches':
        if (typeof left === 'string' && typeof right === 'string') {
          try {
            const regex = new RegExp(right);
            return regex.test(left);
          } catch {
            return false;
          }
        }
        return false;

      case 'in':
        if (Array.isArray(right)) {
          return right.includes(left);
        }
        return false;

      default:
        logger.warn('Unknown operator', { operator });
        return false;
    }
  }
}
