/**
 * LiveKit Agent Worker (v1.0)
 *
 * Defines the LiveKit voice agent using v1.0's voice.Agent + AgentSession API.
 * The agent's llmNode is overridden to route ALL LLM calls through RuntimeExecutor,
 * keeping LiveKit responsible only for WebRTC plumbing (STT/TTS/VAD/barge-in).
 *
 * Architecture (in-process model):
 * - No forked child processes. The agent runs embedded in the runtime server process.
 * - startAgentInRoom() creates a Room (via @livekit/rtc-node), an AgentSession,
 *   and a RuntimeBridgeAgent, then joins the room and starts the voice pipeline.
 * - Called from worker-entry.ts spawnAgentForRoom() which is triggered by the
 *   token endpoint after generating a participant token.
 *
 * Security:
 * - Participant metadata validated before use (S6)
 * - tenantId is server-authoritative (set by token route, not by participant)
 *
 * Observability:
 * - Full voice-trace integration via livekit-trace-hooks (A1)
 * - Adapter registry for global tracking and shutdown (P2)
 *
 * NOTE: This module uses dynamic imports for all @livekit/* packages since they
 * are optional dependencies. The worker is only started when FEATURE_LIVEKIT_ENABLED=true.
 * All LiveKit types are `any` to avoid requiring type declarations at build time.
 */

import { createLogger } from '@abl/compiler/platform';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import { RuntimeLLMAdapter } from './runtime-llm-adapter.js';
import { registerAdapter, unregisterAdapter } from './worker-entry.js';
import {
  traceLiveKitTurnStart,
  traceLiveKitSTT,
  traceLiveKitLLMStart,
  traceLiveKitLLMEnd,
  traceLiveKitTTSStart,
  traceLiveKitTurnComplete,
  traceLiveKitTurnFailed,
} from './livekit-trace-hooks.js';
import { ID_PATTERN, AGENT_NAME_PATTERN } from './validation.js';
import { persistMessage, persistTurnMetrics } from '../../../services/message-persistence-queue.js';
import type { VoiceServiceFactory } from '../voice-service-factory.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import type { CallerContext } from '@agent-platform/shared-auth';
import { getChannelAdapterRegistry } from '../../channel/channel-adapter.js';
import { coerceSessionMetadata } from '../../session-metadata.js';
import { buildPersistedMessageStructuredContent } from '../../session/persisted-message-content.js';

const log = createLogger('livekit-agent-worker');

/**
 * EagerEndOfTurn threshold for LiveKit Flux pipeline.
 * Triggers PREFLIGHT_TRANSCRIPT events so the LLM can start pre-warming before
 * the turn fully ends. Safe in LiveKit because AgentSession handles preemptive
 * generation natively — unlike KoreVG where EagerEndOfTurn caused duplicate
 * verb:hook callbacks (see deepgram-models.ts for KoreVG reasoning).
 */
const LIVEKIT_EAGER_EOT_THRESHOLD = 0.4;
const LIVEKIT_DEFAULT_MIN_ENDPOINTING_DELAY_MS = 500;
const LIVEKIT_DEFAULT_MAX_ENDPOINTING_DELAY_MS = 3000;
const LIVEKIT_DEFAULT_MIN_INTERRUPTION_DURATION_MS = 200;
const LIVEKIT_MIN_ENDPOINTING_DELAY_MS = 200;

// =============================================================================
// TYPES
// =============================================================================

