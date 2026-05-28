/**
 * Slack Stream Buffer
 *
 * Manages chunk buffering and backpressure for streaming LLM responses to Slack.
 *
 * Flow:
 *   1. LLM emits text deltas via onChunk() callback
 *   2. Buffer accumulates text until it exceeds chunkSize
 *   3. First flush calls startStream() to open the streaming message
 *   4. Subsequent flushes call appendStream() to deliver text incrementally
 *   5. close() flushes any remaining buffer and calls stopStream() with final blocks
 *
 * Backpressure: A pendingRequest lock prevents concurrent Slack API calls.
 * While a call is in-flight, chunks accumulate in the buffer. When the call
 * completes, the buffer is drained if it still exceeds chunkSize.
 *
 * Stream rotation: Slack imposes a total message size limit (~12,000 chars).
 * When approaching this limit, the current stream is stopped and a new one is
 * opened in the same thread, allowing arbitrarily long responses.
 *
 * Citation safety: Won't flush if buffer ends with a partial citation reference
 * like `[doc-` to avoid splitting markdown references across chunks.
 */

import { createLogger } from '@abl/compiler/platform';
import { startStream, appendStream, stopStream } from './slack-stream-client.js';
import {
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('slack-stream-buffer');

/** Matches partial citation at end of buffer: `[`, `[d`, `[do`, `[doc`, `[doc-`, `[doc-123` (no closing `]`) */
const PARTIAL_CITATION_RE = /\[(?:\d+|d(?:o(?:c(?:-\d*)?)?)?)?$/;

const DEFAULT_CHUNK_SIZE = 500;
const CLOSE_POLL_INTERVAL_MS = 50;
const CLOSE_MAX_WAIT_MS = 15_000;
/**
 * Slack total message limit for streaming. When totalCharsSent approaches this,
 * the current stream is rotated (stopped and a new one opened).
 * Slack returns msg_too_long around 12,000 chars; use 10,000 as a safe threshold.
 */
const SLACK_STREAM_ROTATE_THRESHOLD = 10_000;

export interface SlackStreamBufferOptions {
  /** Minimum chars before flushing to Slack. Default: 500. */
  chunkSize?: number;
  /** Slack Web API base URL. Defaults to Slack cloud API. */
  apiBase?: string;
}

export class SlackStreamBuffer {
  private readonly botToken: string;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly teamId: string | undefined;
  private readonly userId: string | undefined;
  private readonly chunkSize: number;
  private readonly apiBase: string | undefined;

  private buffer = '';
  private streamTs: string | null = null;
  private pendingRequest = false;
  private closed = false;
  private failed = false;
  /** Chars appended to the current stream (resets on rotation). */
  private currentStreamChars = 0;

  constructor(
    botToken: string,
    channel: string,
    threadTs: string,
    options?: SlackStreamBufferOptions & { teamId?: string; userId?: string },
  ) {
    this.botToken = botToken;
    this.channel = channel;
    this.threadTs = threadTs;
    this.teamId = options?.teamId;
    this.userId = options?.userId;
    this.chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.apiBase = options?.apiBase;
  }

  /** Whether startStream has been called and a stream is open. */
  get isStarted(): boolean {
    return this.streamTs !== null;
  }

  /**
   * Wait for any in-flight flush/startStream/appendStream operation to complete.
   * Call this before checking `isStarted` to avoid race conditions where
   * startStream is still in-flight but hasn't set `streamTs` yet.
   */
  async settle(): Promise<void> {
    let waitedMs = 0;
    while (this.pendingRequest && waitedMs < CLOSE_MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      waitedMs += CLOSE_POLL_INTERVAL_MS;
    }
  }

  /**
   * Accept a text chunk from the LLM. Buffers internally and flushes to Slack
   * when the buffer exceeds chunkSize (respecting backpressure and citation safety).
   */
  async onChunk(chunk: string): Promise<void> {
    if (this.closed || this.failed) return;

    this.buffer += chunk;

    if (this.pendingRequest) return; // In-flight call — buffer will drain on completion
    if (this.buffer.length <= this.chunkSize) return; // Not enough to flush yet
    if (PARTIAL_CITATION_RE.test(this.buffer)) return; // Don't split mid-citation

    await this.flush();
  }

  /**
   * Close the stream. Flushes any remaining buffer and calls stopStream with
   * optional Block Kit blocks (sources, action buttons, etc.).
   */
  async close(blocks?: unknown[]): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Wait for any in-flight request to complete (bounded)
    let waitedMs = 0;
    while (this.pendingRequest && waitedMs < CLOSE_MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      waitedMs += CLOSE_POLL_INTERVAL_MS;
    }
    if (this.pendingRequest) {
      log.warn('Timed out waiting for in-flight Slack request during close', {
        channel: this.channel,
      });
    }

    if (!this.streamTs) {
      // Stream was never opened (response was very short) — nothing to close.
      // The caller should fall back to a regular chat.postMessage.
      return;
    }

    try {
      // Flush remaining buffer, rotating streams as needed
      while (this.buffer.length > 0) {
        const remaining = SLACK_STREAM_ROTATE_THRESHOLD - this.currentStreamChars;
        if (remaining <= 0) {
          await this.rotateStream();
          continue;
        }
        const text = this.buffer.slice(0, remaining);
        this.buffer = this.buffer.slice(text.length);
        this.currentStreamChars += text.length;

        if (this.buffer.length === 0) {
          // Last piece — send via stopStream with blocks
          await stopStream(this.botToken, this.channel, this.streamTs!, {
            markdownText: text || undefined,
            blocks,
            apiBase: this.apiBase,
          });
          return;
        }

        const resp = await appendStream(this.botToken, this.channel, this.streamTs!, text, {
          apiBase: this.apiBase,
        });
        if (!resp.ok) {
          log.error('Failed to append remaining buffer during close', {
            ...buildChannelDeliveryLogContext({
              channelType: 'slack',
              provider: 'slack',
              code: 'CHANNEL_PROVIDER_REJECTED',
              providerErrorCode: resp.error,
            }),
            channel: this.channel,
          });
          break;
        }
      }

      // Buffer was empty or fully drained — just stop the stream
      await stopStream(this.botToken, this.channel, this.streamTs!, {
        blocks,
        apiBase: this.apiBase,
      });
    } catch (error) {
      log.error('Failed to close Slack stream', {
        ...buildChannelDeliveryLogContext({
          channelType: 'slack',
          provider: 'slack',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        channel: this.channel,
      });
    }
  }

  /**
   * Stop the current stream and open a new one in the same thread.
   * Resets currentStreamChars so the new stream has a fresh budget.
   */
  private async rotateStream(): Promise<void> {
    if (this.streamTs) {
      await stopStream(this.botToken, this.channel, this.streamTs, {
        apiBase: this.apiBase,
      });
      this.streamTs = null;
      this.currentStreamChars = 0;
    }

    const resp = await startStream(this.botToken, this.channel, this.threadTs, {
      teamId: this.teamId,
      userId: this.userId,
      apiBase: this.apiBase,
    });
    if (!resp.ok || !resp.ts) {
      log.error('Failed to start rotated Slack stream', {
        ...buildChannelDeliveryLogContext({
          channelType: 'slack',
          provider: 'slack',
          code: 'CHANNEL_PROVIDER_REJECTED',
          providerErrorCode: resp.error,
        }),
        channel: this.channel,
      });
      this.failed = true;
      return;
    }
    this.streamTs = resp.ts;
    log.info('Slack stream rotated', { channel: this.channel });
  }

  /**
   * Internal flush: sends buffered text to Slack. Opens the stream on first call.
   * Drains in a loop if more data accumulated during the API call.
   * Rotates the stream when approaching Slack's total message size limit.
   */
  private async flush(): Promise<void> {
    this.pendingRequest = true;

    try {
      // Open stream on first flush
      if (!this.streamTs) {
        const resp = await startStream(this.botToken, this.channel, this.threadTs, {
          teamId: this.teamId,
          userId: this.userId,
          apiBase: this.apiBase,
        });
        if (!resp.ok || !resp.ts) {
          log.error('Failed to start Slack stream', {
            ...buildChannelDeliveryLogContext({
              channelType: 'slack',
              provider: 'slack',
              code: 'CHANNEL_PROVIDER_REJECTED',
              providerErrorCode: resp.error,
            }),
            channel: this.channel,
          });
          this.failed = true;
          this.pendingRequest = false;
          return;
        }
        this.streamTs = resp.ts;
      }

      // Drain loop: keep flushing while buffer has data
      while (this.buffer.length > 0) {
        // Check if we need to rotate to a new stream
        const remaining = SLACK_STREAM_ROTATE_THRESHOLD - this.currentStreamChars;
        if (remaining <= 0) {
          await this.rotateStream();
          if (this.failed) break;
          continue;
        }

        // Take at most `remaining` chars from the buffer
        const text = this.buffer.slice(0, remaining);
        this.buffer = this.buffer.slice(text.length);
        this.currentStreamChars += text.length;

        const resp = await appendStream(this.botToken, this.channel, this.streamTs!, text, {
          apiBase: this.apiBase,
        });
        if (!resp.ok) {
          log.error('Failed to append to Slack stream', {
            ...buildChannelDeliveryLogContext({
              channelType: 'slack',
              provider: 'slack',
              code: 'CHANNEL_PROVIDER_REJECTED',
              providerErrorCode: resp.error,
            }),
            channel: this.channel,
            currentStreamChars: this.currentStreamChars,
          });
          this.failed = true;
          break;
        }

        // If more data accumulated during the API call, check if we should flush again
        if (this.buffer.length <= this.chunkSize) break;
        if (PARTIAL_CITATION_RE.test(this.buffer)) break;
      }
    } catch (error) {
      log.error('Error flushing Slack stream buffer', {
        ...buildChannelDeliveryLogContext({
          channelType: 'slack',
          provider: 'slack',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        channel: this.channel,
      });
      this.failed = true;
    } finally {
      this.pendingRequest = false;
    }
  }
}
