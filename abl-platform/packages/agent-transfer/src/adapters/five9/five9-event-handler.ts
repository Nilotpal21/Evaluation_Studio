/**
 * Five9 Event Handler
 *
 * Pure static mapping utility that converts Five9 webhook event types
 * to ABL AgentEventType values. Intentionally static-only — Five9Adapter
 * manages handler arrays directly.
 */
import type { AgentEventType } from '../../types.js';

const FIVE9_EVENT_MAP = new Map<string, AgentEventType>([
  ['agent_message', 'agent:message'],
  ['agent_connected', 'agent:connected'],
  ['agent_joined', 'agent:joined'],
  ['agent_disconnected', 'agent:disconnected'],
  ['conversation_queued', 'agent:queued'],
  ['conversation_closed', 'agent:disconnected'],
  ['agent_typing', 'agent:typing'],
  ['agent_typing_stop', 'agent:typing_stop'],
]);

export class Five9EventHandler {
  /**
   * Map a Five9 event type string to an ABL AgentEventType.
   * Returns undefined for unknown/unmapped event types.
   */
  static mapEventType(type: string): AgentEventType | undefined {
    return FIVE9_EVENT_MAP.get(type);
  }

  /**
   * Return all supported Five9 event type strings.
   */
  static supportedEventTypes(): string[] {
    return Array.from(FIVE9_EVENT_MAP.keys());
  }
}
