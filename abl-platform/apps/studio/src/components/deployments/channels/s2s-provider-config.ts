import { normalizeOpenAIRealtimeTemperature } from './openai-realtime-temperature';

export const SUPPORTED_STUDIO_S2S_PROVIDER_TYPES = [
  's2s:openai',
  's2s:microsoft',
  's2s:google',
  's2s:grok',
] as const;

export function isSupportedStudioS2SProvider(provider: string): boolean {
  return SUPPORTED_STUDIO_S2S_PROVIDER_TYPES.includes(
    provider as (typeof SUPPORTED_STUDIO_S2S_PROVIDER_TYPES)[number],
  );
}

const S2S_PROVIDER_OWNED_FIELDS = [
  's2sModel',
  's2sVoice',
  's2sTemperature',
  's2sThreshold',
  's2sStartSensitivity',
  's2sEndSensitivity',
  's2sTurnDetection',
  's2sSilenceDuration',
  's2sPrefixPadding',
  's2sAgentId',
  's2sConversationId',
] as const;

const OPENAI_DEFAULT_MODEL = 'gpt-realtime-1.5';
const OPENAI_DEFAULT_VOICE = 'marin';
const AZURE_OPENAI_DEFAULT_VOICE = 'marin';
const GOOGLE_DEFAULT_MODEL = 'gemini-2.0-flash-exp';
const GOOGLE_DEFAULT_VOICE = 'Puck';
const GOOGLE_DEFAULT_START_SENSITIVITY = 'START_SENSITIVITY_UNSPECIFIED';
const GOOGLE_DEFAULT_END_SENSITIVITY = 'END_SENSITIVITY_UNSPECIFIED';
const GOOGLE_DEFAULT_SILENCE_DURATION = 100;
const GOOGLE_DEFAULT_PREFIX_PADDING = 20;
const GROK_DEFAULT_MODEL = 'grok-2-1212';
const GROK_DEFAULT_VOICE = 'ara';

const OPENAI_VOICES = new Set([
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
]);

const GOOGLE_VOICES = new Set([
  'Puck',
  'Kore',
  'Charon',
  'Aoede',
  'Fenrir',
  'Achernar',
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Autonoe',
  'Callirrhoe',
  'Despina',
  'Enceladus',
  'Erinome',
  'Gacrux',
  'Iapetus',
  'Laomedeia',
  'Leda',
  'Orus',
  'Pulcherrima',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Sulafat',
  'Umbriel',
  'Vindemiatrix',
  'Zephyr',
  'Zubenelgenubi',
]);

const GOOGLE_START_SENSITIVITIES = new Set([
  'START_SENSITIVITY_UNSPECIFIED',
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH',
]);

const GOOGLE_END_SENSITIVITIES = new Set([
  'END_SENSITIVITY_UNSPECIFIED',
  'END_SENSITIVITY_LOW',
  'END_SENSITIVITY_HIGH',
]);

const GROK_VOICES = new Set(['ara', 'eve', 'leo', 'rex', 'sal']);

function clampTemperature(value: unknown, min: number, max: number, defaultValue: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, value));
}

function withoutProviderOwnedFields(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  for (const field of S2S_PROVIDER_OWNED_FIELDS) {
    delete next[field];
  }
  return next;
}

function stringOrDefault(value: unknown, defaultValue: string): string {
  return typeof value === 'string' && value.length > 0 ? value : defaultValue;
}

function providerModelOrDefault(
  value: unknown,
  providerToken: string,
  defaultValue: string,
): string {
  const model = stringOrDefault(value, defaultValue);
  return model.toLowerCase().includes(providerToken) ? model : defaultValue;
}

function setValueOrDefault(values: Set<string>, value: unknown, defaultValue: string): string {
  return typeof value === 'string' && values.has(value) ? value : defaultValue;
}

