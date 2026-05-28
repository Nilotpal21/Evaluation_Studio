import type { S2SProviderType, S2SSessionConfig } from '../s2s/types.js';
import {
  buildRealtimeLlmVerbPayload,
  type RealtimeLlmToolDefinition,
  type RealtimeLlmVerbPayload,
} from './realtime-llm-payload.js';

export interface PromptToolDefinition {
  name: string;
  description?: string;
  input_schema?: {
    type?: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ProviderAdapterBuildParams {
  provider: S2SProviderType;
  apiKey: string;
  instructions: string;
  s2sConfig: S2SSessionConfig;
  openAITools: RealtimeLlmToolDefinition[];
  promptTools: PromptToolDefinition[];
  greetingMessage?: string;
}

export interface GenericRealtimeLlmVerbPayload {
  verb: 'llm';
  vendor: string;
  model: string;
  auth: Record<string, unknown>;
  eventHook: '/llm-event';
  toolHook?: '/llm-tool';
  events: string[];
  llmOptions: Record<string, unknown>;
}

export type ProviderAwareLlmVerbPayload = RealtimeLlmVerbPayload | GenericRealtimeLlmVerbPayload;

export type S2SProviderFamily =
  | 'openai'
  | 'google'
  | 'grok'
  | 'elevenlabs'
  | 'ultravox'
  | 'voiceagent';

export interface SyntheticRealtimeEvent {
  type: string;
  transcript?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringifyToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function buildVoiceAgentFunctions(tools: PromptToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: {
      type: 'object',
      properties: tool.input_schema?.properties || {},
      required: tool.input_schema?.required || [],
    },
  }));
}

function buildUltravoxDynamicParameters(
  inputSchema?: PromptToolDefinition['input_schema'],
): Array<Record<string, unknown>> {
  const properties = inputSchema?.properties || {};
  const required = new Set(inputSchema?.required || []);

  return Object.keys(properties).map((name) => ({
    name,
    location: 'PARAMETER_LOCATION_BODY',
    required: required.has(name),
  }));
}

function buildUltravoxSelectedTools(
  tools: PromptToolDefinition[],
): Array<Record<string, unknown>> | undefined {
  if (tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    temporaryTool: {
      modelToolName: tool.name,
      description: tool.description || '',
      dynamicParameters: buildUltravoxDynamicParameters(tool.input_schema),
      client: {},
    },
  }));
}

function buildElevenLabsLlmVerbPayload(
  params: ProviderAdapterBuildParams,
): GenericRealtimeLlmVerbPayload {
  const agentId = readNonEmptyString(params.s2sConfig.agentId);
  if (!agentId) {
    throw new Error('s2s:elevenlabs requires s2sAgentId');
  }

  const voiceId = readNonEmptyString(params.s2sConfig.voice);
  const conversationConfigOverride: Record<string, unknown> = {
    agent: {
      prompt: {
        prompt: params.instructions,
      },
      ...(params.greetingMessage ? { first_message: params.greetingMessage } : {}),
    },
  };

  if (voiceId) {
    conversationConfigOverride.tts = { voice_id: voiceId };
  }

  const llmOptions: Record<string, unknown> = {
    conversation_initiation_client_data: {
      conversation_config_override: conversationConfigOverride,
      ...(readNumber(params.s2sConfig.temperature) !== undefined
        ? { custom_llm_extra_body: { temperature: params.s2sConfig.temperature } }
        : {}),
    },
    input_sample_rate: 16000,
    output_sample_rate: 16000,
  };

  return {
    verb: 'llm',
    vendor: 'elevenlabs',
    model: readNonEmptyString(params.s2sConfig.model) || 'elevenlabs-convai',
    auth: {
      agent_id: agentId,
      api_key: params.apiKey,
    },
    eventHook: '/llm-event',
    toolHook: params.promptTools.length > 0 ? '/llm-tool' : undefined,
    events: [
      'conversation_initiation_metadata',
      'user_transcript',
      'agent_response',
      'client_tool_call',
    ],
    llmOptions,
  };
}

function buildUltravoxLlmVerbPayload(
  params: ProviderAdapterBuildParams,
): GenericRealtimeLlmVerbPayload {
  const selectedTools = buildUltravoxSelectedTools(params.promptTools);
  const agentId = readNonEmptyString(params.s2sConfig.agentId);
  return {
    verb: 'llm',
    vendor: 'ultravox',
    model: readNonEmptyString(params.s2sConfig.model) || 'fixie-ai/ultravox-v0.7',
    auth: {
      apiKey: params.apiKey,
      ...(agentId ? { agent_id: agentId } : {}),
    },
    eventHook: '/llm-event',
    toolHook: params.promptTools.length > 0 ? '/llm-tool' : undefined,
    events: [
      'callStarted',
      'state',
      'transcript',
      'clientToolInvocation',
      'playbackClearBuffer',
      'userStartedSpeaking',
    ],
    llmOptions: {
      systemPrompt: params.instructions,
      temperature: readNumber(params.s2sConfig.temperature) ?? 0.8,
      medium: {
        serverWebSocket: {
          inputSampleRate: 8000,
          outputSampleRate: 8000,
          dataMessages: {
            callStarted: true,
            state: true,
            transcript: true,
            clientToolInvocation: true,
            playbackClearBuffer: true,
            userStartedSpeaking: true,
          },
        },
      },
      initialOutputMedium: 'MESSAGE_MEDIUM_VOICE',
      ...(params.greetingMessage
        ? {
            firstSpeakerSettings: {
              agent: {
                text: params.greetingMessage,
              },
            },
          }
        : {}),
      ...(selectedTools ? { selectedTools } : {}),
    },
  };
}

