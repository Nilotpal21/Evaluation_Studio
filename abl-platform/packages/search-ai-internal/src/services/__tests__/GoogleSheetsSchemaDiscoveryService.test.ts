import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  GoogleSheetsSchemaDiscoveryService,
  inferColumnType,
  detectEnumCandidates,
  isISO8601Date,
  GS_ERROR_CODES,
  type GSConnectorConfigProvider,
  type GSClientFactory,
  type GSConnectorInfo,
  type GSClient,
  type GSSpreadsheet,
  type GSValueRange,
} from '../GoogleSheetsSchemaDiscoveryService.js';
import { SchemaDiscoveryService } from '../SchemaDiscoveryService.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-abc';
const CONNECTOR_ID = 'gs-connector-1';
const SPREADSHEET_ID = 'spreadsheet-xyz';

const mockConnectorConfig: GSConnectorInfo = {
  connectorId: CONNECTOR_ID,
  tenantId: TENANT_ID,
  spreadsheetId: SPREADSHEET_ID,
  connectionConfig: {
    clientId: 'client-id',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  },
};

function makeSpreadsheet(sheets: string[] = ['Sheet1']): GSSpreadsheet {
  return {
    spreadsheetId: SPREADSHEET_ID,
    properties: { title: 'Test Spreadsheet' },
    sheets: sheets.map((title, idx) => ({
      properties: {
        sheetId: idx,
        title,
        gridProperties: { rowCount: 1000, columnCount: 26 },
      },
    })),
  };
}

function makeValueRange(
  range: string,
  values: unknown[][] = [
    ['Name', 'Age'],
    ['Alice', 30],
    ['Bob', 25],
  ],
): GSValueRange {
  return { range, majorDimension: 'ROWS', values };
}

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockGSClient(overrides: Partial<GSClient> = {}): GSClient {
  return {
    getSpreadsheet: vi
      .fn<(id: string) => Promise<GSSpreadsheet>>()
      .mockResolvedValue(makeSpreadsheet()),
    getValues: vi
      .fn<(id: string, range: string) => Promise<GSValueRange>>()
      .mockResolvedValue(makeValueRange('Sheet1!1:101')),
    ...overrides,
  };
}

function createMockConfigProvider(
  config: GSConnectorInfo | null = mockConnectorConfig,
): GSConnectorConfigProvider {
  return { getConnectorConfig: vi.fn().mockResolvedValue(config) };
}

function createMockClientFactory(client?: GSClient, error?: Error): GSClientFactory {
  return {
    createClient: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(client),
  };
}

// ─── inferColumnType Tests ──────────────────────────────────────────────────

describe('inferColumnType', () => {
  test('returns string for empty array', () => {
    expect(inferColumnType([])).toBe('string');
  });

  test('returns string for all-empty values', () => {
    expect(inferColumnType(['', null, undefined, ''])).toBe('string');
  });

  test('returns number for all numeric strings', () => {
    expect(inferColumnType(['1', '2.5', '-3', '0'])).toBe('number');
  });

  test('returns number for native JS numbers', () => {
    expect(inferColumnType([1, 2.5, -3, 0])).toBe('number');
  });

  test('returns number for mixed native and string numbers', () => {
    expect(inferColumnType([1, '2.5', 3, '0'])).toBe('number');
  });

  test('returns boolean for native JS booleans', () => {
    expect(inferColumnType([true, false, true])).toBe('boolean');
  });

  test('returns boolean for string boolean literals', () => {
    expect(inferColumnType(['true', 'false', 'TRUE', 'FALSE'])).toBe('boolean');
  });

  test('returns boolean for mixed native and string booleans', () => {
    expect(inferColumnType([true, 'false', false, 'TRUE'])).toBe('boolean');
  });

  test('returns date for ISO 8601 date strings', () => {
    expect(inferColumnType(['2024-01-15', '2024-02-20', '2024-03-25'])).toBe('date');
  });

  test('returns date for ISO 8601 datetime strings', () => {
    expect(inferColumnType(['2024-01-15T10:30:00Z', '2024-02-20T14:00:00+05:30'])).toBe('date');
  });

  test('returns string for mixed types', () => {
    expect(inferColumnType(['hello', 42, true])).toBe('string');
  });

  test('returns string when numbers mixed with text', () => {
    expect(inferColumnType(['abc', '123'])).toBe('string');
  });

  test('ignores empty values when inferring type', () => {
    expect(inferColumnType(['', 1, '', 2, null])).toBe('number');
  });

  test('boolean takes priority over number (true/false are not 1/0 here)', () => {
    expect(inferColumnType([true, false])).toBe('boolean');
  });
});

