import { describe, expect, it } from 'vitest';
import {
  GoogleTranscriptAccumulator,
  buildGoogleToolResponse,
  buildOpenAIToolResponse,
  extractGoogleInputTranscript,
  extractGoogleToolCalls,
  extractGoogleTranscript,
} from '../services/voice/korevg/s2s-google-event-handler.js';

describe('Google S2S event handler helpers', () => {
  it('builds Google tool responses using the Gemini functionResponses schema', () => {
    const response = buildGoogleToolResponse('call-123', { ok: true });
    const functionResponse = (
      response as {
        toolResponse: { functionResponses: Array<Record<string, unknown>> };
      }
    ).toolResponse.functionResponses[0] as {
      id: string;
      name: string;
      response: { result: string };
    };

    expect(functionResponse.id).toBe('call-123');
    expect(functionResponse.name).toBe('call-123');
    expect(functionResponse.response.result).toBe('{"ok":true}');
  });

  it('builds OpenAI tool responses as raw realtime events', () => {
    const response = buildOpenAIToolResponse('call-123', { ok: true }) as {
      type: string;
      item: { type: string; call_id: string; output: string };
    };

    expect(response.type).toBe('conversation.item.create');
    expect(response.item.type).toBe('function_call_output');
    expect(response.item.call_id).toBe('call-123');
    expect(response.item.output).toBe('{"ok":true}');
  });

  it('extracts Google tool calls from llm:tool-call payloads', () => {
    const toolCalls = extractGoogleToolCalls({
      type: 'toolCall',
      functionCalls: [
        {
          id: 'call-1',
          name: 'lookup_customer',
          args: { customerId: 'cust-123' },
        },
      ],
    });

    expect(toolCalls).toEqual({
      functionCalls: [
        {
          id: 'call-1',
          name: 'lookup_customer',
          args: { customerId: 'cust-123' },
        },
      ],
    });
  });

  it('extracts Google tool calls from snake_case websocket payloads', () => {
    const toolCalls = extractGoogleToolCalls({
      tool_call_id: 'function_call_id',
      type: 'toolCall',
      function_calls: [
        {
          id: 'call-2',
          name: 'handoff_to_Welcome_Agent',
          args: '{"message":"hello"}',
        },
      ],
    });

    expect(toolCalls).toEqual({
      functionCalls: [
        {
          id: 'call-2',
          name: 'handoff_to_Welcome_Agent',
          args: { message: 'hello' },
        },
      ],
    });
  });

  it('extracts Google tool calls from nested toolCall.functionCalls format', () => {
    const toolCalls = extractGoogleToolCalls({
      type: 'toolCall',
      toolCall: {
        functionCalls: [
          {
            id: 'call-3',
            name: 'get_weather',
            args: { location: 'NYC' },
          },
        ],
      },
    });

    expect(toolCalls).toEqual({
      functionCalls: [
        {
          id: 'call-3',
          name: 'get_weather',
          args: { location: 'NYC' },
        },
      ],
    });
  });

  it('extracts Google tool calls from nested snake_case tool_call.function_calls format', () => {
    const toolCalls = extractGoogleToolCalls({
      type: 'toolCall',
      tool_call: {
        function_calls: [
          {
            id: 'call-4',
            name: 'lookup_customer',
            args: '{"customerId":"cust-456"}',
          },
        ],
      },
    });

    expect(toolCalls).toEqual({
      functionCalls: [
        {
          id: 'call-4',
          name: 'lookup_customer',
          args: { customerId: 'cust-456' },
        },
      ],
    });
  });

  it('returns null when no tool calls are present', () => {
    expect(extractGoogleToolCalls({})).toBeNull();
    expect(extractGoogleToolCalls({ type: 'toolCall' })).toBeNull();
    expect(extractGoogleToolCalls({ functionCalls: [] })).toBeNull();
  });

  it('accumulates transcript fragments until turnComplete', () => {
    const accumulator = new GoogleTranscriptAccumulator();

    expect(
      accumulator.processEvent({
        serverContent: {
          modelTurn: {
            parts: [{ text: 'Hello' }],
          },
        },
      }),
    ).toBe('Hello');

    expect(
      accumulator.processEvent({
        serverContent: {
          modelTurn: {
            parts: [{ text: ' there' }],
          },
          turnComplete: true,
        },
      }),
    ).toBe(' there');

    expect(accumulator.isTurnComplete).toBe(true);
    expect(accumulator.flush()).toBe('Hello there');
    expect(accumulator.isTurnComplete).toBe(false);
  });

  it('resets completion state when turnComplete arrives without transcript fragments', () => {
    const accumulator = new GoogleTranscriptAccumulator();

    expect(
      accumulator.processEvent({
        serverContent: {
          turnComplete: true,
        },
      }),
    ).toBeNull();

    expect(accumulator.isTurnComplete).toBe(true);
    expect(accumulator.flush()).toBeNull();
    expect(accumulator.isTurnComplete).toBe(false);
  });

  it('extracts assistant transcript from snake_case Google events', () => {
    const transcript = extractGoogleTranscript({
      server_content: {
        model_turn: {
          parts: [{ text: 'Hello from snake case.' }],
        },
        turn_complete: true,
      },
    });

    expect(transcript).toEqual({
      role: 'assistant',
      transcript: 'Hello from snake case.',
      isTurnComplete: true,
    });
  });

  it('extracts assistant transcript from snake_case output transcription when model turn parts are empty', () => {
    const transcript = extractGoogleTranscript({
      server_content: {
        model_turn: {
          parts: [],
        },
        output_transcription: {
          text: "Welcome. I'm Elena, your virtual assistant.",
        },
        turn_complete: true,
      },
    });

    expect(transcript).toEqual({
      role: 'assistant',
      transcript: "Welcome. I'm Elena, your virtual assistant.",
      isTurnComplete: true,
    });
  });

  it('extracts assistant transcript from camelCase output transcription', () => {
    const transcript = extractGoogleTranscript({
      serverContent: {
        outputTranscription: {
          text: 'How can I help you today?',
        },
      },
    });

    expect(transcript).toEqual({
      role: 'assistant',
      transcript: 'How can I help you today?',
      isTurnComplete: false,
    });
  });

  it('extracts user input transcription from snake_case Google events', () => {
    const transcript = extractGoogleInputTranscript({
      server_content: {
        input_transcription: {
          text: 'When is my appointment?',
        },
      },
    });

    expect(transcript).toBe('When is my appointment?');
  });

  it('accumulates transcript fragments from snake_case events until turn_complete', () => {
    const accumulator = new GoogleTranscriptAccumulator();

    expect(
      accumulator.processEvent({
        server_content: {
          model_turn: {
            parts: [{ text: 'Hi' }],
          },
        },
      }),
    ).toBe('Hi');

    expect(
      accumulator.processEvent({
        server_content: {
          model_turn: {
            parts: [{ text: ' there' }],
          },
          turn_complete: true,
        },
      }),
    ).toBe(' there');

    expect(accumulator.isTurnComplete).toBe(true);
    expect(accumulator.flush()).toBe('Hi there');
  });

  it('accumulates transcript fragments from output transcription events until turn_complete', () => {
    const accumulator = new GoogleTranscriptAccumulator();

    expect(
      accumulator.processEvent({
        server_content: {
          output_transcription: {
            text: 'Welcome.',
          },
        },
      }),
    ).toBe('Welcome.');

    expect(
      accumulator.processEvent({
        server_content: {
          model_turn: {
            parts: [],
          },
          output_transcription: {
            text: ' How can I help?',
          },
          turn_complete: true,
        },
      }),
    ).toBe(' How can I help?');

    expect(accumulator.isTurnComplete).toBe(true);
    expect(accumulator.flush()).toBe('Welcome. How can I help?');
  });
});
