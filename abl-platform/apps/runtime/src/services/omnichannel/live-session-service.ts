/**
 * Live Session Service — Orchestration for Live Omnichannel Transcript Sync
 *
 * Provides:
 * - Session discovery: find active voice session for a verified contact
 * - Join: attach a new participant with consent/identity checks and transcript backfill
 * - Detach: remove a participant without ending the session
 * - Activate/end live sync: manage live session lifecycle
 *
 * All operations check consent (live_transcript_sync) and identity tier (2+).
 */

import { createLogger } from '@abl/compiler/platform';
import { ContactCapabilityConsent, Message, type IMessage } from '@agent-platform/database/models';
import { getOmnichannelSettings } from './omnichannel-settings-service.js';
import { emitOmnichannelAudit } from './omnichannel-audit.js';
import * as participantRegistry from './participant-registry.js';
import type {
  Participant,
  LiveSessionDiscoveryResult,
  JoinResult,
  TranscriptItem,
} from './types.js';
import { normalizeTranscriptItem } from './types.js';
import { renderSessionMessagesForUserSurface } from '../pii/runtime-pii-boundary-service.js';
import { buildProjectPIIReadSurfaceContext } from '../pii/session-pii-context.js';

const log = createLogger('omnichannel-live-session');

function normalizeMessageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// CONSENT CHECK
// =============================================================================

/**
 * Check if a contact has granted live_transcript_sync consent.
 * Returns true if consent is granted, false otherwise.
 */
async function hasLiveSyncConsent(
  tenantId: string,
  projectId: string,
  contactId: string,
): Promise<boolean> {
  try {
    const consent = await ContactCapabilityConsent.findOne({
      tenantId,
      projectId,
      contactId,
      capability: 'live_transcript_sync',
      state: 'granted',
    }).lean();
    return consent !== null;
  } catch (err) {
    log.error('Failed to check live sync consent', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      projectId,
      contactId,
    });
    return false;
  }
}

// =============================================================================
// DISCOVER
// =============================================================================

/**
 * Discover an active live session for a contact.
 * Returns session info and participants, or null if no active session.
 *
 * Requires verified identity (tier 2+) and live_transcript_sync consent.
 */
export async function discoverLiveSession(
  tenantId: string,
  projectId: string,
  contactId: string,
  identityTier: number,
): Promise<LiveSessionDiscoveryResult | null> {
  // Check identity tier
  if (identityTier < 2) {
    log.info('Live session discovery denied — insufficient identity tier', {
      tenantId,
      projectId,
      contactId,
      identityTier,
    });
    return null;
  }

  // Check settings
  const settings = await getOmnichannelSettings(tenantId, projectId);
  if (!settings.liveSync.enabled) {
    return null;
  }

  // Check consent
  const hasConsent = await hasLiveSyncConsent(tenantId, projectId, contactId);
  if (!hasConsent) {
    log.info('Live session discovery denied — no live_transcript_sync consent', {
      tenantId,
      projectId,
      contactId,
    });
    return null;
  }

  // Look up active session
  const sessionId = await participantRegistry.getLiveSession(tenantId, projectId, contactId);
  if (!sessionId) {
    return null;
  }

  const participants = await participantRegistry.getParticipants(sessionId);

  emitOmnichannelAudit({
    eventType: 'live_session_discovered',
    tenantId,
    projectId,
    sessionId,
    data: { contactId, participantCount: participants.length },
  });

  return { sessionId, participants, liveSyncState: 'active' };
}

// =============================================================================
// JOIN
// =============================================================================

/**
 * Join a live session.
 *
 * Checks consent and identity, validates join token if provided,
 * registers participant, and returns transcript backfill.
 */
export async function joinLiveSession(
  tenantId: string,
  projectId: string,
  sessionId: string,
  participant: Participant,
  contactId: string,
  identityTier: number,
  joinToken?: string,
): Promise<JoinResult> {
  // Check identity tier
  if (identityTier < 2) {
    return {
      success: false,
      backfill: [],
      participants: [],
      error: { code: 'IDENTITY_INSUFFICIENT', message: 'Verified identity required for live sync' },
    };
  }

  // Check settings
  const settings = await getOmnichannelSettings(tenantId, projectId);
  if (!settings.liveSync.enabled) {
    return {
      success: false,
      backfill: [],
      participants: [],
      error: { code: 'LIVE_SYNC_DISABLED', message: 'Live sync is not enabled for this project' },
    };
  }

  // Check consent
  const hasConsent = await hasLiveSyncConsent(tenantId, projectId, contactId);
  if (!hasConsent) {
    return {
      success: false,
      backfill: [],
      participants: [],
      error: {
        code: 'CONSENT_REQUIRED',
        message: 'live_transcript_sync consent required',
      },
    };
  }

  // Validate join token if provided
  if (joinToken) {
    const payload = await participantRegistry.redeemJoinToken(joinToken);
    if (!payload) {
      return {
        success: false,
        backfill: [],
        participants: [],
        error: { code: 'INVALID_JOIN_TOKEN', message: 'Join token is invalid or expired' },
      };
    }
    // Verify token is for this session, contact, tenant, and project
    if (
      payload.sessionId !== sessionId ||
      payload.contactId !== contactId ||
      payload.tenantId !== tenantId ||
      payload.projectId !== projectId
    ) {
      return {
        success: false,
        backfill: [],
        participants: [],
        error: { code: 'TOKEN_MISMATCH', message: 'Join token does not match session or contact' },
      };
    }
  }

  // Verify the session is actually active in Redis
  const liveSessionId = await participantRegistry.getLiveSession(tenantId, projectId, contactId);
  if (liveSessionId !== sessionId) {
    return {
      success: false,
      backfill: [],
      participants: [],
      error: { code: 'SESSION_NOT_ACTIVE', message: 'Live session is no longer active' },
    };
  }

  // Register participant
  try {
    await participantRegistry.addParticipant(sessionId, participant);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to add participant', { sessionId, error: message });
    return {
      success: false,
      backfill: [],
      participants: [],
      error: { code: 'JOIN_FAILED', message },
    };
  }

  // Fetch backfill — recent messages for this session, bounded by settings
  const backfillStartMs = Date.now();
  const backfill = await getTranscriptBackfill(
    tenantId,
    projectId,
    sessionId,
    settings.recall.maxMessages,
  );
  const backfillDurationMs = Date.now() - backfillStartMs;

  const participants = await participantRegistry.getParticipants(sessionId);

  log.info('Live session join completed', {
    sessionId,
    participantId: participant.participantId,
    surface: participant.surface,
    backfillSize: backfill.length,
    backfillDurationMs,
    participantCount: participants.length,
  });

  emitOmnichannelAudit({
    eventType: 'live_session_joined',
    tenantId,
    projectId,
    sessionId,
    data: {
      participantId: participant.participantId,
      surface: participant.surface,
      contactId,
      participantCount: participants.length,
    },
  });

  return { success: true, backfill, participants };
}