export function normalizeS2SProviderConfig(
  config: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const base = withoutProviderOwnedFields(config);

  switch (provider) {
    case 's2s:openai':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: OPENAI_DEFAULT_MODEL,
        s2sVoice: OPENAI_DEFAULT_VOICE,
        s2sTemperature: normalizeOpenAIRealtimeTemperature(config.s2sTemperature),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: 0.5,
        s2sSilenceDuration: 700,
        s2sPrefixPadding: 300,
      };
    case 's2s:microsoft':
      return {
        ...base,
        s2sProvider: provider,
        s2sVoice: AZURE_OPENAI_DEFAULT_VOICE,
        s2sTemperature: normalizeOpenAIRealtimeTemperature(config.s2sTemperature),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: 0.5,
        s2sSilenceDuration: 700,
        s2sPrefixPadding: 300,
      };
    case 's2s:google':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: GOOGLE_DEFAULT_MODEL,
        s2sVoice: GOOGLE_DEFAULT_VOICE,
        s2sTemperature: clampTemperature(config.s2sTemperature, 0, 2, 1.0),
        s2sStartSensitivity: GOOGLE_DEFAULT_START_SENSITIVITY,
        s2sEndSensitivity: GOOGLE_DEFAULT_END_SENSITIVITY,
        s2sSilenceDuration: GOOGLE_DEFAULT_SILENCE_DURATION,
        s2sPrefixPadding: GOOGLE_DEFAULT_PREFIX_PADDING,
      };
    case 's2s:grok':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: GROK_DEFAULT_MODEL,
        s2sVoice: GROK_DEFAULT_VOICE,
        s2sTemperature: clampTemperature(config.s2sTemperature, 0, 2, 1.0),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: 0.5,
        s2sSilenceDuration: 500,
        s2sPrefixPadding: 300,
      };
    case 's2s:ultravox':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: 'fixie-ai/ultravox-v0.2',
        s2sTemperature: clampTemperature(config.s2sTemperature, 0, 1, 0.8),
      };
    case 's2s:deepgram':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: 'aura-asteria-en',
      };
    case 's2s:elevenlabs':
      return {
        ...base,
        s2sProvider: provider,
      };
    default:
      return {
        ...base,
        s2sProvider: provider,
      };
  }
}

export function normalizeActiveS2SProviderConfig(
  config: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const base = withoutProviderOwnedFields(config);

  switch (provider) {
    case 's2s:openai':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: providerModelOrDefault(config.s2sModel, 'realtime', OPENAI_DEFAULT_MODEL),
        s2sVoice: setValueOrDefault(OPENAI_VOICES, config.s2sVoice, OPENAI_DEFAULT_VOICE),
        s2sTemperature: normalizeOpenAIRealtimeTemperature(config.s2sTemperature),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: clampTemperature(config.s2sThreshold, 0, 1, 0.5),
        s2sSilenceDuration: clampTemperature(config.s2sSilenceDuration, 0, 10000, 700),
        s2sPrefixPadding: clampTemperature(config.s2sPrefixPadding, 0, 5000, 300),
      };
    case 's2s:microsoft':
      return {
        ...base,
        s2sProvider: provider,
        s2sVoice: setValueOrDefault(OPENAI_VOICES, config.s2sVoice, AZURE_OPENAI_DEFAULT_VOICE),
        s2sTemperature: normalizeOpenAIRealtimeTemperature(config.s2sTemperature),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: clampTemperature(config.s2sThreshold, 0, 1, 0.5),
        s2sSilenceDuration: clampTemperature(config.s2sSilenceDuration, 0, 10000, 700),
        s2sPrefixPadding: clampTemperature(config.s2sPrefixPadding, 0, 5000, 300),
      };
    case 's2s:google':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: providerModelOrDefault(config.s2sModel, 'gemini', GOOGLE_DEFAULT_MODEL),
        s2sVoice: setValueOrDefault(GOOGLE_VOICES, config.s2sVoice, GOOGLE_DEFAULT_VOICE),
        s2sTemperature: clampTemperature(config.s2sTemperature, 0, 2, 1.0),
        s2sStartSensitivity: setValueOrDefault(
          GOOGLE_START_SENSITIVITIES,
          config.s2sStartSensitivity,
          GOOGLE_DEFAULT_START_SENSITIVITY,
        ),
        s2sEndSensitivity: setValueOrDefault(
          GOOGLE_END_SENSITIVITIES,
          config.s2sEndSensitivity,
          GOOGLE_DEFAULT_END_SENSITIVITY,
        ),
        s2sSilenceDuration:
          config.s2sSilenceDuration === undefined
            ? GOOGLE_DEFAULT_SILENCE_DURATION
            : clampTemperature(
                config.s2sSilenceDuration,
                0,
                10000,
                GOOGLE_DEFAULT_SILENCE_DURATION,
              ),
        s2sPrefixPadding:
          config.s2sPrefixPadding === undefined
            ? GOOGLE_DEFAULT_PREFIX_PADDING
            : clampTemperature(config.s2sPrefixPadding, 0, 5000, GOOGLE_DEFAULT_PREFIX_PADDING),
      };
    case 's2s:grok':
      return {
        ...base,
        s2sProvider: provider,
        s2sModel: providerModelOrDefault(config.s2sModel, 'grok', GROK_DEFAULT_MODEL),
        s2sVoice: setValueOrDefault(GROK_VOICES, config.s2sVoice, GROK_DEFAULT_VOICE),
        s2sTemperature: clampTemperature(config.s2sTemperature, 0, 2, 1.0),
        s2sTurnDetection: 'server_vad',
        s2sThreshold: clampTemperature(config.s2sThreshold, 0, 1, 0.5),
        s2sSilenceDuration: clampTemperature(config.s2sSilenceDuration, 0, 10000, 500),
        s2sPrefixPadding: clampTemperature(config.s2sPrefixPadding, 0, 5000, 300),
      };
    default:
      return config;
  }
}
