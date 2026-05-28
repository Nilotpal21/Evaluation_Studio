import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  upsertDiscoveredSchema,
  getDiscoveredSchema,
  getSchemasByKnowledgeBase,
  toSchemaField,
} from '../DiscoveredSchemaPersistenceService.js';
import type { DiscoveredSchema, DiscoveredField } from '../SchemaDiscoveryService.js';
import type { IDiscoveredSchema } from '@agent-platform/database/models';

// --- Test Fixtures -----------------------------------------------------------

function makeField(
  name: string,
  type = 'string',
  opts?: Partial<DiscoveredField['metadata']>,
): DiscoveredField {
  return {
    name,
    type,
    path: `columns/${name}`,
    metadata: {
      description: `Test field: ${name}`,
      ...opts,
    },
  };
}

function makeDiscoveredSchema(
  fields: DiscoveredField[] = [makeField('title'), makeField('status')],
): DiscoveredSchema {
  return {
    connectorId: 'conn-001',
    tenantId: 'tenant-test',
    fields,
    discoveryMethod: 'hybrid',
    discoveredAt: new Date('2026-03-14T10:00:00Z'),
    metadata: { connectorType: 'jira' },
  };
}

function makePersistedDoc(overrides: Partial<IDiscoveredSchema> = {}): IDiscoveredSchema {
  return {
    _id: 'schema-uuid-001',
    tenantId: 'tenant-test',
    connectorId: 'conn-001',
    knowledgeBaseId: 'kb-001',
    version: 1,
    fields: [
      { name: 'title', type: 'string', path: 'columns/title' },
      { name: 'status', type: 'string', path: 'columns/status' },
    ],
    fieldCount: 2,
    discoveryMethod: 'hybrid',
    discoveredAt: new Date('2026-03-14T10:00:00Z'),
    status: 'active',
    metadata: { connectorType: 'jira' },
    _v: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// --- toSchemaField Tests -----------------------------------------------------

describe('toSchemaField', () => {
  test('flattens metadata into top-level fields', () => {
    const field = makeField('priority', 'string', {
      description: 'Issue priority',
      required: true,
      enumValues: ['high', 'medium', 'low'],
      format: 'select',
      enumDisplayNames: { high: 'High', medium: 'Medium', low: 'Low' },
      enumSource: 'template',
    });

    const result = toSchemaField(field);

    expect(result.name).toBe('priority');
    expect(result.type).toBe('string');
    expect(result.path).toBe('columns/priority');
    expect(result.description).toBe('Issue priority');
    expect(result.required).toBe(true);
    expect(result.enumValues).toEqual(['high', 'medium', 'low']);
    expect(result.format).toBe('select');
    expect(result.enumDisplayNames).toEqual({ high: 'High', medium: 'Medium', low: 'Low' });
    expect(result.enumSource).toBe('template');
  });

  test('handles field with minimal metadata', () => {
    const field = makeField('title');
    const result = toSchemaField(field);

    expect(result.name).toBe('title');
    expect(result.type).toBe('string');
    expect(result.enumValues).toBeUndefined();
    expect(result.enumDisplayNames).toBeUndefined();
    expect(result.enumSource).toBeUndefined();
  });

  test('preserves inferred enumSource', () => {
    const field = makeField('custom', 'string', {
      enumValues: ['a', 'b'],
      enumSource: 'inferred',
    });
    const result = toSchemaField(field);

    expect(result.enumSource).toBe('inferred');
    expect(result.enumValues).toEqual(['a', 'b']);
  });
});

// --- upsertDiscoveredSchema Tests --------------------------------------------

describe('upsertDiscoveredSchema', () => {
  let mockModel: { findOneAndUpdate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockModel = {
      findOneAndUpdate: vi.fn(),
    };
  });

  test('calls findOneAndUpdate with correct compound filter', async () => {
    const doc = makePersistedDoc();
    mockModel.findOneAndUpdate.mockResolvedValue(doc);

    const schema = makeDiscoveredSchema();
    await upsertDiscoveredSchema({ schema, knowledgeBaseId: 'kb-001' }, mockModel);

    expect(mockModel.findOneAndUpdate).toHaveBeenCalledOnce();
    const [filter] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      tenantId: 'tenant-test',
      knowledgeBaseId: 'kb-001',
      connectorId: 'conn-001',
    });
  });

  test('uses upsert with $set and $inc', async () => {
    const doc = makePersistedDoc();
    mockModel.findOneAndUpdate.mockResolvedValue(doc);

    const schema = makeDiscoveredSchema();
    await upsertDiscoveredSchema({ schema, knowledgeBaseId: 'kb-001' }, mockModel);

    const [, update, options] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe('active');
    expect(update.$set.fieldCount).toBe(2);
    expect(update.$set.discoveryMethod).toBe('hybrid');
    expect(update.$set.metadata).toEqual({ connectorType: 'jira' });
    expect(update.$inc).toEqual({ version: 1, _v: 1 });
    expect(options).toEqual({ upsert: true, new: true });
  });

  test('converts fields with metadata flattening', async () => {
    const fields = [
      makeField('priority', 'string', {
        enumValues: ['high', 'low'],
        enumDisplayNames: { high: 'High', low: 'Low' },
        enumSource: 'template',
      }),
    ];
    const schema = makeDiscoveredSchema(fields);
    mockModel.findOneAndUpdate.mockResolvedValue(makePersistedDoc());

    await upsertDiscoveredSchema({ schema, knowledgeBaseId: 'kb-001' }, mockModel);

    const [, update] = mockModel.findOneAndUpdate.mock.calls[0];
    const persistedFields = update.$set.fields;
    expect(persistedFields).toHaveLength(1);
    expect(persistedFields[0].enumValues).toEqual(['high', 'low']);
    expect(persistedFields[0].enumDisplayNames).toEqual({ high: 'High', low: 'Low' });
    expect(persistedFields[0].enumSource).toBe('template');
  });

  test('returns the upserted document', async () => {
    const doc = makePersistedDoc({ version: 3 });
    mockModel.findOneAndUpdate.mockResolvedValue(doc);

    const result = await upsertDiscoveredSchema(
      { schema: makeDiscoveredSchema(), knowledgeBaseId: 'kb-001' },
      mockModel,
    );

    expect(result._id).toBe('schema-uuid-001');
    expect(result.version).toBe(3);
    expect(result.status).toBe('active');
  });

  test('propagates Mongoose errors', async () => {
    mockModel.findOneAndUpdate.mockRejectedValue(new Error('Duplicate key'));

    await expect(
      upsertDiscoveredSchema(
        { schema: makeDiscoveredSchema(), knowledgeBaseId: 'kb-001' },
        mockModel,
      ),
    ).rejects.toThrow('Duplicate key');
  });

  test('sets fieldCount from fields array length', async () => {
    const fields = [makeField('a'), makeField('b'), makeField('c')];
    const schema = makeDiscoveredSchema(fields);
    mockModel.findOneAndUpdate.mockResolvedValue(makePersistedDoc());

    await upsertDiscoveredSchema({ schema, knowledgeBaseId: 'kb-001' }, mockModel);

    const [, update] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.fieldCount).toBe(3);
  });

  test('preserves discoveredAt timestamp', async () => {
    const schema = makeDiscoveredSchema();
    mockModel.findOneAndUpdate.mockResolvedValue(makePersistedDoc());

    await upsertDiscoveredSchema({ schema, knowledgeBaseId: 'kb-001' }, mockModel);

    const [, update] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.discoveredAt).toEqual(new Date('2026-03-14T10:00:00Z'));
  });
});

