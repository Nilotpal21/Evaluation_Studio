/**
 * Five9Adapter Registry Integration Tests
 *
 * INT-11: Five9Adapter registration in AdapterRegistry
 *
 * Tests that the Five9Adapter can be registered, retrieved, and
 * used through the AdapterRegistry. No codebase component mocking.
 */
import { describe, it, expect } from 'vitest';
import { Five9Adapter } from '../index.js';
import { AdapterRegistry } from '../../registry.js';
import type { Five9Credentials } from '../types.js';

function makeCredentials(): Five9Credentials {
  return {
    tenantName: 'test-tenant',
    campaignName: 'test-campaign',
    host: 'app.five9.com',
    authMode: 'anonymous',
  };
}

describe('Five9Adapter Registry Integration Tests', () => {
  describe('INT-11: Five9Adapter registration in AdapterRegistry', () => {
    it('registers Five9Adapter under the five9 name', () => {
      const registry = new AdapterRegistry();
      const adapter = new Five9Adapter(makeCredentials());

      registry.register('five9', adapter);

      expect(registry.has('five9')).toBe(true);
      expect(registry.listNames()).toContain('five9');
    });

    it('retrieves the registered Five9Adapter by name', () => {
      const registry = new AdapterRegistry();
      const adapter = new Five9Adapter(makeCredentials());

      registry.register('five9', adapter);

      const retrieved = registry.get('five9');
      expect(retrieved).toBe(adapter);
      expect(retrieved?.name).toBe('five9');
    });

    it('getOrThrow returns the adapter when registered', () => {
      const registry = new AdapterRegistry();
      const adapter = new Five9Adapter(makeCredentials());

      registry.register('five9', adapter);

      const retrieved = registry.getOrThrow('five9');
      expect(retrieved).toBe(adapter);
    });

    it('getOrThrow throws when adapter not registered', () => {
      const registry = new AdapterRegistry();

      expect(() => registry.getOrThrow('five9')).toThrow("Adapter 'five9' not found");
    });

    it('prevents duplicate registration', () => {
      const registry = new AdapterRegistry();
      const adapter1 = new Five9Adapter(makeCredentials());
      const adapter2 = new Five9Adapter(makeCredentials());

      registry.register('five9', adapter1);

      expect(() => registry.register('five9', adapter2)).toThrow(
        "Adapter 'five9' is already registered",
      );
    });

    it('can coexist with other adapters (e.g. kore)', () => {
      const registry = new AdapterRegistry();
      const five9Adapter = new Five9Adapter(makeCredentials());

      // Simulate a second adapter with a different name
      const mockKoreAdapter = new Five9Adapter(makeCredentials());
      Object.defineProperty(mockKoreAdapter, 'name', { value: 'kore' });

      registry.register('five9', five9Adapter);
      registry.register('kore', mockKoreAdapter);

      expect(registry.listNames()).toEqual(expect.arrayContaining(['five9', 'kore']));
      expect(registry.get('five9')).toBe(five9Adapter);
      expect(registry.get('kore')).toBe(mockKoreAdapter);
    });

    it('unregister removes the adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new Five9Adapter(makeCredentials());

      registry.register('five9', adapter);
      expect(registry.has('five9')).toBe(true);

      const removed = registry.unregister('five9');
      expect(removed).toBe(true);
      expect(registry.has('five9')).toBe(false);
    });

    it('adapter capabilities are correct', () => {
      const adapter = new Five9Adapter(makeCredentials());

      expect(adapter.capabilities).toEqual({
        supportsPreChecks: false,
        supportsPostAgentDialog: false,
        supportsFileUpload: false,
        supportsTranslation: false,
        transportType: 'webhook',
        authType: 'bearer',
      });
    });
  });
});
