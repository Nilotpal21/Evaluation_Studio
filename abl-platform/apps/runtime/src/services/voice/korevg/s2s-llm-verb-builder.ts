/**
 * S2S LLM Verb Builders
 *
 * Builds provider-specific Jambonz `llm` verb payloads for S2S realtime mode.
 * OpenAI uses session_update/response_create format.
 * Google uses BidiGenerateContent setup format.
 */

import { normalizeOpenAIRealtimeTemperature } from './realtime-llm-payload.js';

// =============================================================================
// TYPES
// =============================================================================

export interface LlmVerbBase {
  verb: 'llm';
  vendor: string;
  model: string;
  auth: { apiKey: string };
  eventHook: string;
  toolHook?: string;
  events: string[];
  llmOptions: Record<string, unknown>;
}

export interface OpenAILlmVerbOpts {
  model: string;
  apiKey: string;
  instructions: string;
  voice: string;
  tools: Array<Record<string, unknown>>;
  temperature: number;
  threshold: number;
  prefixPadding: number;
  silenceDuration: number;
}

export interface GoogleLlmVerbOpts {
  model: string;
  apiKey: string;
  instructions: string;
  voice: string;
  tools: Array<Record<string, unknown>>;
  temperature: number;
  startSensitivity?: string;
  endSensitivity?: string;
  prefixPadding?: number;
  silenceDuration?: number;
  greetingMessage?: string;
}

const GEMINI_RUNTIME_INSTRUCTION_GUIDANCE = [
  'If a tool result includes `runtime_instructions`, treat that field as the authoritative session context from that point forward.',
  'If the same tool result also includes `text`, treat it as the caller-facing speech for that tool turn and speak it before continuing.',
  'If a tool result includes `continue_current_turn: true` without `text`, silently apply the new runtime instructions and continue answering the caller in the same turn.',
  'Do not announce the transfer or mention tool execution.',
].join('\n');

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function googleStartSensitivityOrUndefined(value: unknown): string | undefined {
  return value === 'START_SENSITIVITY_HIGH' || value === 'START_SENSITIVITY_LOW'
    ? value
    : undefined;
}

function googleEndSensitivityOrUndefined(value: unknown): string | undefined {
  return value === 'END_SENSITIVITY_HIGH' || value === 'END_SENSITIVITY_LOW' ? value : undefined;
}

function ensureGeminiRuntimeInstructionGuidance(instructions: string): string {
  const trimmed = instructions.trim();
  if (
    trimmed.includes('runtime_instructions') &&
    trimmed.includes('continue_current_turn') &&
    trimmed.includes('Do not announce the transfer')
  ) {
    return trimmed;
  }

  return [trimmed, GEMINI_RUNTIME_INSTRUCTION_GUIDANCE].filter(Boolean).join('\n\n');
}

// =============================================================================
// BUILDERS
// =============================================================================

export function buildOpenAILlmVerb(opts: OpenAILlmVerbOpts): LlmVerbBase {
  return {
    verb: 'llm',
    vendor: 'openai',
    model: opts.model || 'gpt-realtime-1.5',
    auth: { apiKey: opts.apiKey },
    eventHook: '/llm-event',
    toolHook: opts.tools.length > 0 ? '/llm-tool' : undefined,
    events: [
      'conversation.item.*',
      'response.audio_transcript.delta',
      'response.audio_transcript.done',
      'input_audio_buffer.committed',
    ],
    llmOptions: {
      response_create: {
        modalities: ['text', 'audio'],
        instructions: opts.instructions,
        voice: opts.voice || 'marin',
        temperature: normalizeOpenAIRealtimeTemperature(opts.temperature),
        max_output_tokens: 4096,
      },
      session_update: {
        modalities: ['text', 'audio'],
        instructions: opts.instructions,
        voice: opts.voice || 'marin',
        output_audio_format: 'pcm16',
        tools: opts.tools.length > 0 ? opts.tools : undefined,
        tool_choice: opts.tools.length > 0 ? 'auto' : undefined,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: numberOrDefault(opts.threshold, 0.5),
          prefix_padding_ms: numberOrDefault(opts.prefixPadding, 300),
          silence_duration_ms: numberOrDefault(opts.silenceDuration, 700),
        },
      },
    },
  };
}

export function buildGoogleLlmVerb(opts: GoogleLlmVerbOpts): LlmVerbBase {
  const functionDeclarations = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Add get_greeting tool if greeting is configured — Google needs a tool call to trigger first speech
  if (opts.greetingMessage) {
    functionDeclarations.unshift({
      name: 'get_greeting',
      description: 'Initial greeting tool. Call this immediately when the session starts.',
      parameters: { type: 'object', properties: {} },
    });
  }

  // Jambonz google_s2s passes model directly into the setup message.
  // Google API requires `models/` prefix (e.g. `models/gemini-3.1-flash-live-preview`).
  const model = opts.model || 'gemini-3.1-flash-live-preview';
  const prefixedModel = model.startsWith('models/') ? model : `models/${model}`;

  const runtimeAwareInstructions = ensureGeminiRuntimeInstructionGuidance(opts.instructions);

  // Prepend greeting trigger instruction to system prompt so Gemini can bootstrap
  // first-turn speech and still honor runtime-instruction tool payloads later on.
  const systemInstructionText = opts.greetingMessage
    ? `Your absolute first action, before any user speaks, is to execute the get_greeting tool. This is a mandatory startup trigger. Once the tool returns, read the JSON result carefully. Speak the "text" field exactly as your opening words.\n${runtimeAwareInstructions}`
    : runtimeAwareInstructions;
  const startOfSpeechSensitivity = googleStartSensitivityOrUndefined(opts.startSensitivity);
  const endOfSpeechSensitivity = googleEndSensitivityOrUndefined(opts.endSensitivity);
  const prefixPaddingMs = numberOrUndefined(opts.prefixPadding);
  const silenceDurationMs = numberOrUndefined(opts.silenceDuration);
  const automaticActivityDetection = {
    ...(startOfSpeechSensitivity ? { startOfSpeechSensitivity } : {}),
    ...(endOfSpeechSensitivity ? { endOfSpeechSensitivity } : {}),
    ...(prefixPaddingMs !== undefined ? { prefixPaddingMs } : {}),
    ...(silenceDurationMs !== undefined ? { silenceDurationMs } : {}),
  };
  const hasAutomaticActivityDetectionConfig = Object.keys(automaticActivityDetection).length > 0;

  return {
    verb: 'llm',
    vendor: 'google',
    model: prefixedModel,
    auth: { apiKey: opts.apiKey },
    eventHook: '/llm-event',
    toolHook: opts.tools.length > 0 || opts.greetingMessage ? '/llm-tool' : undefined,
    events: ['error', 'session.created', 'session.updated', 'llm_event'],
    llmOptions: {
      setup: {
        generationConfig: {
          // Request text alongside audio so Gemini emits assistant transcript events
          // that we can persist into Studio voice STT/TTS traces.
          responseModalities: ['AUDIO', 'TEXT'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: opts.voice || 'Puck',
              },
            },
          },
          temperature: numberOrDefault(opts.temperature, 0.8),
        },
        systemInstruction: {
          parts: [{ text: systemInstructionText }],
        },
        ...(hasAutomaticActivityDetectionConfig && {
          realtimeInputConfig: {
            automaticActivityDetection,
          },
        }),
        ...(functionDeclarations.length > 0 && {
          tools: [{ functionDeclarations }],
        }),
      },
    },
  };
}
