export type S2SProviderType =
  | 's2s:openai'
  | 's2s:microsoft'
  | 's2s:elevenlabs'
  | 's2s:google'
  | 's2s:deepgram'
  | 's2s:ultravox'
  | 's2s:grok';

export type VoiceServiceType =
  | 'deepgram'
  | 'google'
  | 'aws'
  | 'microsoft'
  | 'nuance'
  | 'gladia'
  | 'soniox'
  | 'cobalt'
  | 'ibm'
  | 'nvidia'
  | 'assemblyai'
  | 'houndify'
  | 'voxist'
  | 'cartesia'
  | 'speechmatics'
  | 'openai'
  | 'verbio'
  | 'rimelabs'
  | 'playht'
  | 'inworld'
  | 'elevenlabs'
  | 'custom:orpheus'
  | 'twilio'
  | 'azure'
  | S2SProviderType;

export type VoiceAdminSurface = 'stt' | 'tts' | 's2s' | null;
export type S2STelephonySupport = 'full' | 'partial' | 'none';

export interface SpeechProviderRole {
  useForStt: boolean;
  useForTts: boolean;
}

export interface VoiceProviderCapabilities {
  adminSurface: VoiceAdminSurface;
  additionalAdminSurfaces?: readonly Exclude<VoiceAdminSurface, null>[];
  runtimeCrud: boolean;
  channelSttSelectable: boolean;
  channelTtsSelectable: boolean;
  channelS2SSelectable: boolean;
  supportsSpeechOptions: boolean;
  supportsTtsPreview: boolean;
  s2sTelephonySupport: S2STelephonySupport;
  speechRole: SpeechProviderRole | null;
}

export interface VoiceProviderDefinition {
  serviceType: VoiceServiceType;
  label: string;
  description: string;
  capabilities: VoiceProviderCapabilities;
}

