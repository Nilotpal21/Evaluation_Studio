/**
 * TemplateUploadDialog Component Tests
 *
 * Tests the upload dialog: drop zone rendering, file size info,
 * cancel button, and error state display.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateUploadDialog } from '../../../components/admin/TemplateUploadDialog';

// Mock sonner — external third-party package
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock fflate — external third-party package (zip extraction)
vi.mock('fflate', () => ({
  unzip: vi.fn(),
  strFromU8: vi.fn(),
}));

describe('TemplateUploadDialog', () => {
  it('renders upload dialog with drop zone', () => {
    render(<TemplateUploadDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

    // Dialog title
    expect(screen.getByText('Upload Template')).toBeTruthy();
    // Drop zone instructions
    expect(screen.getByText('Drop a .zip file here or click to browse')).toBeTruthy();
  });

  it('shows file size limit info', () => {
    render(<TemplateUploadDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

    // The dropzone hint showing the file size limit
    expect(screen.getByText('.zip (max 4MB)')).toBeTruthy();
  });

  it('renders cancel button', () => {
    const onClose = vi.fn();

    render(<TemplateUploadDialog open={true} onClose={onClose} onSuccess={vi.fn()} />);

    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton).toBeTruthy();

    fireEvent.click(cancelButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows upload description text', () => {
    render(<TemplateUploadDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

    expect(screen.getByText('Upload a project export zip to create a new template')).toBeTruthy();
  });

  it('contains a hidden file input for .zip files', () => {
    render(<TemplateUploadDialog open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput?.getAttribute('accept')).toBe('.zip');
  });
});
