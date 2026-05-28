import type { S2SSessionConfig } from '../s2s/types.js';
import type { RealtimeLlmToolDefinition } from './realtime-llm-payload.js';

export interface GrokLlmVerbPayload {
  verb: 'llm';
  vendor: 'grok';
  model: string;
  auth: {
    apiKey: string;
    organizationId?: string;
  };
  actionHook?: string;
  toolHook?: string;
  eventHook?: string;
  events: string[];
  llmOptions: {
    response_create: {
      modalities: ['text', 'audio'];
      instructions: string;
      temperature?: number;
      max_output_tokens?: number;
    };
    session_update: {
      modalities: ['text', 'audio'];
      instructions: string;
      voice: string;
      temperature?: number;
      input_audio_format: 'pcm16';
      output_audio_format: 'pcm16';
      tools?: RealtimeLlmToolDefinition[];
      tool_choice?: 'auto';
      turn_detection: {
        type: 'server_vad';
        threshold: number;
        prefix_padding_ms?: number;
        silence_duration_ms: number;
      };
    };
  };
}

type GrokHandoffSpeechMode = 'silent' | 'brief' | 'explicit';

const DEFAULT_GROK_HANDOFF_RESPONSE_CREATE_INSTRUCTION =
  "Speak immediately. Do not wait for the caller to speak first. Continue naturally from the caller's current request as the active agent. Do not describe internal routing or an agent switch unless the active agent instructions explicitly ask you to do so. Ask only the single most useful next question if more detail is needed.";

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

function escapeQuotedInstructionText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
}

function normalizeGrokHandoffSpeechMode(value: string | undefined): GrokHandoffSpeechMode {
  return value === 'brief' || value === 'explicit' ? value : 'silent';
}

function buildGrokHandoffResponseCreateInstruction(
  handoffContext?: string,
  internalHandoffSpeech?: string,
): string {
  const speechMode = normalizeGrokHandoffSpeechMode(internalHandoffSpeech);
  if (!handoffContext && speechMode === 'silent') {
    return DEFAULT_GROK_HANDOFF_RESPONSE_CREATE_INSTRUCTION;
  }

  const modeInstruction =
    speechMode === 'brief'
      ? 'Briefly acknowledge that the caller is now with the right specialist, then continue naturally.'
      : speechMode === 'explicit'
        ? 'Clearly explain that the caller is now with the specialist who can help, then continue naturally.'
        : 'Continue naturally from this context as the active agent. Do not describe internal routing or an agent switch unless the active agent instructions explicitly ask you to do so.';

  if (!handoffContext) {
    return `Speak immediately. Do not wait for the caller to speak first. ${modeInstruction} Ask only the single most useful next question if more detail is needed.`;
  }

  const escapedContext = escapeQuotedInstructionText(handoffContext);
  return `Speak immediately. Do not wait for the caller to speak first. ${modeInstruction} Ask only the single most useful next question: "${escapedContext}"`;
}

/**
 * Build Grok LLM verb payload for KoreVG (Jambonz) telephony integration.
 *
 * CRITICAL: Jambonz TaskLlmGrok_S2S sends session.update BEFORE response.create.
 * This initialization order is handled by Jambonz (grok_s2s.js lines 198-233),
 * not by this payload builder.
 *
 * @param apiKey - Grok API key (xai-...)
 * @param instructions - System prompt for the session
 * @param s2sConfig - S2S session configuration (model, voice, temperature, etc.)
 * @param tools - Tool definitions in OpenAI-compatible format
 * @param includeResponseCreate - If true, includes response_create with greeting (default true)
 * @returns Jambonz llm verb payload with vendor: 'grok'
 */
export function buildGrokLlmVerbPayload({
  apiKey,
  instructions,
  s2sConfig,
  tools,
  includeResponseCreate = true,
  handoffContext,
  internalHandoffSpeech,
}: {
  apiKey: string;
  instructions: string;
  s2sConfig: S2SSessionConfig;
  tools: RealtimeLlmToolDefinition[];
  includeResponseCreate?: boolean;
  handoffContext?: string;
  internalHandoffSpeech?: string;
}): GrokLlmVerbPayload {
  // CRITICAL: Grok ignores system instruction directives like "Start by saying X"
  // Both initial greeting and handoff context must go DIRECTLY in response_create.instructions
  // Unlike OpenAI which can reference system prompt, Grok needs explicit text in response_create
  const effectiveInstructions = instructions;
  let responseCreateInstruction: string;

  if (includeResponseCreate) {
    // Initial greeting: use extracted welcome message or default
    // Wrap in quotes to signal literal text to Grok (without "nothing else" to keep turn_detection active)
    const greetingText = handoffContext || 'Greet the caller and ask how you can help them today.';
    responseCreateInstruction = `Say: "${greetingText}"`;
  } else {
    // Handoff: use conversation context plus an explicit "speak now" instruction.
    // Sending the full system prompt here produces unreliable first-turn behavior.
    responseCreateInstruction = buildGrokHandoffResponseCreateInstruction(
      handoffContext,
      internalHandoffSpeech,
    );
  }

  const llmVerb: GrokLlmVerbPayload = {
    verb: 'llm',
    vendor: 'grok',
    model: (s2sConfig.model as string) || 'grok-2-1212',
    auth: {
      apiKey,
      organizationId: s2sConfig.organizationId as string | undefined,
    },
    actionHook: '/llm-event',
    toolHook: '/llm-event',
    eventHook: '/llm-event',
    // CRITICAL: Match reference - only subscribe to response events
    // Grok handles user input automatically, no need to subscribe to input events
    // response.output_audio_transcript.* includes both .done and .delta for handoff orchestration
    events: [
      'response.done',
      'response.output_audio_transcript.*',
      'conversation.item.input_audio_transcription.completed',
    ],
    llmOptions: {
      // CRITICAL: Jambonz sends session_update FIRST, then response_create
      // This ensures session is fully configured before initial greeting
      session_update: {
        modalities: ['text', 'audio'],
        instructions: effectiveInstructions,
        voice: (s2sConfig.voice as string) || 'ara',
        temperature: numberOrDefault(s2sConfig.temperature, 0.8),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        turn_detection: {
          type: 'server_vad',
          threshold: numberOrDefault(s2sConfig.threshold, 0.5),
          prefix_padding_ms: numberOrDefault(s2sConfig.prefixPadding, 300),
          silence_duration_ms: numberOrDefault(s2sConfig.silenceDuration, 500),
        },
      },
      // response_create triggers initial agent response
      // For initial greeting: generic instruction keeps turn_detection active
      // For handoff: explicit context helps Grok continue the conversation immediately
      response_create: {
        modalities: ['text', 'audio'],
        instructions: responseCreateInstruction,
        temperature: numberOrDefault(s2sConfig.temperature, 0.8),
      },
    },
  };

  // Clean up undefined optional fields
  if (!llmVerb.auth.organizationId) {
    delete llmVerb.auth.organizationId;
  }
  if (!llmVerb.llmOptions.session_update.tools) {
    delete llmVerb.llmOptions.session_update.tools;
  }
  if (!llmVerb.llmOptions.session_update.tool_choice) {
    delete llmVerb.llmOptions.session_update.tool_choice;
  }
  if (llmVerb.llmOptions.session_update.turn_detection.prefix_padding_ms === undefined) {
    delete llmVerb.llmOptions.session_update.turn_detection.prefix_padding_ms;
  }

  return llmVerb;
}
