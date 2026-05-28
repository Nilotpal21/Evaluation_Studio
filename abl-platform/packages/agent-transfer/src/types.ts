/**
 * Shared types for agent transfer.
 *
 * Central type definitions used across adapters, session store,
 * tools, and event handlers.
 */

export type TransferChannel = 'chat' | 'email' | 'voice' | 'messaging' | 'campaign';

export interface TransferContact {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  customerId?: string;
}

export interface TransferRoutingVoiceContext {
  callSid?: string;
  sipCallId?: string;
  gateway?: string;
}

export interface TransferRoutingContext {
  runtimeSessionId: string;
  conversationSessionId?: string;
  resolvedContactId?: string;
  normalizedTransferChannel: TransferChannel;
  sourceChannelType?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voice?: TransferRoutingVoiceContext;
}

export interface TransferIdentityHints {
  customerId?: string;
  anonymousId?: string;
  identityTier?: number;
  verificationMethod?: string;
  channelArtifactType?: string;
}

export interface TransferContextSnapshot {
  identityHints?: TransferIdentityHints;
  contact?: TransferContact;
  interactionContext?: {
    language?: string;
    locale?: string;
    timezone?: string;
  };
  sessionContext?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
}

const CHAT_TRANSFER_CHANNELS = new Set([
  'chat',
  'web_chat',
  'sdk_websocket',
  'web',
  'web_debug',
  'debug_websocket',
  'http',
  'api',
]);
const MESSAGING_TRANSFER_CHANNELS = new Set([
  'messaging',
  'http_async',
  'slack',
  'line',
  'msteams',
  'whatsapp',
  'messenger',
  'instagram',
  'twilio_sms',
  'sms',
  'zendesk',
  'telegram',
  'genesys',
]);
const EMAIL_TRANSFER_CHANNELS = new Set(['email']);
const VOICE_TRANSFER_CHANNELS = new Set([
  'voice',
  'voice_vxml',
  'korevg',
  'audiocodes',
  'jambonz',
  'voice_twilio',
  'voice_pipeline',
  'voice_realtime',
  'voice_livekit',
  'twilio',
  'ivr',
]);
const CAMPAIGN_TRANSFER_CHANNELS = new Set(['campaign']);

function trimOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function cloneRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value ? { ...value } : undefined;
}

export function normalizeTransferChannel(channel: string | undefined): TransferChannel {
  const normalized = trimOptionalString(channel)?.toLowerCase();
  if (!normalized) {
    return 'chat';
  }

  if (VOICE_TRANSFER_CHANNELS.has(normalized)) {
    return 'voice';
  }

  if (EMAIL_TRANSFER_CHANNELS.has(normalized)) {
    return 'email';
  }

  if (CAMPAIGN_TRANSFER_CHANNELS.has(normalized)) {
    return 'campaign';
  }

  if (MESSAGING_TRANSFER_CHANNELS.has(normalized)) {
    return 'messaging';
  }

  if (CHAT_TRANSFER_CHANNELS.has(normalized)) {
    return 'chat';
  }

  return 'chat';
}

export function resolveTransferOwnerId(input: {
  ownerId?: string;
  runtimeSessionId?: string;
  contactId?: string;
}): string {
  return (
    trimOptionalString(input.ownerId) ??
    trimOptionalString(input.runtimeSessionId) ??
    trimOptionalString(input.contactId) ??
    ''
  );
}

export function resolveTransferSessionOwnerId(input: {
  ownerId?: string;
  routing?: Pick<TransferRoutingContext, 'runtimeSessionId'> | undefined;
  contactId?: string;
}): string {
  return resolveTransferOwnerId({
    ownerId: input.ownerId,
    runtimeSessionId: input.routing?.runtimeSessionId,
    contactId: input.contactId,
  });
}

