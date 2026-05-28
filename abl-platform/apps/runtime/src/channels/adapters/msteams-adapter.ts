/**
 * MS Teams Channel Adapter
 *
 * Handles Azure Bot Framework webhook activities and sends replies via REST API.
 *
 * - verifyRequest()  → JWT token validation against Microsoft's JWKS
 * - parseIncoming()  → Normalizes Bot Framework Activity → NormalizedIncomingMessage
 * - sendResponse()   → OAuth2 client credentials → POST reply to Bot Framework service URL
 *
 * Supports: message activities (DMs and channel @mentions)
 * Ignores: conversationUpdate, typing, and other non-message activity types
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, RichContentIR } from '@abl/compiler';
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
import { getBotFrameworkToken } from './msteams-auth.js';
import type { MSTeamsFileReference } from './msteams-file-downloader.js';
import { requireNormalizedActionEvent } from '../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  buildChannelDeliveryLogContext,
  getChannelDeliveryErrorName,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('msteams-adapter');

function parseJsonPayload(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractAdaptiveCard(richContent?: RichContentIR): Record<string, unknown> | undefined {
  if (typeof richContent?.adaptive_card !== 'string' || richContent.adaptive_card.trim() === '') {
    return undefined;
  }

  const parsed = parseJsonPayload(richContent.adaptive_card);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function extractRichContentText(richContent?: RichContentIR): string {
  if (!richContent) {
    return '';
  }

  const candidates = [
    richContent.markdown,
    richContent.html,
    richContent.image?.caption,
    richContent.video?.caption,
    richContent.audio?.caption,
    richContent.file?.filename,
    richContent.kpi?.label,
    richContent.chart?.title,
    richContent.form?.title,
    richContent.feedback?.prompt,
  ];

  return (
    candidates
      .find((candidate): candidate is string => {
        return typeof candidate === 'string' && candidate.trim().length > 0;
      })
      ?.trim() ?? ''
  );
}

// =============================================================================
// BOT FRAMEWORK TYPES
// =============================================================================

interface BotFrameworkActivity {
  type: string;
  id: string;
  timestamp: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name: string; aadObjectId?: string };
  conversation: { id: string; conversationType?: string; tenantId?: string };
  recipient: { id: string; name: string };
  text?: string;
  textFormat?: string;
  locale?: string;
  channelData?: Record<string, unknown>;
  attachments?: BotFrameworkAttachment[];
  /** Present on invoke activities (Adaptive Card action submissions) */
  value?: { action?: { type?: string; data?: Record<string, unknown> } } & Record<string, unknown>;
}

interface BotFrameworkAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: Record<string, unknown>;
}

interface TeamsFileDownloadInfoContent {
  downloadUrl?: string;
  uniqueId?: string;
  fileType?: string;
  etag?: string;
}

// =============================================================================
// JWKS FOR TOKEN VERIFICATION
// =============================================================================

const JWKS = createRemoteJWKSet(new URL('https://login.botframework.com/v1/.well-known/keys'));

const TEAMS_FILE_INFO_CONTENT_TYPE = 'application/vnd.microsoft.teams.file.download.info';

function normalizeServiceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

function isPersonalConversation(activity: BotFrameworkActivity): boolean {
  return activity.conversation?.conversationType?.toLowerCase() === 'personal';
}