// ─── isISO8601Date Tests ────────────────────────────────────────────────────

describe('isISO8601Date', () => {
  test('matches date-only format', () => {
    expect(isISO8601Date('2024-01-15')).toBe(true);
  });

  test('matches datetime with Z', () => {
    expect(isISO8601Date('2024-01-15T10:30:00Z')).toBe(true);
  });

  test('matches datetime with timezone offset', () => {
    expect(isISO8601Date('2024-01-15T10:30:00+05:30')).toBe(true);
  });

  test('matches datetime with milliseconds', () => {
    expect(isISO8601Date('2024-01-15T10:30:00.123Z')).toBe(true);
  });

  test('rejects plain text', () => {
    expect(isISO8601Date('hello')).toBe(false);
  });

  test('rejects numbers', () => {
    expect(isISO8601Date('12345')).toBe(false);
  });

  test('rejects non-ISO date formats', () => {
    expect(isISO8601Date('01/15/2024')).toBe(false);
    expect(isISO8601Date('Jan 15 2024')).toBe(false);
  });
});

// ─── detectEnumCandidates Tests ─────────────────────────────────────────────

describe('detectEnumCandidates', () => {
  test('returns undefined for empty array', () => {
    expect(detectEnumCandidates([])).toBeUndefined();
  });

  test('returns undefined for all-empty values', () => {
    expect(detectEnumCandidates(['', null, ''])).toBeUndefined();
  });

  test('detects enum with low cardinality', () => {
    const values = Array.from({ length: 100 }, (_, i) => ['Active', 'Inactive', 'Pending'][i % 3]);
    const result = detectEnumCandidates(values);
    expect(result).toEqual(['Active', 'Inactive', 'Pending']);
  });

  test('returns undefined when cardinality exceeds threshold', () => {
    const values = Array.from({ length: 100 }, (_, i) => `value-${i}`);
    expect(detectEnumCandidates(values)).toBeUndefined();
  });

  test('returns undefined when ratio is too high (near-unique)', () => {
    // 19 unique values out of 20 rows → ratio = 19/20 = 0.95 > 0.8
    const values = Array.from({ length: 20 }, (_, i) => (i < 19 ? `val-${i}` : 'val-0'));
    expect(detectEnumCandidates(values)).toBeUndefined();
  });

  test('detects enum with exactly max cardinality', () => {
    // 20 unique values but repeated enough → ratio check
    const baseValues = Array.from({ length: 20 }, (_, i) => `opt-${i}`);
    // Repeat each 5 times → 100 values, 20 unique → ratio 20/100 = 0.2 < 0.8
    const values = Array.from({ length: 100 }, (_, i) => baseValues[i % 20]);
    const result = detectEnumCandidates(values);
    expect(result).toHaveLength(20);
  });

  test('returns sorted unique values', () => {
    const values = ['Banana', 'Apple', 'Cherry', 'Apple', 'Banana', 'Cherry'];
    expect(detectEnumCandidates(values)).toEqual(['Apple', 'Banana', 'Cherry']);
  });

  test('converts non-string values to strings', () => {
    const values = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
    expect(detectEnumCandidates(values)).toEqual(['1', '2']);
  });
});

// ─── GoogleSheetsSchemaDiscoveryService Tests ───────────────────────────────

