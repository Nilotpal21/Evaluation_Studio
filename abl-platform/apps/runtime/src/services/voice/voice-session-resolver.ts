/**
 * Voice Session Resolver
 *
 * Centralized service for resolving voice mode (pipeline vs realtime)
 * and creating the appropriate executor. Both SDK and Twilio handlers
 * call this to avoid duplicated channel lookup, tenant model checks,
 * and credential decryption across handlers.
 *
 * Logging strategy:
 * - ONE structured log at the end of every resolution (info or error)
 * - Every log includes the full context: sessionId, tenantId, channelId, reason
 * - Handlers do NOT re-log the resolution result — they only log their own actions
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type {
  RealtimeProviderType,
  RealtimeAudioFormat,
} from '@abl/compiler/platform/llm/realtime/types.js';
import { createRealtimeSession } from '@abl/compiler/platform/llm/realtime/index.js';
import type { RuntimeSession } from '../execution/types.js';
import {
  RealtimeVoiceExecutor,
  type RealtimeVoiceExecutorConfig,
} from './realtime-voice-executor.js';
import { findDefaultTenantModelForVoice } from '../../repos/llm-resolution-repo.js';
import type { VoiceParityFamily } from './voice-dsl-parity.js';
import {
  resolveVoiceSemanticConvergencePlan,
  type VoiceSemanticConvergencePlan,
} from './voice-semantic-convergence.js';

const log = createLogger('voice-session-resolver');

// =============================================================================
// TYPES
// =============================================================================

export interface VoiceResolutionContext {
  tenantId?: string;
  projectId?: string;
  channelId?: string;
  deploymentId?: string;
  agentIR?: AgentIR;
  runtimeSession?: RuntimeSession;
  audioFormat?: RealtimeAudioFormat;
  sampleRate?: number;
  sessionId: string;
  toolExecutor?: RealtimeVoiceExecutorConfig['toolExecutor'];
  voiceTurnExecutor?: RealtimeVoiceExecutorConfig['voiceTurnExecutor'];
  semanticFamily?: VoiceParityFamily;
}

export interface ResolvedVoiceSession {
  mode: 'pipeline' | 'realtime';
  executor?: RealtimeVoiceExecutor;
  providerType?: RealtimeProviderType;
  reason: string;
  /**
   * Set when the admin explicitly configured 'realtime' but it can't be
   * fulfilled. Callers should surface this to the client as a voice_error
   * rather than silently falling back to pipeline.
   */
  error?: string;
  semanticConvergence?: VoiceSemanticConvergencePlan;
}

// =============================================================================
// RESOLVER
// =============================================================================

/**
 * Resolve voice mode and optionally create a RealtimeVoiceExecutor.
 *
 * Centralizes:
 * - Channel config lookup (voicePipeline setting)
 * - Voice mode resolution (feature flags, deployment config, agent hints)
 * - Tenant model lookup + credential decryption
 * - Realtime session + executor creation
 */
