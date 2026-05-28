import { describe, expect, test } from 'vitest';
import type { ExtendedTraceEvent } from '../types';
import {
  getObservatoryEventSummary,
  getObservatoryEventTypeLabel,
} from '../utils/observatory-event-presentation';

function makeEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: 'event-1',
    type: 'agent_error_handled',
    timestamp: new Date('2026-03-29T17:30:00.000Z'),
    traceId: 'trace-1',
    spanId: 'span-1',
    sessionId: 'session-1',
    agentName: 'TravelDesk_Supervisor',
    data: {},
    ...overrides,
  };
}

describe('observatory event presentation', () => {
  test('renders handled configuration failures with a specific label and summary', () => {
    const event = makeEvent({
      data: {
        errorType: 'unknown_error',
        message: 'An error occurred. Please try again.',
        diagnostic: {
          category: 'llm',
          severity: 'error',
          code: 'LLM_CREDENTIAL_MISSING',
          message: 'No credential found for provider openai',
          bannerEligible: true,
        },
      },
    });

    expect(getObservatoryEventTypeLabel(event.type)).toBe('Handled Error');
    expect(getObservatoryEventSummary(event)).toBe(
      'LLM_CREDENTIAL_MISSING — No credential found for provider openai',
    );
  });

  test('falls back to handled error type/message when no configuration diagnostic exists', () => {
    const event = makeEvent({
      data: {
        errorType: 'unknown_error',
        message: 'Transient LLM failure',
      },
    });

    expect(getObservatoryEventSummary(event)).toBe('unknown_error — Transient LLM failure');
  });

  test('renders configuration diagnostics from tool traces', () => {
    const event = makeEvent({
      type: 'tool_call',
      data: {
        toolName: 'search_hotels',
        diagnostic: {
          category: 'tool',
          severity: 'error',
          code: 'TOOL_CODE_EXECUTION_DISABLED',
          message:
            'Code tool execution is disabled for this workspace. Enable code tools in workspace settings to run sandbox tools.',
          bannerEligible: true,
        },
      },
    });

    expect(getObservatoryEventTypeLabel(event.type)).toBe('Tool Call');
    expect(getObservatoryEventSummary(event)).toContain('TOOL_CODE_EXECUTION_DISABLED');
    expect(getObservatoryEventSummary(event)).toContain(
      'Code tool execution is disabled for this workspace',
    );
  });

  test('summarizes dsl_respond using rendered text before legacy fields', () => {
    const event = makeEvent({
      type: 'dsl_respond',
      data: {
        rendered: 'Rendered response from the runtime DSL executor',
        message: 'Legacy message fallback',
        text: 'Legacy text fallback',
      },
    });

    expect(getObservatoryEventSummary(event)).toBe(
      'Rendered response from the runtime DSL executor',
    );
  });

  test('renders attachment labels and summaries', () => {
    const uploadEvent = makeEvent({
      type: 'attachment_upload',
      data: {
        stage: 'upload',
        filename: 'invoice.pdf',
        success: true,
      },
    });
    const preprocessEvent = makeEvent({
      type: 'attachment_preprocess',
      data: {
        attachmentSummary: '1 PDF',
        contentBlockCount: 3,
      },
    });

    expect(getObservatoryEventTypeLabel(uploadEvent.type)).toBe('Attachment Ingest');
    expect(getObservatoryEventSummary(uploadEvent)).toBe('ingest — invoice.pdf — success');
    expect(getObservatoryEventSummary(preprocessEvent)).toBe('1 PDF — 3 blocks');
  });
});
