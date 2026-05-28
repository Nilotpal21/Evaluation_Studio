import { createLogger } from '@abl/compiler/platform/logger.js';
import type { ArchSSEEvent } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:sse-stream');

export function serializeSSEEvent(event: ArchSSEEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createSSEStream(): {
  stream: ReadableStream<string>;
  emit: (event: ArchSSEEvent) => void;
  emitRaw: (raw: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<string> | null = null;
  let closed = false;

  const stream = new ReadableStream<string>({
    start(nextController) {
      controller = nextController;
    },
    cancel() {
      closed = true;
      controller = null;
    },
  });

  return {
    stream,
    emit: (event) => {
      if (!controller || closed) {
        return;
      }

      try {
        controller.enqueue(serializeSSEEvent(event));
      } catch (err: unknown) {
        log.warn('SSE emit failed, closing stream', {
          error: err instanceof Error ? err.message : String(err),
          eventType: event.type,
        });
        closed = true;
        controller = null;
      }
    },
    emitRaw: (raw) => {
      if (!controller || closed) {
        return;
      }

      try {
        controller.enqueue(raw);
      } catch {
        closed = true;
        controller = null;
      }
    },
    close: () => {
      if (!controller || closed) {
        return;
      }

      const activeController = controller;
      closed = true;
      controller = null;

      try {
        activeController.close();
      } catch (err: unknown) {
        log.debug('SSE close failed (client likely disconnected)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
