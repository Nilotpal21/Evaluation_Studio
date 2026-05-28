/**
 * Base Schema Discovery Service Tests
 *
 * Tests for schema change detection and field mapping updates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseSchemaDiscoveryService, type DiscoveryResult } from '../base-discovery.service.js';
import type { IConnectorSchemaField } from '@agent-platform/database/models';

// ─── Test Implementation ─────────────────────────────────────────────────────

class TestDiscoveryService extends BaseSchemaDiscoveryService {
  constructor() {
    super('test-connector');
  }

  async discover(): Promise<DiscoveryResult> {
    return {
      fields: [],
      fieldCount: 0,
      customFieldCount: 0,
    };
  }

  // Expose protected methods for testing
  public detectSchemaChangesPublic(
    oldFields: IConnectorSchemaField[],
    newFields: IConnectorSchemaField[],
  ) {
    return this.detectSchemaChanges(oldFields, newFields);
  }

  public detectFieldTypePublic(sampleValues: unknown[]) {
    return this.detectFieldType(sampleValues);
  }

  public extractFieldPathsPublic(obj: Record<string, unknown>, prefix = '', maxDepth = 3) {
    return this.extractFieldPaths(obj, prefix, maxDepth);
  }

  public calculateFieldFrequencyPublic(samples: Record<string, unknown>[]) {
    return this.calculateFieldFrequency(samples);
  }

  public collectSampleValuesPublic(
    samples: Record<string, unknown>[],
    fieldPath: string,
    maxSamples = 5,
  ) {
    return this.collectSampleValues(samples, fieldPath, maxSamples);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BaseSchemaDiscoveryService', () => {
  let service: TestDiscoveryService;

  beforeEach(() => {
    service = new TestDiscoveryService();
  });

  describe('detectSchemaChanges', () => {
    it('should detect no changes when fields are identical', () => {
      const fields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
        {
          path: 'field2',
          label: 'Field 2',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const result = service.detectSchemaChangesPublic(fields, fields);

      expect(result.hasChanges).toBe(false);
      expect(result.addedFields).toEqual([]);
      expect(result.removedFields).toEqual([]);
      expect(result.typeChanges).toEqual([]);
      expect(result.totalChanges).toBe(0);
    });

    it('should detect added fields', () => {
      const oldFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const newFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
        {
          path: 'field2',
          label: 'Field 2',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const result = service.detectSchemaChangesPublic(oldFields, newFields);

      expect(result.hasChanges).toBe(true);
      expect(result.addedFields).toEqual(['field2']);
      expect(result.removedFields).toEqual([]);
      expect(result.typeChanges).toEqual([]);
      expect(result.totalChanges).toBe(1);
    });

    it('should detect removed fields', () => {
      const oldFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
        {
          path: 'field2',
          label: 'Field 2',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const newFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const result = service.detectSchemaChangesPublic(oldFields, newFields);

      expect(result.hasChanges).toBe(true);
      expect(result.addedFields).toEqual([]);
      expect(result.removedFields).toEqual(['field2']);
      expect(result.typeChanges).toEqual([]);
      expect(result.totalChanges).toBe(1);
    });

    it('should detect type changes', () => {
      const oldFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const newFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const result = service.detectSchemaChangesPublic(oldFields, newFields);

      expect(result.hasChanges).toBe(true);
      expect(result.addedFields).toEqual([]);
      expect(result.removedFields).toEqual([]);
      expect(result.typeChanges).toEqual([
        { path: 'field1', oldType: 'string', newType: 'number' },
      ]);
      expect(result.totalChanges).toBe(1);
    });

    it('should detect multiple changes', () => {
      const oldFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
        {
          path: 'field2',
          label: 'Field 2',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
        {
          path: 'field3',
          label: 'Field 3',
          type: 'boolean',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        },
      ];

      const newFields: IConnectorSchemaField[] = [
        {
          path: 'field1',
          label: 'Field 1',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        }, // type change
        {
          path: 'field2',
          label: 'Field 2',
          type: 'number',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        }, // no change
        {
          path: 'field4',
          label: 'Field 4',
          type: 'string',
          isCustom: false,
          isRequired: false,
          sampleValues: [],
        }, // added
        // field3 removed
      ];

      const result = service.detectSchemaChangesPublic(oldFields, newFields);

      expect(result.hasChanges).toBe(true);
      expect(result.addedFields).toEqual(['field4']);
      expect(result.removedFields).toEqual(['field3']);
      expect(result.typeChanges).toEqual([
        { path: 'field1', oldType: 'string', newType: 'number' },
      ]);
      expect(result.totalChanges).toBe(3);
    });
  });

  describe('detectFieldType', () => {
    it('should detect string type', () => {
      const result = service.detectFieldTypePublic(['hello', 'world', 'test']);
      expect(result.type).toBe('string');
      expect(result.confidence).toBe(1);
    });

    it('should detect number type', () => {
      const result = service.detectFieldTypePublic([1, 2, 3, 4.5]);
      expect(result.type).toBe('number');
      expect(result.confidence).toBe(1);
    });

    it('should detect boolean type', () => {
      const result = service.detectFieldTypePublic([true, false, true]);
      expect(result.type).toBe('boolean');
      expect(result.confidence).toBe(1);
    });

    it('should detect date type', () => {
      const result = service.detectFieldTypePublic(['2024-01-01', '2024-01-02T10:00:00Z']);
      expect(result.type).toBe('date');
      expect(result.confidence).toBe(1);
    });

    it('should detect array type', () => {
      const result = service.detectFieldTypePublic([
        [1, 2],
        ['a', 'b'],
      ]);
      expect(result.type).toBe('array');
      expect(result.confidence).toBe(1);
    });

    it('should detect object type', () => {
      const result = service.detectFieldTypePublic([{ a: 1 }, { b: 2 }]);
      expect(result.type).toBe('object');
      expect(result.confidence).toBe(1);
    });

    it('should handle mixed types', () => {
      const result = service.detectFieldTypePublic(['hello', 123, 'world']);
      expect(result.type).toBe('string'); // majority type
      expect(result.confidence).toBeCloseTo(0.67, 1);
    });

    it('should handle empty array', () => {
      const result = service.detectFieldTypePublic([]);
      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    it('should handle null values', () => {
      const result = service.detectFieldTypePublic([null, undefined, null]);
      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(0);
    });
  });

  describe('extractFieldPaths', () => {
    it('should extract flat field paths', () => {
      const obj = { field1: 'value1', field2: 'value2' };
      const result = service.extractFieldPathsPublic(obj);
      expect(result).toEqual(['field1', 'field2']);
    });

    it('should extract nested field paths', () => {
      const obj = {
        field1: 'value1',
        nested: {
          field2: 'value2',
          deepNested: {
            field3: 'value3',
          },
        },
      };
      const result = service.extractFieldPathsPublic(obj);
      expect(result).toContain('field1');
      expect(result).toContain('nested');
      expect(result).toContain('nested.field2');
      expect(result).toContain('nested.deepNested');
      expect(result).toContain('nested.deepNested.field3');
    });

    it('should respect max depth', () => {
      const obj = {
        level1: {
          level2: {
            level3: {
              level4: 'too deep',
            },
          },
        },
      };
      const result = service.extractFieldPathsPublic(obj, '', 2);
      expect(result).toContain('level1');
      expect(result).toContain('level1.level2');
      expect(result).not.toContain('level1.level2.level3');
    });

    it('should handle arrays (not recurse)', () => {
      const obj = {
        field1: 'value1',
        arrayField: [1, 2, 3],
      };
      const result = service.extractFieldPathsPublic(obj);
      expect(result).toContain('field1');
      expect(result).toContain('arrayField');
    });
  });

  describe('calculateFieldFrequency', () => {
    it('should calculate frequency across samples', () => {
      const samples = [
        { field1: 'a', field2: 'b' },
        { field1: 'c', field3: 'd' },
        { field1: 'e', field2: 'f' },
      ];

      const result = service.calculateFieldFrequencyPublic(samples);

      expect(result.get('field1')).toBe(1.0); // appears in all 3
      expect(result.get('field2')).toBeCloseTo(0.67, 1); // appears in 2/3
      expect(result.get('field3')).toBeCloseTo(0.33, 1); // appears in 1/3
    });

    it('should handle empty samples', () => {
      const result = service.calculateFieldFrequencyPublic([]);
      expect(result.size).toBe(0);
    });

    it('should handle nested fields', () => {
      const samples = [{ nested: { field1: 'a' } }, { nested: { field1: 'b' } }, { other: 'c' }];

      const result = service.calculateFieldFrequencyPublic(samples);

      expect(result.get('nested')).toBeCloseTo(0.67, 1);
      expect(result.get('nested.field1')).toBeCloseTo(0.67, 1);
      expect(result.get('other')).toBeCloseTo(0.33, 1);
    });
  });

  describe('collectSampleValues', () => {
    it('should collect sample values for a field', () => {
      const samples = [
        { field1: 'a', field2: 'b' },
        { field1: 'c', field2: 'd' },
        { field1: 'e', field2: 'f' },
      ];

      const result = service.collectSampleValuesPublic(samples, 'field1', 5);

      expect(result).toEqual(['a', 'c', 'e']);
    });

    it('should respect max samples', () => {
      const samples = [
        { field1: '1' },
        { field1: '2' },
        { field1: '3' },
        { field1: '4' },
        { field1: '5' },
      ];

      const result = service.collectSampleValuesPublic(samples, 'field1', 3);

      expect(result.length).toBe(3);
      expect(result).toEqual(['1', '2', '3']);
    });

    it('should collect nested field values', () => {
      const samples = [
        { nested: { field1: 'a' } },
        { nested: { field1: 'b' } },
        { nested: { field1: 'c' } },
      ];

      const result = service.collectSampleValuesPublic(samples, 'nested.field1', 5);

      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should skip null/undefined values', () => {
      const samples = [
        { field1: 'a' },
        { field1: null },
        { field1: 'b' },
        { field1: undefined },
        { field1: 'c' },
      ];

      const result = service.collectSampleValuesPublic(samples, 'field1', 5);

      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should handle missing field', () => {
      const samples = [{ field1: 'a' }, { field2: 'b' }, { field1: 'c' }];

      const result = service.collectSampleValuesPublic(samples, 'field1', 5);

      expect(result).toEqual(['a', 'c']);
    });
  });
});
