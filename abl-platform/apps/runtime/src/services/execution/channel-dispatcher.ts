/**
 * ChannelDispatcher — delivers async execution results back to the original
 * channel with multi-tier fallback for disconnected channels.
 *
 * Tier 1: Direct delivery (WebSocket on same pod, A2A push notification, async webhook)
 * Tier 2: Cross-pod delivery (Redis Pub/Sub for WebSocket sessions on other pods)
 * Tier 3: Persistent delivery (store in PendingDeliveryStore + message history)
 */

import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type { ChannelBinding } from '@agent-platform/execution';
import type { ResponseMessageMetadata } from '../channel/response-provenance.js';
import {
  buildPersistedMessageStructuredContent,
  type PersistedMessageLocalizationOwnershipV1,
  type PersistedMessageStructuredContent,
} from '../session/persisted-message-content.js';
import type { HandoffProgress } from '../../types/index.js';
import type { WebSocketConnectionRegistry } from '../../websocket/connection-registry.js';
import type { PendingDeliveryStore } from './pending-delivery-store.js';

const log = createLogger('channel-dispatcher');

export interface DispatchableResult {
  response: string;
  action?: { type: string; [key: string]: unknown };
  stateUpdates?: Record<string, unknown>;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
  localization?: PersistedMessageLocalizationOwnershipV1;
  responseMetadata?: ResponseMessageMetadata;
  /** Optional handoff progress to emit before the response */
  handoffProgress?: HandoffProgress;
}

function buildA2AResponseParts(result: DispatchableResult): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];

  if (result.response) {
    parts.push({ kind: 'text', text: result.response });
  }

  const structuredPayload: Record<string, unknown> = {};
  if (result.richContent && Object.keys(result.richContent).length > 0) {
    structuredPayload.richContent = result.richContent;
  }
  if (result.actions !== undefined) {
    structuredPayload.actions = result.actions;
  }
  if (result.voiceConfig !== undefined) {
    structuredPayload.voiceConfig = result.voiceConfig;
  }
  if (result.localization !== undefined) {
    structuredPayload.localization = result.localization;
  }

  if (Object.keys(structuredPayload).length > 0) {
    parts.push({ kind: 'data', data: structuredPayload });
  }

  return parts;
}

function buildStructuredResponseFields(result: DispatchableResult): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (result.richContent && Object.keys(result.richContent).length > 0) {
    fields.richContent = result.richContent;
  }
  if (result.actions !== undefined) {
    fields.actions = result.actions;
  }
  if (result.voiceConfig !== undefined) {
    fields.voiceConfig = result.voiceConfig;
  }
  if (result.localization !== undefined) {
    fields.localization = result.localization;
  }
  return fields;
}

/**
 * Interface for push notification delivery (provided by A2A package).
 */
export interface PushNotificationSender {
  deliverTaskUpdate(
    config: { url: string; token?: string; authentication?: unknown },
    taskId: string,
    state: string,
    message?: unknown,
  ): Promise<void>;
}

/**
 * Interface for Redis Pub/Sub publishing.
 */
export interface PubSubPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * Interface for message persistence.
 */
export interface MessagePersister {
  persistMessage(
    dbSessionId: string,
    role: string,
    content: string,
    channelType: string,
    tenantId: string,
    projectId?: string,
    structuredContent?: PersistedMessageStructuredContent,
    metadata?: ResponseMessageMetadata,
  ): Promise<void>;
}

export interface ChannelDispatcherDeps {
  wsRegistry: WebSocketConnectionRegistry;
  pushNotificationSender?: PushNotificationSender;
  messagePersister?: MessagePersister;
  pendingDeliveryStore: PendingDeliveryStore;
  redisPubSub?: PubSubPublisher;
}

export class ChannelDispatcher {
  private readonly wsRegistry: WebSocketConnectionRegistry;
  private readonly pushNotificationSender?: PushNotificationSender;
  private readonly messagePersister?: MessagePersister;
  private readonly pendingDeliveryStore: PendingDeliveryStore;
  private readonly redisPubSub?: PubSubPublisher;

  constructor(deps: ChannelDispatcherDeps) {
    this.wsRegistry = deps.wsRegistry;
    this.pushNotificationSender = deps.pushNotificationSender;
    this.messagePersister = deps.messagePersister;
    this.pendingDeliveryStore = deps.pendingDeliveryStore;
    this.redisPubSub = deps.redisPubSub;
  }

