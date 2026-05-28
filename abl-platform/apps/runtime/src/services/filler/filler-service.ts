import { randomUUID } from 'crypto';
import type {
  StatusEvent,
  StatusOperation,
  FillerConfig,
  QueuedFiller,
  FillerSource,
} from './types.js';

export type FillerTextNormalizer = (
  filler: Pick<QueuedFiller, 'text' | 'source' | 'operation'>,
) => string | null;

export interface FillerMessageServiceOptions {
  normalizeText?: FillerTextNormalizer;
}

const FILLER_SOURCE_PRIORITY: Record<FillerSource, number> = {
  static: 1,
  piggybacked: 2,
  pipeline: 3,
};
const COMPLETE_PHRASE_PATTERN = /(?:[.!?…。！？؟]|\.{3})$/u;
const TRAILING_ELLIPSIS_PATTERN = /\s*(?:\.{3}|…)\s*$/u;

function shouldReplacePendingFiller(current: QueuedFiller, nextSource: FillerSource): boolean {
  return FILLER_SOURCE_PRIORITY[nextSource] >= FILLER_SOURCE_PRIORITY[current.source];
}

function defaultNormalizeFillerText(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ').trim().replace(TRAILING_ELLIPSIS_PATTERN, '.');
  if (!compact) {
    return null;
  }

  return COMPLETE_PHRASE_PATTERN.test(compact) ? compact : `${compact}.`;
}

/**
 * Per-session service that owns the turn-level silence window for contextual
 * status messages. A turn opens when a user message starts processing, the
 * first filler is scheduled from that message boundary, and visible output
 * closes the window so late async filler work cannot leak into the response.
 */
export class FillerMessageService {
  private readonly sessionId: string;
  private readonly config: FillerConfig;
  private readonly onEmit: (event: StatusEvent) => void;
  private readonly normalizeText: FillerTextNormalizer;

  private pending: QueuedFiller | null = null;
  private turnEmitCount = 0;
  private turnIndex = 0;
  private lastEmitTime = 0;
  private turnStarted = false;
  private turnClosed = false;
  private destroyed = false;

  constructor(
    sessionId: string,
    config: FillerConfig,
    onEmit: (event: StatusEvent) => void,
    options: FillerMessageServiceOptions = {},
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.onEmit = onEmit;
    this.normalizeText =
      options.normalizeText ?? ((filler) => defaultNormalizeFillerText(filler.text));
  }

  /**
   * Store a pipeline-generated filler for compatibility with older tests/callers.
   * Runtime delivery now uses queueFiller() so generated text updates the active
   * turn-level silence window instead of emitting independently.
   */
  setPipelineFiller(text: string): void {
    this.pipelineFiller = text;
  }

  /** Get and consume the pipeline filler (returns null if not set or already used). */
  consumePipelineFiller(): string | null {
    const text = this.pipelineFiller;
    this.pipelineFiller = null;
    return text;
  }

  private pipelineFiller: string | null = null;

  /** Open a turn without scheduling a fallback filler yet. */
  openTurn(): void {
    if (!this.config.enabled || this.destroyed) return;

    this.turnStarted = true;
    this.turnClosed = false;
    this.clearPending();
  }

  /**
   * Open the message-level filler window. The first filler timer starts here,
   * not when a tool, handoff, extraction, or other internal operation happens.
   */
  startTurn(operation: StatusOperation, text: string, source: FillerSource = 'static'): void {
    if (!this.config.enabled || this.destroyed) return;

    this.turnStarted = true;
    this.turnClosed = false;
    this.clearPending();
    this.scheduleFiller(operation, text, source, Date.now());
  }

  /**
   * Emit a filler immediately while preserving turn lifecycle, max-per-turn,
   * and cancellation behavior. Used when an async contextual filler has already
   * waited for the configured delay gate before becoming available.
   */
  emitImmediate(operation: StatusOperation, text: string, source: FillerSource = 'static'): void {
    if (!this.config.enabled || this.destroyed) return;
    if (this.turnEmitCount >= this.config.maxPerTurn) return;
    if (this.turnClosed) return;

    if (!this.turnStarted) {
      this.turnStarted = true;
      this.turnClosed = false;
    }

    this.clearPending();
    this.emit({
      text,
      source,
      operation,
      queuedAt: Date.now(),
      timerId: null,
    });
  }

  /**
   * Queue or update a filler message. During an open turn, this updates the
   * pending message without restarting the timer. That lets contextual text
   * from pipeline generation or operation traces improve the message while the
   * trigger interval remains anchored to the user message.
   */
  queueFiller(operation: StatusOperation, text: string, source: FillerSource = 'static'): void {
    if (!this.config.enabled || this.destroyed) return;
    if (this.turnEmitCount >= this.config.maxPerTurn) return;
    if (this.turnClosed) return;

    const now = Date.now();

    if (!this.turnStarted) {
      this.startTurn(operation, text, source);
      return;
    }

    if (this.pending) {
      if (!shouldReplacePendingFiller(this.pending, source)) {
        return;
      }

      this.pending.text = text;
      this.pending.source = source;
      this.pending.operation = operation;
      this.pending.queuedAt = now;
      return;
    }

    if (source !== 'static' && this.turnEmitCount > 0) {
      return;
    }

    if (this.lastEmitTime > 0 && now - this.lastEmitTime < this.config.cooldownMs) return;

    this.scheduleFiller(operation, text, source, now);
  }

  /** Cancel pending and future fillers for this message turn. */
  closeTurn(): void {
    this.turnClosed = true;
    this.clearPending();
  }

  /** Cancel any pending filler (real response is streaming). */
  cancel(): void {
    this.closeTurn();
  }

  /** Reset silence timer (LLM chunk reached user, no filler needed). */
  reset(): void {
    this.closeTurn();
  }

  /** Reset turn counters for a new execution turn. */
  resetTurn(): void {
    this.turnEmitCount = 0;
    this.turnIndex = 0;
    this.lastEmitTime = 0;
    this.turnStarted = false;
    this.turnClosed = false;
    this.clearPending();
  }

  /** Destroy the service, clearing all timers. */
  destroy(): void {
    this.destroyed = true;
    this.closeTurn();
  }

  /** Check if the service has been destroyed. */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  private scheduleFiller(
    operation: StatusOperation,
    text: string,
    source: FillerSource,
    queuedAt: number,
  ): void {
    const filler: QueuedFiller = {
      text,
      source,
      operation,
      queuedAt,
      timerId: null,
    };

    const delay = this.config.voiceDelayMs ?? this.config.chatDelayMs;
    if (delay <= 0) {
      this.emit(filler);
    } else {
      filler.timerId = setTimeout(() => {
        this.emit(filler);
      }, delay);
      this.pending = filler;
    }
  }

  private emit(filler: QueuedFiller): void {
    if (this.destroyed || this.turnClosed) return;

    const text = this.normalizeText(filler);
    if (!text) {
      this.pending = null;
      return;
    }

    const event: StatusEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      text,
      operation: filler.operation,
      source: filler.source,
      transient: true,
      index: this.turnIndex++,
      timestamp: Date.now(),
    };

    this.turnEmitCount++;
    this.lastEmitTime = Date.now();
    this.pending = null;
    this.onEmit(event);
  }

  private clearPending(): void {
    if (this.pending?.timerId) {
      clearTimeout(this.pending.timerId);
    }
    this.pending = null;
  }
}
