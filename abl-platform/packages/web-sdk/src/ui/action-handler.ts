/**
 * Action Handler
 *
 * Creates action callbacks that use ChatClient.submitAction()
 * to send action_submit WebSocket messages when users interact
 * with buttons, selects, or form inputs in rich content.
 */

import type { ChatClient } from '../chat/ChatClient.js';
import type { ActionSubmitOptions } from '../core/types.js';

/**
 * Create an action callback bound to a ChatClient instance.
 */
export function createActionHandler(
  chat: ChatClient | null,
): (actionId: string, value?: string, options?: ActionSubmitOptions) => void {
  return (actionId: string, value?: string, options?: ActionSubmitOptions) => {
    chat?.submitAction(
      actionId,
      options ? { ...options, ...(value !== undefined ? { value } : {}) } : value,
    );
  };
}
