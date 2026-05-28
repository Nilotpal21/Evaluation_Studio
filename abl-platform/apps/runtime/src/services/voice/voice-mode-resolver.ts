/**
 * Voice Mode Resolver
 *
 * Centralized resolution of voice mode (pipeline vs realtime).
 * Priority chain:
 * 1. Deployment explicit voice config (highest)
 * 2. S2S provider explicitly configured with valid credentials
 * 3. Agent voice_optimized hint + tenant has realtime model
 * 4. Global voice.mode config
 * 5. Default: 'pipeline'
 *
 * Feature-flagged: returns 'pipeline' when REALTIME_VOICE_ENABLED=false.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

const log = createLogger('voice-mode-resolver');

export type VoiceMode = 'pipeline' | 'realtime';

export interface VoiceModeContext {
  tenantId?: string;
  deploymentVoiceConfig?: {
    mode?: 'pipeline' | 'realtime' | 'auto';
    provider?: string;
  };
  agentIR?: AgentIR;
  globalConfig?: {
    voice?: {
      mode?: 'pipeline' | 'realtime' | 'auto';
      realtime?: { enabled?: boolean };
    };
  };
  tenantHasRealtimeModel?: boolean;
}

/**
 * Check if the realtime voice feature flag is enabled.
 */
function isRealtimeVoiceEnabled(ctx: VoiceModeContext): boolean {
  // Environment variable check (highest precedence for kill switch)
  const envFlag = process.env.REALTIME_VOICE_ENABLED;
  if (envFlag !== undefined) {
    return envFlag === 'true' || envFlag === '1';
  }

  // Config check
  if (ctx.globalConfig?.voice?.realtime?.enabled !== undefined) {
    return ctx.globalConfig.voice.realtime.enabled;
  }

  // Default: enabled — realtime is still gated by:
  //   channel config (voicePipeline: 'realtime')
  //   + tenant model (capabilities: ['realtime_voice'])
  //   + valid API key
  // The env var becomes an emergency kill switch only.
  return true;
}

/**
 * Resolve the voice mode for a session.
 */
export function resolveVoiceMode(ctx: VoiceModeContext): VoiceMode {
  // Kill switch: if realtime voice is globally disabled, always use pipeline
  if (!isRealtimeVoiceEnabled(ctx)) {
    return 'pipeline';
  }

  // Priority 1: Deployment explicit config
  if (ctx.deploymentVoiceConfig?.mode) {
    if (ctx.deploymentVoiceConfig.mode === 'realtime') {
      if (!ctx.tenantHasRealtimeModel) {
        log.warn(
          'Deployment requests realtime but tenant has no realtime model, falling back to pipeline',
          {
            tenantId: ctx.tenantId,
          },
        );
        return 'pipeline';
      }
      return 'realtime';
    }
    if (ctx.deploymentVoiceConfig.mode === 'pipeline') {
      return 'pipeline';
    }
    // mode === 'auto': check S2S provider first, then fall through to agent hint
  }

  // Priority 2: S2S provider explicitly configured
  // When user explicitly selects an S2S provider (e.g., OpenAI Realtime, ElevenLabs),
  // use realtime mode regardless of tenantHasRealtimeModel.
  // The credentials will be validated later in the session.
  const s2sProvider = ctx.deploymentVoiceConfig?.provider;
  if (s2sProvider?.startsWith('s2s:')) {
    log.debug('[VOICE_MODE] Using realtime mode for explicit S2S provider', {
      provider: s2sProvider,
      tenantHasRealtimeModel: ctx.tenantHasRealtimeModel,
    });
    return 'realtime';
  }

  // Priority 3: Agent voice_optimized hint + tenant has realtime model
  const isVoiceOptimized = ctx.agentIR?.execution?.hints?.voice_optimized === true;
  if (isVoiceOptimized && ctx.tenantHasRealtimeModel) {
    return 'realtime';
  }

  // Priority 4: Global config
  if (ctx.globalConfig?.voice?.mode) {
    if (ctx.globalConfig.voice.mode === 'realtime') {
      if (!ctx.tenantHasRealtimeModel) {
        return 'pipeline';
      }
      return 'realtime';
    }
    if (ctx.globalConfig.voice.mode === 'pipeline') {
      return 'pipeline';
    }
    // mode === 'auto': same as agent hint check (already done above)
  }

  // Default: pipeline
  return 'pipeline';
}
