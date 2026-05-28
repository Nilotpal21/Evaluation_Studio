import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatWidget } from '../ui/ChatWidget.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';
import { VoiceWidget } from '../ui/VoiceWidget.js';

describe('UnifiedWidget companion panel', () => {
  let widget: UnifiedWidget;

  beforeEach(() => {
    vi.stubGlobal('AudioContext', class MockAudioContext {});
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
    widget = new UnifiedWidget();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function configureUnifiedVoiceWidget(target: UnifiedWidget): void {
    target.setAttribute('mode', 'unified');
    target.setAttribute('chat-enabled', 'true');
    target.setAttribute('voice-enabled', 'true');
    (target as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: true }),
    };
  }

  test('4-U15: unified mode shows voice controls and content panel', () => {
    configureUnifiedVoiceWidget(widget);
    widget.setAttribute('project-id', 'test-proj');
    widget.setAttribute('api-key', 'pk_test');

    // Trigger render
    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const voicePanel = shadow.querySelector('.voice-panel');
    const contentPanel = shadow.querySelector('.content-panel');

    expect(voicePanel).toBeTruthy();
    expect(contentPanel).toBeTruthy();
  });

  test('4-U16: thought event populates content panel', () => {
    configureUnifiedVoiceWidget(widget);
    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';

    // Simulate a thought arriving
    (widget as any).lastThought = {
      toolName: 'search',
      thought: 'Looking for red shoes',
      reasoning: 'Extracting product query',
      agent: 'shop-agent',
    };
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const thoughtEl = shadow.querySelector('.thought-display');
    expect(thoughtEl).toBeTruthy();
    expect(thoughtEl!.textContent).toContain('Looking for red shoes');
  });

  test('4-U17: status update shown in content panel', () => {
    configureUnifiedVoiceWidget(widget);
    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';
    (widget as any).statusMessage = 'Searching for products...';
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const statusEl = shadow.querySelector('.status-message');
    expect(statusEl).toBeTruthy();
    expect(statusEl!.textContent).toContain('Searching for products...');
  });

  test('4-U19: voice-only mode hides content panel', () => {
    widget.setAttribute('mode', 'voice');
    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const contentPanel = shadow.querySelector('.content-panel');
    expect(contentPanel).toBeNull();
  });

  test('channel-level showActivityUpdates=false hides unified voice activity panel content', () => {
    configureUnifiedVoiceWidget(widget);
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: false }),
    };
    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';
    (widget as any).lastThought = {
      toolName: 'handoff',
      thought: 'Transferring to Account Info agent',
      reasoning: 'Routing to the best specialist',
      agent: 'router',
    };
    (widget as any).statusMessage = 'Transferring to Account Info agent';
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    expect(shadow.querySelector('.content-panel')).toBeNull();
    expect(shadow.querySelector('.thought-display')).toBeNull();
    expect(shadow.querySelector('.status-message')).toBeNull();
  });
});

describe('VoiceWidget show-panel attribute', () => {
  let widget: VoiceWidget;

  beforeEach(() => {
    widget = new VoiceWidget();
  });

  test('4-U20: show-panel attribute on <agent-voice> renders companion panel', () => {
    widget.setAttribute('show-panel', 'true');
    widget.setAttribute('project-id', 'test-proj');
    widget.setAttribute('api-key', 'pk_test');
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: true }),
    };

    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const panel = shadow.querySelector('.companion-panel');
    expect(panel).toBeTruthy();
  });

  test('no show-panel attribute means no companion panel', () => {
    widget.setAttribute('project-id', 'test-proj');
    widget.setAttribute('api-key', 'pk_test');

    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const panel = shadow.querySelector('.companion-panel');
    expect(panel).toBeNull();
  });

  test('channel-level showActivityUpdates=false suppresses the explicit companion panel', () => {
    widget.setAttribute('show-panel', 'true');
    widget.setAttribute('project-id', 'test-proj');
    widget.setAttribute('api-key', 'pk_test');
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: false }),
    };

    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const panel = shadow.querySelector('.companion-panel');
    expect(panel).toBeNull();
  });
});

describe('ChatWidget activity visibility', () => {
  test('activity updates are hidden by default in the web component UI', () => {
    const widget = new ChatWidget();
    const messagesEl = document.createElement('div');
    (widget as any).messagesEl = messagesEl;

    (widget as any).addMessage({
      id: 'thought-default',
      role: 'thought',
      content: 'Transferring to Account Info agent',
      timestamp: new Date(),
      metadata: { toolName: 'handoff' },
    });

    expect(messagesEl.children).toHaveLength(0);
  });

  test('channel-level showActivityUpdates=false suppresses thought messages in the web component UI', () => {
    const widget = new ChatWidget();
    const messagesEl = document.createElement('div');
    (widget as any).messagesEl = messagesEl;
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: false }),
    };

    (widget as any).addMessage({
      id: 'thought-1',
      role: 'thought',
      content: 'Transferring to Account Info agent',
      timestamp: new Date(),
      metadata: { toolName: 'handoff' },
    });

    expect(messagesEl.children).toHaveLength(0);
  });
});
