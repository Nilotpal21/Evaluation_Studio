/**
 * CancelTask — cancel a running task on a remote A2A agent.
 *
 * Called when the user cancels, the operation times out, or the session
 * is cleaned up while a remote handoff is in progress.
 * Best-effort: errors are logged but not propagated (remote may already be done).
 */

import type { Task, TaskIdParams } from '@a2a-js/sdk';
import type { A2AClient } from '@a2a-js/sdk/client';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

export interface CancelTaskParams {
  /** Remote agent base URL */
  endpoint: string;
  /** Tenant issuing the cancel */
  tenantId: string;
  /** The task ID to cancel */
  taskId: string;
  /** Allow private/internal endpoints (dev only) */
  allowPrivate?: boolean;
}

export interface CancelTaskDeps {
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  createClient: (baseUrl: string) => A2AClient;
}

/**
 * Cancels a task on a remote A2A agent.
 * Returns the updated Task (usually with state='canceled').
 */
export async function cancelRemoteTask(
  params: CancelTaskParams,
  deps: CancelTaskDeps,
): Promise<Task> {
  const interceptor = new TracedCallInterceptor({
    endpoint: params.endpoint,
    tenantId: params.tenantId,
    tracing: deps.tracing,
    validator: deps.validator,
    allowPrivate: params.allowPrivate,
  });

  const client = deps.createClient(interceptor.endpoint);

  const start = Date.now();
  const cancelParams: TaskIdParams = { id: params.taskId };

  try {
    const response = await client.cancelTask(cancelParams);
    if ('error' in response) {
      throw new Error(
        `Remote agent returned error: ${response.error.message} (code ${response.error.code})`,
      );
    }
    interceptor.traceCall(`cancel:${params.taskId}`, Date.now() - start, 'success');
    return response.result as Task;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    interceptor.traceCall(`cancel:${params.taskId}`, Date.now() - start, 'error', errorMessage);
    throw error;
  }
}