export interface AgentWorkerConfig {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface RoomMetadata {
  sessionId: string;
  projectId: string;
  agentName?: string;
  tenantId?: string;
  deploymentId?: string;
  callerContext?: CallerContext;
  sessionMetadata?: Record<string, unknown>;
}

export interface ActiveAgentConnection {
  room: any;
  session: any;
  adapter: RuntimeLLMAdapter;
  cleanup: () => Promise<void>;
}

// =============================================================================
// METADATA VALIDATION (S6)
// =============================================================================

export function parseAndValidateMetadata(raw: string): RoomMetadata | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.sessionId !== 'string' || !ID_PATTERN.test(parsed.sessionId)) return null;
  if (typeof parsed.projectId !== 'string' || !ID_PATTERN.test(parsed.projectId)) return null;

  if (parsed.agentName !== undefined) {
    if (typeof parsed.agentName !== 'string' || !AGENT_NAME_PATTERN.test(parsed.agentName))
      return null;
  }

  if (parsed.tenantId !== undefined) {
    if (typeof parsed.tenantId !== 'string' || !ID_PATTERN.test(parsed.tenantId)) return null;
  }

  return {
    sessionId: parsed.sessionId,
    projectId: parsed.projectId,
    agentName: parsed.agentName,
    tenantId: parsed.tenantId,
    deploymentId: parsed.deploymentId,
    sessionMetadata:
      parsed.sessionMetadata === undefined
        ? undefined
        : coerceSessionMetadata(parsed.sessionMetadata),
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract the last user message text from a v1.0 ChatContext.
 * In v1.0, chatCtx.items contains ChatMessage objects with string roles
 * ('user', 'system', 'assistant', 'tool').
 */
export function findLastUserMessage(chatCtx: any): string | null {
  const items = chatCtx?.items || [];

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role === 'user') {
      if (typeof item.content === 'string') return item.content;
      if (typeof item.textContent === 'string') return item.textContent;
      // ChatContent[] — extract text parts
      if (Array.isArray(item.content)) {
        const texts = item.content
          .filter((c: any) => typeof c === 'string' || c?.type === 'text')
          .map((c: any) => (typeof c === 'string' ? c : c.text));
        return texts.length > 0 ? texts.join(' ') : null;
      }
      return null;
    }
  }
  return null;
}

/**
 * Create a ReadableStream<string> from a single text value.
 * This is what llmNode() returns to feed into the TTS pipeline.
 */
export function createTextStream(text: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

/**
 * Create a ReadableStream<string> that can be filled asynchronously.
 * Returns the stream immediately so TTS can start consuming as chunks arrive.
 * Used by llmNode() to stream LLM responses to TTS without waiting for completion.
 */
export function createChunkedTextStream(): {
  stream: ReadableStream<string>;
  enqueue: (chunk: string) => void;
  close: () => void;
  error: (err: Error) => void;
} {
  let controller: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    enqueue: (chunk) => {
      try {
        controller.enqueue(chunk);
      } catch {
        /* stream already closed */
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        /* stream already closed */
      }
    },
    error: (err) => {
      try {
        controller.error(err);
      } catch {
        /* stream already closed */
      }
    },
  };
}

// =============================================================================
// AGENT FACTORY
// =============================================================================

/**
 * Create a RuntimeBridgeAgent — a voice.Agent subclass that routes all LLM calls
 * through our RuntimeExecutor via the provided adapter.
 *
 * Uses dynamic import to avoid build-time dependency on @livekit/agents.
 */
