/**
 * DslEditorOverlay Save Flow Tests
 *
 * Tests the save workflow of DslEditorOverlay: button states, API calls,
 * success/failure handling, and store interactions.
 * (The existing header-overlays.test.tsx covers open/close behavior.)
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// =============================================================================
// MOCKS — hoisted values so vi.mock factories can reference them
// =============================================================================

const mockSetOriginalContent = vi.fn();
const mockMarkSaved = vi.fn();
const mockSetSaveError = vi.fn();

/** Mutable store state — tests mutate these before render */
let storeDslContent = 'AGENT booking_agent {}';
let storeIsDirty = false;
let storeSaveError: string | null = null;
let storeCompileErrors: string[] = [];

vi.mock('@/store/editor-store', () => ({
  useEditorStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => {
      const state: Record<string, unknown> = {
        setOriginalContent: mockSetOriginalContent,
        dslContent: storeDslContent,
        isDirty: storeIsDirty,
        saveError: storeSaveError,
        compileErrors: storeCompileErrors,
      };
      return selector(state);
    },
    {
      getState: () => ({
        dslContent: storeDslContent,
        markSaved: mockMarkSaved,
        setSaveError: (error: string | null) => {
          storeSaveError = error;
          mockSetSaveError(error);
        },
        setCompileErrors: (errors: string[]) => {
          storeCompileErrors = errors;
        },
      }),
    },
  ),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

// ABLEditor mock — rendered by next/dynamic
vi.mock('@/components/abl/ABLEditor', () => ({
  ABLEditor: ({ className }: { className?: string }) => (
    <div data-testid="abl-editor" className={className}>
      Monaco Editor
    </div>
  ),
}));

// Override next/dynamic to return our mocked ABLEditor directly
vi.mock('next/dynamic', () => ({
  default: () => {
    return ({ className }: { className?: string }) => (
      <div data-testid="abl-editor" className={className}>
        Monaco Editor
      </div>
    );
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { DslEditorOverlay } from '../../components/agent-detail/DslEditorOverlay';

// =============================================================================
// TESTS
// =============================================================================

describe('DslEditorOverlay — save flow', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    projectId: 'proj-1',
    agentName: 'booking_agent',
    dsl: 'AGENT booking_agent {}',
    onSaved: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storeDslContent = 'AGENT booking_agent {}';
    storeIsDirty = false;
    storeSaveError = null;
    storeCompileErrors = [];
    // Mock returns different responses based on the URL
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/dsl')) {
        // PUT /dsl returns status-like response
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      if (url.includes('/compile')) {
        // POST /compile returns success response
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              errors: [],
              warnings: [],
            }),
        });
      }
      // GET agent details (from useEffect on overlay open)
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            agent: {
              dslContent: 'AGENT booking_agent {}',
            },
          }),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Store seeding
  // ---------------------------------------------------------------------------

  it('seeds editor store with DSL on open (setOriginalContent called with dsl prop)', () => {
    render(<DslEditorOverlay {...defaultProps} />);
    return waitFor(() => {
      expect(mockSetOriginalContent).toHaveBeenCalledWith('AGENT booking_agent {}');
    });
  });

  // ---------------------------------------------------------------------------
  // Save button state
  // ---------------------------------------------------------------------------

  it('save button disabled when not dirty', () => {
    storeIsDirty = false;
    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();
  });

  it('save button enabled when dirty', () => {
    storeIsDirty = true;
    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // API call
  // ---------------------------------------------------------------------------

  it('calls PUT API with dslContent on save, then compile endpoint', async () => {
    storeIsDirty = true;
    storeDslContent = 'AGENT booking_agent { UPDATED }';

    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/agents/booking_agent/dsl',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dslContent: 'AGENT booking_agent { UPDATED }' }),
        }),
      );
    });

    // Verify compile endpoint was also called
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/compile'),
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  it('shows loading spinner during save', async () => {
    storeIsDirty = true;

    // Create a deferred promise so we can observe the loading state
    let resolveApi!: () => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveApi = () =>
          resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                errors: [],
              }),
          });
      }),
    );

    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    // Click save — enters loading state
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // The Loader2 icon should be visible (rendered as svg with lucide class)
    expect(document.querySelector('.lucide-loader2')).toBeInTheDocument();

    // Resolve the API call to clean up
    await act(async () => {
      resolveApi();
    });
  });

  // ---------------------------------------------------------------------------
  // Success path
  // ---------------------------------------------------------------------------

  it('calls markSaved() on success', async () => {
    storeIsDirty = true;

    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockMarkSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('calls onSaved() callback on success', async () => {
    storeIsDirty = true;
    const onSaved = vi.fn();

    render(<DslEditorOverlay {...defaultProps} onSaved={onSaved} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('calls onClose() on success', async () => {
    storeIsDirty = true;
    const onClose = vi.fn();

    render(<DslEditorOverlay {...defaultProps} onClose={onClose} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Failure path
  // ---------------------------------------------------------------------------

  it('sets save error on API failure', async () => {
    storeIsDirty = true;
    // Mock the PUT call to fail
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/dsl')) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockSetSaveError).toHaveBeenCalledWith('Network error');
    });
  });

  it('does NOT close on failure', async () => {
    storeIsDirty = true;
    const onClose = vi.fn();
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/dsl')) {
        return Promise.reject(new Error('Server error'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<DslEditorOverlay {...defaultProps} onClose={onClose} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockSetSaveError).toHaveBeenCalled();
    });

    // onClose should NOT have been called
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT call markSaved on failure', async () => {
    storeIsDirty = true;
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/dsl')) {
        return Promise.reject(new Error('Save failed'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    render(<DslEditorOverlay {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockSetSaveError).toHaveBeenCalled();
    });

    expect(mockMarkSaved).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Compile validation failure (agent name mismatch)
  // ---------------------------------------------------------------------------

  it('keeps editor open and shows error when compile validation fails', async () => {
    storeIsDirty = true;
    const onClose = vi.fn();
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/dsl')) {
        return Promise.resolve({ ok: true });
      }
      if (url.includes('/compile')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: false,
              errors: ['Agent DSL declares "booking_agent1" but this record is "booking_agent".'],
              warnings: [],
            }),
        });
      }
      return Promise.resolve({ ok: true });
    });

    render(<DslEditorOverlay {...defaultProps} onClose={onClose} />);
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockSetSaveError).toHaveBeenCalledWith(
        'Agent DSL declares "booking_agent1" but this record is "booking_agent".',
      );
    });

    // onClose should NOT have been called — editor stays open
    expect(onClose).not.toHaveBeenCalled();
    // markSaved should NOT have been called
    expect(mockMarkSaved).not.toHaveBeenCalled();
  });
});
