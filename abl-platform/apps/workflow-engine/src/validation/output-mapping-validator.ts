import { resolveExpressionTyped } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import type { OutputMapping } from '../handlers/canvas-to-steps.js';

export interface OutputMappingError {
  name: string;
  expression: string;
  error: string;
  expected?: string;
  got?: string;
}

export interface ResolvedOutputMappings {
  output: Record<string, unknown>;
  mappingErrors: OutputMappingError[];
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return 'json';
  return typeof value;
}

function isFiniteNumericString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  const n = Number(value);
  return Number.isFinite(n);
}

interface ValidationResult {
  error: OutputMappingError | null;
  coercedValue: unknown;
}

function validateResolvedValueType(mapping: OutputMapping, value: unknown): ValidationResult {
  if (value === null || value === undefined) return { error: null, coercedValue: value };
  if (!mapping.type) return { error: null, coercedValue: value };

  const got = describeRuntimeType(value);
  const expected = mapping.type;

  if (expected === 'number' && isFiniteNumericString(value)) {
    return { error: null, coercedValue: Number(value) };
  }

  const matches =
    expected === 'number'
      ? typeof value === 'number' && !Number.isNaN(value)
      : expected === 'json'
        ? got === 'json'
        : got === expected;

  if (matches) return { error: null, coercedValue: value };

  return {
    error: {
      name: mapping.name,
      expression: mapping.expression,
      expected,
      got,
      error: `Output mapping "${mapping.name}" type mismatch: expected ${expected}, got ${got}`,
    },
    coercedValue: value,
  };
}

export function resolveOutputMappings(
  mappings: OutputMapping[],
  ctx: WorkflowContextData,
): ResolvedOutputMappings {
  const output: Record<string, unknown> = {};
  const mappingErrors: OutputMappingError[] = [];

  for (const mapping of mappings) {
    if (!mapping.expression) {
      output[mapping.name] = null;
      continue;
    }

    let value: unknown;
    let evaluationError: string | null = null;
    try {
      value = resolveExpressionTyped(mapping.expression, ctx);
    } catch (err) {
      evaluationError = err instanceof Error ? err.message : String(err);
    }

    if (evaluationError !== null) {
      mappingErrors.push({
        name: mapping.name,
        expression: mapping.expression,
        error: evaluationError,
      });
      output[mapping.name] = null;
      continue;
    }

    if (value === undefined) {
      output[mapping.name] = null;
      continue;
    }

    const { error: typeError, coercedValue } = validateResolvedValueType(mapping, value);
    if (typeError) {
      mappingErrors.push(typeError);
      output[mapping.name] = null;
      continue;
    }

    output[mapping.name] = coercedValue;
  }

  return { output, mappingErrors };
}
