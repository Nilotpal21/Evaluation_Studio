/**
 * Tests for SourcesTable delete confirmation modal (ConfirmDialog).
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react (prevents infinite hang from barrel import)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Search: n,
    Upload: n,
    Eye: n,
    Trash2: n,
    Plus: n,
    AlertTriangle: n,
    X: n,
    ChevronUp: n,
    ChevronDown: n,
    ChevronsUpDown: n,
    LayoutGrid: n,
    List: n,
    Pause: n,
    Play: n,
    RefreshCw: n,
    KeyRound: n,
    Calendar: n,
    Download: n,
    MoreHorizontal: n,
    FileText: n,
    ChevronLeft: n,
    ChevronRight: n,
    RotateCcw: n,
    Globe: n,
    Clock: n,
    Activity: n,
    Layers: n,
  };
});

// ---------------------------------------------------------------------------
// Mock sonner toast
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------

vi.mock('../../api/search-ai', () => ({
  fetchEnterpriseConnectors: vi.fn().mockResolvedValue({ data: { connectors: [] } }),
  deleteSource: vi.fn().mockResolvedValue({ success: true }),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock framer-motion
// ---------------------------------------------------------------------------

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const { initial, animate, exit, transition, ...rest } = props;
      return (
        <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children as React.ReactNode}</div>
      );
    },
  },
}));

vi.mock('../../lib/animation', () => ({
  springs: { snappy: {}, gentle: {} },
  transitions: { slideRight: {}, backdrop: {} },
}));

// ---------------------------------------------------------------------------
// Mock panels (not under test)
// ---------------------------------------------------------------------------

vi.mock('../../components/search-ai/ConnectorDetailPanel', () => ({
  ConnectorDetailPanel: () => null,
}));

vi.mock('../../components/search-ai/data/SourceDetailPanel', () => ({
  SourceDetailPanel: () => null,
}));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_e: unknown, f: string) => f,
}));

// ---------------------------------------------------------------------------
// Mock ConfirmDialog with testid-based interaction surface
// ---------------------------------------------------------------------------

let capturedConfirmDialogProps: Record<string, unknown> = {};

vi.mock('../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: Record<string, unknown>) => {
    capturedConfirmDialogProps = props;
    if (!props.open) return null;
    return (
      <div data-testid="confirm-dialog">
        <span data-testid="confirm-dialog-title">{props.title as string}</span>
        <span data-testid="confirm-dialog-description">{props.description as string}</span>
        <button
          data-testid="confirm-dialog-confirm"
          onClick={props.onConfirm as () => void}
          disabled={props.loading as boolean}
        >
          {props.confirmLabel as string}
        </button>
        <button data-testid="confirm-dialog-cancel" onClick={props.onClose as () => void}>
          Cancel
        </button>
        {Boolean(props.loading) && <span data-testid="confirm-dialog-loading">Loading</span>}
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SourcesTable } from '../../components/search-ai/data/SourcesTable';
import { toast } from 'sonner';
import { deleteSource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSources(overrides?: Partial<SearchAISource>[]): SearchAISource[] {
  const defaults: SearchAISource[] = [
    {
      _id: 'src-1',
      tenantId: 't-1',
      indexId: 'idx-1',
      name: 'Test Source Alpha',
      sourceType: 'file',
      sourceConfig: {},
      status: 'active',
      extractionConfig: null,
      enrichmentConfig: null,
      syncSchedule: null,
      documentCount: 42,
      lastSyncAt: null,
      syncError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-17T00:00:00Z',
    },
    {
      _id: 'src-2',
      tenantId: 't-1',
      indexId: 'idx-1',
      name: 'Test Source Beta',
      sourceType: 'web',
      sourceConfig: {},
      status: 'active',
      extractionConfig: null,
      enrichmentConfig: null,
      syncSchedule: null,
      documentCount: 7,
      lastSyncAt: null,
      syncError: null,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-17T00:00:00Z',
    },
  ];
  if (overrides) {
    return defaults.map((d, i) => ({ ...d, ...(overrides[i] ?? {}) }));
  }
  return defaults;
}

const defaultProps = {
  indexId: 'idx-1',
  onRefresh: vi.fn(),
  onViewDocuments: vi.fn(),
  onUploadToSource: vi.fn(),
};

// ===========================================================================
// Tests
// ===========================================================================

describe('SourcesTable delete confirmation modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedConfirmDialogProps = {};
    // Force table view mode (component defaults to card view for <=6 sources)
    localStorage.setItem('sp-sources-view-mode', 'table');
  });

  it('delete button opens ConfirmDialog with correct source name and document count', () => {
    const sources = makeSources();
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Dialog should not be open initially
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();

    // Click the delete button for the first source (aria-label "Delete source")
    const deleteButtons = screen.getAllByLabelText('Delete source');
    fireEvent.click(deleteButtons[0]);

    // Dialog should now be open
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    // Verify title and description contain source name and document count
    const title = screen.getByTestId('confirm-dialog-title');
    expect(title).toBeInTheDocument();

    const description = screen.getByTestId('confirm-dialog-description');
    expect(description).toBeInTheDocument();

    // Verify the props passed to ConfirmDialog
    expect(capturedConfirmDialogProps.variant).toBe('danger');
    expect(capturedConfirmDialogProps.open).toBe(true);
  });

  it('confirming delete calls deleteSource API and refreshes', async () => {
    vi.mocked(deleteSource).mockResolvedValue({ deleted: true });
    const sources = makeSources();
    const onRefresh = vi.fn();
    render(<SourcesTable {...defaultProps} sources={sources} onRefresh={onRefresh} />);

    // Open delete dialog for first source
    const deleteButtons = screen.getAllByLabelText('Delete source');
    fireEvent.click(deleteButtons[0]);

    // Click confirm
    const confirmButton = screen.getByTestId('confirm-dialog-confirm');
    fireEvent.click(confirmButton);

    // Wait for async delete
    await vi.waitFor(() => {
      expect(vi.mocked(deleteSource)).toHaveBeenCalledWith('idx-1', 'src-1');
    });

    await vi.waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      expect(vi.mocked(toast).success).toHaveBeenCalled();
    });

    // Dialog should close after successful delete
    await vi.waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('cancelling dialog clears deleteTarget without deleting', () => {
    const sources = makeSources();
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Open delete dialog
    const deleteButtons = screen.getAllByLabelText('Delete source');
    fireEvent.click(deleteButtons[0]);
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    // Click cancel
    const cancelButton = screen.getByTestId('confirm-dialog-cancel');
    fireEvent.click(cancelButton);

    // Dialog should close
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();

    // Delete API should not have been called
    expect(vi.mocked(deleteSource)).not.toHaveBeenCalled();
  });

  it('clicking delete on a different row updates the target', () => {
    const sources = makeSources();
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Open delete dialog for first source
    const deleteButtons = screen.getAllByLabelText('Delete source');
    fireEvent.click(deleteButtons[0]);
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    // Now click delete on the second source
    fireEvent.click(deleteButtons[1]);

    // Dialog should still be open (updated target)
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
  });

  it('shows error toast when delete fails', async () => {
    vi.mocked(deleteSource).mockRejectedValue(new Error('Network error'));
    const sources = makeSources();
    render(<SourcesTable {...defaultProps} sources={sources} />);

    // Open delete dialog
    const deleteButtons = screen.getAllByLabelText('Delete source');
    fireEvent.click(deleteButtons[0]);

    // Click confirm
    const confirmButton = screen.getByTestId('confirm-dialog-confirm');
    fireEvent.click(confirmButton);

    await vi.waitFor(() => {
      expect(vi.mocked(toast).error).toHaveBeenCalled();
    });
  });

  it('upload and view docs buttons still work alongside delete', () => {
    const sources = makeSources();
    const onViewDocuments = vi.fn();
    const onUploadToSource = vi.fn();
    render(
      <SourcesTable
        {...defaultProps}
        sources={sources}
        onViewDocuments={onViewDocuments}
        onUploadToSource={onUploadToSource}
      />,
    );

    // Upload button should exist for file-type source
    const uploadButtons = screen.getAllByLabelText('Upload files');
    expect(uploadButtons.length).toBeGreaterThan(0);
    fireEvent.click(uploadButtons[0]);
    expect(onUploadToSource).toHaveBeenCalledWith('src-1', 'Test Source Alpha');

    // View docs button should exist
    const viewButtons = screen.getAllByLabelText('View documents');
    expect(viewButtons.length).toBeGreaterThan(0);
    fireEvent.click(viewButtons[0]);
    expect(onViewDocuments).toHaveBeenCalled();
  });
});
