/**
 * Tests for JSON Schema → FieldPreview extraction
 *
 * Validates that when a user provides a JSON Schema definition,
 * field types are derived from the schema (not value inference),
 * and the existing value-based extraction remains unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFieldsFromSchema,
  extractSchema,
  resolveSchemaType,
  normalizeBsonType,
  type JsonSchemaInput,
  type JsonSchemaProperty,
} from '../routes/json-field-config.js';

describe('resolveSchemaType', () => {
  it('maps "string" to string', () => {
    expect(resolveSchemaType({ type: 'string' })).toBe('string');
  });

  it('maps "number" to number', () => {
    expect(resolveSchemaType({ type: 'number' })).toBe('number');
  });

  it('maps "integer" to number', () => {
    expect(resolveSchemaType({ type: 'integer' })).toBe('number');
  });

  it('maps "boolean" to boolean', () => {
    expect(resolveSchemaType({ type: 'boolean' })).toBe('boolean');
  });

  it('maps "array" to array', () => {
    expect(resolveSchemaType({ type: 'array' })).toBe('array');
  });

  it('maps "object" to object', () => {
    expect(resolveSchemaType({ type: 'object' })).toBe('object');
  });

  it('maps string with format "date" to date', () => {
    expect(resolveSchemaType({ type: 'string', format: 'date' })).toBe('date');
  });

  it('maps string with format "date-time" to date', () => {
    expect(resolveSchemaType({ type: 'string', format: 'date-time' })).toBe('date');
  });

  it('maps string with format "time" to date', () => {
    expect(resolveSchemaType({ type: 'string', format: 'time' })).toBe('date');
  });

  it('handles union types ["string", "null"] → string', () => {
    expect(resolveSchemaType({ type: ['string', 'null'] })).toBe('string');
  });

  it('handles union types ["null", "number"] → number', () => {
    expect(resolveSchemaType({ type: ['null', 'number'] })).toBe('number');
  });

  it('handles union types ["null", "integer"] → number', () => {
    expect(resolveSchemaType({ type: ['null', 'integer'] })).toBe('number');
  });

  it('defaults to string when type is missing', () => {
    expect(resolveSchemaType({})).toBe('string');
  });

  it('defaults to string for unknown type', () => {
    expect(resolveSchemaType({ type: 'unknown_thing' })).toBe('string');
  });
});

describe('extractFieldsFromSchema', () => {
  it('extracts flat properties with correct types', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        productname: { type: 'string', maxLength: 100 },
        rate: { type: 'number' },
        inStock: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    const fields = extractFieldsFromSchema(schema);

    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('productname')?.fieldType).toBe('string');
    expect(fieldMap.get('rate')?.fieldType).toBe('number');
    expect(fieldMap.get('inStock')?.fieldType).toBe('boolean');
    expect(fieldMap.get('createdAt')?.fieldType).toBe('date');
    expect(fieldMap.get('tags')?.fieldType).toBe('array');
  });

  it('extracts enum values as sampleValues', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'sold', 'draft'] },
        color: { type: 'string', enum: ['red', 'blue', 'green', 'black', 'white', 'yellow'] },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('status')?.sampleValues).toEqual(['active', 'sold', 'draft']);
    // Only first 5 enum values are taken
    expect(fieldMap.get('color')?.sampleValues).toEqual(['red', 'blue', 'green', 'black', 'white']);
  });

  it('marks required fields as suggested', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      required: ['name', 'sku'],
      properties: {
        name: { type: 'string' },
        sku: { type: 'string' }, // SKU matches SKIP_PATTERNS but is required
        description: { type: 'string', maxLength: 5000 },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('name')?.suggested).toBe(true);
    // Even though 'sku' matches skip patterns, required overrides it
    expect(fieldMap.get('sku')?.suggested).toBe(true);
    expect(fieldMap.get('sku')?.suggestReason).toBe('Required field in schema');
  });

  it('handles nested object properties', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
            latitude: { type: 'number' },
          },
        },
        name: { type: 'string' },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    // Object parent should not appear (same as value-based extraction)
    expect(fieldMap.has('address')).toBe(false);

    // Nested fields should have dotted paths
    expect(fieldMap.get('address.city')?.fieldType).toBe('string');
    expect(fieldMap.get('address.zip')?.fieldType).toBe('string');
    expect(fieldMap.get('address.latitude')?.fieldType).toBe('number');
    expect(fieldMap.get('name')?.fieldType).toBe('string');
  });

  it('respects maxDepth for deeply nested schemas', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        level1: {
          type: 'object',
          properties: {
            level2: {
              type: 'object',
              properties: {
                level3: {
                  type: 'object',
                  properties: {
                    tooDeep: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };

    // Default maxDepth=2, so level1.level2.level3.tooDeep should not appear
    const fields = extractFieldsFromSchema(schema);
    const paths = fields.map((f) => f.fieldPath);

    expect(paths).not.toContain('level1.level2.level3.tooDeep');
  });

  it('uses maxLength from schema', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        shortField: { type: 'string', maxLength: 50 },
        longField: { type: 'string', maxLength: 5000 },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('shortField')?.maxLength).toBe(50);
    expect(fieldMap.get('longField')?.maxLength).toBe(5000);
  });

  it('handles integer type (maps to number)', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        price: { type: 'number' },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('count')?.fieldType).toBe('number');
    expect(fieldMap.get('price')?.fieldType).toBe('number');
  });

  it('returns empty array for schema with no properties', () => {
    const schema: JsonSchemaInput = { type: 'object' };
    const fields = extractFieldsFromSchema(schema);
    expect(fields).toEqual([]);
  });

  it('sorts suggested fields first then alphabetically', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        zName: { type: 'string' },
        aPrice: { type: 'number' }, // numbers are auto-suggested
        mDescription: { type: 'string', maxLength: 5000 },
        bActive: { type: 'boolean' }, // booleans are auto-suggested
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const paths = fields.map((f) => f.fieldPath);

    // Suggested fields (number, boolean) come first
    expect(paths.indexOf('aPrice')).toBeLessThan(paths.indexOf('mDescription'));
    expect(paths.indexOf('bActive')).toBeLessThan(paths.indexOf('mDescription'));
  });

  it('handles nullable enum values', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [null, 'active', 'sold', undefined, 'draft'] },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    // null and undefined are excluded from sampleValues
    expect(fieldMap.get('status')?.sampleValues).toEqual(['active', 'sold', 'draft']);
  });

  it('skips system fields same as value-based extraction', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        _id: { type: 'string' },
        uuid: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
        productName: { type: 'string', enum: ['Shirt', 'Shoes'] },
        price: { type: 'number' },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    // System fields should NOT be suggested (but still appear in the list)
    expect(fieldMap.get('_id')?.suggested).toBe(false);
    expect(fieldMap.get('uuid')?.suggested).toBe(false);
    expect(fieldMap.get('created_at')?.suggested).toBe(false);
    // Number field is always suggested
    expect(fieldMap.get('price')?.suggested).toBe(true);
    // String with enum provides sampleValues → short text → suggested
    expect(fieldMap.get('productName')?.suggested).toBe(true);
  });
});

describe('extractSchema (value-based — existing behaviour)', () => {
  it('infers types from values', () => {
    const records = [
      { name: 'Shirt', price: 100, active: true, createdAt: '2024-01-15T10:00:00Z' },
      { name: 'Shoes', price: 200, active: false, createdAt: '2024-02-20T12:00:00Z' },
    ];

    const fields = extractSchema(records);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('name')?.fieldType).toBe('string');
    expect(fieldMap.get('price')?.fieldType).toBe('number');
    expect(fieldMap.get('active')?.fieldType).toBe('boolean');
    expect(fieldMap.get('createdAt')?.fieldType).toBe('date');
  });

  it('treats numeric strings as string (the problem schema solves)', () => {
    const records = [
      { rate: '6200', name: 'Product' },
      { rate: '4500', name: 'Another' },
    ];

    const fields = extractSchema(records);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    // Value-based sees "6200" as a string (typeof === 'string', not matching date regex)
    expect(fieldMap.get('rate')?.fieldType).toBe('string');
  });

  it('schema-based correctly types numeric strings when schema says number', () => {
    const schema: JsonSchemaInput = {
      type: 'object',
      properties: {
        rate: { type: 'number' },
        name: { type: 'string' },
      },
    };

    const fields = extractFieldsFromSchema(schema);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    // Schema-based knows it's a number
    expect(fieldMap.get('rate')?.fieldType).toBe('number');
  });
});

describe('JSON Schema file auto-detection', () => {
  it('a file with type:"object" + properties is detected as schema (not data)', () => {
    // Simulates what happens when user uploads a schema .json file.
    // The route handler detects it and routes to extractFieldsFromSchema.
    // We test the detection logic here by verifying that if such content
    // is passed to extractFieldsFromSchema, it produces correct results.
    const schemaFileContent: JsonSchemaInput = {
      type: 'object',
      required: ['productname', 'rate'],
      properties: {
        productname: { type: 'string', maxLength: 100 },
        rate: { type: 'number' },
        color: { type: 'string', enum: ['black', 'white', 'red'] },
      },
    };

    // Detection criteria: has "properties" + type === "object" + not array
    const isSchema =
      typeof schemaFileContent === 'object' &&
      schemaFileContent !== null &&
      !Array.isArray(schemaFileContent) &&
      'properties' in schemaFileContent &&
      typeof schemaFileContent.properties === 'object' &&
      schemaFileContent.type === 'object';

    expect(isSchema).toBe(true);

    // And the schema extraction works on it
    const fields = extractFieldsFromSchema(schemaFileContent);
    const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

    expect(fieldMap.get('rate')?.fieldType).toBe('number');
    expect(fieldMap.get('productname')?.fieldType).toBe('string');
    expect(fieldMap.get('color')?.sampleValues).toEqual(['black', 'white', 'red']);
  });

  it('a regular data file is NOT detected as schema', () => {
    // Regular JSON data array
    const dataFile = [{ productname: 'Shirt', rate: '6200' }];
    const isSchema =
      typeof dataFile === 'object' &&
      dataFile !== null &&
      !Array.isArray(dataFile) &&
      'properties' in dataFile;

    expect(isSchema).toBe(false); // Arrays are caught by !Array.isArray
  });

  it('a data object without "type":"object" is NOT detected as schema', () => {
    // A single record that happens to have a "properties" key
    const dataWithProperties = {
      name: 'Widget',
      properties: { color: 'red', size: 'large' },
    };

    const isSchema =
      typeof dataWithProperties === 'object' &&
      dataWithProperties !== null &&
      !Array.isArray(dataWithProperties) &&
      'properties' in dataWithProperties &&
      typeof (dataWithProperties as any).properties === 'object' &&
      (dataWithProperties as any).type === 'object';

    // Missing type:"object" so it's not a schema
    expect(isSchema).toBe(false);
  });
});

describe('MongoDB $jsonSchema / bsonType support', () => {
  describe('normalizeBsonType', () => {
    it('maps "int" to number', () => {
      expect(normalizeBsonType('int')).toBe('number');
    });

    it('maps "long" to number', () => {
      expect(normalizeBsonType('long')).toBe('number');
    });

    it('maps "double" to number', () => {
      expect(normalizeBsonType('double')).toBe('number');
    });

    it('maps "decimal" to number', () => {
      expect(normalizeBsonType('decimal')).toBe('number');
    });

    it('maps "bool" to boolean', () => {
      expect(normalizeBsonType('bool')).toBe('boolean');
    });

    it('maps "date" to date', () => {
      expect(normalizeBsonType('date')).toBe('date');
    });

    it('maps "timestamp" to date', () => {
      expect(normalizeBsonType('timestamp')).toBe('date');
    });

    it('maps "objectId" to string', () => {
      expect(normalizeBsonType('objectId')).toBe('string');
    });

    it('maps "object" to object', () => {
      expect(normalizeBsonType('object')).toBe('object');
    });

    it('maps "array" to array', () => {
      expect(normalizeBsonType('array')).toBe('array');
    });

    it('maps "binData" to string', () => {
      expect(normalizeBsonType('binData')).toBe('string');
    });

    it('maps "regex" to string', () => {
      expect(normalizeBsonType('regex')).toBe('string');
    });

    it('maps unknown bsonType to string', () => {
      expect(normalizeBsonType('minKey')).toBe('string');
    });
  });

  describe('resolveSchemaType with bsonType', () => {
    it('uses bsonType when present (takes precedence over type)', () => {
      expect(resolveSchemaType({ bsonType: 'int' })).toBe('number');
      expect(resolveSchemaType({ bsonType: 'date' })).toBe('date');
      expect(resolveSchemaType({ bsonType: 'objectId' })).toBe('string');
    });

    it('handles bsonType array union ["null", "int"] → number', () => {
      expect(resolveSchemaType({ bsonType: ['null', 'int'] })).toBe('number');
    });

    it('handles bsonType array union ["string", "null"] → string', () => {
      expect(resolveSchemaType({ bsonType: ['string', 'null'] })).toBe('string');
    });

    it('handles bsonType array union ["null", "string"] → string', () => {
      expect(resolveSchemaType({ bsonType: ['null', 'string'] })).toBe('string');
    });

    it('handles bsonType array with all nulls → defaults to string', () => {
      expect(resolveSchemaType({ bsonType: ['null'] })).toBe('string');
    });

    it('bsonType takes precedence over type if both present', () => {
      // Unlikely in practice, but bsonType should win
      expect(resolveSchemaType({ type: 'string', bsonType: 'int' })).toBe('number');
    });

    it('falls back to type when bsonType not present', () => {
      expect(resolveSchemaType({ type: 'number' })).toBe('number');
      expect(resolveSchemaType({ type: 'boolean' })).toBe('boolean');
    });
  });

  describe('extractFieldsFromSchema with MongoDB $jsonSchema', () => {
    it('extracts fields from a MongoDB validator schema (bsonType)', () => {
      const mongoSchema: JsonSchemaInput = {
        bsonType: 'object',
        required: ['planName', 'benefit', 'startEffectiveDatetime'],
        properties: {
          _id: { bsonType: 'objectId' },
          benefit: { bsonType: 'array', items: { bsonType: 'string' } },
          endEffectiveDatetime: { bsonType: 'date' },
          href: { bsonType: 'string' },
          planName: { bsonType: 'string' },
          productCondition: { bsonType: 'string' },
          startEffectiveDatetime: { bsonType: 'date' },
        },
      };

      const fields = extractFieldsFromSchema(mongoSchema);
      const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

      // _id is objectId → string but skipped by SKIP_PATTERNS for suggestion
      expect(fieldMap.get('_id')?.fieldType).toBe('string');
      expect(fieldMap.get('_id')?.suggested).toBe(false);

      // benefit is array
      expect(fieldMap.get('benefit')?.fieldType).toBe('array');
      expect(fieldMap.get('benefit')?.suggested).toBe(true);

      // dates
      expect(fieldMap.get('endEffectiveDatetime')?.fieldType).toBe('date');
      expect(fieldMap.get('startEffectiveDatetime')?.fieldType).toBe('date');

      // strings
      expect(fieldMap.get('planName')?.fieldType).toBe('string');
      expect(fieldMap.get('productCondition')?.fieldType).toBe('string');

      // href matches SKIP_PATTERNS
      expect(fieldMap.get('href')?.suggested).toBe(false);

      // required fields are suggested
      expect(fieldMap.get('planName')?.suggested).toBe(true);
    });

    it('recurses into array items with bsonType: "object" + properties', () => {
      const mongoSchema: JsonSchemaInput = {
        bsonType: 'object',
        properties: {
          tier: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['pricePerMonth'],
              properties: {
                deviceReplacementPrice: { bsonType: ['null', 'int'] },
                pricePerMonth: { bsonType: ['int', 'null'] },
                pricePerYear: { bsonType: ['int', 'null'] },
                productIncluded: { bsonType: ['null', 'string'] },
                productPriceRange: { bsonType: ['string', 'null'] },
              },
            },
          },
        },
      };

      const fields = extractFieldsFromSchema(mongoSchema);
      const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

      // Array parent "tier" should not appear (recurses into items)
      expect(fieldMap.has('tier')).toBe(false);

      // Nested fields under tier
      expect(fieldMap.get('tier.deviceReplacementPrice')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.pricePerMonth')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.pricePerYear')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.productIncluded')?.fieldType).toBe('string');
      expect(fieldMap.get('tier.productPriceRange')?.fieldType).toBe('string');

      // pricePerMonth is required in items
      expect(fieldMap.get('tier.pricePerMonth')?.suggested).toBe(true);
    });

    it('handles the full MongoDB test schema (real-world case)', () => {
      // This is the exact schema from the user's test.json (inner $jsonSchema content)
      const mongoSchema: JsonSchemaInput = {
        bsonType: 'object',
        required: [
          '_id',
          'benefit',
          'endEffectiveDatetime',
          'href',
          'planName',
          'productCondition',
          'startEffectiveDatetime',
          'tier',
        ],
        properties: {
          _id: { bsonType: 'objectId' },
          benefit: { bsonType: 'array', items: { bsonType: 'string' } },
          endEffectiveDatetime: { bsonType: 'date' },
          href: { bsonType: 'string' },
          planName: { bsonType: 'string' },
          productCondition: { bsonType: 'string' },
          startEffectiveDatetime: { bsonType: 'date' },
          tier: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              properties: {
                deviceReplacementPrice: { bsonType: ['null', 'int'] },
                pricePerMonth: { bsonType: ['int', 'null'] },
                pricePerYear: { bsonType: ['int', 'null'] },
                productIncluded: { bsonType: ['null', 'string'] },
                productPriceRange: { bsonType: ['string', 'null'] },
                screenReplacementPrice: { bsonType: ['null', 'int'] },
                twoYearPackagePrice: { bsonType: ['null', 'int'] },
              },
              required: [
                'deviceReplacementPrice',
                'pricePerMonth',
                'pricePerYear',
                'productIncluded',
                'productPriceRange',
                'screenReplacementPrice',
                'twoYearPackagePrice',
              ],
            },
          },
        },
      };

      const fields = extractFieldsFromSchema(mongoSchema);
      const fieldMap = new Map(fields.map((f) => [f.fieldPath, f]));

      // Top-level fields
      expect(fieldMap.get('benefit')?.fieldType).toBe('array');
      expect(fieldMap.get('endEffectiveDatetime')?.fieldType).toBe('date');
      expect(fieldMap.get('startEffectiveDatetime')?.fieldType).toBe('date');
      expect(fieldMap.get('planName')?.fieldType).toBe('string');
      expect(fieldMap.get('productCondition')?.fieldType).toBe('string');

      // Nested tier fields (array of objects → flattened)
      expect(fieldMap.get('tier.deviceReplacementPrice')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.pricePerMonth')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.pricePerYear')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.productIncluded')?.fieldType).toBe('string');
      expect(fieldMap.get('tier.productPriceRange')?.fieldType).toBe('string');
      expect(fieldMap.get('tier.screenReplacementPrice')?.fieldType).toBe('number');
      expect(fieldMap.get('tier.twoYearPackagePrice')?.fieldType).toBe('number');

      // tier array parent should NOT appear as its own field
      expect(fieldMap.has('tier')).toBe(false);

      // All numeric fields should be suggested
      expect(fieldMap.get('tier.deviceReplacementPrice')?.suggested).toBe(true);
      expect(fieldMap.get('tier.pricePerMonth')?.suggested).toBe(true);
    });
  });

  describe('$jsonSchema wrapper detection', () => {
    it('detects {"$jsonSchema": {"bsonType": "object", "properties": {...}}}', () => {
      // Simulates what the route handler does when detecting schema format
      const fileContent = {
        $jsonSchema: {
          bsonType: 'object',
          properties: {
            name: { bsonType: 'string' },
          },
        },
      };

      let schemaCandidate: any = fileContent;

      // Unwrap $jsonSchema
      if ('$jsonSchema' in fileContent && typeof (fileContent as any).$jsonSchema === 'object') {
        schemaCandidate = (fileContent as any).$jsonSchema;
      }

      const hasProperties =
        'properties' in schemaCandidate && typeof schemaCandidate.properties === 'object';
      const isMongoSchema =
        schemaCandidate.bsonType === 'object' ||
        (Array.isArray(schemaCandidate.bsonType) && schemaCandidate.bsonType.includes('object'));

      expect(hasProperties).toBe(true);
      expect(isMongoSchema).toBe(true);

      // And extraction works
      const fields = extractFieldsFromSchema(schemaCandidate);
      expect(fields.length).toBe(1);
      expect(fields[0].fieldPath).toBe('name');
      expect(fields[0].fieldType).toBe('string');
    });

    it('does NOT detect a regular data object as MongoDB schema', () => {
      const regularData = {
        name: 'Product',
        price: 100,
        properties: { color: 'red' }, // has "properties" but no bsonType/type
      };

      let schemaCandidate: any = regularData;

      if ('$jsonSchema' in regularData) {
        schemaCandidate = (regularData as any).$jsonSchema;
      }

      const hasProperties =
        'properties' in schemaCandidate && typeof schemaCandidate.properties === 'object';
      const isStandardSchema = schemaCandidate.type === 'object';
      const isMongoSchema =
        schemaCandidate.bsonType === 'object' ||
        (Array.isArray(schemaCandidate.bsonType) && schemaCandidate.bsonType?.includes('object'));

      // Has properties but no type/bsonType = "object" → not a schema
      expect(hasProperties).toBe(true);
      expect(isStandardSchema).toBe(false);
      expect(isMongoSchema).toBe(false);
    });
  });
});
