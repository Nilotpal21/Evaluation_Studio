import { describe, test, expect, vi } from 'vitest';
import type { Message } from '../core/types.js';
import { ChatWidget } from '../ui/ChatWidget.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';

interface StreamingWidgetHarness {
  messagesEl: HTMLElement | null;
  appendToLastMessage: (messageId: string, chunk: string) => void;
  addMessage: (message: Message) => void;
  showError: (message: string) => void;
}

interface RenderWidgetHarness {
  chat: WidgetChatMock | { getMessages: () => Message[] } | null;
  isMinimized: boolean;
  currentMode?: 'chat' | 'voice';
  render: () => void;
  setupEventListeners: () => void;
  setupChatHandlers: () => void;
  invalidateSdkState: () => void;
  open: () => void;
}

type WidgetChatEvent =
  | 'message'
  | 'messagesReplaced'
  | 'messageChunk'
  | 'typing'
  | 'statusUpdate'
  | 'statusClear'
  | 'error';

class WidgetChatMock {
  private messages: Message[];
  private readonly handlers = new Map<WidgetChatEvent, Array<(payload: unknown) => void>>();

  constructor(messages: Message[]) {
    this.messages = messages;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  on(event: WidgetChatEvent, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }

  replaceMessages(messages: Message[]): void {
    this.messages = messages;
    for (const handler of this.handlers.get('messagesReplaced') ?? []) {
      handler({ messages });
    }
  }

  emit(event: WidgetChatEvent, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  listenerCount(event: WidgetChatEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

function createMessage(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    role,
    content,
    timestamp: new Date(),
  };
}

function prepareHarness<T extends HTMLElement>(widget: T): StreamingWidgetHarness {
  const harness = widget as unknown as StreamingWidgetHarness;
  harness.messagesEl = document.createElement('div');
  harness.messagesEl.innerHTML =
    '<div class="message assistant welcome-placeholder">Hello! How can I help you today?</div>';
  return harness;
}

function assertStreamingMessagePreserved(harness: StreamingWidgetHarness): void {
  harness.appendToLastMessage('assistant-1', 'Hello');
  expect(harness.messagesEl?.querySelector('.welcome-placeholder')).toBeNull();
  harness.addMessage(createMessage('user-1', 'user', 'Thanks'));

  const streamingEl = harness.messagesEl?.querySelector(
    '.message.streaming[data-id="assistant-1"]',
  ) as HTMLElement | null;
  expect(streamingEl?.textContent).toBe('Hello');

  harness.appendToLastMessage('assistant-1', ' world');
  expect(streamingEl?.textContent).toBe('Hello world');

  harness.addMessage(createMessage('assistant-1', 'assistant', 'Hello world'));
  expect(harness.messagesEl?.querySelector('.message.streaming[data-id="assistant-1"]')).toBeNull();
}

function assertWelcomeMessageSurvivesRerender(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const welcome = createMessage('welcome-1', 'assistant', 'Hello! How can I help you today?');

  harness.chat = { getMessages: () => [welcome] };
  harness.isMinimized = false;
  harness.currentMode = 'chat';
  harness.render();

  const messages = widget.shadowRoot!.querySelectorAll('.message.assistant');
  expect(messages).toHaveLength(1);
  expect(messages[0].textContent).toBe(welcome.content);
  expect(widget.shadowRoot!.querySelector('.welcome-placeholder')).toBeNull();
}

function assertMessagesReplacedRestoresFreshPlaceholder(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const chat = new WidgetChatMock([createMessage('old-1', 'assistant', 'Old session message')]);

  harness.chat = chat;
  harness.isMinimized = false;
  harness.currentMode = 'chat';
  harness.render();
  harness.setupChatHandlers();

  expect(widget.shadowRoot!.querySelector('.message.assistant')?.textContent).toBe(
    'Old session message',
  );

  chat.replaceMessages([]);

  const messages = widget.shadowRoot!.querySelectorAll('.message.assistant');
  expect(messages).toHaveLength(1);
  expect(messages[0].textContent).toBe('Hello! How can I help you today?');
  expect(messages[0].classList.contains('welcome-placeholder')).toBe(true);
}

function assertChatHandlersAreOwned(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const chat = new WidgetChatMock([createMessage('old-1', 'assistant', 'Old session message')]);

  harness.chat = chat;
  harness.isMinimized = false;
  harness.currentMode = 'chat';
  harness.render();
  harness.setupChatHandlers();
  harness.setupChatHandlers();

  expect(chat.listenerCount('message')).toBe(1);
  expect(chat.listenerCount('messagesReplaced')).toBe(1);
  expect(chat.listenerCount('messageChunk')).toBe(1);
  expect(chat.listenerCount('typing')).toBe(1);
  expect(chat.listenerCount('statusUpdate')).toBe(1);
  expect(chat.listenerCount('statusClear')).toBe(1);
  expect(chat.listenerCount('error')).toBe(1);

  harness.invalidateSdkState();

  expect(chat.listenerCount('message')).toBe(0);
  expect(chat.listenerCount('messagesReplaced')).toBe(0);
  expect(chat.listenerCount('messageChunk')).toBe(0);
  expect(chat.listenerCount('typing')).toBe(0);
  expect(chat.listenerCount('statusUpdate')).toBe(0);
  expect(chat.listenerCount('statusClear')).toBe(0);
  expect(chat.listenerCount('error')).toBe(0);
}

function assertChatStatusRendersInMessages(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const chat = new WidgetChatMock([]);

  harness.chat = chat;
  harness.isMinimized = false;
  harness.currentMode = 'chat';
  harness.render();
  harness.setupChatHandlers();

  chat.emit('statusUpdate', { text: 'Checking account tools...', operation: 'tool' });

  const status = widget.shadowRoot!.querySelector('.status-indicator');
  expect(status?.textContent).toBe('Checking account tools...');
  expect(widget.shadowRoot!.querySelector('.typing-indicator')).toBeNull();
  expect(widget.shadowRoot!.querySelector('.welcome-placeholder')).toBeNull();

  chat.emit('statusClear', undefined);
  expect(widget.shadowRoot!.querySelector('.status-indicator')).toBeNull();
}

function assertHistoryDoesNotLeakIntoUnavailableState(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  harness.chat = {
    getMessages: () => [createMessage('old-1', 'assistant', 'Old session message')],
  };
  harness.isMinimized = false;
  harness.currentMode = 'chat';
  widget.setAttribute('chat-enabled', 'false');

  harness.render();

  expect(widget.shadowRoot!.textContent).toContain('not configured');
  expect(widget.shadowRoot!.textContent).not.toContain('Old session message');
}

function assertInvalidateClearsTransientIndicators(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const messagesEl = document.createElement('div');
  messagesEl.innerHTML =
    '<div class="typing-indicator"></div><div class="status-indicator">Checking tools...</div>';
  (harness as unknown as StreamingWidgetHarness).messagesEl = messagesEl;

  harness.invalidateSdkState();

  expect(messagesEl.querySelector('.typing-indicator')).toBeNull();
  expect(messagesEl.querySelector('.status-indicator')).toBeNull();
}

function assertEventListenersAreBoundOnce(widget: HTMLElement): void {
  const harness = widget as unknown as RenderWidgetHarness;
  const open = vi.fn();

  harness.open = open;
  harness.isMinimized = true;
  harness.render();
  harness.setupEventListeners();
  harness.setupEventListeners();

  (widget.shadowRoot!.querySelector('.launcher') as HTMLButtonElement).click();

  expect(open).toHaveBeenCalledTimes(1);
}

describe('widget streaming message handling', () => {
  test('ChatWidget keeps streamed output when unrelated messages arrive', () => {
    const harness = prepareHarness(new ChatWidget());
    assertStreamingMessagePreserved(harness);
  });

  test('UnifiedWidget keeps streamed output when unrelated messages arrive', () => {
    const harness = prepareHarness(new UnifiedWidget());
    assertStreamingMessagePreserved(harness);
  });

  test('ChatWidget removes welcome placeholder when showing an error', () => {
    const harness = prepareHarness(new ChatWidget());

    harness.showError('The agent returned an empty response.');

    expect(harness.messagesEl?.querySelector('.welcome-placeholder')).toBeNull();
    expect(harness.messagesEl?.querySelector('.message.system')?.textContent).toBe(
      'The agent returned an empty response.',
    );
  });

  test('UnifiedWidget removes welcome placeholder when showing an error', () => {
    const harness = prepareHarness(new UnifiedWidget());

    harness.showError('The agent returned an empty response.');

    expect(harness.messagesEl?.querySelector('.welcome-placeholder')).toBeNull();
    expect(harness.messagesEl?.querySelector('.message.system')?.textContent).toBe(
      'The agent returned an empty response.',
    );
  });

  test('ChatWidget renders chat status updates when typing is suppressed', () => {
    assertChatStatusRendersInMessages(new ChatWidget());
  });

  test('UnifiedWidget renders chat status updates when typing is suppressed', () => {
    assertChatStatusRendersInMessages(new UnifiedWidget());
  });

  test('ChatWidget clears transient indicators when SDK state is invalidated', () => {
    assertInvalidateClearsTransientIndicators(new ChatWidget());
  });

  test('UnifiedWidget clears transient indicators when SDK state is invalidated', () => {
    assertInvalidateClearsTransientIndicators(new UnifiedWidget());
  });

  test('ChatWidget restores real welcome history instead of re-adding placeholder on rerender', () => {
    assertWelcomeMessageSurvivesRerender(new ChatWidget());
  });

  test('UnifiedWidget restores real welcome history instead of re-adding placeholder on rerender', () => {
    const widget = new UnifiedWidget();
    widget.setAttribute('mode', 'chat');
    widget.setAttribute('chat-enabled', 'true');

    assertWelcomeMessageSurvivesRerender(widget);
  });

  test('ChatWidget shows fresh-session placeholder when messages are replaced with an empty transcript', () => {
    assertMessagesReplacedRestoresFreshPlaceholder(new ChatWidget());
  });

  test('UnifiedWidget shows fresh-session placeholder when messages are replaced with an empty transcript', () => {
    const widget = new UnifiedWidget();
    widget.setAttribute('mode', 'chat');
    widget.setAttribute('chat-enabled', 'true');

    assertMessagesReplacedRestoresFreshPlaceholder(widget);
  });

  test('ChatWidget avoids duplicate and stale chat subscriptions', () => {
    assertChatHandlersAreOwned(new ChatWidget());
  });

  test('UnifiedWidget avoids duplicate and stale chat subscriptions', () => {
    const widget = new UnifiedWidget();
    widget.setAttribute('mode', 'chat');
    widget.setAttribute('chat-enabled', 'true');

    assertChatHandlersAreOwned(widget);
  });

  test('ChatWidget does not restore chat history into unavailable state', () => {
    assertHistoryDoesNotLeakIntoUnavailableState(new ChatWidget());
  });

  test('UnifiedWidget does not restore chat history into unavailable state', () => {
    const widget = new UnifiedWidget();
    widget.setAttribute('mode', 'chat');

    assertHistoryDoesNotLeakIntoUnavailableState(widget);
  });

  test('ChatWidget binds delegated shadow event listeners only once', () => {
    assertEventListenersAreBoundOnce(new ChatWidget());
  });

  test('UnifiedWidget binds delegated shadow event listeners only once', () => {
    assertEventListenersAreBoundOnce(new UnifiedWidget());
  });
});
