import { getChannelManifest } from '../../channels/manifest.js';
import { DEFAULT_FILLER_CONFIG, DEFAULT_VOICE_PIPELINE_FILLER_CONFIG } from './types.js';
import type { FillerConfig } from './types.js';

/**
 * Resolves FillerConfig for a session based on channel type.
 *
 * - 'none' channels (voice_realtime, voice_vxml): returns enabled:false — no
 *   mid-flight filler injection possible (realtime S2S / sync VXML responses).
 * - 'voice_pipeline' channels: returns voice defaults with the 500ms delay gate and
 *   lower maxPerTurn (TTS synthesis adds latency; fewer fillers tolerated).
 * - 'chat' channels and unknown/undefined types: returns chat defaults.
 *
 * Future: when DSL compiler lands, signature extends to
 * resolveFillerConfig(channelType, ir?: FillerConfigIR) for per-agent overrides.
 */
export function resolveFillerConfig(channelType: string | undefined): FillerConfig {
  const manifest = channelType ? getChannelManifest(channelType) : undefined;
  const fillerMode = manifest?.fillerMode ?? 'chat';

  switch (fillerMode) {
    case 'none':
      return { ...DEFAULT_FILLER_CONFIG, enabled: false };
    case 'voice_pipeline':
      return DEFAULT_VOICE_PIPELINE_FILLER_CONFIG;
    case 'chat':
      return DEFAULT_FILLER_CONFIG;
    default: {
      // TypeScript compile error here if a new ChannelFillerMode value is added without a case
      const _exhaustive: never = fillerMode;
      void _exhaustive;
      return DEFAULT_FILLER_CONFIG;
    }
  }
}
