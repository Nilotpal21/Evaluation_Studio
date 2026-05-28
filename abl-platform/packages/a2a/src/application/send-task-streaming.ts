/**
 * SendTaskStreaming — outbound SSE streaming to a remote A2A agent.
 *
 * Calls client.sendMessageStream() and yields each SSE event back to the
 * caller as an AsyncGenerator. The caller (routing-executor) can forward
 * artifact chunks to the user's WebSocket in real-time.
 */

import type {
  Task,
  Message,
  MessageSendParams,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type { A2AClient } from '@a2a-js/sdk/client';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:send-task-streaming');

export type A2AStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface SendTaskStreamingParams {
  /** Remote agent base URL */
  endpoint: string;
  /** Tenant issuing the call */
  tenantId: string;
  /** Unique task identifier for tracing */
  taskId: string;
  /** The message to send to the remote agent */
  message: MessageSendParams;
  /** Allow private/internal endpoints (dev only) */
  allowPrivate?: boolean;
}

export interface SendTaskStreamingDeps {
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  createClient: (baseUrl: string) => A2AClient;
}

/**
 * Opens an SSE streaming connection to a remote A2A agent and yields
 * each event. The caller consumes the generator to forward artifact
 * chunks to the user in real-time.
 *
 * The final event will be a Task or TaskStatusUpdateEvent with a terminal state.
 *
 * NOTE: No automatic SSE reconnection. If the connection drops mid-stream,
 * the generator terminates with an error. The caller should handle reconnection
 * by calling sendTaskStreaming again with the same contextId (via Message.contextId).
 * The remote server's session resolver will resume the existing session.
 */
export async function* sendTaskStreaming(
  params: SendTaskStreamingParams,
  deps: SendTaskStreamingDeps,
): AsyncGenerator<A2AStreamEvent, void, undefined> {
  // 0. Warn if contextId is missing (multi-turn session continuity will not work)
  if (!params.message?.message?.contextId) {
    log.warn(
      'Outbound A2A task sent without contextId — multi-turn session continuity will not work',
      {
        endpoint: params.endpoint,
        taskId: params.taskId,
      },
    );
  }

  // 1. Validate endpoint (SSRF)
  const interceptor = new TracedCallInterceptor({
    endpoint: params.endpoint,
    tenantId: params.tenantId,
    tracing: deps.tracing,
    validator: deps.validator,
    allowPrivate: params.allowPrivate,
  });

  // 2. Create SDK client
  const client = deps.createClient(interceptor.endpoint);

  // 3. Stream events and trace
  const start = Date.now();
  let eventCount = 0;
  try {
    const stream = client.sendMessageStream(params.message);
    for await (const event of stream) {
      eventCount++;
      yield event;
    }
    interceptor.traceCall(params.taskId, Date.now() - start, 'success');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    interceptor.traceCall(params.taskId, Date.now() - start, 'error', errorMessage);
    throw error;
  }
}
