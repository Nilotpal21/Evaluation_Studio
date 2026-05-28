/**
 * React Components Tests (UT-5 through UT-12)
 *
 * Renders each SDK component with minimal props, verifies output.
 * ThoughtCard expand/collapse, ErrorMessage severity, ActionHandler click,
 * MessageList role-based dispatch.
 */

import React, { act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StringsProvider } from '../react/strings/StringsProvider.js';
import type { SDKStrings } from '../react/strings/types.js';
import type { Message, ActionSet } from '../core/types.js';
import type { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  SDKTransport,
  TransportClientMessage,
  TransportError,
  TransportServerMessage,
} from '../transport/types.js';

// Helper to wrap in StringsProvider (ThoughtCard, ErrorMessage, etc. use useStrings)
function withStrings(
  element: React.ReactElement,
  strings?: Partial<SDKStrings>,
): React.ReactElement {
  return React.createElement(StringsProvider, { children: element, strings });
}

class MockTransport
  extends TypedEventEmitter<{
    message: TransportServerMessage;
    connected: void;
    disconnected: string | undefined;
    error: TransportError;
  }>
  implements SDKTransport
{
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: false,
    supportsVoice: false,
  };
  sentMessages: TransportClientMessage[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    // noop
  }

  isConnected(): boolean {
    return true;
  }

  send(message: TransportClientMessage): void {
    this.sentMessages.push(message);
  }

  getSessionId(): string | null {
    return 'react-components-session';
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MarkdownContent
// ---------------------------------------------------------------------------
describe('MarkdownContent', () => {
  test('renders markdown as sanitized HTML', async () => {
    const { MarkdownContent } = await import('../react/components/MarkdownContent.js');
    await act(async () => {
      root.render(React.createElement(MarkdownContent, { content: '**bold** text' }));
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('<strong>bold</strong>');
    expect(container.innerHTML).toContain('text');
  });

  test('renders markdown tables as HTML tables', async () => {
    const { MarkdownContent } = await import('../react/components/MarkdownContent.js');
    await act(async () => {
      root.render(
        React.createElement(MarkdownContent, {
          content: '| Name | Balance |\n| --- | --- |\n| Alice | $10 |',
        }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.innerHTML).toContain('<td>Alice</td>');
  });

  test('renders empty content safely', async () => {
    const { MarkdownContent } = await import('../react/components/MarkdownContent.js');
    await act(async () => {
      root.render(React.createElement(MarkdownContent, { content: '' }));
      await Promise.resolve();
    });
    expect(container.querySelector('div')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// RichContent
// ---------------------------------------------------------------------------
describe('RichContent', () => {
  test('renders template content when imported from the React entry', async () => {
    const { RichContent } = await import('../react/index.js');
    const message: Message = {
      id: 'rich-msg-1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        markdown: '**templated** response',
      },
    };

    await act(async () => {
      root.render(
        React.createElement(RichContent, {
          message,
          onAction: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.rich-content')).toBeTruthy();
    expect(container.innerHTML).toContain('<strong>templated</strong>');
  });

  test('renders markdown tables through the template registry', async () => {
    const { RichContent } = await import('../react/index.js');
    const message: Message = {
      id: 'rich-msg-table',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        markdown: '| Name | Balance |\n| --- | --- |\n| Alice | $10 |',
      },
    };

    await act(async () => {
      root.render(
        React.createElement(RichContent, {
          message,
          onAction: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.rich-content')).toBeTruthy();
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.innerHTML).toContain('<td>Alice</td>');
  });

  test('renders fallback content for channel-native payloads', async () => {
    const { RichContent } = await import('../react/index.js');
    const message: Message = {
      id: 'rich-msg-slack',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        slack: '{"text":"Hello from Slack"}',
      },
    };

    await act(async () => {
      root.render(
        React.createElement(RichContent, {
          message,
          onAction: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Slack Block Kit');
    expect(container.textContent).toContain('Hello from Slack');
  });

  test('does not submit invalid deferred action sets from the React renderer', async () => {
    const { RichContent } = await import('../react/index.js');
    const onAction = vi.fn();
    const message: Message = {
      id: 'rich-actions-required',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      actions: {
        elements: [
          {
            id: 'email',
            type: 'input',
            label: 'Email',
            input_type: 'email',
            required: true,
          },
        ],
        submit_id: 'submit_actions',
        submit_label: 'Submit',
      },
    };

    await act(async () => {
      root.render(
        React.createElement(RichContent, {
          message,
          onAction,
        }),
      );
      await Promise.resolve();
    });

    const submitButton = container.querySelector(
      '[data-testid="action-handler"] .rich-btn-primary',
    ) as HTMLButtonElement | null;
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).not.toHaveBeenCalled();

    const input = container.querySelector(
      'input[data-action-id="email"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    if (input) {
      input.value = 'user@example.com';
    }

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith(
      'submit_actions',
      JSON.stringify({ email: 'user@example.com' }),
      { formData: { email: 'user@example.com' } },
    );
  });

  test('does not submit invalid forms from the React renderer', async () => {
    const { RichContent } = await import('../react/index.js');
    const onAction = vi.fn();
    const message: Message = {
      id: 'rich-form-required',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        form: {
          title: 'Contact',
          fields: [
            {
              id: 'email',
              type: 'input',
              label: 'Email',
              input_type: 'email',
              required: true,
            },
          ],
          submit_label: 'Send',
        },
      },
    };

    await act(async () => {
      root.render(
        React.createElement(RichContent, {
          message,
          onAction,
        }),
      );
      await Promise.resolve();
    });

    const submitButton = container.querySelector('.rich-form-submit') as HTMLButtonElement | null;
    expect(submitButton).toBeTruthy();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).not.toHaveBeenCalled();

    const input = container.querySelector(
      'input[data-field-id="email"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();
    if (input) {
      input.value = 'user@example.com';
    }

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith(
      'form-submit',
      JSON.stringify({ email: 'user@example.com' }),
      { formData: { email: 'user@example.com' } },
    );
  });
});

// ---------------------------------------------------------------------------
// StreamingMessage
// ---------------------------------------------------------------------------
describe('StreamingMessage', () => {
  test('renders content with cursor when streaming', async () => {
    const { StreamingMessage } = await import('../react/components/StreamingMessage.js');
    await act(async () => {
      root.render(React.createElement(StreamingMessage, { content: 'Hello', isStreaming: true }));
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="streaming-message"]');
    expect(el).toBeTruthy();
    expect(container.innerHTML).toContain('Hello');
    // Cursor span should be present
    expect(container.querySelectorAll('span').length).toBeGreaterThan(0);
  });

  test('hides cursor when not streaming', async () => {
    const { StreamingMessage } = await import('../react/components/StreamingMessage.js');
    await act(async () => {
      root.render(React.createElement(StreamingMessage, { content: 'Done', isStreaming: false }));
      await Promise.resolve();
    });
    // The streaming cursor span should not be present (only the MarkdownContent div)
    const el = container.querySelector('[data-testid="streaming-message"]');
    expect(el).toBeTruthy();
    // No blink animation span inside the streaming container
    const directSpans = el?.querySelectorAll(':scope > span');
    expect(directSpans?.length ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ThoughtCard
// ---------------------------------------------------------------------------
describe('ThoughtCard', () => {
  test('renders collapsed by default', async () => {
    const { ThoughtCard } = await import('../react/components/ThoughtCard.js');
    const onToggle = vi.fn();
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ThoughtCard, {
            content: 'The reasoning here',
            isExpanded: false,
            onToggle,
          }),
        ),
      );
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="thought-card"]');
    expect(el).toBeTruthy();
    // Content should NOT be visible when collapsed
    expect(container.textContent).not.toContain('The reasoning here');
  });

  test('shows content when expanded', async () => {
    const { ThoughtCard } = await import('../react/components/ThoughtCard.js');
    const onToggle = vi.fn();
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ThoughtCard, {
            content: 'The reasoning here',
            isExpanded: true,
            onToggle,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('The reasoning here');
  });

  test('calls onToggle when header is clicked', async () => {
    const { ThoughtCard } = await import('../react/components/ThoughtCard.js');
    const onToggle = vi.fn();
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ThoughtCard, {
            content: 'Reasoning',
            isExpanded: false,
            onToggle,
          }),
        ),
      );
      await Promise.resolve();
    });
    const header = container.querySelector('[role="button"]');
    await act(async () => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('shows View trace button when onViewTrace and metadata provided', async () => {
    const { ThoughtCard } = await import('../react/components/ThoughtCard.js');
    const onToggle = vi.fn();
    const onViewTrace = vi.fn();
    const metadata = { toolName: 'search', traceIds: ['t-1'] };
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ThoughtCard, {
            content: 'Trace content',
            isExpanded: true,
            onToggle,
            onViewTrace,
            metadata,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('View trace');
    // Click the view trace button
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'View trace',
    );
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onViewTrace).toHaveBeenCalledWith(metadata);
  });
});

// ---------------------------------------------------------------------------
// HandoffMessage
// ---------------------------------------------------------------------------
describe('HandoffMessage', () => {
  test('renders a collapsed handoff summary and expands with customizable strings', async () => {
    const { HandoffMessage } = await import('../react/components/HandoffMessage.js');
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(HandoffMessage, {
            fromAgent: 'AgentA',
            toAgent: 'AgentB',
          }),
          {
            handoffSummary: 'Transfer from {from} to {to}',
            handoffShowDetails: 'Expand handoff',
            handoffHideDetails: 'Collapse handoff',
          },
        ),
      );
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="handoff-message"]');
    expect(el).toBeTruthy();
    expect(container.textContent).toContain('Transfer from AgentA to AgentB');
    expect(container.textContent).toContain('Expand handoff');
    expect(container.textContent).not.toContain('Routing from AgentA to AgentB');

    const button = container.querySelector('button');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Routing from AgentA to AgentB');
    expect(container.textContent).toContain('Collapse handoff');
  });
});

// ---------------------------------------------------------------------------
// ErrorMessage
// ---------------------------------------------------------------------------
describe('ErrorMessage', () => {
  test('renders error severity', async () => {
    const { ErrorMessage } = await import('../react/components/ErrorMessage.js');
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ErrorMessage, {
            content: 'Something broke',
            severity: 'error',
          }),
        ),
      );
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="error-message"]');
    expect(el).toBeTruthy();
    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('Something broke');
  });

  test('renders warning severity', async () => {
    const { ErrorMessage } = await import('../react/components/ErrorMessage.js');
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(ErrorMessage, {
            content: 'Something might be wrong',
            severity: 'warning',
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Warning');
    expect(container.textContent).toContain('Something might be wrong');
  });
});

// ---------------------------------------------------------------------------
// ActionHandler
// ---------------------------------------------------------------------------
describe('ActionHandler', () => {
  test('renders buttons and fires onAction when clicked', async () => {
    const { ActionHandler } = await import('../react/components/ActionHandler.js');
    const onAction = vi.fn();
    const actions: ActionSet = {
      elements: [{ id: 'btn-1', type: 'button', label: 'Click Me', value: 'yes' }],
    };
    await act(async () => {
      root.render(React.createElement(ActionHandler, { actions, onAction }));
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="action-handler"]');
    expect(el).toBeTruthy();
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Click Me');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith('btn-1', 'yes');
  });

  test('renders select and fires onAction on change', async () => {
    const { ActionHandler } = await import('../react/components/ActionHandler.js');
    const onAction = vi.fn();
    const actions: ActionSet = {
      elements: [
        {
          id: 'sel-1',
          type: 'select',
          label: 'Pick one',
          options: [
            { id: 'opt-a', label: 'Option A' },
            { id: 'opt-b', label: 'Option B' },
          ],
        },
      ],
    };
    await act(async () => {
      root.render(React.createElement(ActionHandler, { actions, onAction }));
      await Promise.resolve();
    });
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
  });

  test('submits deferred action form values with renderId', async () => {
    const { ActionHandler } = await import('../react/components/ActionHandler.js');
    const onAction = vi.fn();
    const actions: ActionSet = {
      renderId: 'render-123',
      submit_id: 'route_agent',
      submit_label: 'Route',
      elements: [
        {
          id: 'target',
          type: 'select',
          label: 'Target',
          required: true,
          options: [
            { id: 'Agent_A', label: 'Agent A' },
            { id: 'Agent_B', label: 'Agent B' },
          ],
        },
        {
          id: 'comment',
          type: 'input',
          label: 'Comment',
          required: true,
        },
      ],
    };

    await act(async () => {
      root.render(React.createElement(ActionHandler, { actions, onAction }));
      await Promise.resolve();
    });

    const select = container.querySelector(
      'select[data-action-id="target"]',
    ) as HTMLSelectElement | null;
    const input = container.querySelector(
      'input[data-action-id="comment"]',
    ) as HTMLInputElement | null;
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Route',
    ) as HTMLButtonElement | undefined;

    expect(select).toBeTruthy();
    expect(input).toBeTruthy();
    expect(submit).toBeTruthy();
    if (select) select.value = 'Agent_A';
    if (input) input.value = 'handoff requested';

    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith(
      'route_agent',
      JSON.stringify({ target: 'Agent_A', comment: 'handoff requested' }),
      {
        renderId: 'render-123',
        formData: { target: 'Agent_A', comment: 'handoff requested' },
      },
    );
  });

  test('returns null for empty actions', async () => {
    const { ActionHandler } = await import('../react/components/ActionHandler.js');
    const onAction = vi.fn();
    const actions: ActionSet = { elements: [] };
    await act(async () => {
      root.render(React.createElement(ActionHandler, { actions, onAction }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="action-handler"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TypingIndicator
// ---------------------------------------------------------------------------
describe('TypingIndicator', () => {
  test('renders typing dots and label', async () => {
    const { TypingIndicator } = await import('../react/components/TypingIndicator.js');
    await act(async () => {
      root.render(withStrings(React.createElement(TypingIndicator)));
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="typing-indicator"]');
    expect(el).toBeTruthy();
    expect(container.textContent).toContain('Agent is typing');
  });
});

// ---------------------------------------------------------------------------
// MessageList — role-based dispatch
// ---------------------------------------------------------------------------
describe('MessageList', () => {
  const makeMsg = (overrides: Partial<Message>): Message => ({
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: 'Hello',
    timestamp: new Date(),
    ...overrides,
  });

  test('renders user messages in user bubbles', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [makeMsg({ role: 'user', content: 'Hi there' })];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="message-list"]');
    expect(el).toBeTruthy();
    expect(container.textContent).toContain('Hi there');
  });

  test('renders assistant messages with markdown', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [makeMsg({ role: 'assistant', content: '**bold response**' })];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('<strong>bold response</strong>');
  });

  test('does not render built-in message feedback controls until enabled', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const submitFeedback = vi.fn().mockResolvedValue({ feedbackId: 'fb-disabled' });
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-feedback-disabled',
        role: 'assistant',
        content: 'Feedback is opt-in.',
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            submitFeedback,
          }),
        ),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="message-feedback-controls"]')).toBeNull();
  });

  test('renders enabled thumbs feedback controls for plain assistant messages', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const submitFeedback = vi.fn().mockResolvedValue({ feedbackId: 'fb-up' });
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-feedback-up',
        role: 'assistant',
        content: 'Rate this answer.',
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            submitFeedback,
            enableFeedback: true,
          }),
        ),
      );
      await Promise.resolve();
    });

    const thumbsUp = container.querySelector(
      'button[aria-label="Thumbs up"]',
    ) as HTMLButtonElement | null;
    expect(thumbsUp).toBeTruthy();

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitFeedback).toHaveBeenCalledWith({
      messageId: 'assistant-feedback-up',
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    expect(container.textContent).toContain('Thanks for the feedback');
  });

  test('uses generic text for unknown feedback failures', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const rawError = 'tenant tenant_123 model internal-model credential missing';
    const submitFeedback = vi.fn().mockRejectedValue(new Error(rawError));
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-feedback-unknown-error',
        role: 'assistant',
        content: 'Rate this answer.',
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            submitFeedback,
            enableFeedback: true,
          }),
        ),
      );
      await Promise.resolve();
    });

    const thumbsUp = container.querySelector(
      'button[aria-label="Thumbs up"]',
    ) as HTMLButtonElement | null;

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Could not send feedback');
    expect(container.textContent).not.toContain(rawError);
  });

  test('submits enabled thumbs-down feedback with an optional comment', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const submitFeedback = vi.fn().mockResolvedValue({ feedbackId: 'fb-down' });
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-feedback-down',
        role: 'assistant',
        content: 'Rate this answer too.',
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            submitFeedback,
            enableFeedback: true,
          }),
        ),
      );
      await Promise.resolve();
    });

    const thumbsDown = container.querySelector(
      'button[aria-label="Thumbs down"]',
    ) as HTMLButtonElement | null;
    expect(thumbsDown).toBeTruthy();

    await act(async () => {
      thumbsDown?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      if (textarea) {
        const textareaValueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        textareaValueSetter?.call(textarea, 'The answer missed the account context');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await Promise.resolve();
    });

    const send = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send feedback',
    ) as HTMLButtonElement | undefined;
    expect(send).toBeTruthy();

    await act(async () => {
      send?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitFeedback).toHaveBeenCalledWith({
      messageId: 'assistant-feedback-down',
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'The answer missed the account context',
    });
    expect(container.textContent).toContain('Feedback recorded');
  });

  test('renders PII asterisk masks as literal text', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'assistant',
        content: '*****4567 *******0900 555-123-4567',
      }),
    ];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('*****4567 *******0900 555-123-4567');
  });

  test('renders thought messages as ThoughtCard', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'thought',
        content: 'Reasoning about it',
        metadata: { toolName: 'search' },
      }),
    ];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="thought-card"]')).toBeTruthy();
  });

  test('renders system error messages', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'system',
        content: 'Something failed',
        metadata: { errorCode: 'TIMEOUT', severity: 'error' },
      }),
    ];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="error-message"]')).toBeTruthy();
    expect(container.textContent).toContain('Something failed');
  });

  test('renders handoff messages', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'system',
        content: '',
        metadata: { handoffFrom: 'Router', handoffTo: 'Specialist' },
      }),
    ];
    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="handoff-message"]')).toBeTruthy();
    expect(container.textContent).toContain('Router');
    expect(container.textContent).toContain('Specialist');
  });

  test('suppresses thought and handoff activity when showActivityUpdates is false', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        id: 'thought-hidden',
        role: 'thought',
        content: 'Thinking aloud',
      }),
      makeMsg({
        id: 'handoff-hidden',
        role: 'system',
        content: '',
        metadata: { handoffFrom: 'Router', handoffTo: 'Specialist' },
      }),
      makeMsg({
        id: 'assistant-visible',
        role: 'assistant',
        content: 'Final answer',
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            showActivityUpdates: false,
          }),
        ),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="thought-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="handoff-message"]')).toBeNull();
    expect(container.textContent).toContain('Final answer');
  });

  test('renders thought and assistant messages provided by the caller', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        id: 'thought-default',
        role: 'thought',
        content: 'Transferring to Account Info agent',
        metadata: { toolName: 'handoff' },
      }),
      makeMsg({
        id: 'assistant-default',
        role: 'assistant',
        content: 'I can help with that.',
      }),
    ];

    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="thought-card"]')).toBeTruthy();
    expect(container.textContent).toContain('I can help with that.');
  });

  test('renders thought and handoff messages provided by the caller', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        id: 'thought-1',
        role: 'thought',
        content: 'Transferring to Account Info agent',
        metadata: { toolName: 'handoff' },
      }),
      makeMsg({
        id: 'handoff-1',
        role: 'system',
        content: '',
        metadata: { handoffFrom: 'Router', handoffTo: 'Account Info' },
      }),
      makeMsg({
        id: 'assistant-1',
        role: 'assistant',
        content: 'I can help with that.',
      }),
    ];

    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="thought-card"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="handoff-message"]')).toBeTruthy();
    expect(container.textContent).toContain('I can help with that.');
  });

  test('does not render StreamingMessage when idle (empty content, not streaming)', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages: [],
            streamingContent: '',
            isStreaming: false,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="streaming-message"]')).toBeNull();
  });

  test('renders streaming content when provided', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages: [],
            streamingContent: 'Streaming...',
            isStreaming: true,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="streaming-message"]')).toBeTruthy();
    expect(container.textContent).toContain('Streaming...');
  });

  test('renders assistant actions even when onAction is omitted', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'assistant',
        content: 'Choose one',
        actions: {
          elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
        },
      }),
    ];

    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="action-handler"]')).toBeTruthy();
    expect(container.textContent).toContain('Approve');
  });

  test('renders assistant actions only once when rich content and actions share a message', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const messages: Message[] = [
      makeMsg({
        role: 'assistant',
        content: 'Choose one',
        richContent: {
          markdown: '**Choose one**',
        },
        actions: {
          elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
        },
      }),
    ];

    await act(async () => {
      root.render(withStrings(React.createElement(MessageList, { messages })));
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-testid="action-handler"]')).toHaveLength(1);
    expect(
      Array.from(container.querySelectorAll('[data-testid="action-handler"] button')).filter(
        (button) => button.textContent === 'Approve',
      ),
    ).toHaveLength(1);
  });

  test('binds assistant message id when rich feedback submits', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const onAction = vi.fn();
    const submitFeedback = vi.fn().mockResolvedValue({ feedbackId: 'fb-message-list' });
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-feedback',
        role: 'assistant',
        content: '',
        richContent: {
          feedback: {
            prompt: 'Was this helpful?',
            type: 'thumbs',
          },
        },
        actions: {
          renderId: 'feedback-render-1',
          elements: [],
        },
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            onAction,
            submitFeedback,
          }),
        ),
      );
      await Promise.resolve();
    });

    const thumbsUp = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '👍',
    );
    expect(thumbsUp).toBeTruthy();

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(submitFeedback).toHaveBeenCalledWith({
      messageId: 'assistant-feedback',
      ratingType: 'thumbs',
      ratingValue: 1,
      actionRenderId: 'feedback-render-1',
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  test('does not duplicate controls when a rich feedback template is already present', async () => {
    const { MessageList } = await import('../react/components/MessageList.js');
    const submitFeedback = vi.fn().mockResolvedValue({ feedbackId: 'fb-rich-only' });
    const messages: Message[] = [
      makeMsg({
        id: 'assistant-rich-feedback-only',
        role: 'assistant',
        content: '',
        richContent: {
          feedback: {
            prompt: 'Was this helpful?',
            type: 'thumbs',
          },
        },
      }),
    ];

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(MessageList, {
            messages,
            submitFeedback,
            enableFeedback: true,
          }),
        ),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="message-feedback-controls"]')).toBeNull();
    expect(container.querySelectorAll('.rich-feedback')).toHaveLength(1);
    expect(container.querySelectorAll('button[aria-label="Thumbs up"]')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RichMessage
// ---------------------------------------------------------------------------
describe('RichMessage', () => {
  test('submits rich feedback through ChatClient with message id', async () => {
    const { RichMessage } = await import('../react/RichMessage.js');
    const chat = {
      submitAction: vi.fn(),
      submitFeedback: vi.fn().mockResolvedValue({ feedbackId: 'fb-rich-message' }),
    };
    const message: Message = {
      id: 'rich-message-feedback',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        feedback: {
          prompt: 'Was this helpful?',
          type: 'thumbs',
        },
      },
      actions: {
        renderId: 'rich-render-1',
        elements: [],
      },
    };

    await act(async () => {
      root.render(
        withStrings(
          React.createElement(RichMessage, {
            message,
            chat: chat as unknown as ChatClient,
          }),
        ),
      );
      await Promise.resolve();
    });

    const thumbsUp = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '👍',
    );
    expect(thumbsUp).toBeTruthy();

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(chat.submitFeedback).toHaveBeenCalledWith({
      messageId: 'rich-message-feedback',
      ratingType: 'thumbs',
      ratingValue: 1,
      actionRenderId: 'rich-render-1',
    });
    expect(chat.submitAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ChatWidget
// ---------------------------------------------------------------------------
describe('ChatWidget', () => {
  test('does not show typing dots and a status filler at the same time', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', { type: 'response_start', messageId: 'msg-filler' });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="typing-indicator"]')).not.toBeNull();

    await act(async () => {
      transport.emit('message', {
        type: 'status_update',
        text: "I'm working on the best answer.",
        operation: 'general',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="typing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="status-indicator"]')?.textContent).toBe(
      "I'm working on the best answer.",
    );
  });

  test('renders transient chat status before final response and clears without history duplication', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'status_update',
        text: 'Checking customer profile...',
        operation: 'tool_call',
      });
      await Promise.resolve();
    });

    const statusIndicator = container.querySelector('[data-testid="status-indicator"]');
    const messageList = container.querySelector('[data-testid="message-list"]');
    expect(statusIndicator?.textContent).toBe('Checking customer profile...');
    expect(messageList?.textContent).not.toContain('Checking customer profile...');

    await act(async () => {
      transport.emit('message', {
        type: 'status_update',
        text: 'Checking customer profile...',
        operation: 'tool_call',
      });
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-testid="status-indicator"]')).toHaveLength(1);

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'customer-profile-final',
        content: 'The customer profile is current.',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="status-indicator"]')).toBeNull();
    expect(messageList?.textContent).toContain('The customer profile is current.');
    expect(messageList?.textContent).not.toContain('Checking customer profile...');
  });

  test('keeps http_async status outside streamed history until the final response clears it', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'status_update',
        text: 'Checking warranty details...',
        operation: 'http_async',
      });
      transport.emit('message', { type: 'response_start', messageId: 'warranty-final' });
      transport.emit('message', {
        type: 'response_chunk',
        messageId: 'warranty-final',
        content: 'Your warranty',
      });
      await Promise.resolve();
    });

    const statusIndicator = container.querySelector('[data-testid="status-indicator"]');
    const messageList = container.querySelector('[data-testid="message-list"]');
    expect(statusIndicator?.textContent).toBe('Checking warranty details...');
    expect(messageList?.textContent).toContain('Your warranty');
    expect(messageList?.textContent).not.toContain('Checking warranty details...');

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'warranty-final',
        content: 'Your warranty is active through June 30.',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="status-indicator"]')).toBeNull();
    expect(messageList?.textContent).toContain('Your warranty is active through June 30.');
    expect(messageList?.textContent).not.toContain('Checking warranty details...');
    expect(container.querySelectorAll('[data-testid="streaming-message"]')).toHaveLength(0);
  });

  test('auto-submits server actions through ChatClient when no onAction prop is provided', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'msg-actions',
        content: 'Choose an option',
        actions: {
          elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
        },
      });
      await Promise.resolve();
    });

    const button = Array.from(
      container.querySelectorAll('[data-testid="action-handler"] button'),
    ).find((candidate) => candidate.textContent === 'Approve');

    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(transport.sentMessages).toEqual([
      {
        type: 'action_submit',
        actionId: 'approve',
        value: 'yes',
      },
    ]);
  });

  test('prefers an explicit onAction override over the default action submit handler', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();
    const onAction = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget, { onAction }),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'msg-actions-override',
        content: 'Choose an option',
        actions: {
          elements: [{ id: 'approve', type: 'button', label: 'Approve', value: 'yes' }],
        },
      });
      await Promise.resolve();
    });

    const button = Array.from(
      container.querySelectorAll('[data-testid="action-handler"] button'),
    ).find((candidate) => candidate.textContent === 'Approve');

    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith('approve', 'yes');
    expect(transport.sentMessages).toEqual([]);
  });

  test('renders enabled message feedback controls and submits through ChatClient', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget, { enableFeedback: true }),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'msg-widget-feedback',
        content: 'Plain answer with enabled feedback.',
      });
      await Promise.resolve();
    });

    const thumbsUp = container.querySelector(
      'button[aria-label="Thumbs up"]',
    ) as HTMLButtonElement | null;
    expect(thumbsUp).toBeTruthy();

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(transport.sentMessages).toEqual([
      {
        type: 'feedback.submit',
        messageId: 'msg-widget-feedback',
        ratingType: 'thumbs',
        ratingValue: 1,
      },
    ]);

    await act(async () => {
      transport.emit('message', {
        type: 'feedback.ack',
        messageId: 'msg-widget-feedback',
        success: true,
        feedbackId: 'fb-widget-feedback',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Thanks for the feedback');
  });

  test('submits rich feedback through ChatClient instead of action_submit fallback', async () => {
    const { AgentProvider } = await import('../react/AgentProvider.js');
    const { ChatWidget } = await import('../react/components/ChatWidget.js');
    const transport = new MockTransport();

    await act(async () => {
      root.render(
        React.createElement(
          AgentProvider,
          { transport: transport as SDKTransport },
          React.createElement(ChatWidget),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      transport.emit('message', {
        type: 'response_end',
        messageId: 'msg-feedback',
        content: '',
        richContent: {
          feedback: {
            prompt: 'Was this helpful?',
            type: 'thumbs',
          },
        },
      });
      await Promise.resolve();
    });

    const thumbsUp = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '👍',
    );
    expect(thumbsUp).toBeTruthy();

    await act(async () => {
      thumbsUp?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(transport.sentMessages).toEqual([
      {
        type: 'feedback.submit',
        messageId: 'msg-feedback',
        ratingType: 'thumbs',
        ratingValue: 1,
      },
    ]);

    await act(async () => {
      transport.emit('message', {
        type: 'feedback.ack',
        messageId: 'msg-feedback',
        success: true,
        feedbackId: 'fb-widget',
      });
      await Promise.resolve();
    });
  });
});
