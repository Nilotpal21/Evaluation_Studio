import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockParams, mockSearchParams, translationFns, runtimeConfig } = vi.hoisted(() => {
  const mockParams = { projectId: 'proj-123' };
  const mockSearchParams = new URLSearchParams();
  const translations: Record<string, string> = {
    'preview.project.widget_not_configured': 'Widget not configured',
    'preview.project.failed_sdk_token': 'Failed to fetch preview token',
    'preview.project.failed_to_connect': 'Failed to connect to runtime',
    'preview.project.agent_preview': 'Agent Preview',
    'preview.project.live_preview': 'Live preview of your agent widget',
    'preview.project.project_id_label': 'Project ID:',
    'preview.project.session_id_label': 'Session ID:',
    'preview.project.not_connected': 'Not connected',
    'preview.project.your_website_content': 'Your Website Content',
    'preview.project.website_preview_description':
      'This is a preview of how the chat widget will appear on your website. The widget is displayed in the bottom-right corner.',
    'preview.project.share_url_hint':
      'Share this URL with users to let them interact with your agent:',
    'preview.project.chat_preview_unavailable': 'Chat preview unavailable',
    'preview.project.chat_label': 'Chat',
    'preview.connected': 'Connected',
    'preview.disconnected': 'Disconnected',
    'preview.end_session': 'End Session',
    'preview.session_ended_message': 'Session ended',
    'preview.attach_file': 'Attach file',
    'preview.send_button': 'Send',
    'preview.pending_files': 'Pending files',
    'preview.upload_failed': 'Upload failed: {message}',
    'preview.attachments_only_message': '{count} attachment(s)',
    'preview.upload_session_not_ready': 'Upload session not ready',
  };

  const interpolate = (template: string, values?: Record<string, unknown>) =>
    template.replace(/\{(\w+)\}/g, (_match, key) =>
      values?.[key] === undefined ? `{${key}}` : String(values[key]),
    );

  const makeTranslator = (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    interpolate(translations[`${namespace}.${key}`] ?? key, values);

  return {
    mockParams,
    mockSearchParams,
    translationFns: {
      'preview.project': makeTranslator('preview.project'),
      preview: makeTranslator('preview'),
    },
    runtimeConfig: {
      runtimeUrl: 'http://localhost:3112',
      sdkWsUrl: 'ws://localhost:3112/sdk',
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/',
  useParams: () => mockParams,
}));

vi.mock('next-intl', () => ({
  useTranslations: (namespace: 'preview.project' | 'preview') =>
    translationFns[namespace] ?? ((key: string) => key),
}));

const apiFetchMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/contexts/RuntimeConfigContext', () => ({
  useRuntimeConfig: () => runtimeConfig,
}));

vi.mock('@/components/auth-profiles/BatchConsentGate', () => ({
  BatchConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/preview/PreviewMessageList', () => ({
  PreviewMessageList: ({ messages }: { messages: Array<{ id: string; content: string }> }) => (
    <div data-testid="preview-message-list">
      {messages.map((message) => (
        <div key={message.id}>{message.content}</div>
      ))}
    </div>
  ),
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  protocols: string | string[] | undefined;
  readyState = MockWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  emit(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const OriginalWebSocket = globalThis.WebSocket;
let mockSocket: MockWebSocket | null = null;

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe('project preview session closure', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/projects/proj-123') {
        return Promise.resolve(
          jsonResponse({
            success: true,
            project: { name: 'TravelDesk Supervisor' },
          }),
        );
      }

      if (path === '/api/sdk/widget/proj-123') {
        return Promise.resolve(
          jsonResponse({
            mode: 'chat',
            position: 'bottom-right',
            theme: {
              primaryColor: '#2563eb',
              fontFamily: 'Inter',
            },
            welcomeMessage: 'Welcome! I can help you travel.',
            placeholderText: 'Type a message...',
            chatEnabled: true,
            voiceEnabled: false,
            showActivityUpdates: true,
          }),
        );
      }

      if (path === '/api/sdk/preview-token') {
        return Promise.resolve(jsonResponse({ sdkToken: 'sdk-token-123' }));
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    mockSocket = null;
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      class extends MockWebSocket {
        static OPEN = MockWebSocket.OPEN;
        static CLOSED = MockWebSocket.CLOSED;

        constructor(url: string | URL, protocols?: string | string[]) {
          super(typeof url === 'string' ? url : url.toString(), protocols);
          mockSocket = this;
        }
      } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    mockSocket = null;
  });

  it('sends end_session and swaps the composer for the ended-state message', async () => {
    const { default: ProjectPreviewPage } = await import('@/app/preview/[projectId]/page');

    render(<ProjectPreviewPage />);

    await waitFor(() => {
      expect(mockSocket).not.toBeNull();
    });

    act(() => {
      mockSocket?.emit({ type: 'session_start', sessionId: 'sess-123' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('preview-chat-composer')).toBeInTheDocument();
      expect(screen.getByTitle('End Session')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('End Session'));

    expect(mockSocket?.sent).toContain(JSON.stringify({ type: 'end_session' }));

    act(() => {
      mockSocket?.emit({ type: 'session_ended' });
    });

    await waitFor(() => {
      expect(screen.getByText('Session ended')).toBeInTheDocument();
      expect(screen.queryByTestId('preview-chat-composer')).not.toBeInTheDocument();
      expect(screen.queryByTitle('End Session')).not.toBeInTheDocument();
    });
  });
});
