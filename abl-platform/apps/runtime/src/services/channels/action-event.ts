/**
 * ActionEvent — shared type for inbound user interactions across all channels.
 *
 * All transport layers (WebSocket, REST, A2A, external webhooks) normalize
 * platform-specific interaction payloads into this common shape before
 * passing to the runtime executor.
 */
export interface ActionEvent {
  type: 'action_event';
  actionId: string;
  value?: string;
  formData?: Record<string, unknown>;
  renderId?: string;
  source?:
    | 'websocket'
    | 'sdk'
    | 'rest'
    | 'a2a'
    | 'slack'
    | 'line'
    | 'whatsapp'
    | 'messenger'
    | 'instagram'
    | 'teams'
    | 'zendesk'
    | 'telegram'
    | 'genesys';
}