// =============================================================================
// DETACH
// =============================================================================

/**
 * Detach a participant from a live session.
 * Does not end the session — other participants continue.
 */
export async function detachParticipant(
  sessionId: string,
  participantId: string,
  tenantId?: string,
  projectId?: string,
): Promise<void> {
  await participantRegistry.removeParticipant(sessionId, participantId);

  if (tenantId && projectId) {
    emitOmnichannelAudit({
      eventType: 'live_session_detached',
      tenantId,
      projectId,
      sessionId,
      data: { participantId },
    });
  }

  log.info('Participant detached', { sessionId, participantId });
}

// =============================================================================
// ACTIVATE / END LIVE SYNC
// =============================================================================

/**
 * Activate live sync for a session.
 * Registers the session in the Redis live-session lookup for the contact.
 */
export async function activateLiveSync(
  sessionId: string,
  contactId: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  // Check settings
  const settings = await getOmnichannelSettings(tenantId, projectId);
  if (!settings.liveSync.enabled) {
    log.info('Live sync activation skipped — not enabled', { tenantId, projectId, sessionId });
    return;
  }

  await participantRegistry.registerLiveSession(tenantId, projectId, contactId, sessionId);

  log.info('Live sync activated', { sessionId, contactId, tenantId, projectId });
}

/**
 * End live sync for a session.
 * Cleans up participant set and sequence keys.
 * The live-session lookup must be cleaned separately if the session is fully ending.
 */
export async function endLiveSync(
  sessionId: string,
  tenantId?: string,
  projectId?: string,
  contactId?: string,
): Promise<void> {
  await participantRegistry.cleanup(sessionId);

  // Remove live session lookup if we have the contact info
  if (tenantId && projectId && contactId) {
    await participantRegistry.removeLiveSession(tenantId, projectId, contactId);
  }

  log.info('Live sync ended', { sessionId });
}

// =============================================================================
// TRANSCRIPT BACKFILL
// =============================================================================

/**
 * Fetch recent transcript items for backfill when a participant joins.
 * Returns messages ordered by sequence (if available) or timestamp.
 * Does NOT use .lean() because encryption plugin needs Mongoose documents.
 */
async function getTranscriptBackfill(
  tenantId: string,
  projectId: string,
  sessionId: string,
  maxMessages: number,
): Promise<TranscriptItem[]> {
  try {
    const messages = await Message.find({
      tenantId,
      projectId,
      sessionId,
      role: { $in: ['user', 'assistant'] },
    })
      .sort({ sequence: -1, timestamp: -1 })
      .limit(maxMessages);

    const piiReadContext = await buildProjectPIIReadSurfaceContext({
      tenantId,
      projectId,
    });

    const transcriptItems = messages.reverse().map((msg: IMessage) => {
      const metadata = normalizeMessageMetadata(
        (msg as IMessage & { metadata?: unknown }).metadata,
      );
      return {
        id: msg._id as string,
        sessionId: msg.sessionId,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        channel: msg.sourceChannel ?? msg.channel,
        sourceChannel: msg.sourceChannel ?? msg.channel,
        inputMode: msg.inputMode,
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        final: msg.final,
        ...(metadata ? { metadata } : {}),
      };
    });

    return renderSessionMessagesForUserSurface(transcriptItems, piiReadContext).map((item) =>
      normalizeTranscriptItem(item),
    );
  } catch (err) {
    log.error('Failed to fetch transcript backfill', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
    return [];
  }
}

// =============================================================================
// HELPERS (exported for use in fan-out)
// =============================================================================

/**
 * Get current participants for a session.
 * Delegates to participant registry.
 */
export async function getSessionParticipants(sessionId: string): Promise<Participant[]> {
  return participantRegistry.getParticipants(sessionId);
}

/**
 * Check if a session has an active live sync.
 */
export async function isLiveSyncActive(
  tenantId: string,
  projectId: string,
  contactId: string,
  sessionId: string,
): Promise<boolean> {
  const activeSid = await participantRegistry.getLiveSession(tenantId, projectId, contactId);
  return activeSid === sessionId;
}
