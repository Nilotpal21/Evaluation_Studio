import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  JSONSchemaDiscoveryService,
  extractFieldPaths,
  inferJSONFieldType,
  inferArrayItemType,
  JSON_ERROR_CODES,
  type JSONConnectorConfigProvider,
  type JSONDocumentProviderFactory,
  type JSONDocumentProvider,
  type JSONConnectorInfo,
  type JSONDocument,
} from '../JSONSchemaDiscoveryService.js';

// --- Test Constants ----------------------------------------------------------

const TENANT_ID = 'tenant-json-test';
const CONNECTOR_ID = 'connector-json-001';

const CONNECTOR_CONFIG: JSONConnectorInfo = {
  connectorId: CONNECTOR_ID,
  tenantId: TENANT_ID,
  connectionConfig: {
    documentSource: 's3://test-bucket/documents',
  },
};

// --- Test Fixtures -----------------------------------------------------------

function makeDocument(id: string, content: Record<string, unknown>): JSONDocument {
  return { id, content };
}

function makeFlatDocuments(): JSONDocument[] {
  return [
    makeDocument('doc-1', { name: 'Alice', age: 30, active: true }),
    makeDocument('doc-2', { name: 'Bob', age: 25, active: false }),
    makeDocument('doc-3', { name: 'Charlie', age: 35, active: true }),
  ];
}

function makeNestedDocuments(): JSONDocument[] {
  return [
    makeDocument('doc-1', {
      user: { name: 'Alice', address: { city: 'NYC', zip: '10001' } },
      score: 95,
    }),
    makeDocument('doc-2', {
      user: { name: 'Bob', address: { city: 'LA', zip: '90001' } },
      score: 88,
    }),
  ];
}

// --- Mock Setup --------------------------------------------------------------

function createMocks(documents: JSONDocument[] = makeFlatDocuments()) {
  const mockProvider: JSONDocumentProvider = {
    getDocumentSamples: vi.fn().mockResolvedValue(documents),
  };

  const mockConfigProvider: JSONConnectorConfigProvider = {
    getConnectorConfig: vi.fn().mockResolvedValue(CONNECTOR_CONFIG),
  };

  const mockProviderFactory: JSONDocumentProviderFactory = {
    createProvider: vi.fn().mockResolvedValue(mockProvider),
  };

  const service = new JSONSchemaDiscoveryService(mockConfigProvider, mockProviderFactory);

  return { service, mockProvider, mockConfigProvider, mockProviderFactory };
}

// --- extractFieldPaths Tests -------------------------------------------------

describe('extractFieldPaths', () => {
  test('extracts fields from flat object', () => {
    const fields = extractFieldPaths({ name: 'Alice', age: 30, active: true });
    expect([...fields.keys()]).toEqual(expect.arrayContaining(['name', 'age', 'active']));
    expect(fields.get('name')).toEqual(['Alice']);
    expect(fields.get('age')).toEqual([30]);
    expect(fields.get('active')).toEqual([true]);
  });

  test('extracts dot-notation paths from nested objects', () => {
    const fields = extractFieldPaths({
      user: { name: 'Alice', address: { city: 'NYC' } },
    });
    expect([...fields.keys()]).toEqual(expect.arrayContaining(['user.name', 'user.address.city']));
    expect(fields.get('user.name')).toEqual(['Alice']);
    expect(fields.get('user.address.city')).toEqual(['NYC']);
  });

  test('stops recursion at MAX_DEPTH (5 levels)', () => {
    const deepObj = {
      a: { b: { c: { d: { e: { f: 'too-deep' } } } } },
    };
    const fields = extractFieldPaths(deepObj);
    // Depth 0: a → recurse
    // Depth 1: a.b → recurse
    // Depth 2: a.b.c → recurse
    // Depth 3: a.b.c.d → recurse
    // Depth 4: a.b.c.d.e → recurse
    // Depth 5: MAX_DEPTH reached, returns empty
    expect(fields.has('a.b.c.d.e.f')).toBe(false);
    expect(fields.size).toBe(0);
  });

  test('records fields at exactly MAX_DEPTH - 1', () => {
    // 4 levels of nesting = depth 4 when processing leaf
    const obj = {
      a: { b: { c: { d: { value: 42 } } } },
    };
    const fields = extractFieldPaths(obj);
    expect(fields.get('a.b.c.d.value')).toEqual([42]);
  });

  test('returns empty map for empty object', () => {
    const fields = extractFieldPaths({});
    expect(fields.size).toBe(0);
  });

  test('records null and undefined values', () => {
    const fields = extractFieldPaths({ a: null, b: undefined });
    expect(fields.has('a')).toBe(true);
    expect(fields.get('a')).toEqual([null]);
    expect(fields.has('b')).toBe(true);
    expect(fields.get('b')).toEqual([undefined]);
  });

  test('records array values without recursing into items', () => {
    const fields = extractFieldPaths({ tags: ['a', 'b'], nested: { list: [1, 2] } });
    expect(fields.get('tags')).toEqual([['a', 'b']]);
    expect(fields.get('nested.list')).toEqual([[1, 2]]);
  });

  test('escapes keys containing dots with bracket notation', () => {
    const fields = extractFieldPaths({ 'user.name': 'Alice', normal: 'Bob' });
    expect(fields.has('[user.name]')).toBe(true);
    expect(fields.get('[user.name]')).toEqual(['Alice']);
    expect(fields.has('normal')).toBe(true);
  });

  test('escapes dotted keys in nested objects', () => {
    const fields = extractFieldPaths({ outer: { 'inner.key': 42 } });
    expect(fields.has('outer.[inner.key]')).toBe(true);
    expect(fields.get('outer.[inner.key]')).toEqual([42]);
  });
});

