import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInputBar } from '../../components/chat/ChatInputBar';

describe('ChatInputBar', () => {
  // ─── Core behavior ───────────────────────────────────────────────

  test('renders textarea with placeholder', () => {
    render(<ChatInputBar onSend={() => {}} />);
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument();
  });

  test('send button disabled when empty', () => {
    render(<ChatInputBar onSend={() => {}} />);
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  test('send button enabled when text entered', () => {
    render(<ChatInputBar onSend={() => {}} />);
    fireEvent.change(screen.getByTestId('chat-input-textarea'), { target: { value: 'Hello' } });
    expect(screen.getByLabelText('Send message')).not.toBeDisabled();
  });

  test('calls onSend with message text on submit', () => {
    const onSend = vi.fn();
    render(<ChatInputBar onSend={onSend} />);
    const textarea = screen.getByTestId('chat-input-textarea');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('Hello', []);
  });

  test('supports stable custom selectors for embedded chat surfaces', () => {
    render(
      <ChatInputBar onSend={() => {}} inputTestId="arch-input" sendButtonTestId="arch-send" />,
    );

    expect(screen.getByTestId('arch-input')).toBeInTheDocument();
    expect(screen.getByTestId('arch-send')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input-textarea')).not.toBeInTheDocument();
  });

  test('clears input after send', () => {
    render(<ChatInputBar onSend={() => {}} />);
    const textarea = screen.getByTestId('chat-input-textarea');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(textarea).toHaveValue('');
  });

  test('shows model label as Default', () => {
    render(<ChatInputBar onSend={() => {}} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  test('renders attachment button', () => {
    render(<ChatInputBar onSend={() => {}} />);
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
  });

  test('disables input when disabled prop is true', () => {
    render(<ChatInputBar onSend={() => {}} disabled />);
    expect(screen.getByTestId('chat-input-textarea')).toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  test('shows indicator when disabled for project creation', () => {
    render(<ChatInputBar onSend={() => {}} disabled disabledReason="project-created" />);
    expect(screen.getByText('Project ready')).toBeInTheDocument();
  });

  test('hides indicator when disabled for streaming', () => {
    render(<ChatInputBar onSend={() => {}} disabled disabledReason="streaming" />);
    expect(screen.queryByText('Project ready')).not.toBeInTheDocument();
  });

  test('hides indicator when not disabled', () => {
    render(<ChatInputBar onSend={() => {}} />);
    expect(screen.queryByText('Project ready')).not.toBeInTheDocument();
  });

  // ─── Variant tests ───────────────────────────────────────────────

  describe('variant="compact"', () => {
    test('renders with rounded-xl instead of rounded-2xl', () => {
      render(<ChatInputBar onSend={() => {}} variant="compact" />);
      const container = screen.getByTestId('chat-input-bar');
      expect(container.className).toContain('rounded-xl');
      expect(container.className).not.toContain('rounded-2xl');
    });

    test('hides model label', () => {
      render(<ChatInputBar onSend={() => {}} variant="compact" />);
      expect(screen.queryByText('Default')).not.toBeInTheDocument();
    });

    test('renders with compact textarea sizing', () => {
      render(<ChatInputBar onSend={() => {}} variant="compact" />);
      const textarea = screen.getByTestId('chat-input-textarea');
      expect(textarea.className).toContain('min-h-[36px]');
    });
  });

  // ─── showModelLabel ──────────────────────────────────────────────

  describe('showModelLabel', () => {
    test('hides label when showModelLabel=false', () => {
      render(<ChatInputBar onSend={() => {}} showModelLabel={false} />);
      expect(screen.queryByText('Default')).not.toBeInTheDocument();
    });

    test('shows label by default', () => {
      render(<ChatInputBar onSend={() => {}} />);
      expect(screen.getByText('Default')).toBeInTheDocument();
    });
  });

  // ─── footer slot ─────────────────────────────────────────────────

  describe('footer', () => {
    test('renders footer content below input', () => {
      render(
        <ChatInputBar onSend={() => {}} footer={<div data-testid="test-footer">Context</div>} />,
      );
      expect(screen.getByTestId('test-footer')).toBeInTheDocument();
      expect(screen.getByText('Context')).toBeInTheDocument();
    });

    test('does not render footer when not provided', () => {
      render(<ChatInputBar onSend={() => {}} />);
      expect(screen.queryByTestId('test-footer')).not.toBeInTheDocument();
    });
  });

  // ─── autoFocus ───────────────────────────────────────────────────

  describe('autoFocus', () => {
    test('focuses textarea on mount when autoFocus=true', () => {
      render(<ChatInputBar onSend={() => {}} autoFocus />);
      expect(screen.getByTestId('chat-input-textarea')).toHaveFocus();
    });

    test('does not focus textarea by default', () => {
      render(<ChatInputBar onSend={() => {}} />);
      expect(screen.getByTestId('chat-input-textarea')).not.toHaveFocus();
    });
  });

  // ─── maxLength ───────────────────────────────────────────────────

  describe('maxLength', () => {
    test('shows character count when >80% of limit', () => {
      render(<ChatInputBar onSend={() => {}} maxLength={10} />);
      fireEvent.change(screen.getByTestId('chat-input-textarea'), {
        target: { value: 'abcdefghi' },
      }); // 9 chars = 90%
      expect(screen.getByText(/9/)).toBeInTheDocument();
    });

    test('blocks send when over limit', () => {
      const onSend = vi.fn();
      render(<ChatInputBar onSend={onSend} maxLength={5} />);
      fireEvent.change(screen.getByTestId('chat-input-textarea'), {
        target: { value: 'abcdefgh' },
      });
      fireEvent.click(screen.getByLabelText('Send message'));
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  // ─── ariaLabel ───────────────────────────────────────────────────

  describe('ariaLabel', () => {
    test('uses custom aria-label when provided', () => {
      render(<ChatInputBar onSend={() => {}} ariaLabel="Ask about this project" />);
      expect(screen.getByLabelText('Ask about this project')).toBeInTheDocument();
    });

    test('defaults to "Message input" aria-label', () => {
      render(<ChatInputBar onSend={() => {}} />);
      expect(screen.getByLabelText('Message input')).toBeInTheDocument();
    });
  });

  // ─── Streaming stop button ───────────────────────────────────────

  describe('streaming', () => {
    test('shows stop button when streaming', () => {
      render(<ChatInputBar onSend={() => {}} isStreaming />);
      expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();
    });

    test('calls onStop when stop button clicked', () => {
      const onStop = vi.fn();
      render(<ChatInputBar onSend={() => {}} isStreaming onStop={onStop} />);
      fireEvent.click(screen.getByLabelText('Stop generating'));
      expect(onStop).toHaveBeenCalledOnce();
    });
  });

  // ─── Disabled state explanations ─────────────────────────────────

  describe('disabledReason placeholders', () => {
    test('shows "Connecting..." when connecting', () => {
      render(<ChatInputBar onSend={() => {}} disabled disabledReason="connecting" />);
      expect(screen.getByPlaceholderText('Connecting...')).toBeInTheDocument();
    });

    test('shows "Waiting for your input above..." when widget-pending', () => {
      render(<ChatInputBar onSend={() => {}} disabled disabledReason="widget-pending" />);
      expect(screen.getByPlaceholderText('Waiting for your input above...')).toBeInTheDocument();
    });

    test('shows "Thinking..." when streaming', () => {
      render(<ChatInputBar onSend={() => {}} disabled disabledReason="streaming" />);
      expect(screen.getByPlaceholderText('Thinking...')).toBeInTheDocument();
    });
  });

  // ─── Keyboard handling ───────────────────────────────────────────

  describe('keyboard', () => {
    test('sends on Enter', () => {
      const onSend = vi.fn();
      render(<ChatInputBar onSend={onSend} />);
      const textarea = screen.getByTestId('chat-input-textarea');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      expect(onSend).toHaveBeenCalledWith('Hello', []);
    });

    test('does not send on Shift+Enter', () => {
      const onSend = vi.fn();
      render(<ChatInputBar onSend={onSend} />);
      const textarea = screen.getByTestId('chat-input-textarea');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  // ─── File attachments ────────────────────────────────────────────

  describe('file attachments', () => {
    test('supports selecting multiple files in one pick', async () => {
      const user = userEvent.setup();
      render(<ChatInputBar onSend={() => {}} />);

      const fileInput = screen.getByTestId('chat-input-file-input');
      const fileOne = new File(['alpha'], 'alpha.md', { type: 'text/markdown' });
      const fileTwo = new File(['beta'], 'beta.pdf', { type: 'application/pdf' });

      await user.upload(fileInput, [fileOne, fileTwo]);

      expect(fileInput).toHaveAttribute('multiple');
      expect(screen.getByText('alpha.md')).toBeInTheDocument();
      expect(screen.getByText('beta.pdf')).toBeInTheDocument();
    });

    test('keeps typed text and accumulates files across multiple picks', async () => {
      const user = userEvent.setup();
      render(<ChatInputBar onSend={() => {}} />);

      const textarea = screen.getByTestId('chat-input-textarea');
      const fileInput = screen.getByTestId('chat-input-file-input');
      const firstFile = new File(['first'], 'first.md', { type: 'text/markdown' });
      const secondFile = new File(['second'], 'second.md', { type: 'text/markdown' });

      await user.type(textarea, 'Please use these files');
      await user.upload(fileInput, firstFile);
      await user.upload(fileInput, secondFile);

      expect(textarea).toHaveValue('Please use these files');
      expect(screen.getByText('first.md')).toBeInTheDocument();
      expect(screen.getByText('second.md')).toBeInTheDocument();
    });

    test('sends all selected files with the message', async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<ChatInputBar onSend={onSend} />);

      const textarea = screen.getByTestId('chat-input-textarea');
      const fileInput = screen.getByTestId('chat-input-file-input');
      const firstFile = new File(['first'], 'first.md', { type: 'text/markdown' });
      const secondFile = new File(['second'], 'second.pdf', { type: 'application/pdf' });

      await user.type(textarea, 'Build from these');
      await user.upload(fileInput, [firstFile, secondFile]);
      await user.click(screen.getByLabelText('Send message'));

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Build from these', [firstFile, secondFile]);
    });

    test('allows sending when files are attached even without text', async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<ChatInputBar onSend={onSend} />);

      const fileInput = screen.getByTestId('chat-input-file-input');
      const brief = new File(['brief'], 'brief.md', { type: 'text/markdown' });

      await user.upload(fileInput, brief);
      await user.click(screen.getByLabelText('Send message'));

      expect(onSend).toHaveBeenCalledWith('', [brief]);
    });
  });

  describe('controlled attachments', () => {
    test('enables send for ready attachment-only messages', async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(
        <ChatInputBar
          onSend={onSend}
          attachments={[
            {
              id: 'att-1',
              name: 'brief.md',
              size: 1024,
              mediaType: 'text/markdown',
              status: 'ready',
            },
          ]}
        />,
      );

      expect(
        screen.getByText('Your attachments are ready. You can send without adding more text.'),
      ).toBeInTheDocument();

      await user.click(screen.getByLabelText('Send message'));
      expect(onSend).toHaveBeenCalledWith('', []);
    });

    test('keeps send disabled while controlled attachments are processing', () => {
      render(
        <ChatInputBar
          onSend={() => {}}
          attachments={[
            {
              id: 'att-2',
              name: 'large.pdf',
              size: 6_000_000,
              mediaType: 'application/pdf',
              status: 'processing',
              detail: 'Scanning and extracting content...',
            },
          ]}
        />,
      );

      expect(screen.getByLabelText('Send message')).toBeDisabled();
      expect(
        screen.getByText("Preparing attachments. You can send when they're ready."),
      ).toBeInTheDocument();
    });

    test('calls controlled attachment callbacks', async () => {
      const user = userEvent.setup();
      const onAttachFiles = vi.fn();
      const onRemoveAttachment = vi.fn();
      render(
        <ChatInputBar
          onSend={() => {}}
          attachments={[
            {
              id: 'att-3',
              name: 'diagram.png',
              size: 2048,
              mediaType: 'image/png',
              status: 'ready',
            },
          ]}
          onAttachFiles={onAttachFiles}
          onRemoveAttachment={onRemoveAttachment}
        />,
      );

      const fileInput = screen.getByTestId('chat-input-file-input');
      const spec = new File(['spec'], 'spec.pdf', { type: 'application/pdf' });

      await user.upload(fileInput, spec);
      expect(onAttachFiles).toHaveBeenCalledWith([spec]);

      await user.click(screen.getByLabelText('Remove diagram.png'));
      expect(onRemoveAttachment).toHaveBeenCalledWith('att-3');
    });
  });
});
