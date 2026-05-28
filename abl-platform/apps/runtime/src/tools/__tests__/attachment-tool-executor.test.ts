/**
 * AttachmentToolExecutor Tests
 *
 * Verifies tool dispatch, parameter validation, structured error results,
 * and correct delegation to MultimodalServiceClient for get_attachment
 * and list_attachments tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AttachmentToolExecutor,
  ATTACHMENT_TOOL_NAMES,
  isAttachmentTool,
} from '../attachment-tool-executor.js';
import type {
  AttachmentServiceClient,
  AttachmentToolContext,
} from '../attachment-tool-executor.js';
import type { IAttachment } from '@agent-platform/database';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-001';
const SESSION_ID = 'sess-001';
const PROJECT_ID = 'proj-001';

const DEFAULT_CONTEXT: AttachmentToolContext = {
  tenantId: TENANT_ID,
  sessionId: SESSION_ID,
  projectId: PROJECT_ID,
};

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
    retryCount: 0,
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

function createExecutor(client?: AttachmentServiceClient) {
  const serviceClient = client ?? createMockClient();
  const executor = new AttachmentToolExecutor({ serviceClient });
  return { executor, serviceClient };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AttachmentToolExecutor', () => {
  // ── isAttachmentTool ─────────────────────────────────────────────────────

  describe('isAttachmentTool', () => {
    it('returns true for get_attachment', () => {
      expect(isAttachmentTool('get_attachment')).toBe(true);
    });

    it('returns true for list_attachments', () => {
      expect(isAttachmentTool('list_attachments')).toBe(true);
    });

    it('returns false for unknown tool names', () => {
      expect(isAttachmentTool('search_vector')).toBe(false);
      expect(isAttachmentTool('delete_attachment')).toBe(false);
      expect(isAttachmentTool('')).toBe(false);
      expect(isAttachmentTool('GET_ATTACHMENT')).toBe(false);
    });
  });

  // ── ATTACHMENT_TOOL_NAMES ────────────────────────────────────────────────

  describe('ATTACHMENT_TOOL_NAMES', () => {
    it('contains all attachment tool names', () => {
      expect(ATTACHMENT_TOOL_NAMES).toHaveLength(5);
      expect(ATTACHMENT_TOOL_NAMES).toContain('get_attachment');
      expect(ATTACHMENT_TOOL_NAMES).toContain('list_attachments');
      expect(ATTACHMENT_TOOL_NAMES).toContain('upload_attachment');
      expect(ATTACHMENT_TOOL_NAMES).toContain('get_attachment_url');
      expect(ATTACHMENT_TOOL_NAMES).toContain('route_attachment');
    });
  });

  // ── get_attachment ───────────────────────────────────────────────────────

  describe('get_attachment', () => {
    it('returns metadata and content for found attachment', async () => {
      const { executor, serviceClient } = createExecutor();
      const attachment = mockAttachment();
      vi.mocked(serviceClient.getAttachment).mockResolvedValue(attachment);

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        id: 'att-1',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        category: 'image',
        processingStatus: 'completed',
        content: 'Extracted text content from the image',
        imageDescription: 'A sunny beach with palm trees',
      });
      expect(result).not.toHaveProperty('storageKey');
      expect(result).not.toHaveProperty('storageBucket');
      expect(result).not.toHaveProperty('contentHash');

      expect(serviceClient.getAttachment).toHaveBeenCalledWith('att-1', TENANT_ID);
    });

    it('returns error when attachment not found', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getAttachment).mockResolvedValue(null);

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 'nonexistent' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({ error: 'Attachment not found' });
      expect(serviceClient.getAttachment).toHaveBeenCalledWith('nonexistent', TENANT_ID);
    });

    it('returns error when attachmentId param is missing', async () => {
      const { executor, serviceClient } = createExecutor();

      const result = await executor.execute('get_attachment', {}, DEFAULT_CONTEXT);

      expect(result).toEqual({ error: 'Missing required parameter: attachmentId' });
      expect(serviceClient.getAttachment).not.toHaveBeenCalled();
    });

    it('returns error when attachmentId is not a string', async () => {
      const { executor, serviceClient } = createExecutor();

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 123 },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({ error: 'Missing required parameter: attachmentId' });
      expect(serviceClient.getAttachment).not.toHaveBeenCalled();
    });

    it('accepts attachment_id (snake_case) as parameter name', async () => {
      const { executor, serviceClient } = createExecutor();
      const attachment = mockAttachment();
      vi.mocked(serviceClient.getAttachment).mockResolvedValue(attachment);

      const result = await executor.execute(
        'get_attachment',
        { attachment_id: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('id', 'att-1');
      expect(serviceClient.getAttachment).toHaveBeenCalledWith('att-1', TENANT_ID);
    });

    it('returns null content fields when not processed', async () => {
      const { executor, serviceClient } = createExecutor();
      const attachment = mockAttachment({
        processingStatus: 'pending',
        processedContent: null,
        imageDescription: null,
      });
      vi.mocked(serviceClient.getAttachment).mockResolvedValue(attachment);

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        id: 'att-1',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        category: 'image',
        processingStatus: 'pending',
        content: null,
        imageDescription: null,
      });
    });
  });

  // ── list_attachments ─────────────────────────────────────────────────────

  describe('list_attachments', () => {
    it('returns attachments for session', async () => {
      const { executor, serviceClient } = createExecutor();
      const attachments = [
        mockAttachment({ _id: 'att-1', originalFilename: 'photo1.jpg' }),
        mockAttachment({
          _id: 'att-2',
          originalFilename: 'doc.pdf',
          category: 'document',
          mimeType: 'application/pdf',
        }),
      ];
      vi.mocked(serviceClient.listBySession).mockResolvedValue(attachments);

      const result = await executor.execute('list_attachments', {}, DEFAULT_CONTEXT);

      expect(result).toEqual({
        attachments: [
          {
            id: 'att-1',
            filename: 'photo1.jpg',
            mimeType: 'image/jpeg',
            category: 'image',
            processingStatus: 'completed',
          },
          {
            id: 'att-2',
            filename: 'doc.pdf',
            mimeType: 'application/pdf',
            category: 'document',
            processingStatus: 'completed',
          },
        ],
        total: 2,
      });
      expect((result.attachments as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
        'storageKey',
      );
      expect((result.attachments as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
        'storageBucket',
      );

      expect(serviceClient.listBySession).toHaveBeenCalledWith(SESSION_ID, TENANT_ID, {
        limit: undefined,
        offset: undefined,
      });
    });

    it('filters by category when provided', async () => {
      const { executor, serviceClient } = createExecutor();
      const attachments = [
        mockAttachment({ _id: 'att-1', category: 'image' }),
        mockAttachment({ _id: 'att-2', category: 'document', mimeType: 'application/pdf' }),
        mockAttachment({ _id: 'att-3', category: 'image' }),
      ];
      vi.mocked(serviceClient.listBySession).mockResolvedValue(attachments);

      const result = await executor.execute(
        'list_attachments',
        { category: 'image' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        attachments: [
          expect.objectContaining({ id: 'att-1', category: 'image' }),
          expect.objectContaining({ id: 'att-3', category: 'image' }),
        ],
        total: 2,
      });
    });

    it('passes limit and offset to service client', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockResolvedValue([]);

      await executor.execute('list_attachments', { limit: 10, offset: 20 }, DEFAULT_CONTEXT);

      expect(serviceClient.listBySession).toHaveBeenCalledWith(SESSION_ID, TENANT_ID, {
        limit: 10,
        offset: 20,
      });
    });

    it('handles string limit and offset params', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockResolvedValue([]);

      await executor.execute('list_attachments', { limit: '5', offset: '10' }, DEFAULT_CONTEXT);

      expect(serviceClient.listBySession).toHaveBeenCalledWith(SESSION_ID, TENANT_ID, {
        limit: 5,
        offset: 10,
      });
    });

    it('returns empty array when no attachments exist', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockResolvedValue([]);

      const result = await executor.execute('list_attachments', {}, DEFAULT_CONTEXT);

      expect(result).toEqual({
        attachments: [],
        total: 0,
      });
    });

    it('ignores invalid limit/offset values', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockResolvedValue([]);

      await executor.execute('list_attachments', { limit: 'abc', offset: -5 }, DEFAULT_CONTEXT);

      expect(serviceClient.listBySession).toHaveBeenCalledWith(SESSION_ID, TENANT_ID, {
        limit: undefined,
        offset: undefined,
      });
    });
  });

  // ── Unknown tool ─────────────────────────────────────────────────────────

  describe('unknown tool name', () => {
    it('returns error for unrecognized tool name', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute('delete_attachment', {}, DEFAULT_CONTEXT);

      expect(result).toEqual({ error: 'Unknown attachment tool: delete_attachment' });
    });
  });

  // ── Error handling (never throws) ────────────────────────────────────────

  describe('never throws — errors returned as structured results', () => {
    it('catches serviceClient.getAttachment errors', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getAttachment).mockRejectedValue(new Error('Connection refused'));

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        error: "Attachment tool 'get_attachment' failed: Connection refused",
      });
    });

    it('catches serviceClient.listBySession errors', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockRejectedValue(new Error('Timeout exceeded'));

      const result = await executor.execute('list_attachments', {}, DEFAULT_CONTEXT);

      expect(result).toEqual({
        error: "Attachment tool 'list_attachments' failed: Timeout exceeded",
      });
    });

    it('handles non-Error thrown values', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getAttachment).mockRejectedValue('string-error');

      const result = await executor.execute(
        'get_attachment',
        { attachmentId: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        error: "Attachment tool 'get_attachment' failed: string-error",
      });
    });
  });

  // ── Tenant isolation ─────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('passes tenantId to getAttachment', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getAttachment).mockResolvedValue(null);

      await executor.execute(
        'get_attachment',
        { attachmentId: 'att-1' },
        { tenantId: 'tenant-xyz', sessionId: 'sess-1', projectId: 'proj-1' },
      );

      expect(serviceClient.getAttachment).toHaveBeenCalledWith('att-1', 'tenant-xyz');
    });

    it('passes tenantId to listBySession', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.listBySession).mockResolvedValue([]);

      await executor.execute(
        'list_attachments',
        {},
        { tenantId: 'tenant-abc', sessionId: 'sess-2', projectId: 'proj-2' },
      );

      expect(serviceClient.listBySession).toHaveBeenCalledWith('sess-2', 'tenant-abc', {
        limit: undefined,
        offset: undefined,
      });
    });
  });
});
