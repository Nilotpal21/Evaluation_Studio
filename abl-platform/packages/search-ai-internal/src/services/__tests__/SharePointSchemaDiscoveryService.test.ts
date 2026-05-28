import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  SharePointSchemaDiscoveryService,
  mapSharePointType,
  SP_ERROR_CODES,
  type ConnectorConfigProvider,
  type GraphClientFactory,
  type SharePointConnectorInfo,
  type SPColumnDefinition,
  type SPListInfo,
  type SPGraphClient,
} from '../SharePointSchemaDiscoveryService.js';
import { SchemaDiscoveryService } from '../SchemaDiscoveryService.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-abc';
const CONNECTOR_ID = 'sp-connector-1';
const SITE_ID = 'site-xyz';
const LIST_ID = 'list-123';

const mockConnectorConfig: SharePointConnectorInfo = {
  connectorId: CONNECTOR_ID,
  tenantId: TENANT_ID,
  siteId: SITE_ID,
  connectionConfig: {
    tenantUrl: 'https://contoso.sharepoint.com',
    clientId: 'client-id',
    scopes: ['https://graph.microsoft.com/.default'],
  },
};

function makeColumn(overrides: Partial<SPColumnDefinition> = {}): SPColumnDefinition {
  return {
    id: 'col-1',
    name: 'Title',
    displayName: 'Title',
    description: '',
    readOnly: false,
    hidden: false,
    required: false,
    indexed: false,
    text: { allowMultipleLines: false, maxLength: 255 },
    ...overrides,
  };
}

