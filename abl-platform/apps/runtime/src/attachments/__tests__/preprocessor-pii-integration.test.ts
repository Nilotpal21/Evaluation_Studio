/**
 * MessagePreprocessor PII Integration Tests (I-0.5 through I-0.8)
 *
 * Integration tests that use the REAL redactPII / applyPIIPolicy logic
 * from the message preprocessor. The MultimodalServiceClient is mocked
 * (returns attachment data), but PII redaction uses the real implementation.
 *
 * The key difference from the unit tests in message-preprocessor-pii.test.ts:
 * that file tests the applyPIIPolicy function with pre-computed piiDetections.
 * THIS file verifies that the real redactPII logic from @abl/compiler/platform
 * produces correct redaction output when wired through the preprocessor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAttachment } from '@agent-platform/database';
import { detectPII } from '@abl/compiler/platform';
import {
  MessagePreprocessor,
  type RawIncomingMessage,
  type PreprocessParams,
} from '../message-preprocessor.js';
import type { MultimodalServiceClient } from '../multimodal-service-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-001';

function makeAttachment(overrides?: Partial<IAttachment>): IAttachment {
  return {
    _id: 'att-1',
    tenantId: TENANT_ID,
    projectId: 'proj-1',
    sessionId: 'session-1',
    messageId: null,
    originalFilename: 'report.pdf',
    mimeType: 'application/pdf',
    detectedMimeType: null,
    category: 'document',
    sizeBytes: 1024,
    contentHash: null,
    storageProvider: 'local',
    storageKey: 'tenant-1/proj-1/session-1/att-1/original',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'clean',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: null,
    processedContentHash: null,
    processingError: null,
    processingEngine: null,
    processedAt: null,
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    retryCount: 0,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function makeMessage(overrides?: Partial<RawIncomingMessage>): RawIncomingMessage {
  return {
    content: 'Please analyze this document.',
    attachmentIds: [],
    channel: 'web',
    ...overrides,
  };
}

function createMockClient(): {
  getAttachment: ReturnType<typeof vi.fn>;
  listBySession: ReturnType<typeof vi.fn>;
  getDownloadUrl: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  deleteAttachment: ReturnType<typeof vi.fn>;
  deleteBySession: ReturnType<typeof vi.fn>;
} {
  return {
    getAttachment: vi.fn(),
    listBySession: vi.fn(),
    getDownloadUrl: vi.fn(),
    getStatus: vi.fn(),
    upload: vi.fn(),
    deleteAttachment: vi.fn(),
    deleteBySession: vi.fn(),
  };
}

/**
 * Helper: Use the REAL detectPII to generate realistic piiDetections
 * for a given text, mimicking what the multimodal-service would produce.
 */
