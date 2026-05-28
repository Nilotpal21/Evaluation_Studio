import { describe, test, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import type { NodeTypeDefinition, NodeTypeDefinitionDoc } from '../pipeline/types.js';

const toxicityNode: NodeTypeDefinition = {
  type: 'compute-toxicity',
  category: 'compute',
  label: 'Toxicity Detection',
  description: 'Score messages for toxicity',
  configSchema: {
    fields: [
      {
        name: 'threshold',
        type: 'number',
        required: true,
        default: 0.7,
        description: 'Score threshold',
      },
      { name: 'categories', type: 'array', required: false, description: 'Categories to evaluate' },
    ],
  },
  executionModel: 'sync',
  defaultTimeout: 120_000,
  defaultRetries: 2,
  retryable: true,
};

const httpNode: NodeTypeDefinition = {
  type: 'http-request',
  category: 'integration',
  label: 'HTTP Request',
  description: 'Make HTTP request',
  configSchema: {
    fields: [
      { name: 'url', type: 'string', required: true, description: 'URL' },
      {
        name: 'method',
        type: 'enum',
        required: true,
        default: 'GET',
        description: 'HTTP method',
        values: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    ],
  },
  executionModel: 'async',
  requiredCapabilities: ['external-http'],
};

const nodeGroupNode: NodeTypeDefinition = {
  type: 'node-group',
  category: 'logic',
  label: 'Parallel Group',
  description: 'Execute nodes in parallel',
  configSchema: { fields: [] },
  executionModel: 'control-flow',
};

describe('NodeRegistry', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  describe('register', () => {
    test('registers a node type', () => {
      registry.register(toxicityNode);
      expect(registry.has('compute-toxicity')).toBe(true);
    });

    test('throws on duplicate registration', () => {
      registry.register(toxicityNode);
      expect(() => registry.register(toxicityNode)).toThrow('already registered');
    });
  });

  describe('get', () => {
    test('returns registered node type', () => {
      registry.register(toxicityNode);
      const def = registry.get('compute-toxicity');
      expect(def).toBeDefined();
      expect(def!.label).toBe('Toxicity Detection');
    });

    test('returns undefined for unknown type', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('has', () => {
    test('returns true for registered type', () => {
      registry.register(toxicityNode);
      expect(registry.has('compute-toxicity')).toBe(true);
    });

    test('returns false for unknown type', () => {
      expect(registry.has('unknown')).toBe(false);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      registry.register(toxicityNode);
      registry.register(httpNode);
      registry.register(nodeGroupNode);
    });

    test('lists all node types', () => {
      const all = registry.list();
      expect(all).toHaveLength(3);
    });

    test('filters by category', () => {
      const compute = registry.list({ category: 'compute' });
      expect(compute).toHaveLength(1);
      expect(compute[0].type).toBe('compute-toxicity');
    });

    test('filters by capabilities -- returns nodes whose capabilities are satisfied', () => {
      const withHttp = registry.list({ capabilities: ['external-http'] });
      // toxicity (no cap required) + node-group (no cap) + http-request (requires external-http, satisfied)
      expect(withHttp).toHaveLength(3);
    });

    test('filters by capabilities -- excludes unsatisfied nodes', () => {
      const noCaps = registry.list({ capabilities: [] });
      // toxicity + node-group pass (no caps required), http-request fails (needs external-http)
      expect(noCaps).toHaveLength(2);
    });
  });

  describe('validateConfig', () => {
    beforeEach(() => {
      registry.register(toxicityNode);
    });

    test('validates valid config', () => {
      const result = registry.validateConfig('compute-toxicity', { threshold: 0.8 });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('fails for missing required field', () => {
      const result = registry.validateConfig('compute-toxicity', {});
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('threshold');
    });

    test('fails for unknown node type', () => {
      const result = registry.validateConfig('unknown', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown node type');
    });
  });
});

describe('loadFromDocs', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  const mockDocs: NodeTypeDefinitionDoc[] = [
    {
      _id: 'compute-intent',
      tenantId: 'SYSTEM',
      label: 'Classify Intent',
      description: 'LLM-based intent classification',
      category: 'compute',
      executionModel: 'async',
      defaultTimeout: 120000,
      defaultRetries: 2,
      retryable: true,
      traits: ['compute', 'llm', 'storage'],
      configSchema: [
        {
          name: 'taxonomy',
          type: 'object[]',
          required: false,
          label: 'Taxonomy',
          description: 'Intent taxonomy',
          itemSchema: [
            {
              name: 'category',
              type: 'string',
              required: true,
              label: 'Cat',
              description: 'Category name',
            },
          ],
        },
      ],
      outputSchema: {
        intent: { type: 'string', description: 'Classified intent label' },
      },
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: 'delay',
      tenantId: 'SYSTEM',
      label: 'Delay',
      description: 'Pause execution',
      category: 'logic',
      executionModel: 'control-flow',
      defaultTimeout: 86400000,
      defaultRetries: 0,
      traits: [],
      configSchema: [
        {
          name: 'durationMs',
          type: 'number',
          required: true,
          label: 'Duration',
          description: 'Pause duration in ms',
          validation: { min: 1000, max: 86400000 },
        },
      ],
      version: 1,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  test('loads node types from document array', () => {
    registry.loadFromDocs(mockDocs);
    expect(registry.has('compute-intent')).toBe(true);
    expect(registry.has('delay')).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  test('merges trait fields during loading', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    const fieldNames = intent.configSchema.fields.map((f) => f.name);
    expect(fieldNames).toContain('taxonomy');
    expect(fieldNames).not.toContain('sourceStep');
    expect(fieldNames).toContain('model');
    expect(fieldNames).toContain('skipDirectWrite');
  });

  test('maps object[] type to array', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    const taxonomy = intent.configSchema.fields.find((f) => f.name === 'taxonomy')!;
    expect(taxonomy.type).toBe('array');
  });

  test('preserves non-interactive info fields from docs', () => {
    registry.loadFromDocs([
      {
        _id: 'store-results',
        tenantId: 'SYSTEM',
        label: 'Store Results',
        description: 'Stores results',
        category: 'action',
        executionModel: 'async',
        defaultTimeout: 60000,
        defaultRetries: 0,
        traits: [],
        configSchema: [
          {
            name: '__destination_clickhouse_hint',
            type: 'info',
            required: false,
            label: 'ClickHouse hint',
            description: 'Leave table empty to use the shared table.',
            intent: 'info',
            showWhen: { field: 'destination', equals: 'clickhouse' },
          },
        ],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const storeResults = registry.get('store-results')!;
    const hint = storeResults.configSchema.fields.find(
      (field) => field.name === '__destination_clickhouse_hint',
    );

    expect(hint).toMatchObject({
      type: 'info',
      intent: 'info',
      showWhen: { field: 'destination', equals: 'clickhouse' },
    });
  });

  test('converts itemSchema to items property', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    const taxonomy = intent.configSchema.fields.find((f) => f.name === 'taxonomy')!;
    expect(taxonomy.items).toBeDefined();
    const items = taxonomy.items as { type: string; properties: Record<string, any> };
    expect(items.type).toBe('object');
    expect(items.properties['category']).toBeDefined();
    expect(items.properties['category'].type).toBe('string');
  });

  test('preserves non-config fields from doc', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    expect(intent.type).toBe('compute-intent');
    expect(intent.category).toBe('compute');
    expect(intent.executionModel).toBe('async');
    expect(intent.defaultTimeout).toBe(120000);
    expect(intent.defaultRetries).toBe(2);
    expect(intent.retryable).toBe(true);
  });

  test('preserves outputSchema from doc', () => {
    registry.loadFromDocs(mockDocs);
    const intent = registry.get('compute-intent')!;
    expect(intent.outputSchema).toBeDefined();
    expect(intent.outputSchema!.properties['intent']).toBeDefined();
  });

  test('clears existing registrations before loading', () => {
    registry.register(toxicityNode);
    expect(registry.has('compute-toxicity')).toBe(true);
    registry.loadFromDocs(mockDocs);
    expect(registry.has('compute-toxicity')).toBe(false);
    expect(registry.has('compute-intent')).toBe(true);
  });

  test('loads contextKey from doc', () => {
    const registry = new NodeRegistry();
    registry.loadFromDocs([
      {
        _id: 'compute-sentiment',
        tenantId: 'SYSTEM',
        label: 'Compute Sentiment',
        description: 'Sentiment analysis',
        category: 'compute',
        executionModel: 'async',
        defaultTimeout: 60000,
        defaultRetries: 0,
        traits: ['compute'],
        configSchema: [],
        contextKey: 'sentiment',
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const def = registry.get('compute-sentiment');
    expect(def?.contextKey).toBe('sentiment');
  });

  test('contextKey is undefined when not set in doc', () => {
    const registry = new NodeRegistry();
    registry.loadFromDocs([
      {
        _id: 'store-results',
        tenantId: 'SYSTEM',
        label: 'Store Results',
        description: 'Stores results',
        category: 'action',
        executionModel: 'async',
        defaultTimeout: 60000,
        defaultRetries: 0,
        traits: [],
        configSchema: [],
        version: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const def = registry.get('store-results');
    expect(def?.contextKey).toBeUndefined();
  });

  test('validation works against loaded types', () => {
    registry.loadFromDocs(mockDocs);
    // delay requires durationMs
    const result = registry.validateConfig('delay', {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('durationMs');

    // valid config
    const result2 = registry.validateConfig('delay', { durationMs: 5000 });
    expect(result2.valid).toBe(true);
  });
});