function makeList(overrides: Partial<SPListInfo> = {}): SPListInfo {
  return {
    id: LIST_ID,
    name: 'Documents',
    displayName: 'Documents',
    list: { hidden: false },
    ...overrides,
  };
}

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockGraphClient(overrides: Partial<SPGraphClient> = {}): SPGraphClient {
  return {
    getLists: vi.fn<(siteId: string) => Promise<SPListInfo[]>>().mockResolvedValue([makeList()]),
    getListColumns: vi
      .fn<(siteId: string, listId: string) => Promise<SPColumnDefinition[]>>()
      .mockResolvedValue([makeColumn()]),
    getSites: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockConfigProvider(
  config: SharePointConnectorInfo | null = mockConnectorConfig,
): ConnectorConfigProvider {
  return {
    getConnectorConfig: vi.fn().mockResolvedValue(config),
  };
}

function createMockClientFactory(client?: SPGraphClient, error?: Error): GraphClientFactory {
  const factory: GraphClientFactory = {
    createClient: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(client),
  };
  return factory;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SharePointSchemaDiscoveryService', () => {
  let configProvider: ConnectorConfigProvider;
  let clientFactory: GraphClientFactory;
  let mockClient: SPGraphClient;
  let service: SharePointSchemaDiscoveryService;

  beforeEach(() => {
    mockClient = createMockGraphClient();
    configProvider = createMockConfigProvider();
    clientFactory = createMockClientFactory(mockClient);
    service = new SharePointSchemaDiscoveryService(configProvider, clientFactory);
  });

  test('extends SchemaDiscoveryService', () => {
    expect(service).toBeInstanceOf(SchemaDiscoveryService);
  });

  describe('discoverSchema', () => {
    test('returns static DriveItem fields when no listId specified', async () => {
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
      });

      // No API calls needed for file-based discovery — static schema
      expect(mockClient.getLists).not.toHaveBeenCalled();
      expect(mockClient.getListColumns).not.toHaveBeenCalled();
      expect(result.fields.length).toBeGreaterThan(0);
      expect(result.fields.some((f) => f.name === 'itemName')).toBe(true);
      expect(result.fields.some((f) => f.name === 'createdDateTime')).toBe(true);
      expect(result.fields.some((f) => f.name === 'mimeType')).toBe(true);
      expect(result.connectorId).toBe(CONNECTOR_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.discoveryMethod).toBe('api');
      expect(result.metadata.connectorType).toBe('sharepoint');
    });

    test('discovers fields from a specific list when listId provided', async () => {
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        listId: LIST_ID,
      });

      expect(mockClient.getLists).not.toHaveBeenCalled();
      expect(mockClient.getListColumns).toHaveBeenCalledWith(SITE_ID, LIST_ID);
      expect(result.fields.length).toBeGreaterThan(0);
    });

    test('uses provided siteId over connector config siteId', async () => {
      const customSiteId = 'custom-site-id';
      await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        siteId: customSiteId,
        listId: LIST_ID,
      });

      expect(mockClient.getListColumns).toHaveBeenCalledWith(customSiteId, LIST_ID);
    });

    test('throws when connector config not found', async () => {
      configProvider = createMockConfigProvider(null);
      service = new SharePointSchemaDiscoveryService(configProvider, clientFactory);

      await expect(
        service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID }),
      ).rejects.toThrow(`Connector not found: ${CONNECTOR_ID} for tenant ${TENANT_ID}`);
    });

    test('filters out hidden and readOnly columns', async () => {
      const columns: SPColumnDefinition[] = [
        makeColumn({ name: 'visible', hidden: false, readOnly: false }),
        makeColumn({ name: 'hidden', hidden: true, readOnly: false }),
        makeColumn({ name: 'readOnly', hidden: false, readOnly: true }),
        makeColumn({ name: 'both', hidden: true, readOnly: true }),
      ];
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockResolvedValue(columns);

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        listId: LIST_ID,
      });

      expect(result.fields).toHaveLength(1);
      expect(result.fields[0].name).toBe('visible');
    });

    test('maps column to DiscoveredField with correct path and metadata', async () => {
      const columns: SPColumnDefinition[] = [
        makeColumn({
          name: 'Status',
          displayName: 'Status',
          required: true,
          text: undefined,
          choice: { allowTextEntry: false, choices: ['Active', 'Inactive'], displayAs: 'dropdown' },
        }),
      ];
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockResolvedValue(columns);

      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        listId: LIST_ID,
      });

      expect(result.fields[0]).toEqual({
        name: 'Status',
        type: 'string',
        path: `lists/${LIST_ID}/columns/Status`,
        metadata: {
          description: 'Status',
          required: true,
          enumValues: ['Active', 'Inactive'],
          format: undefined,
        },
      });
    });

    test('returns discoveredAt as a Date', async () => {
      const before = new Date();
      const result = await service.discoverSchema({
        connectorId: CONNECTOR_ID,
        tenantId: TENANT_ID,
        listId: LIST_ID,
      });
      const after = new Date();

      expect(result.discoveredAt).toBeInstanceOf(Date);
      expect(result.discoveredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.discoveredAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('error handling', () => {
    test('wraps auth creation errors with ERR_SP_AUTH_FAILED code', async () => {
      clientFactory = createMockClientFactory(undefined, new Error('token expired'));
      service = new SharePointSchemaDiscoveryService(configProvider, clientFactory);

      try {
        await service.discoverSchema({ connectorId: CONNECTOR_ID, tenantId: TENANT_ID });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(SP_ERROR_CODES.AUTH_FAILED);
        expect((err as Error).message).toContain('token expired');
        expect((err as { code: string }).code).toBe(SP_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 401 status to ERR_SP_AUTH_FAILED', async () => {
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      );

      try {
        await service.discoverSchema({
          connectorId: CONNECTOR_ID,
          tenantId: TENANT_ID,
          listId: LIST_ID,
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(SP_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 403 status to ERR_SP_AUTH_FAILED', async () => {
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );

      try {
        await service.discoverSchema({
          connectorId: CONNECTOR_ID,
          tenantId: TENANT_ID,
          listId: LIST_ID,
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(SP_ERROR_CODES.AUTH_FAILED);
      }
    });

    test('maps 404 status to ERR_SP_LIST_NOT_FOUND', async () => {
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Not found'), { status: 404 }),
      );

      try {
        await service.discoverSchema({
          connectorId: CONNECTOR_ID,
          tenantId: TENANT_ID,
          listId: LIST_ID,
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as { code: string }).code).toBe(SP_ERROR_CODES.LIST_NOT_FOUND);
      }
    });

    test('re-throws unknown errors as-is', async () => {
      const originalError = new Error('network timeout');
      (mockClient.getListColumns as ReturnType<typeof vi.fn>).mockRejectedValue(originalError);

      try {
        await service.discoverSchema({
          connectorId: CONNECTOR_ID,
          tenantId: TENANT_ID,
          listId: LIST_ID,
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBe(originalError);
      }
    });
  });

  describe('validateCredentials', () => {
    test('returns true when getSites succeeds', async () => {
      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(true);
      expect(mockClient.getSites).toHaveBeenCalled();
    });

    test('returns false when connector config not found', async () => {
      configProvider = createMockConfigProvider(null);
      service = new SharePointSchemaDiscoveryService(configProvider, clientFactory);

      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });

    test('returns false when client creation fails', async () => {
      clientFactory = createMockClientFactory(undefined, new Error('auth failed'));
      service = new SharePointSchemaDiscoveryService(configProvider, clientFactory);

      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });

    test('returns false when getSites throws', async () => {
      (mockClient.getSites as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network error'),
      );

      const result = await service.validateCredentials(CONNECTOR_ID, TENANT_ID);
      expect(result).toBe(false);
    });
  });
});

describe('mapSharePointType', () => {
  test('maps text columns to string', () => {
    expect(
      mapSharePointType(makeColumn({ text: { allowMultipleLines: false, maxLength: 255 } })),
    ).toBe('string');
  });

  test('maps number columns to number', () => {
    expect(
      mapSharePointType(
        makeColumn({ text: undefined, number: { decimalPlaces: '2', maximum: 100, minimum: 0 } }),
      ),
    ).toBe('number');
  });

  test('maps currency columns to number', () => {
    expect(mapSharePointType(makeColumn({ text: undefined, currency: { locale: 'en-US' } }))).toBe(
      'number',
    );
  });

  test('maps dateTime columns to date', () => {
    expect(
      mapSharePointType(
        makeColumn({ text: undefined, dateTime: { displayAs: 'default', format: 'dateOnly' } }),
      ),
    ).toBe('date');
  });

  test('maps boolean columns to boolean', () => {
    expect(mapSharePointType(makeColumn({ text: undefined, boolean: {} }))).toBe('boolean');
  });

  test('maps choice columns to string', () => {
    expect(
      mapSharePointType(
        makeColumn({
          text: undefined,
          choice: { allowTextEntry: false, choices: ['A', 'B'], displayAs: 'dropdown' },
        }),
      ),
    ).toBe('string');
  });

  test('maps lookup columns to string', () => {
    expect(
      mapSharePointType(
        makeColumn({
          text: undefined,
          lookup: { allowMultipleValues: false, columnName: 'Title', listId: 'list-1' },
        }),
      ),
    ).toBe('string');
  });

  test('maps personOrGroup columns to string', () => {
    expect(
      mapSharePointType(
        makeColumn({
          text: undefined,
          personOrGroup: { allowMultipleSelection: false, chooseFromType: 'peopleOnly' },
        }),
      ),
    ).toBe('string');
  });

  test('maps calculated columns to string', () => {
    expect(
      mapSharePointType(
        makeColumn({
          text: undefined,
          calculated: { format: 'number', formula: '=A+B', outputType: 'text' },
        }),
      ),
    ).toBe('string');
  });

  test('maps hyperlinkOrPicture columns to string', () => {
    expect(
      mapSharePointType(makeColumn({ text: undefined, hyperlinkOrPicture: { isPicture: false } })),
    ).toBe('string');
  });

  test('defaults to string for unknown column types', () => {
    expect(mapSharePointType(makeColumn({ text: undefined }))).toBe('string');
  });
});
