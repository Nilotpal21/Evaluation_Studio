import type { ComponentType, ReactNode } from 'react';
import { AudioLines, Mic, Volume2 } from 'lucide-react';
import { DEEPGRAM_STT_MODELS } from '@agent-platform/config/constants/deepgram-models';
import { AzureOpenAIS2SFields } from '../deployments/channels/AzureOpenAIS2SFields';
import {
  getS2STelephonySupportMessage,
  getVoiceProviderDefinition,
  isS2SProviderType,
  isTtsPreviewProviderType,
  listAdminVoiceProviders,
  type S2SProviderType,
} from '@agent-platform/config/constants/voice-providers';
import { DeepgramS2SFields } from '../deployments/channels/DeepgramS2SFields';
import { ElevenLabsS2SFields } from '../deployments/channels/ElevenLabsS2SFields';
import { GoogleS2SFields } from '../deployments/channels/GoogleS2SFields';
import { GrokS2SFields } from '../deployments/channels/GrokS2SFields';
import { OpenAIS2SFields } from '../deployments/channels/OpenAIS2SFields';
import { UltravoxS2SFields } from '../deployments/channels/UltravoxS2SFields';

export type VoiceServiceCardFieldStorage = 'apiKey' | 'config';

export interface VoiceServiceCardFieldConfig {
  key: string;
  label: string;
  placeholder: string;
  storage: VoiceServiceCardFieldStorage;
  type?: 'text' | 'password' | 'select' | 'textarea' | 'range' | 'toggle';
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
  hint?: ReactNode;
  sensitive?: boolean;
  authProfileEligible?: boolean;
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface VoiceServiceCardConfig {
  serviceType: string;
  label: string;
  description: string;
  icon: ReactNode;
  fields: VoiceServiceCardFieldConfig[];
}

export interface VoiceServiceConfigValidationResult {
  isValid: boolean;
  fieldErrors: Record<string, string>;
}

export interface S2SFieldComponentProps {
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

function requireProvider(serviceType: string) {
  const provider = getVoiceProviderDefinition(serviceType);
  if (!provider) {
    throw new Error(`Unknown voice provider registry entry: ${serviceType}`);
  }
  return provider;
}

function primaryCredentialField(
  label: string,
  placeholder: string,
  options: Partial<VoiceServiceCardFieldConfig> = {},
): VoiceServiceCardFieldConfig {
  return {
    key: 'apiKey',
    label,
    placeholder,
    storage: 'apiKey',
    type: options.type ?? (options.sensitive === false ? 'text' : 'password'),
    sensitive: options.sensitive ?? true,
    authProfileEligible: options.authProfileEligible ?? false,
    defaultValue: options.defaultValue,
    hint: options.hint,
    options: options.options,
    rows: options.rows,
    min: options.min,
    max: options.max,
    step: options.step,
  };
}

function configField(
  key: string,
  label: string,
  placeholder: string,
  options: Partial<VoiceServiceCardFieldConfig> = {},
): VoiceServiceCardFieldConfig {
  return {
    key,
    label,
    placeholder,
    storage: 'config',
    type: options.type ?? (options.sensitive ? 'password' : 'text'),
    sensitive: options.sensitive ?? false,
    authProfileEligible: false,
    defaultValue: options.defaultValue,
    hint: options.hint,
    options: options.options,
    rows: options.rows,
    min: options.min,
    max: options.max,
    step: options.step,
  };
}

function isUrlLikeAzureDeploymentName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return true;
  }