describe('GoogleSheetsSchemaDiscoveryService', () => {
  let configProvider: GSConnectorConfigProvider;
  let clientFactory: GSClientFactory;
  let mockClient: GSClient;
  let service: GoogleSheetsSchemaDiscoveryService;

  beforeEach(() => {
    mockClient = createMockGSClient();
    configProvider = createMockConfigProvider();
    clientFactory = createMockClientFactory(mockClient);
    service = new GoogleSheetsSchemaDiscoveryService(configProvider, clientFactory);
  });

  test('extends SchemaDiscoveryService', () => {
    expect(service).toBeInstanceOf(SchemaDiscoveryService);
  });

  describe('discoverSchema', () => {
    test('discovers fields from spreadsheet with correct hybrid method', async () => {
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.connectorId).toBe(CONNECTOR_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.discoveryMethod).toBe('hybrid');
      expect(result.metadata.connectorType).toBe('google-sheets');
      expect(result.metadata.version).toBe('v4');
      expect(result.fields.length).toBeGreaterThan(0);
    });

    test('discovers fields from multiple sheets', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSpreadsheet(['Sales', 'Inventory']),
      );
      (mockClient.getValues as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeValueRange('Sales!1:101', [['Product'], ['Widget']]))
        .mockResolvedValueOnce(makeValueRange('Inventory!1:101', [['SKU'], ['SKU-001']]));

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toHaveLength(2);
      expect(result.fields[0].path).toBe('sheets/Sales/columns/Product');
      expect(result.fields[1].path).toBe('sheets/Inventory/columns/SKU');
    });

    test('infers types from sampled data', async () => {
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange('Sheet1!1:101', [
          ['Name', 'Age', 'Active', 'Created'],
          ['Alice', 30, true, '2024-01-15'],
          ['Bob', 25, false, '2024-02-20'],
        ]),
      );

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      const fieldMap = new Map(result.fields.map((f) => [f.name, f]));
      expect(fieldMap.get('Name')!.type).toBe('string');
      expect(fieldMap.get('Age')!.type).toBe('number');
      expect(fieldMap.get('Active')!.type).toBe('boolean');
      expect(fieldMap.get('Created')!.type).toBe('date');
    });

    test('detects enum candidates from sampled data', async () => {
      const rows: unknown[][] = [['Status']];
      for (let i = 0; i < 100; i++) {
        rows.push([['Active', 'Inactive', 'Pending'][i % 3]]);
      }
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange('Sheet1!1:101', rows),
      );

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields[0].metadata.enumValues).toEqual(['Active', 'Inactive', 'Pending']);
    });

    test('uses provided spreadsheetId over connector config', async () => {
      const customId = 'custom-spreadsheet';
      await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        spreadsheetId: customId,
      });

      expect(mockClient.getSpreadsheet).toHaveBeenCalledWith(customId);
    });

    test('skips empty headers', async () => {
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange('Sheet1!1:101', [
          ['Name', '', null, 'Age'],
          ['Alice', '', null, 30],
        ]),
      );

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toHaveLength(2);
      expect(result.fields.map((f) => f.name)).toEqual(['Name', 'Age']);
    });

    test('skips sheets with no data', async () => {
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange('Sheet1!1:101', []),
      );

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toHaveLength(0);
    });

    test('throws when connector config not found', async () => {
      configProvider = createMockConfigProvider(null);
      service = new GoogleSheetsSchemaDiscoveryService(configProvider, clientFactory);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(`Connector not found: ${CONNECTOR_ID} for tenant ${TENANT_ID}`);
    });

    test('passes both connectorId and tenantId to config provider', async () => {
      await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });

      expect(configProvider.getConnectorConfig).toHaveBeenCalledWith(CONNECTOR_ID, TENANT_ID);
    });

    test('returns discoveredAt as a Date', async () => {
      const before = new Date();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });
      const after = new Date();

      expect(result.discoveredAt).toBeInstanceOf(Date);
      expect(result.discoveredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.discoveredAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('error handling', () => {
    test('wraps auth creation errors with ERR_GSHEETS_AUTH_FAILED', async () => {
      clientFactory = createMockClientFactory(undefined, new Error('invalid credentials'));
      service = new GoogleSheetsSchemaDiscoveryService(configProvider, clientFactory);

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain(GS_ERROR_CODES.AUTH_FAILED);
        expect((err as { code: string }).code).toBe(GS_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 401 status to ERR_GSHEETS_AUTH_FAILED', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      );

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(GS_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 403 status to ERR_GSHEETS_AUTH_FAILED', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(GS_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 404 status to ERR_GSHEETS_NOT_FOUND', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Not found'), { status: 404 }),
      );

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(GS_ERROR_CODES.NOT_FOUND);
      }
    });

    test('re-throws unknown errors as-is', async () => {
      const originalError = new Error('network timeout');
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(originalError);

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBe(originalError);
      }
    });
  });

  describe('rate limit retry with exponential backoff', () => {
    let sleepSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      sleepSpy = vi.spyOn(service, 'sleep' as keyof typeof service).mockResolvedValue(undefined);
    });

    test('retries on 429 and succeeds on subsequent attempt', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(makeSpreadsheet());

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields.length).toBeGreaterThan(0);
      expect(mockClient.getSpreadsheet).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(1000); // BASE_BACKOFF_MS * 2^0
    });

    test('retries on 500 server error', async () => {
      const serverError = Object.assign(new Error('Internal error'), { status: 500 });
      (mockClient.getValues as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeValueRange('Sheet1!1:101'));

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields.length).toBeGreaterThan(0);
      expect(mockClient.getValues).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    test('throws after exhausting retries on persistent 429', async () => {
      const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitError);

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error).message).toBe('Rate limited');
        // 1 initial + 3 retries = 4 total calls
        expect(mockClient.getSpreadsheet).toHaveBeenCalledTimes(4);
        // Exponential backoff: 1000, 2000, 4000
        expect(sleepSpy).toHaveBeenCalledTimes(3);
        expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
        expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
        expect(sleepSpy).toHaveBeenNthCalledWith(3, 4000);
      }
    });

    test('does not retry non-retryable errors (401)', async () => {
      const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(authError);

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(GS_ERROR_CODES.AUTH_FAILED);
        // Only 1 call — no retry for 401
        expect(mockClient.getSpreadsheet).toHaveBeenCalledTimes(1);
        expect(sleepSpy).not.toHaveBeenCalled();
      }
    });

    test('retries on 503 and verifies exponential delay progression', async () => {
      const serviceUnavailable = Object.assign(new Error('Service unavailable'), { status: 503 });
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(serviceUnavailable)
        .mockRejectedValueOnce(serviceUnavailable)
        .mockResolvedValueOnce(makeSpreadsheet());

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields.length).toBeGreaterThan(0);
      expect(mockClient.getSpreadsheet).toHaveBeenCalledTimes(3);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
    });
  });

  describe('sheet title quoting', () => {
    test('quotes sheet titles with spaces', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSpreadsheet(['Sales Data']),
      );
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange("'Sales Data'!1:101", [['Name'], ['Alice']]),
      );

      await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(mockClient.getValues).toHaveBeenCalledWith(SPREADSHEET_ID, "'Sales Data'!1:101");
    });

    test('leaves simple alphanumeric titles unquoted', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSpreadsheet(['Sheet1']),
      );

      await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(mockClient.getValues).toHaveBeenCalledWith(SPREADSHEET_ID, 'Sheet1!1:101');
    });

    test('escapes single quotes in sheet titles', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSpreadsheet(["Bob's Data"]),
      );
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeValueRange("'Bob''s Data'!1:101", [['Name'], ['Alice']]),
      );

      await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(mockClient.getValues).toHaveBeenCalledWith(SPREADSHEET_ID, "'Bob''s Data'!1:101");
    });
  });

  describe('handles missing values field', () => {
    test('skips sheet when values field is undefined', async () => {
      (mockClient.getValues as ReturnType<typeof vi.fn>).mockResolvedValue({
        range: 'Sheet1!1:101',
        majorDimension: 'ROWS',
        // no values field at all
      });

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      expect(result.fields).toHaveLength(0);
    });
  });

  describe('validateCredentials', () => {
    test('returns true when getSpreadsheet succeeds', async () => {
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(true);
      expect(mockClient.getSpreadsheet).toHaveBeenCalledWith(SPREADSHEET_ID);
    });

    test('returns false when connector config not found', async () => {
      configProvider = createMockConfigProvider(null);
      service = new GoogleSheetsSchemaDiscoveryService(configProvider, clientFactory);

      expect(await service.validateCredentials(CONNECTOR_ID, TENANT_ID)).toBe(false);
    });

    test('returns false when client creation fails', async () => {
      clientFactory = createMockClientFactory(undefined, new Error('auth failed'));
      service = new GoogleSheetsSchemaDiscoveryService(configProvider, clientFactory);

      expect(await service.validateCredentials(CONNECTOR_ID, TENANT_ID)).toBe(false);
    });

    test('returns false when getSpreadsheet throws', async () => {
      (mockClient.getSpreadsheet as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network error'),
      );

      expect(await service.validateCredentials(CONNECTOR_ID, TENANT_ID)).toBe(false);
    });
  });
});
