/**
 * Agent Transfer Message Bridge
 *
 * Routes agent messages from the agent desktop (SmartAssist, etc.)
 * back to the user's channel. Supports WebSocket (Studio debug),
 * channel adapters (Slack, WhatsApp), and voice gateway.
 *
 * The bridge maintains a session-to-WebSocket mapping for real-time
 * message push to connected clients.
 */

import type { WebSocket } from 'ws';
import { hostname } from 'os';
import { createLogger } from '@abl/compiler/platform';
import { createSubscriber } from '@agent-platform/redis';
import type { RedisConnectionHandle, RedisClient as DualRedisClient } from '@agent-platform/redis';
import type {
  AgentEvent,
  VoiceGatewaySession,
  DialAgentOptions,
  TransferSessionData,
} from '@agent-platform/agent-transfer';
import type { ChannelType, NormalizedOutgoingMessage } from '../../channels/types.js';
import {
  registerSessionWebSocket,
  unregisterSessionWebSocket,
  getSessionWebSocket,
} from './session-ws-registry.js';

const log = createLogger('agent-transfer-bridge');

const CROSS_POD_CHANNEL = 'at:cross_pod:agent_events';
const MAX_RELAY_PAYLOAD_BYTES = 256 * 1024; // 256 KB — guards against memory pressure from oversized events
const podId = hostname();
type AgentTransferDeliveryChannel =
  | 'websocket'
  | 'channel_adapter'
  | 'voice_gateway'
  | 'acw_metadata';

interface ParsedTransferSessionKey {
  tenantId: string;
  contactId: string;
  channel: string;
}

function parseTransferSessionKey(value: string): ParsedTransferSessionKey | null {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'agent_transfer') {
    return null;
  }

  const [, tenantId, contactId, channel] = parts;
  if (!tenantId || !contactId || !channel) {
    return null;
  }

  return { tenantId, contactId, channel };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function resolveAgentMessageContent(event: AgentEvent): string | undefined {
  if (event.type !== 'agent:message') {
    return undefined;
  }

  return firstNonEmptyString(event.data?.message, event.data?.text, event.data?.body);
}

// ---------------------------------------------------------------------------
// Form Rendering
// ---------------------------------------------------------------------------

/**
 * A single field in a form definition.
 * Covers common patterns: text inputs, selects, date pickers, checkboxes, etc.
 */
interface FormField {
  label?: string;
  name?: string;
  type?: string;
  value?: unknown;
  options?: Array<{ label?: string; value?: unknown }> | string[];
  required?: boolean;
  placeholder?: string;
  description?: string;
}

/**
 * Convert form JSON data to human-readable plain text.
 *
 * Handles common form patterns:
 * - `{ title, fields[] }` — labelled field list
 * - `{ title, description }` — simple info card
 * - Array of fields at the top level
 * - Arbitrary key/value objects as a last resort
 *
 * Returns a string suitable for any text-only channel.
 */
export function renderFormAsText(formData: unknown): string {
  if (formData == null) return '';

  // Primitive value — just stringify
  if (typeof formData !== 'object') return String(formData);

  // Array of fields
  if (Array.isArray(formData)) {
    return renderFieldList(formData as FormField[]);
  }

  const obj = formData as Record<string, unknown>;
  const lines: string[] = [];

  // Title
  if (typeof obj.title === 'string' && obj.title) {
    lines.push(obj.title);
    lines.push('---');
  }

  // Description
  if (typeof obj.description === 'string' && obj.description) {
    lines.push(obj.description);
  }

  // Message (some form payloads use a `message` field)
  if (typeof obj.message === 'string' && obj.message) {
    lines.push(obj.message);
  }

  // Fields array
  if (Array.isArray(obj.fields)) {
    lines.push(renderFieldList(obj.fields as FormField[]));
  }

  // If no structured content was extracted, fall back to key/value dump
  if (lines.length === 0) {
    return renderKeyValues(obj);
  }

  return lines.filter(Boolean).join('\n');
}