export const VOICE_PROVIDER_DEFINITIONS = [
  {
    serviceType: 'deepgram',
    label: 'Deepgram Speech',
    description: 'Deepgram credentials for speech recognition and synthesis',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'google',
    label: 'Google Cloud Speech',
    description: 'Google Cloud speech credentials for recognition and synthesis',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'aws',
    label: 'AWS Speech',
    description: 'AWS credentials for Amazon Transcribe and Polly',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'microsoft',
    label: 'Microsoft Speech',
    description: 'Azure / Microsoft Speech credentials for STT and TTS',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'nuance',
    label: 'Nuance Speech',
    description: 'Nuance speech credentials for STT and TTS',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'gladia',
    label: 'Gladia (STT)',
    description: 'Gladia live speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'soniox',
    label: 'Soniox (STT)',
    description: 'Soniox streaming speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'cobalt',
    label: 'Cobalt (STT)',
    description: 'Cobalt on-prem speech recognition server',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'ibm',
    label: 'IBM Watson (STT)',
    description: 'IBM Watson Speech-to-Text credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'nvidia',
    label: 'NVIDIA Riva (STT)',
    description: 'NVIDIA Riva speech recognition server',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'assemblyai',
    label: 'AssemblyAI (STT)',
    description: 'AssemblyAI streaming speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'houndify',
    label: 'Houndify (STT)',
    description: 'Houndify speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'voxist',
    label: 'Voxist (STT)',
    description: 'Voxist speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'cartesia',
    label: 'Cartesia Speech',
    description: 'Cartesia credentials for speech recognition and synthesis',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'speechmatics',
    label: 'Speechmatics (STT)',
    description: 'Speechmatics realtime speech recognition credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'openai',
    label: 'OpenAI STT',
    description: 'OpenAI speech-to-text credentials',
    capabilities: {
      adminSurface: 'stt',
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 'verbio',
    label: 'Verbio Speech',
    description: 'Verbio speech credentials for recognition and synthesis',
    capabilities: {
      adminSurface: 'stt',
      additionalAdminSurfaces: ['tts'],
      runtimeCrud: true,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: true },
    },
  },
  {
    serviceType: 'rimelabs',
    label: 'RimeLabs (TTS)',
    description: 'RimeLabs streaming text-to-speech credentials',
    capabilities: {
      adminSurface: 'tts',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: false, useForTts: true },
    },
  },
  {
    serviceType: 'playht',
    label: 'PlayHT (TTS)',
    description: 'PlayHT text-to-speech credentials',
    capabilities: {
      adminSurface: 'tts',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: false, useForTts: true },
    },
  },
  {
    serviceType: 'inworld',
    label: 'Inworld (TTS)',
    description: 'Inworld text-to-speech credentials',
    capabilities: {
      adminSurface: 'tts',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: false, useForTts: true },
    },
  },
  {
    serviceType: 'elevenlabs',
    label: 'ElevenLabs (TTS)',
    description: 'Text-to-speech synthesis for voice output',
    capabilities: {
      adminSurface: 'tts',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: true,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: false, useForTts: true },
    },
  },
  {
    serviceType: 'custom:orpheus',
    label: 'Orpheus via Groq (TTS)',
    description: 'Expressive custom TTS routed through the platform Orpheus adapter',
    capabilities: {
      adminSurface: 'tts',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: true,
      s2sTelephonySupport: 'none',
      speechRole: null,
    },
  },
  {
    serviceType: 'twilio',
    label: 'Twilio',
    description: 'Telephony provider credentials',
    capabilities: {
      adminSurface: null,
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: false,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: null,
    },
  },
  {
    serviceType: 'azure',
    label: 'Azure',
    description: 'Externally configured Azure speech provider',
    capabilities: {
      adminSurface: null,
      runtimeCrud: false,
      channelSttSelectable: true,
      channelTtsSelectable: true,
      channelS2SSelectable: false,
      supportsSpeechOptions: true,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'none',
      speechRole: { useForStt: true, useForTts: false },
    },
  },
  {
    serviceType: 's2s:openai',
    label: 'OpenAI Realtime',
    description: 'OpenAI Realtime API for speech-to-speech conversations',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'full',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:microsoft',
    label: 'Azure OpenAI Realtime',
    description: 'Azure OpenAI Realtime API for speech-to-speech conversations',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'full',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:elevenlabs',
    label: 'ElevenLabs Conversational AI (S2S)',
    description: 'ElevenLabs voice agents for natural conversations',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'partial',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:google',
    label: 'Google Gemini Live (S2S)',
    description: 'Gemini multimodal voice conversations with low latency',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'full',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:deepgram',
    label: 'Deepgram Voice Agent (S2S)',
    description: 'Deepgram Aura voice agent for realtime conversations',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'partial',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:ultravox',
    label: 'Ultravox (S2S)',
    description: 'Ultravox speech-to-speech with function calling',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'partial',
      speechRole: null,
    },
  },
  {
    serviceType: 's2s:grok',
    label: 'Grok Realtime (S2S)',
    description: 'xAI Grok Realtime API for speech-to-speech conversations',
    capabilities: {
      adminSurface: 's2s',
      runtimeCrud: true,
      channelSttSelectable: false,
      channelTtsSelectable: false,
      channelS2SSelectable: true,
      supportsSpeechOptions: false,
      supportsTtsPreview: false,
      s2sTelephonySupport: 'full',
      speechRole: null,
    },
  },
] as const satisfies readonly VoiceProviderDefinition[];

const VOICE_PROVIDER_LOOKUP = new Map<string, VoiceProviderDefinition>(
  VOICE_PROVIDER_DEFINITIONS.map((provider) => [provider.serviceType, provider]),
);

export const RUNTIME_VOICE_SERVICE_TYPES = VOICE_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.capabilities.runtimeCrud,
).map((provider) => provider.serviceType) as readonly VoiceServiceType[];

export const CHANNEL_STT_PROVIDER_TYPES = VOICE_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.capabilities.channelSttSelectable,
).map((provider) => provider.serviceType) as readonly VoiceServiceType[];

