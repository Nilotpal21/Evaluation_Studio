import { createLogger } from '@abl/compiler/platform';
import { redactPII } from '@abl/compiler';
import type { Channel, MessageMetadata, MessageRole } from '@abl/compiler/platform/core/types.js';
import type { AgentEvent, TransferSessionData } from '@agent-platform/agent-transfer';
import type { EventStoreServices } from '@abl/eventstore';
import { flushMessageQueue, persistMessageRecord } from '../message-persistence-queue.js';
import { findLatestMessageForSession } from '../../repos/session-repo.js';
import { emitToEventStore } from '../trace/emit-to-eventstore.js';
import { getEventStore } from '../eventstore-singleton.js';

const log = createLogger('agent-transfer-transcript-persistence');
const DUPLICATE_AGENT_TRANSFER_WINDOW_MS = 15_000;

type AgentTransferDeliveryChannel =
  | 'websocket'
  | 'channel_adapter'
  | 'voice_gateway'
  | 'acw_metadata';
type AgentTransferParticipantType = 'user' | 'human_agent' | 'system';
type AgentTransferDirection = 'user_to_agent' | 'agent_to_user' | 'system_to_user';
type AgentTransferTranscriptFlushReason =
  | 'runtime_execution_exit'
  | 'runtime_execution_error'
  | 'voice_session_close'
  | 'realtime_voice_session_close'
  | 'transfer_session_end';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PERSISTED_AGENT_TRANSFER_EVENT_DATA_KEYS = [
  'aId',
  'acwCloseReason',
  'acwTimedOut',
  'agentId',
  'body',
  'closeRemarks',
  'closeStatus',
  'closedBy',
  'conversationId',
  'csatMessage',
  'csatRequested',
  'csatRequired',
  'csatSurveyType',
  'dispositionSets',
  'event',
  'iId',
  'id',
  'isACWEnabled',
  'language',
  'message',
  'metaStatus',
  'orgId',
  'originalType',
  'skipSessionCreation',
  'source',
  'surveyType',
  'text',
  'traceId',
  'userId',
] as const;

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function addNonEmptySessionId(target: Set<string>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

function resolveParentConversationSessionId(session: TransferSessionData): string | null {
  const routingConversationId = session.routing?.conversationSessionId?.trim();
  if (routingConversationId) {
    return routingConversationId;
  }

  const metadataConversationId = session.metadata?.conversationSessionId;
  if (typeof metadataConversationId === 'string' && metadataConversationId.trim().length > 0) {
    return metadataConversationId;
  }

  const routingRuntimeId = session.routing?.runtimeSessionId?.trim();
  if (routingRuntimeId) {
    return routingRuntimeId;
  }

  return session.ownerId.trim().length > 0 ? session.ownerId : null;
}

function resolveChannel(session: TransferSessionData): Channel {
  const source = session.routing?.sourceChannelType?.toLowerCase();

  if (session.channel === 'voice') {
    return 'voice';
  }
  if (session.channel === 'email') {
    return 'email';
  }

  if (source === 'whatsapp') {
    return 'whatsapp';
  }
  if (source === 'sms' || source === 'twilio_sms') {
    return 'sms';
  }
  if (source === 'api' || source === 'http') {
    return 'api';
  }
  if (source === 'web_debug' || source === 'sdk_websocket' || source === 'debug_websocket') {
    return 'web_debug';
  }
  if (session.channel === 'messaging') {
    return 'http_async';
  }

  return 'web_chat';
}

function resolveContactId(session: TransferSessionData): string | undefined {
  const resolvedContactId = session.routing?.resolvedContactId?.trim();
  if (resolvedContactId) {
    return resolvedContactId;
  }
  return session.contactId.trim().length > 0 ? session.contactId : undefined;
}

function resolveTenantId(session: TransferSessionData): string | null {
  const tenantId = session.tenantId.trim();
  return tenantId.length > 0 ? tenantId : null;
}

function buildBaseCustomMetadata(params: {
  transferSessionId: string;
  transferSession: TransferSessionData;
  direction: AgentTransferDirection;
  participantType: AgentTransferParticipantType;
  deliveryChannel?: AgentTransferDeliveryChannel;
  eventType?: AgentEvent['type'];
  agentInfo?: unknown;
}): Record<string, unknown> {
  const custom: Record<string, unknown> = {
    source: 'agent-transfer',
    transferSessionId: params.transferSessionId,
    provider: params.transferSession.provider,
    providerSessionId: params.transferSession.providerSessionId,
    participantType: params.participantType,
    direction: params.direction,
    transferState: params.transferSession.state,
  };

  if (params.deliveryChannel) {
    custom.deliveryChannel = params.deliveryChannel;
  }
  if (params.eventType) {
    custom.eventType = params.eventType;
  }
  if (isPlainObject(params.agentInfo)) {
    custom.agentInfo = params.agentInfo;
  }

  return custom;
}

function buildPersistedAgentTransferEventData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  const persisted: Record<string, unknown> = {};

  for (const key of PERSISTED_AGENT_TRANSFER_EVENT_DATA_KEYS) {
    const value = data[key];
    if (value !== undefined) {
      persisted[key] = value;
    }
  }

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

export class AgentTransferTranscriptPersistenceService {
  constructor(private readonly getEventStoreFn: () => EventStoreServices | null = getEventStore) {}

  async persistForwardedUserMessage(params: {
    transferSessionId: string;
    transferSession: TransferSessionData;
    content: string;
    traceId?: string;
    messageTimestamp?: number;
  }): Promise<void> {
    await this.persistTransferTranscriptMessage({
      transferSessionId: params.transferSessionId,
      transferSession: params.transferSession,
      role: 'user',
      content: params.content,
      traceId: params.traceId,
      messageTimestamp: params.messageTimestamp,
      metadata: {
        ...(params.transferSession.channel === 'voice' ? { voiceType: 'asr' as const } : {}),
        custom: buildBaseCustomMetadata({
          transferSessionId: params.transferSessionId,
          transferSession: params.transferSession,
          direction: 'user_to_agent',
          participantType: 'user',
        }),
      },
    });
  }

  async persistDeliveredAgentEvent(params: {
    transferSessionId: string;
    transferSession: TransferSessionData;
    event: AgentEvent;
    content: string;
    deliveryChannel: AgentTransferDeliveryChannel;
    traceId?: string;
  }): Promise<void> {
    if (params.event.tenantId !== params.transferSession.tenantId) {
      log.warn('Skipping agent transfer transcript persistence for tenant mismatch', {
        transferSessionId: params.transferSessionId,
        transferTenantId: params.transferSession.tenantId,
        eventTenantId: params.event.tenantId,
        provider: params.transferSession.provider,
      });
      return;
    }

    const providerEventData = buildPersistedAgentTransferEventData(
      isPlainObject(params.event.data) ? params.event.data : undefined,
    );

    await this.persistTransferTranscriptMessage({
      transferSessionId: params.transferSessionId,
      transferSession: params.transferSession,
      role: 'assistant',
      content: params.content,
      traceId: params.traceId,
      messageTimestamp: parseTimestamp(params.event.timestamp),
      metadata: {
        ...(params.transferSession.channel === 'voice' ? { voiceType: 'tts' as const } : {}),
        custom: {
          ...buildBaseCustomMetadata({
            transferSessionId: params.transferSessionId,
            transferSession: params.transferSession,
            direction: 'agent_to_user',
            participantType: 'human_agent',
            deliveryChannel: params.deliveryChannel,
            eventType: params.event.type,
            agentInfo: params.event.data?.agentInfo,
          }),
          ...(providerEventData ? { providerEventData } : {}),
        },
      },
    });
  }

  async persistObservedAgentTranscript(params: {
    transferSessionId: string;
    transferSession: TransferSessionData;
    content: string;
    traceId?: string;
    messageTimestamp?: number;
    agentInfo?: Record<string, unknown>;
  }): Promise<void> {
    await this.persistTransferTranscriptMessage({
      transferSessionId: params.transferSessionId,
      transferSession: params.transferSession,
      role: 'assistant',
      content: params.content,
      traceId: params.traceId,
      messageTimestamp: params.messageTimestamp,
      metadata: {
        ...(params.transferSession.channel === 'voice' ? { voiceType: 'asr' as const } : {}),
        custom: buildBaseCustomMetadata({
          transferSessionId: params.transferSessionId,
          transferSession: params.transferSession,
          direction: 'agent_to_user',
          participantType: 'human_agent',
          eventType: 'agent:message',
          agentInfo: params.agentInfo,
        }),
      },
    });
  }

  async flushTransferTranscriptQueue(params: {
    transferSessionId?: string;
    transferSession?: TransferSessionData;
    parentConversationSessionId?: string | null;
    runtimeSessionId?: string | null;
    reason: AgentTransferTranscriptFlushReason;
  }): Promise<void> {
    const dbSessionIds = new Set<string>();

    if (params.transferSession) {
      addNonEmptySessionId(
        dbSessionIds,
        resolveParentConversationSessionId(params.transferSession),
      );
    }
    addNonEmptySessionId(dbSessionIds, params.parentConversationSessionId);
    addNonEmptySessionId(dbSessionIds, params.runtimeSessionId);

    if (dbSessionIds.size === 0) {
      log.warn('Skipping agent transfer transcript queue flush without parent session id', {
        transferSessionId: params.transferSessionId,
        reason: params.reason,
      });
      return;
    }

    for (const dbSessionId of dbSessionIds) {
      await flushMessageQueue(dbSessionId);
    }

    log.info('Flushed agent transfer transcript queue', {
      transferSessionId: params.transferSessionId,
      dbSessionIds: [...dbSessionIds],
      reason: params.reason,
    });
  }

  async flushRuntimeSessionTransferTranscript(params: {
    runtimeSessionId: string;
    tenantId?: string;
    channelType?: string;
    parentConversationSessionId?: string | null;
    reason: AgentTransferTranscriptFlushReason;
  }): Promise<void> {
    let transferSessionId: string | undefined;
    let transferSession: TransferSessionData | undefined;
    const tenantId = params.tenantId?.trim();

    if (tenantId && params.runtimeSessionId.trim().length > 0) {
      try {
        const [{ getTransferSessionStore }, at] = await Promise.all([
          import('./index.js'),
          import('@agent-platform/agent-transfer'),
        ]);
        const store = getTransferSessionStore();
        if (store) {
          const channel = at.normalizeTransferChannel(params.channelType);
          transferSessionId = at.sessionKey(tenantId, params.runtimeSessionId, channel);
          const loaded = await store.get(transferSessionId);
          if (loaded) {
            transferSession = loaded as TransferSessionData;
          }
        }
      } catch (err) {
        log.warn('Failed to resolve transfer session for transcript queue flush', {
          runtimeSessionId: params.runtimeSessionId,
          tenantId,
          channelType: params.channelType,
          reason: params.reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.flushTransferTranscriptQueue({
      transferSessionId,
      transferSession,
      parentConversationSessionId: params.parentConversationSessionId,
      runtimeSessionId: params.runtimeSessionId,
      reason: params.reason,
    });
  }

  private async persistTransferTranscriptMessage(params: {
    transferSessionId: string;
    transferSession: TransferSessionData;
    role: MessageRole;
    content: string;
    traceId?: string;
    messageTimestamp?: number;
    metadata: Partial<MessageMetadata>;
  }): Promise<void> {
    const parentConversationSessionId = resolveParentConversationSessionId(params.transferSession);
    if (!parentConversationSessionId) {
      log.warn('Skipping agent transfer transcript persistence without parent session id', {
        transferSessionId: params.transferSessionId,
        tenantId: params.transferSession.tenantId,
        provider: params.transferSession.provider,
      });
      return;
    }

    const tenantId = resolveTenantId(params.transferSession);
    if (!tenantId) {
      log.warn('Skipping agent transfer transcript persistence without tenant id', {
        transferSessionId: params.transferSessionId,
        parentConversationSessionId,
        provider: params.transferSession.provider,
      });
      return;
    }

    if (!params.transferSession.projectId) {
      log.warn('Skipping agent transfer transcript persistence without project id', {
        transferSessionId: params.transferSessionId,
        tenantId,
        parentConversationSessionId,
      });
      return;
    }

    if (
      params.role === 'assistant' &&
      (await this.isDuplicateDeliveredAgentMessage({
        parentConversationSessionId,
        transferSessionId: params.transferSessionId,
        tenantId,
        content: params.content,
        role: params.role,
        messageTimestamp: params.messageTimestamp,
      }))
    ) {
      log.info('Skipping duplicate agent transfer transcript message', {
        transferSessionId: params.transferSessionId,
        tenantId,
        parentConversationSessionId,
        provider: params.transferSession.provider,
      });
      return;
    }

    await persistMessageRecord({
      dbSessionId: parentConversationSessionId,
      role: params.role,
      content: params.content,
      channel: resolveChannel(params.transferSession),
      tenantId,
      traceId: params.traceId,
      contactId: resolveContactId(params.transferSession),
      projectId: params.transferSession.projectId,
      messageTimestamp: params.messageTimestamp,
      metadata: params.metadata,
    });

    const eventStore = this.getEventStoreFn();
    if (eventStore) {
      emitToEventStore({
        eventStore,
        event: {
          id: `at-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: params.role === 'user' ? 'user_message' : 'agent_response',
          tenantId,
          projectId: params.transferSession.projectId ?? '',
          sessionId: parentConversationSessionId,
          timestamp: new Date(params.messageTimestamp ?? Date.now()),
          data: {
            contentLength: params.content.length,
            channel: resolveChannel(params.transferSession),
            participantType: params.role === 'user' ? 'user' : 'human_agent',
            source: 'agent-transfer',
            transferSessionId: params.transferSessionId,
            provider: params.transferSession.provider,
          },
        },
        scrubPII: true,
        redactPIIFn: (value: string) => redactPII(value),
      });
    }
  }

  private async isDuplicateDeliveredAgentMessage(params: {
    parentConversationSessionId: string;
    transferSessionId: string;
    tenantId: string;
    content: string;
    role: MessageRole;
    messageTimestamp?: number;
  }): Promise<boolean> {
    const latestMessage = await findLatestMessageForSession(
      params.parentConversationSessionId,
      params.tenantId,
    );
    if (!latestMessage) {
      return false;
    }

    if (latestMessage.role !== params.role || latestMessage.content !== params.content) {
      return false;
    }

    const latestMetadata = isPlainObject(latestMessage.metadata) ? latestMessage.metadata : null;
    const latestCustom =
      latestMetadata && isPlainObject(latestMetadata.custom) ? latestMetadata.custom : null;
    if (!latestCustom) {
      return false;
    }

    if (
      latestCustom.source !== 'agent-transfer' ||
      latestCustom.transferSessionId !== params.transferSessionId ||
      latestCustom.direction !== 'agent_to_user'
    ) {
      return false;
    }

    const candidateTimestamp = params.messageTimestamp ?? Date.now();
    const latestTimestamp = latestMessage.timestamp.getTime();
    return Math.abs(candidateTimestamp - latestTimestamp) <= DUPLICATE_AGENT_TRANSFER_WINDOW_MS;
  }
}

let transcriptPersistenceService: AgentTransferTranscriptPersistenceService | null = null;

export function getAgentTransferTranscriptPersistenceService(): AgentTransferTranscriptPersistenceService {
  if (!transcriptPersistenceService) {
    transcriptPersistenceService = new AgentTransferTranscriptPersistenceService();
  }

  return transcriptPersistenceService;
}
