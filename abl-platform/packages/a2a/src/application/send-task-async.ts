/**
 * SendTaskAsync — non-blocking outbound task dispatch with push notification config.
 *
 * When calling a remote agent that supports push notifications, this function
 * sends the task with `blocking: false` and includes the caller's push notification
 * URL. The remote agent responds immediately with a Task in 'working' state,
 * and will POST status updates to the push notification URL when done.
 */

import { sendTask } from './send-task.js';
import type { SendTaskDeps } from './send-task.js';
import type { Task, Message } from '@a2a-js/sdk';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:send-task-async');

export interface SendTaskAsyncParams {
  endpoint: string;
  tenantId: string;
  taskId: string;
  message: {
    message: Message;
    metadata?: Record<string, unknown>;
  };
  allowPrivate?: boolean;
  /** Our callback URL where the remote agent should POST status updates */
  pushNotificationUrl: string;
  /** Token that authenticates push notification callbacks */
  pushNotificationToken: string;
}

export type SendTaskAsyncDeps = SendTaskDeps;

/**
 * Send a task to a remote agent in non-blocking mode with push notification config.
 *
 * The remote agent's response is a Task in 'submitted' or 'working' state.
 * When the task completes, the remote agent POSTs to our pushNotificationUrl.
 *
 * @throws SyncResponseForAsyncRequest if the remote agent completes synchronously
 */
export async function sendTaskAsync(
  params: SendTaskAsyncParams,
  deps: SendTaskAsyncDeps,
): Promise<Task> {
  // Warn if contextId is missing (multi-turn session continuity will not work)
  if (!params.message?.message?.contextId) {
    log.warn(
      'Outbound A2A task sent without contextId — multi-turn session continuity will not work',
      {
        endpoint: params.endpoint,
        taskId: params.taskId,
      },
    );
  }

  // Build the message with push notification configuration
  const messageWithPush = {
    ...params.message,
    configuration: {
      ...(params.message as any).configuration,
      acceptedOutputModes: ['text'],
      blocking: false,
      pushNotificationConfig: {
        url: params.pushNotificationUrl,
        token: params.pushNotificationToken,
      },
    },
  };

  const result = await sendTask(
    {
      endpoint: params.endpoint,
      tenantId: params.tenantId,
      taskId: params.taskId,
      message: messageWithPush,
      allowPrivate: params.allowPrivate,
    },
    deps,
  );

  // Check if result is a Task or a Message
  if ((result as any).kind !== 'task') {
    // Remote agent returned a Message (immediate response) instead of Task.
    // This means the task completed synchronously despite our non-blocking request.
    throw new SyncResponseForAsyncRequest(result);
  }

  return result as Task;
}

/**
 * Thrown when a remote agent returns a synchronous response for a
 * non-blocking request. The caller should handle the result inline
 * instead of creating a suspension.
 */
export class SyncResponseForAsyncRequest extends Error {
  constructor(public readonly result: unknown) {
    super('Remote agent returned synchronous response for non-blocking request');
    this.name = 'SyncResponseForAsyncRequest';
  }
}
