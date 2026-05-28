/**
 * useAnalyticsQuery + useAnalyticsTables hook tests
 *
 * These hooks are the data layer for the Query Explorer tab — no coverage
 * existed before. They use apiFetch (which wraps globalThis.fetch), so
 * all tests intercept fetch via vi.stubGlobal without touching relative
 * imports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useAnalyticsQuery, useAnalyticsTables } from '../../hooks/useAnalyticsQuery';

// ── fetch helpers ─────────────────────────────────────────────────────────

function mockFetchOnce(body: unknown): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

function mockFetchError(message: string): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(message)));
}

// ── useAnalyticsQuery ─────────────────────────────────────────────────────

describe('useAnalyticsQuery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts in idle state', () => {
    mockFetchOnce({});
    const { result } = renderHook(() => useAnalyticsQuery('proj-1'));

    expect(result.current.result).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.executionTimeMs).toBeNull();
  });

  it('POSTs to the runtime analytics proxy with projectId and sql-query endpoint', async () => {
    const mockFetch = mockFetchOnce({
      success: true,
      data: { columns: [], rows: [], rowCount: 0 },
      executionTimeMs: 42,
    });

    const { result } = renderHook(() => useAnalyticsQuery('proj-abc'));

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('projectId=proj-abc');
    expect(url).toContain('endpoint=sql-query');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ sql: 'SELECT 1' });
  });

  it('sets result and executionTimeMs on a successful query', async () => {
    const payload = { columns: ['cnt'], rows: [[99]], rowCount: 1 };
    mockFetchOnce({ success: true, data: payload, executionTimeMs: 77 });

    const { result } = renderHook(() => useAnalyticsQuery('proj-1'));

    await act(async () => {
      await result.current.executeQuery(
        `SELECT count() AS cnt FROM abl_platform.messages
         WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`,
      );
    });

    expect(result.current.result).toEqual(payload);
    expect(result.current.executionTimeMs).toBe(77);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('sets error string when the server returns success:false', async () => {
    mockFetchOnce({ success: false, error: 'Table not in allowlist' });

    const { result } = renderHook(() => useAnalyticsQuery('proj-1'));

    await act(async () => {
      await result.current.executeQuery(
        'SELECT * FROM abl_platform.forbidden WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}',
      );
    });

    expect(result.current.error).toBe('Table not in allowlist');
    expect(result.current.result).toBeNull();
  });

  it('sets error string on a network failure', async () => {
    mockFetchError('Network unavailable');

    const { result } = renderHook(() => useAnalyticsQuery('proj-1'));

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    expect(result.current.error).toBe('Network unavailable');
    expect(result.current.result).toBeNull();
  });

  it('clear() resets result, error, and executionTimeMs to null', async () => {
    mockFetchOnce({
      success: true,
      data: { columns: ['x'], rows: [[1]], rowCount: 1 },
      executionTimeMs: 5,
    });

    const { result } = renderHook(() => useAnalyticsQuery('proj-1'));

    await act(async () => {
      await result.current.executeQuery(
        'SELECT 1 AS x FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}',
      );
    });
    expect(result.current.result).not.toBeNull();

    act(() => result.current.clear());

    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.executionTimeMs).toBeNull();
  });

  it('sets an error without fetching when projectId is null', async () => {
    const mockFetch = mockFetchOnce({});

    const { result } = renderHook(() => useAnalyticsQuery(null));

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.error).toBe('No project selected');
  });
});

// ── useAnalyticsTables ────────────────────────────────────────────────────

describe('useAnalyticsTables', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('starts with empty tables and null maxRows when projectId is null', () => {
    const { result } = renderHook(() => useAnalyticsTables(null));

    expect(result.current.tables).toEqual([]);
    expect(result.current.maxRows).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('GETs the tables endpoint with the correct projectId', async () => {
    const mockFetch = mockFetchOnce({
      success: true,
      data: {
        tables: [{ name: 'abl_platform.platform_events', description: 'All events' }],
        maxRows: 1000,
      },
    });

    const { result } = renderHook(() => useAnalyticsTables('proj-xyz'));

    await act(async () => {
      await Promise.resolve();
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('endpoint=tables');
    expect(url).toContain('projectId=proj-xyz');
    expect(result.current.tables).toHaveLength(1);
    expect(result.current.tables[0]?.name).toBe('abl_platform.platform_events');
    expect(result.current.maxRows).toBe(1000);
    expect(result.current.error).toBeNull();
  });

  it('surfaces messages and custom_pipeline_results when the server returns them', async () => {
    mockFetchOnce({
      success: true,
      data: {
        tables: [
          { name: 'abl_platform.platform_events', description: 'All events' },
          { name: 'abl_platform.messages', description: 'Conversation messages' },
          { name: 'abl_platform.custom_pipeline_results', description: 'Pipeline results' },
        ],
        maxRows: 1000,
      },
    });

    const { result } = renderHook(() => useAnalyticsTables('proj-1'));

    await act(async () => {
      await Promise.resolve();
    });

    const names = result.current.tables.map((t) => t.name);
    expect(names).toContain('abl_platform.messages');
    expect(names).toContain('abl_platform.custom_pipeline_results');
  });

  it('sets error and keeps tables empty when the server returns success:false', async () => {
    mockFetchOnce({ success: false, error: 'Unauthorized' });

    const { result } = renderHook(() => useAnalyticsTables('proj-1'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.tables).toEqual([]);
  });

  it('resets to empty tables when projectId changes to null', async () => {
    mockFetchOnce({
      success: true,
      data: {
        tables: [{ name: 'abl_platform.platform_events', description: '' }],
        maxRows: 500,
      },
    });

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) => useAnalyticsTables(projectId),
      { initialProps: { projectId: 'proj-1' } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.tables).toHaveLength(1);

    rerender({ projectId: null });

    expect(result.current.tables).toEqual([]);
    expect(result.current.maxRows).toBeNull();
  });
});
