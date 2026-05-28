import type { Message } from '../core/types.js';

export function isActivityMessage(
  message: Pick<Message, 'role' | 'metadata'> | null | undefined,
): boolean {
  if (!message) {
    return false;
  }

  if (message.role === 'thought') {
    return true;
  }

  if (message.role !== 'system') {
    return false;
  }

  return Boolean(message.metadata?.handoffFrom || message.metadata?.handoffTo);
}
