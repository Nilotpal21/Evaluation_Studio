import { CHANNEL_MANIFEST, isKnownChannelType } from './manifest.js';
import type { ChannelType } from './types.js';

/**
 * Trace delivery semantics exposed by the current channel surface.
 *
 * - stream: trace events are streamed directly to the client/channel consumer
 * - inline: trace data is returned inline with the sync response payload
 * - correlation_only: no inline/streamed traces, but the response exposes a
 *   stable session identifier that can be used for later lookup
 * - observability_only: traces exist in platform observability, but the channel
 *   surface does not currently expose a stable trace retrieval handle
 */
export type TraceDeliveryMode = 'stream' | 'inline' | 'correlation_only' | 'observability_only';

/**
 * Studio debug is the only surface that should ever show runtime config banners.
 *
 * Studio debug banners are derived from session_health diagnostics emitted
 * during session boot plus banner-eligible configuration traces promoted into
 * the observatory stream during execution.
 */
export type BannerPolicy = 'none' | 'studio_debug_config_only';

export type PreflightAuthMode = 'interactive_gate' | 'outcome_only' | 'unsupported';
export type JitAuthMode = 'interactive' | 'unsupported';
export type RichContentMode = 'full' | 'actions_only' | 'text_only' | 'structured_passthrough';
export type VoiceConfigMode = 'full' | 'plain_text_only' | 'ignored';
export type AttachmentSupportMode =
  | 'upload_and_send'
  | 'channel_media_ingest'
  | 'artifact_parts'
  | 'none';
export type FormSubmissionMode = 'interactive_submit' | 'none';
export type ProactiveDeliveryMode =
  | 'on_start'
  | 'async_updates'
  | 'on_start_and_async_updates'
  | 'channel_native'
  | 'none';
export type PresenceSemanticsMode =
  | 'typing_and_thoughts'
  | 'thoughts_only'
  | 'channel_native_typing'
  | 'status_updates'
  | 'none';
export type SessionClosureMode = 'explicit_end_event' | 'task_terminal' | 'implicit_only';
export type SessionOutcomeEvidenceMode =
  | 'explicit_end_event'
  | 'task_terminal'
  | 'transport_lifecycle_event'
  | 'provider_terminal_status'
  | 'provider_disconnect_attribution'
  | 'implicit_or_ttl';
export type TimeoutMode = 'shared_outcome' | 'ws_error_close' | 'direct_handler';
export type SessionLifecycleMode =
  | 'create_resume_join'
  | 'create_resume'
  | 'implicit_resume'
  | 'ephemeral';
export type IdentityLinkingMode = 'verified_contact' | 'artifact_only' | 'none';
export type ImplementationStatus = 'working' | 'partial' | 'gap' | 'separate_stack';

/**
 * Logical parity families used by the final cross-channel audit.
 *
 * These are intentionally product-surface groupings, not transport or routing
 * implementation details. For example, `sdk_chat` is a logical family label
 * even though there is no `sdk_chat` manifest key.
 */
export const CHANNEL_LOGICAL_FAMILIES = {
  studio_debug: ['web_debug'],
  sdk_chat: ['web_chat', 'sdk_websocket'],
  sdk_voice: ['voice', 'voice_pipeline', 'voice_realtime'],
  http_sync: ['http', 'api'],
  http_async: ['http_async'],
  messaging_async: [
    'slack',
    'line',
    'msteams',
    'whatsapp',
    'messenger',
    'instagram',
    'twilio_sms',
    'zendesk',
    'telegram',
    'genesys',
    'ai4w',
    'email',
  ],
  sync_webhook_bridge: ['voice_vxml', 'korevg', 'audiocodes', 'voice_twilio'],
  livekit_voice: ['voice_livekit'],
  a2a: ['a2a'],
  ag_ui: ['ag_ui'],
} as const satisfies Record<string, readonly ChannelType[]>;

