import { describe, test, expect } from 'vitest';

describe('NodeTypeDefinitionModel', () => {
  test('model is exported from package', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    expect(NodeTypeDefinitionModel).toBeDefined();
    expect(NodeTypeDefinitionModel.modelName).toBe('NodeTypeDefinition');
  });

  test('schema validates required fields', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({});
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['_id']).toBeDefined();
    expect(err!.errors['tenantId']).toBeDefined();
    expect(err!.errors['label']).toBeDefined();
    expect(err!.errors['description']).toBeDefined();
    expect(err!.errors['category']).toBeDefined();
    expect(err!.errors['executionModel']).toBeDefined();
  });

  test('schema accepts a valid compute-intent document', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
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
          label: 'Intent Taxonomy',
          description: 'Define intent categories',
          group: 'basic',
          itemSchema: [
            {
              name: 'category',
              type: 'string',
              required: true,
              label: 'Category',
              description: 'Group name',
            },
          ],
        },
      ],
      outputSchema: {
        intent: { type: 'string', description: 'Classified intent' },
      },
      storageSchema: {
        tables: [
          {
            table: 'abl_platform.intent_classifications',
            granularity: 'session',
            columns: [
              { name: 'tenant_id', type: 'String', source: 'system', description: 'Tenant ID' },
              {
                name: 'intent',
                type: 'String',
                source: 'computed',
                description: 'Classified intent',
              },
            ],
          },
        ],
      },
      inputSchema: {
        requiresPreviousStep: 'read-conversation',
        requiredInputFields: ['messages', 'metadata'],
      },
      version: 1,
      isActive: true,
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  test('schema rejects invalid category', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
      _id: 'test',
      tenantId: 'SYSTEM',
      label: 'Test',
      description: 'Test',
      category: 'invalid',
      executionModel: 'async',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['category']).toBeDefined();
  });

  test('schema rejects invalid executionModel', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
      _id: 'test',
      tenantId: 'SYSTEM',
      label: 'Test',
      description: 'Test',
      category: 'compute',
      executionModel: 'invalid',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['executionModel']).toBeDefined();
  });

  test('schema rejects invalid trait values', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
      _id: 'test',
      tenantId: 'SYSTEM',
      label: 'Test',
      description: 'Test',
      category: 'compute',
      executionModel: 'async',
      traits: ['invalid_trait'],
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
  });

  test('schema accepts non-interactive info config fields without labels', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    const doc = new NodeTypeDefinitionModel({
      _id: 'store-results',
      tenantId: 'SYSTEM',
      label: 'Store Results',
      description: 'Stores results',
      category: 'action',
      executionModel: 'async',
      defaultTimeout: 30000,
      defaultRetries: 3,
      traits: [],
      configSchema: [
        {
          name: '__destination_clickhouse_hint',
          type: 'info',
          required: false,
          description: 'Leave table empty to use the shared ClickHouse results table.',
          intent: 'info',
          showWhen: { field: 'destination', equals: 'clickhouse' },
        },
      ],
      version: 1,
      isActive: true,
    });

    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  test('schema has correct collection name', async () => {
    const { NodeTypeDefinitionModel } = await import('../schemas/node-type-definition.schema.js');
    expect(NodeTypeDefinitionModel.collection.collectionName).toBe('node_type_definitions');
  });
});