// --- getDiscoveredSchema Tests -----------------------------------------------

describe('getDiscoveredSchema', () => {
  test('queries with correct filter and returns lean doc', async () => {
    const doc = makePersistedDoc();
    const mockLean = vi.fn().mockResolvedValue(doc);
    const mockModel = {
      findOne: vi.fn().mockReturnValue({ lean: mockLean }),
    };

    const result = await getDiscoveredSchema('tenant-test', 'kb-001', 'conn-001', mockModel);

    expect(mockModel.findOne).toHaveBeenCalledWith({
      tenantId: 'tenant-test',
      knowledgeBaseId: 'kb-001',
      connectorId: 'conn-001',
    });
    expect(mockLean).toHaveBeenCalled();
    expect(result).toBe(doc);
  });

  test('returns null when not found', async () => {
    const mockLean = vi.fn().mockResolvedValue(null);
    const mockModel = {
      findOne: vi.fn().mockReturnValue({ lean: mockLean }),
    };

    const result = await getDiscoveredSchema('tenant-test', 'kb-001', 'conn-999', mockModel);
    expect(result).toBeNull();
  });

  test('includes tenantId in filter for isolation', async () => {
    const mockLean = vi.fn().mockResolvedValue(null);
    const mockModel = {
      findOne: vi.fn().mockReturnValue({ lean: mockLean }),
    };

    await getDiscoveredSchema('tenant-A', 'kb-001', 'conn-001', mockModel);

    const [filter] = mockModel.findOne.mock.calls[0];
    expect(filter.tenantId).toBe('tenant-A');
  });
});

// --- getSchemasByKnowledgeBase Tests -----------------------------------------

describe('getSchemasByKnowledgeBase', () => {
  test('queries with tenantId and knowledgeBaseId', async () => {
    const docs = [makePersistedDoc(), makePersistedDoc({ connectorId: 'conn-002' })];
    const mockLean = vi.fn().mockResolvedValue(docs);
    const mockModel = {
      find: vi.fn().mockReturnValue({ lean: mockLean }),
    };

    const result = await getSchemasByKnowledgeBase('tenant-test', 'kb-001', mockModel);

    expect(mockModel.find).toHaveBeenCalledWith({
      tenantId: 'tenant-test',
      knowledgeBaseId: 'kb-001',
    });
    expect(mockLean).toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  test('returns empty array when no schemas found', async () => {
    const mockLean = vi.fn().mockResolvedValue([]);
    const mockModel = {
      find: vi.fn().mockReturnValue({ lean: mockLean }),
    };

    const result = await getSchemasByKnowledgeBase('tenant-test', 'kb-empty', mockModel);
    expect(result).toEqual([]);
  });
});
