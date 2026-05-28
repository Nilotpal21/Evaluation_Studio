import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionElementIR, ActionSetIR, RichContentIR } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelOutput,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';
import { resolveConnectionProviderApiBase } from './provider-api-base.js';
import type { LineMediaReferenceMetadata } from './line-media-processor.js';
import { requireNormalizedActionEvent } from '../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('line-adapter');

const LINE_API_BASE = 'https://api.line.me';
const MAX_QUICK_REPLY_ITEMS = 13;
const MAX_LABEL_LENGTH = 20;
const MAX_POSTBACK_DATA_LENGTH = 300;
const DEFAULT_LOADING_SECONDS = 20;
const LINE_REPLY_TIMEOUT_MS = 5_000;
const LINE_PUSH_TIMEOUT_MS = 5_000;
const LINE_TYPING_TIMEOUT_MS = 5_000;

type LinePushTargetMetadata = {
  lineSourceType?: string;
  lineUserId?: string;
  lineGroupId?: string;
  lineRoomId?: string;
};

interface LineWebhookPayload {
  destination?: string;
  events?: LineWebhookEvent[];
}

type LineWebhookEvent = LineMessageEvent | LinePostbackEvent | LineUnsupportedEvent;

interface LineEventBase {
  type: string;
  mode?: string;
  timestamp: number;
  source: LineSource;
  replyToken?: string;
}

interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineTextMessage {
  id: string;
  type: 'text';
  text: string;
}

interface LineMediaMessage {
  id: string;
  type: 'image' | 'video' | 'audio';
  contentProvider?: { type: string };
}

interface LineFileMessage {
  id: string;
  type: 'file';
  fileName?: string;
  fileSize?: number;
}

