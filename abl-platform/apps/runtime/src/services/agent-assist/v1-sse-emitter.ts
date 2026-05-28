import type { Request, Response } from 'express';
import type { V1OutputBlock, V1SessionInfo, V1StreamFrame } from './types.js';

/**
 * V1 SSE frame writer.
 *
 * Kore.ai Agent Assist's widget parses each frame as a single JSON object carried on
 * a `data: <json>\n\n` line. Unlike `apps/runtime/src/routes/chat.ts` which uses named
 * `event: <name>` SSE events, V1 clients require unnamed `data:`-only frames — named
 * events are treated as parse errors by the widget's superagent integration.
 *
 * The opener (`eventIndex: 0`) carries `sessionInfo` and is treated by the widget as
 * the immediate HTTP response. Intermediate frames concatenate `output[].content`.
 * The terminal frame MUST set `isLastEvent: true` so the widget hides its thinking
 * indicator and finalizes the message.
 */
export class V1SSEEmitter {
  private eventIndex = 0;
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly res: Response,
    private readonly heartbeatMs: number,
  ) {}

  /**
   * @param req - Optional Express request. When passed, the emitter listens
   *              for socket close so heartbeats stop firing the moment the
   *              client hangs up instead of waiting for the next write to
   *              throw.
   */
  start(req?: Request): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    // `no-transform` tells the global `compression` middleware to skip gzip on
    // this response. Without it, gzip buffers 1+ KB of frames before flushing,
    // so token deltas arrive in big batches instead of live.
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers so the widget knows it is a stream before the first frame lands.
    if (typeof this.res.flushHeaders === 'function') this.res.flushHeaders();
    if (req) {
      const onClose = (): void => {
        this.closed = true;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      };
      req.on('close', onClose);
    }
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.closed) return;
        // SSE comment line — no event/data body, ignored by spec-compliant parsers.
        try {
          this.res.write(': heartbeat\n\n');
          this.flush();
        } catch {
          // Socket gone; `write` will return false / throw on some runtimes.
          this.closed = true;
        }
      }, this.heartbeatMs);
    }
  }

  /**
   * Flush the response write buffer so each SSE frame reaches the client
   * immediately. When `compression` middleware is active it patches `res.flush`
   * to flush the gzip stream; on a plain Node response `flush` is undefined and
   * this is a no-op.
   */
  private flush(): void {
    const maybeFlush = (this.res as unknown as { flush?: () => void }).flush;
    if (typeof maybeFlush === 'function') {
      try {
        maybeFlush.call(this.res);
      } catch {
        // Ignore — response may have been closed between write and flush.
      }
    }
  }

  private nextIndex(isLast: boolean): number {
    const idx = this.eventIndex;
    if (!isLast) this.eventIndex += 1;
    return idx;
  }

  emit(frame: Omit<V1StreamFrame, 'eventIndex'>): void {
    if (this.closed) return;
    const isLast = frame.isLastEvent === true;
    const payload: V1StreamFrame = { ...frame, eventIndex: this.nextIndex(isLast) };
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    // Flush after each frame so token deltas arrive live, not in batches.
    this.flush();
  }

  emitOpener(sessionInfo: V1SessionInfo, messageId: string): void {
    this.emit({
      isLastEvent: false,
      messageId,
      sessionInfo: { ...sessionInfo, status: 'processing' },
    });
  }

  emitDelta(content: string, messageId: string): void {
    if (!content) return;
    this.emit({
      isLastEvent: false,
      messageId,
      output: [{ type: 'text', content }],
    });
  }

  emitFinal(params: {
    messageId: string;
    sessionInfo: V1SessionInfo;
    outputText: string;
    richContent?: V1OutputBlock['richContent'];
    actions?: V1OutputBlock['actions'];
    voiceConfig?: V1OutputBlock['voiceConfig'];
    contentEnvelope?: V1OutputBlock['contentEnvelope'];
    metadata?: Record<string, unknown>;
  }): void {
    this.emit({
      isLastEvent: true,
      messageId: params.messageId,
      output: [
        {
          type: 'text',
          content: params.outputText,
          ...(params.richContent ? { richContent: params.richContent } : {}),
          ...(params.actions ? { actions: params.actions } : {}),
          ...(params.voiceConfig ? { voiceConfig: params.voiceConfig } : {}),
          ...(params.contentEnvelope ? { contentEnvelope: params.contentEnvelope } : {}),
        },
      ],
      sessionInfo: { ...params.sessionInfo, status: params.sessionInfo.status ?? 'completed' },
      ...(params.metadata && Object.keys(params.metadata).length > 0
        ? { metadata: params.metadata }
        : {}),
    });
  }

  emitError(params: { messageId: string; sessionInfo: V1SessionInfo; message: string }): void {
    this.emit({
      isLastEvent: true,
      messageId: params.messageId,
      output: [{ type: 'text', content: params.message }],
      sessionInfo: { ...params.sessionInfo, status: 'error' },
    });
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.res.end();
    } catch {
      // Socket already gone.
    }
  }
}
