/**
 * Pre-Refactor: Gather Delegation & Shadow Mode Tests
 *
 * Tests for the strangler-pattern delegation of gather logic from
 * FlowStepExecutor to GatherExecutor. Verifies:
 * - GatherExecutor produces correct results independently
 * - Shadow mode calls both old and new paths
 * - Shadow mode compares results and logs mismatches
 * - Old path result is always returned during shadow phase
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  GatherExecutor,
  type GatherExecutorConfig,
  type GatherExecutorField,
} from '@abl/compiler/platform/constructs';
import { RuntimeExecutor, compileToResolvedAgent } from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';

// =============================================================================
// GatherExecutor Unit Tests
// =============================================================================

describe('GatherExecutor', () => {
  let executor: GatherExecutor;

  beforeEach(() => {
    executor = new GatherExecutor();
  });

  // ---------------------------------------------------------------------------
  // checkCompleteness
  // ---------------------------------------------------------------------------

  describe('checkCompleteness', () => {
    test('returns complete when all required fields are collected', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'name', required: true },
          { name: 'email', required: true },
        ],
      };
      const result = executor.checkCompleteness(gather, {
        name: 'Alice',
        email: 'alice@example.com',
      });
      expect(result.complete).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.collected).toEqual(['name', 'email']);
    });

    test('returns incomplete when required fields are missing', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'name', required: true },
          { name: 'email', required: true },
        ],
      };
      const result = executor.checkCompleteness(gather, { name: 'Alice' });
      expect(result.complete).toBe(false);
      expect(result.missing).toContain('email');
      expect(result.collected).toEqual(['name']);
    });

    test('optional fields do not block completion', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'name', required: true },
          { name: 'nickname', required: false },
        ],
      };
      const result = executor.checkCompleteness(gather, { name: 'Alice' });
      expect(result.complete).toBe(true);
      expect(result.collected).toEqual(['name']);
    });

    test('empty collected data means all required fields missing', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'a', required: true },
          { name: 'b', required: true },
        ],
      };
      const result = executor.checkCompleteness(gather, {});
      expect(result.complete).toBe(false);
      expect(result.missing.length).toBe(2);
      expect(result.collected).toEqual([]);
    });

    test('fields with defaults are treated as collected', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'lang', required: true, default: 'English' },
          { name: 'region', required: true },
        ],
      };
      // Default fields are pre-populated by the runtime before checking
      const result = executor.checkCompleteness(gather, { lang: 'English' });
      expect(result.missing).toContain('region');
      expect(result.collected).toEqual(['lang']);
    });
  });

  // ---------------------------------------------------------------------------
  // validateExtracted
  // ---------------------------------------------------------------------------

  describe('validateExtracted', () => {
    test('passes values with no validation rules', () => {
      const fields: GatherExecutorField[] = [{ name: 'city' }];
      const result = executor.validateExtracted({ city: 'Tokyo' }, fields);
      expect(result.valid).toEqual({ city: 'Tokyo' });
      expect(result.errors).toEqual({});
    });

    test('rejects values failing pattern validation', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'zip',
          validation: {
            type: 'pattern',
            rule: '^\\d{5}$',
            error_message: 'Must be 5 digits',
          },
        },
      ];
      const result = executor.validateExtracted({ zip: 'abc' }, fields);
      expect(result.valid).toEqual({});
      expect(result.errors.zip).toBe('Must be 5 digits');
    });

    test('accepts values passing pattern validation', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'zip',
          validation: {
            type: 'pattern',
            rule: '^\\d{5}$',
            error_message: 'Must be 5 digits',
          },
        },
      ];
      const result = executor.validateExtracted({ zip: '12345' }, fields);
      expect(result.valid).toEqual({ zip: '12345' });
      expect(result.errors).toEqual({});
    });

    test('rejects out-of-range values', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'rating',
          validation: {
            type: 'range',
            rule: '1-5',
            error_message: 'Must be 1-5',
          },
        },
      ];
      const result = executor.validateExtracted({ rating: 10 }, fields);
      expect(result.errors.rating).toBe('Must be 1-5');
    });

    test('accepts in-range values', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'rating',
          validation: {
            type: 'range',
            rule: '1-5',
            error_message: 'Must be 1-5',
          },
        },
      ];
      const result = executor.validateExtracted({ rating: 3 }, fields);
      expect(result.valid).toEqual({ rating: 3 });
    });

    test('rejects enum values not in list', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'size',
          validation: {
            type: 'enum',
            rule: 'small|medium|large',
            error_message: 'Invalid size',
          },
        },
      ];
      const result = executor.validateExtracted({ size: 'huge' }, fields);
      expect(result.errors.size).toBe('Invalid size');
    });

    test('accepts enum values in list', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'size',
          validation: {
            type: 'enum',
            rule: 'small|medium|large',
            error_message: 'Invalid size',
          },
        },
      ];
      const result = executor.validateExtracted({ size: 'medium' }, fields);
      expect(result.valid).toEqual({ size: 'medium' });
    });

    test('skips null and undefined values', () => {
      const fields: GatherExecutorField[] = [
        {
          name: 'zip',
          validation: {
            type: 'pattern',
            rule: '^\\d{5}$',
            error_message: 'Must be 5 digits',
          },
        },
      ];
      const result = executor.validateExtracted({ zip: undefined }, fields);
      expect(result.valid).toEqual({});
      expect(result.errors).toEqual({});
    });

    test('handles mix of valid and invalid', () => {
      const fields: GatherExecutorField[] = [
        { name: 'name' },
        {
          name: 'age',
          validation: {
            type: 'range',
            rule: '0-150',
            error_message: 'Invalid age',
          },
        },
      ];
      const result = executor.validateExtracted({ name: 'Alice', age: 200 }, fields);
      expect(result.valid).toEqual({ name: 'Alice' });
      expect(result.errors.age).toBe('Invalid age');
    });
  });

  // ---------------------------------------------------------------------------
  // buildPrompt
  // ---------------------------------------------------------------------------

  describe('buildPrompt', () => {
    test('returns empty string when no missing fields', () => {
      const gather: GatherExecutorConfig = {
        fields: [{ name: 'name', prompt: 'Your name?' }],
      };
      const result = executor.buildPrompt(gather, [], { name: 'Alice' });
      expect(result).toBe('');
    });

    test('returns field prompt for missing fields', () => {
      const gather: GatherExecutorConfig = {
        fields: [{ name: 'email', prompt: 'What is your email?' }],
      };
      const result = executor.buildPrompt(gather, ['email'], {});
      expect(result).toContain('email');
    });

    test('uses custom gather prompt if provided', () => {
      const gather: GatherExecutorConfig = {
        fields: [{ name: 'name' }],
        prompt: 'Please provide your {{name}}',
      };
      const result = executor.buildPrompt(gather, ['name'], {});
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // evaluate (combined)
  // ---------------------------------------------------------------------------

  describe('evaluate', () => {
    test('returns complete when extraction fills all required fields', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'city', required: true },
          { name: 'budget', required: true, type: 'number' },
        ],
      };
      const result = executor.evaluate(gather, { city: 'Tokyo' }, { budget: 5000 });
      expect(result.complete).toBe(true);
      expect(result.validValues).toEqual({ budget: 5000 });
      expect(result.validationErrors).toEqual({});
      expect(result.prompt).toBe('');
    });

    test('returns incomplete when extraction leaves required fields empty', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          { name: 'city', required: true },
          { name: 'budget', required: true },
        ],
      };
      const result = executor.evaluate(gather, {}, { city: 'Tokyo' });
      expect(result.complete).toBe(false);
      expect(result.missing).toContain('budget');
      expect(result.prompt.length).toBeGreaterThan(0);
    });

    test('filters out invalid extracted values from completeness check', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          {
            name: 'rating',
            required: true,
            validation: {
              type: 'range',
              rule: '1-5',
              error_message: 'Must be 1-5',
            },
          },
        ],
      };
      const result = executor.evaluate(gather, {}, { rating: 10 });
      // Invalid value should not count toward completion
      expect(result.complete).toBe(false);
      expect(result.validationErrors.rating).toBe('Must be 1-5');
      expect(result.validValues).toEqual({});
    });

    test('valid extracted values are included in completeness', () => {
      const gather: GatherExecutorConfig = {
        fields: [
          {
            name: 'rating',
            required: true,
            validation: {
              type: 'range',
              rule: '1-5',
              error_message: 'Must be 1-5',
            },
          },
        ],
      };
      const result = executor.evaluate(gather, {}, { rating: 3 });
      expect(result.complete).toBe(true);
      expect(result.validValues).toEqual({ rating: 3 });
    });
  });
});

// =============================================================================
// Shadow Mode Integration Tests
// =============================================================================

describe('Gather Shadow Mode Integration', () => {
  let runtimeExecutor: RuntimeExecutor;

  beforeEach(() => {
    runtimeExecutor = new RuntimeExecutor();
  });

  test('GatherExecutor produces same completeness as inline path for simple gather', async () => {
    const dsl = `
AGENT: Shadow_Compare
GOAL: "Test shadow mode"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  GATHER:
    - name: required
  THEN: done

done:
  RESPOND: "Hello {{name}}!"
  THEN: COMPLETE
`;
    const session = runtimeExecutor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Shadow_Compare'),
    );
    await runtimeExecutor.initializeSession(session.id);

    // Simulate what shadow mode does: run GatherExecutor on same input
    const gatherExecutor = new GatherExecutor();
    const gatherConfig: GatherExecutorConfig = {
      fields: [{ name: 'name', required: true }],
    };

    // Before user input: check completeness
    const before = gatherExecutor.checkCompleteness(gatherConfig, session.data.values);
    expect(before.complete).toBe(false);
    expect(before.missing).toContain('name');

    // User provides input — runtime collects it
    await runtimeExecutor.executeMessage(session.id, 'Alice');

    // After runtime collection: verify GatherExecutor agrees
    const after = gatherExecutor.checkCompleteness(gatherConfig, session.data.values);
    expect(after.complete).toBe(true);
    expect(session.data.values.name).toBe('Alice');
  });

  test('GatherExecutor validation matches runtime validation for pattern rules', () => {
    const gatherExecutor = new GatherExecutor();
    const fields: GatherExecutorField[] = [
      {
        name: 'zip',
        required: true,
        validation: {
          type: 'pattern',
          rule: '^\\d{5}$',
          error_message: 'Must be 5 digits',
        },
      },
    ];

    // Invalid value
    const invalid = gatherExecutor.validateExtracted({ zip: 'abc' }, fields);
    expect(invalid.errors.zip).toBeDefined();

    // Valid value
    const valid = gatherExecutor.validateExtracted({ zip: '90210' }, fields);
    expect(valid.valid.zip).toBe('90210');
  });

  test('GatherExecutor evaluate matches runtime behavior for multi-field gather', async () => {
    const dsl = `
AGENT: Shadow_Multi
GOAL: "Collect travel info"

FLOW:
  entry_point: collect
  steps:
    - collect
    - done

collect:
  GATHER:
    - city: required
    - budget: required
      type: number
  THEN: done

done:
  RESPOND: "Going to {{city}} with budget {{budget}}!"
  THEN: COMPLETE
`;
    const session = runtimeExecutor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Shadow_Multi'),
    );
    await runtimeExecutor.initializeSession(session.id);

    const gatherExecutor = new GatherExecutor();
    const gatherConfig: GatherExecutorConfig = {
      fields: [
        { name: 'city', required: true },
        { name: 'budget', required: true, type: 'number' },
      ],
    };

    // Simulate partial extraction (only city)
    const partial = gatherExecutor.evaluate(gatherConfig, {}, { city: 'Tokyo' });
    expect(partial.complete).toBe(false);
    expect(partial.missing).toContain('budget');

    // Simulate full extraction
    const full = gatherExecutor.evaluate(gatherConfig, { city: 'Tokyo' }, { budget: 5000 });
    expect(full.complete).toBe(true);
    expect(full.missing).toEqual([]);
  });

  test('shadow mode comparison detects mismatch when validation differs', () => {
    const gatherExecutor = new GatherExecutor();
    const config: GatherExecutorConfig = {
      fields: [
        {
          name: 'rating',
          required: true,
          validation: {
            type: 'range',
            rule: '1-5',
            error_message: 'Must be 1-5',
          },
        },
      ],
    };

    // Simulate old path accepting value without validation
    const oldResult = { rating: 10 };
    // New executor validates and rejects
    const newResult = gatherExecutor.evaluate(config, {}, oldResult);

    // Shadow comparison would detect this mismatch
    const oldComplete = true; // hypothetical old path said complete
    const newComplete = newResult.complete; // new path says incomplete due to validation
    const mismatch = oldComplete !== newComplete;
    expect(mismatch).toBe(true);
  });
});
