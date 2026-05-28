/**
 * PollTask — query the status of a remote A2A task.
 *
 * Used as a fallback when push notifications fail. The caller can poll
 * periodically until the task reaches a terminal state.
 */

import type { Task, TaskQueryParams } from '@a2a-js/sdk';
import type { A2AClient } from '@a2a-js/sdk/client';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

export interface PollTaskParams {
  /** Remote agent base URL */
  endpoint: string;
  /** Tenant issuing the call */
  tenantId: string;
  /** The task ID to query */
  taskId: string;
  /** Optional history length limit */
  historyLength?: number;
  /** Allow private/internal endpoints (dev only) */
  allowPrivate?: boolean;
}

export interface PollTaskDeps {
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  createClient: (baseUrl: string) => A2AClient;
}

/**
 * Queries the status of a task on a remote A2A agent.
 * Returns the Task object with its current state and optional history.
 */
export async function pollTask(params: PollTaskParams, deps: PollTaskDeps): Promise<Task> {
  const interceptor = new TracedCallInterceptor({
    endpoint: params.endpoint,
    tenantId: params.tenantId,
    tracing: deps.tracing,
    validator: deps.validator,
    allowPrivate: params.allowPrivate,
  });

  const client = deps.createClient(interceptor.endpoint);

  const start = Date.now();
  const queryParams: TaskQueryParams = {
    id: params.taskId,
    ...(params.historyLength !== undefined ? { historyLength: params.historyLength } : {}),
  };

  try {
    const response = await client.getTask(queryParams);
    if ('error' in response) {
      throw new Error(
        `Remote agent returned error: ${response.error.message} (code ${response.error.code})`,
      );
    }
    interceptor.traceCall(`poll:${params.taskId}`, Date.now() - start, 'success');
    return response.result as Task;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    interceptor.traceCall(`poll:${params.taskId}`, Date.now() - start, 'error', errorMessage);
    throw error;
  }
}