function renderFieldList(fields: FormField[]): string {
  return fields
    .map((field) => {
      const label = field.label || field.name || 'Field';
      const parts: string[] = [];

      // Main label and current value
      if (field.value !== undefined && field.value !== null && field.value !== '') {
        parts.push(`${label}: ${String(field.value)}`);
      } else {
        parts.push(`${label}${field.required ? ' (required)' : ''}`);
      }

      // Type hint when relevant
      if (field.type && !['text', 'string'].includes(field.type)) {
        parts[0] += ` [${field.type}]`;
      }

      // Placeholder as hint
      if (field.placeholder && !field.value) {
        parts.push(`  Hint: ${field.placeholder}`);
      }

      // Select / radio options
      if (field.options && field.options.length > 0) {
        const optionLabels = field.options.map((opt) =>
          typeof opt === 'string' ? opt : (opt.label ?? String(opt.value ?? opt)),
        );
        parts.push(`  Options: ${optionLabels.join(', ')}`);
      }

      // Description
      if (field.description) {
        parts.push(`  ${field.description}`);
      }

      return parts.join('\n');
    })
    .join('\n');
}

function renderKeyValues(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      try {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } catch {
        lines.push(`${key}: [complex object]`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Session ↔ WebSocket Registry
// ---------------------------------------------------------------------------

// Re-export registry helpers so existing callers (ws-handler) keep working
// without changing their import paths.
export { registerSessionWebSocket, unregisterSessionWebSocket, getSessionWebSocket };

// ---------------------------------------------------------------------------
// Message Bridge
// ---------------------------------------------------------------------------

export class AgentTransferMessageBridge {
  private publisherRedis: DualRedisClient | null = null;
  private subscriberRedis: DualRedisClient | null = null;

  /**
   * Called instead of hangup() when agent:disconnected fires for a voice session
   * with csatRequired=true. The runner is responsible for hanging up the call.
   */
  private voiceCsatRunner:
    | ((sessionId: string, event: AgentEvent, voiceSession: VoiceGatewaySession) => Promise<void>)
    | null = null;

  /**
   * Register a voice CSAT runner callback.
   * When set, agent:disconnected events with csatRequired=true will delegate
   * to this runner instead of immediately hanging up.
   */
  setVoiceCsatRunner(
    runner: (
      sessionId: string,
      event: AgentEvent,
      voiceSession: VoiceGatewaySession,
    ) => Promise<void>,
  ): void {
    this.voiceCsatRunner = runner;
  }

  /**
   * Start the cross-pod relay using Redis pub/sub.
   * When a webhook lands on a pod that doesn't own the user's WebSocket
   * or voice session, the event is published to Redis. The pod that owns
   * the connection picks it up and delivers locally.
   */
  async startCrossPodRelay(handle: RedisConnectionHandle): Promise<void> {
    this.publisherRedis = handle.client;
    this.subscriberRedis = createSubscriber(handle);

    // createSubscriber returns a new connection; explicitly connect if not yet ready.
    if (this.subscriberRedis.status === 'wait') {
      await this.subscriberRedis.connect();
    }

    await this.subscriberRedis.subscribe(CROSS_POD_CHANNEL);
    this.subscriberRedis.on('message', (_channel: string, message: string) => {
      this.handleCrossPodEvent(message).catch((err) => {
        log.error('Failed to handle cross-pod agent event', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    log.info('Cross-pod agent event relay started', { podId });
  }

  async stopCrossPodRelay(): Promise<void> {
    if (this.subscriberRedis) {
      try {
        await this.subscriberRedis.unsubscribe(CROSS_POD_CHANNEL);
        this.subscriberRedis.disconnect();
      } catch (err) {
        log.warn('Failed to disconnect cross-pod subscriber', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.subscriberRedis = null;
    }
    this.publisherRedis = null;
  }

  private async publishCrossPod(sessionKey: string, event: AgentEvent): Promise<void> {
    if (!this.publisherRedis) {
      log.warn('No delivery mechanism for channel (no cross-pod relay)', {
        channel: event.channel,
        eventType: event.type,
      });
      return;
    }

    try {
      const payload = JSON.stringify({ sourcePod: podId, sessionKey, event });

      if (payload.length > MAX_RELAY_PAYLOAD_BYTES) {
        log.warn('Cross-pod relay payload exceeds size limit, dropping', {
          eventType: event.type,
          sessionId: event.sessionId,
          payloadSize: payload.length,
          maxSize: MAX_RELAY_PAYLOAD_BYTES,
        });
        return;
      }

      await this.publisherRedis.publish(CROSS_POD_CHANNEL, payload);
      log.info('Published agent event for cross-pod delivery', {
        eventType: event.type,
        sessionId: event.sessionId,
        channel: event.channel,
      });
    } catch (err) {
      log.error('Failed to publish cross-pod agent event', {
        eventType: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleCrossPodEvent(message: string): Promise<void> {
    if (message.length > MAX_RELAY_PAYLOAD_BYTES) {
      log.warn('Oversized cross-pod message dropped', { size: message.length });
      return;
    }

    let parsed: { sourcePod: string; sessionKey: string; event: AgentEvent };
    try {
      parsed = JSON.parse(message);
    } catch {
      log.warn('Invalid cross-pod agent event message');
      return;
    }

    // Skip events from this pod — we already tried local delivery
    if (parsed.sourcePod === podId) return;

    // Validate required fields to prevent malformed events from propagating
    if (
      !parsed.event ||
      typeof parsed.event.type !== 'string' ||
      typeof parsed.event.sessionId !== 'string' ||
      typeof parsed.event.tenantId !== 'string' ||
      typeof parsed.sessionKey !== 'string'
    ) {
      log.warn('Malformed cross-pod agent event, missing required fields');
      return;
    }

    const parsedSessionKey = parseTransferSessionKey(parsed.sessionKey);
    if (!parsedSessionKey) {
      log.warn('Invalid cross-pod session key format', {
        sessionKey: parsed.sessionKey.slice(0, 50),
      });
      return;
    }

    if (parsed.event.sessionId !== parsed.sessionKey) {
      log.warn('Cross-pod event sessionId does not match relayed session key', {
        eventSessionId: parsed.event.sessionId,
        sessionKeyPrefix: parsed.sessionKey.slice(0, 60),
      });
      return;
    }

    if (parsedSessionKey.tenantId !== parsed.event.tenantId) {
      log.warn('Cross-pod event tenantId does not match session key', {
        eventTenantId: parsed.event.tenantId,
        sessionKeyPrefix: parsed.sessionKey.slice(0, 60),
      });
      return;
    }

    log.info('Received cross-pod agent event', {
      eventType: parsed.event.type,
      sessionId: parsed.event.sessionId,
      sourcePod: parsed.sourcePod,
    });

    await this.routeAgentEvent(parsed.sessionKey, parsed.event, true);
  }

  /**
   * Route an agent event to the user's channel.
   *
   * Determines the delivery mechanism based on the session's channel
   * and available connections:
   * - WebSocket: Direct push to connected Studio client
   * - Webhook channels: Delegate to channel adapter (future)
   * - Voice: Route via voice gateway (future)
   *
   * When no local delivery mechanism is found and fromRelay is false,
   * the event is published to Redis pub/sub for cross-pod delivery.
   */
  async routeAgentEvent(sessionKey: string, event: AgentEvent, fromRelay = false): Promise<void> {
    const { type: eventType, sessionId, contactId, channel } = event;
    const transferSession = await this.loadTransferSessionForTranscript(sessionKey);

    log.info('Routing agent event', {
      eventType,
      sessionId,
      channel,
      fromRelay,
    });

    if (this.shouldSuppressPostAgentDelivery(transferSession, event)) {
      // ACW data messages arrive as agent:message after disconnect but carry
      // metadata (disposition codes, wrap-up notes) that must be recorded even
      // though the message is not shown to the user.
      if (transferSession && this.hasAcwData(event)) {
        log.info('Persisting suppressed ACW data message to transcript', {
          eventType,
          sessionId,
          transferState: transferSession.state,
        });
        void this.persistDeliveredTranscript({
          transferSessionId: sessionKey,
          event,
          content: (event.data?.message as string) || '',
          deliveryChannel: 'acw_metadata',
        });
      }
      log.info('Suppressing post-agent chat delivery', {
        eventType,
        sessionId,
        transferState: transferSession?.state,
        originalType:
          typeof event.data?.originalType === 'string' ? event.data.originalType : undefined,
      });
      return;
    }

    if (this.shouldSuppressDuplicateDisconnect(transferSession, event)) {
      log.info('Suppressing duplicate post-agent disconnect delivery', {
        eventType,
        sessionId,
        transferState: transferSession?.state,
      });
      return;
    }

    // Try WebSocket delivery first (Studio debug sessions).
    // The sessionId is the transfer session key (agent_transfer:tenantId:contactId:channel)
    // but WS connections are registered by the runtime session ID (which is the contactId).
    // Try both keys for lookup.
    // The contactId alias is registered as "tenantId:contactId" to prevent cross-tenant
    // collisions — bare contactIds are only unique within a tenant.
    let ws = getSessionWebSocket(sessionId);
    if (!ws && contactId) {
      ws = getSessionWebSocket(`${event.tenantId}:${contactId}`);
    }
    // Also try extracting contactId from the transfer session key format
    const parsedSessionId = parseTransferSessionKey(sessionId);
    if (!ws && parsedSessionId) {
      ws = getSessionWebSocket(`${parsedSessionId.tenantId}:${parsedSessionId.contactId}`);
    }

    log.info('WebSocket lookup result', {
      eventType,
      sessionId,
      contactId,
      found: !!ws,
    });

    if (ws) {
      return this.deliverViaWebSocket(ws, event, transferSession);
    }

    // For non-WS channels, try channel-specific delivery
    let delivered = false;

    switch (channel) {
      case 'chat':
      case 'messaging':
        delivered = await this.deliverViaChatChannel(event, transferSession);
        break;

      case 'voice':
        delivered = await this.deliverViaVoiceGateway(event, transferSession);
        break;

      default:
        // Try chat channel delivery for any channel with connection metadata
        if (event.data?.channelType && event.data?.connectionId) {
          delivered = await this.deliverViaChatChannel(event, transferSession);
        }
    }

    if (!delivered && !fromRelay) {
      await this.publishCrossPod(sessionKey, event);
    } else if (!delivered && fromRelay) {
      log.warn('No delivery mechanism for channel on any pod', {
        channel,
        eventType,
        sessionId,
      });
    }
  }

  private async loadTransferSessionForTranscript(
    sessionId: string,
  ): Promise<TransferSessionData | null> {
    try {
      const { getTransferSessionStore } = await import('./index.js');
      const store = getTransferSessionStore();
      if (!store) {
        return null;
      }

      return await store.get(sessionId);
    } catch (err) {
      log.debug('Failed to load transfer session for transcript persistence', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private hasAcwData(event: AgentEvent): boolean {
    const data = event.data as Record<string, unknown> | undefined;
    return !!(
      data?.isACWEnabled ||
      data?.dispositionSets ||
      data?.closeRemarks ||
      data?.closeStatus
    );
  }

  private shouldSuppressPostAgentDelivery(
    transferSession: TransferSessionData | null,
    event: AgentEvent,
  ): boolean {
    if (!transferSession) {
      return false;
    }

    if (transferSession.channel === 'voice') {
      return false;
    }

    if (transferSession.state !== 'post_agent' && transferSession.state !== 'ended') {
      return false;
    }

    const postAgentAction = transferSession.postAgentConfig?.action;
    const metadataPostAgentAction =
      typeof transferSession.metadata?.postAgentAction === 'string'
        ? transferSession.metadata.postAgentAction
        : undefined;
    const hasCsatFlow =
      postAgentAction === 'csat' ||
      metadataPostAgentAction === 'csat' ||
      typeof transferSession.csatSurveyType === 'string' ||
      typeof transferSession.csatDialogId === 'string' ||
      typeof transferSession.csatStartedAt === 'number';

    if (hasCsatFlow) {
      return false;
    }

    if (event.type !== 'agent:message') {
      return false;
    }

    return true;
  }

  private shouldSuppressDuplicateDisconnect(
    transferSession: TransferSessionData | null,
    event: AgentEvent,
  ): boolean {
    if (!transferSession) {
      return false;
    }

    if (event.type !== 'agent:disconnected') {
      return false;
    }

    if (transferSession.channel === 'voice') {
      return false;
    }

    return transferSession.state === 'post_agent' || transferSession.state === 'ended';
  }

  private async persistDeliveredTranscript(params: {
    transferSessionId: string;
    event: AgentEvent;
    content: string;
    deliveryChannel: AgentTransferDeliveryChannel;
  }): Promise<void> {
    try {
      const transferSession = await this.loadTransferSessionForTranscript(params.transferSessionId);
      if (!transferSession) {
        return;
      }

      const { getAgentTransferTranscriptPersistenceService } =
        await import('./transcript-persistence.js');
      await getAgentTransferTranscriptPersistenceService().persistDeliveredAgentEvent({
        transferSessionId: params.transferSessionId,
        transferSession,
        event: params.event,
        content: params.content,
        deliveryChannel: params.deliveryChannel,
      });
    } catch (err) {
      log.warn('Agent transfer transcript persistence failed after delivery', {
        transferSessionId: params.transferSessionId,
        eventType: params.event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deliver an agent event via a channel adapter (Slack, WhatsApp, etc.).
   *
   * Handles both `agent:message` (plain text) and `agent:form` (form data)
   * events. For forms, attempts `adapter.transformOutput()` first, then
   * falls back to `renderFormAsText()`.
   *
   * Requires channelType + connectionId in the event's session metadata.
   * Falls back to log-only if no connection metadata is available.
   */
  async deliverViaChatChannel(
    event: AgentEvent,
    transferSession?: TransferSessionData | null,
  ): Promise<boolean> {
    // Only agent:message and agent:form events carry deliverable content
    if (event.type !== 'agent:message' && event.type !== 'agent:form') {
      log.info('Non-deliverable chat event (no channel delivery)', {
        eventType: event.type,
        sessionId: event.sessionId,
      });
      return false;
    }

    // Resolve the text to deliver
    let message: string | undefined;
    if (event.type === 'agent:form') {
      // Form events: the entire data payload is the form structure
      message = renderFormAsText(event.data);
    } else {
      message = resolveAgentMessageContent(event);
    }

    if (!message) {
      log.warn('Agent event has no deliverable content', {
        eventType: event.type,
        sessionId: event.sessionId,
      });
      return false;
    }

    const channelType = event.data?.channelType as ChannelType | undefined;
    const connectionId = event.data?.connectionId as string | undefined;

    if (!channelType || !connectionId) {
      log.info('No channel connection metadata for chat delivery', {
        sessionId: event.sessionId,
        channel: event.channel,
        hasChannelType: !!channelType,
        hasConnectionId: !!connectionId,
      });
      return false;
    }

    try {
      const { getChannelRegistry } = await import('../../channels/registry.js');
      const registry = getChannelRegistry();
      const adapter = registry.get(channelType);

      if (!adapter) {
        log.warn('No channel adapter registered for type', {
          channelType,
          sessionId: event.sessionId,
        });
        return true;
      }

      const { resolveConnectionById } = await import('../../channels/connection-resolver.js');
      const connection = await resolveConnectionById(connectionId, event.tenantId);

      if (!connection) {
        log.warn('Channel connection not found or inactive', {
          connectionId,
          channelType,
          sessionId: event.sessionId,
        });
        return true;
      }

      // For agent:form events, try channel-native transformation first
      let deliveryText = message;
      if (event.type === 'agent:form' && adapter.transformOutput) {
        try {
          const output = adapter.transformOutput(message);
          // Use the text representation from the channel output.
          // Most ChannelOutput variants include `text`, but ag_ui_events does not.
          const outputText = 'text' in output ? (output as { text: string }).text : undefined;
          deliveryText = outputText || message;
          log.info('Form transformed via channel adapter', {
            channelType,
            outputKind: output.kind,
            sessionId: event.sessionId,
          });
        } catch (err) {
          log.warn('Channel adapter transformOutput failed for form, using text fallback', {
            channelType,
            sessionId: event.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          // deliveryText remains as the renderFormAsText() output
        }
      }

      const outgoingMessage: NormalizedOutgoingMessage = {
        sessionId: event.sessionId,
        text: deliveryText,
        eventType: 'agent.response',
        metadata: {
          agentInfo: event.data?.agentInfo,
          transferSessionId: event.sessionId,
          source: 'agent-transfer',
          ...(event.type === 'agent:form' ? { isForm: true } : {}),
        },
      };

      const result = await adapter.sendResponse(outgoingMessage, connection);

      if (result.success) {
        await this.persistDeliveredTranscript({
          transferSessionId: event.sessionId,
          event,
          content: deliveryText,
          deliveryChannel: 'channel_adapter',
        });
        log.info('Agent event delivered via channel adapter', {
          channelType,
          eventType: event.type,
          sessionId: event.sessionId,
          deliveryId: result.deliveryId,
        });
      } else {
        log.error('Channel adapter delivery failed', {
          channelType,
          eventType: event.type,
          sessionId: event.sessionId,
          error: result.error,
        });
      }

      // Deliver attachments as separate messages (Phase 3 — attachment handling)
      const attachments = event.data?.attachments as
        | Array<{
            fileId?: string;
            url?: string;
            fileName?: string;
            fileType?: string;
          }>
        | undefined;
      if (attachments?.length) {
        for (const attachment of attachments) {
          const fileUrl = attachment.url; // NOTE: Do NOT use fileId as URL — fileId needs resolution via SmartAssistClient.resolveFileUrl()
          if (!fileUrl) {
            log.warn('Attachment has no URL, skipping', {
              sessionId: event.sessionId,
              fileName: attachment.fileName,
            });
            continue;
          }
          const attachmentMessage: NormalizedOutgoingMessage = {
            sessionId: event.sessionId,
            text: attachment.fileName ?? 'Attachment',
            eventType: 'agent.attachment',
            metadata: {
              fileUrl,
              fileName: attachment.fileName,
              fileType: attachment.fileType,
              source: 'agent-transfer',
            },
          };
          await adapter.sendResponse(attachmentMessage, connection);
        }
      }
    } catch (err) {
      log.error('Failed to deliver agent event via channel adapter', {
        channelType,
        connectionId,
        eventType: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }

  /**
   * Deliver agent events via the voice gateway.
   * Returns true if a voice session was found and delivery was attempted.
   */
  private async deliverViaVoiceGateway(
    event: AgentEvent,
    transferSession?: TransferSessionData | null,
  ): Promise<boolean> {
    const voiceSession = await this.findVoiceSession(event, transferSession);
    if (!voiceSession) {
      return false;
    }

    try {
      switch (event.type) {
        case 'agent:message': {
          const message = resolveAgentMessageContent(event);
          if (message) {
            voiceSession.sendAgentMessage(message);
            await this.persistDeliveredTranscript({
              transferSessionId: event.sessionId,
              event,
              content: message,
              deliveryChannel: 'voice_gateway',
            });
            log.info('Agent message delivered via TTS', {
              sessionId: event.sessionId,
              textLength: message.length,
            });
          }
          break;
        }

        case 'agent:connected': {
          let transferURI = event.data?.transferURI as string;
          if (!transferURI) {
            log.info('agent:connected with no transferURI, skipping voice dial', {
              sessionId: event.sessionId,
            });
            break;
          }
          if (!voiceSession.dialAgent) {
            log.warn('Voice session does not support dialAgent', {
              sessionId: event.sessionId,
            });
            break;
          }

          // Use the original domain from SmartAssist transferURI as-is.
          // The port suffix (:5060) is stripped by dialAgent().
          log.info('Using original transferURI domain for dial', {
            sessionId: event.sessionId,
          });

          await voiceSession.dialAgent(transferURI, {
            sipHeaders: event.data?.sipHeaders as DialAgentOptions['sipHeaders'],
            dialHeaders: event.data?.dialHeaders as Record<string, string> | undefined,
            abortPrompts: true,
          });
          log.info('Agent dialed into voice call', {
            sessionId: event.sessionId,
          });
          break;
        }

        case 'agent:call_status': {
          const callStatus = event.data?.callStatus as string;
          if (['agent_hangup', 'user_hangup', 'failed', 'busy', 'no_answer'].includes(callStatus)) {
            voiceSession.hangup?.(callStatus);
            log.info('Voice call hangup on call status', {
              sessionId: event.sessionId,
              reason: callStatus,
            });
          }
          break;
        }

        case 'agent:waiting_message': {
          const message = event.data?.message as string;
          if (message && voiceSession.playMessage) {
            voiceSession.playMessage(message, {
              audioUrl: event.data?.audioUrl as string | undefined,
              bargeIn: event.data?.bargeIn as boolean | undefined,
              bargeInOnDTMF: event.data?.bargeInOnDTMF as boolean | undefined,
            });
            log.info('Waiting message played to caller', {
              sessionId: event.sessionId,
              textLength: message.length,
            });
          }
          break;
        }

        case 'agent:disconnected': {
          const csatRequired = event.data?.csatRequired === true;
          if (csatRequired && this.voiceCsatRunner) {
            log.info('[VOICE-CSAT] Delegating to voice CSAT runner', {
              sessionId: event.sessionId,
            });
            this.voiceCsatRunner(event.sessionId, event, voiceSession).catch((err) => {
              log.error('[VOICE-CSAT] Runner failed, falling back to hangup', {
                sessionId: event.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
              voiceSession.hangup?.('agent_disconnect');
            });
          } else {
            voiceSession.hangup?.('agent_disconnect');
            log.info('Voice call ended on agent disconnect', {
              sessionId: event.sessionId,
            });
          }
          break;
        }

        default:
          log.info('Unhandled voice event type', {
            eventType: event.type,
            sessionId: event.sessionId,
          });
      }
    } catch (err) {
      log.error('Failed to deliver voice event', {
        eventType: event.type,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }

  private async findVoiceSession(
    event: AgentEvent,
    transferSession?: TransferSessionData | null,
  ): Promise<VoiceGatewaySession | undefined> {
    try {
      let callSid: string | undefined;

      try {
        const resolvedTransferSession =
          transferSession ?? (await this.loadTransferSessionForTranscript(event.sessionId));
        if (resolvedTransferSession) {
          callSid = resolvedTransferSession.voiceData?.callSid;
          if (!callSid) {
            callSid = resolvedTransferSession.providerData?.callSid as string | undefined;
          }
        }
      } catch (storeErr) {
        log.debug('Transfer session store not available for voice lookup', {
          sessionId: event.sessionId,
          error: storeErr instanceof Error ? storeErr.message : String(storeErr),
        });
      }

      if (callSid) {
        const { getVoiceGatewayRegistry } = await import('@agent-platform/agent-transfer');
        const registry = getVoiceGatewayRegistry();
        const registrySession = registry.findSession(callSid);
        if (registrySession) {
          return registrySession;
        }
      }

      const { getVoiceSession } = await import('../voice/korevg/korevg-session.js');
      if (event.contactId) {
        const runtimeSession = getVoiceSession(event.contactId);
        if (runtimeSession) {
          return runtimeSession as unknown as VoiceGatewaySession;
        }
      }

      if (callSid) {
        const sessionByCallSid = getVoiceSession(callSid);
        if (sessionByCallSid) {
          return sessionByCallSid as unknown as VoiceGatewaySession;
        }
      }

      log.warn('No active voice session for event delivery', {
        eventType: event.type,
        sessionId: event.sessionId,
        contactId: event.contactId,
        callSid,
      });
      return undefined;
    } catch (err) {
      log.error('Failed to find voice session', {
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Push an agent event to a connected WebSocket client.
   */
  private deliverViaWebSocket(
    ws: WebSocket,
    event: AgentEvent,
    transferSession?: TransferSessionData | null,
  ): void {
    if (ws.readyState !== ws.OPEN) {
      log.warn('WebSocket not open for agent event delivery', {
        eventType: event.type,
        sessionId: event.sessionId,
      });
      return;
    }

    const message = {
      type: 'agent_transfer_event',
      sessionId: event.sessionId,
      event: {
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      },
    };

    try {
      ws.send(JSON.stringify(message));
      const transcriptText =
        event.type === 'agent:form'
          ? renderFormAsText(event.data)
          : resolveAgentMessageContent(event);
      if (transcriptText) {
        void this.persistDeliveredTranscript({
          transferSessionId: event.sessionId,
          event,
          content: transcriptText,
          deliveryChannel: 'websocket',
        });
      } else if (this.hasAcwData(event)) {
        // ACW data events delivered to the WebSocket client have no text body
        // but carry metadata (disposition codes, wrap-up notes) that must be
        // persisted even though there is nothing to display in the transcript.
        void this.persistDeliveredTranscript({
          transferSessionId: event.sessionId,
          event,
          content: '',
          deliveryChannel: 'acw_metadata',
        });
      }
      log.info('Agent event delivered via WebSocket', {
        eventType: event.type,
        sessionId: event.sessionId,
      });
    } catch (err) {
      log.error('Failed to send agent event via WebSocket', {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let messageBridge: AgentTransferMessageBridge | null = null;

export function initializeMessageBridge(): AgentTransferMessageBridge {
  if (!messageBridge) {
    messageBridge = new AgentTransferMessageBridge();
    log.info('Agent transfer message bridge initialized');
  }
  return messageBridge;
}

export function getMessageBridge(): AgentTransferMessageBridge | null {
  return messageBridge;
}
