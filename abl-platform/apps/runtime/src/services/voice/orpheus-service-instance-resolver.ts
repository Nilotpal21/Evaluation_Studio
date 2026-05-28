import { createLogger } from '@abl/compiler/platform';
import { ORPHEUS_DEFAULT_MODEL, ORPHEUS_DEFAULT_VOICE } from './orpheus-tts.js';
import { VoiceServiceFactory } from './voice-service-factory.js';
import { getEncryptionService, isEncryptionAvailable } from '@agent-platform/shared/encryption';

const log = createLogger('orpheus-service-instance-resolver');

export interface OrpheusResolvedServiceConfig {
  apiKey: string | null;
  model: string;
  voice: string;
  serviceInstanceId?: string;
  source: 'tenant' | 'environment';
}

export interface ResolveOrpheusServiceConfigInput {
  tenantId?: string;
  serviceInstanceId?: string;
  requestedModel?: string;
  requestedVoice?: string;
}

function resolveEnvApiKey(): string | null {
  const value = (process.env.ORPHEUS_GROQ_API_KEY || process.env.GROQ_API_KEY || '').trim();
  return value.length > 0 ? value : null;
}

export async function resolveOrpheusServiceConfig(
  input: ResolveOrpheusServiceConfigInput,
): Promise<OrpheusResolvedServiceConfig> {
  const fallback = {
    apiKey: resolveEnvApiKey(),
    model: input.requestedModel || process.env.ORPHEUS_TTS_MODEL || ORPHEUS_DEFAULT_MODEL,
    voice: input.requestedVoice || process.env.ORPHEUS_TTS_VOICE || ORPHEUS_DEFAULT_VOICE,
    source: 'environment' as const,
  };

  if (!input.tenantId) {
    return fallback;
  }

  try {
    const encryption = isEncryptionAvailable() ? getEncryptionService() : null;
    const factory = new VoiceServiceFactory(encryption);
    const credentials = await factory.resolveServiceCredentials(input.tenantId, 'custom:orpheus', {
      instanceId: input.serviceInstanceId,
    });

    if (!credentials) {
      return fallback;
    }

    return {
      apiKey: credentials.apiKey,
      model:
        input.requestedModel ||
        (credentials.config?.model as string | undefined) ||
        process.env.ORPHEUS_TTS_MODEL ||
        ORPHEUS_DEFAULT_MODEL,
      voice:
        input.requestedVoice ||
        (credentials.config?.voiceId as string | undefined) ||
        process.env.ORPHEUS_TTS_VOICE ||
        ORPHEUS_DEFAULT_VOICE,
      serviceInstanceId: credentials.instanceId,
      source: 'tenant',
    };
  } catch (err) {
    log.warn('Failed to resolve tenant-scoped Orpheus service config', {
      tenantId: input.tenantId,
      serviceInstanceId: input.serviceInstanceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
