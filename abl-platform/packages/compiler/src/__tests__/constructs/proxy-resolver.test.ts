/**
 * Proxy Resolver Tests
 *
 * Verifies URL pattern matching, priority ordering, auth injection,
 * bypass patterns, SSRF checks on proxy URL, and certificate handling.
 */

import { describe, it, expect } from 'vitest';
import { ProxyResolver } from '../../platform/constructs/executors/proxy-resolver.js';
import type {
  OrgProxyConfigRecord,
  ProxyConfig,
} from '../../platform/constructs/executors/proxy-resolver.js';

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
describe('ProxyResolver', () => {
  describe('URL pattern matching', () => {
    it('should match wildcard * pattern to any URL', () => {
      const resolver = new ProxyResolver([createRecord({ urlPatterns: '*' })]);

      const result = resolver.resolve('https://api.example.com/data');
      expect(result).not.toBeNull();
      expect(result!.proxyUrl).toBe('https://proxy.example.com:8080');
    });

    it('should match exact hostname pattern', () => {
      const resolver = new ProxyResolver([createRecord({ urlPatterns: 'api.internal.com' })]);

      expect(resolver.resolve('https://api.internal.com/v1/data')).not.toBeNull();
      expect(resolver.resolve('https://other.example.com/v1/data')).toBeNull();
    });

    it('should match glob hostname pattern', () => {
      const resolver = new ProxyResolver([createRecord({ urlPatterns: '*.internal.com' })]);

      expect(resolver.resolve('https://api.internal.com/v1')).not.toBeNull();
      expect(resolver.resolve('https://db.internal.com/query')).not.toBeNull();
      expect(resolver.resolve('https://api.external.com/v1')).toBeNull();
    });

    it('should match multiple comma-separated patterns', () => {
      const resolver = new ProxyResolver([
        createRecord({ urlPatterns: '*.internal.com, api.partner.io' }),
      ]);

      expect(resolver.resolve('https://api.internal.com/v1')).not.toBeNull();
      expect(resolver.resolve('https://api.partner.io/v2')).not.toBeNull();
      expect(resolver.resolve('https://random.com')).toBeNull();
    });
  });

  describe('bypass patterns', () => {
    it('should skip proxy for URLs matching bypass pattern', () => {
      const resolver = new ProxyResolver([
        createRecord({
          urlPatterns: '*',
          bypassPatterns: '*.public-api.com',
        }),
      ]);

      expect(resolver.resolve('https://data.public-api.com/v1')).toBeNull();
      expect(resolver.resolve('https://internal.corp.com/api')).not.toBeNull();
    });
  });

  describe('priority ordering', () => {
    it('should return highest priority match first', () => {
      const resolver = new ProxyResolver([
        createRecord({
          id: 'low',
          name: 'Low Priority',
          proxyUrl: 'https://low-proxy.example.com:8080',
          urlPatterns: '*',
          priority: 0,
        }),
        createRecord({
          id: 'high',
          name: 'High Priority',
          proxyUrl: 'https://high-proxy.example.com:8080',
          urlPatterns: '*',
          priority: 10,
        }),
      ]);

      const result = resolver.resolve('https://api.example.com/data');
      expect(result).not.toBeNull();
      expect(result!.proxyUrl).toBe('https://high-proxy.example.com:8080');
    });
  });

  describe('proxy auth', () => {
    it('should apply basic auth header', () => {
      const headers: Record<string, string> = {};
      const config: ProxyConfig = {
        proxyUrl: 'https://proxy.example.com',
        authType: 'basic',
        username: 'user',
        password: 'pass',
      };

      ProxyResolver.applyProxyAuth(config, headers);

      const expected = Buffer.from('user:pass').toString('base64');
      expect(headers['Proxy-Authorization']).toBe(`Basic ${expected}`);
    });

    it('should apply bearer token auth', () => {
      const headers: Record<string, string> = {};
      const config: ProxyConfig = {
        proxyUrl: 'https://proxy.example.com',
        authType: 'bearer',
        token: 'my-token',
      };

      ProxyResolver.applyProxyAuth(config, headers);
      expect(headers['Proxy-Authorization']).toBe('Bearer my-token');
    });

    it('should apply api_key token directly', () => {
      const headers: Record<string, string> = {};
      const config: ProxyConfig = {
        proxyUrl: 'https://proxy.example.com',
        authType: 'api_key',
        token: 'ak_12345',
      };

      ProxyResolver.applyProxyAuth(config, headers);
      expect(headers['Proxy-Authorization']).toBe('ak_12345');
    });

    it('should not add header for none auth type', () => {
      const headers: Record<string, string> = {};
      const config: ProxyConfig = {
        proxyUrl: 'https://proxy.example.com',
        authType: 'none',
      };

      ProxyResolver.applyProxyAuth(config, headers);
      expect(headers['Proxy-Authorization']).toBeUndefined();
    });
  });

  describe('SSRF check on proxy URL', () => {
    it('should reject proxy pointing to private IP', () => {
      const resolver = new ProxyResolver([createRecord({ proxyUrl: 'http://127.0.0.1:8080' })]);

      // The invalid config should be skipped, so resolve returns null
      expect(resolver.resolve('https://api.example.com')).toBeNull();
      expect(resolver.hasConfigs).toBe(false);
    });

    it('should reject proxy pointing to cloud metadata', () => {
      const resolver = new ProxyResolver([createRecord({ proxyUrl: 'http://169.254.169.254' })]);

      expect(resolver.resolve('https://api.example.com')).toBeNull();
      expect(resolver.hasConfigs).toBe(false);
    });
  });

  describe('certificate handling', () => {
    it('should decrypt and include custom CA certificate', () => {
      const resolver = new ProxyResolver([
        createRecord({
          _resolvedCaCertificate: 'decrypted:encrypted-ca-cert',
        }),
      ]);

      const result = resolver.resolve('https://api.example.com');
      expect(result).not.toBeNull();
      expect(result!.caCertificate).toBe('decrypted:encrypted-ca-cert');
    });

    it('should decrypt and include mTLS client cert + key', () => {
      const resolver = new ProxyResolver([
        createRecord({
          _resolvedClientCert: 'decrypted:encrypted-client-cert',
          _resolvedClientKey: 'decrypted:encrypted-client-key',
        }),
      ]);

      const result = resolver.resolve('https://api.example.com');
      expect(result).not.toBeNull();
      expect(result!.clientCert).toBe('decrypted:encrypted-client-cert');
      expect(result!.clientKey).toBe('decrypted:encrypted-client-key');
    });
  });

  describe('disabled configs', () => {
    it('should exclude disabled configs', () => {
      const resolver = new ProxyResolver([createRecord({ enabled: false })]);

      expect(resolver.resolve('https://api.example.com')).toBeNull();
      expect(resolver.hasConfigs).toBe(false);
    });
  });

  describe('mTLS + CA cert combined (T3)', () => {
    it('should handle mTLS client cert + key + CA cert + auth together', () => {
      const resolver = new ProxyResolver([
        createRecord({
          proxyAuthType: 'bearer',
          _resolvedProxyToken: 'decrypted:enc-gw-token',
          _resolvedCaCertificate: 'decrypted:enc-ca-pem',
          _resolvedClientCert: 'decrypted:enc-client-cert',
          _resolvedClientKey: 'decrypted:enc-client-key',
        }),
      ]);

      const result = resolver.resolve('https://partner-api.example.com/');
      expect(result).not.toBeNull();
      expect(result!.authType).toBe('bearer');
      expect(result!.token).toBe('decrypted:enc-gw-token');
      expect(result!.caCertificate).toBe('decrypted:enc-ca-pem');
      expect(result!.clientCert).toBe('decrypted:enc-client-cert');
      expect(result!.clientKey).toBe('decrypted:enc-client-key');
    });

    it('should handle null cert fields gracefully', () => {
      const resolver = new ProxyResolver([
        createRecord({
          encryptedCaCertificate: null,
          encryptedClientCert: null,
          encryptedClientKey: null,
        }),
      ]);

      const result = resolver.resolve('https://api.example.com/');
      expect(result).not.toBeNull();
      expect(result!.caCertificate).toBeUndefined();
      expect(result!.clientCert).toBeUndefined();
      expect(result!.clientKey).toBeUndefined();
    });

    it('should ignore unresolved auth material when not pre-resolved', () => {
      const resolver = new ProxyResolver([
        createRecord({
          proxyAuthType: 'bearer',
          encryptedProxyToken: 'corrupted-data',
        }),
      ]);

      const result = resolver.resolve('https://api.example.com/');
      expect(result).not.toBeNull();
      expect(result!.token).toBeUndefined();
    });
  });

  describe('no match', () => {
    it('should return null when no patterns match', () => {
      const resolver = new ProxyResolver([createRecord({ urlPatterns: '*.internal.com' })]);

      expect(resolver.resolve('https://api.external.com/data')).toBeNull();
    });

    it('should return null for empty config list', () => {
      const resolver = new ProxyResolver([]);
      expect(resolver.resolve('https://api.example.com')).toBeNull();
    });
  });

  describe('credential decryption', () => {
    it('should decrypt basic auth credentials', () => {
      const resolver = new ProxyResolver([
        createRecord({
          proxyAuthType: 'basic',
          _resolvedProxyUsername: 'decrypted:enc-user',
          _resolvedProxyPassword: 'decrypted:enc-pass',
        }),
      ]);

      const result = resolver.resolve('https://api.example.com');
      expect(result).not.toBeNull();
      expect(result!.authType).toBe('basic');
      expect(result!.username).toBe('decrypted:enc-user');
      expect(result!.password).toBe('decrypted:enc-pass');
    });

    it('should decrypt bearer token', () => {
      const resolver = new ProxyResolver([
        createRecord({
          proxyAuthType: 'bearer',
          _resolvedProxyToken: 'decrypted:enc-token',
        }),
      ]);

      const result = resolver.resolve('https://api.example.com');
      expect(result).not.toBeNull();
      expect(result!.authType).toBe('bearer');
      expect(result!.token).toBe('decrypted:enc-token');
    });
  });
});