export function buildTransferRoutingContext(input: {
  runtimeSessionId: string;
  conversationSessionId?: string;
  resolvedContactId?: string;
  channel?: string;
  sourceChannelType?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voice?: TransferRoutingVoiceContext;
}): TransferRoutingContext {
  const sourceChannelType = trimOptionalString(input.sourceChannelType ?? input.channel);
  const routing: TransferRoutingContext = {
    runtimeSessionId: input.runtimeSessionId,
    normalizedTransferChannel: normalizeTransferChannel(sourceChannelType),
  };

  const conversationSessionId = trimOptionalString(input.conversationSessionId);
  if (conversationSessionId) {
    routing.conversationSessionId = conversationSessionId;
  }

  const resolvedContactId = trimOptionalString(input.resolvedContactId);
  if (resolvedContactId) {
    routing.resolvedContactId = resolvedContactId;
  }

  if (sourceChannelType) {
    routing.sourceChannelType = sourceChannelType;
  }

  const channelConnectionId = trimOptionalString(input.channelConnectionId);
  if (channelConnectionId) {
    routing.channelConnectionId = channelConnectionId;
  }

  const externalSessionKey = trimOptionalString(input.externalSessionKey);
  if (externalSessionKey) {
    routing.externalSessionKey = externalSessionKey;
  }

  if (input.voice) {
    const voice: TransferRoutingVoiceContext = {};
    const callSid = trimOptionalString(input.voice.callSid);
    const sipCallId = trimOptionalString(input.voice.sipCallId);
    const gateway = trimOptionalString(input.voice.gateway);

    if (callSid) {
      voice.callSid = callSid;
    }
    if (sipCallId) {
      voice.sipCallId = sipCallId;
    }
    if (gateway) {
      voice.gateway = gateway;
    }

    if (Object.keys(voice).length > 0) {
      routing.voice = voice;
    }
  }

  return routing;
}

export function buildTransferContextSnapshot(
  input: Partial<TransferContextSnapshot> | undefined,
): TransferContextSnapshot | undefined {
  if (!input) {
    return undefined;
  }

  const snapshot: TransferContextSnapshot = {};

  if (input.identityHints && Object.keys(input.identityHints).length > 0) {
    snapshot.identityHints = { ...input.identityHints };
  }

  if (input.contact && Object.keys(input.contact).length > 0) {
    snapshot.contact = { ...input.contact };
  }

  if (input.interactionContext && Object.keys(input.interactionContext).length > 0) {
    snapshot.interactionContext = { ...input.interactionContext };
  }

  const sessionContext = cloneRecord(input.sessionContext);
  if (sessionContext && Object.keys(sessionContext).length > 0) {
    snapshot.sessionContext = sessionContext;
  }

  const messageMetadata = cloneRecord(input.messageMetadata);
  if (messageMetadata && Object.keys(messageMetadata).length > 0) {
    snapshot.messageMetadata = messageMetadata;
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** Voice call data extracted from the active gateway session for transfer payloads. */
export interface VoiceCallData {
  callSid: string;
  caller: string;
  called: string;
  sipCallId?: string;
  sipFrom?: string;
  sipTo?: string;
  originatingSipIp?: string;
  direction?: string;
  callerName?: string;
}

export interface TransferPayload {
  tenantId: string;
  projectId: string;
  agentId: string;
  contactId: string;
  sessionId: string;
  channel: TransferChannel;
  routing?: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  queue?: string;
  skills?: string[];
  priority?: number;
  sourceAgentId?: string;
  parentAgentId?: string;
  conversationHistory?: ConversationMessage[];
  /** Pre-computed plain-text transcript for immediate display on the agent desktop.
   * Eliminates the race condition where an agent accepts before the async ML summary completes. */
  conversationSummaryForAgentTransfer?: string;
  contact?: TransferContact;
  metadata?: Record<string, unknown>;
  message?: string;
  postAgentAction?: 'return' | 'end' | 'csat';
  language?: string;
  customData?: Record<string, unknown>;
  voiceData?: VoiceCallData;
}

export interface ConversationMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
}

export type TransferStatus =
  | 'transferred'
  | 'queued'
  | 'waiting'
  | 'outside_hours'
  | 'no_agents'
  | 'queue_invalid'
  | 'declined'
  | 'failed';

export interface TransferResult {
  success: boolean;
  status: TransferStatus;
  sessionId?: string;
  providerSessionId?: string;
  estimatedWaitTime?: number;
  queuePosition?: number;
  /** Whether SmartAssist requested a CSAT survey at end of conversation */
  csatSurveyRequired?: boolean;
  /** SmartAssist survey type: 'csat' | 'nps' | 'likeDislike' */
  csatSurveyType?: string;
  error?: { code: string; message: string };
}

export interface UserMessage {
  content: string;
  type?: 'text' | 'attachment' | 'form_response';
  attachments?: MessageAttachment[];
  metadata?: Record<string, unknown>;
}

export interface MessageAttachment {
  url: string;
  name: string;
  mimeType: string;
  size?: number;
}

export type AgentEventType =
  | 'agent:message'
  | 'agent:connected'
  | 'agent:joined'
  | 'agent:exited' // TODO: wire XO mapping when SmartAssist exposes agent_exited event
  | 'agent:queued'
  | 'agent:disconnected'
  | 'agent:typing'
  | 'agent:typing_stop'
  | 'agent:delivery_receipt'
  | 'agent:form'
  | 'agent:assist_suggestion'
  | 'agent:call_status'
  | 'agent:waiting_message';

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  tenantId: string;
  contactId: string;
  channel: TransferChannel;
  timestamp: string;
  data: Record<string, unknown>;
}

