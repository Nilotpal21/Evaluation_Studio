import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  CSVSchemaDiscoveryService,
  inferCSVColumnType,
  isCSVBoolean,
  isCommonDateFormat,
  CSV_ERROR_CODES,
  type CSVConnectorConfigProvider,
  type CSVDataProviderFactory,
  type CSVDataProvider,
  type CSVConnectorInfo,
  type CSVData,
} from '../CSVSchemaDiscoveryService.js';

// --- Test Constants ----------------------------------------------------------

const TENANT_ID = 'tenant-csv-test';
const CONNECTOR_ID = 'connector-csv-001';

const CONNECTOR_CONFIG: CSVConnectorInfo = {
  connectorId: CONNECTOR_ID,
  tenantId: TENANT_ID,
  connectionConfig: {
    fileSource: 's3://test-bucket/data.csv',
    delimiter: ',',
    encoding: 'utf-8',
  },
};

// --- Test Fixtures -----------------------------------------------------------

function makeCSVData(headers: string[], rows: string[][], delimiter = ','): CSVData {
  return { headers, rows, delimiter };
}

function makeStandardCSV(): CSVData {
  return makeCSVData(
    ['name', 'age', 'active', 'joined'],
    [
      ['Alice', '30', 'true', '2024-01-15'],
      ['Bob', '25', 'false', '2024-02-20'],
      ['Charlie', '35', 'yes', '2024-03-10'],
    ],
  );
}

// --- Mock Setup --------------------------------------------------------------

function createMocks(csvData: CSVData = makeStandardCSV()) {
  const mockProvider: CSVDataProvider = {
    getCSVData: vi.fn().mockResolvedValue(csvData),
  };

  const mockConfigProvider: CSVConnectorConfigProvider = {
    getConnectorConfig: vi.fn().mockResolvedValue(CONNECTOR_CONFIG),
  };

  const mockProviderFactory: CSVDataProviderFactory = {
    createProvider: vi.fn().mockResolvedValue(mockProvider),
  };

  const service = new CSVSchemaDiscoveryService(mockConfigProvider, mockProviderFactory);

  return { service, mockProvider, mockConfigProvider, mockProviderFactory };
}

// --- isCSVBoolean Tests ------------------------------------------------------

describe('isCSVBoolean', () => {
  test('recognizes true/false', () => {
    expect(isCSVBoolean('true')).toBe(true);
    expect(isCSVBoolean('false')).toBe(true);
    expect(isCSVBoolean('TRUE')).toBe(true);
    expect(isCSVBoolean('FALSE')).toBe(true);
  });

  test('recognizes yes/no', () => {
    expect(isCSVBoolean('yes')).toBe(true);
    expect(isCSVBoolean('no')).toBe(true);
    expect(isCSVBoolean('YES')).toBe(true);
    expect(isCSVBoolean('NO')).toBe(true);
  });

  test('recognizes 1/0', () => {
    expect(isCSVBoolean('1')).toBe(true);
    expect(isCSVBoolean('0')).toBe(true);
  });

  test('rejects non-boolean strings', () => {
    expect(isCSVBoolean('maybe')).toBe(false);
    expect(isCSVBoolean('2')).toBe(false);
    expect(isCSVBoolean('')).toBe(false);
  });
});

// --- isCommonDateFormat Tests ------------------------------------------------

describe('isCommonDateFormat', () => {
  test('matches MM/DD/YYYY', () => {
    expect(isCommonDateFormat('01/15/2024')).toBe(true);
    expect(isCommonDateFormat('1/5/2024')).toBe(true);
  });

  test('matches DD-MM-YYYY', () => {
    expect(isCommonDateFormat('15-01-2024')).toBe(true);
  });

  test('matches YYYY/MM/DD', () => {
    expect(isCommonDateFormat('2024/01/15')).toBe(true);
  });

  test('rejects non-date strings', () => {
    expect(isCommonDateFormat('hello')).toBe(false);
    expect(isCommonDateFormat('2024')).toBe(false);
    expect(isCommonDateFormat('')).toBe(false);
  });
});

// --- inferCSVColumnType Tests ------------------------------------------------

