/**
 * Result Validation Middleware Tests
 *
 * Verifies that tool results are validated against ToolReturnType schema.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resultValidationMiddleware,
  validateResult,
} from '../../platform/constructs/executors/result-validation-middleware.js';
import type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';
import type { ToolReturnType } from '../../platform/ir/schema.js';

describe('Result Validation Middleware', () => {
  const makeCtx = (returnType: ToolReturnType): ToolCallContext => ({
    toolName: 'test_tool',
    params: {},
    timeoutMs: 5000,
    tool: {
      name: 'test_tool',
      description: 'Test',
      parameters: [],
      returns: returnType,
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: false,
        side_effects: false,
        requires_auth: false,
      },
    },
  });

  const makeNext = (result: unknown): ToolMiddlewareNext => {
    return async () => ({ result });
  };

  describe('warn mode', () => {
    it('should pass through valid string result', async () => {
      const middleware = resultValidationMiddleware('warn');
      const ctx = makeCtx({ type: 'string' });
      const next = makeNext('hello');

      const { result } = await middleware(ctx, next);
      expect(result).toBe('hello');
    });

    it('should log warning but return result on type mismatch', async () => {
      const middleware = resultValidationMiddleware('warn');
      const ctx = makeCtx({ type: 'string' });
      const next = makeNext(42);

      const { result } = await middleware(ctx, next);
      // In warn mode, result is still returned despite mismatch
      expect(result).toBe(42);
    });

    it('should skip validation when no return schema', async () => {
      const middleware = resultValidationMiddleware('warn');
      const ctx: ToolCallContext = {
        toolName: 'test_tool',
        params: {},
        timeoutMs: 5000,
        // no tool.returns
      };
      const next = makeNext('anything');

      const { result } = await middleware(ctx, next);
      expect(result).toBe('anything');
    });

    it('should skip validation for null results', async () => {
      const middleware = resultValidationMiddleware('warn');
      const ctx = makeCtx({ type: 'string' });
      const next = makeNext(null);

      const { result } = await middleware(ctx, next);
      expect(result).toBeNull();
    });
  });

  describe('strict mode', () => {
    it('should throw on type mismatch', async () => {
      const middleware = resultValidationMiddleware('strict');
      const ctx = makeCtx({ type: 'string' });
      const next = makeNext(42);

      await expect(middleware(ctx, next)).rejects.toThrow('result validation failed');
    });

    it('should pass valid results through', async () => {
      const middleware = resultValidationMiddleware('strict');
      const ctx = makeCtx({ type: 'number' });
      const next = makeNext(42);

      const { result } = await middleware(ctx, next);
      expect(result).toBe(42);
    });
  });
});

describe('validateResult', () => {
  it('should validate string type', () => {
    expect(validateResult('hello', { type: 'string' }, '')).toEqual([]);
    expect(validateResult(42, { type: 'string' }, '')).toHaveLength(1);
  });

  it('should validate number type', () => {
    expect(validateResult(42, { type: 'number' }, '')).toEqual([]);
    expect(validateResult('not a number', { type: 'number' }, '')).toHaveLength(1);
  });

  it('should validate boolean type', () => {
    expect(validateResult(true, { type: 'boolean' }, '')).toEqual([]);
    expect(validateResult('true', { type: 'boolean' }, '')).toHaveLength(1);
  });

  it('should validate array type', () => {
    expect(validateResult([1, 2, 3], { type: 'array' }, '')).toEqual([]);
    expect(validateResult('not array', { type: 'array' }, '')).toHaveLength(1);
  });

  it('should validate array items', () => {
    const schema: ToolReturnType = {
      type: 'array',
      items: { type: 'string' },
    };
    expect(validateResult(['a', 'b'], schema, '')).toEqual([]);
    expect(validateResult(['a', 42], schema, '')).toHaveLength(1);
  });

  it('should validate object type', () => {
    expect(validateResult({}, { type: 'object' }, '')).toEqual([]);
    expect(validateResult('not object', { type: 'object' }, '')).toHaveLength(1);
    expect(validateResult(null, { type: 'object' }, '')).toHaveLength(1);
    expect(validateResult([], { type: 'object' }, '')).toHaveLength(1);
  });

  it('should validate nested object fields', () => {
    const schema: ToolReturnType = {
      type: 'object',
      fields: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };
    expect(validateResult({ name: 'Alice', age: 30 }, schema, '')).toEqual([]);
    expect(validateResult({ name: 'Alice', age: 'thirty' }, schema, '')).toHaveLength(1);
  });

  it('should handle optional fields', () => {
    const schema: ToolReturnType = { type: 'string', optional: true };
    expect(validateResult(null, schema, '')).toEqual([]);
    expect(validateResult(undefined, schema, '')).toEqual([]);
    expect(validateResult('hello', schema, '')).toEqual([]);
  });

  it('should validate deeply nested structures', () => {
    const schema: ToolReturnType = {
      type: 'object',
      fields: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            fields: {
              id: { type: 'number' },
              name: { type: 'string' },
            },
          },
        },
      },
    };

    const valid = {
      items: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
    };
    expect(validateResult(valid, schema, '')).toEqual([]);

    const invalid = { items: [{ id: 'not-a-number', name: 'A' }] };
    const errors = validateResult(invalid, schema, '');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toContain('items[0].id');
  });

  it('should skip validation for unknown types', () => {
    expect(validateResult('anything', { type: 'custom_type' }, '')).toEqual([]);
  });

  it('should validate integer subtype', () => {
    expect(validateResult(42, { type: 'integer' }, '')).toEqual([]);
    expect(validateResult('not number', { type: 'integer' }, '')).toHaveLength(1);
  });
});
