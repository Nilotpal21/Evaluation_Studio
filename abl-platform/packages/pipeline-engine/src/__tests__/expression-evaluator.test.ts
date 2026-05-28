import { describe, test, expect } from 'vitest';
import {
  evaluateExpression,
  resolveExpression,
  isSafeExpression,
  extractStepReferences,
} from '../pipeline/expression-evaluator.js';
import type { StepOutput } from '../pipeline/types.js';

const stepOutputs: Record<string, StepOutput> = {
  'eval-safety': {
    status: 'success',
    data: { scores: { toxicity: 0.9, bias: 0.3 }, status: 'success' },
  },
  'check-policy': {
    status: 'fail',
    data: { status: 'FAIL', summary: { passed: 2, failed: 1 } },
  },
  'skipped-step': {
    status: 'skipped',
    data: {},
  },
};

describe('evaluateExpression', () => {
  test('string equality — true', () => {
    expect(evaluateExpression("steps.check-policy.output.status == 'FAIL'", stepOutputs)).toBe(
      true,
    );
  });

  test('string equality — false', () => {
    expect(evaluateExpression("steps.check-policy.output.status == 'PASS'", stepOutputs)).toBe(
      false,
    );
  });

  test('numeric comparison — greater than', () => {
    expect(evaluateExpression('steps.eval-safety.output.scores.toxicity > 0.7', stepOutputs)).toBe(
      true,
    );
  });

  test('numeric comparison — less than', () => {
    expect(evaluateExpression('steps.eval-safety.output.scores.toxicity < 0.5', stepOutputs)).toBe(
      false,
    );
  });

  test('logical AND', () => {
    expect(
      evaluateExpression(
        "steps.eval-safety.output.status == 'success' && steps.check-policy.output.status == 'FAIL'",
        stepOutputs,
      ),
    ).toBe(true);
  });

  test('logical OR', () => {
    expect(
      evaluateExpression(
        "steps.check-policy.output.status == 'PASS' || steps.eval-safety.output.scores.toxicity > 0.5",
        stepOutputs,
      ),
    ).toBe(true);
  });

  test('negation', () => {
    expect(evaluateExpression("!steps.skipped-step.output.status == 'success'", stepOutputs)).toBe(
      true,
    );
  });

  test('nested property access', () => {
    expect(evaluateExpression('steps.check-policy.output.summary.failed > 0', stepOutputs)).toBe(
      true,
    );
  });

  test('missing step returns false safely', () => {
    expect(evaluateExpression("steps.nonexistent.output.x == 'y'", stepOutputs)).toBe(false);
  });
});

describe('resolveExpression', () => {
  test('resolves nested dot path', () => {
    expect(resolveExpression('steps.eval-safety.output.scores.toxicity', stepOutputs)).toBe(0.9);
  });

  test('resolves named node aliases when previousSteps includes them', () => {
    expect(
      resolveExpression('steps.quality_score.output.scores.toxicity', {
        ...stepOutputs,
        quality_score: stepOutputs['eval-safety'],
      }),
    ).toBe(0.9);
  });

  test('resolves object', () => {
    expect(resolveExpression('steps.check-policy.output.summary', stepOutputs)).toEqual({
      passed: 2,
      failed: 1,
    });
  });

  test('returns undefined for missing path', () => {
    expect(resolveExpression('steps.nonexistent.output.x', stepOutputs)).toBeUndefined();
  });
});

describe('isSafeExpression', () => {
  test('allows comparison expressions', () => {
    expect(isSafeExpression("steps.x.output.status == 'FAIL'")).toBe(true);
  });

  test('allows logical operators', () => {
    expect(isSafeExpression('steps.a.output.x > 0 && steps.b.output.y == true')).toBe(true);
  });

  test('rejects function keyword', () => {
    expect(isSafeExpression('function() {}')).toBe(false);
  });

  test('rejects eval', () => {
    expect(isSafeExpression("eval('code')")).toBe(false);
  });

  test('rejects bracket access', () => {
    expect(isSafeExpression("steps['x'].output")).toBe(false);
  });

  test('rejects require', () => {
    expect(isSafeExpression("require('fs')")).toBe(false);
  });

  test('rejects constructor', () => {
    expect(isSafeExpression('constructor.prototype')).toBe(false);
  });

  test('rejects __proto__', () => {
    expect(isSafeExpression('__proto__')).toBe(false);
  });

  test('rejects arithmetic', () => {
    expect(isSafeExpression('steps.x.output.a + steps.x.output.b')).toBe(false);
  });
});

describe('resolveExpression — pipelineInput prefix', () => {
  test('resolves top-level pipelineInput field', () => {
    expect(resolveExpression('pipelineInput.sessionId', stepOutputs, { sessionId: 'sess-1' })).toBe(
      'sess-1',
    );
  });

  test('resolves nested pipelineInput field', () => {
    expect(
      resolveExpression('pipelineInput.payload.score', stepOutputs, {
        payload: { score: 0.8 },
      }),
    ).toBe(0.8);
  });

  test('returns undefined for missing pipelineInput field', () => {
    expect(resolveExpression('pipelineInput.missing', stepOutputs, {})).toBeUndefined();
  });

  test('returns undefined when pipelineInput not provided', () => {
    expect(resolveExpression('pipelineInput.x', stepOutputs)).toBeUndefined();
  });
});

describe('evaluateExpression — pipelineInput prefix', () => {
  test('compares pipelineInput field to string literal', () => {
    expect(
      evaluateExpression("pipelineInput.channel == 'whatsapp'", stepOutputs, {
        channel: 'whatsapp',
      }),
    ).toBe(true);
  });

  test('compares pipelineInput field to number', () => {
    expect(
      evaluateExpression('pipelineInput.payload.score > 0.5', stepOutputs, {
        payload: { score: 0.8 },
      }),
    ).toBe(true);
  });

  test('mixes pipelineInput and steps references', () => {
    expect(
      evaluateExpression(
        "pipelineInput.channel == 'whatsapp' && steps.eval-safety.output.scores.toxicity > 0.5",
        stepOutputs,
        { channel: 'whatsapp' },
      ),
    ).toBe(true);
  });
});

describe('extractStepReferences', () => {
  test('extracts single reference', () => {
    expect(extractStepReferences("steps.check-policy.output.status == 'FAIL'")).toEqual([
      'check-policy',
    ]);
  });

  test('extracts multiple references', () => {
    expect(
      extractStepReferences('steps.eval-a.output.x > 0 && steps.eval-b.output.y == true'),
    ).toEqual(['eval-a', 'eval-b']);
  });

  test('deduplicates references', () => {
    expect(
      extractStepReferences('steps.eval-a.output.x > 0 && steps.eval-a.output.y == true'),
    ).toEqual(['eval-a']);
  });

  test('returns empty for no references', () => {
    expect(extractStepReferences('true')).toEqual([]);
  });
});
