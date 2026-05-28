/**
 * Omnichannel Session Continuity — Shared Types
 *
 * Types for recall, live session, project settings, and audit events.
 * Used across recall-service, settings-service, routes, and audit modules.
 */

// =============================================================================
// RECALL
// =============================================================================

/** Request to retrieve cross-channel transcript history for a contact */
export interface RecallRequest {
  /** Active session ID (the session requesting recall) */
  sessionId: string;
  /** Tenant scope */
  tenantId: string;
  /** Project scope */
  projectId: string;
  /** Resolved contact ID (may be a merged canonical ID) */
  contactId: string;
  /** Maximum number of messages to return (capped by project settings) */
  maxMessages?: number;
  /** Maximum age in days for recalled messages */
  maxAgeDays?: number;
  /** Restrict recall to messages from specific channels only */
  allowedChannels?: string[];
  /** Retention compliance boundary — clamps maxAgeDays when set */
  retentionMaxDays?: number;
}

/** A single message returned from cross-channel recall */
export interface RecallMessage {
  /** Message document ID */
  id: string;
  /** Session ID where this message originated */
  sessionId: string;
  /** Message role (user, assistant, system, tool) */
  role: string;
  /** Message content (auto-decrypted by Mongoose encryption plugin) */
  content: string;
  /** Channel where this message was sent */
  channel: string;
  /** Originating channel for omnichannel display */
  sourceChannel: string | null;
  /** Message timestamp */
  timestamp: Date;
  /** Input mode: voice, typed, tool, or system */
  inputMode: string | null;
}

/** Result of a cross-channel recall query */
export interface RecallResult {
  /** Recalled messages, ordered newest-first */
  messages: RecallMessage[];
  /** Metadata about the recall operation */
  metadata: {
    /** Number of distinct sessions that contributed messages */
    matchedSessions: number;
    /** Whether the result was truncated (by maxMessages or payload size) */
    truncated: boolean;
    /** Approximate payload size in bytes */
    payloadBytes: number;
  };
}

// =============================================================================
// PROJECT SETTINGS
// =============================================================================

/** Project-level omnichannel configuration */
export interface IOmnichannelProjectSettings {
  /** Cross-channel recall configuration */
  recall: {
    /** Whether recall is enabled for this project */
    enabled: boolean;
    /** Maximum messages to return per recall request */
    maxMessages: number;
    /** Maximum age in days for recalled messages */
    maxAgeDays: number;
    /** Default channels to include in recall (empty = all channels) */
    defaultAllowedChannels: string[];
  };
  /** Identity verification requirements */
  identity: {
    /** Whether identity verification is required for recall */
    requireVerification: boolean;
    /** Minimum identity tier required (0=anonymous, 1=artifact, 2=verified) */
    minTier: number;
  };
  /** Consent configuration */
  consent: {
    /** Whether explicit consent is required for cross-channel capabilities */
    requireExplicitConsent: boolean;
    /** Default capabilities granted when consent is given */
    defaultCapabilities: string[];
  };
  /** Live session synchronization configuration */
  liveSync: {
    /** Whether live sync is enabled */
    enabled: boolean;
    /** How users join live sessions: 'prompt' = ask first, 'auto' = join silently */
    joinMode: 'prompt' | 'auto';
    /** Transcript persistence mode */
    transcriptMode: 'final_only' | 'interim';
  };
  /** Retention compliance configuration */
  retention: {
    /** Maximum days data may be retained — compliance boundary */
    maxRetentionDays: number;
    /** Whether automatic time-based purge is active */
    enableAutoPurge: boolean;
  };
}

/** Deep partial of omnichannel settings — used for update operations */
export interface IOmnichannelProjectSettingsUpdate {
  recall?: {
    enabled?: boolean;
    maxMessages?: number;
    maxAgeDays?: number;
    defaultAllowedChannels?: string[];
  };
  identity?: {
    requireVerification?: boolean;
    minTier?: number;
  };
  consent?: {
    requireExplicitConsent?: boolean;
    defaultCapabilities?: string[];
  };
  liveSync?: {
    enabled?: boolean;
    joinMode?: 'prompt' | 'auto';
    transcriptMode?: 'final_only' | 'interim';
  };
  retention?: {
    maxRetentionDays?: number;
    enableAutoPurge?: boolean;
  };
}

