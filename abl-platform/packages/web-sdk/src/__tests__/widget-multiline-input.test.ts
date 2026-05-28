import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatWidget } from '../ui/ChatWidget.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';

function configureChatWidget(widget: ChatWidget) {
  widget.setAttribute('project-id', 'project-1');
  widget.setAttribute('api-key', 'pk_test');
  widget.setAttribute('endpoint', 'https://runtime.example.com');
  document.body.appendChild(widget);

  const chat = {
    send: vi.fn(async () => {}),
  };
  const sdk = {
    disconnect: vi.fn(),
    isConnected: () => true,
    getSessionScope: () => ({ showActivityUpdates: true }),
  };

  (widget as any).isMinimized = false;
  (widget as any).chat = chat;
  (widget as any).sdk = sdk;
  (widget as any).render();

  const composer = widget.shadowRoot?.querySelector('.input-field') as HTMLTextAreaElement | null;
  return { chat, sdk, composer };
}

function configureUnifiedWidget(widget: UnifiedWidget, options?: { liveSession?: boolean }) {
  widget.setAttribute('project-id', 'project-1');
  widget.setAttribute('api-key', 'pk_test');
  widget.setAttribute('endpoint', 'https://runtime.example.com');
  widget.setAttribute('mode', 'unified');
  widget.setAttribute('chat-enabled', 'true');
  widget.setAttribute('voice-enabled', 'false');
  document.body.appendChild(widget);

  const chat = {
    send: vi.fn(async () => {}),
    sendTypedInterrupt: vi.fn(),
  };
  const sdk = {
    disconnect: vi.fn(),
    isConnected: () => true,
    getSessionScope: () => ({ showActivityUpdates: true }),
  };

  (widget as any).isMinimized = false;
  (widget as any).currentMode = 'chat';
  (widget as any).isInLiveSession = options?.liveSession === true;
  (widget as any).chat = chat;
  (widget as any).sdk = sdk;
  (widget as any).render();

  const composer = widget.shadowRoot?.querySelector('.input-field') as HTMLTextAreaElement | null;
  return { chat, sdk, composer };
}

describe('SDK widget multiline composer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('ChatWidget uses a textarea composer and auto-resizes up to the max height', () => {
    const widget = new ChatWidget();
    const { composer } = configureChatWidget(widget);

    expect(composer).not.toBeNull();
    expect(composer?.tagName).toBe('TEXTAREA');

    Object.defineProperty(composer!, 'scrollHeight', {
      configurable: true,
      get: () => 200,
    });

    composer!.value = 'first line\nsecond line\nthird line';
    composer!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(composer?.style.height).toBe('120px');
    expect(composer?.style.overflowY).toBe('auto');
  });

  test('UnifiedWidget uses a textarea composer in both chat and live-session layouts', () => {
    const chatWidget = new UnifiedWidget();
    const { composer: chatComposer } = configureUnifiedWidget(chatWidget);
    expect(chatComposer?.tagName).toBe('TEXTAREA');

    const liveWidget = new UnifiedWidget();
    const { composer: liveComposer } = configureUnifiedWidget(liveWidget, { liveSession: true });
    expect(liveComposer?.tagName).toBe('TEXTAREA');
  });

  test('UnifiedWidget sends multiline text on Enter and keeps Shift+Enter in compose mode', () => {
    const widget = new UnifiedWidget();
    const { chat, composer } = configureUnifiedWidget(widget);

    composer!.value = 'hello\nworld';

    const shiftEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
    });
    composer!.dispatchEvent(shiftEnterEvent);
    expect(chat.send).not.toHaveBeenCalled();

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    });
    composer!.dispatchEvent(enterEvent);

    expect(chat.send).toHaveBeenCalledWith('hello\nworld');
    expect(composer?.value).toBe('');
  });
});