describe('inferCSVColumnType', () => {
  test('returns "number" for all numeric strings', () => {
    expect(inferCSVColumnType(['1', '2.5', '-3', '0', '100.99'])).toBe('number');
  });

  test('returns "boolean" for true/false/yes/no/1/0 mix', () => {
    expect(inferCSVColumnType(['true', 'false', 'yes', 'no', '1', '0'])).toBe('boolean');
  });

  test('returns "date" for ISO 8601 dates', () => {
    expect(inferCSVColumnType(['2024-01-15', '2024-02-20T12:00:00Z'])).toBe('date');
  });

  test('returns "date" for common date formats', () => {
    expect(inferCSVColumnType(['01/15/2024', '02/20/2024', '03/10/2024'])).toBe('date');
  });

  test('returns "date" for mixed ISO and common date formats', () => {
    expect(inferCSVColumnType(['2024-01-15', '02/20/2024'])).toBe('date');
  });

  test('returns "string" for all plain strings', () => {
    expect(inferCSVColumnType(['hello', 'world', 'foo'])).toBe('string');
  });

  test('returns "string" for mixed types', () => {
    expect(inferCSVColumnType(['42', 'hello', 'true'])).toBe('string');
  });

  test('returns "string" for empty/whitespace-only values', () => {
    expect(inferCSVColumnType([])).toBe('string');
    expect(inferCSVColumnType(['', '  ', ''])).toBe('string');
  });

  test('ignores empty cells when determining type', () => {
    expect(inferCSVColumnType(['', '42', '', '100'])).toBe('number');
  });

  test('returns "number" for negative and decimal numbers', () => {
    expect(inferCSVColumnType(['-1.5', '0.001', '-100'])).toBe('number');
  });
});

// --- CSVSchemaDiscoveryService Tests -----------------------------------------