// =============================================================================
// AUDIT EVENTS
// =============================================================================

/** All omnichannel audit event types */
export type OmnichannelAuditEventType =
  | 'omnichannel_recall_requested'
  | 'omnichannel_recall_returned'
  | 'session_linked_to_contact'
  | 'identity_verified'
  | 'live_session_discovered'
  | 'live_session_joined'
  | 'transcript_item_persisted'
  | 'typed_input_interrupted_tts'
  | 'live_session_detached'
  | 'consent_granted'
  | 'consent_revoked';

/** Parameters for emitting an omnichannel audit event */
export interface OmnichannelAuditParams {
  /** The audit event type */
  eventType: OmnichannelAuditEventType;
  /** Tenant scope */
  tenantId: string;
  /** Project scope */
  projectId: string;
  /** Session ID where the event occurred */
  sessionId: string;
  /** Event-specific data payload */
  data?: Record<string, unknown>;
}

// =============================================================================
// LIVE SESSION PARTICIPANTS
// =============================================================================

/** Surface type for a live session participant */
export type ParticipantSurface = 'voice' | 'web' | 'mobile' | 'api';
export type SourceChannel = 'voice' | 'text' | 'system';
export type InputMode = 'speech' | 'typed' | 'system';
export type LiveSyncState = 'active' | 'idle' | 'ended';

/** A participant attached to a live session */
export interface Participant {
  /** Unique participant ID (typically connectionId or generated UUID) */
  participantId: string;
  /** Session ID the participant is attached to */
  sessionId: string;
  /** Contact ID of the user */
  contactId: string;
  /** Runtime-facing physical surface */
  surface: ParticipantSurface;
  /** SDK-facing channel family */
  channel: SourceChannel;
  /** Input mode used by this participant */
  mode: InputMode;
  /** Whether the participant can send input */
  interactive: boolean;
  /** Timestamp when the participant joined */
  attachedAt: Date;
  /** Display label for the participant */
  label?: string;
}

/** Payload stored in a join token */
export interface JoinTokenPayload {
  /** Session ID to join */
  sessionId: string;
  /** Contact ID that the token was issued for */
  contactId: string;
  /** Project scope */
  projectId: string;
  /** Tenant scope */
  tenantId: string;
}

// =============================================================================
// LIVE SESSION SERVICE RESULTS
// =============================================================================

/** Result of discovering a live session */
export interface LiveSessionDiscoveryResult {
  /** The active session ID */
  sessionId: string;
  /** Currently attached participants */
  participants: Participant[];
  /** Current live sync state */
  liveSyncState: LiveSyncState;
}

/** A transcript message for backfill or fan-out */
export interface TranscriptItem {
  /** Message document ID */
  id: string;
  /** Session ID */
  sessionId: string;
  /** Message role */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: string;
  /** Channel where the message was sent */
  channel: SourceChannel;
  /** Display channel used by SDK/UI consumers */
  sourceChannel: SourceChannel;
  /** Input mode (voice, typed, etc.) */
  inputMode: InputMode;
  /** Monotonic sequence number */
  sequence: number;
  /** Message timestamp */
  timestamp: Date;
  /** Whether the transcript item is finalized */
  final: boolean;
  /** Optional message metadata for SDK/UI consumers */
  metadata?: Record<string, unknown>;
}

/** Result of joining a live session */
export interface JoinResult {
  /** Whether the join was successful */
  success: boolean;
  /** Backfill of recent transcript items (on success) */
  backfill: TranscriptItem[];
  /** Current participants (on success) */
  participants: Participant[];
  /** Error details (on failure) */
  error?: { code: string; message: string };
}

interface ParticipantLike {
  participantId?: unknown;
  id?: unknown;
  sessionId?: unknown;
  contactId?: unknown;
  surface?: unknown;
  channel?: unknown;
  mode?: unknown;
  interactive?: unknown;
  attachedAt?: unknown;
  joinedAt?: unknown;
  label?: unknown;
}

