/**
 * Transcript Fan-Out — Live Session Transcript Sync
 *
 * After a message is persisted during a live session, this module
 * fans out the transcript item to all attached participants via WebSocket.
 *
 * Uses the WebSocketConnectionRegistry to find all connections for a session,
 * then sends a `transcript_item` message with the sequence number.
 */

import { createLogger } from '@abl/compiler/platform';
import type { WebSocketConnectionRegistry } from '../../websocket/connection-registry.js';
import type { TranscriptItem, Participant } from './types.js';
import { ServerMessages, serializeServerMessage } from '../../websocket/events.js';

const log = createLogger('omnichannel-transcript-fanout');

/** Singleton reference to the connection registry — set at startup */
let _registry: WebSocketConnectionRegistry | null = null;

/**
 * Initialize the fan-out module with the connection registry.
 * Must be called once at server startup.
 */
export function initTranscriptFanout(registry: WebSocketConnectionRegistry): void {
  _registry = registry;
}

/**
 * Fan out a transcript item to all connections for a session.
 * Sends a `transcript_item` WS message to each connected participant.
 *
 * This is a fire-and-forget operation — errors are logged but never thrown.
 *
 * @param sessionId - The session to fan out to
 * @param item - The transcript item to broadcast
 */
export function fanOutTranscriptItem(sessionId: string, item: TranscriptItem): void {
  if (!_registry) {
    log.warn('Transcript fan-out not initialized — skipping', { sessionId });
    return;
  }

  try {
    const startMs = Date.now();
    const connections = _registry.getConnectionsForSession(sessionId);
    if (connections.length === 0) return;

    const message = serializeServerMessage(ServerMessages.transcriptItem(item));

    let sent = 0;
    for (const ws of connections) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(message);
        sent++;
      }
    }

    if (sent > 0) {
      const durationMs = Date.now() - startMs;
      log.debug('Transcript item fanned out', {
        sessionId,
        sent,
        sequence: item.sequence,
        fanOutDurationMs: durationMs,
      });
    }
  } catch (err) {
    log.error('Transcript fan-out failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
    });
  }
}

/**
 * Fan out a participant event to all connections for a session.
 * Used for `participant_attached` and `participant_detached` events.
 */
export function fanOutParticipantEvent(
  sessionId: string,
  eventType: 'participant_attached' | 'participant_detached',
  participant: Participant,
): void {
  if (!_registry) return;

  try {
    const connections = _registry.getConnectionsForSession(sessionId);
    if (connections.length === 0) return;

    const message = serializeServerMessage(
      ServerMessages.participantEvent(eventType, sessionId, participant),
    );

    for (const ws of connections) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(message);
      }
    }
  } catch (err) {
    log.error('Participant event fan-out failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
      eventType,
    });
  }
}
