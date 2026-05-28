/**
 * Slack Channel Adapter
 *
 * Handles Slack Events API webhooks and sends responses via chat.postMessage.
 *
 * - verifyRequest()  → HMAC-SHA256 signature verification (signing secret)
 * - parseIncoming()  → Normalizes Slack event payload → NormalizedIncomingMessage
 * - sendResponse()   → POST to https://slack.com/api/chat.postMessage with bot token
 *
 * Supports: message.im (DMs), app_mention (channel @mentions)
 * Ignores: bot messages, message_changed, message_deleted subtypes
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import type { ActionSetIR, ActionElementIR, RichContentIR } from '@abl/compiler';
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
import { requireNormalizedActionEvent } from '../../services/channels/action-event-validation.js';
import {
  buildChannelDeliveryFailure,
  readNonEmptyDeliveryMetadataString,
} from '../../services/channel/delivery-diagnostics.js';

const log = createLogger('slack-adapter');
const SLACK_API_BASE = 'https://slack.com/api';
const SLACK_SECTION_TEXT_LIMIT = 3000;

function parseJsonPayload(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractSlackBlocks(richContent?: RichContentIR): unknown[] {
  if (!richContent) {
    return [];
  }

  if (typeof richContent.slack === 'string' && richContent.slack.trim().length > 0) {
    const parsed = parseJsonPayload(richContent.slack);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { blocks?: unknown[] }).blocks)
    ) {
      return (parsed as { blocks: unknown[] }).blocks;
    }
  }

  const blocks: unknown[] = [];
  const richText = richContent.markdown ?? richContent.html;
  if (typeof richText === 'string' && richText.trim().length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: richText.trim().slice(0, SLACK_SECTION_TEXT_LIMIT) },
    });
  }

  if (richContent.image?.url) {
    blocks.push({
      type: 'image',
      image_url: richContent.image.url,
      alt_text: richContent.image.alt ?? richContent.image.caption ?? 'Image',
    });
  }

  return blocks;
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
// SLACK EVENT TYPES
// =============================================================================

interface SlackEventCallback {
  type: 'event_callback';
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackMessageEvent;
  event_id: string;
  event_time: number;
}

interface SlackUrlVerification {
  type: 'url_verification';
  challenge: string;
  token: string;
}

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download: string;
  file_access: string;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  event_ts: string;
  channel_type?: string;
  bot_id?: string;
  files?: SlackFile[];
  upload?: boolean;
}

/** Slack block_actions interaction payload */
interface SlackBlockActionsPayload {
  type: 'block_actions';
  trigger_id: string;
  api_app_id?: string;
  user: { id: string; team_id: string; name: string };
  team: { id: string };
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string };
  state?: SlackInteractionState;
  actions: Array<{
    type: string;
    action_id: string;
    block_id: string;
    value?: string;
    selected_option?: { value: string; text: { text: string } };
    selected_options?: Array<{ value: string; text: { text: string } }>;
    selected_date?: string;
    selected_time?: string;
  }>;
}

interface SlackInteractionStateValue {
  value?: string;
  selected_option?: { value: string };
  selected_options?: Array<{ value: string }>;
  selected_date?: string;
  selected_time?: string;
}

interface SlackInteractionState {
  values: Record<string, Record<string, SlackInteractionStateValue>>;
}

/** Slack view_submission interaction payload */
interface SlackViewSubmissionPayload {
  type: 'view_submission';
  trigger_id: string;
  api_app_id?: string;
  user: { id: string; team_id: string; name: string };
  team: { id: string };
  view: {
    id: string;
    callback_id: string;
    private_metadata?: string;
    state: SlackInteractionState;
  };
}

interface SlackSlashCommandPayload {
  command: string;
  text?: string;
  team_id: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  trigger_id: string;
  response_url?: string;
  api_app_id?: string;
}

export type SlackWebhookPayload =
  | SlackEventCallback
  | SlackUrlVerification
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload
  | SlackSlashCommandPayload;