  if (/[/?#]/.test(trimmed)) {
    return true;
  }

  return /\.openai\.azure\.com$/i.test(trimmed);
}

export function validateVoiceServiceConfig(
  serviceType: string,
  config: Record<string, unknown>,
): VoiceServiceConfigValidationResult {
  const fieldErrors: Record<string, string> = {};

  if (serviceType === 's2s:microsoft' && typeof config.deploymentName === 'string') {
    const deploymentName = config.deploymentName.trim();
    if (isUrlLikeAzureDeploymentName(deploymentName)) {
      fieldErrors.deploymentName =
        'Use only the Azure deployment name, not a URL, endpoint, or path.';
    }
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export const ADMIN_STT_SERVICE_TYPES = listAdminVoiceProviders('stt').map(
  (provider) => provider.serviceType,
);

export const ADMIN_TTS_SERVICE_TYPES = listAdminVoiceProviders('tts').map(
  (provider) => provider.serviceType,
);

export const VOICE_SERVICE_CARD_CONFIGS: VoiceServiceCardConfig[] = [
  {
    serviceType: 'deepgram',
    label: requireProvider('deepgram').label,
    description: requireProvider('deepgram').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'dg_...', { authProfileEligible: true }),
      configField('model', 'Model', 'Select a model', {
        type: 'select',
        defaultValue: 'nova-3',
        options: DEEPGRAM_STT_MODELS.map((model) => ({ value: model.id, label: model.label })),
        hint: (
          <a
            href="https://developers.deepgram.com/docs/models"
            target="_blank"
            rel="noopener noreferrer"
            className="text-info hover:underline"
          >
            View all Deepgram models &rarr;
          </a>
        ),
      }),
    ],
  },
  {
    serviceType: 'google',
    label: requireProvider('google').label,
    description: requireProvider('google').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('Service Account JSON', 'Paste Google credentials JSON', {
        type: 'textarea',
        sensitive: true,
        rows: 10,
        hint: 'Paste the full Google service-account JSON used for Speech-to-Text.',
      }),
      configField('modelId', 'STT Model ID', 'chirp_3', {
        hint: 'Optional Google STT model, for example chirp_3, chirp, latest_long, latest_short, telephony, or telephony_short.',
      }),
    ],
  },
  {
    serviceType: 'aws',
    label: requireProvider('aws').label,
    description: requireProvider('aws').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField(
        'Access Key ID or Role ARN',
        'AKIA... or arn:aws:iam::123456789012:role/...',
        {
          sensitive: false,
        },
      ),
      configField('secretAccessKey', 'Secret Access Key', 'AWS secret access key', {
        sensitive: true,
      }),
      configField('awsRegion', 'Region', 'us-east-1'),
    ],
  },
  {
    serviceType: 'microsoft',
    label: requireProvider('microsoft').label,
    description: requireProvider('microsoft').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Azure Speech API key', { authProfileEligible: true }),
      configField('region', 'Region', 'eastus'),
      configField(
        'customSttEndpointId',
        'STT Deployment ID',
        'Optional Azure custom speech deployment ID',
        {
          hint: 'Optional. The Azure recognition URL is generated from region and deployment ID.',
        },
      ),
    ],
  },
  {
    serviceType: 'nuance',
    label: requireProvider('nuance').label,
    description: requireProvider('nuance').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('Client ID', 'Nuance client ID', { sensitive: false }),
      configField('secret', 'Client Secret', 'Nuance client secret', { sensitive: true }),
      configField('nuanceSttUri', 'STT URI', 'Optional Nuance Krypton STT URI'),
      configField('nuanceTtsUri', 'TTS URI', 'Optional Nuance Krypton TTS URI'),
    ],
  },
  {
    serviceType: 'gladia',
    label: requireProvider('gladia').label,
    description: requireProvider('gladia').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Gladia API key', { authProfileEligible: true }),
      configField('region', 'Region', 'us-west'),
    ],
  },
  {
    serviceType: 'soniox',
    label: requireProvider('soniox').label,
    description: requireProvider('soniox').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [primaryCredentialField('API Key', 'Soniox API key', { authProfileEligible: true })],
  },
  {
    serviceType: 'cobalt',
    label: requireProvider('cobalt').label,
    description: requireProvider('cobalt').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [primaryCredentialField('Server URI', 'host:port', { sensitive: false })],
  },
  {
    serviceType: 'ibm',
    label: requireProvider('ibm').label,
    description: requireProvider('ibm').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('STT API Key', 'IBM Watson STT API key', {
        authProfileEligible: true,
      }),
      configField('sttRegion', 'STT Region', 'us-south'),
      configField('instanceId', 'Instance ID', 'Optional IBM instance ID'),
    ],
  },
  {
    serviceType: 'nvidia',
    label: requireProvider('nvidia').label,
    description: requireProvider('nvidia').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [primaryCredentialField('Riva Server URI', 'host:port', { sensitive: false })],
  },
  {
    serviceType: 'assemblyai',
    label: requireProvider('assemblyai').label,
    description: requireProvider('assemblyai').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'AssemblyAI API key', { authProfileEligible: true }),
      configField('serviceVersion', 'Service Version', 'v2', {
        type: 'select',
        defaultValue: 'v2',
        options: [
          { value: 'v2', label: 'v2' },
          { value: 'v3', label: 'v3' },
        ],
      }),
    ],
  },
  {
    serviceType: 'houndify',
    label: requireProvider('houndify').label,
    description: requireProvider('houndify').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('Client ID', 'Houndify client ID', { sensitive: false }),
      configField('clientKey', 'Client Key', 'Houndify client key', { sensitive: true }),
      configField('userId', 'User ID', 'Stable user identifier'),
      configField('houndifyServerUri', 'Audio Endpoint URI', 'Optional Houndify server URI'),
    ],
  },
  {
    serviceType: 'voxist',
    label: requireProvider('voxist').label,
    description: requireProvider('voxist').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [primaryCredentialField('API Key', 'Voxist API key', { authProfileEligible: true })],
  },
  {
    serviceType: 'cartesia',
    label: requireProvider('cartesia').label,
    description: requireProvider('cartesia').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Cartesia API key', { authProfileEligible: true }),
      configField('sttModelId', 'STT Model', 'ink-whisper', {
        type: 'select',
        defaultValue: 'ink-whisper',
        options: [{ value: 'ink-whisper', label: 'Ink-whisper' }],
      }),
      configField('modelId', 'TTS Model ID', 'Optional Cartesia model ID'),
    ],
  },
  {
    serviceType: 'speechmatics',
    label: requireProvider('speechmatics').label,
    description: requireProvider('speechmatics').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Speechmatics API key', { authProfileEligible: true }),
      configField('speechmaticsSttUri', 'Host', 'eu2.rt.speechmatics.com'),
    ],
  },
  {
    serviceType: 'openai',
    label: requireProvider('openai').label,
    description: requireProvider('openai').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'sk-proj-...', { authProfileEligible: true }),
      configField('model', 'Model', 'whisper-1', {
        type: 'select',
        defaultValue: 'whisper-1',
        options: [
          { value: 'whisper-1', label: 'Whisper 1' },
          { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
          { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
        ],
      }),
    ],
  },
  {
    serviceType: 'verbio',
    label: requireProvider('verbio').label,
    description: requireProvider('verbio').description,
    icon: <AudioLines className="w-5 h-5" />,
    fields: [
      primaryCredentialField('Client ID', 'Verbio client ID', { sensitive: false }),
      configField('clientSecret', 'Client Secret', 'Verbio client secret', { sensitive: true }),
      configField('engineVersion', 'Engine Version', 'V1', { defaultValue: 'V1' }),
    ],
  },
  {
    serviceType: 'rimelabs',
    label: requireProvider('rimelabs').label,
    description: requireProvider('rimelabs').description,
    icon: <Volume2 className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'RimeLabs API key', { authProfileEligible: true }),
      configField('modelId', 'Model ID', 'Optional Rime model ID'),
    ],
  },
  {
    serviceType: 'playht',
    label: requireProvider('playht').label,
    description: requireProvider('playht').description,
    icon: <Volume2 className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'PlayHT API key', { authProfileEligible: true }),
      configField('userId', 'User ID', 'PlayHT user ID'),
      configField('voiceEngine', 'Voice Engine', 'Optional PlayHT voice engine'),
    ],
  },
  {
    serviceType: 'inworld',
    label: requireProvider('inworld').label,
    description: requireProvider('inworld').description,
    icon: <Volume2 className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Inworld API key', { authProfileEligible: true }),
      configField('modelId', 'Model ID', 'Optional Inworld model ID'),
    ],
  },
  {
    serviceType: 'elevenlabs',
    label: requireProvider('elevenlabs').label,
    description: requireProvider('elevenlabs').description,
    icon: <Volume2 className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'sk_...', { authProfileEligible: true }),
      configField('voiceId', 'Voice ID', 'e.g. EXAVITQu4vr4xnSDxMaL', {
        hint: (
          <>
            Popular voices: <span className="font-mono">EXAVITQu4vr4xnSDxMaL</span> (Sarah),{' '}
            <span className="font-mono">21m00Tcm4TlvDq8ikWAM</span> (Rachel),{' '}
            <span className="font-mono">pNInz6obpgDQGcFmaJgB</span> (Adam).{' '}
            <a
              href="https://elevenlabs.io/voice-library"
              target="_blank"
              rel="noopener noreferrer"
              className="text-info hover:underline"
            >
              Browse voices &rarr;
            </a>
          </>
        ),
      }),
      configField('model', 'Model', 'eleven_multilingual_v2', {
        defaultValue: 'eleven_multilingual_v2',
        hint: (
          <>
            <span className="font-mono">eleven_multilingual_v2</span> (best quality, 29 languages),{' '}
            <span className="font-mono">eleven_turbo_v2_5</span> (fast, low latency),{' '}
            <span className="font-mono">eleven_flash_v2_5</span> (fastest)
          </>
        ),
      }),
      configField('speed', 'Speed', '1.0', {
        type: 'range',
        defaultValue: '1',
        min: 0.7,
        max: 1.2,
        step: 0.05,
        hint: 'Adjusts speaking pace. 1.0 is normal; lower slows the voice down, higher makes it faster.',
      }),
      configField('stability', 'Stability', '0.5', {
        type: 'range',
        defaultValue: '0.5',
        min: 0,
        max: 1,
        step: 0.05,
        hint: 'Controls consistency across generations. Higher is more stable and less expressive; lower allows more variation.',
      }),
      configField('similarityBoost', 'Similarity boost', '0.75', {
        type: 'range',
        defaultValue: '0.75',
        min: 0,
        max: 1,
        step: 0.05,
        hint: 'Keeps the output closer to the selected voice. Higher values preserve more of the original voice character.',
      }),
      configField('style', 'Style exaggeration', '0', {
        type: 'range',
        defaultValue: '0',
        min: 0,
        max: 1,
        step: 0.05,
        hint: 'Amplifies voice style and emotion. Higher values can sound more expressive but may increase latency or instability.',
      }),
      configField('useSpeakerBoost', 'Speaker boost', 'true', {
        type: 'toggle',
        defaultValue: 'true',
        hint: 'Enhances speaker similarity and clarity. Turning it off may reduce latency for some voices.',
      }),
    ],
  },
  {
    serviceType: 'custom:orpheus',
    label: requireProvider('custom:orpheus').label,
    description: requireProvider('custom:orpheus').description,
    icon: <Volume2 className="w-5 h-5" />,
    fields: [
      primaryCredentialField('Groq API Key', 'gsk_...', { authProfileEligible: true }),
      configField('model', 'Model', 'canopylabs/orpheus-v1-english', {
        defaultValue: 'canopylabs/orpheus-v1-english',
        hint: <span className="font-mono">canopylabs/orpheus-v1-english</span>,
      }),
      configField('voiceId', 'Voice ID', 'Select a voice', {
        defaultValue: 'hannah',
        type: 'select',
        options: [
          { value: 'autumn', label: 'Autumn' },
          { value: 'diana', label: 'Diana' },
          { value: 'hannah', label: 'Hannah' },
          { value: 'austin', label: 'Austin' },
          { value: 'daniel', label: 'Daniel' },
          { value: 'troy', label: 'Troy' },
        ],
        hint: (
          <>
            Supported voices: <span className="font-mono">autumn</span>,{' '}
            <span className="font-mono">diana</span>, <span className="font-mono">hannah</span>,{' '}
            <span className="font-mono">austin</span>, <span className="font-mono">daniel</span>,{' '}
            <span className="font-mono">troy</span>
          </>
        ),
      }),
    ],
  },
  {
    serviceType: 's2s:openai',
    label: requireProvider('s2s:openai').label,
    description: requireProvider('s2s:openai').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'sk-proj-...', { authProfileEligible: true }),
      configField('model', 'Model', 'gpt-realtime-1.5', { defaultValue: 'gpt-realtime-1.5' }),
      configField('voice', 'Voice', 'marin', { defaultValue: 'marin' }),
    ],
  },
  {
    serviceType: 's2s:microsoft',
    label: requireProvider('s2s:microsoft').label,
    description: requireProvider('s2s:microsoft').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'Azure OpenAI API key', { authProfileEligible: true }),
      configField('resourceHost', 'Resource Host', 'my-resource.openai.azure.com'),
      configField('deploymentName', 'Deployment Name', 'gpt-realtime'),
      configField('voice', 'Voice', 'marin', { defaultValue: 'marin' }),
      configField('apiVersion', 'API Version', '2025-04-01-preview', {
        defaultValue: '2025-04-01-preview',
      }),
    ],
  },
  {
    serviceType: 's2s:elevenlabs',
    label: requireProvider('s2s:elevenlabs').label,
    description: requireProvider('s2s:elevenlabs').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'sk_...', { authProfileEligible: true }),
      configField('agentId', 'Agent ID', 'agent_abc123xyz'),
    ],
  },
  {
    serviceType: 's2s:google',
    label: requireProvider('s2s:google').label,
    description: requireProvider('s2s:google').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'AIza...', { authProfileEligible: true }),
      configField('model', 'Model', 'gemini-2.0-flash-exp', {
        defaultValue: 'gemini-2.0-flash-exp',
      }),
      configField('voice', 'Voice', 'Puck', { defaultValue: 'Puck' }),
    ],
  },
  {
    serviceType: 's2s:deepgram',
    label: requireProvider('s2s:deepgram').label,
    description: requireProvider('s2s:deepgram').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'dg_...', { authProfileEligible: true }),
      configField('model', 'Voice Model', 'aura-asteria-en', {
        defaultValue: 'aura-asteria-en',
      }),
      configField('thinkProviderType', 'Think Provider', 'open_ai', {
        defaultValue: 'open_ai',
      }),
      configField('thinkModel', 'Think Model', 'gpt-4o-mini', {
        defaultValue: 'gpt-4o-mini',
      }),
      configField('listenModel', 'Listen Model', 'nova-3', {
        defaultValue: 'nova-3',
      }),
    ],
  },
  {
    serviceType: 's2s:ultravox',
    label: requireProvider('s2s:ultravox').label,
    description: requireProvider('s2s:ultravox').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'uv_...', { authProfileEligible: true }),
      configField('agentId', 'Agent ID', 'agent_abc123xyz'),
      configField('model', 'Model', 'fixie-ai/ultravox-v0.2', {
        defaultValue: 'fixie-ai/ultravox-v0.2',
      }),
    ],
  },
  {
    serviceType: 's2s:grok',
    label: requireProvider('s2s:grok').label,
    description: requireProvider('s2s:grok').description,
    icon: <Mic className="w-5 h-5" />,
    fields: [
      primaryCredentialField('API Key', 'xai-...', { authProfileEligible: true }),
      configField('model', 'Model', 'grok-2-1212', { defaultValue: 'grok-2-1212' }),
      configField('voice', 'Voice', 'ara', { defaultValue: 'ara' }),
    ],
  },
];

const S2S_FIELD_COMPONENTS: Record<S2SProviderType, ComponentType<S2SFieldComponentProps>> = {
  's2s:openai': OpenAIS2SFields,
  's2s:microsoft': AzureOpenAIS2SFields,
  's2s:elevenlabs': ElevenLabsS2SFields,
  's2s:google': GoogleS2SFields,
  's2s:deepgram': DeepgramS2SFields,
  's2s:ultravox': UltravoxS2SFields,
  's2s:grok': GrokS2SFields,
};

export function isTtsPreviewProvider(serviceType: string): boolean {
  return isTtsPreviewProviderType(serviceType);
}

export function getVoiceServiceCardConfig(serviceType: string): VoiceServiceCardConfig | null {
  return VOICE_SERVICE_CARD_CONFIGS.find((config) => config.serviceType === serviceType) ?? null;
}

export function getS2SFieldComponent(
  serviceType: string,
): ComponentType<S2SFieldComponentProps> | null {
  if (!isS2SProviderType(serviceType)) {
    return null;
  }
  return S2S_FIELD_COMPONENTS[serviceType];
}

export function getS2SProviderSupportMessage(serviceType: string): string | null {
  return getS2STelephonySupportMessage(serviceType);
}