export type ChannelLogicalFamily = keyof typeof CHANNEL_LOGICAL_FAMILIES;

/**
 * Semantic behavior profiles capture shared runtime expectations that cut
 * across transport families. This is intentionally a second axis from
 * `CHANNEL_LOGICAL_FAMILIES`: a voice transport can remain a distinct delivery
 * family while still inheriting the same "voice core" behavior model.
 */
export type ChannelBehaviorProfile =
  | 'studio_debug'
  | 'sdk_chat'
  | 'sdk_voice'
  | 'voice_core'
  | 'http_sync'
  | 'http_async'
  | 'messaging_async'
  | 'sync_bridge'
  | 'a2a'
  | 'ag_ui';

export const VOICE_BEHAVIOR_PROFILES = [
  'sdk_voice',
  'voice_core',
] as const satisfies readonly ChannelBehaviorProfile[];

export type VoiceBehaviorProfile = (typeof VOICE_BEHAVIOR_PROFILES)[number];

export const CHANNEL_BEHAVIOR_PROFILES = {
  web_debug: 'studio_debug',
  web_chat: 'sdk_chat',
  sdk_websocket: 'sdk_chat',
  voice: 'sdk_voice',
  voice_pipeline: 'sdk_voice',
  voice_realtime: 'sdk_voice',
  http: 'http_sync',
  api: 'http_sync',
  http_async: 'http_async',
  slack: 'messaging_async',
  line: 'messaging_async',
  msteams: 'messaging_async',
  whatsapp: 'messaging_async',
  messenger: 'messaging_async',
  instagram: 'messaging_async',
  twilio_sms: 'messaging_async',
  zendesk: 'messaging_async',
  telegram: 'messaging_async',
  email: 'messaging_async',
  genesys: 'sync_bridge',
  ai4w: 'messaging_async',
  voice_vxml: 'voice_core',
  korevg: 'voice_core',
  audiocodes: 'voice_core',
  voice_twilio: 'voice_core',
  voice_livekit: 'voice_core',
  a2a: 'a2a',
  ag_ui: 'ag_ui',
} as const satisfies Record<ChannelType, ChannelBehaviorProfile>;

/**
 * Explicit, channel-by-channel contract describing the platform's current
 * end-to-end behavior. This is intentionally descriptive rather than
 * aspirational so follow-up PRs can tighten one concern at a time and show the
 * diff clearly in code review.
 */
export interface ChannelBehaviorContract {
  traceDelivery: TraceDeliveryMode;
  bannerPolicy: BannerPolicy;
  preflightAuth: PreflightAuthMode;
  jitAuth: JitAuthMode;
  richContent: RichContentMode;
  voiceConfig: VoiceConfigMode;
  attachmentSupport: AttachmentSupportMode;
  formSubmission: FormSubmissionMode;
  proactiveDelivery: ProactiveDeliveryMode;
  presenceSemantics: PresenceSemanticsMode;
  sessionClosure: SessionClosureMode;
  sessionOutcomeEvidence: SessionOutcomeEvidenceMode;
  timeoutHandling: TimeoutMode;
  sessionLifecycle: SessionLifecycleMode;
  identityLinking: IdentityLinkingMode;
  implementationStatus: ImplementationStatus;
}

