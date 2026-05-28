/**
 * Event Types and PlatformEvent Interface
 *
 * Defines the canonical event envelope, payload interfaces, event type catalog,
 * and the EventBus contract for the Runtime Event Production System.
 *
 * All runtime business events conform to PlatformEvent<T, P> — a self-describing
 * envelope carrying tenant context, session identity, and a typed payload.
 */

import { EVENT_TOPIC_PREFIX } from '@agent-platform/config';
import type {
  CanonicalSessionDisposition,
  CanonicalSessionStatus,
  SessionTerminalSource,
} from '@abl/compiler/platform/core/types';
import type { BillingMaterializationBasis } from '@agent-platform/database/models';
import type { ResponseMessageMetadata } from '../channel/response-provenance.js';
import type {
  PersistedMessageStructuredContent,
  PersistedStructuredMessageEnvelopeV2,
} from '../session/persisted-message-content.js';

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

export interface PlatformEvent<T extends string, P> {
  eventId: string;
  type: T;
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  channel: string;
  timestamp: string;
  payload: P;
}

// ---------------------------------------------------------------------------
// Session Event Payloads (lightweight)
// ---------------------------------------------------------------------------

export interface SessionCreatedPayload {
  customerId?: string;
  anonymousId?: string;
  deploymentId?: string;
  resumedFrom?: string;
}

export interface SessionEndedPayload {
  reason?:
    | 'completed'
    | 'timeout'
    | 'error'
    | 'user_left'
    | 'user_exit'
    | CanonicalSessionDisposition;
  disposition?: CanonicalSessionDisposition;
  status?: CanonicalSessionStatus;
  terminalSource?: SessionTerminalSource;
  durationMs?: number;
  turnCount?: number;
  agentsUsed?: string[];
}

export interface SessionHandoffPayload {
  fromAgent: string;
  toAgent: string;
  reason?: string;
  context?: Record<string, unknown>;
}

export interface SessionEscalationPayload {
  agent: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  targetTeam?: string;
}

export interface BillingUsageProjectBreakdownPayload {
  projectId: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageChannelBreakdownPayload {
  channel: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface BillingUsageUpdatedPayload {
  batchId?: string;
  triggerSource?: 'manual' | 'scheduled';
  projectId?: string;
  projectScope?: 'tenant' | 'project';
  materializationBasis?: BillingMaterializationBasis;
  periodLabel?: string;
  windowStart?: string;
  windowEnd?: string;
  completedSessionCount?: number;
  examinedSessionCount?: number;
  includedSessionCount?: number;
  excludedSessionCount?: number;
  baseUnits?: number;
  llmAddonUnits?: number;
  toolAddonUnits?: number;
  totalUnits?: number;
  projectBreakdown?: BillingUsageProjectBreakdownPayload[];
  channelBreakdown?: BillingUsageChannelBreakdownPayload[];
}

// ---------------------------------------------------------------------------
// Message Event Payloads (rich)
// ---------------------------------------------------------------------------

export interface MessageUserPayload {
  messageId: string;
  content: string;
  messageIndex: number;
  locale?: string;
}

export interface MessageAgentPayload {
  messageId: string;
  content: string;
  messageIndex: number;
  structuredContent?: PersistedMessageStructuredContent;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  responseMetadata?: ResponseMessageMetadata;
  modelId?: string;
  tokensUsed?: number;
}

// ---------------------------------------------------------------------------
// Execution Event Payloads (medium)
// ---------------------------------------------------------------------------

export interface ToolCalledPayload {
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface ToolCompletedPayload {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  resultSummary?: string;
}

// ---------------------------------------------------------------------------
// Event Type Catalog
// ---------------------------------------------------------------------------

export type EventType =
  | 'session.created'
  | 'session.ended'
  | 'session.handoff'
  | 'session.escalation'
  | 'billing.usage.updated'
  | 'message.user'
  | 'message.agent'
  | 'tool.called'
  | 'tool.completed';

export const EVENT_TYPES: EventType[] = [
  'session.created',
  'session.ended',
  'session.handoff',
  'session.escalation',
  'billing.usage.updated',
  'message.user',
  'message.agent',
  'tool.called',
  'tool.completed',
];

/**
 * Maps an EventType to its Kafka topic name.
 * E.g. 'message.user' -> 'abl.message.user'
 */
export function eventTypeToTopic(type: EventType): string {
  return `${EVENT_TOPIC_PREFIX}.${type}`;
}

// ---------------------------------------------------------------------------
// EventBus Contract
// ---------------------------------------------------------------------------

export type AnyPlatformEvent = PlatformEvent<string, unknown>;
export type EventSubscriber = (event: AnyPlatformEvent) => void;

export interface EventBus {
  emit(event: AnyPlatformEvent): void;
  subscribe(fn: EventSubscriber): void;
  unsubscribe(fn: EventSubscriber): void;
  shutdown(): Promise<void>;
}