async function createRuntimeBridgeAgent(
  adapter: RuntimeLLMAdapter,
  publishData: (payload: object) => Promise<void>,
  sessionId: string,
  isFlux: boolean,
): Promise<any> {
  const agents: any = await (import('@livekit/agents' as string) as Promise<any>);
  const { voice } = agents;

  class RuntimeBridgeAgent extends voice.Agent {
    private _adapter: RuntimeLLMAdapter;
    private _publishData: (payload: object) => Promise<void>;
    private _sessionId: string;
    private _isFlux: boolean;
    /** Set by event listeners, read by llmNode for turn timing */
    _userSpeechStartAt: number | null = null;
    _userStoppedSpeakingAt: number | null = null;
    constructor(
      adapterRef: RuntimeLLMAdapter,
      publishDataRef: (payload: object) => Promise<void>,
      sessionIdRef: string,
      isFluxRef: boolean,
    ) {
      // No LLM instructions — RuntimeExecutor handles all agent logic
      super({ instructions: '' });
      this._adapter = adapterRef;
      this._publishData = publishDataRef;
      this._sessionId = sessionIdRef;
      this._isFlux = isFluxRef;
    }

    /**
     * Override llmNode to intercept ALL LLM calls and route them to RuntimeExecutor.
     * Returns a ReadableStream<string> immediately — TTS starts consuming as chunks arrive.
     *
     * Streaming granularity: onChunk fires per-iteration in executeWithTools(),
     * not per-token. This means multi-step flows (tool calls, scripted RESPOND/PROMPT)
     * get each step's text to TTS immediately. Single-turn simple responses still
     * arrive as one chunk.
     */
    async llmNode(
      chatCtx: any,
      _toolCtx: any,
      _modelSettings: any,
    ): Promise<ReadableStream<string> | null> {
      const lastUserMsg = findLastUserMessage(chatCtx);
      if (!lastUserMsg) {
        let noMatchMessage = DEFAULT_MESSAGES.voice_nomatch;
        try {
          noMatchMessage = await this._adapter.resolveSystemMessage(
            'voice_nomatch',
            DEFAULT_MESSAGES.voice_nomatch,
          );
        } catch (error) {
          log.warn('Failed to resolve localized LiveKit no-match message', {
            error: error instanceof Error ? error.message : String(error),
            sessionId: this._sessionId,
          });
        }

        return createTextStream(noMatchMessage);
      }

      // Measure turn timing: from user-stopped-speaking → llmNode called
      const llmNodeAt = Date.now();
      const turnDetectionDelayMs = this._userStoppedSpeakingAt
        ? llmNodeAt - this._userStoppedSpeakingAt
        : null;
      const speechDurationMs =
        this._userSpeechStartAt && this._userStoppedSpeakingAt
          ? this._userStoppedSpeakingAt - this._userSpeechStartAt
          : null;
      const totalSttMs = this._userSpeechStartAt ? llmNodeAt - this._userSpeechStartAt : null;

      log.info('Voice turn timing', {
        sessionId: this._sessionId,
        transcript: lastUserMsg.slice(0, 80),
        speechDurationMs,
        turnDetectionDelayMs,
        totalSttMs,
        isFlux: this._isFlux,
      });
      this._userSpeechStartAt = null;
      this._userStoppedSpeakingAt = null;

      const traceCtx = traceLiveKitTurnStart(this._sessionId, lastUserMsg);
      traceLiveKitSTT(traceCtx, lastUserMsg, 1.0, turnDetectionDelayMs ?? 0);

      const { stream, enqueue, close } = createChunkedTextStream();
      let fullText = '';

      // Background: push chunks as they arrive from RuntimeExecutor
      (async () => {
        try {
          traceLiveKitLLMStart(traceCtx);
          const llmStart = Date.now();

          let chunkCount = 0;
          const response = await this._adapter.chat(lastUserMsg, (chunk) => {
            if (chunk?.trim()) {
              chunkCount++;
              if (chunkCount === 1) {
                log.info('LLM first chunk', {
                  sessionId: this._sessionId,
                  ttftMs: Date.now() - llmStart,
                  chunkLength: chunk.length,
                  preview: chunk.slice(0, 50),
                });
              }
              enqueue(chunk);
              fullText += chunk;
            }
          });

          const llmDurationMs = Date.now() - llmStart;
          log.info('LLM complete', {
            sessionId: this._sessionId,
            durationMs: llmDurationMs,
            totalChunks: chunkCount,
            totalChars: fullText.length,
          });
          traceLiveKitLLMEnd(traceCtx, response.text, llmDurationMs);

          // TTS phase starts when we yield text back to the pipeline
          traceLiveKitTTSStart(traceCtx);

          // Fallback: if onChunk never fired, push full text
          if (!fullText && response.text) {
            const voiceText = getChannelAdapterRegistry().resolve(
              { text: response.text, voiceConfig: response.voiceConfig },
              { channelType: 'voice_livekit' },
            );
            enqueue(voiceText);
            fullText = voiceText;
          }
          close();

          const { breakdown } = traceLiveKitTurnComplete(traceCtx);

          // Publish transcript + timing via data channel
          await this._publishData({
            type: 'transcript',
            userText: lastUserMsg,
            agentText: fullText || response.text,
            timestamp: Date.now(),
          });

          await this._publishData({
            type: 'timing',
            timing: {
              total: breakdown.totalLatency,
              stt: breakdown.sttLatency,
              llm: breakdown.llmLatency,
              tts: breakdown.ttsLatency,
              ttsFirstChunk: breakdown.ttsFirstChunkLatency ?? 0,
            },
          });

          // Persist user + assistant messages to DB for session detail
          const dbSessionId = this._adapter.getDbSessionId();
          if (dbSessionId) {
            const tenantId = this._adapter.getTenantId();
            const projectId = this._adapter.getProjectId();
            persistMessage(
              dbSessionId,
              'user',
              lastUserMsg,
              'voice',
              tenantId,
              undefined,
              undefined,
              projectId,
            ).catch((err: unknown) => log.warn('LiveKit user message persist failed', { err }));
            persistMessage(
              dbSessionId,
              'assistant',
              fullText || response.text,
              'voice',
              tenantId,
              undefined,
              undefined,
              projectId,
              undefined,
              buildPersistedMessageStructuredContent({
                voiceConfig: response.voiceConfig,
              }),
              response.responseMetadata,
            ).catch((err: unknown) =>
              log.warn('LiveKit assistant message persist failed', { err }),
            );
            persistTurnMetrics({
              dbSessionId,
              tenantId,
              tokensIn: response.tokensIn,
              tokensOut: response.tokensOut,
              cost: 0,
              traceEventCount: 1,
              errorCount: 0,
              handoffCount: 0,
            }).catch((err: unknown) => log.warn('LiveKit metrics persist failed', { err }));
          }
        } catch (error) {
          traceLiveKitTurnFailed(traceCtx, error instanceof Error ? error : String(error));

          log.error('RuntimeExecutor error during chat', {
            error: error instanceof Error ? error.message : String(error),
            sessionId: this._sessionId,
          });

          let errorMessage = DEFAULT_MESSAGES.voice_error;
          try {
            errorMessage = await this._adapter.resolveSystemMessage(
              'voice_error',
              DEFAULT_MESSAGES.voice_error,
            );
          } catch (resolveError) {
            log.warn('Failed to resolve localized LiveKit error message', {
              error: resolveError instanceof Error ? resolveError.message : String(resolveError),
              sessionId: this._sessionId,
            });
          }

          enqueue(errorMessage);
          close();
        }
      })();

      return stream; // Returned immediately — TTS starts consuming as chunks arrive
    }
  }

  return new RuntimeBridgeAgent(adapter, publishData, sessionId, isFlux);
}

