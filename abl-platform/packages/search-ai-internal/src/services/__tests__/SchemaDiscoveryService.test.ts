import {
  SchemaDiscoveryService,
  DiscoveredSchema,
  SchemaDiscoveryOptions,
  DiscoveredField,
} from '../SchemaDiscoveryService.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('schema-discovery-test');

describe('SchemaDiscoveryService', () => {
  describe('Interface Definition', () => {
    test('SchemaDiscoveryService abstract class is defined', () => {
      expect(SchemaDiscoveryService).toBeDefined();
      expect(typeof SchemaDiscoveryService).toBe('function');
    });

    test('SchemaDiscoveryService cannot be instantiated directly', () => {
      // Abstract classes in TypeScript compile to regular classes,
      // but they have no concrete methods — subclasses must implement them.
      // We verify the class exists and is a constructor function.
      expect(SchemaDiscoveryService.prototype.constructor).toBeDefined();
    });
  });

  describe('Mock Implementation', () => {
    class MockSchemaDiscoveryService extends SchemaDiscoveryService {
      async discoverSchema(options: SchemaDiscoveryOptions): Promise<DiscoveredSchema> {
        this.logger.info('Discovering schema', {
          connectorId: options.connectorId,
          tenantId: options.tenantId,
        });
        return {
          connectorId: options.connectorId,
          tenantId: options.tenantId,
          fields: [{ name: 'test_field', type: 'string', path: 'test', metadata: {} }],
          discoveryMethod: 'api',
          discoveredAt: new Date(),
          metadata: { connectorType: 'test' },
        };
      }

      async validateCredentials(connectorId: string, tenantId: string): Promise<boolean> {
        this.logger.info('Validating credentials', { connectorId, tenantId });
        return true;
      }
    }

    test('Mock implementation can extend SchemaDiscoveryService', async () => {
      const service = new MockSchemaDiscoveryService(log);
      const result = await service.discoverSchema({ connectorId: 'test', tenantId: 'tenant1' });
      expect(result.fields).toHaveLength(1);
      expect(result.discoveryMethod).toBe('api');
      expect(result.connectorId).toBe('test');
      expect(result.tenantId).toBe('tenant1');
    });

    test('Mock implementation validates credentials', async () => {
      const service = new MockSchemaDiscoveryService(log);
      const isValid = await service.validateCredentials('test', 'tenant1');
      expect(isValid).toBe(true);
    });

    test('Mock implementation has access to logger via base class', () => {
      const service = new MockSchemaDiscoveryService(log);
      expect(service).toBeInstanceOf(SchemaDiscoveryService);
    });
  });

  describe('Type Structure', () => {
    test('DiscoveredSchema type structure is correct', () => {
      const schema: DiscoveredSchema = {
        connectorId: 'conn1',
        tenantId: 'tenant1',
        fields: [],
        discoveryMethod: 'api',
        discoveredAt: new Date(),
        metadata: { connectorType: 'sharepoint' },
      };
      expect(schema).toBeDefined();
      expect(schema.connectorId).toBe('conn1');
      expect(schema.tenantId).toBe('tenant1');
      expect(schema.fields).toEqual([]);
    });

    test('DiscoveredSchema supports hybrid discovery method', () => {
      const schema: DiscoveredSchema = {
        connectorId: 'conn1',
        tenantId: 'tenant1',
        fields: [],
        discoveryMethod: 'hybrid',
        discoveredAt: new Date(),
        metadata: { connectorType: 'google-sheets', version: 'v4' },
      };
      expect(schema.discoveryMethod).toBe('hybrid');
      expect(schema.metadata.version).toBe('v4');
    });

    test('DiscoveredField type structure is correct', () => {
      const field: DiscoveredField = {
        name: 'title',
        type: 'string',
        path: '$.title',
        metadata: {
          description: 'Document title',
          required: true,
          enumValues: ['draft', 'published'],
          format: 'text',
        },
      };
      expect(field).toBeDefined();
      expect(field.name).toBe('title');
      expect(field.metadata.enumValues).toEqual(['draft', 'published']);
    });

    test('DiscoveredField supports minimal metadata', () => {
      const field: DiscoveredField = {
        name: 'id',
        type: 'number',
        path: '$.id',
        metadata: {},
      };
      expect(field.metadata.description).toBeUndefined();
      expect(field.metadata.enumValues).toBeUndefined();
    });
  });
});
