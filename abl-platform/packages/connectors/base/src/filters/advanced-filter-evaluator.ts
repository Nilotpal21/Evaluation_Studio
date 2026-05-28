/**
 * Advanced Filter Evaluator
 *
 * Evaluates structured field/operator/value conditions against documents.
 * Supports compound conditions with AND/OR grouping (max depth: 2).
 *
 * Design:
 * - Generic: works for any connector type (field names are strings)
 * - Type-safe operators: different operators for string, number, date, array fields
 * - Dot-notation field access: "metadata.sharepoint.author" resolves nested fields
 */

import type { SourceDocument } from '../interfaces/sync-coordinator.interface.js';

// ─── Types ──────────────────────────────────────────────────────────────

/** Comparison operators */
export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'lt'
  | 'ge'
  | 'le'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'in'
  | 'notIn'
  | 'exists'
  | 'notExists'
  | 'matches';

/** Single filter condition */
export interface FilterCondition {
  /** Field path (dot-notation for nested: "metadata.sharepoint.author") */
  field: string;
  /** Comparison operator */
  operator: FilterOperator;
  /** Value to compare against (type depends on operator) */
  value: unknown;
  /** Case-insensitive comparison for string fields (default: true) */
  caseInsensitive?: boolean;
}

/** Group of conditions combined with AND/OR */
export interface FilterGroup {
  /** How conditions in this group are combined */
  operator: 'AND' | 'OR';
  /** Conditions in this group */
  conditions: FilterCondition[];
}

/** Complete advanced filter configuration */
export interface AdvancedFilterConfig {
  /** Whether advanced filters are active */
  enabled: boolean;
  /** How top-level groups are combined */
  rootOperator: 'AND' | 'OR';
  /** Top-level conditions (applied with rootOperator) */
  conditions: FilterCondition[];
  /** Grouped conditions (each group has its own internal operator) */
  groups: FilterGroup[];
}

/** Evaluation result for a single condition */
interface ConditionResult {
  passed: boolean;
  field: string;
  operator: FilterOperator;
  reason?: string;
}

// ─── Evaluator ──────────────────────────────────────────────────────────

export class AdvancedFilterEvaluator {
  private readonly config: AdvancedFilterConfig;

  constructor(config: AdvancedFilterConfig) {
    this.config = config;
  }

  /**
   * Evaluate a document against all advanced filter conditions.
   *
   * Returns true if the document passes all conditions.
   */
  evaluate(document: SourceDocument): {
    passed: boolean;
    reason?: string;
    details: ConditionResult[];
  } {
    if (!this.config.enabled) {
      return { passed: true, details: [] };
    }

    // No conditions configured → pass
    if (this.config.conditions.length === 0 && this.config.groups.length === 0) {
      return { passed: true, details: [] };
    }

    const allResults: ConditionResult[] = [];
    const groupResults: boolean[] = [];

    // Evaluate top-level conditions
    for (const condition of this.config.conditions) {
      const result = this.evaluateCondition(condition, document);
      allResults.push(result);
      groupResults.push(result.passed);
    }

    // Evaluate each group
    for (const group of this.config.groups) {
      const groupConditionResults: ConditionResult[] = [];
      for (const condition of group.conditions) {
        const result = this.evaluateCondition(condition, document);
        allResults.push(result);
        groupConditionResults.push(result);
      }

      // Combine group results with group operator
      const groupPassed =
        group.operator === 'AND'
          ? groupConditionResults.every((r) => r.passed)
          : groupConditionResults.some((r) => r.passed);

      groupResults.push(groupPassed);
    }

    // Combine all results with root operator
    const finalPassed =
      this.config.rootOperator === 'AND'
        ? groupResults.every((r) => r)
        : groupResults.some((r) => r);

    const failedResults = allResults.filter((r) => !r.passed);
    const reason = finalPassed
      ? undefined
      : `Advanced filter failed: ${failedResults.map((r) => `${r.field} ${r.operator} (${r.reason})`).join(', ')}`;

    return { passed: finalPassed, reason, details: allResults };
  }