// =============================================================================
// AGENT LIFECYCLE
// =============================================================================

/**
 * Start a voice agent in a LiveKit room.
 *
 * This is the main entry point called by worker-entry.ts spawnAgentForRoom().
 * It creates a Room connection, initializes the RuntimeLLMAdapter,
 * loads STT/TTS/VAD plugins, creates an AgentSession, and starts the pipeline.
 *
 * Returns an ActiveAgentConnection for lifecycle management.
 */
export async function startAgentInRoom(
  config: AgentWorkerConfig,
  roomName: string,
  metadata: RoomMetadata,
  voiceFactory: VoiceServiceFactory | null,
): Promise<ActiveAgentConnection> {
  log.info('Starting agent in room', {
    room: roomName,
    sessionId: metadata.sessionId,
    projectId: metadata.projectId,
    agentName: metadata.agentName,
    tenantId: metadata.tenantId,
    deploymentId: metadata.deploymentId,
    callerIdentityTier: metadata.callerContext?.identityTier,
    callerChannelId: metadata.callerContext?.channelId,
  });

  // Initialize @livekit/agents logger — required before creating any plugins (STT/TTS/VAD)
  const agents: any = await (import('@livekit/agents' as string) as Promise<any>);
  if (typeof agents.initializeLogger === 'function') {
    agents.initializeLogger({ pretty: false, level: 'warn' });
  }

  // ---------------------------------------------------------------
  // Initialize RuntimeExecutor bridge
  // ---------------------------------------------------------------
  const adapter = new RuntimeLLMAdapter({
    sessionId: metadata.sessionId,
    projectId: metadata.projectId,
    agentName: metadata.agentName,
    tenantId: metadata.tenantId,
    deploymentId: metadata.deploymentId,
    callerContext: metadata.callerContext,
    sessionMetadata: metadata.sessionMetadata,
  });

  try {
    await adapter.initialize();
  } catch (error) {
    log.error('Failed to initialize RuntimeLLMAdapter', {
      error: error instanceof Error ? error.message : String(error),
      projectId: metadata.projectId,
      tenantId: metadata.tenantId,
      room: roomName,
    });
    throw error;
  }

  // Register adapter for concurrency tracking + shutdown (P2)
  registerAdapter(roomName, adapter);

  // ---------------------------------------------------------------
  // Resolve tenant-scoped voice credentials (no env var fallback)
  // ---------------------------------------------------------------
  if (!voiceFactory || !metadata.tenantId) {
    unregisterAdapter(roomName);
    await adapter.dispose();
    throw new AppError(
      'Voice requires tenant-scoped credentials. VoiceServiceFactory or tenantId not available.',
      { ...ErrorCodes.NOT_FOUND },
    );
  }

  const voiceCreds = await voiceFactory.resolveVoiceCredentials(metadata.tenantId);
  if (!voiceCreds.stt) {
    unregisterAdapter(roomName);
    await adapter.dispose();
    throw new AppError(
      'No Deepgram (STT) credentials configured for this tenant. Configure in Workspace Settings > Voice Services.',
      { ...ErrorCodes.NOT_FOUND },
    );
  }
  if (!voiceCreds.tts) {
    unregisterAdapter(roomName);
    await adapter.dispose();
    throw new AppError(
      'No ElevenLabs (TTS) credentials configured for this tenant. Configure in Workspace Settings > Voice Services.',
      { ...ErrorCodes.NOT_FOUND },
    );
  }

  // ---------------------------------------------------------------
  // Generate agent token and connect to room
  // ---------------------------------------------------------------
  let room: any;

  try {
    const sdk: any = await (import('livekit-server-sdk' as string) as Promise<any>);
    const rtc: any = await (import('@livekit/rtc-node' as string) as Promise<any>);

    const agentIdentity = `agent_${roomName.slice(0, 40)}_${Date.now()}`;
    const at = new sdk.AccessToken(config.apiKey, config.apiSecret, {
      identity: agentIdentity,
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const agentToken = await at.toJwt();

    room = new rtc.Room();
    await room.connect(config.livekitUrl, agentToken);

    log.info('Agent connected to room', { room: roomName, identity: agentIdentity });
  } catch (error) {
    log.error('Failed to connect agent to room', {
      error: error instanceof Error ? error.message : String(error),
      room: roomName,
    });
    unregisterAdapter(roomName);
    await adapter.dispose();
    throw error;
  }

  // ---------------------------------------------------------------
  // Load STT, TTS, and VAD plugins dynamically
  // ---------------------------------------------------------------
  let stt: any;
  let tts: any;
  let vad: any;
  let isFlux = false;

  try {
    const deepgramPlugin: any = await (import(
      '@livekit/agents-plugin-deepgram' as string
    ) as Promise<any>);
    const sttModel = voiceCreds.stt.model || 'nova-3';
    isFlux = (await import('@agent-platform/config')).isFluxModel(sttModel);

    if (isFlux) {
      const { FLUX_DEFAULTS } = await import('@agent-platform/config');
      log.info('Creating Deepgram STTv2 for Flux model (tenant-scoped)', {
        room: roomName,
        tenantId: metadata.tenantId,
        model: sttModel,
        eotThreshold: FLUX_DEFAULTS.eotThreshold,
        eagerEotThreshold: LIVEKIT_EAGER_EOT_THRESHOLD,
        eotTimeoutMs: FLUX_DEFAULTS.eotTimeoutMs,
      });
      stt = new deepgramPlugin.STTv2({
        apiKey: voiceCreds.stt.apiKey,
        model: sttModel,
        eotThreshold: FLUX_DEFAULTS.eotThreshold,
        eagerEotThreshold: LIVEKIT_EAGER_EOT_THRESHOLD,
        eotTimeoutMs: FLUX_DEFAULTS.eotTimeoutMs,
      });
    } else {
      log.info('Creating Deepgram STT (tenant-scoped)', {
        room: roomName,
        tenantId: metadata.tenantId,
        model: sttModel,
      });
      stt = new deepgramPlugin.STT({
        apiKey: voiceCreds.stt.apiKey,
        model: sttModel,
        language: 'en',
      });
    }
  } catch (err) {
    log.error('Failed to load Deepgram STT plugin', {
      room: roomName,
      error: err instanceof Error ? err.message : String(err),
    });
    unregisterAdapter(roomName);
    await adapter.dispose();
    await room.disconnect();
    throw err;
  }

  try {
    const elevenLabsPlugin: any = await (import(
      '@livekit/agents-plugin-elevenlabs' as string
    ) as Promise<any>);
    const ttsModel = voiceCreds.tts.model || 'eleven_turbo_v2';
    log.info('Creating ElevenLabs TTS (tenant-scoped)', {
      room: roomName,
      tenantId: metadata.tenantId,
      voiceId: voiceCreds.tts.voiceId || '(default)',
      model: ttsModel,
    });
    tts = new elevenLabsPlugin.TTS({
      apiKey: voiceCreds.tts.apiKey,
      voiceId: voiceCreds.tts.voiceId,
      modelId: ttsModel,
    });
  } catch (err) {
    log.error('Failed to load ElevenLabs TTS plugin', {
      room: roomName,
      error: err instanceof Error ? err.message : String(err),
    });
    unregisterAdapter(roomName);
    await adapter.dispose();
    await room.disconnect();
    throw err;
  }

  // Always load Silero VAD — needed for barge-in/interruption detection.
  // With Flux, VAD handles voice activity while STTv2 handles turn detection.
  try {
    const sileroPlugin: any = await (import(
      '@livekit/agents-plugin-silero' as string
    ) as Promise<any>);
    vad = await sileroPlugin.VAD.load();
  } catch (err) {
    log.warn('Silero VAD plugin not available, proceeding without VAD', { room: roomName });
  }

  // ---------------------------------------------------------------
  // Publish helper — sends data channel messages to client
  // ---------------------------------------------------------------
  const publishData = async (payload: object) => {
    try {
      await room.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
        reliable: true,
      });
    } catch {
      // Non-critical: client may not be listening for data
    }
  };

  // ---------------------------------------------------------------
  // Create v1.0 Agent + AgentSession and start the voice pipeline
  // ---------------------------------------------------------------
  const { voice, llm: llmModule } = agents;

  const agent = await createRuntimeBridgeAgent(adapter, publishData, metadata.sessionId, isFlux);
  const conversationVoiceConfig = adapter.getConversationBehaviorVoiceRuntimeConfig();
  const minEndpointingDelay =
    conversationVoiceConfig.pauseTimeoutMs !== undefined
      ? Math.max(
          LIVEKIT_MIN_ENDPOINTING_DELAY_MS,
          Math.floor(conversationVoiceConfig.pauseTimeoutMs / 2),
        )
      : LIVEKIT_DEFAULT_MIN_ENDPOINTING_DELAY_MS;
  const maxEndpointingDelay =
    conversationVoiceConfig.pauseTimeoutMs ?? LIVEKIT_DEFAULT_MAX_ENDPOINTING_DELAY_MS;
  const livekitVoiceOptions: Record<string, unknown> = {
    ...(isFlux
      ? {
          minEndpointingDelay,
          maxEndpointingDelay,
          minInterruptionDuration: LIVEKIT_DEFAULT_MIN_INTERRUPTION_DURATION_MS,
          preemptiveGeneration: true,
        }
      : conversationVoiceConfig.pauseTimeoutMs !== undefined
        ? {
            minEndpointingDelay,
            maxEndpointingDelay,
          }
        : {}),
    ...(conversationVoiceConfig.bargeIn === false
      ? {
          allowInterruptions: false,
          minInterruptionDuration: Number.MAX_SAFE_INTEGER,
        }
      : conversationVoiceConfig.bargeIn === true
        ? { allowInterruptions: true }
        : {}),
  };

  // PipelineLLM: satisfies the AgentSession pipeline gate (`instanceof LLM` check)
  // so that STT transcripts flow through to our Agent.llmNode() override.
  // The default llmNode() calls LLM.chat() — but our override intercepts first,
  // routing all inference through RuntimeExecutor instead.
  class PipelineLLM extends llmModule.LLM {
    get model() {
      return 'runtime-bridge';
    }
    chat(): any {
      throw new AppError(
        'PipelineLLM.chat() should not be called — llmNode() override handles inference',
        { ...ErrorCodes.INTERNAL_ERROR },
      );
    }
  }

  const session = new voice.AgentSession({
    vad,
    stt,
    tts,
    llm: new PipelineLLM(),
    ...(Object.keys(livekitVoiceOptions).length > 0 ? { voiceOptions: livekitVoiceOptions } : {}),
    ...(isFlux && {
      turnDetection: 'stt',
    }),
  });

  // Register all event listeners BEFORE session.start() to avoid race conditions
  session.on('error', (event: any) => {
    log.warn('AgentSession error (non-fatal)', {
      room: roomName,
      error: event.error?.message || String(event.error),
      source: event.source?.label || 'unknown',
    });
  });

  session.on('user_state_changed', (event: any) => {
    if (event.newState === 'speaking') {
      (agent as any)._userSpeechStartAt = Date.now();
    }
    if (event.oldState === 'speaking' && event.newState === 'listening') {
      (agent as any)._userStoppedSpeakingAt = Date.now();
    }
  });

  // ---------------------------------------------------------------
  // LiveKit pipeline metrics — real STT/TTS/EOU latency from framework
  // ---------------------------------------------------------------
  session.on('metrics_collected', (event: any) => {
    const m = event.metrics;
    switch (m.type) {
      case 'stt_metrics':
        log.debug('STT metrics', {
          room: roomName,
          durationMs: m.durationMs,
          audioDurationMs: m.audioDurationMs,
          streamed: m.streamed,
        });
        break;
      case 'eou_metrics':
        log.debug('EOU metrics (turn detection)', {
          room: roomName,
          endOfUtteranceDelayMs: m.endOfUtteranceDelayMs,
          transcriptionDelayMs: m.transcriptionDelayMs,
          onUserTurnCompletedDelayMs: m.onUserTurnCompletedDelayMs,
        });
        break;
      case 'tts_metrics':
        log.info('TTS metrics', {
          room: roomName,
          ttfbMs: m.ttfbMs,
          durationMs: m.durationMs,
          audioDurationMs: m.audioDurationMs,
          charactersCount: m.charactersCount,
        });
        break;
      case 'llm_metrics':
        log.debug('LLM metrics', {
          room: roomName,
          durationMs: m.durationMs,
          ttftMs: m.ttftMs,
          tokensPerSecond: m.tokensPerSecond,
          promptTokens: m.promptTokens,
          completionTokens: m.completionTokens,
        });
        break;
    }
  });

  await session.start({ room, agent });

  log.info('LiveKit voice pipeline started', {
    room: roomName,
    sessionId: metadata.sessionId,
    projectId: metadata.projectId,
    adapterSessionId: adapter.getSessionId(),
  });

  // ---------------------------------------------------------------
  // Build cleanup function
  // ---------------------------------------------------------------
  const cleanup = async () => {
    log.info('Cleaning up agent in room', {
      room: roomName,
      sessionId: metadata.sessionId,
      durationMs: adapter.getSessionDurationMs(),
    });

    try {
      await session.close();
    } catch (err) {
      log.warn('Error closing AgentSession', {
        room: roomName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await room.disconnect();
    } catch (err) {
      log.warn('Error disconnecting room', {
        room: roomName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    unregisterAdapter(roomName);
    await adapter.dispose();
  };

  return { room, session, adapter, cleanup };
}
