export type AgentDesktopEventType =
  | 'agent_message'
  | 'agent_connected'
  | 'agent_disconnected'
  | 'agent_typing'
  | 'session_closed';

export interface AgentDesktopEventJob {
  sessionKey: string;
  tenantId: string;
  contactId: string;
  channel: string;
  eventType: AgentDesktopEventType;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface SdkNotificationJob {
  callbackUrl: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  timestamp: number;
}

export interface DurableEventConfig {
  maxRetries: number;
  backoffType: 'exponential' | 'fixed';
  initialDelayMs: number;
  concurrency: number;
}

export const DEFAULT_EVENT_CONFIG: DurableEventConfig = {
  maxRetries: 3,
  backoffType: 'exponential',
  initialDelayMs: 1000,
  concurrency: 10,
};
