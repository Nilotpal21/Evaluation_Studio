export interface PostAgentConfig {
  action: 'end' | 'return' | 'csat';
  dialogId?: string;
  surveyType?: 'inline' | 'dialog';
}

export type CsatEventType = 'csat_started' | 'csat_completed' | 'csat_skipped';

export interface CsatSessionEvent {
  type: CsatEventType;
  sessionKey: string;
  tenantId: string;
  contactId: string;
  channel: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type CsatEventHandler = (event: CsatSessionEvent) => void | Promise<void>;
