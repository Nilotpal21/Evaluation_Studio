/**
 * useAuthProfile hook regression coverage.
 *
 * Background: when an auth profile is deleted while the slideover is still
 * open, SWR kept retrying the failed fetch (`errorRetryCount: 2` from the
 * global config) and revalidating on every tab focus, producing a continuous
 * 404 loop on the dev server.
 *
 * Fix: useAuthProfile passes `shouldRetryOnError` (skip 404),
 * `revalidateOnFocus: false`, and exposes `errorStatus` so the slideover can
 * auto-close on 404.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import { useAuthProfile } from '@/hooks/useAuthProfiles';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

function wrapWithSWR(fetcher: (url: string) => Promise<unknown>) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        errorRetryInterval: 1, // very short retry interval so the test isn't slow
        fetcher,
      }}
    >
      {children}
    </SWRConfig>
  );
}

function notFoundError(): AppError {
  return new AppError('Auth profile not found', {
    ...ErrorCodes.NOT_FOUND,
    statusCode: 404,
  });
}

function serverError(): AppError {
  return new AppError('Server error', {
    ...ErrorCodes.INTERNAL_ERROR,
    statusCode: 500,
  });
}

describe('useAuthProfile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not retry on 404 — the resource is permanently gone', async () => {
    const fetcher = vi.fn(async () => {
      throw notFoundError();
    });

    const { result } = renderHook(() => useAuthProfile('proj-1', 'profile-deleted'), {
      wrapper: wrapWithSWR(fetcher as never),
    });

    await waitFor(() => expect(result.current.errorStatus).toBe(404));

    // Wait long enough for any retries to have fired (errorRetryInterval=1ms,
    // global errorRetryCount=2 → all retries would complete in ~tens of ms).
    await new Promise((r) => setTimeout(r, 100));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.profile).toBeNull();
  });

  it('still retries non-404 errors (e.g. 500) up to the configured count', async () => {
    const fetcher = vi.fn(async () => {
      throw serverError();
    });

    renderHook(() => useAuthProfile('proj-1', 'profile-err'), {
      wrapper: wrapWithSWR(fetcher as never),
    });

    // Allow the global errorRetryCount: 2 to play out with errorRetryInterval=1.
    await new Promise((r) => setTimeout(r, 200));

    // Should have attempted at least twice (initial + at least 1 retry).
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns errorStatus=null on success', async () => {
    const fetcher = vi.fn(async () => ({
      success: true,
      data: { id: 'profile-ok', name: 'Profile' },
    }));

    const { result } = renderHook(() => useAuthProfile('proj-1', 'profile-ok'), {
      wrapper: wrapWithSWR(fetcher as never),
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.errorStatus).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does not fetch when projectId or profileId is null', async () => {
    const fetcher = vi.fn(async () => ({ success: true, data: {} }));

    renderHook(() => useAuthProfile(null, 'profile-1'), {
      wrapper: wrapWithSWR(fetcher as never),
    });
    renderHook(() => useAuthProfile('proj-1', null), {
      wrapper: wrapWithSWR(fetcher as never),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