export const CHANNEL_TTS_PROVIDER_TYPES = VOICE_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.capabilities.channelTtsSelectable,
).map((provider) => provider.serviceType) as readonly VoiceServiceType[];

export const S2S_PROVIDER_TYPES = VOICE_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.capabilities.channelS2SSelectable,
).map((provider) => provider.serviceType as S2SProviderType) as readonly S2SProviderType[];

export const TTS_PREVIEW_PROVIDER_TYPES = VOICE_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.capabilities.supportsTtsPreview,
).map((provider) => provider.serviceType) as readonly VoiceServiceType[];

const SENSITIVE_VOICE_CONFIG_KEYS: Partial<Record<VoiceServiceType, readonly string[]>> = {
  aws: ['secretAccessKey'],
  nuance: ['secret'],
  houndify: ['clientKey'],
  verbio: ['clientSecret'],
};

export function getVoiceProviderDefinition(serviceType: string): VoiceProviderDefinition | null {
  return VOICE_PROVIDER_LOOKUP.get(serviceType) ?? null;
}

export function getVoiceProviderLabel(serviceType: string): string {
  return getVoiceProviderDefinition(serviceType)?.label ?? serviceType;
}

export function isRuntimeVoiceServiceType(serviceType: string): serviceType is VoiceServiceType {
  return getVoiceProviderDefinition(serviceType)?.capabilities.runtimeCrud === true;
}

export function isChannelSttVoiceServiceType(serviceType: string): serviceType is VoiceServiceType {
  return getVoiceProviderDefinition(serviceType)?.capabilities.channelSttSelectable === true;
}

export function isChannelTtsVoiceServiceType(serviceType: string): serviceType is VoiceServiceType {
  return getVoiceProviderDefinition(serviceType)?.capabilities.channelTtsSelectable === true;
}

export function isS2SProviderType(serviceType: string): serviceType is S2SProviderType {
  return getVoiceProviderDefinition(serviceType)?.capabilities.channelS2SSelectable === true;
}

export function isTtsPreviewProviderType(serviceType: string): serviceType is VoiceServiceType {
  return getVoiceProviderDefinition(serviceType)?.capabilities.supportsTtsPreview === true;
}

export function getSpeechProviderRole(serviceType: string): SpeechProviderRole | null {
  return getVoiceProviderDefinition(serviceType)?.capabilities.speechRole ?? null;
}

export function getSensitiveVoiceConfigKeys(serviceType: string): readonly string[] {
  return SENSITIVE_VOICE_CONFIG_KEYS[serviceType as VoiceServiceType] ?? [];
}

export function isSpeechVoiceServiceType(serviceType: string): serviceType is VoiceServiceType {
  return getSpeechProviderRole(serviceType) != null;
}

export function listAdminVoiceProviders(
  surface?: Exclude<VoiceAdminSurface, null>,
): VoiceProviderDefinition[] {
  return VOICE_PROVIDER_DEFINITIONS.filter((provider) => {
    const capabilities = provider.capabilities as VoiceProviderCapabilities;
    return surface == null
      ? capabilities.adminSurface != null
      : capabilities.adminSurface === surface ||
          capabilities.additionalAdminSurfaces?.includes(surface) === true;
  });
}

export function getS2STelephonySupport(serviceType: string): S2STelephonySupport {
  return getVoiceProviderDefinition(serviceType)?.capabilities.s2sTelephonySupport ?? 'none';
}

export function getS2STelephonySupportMessage(serviceType: string): string | null {
  switch (getS2STelephonySupport(serviceType)) {
    case 'partial':
      return 'Baseline KoreVG telephony support is available, but inline agent handoff and prompt-swap flows remain limited for this provider in ABL.';
    case 'full':
    case 'none':
    default:
      return null;
  }
}

export function describeRuntimeVoiceServiceTypes(): string {
  return RUNTIME_VOICE_SERVICE_TYPES.join(', ');
}
