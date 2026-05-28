import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import {
  buildPersistedAssistantStructuredContent,
  buildPersistedMessageStructuredContent,
  contentBlocksToText,
  createPersistedMessageContentEnvelope,
  createPersistedStructuredMessageEnvelope,
  decodePersistedMessageContent,
} from '../persisted-message-content.js';

describe('persisted-message-content', () => {
  it('returns plain text content unchanged', () => {
    expect(decodePersistedMessageContent('Hello there')).toEqual({
      content: 'Hello there',
      encoding: 'plain_text',
    });
  });

  it('extracts display text from legacy JSON content blocks and keeps rawContent', () => {
    const blocks = [
      { type: 'text', text: 'Here is the result.' },
      { type: 'tool_result', tool_use_id: 'tool-1', content: '42' },
    ] as const;

    const decoded = decodePersistedMessageContent(JSON.stringify(blocks));

    expect(decoded.encoding).toBe('legacy_json_blocks');
    expect(decoded.content).toBe('Here is the result.\n42');
    expect(decoded.rawContent).toEqual(blocks);
  });

  it('supports the future envelope shape without changing caller code', () => {
    const envelope = createPersistedMessageContentEnvelope([
      { type: 'text', text: 'Future-ready transcript.' },
    ]);

    const decoded = decodePersistedMessageContent(JSON.stringify(envelope));

    expect(decoded.encoding).toBe('envelope_v1');
    expect(decoded.content).toBe('Future-ready transcript.');
    expect(decoded.rawContent).toEqual(envelope.blocks);
    expect(decoded.envelope).toEqual(envelope);
  });

  it('prefers a separate durable envelope for structured assistant payloads', () => {
    const blocks = [{ type: 'text', text: 'Structured transcript.' }] as const;
    const envelope = createPersistedStructuredMessageEnvelope('Structured transcript.', {
      blocks: [...blocks],
      richContent: { markdown: '**Structured transcript.**' },
      actions: {
        elements: [{ id: 'ack', type: 'button', label: 'Acknowledge' }],
        submit_id: 'ack-submit',
      },
      voiceConfig: { plain_text: 'Structured transcript.' },
    });

    expect(envelope).not.toBeNull();
    if (!envelope) {
      throw new Error('Expected structured message envelope');
    }

    const decoded = decodePersistedMessageContent(
      'Structured transcript.',
      JSON.stringify(envelope),
    );

    expect(decoded.encoding).toBe('envelope_v2');
    expect(decoded.content).toBe('Structured transcript.');
    expect(decoded.rawContent).toEqual(blocks);
    expect(decoded.contentEnvelope).toMatchObject({
      version: 2,
      format: 'message_envelope',
      text: 'Structured transcript.',
      richContent: { markdown: '**Structured transcript.**' },
      actions: {
        elements: [{ id: 'ack', type: 'button', label: 'Acknowledge' }],
        submit_id: 'ack-submit',
      },
      voiceConfig: { plain_text: 'Structured transcript.' },
    });
  });

  it('builds direct assistant structured content through the canonical persisted helper', () => {
    const source = {
      richContent: { markdown: '**Canonical assistant**' },
      actions: {
        elements: [{ id: 'next', type: 'button' as const, label: 'Next' }],
        submit_id: 'next-submit',
      },
      voiceConfig: { plain_text: 'Canonical assistant' },
      localization: {
        domain: 'project' as const,
        locale: 'en-US',
        messageKey: 'assistant.next',
        catalogId: 'catalog-v1',
      },
    };

    expect(buildPersistedAssistantStructuredContent(source)).toEqual(
      buildPersistedMessageStructuredContent(source),
    );
  });

  it('drops localization for fallback assistant responses before persistence', () => {
    expect(
      buildPersistedAssistantStructuredContent({
        richContent: { markdown: '**Fallback assistant**' },
        localization: {
          domain: 'project',
          locale: 'fr-FR',
          fallbackLocale: 'en-US',
          messageKey: 'assistant.fallback',
          catalogId: 'catalog-v1',
        },
        usedFallback: true,
      }),
    ).toEqual({
      richContent: { markdown: '**Fallback assistant**' },
    });
  });

  it('omits empty direct assistant structured content', () => {
    expect(buildPersistedAssistantStructuredContent({})).toBeUndefined();
  });

  it('falls back to the original JSON string when blocks have no text preview', () => {
    const imageOnly: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/only-image.png' },
      },
    ];

    const serialized = JSON.stringify(imageOnly);
    const decoded = decodePersistedMessageContent(serialized);

    expect(contentBlocksToText(imageOnly)).toBe('');
    expect(decoded.content).toBe(serialized);
    expect(decoded.rawContent).toEqual(imageOnly);
  });
});
