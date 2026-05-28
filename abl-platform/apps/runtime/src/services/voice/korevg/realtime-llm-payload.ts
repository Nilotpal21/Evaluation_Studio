import type { S2SSessionConfig } from '../s2s/types.js';

export interface RealtimeLlmToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface RealtimeLlmVerbPayload {
  verb: 'llm';
  vendor: 'openai' | 'microsoft';
  model: string;
  auth: {
    apiKey: string;
  };
  connectOptions?: {
    host?: string;
    path?: string;
  };
  eventHook: '/llm-event';
  toolHook?: '/llm-tool';
  events: string[];
  llmOptions: {
    response_create: {
      modalities: ['text', 'audio'];
      instructions: string;
      voice: string;
      temperature: number;
      max_output_tokens: number;
    };
    session_update: {
      modalities: ['text', 'audio'];
      instructions: string;
      voice: string;
      output_audio_format: 'pcm16';
      tools?: RealtimeLlmToolDefinition[];
      tool_choice?: 'auto';
      input_audio_transcription: {
        model: 'whisper-1';
      };
      turn_detection: {
        type: 'server_vad';
        threshold: number;
        prefix_padding_ms: number;
        silence_duration_ms: number;
      };
    };
  };
}

export const OPENAI_REALTIME_TEMPERATURE_MIN = 0.6;
export const OPENAI_REALTIME_TEMPERATURE_MAX = 1.2;
export const OPENAI_REALTIME_TEMPERATURE_DEFAULT = 0.8;
// Temporary KoreVG dialect shim: Azure preview deployments such as gpt-realtime-2
// reject the newer response.audio payload shape that KoreVG selects from that
// label. Keep the Azure deployment in connectOptions.path, but send KoreVG the
// older working label until KoreVG supports the gpt-realtime-2 Azure dialect.
export const AZURE_OPENAI_PREVIEW_KOREVG_MODEL_LABEL = 'gpt-realtime-1.5';