function buildVoiceAgentLlmVerbPayload(
  params: ProviderAdapterBuildParams,
): GenericRealtimeLlmVerbPayload {
  const thinkProviderType = readNonEmptyString(params.s2sConfig.thinkProviderType) || 'open_ai';
  const thinkModel = readNonEmptyString(params.s2sConfig.thinkModel) || 'gpt-4o-mini';
  const listenModel = readNonEmptyString(params.s2sConfig.listenModel) || 'nova-3';
  const speakModel =
    readNonEmptyString(params.s2sConfig.voice) ||
    readNonEmptyString(params.s2sConfig.model) ||
    'aura-asteria-en';
  const functions = buildVoiceAgentFunctions(params.promptTools);

  return {
    verb: 'llm',
    vendor: 'deepgram',
    model: thinkModel,
    auth: {
      apiKey: params.apiKey,
    },
    eventHook: '/llm-event',
    toolHook: params.promptTools.length > 0 ? '/llm-tool' : undefined,
    events: [
      'Welcome',
      'SettingsApplied',
      'ConversationText',
      'UserStartedSpeaking',
      'FunctionCallRequest',
      'AgentAudioDone',
      'Warning',
      'Error',
    ],
    llmOptions: {
      Settings: {
        type: 'Settings',
        agent: {
          listen: {
            provider: {
              type: 'deepgram',
              model: listenModel,
            },
          },
          think: {
            provider: {
              type: thinkProviderType,
              model: thinkModel,
              ...(readNumber(params.s2sConfig.temperature) !== undefined
                ? { temperature: params.s2sConfig.temperature }
                : {}),
            },
            prompt: params.instructions,
            ...(functions.length > 0 ? { functions } : {}),
          },
          speak: {
            provider: {
              type: 'deepgram',
              model: speakModel,
            },
          },
          ...(params.greetingMessage ? { greeting: params.greetingMessage } : {}),
        },
      },
    },
  };
}

export function getS2SProviderFamily(provider: S2SProviderType): S2SProviderFamily {
  switch (provider) {
    case 's2s:google':
      return 'google';
    case 's2s:grok':
      return 'grok';
    case 's2s:elevenlabs':
      return 'elevenlabs';
    case 's2s:ultravox':
      return 'ultravox';
    case 's2s:deepgram':
      return 'voiceagent';
    case 's2s:microsoft':
    case 's2s:openai':
    default:
      return 'openai';
  }
}

export function getS2STraceProviderName(provider: S2SProviderType): string {
  switch (provider) {
    case 's2s:deepgram':
      return 'deepgram';
    case 's2s:elevenlabs':
      return 'elevenlabs';
    case 's2s:ultravox':
      return 'ultravox';
    case 's2s:google':
      return 'google';
    case 's2s:grok':
      return 'grok';
    case 's2s:microsoft':
      return 'azure_openai';
    case 's2s:openai':
    default:
      return 'openai';
  }
}

export function buildProviderAwareLlmVerbPayload(
  params: ProviderAdapterBuildParams,
): ProviderAwareLlmVerbPayload {
  switch (getS2SProviderFamily(params.provider)) {
    case 'elevenlabs':
      return buildElevenLabsLlmVerbPayload(params);
    case 'ultravox':
      return buildUltravoxLlmVerbPayload(params);
    case 'voiceagent':
      return buildVoiceAgentLlmVerbPayload(params);
    case 'openai':
    default:
      return buildRealtimeLlmVerbPayload({
        apiKey: params.apiKey,
        instructions: params.instructions,
        s2sConfig: params.s2sConfig,
        tools: params.openAITools,
        greetingMessage: params.greetingMessage,
      });
  }
}

export function buildProviderToolResponseMessage(params: {
  provider: S2SProviderType;
  callId: string;
  toolName: string;
  result: unknown;
}): Record<string, unknown> {
  const { provider, callId, toolName, result } = params;

  switch (getS2SProviderFamily(provider)) {
    case 'elevenlabs':
      return {
        type: 'client_tool_result',
        tool_call_id: callId,
        result: stringifyToolResult(result),
        is_error: false,
      };
    case 'ultravox':
      return {
        type: 'client_tool_result',
        invocationId: callId,
        invocation_id: callId,
        result: stringifyToolResult(result),
        responseType: 'tool-response',
        agentReaction: 'speaks',
      };
    case 'voiceagent':
      return {
        type: 'FunctionCallResponse',
        id: callId,
        name: toolName,
        content: stringifyToolResult(result),
      };
    case 'openai':
    default:
      return {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: stringifyToolResult(result),
        },
      };
  }
}

