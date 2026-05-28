/**
 * INT-5, INT-10: Prompt Library Test Service Tests
 *
 * Tests variable sanitization, template rendering, and partial pane failure
 * data structures. Pure function tests — no LLM calls needed.
 */

import { describe, test, expect } from 'vitest';
import {
  extractVariables,
  sanitizeVariableValue,
  renderTemplate,
  type FailedPane,
  type TestPane,
  type TestResult,
} from '../prompt-library-test-service.js';

// ---------------------------------------------------------------------------
// INT-5: Variable Sanitization
// ---------------------------------------------------------------------------

describe('INT-5: variable sanitization in rendering', () => {
  test('sanitizeVariableValue strips injected {{ }}', () => {
    expect(sanitizeVariableValue('{{injection}} attack')).toBe('injection attack');
  });

  test('renderTemplate substitutes variables', () => {
    const result = renderTemplate('Hello {{name}}', { name: 'world' });
    expect(result).toBe('Hello world');
  });

  test('renderTemplate sanitizes injected variable values', () => {
    const result = renderTemplate('{{a}} and {{b}}', {
      a: '{{evil}}',
      b: 'safe',
    });
    // {{evil}} gets its {{ and }} stripped → "evil"
    expect(result).toBe('evil and safe');
  });

  test('renderTemplate replaces missing variables with empty string', () => {
    const result = renderTemplate('Hello {{name}}, welcome to {{place}}', {
      name: 'Alice',
    });
    expect(result).toBe('Hello Alice, welcome to ');
  });

  test('renderTemplate handles template with no variables', () => {
    const result = renderTemplate('No variables here', {});
    expect(result).toBe('No variables here');
  });

  test('renderTemplate handles whitespace in variable names', () => {
    const result = renderTemplate('{{ name }} is here', { name: 'Bob' });
    expect(result).toBe('Bob is here');
  });
});

// ---------------------------------------------------------------------------
// INT-10: Partial Pane Failure Data Structures
// ---------------------------------------------------------------------------

describe('INT-10: partial pane failure assembly', () => {
  test('TestResult shape with mixed success and failure', () => {
    const result: TestResult = {
      panes: [
        {
          promptVersionId: 'plv_1',
          tenantModelId: 'tm_1',
          output: 'Hello world',
          usage: { input: 10, output: 5, total: 15 },
          latencyMs: 150,
          model: 'gpt-4',
          provider: 'openai',
        },
      ],
      failedPanes: [
        {
          promptVersionId: 'plv_2',
          tenantModelId: 'tm_2',
          error: {
            code: 'PROMPT_LIBRARY_MODEL_NOT_FOUND',
            message: 'TenantModel not found or inactive',
          },
        },
      ],
    };

    // Verify shape
    expect(result.panes).toHaveLength(1);
    expect(result.failedPanes).toHaveLength(1);
    expect(result.panes[0].output).toBe('Hello world');
    expect(result.failedPanes[0].error.code).toBe('PROMPT_LIBRARY_MODEL_NOT_FOUND');
  });

  test('FailedPane can omit optional fields', () => {
    const pane: FailedPane = {
      error: { code: 'GENERIC_ERROR', message: 'Something went wrong' },
    };

    expect(pane.promptVersionId).toBeUndefined();
    expect(pane.tenantModelId).toBeUndefined();
    expect(pane.error.code).toBe('GENERIC_ERROR');
  });

  test('TestPane usage totals are consistent', () => {
    const pane: TestPane = {
      promptVersionId: 'plv_1',
      tenantModelId: 'tm_1',
      output: 'test output',
      usage: { input: 100, output: 50, total: 150 },
      latencyMs: 500,
      model: 'claude-3',
      provider: 'anthropic',
    };

    expect(pane.usage.total).toBe(pane.usage.input + pane.usage.output);
  });

  test('all panes failed result shape', () => {
    const result: TestResult = {
      panes: [],
      failedPanes: [
        {
          promptVersionId: 'plv_1',
          tenantModelId: 'tm_1',
          error: {
            code: 'PROMPT_LIBRARY_VERSION_ARCHIVED',
            message: 'Prompt version is archived',
          },
        },
        {
          promptVersionId: 'plv_2',
          tenantModelId: 'tm_2',
          error: {
            code: 'PROMPT_LIBRARY_CREDENTIAL_MISSING',
            message: 'Credential not found',
          },
        },
      ],
    };

    expect(result.panes).toHaveLength(0);
    expect(result.failedPanes).toHaveLength(2);
  });
});
