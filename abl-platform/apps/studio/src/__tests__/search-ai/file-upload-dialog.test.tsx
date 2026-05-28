/**
 * @vitest-environment happy-dom
 *
 * FileUploadDialog — duplicate detection & cancel/abort tests
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react (override setup Proxy — Proxy causes hang)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return {
    Upload: n,
    FileText: n,
    Info: n,
    Plus: n,
    X: n,
    ChevronDown: n,
    ChevronRight: n,
    RotateCcw: n,
  };
});

// ---------------------------------------------------------------------------
// Mock SWR
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  isValidating: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ---------------------------------------------------------------------------
// Mock API
// ---------------------------------------------------------------------------

const mockUploadDocument = vi.fn();
const mockFetchUploadHints = vi.fn();
const mockAddSource = vi.fn();

vi.mock('../../api/search-ai', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
  fetchUploadHints: (...args: unknown[]) => mockFetchUploadHints(...args),
  addSource: (...args: unknown[]) => mockAddSource(...args),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock sonner toast
// ---------------------------------------------------------------------------

const { mockToast } = vi.hoisted(() => ({
  mockToast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: mockToast }));

// ---------------------------------------------------------------------------
// Mock sanitize-error
// ---------------------------------------------------------------------------

vi.mock('@/lib/sanitize-error', () => ({
  sanitizeError: (_err: unknown, fallback: string) => fallback,
}));

// ---------------------------------------------------------------------------
// Import component (after mocks)
// ---------------------------------------------------------------------------

import { FileUploadDialog } from '../../components/search-ai/data/FileUploadDialog';
import type { SearchAISource } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFile(name: string, size: number, type = 'application/pdf'): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  indexId: 'idx-1',
  sourceId: 'src-1',
  sourceName: 'Test Source',
  sources: [{ _id: 'src-1', name: 'Test Source', sourceType: 'manual' }] as SearchAISource[],
  onUploadComplete: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileUploadDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwrReturn = {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mockMutate,
    };
  });

  describe('Duplicate file detection', () => {
    it('rejects files with same name and size in a batch', async () => {
      render(<FileUploadDialog {...defaultProps} />);

      const dropzone = screen.getByRole('button', { name: /file upload drop zone/i });

      // Drop a batch with unique file + two copies of same file (same name+size)
      const file1 = createFile('doc.pdf', 1024);
      const file1dup = createFile('doc.pdf', 1024);
      const file2 = createFile('report.pdf', 2048);

      await act(async () => {
        fireEvent.drop(dropzone, {
          dataTransfer: { files: [file1, file2, file1dup] },
        });
      });

      // Should show warning for the duplicate
      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('doc.pdf'));

      // doc.pdf should appear once, report.pdf once
      expect(screen.getByText('report.pdf')).toBeInTheDocument();
      const docEntries = screen.getAllByText('doc.pdf');
      expect(docEntries).toHaveLength(1);
    });

    it('accepts file with same name but different size via drop', async () => {
      const { unmount } = render(<FileUploadDialog {...defaultProps} />);

      const dropzone = screen.getByRole('button', { name: /file upload drop zone/i });

      // First drop: doc.pdf (1024) + different file
      const file1 = createFile('doc.pdf', 1024);
      const file2 = createFile('doc.pdf', 2048); // same name, different size

      await act(async () => {
        fireEvent.drop(dropzone, {
          dataTransfer: { files: [file1, file2] },
        });
      });

      // Both should be accepted — different sizes means not a duplicate
      expect(mockToast.warning).not.toHaveBeenCalled();
      const fileEntries = screen.getAllByText('doc.pdf');
      expect(fileEntries).toHaveLength(2);

      unmount();
    });

    it('deduplicates within a single batch', async () => {
      render(<FileUploadDialog {...defaultProps} />);

      const dropzone = screen.getByRole('button', { name: /file upload drop zone/i });

      const file1 = createFile('doc.pdf', 1024);
      const file2 = createFile('doc.pdf', 1024);

      await act(async () => {
        fireEvent.drop(dropzone, {
          dataTransfer: { files: [file1, file2] },
        });
      });

      // Should show warning for the duplicate
      expect(mockToast.warning).toHaveBeenCalledTimes(1);

      // Only one file should appear
      const fileEntries = screen.getAllByText('doc.pdf');
      expect(fileEntries).toHaveLength(1);
    });
  });

  describe('Upload cancel/abort', () => {
    it('shows cancel button during upload that aborts remaining files', async () => {
      // Make upload slow so we can cancel
      let resolveUpload: (() => void) | undefined;
      let rejectUpload: ((err: Error) => void) | undefined;
      let uploadCallCount = 0;

      mockUploadDocument.mockImplementation(() => {
        uploadCallCount++;
        if (uploadCallCount === 1) {
          // First file uploads immediately
          return Promise.resolve({
            id: 'doc-1',
            originalReference: 'file1.pdf',
            contentType: 'application/pdf',
            contentSizeBytes: 1024,
            status: 'processing',
          });
        }
        // Second file hangs until we resolve/reject
        return new Promise((resolve, reject) => {
          resolveUpload = () =>
            resolve({
              id: 'doc-2',
              originalReference: 'file2.pdf',
              contentType: 'application/pdf',
              contentSizeBytes: 2048,
              status: 'processing',
            });
          rejectUpload = reject;
        });
      });

      render(<FileUploadDialog {...defaultProps} />);

      const dropzone = screen.getByRole('button', { name: /file upload drop zone/i });

      // Add two files
      const file1 = createFile('file1.pdf', 1024);
      const file2 = createFile('file2.pdf', 2048);
      const file3 = createFile('file3.pdf', 3072);

      await act(async () => {
        fireEvent.drop(dropzone, {
          dataTransfer: { files: [file1, file2, file3] },
        });
      });

      // Click upload button
      const uploadButton = screen.getByRole('button', { name: /upload 3 files/i });
      await act(async () => {
        fireEvent.click(uploadButton);
      });

      // Wait for upload to start (first file done, second in progress)
      await waitFor(() => {
        expect(uploadCallCount).toBeGreaterThanOrEqual(2);
      });

      // Cancel button should be enabled during upload
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      expect(cancelButton).not.toBeDisabled();

      // Click cancel
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      // The second upload should reject with AbortError
      if (rejectUpload) {
        const abortError = new DOMException('The operation was aborted.', 'AbortError');
        await act(async () => {
          rejectUpload!(abortError);
        });
      }

      // Should show cancel toast with partial success
      await waitFor(() => {
        expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('Upload cancelled'));
      });

      // onUploadComplete should be called since 1 file was uploaded
      expect(defaultProps.onUploadComplete).toHaveBeenCalled();
    });

    it('does not call onUploadComplete when cancelled with 0 uploads', async () => {
      // Make first upload hang
      let rejectUpload: ((err: Error) => void) | undefined;

      mockUploadDocument.mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          rejectUpload = reject;
        });
      });

      const onUploadComplete = vi.fn();
      render(<FileUploadDialog {...defaultProps} onUploadComplete={onUploadComplete} />);

      const dropzone = screen.getByRole('button', { name: /file upload drop zone/i });

      const file1 = createFile('file1.pdf', 1024);
      await act(async () => {
        fireEvent.drop(dropzone, {
          dataTransfer: { files: [file1] },
        });
      });

      const uploadButton = screen.getByRole('button', { name: /upload 1 file/i });
      await act(async () => {
        fireEvent.click(uploadButton);
      });

      // Cancel
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await act(async () => {
        fireEvent.click(cancelButton);
      });

      // Reject the pending upload
      if (rejectUpload) {
        const abortError = new DOMException('The operation was aborted.', 'AbortError');
        await act(async () => {
          rejectUpload!(abortError);
        });
      }

      await waitFor(() => {
        expect(mockToast.info).toHaveBeenCalled();
      });

      // onUploadComplete should NOT be called since no files were uploaded
      expect(onUploadComplete).not.toHaveBeenCalled();
    });
  });
});