export async function resolveVoiceSession(
  ctx: VoiceResolutionContext,
): Promise<ResolvedVoiceSession> {
  // Consistent context for every log in this function
  const logCtx = {
    sessionId: ctx.sessionId,
    tenantId: ctx.tenantId,
    channelId: ctx.channelId,
    projectId: ctx.projectId,
  };

  // =========================================================================
  // 1. Load channel config for voicePipeline setting
  // =========================================================================
  let channelVoicePipeline: 'pipeline' | 'realtime' | 'auto' | undefined;

  if (ctx.channelId && ctx.projectId && ctx.tenantId) {
    try {
      const { findSDKChannelById } = await import('../../repos/channel-repo.js');
      const channel = await findSDKChannelById(ctx.channelId, ctx.projectId, ctx.tenantId);
      if (channel?.config?.voicePipeline) {
        const pipeline = channel.config.voicePipeline;
        if (pipeline === 'pipeline' || pipeline === 'realtime' || pipeline === 'auto') {
          channelVoicePipeline = pipeline;
        }
      }
    } catch {
      // Channel lookup is best-effort — logged in the final outcome if it matters
    }
  }

  // Whether realtime was *explicitly* requested by the admin (not 'auto')
  const explicitRealtime = channelVoicePipeline === 'realtime';

  // =========================================================================
  // 2. Resolve voice mode via VoiceServiceFactory
  // =========================================================================
  let resolvedMode: 'pipeline' | 'realtime';

  try {
    const { VoiceServiceFactory } = await import('./voice-service-factory.js');
    const factory = new VoiceServiceFactory();

    resolvedMode = await factory.resolveVoiceMode({
      tenantId: ctx.tenantId,
      deploymentVoiceConfig: channelVoicePipeline ? { mode: channelVoicePipeline } : undefined,
      agentIR: ctx.agentIR,
    });
  } catch (err) {
    return finish(
      'pipeline',
      'resolution_error',
      explicitRealtime
        ? `Voice mode resolution failed: ${err instanceof Error ? err.message : String(err)}`
        : undefined,
    );
  }

  if (resolvedMode !== 'realtime') {
    return finish('pipeline', 'resolved_as_pipeline');
  }

  // =========================================================================
  // 3. Realtime path: find tenant voice model + decrypt credentials
  // =========================================================================
  if (!ctx.tenantId) {
    return finish(
      'pipeline',
      'no_tenant_for_realtime',
      explicitRealtime ? 'Realtime voice requires a tenant context' : undefined,
    );
  }

  if (!ctx.agentIR) {
    return finish(
      'pipeline',
      'no_agent_ir_for_realtime',
      explicitRealtime ? 'Realtime voice requires an agent to be loaded' : undefined,
    );
  }

  let voiceModel: any;
  try {
    voiceModel = await findDefaultTenantModelForVoice(ctx.tenantId);
  } catch (err) {
    return finish(
      'pipeline',
      'voice_model_lookup_failed',
      explicitRealtime
        ? `Failed to query tenant voice model: ${err instanceof Error ? err.message : String(err)}`
        : undefined,
    );
  }

  if (!voiceModel) {
    return finish(
      'pipeline',
      'no_realtime_model',
      explicitRealtime
        ? 'No TenantModel with realtime_voice capability is configured for this tenant'
        : undefined,
    );
  }

  const primaryConnection = voiceModel.connections?.[0];
  if (!primaryConnection?.encryptedApiKey) {
    return finish(
      'pipeline',
      'no_api_key',
      explicitRealtime
        ? 'Voice model has no API key configured on its primary connection'
        : undefined,
    );
  }

  let apiKey: string;
  try {
    const { decryptForTenantAuto } = await import('@agent-platform/shared/encryption');
    apiKey = await decryptForTenantAuto(primaryConnection.encryptedApiKey, ctx.tenantId);
  } catch (err) {
    return finish(
      'pipeline',
      'api_key_decrypt_failed',
      explicitRealtime
        ? `Failed to decrypt voice model API key: ${err instanceof Error ? err.message : String(err)}`
        : undefined,
    );
  }

  // =========================================================================
  // 4. Determine provider type and create executor
  // =========================================================================
  const providerType = resolveProviderType(voiceModel);

  let session;
  try {
    session = createRealtimeSession(providerType);
  } catch (err) {
    return finish(
      'pipeline',
      'provider_not_registered',
      explicitRealtime
        ? `Realtime provider '${providerType}' is not registered: ${err instanceof Error ? err.message : String(err)}`
        : undefined,
    );
  }

  const realtimeConfig = voiceModel.realtimeConfig || {};
  const capabilityProfile = session.getCapabilityProfile();
  const semanticConvergence = resolveVoiceSemanticConvergencePlan({
    family: ctx.semanticFamily ?? 'sdk_voice_realtime',
    providerCapabilityProfile: capabilityProfile,
    hasCoordinatorExecutor: typeof ctx.voiceTurnExecutor === 'function',
  });

  const executorConfig: RealtimeVoiceExecutorConfig = {
    sessionId: ctx.sessionId,
    agentIR: ctx.agentIR,
    ...(ctx.runtimeSession ? { runtimeSession: ctx.runtimeSession } : {}),
    ...(ctx.toolExecutor ? { toolExecutor: ctx.toolExecutor } : {}),
    ...(ctx.voiceTurnExecutor ? { voiceTurnExecutor: ctx.voiceTurnExecutor } : {}),
    semanticConvergence,
    sessionConfig: {
      model: voiceModel.modelId || 'gpt-realtime-1.5',
      apiKey,
      systemPrompt: '', // Built by executor from agentIR
      voice: realtimeConfig.voice || 'marin',
      audioFormat: ctx.audioFormat || 'pcm16',
      sampleRate: ctx.sampleRate || 24000,
      temperature: voiceModel.temperature ?? 0.8,
      maxResponseTokens: voiceModel.maxTokens ?? 4096,
      turnDetection: realtimeConfig.turnDetection || {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 500,
      },
      ...(realtimeConfig.endpoint && { endpoint: realtimeConfig.endpoint }),
      // Ultravox-specific fields
      ...(realtimeConfig.joinTimeout && { joinTimeout: realtimeConfig.joinTimeout }),
      ...(realtimeConfig.maxDuration && { maxDuration: realtimeConfig.maxDuration }),
      ...(realtimeConfig.languageHint && { languageHint: realtimeConfig.languageHint }),
      ...(realtimeConfig.firstSpeaker && { firstSpeaker: realtimeConfig.firstSpeaker }),
      ...(realtimeConfig.firstSpeakerMessage && {
        firstSpeakerMessage: realtimeConfig.firstSpeakerMessage,
      }),
      ...(realtimeConfig.recordingEnabled != null && {
        recordingEnabled: realtimeConfig.recordingEnabled,
      }),
      ...(realtimeConfig.inactivityMessage && {
        inactivityMessage: realtimeConfig.inactivityMessage,
      }),
      ...(realtimeConfig.timeExceededMessage && {
        timeExceededMessage: realtimeConfig.timeExceededMessage,
      }),
    },
  };

  const executor = new RealtimeVoiceExecutor(session, executorConfig);

  return finish(
    'realtime',
    semanticConvergence.strategy === 'coordinator_tool'
      ? 'realtime_resolved_with_coordinator'
      : 'realtime_resolved',
    undefined,
    executor,
    providerType,
    semanticConvergence,
  );

  // =========================================================================
  // Single exit point — every resolution path goes through here
  // =========================================================================
  function finish(
    mode: 'pipeline' | 'realtime',
    reason: string,
    error?: string,
    exec?: RealtimeVoiceExecutor,
    provider?: RealtimeProviderType,
    convergencePlan?: VoiceSemanticConvergencePlan,
  ): ResolvedVoiceSession {
    const level = error ? 'error' : mode === 'realtime' ? 'info' : 'debug';
    log[level]('Voice session resolved', {
      ...logCtx,
      mode,
      reason,
      channelConfig: channelVoicePipeline ?? 'none',
      explicitRealtime,
      ...(provider && { providerType: provider }),
      ...(convergencePlan && {
        semanticConvergenceMode: convergencePlan.mode,
        semanticConvergenceStrategy: convergencePlan.strategy,
        semanticConvergenceFamily: convergencePlan.family,
        semanticConvergenceReason: convergencePlan.reason,
      }),
      ...(error && { error }),
    });
    return {
      mode,
      reason,
      error,
      executor: exec,
      providerType: provider,
      semanticConvergence: convergencePlan,
    };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Determine the realtime provider type from the TenantModel config.
 */
function resolveProviderType(voiceModel: any): RealtimeProviderType {
  // Normalize provider type — DB may store short names like 'gemini' or 'openai'
  // but the registry expects 'gemini_live' or 'openai_realtime'.
  const raw = (voiceModel.realtimeConfig?.providerType || voiceModel.provider || '').toLowerCase();

  if (raw.includes('ultravox') || raw.includes('fixie')) {
    return 'ultravox';
  }
  if (raw.includes('gemini') || raw.includes('google')) {
    return 'gemini_live';
  }
  if (raw.includes('openai') || raw.includes('gpt')) {
    return 'openai_realtime';
  }

  // If it's already a valid registry key, use it directly
  if (raw === 'gemini_live' || raw === 'openai_realtime' || raw === 'ultravox') {
    return raw as RealtimeProviderType;
  }

  return 'openai_realtime';
}
