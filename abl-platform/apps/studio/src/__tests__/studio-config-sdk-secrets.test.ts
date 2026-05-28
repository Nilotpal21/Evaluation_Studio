import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigLoader, type VaultProvider } from '@agent-platform/config';
import { StudioConfigSchema } from '../config';

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

describe('Studio config SDK secret schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads config when AUTH_SDK_BOOTSTRAP_SIGNING_SECRET is configured', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'development',
      JWT_SECRET: 'j'.repeat(64),
      AUTH_SDK_BOOTSTRAP_SIGNING_SECRET: 'b'.repeat(64),
    });

    const loader = createConfigLoader(StudioConfigSchema);
    const config = await loader.loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    expect(config.auth.sdk.bootstrapSigningSecret).toBe('b'.repeat(64));
  });

  it('loads config without SDK secrets (shape-only validation)', async () => {
    const provider = createMockProvider({
      NODE_ENV: 'test',
      JWT_SECRET: 'j'.repeat(64),
    });

    const loader = createConfigLoader(StudioConfigSchema);
    const config = await loader.loadConfig({
      vaultProvider: provider,
      logSummary: false,
    });

    // Schema accepts missing secrets — operational enforcement is in studio-sdk-session.ts
    expect(config.auth.sdk.bootstrapSigningSecret).toBeUndefined();
  });
});
