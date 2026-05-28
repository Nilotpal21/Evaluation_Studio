/**
 * LiveKit Worker Entry Point (v1.0)
 *
 * Manages LiveKit voice agent lifecycle using the in-process model.
 * Instead of forking child processes (which breaks tsx dev mode and cross-process
 * adapter registry), agents run directly in the runtime server process.
 *
 * spawnAgentForRoom() is called by the token endpoint (routes/livekit.ts)
 * after generating a participant token. It creates a Room connection,
 * an AgentSession with STT/TTS/VAD, and a RuntimeBridgeAgent that routes
 * all LLM calls through RuntimeExecutor.
 *
 * Exports:
 * - startLiveKitWorker() — validate config, mark worker as ready
 * - stopLiveKitWorker()  — graceful shutdown (dispose all agents + adapters)
 * - isLiveKitWorkerRunning() — health probe
 * - activeRoomCount()    — concurrency tracking for rate-limit in routes
 * - spawnAgentForRoom()  — start an agent in a specific room
 * - registerAdapter() / unregisterAdapter() — adapter lifecycle (called by agent-worker)
 */

import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../../../config/index.js';
import type { RuntimeLLMAdapter } from './runtime-llm-adapter.js';
import type { ActiveAgentConnection, RoomMetadata } from './agent-worker.js';
import type { VoiceServiceFactory } from '../voice-service-factory.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('livekit-worker');

// =============================================================================
// STATE
// =============================================================================

let workerRunning = false;
let voiceFactory: VoiceServiceFactory | null = null;

/**
 * Inject the VoiceServiceFactory so agent-worker can resolve tenant credentials.
 * Called from server.ts after factory initialization.
 */
export function setVoiceServiceFactory(factory: VoiceServiceFactory): void {
  voiceFactory = factory;
}

/** Active adapters keyed by room name — enables concurrency tracking + cleanup */
const activeAdapters = new Map<string, RuntimeLLMAdapter>();

/** Active agent connections keyed by room name — for graceful shutdown of sessions + rooms */
const activeConnections = new Map<string, ActiveAgentConnection>();

// =============================================================================
// ADAPTER REGISTRY (P2)
// =============================================================================

/**
 * Register an adapter when an agent joins a room.
 * Called from agent-worker.ts on pipeline start.
 */
export function registerAdapter(roomName: string, adapter: RuntimeLLMAdapter): void {
  activeAdapters.set(roomName, adapter);
  log.debug('Adapter registered', {
    roomName,
    activeRooms: activeAdapters.size,
    sessionId: adapter.getSessionId(),
  });
}

/**
 * Unregister an adapter when a room closes.
 * Called from agent-worker.ts cleanup callback.
 */
export function unregisterAdapter(roomName: string): void {
  activeAdapters.delete(roomName);
  activeConnections.delete(roomName);
  log.debug('Adapter unregistered', {
    roomName,
    activeRooms: activeAdapters.size,
  });
}

/**
 * Current number of active LiveKit rooms (E7, P1 concurrency limit).
 * Used by routes/livekit.ts to enforce maxConcurrentRooms.
 */
export function activeRoomCount(): number {
  return activeAdapters.size;
}

// =============================================================================
// SPAWN AGENT FOR ROOM
// =============================================================================

/**
 * Start a voice agent in a specific LiveKit room.
 * Called by routes/livekit.ts after generating a participant token.
 *
 * This is the v1.0 replacement for the v0.4 forked-process dispatch model.
 * The agent runs in-process using voice.Agent + AgentSession + @livekit/rtc-node Room.
 */
export async function spawnAgentForRoom(roomName: string, metadata: RoomMetadata): Promise<void> {
  if (!workerRunning) {
    throw new AppError('LiveKit worker not running', { ...ErrorCodes.SERVICE_UNAVAILABLE });
  }

  // Prevent duplicate agents in the same room
  if (activeConnections.has(roomName)) {
    log.warn('Agent already active in room, skipping spawn', { roomName });
    return;
  }

  const config = getConfig();
  const lk = config.voice.livekit;

  try {
    const { startAgentInRoom } = await import('./agent-worker.js');

    const connection = await startAgentInRoom(
      {
        livekitUrl: lk.url!,
        apiKey: lk.apiKey!,
        apiSecret: lk.apiSecret!,
      },
      roomName,
      metadata,
      voiceFactory,
    );

    activeConnections.set(roomName, connection);

    log.info('Agent spawned in room', {
      roomName,
      sessionId: metadata.sessionId,
      projectId: metadata.projectId,
      activeRooms: activeAdapters.size,
    });
  } catch (error) {
    log.error('Failed to spawn agent in room', {
      roomName,
      error: error instanceof Error ? error.message : String(error),
      sessionId: metadata.sessionId,
      projectId: metadata.projectId,
    });
    throw error;
  }
}

// =============================================================================
// WORKER LIFECYCLE
// =============================================================================

/**
 * Start the LiveKit agent worker.
 * Validates configuration and marks the worker as ready to accept room spawns.
 */
export async function startLiveKitWorker(): Promise<void> {
  if (workerRunning) {
    log.warn('LiveKit worker already running');
    return;
  }

  const config = getConfig();
  const lk = config.voice.livekit;

  if (!lk.url || !lk.apiKey || !lk.apiSecret) {
    throw new AppError(
      'LiveKit not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET',
      { ...ErrorCodes.SERVICE_UNAVAILABLE },
    );
  }

  log.info('Starting LiveKit agent worker (in-process model)', { url: lk.url });

  workerRunning = true;

  log.info('LiveKit agent worker ready', { url: lk.url });
}

/**
 * Graceful shutdown: close all agent sessions, disconnect rooms,
 * dispose all active adapters, mark worker as stopped (E4, P5).
 * Called from server.ts shutdown handler.
 */
export async function stopLiveKitWorker(): Promise<void> {
  if (!workerRunning) return;

  log.info('Stopping LiveKit worker', { activeRooms: activeAdapters.size });

  // Close all active agent connections (sessions + rooms + adapters)
  const cleanupPromises: Promise<void>[] = [];
  for (const [roomName, connection] of activeConnections) {
    cleanupPromises.push(
      connection.cleanup().catch((err) => {
        log.warn('Error during agent cleanup on shutdown', {
          roomName,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }
  await Promise.allSettled(cleanupPromises);

  // Dispose any remaining adapters not tracked via connections
  const remainingDisposePromises: Promise<void>[] = [];
  for (const [roomName, adapter] of activeAdapters) {
    remainingDisposePromises.push(
      adapter.dispose().catch((err) => {
        log.warn('Error disposing adapter during shutdown', {
          roomName,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }
  await Promise.allSettled(remainingDisposePromises);

  activeAdapters.clear();
  activeConnections.clear();

  workerRunning = false;
  log.info('LiveKit worker stopped');
}

/**
 * Check if the LiveKit worker is running (health probe, E3).
 */
export function isLiveKitWorkerRunning(): boolean {
  return workerRunning;
}
