/**
 * Kore SmartAssist Event Handler
 *
 * Maps XO event types to ABL agent event types.
 * Processes inbound events from SmartAssist and routes
 * them to registered handlers.
 */
import { createLogger } from '@abl/compiler/platform';
import type { AgentEventType, AgentMessageHandler, TransferChannel } from '../../types.js';

const log = createLogger('kore-event-handler');

export interface XOEvent {
  type: string;
  /** SmartAssist sends eventName instead of type — normalized in webhook route */
  eventName?: string;
  conversationId: string;
  botId?: string;
  userId?: string;
  orgId?: string;
  data?: Record<string, unknown>;
  /** SmartAssist wraps event data in a payload field */
  payload?: Record<string, unknown>;
  message?: string;
  agentInfo?: Record<string, unknown>;
  timestamp?: string;
}

const XO_EVENT_MAP = new Map<string, AgentEventType>([
  // SmartAssist XO webhook event names (start_kore_* prefix format)
  ['start_kore_agent_chat_message_for_user', 'agent:message'],
  ['start_kore_agent_chat_form_for_user', 'agent:form'],
  ['start_kore_agent_chat_typing_for_user', 'agent:typing'],
  ['start_kore_agent_chat_stop_typing_for_user', 'agent:typing_stop'],
  ['start_kore_agent_chat_close_for_user', 'agent:disconnected'],
  // Normalized/short event names (used by some XO webhook versions)
  ['agent_message', 'agent:message'],
  ['agent_accepted', 'agent:connected'],
  ['conversation_queued', 'agent:queued'],
  ['closed', 'agent:disconnected'],
  ['typing', 'agent:typing'],
  ['stop_typing', 'agent:typing_stop'],
  ['message_delivered', 'agent:delivery_receipt'],
  ['form_message', 'agent:form'],
  ['proactive_agentassist', 'agent:assist_suggestion'],
  ['agent_joined', 'agent:joined'],
  ['conversation_closed', 'agent:disconnected'],
  ['agent_transferred', 'agent:connected'],
  ['bot_message_delivered', 'agent:delivery_receipt'],
  ['user_message_delivered', 'agent:delivery_receipt'],
  ['queue_position_update', 'agent:queued'],
  ['wait_time_update', 'agent:queued'],
  ['agent_disconnect', 'agent:disconnected'],
  ['call_status_notifications', 'agent:call_status'],
  ['wait_time_voice_message_for_user', 'agent:waiting_message'],
  // SmartAssist sends active_call_status when a voice agent accepts the call.
  // For voice transfers this is the reliable signal that the agent is connected
  // since assign_kore_agent_for_user / agent_accepted are not always sent.
  ['active_call_status', 'agent:connected'],
  ['assign_kore_agent_for_user', 'agent:connected'],
  // SmartAssist sends this when tearing down the agent–customer link after
  // the agent closes the conversation.  It often arrives instead of (or after)
  // the expected start_kore_agent_chat_close_for_user event.
  ['remove_id_to_acc_identity', 'agent:disconnected'],
]);

/**
 * SmartAssist event types that are acknowledged but do not map to an ABL
 * agent event. These are internal control signals (recording, call status
 * probes, Redis sync) that SmartAssist sends during voice transfers.
 * We return early on these to avoid "Unknown XO event type" warnings.
 */
const XO_ACKNOWLEDGED_NOOP = new Set<string>([
  'korevg_recording_controls',
  'update_agent_data_in_redis',
]);

export class KoreEventHandler {
  private readonly messageHandlers: AgentMessageHandler[] = [];

