/**
 * Tool Utilities Tests
 *
 * Tests for JSON Schema generation and test data generation functions.
 * These functions are critical for LLM tool calling and the test panel.
 */

import { describe, test, expect } from 'vitest';
import {
  buildInputSchemaFromParams,
  generateDummyDataFromSchema,
  type ParameterDefinition,
} from '../tool-utils';

// =============================================================================
// buildInputSchemaFromParams Tests
// =============================================================================

describe('buildInputSchemaFromParams', () => {
  // Basic parameter types
  test('generates schema for string parameter', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'username',
        type: 'string',
        description: 'User name',
        required: true,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'User name',
        },
      },
      required: ['username'],
    });
  });

  test('generates schema for number parameter', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'age',
        type: 'number',
        description: 'User age',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        age: {
          type: 'number',
          description: 'User age',
        },
      },
    });
  });

  test('generates schema for boolean parameter', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'enabled',
        type: 'boolean',
        description: 'Is enabled',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.enabled.type).toBe('boolean');
  });

  // Enum types
  test('handles enum types with values', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'status',
        type: 'enum',
        description: 'Status',
        required: false,
        enumValues: ['active', 'inactive', 'pending'],
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.status).toEqual({
      type: 'string',
      enum: ['active', 'inactive', 'pending'],
      description: 'Status',
    });
  });

  test('filters empty enum values', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'status',
        type: 'enum',
        description: 'Status',
        required: false,
        enumValues: ['active', '', 'inactive', null as any, 'pending'],
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.status.enum).toEqual(['active', 'inactive', 'pending']);
  });

  test('handles enum without enumValues', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'status',
        type: 'enum',
        description: 'Status',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.status.enum).toEqual([]);
  });

  // Object types
  test('handles object type with valid JSON schema', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'user',
        type: 'object',
        description: 'User data',
        required: false,
        objectSchema: JSON.stringify({
          name: { type: 'string' },
          age: { type: 'number' },
        }),
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.user).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      description: 'User data',
    });
  });

  test('handles object type with invalid JSON schema gracefully', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'data',
        type: 'object',
        description: 'Data',
        required: false,
        objectSchema: '{invalid-json}',
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    // Should not throw, just skip invalid schema
    expect(schema!.properties.data).toEqual({
      type: 'object',
      description: 'Data',
    });
  });

  test('handles object type without objectSchema', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'config',
        type: 'object',
        description: 'Configuration',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.config).toEqual({
      type: 'object',
      description: 'Configuration',
    });
  });

  // Array types
  test('handles array type with valid item schema', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'tags',
        type: 'array',
        description: 'Tag list',
        required: false,
        objectSchema: JSON.stringify({ type: 'string' }),
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.tags).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: 'Tag list',
    });
  });

  test('handles array type with object items', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'users',
        type: 'array',
        description: 'User list',
        required: false,
        objectSchema: JSON.stringify({
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
        }),
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.users.type).toBe('array');
    expect(schema!.properties.users.items!.type).toBe('object');
    expect(schema!.properties.users.items!.properties!.name.type).toBe('string');
  });

  test('handles array type with invalid JSON schema gracefully', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'items',
        type: 'array',
        description: 'Items',
        required: false,
        objectSchema: '{invalid}',
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    // Should not throw, just skip invalid schema
    expect(schema!.properties.items).toEqual({
      type: 'array',
      description: 'Items',
    });
  });

  // Multiple parameters
  test('handles multiple parameters with mixed types', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'name',
        type: 'string',
        description: 'Name',
        required: true,
      },
      {
        name: 'age',
        type: 'number',
        description: 'Age',
        required: false,
      },
      {
        name: 'status',
        type: 'enum',
        description: 'Status',
        required: true,
        enumValues: ['active', 'inactive'],
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(Object.keys(schema!.properties)).toHaveLength(3);
    expect(schema!.required).toEqual(['name', 'status']);
  });

  // Edge cases
  test('handles empty parameter array', () => {
    const schema = buildInputSchemaFromParams([]);
    expect(schema).toBeNull();
  });

  test('handles null/undefined parameters', () => {
    const schema1 = buildInputSchemaFromParams(null as any);
    expect(schema1).toBeNull();

    const schema2 = buildInputSchemaFromParams(undefined as any);
    expect(schema2).toBeNull();
  });

  test('skips parameters with empty name', () => {
    const params: ParameterDefinition[] = [
      {
        name: '',
        type: 'string',
        description: 'Test',
        required: false,
      },
      {
        name: 'valid',
        type: 'string',
        description: 'Valid param',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(Object.keys(schema!.properties)).toHaveLength(1);
    expect(schema!.properties.valid).toBeDefined();
  });

  test('handles parameters without description', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'param1',
        type: 'string',
        description: '',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.properties.param1).toEqual({ type: 'string' });
  });

  test('omits required array when no required parameters', () => {
    const params: ParameterDefinition[] = [
      {
        name: 'optional1',
        type: 'string',
        description: 'Optional',
        required: false,
      },
    ];
    const schema = buildInputSchemaFromParams(params);
    expect(schema!.required).toBeUndefined();
  });
});

// =============================================================================
// generateDummyDataFromSchema Tests
// =============================================================================

