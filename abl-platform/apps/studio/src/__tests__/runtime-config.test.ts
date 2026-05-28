// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_RUNTIME_URL = process.env.RUNTIME_URL;
const ORIGINAL_RUNTIME_PUBLIC_BASE_URL = process.env.RUNTIME_PUBLIC_BASE_URL;
const ORIGINAL_PUBLIC_RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL;

function restoreRuntimeEnv(): void {
  if (ORIGINAL_RUNTIME_URL === undefined) {
    delete process.env.RUNTIME_URL;
  } else {
    process.env.RUNTIME_URL = ORIGINAL_RUNTIME_URL;
  }

  if (ORIGINAL_RUNTIME_PUBLIC_BASE_URL === undefined) {
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
  } else {
    process.env.RUNTIME_PUBLIC_BASE_URL = ORIGINAL_RUNTIME_PUBLIC_BASE_URL;
  }

  if (ORIGINAL_PUBLIC_RUNTIME_URL === undefined) {
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;
  } else {
    process.env.NEXT_PUBLIC_RUNTIME_URL = ORIGINAL_PUBLIC_RUNTIME_URL;
  }
}

afterEach(() => {
  restoreRuntimeEnv();
  vi.resetModules();
});

describe('runtime config', () => {
  test('returns empty public runtime URLs when browser runtime config is not explicitly set', async () => {
    const { createPublicRuntimeConfig } = await import('../config/runtime.public');

    expect(createPublicRuntimeConfig(undefined, false)).toMatchObject({
      apiUrl: '',
      wsUrl: '',
      sdkWsUrl: '',
    });
  });

  test('uses the server-side local fallback when runtime config is unset', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;

    const { getRuntimeUrl } = await import('../config/runtime.server');

    expect(getRuntimeUrl()).toBe('http://localhost:3112');
  });

  test('server resolves public runtime config from RUNTIME_PUBLIC_BASE_URL', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://studio-runtime.example.test/';

    const { getPublicRuntimeConfig } = await import('../config/runtime.server');

    expect(getPublicRuntimeConfig()).toMatchObject({
      apiUrl: 'https://studio-runtime.example.test',
      wsUrl: 'wss://studio-runtime.example.test/ws',
      sdkWsUrl: 'wss://studio-runtime.example.test/ws/sdk',
    });
  });

  test('server falls back to legacy NEXT_PUBLIC_RUNTIME_URL for public runtime config', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    process.env.NEXT_PUBLIC_RUNTIME_URL = 'https://legacy-runtime.example.test/';

    const { getPublicRuntimeConfig } = await import('../config/runtime.server');

    expect(getPublicRuntimeConfig()).toMatchObject({
      apiUrl: 'https://legacy-runtime.example.test',
      wsUrl: 'wss://legacy-runtime.example.test/ws',
      sdkWsUrl: 'wss://legacy-runtime.example.test/ws/sdk',
    });
  });

  test('normalizes explicit public runtime URLs for browser injection', async () => {
    const { createPublicRuntimeConfig } = await import('../config/runtime.public');

    expect(createPublicRuntimeConfig('https://studio-runtime.example.test/', false)).toMatchObject({
      apiUrl: 'https://studio-runtime.example.test',
      wsUrl: 'wss://studio-runtime.example.test/ws',
      sdkWsUrl: 'wss://studio-runtime.example.test/ws/sdk',
    });
  });

  test('requires an explicit runtime URL for server-side SDK bootstrap exchange', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;

    const { getRequiredRuntimeUrl } = await import('../config/runtime.server');

    expect(() => getRequiredRuntimeUrl()).toThrow(
      'RUNTIME_URL must be configured for Studio Runtime exchanges.',
    );
  });

  test('normalizes a configured server-side runtime URL', async () => {
    process.env.RUNTIME_URL = 'https://runtime.example.test/';
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;

    const { getRequiredRuntimeUrl } = await import('../config/runtime.server');

    expect(getRequiredRuntimeUrl()).toBe('https://runtime.example.test');
  });

  test('rejects non-http runtime URLs for server-side SDK bootstrap exchange', async () => {
    process.env.RUNTIME_URL = 'ws://runtime.example.test';
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;

    const { getRequiredRuntimeUrl } = await import('../config/runtime.server');

    expect(() => getRequiredRuntimeUrl()).toThrow(
      'Runtime URL must be an absolute http:// or https:// URL without a trailing slash.',
    );
  });

  test('resolves explicit runtime config for SDK embed snippets', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.example.test/';

    const { resolveSdkEmbedRuntimeUrl } = await import('../config/runtime.server');

    expect(resolveSdkEmbedRuntimeUrl('https://studio.example.test')).toBe(
      'https://runtime.example.test',
    );
  });

  test('falls back to the request origin for SDK embed snippets when public runtime config is unset', async () => {
    delete process.env.RUNTIME_URL;
    delete process.env.RUNTIME_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_RUNTIME_URL;

    const { resolveSdkEmbedRuntimeUrl } = await import('../config/runtime.server');

    expect(resolveSdkEmbedRuntimeUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(resolveSdkEmbedRuntimeUrl('https://studio.example.test')).toBe(
      'https://studio.example.test',
    );
  });
});