  onAgentMessage(handler: AgentMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  handlerCount(): number {
    return this.messageHandlers.length;
  }

  clear(): void {
    this.messageHandlers.length = 0;
  }

  async processEvent(
    xoEvent: XOEvent,
    sessionContext: {
      tenantId: string;
      contactId: string;
      channel: TransferChannel;
    },
  ): Promise<void> {
    // Acknowledged but no-op events — SmartAssist internal control signals
    if (XO_ACKNOWLEDGED_NOOP.has(xoEvent.type)) {
      log.debug('Acknowledged SmartAssist control event (no-op)', {
        type: xoEvent.type,
        conversationId: xoEvent.conversationId,
      });
      return;
    }

    const ablType = XO_EVENT_MAP.get(xoEvent.type);
    if (!ablType) {
      log.warn('Unknown XO event type, skipping', {
        type: xoEvent.type,
        conversationId: xoEvent.conversationId,
      });
      return;
    }

    // SmartAssist may send message text in various fields depending on event type.
    // Plain messages use xoEvent.message or payload.value.
    // Template messages (CSAT, surveys) use payload.text or payload.body.
    const messageText =
      xoEvent.message ||
      (xoEvent.payload?.value as string | undefined) ||
      (xoEvent.payload?.text as string | undefined) ||
      (xoEvent.payload?.body as string | undefined) ||
      (xoEvent.payload?.message as string | undefined) ||
      (xoEvent.data?.value as string | undefined) ||
      (xoEvent.data?.text as string | undefined) ||
      (xoEvent.data?.body as string | undefined);

    const data: Record<string, unknown> = {
      // Spread payload first so data fields take precedence on collision
      ...xoEvent.payload,
      ...xoEvent.data,
      message: messageText,
      agentInfo: xoEvent.agentInfo || xoEvent.data?.agentInfo || xoEvent.payload?.agentInfo,
      originalType: xoEvent.type,
    };

    // Preserve attachment data from XO events (Phase 3 — attachment handling)
    if (xoEvent.data?.attachments && Array.isArray(xoEvent.data.attachments)) {
      data.attachments = xoEvent.data.attachments;
    }

    if (xoEvent.type === 'assign_kore_agent_for_user' || xoEvent.type === 'agent_accepted') {
      const payload = xoEvent.payload ?? xoEvent.data ?? {};
      if (typeof payload.transferURI === 'string') data.transferURI = payload.transferURI;
      if (Array.isArray(payload.sipHeaders)) {
        data.sipHeaders = payload.sipHeaders.filter(
          (header: Record<string, unknown>) =>
            header &&
            typeof header === 'object' &&
            typeof header.name === 'string' &&
            typeof header.value === 'string',
        );
      }
      if (
        payload.dialHeaders &&
        typeof payload.dialHeaders === 'object' &&
        !Array.isArray(payload.dialHeaders)
      ) {
        data.dialHeaders = payload.dialHeaders;
      }
      if (typeof payload.agentSipURI === 'string') data.agentSipURI = payload.agentSipURI;
      data.isVoice = !!payload.transferURI;
    }

    if (xoEvent.type === 'call_status_notifications') {
      const payload = xoEvent.payload ?? xoEvent.data ?? {};
      data.callStatus = payload.callStatus || payload.event;
      data.disconnectReason = payload.reason;
      data.sipCallId = payload.sipCallId;
    }

    if (xoEvent.type === 'wait_time_voice_message_for_user') {
      const payload = xoEvent.payload ?? xoEvent.data ?? {};
      data.message = payload.value || payload.message || data.message;
      data.audioUrl = payload.audioUrl;
      data.bargeIn = payload.bargeIn ?? true;
      data.bargeInOnDTMF = payload.bargeInOnDTMF ?? true;
    }

    const agentEvent = {
      type: ablType,
      sessionId: xoEvent.conversationId,
      tenantId: sessionContext.tenantId,
      contactId: sessionContext.contactId,
      channel: sessionContext.channel,
      timestamp: xoEvent.timestamp ?? new Date().toISOString(),
      data,
    };

    // Fallback connection detection: SmartAssist sometimes delivers the agent
    // connection notification as a plain agent:message with an agentInfo field
    // (e.g. "You are now connected with <name>") instead of (or before) the
    // dedicated assign_kore_agent_for_user event.  Synthesize an agent:connected
    // event BEFORE the message so the platform event fires and session state
    // transitions to active.  Index.ts deduplicates via session-state guard.
    if (ablType === 'agent:message' && data.agentInfo != null) {
      const agentInfoObj = data.agentInfo as Record<string, unknown>;
      const firstName = typeof agentInfoObj.firstName === 'string' ? agentInfoObj.firstName : '';
      const lastName = typeof agentInfoObj.lastName === 'string' ? agentInfoObj.lastName : '';
      const agentName = [firstName, lastName].filter(Boolean).join(' ') || undefined;

      log.info('Synthesizing agent:connected from agentInfo in agent message', {
        sessionId: xoEvent.conversationId,
        originalType: xoEvent.type,
      });

      const connectedEvent = {
        ...agentEvent,
        type: 'agent:connected' as AgentEventType,
        data: { ...data, agentName, syntheticConnected: true },
      };

      for (const handler of this.messageHandlers) {
        try {
          await handler(connectedEvent);
        } catch (err) {
          log.error('Synthetic connected handler threw', {
            sessionId: xoEvent.conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const handler of this.messageHandlers) {
      try {
        await handler(agentEvent);
      } catch (err) {
        log.error('Agent event handler threw', {
          type: ablType,
          sessionId: xoEvent.conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback disconnect detection: SmartAssist sometimes sends the
    // conversation-close notification as a plain agent:message with text
    // "<name> has now closed this conversation" instead of (or before)
    // the dedicated close event.  Synthesize an agent:disconnected event
    // so the transfer flags are cleared and the AI agent can resume.
    if (
      ablType === 'agent:message' &&
      typeof messageText === 'string' &&
      /has now closed this conversation/i.test(messageText)
    ) {
      log.info('Detected conversation-close message, synthesizing agent:disconnected', {
        sessionId: xoEvent.conversationId,
        originalType: xoEvent.type,
      });
      const disconnectEvent = {
        ...agentEvent,
        type: 'agent:disconnected' as AgentEventType,
        data: { ...data, syntheticDisconnect: true, closeMessage: messageText },
      };
      for (const handler of this.messageHandlers) {
        try {
          await handler(disconnectEvent);
        } catch (err) {
          log.error('Synthetic disconnect handler threw', {
            sessionId: xoEvent.conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  static mapEventType(xoType: string): AgentEventType | undefined {
    return XO_EVENT_MAP.get(xoType);
  }

  static supportedEventTypes(): string[] {
    return Array.from(XO_EVENT_MAP.keys());
  }
}
