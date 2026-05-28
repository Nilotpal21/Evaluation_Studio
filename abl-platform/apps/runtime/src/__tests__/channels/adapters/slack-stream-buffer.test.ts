/**
 * Slack Stream Buffer Tests
 *
 * Tests chunk buffering, backpressure, citation safety,
 * and stream lifecycle (start → append → stop).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the stream client before importing the buffer
vi.mock('../../../channels/adapters/slack-stream-client.js', () => ({
  startStream: vi.fn(),
  appendStream: vi.fn(),
  stopStream: vi.fn(),
}));

import { SlackStreamBuffer } from '../../../channels/adapters/slack-stream-buffer.js';
import {
  startStream,
  appendStream,
  stopStream,
} from '../../../channels/adapters/slack-stream-client.js';

const mockStart = vi.mocked(startStream);
const mockAppend = vi.mocked(appendStream);
const mockStop = vi.mocked(stopStream);

const TOKEN = 'xoxb-test';
const CHANNEL = 'C123';
const THREAD = '111.222';

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockResolvedValue({ ok: true, ts: '333.444' });
  mockAppend.mockResolvedValue({ ok: true });
  mockStop.mockResolvedValue({ ok: true, ts: '333.444' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SlackStreamBuffer', () => {
  describe('buffering', () => {
    it('does not flush when buffer is below chunkSize', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 100 });

      await buffer.onChunk('hello'); // 5 chars — well below 100

      expect(mockStart).not.toHaveBeenCalled();
      expect(mockAppend).not.toHaveBeenCalled();
      expect(buffer.isStarted).toBe(false);
    });

    it('flushes when buffer exceeds chunkSize', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 10 });

      await buffer.onChunk('a'.repeat(15));

      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledWith(TOKEN, CHANNEL, THREAD, {
        teamId: undefined,
        userId: undefined,
        apiBase: undefined,
      });
      expect(mockAppend).toHaveBeenCalledOnce();
      expect(mockAppend).toHaveBeenCalledWith(TOKEN, CHANNEL, '333.444', 'a'.repeat(15), {
        apiBase: undefined,
      });
      expect(buffer.isStarted).toBe(true);
    });

    it('accumulates multiple small chunks before flushing', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 10 });

      await buffer.onChunk('abc'); // 3 chars
      await buffer.onChunk('def'); // 6 chars
      expect(mockStart).not.toHaveBeenCalled();

      await buffer.onChunk('ghijklmno'); // 15 chars — exceeds 10
      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockAppend).toHaveBeenCalledWith(TOKEN, CHANNEL, '333.444', 'abcdefghijklmno', {
        apiBase: undefined,
      });
    });
  });

  describe('stream lifecycle', () => {
    it('starts stream only once across multiple flushes', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('a'.repeat(10)); // flush 1
      await buffer.onChunk('b'.repeat(10)); // flush 2

      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockAppend).toHaveBeenCalledTimes(2);
    });

    it('close() calls stopStream with remaining text', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 100 });

      await buffer.onChunk('partial text'); // below chunkSize, stays in buffer

      // Force stream start by flushing a large chunk
      await buffer.onChunk('x'.repeat(100));

      // Add more text that won't trigger a flush
      await buffer.onChunk(' tail');

      await buffer.close();

      expect(mockStop).toHaveBeenCalledOnce();
      expect(mockStop).toHaveBeenCalledWith(TOKEN, CHANNEL, '333.444', {
        markdownText: ' tail',
        blocks: undefined,
        apiBase: undefined,
      });
    });

    it('close() passes blocks to stopStream', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('a'.repeat(10)); // starts stream

      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Sources' } }];
      await buffer.close(blocks);

      expect(mockStop).toHaveBeenCalledWith(TOKEN, CHANNEL, '333.444', {
        markdownText: undefined,
        blocks,
        apiBase: undefined,
      });
    });

    it('close() is a no-op when stream was never started', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 100 });

      await buffer.onChunk('tiny'); // below chunkSize
      await buffer.close();

      expect(mockStop).not.toHaveBeenCalled();
      expect(buffer.isStarted).toBe(false);
    });

    it('ignores chunks after close', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('a'.repeat(10)); // starts stream
      await buffer.close();

      await buffer.onChunk('b'.repeat(100)); // should be ignored

      expect(mockAppend).toHaveBeenCalledOnce(); // Only from first flush
    });
  });

  describe('citation safety', () => {
    it('does not flush when buffer ends with partial citation [doc-', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('some text [doc-'); // 15 chars, exceeds chunkSize

      // Should NOT flush because buffer ends with partial citation
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('does not flush when buffer ends with [', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('some text ['); // ends with [

      expect(mockStart).not.toHaveBeenCalled();
    });

    it('does not flush when buffer ends with [d', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('some text [d');

      expect(mockStart).not.toHaveBeenCalled();
    });

    it('flushes when citation is complete [doc-1]', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      await buffer.onChunk('text [doc-1] more text');

      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockAppend).toHaveBeenCalledOnce();
    });

    it('flushes partial citation on close()', async () => {
      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      // First trigger a stream start with a clean chunk
      await buffer.onChunk('a'.repeat(10));

      // Then add text ending with partial citation
      await buffer.onChunk(' [doc-');

      await buffer.close();

      // stopStream should include the partial citation text
      expect(mockStop).toHaveBeenCalledWith(TOKEN, CHANNEL, '333.444', {
        markdownText: ' [doc-',
        blocks: undefined,
        apiBase: undefined,
      });
    });
  });

  describe('backpressure', () => {
    it('does not send concurrent Slack API calls', async () => {
      let resolveAppend!: (value: any) => void;
      const appendPromise = new Promise((resolve) => {
        resolveAppend = resolve;
      });
      mockAppend.mockReturnValueOnce(appendPromise as any);

      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      // First chunk triggers flush — startStream resolves (microtask), then
      // appendStream gets the pending promise.
      const flushPromise = buffer.onChunk('a'.repeat(10));

      // 'b' arrives before appendStream's pending promise resolves (during startStream microtask)
      // 'c' arrives while appendStream is in-flight
      await buffer.onChunk('b'.repeat(10));
      await buffer.onChunk('c'.repeat(10));

      // Only 1 appendStream call so far (the in-flight one)
      expect(mockAppend).toHaveBeenCalledTimes(1);

      // Resolve the in-flight request — buffer should drain remaining chunks
      resolveAppend!({ ok: true });
      await flushPromise;

      // All text should have been sent across append calls (order preserved)
      const allAppendedText = mockAppend.mock.calls.map((c) => c[3]).join('');
      expect(allAppendedText).toBe('a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(10));
    });
  });

  describe('error handling', () => {
    it('handles startStream failure gracefully', async () => {
      mockStart.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' });

      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      // Should not throw
      await buffer.onChunk('a'.repeat(10));

      expect(buffer.isStarted).toBe(false);
      expect(mockAppend).not.toHaveBeenCalled();
    });

    it('handles appendStream failure gracefully', async () => {
      mockAppend.mockResolvedValueOnce({ ok: false, error: 'invalid_auth' });

      const buffer = new SlackStreamBuffer(TOKEN, CHANNEL, THREAD, { chunkSize: 5 });

      // Should not throw
      await buffer.onChunk('a'.repeat(10));

      expect(buffer.isStarted).toBe(true);
    });
  });
});
