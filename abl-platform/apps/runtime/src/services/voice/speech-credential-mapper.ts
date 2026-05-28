import {
  getSensitiveVoiceConfigKeys,
  getSpeechProviderRole,
  type VoiceServiceType,
} from '@agent-platform/config/constants/voice-providers';
import type { SpeechCredentialInput } from './jambonz-provisioning.service.js';

export interface VoiceServiceCredentialSnapshot {
  apiKey: string;
  config?: Record<string, unknown>;
}

const DEFAULT_MODEL_IDS: Partial<Record<VoiceServiceType, string>> = {
  deepgram: 'nova-3',
  cartesia: 'ink-whisper',
  openai: 'whisper-1',
};
const AZURE_SPEECH_RECOGNITION_PATH = '/speech/recognition/interactive/cognitiveservices/v1';

function tenantLabel(tenantId: string): string {
  return `t:${tenantId}`;
}

function readString(config: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function buildElevenLabsCredentialOptions(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const stability = readNumber(config, 'stability');
  const similarityBoost = readNumber(config, 'similarityBoost');
  const style = readNumber(config, 'style');
  const useSpeakerBoost = readBoolean(config, 'useSpeakerBoost');

  if (stability !== undefined) options.stability = stability;
  if (similarityBoost !== undefined) options.similarity_boost = similarityBoost;
  if (style !== undefined) options.style = style;
  if (useSpeakerBoost !== undefined) options.use_speaker_boost = useSpeakerBoost;

  return options;
}

function resolveSpeechCredentialModelId(
  serviceType: string,
  config: Record<string, unknown>,
): string | undefined {
  if (serviceType === 'cartesia') {
    return readString(config, 'sttModelId') ?? DEFAULT_MODEL_IDS.cartesia;
  }
  return (
    readString(config, 'modelId', 'model') ?? DEFAULT_MODEL_IDS[serviceType as VoiceServiceType]
  );
}

function isAzureSpeechRecognitionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname.endsWith('.stt.speech.microsoft.com') &&
      url.pathname === AZURE_SPEECH_RECOGNITION_PATH
    );
  } catch {
    return false;
  }
}

function buildAzureSpeechRecognitionUrl(
  region: string | undefined,
  endpointId: string | undefined,
  explicitUrl: string | undefined,
): string | undefined {
  if (explicitUrl && isAzureSpeechRecognitionUrl(explicitUrl)) {
    return explicitUrl;
  }

  if (!region || !endpointId) {
    return explicitUrl;
  }

  const normalizedRegion = region.toLowerCase();
  return `https://${normalizedRegion}.stt.speech.microsoft.com${AZURE_SPEECH_RECOGNITION_PATH}?cid=${encodeURIComponent(endpointId)}`;
}

export function sanitizeVoiceServiceConfig(
  serviceType: string,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!config) return undefined;

  const sensitiveKeys = new Set(getSensitiveVoiceConfigKeys(serviceType));
  const sanitizedEntries = Object.entries(config).filter(([key]) => !sensitiveKeys.has(key));

  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

export function buildSpeechCredentialInput(
  serviceType: string,
  snapshot: VoiceServiceCredentialSnapshot,
  tenantId: string,
): SpeechCredentialInput {
  const role = getSpeechProviderRole(serviceType);
  if (!role) {
    throw new Error(`Speech role missing for provider ${serviceType}`);
  }

  const config = snapshot.config ?? {};
  const baseInput: SpeechCredentialInput = {
    vendor: serviceType,
    label: tenantLabel(tenantId),
    useForStt: role.useForStt,
    useForTts: role.useForTts,
  };

  switch (serviceType) {
    case 'google':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: resolveSpeechCredentialModelId(serviceType, config),
      };
    case 'aws': {
      const primaryValue = snapshot.apiKey.trim();
      const roleArn = readString(config, 'roleArn');
      const inferredRoleArn = primaryValue.startsWith('arn:') ? primaryValue : undefined;
      return {
        ...baseInput,
        apiKey: inferredRoleArn ? undefined : primaryValue,
        roleArn: roleArn ?? inferredRoleArn,
        secretAccessKey: readString(config, 'secretAccessKey'),
        awsRegion: readString(config, 'awsRegion'),
      };
    }
    case 'microsoft': {
      const region = readString(config, 'region');
      const customSttEndpoint = readString(config, 'customSttEndpointId', 'customSttEndpoint');
      const customSttEndpointUrl = buildAzureSpeechRecognitionUrl(
        region,
        customSttEndpoint,
        readString(config, 'customSttEndpointUrl'),
      );
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        region,
        customSttEndpoint,
        customSttEndpointUrl,
      };
    }
    case 'nuance':
      return {
        ...baseInput,
        clientId: snapshot.apiKey,
        secret: readString(config, 'secret'),
        nuanceSttUri: readString(config, 'nuanceSttUri'),
        nuanceTtsUri: readString(config, 'nuanceTtsUri'),
      };
    case 'deepgram':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: resolveSpeechCredentialModelId(serviceType, config),
      };
    case 'gladia':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        region: readString(config, 'region'),
      };
    case 'soniox':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
      };
    case 'cobalt':
      return {
        ...baseInput,
        cobaltServerUri: snapshot.apiKey,
      };
    case 'ibm':
      return {
        ...baseInput,
        sttApiKey: snapshot.apiKey,
        sttRegion: readString(config, 'sttRegion'),
        instanceId: readString(config, 'instanceId'),
      };
    case 'nvidia':
      return {
        ...baseInput,
        rivaServerUri: snapshot.apiKey,
      };
    case 'assemblyai':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        serviceVersion: readString(config, 'serviceVersion') ?? 'v2',
      };
    case 'houndify':
      return {
        ...baseInput,
        clientId: snapshot.apiKey,
        clientKey: readString(config, 'clientKey'),
        userId: readString(config, 'userId'),
        houndifyServerUri: readString(config, 'houndifyServerUri'),
      };
    case 'voxist':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
      };
    case 'cartesia':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: readString(config, 'modelId'),
        sttModelId: resolveSpeechCredentialModelId(serviceType, config),
      };
    case 'playht':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        userId: readString(config, 'userId'),
        voiceEngine: readString(config, 'voiceEngine'),
      };
    case 'elevenlabs': {
      const options = buildElevenLabsCredentialOptions(config);
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: resolveSpeechCredentialModelId(serviceType, config),
        options: Object.keys(options).length > 0 ? options : undefined,
      };
    }
    case 'speechmatics':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        speechmaticsSttUri: readString(config, 'speechmaticsSttUri'),
      };
    case 'openai':
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: resolveSpeechCredentialModelId(serviceType, config),
      };
    case 'verbio':
      return {
        ...baseInput,
        clientId: snapshot.apiKey,
        clientSecret: readString(config, 'clientSecret'),
        engineVersion: readString(config, 'engineVersion'),
      };
    default:
      return {
        ...baseInput,
        apiKey: snapshot.apiKey,
        modelId: resolveSpeechCredentialModelId(serviceType, config),
      };
  }
}