function detectPIIForAttachment(text: string) {
  const result = detectPII(text);
  return {
    hasPII: result.hasPII,
    piiDetections: result.detections.map((d) => ({
      type: d.type,
      start: d.start,
      end: d.end,
      value: d.value,
    })),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MessagePreprocessor PII Integration (real redaction)', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let preprocessor: MessagePreprocessor;

  beforeEach(() => {
    mockClient = createMockClient();
    preprocessor = new MessagePreprocessor(mockClient as unknown as MultimodalServiceClient);
  });

  // ---------------------------------------------------------------------------
  // I-0.5: Redaction preserves surrounding text
  // ---------------------------------------------------------------------------

  it('I-0.5: redaction preserves surrounding text around phone number', async () => {
    const content = 'Call John at 555-123-4567 for details';
    const piiResult = detectPIIForAttachment(content);

    const docAtt = makeAttachment({
      _id: 'doc-phone',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'contacts.pdf',
      processedContent: content,
      hasPII: piiResult.hasPII,
      piiDetections: piiResult.piiDetections,
    });

    const message = makeMessage({
      content: 'Summarize this',
      attachmentIds: ['doc-phone'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // The phone number should be redacted
    expect(result.content).not.toContain('555-123-4567');
    // Surrounding text should be preserved
    expect(result.content).toContain('Call John at');
    expect(result.content).toContain('for details');
    // Should contain a REDACTED token for the phone
    expect(result.content).toContain('[REDACTED:phone]');
  });

  // ---------------------------------------------------------------------------
  // I-0.6: Multiple PII types redacted correctly
  // ---------------------------------------------------------------------------

  it('I-0.6: multiple PII types (email + SSN + credit card) each get correct [REDACTED:type] tag', async () => {
    const content = 'Email: user@test.com, SSN: 123-45-6789, Card: 4111 1111 1111 1111';
    const piiResult = detectPIIForAttachment(content);

    const docAtt = makeAttachment({
      _id: 'doc-multi-pii',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'sensitive-data.pdf',
      processedContent: content,
      hasPII: piiResult.hasPII,
      piiDetections: piiResult.piiDetections,
    });

    const message = makeMessage({
      content: 'Review this',
      attachmentIds: ['doc-multi-pii'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // Original PII values must be gone
    expect(result.content).not.toContain('user@test.com');
    expect(result.content).not.toContain('123-45-6789');
    expect(result.content).not.toContain('4111 1111 1111 1111');

    // Each type should have its own REDACTED tag
    expect(result.content).toContain('[REDACTED:email]');
    expect(result.content).toContain('[REDACTED:ssn]');

    // Credit card 4111111111111111 passes Luhn validation
    expect(result.content).toContain('[REDACTED:credit_card]');

    // Surrounding labels should be preserved
    expect(result.content).toContain('Email:');
    expect(result.content).toContain('SSN:');
    expect(result.content).toContain('Card:');
  });

  // ---------------------------------------------------------------------------
  // I-0.7: Truncated content with PII at boundary
  // ---------------------------------------------------------------------------

  it('I-0.7: 50,000 char content with PII near the end — PII at boundary still redacted', async () => {
    // Build content: 49,970 chars of filler + email near the end
    const filler = 'A'.repeat(49_970);
    const emailAtEnd = ' Contact: boundary@test.com done.';
    const content = filler + emailAtEnd;

    // The preprocessor truncates at 50,000 chars. With 49,970 + 33 = 50,003,
    // truncation will cut to 50,000 + "[... truncated]". The email starts
    // at position 49,980 (within the 50,000 limit), so it should still be detectable.
    const piiResult = detectPIIForAttachment(content);

    const docAtt = makeAttachment({
      _id: 'doc-boundary',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'huge-doc.pdf',
      processedContent: content,
      hasPII: piiResult.hasPII,
      piiDetections: piiResult.piiDetections,
    });

    const message = makeMessage({
      content: 'Analyze',
      attachmentIds: ['doc-boundary'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // The content is over 50k, so it should be truncated
    expect(result.content).toContain('[... truncated]');

    // The email should still be redacted since it's within the 50k window
    // (it starts at position 49,980 which is before the 50,000 cut)
    expect(result.content).not.toContain('boundary@test.com');
    expect(result.content).toContain('[REDACTED:email]');
  });

  // ---------------------------------------------------------------------------
  // I-0.8: Unicode content with PII
  // ---------------------------------------------------------------------------

  it('I-0.8: Japanese text mixed with email address — email detected and redacted, unicode preserved', async () => {
    const content = 'お問い合わせは support@example.com までご連絡ください。東京都渋谷区';
    const piiResult = detectPIIForAttachment(content);

    const docAtt = makeAttachment({
      _id: 'doc-unicode',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'japanese-doc.pdf',
      processedContent: content,
      hasPII: piiResult.hasPII,
      piiDetections: piiResult.piiDetections,
    });

    const message = makeMessage({
      content: 'Translate this',
      attachmentIds: ['doc-unicode'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // Email should be redacted
    expect(result.content).not.toContain('support@example.com');
    expect(result.content).toContain('[REDACTED:email]');

    // Japanese text should be preserved
    expect(result.content).toContain('お問い合わせは');
    expect(result.content).toContain('までご連絡ください。東京都渋谷区');
  });
});
