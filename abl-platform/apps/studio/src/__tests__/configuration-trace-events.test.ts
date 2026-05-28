import { describe, expect, test } from 'vitest';
import {
  getBannerEligibleConfigurationDiagnostic,
  getConfigurationTraceDiagnostic,
} from '../utils/configuration-trace-events';
import type { ExtendedTraceEvent } from '../types';

function makeTraceEvent(overrides: Partial<ExtendedTraceEvent> = {}): ExtendedTraceEvent {
  return {
    id: 'trace-config-1',
    type: 'agent_error_handled',
    timestamp: new Date('2026-03-28T16:20:00.000Z'),
    traceId: 'trace-123',
    spanId: 'span-123',
    sessionId: 'session-123',
    agentName: 'TravelDesk_Supervisor',
    data: {},
    ...overrides,
  };
}

describe('configuration trace diagnostics', () => {
  test('extracts banner-eligible configuration diagnostics from runtime trace events', () => {
    const sourceEvent = makeTraceEvent({
      data: {
        diagnostic: {
          category: 'llm',
          severity: 'error',
          code: 'LLM_CREDENTIAL_MISSING',
          message: 'No credential found for provider openai',
          bannerEligible: true,
        },
      },
    });

    expect(getConfigurationTraceDiagnostic(sourceEvent)).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_CREDENTIAL_MISSING',
      message: 'No credential found for provider openai',
      bannerEligible: true,
    });
    expect(getBannerEligibleConfigurationDiagnostic(sourceEvent)).toEqual({
      category: 'llm',
      severity: 'error',
      code: 'LLM_CREDENTIAL_MISSING',
      message: 'No credential found for provider openai',
      bannerEligible: true,
    });
  });

  test('ignores non-banner-eligible diagnostics for banner/error surfaces', () => {
    const sourceEvent = makeTraceEvent({
      data: {
        diagnostic: {
          category: 'llm',
          severity: 'warning',
          code: 'LLM_CREDENTIAL_MISSING',
          message: 'No credential found for provider openai',
          bannerEligible: false,
        },
      },
    });

    expect(getConfigurationTraceDiagnostic(sourceEvent)).toEqual({
      category: 'llm',
      severity: 'warning',
      code: 'LLM_CREDENTIAL_MISSING',
      message: 'No credential found for provider openai',
      bannerEligible: false,
    });
    expect(getBannerEligibleConfigurationDiagnostic(sourceEvent)).toBeUndefined();
  });
});
