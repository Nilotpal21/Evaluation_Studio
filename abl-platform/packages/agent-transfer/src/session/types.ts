/**
 * Transfer Session Types
 *
 * Data model for agent transfer sessions stored in Redis.
 * Sessions track the lifecycle of a conversation handoff from
 * an AI agent to a human agent on an external desktop.
 */

import type { TransferContextSnapshot, TransferRoutingContext } from '../types.js';

/** Transfer session states */
export type TransferSessionState = 'pending' | 'queued' | 'active' | 'post_agent' | 'ended';

/** Channel types with their default TTLs (seconds) */
export const CHANNEL_TTL_DEFAULTS: Record<string, number> = {
  chat: 1800, // 30min
  email: 86400, // 24hr
  voice: 0, // 0 = session duration (no timeout)
  messaging: 1800, // 30min
  campaign: 3600, // 1hr
  default: 1800,
};

/** Voice-specific transfer state persisted with the session. */
export interface VoiceTransferData {
  callSid: string;
  sipCallId?: string;
  agentSipURI?: string;
  disconnectReason?: string;
}

/** Data stored in the Redis session hash */
export interface TransferSessionData {
  tenantId: string;
  ownerId: string;
  contactId: string;
  channel: string;
  provider: string;
  providerSessionId: string;
  state: TransferSessionState;
  metadata: Record<string, unknown>;
  providerData: Record<string, unknown>;
  routing?: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  ownerPod: string;
  lastHeartbeat: number;
  createdAt: number;
  updatedAt: number;
  ttl: number;
  agentId?: string;
  projectId?: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  postAgentConfig?: { action: string; dialogId?: string; surveyType?: string };
  csatSurveyType?: string;
  csatDialogId?: string;
  csatStartedAt?: number;
  csatCompletedAt?: number;
  dispositionCode?: string;
  wrapUpNotes?: string;
  acwEnabled?: boolean;
  acwTimedOut?: boolean;
  acwCloseReason?: 'timeout' | 'agent_closed';
  acwEndedAt?: number;
  acwCompletedEmitted?: boolean;
  acwExpected?: boolean;
  voiceData?: VoiceTransferData;
}

/** Input for creating a new transfer session */
export interface CreateTransferSessionInput {
  tenantId: string;
  ownerId?: string;
  contactId: string;
  channel: string;
  provider: string;
  providerSessionId: string;
  ownerPod: string;
  ttl?: number;
  metadata?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
  routing?: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  agentId?: string;
  projectId?: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  postAgentConfig?: { action: string; dialogId?: string; surveyType?: string };
  voiceData?: Pick<VoiceTransferData, 'callSid' | 'sipCallId'>;
}

/** Fields that can be updated on an existing session */
export interface UpdateTransferSessionFields {
  state?: TransferSessionState;
  metadata?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
  routing?: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  lastHeartbeat?: number;
  ownerPod?: string;
  agentId?: string;
  projectId?: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  postAgentConfig?: { action: string; dialogId?: string; surveyType?: string };
  csatSurveyType?: string;
  csatDialogId?: string;
  csatStartedAt?: number;
  csatCompletedAt?: number;
  dispositionCode?: string;
  wrapUpNotes?: string;
  acwEnabled?: boolean;
  acwTimedOut?: boolean;
  acwCloseReason?: 'timeout' | 'agent_closed';
  acwEndedAt?: number;
  acwCompletedEmitted?: boolean;
  acwExpected?: boolean;
  voiceData?: Partial<VoiceTransferData>;
}

/** Result of a session creation attempt */
export interface CreateSessionResult {
  success: boolean;
  sessionKey?: string;
  error?: { code: string; message: string };
}

/** Result of a session claim attempt */
export interface ClaimSessionResult {
  success: boolean;
  session?: TransferSessionData;
}

/** Redis key builders */
export function sessionKey(tenantId: string, ownerId: string, channel: string): string {
  if (tenantId.includes(':') || ownerId.includes(':') || channel.includes(':')) {
    throw new Error('Session key components must not contain colons');
  }
  return `agent_transfer:${tenantId}:${ownerId}:${channel}`;
}

/**
 * Provider index key — includes tenantId to prevent cross-tenant collisions.
 * Two tenants with the same providerSessionId will NOT collide.
 */
export function providerIndexKey(
  provider: string,
  tenantId: string,
  providerSessionId: string,
): string {
  return `at_by_provider:${provider}:${tenantId}:${providerSessionId}`;
}

export const ACTIVE_SESSIONS_SET = 'at_active_sessions';

export function podSessionsKey(hostname: string): string {
  return `at_pod:${hostname}`;
}

export function podHeartbeatKey(hostname: string): string {
  return `at_pod_heartbeat:${hostname}`;
}

export const RECOVERY_LEADER_KEY = 'at_recovery_leader';