export function buildProviderToolErrorMessage(params: {
  provider: S2SProviderType;
  callId: string;
  toolName: string;
  errorMessage: string;
}): Record<string, unknown> {
  const { provider, callId, toolName, errorMessage } = params;

  switch (getS2SProviderFamily(provider)) {
    case 'elevenlabs':
      return {
        type: 'client_tool_result',
        tool_call_id: callId,
        result: errorMessage,
        is_error: true,
      };
    case 'ultravox':
      return {
        type: 'client_tool_result',
        invocationId: callId,
        invocation_id: callId,
        errorType: 'implementation-error',
        errorMessage,
        responseType: 'tool-response',
      };
    case 'voiceagent':
      return {
        type: 'FunctionCallResponse',
        id: callId,
        name: toolName,
        content: errorMessage,
      };
    case 'openai':
    default:
      return {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: errorMessage,
        },
      };
  }
}

export class UltravoxTranscriptAccumulator {
  private readonly buffers = new Map<number, { role: 'user' | 'assistant'; text: string }>();

  translate(event: Record<string, unknown>): SyntheticRealtimeEvent[] {
    const type = readNonEmptyString(event.type);
    if (type === 'userStartedSpeaking' || type === 'user_started_speaking') {
      return [{ type: 'conversation.item.truncated' }];
    }
    if (type === 'playbackClearBuffer' || type === 'playback_clear_buffer') {
      return [{ type: 'conversation.item.truncated' }];
    }
    if (type !== 'transcript') {
      return [];
    }

    const rawRole = readNonEmptyString(event.role) || readNonEmptyString(event.speaker);
    const role =
      rawRole === 'agent' || rawRole === 'assistant'
        ? 'assistant'
        : rawRole === 'user'
          ? 'user'
          : undefined;
    if (!role) {
      return [];
    }

    const ordinal =
      typeof event.ordinal === 'number' && Number.isFinite(event.ordinal) ? event.ordinal : 0;
    const final =
      typeof event.final === 'boolean'
        ? event.final
        : typeof event.isFinal === 'boolean'
          ? event.isFinal
          : false;
    const text = readNonEmptyString(event.text);
    const delta = readNonEmptyString(event.delta);
    const existing = this.buffers.get(ordinal);

    const nextText = text ?? (delta ? `${existing?.text ?? ''}${delta}` : (existing?.text ?? ''));

    if (!nextText) {
      return [];
    }

    this.buffers.set(ordinal, { role, text: nextText });

    if (role === 'assistant' && !final) {
      return [{ type: 'response.audio_transcript.delta' }];
    }

    if (!final) {
      return [];
    }

    this.buffers.delete(ordinal);
    if (role === 'assistant') {
      return [
        { type: 'response.audio_transcript.delta' },
        { type: 'response.audio_transcript.done', transcript: nextText },
      ];
    }

    return [
      { type: 'conversation.item.input_audio_transcription.completed', transcript: nextText },
    ];
  }
}

export function translateProviderEventToRealtimeEvents(
  provider: S2SProviderType,
  event: Record<string, unknown>,
  ultravoxAccumulator: UltravoxTranscriptAccumulator,
): SyntheticRealtimeEvent[] {
  switch (getS2SProviderFamily(provider)) {
    case 'elevenlabs': {
      if (event.type === 'user_transcript') {
        const transcript = readNonEmptyString(
          (event.user_transcription_event as { user_transcript?: unknown } | undefined)
            ?.user_transcript,
        );
        return transcript
          ? [{ type: 'conversation.item.input_audio_transcription.completed', transcript }]
          : [];
      }

      if (event.type === 'agent_response') {
        const transcript = readNonEmptyString(
          (event.agent_response_event as { agent_response?: unknown } | undefined)?.agent_response,
        );
        return transcript
          ? [
              { type: 'response.audio_transcript.delta' },
              { type: 'response.audio_transcript.done', transcript },
            ]
          : [];
      }

      return [];
    }
    case 'ultravox':
      return ultravoxAccumulator.translate(event);
    case 'voiceagent': {
      if (event.type === 'UserStartedSpeaking') {
        return [{ type: 'conversation.item.truncated' }];
      }

      if (event.type === 'ConversationText') {
        const role = readNonEmptyString(event.role);
        const transcript = readNonEmptyString(event.content);
        if (!role || !transcript) {
          return [];
        }

        if (role === 'assistant') {
          return [
            { type: 'response.audio_transcript.delta' },
            { type: 'response.audio_transcript.done', transcript },
          ];
        }

        if (role === 'user') {
          return [{ type: 'conversation.item.input_audio_transcription.completed', transcript }];
        }
      }

      return [];
    }
    case 'openai':
    case 'google':
    case 'grok':
    default:
      return [];
  }
}
