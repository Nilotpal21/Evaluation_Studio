/**
 * Telegram Stream Buffer
 *
 * Manages chunk buffering for streaming LLM responses to Telegram
 * using the sendMessageDraft API (Bot API 9.5).
 *
 * Flow:
 *   1. LLM emits text deltas via onChunk()
 *   2. Buffer accumulates text until it exceeds chunkSize
 *   3. Flushes call sendMessageDraft with accumulated text
 *   4. close() is called when the LLM response is complete
 *      (the final sendMessage is handled by the adapter, not the buffer)
 *
 * Backpressure: A pendingRequest lock prevents concurrent API calls.
 * Throttle: Minimum interval between flushes to respect Telegram rate limits.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('telegram-stream-buffer');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_CHUNK_SIZE = 300;
const MIN_FLUSH_INTERVAL_MS = 400; // ~2.5 calls/sec
const CLOSE_POLL_INTERVAL_MS = 50;
const CLOSE_MAX_WAIT_MS = 15_000;

/** Matches partial citation at end of buffer. */
const PARTIAL_CITATION_RE = /\[(?:\d+|d(?:o(?:c(?:-\d*)?)?)?)?$/;

export interface TelegramStreamBufferOptions {
  /** Minimum chars before flushing. Default: 300. */
  chunkSize?: number;
  /** Telegram Bot API base URL. Default: https://api.telegram.org */
  apiBase?: string;
}

export class TelegramStreamBuffer {
  private readonly botToken: string;
  private readonly chatId: string | number;
  private readonly draftId: number;
  private readonly chunkSize: number;
  private readonly apiBase: string;

  private buffer = '';
  private fullText = '';
  private pendingRequest = false;
  private closed = false;
  private failed = false;
  private lastFlushTime = 0;
  private started = false;

  constructor(
    botToken: string,
    chatId: string | number,
    draftId: number,
    options?: TelegramStreamBufferOptions,
  ) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.draftId = draftId;
    this.chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.apiBase = options?.apiBase ?? TELEGRAM_API_BASE;
  }

  /** Whether at least one sendMessageDraft call has been made. */
  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Wait for any in-flight flush operation to complete.
   * Call this before checking `isStarted` to avoid race conditions.
   */
  async settle(): Promise<void> {
    let waitedMs = 0;
    while (this.pendingRequest && waitedMs < CLOSE_MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      waitedMs += CLOSE_POLL_INTERVAL_MS;
    }
  }

  /** The full accumulated text sent so far. */
  get accumulatedText(): string {
    return this.fullText;
  }

  /**
   * Accept a text chunk from the LLM. Buffers internally and flushes
   * when the buffer exceeds chunkSize (respecting backpressure and throttle).
   */
  async onChunk(chunk: string): Promise<void> {
    if (this.closed || this.failed) return;

    this.buffer += chunk;

    if (this.pendingRequest) return;
    if (this.buffer.length <= this.chunkSize) return;
    if (PARTIAL_CITATION_RE.test(this.buffer)) return;

    // Throttle: wait until MIN_FLUSH_INTERVAL_MS since last flush
    const elapsed = Date.now() - this.lastFlushTime;
    if (elapsed < MIN_FLUSH_INTERVAL_MS) return;

    await this.flush();
  }

  /**
   * Close the stream buffer. Flushes any remaining buffer.
   * The caller is responsible for sending the final sendMessage.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    let waitedMs = 0;
    while (this.pendingRequest && waitedMs < CLOSE_MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_INTERVAL_MS));
      waitedMs += CLOSE_POLL_INTERVAL_MS;
    }

    // Flush any remaining buffer as a final draft update
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  /**
   * Internal flush: sends buffered text to Telegram via sendMessageDraft.
   */
  private async flush(): Promise<void> {
    this.pendingRequest = true;

    try {
      const text = this.buffer;
      this.buffer = '';
      this.fullText += text;

      const url = `${this.apiBase}/bot${this.botToken}/sendMessageDraft`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          draft_id: this.draftId,
          text: this.fullText,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        log.error('Failed to send Telegram message draft', {
          ...buildChannelDeliveryLogContext({
            channelType: 'telegram',
            provider: 'telegram',
            httpStatus: resp.status,
          }),
          chatId: this.chatId,
        });
        this.failed = true;
        return;
      }

      this.started = true;
      this.lastFlushTime = Date.now();

      // Drain loop: if more data accumulated during the API call, flush again
      while (this.buffer.length > this.chunkSize && !PARTIAL_CITATION_RE.test(this.buffer)) {
        const next = this.buffer;
        this.buffer = '';
        this.fullText += next;

        const drainResp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            draft_id: this.draftId,
            text: this.fullText,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!drainResp.ok) {
          log.error('Failed to update Telegram message draft', {
            ...buildChannelDeliveryLogContext({
              channelType: 'telegram',
              provider: 'telegram',
              code: 'CHANNEL_PROVIDER_REJECTED',
              httpStatus: drainResp.status,
            }),
            chatId: this.chatId,
          });
          this.failed = true;
          break;
        }

        this.lastFlushTime = Date.now();
      }
    } catch (error) {
      log.error('Error flushing Telegram stream buffer', {
        ...buildChannelDeliveryLogContext({
          channelType: 'telegram',
          provider: 'telegram',
          code: 'CHANNEL_DELIVERY_FAILED',
          errorName: getChannelDeliveryErrorName(error),
        }),
        chatId: this.chatId,
      });
      this.failed = true;
    } finally {
      this.pendingRequest = false;
    }
  }
}