interface TranscriptItemLike {
  id?: unknown;
  sessionId?: unknown;
  role?: unknown;
  content?: unknown;
  channel?: unknown;
  sourceChannel?: unknown;
  inputMode?: unknown;
  sequence?: unknown;
  timestamp?: unknown;
  final?: unknown;
  metadata?: unknown;
}

function parseDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function normalizeTranscriptRole(role: unknown): TranscriptItem['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }

  return 'system';
}

export function normalizeSourceChannel(value: unknown): SourceChannel {
  if (value === 'voice') {
    return 'voice';
  }

  if (value === 'system') {
    return 'system';
  }

  return 'text';
}

export function normalizeInputMode(
  value: unknown,
  fallbackChannel: SourceChannel,
  role: TranscriptItem['role'] = 'user',
): InputMode {
  if (value === 'speech' || value === 'voice') {
    return 'speech';
  }

  if (value === 'typed') {
    return 'typed';
  }

  if (value === 'system' || value === 'tool') {
    return 'system';
  }

  if (role === 'assistant' || fallbackChannel === 'system') {
    return 'system';
  }

  return fallbackChannel === 'voice' ? 'speech' : 'typed';
}

export function createParticipant(params: {
  participantId: string;
  sessionId: string;
  contactId: string;
  surface: ParticipantSurface;
  label?: string;
  interactive?: boolean;
  attachedAt?: Date;
  mode?: InputMode;
}): Participant {
  const channel = params.surface === 'voice' ? 'voice' : 'text';

  return {
    participantId: params.participantId,
    sessionId: params.sessionId,
    contactId: params.contactId,
    surface: params.surface,
    channel,
    mode: params.mode ?? (channel === 'voice' ? 'speech' : 'typed'),
    interactive: params.interactive ?? true,
    attachedAt: params.attachedAt ?? new Date(),
    ...(params.label ? { label: params.label } : {}),
  };
}

export function normalizeParticipant(participant: ParticipantLike): Participant | null {
  const participantId =
    typeof participant.participantId === 'string' && participant.participantId.length > 0
      ? participant.participantId
      : typeof participant.id === 'string' && participant.id.length > 0
        ? participant.id
        : null;

  if (!participantId) {
    return null;
  }

  const surface: ParticipantSurface =
    participant.surface === 'voice' ||
    participant.surface === 'web' ||
    participant.surface === 'mobile' ||
    participant.surface === 'api'
      ? participant.surface
      : normalizeSourceChannel(participant.channel) === 'voice'
        ? 'voice'
        : 'web';
  const channel = normalizeSourceChannel(participant.channel ?? surface);

  return {
    participantId,
    sessionId: typeof participant.sessionId === 'string' ? participant.sessionId : '',
    contactId: typeof participant.contactId === 'string' ? participant.contactId : '',
    surface,
    channel,
    mode: normalizeInputMode(participant.mode, channel),
    interactive: participant.interactive !== false,
    attachedAt: parseDate(participant.attachedAt ?? participant.joinedAt),
    ...(typeof participant.label === 'string' && participant.label.length > 0
      ? { label: participant.label }
      : {}),
  };
}

export function normalizeTranscriptItem(item: TranscriptItemLike): TranscriptItem {
  const role = normalizeTranscriptRole(item.role);
  const sourceChannel = normalizeSourceChannel(item.sourceChannel ?? item.channel);

  return {
    id: typeof item.id === 'string' ? item.id : '',
    sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
    role,
    content: typeof item.content === 'string' ? item.content : '',
    channel: sourceChannel,
    sourceChannel,
    inputMode: normalizeInputMode(item.inputMode, sourceChannel, role),
    sequence:
      typeof item.sequence === 'number' && Number.isFinite(item.sequence) ? item.sequence : 0,
    timestamp: parseDate(item.timestamp),
    final: item.final !== false,
    ...(item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? { metadata: item.metadata as Record<string, unknown> }
      : {}),
  };
}