  async deliver(
    binding: ChannelBinding,
    sessionId: string,
    result: DispatchableResult,
  ): Promise<void> {
    let delivered = false;

    switch (binding.channelType) {
      case 'web_debug':
      case 'web_chat':
      case 'sdk_websocket': {
        delivered = await this.deliverViaWebSocket(binding, sessionId, result);
        break;
      }

      case 'a2a': {
        delivered = await this.deliverViaA2APush(binding, sessionId, result);
        break;
      }

      case 'slack':
      case 'whatsapp':
      case 'http_async':
      case 'msteams':
      case 'email': {
        // Async channels use the existing webhook-delivery BullMQ queue
        // which is already handled by the channel pipeline
        if (binding.connectionId) {
          delivered = true;
        }
        break;
      }
    }

    // Always persist to message history (even if live delivery succeeded)
    if (binding.dbSessionId && this.messagePersister) {
      try {
        await this.messagePersister.persistMessage(
          binding.dbSessionId,
          'assistant',
          result.response,
          binding.channelType,
          binding.tenantId,
          binding.projectId,
          buildPersistedMessageStructuredContent(result),
          result.responseMetadata,
        );
      } catch (err) {
        log.warn('Message persistence failed during resume delivery', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // If not delivered live, store for later pickup
    if (!delivered) {
      await this.pendingDeliveryStore.store(sessionId, binding, result);
      log.info('Result stored for pending delivery', {
        sessionId,
        channelType: binding.channelType,
      });
    }
  }

  private async deliverViaWebSocket(
    binding: ChannelBinding,
    sessionId: string,
    result: DispatchableResult,
  ): Promise<boolean> {
    // Tier 1: Try local WebSocket (this pod)
    const localWs = this.wsRegistry.getConnectionForSession(binding.wsSessionId || sessionId);
    if (localWs && (localWs as any).readyState === 1 /* OPEN */) {
      try {
        this.sendStudioProtocol(localWs as any, sessionId, result);
        return true;
      } catch (err) {
        log.warn('Local WebSocket delivery failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Tier 2: Try cross-pod delivery via Redis Pub/Sub
    if (this.redisPubSub) {
      try {
        const structuredFields = buildStructuredResponseFields(result);
        await this.redisPubSub.publish(
          `ws:deliver:${sessionId}`,
          JSON.stringify({
            response: result.response,
            ...structuredFields,
            ...(result.responseMetadata ? { responseMetadata: result.responseMetadata } : {}),
            ...(result.handoffProgress ? { handoffProgress: result.handoffProgress } : {}),
          }),
        );
        // We don't know if anyone received it; pending delivery store is the backup
      } catch (err) {
        log.warn('Cross-pod WebSocket delivery failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return false;
  }

  /** Send result using Studio's response_start → response_chunk → response_end protocol. */
  private sendStudioProtocol(
    ws: { send(data: string): void },
    sessionId: string,
    result: DispatchableResult,
  ): void {
    // Emit handoff progress before the response if present
    if (result.handoffProgress) {
      ws.send(
        JSON.stringify({
          type: 'handoff_progress',
          sessionId,
          progress: result.handoffProgress,
        }),
      );
    }

    const msgId = `resume-${Date.now()}`;
    const structuredFields = buildStructuredResponseFields(result);
    ws.send(JSON.stringify({ type: 'response_start', sessionId, messageId: msgId }));
    ws.send(
      JSON.stringify({
        type: 'response_chunk',
        sessionId,
        messageId: msgId,
        chunk: result.response,
        ...structuredFields,
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'response_end',
        sessionId,
        messageId: msgId,
        fullText: result.response,
        ...structuredFields,
        ...(result.responseMetadata ? { metadata: result.responseMetadata } : {}),
      }),
    );
  }

  private async deliverViaA2APush(
    binding: ChannelBinding,
    sessionId: string,
    result: DispatchableResult,
  ): Promise<boolean> {
    if (!binding.pushNotificationConfig || !this.pushNotificationSender) {
      return false;
    }

    try {
      const parts = buildA2AResponseParts(result);
      await this.pushNotificationSender.deliverTaskUpdate(
        binding.pushNotificationConfig,
        sessionId,
        'completed',
        {
          kind: 'message',
          messageId: `resp-${sessionId}-${Date.now()}`,
          role: 'agent',
          parts,
        },
      );
      return true;
    } catch (err) {
      log.warn('A2A push notification delivery failed', {
        sessionId,
        url: binding.pushNotificationConfig.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
