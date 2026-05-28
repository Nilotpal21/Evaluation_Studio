import { describe, expect, test } from 'vitest';
import { classifyEvalRunError } from '../pipeline/handlers/eval-run-errors.js';

describe('classifyEvalRunError', () => {
  test('categorizes missing eval set as terminal', () => {
    expect(classifyEvalRunError(new Error('EvalSet eval-set-1 not found'))).toEqual({
      category: 'eval_set_not_found',
      message: 'EvalSet eval-set-1 not found',
      terminal: true,
    });
  });

  test('categorizes referenced entity access errors as terminal', () => {
    expect(
      classifyEvalRunError(new Error('One or more evaluators not found or access denied')),
    ).toEqual({
      category: 'entity_access_denied',
      message: 'One or more evaluators not found or access denied',
      terminal: true,
    });
  });

  test('categorizes preflight failures as terminal', () => {
    expect(classifyEvalRunError(new Error('Eval preflight failed: LLM: missing key'))).toEqual({
      category: 'preflight_failed',
      message: 'Eval preflight failed: LLM: missing key',
      terminal: true,
    });
  });

  test('categorizes cancelled runs as terminal', () => {
    expect(classifyEvalRunError(new Error('Run cancelled or not found'))).toEqual({
      category: 'run_cancelled',
      message: 'Run cancelled or not found',
      terminal: true,
    });
  });

  test('leaves unknown failures retryable', () => {
    expect(classifyEvalRunError(new Error('Mongo timeout while loading eval set'))).toEqual({
      category: 'unknown',
      message: 'Mongo timeout while loading eval set',
      terminal: false,
    });
  });
});