function isSlackSlashCommandPayload(
  payload: SlackWebhookPayload,
): payload is SlackSlashCommandPayload {
  return 'command' in payload && 'team_id' in payload;
}

function hasSlackType(
  payload: SlackWebhookPayload,
): payload is
  | SlackEventCallback
  | SlackUrlVerification
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload {
  return 'type' in payload;
}

function buildSlackChannelSessionKey(teamId: string, channelId: string): string {
  return `slack:${teamId}:${channelId}`;
}

function buildSlackThreadSessionKey(
  teamId: string,
  channelId: string,
  threadTs?: string,
): string | undefined {
  if (!threadTs) {
    return undefined;
  }

  return `${buildSlackChannelSessionKey(teamId, channelId)}:${threadTs}`;
}

function uniqueSessionLookupKeys(...keys: Array<string | undefined>): string[] {
  return [...new Set(keys.filter((value): value is string => !!value && value.trim().length > 0))];
}

const ACTION_RENDER_BLOCK_PREFIX = 'action-render:';

function buildSlackActionRenderBlockId(renderId: string | undefined): string | undefined {
  return renderId ? `${ACTION_RENDER_BLOCK_PREFIX}${renderId}` : undefined;
}

function parseSlackActionRenderBlockId(blockId: string | undefined): string | undefined {
  if (!blockId?.startsWith(ACTION_RENDER_BLOCK_PREFIX)) {
    return undefined;
  }

  const renderId = blockId.slice(ACTION_RENDER_BLOCK_PREFIX.length);
  return renderId.length > 0 ? renderId : undefined;
}

function extractSlackInteractionValue(value: SlackInteractionStateValue): unknown {
  if (value.selected_options) {
    return value.selected_options.map((option) => option.value);
  }
  return (
    value.selected_option?.value ?? value.value ?? value.selected_date ?? value.selected_time ?? ''
  );
}

function extractSlackFormData(state?: SlackInteractionState): Record<string, unknown> | undefined {
  if (!state?.values) {
    return undefined;
  }

  const formData: Record<string, unknown> = {};
  for (const [blockId, blockValues] of Object.entries(state.values)) {
    for (const [actionId, actionValue] of Object.entries(blockValues)) {
      formData[actionId || blockId] = extractSlackInteractionValue(actionValue);
    }
  }

  return Object.keys(formData).length > 0 ? formData : undefined;
}

function parseSlackPrivateMetadata(raw: string | undefined): {
  sessionKey?: string;
  channelId?: string;
  threadTs?: string;
} {
  if (!raw || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sessionKey: typeof parsed.sessionKey === 'string' ? parsed.sessionKey : undefined,
      channelId: typeof parsed.channelId === 'string' ? parsed.channelId : undefined,
      threadTs: typeof parsed.threadTs === 'string' ? parsed.threadTs : undefined,
    };
  } catch {
    return {
      sessionKey: raw,
    };
  }
}

// =============================================================================
// ADAPTER
// =============================================================================

