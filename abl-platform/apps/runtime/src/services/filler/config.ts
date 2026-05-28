import {
  DEFAULT_FILLER_RUNTIME_CONFIG,
  type FillerConfig,
  type ProjectFillerConfig,
  type ResolvedFillerRuntimeConfig,
} from './types.js';

export interface ResolveFillerConfigOptions {
  projectFiller?: ProjectFillerConfig;
  isVoiceChannel: boolean;
  /** Channel-type defaults from resolveFillerConfig (ABLP-710). When provided,
   *  used as timing/capacity base so voice channels get their correct voiceDelayMs,
   *  cooldownMs, and maxPerTurn without relying on hardcoded fallbacks. */
  channelDefaults?: FillerConfig;
}

export function resolveFillerConfig({
  projectFiller,
  isVoiceChannel,
  channelDefaults,
}: ResolveFillerConfigOptions): ResolvedFillerRuntimeConfig {
  const defaults = DEFAULT_FILLER_RUNTIME_CONFIG;
  const timingBase = channelDefaults ?? defaults.serviceConfig;
  // Fillers are useful for both chat and voice, but the runtime quality-gates
  // the emitted text so voice does not fall back to low-context chatter.
  const channelEnabled = isVoiceChannel
    ? projectFiller?.voiceEnabled !== false
    : projectFiller?.chatEnabled !== false;
  const projectVoiceDelayMs = projectFiller?.voiceDelayMs;

  const channelDelayMs = isVoiceChannel
    ? (projectVoiceDelayMs ?? timingBase.voiceDelayMs ?? timingBase.chatDelayMs)
    : (projectFiller?.chatDelayMs ?? timingBase.chatDelayMs);

  return {
    serviceConfig: {
      enabled: (projectFiller?.enabled ?? defaults.serviceConfig.enabled) && channelEnabled,
      chatDelayMs: channelDelayMs,
      voiceDelayMs: projectVoiceDelayMs ?? timingBase.voiceDelayMs,
      cooldownMs: projectFiller?.cooldownMs ?? timingBase.cooldownMs,
      maxPerTurn: projectFiller?.maxPerTurn ?? timingBase.maxPerTurn,
    },
    piggybackEnabled: projectFiller?.piggybackEnabled ?? defaults.piggybackEnabled,
    pipelineGenerationEnabled:
      projectFiller?.pipelineGenerationEnabled ?? defaults.pipelineGenerationEnabled,
    modelSource:
      projectFiller?.modelSource === 'default'
        ? 'system'
        : (projectFiller?.modelSource ?? defaults.modelSource),
    modelId: projectFiller?.modelId,
    tenantModelId: projectFiller?.tenantModelId,
    promptRef: projectFiller?.promptRef,
  };
}
