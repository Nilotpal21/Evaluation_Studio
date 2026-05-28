/**
 * AgentDesktopAdapter Interface
 */
import type { ProviderConfig } from '../config/schema.js';
import type {
  TransferPayload,
  TransferResult,
  UserMessage,
  AgentMessageHandler,
  SessionEventHandler,
  AuthType,
  OperationResult,
} from '../types.js';
import type { XOEvent } from './kore/event-handler.js';

export interface CsatRatingParams {
  userId: string;
  channel: string;
  botId: string;
  score: number;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  comments?: string;
}

export interface AgentDesktopAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  initialize(config: ProviderConfig): Promise<void>;
  execute(payload: TransferPayload): Promise<TransferResult>;
  sendUserMessage(sessionId: string, message: UserMessage): Promise<void>;
  endSession(sessionId: string, reason: string): Promise<void>;
  onAgentMessage(handler: AgentMessageHandler): void;
  onSessionEvent(handler: SessionEventHandler): void;
  /**
   * Handle an inbound webhook event from the provider.
   * The adapter normalizes the event type, extends session TTL,
   * and fires onAgentMessage callbacks internally.
   */
  handleInboundEvent(event: XOEvent, tenantId: string): Promise<void>;
  /**
   * Send a typing indicator to the agent desktop for the given session.
   * Optional — not all providers support outbound typing notifications.
   */
  sendTypingIndicator?(sessionId: string): Promise<void>;
  submitCsatRating?(params: CsatRatingParams): Promise<OperationResult<{ message?: string }>>;
  checkHealth?(): Promise<boolean>;
  recoverSessions?(hostname: string): Promise<void>;
  invalidateAuth?(tenantId: string): void;
  close?(): Promise<void>;
}

export interface AdapterCapabilities {
  supportsPreChecks: boolean;
  supportsPostAgentDialog: boolean;
  supportsFileUpload: boolean;
  supportsTranslation: boolean;
  transportType: 'polling' | 'webhook' | 'websocket' | 'direct' | 'pubsub';
  authType: AuthType;
}
