import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ASSISTANT_OUTPUT_GOLDEN_FIXTURE } from '@agent-platform/shared-kernel/propagation-fixtures';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { Message } from '../core/types.js';
import {
  normalizeActionSet,
  normalizeContentEnvelope,
  normalizeRichContent,
  normalizeVoiceConfig,
} from '../core/message-normalization.js';
import type {
  TransportClientMessage,
  TransportError,
  TransportServerMessage,
} from '../transport/types.js';
import { renderRichMessage } from '../ui/rich-renderer.js';
import '../templates/index.js';

class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: TransportError;
}> {
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    // noop
  }

  isConnected(): boolean {
    return true;
  }

  send(_message: TransportClientMessage): void {
    // noop
  }

  getSessionId(): string | null {
    return 'sdk-golden-session';
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

const golden = ASSISTANT_OUTPUT_GOLDEN_FIXTURE.textPlusStructured;

function makeGoldenMessage(): Message {
  const contentEnvelope = normalizeContentEnvelope(golden.contentEnvelope);

  return {
    id: 'golden-msg-1',
    role: 'assistant',
    content: contentEnvelope?.text ?? '',
    timestamp: new Date('2026-05-06T00:00:00.000Z'),
    richContent: normalizeRichContent(golden.richContent),
    actions: normalizeActionSet(golden.actions),
    voiceConfig: normalizeVoiceConfig(golden.voiceConfig),
    contentEnvelope,
    metadata: {
      localization: golden.localization,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'mixed',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    },
  };
}

describe('SDK golden assistant-output propagation', () => {
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
  });

  it('core ChatClient preserves the shared golden runtime envelope and SDK-normalized fields', () => {
    const transport = new MockTransport();
    const chat = new ChatClient(transport as any, undefined, false);
    const messages: Message[] = [];
    chat.on('message', (message) => messages.push(message));

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'golden-msg-1',
      content: '',
      contentEnvelope: golden.contentEnvelope,
      richContent: golden.richContent,
      actions: golden.actions,
      voiceConfig: golden.voiceConfig,
      metadata: { localization: golden.localization },
    } as unknown as TransportServerMessage);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        id: 'golden-msg-1',
        role: 'assistant',
        content: 'Your claim CLM-123 is ready for review.',
      }),
    );
    expect(messages[0].contentEnvelope?.version).toBe('assistant.contentEnvelope/v2');
    expect(messages[0].contentEnvelope?.localization).toEqual(golden.localization);
    expect(messages[0].contentEnvelope?.metadata).toEqual({
      locale: 'en-US',
      source: 'golden-fixture',
    });
    expect(messages[0].richContent?.markdown).toContain('Claim review');
    expect(messages[0].voiceConfig?.plain_text).toBe('Your claim is ready for review.');
    expect(messages[0].actions?.elements.map((element) => element.label)).toEqual([
      'Open claim {{session.claimId}}',
      'Request callback',
    ]);
    expect(messages[0].metadata?.localization).toEqual(golden.localization);
  });

  it('React RichContent renders the SDK-normalized golden fixture and submits actions', async () => {
    const { RichContent } = await import('../react/index.js');
    const onAction = vi.fn();

    await act(async () => {
      root.render(React.createElement(RichContent, { message: makeGoldenMessage(), onAction }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Claim review');
    expect(container.textContent).toContain('Status');
    expect(container.textContent).toContain('Open claim {{session.claimId}}');

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Open claim {{session.claimId}}',
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith(
      'open-claim',
      JSON.stringify({ claimId: '{{session.claimId}}' }),
    );
  });

  it('vanilla DOM renderer consumes the same normalized golden fixture as React', () => {
    const onAction = vi.fn();
    const message = makeGoldenMessage();

    renderRichMessage(container, message, { onAction });

    expect(container.textContent).toContain('Claim review');
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('Request callback');

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Request callback',
    );
    expect(button).toBeTruthy();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onAction).toHaveBeenCalledWith(
      'request-callback',
      JSON.stringify({ action: 'request_callback', contactId: '{{contact.id}}' }),
    );
  });
});
