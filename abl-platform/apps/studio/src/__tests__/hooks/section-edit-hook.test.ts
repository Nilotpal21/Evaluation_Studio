import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock api-client
// ---------------------------------------------------------------------------

const mockApiFetch = vi.fn();
vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  handleResponse: (r: any) => r.json(),
}));

// ---------------------------------------------------------------------------
// Mock agent-detail-store
// ---------------------------------------------------------------------------

const mockSetSaveStatus = vi.fn();

vi.mock('../../store/agent-detail-store', () => ({
  useAgentDetailStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setSaveStatus: mockSetSaveStatus };
    return selector ? selector(state) : state;
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { useSectionEdit } from '../../hooks/useSectionEdit';

// ===========================================================================
// Tests
// ===========================================================================

describe('useSectionEdit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockApiFetch.mockReset();
    mockSetSaveStatus.mockReset();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ dslContent: 'updated', diff: {} }),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('debounces edits and calls surgical edit API after 500ms', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'TOOLS:\n  search:\n    ...');
    });

    // Should not have called API yet
    expect(mockApiFetch).not.toHaveBeenCalled();

    // Advance timer past debounce
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/agents/booking/edit',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('TOOLS'),
      }),
    );
  });

  it('coalesces multiple rapid edits into one API call', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'version 1');
      result.current.editSection('TOOLS', 'version 2');
      result.current.editSection('TOOLS', 'version 3');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // Only called once with the last version
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.stringContaining('version 3'),
      }),
    );
  });

  it('sets save status to saving then saved on success', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'new content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockSetSaveStatus).toHaveBeenCalledWith('saving');
    expect(mockSetSaveStatus).toHaveBeenCalledWith('saved');
  });

  it('sets save status to error on API failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'bad content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockSetSaveStatus).toHaveBeenCalledWith('saving');
    expect(mockSetSaveStatus).toHaveBeenCalledWith('error', 'Network error');
  });

  it('does not call API when projectId is null', async () => {
    const { result } = renderHook(() => useSectionEdit(null, 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('does not call API when agentName is null', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', null));

    act(() => {
      result.current.editSection('TOOLS', 'content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('passes through safe string errors', async () => {
    mockApiFetch.mockRejectedValueOnce('string error');

    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockSetSaveStatus).toHaveBeenCalledWith('error', 'string error');
  });

  it('sends correct JSON body structure', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('GATHER', 'GATHER:\n  name:\n    prompt: ...');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const callArgs = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body).toEqual({
      edits: [{ section: 'GATHER', content: 'GATHER:\n  name:\n    prompt: ...' }],
    });
  });

  it('uses custom statusCallback when provided', async () => {
    const customCallback = vi.fn();
    const { result } = renderHook(() =>
      useSectionEdit('proj-1', 'booking', undefined, customCallback),
    );

    act(() => {
      result.current.editSection('TOOLS', 'new content');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // Custom callback should be called, not the detail store's
    expect(customCallback).toHaveBeenCalledWith('saving');
    expect(customCallback).toHaveBeenCalledWith('saved');
    expect(mockSetSaveStatus).not.toHaveBeenCalled();
  });

  it('saveEditsNow flushes immediately without debounce', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    let ok = false;
    await act(async () => {
      ok = await result.current.saveEditsNow([{ section: 'TOOLS', content: 'immediate' }]);
    });

    expect(ok).toBe(true);
    // API called without waiting for debounce
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/agents/booking/edit',
      expect.objectContaining({
        body: expect.stringContaining('immediate'),
      }),
    );
  });

  it('saveEditsNow cancels pending debounce and includes its edits', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    // Queue a debounced edit
    act(() => {
      result.current.editSection('GATHER', 'debounced content');
    });

    // Now flush immediately with additional edits
    await act(async () => {
      await result.current.saveEditsNow([{ section: 'TOOLS', content: 'immediate' }]);
    });

    // Should have been called once with both edits
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockApiFetch.mock.calls[0][1].body);
    expect(body.edits).toHaveLength(2);
    expect(body.edits).toEqual(
      expect.arrayContaining([
        { section: 'GATHER', content: 'debounced content' },
        { section: 'TOOLS', content: 'immediate' },
      ]),
    );

    // Advancing timers should not trigger another call
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('saveEditsNow with no edits does not call API', async () => {
    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    await act(async () => {
      await result.current.saveEditsNow();
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(mockSetSaveStatus).not.toHaveBeenCalled();
  });

  it('saveEditsNow reports error via custom statusCallback on API failure', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Server unavailable'));
    const customCallback = vi.fn();
    const { result } = renderHook(() =>
      useSectionEdit('proj-1', 'booking', undefined, customCallback),
    );

    let ok = true;
    await act(async () => {
      ok = await result.current.saveEditsNow([{ section: 'TOOLS', content: 'content' }]);
    });

    expect(ok).toBe(false);
    expect(customCallback).toHaveBeenCalledWith('saving');
    expect(customCallback).toHaveBeenCalledWith('error', 'Server unavailable');
  });

  it('requeues failed debounced edits so a retry can resend the same batch', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ dslContent: 'updated', diff: {} }),
    });

    const { result } = renderHook(() => useSectionEdit('proj-1', 'booking'));

    act(() => {
      result.current.editSection('TOOLS', 'retry me');
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    let ok = false;
    await act(async () => {
      ok = await result.current.saveEditsNow();
    });

    expect(ok).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenLastCalledWith(
      '/api/projects/proj-1/agents/booking/edit',
      expect.objectContaining({
        body: expect.stringContaining('retry me'),
      }),
    );
  });
});