// --- inferJSONFieldType Tests ------------------------------------------------

describe('inferJSONFieldType', () => {
  test('returns "number" for all numbers', () => {
    expect(inferJSONFieldType([1, 2, 3.5, 0, -1])).toBe('number');
  });

  test('returns "boolean" for all booleans', () => {
    expect(inferJSONFieldType([true, false, true])).toBe('boolean');
  });

  test('returns "string" for all strings', () => {
    expect(inferJSONFieldType(['hello', 'world', 'foo'])).toBe('string');
  });

  test('returns "date" for all ISO 8601 date strings', () => {
    expect(inferJSONFieldType(['2024-01-15', '2024-02-20', '2024-03-10T12:00:00Z'])).toBe('date');
  });

  test('returns "array" for all arrays', () => {
    expect(inferJSONFieldType([[1, 2], ['a'], []])).toBe('array');
  });

  test('returns "object" for all objects', () => {
    expect(inferJSONFieldType([{ a: 1 }, { b: 2 }])).toBe('object');
  });

  test('returns "string" for mixed types across documents', () => {
    expect(inferJSONFieldType([1, 'hello', true])).toBe('string');
  });

  test('returns "string" for mixed number and string', () => {
    expect(inferJSONFieldType([42, 'not-a-number'])).toBe('string');
  });

  test('returns "string" for empty/null-only values', () => {
    expect(inferJSONFieldType([])).toBe('string');
    expect(inferJSONFieldType([null, undefined])).toBe('string');
  });

  test('ignores null values when determining type', () => {
    expect(inferJSONFieldType([null, 42, null, 100])).toBe('number');
  });
});

// --- inferArrayItemType Tests ------------------------------------------------

describe('inferArrayItemType', () => {
  test('returns "number" for homogeneous number arrays', () => {
    expect(
      inferArrayItemType([
        [1, 2, 3],
        [4, 5],
      ]),
    ).toBe('number');
  });

  test('returns "string" for homogeneous string arrays', () => {
    expect(inferArrayItemType([['a', 'b'], ['c']])).toBe('string');
  });

  test('returns "boolean" for homogeneous boolean arrays', () => {
    expect(inferArrayItemType([[true, false], [true]])).toBe('boolean');
  });

  test('returns "date" for homogeneous ISO 8601 date string arrays', () => {
    expect(inferArrayItemType([['2024-01-15', '2024-02-20'], ['2024-03-10']])).toBe('date');
  });

  test('returns "mixed" for heterogeneous arrays', () => {
    expect(inferArrayItemType([[1, 'two', true]])).toBe('mixed');
  });

  test('returns undefined for empty arrays', () => {
    expect(inferArrayItemType([[], []])).toBeUndefined();
  });

  test('ignores null items', () => {
    expect(
      inferArrayItemType([
        [1, null, 2],
        [null, 3],
      ]),
    ).toBe('number');
  });
});

// --- JSONSchemaDiscoveryService Tests ----------------------------------------

