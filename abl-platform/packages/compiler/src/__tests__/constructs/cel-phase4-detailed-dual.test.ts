/**
 * CEL Phase 4 Tests: evaluateConditionDetailedDual
 *
 * Verifies that the CEL-aware detailed evaluator produces correct
 * ConditionEvalDetail structs using dual evaluation for both boolean
 * results and value resolution.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import * as compilerPublicApi from '../../index.js';
import {
  evaluateConditionDetailedDual,
  evaluateConditionDual,
  resolveValueDual,
  celMetrics,
} from '../../platform/constructs/dual-evaluator.js';
import {
  evaluateConditionDetailedDual as publicEvaluateConditionDetailedDual,
  evaluateConditionDual as publicEvaluateConditionDual,
  resolveValueDual as publicResolveValueDual,
  celMetrics as publicCelMetrics,
} from '../../index.js';

describe('evaluateConditionDetailedDual', () => {
  beforeEach(() => {
    celMetrics.reset();
  });

  describe('variable comparison', () => {
    test('CEL variable comparison — budget > 1000', () => {
      const result = evaluateConditionDetailedDual('budget > 1000', '', {
        budget: 2000,
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('variable_comparison');
      expect(result.operator).toBe('>');
      expect(result.leftValue).toBe(2000);
      expect(result.rightValue).toBe(1000);
    });

    test('CEL variable comparison — equality', () => {
      const result = evaluateConditionDetailedDual('status == "active"', '', {
        status: 'active',
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('variable_comparison');
      expect(result.operator).toBe('==');
    });

    test('CEL variable comparison — false result', () => {
      const result = evaluateConditionDetailedDual('budget > 1000', '', {
        budget: 500,
      });
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('variable_comparison');
    });
  });

  describe('compound conditions', () => {
    test('CEL compound AND', () => {
      const result = evaluateConditionDetailedDual('budget > 0 AND destination IS SET', '', {
        budget: 1000,
        destination: 'Paris',
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('compound_and');
      expect(result.operator).toBe('AND');
    });

    test('CEL compound AND — one part false', () => {
      const result = evaluateConditionDetailedDual('budget > 5000 AND destination IS SET', '', {
        budget: 1000,
        destination: 'Paris',
      });
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('compound_and');
    });

    test('CEL compound OR', () => {
      const result = evaluateConditionDetailedDual('budget > 5000 OR destination IS SET', '', {
        budget: 1000,
        destination: 'Paris',
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('compound_or');
      expect(result.operator).toBe('OR');
    });

    test('CEL compound && syntax', () => {
      const result = evaluateConditionDetailedDual('budget > 0 && budget < 5000', '', {
        budget: 1000,
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('compound_and');
    });

    test('CEL compound || syntax', () => {
      const result = evaluateConditionDetailedDual('budget > 5000 || budget < 100', '', {
        budget: 1000,
      });
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('compound_or');
    });
  });

  describe('IS SET / IS NOT SET', () => {
    test('legacy IS SET — variable present', () => {
      const result = evaluateConditionDetailedDual('name IS SET', '', {
        name: 'John',
      });
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('is_set');
      expect(result.operator).toBe('IS SET');
    });

    test('legacy IS SET — variable absent', () => {
      const result = evaluateConditionDetailedDual('name IS SET', '', {});
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('is_set');
    });

    test('legacy IS NOT SET — variable absent', () => {
      const result = evaluateConditionDetailedDual('name IS NOT SET', '', {});
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('is_not_set');
      expect(result.operator).toBe('IS NOT SET');
    });
  });

  describe('contains', () => {
    test('input contains keyword', () => {
      const result = evaluateConditionDetailedDual(
        'input contains "help"',
        'i need help please',
        {},
      );
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('contains');
      expect(result.operator).toBe('contains');
    });

    test('input does not contain keyword', () => {
      const result = evaluateConditionDetailedDual('input contains "help"', 'just browsing', {});
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('contains');
    });
  });

  describe('regex matches', () => {
    test('input matches regex pattern', () => {
      const context: Record<string, unknown> = {};
      const result = evaluateConditionDetailedDual('input matches "^[0-9]+$"', '42', context);
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('matches');
      expect(result.operator).toBe('matches');
    });

    test('input does not match regex pattern', () => {
      const result = evaluateConditionDetailedDual('input matches "^[0-9]+$"', 'abc', {});
      expect(result.matched).toBe(false);
      expect(result.conditionType).toBe('matches');
    });
  });

  describe('fallback', () => {
    test('complex expression evaluates via fallback', () => {
      const result = evaluateConditionDetailedDual('true', '', {});
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe('other');
      expect(result.operator).toBe('eval');
    });
  });

  describe('explanation field', () => {
    test('variable comparison includes explanation', () => {
      const result = evaluateConditionDetailedDual('count > 3', '', {
        count: 5,
      });
      expect(result.explanation).toContain('count');
      expect(result.explanation).toContain('>');
      expect(result.explanation).toContain('true');
    });

    test('contains includes explanation', () => {
      const result = evaluateConditionDetailedDual('input contains "test"', 'this is a test', {});
      expect(result.explanation).toContain('contains');
    });
  });
});

describe('CEL Phase 4: Public API exports', () => {
  test('evaluateConditionDetailedDual is re-exported from @abl/compiler', () => {
    expect(publicEvaluateConditionDetailedDual).toBe(evaluateConditionDetailedDual);
  });

  test('evaluateConditionDual is re-exported from @abl/compiler', () => {
    expect(publicEvaluateConditionDual).toBe(evaluateConditionDual);
  });

  test('resolveValueDual is re-exported from @abl/compiler', () => {
    expect(publicResolveValueDual).toBe(resolveValueDual);
  });

  test('celMetrics is re-exported from @abl/compiler', () => {
    expect(publicCelMetrics).toBe(celMetrics);
    expect(typeof publicCelMetrics.reset).toBe('function');
  });

  test('legacy evaluateCondition NOT importable from @abl/compiler', () => {
    expect((compilerPublicApi as Record<string, unknown>)['evaluateCondition']).toBeUndefined();
  });

  test('legacy evaluateConditionWithInput NOT importable from @abl/compiler', () => {
    expect(
      (compilerPublicApi as Record<string, unknown>)['evaluateConditionWithInput'],
    ).toBeUndefined();
  });
});