export class SlackAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'slack';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: true,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: true,
  };

  /**
   * Verify Slack's HMAC-SHA256 request signature.
   *
   * Slack signs every webhook with:
   *   v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{rawBody}")
   *
   * We also reject requests with timestamps older than 5 minutes (replay protection).
   */
  async verifyRequest(
    headers: Record<string, string>,
    _body: unknown,
    rawBody?: Buffer | string,
    connection?: import('../types.js').ResolvedConnection | null,
  ): Promise<boolean> {
    const signingSecret =
      (connection?.credentials?.signing_secret as string) || process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      log.error(
        'Slack signing secret not configured (not in connection credentials or SLACK_SIGNING_SECRET env)',
      );
      return false;
    }

    const signature = headers['x-slack-signature'];
    const timestamp = headers['x-slack-request-timestamp'];

    if (!signature || !timestamp) {
      log.warn('Missing Slack signature headers');
      return false;
    }

    // Replay protection: reject timestamps > 5 minutes old
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
      log.warn('Slack request timestamp too old', { timestamp, now });
      return false;
    }

    // Compute expected signature
    const bodyStr = rawBody
      ? typeof rawBody === 'string'
        ? rawBody
        : rawBody.toString('utf8')
      : JSON.stringify(_body);

    const sigBasestring = `v0:${timestamp}:${bodyStr}`;
    const expectedSignature =
      'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  /**
   * Handle Slack's url_verification challenge.
   * Returns the challenge string if this is a verification request, null otherwise.
   */
  handleVerificationChallenge(body: unknown): string | null {
    const payload = body as SlackWebhookPayload;
    if (hasSlackType(payload) && payload.type === 'url_verification') {
      return (payload as SlackUrlVerification).challenge;
    }
    return null;
  }

  /**
   * Extract event_id for deduplication.
   */
  extractEventId(body: unknown): string | null {
    const payload = body as SlackWebhookPayload;
    if (hasSlackType(payload) && payload.type === 'event_callback') {
      return (payload as SlackEventCallback).event_id;
    }
    return null;
  }

  /**
   * Extract team_id:app_id (external identifier) for connection resolution.
   * Uses the composite format to support multiple Slack apps per workspace.
   */
  extractExternalIdentifier(body: unknown): string | null {
    const payload = body as SlackWebhookPayload;

    if (hasSlackType(payload) && payload.type === 'event_callback') {
      const evt = payload as SlackEventCallback;
      return evt.team_id && evt.api_app_id
        ? `${evt.team_id}:${evt.api_app_id}`
        : evt.team_id || null;
    }

    // Interactive payloads (block_actions, view_submission) use team.id
    if (
      hasSlackType(payload) &&
      (payload.type === 'block_actions' || payload.type === 'view_submission')
    ) {
      const interactive = payload as SlackBlockActionsPayload | SlackViewSubmissionPayload;
      const teamId = interactive.team?.id;
      const appId = interactive.api_app_id;
      return teamId && appId ? `${teamId}:${appId}` : teamId || null;
    }

    if (isSlackSlashCommandPayload(payload)) {
      const slash = payload;
      return slash.team_id && slash.api_app_id
        ? `${slash.team_id}:${slash.api_app_id}`
        : slash.team_id || null;
    }

    return null;
  }

  /**
   * Check if this event should be processed.
   * Handles message events, block_actions, and view_submission.
   */
  shouldProcess(body: unknown): boolean {
    const payload = body as SlackWebhookPayload;

    if (isSlackSlashCommandPayload(payload)) {
      return typeof payload.command === 'string' && payload.command.trim().length > 0;
    }

    // Interactive payloads: block_actions and view_submission
    if (
      hasSlackType(payload) &&
      (payload.type === 'block_actions' || payload.type === 'view_submission')
    ) {
      return true;
    }

    if (payload.type !== 'event_callback') return false;

    const event = (payload as SlackEventCallback).event;

    // Skip bot messages to avoid loops
    if (event.bot_id) return false;
    if (event.subtype === 'bot_message') return false;

    // Skip message subtypes we don't handle
    const ignoredSubtypes = [
      'message_changed',
      'message_deleted',
      'channel_join',
      'channel_leave',
      'channel_topic',
      'channel_purpose',
    ];
    if (event.subtype && ignoredSubtypes.includes(event.subtype)) return false;

    // Only process message and app_mention events
    if (event.type !== 'message' && event.type !== 'app_mention') return false;

    // Must have text content or file attachments
    const hasText = event.text && event.text.trim().length > 0;
    const hasFiles = Array.isArray(event.files) && event.files.length > 0;
    if (!hasText && !hasFiles) return false;

    return true;
  }

  /**
   * Parse an inbound job payload into a normalized message.
   * The payload.message is already set by the webhook route using buildNormalizedMessage().
   */
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  /**
   * Build a NormalizedIncomingMessage from a raw Slack event.
   * Handles message events, block_actions, and view_submission.
   */
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage {
    const payload = body as SlackWebhookPayload;

    if (isSlackSlashCommandPayload(payload)) {
      const slash = payload;
      const trimmedArgs = slash.text?.trim() || '';
      const text = trimmedArgs ? `${slash.command} ${trimmedArgs}` : slash.command;

      return {
        externalMessageId: `slash:${slash.trigger_id}:${slash.channel_id}:${slash.user_id}`,
        externalSessionKey: `slack:${slash.team_id}:${slash.channel_id}`,
        text,
        metadata: {
          isSlashCommand: true,
          slashCommand: slash.command,
          slashArgs: trimmedArgs,
          slackTeamId: slash.team_id,
          slackChannelId: slash.channel_id,
          slackChannelName: slash.channel_name,
          slackUserId: slash.user_id,
          slackUserName: slash.user_name,
          slackTriggerId: slash.trigger_id,
          responseUrl: slash.response_url,
          slackApiAppId: slash.api_app_id,
          slackEventType: 'slash_command',
        },
        timestamp: new Date(),
      };
    }

    // Handle block_actions interactions
    if (payload.type === 'block_actions') {
      const ba = payload as SlackBlockActionsPayload;
      const action = ba.actions[0];
      const actionId = action?.action_id || 'unknown';
      const channelId = ba.channel?.id || 'dm';
      const channelSessionKey = buildSlackChannelSessionKey(ba.team.id, channelId);
      const threadSessionKey =
        ba.channel?.id !== undefined
          ? buildSlackThreadSessionKey(ba.team.id, ba.channel.id, ba.message?.thread_ts)
          : undefined;
      const value =
        action?.selected_option?.value ??
        action?.value ??
        action?.selected_date ??
        action?.selected_time ??
        '';
      const renderId = parseSlackActionRenderBlockId(action?.block_id);
      const formData = extractSlackFormData(ba.state);
      const actionEvent = requireNormalizedActionEvent({
        actionId,
        value,
        ...(renderId ? { renderId } : {}),
        ...(formData ? { formData } : {}),
        formDataPresent: formData !== undefined,
        source: 'slack',
      });

      return {
        externalMessageId: `block_action:${ba.trigger_id}`,
        externalSessionKey: channelSessionKey,
        text: '',
        actionEvent,
        metadata: {
          slackTeamId: ba.team.id,
          slackChannelId: ba.channel?.id,
          slackUserId: ba.user.id,
          slackTs: ba.message?.ts,
          slackThreadTs: ba.message?.thread_ts,
          slackEventType: 'block_actions',
          sessionLookupKeys: uniqueSessionLookupKeys(threadSessionKey, channelSessionKey),
        },
        timestamp: new Date(),
      };
    }

    // Handle view_submission (modal form)
    if (payload.type === 'view_submission') {
      const vs = payload as SlackViewSubmissionPayload;
      const privateMetadata = parseSlackPrivateMetadata(vs.view.private_metadata);
      const formData = extractSlackFormData(vs.view.state) ?? {};
      const actionEvent = requireNormalizedActionEvent({
        actionId: vs.view.callback_id || 'form_submit',
        formData,
        formDataPresent: true,
        source: 'slack',
      });

      const privateMetadataSessionKey =
        privateMetadata.channelId && privateMetadata.threadTs
          ? buildSlackThreadSessionKey(
              vs.team.id,
              privateMetadata.channelId,
              privateMetadata.threadTs,
            )
          : privateMetadata.channelId
            ? buildSlackChannelSessionKey(vs.team.id, privateMetadata.channelId)
            : undefined;
      const userSessionKey = `slack:${vs.team.id}:${vs.user.id}`;
      const sessionKey = privateMetadata.sessionKey || privateMetadataSessionKey || userSessionKey;

      return {
        externalMessageId: `view_submit:${vs.trigger_id}`,
        externalSessionKey: sessionKey,
        text: '',
        actionEvent,
        metadata: {
          slackTeamId: vs.team.id,
          slackChannelId: privateMetadata.channelId,
          slackUserId: vs.user.id,
          slackEventType: 'view_submission',
          slackViewId: vs.view.id,
          slackThreadTs: privateMetadata.threadTs,
          sessionLookupKeys: uniqueSessionLookupKeys(
            privateMetadata.sessionKey,
            privateMetadataSessionKey,
            userSessionKey,
          ),
        },
        timestamp: new Date(),
      };
    }

    // Standard message event
    const evtPayload = payload as SlackEventCallback;
    const event = evtPayload.event;

    const sessionKey =
      buildSlackThreadSessionKey(evtPayload.team_id, event.channel, event.thread_ts) ||
      buildSlackChannelSessionKey(evtPayload.team_id, event.channel);

    let text = event.text;
    if (event.type === 'app_mention') {
      text = text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
    }

    const slackFileReferences = (event.files ?? [])
      .filter((f) => f.file_access === 'visible' && f.url_private_download)
      .map((f) => ({
        slackFileId: f.id,
        name: f.name,
        mimetype: f.mimetype,
        filetype: f.filetype,
        size: f.size,
        downloadUrl: f.url_private_download,
      }));

    return {
      externalMessageId: event.event_ts || event.ts,
      externalSessionKey: sessionKey,
      text,
      metadata: {
        slackTeamId: evtPayload.team_id,
        slackChannelId: event.channel,
        slackUserId: event.user,
        slackTs: event.ts,
        slackThreadTs: event.thread_ts,
        slackChannelType: event.channel_type,
        slackEventType: event.type,
        slackFileReferences,
        sessionLookupKeys: uniqueSessionLookupKeys(sessionKey),
      },
      timestamp: new Date(parseFloat(event.event_ts || event.ts) * 1000),
    };
  }

  /**
   * Transform ActionSetIR into Slack Block Kit format.
   * Slack limits: 5 elements per actions block, 3000 char per text block.
   */
  transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
    const richBlocks = extractSlackBlocks(richContent);
    const outputText = text || extractRichContentText(richContent);
    if ((!actions || actions.elements.length === 0) && richBlocks.length === 0) {
      return { kind: 'text', text };
    }

    const blocks: unknown[] = [...richBlocks];

    // Text section
    if (text) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: text.slice(0, SLACK_SECTION_TEXT_LIMIT) },
      });
    }

    if ((!actions || actions.elements.length === 0) && blocks.length > 0) {
      return { kind: 'slack_blocks', blocks, text: outputText };
    }

    const actionSet = actions;
    if (!actionSet) {
      return { kind: 'slack_blocks', blocks, text: outputText };
    }

    // Group elements by type for optimal Block Kit layout
    const buttons = actionSet.elements.filter((e) => e.type === 'button');
    const selects = actionSet.elements.filter((e) => e.type === 'select');
    const inputs = actionSet.elements.filter((e) => e.type === 'input');

    // Buttons → actions block (max 5 per block)
    for (let i = 0; i < buttons.length; i += 5) {
      const chunk = buttons.slice(i, i + 5);
      blocks.push({
        type: 'actions',
        ...(buildSlackActionRenderBlockId(actionSet.renderId)
          ? { block_id: buildSlackActionRenderBlockId(actionSet.renderId) }
          : {}),
        elements: chunk.map((btn) => ({
          type: 'button',
          text: { type: 'plain_text', text: btn.label.slice(0, 75) },
          action_id: btn.id,
          value: btn.value || btn.id,
        })),
      });
    }

    // Selects → actions block with static_select
    for (const sel of selects) {
      blocks.push({
        type: 'actions',
        ...(buildSlackActionRenderBlockId(actionSet.renderId)
          ? { block_id: buildSlackActionRenderBlockId(actionSet.renderId) }
          : {}),
        elements: [
          {
            type: 'static_select',
            placeholder: { type: 'plain_text', text: sel.label.slice(0, 150) },
            action_id: sel.id,
            options: (sel.options || []).slice(0, 100).map((opt) => ({
              text: { type: 'plain_text', text: opt.label.slice(0, 75) },
              value: opt.id,
            })),
          },
        ],
      });
    }

    // Inputs → input blocks (for modals; in messages, show as context)
    for (const inp of inputs) {
      blocks.push({
        type: 'input',
        block_id: `input_${inp.id}`,
        label: { type: 'plain_text', text: inp.label.slice(0, 2000) },
        element: {
          type: 'plain_text_input',
          action_id: inp.id,
          placeholder: inp.placeholder
            ? { type: 'plain_text', text: inp.placeholder.slice(0, 150) }
            : undefined,
        },
        optional: !inp.required,
      });
    }

    // Submit button if specified
    if (actionSet.submit_label && actionSet.submit_id) {
      blocks.push({
        type: 'actions',
        ...(buildSlackActionRenderBlockId(actionSet.renderId)
          ? { block_id: buildSlackActionRenderBlockId(actionSet.renderId) }
          : {}),
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: actionSet.submit_label.slice(0, 75) },
            action_id: actionSet.submit_id,
            style: 'primary',
          },
        ],
      });
    }

    return { kind: 'slack_blocks', blocks, text: outputText };
  }

  /**
   * Send a response back to Slack via chat.postMessage.
   */
  async sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult> {
    const botToken = (connection.credentials?.bot_token as string) || process.env.SLACK_BOT_TOKEN;

    if (!botToken) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'slack',
        category: 'configuration',
        code: 'CHANNEL_DELIVERY_CONFIGURATION',
        operatorMessage: 'No Slack bot token was available for outbound delivery.',
        retryable: false,
      });
    }

    // Extract Slack-specific info from metadata
    const channelId = readNonEmptyDeliveryMetadataString(message.metadata?.slackChannelId);
    // Fall back to slackTs so DM replies always go to the thread (matches stream buffer behavior)
    const threadTs = (message.metadata?.slackThreadTs || message.metadata?.slackTs) as
      | string
      | undefined;

    if (!channelId) {
      return buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'slack',
        category: 'metadata',
        code: 'CHANNEL_DELIVERY_METADATA',
        operatorMessage: 'No Slack channel ID was present in message metadata.',
        retryable: false,
      });
    }

    try {
      const slackApiBase = resolveConnectionProviderApiBase(
        connection,
        'SLACK_API_BASE_URL',
        SLACK_API_BASE,
        'slackApiBaseUrl',
      );

      // Build payload — include blocks if channelOutput is present in metadata
      const channelOutput = message.metadata?.channelOutput as ChannelOutput | undefined;
      const slackPayload: Record<string, unknown> = {
        channel: channelId,
        text: channelOutput?.kind === 'slack_blocks' ? channelOutput.text : message.text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      };
      if (channelOutput?.kind === 'slack_blocks') {
        slackPayload.blocks = channelOutput.blocks;
      }

      const response = await fetch(`${slackApiBase}/chat.postMessage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(slackPayload),
      });

      const result = (await response.json()) as { ok: boolean; ts?: string; error?: string };

      if (!result.ok) {
        log.error('Slack chat.postMessage failed', { error: result.error });
        return buildChannelDeliveryFailure({
          channelType: this.channelType,
          provider: 'slack',
          category: 'provider',
          code: 'CHANNEL_PROVIDER_REJECTED',
          operatorMessage: 'Slack chat.postMessage rejected the outbound response.',
          ...(result.error ? { providerErrorCode: result.error } : {}),
          retryable: false,
        });
      }

      log.info('Slack message sent', { channel: channelId, ts: result.ts });
      return { success: true, deliveryId: result.ts };
    } catch (error) {
      const failure = buildChannelDeliveryFailure({
        channelType: this.channelType,
        provider: 'slack',
        category: 'network',
        code:
          error instanceof Error && error.name === 'AbortError'
            ? 'CHANNEL_DELIVERY_TIMEOUT'
            : 'CHANNEL_DELIVERY_FAILED',
        operatorMessage: 'Slack chat.postMessage failed before a provider response was available.',
        retryable: true,
      });
      const diagnostic = failure.metadata?.channelDiagnostic as { message?: string } | undefined;
      log.error('Failed to send Slack message', {
        error: diagnostic?.message ?? failure.error,
      });
      return failure;
    }
  }
}
