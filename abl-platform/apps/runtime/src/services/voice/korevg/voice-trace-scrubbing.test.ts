import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '@abl/compiler/platform/security/pii-recognizer-registry.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTraceStore, resetTraceStore, type TraceEvent } from '../../trace-store.js';
import type { RuntimeSession } from '../../execution/types.js';
import { addScrubbedVoiceTraceEvent, scrubVoiceTraceEvent } from './voice-trace-scrubbing.js';

const {
  mockEventStoreEmitter,
  mockGetEventStore,
  mockPersistMessageRecord,
  mockPersistTurnMetrics,
} = vi.hoisted(() => {
  const emitter = {
    emit: vi.fn(),
  };

  return {
    mockEventStoreEmitter: emitter,
    mockGetEventStore: vi.fn(() => ({ emitter })),
    mockPersistMessageRecord: vi.fn(async () => undefined),
    mockPersistTurnMetrics: vi.fn(async () => undefined),
  };
});

vi.mock('../../eventstore-singleton.js', () => ({
  getEventStore: mockGetEventStore,
}));

vi.mock('../../message-persistence-queue.js', () => ({
  persistMessageRecord: mockPersistMessageRecord,
  persistTurnMetrics: mockPersistTurnMetrics,
}));

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function buildSession(): Pick<RuntimeSession, 'id' | 'piiRecognizerRegistry'> {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['ContractID'],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      'ContractID',
      undefined,
      'custom',
    ),
  );

  return {
    id: 'voice-session-1',
    piiRecognizerRegistry: registry,
  };
}

function buildEvent(type: string, data: Record<string, unknown>): TraceEvent {
  return {
    id: `${type}-event`,
    sessionId: 'voice-session-1',
    type,
    timestamp: new Date(),
    data,
    agentName: 'VoiceAgent',
  };
}

describe('voice trace scrubbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEventStore.mockReturnValue({ emitter: mockEventStoreEmitter });
  });

  it('scrubs STT transcripts with the project PII recognizer registry', () => {
    const event = buildEvent('voice_stt', {
      transcript: `Contract ${rawContractId}`,
      provider: 'google',
    });

    const scrubbed = scrubVoiceTraceEvent(event, buildSession());

    expect(JSON.stringify(scrubbed.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(scrubbed.data)).not.toContain(rawContractId);
  });

  it('scrubs realtime voice tool-call arguments with the project PII recognizer registry', () => {
    const event = buildEvent('voice_realtime_tool_call', {
      toolName: 'lookup_contract',
      arguments: {
        contractId: rawContractId,
      },
    });

    const scrubbed = scrubVoiceTraceEvent(event, buildSession());

    expect(JSON.stringify(scrubbed.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(scrubbed.data)).not.toContain(rawContractId);
  });

  it('falls back to built-in scrubbers when project PII context is unavailable', () => {
    const event = buildEvent('voice_realtime_tool_call', {
      arguments: {
        apiKey: 'sk-test-1234567890abcdef',
      },
    });

    const scrubbed = scrubVoiceTraceEvent(event);

    expect(JSON.stringify(scrubbed.data)).not.toContain('sk-test-1234567890abcdef');
  });

  it('stores scrubbed voice trace data through the central helper', () => {
    resetTraceStore();
    const event = buildEvent('voice_stt', {
      transcript: `Contract ${rawContractId}`,
    });

    addScrubbedVoiceTraceEvent(event.sessionId, event, buildSession());

    const stored = getTraceStore().getEvents(event.sessionId);
    expect(Array.isArray(stored)).toBe(true);
    expect(JSON.stringify(stored)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(stored)).not.toContain(rawContractId);
    resetTraceStore();
  });

  it('durably emits canonical voice callback events when tenant context is provided', () => {
    resetTraceStore();
    const event = buildEvent('agent_enter', {
      agentName: 'VoiceAgent',
      trigger: 'resume_intent',
      channel: 'voice',
    });

    addScrubbedVoiceTraceEvent(event.sessionId, event, buildSession(), {
      persistToEventStore: true,
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    expect(getTraceStore().getEvents(event.sessionId)).toHaveLength(1);
    expect(mockEventStoreEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'agent.entered',
        tenant_id: 'tenant-1',
        project_id: 'project-1',
        session_id: event.sessionId,
        agent_name: 'VoiceAgent',
        data: expect.objectContaining({
          trigger: 'resume_intent',
          channel: 'voice',
          phase: 'agent_lifecycle',
          reasonCode: 'agent_enter',
          causal: expect.objectContaining({
            phase: 'agent_lifecycle',
            reasonCode: 'agent_enter',
          }),
        }),
        metadata: expect.objectContaining({
          causal: expect.objectContaining({
            phase: 'agent_lifecycle',
            reasonCode: 'agent_enter',
          }),
        }),
      }),
    );
    resetTraceStore();
  });

  it('increments the session trace count for canonical voice callback events', async () => {
    resetTraceStore();
    const event = buildEvent('decision', {
      action: 'handoff_to_BillingAgent',
      channel: 'voice',
    });

    addScrubbedVoiceTraceEvent(event.sessionId, event, buildSession(), {
      persistToEventStore: true,
      incrementTraceEventCount: true,
      dbSessionId: 'db-session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    await vi.waitFor(() => {
      expect(mockPersistTurnMetrics).toHaveBeenCalledWith({
        dbSessionId: 'db-session-1',
        tenantId: 'tenant-1',
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      });
    });
    resetTraceStore();
  });

  it('keeps trace writes non-fatal when durable voice emission is unavailable', () => {
    resetTraceStore();
    mockGetEventStore.mockImplementation(() => {
      throw new Error('eventstore unavailable');
    });
    const event = buildEvent('agent_exit', {
      result: 'return_to_parent',
      channel: 'voice',
    });

    expect(() =>
      addScrubbedVoiceTraceEvent(event.sessionId, event, buildSession(), {
        persistToEventStore: true,
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
    ).not.toThrow();

    expect(getTraceStore().getEvents(event.sessionId)).toHaveLength(1);
    resetTraceStore();
  });
});
