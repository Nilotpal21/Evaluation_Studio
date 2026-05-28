import { describe, test, expect } from 'vitest';
import {
  buildJsonSchema,
  parseJsonSchemaToFields,
  isValidFieldName,
  type SchemaField,
} from '../SchemaFieldBuilder';

describe('buildJsonSchema', () => {
  test('generates schema from fields with all types', () => {
    const fields: SchemaField[] = [
      { name: 'score', type: 'number', description: 'Quality score 0-1' },
      { name: 'summary', type: 'string', description: 'Brief summary' },
      { name: 'issues', type: 'string[]', description: 'List of issues found' },
      { name: 'passed', type: 'boolean', description: '' },
    ];

    const schema = buildJsonSchema(fields);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        score: { type: 'number', description: 'Quality score 0-1' },
        summary: { type: 'string', description: 'Brief summary' },
        issues: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of issues found',
        },
        passed: { type: 'boolean' },
      },
      required: ['score', 'summary', 'issues', 'passed'],
    });
  });

  test('omits description when empty', () => {
    const fields: SchemaField[] = [{ name: 'value', type: 'number', description: '' }];

    const schema = buildJsonSchema(fields);

    expect((schema as any)!.properties.value).toEqual({ type: 'number' });
    expect((schema as any)!.properties.value).not.toHaveProperty('description');
  });

  test('returns undefined for empty fields array', () => {
    expect(buildJsonSchema([])).toBeUndefined();
  });
});

describe('parseJsonSchemaToFields', () => {
  test('parses flat object schema with supported types', () => {
    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number', description: 'A score' },
        name: { type: 'string' },
        ok: { type: 'boolean', description: 'Pass/fail' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['score', 'name', 'ok', 'tags'],
    };

    const result = parseJsonSchemaToFields(schema);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect(result![0]).toEqual({ name: 'score', type: 'number', description: 'A score' });
    expect(result![1]).toEqual({ name: 'name', type: 'string', description: '' });
    expect(result![2]).toEqual({ name: 'ok', type: 'boolean', description: 'Pass/fail' });
    expect(result![3]).toEqual({ name: 'tags', type: 'string[]', description: 'Tags' });
  });

  test('returns null for schema with unsupported types', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { a: { type: 'string' } } },
      },
    };

    expect(parseJsonSchemaToFields(schema)).toBeNull();
  });

  test('returns null for non-object schema', () => {
    expect(parseJsonSchemaToFields({ type: 'array' })).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    expect(parseJsonSchemaToFields(null)).toBeNull();
    expect(parseJsonSchemaToFields(undefined)).toBeNull();
  });
});

describe('isValidFieldName', () => {
  test('accepts valid names', () => {
    expect(isValidFieldName('score')).toBe(true);
    expect(isValidFieldName('my_field')).toBe(true);
    expect(isValidFieldName('_private')).toBe(true);
    expect(isValidFieldName('Field1')).toBe(true);
  });

  test('rejects invalid names', () => {
    expect(isValidFieldName('')).toBe(false);
    expect(isValidFieldName('1starts_with_digit')).toBe(false);
    expect(isValidFieldName('has space')).toBe(false);
    expect(isValidFieldName('has-dash')).toBe(false);
    expect(isValidFieldName('a'.repeat(65))).toBe(false);
  });
});
