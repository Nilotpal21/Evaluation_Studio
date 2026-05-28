/**
 * AttachmentToolExecutor — upload_attachment tool tests
 *
 * Verifies base64 upload, MIME validation, size limits, service errors,
 * and correct delegation to MultimodalServiceClient.
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

describe('AttachmentToolExecutor — upload_attachment', () => {
  describe('isAttachmentTool', () => {
    it('returns true for upload_attachment', () => {
      expect(isAttachmentTool('upload_attachment')).toBe(true);
    });
  });

  describe('ATTACHMENT_TOOL_NAMES', () => {
    it('contains upload_attachment', () => {
      expect(ATTACHMENT_TOOL_NAMES).toContain('upload_attachment');
    });
  });

  // 1-U1: Valid base64 upload → client upload() called, returns { attachmentId, filename, url }
  describe('1-U1: valid base64 upload', () => {
    it('calls client.upload and returns structured result', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.upload).mockResolvedValue({
        success: true,
        attachmentId: 'att-new-1',
        status: 'accepted',
      });

      const content = Buffer.from('hello world').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: content,
          mime_type: 'text/plain',
          description: 'A test file',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: true,
        data: {
          attachmentId: 'att-new-1',
          filename: 'test.txt',
          status: 'accepted',
        },
      });

      expect(serviceClient.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'test.txt',
          mimeType: 'text/plain',
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
        }),
      );
    });
  });

  // 1-U2: Invalid base64 → error INVALID_BASE64
  describe('1-U2: invalid base64', () => {
    it('returns INVALID_BASE64 error for non-base64 content', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: '!!!not-valid-base64!!!',
          mime_type: 'text/plain',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: false,
        error: { code: 'INVALID_BASE64', message: expect.any(String) },
      });
    });
  });

  // 1-U3: Unsupported MIME type → error UNSUPPORTED_MIME_TYPE
  describe('1-U3: unsupported MIME type', () => {
    it('returns UNSUPPORTED_MIME_TYPE error', async () => {
      const { executor } = createExecutor();

      const content = Buffer.from('data').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.exe',
          content_base64: content,
          mime_type: 'application/x-msdownload',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: false,
        error: { code: 'UNSUPPORTED_MIME_TYPE', message: expect.any(String) },
      });
    });
  });

  // 1-U4: Content exceeds max size → error FILE_TOO_LARGE
  describe('1-U4: content exceeds max size', () => {
    it('returns FILE_TOO_LARGE error', async () => {
      const { executor } = createExecutor();

      // Generate content > 20 MB (the upload tool limit)
      // We'll test the local validation with a large buffer
      const largeContent = Buffer.alloc(21 * 1024 * 1024).toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'huge.bin',
          content_base64: largeContent,
          mime_type: 'application/octet-stream',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: expect.any(String) },
      });
    });
  });

  // 1-U5: Multimodal service unavailable → graceful error
  describe('1-U5: multimodal service unavailable', () => {
    it('returns graceful error when upload fails', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.upload).mockResolvedValue({
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Connection refused' },
      });

      const content = Buffer.from('data').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: content,
          mime_type: 'text/plain',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Connection refused' },
      });
    });

    it('handles thrown exceptions gracefully', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.upload).mockRejectedValue(new Error('Network timeout'));

      const content = Buffer.from('data').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: content,
          mime_type: 'text/plain',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('error');
    });
  });

  // 1-U6: Missing required params
  describe('1-U6: missing required parameters', () => {
    it('returns error when filename is missing', async () => {
      const { executor } = createExecutor();

      const content = Buffer.from('data').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          content_base64: content,
          mime_type: 'text/plain',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('error');
    });

    it('returns error when content_base64 is missing', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          mime_type: 'text/plain',
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('error');
    });

    it('returns error when mime_type is missing', async () => {
      const { executor } = createExecutor();

      const content = Buffer.from('data').toString('base64');
      const result = await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: content,
        },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('error');
    });
  });

  // Passes projectId from context
  describe('context propagation', () => {
    it('passes projectId from context to upload', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.upload).mockResolvedValue({
        success: true,
        attachmentId: 'att-new-1',
        status: 'accepted',
      });

      const content = Buffer.from('data').toString('base64');
      await executor.execute(
        'upload_attachment',
        {
          filename: 'test.txt',
          content_base64: content,
          mime_type: 'text/plain',
        },
        { tenantId: 'tenant-x', sessionId: 'sess-x', projectId: 'proj-x' },
      );

      expect(serviceClient.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-x',
          projectId: 'proj-x',
          sessionId: 'sess-x',
        }),
      );
    });
  });
});