describe('JSONSchemaDiscoveryService', () => {
  describe('discoverSchema - flat documents', () => {
    test('discovers fields from flat JSON documents', async () => {
      const { service } = createMocks(makeFlatDocuments());
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.connectorId).toBe(CONNECTOR_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.discoveryMethod).toBe('hybrid');
      expect(result.metadata.connectorType).toBe('json');
      expect(result.discoveredAt).toBeInstanceOf(Date);
      expect(result.fields.length).toBe(3);

      const nameField = result.fields.find((f) => f.path === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');
      expect(nameField!.name).toBe('name');

      const ageField = result.fields.find((f) => f.path === 'age');
      expect(ageField).toBeDefined();
      expect(ageField!.type).toBe('number');

      const activeField = result.fields.find((f) => f.path === 'active');
      expect(activeField).toBeDefined();
      expect(activeField!.type).toBe('boolean');
    });
  });

  describe('discoverSchema - nested documents', () => {
    test('discovers dot-notation paths from nested objects', async () => {
      const { service } = createMocks(makeNestedDocuments());
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const paths = result.fields.map((f) => f.path);
      expect(paths).toContain('user.name');
      expect(paths).toContain('user.address.city');
      expect(paths).toContain('user.address.zip');
      expect(paths).toContain('score');

      const cityField = result.fields.find((f) => f.path === 'user.address.city');
      expect(cityField!.name).toBe('city');
      expect(cityField!.type).toBe('string');
      expect(cityField!.metadata.description).toBe('user.address.city');
    });
  });

  describe('discoverSchema - array fields', () => {
    test('detects array fields with item type metadata', async () => {
      const docs = [
        makeDocument('doc-1', { tags: ['red', 'blue'], scores: [95, 88] }),
        makeDocument('doc-2', { tags: ['green'], scores: [72, 91] }),
      ];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const tagsField = result.fields.find((f) => f.path === 'tags');
      expect(tagsField!.type).toBe('array');
      expect(tagsField!.metadata.format).toBe('array<string>');

      const scoresField = result.fields.find((f) => f.path === 'scores');
      expect(scoresField!.type).toBe('array');
      expect(scoresField!.metadata.format).toBe('array<number>');
    });

    test('detects mixed array item types', async () => {
      const docs = [makeDocument('doc-1', { data: [1, 'two', true] })];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const dataField = result.fields.find((f) => f.path === 'data');
      expect(dataField!.type).toBe('array');
      expect(dataField!.metadata.format).toBe('array<mixed>');
    });
  });

  describe('discoverSchema - multi-document merging', () => {
    test('merges fields from documents with different structures', async () => {
      const docs = [
        makeDocument('doc-1', { name: 'Alice', age: 30 }),
        makeDocument('doc-2', { name: 'Bob', email: 'bob@test.com' }),
      ];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const paths = result.fields.map((f) => f.path);
      expect(paths).toContain('name');
      expect(paths).toContain('age');
      expect(paths).toContain('email');
    });

    test('falls back to string for conflicting types across documents', async () => {
      const docs = [
        makeDocument('doc-1', { value: 42 }),
        makeDocument('doc-2', { value: 'not-a-number' }),
      ];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const valueField = result.fields.find((f) => f.path === 'value');
      expect(valueField!.type).toBe('string');
    });
  });

  describe('discoverSchema - date detection', () => {
    test('detects ISO 8601 date strings as date type', async () => {
      const docs = [
        makeDocument('doc-1', { createdAt: '2024-01-15T10:00:00Z' }),
        makeDocument('doc-2', { createdAt: '2024-02-20' }),
      ];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const dateField = result.fields.find((f) => f.path === 'createdAt');
      expect(dateField!.type).toBe('date');
    });
  });

  describe('discoverSchema - enum detection', () => {
    test('detects enum candidates for low-cardinality fields', async () => {
      const statuses = ['active', 'inactive', 'pending'];
      const docs = Array.from({ length: 30 }, (_, i) =>
        makeDocument(`doc-${i}`, { status: statuses[i % 3] }),
      );
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const statusField = result.fields.find((f) => f.path === 'status');
      expect(statusField!.metadata.enumValues).toBeDefined();
      expect(statusField!.metadata.enumValues).toEqual(
        expect.arrayContaining(['active', 'inactive', 'pending']),
      );
    });

    test('does not detect enum for high-cardinality fields', async () => {
      const docs = Array.from({ length: 30 }, (_, i) =>
        makeDocument(`doc-${i}`, { id: `unique-${i}` }),
      );
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const idField = result.fields.find((f) => f.path === 'id');
      expect(idField!.metadata.enumValues).toBeUndefined();
    });
  });

  describe('discoverSchema - empty documents', () => {
    test('returns zero fields for empty document list', async () => {
      const { service } = createMocks([]);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toEqual([]);
      expect(result.discoveryMethod).toBe('hybrid');
    });

    test('returns zero fields for documents with empty content', async () => {
      const docs = [makeDocument('doc-1', {}), makeDocument('doc-2', {})];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toEqual([]);
    });
  });

  describe('error handling', () => {
    test('throws AUTH_FAILED when provider factory fails', async () => {
      const { service, mockProviderFactory } = createMocks();
      (mockProviderFactory.createProvider as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Invalid credentials'),
      );

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(JSON_ERROR_CODES.AUTH_FAILED);
    });

    test('throws when connector config not found', async () => {
      const { service, mockConfigProvider } = createMocks();
      (mockConfigProvider.getConnectorConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        null,
      );

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow('Connector not found');
    });

    test('throws PARSE_FAILED when all documents fail to parse', async () => {
      const badDocs = [
        {
          id: 'bad-1',
          get content(): Record<string, unknown> {
            throw new Error('corrupt');
          },
        } as JSONDocument,
        {
          id: 'bad-2',
          get content(): Record<string, unknown> {
            throw new Error('also corrupt');
          },
        } as JSONDocument,
      ];
      const { service } = createMocks(badDocs);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(JSON_ERROR_CODES.PARSE_FAILED);
    });

    test('skips malformed documents and continues', async () => {
      // Create a document whose content causes extractFieldPaths to throw
      const docs = [
        makeDocument('doc-good', { name: 'Alice' }),
        // A document with a getter that throws
        {
          id: 'doc-bad',
          get content(): Record<string, unknown> {
            throw new Error('parse error');
          },
        } as JSONDocument,
        makeDocument('doc-good-2', { age: 30 }),
      ];
      const { service } = createMocks(docs);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      // Should have fields from the good documents
      expect(result.fields.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    test('passes both connectorId and tenantId to config provider', async () => {
      const { service, mockConfigProvider } = createMocks();
      await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });

      expect(mockConfigProvider.getConnectorConfig).toHaveBeenCalledWith(CONNECTOR_ID, TENANT_ID);
    });
  });

  describe('validateCredentials', () => {
    test('returns true when provider connects successfully', async () => {
      const { service } = createMocks();
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(true);
    });

    test('returns false when connector config not found', async () => {
      const { service, mockConfigProvider } = createMocks();
      (mockConfigProvider.getConnectorConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        null,
      );
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });

    test('returns false when provider creation fails', async () => {
      const { service, mockProviderFactory } = createMocks();
      (mockProviderFactory.createProvider as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused'),
      );
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });
  });

  describe('rate limit retry with exponential backoff', () => {
    let service: JSONSchemaDiscoveryService;
    let mockProvider: JSONDocumentProvider;
    let sleepSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      const mocks = createMocks();
      service = mocks.service;
      mockProvider = mocks.mockProvider;
      sleepSpy = vi
        .spyOn(service, 'sleep' as keyof typeof service)
        .mockResolvedValue(undefined as never);
    });

    test('retries on 429 and succeeds on subsequent attempt', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      (mockProvider.getDocumentSamples as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(makeFlatDocuments());

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      expect(result.fields.length).toBeGreaterThan(0);
      expect(mockProvider.getDocumentSamples).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledWith(1000);
    });

    test('uses exponential backoff delays', async () => {
      const serverError = Object.assign(new Error('Server error'), { status: 500 });
      (mockProvider.getDocumentSamples as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeFlatDocuments());

      await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
    });

    test('throws after MAX_RETRIES exhausted', async () => {
      const serviceUnavailable = Object.assign(new Error('Unavailable'), { status: 503 });
      (mockProvider.getDocumentSamples as ReturnType<typeof vi.fn>).mockRejectedValue(
        serviceUnavailable,
      );

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow('Unavailable');
      // 1 initial + 3 retries = 4 calls
      expect(mockProvider.getDocumentSamples).toHaveBeenCalledTimes(4);
      expect(sleepSpy).toHaveBeenCalledTimes(3);
    });

    test('does not retry non-retryable errors', async () => {
      const notFoundError = Object.assign(new Error('Not found'), { status: 404 });
      (mockProvider.getDocumentSamples as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        notFoundError,
      );

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow('Not found');
      expect(mockProvider.getDocumentSamples).toHaveBeenCalledTimes(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });
  });

  describe('performance', () => {
    test('processes 100 documents within 2 seconds', async () => {
      const docs = Array.from({ length: 100 }, (_, i) =>
        makeDocument(`doc-${i}`, {
          name: `User ${i}`,
          age: 20 + (i % 50),
          email: `user${i}@test.com`,
          nested: { department: `dept-${i % 5}`, level: i % 10 },
          tags: ['tag-a', 'tag-b'],
        }),
      );
      const { service } = createMocks(docs);

      const start = Date.now();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000);
      expect(result.fields.length).toBeGreaterThan(0);
    });
  });

  describe('discoveryMethod', () => {
    test('returns hybrid as discovery method', async () => {
      const { service } = createMocks();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      expect(result.discoveryMethod).toBe('hybrid');
    });
  });
});
