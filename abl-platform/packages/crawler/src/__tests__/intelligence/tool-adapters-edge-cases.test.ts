/**
 * Edge case tests for jsonSchemaToZod in tool-adapters.ts
 *
 * Covers:
 *   B1: array type with missing `items` — was crashing on undefined.type
 *   B2: oneOf/anyOf with 0 or 1 schemas — z.union() requires ≥2
 *   G1: schema.type as array (e.g., ["string", "null"]) — nullable patterns
 */

import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod, convertTools } from '@agent-platform/llm';

describe('jsonSchemaToZod — edge cases', () => {
  // ==========================================================================
  // B1: array type with no `items`
  // ==========================================================================

  describe('B1: array with missing items', () => {
    it('does not crash when items is undefined', () => {
      expect(() => jsonSchemaToZod({ type: 'array' })).not.toThrow();
    });

    it('returns z.array(z.any()) for array with no items', () => {
      const schema = jsonSchemaToZod({ type: 'array' });
      // Should accept any array
      expect(schema.safeParse([1, 'two', true]).success).toBe(true);
      expect(schema.safeParse([]).success).toBe(true);
      // Should reject non-arrays
      expect(schema.safeParse('not an array').success).toBe(false);
      expect(schema.safeParse(42).success).toBe(false);
    });

    it('still works correctly when items IS provided', () => {
      const schema = jsonSchemaToZod({
        type: 'array',
        items: { type: 'string' },
      });
      expect(schema.safeParse(['a', 'b']).success).toBe(true);
      expect(schema.safeParse([1, 2]).success).toBe(false);
    });

    it('respects minItems/maxItems even without items schema', () => {
      const schema = jsonSchemaToZod({
        type: 'array',
        minItems: 1,
        maxItems: 3,
      });
      expect(schema.safeParse([]).success).toBe(false);
      expect(schema.safeParse([1]).success).toBe(true);
      expect(schema.safeParse([1, 2, 3]).success).toBe(true);
      expect(schema.safeParse([1, 2, 3, 4]).success).toBe(false);
    });
  });

  // ==========================================================================
  // B2: oneOf/anyOf with 0 or 1 schemas
  // ==========================================================================

  describe('B2: oneOf/anyOf edge cases', () => {
    it('does not crash when oneOf has 0 schemas', () => {
      expect(() => jsonSchemaToZod({ oneOf: [] })).not.toThrow();
    });

    it('returns z.any() for empty oneOf', () => {
      const schema = jsonSchemaToZod({ oneOf: [] });
      expect(schema.safeParse('anything').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(true);
    });

    it('does not crash when oneOf has 1 schema', () => {
      expect(() => jsonSchemaToZod({ oneOf: [{ type: 'string' }] })).not.toThrow();
    });

    it('returns the single schema when oneOf has 1 entry', () => {
      const schema = jsonSchemaToZod({ oneOf: [{ type: 'string' }] });
      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(false);
    });

    it('works normally with 2+ schemas in oneOf', () => {
      const schema = jsonSchemaToZod({
        oneOf: [{ type: 'string' }, { type: 'number' }],
      });
      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse(true).success).toBe(false);
    });

    it('does not crash when anyOf has 0 schemas', () => {
      expect(() => jsonSchemaToZod({ anyOf: [] })).not.toThrow();
      const schema = jsonSchemaToZod({ anyOf: [] });
      expect(schema.safeParse('anything').success).toBe(true);
    });

    it('does not crash when anyOf has 1 schema', () => {
      const schema = jsonSchemaToZod({ anyOf: [{ type: 'number' }] });
      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse('nope').success).toBe(false);
    });

    it('works normally with 2+ schemas in anyOf', () => {
      const schema = jsonSchemaToZod({
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
      });
      expect(schema.safeParse(true).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse('nope').success).toBe(false);
    });
  });

  // ==========================================================================
  // G1: schema.type as array (e.g., ["string", "null"])
  // ==========================================================================

  describe('G1: type as array (nullable patterns)', () => {
    it('handles ["string", "null"] as union', () => {
      const schema = jsonSchemaToZod({ type: ['string', 'null'] });
      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(42).success).toBe(false);
    });

    it('handles ["number", "null"] as union', () => {
      const schema = jsonSchemaToZod({ type: ['number', 'null'] });
      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse('nope').success).toBe(false);
    });

    it('handles single-element type array', () => {
      const schema = jsonSchemaToZod({ type: ['boolean'] });
      expect(schema.safeParse(true).success).toBe(true);
      expect(schema.safeParse('nope').success).toBe(false);
    });

    it('handles empty type array as z.any()', () => {
      const schema = jsonSchemaToZod({ type: [] });
      expect(schema.safeParse('anything').success).toBe(true);
    });

    it('handles ["string", "number", "null"] as union', () => {
      const schema = jsonSchemaToZod({ type: ['string', 'number', 'null'] });
      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(true).success).toBe(false);
    });
  });

  // ==========================================================================
  // convertTools with edge-case schemas
  // ==========================================================================

  describe('convertTools with edge-case tool schemas', () => {
    it('converts tool with array-no-items param without crashing', () => {
      const tools = [
        {
          name: 'test_tool',
          description: 'Test',
          input_schema: {
            type: 'object' as const,
            properties: {
              tags: { type: 'array' },
            },
          },
        },
      ];

      expect(() => convertTools(tools)).not.toThrow();
      const result = convertTools(tools);
      expect(result.test_tool).toBeDefined();
      expect(result.test_tool.description).toBe('Test');
    });

    it('converts tool with oneOf single-schema param', () => {
      const tools = [
        {
          name: 'flex_tool',
          description: 'Flexible',
          input_schema: {
            type: 'object' as const,
            properties: {
              value: { oneOf: [{ type: 'string' }] },
            },
          },
        },
      ];

      expect(() => convertTools(tools)).not.toThrow();
    });

    it('converts tool with nullable type array param', () => {
      const tools = [
        {
          name: 'nullable_tool',
          description: 'Nullable',
          input_schema: {
            type: 'object' as const,
            properties: {
              name: { type: ['string', 'null'] },
            },
          },
        },
      ];

      expect(() => convertTools(tools)).not.toThrow();
    });
  });
});
