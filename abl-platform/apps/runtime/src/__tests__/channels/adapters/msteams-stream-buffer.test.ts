/**
 * MS Teams Stream Buffer Tests
 *
 * Tests time-based flushing, backpressure, append-only content delivery,
 * auto-finalize guard, and stream lifecycle (startStream → continueStream → finalizeStream).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the stream client before importing the buffer
vi.mock('../../../channels/adapters/msteams-stream-client.js', () => ({
  startStream: vi.fn(),
  continueStream: vi.fn(),
  finalizeStream: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { MSTeamsStreamBuffer } from '../../../channels/adapters/msteams-stream-buffer.js';
import {
  startStream,
  continueStream,
  finalizeStream,
} from '../../../channels/adapters/msteams-stream-client.js';

const mockStart = vi.mocked(startStream);
const mockContinue = vi.mocked(continueStream);
const mockFinalize = vi.mocked(finalizeStream);

const TOKEN = 'test-bearer-token';
const SERVICE_URL = 'https://smba.trafficmanager.net/teams';
const CONVERSATION_ID = 'conv-123';
const ACTIVITY_ID = 'act-456';
const STREAM_ID = 'stream-789';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockStart.mockResolvedValue({ streamId: STREAM_ID });
  mockContinue.mockResolvedValue(undefined);
  mockFinalize.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MSTeamsStreamBuffer', () => {
  describe('informative update on first chunk', () => {
    it('sends informative update via startStream on first onChunk call', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        'Generating response...',
        'informative',
      );
      expect(buffer.isStarted).toBe(true);
    });

    it('uses default informative message when not specified', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      expect(mockStart).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        'Generating response...',
        'informative',
      );
    });

    it('uses custom informative message when specified', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        informativeMessage: 'Thinking hard...',
      });

      await buffer.onChunk('Hello');

      expect(mockStart).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        'Thinking hard...',
        'informative',
      );
    });

    it('only sends startStream once across multiple chunks', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');
      await buffer.onChunk(' world');
      await buffer.onChunk('!');

      expect(mockStart).toHaveBeenCalledOnce();
    });
  });

  describe('time-based flushing', () => {
    it('flushes accumulated text after flush interval', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 2000,
      });

      await buffer.onChunk('Hello');
      await buffer.onChunk(' world');

      // No continueStream yet — interval hasn't fired
      expect(mockContinue).not.toHaveBeenCalled();

      // Advance past the flush interval
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockContinue).toHaveBeenCalledOnce();
      expect(mockContinue).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello world',
        'streaming',
        2,
      );
    });

    it('sends append-only content (full text each time, not delta)', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // First tick
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockContinue).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello',
        'streaming',
        2,
      );

      await buffer.onChunk(' world');

      // Second tick — should send FULL text, not just " world"
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockContinue).toHaveBeenCalledTimes(2);
      expect(mockContinue).toHaveBeenLastCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello world',
        'streaming',
        3,
      );
    });

    it('skips flush tick when no new content', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // First tick — flushes "Hello"
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce();

      // Second tick — no new content, should skip
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce(); // Still 1
    });

    it('increments streamSequence on each flush', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('a');
      await vi.advanceTimersByTimeAsync(1000); // sequence 2

      await buffer.onChunk('b');
      await vi.advanceTimersByTimeAsync(1000); // sequence 3

      await buffer.onChunk('c');
      await vi.advanceTimersByTimeAsync(1000); // sequence 4

      expect(mockContinue).toHaveBeenCalledTimes(3);
      expect(mockContinue.mock.calls[0][7]).toBe(2);
      expect(mockContinue.mock.calls[1][7]).toBe(3);
      expect(mockContinue.mock.calls[2][7]).toBe(4);
    });
  });

  describe('backpressure', () => {
    it('skips tick when a request is in-flight', async () => {
      // Make continueStream take a very long time (never resolves in this test)
      // to keep pendingRequest = true across multiple interval ticks.
      mockContinue.mockReturnValue(new Promise<void>(() => {}));

      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // First tick — starts an in-flight continueStream call (pending forever)
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce();

      // Add more content while the first request is still in-flight
      await buffer.onChunk(' world');

      // Second tick — should be skipped because first request is in-flight
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce(); // Still 1

      // Third tick — still in-flight, still skipped
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce(); // Still 1

      // Fourth tick — still in-flight, still skipped
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce(); // Still 1
    });
  });

  describe('close()', () => {
    it('flushes remaining text and calls finalizeStream', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 2000,
      });

      await buffer.onChunk('Hello world');
      // Don't advance timer — text is still in buffer

      await buffer.close();

      expect(mockFinalize).toHaveBeenCalledOnce();
      expect(mockFinalize).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello world',
        undefined,
      );
    });

    it('passes attachments to finalizeStream', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      const attachments = [
        { contentType: 'application/vnd.microsoft.card.adaptive', content: { body: [] } },
      ];
      await buffer.close(attachments);

      expect(mockFinalize).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello',
        attachments,
      );
    });

    it('clears the interval timer', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // First tick — starts flush
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockContinue).toHaveBeenCalledOnce();

      await buffer.onChunk(' more');
      await buffer.close();

      // Advance more time — should not trigger any additional continueStream calls
      await vi.advanceTimersByTimeAsync(5000);

      // Only the one from the tick before close, no more
      expect(mockContinue).toHaveBeenCalledOnce();
    });

    it('is a no-op when stream was never started (e.g. startStream failed)', async () => {
      mockStart.mockRejectedValueOnce(new Error('startStream failed'));

      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello'); // startStream fails

      expect(buffer.isStarted).toBe(false);

      await buffer.close();

      expect(mockFinalize).not.toHaveBeenCalled();
      expect(mockContinue).not.toHaveBeenCalled();
    });

    it('is idempotent — calling close() twice does not throw or double-finalize', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      await buffer.close();
      await buffer.close();

      expect(mockFinalize).toHaveBeenCalledOnce();
    });

    it('skips finalizeStream when the stream has failed', async () => {
      mockContinue.mockRejectedValueOnce(new Error('API error'));

      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // Tick triggers continueStream which throws, marking buffer as failed
      await vi.advanceTimersByTimeAsync(1000);

      await buffer.close();

      // finalizeStream should NOT be called — the stream is in a broken state
      expect(mockFinalize).not.toHaveBeenCalled();
    });

    it('ignores chunks after close', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');
      await buffer.close();

      await buffer.onChunk(' should be ignored');

      // startStream was called once for the initial chunk
      expect(mockStart).toHaveBeenCalledOnce();
      // finalizeStream was called once during close
      expect(mockFinalize).toHaveBeenCalledOnce();
      // Text in finalizeStream should only be "Hello"
      expect(mockFinalize).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello',
        undefined,
      );
    });
  });

  describe('auto-finalize guard', () => {
    it('auto-finalizes when approaching the 2-minute limit', async () => {
      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      // Advance to just past the 110-second auto-finalize threshold
      await vi.advanceTimersByTimeAsync(110_000);

      expect(mockFinalize).toHaveBeenCalledOnce();
      expect(mockFinalize).toHaveBeenCalledWith(
        TOKEN,
        SERVICE_URL,
        CONVERSATION_ID,
        ACTIVITY_ID,
        STREAM_ID,
        'Hello',
        undefined,
      );
    });
  });

  describe('error handling', () => {
    it('marks buffer as failed when startStream throws', async () => {
      mockStart.mockRejectedValueOnce(new Error('Network error'));

      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID);

      await buffer.onChunk('Hello');

      expect(buffer.isStarted).toBe(false);

      // Subsequent chunks should be ignored
      await buffer.onChunk(' more text');
      expect(mockStart).toHaveBeenCalledOnce(); // No retry
    });

    it('marks buffer as failed when continueStream throws', async () => {
      mockContinue.mockRejectedValueOnce(new Error('API error'));

      const buffer = new MSTeamsStreamBuffer(TOKEN, SERVICE_URL, CONVERSATION_ID, ACTIVITY_ID, {
        flushIntervalMs: 1000,
      });

      await buffer.onChunk('Hello');

      // Tick triggers continueStream which throws
      await vi.advanceTimersByTimeAsync(1000);

      // Subsequent chunks should be ignored due to failure
      await buffer.onChunk(' more text');
      await vi.advanceTimersByTimeAsync(1000);

      // Only one continueStream call — the failed one
      expect(mockContinue).toHaveBeenCalledOnce();
    });
  });
});
