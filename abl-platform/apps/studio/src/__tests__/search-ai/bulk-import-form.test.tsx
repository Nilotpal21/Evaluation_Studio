/**
 * BulkImportForm Tests
 *
 * Tests the bulk HTTP import form (Flow 2c):
 * - Renders URL textarea
 * - Start Import button disabled without URLs
 * - Parses URLs correctly (splits by newline, filters invalid)
 * - Creates source then submits batch
 * - onJobStarted called with jobId + sourceId
 * - Error state shown on failure
 * - All text from i18n
 */

import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockAddSource, mockDeleteSource, mockSubmitBatchCrawl } = vi.hoisted(() => ({
  mockAddSource: vi.fn(),
  mockDeleteSource: vi.fn(),
  mockSubmitBatchCrawl: vi.fn(),
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Zap: n,
    ChevronDown: n,
    Check: n,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

vi.mock('../../api/search-ai', () => ({
  addSource: mockAddSource,
  deleteSource: mockDeleteSource,
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../api/crawl', () => ({
  submitBatchCrawl: mockSubmitBatchCrawl,
  getCrawlHistory: vi.fn(),
  recrawlSource: vi.fn(),
}));

// ── Component under test ──────────────────────────────────────────────────────

import { BulkImportForm } from '../../components/search-ai/BulkImportForm';
import { toast } from 'sonner';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BulkImportForm', () => {
  const defaultProps = {
    indexId: 'idx-1',
    onJobStarted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddSource.mockResolvedValue({
      source: { _id: 'src-123', name: 'example.com', sourceType: 'web' },
    });
    mockDeleteSource.mockResolvedValue(undefined);
    mockSubmitBatchCrawl.mockResolvedValue({
      success: true,
      needsUserInput: false,
      jobId: 'job-456',
    });
  });

  test('renders URL textarea with label', () => {
    render(<BulkImportForm {...defaultProps} />);
    expect(screen.getByLabelText('URLs (one per line)')).toBeInTheDocument();
  });

  test('renders strategy select and max pages input', () => {
    render(<BulkImportForm {...defaultProps} />);
    expect(screen.getByLabelText('Strategy')).toBeInTheDocument();
    expect(screen.getByLabelText('Max pages')).toBeInTheDocument();
  });

  test('renders info text about fast HTTP crawl', () => {
    render(<BulkImportForm {...defaultProps} />);
    expect(screen.getByText('Fast HTTP crawl — no JavaScript rendering.')).toBeInTheDocument();
  });

  test('renders hint about JS-rendered sites', () => {
    render(<BulkImportForm {...defaultProps} />);
    expect(screen.getByText('For JS-rendered sites, use "Crawl Website"')).toBeInTheDocument();
  });

  test('Start Import button disabled without URLs', () => {
    render(<BulkImportForm {...defaultProps} />);
    const btn = screen.getByRole('button', { name: /Start Import/i });
    expect(btn).toBeDisabled();
  });

  test('Start Import button enabled when valid URLs entered', async () => {
    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');

    const btn = screen.getByRole('button', { name: /Start Import/i });
    expect(btn).not.toBeDisabled();
  });

  test('filters invalid URLs (non-http lines)', async () => {
    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1\nnot-a-url\nhttps://example.com/page-2');

    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(mockSubmitBatchCrawl).toHaveBeenCalledWith(
        expect.objectContaining({
          urls: ['https://example.com/page-1', 'https://example.com/page-2'],
        }),
      );
    });
  });

  test('creates source then submits batch with correct params', async () => {
    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');

    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(mockAddSource).toHaveBeenCalledWith('idx-1', {
        name: 'example.com',
        sourceType: 'web',
      });
    });

    await waitFor(() => {
      expect(mockSubmitBatchCrawl).toHaveBeenCalledWith({
        urls: ['https://example.com/page-1'],
        indexId: 'idx-1',
        sourceId: 'src-123',
        strategy: 'smart',
        limits: { maxPages: 500 },
      });
    });
  });

  test('onJobStarted called with jobId and sourceId on success', async () => {
    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(defaultProps.onJobStarted).toHaveBeenCalledWith('job-456', 'src-123', 'example.com');
    });
  });

  test('shows error when no valid URLs entered', async () => {
    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'not-a-url\nalso-invalid');

    // Button should still be disabled since no http URLs
    const btn = screen.getByRole('button', { name: /Start Import/i });
    expect(btn).toBeDisabled();
  });

  test('shows error on source creation failure', async () => {
    mockAddSource.mockRejectedValueOnce(new Error('Network error'));

    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-error')).toBeInTheDocument();
    });
    expect(toast.error).toHaveBeenCalled();
  });

  test('shows error on batch submit failure', async () => {
    mockSubmitBatchCrawl.mockRejectedValueOnce(new Error('Batch failed'));

    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-error')).toBeInTheDocument();
    });
    expect(toast.error).toHaveBeenCalled();
  });

  test('handles needsUserInput response with warning toast', async () => {
    mockSubmitBatchCrawl.mockResolvedValueOnce({
      success: true,
      needsUserInput: true,
      pendingId: 'pending-1',
      questions: [{ id: 'q1', text: 'Choose strategy', options: [] }],
    });

    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled();
    });
    // onJobStarted should NOT be called
    expect(defaultProps.onJobStarted).not.toHaveBeenCalled();
  });

  test('shows an error toast and logs when orphan source cleanup fails after needsUserInput', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanupError = new Error('cleanup failed');

    mockSubmitBatchCrawl.mockResolvedValueOnce({
      success: true,
      needsUserInput: true,
      pendingId: 'pending-1',
      questions: [{ id: 'q1', text: 'Choose strategy', options: [] }],
    });
    mockDeleteSource.mockRejectedValueOnce(cleanupError);

    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(mockDeleteSource).toHaveBeenCalledWith('idx-1', 'src-123');
    });

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith('For JS-rendered sites, use "Crawl Website"');
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.any(String));
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('shows both cleanup and import errors when orphan source cleanup fails after a batch failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockSubmitBatchCrawl.mockRejectedValueOnce(new Error('Batch failed'));
    mockDeleteSource.mockRejectedValueOnce(new Error('cleanup failed'));

    const user = userEvent.setup();
    render(<BulkImportForm {...defaultProps} />);

    const textarea = screen.getByTestId('bulk-urls-textarea');
    await user.type(textarea, 'https://example.com/page-1');
    await user.click(screen.getByRole('button', { name: /Start Import/i }));

    await waitFor(() => {
      expect(mockDeleteSource).toHaveBeenCalledWith('idx-1', 'src-123');
    });

    await waitFor(() => {
      expect(screen.getByTestId('bulk-import-error')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(2);
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('max pages defaults to 500', () => {
    render(<BulkImportForm {...defaultProps} />);
    expect(screen.getByLabelText('Max pages')).toHaveValue(500);
  });
});
