import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  FileAttachment,
  encodeFilesForRequest,
  type PendingFile,
} from '@/lib/arch-ai/components/arch/chat/FileAttachment';
import { FileUpload } from '@/lib/arch-ai/components/arch/widgets/FileUpload';

function setInputFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: files,
  });
  fireEvent.change(input);
}

describe('Arch file attachment controls', () => {
  it('accepts markdown files reported as octet-stream in the chat attachment picker', () => {
    const onChange = vi.fn();
    const { container } = render(<FileAttachment files={[]} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    setInputFiles(input, [new File(['# Notes'], 'notes.md', { type: 'application/octet-stream' })]);

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        file: expect.objectContaining({ name: 'notes.md' }),
      }),
    ]);
    expect(screen.queryByText(/unsupported file type/i)).not.toBeInTheDocument();
  });

  it('encodes accepted attachments with canonical MIME types', async () => {
    const pending: PendingFile[] = [
      {
        file: new File(['# Notes'], 'notes.md', { type: 'application/octet-stream' }),
      },
    ];

    const [encoded] = await encodeFilesForRequest(pending);

    expect(encoded).toMatchObject({
      name: 'notes.md',
      type: 'text/markdown',
    });
  });

  it('matches collect-file widget accept rules against canonical MIME types', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <FileUpload
        input={{ message: 'Upload architecture brief', accept: ['application/pdf'], maxFiles: 1 }}
        onSubmit={onSubmit}
      />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    setInputFiles(input, [
      new File(['%PDF-1.4'], 'architecture.pdf', { type: 'application/octet-stream' }),
    ]);

    expect(screen.getByText('architecture.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/wrong file type/i)).not.toBeInTheDocument();
  });
});
