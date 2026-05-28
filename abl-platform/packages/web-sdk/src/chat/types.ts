/**
 * Chat-specific types
 */

import type { SendMessageOptions } from '../core/types.js';

export type SendOptions = SendMessageOptions;

export interface ChatState {
  /** All messages in the current session */
  messages: import('../core/types.js').Message[];
  /** Whether the agent is currently typing */
  isTyping: boolean;
  /** Whether a message is currently being sent */
  isSending: boolean;
}
