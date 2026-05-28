import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createConfigLoader } from '../loader.js';
import { BaseAppConfigSchema } from '../schemas/base-app.schema.js';
import type { VaultProvider } from '../vault/index.js';

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

describe('createConfigLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load config from vault provider', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(32),
      PORT: '3001',
    });

    const { loadConfig, getConfig, isConfigLoaded } = createConfigLoader(BaseAppConfigSchema);

    expect(isConfigLoaded()).toBe(false);

    const config = await loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    expect(isConfigLoaded()).toBe(true);
    expect(config.env).toBe('production');
    expect(config.jwt.secret).toBe('a'.repeat(32));
    expect(config.server.port).toBe(3001);

    // getConfig should return same config
    expect(getConfig()).toBe(config);
  });

  it('should throw if getConfig called before loadConfig', () => {
    const { getConfig } = createConfigLoader(BaseAppConfigSchema);
    expect(() => getConfig()).toThrow('Configuration not loaded');
  });

  it('should seal config (prevent mutation)', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(32),
    });

    const { loadConfig } = createConfigLoader(BaseAppConfigSchema);
    const config = await loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    // Config should be frozen (production mode uses deepFreeze)
    expect(() => {
      (config as Record<string, unknown>).env = 'dev';
    }).toThrow();
  });

  it('should seal config with descriptive errors in dev mode', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'development',
      JWT_SECRET: 'a'.repeat(32),
    });

    const { loadConfig } = createConfigLoader(BaseAppConfigSchema);
    const config = await loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    // Dev mode uses Proxy with descriptive errors
    expect(() => {
      (config as Record<string, unknown>).env = 'production';
    }).toThrow(/Cannot modify config property/);
  });

  it('should reload config', async () => {
    const provider1 = createMockProvider({
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(32),
      PORT: '3001',
    });
    const provider2 = createMockProvider({
      NODE_ENV: 'production',
      JWT_SECRET: 'b'.repeat(32),
      PORT: '4000',
    });

    const { loadConfig, reloadConfig, getConfig } = createConfigLoader(BaseAppConfigSchema);

    await loadConfig({ vaultProvider: provider1, logSummary: false });
    expect(getConfig().server.port).toBe(3001);

    await reloadConfig({ vaultProvider: provider2, logSummary: false });
    expect(getConfig().server.port).toBe(4000);
    expect(getConfig().jwt.secret).toBe('b'.repeat(32));
  });

  it('should throw on validation error when throwOnError is true', async () => {
    const provider = createMockProvider({
      JWT_SECRET: 'short', // Too short
    });

    const { loadConfig } = createConfigLoader(BaseAppConfigSchema);

    await expect(loadConfig({ vaultProvider: provider, logSummary: false })).rejects.toThrow(
      'Configuration validation failed',
    );
  });

  it('should provide config metadata', async () => {
    const provider = createMockProvider({
      JWT_SECRET: 'a'.repeat(32),
      NODE_ENV: 'staging',
    });

    const { loadConfig, getConfigMeta } = createConfigLoader(BaseAppConfigSchema);

    await loadConfig({ vaultProvider: provider, logSummary: false });

    const meta = getConfigMeta();
    expect(meta).not.toBeNull();
    expect(meta!.vaultType).toBe('mock');
    expect(meta!.environment).toBe('staging');
    expect(meta!.loadedAt).toBeInstanceOf(Date);
  });
});
