import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewChatComposer } from '@/components/preview/PreviewChatComposer';

describe('PreviewChatComposer', () => {
  it('sends text and uploaded attachment ids together', async () => {
    const onSend = vi.fn();
    const onUploadFile = vi.fn().mockResolvedValue('att-1');
    const onValueChange = vi.fn();

    render(
      <PreviewChatComposer
        value="Find me flights"
        onValueChange={onValueChange}
        onSend={onSend}
        placeholder="Type a message..."
        primaryColor="#2563eb"
        onUploadFile={onUploadFile}
      />,
    );

    const input = screen.getByTestId('preview-chat-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['ticket'], 'ticket.txt', { type: 'text/plain' })],
      },
    });

    await waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Find me flights', ['att-1']);
    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('shows upload errors from the attachment uploader', async () => {
    const onUploadFile = vi.fn().mockRejectedValue(new Error('Upload failed badly'));

    render(
      <PreviewChatComposer
        value=""
        onValueChange={vi.fn()}
        onSend={vi.fn()}
        placeholder="Type a message..."
        primaryColor="#2563eb"
        onUploadFile={onUploadFile}
      />,
    );

    const input = screen.getByTestId('preview-chat-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['ticket'], 'ticket.txt', { type: 'text/plain' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Upload failed: Upload failed badly');
    });
  });
});
