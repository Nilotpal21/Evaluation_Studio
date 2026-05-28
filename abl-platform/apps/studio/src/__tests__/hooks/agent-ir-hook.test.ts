import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock apiFetch before importing the hook
// ---------------------------------------------------------------------------

const mockApiFetch = vi.fn();
vi.mock('../../lib/api-client', () => ({
  apiFetch: (...args: any[]) => mockApiFetch(...args),
  handleResponse: (r: any) => r.json(),
}));

// ---------------------------------------------------------------------------
// Mock agent-detail-store
// ---------------------------------------------------------------------------

const mockLoadFromIR = vi.fn();

vi.mock('../../store/agent-detail-store', () => ({
  useAgentDetailStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { loadFromIR: mockLoadFromIR };
    return selector ? selector(state) : state;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { useAgentIR } from '../../hooks/useAgentIR';

function renderAgentIRHook(projectId: string | null, agentName: string | null) {
  return renderHook(() => useAgentIR(projectId, agentName), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        children,
      ),
  });
}

// ===========================================================================
// useAgentIR
// ===========================================================================

describe('useAgentIR', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockLoadFromIR.mockReset();
  });

  it('returns null IR when projectId or agentName is missing', () => {
    const { result } = renderAgentIRHook(null, null);
    expect(result.current.ir).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('returns null IR when only projectId is provided', () => {
    const { result } = renderAgentIRHook('proj-1', null);
    expect(result.current.ir).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('returns null IR when only agentName is provided', () => {
    const { result } = renderAgentIRHook(null, 'booking');
    expect(result.current.ir).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches agent DSL and compiles to IR', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/booking/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: {
                ir_version: '1.0',
                metadata: { name: 'booking' },
                execution: { mode: 'reasoning' },
                identity: { goal: '', persona: '', limitations: [] },
                tools: [],
                gather: { fields: [] },
              },
              errors: [],
            }),
        });
      }
      if (url.includes('/agents/booking')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: booking\nMODE: reasoning' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-1', 'booking');

    await waitFor(() => {
      expect(result.current.ir).not.toBeNull();
    });

    expect((result.current.ir?.metadata as Record<string, unknown>)?.name).toBe('booking');
    expect(result.current.compileErrors).toHaveLength(0);
    expect(result.current.compileWarnings).toHaveLength(0);
  });

  it('returns compile errors when compilation fails', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/support/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: false,
              ir: null,
              errors: ['Unexpected token at line 1'],
            }),
        });
      }
      if (url.includes('/agents/support')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'INVALID DSL' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-1', 'support');

    await waitFor(() => {
      expect(result.current.compileErrors).toHaveLength(1);
    });

    expect(result.current.ir).toBeNull();
    expect(result.current.compileErrors[0]).toBe('Unexpected token at line 1');
    expect(result.current.compileWarnings).toEqual([]);
  });

  it('does not expose or load IR when compilation reports failure', async () => {
    const siblingIR = {
      ir_version: '1.0',
      metadata: { name: 'sibling_agent' },
    };

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/support-strict/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: false,
              ir: siblingIR,
              errors: ['support: Unknown delegate target'],
            }),
        });
      }
      if (url.includes('/agents/support-strict')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: support-strict' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-strict', 'support-strict');

    await waitFor(() => {
      expect(result.current.compileErrors).toEqual(['support: Unknown delegate target']);
    });

    expect(result.current.ir).toBeNull();
    expect(mockLoadFromIR).not.toHaveBeenCalled();
  });

  it('separates compile warnings from compile errors', async () => {
    const warningIR = {
      ir_version: '1.0',
      metadata: { name: 'booking' },
    };

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/booking-warning/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: warningIR,
              errors: [],
              warnings: ['booking: Tool resolution warning'],
            }),
        });
      }
      if (url.includes('/agents/booking-warning')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: booking-warning' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-warning', 'booking-warning');

    await waitFor(() => {
      expect(result.current.ir).toEqual(warningIR);
    });

    expect(result.current.compileErrors).toEqual([]);
    expect(result.current.compileWarnings).toEqual(['booking: Tool resolution warning']);
  });

  it('returns error when agent has no DSL content', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/empty')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: null } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-1', 'empty');

    await waitFor(() => {
      expect(result.current.compileErrors).toHaveLength(1);
    });

    expect(result.current.ir).toBeNull();
    expect(result.current.compileErrors[0]).toBe('Agent has no DSL content');
    expect(result.current.dsl).toBe('');
    expect(result.current.compileWarnings).toEqual([]);
  });

  it('calls loadFromIR on the detail store on success', async () => {
    const mockIR = {
      ir_version: '1.0',
      metadata: { name: 'loader' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'test', persona: '', limitations: [] },
      tools: [],
      gather: { fields: [] },
    };

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/loader/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: mockIR,
              errors: [],
            }),
        });
      }
      if (url.includes('/agents/loader')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: loader' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    renderAgentIRHook('proj-2', 'loader');

    await waitFor(() => {
      expect(mockLoadFromIR).toHaveBeenCalledWith(mockIR, 'proj-2/loader');
    });
  });

  it('returns the raw DSL content on success', async () => {
    const dslContent = 'AGENT: dsl-check\nGOAL: Help users';

    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/dsl-check/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: { metadata: { name: 'dsl-check' } },
              errors: [],
            }),
        });
      }
      if (url.includes('/agents/dsl-check')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-dsl', 'dsl-check');

    await waitFor(() => {
      expect(result.current.dsl).toBe(dslContent);
    });

    expect(result.current.compileWarnings).toEqual([]);
  });

  it('encodes agent name in the URL', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: null } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    renderAgentIRHook('proj-1', 'agent with spaces');

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agent%20with%20spaces'),
      );
    });
  });

  it('defaults compileErrors to empty array when absent', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/agents/test/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              ir: { metadata: { name: 'test' } },
              // No errors field at all
            }),
        });
      }
      if (url.includes('/agents/test')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agent: { dslContent: 'AGENT: test' } }),
        });
      }
      return Promise.reject(new Error('unknown url'));
    });

    const { result } = renderAgentIRHook('proj-1', 'test');

    await waitFor(() => {
      expect(result.current.ir).not.toBeNull();
    });

    expect(result.current.compileErrors).toEqual([]);
    expect(result.current.compileWarnings).toEqual([]);
  });
});
