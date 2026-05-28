import type { ChannelType, WebhookEventType } from './types.js';
import { CHANNEL_MANIFEST } from './manifest.js';

export type CustomerContinuityKind =
  | 'pre_action_bridge'
  | 'long_running_status'
  | 'handoff_transition';

export type CustomerContinuityDeliveryMode =
  | 'status_event'
  | 'stream_text'
  | 'typing_indicator'
  | 'final_response_only';

export interface CustomerContinuityDeliveryContract {
  mode: CustomerContinuityDeliveryMode;
  eventType?: WebhookEventType;
}

export interface CustomerContinuityStatusPayloadParams {
  channelType: ChannelType;
  kind: CustomerContinuityKind;
  rawText: string;
  messageId: string;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  source?: 'agent_authored' | 'runtime_topology';
}

const CONTINUITY_STATUS_MAX_LENGTH = 240;
const GENERIC_BRIDGE_TEXT = 'Let me check that for you.';

const INTERNAL_LANGUAGE_PATTERN =
  /\b(api|debug|delegate|endpoint|function|handoff|http|internal|json|llm|model|prompt|request|runtime|schema|system|tool|trace|variable|workflow)\b|(?:api|http|json|raw)\s+response/i;
const COMPLETE_PHRASE_PATTERN = /(?:[.!?…]|\.{3})$/;
const TRAILING_ELLIPSIS_PATTERN = /\s*(?:\.{3}|…)$/;
const LEADING_FRAGMENT_REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/^still checking\b/i, "I'm still checking"],
  [/^searching\b/i, "I'm searching"],
  [/^looking\b/i, "I'm looking"],
  [/^pulling\b/i, "I'm pulling"],
  [/^checking\b/i, "I'm checking"],
  [/^working\b/i, "I'm working"],
  [/^putting\b/i, "I'm putting"],
  [/^calculating\b/i, "I'm calculating"],
  [/^running\b/i, "I'm running"],
  [/^processing\b/i, "I'm processing"],
  [/^transferring\b/i, "I'm transferring"],
];

export function resolveCustomerContinuityDelivery(
  channelType: ChannelType,
): CustomerContinuityDeliveryContract {
  if (channelType === 'http_async') {
    return { mode: 'status_event', eventType: 'agent.status' };
  }

  const manifest = CHANNEL_MANIFEST[channelType];
  if (manifest?.supportsStreaming) {
    return { mode: 'stream_text' };
  }

  if (manifest?.supportsTypingIndicator) {
    return { mode: 'typing_indicator' };
  }

  return { mode: 'final_response_only' };
}

export function normalizeCustomerContinuityText(rawText: string): string {
  const compact = rawText.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length < 12 || INTERNAL_LANGUAGE_PATTERN.test(compact)) {
    return GENERIC_BRIDGE_TEXT;
  }

  if (compact.length <= CONTINUITY_STATUS_MAX_LENGTH) {
    return completeCustomerContinuityPhrase(compact);
  }

  return `${compact.slice(0, CONTINUITY_STATUS_MAX_LENGTH - 3)}...`;
}

export function completeCustomerContinuityPhrase(rawText: string): string {
  const compact = rawText.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return compact;
  }

  let candidate = compact.replace(TRAILING_ELLIPSIS_PATTERN, '.');
  if (/^on it\.?$/i.test(candidate)) {
    return "I'm on it.";
  }

  for (const [pattern, replacement] of LEADING_FRAGMENT_REWRITES) {
    if (pattern.test(candidate)) {
      candidate = candidate.replace(pattern, replacement);
      break;
    }
  }

  return COMPLETE_PHRASE_PATTERN.test(candidate) ? candidate : `${candidate}.`;
}

export function buildCustomerContinuityStatusPayload(
  params: CustomerContinuityStatusPayloadParams,
): Record<string, unknown> | null {
  const delivery = resolveCustomerContinuityDelivery(params.channelType);
  if (delivery.mode !== 'status_event' || !delivery.eventType) {
    return null;
  }

  const message = normalizeCustomerContinuityText(params.rawText);
  return {
    message_id: params.messageId,
    session_key: params.sessionKey,
    event: delivery.eventType,
    status: 'in_progress',
    message,
    response: message,
    trace_context: {
      session_id: params.sessionId,
      delivery: 'status_event',
    },
    session_id: params.sessionId,
    is_new_session: params.isNewSession,
    metadata: {
      status_kind: 'continuity',
      continuity_kind: params.kind,
      visibility: 'customer_visible',
      source: params.source ?? 'agent_authored',
    },
  };
}