export function normalizeOpenAIRealtimeTemperature(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return OPENAI_REALTIME_TEMPERATURE_DEFAULT;
  }

  return Math.min(
    OPENAI_REALTIME_TEMPERATURE_MAX,
    Math.max(OPENAI_REALTIME_TEMPERATURE_MIN, value),
  );
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveAzureResourceHost(s2sConfig: S2SSessionConfig): string | undefined {
  const explicitHost =
    stringOrUndefined(s2sConfig.resourceHost) ||
    stringOrUndefined(s2sConfig.azureResourceHost) ||
    stringOrUndefined(s2sConfig.host);
  if (explicitHost) {
    return explicitHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  const endpoint = stringOrUndefined(s2sConfig.endpoint);
  if (!endpoint) {
    return undefined;
  }

  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function resolveAzureRealtimePath(s2sConfig: S2SSessionConfig, deploymentName: string): string {
  const explicitPath =
    stringOrUndefined(s2sConfig.path) || stringOrUndefined(s2sConfig.realtimePath);
  if (explicitPath) {
    return explicitPath.replace(/^\//, '');
  }

  const apiVersion = stringOrUndefined(s2sConfig.apiVersion) || '2025-04-01-preview';
  return `openai/realtime?api-version=${encodeURIComponent(apiVersion)}&deployment=${encodeURIComponent(
    deploymentName,
  )}`;
}

function withAzureApiKeyQuery(path: string, apiKey: string): string {
  const [pathAndQuery, fragment] = path.split('#', 2);
  if (/(^|[?&])api-key=/.test(pathAndQuery)) {
    return path;
  }

  // Temporary KoreVG auth workaround: current KoreVG microsoft S2S supports
  // Azure Realtime query auth but cannot attach the Azure-required api-key
  // websocket header. Remove this once KoreVG supports header auth and redacts
  // connectOptions.path from its logs.
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  const updatedPath = `${pathAndQuery}${separator}api-key=${encodeURIComponent(apiKey)}`;
  return fragment ? `${updatedPath}#${fragment}` : updatedPath;
}

function usesAzurePreviewRealtimeApi(s2sConfig: S2SSessionConfig): boolean {
  const explicitPath =
    stringOrUndefined(s2sConfig.path) || stringOrUndefined(s2sConfig.realtimePath);
  if (explicitPath) {
    const normalizedPath = explicitPath.replace(/^\//, '').toLowerCase();
    return (
      normalizedPath.startsWith('openai/realtime') ||
      normalizedPath.includes('api-version=') ||
      normalizedPath.includes('-preview')
    );
  }

  const apiVersion = stringOrUndefined(s2sConfig.apiVersion);
  return !apiVersion || apiVersion.toLowerCase().includes('preview');
}

function resolveAzureKorevgModelLabel(s2sConfig: S2SSessionConfig, deploymentName: string): string {
  if (usesAzurePreviewRealtimeApi(s2sConfig)) {
    return AZURE_OPENAI_PREVIEW_KOREVG_MODEL_LABEL;
  }

  return deploymentName;
}

export function buildRealtimeLlmVerbPayload({
  apiKey,
  instructions,
  s2sConfig,
  tools,
  greetingMessage,
}: {
  apiKey: string;
  instructions: string;
  s2sConfig: S2SSessionConfig;
  tools: RealtimeLlmToolDefinition[];
  greetingMessage?: string;
}): RealtimeLlmVerbPayload {
  const isAzureOpenAI = s2sConfig.provider === 's2s:microsoft';
  const configuredModel =
    (s2sConfig.model as string | undefined) ||
    (s2sConfig.deploymentName as string | undefined) ||
    'gpt-realtime-1.5';
  const azureDeploymentName = (s2sConfig.deploymentName as string | undefined) || configuredModel;
  const model = isAzureOpenAI
    ? resolveAzureKorevgModelLabel(s2sConfig, azureDeploymentName)
    : configuredModel;
  const azureResourceHost = isAzureOpenAI ? resolveAzureResourceHost(s2sConfig) : undefined;

  if (isAzureOpenAI && !azureResourceHost) {
    throw new Error('Azure OpenAI Realtime requires resourceHost in the S2S provider config');
  }

  const llmVerb: RealtimeLlmVerbPayload = {
    verb: 'llm',
    vendor: isAzureOpenAI ? 'microsoft' : 'openai',
    model,
    auth: {
      apiKey,
    },
    connectOptions:
      isAzureOpenAI && azureResourceHost
        ? {
            host: azureResourceHost,
            path: withAzureApiKeyQuery(
              resolveAzureRealtimePath(s2sConfig, azureDeploymentName),
              apiKey,
            ),
          }
        : undefined,
    eventHook: '/llm-event',
    toolHook: tools.length > 0 ? '/llm-tool' : undefined,
    events: [
      'session.updated',
      'conversation.item.*',
      'response.created',
      'response.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.audio.done',
      'response.audio_transcript.delta',
      'response.audio_transcript.done',
      'input_audio_buffer.committed',
    ],
    llmOptions: {
      response_create: {
        modalities: ['text', 'audio'],
        instructions:
          greetingMessage ||
          instructions ||
          'Greet the caller and ask how you can help them today.',
        voice: (s2sConfig.voice as string) || 'marin',
        temperature: normalizeOpenAIRealtimeTemperature(s2sConfig.temperature),
        max_output_tokens: 4096,
      },
      session_update: {
        modalities: ['text', 'audio'],
        instructions,
        voice: (s2sConfig.voice as string) || 'marin',
        output_audio_format: 'pcm16',
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: numberOrDefault(s2sConfig.threshold, 0.5),
          prefix_padding_ms: numberOrDefault(s2sConfig.prefixPadding, 300),
          silence_duration_ms: numberOrDefault(s2sConfig.silenceDuration, 700),
        },
      },
    },
  };

  if (!llmVerb.toolHook) {
    delete llmVerb.toolHook;
  }
  if (!llmVerb.llmOptions.session_update.tools) {
    delete llmVerb.llmOptions.session_update.tools;
  }
  if (!llmVerb.llmOptions.session_update.tool_choice) {
    delete llmVerb.llmOptions.session_update.tool_choice;
  }

  return llmVerb;
}
