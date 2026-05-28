import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAllowedCallbackUrl,
  CallbackUrlError,
} from '../channels/security/callback-url-policy.js';

// Mock dns/promises to control DNS resolution in tests.
// lookup({ all: true }) returns LookupAddress[], so the default mock returns an array.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW_LOCAL = process.env.ALLOW_LOCAL_CALLBACKS;

function restoreEnv() {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ALLOW_LOCAL === undefined) {
    delete process.env.ALLOW_LOCAL_CALLBACKS;
  } else {
    process.env.ALLOW_LOCAL_CALLBACKS = ORIGINAL_ALLOW_LOCAL;
  }
}

describe('callback-url-policy', () => {
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('allows localhost in development when not production', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_LOCAL_CALLBACKS;

    await expect(
      assertAllowedCallbackUrl('http://localhost:4567/webhook', false),
    ).resolves.toBeUndefined();
  });

  it('blocks localhost when production flag is enabled', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_LOCAL_CALLBACKS;

    await expect(assertAllowedCallbackUrl('http://localhost:4567/webhook', true)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  it('blocks private IP when local callbacks are not enabled', async () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.ALLOW_LOCAL_CALLBACKS;

    await expect(assertAllowedCallbackUrl('http://127.0.0.1:3000/hook', false)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  it('allows private IP when ALLOW_LOCAL_CALLBACKS is true', async () => {
    process.env.NODE_ENV = 'staging';
    process.env.ALLOW_LOCAL_CALLBACKS = 'true';

    await expect(
      assertAllowedCallbackUrl('http://127.0.0.1:3000/hook', false),
    ).resolves.toBeUndefined();
  });

  it('still blocks unsupported protocols even with local callbacks enabled', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_LOCAL_CALLBACKS = 'true';

    await expect(assertAllowedCallbackUrl('ftp://localhost:4567/webhook', false)).rejects.toThrow(
      CallbackUrlError,
    );
  });

  describe('DNS resolution safety', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'staging';
      delete process.env.ALLOW_LOCAL_CALLBACKS;
    });

    it('blocks hostname resolving to private IP', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);

      await expect(
        assertAllowedCallbackUrl('https://evil.example.com/hook', false),
      ).rejects.toThrow('resolves to a private/reserved IP range');
    });

    it('blocks hostname resolving to loopback', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      await expect(
        assertAllowedCallbackUrl('https://sneaky.example.com/hook', false),
      ).rejects.toThrow('resolves to a private/reserved IP range');
    });

    it('blocks hostname resolving to link-local', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      await expect(
        assertAllowedCallbackUrl('https://metadata.example.com/hook', false),
      ).rejects.toThrow('resolves to a private/reserved IP range');
    });

    it('allows hostname resolving to public IP', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

      await expect(
        assertAllowedCallbackUrl('https://example.com/hook', false),
      ).resolves.toBeUndefined();
    });

    it('blocks on DNS resolution failure', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'));

      await expect(
        assertAllowedCallbackUrl('https://nonexistent.invalid/hook', false),
      ).rejects.toThrow('DNS resolution failed');
    });

    it('blocks when any DNS answer is private (multi-record response)', async () => {
      const { lookup } = await import('node:dns/promises');
      // Public answer first, private answer second — still must be blocked
      vi.mocked(lookup).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);

      await expect(
        assertAllowedCallbackUrl('https://split-horizon.example.com/hook', false),
      ).rejects.toThrow('resolves to a private/reserved IP range');
    });

    it('blocks hostname resolving to IPv6 ULA address (fc00::/7)', async () => {
      const { lookup } = await import('node:dns/promises');
      vi.mocked(lookup).mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);

      await expect(assertAllowedCallbackUrl('https://ula.example.com/hook', false)).rejects.toThrow(
        'resolves to a private/reserved IP range',
      );
    });
  });
});
