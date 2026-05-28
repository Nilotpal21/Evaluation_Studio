import type {
  JoinResult,
  LiveSessionDiscoveryResult,
  Message,
  Participant,
  TranscriptItem,
  WSServerMessage,
} from '../core/types.js';

const DEFAULT_DISCOVERY_SESSION_ID = 'live-session-1';
const DEFAULT_PARTICIPANT_ID = 'participant-1';
const DEFAULT_CONTACT_ID = 'contact-1';
const DEFAULT_ATTACHED_AT = new Date('2026-04-06T10:00:00.000Z');
const DEFAULT_TRANSCRIPT_TIMESTAMP = new Date('2026-04-06T10:00:01.000Z');

function toWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createCanonicalParticipant(overrides: Partial<Participant> = {}): Participant {
  const sessionId = overrides.sessionId ?? DEFAULT_DISCOVERY_SESSION_ID;
  const channel = overrides.channel ?? 'voice';
  const surface = overrides.surface ?? (channel === 'voice' ? 'voice' : 'web');
  const mode = overrides.mode ?? (channel === 'voice' ? 'speech' : 'typed');

  return {
    participantId: overrides.participantId ?? DEFAULT_PARTICIPANT_ID,
    sessionId,
    contactId: overrides.contactId ?? DEFAULT_CONTACT_ID,
    surface,
    channel,
    mode,
    interactive: overrides.interactive ?? true,
    attachedAt: overrides.attachedAt ?? DEFAULT_ATTACHED_AT,
    ...(typeof overrides.label === 'string' ? { label: overrides.label } : {}),
  };
}

export function createCanonicalTranscriptItem(
  overrides: Partial<TranscriptItem> = {},
): TranscriptItem {
  const sourceChannel = overrides.sourceChannel ?? overrides.channel ?? 'voice';
  const role = overrides.role ?? 'assistant';
  const inputMode =
    overrides.inputMode ??
    (role === 'assistant' || sourceChannel === 'system'
      ? 'system'
      : sourceChannel === 'voice'
        ? 'speech'
        : 'typed');

  return {
    id: overrides.id ?? 'transcript-1',
    sessionId: overrides.sessionId ?? DEFAULT_DISCOVERY_SESSION_ID,
    role,
    content: overrides.content ?? 'Transcript item',
    channel: overrides.channel ?? sourceChannel,
    sourceChannel,
    inputMode,
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? DEFAULT_TRANSCRIPT_TIMESTAMP,
    final: overrides.final ?? true,
  };
}

export function createCanonicalDiscovery(
  overrides: Partial<LiveSessionDiscoveryResult> = {},
): LiveSessionDiscoveryResult {
  const sessionId = overrides.sessionId ?? DEFAULT_DISCOVERY_SESSION_ID;
  return {
    sessionId,
    participants: overrides.participants ?? [
      createCanonicalParticipant({ sessionId, channel: 'voice', surface: 'voice', mode: 'speech' }),
    ],
    liveSyncState: overrides.liveSyncState ?? 'active',
  };
}

export function createCanonicalJoinResult(overrides: Partial<JoinResult> = {}): JoinResult {
  return {
    success: overrides.success ?? true,
    backfill: overrides.backfill ?? [],
    participants: overrides.participants ?? [],
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

export function createLiveSessionDiscoveredWireMessage(
  overrides: Partial<LiveSessionDiscoveryResult> = {},
): WSServerMessage {
  return toWire({
    type: 'live_session_discovered',
    ...createCanonicalDiscovery(overrides),
  }) as WSServerMessage;
}

export function createLiveSessionJoinedWireMessage(
  params: {
    sessionId?: string;
    participantId?: string;
    backfill?: TranscriptItem[];
    participants?: Participant[];
  } = {},
): WSServerMessage {
  return toWire({
    type: 'live_session_joined',
    sessionId: params.sessionId ?? DEFAULT_DISCOVERY_SESSION_ID,
    participantId: params.participantId ?? 'participant-self',
    backfill: params.backfill ?? [],
    participants: params.participants ?? [],
  }) as WSServerMessage;
}

export function createTranscriptItemWireMessage(
  overrides: Partial<TranscriptItem> = {},
): WSServerMessage {
  return toWire({
    type: 'transcript_item',
    ...createCanonicalTranscriptItem(overrides),
  }) as WSServerMessage;
}

export function createParticipantEventWireMessage(
  eventType: 'participant_attached' | 'participant_detached',
  overrides: Partial<Participant> = {},
): WSServerMessage {
  const participant = createCanonicalParticipant(overrides);
  return toWire({
    type: eventType,
    sessionId: participant.sessionId,
    participant,
  }) as WSServerMessage;
}

export function transcriptItemToChatMessage(item: TranscriptItem): Message {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    timestamp: item.timestamp,
    sourceChannel: item.sourceChannel,
    inputMode: item.inputMode,
  };
}
