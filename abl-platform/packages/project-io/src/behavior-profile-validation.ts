import { parseAgentBasedABL } from '@abl/core';
import { compileBehaviorProfile, type CompilationError } from '@abl/compiler';

export interface BehaviorProfileSemanticValidationResult {
  parseErrors: string[];
  compilationErrors: string[];
  valid: boolean;
}

export function validateBehaviorProfileSemantics(
  dslContent: string,
): BehaviorProfileSemanticValidationResult {
  const parseResult = parseAgentBasedABL(dslContent);
  const parseErrors = parseResult.errors.map((error) => formatParseError(error));

  if (!parseResult.document || parseErrors.length > 0) {
    return {
      parseErrors,
      compilationErrors: [],
      valid: false,
    };
  }

  const { errors } = compileBehaviorProfile(parseResult.document);
  const compilationErrors = errors.map((error) => formatCompilationError(error));

  return {
    parseErrors,
    compilationErrors,
    valid: compilationErrors.length === 0,
  };
}

function formatParseError(error: { line?: number; message?: string } | string): string {
  if (typeof error === 'string') {
    return error;
  }

  const message = error.message ?? 'Invalid behavior profile DSL';
  return typeof error.line === 'number' ? `line ${error.line + 1}: ${message}` : message;
}

function formatCompilationError(error: CompilationError): string {
  const path = error.path ? `${error.path}: ` : '';
  return `${path}${error.message}`;
}
