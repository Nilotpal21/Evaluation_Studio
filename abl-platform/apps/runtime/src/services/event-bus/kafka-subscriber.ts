/**
 * KafkaSubscriber — Batched Kafka Publisher
 *
 * Accepts PlatformEvents via handle(), buffers them, and flushes to Kafka
 * in batches when either batchSize is reached or lingerMs elapses.
 *
 * Events are grouped by topic in a single sendBatch call. Partition keys
 * are set to `${tenantId}:${sessionId}` for session-ordered delivery.
 * Kafka message headers carry event-type, tenant-id, event-id, traceparent,
 * tracestate, and session-id for distributed tracing.
 *
 * On persistent Kafka failure (after retries with exponential backoff),
 * events are written to a dead-letter store.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  EVENT_KAFKA_BATCH_SIZE,
  EVENT_KAFKA_LINGER_MS,
  EVENT_KAFKA_RETRIES,
  EVENT_KAFKA_RETRY_INITIAL_MS,
} from '@agent-platform/config';
import { trace, context, propagation } from '@opentelemetry/api';
import type { AnyPlatformEvent } from './types.js';
import { eventTypeToTopic } from './types.js';
import type { EventType } from './types.js';
import type { DeadLetterWriter } from './dead-letter-writer.js';

// ---------------------------------------------------------------------------
// Trace context capture — snapshotted at handle() time, not flush time
// ---------------------------------------------------------------------------

interface CapturedTraceContext {
  traceparent: string;
  tracestate: string;
}

/**
 * Captures the W3C traceparent and tracestate from the currently active
 * OTEL context. Returns undefined if no active span exists.
 */
function captureTraceContext(): CapturedTraceContext | undefined {
  const activeSpan = trace.getSpan(context.active());
  if (!activeSpan) return undefined;

  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const traceparent = carrier['traceparent'];
  if (!traceparent) return undefined;

  return {
    traceparent,
    tracestate: carrier['tracestate'] ?? '',
  };
}

const log = createLogger('kafka-subscriber');

// ---------------------------------------------------------------------------
// KafkaProducer interface (for mocking / DI)
// ---------------------------------------------------------------------------

export interface KafkaProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendBatch(batch: {
    topicMessages: Array<{
      topic: string;
      messages: Array<{
        key: string;
        value: string;
        headers: Record<string, string>;
        timestamp?: string;
      }>;
    }>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// KafkaSubscriber
// ---------------------------------------------------------------------------

export interface KafkaSubscriberOptions {
  batchSize?: number;
  lingerMs?: number;
  maxRetries?: number;
  retryInitialMs?: number;
}

export class KafkaSubscriber {
  private buffer: AnyPlatformEvent[] = [];
  private traceContextMap = new WeakMap<AnyPlatformEvent, CapturedTraceContext>();
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchSize: number;
  private readonly lingerMs: number;
  private readonly maxRetries: number;
  private readonly retryInitialMs: number;

  constructor(
    private producer: KafkaProducer,
    private deadLetterWriter: DeadLetterWriter,
    options: KafkaSubscriberOptions = {},
  ) {
    this.batchSize = options.batchSize ?? EVENT_KAFKA_BATCH_SIZE;
    this.lingerMs = options.lingerMs ?? EVENT_KAFKA_LINGER_MS;
    this.maxRetries = options.maxRetries ?? EVENT_KAFKA_RETRIES;
    this.retryInitialMs = options.retryInitialMs ?? EVENT_KAFKA_RETRY_INITIAL_MS;
  }

  /**
   * Event handler to pass to EventBus.subscribe().
   * Buffers the event and flushes when batch size is reached.
   */
  handle = (event: AnyPlatformEvent): void => {
    // Capture trace context now (while the originating span is still active),
    // not at flush time when the async context has changed.
    const traceCtx = captureTraceContext();
    if (traceCtx) {
      this.traceContextMap.set(event, traceCtx);
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.batchSize) {
      this.cancelLinger();
      this.drainBuffer().catch((err) => {
        log.warn('KafkaSubscriber drain failed after batch-size trigger', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (!this.lingerTimer) {
      this.lingerTimer = setTimeout(() => {
        this.lingerTimer = null;
        this.drainBuffer().catch((err) => {
          log.warn('KafkaSubscriber drain failed after linger timeout', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.lingerMs);
    }
  };

  /**
   * Immediately flushes all buffered events. Call during graceful shutdown.
   */
  async flush(): Promise<void> {
    this.cancelLinger();
    if (this.buffer.length > 0) {
      await this.drainBuffer();
    }
  }

  /**
   * Flushes and disconnects the producer.
   */
  async close(): Promise<void> {
    await this.flush();
    await this.producer.disconnect();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private async drainBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    await this.sendWithRetry(batch);
  }

  private async sendWithRetry(events: AnyPlatformEvent[]): Promise<void> {
    const topicMessages = this.groupByTopic(events);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.producer.sendBatch({ topicMessages });
        log.debug('Kafka batch sent', { eventCount: events.length, topics: topicMessages.length });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          const delayMs = this.retryInitialMs * Math.pow(2, attempt);
          log.warn('Kafka send failed, retrying', {
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delayMs,
            error: lastError.message,
          });
          await this.sleep(delayMs);
        }
      }
    }

    // All retries exhausted — write to dead letter
    log.error('Kafka send failed after all retries, writing to dead letter', {
      eventCount: events.length,
      error: lastError?.message,
    });

    for (const event of events) {
      try {
        await this.deadLetterWriter.write(
          event,
          lastError?.message ?? 'Unknown error',
          this.maxRetries,
        );
      } catch (dlErr) {
        log.error('Dead letter write also failed', {
          eventId: event.eventId,
          error: dlErr instanceof Error ? dlErr.message : String(dlErr),
        });
      }
    }
  }

  private groupByTopic(events: AnyPlatformEvent[]): Array<{
    topic: string;
    messages: Array<{
      key: string;
      value: string;
      headers: Record<string, string>;
      timestamp?: string;
    }>;
  }> {
    const topicMap = new Map<
      string,
      Array<{
        key: string;
        value: string;
        headers: Record<string, string>;
        timestamp?: string;
      }>
    >();

    for (const event of events) {
      const topic = eventTypeToTopic(event.type as EventType);
      const key = `${event.tenantId}:${event.sessionId}`;

      const headers: Record<string, string> = {
        'event-type': event.type,
        'tenant-id': event.tenantId,
        'event-id': event.eventId,
      };

      // Inject W3C trace context headers for distributed tracing.
      // The trace context was captured at handle() time so it reflects the
      // originating request span, not the async flush context.
      const traceCtx = this.traceContextMap.get(event);
      if (traceCtx) {
        headers['traceparent'] = traceCtx.traceparent;
        if (traceCtx.tracestate) {
          headers['tracestate'] = traceCtx.tracestate;
        }
      }
      headers['session-id'] = event.sessionId;

      const message = {
        key,
        value: JSON.stringify(event),
        headers,
        timestamp: String(new Date(event.timestamp).getTime()),
      };

      let messages = topicMap.get(topic);
      if (!messages) {
        messages = [];
        topicMap.set(topic, messages);
      }
      messages.push(message);
    }

    return Array.from(topicMap.entries()).map(([topic, messages]) => ({
      topic,
      messages,
    }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
