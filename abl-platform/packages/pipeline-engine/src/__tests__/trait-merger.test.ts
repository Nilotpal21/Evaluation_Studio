import { describe, test, expect } from 'vitest';
import { mergeTraitFields } from '../pipeline/trait-merger.js';
import type { NodeTypeDefinitionDoc, ConfigFieldDefinition } from '../pipeline/types.js';

function makeDoc(overrides: Partial<NodeTypeDefinitionDoc>): NodeTypeDefinitionDoc {
  return {
    _id: 'test-node',
    tenantId: 'SYSTEM',
    label: 'Test',
    description: 'Test node',
    category: 'compute',
    executionModel: 'async',
    defaultTimeout: 60000,
    defaultRetries: 0,
    traits: [],
    configSchema: [],
    version: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('mergeTraitFields', () => {
  test('returns configSchema unchanged when traits is empty', () => {
    const doc = makeDoc({
      configSchema: [
        { name: 'foo', type: 'string', required: true, label: 'Foo', description: 'A foo' },
      ],
    });
    const result = mergeTraitFields(doc);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('foo');
  });

  test('compute trait does not inject sourceStep (replaced by execution context)', () => {
    const doc = makeDoc({ traits: ['compute'] });
    const result = mergeTraitFields(doc);
    const sourceStep = result.find((f) => f.name === 'sourceStep');
    expect(sourceStep).toBeUndefined();
  });

  test('merges model for llm trait', () => {
    const doc = makeDoc({ traits: ['llm'] });
    const result = mergeTraitFields(doc);
    const model = result.find((f) => f.name === 'model');
    expect(model).toBeDefined();
    expect(model!.type).toBe('string');
    expect(model!.required).toBe(false);
    expect(model!.group).toBe('advanced');
  });

  test('merges skipDirectWrite for storage trait', () => {
    const doc = makeDoc({ traits: ['storage'] });
    const result = mergeTraitFields(doc);
    const skip = result.find((f) => f.name === 'skipDirectWrite');
    expect(skip).toBeDefined();
    expect(skip!.type).toBe('boolean');
    expect(skip!.default).toBe(false);
    expect(skip!.required).toBe(false);
  });

  test('merges all three traits together', () => {
    const doc = makeDoc({
      traits: ['compute', 'llm', 'storage'],
      configSchema: [
        {
          name: 'threshold',
          type: 'number',
          required: false,
          label: 'Threshold',
          description: 'Score threshold',
        },
      ],
    });
    const result = mergeTraitFields(doc);
    const names = result.map((f) => f.name);
    expect(names).toContain('threshold');
    expect(names).not.toContain('sourceStep');
    expect(names).toContain('model');
    expect(names).toContain('skipDirectWrite');
    expect(result).toHaveLength(3);
  });

  test('compute trait adds no fields even when configSchema is empty', () => {
    const doc = makeDoc({
      traits: ['compute'],
      configSchema: [],
    });
    const result = mergeTraitFields(doc);
    expect(result).toHaveLength(0);
  });

  test('preserves order: existing fields first, then trait fields', () => {
    const doc = makeDoc({
      traits: ['compute', 'llm'],
      configSchema: [
        { name: 'alpha', type: 'string', required: true, label: 'Alpha', description: 'First' },
        { name: 'beta', type: 'number', required: false, label: 'Beta', description: 'Second' },
      ],
    });
    const result = mergeTraitFields(doc);
    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('beta');
    expect(result[2].name).toBe('model');
    expect(result).toHaveLength(3);
  });

  test('returns empty array for empty traits and empty configSchema', () => {
    const doc = makeDoc({ traits: [], configSchema: [] });
    const result = mergeTraitFields(doc);
    expect(result).toHaveLength(0);
  });
});