function mimeTypeFromFileType(fileType: string | undefined): string {
  switch ((fileType || '').toLowerCase()) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'txt':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function extractTeamsFileReferences(activity: BotFrameworkActivity): MSTeamsFileReference[] {
  if (!isPersonalConversation(activity)) {
    if (activity.attachments && activity.attachments.length > 0) {
      log.debug('Skipping file extraction for non-personal conversation', {
        conversationType: activity.conversation?.conversationType,
        attachmentCount: activity.attachments.length,
      });
    }
    return [];
  }

  const attachments = activity.attachments ?? [];
  const refs: MSTeamsFileReference[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const contentType = attachment.contentType || 'application/octet-stream';

    if (contentType === TEAMS_FILE_INFO_CONTENT_TYPE) {
      const content = attachment.content as TeamsFileDownloadInfoContent | undefined;
      const downloadUrl = content?.downloadUrl;
      if (!downloadUrl) continue;

      refs.push({
        source: 'file_download_info',
        name: attachment.name || `teams-file-${index}`,
        mimeType: mimeTypeFromFileType(content?.fileType),
        downloadUrl,
        fileType: content?.fileType,
        uniqueId: content?.uniqueId,
      });
      continue;
    }

    if (contentType.startsWith('image/') && attachment.contentUrl) {
      refs.push({
        source: 'inline_image',
        name: attachment.name || `teams-image-${index}`,
        mimeType: contentType,
        downloadUrl: attachment.contentUrl,
        requiresBotToken: true,
      });
    }
  }

  return refs;
}

// =============================================================================
// ADAPTER
// =============================================================================

export class MSTeamsAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'msteams';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: true,
  };

  /**
   * Verify Microsoft Bot Framework JWT token.
   *
   * Microsoft sends `Authorization: Bearer <JWT>` on every webhook request.
   * We validate the token against Microsoft's published JWKS signing keys.
   */
  async verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    _rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean> {
    const appId = (connection?.credentials?.app_id as string) || process.env.MSTEAMS_APP_ID;
    if (!appId) {
      log.error('MSTEAMS_APP_ID not configured');
      return false;
    }

    const authHeader = headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      log.warn('Missing Authorization Bearer token');
      return false;
    }

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: 'https://api.botframework.com',
        audience: appId,
      });

      const activity = body as BotFrameworkActivity;
      const serviceUrlFromActivity = activity?.serviceUrl;
      const claimValue =
        (payload['serviceurl'] as string | string[] | undefined) ||
        (payload['serviceUrl'] as string | string[] | undefined);

      if (serviceUrlFromActivity && claimValue) {
        const actual = normalizeServiceUrl(serviceUrlFromActivity);
        const expectedValues = (Array.isArray(claimValue) ? claimValue : [claimValue])
          .map((v) => normalizeServiceUrl(v))
          .filter((v): v is string => !!v);

        if (actual && expectedValues.length > 0 && !expectedValues.includes(actual)) {
          log.warn('JWT service URL claim mismatch', {
            actualServiceUrl: actual,
            tokenServiceUrls: expectedValues,
          });
          return false;
        }
      }

      return !!payload;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      log.warn('JWT verification failed', { error: errMsg });
      return false;
    }
  }

  /**
   * Extract the bot's App ID (recipient.id) for connection resolution.
   * This matches against ChannelConnection.externalIdentifier.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const activity = body as BotFrameworkActivity;
    const rawId = activity.recipient?.id || null;
    // Bot Framework prefixes the App ID with "28:" — strip it for DB lookup
    if (rawId && rawId.startsWith('28:')) return rawId.slice(3);
    return rawId;
  }

  /**
   * Extract activity ID for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const activity = body as BotFrameworkActivity;
    return activity.id || null;
  }

  /**
   * Check if this activity should be processed.
   * Handles message activities and invoke (Adaptive Card) activities.
   */
  shouldProcess(body: unknown): boolean {
    const activity = body as BotFrameworkActivity;

    // Adaptive Card action invoke
    if (activity.type === 'invoke' && activity.value?.action?.type === 'Action.Execute') {
      return true;
    }

    if (activity.type !== 'message') return false;

    const hasText = !!activity.text?.trim();
    if (hasText) return true;

    const fileRefs = extractTeamsFileReferences(activity);
    return fileRefs.length > 0;
  }

  /**
   * Build a NormalizedIncomingMessage from a raw Bot Framework Activity.
   * Handles message and invoke (Adaptive Card action) activities.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const activity = body as BotFrameworkActivity;
    const interactionContext =
      typeof activity.locale === 'string' && activity.locale.trim().length > 0
        ? {
            locale: activity.locale,
            language: activity.locale.split('-')[0],
          }
        : undefined;

    const baseMeta = {
      serviceUrl: activity.serviceUrl,
      conversationId: activity.conversation.id,
      activityId: activity.id,
      fromId: activity.from.id,
      fromName: activity.from.name,
      recipientId: activity.recipient.id,
      recipientName: activity.recipient.name,
      conversationType: activity.conversation.conversationType,
      tenantId: activity.conversation.tenantId,
    };

    // Handle invoke (Adaptive Card Action.Execute)
    if (activity.type === 'invoke' && activity.value?.action?.data) {
      const data = activity.value.action.data;
      const actionId = (data._actionId as string) || 'card_action';
      const value = (data._value as string) || '';
      const renderId = typeof data._renderId === 'string' ? data._renderId : undefined;
      // Remove internal fields from formData
      const formData = { ...data };
      delete formData._actionId;
      delete formData._value;
      delete formData._renderId;
      const actionEvent = requireNormalizedActionEvent({
        actionId,
        value,
        ...(renderId ? { renderId } : {}),
        formData,
        formDataPresent: Object.keys(formData).length > 0,
        source: 'teams',
      });

      return {
        externalMessageId: activity.id,
        externalSessionKey: `teams:${activity.conversation.id}`,
        text: '',
        actionEvent,
        metadata: { ...baseMeta, activityType: 'invoke' },
        ...(interactionContext ? { interactionContext } : {}),
        timestamp: new Date(activity.timestamp),
      };
    }

    // Standard message
    const teamsFileReferences = extractTeamsFileReferences(activity);
    let text = activity.text || '';
    text = text.replace(/<at>[^<]*<\/at>\s*/g, '').trim();

    return {
      externalMessageId: activity.id,
      externalSessionKey: `teams:${activity.conversation.id}`,
      text,
      ...(interactionContext ? { interactionContext } : {}),
      metadata: {
        ...baseMeta,
        ...(teamsFileReferences.length > 0 ? { teamsFileReferences } : {}),
      },
      timestamp: new Date(activity.timestamp),
    };
  }

  /**
   * Parse an inbound job payload into a normalized message.
   * The payload.message is already set by the webhook route using buildNormalizedMessage().
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Send a reply back to Teams via Bot Framework REST API.
   *
   * 1. Acquire OAuth2 token via client credentials grant
   * 2. POST reply activity to the conversation's service URL
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const appId = (connection.credentials?.app_id as string) || process.env.MSTEAMS_APP_ID;
    const clientSecret =
      (connection.credentials?.client_secret as string) || process.env.MSTEAMS_CLIENT_SECRET;
    const tenantId = (connection.credentials?.tenant_id as string) || process.env.MSTEAMS_TENANT_ID;

    if (!appId || !clientSecret || !tenantId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'msteams',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage:
          'No Microsoft Teams app ID, client secret, or tenant ID was available for outbound delivery.',
        retryable: false,
      });
    }

    const serviceUrl = readNonEmptyDeliveryMetadataString(message.metadata?.serviceUrl);
    const conversationId = readNonEmptyDeliveryMetadataString(message.metadata?.conversationId);
    const activityId = readNonEmptyDeliveryMetadataString(message.metadata?.activityId);

    if (!serviceUrl || !conversationId || !activityId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'msteams',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage:
          'Microsoft Teams delivery metadata was missing serviceUrl, conversationId, or activityId.',
        retryable: false,
      });
    }

    try {
      const token = await getBotFrameworkToken(appId, clientSecret, tenantId);

      // Ensure serviceUrl ends with /
      const baseUrl = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
      const replyUrl = `${baseUrl}v3/conversations/${conversationId}/activities/${activityId}`;

      // Build activity — include Adaptive Card if present
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;
      const activity: Record<string, unknown> = {
        type: 'message',
        text: channelOutput?.kind === 'adaptive_card' ? channelOutput.text : message.text,
      };
      if (channelOutput?.kind === 'adaptive_card') {
        activity.attachments = [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: channelOutput.card,
          },
        ];
      }

      const resp = await fetch(replyUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(activity),
      });

      if (!resp.ok) {
        log.error(
          'Bot Framework reply failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'msteams',
            httpStatus: resp.status,
          }),
        );
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'msteams',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Microsoft Bot Framework rejected the outbound response.',
          httpStatus: resp.status,
          retryable: false,
        });
      }

      const result = (await resp.json()) as { id?: string };
      log.info('Teams message sent', { conversationId, activityId: result.id });
      return { success: true, deliveryId: result.id };
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'AbortError'
          ? 'CHANNEL_DELIVERY_TIMEOUT'
          : 'CHANNEL_DELIVERY_FAILED';
      log.error(
        'Failed to send Teams message',
        buildChannelDeliveryLogContext({
          channelType: this.channelType,
          provider: 'msteams',
          code,
          errorName: getChannelDeliveryErrorName(error),
        }),
      );
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'msteams',
        category: 'network',
        code,
        operatorMessage:
          'Microsoft Bot Framework delivery failed before a provider response was available.',
        retryable: true,
      });
    }
  }

  /**
   * Send a typing indicator activity to MS Teams via Bot Framework REST API.
   * Best-effort: silently returns on missing credentials; logs warnings on API failure.
   */
  async sendTypingIndicator(
    connection: ResolvedConnection,
    _externalSessionKey: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const appId = (connection.credentials?.app_id as string) || process.env.MSTEAMS_APP_ID;
      const clientSecret =
        (connection.credentials?.client_secret as string) || process.env.MSTEAMS_CLIENT_SECRET;
      const tenantId =
        (connection.credentials?.tenant_id as string) || process.env.MSTEAMS_TENANT_ID;
      if (!appId || !clientSecret || !tenantId) return;

      const serviceUrl = readNonEmptyDeliveryMetadataString(metadata?.serviceUrl);
      const conversationId = readNonEmptyDeliveryMetadataString(metadata?.conversationId);
      if (!serviceUrl || !conversationId) return;

      const token = await getBotFrameworkToken(appId, clientSecret, tenantId);
      const baseUrl = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
      const url = `${baseUrl}v3/conversations/${conversationId}/activities`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'typing' }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        log.warn(
          'Teams typing indicator failed',
          buildChannelDeliveryLogContext({
            channelType: this.channelType,
            provider: 'msteams',
            httpStatus: resp.status,
          }),
        );
      }
    } catch (err) {
      log.warn('Teams typing indicator failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Transform ActionSetIR into Adaptive Card 1.4 format.
   * Buttons → Action.Execute, Select → Input.ChoiceSet, Input → Input.Text.
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    const nativeCard = extractAdaptiveCard(richContent);
    const richContentText = extractRichContentText(richContent);
    const outputText = text || richContentText;
    const actionSet = actions && actions.elements.length > 0 ? actions : undefined;
    const hasActions = Boolean(actionSet);
    const hasRichContent = Boolean(nativeCard || richContentText);

    if (!hasActions && !hasRichContent) {
      return { kind: 'text', text };
    }

    if ((!actions || actions.elements.length === 0) && nativeCard) {
      return { kind: 'adaptive_card', card: nativeCard, text: outputText };
    }

    if (!hasActions && !outputText) {
      return { kind: 'text', text };
    }

    const body: unknown[] = [];
    const cardActions: unknown[] = [];

    // Text block
    if (outputText) {
      body.push({
        type: 'TextBlock',
        text: outputText,
        wrap: true,
      });
    }

    if (!hasActions) {
      const card = {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body,
      };

      return { kind: 'adaptive_card', card, text: outputText };
    }

    for (const el of actionSet?.elements ?? []) {
      switch (el.type) {
        case 'button':
          cardActions.push({
            type: 'Action.Execute',
            title: el.label,
            data: {
              _actionId: el.id,
              _value: el.value || el.id,
              ...(actionSet?.renderId ? { _renderId: actionSet.renderId } : {}),
            },
          });
          break;

        case 'select':
          body.push({
            type: 'Input.ChoiceSet',
            id: el.id,
            label: el.label,
            choices: (el.options || []).map((opt) => ({
              title: opt.label,
              value: opt.id,
            })),
            placeholder: el.placeholder || el.label,
          });
          break;

        case 'input':
          body.push({
            type: 'Input.Text',
            id: el.id,
            label: el.label,
            placeholder: el.placeholder || '',
            isRequired: el.required || false,
          });
          break;
      }
    }

    // Submit action
    if (actionSet?.submit_label && actionSet.submit_id) {
      cardActions.push({
        type: 'Action.Execute',
        title: actionSet.submit_label,
        data: {
          _actionId: actionSet.submit_id,
          _value: 'submit',
          ...(actionSet.renderId ? { _renderId: actionSet.renderId } : {}),
        },
      });
    }

    const card = {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body,
      actions: cardActions.length > 0 ? cardActions : undefined,
    };

    return { kind: 'adaptive_card', card, text: outputText };
  }
}