export const CHANNEL_BEHAVIOR_CONTRACT = {
  http_async: {
    traceDelivery: 'correlation_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'structured_passthrough',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'working',
  },
  slack: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  line: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'actions_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  whatsapp: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  messenger: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  instagram: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  twilio_sms: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  zendesk: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'actions_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  telegram: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'actions_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  genesys: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'actions_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  ai4w: {
    traceDelivery: 'correlation_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'none',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  email: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'ignored',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  msteams: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'channel_media_ingest',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'channel_native_typing',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'partial',
  },
  voice_vxml: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'transport_lifecycle_event',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  korevg: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'provider_disconnect_attribution',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'ephemeral',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  audiocodes: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'transport_lifecycle_event',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  voice_pipeline: {
    traceDelivery: 'stream',
    bannerPolicy: 'none',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'thoughts_only',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'ws_error_close',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  web_debug: {
    traceDelivery: 'stream',
    bannerPolicy: 'studio_debug_config_only',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'full',
    voiceConfig: 'full',
    attachmentSupport: 'upload_and_send',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'on_start_and_async_updates',
    presenceSemantics: 'typing_and_thoughts',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'direct_handler',
    sessionLifecycle: 'create_resume_join',
    identityLinking: 'none',
    implementationStatus: 'partial',
  },
  web_chat: {
    traceDelivery: 'stream',
    bannerPolicy: 'none',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'upload_and_send',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'on_start_and_async_updates',
    presenceSemantics: 'typing_and_thoughts',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'ws_error_close',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  sdk_websocket: {
    traceDelivery: 'stream',
    bannerPolicy: 'none',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'full',
    voiceConfig: 'ignored',
    attachmentSupport: 'upload_and_send',
    formSubmission: 'interactive_submit',
    proactiveDelivery: 'on_start_and_async_updates',
    presenceSemantics: 'typing_and_thoughts',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'ws_error_close',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  api: {
    traceDelivery: 'inline',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'full',
    attachmentSupport: 'upload_and_send',
    formSubmission: 'none',
    proactiveDelivery: 'none',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'working',
  },
  ag_ui: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'unsupported',
    jitAuth: 'unsupported',
    richContent: 'structured_passthrough',
    voiceConfig: 'ignored',
    attachmentSupport: 'artifact_parts',
    formSubmission: 'none',
    proactiveDelivery: 'channel_native',
    presenceSemantics: 'status_updates',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'direct_handler',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'artifact_only',
    implementationStatus: 'separate_stack',
  },
  voice: {
    traceDelivery: 'stream',
    bannerPolicy: 'none',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'thoughts_only',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'ws_error_close',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  voice_twilio: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'provider_terminal_status',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  voice_livekit: {
    traceDelivery: 'correlation_only',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'none',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'transport_lifecycle_event',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'ephemeral',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  http: {
    traceDelivery: 'inline',
    bannerPolicy: 'none',
    preflightAuth: 'outcome_only',
    jitAuth: 'unsupported',
    richContent: 'full',
    voiceConfig: 'full',
    attachmentSupport: 'upload_and_send',
    formSubmission: 'none',
    proactiveDelivery: 'none',
    presenceSemantics: 'none',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'implicit_or_ttl',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'working',
  },
  voice_realtime: {
    traceDelivery: 'stream',
    bannerPolicy: 'none',
    preflightAuth: 'interactive_gate',
    jitAuth: 'interactive',
    richContent: 'text_only',
    voiceConfig: 'plain_text_only',
    attachmentSupport: 'none',
    formSubmission: 'none',
    proactiveDelivery: 'on_start',
    presenceSemantics: 'thoughts_only',
    sessionClosure: 'explicit_end_event',
    sessionOutcomeEvidence: 'explicit_end_event',
    timeoutHandling: 'ws_error_close',
    sessionLifecycle: 'create_resume',
    identityLinking: 'verified_contact',
    implementationStatus: 'partial',
  },
  a2a: {
    traceDelivery: 'observability_only',
    bannerPolicy: 'none',
    preflightAuth: 'unsupported',
    jitAuth: 'unsupported',
    richContent: 'structured_passthrough',
    voiceConfig: 'ignored',
    attachmentSupport: 'artifact_parts',
    formSubmission: 'none',
    proactiveDelivery: 'async_updates',
    presenceSemantics: 'status_updates',
    sessionClosure: 'implicit_only',
    sessionOutcomeEvidence: 'task_terminal',
    timeoutHandling: 'shared_outcome',
    sessionLifecycle: 'implicit_resume',
    identityLinking: 'none',
    implementationStatus: 'partial',
  },
} as const satisfies Record<ChannelType, ChannelBehaviorContract>;

/**
 * Look up the behavior contract for a channel type.
 * Returns undefined for unknown channel types.
 */
export function getChannelBehaviorContract(
  channelType: string,
): ChannelBehaviorContract | undefined {
  if (!isKnownChannelType(channelType)) {
    return undefined;
  }
  return CHANNEL_BEHAVIOR_CONTRACT[channelType as ChannelType];
}

/**
 * Require a behavior contract for a known channel type.
 */
export function requireChannelBehaviorContract(channelType: ChannelType): ChannelBehaviorContract {
  return CHANNEL_BEHAVIOR_CONTRACT[channelType];
}

/**
 * Derive channel types from the behavior contract rather than re-encoding
 * additional hard-coded channel lists.
 */
export function getChannelTypesByTraceDelivery(mode: TraceDeliveryMode): ChannelType[] {
  return (
    Object.entries(CHANNEL_BEHAVIOR_CONTRACT) as Array<[ChannelType, ChannelBehaviorContract]>
  )
    .filter(([, entry]) => entry.traceDelivery === mode)
    .map(([channelType]) => channelType);
}

export function getChannelTypesByRichContentMode(mode: RichContentMode): ChannelType[] {
  return (
    Object.entries(CHANNEL_BEHAVIOR_CONTRACT) as Array<[ChannelType, ChannelBehaviorContract]>
  )
    .filter(([, entry]) => entry.richContent === mode)
    .map(([channelType]) => channelType);
}

export function getChannelTypesByLogicalFamily(family: ChannelLogicalFamily): ChannelType[] {
  return [...CHANNEL_LOGICAL_FAMILIES[family]];
}

export function getChannelTypesByBehaviorProfile(profile: ChannelBehaviorProfile): ChannelType[] {
  return (Object.entries(CHANNEL_BEHAVIOR_PROFILES) as Array<[ChannelType, ChannelBehaviorProfile]>)
    .filter(([, value]) => value === profile)
    .map(([channelType]) => channelType);
}

export function isVoiceBehaviorProfile(
  profile: ChannelBehaviorProfile,
): profile is VoiceBehaviorProfile {
  return (VOICE_BEHAVIOR_PROFILES as readonly ChannelBehaviorProfile[]).includes(profile);
}

export function getVoiceChannelTypesByBehaviorProfile(
  profile: VoiceBehaviorProfile,
): ChannelType[] {
  return getChannelTypesByBehaviorProfile(profile);
}

export function getVoiceBehaviorProfileForChannelType(
  channelType: ChannelType,
): VoiceBehaviorProfile | null {
  const profile = CHANNEL_BEHAVIOR_PROFILES[channelType];
  return isVoiceBehaviorProfile(profile) ? profile : null;
}

export function getLogicalFamilyForChannelType(channelType: ChannelType): ChannelLogicalFamily {
  const familyEntry = (
    Object.entries(CHANNEL_LOGICAL_FAMILIES) as Array<
      [ChannelLogicalFamily, readonly ChannelType[]]
    >
  ).find(([, channelTypes]) => channelTypes.includes(channelType));

  if (!familyEntry) {
    throw new Error(`No logical family defined for channel type "${channelType}"`);
  }

  return familyEntry[0];
}

/**
 * Safety check for local development and tests: the behavior contract must stay
 * aligned with the channel manifest.
 */
export function isChannelBehaviorContractAlignedWithManifest(): boolean {
  const manifestKeys = Object.keys(CHANNEL_MANIFEST).sort();
  const contractKeys = Object.keys(CHANNEL_BEHAVIOR_CONTRACT).sort();
  return (
    manifestKeys.length === contractKeys.length &&
    manifestKeys.every((key, index) => key === contractKeys[index])
  );
}
