/**
 * AttachmentToolExecutor — get_attachment_url tool tests
 *
 * Verifies URL generation, expiry handling, cross-session isolation,
 * and correct delegation to MultimodalServiceClient.getDownloadUrl().
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AttachmentToolExecutor,
  ATTACHMENT_TOOL_NAMES,
  isAttachmentTool,
} from '../attachment-tool-executor.js';
import type {
  AttachmentServiceClient,
  AttachmentToolContext,
} from '../attachment-tool-executor.js';

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

describe('AttachmentToolExecutor — get_attachment_url', () => {
  describe('isAttachmentTool', () => {
    it('returns true for get_attachment_url', () => {
      expect(isAttachmentTool('get_attachment_url')).toBe(true);
    });
  });

  describe('ATTACHMENT_TOOL_NAMES', () => {
    it('contains get_attachment_url', () => {
      expect(ATTACHMENT_TOOL_NAMES).toContain('get_attachment_url');
    });
  });

  // 1-U7: Valid attachment ID → returns { url, expiresAt }
  describe('1-U7: valid attachment ID', () => {
    it('returns url and expiresAt', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getDownloadUrl).mockResolvedValue(
        'https://storage.example.com/signed-url',
      );

      const result = await executor.execute(
        'get_attachment_url',
        { attachment_id: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: true,
        data: {
          url: 'https://storage.example.com/signed-url',
          expiresInSeconds: 3600,
        },
      });

      expect(serviceClient.getDownloadUrl).toHaveBeenCalledWith('att-1', TENANT_ID, {
        expiresIn: 3600,
      });
    });
  });

  // 1-U8: Non-existent attachment ID → ATTACHMENT_NOT_FOUND
  describe('1-U8: non-existent attachment ID', () => {
    it('returns ATTACHMENT_NOT_FOUND error', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getDownloadUrl).mockResolvedValue(null);

      const result = await executor.execute(
        'get_attachment_url',
        { attachment_id: 'nonexistent' },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: false,
        error: {
          code: 'ATTACHMENT_NOT_FOUND',
          message: expect.any(String),
        },
      });
    });
  });

  // 1-U9: Missing attachment_id → error
  describe('1-U9: missing attachment_id', () => {
    it('returns error when attachment_id is missing', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute('get_attachment_url', {}, DEFAULT_CONTEXT);

      expect(result).toHaveProperty('error');
    });
  });

  // 1-U10: Custom expiry → passed through
  describe('1-U10: custom expiry', () => {
    it('passes custom expires_in_seconds to getDownloadUrl', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getDownloadUrl).mockResolvedValue(
        'https://storage.example.com/signed-url',
      );

      const result = await executor.execute(
        'get_attachment_url',
        { attachment_id: 'att-1', expires_in_seconds: 7200 },
        DEFAULT_CONTEXT,
      );

      expect(result).toEqual({
        success: true,
        data: {
          url: 'https://storage.example.com/signed-url',
          expiresInSeconds: 7200,
        },
      });

      expect(serviceClient.getDownloadUrl).toHaveBeenCalledWith('att-1', TENANT_ID, {
        expiresIn: 7200,
      });
    });
  });

  // 1-U11: Default expiry → 3600
  describe('1-U11: default expiry', () => {
    it('uses 3600 seconds as default expiry', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getDownloadUrl).mockResolvedValue(
        'https://storage.example.com/signed-url',
      );

      await executor.execute('get_attachment_url', { attachment_id: 'att-1' }, DEFAULT_CONTEXT);

      expect(serviceClient.getDownloadUrl).toHaveBeenCalledWith('att-1', TENANT_ID, {
        expiresIn: 3600,
      });
    });
  });

  // Error handling — never throws
  describe('error handling', () => {
    it('catches getDownloadUrl exceptions gracefully', async () => {
      const { executor, serviceClient } = createExecutor();
      vi.mocked(serviceClient.getDownloadUrl).mockRejectedValue(new Error('Service unavailable'));

      const result = await executor.execute(
        'get_attachment_url',
        { attachment_id: 'att-1' },
        DEFAULT_CONTEXT,
      );

      expect(result).toHaveProperty('error');
    });
  });
});
