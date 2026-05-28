import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigLoader, type VaultProvider } from '@agent-platform/config';
import { RuntimeConfigSchema } from '../config/index.js';

function createMockProvider(values: Record<string, string>): VaultProvider {
  return {
    name: 'mock',
    initialize: vi.fn(),
    get: vi.fn(async (key: string) => values[key]),
    getAll: vi.fn(async () => values),
    isAvailable: vi.fn(() => true),
    close: vi.fn(),
  };
}

describe('Runtime config SDK secret schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads config when both dedicated SDK secrets are configured', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'development',
      JWT_SECRET: 'j'.repeat(64),
      AUTH_SDK_SESSION_SIGNING_SECRET: 's'.repeat(64),
      AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: 'b'.repeat(64),
    });

    const loader = createConfigLoader(RuntimeConfigSchema);
    const config = await loader.loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    expect(config.auth.sdk.sessionSigningSecret).toBe('s'.repeat(64));
    expect(config.auth.sdk.bootstrapSigningSecret).toBe('b'.repeat(64));
  });

  it('loads config without SDK secrets (shape-only validation)', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'test',
      JWT_SECRET: 'j'.repeat(64),
    });

    const loader = createConfigLoader(RuntimeConfigSchema);
    const config = await loader.loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    // Schema accepts missing secrets — operational enforcement is in sdk-secret-config.ts
    expect(config.auth.sdk.sessionSigningSecret).toBeUndefined();
    expect(config.auth.sdk.bootstrapSigningSecret).toBeUndefined();
  });
});

describe('Runtime SDK secret config helpers (operational enforcement)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns dedicated secret when configured', async () => {
    vi.doMock('../config/index.js', () => ({
      getConfig: () => ({
        env: 'production',
        jwt: { secret: 'jwt-fallback' },
        auth: {
          sdk: {
            sessionSigningSecret: 'dedicated-session-secret',
            bootstrapSigningSecret: 'dedicated-bootstrap-secret',
          },
        },
      }),
    }));

    const {
      getRuntimeSdkSessionSigningSecret,
      getRuntimeSdkBootstrapSigningSecret,
      getRuntimeTenantScopedSdkBootstrapSigningSecret,
    } = await import('../services/identity/sdk-secret-config.js');

    expect(getRuntimeSdkSessionSigningSecret()).toBe('dedicated-session-secret');
    expect(getRuntimeSdkBootstrapSigningSecret()).toBe('dedicated-bootstrap-secret');
    expect(getRuntimeTenantScopedSdkBootstrapSigningSecret('tenant-1')).toBe(
      createHmac('sha256', 'dedicated-bootstrap-secret')
        .update('sdk-bootstrap:tenant-1')
        .digest('base64url'),
    );
    expect(getRuntimeTenantScopedSdkBootstrapSigningSecret('tenant-1')).toBe(
      getRuntimeTenantScopedSdkBootstrapSigningSecret('tenant-1'),
    );
    expect(getRuntimeTenantScopedSdkBootstrapSigningSecret('tenant-1')).not.toBe(
      getRuntimeTenantScopedSdkBootstrapSigningSecret('tenant-2'),
    );
  });

  it('falls back to JWT_SECRET in test env', async () => {
    vi.doMock('../config/index.js', () => ({
      getConfig: () => ({
        env: 'test',
        jwt: { secret: 'jwt-test-secret' },
        auth: { sdk: {} },
      }),
    }));

    const { getRuntimeSdkSessionSigningSecret, getRuntimeSdkBootstrapSigningSecret } =
      await import('../services/identity/sdk-secret-config.js');

    expect(getRuntimeSdkSessionSigningSecret()).toBe('jwt-test-secret');
    expect(getRuntimeSdkBootstrapSigningSecret()).toBe('jwt-test-secret');
  });

  it('throws in production when secrets are missing', async () => {
    vi.doMock('../config/index.js', () => ({
      getConfig: () => ({
        env: 'production',
        jwt: { secret: 'jwt-fallback' },
        auth: { sdk: {} },
      }),
    }));

    const { getRuntimeSdkSessionSigningSecret, getRuntimeSdkBootstrapSigningSecret } =
      await import('../services/identity/sdk-secret-config.js');

    expect(() => getRuntimeSdkSessionSigningSecret()).toThrow(
      /AUTH_SDK_SESSION_SIGNING_SECRET must be configured/,
    );
    expect(() => getRuntimeSdkBootstrapSigningSecret()).toThrow(
      /AUTH_SDK_BOOTSTRAP_SIGNING_SECRET must be configured/,
    );
  });

  it('requires a non-empty tenant id for tenant-scoped bootstrap secrets', async () => {
    vi.doMock('../config/index.js', () => ({
      getConfig: () => ({
        env: 'production',
        jwt: { secret: 'jwt-fallback' },
        auth: {
          sdk: {
            sessionSigningSecret: 'dedicated-session-secret',
            bootstrapSigningSecret: 'dedicated-bootstrap-secret',
          },
        },
      }),
    }));

    const { getRuntimeTenantScopedSdkBootstrapSigningSecret } =
      await import('../services/identity/sdk-secret-config.js');

    expect(() => getRuntimeTenantScopedSdkBootstrapSigningSecret('   ')).toThrow(
      /tenantId is required/,
    );
  });
});
