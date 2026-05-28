/**
 * WhatsApp File Attachments — Adapter-level tests
 *
 * Tests that the WhatsApp adapter:
 * - Accepts media messages (image, document, audio, video) in shouldProcess()
 * - Extracts media references into metadata.whatsappMediaReferences in buildNormalizedMessage()
 * - Uses caption as text for media messages that support it
 * - Does NOT add whatsappMediaReferences for regular text messages
 */

import { describe, it, expect } from 'vitest';
import { WhatsAppAdapter } from '../../../channels/adapters/whatsapp-adapter.js';

const adapter = new WhatsAppAdapter();

// Helper: build a minimal WhatsApp webhook payload with a media message
function makeMediaPayload(overrides: {
  type: 'image' | 'document' | 'audio' | 'video';
  media: Record<string, unknown>;
  text?: string;
}) {
  return {
    object: 'whatsapp_business_account' as const,
    entry: [
      {
        id: 'WABA1',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp' as const,
              metadata: {
                display_phone_number: '15550001111',
                phone_number_id: 'PN123',
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: '919999999999' }],
              messages: [
                {
                  id: 'wamid.test123',
                  from: '919999999999',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: overrides.type,
                  [overrides.type]: overrides.media,
                  ...(overrides.text ? { text: { body: overrides.text } } : {}),
                },
              ],
            },
            field: 'messages' as const,
          },
        ],
      },
    ],
  };
}

describe('WhatsAppAdapter media: shouldProcess', () => {
  it('accepts image messages', () => {
    const body = makeMediaPayload({
      type: 'image',
      media: { id: 'media-001', mime_type: 'image/jpeg', sha256: 'abc' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts document messages', () => {
    const body = makeMediaPayload({
      type: 'document',
      media: {
        id: 'media-002',
        mime_type: 'application/pdf',
        sha256: 'def',
        filename: 'report.pdf',
      },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts audio messages', () => {
    const body = makeMediaPayload({
      type: 'audio',
      media: { id: 'media-003', mime_type: 'audio/ogg; codecs=opus', sha256: 'ghi' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });

  it('accepts video messages', () => {
    const body = makeMediaPayload({
      type: 'video',
      media: { id: 'media-004', mime_type: 'video/mp4', sha256: 'jkl' },
    });
    expect(adapter.shouldProcess(body)).toBe(true);
  });
});

describe('WhatsAppAdapter media: buildNormalizedMessage', () => {
  it('extracts whatsappMediaReferences for an image message', () => {
    const body = makeMediaPayload({
      type: 'image',
      media: { id: 'media-010', mime_type: 'image/jpeg', sha256: 'hash1', caption: 'My photo' },
    });

    const msg = adapter.buildNormalizedMessage(body);

    // Caption becomes the text
    expect(msg.text).toBe('My photo');

    const refs = msg.metadata?.whatsappMediaReferences as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      mediaId: 'media-010',
      mimeType: 'image/jpeg',
      mediaType: 'image',
      filename: undefined,
    });
  });

  it('extracts whatsappMediaReferences for a document with filename', () => {
    const body = makeMediaPayload({
      type: 'document',
      media: {
        id: 'media-020',
        mime_type: 'application/pdf',
        sha256: 'hash2',
        filename: 'report.pdf',
        caption: 'Q4 report',
      },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('Q4 report');

    const refs = msg.metadata?.whatsappMediaReferences as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      mediaId: 'media-020',
      mimeType: 'application/pdf',
      mediaType: 'document',
      filename: 'report.pdf',
    });
  });

  it('extracts whatsappMediaReferences for audio (no caption)', () => {
    const body = makeMediaPayload({
      type: 'audio',
      media: { id: 'media-030', mime_type: 'audio/ogg; codecs=opus', sha256: 'hash3' },
    });

    const msg = adapter.buildNormalizedMessage(body);
    expect(msg.text).toBe('');

    const refs = msg.metadata?.whatsappMediaReferences as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      mediaId: 'media-030',
      mimeType: 'audio/ogg; codecs=opus',
      mediaType: 'audio',
      filename: undefined,
    });
  });

  it('has no whatsappMediaReferences for regular text messages', () => {
    const body = {
      object: 'whatsapp_business_account' as const,
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp' as const,
                metadata: { display_phone_number: '15550001111', phone_number_id: 'PN123' },
                contacts: [{ profile: { name: 'Test User' }, wa_id: '919999999999' }],
                messages: [
                  {
                    id: 'wamid.text456',
                    from: '919999999999',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text' as const,
                    text: { body: 'Hello agent' },
                  },
                ],
              },
              field: 'messages' as const,
            },
          ],
        },
      ],
    };

    const msg = adapter.buildNormalizedMessage(body);
    const refs = msg.metadata?.whatsappMediaReferences as
      | Array<Record<string, unknown>>
      | undefined;
    expect(!refs || refs.length === 0).toBe(true);
  });
});
