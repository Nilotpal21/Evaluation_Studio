/**
 * LiveKit Voice Integration
 *
 * Barrel exports for the LiveKit-based voice pipeline.
 */

export {
  RuntimeLLMAdapter,
  type LLMAdapterOptions,
  type ChatResponse,
} from './runtime-llm-adapter.js';
export {
  startAgentInRoom,
  findLastUserMessage,
  createTextStream,
  parseAndValidateMetadata,
  type AgentWorkerConfig,
  type RoomMetadata,
  type ActiveAgentConnection,
} from './agent-worker.js';
export {
  startLiveKitWorker,
  stopLiveKitWorker,
  isLiveKitWorkerRunning,
  activeRoomCount,
  spawnAgentForRoom,
  registerAdapter,
  unregisterAdapter,
} from './worker-entry.js';
export {
  traceLiveKitTurnStart,
  traceLiveKitSTT,
  traceLiveKitLLMStart,
  traceLiveKitLLMEnd,
  traceLiveKitTTSStart,
  traceLiveKitTTSFirstChunk,
  traceLiveKitTTSEnd,
  traceLiveKitTurnComplete,
  traceLiveKitTurnFailed,
} from './livekit-trace-hooks.js';
