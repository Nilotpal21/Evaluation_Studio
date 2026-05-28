// packages/a2a/src/application/send-task.ts

import type { Task, Message, MessageSendParams, SendMessageResponse } from '@a2a-js/sdk';
import type { A2AClient } from '@a2a-js/sdk/client';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:send-task');

export interface SendTaskParams {
  /** Remote agent base URL (e.g. https://agent.example.com) */
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

export interface SendTaskDeps {
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  /** Factory to create A2AClient — enables testing without real HTTP */
  createClient: (baseUrl: string) => A2AClient;
}

/**
 * Extracts the Task or Message result from a SendMessageResponse.
 * The response is a JSON-RPC wrapper — on success it contains `result`.
 */
function extractResult(response: SendMessageResponse): Task | Message {
  if ('error' in response) {
    throw new Error(
      `Remote agent returned error: ${response.error.message} (code ${response.error.code})`,
    );
  }
  return response.result as Task | Message;
}

/**
 * SendTaskUseCase wraps the A2A SDK client with platform concerns:
 *  - SSRF endpoint validation
 *  - Outbound call tracing (duration, success/error)
 *
 * The use case creates a TracedCallInterceptor to validate the endpoint,
 * then delegates to the SDK's A2AClient for the actual HTTP call.
 */
export async function sendTask(
  params: SendTaskParams,
  deps: SendTaskDeps,
): Promise<Task | Message> {
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

  // 1. Validate endpoint (throws on SSRF) and set up tracing
  const interceptor = new TracedCallInterceptor({
    endpoint: params.endpoint,
    tenantId: params.tenantId,
    tracing: deps.tracing,
    validator: deps.validator,
    allowPrivate: params.allowPrivate,
  });

  // 2. Create SDK client
  const client = deps.createClient(interceptor.endpoint);

  // 3. Send message and trace
  const start = Date.now();
  try {
    const response = await client.sendMessage(params.message);
    const result = extractResult(response);
    const durationMs = Date.now() - start;
    interceptor.traceCall(params.taskId, durationMs, 'success');
    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    interceptor.traceCall(params.taskId, durationMs, 'error', errorMessage);
    throw error;
  }
}
