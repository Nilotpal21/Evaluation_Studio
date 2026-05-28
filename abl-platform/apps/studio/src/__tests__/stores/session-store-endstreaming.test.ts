/**
 * Session Store — endStreaming tests
 *
 * Verifies the endStreaming method correctly handles full text responses,
 * empty responses, and missing streaming message IDs.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../store/session-store';

// =============================================================================
// HELPERS
// =============================================================================

const store = useSessionStore;

function getMessages() {
  return store.getState().messages;
}

// =============================================================================
// TESTS
// =============================================================================

describe('session-store endStreaming', () => {
  beforeEach(() => {
    store.setState({
      messages: [],
      isStreaming: true,
      streamingMessageId: 'msg-1',
      streamingContent: '',
      expandedThoughtIds: new Set<string>(),
      sessionId: 'test-session',
      agent: null,
      state: null,
      lastAction: null,
      isLoading: false,
      error: null,
    });
  });

  it('adds assistant message when fullText is provided', () => {
    store.getState().endStreaming('Hello, how can I help?');

    const msgs = getMessages();
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Hello, how can I help?');
    expect(assistant!.id).toBe('msg-1');
  });

  it('uses voiceConfig.plain_text when fullText is empty', () => {
    store.getState().endStreaming({
      fullText: '',
      voiceConfig: { plain_text: 'Spoken fallback text' },
      metadata: {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    });

    const msgs = getMessages();
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Spoken fallback text');
    expect(assistant!.metadata?.isLlmGenerated).toBe(true);
    expect(assistant!.contentEnvelope).toEqual({
      text: 'Spoken fallback text',
      voiceConfig: { plain_text: 'Spoken fallback text' },
    });
  });

  it('keeps structured-only assistant payloads instead of surfacing an empty-response error', () => {
    store.getState().endStreaming({
      fullText: '',
      richContent: { markdown: '**Structured** output' },
      actions: {
        elements: [{ id: 'approve', type: 'button', label: 'Approve' }],
      },
    });

    const msgs = getMessages();
    expect(msgs.find((m) => m.role === 'system')).toBeUndefined();

    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('');
    expect(assistant!.contentEnvelope).toEqual({
      text: '',
      richContent: { markdown: '**Structured** output' },
      actions: {
        elements: [{ id: 'approve', type: 'button', label: 'Approve' }],
      },
    });
  });

  it('keeps streamed chunks transient and commits the final structured envelope once', () => {
    store.getState().appendStreamChunk('Partial ');
    store.getState().appendStreamChunk('chunk');
    const localization = {
      locale: 'en-US',
      source: 'template',
      bundleId: 'support-responses',
    };

    store.getState().endStreaming({
      fullText: 'Final answer',
      voiceConfig: { plain_text: 'Final answer' },
      richContent: { markdown: '**Final**' },
      actions: {
        elements: [{ id: 'details', type: 'button', label: 'Details' }],
      },
      metadata: {
        locale: 'en-US',
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: false,
          usedLlmInternally: true,
        },
      },
      localization,
    });

    const msgs = getMessages();
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Final answer');
    expect(assistant!.content).not.toContain('Partial chunk');
    expect(assistant!.metadata?.locale).toBe('en-US');
    expect(assistant!.metadata?.localization).toEqual(localization);
    expect(assistant!.contentEnvelope).toEqual({
      text: 'Final answer',
      voiceConfig: { plain_text: 'Final answer' },
      richContent: { markdown: '**Final**' },
      actions: {
        elements: [{ id: 'details', type: 'button', label: 'Details' }],
      },
      localization,
    });
    expect(store.getState().streamingContent).toBe('');
  });

  it('adds system error message when fullText is empty', () => {
    store.getState().endStreaming('');

    const msgs = getMessages();
    const system = msgs.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.id).toBe('msg-1');
  });

  it('error message uses sanitized user-facing text', () => {
    store.getState().endStreaming('');

    const msgs = getMessages();
    const system = msgs.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toBe("I'm having trouble completing that request. Please try again.");
    expect(system!.content).not.toContain('model resolution');
    expect(system!.content).not.toContain('credentials');
  });

  it('clears streaming state after endStreaming with fullText', () => {
    store.getState().endStreaming('Done');

    const state = store.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.streamingMessageId).toBeNull();
    expect(state.streamingContent).toBe('');
  });

  it('clears streaming state after endStreaming with empty fullText', () => {
    store.getState().endStreaming('');

    const state = store.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.streamingMessageId).toBeNull();
    expect(state.streamingContent).toBe('');
  });

  it('adds no message when streamingMessageId is null', () => {
    store.setState({ streamingMessageId: null });

    store.getState().endStreaming('This should be ignored');

    const msgs = getMessages();
    expect(msgs).toHaveLength(0);
  });

  it('removes empty placeholder thought messages', () => {
    // Add a placeholder thought with no content (as startStreaming does)
    store.setState({
      messages: [
        {
          id: 'thinking-msg-1',
          role: 'thought' as const,
          content: '',
          timestamp: new Date(),
          traceIds: [],
        },
      ],
    });

    store.getState().endStreaming('Final answer');

    const msgs = getMessages();
    const thoughts = msgs.filter((m) => m.role === 'thought');
    expect(thoughts).toHaveLength(0);

    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('Final answer');
  });
});
