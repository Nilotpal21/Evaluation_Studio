import { describe, expect, it } from 'vitest';
import {
  ChannelExecutionTimeoutError,
  buildAuthRequiredOutcome,
  buildErrorOutcome,
  buildExecutionOutcome,
  buildOutcomeTraceEvent,
  collectChannelDiagnostics,
  toPublicChannelOutcome,
} from '../outcome.js';
import { buildAssistantPersistenceMessages } from '../outcome-persistence.js';
import { classifyLlmError } from '../../llm/classify-llm-error.js';

describe('channel outcome helpers', () => {
  it('collects tool warnings and session health diagnostics', () => {
    expect(
      collectChannelDiagnostics({
        toolWarnings: ['Calendar credentials missing'],
        sessionHealth: [
          {
            timestamp: Date.now(),
            category: 'llm',
            severity: 'error',
            code: 'MODEL_MISSING',
            message: 'No model available',
          },
        ],
      }),
    ).toEqual([
      {
        source: 'tool_warning',
        category: 'tool',
        severity: 'warning',
        code: 'TOOL_WARNING',
        message: 'Calendar credentials missing',
      },
      {
        source: 'session_health',
        category: 'llm',
        severity: 'error',
        code: 'MODEL_MISSING',
        message: 'No model available',
      },
    ]);
  });

  it('turns blank results into a surfaced empty-response outcome', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('empty_response');
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.responseText).toBe(
      "I'm having trouble completing that request. Please try again.",
    );
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EMPTY_RESPONSE',
          category: 'response',
        }),
      ]),
    );
  });

  it('summarizes structured JSON responses for interactive chat surfaces', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: {
        response: '{"response":"Hello there","metadata":{"channel":"web"}}',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.responseText).toBe('Hello there');
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'STRUCTURED_RESPONSE_SUMMARY',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('preserves structured JSON responses for API surfaces', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'api',
      result: {
        response: '{"response":"Hello there","metadata":{"channel":"api"}}',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.responseText).toBe('{"response":"Hello there","metadata":{"channel":"api"}}');
  });

  it('preserves empty text when structured payload is present', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'http_async',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: { markdown: '**Hello**' },
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.responseText).toBe('');
  });

  it('keeps successful structured channel outcomes out of diagnostic trace events', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'http_async',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: { plain_text: 'Voice response' },
        richContent: { markdown: '**Structured response**' },
        actions: {
          elements: [{ id: 'next', type: 'button' as const, label: 'Next' }],
        },
      },
    });

    expect(outcome.status).toBe('ok');
    expect(buildOutcomeTraceEvent(outcome)).toBeUndefined();
  });

  it('preserves response metadata for direct-channel parity flows', () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'mixed' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    const outcome = buildExecutionOutcome({
      channelType: 'genesys',
      result: {
        response: 'Hello there',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
        responseMetadata,
      },
    });

    expect(outcome.responseMetadata).toEqual(responseMetadata);
  });

  it('prefers the final execution response over accumulated streamed text', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      streamedText:
        'Your headphones order is delayed, so let me check the available options.\n\n' +
        'Since it is more than 48 hours late, you qualify for an expedited replacement.',
      result: {
        response: 'Since it is more than 48 hours late, you qualify for an expedited replacement.',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.responseText).toBe(
      'Since it is more than 48 hours late, you qualify for an expedited replacement.',
    );
  });

  it('falls back to accumulated streamed text when the execution response is empty', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      streamedText: 'Streaming-only response',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.responseText).toBe('Streaming-only response');
  });

  it('uses the final output message before accumulated streamed text when response is empty', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      streamedText: 'Interim message\n\nFinal output message',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
        outputMessages: [
          {
            id: 'interim-1',
            turnId: 'turn-1',
            sequence: 0,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'interim',
            text: 'Interim message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
          {
            id: 'final-1',
            turnId: 'turn-1',
            sequence: 1,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'final',
            text: 'Final output message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
        ],
        finalOutputMessageId: 'final-1',
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.responseText).toBe('Final output message');
    expect(outcome.outputMessages).toHaveLength(2);
    expect(outcome.finalOutputMessageId).toBe('final-1');
  });

  it('uses the final output message before a non-empty aggregate response', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      streamedText: 'Interim message\n\nFinal output message',
      result: {
        response: 'Interim message\n\nFinal output message',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
        outputMessages: [
          {
            id: 'interim-1',
            turnId: 'turn-1',
            sequence: 0,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'interim',
            text: 'Interim message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
          {
            id: 'final-1',
            turnId: 'turn-1',
            sequence: 1,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'final',
            text: 'Final output message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
        ],
        finalOutputMessageId: 'final-1',
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.responseText).toBe('Final output message');
  });

  it('builds separate persisted assistant messages from output messages', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      streamedText: 'Interim message\n\nFinal output message',
      result: {
        response: 'Final output message',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: { markdown: '**Final output message**' },
        actions: undefined,
        outputMessages: [
          {
            id: 'interim-1',
            turnId: 'turn-1',
            sequence: 0,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'interim',
            text: 'Interim message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
          {
            id: 'final-1',
            turnId: 'turn-1',
            sequence: 1,
            agentName: 'PolicyAdvisor',
            role: 'assistant',
            phase: 'final',
            text: 'Final output message',
            deliveredToUser: true,
            includeInModelContext: true,
            persistToTranscript: true,
          },
        ],
        finalOutputMessageId: 'final-1',
      },
    });

    const messages = buildAssistantPersistenceMessages({
      outcome,
      responseMessageId: 'transport-final-id',
      agentName: 'Alex',
      messageTimestamp: 1000,
    });

    expect(messages).toEqual([
      expect.objectContaining({
        content: 'Interim message',
        messageId: 'interim-1',
        agentName: 'PolicyAdvisor',
        metadata: { agentName: 'PolicyAdvisor' },
        messageTimestamp: 1000,
      }),
      expect.objectContaining({
        content: 'Final output message',
        messageId: 'transport-final-id',
        agentName: 'PolicyAdvisor',
        metadata: { agentName: 'PolicyAdvisor' },
        messageTimestamp: 1001,
        structuredContent: { richContent: { markdown: '**Final output message**' } },
      }),
    ]);
    expect(messages[0]).not.toHaveProperty('structuredContent');
  });

  it('preserves final response metadata while adding agent attribution metadata', () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: false,
        usedLlmInternally: true,
      },
    };
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: {
        response: 'Final output message',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
    });

    const messages = buildAssistantPersistenceMessages({
      outcome,
      responseMetadata,
      responseMessageId: 'transport-final-id',
      agentName: 'PolicyAdvisor',
    });

    expect(messages).toEqual([
      expect.objectContaining({
        content: 'Final output message',
        messageId: 'transport-final-id',
        agentName: 'PolicyAdvisor',
        metadata: {
          ...responseMetadata,
          agentName: 'PolicyAdvisor',
        },
      }),
    ]);
  });

  it('generates summary text when a web surface only receives channel-native rich content', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: {
          slack:
            '{"text":"Approval required","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Approve expense report"}}]}',
        },
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.responseText).toContain('Approval required');
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CHANNEL_NATIVE_CONTENT_SUMMARY',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('does not synthesize summary text when a web-native template is present alongside channel-native content', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'api',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: {
          markdown: '**Hello**',
          slack: '{"text":"Slack copy"}',
        },
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.responseText).toBe('');
  });

  it('treats voice-only payloads as renderable when the channel supports voiceConfig', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'api',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: { plain_text: 'Speak this aloud.' },
        richContent: undefined,
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.responseText).toBe('');
  });

  it('preserves coordinator diagnostics alongside channel outcome diagnostics', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'voice_livekit',
      result: {
        response: 'Hello there',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: undefined,
        actions: undefined,
      },
      additionalDiagnostics: [
        {
          source: 'voice_turn_coordinator',
          category: 'voice_runtime',
          severity: 'info',
          code: 'VOICE_PROMPT_PROFILE_PIPELINE',
          message: 'Voice turn used the canonical pipeline prompt profile.',
        },
      ],
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'voice_turn_coordinator',
          code: 'VOICE_PROMPT_PROFILE_PIPELINE',
        }),
      ]),
    );
  });

  it('still surfaces empty-response fallback when a channel cannot render rich payloads', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'twilio_sms',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: { markdown: '**Hello**' },
        actions: undefined,
      },
    });

    expect(outcome.status).toBe('empty_response');
    expect(outcome.usedFallback).toBe(true);
  });

  it('treats empty markdown and empty action sets as non-renderable', () => {
    const outcome = buildExecutionOutcome({
      channelType: 'web_chat',
      result: {
        response: '',
        action: { type: 'continue' },
        voiceConfig: undefined,
        richContent: { markdown: '' },
        actions: { elements: [] },
      },
    });

    expect(outcome.status).toBe('empty_response');
    expect(outcome.usedFallback).toBe(true);
  });

  it('builds auth-required outcomes with pending requirements', () => {
    const outcome = buildAuthRequiredOutcome({
      channelType: 'telegram',
      pending: [
        {
          connector: 'google',
          authProfileRef: 'google_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    expect(outcome.status).toBe('auth_required');
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.responseText).toContain("can't continue");
    expect(outcome.auth?.pending).toHaveLength(1);
  });

  it('classifies timeout errors distinctly from generic failures', () => {
    const timeoutOutcome = buildErrorOutcome({
      channelType: 'voice',
      error: new ChannelExecutionTimeoutError(30_000),
    });
    const genericOutcome = buildErrorOutcome({
      channelType: 'slack',
      error: new Error('Executor exploded'),
    });

    expect(timeoutOutcome.status).toBe('timeout');
    expect(timeoutOutcome.responseText).toContain('taking too long');
    expect(timeoutOutcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'EXECUTION_TIMEOUT',
          category: 'timeout',
        }),
      ]),
    );
    expect(genericOutcome.status).toBe('error');
    expect(genericOutcome.responseText).toContain("couldn't complete");
    expect(buildOutcomeTraceEvent(genericOutcome)?.data.message).not.toContain('Executor exploded');
    expect(buildOutcomeTraceEvent(genericOutcome)?.data.message).toContain('classified diagnostic');
  });

  it('surfaces runtime error envelopes through channel outcomes without leaking provider details', () => {
    const providerError = new Error(
      'OpenAI tenant tenant_abc model gpt-5-pro rejected function_call fc_123 because required reasoning item rs_456 was missing. api key sk-secret',
    );
    const classified = classifyLlmError(providerError);

    const outcome = buildErrorOutcome({
      channelType: 'http_async',
      error: classified,
      traceId: 'trace-channel-1',
      agentName: 'SupportAgent',
    });
    const traceEvent = buildOutcomeTraceEvent(outcome);

    expect(outcome.status).toBe('error');
    expect(outcome.responseText).toBe(
      "I'm having trouble completing that request. Please try again.",
    );
    expect(outcome.responseText).not.toContain('gpt-5-pro');
    expect(outcome.responseText).not.toContain('tenant_abc');
    expect(traceEvent?.data).toMatchObject({
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      category: 'llm',
      source: 'channel_outcome',
      errorEnvelope: {
        code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
        category: 'llm',
        trace_id: 'trace-channel-1',
        agent_name: 'SupportAgent',
      },
    });
    expect(traceEvent?.data.message).toContain('OpenAI Responses rejected');
    expect(JSON.stringify(traceEvent)).not.toContain('gpt-5-pro');
    expect(JSON.stringify(traceEvent)).not.toContain('tenant_abc');
    expect(JSON.stringify(traceEvent)).not.toContain('sk-secret');
  });

  it('sanitizes public outcomes to omit internal diagnostics', () => {
    const outcome = buildAuthRequiredOutcome({
      channelType: 'telegram',
      pending: [
        {
          connector: 'google',
          authProfileRef: 'google_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
      session: {
        toolWarnings: ['tool warning'],
        sessionHealth: [
          {
            timestamp: Date.now(),
            category: 'llm',
            severity: 'error',
            code: 'LLM_CREDENTIAL_MISSING',
            message: 'No credential found',
          },
        ],
      },
    });

    expect(toPublicChannelOutcome(outcome)).toEqual({
      status: 'auth_required',
      usedFallback: true,
      auth: {
        pending: [
          {
            connector: 'google',
            authProfileRef: 'google_auth',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      },
    });
  });
});