interface LineLocationMessage {
  id: string;
  type: 'location';
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

interface LineStickerMessage {
  id: string;
  type: 'sticker';
  packageId?: string;
  stickerId?: string;
  stickerResourceType?: string;
  keywords?: string[];
}

interface LineMessageEvent extends LineEventBase {
  type: 'message';
  message:
    | LineTextMessage
    | LineMediaMessage
    | LineFileMessage
    | LineLocationMessage
    | LineStickerMessage;
}

interface LinePostbackEvent extends LineEventBase {
  type: 'postback';
  postback: {
    data: string;
    params?: Record<string, string>;
  };
}

interface LineUnsupportedEvent extends LineEventBase {
  type:
    | 'follow'
    | 'unfollow'
    | 'join'
    | 'leave'
    | 'memberJoined'
    | 'memberLeft'
    | 'videoPlayComplete'
    | 'beacon'
    | 'accountLink'
    | 'things';
}

type LineNormalizedBatchItem = {
  message: NormalizedIncomingMessage;
  eventId?: string | null;
};

function getSourceId(source: LineSource): string {
  if (source.type === 'user') return source.userId || 'unknown';
  if (source.type === 'group') return source.groupId || 'unknown';
  return source.roomId || 'unknown';
}

function buildSessionKey(destination: string, source: LineSource): string {
  return `line:${destination}:${source.type}:${getSourceId(source)}`;
}

function buildCommonMetadata(
  destination: string,
  event: LineWebhookEvent,
): Record<string, unknown> {
  return {
    lineDestination: destination,
    lineSourceType: event.source.type,
    ...(event.source.userId ? { lineUserId: event.source.userId } : {}),
    ...(event.source.groupId ? { lineGroupId: event.source.groupId } : {}),
    ...(event.source.roomId ? { lineRoomId: event.source.roomId } : {}),
    ...(event.replyToken ? { lineReplyToken: event.replyToken } : {}),
    lineEventType: event.type,
  };
}

function buildMediaReference(
  message: LineMediaMessage | LineFileMessage,
): LineMediaReferenceMetadata | null {
  switch (message.type) {
    case 'image':
      return { messageId: message.id, mediaType: 'image', mimeType: 'image/jpeg' };
    case 'video':
      return { messageId: message.id, mediaType: 'video', mimeType: 'video/mp4' };
    case 'audio':
      return { messageId: message.id, mediaType: 'audio', mimeType: 'audio/mp4' };
    case 'file':
      return {
        messageId: message.id,
        mediaType: 'file',
        mimeType: 'application/octet-stream',
        filename: message.fileName,
        sizeBytes: message.fileSize,
      };
    default:
      return null;
  }
}

function truncateLabel(label: string): string {
  return label.slice(0, MAX_LABEL_LENGTH);
}

function buildQuickReplyAction(actionId: string, label: string): { type: string; action: unknown } {
  const truncated = truncateLabel(label);
  return {
    type: 'action',
    action: {
      type: 'postback',
      label: truncated,
      data: actionId.slice(0, MAX_POSTBACK_DATA_LENGTH),
      displayText: truncated,
    },
  };
}

function isInvalidReplyTokenError(errorText: string): boolean {
  return /invalid reply token/i.test(errorText);
}

function getPushTarget(metadata?: Record<string, unknown>): string | null {
  const lineMetadata = (metadata || {}) as LinePushTargetMetadata;

  switch (lineMetadata.lineSourceType) {
    case 'group':
      return lineMetadata.lineGroupId || null;
    case 'room':
      return lineMetadata.lineRoomId || null;
    case 'user':
      return lineMetadata.lineUserId || null;
    default:
      return lineMetadata.lineUserId || lineMetadata.lineGroupId || lineMetadata.lineRoomId || null;
  }
}

export class LineAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'line';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: false,
    supportsMedia: true,
    supportsThreading: false,
  };

  async verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const channelSecret =
      (connection?.credentials?.channel_secret as string) || process.env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      log.error('LINE channel secret not configured');
      return false;
    }

    const signature = headers['x-line-signature'];
    if (!signature) {
      log.warn('Missing X-Line-Signature header');
      return false;
    }

    const bodyStr = rawBody
      ? typeof rawBody === 'string'
        ? rawBody
        : rawBody.toString('utf8')
      : JSON.stringify(body);

    const expectedSignature = crypto
      .createHmac('sha256', channelSecret)
      .update(bodyStr)
      .digest('base64');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as LineWebhookPayload;
    return payload.destination || null;
  }

  shouldProcess(body: unknown): boolean {
    const payload = body as LineWebhookPayload;
    const events = payload.events || [];
    if (events.length === 0) return false;

    return events.some((event) => {
      if (event.type === 'postback') return true;
      if (event.type !== 'message') return false;
      return ['text', 'image', 'video', 'audio', 'file', 'location', 'sticker'].includes(
        event.message.type,
      );
    });
  }

  buildNormalizedMessages(
    body: unknown,
    connection?: ResolvedConnection | null,
  ): LineNormalizedBatchItem[] {
    const payload = body as LineWebhookPayload;
    const destination = payload.destination || connection?.externalIdentifier || 'unknown';
    const normalizedMessages: LineNormalizedBatchItem[] = [];

    for (const event of payload.events || []) {
      const commonMetadata = buildCommonMetadata(destination, event);
      const externalSessionKey = buildSessionKey(destination, event.source);

      if (event.type === 'postback') {
        const eventId = `postback:${getSourceId(event.source)}:${event.timestamp}`;
        const actionEvent = requireNormalizedActionEvent({
          actionId: event.postback.data,
          value: event.postback.data,
          ...(event.postback.params ? { formData: event.postback.params } : {}),
          formDataPresent: event.postback.params !== undefined,
          source: 'line',
        });
        normalizedMessages.push({
          eventId,
          message: {
            externalMessageId: eventId,
            externalSessionKey,
            text: '',
            actionEvent,
            metadata: {
              ...commonMetadata,
              linePostbackData: event.postback.data,
              ...(event.postback.params ? { linePostbackParams: event.postback.params } : {}),
            },
            timestamp: new Date(event.timestamp),
          },
        });
        continue;
      }

      if (event.type !== 'message') {
        continue;
      }

      if (event.message.type === 'text') {
        normalizedMessages.push({
          eventId: event.message.id,
          message: {
            externalMessageId: event.message.id,
            externalSessionKey,
            text: event.message.text,
            metadata: {
              ...commonMetadata,
              lineMessageId: event.message.id,
            },
            timestamp: new Date(event.timestamp),
          },
        });
        continue;
      }

      if (['image', 'video', 'audio', 'file'].includes(event.message.type)) {
        const mediaRef = buildMediaReference(event.message as LineMediaMessage | LineFileMessage);
        normalizedMessages.push({
          eventId: event.message.id,
          message: {
            externalMessageId: event.message.id,
            externalSessionKey,
            text: '',
            metadata: {
              ...commonMetadata,
              lineMessageId: event.message.id,
              ...(mediaRef ? { lineMediaReferences: [mediaRef] } : {}),
            },
            timestamp: new Date(event.timestamp),
          },
        });
        continue;
      }

      if (event.message.type === 'location') {
        const locationMessage = event.message as LineLocationMessage;
        normalizedMessages.push({
          eventId: locationMessage.id,
          message: {
            externalMessageId: locationMessage.id,
            externalSessionKey,
            text: locationMessage.address || locationMessage.title || 'User shared a location.',
            metadata: {
              ...commonMetadata,
              lineMessageId: locationMessage.id,
              lineLocation: {
                title: locationMessage.title,
                address: locationMessage.address,
                latitude: locationMessage.latitude,
                longitude: locationMessage.longitude,
              },
            },
            timestamp: new Date(event.timestamp),
          },
        });
        continue;
      }

      if (event.message.type === 'sticker') {
        const stickerMessage = event.message as LineStickerMessage;
        normalizedMessages.push({
          eventId: stickerMessage.id,
          message: {
            externalMessageId: stickerMessage.id,
            externalSessionKey,
            text: 'User sent a sticker.',
            metadata: {
              ...commonMetadata,
              lineMessageId: stickerMessage.id,
              lineSticker: {
                packageId: stickerMessage.packageId,
                stickerId: stickerMessage.stickerId,
                stickerResourceType: stickerMessage.stickerResourceType,
                keywords: stickerMessage.keywords,
              },
            },
            timestamp: new Date(event.timestamp),
          },
        });
      }
    }

    return normalizedMessages;
  }

  buildNormalizedMessage(
    body: unknown,
    connection?: ResolvedConnection | null,
  ): NormalizedIncomingMessage {
    const first = this.buildNormalizedMessages(body, connection)[0];
    if (!first) {
      throw new Error('Invalid LINE payload: missing supported event');
    }
    return first.message;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const accessToken =
      (connection.credentials?.channel_access_token as string) ||
      process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'line',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No LINE channel access token was available for outbound delivery.',
        retryable: false,
      });
    }

    const replyToken = message.metadata?.lineReplyToken as string | undefined;

    const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;
    const text =
      (channelOutput?.kind === 'line_quick_reply' ? channelOutput.text : message.text) || '...';

    const lineMessage: Record<string, unknown> = {
      type: 'text',
      text,
    };
    const lineApiBase = resolveConnectionProviderApiBase(
      connection,
      'LINE_API_BASE_URL',
      LINE_API_BASE,
      'lineApiBaseUrl',
    );

    if (channelOutput?.kind === 'line_quick_reply') {
      lineMessage.quickReply = channelOutput.quickReply;
    }

    const pushFallback = async (): Promise<SendResult> => {
      const pushTarget = getPushTarget(message.metadata);
      if (!pushTarget) {
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'line',
          category: 'metadata',
          code: 'CHANNEL_DELIVERY_METADATA',
          operatorMessage: 'No LINE reply token or push target was present in message metadata.',
          retryable: false,
        });
      }

      try {
        const response = await fetch(`${lineApiBase}/v2/bot/message/push`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: pushTarget,
            messages: [lineMessage],
          }),
          signal: AbortSignal.timeout(LINE_PUSH_TIMEOUT_MS),
        });

        if (!response.ok) {
          log.error(
            'LINE push API error',
            buildChannelDeliveryLogContext({
              channelType: this.channelType,
              provider: 'line',
              httpStatus: response.status,
            }),
          );
          return buildChannelDeliveryFailure({
            channelType: this.channelType,
            provider: 'line',
            category: 'provider',
            code: 'CHANNEL_PROVIDER_REJECTED',
            operatorMessage: 'LINE push API rejected the outbound response.',
            httpStatus: response.status,
            retryable: false,
          });
        }

        return { success: true };
      } catch (error) {
        const code =
          error instanceof Error && error.name === 'AbortError'
            ? 'CHANNEL_DELIVERY_TIMEOUT'
            : 'CHANNEL_DELIVERY_FAILED';
        log.error(
          'Failed to send LINE push fallback',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'line',
            code,
            errorName: getChannelDeliveryErrorName(error),
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'line',
          category: 'network',
          code,
          operatorMessage: 'LINE push API failed before a provider response was available.',
          retryable: true,
        });
      }
    };

    try {
      if (!replyToken) {
        return await pushFallback();
      }

      const response = await fetch(`${lineApiBase}/v2/bot/message/reply`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replyToken,
          messages: [lineMessage],
        }),
        signal: AbortSignal.timeout(LINE_REPLY_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (isInvalidReplyTokenError(errorText)) {
          log.warn('LINE reply token invalid, attempting push fallback');
          return await pushFallback();
        }
        log.error(
          'LINE reply API error',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'line',
            httpStatus: response.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'line',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'LINE reply API rejected the outbound response.',
          httpStatus: response.status,
          retryable: false,
        });
      }

      return { success: true };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send LINE reply',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'line',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'line',
        category: 'network',
        code,
        operatorMessage: 'LINE reply API failed before a provider response was available.',
        retryable: true,
      });
    }
  }

  async sendTypingIndicator(
    connection: ResolvedConnection,
    _externalSessionKey: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const accessToken =
        (connection.credentials?.channel_access_token as string) ||
        process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (!accessToken) return;

      const userId = metadata?.lineUserId as string | undefined;
      const sourceType = metadata?.lineSourceType as string | undefined;
      if (sourceType && sourceType !== 'user') return;
      if (!userId) return;
      const lineApiBase = resolveConnectionProviderApiBase(
        connection,
        'LINE_API_BASE_URL',
        LINE_API_BASE,
        'lineApiBaseUrl',
      );

      const response = await fetch(`${lineApiBase}/v2/bot/chat/loading/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatId: userId,
          loadingSeconds: DEFAULT_LOADING_SECONDS,
        }),
        signal: AbortSignal.timeout(LINE_TYPING_TIMEOUT_MS),
      });

      if (!response.ok) {
        log.warn(
          'LINE loading indicator failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'line',
            httpStatus: response.status,
          }),
        );
      }
    } catch (error) {
      log.warn('LINE loading indicator failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  transformOutput(
    text: string,
    actions?: ActionSetIR,
    _richContent?: RichContentIR,
  ): ChannelOutput {
    if (!actions || actions.elements.length === 0) {
      return { kind: 'text', text };
    }

    const items: unknown[] = [];
    const buttons = actions.elements.filter(
      (element: ActionElementIR) => element.type === 'button',
    );
    const selects = actions.elements.filter(
      (element: ActionElementIR) => element.type === 'select',
    );

    for (const button of buttons) {
      if (items.length >= MAX_QUICK_REPLY_ITEMS) break;
      items.push(buildQuickReplyAction(button.id, button.label));
    }

    for (const select of selects) {
      for (const option of select.options || []) {
        if (items.length >= MAX_QUICK_REPLY_ITEMS) break;
        items.push(buildQuickReplyAction(option.id, option.label));
      }
    }

    if (items.length === 0) {
      return { kind: 'text', text };
    }

    return {
      kind: 'line_quick_reply',
      text,
      quickReply: { items },
    };
  }
}
