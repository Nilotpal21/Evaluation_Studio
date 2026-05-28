/**
 * Speech Providers API Client
 *
 * Fetches configured speech providers for the current tenant
 * from the service instances endpoint. Used by the voice channel
 * configuration UI to populate ASR/TTS provider dropdowns.
 */

import { apiFetch } from '../lib/api-client';
import {
  isChannelSttVoiceServiceType,
  isChannelTtsVoiceServiceType,
} from '@agent-platform/config/constants/voice-providers';

export interface SpeechProvider {
  id: string;
  serviceType: string;
  displayName: string;
  isDefault: boolean;
  isActive: boolean;
  config?: Record<string, unknown>;
}

export async function fetchConfiguredSpeechProviders(
  tenantId: string,
): Promise<{ stt: SpeechProvider[]; tts: SpeechProvider[] }> {
  const res = await apiFetch(`/api/service-instances?tenantId=${tenantId}&isActive=true`);
  if (!res.ok) return { stt: [], tts: [] };
  const data = await res.json();
  const instances: SpeechProvider[] = data.instances || data.serviceInstances || [];
  const activeInstances = instances.filter((instance) => instance.isActive);

  return {
    stt: activeInstances.filter((instance) => isChannelSttVoiceServiceType(instance.serviceType)),
    tts: activeInstances.filter((instance) => isChannelTtsVoiceServiceType(instance.serviceType)),
  };
}

export interface SpeechVoice {
  name: string;
  value: string;
}

export interface SpeechLanguage {
  code: string;
  name: string;
  voices: SpeechVoice[];
}

export interface SttLanguage {
  code: string;
  name: string;
}

export interface SpeechOptions {
  tts: SpeechLanguage[];
  stt: SttLanguage[];
}

/**
 * Fetch supported languages and voices for a vendor from Jambonz
 * via the runtime proxy.
 */
export async function fetchSpeechOptions(vendor: string): Promise<SpeechOptions> {
  const res = await apiFetch(`/api/speech-options?vendor=${encodeURIComponent(vendor)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch speech options for ${vendor}`);
  }
  const data = await res.json();
  return {
    tts: data.tts || [],
    stt: data.stt || [],
  };
}
