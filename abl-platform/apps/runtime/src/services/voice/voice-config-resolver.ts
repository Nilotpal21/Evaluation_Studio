/**
 * Voice Config Resolver
 *
 * Pure function that resolves TTS configuration from IR and profile overrides.
 * Priority chain: profile override > IR base (execution.voice) > external provisioning (empty).
 * Maps IR field names (provider/voice_id/speed) to voice session params (ttsVendor/ttsVoice/ttsSpeed).
 *
 * IR-gated: returns undefined when no voice config exists in IR or profiles.
 */

import type { AgentIR, VoiceConfigIR } from '@abl/compiler';
import type { EffectiveAgentConfig } from '../execution/profile-resolver.js';

/** Resolved TTS parameters for voice session config */
export interface VoiceParams {
  ttsVendor?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  ttsLanguage?: string;
}

/**
 * Resolve voice TTS config from IR and active profile overrides.
 *
 * Priority:
 * 1. Profile voice override (effectiveConfig.voiceConfig) — highest
 * 2. IR base voice config (ir.execution.voice)
 * 3. External provisioning / connection config — not handled here (caller provides defaults)
 *
 * @returns VoiceParams if any IR-level voice config exists, undefined otherwise
 */
export function resolveVoiceConfig(
  ir: AgentIR | null,
  effectiveConfig: EffectiveAgentConfig | undefined,
): VoiceParams | undefined {
  const profileVoice = effectiveConfig?.voiceConfig;
  const irVoice = ir?.execution?.voice;

  // IR-gated: no voice config at any level → return undefined (caller uses external defaults)
  if (!profileVoice && !irVoice) {
    return undefined;
  }

  // Merge: profile overrides IR base (shallow per-field)
  const merged: VoiceConfigIR = {
    ...irVoice,
    ...profileVoice,
  };

  return mapToVoiceParams(merged);
}

/** Map IR VoiceConfigIR fields to voice session TTS params */
function mapToVoiceParams(voice: VoiceConfigIR): VoiceParams {
  const params: VoiceParams = {};

  if (voice.provider) {
    params.ttsVendor = voice.provider;
  }
  if (voice.voice_id) {
    params.ttsVoice = voice.voice_id;
  }
  if (voice.speed !== undefined) {
    params.ttsSpeed = voice.speed;
  }

  return params;
}
