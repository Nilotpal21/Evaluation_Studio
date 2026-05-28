/**
 * SearchAIAwareToolExecutor Tests
 *
 * Verifies routing logic: search tools -> SearchAIToolHandler,
 * attachment tools -> AttachmentToolExecutor, all others -> inner executor.
 * Tests both execute() and executeParallel() paths including the
 * optional attachment executor behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchAIAwareToolExecutor } from '../search-ai-tool-executor.js';
import type { ToolExecutor } from '@abl/compiler/platform';
import type {
  AttachmentToolExecutor,
  AttachmentToolContext,
} from '../../../tools/attachment-tool-executor.js';

// ─── Mock SearchAIClient ─────────────────────────────────────────────────────

vi.mock('@agent-platform/search-ai-sdk', () => {
  class MockSearchAIClient {
    vectorSearch = vi.fn();
    structuredSearch = vi.fn();
    aggregate = vi.fn();
    resolveVocabulary = vi.fn();
  }
  return { SearchAIClient: MockSearchAIClient };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEARCH_CONFIG = {
  runtimeUrl: 'http://localhost:3004',
  engineUrl: 'http://localhost:3005',
  timeoutMs: 5_000,
};

const ATTACHMENT_CONTEXT: AttachmentToolContext = {
  tenantId: 'tenant-001',
  sessionId: 'sess-001',
  projectId: 'proj-001',
};

function createMockInnerExecutor(): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ result: 'inner-result' }),
    executeParallel: vi.fn().mockResolvedValue([]),
  };
}

function createMockAttachmentExecutor(): AttachmentToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ id: 'att-1', filename: 'file.pdf' }),
  } as unknown as AttachmentToolExecutor;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SearchAIAwareToolExecutor', () => {
  let innerExecutor: ToolExecutor;

  beforeEach(() => {
    innerExecutor = createMockInnerExecutor();
  });

  // ── execute() routing ───────────────────────────────────────────────────

  describe('execute() routing', () => {
    it('delegates non-search, non-attachment tools to inner executor', async () => {
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG);

      const result = await executor.execute('some_custom_tool', { key: 'val' }, 5000);

      expect(innerExecutor.execute).toHaveBeenCalledWith('some_custom_tool', { key: 'val' }, 5000);
      expect(result).toEqual({ result: 'inner-result' });
    });

    it('routes attachment tools to AttachmentToolExecutor when provided', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      const result = await executor.execute('get_attachment', { attachmentId: 'att-1' }, 5000);

      expect(attachmentExecutor.execute).toHaveBeenCalledWith(
        'get_attachment',
        { attachmentId: 'att-1' },
        ATTACHMENT_CONTEXT,
      );
      expect(innerExecutor.execute).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'att-1', filename: 'file.pdf' });
    });

    it('routes list_attachments to AttachmentToolExecutor when provided', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      vi.mocked(attachmentExecutor.execute).mockResolvedValue({
        attachments: [],
        total: 0,
      });
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      const result = await executor.execute('list_attachments', {}, 5000);

      expect(attachmentExecutor.execute).toHaveBeenCalledWith(
        'list_attachments',
        {},
        ATTACHMENT_CONTEXT,
      );
      expect(innerExecutor.execute).not.toHaveBeenCalled();
      expect(result).toEqual({ attachments: [], total: 0 });
    });

    it('falls through to inner executor for attachment tools when executor not provided', async () => {
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG);

      await executor.execute('get_attachment', { attachmentId: 'att-1' }, 5000);

      expect(innerExecutor.execute).toHaveBeenCalledWith(
        'get_attachment',
        { attachmentId: 'att-1' },
        5000,
      );
    });

    it('falls through to inner executor for attachment tools when context not provided', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        // no attachmentContext
      });

      await executor.execute('get_attachment', { attachmentId: 'att-1' }, 5000);

      expect(innerExecutor.execute).toHaveBeenCalledWith(
        'get_attachment',
        { attachmentId: 'att-1' },
        5000,
      );
      expect(attachmentExecutor.execute).not.toHaveBeenCalled();
    });
  });

  // ── executeParallel() routing ─────────────────────────────────────────

  describe('executeParallel() routing', () => {
    it('routes attachment calls separately in parallel', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      vi.mocked(attachmentExecutor.execute).mockResolvedValue({
        id: 'att-1',
        filename: 'file.pdf',
      });

      vi.mocked(innerExecutor.executeParallel).mockResolvedValue([
        { name: 'custom_tool', result: 'custom-result' },
      ]);

      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      const results = await executor.executeParallel(
        [
          { name: 'custom_tool', params: { x: 1 } },
          { name: 'get_attachment', params: { attachmentId: 'att-1' } },
        ],
        5000,
      );

      // Both should be routed correctly
      expect(attachmentExecutor.execute).toHaveBeenCalledWith(
        'get_attachment',
        { attachmentId: 'att-1' },
        ATTACHMENT_CONTEXT,
      );
      expect(innerExecutor.executeParallel).toHaveBeenCalledWith(
        [{ name: 'custom_tool', params: { x: 1 } }],
        5000,
      );

      // Results should be in original call order
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ name: 'custom_tool', result: 'custom-result' });
      expect(results[1]).toEqual({
        name: 'get_attachment',
        result: { id: 'att-1', filename: 'file.pdf' },
      });
    });

    it('falls through attachment tools to inner when executor not provided', async () => {
      vi.mocked(innerExecutor.executeParallel).mockResolvedValue([
        { name: 'get_attachment', result: 'from-inner' },
      ]);

      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG);

      const results = await executor.executeParallel(
        [{ name: 'get_attachment', params: { attachmentId: 'att-1' } }],
        5000,
      );

      // Should delegate to inner executor since no attachment executor
      expect(innerExecutor.executeParallel).toHaveBeenCalledWith(
        [{ name: 'get_attachment', params: { attachmentId: 'att-1' } }],
        5000,
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'get_attachment', result: 'from-inner' });
    });

    it('handles attachment executor errors gracefully in parallel', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      vi.mocked(attachmentExecutor.execute).mockRejectedValue(new Error('Service unavailable'));

      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      const results = await executor.executeParallel(
        [{ name: 'get_attachment', params: { attachmentId: 'att-1' } }],
        5000,
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        name: 'get_attachment',
        error: 'Service unavailable',
      });
    });

    it('handles multiple attachment calls in parallel', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      vi.mocked(attachmentExecutor.execute)
        .mockResolvedValueOnce({ id: 'att-1', filename: 'a.pdf' })
        .mockResolvedValueOnce({ attachments: [], total: 0 });

      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      const results = await executor.executeParallel(
        [
          { name: 'get_attachment', params: { attachmentId: 'att-1' } },
          { name: 'list_attachments', params: {} },
        ],
        5000,
      );

      expect(attachmentExecutor.execute).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        name: 'get_attachment',
        result: { id: 'att-1', filename: 'a.pdf' },
      });
      expect(results[1]).toEqual({
        name: 'list_attachments',
        result: { attachments: [], total: 0 },
      });
    });

    it('does not call inner.executeParallel when all calls are attachment or search', async () => {
      const attachmentExecutor = createMockAttachmentExecutor();
      vi.mocked(attachmentExecutor.execute).mockResolvedValue({ id: 'att-1' });

      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {
        attachmentToolExecutor: attachmentExecutor,
        attachmentContext: ATTACHMENT_CONTEXT,
      });

      await executor.executeParallel(
        [{ name: 'get_attachment', params: { attachmentId: 'att-1' } }],
        5000,
      );

      expect(innerExecutor.executeParallel).not.toHaveBeenCalled();
    });
  });

  // ── Constructor options ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('works without attachment options (backward compatible)', async () => {
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG);

      // Should not throw
      await executor.execute('some_tool', {}, 5000);
      expect(innerExecutor.execute).toHaveBeenCalled();
    });

    it('works with empty opts object', async () => {
      const executor = new SearchAIAwareToolExecutor(innerExecutor, SEARCH_CONFIG, {});

      await executor.execute('get_attachment', { attachmentId: 'att-1' }, 5000);
      // Falls through to inner since no attachment executor
      expect(innerExecutor.execute).toHaveBeenCalled();
    });
  });
});
