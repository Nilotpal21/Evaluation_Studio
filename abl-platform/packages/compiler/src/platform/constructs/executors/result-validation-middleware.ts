/**
 * Result Validation Middleware
 *
 * Validates tool call results against the tool's ToolReturnType schema.
 * Operates in 'warn' mode (log mismatches) or 'strict' mode (throw).
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './tool-middleware.js';
import type { ToolReturnType } from '../../ir/schema.js';
import { createLogger } from '../../logger.js';

const log = createLogger('result-validation');

export type ValidationMode = 'warn' | 'strict';

export interface ValidationError {
  path: string;
  expected: string;
  actual: string;
  message: string;
}

/**
 * Create result validation middleware.
 * In 'warn' mode, logs mismatches but returns the result unchanged.
 * In 'strict' mode, throws on type mismatch.
 */
export function resultValidationMiddleware(mode: ValidationMode = 'warn'): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const result = await next(ctx);

    // Only validate if tool has a returns schema
    const returnSchema = ctx.tool?.returns;
    if (!returnSchema || result.result === null || result.result === undefined) {
      return result;
    }

    const errors = validateResult(result.result, returnSchema, '');

    if (errors.length > 0) {
      if (mode === 'strict') {
        throw new Error(
          `Tool ${ctx.toolName} result validation failed: ${errors.map((e) => e.message).join('; ')}`,
        );
      } else {
        log.warn('Tool result validation mismatches', {
          toolName: ctx.toolName,
          errors: errors.map((e) => e.message),
        });
      }
    }

    return result;
  };
}

/**
 * Validate a result value against a ToolReturnType schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateResult(
  value: unknown,
  schema: ToolReturnType,
  path: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const actualType = getActualType(value);

  // Handle optional fields
  if (schema.optional && (value === null || value === undefined)) {
    return errors;
  }

  const expectedType = schema.type.toLowerCase();

  switch (expectedType) {
    case 'string':
    case 'date':
    case 'datetime':
    case 'email':
    case 'url':
      if (typeof value !== 'string') {
        errors.push({
          path: path || 'root',
          expected: schema.type,
          actual: actualType,
          message: `${path || 'root'}: expected ${schema.type}, got ${actualType}`,
        });
      }
      break;

    case 'number':
    case 'integer':
      if (typeof value !== 'number') {
        errors.push({
          path: path || 'root',
          expected: schema.type,
          actual: actualType,
          message: `${path || 'root'}: expected ${schema.type}, got ${actualType}`,
        });
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({
          path: path || 'root',
          expected: 'boolean',
          actual: actualType,
          message: `${path || 'root'}: expected boolean, got ${actualType}`,
        });
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        errors.push({
          path: path || 'root',
          expected: 'array',
          actual: actualType,
          message: `${path || 'root'}: expected array, got ${actualType}`,
        });
      } else if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateResult(value[i], schema.items, `${path}[${i}]`));
        }
      }
      break;

    case 'object':
      if (typeof value !== 'object' || Array.isArray(value) || value === null) {
        errors.push({
          path: path || 'root',
          expected: 'object',
          actual: actualType,
          message: `${path || 'root'}: expected object, got ${actualType}`,
        });
      } else if (schema.fields) {
        for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
          const fieldValue = (value as Record<string, unknown>)[fieldName];
          errors.push(
            ...validateResult(fieldValue, fieldSchema, path ? `${path}.${fieldName}` : fieldName),
          );
        }
      }
      break;

    default:
      // Unknown type — skip validation
      break;
  }

  return errors;
}

function getActualType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
