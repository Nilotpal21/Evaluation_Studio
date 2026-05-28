/**
 * Tool Input Validator — attachment type parameter validation tests
 *
 * Verifies that tool parameters with `type: 'attachment'` are validated
 * against the session's attachment list before tool dispatch.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateAttachmentParam } from '../attachment-param-validator.js';
import type { AttachmentServiceClient } from '../attachment-tool-executor.js';
import type { IAttachment } from '@agent-platform/database';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-001';
const SESSION_ID = 'sess-001';

function mockAttachment(overrides: Partial<IAttachment> = {}): IAttachment {
  return {
    _id: 'att-1',
    tenantId: TENANT_ID,
    projectId: 'proj-001',
    sessionId: SESSION_ID,
    messageId: null,
    originalFilename: 'photo.jpg',
    mimeType: 'image/jpeg',
    detectedMimeType: null,
    category: 'image',
    sizeBytes: 1024,
    contentHash: null,
    storageProvider: 's3',
    storageKey: 'uploads/att-1.jpg',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'pending',
    scanEngine: null,
    scannedAt: null,
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: 'Extracted text content from the image',
    processedContentHash: null,
    processingError: null,
    processingEngine: 'tesseract',
    processedAt: new Date('2026-01-15T00:00:00Z'),
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: 'A sunny beach with palm trees',
    imageDescriptionModel: 'gpt-4o',
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    expiresAt: new Date('2026-04-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-15T00:00:00Z'),
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function createMockClient(): AttachmentServiceClient {
  return {
    getAttachment: vi.fn(),
    listBySession: vi.fn(),
    getDownloadUrl: vi.fn(),
    upload: vi.fn(),
    retry: vi.fn(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateAttachmentParam', () => {
  // 1-U12: Valid attachment ID in session → passes
  describe('1-U12: valid attachment ID in session', () => {
    it('returns valid result when attachment exists in session', async () => {
      const client = createMockClient();
      const attachment = mockAttachment({ _id: 'att-1', sessionId: SESSION_ID });
      vi.mocked(client.getAttachment).mockResolvedValue(attachment);

      const result = await validateAttachmentParam('att-1', {
        serviceClient: client,
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({ valid: true });
      expect(client.getAttachment).toHaveBeenCalledWith('att-1', TENANT_ID);
    });
  });

  // 1-U13: Non-existent attachment ID → fails with helpful message
  describe('1-U13: non-existent attachment ID', () => {
    it('returns invalid result with helpful message', async () => {
      const client = createMockClient();
      vi.mocked(client.getAttachment).mockResolvedValue(null);

      const result = await validateAttachmentParam('nonexistent', {
        serviceClient: client,
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('Invalid attachment ID'),
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('list_attachments');
      }
    });
  });

  // 1-U14: Empty string → fails
  describe('1-U14: empty string', () => {
    it('returns invalid result for empty attachment ID', async () => {
      const client = createMockClient();

      const result = await validateAttachmentParam('', {
        serviceClient: client,
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('Invalid attachment ID'),
      });
      // Should not even call the service for empty string
      expect(client.getAttachment).not.toHaveBeenCalled();
    });
  });

  // 1-U15: Attachment from different session → fails
  describe('1-U15: attachment from different session', () => {
    it('returns invalid result for cross-session attachment', async () => {
      const client = createMockClient();
      const attachment = mockAttachment({
        _id: 'att-other',
        sessionId: 'other-session',
      });
      vi.mocked(client.getAttachment).mockResolvedValue(attachment);

      const result = await validateAttachmentParam('att-other', {
        serviceClient: client,
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining('Invalid attachment ID'),
      });
    });
  });
});
