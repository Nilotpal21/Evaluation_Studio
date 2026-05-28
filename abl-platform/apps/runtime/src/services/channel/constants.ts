/**
 * Channel Platform Constants
 *
 * All platform-owned strings for channel adapters, error messages,
 * and fallback responses. Engine code reads from here — never inlines
 * domain-specific or user-facing string literals.
 *
 * Customer/agent-defined strings come from the IR at runtime.
 */

// =============================================================================
// CHANNEL TYPES  (runtime-level, superset of compiler Channel type)
// =============================================================================

/**
 * Runtime channel type — identifies the transport that originated the session.
 * Stored on RuntimeSession.channelType and used for adapter resolution,
 * lifecycle config lookup, and message persistence tagging.
 *
 * The compiler-level `Channel` type is a subset used for DB persistence;
 * this enum adds transport-specific variants the runtime needs internally.
 */
export const RUNTIME_CHANNEL = {
  /** SDK WebSocket — embedded widget (text mode) */
  WEB_CHAT: 'web_chat',
  /** Twilio voice pipeline — STT→Agent→TTS */
  VOICE: 'voice',
  /** REST /api/v1/chat/agent endpoint */
  API: 'api',
  /** Debug WebSocket (/ws) — studio testing */
  WEB_DEBUG: 'web_debug',
} as const;

export type RuntimeChannel = (typeof RUNTIME_CHANNEL)[keyof typeof RUNTIME_CHANNEL];

// =============================================================================
// VOICE ENGINE IDENTIFIERS
// =============================================================================

export const VOICE_ENGINE = {
  ELEVENLABS: 'elevenlabs',
  OPENAI_REALTIME: 'openai_realtime',
  GEMINI_LIVE: 'gemini_live',
  GOOGLE_TTS: 'google_tts',
  AZURE_SPEECH: 'azure_speech',
} as const;

export type VoiceEngine = (typeof VOICE_ENGINE)[keyof typeof VOICE_ENGINE];

// =============================================================================
// FALLBACK / ERROR MESSAGES  (platform-owned, not customer-specific)
// =============================================================================

export const PLATFORM_MESSAGES = {
  /** Sent when the runtime executor is not configured for a voice session */
  VOICE_RUNTIME_NOT_CONFIGURED: 'The agent runtime is not configured for this voice session.',
  /** Sent when utterance processing encounters an unrecoverable error */
  VOICE_PROCESSING_ERROR: "I'm sorry, I encountered an error processing your request.",
  /** Sent when the SDK runtime is not configured (no tenant model) */
  SDK_DEMO_MODE:
    "I'm currently in demo mode. To enable full AI capabilities, please configure a TenantModel with credentials for this tenant.",
  /** Diagnostic shown on interactive/API surfaces when execution completed with no visible output */
  EMPTY_RESPONSE_DIAGNOSTIC: "I'm having trouble completing that request. Please try again.",
  /** Safe fallback for end-user channels when execution completed with no visible output */
  EMPTY_RESPONSE_FALLBACK:
    "I'm sorry, I couldn't generate a response. Please try again in a moment.",
  /** Diagnostic shown when the runtime had to summarize a channel-native payload for web/API surfaces */
  CHANNEL_NATIVE_CONTENT_SUMMARY_DIAGNOSTIC:
    'The agent returned channel-native rich content without plain text, so the platform generated a summary for this surface.',
  /** Safe fallback when a channel-native payload has no extractable preview text */
  CHANNEL_NATIVE_CONTENT_SUMMARY_FALLBACK:
    'The agent sent channel-optimized content that is summarized on this surface.',
  /** Diagnostic shown when an interactive surface receives structured JSON without plain text */
  STRUCTURED_RESPONSE_SUMMARY_DIAGNOSTIC:
    'The agent returned structured JSON without plain text, so the platform generated a text summary for this surface.',
  /** Diagnostic shown on interactive/API surfaces when execution times out */
  EXECUTION_TIMEOUT_DIAGNOSTIC:
    'The request timed out before the agent could respond. Please try again.',
  /** Safe fallback for end-user channels when execution times out */
  EXECUTION_TIMEOUT_FALLBACK:
    "I'm sorry, I'm taking too long to respond. Please try again in a moment.",
  /** Diagnostic shown when required authorization is missing */
  AUTH_REQUIRED_DIAGNOSTIC: 'Authorization is required before the agent can continue.',
  /** Safe fallback for non-interactive channels when authorization is missing */
  AUTH_REQUIRED_FALLBACK: "I can't continue until the required authorization has been completed.",
  /** Diagnostic shown on interactive/API surfaces when execution fails */
  EXECUTION_FAILED_DIAGNOSTIC: 'Failed to process the request.',
  /** Safe fallback for non-interactive channels when execution fails */
  EXECUTION_FAILED_FALLBACK:
    "I'm sorry, I couldn't complete that request. Please try again in a moment.",
  /** Notice shown when a message is queued behind an auth gate */
  MESSAGE_QUEUED_AUTH: 'Your message is queued until the required authorization is completed.',
} as const;

// =============================================================================
// ENV-VAR-BACKED CONFIGURATION HELPERS
// =============================================================================

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// =============================================================================
// RESOURCE LIMITS
// =============================================================================

/** Max concurrent Twilio media sessions before rejecting new connections */
export const MAX_MEDIA_SESSIONS = safeParseInt(process.env.MAX_MEDIA_SESSIONS, 10_000);

/** Max concurrent SDK WebSocket clients before rejecting new connections */
export const MAX_SDK_CLIENTS = safeParseInt(process.env.MAX_SDK_CLIENTS, 50_000);

/** Max concurrent Korevg voice WebSocket sessions before rejecting new connections */
export const MAX_KOREVG_SESSIONS = safeParseInt(process.env.MAX_KOREVG_SESSIONS, 500);

/** TTL for stale media sessions that never received a stop event (ms) */
export const MEDIA_SESSION_TTL_MS = safeParseInt(process.env.MEDIA_SESSION_TTL_MS, 30 * 60 * 1000);

/** Max entries in per-tenant ClickHouse store caches */
export const MAX_CLICKHOUSE_STORE_CACHE = safeParseInt(
  process.env.MAX_CLICKHOUSE_STORE_CACHE,
  1_000,
);

/** Max entries in the WS rate limiter IP map */
export const MAX_RATE_LIMITER_ENTRIES = safeParseInt(
  process.env.WS_RATE_LIMITER_MAX_ENTRIES,
  100_000,
);

/** Timeout for WebSocket message processing before sending an error to the client (ms) */
export const WS_MESSAGE_TIMEOUT_MS = safeParseInt(process.env.WS_MESSAGE_TIMEOUT_MS, 90_000);

// =============================================================================
// KOREVG VOICE CHANNEL DEFAULTS
// =============================================================================

/** Default TTS vendor used when not specified in the channel connection config */
export const DEFAULT_KOREVG_TTS_VENDOR = 'elevenlabs';

/** Default TTS voice ID (ElevenLabs Bella voice) used when not specified in the channel connection config */
export const DEFAULT_KOREVG_TTS_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // ElevenLabs Bella voice

/** Default STT vendor used when not specified in the channel connection config */
export const DEFAULT_KOREVG_STT_VENDOR = 'deepgram';

/** Max messages buffered in the per-session verb:hook queue before dropping the oldest */
export const MAX_KOREVG_QUEUE_SIZE = 50;