export type AgentMessageHandler = (event: AgentEvent) => void | Promise<void>;
export type SessionEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface AuthCredentials {
  type: AuthType;
  token?: string;
  headers?: Record<string, string>;
  expiresAt?: number;
}

export type AuthType =
  | 'internal_key'
  | 'oauth2'
  | 'jwt'
  | 'basic'
  | 'bearer'
  | 'oidc'
  | 'session_header'
  | 'none';

export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Voice types
// ---------------------------------------------------------------------------

/** Payload sent to KoreVG to render TTS prompts, collect DTMF, or transfer. */
export interface VoiceMessagePayload {
  message: string;
  isPrompt: boolean;
  sendDTMF: boolean;
  dtmfCollect: boolean;
  timeout?: number;
  retries?: number;
  bargeIn?: boolean;
  enableSpeechInput?: boolean;
  isHangUp: boolean;
  isCallTransfer?: boolean;
  callTransferConfig?: {
    callTransferType: 'sip' | 'pstn';
    phoneNumber?: string;
    sipTransferId?: string;
  };
  language?: string;
  dtmfCollectSubmitDigit?: string;
  dtmfCollectInterDigitTimeoutMS?: number;
  dtmfCollectMaxDigits?: number;
  messages?: Array<{ type: string; value: string }>;
}

/** Status of a voice call transfer attempt from KoreVG. */
export interface VoiceTransferStatus {
  status: 'success' | 'failed' | 'declined';
  internalAgentTransfer?: boolean;
  error?: string;
}

/** OOB flags parsed from bot response metadata. */
export interface OOBFlags {
  isAgentTransfer?: boolean;
  agentTransfer?: boolean;
  isDeflection?: boolean;
  isDeflectionAutomation?: boolean;
  isDeflectionAgentTransfer?: boolean;
  isOfferChatOptions?: boolean;
  endDialog?: boolean;
  endReason?: string;
  detectedIntentName?: string;
  userInput?: string;
  dialog_tone?: string;
  dialogRefId?: string;
  dialogId?: string;
}

// ---------------------------------------------------------------------------
// VoiceToolResult — discriminated union for korevg-session verb translation
// ---------------------------------------------------------------------------

/**
 * Structured output from voice tools that `korevg-session` translates into
 * Jambonz verbs via `verb-builder`.
 *
 * Usage in korevg-session:
 * ```ts
 * switch (voiceResult.type) {
 *   case 'gather': verbs = verbBuilder.gather({ prompt: voiceResult.prompt, ... }); break;
 *   case 'transfer': // SIP REFER or PSTN dial sequence
 *   case 'deflect':  // Channel-switch metadata
 *   case 'hangup':   verbs = [{ verb: 'hangup' }]; break;
 * }
 * ```
 */
export type VoiceToolResult =
  | VoiceToolGatherResult
  | VoiceToolTransferResult
  | VoiceToolDeflectResult
  | VoiceToolHangupResult;

/** Maps to `KorevgVerbBuilder.gather()`. Used by IVR menu and digit input tools. */
export interface VoiceToolGatherResult {
  type: 'gather';
  prompt: string;
  input: ('speech' | 'dtmf')[];
  dtmfMappings?: Record<string, { label: string; intent?: string }>;
  timeout?: number;
  maxDigits?: number;
  finishOnKey?: string;
  interDigitTimeout?: number;
  bargeIn?: boolean;
  retries?: {
    noInput: number;
    noMatch: number;
    noInputPrompt?: string;
    noMatchPrompt?: string;
  };
}

/** Maps to SIP REFER or PSTN dial sequences via Jambonz. */
export interface VoiceToolTransferResult {
  type: 'transfer';
  transferType: 'sip' | 'pstn';
  target: string;
  headers?: Record<string, string>;
}

/** Channel-switch metadata for voice-to-chat deflection. */
export interface VoiceToolDeflectResult {
  type: 'deflect';
  targetChannel: string;
  metadata?: Record<string, unknown>;
}

/** Maps to `KorevgVerbBuilder.hangup()`. */
export interface VoiceToolHangupResult {
  type: 'hangup';
  reason?: string;
}
