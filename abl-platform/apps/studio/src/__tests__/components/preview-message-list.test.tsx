import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewMessageList } from '@/components/preview/PreviewMessageList';
import type { PreviewChatMessage } from '@/components/preview/preview-chat-utils';

describe('PreviewMessageList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders assistant rich content and action buttons', () => {
    const onAction = vi.fn();
    const messages: PreviewChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: new Date('2026-03-31T10:00:00.000Z'),
        richContent: {
          quick_replies: [
            { id: 'qr-1', label: '3 nights' },
            { id: 'qr-2', label: '5 nights' },
          ],
        },
        actions: {
          renderId: 'render-456',
          elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
        },
      },
    ];

    render(<PreviewMessageList messages={messages} isTyping={false} onAction={onAction} />);

    expect(screen.getByText('3 nights')).toBeInTheDocument();
    expect(screen.getByText('5 nights')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onAction).toHaveBeenCalledWith('approve', 'yes', { renderId: 'render-456' });
  });

  it('submits action set form data with the render id', () => {
    const onAction = vi.fn();
    const messages: PreviewChatMessage[] = [
      {
        id: 'assistant-2',
        role: 'assistant',
        content: '',
        timestamp: new Date('2026-03-31T10:00:00.000Z'),
        actions: {
          renderId: 'render-form-1',
          submit_id: 'route_agent',
          submit_label: 'Route',
          elements: [
            {
              id: 'agent',
              type: 'select',
              label: 'Agent',
              required: true,
              options: [
                { id: 'agent_a', label: 'Agent A' },
                { id: 'agent_b', label: 'Agent B' },
              ],
            },
            {
              id: 'note',
              type: 'input',
              label: 'Note',
              placeholder: 'Reason',
            },
          ],
        },
      },
    ];

    render(<PreviewMessageList messages={messages} isTyping={false} onAction={onAction} />);

    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'agent_b' } });
    fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'Need support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Route' }));

    const formData = { agent: 'agent_b', note: 'Need support' };
    expect(onAction).toHaveBeenCalledWith('route_agent', JSON.stringify(formData), {
      renderId: 'render-form-1',
      formData,
    });
  });

  it('renders thought messages separately from assistant bubbles', () => {
    const messages: PreviewChatMessage[] = [
      {
        id: 'thought-1',
        role: 'thought',
        content: 'Checking room availability before answering.',
        timestamp: new Date('2026-03-31T10:00:00.000Z'),
        metadata: {
          toolName: 'availability_lookup',
        },
      },
    ];

    render(<PreviewMessageList messages={messages} isTyping={false} />);

    expect(screen.getByText('availability_lookup')).toBeInTheDocument();
    expect(screen.getByText('Checking room availability before answering.')).toBeInTheDocument();
  });

  it('renders auth challenges and sends cancelled responses', () => {
    const onAuthResponse = vi.fn();
    const messages: PreviewChatMessage[] = [
      {
        id: 'auth-1',
        role: 'system',
        content: 'Authorize Google to continue',
        timestamp: new Date('2026-03-31T10:00:00.000Z'),
        authChallenge: {
          type: 'auth_challenge',
          code: 'AUTH_JIT_REQUIRED',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          authType: 'oauth2',
          authUrl: 'https://accounts.google.com/o/oauth2/auth',
          profileId: 'google-creds',
          profileName: 'Google',
          prompt: 'Authorize Google to continue',
          timeoutMs: 600000,
        },
      },
    ];

    render(
      <PreviewMessageList messages={messages} isTyping={false} onAuthResponse={onAuthResponse} />,
    );

    expect(screen.getByTestId('preview-auth-challenge')).toBeInTheDocument();
    expect(screen.getByText('Authorize Google to continue')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel$/ }));
    expect(onAuthResponse).toHaveBeenCalledWith('tool-1', 'cancelled');
  });

  it('completes auth challenges when the popup callback posts oauth_complete', async () => {
    const onAuthResponse = vi.fn();
    const popup = { closed: false, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    const messages: PreviewChatMessage[] = [
      {
        id: 'auth-2',
        role: 'system',
        content: 'Authorize Google to continue',
        timestamp: new Date('2026-03-31T10:00:00.000Z'),
        authChallenge: {
          type: 'auth_challenge',
          code: 'AUTH_JIT_REQUIRED',
          sessionId: 'session-1',
          toolCallId: 'tool-2',
          authType: 'oauth2',
          authUrl:
            'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback',
          profileId: 'google-creds',
          profileName: 'Google',
          prompt: 'Authorize Google to continue',
          timeoutMs: 600000,
        },
      },
    ];

    render(
      <PreviewMessageList messages={messages} isTyping={false} onAuthResponse={onAuthResponse} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Authorize$/ }));

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: popup as unknown as MessageEventSource,
        data: {
          type: 'oauth_complete',
          success: true,
        },
      }),
    );

    await waitFor(() => {
      expect(onAuthResponse).toHaveBeenCalledWith('tool-2', 'completed');
    });
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByText('Authorization completed')).toBeInTheDocument();
  });
});
