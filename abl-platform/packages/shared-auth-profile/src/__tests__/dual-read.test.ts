import { describe, expect, it, vi } from 'vitest';

import { dualReadCredentials } from '../dual-read.js';

describe('dualReadCredentials', () => {
  const baseOpts = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    consumer: 'TestConsumer',
  };

  it('authProfileId present — resolves via auth profile', async () => {
    const resolve = vi.fn().mockResolvedValue({ apiKey: 'from-profile' });
    const legacyFallback = vi.fn().mockResolvedValue({ apiKey: 'from-legacy' });

    const result = await dualReadCredentials({
      ...baseOpts,
      authProfileId: 'ap-123',
      resolve,
      legacyFallback,
    });

    expect(result.source).toBe('auth-profile');
    expect(result.credentials).toEqual({ apiKey: 'from-profile' });
    expect(resolve).toHaveBeenCalledOnce();
    expect(legacyFallback).not.toHaveBeenCalled();
  });

  it('authProfileId null — falls back to legacy', async () => {
    const resolve = vi.fn();
    const legacyFallback = vi.fn().mockResolvedValue({ apiKey: 'legacy' });

    const result = await dualReadCredentials({
      ...baseOpts,
      authProfileId: null,
      resolve,
      legacyFallback,
    });

    expect(result.source).toBe('legacy');
    expect(result.credentials).toEqual({ apiKey: 'legacy' });
    expect(resolve).not.toHaveBeenCalled();
    expect(legacyFallback).toHaveBeenCalledOnce();
  });

  it('authProfileId undefined — falls back to legacy', async () => {
    const resolve = vi.fn();
    const legacyFallback = vi.fn().mockResolvedValue({ apiKey: 'legacy' });

    const result = await dualReadCredentials({
      ...baseOpts,
      authProfileId: undefined,
      resolve,
      legacyFallback,
    });

    expect(result.source).toBe('legacy');
    expect(resolve).not.toHaveBeenCalled();
    expect(legacyFallback).toHaveBeenCalledOnce();
  });

  it('resolve() throws — error propagates, no silent fallback to legacy', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('decryption failed'));
    const legacyFallback = vi.fn();

    await expect(
      dualReadCredentials({
        ...baseOpts,
        authProfileId: 'ap-123',
        resolve,
        legacyFallback,
      }),
    ).rejects.toThrow('decryption failed');
    expect(legacyFallback).not.toHaveBeenCalled();
  });

  it('legacyFallback() throws — error propagates', async () => {
    const resolve = vi.fn();
    const legacyFallback = vi.fn().mockRejectedValue(new Error('legacy DB down'));

    await expect(
      dualReadCredentials({
        ...baseOpts,
        authProfileId: null,
        resolve,
        legacyFallback,
      }),
    ).rejects.toThrow('legacy DB down');
  });
});
