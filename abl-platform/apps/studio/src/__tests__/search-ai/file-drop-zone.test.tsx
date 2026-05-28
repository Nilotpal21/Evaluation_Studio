/**
 * Tests for FileDropZone component
 *
 * @vitest-environment happy-dom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock lucide-react — explicit object (Proxy mock from setup.tsx hangs)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const n = () => null;
  return { Upload: n };
});

// ---------------------------------------------------------------------------
// Mock Button component (avoids deep dependency chains)
// ---------------------------------------------------------------------------

vi.mock('../../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Import component under test (after all mocks)
// ---------------------------------------------------------------------------

import { FileDropZone } from '../../components/search-ai/home/FileDropZone';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(name: string, size: number, type = 'application/pdf'): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

function makeDataTransfer(files: File[]): Partial<DataTransfer> {
  return {
    files: files as unknown as FileList,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileDropZone', () => {
  const onFilesSelected = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders drop zone with correct text', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} />);

    expect(screen.getByText('Drop files here or click to browse')).toBeInTheDocument();
    expect(screen.getByText(/PDF, DOCX, TXT/)).toBeInTheDocument();
    expect(screen.getByText('Max 100 MB per file')).toBeInTheDocument();
    expect(screen.getByText('Browse files')).toBeInTheDocument();
  });

  it('calls onFilesSelected when valid files are dropped', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} />);

    const dropZone = screen.getByRole('button', { name: /file upload drop zone/i });
    const file = makeFile('test.pdf', 1024);

    fireEvent.drop(dropZone, {
      dataTransfer: makeDataTransfer([file]),
    });

    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    expect(onFilesSelected).toHaveBeenCalledWith([expect.objectContaining({ name: 'test.pdf' })]);
  });

  it('rejects files with unsupported extensions (shows error)', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} />);

    const dropZone = screen.getByRole('button', { name: /file upload drop zone/i });
    const file = makeFile('malware.exe', 1024, 'application/octet-stream');

    fireEvent.drop(dropZone, {
      dataTransfer: makeDataTransfer([file]),
    });

    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(screen.getByText(/malware\.exe: unsupported file type/)).toBeInTheDocument();
  });

  it('rejects files over MAX_FILE_SIZE (shows error)', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} />);

    const dropZone = screen.getByRole('button', { name: /file upload drop zone/i });
    // 101 MB — over 100 MB limit
    const file = makeFile('big.pdf', 101 * 1024 * 1024);

    fireEvent.drop(dropZone, {
      dataTransfer: makeDataTransfer([file]),
    });

    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(screen.getByText(/big\.pdf: file exceeds 100 MB limit/)).toBeInTheDocument();
  });

  it('rejects zero-byte files (shows error)', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} />);

    const dropZone = screen.getByRole('button', { name: /file upload drop zone/i });
    const file = makeFile('empty.pdf', 0);

    fireEvent.drop(dropZone, {
      dataTransfer: makeDataTransfer([file]),
    });

    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(screen.getByText(/empty\.pdf: file is empty/)).toBeInTheDocument();
  });

  it('disabled prop prevents interaction', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} disabled />);

    const dropZone = screen.getByRole('button', { name: /file upload drop zone/i });
    const file = makeFile('test.pdf', 1024);

    fireEvent.drop(dropZone, {
      dataTransfer: makeDataTransfer([file]),
    });

    expect(onFilesSelected).not.toHaveBeenCalled();

    // Disabled state: tabIndex should be -1
    expect(dropZone).toHaveAttribute('tabindex', '-1');
  });

  it('browse button exists and is disabled when component is disabled', () => {
    render(<FileDropZone onFilesSelected={onFilesSelected} disabled />);

    const browseButton = screen.getByText('Browse files');
    expect(browseButton).toBeDisabled();
  });
});