describe('generateDummyDataFromSchema', () => {
  // Context-aware string generation
  test('generates context-aware email for "email" field', () => {
    const schema = {
      type: 'object',
      properties: {
        email: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.email).toBe('user@example.com');
  });

  test('generates context-aware email for fields containing "email"', () => {
    const schema = {
      type: 'object',
      properties: {
        userEmail: { type: 'string' },
        contactEmail: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.userEmail).toBe('user@example.com');
    expect(data.contactEmail).toBe('user@example.com');
  });

  test('generates context-aware URL for "url" field', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
        apiUrl: { type: 'string' },
        endpoint: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.url).toBe('https://api.example.com');
    expect(data.apiUrl).toBe('https://api.example.com');
    expect(data.endpoint).toBe('https://api.example.com');
  });

  test('generates context-aware phone for "phone" field', () => {
    const schema = {
      type: 'object',
      properties: {
        phone: { type: 'string' },
        phoneNumber: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.phone).toBe('+1-555-0100');
    expect(data.phoneNumber).toBe('+1-555-0100');
  });

  test('generates context-aware name for "name" field', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        userName: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.name).toBe('John Doe');
    expect(data.userName).toBe('John Doe');
  });

  test('generates context-aware ID for "id" field', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.id).toBe('abc123');
    expect(data.userId).toBe('abc123');
  });

  test('generates context-aware address fields', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.address).toBe('123 Main St');
    expect(data.city).toBe('San Francisco');
    expect(data.country).toBe('USA');
  });

  test('generates context-aware description and message', () => {
    const schema = {
      type: 'object',
      properties: {
        description: { type: 'string' },
        message: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.description).toBe('Sample description');
    expect(data.message).toBe('Hello, this is a test message');
  });

  test('generates generic string for unrecognized fields', () => {
    const schema = {
      type: 'object',
      properties: {
        customField: { type: 'string' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.customField).toBe('example');
  });

  // Number and integer types
  test('generates number with default range', () => {
    const schema = {
      type: 'object',
      properties: {
        score: { type: 'number' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(typeof data.score).toBe('number');
    expect(data.score).toBe(50); // (0 + 100) / 2
  });

  test('generates integer with default range', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(Number.isInteger(data.count)).toBe(true);
    expect(data.count).toBe(50);
  });

  test('respects minimum and maximum for numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        age: {
          type: 'number',
          minimum: 18,
          maximum: 65,
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.age).toBe(41.5); // (18 + 65) / 2
  });

  test('respects minimum and maximum for integers', () => {
    const schema = {
      type: 'object',
      properties: {
        rating: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.rating).toBe(3); // floor((1 + 5) / 2)
  });

  // Boolean type
  test('generates false for boolean fields', () => {
    const schema = {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        active: { type: 'boolean' },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.enabled).toBe(false);
    expect(data.active).toBe(false);
  });

  // Enum with default
  test('uses default value when available', () => {
    const schema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          default: 'active',
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.status).toBe('active');
  });

  test('uses first enum value when available', () => {
    const schema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'active', 'inactive'],
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.status).toBe('pending');
  });

  test('prefers default over enum', () => {
    const schema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'active', 'inactive'],
          default: 'active',
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.status).toBe('active');
  });

  // Array types
  test('generates array of strings', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(Array.isArray(data.tags)).toBe(true);
    expect(data.tags).toEqual(['item1', 'item2']);
  });

  test('generates array of numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          items: { type: 'number' },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(Array.isArray(data.scores)).toBe(true);
    expect(data.scores).toEqual([1, 2, 3]);
  });

  test('generates array of integers', () => {
    const schema = {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'integer' },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(Array.isArray(data.ids)).toBe(true);
    expect(data.ids).toEqual([1, 2, 3]);
  });

  test('generates array of objects recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users).toHaveLength(1);
    expect((data.users as Record<string, unknown>[])[0]).toEqual({
      name: 'John Doe',
      email: 'user@example.com',
    });
  });

  test('generates empty array when no items schema', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.items).toEqual([]);
  });

  test('generates empty array for unknown item types', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'unknown' },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.items).toEqual([]);
  });

  // Nested objects
  test('handles nested objects recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            contact: {
              type: 'object',
              properties: {
                email: { type: 'string' },
                phone: { type: 'string' },
              },
            },
          },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.user).toBeDefined();
    expect(data.user).toEqual({
      name: 'John Doe',
      contact: {
        email: 'user@example.com',
        phone: '+1-555-0100',
      },
    });
  });

  test('generates empty object when no properties', () => {
    const schema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.config).toEqual({});
  });

  // Array type handling
  test('handles array type field', () => {
    const schema = {
      type: 'object',
      properties: {
        field: {
          type: ['string', 'null'],
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data.field).toBe('example');
  });

  // Edge cases
  test('returns empty object for null schema', () => {
    const data = generateDummyDataFromSchema(
      null as unknown as Parameters<typeof generateDummyDataFromSchema>[0],
    );
    expect(data).toEqual({});
  });

  test('returns empty object for undefined schema', () => {
    const data = generateDummyDataFromSchema(
      undefined as unknown as Parameters<typeof generateDummyDataFromSchema>[0],
    );
    expect(data).toEqual({});
  });

  test('returns empty object for schema without properties', () => {
    const schema = { type: 'object' };
    const data = generateDummyDataFromSchema(schema);
    expect(data).toEqual({});
  });

  test('handles complex nested schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        active: { type: 'boolean' },
        status: { type: 'string', enum: ['active', 'inactive'], default: 'active' },
        tags: { type: 'array', items: { type: 'string' } },
        profile: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            phone: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                city: { type: 'string' },
                country: { type: 'string' },
              },
            },
          },
        },
      },
    };
    const data = generateDummyDataFromSchema(schema);
    expect(data).toEqual({
      name: 'John Doe',
      age: 60,
      active: false,
      status: 'active',
      tags: ['item1', 'item2'],
      profile: {
        email: 'user@example.com',
        phone: '+1-555-0100',
        address: {
          city: 'San Francisco',
          country: 'USA',
        },
      },
    });
  });
});
