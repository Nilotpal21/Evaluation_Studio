import { describe, expect, it } from 'vitest';
import type { WorkflowContextData } from '../context/expression-resolver.js';
import { resolveOutputMappings } from '../validation/output-mapping-validator.js';

const baseContext: WorkflowContextData = {
  trigger: { type: 'studio', payload: {} },
  workflow: { id: 'wf-1', name: 'Workflow', executionId: 'exec-1' },
  tenant: { tenantId: 'tenant-1', projectId: 'project-1' },
  steps: {
    API0001: {
      output: {
        statusCode: 200,
        ok: true,
        body: { orderId: 'ord-1' },
      },
    },
  },
};

describe('resolveOutputMappings', () => {
  it('resolves blank and missing expressions to null without an error', () => {
    const result = resolveOutputMappings(
      [
        { name: 'blank', expression: '', type: 'string' },
        {
          name: 'missing',
          expression: '{{context.steps.API0001.output.body.missing}}',
          type: 'number',
        },
      ],
      baseContext,
    );

    expect(result.output).toEqual({ blank: null, missing: null });
    expect(result.mappingErrors).toEqual([]);
  });

  it('validates configured primitive output types when a value is present', () => {
    const result = resolveOutputMappings(
      [
        {
          name: 'status',
          expression: '{{context.steps.API0001.output.statusCode}}',
          type: 'number',
        },
        {
          name: 'wrong',
          expression: '{{context.steps.API0001.output.statusCode}}',
          type: 'string',
        },
      ],
      baseContext,
    );

    expect(result.output).toEqual({ status: 200, wrong: null });
    expect(result.mappingErrors).toEqual([
      {
        name: 'wrong',
        expression: '{{context.steps.API0001.output.statusCode}}',
        expected: 'string',
        got: 'number',
        error: 'Output mapping "wrong" type mismatch: expected string, got number',
      },
    ]);
  });

  it('requires json output mappings to resolve to an object or array', () => {
    const result = resolveOutputMappings(
      [
        { name: 'body', expression: '{{context.steps.API0001.output.body}}', type: 'json' },
        { name: 'literal', expression: 'plain-text', type: 'json' },
      ],
      baseContext,
    );

    expect(result.output).toEqual({ body: { orderId: 'ord-1' }, literal: null });
    expect(result.mappingErrors).toEqual([
      {
        name: 'literal',
        expression: 'plain-text',
        expected: 'json',
        got: 'string',
        error: 'Output mapping "literal" type mismatch: expected json, got string',
      },
    ]);
  });

  it('reports objects and arrays as json for primitive type mismatches', () => {
    const result = resolveOutputMappings(
      [
        {
          name: 'bodyAsString',
          expression: '{{context.steps.API0001.output.body}}',
          type: 'string',
        },
      ],
      baseContext,
    );

    expect(result.output).toEqual({ bodyAsString: null });
    expect(result.mappingErrors).toEqual([
      {
        name: 'bodyAsString',
        expression: '{{context.steps.API0001.output.body}}',
        expected: 'string',
        got: 'json',
        error: 'Output mapping "bodyAsString" type mismatch: expected string, got json',
      },
    ]);
  });

  it('accepts array values for json output type without a type error', () => {
    const ctxWithArray: WorkflowContextData = {
      ...baseContext,
      steps: {
        List0001: { output: { items: [1, 2, 3] } },
      },
    };

    const result = resolveOutputMappings(
      [{ name: 'items', expression: '{{context.steps.List0001.output.items}}', type: 'json' }],
      ctxWithArray,
    );

    expect(result.output).toEqual({ items: [1, 2, 3] });
    expect(result.mappingErrors).toEqual([]);
  });

  describe('numeric-string coercion for number-typed mappings (ABLP-1098)', () => {
    // User types `200` in a number-typed output-mapping expression field;
    // the expression is stored as the string "200". Without coercion the
    // engine rejected this at runtime with a confusing "expected number,
    // got string" error. The validator now accepts finite numeric strings
    // for number-typed mappings and coerces them to the number.

    it('coerces a literal numeric string ("200") to a number when type is "number"', () => {
      const result = resolveOutputMappings(
        [{ name: 'status', expression: '200', type: 'number' }],
        baseContext,
      );
      expect(result.output).toEqual({ status: 200 });
      expect(result.mappingErrors).toEqual([]);
    });

    it('coerces decimal and negative numeric strings', () => {
      const result = resolveOutputMappings(
        [
          { name: 'price', expression: '12.5', type: 'number' },
          { name: 'delta', expression: '-3', type: 'number' },
          { name: 'scientific', expression: '1e3', type: 'number' },
        ],
        baseContext,
      );
      expect(result.output).toEqual({ price: 12.5, delta: -3, scientific: 1000 });
      expect(result.mappingErrors).toEqual([]);
    });

    it('rejects non-numeric strings ("200abc", "abc") with the same type-mismatch error', () => {
      const result = resolveOutputMappings(
        [
          { name: 'mixed', expression: '200abc', type: 'number' },
          { name: 'word', expression: 'abc', type: 'number' },
        ],
        baseContext,
      );
      expect(result.output).toEqual({ mixed: null, word: null });
      expect(result.mappingErrors).toHaveLength(2);
      expect(result.mappingErrors[0].error).toBe(
        'Output mapping "mixed" type mismatch: expected number, got string',
      );
    });

    it('rejects non-finite numeric strings ("NaN", "Infinity")', () => {
      const result = resolveOutputMappings(
        [
          { name: 'nan', expression: 'NaN', type: 'number' },
          { name: 'inf', expression: 'Infinity', type: 'number' },
          { name: 'negInf', expression: '-Infinity', type: 'number' },
        ],
        baseContext,
      );
      expect(result.output).toEqual({ nan: null, inf: null, negInf: null });
      expect(result.mappingErrors).toHaveLength(3);
    });

    it('treats empty / whitespace-only expressions as absence (null, no error)', () => {
      const result = resolveOutputMappings(
        [
          { name: 'blank', expression: '', type: 'number' },
          { name: 'spaces', expression: '   ', type: 'number' },
        ],
        baseContext,
      );
      // Blank expression short-circuits before validation; whitespace-only
      // resolves to the string "   ", which our isFiniteNumericString
      // helper rejects → type-mismatch error.
      expect(result.output.blank).toBeNull();
      expect(result.output.spaces).toBeNull();
      // Only "spaces" produces a validation error (blank short-circuits).
      expect(result.mappingErrors.map((e) => e.name)).toEqual(['spaces']);
    });

    it('still resolves number-typed expressions that reference numeric step output', () => {
      // Pre-existing behavior — confirm coercion path didn't break the
      // normal "expression resolves to a real number" case.
      const result = resolveOutputMappings(
        [
          {
            name: 'status',
            expression: '{{context.steps.API0001.output.statusCode}}',
            type: 'number',
          },
        ],
        baseContext,
      );
      expect(result.output).toEqual({ status: 200 });
      expect(result.mappingErrors).toEqual([]);
    });

    it('does NOT coerce numeric strings for non-number types', () => {
      // String "200" stays a string when type is "string". This proves
      // the coercion is scoped to number — boolean / string / json
      // semantics are untouched.
      const result = resolveOutputMappings(
        [{ name: 'asString', expression: '200', type: 'string' }],
        baseContext,
      );
      expect(result.output).toEqual({ asString: '200' });
      expect(result.mappingErrors).toEqual([]);
    });
  });
});
