/**
 * Google S2S Event Handler
 *
 * Translates Jambonz Google Gemini Live events into the same transcript/metrics
 * flow that the OpenAI S2S path uses. Jambonz sends raw Google server events
 * via eventHook — this module extracts transcripts, detects turn boundaries,
 * and handles tool call format differences.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('s2s-google-events');

// =============================================================================
// TYPES
// =============================================================================

/** Raw Google server event forwarded by Jambonz google_s2s */
export interface GoogleServerEvent {
  setupComplete?: boolean;
  setup_complete?: boolean;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
    model_turn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mime_type?: string; mimeType?: string; data: string };
      }>;
    };
    turnComplete?: boolean;
    turn_complete?: boolean;
    interrupted?: boolean;
    inputTranscription?: {
      text?: string;
    };
    input_transcription?: {
      text?: string;
    };
    outputTranscription?: {
      text?: string;
    };
    output_transcription?: {
      text?: string;
    };
  };
  server_content?: {
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
    model_turn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mime_type?: string; mimeType?: string; data: string };
      }>;
    };
    turnComplete?: boolean;
    turn_complete?: boolean;
    interrupted?: boolean;
    inputTranscription?: {
      text?: string;
    };
    input_transcription?: {
      text?: string;
    };
    outputTranscription?: {
      text?: string;
    };
    output_transcription?: {
      text?: string;
    };
  };
  toolCall?: {
    functionCalls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
  };
  tool_call?: {
    functionCalls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown> | string;
    }>;
    function_calls?: Array<{
      id: string;
      name: string;
      args: Record<string, unknown> | string;
    }>;
  };
}

/** Normalized transcript extracted from a Google event */
export interface GoogleTranscriptEvent {
  role: 'assistant';
  transcript: string;
  isTurnComplete: boolean;
}

/** Tool call extracted from a Google event */
export interface GoogleToolCallEvent {
  functionCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

interface NormalizedGoogleServerContent {
  modelTurn?: {
    parts?: Array<{
      text?: string;
    }>;
  };
  turnComplete: boolean;
  interrupted: boolean;
  inputTranscript?: string;
  outputTranscript?: string;
}

// =============================================================================
// EVENT PARSING
// =============================================================================

function normalizeGoogleServerContent(
  evt: GoogleServerEvent,
): NormalizedGoogleServerContent | null {
  const rawContent = evt.serverContent ?? evt.server_content;
  if (!rawContent) return null;

  const modelTurn = rawContent.modelTurn ?? rawContent.model_turn;
  const inputTranscript =
    rawContent.inputTranscription?.text ?? rawContent.input_transcription?.text;
  const outputTranscript =
    rawContent.outputTranscription?.text ?? rawContent.output_transcription?.text;

  return {
    modelTurn,
    turnComplete: !!(rawContent.turnComplete ?? rawContent.turn_complete),
    interrupted: !!rawContent.interrupted,
    inputTranscript: typeof inputTranscript === 'string' ? inputTranscript : undefined,
    outputTranscript: typeof outputTranscript === 'string' ? outputTranscript : undefined,
  };
}

/**
 * Extract assistant transcript text from a Google server event.
 * Google sends text in serverContent.modelTurn.parts[].text, and Jambonz can
 * forward Gemini spoken output in server_content.output_transcription.text.
 */
export function extractGoogleTranscript(evt: GoogleServerEvent): GoogleTranscriptEvent | null {
  const content = normalizeGoogleServerContent(evt);
  if (!content) return null;

  const texts: string[] = [];
  for (const part of content.modelTurn?.parts ?? []) {
    if (part.text) {
      texts.push(part.text);
    }
  }

  if (texts.length === 0 && content.outputTranscript) {
    texts.push(content.outputTranscript);
  }

  if (texts.length === 0) return null;

  return {
    role: 'assistant',
    transcript: texts.join(''),
    isTurnComplete: !!content.turnComplete,
  };
}

/**
 * Extract user input transcription text from a Google server event.
 * Jambonz forwards this as server_content.input_transcription.text.
 */
export function extractGoogleInputTranscript(evt: GoogleServerEvent): string | null {
  const content = normalizeGoogleServerContent(evt);
  const transcript = content?.inputTranscript?.trim();
  return transcript ? transcript : null;
}

/**
 * Check if the event signals turn completion (assistant finished speaking).
 */
export function isGoogleTurnComplete(evt: GoogleServerEvent): boolean {
  return !!normalizeGoogleServerContent(evt)?.turnComplete;
}

/**
 * Check if the event signals an interruption (user barged in).
 */
export function isGoogleInterrupted(evt: GoogleServerEvent): boolean {
  return !!normalizeGoogleServerContent(evt)?.interrupted;
}

/**
 * Check if the event is a setup completion event.
 */
export function isGoogleSetupComplete(evt: GoogleServerEvent): boolean {
  return !!(evt.setupComplete ?? evt.setup_complete);
}

/**
 * Extract tool calls from a Google llm:tool-call message.
 * Jambonz sends: {tool_call_id: 'function_call_id', type: 'toolCall', functionCalls: [...]}
 *
 * Supports multiple field name variations for robustness:
 * - data.functionCalls (camelCase - current Jambonz format)
 * - data.function_calls (snake_case - legacy/alternative format)
 * - data.toolCall?.functionCalls (nested path - direct Gemini Live format)
 *
 * Also handles stringified args for compatibility with different serialization formats.
 */
export function extractGoogleToolCalls(data: Record<string, unknown>): GoogleToolCallEvent | null {
  // Try multiple field name variations (matches pattern from korevg-router.ts OpenAI/Grok path)
  const rawFunctionCalls =
    (data.functionCalls as any[]) ||
    (data.function_calls as any[]) ||
    ((data.toolCall as any)?.functionCalls as any[]) ||
    ((data.tool_call as any)?.functionCalls as any[]) ||
    ((data.tool_call as any)?.function_calls as any[]);

  if (!rawFunctionCalls || rawFunctionCalls.length === 0) return null;

  // Normalize each function call - handle stringified args
  const functionCalls = rawFunctionCalls.map((fc) => {
    let parsedArgs = fc.args;
    if (typeof parsedArgs === 'string') {
      try {
        parsedArgs = JSON.parse(parsedArgs);
      } catch {
        parsedArgs = {};
      }
    }
    return {
      id: fc.id,
      name: fc.name,
      args: parsedArgs || {},
    };
  });

  return { functionCalls };
}

/**
 * Build a Google tool response message to send back to Jambonz.
 * Keep this aligned with the direct GeminiLiveSession adapter so tool round-trips
 * use the same `functionResponses[].response.result` shape.
 */
export function buildGoogleToolResponse(callId: string, result: unknown): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: callId,
          name: callId,
          response: {
            result: typeof result === 'string' ? result : JSON.stringify(result),
          },
        },
      ],
    },
  };
}

