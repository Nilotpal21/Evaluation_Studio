/**
 * Tests for agent-related hooks:
 * - useAgents
 * - useAgentVersions
 * - useABLParsing
 * - useLLMCalls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockGlobalMutate = vi.fn();
const mockSwrReturn = {
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
  mutate: (...args: unknown[]) => mockGlobalMutate(...args),
}));

// ---------------------------------------------------------------------------
// Mock API modules
// ---------------------------------------------------------------------------

const mockFetchVersions = vi.fn();
const mockCreateVersion = vi.fn();
const mockPromoteVersion = vi.fn();

vi.mock('../../api/versions', () => ({
  fetchVersions: (...args: unknown[]) => mockFetchVersions(...args),
  createVersion: (...args: unknown[]) => mockCreateVersion(...args),
  promoteVersion: (...args: unknown[]) => mockPromoteVersion(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// ---------------------------------------------------------------------------
// Mock api-client — delegate apiFetch to mockFetch to avoid auth store hang
// ---------------------------------------------------------------------------

const { mockFetch } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return { mockFetch };
});

vi.mock('../../lib/api-client', () => ({
  apiFetch: (path: string, init?: RequestInit) =>
    mockFetch(path, {
      ...init,
      credentials: 'same-origin',
    }),
}));

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const mockVersionStore: Record<string, unknown> = {
  diffVersionA: null,
  diffVersionB: null,
  showDiff: false,
  setDiffVersions: vi.fn(),
  setShowDiff: vi.fn(),
};

vi.mock('../../store/version-store', () => ({
  useVersionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(mockVersionStore) : mockVersionStore,
}));

const mockEditorStore: Record<string, unknown> = {
  dslContent: '',
  currentFilePath: null,
  setParseErrors: vi.fn(),
  setParseWarnings: vi.fn(),
  setIsParsingLive: vi.fn(),
  setDiagnostics: vi.fn(),
  setCompiledIR: vi.fn(),
  setCompileErrors: vi.fn(),
  setIsCompiling: vi.fn(),
  setIsSaving: vi.fn(),
  setSaveError: vi.fn(),
  markSaved: vi.fn(),
};

vi.mock('../../store/editor-store', () => ({
  useEditorStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(mockEditorStore) : mockEditorStore,
}));

const mockObservatoryEvents: Array<Record<string, unknown>> = [];

vi.mock('../../store/observatory-store', () => ({
  useObservatoryStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { events: mockObservatoryEvents };
    return selector ? selector(state) : state;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useAgents } from '../../hooks/useAgents';
import { useAgentVersions } from '../../hooks/useAgentVersions';
import { useABLParsing } from '../../hooks/useABLParsing';
import { useLLMCalls } from '../../hooks/useLLMCalls';
import useSWR from 'swr';
import { toast } from 'sonner';

// ===========================================================================
// useAgents
// ===========================================================================

describe('useAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('should use /api/agents as the SWR key', () => {
    renderHook(() => useAgents());

    expect(useSWR).toHaveBeenCalledWith('/api/agents');
  });

  it('should return empty agents and domains when no data', () => {
    const { result } = renderHook(() => useAgents());

    expect(result.current.agents).toEqual({});
    expect(result.current.domains).toEqual([]);
  });

  it('should return agents grouped by domain', () => {
    Object.assign(mockSwrReturn, {
      data: {
        success: true,
        agents: {
          'hotel-booking': [
            {
              id: 'a1',
              name: 'BookingAgent',
              domain: 'hotel-booking',
              type: 'agent',
              mode: 'reasoning',
              toolCount: 3,
              gatherFieldCount: 5,
              isSupervisor: false,
            },
          ],
          support: [
            {
              id: 'a2',
              name: 'SupportAgent',
              domain: 'support',
              type: 'agent',
              mode: 'scripted',
              toolCount: 1,
              gatherFieldCount: 2,
              isSupervisor: false,
            },
          ],
        },
        domains: ['hotel-booking', 'support'],
      },
    });

    const { result } = renderHook(() => useAgents());

    expect(result.current.domains).toEqual(['hotel-booking', 'support']);
    expect(result.current.agents['hotel-booking']).toHaveLength(1);
    expect(result.current.agents['support']).toHaveLength(1);
  });

  it('should return isLoading true during fetch', () => {
    Object.assign(mockSwrReturn, { isLoading: true });

    const { result } = renderHook(() => useAgents());

    expect(result.current.isLoading).toBe(true);
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: new Error('Failed') });

    const { result } = renderHook(() => useAgents());

    expect(result.current.error).toBe('Error: Failed');
  });

  it('should return null error on success', () => {
    Object.assign(mockSwrReturn, { error: undefined });

    const { result } = renderHook(() => useAgents());

    expect(result.current.error).toBeNull();
  });

  it('should expose refresh function that calls mutate', () => {
    const { result } = renderHook(() => useAgents());

    result.current.refresh();
    expect(mockMutate).toHaveBeenCalled();
  });
});

// ===========================================================================
// useAgentVersions
// ===========================================================================

describe('useAgentVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalMutate.mockResolvedValue(undefined);
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
    Object.assign(mockVersionStore, {
      diffVersionA: null,
      diffVersionB: null,
      showDiff: false,
      setDiffVersions: vi.fn(),
      setShowDiff: vi.fn(),
    });
  });

  it('should pass null key when projectId is null', () => {
    renderHook(() => useAgentVersions(null, 'TestAgent'));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.any(Object));
  });

  it('should pass null key when agentName is null', () => {
    renderHook(() => useAgentVersions('proj-1', null));

    expect(useSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.any(Object));
  });

  it('should construct array SWR key from projectId and agentName', () => {
    renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    expect(useSWR).toHaveBeenCalledWith(
      ['versions', 'proj-1', 'TestAgent'],
      expect.any(Function),
      expect.objectContaining({ revalidateOnFocus: false }),
    );
  });

  it('should return empty versions when no data', () => {
    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    expect(result.current.versions).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('should return versions from SWR data', () => {
    Object.assign(mockSwrReturn, {
      data: {
        success: true,
        versions: [
          {
            id: 'v1',
            projectId: 'proj-1',
            agentName: 'TestAgent',
            version: '1.0.0',
            status: 'active',
            dslContent: 'agent TestAgent {}',
            sourceHash: 'abc123',
            ir: null,
            compileErrors: null,
            createdAt: '2025-01-01T00:00:00Z',
            createdBy: 'user-1',
            changelog: 'Initial version',
          },
        ],
        total: 1,
      },
    });

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    expect(result.current.versions).toHaveLength(1);
    expect(result.current.total).toBe(1);
    expect(result.current.versions[0].version).toBe('1.0.0');
  });

  it('should call createVersion and toast.success on create', async () => {
    mockCreateVersion.mockResolvedValueOnce({
      success: true,
      versionId: 'v2',
      version: '1.1.0',
      sourceHash: 'def456',
    });
    mockMutate.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    await act(async () => {
      await result.current.create('New feature');
    });

    expect(mockCreateVersion).toHaveBeenCalledWith('proj-1', 'TestAgent', 'New feature');
    expect(toast.success).toHaveBeenCalledWith('Version 1.1.0 created');
    expect(mockGlobalMutate).toHaveBeenCalledWith(['stale-tool-check', 'proj-1', 'TestAgent']);
  });

  it('should toast.info when version is deduplicated', async () => {
    mockCreateVersion.mockResolvedValueOnce({
      success: true,
      versionId: 'v1',
      version: '1.0.0',
      sourceHash: 'abc123',
      deduplicated: true,
    });

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    await act(async () => {
      await result.current.create();
    });

    expect(toast.info).toHaveBeenCalledWith(
      'No changes to version — source is identical to latest',
    );
    expect(mockMutate).toHaveBeenCalled();
    expect(mockGlobalMutate).toHaveBeenCalledWith(['stale-tool-check', 'proj-1', 'TestAgent']);
  });

  it('should toast.error on create failure', async () => {
    mockCreateVersion.mockRejectedValueOnce(new Error('Create failed'));

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    await act(async () => {
      await result.current
        .create()
        .then(() => {
          throw new Error('Expected create to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain('Create failed');
        });
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to create version');
  });

  it('should not create when projectId is null', async () => {
    const { result } = renderHook(() => useAgentVersions(null, 'TestAgent'));

    await act(async () => {
      await result.current.create();
    });

    expect(mockCreateVersion).not.toHaveBeenCalled();
  });

  it('should call promoteVersion and toast.success on promote', async () => {
    mockPromoteVersion.mockResolvedValueOnce({
      success: true,
      version: { status: 'staged' },
    });
    mockMutate.mockImplementationOnce(async (updater: unknown) => {
      // Simulate optimistic update
      if (typeof updater === 'function') {
        (updater as Function)(null);
      }
      return undefined;
    });

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    await act(async () => {
      await result.current.promote('1.0.0', 'staged');
    });

    expect(mockPromoteVersion).toHaveBeenCalledWith('proj-1', 'TestAgent', '1.0.0', 'staged');
    expect(toast.success).toHaveBeenCalledWith('Version 1.0.0 promoted to staged');
  });

  it('should toast.error on promote failure', async () => {
    mockPromoteVersion.mockRejectedValueOnce(new Error('Promote failed'));

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    await act(async () => {
      await result.current
        .promote('1.0.0', 'staged')
        .then(() => {
          throw new Error('Expected promote to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'Promote failed',
          );
        });
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to promote version');
  });

  it('should not promote when projectId is null', async () => {
    const { result } = renderHook(() => useAgentVersions(null, 'TestAgent'));

    await act(async () => {
      await result.current.promote('1.0.0', 'staged');
    });

    expect(mockPromoteVersion).not.toHaveBeenCalled();
  });

  it('should expose diff UI state from version store', () => {
    Object.assign(mockVersionStore, {
      diffVersionA: '1.0.0',
      diffVersionB: '1.1.0',
      showDiff: true,
    });

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    expect(result.current.diffVersionA).toBe('1.0.0');
    expect(result.current.diffVersionB).toBe('1.1.0');
    expect(result.current.showDiff).toBe(true);
  });

  it('should expose reload function', () => {
    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    result.current.reload();
    expect(mockMutate).toHaveBeenCalled();
  });

  it('should return error string when SWR errors', () => {
    Object.assign(mockSwrReturn, { error: new Error('Network error') });

    const { result } = renderHook(() => useAgentVersions('proj-1', 'TestAgent'));

    expect(result.current.error).toBe('Error: Network error');
  });
});

// ===========================================================================
// useABLParsing
// ===========================================================================

describe('useABLParsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.assign(mockEditorStore, {
      dslContent: '',
      currentFilePath: null,
      setParseErrors: vi.fn(),
      setParseWarnings: vi.fn(),
      setIsParsingLive: vi.fn(),
      setDiagnostics: vi.fn(),
      setCompiledIR: vi.fn(),
      setCompileErrors: vi.fn(),
      setIsCompiling: vi.fn(),
      setIsSaving: vi.fn(),
      setSaveError: vi.fn(),
      markSaved: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseABL', () => {
    it('should clear errors and warnings for empty content', async () => {
      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('');
      });

      expect(mockEditorStore.setParseErrors).toHaveBeenCalledWith([]);
      expect(mockEditorStore.setParseWarnings).toHaveBeenCalledWith([]);
      expect(mockEditorStore.setIsParsingLive).not.toHaveBeenCalled();
    });

    it('should clear errors and warnings for whitespace-only content', async () => {
      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('   \n\t  ');
      });

      expect(mockEditorStore.setParseErrors).toHaveBeenCalledWith([]);
      expect(mockEditorStore.setParseWarnings).toHaveBeenCalledWith([]);
    });

    it('should set parsing flag and call API', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            success: true,
            diagnostics: [],
          }),
      });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('agent TestAgent { }');
      });

      expect(mockEditorStore.setIsParsingLive).toHaveBeenCalledWith(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/abl/diagnostics', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsl: 'agent TestAgent { }', tier: 2 }),
      });
      // Should reset parsing flag in finally
      expect(mockEditorStore.setIsParsingLive).toHaveBeenCalledWith(false);
    });

    it('should set parse errors from response', async () => {
      const errors = [{ line: 5, column: 10, message: 'Unexpected token' }];
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            success: false,
            diagnostics: [{ severity: 'error', line: 5, column: 10, message: 'Unexpected token' }],
          }),
      });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('agent Bad {');
      });

      expect(mockEditorStore.setParseErrors).toHaveBeenCalledWith(errors);
    });

    it('should transform warnings to include column 0', async () => {
      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            success: true,
            diagnostics: [{ severity: 'warning', line: 3, column: 0, message: 'Unused field' }],
          }),
      });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('agent TestAgent { }');
      });

      expect(mockEditorStore.setParseWarnings).toHaveBeenCalledWith([
        { line: 3, column: 0, message: 'Unused field' },
      ]);
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.parseABL('agent TestAgent { }');
      });

      expect(mockEditorStore.setParseErrors).toHaveBeenCalledWith([
        { line: 1, column: 1, message: 'Failed to parse ABL' },
      ]);
      expect(mockEditorStore.setIsParsingLive).toHaveBeenCalledWith(false);
    });
  });

  describe('parseLive', () => {
    it('should debounce calls by 500ms', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ success: true, errors: [], warnings: [] }),
      });

      const { result } = renderHook(() => useABLParsing());

      act(() => {
        result.current.parseLive('agent A {}');
      });

      // Should not have called fetch yet
      expect(mockFetch).not.toHaveBeenCalled();

      // Advance time past debounce
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should cancel previous debounced call', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ success: true, errors: [], warnings: [] }),
      });

      const { result } = renderHook(() => useABLParsing());

      act(() => {
        result.current.parseLive('agent A {}');
      });

      // Call again before debounce expires
      act(() => {
        vi.advanceTimersByTime(300);
        result.current.parseLive('agent B {}');
      });

      // Advance past new debounce
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      // Should have only called once with the latest content
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.dsl).toBe('agent B {}');
    });
  });

  describe('compileABL', () => {
    it('should set compile error for empty content', async () => {
      Object.assign(mockEditorStore, { dslContent: '' });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith(['No ABL content to compile']);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should call compile API with dslContent', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              success: true,
              ir: { name: 'TestAgent', type: 'agent' },
            }),
        });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setIsCompiling).toHaveBeenCalledWith(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/abl/compile', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dsl: 'agent TestAgent { }' }),
      });
    });

    it('should use the project-aware compile path when project and agent are provided', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              success: true,
              ir: { name: 'TestAgent', type: 'agent' },
            }),
        });

      const { result } = renderHook(() => useABLParsing('proj-1', 'Test Agent'));

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockFetch).toHaveBeenNthCalledWith(1, '/api/abl/diagnostics', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dsl: 'agent TestAgent { }',
          tier: 3,
          projectId: 'proj-1',
          agentName: 'Test Agent',
        }),
      });
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        '/api/projects/proj-1/agents/Test%20Agent/compile',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dsl: 'agent TestAgent { }' }),
        },
      );
    });

    it('should set compiled IR on success', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      const ir = { name: 'TestAgent', type: 'agent', steps: [] };
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, ir }),
        });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setCompiledIR).toHaveBeenCalledWith(ir);
      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith([]);
      expect(mockEditorStore.setIsCompiling).toHaveBeenCalledWith(false);
    });

    it('should set compile errors on failure', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent Bad {' });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: false, errors: ['Missing closing brace'] }),
        });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith(['Missing closing brace']);
      expect(mockEditorStore.setCompiledIR).toHaveBeenCalledWith(null);
    });

    it('should handle compile API failure', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      mockFetch.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith(['Failed to compile ABL']);
      expect(mockEditorStore.setIsCompiling).toHaveBeenCalledWith(false);
    });

    it('should use error string when errors array is undefined', async () => {
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              success: false,
              // errors is undefined — falls back to [result.error]
              error: 'Unknown compilation failure',
            }),
        });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith([
        'Unknown compilation failure',
      ]);
    });

    it('should pass through empty errors array as-is', async () => {
      // When result.errors is [] (truthy), the hook uses it directly
      Object.assign(mockEditorStore, { dslContent: 'agent TestAgent { }' });
      mockFetch
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ success: true, diagnostics: [] }),
        })
        .mockResolvedValueOnce({
          json: () =>
            Promise.resolve({
              success: false,
              errors: [],
              error: 'Fallback error',
            }),
        });

      const { result } = renderHook(() => useABLParsing());

      await act(async () => {
        await result.current.compileABL();
      });

      // Empty array is truthy, so errors = [] is used as-is
      expect(mockEditorStore.setCompileErrors).toHaveBeenCalledWith([]);
    });
  });

  describe('saveABL', () => {
    it('should return false and set error when no file path', async () => {
      Object.assign(mockEditorStore, { currentFilePath: null });

      const { result } = renderHook(() => useABLParsing());

      let success: boolean | undefined;
      await act(async () => {
        success = await result.current.saveABL();
      });

      expect(success).toBe(false);
      expect(mockEditorStore.setSaveError).toHaveBeenCalledWith('No file path specified');
    });

    it('should return false and set error for empty content', async () => {
      Object.assign(mockEditorStore, {
        currentFilePath: '/path/to/file.abl',
        dslContent: '',
      });

      const { result } = renderHook(() => useABLParsing());

      let success: boolean | undefined;
      await act(async () => {
        success = await result.current.saveABL();
      });

      expect(success).toBe(false);
      expect(mockEditorStore.setSaveError).toHaveBeenCalledWith('No ABL content to save');
    });

    it('should call save API and return true on success', async () => {
      Object.assign(mockEditorStore, {
        currentFilePath: '/path/to/file.abl',
        dslContent: 'agent TestAgent { }',
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            success: true,
            savedPath: '/path/to/file.abl',
          }),
      });

      const { result } = renderHook(() => useABLParsing());

      let success: boolean | undefined;
      await act(async () => {
        success = await result.current.saveABL();
      });

      expect(success).toBe(true);
      expect(mockEditorStore.markSaved).toHaveBeenCalled();
      expect(mockEditorStore.setIsSaving).toHaveBeenCalledWith(false);
    });

    it('should return false and set error on save failure', async () => {
      Object.assign(mockEditorStore, {
        currentFilePath: '/path/to/file.abl',
        dslContent: 'agent TestAgent { }',
      });

      mockFetch.mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            success: false,
            error: 'Permission denied',
          }),
      });

      const { result } = renderHook(() => useABLParsing());

      let success: boolean | undefined;
      await act(async () => {
        success = await result.current.saveABL();
      });

      expect(success).toBe(false);
      expect(mockEditorStore.setSaveError).toHaveBeenCalledWith('Permission denied');
    });

    it('should handle save API failure', async () => {
      Object.assign(mockEditorStore, {
        currentFilePath: '/path/to/file.abl',
        dslContent: 'agent TestAgent { }',
      });

      mockFetch.mockRejectedValueOnce(new Error('Disk full'));

      const { result } = renderHook(() => useABLParsing());

      let success: boolean | undefined;
      await act(async () => {
        success = await result.current.saveABL();
      });

      expect(success).toBe(false);
      expect(mockEditorStore.setSaveError).toHaveBeenCalledWith('Failed to save ABL');
      expect(mockEditorStore.setIsSaving).toHaveBeenCalledWith(false);
    });
  });

  describe('cleanup on unmount', () => {
    it('should clear pending parse timeout on unmount', async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ success: true, errors: [], warnings: [] }),
      });

      const { result, unmount } = renderHook(() => useABLParsing());

      act(() => {
        result.current.parseLive('agent A {}');
      });

      unmount();

      // Advancing timers after unmount should not trigger a fetch
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// useLLMCalls
// ===========================================================================

describe('useLLMCalls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockObservatoryEvents.length = 0;
  });

  it('should return empty calls and zero metrics when no events', () => {
    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls).toEqual([]);
    expect(result.current.metrics).toEqual({
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      avgLatencyMs: 0,
    });
  });

  it('should filter only llm_call events', () => {
    mockObservatoryEvents.push(
      {
        id: 'ev-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T10:00:00Z'),
        agentName: 'TestAgent',
        data: {
          model: 'claude-3.5-sonnet',
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 500,
        },
      },
      {
        id: 'ev-2',
        type: 'tool_call',
        timestamp: new Date('2025-01-01T10:00:01Z'),
        agentName: 'TestAgent',
        data: { toolName: 'search', success: true },
      },
    );

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls).toHaveLength(1);
    expect(result.current.calls[0].model).toBe('claude-3.5-sonnet');
  });

  it('should compute aggregate metrics', () => {
    mockObservatoryEvents.push(
      {
        id: 'ev-1',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T10:00:00Z'),
        agentName: 'TestAgent',
        data: {
          model: 'claude-3.5-sonnet',
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 500,
        },
      },
      {
        id: 'ev-2',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T10:00:01Z'),
        agentName: 'TestAgent',
        data: {
          model: 'claude-3.5-sonnet',
          inputTokens: 200,
          outputTokens: 100,
          latencyMs: 300,
        },
      },
    );

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.metrics.totalCalls).toBe(2);
    expect(result.current.metrics.totalInputTokens).toBe(300);
    expect(result.current.metrics.totalOutputTokens).toBe(150);
    expect(result.current.metrics.avgLatencyMs).toBe(400);
  });

  it('should handle alternative token field names (tokensIn/tokensOut)', () => {
    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      agentName: 'TestAgent',
      data: {
        model: 'claude-3.5-sonnet',
        tokensIn: 150,
        tokensOut: 75,
        latency_ms: 600,
      },
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].inputTokens).toBe(150);
    expect(result.current.calls[0].outputTokens).toBe(75);
    expect(result.current.calls[0].latencyMs).toBe(600);
  });

  it('should sort calls by timestamp descending (newest first)', () => {
    mockObservatoryEvents.push(
      {
        id: 'ev-old',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T08:00:00Z'),
        agentName: 'TestAgent',
        data: { model: 'claude-3.5-sonnet' },
      },
      {
        id: 'ev-new',
        type: 'llm_call',
        timestamp: new Date('2025-01-01T10:00:00Z'),
        agentName: 'TestAgent',
        data: { model: 'claude-3.5-sonnet' },
      },
    );

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].id).toBe('ev-new');
    expect(result.current.calls[1].id).toBe('ev-old');
  });

  it('should limit to 100 calls', () => {
    for (let i = 0; i < 120; i++) {
      mockObservatoryEvents.push({
        id: `ev-${i}`,
        type: 'llm_call',
        timestamp: new Date(`2025-01-01T10:${String(i).padStart(2, '0')}:00Z`),
        agentName: 'TestAgent',
        data: { model: 'claude-3.5-sonnet', inputTokens: 10, outputTokens: 5 },
      });
    }

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls).toHaveLength(100);
    // But metrics should include all 120 calls
    expect(result.current.metrics.totalCalls).toBe(120);
  });

  it('should extract messages from data', () => {
    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      agentName: 'TestAgent',
      data: {
        model: 'claude-3.5-sonnet',
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' },
        ],
        response: 'Hi there!',
      },
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].messages).toHaveLength(2);
    expect(result.current.calls[0].response).toBe('Hi there!');
  });

  it('should construct messages from prompt if messages is empty', () => {
    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      agentName: 'TestAgent',
      data: {
        model: 'claude-3.5-sonnet',
        messages: [],
        prompt: 'What is the weather?',
        text: 'The weather is sunny.',
      },
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].messages).toEqual([
      { role: 'user', content: 'What is the weather?' },
    ]);
    expect(result.current.calls[0].response).toBe('The weather is sunny.');
  });

  it('should use durationMs from event when latencyMs is not in data', () => {
    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      durationMs: 750,
      agentName: 'TestAgent',
      data: {
        model: 'claude-3.5-sonnet',
      },
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].latencyMs).toBe(750);
  });

  it('should default model to "unknown" when not provided', () => {
    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      agentName: 'TestAgent',
      data: {},
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].model).toBe('unknown');
  });

  it('should include toolCalls and raw payloads when present', () => {
    const toolCalls = [{ id: 'tc-1', name: 'search', input: { q: 'test' } }];
    const rawRequest = { messages: [] };
    const rawResponse = { choices: [] };

    mockObservatoryEvents.push({
      id: 'ev-1',
      type: 'llm_call',
      timestamp: new Date('2025-01-01T10:00:00Z'),
      agentName: 'TestAgent',
      data: {
        model: 'claude-3.5-sonnet',
        toolCalls,
        rawRequest,
        rawResponse,
      },
    });

    const { result } = renderHook(() => useLLMCalls());

    expect(result.current.calls[0].toolCalls).toEqual(toolCalls);
    expect(result.current.calls[0].rawRequest).toEqual(rawRequest);
    expect(result.current.calls[0].rawResponse).toEqual(rawResponse);
  });
});