  /**
   * Validate the advanced filter configuration.
   */
  validate(): { valid: boolean; errors: Array<{ field: string; message: string }> } {
    const errors: Array<{ field: string; message: string }> = [];

    if (!this.config.enabled) {
      return { valid: true, errors: [] };
    }

    // Validate root operator
    if (!['AND', 'OR'].includes(this.config.rootOperator)) {
      errors.push({ field: 'rootOperator', message: 'Must be "AND" or "OR"' });
    }

    // Validate conditions
    for (let i = 0; i < this.config.conditions.length; i++) {
      const condErrors = this.validateCondition(this.config.conditions[i], `conditions[${i}]`);
      errors.push(...condErrors);
    }

    // Validate groups
    for (let gi = 0; gi < this.config.groups.length; gi++) {
      const group = this.config.groups[gi];
      if (!['AND', 'OR'].includes(group.operator)) {
        errors.push({ field: `groups[${gi}].operator`, message: 'Must be "AND" or "OR"' });
      }
      for (let ci = 0; ci < group.conditions.length; ci++) {
        const condErrors = this.validateCondition(
          group.conditions[ci],
          `groups[${gi}].conditions[${ci}]`,
        );
        errors.push(...condErrors);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private evaluateCondition(condition: FilterCondition, document: SourceDocument): ConditionResult {
    const fieldValue = resolveFieldValue(document, condition.field);
    const caseInsensitive = condition.caseInsensitive !== false; // Default true

    try {
      const passed = compareValues(
        fieldValue,
        condition.operator,
        condition.value,
        caseInsensitive,
      );
      return {
        passed,
        field: condition.field,
        operator: condition.operator,
        reason: passed
          ? undefined
          : `Value ${String(fieldValue)} did not match ${condition.operator} ${String(condition.value)}`,
      };
    } catch (err: unknown) {
      return {
        passed: false,
        field: condition.field,
        operator: condition.operator,
        reason: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private validateCondition(
    condition: FilterCondition,
    path: string,
  ): Array<{ field: string; message: string }> {
    const errors: Array<{ field: string; message: string }> = [];

    if (!condition.field || condition.field.trim().length === 0) {
      errors.push({ field: `${path}.field`, message: 'Field name is required' });
    }

    const validOperators: FilterOperator[] = [
      'eq',
      'ne',
      'gt',
      'lt',
      'ge',
      'le',
      'contains',
      'notContains',
      'startsWith',
      'endsWith',
      'in',
      'notIn',
      'exists',
      'notExists',
      'matches',
    ];
    if (!validOperators.includes(condition.operator)) {
      errors.push({
        field: `${path}.operator`,
        message: `Invalid operator: ${condition.operator}. Valid: ${validOperators.join(', ')}`,
      });
    }

    // Value required for all operators except exists/notExists
    if (!['exists', 'notExists'].includes(condition.operator) && condition.value === undefined) {
      errors.push({ field: `${path}.value`, message: 'Value is required for this operator' });
    }

    // 'in' and 'notIn' require array values
    if (['in', 'notIn'].includes(condition.operator) && !Array.isArray(condition.value)) {
      errors.push({
        field: `${path}.value`,
        message: `Operator '${condition.operator}' requires an array value`,
      });
    }

    // 'matches' requires a valid regex string with complexity limits
    if (condition.operator === 'matches' && typeof condition.value === 'string') {
      if (condition.value.length > 200) {
        errors.push({
          field: `${path}.value`,
          message: `Regex pattern too long (${condition.value.length} chars, max 200)`,
        });
      } else {
        try {
          new RegExp(condition.value);
        } catch {
          errors.push({
            field: `${path}.value`,
            message: `Invalid regex pattern: ${condition.value}`,
          });
        }
      }
    }

    return errors;
  }
}

// ─── Field Resolution ───────────────────────────────────────────────────

/**
 * Resolve a dot-notation field path to a value from a SourceDocument.
 * Supports both top-level SourceDocument fields and nested metadata.
 *
 * Examples:
 * - "name" → document.name
 * - "contentType" → document.contentType
 * - "sizeBytes" → document.sizeBytes
 * - "modifiedAt" → document.modifiedAt
 * - "metadata.sharepoint.author" → document.metadata.sharepoint.author
 */
function resolveFieldValue(document: SourceDocument, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let current: unknown = document;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Compare a field value against a condition value using the specified operator.
 */
function compareValues(
  fieldValue: unknown,
  operator: FilterOperator,
  conditionValue: unknown,
  caseInsensitive: boolean,
): boolean {
  // Handle exists/notExists first
  if (operator === 'exists') {
    return fieldValue !== null && fieldValue !== undefined;
  }
  if (operator === 'notExists') {
    return fieldValue === null || fieldValue === undefined;
  }

  // For other operators, undefined field → false
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  // Normalize strings for case-insensitive comparison
  const normalize = (v: unknown): unknown => {
    if (caseInsensitive && typeof v === 'string') {
      return v.toLowerCase();
    }
    return v;
  };

  const normalizedField = normalize(fieldValue);
  const normalizedCondition = normalize(conditionValue);

  switch (operator) {
    case 'eq':
      return normalizedField === normalizedCondition;

    case 'ne':
      return normalizedField !== normalizedCondition;

    case 'gt':
      return toComparable(fieldValue) > toComparable(conditionValue);

    case 'lt':
      return toComparable(fieldValue) < toComparable(conditionValue);

    case 'ge':
      return toComparable(fieldValue) >= toComparable(conditionValue);

    case 'le':
      return toComparable(fieldValue) <= toComparable(conditionValue);

    case 'contains':
      return typeof normalizedField === 'string' && typeof normalizedCondition === 'string'
        ? normalizedField.includes(normalizedCondition)
        : false;

    case 'notContains':
      return typeof normalizedField === 'string' && typeof normalizedCondition === 'string'
        ? !normalizedField.includes(normalizedCondition)
        : true;

    case 'startsWith':
      return typeof normalizedField === 'string' && typeof normalizedCondition === 'string'
        ? normalizedField.startsWith(normalizedCondition)
        : false;

    case 'endsWith':
      return typeof normalizedField === 'string' && typeof normalizedCondition === 'string'
        ? normalizedField.endsWith(normalizedCondition)
        : false;

    case 'in':
      if (!Array.isArray(conditionValue)) return false;
      return conditionValue.some((v) => normalize(v) === normalizedField);

    case 'notIn':
      if (!Array.isArray(conditionValue)) return true;
      return !conditionValue.some((v) => normalize(v) === normalizedField);

    case 'matches':
      if (typeof fieldValue !== 'string' || typeof conditionValue !== 'string') return false;
      try {
        const flags = caseInsensitive ? 'i' : '';
        return new RegExp(conditionValue, flags).test(fieldValue);
      } catch {
        return false;
      }

    default:
      return false;
  }
}

/**
 * Convert a value to a comparable number/date for ordering operators.
 */
function toComparable(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string') {
    // Try parsing as date
    const dateMs = Date.parse(value);
    if (!isNaN(dateMs)) {
      return dateMs;
    }
    // Try parsing as number
    const num = Number(value);
    if (!isNaN(num)) {
      return num;
    }
  }
  if (typeof value === 'number') {
    return value;
  }
  return 0;
}