/**
 * Build an OpenAI tool response message (existing format).
 */
export function buildOpenAIToolResponse(callId: string, result: unknown): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: typeof result === 'string' ? result : JSON.stringify(result),
    },
  };
}

/**
 * Process a Google llm:event and accumulate transcript text.
 * Returns the full transcript when the turn is complete.
 *
 * Google streams text in fragments across multiple events, then sends
 * turnComplete. We accumulate fragments and return the full transcript
 * only when the turn ends.
 */
export class GoogleTranscriptAccumulator {
  private fragments: string[] = [];
  private _turnComplete = false;
  private _interrupted = false;
  private _setupDone = false;

  /**
   * Process an incoming Google server event.
   * Returns transcript text if available in this event.
   */
  processEvent(evt: GoogleServerEvent): string | null {
    if (isGoogleSetupComplete(evt)) {
      this._setupDone = true;
      log.debug('[Google] Setup complete');
      return null;
    }

    if (isGoogleInterrupted(evt)) {
      this._interrupted = true;
      log.debug('[Google] Interrupted (barge-in)');
      return null;
    }

    const transcript = extractGoogleTranscript(evt);
    if (transcript) {
      this.fragments.push(transcript.transcript);
    }

    if (isGoogleTurnComplete(evt)) {
      this._turnComplete = true;
    }

    return transcript?.transcript ?? null;
  }

  /** Get the full accumulated transcript and reset for next turn */
  flush(): string | null {
    if (this.fragments.length === 0) {
      this._turnComplete = false;
      this._interrupted = false;
      return null;
    }
    const full = this.fragments.join('');
    this.fragments = [];
    this._turnComplete = false;
    this._interrupted = false;
    return full;
  }

  get isTurnComplete(): boolean {
    return this._turnComplete;
  }

  get isInterrupted(): boolean {
    return this._interrupted;
  }

  get isSetupDone(): boolean {
    return this._setupDone;
  }

  resetInterrupted(): void {
    this._interrupted = false;
  }
}