describe('CSVSchemaDiscoveryService', () => {
  describe('discoverSchema - standard CSV', () => {
    test('discovers fields from standard CSV', async () => {
      const { service } = createMocks();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.connectorId).toBe(CONNECTOR_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.discoveryMethod).toBe('hybrid');
      expect(result.metadata.connectorType).toBe('csv');
      expect(result.discoveredAt).toBeInstanceOf(Date);
      expect(result.fields.length).toBe(4);

      const nameField = result.fields.find((f) => f.path === 'columns/name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('string');
      expect(nameField!.name).toBe('name');

      const ageField = result.fields.find((f) => f.path === 'columns/age');
      expect(ageField).toBeDefined();
      expect(ageField!.type).toBe('number');

      const activeField = result.fields.find((f) => f.path === 'columns/active');
      expect(activeField).toBeDefined();
      expect(activeField!.type).toBe('boolean');

      const joinedField = result.fields.find((f) => f.path === 'columns/joined');
      expect(joinedField).toBeDefined();
      expect(joinedField!.type).toBe('date');
    });
  });

  describe('discoverSchema - headers', () => {
    test('skips empty headers', async () => {
      const csv = makeCSVData(['name', '', 'age', '  '], [['Alice', 'x', '30', 'y']]);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const fieldNames = result.fields.map((f) => f.name);
      expect(fieldNames).toContain('name');
      expect(fieldNames).toContain('age');
      expect(fieldNames).not.toContain('');
      expect(result.fields.length).toBe(2);
    });

    test('deduplicates duplicate headers with suffix', async () => {
      const csv = makeCSVData(
        ['name', 'name', 'age'],
        [
          ['Alice', 'Bob', '30'],
          ['Charlie', 'Dave', '25'],
        ],
      );
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields.length).toBe(3);
      expect(result.fields[0].name).toBe('name');
      expect(result.fields[0].path).toBe('columns/name');
      expect(result.fields[1].name).toBe('name_1');
      expect(result.fields[1].path).toBe('columns/name_1');
      expect(result.fields[2].name).toBe('age');
    });

    test('duplicate headers read correct column data', async () => {
      const csv = makeCSVData(
        ['val', 'val'],
        [
          ['10', 'hello'],
          ['20', 'world'],
        ],
      );
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      // First 'val' column is all numbers, second is all strings
      expect(result.fields[0].type).toBe('number');
      expect(result.fields[1].type).toBe('string');
    });

    test('preserves headers with spaces', async () => {
      const csv = makeCSVData(['First Name', 'Last Name'], [['Alice', 'Smith']]);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields[0].name).toBe('First Name');
      expect(result.fields[0].path).toBe('columns/First Name');
    });
  });

  describe('discoverSchema - delimiter metadata', () => {
    test('includes delimiter in metadata', async () => {
      const csv = makeCSVData(['a', 'b'], [['1', '2']], ';');
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.metadata.version).toContain('delimiter=;');
    });
  });

  describe('discoverSchema - enum detection (threshold 30)', () => {
    test('detects enum for low-cardinality column', async () => {
      const statuses = ['active', 'inactive', 'pending'];
      const rows = Array.from({ length: 100 }, (_, i) => [statuses[i % 3]]);
      const csv = makeCSVData(['status'], rows);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const statusField = result.fields.find((f) => f.name === 'status');
      expect(statusField!.metadata.enumValues).toBeDefined();
      expect(statusField!.metadata.enumValues).toEqual(
        expect.arrayContaining(['active', 'inactive', 'pending']),
      );
    });

    test('detects enum up to 29 unique values (CSV threshold)', async () => {
      const values = Array.from({ length: 29 }, (_, i) => `val-${i}`);
      // Repeat values to exceed ratio threshold
      const rows = Array.from({ length: 200 }, (_, i) => [values[i % 29]]);
      const csv = makeCSVData(['category'], rows);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const catField = result.fields.find((f) => f.name === 'category');
      expect(catField!.metadata.enumValues).toBeDefined();
    });

    test('does not detect enum for high-cardinality column', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => [`unique-${i}`]);
      const csv = makeCSVData(['id'], rows);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const idField = result.fields.find((f) => f.name === 'id');
      expect(idField!.metadata.enumValues).toBeUndefined();
    });
  });

  describe('discoverSchema - empty data', () => {
    test('throws PARSE_FAILED for empty headers', async () => {
      const csv = makeCSVData([], []);
      const { service } = createMocks(csv);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(CSV_ERROR_CODES.PARSE_FAILED);
    });

    test('throws PARSE_FAILED when all headers are empty strings', async () => {
      const csv = makeCSVData(['', '  ', ''], [['a', 'b', 'c']]);
      const { service } = createMocks(csv);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(CSV_ERROR_CODES.PARSE_FAILED);
    });

    test('returns fields with empty type for headers with no data rows', async () => {
      const csv = makeCSVData(['name', 'age'], []);
      const { service } = createMocks(csv);
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields.length).toBe(2);
      expect(result.fields[0].type).toBe('string'); // default for empty
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
      ).rejects.toThrow(CSV_ERROR_CODES.AUTH_FAILED);
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

    test('returns false when getCSVData throws', async () => {
      const { service, mockProvider } = createMocks();
      (mockProvider.getCSVData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('File not found'),
      );
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });
  });

  describe('rate limit retry with exponential backoff', () => {
    let service: CSVSchemaDiscoveryService;
    let mockProvider: CSVDataProvider;
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
      (mockProvider.getCSVData as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(makeStandardCSV());

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      expect(result.fields.length).toBeGreaterThan(0);
      expect(mockProvider.getCSVData).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledWith(1000);
    });

    test('uses exponential backoff delays', async () => {
      const serverError = Object.assign(new Error('Server error'), { status: 500 });
      (mockProvider.getCSVData as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeStandardCSV());

      await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
    });

    test('throws after MAX_RETRIES exhausted', async () => {
      const serviceUnavailable = Object.assign(new Error('Unavailable'), { status: 503 });
      (mockProvider.getCSVData as ReturnType<typeof vi.fn>).mockRejectedValue(serviceUnavailable);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow('Unavailable');
      expect(mockProvider.getCSVData).toHaveBeenCalledTimes(4);
      expect(sleepSpy).toHaveBeenCalledTimes(3);
    });

    test('does not retry non-retryable errors', async () => {
      const notFoundError = Object.assign(new Error('Not found'), { status: 404 });
      (mockProvider.getCSVData as ReturnType<typeof vi.fn>).mockRejectedValueOnce(notFoundError);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow('Not found');
      expect(mockProvider.getCSVData).toHaveBeenCalledTimes(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });
  });

  describe('performance', () => {
    test('processes 1000 rows within 1 second', async () => {
      const headers = ['name', 'age', 'email', 'status', 'joined'];
      const rows = Array.from({ length: 1000 }, (_, i) => [
        `User ${i}`,
        String(20 + (i % 50)),
        `user${i}@test.com`,
        ['active', 'inactive', 'pending'][i % 3],
        '2024-01-15',
      ]);
      const csv = makeCSVData(headers, rows);
      const { service } = createMocks(csv);

      const start = Date.now();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(result.fields.length).toBe(5);
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
