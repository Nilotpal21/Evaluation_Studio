/**
 * MessagePreprocessor PII Redaction Tests
 *
 * Verifies that PII-flagged attachments have their processedContent
 * redacted before injection into the LLM context, based on a
 * configurable policy (redact | block | allow).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAttachment } from '@agent-platform/database';
import type { ImageContent, TextContent } from '@abl/compiler/platform/llm/types.js';
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MessagePreprocessor PII redaction', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let preprocessor: MessagePreprocessor;

  beforeEach(() => {
    mockClient = createMockClient();
    preprocessor = new MessagePreprocessor(mockClient as unknown as MultimodalServiceClient);
  });

  // ---------------------------------------------------------------------------
  // 0-U9: Redact policy with PII → content contains [REDACTED:email]
  // ---------------------------------------------------------------------------

  it('0-U9: redact policy with PII → content has [REDACTED:type] tokens', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-pii',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'contract.pdf',
      processedContent: 'Contact user@example.com for details. SSN: 123-45-6789.',
      hasPII: true,
      piiDetections: [
        { type: 'email', start: 8, end: 24, value: '[REDACTED_EMAIL]' },
        { type: 'ssn', start: 43, end: 54, value: '[REDACTED_SSN]' },
      ],
    });

    const message = makeMessage({
      content: 'Summarize this',
      attachmentIds: ['doc-pii'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // Should contain redaction tokens
    expect(result.content).toContain('[REDACTED:email]');
    expect(result.content).toContain('[REDACTED:ssn]');
    // Original PII values should be gone
    expect(result.content).not.toContain('user@example.com');
    expect(result.content).not.toContain('123-45-6789');
  });

  // ---------------------------------------------------------------------------
  // 0-U10: Block policy with PII → [File contains PII and cannot be processed]
  // ---------------------------------------------------------------------------

  it('0-U10: block policy with PII → blocks entire content', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-block',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'sensitive.pdf',
      processedContent: 'SSN: 123-45-6789',
      hasPII: true,
      piiDetections: [{ type: 'ssn', start: 5, end: 16, value: '123-45-6789' }],
    });

    const message = makeMessage({
      content: 'Read this',
      attachmentIds: ['doc-block'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'block',
    } as PreprocessParams);

    expect(result.content).toContain('[File contains PII and cannot be processed]');
    // Actual content must NOT appear
    expect(result.content).not.toContain('SSN: 123-45-6789');
  });

  // ---------------------------------------------------------------------------
  // 0-U11: Allow policy with PII → raw content
  // ---------------------------------------------------------------------------

  it('0-U11: allow policy with PII → injects raw content', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-allow',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'public.pdf',
      processedContent: 'Contact user@example.com for more.',
      hasPII: true,
      piiDetections: [{ type: 'email', start: 8, end: 24, value: 'user@example.com' }],
    });

    const message = makeMessage({
      content: 'Summarize',
      attachmentIds: ['doc-allow'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'allow',
    } as PreprocessParams);

    // Raw content should be present
    expect(result.content).toContain('Contact user@example.com for more.');
    expect(result.content).not.toContain('[REDACTED');
  });

  // ---------------------------------------------------------------------------
  // 0-U12: No PII → verbatim injection regardless of policy
  // ---------------------------------------------------------------------------

  it('0-U12: no PII → verbatim injection regardless of policy', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-clean',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'clean.pdf',
      processedContent: 'This document has no sensitive data.',
      hasPII: false,
      piiDetections: [],
    });

    const message = makeMessage({
      content: 'Read this',
      attachmentIds: ['doc-clean'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'redact',
    } as PreprocessParams);

    expect(result.content).toContain('This document has no sensitive data.');
  });

  // ---------------------------------------------------------------------------
  // 0-U13: Policy resolution order (project overrides tenant)
  // ---------------------------------------------------------------------------

  it('0-U13: piiPolicy from params is used (project overrides tenant)', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-proj',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'data.pdf',
      processedContent: 'Email: admin@corp.com',
      hasPII: true,
      piiDetections: [{ type: 'email', start: 7, end: 21, value: 'admin@corp.com' }],
    });

    const message = makeMessage({
      content: 'Check',
      attachmentIds: ['doc-proj'],
    });

    // Even if tenant default is 'redact', project says 'allow'
    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
      piiPolicy: 'allow',
    } as PreprocessParams);

    // allow policy → raw content preserved
    expect(result.content).toContain('admin@corp.com');
  });

  // ---------------------------------------------------------------------------
  // 0-U14: Default policy when none configured → falls back to 'redact'
  // ---------------------------------------------------------------------------

  it('0-U14: no piiPolicy configured → defaults to redact', async () => {
    const docAtt = makeAttachment({
      _id: 'doc-default',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'invoice.pdf',
      processedContent: 'Pay user@billing.com',
      hasPII: true,
      piiDetections: [{ type: 'email', start: 4, end: 20, value: 'user@billing.com' }],
    });

    const message = makeMessage({
      content: 'Process this',
      attachmentIds: ['doc-default'],
    });

    // No piiPolicy specified — should default to 'redact'
    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docAtt],
    });

    expect(result.content).toContain('[REDACTED:email]');
    expect(result.content).not.toContain('user@billing.com');
  });

  // ---------------------------------------------------------------------------
  // 0-U15: Multiple attachments mixed PII
  // ---------------------------------------------------------------------------

  it('0-U15: multiple attachments with mixed PII', async () => {
    const docWithPII = makeAttachment({
      _id: 'doc-pii',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'sensitive.pdf',
      processedContent: 'SSN: 123-45-6789',
      hasPII: true,
      piiDetections: [{ type: 'ssn', start: 5, end: 16, value: '123-45-6789' }],
    });

    const docClean = makeAttachment({
      _id: 'doc-clean',
      category: 'document',
      processingStatus: 'completed',
      originalFilename: 'public.pdf',
      processedContent: 'This is public information.',
      hasPII: false,
      piiDetections: [],
    });

    const message = makeMessage({
      content: 'Review both',
      attachmentIds: ['doc-pii', 'doc-clean'],
    });

    const result = await preprocessor.preprocess({
      message,
      tenantId: TENANT_ID,
      attachments: [docWithPII, docClean],
      piiPolicy: 'redact',
    } as PreprocessParams);

    // First doc should be redacted
    expect(result.content).toContain('[REDACTED:ssn]');
    expect(result.content).not.toContain('123-45-6789');
    // Second doc should pass through verbatim
    expect(result.content).toContain('This is public information.');
  });
});
