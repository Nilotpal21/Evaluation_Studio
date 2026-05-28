/**
 * AttachmentToolExecutor — route_attachment Tests (Phase 3A — ST-3.2)
 *
 * Verifies the route_attachment tool: sending attachments to named
 * destinations from the DESTINATIONS DSL block, SSRF protection,
 * auth header injection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttachmentToolExecutor, isAttachmentTool } from '../attachment-tool-executor.js';
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
    _id: 'att-route-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    messageId: null,
    originalFilename: 'doc.pdf',
    mimeType: 'application/pdf',
    detectedMimeType: null,
    category: 'document',
    sizeBytes: 2048,
    contentHash: null,
    storageProvider: 's3',
    storageKey: 'uploads/att-route-1.pdf',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    processingMode: 'full',
    scanStatus: 'clean',
    scanEngine: 'clamav',
    scannedAt: new Date(),
    hasPII: false,
    piiDetections: [],
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: 'Extracted document text',
    processedContentHash: null,
    processingError: null,
    processingEngine: 'docling',
    processedAt: new Date(),
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'completed',
    embeddedAt: new Date(),
    retryCount: 0,
    expiresAt: new Date('2026-06-01'),
    createdAt: new Date(),
    updatedAt: new Date(),
    _v: 1,
    ...overrides,
  } as IAttachment;
}

function createMockClient(): AttachmentServiceClient {
  return {
    getAttachment: vi.fn().mockResolvedValue(mockAttachment()),
    listBySession: vi.fn().mockResolvedValue([]),
    getDownloadUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/doc.pdf'),
    upload: vi.fn(),
    retry: vi.fn(),
  };
}

function createExecutor(client?: AttachmentServiceClient, destinations?: unknown[]) {
  const serviceClient = client ?? createMockClient();
  const executor = new AttachmentToolExecutor({
    serviceClient,
    destinations: destinations as undefined,
  });
  return { executor, serviceClient };
}

// Mock fetch for route_attachment HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AttachmentToolExecutor — route_attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ received: true }),
      text: async () => 'OK',
    });
  });

  describe('3-U12: Route to named destination', () => {
    it('should send HTTP request to named destination URL', async () => {
      const destinations = [
        {
          name: 'doc_processor',
          url: 'https://api.docprocessor.com/ingest',
          method: 'POST',
        },
      ];

      const { executor } = createExecutor(undefined, destinations);

      const result = await executor.execute(
        'route_attachment',
        { attachment_id: 'att-route-1', destination: 'doc_processor' },
        DEFAULT_CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.docprocessor.com/ingest',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('3-U14: Route to SSRF URL → error', () => {
    it('should reject private/internal IP destinations', async () => {
      const destinations = [
        {
          name: 'internal',
          url: 'http://169.254.169.254/latest/meta-data/',
          method: 'POST',
        },
      ];

      const { executor } = createExecutor(undefined, destinations);

      const result = await executor.execute(
        'route_attachment',
        { attachment_id: 'att-route-1', destination: 'internal' },
        DEFAULT_CONTEXT,
      );

      expect(result.success).toBe(false);
      if ('error' in result) {
        expect(
          (result.error as { code: string }).code === 'SSRF_BLOCKED' ||
            (result.error as { message: string }).message.toLowerCase().includes('not allowed'),
        ).toBe(true);
      }
    });
  });

  describe('3-U15: Unknown destination name → error', () => {
    it('should return error for unregistered destination name', async () => {
      const destinations = [
        {
          name: 'known',
          url: 'https://api.example.com/ingest',
          method: 'POST',
        },
      ];

      const { executor } = createExecutor(undefined, destinations);

      const result = await executor.execute(
        'route_attachment',
        { attachment_id: 'att-route-1', destination: 'unknown_dest' },
        DEFAULT_CONTEXT,
      );

      expect(result.success).toBe(false);
      if ('error' in result) {
        expect(
          (result.error as { code: string }).code === 'UNKNOWN_DESTINATION' ||
            (result.error as { message: string }).message.toLowerCase().includes('unknown'),
        ).toBe(true);
      }
    });
  });

  describe('3-U16: Route with auth header', () => {
    it('should include Authorization header when destination has auth', async () => {
      const destinations = [
        {
          name: 'secured',
          url: 'https://api.secure.com/upload',
          method: 'POST',
          auth: 'bearer_token',
          headers: { Authorization: 'Bearer test-token-123' },
        },
      ];

      const { executor } = createExecutor(undefined, destinations);

      const result = await executor.execute(
        'route_attachment',
        { attachment_id: 'att-route-1', destination: 'secured' },
        DEFAULT_CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.secure.com/upload',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
          }),
        }),
      );
    });
  });

  describe('3-U17: Destination returns error → tool returns error envelope', () => {
    it('should return structured error when destination HTTP call fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Service down',
      });

      const destinations = [
        {
          name: 'flaky',
          url: 'https://api.flaky.com/upload',
          method: 'POST',
        },
      ];

      const { executor } = createExecutor(undefined, destinations);

      const result = await executor.execute(
        'route_attachment',
        { attachment_id: 'att-route-1', destination: 'flaky' },
        DEFAULT_CONTEXT,
      );

      expect(result.success).toBe(false);
      if ('error' in result) {
        expect(
          (result.error as { code: string }).code === 'DESTINATION_ERROR' ||
            (result.error as { message: string }).message.includes('503'),
        ).toBe(true);
      }
    });
  });

  describe('isAttachmentTool includes route_attachment', () => {
    it('should recognize route_attachment as an attachment tool', () => {
      expect(isAttachmentTool('route_attachment')).toBe(true);
    });
  });
});
