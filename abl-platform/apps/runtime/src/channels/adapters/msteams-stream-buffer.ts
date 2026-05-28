/**
 * MS Teams Stream Buffer
 *
 * Manages time-based buffering and backpressure for streaming LLM responses to
 * Microsoft Teams via the Bot Framework streaming protocol.
 *
 * Flow:
 *   1. LLM emits text deltas via onChunk() callback
 *   2. First onChunk() call sends an informative update via startStream()
 *   3. A 2-second interval timer flushes accumulated text via continueStream()
 *   4. close() clears timers, flushes remaining buffer, and calls finalizeStream()
 *
 * Key differences from SlackStreamBuffer:
 *   - Time-based flushing (2s intervals) instead of character-based flushing,
 *     because Teams throttles at 1 req/sec.
 *   - Append-only content: each flush sends the full accumulated text, not a delta,
 *     as required by the Teams streaming protocol.
 *   - 2-minute streaming guard: auto-finalizes at 110 seconds to stay within
 *     the Teams 2-minute streaming window.
 */

import { createLogger } from '@abl/compiler/platform';
import { startStream, continueStream, finalizeStream } from './msteams-stream-client.js';
import {
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('msteams-stream-buffer');

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_INFORMATIVE_MESSAGE = 'Generating response...';
const AUTO_FINALIZE_MS = 110_000;
const CLOSE_POLL_INTERVAL_MS = 50;
const CLOSE_MAX_WAIT_MS = 15_000;

export interface MSTeamsStreamBufferOptions {
  /** Interval in ms between flush ticks. Default: 2000. */
  flushIntervalMs?: number;
  /** Text shown during the informative phase before streaming begins. */
  informativeMessage?: string;
}

export class MSTeamsStreamBuffer {
  private readonly token: string;
  private readonly serviceUrl: string;
  private readonly conversationId: string;
  private readonly activityId: string;
  private readonly flushIntervalMs: number;
  private readonly informativeMessage: string;

  private streamId: string | null = null;
  private fullText = '';
  private lastFlushedLength = 0;
  private streamSequence = 1;
  private pendingRequest = false;
  private closed = false;
  private failed = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private autoFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    token: string,
    serviceUrl: string,
    conversationId: string,
    activityId: string,
    options?: MSTeamsStreamBufferOptions,
  ) {
    this.token = token;
    this.serviceUrl = serviceUrl;
    this.conversationId = conversationId;
    this.activityId = activityId;
    this.flushIntervalMs = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.informativeMessage = options?.informativeMessage ?? DEFAULT_INFORMATIVE_MESSAGE;
  }

  /** Whether startStream has been called and a streamId is set. */
  get isStarted(): boolean {
    return this.streamId !== null;
  }

  /**
   * Wait for any in-flight streaming request to complete.
   *
   * The inbound worker should call `settle()` before inspecting `isStarted`
   * to avoid a race where `startStream` is still in-flight and `isStarted`
   * would incorrectly return false.
   */
  async settle(): Promise<void> {
    return this.waitForPending();
  }

  /**
   * Accept a text chunk from the LLM. On the first call, sends an informative
   * update via startStream and starts the flush/auto-finalize timers.
   * Subsequent calls accumulate text in the buffer.
   */
  async onChunk(chunk: string): Promise<void> {
    if (this.closed || this.failed) return;

    if (!this.streamId) {
      await this.startInformativeUpdate();
      if (this.failed) return;
    }

    this.fullText += chunk;
  }

  /**
   * Close the stream. Clears timers, waits for any in-flight request,
   * flushes remaining text, and calls finalizeStream.
   * If the stream was never started (e.g. startStream threw), this is a no-op.
   */
  async close(attachments?: unknown[]): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();

    // Wait for any in-flight request to complete
    await this.waitForPending();

    if (!this.streamId || this.failed) {
      // Stream was never opened, or a previous continueStream call failed.
      // Attempting to finalize a failed stream would produce a redundant error.
      // The caller should fall back to a regular sendResponse().
      return;
    }

    try {
      await finalizeStream(
        this.token,
        this.serviceUrl,
        this.conversationId,
        this.activityId,
        this.streamId,
        this.fullText,
        attachments,
      );
    } catch (error) {
      log.error('Failed to finalize Teams stream', {
        ...buildChannelDeliveryLogContext({
          channelType: 'msteams',
          provider: 'msteams',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        conversationId: this.conversationId,
      });
    }
  }

  /**
   * Send the initial informative update via startStream.
   * Sets streamId and starts the flush/auto-finalize timers on success.
   */
  private async startInformativeUpdate(): Promise<void> {
    try {
      const result = await startStream(
        this.token,
        this.serviceUrl,
        this.conversationId,
        this.activityId,
        this.informativeMessage,
        'informative',
      );
      this.streamId = result.streamId;
      this.startTimers();
      log.info('Teams stream started', {
        streamId: this.streamId,
        conversationId: this.conversationId,
      });
    } catch (error) {
      log.error('Failed to start Teams stream', {
        ...buildChannelDeliveryLogContext({
          channelType: 'msteams',
          provider: 'msteams',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        conversationId: this.conversationId,
      });
      this.failed = true;
    }
  }

  /** Set up the periodic flush timer and the auto-finalize safety timer. */
  private startTimers(): void {
    this.flushTimer = setInterval(() => {
      void this.tick();
    }, this.flushIntervalMs);

    this.autoFinalizeTimer = setTimeout(() => {
      log.warn('Auto-finalizing Teams stream at 110s safety limit', {
        conversationId: this.conversationId,
      });
      void this.close();
    }, AUTO_FINALIZE_MS);
  }

  /** Clear both the flush interval and auto-finalize timeout. */
  private clearTimers(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.autoFinalizeTimer !== null) {
      clearTimeout(this.autoFinalizeTimer);
      this.autoFinalizeTimer = null;
    }
  }

  /**
   * Called by the flush interval timer. Sends the full accumulated text
   * to Teams if there is new content since the last flush.
   */
  private async tick(): Promise<void> {
    if (this.closed || this.failed) return;
    if (this.pendingRequest) return; // backpressure — skip this tick
    if (this.fullText.length === this.lastFlushedLength) return; // no new content

    this.pendingRequest = true;
    this.streamSequence += 1;

    try {
      await continueStream(
        this.token,
        this.serviceUrl,
        this.conversationId,
        this.activityId,
        this.streamId!,
        this.fullText,
        'streaming',
        this.streamSequence,
      );
      this.lastFlushedLength = this.fullText.length;
    } catch (error) {
      log.error('Failed to continue Teams stream', {
        ...buildChannelDeliveryLogContext({
          channelType: 'msteams',
          provider: 'msteams',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        conversationId: this.conversationId,
        streamSequence: this.streamSequence,
      });
      this.failed = true;
      this.clearTimers();
    } finally {
      this.pendingRequest = false;
    }
  }

  /**
   * Poll loop waiting for any in-flight request to complete.
   * Bounded at 15 seconds to prevent infinite hangs.
   */
  private async waitForPending(): Promise<void> {
    let waitedMs = 0;
    while (this.pendingRequest && waitedMs < CLOSE_MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      waitedMs += CLOSE_POLL_INTERVAL_MS;
    }
    if (this.pendingRequest) {
      log.warn('Timed out waiting for in-flight Teams request during close', {
        conversationId: this.conversationId,
      });
    }
  }
}
