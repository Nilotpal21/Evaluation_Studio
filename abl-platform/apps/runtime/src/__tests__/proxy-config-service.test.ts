/**
 * Proxy Config Service Tests
 *
 * Verifies config loading from store, caching, cache invalidation,
 * empty configs, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyConfigService } from '../services/proxy-config-service.js';
import type { ProxyConfigStore } from '../services/proxy-config-service.js';
import type { OrgProxyConfigRecord } from '@abl/compiler';

function createMockStore(records: OrgProxyConfigRecord[] = []): ProxyConfigStore {
  return {
    findConfigs: vi.fn(async () => records),
  };
}

function createRecord(overrides: Partial<OrgProxyConfigRecord> = {}): OrgProxyConfigRecord {
  return {
    id: 'cfg-1',
    tenantId: 'org-1',
    name: 'Test Proxy',
    proxyUrl: 'https://proxy.example.com:8080',
    proxyAuthType: 'none',
    encryptedProxyUsername: null,
    encryptedProxyPassword: null,
    encryptedProxyToken: null,
    encryptedCaCertificate: null,
    encryptedClientCert: null,
    encryptedClientKey: null,
    urlPatterns: '*',
    bypassPatterns: null,
    environment: 'dev',
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

const mockDecrypt = async (encrypted: string, _tenantId: string) => `dec:${encrypted}`;

describe('ProxyConfigService', () => {
  let store: ProxyConfigStore;
  let service: ProxyConfigService;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should load configs from store and create resolver', async () => {
    store = createMockStore([createRecord()]);
    service = new ProxyConfigService(store, mockDecrypt);

    const resolver = await service.getResolver('org-1', 'dev');
    expect(resolver).not.toBeNull();
    expect(resolver!.hasConfigs).toBe(true);
    expect(store.findConfigs).toHaveBeenCalledWith({
      tenantId: 'org-1',
      environment: 'dev',
    });
  });

  it('should return null for empty configs', async () => {
    store = createMockStore([]);
    service = new ProxyConfigService(store, mockDecrypt);

    const resolver = await service.getResolver('org-1', 'dev');
    expect(resolver).toBeNull();
  });

  it('should cache resolver and not re-query store', async () => {
    store = createMockStore([createRecord()]);
    service = new ProxyConfigService(store, mockDecrypt);

    await service.getResolver('org-1', 'dev');
    await service.getResolver('org-1', 'dev');

    // Should only query once due to caching
    expect(store.findConfigs).toHaveBeenCalledTimes(1);
  });

  it('should invalidate cache by org+env', async () => {
    store = createMockStore([createRecord()]);
    service = new ProxyConfigService(store, mockDecrypt);

    await service.getResolver('org-1', 'dev');
    service.invalidate('org-1', 'dev');
    await service.getResolver('org-1', 'dev');

    expect(store.findConfigs).toHaveBeenCalledTimes(2);
  });

  it('should invalidate all environments for an org', async () => {
    store = createMockStore([createRecord()]);
    service = new ProxyConfigService(store, mockDecrypt);

    await service.getResolver('org-1', 'dev');
    await service.getResolver('org-1', 'staging');
    service.invalidate('org-1');
    await service.getResolver('org-1', 'dev');
    await service.getResolver('org-1', 'staging');

    // 2 initial + 2 after invalidation = 4
    expect(store.findConfigs).toHaveBeenCalledTimes(4);
  });

  it('should handle store errors gracefully', async () => {
    store = {
      findConfigs: vi.fn().mockRejectedValue(new Error('DB connection failed')),
    };
    service = new ProxyConfigService(store, mockDecrypt);

    const resolver = await service.getResolver('org-1', 'dev');
    expect(resolver).toBeNull();
  });

  it('should default environment to dev', async () => {
    store = createMockStore([createRecord()]);
    service = new ProxyConfigService(store, mockDecrypt);

    await service.getResolver('org-1');
    expect(store.findConfigs).toHaveBeenCalledWith({
      tenantId: 'org-1',
      environment: 'dev',
    });
  });

  it('should resolve URL through loaded proxy config', async () => {
    store = createMockStore([
      createRecord({
        urlPatterns: '*.internal.com',
        proxyAuthType: 'bearer',
        encryptedProxyToken: 'tok-123',
      }),
    ]);
    service = new ProxyConfigService(store, mockDecrypt);

    const resolver = await service.getResolver('org-1', 'dev');
    expect(resolver).not.toBeNull();

    const config = resolver!.resolve('https://api.internal.com/v1');
    expect(config).not.toBeNull();
    expect(config!.proxyUrl).toBe('https://proxy.example.com:8080');
    expect(config!.authType).toBe('bearer');
    expect(config!.token).toBe('dec:tok-123');

    // Should not match external URL
    const noMatch = resolver!.resolve('https://api.external.com/v1');
    expect(noMatch).toBeNull();
  });
});
